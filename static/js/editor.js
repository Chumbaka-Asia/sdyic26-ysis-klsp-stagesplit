// Story editor: build and change the show without touching code.
// Left: the story map (a tree). Right: a simple form for the selected part.
// Every change saves automatically to story.json; backups are kept on the server.

import { BUILTIN_MOVES, BODY_PARTS, RELATIONS, STRICTNESS, PoseDetector, moveInfo } from "./pose.js";
import { inputsFor, DEFAULT_WEIGHTS } from "./engine.js";
import { StoryCanvas } from "./canvas.js";
import { calibrate, resample } from "./taught.js";

const TYPES = {
  scene:  { icon: "🎬", name: "Scene",        desc: "The audience just watches." },
  choice: { icon: "❓", name: "Question",     desc: "Children pick an answer by voice or on a phone." },
  action: { icon: "🙌", name: "Move",         desc: "Children do a movement, like jumping, to carry on." },
  open:   { icon: "💬", name: "Say anything", desc: "Children shout any answer and the actors react." },
  pause:  { icon: "⏸️", name: "Pause",        desc: "The show waits until the presenter presses Continue. Good for breaks or setting up." },
  end:    { icon: "🏁", name: "Ending",       desc: "The show finishes here." },
};
const MAX_OPTIONS = 6;
const MAX_REACTIONS = 6;
const LANGUAGES = [["en-US", "English (US)"], ["en-GB", "English (UK)"], ["ms-MY", "Bahasa Melayu"], ["zh-CN", "中文 (普通话)"]];

const $ = (s) => document.querySelector(s);
let story = null;
let selected = null;      // selected part id
let view = "story";       // "story" | "moves" | "settings"
let selectedMove = null;  // selected custom move id
let videos = [];
let saveTimer = null;
let saving = false;
let unsaved = false;
let tester = null;        // PoseDetector used by the move tester
let query = "";           // story map search text
// "canvas" (visual map) or "list" (tree). Remembered on this computer.
let mapStyle = localStorage.getItem("klsp-map-style") || (window.innerWidth >= 1100 ? "canvas" : "list");
let canvas = null;
let pendingDropPos = null; // where a part dropped on the canvas should appear
const collapsed = new Set(); // parts whose branches are folded away in the map

// Undo / redo: snapshots of the whole story. Typing is grouped into one step.
let baseline = null;
let undoStack = [];
let redoStack = [];
let groupOpen = false;
let groupTimer = null;

// ---------------------------------------------------------------------------
// Tiny helper to build HTML elements
// ---------------------------------------------------------------------------
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (k === "checked" || k === "selected" || k === "disabled") el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// ---------------------------------------------------------------------------
// Story helpers
// ---------------------------------------------------------------------------
const clip = (title, line = "", duration = 5) => ({ file: "", title, line, duration });

function titleOf(node) {
  if (!node) return "Missing part";
  const t = ["choice", "action", "open"].includes(node.type) ? node.question
    : node.type === "pause" ? node.message : node.clip?.title;
  return (t && t.trim()) || `Untitled ${TYPES[node.type]?.name.toLowerCase() || "part"}`;
}

/** The "what happens next" links coming out of a part. */
function links(node) {
  switch (node.type) {
    case "scene": return [{ label: "Then", get: () => node.next, set: (v) => (node.next = v) }];
    case "open": return [{ label: "After the reaction", get: () => node.next, set: (v) => (node.next = v) }];
    case "pause": return [{ label: "After the break", get: () => node.next, set: (v) => (node.next = v) }];
    case "action": return [
      { label: "If they do it", get: () => node.success, set: (v) => (node.success = v) },
      { label: "If time runs out", get: () => node.timeout_next, set: (v) => (node.timeout_next = v) },
    ];
    case "choice": return (node.options || []).map((o) => ({
      label: `If they pick ${o.emoji ? o.emoji + " " : ""}${o.label || "this answer"}`,
      get: () => o.next, set: (v) => (o.next = v),
    }));
    default: return [];
  }
}

function newId(prefix) {
  let i = 1;
  while (story.nodes[`${prefix}_${i}`]) i++;
  return `${prefix}_${i}`;
}

function newPart(type) {
  switch (type) {
    case "scene": return { type, clip: clip("New scene", "", 6), next: null };
    case "choice": return {
      type, question: "New question?",
      prompt: clip("Asking the question"), idle: clip("Waiting for answers"),
      timeout_clip: clip("Nobody answered", "Nobody chose? Then I'll pick!", 4),
      window_sec: 15, default: "opt1",
      options: [
        { id: "opt1", label: "First answer", emoji: "⭐", keywords: [], next: null },
        { id: "opt2", label: "Second answer", emoji: "🌙", keywords: [], next: null },
      ],
    };
    case "action": return {
      type, question: "Everyone, raise your hands!", action: "hands_up", hold_sec: 1, timeout_sec: 20,
      prompt: clip("Asking for the move"), idle: clip("Waiting for the move"),
      success: null, timeout_next: null,
    };
    case "open": return {
      type, question: "What do you think?", listen_sec: 12,
      prompt: clip("Asking the question"), idle: clip("Listening"),
      categories: [], fallback_reaction: clip("What a great idea!", "What a creative answer!"),
      next: null,
    };
    case "pause": return { type, message: "Short break", auto_sec: 0, clip: clip("Short break", "We'll be right back!", 5), next: null };
    case "end": return { type, clip: clip("The end", "Thank you for watching!", 6) };
  }
}

/** Name tags the children's answers are saved as, e.g. ["donkey name"]. */
function nameTags() {
  return [...new Set(Object.values(story.nodes).map((n) => n.capture?.save_as).filter(Boolean))];
}

function customMoves() {
  story.settings ??= {};
  story.settings.custom_actions ??= [];
  return story.settings.custom_actions;
}

/** Things the team should fix before the show will run properly. */
function findProblems() {
  const out = [];
  const reach = reachable();
  for (const [id, node] of Object.entries(story.nodes)) {
    const name = `“${titleOf(node)}”`;
    for (const l of links(node)) {
      const t = l.get();
      if (!t) out.push({ id, text: `${name}: choose what happens ${whenText(l)}.` });
      else if (!story.nodes[t]) out.push({ id, text: `${name} points to a part that was deleted.` });
    }
    if (node.type === "choice" && (node.options || []).length < 2) out.push({ id, text: `${name} needs at least 2 answers.` });
    if (node.type === "action" && !BUILTIN_MOVES.some((m) => m.id === node.action) && !customMoves().some((m) => m.id === node.action))
      out.push({ id, text: `${name} uses a move that was deleted.` });
    const taught = node.type === "action" && customMoves().find((m) => m.id === node.action && m.type === "taught");
    if (taught && (taught.examples || []).length < 3)
      out.push({ id, text: `${name} uses “${taught.name}”, which needs at least 3 examples (Moves tab).` });
    if (!reach.has(id)) out.push({ id, text: `${name} isn't connected to the story yet.` });
  }
  return out;
}

function reachable() {
  const seen = new Set();
  const stack = [story.start];
  while (stack.length) {
    const id = stack.pop();
    if (!id || seen.has(id) || !story.nodes[id]) continue;
    seen.add(id);
    links(story.nodes[id]).forEach((l) => stack.push(l.get()));
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------
function changed({ tree = true, form = false } = {}) {
  recordHistory(form);
  scheduleSave();
  if (tree) renderMap();
  if (form) renderPanel();
}

function scheduleSave() {
  unsaved = true;
  setStatus("Saving…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 700);
}

/** Save straight away (used before closing a project or previewing). */
async function flushSave() {
  if (!unsaved) return;
  clearTimeout(saveTimer);
  await save();
}

// ---------------------------------------------------------------------------
// Undo and redo
// ---------------------------------------------------------------------------
function recordHistory(structural) {
  if (!groupOpen) {
    undoStack.push(baseline);
    if (undoStack.length > 200) undoStack.shift();
    redoStack = [];
    groupOpen = true;
  }
  clearTimeout(groupTimer);
  if (structural) closeGroup();
  else groupTimer = setTimeout(closeGroup, 1000);
  syncUndo();
}

function closeGroup() {
  clearTimeout(groupTimer);
  groupOpen = false;
  baseline = JSON.stringify(story);
}

function undo() {
  closeGroup();
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify(story));
  story = JSON.parse(undoStack.pop());
  afterHistory("Undone");
}

function redo() {
  closeGroup();
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(story));
  story = JSON.parse(redoStack.pop());
  afterHistory("Redone");
}

function afterHistory() {
  baseline = JSON.stringify(story);
  if (!story.nodes[selected]) selected = story.start;
  if (selectedMove && !customMoves().some((m) => m.id === selectedMove)) selectedMove = null;
  $("#storyTitle").value = story.title || "";
  stopTester();
  renderMap();
  renderPanel();
  syncUndo();
  scheduleSave();
}

function syncUndo() {
  $("#undoBtn").disabled = !undoStack.length;
  $("#redoBtn").disabled = !redoStack.length;
}

$("#undoBtn").addEventListener("click", undo);
$("#redoBtn").addEventListener("click", redo);
// ---------------------------------------------------------------------------
// Keyboard shortcuts (Ctrl on Windows, ⌘ Cmd on Mac)
// ---------------------------------------------------------------------------
document.addEventListener("keydown", (e) => {
  if (!story || e.defaultPrevented) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  const typing = e.target.matches("input:not([type=checkbox]):not([type=range]):not([type=file]), textarea, select") || e.target.isContentEditable;
  const inDialog = Boolean(e.target.closest("dialog"));
  const run = (fn) => { e.preventDefault(); fn(); };

  // These work everywhere, even while typing.
  if (mod && k === "s") return run(async () => { await flushSave(); setStatus("All changes saved"); });
  if (mod && k === "f") return run(() => {
    if (view !== "story") { view = "story"; stopTester(); syncTabs(); renderMap(); renderPanel(); }
    $("#search").focus();
    $("#search").select();
  });
  if (mod && (k === "/" || k === "?")) return run(() => $("#keysDialog").showModal());
  if (mod && k === "enter" && view === "story" && selected) return run(() => tryFromHere(selected));
  if (mod && e.shiftKey && k === "e") return run(() => $("#scriptBtn").click());

  // Everything below leaves text boxes alone: they keep their own copy, paste and undo.
  if (typing || inDialog) return;
  if (!mod && (k === "?" || (e.shiftKey && k === "/"))) return run(() => $("#keysDialog").showModal());
  if (mod && k === "z" && !e.shiftKey) return run(undo);
  if (mod && (k === "y" || (k === "z" && e.shiftKey))) return run(redo);

  // Canvas zoom (instead of zooming the whole page).
  if (mod && document.body.classList.contains("canvas-mode") && canvas) {
    if (k === "=" || k === "+") return run(() => canvas.zoomBy(1.2));
    if (k === "-") return run(() => canvas.zoomBy(1 / 1.2));
    if (k === "0") return run(() => canvas.fit());
  }

  if (view !== "story" || !selected || !story.nodes[selected]) return;
  if (mod && k === "c") return run(() => copyPart(selected));
  if (mod && k === "x") return run(() => { copyPart(selected); deletePart(selected, { quiet: true }); });
  if (mod && k === "v") return run(pastePart);
  if (mod && k === "d") return run(() => duplicatePart(selected));
  if (!mod && (k === "delete" || k === "backspace") && !canvas?.selWire) return run(() => deletePart(selected, { quiet: true }));
  if (e.key === "Escape" && query) return run(() => { query = ""; $("#search").value = ""; renderMap(); });
});

// ---------------------------------------------------------------------------
// Part actions shared by buttons and shortcuts
// ---------------------------------------------------------------------------
let clipboardPart = null; // fallback when the system clipboard isn't available

async function tryFromHere(id) {
  const win = window.open("about:blank", "_blank"); // open now, before saving, so pop-up blockers allow it
  await flushSave();
  if (win) win.location = `/play?show=${encodeURIComponent(story._project)}&from=${encodeURIComponent(id)}`;
}

function renamedCopy(node) {
  const copy = structuredClone(node);
  if ("question" in copy) copy.question = `${copy.question} (copy)`;
  else if ("message" in copy) copy.message = `${copy.message} (copy)`;
  else if (copy.clip) copy.clip.title = `${copy.clip.title} (copy)`;
  if (copy.ui) copy.ui = { x: copy.ui.x + 40, y: copy.ui.y + 40 };
  return copy;
}

function duplicatePart(id) {
  const node = story.nodes[id];
  if (!node) return;
  const nid = newId(node.type);
  story.nodes[nid] = renamedCopy(node);
  selected = nid;
  setStatus("Copy made. Connect it with “What happens next” or by dragging a wire.");
  changed({ form: true });
}

function deletePart(id, { quiet = false } = {}) {
  const node = story.nodes[id];
  if (!node) return;
  if (id === story.start) { setStatus("The first part can't be deleted. Make another part the start first.", true); return; }
  if (!quiet && !confirm(`Delete “${titleOf(node)}”? Anything that led here will need a new next step.`)) return;
  delete story.nodes[id];
  for (const n of Object.values(story.nodes)) links(n).forEach((l) => { if (l.get() === id) l.set(null); });
  selected = story.start;
  changed({ form: true });
  setStatus(`Deleted “${titleOf(node)}”. Press Ctrl+Z to undo.`);
}

/** Copy a part (with any custom move it uses), so it can be pasted here or in another show. */
async function copyPart(id) {
  const node = story.nodes[id];
  if (!node) return;
  const move = node.type === "action" ? customMoves().find((m) => m.id === node.action) : null;
  clipboardPart = { klsp_part: structuredClone(node), move: move ? structuredClone(move) : null };
  try { await navigator.clipboard.writeText(JSON.stringify(clipboardPart)); } catch { /* the in-page copy still works */ }
  setStatus(`Copied “${titleOf(node)}”. Press Ctrl+V to paste it, in this show or another.`);
}

async function pastePart() {
  let data = null;
  try { data = JSON.parse(await navigator.clipboard.readText()); } catch { /* not ours, or not allowed */ }
  if (!data?.klsp_part) data = clipboardPart;
  if (!data?.klsp_part) { setStatus("Nothing to paste. Select a part and press Ctrl+C first."); return; }
  const node = renamedCopy(data.klsp_part);
  // Paths to parts that don't exist in this show are cleared.
  links(node).forEach((l) => { if (l.get() && !story.nodes[l.get()]) l.set(null); });
  // Bring along a custom move this show doesn't have yet.
  if (data.move && !customMoves().some((m) => m.id === data.move.id)) customMoves().push(data.move);
  const nid = newId(node.type);
  story.nodes[nid] = node;
  selected = nid;
  changed({ form: true });
  setStatus(`Pasted “${titleOf(node)}”. Connect it with “What happens next” or by dragging a wire.`);
}

async function save() {
  if (saving) { saveTimer = setTimeout(save, 400); return; }
  saving = true;
  try {
    const res = await fetch("/api/story", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(story),
    });
    const data = await res.json();
    if (data.no_project) throw new Error("this project was closed in another window. Reload the page.");
    if (!data.ok) throw new Error(data.reason);
    unsaved = false;
    setStatus(`All changes saved`);
  } catch (err) {
    setStatus(`Not saved: ${err.message || "can't reach the server. Is it still running?"}`, true);
    saveTimer = setTimeout(save, 4000); // keep retrying
  } finally {
    saving = false;
  }
}

function setStatus(text, error = false) {
  const el = $("#saveStatus");
  el.textContent = text;
  el.classList.toggle("is-error", error);
}

window.addEventListener("beforeunload", (e) => {
  if (unsaved) { e.preventDefault(); e.returnValue = ""; }
});

// ---------------------------------------------------------------------------
// Left side: story map and moves list
// ---------------------------------------------------------------------------
function renderMap() {
  const body = $("#mapBody");
  body.innerHTML = "";
  renderProblems();
  document.body.classList.toggle("canvas-mode", view === "story" && mapStyle === "canvas");
  syncMapStyle();
  if (view === "moves") return renderMovesList(body);
  if (view === "story" && mapStyle === "canvas") return renderCanvas(body);
  if (query) return renderSearch(body);

  const seen = new Set();
  const tree = h("ul", { class: "tree seq" });
  sequence(story.start, tree, seen);
  body.append(tree);

  const loose = Object.keys(story.nodes).filter((id) => !seen.has(id));
  if (loose.length) {
    body.append(h("p", { class: "map-section" }, "Not connected yet"));
    const ul = h("ul", { class: "tree seq" });
    loose.forEach((id) => { if (!seen.has(id)) sequence(id, ul, seen); });
    body.append(ul);
  }
  body.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
}

function renderCanvas(body) {
  canvas ??= new StoryCanvas({
    story: () => story,
    selected: () => selected,
    select: (id) => select(id),
    links,
    titleOf,
    types: TYPES,
    problems: findProblems,
    reachable,
    changed: (opts) => changed(opts),
    query: () => query,
    openAdd: (fromId, link, pos) => { pendingDropPos = pos; openAddDialog(fromId, link); },
    addPart: (type, pos) => {
      const id = newId(type);
      story.nodes[id] = { ...newPart(type), ui: pos };
      selected = id;
      changed({ form: true });
    },
  });
  const first = !canvas.root.isConnected;
  body.append(canvas.root);
  canvas.render();
  if (first && !canvas.fitted) { canvas.fitted = true; requestAnimationFrame(() => canvas.fit()); }
}

function syncMapStyle() {
  const bar = $("#mapStyle");
  bar.hidden = view !== "story";
  $("#styleList").setAttribute("aria-pressed", String(mapStyle === "list"));
  $("#styleCanvas").setAttribute("aria-pressed", String(mapStyle === "canvas"));
}

function setMapStyle(style) {
  mapStyle = style;
  localStorage.setItem("klsp-map-style", style);
  renderMap();
}

function partText(node) {
  const bits = [node.question, node.message, node.clip?.title, node.clip?.line, node.clip?.caption, node.prompt?.line, node.capture?.save_as, ...(node.capture?.expected || [])];
  (node.options || []).forEach((o) => bits.push(o.label, ...(o.keywords || [])));
  (node.categories || []).forEach((c) => bits.push(c.name, c.description, c.reaction?.line));
  return bits.filter(Boolean).join(" ").toLowerCase();
}

function renderSearch(body) {
  const q = query.toLowerCase();
  const hits = Object.entries(story.nodes).filter(([, n]) => partText(n).includes(q) || titleOf(n).toLowerCase().includes(q));
  body.append(h("p", { class: "search-note" }, hits.length ? `${hits.length} part${hits.length === 1 ? "" : "s"} found` : "No parts match. Try a different word."));
  const ul = h("ul", { class: "tree seq" });
  hits.forEach(([id, n]) => ul.append(h("li", {}, nodeButton(id, n))));
  body.append(ul);
}

/** Draw a run of parts. Straight runs stay at one level; branches indent. */
function sequence(id, ul, seen) {
  let cur = id;
  while (cur) {
    const node = story.nodes[cur];
    if (!node) { ul.append(h("li", {}, h("p", { class: "help" }, "This link points to a deleted part."))); return; }
    if (seen.has(cur)) {
      const target = cur;
      ul.append(h("li", {}, h("button", { type: "button", class: "goto-btn", onclick: () => select(target) }, `↪ Joins up with “${titleOf(node)}”`)));
      return;
    }
    seen.add(cur);
    const li = h("li", {}, nodeButton(cur, node));
    ul.append(li);

    const ls = links(node);
    if (!ls.length) return;
    if (ls.length === 1 && ["scene", "open", "pause"].includes(node.type)) {
      const next = ls[0].get();
      if (!next) { ul.append(h("li", {}, addButton(cur, ls[0]))); return; }
      cur = next;
      continue;
    }
    const branches = h("ul", { class: "branches" });
    const from = cur;
    const folded = collapsed.has(cur);
    li.append(h("button", { type: "button", class: "fold-btn", "aria-expanded": String(!folded), onclick: () => {
      if (folded) collapsed.delete(from); else collapsed.add(from);
      renderMap();
    } }, folded ? `▸ Show ${ls.length} paths` : "▾ Hide paths"));
    for (const l of ls) {
      const sub = h("ul", { class: "seq" });
      const next = l.get();
      if (next) sequence(next, sub, seen);
      else sub.append(h("li", {}, addButton(from, l)));
      branches.append(h("li", { class: "branch" }, h("p", { class: "branch-label" }, l.label), sub));
    }
    if (!folded) li.append(branches); // folded paths are still walked, so they don't show as "not connected"
    return;
  }
}

function nodeButton(id, node) {
  const t = TYPES[node.type];
  return h("button", {
    type: "button",
    class: `node-btn t-${node.type}${id === selected && view === "story" ? " is-selected" : ""}`,
    onclick: () => select(id),
  },
    h("span", { class: "node-icon", "aria-hidden": "true" }, t.icon),
    h("span", { class: "node-text" },
      h("span", { class: "node-kind" }, t.name, id === story.start ? h("span", { class: "start-tag" }, "Start") : null),
      h("span", { class: "node-title" }, titleOf(node))));
}

const SIMPLE_LINKS = ["Then", "After the reaction", "After the break"];
const whenText = (link) => (SIMPLE_LINKS.includes(link.label) ? "next" : link.label.toLowerCase());

function addButton(fromId, link) {
  return h("button", { type: "button", class: "add-btn", onclick: () => openAddDialog(fromId, link) },
    `+ Add what happens ${whenText(link)}`);
}

function renderProblems() {
  const box = $("#problems");
  const probs = view === "story" ? findProblems() : [];
  box.hidden = !probs.length;
  if (!probs.length) return;
  box.innerHTML = "";
  box.append(
    h("p", {}, probs.length === 1 ? "1 thing to fix" : `${probs.length} things to fix`),
    h("ul", {}, probs.slice(0, 6).map((p) =>
      h("li", {}, h("button", { type: "button", onclick: () => select(p.id) }, p.text)))),
  );
}

function renderMovesList(body) {
  // Making a move comes first, so the teach option is never buried below the built-ins.
  body.append(
    h("button", { type: "button", class: "teach-cta", onclick: () => createTaughtMove() },
      h("strong", {}, "🎓 Teach a new move by example"),
      h("span", {}, "Best for fingers, the face and tricky moves, like a finger pointing at the forehead. Just show the camera a few times.")),
    h("button", { type: "button", class: "add-btn", style: "margin-top:8px", onclick: () => createMove() }, "✨ + Make a simple body pose from rules (no fingers)"),
    h("a", { class: "btn", href: "/camera-check", target: "_blank", rel: "noopener", style: "margin:8px 0 4px" }, "📷 Camera check: see what the camera can track"));

  const moves = customMoves();
  body.append(h("p", { class: "map-section" }, "Your moves"));
  const mine = h("ul", { class: "tree seq" });
  if (!moves.length) mine.append(h("li", { class: "help" }, "None yet. Teach one with the button above."));
  moves.forEach((m) => mine.append(h("li", {}, h("button", {
    type: "button", class: `node-btn t-action${m.id === selectedMove ? " is-selected" : ""}`,
    onclick: () => { selectedMove = m.id; stopTester(); renderMap(); renderPanel(); },
  }, h("span", { class: "node-icon", "aria-hidden": "true" }, m.type === "taught" ? "🎓" : "✨"),
     h("span", { class: "node-text" },
       h("span", { class: "node-kind" }, m.type === "taught" ? `Taught by example · ${(m.examples || []).length} examples` : "Made from rules (body only)"),
       h("span", { class: "node-title" }, m.name || "Untitled move"))))));
  body.append(mine);

  body.append(h("p", { class: "map-section" }, "Built-in moves"));
  const ul = h("ul", { class: "tree seq" });
  BUILTIN_MOVES.forEach((m) => ul.append(h("li", {}, h("button", {
    type: "button", class: `node-btn t-action${selectedMove === `builtin:${m.id}` ? " is-selected" : ""}`,
    onclick: () => { selectedMove = `builtin:${m.id}`; stopTester(); renderMap(); renderPanel(); },
  }, h("span", { class: "node-icon", "aria-hidden": "true" }, m.kind === "hold" ? "🙌" : "🔁"),
     h("span", { class: "node-text" }, h("span", { class: "node-kind" }, m.kind === "hold" ? "Hold it" : "Repeat it"), h("span", { class: "node-title" }, m.name))))));
  body.append(ul);
}

$("#search").addEventListener("input", (e) => {
  query = e.target.value.trim();
  if (view !== "story") { view = "story"; syncTabs(); renderPanel(); }
  renderMap();
});

// ---------------------------------------------------------------------------
// Adding parts
// ---------------------------------------------------------------------------
let pendingLink = null;

function openAddDialog(fromId, link) {
  pendingLink = link;
  const old = link.get();
  const oldNode = old && story.nodes[old];
  $("#addTitle").textContent = oldNode ? "Add a new part here" : `What happens ${whenText(link)}?`;
  $("#addNote").textContent = oldNode
    ? `The new part goes in between. Afterwards the story carries on to “${titleOf(oldNode)}”.`
    : "";
  const cards = $("#typeCards");
  cards.innerHTML = "";
  for (const [type, t] of Object.entries(TYPES)) {
    cards.append(h("button", {
      type: "button", class: `type-card t-${type}`,
      onclick: () => {
        const id = newId(type);
        const part = newPart(type);
        const oldTarget = pendingLink.get();
        if (oldTarget && story.nodes[oldTarget]) {
          const first = links(part)[0]; // new part leads on to where this path used to go
          if (first) first.set(oldTarget);
        }
        if (pendingDropPos) part.ui = pendingDropPos;
        pendingDropPos = null;
        story.nodes[id] = part;
        pendingLink.set(id);
        $("#addDialog").close();
        selected = id;
        changed({ form: true });
      },
    }, h("span", { class: "node-icon", "aria-hidden": "true" }, t.icon), h("strong", {}, t.name), h("span", { class: "help" }, t.desc)));
  }
  const sel = $("#connectSelect");
  sel.innerHTML = "";
  Object.entries(story.nodes)
    .filter(([id]) => id !== fromId)
    .forEach(([id, n]) => sel.append(h("option", { value: id }, `${TYPES[n.type].icon} ${titleOf(n)}`)));
  $("#connectRow").hidden = !sel.options.length;
  $("#addDialog").showModal();
}

$("#addDialog").addEventListener("close", () => { pendingDropPos = null; });
$("#connectBtn").addEventListener("click", () => {
  const id = $("#connectSelect").value;
  if (!id || !pendingLink) return;
  pendingLink.set(id);
  $("#addDialog").close();
  changed();
});

function select(id) {
  view = "story";
  selected = id;
  syncTabs();
  renderMap();
  renderPanel();
  stopTester();
}

// ---------------------------------------------------------------------------
// Right side: form for the selected part
// ---------------------------------------------------------------------------
function renderPanel() {
  const panel = $("#panel");
  stopTester(); // the form is being rebuilt, so its camera preview goes too
  panel.innerHTML = "";
  if (view === "moves") return renderMovePanel(panel);
  if (view === "settings") return renderSettings(panel);
  const node = story.nodes[selected];
  if (!node) {
    panel.append(h("p", { class: "empty" }, "Pick a part of the story on the left to change it."));
    return;
  }
  const t = TYPES[node.type];
  panel.append(
    h("div", { class: "panel-head" }, h("span", { class: "node-icon", "aria-hidden": "true" }, t.icon), h("h2", {}, t.name)),
    h("p", { class: "lead" }, t.desc),
  );
  const forms = { scene: sceneForm, choice: choiceForm, action: actionForm, open: openForm, pause: pauseForm, end: endForm };
  panel.append(...forms[node.type](node).filter(Boolean));
  const next = nextSection(selected, node);
  if (next) panel.append(next);
  panel.append(dangerZone(selected, node));
}

function sceneForm(node) {
  return [clipEditor("The scene", "What the audience sees.", node.clip, true)];
}

function pauseForm(node) {
  return [
    textField("Message on screen", "e.g. Short break!, or Get your props ready.", () => node.message, (v) => (node.message = v)),
    clipEditor("During the break", "Plays on repeat until the show carries on.", node.clip ??= clip("Short break")),
    rangeField("Carry on by itself after", "Leave at 0 to wait until the presenter presses Continue.", 0, 300,
      () => node.auto_sec || 0, (v) => (node.auto_sec = v), (v) => (v === 0 ? "Wait for presenter" : secs(v)), 5),
  ];
}

/** Where each path out of this part goes, with a way to slot a new part in between. */
function nextSection(id, node) {
  const ls = links(node);
  if (!ls.length) return null;
  const choices = [["", "Nothing yet"], ...Object.entries(story.nodes)
    .filter(([nid]) => nid !== id)
    .map(([nid, n]) => [nid, `${TYPES[n.type].icon} ${titleOf(n)}`])];
  return h("div", { class: "group" },
    h("h3", {}, "What happens next"),
    h("p", { class: "help" }, "Choose where each path goes. To put a new scene in between, press “Add a new part here”."),
    ls.map((l) => h("div", { class: "next-row" },
      h("span", { class: "next-label" }, l.label),
      miniSelect(`Where to go: ${l.label}`, choices, l.get() || "", (v) => { l.set(v || null); changed({ form: true }); }),
      h("button", { type: "button", class: "btn btn-small", onclick: () => openAddDialog(id, l) }, "Add a new part here"))));
}

/** Up/down buttons for reordering answers and groups. */
function orderButtons(arr, i, what) {
  const swap = (a, b) => { [arr[a], arr[b]] = [arr[b], arr[a]]; changed({ form: true }); };
  return [
    h("button", { type: "button", class: "btn btn-small", disabled: i === 0, "aria-label": `Move ${what} ${i + 1} up`, onclick: () => swap(i, i - 1) }, "↑"),
    h("button", { type: "button", class: "btn btn-small", disabled: i === arr.length - 1, "aria-label": `Move ${what} ${i + 1} down`, onclick: () => swap(i, i + 1) }, "↓"),
  ];
}

function endForm(node) {
  return [clipEditor("The final scene", "The last thing the audience sees.", node.clip, true)];
}

function choiceForm(node) {
  const opts = node.options;
  return [
    textField("The question", "Shown on screen and on the phones.", () => node.question, (v) => (node.question = v)),
    clipEditor("Actor asks the question", "The actor says the question out loud.", node.prompt),
    h("div", { class: "group" },
      h("h3", {}, "Answers"),
      h("p", { class: "help" }, `Up to ${MAX_OPTIONS} answers. Add the words children might shout for each one, in any language. The order here is the order on phones.`),
      opts.map((o, i) => h("div", { class: "item" },
        h("div", { class: "item-head" },
          h("label", { style: "flex:none" }, h("span", { class: "mini" }, "Emoji"),
            h("input", { class: "emoji-in", type: "text", value: o.emoji || "", maxlength: "8", "aria-label": `Emoji for answer ${i + 1}`,
              oninput: (e) => { o.emoji = e.target.value.trim(); changed(); } })),
          h("label", {}, h("span", { class: "mini" }, `Answer ${i + 1}`),
            h("input", { type: "text", value: o.label, oninput: (e) => { o.label = e.target.value; changed(); } })),
          orderButtons(opts, i, "answer"),
          h("button", { type: "button", class: "btn btn-small btn-danger", disabled: opts.length <= 2,
            title: opts.length <= 2 ? "A question needs at least 2 answers" : null,
            onclick: () => {
              opts.splice(i, 1);
              if (node.default === o.id) node.default = opts[0].id;
              changed({ form: true });
            } }, "Remove")),
        wordsField("Words that count as this answer", "Separate with commas, e.g. forest, trees, hutan, 森林", o))),
      opts.length < MAX_OPTIONS ? h("button", { type: "button", class: "btn add-item", onclick: () => {
        let n = opts.length + 1;
        while (opts.some((x) => x.id === `opt${n}`)) n++;
        opts.push({ id: `opt${n}`, label: "New answer", emoji: "", keywords: [], next: null });
        changed({ form: true });
      } }, "+ Add another answer") : null),
    answerRulesGroup(node),
    rangeField("How long to wait for answers", "Children can shout or vote during this time.", 5, 60, () => node.window_sec || 15, (v) => (node.window_sec = v), secs),
    clipEditor("While waiting", "Plays on repeat while answers come in.", node.idle),
    selectField("If nobody answers, go with", null, opts.map((o) => [o.id, `${o.emoji || ""} ${o.label}`.trim()]), () => node.default, (v) => (node.default = v)),
    clipEditor("If nobody answers", "The actor picks for them.", node.timeout_clip ??= clip("Nobody answered")),
  ];
}

function actionForm(node) {
  const moves = customMoves();
  const info = moveInfo(node.action, moves);
  const kindLabel = (m) => (m.kind === "hold" ? "hold it" : "repeat it");
  const choices = [
    ...BUILTIN_MOVES.map((m) => [m.id, `${m.name} (${kindLabel(m)})`]),
    ...moves.map((m) => [m.id, m.type === "taught"
      ? `🎓 ${m.name || "Untitled move"} (taught, ${m.motion ? "repeat it" : "hold it"})`
      : `✨ ${m.name || "Untitled move"} (hold it)`]),
    ["__teach", "🎓 + Teach a new move by example…"],
    ["__new", "✨ + Make a simple body pose from rules…"],
  ];
  return [
    textField("What the children are asked to do", "Shown on screen.", () => node.question, (v) => (node.question = v)),
    clipEditor("Actor asks for the move", null, node.prompt),
    selectField("Which move the camera watches for", info.desc || "Make your own in the Moves tab.", choices, () => node.action, (v) => {
      if (v === "__teach") { createTaughtMove(); return; }
      if (v === "__new") { createMove(); return; }
      node.action = v;
      delete node.reps;
      changed({ form: true });
    }),
    h("div", { class: "group" },
      h("h3", {}, "How it's judged"),
      info.kind === "hold"
        ? rangeField("How long they must hold it", null, 0.5, 5, () => node.hold_sec || 1, (v) => (node.hold_sec = v), secs, 0.5)
        : rangeField("How many times", `Counts each ${info.unit || "time"} separately.`, 1, 12, () => node.reps || info.reps || 1, (v) => (node.reps = v), (v) => `${v} time${v === 1 ? "" : "s"}`),
      selectField("How strict the camera is", "Relaxed suits young children and quick, loose movements. Strict avoids accidental passes.",
        Object.entries(STRICTNESS).map(([k, v]) => [k, v.label]), () => node.strictness || "normal", (v) => (node.strictness = v)),
      rangeField("Auditorium mode: share of children needed", `Each child the camera can see is judged separately. The move counts once this share of them have ${info.kind === "hold" ? "held it" : "done it"}.`,
        10, 100, () => Math.round((node.crowd_share ?? 0.5) * 100), (v) => (node.crowd_share = v / 100), (v) => `${v}%`, 5),
      rangeField("Auditorium mode: at least this many children", "So one keen child can't finish it for the whole room.",
        1, 10, () => node.min_people ?? 1, (v) => (node.min_people = v), (v) => `${v} ${v === 1 ? "child" : "children"}`),
      info.taught && (info.uses?.hands || info.uses?.face) && story.settings?.audience_mode === "auditorium"
        ? h("p", { class: "help warn-text" }, "⚠ This taught move uses fingers or the face. In Auditorium mode each child is checked, but fingers and faces are only clear within about 2–3 metres, so children further back may not be counted. Consider a lower share.")
        : null,
      h("p", { class: "help" }, "Test any move with your own camera in the Moves tab.")),
    rangeField("Time limit", "After this, the story carries on anyway.", 5, 60, () => node.timeout_sec || 20, (v) => (node.timeout_sec = v), secs),
    clipEditor("While waiting", "Plays on repeat until they do it.", node.idle),
  ];
}

/** Which kinds of answer this Question accepts, and how much each counts. */
function answerRulesGroup(node) {
  const inputs = inputsFor(node);
  const showW = { ...DEFAULT_WEIGHTS, ...(story.settings?.weights || {}) };
  const kinds = [
    ["voice", "🗣 Spoken answers", "Children shout an answer. Uses each answer's word list above."],
    ["poll", "📱 Phone votes", "Phones vote with the QR code or room code."],
    ["emoji", "😀 Emoji reactions", "Each answer's emoji counts as a small vote."],
    ["cheer", "📣 Cheer loudest", "After the waiting time, the room cheers for each answer in turn, and the loudest cheer wins. Great for big groups."],
    ["zone", "🚶 Stand to choose", "Children move to the left or right of the room (left, middle or right for 3 answers) and the camera counts them. Needs the camera; best in Auditorium mode."],
  ];
  const onCount = kinds.filter(([k]) => inputs[k]).length;
  return h("div", { class: "group" },
    h("h3", {}, "How children answer"),
    h("p", { class: "help" }, "Choose what counts for this question. A quiet moment might use phones only, and a big hall might use cheering."),
    kinds.map(([k, label, help]) => h("label", { class: "check-row check-row-help" },
      h("input", { type: "checkbox", checked: inputs[k], disabled: inputs[k] && onCount === 1, onchange: (e) => {
        node.inputs = { ...inputsFor(node), [k]: e.target.checked };
        changed({ form: true });
      } }),
      h("span", {}, label, h("span", { class: "help" }, help)))),
    inputs.cheer ? rangeField("Seconds of cheering for each answer", null, 2, 6, () => node.cheer_sec || 3, (v) => (node.cheer_sec = v), secs) : null,
    h("label", { class: "check-row" },
      h("input", { type: "checkbox", checked: Boolean(node.weights), onchange: (e) => {
        if (e.target.checked) node.weights = { ...showW };
        else delete node.weights;
        changed({ form: true });
      } }),
      " Give this question its own weights (otherwise the show's usual weights from Settings are used)"),
    node.weights ? kinds.filter(([k]) => inputs[k]).map(([k, label]) =>
      rangeField(label.replace(/^\S+ /, ""), null, 0, 10, () => Math.round((node.weights[k] ?? showW[k]) * 10),
        (v) => (node.weights[k] = v / 10), (v) => (v === 0 ? "Ignored" : `${v} / 10`))) : null);
}

function openForm(node) {
  const cats = node.categories;
  return [
    textField("The question", "Children can answer with anything they like.", () => node.question, (v) => (node.question = v)),
    clipEditor("Actor asks the question", null, node.prompt),
    rangeField("How long to listen", null, 5, 30, () => node.listen_sec || 12, (v) => (node.listen_sec = v), secs),
    clipEditor("While listening", "Plays on repeat until someone answers.", node.idle),
    captureGroup(node),
    h("div", { class: "group" },
      h("h3", {}, "Reactions"),
      h("p", { class: "help" }, `Group the answers you expect, and record a reaction for each group (up to ${MAX_REACTIONS}). The AI decides which group an answer belongs to.`),
      cats.map((c, i) => h("div", { class: "item" },
        h("div", { class: "item-head" },
          h("label", {}, h("span", { class: "mini" }, `Group ${i + 1} name`),
            h("input", { type: "text", value: c.name || c.id, oninput: (e) => { c.name = e.target.value; changed(); } })),
          orderButtons(cats, i, "group"),
          h("button", { type: "button", class: "btn btn-small btn-danger", onclick: () => { cats.splice(i, 1); changed({ form: true }); } }, "Remove")),
        textField("What kind of answers go here?", "Describe it in plain words. The AI reads this, e.g. “the name of an animal”.", () => c.description, (v) => (c.description = v), true),
        wordsField("Words that always count", "Optional. Separate with commas.", c),
        clipEditor("Reaction", null, c.reaction ??= clip("Reaction"))),
      ),
      cats.length < MAX_REACTIONS ? h("button", { type: "button", class: "btn add-item", onclick: () => {
        let n = cats.length + 1;
        while (cats.some((x) => x.id === `cat${n}`)) n++;
        cats.push({ id: `cat${n}`, name: "New group", description: "", keywords: [], reaction: clip("Reaction") });
        changed({ form: true });
      } }, "+ Add a group") : null),
    clipEditor("Reaction to anything else", "Plays when an answer doesn't fit any group, or nobody answers.", node.fallback_reaction ??= clip("What a great idea!")),
  ];
}

/** "Remember the name the children say" settings for a Say-anything part. */
function captureGroup(node) {
  const on = Boolean(node.capture);
  const box = h("input", { type: "checkbox", checked: on, onchange: (e) => {
    if (e.target.checked) node.capture = { save_as: suggestTag(node), fallback: "our friend" };
    else delete node.capture;
    changed({ form: true });
  } });
  return h("div", { class: "group" },
    h("h3", {}, "Remember a name"),
    h("label", { class: "check-row" }, box, " The children are shouting out a name. Pick it out and remember it."),
    on ? [
      textField("Name tag", "A short label for this name. Type it in curly brackets in any words on screen to show the name, e.g. {donkey name}.",
        () => node.capture.save_as, (v) => (node.capture.save_as = v.replace(/[{}]/g, "").trim() || "name")),
      textField("If no name is heard, use", "These words are shown instead, e.g. “our donkey”.",
        () => node.capture.fallback, (v) => (node.capture.fallback = v)),
      h("label", { class: "check-row" },
        h("input", { type: "checkbox", checked: node.capture.use_library !== false, onchange: (e) => {
          node.capture.use_library = e.target.checked;
          changed({ tree: false });
        } }),
        " Also recognise the names in the Studio's Name library"),
      textField("Names children often suggest (optional)",
        "Separate with commas. Helps the show spell these right even when they're misheard, e.g. “Boh boh” becomes Bobo. Other names still work.",
        () => (node.capture.expected || []).join(", "),
        (v) => (node.capture.expected = v.split(/[,，、]/).map((w) => w.trim()).filter(Boolean)), true),
      h("p", { class: "help" }, `Example: set a reaction's “Words shown on screen” to “Meet {${node.capture.save_as || "name"}}!”`),
    ] : null);
}

function suggestTag(node) {
  const m = (node.question || "").toLowerCase().match(/name (?:the|our|your|this)\s+([a-z]+)/);
  return m ? `${m[1]} name` : "name";
}

function dangerZone(id, node) {
  const isStart = id === story.start;
  return h("div", { class: "danger-zone" },
    h("button", { type: "button", class: "btn btn-primary", title: "Ctrl+Enter", onclick: () => tryFromHere(id) }, "▶ Try from here"),
    " ",
    isStart ? null : h("button", { type: "button", class: "btn", onclick: () => {
      story.start = id;
      changed({ form: true });
    } }, "Make this the start of the show"),
    " ",
    h("button", { type: "button", class: "btn", title: "Ctrl+D", onclick: () => duplicatePart(id) }, "Make a copy"),
    " ",
    h("button", { type: "button", class: "btn btn-danger", disabled: isStart,
      title: isStart ? "The first part can't be deleted. Make another part the start first." : "Delete",
      onclick: () => deletePart(id) }, "Delete this part"),
    h("p", { class: "help shortcut-hint" }, "Shortcuts: Ctrl+C copy · Ctrl+V paste · Ctrl+D copy here · Delete · Ctrl+Z undo · Ctrl+/ for all shortcuts"));
}

// ---------------------------------------------------------------------------
// Settings tab: things that apply to the whole show
// ---------------------------------------------------------------------------
function renderSettings(panel) {
  const st = (story.settings ??= {});
  st.weights ??= { poll: 0.5, voice: 0.4, emoji: 0.1 };
  st.weights.cheer ??= DEFAULT_WEIGHTS.cheer;
  st.weights.zone ??= DEFAULT_WEIGHTS.zone;
  const w = st.weights;
  const summary = h("p", { class: "help" });
  const updateSummary = () => {
    summary.textContent = "When a question uses more than one kind of answer, each counts in proportion to these numbers. A question can also set its own weights.";
  };
  updateSummary();
  const weight = (label, key) => rangeField(label, null, 0, 10, () => Math.round((w[key] ?? 0) * 10),
    (v) => { w[key] = v / 10; updateSummary(); }, (v) => (v === 0 ? "Ignored" : `${v} / 10`));

  panel.append(
    h("div", { class: "panel-head" }, h("span", { class: "node-icon", "aria-hidden": "true" }, "⚙️"), h("h2", {}, "Show settings")),
    h("p", { class: "lead" }, "These apply to the whole show."),
    homeGroup(st),
    h("div", { class: "group" },
      h("h3", {}, "Audience"),
      selectField("Who's watching", null, [
        ["single", "One child, or a few, in front of the laptop (Single child)"],
        ["auditorium", "A room full of children (Auditorium)"],
      ], () => st.audience_mode || "single", (v) => { st.audience_mode = v; setTimeout(renderPanel, 0); }),
      (st.audience_mode || "single") === "auditorium"
        ? rangeField("Children tracked at once", "Each one is followed and judged separately. More children needs a faster laptop; check the speed in Camera check.",
          2, 10, () => st.max_people || 6, (v) => (st.max_people = v), (v) => `${v} children`)
        : null,
      h("p", { class: "help" }, "Auditorium mode follows each child separately and decides as a group (for example “5 of 8 children did it”), and listens a little longer for names. If nobody can be picked out, it uses overall room movement. For big groups, “Cheer loudest” works well on questions. The operator can switch modes during the show.")),
    selectField("The show starts with", null,
      Object.entries(story.nodes).map(([id, n]) => [id, `${TYPES[n.type].icon} ${titleOf(n)}`]),
      () => story.start, (v) => (story.start = v)),
    selectField("Language the microphone listens for", "Children can still use words from other languages if you add them to an answer's word list.",
      LANGUAGES, () => st.speech_lang || "en-US", (v) => (st.speech_lang = v)),
    h("div", { class: "group" },
      h("h3", {}, "Names the children shout"),
      h("p", { class: "help" }, "Used by “Say anything” parts that remember a name. Names are only kept in memory during the show, never saved."),
      selectField("How to listen for names", null, [
        ["whisper", "Whisper on this laptop (more accurate, recommended)"],
        ["chrome", "Chrome's built-in listening only"],
      ], () => st.name_listening || "whisper", (v) => (st.name_listening = v)),
      whisperStatusLine(),
      selectField("Before a name appears on screen", null, [
        ["timed", "Give the operator a few seconds to check it (recommended)"],
        ["manual", "Always wait for the operator to approve it"],
        ["auto", "Show it straight away"],
      ], () => st.name_check || "timed", (v) => { st.name_check = v; changed({ form: true }); }),
      (st.name_check || "timed") === "timed"
        ? rangeField("Seconds to check", null, 2, 15, () => st.name_check_sec || 5, (v) => (st.name_check_sec = v), secs)
        : null,
      textField("Words that must never appear on screen", "Separate with commas. A list of common rude words in English, Malay and Mandarin is always blocked too.",
        () => (st.blocked_words || []).join(", "),
        (v) => (st.blocked_words = v.split(/[,，、]/).map((w) => w.trim()).filter(Boolean)), true)),
    h("div", { class: "group" },
      h("h3", {}, "How much each kind of answer counts"),
      h("p", { class: "help" }, "Used at Question parts. If a kind of answer isn't used at all, the others share its weight."),
      weight("Phone votes", "poll"),
      weight("Spoken answers", "voice"),
      weight("Emoji reactions", "emoji"),
      weight("Cheer loudest", "cheer"),
      weight("Stand to choose", "zone"),
      summary),
  );
}

const COVER_COLOURS = [["velvet", "Velvet red"], ["forest", "Forest green"], ["ocean", "Ocean blue"], ["sunset", "Sunset orange"], ["violet", "Violet"], ["gold", "Gold"]];

/** How this story appears on the audience home page. */
function homeGroup() {
  story.home ??= {};
  const home = story.home;
  const preview = h("div", { class: `home-preview c-${home.color || "velvet"}` },
    h("span", { class: "hp-emoji" }, home.emoji || "🎭"),
    h("span", { class: "hp-title" }, story.title || "Untitled show"),
    h("span", { class: "hp-blurb" }, home.blurb || ""));
  const refresh = () => {
    preview.className = `home-preview c-${home.color || "velvet"}`;
    preview.querySelector(".hp-emoji").textContent = home.emoji || "🎭";
    preview.querySelector(".hp-blurb").textContent = home.blurb || "";
  };
  return h("div", { class: "group" },
    h("h3", {}, "Audience home page"),
    h("label", { class: "check-row" },
      h("input", { type: "checkbox", checked: Boolean(home.published), onchange: (e) => { home.published = e.target.checked; changed({ tree: false }); } }),
      " Show this story on the audience home page"),
    h("div", { class: "home-edit" },
      h("div", { class: "home-fields" },
        textField("Short description for the audience", "One or two sentences children can understand, e.g. “Help Puck find the magic flower!”",
          () => home.blurb, (v) => { home.blurb = v; refresh(); }, true),
        h("div", { class: "field-row" },
          h("label", { class: "field" }, h("span", {}, "Picture"),
            h("input", { type: "text", class: "emoji-big", maxlength: "8", value: home.emoji || "🎭",
              oninput: (e) => { home.emoji = e.target.value.trim(); refresh(); changed({ tree: false }); } })),
          selectField("Colour", null, COVER_COLOURS, () => home.color || "velvet", (v) => { home.color = v; refresh(); }))),
      h("div", {}, h("span", { class: "help" }, "Preview"), preview)));
}

/** Shows whether Whisper is installed and ready, fetched live from the server. */
function whisperStatusLine() {
  const p = h("p", { class: "help" }, "Checking Whisper…");
  fetch("/api/info").then((r) => r.json()).then(({ whisper: w }) => {
    p.textContent = !w ? "Couldn't check Whisper."
      : !w.enabled ? "Whisper is turned off (WHISPER=off in the .env file). Chrome's listening will be used."
      : !w.installed ? "Whisper isn't installed yet. Run setup again (it needs internet once)."
      : w.state === "failed" ? `Whisper couldn't load, so Chrome's listening will be used. Run setup again while online. (${w.error})`
      : w.ready ? `Whisper is ready (${w.model} model). The children's voices stay on this laptop.`
      : `Whisper (${w.model} model) is loading. This takes a moment after the server starts.`;
  }).catch(() => (p.textContent = "Couldn't check Whisper."));
  return p;
}

// ---------------------------------------------------------------------------
// Moves tab: build your own camera moves
// ---------------------------------------------------------------------------
function createTaughtMove() {
  const moves = customMoves();
  let n = moves.length + 1;
  while (moves.some((m) => m.id === `move_${n}`)) n++;
  const move = {
    id: `move_${n}`, name: "New move", type: "taught", motion: false, window_sec: 1.5, either_hand: true,
    uses: { body: true, hands: true, face: true }, examples: [], negatives: [], calibration: null,
  };
  moves.push(move);
  const node = story.nodes[selected];
  if (view === "story" && node?.type === "action") node.action = move.id;
  view = "moves";
  selectedMove = move.id;
  syncTabs();
  changed({ form: true });
}

function createMove() {
  const moves = customMoves();
  let n = moves.length + 1;
  while (moves.some((m) => m.id === `move_${n}`)) n++;
  const move = { id: `move_${n}`, name: "New move", conditions: [{ part: "right_hand", relation: "near", target: "head" }] };
  moves.push(move);
  // If we came from a Move part, use the new move there straight away.
  const node = story.nodes[selected];
  if (view === "story" && node?.type === "action") node.action = move.id;
  view = "moves";
  selectedMove = move.id;
  syncTabs();
  changed({ form: true });
}

/** Settings for the "Try it" box (not saved with the story). */
const testOpts = { strictness: "normal", mode: "single" };

function testerGroup(moveId) {
  const info = moveInfo(moveId, customMoves());
  const opts = () => ({ ...testOpts, holdSec: 1, reps: info.reps || 1 });
  const restart = () => { if (tester) startTester(moveId, opts); };
  return h("div", { class: "group" },
    h("h3", {}, "Try it"),
    h("p", { class: "help" }, info.kind === "hold"
      ? "Stand where the camera can see you and hold the pose for a second."
      : `Stand where the camera can see you and do it ${info.reps || 1} time${(info.reps || 1) === 1 ? "" : "s"}.`),
    h("div", { class: "field-row tester-opts" },
      h("label", { class: "field" }, h("span", {}, "Strictness"),
        miniSelect("Strictness", Object.entries(STRICTNESS).map(([k, v]) => [k, v.label.split(" (")[0]]), testOpts.strictness, (v) => { testOpts.strictness = v; restart(); })),
      h("label", { class: "field" }, h("span", {}, "Mode"),
        miniSelect("Mode", [["single", "Single child"], ["auditorium", "Auditorium"]], testOpts.mode, (v) => { testOpts.mode = v; restart(); }))),
    h("div", { class: "tester" },
      h("div", { class: "tester-cam" }, h("video", { id: "testVideo", playsinline: true, muted: true }), h("canvas", { id: "testCanvas" })),
      h("div", { class: "tester-side" },
        h("p", { id: "testResult", class: "tester-result", "aria-live": "polite" }, "Camera is off"),
        h("div", { class: "progress-bar" }, h("span", { id: "testBar" })),
        h("p", { id: "testDetail", class: "help" }),
        h("button", { type: "button", class: "btn", id: "testBtn", onclick: () => startTester(moveId, opts) }, "Turn on camera"))));
}

function renderMovePanel(panel) {
  if (selectedMove?.startsWith("builtin:")) {
    const info = moveInfo(selectedMove.slice(8));
    panel.append(
      h("div", { class: "panel-head" }, h("span", { class: "node-icon", "aria-hidden": "true" }, info.kind === "hold" ? "🙌" : "🔁"), h("h2", {}, info.name)),
      h("p", { class: "lead" }, `${info.desc} ${info.kind === "hold" ? "A pose to hold." : `A movement to repeat (${info.reps} by default).`}`),
      h("p", { class: "help" }, "Built-in moves can't be changed, but each Move part sets its own hold time, number of times and strictness."),
      testerGroup(info.id));
    return;
  }
  const move = customMoves().find((m) => m.id === selectedMove);
  if (!move) {
    panel.append(h("p", { class: "empty" }, "Pick one of your moves on the left, or make a new one."));
    return;
  }
  if (move.type === "taught") return renderTaughtPanel(panel, move);
  panel.append(h("div", { class: "rules-note" },
    h("p", {}, h("strong", {}, "Rules can only see the body: "), "head, shoulders, elbows, wrists, hips, knees and feet. They can't see fingers or the face, so a finger pointing at the forehead needs teaching by example."),
    h("button", { type: "button", class: "btn btn-primary", onclick: () => {
      if (!confirm(`Turn “${move.name}” into a taught move? Its rules will be replaced by examples you record.`)) return;
      move.type = "taught";
      move.motion = false;
      move.window_sec = 1.5;
      move.either_hand = true;
      move.uses = { body: true, hands: true, face: true };
      move.examples = [];
      move.negatives = [];
      move.calibration = null;
      delete move.conditions;
      changed({ form: true });
    } }, "🎓 Teach this move by example instead")));
  const partOpts = BODY_PARTS.map((p) => [p.id, p.label]);
  panel.append(
    h("div", { class: "panel-head" }, h("span", { class: "node-icon", "aria-hidden": "true" }, "✨"), h("h2", {}, "Your move")),
    h("p", { class: "lead" }, "Describe the pose in simple rules. The move counts when all the rules are true at the same time."),
    textField("Name of the move", "e.g. Touch your head, Hands on hips.", () => move.name, (v) => (move.name = v)),
    h("div", { class: "group" },
      h("h3", {}, "Rules"),
      h("p", { class: "help" }, "Left and right mean the child's own left and right."),
      move.conditions.map((c, i) => h("div", { class: "rule" },
        miniSelect(`Rule ${i + 1} body part`, partOpts, c.part, (v) => { c.part = v; changed(); }),
        miniSelect(`Rule ${i + 1} position`, RELATIONS.map((r) => [r.id, r.label]), c.relation, (v) => { c.relation = v; changed(); }),
        miniSelect(`Rule ${i + 1} other body part`, partOpts, c.target, (v) => { c.target = v; changed(); }),
        h("button", { type: "button", class: "btn btn-small btn-danger", disabled: move.conditions.length <= 1,
          onclick: () => { move.conditions.splice(i, 1); changed({ form: true }); } }, "Remove"))),
      h("button", { type: "button", class: "btn add-item", onclick: () => {
        move.conditions.push({ part: "left_hand", relation: "above", target: "head" });
        changed({ form: true });
      } }, "+ Add a rule")),
    testerGroup(move.id),
    h("div", { class: "danger-zone" }, h("button", { type: "button", class: "btn btn-danger", onclick: () => {
      const users = Object.values(story.nodes).filter((n) => n.type === "action" && n.action === move.id);
      const warn = users.length ? ` ${users.length} Move part(s) use it and will switch to “Both hands up”.` : "";
      if (!confirm(`Delete the move “${move.name}”?${warn}`)) return;
      users.forEach((n) => (n.action = "hands_up"));
      story.settings.custom_actions = customMoves().filter((m) => m.id !== move.id);
      selectedMove = null;
      stopTester();
      changed({ form: true });
    } }, "Delete this move")),
  );
}

// ---------------------------------------------------------------------------
// Teach a move by example
// ---------------------------------------------------------------------------
function renderTaughtPanel(panel, move) {
  move.examples ??= [];
  move.negatives ??= [];
  move.uses ??= { body: true, hands: true, face: true };
  const hasExamples = move.examples.length + move.negatives.length > 0;
  const setKind = (motion) => {
    if (Boolean(move.motion) === motion) return;
    if (hasExamples && !confirm("Changing the kind of move clears the examples recorded so far. Carry on?")) { renderPanel(); return; }
    move.motion = motion;
    move.examples = [];
    move.negatives = [];
    move.calibration = null;
    changed({ form: true });
  };
  const useBox = (key, label, help) => h("label", { class: "check-row check-row-help" },
    h("input", { type: "checkbox", checked: Boolean(move.uses[key]), onchange: (e) => {
      move.uses = { ...move.uses, [key]: e.target.checked };
      if (!move.uses.body && !move.uses.hands) move.uses.body = true;
      move.calibration = calibrate(move);
      changed({ form: true });
    } }), h("span", {}, label, h("span", { class: "help" }, help)));

  const auditorium = story.settings?.audience_mode === "auditorium";
  panel.append(
    h("div", { class: "panel-head" }, h("span", { class: "node-icon", "aria-hidden": "true" }, "🎓"), h("h2", {}, "Taught move")),
    h("p", { class: "lead" }, "Show the camera what the move looks like a few times, and it learns to recognise it. No rules to write."),
    textField("Name of the move", "e.g. Finger on forehead, Magic wand swirl, Shh finger on lips.", () => move.name, (v) => (move.name = v)),
    h("div", { class: "group" },
      h("h3", {}, "What kind of move?"),
      h("div", { class: "choice-cards" },
        h("button", { type: "button", class: `choice-card${move.motion ? "" : " is-on"}`, onclick: () => setKind(false) },
          h("strong", {}, "🧍 A pose to hold"), h("span", { class: "help" }, "Finger on forehead, hands on hips, shh finger on lips…")),
        h("button", { type: "button", class: `choice-card${move.motion ? " is-on" : ""}`, onclick: () => setKind(true) },
          h("strong", {}, "👋 A movement"), h("span", { class: "help" }, "Waving, a magic-wand swirl, a bow…"))),
      move.motion ? rangeField("How long one movement takes", "Record each example at about this speed. Faster or slower still matches.",
        0.8, 3, () => move.window_sec || 1.5, (v) => { move.window_sec = v; }, (v) => `${v} seconds`, 0.1) : null),
    h("div", { class: "group" },
      h("h3", {}, "What the camera looks at"),
      useBox("body", "🧍 Body", "Arms, head and shoulders."),
      useBox("hands", "✋ Hands and fingers", "Every finger joint. Needed for pointing, finger shapes and hand signs."),
      useBox("face", "🙂 Face", "Forehead, nose, mouth and chin, so the camera knows where fingers touch the face."),
      h("label", { class: "check-row" },
        h("input", { type: "checkbox", checked: move.either_hand !== false, onchange: (e) => { move.either_hand = e.target.checked; changed({ tree: false }); } }),
        " Either hand works (record with one hand; the other hand counts too)"),
      (move.uses.hands || move.uses.face)
        ? h("p", { class: `help${auditorium ? " warn-text" : ""}` }, auditorium
          ? "⚠ This show is set to Auditorium mode. Fingers and faces are too small to see from across a hall: this move will follow the child nearest the camera. For a whole room, use a body move instead."
          : "Fingers and faces work best within about 2–3 metres of the camera, in good light.")
        : null,
      hasExamples ? h("p", { class: "help" }, "If you change these after recording, record the examples again for the best results.") : null),
    h("div", { class: "group" },
      h("h3", {}, "Examples"),
      h("p", { class: "help" }, move.motion
        ? "Press record, wait for “Go!”, then do the movement once. Repeat 5 or more times, varying it a little (a bit faster, bigger, other hand). Children make the best examples."
        : "Press record, wait for “Go!”, then hold the pose for 2 seconds while moving slightly. Repeat 5 or more times from slightly different spots. Children make the best examples."),
      h("div", { class: "tester" },
        h("div", { class: "tester-cam" },
          h("video", { id: "testVideo", playsinline: true, muted: true }), h("canvas", { id: "testCanvas" }),
          h("div", { id: "teachOverlay", class: "teach-overlay", hidden: true })),
        h("div", { class: "tester-side" },
          h("button", { type: "button", class: "btn", id: "teachCamBtn", onclick: () => startTeachCamera(move) }, "Turn on camera"),
          h("div", { class: "teach-buttons" },
            h("button", { type: "button", class: "btn btn-primary", onclick: () => recordTake(move, false) }, "● Record the move"),
            h("button", { type: "button", class: "btn", onclick: () => recordTake(move, true) }, "● Record “not this”")),
          h("p", { class: "help" }, "“Not this” examples are things that look similar but shouldn't count, like scratching your head or pointing at your nose."),
          h("p", { id: "teachStatus", class: "teach-status", "aria-live": "polite" }))),
      h("div", { id: "teachInfo" })),
    h("div", { class: "group" },
      h("h3", {}, "Try it"),
      h("p", { class: "help" }, "Once there are 3 or more examples, do the move and watch the match."),
      h("div", { class: "field-row tester-opts" },
        h("label", { class: "field" }, h("span", {}, "Strictness"),
          miniSelect("Strictness", Object.entries(STRICTNESS).map(([k, v]) => [k, v.label.split(" (")[0]]), testOpts.strictness, (v) => { testOpts.strictness = v; rewatch(move); }))),
      h("p", { id: "testResult", class: "tester-result", "aria-live": "polite" }, "Camera is off"),
      h("div", { class: "progress-bar" }, h("span", { id: "testBar" })),
      h("p", { id: "testDetail", class: "help" })),
    h("div", { class: "danger-zone" }, h("button", { type: "button", class: "btn btn-danger", onclick: () => deleteCustomMove(move) }, "Delete this move")),
  );
  updateTeachInfo(move);
}

/** The example lists and the reliability check, updated in place (the camera keeps running). */
function updateTeachInfo(move) {
  const box = $("#teachInfo");
  if (!box) return;
  const cal = move.calibration || calibrate(move);
  const list = (takes, neg) => h("div", { class: "takes" },
    h("span", { class: "takes-label" }, neg ? `Not this: ${takes.length}` : `The move: ${takes.length}`),
    takes.map((_, i) => h("span", { class: `take${neg ? " is-neg" : ""}` }, `${i + 1}`,
      h("button", { type: "button", "aria-label": `Delete ${neg ? "not-this " : ""}example ${i + 1}`, onclick: () => {
        takes.splice(i, 1);
        move.calibration = calibrate(move);
        changed({ tree: true });
        updateTeachInfo(move);
        rewatch(move);
      } }, "✕"))));
  box.innerHTML = "";
  box.append(
    list(move.examples, false),
    list(move.negatives, true),
    h("p", { class: `quality q-${cal.quality}` },
      { good: "✓ ", ok: "◐ ", few: "○ ", none: "○ " }[cal.quality] || "", cal.message));
}

function deleteCustomMove(move) {
  const users = Object.values(story.nodes).filter((n) => n.type === "action" && n.action === move.id);
  const warn = users.length ? ` ${users.length} Move part(s) use it and will switch to “Both hands up”.` : "";
  if (!confirm(`Delete the move “${move.name}”?${warn}`)) return;
  users.forEach((n) => (n.action = "hands_up"));
  story.settings.custom_actions = customMoves().filter((m) => m.id !== move.id);
  selectedMove = null;
  stopTester();
  changed({ form: true });
}

async function startTeachCamera(move) {
  stopTester();
  const status = $("#teachStatus");
  const t = new PoseDetector($("#testVideo"), $("#testCanvas"), {
    onStatus: (st) => {
      if (!$("#teachStatus")) return;
      if (st === "loading") status.textContent = "Starting the camera and hand/face tracking…";
      if (st === "watching" && (!status.textContent || status.textContent.startsWith("Starting"))) status.textContent = "Camera ready.";
      if (st === "blocked") status.textContent = "Camera was blocked. Allow it in the browser's address bar.";
      if (st === "error") status.textContent = `Camera couldn't start: ${t.info.lastError || "unknown problem"}. Try 📷 Camera check.`;
      if (st === "detail-failed") status.textContent = `${t.info.lastError}. Check the internet connection and try again, or open 📷 Camera check.`;
    },
  });
  tester = t;
  t.keepDetail = true; // keep hand/face tracking on while teaching
  t.setCustomMoves(customMoves());
  await t.start();
  if (tester !== t) return t.stop();
  await t.setDetail(move.uses);
  $("#teachCamBtn")?.remove();
  rewatch(move);
  let doneAt = null;
  const loop = () => {
    if (tester !== t || !t.running) return;
    const el = $("#testResult");
    if (!el) return stopTester();
    const cal = move.calibration || calibrate(move);
    if (!cal.threshold) {
      el.textContent = "Record at least 3 examples to start testing";
      el.classList.remove("is-yes");
      $("#testBar").style.width = "0%";
      $("#testDetail").textContent = "";
    } else {
      const p = t.progress();
      const done = p.value >= 1;
      el.textContent = done ? "Yes! That counts" : p.doingNow ? "Keep going…" : "Not yet";
      el.classList.toggle("is-yes", done);
      $("#testBar").style.width = `${Math.round((move.motion ? p.value : Math.max(p.value, (p.similarity || 0) * 0.6)) * 100)}%`;
      $("#testDetail").textContent = p.label || "";
      if (done) { doneAt ??= performance.now(); if (performance.now() - doneAt > 1500) { doneAt = null; rewatch(move); } }
    }
    requestAnimationFrame(loop);
  };
  loop();
}

function rewatch(move) {
  if (!tester?.running) return;
  tester.setCustomMoves(customMoves());
  tester.watch(move.id, { strictness: testOpts.strictness, holdSec: 1, reps: 1 });
}

/** Is there enough of the person in view for this move? */
function usable(f, uses) {
  if (!f) return false;
  if (uses.hands && !f.hands[0] && !f.hands[1]) return false;
  if (uses.hands && uses.face && !f.touch[0] && !f.touch[1]) return false;
  if (uses.body && !uses.hands && !f.body) return false;
  return true;
}

let recording = false;
async function recordTake(move, negative) {
  const status = $("#teachStatus");
  if (!tester?.running) { status.textContent = "Turn on the camera first."; return; }
  if (recording) return;
  recording = true;
  const overlay = $("#teachOverlay");
  const say = (text) => { overlay.hidden = !text; overlay.textContent = text || ""; };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    for (const n of [3, 2, 1]) { say(`${negative ? "Not this" : "Get ready"}… ${n}`); await wait(800); }
    say("Go!");
    let take = null;
    if (!move.motion) {
      const frames = [];
      for (let i = 0; i < 10; i++) {
        await wait(200);
        const f = tester.currentFeatures();
        if (usable(f, move.uses)) frames.push(f);
      }
      if (frames.length >= 5) take = { frames };
    } else {
      const ms = (move.window_sec || 1.5) * 1000;
      const buf = [];
      const start = performance.now();
      while (performance.now() - start < ms + 100) {
        await new Promise((r) => requestAnimationFrame(r));
        const f = tester.currentFeatures();
        if (usable(f, move.uses)) buf.push({ t: performance.now(), f });
      }
      const seq = resample(buf, ms, 12);
      if (seq.length === 12 && buf.length >= 10) take = { frames: seq };
    }
    say("");
    if (!take) {
      status.textContent = move.uses.hands
        ? "Couldn't see clearly. Make sure the hands" + (move.uses.face ? " and face are" : " are") + " in view, with good light, then try again."
        : "Couldn't see clearly. Step into view and try again.";
      return;
    }
    (negative ? move.negatives : move.examples).push(take);
    move.calibration = calibrate(move);
    status.textContent = negative ? "Saved a “not this” example." : "Saved an example of the move.";
    changed({ tree: true });
    updateTeachInfo(move);
    rewatch(move);
  } finally {
    say("");
    recording = false;
  }
}

async function startTester(moveId, getOpts) {
  stopTester();
  const result = $("#testResult");
  const t = new PoseDetector($("#testVideo"), $("#testCanvas"), {
    onStatus: (st) => {
      if (st === "loading") result.textContent = "Starting camera…";
      if (st === "blocked") result.textContent = "Camera was blocked. Allow it in the browser's address bar.";
      if (st === "error") result.textContent = "Camera couldn't start.";
    },
  });
  tester = t;
  t.setCustomMoves(customMoves());
  await t.setMode(getOpts().mode);
  await t.start();
  if (tester !== t) return t.stop();
  $("#testBtn")?.remove();
  t.watch(moveId, getOpts());
  let doneAt = null;
  const loop = () => {
    if (tester !== t || !t.running) return;
    const el = $("#testResult");
    if (!el) return stopTester();
    t.setCustomMoves(customMoves()); // pick up rule changes live
    const p = t.progress();
    const done = p.value >= 1;
    el.textContent = !t.state.person && t.mode === "single" ? "Can't see anyone" : done ? "Yes! That counts" : p.doingNow ? "Keep going…" : "Not yet";
    el.classList.toggle("is-yes", done);
    $("#testBar").style.width = `${Math.round(p.value * 100)}%`;
    $("#testDetail").textContent = [p.label, t.mode === "auditorium" ? `${p.people} people seen` : ""].filter(Boolean).join(" · ");
    if (done) { doneAt ??= performance.now(); if (performance.now() - doneAt > 1500) { doneAt = null; t.watch(moveId, getOpts()); } }
    requestAnimationFrame(loop);
  };
  loop();
}

function stopTester() {
  if (tester) { tester.stop(); tester = null; }
}

// ---------------------------------------------------------------------------
// Form field builders
// ---------------------------------------------------------------------------
const secs = (v) => `${v} second${v === 1 ? "" : "s"}`;

function textField(label, help, get, set, multiline = false) {
  const input = multiline
    ? h("textarea", { oninput: (e) => { set(e.target.value); changed(); } })
    : h("input", { type: "text", oninput: (e) => { set(e.target.value); changed(); } });
  input.value = get() || "";
  return h("label", { class: "field" }, h("span", {}, label), help ? h("span", { class: "help" }, help) : null, input);
}

function wordsField(label, help, obj) {
  return textField(label, help, () => (obj.keywords || []).join(", "), (v) => {
    obj.keywords = v.split(/[,，、]/).map((w) => w.trim()).filter(Boolean);
  });
}

function rangeField(label, help, min, max, get, set, fmt, step = 1) {
  const out = h("output", {}, fmt(get()));
  const input = h("input", { type: "range", min, max, step, value: get(), "aria-label": label,
    oninput: (e) => { const v = Number(e.target.value); set(v); out.textContent = fmt(v); changed({ tree: false }); } });
  return h("div", { class: "field" }, h("span", {}, label), help ? h("span", { class: "help" }, help) : null, h("div", { class: "range-row" }, input, out));
}

function selectField(label, help, options, get, set) {
  const sel = h("select", { onchange: (e) => { set(e.target.value); changed(); } },
    options.map(([v, text]) => h("option", { value: v, selected: v === get() }, text)));
  return h("label", { class: "field" }, h("span", {}, label), help ? h("span", { class: "help" }, help) : null, sel);
}

function miniSelect(ariaLabel, options, value, onChange) {
  return h("select", { "aria-label": ariaLabel, onchange: (e) => onChange(e.target.value) },
    options.map(([v, text]) => h("option", { value: v, selected: v === value }, text)));
}

/** Clip sections the user has opened stay open when the form redraws. */
const openClips = new WeakSet();

/** Read a video's real length from the file, so nobody has to set it by hand. */
function videoDuration(file) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    const done = (d) => { v.removeAttribute("src"); v.load(); resolve(d); };
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : null);
    v.onerror = () => done(null);
    setTimeout(() => done(null), 8000);
    v.src = `/media/${encodeURIComponent(story._project)}/${encodeURIComponent(file)}`;
  });
}

async function readLength(c) {
  if (!c.file) { delete c.from_video; return; }
  const d = await videoDuration(c.file);
  if (d) {
    c.duration = Math.round(d * 10) / 10;
    c.from_video = true;
    setStatus(`Video length: ${c.duration} seconds`);
  } else {
    delete c.from_video;
  }
}

/** Collapsible editor for one video clip: title, actor's line, length, video file. */
function clipEditor(name, help, c, open = false) {
  const sum = h("span", { class: "clip-sum" }, c.title || "");
  const fileSel = h("select", { "aria-label": `Video for ${name}`, onchange: async (e) => {
      c.file = e.target.value;
      await readLength(c);
      changed({ tree: false, form: true });
    } },
    h("option", { value: "" }, "No video yet (show a placeholder card)"),
    videos.map((v) => h("option", { value: v, selected: v === c.file }, v)),
    c.file && !videos.includes(c.file) ? h("option", { value: c.file, selected: true }, `${c.file} (not uploaded yet)`) : null);
  const upload = h("input", { type: "file", accept: "video/*", hidden: true, onchange: async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    setStatus(`Uploading ${f.name}…`);
    const fd = new FormData();
    fd.append("file", f);
    try {
      const res = await (await fetch("/api/videos", { method: "POST", body: fd })).json();
      if (!res.ok) throw new Error(res.reason);
      videos = await (await fetch("/api/videos")).json();
      c.file = res.file;
      await readLength(c);
      changed({ tree: false, form: true });
    } catch (err) {
      setStatus(`Upload failed: ${err.message}`, true);
    }
  } });

  if (open) openClips.add(c);
  return h("details", { class: "clip", open: openClips.has(c),
    ontoggle: (e) => { if (e.target.open) openClips.add(c); else openClips.delete(c); } },
    h("summary", {}, h("span", { class: "clip-name" }, name), sum),
    h("div", { class: "clip-body" },
      help ? h("p", { class: "help" }, help) : null,
      textField("Scene title", "A short name, shown on the placeholder card.", () => c.title, (v) => { c.title = v; sum.textContent = v; }),
      textField("Who says it", "The actor or character, e.g. Puck. Used to sort the filming script by actor.", () => c.who, (v) => (c.who = v)),
      textField("What the actor says", "Doubles as the script when you film it.", () => c.line, (v) => (c.line = v), true),
      textField("Words shown on screen (optional)",
        nameTags().length
          ? `Shown over the video like a subtitle. Add a name the children chose with ${nameTags().map((t) => `{${t}}`).join(", ")}.`
          : "Shown over the video like a subtitle.",
        () => c.caption, (v) => (c.caption = v)),
      c.file && c.from_video
        ? h("div", { class: "field" }, h("span", {}, "Length"), h("p", { class: "locked" }, `${c.duration} seconds, read from the video`))
        : rangeField("Length (until a video is added)", "Set automatically when you choose or upload a video.", 2, 30, () => c.duration || 5, (v) => (c.duration = v), secs),
      h("div", { class: "field" }, h("span", {}, "Video"),
        h("div", { class: "video-row" }, fileSel,
          h("button", { type: "button", class: "btn", onclick: () => upload.click() }, "Upload video"), upload))));
}

// ---------------------------------------------------------------------------
// Tabs, versions, start-up
// ---------------------------------------------------------------------------
function syncTabs() {
  $("#tabStory").setAttribute("aria-selected", String(view === "story"));
  $("#tabMoves").setAttribute("aria-selected", String(view === "moves"));
  $("#tabSettings").setAttribute("aria-selected", String(view === "settings"));
}
$("#tabStory").addEventListener("click", () => { view = "story"; stopTester(); syncTabs(); renderMap(); renderPanel(); });
$("#tabMoves").addEventListener("click", () => { view = "moves"; syncTabs(); renderMap(); renderPanel(); });
$("#tabSettings").addEventListener("click", () => { view = "settings"; stopTester(); syncTabs(); renderMap(); renderPanel(); });
$("#styleList").addEventListener("click", () => setMapStyle("list"));
$("#styleCanvas").addEventListener("click", () => setMapStyle("canvas"));

$("#storyTitle").addEventListener("input", (e) => { story.title = e.target.value; changed({ tree: false }); });

$("#versionsBtn").addEventListener("click", async () => {
  const list = $("#versionsList");
  list.innerHTML = "";
  const items = await (await fetch("/api/backups")).json();
  if (!items.length) list.append(h("li", {}, "No earlier versions yet. They appear after a few minutes of editing."));
  items.forEach((b) => list.append(h("li", {}, h("span", {}, b.named ? `★ ${b.label}` : b.label),
    h("button", { type: "button", class: "btn btn-small", onclick: async () => {
      if (!confirm(`Bring back the version from ${b.label}?`)) return;
      clearTimeout(saveTimer);
      const res = await (await fetch("/api/backups/restore", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: b.name }),
      })).json();
      if (!res.ok) { alert(res.reason); return; }
      closeGroup();
      undoStack.push(JSON.stringify(story));
      redoStack = [];
      story = res.story;
      baseline = JSON.stringify(story);
      syncUndo();
      unsaved = false;
      selected = story.start;
      $("#storyTitle").value = story.title || "";
      $("#versionsDialog").close();
      setStatus(`Brought back the version from ${b.label}`);
      renderMap();
      renderPanel();
    } }, "Bring back"))));
  $("#versionsDialog").showModal();
});

// ---------------------------------------------------------------------------
// Project menu: versions, download, back to the Studio
// ---------------------------------------------------------------------------
async function post(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  return res.json();
}

$("#saveVersionBtn").addEventListener("click", async () => {
  $(".menu").open = false;
  const label = prompt("Name this version, so you can find it later:", "Before rehearsal");
  if (label === null) return;
  await flushSave();
  const res = await post(`/api/projects/${story._project}/version`, { label });
  setStatus(res.ok ? `Saved a version called “${label || "Saved version"}”` : "Couldn't save a version", !res.ok);
});
$("#scriptBtn").addEventListener("click", async () => {
  $(".menu").open = false;
  await flushSave();
  window.open(`/script?show=${encodeURIComponent(story._project)}`, "_blank");
});
$("#exportBtn").addEventListener("click", async () => {
  $(".menu").open = false;
  await flushSave();
  location.href = `/api/projects/${story._project}/export`;
});
$("#studioBtn").addEventListener("click", async () => {
  $(".menu").open = false;
  await flushSave();
  location.href = "/studio";
});
$("#versionsBtn").addEventListener("click", () => { $(".menu").open = false; });
$("#keysBtn").addEventListener("click", () => { $(".menu").open = false; $("#keysDialog").showModal(); });

async function init() {
  const res = await fetch("/api/story", { cache: "no-store" }).catch(() => null);
  if (!res) {
    document.body.prepend(h("p", { class: "problems" }, "Can't reach the server. Start it with run.bat or run.sh, then refresh this page."));
    return;
  }
  if (res.status === 409) { location.href = "/studio"; return; } // no show open: pick one in the Studio
  story = await res.json();
  $("#playLink").href = `/play?show=${encodeURIComponent(story._project)}`;
  videos = await (await fetch("/api/videos")).json();
  baseline = JSON.stringify(story);
  $("#editorBar").hidden = false;
  $("#workspace").hidden = false;
  selected = story.start;
  $("#storyTitle").value = story.title || "";
  setStatus("All changes saved");
  renderMap();
  renderPanel();
}
init();
