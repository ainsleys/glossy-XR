// node --test: the cloud fallback in server/transcribe.js, with fake backends
// injected through createTranscriber's `backends` seam. The secondary must run
// only for an `allowCloud` job whose primary result was clean but rejected by
// the transcript guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranscriber } from '../../server/transcribe.js';

const quiet = { log() {}, warn() {}, error() {} };

/** A fake backend that answers `text`, or throws `error`; counts its calls. */
function fake(name, { text = '', error = null, warm = null } = {}) {
  const b = {
    name, model: `${name}-model`, calls: 0,
    async transcribe() { b.calls++; if (error) throw new Error(error); return { text, words: [], language: 'en', detected: true, fallback: false }; },
  };
  if (warm) b.warm = async () => { throw new Error(warm); };
  return b;
}

/** Run one job and resolve with {err, result}. */
function run(primary, secondary, opts) {
  const t = createTranscriber({ log: quiet, backends: { primary, secondary } });
  return new Promise((resolve) => t.enqueue('clip', '/dev/null', opts, (err, result) => resolve({ err, result, info: t.info() })));
}

test('an unclear primary result with allowCloud goes to the secondary', async () => {
  const primary = fake('local', { text: 'Thank you.' }), secondary = fake('openai', { text: 'The pot stood here.' });
  const { err, result } = await run(primary, secondary, { allowCloud: true });
  assert.equal(err, null);
  assert.equal(secondary.calls, 1);
  assert.equal(result.text, 'The pot stood here.');
  assert.equal(result.backend, 'openai');
  assert.equal(result.model, 'openai-model');
  assert.deepEqual(result.cloud, { from: 'local', reason: 'silence' });
});

test('a repetition is sent with its reason; an unclear secondary result keeps the cloud marker and the rejected local text', async () => {
  const primary = fake('local', { text: 'la la la la la' }), secondary = fake('openai', { text: 'Thank you.' });
  const { result } = await run(primary, secondary, { allowCloud: true });
  assert.equal(secondary.calls, 1);
  assert.equal(result.backend, 'openai');
  assert.equal(result.text, 'Thank you.');
  assert.deepEqual(result.cloud, { from: 'local', reason: 'repetition', raw: 'la la la la la' });
});

test('allowCloud as a function is asked after the primary result, and false keeps the clip local', async () => {
  let asked = 0, allow = true;
  const primary = fake('local', { text: 'Thank you.' }), secondary = fake('openai', { text: 'other' });
  const inner = primary.transcribe;
  primary.transcribe = async (...a) => { allow = false; return inner(...a); };   // consent withdrawn while the local model ran
  const { result } = await run(primary, secondary, { allowCloud: () => { asked++; return allow; } });
  assert.equal(asked, 1);
  assert.equal(secondary.calls, 0);
  assert.equal(result.backend, 'local');
  assert.equal(result.cloud, undefined);
  // and true sends it
  const { result: sent } = await run(fake('local', { text: 'Thank you.' }), secondary, { allowCloud: () => true });
  assert.equal(secondary.calls, 1);
  assert.equal(sent.backend, 'openai');
});

test('allowCloud is not asked for a clean result', async () => {
  let asked = 0;
  await run(fake('local', { text: 'The lamp is broken.' }), fake('openai', { text: 'other' }), { allowCloud: () => { asked++; return true; } });
  assert.equal(asked, 0);
});

test('a clean primary result does not go to the secondary', async () => {
  const primary = fake('local', { text: 'The lamp on the table is broken.' }), secondary = fake('openai', { text: 'other' });
  const { result } = await run(primary, secondary, { allowCloud: true });
  assert.equal(secondary.calls, 0);
  assert.equal(result.backend, 'local');
  assert.equal(result.cloud, undefined);
});

test('an unclear primary result without allowCloud does not go to the secondary', async () => {
  const primary = fake('local', { text: 'Thank you.' }), secondary = fake('openai', { text: 'other' });
  for (const opts of [{}, { allowCloud: false }, undefined]) {
    const { result } = await run(primary, secondary, opts);
    assert.equal(result.backend, 'local');
    assert.equal(result.cloud, undefined);
  }
  assert.equal(secondary.calls, 0);
});

test('a primary error fails the job and does not go to the secondary', async () => {
  const primary = fake('local', { error: 'ffmpeg failed' }), secondary = fake('openai', { text: 'other' });
  const { err, result } = await run(primary, secondary, { allowCloud: true });
  assert.match(err?.message || '', /ffmpeg failed/);
  assert.equal(result, null);
  assert.equal(secondary.calls, 0);
});

test('a language fallback does not go to the secondary', async () => {
  const primary = fake('local', { text: 'Thank you.' }), secondary = fake('openai', { text: 'other' });
  const inner = primary.transcribe;
  primary.transcribe = async (...a) => ({ ...(await inner(...a)), fallback: true });
  const { result } = await run(primary, secondary, { allowCloud: true });
  assert.equal(secondary.calls, 0);
  assert.equal(result.backend, 'local');
});

test('an unavailable secondary leaves the primary result, unclear, and the primary working', async () => {
  const primary = fake('local', { text: 'Thank you.' });
  for (const secondary of [null, fake('openai', { text: 'other', warm: 'OPENAI_API_KEY is not set' })]) {
    const { err, result, info } = await run(primary, secondary, { allowCloud: true });
    assert.equal(err, null);
    assert.equal(result.backend, 'local');
    assert.equal(result.text, 'Thank you.');
    assert.equal(result.cloud, undefined);
    assert.equal(info.unavailable, null);
    if (secondary) { assert.equal(secondary.calls, 0); assert.deepEqual(info.cloud, { backend: 'openai', model: 'openai-model', unavailable: 'OPENAI_API_KEY is not set' }); }
    else assert.equal(info.cloud, null);
  }
});

test('a secondary that throws leaves the primary result, with the attempt and its error in cloud', async () => {
  const primary = fake('local', { text: 'Thank you.' }), secondary = fake('openai', { error: 'openai 500' });
  const { err, result } = await run(primary, secondary, { allowCloud: true });
  assert.equal(err, null);
  assert.equal(secondary.calls, 1);
  assert.equal(result.backend, 'local');
  assert.equal(result.text, 'Thank you.');
  assert.deepEqual(result.cloud, { from: 'local', reason: 'silence', error: 'openai 500' });
});
