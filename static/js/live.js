// Online room, host side.
//
// The show window is the "director". This module tells the server what the
// stage is doing (clip, question, pause, the move to do), so everyone watching
// on their own device sees the same thing at the same moment. It also reads
// back who's here, how they're doing with the move, where they're standing,
// how loud they're cheering, and anything they said or typed.

async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  return res.json().catch(() => ({}));
}

export class LiveHost {
  constructor({ onRoster, onSpeech, onProblem } = {}) {
    this.on = false;
    this.onProblem = onProblem || (() => {});
    this.onRoster = onRoster || (() => {});
    this.onSpeech = onSpeech || (() => {});
    this.people = [];      // latest roster
    this.since = 0;        // last speech item already handled
    this.taskSeq = 0;
    this._scoresAt = 0;
    this._timer = null;
  }

  async start({ title, showId, lang }) {
    this.on = true;
    const r = await post("/api/live/host", { reset: true, title, showId, lang: lang || "en-US" });
    this.taskSeq = r.taskSeq || 0;
    // Don't replay things said before the show started.
    const roster = await fetch("/api/live/roster").then((x) => x.json()).catch(() => ({}));
    this.since = roster.lastSpeech || 0;
    clearInterval(this._timer);
    this._timer = setInterval(() => this.poll(), 500);
    this.poll();
  }

  stop() {
    this.on = false;
    clearInterval(this._timer);
  }

  async poll() {
    if (!this.on) return;
    const r = await fetch(`/api/live/roster?since=${this.since}`).then((x) => x.json()).catch(() => null);
    if (!r) return;
    this.people = r.participants || [];
    for (const item of r.speech || []) {
      this.since = Math.max(this.since, item.id);
      if (item.problem) this.onProblem(item); else this.onSpeech(item);
    }
    this.onRoster(this.people, r);
  }

  /** People here right now. */
  get active() {
    return this.people.filter((p) => p.active);
  }

  // ---- what the stage is doing -------------------------------------------
  clip(clip, { loop = false, offset = 0 } = {}) {
    if (!this.on || !clip) return;
    const { file, title, line, caption, duration } = clip;
    post("/api/live/host", { clip: { file: file || "", title: title || "", line: line || "", caption: caption || "", duration: duration || 5, loop, offset } });
  }

  prompt(question, hint) {
    if (this.on) post("/api/live/host", { prompt: { question: question || "", hint: hint || "" } });
  }

  paused(p) {
    if (this.on) post("/api/live/host", { paused: Boolean(p) });
  }

  /** Tell everyone what to do now. Resolves with the task number their answers will carry. */
  async task(task) {
    if (!this.on) return 0;
    const r = await post("/api/live/host", { task });
    this.taskSeq = r.taskSeq || this.taskSeq;
    return this.taskSeq;
  }

  /** Live vote bars on participants' screens (at most once a second). */
  scores(list, force = false) {
    if (!this.on) return;
    const now = performance.now();
    if (!force && now - this._scoresAt < 1000) return;
    this._scoresAt = now;
    post("/api/live/scores", { scores: list });
  }

  kick(pid) {
    return post("/api/live/kick", { pid });
  }

  // ---- reading back ---------------------------------------------------------
  /** Move progress for the current task: { active, done, doing, persons: [{ id, name, done, doing, value, online }] } */
  moveStatus(seq) {
    const here = this.active.filter((p) => p.cam !== "watch-only");
    const persons = here.map((p) => {
      const m = p.move && p.move.taskSeq === seq ? p.move : null;
      return { id: `web-${p.pid}`, name: p.name, done: Boolean(m?.done), doing: Boolean(m?.doing), value: m?.value || 0, online: true };
    });
    return {
      active: persons.length,
      done: persons.filter((x) => x.done).length,
      doing: persons.filter((x) => x.doing && !x.done).length,
      persons,
    };
  }

  /** "Stand to choose" online: how many people are on each side of their own camera picture. */
  zoneCounts(seq, n) {
    const counts = Array(n).fill(0);
    for (const p of this.active) {
      const z = p.zone;
      if (z && z.taskSeq === seq && z.index >= 0 && z.index < n) counts[z.index]++;
    }
    return counts;
  }

  /** "Cheer loudest" online: the average loudness of everyone cheering now (0..1), or null. */
  cheerLevel(seq) {
    const levels = this.active.map((p) => (p.level && p.level.taskSeq === seq ? p.level.level : null)).filter((x) => x !== null);
    return levels.length ? levels.reduce((a, b) => a + b, 0) / levels.length : null;
  }
}
