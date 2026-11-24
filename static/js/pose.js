// Camera: runs MediaPipe body, hand and face tracking in the browser (video
// never leaves the computer), keeps track of each child with the Crowd
// tracker, and judges the watched move with a Watcher (see crowd.js).
//
//   single     - the child nearest the camera; precise tracking.
//   auditorium - every child it can pick out (up to "max people"), judged
//                separately, then decided as a group ("5 of 8 children").
//                If nobody can be picked out, movements fall back to
//                overall movement in the picture.

import { clock } from "./clock.js";
import { FACE } from "./taught.js";
import { BONES, NOSE, L_WR, R_WR } from "./moves.js";
import { Crowd, Watcher, featuresOf } from "./crowd.js";

export { STRICTNESS, BUILTIN_MOVES, BODY_PARTS, RELATIONS, moveInfo, moveName, isHoldMove } from "./moves.js";

const MP_VERSION = "0.10.14";
const MP_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`;
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const HAND_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const FACE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const HAND_BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];

/**
 * Create a MediaPipe tracker, trying the graphics card first and falling back
 * to the processor if the graphics card isn't available (common on some laptops).
 */
async function makeTracker(Cls, fileset, modelUrl, extra) {
  try {
    const lm = await Cls.createFromOptions(fileset, { baseOptions: { modelAssetPath: modelUrl, delegate: "GPU" }, runningMode: "VIDEO", ...extra });
    return { lm, how: "graphics card" };
  } catch (gpuErr) {
    console.warn("GPU tracker failed, trying CPU:", gpuErr);
    const lm = await Cls.createFromOptions(fileset, { baseOptions: { modelAssetPath: modelUrl, delegate: "CPU" }, runningMode: "VIDEO", ...extra });
    return { lm, how: "processor" };
  }
}

const errText = (e) => String(e?.message || e || "unknown error").slice(0, 160);

export class PoseDetector {
  constructor(videoEl, canvasEl, { onStatus } = {}) {
    this.video = videoEl;
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext("2d");
    this.onStatus = onStatus || (() => {});
    this.landmarker = null;
    this.running = false;
    this.mode = "single";
    this.maxPeople = 6;
    this.custom = {};
    this.crowd = new Crowd();
    this.visible = [];        // children in view now, nearest first (see crowd.js)
    this.people = [];         // their body landmarks (older code reads this)
    this.state = { person: false, people: 0 };
    this.watcher = null;
    this.target = null;
    this.motion = 0;          // overall movement in the picture, 0..1 (smoothed)
    this._calm = 0.01;
    this._lastTs = -1;
    this._tick = 0;
    this._small = document.createElement("canvas");
    this._small.width = 64;
    this._small.height = 48;
    this._sctx = this._small.getContext("2d", { willReadFrequently: true });
    this._prev = null;
    this.handLm = null;
    this.faceLm = null;
    this.detail = { hands: false, face: false };
    this.handResult = null;
    this.faceResult = null;
    this.keepDetail = false;
    this.info = { body: "off", hands: "off", face: "off", fps: 0, lastError: null };
    this._frames = 0;
    this._fpsAt = performance.now();
  }

  // ---- how many of each thing to look for --------------------------------
  get poseCount() { return this.mode === "auditorium" ? this.maxPeople : 3; }   // single: a few, then pick the nearest
  get handCount() { return this.mode === "auditorium" ? Math.min(2 * this.maxPeople, 12) : 2; }
  get faceCount() { return this.mode === "auditorium" ? Math.min(this.maxPeople, 8) : 1; }

  async applyCounts() {
    const safe = async (lm, opts) => { if (lm) try { await lm.setOptions(opts); } catch { /* older versions */ } };
    await safe(this.landmarker, { numPoses: this.poseCount });
    await safe(this.handLm, { numHands: this.handCount });
    await safe(this.faceLm, { numFaces: this.faceCount });
  }

  async setMode(mode) {
    this.mode = mode === "auditorium" ? "auditorium" : "single";
    await this.applyCounts();
  }

  /** How many children to track at once in Auditorium mode (2–10). More is slower. */
  async setMaxPeople(n) {
    this.maxPeople = Math.max(2, Math.min(10, Math.round(n || 6)));
    await this.applyCounts();
  }

  setCustomMoves(defs) {
    this.custom = Object.fromEntries((defs || []).map((d) => [d.id, d]));
  }

  // ---- loading -------------------------------------------------------------
  /** Load the hand/face trackers a move needs (once), without switching them on. */
  async ensureDetail(uses = {}) {
    if (!this._vision) return;
    const { HandLandmarker, FaceLandmarker } = this._vision;
    if (uses.hands && !this.handLm && !this._loadingHands) {
      this._loadingHands = true;
      this.info.hands = "loading…";
      this.onStatus("loading");
      try {
        const t = await makeTracker(HandLandmarker, this._fileset, HAND_MODEL_URL, { numHands: this.handCount });
        this.handLm = t.lm;
        this.info.hands = `working (${t.how})`;
      } catch (err) {
        this.info.hands = `couldn't load: ${errText(err)}`;
        this.info.lastError = `Hand tracking: ${errText(err)}`;
        this.onStatus("detail-failed");
      }
      this._loadingHands = false;
    }
    if (uses.face && !this.faceLm && !this._loadingFace) {
      this._loadingFace = true;
      this.info.face = "loading…";
      this.onStatus("loading");
      try {
        const t = await makeTracker(FaceLandmarker, this._fileset, FACE_MODEL_URL, { numFaces: this.faceCount });
        this.faceLm = t.lm;
        this.info.face = `working (${t.how})`;
      } catch (err) {
        this.info.face = `couldn't load: ${errText(err)}`;
        this.info.lastError = `Face tracking: ${errText(err)}`;
        this.onStatus("detail-failed");
      }
      this._loadingFace = false;
    }
    if (this.running) this.onStatus("watching");
  }

  /** Switch hand/face tracking on or off (they cost speed, so only when needed). */
  async setDetail(uses = {}) {
    await this.ensureDetail(uses);
    this.detail = { hands: Boolean(uses.hands && this.handLm), face: Boolean(uses.face && this.faceLm) };
    if (!this.detail.hands) this.handResult = null;
    if (!this.detail.face) this.faceResult = null;
  }

  async start() {
    try {
      this.onStatus("loading");
      this.info.body = "loading…";
      this._vision = await import(MP_URL);
      const { PoseLandmarker, FilesetResolver } = this._vision;
      this._fileset = await FilesetResolver.forVisionTasks(WASM_URL);
      const t = await makeTracker(PoseLandmarker, this._fileset, MODEL_URL, { numPoses: this.poseCount });
      this.landmarker = t.lm;
      this.info.body = `working (${t.how})`;
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" }, audio: false });
      this.video.srcObject = stream;
      await this.video.play();
      this.running = true;
      this.onStatus("watching");
      this._loop();
    } catch (err) {
      console.warn("Camera/pose failed:", err);
      const blocked = err && err.name === "NotAllowedError";
      this.info.body = blocked ? "camera blocked by the browser" : `couldn't start: ${errText(err)}`;
      this.info.lastError = this.info.body;
      this.onStatus(blocked ? "blocked" : "error");
    }
  }

  stop() {
    this.running = false;
    const s = this.video.srcObject;
    if (s) s.getTracks().forEach((t) => t.stop());
    this.video.srcObject = null;
    this.onStatus("off");
  }

  // ---- watching a move -----------------------------------------------------
  /**
   * Start watching for a move. Options: holdSec, reps, strictness,
   * crowdShare (0..1), minPeople, crowdSec. See Watcher in crowd.js.
   */
  watch(id, opts = {}) {
    this.watcher = new Watcher(id, this.custom, opts, this.mode);
    this.target = id;
    const def = this.custom[id];
    if (def?.type === "taught") this.setDetail(def.uses || {});
    else if (!this.keepDetail) this.setDetail({});
  }

  unwatch() {
    this.watcher = null;
    this.target = null;
    if (!this.keepDetail) this.setDetail({});
  }

  /** { value, label, doingNow, people, doingPeople, donePeople, similarity, persons } */
  progress() {
    if (!this.watcher) return { value: 0, label: "", doingNow: false, people: this.state.people, doingPeople: 0, donePeople: 0, similarity: 0, persons: [] };
    return this.watcher.progress(performance.now(), clock.now());
  }

  isDoing(id) {
    if (this.watcher?.id !== id) this.watch(id);
    return this.progress().doingNow;
  }

  /** Measurements for the nearest child (used when recording taught examples). */
  currentFeatures() {
    return featuresOf(this.visible[0]);
  }

  /**
   * "Stand to choose": how many children are in each of n zones, left to right
   * as the children see themselves on screen (the preview is a mirror image).
   */
  zoneCounts(n) {
    const counts = Array(n).fill(0);
    for (const v of this.visible || []) {
      if (!v.c) continue;
      const mirrored = 1 - v.c.x;
      counts[Math.min(n - 1, Math.max(0, Math.floor(mirrored * n)))]++;
    }
    return counts;
  }

  get roomIsMoving() {
    return this.motion > Math.max(0.025, this._calm * 3);
  }

  // ---- every frame -----------------------------------------------------------
  _loop() {
    if (!this.running) return;
    const now = performance.now();
    if (this.video.readyState >= 2 && now !== this._lastTs) {
      this._lastTs = now;
      this._tick++;
      let poses = [];
      try {
        poses = this.landmarker.detectForVideo(this.video, now).landmarks || [];
        // In Auditorium mode hands and faces are checked every other frame, to keep things quick.
        const detailNow = this.mode === "single" || this._tick % 2 === 0;
        if (detailNow && this.detail.hands && this.handLm) this.handResult = this.handLm.detectForVideo(this.video, now);
        if (detailNow && this.detail.face && this.faceLm) this.faceResult = this.faceLm.detectForVideo(this.video, now);
      } catch (err) {
        this.info.lastError = `Tracking error: ${errText(err)}`;
      }
      const hands = (this.handResult?.landmarks || []).map((lm, i) => ({
        side: (this.handResult.handedness || this.handResult.handednesses || [])[i]?.[0]?.categoryName || "Right", lm,
      }));
      this.visible = this.crowd.update(poses, hands, this.faceResult?.faceLandmarks || [], now, { maxPeople: this.poseCount });
      this.people = this.visible.map((t) => t.lm);
      this.state.person = this.visible.length > 0;
      this.state.people = this.visible.length;
      this._measureMotion();
      this.watcher?.update(this.visible, now, clock.now(), this.roomIsMoving, clock.paused);
      this._draw();
      this._frames++;
      if (now - this._fpsAt > 1000) { this.info.fps = Math.round((this._frames * 1000) / (now - this._fpsAt)); this._frames = 0; this._fpsAt = now; }
    }
    requestAnimationFrame(() => this._loop());
  }

  /** Overall movement: difference between this frame and the last, on a tiny grey copy. */
  _measureMotion() {
    const c = this._sctx;
    c.drawImage(this.video, 0, 0, 64, 48);
    const px = c.getImageData(0, 0, 64, 48).data;
    const grey = new Uint8Array(64 * 48);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) grey[j] = (px[i] * 3 + px[i + 1] * 6 + px[i + 2]) / 10;
    if (this._prev) {
      let diff = 0;
      for (let j = 0; j < grey.length; j++) diff += Math.abs(grey[j] - this._prev[j]);
      const e = diff / grey.length / 255;
      this.motion = this.motion * 0.8 + e * 0.2;
      if (this.motion < this._calm * 2) this._calm = this._calm * 0.99 + this.motion * 0.01;
    }
    this._prev = grey;
  }

  /** Skeletons (green = done, light green = doing it, yellow = not yet), hands, face points and each child's number. */
  _draw() {
    const { canvas, ctx, video } = this;
    if (canvas.width !== video.videoWidth) {
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
    }
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const w = this.watcher;
    const multi = this.visible.length > 1;
    this.visible.forEach((child, i) => {
      const st = w?.per.get(child.id);
      const judged = w && (this.mode === "auditorium" || i === 0);
      const colour = judged && st?.done ? "#4FAF8A" : judged && st?.doing ? "#A7E3B5" : judged || !w ? "#F4C542" : "#8C86B0";
      const lm = child.lm;
      ctx.lineWidth = 4;
      ctx.strokeStyle = colour;
      ctx.fillStyle = colour;
      for (const [a, b] of BONES) {
        if (!lm[a] || !lm[b]) continue;
        ctx.beginPath();
        ctx.moveTo(lm[a].x * W, lm[a].y * H);
        ctx.lineTo(lm[b].x * W, lm[b].y * H);
        ctx.stroke();
      }
      for (const j of [NOSE, L_WR, R_WR]) {
        if (!lm[j]) continue;
        ctx.beginPath();
        ctx.arc(lm[j].x * W, lm[j].y * H, 6, 0, Math.PI * 2);
        ctx.fill();
      }
      // The child's number above their head (drawn flipped, because the picture is shown mirrored).
      if (multi && lm[NOSE]) {
        const x = lm[NOSE].x * W, y = Math.max(16, lm[NOSE].y * H - 34);
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(-1, 1);
        ctx.beginPath();
        ctx.arc(0, 0, 13, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#1B1633";
        ctx.font = "bold 15px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(st?.done ? "✓" : String(child.id), 0, 1);
        ctx.restore();
      }
      // Fingers and face points for this child.
      ctx.lineWidth = 2;
      ctx.strokeStyle = ctx.fillStyle = st?.doing || st?.done ? "#4FAF8A" : "#8FD3FF";
      for (const hand of child.hands || []) {
        for (const [a, b] of HAND_BONES) {
          ctx.beginPath();
          ctx.moveTo(hand.lm[a].x * W, hand.lm[a].y * H);
          ctx.lineTo(hand.lm[b].x * W, hand.lm[b].y * H);
          ctx.stroke();
        }
      }
      if (child.face) {
        ctx.fillStyle = "#F4C542";
        for (const idx of [FACE.forehead, FACE.nose, FACE.mouth, FACE.chin]) {
          ctx.beginPath();
          ctx.arc(child.face[idx].x * W, child.face[idx].y * H, 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    });
  }
}
