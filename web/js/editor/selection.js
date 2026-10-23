// Screen-space overlay over the canvas: hover outlines, the selection box
// with handles and rotation knob, arrow end and bend handles, the marquee,
// snap and spacing guides, and the live pills (size, angle, "Center", gaps).
// Handle hit testing lives here too, so what you see is exactly what you grab.

import { svg, h } from "../ui/dom.js";
import { corners, aabb, unionBox, arrowPoints, pointInPolygon } from "../core/geometry.js";
import { HANDLES, handlesFor, isCorner, CORNER_IDS } from "./transform.js";
import { resizeCursor, rotateCursor } from "./cursors.js";

const RAD = Math.PI / 180;
const KNOB_GAP = 26;
const SIDE_LEN = 7;

const f2 = (v) => (Math.round(v * 100) / 100).toString();
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const angleOf = (c, p) => Math.atan2(p.y - c.y, p.x - c.x) / RAD;
const poly = (pts) => `M${pts.map((p) => `${f2(p.x)} ${f2(p.y)}`).join("L")}Z`;
const crisp = (v) => Math.round(v - 0.5) + 0.5;

// Reuse children of `group` for `items`, creating and removing as needed.
function sync(group, items, tag, set) {
  const kids = [...group.children];
  for (let i = 0; i < items.length; i++) {
    let el = kids[i];
    if (!el || el.tagName.toLowerCase() !== tag) {
      const n = tag === "div" ? h("div") : svg(tag);
      if (el) el.replaceWith(n);
      else group.appendChild(n);
      el = n;
    }
    set(el, items[i], i);
  }
  for (let i = items.length; i < kids.length; i++) kids[i].remove();
}

function attr(el, name, value) {
  const v = String(value);
  if (el.getAttribute(name) !== v) el.setAttribute(name, v);
}

// The outline of a layer in host-local px: the box, or the curve for arrows.
export function outlinePath(layer, L) {
  if (layer.type === "arrow") {
    const p = arrowPoints(layer);
    const a = L(p.a);
    const b = L(p.b);
    if (!p.c) return `M${f2(a.x)} ${f2(a.y)}L${f2(b.x)} ${f2(b.y)}`;
    const c = L(p.c);
    return `M${f2(a.x)} ${f2(a.y)}Q${f2(c.x)} ${f2(c.y)} ${f2(b.x)} ${f2(b.y)}`;
  }
  return poly(corners(layer).map(L));
}

export function createSelectionOverlay(core) {
  const root = core.overlaySvg;
  const group = (cls) => root.appendChild(svg("g", { class: cls }));
  const gHover = group("ed-g-hover");
  const gSel = group("ed-g-sel");
  const gSnap = group("ed-g-snap");
  const gSpace = group("ed-g-space");
  const gMarquee = group("ed-g-marquee");
  const gCrop = group("ed-g-crop");
  const gHandles = group("ed-g-handles");
  const gTool = group("ed-g-tool");
  const stem = gHandles.appendChild(svg("path", { class: "ed-knob-stem" }));
  const gSides = gHandles.appendChild(svg("g", { class: "ed-sides" }));
  const gCorners = gHandles.appendChild(svg("g", { class: "ed-corners" }));
  const knob = gHandles.appendChild(svg("g", { class: "ed-knob" }, svg("circle", { r: "9" }), svg("path", { class: "ed-knob-icon", d: "M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8M21 3v5h-5", transform: "translate(-5.5 -5.5) scale(0.46)" })));
  const gArrow = gHandles.appendChild(svg("g", { class: "ed-arrow-handles" }));
  const marquee = gMarquee.appendChild(svg("rect", { class: "ed-marquee" }));
  const pills = core.pillsEl;

  const store = core.store;
  const L = (p) => core.viewport.docToLocal(p);

  // ---- handle geometry ---------------------------------------------------------

  function singleHandles(l) {
    if (l.locked || l.hidden) return [];
    if (l.type === "arrow") {
      const p = arrowPoints(l);
      return [
        { kind: "arrow", handle: "a", ...L(p.a) },
        { kind: "arrow", handle: "b", ...L(p.b) },
        { kind: "bend", handle: "c", ...L(p.mid), curved: !!p.c },
      ];
    }
    const cs = corners(l).map(L);
    const pos = { nw: cs[0], ne: cs[1], se: cs[2], sw: cs[3], n: mid(cs[0], cs[1]), e: mid(cs[1], cs[2]), s: mid(cs[2], cs[3]), w: mid(cs[3], cs[0]) };
    const c = L({ x: l.x, y: l.y });
    const sw = Math.hypot(cs[1].x - cs[0].x, cs[1].y - cs[0].y);
    const sh = Math.hypot(cs[2].x - cs[1].x, cs[2].y - cs[1].y);
    const out = [];
    for (const id of handlesFor(l)) {
      const corner = isCorner(id);
      if (!corner && (HANDLES[id][0] ? sh : sw) < 34) continue;
      const edge = HANDLES[id][0] ? l.rotation + 90 : l.rotation;
      out.push({ kind: "resize", handle: id, ...pos[id], angle: angleOf(c, pos[id]), corner, edge });
    }
    const r = (l.rotation || 0) * RAD;
    const kx = pos.s.x - Math.sin(r) * KNOB_GAP;
    const ky = pos.s.y + Math.cos(r) * KNOB_GAP;
    out.push({ kind: "rotate", handle: "rot", x: kx, y: ky, stem: pos.s, angle: angleOf(c, { x: kx, y: ky }) });
    return out;
  }

  // Every grabbable handle for the current selection, in host-local px.
  function handleList() {
    if (core.toolId !== "select" || core.state.mode !== "normal" || core.textEditing) return [];
    const sel = store.selected();
    if (!sel.length) return [];
    if (sel.length === 1) return singleHandles(sel[0]);
    if (sel.some((l) => l.locked) || sel.every((l) => l.hidden)) return [];
    const b = unionBox(sel.map(aabb));
    const c = L({ x: b.cx, y: b.cy });
    const pts = { nw: L({ x: b.l, y: b.t }), ne: L({ x: b.r, y: b.t }), se: L({ x: b.r, y: b.b }), sw: L({ x: b.l, y: b.b }) };
    return CORNER_IDS.map((id) => ({ kind: "scale", handle: id, ...pts[id], angle: angleOf(c, pts[id]), corner: true, edge: 0 }));
  }

  // The area a press drags the selection from. Hidden layers can not be
  // dragged, so they do not count: a press over one starts a marquee.
  function selectionPolygon() {
    const sel = store.selected().filter((l) => !l.hidden);
    if (!sel.length) return null;
    if (sel.length === 1) {
      const l = sel[0];
      if (l.type === "arrow") return null;
      return corners(l).map(L);
    }
    const b = unionBox(sel.map(aabb));
    return [L({ x: b.l, y: b.t }), L({ x: b.r, y: b.t }), L({ x: b.r, y: b.b }), L({ x: b.l, y: b.b })];
  }

  function cursorFor(hd) {
    if (hd.kind === "rotate") return rotateCursor(hd.angle);
    if (hd.kind === "arrow" || hd.kind === "bend") return "move";
    return resizeCursor(hd.angle);
  }

  // The handle under a host-local point, or null. Inside a small box the
  // body wins over the handles so tiny layers can still be dragged.
  function hitHandle(local, pointerType = "mouse") {
    const tol = pointerType === "touch" ? 16 : pointerType === "pen" ? 10 : 8;
    const list = handleList();
    if (!list.length) return null;
    const polyPts = selectionPolygon();
    const inside = polyPts ? pointInPolygon(local, polyPts) : false;
    let small = false;
    if (polyPts) {
      const w = Math.hypot(polyPts[1].x - polyPts[0].x, polyPts[1].y - polyPts[0].y);
      const hh = Math.hypot(polyPts[2].x - polyPts[1].x, polyPts[2].y - polyPts[1].y);
      small = Math.min(w, hh) < 40;
    }
    let found = null;
    for (const hd of list) {
      const d = Math.hypot(hd.x - local.x, hd.y - local.y);
      let t = hd.kind === "rotate" ? tol + 3 : tol;
      if (hd.kind === "resize" && !hd.corner) t = tol + 1;
      if (inside && small && (hd.kind === "resize" || hd.kind === "scale")) t = Math.min(t, 4);
      if (d <= t && (!found || d < found.d)) found = { ...hd, d };
    }
    if (found) return { ...found, cursor: cursorFor(found) };
    // Just outside a corner rotates, like most design tools.
    const sel = store.selected();
    if (sel.length === 1 && polyPts && !sel[0].locked) {
      const l = sel[0];
      const r = -(l.rotation || 0) * RAD;
      const c = L({ x: l.x, y: l.y });
      for (let i = 0; i < 4; i++) {
        const [hx, hy] = HANDLES[CORNER_IDS[i]];
        const p = polyPts[i];
        const vx = local.x - p.x;
        const vy = local.y - p.y;
        const bx = vx * Math.cos(r) - vy * Math.sin(r);
        const by = vx * Math.sin(r) + vy * Math.cos(r);
        const d = Math.hypot(vx, vy);
        if (bx * hx > 1 && by * hy > 1 && d > tol * 0.6 && d < tol + 16) {
          return { kind: "rotate", handle: "rot", x: p.x, y: p.y, angle: angleOf(c, p), cursor: rotateCursor(angleOf(c, p)) };
        }
      }
    }
    return null;
  }

  function selectionContains(local) {
    const pts = selectionPolygon();
    return pts ? pointInPolygon(local, pts) : false;
  }

  // Bounds of the selection in host-local px (for pills and the quick bar).
  function selectionRect() {
    const sel = store.selected();
    if (!sel.length) return null;
    const pts = [];
    for (const l of sel) {
      if (l.type === "arrow") {
        const p = arrowPoints(l);
        pts.push(L(p.a), L(p.b), L(p.mid));
      } else {
        pts.push(...corners(l).map(L));
      }
    }
    let l = Infinity;
    let t = Infinity;
    let r = -Infinity;
    let b = -Infinity;
    for (const p of pts) {
      l = Math.min(l, p.x);
      t = Math.min(t, p.y);
      r = Math.max(r, p.x);
      b = Math.max(b, p.y);
    }
    return { l, t, r, b };
  }

  // ---- drawing ----------------------------------------------------------------------

  function drawLines(items) {
    // Each line gets a dark halo underneath so it reads on any picture.
    const flat = [];
    for (const it of items) flat.push({ d: it.d, cls: `${it.cls} ed-halo` }, it);
    sync(gSel, flat, "path", (el, it) => {
      attr(el, "d", it.d);
      attr(el, "class", it.cls);
    });
  }

  function drawGuides(S) {
    const lines = [];
    for (const g of S.guides || []) {
      if (g.axis === "x") {
        const x = crisp(L({ x: g.v, y: 0 }).x);
        const a = L({ x: g.v, y: g.from }).y;
        const b = L({ x: g.v, y: g.to }).y;
        lines.push({ d: `M${x} ${f2(a)}L${x} ${f2(b)}`, cls: g.canvas ? "ed-guide canvas" : "ed-guide" });
      } else {
        const y = crisp(L({ x: 0, y: g.v }).y);
        const a = L({ x: g.from, y: g.v }).x;
        const b = L({ x: g.to, y: g.v }).x;
        lines.push({ d: `M${f2(a)} ${y}L${f2(b)} ${y}`, cls: g.canvas ? "ed-guide canvas" : "ed-guide" });
      }
    }
    const flat = [];
    for (const it of lines) flat.push({ d: it.d, cls: `${it.cls} ed-guide-halo` }, it);
    sync(gSnap, flat, "path", (el, it) => {
      attr(el, "d", it.d);
      attr(el, "class", it.cls);
    });
    const segs = [];
    for (const s of S.spacing || []) {
      if (s.axis === "x") {
        const a = L({ x: s.from, y: s.at });
        const b = L({ x: s.to, y: s.at });
        const y = crisp(a.y);
        segs.push(`M${f2(a.x)} ${y - 4}L${f2(a.x)} ${y + 4}M${f2(a.x)} ${y}L${f2(b.x)} ${y}M${f2(b.x)} ${y - 4}L${f2(b.x)} ${y + 4}`);
      } else {
        const a = L({ x: s.at, y: s.from });
        const b = L({ x: s.at, y: s.to });
        const x = crisp(a.x);
        segs.push(`M${x - 4} ${f2(a.y)}L${x + 4} ${f2(a.y)}M${x} ${f2(a.y)}L${x} ${f2(b.y)}M${x - 4} ${f2(b.y)}L${x + 4} ${f2(b.y)}`);
      }
    }
    const flatS = [];
    for (const d of segs) flatS.push({ d, cls: "ed-space-halo" }, { d, cls: "ed-space" });
    sync(gSpace, flatS, "path", (el, it) => {
      attr(el, "d", it.d);
      attr(el, "class", it.cls);
    });
  }

  function drawHandles(list) {
    const resize = list.filter((hd) => hd.kind === "resize" || hd.kind === "scale");
    const cornersList = resize.filter((hd) => hd.corner);
    const sides = resize.filter((hd) => !hd.corner);
    sync(gCorners, cornersList, "rect", (el, hd) => {
      attr(el, "class", "ed-h-corner");
      attr(el, "x", f2(hd.x - 4.5));
      attr(el, "y", f2(hd.y - 4.5));
      attr(el, "width", 9);
      attr(el, "height", 9);
      attr(el, "rx", 2.6);
      attr(el, "transform", `rotate(${f2(hd.edge || 0)} ${f2(hd.x)} ${f2(hd.y)})`);
    });
    const sideItems = [];
    for (const hd of sides) {
      const r = hd.edge * RAD;
      const dx = Math.cos(r) * SIDE_LEN;
      const dy = Math.sin(r) * SIDE_LEN;
      const d = `M${f2(hd.x - dx)} ${f2(hd.y - dy)}L${f2(hd.x + dx)} ${f2(hd.y + dy)}`;
      sideItems.push({ d, cls: "ed-h-side-edge" }, { d, cls: "ed-h-side" });
    }
    sync(gSides, sideItems, "path", (el, it) => {
      attr(el, "d", it.d);
      attr(el, "class", it.cls);
    });
    const rot = list.find((hd) => hd.kind === "rotate");
    if (rot) {
      stem.style.display = "";
      knob.style.display = "";
      attr(stem, "d", `M${f2(rot.stem.x)} ${f2(rot.stem.y)}L${f2(rot.x)} ${f2(rot.y)}`);
      attr(knob, "transform", `translate(${f2(rot.x)} ${f2(rot.y)})`);
    } else {
      stem.style.display = "none";
      knob.style.display = "none";
    }
    const arrows = list.filter((hd) => hd.kind === "arrow" || hd.kind === "bend");
    sync(gArrow, arrows, "circle", (el, hd) => {
      attr(el, "class", hd.kind === "bend" ? (hd.curved ? "ed-h-bend curved" : "ed-h-bend") : "ed-h-end");
      attr(el, "cx", f2(hd.x));
      attr(el, "cy", f2(hd.y));
      attr(el, "r", hd.kind === "bend" ? 5 : 6);
    });
  }

  function drawPills(S, list) {
    const items = [];
    const g = S.gesture;
    const rect = selectionRect();
    if (g?.pill) {
      if (g.pillAt === "pointer" && S.pointer) {
        items.push({ text: g.pill, x: S.pointer.x + 20, y: S.pointer.y + 22, cls: "ed-pill", anchor: "left" });
      } else if (rect) {
        const rot = list.find((hd) => hd.kind === "rotate");
        let y = rect.b + 12;
        if (rot && rot.y + 12 > y - 4) y = rot.y + 16;
        items.push({ text: g.pill, x: (rect.l + rect.r) / 2, y, cls: "ed-pill", anchor: "top" });
      }
    }
    const sel = store.selected();
    if (!g && S.mode === "normal" && sel.length === 1 && sel[0].locked && rect) {
      items.push({ text: "Locked", x: (rect.l + rect.r) / 2, y: rect.b + 10, cls: "ed-pill muted", anchor: "top" });
    }
    for (const gd of S.guides || []) {
      if (!gd.center) continue;
      if (gd.axis === "x") {
        const top = L({ x: gd.v, y: 0 });
        items.push({ text: "Center", x: top.x, y: Math.max(top.y + 10, 10), cls: "ed-pill accent", anchor: "top" });
      } else {
        const left = L({ x: 0, y: gd.v });
        items.push({ text: "Center", x: Math.max(left.x + 10, 10), y: left.y, cls: "ed-pill accent", anchor: "left-mid" });
      }
    }
    for (const s of S.spacing || []) {
      const a = s.axis === "x" ? L({ x: (s.from + s.to) / 2, y: s.at }) : L({ x: s.at, y: (s.from + s.to) / 2 });
      items.push({ text: s.label, x: a.x, y: a.y, cls: "ed-pill gold", anchor: "center" });
    }
    sync(pills, items, "div", (el, it) => {
      if (el.textContent !== it.text) el.textContent = it.text;
      if (el.className !== it.cls) el.className = it.cls;
      const shift = it.anchor === "left" ? "0, 0" : it.anchor === "left-mid" ? "0, -50%" : it.anchor === "center" ? "-50%, -50%" : "-50%, 0";
      const tf = `translate(${Math.round(it.x)}px, ${Math.round(it.y)}px) translate(${shift})`;
      if (el.style.transform !== tf) el.style.transform = tf;
    });
  }

  function update() {
    const S = core.state;
    const sel = store.selected();
    const g = S.gesture;
    const editing = core.textEditing;
    const toolSelect = core.toolId === "select";

    const hover = [];
    const quiet = g && g.kind !== "none";
    let hid = S.panelHoverId;
    if (!hid && toolSelect && S.mode === "normal" && !quiet && S.hoverId && !store.selection.includes(S.hoverId)) hid = S.hoverId;
    const hl = hid ? store.get(hid) : null;
    if (hl && !hl.hidden) hover.push(outlinePath(hl, L));
    sync(gHover, hover, "path", (el, d) => {
      attr(el, "d", d);
      attr(el, "class", "ed-hover");
    });

    const lines = [];
    if (S.mode !== "crop" && sel.length) {
      if (sel.length === 1) {
        const l = sel[0];
        const cls = l.locked ? "ed-sel locked" : editing === l.id ? "ed-sel editing" : l.type === "arrow" ? "ed-sel arrow" : "ed-sel";
        lines.push({ d: outlinePath(l, L), cls });
      } else {
        for (const l of sel) lines.push({ d: outlinePath(l, L), cls: "ed-sel member" });
        const b = unionBox(sel.map(aabb));
        lines.push({ d: poly([L({ x: b.l, y: b.t }), L({ x: b.r, y: b.t }), L({ x: b.r, y: b.b }), L({ x: b.l, y: b.b })]), cls: "ed-sel" });
      }
    }
    drawLines(lines);
    drawGuides(S);

    if (S.marquee) {
      const m = S.marquee;
      marquee.style.display = "";
      attr(marquee, "x", f2(Math.min(m.x0, m.x1)));
      attr(marquee, "y", f2(Math.min(m.y0, m.y1)));
      attr(marquee, "width", f2(Math.abs(m.x1 - m.x0)));
      attr(marquee, "height", f2(Math.abs(m.y1 - m.y0)));
    } else {
      marquee.style.display = "none";
    }

    const hideHandles = g && (g.kind === "move" || g.kind === "marquee" || g.kind === "pan");
    const list = hideHandles ? [] : handleList();
    drawHandles(list);
    gHandles.classList.toggle("dragging", !!(g && g.kind !== "none"));
    drawPills(S, list);
  }

  return {
    update,
    hitHandle,
    selectionContains,
    selectionRect,
    handleList,
    toolGroup: gTool,
    cropGroup: gCrop,
  };
}
