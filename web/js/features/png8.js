// 256-color (or fewer) PNG: palette quantization plus a small PNG encoder.
//
// Pipeline: exact palette when the image already has few colors (lossless),
// otherwise a 19-bit histogram -> variance-split median cut -> a few k-means
// passes -> nearest-color mapping with optional serpentine Floyd-Steinberg
// dithering. The core works on plain { width, height, data } so it runs
// anywhere (tests run it in Deno); only encodePng8() needs a canvas.

import { crc32 } from "./zip.js";

// Eye sensitivity: green matters most, blue least. Colors are compared
// premultiplied by alpha, so nearly transparent pixels cost little. Points are
// stored pre-scaled by sqrt(weight) so plain Euclidean distance is weighted.
const WEIGHTS = [0.5, 1.0, 0.45, 0.8];
const SQW = WEIGHTS.map(Math.sqrt);

const now = () => (globalThis.performance?.now ? performance.now() : Date.now());

// MessageChannel (not setTimeout) so yielding stays fast in hidden tabs.
function yieldToEventLoop() {
  if (globalThis.scheduler?.yield) return globalThis.scheduler.yield();
  if (typeof MessageChannel !== "function") return Promise.resolve();
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      ch.port2.close();
      resolve();
    };
    ch.port2.postMessage(0);
  });
}

function ticker(budgetMs = 40) {
  let last = now();
  return async () => {
    if (now() - last < budgetMs) return;
    await yieldToEventLoop();
    last = now();
  };
}

function checkImage(image) {
  const { width, height, data } = image || {};
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0)) throw Error("png8: the image needs a width and height.");
  if (!data || data.length < width * height * 4) throw Error("png8: the pixel data is incomplete.");
  return { width, height, data };
}

// ---- quantization -------------------------------------------------------

// Lossless path: null when the image has more than `limit` distinct colors.
function exactPalette(img, limit) {
  const { data } = img;
  const n = img.width * img.height;
  const map = new Map();
  const keys = [];
  const indices = new Uint8Array(n);
  let lastKey = -1;
  let lastIdx = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const a = data[p + 3];
    const key = a === 0 ? 0 : ((data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | a) >>> 0;
    if (key !== lastKey) {
      let idx = map.get(key);
      if (idx === undefined) {
        if (keys.length >= limit) return null;
        idx = keys.length;
        map.set(key, idx);
        keys.push(key);
      }
      lastKey = key;
      lastIdx = idx;
    }
    indices[i] = lastIdx;
  }
  const palette = new Uint8Array(keys.length * 4);
  keys.forEach((k, i) => {
    palette[i * 4] = k >>> 24;
    palette[i * 4 + 1] = (k >>> 16) & 255;
    palette[i * 4 + 2] = (k >>> 8) & 255;
    palette[i * 4 + 3] = k & 255;
  });
  return { palette, indices };
}

// 5 bits per color channel + 4 bits alpha. Buckets keep exact premultiplied
// sums, so a bucket's representative is the true mean of its pixels.
async function histogram(img, tick) {
  const { data } = img;
  const n = img.width * img.height;
  const size = 1 << 19;
  const count = new Uint32Array(size);
  const sums = new Float64Array(size * 4);
  let transparent = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const a = data[p + 3];
    if (a === 0) {
      transparent++;
      continue;
    }
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const k = ((r >> 3) << 14) | ((g >> 3) << 9) | ((b >> 3) << 4) | (a >> 4);
    const f = a / 255;
    count[k]++;
    const s = k * 4;
    sums[s] += r * f;
    sums[s + 1] += g * f;
    sums[s + 2] += b * f;
    sums[s + 3] += a;
    if ((i & 0x3ffff) === 0) await tick();
  }
  let used = 0;
  for (let k = 0; k < size; k++) if (count[k]) used++;
  const cnt = new Float64Array(used);
  const pts = new Float64Array(used * 4);
  for (let k = 0, j = 0; k < size; k++) {
    const c = count[k];
    if (!c) continue;
    cnt[j] = c;
    for (let ch = 0; ch < 4; ch++) pts[j * 4 + ch] = (sums[k * 4 + ch] / c) * SQW[ch];
    j++;
  }
  return { n: used, cnt, pts, transparent };
}

function makeBox(h, order, lo, hi) {
  let w = 0;
  const s = [0, 0, 0, 0];
  const q = [0, 0, 0, 0];
  for (let i = lo; i < hi; i++) {
    const j = order[i];
    const c = h.cnt[j];
    w += c;
    for (let ch = 0; ch < 4; ch++) {
      const v = h.pts[j * 4 + ch];
      s[ch] += c * v;
      q[ch] += c * v * v;
    }
  }
  const spread = q.map((qq, ch) => Math.max(0, qq - (s[ch] * s[ch]) / w));
  let axis = 0;
  for (let ch = 1; ch < 4; ch++) if (spread[ch] > spread[axis]) axis = ch;
  return { lo, hi, w, sse: spread[0] + spread[1] + spread[2] + spread[3], axis, mean: s.map((v) => v / w) };
}

// Sort the box along its widest axis and cut where the two halves have the
// least total squared error (better than a population median for flat art).
function splitBox(h, order, box) {
  const { lo, hi, axis } = box;
  const sub = Array.from(order.subarray(lo, hi));
  sub.sort((x, y) => h.pts[x * 4 + axis] - h.pts[y * 4 + axis]);
  order.set(sub, lo);
  const total = box.mean.map((m) => m * box.w);
  const sl = [0, 0, 0, 0];
  let nl = 0;
  let bestScore = -1;
  let bestAt = lo + 1;
  for (let i = lo; i < hi - 1; i++) {
    const j = order[i];
    const c = h.cnt[j];
    nl += c;
    for (let ch = 0; ch < 4; ch++) sl[ch] += c * h.pts[j * 4 + ch];
    const nr = box.w - nl;
    let score = 0;
    for (let ch = 0; ch < 4; ch++) {
      const r = total[ch] - sl[ch];
      score += (sl[ch] * sl[ch]) / nl + (r * r) / nr;
    }
    if (score > bestScore) {
      bestScore = score;
      bestAt = i + 1;
    }
  }
  return [makeBox(h, order, lo, bestAt), makeBox(h, order, bestAt, hi)];
}

async function medianCut(h, k, tick) {
  const order = new Uint32Array(h.n);
  for (let i = 0; i < h.n; i++) order[i] = i;
  const boxes = [makeBox(h, order, 0, h.n)];
  while (boxes.length < k) {
    let bi = -1;
    let best = 0;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.hi - b.lo > 1 && b.sse > best) {
        best = b.sse;
        bi = i;
      }
    }
    if (bi < 0) break;
    const [a, b] = splitBox(h, order, boxes[bi]);
    boxes[bi] = a;
    boxes.push(b);
    await tick();
  }
  const pal = new Float64Array(boxes.length * 4);
  boxes.forEach((b, i) => pal.set(b.mean, i * 4));
  return pal;
}

function nearest(pal, k, v0, v1, v2, v3) {
  let best = 0;
  let bd = Infinity;
  for (let i = 0, p = 0; i < k; i++, p += 4) {
    let d = v0 - pal[p];
    d *= d;
    if (d >= bd) continue;
    let e = v1 - pal[p + 1];
    d += e * e;
    if (d >= bd) continue;
    e = v2 - pal[p + 2];
    d += e * e;
    if (d >= bd) continue;
    e = v3 - pal[p + 3];
    d += e * e;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

// Lloyd iterations over the histogram buckets: moves each palette color to
// the mean of the pixels that actually map to it.
async function refine(h, pal, tick) {
  const k = pal.length / 4;
  const work = h.n * k;
  const iterations = work > 30e6 ? 1 : work > 8e6 ? 2 : 3;
  for (let it = 0; it < iterations; it++) {
    const acc = new Float64Array(k * 4);
    const w = new Float64Array(k);
    for (let j = 0; j < h.n; j++) {
      const p = j * 4;
      const idx = nearest(pal, k, h.pts[p], h.pts[p + 1], h.pts[p + 2], h.pts[p + 3]);
      const c = h.cnt[j];
      w[idx] += c;
      for (let ch = 0; ch < 4; ch++) acc[idx * 4 + ch] += c * h.pts[p + ch];
      if ((j & 0x3fff) === 0) await tick();
    }
    for (let i = 0; i < k; i++) {
      if (w[i] > 0) for (let ch = 0; ch < 4; ch++) pal[i * 4 + ch] = acc[i * 4 + ch] / w[i];
    }
  }
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

// Floyd-Steinberg weights 7/16 ahead, 3/16 behind-below, 5/16 below, 1/16
// ahead-below. `d` is +4 or -4 (serpentine direction, 4 channels per pixel).
function spread(cur, next, e, d, er, eg, eb, ea) {
  cur[e + d] += er * 0.4375;
  cur[e + d + 1] += eg * 0.4375;
  cur[e + d + 2] += eb * 0.4375;
  cur[e + d + 3] += ea * 0.4375;
  next[e - d] += er * 0.1875;
  next[e - d + 1] += eg * 0.1875;
  next[e - d + 2] += eb * 0.1875;
  next[e - d + 3] += ea * 0.1875;
  next[e] += er * 0.3125;
  next[e + 1] += eg * 0.3125;
  next[e + 2] += eb * 0.3125;
  next[e + 3] += ea * 0.3125;
  next[e + d] += er * 0.0625;
  next[e + d + 1] += eg * 0.0625;
  next[e + d + 2] += eb * 0.0625;
  next[e + d + 3] += ea * 0.0625;
}

// Map every pixel to a palette index. palW: weighted premultiplied points
// (for distance); palU: unweighted premultiplied (for dithering error).
async function mapPixels(img, palW, palU, transparentIndex, dither, tick) {
  const { width: w, height: h, data } = img;
  const k = palW.length / 4;
  const out = new Uint8Array(w * h);
  // 6 bits per premultiplied color channel + 4 bits alpha.
  const cache = new Int16Array(1 << 22).fill(-1);
  const look = (r, g, b, a) => {
    const key = ((r >> 2) << 16) | ((g >> 2) << 10) | ((b >> 2) << 4) | (a >> 4);
    let idx = cache[key];
    if (idx < 0) {
      idx = nearest(palW, k, r * SQW[0], g * SQW[1], b * SQW[2], a * SQW[3]);
      cache[key] = idx;
    }
    return idx;
  };
  let cur = new Float32Array((w + 2) * 4);
  let next = new Float32Array((w + 2) * 4);
  for (let y = 0; y < h; y++) {
    const ltr = (y & 1) === 0;
    const d = ltr ? 4 : -4;
    if (dither) next.fill(0);
    for (let step = 0; step < w; step++) {
      const x = ltr ? step : w - 1 - step;
      const i = y * w + x;
      const p = i * 4;
      const a0 = data[p + 3];
      if (a0 === 0 && transparentIndex >= 0) {
        out[i] = transparentIndex;
        continue;
      }
      const f = a0 / 255;
      if (!dither) {
        out[i] = look((data[p] * f + 0.5) | 0, (data[p + 1] * f + 0.5) | 0, (data[p + 2] * f + 0.5) | 0, a0);
        continue;
      }
      const e = (x + 1) * 4;
      const a = clamp255(a0 + cur[e + 3]);
      const r = clamp255(data[p] * f + cur[e]);
      const g = clamp255(data[p + 1] * f + cur[e + 1]);
      const b = clamp255(data[p + 2] * f + cur[e + 2]);
      const idx = look((r + 0.5) | 0, (g + 0.5) | 0, (b + 0.5) | 0, (a + 0.5) | 0);
      out[i] = idx;
      const q = idx * 4;
      spread(cur, next, e, d, r - palU[q], g - palU[q + 1], b - palU[q + 2], a - palU[q + 3]);
    }
    if (dither) [cur, next] = [next, cur];
    if ((y & 7) === 0) await tick();
  }
  return out;
}

// Drop unused and duplicate entries, put translucent entries first (so tRNS
// stays short) and sort the rest by luminance (helps the PNG filters).
function tidyPalette(palette, indices) {
  const k = palette.length / 4;
  const used = new Uint8Array(k);
  for (let i = 0; i < indices.length; i++) used[indices[i]] = 1;
  const byKey = new Map();
  const merged = new Int32Array(k).fill(-1);
  const keep = [];
  for (let i = 0; i < k; i++) {
    if (!used[i]) continue;
    const p = i * 4;
    const key = palette[p + 3] === 0 ? 0 : ((palette[p] << 24) | (palette[p + 1] << 16) | (palette[p + 2] << 8) | palette[p + 3]) >>> 0;
    if (byKey.has(key)) {
      merged[i] = byKey.get(key);
      continue;
    }
    byKey.set(key, i);
    merged[i] = i;
    keep.push(i);
  }
  const lum = (i) => 0.299 * palette[i * 4] + 0.587 * palette[i * 4 + 1] + 0.114 * palette[i * 4 + 2];
  keep.sort((x, y) => {
    const ax = palette[x * 4 + 3];
    const ay = palette[y * 4 + 3];
    const tx = ax < 255;
    const ty = ay < 255;
    if (tx !== ty) return tx ? -1 : 1;
    if (tx && ax !== ay) return ax - ay;
    return lum(x) - lum(y);
  });
  const remap = new Uint8Array(k);
  const out = new Uint8Array(keep.length * 4);
  keep.forEach((old, nu) => {
    out.set(palette.subarray(old * 4, old * 4 + 4), nu * 4);
    remap[old] = nu;
  });
  for (let i = 0; i < k; i++) if (merged[i] >= 0) remap[i] = remap[merged[i]];
  for (let i = 0; i < indices.length; i++) indices[i] = remap[indices[i]];
  if (out[3] === 0) out.fill(0, 0, 3);
  return out;
}

// image: { width, height, data: RGBA bytes } -> { palette: Uint8Array (RGBA
// per entry), indices: Uint8Array (one per pixel), colors, exact }.
export async function quantize(image, { colors = 256, dither = true } = {}) {
  const img = checkImage(image);
  const limit = Math.max(2, Math.min(256, Math.round(colors) || 256));
  const tick = ticker();
  const exact = exactPalette(img, limit);
  if (exact) {
    const palette = tidyPalette(exact.palette, exact.indices);
    return { palette, indices: exact.indices, colors: palette.length / 4, exact: true };
  }
  const h = await histogram(img, tick);
  const reserve = h.transparent > 0 ? 1 : 0;
  const k = Math.max(1, limit - reserve);
  let palW = h.n ? await medianCut(h, k, tick) : new Float64Array(0);
  if (h.n) await refine(h, palW, tick);
  if (reserve) {
    const withClear = new Float64Array(palW.length + 4);
    withClear.set(palW);
    palW = withClear;
  }
  const count = palW.length / 4;
  const palU = new Float64Array(palW.length);
  for (let i = 0; i < palW.length; i++) palU[i] = palW[i] / SQW[i & 3];
  const indices = await mapPixels(img, palW, palU, reserve ? count - 1 : -1, !!dither, tick);
  const palette = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const p = i * 4;
    const a = Math.round(clamp255(palU[p + 3]));
    if (a === 0) continue;
    for (let ch = 0; ch < 3; ch++) palette[p + ch] = Math.round(clamp255((palU[p + ch] * 255) / palU[p + 3]));
    palette[p + 3] = a;
  }
  const tidy = tidyPalette(palette, indices);
  return { palette: tidy, indices, colors: tidy.length / 4, exact: false };
}

// ---- PNG encoding -------------------------------------------------------

export function bitDepthFor(colors) {
  return colors <= 2 ? 1 : colors <= 4 ? 2 : colors <= 16 ? 4 : 8;
}

function packRows(indices, width, height, depth) {
  const rowBytes = Math.ceil((width * depth) / 8);
  const raw = new Uint8Array(rowBytes * height);
  if (depth === 8) {
    raw.set(indices.subarray(0, width * height));
    return { raw, rowBytes };
  }
  const per = 8 / depth;
  for (let y = 0; y < height; y++) {
    const src = y * width;
    const dst = y * rowBytes;
    for (let x = 0; x < width; x++) {
      raw[dst + ((x / per) | 0)] |= indices[src + x] << (8 - depth * ((x % per) + 1));
    }
  }
  return { raw, rowBytes };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Fill `out` with filter type t applied to `row`; returns the sum of absolute
// (signed) byte values, stopping early once it reaches `limit`. bpp is 1 for
// palette images at every bit depth.
function applyFilter(t, row, prev, out, limit) {
  let cost = 0;
  for (let i = 0; i < row.length; i++) {
    const x = row[i];
    const a = i > 0 ? row[i - 1] : 0;
    const b = prev ? prev[i] : 0;
    let v;
    if (t === 0) v = x;
    else if (t === 1) v = x - a;
    else if (t === 2) v = x - b;
    else if (t === 3) v = x - ((a + b) >> 1);
    else v = x - paeth(a, b, prev && i > 0 ? prev[i - 1] : 0);
    v &= 255;
    out[i] = v;
    cost += v < 128 ? v : 256 - v;
    if (cost >= limit) return cost;
  }
  return cost;
}

// Per-scanline filter choice by minimum sum of absolute differences.
export function filterScanlines(raw, rowBytes, height, { adaptive = true } = {}) {
  const out = new Uint8Array((rowBytes + 1) * height);
  const cand = Array.from({ length: 5 }, () => new Uint8Array(rowBytes));
  for (let y = 0; y < height; y++) {
    const row = raw.subarray(y * rowBytes, (y + 1) * rowBytes);
    const prev = y > 0 ? raw.subarray((y - 1) * rowBytes, y * rowBytes) : null;
    const at = y * (rowBytes + 1);
    if (!adaptive) {
      out[at] = 0;
      out.set(row, at + 1);
      continue;
    }
    let bestType = 0;
    let bestCost = Infinity;
    for (let t = 0; t < 5; t++) {
      const cost = applyFilter(t, row, prev, cand[t], bestCost);
      if (cost < bestCost) {
        bestCost = cost;
        bestType = t;
      }
    }
    out[at] = bestType;
    out.set(cand[bestType], at + 1);
  }
  return out;
}

export async function zlibDeflate(bytes) {
  if (typeof CompressionStream !== "function") throw Error("This browser cannot make compressed PNG files.");
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// { width, height, palette: RGBA Uint8Array, indices } -> PNG bytes.
export async function encodeIndexedPng({ width, height, palette, indices }) {
  const count = palette.length / 4;
  if (!Number.isInteger(count) || count < 1 || count > 256) throw Error("png8: the palette needs 1 to 256 colors.");
  if (!indices || indices.length < width * height) throw Error("png8: the index data is incomplete.");
  const depth = bitDepthFor(count);

  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  ihdr[8] = depth;
  ihdr[9] = 3; // color type: indexed
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const plte = new Uint8Array(count * 3);
  let lastAlpha = -1;
  for (let i = 0; i < count; i++) {
    plte[i * 3] = palette[i * 4];
    plte[i * 3 + 1] = palette[i * 4 + 1];
    plte[i * 3 + 2] = palette[i * 4 + 2];
    if (palette[i * 4 + 3] < 255) lastAlpha = i;
  }

  const { raw, rowBytes } = packRows(indices, width, height, depth);
  let idat = await zlibDeflate(filterScanlines(raw, rowBytes, height, { adaptive: true }));
  // Indexed images often compress best unfiltered; keep whichever is smaller.
  if (raw.length <= 24e6) {
    const plain = await zlibDeflate(filterScanlines(raw, rowBytes, height, { adaptive: false }));
    if (plain.length < idat.length) idat = plain;
  }

  const chunks = [SIGNATURE, chunk("IHDR", ihdr), chunk("PLTE", plte)];
  if (lastAlpha >= 0) {
    const trns = new Uint8Array(lastAlpha + 1);
    for (let i = 0; i <= lastAlpha; i++) trns[i] = palette[i * 4 + 3];
    chunks.push(chunk("tRNS", trns));
  }
  chunks.push(chunk("IDAT", idat), chunk("IEND", new Uint8Array(0)));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// { width, height, data } -> { bytes, colors, depth, exact }.
export async function encodePng8Data(image, { colors = 256, dither = true } = {}) {
  const img = checkImage(image);
  const q = await quantize(img, { colors, dither });
  const bytes = await encodeIndexedPng({ width: img.width, height: img.height, palette: q.palette, indices: q.indices });
  return { bytes, colors: q.colors, depth: bitDepthFor(q.colors), exact: q.exact };
}

function scratchCanvas(w, h) {
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h);
}

// Canvas, OffscreenCanvas, ImageBitmap, ImageData or { width, height, data }
// -> RGBA pixels.
export function readPixels(source) {
  if (source?.data && !source.getContext && Number.isInteger(source.width)) return source;
  const w = source.width;
  const h = source.height;
  let ctx2d = null;
  try {
    ctx2d = source.getContext?.("2d") || null;
  } catch {
    ctx2d = null;
  }
  if (!ctx2d) {
    const c = scratchCanvas(w, h);
    ctx2d = c.getContext("2d");
    ctx2d.drawImage(source, 0, 0);
  }
  return ctx2d.getImageData(0, 0, w, h);
}

// Canvas -> indexed PNG Blob with at most `colors` colors.
export async function encodePng8(canvas, { colors = 256, dither = true } = {}) {
  const { bytes } = await encodePng8Data(readPixels(canvas), { colors, dither });
  return new Blob([bytes], { type: "image/png" });
}
