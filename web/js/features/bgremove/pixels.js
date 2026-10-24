// The canvas helpers background removal needs from the start: sizes, new
// canvases and reading pixels (with an opt-in cache). mask.js re-exports them,
// so its callers see one module; this file stays small so the service in
// index.js can use it without loading the whole of mask.js at boot.

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

export function ctx2d(canvas) {
  return canvas.getContext("2d", { willReadFrequently: true });
}

export const isPixels = (s) => s && s.data && typeof s.width === "number" && typeof s.height === "number" && !s.getContext;

// Decoded images do not change, so a caller that reads the same image again
// and again (the magic eraser, once per click) can ask for the pixels to be
// kept: { cache: true }. At most two images, none over READ_CACHE_PIXELS, and
// all dropped after READ_CACHE_IDLE ms without a read, so a big photo's
// pixels are not held for the rest of the session.
const keptReads = [];
const READ_CACHE_PIXELS = 16e6;
const READ_CACHE_IDLE = 15000;
let readCacheTimer = 0;

function touchReadCache() {
  clearTimeout(readCacheTimer);
  readCacheTimer = keptReads.length ? setTimeout(clearReadCache, READ_CACHE_IDLE) : 0;
}

// Forget the pixels kept by readPixels(source, { cache: true }).
export function clearReadCache() {
  clearTimeout(readCacheTimer);
  readCacheTimer = 0;
  keptReads.length = 0;
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
  const at = keep ? keptReads.findIndex((r) => r.source === source) : -1;
  if (at >= 0) {
    const [hit] = keptReads.splice(at, 1);
    keptReads.unshift(hit);
    touchReadCache();
    return hit.pixels;
  }
  const g = ctx2d(makeCanvas(width, height));
  g.drawImage(source, 0, 0, width, height);
  const pixels = g.getImageData(0, 0, width, height);
  if (keep) {
    keptReads.unshift({ source, pixels });
    keptReads.length = Math.min(keptReads.length, 2);
    touchReadCache();
  }
  return pixels;
}
