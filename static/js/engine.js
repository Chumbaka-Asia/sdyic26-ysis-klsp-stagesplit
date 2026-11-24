// Decision engine: turns everything the audience does into one choice.
//
// For a choice point, each option gets a score:
//   score = w_poll  * (share of phone votes)
//         + w_voice * (share of spoken keyword matches)
//         + w_emoji * (share of that option's emoji taps)
// Weights come from story.json -> settings.weights, so KLSP can tune them
// without touching code. If nobody responds at all, the default option wins.

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

export const audience = {
  info: () => api("/api/info"),
  openRound: (node_id, question, options) =>
    api("/api/round", { node_id, question, options, open: true }),
  closeRound: () => api("/api/round/close", {}),
  tally: () => api("/api/tally"),
  setPaused: (paused) => api("/api/pause", { paused }),
  extractName: (question, utterances, blocked, expected, useLibrary = true) =>
    api("/api/extract-name", { question, utterances, blocked, expected, use_library: useLibrary }),
  /** Send one recording to Whisper on this laptop. Gives up after 25 s. */
  transcribe: async (blob, lang, hints, question, useLibrary = true) => {
    const fd = new FormData();
    fd.append("audio", blob, "shout.webm");
    fd.append("lang", lang || "en-US");
    fd.append("hints", JSON.stringify(hints || []));
    fd.append("question", question || "");
    fd.append("use_library", useLibrary ? "1" : "0");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25000);
    try {
      const res = await fetch("/api/transcribe", { method: "POST", body: fd, signal: ctl.signal });
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  },
  classify: (question, answer, categories) =>
    api("/api/classify", { question, answer, categories }),
};

/** Which kinds of answer a Question accepts. Older stories accept voice, phones and emojis. */
export function inputsFor(node) {
  return { voice: true, poll: true, emoji: true, cheer: false, zone: false, ...(node.inputs || {}) };
}

export const DEFAULT_WEIGHTS = { poll: 0.5, voice: 0.4, emoji: 0.1, cheer: 0.6, zone: 0.7 };

export class ChoiceRound {
  /**
   * node: the Question part. showWeights: the show-wide weights (Settings tab).
   * A Question can use its own weights (node.weights) and switch kinds of
   * answer off entirely (node.inputs).
   */
  constructor(node, showWeights) {
    this.node = node;
    this.inputs = inputsFor(node);
    this.weights = { ...DEFAULT_WEIGHTS, ...(showWeights || {}), ...(node.weights || {}) };
    for (const k of Object.keys(DEFAULT_WEIGHTS)) if (!this.inputs[k]) this.weights[k] = 0;
    this.voiceHits = Object.fromEntries(node.options.map((o) => [o.id, 0]));
    this.cheer = {};   // option id -> loudness when the room cheered for it
    this.zone = {};    // option id -> how many children are standing in its part of the room
    this.tally = { votes: {}, emojis: {}, voters: 0 };
  }

  addVoiceHits(ids) {
    for (const id of ids) if (id in this.voiceHits) this.voiceHits[id] += 1;
  }

  setTally(t) {
    this.tally = t;
  }

  /** Returns [{ id, score, votes, voice, emoji, cheer, zone }] in option order. */
  scores() {
    const opts = this.node.options;
    const votes = opts.map((o) => (this.inputs.poll ? this.tally.votes?.[o.id] || 0 : 0));
    const voice = opts.map((o) => (this.inputs.voice ? this.voiceHits[o.id] || 0 : 0));
    const emoji = opts.map((o) => (this.inputs.emoji ? this.tally.emojis?.[o.emoji] || 0 : 0));
    const cheer = opts.map((o) => (this.inputs.cheer ? this.cheer[o.id] || 0 : 0));
    const zone = opts.map((o) => (this.inputs.zone ? this.zone[o.id] || 0 : 0));
    const share = (arr, i) => {
      const total = arr.reduce((a, b) => a + b, 0);
      return total ? arr[i] / total : 0;
    };
    // Only weight the kinds of answer that were actually used, so e.g. a room
    // with no phones is decided fully by the others.
    const used = {
      poll: votes.some(Boolean) ? this.weights.poll : 0,
      voice: voice.some(Boolean) ? this.weights.voice : 0,
      emoji: emoji.some(Boolean) ? this.weights.emoji : 0,
      cheer: cheer.some(Boolean) ? this.weights.cheer : 0,
      zone: zone.some(Boolean) ? this.weights.zone : 0,
    };
    const wTotal = used.poll + used.voice + used.emoji + used.cheer + used.zone || 1;
    return opts.map((o, i) => ({
      id: o.id,
      votes: votes[i],
      voice: voice[i],
      emoji: emoji[i],
      cheer: cheer[i],
      zone: zone[i],
      score: (used.poll * share(votes, i) + used.voice * share(voice, i) + used.emoji * share(emoji, i)
        + used.cheer * share(cheer, i) + used.zone * share(zone, i)) / wTotal,
    }));
  }

  get anyInput() {
    return this.scores().some((s) => s.votes || s.voice || s.emoji || s.cheer || s.zone);
  }

  /** The winning option id, or the default when nobody responded. Ties go to the default. */
  winner() {
    const s = this.scores();
    if (!this.anyInput) return { id: this.node.default, byDefault: true };
    const best = Math.max(...s.map((x) => x.score));
    const top = s.filter((x) => Math.abs(x.score - best) < 1e-9).map((x) => x.id);
    const id = top.includes(this.node.default) ? this.node.default : top[0];
    return { id, byDefault: false };
  }
}
