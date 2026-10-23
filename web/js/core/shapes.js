// Shape registry. Each shape draws itself as a Path2D in local coordinates
// (box centered on 0,0) and, optionally, describes the same outline as a
// polygon so hit testing and previews work without a canvas. Mods add shapes
// with shapes.register({ id, label, icon, path, outline?, defaults?, params? }).

import { createRegistry } from "../app/context.js";

export const shapes = createRegistry("shapes", {
  validate(def) {
    if (typeof def.path !== "function") throw Error(`shapes: "${def.id}" needs path()`);
    if (typeof def.label !== "string" || !def.label.trim()) throw Error(`shapes: "${def.id}" needs a label`);
  },
});

const TAU = Math.PI * 2;

// Rounded corners for a closed polygon, shared by path() and outline() so the
// drawn shape and the hit-test outline agree. radii: number or per-corner list.
function corners(pts, radii) {
  const n = pts.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const r = Array.isArray(radii) ? radii[i] || 0 : radii || 0;
    if (r <= 0) {
      out.push({ p, r: 0 });
      continue;
    }
    const a = pts[(i + n - 1) % n];
    const b = pts[(i + 1) % n];
    const la = Math.hypot(a.x - p.x, a.y - p.y);
    const lb = Math.hypot(b.x - p.x, b.y - p.y);
    if (la < 1e-6 || lb < 1e-6) {
      out.push({ p, r: 0 });
      continue;
    }
    const ux = (a.x - p.x) / la;
    const uy = (a.y - p.y) / la;
    const vx = (b.x - p.x) / lb;
    const vy = (b.y - p.y) / lb;
    const theta = Math.acos(Math.max(-1, Math.min(1, ux * vx + uy * vy)));
    if (theta < 1e-3 || Math.PI - theta < 1e-3) {
      out.push({ p, r: 0 });
      continue;
    }
    const tanHalf = Math.tan(theta / 2);
    const d = Math.min(r / tanHalf, la / 2, lb / 2);
    const rr = d * tanHalf;
    const bx = ux + vx;
    const by = uy + vy;
    const bl = Math.hypot(bx, by) || 1;
    const cd = rr / Math.sin(theta / 2);
    const c = { x: p.x + (bx / bl) * cd, y: p.y + (by / bl) * cd };
    const t1 = { x: p.x + ux * d, y: p.y + uy * d };
    const t2 = { x: p.x + vx * d, y: p.y + vy * d };
    const a1 = Math.atan2(t1.y - c.y, t1.x - c.x);
    const a2 = Math.atan2(t2.y - c.y, t2.x - c.x);
    const cross = (t1.x - c.x) * (t2.y - c.y) - (t1.y - c.y) * (t2.x - c.x);
    out.push({ p, r: rr, c, t1, t2, a1, a2, ccw: cross < 0 });
  }
  return out;
}

export function polygonPath(pts, radii = 0, path = new Path2D()) {
  const cs = corners(pts, radii);
  cs.forEach((k, i) => {
    if (!k.r) {
      if (i === 0) path.moveTo(k.p.x, k.p.y);
      else path.lineTo(k.p.x, k.p.y);
      return;
    }
    if (i === 0) path.moveTo(k.t1.x, k.t1.y);
    else path.lineTo(k.t1.x, k.t1.y);
    path.arc(k.c.x, k.c.y, k.r, k.a1, k.a2, k.ccw);
  });
  path.closePath();
  return path;
}

export function polygonOutline(pts, radii = 0, segs = 6) {
  const out = [];
  for (const k of corners(pts, radii)) {
    if (!k.r) {
      out.push({ x: k.p.x, y: k.p.y });
      continue;
    }
    let sweep = k.a2 - k.a1;
    if (k.ccw && sweep > 0) sweep -= TAU;
    if (!k.ccw && sweep < 0) sweep += TAU;
    for (let s = 0; s <= segs; s++) {
      const a = k.a1 + (sweep * s) / segs;
      out.push({ x: k.c.x + Math.cos(a) * k.r, y: k.c.y + Math.sin(a) * k.r });
    }
  }
  return out;
}

const rectPts = (w, h) => [
  { x: -w / 2, y: -h / 2 },
  { x: w / 2, y: -h / 2 },
  { x: w / 2, y: h / 2 },
  { x: -w / 2, y: h / 2 },
];

const rectRadius = (w, h, layer) => Math.max(0, Math.min(Number(layer?.radius) || 0, w / 2, h / 2));

const trianglePts = (w, h) => [
  { x: 0, y: -h / 2 },
  { x: w / 2, y: h / 2 },
  { x: -w / 2, y: h / 2 },
];

// Star points on a unit circle, then stretched so the polygon fills the box.
const starCache = new Map();
function starPts(w, h, points, inner) {
  const n = Math.max(3, Math.min(64, Math.round(points) || 5));
  const k = Math.max(0.05, Math.min(0.98, Number(inner) || 0.45));
  const key = `${n}|${k}`;
  let unit = starCache.get(key);
  if (!unit) {
    const raw = [];
    for (let i = 0; i < n * 2; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / n;
      const r = i % 2 ? k : 1;
      raw.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
    }
    let l = Infinity;
    let t = Infinity;
    let rr = -Infinity;
    let b = -Infinity;
    for (const p of raw) {
      l = Math.min(l, p.x);
      t = Math.min(t, p.y);
      rr = Math.max(rr, p.x);
      b = Math.max(b, p.y);
    }
    unit = raw.map((p) => ({ x: (p.x - (l + rr) / 2) / (rr - l), y: (p.y - (t + b) / 2) / (b - t) }));
    if (starCache.size > 64) starCache.clear();
    starCache.set(key, unit);
  }
  return unit.map((p) => ({ x: p.x * w, y: p.y * h }));
}

function bubbleGeom(w, h, params, layer) {
  const bodyH = h * 0.78;
  const top = -h / 2;
  const bottom = top + bodyH;
  const given = Number(layer?.radius) || 0;
  const r = Math.max(0, Math.min(given > 0 ? given : Math.min(w, bodyH) * 0.3, w / 2, bodyH / 2));
  const tail = Math.max(0, Math.min(1, Number(params?.tail ?? 0.28)));
  const tw = Math.max(2, Math.min(w * 0.09, bodyH * 0.3));
  let bx = -w / 2 + w * tail;
  const lo = -w / 2 + r + tw;
  const hi = w / 2 - r - tw;
  bx = lo <= hi ? Math.max(lo, Math.min(hi, bx)) : 0;
  const dir = tail <= 0.5 ? -1 : 1;
  const tipX = Math.max(-w / 2, Math.min(w / 2, bx + dir * tw * 1.6));
  const pts = [
    { x: -w / 2, y: top },
    { x: w / 2, y: top },
    { x: w / 2, y: bottom },
    { x: bx + tw, y: bottom },
    { x: tipX, y: h / 2 },
    { x: bx - tw, y: bottom },
    { x: -w / 2, y: bottom },
  ];
  const radii = [r, r, r, tw * 0.5, 0, tw * 0.5, r];
  return { pts, radii };
}

function ellipseOutline(w, h, n = 64) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    out.push({ x: (Math.cos(a) * w) / 2, y: (Math.sin(a) * h) / 2 });
  }
  return out;
}

const BUILT_INS = [
  {
    id: "rect",
    label: "Rectangle",
    icon: "square",
    path: (w, h, params, layer) => polygonPath(rectPts(w, h), rectRadius(w, h, layer)),
    outline: (w, h, params, layer) => polygonOutline(rectPts(w, h), rectRadius(w, h, layer)),
  },
  {
    id: "ellipse",
    label: "Ellipse",
    icon: "circle",
    path(w, h) {
      const p = new Path2D();
      p.ellipse(0, 0, w / 2, h / 2, 0, 0, TAU);
      return p;
    },
    outline: (w, h) => ellipseOutline(w, h),
  },
  {
    id: "triangle",
    label: "Triangle",
    icon: "triangle",
    path: (w, h, params, layer) => polygonPath(trianglePts(w, h), Math.min(Number(layer?.radius) || 0, Math.min(w, h) / 3)),
    outline: (w, h, params, layer) => polygonOutline(trianglePts(w, h), Math.min(Number(layer?.radius) || 0, Math.min(w, h) / 3)),
  },
  {
    id: "star",
    label: "Star",
    icon: "star",
    defaults: { fill: { on: true, color: "#ffe14d" }, params: { points: 5, inner: 0.45 } },
    params: [
      { key: "points", label: "Points", min: 3, max: 24, step: 1, default: 5 },
      { key: "inner", label: "Inner size", min: 0.1, max: 0.95, step: 0.01, default: 0.45 },
    ],
    path: (w, h, params, layer) => polygonPath(starPts(w, h, params?.points ?? 5, params?.inner ?? 0.45), Math.min(Number(layer?.radius) || 0, Math.min(w, h) / 8)),
    outline: (w, h, params, layer) => polygonOutline(starPts(w, h, params?.points ?? 5, params?.inner ?? 0.45), Math.min(Number(layer?.radius) || 0, Math.min(w, h) / 8)),
  },
  {
    id: "burst",
    label: "Burst",
    icon: "burst",
    defaults: { fill: { on: true, color: "#ffe14d" }, stroke: { on: true, color: "#000000", width: 8, dash: false }, params: { points: 16, inner: 0.78 } },
    params: [
      { key: "points", label: "Spikes", min: 6, max: 48, step: 1, default: 16 },
      { key: "inner", label: "Inner size", min: 0.4, max: 0.95, step: 0.01, default: 0.78 },
    ],
    path: (w, h, params) => polygonPath(starPts(w, h, params?.points ?? 16, params?.inner ?? 0.78)),
    outline: (w, h, params) => starPts(w, h, params?.points ?? 16, params?.inner ?? 0.78),
  },
  {
    id: "bubble",
    label: "Speech bubble",
    icon: "message-circle",
    defaults: { fill: { on: true, color: "#ffffff" }, stroke: { on: true, color: "#000000", width: 8, dash: false }, params: { tail: 0.28 } },
    params: [{ key: "tail", label: "Tail position", min: 0, max: 1, step: 0.01, default: 0.28 }],
    path(w, h, params, layer) {
      const g = bubbleGeom(w, h, params, layer);
      return polygonPath(g.pts, g.radii);
    },
    outline(w, h, params, layer) {
      const g = bubbleGeom(w, h, params, layer);
      return polygonOutline(g.pts, g.radii);
    },
  },
];

for (const def of BUILT_INS) shapes.register(def);

// Params with registry defaults filled in (shape-specific params only).
export function shapeParams(layer, def = shapes.get(layer?.shape)) {
  const out = {};
  for (const p of def?.params || []) out[p.key] = p.default;
  return { ...out, ...(def?.defaults?.params || {}), ...(layer?.params || {}) };
}

// SVG path data for a shape drawn in a size x size box, for pickers and icons.
export function shapePreviewPath(id, size = 24, pad = 3) {
  const def = shapes.get(id);
  if (!def?.outline) return "";
  const s = size - pad * 2;
  const stub = { radius: id === "rect" ? s * 0.18 : 0, params: {} };
  const pts = def.outline(s, s, shapeParams(stub, def), stub) || [];
  if (!pts.length) return "";
  const f = (v) => (Math.round((v + size / 2) * 10) / 10).toString();
  return pts.map((p, i) => `${i ? "L" : "M"}${f(p.x)} ${f(p.y)}`).join("") + "Z";
}
