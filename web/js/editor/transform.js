// Transform maths for the select tool: resizing with the per-type rules,
// group scaling, rotation and arrow handles. Every function works from the
// layer as it was when the drag started (so a drag never drifts) and returns
// props for store.patch().
//
// Rules (SPEC 8): text corners scale the font size, text sides set a fixed
// wrap width; image corners keep the aspect (Shift frees it) and image sides
// crop; shapes and paths resize freely (Shift keeps the aspect); Alt resizes
// from the center. Handles live in the layer's box frame (rotation, no flips).

import { toBox, boxMatrix, snapAngle, normAngle, refitArrow, arrowPoints, quadThrough, dist } from "../core/geometry.js";
import { measureBox } from "../core/textlayout.js";

const RAD = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round2 = (v) => Math.round(v * 100) / 100;

// [hx, hy] of each handle in the box frame.
export const HANDLES = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
};

export const CORNER_IDS = ["nw", "ne", "se", "sw"];

export function isCorner(handle) {
  const v = HANDLES[handle];
  return !!v && v[0] !== 0 && v[1] !== 0;
}

// The resize handles a single layer shows.
export function handlesFor(layer) {
  if (!layer || layer.locked || layer.type === "arrow") return [];
  if (layer.type === "text") return ["nw", "ne", "se", "sw", "e", "w"];
  return ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
}

// Resize a w x h box centered on 0,0 by dragging `handle`. grab and q are the
// pointer at the start and now, in the box frame. snapX/snapY receive the
// dragged edge positions (box frame) and return { i, d } (index of the edge
// that snapped and the offset to add) or null. Returns the new size and center.
export function resizeBox(w, h, handle, grab, q, opts = {}) {
  const { keepAspect = false, fromCenter = false, minW = 1, minH = 1, maxW = Infinity, maxH = Infinity, snapX = null, snapY = null } = opts;
  const [hx, hy] = HANDLES[handle] || [0, 0];
  const hw = w / 2;
  const hh = h / 2;
  let ex = hx ? hx * hw + (q.x - grab.x) : 0;
  let ey = hy ? hy * hh + (q.y - grab.y) : 0;
  let snapDX = null;
  let snapDY = null;
  if (hx && snapX) {
    const s = snapX(fromCenter ? [ex, -ex] : [ex]);
    if (s) {
      ex += s.i === 1 ? -s.d : s.d;
      snapDX = Math.abs(s.d);
    }
  }
  if (hy && snapY) {
    const s = snapY(fromCenter ? [ey, -ey] : [ey]);
    if (s) {
      ey += s.i === 1 ? -s.d : s.d;
      snapDY = Math.abs(s.d);
    }
  }
  let nw = w;
  let nh = h;
  if (hx) nw = fromCenter ? 2 * hx * ex : hx * ex + hw;
  if (hy) nh = fromCenter ? 2 * hy * ey : hy * ey + hh;
  if (keepAspect && w > 0 && h > 0) {
    let s;
    if (hx && hy) {
      const sx = nw / w;
      const sy = nh / h;
      if (snapDX !== null && (snapDY === null || snapDX <= snapDY)) s = sx;
      else if (snapDY !== null) s = sy;
      else s = Math.max(sx, sy);
    } else {
      s = hx ? nw / w : nh / h;
    }
    s = Math.min(Math.max(s, minW / w, minH / h), maxW / w, maxH / h);
    nw = w * s;
    nh = h * s;
  } else {
    if (hx) nw = clamp(nw, minW, Math.max(minW, maxW));
    if (hy) nh = clamp(nh, minH, Math.max(minH, maxH));
  }
  const cx = hx && !fromCenter ? -hx * hw + (hx * nw) / 2 : 0;
  const cy = hy && !fromCenter ? -hy * hh + (hy * nh) / 2 : 0;
  return { cx, cy, w: nw, h: nh, sx: w ? nw / w : 1, sy: h ? nh / h : 1 };
}

// ---- scaling helpers -------------------------------------------------------------

function scaleEffects(layer, s) {
  const out = {};
  if (layer.shadow) {
    out.shadow = {
      ...layer.shadow,
      blur: round2(clamp(layer.shadow.blur * s, 0, 400)),
      dx: round2(clamp(layer.shadow.dx * s, -2000, 2000)),
      dy: round2(clamp(layer.shadow.dy * s, -2000, 2000)),
    };
  }
  if (layer.glow) out.glow = { ...layer.glow, size: round2(clamp(layer.glow.size * s, 0, 400)) };
  return out;
}

// Text props scaled by s, so the text looks the same at a new size: font
// size, outlines, the background pill and the effects all grow together.
export function scaleTextProps(layer, s) {
  const p = { size: round2(clamp(layer.size * s, 4, 4000)) };
  if (layer.stroke) p.stroke = { ...layer.stroke, width: round2(clamp(layer.stroke.width * s, 0, 400)) };
  if (layer.stroke2) p.stroke2 = { ...layer.stroke2, width: round2(clamp(layer.stroke2.width * s, 0, 400)) };
  if (layer.bg) {
    p.bg = {
      ...layer.bg,
      padX: round2(clamp(layer.bg.padX * s, 0, 2000)),
      padY: round2(clamp(layer.bg.padY * s, 0, 2000)),
      radius: round2(clamp(layer.bg.radius * s, 0, 1e4)),
    };
  }
  Object.assign(p, scaleEffects(layer, s));
  if (layer.wrap === "fixed") p.w = round2(layer.w * s);
  return p;
}

function measured(layer, props) {
  const m = measureBox({ ...layer, ...props });
  return { w: round2(m.w), h: round2(m.h) };
}

// Everything about a layer scaled by s around its own center (group scaling).
export function scaleLayerProps(layer, s) {
  const fx = scaleEffects(layer, s);
  switch (layer.type) {
    case "text": {
      const p = scaleTextProps(layer, s);
      return { ...p, ...measured(layer, p) };
    }
    case "image":
      return {
        w: layer.w * s,
        h: layer.h * s,
        radius: round2(layer.radius * s),
        outline: layer.outline ? { ...layer.outline, width: round2(clamp(layer.outline.width * s, 0, 400)) } : undefined,
        ...fx,
      };
    case "shape":
      return {
        w: layer.w * s,
        h: layer.h * s,
        radius: round2(layer.radius * s),
        stroke: layer.stroke ? { ...layer.stroke, width: round2(clamp(layer.stroke.width * s, 0, 400)) } : undefined,
        ...fx,
      };
    case "path":
    case "arrow":
      return { w: layer.w * s, h: layer.h * s, width: round2(clamp(layer.width * s, 0.5, 1000)), ...fx };
    default:
      return { w: layer.w * s, h: layer.h * s, ...fx };
  }
}

// ---- single layer resize -------------------------------------------------------------

function textCorner(layer, handle, grab, q, o) {
  const r = resizeBox(layer.w, layer.h, handle, grab, q, { keepAspect: true, fromCenter: o.alt, minW: 4, minH: 4, snapX: o.snapX, snapY: o.snapY });
  const size = clamp(layer.size * r.sx, 4, 4000);
  const props = scaleTextProps(layer, size / layer.size);
  const { w, h } = measured(layer, props);
  const [hx, hy] = HANDLES[handle];
  const cx = o.alt ? 0 : (-hx * layer.w) / 2 + (hx * w) / 2;
  const cy = o.alt ? 0 : (-hy * layer.h) / 2 + (hy * h) / 2;
  const c = boxMatrix(layer).apply({ x: cx, y: cy });
  return { ...props, w, h, x: c.x, y: c.y };
}

// Left/right on text: a fixed wrap width. The top edge stays put while the
// text reflows.
function textSide(layer, handle, grab, q, o) {
  const r = resizeBox(layer.w, layer.h, handle, grab, q, { fromCenter: o.alt, minW: 8, snapX: o.snapX });
  let fw = round2(r.w);
  // An auto-width layer stores its width rounded, up to 0.005 under its
  // longest line. A wrap width at least that wide must not break the line.
  if (layer.wrap !== "fixed" && fw >= layer.w) fw = Math.max(fw, Math.ceil((measureBox(layer).w + 1e-6) * 100) / 100);
  const { w, h } = measured(layer, { wrap: "fixed", w: fw });
  const [hx] = HANDLES[handle];
  const cx = o.alt ? 0 : (-hx * layer.w) / 2 + (hx * w) / 2;
  const cy = -layer.h / 2 + h / 2;
  const c = boxMatrix(layer).apply({ x: cx, y: cy });
  return { wrap: "fixed", w, h, x: c.x, y: c.y };
}

// Sides on an image crop it: the picture keeps its scale and position while
// the frame edge moves, and the frame can not grow past the picture.
function imageSide(layer, handle, grab, q, o) {
  const [hx, hy] = HANDLES[handle];
  const c0 = layer.crop;
  const opts = { fromCenter: o.alt, minW: o.minSize, minH: o.minSize, snapX: o.snapX, snapY: o.snapY };
  const ux = layer.w / c0.w;
  const uy = layer.h / c0.h;
  const dirX = layer.flipX ? -hx : hx;
  const dirY = layer.flipY ? -hy : hy;
  if (hx) {
    opts.maxW = o.alt ? 2 * ux * Math.min(c0.x + c0.w / 2, 1 - c0.x - c0.w / 2) : dirX > 0 ? (1 - c0.x) * ux : (c0.x + c0.w) * ux;
    opts.maxW = Math.max(opts.maxW, layer.w);
  }
  if (hy) {
    opts.maxH = o.alt ? 2 * uy * Math.min(c0.y + c0.h / 2, 1 - c0.y - c0.h / 2) : dirY > 0 ? (1 - c0.y) * uy : (c0.y + c0.h) * uy;
    opts.maxH = Math.max(opts.maxH, layer.h);
  }
  const r = resizeBox(layer.w, layer.h, handle, grab, q, opts);
  const crop = { ...c0 };
  if (hx) {
    const cw = clamp(r.w / ux, 0.001, 1);
    crop.w = cw;
    crop.x = o.alt ? c0.x + (c0.w - cw) / 2 : dirX > 0 ? c0.x : c0.x + c0.w - cw;
  }
  if (hy) {
    const ch = clamp(r.h / uy, 0.001, 1);
    crop.h = ch;
    crop.y = o.alt ? c0.y + (c0.h - ch) / 2 : dirY > 0 ? c0.y : c0.y + c0.h - ch;
  }
  crop.x = clamp(crop.x, 0, Math.max(0, 1 - crop.w));
  crop.y = clamp(crop.y, 0, Math.max(0, 1 - crop.h));
  const c = boxMatrix(layer).apply({ x: r.cx, y: r.cy });
  return { x: c.x, y: c.y, w: r.w, h: r.h, crop };
}

// Resize one layer. grabDoc: pointer at drag start; pDoc: pointer now (doc).
// opts: { shift, alt, minSize, snapX, snapY } (snap functions in box frame).
export function resizeLayer(layer, handle, grabDoc, pDoc, opts = {}) {
  const o = { shift: false, alt: false, minSize: 1, snapX: null, snapY: null, ...opts };
  const grab = toBox(layer, grabDoc);
  const q = toBox(layer, pDoc);
  const corner = isCorner(handle);
  if (layer.type === "text") return corner ? textCorner(layer, handle, grab, q, o) : textSide(layer, handle, grab, q, o);
  if (layer.type === "image" && !corner) return imageSide(layer, handle, grab, q, o);
  const keepAspect = layer.type === "image" ? !o.shift : o.shift;
  const r = resizeBox(layer.w, layer.h, handle, grab, q, {
    keepAspect,
    fromCenter: o.alt,
    minW: o.minSize,
    minH: o.minSize,
    snapX: o.snapX,
    snapY: o.snapY,
  });
  const c = boxMatrix(layer).apply({ x: r.cx, y: r.cy });
  return { x: c.x, y: c.y, w: r.w, h: r.h };
}

// ---- groups -------------------------------------------------------------------------

// Scale several layers by a corner of their union box `box` ({ l, t, r, b }).
// Always keeps the aspect. Returns { props: Map(id -> props), scale, box }.
export function scaleGroup(layers, box, handle, grabDoc, pDoc, opts = {}) {
  const center = { x: (box.l + box.r) / 2, y: (box.t + box.b) / 2 };
  const W = Math.max(1e-6, box.r - box.l);
  const H = Math.max(1e-6, box.b - box.t);
  const grab = { x: grabDoc.x - center.x, y: grabDoc.y - center.y };
  const q = { x: pDoc.x - center.x, y: pDoc.y - center.y };
  const min = opts.minSize || 1;
  const r = resizeBox(W, H, handle, grab, q, { keepAspect: true, fromCenter: !!opts.alt, minW: min, minH: min, snapX: opts.snapX, snapY: opts.snapY });
  const s = r.sx;
  const nc = { x: center.x + r.cx, y: center.y + r.cy };
  const props = new Map();
  for (const l of layers) {
    const p = scaleLayerProps(l, s);
    p.x = nc.x + (l.x - center.x) * s;
    p.y = nc.y + (l.y - center.y) * s;
    props.set(l.id, p);
  }
  return { props, scale: s, box: { l: nc.x - r.w / 2, t: nc.y - r.h / 2, r: nc.x + r.w / 2, b: nc.y + r.h / 2 } };
}

// ---- rotation ----------------------------------------------------------------------

// The angle when dragging the rotation knob from `start` to `now` around
// `center`. Snaps to 45° multiples within 3°, or to 15° steps with Shift.
export function rotateFrom(center, start, now, rotation0, { shift = false } = {}) {
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  const a1 = Math.atan2(now.y - center.y, now.x - center.x);
  let deg = rotation0 + (a1 - a0) / RAD;
  if (shift) return snapAngle(deg, 15);
  const near = Math.round(deg / 45) * 45;
  if (Math.abs(deg - near) <= 3) deg = near;
  return normAngle(Math.round(deg * 100) / 100);
}

// ---- arrows -------------------------------------------------------------------------

// p moved to the nearest `step`° direction from origin, keeping its distance.
export function constrainAngle(origin, p, step = 15) {
  const len = dist(origin, p);
  const ang = Math.round(Math.atan2(p.y - origin.y, p.x - origin.x) / RAD / step) * step * RAD;
  return { x: origin.x + Math.cos(ang) * len, y: origin.y + Math.sin(ang) * len };
}

// Move one end ("a" tail or "b" tip) of an arrow to doc point p. A bend keeps
// its shape: it turns and scales with the moved end around the fixed one.
export function moveArrowEnd(layer, which, p) {
  const { a, b, c } = arrowPoints(layer);
  const fixed = which === "a" ? b : a;
  const moving = which === "a" ? a : b;
  let nc = c;
  if (c) {
    const v0x = moving.x - fixed.x;
    const v0y = moving.y - fixed.y;
    const l0 = Math.hypot(v0x, v0y);
    if (l0 > 1e-6) {
      const k = Math.hypot(p.x - fixed.x, p.y - fixed.y) / l0;
      const ang = Math.atan2(p.y - fixed.y, p.x - fixed.x) - Math.atan2(v0y, v0x);
      const co = Math.cos(ang) * k;
      const si = Math.sin(ang) * k;
      const dx = c.x - fixed.x;
      const dy = c.y - fixed.y;
      nc = { x: fixed.x + dx * co - dy * si, y: fixed.y + dx * si + dy * co };
    }
  }
  return refitArrow(layer, which === "a" ? { a: p, b, c: nc } : { a, b: p, c: nc });
}

// Drag the bend handle (on the curve at its middle) to p. Close to the
// straight line's middle (within straightTol doc px) the arrow straightens.
export function bendArrow(layer, p, { straightTol = 0 } = {}) {
  const { a, b } = arrowPoints(layer);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  if (dist(p, mid) <= straightTol) return refitArrow(layer, { a, b, c: null });
  return refitArrow(layer, { a, b, c: quadThrough(a, p, b) });
}
