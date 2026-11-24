// Teach by example: recognise a move by comparing the child with recorded examples.
//
// Each camera frame becomes a set of measurements that don't depend on the
// child's size or distance from the camera:
//   body  - arms and head relative to the shoulders (scaled by shoulder width)
//   hands - the shape of each hand: all 21 finger points relative to the wrist
//   touch - how far each fingertip is from the forehead, nose, mouth and chin
//           (scaled by face width), plus where the index finger is relative
//           to the forehead. This is what makes "finger on forehead" work.
//   place - where each hand is relative to the face or body
// Missing parts are stored as null and simply left out of comparisons.
//
// Held poses: each moment is compared with every recorded moment.
// Movements: the last second or two is compared as a sequence, using dynamic
// time warping so a faster or slower wave still matches.
//
// Pure functions only, so they can be tested without a camera.

const R = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);

// Body landmarks used (MediaPipe Pose): nose, shoulders, elbows, wrists, hips.
const BODY_POINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24];
const BODY_MIRROR = [0, 2, 1, 4, 3, 6, 5, 8, 7]; // left and right swapped
// Face landmarks (MediaPipe Face Mesh): forehead, nose tip, upper lip, chin, cheeks.
export const FACE = { forehead: 151, nose: 1, mouth: 13, chin: 152, left: 234, right: 454 };
const ANCHORS = [FACE.forehead, FACE.nose, FACE.mouth, FACE.chin];
const TIPS = [0, 4, 8, 12]; // wrist, thumb tip, index tip, middle tip

const GROUP_WEIGHT = { body: 1, hands: 1, touch: 1.6, place: 0.7 };

// ---------------------------------------------------------------------------
// Frame -> measurements
// ---------------------------------------------------------------------------
/**
 * pose: 33 pose landmarks (or null). hands: [{ side: "Left"|"Right", lm: [21] }].
 * face: 478 face landmarks (or null). Returns a feature object, or null if
 * nothing useful was seen.
 */
export function featuresFrom(pose, hands, face) {
  // size: how big the child looks (for distance-aware matching); not compared itself.
  const f = { body: null, hands: [null, null], touch: [null, null], place: [null, null], size: null };
  const vis = (p) => p && (p.visibility ?? 1) >= 0.4;

  let shMid = null, shW = null;
  if (pose && vis(pose[11]) && vis(pose[12])) {
    shMid = { x: (pose[11].x + pose[12].x) / 2, y: (pose[11].y + pose[12].y) / 2 };
    shW = Math.max(0.03, Math.hypot(pose[11].x - pose[12].x, pose[11].y - pose[12].y));
    f.body = BODY_POINTS.flatMap((i) => (vis(pose[i]) ? [R((pose[i].x - shMid.x) / shW), R((pose[i].y - shMid.y) / shW)] : [null, null]));
  }
  let faceW = null;
  if (face && face[FACE.left] && face[FACE.right]) {
    faceW = Math.max(0.02, Math.hypot(face[FACE.left].x - face[FACE.right].x, face[FACE.left].y - face[FACE.right].y));
  }
  for (const hand of hands || []) {
    const k = hand.side === "Left" ? 0 : 1;
    const lm = hand.lm;
    if (!lm || lm.length < 21 || f.hands[k]) continue;
    const palm = Math.max(0.01, Math.hypot(lm[9].x - lm[0].x, lm[9].y - lm[0].y));
    f.hands[k] = lm.flatMap((p) => [R((p.x - lm[0].x) / palm), R((p.y - lm[0].y) / palm)]);
    if (faceW) {
      const d = [];
      for (const t of TIPS) for (const a of ANCHORS) d.push(R(Math.hypot(lm[t].x - face[a].x, lm[t].y - face[a].y) / faceW));
      d.push(R((lm[8].x - face[FACE.forehead].x) / faceW), R((lm[8].y - face[FACE.forehead].y) / faceW));
      f.touch[k] = d;
      f.place[k] = [R((lm[0].x - face[FACE.nose].x) / faceW / 3), R((lm[0].y - face[FACE.nose].y) / faceW / 3)];
    } else if (shMid) {
      f.place[k] = [R((lm[0].x - shMid.x) / shW), R((lm[0].y - shMid.y) / shW)];
    }
  }
  f.size = R(shW ?? (faceW ? faceW * 2 : null));
  const anything = f.body || f.hands[0] || f.hands[1];
  return anything ? f : null;
}

/** The same frame as if performed with the other hand (for "either hand works"). */
export function mirror(f) {
  if (!f) return f;
  const negX = (arr) => arr && arr.map((v, i) => (i % 2 === 0 && v !== null ? -v : v));
  const body = f.body && BODY_MIRROR.flatMap((j) => [f.body[j * 2] === null ? null : -f.body[j * 2], f.body[j * 2 + 1]]);
  const touch = (t) => t && t.map((v, i) => (i === 16 && v !== null ? -v : v));
  return {
    size: f.size,
    body,
    hands: [negX(f.hands[1]), negX(f.hands[0])],
    touch: [touch(f.touch[1]), touch(f.touch[0])],
    place: [negX(f.place[1]), negX(f.place[0])],
  };
}

// ---------------------------------------------------------------------------
// Comparing frames and sequences
// ---------------------------------------------------------------------------
function rms(a, b) {
  let sum = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x === null || y === null || x === undefined || y === undefined) continue;
    sum += (x - y) ** 2;
    n++;
  }
  return n ? Math.sqrt(sum / n) : null;
}

/**
 * Distance between two frames (0 = identical). uses: { body, hands, face }.
 * A hand seen in the example but missing live costs a lot; an extra hand
 * that the example didn't have costs a little.
 */
export function frameDistance(live, ex, uses) {
  let total = 0, weight = 0;
  const add = (d, w) => { if (d !== null) { total += d * w; weight += w; } };
  if (uses.body && live.body && ex.body) add(rms(live.body, ex.body), GROUP_WEIGHT.body);
  if (uses.hands) {
    for (let k = 0; k < 2; k++) {
      const a = live.hands[k], b = ex.hands[k];
      if (b && !a) add(1.2, GROUP_WEIGHT.hands);
      else if (a && b) {
        add(rms(a, b), GROUP_WEIGHT.hands);
        if (uses.face && live.touch[k] && ex.touch[k]) add(rms(live.touch[k], ex.touch[k]), GROUP_WEIGHT.touch);
        else if (uses.face && ex.touch[k]) add(1.0, GROUP_WEIGHT.touch);
        if (live.place[k] && ex.place[k]) add(rms(live.place[k], ex.place[k]), GROUP_WEIGHT.place);
      } else if (a && !b) add(0.15, 0.3);
    }
  }
  return weight ? total / weight : 9;
}

/** Dynamic time warping: sequences can be a bit faster or slower and still match. */
export function sequenceDistance(a, b, uses, band = 3) {
  const n = a.length, m = b.length;
  const D = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(Infinity));
  D[0][0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = Math.max(1, i - band); j <= Math.min(m, i + band); j++) {
      const c = frameDistance(a[i - 1], b[j - 1], uses);
      D[i][j] = c + Math.min(D[i - 1][j], D[i][j - 1], D[i - 1][j - 1]);
    }
  }
  return D[n][m] / (n + m) * 2;
}

/** How much a sequence moves (so a still pose can't pass for a movement). */
export function movementAmount(seq, uses) {
  let sum = 0;
  for (let i = 1; i < seq.length; i++) sum += frameDistance(seq[i], seq[i - 1], uses);
  return seq.length > 1 ? sum / (seq.length - 1) : 0;
}

/** Pick `n` evenly spaced frames from timed frames [{t, f}] covering `ms`. */
export function resample(frames, ms, n = 12) {
  if (!frames.length) return [];
  const end = frames[frames.length - 1].t, start = end - ms;
  if (frames[0].t > start + ms * 0.25) return []; // not enough history yet
  const out = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = start + (ms * i) / (n - 1);
    while (j < frames.length - 1 && Math.abs(frames[j + 1].t - t) <= Math.abs(frames[j].t - t)) j++;
    out.push(frames[j].f);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Calibration and quality check
// ---------------------------------------------------------------------------
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
export const SENSITIVITY = { relaxed: 1.4, normal: 1, strict: 0.72 };

/** How big the child looked in the examples (median). */
function typicalSize(takes) {
  const sizes = takes.flatMap((t) => t.frames.map((f) => f?.size)).filter((x) => x > 0);
  return sizes.length ? median(sizes) : null;
}

/**
 * Children further from the camera look smaller, so the same small wobble in
 * tracking is a bigger share of them. Allow proportionally more tolerance
 * (up to 2.5x) for children smaller than in the examples.
 */
export function distanceFactor(refSize, size) {
  if (!refSize || !size) return 1;
  return Math.min(2.5, Math.max(1, refSize / size));
}

/**
 * Work out how close is "close enough", from the examples themselves.
 * Each example is compared with the examples from the *other* takes, so
 * near-identical frames from one take don't make the move over-fussy.
 * Returns { threshold, quality: "none"|"few"|"ok"|"good", message, ... }.
 */
export function calibrate(move) {
  const uses = move.uses || { body: true, hands: true, face: true };
  const pos = move.examples || [], neg = move.negatives || [];
  if (pos.length < 3) {
    return { threshold: null, quality: pos.length ? "few" : "none",
      message: `Record at least 3 examples (${pos.length} so far). 5 or more works best.` };
  }
  const motion = Boolean(move.motion);
  const d = (a, b) => (motion ? sequenceDistance(a, b, uses) : frameDistance(a, b, uses));
  const items = (takes) => (motion ? takes.map((t, i) => ({ take: i, x: t.frames })) : takes.flatMap((t, i) => t.frames.map((x) => ({ take: i, x }))));
  const P = items(pos), N = items(neg);
  const near = P.map((p) => {
    let best = Infinity;
    for (const q of P) if (q.take !== p.take) best = Math.min(best, d(p.x, q.x));
    return best;
  });
  const typical = median(near);
  const spread = [...near].sort((a, b) => a - b)[Math.floor(near.length * 0.9)] || typical;
  let threshold = Math.min(1.5, Math.max(0.08, typical * 2.5, spread * 1.4));
  const motionLevel = motion ? median(pos.map((t) => movementAmount(t.frames, uses))) : null;
  // "Not this" movements that barely move are rejected by the movement check
  // anyway, so they don't count towards the "too similar" warning.
  const Nc = motion ? N.filter((q) => movementAmount(q.x, uses) >= motionLevel * 0.3) : N;
  let closestNeg = Infinity;
  for (const p of P) for (const q of Nc) closestNeg = Math.min(closestNeg, d(p.x, q.x));
  if (closestNeg < threshold) threshold = Math.max(typical * 1.2, closestNeg * 0.85);
  const missed = near.filter((x) => x > threshold).length / near.length;
  const separation = Nc.length ? closestNeg / Math.max(typical, 1e-6) : null;
  let quality = "good", message = "Looks reliable.";
  if (missed > 0.25) { quality = "ok"; message = "The examples vary a lot. Record a few more, a little more consistently."; }
  if (separation !== null && separation < 1.2) { quality = "ok"; message = "The move and the “not this” examples look similar. Make them more different, or add more examples."; }
  if (pos.length < 5 && quality === "good") { quality = "ok"; message = "Working. A couple more examples will make it more reliable."; }
  return { threshold: Math.round(threshold * 1000) / 1000, quality, message, typical, separation, motionLevel, refSize: typicalSize(pos) };
}

// ---------------------------------------------------------------------------
// Live matching
// ---------------------------------------------------------------------------
/** Build a matcher for a taught move. */
export function compile(move, sensitivity = "normal") {
  const uses = move.uses || { body: true, hands: true, face: true };
  const cal = move.calibration || calibrate(move);
  const thr = (cal.threshold ?? 0) * (SENSITIVITY[sensitivity] || 1);
  const pos = move.examples || [], neg = move.negatives || [];
  const either = move.either_hand !== false;
  const ready = Boolean(cal.threshold) && pos.length >= 3;

  const best = (takes, live, dist) => {
    let b = Infinity;
    const variants = either ? [live, move.motion ? live.map(mirror) : mirror(live)] : [live];
    for (const v of variants) {
      for (const t of takes) {
        if (move.motion) b = Math.min(b, dist(v, t.frames));
        else for (const fr of t.frames) b = Math.min(b, dist(v, fr));
      }
    }
    return b;
  };
  const refSize = cal.refSize ?? typicalSize(pos);
  const result = (dPos, dNeg, size) => {
    const t = thr * distanceFactor(refSize, size);
    return {
      match: ready && dPos <= t && (dNeg === Infinity || dPos < dNeg * 0.9),
      similarity: ready ? Math.max(0, Math.min(1, 1 - dPos / (t * 2))) : 0,
      dPos, dNeg,
    };
  };

  return {
    ready,
    motion: Boolean(move.motion),
    windowMs: (move.window_sec || 1.5) * 1000,
    uses,
    /** Held pose: one frame. */
    frame(f) {
      if (!f || !ready) return result(Infinity, Infinity);
      const dist = (a, b) => frameDistance(a, b, uses);
      return result(best(pos, f, dist), neg.length ? best(neg, f, dist) : Infinity, f.size);
    },
    /** Movement: a resampled sequence. */
    sequence(seq) {
      if (!ready || seq.length < 4 || seq.some((x) => !x)) return result(Infinity, Infinity);
      // A still child can't pass for a movement.
      if (cal.motionLevel && movementAmount(seq, uses) < cal.motionLevel * 0.3) return result(Infinity, Infinity);
      const dist = (a, b) => sequenceDistance(a, b, uses);
      return result(best(pos, seq, dist), neg.length ? best(neg, seq, dist) : Infinity, seq[seq.length - 1]?.size);
    },
  };
}
