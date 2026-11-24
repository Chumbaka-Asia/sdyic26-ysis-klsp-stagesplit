// Operator console: a second window on the show laptop (like presenter view).
// The projector shows only the stage; this window shows everything the
// operator needs, and big buttons to override the AI at any moment.
// It talks to the show window through a BroadcastChannel (same browser).

const $ = (s) => document.querySelector(s);
const channel = new BroadcastChannel("klsp-show");
let state = null;
let lastSeen = 0;
let ctxKey = "";

const send = (cmd, extra = {}) => channel.postMessage({ type: "cmd", cmd, ...extra });
const key = (k) => send("key", { key: k });
setInterval(() => channel.postMessage({ type: "hello" }), 1000);

channel.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === "state") { state = m; lastSeen = Date.now(); render(); }
  if (m.type === "cam") { $("#camImg").src = m.img; $("#camNote").hidden = true; }
};

setInterval(() => {
  const on = Date.now() - lastSeen < 2000;
  $("#link").dataset.state = on ? "on" : "off";
  $("#link").textContent = on ? "Connected to the show" : "Not connected. Open the show page in this browser.";
}, 700);

const TYPE_NAMES = { scene: "🎬 Scene", choice: "❓ Question", action: "🙌 Move", open: "💬 Say anything", pause: "⏸ Pause", end: "🏁 Ending" };

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  kids.flat().forEach((c) => c != null && n.append(c instanceof Node ? c : document.createTextNode(String(c))));
  return n;
}

function render() {
  const s = state;
  $("#title").textContent = s.title || "Show";
  document.title = `Operator · ${s.title || "Show"}`;
  $("#partType").textContent = s.part ? TYPE_NAMES[s.part.type] || s.part.type : s.started ? "Now" : "Not started";
  $("#partTitle").textContent = s.ended ? "The end" : s.part ? s.part.title : s.started ? "…" : "Press “Start the show” on the stage screen";
  $("#countdown").hidden = !s.countdown;
  $("#countdown").textContent = s.countdown || "";
  $("#pauseBtn").innerHTML = s.paused ? "▶ Resume <kbd>P</kbd>" : "⏸ Pause <kbd>P</kbd>";
  $("#people").textContent = s.cam === "watching" ? `· ${s.people} ${s.people === 1 ? "person" : "people"} seen` : "";
  if (s.cam !== "watching") { $("#camImg").removeAttribute("src"); $("#camNote").hidden = false; }
  $("#modeSingle").setAttribute("aria-pressed", String(s.mode !== "auditorium"));
  $("#modeAud").setAttribute("aria-pressed", String(s.mode === "auditorium"));
  $("#levelBar").style.width = `${Math.round(Math.min(1, s.level) * 100)}%`;
  $("#motionBar").style.width = `${Math.round(Math.min(1, s.motion * 12) * 100)}%`;
  $("#heard").textContent = s.heard || "…";
  const names = Object.entries(s.vars || {});
  $("#vars").textContent = names.length ? `Remembered: ${names.map(([k, v]) => `{${k}} = ${v}`).join(", ")}` : "";

  // Jump list: rebuild only when the parts change.
  const partsKey = s.parts.map((p) => p.id + p.title).join("|");
  if (partsKey !== render.partsKey) {
    render.partsKey = partsKey;
    const sel = $("#jumpSelect");
    sel.innerHTML = "";
    s.parts.forEach((p) => sel.append(el("option", { value: p.id }, p.title)));
  }
  $("#log").innerHTML = "";
  s.log.forEach((l) => $("#log").append(el("li", {}, l)));
  renderContext();
}

/** The big contextual buttons: what the operator can do at this moment. */
function renderContext() {
  const s = state;
  const box = $("#ctx");
  const k = [s.part?.id, s.part?.type, Boolean(s.nameCheck), s.paused, s.ended, (s.options || []).length].join("|");
  if (k === ctxKey) return updateContext();
  ctxKey = k;
  box.innerHTML = "";
  const title = $("#ctxTitle");
  if (!s.started) { title.textContent = "Controls"; box.append(el("p", { class: "ctx-note" }, "Start the show on the stage screen. The controls appear here.")); return; }
  if (s.paused) { title.textContent = "Paused"; box.append(el("button", { class: "big primary", onclick: () => send("resume") }, "▶ Resume the show")); return; }
  if (s.ended) { title.textContent = "The end"; box.append(el("button", { class: "big primary", onclick: () => send("restart", { where: "beginning" }) }, "⏮ Start again")); return; }

  if (s.nameCheck) {
    title.textContent = "Check the name";
    const input = el("input", { id: "nameInput", type: "text", value: s.nameCheck.name || "", placeholder: "Type the name", "aria-label": "Name" });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); send("name-set", { name: input.value }); } });
    box.append(
      el("p", { class: "ctx-note" }, s.nameCheck.name ? "The show heard:" : "No name was caught."),
      el("p", { class: "name-big" }, s.nameCheck.name || "—"),
      el("div", { class: "name-edit" }, input, el("button", { class: "big go", onclick: () => send("name-set", { name: input.value }) }, "✓ Use this name")),
      el("div", { class: "row" },
        el("button", { onclick: () => key("r") }, "↻ Listen again", el("kbd", {}, "R")),
        el("button", { onclick: () => key("x") }, "✕ No name", el("kbd", {}, "X")),
        s.nameCheck.name ? el("button", { onclick: () => send("name-save") }, "★ Save to name library") : null));
    return;
  }
  const t = s.part?.type;
  if (t === "choice") {
    title.textContent = "Force an answer";
    box.append(el("div", { class: "force" }, s.options.map((o) =>
      el("button", { "data-id": o.id, onclick: () => key(String(o.n)) },
        el("span", { class: "lab" }, el("span", { class: "emo" }, o.emoji || ""), o.label, el("span", { class: "num" }, o.n)),
        el("span", { class: "sbar" }, el("span")),
        el("span", { class: "meta" })))));
    box.append(el("p", { class: "ctx-note" }, "Press a number to choose that answer straight away, or Space to end the waiting and let the votes decide."));
  } else if (t === "action") {
    title.textContent = "Move";
    box.append(
      el("div", { class: "progress" }, el("span", { id: "moveBar" })),
      el("p", { id: "moveNote", class: "ctx-note" }),
      el("div", { class: "row" },
        el("button", { class: "big go", onclick: () => key("Enter") }, "✓ They did it", el("kbd", {}, "Enter")),
        el("button", { class: "big", onclick: () => key(" ") }, "Time's up", el("kbd", {}, "Space"))));
  } else if (t === "open") {
    title.textContent = "Choose a reaction";
    box.append(el("div", { class: "row" }, s.categories.map((c) => el("button", { class: "big", onclick: () => key(String(c.n)) }, c.name, el("kbd", {}, c.n))),
      el("button", { class: "big", onclick: () => key(" ") }, "No answer / skip", el("kbd", {}, "Space"))));
  } else if (t === "pause") {
    title.textContent = "Break";
    box.append(el("button", { class: "big primary", onclick: () => key("c") }, "▶ Continue the show", el("kbd", {}, "C")));
  } else {
    title.textContent = "Scene";
    box.append(el("button", { class: "big", onclick: () => key(" ") }, "⏭ Skip this clip", el("kbd", {}, "Space")));
  }
  updateContext();
}

function updateContext() {
  const s = state;
  (s.options || []).forEach((o) => {
    const b = document.querySelector(`.force [data-id="${CSS.escape(o.id)}"]`);
    if (!b) return;
    b.querySelector(".sbar span").style.width = `${Math.round((o.score || 0) * 100)}%`;
    b.querySelector(".meta").textContent = `${o.votes || 0} votes · ${o.voice || 0} heard · ${o.emojis || 0} emojis${o.cheer ? ` · cheer ${Math.round(o.cheer * 100)}` : ""}${o.zone ? ` · ${Math.round(o.zone)} standing` : ""}`;
  });
  if (s.move && $("#moveBar")) {
    $("#moveBar").style.width = `${Math.round((s.move.value || 0) * 100)}%`;
    $("#moveNote").textContent = `${s.move.name}${s.move.label ? `: ${s.move.label}` : ""}${s.move.doingNow ? " (doing it now)" : ""}`;
  }
}

// Always-on controls
$("#pauseBtn").addEventListener("click", () => send(state?.paused ? "resume" : "pause"));
$("#skipBtn").addEventListener("click", () => key(" "));
$("#restartPartBtn").addEventListener("click", () => send("restart", { where: "part" }));
$("#restartAllBtn").addEventListener("click", () => { if (confirm("Start the show again from the beginning?")) send("restart", { where: "beginning" }); });
$("#jumpBtn").addEventListener("click", () => send("restart", { where: $("#jumpSelect").value }));
$("#modeSingle").addEventListener("click", () => send("mode", { mode: "single" }));
$("#modeAud").addEventListener("click", () => send("mode", { mode: "auditorium" }));

// Keyboard shortcuts work in this window too.
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, select, textarea")) return;
  if (e.key === " ") { e.preventDefault(); key(" "); }
  else if (/^[1-6]$/.test(e.key) || ["Enter", "c", "C", "r", "R", "x", "X"].includes(e.key)) key(e.key);
  else if (e.key === "p" || e.key === "P") send(state?.paused ? "resume" : "pause");
  else if ((e.key === "e" || e.key === "E") && $("#nameInput")) { e.preventDefault(); $("#nameInput").focus(); $("#nameInput").select(); }
});

// Phones: room code, join address, public link
async function refreshPhones() {
  const info = await fetch("/api/info").then((r) => r.json()).catch(() => null);
  if (!info) return;
  $("#room").textContent = info.room;
  $("#joinUrl").textContent = `Or go to ${info.join_url.replace(/^https?:\/\//, "")} and type the code.`;
  const k = info.public?.url || "lan";
  if (k !== refreshPhones.k) { refreshPhones.k = k; $("#qr").src = `/api/qr?t=${Date.now()}`; }
  const p = info.public || {};
  const btn = $("#publicBtn");
  btn.disabled = p.state === "starting" || p.state === "downloading";
  btn.textContent = p.state === "on" ? "Turn off the public link" : p.state === "downloading" ? "Downloading the link tool…" : p.state === "starting" ? "Starting…" : "🌐 Make a public link";
  $("#publicNote").textContent = p.state === "on" ? `Public link is on: ${p.url.replace(/^https:\/\//, "")}. Phones anywhere can join with the room code.`
    : p.state === "failed" ? `Couldn't make a public link: ${p.error}`
    : "For phones on mobile data or another Wi-Fi. Only voting is reachable through it.";
  btn.dataset.state = p.state;
}
$("#publicBtn").addEventListener("click", async () => {
  const on = $("#publicBtn").dataset.state === "on";
  await fetch(on ? "/api/tunnel/stop" : "/api/tunnel/start", { method: "POST" });
  refreshPhones();
});
refreshPhones();
setInterval(refreshPhones, 2000);
