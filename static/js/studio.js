// Studio: the team's home page. Shows (projects) and the name library.

const $ = (s) => document.querySelector(s);

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "checked" || k === "disabled") el[k] = Boolean(v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function post(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  return res.json();
}

function say(text) {
  $("#status").textContent = text;
}

// ---------------------------------------------------------------------------
// Shows
// ---------------------------------------------------------------------------
async function loadShows() {
  const res = await fetch("/api/projects");
  if (res.status === 403) { say("The Studio only works on the show laptop."); return; }
  const { current, projects } = await res.json();
  const list = $("#showList");
  list.innerHTML = "";
  if (!projects.length) list.append(h("li", { class: "help" }, "No shows yet. Make a new one, or upload a show file a teammate sent you."));
  for (const p of projects) {
    const toggle = h("input", { type: "checkbox", checked: p.published, onchange: async (e) => {
      const res = await post(`/api/projects/${p.id}/home`, { published: e.target.checked });
      say(res.ok ? (e.target.checked ? `“${p.title}” is now on the audience home page.` : `“${p.title}” is hidden from the audience home page.`) : res.reason);
    } });
    list.append(h("li", { class: `project-card show-card${p.id === current ? " is-current" : ""}` },
      h("span", { class: `cover c-${p.color}`, "aria-hidden": "true" }, p.emoji),
      h("div", { class: "project-info" },
        h("h3", {}, p.title),
        h("p", {}, `${p.parts} part${p.parts === 1 ? "" : "s"}, ${p.videos} video${p.videos === 1 ? "" : "s"}. Last changed ${p.updated}.`),
        h("label", { class: "switch-row" }, toggle, h("span", { class: "switch", "aria-hidden": "true" }), "On the audience home page")),
      h("div", { class: "project-buttons" },
        h("a", { class: "btn btn-primary", href: `/edit/${p.id}` }, "✎ Edit"),
        h("a", { class: "btn", href: `/play?show=${p.id}`, target: "_blank", rel: "noopener" }, "▶ Play"),
        h("button", { type: "button", class: "btn", onclick: async () => {
          const label = prompt("Name this version, so you can find it later:", "Before rehearsal");
          if (label === null) return;
          const res = await post(`/api/projects/${p.id}/version`, { label });
          say(res.ok ? `Saved a version of “${p.title}” called “${label || "Saved version"}”. Find it in the editor under Project → Earlier versions.` : "Couldn't save a version.");
        } }, "★ Save a version"),
        h("a", { class: "btn", href: `/script?show=${p.id}`, target: "_blank", rel: "noopener" }, "📄 Script"),
        h("a", { class: "btn", href: `/api/projects/${p.id}/export` }, "⤓ Download"),
        h("button", { type: "button", class: "btn", onclick: async () => {
          await post("/api/projects/duplicate", { id: p.id });
          say(`Made a copy of “${p.title}”.`);
          loadShows();
        } }, "Make a copy"),
        h("button", { type: "button", class: "btn btn-danger", onclick: async () => {
          if (!confirm(`Delete “${p.title}”? It's moved to the projects/.trash folder, so it can still be recovered by hand.`)) return;
          await post("/api/projects/delete", { id: p.id });
          say(`Deleted “${p.title}”.`);
          loadShows();
        } }, "Delete"))));
  }
}

$("#newBlankBtn").addEventListener("click", async () => {
  const title = prompt("What's the show called?", "New show");
  if (title === null) return;
  const res = await post("/api/projects", { template: "blank", title });
  if (res.ok) location.href = `/edit/${res.id}`;
});
$("#newSampleBtn").addEventListener("click", async () => {
  const res = await post("/api/projects", { template: "sample" });
  if (res.ok) location.href = `/edit/${res.id}`;
});
$("#importBtn").addEventListener("click", () => $("#importInput").click());
$("#importInput").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  say(`Uploading ${f.name}… Show files with videos can take a minute.`);
  const fd = new FormData();
  fd.append("file", f);
  const res = await (await fetch("/api/projects/import", { method: "POST", body: fd })).json().catch(() => ({ ok: false, reason: "Upload failed." }));
  e.target.value = "";
  say(res.ok ? `Added “${f.name.replace(/\.klsp\.zip$|\.zip$/i, "")}”.` : res.reason);
  loadShows();
});

// ---------------------------------------------------------------------------
// Name library
// ---------------------------------------------------------------------------
let library = [];

async function loadLibrary() {
  library = (await (await fetch("/api/library")).json()).names || [];
  renderLibrary();
}

function renderLibrary() {
  const q = $("#libFilter").value.trim().toLowerCase();
  const shown = library.filter((n) => n.toLowerCase().includes(q));
  const ul = $("#libList");
  ul.innerHTML = "";
  if (!library.length) ul.append(h("li", { class: "help" }, "No names yet. Add some above."));
  else if (!shown.length) ul.append(h("li", { class: "help" }, "No names match."));
  shown.forEach((n) => ul.append(h("li", { class: "chip" }, n,
    h("button", { type: "button", "aria-label": `Remove ${n}`, onclick: () => saveLibrary(library.filter((x) => x !== n)) }, "✕"))));
  $("#libCount").textContent = `${library.length} name${library.length === 1 ? "" : "s"}`;
  $("#libClearBtn").hidden = !library.length;
}

async function saveLibrary(names) {
  const res = await fetch("/api/library", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ names }) })
    .then((r) => r.json()).catch(() => ({}));
  if (res.ok) { library = res.names; renderLibrary(); }
  else say(res.reason || "Couldn't save the name library.");
}

function addFromInput() {
  const typed = $("#libInput").value.split(/[,，、\n]/).map((w) => w.trim()).filter(Boolean);
  if (!typed.length) return;
  $("#libInput").value = "";
  saveLibrary([...library, ...typed]);
}
$("#libAddBtn").addEventListener("click", addFromInput);
$("#libInput").addEventListener("keydown", (e) => { if (e.key === "Enter") addFromInput(); });
$("#libFilter").addEventListener("input", renderLibrary);
$("#libClearBtn").addEventListener("click", () => {
  if (confirm(`Remove all ${library.length} names from the library?`)) saveLibrary([]);
});

loadShows();
loadLibrary();
fetch("/api/info").then((r) => r.json()).then((i) => { $("#appVersion").textContent = `version ${i.version}`; }).catch(() => {});
