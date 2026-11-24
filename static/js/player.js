// Stage: plays clips on two stacked <video> elements so the next clip can be
// loaded while the current one plays (no black gap between clips).
//
// Until KLSP records the real videos, any clip whose file is missing is shown
// as a placeholder card: scene title + the line the actor will say + a timer.
// Drop a real file into the project's videos folder with the same name and it plays instead.
//
// Rules that keep the right video on screen:
//  * Only ONE clip is ever "current". Starting a new clip (or restarting the
//    show) cancels the old one, even if it was still loading, so a slow clip
//    can never pop up late on top of a newer one.
//  * Preloading only ever uses the hidden element, and never the element a
//    clip is about to play in.
//  * A clip that fails once is NOT written off for the rest of the show.

import { clock } from "./clock.js";

const DEFAULT_VIDEO_DIR = "/media/";
const SLOW_MS = 1500;      // show "Loading video…" after this long
const GIVE_UP_MS = 15000;  // then fall back to the placeholder card for this play

export class Stage {
  constructor(root, { onProblem = null, onSoundBlocked = null } = {}) {
    this.root = root;
    this.videos = [root.querySelector("#videoA"), root.querySelector("#videoB")];
    this.front = 0;
    this.card = root.querySelector("#placeholder");
    this.cardTitle = root.querySelector("#phTitle");
    this.cardLine = root.querySelector("#phLine");
    this.cardTimer = root.querySelector("#phTimer");
    this.cardFile = root.querySelector("#phFile");
    this.onProblem = onProblem;          // (message) => void, e.g. write to the log
    this.onSoundBlocked = onSoundBlocked; // () => void, when the browser forced mute
    this._availability = new Map(); // file -> Promise<boolean> (does it exist on the server?)
    this._broken = new Set();       // files the browser can't decode (wrong format)
    this._videoActive = false;      // is a real video (not a card) on screen?
    this._current = null;           // { gen, looping, cancel() }
    this._gen = 0;
    this._wanted = null;            // clip to warm up once the current one is showing
    this.base = DEFAULT_VIDEO_DIR;  // where this show's videos live, e.g. /media/<show id>/
    this.videos.forEach((v) => { v.dataset.file = ""; });
    this._makeOverlays();
  }

  _makeOverlays() {
    const screen = this.videos[0].parentElement;
    this.loadingEl = document.createElement("div");
    this.loadingEl.className = "stage-loading";
    this.loadingEl.textContent = "Loading video…";
    this.loadingEl.hidden = true;
    screen.append(this.loadingEl);
  }

  setVideoBase(base) {
    if (base === this.base) return;
    this.base = base;
    this._availability.clear();
    this._broken.clear();
  }

  /** Words shown over the video, like a subtitle ("Meet Bobo the donkey!"). */
  setCaption(text) {
    const el = this.root.querySelector("#caption");
    if (!el) return;
    const t = (text || "").trim();
    el.hidden = !t;
    if (t && el.textContent !== t) {
      el.textContent = t;
      el.classList.remove("pop");
      void el.offsetWidth;
      el.classList.add("pop");
    }
  }

  /** Freeze whatever is on stage. Placeholder cards freeze via the shared clock. */
  pause() {
    if (this._videoActive) this.videos[this.front].pause();
  }

  resume() {
    if (this._videoActive) this.videos[this.front].play().catch(() => {});
  }

  /** True while a video is waiting for a tap before it can play. */
  get needsTap() {
    return Boolean(this._blockedRetry);
  }

  /** Let sound play again after the browser forced the videos to be muted. */
  unmute() {
    this.videos.forEach((v) => { v.muted = false; });
    const retry = this._blockedRetry;
    this._blockedRetry = null;
    if (retry) retry();
    else if (this._videoActive && !clock.paused) this.videos[this.front].play().catch(() => {});
  }

  _url(file) {
    return this.base + encodeURIComponent(file).replace(/%2F/g, "/");
  }

  /** Check whether a video file exists on the server (remembered per file). */
  _exists(file) {
    if (!file || this._broken.has(file)) return Promise.resolve(false);
    if (!this._availability.has(file)) {
      const p = fetch(this._url(file), { method: "HEAD", cache: "no-store" })
        .then((r) => r.ok)
        .catch(() => { this._availability.delete(file); return false; }); // network blip: ask again next time
      this._availability.set(file, p);
    }
    return this._availability.get(file);
  }

  _setSrc(el, file) {
    if (el.dataset.file === file) return false;
    el.dataset.file = file;
    el.src = this._url(file);
    el.load();
    return true;
  }

  /**
   * Hint: this clip is probably coming up next. It's loaded into the hidden
   * element once the current clip is on screen, never while one is starting.
   */
  preload(clip) {
    this._wanted = clip && clip.file ? clip : null;
    if (!this._current || this._current.shown) this._warm();
  }

  async _warm() {
    const clip = this._wanted;
    if (!clip) return;
    if (!(await this._exists(clip.file))) return;
    if (clip !== this._wanted) return;                 // a newer hint arrived
    if (this.videos.some((v) => v.dataset.file === clip.file)) return; // already loaded
    if (this._current && !this._current.shown) return; // a clip is starting: hands off
    const back = this.videos[1 - this.front];
    this._setSrc(back, clip.file);
  }

  /** End whatever is playing or loading now. */
  _cancelCurrent() {
    const c = this._current;
    this._current = null;
    this._gen++;
    this._blockedRetry = null;
    if (c) c.cancel();
  }

  /** Play a clip once. Resolves when it ends (or when skip() is called). */
  async play(clip, startAt = 0) {
    return this._start(clip, false, startAt);
  }

  /**
   * Loop a clip (idle "waiting" clips) until stopLoop() is called.
   * Returns straight away.
   */
  loop(clip, startAt = 0) {
    this._start(clip, true, startAt);
  }

  async _start(clip, looping, startAt) {
    this._cancelCurrent();
    const gen = this._gen;
    if (!clip) return;
    // Hold a place straight away so a stopLoop()/skip() that arrives while we
    // check the file still cancels this clip.
    let release;
    const cancelled = new Promise((r) => { release = r; });
    this._current = { gen, looping, shown: false, cancel: () => release() };
    const exists = await Promise.race([this._exists(clip.file), cancelled.then(() => null)]);
    if (gen !== this._gen || exists === null) return;
    return exists ? this._playVideo(clip, looping, startAt, gen) : this._playCard(clip, looping, startAt, gen);
  }

  /** The video element on screen now (null for a placeholder card). Used to stay in sync. */
  currentVideo() {
    return this._videoActive ? this.videos[this.front] : null;
  }

  stopLoop() {
    if (this._current?.looping) this._cancelCurrent();
  }

  /** Operator shortcut / restart: end the current clip immediately. */
  skip() {
    if (this._current && !this._current.looping) this._cancelCurrent();
  }

  /** Stop everything (used when restarting or jumping). */
  stopAll() {
    this._cancelCurrent();
  }

  _playVideo(clip, looping, startAt, gen) {
    return new Promise((resolve) => {
      // If the hidden element already holds this clip (preloaded), use it.
      const el = this.videos[1 - this.front];
      const old = this.videos[this.front];
      this._setSrc(el, clip.file);
      el.loop = looping;
      let finished = false;
      let slowTimer, giveUpTimer;

      const cleanup = () => {
        el.removeEventListener("ended", onEnded);
        el.removeEventListener("error", onError);
        el.removeEventListener("loadedmetadata", seek);
        clearTimeout(slowTimer);
        clearTimeout(giveUpTimer);
        this.loadingEl.hidden = true;
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        cleanup();
        if (this._current === cur) this._current = null;
        resolve();
      };
      const cur = { gen, looping, shown: false, cancel: () => { el.loop = false; el.pause(); finish(); } };
      this._current = cur;

      // Start partway through (someone joining mid-scene); loops wrap round.
      function seek() {
        const d = el.duration;
        let t = startAt || 0;
        if (looping && Number.isFinite(d) && d > 0) t %= d;
        else if (Number.isFinite(d) && t >= d) t = Math.max(0, d - 0.05);
        try { el.currentTime = t; } catch { /* not ready yet */ }
      }
      if (el.readyState >= 1) seek(); else el.addEventListener("loadedmetadata", seek, { once: true });

      const show = () => {
        if (gen !== this._gen || finished) return;
        clearTimeout(slowTimer);
        clearTimeout(giveUpTimer);
        this.loadingEl.hidden = true;
        el.classList.add("is-front");
        old.classList.remove("is-front");
        old.pause();
        this.card.hidden = true;
        this.front = this.videos.indexOf(el);
        this._videoActive = true;
        cur.shown = true;
        if (clock.paused) el.pause(); // paused while the clip was loading
        this._warm();                 // now it's safe to load the next one
      };
      const fallBack = (why) => {
        if (gen !== this._gen || finished) return;
        cleanup();
        el.pause();
        if (why) this.onProblem?.(why);
        finished = true; // this attempt is over; the card takes over the same slot
        this._playCard(clip, looping, startAt, gen).then(resolve);
      };
      function onEnded() { if (!looping) finish(); }
      const onError = () => {
        const code = el.error?.code;
        if (code === 3 || code === 4) {
          // 3 = can't decode, 4 = format not supported: this file won't work in this browser.
          this._broken.add(clip.file);
          fallBack(`“${clip.file}” can't play in this browser (unsupported format). Save it as MP4 (H.264 + AAC).`);
        } else {
          fallBack(`“${clip.file}” couldn't load. Showing its card instead.`);
        }
      };
      el.addEventListener("ended", onEnded);
      el.addEventListener("error", onError);
      slowTimer = setTimeout(() => { if (!cur.shown) this.loadingEl.hidden = false; }, SLOW_MS);
      giveUpTimer = setTimeout(() => { if (!cur.shown) fallBack(`“${clip.file}” took too long to load. Showing its card instead.`); }, GIVE_UP_MS);

      const tryPlay = (retried) => {
        if (gen !== this._gen || finished) return;
        el.play().then(show).catch((err) => {
          if (gen !== this._gen || finished) return;
          if (err?.name === "NotAllowedError" && !el.muted) {
            // The browser wants a click before sound: play muted and offer a sound button.
            this.videos.forEach((v) => { v.muted = true; });
            this.onSoundBlocked?.();
            return tryPlay(retried);
          }
          if (err?.name === "NotAllowedError") {
            // Even muted play is blocked (e.g. phone battery saver): wait for a tap.
            clearTimeout(slowTimer);
            clearTimeout(giveUpTimer);
            this.loadingEl.hidden = true;
            this._blockedRetry = () => tryPlay(retried);
            this.onProblem?.("The browser blocked the video until the screen is tapped.");
            this.onSoundBlocked?.(true);
            return;
          }
          if (err?.name === "AbortError" && !retried) return setTimeout(() => tryPlay(true), 150);
          if (el.error) return; // the error handler deals with it
          fallBack(`“${clip.file}” couldn't start (${err?.name || "error"}). Showing its card instead.`);
        });
      };
      tryPlay(false);
    });
  }

  _playCard(clip, looping, startAt, gen) {
    return new Promise((resolve) => {
      if (gen !== this._gen) return resolve();
      this.videos.forEach((v) => { v.pause(); v.classList.remove("is-front"); });
      this._videoActive = false;
      this.loadingEl.hidden = true;
      this.card.hidden = false;
      this.card.classList.toggle("is-loop", looping);
      this.cardTitle.textContent = clip.title || "";
      this.cardLine.textContent = clip.line || "";
      this.cardFile.textContent = clip.file ? `Placeholder for ${clip.file}` : "";
      // Restart the entrance animation for each new card.
      this.card.classList.remove("enter");
      void this.card.offsetWidth;
      this.card.classList.add("enter");

      const duration = Math.max(1, clip.duration || 5);
      const start = clock.now() - (startAt || 0) * 1000;
      let raf;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        cancelAnimationFrame(raf);
        if (this._current === cur) this._current = null;
        resolve();
      };
      const cur = { gen, looping, shown: true, cancel: finish };
      this._current = cur;
      const tick = () => {
        if (finished) return;
        const elapsed = (clock.now() - start) / 1000;
        const left = looping ? duration - (elapsed % duration) : duration - elapsed;
        this.cardTimer.style.setProperty("--progress", String(1 - left / duration));
        if (!looping && left <= 0) return finish();
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      this._warm();
    });
  }
}
