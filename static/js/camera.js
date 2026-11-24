// Camera check: shows which trackers work on this laptop, what the camera can
// see, and lets you try any move. Also makes a report for troubleshooting.

import { PoseDetector, BUILTIN_MOVES, moveInfo } from "./pose.js";

const $ = (s) => document.querySelector(s);
let det = null, custom = [], version = "?", doneAt = null;

const PARTS = [["Head", [0]], ["Shoulders", [11, 12]], ["Hands (wrists)", [15, 16]], ["Hips", [23, 24]], ["Knees", [25, 26]], ["Feet", [27, 28]]];

async function init() {
  const info = await fetch("/api/info").then((r) => r.json()).catch(() => ({}));
  version = info.version || "?";
  $("#version").textContent = `version ${version}`;
  const list = await fetch("/api/projects").then((r) => r.json()).catch(() => ({}));
  if (list.current) {
    const story = await fetch(`/api/shows/${list.current}/story.json`).then((r) => r.json()).catch(() => null);
    custom = story?.settings?.custom_actions || [];
  }
  const sel = $("#moveSel");
  const add = (id, label) => { const o = document.createElement("option"); o.value = id; o.textContent = label; sel.append(o); };
  BUILTIN_MOVES.forEach((m) => add(m.id, `${m.name} (${m.kind === "hold" ? "hold it" : "repeat it"})`));
  custom.forEach((m) => add(m.id, `${m.type === "taught" ? "🎓" : "✨"} ${m.name} (from the open show)`));
}

function watchSelected() {
  if (!det?.running) return;
  const id = $("#moveSel").value;
  const info = moveInfo(id, custom);
  det.watch(id, { strictness: $("#strictSel").value, holdSec: 1, reps: info.reps || 1 });
  doneAt = null;
}

async function start() {
  $("#startBox").hidden = true;
  $("#sCam").textContent = "starting…";
  det = new PoseDetector($("#v"), $("#c"), { onStatus: () => {} });
  det.keepDetail = true;
  det.setCustomMoves(custom);
  await det.setMode($("#modeSel").value);
  await det.setMaxPeople(Number($("#maxSel").value));
  await det.start();
  if (!det.running) { render(); return; }
  await applyDetail();
  watchSelected();
  loop();
}

async function applyDetail() {
  if (!det?.running) return;
  await det.setDetail({ hands: $("#useHands").checked, face: $("#useFace").checked });
}

function cls(el, text) {
  el.textContent = text;
  el.className = "v " + (/^working/.test(text) || text === "on" ? "good" : /couldn|blocked|fail|error/i.test(text) ? "bad" : /loading/.test(text) ? "warn" : "");
}

function render() {
  const i = det?.info || {};
  cls($("#sCam"), det?.running ? "on" : i.body?.includes("blocked") ? "blocked by the browser" : det ? "couldn't start" : "not started");
  cls($("#sBody"), i.body || "off");
  cls($("#sHands"), $("#useHands").checked ? (i.hands || "off") : "off");
  cls($("#sFace"), $("#useFace").checked ? (i.face || "off") : "off");
  const fps = i.fps || 0;
  $("#sFps").textContent = det?.running ? `${fps} frames a second` : "–";
  $("#sFps").className = "v " + (!det?.running ? "" : fps >= 15 ? "good" : fps >= 8 ? "warn" : "bad");

  const lm = det?.people?.[0];
  const hands = det?.handResult?.landmarks?.length || 0;
  const face = Boolean(det?.faceResult?.faceLandmarks?.length);
  const seen = PARTS.map(([name, idx]) => [name, Boolean(lm) && idx.every((k) => (lm[k]?.visibility ?? 0) >= 0.5)]);
  const sees = $("#sees");
  sees.innerHTML = "";
  const chip = (text, on) => { const s = document.createElement("span"); s.className = `part${on ? " on" : ""}`; s.textContent = text; sees.append(s); };
  chip(det?.running ? `${det.state.people} ${det.state.people === 1 ? "person" : "people"}` : "no one yet", det?.state.people > 0);
  seen.forEach(([n, on]) => chip(n, on));
  if ($("#useHands").checked) chip(`${hands} ${hands === 1 ? "hand" : "hands"} with fingers`, hands > 0);
  if ($("#useFace").checked) chip(face ? "Face" : "No face", face);

  const tips = [];
  if (!det) tips.push("Press “Start the camera”.");
  else if (!det.running) {
    tips.push("If the browser asked for the camera, allow it (camera icon in the address bar).");
    tips.push("Close other apps that use the camera, such as Zoom, Teams or the Camera app.");
    tips.push("The first time, the trackers download from the internet, so check the Wi-Fi.");
  } else {
    if (/couldn/.test(i.hands || "") || /couldn/.test(i.face || "")) tips.push("Hand or face tracking couldn't load. Check the internet connection (needed the first time), then press Start again. Moves that don't need fingers or the face still work.");
    if (fps && fps < 8) tips.push("The camera is running slowly. Untick hand or face tracking when you don't need them, close other programs, or plug the laptop in.");
    if (lm && !seen[3][1]) tips.push("Hips aren't visible: jumps are measured from the shoulders. Marching and touching toes need the whole body in view.");
    if ($("#useHands").checked && lm && !hands) tips.push("No hands found: hold them up in view. Fingers need good light and to be within about 2–3 metres.");
    if (!lm) tips.push("No one seen: stand in front of the camera, with light on your face rather than behind you.");
  }
  $("#tips").innerHTML = tips.map((t) => `<li>${t}</li>`).join("");
}

function loop() {
  render();
  if (det?.running) {
    const p = det.progress();
    const done = p.value >= 1;
    $("#result").textContent = done ? "Yes! That counts" : p.doingNow ? "Keep going…" : "Not yet";
    $("#result").classList.toggle("is-yes", done);
    $("#bar").style.width = `${Math.round(p.value * 100)}%`;
    $("#detail").textContent = [p.label, det.mode === "auditorium" ? `${p.people} people seen` : ""].filter(Boolean).join(" · ");
    if (done) { doneAt ??= performance.now(); if (performance.now() - doneAt > 1500) watchSelected(); }
  }
  requestAnimationFrame(loop);
}

$("#startBtn").addEventListener("click", start);
$("#useHands").addEventListener("change", applyDetail);
$("#useFace").addEventListener("change", applyDetail);
$("#moveSel").addEventListener("change", watchSelected);
$("#strictSel").addEventListener("change", watchSelected);
$("#modeSel").addEventListener("change", async () => { await det?.setMode($("#modeSel").value); watchSelected(); });
$("#maxSel").addEventListener("change", async () => { await det?.setMaxPeople(Number($("#maxSel").value)); watchSelected(); });
$("#copyBtn").addEventListener("click", async () => {
  const i = det?.info || {};
  const text = [
    `KLSP camera check report`,
    `Version: ${version}`,
    `Browser: ${navigator.userAgent}`,
    `Camera running: ${Boolean(det?.running)}`,
    `Body tracking: ${i.body || "off"}`,
    `Hand tracking: ${i.hands || "off"}`,
    `Face tracking: ${i.face || "off"}`,
    `Speed: ${i.fps || 0} fps`,
    `People seen: ${det?.state?.people ?? 0}; hands: ${det?.handResult?.landmarks?.length || 0}; face: ${Boolean(det?.faceResult?.faceLandmarks?.length)}`,
    `Last error: ${i.lastError || "none"}`,
    `Move tested: ${$("#moveSel").value} (${$("#strictSel").value}, ${$("#modeSel").value})`,
  ].join("\n");
  try { await navigator.clipboard.writeText(text); $("#copied").textContent = "Copied. Paste it into a message."; }
  catch { $("#copied").textContent = text; }
});
init();
