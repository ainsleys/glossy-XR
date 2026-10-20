// Microphone capture with the MediaRecorder API. Replaces recorder.js /
// opus-recorder / encoderWorker from the 2016 build. Produces webm/opus on
// Chrome (desktop and Quest), ogg/opus or mp4/aac on other engines.
//
// The stream is not forever: a headset that goes to sleep, a device that is
// unplugged or a browser that reclaims the microphone ends the track under
// us. `init()` therefore asks again whenever the track it holds is no longer
// live, `onended` tells the room when that happens, and a start that throws
// never leaves a recorder behind that claims to be recording (Quest Browser
// did exactly that on an ended track, and every later clip was refused).

const PREFERRED = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];

export class VoiceRecorder {
  constructor() {
    this.stream = null;
    this.rec = null;
    this.chunks = [];
    this.startedAt = 0;
    this.mimeType = PREFERRED.find((t) => window.MediaRecorder?.isTypeSupported(t)) || '';
  }

  /** The microphone track is open and delivering. */
  get live() {
    return !!this.stream && this.stream.getAudioTracks().some((t) => t.readyState === 'live');
  }

  get isRecording() {
    return !!this.rec && this.rec.state === 'recording' && this.live;
  }

  /** Drop the stream and any recorder on it. */
  release() {
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.rec = null;
    this.chunks = [];
  }

  async init() {
    if (this.live) return;
    this.release();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    this.stream = stream;
    for (const t of stream.getAudioTracks()) {
      t.addEventListener('ended', () => {
        if (this.stream !== stream) return;                     // already replaced
        this.release();
        this.onended?.();
      });
    }
  }

  async start() {
    await this.init();
    if (this.isRecording) return;
    this.chunks = [];
    const rec = new MediaRecorder(this.stream, this.mimeType ? { mimeType: this.mimeType } : undefined);
    rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    try { rec.start(250); }
    catch (e) { this.release(); throw e; }                      // a failed start must not leave a recorder that says it is recording
    this.rec = rec;
    this.startedAt = performance.now();
    this.onstart?.(this.stream);
  }

  /** @returns {Promise<{blob: Blob, durationMs: number} | null>} */
  stop() {
    return new Promise((resolve) => {
      const rec = this.rec;
      if (!rec || rec.state !== 'recording') return resolve(null);
      const durationMs = Math.round(performance.now() - this.startedAt);
      const done = () => {
        clearTimeout(guard);
        const blob = new Blob(this.chunks, { type: rec.mimeType || this.mimeType || 'audio/webm' });
        this.chunks = [];
        resolve(durationMs < 300 || !blob.size ? null : { blob, durationMs });
      };
      const guard = setTimeout(done, 2000);                     // a recorder on a dead track may never report stop
      rec.onstop = done;
      try { rec.stop(); } catch { done(); }
    });
  }
}
