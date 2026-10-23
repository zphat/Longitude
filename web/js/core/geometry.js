// Geometry for layers: matrices, bounds, hit testing and point refitting.
// Pure math with no DOM, except the small alpha maps used to hit test masked
// images, which are built lazily from a decoded mask when a canvas exists.
//
// Two local frames:
//   content space (layerMatrix / toLocal): box centred on 0,0, includes flips.
//     This is the frame the renderer draws in and that path/arrow points use.
//   box space (boxMatrix / toBox): same but without flips, for handles.

import { shapes, shapeParams } from "./shapes.js";

const RAD = Math.PI / 180;

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const px = (p) => (Array.isArray(p) ? p[0] : p.x);
const py = (p) => (Array.isArray(p) ? p[1] : p.y);

export function dist(a, b) {
  return Math.hypot(px(a) - px(b), py(a) - py(b));
}

export function normAngle(deg) {
  if (!Number.isFinite(deg)) return 0;
  let a = deg % 360;
  if (a <= -180) a += 360;
  else if (a > 180) a -= 360;
  return a === 0 ? 0 : a;
}

export function snapAngle(deg, step = 15) {
  if (!(step > 0)) return normAngle(deg);
  return normAngle(Math.round(deg / step) * step);
}

// Clockwise on screen (y points down), like ctx.rotate.
export function rotatePoint(pt, center, deg) {
  const r = deg * RAD;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const dx = px(pt) - px(center);
  const dy = py(pt) - py(center);
  return { x: px(center) + dx * c - dy * s, y: py(center) + dx * s + dy * c };
}

// ---- matrices ----------------------------------------------------------------

export class Mat {
  constructor(a = 1, b = 0, c = 0, d = 1, e = 0, f = 0) {
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    this.e = e;
    this.f = f;
  }

  static identity() {
    return new Mat();
  }

  static translate(x, y) {
    return new Mat(1, 0, 0, 1, x, y);
  }

  static rotate(deg) {
    const r = deg * RAD;
    const c = Math.cos(r);
    const s = Math.sin(r);
    return new Mat(c, s, -s, c, 0, 0);
  }

  static scale(sx, sy = sx) {
    return new Mat(sx, 0, 0, sy, 0, 0);
  }

  static from(m) {
    return new Mat(m.a, m.b, m.c, m.d, m.e, m.f);
  }

  // this x m: apply m first, then this.
  multiply(m) {
    return new Mat(
      this.a * m.a + this.c * m.b,
      this.b * m.a + this.d * m.b,
      this.a * m.c + this.c * m.d,
      this.b * m.c + this.d * m.d,
      this.a * m.e + this.c * m.f + this.e,
      this.b * m.e + this.d * m.f + this.f,
    );
  }

  invert() {
    const det = this.a * this.d - this.b * this.c;
    if (!det || !Number.isFinite(det)) return new Mat();
    const a = this.d / det;
    const b = -this.b / det;
    const c = -this.c / det;
    const d = this.a / det;
    return new Mat(a, b, c, d, -(a * this.e + c * this.f), -(b * this.e + d * this.f));
  }

  apply(pt) {
    const x = px(pt);
    const y = py(pt);
    return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f };
  }

  get isIdentity() {
    return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
  }

  toArray() {
    return [this.a, this.b, this.c, this.d, this.e, this.f];
  }
}

function trig(layer) {
  const r = (layer.rotation || 0) * RAD;
  return [Math.cos(r), Math.sin(r)];
}

// content space -> doc (translate, rotate, flip)
export function layerMatrix(layer) {
  const [c, s] = trig(layer);
  const fx = layer.flipX ? -1 : 1;
  const fy = layer.flipY ? -1 : 1;
  return new Mat(c * fx, s * fx, -s * fy, c * fy, layer.x, layer.y);
}

// box space -> doc (translate, rotate)
export function boxMatrix(layer) {
  const [c, s] = trig(layer);
  return new Mat(c, s, -s, c, layer.x, layer.y);
}

// doc -> content space
export function toLocal(layer, pt) {
  const [c, s] = trig(layer);
  const dx = px(pt) - layer.x;
  const dy = py(pt) - layer.y;
  let x = dx * c + dy * s;
  let y = -dx * s + dy * c;
  if (layer.flipX) x = -x;
  if (layer.flipY) y = -y;
  return { x, y };
}

// doc -> box space (no flips)
export function toBox(layer, pt) {
  const [c, s] = trig(layer);
  const dx = px(pt) - layer.x;
  const dy = py(pt) - layer.y;
  return { x: dx * c + dy * s, y: -dx * s + dy * c };
}

// content space -> doc
export function fromLocal(layer, pt) {
  const [c, s] = trig(layer);
  const x = layer.flipX ? -px(pt) : px(pt);
  const y = layer.flipY ? -py(pt) : py(pt);
  return { x: layer.x + x * c - y * s, y: layer.y + x * s + y * c };
}

// The box corners in doc space, clockwise from the box's own top-left (flips
// do not change the box, so they are ignored here).
export function corners(layer) {
  const [c, s] = trig(layer);
  const hw = layer.w / 2;
  const hh = layer.h / 2;
  const pt = (x, y) => ({ x: layer.x + x * c - y * s, y: layer.y + x * s + y * c });
  return [pt(-hw, -hh), pt(hw, -hh), pt(hw, hh), pt(-hw, hh)];
}

function box(l, t, r, b) {
  return { x: l, y: t, w: r - l, h: b - t, l, t, r, b, cx: (l + r) / 2, cy: (t + b) / 2 };
}

export function aabb(layer) {
  const [c, s] = trig(layer);
  const ac = Math.abs(c);
  const as = Math.abs(s);
  const hw = (layer.w * ac + layer.h * as) / 2;
  const hh = (layer.w * as + layer.h * ac) / 2;
  return box(layer.x - hw, layer.y - hh, layer.x + hw, layer.y + hh);
}

// Union of boxes ({l,t,r,b} or {x,y,w,h}); null for an empty list.
export function unionBox(boxes) {
  let l = Infinity;
  let t = Infinity;
  let r = -Infinity;
  let b = -Infinity;
  for (const bx of boxes || []) {
    if (!bx) continue;
    const bl = bx.l ?? bx.x;
    const bt = bx.t ?? bx.y;
    const br = bx.r ?? bx.x + bx.w;
    const bb = bx.b ?? bx.y + bx.h;
    if (![bl, bt, br, bb].every(Number.isFinite)) continue;
    l = Math.min(l, bl);
    t = Math.min(t, bt);
    r = Math.max(r, br);
    b = Math.max(b, bb);
  }
  return l === Infinity ? null : box(l, t, r, b);
}

// ---- curves and distances ----------------------------------------------------

export function quadPoint(a, c, b, t) {
  const u = 1 - t;
  return {
    x: u * u * px(a) + 2 * u * t * px(c) + t * t * px(b),
    y: u * u * py(a) + 2 * u * t * py(c) + t * t * py(b),
  };
}

// Control point so the quadratic a -> c -> b passes through m at t = 0.5
// (the bend handle sits at quadPoint(a, c, b, 0.5)).
export function quadThrough(a, m, b) {
  return { x: 2 * px(m) - (px(a) + px(b)) / 2, y: 2 * py(m) - (py(a) + py(b)) / 2 };
}

// The control point of the part of a -> c -> b between t0 and t1.
export function quadBlossom(a, c, b, t0, t1) {
  const k0 = (1 - t0) * (1 - t1);
  const k1 = (1 - t0) * t1 + t0 * (1 - t1);
  const k2 = t0 * t1;
  return { x: k0 * px(a) + k1 * px(c) + k2 * px(b), y: k0 * py(a) + k1 * py(c) + k2 * py(b) };
}

// Tight bounds of a quadratic curve.
export function quadBounds(a, c, b) {
  const xs = [px(a), px(b)];
  const ys = [py(a), py(b)];
  const ext = (p0, p1, p2) => {
    const den = p0 - 2 * p1 + p2;
    if (Math.abs(den) < 1e-12) return null;
    const t = (p0 - p1) / den;
    return t > 0 && t < 1 ? t : null;
  };
  const tx = ext(px(a), px(c), px(b));
  const ty = ext(py(a), py(c), py(b));
  for (const t of [tx, ty]) {
    if (t === null) continue;
    const p = quadPoint(a, c, b, t);
    xs.push(p.x);
    ys.push(p.y);
  }
  return box(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
}

function segDist2(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + dx * t - x;
  const ey = ay + dy * t - y;
  return ex * ex + ey * ey;
}

export function distToSegment(pt, a, b) {
  return Math.sqrt(segDist2(px(pt), py(pt), px(a), py(a), px(b), py(b)));
}

export function distToPolyline(pt, pts, closed = false) {
  const n = pts?.length || 0;
  if (!n) return Infinity;
  const x = px(pt);
  const y = py(pt);
  if (n === 1) return Math.hypot(x - px(pts[0]), y - py(pts[0]));
  let best = Infinity;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    const d = segDist2(x, y, px(p), py(p), px(q), py(q));
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

export function distToQuad(pt, a, c, b) {
  const x = px(pt);
  const y = py(pt);
  const N = 24;
  let bestT = 0;
  let best = Infinity;
  let prev = quadPoint(a, c, b, 0);
  for (let i = 1; i <= N; i++) {
    const t = i / N;
    const p = quadPoint(a, c, b, t);
    const d = segDist2(x, y, prev.x, prev.y, p.x, p.y);
    if (d < best) {
      best = d;
      bestT = t - 0.5 / N;
    }
    prev = p;
  }
  // Refine around the best segment with a ternary search on the true curve.
  let lo = Math.max(0, bestT - 1 / N);
  let hi = Math.min(1, bestT + 1 / N);
  const f = (t) => {
    const p = quadPoint(a, c, b, t);
    return (p.x - x) ** 2 + (p.y - y) ** 2;
  };
  for (let i = 0; i < 24; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (f(m1) < f(m2)) hi = m2;
    else lo = m1;
  }
  return Math.sqrt(Math.min(best, f((lo + hi) / 2)));
}

export function pointInPolygon(pt, poly) {
  const x = px(pt);
  const y = py(pt);
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = px(poly[i]);
    const yi = py(poly[i]);
    const xj = px(poly[j]);
    const yj = py(poly[j]);
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---- arrows ------------------------------------------------------------------

const arrowCache = new WeakMap();

function lerpPt(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function unit(dx, dy, fx = 1, fy = 0) {
  const l = Math.hypot(dx, dy);
  return l > 1e-9 ? { x: dx / l, y: dy / l } : { x: fx, y: fy };
}

// Arc-length table for a quadratic, used to find "distance d from an end".
function lengthTable(A, C, B, n = 48) {
  const ts = [0];
  const ls = [0];
  let prev = A;
  let total = 0;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const p = quadPoint(A, C, B, t);
    total += Math.hypot(p.x - prev.x, p.y - prev.y);
    ts.push(t);
    ls.push(total);
    prev = p;
  }
  return { ts, ls, total };
}

function tAtLength(table, len) {
  const { ts, ls, total } = table;
  if (len <= 0) return 0;
  if (len >= total) return 1;
  let i = 1;
  while (i < ls.length && ls[i] < len) i++;
  const span = ls[i] - ls[i - 1] || 1;
  return ts[i - 1] + ((len - ls[i - 1]) / span) * (ts[i] - ts[i - 1]);
}

// Shrinks a triangle toward its incentre by r, so filling it and stroking it
// with a round join of width 2r gives back the original outline with soft
// corners (the visible tip stays on the arrow's end point).
function insetTriangle(pts, r) {
  const [A, B, C] = pts;
  const a = Math.hypot(B.x - C.x, B.y - C.y);
  const b = Math.hypot(A.x - C.x, A.y - C.y);
  const c = Math.hypot(A.x - B.x, A.y - B.y);
  const per = a + b + c;
  const area = Math.abs((B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y)) / 2;
  const rho = per > 1e-9 ? (2 * area) / per : 0;
  if (rho < 1e-6) return pts;
  const I = { x: (a * A.x + b * B.x + c * C.x) / per, y: (a * A.y + b * B.y + c * C.y) / per };
  const k = Math.max(0.2, (rho - r) / rho);
  return pts.map((q) => ({ x: I.x + (q.x - I.x) * k, y: I.y + (q.y - I.y) * k }));
}

// Head or tail at `tip`, pointing away from `from`. Line caps are drawn with
// round joins of the arrow's width, so their apex sits half a width back.
function endCap(kind, tip, from, L, width) {
  if (kind === "none" || !kind) return { kind: "none" };
  if (kind === "dot") return { kind, center: tip, r: Math.max(width * 1.1, 3) };
  const d = unit(tip.x - from.x, tip.y - from.y);
  const n = { x: -d.y, y: d.x };
  if (kind === "line") {
    const apex = { x: tip.x - (d.x * width) / 2, y: tip.y - (d.y * width) / 2 };
    const back = L * 0.95;
    const half = L * 0.55;
    const bb = { x: apex.x - d.x * back, y: apex.y - d.y * back };
    return {
      kind,
      tip: apex,
      dir: d,
      lines: [
        [{ x: bb.x + n.x * half, y: bb.y + n.y * half }, apex],
        [{ x: bb.x - n.x * half, y: bb.y - n.y * half }, apex],
      ],
    };
  }
  const base = { x: tip.x - d.x * L, y: tip.y - d.y * L };
  const half = L * 0.52;
  const round = Math.max(1, width * 0.35);
  const raw = [tip, { x: base.x + n.x * half, y: base.y + n.y * half }, { x: base.x - n.x * half, y: base.y - n.y * half }];
  return { kind: "triangle", tip, dir: d, base, round, poly: insetTriangle(raw, round / 2) };
}

// Everything needed to draw or hit test an arrow, in content space.
export function arrowGeometry(layer) {
  const hit = arrowCache.get(layer);
  if (hit) return hit;
  const w = layer.w;
  const h = layer.h;
  const A = { x: (px(layer.a) - 0.5) * w, y: (py(layer.a) - 0.5) * h };
  const B = { x: (px(layer.b) - 0.5) * w, y: (py(layer.b) - 0.5) * h };
  const C = layer.c ? { x: (px(layer.c) - 0.5) * w, y: (py(layer.c) - 0.5) * h } : lerpPt(A, B, 0.5);
  const table = lengthTable(A, C, B);
  const len = table.total;
  const width = layer.width;
  const L = Math.max(Math.min(layer.headSize * width, len * 0.45), Math.min(width * 1.5, len * 0.45));
  const headKind = layer.head || "none";
  const tailKind = layer.tail || "none";
  // Orient each end along the chord over its last L of curve so curved
  // arrows point the way the eye expects.
  const tHeadBase = tAtLength(table, len - L);
  const tTailBase = tAtLength(table, L);
  const head = endCap(headKind, B, quadPoint(A, C, B, tHeadBase), L, width);
  const tail = endCap(tailKind, A, quadPoint(A, C, B, tTailBase), L, width);
  const back = (kind) => (kind === "triangle" ? L * 0.6 : kind === "line" ? width / 2 : 0);
  const t1 = tAtLength(table, len - back(headKind));
  const t0 = tAtLength(table, back(tailKind));
  const shaft = t1 > t0 ? { a: quadPoint(A, C, B, t0), c: quadBlossom(A, C, B, t0, t1), b: quadPoint(A, C, B, t1) } : null;
  const g = { A, B, C, curved: !!layer.c, len, L, width, head, tail, shaft };
  arrowCache.set(layer, g);
  return g;
}

// ---- hit testing --------------------------------------------------------------

const inBox = (p, hw, hh) => Math.abs(p.x) <= hw && Math.abs(p.y) <= hh;

function inRoundRect(p, hw, hh, r) {
  if (!inBox(p, hw, hh)) return false;
  r = Math.min(r, hw, hh);
  if (r <= 0) return true;
  const qx = Math.abs(p.x) - (hw - r);
  const qy = Math.abs(p.y) - (hh - r);
  if (qx <= 0 || qy <= 0) return true;
  return qx * qx + qy * qy <= r * r;
}

const outlineCache = new WeakMap();

// The polygon the shape is drawn with, in content space, inset by half the
// stroke the same way the renderer insets it. null when the shape has none.
export function shapeOutline(layer) {
  if (outlineCache.has(layer)) return outlineCache.get(layer);
  const def = shapes.get(layer.shape) || shapes.get("rect");
  let poly = null;
  if (def?.outline) {
    const sw = layer.stroke?.on ? layer.stroke.width : 0;
    const w = Math.max(1, layer.w - sw);
    const h = Math.max(1, layer.h - sw);
    const ref = sw ? { ...layer, radius: Math.max(0, (layer.radius || 0) - sw / 2) } : layer;
    try {
      poly = def.outline(w, h, shapeParams(layer, def), ref) || null;
    } catch (err) {
      console.error(err);
      poly = null;
    }
  }
  outlineCache.set(layer, poly);
  return poly;
}

let probeCtx;
function getProbe() {
  if (probeCtx !== undefined) return probeCtx;
  probeCtx = null;
  try {
    if (typeof OffscreenCanvas === "function") probeCtx = new OffscreenCanvas(4, 4).getContext("2d");
    if (!probeCtx && typeof document !== "undefined") probeCtx = document.createElement("canvas").getContext("2d");
  } catch {
    probeCtx = null;
  }
  return probeCtx;
}

function hitShape(layer, p, tol) {
  const fill = !!layer.fill?.on;
  const sw = layer.stroke?.on ? layer.stroke.width : 0;
  const hw = layer.w / 2;
  const hh = layer.h / 2;
  if (!fill && !sw) return inBox(p, hw + tol, hh + tol);
  const poly = shapeOutline(layer);
  if (poly && poly.length > 2) {
    if (fill && pointInPolygon(p, poly)) return true;
    const band = (sw ? sw / 2 : 0) + tol;
    return distToPolyline(p, poly, true) <= band;
  }
  // A mod shape without an outline: ask the canvas, else fall back to the box.
  const def = shapes.get(layer.shape);
  const ctx = getProbe();
  if (def && ctx && typeof Path2D === "function") {
    try {
      const path = def.path(Math.max(1, layer.w - sw), Math.max(1, layer.h - sw), shapeParams(layer, def), layer);
      if (fill && ctx.isPointInPath(path, p.x, p.y)) return true;
      ctx.lineWidth = sw + tol * 2;
      return ctx.isPointInStroke(path, p.x, p.y);
    } catch {
      return inBox(p, hw + tol, hh + tol);
    }
  }
  return inBox(p, hw + tol, hh + tol);
}

function hitPath(layer, p, tol) {
  const pts = layer.points;
  const n = pts?.length || 0;
  if (!n) return false;
  const w = layer.w;
  const h = layer.h;
  const r = layer.width / 2 + tol;
  const r2 = r * r;
  let ax = (pts[0][0] - 0.5) * w;
  let ay = (pts[0][1] - 0.5) * h;
  if (n === 1) return (p.x - ax) ** 2 + (p.y - ay) ** 2 <= r2;
  for (let i = 1; i < n; i++) {
    const bx = (pts[i][0] - 0.5) * w;
    const by = (pts[i][1] - 0.5) * h;
    if (segDist2(p.x, p.y, ax, ay, bx, by) <= r2) return true;
    ax = bx;
    ay = by;
  }
  return false;
}

function hitCap(cap, p, half, tol) {
  if (!cap || cap.kind === "none") return false;
  if (cap.kind === "dot") return Math.hypot(p.x - cap.center.x, p.y - cap.center.y) <= cap.r + tol;
  if (cap.kind === "line") return cap.lines.some(([q, t]) => distToSegment(p, q, t) <= half + tol);
  return pointInPolygon(p, cap.poly) || distToPolyline(p, cap.poly, true) <= tol + (cap.round || 0) / 2;
}

function hitArrow(layer, p, tol) {
  const g = arrowGeometry(layer);
  const half = layer.width / 2;
  if (distToQuad(p, g.A, g.C, g.B) <= half + tol) return true;
  return hitCap(g.head, p, half, tol) || hitCap(g.tail, p, half, tol);
}

// Small alpha maps of masks, built once per mask asset.
const alphaMaps = new Map();
const ALPHA_MAP_SIDE = 256;
const ALPHA_MAP_LIMIT = 48;

export function buildAlphaMap(source, maxSide = ALPHA_MAP_SIDE) {
  const sw = source?.width || 0;
  const sh = source?.height || 0;
  if (!sw || !sh) return null;
  const s = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * s));
  const h = Math.max(1, Math.round(sh * s));
  let ctx = null;
  try {
    if (typeof OffscreenCanvas === "function") ctx = new OffscreenCanvas(w, h).getContext("2d", { willReadFrequently: true });
    if (!ctx && typeof document !== "undefined") {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      ctx = c.getContext("2d", { willReadFrequently: true });
    }
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, w, h);
    const rgba = ctx.getImageData(0, 0, w, h).data;
    const data = new Uint8Array(w * h);
    for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4 + 3];
    return { w, h, data };
  } catch {
    return null;
  }
}

// Seed or replace the alpha map for a mask asset (for example right after a
// mask is created, so hit testing does not wait for a decode).
export function setAlphaMap(id, map) {
  if (!id) return;
  alphaMaps.delete(id);
  if (map) alphaMaps.set(id, map);
  while (alphaMaps.size > ALPHA_MAP_LIMIT) alphaMaps.delete(alphaMaps.keys().next().value);
}

export function clearHitCache() {
  alphaMaps.clear();
}

function alphaMapFor(id, assets) {
  const hit = alphaMaps.get(id);
  if (hit) {
    alphaMaps.delete(id);
    alphaMaps.set(id, hit);
    return hit;
  }
  const img = assets?.getImage?.(id);
  if (!img) return null;
  const map = buildAlphaMap(img);
  if (map) setAlphaMap(id, map);
  return map;
}

function sampleAlpha(map, x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= map.w || iy >= map.h) return 0;
  return map.data[iy * map.w + ix];
}

function hitImage(layer, p, tol, assets) {
  const hw = layer.w / 2;
  const hh = layer.h / 2;
  if (layer.frame === "ellipse") {
    const rx = hw + tol;
    const ry = hh + tol;
    if ((p.x * p.x) / (rx * rx) + (p.y * p.y) / (ry * ry) > 1) return false;
  } else if (!inRoundRect(p, hw + tol, hh + tol, layer.radius ? layer.radius + tol : 0)) {
    return false;
  }
  if (!layer.mask) return true;
  const map = alphaMapFor(layer.mask, assets);
  if (!map) return true;
  const crop = layer.crop || { x: 0, y: 0, w: 1, h: 1 };
  const u = crop.x + (p.x / layer.w + 0.5) * crop.w;
  const v = crop.y + (p.y / layer.h + 0.5) * crop.h;
  const mx = u * map.w;
  const my = v * map.h;
  if (sampleAlpha(map, mx, my) > 24) return true;
  const r = Math.min(8, (tol / layer.w) * crop.w * map.w);
  if (r < 0.05) return false;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    if (sampleAlpha(map, mx + Math.cos(a) * r, my + Math.sin(a) * r) > 24) return true;
  }
  return false;
}

// How far a layer's hittable area can reach outside its box.
function reach(layer) {
  if (layer.type === "arrow") return layer.width * Math.max(1, layer.headSize) + layer.width;
  if (layer.type === "path") return layer.width;
  return 0;
}

export function hitTest(layer, pt, { tol = 6, assets = null } = {}) {
  if (!layer || !(layer.w > 0) || !(layer.h > 0)) return false;
  const p = toLocal(layer, pt);
  const m = tol + reach(layer);
  if (Math.abs(p.x) > layer.w / 2 + m || Math.abs(p.y) > layer.h / 2 + m) return false;
  switch (layer.type) {
    case "image":
      return hitImage(layer, p, tol, assets);
    case "shape":
      return hitShape(layer, p, tol);
    case "path":
      return hitPath(layer, p, tol);
    case "arrow":
      return hitArrow(layer, p, tol);
    default:
      return inBox(p, layer.w / 2 + tol, layer.h / 2 + tol);
  }
}

export function pickLayer(doc, pt, { tol = 6, assets = null, includeLocked = false, includeHidden = false } = {}) {
  const layers = doc?.layers || [];
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (l.hidden && !includeHidden) continue;
    if (l.locked && !includeLocked) continue;
    if (hitTest(l, pt, { tol, assets })) return l;
  }
  return null;
}

// Separating-axis test between a layer's rotated box and an axis-aligned rect.
function boxIntersectsRect(layer, l, t, r, b) {
  const bb = aabb(layer);
  if (bb.r < l || bb.l > r || bb.b < t || bb.t > b) return false;
  if (Math.abs(layer.rotation || 0) % 90 === 0) return true;
  const [c, s] = trig(layer);
  const rect = [
    { x: l, y: t },
    { x: r, y: t },
    { x: r, y: b },
    { x: l, y: b },
  ];
  const axes = [
    { x: c, y: s },
    { x: -s, y: c },
  ];
  const hw = layer.w / 2;
  const hh = layer.h / 2;
  for (const ax of axes) {
    const center = layer.x * ax.x + layer.y * ax.y;
    const ext = ax === axes[0] ? hw : hh;
    let min = Infinity;
    let max = -Infinity;
    for (const p of rect) {
      const d = p.x * ax.x + p.y * ax.y;
      min = Math.min(min, d);
      max = Math.max(max, d);
    }
    if (max < center - ext || min > center + ext) return false;
  }
  return true;
}

// Marquee selection: visible, unlocked layers whose box touches the rect.
// rect: { x, y, w, h } (w/h may be negative) or { l, t, r, b }.
export function layersInRect(doc, rect) {
  if (!rect) return [];
  let l = rect.l ?? rect.x;
  let t = rect.t ?? rect.y;
  let r = rect.r ?? rect.x + rect.w;
  let b = rect.b ?? rect.y + rect.h;
  if (![l, t, r, b].every(Number.isFinite)) return [];
  if (r < l) [l, r] = [r, l];
  if (b < t) [t, b] = [b, t];
  return (doc?.layers || []).filter((layer) => !layer.hidden && !layer.locked && boxIntersectsRect(layer, l, t, r, b));
}

// ---- points --------------------------------------------------------------------

const round5 = (v) => Math.round(v * 1e5) / 1e5;

export function defaultPad(layer) {
  return Math.max((layer?.width || 0) * 1.5, 8);
}

// Fit a new box around doc-space points ({x,y,p?} or [x,y,p?]) keeping the
// layer's rotation and flips. Returns the box and the points normalised to it
// ([u, v] or [u, v, p] when the input had pressure).
export function refitPoints(layer, docPoints, pad = defaultPad(layer)) {
  const rot = layer?.rotation || 0;
  const cx = Number.isFinite(layer?.x) ? layer.x : 0;
  const cy = Number.isFinite(layer?.y) ? layer.y : 0;
  const frame = { x: cx, y: cy, rotation: rot };
  const qs = (docPoints || []).map((p) => {
    const q = toBox(frame, p);
    const pr = Array.isArray(p) ? p[2] : p.p;
    return { x: q.x, y: q.y, p: pr };
  });
  if (!qs.length) return { x: cx, y: cy, w: Math.max(1, pad * 2), h: Math.max(1, pad * 2), points: [] };
  let l = Infinity;
  let t = Infinity;
  let r = -Infinity;
  let b = -Infinity;
  for (const q of qs) {
    l = Math.min(l, q.x);
    t = Math.min(t, q.y);
    r = Math.max(r, q.x);
    b = Math.max(b, q.y);
  }
  l -= pad;
  t -= pad;
  r += pad;
  b += pad;
  const w = Math.max(1, r - l);
  const h = Math.max(1, b - t);
  const mid = rotatePoint({ x: (l + r) / 2, y: (t + b) / 2 }, { x: 0, y: 0 }, rot);
  const points = qs.map((q) => {
    let u = (q.x - l) / w;
    let v = (q.y - t) / h;
    if (layer?.flipX) u = 1 - u;
    if (layer?.flipY) v = 1 - v;
    const out = [round5(u), round5(v)];
    if (Number.isFinite(q.p)) out.push(Math.round(Math.min(1, Math.max(0, q.p)) * 1000) / 1000);
    return out;
  });
  return { x: cx + mid.x, y: cy + mid.y, w, h, points };
}

// Normalised points -> doc space ({ x, y } plus p when present).
export function pointsToDoc(layer, normPoints) {
  return (normPoints || []).map((n) => {
    const u = Array.isArray(n) ? n[0] : n.x;
    const v = Array.isArray(n) ? n[1] : n.y;
    const p = fromLocal(layer, { x: (u - 0.5) * layer.w, y: (v - 0.5) * layer.h });
    const pr = Array.isArray(n) ? n[2] : n.p;
    if (Number.isFinite(pr)) p.p = pr;
    return p;
  });
}

// Refit an arrow from doc-space endpoints (and optional control point) using
// the curve's true bounds, so a bent arrow's box hugs the curve rather than
// the control point. Pads by max(width * 1.5, 8, half the head width).
export function refitArrow(layer, { a, b, c = null }) {
  const rot = layer?.rotation || 0;
  const cx = Number.isFinite(layer?.x) ? layer.x : 0;
  const cy = Number.isFinite(layer?.y) ? layer.y : 0;
  const frame = { x: cx, y: cy, rotation: rot };
  const qa = toBox(frame, a);
  const qb = toBox(frame, b);
  const qc = c ? toBox(frame, c) : null;
  const bb = qc ? quadBounds(qa, qc, qb) : box(Math.min(qa.x, qb.x), Math.min(qa.y, qb.y), Math.max(qa.x, qb.x), Math.max(qa.y, qb.y));
  const width = layer?.width || 0;
  const head = layer?.head && layer.head !== "none" ? (layer.headSize || 3.2) * width * 0.55 : 0;
  const pad = Math.max(width * 1.5, 8, head);
  const l = bb.l - pad;
  const t = bb.t - pad;
  const w = Math.max(1, bb.r + pad - l);
  const h = Math.max(1, bb.b + pad - t);
  const mid = rotatePoint({ x: l + w / 2, y: t + h / 2 }, { x: 0, y: 0 }, rot);
  const norm = (q) => {
    let u = (q.x - l) / w;
    let v = (q.y - t) / h;
    if (layer?.flipX) u = 1 - u;
    if (layer?.flipY) v = 1 - v;
    return [round5(u), round5(v)];
  };
  return { x: cx + mid.x, y: cy + mid.y, w, h, a: norm(qa), b: norm(qb), c: qc ? norm(qc) : null };
}

// Doc-space endpoints of an arrow layer: { a, b, c|null, mid } where mid is the
// bend handle position (on the curve at t = 0.5).
export function arrowPoints(layer) {
  const toDoc = (n) => fromLocal(layer, { x: (n[0] - 0.5) * layer.w, y: (n[1] - 0.5) * layer.h });
  const a = toDoc(layer.a);
  const b = toDoc(layer.b);
  const c = layer.c ? toDoc(layer.c) : null;
  const mid = c ? quadPoint(a, c, b, 0.5) : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return { a, b, c, mid };
}
