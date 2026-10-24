// Deep fry: the over-saturated, over-sharpened, crunchy meme look.
//
// Shows the filters registry. A filter is a pure function over ImageData; the
// renderer runs it on the cropped, masked image and caches the result, so it
// only re-runs when the layer or the filter's params change. A command adds it
// to the selected images, and an inspector section tunes or removes it.

export const manifest = {
  id: "deep-fry",
  name: "Deep fry",
  version: "1.0.0",
  author: "Longitude",
  homepage: "https://github.com/zphat/Longitude/tree/main/web/mods/deep-fry",
  description: "A filter that crushes color and contrast, oversharpens and adds noise, plus a command to fry the selected images.",
  apiVersion: 1,
};

const FILTER_ID = "deep-fry";

const PARAMS = [
  { key: "amount", label: "Fry", min: 0, max: 100, step: 1, default: 70 },
  { key: "sharpen", label: "Sharpen", min: 0, max: 100, step: 1, default: 60 },
  { key: "noise", label: "Noise", min: 0, max: 100, step: 1, default: 30 },
];

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const pct = (v, d) => Math.max(0, Math.min(100, num(v, d))) / 100;

// Small seeded random numbers, so the noise is the same on every render.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Saturation and contrast crush with a warm push, then a slight posterize.
function crush(d, k) {
  const sat = 1 + 2.2 * k;
  const con = 1 + 1.4 * k;
  const warm = 30 * k;
  const step = 256 / Math.max(8, Math.round(64 - 48 * k));
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    const r2 = ((l + (r - l) * sat - 128) * con + 128 + warm) | 0;
    const g2 = ((l + (g - l) * sat - 128) * con + 128 + warm * 0.25) | 0;
    const b2 = ((l + (b - l) * sat - 128) * con + 128 - warm) | 0;
    d[i] = Math.round(r2 / step) * step;
    d[i + 1] = Math.round(g2 / step) * step;
    d[i + 2] = Math.round(b2 / step) * step;
  }
}

// 3 x 3 sharpen against a copy of the pixels. Edge pixels are left as they are.
function sharpen(d, w, h, s) {
  const src = new Uint8ClampedArray(d);
  const row = w * 4;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * row + x * 4;
      for (let c = 0; c < 3; c++) {
        const j = i + c;
        const edge = 4 * src[j] - src[j - 4] - src[j + 4] - src[j - row] - src[j + row];
        d[j] = src[j] + edge * s;
      }
    }
  }
}

function noise(d, amount) {
  const rand = rng(0xf4e1);
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() + rand() - 1) * amount;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
}

export function deepFry(img, p = {}) {
  const k = pct(p.amount, 70);
  const s = pct(p.sharpen, 60) * 1.6;
  const n = pct(p.noise, 30) * 60;
  if (!k && !s && !n) return img;
  const { width: w, height: h, data: d } = img;
  if (k) crush(d, k);
  if (s && w > 2 && h > 2) sharpen(d, w, h, s);
  if (n) noise(d, n);
  return img;
}

// ---- layer helpers -------------------------------------------------------------

const defaults = () => Object.fromEntries(PARAMS.map((p) => [p.key, p.default]));
const fried = (layer) => layer.filters?.find((f) => f.id === FILTER_ID) || null;
const selectedImages = (api) => api.store.selected().filter((l) => l.type === "image");

function fryImages(api) {
  const images = selectedImages(api);
  const raw = images.filter((l) => !fried(l));
  if (!raw.length) {
    api.ui.toast("Already deep fried. Tune it in the Deep fry section of the inspector.");
    return;
  }
  api.store.patch(
    raw.map((l) => l.id),
    (l) => ({ filters: [...(l.filters || []), { id: FILTER_ID, params: defaults() }] }),
    { label: "Deep fry" }
  );
  api.editor.flash(raw.map((l) => l.id));
}

function unfry(api, ids) {
  api.store.patch(ids, (l) => ({ filters: (l.filters || []).filter((f) => f.id !== FILTER_ID) }), { label: "Remove deep fry" });
}

function setParam(api, ids, key, value) {
  api.store.patch(
    ids,
    (l) => ({ filters: (l.filters || []).map((f) => (f.id === FILTER_ID ? { ...f, params: { ...f.params, [key]: value } } : f)) }),
    { label: "Deep fry", coalesce: `deep-fry-${key}` }
  );
}

// The section shows for image selections. It offers the filter when the
// images are not fried yet and its sliders once they are, and keeps itself in
// step with undo and redo.
function renderSection(body, layers, api) {
  const { slider, button } = api.controls;
  const ids = layers.map((l) => l.id);
  const wrap = api.h("div", { class: "mod-stack" });
  const timers = new Map();
  let sliders = [];
  let shown = null;

  const current = () => fried(api.store.get(ids[0]) || {});
  const anyFried = () => ids.some((id) => fried(api.store.get(id) || {}));

  function paint() {
    shown = anyFried();
    sliders = [];
    wrap.replaceChildren();
    if (!shown) {
      wrap.append(
        api.h("p", { class: "mod-hint" }, "Crushed color, oversharpened edges and noise."),
        button({ label: "Deep fry", wide: true, onClick: () => fryImages(api) })
      );
      return;
    }
    const f = current();
    for (const p of PARAMS) {
      const push = (v) => {
        clearTimeout(timers.get(p.key));
        timers.set(p.key, setTimeout(() => setParam(api, ids, p.key, v), 60));
      };
      const el = slider({
        label: p.label,
        min: p.min,
        max: p.max,
        step: p.step,
        value: num(f?.params?.[p.key], p.default),
        defaultValue: p.default,
        onInput: push,
        onChange: (v) => {
          clearTimeout(timers.get(p.key));
          setParam(api, ids, p.key, v);
        },
      });
      sliders.push([p, el]);
      wrap.append(el);
    }
    wrap.append(button({ label: "Remove deep fry", kind: "ghost danger", wide: true, onClick: () => unfry(api, ids) }));
  }

  function sync() {
    if (anyFried() !== shown) return paint();
    const f = current();
    if (!f) return;
    for (const [p, el] of sliders) {
      const v = num(f.params?.[p.key], p.default);
      if (el.value !== v) el.value = v;
    }
  }

  paint();
  body.append(wrap);
  const off = api.store.on("change", sync);
  return () => {
    off();
    for (const t of timers.values()) clearTimeout(t);
  };
}

export function activate(api) {
  api.filters.register({ id: FILTER_ID, label: "Deep fry", params: PARAMS, apply: deepFry });

  api.commands.register({
    id: "deep-fry.apply",
    title: "Deep fry selected image",
    group: "Image",
    keywords: "meme fried saturate crunchy filter",
    when: (api) => selectedImages(api).length > 0,
    run: (api) => fryImages(api),
  });

  api.commands.register({
    id: "deep-fry.remove",
    title: "Remove deep fry",
    group: "Image",
    keywords: "unfry filter clear",
    when: (api) => selectedImages(api).some(fried),
    run: (api) => unfry(api, selectedImages(api).filter(fried).map((l) => l.id)),
  });

  api.inspector.register({
    id: "deep-fry",
    title: "Deep fry",
    order: 33,
    when: (layers) => layers.length > 0 && layers.every((l) => l.type === "image"),
    render: renderSection,
  });
}
