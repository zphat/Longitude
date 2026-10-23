// Mask helpers. A mask is a canvas the size of the image's natural pixels. Its
// alpha says how much of the image to keep (255 keep, 0 removed); RGB is white.
//
// The cores work on plain objects so they also run in workers and Deno tests:
//   image  { width, height, data }  data = RGBA bytes (ImageData-like)
//   alpha  { width, height, data }  data = one byte per pixel, 0..255
// The canvas wrappers at the bottom are the SPEC 11 exports used by the editor.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

// ---- color distance (OKLab) ------------------------------------------------

const LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

// sRGB bytes -> OKLab, written into out[0..2]. L is 0..1; white to black is 1.0.
export function oklab(r, g, b, out = [0, 0, 0]) {
  const R = LINEAR[r];
  const G = LINEAR[g];
  const B = LINEAR[b];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  out[0] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  out[1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  out[2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return out;
}

// Tolerance 0..100 (what the user sees) -> OKLab distance.
export function toleranceToDistance(tolerance) {
  const t = clamp(Number(tolerance) || 0, 0, 100) / 100;
  return 0.004 + t ** 1.5 * 0.8;
}

// Distance from pixel i to a target color. Color distances are memoized in a
// small direct-mapped cache because flat backgrounds repeat a few colors.
function makeDistance(image, lab, alpha) {
  const d = image.data;
  const tags = new Int32Array(4096).fill(-1);
  const vals = new Float32Array(4096);
  const tmp = [0, 0, 0];
  return (i) => {
    const o = i * 4;
    const a = d[o + 3];
    if (a < 8 && alpha < 8) return 0;
    const key = (d[o] << 16) | (d[o + 1] << 8) | d[o + 2];
    const slot = Math.imul(key, 2654435761) >>> 20;
    let cd;
    if (tags[slot] === key) cd = vals[slot];
    else {
      oklab(d[o], d[o + 1], d[o + 2], tmp);
      const dl = tmp[0] - lab[0];
      const da = tmp[1] - lab[1];
      const db = tmp[2] - lab[2];
      cd = Math.sqrt(dl * dl + da * da + db * db);
      tags[slot] = key;
      vals[slot] = cd;
    }
    return cd + Math.abs(a - alpha) / 255;
  };
}

// Selection strength 0..255 for every pixel whose distance is within thr
// (fully) or within the soft band above it (partly, for anti-aliased edges).
// contiguous: grow from the seeds through fully matching 4-neighbors only.
function floodSelect(image, dist, seeds, thr, contiguous, forceSeeds = false) {
  const { width: w, height: h } = image;
  const n = w * h;
  const sel = new Uint8Array(n);
  const soft = thr * 0.35 + 0.004;
  const strength = (d) => (d <= thr ? 255 : d < thr + soft ? Math.round(255 * (1 - (d - thr) / soft)) : 0);
  if (!contiguous) {
    for (let i = 0; i < n; i++) sel[i] = strength(dist(i));
    return sel;
  }
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;
  for (const i of seeds) {
    if (i < 0 || i >= n || seen[i]) continue;
    seen[i] = 1;
    const s = forceSeeds ? 255 : strength(dist(i));
    sel[i] = s;
    if (s === 255) stack[top++] = i;
  }
  const visit = (j) => {
    seen[j] = 1;
    const s = strength(dist(j));
    if (!s) return;
    sel[j] = s;
    if (s === 255) stack[top++] = j;
  };
  while (top > 0) {
    const i = stack[--top];
    const x = i % w;
    if (x > 0 && !seen[i - 1]) visit(i - 1);
    if (x < w - 1 && !seen[i + 1]) visit(i + 1);
    if (i >= w && !seen[i - w]) visit(i - w);
    if (i + w < n && !seen[i + w]) visit(i + w);
  }
  return sel;
}

function averageLab(image, cx, cy, r = 1) {
  const { width: w, height: h, data } = image;
  const tmp = [0, 0, 0];
  const sum = [0, 0, 0];
  let count = 0;
  for (let y = Math.max(0, cy - r); y <= Math.min(h - 1, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
      const o = (y * w + x) * 4;
      oklab(data[o], data[o + 1], data[o + 2], tmp);
      sum[0] += tmp[0];
      sum[1] += tmp[1];
      sum[2] += tmp[2];
      count++;
    }
  }
  return count ? sum.map((v) => v / count) : [0, 0, 0];
}

// Magic eraser core: remove the color under (x, y). Returns the new keep-alpha
// (base * (1 - selection)). tolerance 0..100, feather in px.
export function magicAlpha(image, { x = 0, y = 0, tolerance = 32, contiguous = true, feather = 1, base = null } = {}) {
  const { width: w, height: h, data } = image;
  const sx = clamp(Math.floor(x), 0, w - 1);
  const sy = clamp(Math.floor(y), 0, h - 1);
  const seed = sy * w + sx;
  const lab = averageLab(image, sx, sy, 1);
  const dist = makeDistance(image, lab, data[seed * 4 + 3]);
  const sel = floodSelect(image, dist, [seed], toleranceToDistance(tolerance), contiguous, true);
  sel[seed] = 255;
  return keepFromSelection({ width: w, height: h, data: sel }, feather, base);
}

function keepFromSelection(sel, feather, base) {
  const soft = feather > 0 ? featherAlpha(sel, feather) : sel;
  const s = soft.data;
  const out = new Uint8ClampedArray(s.length);
  const b = base?.data;
  if (b && b.length !== s.length) throw Error("The mask and the image are different sizes.");
  for (let i = 0; i < s.length; i++) {
    const keep = 255 - s[i];
    out[i] = b ? (b[i] * keep) / 255 : keep;
  }
  return { width: sel.width, height: sel.height, data: out };
}

// The dominant color around the image border, and how much of the border it
// covers. Used by the "Magic (flat backgrounds)" provider.
export function estimateBorder(image) {
  const { width: w, height: h, data } = image;
  const ring = clamp(Math.round(Math.min(w, h) * 0.005), 1, 4);
  const labs = [];
  let transparent = 0;
  let total = 0;
  const tmp = [0, 0, 0];
  const take = (x, y) => {
    const o = (y * w + x) * 4;
    total++;
    if (data[o + 3] < 16) {
      transparent++;
      return;
    }
    oklab(data[o], data[o + 1], data[o + 2], tmp);
    labs.push(tmp[0], tmp[1], tmp[2]);
  };
  for (let y = 0; y < h; y++) {
    const edgeRow = y < ring || y >= h - ring;
    if (edgeRow) for (let x = 0; x < w; x++) take(x, y);
    else for (let k = 0; k < ring; k++) {
      take(k, y);
      if (w - 1 - k > k) take(w - 1 - k, y);
    }
  }
  const opaque = labs.length / 3;
  if (!total || transparent / total > 0.6 || !opaque) return { lab: [1, 0, 0], coverage: 0, spread: 0, transparent: true };

  // Mode of a coarse OKLab histogram, then refine the center on its inliers.
  const bins = new Map();
  let best = -1;
  let bestCount = 0;
  for (let i = 0; i < labs.length; i += 3) {
    const key = (Math.floor(labs[i] / 0.05) * 64 + Math.floor((labs[i + 1] + 0.5) / 0.05)) * 64 + Math.floor((labs[i + 2] + 0.5) / 0.05);
    const c = (bins.get(key) || 0) + 1;
    bins.set(key, c);
    if (c > bestCount) {
      bestCount = c;
      best = key;
    }
  }
  let center = [0, 0, 0];
  let count = 0;
  for (let i = 0; i < labs.length; i += 3) {
    const key = (Math.floor(labs[i] / 0.05) * 64 + Math.floor((labs[i + 1] + 0.5) / 0.05)) * 64 + Math.floor((labs[i + 2] + 0.5) / 0.05);
    if (key !== best) continue;
    center[0] += labs[i];
    center[1] += labs[i + 1];
    center[2] += labs[i + 2];
    count++;
  }
  center = center.map((v) => v / count);
  const near = 0.08;
  let dists = [];
  for (let pass = 0; pass < 2; pass++) {
    const sum = [0, 0, 0];
    dists = [];
    for (let i = 0; i < labs.length; i += 3) {
      const dl = labs[i] - center[0];
      const da = labs[i + 1] - center[1];
      const db = labs[i + 2] - center[2];
      const d = Math.sqrt(dl * dl + da * da + db * db);
      if (d >= near) continue;
      dists.push(d);
      sum[0] += labs[i];
      sum[1] += labs[i + 1];
      sum[2] += labs[i + 2];
    }
    if (dists.length) center = sum.map((v) => v / dists.length);
  }
  dists.sort((a, b) => a - b);
  const spread = dists.length ? dists[Math.min(dists.length - 1, Math.floor(dists.length * 0.9))] : 0;
  return { lab: center, coverage: dists.length / opaque, spread, transparent: false };
}

// Remove a flat background that touches the edges. Throws an Error with
// code "not-flat" or "already-transparent" when that does not apply.
export function edgeMagicAlpha(image, { tolerance = null, feather = 1, minCoverage = 0.45 } = {}) {
  const { width: w, height: h } = image;
  const est = estimateBorder(image);
  if (est.transparent) throw Object.assign(Error("This image already has a transparent background."), { code: "already-transparent" });
  if (est.coverage < minCoverage) throw Object.assign(Error("The edges are not one flat color. Try Fast or Best."), { code: "not-flat" });
  const thr = tolerance === null || tolerance === undefined ? clamp(est.spread * 2.5 + 0.03, 0.05, 0.2) : toleranceToDistance(tolerance);
  const dist = makeDistance(image, est.lab, 255);
  const seeds = [];
  for (let x = 0; x < w; x++) seeds.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) seeds.push(y * w, y * w + w - 1);
  const sel = floodSelect(image, dist, seeds, thr, true);
  return keepFromSelection({ width: w, height: h, data: sel }, feather, null);
}

// ---- feather (gaussian-like blur of the alpha) ---------------------------

function boxesForGauss(sigma, n) {
  const ideal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(ideal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  const sizes = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes;
}

// Box blur of n samples at offset + i*stride, edge-normalized, src -> dst.
function boxLine(src, dst, offset, stride, n, r, prefix) {
  prefix[0] = 0;
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + src[offset + i * stride];
  for (let i = 0; i < n; i++) {
    const a = i - r < 0 ? 0 : i - r;
    const b = i + r >= n ? n - 1 : i + r;
    dst[offset + i * stride] = (prefix[b + 1] - prefix[a]) / (b - a + 1);
  }
}

function tentLine(src, dst, offset, stride, n) {
  for (let i = 0; i < n; i++) {
    const c = src[offset + i * stride];
    const l = i > 0 ? src[offset + (i - 1) * stride] : c;
    const r = i < n - 1 ? src[offset + (i + 1) * stride] : c;
    dst[offset + i * stride] = (l + 2 * c + r) * 0.25;
  }
}

// Soften the alpha by `px` (roughly a gaussian with sigma px/2). Returns a new alpha.
export function featherAlpha(alpha, px) {
  const { width: w, height: h, data } = alpha;
  const out = new Uint8ClampedArray(data.length);
  const sigma = (Number(px) || 0) / 2;
  if (sigma <= 0.05 || !w || !h) {
    out.set(data);
    return { width: w, height: h, data: out };
  }
  let a = Float32Array.from(data);
  const b = new Float32Array(a.length);
  const prefix = new Float64Array(Math.max(w, h) + 1);
  const passes = sigma < 0.8 ? [0] : boxesForGauss(sigma, 3).map((s) => (s - 1) / 2);
  for (const r of passes) {
    for (let y = 0; y < h; y++) {
      if (r === 0) tentLine(a, b, y * w, 1, w);
      else boxLine(a, b, y * w, 1, w, r, prefix);
    }
    for (let x = 0; x < w; x++) {
      if (r === 0) tentLine(b, a, x, w, h);
      else boxLine(b, a, x, w, h, r, prefix);
    }
  }
  out.set(a);
  return { width: w, height: h, data: out };
}

// ---- grow / shrink (grayscale dilate / erode with an octagon ≈ disc) ----------

// Max (or min) over a sliding window of 2r+1 on one line, in place.
// van Herk / Gil-Werman: O(n) whatever the radius.
function windowLine(buf, n, r, isMax, g, hh) {
  const k = 2 * r + 1;
  const len = n + 2 * r;
  const id = isMax ? 0 : 255;
  for (let j = 0; j < len; j++) {
    const v = j < r || j >= n + r ? id : buf[j - r];
    if (j % k === 0) g[j] = v;
    else g[j] = isMax ? (v > g[j - 1] ? v : g[j - 1]) : v < g[j - 1] ? v : g[j - 1];
  }
  for (let j = len - 1; j >= 0; j--) {
    const v = j < r || j >= n + r ? id : buf[j - r];
    if (j % k === k - 1 || j === len - 1) hh[j] = v;
    else hh[j] = isMax ? (v > hh[j + 1] ? v : hh[j + 1]) : v < hh[j + 1] ? v : hh[j + 1];
  }
  for (let i = 0; i < n; i++) {
    const p = hh[i];
    const q = g[i + k - 1];
    buf[i] = isMax ? (p > q ? p : q) : p < q ? p : q;
  }
}

// Run windowLine along every line with direction (dx, dy).
function morphPass(data, w, h, r, isMax, dx, dy) {
  if (r <= 0) return;
  const maxLen = Math.max(w, h);
  const buf = new Uint8Array(maxLen);
  const idx = new Int32Array(maxLen);
  const g = new Uint8Array(maxLen + 2 * r);
  const hh = new Uint8Array(maxLen + 2 * r);
  const starts = [];
  if (dy === 0) for (let y = 0; y < h; y++) starts.push([0, y]);
  else if (dx === 0) for (let x = 0; x < w; x++) starts.push([x, 0]);
  else if (dx === 1) {
    for (let x = 0; x < w; x++) starts.push([x, 0]);
    for (let y = 1; y < h; y++) starts.push([0, y]);
  } else {
    for (let x = 0; x < w; x++) starts.push([x, 0]);
    for (let y = 1; y < h; y++) starts.push([w - 1, y]);
  }
  for (const [sx, sy] of starts) {
    let n = 0;
    for (let x = sx, y = sy; x >= 0 && x < w && y < h; x += dx, y += dy) {
      idx[n] = y * w + x;
      buf[n] = data[idx[n]];
      n++;
    }
    windowLine(buf, n, r, isMax, g, hh);
    for (let i = 0; i < n; i++) data[idx[i]] = buf[i];
  }
}

// Positive px grows the kept area, negative shrinks it. Returns a new alpha.
export function growAlpha(alpha, px) {
  const { width: w, height: h } = alpha;
  const r = Math.round(Math.abs(Number(px) || 0));
  if (!r) return { width: w, height: h, data: new Uint8ClampedArray(alpha.data) };
  const isMax = px > 0;
  // Pad so the passes can reach around corners; outside the image is neutral
  // (nothing to grow from, and the frame edge does not eat into the mask).
  const pw = w + 2 * r;
  const ph = h + 2 * r;
  const pad = new Uint8Array(pw * ph).fill(isMax ? 0 : 255);
  for (let y = 0; y < h; y++) pad.set(alpha.data.subarray(y * w, y * w + w), (y + r) * pw + r);
  // A square (half side s) plus a diamond (radius 2u) makes an octagon whose
  // straight and diagonal reach are both close to r.
  const u = Math.round(r * 0.2929);
  const s = r - 2 * u;
  morphPass(pad, pw, ph, s, isMax, 1, 0);
  morphPass(pad, pw, ph, s, isMax, 0, 1);
  morphPass(pad, pw, ph, u, isMax, 1, 1);
  morphPass(pad, pw, ph, u, isMax, -1, 1);
  const data = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) data.set(pad.subarray((y + r) * pw + r, (y + r) * pw + r + w), y * w);
  return { width: w, height: h, data };
}

// ---- brush ----------------------------------------------------------------

function brushFalloff(radius, hardness) {
  const r = Math.max(0.5, radius);
  const inner = Math.max(0, Math.min(r * clamp(hardness, 0, 1), r - 0.75));
  const band = r - inner;
  return (d) => {
    if (d >= r) return 0;
    if (d <= inner) return 1;
    const t = (d - inner) / band;
    return 1 - t * t * (3 - 2 * t);
  };
}

// Rectangle touched by a round brush moved from -> to, clipped to w x h.
export function brushRect(w, h, from, to, radius) {
  const r = Math.max(0.5, radius) + 1;
  const x0 = clamp(Math.floor(Math.min(from.x, to.x) - r), 0, w);
  const y0 = clamp(Math.floor(Math.min(from.y, to.y) - r), 0, h);
  const x1 = clamp(Math.ceil(Math.max(from.x, to.x) + r), 0, w);
  const y1 = clamp(Math.ceil(Math.max(from.y, to.y) + r), 0, h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

// Max-accumulate brush coverage (0..255) of the segment from -> to into cov
// (row stride `stride`, origin at (ox, oy) in image px) inside rect. The brush
// is continuous along the segment, so there are no visible dabs.
function stampSegment(cov, stride, ox, oy, rect, from, to, radius, hardness) {
  const fall = brushFalloff(radius, hardness);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len2 = dx * dx + dy * dy;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    const py = y + 0.5;
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const px = x + 0.5;
      let t = len2 > 0 ? ((px - from.x) * dx + (py - from.y) * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = px - (from.x + dx * t);
      const ey = py - (from.y + dy * t);
      const v = fall(Math.sqrt(ex * ex + ey * ey));
      if (v <= 0) continue;
      const i = (y - oy) * stride + (x - ox);
      const c = Math.round(v * 255);
      if (c > cov[i]) cov[i] = c;
    }
  }
}

function applyBrush(base, cov, mode, strength) {
  const s = clamp(strength, 0, 1) / 255;
  if (mode === "restore") return base + (255 - base) * cov * s;
  return base * (1 - cov * s);
}

// Paint the alpha in place with a soft round brush from -> to (image px).
// mode "erase" removes, "restore" brings pixels back. Returns the dirty rect.
export function paintAlpha(alpha, from, to, { radius = 24, hardness = 0.6, mode = "erase", strength = 1 } = {}) {
  const { width: w, height: h, data } = alpha;
  const rect = brushRect(w, h, from, to, radius);
  if (!rect) return null;
  const cov = new Uint8Array(rect.w * rect.h);
  stampSegment(cov, rect.w, rect.x, rect.y, rect, from, to, radius, hardness);
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      const c = cov[y * rect.w + x];
      if (!c) continue;
      const i = (rect.y + y) * w + rect.x + x;
      data[i] = Math.round(applyBrush(data[i], c, mode, strength));
    }
  }
  return rect;
}

// ---- conversions ------------------------------------------------------------

export function alphaFromRGBA(image) {
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0, o = 3; i < out.length; i++, o += 4) out[i] = data[o];
  return { width, height, data: out };
}

// White pixels carrying the alpha, as RGBA bytes.
export function rgbaFromAlpha(alpha, target = new Uint8ClampedArray(alpha.width * alpha.height * 4)) {
  const a = alpha.data;
  if (LITTLE_ENDIAN) {
    const u32 = new Uint32Array(target.buffer, target.byteOffset, a.length);
    for (let i = 0; i < a.length; i++) u32[i] = ((a[i] << 24) | 0xffffff) >>> 0;
  } else {
    for (let i = 0, o = 0; i < a.length; i++, o += 4) {
      target[o] = target[o + 1] = target[o + 2] = 255;
      target[o + 3] = a[i];
    }
  }
  return target;
}

// Area-average the alpha down so its longest side is at most maxSide.
export function downsampleAlpha(alpha, maxSide = 256) {
  const { width: w, height: h, data } = alpha;
  const scale = Math.min(1, maxSide / Math.max(w, h, 1));
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));
  const sum = new Float64Array(dw * dh);
  const count = new Uint32Array(dw * dh);
  const colOf = new Int32Array(w);
  for (let x = 0; x < w; x++) colOf[x] = Math.min(dw - 1, Math.floor((x * dw) / w));
  for (let y = 0; y < h; y++) {
    const row = Math.min(dh - 1, Math.floor((y * dh) / h)) * dw;
    for (let x = 0; x < w; x++) {
      const j = row + colOf[x];
      sum[j] += data[y * w + x];
      count[j]++;
    }
  }
  const out = new Uint8Array(dw * dh);
  for (let i = 0; i < out.length; i++) out[i] = count[i] ? Math.round(sum[i] / count[i]) : 0;
  return { w: dw, h: dh, data: out };
}

// ---- canvas wrappers (browser) --------------------------------------------------

export function sourceSize(source) {
  const width = source.naturalWidth || source.videoWidth || source.displayWidth || source.width || 0;
  const height = source.naturalHeight || source.videoHeight || source.displayHeight || source.height || 0;
  return { width, height };
}

export function makeCanvas(width, height) {
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    return c;
  }
  return new OffscreenCanvas(width, height);
}

function ctx2d(canvas) {
  return canvas.getContext("2d", { willReadFrequently: true });
}

const isPixels = (s) => s && s.data && typeof s.width === "number" && typeof s.height === "number" && !s.getContext;

// Decoded images do not change, so a caller that reads the same image again
// and again (the magic eraser, once per click) can ask for the pixels to be
// kept: { cache: true }. At most two images, none over READ_CACHE_PIXELS, and
// all dropped after READ_CACHE_IDLE ms without a read, so a big photo's
// pixels are not held for the rest of the session.
const recenterads = [];
const READ_CACHE_PIXELS = 16e6;
const READ_CACHE_IDLE = 15000;
let readCacheTimer = 0;

function touchReadCache() {
  clearTimeout(readCacheTimer);
  readCacheTimer = recenterads.length ? setTimeout(clearReadCache, READ_CACHE_IDLE) : 0;
}

// Forget the pixels kept by readPixels(source, { cache: true }).
export function clearReadCache() {
  clearTimeout(readCacheTimer);
  readCacheTimer = 0;
  recenterads.length = 0;
}

// RGBA pixels of an ImageBitmap, image, canvas or ImageData-like object.
export function readPixels(source, { cache = false } = {}) {
  if (isPixels(source)) return source;
  const { width, height } = sourceSize(source);
  if (!width || !height) throw Error("The image has no pixels.");
  if (typeof source.getContext === "function") {
    const own = source.getContext("2d");
    if (own) return own.getImageData(0, 0, width, height);
  }
  const immutable = (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap)
    || (typeof HTMLImageElement !== "undefined" && source instanceof HTMLImageElement);
  const keep = cache && immutable && width * height <= READ_CACHE_PIXELS;
  const at = keep ? recenterads.findIndex((r) => r.source === source) : -1;
  if (at >= 0) {
    const [hit] = recenterads.splice(at, 1);
    recenterads.unshift(hit);
    touchReadCache();
    return hit.pixels;
  }
  const g = ctx2d(makeCanvas(width, height));
  g.drawImage(source, 0, 0, width, height);
  const pixels = g.getImageData(0, 0, width, height);
  if (keep) {
    recenterads.unshift({ source, pixels });
    recenterads.length = Math.min(recenterads.length, 2);
    touchReadCache();
  }
  return pixels;
}

// Alpha of a mask canvas (or of any image) at its own size.
export function readAlpha(mask) {
  return alphaFromRGBA(readPixels(mask));
}

export function alphaToMask(alpha) {
  const c = makeCanvas(alpha.width, alpha.height);
  const g = ctx2d(c);
  const img = g.createImageData(alpha.width, alpha.height);
  rgbaFromAlpha(alpha, img.data);
  g.putImageData(img, 0, 0);
  return c;
}

// A mask that keeps everything (or `value`).
export function createMask(width, height, value = 255) {
  return alphaToMask({ width, height, data: new Uint8ClampedArray(width * height).fill(value) });
}

function alphaAtSize(mask, width, height) {
  if (isPixels(mask) && mask.data.length === width * height) return mask;
  const { width: mw, height: mh } = sourceSize(mask);
  if (mw === width && mh === height) return readAlpha(mask);
  const c = makeCanvas(width, height);
  const g = ctx2d(c);
  g.imageSmoothingQuality = "high";
  g.drawImage(mask, 0, 0, width, height);
  return alphaFromRGBA(g.getImageData(0, 0, width, height));
}

// Magic eraser: (x, y) in natural image px. baseMask: the layer's current mask
// (canvas) or null. Returns a new mask canvas.
export function magicMask(source, { x, y, tolerance = 32, contiguous = true, feather = 1, baseMask = null } = {}) {
  // The image is read on every click, so it is kept for a little while; the
  // base mask is new after every click, so it is not.
  const image = readPixels(source, { cache: true });
  const base = baseMask ? alphaAtSize(baseMask, image.width, image.height) : null;
  return alphaToMask(magicAlpha(image, { x, y, tolerance, contiguous, feather, base }));
}

// Per-canvas stroke state, so consecutive segments of one stroke (each call's
// `from` is the last call's `to`) blend against the alpha from the start of
// the stroke and soft edges do not build up where segments meet.
const strokes = new WeakMap();
const TILE = 64;

function strokeFor(canvas, from, opts) {
  const now = Date.now();
  const w = canvas.width;
  const h = canvas.height;
  const s = strokes.get(canvas);
  const continues = s && s.w === w && s.h === h && s.mode === opts.mode && s.radius === opts.radius
    && s.hardness === opts.hardness && s.strength === opts.strength
    && Math.abs(s.last.x - from.x) < 0.5 && Math.abs(s.last.y - from.y) < 0.5 && now - s.time < 1500;
  if (continues) return s;
  const tw = Math.ceil(w / TILE);
  const fresh = {
    w, h, tw, mode: opts.mode, radius: opts.radius, hardness: opts.hardness, strength: opts.strength,
    base: new Uint8Array(w * h),
    cov: new Uint8Array(w * h),
    touched: new Uint8Array(tw * Math.ceil(h / TILE)),
    last: from,
    time: now,
  };
  strokes.set(canvas, fresh);
  return fresh;
}

// End the current brush stroke on this mask (optional; a new stroke also
// starts on its own when a segment does not continue the last one).
export function endMaskStroke(maskCanvas) {
  strokes.delete(maskCanvas);
}

// Soft round brush on the mask canvas, in natural image px. Returns the dirty
// rect { x, y, w, h } or null.
export function paintMask(maskCanvas, from, to, { radius = 24, hardness = 0.6, mode = "erase", strength = 1 } = {}) {
  const opts = { radius, hardness, mode: mode === "restore" ? "restore" : "erase", strength };
  const w = maskCanvas.width;
  const h = maskCanvas.height;
  const rect = brushRect(w, h, from, to, radius);
  if (!rect) return null;
  const s = strokeFor(maskCanvas, from, opts);
  // Work on whole tiles so each tile's starting alpha is captured exactly once.
  const tx0 = Math.floor(rect.x / TILE);
  const ty0 = Math.floor(rect.y / TILE);
  const tx1 = Math.ceil((rect.x + rect.w) / TILE);
  const ty1 = Math.ceil((rect.y + rect.h) / TILE);
  const ax = tx0 * TILE;
  const ay = ty0 * TILE;
  const aw = Math.min(w, tx1 * TILE) - ax;
  const ah = Math.min(h, ty1 * TILE) - ay;
  const g = ctx2d(maskCanvas);
  const img = g.getImageData(ax, ay, aw, ah);
  const px = img.data;
  for (let ty = ty0; ty < ty1; ty++) {
    for (let tx = tx0; tx < tx1; tx++) {
      const t = ty * s.tw + tx;
      if (s.touched[t]) continue;
      s.touched[t] = 1;
      const x0 = tx * TILE;
      const y0 = ty * TILE;
      const x1 = Math.min(w, x0 + TILE);
      const y1 = Math.min(h, y0 + TILE);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) s.base[y * w + x] = px[((y - ay) * aw + (x - ax)) * 4 + 3];
      }
    }
  }
  stampSegment(s.cov, w, 0, 0, rect, from, to, radius, hardness);
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = y * w + x;
      const c = s.cov[i];
      if (!c) continue;
      const o = ((y - ay) * aw + (x - ax)) * 4;
      px[o] = px[o + 1] = px[o + 2] = 255;
      px[o + 3] = applyBrush(s.base[i], c, opts.mode, strength);
    }
  }
  g.putImageData(img, ax, ay);
  s.last = { x: to.x, y: to.y };
  s.time = Date.now();
  return rect;
}

function filtered(mask, fn) {
  return alphaToMask(fn(readAlpha(mask)));
}

// Returns a new, softened mask canvas.
export function featherMask(mask, px) {
  return filtered(mask, (a) => featherAlpha(a, px));
}

// Returns a new mask canvas; positive px grows the kept area, negative shrinks it.
export function growMask(mask, px) {
  return filtered(mask, (a) => growAlpha(a, px));
}

// The image with the mask applied, as a canvas at the image's natural size.
export function maskToCutout(source, mask) {
  const { width, height } = sourceSize(source);
  const c = makeCanvas(width, height);
  const g = c.getContext("2d");
  if (isPixels(source)) {
    const img = g.createImageData(width, height);
    img.data.set(source.data);
    g.putImageData(img, 0, 0);
  } else {
    g.drawImage(source, 0, 0, width, height);
  }
  if (mask) {
    g.globalCompositeOperation = "destination-in";
    if (isPixels(mask)) g.drawImage(alphaToMask(mask.data.length === width * height ? mask : alphaFromRGBA(mask)), 0, 0, width, height);
    else g.drawImage(mask, 0, 0, width, height);
    g.globalCompositeOperation = "source-over";
  }
  return c;
}

// Small alpha map for hit testing: { w, h, data } with the longest side <= maxSide.
export function maskAlphaMap(maskCanvas, maxSide = 256) {
  const { width, height } = sourceSize(maskCanvas);
  if (!width || !height) return { w: 1, h: 1, data: new Uint8Array(1) };
  // Let the canvas do the first big reduction, then area-average exactly.
  const scale = Math.min(1, (maxSide * 4) / Math.max(width, height));
  const mw = Math.max(1, Math.round(width * scale));
  const mh = Math.max(1, Math.round(height * scale));
  let alpha;
  if (scale < 1) {
    const c = makeCanvas(mw, mh);
    const g = ctx2d(c);
    g.imageSmoothingQuality = "high";
    g.drawImage(maskCanvas, 0, 0, mw, mh);
    alpha = alphaFromRGBA(g.getImageData(0, 0, mw, mh));
  } else {
    alpha = readAlpha(maskCanvas);
  }
  return downsampleAlpha(alpha, maxSide);
}
