// Pure pre- and post-processing for the segmentation models. No DOM, no
// canvas: runs in the worker, on the main thread and in Deno tests.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// RGBA bytes (already resized to the model's input size) -> NCHW float32,
// (x * scale - mean) / std per channel. Alpha is ignored.
export function toInputTensor(rgba, width, height, { scale = 1 / 255, mean = [0, 0, 0], std = [1, 1, 1] } = {}) {
  const n = width * height;
  const out = new Float32Array(3 * n);
  const k0 = scale / std[0];
  const k1 = scale / std[1];
  const k2 = scale / std[2];
  const b0 = mean[0] / std[0];
  const b1 = mean[1] / std[1];
  const b2 = mean[2] / std[2];
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    out[i] = rgba[o] * k0 - b0;
    out[n + i] = rgba[o + 1] * k1 - b1;
    out[2 * n + i] = rgba[o + 2] * k2 - b2;
  }
  return out;
}

// float32 -> IEEE half bits (round to nearest even), for models with float16 input.
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
export function toHalf(value) {
  f32[0] = value;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  let e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let half = mant >>> shift;
    const rem = mant & ((1 << shift) - 1);
    const mid = 1 << (shift - 1);
    if (rem > mid || (rem === mid && half & 1)) half++;
    return sign | half;
  }
  let half = (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && half & 1)) half++;
  return sign | half;
}

export function fromHalf(h) {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >>> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 0x1f) return mant ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

export function toHalfArray(src) {
  const out = new Uint16Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = toHalf(src[i]);
  return out;
}

// Tensor data of any float type -> Float32Array.
export function toFloat32(data, type = "float32") {
  if (data instanceof Float32Array) return data;
  if (type === "float16" && data instanceof Uint16Array) {
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = fromHalf(data[i]);
    return out;
  }
  return Float32Array.from(data, Number);
}

// Raw model output -> probabilities 0..1 (new array).
//   sigmoid: the model outputs logits
//   minmax:  stretch to the output's own range (IS-Net, as rembg does); a nearly
//            flat output is left alone so an empty prediction stays empty
//   clamp:   already 0..1
export function activate(data, kind = "sigmoid") {
  const out = new Float32Array(data.length);
  if (kind === "sigmoid") {
    for (let i = 0; i < data.length; i++) out[i] = 1 / (1 + Math.exp(-data[i]));
    return out;
  }
  let lo = Infinity;
  let hi = -Infinity;
  if (kind === "minmax") {
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (kind === "minmax" && hi - lo > 0.2) {
    const k = 1 / (hi - lo);
    for (let i = 0; i < data.length; i++) out[i] = (data[i] - lo) * k;
  } else {
    for (let i = 0; i < data.length; i++) out[i] = clamp01(data[i]);
  }
  return out;
}

// Keys cubic (a = -0.5, Catmull-Rom).
function cubic(x) {
  x = Math.abs(x);
  if (x < 1) return 1.5 * x * x * x - 2.5 * x * x + 1;
  if (x < 2) return -0.5 * x * x * x + 2.5 * x * x - 4 * x + 2;
  return 0;
}

// Per output index: first source index, tap count and normalized weights.
// When shrinking, the kernel widens so every source pixel contributes.
function resampleTable(srcLen, dstLen) {
  const scale = srcLen / dstLen;
  const support = 2 * Math.max(1, scale);
  const taps = Math.ceil(support) * 2 + 1;
  const first = new Int32Array(dstLen);
  const count = new Int32Array(dstLen);
  const weights = new Float32Array(dstLen * taps);
  const filterScale = Math.max(1, scale);
  for (let i = 0; i < dstLen; i++) {
    const center = (i + 0.5) * scale;
    const a = Math.max(0, Math.floor(center - support));
    const b = Math.min(srcLen, Math.ceil(center + support));
    let sum = 0;
    let n = 0;
    for (let j = a; j < b && n < taps; j++, n++) {
      const w = cubic((j + 0.5 - center) / filterScale);
      weights[i * taps + n] = w;
      sum += w;
    }
    if (sum !== 0) for (let k = 0; k < n; k++) weights[i * taps + k] /= sum;
    first[i] = a;
    count[i] = n;
  }
  return { first, count, weights, taps };
}

// Separable bicubic resize of a single-channel float image (smooth upscaling
// of the model's mask to the photo's natural size).
export function resizeBicubic(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return Float32Array.from(src);
  const tx = resampleTable(sw, dw);
  const ty = resampleTable(sh, dh);
  const mid = new Float32Array(dw * sh);
  for (let y = 0; y < sh; y++) {
    const row = y * sw;
    for (let x = 0; x < dw; x++) {
      const f = tx.first[x];
      const base = x * tx.taps;
      let acc = 0;
      for (let k = 0; k < tx.count[x]; k++) acc += src[row + f + k] * tx.weights[base + k];
      mid[y * dw + x] = acc;
    }
  }
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const f = ty.first[y];
    const base = y * ty.taps;
    const n = ty.count[y];
    const o = y * dw;
    for (let k = 0; k < n; k++) {
      const w = ty.weights[base + k];
      const row = (f + k) * dw;
      for (let x = 0; x < dw; x++) out[o + x] += mid[row + x] * w;
    }
  }
  return out;
}

// [1 2 1] blur in both directions, in place.
export function blur121(data, w, h) {
  const tmp = new Float32Array(Math.max(w, h));
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const c = data[o + x];
      tmp[x] = ((x > 0 ? data[o + x - 1] : c) + 2 * c + (x < w - 1 ? data[o + x + 1] : c)) * 0.25;
    }
    data.set(tmp.subarray(0, w), o);
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const c = data[y * w + x];
      tmp[y] = ((y > 0 ? data[(y - 1) * w + x] : c) + 2 * c + (y < h - 1 ? data[(y + 1) * w + x] : c)) * 0.25;
    }
    for (let y = 0; y < h; y++) data[y * w + x] = tmp[y];
  }
  return data;
}

// Contrast curve: stretch lo..hi to 0..1 so faint haze disappears and solid
// areas become fully opaque, then bend toward a smoothstep by `curve` (0..1)
// so edges stay crisp while hair keeps its in-between values.
export function edgeCurve(v, { lo = 0.03, hi = 0.97, curve = 0.4 } = {}) {
  const t = clamp01((v - lo) / Math.max(1e-6, hi - lo));
  return t + (t * t * (3 - 2 * t) - t) * curve;
}

// Model output (outW x outH) -> keep-alpha bytes at the image's natural size.
export function outputToAlpha(raw, outW, outH, width, height, { activation = "sigmoid", refine = {} } = {}) {
  const prob = activate(raw, activation);
  const big = resizeBicubic(prob, outW, outH, width, height);
  if (refine.blur !== false) blur121(big, width, height);
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0; i < out.length; i++) out[i] = edgeCurve(big[i], refine) * 255;
  return out;
}
