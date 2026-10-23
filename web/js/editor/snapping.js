// Snapping (SPEC 1.4 and 8): magnetic alignment to the canvas edges and centre
// lines and to other layers' edges and centres, equal spacing between
// neighbours, and the guides that show what lined up. Everything is in doc px;
// callers pass the threshold in doc px (SNAP_PX screen px / zoom).

import { aabb, quadBounds, arrowPoints, defaultPad } from "../core/geometry.js";

export const SNAP_PX = 6;
const EPS = 1e-6;

export function boxOf(l, t, r, b) {
  return { l, t, r, b, cx: (l + r) / 2, cy: (t + b) / 2, w: r - l, h: b - t };
}

export function offsetBox(b, dx, dy) {
  return boxOf(b.l + dx, b.t + dy, b.r + dx, b.b + dy);
}

// What a layer visibly covers, axis aligned. Paths and arrows carry padding
// in their boxes, so their snapping box is the stroke itself.
export function visualBox(layer) {
  if (layer.type === "arrow") {
    const { a, b, c } = arrowPoints(layer);
    const q = c ? quadBounds(a, c, b) : boxOf(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y));
    const half = (layer.width || 0) / 2;
    return boxOf(q.l - half, q.t - half, q.r + half, q.b + half);
  }
  if (layer.type === "path") {
    const inset = Math.max(0, defaultPad(layer) - (layer.width || 0) / 2);
    const w = Math.max(1, layer.w - inset * 2);
    const h = Math.max(1, layer.h - inset * 2);
    const a = aabb({ ...layer, w, h });
    return boxOf(a.l, a.t, a.r, a.b);
  }
  const a = aabb(layer);
  return boxOf(a.l, a.t, a.r, a.b);
}

// Snap candidates: the canvas plus every visible layer not in `exclude`.
// extra: more boxes ({ l, t, r, b, src }), for example preset safe zones.
export function buildTargets(doc, { exclude = [], extra = [] } = {}) {
  const skip = new Set(exclude);
  const xs = [];
  const ys = [];
  const boxes = [];
  const add = (b, src) => {
    xs.push({ v: b.l, kind: "edge", box: b, src }, { v: b.cx, kind: "center", box: b, src }, { v: b.r, kind: "edge", box: b, src });
    ys.push({ v: b.t, kind: "edge", box: b, src }, { v: b.cy, kind: "center", box: b, src }, { v: b.b, kind: "edge", box: b, src });
  };
  const canvas = boxOf(0, 0, doc.width, doc.height);
  add(canvas, "canvas");
  for (const l of doc.layers) {
    if (l.hidden || skip.has(l.id)) continue;
    const b = visualBox(l);
    boxes.push(b);
    add(b, "layer");
  }
  for (const e of extra) {
    if (![e.l, e.t, e.r, e.b].every(Number.isFinite)) continue;
    add(boxOf(e.l, e.t, e.r, e.b), e.src || "guide");
  }
  return { xs, ys, boxes, canvas };
}

// The closest target to any of `values` within thr: { i, d, v } (i = index
// of the value that snapped, d = offset to add) or null. Earlier targets win
// ties, so the canvas beats layers.
export function best(values, list, thr) {
  let out = null;
  for (let i = 0; i < values.length; i++) {
    const val = values[i];
    for (const t of list) {
      const d = t.v - val;
      if (Math.abs(d) <= thr + EPS && (!out || Math.abs(d) < Math.abs(out.d) - EPS)) out = { i, d, v: t.v, t };
    }
  }
  return out;
}

const overlapsAcross = (a, b, axis) => (axis === "x" ? a.t < b.b && a.b > b.t : a.l < b.r && a.r > b.l);

function sides(axis) {
  return axis === "x" ? ["l", "r", "cx"] : ["t", "b", "cy"];
}

// Neighbours of box along one axis: boxes in the same row (or column) that
// sit wholly before or after it.
function neighbours(box, boxes, axis) {
  const [lo, hi] = sides(axis);
  const row = boxes.filter((b) => overlapsAcross(box, b, axis));
  const mid = (box[lo] + box[hi]) / 2;
  const before = row.filter((b) => b[hi] <= mid && b[lo] < box[lo]).sort((a, b) => b[hi] - a[hi]);
  const after = row.filter((b) => b[lo] >= mid && b[hi] > box[hi]).sort((a, b) => a[lo] - b[lo]);
  return { before, after, row };
}

function previousOf(target, row, axis) {
  const [lo, hi] = sides(axis);
  let out = null;
  for (const b of row) {
    if (b === target || b[hi] > target[lo] + EPS) continue;
    if (!out || b[hi] > out[hi]) out = b;
  }
  return out;
}

function nextOf(target, row, axis) {
  const [lo, hi] = sides(axis);
  let out = null;
  for (const b of row) {
    if (b === target || b[lo] < target[hi] - EPS) continue;
    if (!out || b[lo] < out[lo]) out = b;
  }
  return out;
}

// Positions of box's low edge that make it evenly spaced with its
// neighbours: centred between two, or continuing a gap on either side.
export function spacingCandidates(box, boxes, axis) {
  const [lo, hi] = sides(axis);
  const size = box[hi] - box[lo];
  const { before, after, row } = neighbours(box, boxes, axis);
  const out = [];
  const A = before[0];
  const B = after[0];
  if (A && B && B[lo] - A[hi] > size) out.push((A[hi] + B[lo] - size) / 2);
  if (A) {
    const A2 = previousOf(A, row, axis);
    if (A2) {
      const g = A[lo] - A2[hi];
      if (g > 0.5) out.push(A[hi] + g);
    }
  }
  if (B) {
    const B2 = nextOf(B, row, axis);
    if (B2) {
      const g = B2[lo] - B[hi];
      if (g > 0.5) out.push(B[lo] - g - size);
    }
  }
  return out;
}

// Offset that snaps a moving box. Returns { dx, dy, x, y } where x/y say
// whether that axis snapped. lockX/lockY keep an axis where it is.
export function snapMove(box, T, thr, { equal = true, lockX = false, lockY = false } = {}) {
  const pick = (axis, locked) => {
    if (locked) return 0;
    const [lo, hi, c] = sides(axis);
    const align = best([box[lo], box[c], box[hi]], axis === "x" ? T.xs : T.ys, thr);
    let d = align ? align.d : null;
    if (equal) {
      for (const v of spacingCandidates(box, T.boxes, axis)) {
        const dd = v - box[lo];
        if (Math.abs(dd) <= thr + EPS && (d === null || Math.abs(dd) < Math.abs(d) - EPS)) d = dd;
      }
    }
    return d;
  };
  const dx = pick("x", lockX);
  const dy = pick("y", lockY);
  return { dx: dx || 0, dy: dy || 0, x: dx !== null && !lockX, y: dy !== null && !lockY };
}

// Snap one point (drawing tools, arrow ends). Returns { x, y, sx, sy } where
// sx/sy are the matched targets or null.
export function snapPoint(pt, T, thr) {
  const bx = best([pt.x], T.xs, thr);
  const by = best([pt.y], T.ys, thr);
  return { x: bx ? bx.v : pt.x, y: by ? by.v : pt.y, sx: bx, sy: by };
}

// Guides for every target that lines up with the box (after snapping).
// Each guide: { axis: "x" | "y", v, from, to, canvas, centre } where axis "x"
// is a vertical line at x = v running from y = from to y = to.
export function alignGuides(box, T, eps = 0.01) {
  const out = [];
  const run = (axis) => {
    const [lo, hi, c] = sides(axis);
    const [clo, chi] = axis === "x" ? ["t", "b"] : ["l", "r"];
    const list = axis === "x" ? T.xs : T.ys;
    const vals = [box[lo], box[c], box[hi]];
    const byV = new Map();
    for (let i = 0; i < vals.length; i++) {
      for (const t of list) {
        if (Math.abs(t.v - vals[i]) > eps) continue;
        const key = Math.round(t.v * 20);
        let g = byV.get(key);
        if (!g) {
          g = { axis, v: t.v, from: box[clo], to: box[chi], canvas: false, centre: false };
          byV.set(key, g);
          out.push(g);
        }
        g.from = Math.min(g.from, t.box[clo]);
        g.to = Math.max(g.to, t.box[chi]);
        if (t.src === "canvas") {
          g.canvas = true;
          if (i === 1 && t.kind === "center") g.centre = true;
        }
      }
    }
  };
  run("x");
  run("y");
  return out;
}

// Guides that point at equal gaps around a box (after snapping). Each:
// { axis, from, to, at, label } where axis "x" is a horizontal gap from
// x = from to x = to drawn at y = at.
export function spacingGuides(box, boxes, eps = 0.01) {
  const out = [];
  const run = (axis) => {
    const [lo, hi] = sides(axis);
    const [clo, chi] = axis === "x" ? ["t", "b"] : ["l", "r"];
    const { before, after, row } = neighbours(box, boxes, axis);
    const at = (a, b) => (Math.max(a[clo], b[clo]) + Math.min(a[chi], b[chi])) / 2;
    const seg = (a, b) => ({ axis, from: a[hi], to: b[lo], at: at(a, b), label: String(Math.round(b[lo] - a[hi])) });
    const A = before[0];
    const B = after[0];
    const found = [];
    if (A && B) {
      const ga = box[lo] - A[hi];
      const gb = B[lo] - box[hi];
      if (ga > 0.5 && Math.abs(ga - gb) <= eps) found.push(seg(A, box), seg(box, B));
    }
    if (A) {
      const A2 = previousOf(A, row, axis);
      const ga = box[lo] - A[hi];
      if (A2 && ga > 0.5 && Math.abs(A[lo] - A2[hi] - ga) <= eps) found.push(seg(A2, A), seg(A, box));
    }
    if (B) {
      const B2 = nextOf(B, row, axis);
      const gb = B[lo] - box[hi];
      if (B2 && gb > 0.5 && Math.abs(B2[lo] - B[hi] - gb) <= eps) found.push(seg(box, B), seg(B, B2));
    }
    const seen = new Set();
    for (const s of found) {
      const key = `${Math.round(s.from * 10)}:${Math.round(s.to * 10)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  };
  run("x");
  run("y");
  return out;
}

// Guides for a snapped point: lines from the point to what it lines up with.
export function pointGuides(pt, T, eps = 0.01) {
  return alignGuides(boxOf(pt.x, pt.y, pt.x, pt.y), T, eps);
}
