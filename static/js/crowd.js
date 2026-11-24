// Several children at once.
//
// Crowd   - gives every child in the picture a number that stays with them
//           from frame to frame, and works out which hands and face belong
//           to which child.
// Watcher - judges the watched move for EACH child separately (holding a
//           pose, counting repetitions, taught gestures), then decides for
//           the group: e.g. "5 of 8 children did 3 jumping jacks".
//
// Pure code (no camera, no page), so it can be tested on its own.

import { body, poseNow, RepCounter, moveInfo, STRICTNESS, NOSE, L_SH, R_SH, L_WR, R_WR } from "./moves.js";
import { featuresFrom, compile, resample } from "./taught.js";

const seen = (p, v = 0.4) => Boolean(p) && (p.visibility ?? 1) >= v;
const FORGET_MS = 1500;   // a child out of sight longer than this gets a new number when they return
const RECENT_MS = 3000;   // children seen this recently count towards the group

function centreOf(lm) {
  if (seen(lm[L_SH]) && seen(lm[R_SH])) return { x: (lm[L_SH].x + lm[R_SH].x) / 2, y: (lm[L_SH].y + lm[R_SH].y) / 2 };
  if (seen(lm[NOSE])) return { x: lm[NOSE].x, y: lm[NOSE].y };
  const pts = lm.filter((p) => seen(p));
  if (!pts.length) return null;
  return { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
}

/** How big the child looks (shoulder width): bigger means nearer the camera. */
function sizeOf(lm) {
  if (seen(lm[L_SH]) && seen(lm[R_SH])) return Math.max(0.01, Math.hypot(lm[L_SH].x - lm[R_SH].x, lm[L_SH].y - lm[R_SH].y));
  return 0.08;
}

export class Crowd {
  constructor() {
    this.tracks = [];
    this.nextId = 1;
  }

  /**
   * poses: [landmarks, …]   hands: [{ side, lm }, …]   faces: [landmarks, …]
   * Returns the children visible now, nearest first, each as
   * { id, lm, c: {x, y}, s, hands: [{ side, lm }], face }.
   */
  update(poses, hands, faces, now, { maxPeople = 6, minSize = 0.03 } = {}) {
    const dets = poses
      .map((lm) => ({ lm, c: centreOf(lm), s: sizeOf(lm) }))
      .filter((d) => d.c && d.s >= minSize)
      .sort((a, b) => b.s - a.s)
      .slice(0, maxPeople);

    // Forget children who've been out of sight too long, before matching.
    this.tracks = this.tracks.filter((t) => now - t.seen < FORGET_MS);
    // Match each detection to the nearest existing child (closest pairs first).
    const pairs = [];
    dets.forEach((d, di) => {
      for (const t of this.tracks) {
        const dist = Math.hypot(d.c.x - t.c.x, d.c.y - t.c.y);
        if (dist < Math.max(0.1, 1.5 * Math.max(d.s, t.s))) pairs.push({ di, t, dist });
      }
    });
    pairs.sort((a, b) => a.dist - b.dist);
    const usedD = new Set(), usedT = new Set();
    for (const p of pairs) {
      if (usedD.has(p.di) || usedT.has(p.t.id)) continue;
      usedD.add(p.di);
      usedT.add(p.t.id);
      Object.assign(p.t, { lm: dets[p.di].lm, c: dets[p.di].c, s: dets[p.di].s, seen: now });
    }
    dets.forEach((d, di) => {
      if (!usedD.has(di)) this.tracks.push({ id: this.nextId++, lm: d.lm, c: d.c, s: d.s, seen: now });
    });
    const visible = this.tracks.filter((t) => t.seen === now).sort((a, b) => b.s - a.s);
    for (const t of visible) { t.hands = []; t.face = null; }

    // Each hand belongs to the child whose wrist it's nearest (measured in that child's own size).
    for (const h of hands || []) {
      const w = h.lm?.[0];
      if (!w) continue;
      let best = null, bestD = Infinity;
      for (const t of visible) {
        let d = Infinity;
        for (const k of [L_WR, R_WR]) if (seen(t.lm[k], 0.15)) d = Math.min(d, Math.hypot(w.x - t.lm[k].x, w.y - t.lm[k].y));
        if (d === Infinity && seen(t.lm[NOSE], 0.15)) d = Math.hypot(w.x - t.lm[NOSE].x, w.y - t.lm[NOSE].y) * 0.7;
        const rel = d / t.s;
        if (rel < bestD) { bestD = rel; best = t; }
      }
      if (best && bestD < 1.2) best.hands.push({ ...h, rel: bestD });
    }
    for (const t of visible) if (t.hands.length > 2) t.hands = t.hands.sort((a, b) => a.rel - b.rel).slice(0, 2);

    // Each face belongs to the child whose nose it's on.
    for (const f of faces || []) {
      const n = f?.[1];
      if (!n) continue;
      let best = null, bestD = Infinity;
      for (const t of visible) {
        if (!seen(t.lm[NOSE], 0.15)) continue;
        const rel = Math.hypot(n.x - t.lm[NOSE].x, n.y - t.lm[NOSE].y) / t.s;
        if (rel < bestD) { bestD = rel; best = t; }
      }
      if (best && bestD < 0.8 && !best.face) best.face = f;
    }
    return visible;
  }
}

/** Measurements for one child, for taught moves and recording examples. */
export const featuresOf = (t) => (t ? featuresFrom(t.lm, t.hands || [], t.face || null) : null);

export class Watcher {
  /**
   * id: the move. custom: { id: definition } for custom and taught moves.
   * opts: holdSec, reps, strictness, crowdShare (0..1), minPeople, crowdSec.
   * mode: "single" (the nearest child) or "auditorium" (everyone).
   */
  constructor(id, custom = {}, opts = {}, mode = "single") {
    this.id = id;
    this.def = custom[id];
    this.info = moveInfo(id, Object.values(custom));
    this.mode = mode === "auditorium" ? "auditorium" : "single";
    this.reps = Math.max(1, opts.reps || this.info.reps || 1);
    this.holdMs = Math.max(0.2, opts.holdSec ?? 1) * 1000;
    this.strict = STRICTNESS[opts.strictness] || STRICTNESS.normal;
    this.crowdShare = Math.min(1, Math.max(0.05, opts.crowdShare ?? 0.5));
    this.minPeople = Math.max(1, opts.minPeople ?? 1);
    this.crowdMs = (opts.crowdSec ?? Math.max(1.5, this.reps * 0.7)) * 1000;
    this.taught = this.def?.type === "taught" ? compile(this.def, opts.strictness || "normal") : null;
    this.per = new Map();       // child id -> their progress
    this.visibleIds = [];
    this.activeMs = 0;          // fallback: time the room has been moving
    this.fallback = false;
    this.done = false;
    this.lastT = null;
  }

  state(id) {
    if (!this.per.has(id)) {
      this.per.set(id, { history: [], heldSince: null, done: false, counter: null, count: 0, buffer: [],
        lastCount: 0, lastCheck: 0, similarity: 0, doing: false, flash: 0, seen: 0 });
    }
    return this.per.get(id);
  }

  /** Call every frame. t = show-clock time (stops while paused). */
  update(visible, now, t, roomMoving = false, paused = false) {
    const dt = this.lastT === null ? 0 : Math.min(200, t - this.lastT);
    this.lastT = t;
    this.visibleIds = visible.map((v) => v.id);
    this.positions = new Map(visible.map((v) => [v.id, v.c]));
    if (paused || this.done) return;
    const people = this.mode === "single" ? visible.slice(0, 1) : visible;
    for (const child of people) this.judge(child, now, t);

    const recent = [...this.per.values()].filter((st) => now - st.seen < RECENT_MS);
    this.seenCount = recent.length;
    this.doneCount = recent.filter((st) => st.done).length;
    this.doingCount = people.filter((c) => this.state(c.id).doing).length;

    if (this.mode === "single") {
      if (this.doneCount >= 1) this.done = true;
      return;
    }
    // Nobody can be picked out (too far, too crowded): use overall room movement for movements.
    this.fallback = people.length === 0 && this.info.kind === "count" && !this.taught;
    if (this.fallback) {
      if (roomMoving) this.activeMs += dt;
      else this.activeMs = Math.max(0, this.activeMs - dt * 0.5);
      if (this.activeMs >= this.crowdMs) this.done = true;
      return;
    }
    if (this.doneCount >= this.needed()) this.done = true;
  }

  /** How many children must finish, given how many are in view. */
  needed() {
    return Math.max(this.minPeople, Math.ceil(this.crowdShare * Math.max(1, this.seenCount || 0)));
  }

  judge(child, now, t) {
    const st = this.state(child.id);
    st.seen = now;
    if (st.done) { st.doing = false; return; }
    if (this.taught) {
      const f = featuresOf(child);
      if (!this.taught.motion) {
        const r = this.taught.frame(f);
        st.similarity = r.similarity;
        this.hold(st, now, t, r.match);
        return;
      }
      if (f) st.buffer.push({ t: now, f });
      st.buffer = st.buffer.filter((x) => now - x.t < this.taught.windowMs + 400);
      if (now - st.lastCheck >= 100) {
        st.lastCheck = now;
        const r = this.taught.sequence(resample(st.buffer, this.taught.windowMs, 12));
        st.similarity = r.similarity;
        if (r.match && now - st.lastCount > this.taught.windowMs * 0.7) { st.lastCount = now; st.count++; st.flash = now; }
      }
      st.doing = now - st.flash < 600;
      if (st.count >= this.reps) st.done = true;
      return;
    }
    const b = body(child.lm, this.strict.visibility);
    if (this.info.kind === "hold") {
      this.hold(st, now, t, poseNow(this.id, b, this.def));
      return;
    }
    st.counter ??= new RepCounter(this.id);
    if (st.counter.update(b, now)) st.flash = now;
    st.count = st.counter.count;
    st.doing = now - st.flash < 500;
    if (st.count >= this.reps) st.done = true;
  }

  /** Smoothing: the pose counts only if most recent frames agree; then time the hold. */
  hold(st, now, t, raw) {
    st.history.push({ t: now, v: raw });
    st.history = st.history.filter((x) => now - x.t < 450);
    const share = st.history.filter((x) => x.v).length / st.history.length;
    st.doing = share >= this.strict.share;
    if (st.doing) st.heldSince ??= t; else st.heldSince = null;
    if (st.heldSince !== null && t - st.heldSince >= this.holdMs) st.done = true;
  }

  personValue(st, t) {
    if (st.done) return 1;
    if (this.info.kind === "hold" || (this.taught && !this.taught.motion)) {
      return st.heldSince !== null ? Math.min(1, (t - st.heldSince) / this.holdMs) : 0;
    }
    return Math.min(1, st.count / this.reps);
  }

  /** { value 0..1, label, doingNow, people, doingPeople, donePeople, similarity, persons: [...] } */
  progress(now, t) {
    const persons = this.visibleIds.map((id) => {
      const st = this.state(id);
      return { id, done: st.done, doing: st.doing, value: this.personValue(st, t), at: this.positions?.get(id) };
    });
    const base = { people: this.visibleIds.length, doingPeople: this.doingCount || 0, donePeople: this.doneCount || 0, persons };
    if (this.taught && !this.taught.ready) return { ...base, value: 0, label: "Needs more examples", doingNow: false, similarity: 0 };

    if (this.mode === "single") {
      const id = this.visibleIds[0];
      const st = id !== undefined ? this.state(id) : null;
      const doneSt = [...this.per.values()].find((x) => x.done);
      const value = this.done || doneSt ? 1 : st ? this.personValue(st, t) : 0;
      let label = "";
      if (!this.done && st && this.info.kind === "count" && this.reps > 1) label = `${Math.min(st.count, this.reps)} of ${this.reps}`;
      if (!this.done && st && this.taught && !st.doing) label = `${Math.round(st.similarity * 100)}% like the examples`;
      return { ...base, value, label, doingNow: Boolean(st?.doing), similarity: st?.similarity || 0 };
    }
    if (this.fallback) {
      return { ...base, value: this.done ? 1 : Math.min(1, this.activeMs / this.crowdMs), label: "Everybody moving!", doingNow: this.activeMs > 0, similarity: 0 };
    }
    const need = this.needed();
    const value = this.done ? 1 : Math.min(1, (this.doneCount || 0) / need);
    const label = this.seenCount ? `${this.doneCount || 0} of ${this.seenCount} children` : "Looking for children…";
    const best = Math.max(0, ...[...this.per.values()].map((x) => x.similarity || 0));
    return { ...base, value, label, doingNow: (this.doingCount || 0) > 0, similarity: best };
  }
}
