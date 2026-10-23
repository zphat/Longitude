// Text layout: font strings, measuring, wrapping and the store normalizer
// that keeps text layer boxes hugging their text. Layouts are cached by the
// props that affect them; the cache is dropped whenever fonts change (a font
// face loads, or store.remeasure() runs).
//
// Box model, in content space (box centered on 0,0):
//   content block = the lines (first line ascent to last line descent)
//   pad = room for stroke, second outline and the background pill
//   box (w, h) = content + 2 * pad   (wrap "fixed": w is the layer's own w)

let registry = null;
let unsubscribe = null;
let epoch = 0;
let measureCtx;
let lsSupported = false;
const cache = new Map();
const metricsCache = new Map();
const CACHE_LIMIT = 400;

const FALLBACKS = {
  anton: '"Anton", Impact, "Arial Narrow Bold", sans-serif',
  impact: 'Impact, "Anton", "Arial Narrow Bold", sans-serif',
  "bebas neue": '"Bebas Neue", Impact, sans-serif',
  "arial black": '"Arial Black", "Arial Bold", Arial, sans-serif',
};

// Tell layout and rendering which FontRegistry to use (optional). Also
// subscribes to its 'load' event so cached layouts refresh.
export function useFonts(fonts) {
  if (fonts === registry) return;
  unsubscribe?.();
  unsubscribe = null;
  registry = fonts || null;
  if (registry?.addEventListener) {
    const onLoad = () => bumpTextEpoch();
    registry.addEventListener("load", onLoad);
    registry.addEventListener("change", onLoad);
    unsubscribe = () => {
      registry.removeEventListener("load", onLoad);
      registry.removeEventListener("change", onLoad);
    };
  }
  bumpTextEpoch();
}

export function getFonts() {
  return registry;
}

// Changes whenever fonts change; render caches compare against it.
export function textEpoch() {
  return epoch;
}

export function bumpTextEpoch() {
  epoch++;
  cache.clear();
  metricsCache.clear();
}

let docFontsHooked = false;
function hookDocumentFonts() {
  if (docFontsHooked) return;
  docFontsHooked = true;
  try {
    globalThis.document?.fonts?.addEventListener?.("loadingdone", () => bumpTextEpoch());
  } catch {}
}

function getCtx() {
  if (measureCtx !== undefined) return measureCtx;
  measureCtx = null;
  try {
    if (typeof OffscreenCanvas === "function") measureCtx = new OffscreenCanvas(8, 8).getContext("2d");
    if (!measureCtx && typeof document !== "undefined") measureCtx = document.createElement("canvas").getContext("2d");
  } catch {
    measureCtx = null;
  }
  if (measureCtx) {
    lsSupported = "letterSpacing" in measureCtx;
    if ("textRendering" in measureCtx) measureCtx.textRendering = "geometricPrecision";
    hookDocumentFonts();
  }
  return measureCtx;
}

// Whether canvas letterSpacing is used (else glyphs are placed one by one).
export function letterSpacingSupported() {
  getCtx();
  return lsSupported;
}

const quote = (family) => `"${String(family || "").replace(/["\\]/g, "")}"`;

export function fontStack(family) {
  try {
    const s = registry?.stack?.(family);
    if (typeof s === "string" && s.trim()) return s;
  } catch {}
  return FALLBACKS[String(family || "").toLowerCase()] || `${quote(family)}, sans-serif`;
}

// CSS font shorthand for a text layer, for example 'italic 700 140px "Anton", Impact, sans-serif'.
export function fontString(layer, size = layer.size) {
  const s = Math.max(0.5, Math.round(Number(size) * 100) / 100 || 0);
  const w = Math.max(1, Math.min(1000, Math.round(Number(layer.weight) || 400)));
  return `${layer.italic ? "italic " : ""}${w} ${s}px ${fontStack(layer.font)}`;
}

export function displayText(layer) {
  let t = String(layer.text ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
  if (layer.uppercase) t = t.toUpperCase();
  return t;
}

export function spacingPx(layer) {
  return ((Number(layer.letterSpacing) || 0) / 1000) * layer.size;
}

function charCount(s) {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

// Rough widths for environments without a canvas (tests, workers without
// OffscreenCanvas). Good enough to keep boxes sensible.
function approxWidth(s, size) {
  let w = 0;
  for (const ch of s) {
    if (ch === " ") w += 0.28;
    else if (/[A-Z]/.test(ch)) w += 0.62;
    else if (/[0-9]/.test(ch)) w += 0.56;
    else if (/[a-z]/.test(ch)) w += 0.52;
    else if (/[.,:;'!|il]/.test(ch)) w += 0.26;
    else w += 0.6;
  }
  return w * size;
}

let lastFont = "";
let lastSpacing = "";
function prep(ctx, font, spacing) {
  if (font !== lastFont) {
    ctx.font = font;
    lastFont = font;
  }
  if (lsSupported) {
    const ls = `${spacing}px`;
    if (ls !== lastSpacing) {
      ctx.letterSpacing = ls;
      lastSpacing = ls;
    }
  }
}

function makeMeasurer(font, size, spacing) {
  const ctx = getCtx();
  if (!ctx) {
    return {
      width: (s) => {
        const n = charCount(s);
        return approxWidth(s, size) + (n > 1 ? spacing * (n - 1) : 0);
      },
      raw: (s) => approxWidth(s, size),
      ink: () => ({ ascent: size * 0.72, descent: size * 0.02 }),
    };
  }
  return {
    width(s) {
      if (!s) return 0;
      prep(ctx, font, lsSupported ? spacing : 0);
      const w = ctx.measureText(s).width;
      const n = charCount(s);
      if (lsSupported) return w - (n > 0 ? spacing : 0);
      return w + (n > 1 ? spacing * (n - 1) : 0);
    },
    raw(s) {
      if (!s) return 0;
      prep(ctx, font, 0);
      return ctx.measureText(s).width;
    },
    ink(s) {
      if (!s || !s.trim()) return null;
      prep(ctx, font, lsSupported ? spacing : 0);
      const m = ctx.measureText(s);
      const a = m.actualBoundingBoxAscent;
      const d = m.actualBoundingBoxDescent;
      return Number.isFinite(a) && Number.isFinite(d) ? { ascent: a, descent: d } : null;
    },
  };
}

function fontMetrics(font, size) {
  const hit = metricsCache.get(font);
  if (hit) return hit;
  const ctx = getCtx();
  let ascent = size * 0.92;
  let descent = size * 0.24;
  if (ctx) {
    prep(ctx, font, 0);
    const m = ctx.measureText("HÁgjpqy|");
    if (Number.isFinite(m.fontBoundingBoxAscent) && m.fontBoundingBoxAscent > 0) {
      ascent = m.fontBoundingBoxAscent;
      descent = Number.isFinite(m.fontBoundingBoxDescent) ? m.fontBoundingBoxDescent : descent;
    } else if (Number.isFinite(m.actualBoundingBoxAscent) && m.actualBoundingBoxAscent > 0) {
      ascent = m.actualBoundingBoxAscent;
      descent = Number.isFinite(m.actualBoundingBoxDescent) ? m.actualBoundingBoxDescent : descent;
    }
  }
  const out = { ascent, descent };
  if (metricsCache.size > CACHE_LIMIT) metricsCache.clear();
  metricsCache.set(font, out);
  return out;
}

// Extra room around the text block for stroke, second outline and pill.
export function textPad(layer) {
  const sw = layer.stroke?.on ? Math.max(0, layer.stroke.width) : 0;
  const s2 = layer.stroke2?.on ? Math.max(0, layer.stroke2.width) : 0;
  const strokeReach = sw + s2;
  const bgX = layer.bg?.on ? Math.max(0, layer.bg.padX) : 0;
  const bgY = layer.bg?.on ? Math.max(0, layer.bg.padY) : 0;
  return { x: Math.max(strokeReach, bgX), y: Math.max(strokeReach, bgY) };
}

function breakWord(word, maxW, measure) {
  const chars = Array.from(word);
  let lo = 1;
  let hi = chars.length - 1;
  let fit = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (measure(chars.slice(0, mid).join("")) <= maxW + 0.01) {
      fit = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return [chars.slice(0, fit).join(""), chars.slice(fit).join("")];
}

// Greedy wrap on spaces; words wider than the line are broken by character.
export function wrapParagraph(par, maxW, measure) {
  if (!(maxW > 0) || measure(par) <= maxW + 0.01) return [par];
  const out = [];
  let line = null;
  for (const word of par.split(" ")) {
    if (line === null) {
      line = word;
    } else {
      const cand = `${line} ${word}`;
      if (measure(cand) <= maxW + 0.01) {
        line = cand;
        continue;
      }
      out.push(line);
      line = word;
    }
    while (charCount(line) > 1 && measure(line) > maxW + 0.01) {
      const [head, tail] = breakWord(line, maxW, measure);
      out.push(head);
      line = tail;
    }
  }
  if (line !== null) out.push(line);
  return out;
}

function layoutKey(layer, font, spacing, pad) {
  const fixed = layer.wrap === "fixed";
  return [
    font,
    spacing,
    layer.lineHeight,
    layer.align,
    fixed ? `f${layer.w}` : "a",
    layer.uppercase ? 1 : 0,
    pad.x,
    pad.y,
    layer.text,
  ].join("\u0001");
}

// Layout in content space with the box centered on 0,0. Each line's x is its
// left edge after alignment and y is its baseline. width/height are the box
// size (same as measureBox).
export function layoutText(layer, fonts) {
  if (fonts && fonts !== registry) useFonts(fonts);
  const font = fontString(layer);
  const spacing = spacingPx(layer);
  const pad = textPad(layer);
  const key = layoutKey(layer, font, spacing, pad);
  const hit = cache.get(key);
  if (hit) return hit;

  const size = layer.size;
  const measure = makeMeasurer(font, size, spacing);
  const { ascent, descent } = fontMetrics(font, size);
  const lineHeightPx = size * layer.lineHeight;
  const fixed = layer.wrap === "fixed";
  const minW = size * 0.5;
  const boxW = fixed ? Math.max(layer.w, pad.x * 2 + minW) : 0;
  const maxW = fixed ? Math.max(1, boxW - pad.x * 2) : Infinity;

  const texts = [];
  for (const par of displayText(layer).split("\n")) {
    if (fixed) texts.push(...wrapParagraph(par, maxW, measure.width));
    else texts.push(par);
  }
  const widths = texts.map((t) => measure.width(t));
  const contentW = Math.max(size * 0.2, ...widths);
  const contentH = ascent + descent + (texts.length - 1) * lineHeightPx;
  const width = fixed ? boxW : contentW + pad.x * 2;
  const height = contentH + pad.y * 2;
  const top = -height / 2 + pad.y;

  let l = Infinity;
  let r = -Infinity;
  let inkT = Infinity;
  let inkB = -Infinity;
  const lines = texts.map((text, i) => {
    const w = widths[i];
    let x;
    if (layer.align === "left") x = -width / 2 + pad.x;
    else if (layer.align === "right") x = width / 2 - pad.x - w;
    else x = -w / 2;
    const y = top + ascent + i * lineHeightPx;
    const ink = measure.ink(text);
    const inkAscent = ink ? ink.ascent : ascent * 0.8;
    const inkDescent = ink ? ink.descent : 0;
    if (text) {
      l = Math.min(l, x);
      r = Math.max(r, x + w);
    }
    if (ink) {
      inkT = Math.min(inkT, y - inkAscent);
      inkB = Math.max(inkB, y + inkDescent);
    }
    return { text, width: w, x, y, inkAscent, inkDescent };
  });
  if (l === Infinity) {
    l = -contentW / 2;
    r = contentW / 2;
  }
  const blockT = top;
  const blockB = top + contentH;
  if (inkT === Infinity) {
    inkT = blockT;
    inkB = blockB;
  }

  const out = {
    lines,
    width,
    height,
    contentWidth: contentW,
    contentHeight: contentH,
    ascent,
    descent,
    lineHeightPx,
    pad,
    block: { l, t: blockT, r, b: blockB },
    ink: { l, t: inkT, r, b: inkB },
    font,
    spacing,
  };
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, out);
  return out;
}

// Per-glyph x offsets for a line, used to draw letter spacing when canvas
// letterSpacing is not available. Cached on the line object.
export function glyphOffsets(line, layout) {
  if (line.offsets) return line.offsets;
  const ctx = getCtx();
  const chars = Array.from(line.text);
  const offsets = [];
  let prefix = "";
  for (let i = 0; i < chars.length; i++) {
    let w;
    if (ctx) {
      prep(ctx, layout.font, 0);
      w = prefix ? ctx.measureText(prefix).width : 0;
    } else {
      w = approxWidth(prefix, Number(layout.font.match(/(\d+(?:\.\d+)?)px/)?.[1]) || 16);
    }
    offsets.push({ ch: chars[i], x: w + i * layout.spacing });
    prefix += chars[i];
  }
  line.offsets = offsets;
  return offsets;
}

export function measureBox(layer) {
  const l = layoutText(layer);
  return { w: l.width, h: l.height };
}

const round2 = (v) => Math.round(v * 100) / 100;

// Keeps text boxes in sync with their text. New layers keep their center.
// Otherwise the horizontal anchor follows the alignment (left edge, center,
// right edge) and the vertical anchor is the top while typing or reflowing
// and the center for style changes, all in the layer's rotated frame.
export function textNormalizer(layer, doc, prev) {
  if (layer.type !== "text") return undefined;
  const m = measureBox(layer);
  const w = round2(m.w);
  const h = round2(m.h);
  const dw = w - layer.w;
  const dh = h - layer.h;
  if (Math.abs(dw) < 0.01 && Math.abs(dh) < 0.01) return undefined;
  if (!prev) return { w, h };
  let sx = layer.align === "left" ? dw / 2 : layer.align === "right" ? -dw / 2 : 0;
  const reflow = prev.text !== layer.text || (layer.wrap === "fixed" && (prev.w !== layer.w || prev.wrap !== layer.wrap));
  let sy = reflow ? dh / 2 : 0;
  if (layer.flipX) sx = -sx;
  if (layer.flipY) sy = -sy;
  const r = ((layer.rotation || 0) * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { w, h, x: layer.x + sx * c - sy * s, y: layer.y + sx * s + sy * c };
}

// Registers the text normalizer on a store and re-measures once. Returns a
// dispose function. Pass the FontRegistry when there is one.
export function installTextNormalizer(store, fonts) {
  if (fonts) useFonts(fonts);
  const off = store.addNormalizer(textNormalizer);
  const onRemeasure = () => bumpTextEpoch();
  store.addEventListener("remeasure", onRemeasure);
  store.remeasure();
  return () => {
    off();
    store.removeEventListener("remeasure", onRemeasure);
  };
}
