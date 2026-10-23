// Renderer. Each layer is drawn into a composite (content plus outline, glow
// and shadow) in device pixels with its rotation and flips baked in, then the
// composite is placed with the layer's opacity and blend mode. In the editor
// the composites are cached per layer and keyed by everything that affects
// them except position, opacity and blend, so moving or fading a layer is a
// single drawImage. Without a cache (export) every layer renders exactly.
//
// The caller's transform may be any translate + uniform scale (the usual
// editor pan/zoom/dpr); composites are then pixel-aligned and crisp. Other
// transforms work too, with resampling.

import { arrowGeometry } from "./geometry.js";
import { layoutText, fontString, displayText, textEpoch, letterSpacingSupported, glyphOffsets, getFonts, useFonts, bumpTextEpoch } from "./textlayout.js";
import { shapes, shapeParams } from "./shapes.js";
import { filters, applyFilters, hasActiveFilters } from "./filters.js";
import * as fx from "./effects.js";

const RAD = Math.PI / 180;
const TAU = Math.PI * 2;
const SCREEN_CAP = 2048;
const EXPORT_CAP = 8192;
// Pixel filters run at this many source px per doc px (see imageSource).
const FILTER_DENSITY = 2;
const CLIP_AREA = 8e6;
const CACHE_PIXELS = 96e6;
const STALE_FRAMES = 600;
const DONE = { complete: true, deps: null };

// Bumped when a shape or filter is registered or removed (a mod turned on or
// off), so composites cached with the old definitions are drawn again. The
// editor still has to redraw on the registries' change events.
let regEpoch = 0;
shapes.onChange(() => regEpoch++);
filters.onChange(() => regEpoch++);

// ---- cache ---------------------------------------------------------------------

class RenderCache {
  constructor() {
    this.entries = new Map();
    this.sources = new Map();
    this.frame = 0;
    this.assets = null;
    this._onReady = (e) => this.invalidateAsset(e.detail?.id);
  }

  // Follow an AssetStore so composites drawn before an image decoded are
  // dropped when it is ready (the editor still has to redraw on 'ready').
  attach(assets) {
    if (assets === this.assets) return;
    this.assets?.removeEventListener?.("ready", this._onReady);
    this.assets = assets || null;
    this.assets?.addEventListener?.("ready", this._onReady);
  }

  invalidateAsset(id) {
    if (!id) return;
    for (const [k, e] of this.entries) if (e.deps?.includes(id)) this.entries.delete(k);
    for (const [k, s] of this.sources) if (s.deps?.includes(id)) this.sources.delete(k);
  }

  invalidate(ids) {
    if (ids == null) return this.clear();
    for (const id of Array.isArray(ids) ? ids : [ids]) {
      this.entries.delete(id);
      this.sources.delete(id);
    }
  }

  clear() {
    this.entries.clear();
    this.sources.clear();
  }

  dispose() {
    this.attach(null);
    this.clear();
  }

  // Drop composites for layers that are gone or unused, and keep memory bounded.
  sweep(doc) {
    const live = doc ? new Set(doc.layers.map((l) => l.id)) : null;
    let pixels = 0;
    for (const [id, e] of this.entries) {
      if ((live && !live.has(id)) || this.frame - e.frame > STALE_FRAMES) this.entries.delete(id);
      else pixels += e.canvas.width * e.canvas.height;
    }
    for (const [id, s] of this.sources) {
      if ((live && !live.has(id)) || this.frame - s.frame > STALE_FRAMES) this.sources.delete(id);
    }
    if (pixels <= CACHE_PIXELS) return;
    const byAge = [...this.entries].sort((a, b) => a[1].frame - b[1].frame);
    for (const [id, e] of byAge) {
      if (pixels <= CACHE_PIXELS * 0.75 || e.frame === this.frame) break;
      pixels -= e.canvas.width * e.canvas.height;
      this.entries.delete(id);
    }
  }

  get size() {
    return this.entries.size;
  }
}

export function createRenderCache() {
  return new RenderCache();
}

// ---- keys ------------------------------------------------------------------------

const SKIP_KEYS = new Set(["x", "y", "opacity", "blend", "hidden", "locked", "name", "id"]);
const arrayIds = new WeakMap();
let nextArrayId = 1;

function arrayId(a) {
  let id = arrayIds.get(a);
  if (!id) {
    id = nextArrayId++;
    arrayIds.set(a, id);
  }
  return id;
}

// Everything that changes how a layer looks, except where it is and how it
// is blended. Point lists are keyed by identity (the store replaces them).
function layerKey(layer) {
  return JSON.stringify(layer, function (key, value) {
    if (this === layer) {
      if (SKIP_KEYS.has(key)) return undefined;
      if (key === "points" && Array.isArray(value)) return `#${arrayId(value)}`;
    }
    return value;
  });
}

// ---- transforms --------------------------------------------------------------------

function readOuter(ctx) {
  let m = null;
  try {
    m = ctx.getTransform?.();
  } catch {
    m = null;
  }
  if (!m) return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, k: 1, aligned: true };
  const aligned = Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9 && m.a > 0 && Math.abs(m.a - m.d) < 1e-9 * Math.max(1, m.a);
  const k = aligned ? m.a : Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
  return { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f, k, aligned };
}

// How far (doc px) a layer's pixels can reach outside its box: content
// overflow (glyph overhang, outlines, arrow heads) and effects (glow, shadow).
function margins(layer) {
  let content = 0;
  switch (layer.type) {
    case "text":
      content = layer.size * (layer.italic ? 0.45 : 0.3);
      break;
    case "image":
      content = layer.outline?.on ? layer.outline.width + 1 : 0;
      break;
    case "shape":
      content = layer.stroke?.on ? 1 : 0;
      break;
    case "path":
      content = layer.width;
      break;
    case "arrow":
      content = layer.width * (layer.headSize * 0.6 + 1.5);
      break;
  }
  let effects = 0;
  if (layer.glow?.on && layer.glow.opacity > 0) effects = Math.max(effects, layer.glow.size * 1.6);
  if (layer.shadow?.on && layer.shadow.opacity > 0) effects = Math.max(effects, layer.shadow.blur * 1.6 + Math.max(Math.abs(layer.shadow.dx), Math.abs(layer.shadow.dy)));
  return { content, effects };
}

// ---- public API -----------------------------------------------------------------------

const toSet = (v) => (v == null ? null : v instanceof Set ? v : new Set(Array.isArray(v) ? v : [v]));

export function drawBackground(ctx, doc, scale = 1) {
  const bg = doc?.background;
  if (!bg || bg.kind === "transparent") return;
  const W = doc.width * scale;
  const H = doc.height * scale;
  ctx.save();
  ctx.fillStyle = bg.kind === "gradient" ? fx.linearGradient(ctx, 0, 0, W, H, bg.angle, bg.from, bg.to) : bg.color;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

export function renderDoc(ctx, doc, opts = {}) {
  if (!ctx || !doc) return;
  const { scale = 1, assets = null, background = true, editingTextId = null, cache = null, overrides = null, fonts = null, cap = SCREEN_CAP } = opts;
  if (fonts && fonts !== getFonts()) useFonts(fonts);
  const skip = toSet(opts.skip);
  const only = toSet(opts.only);
  const outer = readOuter(ctx);
  if (cache) {
    cache.attach(assets);
    cache.frame++;
  }
  if (background) drawBackground(ctx, doc, scale);
  const masks = overrides?.masks || null;
  const o = { scale, assets, cache, outer, maskOverride: null, cap, viewW: ctx.canvas?.width || 0, viewH: ctx.canvas?.height || 0 };
  for (const layer of doc.layers) {
    if (layer.hidden) continue;
    if (skip && skip.has(layer.id)) continue;
    if (only && !only.has(layer.id)) continue;
    const mask = masks ? masks.get(layer.id) || null : null;
    o.maskOverride = mask;
    o.cache = mask || layer.id === editingTextId ? null : cache;
    drawLayer(ctx, layer, o);
  }
  if (cache && cache.frame % 120 === 0) cache.sweep(doc);
}

// Draws one layer at (x * scale, y * scale) in the current transform, with
// its rotation, flips, effects, opacity and blend mode.
export function renderLayer(ctx, layer, { scale = 1, assets = null, cache = null, editingText = false, maskOverride = null, cap = SCREEN_CAP } = {}) {
  if (!ctx || !layer || layer.hidden) return;
  if (cache) cache.attach(assets);
  const o = {
    scale,
    assets,
    cache: editingText || maskOverride ? null : cache,
    outer: readOuter(ctx),
    maskOverride,
    cap,
    viewW: ctx.canvas?.width || 0,
    viewH: ctx.canvas?.height || 0,
  };
  drawLayer(ctx, layer, o);
}

// Draws a layer fitted and centered in the rect (x, y, w, h) of the current
// transform, for layer thumbnails. Pass no cache (or a separate one).
export function renderLayerThumb(ctx, layer, { x = 0, y = 0, w, h, assets = null, pad = 0 } = {}) {
  if (!layer || !(w > 0) || !(h > 0)) return;
  const r = Math.abs((layer.rotation || 0) * RAD);
  const bw = layer.w * Math.abs(Math.cos(r)) + layer.h * Math.abs(Math.sin(r));
  const bh = layer.w * Math.abs(Math.sin(r)) + layer.h * Math.abs(Math.cos(r));
  const s = Math.min((w - pad * 2) / bw, (h - pad * 2) / bh);
  if (!(s > 0)) return;
  ctx.save();
  ctx.translate(x + w / 2 - layer.x * s, y + h / 2 - layer.y * s);
  renderLayer(ctx, { ...layer, hidden: false }, { scale: s, assets, cap: 512 });
  ctx.restore();
}

// Load every image and font a doc uses. Resolves when they are ready (missing
// images resolve too, and render as a faint placeholder).
export async function prepareDoc(doc, { assets = null, fonts = null } = {}) {
  const ids = new Set();
  for (const l of doc?.layers || []) {
    if (l.type !== "image") continue;
    if (l.asset) ids.add(l.asset);
    if (l.mask) ids.add(l.mask);
  }
  await Promise.all([...ids].map((id) => Promise.resolve(assets?.loadImage?.(id)).catch(() => null)));
  const texts = (doc?.layers || []).filter((l) => l.type === "text" && !l.hidden);
  if (!texts.length) return;
  const reg = fonts || getFonts();
  const style = (l) => (l.italic ? "italic" : "normal");
  if (reg?.ensureDoc) {
    const isLoaded = (l) => {
      try {
        return !!reg.loaded?.(l.font, l.weight, style(l));
      } catch {
        return false;
      }
    };
    const before = texts.map(isLoaded);
    try {
      await reg.ensureDoc(doc);
    } catch (err) {
      console.warn(err);
    }
    if (texts.some((l, i) => !before[i] && isLoaded(l))) bumpTextEpoch();
  } else if (globalThis.document?.fonts?.load) {
    const faces = globalThis.document.fonts;
    const missing = texts.filter((l) => !faces.check(fontString(l), displayText(l) || "A"));
    if (!missing.length) return;
    await Promise.all(missing.map((l) => faces.load(fontString(l), displayText(l) || "A").catch(() => [])));
    bumpTextEpoch();
  }
}

// A canvas with the whole doc rendered at `scale` (or fitted to width and/or
// height). Waits for images and fonts. Returns an HTMLCanvasElement in pages.
export async function renderToCanvas(doc, { scale = 1, width, height, assets = null, background = true, fonts = null, cap = EXPORT_CAP } = {}) {
  if (fonts && fonts !== getFonts()) useFonts(fonts);
  await prepareDoc(doc, { assets, fonts });
  let sx = Number(scale) > 0 ? Number(scale) : 1;
  let sy = sx;
  if (width > 0 && height > 0) {
    sx = width / doc.width;
    sy = height / doc.height;
  } else if (width > 0) {
    sx = sy = width / doc.width;
  } else if (height > 0) {
    sx = sy = height / doc.height;
  }
  let W = Math.max(1, Math.round(doc.width * sx));
  let H = Math.max(1, Math.round(doc.height * sy));
  const limit = Math.min(1, 16384 / Math.max(W, H), Math.sqrt(268e6 / (W * H)));
  if (limit < 1) {
    sx *= limit;
    sy *= limit;
    W = Math.max(1, Math.floor(doc.width * sx));
    H = Math.max(1, Math.floor(doc.height * sy));
  }
  const canvas = fx.createDomCanvas(W, H);
  const ctx = fx.context2d(canvas);
  if (Math.abs(sy - sx) > 1e-9) ctx.setTransform(1, 0, 0, sy / sx, 0, 0);
  renderDoc(ctx, doc, { scale: sx, assets, background, cap });
  return canvas;
}

// Project thumbnail: image/webp (png where webp encoding is missing).
export async function renderThumb(doc, { maxSide = 320, assets = null, fonts = null } = {}) {
  const s = Math.min(1, maxSide / Math.max(doc.width, doc.height));
  const canvas = await renderToCanvas(doc, { scale: s, assets, fonts, cap: Math.max(512, maxSide * 2) });
  try {
    const blob = await fx.canvasToBlob(canvas, "image/webp", 0.85);
    if (blob.type === "image/webp") return blob;
  } catch {}
  return fx.canvasToBlob(canvas, "image/png");
}

// ---- layers ---------------------------------------------------------------------------

function drawLayer(ctx, layer, o) {
  if (!(layer.opacity > 0) || !(layer.w > 0) || !(layer.h > 0)) return;
  const outer = o.outer;
  const k = o.scale * outer.k;
  if (!(k > 0) || !Number.isFinite(k)) return;
  const cx = layer.x * o.scale;
  const cy = layer.y * o.scale;

  const m = margins(layer);
  const r = (layer.rotation || 0) * RAD;
  const ac = Math.abs(Math.cos(r));
  const as = Math.abs(Math.sin(r));
  const bw = layer.w + m.content * 2;
  const bh = layer.h + m.content * 2;
  const hw = ((bw * ac + bh * as) / 2 + m.effects) * k;
  const hh = ((bw * as + bh * ac) / 2 + m.effects) * k;
  let x0 = -Math.ceil(hw) - 1;
  let y0 = -Math.ceil(hh) - 1;
  let x1 = Math.ceil(hw) + 2;
  let y1 = Math.ceil(hh) + 2;

  let ax = 0;
  let ay = 0;
  let fx0 = 0;
  let fy0 = 0;
  if (outer.aligned) {
    const dx = outer.a * cx + outer.e;
    const dy = outer.d * cy + outer.f;
    if (o.cache) {
      ax = Math.round(dx);
      ay = Math.round(dy);
    } else {
      ax = Math.floor(dx);
      ay = Math.floor(dy);
      fx0 = dx - ax;
      fy0 = dy - ay;
    }
    // Keep huge composites (zoomed in, oversized layers) to the visible area.
    const big = (x1 - x0) * (y1 - y0) > CLIP_AREA || x1 - x0 > 8192 || y1 - y0 > 8192;
    if (o.viewW && o.viewH && (big || !o.cache)) {
      // The sticker outline is dilated from the drawn silhouette, so the part
      // just outside the view has to be drawn too, like glow and shadow.
      const ol = layer.type === "image" && layer.outline?.on ? layer.outline.width : 0;
      const em = Math.ceil((m.effects + ol) * k) + 2;
      x0 = Math.max(x0, -ax - em);
      y0 = Math.max(y0, -ay - em);
      x1 = Math.min(x1, o.viewW - ax + em);
      y1 = Math.min(y1, o.viewH - ay + em);
      if (x1 <= x0 || y1 <= y0) return;
    }
  }

  const comp = composite(layer, k, o, x0, y0, x1, y1, fx0, fy0);
  if (!comp) return;
  ctx.save();
  ctx.globalAlpha *= layer.opacity;
  ctx.globalCompositeOperation = layer.blend && layer.blend !== "normal" ? layer.blend : "source-over";
  if (outer.aligned) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(comp.canvas, ax + x0, ay + y0);
  } else {
    ctx.translate(cx, cy);
    ctx.scale(1 / outer.k, 1 / outer.k);
    ctx.drawImage(comp.canvas, x0, y0);
  }
  ctx.restore();
}

function depsReady(deps, assets) {
  if (!deps?.length || !assets?.getImage) return false;
  return deps.every((id) => !!assets.getImage(id));
}

function composite(layer, k, o, x0, y0, x1, y1, fx0, fy0) {
  const cache = o.cache;
  const epoch = `${layer.type === "text" ? textEpoch() : 0}:${regEpoch}`;
  if (!cache) {
    const out = fx.getScratch("r-out", x1 - x0, y1 - y0);
    paint(out, layer, k, o, x0, y0, fx0, fy0);
    return { canvas: out };
  }
  let e = cache.entries.get(layer.id);
  if (e && e.layer === layer && e.k === k && e.epoch === epoch && e.x0 === x0 && e.y0 === y0 && e.x1 === x1 && e.y1 === y1) {
    if (e.complete || !depsReady(e.deps, o.assets)) {
      e.frame = cache.frame;
      return e;
    }
  }
  const key = `${k.toFixed(5)}|${epoch}|${x0},${y0},${x1},${y1}|${layerKey(layer)}`;
  if (e && e.key === key && (e.complete || !depsReady(e.deps, o.assets))) {
    e.layer = layer;
    e.k = k;
    e.frame = cache.frame;
    return e;
  }
  const canvas = fx.sizedCanvas(e?.canvas || null, x1 - x0, y1 - y0);
  const res = paint(canvas, layer, k, o, x0, y0, 0, 0);
  e = { key, layer, k, epoch, x0, y0, x1, y1, canvas, complete: res.complete, deps: res.deps, frame: cache.frame };
  cache.entries.set(layer.id, e);
  return e;
}

// Render a layer's composite into `out` (already sized and cleared). The
// layer center lands at (-x0 + fx0, -y0 + fy0).
function paint(out, layer, k, o, x0, y0, fx0, fy0) {
  const W = out.width;
  const H = out.height;
  const glow = layer.glow?.on && layer.glow.opacity > 0;
  const shadow = layer.shadow?.on && layer.shadow.opacity > 0;
  const outline = layer.type === "image" && layer.outline?.on && layer.outline.width > 0;
  const needFx = glow || shadow;
  let content = needFx || outline ? fx.getScratch("r-content", W, H) : out;
  const cctx = content.getContext("2d");
  const r = (layer.rotation || 0) * RAD;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const sx = layer.flipX ? -1 : 1;
  const sy = layer.flipY ? -1 : 1;
  cctx.save();
  cctx.setTransform(k * c * sx, k * s * sx, -k * s * sy, k * c * sy, -x0 + fx0, -y0 + fy0);
  let res = DONE;
  try {
    res = drawContent(cctx, layer, k, o) || DONE;
  } catch (err) {
    console.error(err);
  }
  cctx.restore();
  if (outline) {
    const dst = needFx ? fx.getScratch("r-outline", W, H) : out;
    fx.stickerOutline(content, layer.outline.width * k, layer.outline.color, dst);
    content = dst;
  }
  if (needFx) {
    const octx = out.getContext("2d");
    if (glow) fx.drawGlow(octx, content, 0, 0, layer.glow, k);
    if (shadow) fx.drawShadow(octx, content, 0, 0, layer.shadow, k);
    octx.drawImage(content, 0, 0);
  }
  return res;
}

function drawContent(ctx, layer, k, o) {
  switch (layer.type) {
    case "image":
      return drawImageLayer(ctx, layer, k, o);
    case "text":
      return drawTextLayer(ctx, layer);
    case "shape":
      drawShapeLayer(ctx, layer);
      return DONE;
    case "path":
      drawPathLayer(ctx, layer);
      return DONE;
    case "arrow":
      drawArrowLayer(ctx, layer);
      return DONE;
    default:
      return DONE;
  }
}

// ---- images ------------------------------------------------------------------------------

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (!r) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function frameClip(ctx, layer) {
  const w = layer.w;
  const h = layer.h;
  if (layer.frame === "ellipse") {
    ctx.beginPath();
    ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, TAU);
  } else if (layer.radius > 0) {
    roundRectPath(ctx, -w / 2, -h / 2, w, h, layer.radius);
  } else {
    return;
  }
  ctx.clip();
}

// Longest side of the processed copy. Filter parameters are in processed
// pixels (grain cells, a 3x3 sharpen), so with filters the copy's size comes
// from the layer's size in the design (FILTER_DENSITY px per doc px, never
// more than the source has), not from the view: the editor, export and feed
// preview then filter the same pixels and look the same. The size goes up in
// quarter-octave steps so resizing a layer re-runs the filters a few times,
// not on every frame. Small previews (project and layer thumbnails, cap under
// SCREEN_CAP) keep their cap: the difference cannot be seen at that size and
// they render often.
function sourceSide(layer, filtered, cap) {
  if (!filtered || cap < SCREEN_CAP) return cap;
  const side = Math.max(16, Math.max(layer.w, layer.h) * FILTER_DENSITY);
  return Math.min(EXPORT_CAP, Math.ceil(2 ** (Math.ceil(Math.log2(side) * 4) / 4)));
}

// The pixels to draw for an image layer: the bitmap itself (with the crop as
// a source rect) or, when it has a mask, filters or needs CPU adjustments, a
// processed copy of the cropped region, cached per layer.
function imageSource(layer, bmp, maskSrc, o) {
  const crop = layer.crop;
  const cpuAdjust = !fx.supportsFilter() && !fx.isNeutralAdjust(layer.adjust);
  const filtered = hasActiveFilters(layer.filters);
  if (!maskSrc && !filtered && !cpuAdjust) {
    return {
      image: bmp,
      sx: crop.x * bmp.width,
      sy: crop.y * bmp.height,
      sw: Math.max(1e-3, crop.w * bmp.width),
      sh: Math.max(1e-3, crop.h * bmp.height),
      adjusted: false,
    };
  }
  const live = !!o.maskOverride;
  const cache = live ? null : o.cache;
  const maxSide = sourceSide(layer, filtered, o.cap);
  const key = `${layer.asset}|${layer.mask}|${crop.x},${crop.y},${crop.w},${crop.h}|${filtered ? JSON.stringify(layer.filters) + regEpoch : ""}|${cpuAdjust ? JSON.stringify(layer.adjust) : ""}|${maxSide}`;
  const hit = cache?.sources.get(layer.id);
  if (hit && hit.key === key) {
    hit.frame = cache.frame;
    return hit.src;
  }
  const target = cache ? hit?.canvas || null : fx.scratchCanvas("r-source");
  const canvas = fx.applyMask(bmp, maskSrc, { crop, maxSide, out: target });
  if (filtered || cpuAdjust) {
    try {
      const cctx = canvas.getContext("2d");
      let img = cctx.getImageData(0, 0, canvas.width, canvas.height);
      if (filtered) img = applyFilters(img, layer.filters);
      if (cpuAdjust) fx.applyColorMatrix(img, fx.adjustMatrix(layer.adjust));
      cctx.putImageData(img, 0, 0);
    } catch (err) {
      console.error(err);
    }
  }
  const src = { image: canvas, sx: 0, sy: 0, sw: canvas.width, sh: canvas.height, adjusted: cpuAdjust };
  if (cache) cache.sources.set(layer.id, { key, canvas, src, frame: cache.frame, deps: [layer.asset, layer.mask].filter(Boolean) });
  return src;
}

function drawImageLayer(ctx, layer, k, o) {
  const assets = o.assets;
  const deps = [layer.asset, layer.mask].filter(Boolean);
  const bmp = layer.asset ? assets?.getImage?.(layer.asset) || null : null;
  const maskSrc = o.maskOverride || (layer.mask ? assets?.getImage?.(layer.mask) || null : null);
  const w = layer.w;
  const h = layer.h;
  ctx.save();
  frameClip(ctx, layer);
  if (!bmp || (layer.mask && !maskSrc)) {
    ctx.fillStyle = "rgba(128, 128, 128, 0.16)";
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.restore();
    return { complete: false, deps };
  }
  const src = imageSource(layer, bmp, maskSrc, o);
  const filtered = !src.adjusted && !fx.isNeutralAdjust(layer.adjust) && fx.applyAdjust(ctx, layer.adjust, k);
  ctx.drawImage(src.image, src.sx, src.sy, src.sw, src.sh, -w / 2, -h / 2, w, h);
  const tint = src.adjusted ? null : fx.warmthTint(layer.adjust);
  if (tint) {
    if (filtered) ctx.filter = "none";
    ctx.globalCompositeOperation = tint.mode;
    ctx.globalAlpha = tint.alpha;
    ctx.fillStyle = tint.color;
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "destination-in";
    if (filtered) fx.applyAdjust(ctx, layer.adjust, k);
    ctx.drawImage(src.image, src.sx, src.sy, src.sw, src.sh, -w / 2, -h / 2, w, h);
  }
  ctx.restore();
  return { complete: true, deps };
}

// ---- text ------------------------------------------------------------------------------------

function requestFont(layer) {
  const reg = getFonts();
  if (!reg?.load || !reg.loaded) return;
  const style = layer.italic ? "italic" : "normal";
  try {
    if (!reg.loaded(layer.font, layer.weight, style)) Promise.resolve(reg.load(layer.font, layer.weight, style)).catch(() => {});
  } catch {}
}

function eachLine(ctx, L, perGlyph, draw) {
  for (const line of L.lines) {
    if (!line.text) continue;
    if (!perGlyph) {
      draw(line.text, line.x, line.y);
      continue;
    }
    for (const g of glyphOffsets(line, L)) draw(g.ch, line.x + g.x, line.y);
  }
}

function drawTextLayer(ctx, layer) {
  requestFont(layer);
  const L = layoutText(layer);
  ctx.font = L.font;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  if ("textRendering" in ctx) ctx.textRendering = "geometricPrecision";
  const native = letterSpacingSupported() && "letterSpacing" in ctx;
  if (native) ctx.letterSpacing = `${L.spacing}px`;
  const perGlyph = !native && Math.abs(L.spacing) > 0.001;

  if (layer.bg?.on) {
    const b = L.block;
    const bg = layer.bg;
    const w = b.r - b.l + bg.padX * 2;
    const h = b.b - b.t + bg.padY * 2;
    ctx.fillStyle = fx.rgba(bg.color, bg.opacity);
    roundRectPath(ctx, b.l - bg.padX, b.t - bg.padY, w, h, bg.radius);
    ctx.fill();
  }
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.miterLimit = 2;
  const sw = layer.stroke?.on ? Math.max(0, layer.stroke.width) : 0;
  if (layer.stroke2?.on && layer.stroke2.width > 0) {
    ctx.lineWidth = 2 * (sw + layer.stroke2.width);
    ctx.strokeStyle = layer.stroke2.color;
    eachLine(ctx, L, perGlyph, (t, x, y) => ctx.strokeText(t, x, y));
  }
  if (sw > 0) {
    ctx.lineWidth = 2 * sw;
    ctx.strokeStyle = layer.stroke.color;
    eachLine(ctx, L, perGlyph, (t, x, y) => ctx.strokeText(t, x, y));
  }
  const g = layer.gradient;
  ctx.fillStyle = g?.on ? fx.linearGradient(ctx, L.ink.l, L.ink.t, Math.max(1, L.ink.r - L.ink.l), Math.max(1, L.ink.b - L.ink.t), g.angle, g.from, g.to) : layer.color;
  eachLine(ctx, L, perGlyph, (t, x, y) => ctx.fillText(t, x, y));
  return DONE;
}

// ---- shapes ---------------------------------------------------------------------------------

function drawShapeLayer(ctx, layer) {
  const def = shapes.get(layer.shape) || shapes.get("rect");
  const sw = layer.stroke?.on ? Math.max(0, layer.stroke.width) : 0;
  // The path is inset by half the stroke so the stroke stays inside the box.
  const w = Math.max(1, layer.w - sw);
  const h = Math.max(1, layer.h - sw);
  const ref = sw ? { ...layer, radius: Math.max(0, (layer.radius || 0) - sw / 2) } : layer;
  let path = null;
  try {
    path = def.path(w, h, shapeParams(layer, def), ref);
  } catch (err) {
    console.error(err);
  }
  if (!path) return;
  if (layer.fill?.on) {
    ctx.fillStyle = layer.fill.color;
    ctx.fill(path);
  }
  if (sw > 0) {
    ctx.lineWidth = sw;
    ctx.strokeStyle = layer.stroke.color;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    if (layer.stroke.dash) ctx.setLineDash([sw * 2, sw * 2.2]);
    ctx.stroke(path);
    ctx.setLineDash([]);
  }
}

// ---- freehand paths ----------------------------------------------------------------------------

const freehandCache = new WeakMap();

const pressure = (p) => (Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0.5);

// Smoothed, resampled center line with a radius per sample: streamlined
// input, quadratic curves through midpoints, pressure-scaled width and
// tapered ends.
export function freehandSpine(layer) {
  const pts = layer.points || [];
  const n = pts.length;
  if (!n) return [];
  const w = layer.w;
  const h = layer.h;
  const width = Math.max(0.5, layer.width);
  const t = 1 - Math.min(0.95, Math.max(0, layer.smoothing ?? 0.5)) * 0.75;
  const raw = [];
  let x = (pts[0][0] - 0.5) * w;
  let y = (pts[0][1] - 0.5) * h;
  raw.push({ x, y, p: pressure(pts[0][2]) });
  const minGap = Math.max(0.25, width * 0.05);
  for (let i = 1; i < n; i++) {
    x += ((pts[i][0] - 0.5) * w - x) * t;
    y += ((pts[i][1] - 0.5) * h - y) * t;
    const last = raw[raw.length - 1];
    if (Math.hypot(x - last.x, y - last.y) < minGap) {
      last.p = Math.max(last.p, pressure(pts[i][2]));
      continue;
    }
    raw.push({ x, y, p: pressure(pts[i][2]) });
  }
  if (n > 1) {
    const end = { x: (pts[n - 1][0] - 0.5) * w, y: (pts[n - 1][1] - 0.5) * h, p: pressure(pts[n - 1][2]) };
    const last = raw[raw.length - 1];
    if (Math.hypot(end.x - last.x, end.y - last.y) >= minGap) raw.push(end);
    else Object.assign(last, end);
  }

  const step = Math.max(0.75, width * 0.2);
  const out = [];
  const emit = (px, py, pp) => {
    const last = out[out.length - 1];
    if (last && Math.hypot(px - last.x, py - last.y) < step * 0.5) return;
    out.push({ x: px, y: py, p: pp, r: 0 });
  };
  const quad = (a, c, b, pa, pb) => {
    const len = Math.hypot(c.x - a.x, c.y - a.y) + Math.hypot(b.x - c.x, b.y - c.y);
    const steps = Math.max(1, Math.ceil(len / step));
    for (let i = 1; i <= steps; i++) {
      const s = i / steps;
      const u = 1 - s;
      emit(u * u * a.x + 2 * u * s * c.x + s * s * b.x, u * u * a.y + 2 * u * s * c.y + s * s * b.y, pa + (pb - pa) * s);
    }
  };
  out.push({ x: raw[0].x, y: raw[0].y, p: raw[0].p, r: 0 });
  if (raw.length === 2) {
    quad(raw[0], { x: (raw[0].x + raw[1].x) / 2, y: (raw[0].y + raw[1].y) / 2 }, raw[1], raw[0].p, raw[1].p);
  } else if (raw.length > 2) {
    let start = raw[0];
    for (let i = 1; i < raw.length - 1; i++) {
      const mid = { x: (raw[i].x + raw[i + 1].x) / 2, y: (raw[i].y + raw[i + 1].y) / 2, p: (raw[i].p + raw[i + 1].p) / 2 };
      quad(start, raw[i], mid, start.p, mid.p);
      start = mid;
    }
    const lastRaw = raw[raw.length - 1];
    quad(start, { x: (start.x + lastRaw.x) / 2, y: (start.y + lastRaw.y) / 2 }, lastRaw, start.p, lastRaw.p);
  }

  let total = 0;
  const along = [0];
  for (let i = 1; i < out.length; i++) {
    total += Math.hypot(out[i].x - out[i - 1].x, out[i].y - out[i - 1].y);
    along.push(total);
  }
  const taperIn = total > width * 2 ? Math.min(width * 2.2, total * 0.18) : 0;
  const taperOut = total > width * 2 ? Math.min(width * 3, total * 0.25) : 0;
  const ease = (v) => Math.sin((Math.min(1, Math.max(0, v)) * Math.PI) / 2);
  for (let i = 0; i < out.length; i++) {
    const base = (width / 2) * Math.min(1.3, Math.max(0.35, 0.35 + 1.3 * out[i].p));
    const a = taperIn ? ease(along[i] / taperIn) : 1;
    const b = taperOut ? ease((total - along[i]) / taperOut) : 1;
    out[i].r = base * (0.42 + 0.58 * Math.min(a, b));
  }
  return out;
}

// The stroke as one filled shape: discs at every sample joined by quads, all
// wound the same way so the non-zero fill is their union.
function freehandPath(layer) {
  const pts = layer.points;
  const key = `${layer.w}|${layer.h}|${layer.width}|${layer.smoothing}`;
  const hit = pts ? freehandCache.get(pts) : null;
  if (hit && hit.key === key) return hit.path;
  const spine = freehandSpine(layer);
  const path = new Path2D();
  for (const s of spine) {
    path.moveTo(s.x + s.r, s.y);
    path.arc(s.x, s.y, s.r, 0, TAU);
    path.closePath();
  }
  for (let i = 0; i < spine.length - 1; i++) {
    const a = spine[i];
    const b = spine[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const nx = -dy / len;
    const ny = dx / len;
    const q = [
      [a.x + nx * a.r, a.y + ny * a.r],
      [b.x + nx * b.r, b.y + ny * b.r],
      [b.x - nx * b.r, b.y - ny * b.r],
      [a.x - nx * a.r, a.y - ny * a.r],
    ];
    let area = 0;
    for (let j = 0; j < 4; j++) {
      const p = q[j];
      const r = q[(j + 1) % 4];
      area += p[0] * r[1] - r[0] * p[1];
    }
    if (area < 0) q.reverse();
    path.moveTo(q[0][0], q[0][1]);
    for (let j = 1; j < 4; j++) path.lineTo(q[j][0], q[j][1]);
    path.closePath();
  }
  if (pts) freehandCache.set(pts, { key, path });
  return path;
}

function drawPathLayer(ctx, layer) {
  if (!layer.points?.length) return;
  ctx.fillStyle = layer.color;
  ctx.fill(freehandPath(layer), "nonzero");
}

// ---- arrows -----------------------------------------------------------------------------------

function capPath(ctx, cap) {
  ctx.beginPath();
  ctx.moveTo(cap.poly[0].x, cap.poly[0].y);
  ctx.lineTo(cap.poly[1].x, cap.poly[1].y);
  ctx.lineTo(cap.poly[2].x, cap.poly[2].y);
  ctx.closePath();
}

function drawCap(ctx, cap, width) {
  if (!cap || cap.kind === "none") return;
  if (cap.kind === "triangle") {
    capPath(ctx, cap);
    ctx.fill();
    ctx.lineWidth = cap.round;
    ctx.stroke();
  } else if (cap.kind === "line") {
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(cap.lines[0][0].x, cap.lines[0][0].y);
    ctx.lineTo(cap.tip.x, cap.tip.y);
    ctx.lineTo(cap.lines[1][0].x, cap.lines[1][0].y);
    ctx.stroke();
  } else if (cap.kind === "dot") {
    ctx.beginPath();
    ctx.arc(cap.center.x, cap.center.y, cap.r, 0, TAU);
    ctx.fill();
  }
}

function drawArrowLayer(ctx, layer) {
  const g = arrowGeometry(layer);
  ctx.strokeStyle = layer.color;
  ctx.fillStyle = layer.color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (layer.sketch) {
    drawSketchArrow(ctx, layer, g);
    return;
  }
  if (g.shaft) {
    ctx.lineWidth = layer.width;
    ctx.beginPath();
    ctx.moveTo(g.shaft.a.x, g.shaft.a.y);
    ctx.quadraticCurveTo(g.shaft.c.x, g.shaft.c.y, g.shaft.b.x, g.shaft.b.y);
    ctx.stroke();
  }
  drawCap(ctx, g.head, layer.width);
  drawCap(ctx, g.tail, layer.width);
}

// Hand-drawn look: two slightly different strokes per part. The jitter comes
// from a generator seeded by the layer id, so it never changes between frames.
function drawSketchArrow(ctx, layer, g) {
  const rand = fx.mulberry32(fx.hashString(layer.id || "arrow"));
  const width = layer.width;
  const j = Math.min(width * 0.7, g.len * 0.025) + 0.6;
  const jit = (p, s = 1) => ({ x: p.x + (rand() - 0.5) * 2 * j * s, y: p.y + (rand() - 0.5) * 2 * j * s });
  const widths = [width * 0.62, width * 0.46];
  const shaft = g.shaft || { a: g.A, c: g.C, b: g.B };
  for (let pass = 0; pass < 2; pass++) {
    const a = jit(shaft.a);
    const c = jit(shaft.c, 1.8);
    const b = jit(shaft.b, 0.5);
    ctx.lineWidth = widths[pass];
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(c.x, c.y, b.x, b.y);
    ctx.stroke();
  }
  for (const cap of [g.head, g.tail]) {
    if (!cap || cap.kind === "none") continue;
    if (cap.kind === "triangle") {
      const pts = cap.poly.map((p) => jit(p, 0.4));
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.lineTo(pts[2].x, pts[2].y);
      ctx.closePath();
      ctx.fill();
      for (let pass = 0; pass < 2; pass++) {
        const q = cap.poly.map((p) => jit(p, 0.6));
        ctx.lineWidth = widths[pass];
        ctx.beginPath();
        ctx.moveTo(q[0].x, q[0].y);
        ctx.lineTo(q[1].x, q[1].y);
        ctx.lineTo(q[2].x, q[2].y);
        ctx.closePath();
        ctx.stroke();
      }
    } else if (cap.kind === "line") {
      for (let pass = 0; pass < 2; pass++) {
        const l1 = jit(cap.lines[0][0]);
        const tip = jit(cap.tip, 0.5);
        const l2 = jit(cap.lines[1][0]);
        ctx.lineWidth = widths[pass];
        ctx.beginPath();
        ctx.moveTo(l1.x, l1.y);
        ctx.lineTo(tip.x, tip.y);
        ctx.lineTo(l2.x, l2.y);
        ctx.stroke();
      }
    } else if (cap.kind === "dot") {
      const c = jit(cap.center, 0.3);
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, cap.r * (0.95 + rand() * 0.1), cap.r * (0.95 + rand() * 0.1), rand() * Math.PI, 0, TAU);
      ctx.fill();
    }
  }
}
