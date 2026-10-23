// Crop mode for an image layer. The whole picture shows ghosted around the
// frame; drag inside to move the picture, drag the frame's brackets to change
// what is shown, drag the picture's round corners to scale it. Enter, Escape
// or a click outside applies. One undo step per crop session ("Crop").
//
// The maths works in the layer's content space as it was when crop mode
// started (box centred on 0,0, flips included): F is the frame (the layer
// box) and I the whole picture, so layer.crop = F relative to I.

import { fromLocal, toLocal } from "../core/geometry.js";
import { renderLayer, createRenderCache } from "../core/render.js";
import { svg } from "../ui/dom.js";
import { resizeCursor } from "./cursors.js";

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const MAX_ZOOM_IN = 1000;

export function cropFrames(layer) {
  const c = layer.crop || { x: 0, y: 0, w: 1, h: 1 };
  const IW = layer.w / c.w;
  const IH = layer.h / c.h;
  const F = { l: -layer.w / 2, t: -layer.h / 2, r: layer.w / 2, b: layer.h / 2 };
  const I = { l: F.l - c.x * IW, t: F.t - c.y * IH, w: IW, h: IH };
  return { F, I };
}

// Layer props for frame F over picture I (both in layer0's content space).
export function cropResult(layer0, F, I) {
  const fw = Math.max(1e-3, F.r - F.l);
  const fh = Math.max(1e-3, F.b - F.t);
  const c = fromLocal(layer0, { x: (F.l + F.r) / 2, y: (F.t + F.b) / 2 });
  const w = clamp(fw / I.w, 0.001, 1);
  const h = clamp(fh / I.h, 0.001, 1);
  const crop = {
    x: clamp((F.l - I.l) / I.w, 0, 1 - w),
    y: clamp((F.t - I.t) / I.h, 0, 1 - h),
    w,
    h,
  };
  return { x: c.x, y: c.y, w: fw, h: fh, crop };
}

// Move the picture; it always covers the frame.
export function panImage(F, I, dx, dy) {
  return { ...I, l: clamp(I.l + dx, F.r - I.w, F.l), t: clamp(I.t + dy, F.b - I.h, F.t) };
}

// Scale the picture by its corner (hx, hy) to point p, around the opposite
// corner, keeping its aspect and covering the frame.
export function scaleImage(F, I, hx, hy, p) {
  const ax = hx > 0 ? I.l : I.l + I.w;
  const ay = hy > 0 ? I.t : I.t + I.h;
  const sx = (hx > 0 ? p.x - ax : ax - p.x) / I.w;
  const sy = (hy > 0 ? p.y - ay : ay - p.y) / I.h;
  let s = Math.max(sx, sy);
  const need = [hx > 0 ? (F.r - ax) / I.w : (ax - F.l) / I.w, hy > 0 ? (F.b - ay) / I.h : (ay - F.t) / I.h];
  s = Math.max(s, ...need, 1e-6);
  s = Math.min(s, ((F.r - F.l) * MAX_ZOOM_IN) / I.w);
  const w = I.w * s;
  const h = I.h * s;
  return { l: hx > 0 ? ax : ax - w, t: hy > 0 ? ay : ay - h, w, h };
}

// Move the frame's edges (hx, hy in -1..1) to p, inside the picture.
export function resizeFrame(F, I, hx, hy, p, { minSize = 4, keepAspect = false } = {}) {
  const IR = I.l + I.w;
  const IB = I.t + I.h;
  let { l, t, r, b } = F;
  if (hx > 0) r = clamp(p.x, l + minSize, IR);
  if (hx < 0) l = clamp(p.x, I.l, r - minSize);
  if (hy > 0) b = clamp(p.y, t + minSize, IB);
  if (hy < 0) t = clamp(p.y, I.t, b - minSize);
  if (keepAspect && hx && hy) {
    const w0 = F.r - F.l;
    const h0 = F.b - F.t;
    let s = Math.max((r - l) / w0, (b - t) / h0);
    const maxW = hx > 0 ? IR - F.l : F.r - I.l;
    const maxH = hy > 0 ? IB - F.t : F.b - I.t;
    s = Math.min(s, maxW / w0, maxH / h0);
    s = Math.max(s, minSize / w0, minSize / h0);
    const w = w0 * s;
    const h = h0 * s;
    if (hx > 0) r = F.l + w;
    else l = F.r - w;
    if (hy > 0) b = F.t + h;
    else t = F.b - h;
  }
  return { l, t, r, b };
}

const FRAME_HANDLES = [
  ["nw", -1, -1],
  ["n", 0, -1],
  ["ne", 1, -1],
  ["e", 1, 0],
  ["se", 1, 1],
  ["s", 0, 1],
  ["sw", -1, 1],
  ["w", -1, 0],
];

// Crop mode controller. core: the editor internals (index.js).
export function createCrop(core) {
  let s = null; // { id, l0, F, I, drag }
  const ghostCache = createRenderCache();
  let groups = null;

  const store = core.store;

  function start(id) {
    const l = store.get(id);
    if (!l || l.type !== "image" || l.locked || l.hidden) return false;
    // A drag still in progress (Enter pressed mid-move) commits first, so
    // the crop does not open inside its undo step.
    core.settlePointer?.();
    if (s) end(true);
    if (core.textEditing) core.editor.stopTextEdit();
    store.select([id]);
    store.begin("Crop");
    const { F, I } = cropFrames(l);
    s = { id, l0: l, F, I, drag: null };
    core.setModeInternal("crop");
    core.setStatus("Drag to move the picture. Press Enter when done.");
    core.requestRender();
    return true;
  }

  function end(commit = true) {
    if (!s) return false;
    const dragging = !!s.drag;
    s = null;
    if (dragging) core.interaction(false);
    if (commit) store.commit();
    else store.cancel();
    ghostCache.clear();
    core.setGestureCursor(null);
    core.setHoverCursor(null);
    core.setStatus(null);
    core.setModeInternal("normal");
    core.requestRender();
    return true;
  }

  // The store moved on without us (undo, another design, the layer was
  // deleted): drop the session. commit closes our still-open gesture.
  function abort({ commit = false } = {}) {
    if (!s) return;
    const dragging = !!s.drag;
    s = null;
    if (dragging) core.interaction(false);
    if (commit && store.inGesture) store.commit();
    ghostCache.clear();
    core.setGestureCursor(null);
    core.setStatus(null);
    core.setModeInternal("normal");
  }

  function apply() {
    store.patch(s.id, cropResult(s.l0, s.F, s.I));
    core.requestRender();
  }

  const content = (e) => toLocal(s.l0, core.clientToDoc(e));
  const toScreen = (pt) => core.viewport.docToLocal(fromLocal(s.l0, pt));

  function framePoints() {
    const { l, t, r, b } = s.F;
    return [
      { x: l, y: t },
      { x: r, y: t },
      { x: r, y: b },
      { x: l, y: b },
    ];
  }

  function imagePoints() {
    const { l, t, w, h } = s.I;
    return [
      { x: l, y: t },
      { x: l + w, y: t },
      { x: l + w, y: t + h },
      { x: l, y: t + h },
    ];
  }

  function handles() {
    const F = s.F;
    const I = s.I;
    const fc = toScreen({ x: (F.l + F.r) / 2, y: (F.t + F.b) / 2 });
    const out = [];
    for (const [id, hx, hy] of FRAME_HANDLES) {
      const pt = { x: hx < 0 ? F.l : hx > 0 ? F.r : (F.l + F.r) / 2, y: hy < 0 ? F.t : hy > 0 ? F.b : (F.t + F.b) / 2 };
      const sp = toScreen(pt);
      out.push({ kind: "frame", id, hx, hy, pt, ...sp, angle: (Math.atan2(sp.y - fc.y, sp.x - fc.x) * 180) / Math.PI });
    }
    const ic = toScreen({ x: I.l + I.w / 2, y: I.t + I.h / 2 });
    for (const [hx, hy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      const pt = { x: hx < 0 ? I.l : I.l + I.w, y: hy < 0 ? I.t : I.t + I.h };
      const sp = toScreen(pt);
      out.push({ kind: "image", id: `i${hx}${hy}`, hx, hy, pt, ...sp, angle: (Math.atan2(sp.y - ic.y, sp.x - ic.x) * 180) / Math.PI });
    }
    return out;
  }

  function hit(e) {
    const local = core.toLocal(e);
    const tol = e.pointerType === "touch" ? 18 : 10;
    let bestH = null;
    for (const h of handles()) {
      const d = Math.hypot(h.x - local.x, h.y - local.y);
      // Frame handles win over picture corners that sit on top of them.
      const score = h.kind === "frame" ? d - 3 : d;
      if (d <= tol && (!bestH || score < bestH.score)) bestH = { ...h, score };
    }
    if (bestH) return { ...bestH, cursor: resizeCursor(bestH.angle) };
    const p = content(e);
    const inF = p.x >= s.F.l && p.x <= s.F.r && p.y >= s.F.t && p.y <= s.F.b;
    const inI = p.x >= s.I.l && p.x <= s.I.l + s.I.w && p.y >= s.I.t && p.y <= s.I.t + s.I.h;
    if (inF || inI) return { kind: "pan", cursor: "move" };
    return null;
  }

  function pointerDown(e) {
    if (!s) return false;
    const h = hit(e);
    if (!h) {
      end(true);
      return true;
    }
    const p = content(e);
    s.drag = { kind: h.kind, hx: h.hx, hy: h.hy, start: p, off: h.pt ? { x: h.pt.x - p.x, y: h.pt.y - p.y } : { x: 0, y: 0 }, F0: { ...s.F }, I0: { ...s.I } };
    core.setGestureCursor(h.kind === "pan" ? "grabbing" : h.cursor);
    core.interaction(true, "crop");
    return true;
  }

  function pointerMove(e) {
    if (!s) return;
    if (!s.drag) {
      const h = hit(e);
      core.setHoverCursor(h ? h.cursor : "default");
      return;
    }
    const d = s.drag;
    const p = content(e);
    const target = { x: p.x + d.off.x, y: p.y + d.off.y };
    if (d.kind === "pan") s.I = panImage(d.F0, d.I0, p.x - d.start.x, p.y - d.start.y);
    else if (d.kind === "image") s.I = scaleImage(d.F0, d.I0, d.hx, d.hy, target);
    else s.F = resizeFrame(d.F0, d.I0, d.hx, d.hy, target, { minSize: Math.max(1, 8 / core.viewport.zoom), keepAspect: e.shiftKey });
    apply();
  }

  function pointerUp() {
    if (!s?.drag) return;
    s.drag = null;
    core.setGestureCursor(null);
    core.interaction(false);
  }

  function keyDown(e) {
    if (!s) return false;
    if (e.key === "Enter" || e.key === "Escape") {
      end(true);
      return true;
    }
    // Apply the crop first so Delete gets its own undo step.
    if (e.key === "Delete" || e.key === "Backspace") {
      end(true);
      return false;
    }
    const step = e.shiftKey ? 10 : 1;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key] && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const [dx, dy] = moves[e.key];
      // Arrow keys move the picture in screen directions.
      const o = toLocal(s.l0, { x: 0, y: 0 });
      const q = toLocal(s.l0, { x: dx, y: dy });
      s.I = panImage(s.F, s.I, q.x - o.x, q.y - o.y);
      apply();
      return true;
    }
    return false;
  }

  // Canvas pass: dim everything outside the frame and show the whole picture
  // ghosted there. g has an identity transform (device px).
  function drawCanvas(g) {
    if (!s) return;
    const live = store.get(s.id);
    if (!live) return;
    const vp = core.viewport;
    const dpr = vp.dpr;
    const k = vp.zoom * dpr;
    const dev = (pt) => {
      const q = toScreen(pt);
      return { x: q.x * dpr, y: q.y * dpr };
    };
    const frame = framePoints().map(dev);
    const W = g.canvas.width;
    const H = g.canvas.height;
    const hole = () => {
      g.beginPath();
      g.rect(0, 0, W, H);
      g.moveTo(frame[0].x, frame[0].y);
      for (let i = 1; i < 4; i++) g.lineTo(frame[i].x, frame[i].y);
      g.closePath();
    };
    g.save();
    hole();
    g.fillStyle = "rgba(0, 0, 0, 0.58)";
    g.fill("evenodd");
    hole();
    g.clip("evenodd");
    g.setTransform(k, 0, 0, k, vp.panX * dpr, vp.panY * dpr);
    g.globalAlpha = 0.42;
    const c = fromLocal(s.l0, { x: s.I.l + s.I.w / 2, y: s.I.t + s.I.h / 2 });
    const ghost = {
      ...live,
      id: "crop-ghost",
      x: c.x,
      y: c.y,
      w: s.I.w,
      h: s.I.h,
      rotation: s.l0.rotation,
      flipX: s.l0.flipX,
      flipY: s.l0.flipY,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      frame: "rect",
      radius: 0,
      opacity: 1,
      blend: "normal",
      hidden: false,
      outline: { ...live.outline, on: false },
      shadow: { ...live.shadow, on: false },
      glow: { ...live.glow, on: false },
    };
    renderLayer(g, ghost, { scale: 1, assets: core.ctx.assets, cache: ghostCache });
    g.restore();
  }

  // SVG pass: frame, thirds, picture outline and handles.
  function drawOverlay(group) {
    if (!groups || groups.root !== group) {
      group.replaceChildren();
      groups = {
        root: group,
        image: group.appendChild(svg("path", { class: "ed-crop-image" })),
        grid: group.appendChild(svg("path", { class: "ed-crop-grid" })),
        frameHalo: group.appendChild(svg("path", { class: "ed-crop-frame-halo" })),
        frame: group.appendChild(svg("path", { class: "ed-crop-frame" })),
        bracketsHalo: group.appendChild(svg("path", { class: "ed-crop-bracket-halo" })),
        brackets: group.appendChild(svg("path", { class: "ed-crop-bracket" })),
        knobs: group.appendChild(svg("g", { class: "ed-crop-knobs" })),
      };
    }
    if (!s) {
      group.style.display = "none";
      return;
    }
    group.style.display = "";
    const poly = (pts) => `M${pts.map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join("L")}Z`;
    const F = s.F;
    const fs = framePoints().map(toScreen);
    groups.image.setAttribute("d", poly(imagePoints().map(toScreen)));
    groups.frame.setAttribute("d", poly(fs));
    groups.frameHalo.setAttribute("d", poly(fs));
    let grid = "";
    for (const f of [1 / 3, 2 / 3]) {
      const x = F.l + (F.r - F.l) * f;
      const y = F.t + (F.b - F.t) * f;
      const a = toScreen({ x, y: F.t });
      const b = toScreen({ x, y: F.b });
      const c = toScreen({ x: F.l, y });
      const d = toScreen({ x: F.r, y });
      grid += `M${a.x} ${a.y}L${b.x} ${b.y}M${c.x} ${c.y}L${d.x} ${d.y}`;
    }
    groups.grid.setAttribute("d", grid);
    // Brackets at the corners, bars on the sides, 16 px long on screen.
    const z = core.viewport.zoom;
    const fw = F.r - F.l;
    const fh = F.b - F.t;
    const lx = Math.min(16 / z, fw * 0.3);
    const ly = Math.min(16 / z, fh * 0.3);
    let br = "";
    for (const [, hx, hy] of FRAME_HANDLES) {
      const px = hx < 0 ? F.l : hx > 0 ? F.r : (F.l + F.r) / 2;
      const py = hy < 0 ? F.t : hy > 0 ? F.b : (F.t + F.b) / 2;
      if (hx && hy) {
        const a = toScreen({ x: px - hx * lx, y: py });
        const m = toScreen({ x: px, y: py });
        const b = toScreen({ x: px, y: py - hy * ly });
        br += `M${a.x} ${a.y}L${m.x} ${m.y}L${b.x} ${b.y}`;
      } else if (hx) {
        const a = toScreen({ x: px, y: py - ly * 0.6 });
        const b = toScreen({ x: px, y: py + ly * 0.6 });
        br += `M${a.x} ${a.y}L${b.x} ${b.y}`;
      } else {
        const a = toScreen({ x: px - lx * 0.6, y: py });
        const b = toScreen({ x: px + lx * 0.6, y: py });
        br += `M${a.x} ${a.y}L${b.x} ${b.y}`;
      }
    }
    groups.brackets.setAttribute("d", br);
    groups.bracketsHalo.setAttribute("d", br);
    const knobs = imagePoints().map(toScreen);
    const kids = [...groups.knobs.children];
    while (kids.length < 4) kids.push(groups.knobs.appendChild(svg("circle", { class: "ed-crop-knob", r: "5.5" })));
    knobs.forEach((p, i) => {
      kids[i].setAttribute("cx", p.x.toFixed(2));
      kids[i].setAttribute("cy", p.y.toFixed(2));
    });
  }

  return {
    get active() {
      return s ? s.id : null;
    },
    get dragging() {
      return !!s?.drag;
    },
    start,
    end,
    abort,
    pointerDown,
    pointerMove,
    pointerUp,
    keyDown,
    drawCanvas,
    drawOverlay,
    dispose() {
      ghostCache.dispose();
    },
  };
}
