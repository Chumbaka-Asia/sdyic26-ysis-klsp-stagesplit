// Voice: continuous speech-to-text with the browser's built-in Web Speech API.
// Works in Chrome and Edge. Note for the pitch: Chrome sends audio to Google's
// servers to transcribe it. A production version should use on-device
// recognition (e.g. Whisper) to protect children's privacy.

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export class Voice {
  constructor({ lang = "en-US", onInterim, onFinal, onStatus } = {}) {
    this.supported = Boolean(Recognition);
    this.lang = lang;
    this.onInterim = onInterim || (() => {});
    this.onFinal = onFinal || (() => {});
    this.onStatus = onStatus || (() => {});
    this.wanted = false;
    this.rec = null;
  }

  start() {
    if (!this.supported) {
      this.onStatus("unsupported");
      return;
    }
    this.wanted = true;
    this._spawn();
  }

  stop() {
    this.wanted = false;
    if (this.rec) this.rec.abort();
    this.onStatus("off");
  }

  setLang(lang) {
    this.lang = lang;
    if (this.rec) this.rec.abort(); // onend restarts it with the new language
  }

  _spawn() {
    const rec = new Recognition();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 3;

    rec.onstart = () => this.onStatus("listening");
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const alts = Array.from(r).map((a) => a.transcript.trim());
        if (r.isFinal) this.onFinal(alts[0], alts);
        else this.onInterim(alts[0]);
      }
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        this.wanted = false;
        this.onStatus("blocked");
      }
    };
    // Chrome stops listening after silence; restart automatically.
    rec.onend = () => {
      if (this.wanted) setTimeout(() => this._spawn(), 250);
    };
    this.rec = rec;
    try { rec.start(); } catch { /* already started */ }
  }
}

/** Lowercase, strip punctuation. Keeps Chinese characters intact. */
export function normalise(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[.,!?;:"'()\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Which items' keywords appear in the text?
 * items: [{ id, keywords: [...] }]  ->  returns array of matching ids.
 * English/Malay keywords match whole words; Chinese keywords match anywhere.
 */
export function matchKeywords(text, items) {
  const t = ` ${normalise(text)} `;
  const hits = [];
  for (const item of items) {
    const found = (item.keywords || []).some((kw) => {
      const k = normalise(kw);
      if (!k) return false;
      if (/[\u4e00-\u9fff]/.test(k)) return t.includes(k);
      return t.includes(` ${k} `);
    });
    if (found) hits.push(item.id);
  }
  return hits;
}
