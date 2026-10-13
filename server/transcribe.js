// Speech-to-text for annotation clips.
//
// Default backend is local Whisper through transformers.js (ONNX runtime on
// CPU, no Python): clips are decoded to 16 kHz mono PCM with ffmpeg, run
// through the model one at a time, and come back as text plus word
// timestamps. First use downloads the model into GLOSSY_MODEL_CACHE
// (~/.cache/glossy-xr/models). An OpenAI Whisper backend is available for
// machines without the CPU budget. Nothing here is specific to a project:
// language is auto-detected unless GLOSSY_LANGUAGE pins it.
//
//   GLOSSY_TRANSCRIBE      local (default) | openai | none
//   GLOSSY_WHISPER_MODEL   HF id, default onnx-community/whisper-base_timestamped
//                          (whisper-small_timestamped, whisper-large-v3-turbo_timestamped for better accuracy)
//   GLOSSY_WHISPER_DTYPE   q8 (default) | fp32 | fp16 | q4
//   GLOSSY_LANGUAGE        ISO code to force, e.g. en, tr; unset = detect
//   GLOSSY_MODEL_CACHE     where models are stored
//   FFMPEG                 path to ffmpeg if not on PATH
//   OPENAI_API_KEY         for the openai backend

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BACKEND = (process.env.GLOSSY_TRANSCRIBE || 'local').toLowerCase();
const MODEL = process.env.GLOSSY_WHISPER_MODEL || 'onnx-community/whisper-base_timestamped';
const DTYPE = process.env.GLOSSY_WHISPER_DTYPE || 'q8';
const LANGUAGE = process.env.GLOSSY_LANGUAGE || null;
const CACHE = process.env.GLOSSY_MODEL_CACHE || path.join(os.homedir(), '.cache', 'glossy-xr', 'models');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1 << 28, encoding: 'buffer', ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${stderr?.toString().trim() || err.message}`));
      else resolve(stdout);
    });
  });
}

/** Decode any container/codec ffmpeg knows to 16 kHz mono float32 samples. */
export async function decodeToPcm(file) {
  const buf = await run(FFMPEG, ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', '16000', '-']);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

async function ffmpegAvailable() {
  try { await run(FFMPEG, ['-version']); return true; } catch { return false; }
}

// ---- backends ---------------------------------------------------------------

function localBackend(log) {
  let pipelinePromise = null;
  const load = () => {
    if (pipelinePromise) return pipelinePromise;
    pipelinePromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = CACHE;
      fs.mkdirSync(CACHE, { recursive: true });
      const t0 = Date.now();
      let announced = false;
      const asr = await pipeline('automatic-speech-recognition', MODEL, {
        dtype: DTYPE,
        progress_callback: (p) => { if (p.status === 'progress' && !announced) { announced = true; log.log(`transcribe: downloading ${MODEL} to ${CACHE}`); } },
      });
      log.log(`transcribe: ${MODEL} (${DTYPE}) ready in ${Date.now() - t0} ms`);
      return asr;
    })();
    pipelinePromise.catch(() => { pipelinePromise = null; });   // allow a retry after a failed download
    return pipelinePromise;
  };
  return {
    name: 'local', model: MODEL,
    warm: load,
    async transcribe(file, { language = LANGUAGE } = {}) {
      const asr = await load();
      const audio = await decodeToPcm(file);
      if (audio.length < 1600) return { text: '', words: [], language };
      const out = await asr(audio, { return_timestamps: 'word', chunk_length_s: 30, language: language || null, task: 'transcribe' });
      const words = (out.chunks || []).map((c) => ({ w: c.text.trim(), s: round(c.timestamp[0]), e: round(c.timestamp[1]) })).filter((c) => c.w);
      return { text: out.text.trim(), words, language };
    },
  };
}

function openaiBackend() {
  const key = process.env.OPENAI_API_KEY;
  return {
    name: 'openai', model: 'whisper-1',
    warm: async () => { if (!key) throw new Error('OPENAI_API_KEY is not set'); },
    async transcribe(file, { language = LANGUAGE } = {}) {
      if (!key) throw new Error('OPENAI_API_KEY is not set');
      const fd = new FormData();
      fd.append('file', new Blob([fs.readFileSync(file)]), path.basename(file));
      fd.append('model', 'whisper-1');
      fd.append('response_format', 'verbose_json');
      fd.append('timestamp_granularities[]', 'word');
      if (language) fd.append('language', language);
      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: fd });
      if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = await res.json();
      return { text: (j.text || '').trim(), words: (j.words || []).map((w) => ({ w: w.word, s: round(w.start), e: round(w.end) })), language: j.language || language };
    },
  };
}

const round = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

// ---- queue ------------------------------------------------------------------

/**
 * Serial transcription queue. `enqueue(id, file, opts, done)` calls
 * done(err, result) off the request path; results are never written here,
 * the caller decides what to do with them (the record may be gone by then).
 */
export function createTranscriber({ log = console } = {}) {
  const backend = BACKEND === 'none' ? null : BACKEND === 'openai' ? openaiBackend() : localBackend(log);
  const queue = [];
  let busy = false, ready = null, unavailable = null;

  async function check() {
    if (!backend) return false;
    if (backend.name === 'local' && !(await ffmpegAvailable())) { unavailable = `ffmpeg not found (set FFMPEG or install it); transcription disabled`; log.warn('transcribe: ' + unavailable); return false; }
    try { await backend.warm(); return true; } catch (e) { unavailable = e.message; log.warn('transcribe: ' + e.message); return false; }
  }
  ready = backend ? check() : Promise.resolve(false);

  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const job = queue.shift();
      const t0 = Date.now();
      try {
        if (!(await ready)) throw new Error(unavailable || 'transcription disabled');
        const result = await backend.transcribe(job.file, job.opts);
        job.done(null, { ...result, backend: backend.name, model: backend.model, ms: Date.now() - t0 });
      } catch (e) {
        log.warn(`transcribe: ${job.id} failed: ${e.message}`);
        job.done(e, null);
      }
    }
    busy = false;
  }

  return {
    get enabled() { return !!backend; },
    info: () => ({ backend: backend?.name || 'none', model: backend?.model || null, language: LANGUAGE || 'auto', queued: queue.length + (busy ? 1 : 0), unavailable }),
    enqueue(id, file, opts, done) { queue.push({ id, file, opts, done }); pump(); },
    ready: () => ready,
  };
}
