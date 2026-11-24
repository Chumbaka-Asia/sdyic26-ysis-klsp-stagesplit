// Watch the show on your own device, in sync with the host, and join in.
//
//   * The host's show sends what's playing; this page plays the same clip
//     from the same moment, and stays lined up (pauses too).
//   * Actions are checked by THIS device's camera. Only "done / not done"
//     goes back to the host; no video ever leaves the device.
//   * Votes, emojis, spoken or typed answers, cheering and standing to
//     choose all go back to the host's show.

import { Stage } from "./player.js";
import { clock } from "./clock.js";
import { PoseDetector, moveInfo } from "./pose.js";
import { Voice } from "./voice.js";
import { Recorder } from "./recorder.js";

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
let me = null;                // { room, pid, token, name }
let offset = 0;               // server clock minus this device's clock (ms)
let state = null;
let clipKey = null;
let taskSeq = -1;
let stage = null, pose = null, voice = null, recorder = null;
let camState = "button";      // "on" (camera checks moves) or "button" (tap "I did it")
let events = null, errors = 0;
let lastSseAt = 0;            // last time anything arrived on the live stream
let sseWorked = false;        // has the live stream ever delivered anything?
let version = -1;             // newest state seen (from the stream or from polling)
let polling = false;
let taskTimers = [];
let round = null;
const serverNow = () => Date.now() + offset;

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------
const saved = JSON.parse(sessionStorage.getItem("klsp-watch") || "null");
$("#room").value = params.get("room") || saved?.room || "";
$("#name").value = params.get("name") || saved?.name || "";

// Browsers only allow the camera and microphone on secure (https) links, or on
// the computer itself. On the plain Wi-Fi link, explain, switch them off, and
// offer the host's secure public link if there is one.
const SECURE = window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia);
if (!SECURE) {
  $("#secureWarn").hidden = false;
  for (const id of ["useCam", "useMic"]) { $(`#${id}`).checked = false; $(`#${id}`).disabled = true; }
  const findSecure = async () => {
    const info = await fetch("/api/info", { cache: "no-store" }).then((r) => r.json()).catch(() => null);
    const url = info?.public?.state === "on" ? info.public.url : null;
    $("#secureBar").hidden = !url; // stays at the top, even once the show is running
    for (const id of ["secureBtn", "secureBtn2"]) {
      const a = $(`#${id}`);
      if (id === "secureBtn") a.hidden = !url;
      if (url) {
        const room = $("#room").value.trim() || me?.room || "";
        const name = $("#name").value.trim() || me?.name || "";
        a.href = `${url}/watch?room=${encodeURIComponent(room)}&name=${encodeURIComponent(name)}`;
      }
    }
    $("#secureHow").textContent = url
      ? "The host has made a secure link. Switch to it to use your camera and microphone."
      : "Ask the host to press “Make a secure public link”, or for the link that starts with https://.";
  };
  findSecure();
  setInterval(findSecure, 5000); // the host may make one later
}
if (!$("#room").value) $("#room").focus(); else $("#name").focus();

async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  if (!res) return { ok: false, reason: "Can't reach the show. Check the internet connection." };
  return res.json().catch(() => ({ ok: false }));
}
const report = (kind, extra = {}) => me && post("/api/live/report", { room: me.room, pid: me.pid, token: me.token, kind, ...extra });

async function join() {
  const room = $("#room").value.trim(), name = $("#name").value.trim();
  if (!/^\d{4}$/.test(room)) { $("#joinErr").textContent = "Type the 4-digit room code from the host."; return; }
  if (!name) { $("#joinErr").textContent = "Type your name, or a nickname."; return; }
  $("#joinBtn").disabled = true;
  $("#joinErr").textContent = "Joining…";
  const res = await post("/api/live/join", { room, name, pid: saved?.room === room ? saved.pid : undefined, token: saved?.room === room ? saved.token : undefined });
  $("#joinBtn").disabled = false;
  if (!res.ok) { $("#joinErr").textContent = res.reason || "Couldn't join."; return; }
  me = { room, pid: res.pid, token: res.token, name: res.name };
  sessionStorage.setItem("klsp-watch", JSON.stringify(me));
  $("#joinScreen").hidden = true;
  $("#app").hidden = false;
  $("#me").textContent = `You: ${me.name} · Room ${room}`;
  $("#lobbyHi").textContent = `You're in, ${me.name}!`;
  showLobbyChecks();
  stage = new Stage($("#stage"), {
    onSoundBlocked: (needTap) => {
      $("#soundBtn").textContent = needTap ? "▶ Tap to start the video" : "🔊 Tap for sound";
      $("#soundBtn").hidden = false;
    },
    onProblem: (msg) => {
      report("problem", { text: msg });
      const n = $("#videoNote");
      if (n) { n.textContent = "⚠ " + msg; n.hidden = false; clearTimeout(n._t); n._t = setTimeout(() => (n.hidden = true), 8000); }
    },
  });
  await syncClock();
  connect();
  setInterval(() => report("heartbeat", { cam: camState, fps: pose?.info?.fps || 0 }), 4000);
  setInterval(keepInSync, 2000);
  report("heartbeat", { cam: camState });
  // Camera and microphone (asked for now, while the person has just tapped Join).
  if ($("#useCam").checked && navigator.mediaDevices?.getUserMedia) startCamera();
  if ($("#useMic").checked && SECURE) startMic();
}
$("#joinBtn").addEventListener("click", join);
$("#name").addEventListener("keydown", (e) => { if (e.key === "Enter") join(); });

/** Work out the difference between this device's clock and the server's. */
async function syncClock() {
  let best = null;
  for (let i = 0; i < 4; i++) {
    const t0 = Date.now();
    const r = await fetch("/api/live/time", { cache: "no-store" }).then((x) => x.json()).catch(() => null);
    const t1 = Date.now();
    if (!r) continue;
    const rtt = t1 - t0;
    if (!best || rtt < best.rtt) best = { rtt, offset: r.t + rtt / 2 - t1 };
  }
  if (best) offset = best.offset;
}

async function startCamera() {
  pose = new PoseDetector($("#cam"), $("#poseCanvas"), { onStatus: (st) => {
    if (st === "blocked" || st === "error") { camState = "button"; report("heartbeat", { cam: camState }); }
  } });
  await pose.setMode("single");
  await pose.start();
  camState = pose.running ? "on" : "button";
  // A very slow phone can't track reliably: fall back to the "I did it" button.
  setTimeout(() => { if (pose.running && (pose.info.fps || 0) < 5) { camState = "button"; } }, 6000);
  report("heartbeat", { cam: camState, fps: pose.info?.fps || 0 });
}

async function startMic() {
  recorder = new Recorder({ onLevel: (v) => { const bar = $("#cheerLevel"); if (bar && !$("#cheerBox").hidden) bar.style.width = `${Math.round(v * 100)}%`; } });
  recorder.init();
  voice = new Voice({
    lang: state?.lang || "en-US",
    onFinal: (text, alts) => {
      if (!text.trim()) return;
      report("speech", { text, alts });
      const el = $("#sayBox").hidden ? $("#voteStatus") : $("#sayStatus");
      el.textContent = `Heard you: “${text}”`;
    },
    onStatus: () => {},
  });
}

// ---------------------------------------------------------------------------
// Lobby: quick checks while waiting for the host
// ---------------------------------------------------------------------------
function showLobbyChecks() {
  $("#checks").append($("#selfView")); // the camera preview sits beside the checks while waiting
  $("#selfView").hidden = !$("#useCam").checked;
  const tick = () => {
    if ($("#checks").hidden) return;
    // Camera
    const camOn = pose?.running;
    const seen = camOn && pose.state?.people > 0;
    $("#camTitle").classList.toggle("is-ok", Boolean(seen));
    $("#camMsg").textContent = !SECURE ? "Not available on this link (camera and microphone need a secure https link). For actions, you'll tap “✋ I did it!”."
      : !$("#useCam").checked ? "Off. For actions, you'll tap “✋ I did it!” instead."
      : !pose ? "Starting…"
      : !camOn ? (/blocked/.test(pose.info?.body || "") ? "Blocked. Allow the camera in your browser's address bar (the camera icon), then reload the page."
        : /couldn/.test(pose.info?.body || "") ? `Couldn't start (${pose.info.body.replace(/^couldn't start: /, "")}). Is another app, like Zoom, using the camera? You can tap “✋ I did it!” instead.`
        : "Starting… (the first time takes a few seconds)")
      : seen ? "Ready: the lines on your picture show it can see you."
      : "On, but it can't see you yet. Step back so your head, shoulders and hands are in view.";
    $("#selfView").hidden = !camOn;
    // Microphone
    const micOn = recorder?.ready;
    $("#micMeter").hidden = !micOn;
    const heard = micOn && (recorder.level || 0) > 0.15;
    if (heard) $("#micTitle").classList.add("is-ok");
    $("#micMsg").textContent = !SECURE ? "Not available on this link. You can still tap and type your answers."
      : !$("#useMic").checked ? "Off. You can still tap and type your answers."
      : !micOn ? (recorder && recorder.failed ? "Blocked or unavailable. Allow the microphone in your browser's address bar, then reload." : "Starting… Allow the microphone if your browser asks.")
      : $("#micTitle").classList.contains("is-ok") ? "Working." : "Say hello to check it.";
    if (micOn) $("#micLevel").style.width = `${Math.round(Math.min(1, recorder.level || 0) * 100)}%`;
    requestAnimationFrame(tick);
  };
  tick();
}

$("#testSoundBtn").addEventListener("click", () => {
  // A short chime. Tapping also lets the browser play the show's sound later.
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [523, 659, 784].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.15);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + i * 0.15 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.15 + 0.3);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.15);
      o.stop(ctx.currentTime + i * 0.15 + 0.32);
    });
  } catch { /* no audio */ }
  document.querySelectorAll("#stage video").forEach((v) => { v.muted = false; });
  $("#soundMsg").textContent = "Did you hear a chime? If not, check your volume and that the device isn't on silent.";
});

// ---------------------------------------------------------------------------
// Live connection to the show
// ---------------------------------------------------------------------------
function showPeople(n) {
  n = n || 1;
  $("#lobbyCount").textContent = n === 1 ? "You're the first one here." : `${n} people are here.`;
}

function connect() {
  events?.close();
  events = new EventSource(`/api/live/events?room=${me.room}&pid=${me.pid}&token=${me.token}`);
  const alive = () => { lastSseAt = Date.now(); sseWorked = true; errors = 0; };
  events.addEventListener("state", (e) => { alive(); applyState(JSON.parse(e.data)); });
  events.addEventListener("scores", (e) => { alive(); showScores(JSON.parse(e.data)); });
  events.addEventListener("people", (e) => { alive(); showPeople(JSON.parse(e.data).count); });
  events.addEventListener("ping", alive);
  events.addEventListener("kicked", () => gone("You've been removed", "The host removed you from this show."));
  events.onerror = async () => {
    errors++;
    if (errors === 3) {
      // Maybe the show restarted with a new room code, or we need to rejoin.
      const res = await post("/api/live/join", { room: me.room, name: me.name, pid: me.pid, token: me.token });
      if (!res.ok) { events.close(); gone("The show has ended", "The room code isn't running any more. Ask the host for the new code."); return; }
      Object.assign(me, { pid: res.pid, token: res.token });
      sessionStorage.setItem("klsp-watch", JSON.stringify(me));
      connect();
    }
  };
}

/**
 * Backup: if the live stream goes quiet (some internet proxies hold it back),
 * check in with the server every second instead. Works through anything.
 */
async function poll() {
  if (!me || polling) return;
  polling = true;
  try {
    const res = await fetch(`/api/live/poll?room=${me.room}&pid=${me.pid}&token=${me.token}&since=${version}`, { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (data.kicked) return gone("You've been removed", "The host removed you from this show.");
    if (res.status === 403) { errors = 3; events?.onerror?.(); return; }
    if (data.state) applyState(data.state);
    if (data.people) showPeople(data.people);
    if (data.scores) showScores(data.scores);
  } catch { /* offline for a moment: try again next time */ } finally {
    polling = false;
  }
}
setInterval(() => {
  if (!me || $("#app").hidden) return;
  // Stream quiet for 3 s before it ever worked, or 12 s after: poll instead.
  if (Date.now() - lastSseAt > (sseWorked ? 12000 : 3000)) poll();
}, 1000);

function gone(title, msg) {
  events?.close();
  voice?.stop();
  pose?.stop();
  $("#app").hidden = true;
  $("#goneScreen").hidden = false;
  $("#goneTitle").textContent = title;
  $("#goneMsg").textContent = msg;
  sessionStorage.removeItem("klsp-watch");
}

function applyState(st) {
  // The stream and polling can both deliver the same update; only newer ones count.
  if (st.version !== undefined && st.version !== null) {
    if (st.version <= version && state) return;
    version = st.version;
  }
  state = st;
  $("#showTitle").textContent = st.title || "The show";
  $("#lobbyTitle").textContent = st.title || "The show";
  if (voice && st.lang && voice.lang !== st.lang) voice.setLang(st.lang);

  // Pause and resume with the host.
  if (st.paused && !clock.paused) { clock.pause(); stage.pause(); }
  if (!st.paused && clock.paused) { clock.resume(); stage.resume(); }
  $("#pausedCover").hidden = !st.paused;

  // A new clip: play it from where the host is now.
  const clip = st.clip;
  if (clip && clip.key !== clipKey) {
    clipKey = clip.key;
    $("#waitCover").hidden = true;
    $("#checks").hidden = true;          // the show has started: the checks make way
    $(".w-task").append($("#selfView"));
    stage.setVideoBase(`/media/${encodeURIComponent(st.showId || "")}/`);
    const at = Math.max(0, ((st.paused ? st.pausedAt : serverNow()) - clip.startedAt) / 1000);
    stage.setCaption(clip.caption || "");
    if (clip.loop) stage.loop(clip, at); else stage.play(clip, at);
    setTimeout(checkSound, 800);
  }
  $("#question").textContent = st.prompt?.question || "";
  if ((st.task?.seq ?? -1) !== taskSeq) startTask(st.task || { type: "none" });
}

/** Every couple of seconds, nudge the video back in line with the host if it has drifted. */
function keepInSync() {
  const v = stage?.currentVideo();
  const clip = state?.clip;
  if (!v || !clip || state.paused || v.paused) return;
  let expected = (serverNow() - clip.startedAt) / 1000;
  if (clip.loop && v.duration) expected %= v.duration;
  if (v.duration && expected > v.duration) return;
  if (Math.abs(v.currentTime - expected) > 0.6) v.currentTime = expected;
}

/** Browsers may block sound until the page is tapped; offer a button if so. */
function checkSound() {
  const v = stage?.currentVideo();
  $("#soundBtn").hidden = !(stage?.needsTap || (v && v.muted));
}
$("#soundBtn").addEventListener("click", () => {
  stage.unmute();
  $("#videoNote").hidden = true;
  $("#soundBtn").hidden = true;
});

// ---------------------------------------------------------------------------
// What to do now
// ---------------------------------------------------------------------------
function clearTask() {
  taskTimers.forEach(clearInterval);
  taskTimers = [];
  for (const id of ["voteBox", "moveBox", "sayBox", "cheerBox", "nameBox", "breakBox", "endBox", "selfView"]) $(`#${id}`).hidden = true;
  $("#zoneGuide").hidden = true;
  $("#hint").textContent = "";
  voice?.stop();
  pose?.unwatch();
}

function startTask(task) {
  taskSeq = task.seq ?? 0;
  clearTask();
  ({ vote: taskVote, move: taskMove, say: taskSay, cheer: taskCheer, namecheck: taskName, break: taskBreak, end: taskEnd }[task.type] || (() => {}))(task);
}

const label = (o) => `${o.emoji ? o.emoji + " " : ""}${o.label}`;

async function taskVote(task) {
  const inputs = task.inputs || {};
  const opts = task.options || [];
  const ways = [];
  $("#voteBox").hidden = false;
  $("#voteStatus").textContent = "";
  const box = $("#voteOptions");
  box.innerHTML = "";
  if (inputs.poll) {
    ways.push("tap your answer");
    round = await fetch(`/api/round?room=${me.room}`).then((r) => r.json()).catch(() => null);
    for (const o of opts) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "w-opt";
      b.dataset.id = o.id;
      b.setAttribute("aria-pressed", "false");
      b.innerHTML = `<span class="bar"></span><span class="e"></span><span class="l"></span>`;
      b.querySelector(".e").textContent = o.emoji || "";
      b.querySelector(".l").textContent = o.label;
      b.addEventListener("click", async () => {
        const res = await post("/api/vote", { round_id: round?.round_id, option_id: o.id, voter_id: `web-${me.pid}`, room: me.room });
        if (res.ok) {
          box.querySelectorAll(".w-opt").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
          $("#voteStatus").textContent = `You voted for ${o.label}.`;
        } else $("#voteStatus").textContent = res.reason || "Your vote didn't go through.";
      });
      box.append(b);
    }
  }
  const emo = $("#emojiRow");
  emo.innerHTML = "";
  if (inputs.emoji) {
    ways.push("send an emoji");
    const set = [...new Set([...opts.map((o) => o.emoji).filter(Boolean), "😂", "😱", "👏", "❤️"])];
    for (const e of set) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "w-emo";
      b.textContent = e;
      b.setAttribute("aria-label", `Send ${e}`);
      b.addEventListener("click", () => post("/api/emoji", { round_id: round?.round_id, emoji: e, room: me.room }));
      emo.append(b);
    }
  }
  if (inputs.voice && voice?.supported) { ways.unshift("shout it out"); voice.start(); }
  if (inputs.zone && camState === "on") {
    // Stand to choose, at home: move to the left or right of your own camera picture.
    const n = opts.length;
    ways.unshift(n === 2 ? `move to the left of your camera for ${label(opts[0])}, or the right for ${label(opts[1])}` : "move under your choice in your camera picture");
    $("#selfView").hidden = false;
    const g = $("#zoneGuide");
    g.innerHTML = opts.map((o) => `<div class="zg-col"><span class="zg-emoji">${o.emoji || ""}</span></div>`).join("");
    g.hidden = false;
    taskTimers.push(setInterval(() => {
      const counts = pose.zoneCounts(n);
      const index = counts.findIndex((c) => c > 0);
      if (index >= 0) report("zone", { taskSeq, index });
    }, 700));
  }
  $("#hint").textContent = ways.length ? ways.join(", or ").replace(/^./, (c) => c.toUpperCase()) : "";
}

function showScores(scores) {
  for (const s of scores || []) {
    const b = document.querySelector(`.w-opt[data-id="${CSS.escape(s.id)}"]`);
    if (!b) continue;
    b.querySelector(".bar").style.width = `${Math.round((s.score || 0) * 100)}%`;
    b.classList.toggle("is-winner", Boolean(s.winner));
  }
}

function taskMove(task) {
  const info = moveInfo(task.move, task.def ? [task.def] : []);
  const reps = task.reps || 1;
  $("#moveBox").hidden = false;
  $("#hint").textContent = task.question || "";
  const goal = info.kind === "count" && reps > 1 ? `${task.name || info.name}, ${reps} times` : task.name || info.name;
  $("#moveStatus").textContent = goal;
  const ring = $("#moveRing");
  ring.classList.remove("is-done");
  ring.style.setProperty("--progress", "0");
  $("#moveRingLabel").textContent = "";
  let done = false, last = { value: -1, doing: null }, lastSent = 0;
  const finish = (via) => {
    done = true;
    ring.classList.add("is-done");
    ring.style.setProperty("--progress", "1");
    $("#moveRingLabel").textContent = "✓";
    $("#moveStatus").textContent = "Counted! Well done";
    $("#moveDetail").textContent = "";
    $("#didItBtn").hidden = true;
    report("move", { taskSeq, value: 1, done: true, doing: false, via });
  };
  $("#didItBtn").onclick = () => finish("button");

  if (camState === "on" && pose?.running) {
    $("#selfView").hidden = false;
    pose.setCustomMoves(task.def ? [task.def] : []);
    pose.watch(task.move, { holdSec: task.holdSec || 1, reps, strictness: task.strictness || "normal" });
    $("#moveDetail").textContent = "Your camera is watching. Make sure it can see you.";
    // If the camera struggles, offer the button after a while.
    taskTimers.push(setTimeout(() => { if (!done) $("#didItBtn").hidden = false; }, 8000));
    taskTimers.push(setInterval(() => {
      if (done || clock.paused) return;
      const p = pose.progress();
      ring.style.setProperty("--progress", String(p.value));
      $("#moveRingLabel").textContent = p.label && p.label.length < 12 ? p.label : "";
      if (p.value >= 1) return finish("camera");
      const now = performance.now();
      if (Math.abs(p.value - last.value) >= 0.1 || p.doingNow !== last.doing || now - lastSent > 2000) {
        last = { value: p.value, doing: p.doingNow };
        lastSent = now;
        report("move", { taskSeq, value: p.value, done: false, doing: p.doingNow, via: "camera" });
      }
    }, 250));
  } else {
    $("#moveDetail").textContent = "Do the move, then tap the button.";
    $("#didItBtn").hidden = false;
    report("move", { taskSeq, value: 0, done: false, doing: false, via: "button" });
  }
}

function taskSay(task) {
  $("#sayBox").hidden = false;
  $("#hint").textContent = task.capture ? "Shout out a name!" : "Say your answer out loud!";
  $("#sayStatus").textContent = "";
  $("#sayMic").textContent = voice?.supported ? "Your microphone is listening." : "Type your answer below.";
  if (voice?.supported) voice.start();
  const send = () => {
    const text = $("#sayInput").value.trim();
    if (!text) return;
    report("speech", { text, alts: [text] });
    $("#sayInput").value = "";
    $("#sayStatus").textContent = `Sent: “${text}”`;
  };
  $("#sayBtn").onclick = send;
  $("#sayInput").onkeydown = (e) => { if (e.key === "Enter") send(); };
}

function taskCheer(task) {
  $("#cheerBox").hidden = false;
  $("#cheerTitle").textContent = `Cheer for ${label(task.option || { label: "it" })}!`;
  if (!recorder?.ready) { $("#cheerTitle").textContent += " (turn on your microphone to count)"; return; }
  let peak = 0;
  taskTimers.push(setInterval(() => { peak = Math.max(peak, recorder.level || 0); }, 50));
  taskTimers.push(setInterval(() => { report("level", { taskSeq, level: peak }); peak = 0; }, 300));
}

function taskName(task) {
  if (!task.name) return;
  $("#nameBox").hidden = false;
  $("#heardName").textContent = task.name;
}

function taskBreak(task) {
  $("#breakBox").hidden = false;
  $("#breakMsg").textContent = task.message || "Short break";
}

function taskEnd() {
  $("#endBox").hidden = false;
}

window.addEventListener("pagehide", () => { if (me) navigator.sendBeacon?.("/api/live/report", new Blob([JSON.stringify({ room: me.room, pid: me.pid, token: me.token, kind: "leave" })], { type: "application/json" })); });
