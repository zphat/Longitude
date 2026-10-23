// Size presets: platform sizes with a short note, export defaults and
// on-canvas guides. Bundled ones come from presets/presets.json; mods and JSON
// packs add more with register(). Every preset is validated and frozen.

import { createRegistry } from "../app/context.js";

export const GROUP_ORDER = ["YouTube", "Spotify", "Social", "Custom"];
export const GUIDE_KINDS = ["badge", "safe", "circle", "bar", "zone"];
export const MIN_SIDE = 16;
export const MAX_SIDE = 8000;

const EXPORT_TYPES = ["image/png", "image/jpeg", "image/webp"];
const ID_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const HEX_RE = /^#[0-9a-f]{3,8}$/i;
const EPS = 1e-4;

// Used only if presets.json cannot be fetched, so Home still has a start.
const FALLBACK = [
  {
    id: "yt-thumb",
    group: "YouTube",
    label: "YouTube thumbnail",
    width: 1280,
    height: 720,
    note: "16:9, JPG or PNG. The YouTube app takes up to 2 MB.",
    export: { type: "image/jpeg", quality: 0.92, maxBytes: 2000000, formats: ["image/jpeg", "image/png"] },
    guides: [
      { kind: "badge", x: 0.862, y: 0.86, w: 0.115, h: 0.088, label: "12:34" },
      { kind: "bar", x: 0, y: 0.985, w: 1, h: 0.015, label: "Watch progress" },
    ],
  },
  { id: "custom", group: "Custom", label: "Custom size", width: 1280, height: 720, custom: true, note: "Any size from 16 to 8000 px." },
];

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const in01 = (v) => isNum(v) && v >= -EPS && v <= 1 + EPS;
const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

// Rect kinds use x, y, w, h (top-left and size). Circles use cx (fraction of
// width), cy (fraction of height) and r (fraction of width).
export function normalizeGuide(g, where = "Guide") {
  if (!g || typeof g !== "object" || !GUIDE_KINDS.includes(g.kind)) {
    throw Error(`${where} needs a kind: ${GUIDE_KINDS.join(", ")}.`);
  }
  const out = { kind: g.kind };
  if (g.kind === "circle") {
    if (!in01(g.cx) || !in01(g.cy) || !isNum(g.r) || g.r <= 0 || g.r > 1 + EPS) {
      throw Error(`${where} needs cx, cy and r between 0 and 1.`);
    }
    Object.assign(out, { cx: clamp(g.cx, 0, 1), cy: clamp(g.cy, 0, 1), r: clamp(g.r, 0, 1) });
  } else {
    if (!["x", "y", "w", "h"].every((k) => in01(g[k]))) throw Error(`${where} needs x, y, w and h between 0 and 1.`);
    if (g.w <= 0 || g.h <= 0) throw Error(`${where} needs a width and height above 0.`);
    if (g.x + g.w > 1 + EPS || g.y + g.h > 1 + EPS) throw Error(`${where} must sit inside the canvas.`);
    Object.assign(out, { x: clamp(g.x, 0, 1), y: clamp(g.y, 0, 1), w: clamp(g.w, 0, 1), h: clamp(g.h, 0, 1) });
  }
  out.label = text(g.label, 60);
  out.note = text(g.note, 200);
  return out;
}

function normalizeExport(e) {
  const type = EXPORT_TYPES.includes(e?.type) ? e.type : "image/png";
  const out = {
    type,
    quality: isNum(e?.quality) ? clamp(e.quality, 0.1, 1) : 0.92,
    maxBytes: isNum(e?.maxBytes) && e.maxBytes > 0 ? Math.round(e.maxBytes) : null,
    formats: Array.isArray(e?.formats) ? [...new Set(e.formats.filter((t) => EXPORT_TYPES.includes(t)))] : [],
  };
  // Optional platform limits; the export dialog prefers them over its built-in table.
  for (const k of ["minWidth", "minHeight", "maxSide"]) if (isNum(e?.[k]) && e[k] > 0) out[k] = Math.round(clamp(e[k], 1, MAX_SIDE * 4));
  return out;
}

function normalizeBackground(bg) {
  if (!bg || typeof bg !== "object") return null;
  if (bg.kind === "transparent") return { kind: "transparent" };
  if (bg.kind === "color" && HEX_RE.test(bg.color || "")) return { kind: "color", color: bg.color };
  if (bg.kind === "gradient" && HEX_RE.test(bg.from || "") && HEX_RE.test(bg.to || "")) {
    return { kind: "gradient", from: bg.from, to: bg.to, angle: isNum(bg.angle) ? bg.angle : 135 };
  }
  return null;
}

function normalizeSources(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((s) => s && typeof s.url === "string" && /^https:\/\//.test(s.url))
    .map((s) => ({ title: text(s.title, 160) || s.url, url: s.url, checked: text(s.checked, 32), confirms: text(s.confirms, 400) }));
}

function side(def, key) {
  const v = def[key];
  if (!isNum(v) || Math.round(v) < MIN_SIDE || Math.round(v) > MAX_SIDE) {
    throw Error(`Preset "${def.id}": ${key} must be a number from ${MIN_SIDE} to ${MAX_SIDE}.`);
  }
  return Math.round(v);
}

// Validate and fill defaults. Throws an Error with a plain message.
export function normalizePreset(def, { source = "mod" } = {}) {
  if (!def || typeof def !== "object") throw Error("A preset must be an object.");
  if (typeof def.id !== "string" || !ID_RE.test(def.id)) {
    throw Error(`Preset id "${def.id}" is not valid. Use lowercase letters, digits, dots and dashes.`);
  }
  const label = text(def.label, 80);
  if (!label) throw Error(`Preset "${def.id}" needs a label.`);
  if (def.guides !== undefined && !Array.isArray(def.guides)) throw Error(`Preset "${def.id}": guides must be a list.`);
  const guides = (def.guides || []).map((g, i) => normalizeGuide(g, `Preset "${def.id}", guide ${i + 1}`));
  return deepFreeze({
    id: def.id,
    group: text(def.group, 40) || "Other",
    label,
    width: side(def, "width"),
    height: side(def, "height"),
    note: text(def.note, 400),
    keywords: text(def.keywords, 200),
    custom: def.custom === true,
    background: normalizeBackground(def.background),
    export: normalizeExport(def.export),
    guides,
    sources: normalizeSources(def.sources),
    // "bundled" (presets.json), "mod" (code mods) or "pack" (imported JSON packs).
    source: source === "mod" && def.source === "pack" ? "pack" : source,
  });
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const COMMON_RATIOS = [
  [1, 1], [16, 9], [9, 16], [4, 3], [3, 4], [4, 5], [5, 4], [3, 2], [2, 3], [21, 9], [7, 3], [2, 1], [3, 1],
];

// "16:9", "1:1", "7:3"; near-misses snap to a common ratio within 0.5 %;
// anything else reads as "1.91:1".
export function aspectLabel(width, height) {
  if (!(width > 0 && height > 0)) return "";
  const g = gcd(Math.round(width), Math.round(height));
  const a = Math.round(width) / g;
  const b = Math.round(height) / g;
  if (a <= 32 && b <= 32) return `${a}:${b}`;
  const r = width / height;
  const near = COMMON_RATIOS.find(([x, y]) => Math.abs(x / y - r) / r < 0.005);
  if (near) return `${near[0]}:${near[1]}`;
  return r >= 1 ? `${r.toFixed(2).replace(/\.?0+$/, "")}:1` : `1:${(1 / r).toFixed(2).replace(/\.?0+$/, "")}`;
}

// The service. defs: raw preset objects; invalid ones are skipped and listed
// in `errors` so one bad entry never blocks the app.
export function createPresets(defs = [], { source = "bundled" } = {}) {
  const reg = createRegistry("presets");
  const errors = [];
  for (const def of defs) {
    try {
      reg.register(normalizePreset(def, { source }));
    } catch (err) {
      errors.push({ id: typeof def?.id === "string" ? def.id : null, message: err.message });
      console.warn(`Longitude presets: ${err.message}`);
    }
  }

  function groups() {
    const byGroup = new Map();
    for (const p of reg.list()) {
      if (!byGroup.has(p.group)) byGroup.set(p.group, []);
      byGroup.get(p.group).push(p);
    }
    const known = GROUP_ORDER.filter((g) => g !== "Custom");
    const extra = [...byGroup.keys()].filter((g) => !GROUP_ORDER.includes(g));
    return [...known, ...extra, "Custom"]
      .filter((g) => byGroup.has(g))
      .map((g) => ({ id: g, label: g, presets: byGroup.get(g) }));
  }

  return {
    list: () => groups().flatMap((g) => g.presets),
    get: (id) => reg.get(id),
    has: (id) => reg.has(id),
    groups,
    // Mods and JSON packs: validates (throws a plain Error), returns dispose.
    register(def) {
      return reg.register(normalizePreset(def, { source: "mod" }));
    },
    // First non-custom preset with exactly this size, in list order.
    find(width, height) {
      return groups()
        .flatMap((g) => g.presets)
        .find((p) => !p.custom && p.width === Math.round(width) && p.height === Math.round(height)) || null;
    },
    onChange: (fn) => reg.onChange(fn),
    get errors() {
      return errors.slice();
    },
  };
}

export async function loadPresets(ctx, url = "presets/presets.json") {
  let defs = FALLBACK;
  try {
    const res = await fetch(url);
    if (!res.ok) throw Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json || !Array.isArray(json.presets)) throw Error("no presets list");
    defs = json.presets;
  } catch (err) {
    console.warn(`Longitude presets: could not load ${url} (${err.message}). Using the built-in ones.`);
  }
  const service = createPresets(defs, { source: "bundled" });
  service.onChange(() => ctx?.emit?.("presets", {}));
  return service;
}
