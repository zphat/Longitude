// Canvas helpers and layer effects used by the renderer: canvases and scratch
// buffers, colors, CSS-style gradients, image adjustments, masks, sticker
// outlines, glow and drop shadow. Effect sizes are in doc px and take k, the
// device pixels per doc pixel, so every zoom and export scale looks the same.

const TAU = Math.PI * 2;
const MAX_SIDE = 16384;

// ---- canvases ----------------------------------------------------------------

const clampSide = (v) => Math.max(1, Math.min(MAX_SIDE, Math.ceil(v) || 1));

// An offscreen canvas when available (fast, no DOM), else a DOM canvas.
export function createCanvas(w, h) {
  const W = clampSide(w);
  const H = clampSide(h);
  if (typeof OffscreenCanvas === "function") {
    try {
      const c = new OffscreenCanvas(W, H);
      if (c.getContext("2d")) return c;
    } catch {}
  }
  return createDomCanvas(W, H);
}

// An HTMLCanvasElement when there is a document, else an OffscreenCanvas.
export function createDomCanvas(w, h) {
  const W = clampSide(w);
  const H = clampSide(h);
  if (typeof document !== "undefined" && document.createElement) {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    return c;
  }
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(W, H);
  throw Error("Canvas is not available here.");
}

export function context2d(canvas, opts) {
  const ctx = canvas.getContext("2d", opts);
  if (ctx) {
    ctx.imageSmoothingEnabled = true;
    if ("imageSmoothingQuality" in ctx) ctx.imageSmoothingQuality = "high";
  }
  return ctx;
}

export function resetContext(ctx) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  if (typeof ctx.filter === "string") ctx.filter = "none";
  ctx.shadowColor = "rgba(0, 0, 0, 0)";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.imageSmoothingEnabled = true;
  if ("imageSmoothingQuality" in ctx) ctx.imageSmoothingQuality = "high";
}

// Reusable buffers keyed by slot. The returned canvas is cleared and its
// context reset; it stays valid until the next getScratch() for that slot.
const scratch = new Map();
export function getScratch(slot, w, h) {
  const W = clampSide(w);
  const H = clampSide(h);
  let c = scratch.get(slot);
  if (!c) {
    c = createCanvas(W, H);
    scratch.set(slot, c);
  }
  const ctx = c.getContext("2d");
  if (c.width !== W || c.height !== H) {
    c.width = W;
    c.height = H;
  }
  resetContext(ctx);
  ctx.clearRect(0, 0, W, H);
  return c;
}

// The canvas behind a scratch slot, as is (for helpers that size it
// themselves, such as applyMask's `out`).
export function scratchCanvas(slot) {
  let c = scratch.get(slot);
  if (!c) {
    c = createCanvas(1, 1);
    scratch.set(slot, c);
  }
  return c;
}

// Fit a canvas to a size, reusing it when possible. Returns a cleared canvas.
export function sizedCanvas(canvas, w, h) {
  const W = clampSide(w);
  const H = clampSide(h);
  const c = canvas || createCanvas(W, H);
  if (c.width !== W || c.height !== H) {
    c.width = W;
    c.height = H;
  }
  const ctx = c.getContext("2d");
  resetContext(ctx);
  ctx.clearRect(0, 0, W, H);
  return c;
}

export async function canvasToBlob(canvas, type = "image/png", quality) {
  let blob = null;
  if (typeof canvas.convertToBlob === "function") {
    blob = await canvas.convertToBlob(quality === undefined ? { type } : { type, quality });
  } else if (typeof canvas.toBlob === "function") {
    blob = await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  }
  if (!blob) throw Error("Could not encode the image.");
  return blob;
}

let filterSupport;
// Whether 2D canvas filters (blur, brightness, ...) work in this browser.
export function supportsFilter() {
  if (filterSupport !== undefined) return filterSupport;
  filterSupport = false;
  try {
    const c = createCanvas(2, 2);
    const ctx = c.getContext("2d");
    if (ctx && typeof ctx.filter === "string") {
      ctx.filter = "blur(1px)";
      filterSupport = ctx.filter === "blur(1px)";
    }
  } catch {
    filterSupport = false;
  }
  return filterSupport;
}

// ---- colors -----------------------------------------------------------------

export function parseColor(hex) {
  let s = String(hex || "").trim().replace(/^#/, "");
  if (s.length === 3 || s.length === 4) s = [...s].map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(s)) return { r: 0, g: 0, b: 0, a: 1 };
  const n = parseInt(s.slice(0, 6), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: s.length === 8 ? parseInt(s.slice(6), 16) / 255 : 1 };
}

export function rgba(hex, alpha = 1) {
  const c = parseColor(hex);
  const a = Math.max(0, Math.min(1, c.a * alpha));
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${Math.round(a * 1000) / 1000})`;
}

// A linear gradient across a box with CSS angle semantics: 0 points up, 90
// right, 180 down; the end colors land exactly on the box corners.
export function linearGradient(ctx, x, y, w, h, angle, from, to) {
  const r = ((Number(angle) || 0) * Math.PI) / 180;
  const dx = Math.sin(r);
  const dy = -Math.cos(r);
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const g = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half);
  g.addColorStop(0, from);
  g.addColorStop(1, to);
  return g;
}

// ---- seeded randomness (sketch arrows, grain) ------------------------------

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- adjustments -------------------------------------------------------------

export function isNeutralAdjust(a) {
  return !a || (!a.brightness && !a.contrast && !a.saturation && !a.warmth && !a.hue && !a.blur);
}

// The canvas filter string for an image's adjustments (warmth is separate:
// see warmthTint). k converts the blur from doc px to device px.
export function adjustFilter(a, k = 1) {
  if (!a) return "none";
  const parts = [];
  if (a.brightness) parts.push(`brightness(${(1 + (a.brightness / 100) * 0.7).toFixed(3)})`);
  if (a.contrast) parts.push(`contrast(${(1 + (a.contrast / 100) * 0.8).toFixed(3)})`);
  if (a.saturation) parts.push(`saturate(${Math.max(0, 1 + a.saturation / 100).toFixed(3)})`);
  if (a.hue) parts.push(`hue-rotate(${a.hue}deg)`);
  if (a.blur > 0) parts.push(`blur(${(a.blur * 0.2 * k).toFixed(2)}px)`);
  return parts.length ? parts.join(" ") : "none";
}

// Sets ctx.filter for the adjustments. Returns false when the browser has no
// canvas filters (the renderer then uses applyColorMatrix on the pixels).
export function applyAdjust(ctx, adjust, k = 1) {
  if (!supportsFilter() || typeof ctx.filter !== "string") return false;
  ctx.filter = adjustFilter(adjust, k);
  return true;
}

// Warmth as a soft-light color wash: warm orange or cool blue.
export function warmthTint(a) {
  const v = Number(a?.warmth) || 0;
  if (!v) return null;
  return { color: v > 0 ? "#ff9b3d" : "#3d8bff", alpha: Math.min(1, (Math.abs(v) / 100) * 0.55), mode: "soft-light" };
}

// 3x4 color matrices (rows r, g, b; columns r, g, b, offset 0..255).
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

function compose(m2, m1) {
  // m2 after m1
  const out = new Array(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 4 + c] = m2[r * 4] * m1[c] + m2[r * 4 + 1] * m1[4 + c] + m2[r * 4 + 2] * m1[8 + c];
    }
    out[r * 4 + 3] = m2[r * 4] * m1[3] + m2[r * 4 + 1] * m1[7] + m2[r * 4 + 2] * m1[11] + m2[r * 4 + 3];
  }
  return out;
}

// The same adjustments as adjustFilter + warmthTint, as one matrix (without
// blur), for browsers without canvas filters.
export function adjustMatrix(a) {
  let m = IDENTITY;
  if (!a) return m;
  if (a.brightness) {
    const b = 1 + (a.brightness / 100) * 0.7;
    m = compose([b, 0, 0, 0, 0, b, 0, 0, 0, 0, b, 0], m);
  }
  if (a.contrast) {
    const c = 1 + (a.contrast / 100) * 0.8;
    const o = (0.5 - 0.5 * c) * 255;
    m = compose([c, 0, 0, o, 0, c, 0, o, 0, 0, c, o], m);
  }
  if (a.saturation) {
    const s = Math.max(0, 1 + a.saturation / 100);
    m = compose(
      [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0, 0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0, 0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0],
      m,
    );
  }
  if (a.hue) {
    const r = (a.hue * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    m = compose(
      [
        0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928, 0,
        0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283, 0,
        0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072, 0,
      ],
      m,
    );
  }
  if (a.warmth) {
    const w = (a.warmth / 100) * 0.12 * 255;
    m = compose([1, 0, 0, w, 0, 1, 0, w * 0.25, 0, 0, 1, -w], m);
  }
  return m;
}

export function applyColorMatrix(imageData, m) {
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    d[i] = m[0] * r + m[1] * g + m[2] * b + m[3];
    d[i + 1] = m[4] * r + m[5] * g + m[6] * b + m[7];
    d[i + 2] = m[8] * r + m[9] * g + m[10] * b + m[11];
  }
  return imageData;
}

// ---- masks -------------------------------------------------------------------

// The cropped part of src with mask applied as alpha (opaque = keep), scaled
// so its longest side is at most maxSide. crop is normalized to each source.
export function applyMask(src, mask, { crop = { x: 0, y: 0, w: 1, h: 1 }, maxSide = Infinity, out = null } = {}) {
  const sw = Math.max(1, crop.w * src.width);
  const sh = Math.max(1, crop.h * src.height);
  const s = Math.min(1, maxSide / Math.max(sw, sh));
  const c = sizedCanvas(out, Math.round(sw * s), Math.round(sh * s));
  const ctx = c.getContext("2d");
  ctx.drawImage(src, crop.x * src.width, crop.y * src.height, sw, sh, 0, 0, c.width, c.height);
  if (mask) {
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(mask, crop.x * mask.width, crop.y * mask.height, Math.max(1, crop.w * mask.width), Math.max(1, crop.h * mask.height), 0, 0, c.width, c.height);
    ctx.globalCompositeOperation = "source-over";
  }
  return c;
}

// ---- outlines, glow and shadow -------------------------------------------------

// Sticker outline: the alpha silhouette stamped around a circle of offsets
// (16-48 stamps by width), tinted, with the original drawn on top. Width is in
// pixels of `canvas`, which needs a transparent margin of at least `width`.
// Returns `out` (a new canvas when not given).
export function stickerOutline(canvas, width, color, out = null) {
  const w = canvas.width;
  const h = canvas.height;
  const dst = out || createCanvas(w, h);
  if (dst.width !== w || dst.height !== h) {
    dst.width = w;
    dst.height = h;
  }
  const ctx = dst.getContext("2d");
  resetContext(ctx);
  ctx.clearRect(0, 0, w, h);
  const r = Math.max(0, Number(width) || 0);
  if (r >= 0.5) {
    const n = Math.round(Math.max(16, Math.min(48, r * 1.25)));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      ctx.drawImage(canvas, Math.cos(a) * r, Math.sin(a) * r);
    }
    if (r > 6) {
      const n2 = Math.max(12, n >> 1);
      for (let i = 0; i < n2; i++) {
        const a = ((i + 0.5) / n2) * TAU;
        ctx.drawImage(canvas, Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55);
      }
    }
    ctx.drawImage(canvas, 0, 0);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";
  }
  ctx.drawImage(canvas, 0, 0);
  return dst;
}

function tinted(source, color) {
  const t = getScratch("fx-tint", source.width, source.height);
  const ctx = t.getContext("2d");
  ctx.drawImage(source, 0, 0);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, t.width, t.height);
  ctx.globalCompositeOperation = "source-over";
  return t;
}

function drawBlurred(ctx, img, x, y, sigma) {
  ctx.save();
  if (sigma >= 0.3) ctx.filter = `blur(${sigma.toFixed(2)}px)`;
  ctx.drawImage(img, x, y);
  ctx.restore();
}

// Draw the blurred, tinted alpha silhouette of `source` at (x, y). sigma is
// the gaussian deviation in device px. Uses canvas filters when available,
// else a shadow cast from outside the canvas.
export function drawSilhouette(ctx, source, x, y, color, sigma) {
  if (!source.width || !source.height) return;
  if (sigma < 0.3 || supportsFilter()) {
    drawBlurred(ctx, tinted(source, color), x, y, sigma);
    return;
  }
  ctx.save();
  const off = (ctx.canvas?.width || 0) + source.width + 4096;
  ctx.shadowColor = color;
  ctx.shadowBlur = sigma * 2;
  ctx.shadowOffsetX = off;
  ctx.shadowOffsetY = 0;
  ctx.drawImage(source, x - off, y);
  ctx.restore();
}

// Glow: a wide halo plus a tighter core in the glow color.
export function drawGlow(ctx, source, x, y, glow, k = 1) {
  if (!glow?.on || !(glow.opacity > 0) || !source.width || !source.height) return;
  const color = rgba(glow.color, glow.opacity);
  const sigma = Math.max(0.5, ((glow.size || 0) * k) / 2);
  if (supportsFilter()) {
    const t = tinted(source, color);
    drawBlurred(ctx, t, x, y, sigma);
    drawBlurred(ctx, t, x, y, sigma / 2.5);
    return;
  }
  drawSilhouette(ctx, source, x, y, color, sigma);
  drawSilhouette(ctx, source, x, y, color, sigma / 2.5);
}

// Drop shadow of the rendered layer. dx/dy stay in doc space (not rotated).
export function drawShadow(ctx, source, x, y, shadow, k = 1) {
  if (!shadow?.on || !(shadow.opacity > 0)) return;
  const color = rgba(shadow.color, shadow.opacity);
  drawSilhouette(ctx, source, x + (shadow.dx || 0) * k, y + (shadow.dy || 0) * k, color, ((shadow.blur || 0) * k) / 2);
}

// Run draw() with the native canvas shadow set from a layer shadow.
export function withShadow(ctx, shadow, k, draw) {
  ctx.save();
  if (shadow?.on && shadow.opacity > 0) {
    ctx.shadowColor = rgba(shadow.color, shadow.opacity);
    ctx.shadowBlur = (shadow.blur || 0) * k;
    ctx.shadowOffsetX = (shadow.dx || 0) * k;
    ctx.shadowOffsetY = (shadow.dy || 0) * k;
  }
  try {
    draw(ctx);
  } finally {
    ctx.restore();
  }
}
