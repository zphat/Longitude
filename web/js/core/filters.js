// Pixel filters for image layers. A layer lists the filters it uses as
// [{ id, params }]; the renderer applies them in order to the cropped,
// masked image and caches the result. Mods register more with
// filters.register({ id, label, params: [...], apply(imageData, params) }).
// A param is { key, label, min, max, step, default } or, for colours,
// { key, label, type: "color", default: "#rrggbb" }.

import { createRegistry } from "../app/context.js";
import { parseColor, mulberry32 } from "./effects.js";

export const filters = createRegistry("filters", {
  validate(def) {
    if (typeof def.apply !== "function") throw Error(`filters: "${def.id}" needs apply()`);
    if (typeof def.label !== "string" || !def.label.trim()) throw Error(`filters: "${def.id}" needs a label`);
    if (def.params !== undefined && !Array.isArray(def.params)) throw Error(`filters: "${def.id}" params must be a list`);
  },
});

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

filters.register({
  id: "grain",
  label: "Grain",
  params: [
    { key: "amount", label: "Amount", min: 0, max: 100, step: 1, default: 24 },
    { key: "size", label: "Size", min: 1, max: 4, step: 1, default: 1 },
  ],
  // Film grain: the same pattern every time so the image never flickers.
  apply(img, p) {
    const amount = Math.max(0, Math.min(100, num(p?.amount, 24))) * 0.9;
    const size = Math.max(1, Math.min(4, Math.round(num(p?.size, 1))));
    if (!amount) return img;
    const { width: w, height: h, data: d } = img;
    const rand = mulberry32(num(p?.seed, 1337));
    const cols = Math.ceil(w / size);
    const rows = Math.ceil(h / size);
    const noise = new Float32Array(cols * rows);
    for (let i = 0; i < noise.length; i++) noise[i] = (rand() + rand() - 1) * amount;
    for (let y = 0; y < h; y++) {
      const row = ((y / size) | 0) * cols;
      for (let x = 0; x < w; x++) {
        const n = noise[row + ((x / size) | 0)];
        const i = (y * w + x) * 4;
        d[i] = d[i] + n;
        d[i + 1] = d[i + 1] + n;
        d[i + 2] = d[i + 2] + n;
      }
    }
    return img;
  },
});

filters.register({
  id: "duotone",
  label: "Duotone",
  params: [
    { key: "dark", label: "Shadows", type: "color", default: "#1b1464" },
    { key: "light", label: "Highlights", type: "color", default: "#ff7a1a" },
    { key: "mix", label: "Strength", min: 0, max: 100, step: 1, default: 100 },
  ],
  apply(img, p) {
    const a = parseColor(p?.dark || "#1b1464");
    const b = parseColor(p?.light || "#ff7a1a");
    const t = Math.max(0, Math.min(100, num(p?.mix, 100))) / 100;
    if (!t) return img;
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      d[i] += (a.r + (b.r - a.r) * l - d[i]) * t;
      d[i + 1] += (a.g + (b.g - a.g) * l - d[i + 1]) * t;
      d[i + 2] += (a.b + (b.b - a.b) * l - d[i + 2]) * t;
    }
    return img;
  },
});

// { key: default } for a filter definition.
export function filterDefaults(def) {
  const out = {};
  for (const p of def?.params || []) out[p.key] = p.default;
  return out;
}

// Apply a layer's filter list to ImageData in place. Unknown ids (a mod that
// is not loaded) are skipped. Returns the ImageData.
export function applyFilters(imageData, list) {
  let img = imageData;
  for (const f of list || []) {
    const def = filters.get(f?.id);
    if (!def) continue;
    try {
      img = def.apply(img, { ...filterDefaults(def), ...(f.params || {}) }) || img;
    } catch (err) {
      console.error(err);
    }
  }
  return img;
}

// Whether any filter in the list is registered (so the renderer can skip the
// pixel pass entirely).
export function hasActiveFilters(list) {
  return !!list?.some((f) => filters.has(f?.id));
}
