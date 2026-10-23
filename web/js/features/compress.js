// Export engine: encode, fit under a file size, resize, convert, download,
// copy. Main.js exposes this module's namespace as ctx.exporter.

import { encodePng8 } from "./png8.js";

export { encodePng8 } from "./png8.js";
export { makeZip } from "./zip.js";

export const FORMATS = [
  { type: "image/png", label: "PNG", ext: "png", alpha: true, lossy: false },
  { type: "image/jpeg", label: "JPG", ext: "jpg", alpha: false, lossy: true },
  { type: "image/webp", label: "WebP", ext: "webp", alpha: true, lossy: true },
];

const EXTS = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/avif": "avif", "image/gif": "gif" };

export function extFor(type) {
  return EXTS[String(type || "").toLowerCase()] || "png";
}

export function labelFor(type) {
  return FORMATS.find((f) => f.type === type)?.label || extFor(type).toUpperCase();
}

const abortError = () => (typeof DOMException === "function" ? new DOMException("Cancelled", "AbortError") : Object.assign(Error("Cancelled"), { name: "AbortError" }));

function checkAbort(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
}

// ---- sizes and names -----------------------------------------------------

// Decimal units (1 MB = 1,000,000 bytes) because that is how YouTube, Spotify
// and most upload forms state their limits. Values round UP, so a file that is
// over a limit never reads as under it ("2.0 MB" is always <= 2,000,000).
export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1000) return `${Math.ceil(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1000;
  let u = 0;
  for (;;) {
    let decimals = 1;
    let rounded = Math.ceil(v * 10 - 1e-9) / 10;
    if (rounded >= 100) {
      decimals = 0;
      rounded = Math.ceil(v - 1e-9);
    }
    if (rounded >= 1000 && u < units.length - 1) {
      v /= 1000;
      u++;
      continue;
    }
    return `${rounded.toFixed(decimals)} ${units[u]}`;
  }
}

// A file name every OS accepts, with the right extension for `type`.
export function safeFileName(name, type) {
  let base = String(name ?? "")
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(base)) base = `${base}-image`;
  if (!base) base = "longitude";
  if (!type) return base.slice(0, 120);
  const ext = extFor(type);
  // JPEG's other extensions too, so a kept "photo.jfif" saves as "photo.jpg".
  const known = /\.(png|jpe?g|jfif|jpe|pjpeg|pjp|webp|avif|gif)$/i;
  if (known.test(base)) base = base.replace(known, "");
  return `${base.slice(0, 120) || "longitude"}.${ext}`;
}

// ---- canvases ------------------------------------------------------------

// The largest canvas Chrome and Firefox make: 16384 px a side, about 268 MP.
export const MAX_CANVAS_SIDE = 16384;
export const MAX_CANVAS_PIXELS = 268e6;
// Safari (iOS above all) refuses canvases over 4096 x 4096 worth of pixels.
export const SAFE_CANVAS_PIXELS = 16_777_216;

// (w, h) scaled down, keeping the aspect, until it fits both limits.
// capped is true when it had to shrink.
export function capDims(w, h, { maxSide = MAX_CANVAS_SIDE, maxPixels = MAX_CANVAS_PIXELS } = {}) {
  const s = Math.min(1, maxSide / Math.max(w, h), Math.sqrt(maxPixels / (w * h)));
  if (!(s < 1)) return { width: w, height: h, capped: false };
  // The epsilon keeps 20000 * (16384 / 20000) from flooring to 16383.
  return { width: Math.max(1, Math.floor(w * s + 1e-7)), height: Math.max(1, Math.floor(h * s + 1e-7)), capped: true };
}

export function createCanvas(width, height) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h);
}

function sizeOf(source) {
  return {
    w: source.naturalWidth || source.videoWidth || source.displayWidth || source.width || 0,
    h: source.naturalHeight || source.videoHeight || source.displayHeight || source.height || 0,
  };
}

const tooLarge = () => Error("This image is too large for this browser.");

function context2d(canvas) {
  const c = canvas.getContext("2d");
  if (!c) throw tooLarge();
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = "high";
  return c;
}

// The colour to put under a transparent design for formats without alpha:
// the document's own background colour, else white.
export function flattenColor(doc) {
  const bg = doc?.background;
  if (bg?.kind === "color" && bg.color) return bg.color;
  if (bg?.kind === "gradient" && bg.from) return bg.from;
  return "#ffffff";
}

// New canvas: `color` underneath, then the source on top.
export function flatten(canvas, color = "#ffffff") {
  const { w, h } = sizeOf(canvas);
  const out = createCanvas(w, h);
  const c = out.getContext("2d");
  c.fillStyle = color || "#ffffff";
  c.fillRect(0, 0, w, h);
  c.drawImage(canvas, 0, 0);
  return out;
}

// Source rect, destination rect for a fit mode.
export function fitRects(sw, sh, w, h, fit = "stretch") {
  if (fit === "cover") {
    const s = Math.max(w / sw, h / sh);
    const cw = w / s;
    const ch = h / s;
    return { src: { x: (sw - cw) / 2, y: (sh - ch) / 2, w: cw, h: ch }, dst: { x: 0, y: 0, w, h } };
  }
  if (fit === "contain") {
    const s = Math.min(w / sw, h / sh);
    const dw = sw * s;
    const dh = sh * s;
    return { src: { x: 0, y: 0, w: sw, h: sh }, dst: { x: (w - dw) / 2, y: (h - dh) / 2, w: dw, h: dh } };
  }
  return { src: { x: 0, y: 0, w: sw, h: sh }, dst: { x: 0, y: 0, w, h } };
}

// Resize with stepwise halving for big reductions (one bilinear pass from 4x
// or more skips pixels and shimmers), then a final high-quality draw.
// fit: "stretch" | "cover" (crop to fill) | "contain" (letterbox).
// background: optional fill under the image (use it for JPG).
export function resizeCanvas(source, width, height, { fit = "stretch", background = null } = {}) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const { w: sw, h: sh } = sizeOf(source);
  if (!sw || !sh) throw Error("The image has no size.");
  const { src, dst } = fitRects(sw, sh, w, h, fit);
  let img = source;
  let rect = src;
  const tw = Math.max(1, dst.w);
  const th = Math.max(1, dst.h);
  while (rect.w > tw * 2 || rect.h > th * 2) {
    const nw = Math.max(Math.ceil(tw), Math.round(rect.w / 2));
    const nh = Math.max(Math.ceil(th), Math.round(rect.h / 2));
    const step = createCanvas(nw, nh);
    context2d(step).drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, nw, nh);
    img = step;
    rect = { x: 0, y: 0, w: nw, h: nh };
  }
  const out = createCanvas(w, h);
  const c = context2d(out);
  if (background) {
    c.fillStyle = background;
    c.fillRect(0, 0, w, h);
  }
  c.drawImage(img, rect.x, rect.y, rect.w, rect.h, dst.x, dst.y, dst.w, dst.h);
  return out;
}

// ---- encoding ------------------------------------------------------------

const encodeSupport = new Map();

// Whether this browser can write `type` (Firefox and Safari cannot always
// write WebP; canvas silently falls back to PNG). Cached per type.
export function canEncode(type) {
  if (type === "image/png") return Promise.resolve(true);
  if (!encodeSupport.has(type)) {
    encodeSupport.set(
      type,
      (async () => {
        try {
          const blob = await rawEncode(createCanvas(2, 2), type, 0.8);
          return blob?.type === type;
        } catch {
          return false;
        }
      })(),
    );
  }
  return encodeSupport.get(type);
}

function rawEncode(canvas, type, quality) {
  if (typeof canvas.convertToBlob === "function") return canvas.convertToBlob({ type, quality });
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function checkedEncode(canvas, type, quality) {
  const q = Math.min(1, Math.max(0, Number.isFinite(quality) ? quality : 0.92));
  const blob = await rawEncode(canvas, type, q);
  if (!blob) throw Error("Could not encode the image. It may be too large for this browser.");
  if (blob.type !== type) throw Error(`This browser cannot save ${labelFor(type)} files. Try PNG or JPG.`);
  return blob;
}

// Flatten for JPG (no transparency) always, for WebP only when asked.
const needsFlatten = (type, background) => type === "image/jpeg" || (!!background && type !== "image/png");

// Canvas -> Blob. JPG has no transparency, so it is flattened onto
// `background` (white by default); pass a background for WebP to flatten too.
export async function encode(canvas, { type = "image/png", quality = 0.92, background = null } = {}) {
  const src = needsFlatten(type, background) ? flatten(canvas, background || "#ffffff") : canvas;
  return checkedEncode(src, type, quality);
}

const round2 = (v) => Math.round(v * 100) / 100;

// Find the highest quality whose file fits in maxBytes, testing both ends
// first and then bisecting. encodeAt(q) -> Promise<{ size, ... }>.
// order "hi-first" when a fit at full quality is likely, "lo-first" to bail
// out fast when even the lowest quality is probably too big.
export async function searchQuality(encodeAt, { maxBytes, lo = 0.35, hi = 0.92, maxSteps = 7, order = "hi-first", signal } = {}) {
  lo = round2(Math.min(lo, hi));
  hi = round2(hi);
  let tries = 0;
  let best = null;
  let smallest = null;
  const run = async (q) => {
    checkAbort(signal);
    const r = await encodeAt(q);
    tries++;
    if (!smallest || r.size < smallest.size) smallest = r;
    return r;
  };
  const ends = order === "lo-first" ? [lo, hi] : [hi, lo];
  for (const q of ends) {
    if (tries >= maxSteps) break;
    const r = await run(q);
    if (r.size <= maxBytes) {
      if (q === hi) return { best: r, smallest, tries };
      best = r;
    } else if (q === lo) {
      return { best: null, smallest, tries };
    }
    if (lo === hi) break;
  }
  if (!best) return { best: null, smallest, tries };
  let a = lo;
  let b = hi;
  while (tries < maxSteps && b - a > 0.015) {
    const mid = round2((a + b) / 2);
    if (mid <= a || mid >= b) break;
    const r = await run(mid);
    if (r.size <= maxBytes) {
      best = r;
      a = mid;
    } else {
      b = mid;
    }
  }
  return { best, smallest, tries };
}

// Sizes to try when quality alone is not enough: 90%, 80%, ... of the
// original, while both sides stay at least `minSide` px and the width and
// height stay at least minWidth / minHeight (a platform's smallest size).
export function downscaleSteps(width, height, { step = 0.1, minSide = 16, minWidth = 0, minHeight = 0 } = {}) {
  const out = [];
  for (let i = 1; ; i++) {
    const scale = round2(1 - step * i);
    if (scale <= 0) break;
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    if (w < minSide || h < minSide || w < minWidth || h < minHeight) break;
    out.push({ scale, width: w, height: h });
  }
  return out;
}

const PNG8_STEPS = [256, 128, 64];

// Make a file no bigger than maxBytes.
// Lossy (JPG/WebP): bisect quality between minQuality and `quality` (at most
// 7 encodes), then, if allowDownscale, shrink in 10% steps and search again.
// PNG: lossless first, then 256/128/64-colour PNG, then shrink in 10% steps
// (256 colours). `colors` starts PNG at that palette size (the export
// dialog's "256-colour PNG" toggle). minWidth / minHeight: never shrink
// below this size (fits is then false when it would have needed to).
// onStep(step) fires after every encode:
//   { n, kind: "quality"|"colors"|"lossless", type, quality, colors, scale, width, height, bytes, fits }
// Returns { blob, type, quality, colors, scale, width, height, bytes, fits, steps }.
// fits is false when nothing fitted; blob is then the smallest attempt.
export async function encodeToTarget(canvas, opts = {}) {
  const {
    type = "image/jpeg",
    maxBytes = 0,
    quality = 0.92,
    minQuality = 0.35,
    allowDownscale = true,
    onStep = null,
    background = null,
    colors = null,
    dither = true,
    signal = null,
    minWidth = 0,
    minHeight = 0,
  } = opts;
  const W = canvas.width;
  const H = canvas.height;
  const steps = [];
  const lossy = type !== "image/png";
  const base = needsFlatten(type, background) ? flatten(canvas, background || "#ffffff") : canvas;

  const attempt = async (src, scale, kind, { q = null, c = null } = {}) => {
    checkAbort(signal);
    const blob = kind === "colors" ? await encodePng8(src, { colors: c, dither }) : await checkedEncode(src, type, q ?? quality);
    const step = {
      n: steps.length + 1,
      kind,
      type: blob.type,
      quality: kind === "quality" ? q : null,
      colors: kind === "colors" ? c : null,
      scale,
      width: src.width,
      height: src.height,
      bytes: blob.size,
      fits: !maxBytes || blob.size <= maxBytes,
    };
    steps.push(step);
    onStep?.(step);
    return { ...step, size: blob.size, blob };
  };

  const finish = (r, fits) => ({
    blob: r.blob,
    type: r.blob.type,
    quality: r.quality,
    colors: r.colors,
    scale: r.scale,
    width: r.width,
    height: r.height,
    bytes: r.bytes,
    fits,
    steps,
  });

  if (!maxBytes || maxBytes <= 0) {
    const r = colors && !lossy ? await attempt(base, 1, "colors", { c: colors }) : await attempt(base, 1, lossy ? "quality" : "lossless", { q: quality });
    return finish(r, true);
  }

  const sizes = [{ scale: 1, width: W, height: H }, ...(allowDownscale ? downscaleSteps(W, H, { minWidth, minHeight }) : [])];
  let smallest = null;
  const keepSmallest = (r) => {
    if (r && (!smallest || r.bytes < smallest.bytes)) smallest = r;
  };

  if (lossy) {
    const hi = Math.max(minQuality, Math.min(1, quality));
    for (const s of sizes) {
      const src = s.scale === 1 ? base : resizeCanvas(base, s.width, s.height);
      const found = await searchQuality((q) => attempt(src, s.scale, "quality", { q }), {
        maxBytes,
        lo: minQuality,
        hi,
        maxSteps: 7,
        order: s.scale === 1 ? "hi-first" : "lo-first",
        signal,
      });
      keepSmallest(found.smallest);
      if (found.best) return finish(found.best, true);
    }
    return finish(smallest, false);
  }

  const first = colors ? Math.max(2, Math.min(256, Math.round(colors))) : 0;
  const palettes = first ? [first, ...PNG8_STEPS.filter((c) => c < first)] : PNG8_STEPS;
  if (!colors) {
    const r = await attempt(base, 1, "lossless");
    keepSmallest(r);
    if (r.fits) return finish(r, true);
  }
  for (const c of palettes) {
    const r = await attempt(base, 1, "colors", { c });
    keepSmallest(r);
    if (r.fits) return finish(r, true);
  }
  for (const s of sizes.slice(1)) {
    const r = await attempt(resizeCanvas(base, s.width, s.height), s.scale, "colors", { c: palettes[0] });
    keepSmallest(r);
    if (r.fits) return finish(r, true);
  }
  return finish(smallest, false);
}

// ---- files in and out ----------------------------------------------------

const isSvg = (file) => /svg/i.test(file?.type || "") || /\.svg$/i.test(file?.name || "");

// SVGs without width/height do not draw in some browsers; give them one from
// the viewBox, at least `minSide` px on the long side so logos stay crisp.
async function svgBlob(file, minSide) {
  const text = await file.text();
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== "svg") throw Error("This SVG file could not be read.");
  const num = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 && !/%$/.test(String(v).trim()) ? n : 0;
  };
  const vb = (root.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
  let w = num(root.getAttribute("width")) || (vb.length === 4 ? vb[2] : 0);
  let h = num(root.getAttribute("height")) || (vb.length === 4 ? vb[3] : 0);
  if (!(w > 0 && h > 0)) {
    w = minSide;
    h = minSide;
  }
  const s = Math.max(1, minSide / Math.max(w, h));
  if (!root.getAttribute("viewBox")) root.setAttribute("viewBox", `0 0 ${w} ${h}`);
  root.setAttribute("width", String(Math.round(w * s)));
  root.setAttribute("height", String(Math.round(h * s)));
  return new Blob([new XMLSerializer().serializeToString(doc)], { type: "image/svg+xml" });
}

async function loadImageElement(blob) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.decoding = "async";
  try {
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(Error("This file is not an image Longitude can open."));
      img.src = url;
    });
    return { img, done: () => URL.revokeObjectURL(url) };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

async function decodeBitmap(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return await createImageBitmap(file);
  }
}

// onePass skips resizeCanvas's halving steps, whose in-between canvases can
// be over the limit of a browser that just refused a big one.
function drawAt(source, w, h, size, { onePass = false } = {}) {
  if (size.capped && !onePass) return resizeCanvas(source, size.width, size.height);
  const out = createCanvas(size.width, size.height);
  context2d(out).drawImage(source, 0, 0, w, h, 0, 0, size.width, size.height);
  return out;
}

// File -> { canvas, naturalWidth, naturalHeight, capped }. The canvas is the
// image at its natural size (EXIF orientation applied; GIF: first frame;
// SVG: at least 1024 px on the long side), shrunk only to fit maxSide and
// maxPixels (the browser's canvas limits by default). capped says it shrank.
// A browser that refuses the canvas (Safari) gets a 16.7 MP one instead.
export async function readImageFile(file, { maxSide = MAX_CANVAS_SIDE, maxPixels = MAX_CANVAS_PIXELS } = {}) {
  let source;
  let done = () => {};
  if (isSvg(file)) {
    const loaded = await loadImageElement(await svgBlob(file, Math.min(1024, maxSide)));
    source = loaded.img;
    done = loaded.done;
  } else {
    try {
      source = await decodeBitmap(file);
      done = () => source.close?.();
    } catch {
      const loaded = await loadImageElement(file);
      source = loaded.img;
      done = loaded.done;
    }
  }
  try {
    const { w, h } = sizeOf(source);
    if (!w || !h) throw Error("This image has no size.");
    let size = capDims(w, h, { maxSide, maxPixels });
    let canvas;
    try {
      canvas = drawAt(source, w, h, size);
    } catch (err) {
      const safe = capDims(w, h, { maxSide, maxPixels: Math.min(maxPixels, SAFE_CANVAS_PIXELS) });
      if (!safe.capped || safe.width >= size.width) throw err;
      size = safe;
      canvas = drawAt(source, w, h, size, { onePass: true });
    }
    return { canvas, naturalWidth: w, naturalHeight: h, capped: size.capped };
  } finally {
    done();
  }
}

// File -> canvas (readImageFile without the size details).
export async function fileToCanvas(file, opts) {
  return (await readImageFile(file, opts)).canvas;
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = safeFileName(filename || "longitude", blob.type?.startsWith("image/") ? blob.type : null);
  a.rel = "noopener";
  a.style.display = "none";
  document.body.append(a);
  a.click();
  a.remove();
  // Revoke late: some browsers start reading the URL after click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function toPngBlob(blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const c = createCanvas(bitmap.width, bitmap.height);
    c.getContext("2d").drawImage(bitmap, 0, 0);
    return await encode(c, { type: "image/png" });
  } finally {
    bitmap.close?.();
  }
}

// Copy an image (Blob or canvas) to the clipboard as PNG, the one image type
// every browser's clipboard accepts. Resolves false when not possible.
export async function copyImage(blobOrCanvas) {
  if (!globalThis.navigator?.clipboard?.write || typeof ClipboardItem === "undefined") return false;
  const isBlob = typeof Blob !== "undefined" && blobOrCanvas instanceof Blob;
  const png = isBlob
    ? blobOrCanvas.type === "image/png"
      ? Promise.resolve(blobOrCanvas)
      : toPngBlob(blobOrCanvas)
    : encode(blobOrCanvas, { type: "image/png" });
  try {
    // A promise keeps the user gesture alive while a conversion runs (Safari).
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    return true;
  } catch {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": await png })]);
      return true;
    } catch {
      return false;
    }
  }
}
