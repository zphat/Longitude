// Smart shapes: turn a rough pen stroke into a clean ellipse, straight line,
// arrow or rectangle. Pure functions on point lists ([x, y] or { x, y }), so
// they run anywhere and are easy to test.
//
// recognize(points) -> { kind, confidence, params }
//   kind "ellipse": params { cx, cy, rx, ry, rotation }   (degrees, clockwise)
//   kind "rect":    params { cx, cy, w, h, rotation }
//   kind "line":    params { a, b }
//   kind "arrow":   params { a, b, c }   c is a quadratic control point or null
//   kind null:      nothing fits well enough (params null)
//
// Every test is relative to the stroke's own size, so the same stroke is
// recognized at any zoom.

const DEG = 180 / Math.PI;
const SAMPLES = 96;

const NONE = Object.freeze({ kind: null, confidence: 0, params: null });

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
// 1 at or below `good`, 0 at or above `bad`, linear in between.
const score = (v, good, bad) => clamp01((bad - v) / (bad - good));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const round2 = (v) => Math.round(v * 100) / 100;
const pt = (x, y) => ({ x: round2(x), y: round2(y) });

function toPoint(p) {
  if (Array.isArray(p)) return { x: Number(p[0]), y: Number(p[1]) };
  return p && typeof p === "object" ? { x: Number(p.x), y: Number(p.y) } : { x: NaN, y: NaN };
}

// Finite points without consecutive duplicates.
export function cleanPoints(points) {
  const out = [];
  for (const raw of points || []) {
    const p = toPoint(raw);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-9 && Math.abs(last.y - p.y) < 1e-9) continue;
    out.push(p);
  }
  return out;
}

export function pathLength(points) {
  const pts = cleanPoints(points);
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  return L;
}

// n points spaced evenly along the stroke, first and last kept.
export function resample(points, n = SAMPLES) {
  const pts = cleanPoints(points);
  if (pts.length < 2 || n < 2) return pts.map((p) => ({ ...p }));
  const L = pathLength(pts);
  if (!(L > 0)) return [{ ...pts[0] }];
  const step = L / (n - 1);
  const out = [{ ...pts[0] }];
  let walked = 0;
  let target = step;
  for (let i = 1; i < pts.length && out.length < n - 1; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const seg = dist(a, b);
    while (walked + seg >= target && out.length < n - 1) {
      const t = (target - walked) / seg;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      target += step;
    }
    walked += seg;
  }
  out.push({ ...pts[pts.length - 1] });
  return out;
}

// Sum of signed turning angles in radians (positive = clockwise on screen).
export function totalTurn(pts) {
  let turn = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const ax = pts[i].x - pts[i - 1].x;
    const ay = pts[i].y - pts[i - 1].y;
    const bx = pts[i + 1].x - pts[i].x;
    const by = pts[i + 1].y - pts[i].y;
    turn += Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
  }
  return turn;
}

function lineDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return dist(p, a);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

function quadPoint(a, c, b, t) {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

function segDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y);
}

function quadDistance(p, a, c, b, steps = 40) {
  let best = Infinity;
  let prev = a;
  for (let i = 1; i <= steps; i++) {
    const q = quadPoint(a, c, b, i / steps);
    best = Math.min(best, segDistance(p, prev, q));
    prev = q;
  }
  return best;
}

// The control point that makes a quadratic pass through m at t = 0.5.
function quadThrough(a, m, b) {
  return { x: 2 * m.x - (a.x + b.x) / 2, y: 2 * m.y - (a.y + b.y) / 2 };
}

function unit(dx, dy) {
  const l = Math.hypot(dx, dy);
  return l > 1e-12 ? { x: dx / l, y: dy / l } : { x: 1, y: 0 };
}

// ---- line --------------------------------------------------------------------

// Lines within 4 degrees of horizontal or vertical are leveled around their
// midpoint, since that is nearly always what a hand-drawn underline means.
function levelLine(a, b) {
  const ang = Math.atan2(b.y - a.y, b.x - a.x) * DEG;
  const near = (target) => Math.abs(((ang - target + 540) % 360) - 180) <= 4;
  const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const half = dist(a, b) / 2;
  for (const target of [0, 90, 180, -90]) {
    if (!near(target)) continue;
    const r = target / DEG;
    const d = { x: Math.round(Math.cos(r)) * half, y: Math.round(Math.sin(r)) * half };
    return [pt(m.x - d.x, m.y - d.y), pt(m.x + d.x, m.y + d.y)];
  }
  return [pt(a.x, a.y), pt(b.x, b.y)];
}

export function fitLine(pts, L = pathLength(pts)) {
  const n = pts.length;
  if (n < 2 || !(L > 0)) return null;
  const a = pts[0];
  const b = pts[n - 1];
  const chord = dist(a, b);
  if (chord < 1e-9) return null;
  let maxDev = 0;
  for (const p of pts) maxDev = Math.max(maxDev, lineDistance(p, a, b));
  const straight = chord / L;
  const confidence = Math.min(score(1 - straight, 0.03, 0.1), score(maxDev / chord, 0.035, 0.1));
  const [la, lb] = levelLine(a, b);
  return { kind: "line", confidence, params: { a: la, b: lb } };
}

// ---- arrow -------------------------------------------------------------------

// A shaft followed by a short hook or V at the far end. The tip is where the
// stroke first gets (almost) as far from its start as it ever does; what
// comes after it must stay behind the tip and close to it.
export function fitArrow(pts, L = pathLength(pts)) {
  const n = pts.length;
  if (n < 8 || !(L > 0)) return null;
  const s = pts[0];
  let far = 0;
  for (const p of pts) far = Math.max(far, dist(s, p));
  if (far < 1e-9) return null;
  // The peak of the first stretch that comes close to the farthest distance
  // (a V head visits the tip twice; the first visit ends the shaft).
  let k = -1;
  let best = -1;
  for (let i = 0; i < n; i++) {
    const d = dist(s, pts[i]);
    if (d >= far * 0.95) {
      if (d > best) {
        best = d;
        k = i;
      }
    } else if (k >= 0) {
      break;
    }
  }
  if (k < n * 0.35 || k > n - 4) return null;
  const step = L / (n - 1);
  const shaftLen = k * step;
  const tailLen = L - shaftLen;
  const tailRatio = tailLen / shaftLen;
  if (tailRatio < 0.08 || tailRatio > 0.9) return null;

  const A = s;
  const B = pts[k];
  const chord = dist(A, B);
  const shaft = pts.slice(0, k + 1);
  let devLine = 0;
  for (const p of shaft) devLine = Math.max(devLine, lineDistance(p, A, B));
  devLine /= chord;
  let C = null;
  let fit = devLine;
  if (devLine > 0.04) {
    const M = pts[Math.round(k / 2)];
    const ctrl = quadThrough(A, M, B);
    let devQuad = 0;
    for (const p of shaft) devQuad = Math.max(devQuad, quadDistance(p, A, ctrl, B));
    devQuad /= chord;
    const bulge = dist(M, { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 }) / chord;
    if (devQuad > 0.07 || bulge > 0.5) return null;
    C = ctrl;
    fit = devQuad;
  }
  // Direction of travel at the tip.
  const from = C || A;
  const dir = unit(B.x - from.x, B.y - from.y);
  let reach = 0;
  let ahead = 0;
  let farTail = B;
  let left = 0;
  let right = 0;
  const tail = pts.slice(k + 1);
  for (const p of tail) {
    const vx = p.x - B.x;
    const vy = p.y - B.y;
    const d = Math.hypot(vx, vy);
    ahead = Math.max(ahead, vx * dir.x + vy * dir.y);
    if (d > reach) {
      reach = d;
      farTail = p;
    }
  }
  if (reach < 0.06 * chord || reach > 0.6 * chord) return null;
  for (const p of tail) {
    const side = (p.x - B.x) * -dir.y + (p.y - B.y) * dir.x;
    if (side > reach * 0.25) left++;
    else if (side < -reach * 0.25) right++;
  }
  // The barb must point back along the shaft, off to one side.
  const bx = farTail.x - B.x;
  const by = farTail.y - B.y;
  const back = Math.acos(Math.max(-1, Math.min(1, -(bx * dir.x + by * dir.y) / (reach || 1)))) * DEG;
  // The stroke has to turn sharply at the tip.
  const first = tail.find((p) => dist(p, B) >= reach * 0.3) || farTail;
  const t0 = unit(first.x - B.x, first.y - B.y);
  const turn = Math.acos(Math.max(-1, Math.min(1, t0.x * dir.x + t0.y * dir.y))) * DEG;
  const angleOk = Math.min(score(Math.abs(back - 40), 28, 58), score(10 - back, 0, 8));
  const confidence = Math.min(
    score(fit, 0.03, 0.08),
    score(ahead / reach, 0.2, 0.5),
    score(125 - turn, 0, 45),
    angleOk,
    score(Math.abs(tailRatio - 0.3), 0.3, 0.6),
    left + right > 0 ? 1 : 0.4,
  );
  return {
    kind: "arrow",
    confidence: Math.min(1, confidence + (left && right ? 0.05 : 0)),
    params: { a: pt(A.x, A.y), b: pt(B.x, B.y), c: C ? pt(C.x, C.y) : null },
  };
}

// ---- closed shapes -------------------------------------------------------------

// How sure we are the stroke closes on itself: a full turn, or a small gap
// relative to the shape's perimeter.
function closure(pts, perimeter, absTurnDeg) {
  if (absTurnDeg >= 350) return 1;
  const gap = dist(pts[0], pts[pts.length - 1]);
  return score(gap / Math.max(perimeter, 1e-9), 0.08, 0.25);
}

export function fitEllipse(pts, L = pathLength(pts), turn = totalTurn(pts)) {
  const n = pts.length;
  const absTurn = Math.abs(turn) * DEG;
  if (n < 12 || absTurn < 280 || absTurn > 520) return null;
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p.x;
    my += p.y;
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of pts) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ce = Math.cos(theta);
  const se = Math.sin(theta);
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const p of pts) {
    const dx = p.x - mx;
    const dy = p.y - my;
    const u = dx * ce + dy * se;
    const v = -dx * se + dy * ce;
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
  }
  let rx = (maxU - minU) / 2;
  let ry = (maxV - minV) / 2;
  if (!(rx > 1e-9) || !(ry > 1e-9)) return null;
  const ratio = Math.min(rx, ry) / Math.max(rx, ry);
  if (ratio < 0.1) return null;
  const cu = (maxU + minU) / 2;
  const cv = (maxV + minV) / 2;
  const cx = mx + cu * ce - cv * se;
  const cy = my + cu * se + cv * ce;
  let sum = 0;
  let max = 0;
  const bins = new Uint8Array(12);
  for (const p of pts) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const u = (dx * ce + dy * se) / rx;
    const v = (-dx * se + dy * ce) / ry;
    const e = Math.abs(Math.hypot(u, v) - 1);
    sum += e;
    max = Math.max(max, e);
    bins[Math.floor(((Math.atan2(v, u) + Math.PI) / (2 * Math.PI)) * 12) % 12] = 1;
  }
  const filled = bins.reduce((a, b) => a + b, 0);
  const perimeter = 2 * Math.PI * Math.sqrt((rx * rx + ry * ry) / 2);
  const confidence = Math.min(
    score(sum / n, 0.045, 0.13),
    score(max, 0.17, 0.36),
    filled >= 12 ? 1 : filled === 11 ? 0.75 : 0,
    closure(pts, perimeter, absTurn),
  );
  let rotation = theta * DEG;
  while (rotation > 45) {
    rotation -= 90;
    [rx, ry] = [ry, rx];
  }
  while (rotation <= -45) {
    rotation += 90;
    [rx, ry] = [ry, rx];
  }
  if (ratio >= 0.9) {
    rx = ry = (rx + ry) / 2;
    rotation = 0;
  } else if (Math.abs(rotation) < 10) {
    rotation = 0;
  }
  return {
    kind: "ellipse",
    confidence,
    params: { cx: round2(cx), cy: round2(cy), rx: round2(rx), ry: round2(ry), rotation: round2(rotation) },
  };
}

export function fitRect(pts, L = pathLength(pts), turn = totalTurn(pts)) {
  const n = pts.length;
  const absTurn = Math.abs(turn) * DEG;
  // A box started at a corner turns only three times before it closes.
  if (n < 12 || absTurn < 240 || absTurn > 520) return null;
  // Edge directions folded onto one quarter turn give the orientation.
  let C = 0;
  let S = 0;
  for (let i = 1; i < n; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    const len = Math.hypot(dx, dy);
    const a = Math.atan2(dy, dx) * 4;
    C += len * Math.cos(a);
    S += len * Math.sin(a);
  }
  const theta = Math.atan2(S, C) / 4;
  const ce = Math.cos(theta);
  const se = Math.sin(theta);
  const local = pts.map((p) => ({ u: p.x * ce + p.y * se, v: -p.x * se + p.y * ce }));
  let l = Infinity;
  let r = -Infinity;
  let t = Infinity;
  let b = -Infinity;
  for (const q of local) {
    l = Math.min(l, q.u);
    r = Math.max(r, q.u);
    t = Math.min(t, q.v);
    b = Math.max(b, q.v);
  }
  const w = r - l;
  const h = b - t;
  const m = Math.min(w, h);
  if (!(m > 1e-9) || m < 0.12 * Math.max(w, h)) return null;
  let sum = 0;
  let max = 0;
  const near = 0.15 * m;
  const cover = [new Uint8Array(10), new Uint8Array(10), new Uint8Array(10), new Uint8Array(10)];
  const corner = [Infinity, Infinity, Infinity, Infinity];
  const cs = [
    [l, t],
    [r, t],
    [r, b],
    [l, b],
  ];
  for (const q of local) {
    const dl = q.u - l;
    const dr = r - q.u;
    const dt = q.v - t;
    const db = b - q.v;
    const d = Math.max(0, Math.min(dl, dr, dt, db));
    sum += d;
    max = Math.max(max, d);
    const bu = Math.min(9, Math.floor(((q.u - l) / w) * 10));
    const bv = Math.min(9, Math.floor(((q.v - t) / h) * 10));
    if (dt <= near) cover[0][bu] = 1;
    if (dr <= near) cover[1][bv] = 1;
    if (db <= near) cover[2][bu] = 1;
    if (dl <= near) cover[3][bv] = 1;
    for (let i = 0; i < 4; i++) corner[i] = Math.min(corner[i], Math.hypot(q.u - cs[i][0], q.v - cs[i][1]));
  }
  const coverage = Math.min(...cover.map((c) => c.reduce((a, v) => a + v, 0) / 10));
  const worstCorner = Math.max(...corner) / m;
  const confidence = Math.min(
    score(sum / n / m, 0.035, 0.09),
    score(max / m, 0.13, 0.3),
    score(worstCorner, 0.09, 0.16),
    score(1 - coverage, 0.2, 0.5),
    closure(pts, 2 * (w + h), absTurn),
  );
  const cu = (l + r) / 2;
  const cv = (t + b) / 2;
  let rotation = theta * DEG;
  let rw = w;
  let rh = h;
  if (rotation > 45) {
    rotation -= 90;
    [rw, rh] = [rh, rw];
  } else if (rotation <= -45) {
    rotation += 90;
    [rw, rh] = [rh, rw];
  }
  if (Math.abs(rotation) < 8) rotation = 0;
  return {
    kind: "rect",
    confidence,
    params: { cx: round2(cu * ce - cv * se), cy: round2(cu * se + cv * ce), w: round2(rw), h: round2(rh), rotation: round2(rotation) },
  };
}

// ---- entry point ---------------------------------------------------------------

// minLength: strokes shorter than this (in the points' units) are ignored.
// minConfidence: below this the stroke stays freehand.
export function recognize(points, { minLength = 0, minConfidence = 0.5 } = {}) {
  const raw = cleanPoints(points);
  if (raw.length < 3) return NONE;
  const L = pathLength(raw);
  if (!(L > 0) || L < minLength) return NONE;
  const pts = resample(raw, SAMPLES);
  if (pts.length < SAMPLES) return NONE;
  const turn = totalTurn(pts);
  let best = null;
  for (const fit of [fitLine(pts, L), fitArrow(pts, L), fitEllipse(pts, L, turn), fitRect(pts, L, turn)]) {
    if (fit && (!best || fit.confidence > best.confidence)) best = fit;
  }
  if (!best || best.confidence < minConfidence) return { kind: null, confidence: best ? best.confidence : 0, params: null };
  return best;
}
