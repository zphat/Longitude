// Document model: defaults, factories and validation. Anything that comes from
// outside (files, clipboard, mods, old autosaves) goes through normalizeDoc or
// normalizeLayer before it reaches the store. Normalizing never throws for a
// problem it can repair: bad numbers are clamped, bad colors fall back to the
// default, unknown fields are dropped and missing ids are created.

export const LAYER_TYPES = ["image", "text", "shape", "path", "arrow"];

export const BLEND_MODES = [
  { id: "normal", label: "Normal" },
  { id: "multiply", label: "Multiply" },
  { id: "screen", label: "Screen" },
  { id: "overlay", label: "Overlay" },
  { id: "darken", label: "Darken" },
  { id: "lighten", label: "Lighten" },
  { id: "color-dodge", label: "Color dodge" },
  { id: "color-burn", label: "Color burn" },
  { id: "hard-light", label: "Hard light" },
  { id: "soft-light", label: "Soft light" },
  { id: "difference", label: "Difference" },
  { id: "exclusion", label: "Exclusion" },
  { id: "hue", label: "Hue" },
  { id: "saturation", label: "Saturation" },
  { id: "color", label: "Color" },
  { id: "luminosity", label: "Luminosity" },
];

const BLEND_IDS = new Set(BLEND_MODES.map((b) => b.id));

export const DOC_DEFAULTS = {
  name: "Untitled thumbnail",
  width: 1280,
  height: 720,
  preset: "yt-thumb",
  background: { kind: "color", color: "#0b0c0b" },
};

export const DEFAULTS = {
  base: {
    id: "",
    type: "",
    name: "",
    x: 640,
    y: 360,
    w: 200,
    h: 200,
    rotation: 0,
    flipX: false,
    flipY: false,
    opacity: 1,
    blend: "normal",
    hidden: false,
    locked: false,
    shadow: { on: false, color: "#000000", opacity: 0.6, blur: 24, dx: 0, dy: 10 },
    glow: { on: false, color: "#d1ff4a", opacity: 0.9, size: 28 },
  },
  image: {
    w: 400,
    h: 300,
    asset: "",
    natW: 1,
    natH: 1,
    crop: { x: 0, y: 0, w: 1, h: 1 },
    mask: null,
    frame: "rect",
    radius: 0,
    adjust: { brightness: 0, contrast: 0, saturation: 0, warmth: 0, hue: 0, blur: 0 },
    outline: { on: false, color: "#ffffff", width: 14 },
    filters: [],
  },
  text: {
    w: 400,
    h: 160,
    text: "Your text",
    font: "Anton",
    weight: 400,
    italic: false,
    size: 140,
    color: "#ffffff",
    gradient: { on: false, from: "#ffe14d", to: "#ff7a1a", angle: 180 },
    align: "center",
    lineHeight: 1.05,
    letterSpacing: 0,
    uppercase: false,
    stroke: { on: true, color: "#000000", width: 10 },
    stroke2: { on: false, color: "#d1ff4a", width: 10 },
    bg: { on: false, color: "#000000", opacity: 1, padX: 28, padY: 14, radius: 18 },
    wrap: "auto",
  },
  shape: {
    w: 360,
    h: 240,
    shape: "rect",
    fill: { on: true, color: "#d1ff4a" },
    stroke: { on: false, color: "#ffffff", width: 8, dash: false },
    radius: 0,
    params: {},
  },
  path: {
    w: 200,
    h: 200,
    points: [],
    color: "#ff2d2d",
    width: 10,
    smoothing: 0.5,
  },
  arrow: {
    w: 360,
    h: 120,
    a: [0.06, 0.5],
    b: [0.94, 0.5],
    c: null,
    color: "#ff2d2d",
    width: 14,
    head: "triangle",
    tail: "none",
    headSize: 3.2,
    sketch: false,
  },
};

const DEFAULT_NAMES = { image: "Image", text: "Text", shape: "Shape", path: "Drawing", arrow: "Arrow" };
const SHAPE_NAMES = { rect: "Rectangle", ellipse: "Circle", triangle: "Triangle", star: "Star", burst: "Burst", bubble: "Speech bubble" };

// Numeric ranges by field path. Anything not listed only has to be finite.
const RANGES = {
  x: [-1e5, 1e5],
  y: [-1e5, 1e5],
  w: [1, 1e5],
  h: [1, 1e5],
  opacity: [0, 1],
  "shadow.opacity": [0, 1],
  "shadow.blur": [0, 400],
  "shadow.dx": [-2000, 2000],
  "shadow.dy": [-2000, 2000],
  "glow.opacity": [0, 1],
  "glow.size": [0, 400],
  natW: [1, 1e5],
  natH: [1, 1e5],
  "crop.x": [0, 0.999],
  "crop.y": [0, 0.999],
  "crop.w": [0.001, 1],
  "crop.h": [0.001, 1],
  radius: [0, 1e5],
  "adjust.brightness": [-100, 100],
  "adjust.contrast": [-100, 100],
  "adjust.saturation": [-100, 100],
  "adjust.warmth": [-100, 100],
  "adjust.hue": [-180, 180],
  "adjust.blur": [0, 100],
  "outline.width": [0, 400],
  weight: [1, 1000],
  size: [4, 4000],
  "gradient.angle": [-360, 360],
  lineHeight: [0.5, 5],
  letterSpacing: [-200, 800],
  "stroke.width": [0, 400],
  "stroke2.width": [0, 400],
  "bg.opacity": [0, 1],
  "bg.padX": [0, 2000],
  "bg.padY": [0, 2000],
  "bg.radius": [0, 1e4],
  width: [0.5, 1000],
  smoothing: [0, 1],
  headSize: [0.5, 12],
};

const INTEGERS = new Set(["weight"]);

const ENUMS = {
  blend: BLEND_IDS,
  frame: new Set(["rect", "ellipse"]),
  align: new Set(["left", "center", "right"]),
  wrap: new Set(["auto", "fixed"]),
  head: new Set(["triangle", "line", "none"]),
  tail: new Set(["none", "triangle", "line", "dot"]),
};

const COLOR_KEYS = new Set(["color", "from", "to"]);
const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ASSET_RE = /^ast_[A-Za-z0-9_-]{1,64}$/;
const REG_ID_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const MAX_POINTS = 20000;

export const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

export function isColor(v) {
  return typeof v === "string" && COLOR_RE.test(v);
}

export function normColor(v, fallback) {
  return isColor(v) ? v.toLowerCase() : fallback;
}

export function clampNum(v, min, max, fallback) {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Degrees normalized to (-180, 180].
export function normAngle(deg) {
  if (!Number.isFinite(deg)) return 0;
  let a = deg % 360;
  if (a <= -180) a += 360;
  else if (a > 180) a -= 360;
  return a === 0 ? 0 : a;
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!Object.hasOwn(b, k) || !deepEqual(a[k], b[k])) return false;
  return true;
}

export function uid(prefix = "id") {
  const bytes = new Uint8Array(12);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let s = "";
  for (const b of bytes) s += (b % 36).toString(36);
  return `${prefix}_${s}`;
}

const clone = (v) => (v === null || typeof v !== "object" ? v : structuredClone(v));

// ---- background ---------------------------------------------------------

export function normalizeBackground(raw, fallback = DOC_DEFAULTS.background) {
  if (!raw || typeof raw !== "object") return clone(fallback);
  if (raw.kind === "transparent") return { kind: "transparent" };
  if (raw.kind === "gradient") {
    return {
      kind: "gradient",
      from: normColor(raw.from, "#1b1f22"),
      to: normColor(raw.to, "#0b0c0b"),
      angle: clampNum(raw.angle, -360, 360, 135),
    };
  }
  if (raw.kind === "color" || raw.kind === undefined) {
    return { kind: "color", color: normColor(raw.color, fallback?.kind === "color" ? fallback.color : DOC_DEFAULTS.background.color) };
  }
  return clone(fallback);
}

// ---- documents ----------------------------------------------------------

export function createDoc({ width, height, name, preset, background } = {}) {
  const now = Date.now();
  return {
    v: 1,
    id: uid("doc"),
    name: cleanName(name, DOC_DEFAULTS.name),
    width: Math.round(clampNum(width, 16, 8192, DOC_DEFAULTS.width)),
    height: Math.round(clampNum(height, 16, 8192, DOC_DEFAULTS.height)),
    preset: preset === null ? null : typeof preset === "string" && preset ? preset.slice(0, 64) : width || height ? null : DOC_DEFAULTS.preset,
    background: normalizeBackground(background),
    layers: [],
    meta: { created: now, updated: now },
  };
}

function cleanName(v, fallback) {
  if (typeof v !== "string") return fallback;
  const s = v.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200);
  return s || fallback;
}

export function normalizeDoc(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("This is not a Longitude design.");
  const hasLayers = Array.isArray(raw.layers);
  const hasSize = Number.isFinite(Number(raw.width)) || Number.isFinite(Number(raw.height));
  if (!hasLayers && !hasSize) throw Error("This file does not contain a design.");
  const now = Date.now();
  const created = clampNum(raw.meta?.created, 0, 1e15, now);
  const doc = {
    v: 1,
    id: typeof raw.id === "string" && ID_RE.test(raw.id) ? raw.id : uid("doc"),
    name: cleanName(raw.name, DOC_DEFAULTS.name),
    width: Math.round(clampNum(raw.width, 16, 8192, DOC_DEFAULTS.width)),
    height: Math.round(clampNum(raw.height, 16, 8192, DOC_DEFAULTS.height)),
    preset: typeof raw.preset === "string" && raw.preset ? raw.preset.slice(0, 64) : null,
    background: normalizeBackground(raw.background),
    layers: [],
    meta: { created, updated: clampNum(raw.meta?.updated, 0, 1e15, created) },
  };
  const seen = new Set();
  for (const r of hasLayers ? raw.layers : []) {
    const layer = normalizeLayer(r);
    if (!layer) continue;
    if (seen.has(layer.id)) layer.id = uid("lyr");
    seen.add(layer.id);
    doc.layers.push(layer);
  }
  return doc;
}

// ---- layers -------------------------------------------------------------

function defaultName(type, props) {
  if (type === "shape") return SHAPE_NAMES[props?.shape] || "Shape";
  return DEFAULT_NAMES[type] || "Layer";
}

function template(type) {
  return { ...DEFAULTS.base, ...DEFAULTS[type], type };
}

export function createLayer(type, props = {}) {
  if (!LAYER_TYPES.includes(type)) throw Error(`Unknown layer type "${type}".`);
  const t = template(type);
  const raw = {};
  for (const [k, v] of Object.entries(t)) {
    const p = props?.[k];
    if (p === undefined) raw[k] = clone(v);
    else if (isPlainObject(v) && isPlainObject(p)) raw[k] = { ...clone(v), ...clone(p) };
    else raw[k] = clone(p);
  }
  raw.type = type;
  raw.id = typeof props?.id === "string" && ID_RE.test(props.id) ? props.id : uid("lyr");
  raw.name = typeof props?.name === "string" && props.name.trim() ? props.name : defaultName(type, raw);
  return normalizeLayer(raw);
}

export function cloneLayer(layer) {
  const c = structuredClone(layer);
  c.id = uid("lyr");
  return c;
}

export function normalizeLayer(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const type = raw.type;
  if (!LAYER_TYPES.includes(type)) return null;
  const t = template(type);
  const out = {};
  for (const [k, def] of Object.entries(t)) out[k] = normField(k, k, raw[k], def, type);
  out.type = type;
  out.id = typeof raw.id === "string" && ID_RE.test(raw.id) ? raw.id : uid("lyr");
  out.name = cleanName(raw.name, defaultName(type, out));
  out.rotation = normAngle(clampNum(raw.rotation, -1e6, 1e6, 0));
  fixType(out, raw);
  return out;
}

function normField(path, key, value, def, type) {
  if (path === "id" || path === "type" || path === "name") return def;
  if (Array.isArray(def) || def === null) return def === null ? value ?? null : clone(def);
  if (isPlainObject(def)) {
    const src = isPlainObject(value) ? value : {};
    const o = {};
    for (const [k, d] of Object.entries(def)) o[k] = normField(`${path}.${k}`, k, src[k], d, type);
    return o;
  }
  if (typeof def === "boolean") return typeof value === "boolean" ? value : def;
  if (typeof def === "number") {
    const r = RANGES[path] || [-1e9, 1e9];
    const n = clampNum(value, r[0], r[1], def);
    return INTEGERS.has(path) ? Math.round(n) : n;
  }
  if (typeof def === "string") {
    if (COLOR_KEYS.has(key)) return normColor(value, def);
    if (ENUMS[key]) return ENUMS[key].has(value) ? value : def;
    return typeof value === "string" ? value : def;
  }
  return def;
}

function point2(v, fallback) {
  if (!Array.isArray(v) || v.length < 2) return fallback;
  const u = Number(v[0]);
  const w = Number(v[1]);
  if (!Number.isFinite(u) || !Number.isFinite(w)) return fallback;
  return [clampNum(u, -100, 100, 0), clampNum(w, -100, 100, 0)];
}

function primitiveMap(v, maxKeys = 32) {
  const out = {};
  if (!isPlainObject(v)) return out;
  let n = 0;
  for (const [k, val] of Object.entries(v)) {
    if (n >= maxKeys || !/^[A-Za-z0-9_-]{1,40}$/.test(k)) continue;
    if (typeof val === "number" && Number.isFinite(val)) out[k] = val;
    else if (typeof val === "boolean") out[k] = val;
    else if (typeof val === "string") out[k] = val.slice(0, 200);
    else continue;
    n++;
  }
  return out;
}

function fixType(out, raw) {
  switch (out.type) {
    case "image": {
      out.asset = typeof raw.asset === "string" && ASSET_RE.test(raw.asset) ? raw.asset : "";
      out.mask = typeof raw.mask === "string" && ASSET_RE.test(raw.mask) ? raw.mask : null;
      const c = out.crop;
      c.w = Math.max(0.001, Math.min(c.w, 1 - c.x));
      c.h = Math.max(0.001, Math.min(c.h, 1 - c.y));
      out.filters = Array.isArray(raw.filters)
        ? raw.filters
            .filter((f) => f && typeof f.id === "string" && REG_ID_RE.test(f.id))
            .slice(0, 20)
            .map((f) => ({ id: f.id, params: primitiveMap(f.params) }))
        : [];
      break;
    }
    case "text": {
      out.text = typeof raw.text === "string" ? raw.text.replace(/\r\n?/g, "\n").slice(0, 10000) : DEFAULTS.text.text;
      const font = typeof raw.font === "string" ? raw.font.replace(/["\\;{}<>]/g, "").trim().slice(0, 120) : "";
      out.font = font || DEFAULTS.text.font;
      break;
    }
    case "shape": {
      out.shape = typeof raw.shape === "string" && REG_ID_RE.test(raw.shape) ? raw.shape : "rect";
      out.params = primitiveMap(raw.params);
      break;
    }
    case "path": {
      const pts = [];
      if (Array.isArray(raw.points)) {
        for (const p of raw.points) {
          if (pts.length >= MAX_POINTS) break;
          if (!Array.isArray(p) || p.length < 2) continue;
          const u = Number(p[0]);
          const v = Number(p[1]);
          if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
          pts.push([clampNum(u, -100, 100, 0), clampNum(v, -100, 100, 0), clampNum(p[2], 0, 1, 0.5)]);
        }
      }
      out.points = pts;
      break;
    }
    case "arrow": {
      out.a = point2(raw.a, [...DEFAULTS.arrow.a]);
      out.b = point2(raw.b, [...DEFAULTS.arrow.b]);
      out.c = raw.c == null ? null : point2(raw.c, null);
      break;
    }
  }
}

// Every asset id a document references (image assets and masks).
export function assetIdsOf(doc) {
  const ids = new Set();
  for (const l of doc?.layers || []) {
    if (l.type !== "image") continue;
    if (l.asset) ids.add(l.asset);
    if (l.mask) ids.add(l.mask);
  }
  return ids;
}
