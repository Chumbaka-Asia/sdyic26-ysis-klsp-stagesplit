// Story canvas: the whole show as a map of parts joined by wires.
//
//   * Drag a part by its top bar to move it. Positions are saved in the story.
//   * Drag from a path's dot (right edge) onto another part to connect them,
//     or into empty space to add a new part there.
//   * Click a wire to select it; press Delete or the ✕ to remove it.
//   * Drag the background to move around; scroll or use + and − to zoom.
//   * Loops (paths going back to an earlier part) are drawn as dashed red wires.
//   * Parts with problems glow red; parts nothing leads to are dashed.

const NODE_W = 220;
const COL_W = 300;
const ROW_H = 40;

export class StoryCanvas {
  /**
   * hooks: story(), selected(), select(id), links(node), titleOf(node), types,
   * problems() -> [{id, text}], reachable() -> Set, changed(opts),
   * openAdd(fromId, link, pos), addPart(type, pos), query()
   */
  constructor(hooks) {
    this.h = hooks;
    this.zoom = 1;
    this.pan = { x: 40, y: 40 };
    this.selWire = null;
    this.root = document.createElement("div");
    this.root.className = "cv";
    this.root.innerHTML = `
      <div class="cv-tools">
        <span class="cv-add-label">Add:</span>
        <span class="cv-adds"></span>
        <span class="cv-spacer"></span>
        <button type="button" data-z="out" aria-label="Zoom out">−</button>
        <button type="button" data-z="in" aria-label="Zoom in">+</button>
        <button type="button" data-z="fit">Fit</button>
        <button type="button" data-z="tidy" title="Arrange the parts neatly from left to right">Tidy up</button>
      </div>
      <div class="cv-view" tabindex="0" aria-label="Story canvas">
        <div class="cv-world">
          <svg class="cv-wires"><g class="cv-paths"></g><path class="cv-temp" /></svg>
          <div class="cv-nodes"></div>
        </div>
        <button type="button" class="cv-wire-del" hidden>✕ Remove link</button>
      </div>
      <p class="cv-hint">Drag a dot onto a part to connect it, or into empty space to add a new part. Drag the background to move around.</p>`;
    this.view = this.root.querySelector(".cv-view");
    this.world = this.root.querySelector(".cv-world");
    this.svg = this.root.querySelector(".cv-wires");
    this.paths = this.root.querySelector(".cv-paths");
    this.temp = this.root.querySelector(".cv-temp");
    this.nodesEl = this.root.querySelector(".cv-nodes");
    this.delBtn = this.root.querySelector(".cv-wire-del");

    const adds = this.root.querySelector(".cv-adds");
    for (const [type, t] of Object.entries(this.h.types)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `cv-add t-${type}`;
      b.textContent = `${t.icon} ${t.name}`;
      b.addEventListener("click", () => this.h.addPart(type, this.centre()));
      adds.append(b);
    }
    this.root.querySelector(".cv-tools").addEventListener("click", (e) => {
      const z = e.target.dataset.z;
      if (z === "in") this.zoomBy(1.2);
      if (z === "out") this.zoomBy(1 / 1.2);
      if (z === "fit") this.fit();
      if (z === "tidy") { this.layout(true); this.h.changed({ tree: true }); this.fit(); }
    });
    this.view.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, e);
    }, { passive: false });
    this.view.addEventListener("pointerdown", (e) => this.onDown(e));
    this.view.addEventListener("keydown", (e) => {
      if ((e.key === "Delete" || e.key === "Backspace") && this.selWire) { e.preventDefault(); this.removeWire(); }
    });
    this.delBtn.addEventListener("click", () => this.removeWire());
  }

  // ---- coordinates --------------------------------------------------------
  toWorld(e) {
    const r = this.view.getBoundingClientRect();
    return { x: (e.clientX - r.left - this.pan.x) / this.zoom, y: (e.clientY - r.top - this.pan.y) / this.zoom };
  }
  centre() {
    const r = this.view.getBoundingClientRect();
    return { x: (r.width / 2 - this.pan.x) / this.zoom - NODE_W / 2, y: (r.height / 2 - this.pan.y) / this.zoom - 40 };
  }
  applyTransform() {
    this.world.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom})`;
  }
  zoomBy(f, e) {
    const r = this.view.getBoundingClientRect();
    const cx = e ? e.clientX - r.left : r.width / 2, cy = e ? e.clientY - r.top : r.height / 2;
    const z = Math.min(2, Math.max(0.3, this.zoom * f));
    this.pan.x = cx - ((cx - this.pan.x) * z) / this.zoom;
    this.pan.y = cy - ((cy - this.pan.y) * z) / this.zoom;
    this.zoom = z;
    this.applyTransform();
  }
  fit() {
    const nodes = Object.values(this.h.story().nodes);
    if (!nodes.length) return;
    const xs = nodes.map((n) => n.ui?.x || 0), ys = nodes.map((n) => n.ui?.y || 0);
    const minX = Math.min(...xs), minY = Math.min(...ys), maxX = Math.max(...xs) + NODE_W, maxY = Math.max(...ys) + 160;
    const r = this.view.getBoundingClientRect();
    this.zoom = Math.min(1.2, Math.max(0.3, Math.min((r.width - 60) / (maxX - minX), (r.height - 60) / (maxY - minY))));
    this.pan = { x: 30 - minX * this.zoom, y: 30 - minY * this.zoom };
    this.applyTransform();
  }

  // ---- layout: columns by distance from the start --------------------------
  layout(force = false) {
    const story = this.h.story();
    const ids = Object.keys(story.nodes);
    if (!force && ids.every((id) => story.nodes[id].ui)) return;
    const depth = {};
    const order = [];
    const queue = [[story.start, 0]];
    while (queue.length) {
      const [id, d] = queue.shift();
      if (!id || !story.nodes[id] || id in depth) continue;
      depth[id] = d;
      order.push(id);
      this.h.links(story.nodes[id]).forEach((l) => queue.push([l.get(), d + 1]));
    }
    const maxD = Math.max(0, ...Object.values(depth));
    ids.filter((id) => !(id in depth)).forEach((id) => { depth[id] = maxD + 1; order.push(id); });
    const rows = {};
    for (const id of order) {
      const n = story.nodes[id];
      if (!force && n.ui) continue;
      const d = depth[id];
      rows[d] = rows[d] ?? 0;
      const height = 90 + this.h.links(n).length * 26;
      n.ui = { x: d * COL_W, y: rows[d] };
      rows[d] += height + ROW_H;
    }
  }

  // ---- drawing -------------------------------------------------------------
  render() {
    const story = this.h.story();
    this.layout(false);
    const problems = {};
    this.h.problems().forEach((p) => (problems[p.id] ??= []).push(p.text));
    const reach = this.h.reachable();
    const q = (this.h.query() || "").toLowerCase();
    this.nodesEl.innerHTML = "";
    for (const [id, n] of Object.entries(story.nodes)) {
      const t = this.h.types[n.type];
      const el = document.createElement("div");
      const title = this.h.titleOf(n);
      el.className = `cv-node t-${n.type}${id === this.h.selected() ? " is-selected" : ""}${problems[id] ? " has-problem" : ""}${reach.has(id) ? "" : " is-orphan"}${q && !title.toLowerCase().includes(q) ? " is-dim" : ""}`;
      el.dataset.id = id;
      el.style.left = `${n.ui.x}px`;
      el.style.top = `${n.ui.y}px`;
      el.style.width = `${NODE_W}px`;
      el.innerHTML = `
        <div class="cv-head"><span class="cv-icon"></span><span class="cv-kind"></span>${id === story.start ? '<span class="cv-start">Start</span>' : ""}${problems[id] ? '<span class="cv-warn">!</span>' : ""}</div>
        <div class="cv-title"></div>
        ${reach.has(id) ? "" : '<div class="cv-note">Not connected yet</div>'}
        <ul class="cv-ports"></ul>
        <span class="cv-in"></span>`;
      el.querySelector(".cv-icon").textContent = t.icon;
      el.querySelector(".cv-kind").textContent = t.name;
      el.querySelector(".cv-title").textContent = title;
      if (problems[id]) el.title = problems[id].join("\n");
      const ports = el.querySelector(".cv-ports");
      this.h.links(n).forEach((l, i) => {
        const li = document.createElement("li");
        li.className = "cv-port";
        li.innerHTML = `<span class="cv-port-label"></span><span class="cv-dot${l.get() ? "" : " is-empty"}" data-port="${i}" title="Drag to connect"></span>`;
        li.querySelector(".cv-port-label").textContent = l.label === "Then" ? "Then" : l.label;
        ports.append(li);
      });
      this.nodesEl.append(el);
    }
    this.applyTransform();
    this.drawWires();
  }

  portPos(id, i) {
    const el = this.nodesEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
    const dot = el?.querySelector(`[data-port="${i}"]`);
    if (!dot) return null;
    const n = this.h.story().nodes[id];
    return { x: n.ui.x + dot.parentElement.offsetLeft + dot.offsetLeft + 7, y: n.ui.y + dot.parentElement.offsetTop + dot.offsetTop + 7 };
  }
  inPos(id) {
    const n = this.h.story().nodes[id];
    return { x: n.ui.x, y: n.ui.y + 22 };
  }

  static curve(a, b) {
    if (b.x >= a.x + 30) {
      const dx = Math.max(50, (b.x - a.x) * 0.5);
      return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
    }
    // Loop back to an earlier part: swing out to the right and come in from the left.
    const lift = Math.max(80, Math.abs(a.y - b.y) * 0.3);
    return `M${a.x},${a.y} C${a.x + 140},${a.y + lift} ${b.x - 140},${b.y + lift} ${b.x},${b.y}`;
  }

  drawWires() {
    const story = this.h.story();
    this.paths.innerHTML = "";
    let maxX = 1000, maxY = 800;
    for (const [id, n] of Object.entries(story.nodes)) {
      maxX = Math.max(maxX, n.ui.x + NODE_W + 400);
      maxY = Math.max(maxY, n.ui.y + 600);
      this.h.links(n).forEach((l, i) => {
        const to = l.get();
        if (!to || !story.nodes[to]) return;
        const a = this.portPos(id, i), b = this.inPos(to);
        if (!a) return;
        const d = StoryCanvas.curve(a, b);
        const loop = b.x < a.x + 30;
        const sel = this.selWire && this.selWire.from === id && this.selWire.i === i;
        // A wide invisible path makes the wire easy to click; the visible one sits after it.
        const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
        hit.setAttribute("d", d);
        hit.setAttribute("class", "cv-hit");
        hit.dataset.from = id;
        hit.dataset.i = i;
        const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p.setAttribute("d", d);
        p.setAttribute("class", `cv-wire${loop ? " is-loop" : ""}${sel ? " is-sel" : ""}`);
        p.dataset.from = id;
        p.dataset.i = i;
        this.paths.append(hit, p);
      });
    }
    this.svg.setAttribute("width", maxX);
    this.svg.setAttribute("height", maxY);
    this.placeDelete();
  }

  placeDelete() {
    const w = this.selWire && this.paths.querySelector(`.cv-wire[data-from="${CSS.escape(this.selWire.from)}"][data-i="${this.selWire.i}"]`);
    this.delBtn.hidden = !w;
    if (!w) return;
    const len = w.getTotalLength();
    const mid = w.getPointAtLength(len / 2);
    this.delBtn.style.left = `${mid.x * this.zoom + this.pan.x}px`;
    this.delBtn.style.top = `${mid.y * this.zoom + this.pan.y}px`;
  }

  removeWire() {
    if (!this.selWire) return;
    const n = this.h.story().nodes[this.selWire.from];
    const l = n && this.h.links(n)[this.selWire.i];
    if (l) l.set(null);
    this.selWire = null;
    this.h.changed({ form: true });
  }

  // ---- pointer interactions -----------------------------------------------
  onDown(e) {
    if (e.button !== 0) return;
    const dot = e.target.closest(".cv-dot");
    const head = e.target.closest(".cv-head, .cv-title");
    const node = e.target.closest(".cv-node");
    const wire = e.target.closest(".cv-hit");
    if (e.target.closest(".cv-wire-del")) return;
    this.view.focus({ preventScroll: true });

    if (dot) return this.dragWire(e, node.dataset.id, Number(dot.dataset.port));
    if (node && head) return this.dragNode(e, node.dataset.id);
    if (node) { this.selWire = null; this.h.select(node.dataset.id); return; }
    if (wire) {
      this.selWire = { from: wire.dataset.from, i: Number(wire.dataset.i) };
      this.drawWires();
      return;
    }
    this.selWire = null;
    this.drawWires();
    this.dragPan(e);
  }

  track(e, move, up) {
    const target = e.target;
    target.setPointerCapture?.(e.pointerId);
    const mv = (ev) => move(ev);
    const done = (ev) => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", done);
      up(ev);
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", done);
  }

  dragPan(e) {
    const start = { x: e.clientX, y: e.clientY, px: this.pan.x, py: this.pan.y };
    this.view.classList.add("is-panning");
    this.track(e, (ev) => {
      this.pan.x = start.px + ev.clientX - start.x;
      this.pan.y = start.py + ev.clientY - start.y;
      this.applyTransform();
      this.placeDelete();
    }, () => this.view.classList.remove("is-panning"));
  }

  dragNode(e, id) {
    const n = this.h.story().nodes[id];
    const el = this.nodesEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
    const start = this.toWorld(e);
    const orig = { ...n.ui };
    let moved = false;
    this.track(e, (ev) => {
      const p = this.toWorld(ev);
      const dx = p.x - start.x, dy = p.y - start.y;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      n.ui = { x: Math.round(orig.x + dx), y: Math.round(orig.y + dy) };
      el.style.left = `${n.ui.x}px`;
      el.style.top = `${n.ui.y}px`;
      this.drawWires();
    }, () => {
      if (moved) this.h.changed({ tree: false });
      else this.h.select(id);
    });
  }

  dragWire(e, fromId, i) {
    const a = this.portPos(fromId, i);
    this.temp.style.display = "block";
    this.track(e, (ev) => {
      const b = this.toWorld(ev);
      this.temp.setAttribute("d", StoryCanvas.curve(a, b));
      this.nodesEl.querySelectorAll(".is-target").forEach((x) => x.classList.remove("is-target"));
      document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".cv-node")?.classList.add("is-target");
    }, (ev) => {
      this.temp.style.display = "none";
      this.temp.removeAttribute("d");
      this.nodesEl.querySelectorAll(".is-target").forEach((x) => x.classList.remove("is-target"));
      const story = this.h.story();
      const link = this.h.links(story.nodes[fromId])[i];
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".cv-node");
      if (over && over.dataset.id !== fromId) {
        link.set(over.dataset.id);
        this.h.changed({ form: true });
      } else if (!over) {
        const p = this.toWorld(ev);
        this.h.openAdd(fromId, link, { x: Math.round(p.x), y: Math.round(p.y - 20) });
      }
    });
  }
}
