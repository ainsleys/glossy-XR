// Speech-to-text for annotation clips.
//
// Default backend is local Whisper through transformers.js (ONNX runtime on
// CPU, no Python): clips are decoded to 16 kHz mono PCM with ffmpeg, run
// through the model one at a time, and come back as text plus word
// timestamps. First use downloads the model into GLOSSY_MODEL_CACHE
// (~/.cache/glossy-xr/models). An OpenAI Whisper backend is available for
// machines without the CPU budget. Nothing here is specific to a project.
//
// Language: a job may pass `language` (ISO code) from the annotation or its
// project; otherwise GLOSSY_LANGUAGE; otherwise the local backend detects it
// with one decoder step over the language tokens (about 200 ms) before
// transcribing. The library itself would silently default to English. When a
// language is forced the same step still runs and its answer is returned as
// `heard`, so clients can flag a clip spoken in some other language.
//
//   GLOSSY_TRANSCRIBE      local (default) | openai | none
//   GLOSSY_WHISPER_MODEL   HF id, default onnx-community/whisper-base_timestamped
//                          (whisper-small_timestamped, whisper-large-v3-turbo_timestamped for better accuracy)
//   GLOSSY_WHISPER_DTYPE   q8 (default) | fp32 | fp16 | q4
//   GLOSSY_LANGUAGE        ISO code to force for every clip, e.g. en, tr; unset = per project, else detect
//   GLOSSY_MODEL_CACHE     where models are stored
//   FFMPEG                 path to ffmpeg if not on PATH
//   OPENAI_API_KEY         for the openai backend

import { execFile } from 'node:child_process';
import { looksRepetitive } from '../shared/text.js';
export { looksRepetitive };
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
  let Tensor = null;
  const load = () => {
    if (pipelinePromise) return pipelinePromise;
    pipelinePromise = (async () => {
      const { pipeline, env, Tensor: T } = await import('@huggingface/transformers');
      Tensor = T;
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
  // One decoder step from <|startoftranscript|>: the highest-scoring language
  // token is the detected language. Returns null for English-only models.
  async function detectLanguage(asr, audio) {
    const gc = asr.model.generation_config;
    if (!gc?.is_multilingual || !gc.lang_to_id) return null;
    const feats = await asr.processor(audio);
    const out = await asr.model({ ...feats, decoder_input_ids: new Tensor('int64', [BigInt(gc.decoder_start_token_id)], [1, 1]) });
    const data = out.logits.data, vocab = out.logits.dims.at(-1);
    const last = data.subarray(data.length - vocab);
    let best = null;
    for (const [tok, id] of Object.entries(gc.lang_to_id)) if (best === null || last[id] > last[best.id]) best = { tok, id };
    return best ? best.tok.slice(2, -2) : null;
  }
  return {
    name: 'local', model: MODEL,
    warm: load,
    async transcribe(file, { language = LANGUAGE } = {}) {
      const asr = await load();
      const audio = await decodeToPcm(file);
      const gc = asr.model.generation_config;
      if (audio.length < 1600) return { text: '', words: [], language: language || null, detected: false };
      let detected = false, fallback = false;
      if (!gc?.is_multilingual) {
        // English-only checkpoint (whisper-*.en): the library refuses language/task options, and the answer is always English
        const out = await asr(audio, { return_timestamps: 'word', chunk_length_s: 30 });
        return { text: out.text.trim(), words: wordsOf(out), language: 'en', detected: false, fallback: !!language && language !== 'en' };
      }
      // One detection step runs either way (about 200 ms): with no language it
      // chooses the decoder; with a forced language it is kept as `heard`, so a
      // clip spoken in another language than the project's is flagged rather
      // than silently decoded into noise.
      const heard = await detectLanguage(asr, audio);
      if (!language) {
        language = heard;
        detected = !!language;
        if (!language) { language = 'en'; fallback = true; }       // no language tokens to score against
      }
      let out = await asr(audio, { return_timestamps: 'word', chunk_length_s: 30, language, task: 'transcribe' });
      let retried = false;
      if (looksRepetitive(out.text)) {                            // decode once more with repeated trigrams forbidden
        retried = true;
        try { out = await asr(audio, { return_timestamps: 'word', chunk_length_s: 30, language, task: 'transcribe', no_repeat_ngram_size: 3 }); } catch {}
      }
      return { text: out.text.trim(), words: wordsOf(out), language, detected, heard: detected ? null : heard, fallback, retried };
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
      return { text: (j.text || '').trim(), words: (j.words || []).map((w) => ({ w: w.word, s: round(w.start), e: round(w.end) })), language: toCode(j.language) || language || null, detected: !language && !!j.language, fallback: false };
    },
  };
}

const round = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
const wordsOf = (out) => (out.chunks || []).map((c) => ({ w: c.text.trim(), s: round(c.timestamp[0]), e: round(c.timestamp[1]) })).filter((c) => c.w);

// The OpenAI backend reports a language name ("turkish"); the local one an ISO code. Store codes.
const LANGUAGE_CODES = { english: 'en', turkish: 'tr', german: 'de', french: 'fr', spanish: 'es', italian: 'it', arabic: 'ar', greek: 'el', polish: 'pl', dutch: 'nl', portuguese: 'pt', russian: 'ru', japanese: 'ja', chinese: 'zh', korean: 'ko', kurdish: 'ku', persian: 'fa', hindi: 'hi', ukrainian: 'uk', romanian: 'ro', bulgarian: 'bg', hungarian: 'hu', czech: 'cs', swedish: 'sv', danish: 'da', norwegian: 'no', finnish: 'fi', hebrew: 'he', armenian: 'hy', georgian: 'ka', azerbaijani: 'az' };
const toCode = (l) => { if (!l) return null; const k = String(l).toLowerCase(); return k.length <= 3 ? k : (LANGUAGE_CODES[k] || k); };

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

  // The caller's callback writes the result to the store. If that write throws
  // (a locked database, a closed connection) the failure must stay in the log:
  // a rejection escaping the pump would take the whole server down.
  function finish(job, err, result) {
    try { job.done(err, result); } catch (e) { log.error(`transcribe: ${job.id} result not stored: ${e.message}`); }
  }

  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const job = queue.shift();
      const t0 = Date.now();
      try {
        if (!(await ready)) throw new Error(unavailable || 'transcription disabled');
        const result = await backend.transcribe(job.file, job.opts);
        finish(job, null, { ...result, backend: backend.name, model: backend.model, ms: Date.now() - t0 });
      } catch (e) {
        log.warn(`transcribe: ${job.id} failed: ${e.message}`);
        finish(job, e, null);
      }
    }
    busy = false;
  }

  return {
    get enabled() { return !!backend; },
    info: () => ({ backend: backend?.name || 'none', model: backend?.model || null, language: LANGUAGE || 'per project, else detected', queued: queue.length + (busy ? 1 : 0), unavailable }),
    enqueue(id, file, opts, done) { queue.push({ id, file, opts, done }); pump(); },
    ready: () => ready,
  };
}
