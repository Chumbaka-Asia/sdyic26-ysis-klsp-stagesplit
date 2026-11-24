// Records the microphone during a "name" question so Whisper can transcribe it,
// and watches loudness so the show knows when the children start shouting
// (useful when Chrome's own listening isn't available).
//
// Audio stays in memory and is sent only to our own server on this laptop.

import { clock } from "./clock.js";

export class Recorder {
  constructor({ onLevel } = {}) {
    this.onLevel = onLevel || (() => {});
    this.stream = null;
    this.rec = null;
    this.chunks = [];
    this.ready = false;
    this.shoutAt = null;   // clock time when loud sound first started in this recording
    this.level = 0;
  }

  static supported() {
    return Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  }

  /** Ask for the microphone once, at the start of the show. */
  async init() {
    if (!Recorder.supported()) return false;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(this.stream);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      src.connect(this.analyser);
      this.ctx = ctx;
      this.buf = new Float32Array(this.analyser.fftSize);
      this.floor = 0.01;
      this._watch();
      this.ready = true;
    } catch (err) {
      console.warn("Recorder unavailable:", err);
      this.ready = false;
      this.failed = true;
    }
    return this.ready;
  }

  /** Continuous loudness meter. Tracks background noise so a shout stands out. */
  _watch() {
    const tick = () => {
      if (!this.analyser) return;
      this.analyser.getFloatTimeDomainData(this.buf);
      let sum = 0;
      for (const v of this.buf) sum += v * v;
      const rms = Math.sqrt(sum / this.buf.length);
      const loud = rms > Math.max(0.03, this.floor * 3);
      if (!loud) this.floor = this.floor * 0.98 + rms * 0.02; // slowly learn the room's noise
      if (loud && this.rec?.state === "recording") {
        this._loudFor = (this._loudFor || 0) + 1;
        if (this._loudFor > 6 && this.shoutAt === null) this.shoutAt = clock.now(); // ~0.1 s of loudness
      } else {
        this._loudFor = 0;
      }
      this.level = Math.min(1, rms / 0.25);   // 0..1 loudness, read by meters and cheer voting
      this.onLevel(this.level);
      requestAnimationFrame(tick);
    };
    tick();
  }

  start() {
    if (!this.ready) return false;
    if (this.ctx?.state === "suspended") this.ctx.resume();
    this.chunks = [];
    this.shoutAt = null;
    const type = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]
      .find((t) => MediaRecorder.isTypeSupported(t));
    this.rec = new MediaRecorder(this.stream, type ? { mimeType: type } : undefined);
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start(250);
    return true;
  }

  /** While paused, recording pauses too. */
  pause() { if (this.rec?.state === "recording") this.rec.pause(); }
  resume() { if (this.rec?.state === "paused") this.rec.resume(); }

  /** Stop and return the recording as a Blob (or null). */
  stop() {
    return new Promise((resolve) => {
      if (!this.rec || this.rec.state === "inactive") return resolve(null);
      this.rec.onstop = () => {
        const blob = this.chunks.length ? new Blob(this.chunks, { type: this.rec.mimeType }) : null;
        this.chunks = [];
        resolve(blob);
      };
      this.rec.stop();
    });
  }
}
