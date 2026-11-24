// Show controller: walks through story.json node by node.
//
// Node types:
//   scene  - play a clip, then go to `next`
//   choice - ask a question; phones, voice and emojis pick a branch
//   action - wait until the camera sees an action (or time runs out)
//   open   - listen to a free answer; keywords or Claude pick a reaction clip.
//            With "capture", it also picks out the NAME the children shout and
//            remembers it, so any on-screen words can use it: "Meet {donkey name}!"
//   pause  - hold until the presenter presses Continue (or a set time passes)
//   end    - final clip
//
// Operator keys: 1-6 force an option, Enter = action done, Space = skip/timeout,
// P = pause/resume the whole show, C = continue from a Pause part,
// F = full screen, O = operator panel.
//
// Address: /play?show=<show id>[&from=<part id>]
//   show - which show to play (the audience home page links here)
//   from - start from a particular part (the editor's "Try from here" does this)
// Without show=, the show currently open in the editor is played.

import { Stage } from "./player.js";
import { Voice, matchKeywords } from "./voice.js";
import { PoseDetector, moveName, moveInfo } from "./pose.js";
import { audience, ChoiceRound, inputsFor } from "./engine.js";
import { clock } from "./clock.js";
import { Recorder } from "./recorder.js";
import { LiveHost } from "./live.js";

const $ = (sel) => document.querySelector(sel);

class Show {
  constructor() {
    this.story = null;
    this.stage = new Stage($("#stage"), {
      onProblem: (m) => this.log(`🎬 ${m}`),
      onSoundBlocked: () => { $("#hostSoundBtn").hidden = false; },
    });
    this.token = 0;          // bumps on restart so old runs stop
    this.override = null;    // operator shortcut handler for the current node
    this.onSpeech = null;    // current node's speech handler
    this.voice = null;
    this.pose = null;
    this.vars = {};          // names the children chose, e.g. { "donkey name": "Bobo" }. Memory only.
    this.logLines = [];
    // Online room: people watching and joining in on their own devices.
    this.live = new LiveHost({
      onRoster: (people) => this.renderOnline(people),
      onProblem: (item) => this.log(`🌐⚠ ${item.name}'s screen: ${item.text}`),
      onSpeech: (item) => {
        this.heard(`${item.name}: ${item.text}`, true);
        this.log(`🌐 ${item.name}: “${item.text}”`);
        if (this.onSpeech && !clock.paused) this.onSpeech(item.text, item.alts || [item.text]);
      },
    });
    this.consoleAt = 0;      // last time the operator console was heard from
  }

  // ---------------------------------------------------------------------
  // Names the children chose, and {tags} in on-screen words
  // ---------------------------------------------------------------------
  static tag(t) {
    return String(t || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  /** Replace {donkey name} with the remembered name (or the part's backup words). */
  fill(text) {
    if (!text) return text;
    return String(text).replace(/\{([^{}]+)\}/g, (m, t) => {
      const k = Show.tag(t);
      return this.vars[k] ?? this.fallbacks?.[k] ?? m;
    });
  }

  /** Play or loop a clip with {tags} filled in and its caption shown. */
  play(clip) {
    this.stage.setCaption(this.fill(clip?.caption));
    const filled = this.filledClip(clip);
    this.live.clip(filled ? { ...filled, caption: this.fill(clip?.caption) } : filled, { loop: false });
    return this.stage.play(filled);
  }

  loop(clip) {
    this.stage.setCaption(this.fill(clip?.caption));
    const filled = this.filledClip(clip);
    this.live.clip(filled ? { ...filled, caption: this.fill(clip?.caption) } : filled, { loop: true });
    return this.stage.loop(filled);
  }

  filledClip(clip) {
    return clip ? { ...clip, title: this.fill(clip.title), line: this.fill(clip.line) } : clip;
  }

  async loadStory() {
    if (!this.showId) {
      // No show chosen: play the one open in the editor, if any.
      const list = await (await fetch("/api/projects", { cache: "no-store" })).json().catch(() => ({}));
      this.showId = list.current || null;
      if (!this.showId) return null;
    }
    const res = await fetch(`/api/shows/${encodeURIComponent(this.showId)}/story.json`, { cache: "no-store" });
    if (!res.ok) return null;
    this.stage.setVideoBase(`/media/${encodeURIComponent(this.showId)}/`);
    return res.json();
  }

  /** Update everything that depends on the story (titles, moves, part list). */
  applyStory() {
    document.title = `${this.story.title} · KLSP`;
    $("#showTitle").textContent = this.story.title;
    $("#startTitle").textContent = this.story.title;
    this.customMoves = this.story.settings?.custom_actions || [];
    if (this.pose) this.pose.setCustomMoves(this.customMoves);
    if (!this.modeOverride) this.setAudienceMode(this.story.settings?.audience_mode || "single");
    this.pose?.setMaxPeople(this.story.settings?.max_people || 6);
    this.fallbacks = {};
    for (const n of Object.values(this.story.nodes)) {
      if (n.capture?.save_as) this.fallbacks[Show.tag(n.capture.save_as)] = n.capture.fallback || "";
    }
    const sel = $("#jumpSelect");
    sel.innerHTML = "";
    for (const [id, n] of Object.entries(this.story.nodes)) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = this.partTitle(n);
      sel.append(opt);
    }
  }

  partTitle(n) {
    if (!n) return "";
    const t = ["choice", "action", "open"].includes(n.type) ? n.question : n.type === "pause" ? n.message : n.clip?.title;
    return t || n.type;
  }

  async init() {
    this.showId = new URLSearchParams(location.search).get("show");
    this.story = await this.loadStory().catch(() => null);
    if (!this.story) {
      $("#startScreen").hidden = true;
      $("#noProject").hidden = false;
      return;
    }
    $("#editLink").href = `/edit/${encodeURIComponent(this.showId)}`;
    const from = new URLSearchParams(location.search).get("from");
    this.startFrom = from && this.story.nodes[from] ? from : null;
    if (this.startFrom) $("#startFromNote").textContent = `Preview: starting from “${this.partTitle(this.story.nodes[this.startFrom])}”`;

    const lang = this.story.settings?.speech_lang || "en-US";
    $("#langSelect").value = lang;
    this.voice = new Voice({
      lang,
      onInterim: (t) => this.heard(t, false),
      onFinal: (t, alts) => {
        if (clock.paused) return; // ignore talking during a pause
        this.heard(t, true);
        if (this.onSpeech) this.onSpeech(t, alts);
      },
      onStatus: (s) => this.chip("#micChip", s),
    });
    if (!this.voice.supported) {
      $("#useMic").checked = false;
      $("#useMic").disabled = true;
      $("#micNote").textContent = "Voice needs Chrome or Edge.";
    }
    this.recorder = new Recorder({ onLevel: (v) => $("#micLevel").style.setProperty("--level", String(v)) });
    this.pose = new PoseDetector($("#cam"), $("#poseCanvas"), {
      onStatus: (s) => {
        this.chip("#camChip", s);
        if ((s === "error" || s === "detail-failed") && this.pose?.info?.lastError) this.log(`Camera problem: ${this.pose.info.lastError}. Open 📷 Camera check for help.`);
      },
    });
    this.setAudienceMode(this.story.settings?.audience_mode || "single");
    this.applyStory();

    try {
      const info = await audience.info();
      this.applyJoinInfo(info);
      setInterval(() => audience.info().then((i) => this.applyJoinInfo(i)).catch(() => {}), 8000);
      this.log(`Phones can vote at ${info.vote_url}`);
      this.log(info.llm_enabled ? "Claude answer-matching is on." : "Claude answer-matching is off. Using keywords only.");
      this.whisper = info.whisper || {};
      const w = this.whisper;
      this.log(!w.enabled ? "Whisper is turned off in .env."
        : !w.installed ? "Whisper isn't installed. Run setup again to add it."
        : w.state === "failed" ? `Whisper couldn't load: ${w.error}`
        : `Whisper (${w.model}) is ${w.ready ? "ready" : "loading in the background"}.`);
      const canWhisper = w.enabled && w.installed && w.state !== "failed" && Recorder.supported();
      if (!this.voice.supported && canWhisper) {
        $("#useMic").checked = true;
        $("#useMic").disabled = false;
        $("#micNote").textContent = "Live listening needs Chrome or Edge, but names will still be understood with Whisper.";
      }
    } catch {
      this.log("Could not reach the server. Is app.py running?");
    }

    $("#onPublicBtn").addEventListener("click", async () => {
      await fetch("/api/tunnel/start", { method: "POST" });
      $("#onPublicBtn").textContent = "Starting the public link…";
      setTimeout(() => audience.info().then((i) => { this.joinKey = null; this.applyJoinInfo(i); }), 4000);
    });
    $("#onCopyBtn").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText($("#onLink").href); $("#onCopyBtn").textContent = "Copied ✓"; } catch { /* ignore */ }
      setTimeout(() => ($("#onCopyBtn").textContent = "Copy link"), 1500);
    });
    $("#editTopLink").href = `/edit/${encodeURIComponent(this.showId)}`;
    this.channel = new BroadcastChannel("klsp-show");
    this.channel.onmessage = (e) => this.onConsole(e.data || {});
    setInterval(() => this.sendConsoleState(), 300);
    setInterval(() => this.sendCamera(), 600);
    $("#consoleBtn").addEventListener("click", () =>
      window.open(`/operator?show=${encodeURIComponent(this.showId)}`, "klsp-operator", "width=1200,height=820"));
    $("#startBtn").addEventListener("click", () => this.start());
    $("#hostSoundBtn").addEventListener("click", () => { this.stage.unmute(); $("#hostSoundBtn").hidden = true; });
    // Before the show starts, show who's already waiting to watch online.
    const lobby = async () => {
      const r = await fetch("/api/live/roster").then((x) => x.json()).catch(() => null);
      const n = (r?.participants || []).filter((p) => p.active).length;
      $("#onlineWaiting").hidden = !n;
      $("#onlineWaiting").textContent = `🌐 ${n} ${n === 1 ? "person is" : "people are"} waiting to watch online. They'll see the show as soon as you start.`;
      if (n) $("#goOnline").checked = true;
    };
    lobby();
    this.lobbyTimer = setInterval(lobby, 2000);
    $("#restartBtn").addEventListener("click", () => this.pause("restart"));
    $("#endRestartBtn").addEventListener("click", () => this.restart("beginning"));
    $("#operatorBtn").addEventListener("click", () => this.toggleOperator());
    for (const b of ["#pauseBtn", "#fsPauseBtn"]) $(b).addEventListener("click", () => this.togglePause());
    for (const b of ["#restartTopBtn", "#fsRestartBtn"]) $(b).addEventListener("click", () => this.pause("restart"));
    for (const b of ["#fullscreenBtn", "#fsExitBtn"]) $(b).addEventListener("click", () => this.toggleFullscreen());
    $("#resumeBtn").addEventListener("click", () => this.requestResume());
    $("#restartPartBtn").addEventListener("click", () => this.restart("part"));
    $("#restartAllBtn").addEventListener("click", () => this.restart("beginning"));
    $("#jumpBtn").addEventListener("click", () => this.restart($("#jumpSelect").value));
    $("#nameUse").addEventListener("click", () => this.key("Enter"));
    $("#nameEdit").addEventListener("click", () => this.key("e"));
    $("#nameAgain").addEventListener("click", () => this.key("r"));
    $("#nameSkip").addEventListener("click", () => this.key("x"));
    $("#nameSave").addEventListener("click", () => this.saveNameToLibrary());
    document.addEventListener("fullscreenchange", () => this.syncFullscreen());
    document.addEventListener("mousemove", () => this.wakeControls());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && this.started && !clock.paused && $("#autoPause").checked && $("#endScreen").hidden) {
        this.pause();
        this.log("Paused automatically because the window was hidden");
      }
    });
    $("#continueBtn").addEventListener("click", () => this.key("c"));
    $("#skipBtn").addEventListener("click", () => this.key(" "));
    $("#langSelect").addEventListener("change", (e) => this.voice.setLang(e.target.value));
    document.addEventListener("keydown", (e) => {
      if (e.target.matches("input, select, textarea")) return;
      if (e.key === " ") e.preventDefault();
      this.key(e.key);
    });
  }

  async start() {
    $("#startScreen").hidden = true;
    this.started = true;
    this.vars = {};
    document.body.classList.toggle("no-cam", !$("#useCam").checked);
    // The show is always shared with anyone watching online (it costs nothing if
    // nobody is). The room opens BEFORE the first scene is sent, so it can't wipe it.
    clearInterval(this.lobbyTimer);
    if ($("#goOnline").checked) document.body.classList.add("online-on");
    await this.live.start({ title: this.story.title, showId: this.showId, lang: this.story.settings?.speech_lang || "en-US" });
    this.log("Online room is open: people can watch and join in with the link or QR code.");
    if ($("#useMic").checked) {
      this.voice.start();
      // The recorder powers the loudness meters, cheer voting and Whisper.
      this.recorder.init().then((ok) => { if (!ok) this.log("Couldn't open the microphone for meters and Whisper."); });
    } else this.chip("#micChip", "off");
    if ($("#useCam").checked) {
      // Load hand/face tracking now if any taught move needs it, so it's ready mid-show.
      this.pose.start().then(() => {
        const need = { hands: false, face: false };
        for (const n of Object.values(this.story.nodes)) {
          const m = n.type === "action" && this.customMoves.find((c) => c.id === n.action && c.type === "taught");
          if (m) { need.hands ||= Boolean(m.uses?.hands); need.face ||= Boolean(m.uses?.face); }
        }
        if (need.hands || need.face) this.pose.ensureDetail(need).then(() => this.log("Hand and face tracking ready"));
      });
    } else this.chip("#camChip", "off");
    this.run(this.startFrom || this.story.start);
  }

  /**
   * where: "beginning", "part" (restart the current part) or a part id.
   * Reloads the story first, so edits made in the editor are picked up.
   */
  async restart(where = "beginning") {
    const target = where === "part" ? this.currentId : where === "beginning" ? null : where;
    const fresh = await this.loadStory().catch(() => null);
    if (fresh) { this.story = fresh; this.applyStory(); }
    if (clock.paused) this.resumeNow(true);
    this.token++;
    this.stage.stopAll();
    this.onSpeech = null;
    this.hideZoneGuide();
    this.live.task({ type: "none" });
    $("#endScreen").hidden = true;
    audience.closeRound().catch(() => {});
    this.heard("", false);
    const id = target && this.story.nodes[target] ? target : this.story.start;
    if (id === this.story.start) this.vars = {}; // a fresh show forgets the names
    this.log(where === "part" ? `Restarted “${this.partTitle(this.story.nodes[id])}”`
      : id === this.story.start ? "Started again from the beginning"
      : `Jumped to “${this.partTitle(this.story.nodes[id])}”`);
    this.run(id);
  }

  // ---------------------------------------------------------------------
  // Story runner
  // ---------------------------------------------------------------------
  async run(nodeId) {
    const tok = ++this.token;
    let id = nodeId;
    while (id && tok === this.token) {
      await this.refreshStory(); // edits made in the editor apply from the next part
      if (tok !== this.token) return;
      const node = this.story.nodes[id];
      if (!node) {
        this.log(`Missing node "${id}" in story.json`);
        return;
      }
      this.currentId = id;
      if (node.type === "scene") this.live.task({ type: "none" });
      this.log(`▶ ${id} (${node.type})`);
      this.resetPanel();
      this.stage.setCaption("");
      this.preloadAfter(node);
      id = await this[`run_${node.type}`](node, id, tok);
    }
  }

  alive(tok) {
    return tok === this.token;
  }

  /** Reload the story if it was changed in the editor. The part playing now isn't interrupted. */
  async refreshStory() {
    if (!this.showId) return;
    const text = await fetch(`/api/shows/${encodeURIComponent(this.showId)}/story.json`, { cache: "no-store" })
      .then((r) => (r.ok ? r.text() : null)).catch(() => null);
    if (!text) return;
    if (this.storyText && text !== this.storyText) {
      try {
        this.story = JSON.parse(text);
        this.applyStory();
        this.log("✎ Story updated from the editor");
      } catch { return; }
    }
    this.storyText = text;
  }

  /**
   * Tell the stage which clip is most likely next, so it can load while this one plays.
   * For a question that's its waiting clip; for a scene it's whatever comes after it.
   */
  preloadAfter(node) {
    let clip = node.idle || null;
    if (!clip) {
      const nextId = node.next || node.success;
      const next = nextId && this.story.nodes[nextId];
      clip = next && (next.clip || next.prompt);
    }
    this.stage.preload(clip ? this.filledClip(clip) : null);
  }

  async run_scene(node, id, tok) {
    await this.play(node.clip);
    return this.alive(tok) ? node.next : null;
  }

  async run_end(node, id, tok) {
    this.live.task({ type: "end" });
    await this.play(node.clip);
    if (this.alive(tok)) $("#endScreen").hidden = false;
    return null;
  }

  async run_choice(node, id, tok) {
    const round = new ChoiceRound(node, this.story.settings?.weights);
    const inputs = round.inputs;
    const seconds = node.window_sec || this.story.settings?.default_window_sec || 15;
    // The camera may still be starting, so "stand to choose" is confirmed after the opening clip.
    let zoneOn = inputs.zone && ($("#useCam").checked || this.live.on);
    const hintNow = () => {
      const ways = [zoneOn && this.zoneHint(node.options), inputs.voice && "shout it out", inputs.poll && "vote on your phone", inputs.emoji && "send an emoji"].filter(Boolean);
      return ways.length ? ways.join(", or ").replace(/^./, (c) => c.toUpperCase()) : inputs.cheer ? "Get ready to cheer!" : "";
    };

    this.showQuestion(node.question, hintNow());
    this.renderOptions(node.options, round.scores());
    if (inputs.poll || inputs.emoji) {
      audience.openRound(id, this.fill(node.question), node.options.map(({ id, label, emoji }) => ({ id, label, emoji }))).catch(() => {});
    }

    await this.play(node.prompt);
    if (!this.alive(tok)) return null;
    this.loop(node.idle || node.prompt);

    if (zoneOn) {
      for (let i = 0; i < 25 && $("#useCam").checked && !this.pose.running && /loading|starting/.test(this.pose.info?.body || ""); i++) {
        await new Promise((r) => setTimeout(r, 200));
      }
      zoneOn = Boolean(this.pose.running) || this.live.on;
      if (!zoneOn) this.log("Stand to choose skipped: the camera isn't on.");
      this.showQuestion(node.question, hintNow());
    }
    // Everyone online gets the answer buttons, emojis and instructions.
    const voteSeq = await this.live.task({
      type: "vote", inputs: { ...inputs, zone: zoneOn },
      options: node.options.map(({ id, label, emoji }) => ({ id, label, emoji })),
    });
    const collecting = inputs.voice || inputs.poll || inputs.emoji || zoneOn;

    if (inputs.voice) {
      this.onSpeech = (text, alts) => {
        const hits = new Set(alts.flatMap((a) => matchKeywords(a, node.options)));
        if (hits.size) {
          round.addVoiceHits([...hits]);
          this.log(`Heard a vote for ${[...hits].join(", ")}`);
          this.renderOptions(node.options, round.scores());
        }
      };
    }

    let forced = null;
    const forceKeys = (k) => {
      const n = parseInt(k, 10);
      if (n >= 1 && n <= node.options.length) { forced = node.options[n - 1].id; return "forced"; }
      if (k === " ") return "timeout";
      return null;
    };
    // "Stand to choose": count the children in each part of the room. The last
    // few seconds count most, once everyone has had time to move.
    const zoneSamples = [];
    const sampleZones = () => {
      if (!zoneOn || clock.paused) return;
      const now = clock.now();
      const n = node.options.length;
      const local = this.pose.running ? this.pose.zoneCounts(n) : Array(n).fill(0);
      const online = this.live.on ? this.live.zoneCounts(voteSeq, n) : Array(n).fill(0);
      zoneSamples.push({ t: now, counts: local.map((c, i) => c + online[i]) });
      const recent = zoneSamples.filter((x) => now - x.t < 3000);
      node.options.forEach((o, i) => { round.zone[o.id] = recent.reduce((a, x) => a + x.counts[i], 0) / recent.length; });
    };
    if (zoneOn) this.showZoneGuide(node.options, round);
    if (collecting) {
      this.liveMeter("vote", { options: node.options, round, zones: zoneOn });
      await this.waitWindow(seconds, tok, {
        everyMs: 250,
        check: () => { sampleZones(); return null; },
        onTick: async () => {
          if ((this._tallyTick = (this._tallyTick || 0) + 1) % 3) return; // phones: every ~0.75 s
          if (inputs.poll || inputs.emoji) {
            try { round.setTally(await audience.tally()); } catch { /* server offline */ }
          }
          this.renderOptions(node.options, round.scores());
        },
        keys: forceKeys,
      });
    }
    this.onSpeech = null;
    audience.closeRound().catch(() => {});
    if (zoneOn) {
      this.hideZoneGuide();
      this.log(`Standing: ${node.options.map((o) => `${o.label} ${Math.round(round.zone[o.id] || 0)}`).join(", ")}`);
    }

    // "Cheer loudest": the room cheers for each option in turn; loudness decides.
    // Checked now, not earlier: the microphone may still have been starting up.
    const canCheer = this.recorder?.ready || this.live.active.length > 0;
    if (!forced && inputs.cheer && canCheer && this.alive(tok)) {
      for (const o of node.options) {
        this.liveMeter("cheer", { title: `Cheer for ${o.emoji ? o.emoji + " " : ""}${o.label}!` });
        this.showQuestion(node.question, `Cheer for ${o.label}!`);
        const cheerSeq = await this.live.task({ type: "cheer", option: { id: o.id, label: o.label, emoji: o.emoji } });
        const levels = [];
        const r = await this.waitWindow(node.cheer_sec || 3, tok, {
          everyMs: 50,
          check: () => {
            if (clock.paused) return null;
            // The room's microphone and everyone cheering at home, combined.
            const room = this.recorder?.ready ? this.recorder.level || 0 : null;
            const home = this.live.cheerLevel(cheerSeq);
            levels.push(room !== null && home !== null ? (room + home) / 2 : room ?? home ?? 0);
            this.cheerNow = levels[levels.length - 1];
            return null;
          },
          keys: forceKeys,
        });
        if (!this.alive(tok) || r === "forced") break;
        levels.sort((a, b) => b - a);
        const top = levels.slice(0, Math.max(1, Math.floor(levels.length * 0.3)));
        round.cheer[o.id] = top.reduce((a, b) => a + b, 0) / top.length; // loudest moments, not the average
        this.log(`Cheer for ${o.label}: ${Math.round(round.cheer[o.id] * 100)}`);
        this.renderOptions(node.options, round.scores());
      }
    } else if (inputs.cheer && !canCheer) {
      this.log("Cheer voting skipped: the microphone isn't on and nobody is online.");
    }
    this.cheerNow = null;
    this.live.task({ type: "none" });
    this.liveMeter(null);
    this.stage.stopLoop();
    if (!this.alive(tok)) return null;

    const pick = forced ? { id: forced, byDefault: false } : round.winner();
    this.log(forced ? `Operator chose ${forced}` : `Result: ${pick.id}${pick.byDefault ? " (no answers, default)" : ""}`);
    this.renderOptions(node.options, round.scores(), pick.id);

    if (pick.byDefault && node.timeout_clip) await this.play(node.timeout_clip);
    const opt = node.options.find((o) => o.id === pick.id);
    return this.alive(tok) ? opt.next : null;
  }

  async run_action(node, id, tok) {
    const action = node.action || "hands_up";
    const info = moveInfo(action, this.customMoves);
    const camOn = this.pose.running;
    const reps = node.reps || info.reps || 1;
    const auditorium = this.audienceMode === "auditorium";
    const times = info.kind === "count" && reps > 1 ? `, ${reps} times` : "";
    const who = auditorium
      ? ` (${Math.round((node.crowd_share ?? 0.5) * 100)}% of the children${(node.min_people ?? 1) > 1 ? `, at least ${node.min_people}` : ""})`
      : "";
    const goal = `${info.name}${times}${who}`;
    const hintFor = (on) => (on ? `Camera is watching for: ${goal}`
      : this.live.on ? `Everyone at home: ${info.name}${times}! Their own cameras check it.`
      : "Camera is off. Operator: press Enter when the children do it.");
    this.showQuestion(node.question, hintFor(camOn));
    this.showMeter(action, 0);

    await this.play(node.prompt);
    if (!this.alive(tok)) return null;
    this.loop(node.idle || node.prompt);

    this.pose.watch(action, {
      holdSec: node.hold_sec || 1,
      reps,
      strictness: node.strictness || "normal",
      crowdShare: node.crowd_share ?? 0.5,
      minPeople: node.min_people ?? 1,
    });
    // Everyone online checks the move with their own camera (or taps "I did it").
    const custom = this.customMoves.find((m) => m.id === action);
    const moveSeq = await this.live.task({
      type: "move", move: action, name: info.name, kind: info.kind, question: this.fill(node.question),
      def: custom || null, holdSec: node.hold_sec || 1, reps, strictness: node.strictness || "normal",
    });
    this.liveMeter("move", { name: info.name });
    const result = await this.waitWindow(node.timeout_sec || 20, tok, {
      everyMs: 50,
      check: () => {
        const local = this.pose.running ? this.pose.progress() : null;
        const online = this.live.on ? this.live.moveStatus(moveSeq) : { active: 0, done: 0, doing: 0, persons: [] };
        if (!local && !online.active) return null;
        if (local && $("#hint").textContent !== hintFor(true)) $("#hint").textContent = hintFor(true); // the camera finished starting
        let p;
        if (online.active) {
          // One group: children seen by the room's camera plus everyone online.
          const roomSeen = local ? (auditorium ? local.people || 0 : (local.people ? 1 : 0)) : 0;
          const roomDone = local ? (auditorium ? local.donePeople || 0 : (local.value >= 1 ? 1 : 0)) : 0;
          const total = roomSeen + online.active, done = roomDone + online.done;
          const need = Math.max(Math.min(node.min_people ?? 1, total), Math.ceil((node.crowd_share ?? 0.5) * total));
          const roomPersons = local ? (auditorium ? local.persons || [] : local.people ? [{ id: "room", done: local.value >= 1, doing: local.doingNow }] : []) : [];
          p = {
            value: Math.min(1, done / Math.max(1, need)), label: `${done} of ${total} doing it`,
            doingNow: Boolean(local?.doingNow) || online.doing > 0, persons: [...roomPersons, ...online.persons],
            people: total, donePeople: done,
          };
        } else {
          p = local;
        }
        this.lastMove = { name: info.name, ...p };
        this.showMeter(action, p.value, false, p.label);
        return p.value >= 1 ? "success" : null;
      },
      keys: (k) => (k === "Enter" ? "success" : k === " " ? "timeout" : null),
    });
    this.pose.unwatch();
    this.live.task({ type: "none" });
    this.liveMeter(null);
    this.lastMove = null;
    this.stage.stopLoop();
    if (!this.alive(tok)) return null;

    this.log(result === "success" ? `Move done: ${info.name}` : "Move timed out");
    this.showMeter(action, result === "success" ? 1 : 0, result === "success");
    return result === "success" ? node.success : node.timeout_next;
  }

  async run_open(node, id, tok) {
    const capture = node.capture?.save_as ? node.capture : null;
    this.showQuestion(node.question, capture ? "Shout out a name!" : "Say your answer out loud");
    await this.play(node.prompt);
    if (!this.alive(tok)) return null;
    this.loop(node.idle || node.prompt);

    let heard, forced, audio, name = null;
    while (true) {
      this.liveMeter("listen", { title: capture ? "Shout out a name!" : "Listening…" });
      this.live.task({ type: "say", question: this.fill(node.question), capture: Boolean(capture) });
      ({ heard, forced, audio } = await this.listenForAnswers(node, tok, capture ? (this.audienceMode === "auditorium" ? 3500 : 2500) : 0));
      this.liveMeter(null);
      if (!this.alive(tok)) return null;
      if (!capture) break;

      // Work out the name while the "listening" clip keeps playing.
      this.showQuestion(node.question, "Listening back…");
      const expected = capture.expected || [];
      let utterances = [...heard];
      if (audio) {
        const lang = this.story.settings?.speech_lang || "en-US";
        const tr = await audience.transcribe(audio, lang, expected, this.fill(node.question), capture.use_library !== false)
          .catch((e) => ({ ok: false, reason: e.name === "AbortError" ? "took too long" : "server unreachable" }));
        if (!this.alive(tok)) return null;
        if (tr.ok && tr.segments.length) {
          utterances = [...tr.segments.map((t) => [t]), ...heard]; // Whisper first: usually more accurate
          this.heard(tr.segments.join(" "), true);
          this.log(`Whisper heard “${tr.segments.join(" / ")}” in ${tr.seconds}s`);
        } else if (tr.ok) {
          this.log("Whisper heard no words");
        } else {
          this.log(`Whisper not used (${tr.reason}). Using Chrome's listening.`);
        }
      }
      if (!utterances.length) break;
      const res = await audience.extractName(this.fill(node.question), utterances, this.story.settings?.blocked_words || [], expected, capture.use_library !== false)
        .catch(() => ({}));
      if (!this.alive(tok)) return null;
      name = res.name || null;
      this.log(name ? `Heard the name “${name}” (${res.source === "llm" ? "Claude" : "rules"})` : "No usable name heard");
      const decision = await this.checkName(name, tok);
      if (!this.alive(tok)) return null;
      if (decision.again) { this.showQuestion(node.question, "Shout out a name!"); this.log("Listening again"); continue; }
      name = decision.name;
      break;
    }
    this.stage.stopLoop();
    this.resetNameCheck();

    if (capture) {
      const k = Show.tag(capture.save_as);
      if (name) { this.vars[k] = name; this.log(`Remembered {${capture.save_as}} = “${name}”`); }
      else delete this.vars[k];
    }

    // Choose the reaction. With a name, sort the name itself; otherwise the whole answer.
    const answer = name || (heard.length ? heard[0][0] : null);
    let catId = forced;
    let how = "operator";
    if (!catId && answer) {
      catId = matchKeywords(answer, node.categories)[0] || null;
      how = "keywords";
      if (!catId && node.categories.length) {
        const res = await audience.classify(this.fill(node.question), answer, node.categories.map(({ id, description }) => ({ id, description }))).catch(() => ({}));
        catId = res.category || null;
        how = res.source === "llm" ? "Claude" : "nothing matched";
      }
    }
    const cat = node.categories.find((c) => c.id === catId);
    if (forced) this.log(`Operator chose ${forced}`);
    else this.log(answer ? `Answer "${answer}" → ${cat ? cat.id : "generic"} (${how})` : "No answer heard → generic reaction");
    this.showQuestion(node.question, name ? `We picked: ${name}` : "");
    await this.play(cat ? cat.reaction : node.fallback_reaction);
    return this.alive(tok) ? node.next : null;
  }

  /**
   * Listen during the window. Returns every shout heard (each with the
   * recogniser's alternative guesses). After the first shout, keep listening
   * for `extraMs` more so a room of children can all be heard.
   */
  /** Use Whisper for this part? Only for name questions, when it's installed and chosen. */
  useWhisper(node) {
    const w = this.whisper || {};
    return Boolean(node.capture?.save_as && this.recorder?.ready && w.enabled && w.installed && w.state !== "failed"
      && (this.story.settings?.name_listening || "whisper") === "whisper");
  }

  async listenForAnswers(node, tok, extraMs) {
    const heard = [];
    let firstAt = null;
    let forced = null;
    const recording = this.useWhisper(node) && this.recorder.start();
    // If Chrome's live listening isn't running, notice shouts by loudness instead.
    const byLoudness = recording && !(this.voice.supported && this.voice.wanted);
    this.onSpeech = (text, alts) => {
      if (!text || !text.trim()) return;
      heard.push(alts && alts.length ? alts : [text]);
      firstAt ??= clock.now();
    };
    await this.waitWindow(node.listen_sec || 12, tok, {
      everyMs: 100,
      check: () => {
        const first = firstAt ?? (byLoudness ? this.recorder.shoutAt : null);
        return first !== null && clock.now() - first >= extraMs ? "answered" : null;
      },
      keys: (k) => {
        const n = parseInt(k, 10);
        if (n >= 1 && n <= node.categories.length) { forced = node.categories[n - 1].id; return "forced"; }
        return k === " " ? "timeout" : null;
      },
    });
    this.onSpeech = null;
    const audio = recording ? await this.recorder.stop() : null;
    return { heard, forced, audio };
  }

  /**
   * Show "I heard: Bobo" and let the operator check it, depending on the
   * show's setting: auto (no check), timed (use it after a few seconds unless
   * changed), or manual (wait for the operator).
   * Returns { name } or { again: true }.
   */
  async checkName(name, tok) {
    const mode = this.story.settings?.name_check || "timed";
    if (mode === "auto") return { name };
    const secs = this.story.settings?.name_check_sec || 5;
    $("#hint").textContent = "";
    this.live.task({ type: "namecheck", name: name || "" });
    $("#nameCheck").hidden = false;
    $("#heardNameLabel").textContent = name ? "I heard" : "I didn't catch a name";
    $("#heardName").textContent = name || "";
    $("#nameUse").hidden = !name;
    $("#nameSave").hidden = !name;
    $("#nameSave").disabled = false;
    $("#nameSave").textContent = "★ Save to name library";
    $("#nameHint").textContent = mode === "timed"
      ? (name ? `Using it in a moment. Operator: Enter to use now, E to change, R to listen again, X for no name.` : "Carrying on without a name. Operator: E to type one, R to listen again.")
      : "Operator: Enter to use it, E to change it, R to listen again, X for no name.";
    let consoleName = null;
    const result = await this.waitWindow(mode === "timed" ? secs : 0, tok, {
      keys: (k) => {
        if (k.startsWith("name:")) { consoleName = k.slice(5).trim().slice(0, 30); return "set"; }
        if (k === "Enter" || k === " ") return name ? "use" : "skip";
        if (k === "e" || k === "E") return "edit";
        if (k === "r" || k === "R") return "again";
        if (k === "x" || k === "X" || k === "Backspace") return "skip";
        return null;
      },
    });
    this.resetNameCheck();
    if (result === "again") return { again: true };
    if (result === "set") {
      if (consoleName) this.log(`Operator set the name to “${consoleName}”`);
      return { name: consoleName || null };
    }
    if (result === "skip") return { name: null };
    if (result === "edit") {
      const typed = (prompt("Type the name to use:", name || "") || "").trim().slice(0, 30);
      if (typed) this.log(`Operator changed the name to “${typed}”`);
      return { name: typed || null };
    }
    return { name }; // "use", or the timer ran out
  }

  resetNameCheck() {
    $("#nameCheck").hidden = true;
  }

  /** Operator: keep a good name the children came up with, so every show recognises it. */
  async saveNameToLibrary() {
    const name = $("#heardName").textContent.trim();
    if (!name) return;
    const res = await fetch("/api/library/add", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ names: [name] }),
    }).then((r) => r.json()).catch(() => ({}));
    $("#nameSave").textContent = res.ok ? "★ Saved" : "Couldn't save";
    $("#nameSave").disabled = true;
    this.log(res.ok ? `Saved “${name}” to the name library` : "Couldn't save to the name library (only works on the show laptop)");
  }

  async run_pause(node, id, tok) {
    const auto = node.auto_sec || 0;
    this.showQuestion(node.message || "Short break",
      auto ? `The show carries on by itself when the timer ends, or press Continue.` : "Press Continue when everyone is ready.");
    $("#continueBtn").hidden = false;
    this.loop(node.clip || { title: node.message || "Short break", line: "", duration: 5 });
    this.live.task({ type: "break", message: node.message || "Short break" });
    const result = await this.waitWindow(auto, tok, {
      keys: (k) => (["c", "C", "Enter", " "].includes(k) ? "continue" : null),
    });
    this.stage.stopLoop();
    if (!this.alive(tok)) return null;
    this.log(result === "continue" ? "Continued by presenter" : "Break ended by timer");
    return node.next;
  }

  /**
   * Wait up to `seconds`, showing a countdown. 0 seconds means wait forever. Resolves with:
   *   "timeout" | whatever `check()` or `keys()` returns first.
   */
  waitWindow(seconds, tok, { everyMs = 250, onTick, check, keys } = {}) {
    return new Promise((resolve) => {
      const start = clock.now();
      const total = seconds > 0 ? seconds * 1000 : Infinity;
      let finished = false;
      const finish = (why) => {
        if (finished) return;
        finished = true;
        clearInterval(timer);
        this.override = null;
        this.setCountdown(null);
        resolve(why);
      };
      this.override = (k) => {
        const r = keys && keys(k);
        if (r) finish(r);
      };
      const timer = setInterval(async () => {
        if (!this.alive(tok)) return finish("cancelled");
        if (clock.paused) return; // everything waits while the show is paused
        const elapsed = clock.now() - start;
        if (total !== Infinity) this.setCountdown(1 - elapsed / total, Math.ceil((total - elapsed) / 1000));
        if (onTick) await onTick();
        const r = check && check();
        if (r) return finish(r);
        if (elapsed >= total) finish("timeout");
      }, everyMs);
    });
  }

  key(k) {
    if (k === "o" || k === "O") return this.toggleOperator();
    if (k === "p" || k === "P") return this.togglePause();
    if (k === "f" || k === "F") return this.toggleFullscreen();
    if (clock.paused) return; // other keys do nothing while paused
    if (this.override) return this.override(k);
    if (k === " ") this.stage.skip();
  }

  // ---------------------------------------------------------------------
  // Pause, resume and full screen
  // ---------------------------------------------------------------------
  togglePause() {
    if (!this.started) return;
    if (clock.paused) this.requestResume();
    else this.pause();
  }

  /** mode "pause" shows the pause menu; "restart" shows the same menu, headed for restarting. */
  pause(mode = "pause") {
    if (!this.started) return;
    if (!clock.paused) {
      clock.pause();
      this.stage.pause();
      this.live.paused(true);
      this.recorder?.pause();
      audience.setPaused(true).catch(() => {});
      this.pausedAt = Date.now();
      clearInterval(this.pausedTimer);
      this.pausedTimer = setInterval(() => this.updatePausedFor(), 1000);
      this.log("Paused");
    }
    this.cancelCountdown();
    $("#pauseHeading").textContent = mode === "restart" ? "Restart the show?" : "Paused";
    $("#pauseWhere").textContent = this.currentId ? `Now at: ${this.partTitle(this.story.nodes[this.currentId])}` : "";
    if (this.currentId) $("#jumpSelect").value = this.currentId;
    this.updatePausedFor();
    $("#pauseScreen").hidden = false;
    $("#pauseScreen").classList.toggle("is-restart", mode === "restart");
    for (const b of ["#pauseBtn", "#fsPauseBtn"]) $(b).textContent = "▶ Resume";
    (mode === "restart" ? $("#restartAllBtn") : $("#resumeBtn")).focus();
  }

  updatePausedFor() {
    const secs = Math.floor((Date.now() - (this.pausedAt || Date.now())) / 1000);
    $("#pausedFor").textContent = `Paused for ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  }

  /** Resume after a 3-2-1 countdown so the presenter and children are ready. Pressing again skips it. */
  requestResume() {
    if (!clock.paused) return;
    if (this.countdownTimer) return this.resumeNow();
    let n = 3;
    const show = () => {
      $("#pauseHeading").textContent = `Resuming in ${n}…`;
      $("#resumeBtn").textContent = "Resume right now";
    };
    show();
    this.countdownTimer = setInterval(() => {
      n -= 1;
      if (n <= 0) this.resumeNow();
      else show();
    }, 1000);
  }

  cancelCountdown() {
    clearInterval(this.countdownTimer);
    this.countdownTimer = null;
    $("#resumeBtn").textContent = "▶ Resume";
  }

  resumeNow(quiet = false) {
    this.cancelCountdown();
    clearInterval(this.pausedTimer);
    if (!clock.paused) return;
    clock.resume();
    this.stage.resume();
    this.live.paused(false);
    this.recorder?.resume();
    audience.setPaused(false).catch(() => {});
    $("#pauseScreen").hidden = true;
    for (const b of ["#pauseBtn", "#fsPauseBtn"]) $(b).textContent = "⏸ Pause";
    if (!quiet) this.log("Resumed");
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => this.log("Full screen isn't allowed in this browser."));
  }

  syncFullscreen() {
    const fs = Boolean(document.fullscreenElement);
    document.body.classList.toggle("is-fs", fs);
    $("#fullscreenBtn").textContent = fs ? "Exit full screen" : "⛶ Full screen";
    this.wakeControls();
  }

  /** In full screen, show the floating controls when the mouse moves, then hide them. */
  wakeControls() {
    if (!document.body.classList.contains("is-fs")) return;
    const bar = $("#fsBar");
    bar.classList.add("is-awake");
    document.body.classList.remove("hide-cursor");
    clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(() => {
      if (bar.matches(":hover") || bar.contains(document.activeElement)) return this.wakeControls();
      bar.classList.remove("is-awake");
      document.body.classList.add("hide-cursor");
    }, 2500);
  }

  // ---------------------------------------------------------------------
  // Phones: room code and join address (switches to the public link when on)
  // ---------------------------------------------------------------------
  /** The host dashboard's online room panel: link, QR, who's here and how they're doing. */
  renderOnline(people) {
    const here = people.filter((p) => p.active);
    if (here.length) document.body.classList.add("online-on"); // someone joined: show the panel
    $("#onCount").textContent = String(here.length);
    const move = this.lastMove && this.live.on ? this.live.moveStatus(this.live.taskSeq) : null;
    const grid = $("#onGrid");
    const icon = (p) => {
      const m = move?.persons.find((x) => x.id === `web-${p.pid}`);
      if (m?.done) return "✓";
      if (m?.doing) return "…";
      return p.cam === "on" ? "📷" : p.cam === "button" ? "✋" : "";
    };
    const key = here.map((p) => `${p.pid}${p.name}${icon(p)}`).join("|");
    if (key === grid.dataset.key) return;
    grid.dataset.key = key;
    grid.innerHTML = "";
    for (const p of here) {
      const li = document.createElement("li");
      const m = move?.persons.find((x) => x.id === `web-${p.pid}`);
      li.className = `on-chip${m?.done ? " is-done" : m?.doing ? " is-doing" : ""}`;
      li.title = `${p.name}: camera ${p.cam}${p.fps ? `, ${p.fps} fps` : ""}. Click to remove.`;
      li.innerHTML = `<span class="on-icon"></span><span class="on-name"></span>`;
      li.querySelector(".on-icon").textContent = icon(p);
      li.querySelector(".on-name").textContent = p.name;
      li.addEventListener("click", async () => {
        if (!confirm(`Remove ${p.name} from the online room?`)) return;
        await this.live.kick(p.pid);
        this.log(`Removed ${p.name} from the online room`);
      });
      grid.append(li);
    }
    if (!here.length) grid.innerHTML = '<li class="on-empty">Nobody yet. Share the link or QR code.</li>';
  }

  applyJoinInfo(info) {
    this.joinInfo = info;
    if (info.watch_url) {
      $("#onLink").textContent = info.watch_url.replace(/^https?:\/\//, "");
      $("#onLink").href = info.watch_url;
      const k = info.watch_url;
      if (k !== this.watchKey) { this.watchKey = k; $("#onQr").src = `/api/qr?watch=1&t=${Date.now()}`; }
      $("#onRoom").textContent = info.room;
      const pub = info.public || {};
      $("#onPublicBtn").textContent = pub.state === "on" ? "🔒 Secure link is on ✓" : pub.state === "starting" || pub.state === "downloading" ? "Starting the secure link…" : "🔒 Make a secure public link";
      $("#onPublicBtn").classList.toggle("is-needed", pub.state !== "on");
      $("#onPublicBtn").disabled = pub.state === "on" || pub.state === "starting" || pub.state === "downloading";
      $("#onPublicNote").textContent = pub.state === "failed" ? `Couldn't make a public link: ${pub.error}`
        : pub.state === "on" ? "Anyone with the link can join from anywhere, with their camera and microphone."
        : "⚠ The link above only works on this Wi-Fi, and browsers block participants' cameras and microphones on it. Make a secure public link (needs internet).";
    }
    const key = `${info.room}|${info.public?.url || ""}`;
    if (key === this.joinKey) return;
    this.joinKey = key;
    $("#voteUrl").textContent = info.join_url.replace(/^https?:\/\//, "");
    $("#roomCode").textContent = info.room;
    $("#qrImg").src = "/api/qr?t=" + Date.now();
  }

  // ---------------------------------------------------------------------
  // Operator console (a second window on the laptop, like presenter view)
  // ---------------------------------------------------------------------
  get consoleConnected() {
    return Date.now() - this.consoleAt < 3000;
  }

  onConsole(msg) {
    if (msg.type === "hello") { this.consoleAt = Date.now(); return; }
    if (msg.type !== "cmd") return;
    this.consoleAt = Date.now();
    switch (msg.cmd) {
      case "key": this.key(msg.key); break;
      case "pause": if (!clock.paused) this.pause(); break;
      case "resume": if (clock.paused) this.requestResume(); break;
      case "restart": this.restart(msg.where || "beginning"); break;
      case "name-set": this.key(`name:${msg.name || ""}`); break;
      case "name-save": this.saveNameToLibrary(); break;
      case "mode":
        this.modeOverride = true;
        this.setAudienceMode(msg.mode);
        this.log(`Audience mode: ${this.audienceMode === "auditorium" ? "Auditorium" : "Single child"}`);
        break;
    }
  }

  sendConsoleState() {
    document.body.classList.toggle("has-console", this.consoleConnected);
    if (!this.channel || !this.story) return;
    const node = this.currentId ? this.story.nodes[this.currentId] : null;
    this.channel.postMessage({
      type: "state",
      started: Boolean(this.started),
      title: this.story.title,
      showId: this.showId,
      paused: clock.paused,
      ended: !$("#endScreen").hidden,
      part: node ? { id: this.currentId, type: node.type, title: this.fill(this.partTitle(node)) } : null,
      countdown: $("#countdown").hidden ? null : $("#countdownNum").textContent,
      options: node?.type === "choice"
        ? node.options.map((o, i) => {
          const sc = this.lastScores?.find((x) => x.id === o.id) || {};
          return { n: i + 1, id: o.id, label: o.label, emoji: o.emoji, score: sc.score, votes: sc.votes, voice: sc.voice, emojis: sc.emoji, cheer: sc.cheer, zone: sc.zone };
        })
        : null,
      categories: node?.type === "open" ? node.categories.map((c, i) => ({ n: i + 1, id: c.id, name: c.name || c.id })) : null,
      move: node?.type === "action" ? (this.lastMove || { name: moveName(node.action, this.customMoves), value: 0 }) : null,
      nameCheck: $("#nameCheck").hidden ? null : { name: $("#heardName").textContent },
      heard: $("#heard").textContent,
      level: this.recorder?.level || 0,
      motion: this.pose?.motion || 0,
      people: this.pose?.state?.people || 0,
      mode: this.audienceMode,
      mic: $("#micChip").dataset.status,
      cam: $("#camChip").dataset.status,
      vars: this.vars,
      parts: Object.entries(this.story.nodes).map(([id, n]) => ({ id, title: this.fill(this.partTitle(n)) })),
      log: this.logLines.slice(0, 14),
    });
  }

  /** A small camera picture (with skeletons) for the console, twice a second. */
  sendCamera() {
    if (!this.consoleConnected || !this.pose?.running) return;
    const v = $("#cam"), c = $("#poseCanvas");
    if (!v.videoWidth) return;
    this.snap ??= document.createElement("canvas");
    this.snap.width = 320;
    this.snap.height = 240;
    const x = this.snap.getContext("2d");
    x.save();
    x.scale(-1, 1); // mirror, as on stage
    x.drawImage(v, -320, 0, 320, 240);
    x.drawImage(c, -320, 0, 320, 240);
    x.restore();
    this.channel.postMessage({ type: "cam", img: this.snap.toDataURL("image/jpeg", 0.6) });
  }

  // ---------------------------------------------------------------------
  // On-stage live meters: keep children engaged while answers come in
  // ---------------------------------------------------------------------
  /** mode: "vote" | "cheer" | "move" | "listen" | null (hide). */
  liveMeter(mode, data = {}) {
    const el = $("#liveMeter");
    this.meterMode = mode;
    this.meterData = data;
    el.hidden = !mode;
    el.dataset.mode = mode || "";
    if (!mode) return;
    $("#lmTitle").textContent = data.title
      || (mode === "vote" ? "Who's winning?" : mode === "move" ? data.name : mode === "listen" ? "Listening…" : "");
    const opts = $("#lmOptions");
    opts.innerHTML = "";
    if (mode === "vote") {
      for (const o of data.options) {
        const d = document.createElement("div");
        d.className = "lm-opt";
        d.dataset.id = o.id;
        d.innerHTML = `<span class="lm-emoji"></span><span class="lm-bar"><span></span></span>${data.zones ? '<span class="lm-count"></span>' : ""}`;
        d.querySelector(".lm-emoji").textContent = o.emoji || o.label.slice(0, 1);
        opts.append(d);
      }
    }
    if (!this.meterLoop) {
      const tick = () => {
        this.meterLoop = requestAnimationFrame(tick);
        this.updateLiveMeter();
      };
      tick();
    }
  }

  updateLiveMeter() {
    if (!this.meterMode) return;
    const level = this.recorder?.level || 0;
    // Sound bars: bounce with the room's loudness (with a little life of their own).
    document.querySelectorAll("#lmWave span").forEach((b, i) => {
      const wobble = 0.35 + 0.65 * Math.abs(Math.sin(performance.now() / 180 + i * 1.7));
      b.style.transform = `scaleY(${Math.max(0.08, Math.min(1, level * 1.6 * wobble + 0.06))})`;
    });
    if (this.meterMode === "vote" && this.meterData.round) {
      const scores = this.meterData.round.scores();
      for (const sc of scores) {
        const d = document.querySelector(`#lmOptions [data-id="${CSS.escape(sc.id)}"]`);
        if (d) {
          d.querySelector(".lm-bar span").style.width = `${Math.round(sc.score * 100)}%`;
          d.querySelector(".lm-emoji").style.transform = `scale(${1 + sc.score * 0.5})`;
          const cnt = d.querySelector(".lm-count");
          if (cnt) cnt.textContent = `${Math.round(sc.zone || 0)} standing`;
        }
      }
    }
    if (this.meterMode === "move") {
      const p = this.lastMove || { value: 0 };
      // One little figure per child in view, lighting up as each one does the move.
      const row = $("#lmPeople");
      const online = (p.persons || []).some((x) => x.online);
      const persons = this.audienceMode === "auditorium" || online ? (p.persons || []).slice(0, 30) : [];
      const key = persons.map((x) => `${x.id}${x.done ? "d" : x.doing ? "g" : ""}`).join(",");
      if (key !== row.dataset.key) {
        row.dataset.key = key;
        row.innerHTML = persons.map((x) => `<span class="lm-kid${x.done ? " is-done" : x.doing ? " is-doing" : ""}${x.online ? " is-online" : ""}"></span>`).join("");
      }
      $("#lmRing").style.setProperty("--progress", String(p.value || 0));
      $("#lmRingLabel").textContent = p.label || (p.doingNow ? "Yes!" : "");
      $("#liveMeter").classList.toggle("is-doing", Boolean(p.doingNow));
    }
    if (this.meterMode === "cheer" && this.cheerNow != null && !this.recorder?.ready) {
      $("#lmRing").style.setProperty("--progress", String(Math.min(1, this.cheerNow * 1.4)));
    } else if (this.meterMode === "cheer") {
      $("#lmRing").style.setProperty("--progress", String(Math.min(1, level * 1.4)));
      $("#lmRingLabel").textContent = "";
    }
  }

  /** "Stand on the left for 🌲 The forest, or on the right for 🏰 The castle" */
  zoneHint(options) {
    const name = (o) => `${o.emoji ? o.emoji + " " : ""}${o.label}`;
    if (options.length === 2) return `stand on the left for ${name(options[0])}, or on the right for ${name(options[1])}`;
    if (options.length === 3) return `stand on the left for ${name(options[0])}, in the middle for ${name(options[1])}, or on the right for ${name(options[2])}`;
    return "stand under your choice";
  }

  /** Shows the zones over the camera preview, with a live count in each. */
  showZoneGuide(options, round) {
    const g = $("#zoneGuide");
    g.innerHTML = "";
    for (const o of options) {
      const col = document.createElement("div");
      col.className = "zg-col";
      col.dataset.id = o.id;
      col.innerHTML = `<span class="zg-emoji"></span><span class="zg-count">0</span>`;
      col.querySelector(".zg-emoji").textContent = o.emoji || o.label.slice(0, 2);
      g.append(col);
    }
    g.hidden = false;
    clearInterval(this.zoneTimer);
    this.zoneTimer = setInterval(() => {
      for (const o of options) {
        const c = g.querySelector(`[data-id="${CSS.escape(o.id)}"] .zg-count`);
        if (c) c.textContent = String(Math.round(round.zone[o.id] || 0));
      }
    }, 250);
  }

  hideZoneGuide() {
    clearInterval(this.zoneTimer);
    $("#zoneGuide").hidden = true;
  }

  /** "single" (one child, precise tracking) or "auditorium" (a room of children). */
  setAudienceMode(mode) {
    this.audienceMode = mode === "auditorium" ? "auditorium" : "single";
    this.pose?.setMode(this.audienceMode);
    document.body.dataset.audience = this.audienceMode;
  }

  // ---------------------------------------------------------------------
  // UI helpers
  // ---------------------------------------------------------------------
  resetPanel() {
    $("#prompt").hidden = true;
    $("#options").innerHTML = "";
    $("#meter").hidden = true;
    $("#continueBtn").hidden = true;
    this.resetNameCheck();
    this.setCountdown(null);
  }

  showQuestion(q, hint) {
    $("#prompt").hidden = false;
    $("#question").textContent = this.fill(q) || "";
    $("#hint").textContent = hint || "";
    this.live.prompt(this.fill(q) || "", hint || "");
  }

  renderOptions(options, scores, winnerId = null) {
    this.lastScores = scores;
    this.live.scores(scores.map(({ id, score, votes }) => ({ id, score, votes, winner: id === winnerId })), Boolean(winnerId));
    const el = $("#options");
    if (!el.children.length) {
      el.innerHTML = options.map((o, i) => `
        <li class="option" data-id="${o.id}">
          <button type="button" class="option-btn" data-idx="${i + 1}" aria-label="Choose ${o.label}">
            <span class="option-emoji" aria-hidden="true">${o.emoji || ""}</span>
            <span class="option-label">${o.label}</span>
            <span class="option-key" aria-hidden="true">${i + 1}</span>
          </button>
          <div class="option-bar"><span></span></div>
          <p class="option-meta"></p>
        </li>`).join("");
      el.querySelectorAll(".option-btn").forEach((b) =>
        b.addEventListener("click", () => this.key(b.dataset.idx)));
    }
    for (const s of scores) {
      const li = el.querySelector(`[data-id="${s.id}"]`);
      if (!li) continue;
      li.querySelector(".option-bar span").style.width = `${Math.round(s.score * 100)}%`;
      li.querySelector(".option-meta").textContent =
        `${s.votes} ${s.votes === 1 ? "vote" : "votes"}, ${s.voice} heard, ${s.emoji} ${s.emoji === 1 ? "emoji" : "emojis"}`;
      li.classList.toggle("is-winner", s.id === winnerId);
    }
  }

  showMeter(action, progress, done = false, detail = "") {
    const m = $("#meter");
    m.hidden = false;
    $("#meterLabel").textContent = done ? "Well done!" : detail ? `${moveName(action, this.customMoves)}: ${detail}` : moveName(action, this.customMoves);
    m.style.setProperty("--progress", String(progress));
    m.classList.toggle("is-done", done || progress >= 1);
  }

  setCountdown(fraction, secondsLeft) {
    const c = $("#countdown");
    if (fraction === null) { c.hidden = true; return; }
    c.hidden = false;
    c.style.setProperty("--progress", String(Math.max(0, Math.min(1, fraction))));
    $("#countdownNum").textContent = String(Math.max(0, secondsLeft));
  }

  heard(text, final) {
    const el = $("#heard");
    el.textContent = text || "…";
    el.classList.toggle("is-final", final);
  }

  chip(sel, status) {
    const labels = {
      listening: "Listening", watching: "Watching", loading: "Starting…",
      off: "Off", blocked: "Blocked", error: "Error", unsupported: "Not supported",
      "detail-failed": "Hands/face failed",
    };
    const el = $(sel);
    el.dataset.status = status;
    el.querySelector(".chip-state").textContent = labels[status] || status;
  }

  toggleOperator() {
    const panel = $("#operator");
    panel.hidden = !panel.hidden;
    $("#operatorBtn").setAttribute("aria-expanded", String(!panel.hidden));
  }

  log(msg) {
    const li = document.createElement("li");
    const t = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    li.textContent = `${t}  ${msg}`;
    $("#log").prepend(li);
    this.logLines.unshift(`${t}  ${msg}`);
    this.logLines.length = Math.min(this.logLines.length, 60);
    console.log("[show]", msg);
  }
}

const show = new Show();
show.init();
window.show = show; // handy for debugging in the browser console
