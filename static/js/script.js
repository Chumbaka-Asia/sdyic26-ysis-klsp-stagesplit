// Filming script: every clip the actors need to record, in story order or
// grouped by actor, with a teleprompter view. Print it or save as PDF.

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const showId = params.get("show");
let story, videos = [], by = params.get("by") === "actor" ? "actor" : "scene";

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) if (v != null && v !== false) n.setAttribute(k === "class" ? "class" : k, v);
  kids.flat().forEach((c) => c != null && c !== false && n.append(c instanceof Node ? c : document.createTextNode(String(c))));
  return n;
}

function partTitle(n) {
  const t = ["choice", "action", "open"].includes(n.type) ? n.question : n.type === "pause" ? n.message : n.clip?.title;
  return t || n.type;
}

function links(n) {
  switch (n.type) {
    case "scene": case "open": case "pause": return [{ to: n.next, label: "Then" }];
    case "choice": return (n.options || []).map((o) => ({ to: o.next, label: `If they pick ${o.emoji ? o.emoji + " " : ""}${o.label}` }));
    case "action": return [{ to: n.success, label: "If they do it" }, { to: n.timeout_next, label: "If time runs out" }];
    default: return [];
  }
}

/** Parts in story order: follow each path to its end before the next. */
function orderedParts() {
  const out = [], seen = new Set();
  const visit = (id, via) => {
    if (!id || seen.has(id) || !story.nodes[id]) return;
    seen.add(id);
    out.push({ id, node: story.nodes[id], via });
    links(story.nodes[id]).forEach((l) => visit(l.to, l.label === "Then" ? null : l.label));
  };
  visit(story.start, null);
  Object.keys(story.nodes).forEach((id) => visit(id, "Not connected to the story yet"));
  return out;
}

function clipsOf(n) {
  const c = [];
  const add = (role, clip, loop = false) => clip && c.push({ role, clip, loop });
  switch (n.type) {
    case "scene": add("Scene", n.clip); break;
    case "end": add("Final scene", n.clip); break;
    case "pause": add("Break screen", n.clip, true); break;
    case "choice": add("Asks the question", n.prompt); add("Waiting loop", n.idle, true); add("If nobody answers", n.timeout_clip); break;
    case "action": add("Asks for the move", n.prompt); add("Waiting loop", n.idle, true); break;
    case "open":
      add("Asks the question", n.prompt); add("Listening loop", n.idle, true);
      (n.categories || []).forEach((g) => add(`Reaction: ${g.name || g.id}`, g.reaction));
      add("Reaction to anything else", n.fallback_reaction);
      break;
  }
  return c;
}

function allClips() {
  const list = [];
  orderedParts().forEach((p, i) => {
    clipsOf(p.node).forEach((c, j) => list.push({ ...c, part: p, partNum: i + 1, num: `${i + 1}.${j + 1}`, filmed: Boolean(c.clip.file && videos.includes(c.clip.file)) }));
  });
  return list;
}

function clipCard(c, showPart) {
  const clip = c.clip;
  return el("div", { class: "clip" },
    el("div", { class: "clip-head" },
      el("span", { class: "box" }),
      el("span", { class: "num" }, c.num),
      el("span", { class: "role" }, c.role),
      showPart ? el("span", {}, `· ${c.partNum}. ${partTitle(c.part.node)}`) : null,
      clip.file ? el("span", {}, `· ${clip.file}`) : el("span", {}, "· no file name yet"),
      clip.duration ? el("span", {}, `· about ${clip.duration}s`) : null,
      el("span", { class: `status ${c.filmed ? "done" : "todo"}` }, c.filmed ? "✓ Filmed" : "Not filmed yet")),
    el("p", { class: "who" }, clip.who || "Who says it: not set"),
    clip.line ? el("p", { class: "line" }, clip.line) : el("p", { class: "line empty" }, "No lines written yet."),
    clip.caption ? el("p", { class: "onscreen" }, `On screen: ${clip.caption}`) : null,
    el("p", { class: "note" }, c.loop
      ? "Loops while the children answer: keep it short, and start and end in the same neutral pose."
      : "Start and end in the same neutral pose, so the cuts are seamless."));
}

function render() {
  const todoOnly = $("#todoOnly").checked;
  let clips = allClips();
  const total = clips.length, filmed = clips.filter((c) => c.filmed).length;
  if (todoOnly) clips = clips.filter((c) => !c.filmed);
  $("#title").textContent = story.title || "Untitled show";
  $("#sub").textContent = `Filming script · ${total} clips, ${filmed} filmed · printed ${new Date().toLocaleDateString()}`;
  const out = $("#out");
  out.innerHTML = "";
  if (by === "scene") {
    let last = null;
    clips.forEach((c) => {
      if (c.part.id !== last) {
        last = c.part.id;
        out.append(el("div", { class: "part" },
          el("h2", {}, `${c.partNum}. ${partTitle(c.part.node)}`),
          c.part.via ? el("p", { class: "path" }, `Path: ${c.part.via}`) : null));
      }
      out.append(clipCard(c, false));
    });
  } else {
    const groups = new Map();
    clips.forEach((c) => {
      const who = (c.clip.who || "").trim() || "Not assigned yet";
      if (!groups.has(who)) groups.set(who, []);
      groups.get(who).push(c);
    });
    [...groups.keys()].sort((a, b) => (a === "Not assigned yet") - (b === "Not assigned yet") || a.localeCompare(b)).forEach((who) => {
      out.append(el("h2", { class: "actor" }, `${who} (${groups.get(who).length} clips)`));
      groups.get(who).forEach((c) => out.append(clipCard(c, true)));
    });
  }
  if (!clips.length) out.append(el("p", { class: "sub" }, todoOnly ? "Everything is filmed!" : "No clips yet."));
  renderPrompter(clips);
}

function renderPrompter(clips) {
  const tp = $("#tp");
  tp.innerHTML = "";
  clips.filter((c) => c.clip.line).forEach((c) => {
    tp.append(el("p", { class: "tp-cue" }, `${c.num} · ${c.role}${c.clip.who ? ` · ${c.clip.who}` : ""}`), el("p", { class: "tp-line" }, c.clip.line));
  });
}

// Teleprompter scrolling
let scrolling = false, raf = null, last = 0;
function scrollStep(t) {
  if (!scrolling) return;
  const dt = last ? (t - last) / 1000 : 0;
  last = t;
  window.scrollBy(0, Number($("#tpSpeed").value) * dt);
  raf = requestAnimationFrame(scrollStep);
}
function toggleScroll() {
  scrolling = !scrolling;
  $("#tpPlay").textContent = scrolling ? "⏸ Stop" : "▶ Scroll";
  last = 0;
  if (scrolling) raf = requestAnimationFrame(scrollStep); else cancelAnimationFrame(raf);
}

$("#byScene").addEventListener("click", () => { by = "scene"; sync(); render(); });
$("#byActor").addEventListener("click", () => { by = "actor"; sync(); render(); });
$("#todoOnly").addEventListener("change", render);
$("#printBtn").addEventListener("click", () => window.print());
$("#tpBtn").addEventListener("click", () => {
  const on = document.body.classList.toggle("prompter");
  $("#tpTools").hidden = !on;
  $("#tpBtn").textContent = on ? "📄 Back to the script" : "📺 Teleprompter";
  window.scrollTo(0, 0);
  if (!on && scrolling) toggleScroll();
});
$("#tpPlay").addEventListener("click", toggleScroll);
$("#tpMirror").addEventListener("click", () => $("#tp").classList.toggle("mirror"));
document.addEventListener("keydown", (e) => {
  if (!document.body.classList.contains("prompter")) return;
  if (e.key === " ") { e.preventDefault(); toggleScroll(); }
  if (e.key === "ArrowUp") $("#tpSpeed").value = Number($("#tpSpeed").value) + 10;
  if (e.key === "ArrowDown") $("#tpSpeed").value = Number($("#tpSpeed").value) - 10;
});
function sync() {
  $("#byScene").setAttribute("aria-pressed", String(by === "scene"));
  $("#byActor").setAttribute("aria-pressed", String(by === "actor"));
}

async function init() {
  const res = await fetch(`/api/shows/${encodeURIComponent(showId)}/story.json`);
  if (!res.ok) { $("#title").textContent = "Show not found"; return; }
  story = await res.json();
  videos = await fetch(`/api/projects/${encodeURIComponent(showId)}/videos`).then((r) => r.json()).catch(() => []);
  document.title = `Filming script · ${story.title}`;
  $("#toolTitle").textContent = story.title;
  sync();
  render();
}
init();
