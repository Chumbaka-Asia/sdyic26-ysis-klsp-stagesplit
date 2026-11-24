// Moves: what each move is, and how to judge it for ONE person.
// Pure functions and classes (no camera, no page), shared by the camera
// module, the crowd tracker and the tests.

// Landmark indices (MediaPipe Pose)
export const NOSE = 0, L_SH = 11, R_SH = 12, L_EL = 13, R_EL = 14, L_WR = 15, R_WR = 16,
  L_HIP = 23, R_HIP = 24, L_KN = 25, R_KN = 26, L_AN = 27, R_AN = 28;
export const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];

export const STRICTNESS = {
  relaxed: { visibility: 0.3, share: 0.5, label: "Relaxed (young children, loose movements)" },
  normal: { visibility: 0.5, share: 0.6, label: "Normal" },
  strict: { visibility: 0.7, share: 0.75, label: "Strict (must be clear and exact)" },
};

export const BUILTIN_MOVES = [
  { id: "hands_up", name: "Both hands up", kind: "hold", desc: "Both hands higher than the head." },
  { id: "arms_out", name: "Arms out like a star", kind: "hold", desc: "Both arms stretched out sideways at shoulder height." },
  { id: "touch_toes", name: "Touch your toes", kind: "hold", desc: "Both hands lower than the knees." },
  { id: "jump", name: "Jump", kind: "count", reps: 1, unit: "jump", desc: "The body rises quickly and lands." },
  { id: "wave", name: "Wave", kind: "count", reps: 1, unit: "wave", desc: "A raised hand swings from side to side." },
  { id: "clap", name: "Clap", kind: "count", reps: 3, unit: "clap", desc: "Hands come together from apart." },
  { id: "jumping_jacks", name: "Jumping jacks", kind: "count", reps: 3, unit: "jumping jack", desc: "Arms up and legs apart, then arms down and legs together. Works with arms only if legs are out of view." },
  { id: "flap_wings", name: "Flap fairy wings", kind: "count", reps: 3, unit: "flap", desc: "Arms out to the sides, flapping up and down together." },
  { id: "march", name: "March on the spot", kind: "count", reps: 6, unit: "step", desc: "Knees lifted one after the other." },
  { id: "spin", name: "Spin around", kind: "count", reps: 1, unit: "spin", desc: "Turn all the way round: face the camera, turn away, face it again." },
];

export const BODY_PARTS = [
  { id: "head", label: "Head", index: NOSE },
  { id: "left_hand", label: "Left hand", index: L_WR },
  { id: "right_hand", label: "Right hand", index: R_WR },
  { id: "left_elbow", label: "Left elbow", index: L_EL },
  { id: "right_elbow", label: "Right elbow", index: R_EL },
  { id: "left_shoulder", label: "Left shoulder", index: L_SH },
  { id: "right_shoulder", label: "Right shoulder", index: R_SH },
  { id: "left_hip", label: "Left hip", index: L_HIP },
  { id: "right_hip", label: "Right hip", index: R_HIP },
  { id: "left_knee", label: "Left knee", index: L_KN },
  { id: "right_knee", label: "Right knee", index: R_KN },
  { id: "left_foot", label: "Left foot", index: L_AN },
  { id: "right_foot", label: "Right foot", index: R_AN },
];
export const RELATIONS = [
  { id: "above", label: "is higher than" },
  { id: "below", label: "is lower than" },
  { id: "near", label: "is close to" },
  { id: "far", label: "is far from" },
];
const PART_INDEX = Object.fromEntries(BODY_PARTS.map((p) => [p.id, p.index]));

/** Everything the editor and show need to know about a move. */
export function moveInfo(id, customMoves = []) {
  const b = BUILTIN_MOVES.find((m) => m.id === id);
  if (b) return b;
  const c = customMoves.find((m) => m.id === id);
  if (c?.type === "taught") {
    return { id: c.id, name: c.name || "Untitled move", kind: c.motion ? "count" : "hold", reps: 1, unit: "time",
      custom: true, taught: true, uses: c.uses || {}, desc: "Taught by example." };
  }
  if (c) return { id: c.id, name: c.name || "Untitled move", kind: "hold", custom: true, desc: "Your own move." };
  return { id, name: id, kind: "hold", missing: true };
}
export const moveName = (id, custom = []) => moveInfo(id, custom).name;
export const isHoldMove = (id, custom = []) => moveInfo(id, custom).kind === "hold";

// ---------------------------------------------------------------------------
// Geometry helpers on one person's landmarks
// ---------------------------------------------------------------------------
export function body(lm, minVis) {
  const ok = (i) => Boolean(lm[i]) && (lm[i].visibility ?? 1) >= minVis;
  const mid = (a, b) => ({ x: (lm[a].x + lm[b].x) / 2, y: (lm[a].y + lm[b].y) / 2 });
  const sh = ok(L_SH) && ok(R_SH) ? mid(L_SH, R_SH) : null;
  const hip = ok(L_HIP) && ok(R_HIP) ? mid(L_HIP, R_HIP) : null;
  const torso = sh && hip ? Math.max(0.05, hip.y - sh.y) : 0.25;
  const shoulderWidth = sh ? Math.abs(lm[L_SH].x - lm[R_SH].x) : null;
  const hipWidth = hip ? Math.abs(lm[L_HIP].x - lm[R_HIP].x) : null;
  const dist = (a, b) => Math.hypot(lm[a].x - lm[b].x, lm[a].y - lm[b].y);
  return { lm, ok, sh, hip, torso, shoulderWidth, hipWidth, dist };
}

/** Is this person in a "hold" pose right now (one frame)? */
export function poseNow(id, b, custom) {
  const { lm, ok, torso } = b;
  switch (id) {
    case "hands_up":
      return ok(NOSE) && ok(L_WR) && ok(R_WR) && lm[L_WR].y < lm[NOSE].y && lm[R_WR].y < lm[NOSE].y;
    case "arms_out":
      return ok(L_WR) && ok(R_WR) && ok(L_SH) && ok(R_SH)
        && Math.abs(lm[L_WR].y - lm[L_SH].y) < 0.4 * torso && Math.abs(lm[R_WR].y - lm[R_SH].y) < 0.4 * torso
        && Math.abs(lm[L_WR].x - lm[L_SH].x) > 0.8 * torso && Math.abs(lm[R_WR].x - lm[R_SH].x) > 0.8 * torso;
    case "touch_toes":
      return ok(L_WR) && ok(R_WR) && ok(L_KN) && ok(R_KN) && lm[L_WR].y > lm[L_KN].y && lm[R_WR].y > lm[R_KN].y;
    default: {
      const rules = custom?.conditions || [];
      if (!rules.length) return false;
      const margin = 0.08 * torso;
      return rules.every((r) => {
        const ia = PART_INDEX[r.part], ib = PART_INDEX[r.target];
        if (!ok(ia) || !ok(ib)) return false;
        const a = lm[ia], c = lm[ib];
        const d = Math.hypot(a.x - c.x, a.y - c.y);
        switch (r.relation) {
          case "above": return a.y < c.y - margin;
          case "below": return a.y > c.y + margin;
          case "near": return d < 0.45 * torso;
          case "far": return d > 1.0 * torso;
          default: return false;
        }
      });
    }
  }
}

/** Counts repetitions of a movement for one person, frame by frame. */
export class RepCounter {
  constructor(id) {
    this.id = id;
    this.count = 0;
    this.state = "start";
    this.times = [];
    this.baseline = null;
    this.faceWidth = null;
    this.lastSide = null;
    this.awayAt = 0;
  }

  /** Feed one frame. Returns true when a new repetition was completed. */
  update(b, now) {
    const { lm, ok, torso } = b;
    const before = this.count;
    switch (this.id) {
      case "jump": {
        // Hips if the camera sees them; otherwise shoulders (laptop webcams often see head and shoulders only).
        const ref = b.hip ? "hip" : b.sh ? "sh" : null;
        if (!ref) break;
        if (ref !== this.ref) { this.ref = ref; this.baseline = null; }
        const y = ref === "hip" ? b.hip.y : b.sh.y;
        const scale = ref === "hip" ? torso : Math.max(0.05, (b.shoulderWidth || 0.2) * 1.1);
        this.baseline ??= y;
        const rise = (this.baseline - y) / scale;
        if (this.state !== "up" && rise > 0.25) { this.state = "up"; this.count++; }
        if (rise < 0.1) { this.state = "down"; this.baseline = this.baseline * 0.95 + y * 0.05; }
        break;
      }
      case "wave": {
        const side = (w, s) => (ok(w) && ok(s) && lm[w].y < lm[s].y ? Math.sign(lm[w].x - lm[s].x) : 0);
        const s = side(R_WR, R_SH) || side(L_WR, L_SH);
        if (s && this.lastSide && s !== this.lastSide) this.times.push(now);
        if (s) this.lastSide = s;
        this.times = this.times.filter((t) => now - t < 2000);
        if (this.times.length >= 3) { this.count++; this.times = []; }
        break;
      }
      case "clap": {
        if (!ok(L_WR) || !ok(R_WR)) break;
        const d = b.dist(L_WR, R_WR) / torso;
        if (d > 0.8) this.state = "apart";
        if (d < 0.3 && this.state === "apart") { this.state = "together"; this.count++; }
        break;
      }
      case "jumping_jacks": {
        if (!ok(L_WR) || !ok(R_WR) || !ok(L_SH) || !ok(R_SH)) break;
        const armsUp = lm[L_WR].y < lm[L_SH].y && lm[R_WR].y < lm[R_SH].y;
        const armsDown = lm[L_WR].y > lm[L_SH].y + 0.3 * torso && lm[R_WR].y > lm[R_SH].y + 0.3 * torso;
        const legsVisible = ok(L_AN) && ok(R_AN) && b.hipWidth;
        const legsApart = legsVisible ? Math.abs(lm[L_AN].x - lm[R_AN].x) > 1.8 * b.hipWidth : true;
        const legsTogether = legsVisible ? Math.abs(lm[L_AN].x - lm[R_AN].x) < 1.3 * b.hipWidth : true;
        if (armsUp && legsApart) this.state = "open";
        if (armsDown && legsTogether && this.state === "open") { this.state = "closed"; this.count++; }
        break;
      }
      case "flap_wings": {
        if (!ok(L_WR) || !ok(R_WR) || !ok(L_SH) || !ok(R_SH)) break;
        const out = Math.abs(lm[L_WR].x - lm[L_SH].x) > 0.5 * torso && Math.abs(lm[R_WR].x - lm[R_SH].x) > 0.5 * torso;
        const high = lm[L_WR].y < lm[L_SH].y - 0.1 * torso && lm[R_WR].y < lm[R_SH].y - 0.1 * torso;
        const low = lm[L_WR].y > lm[L_SH].y + 0.25 * torso && lm[R_WR].y > lm[R_SH].y + 0.25 * torso;
        if (out && high) this.state = "high";
        if (out && low && this.state === "high") { this.state = "low"; this.count++; }
        break;
      }
      case "march": {
        if (!b.hip) break;
        const lifted = (k, h) => ok(k) && ok(h) && lm[k].y - lm[h].y < 0.6 * torso;
        const side = lifted(L_KN, L_HIP) ? "L" : lifted(R_KN, R_HIP) ? "R" : null;
        if (side && side !== this.lastSide) { this.count++; this.lastSide = side; }
        break;
      }
      case "spin": {
        const facing = ok(NOSE) && b.shoulderWidth && (!this.faceWidth || b.shoulderWidth > 0.6 * this.faceWidth);
        const away = !ok(NOSE) || (this.faceWidth && b.shoulderWidth !== null && b.shoulderWidth < 0.35 * this.faceWidth);
        if (facing) this.faceWidth = this.faceWidth ? this.faceWidth * 0.9 + b.shoulderWidth * 0.1 : b.shoulderWidth;
        if (facing && this.state === "away" && now - this.awayAt < 4000) { this.count++; this.state = "facing"; }
        else if (facing) this.state = "facing";
        if (away && this.state === "facing") { this.state = "away"; this.awayAt = now; }
        break;
      }
    }
    return this.count > before;
  }
}
