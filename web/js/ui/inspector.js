// Inspector: the right island's contextual sections (SPEC 10). Sections are
// rebuilt only when the selection changes; every other store change updates
// the controls in place so focus, scroll and drags are never interrupted.
//
// Edits: sliders, scrubs and color drags open one store gesture on the first
// input and commit on release (one undo step per drag). Discrete changes are a
// single labeled patch. Numeric fields commit on Enter or blur.
//
// Also registers the inspector's commands and ctx.ui.openColorPicker /
// ctx.ui.openFontPicker. Panel, fontButton and the shared flows are exported
// for the quick bar.

import { h, svg, disposer } from "./dom.js";
import { slider, number, toggle, segmented, select, button, iconButton, swatch, field, section } from "./controls.js";
import { icon, hasIcon, registerIcons } from "./icons.js";
import { openColorPicker, bindColorPicker, normalizeHex } from "./colorpicker.js";
import { openFontPicker, bindFontPicker } from "./fontpicker.js";
import { BLEND_MODES, createLayer, deepEqual } from "../core/model.js";
import { shapePreviewPath, shapeParams } from "../core/shapes.js";
import { aabb, unionBox, arrowPoints, refitArrow } from "../core/geometry.js";
import { aspectLabel } from "../features/presets.js";

const RAD = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round = (v, d = 2) => {
  const k = 10 ** d;
  return Math.round(v * k) / k;
};

// ---- icons ------------------------------------------------------------------------

// Registered only when the shell's set does not have them, so the shell's
// drawings win where both exist.
const FALLBACK_ICONS = {
  eye: '<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>',
  "eye-off": '<path d="M10.73 5.08a10.74 10.74 0 0 1 11.2 6.57 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-1.44 2.49"/><path d="M14.08 14.16a3 3 0 0 1-4.24-4.24"/><path d="M17.48 17.5a10.75 10.75 0 0 1-15.42-5.15 1 1 0 0 1 0-.7 10.75 10.75 0 0 1 4.45-5.14"/><path d="m2 2 20 20"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  unlock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  "text-align-left": '<path d="M21 6H3"/><path d="M15 12H3"/><path d="M17 18H3"/>',
  "text-align-center": '<path d="M21 6H3"/><path d="M17 12H7"/><path d="M19 18H5"/>',
  "text-align-right": '<path d="M21 6H3"/><path d="M21 12H9"/><path d="M21 18H7"/>',
  italic: '<path d="M19 4h-9"/><path d="M14 20H5"/><path d="M15 4 9 20"/>',
  "case-upper": '<path d="m3 15 4-8 4 8"/><path d="M4 13h6"/><path d="M15 11h4.5a2 2 0 0 1 0 4H15V7h4a2 2 0 0 1 0 4"/>',
  "flip-h": '<path d="m3 7 5 5-5 5V7"/><path d="m21 7-5 5 5 5V7"/><path d="M12 20v2"/><path d="M12 14v2"/><path d="M12 8v2"/><path d="M12 2v2"/>',
  "flip-v": '<path d="m17 3-5 5-5-5h10"/><path d="m17 21-5-5-5 5h10"/><path d="M4 12H2"/><path d="M10 12H8"/><path d="M16 12h-2"/><path d="M22 12h-2"/>',
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
  wand: '<path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/>',
  brush: '<path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z"/>',
  "remove-bg": '<path d="M4 8V6a2 2 0 0 1 2-2h2"/><path d="M16 4h2a2 2 0 0 1 2 2v2"/><path d="M20 16v2a2 2 0 0 1-2 2h-2"/><path d="M8 20H6a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="10" r="3"/><path d="M7.5 18.5c.9-2.3 2.5-3.5 4.5-3.5s3.6 1.2 4.5 3.5"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  "copy-plus": '<path d="M15 12v6"/><path d="M12 15h6"/><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  link: '<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><path d="M8 12h8"/>',
  unlink: '<path d="M9 17H7A5 5 0 0 1 7 7"/><path d="M15 7h2a5 5 0 0 1 4 8"/><path d="M8 12h4"/><path d="m2 2 20 20"/>',
  pipette: '<path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  layers: '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  "chevron-up": '<path d="m18 15-6-6-6 6"/>',
  "arrow-left-right": '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
  rotate: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  type: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
  "align-left": '<path d="M4 3v18"/><rect x="8" y="6" width="12" height="4" rx="1.5"/><rect x="8" y="14" width="7" height="4" rx="1.5"/>',
  "align-center-h": '<path d="M12 3v18"/><rect x="5" y="6" width="14" height="4" rx="1.5"/><rect x="8" y="14" width="8" height="4" rx="1.5"/>',
  "align-right": '<path d="M20 3v18"/><rect x="4" y="6" width="12" height="4" rx="1.5"/><rect x="9" y="14" width="7" height="4" rx="1.5"/>',
  "align-top": '<path d="M3 4h18"/><rect x="6" y="8" width="4" height="12" rx="1.5"/><rect x="14" y="8" width="4" height="7" rx="1.5"/>',
  "align-center-v": '<path d="M3 12h18"/><rect x="6" y="5" width="4" height="14" rx="1.5"/><rect x="14" y="8" width="4" height="8" rx="1.5"/>',
  "align-bottom": '<path d="M3 20h18"/><rect x="6" y="4" width="4" height="12" rx="1.5"/><rect x="14" y="9" width="4" height="7" rx="1.5"/>',
  "distribute-h": '<path d="M4 3v18"/><path d="M20 3v18"/><rect x="9" y="7" width="6" height="10" rx="1.5"/>',
  "distribute-v": '<path d="M3 4h18"/><path d="M3 20h18"/><rect x="7" y="9" width="10" height="6" rx="1.5"/>',
  "bring-front": '<path d="M5 3h14"/><path d="m18 13-6-6-6 6"/><path d="M12 7v14"/>',
  "bring-forward": '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  "send-backward": '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  "send-back": '<path d="M5 21h14"/><path d="m6 11 6 6 6-6"/><path d="M12 17V3"/>',
  "ins-head-triangle": '<path d="M3 12h12"/><path d="m13 7 8 5-8 5z" fill="currentColor"/>',
  "ins-head-line": '<path d="M3 12h17"/><path d="m14 6 6 6-6 6"/>',
  "ins-end-none": '<path d="M3 12h18"/>',
  "ins-tail-triangle": '<path d="M9 12h12"/><path d="m11 7-8 5 8 5z" fill="currentColor"/>',
  "ins-tail-line": '<path d="M4 12h17"/><path d="m10 6-6 6 6 6"/>',
  "ins-tail-dot": '<circle cx="6" cy="12" r="3" fill="currentColor"/><path d="M9 12h12"/>',
  "ins-straighten": '<path d="M4.5 19.5 19.5 4.5"/><circle cx="4.5" cy="19.5" r="1.5"/><circle cx="19.5" cy="4.5" r="1.5"/>',
  "ins-size": '<path d="M3 7V5h11v2"/><path d="M8.5 5v14"/><path d="M6.5 19h4"/><path d="M14 13v-1h7v1"/><path d="M17.5 12v7"/><path d="M16 19h3"/>',
  "ins-width": '<path d="M4 6h16" stroke-width="1.2"/><path d="M4 12h16" stroke-width="2.2"/><path d="M4 18h16" stroke-width="3.4"/>',
  "ins-frame-rect": '<rect x="4" y="5" width="16" height="14" rx="3.5"/>',
  "ins-frame-ellipse": '<ellipse cx="12" cy="12" rx="8.5" ry="7.5"/>',
  "ins-outline": '<circle cx="12" cy="12" r="9" stroke-dasharray="3 2.6"/><circle cx="12" cy="12" r="4.5" fill="currentColor"/>',
  "ins-stroke": '<path d="M4.5 20 10.5 4h3l6 16h-3.2l-1.4-4H9.1l-1.4 4Z"/><path d="M10.2 13h3.6L12 7.8Z"/>',
  "align-center": '<path d="M12 3v4"/><path d="M12 17v4"/><path d="M3 12h4"/><path d="M17 12h4"/><rect x="8" y="8" width="8" height="8" rx="1.5"/>',
};

let iconsReady = false;
export function ensureIcons() {
  if (iconsReady) return;
  iconsReady = true;
  const missing = {};
  for (const [k, v] of Object.entries(FALLBACK_ICONS)) if (!hasIcon(k)) missing[k] = v;
  registerIcons(missing);
}

// The icon a command declares (when the shell drew it), else ours.
function cmdIcon(ctx, id, fallback) {
  const name = ctx.commands?.get?.(id)?.icon;
  return name && hasIcon(name) ? name : fallback;
}

function setIcon(btn, name, size = "sm") {
  const old = btn.querySelector("svg.i");
  const next = icon(name, { size });
  if (old) old.replaceWith(next);
  else btn.prepend(next);
}

// ---- pure helpers (tested in tests/inspector-logic.test.js) -------------------------

export function sameValue(a, b) {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-6;
  return deepEqual(a, b);
}

// { value, mixed } for a getter over several layers.
export function readMixed(layers, get) {
  if (!layers?.length) return { value: undefined, mixed: false };
  const v = get(layers[0]);
  for (let i = 1; i < layers.length; i++) if (!sameValue(get(layers[i]), v)) return { value: v, mixed: true };
  return { value: v, mixed: false };
}

// Shadow offset <-> distance and direction (degrees, 90 = straight down).
export function shadowPolar(shadow, fallbackAngle = 90) {
  const dx = Number(shadow?.dx) || 0;
  const dy = Number(shadow?.dy) || 0;
  const distance = Math.hypot(dx, dy);
  const angle = distance < 0.01 ? fallbackAngle : Math.atan2(dy, dx) / RAD;
  return { distance: round(distance, 1), angle: round(angle, 1) };
}

export function polarToShadow(distance, angle) {
  const d = Math.max(0, Number(distance) || 0);
  const a = (Number(angle) || 0) * RAD;
  const fix = (v) => (Math.abs(v) < 0.05 ? 0 : round(v, 1));
  return { dx: fix(d * Math.cos(a)), dy: fix(d * Math.sin(a)) };
}

const WEIGHT_NAMES = { 100: "Thin", 200: "Extra light", 300: "Light", 400: "Regular", 500: "Medium", 600: "Semibold", 700: "Bold", 800: "Extra bold", 900: "Black", 950: "Extra black" };

export function weightName(w) {
  const n = Math.round(Number(w) || 400);
  return WEIGHT_NAMES[n] || String(n);
}

// Props for switching text layers to another family. Keeps a weight the
// family has; a layer still on its old family's default weight takes the new
// family's default (Rubik opens at Black, Poppins at Extra bold).
export function fontSwitchProps(fonts, layer, family) {
  const next = fonts?.get?.(family) || null;
  const prev = fonts?.get?.(layer.font) || null;
  let weight = layer.weight;
  if (next) {
    const onDefault = !prev || layer.weight === prev.defaultWeight;
    if (onDefault && Number.isFinite(next.defaultWeight)) weight = next.defaultWeight;
    else if (typeof fonts.nearestWeight === "function") weight = fonts.nearestWeight(family, layer.weight);
  }
  return { font: family, weight, italic: !!layer.italic && (!next || !!next.italic) };
}

// A layer that covers the whole canvas (a backdrop photo or color block).
export function isBackdrop(layer, width, height, tol = 0.01) {
  if (!layer || (layer.type !== "image" && layer.type !== "shape") || layer.rotation) return false;
  const ex = width * tol;
  const ey = height * tol;
  return layer.x - layer.w / 2 <= ex && layer.y - layer.h / 2 <= ey && layer.x + layer.w / 2 >= width - ex && layer.y + layer.h / 2 >= height - ey;
}

// Scales a layer's size and size-like props by k (in place).
export function scaleLayer(l, k) {
  const s = (v) => round(v * k, 2);
  l.w = Math.max(1, s(l.w));
  l.h = Math.max(1, s(l.h));
  if (l.shadow) Object.assign(l.shadow, { blur: s(l.shadow.blur), dx: s(l.shadow.dx), dy: s(l.shadow.dy) });
  if (l.glow) l.glow.size = s(l.glow.size);
  switch (l.type) {
    case "text":
      l.size = s(l.size);
      l.stroke.width = s(l.stroke.width);
      l.stroke2.width = s(l.stroke2.width);
      Object.assign(l.bg, { padX: s(l.bg.padX), padY: s(l.bg.padY), radius: s(l.bg.radius) });
      break;
    case "image":
      l.radius = s(l.radius);
      l.outline.width = s(l.outline.width);
      break;
    case "shape":
      l.radius = s(l.radius);
      l.stroke.width = s(l.stroke.width);
      break;
    case "path":
    case "arrow":
      l.width = s(l.width);
      break;
  }
  return l;
}

// Resizes a doc in place. "scale": layers scale to fit the new size around
// the center (backdrops cover it); "keep": layers keep their size and their
// offset from the center.
export function resizeDocContent(doc, width, height, mode = "keep", preset) {
  const w0 = doc.width;
  const h0 = doc.height;
  doc.width = width;
  doc.height = height;
  if (preset !== undefined) doc.preset = preset;
  if (mode === "scale") {
    const fit = Math.min(width / w0, height / h0);
    const cover = Math.max(width / w0, height / h0);
    for (const l of doc.layers) {
      const k = isBackdrop(l, w0, h0) ? cover : fit;
      l.x = round(width / 2 + (l.x - w0 / 2) * k, 2);
      l.y = round(height / 2 + (l.y - h0 / 2) * k, 2);
      scaleLayer(l, k);
    }
  } else {
    const dx = (width - w0) / 2;
    const dy = (height - h0) / 2;
    for (const l of doc.layers) {
      l.x = round(l.x + dx, 2);
      l.y = round(l.y + dy, 2);
    }
  }
  return doc;
}

// Filters list edits for image layers.
export function setFilter(list, id, on, params) {
  const cur = Array.isArray(list) ? list : [];
  const has = cur.some((f) => f.id === id);
  if (!on) return cur.filter((f) => f.id !== id);
  if (!has) return [...cur, { id, params: { ...(params || {}) } }];
  return cur.map((f) => (f.id === id ? { id, params: { ...f.params, ...(params || {}) } } : f));
}

// ---- background removal jobs ------------------------------------------------------------

const jobs = new Map(); // layerId -> { phase, progress, message }
const tracked = new WeakSet();

// One listener per app that keeps the job table current for the inspector and
// the quick bar. Returns the job for a layer.
export function trackBgJobs(ctx) {
  if (tracked.has(ctx)) return;
  tracked.add(ctx);
  ctx.on("bg-progress", (d) => {
    if (!d?.layerId) return;
    if (d.phase === "done" || d.phase === "error") jobs.delete(d.layerId);
    else jobs.set(d.layerId, { phase: d.phase, progress: Number(d.progress) || 0, message: d.message || "" });
  });
}

export function bgJob(ctx, layerId) {
  if (!layerId) return null;
  const j = jobs.get(layerId);
  if (j) return j;
  return ctx.bg?.isRunning?.(layerId) ? { phase: "run", progress: 0, message: "" } : null;
}

// The engine's own message ("Downloading · 12 of 44 MB") when it sends one.
export function jobText(job) {
  if (!job) return "";
  if (job.message) return job.message;
  const pct = job.progress > 0 && job.progress < 1 ? ` ${Math.round(job.progress * 100)}%` : "";
  return job.phase === "download" ? `Downloading the model${pct}` : "Removing background";
}

export function progressRing() {
  const C = 2 * Math.PI * 9;
  const arc = svg("circle", { cx: 12, cy: 12, r: 9, class: "ring-arc", "stroke-dasharray": C.toFixed(2), "stroke-dashoffset": (C * 0.72).toFixed(2) });
  const el = svg("svg", { viewBox: "0 0 24 24", class: "insp-ring spin", "aria-hidden": "true" }, svg("circle", { cx: 12, cy: 12, r: 9, class: "ring-track" }), arc);
  el.set = (p) => {
    const known = p > 0.001 && p < 1;
    el.classList.toggle("spin", !known);
    arc.setAttribute("stroke-dashoffset", (C * (known ? 1 - p : 0.72)).toFixed(2));
  };
  return el;
}

function providerShort(label) {
  return String(label || "").replace(/\s*\(.*\)\s*$/, "") || "Model";
}

function downloadMessage(info) {
  if (!info) return "Background removal runs on this computer; your image is never uploaded.";
  if (info.kind === "local" || info.id === "magic") return "Magic works best on flat color backgrounds and screenshots. Nothing to download, and it runs on this computer.";
  if (info.cached) return `${providerShort(info.label)} is ready. It runs on this computer; your image is never uploaded.`;
  const mb = info.downloadMB || info.sizeMB || 0;
  return `Background removal downloads a ${mb} MB model once. It runs on this computer; your image is never uploaded.`;
}

// Choice of model before the first download. Resolves with a provider id or null.
async function chooseProvider(ctx, preferred) {
  const bg = ctx.bg;
  const provs = bg.providers?.list?.() || [];
  if (!provs.length) return null;
  const infos = new Map(await Promise.all(provs.map(async (p) => [p.id, await bg.modelInfo(p.id).catch(() => null)])));
  let choice = provs.some((p) => p.id === preferred) ? preferred : bg.defaultProvider || provs[0].id;
  const remember = (id) => {
    if (typeof bg.setDefaultProvider === "function") bg.setDefaultProvider(id);
    else ctx.prefs?.set?.("bgProvider", id);
  };
  if (typeof ctx.ui?.dialog !== "function") {
    const msg = downloadMessage(infos.get(choice));
    const ok = typeof ctx.ui?.confirm === "function"
      ? await ctx.ui.confirm({ title: "Remove background", message: msg, ok: "Remove background", cancel: "Not now" })
      : window.confirm(msg);
    if (ok) remember(choice);
    return ok ? choice : null;
  }
  return new Promise((resolve) => {
    let done = false;
    let dlg = null;
    const msg = h("p", { class: "insp-dlg-msg" });
    const note = h("p", { class: "insp-dlg-note" });
    const paint = () => {
      const info = infos.get(choice);
      msg.textContent = downloadMessage(info);
      note.textContent = [info?.note, info?.license && `License: ${info.license}`].filter(Boolean).join("  ·  ");
    };
    const seg = segmented({
      options: provs.map((p) => ({ value: p.id, label: providerShort(p.label), tip: p.note || null })),
      value: choice,
      full: true,
      onChange: (v) => {
        choice = v;
        paint();
      },
    });
    paint();
    const finish = (v) => {
      if (done) return;
      done = true;
      if (v) remember(v);
      try {
        dlg?.close?.();
      } catch {}
      resolve(v);
    };
    dlg = ctx.ui.dialog({
      title: "Remove background",
      body: h("div", { class: "insp-dlg" }, msg, h("div", { class: "insp-dlg-field" }, h("span", { class: "micro" }, "Model"), seg), note),
      actions: [
        { label: "Not now", run: () => finish(null) },
        { label: "Remove background", kind: "primary", run: () => finish(choice) },
      ],
      onClose: () => setTimeout(() => finish(null), 0),
    });
  });
}

// The whole flow for one or more image layers: consent before a download,
// then one layer at a time. Cancelling is quiet; errors become a toast.
export async function removeBackground(ctx, ids, { provider } = {}) {
  const bg = ctx.bg;
  if (!bg) {
    ctx.ui?.toast?.("Background removal is not available here.", { kind: "error" });
    return false;
  }
  const layers = (ids || []).map((id) => ctx.store.get(id)).filter((l) => l?.type === "image");
  if (!layers.length) return false;
  let pid = provider || bg.defaultProvider;
  const info = await bg.modelInfo(pid).catch(() => null);
  if (!info || !info.cached) {
    pid = await chooseProvider(ctx, pid);
    if (!pid) return false;
  }
  for (const l of layers) {
    try {
      await bg.removeLayerBackground(l.id, { provider: pid });
    } catch (err) {
      if (err?.code !== "cancelled" && err?.name !== "AbortError") ctx.ui?.toast?.(err?.message || "The background could not be removed.", { kind: "error" });
      return false;
    }
  }
  return true;
}

function restoreImages(ctx, ids) {
  const list = ids.filter((id) => ctx.store.get(id)?.type === "image" && ctx.store.get(id).mask);
  if (!list.length) return false;
  if (list.length === 1 && ctx.bg?.restoreLayer) return ctx.bg.restoreLayer(list[0]);
  for (const id of list) ctx.bg?.cancel?.(id);
  // The boxes fitted to the cutouts go back too.
  return ctx.store.patch(list, (l) => ({ mask: null, ...(ctx.bg?.untrimProps?.(l.id) || {}) }), { label: "Restore original" });
}

// Edge refinement: grow/shrink and soften are applied to the mask the cutout
// started from, so dragging back to 0 gives the original edge again.
const edgeDerived = new Map(); // maskId -> { base, soften, grow }
const edgeSeq = new Map();

export function edgeState(layer) {
  const d = layer?.mask ? edgeDerived.get(layer.mask) : null;
  return d ? { ...d } : { base: layer?.mask || null, soften: 0, grow: 0 };
}

async function applyEdge(ctx, layerId, next) {
  const layer = ctx.store.get(layerId);
  const masks = ctx.bg?.masks;
  if (!layer?.mask || !masks) return;
  const st = edgeState(layer);
  const soften = next.soften ?? st.soften;
  const grow = next.grow ?? st.grow;
  const seq = (edgeSeq.get(layerId) || 0) + 1;
  edgeSeq.set(layerId, seq);
  let maskId = st.base;
  let m = null;
  if (soften || grow) {
    const base = await ctx.assets.loadImage(st.base);
    // Slider values are in doc px; masks are in natural image px.
    const k = (layer.natW * (layer.crop?.w || 1)) / Math.max(1, layer.w);
    m = base;
    if (grow) m = masks.growMask(m, Math.round(grow * k) || Math.sign(grow));
    if (soften) m = masks.featherMask(m, Math.max(1, Math.round(soften * k)));
    maskId = await ctx.assets.addCanvas(m, { type: "image/png" });
    edgeDerived.set(maskId, { base: st.base, soften, grow });
  }
  // Grow can reach past the box fitted to the cutout: fit the box again.
  let fit = null;
  if (typeof ctx.bg?.cutoutProps === "function") {
    try {
      const src = m || ctx.assets.getImage?.(maskId) || (await ctx.assets.loadImage(maskId));
      if (edgeSeq.get(layerId) !== seq || ctx.store.get(layerId)?.mask !== layer.mask) return;
      fit = ctx.bg.cutoutProps(layerId, src);
    } catch (err) {
      console.warn(err);
    }
  }
  if (edgeSeq.get(layerId) !== seq) return;
  const now = ctx.store.get(layerId);
  if (!now || now.mask !== layer.mask || maskId === now.mask) return;
  ctx.store.patch(layerId, { mask: maskId, ...(fit || {}) }, { label: "Cutout edge" });
}

// ---- font flow (shared with the quick bar) -------------------------------------------

// Opens the font picker for the text layers in getIds(): hovering previews on
// the canvas (one transient gesture), leaving restores, a click commits.
export function openFontPickerFor(ctx, anchor, getIds, { placement, onClose } = {}) {
  const store = ctx.store;
  const textIds = () => getIds().filter((id) => store.get(id)?.type === "text");
  const ids = textIds();
  if (!ids.length) return null;
  const first = store.get(ids[0]);
  let previewing = false;
  const props = (fam) => (l) => fontSwitchProps(ctx.fonts, l, fam);
  const ensureLoaded = (fam) => {
    if (!ctx.fonts?.load) return;
    const wants = textIds().map((id) => store.get(id)).filter(Boolean);
    Promise.all(wants.map((l) => ctx.fonts.load(fam, l.weight, l.italic ? "italic" : "normal", { retry: true }).catch(() => false))).then(() => {
      const now = textIds().filter((id) => store.get(id)?.font === fam);
      if (now.length) store.remeasure(now);
      ctx.editor?.requestRender?.();
    });
  };
  const cancel = () => {
    if (!previewing) return;
    previewing = false;
    if (store.inGesture) store.cancel();
  };
  return openFontPicker(anchor, {
    ctx,
    placement,
    value: first.font,
    weight: first.weight,
    onPreview(fam) {
      if (!previewing || !store.inGesture) {
        store.begin("Font");
        previewing = true;
      }
      store.patch(textIds(), props(fam));
      ensureLoaded(fam);
    },
    onPreviewEnd: cancel,
    onChange(fam) {
      if (previewing && store.inGesture) {
        store.patch(textIds(), props(fam));
        previewing = false;
        store.commit();
      } else {
        previewing = false;
        store.patch(textIds(), props(fam), { label: "Font" });
      }
      ensureLoaded(fam);
    },
    onClose() {
      cancel();
      onClose?.();
    },
  });
}

// ---- the panel binder --------------------------------------------------------------

function markMixed(ctl, mixed) {
  ctl.classList.toggle("mixed", !!mixed);
  const input = ctl.querySelector?.(".ctl-num-input");
  if (!input) return;
  input.placeholder = mixed ? "Mixed" : "";
  if (mixed && document.activeElement !== input) input.value = "";
}

// One popover per trigger: a click opens it, the next click closes it. The
// shell's popover returns a closed handle when the same click just closed it.
function popoverToggle(open) {
  let handle = null;
  return {
    toggle(...args) {
      if (handle) {
        handle.close();
        return;
      }
      handle = open(...args, () => {
        handle = null;
      });
      if (handle?.closed) handle = null;
    },
    close: () => handle?.close(),
  };
}

// Binds controls to the selected layers (or to the document with { doc: true }).
// Updaters run on every store change; cleanups run when the panel is replaced.
export class Panel {
  constructor(ctx, ids, { doc = false } = {}) {
    this.ctx = ctx;
    this.ids = ids.slice();
    this.isDoc = doc;
    this.updaters = [];
    this.cleanups = [];
    this.lives = new Set(); // end() of every open live gesture, shared with child panels
  }

  get store() {
    return this.ctx.store;
  }

  layers() {
    if (this.isDoc) return [this.store.doc];
    const out = [];
    for (const id of this.ids) {
      const l = this.store.get(id);
      if (l) out.push(l);
    }
    return out;
  }

  read(get) {
    return readMixed(this.layers(), get);
  }

  every(get) {
    const ls = this.layers();
    return ls.length > 0 && ls.every((l) => !!get(l));
  }

  onUpdate(fn) {
    this.updaters.push(fn);
    return fn;
  }

  onCleanup(fn) {
    this.cleanups.push(fn);
    return fn;
  }

  update() {
    for (const fn of this.updaters.slice()) {
      try {
        fn();
      } catch (err) {
        console.error(err);
      }
    }
  }

  destroy() {
    for (const fn of this.cleanups.splice(0)) {
      try {
        fn();
      } catch (err) {
        console.error(err);
      }
    }
    this.updaters.length = 0;
  }

  child() {
    const c = new Panel(this.ctx, this.ids, { doc: this.isDoc });
    c.hook = this.hook;
    c.lives = this.lives;
    return c;
  }

  // Closes every live gesture this panel (and its children) has open. The
  // owner calls it when a press lands elsewhere, so a field's arrow-key or
  // typed edit records as its own step before the canvas opens a gesture.
  flush() {
    for (const end of [...this.lives].reverse()) end();
  }

  applyPatch(fn, opts = {}) {
    if (this.isDoc) {
      const props = fn(this.store.doc);
      return props ? this.store.setDocProps(props, opts) : false;
    }
    return this.store.patch(this.ids, fn, opts);
  }

  patch(fn, label) {
    return this.applyPatch(fn, { label });
  }

  // First input opens a gesture, change commits it (one undo step).
  // The gesture is owned: end() commits it only while it is on top of the
  // store's stack, so a late focusout never pops someone else's gesture (the
  // editor's Resize, say). If one opened above it, it closes once that is gone.
  live(label, apply) {
    const store = this.store;
    const lives = this.lives;
    let open = false;
    let mine = null; // our entry on the store's gesture stack
    const stack = () => (Array.isArray(store._gestures) ? store._gestures : null);
    const alive = () => {
      const s = stack();
      return s && mine ? s.includes(mine) : store.inGesture;
    };
    const ensure = () => {
      if (!open || !alive()) {
        store.begin(label);
        mine = stack()?.at(-1) || null;
        open = true;
        lives.add(end);
      }
    };
    const closeWhenTop = (g) => {
      const s = stack();
      const i = s ? s.indexOf(g) : -1;
      if (i < 0) return;
      if (i === s.length - 1) store.commit();
      else setTimeout(() => closeWhenTop(g), 50);
    };
    function end() {
      lives.delete(end);
      if (!open) return;
      open = false;
      const g = mine;
      mine = null;
      if (!stack() || !g) {
        if (store.inGesture) store.commit();
        return;
      }
      closeWhenTop(g);
    }
    this.cleanups.push(end);
    return {
      input: (v) => {
        ensure();
        apply(v, {});
      },
      change: (v) => {
        if (open) {
          apply(v, {});
          end();
        } else {
          apply(v, { label });
        }
      },
      end,
    };
  }

  patcher(label, set) {
    return this.live(label, (v, opts) => this.applyPatch((l) => set(v, l), opts));
  }

  bindValue(ctl, o, pt) {
    const upd = () => {
      const r = o.read ? o.read() : this.read(o.get);
      if (r && r.value !== undefined && r.value !== null && !(typeof r.value === "number" && !Number.isFinite(r.value))) ctl.set(r.value);
      markMixed(ctl, r?.mixed);
      if (o.disabled) ctl.setDisabled(!!o.disabled());
    };
    upd();
    this.onUpdate(upd);
    ctl.addEventListener("focusout", () =>
      setTimeout(() => {
        pt?.end();
        upd();
      }, 0)
    );
    if (o.field) ctl.dataset.field = o.field;
    return ctl;
  }

  // Compact numeric field; the label (or icon) scrubs.
  num(label, o) {
    const pt = o.apply ? this.live(o.undo || label || o.tip, o.apply) : this.patcher(o.undo || label || o.tip, o.set);
    const ctl = number({
      label,
      icon: o.icon,
      tip: o.tip,
      value: 0,
      min: o.min ?? -1e6,
      max: o.max ?? 1e6,
      step: o.step ?? 1,
      unit: o.unit || "",
      decimals: o.decimals,
      width: o.width,
      onInput: o.live === false ? null : pt.input,
      onChange: pt.change,
    });
    return this.bindValue(ctl, o, pt);
  }

  // Slider with a value field; double-click the label to reset.
  range(label, o) {
    const pt = o.apply ? this.live(o.undo || label, o.apply) : this.patcher(o.undo || label, o.set);
    const ctl = slider({
      label,
      min: o.min ?? 0,
      max: o.max ?? 100,
      step: o.step ?? 1,
      value: o.min ?? 0,
      unit: o.unit || "",
      decimals: o.decimals,
      defaultValue: o.def,
      tip: o.tip,
      onInput: pt.input,
      onChange: pt.change,
    });
    return this.bindValue(ctl, o, pt);
  }

  // Opens the color picker for a getter/setter pair. o.initial(l) is where
  // it starts when get() reads nothing (a paint that is off).
  // hook(open) tells the owner (the quick bar) a popover opened or closed.
  pickerFor(anchor, o, pt, done) {
    const r = this.read(o.get);
    const hook = this.hook;
    hook?.(true);
    const handle = openColorPicker(anchor, {
      ctx: this.ctx,
      value: r.value || (o.initial ? this.read(o.initial).value : null) || "#ffffff",
      alpha: o.alpha !== false,
      placement: typeof o.placement === "function" ? o.placement() : o.placement,
      title: o.tip,
      onInput: (v) => pt.input(v),
      onChange: (v) => pt.change(v),
      onClose: () => {
        pt.end();
        hook?.(false);
        done?.();
      },
    });
    if (!handle || handle.closed) hook?.(false);
    return handle;
  }

  // A swatch alone (quick bar) or a swatch with a hex field.
  swatchButton(o) {
    const pt = this.patcher(o.undo || o.tip || "Color", o.set);
    const pop = popoverToggle((done) => this.pickerFor(sw, o, pt, done));
    const sw = swatch({ value: "#ffffff", tip: o.tip || "Color", size: o.size, onClick: () => pop.toggle() });
    this.onCleanup(() => pop.close());
    const upd = () => {
      const r = this.read(o.get);
      sw.set(r.value || null);
      sw.classList.toggle("mixed", !!r.mixed);
    };
    upd();
    this.onUpdate(upd);
    sw.pt = pt;
    return sw;
  }

  color(o) {
    const sw = this.swatchButton(o);
    const pt = sw.pt;
    const alpha = o.alpha !== false;
    const input = h("input", { type: "text", class: "insp-hex num", spellcheck: "false", autocomplete: "off", maxlength: 9, "aria-label": `${o.tip || "Color"} hex` });
    const show = () => {
      if (document.activeElement === input) return;
      const r = this.read(o.get);
      input.value = r.mixed ? "" : String(r.value || "").replace(/^#/, "").toUpperCase();
      input.placeholder = r.mixed ? "Mixed" : "";
    };
    const commit = () => {
      const n = normalizeHex(input.value, { alpha });
      const r = this.read(o.get);
      if (n && (r.mixed || n !== normalizeHex(r.value || "", { alpha }))) pt.change(n);
      show();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        input.value = "";
        input.dataset.cancel = "1";
        input.blur();
      }
    });
    input.addEventListener("focus", () => requestAnimationFrame(() => input.select()));
    input.addEventListener("blur", () => {
      if (input.dataset.cancel) {
        delete input.dataset.cancel;
        show();
        return;
      }
      commit();
    });
    show();
    this.onUpdate(show);
    return h("div", { class: "insp-color" }, sw, h("label", { class: "insp-hexfield" }, h("span", { class: "insp-hash" }, "#"), input), o.after || null);
  }

  // Two color stops on a gradient bar plus an angle field.
  gradient(o) {
    const from = this.swatchButton({ get: o.from.get, set: o.from.set, tip: "Start color", undo: o.undo || "Gradient", alpha: o.alpha });
    const to = this.swatchButton({ get: o.to.get, set: o.to.set, tip: "End color", undo: o.undo || "Gradient", alpha: o.alpha });
    const bar = h("button", { type: "button", class: "insp-grad-bar", "data-tip": "Swap colors", "aria-label": "Swap colors" }, icon("arrow-right-left", { size: "sm" }));
    bar.addEventListener("click", () => this.patch(o.swap, "Swap gradient colors"));
    const paint = () => {
      const ls = this.layers();
      if (!ls.length) return;
      bar.style.setProperty("--from", o.from.get(ls[0]) || "#000000");
      bar.style.setProperty("--to", o.to.get(ls[0]) || "#000000");
    };
    paint();
    this.onUpdate(paint);
    const angle = this.num("", {
      icon: "rotate",
      tip: "Gradient angle",
      undo: "Gradient angle",
      get: (l) => ((Math.round(o.angle.get(l)) % 360) + 360) % 360,
      set: (v) => o.angle.set(v),
      min: 0,
      max: 360,
      step: 1,
      unit: "°",
      width: 82,
    });
    return h("div", { class: "insp-grad" }, from, bar, to, angle);
  }

  seg(o) {
    const ctl = segmented({
      options: o.options,
      value: null,
      size: o.size,
      full: o.full,
      onChange: (v) => (o.apply ? o.apply(v) : this.patch((l) => o.set(v, l), o.undo)),
    });
    const upd = () => {
      const r = o.read ? o.read() : this.read(o.get);
      ctl.set(r.mixed ? null : r.value);
    };
    upd();
    this.onUpdate(upd);
    return ctl;
  }

  choice(o) {
    const opts = [{ value: "", label: "Mixed" }, ...o.options];
    const ctl = select({ options: opts, value: "", tip: o.tip, onChange: (v) => v !== "" && this.patch((l) => o.set(v, l), o.undo) });
    ctl.options[0].hidden = true;
    const upd = () => {
      const r = this.read(o.get);
      ctl.value = r.mixed ? "" : String(r.value);
    };
    upd();
    this.onUpdate(upd);
    return ctl;
  }

  toggleRow(label, o) {
    const ctl = toggle({ label, value: false, tip: o.tip, onChange: (b) => this.patch((l) => o.set(b, l), o.undo || label) });
    const upd = () => ctl.set(this.every(o.get));
    upd();
    this.onUpdate(upd);
    return ctl;
  }

  iconToggle(o) {
    const btn = iconButton({ icon: o.icon, tip: o.tip, kbd: o.kbd, size: o.size || "sm", active: false });
    btn.addEventListener("click", () => {
      if (o.run) return o.run();
      const next = !this.every(o.get);
      this.patch((l) => o.set(next, l), o.undo || o.tip);
    });
    const upd = () => {
      const all = this.every(o.get);
      btn.setActive(all);
      btn.classList.toggle("mixed", !all && this.layers().some((l) => !!o.get(l)));
      if (o.icons) setIcon(btn, all ? o.icons[1] : o.icons[0]);
      if (o.tips) {
        const t = all ? o.tips[1] : o.tips[0];
        btn.dataset.tip = t;
        btn.setAttribute("aria-label", t);
      }
    };
    upd();
    this.onUpdate(upd);
    return btn;
  }

  cmd(id, { icon: fallback, tip, label, kind, wide, big, enabled } = {}) {
    const ctx = this.ctx;
    const c = ctx.commands?.get?.(id);
    const kbd = ctx.commands?.keysLabel?.(id) || undefined;
    const name = cmdIcon(ctx, id, fallback);
    const el = label
      ? button({ label, icon: name, kind, wide, big, tip: tip || c?.title, kbd, onClick: () => ctx.commands.run(id) })
      : iconButton({ icon: name, tip: tip || c?.title || id, kbd, size: "sm", onClick: () => ctx.commands.run(id) });
    const upd = () => {
      const ok = !!ctx.commands?.get?.(id) && ctx.commands.enabled?.(id) !== false && (enabled ? enabled() : true);
      el.disabled = !ok;
    };
    upd();
    this.onUpdate(upd);
    return el;
  }

  // A block re-rendered (with its own child panel) when key() changes.
  dyn(key, render) {
    const host = h("div", { class: "insp-dyn" });
    let k;
    let sub = null;
    const run = () => {
      const next = key();
      if (next === k && sub) {
        sub.update();
        return;
      }
      k = next;
      sub?.destroy();
      sub = this.child();
      const out = render(sub, next);
      host.replaceChildren(...[out].flat(Infinity).filter(Boolean));
    };
    run();
    this.onUpdate(run);
    this.onCleanup(() => sub?.destroy());
    return host;
  }

  // Inspector section; toggle: { get, set } puts an on/off switch in the header.
  section(id, title, o = {}) {
    const remembered = openState.get(id);
    let tg;
    if (o.toggle) {
      tg = {
        value: this.every(o.toggle.get),
        tip: o.toggle.tip,
        onChange: (b) => this.patch((l) => o.toggle.set(b, l), o.toggle.undo || title),
      };
    }
    const s = section({ title, id, open: remembered ?? o.open ?? true, toggle: tg, actions: o.actions || [] });
    if (o.toggle) this.onUpdate(() => s.setOn(this.every(o.toggle.get)));
    s.head.querySelector(".sec-title")?.addEventListener("click", () => openState.set(id, !s.el.classList.contains("closed")));
    s.el.classList.add("insp-sec");
    return s;
  }
}

const openState = new Map(); // section id -> open (for this session)
const aspectLocks = new Map(); // layer id -> bool
const shadowAngles = new Map(); // layer id -> last direction while the distance is 0
const lastBackground = { color: "#0b0c0b", gradient: { from: "#1b1f22", to: "#0b0c0b", angle: 135 } };

const sec = (s, order) => ({ el: s.el, order });

// ---- shared controls --------------------------------------------------------------

export function fontButton(p, { compact = false, placement } = {}) {
  const ctx = p.ctx;
  const name = h("span", { class: "insp-font-name" });
  const btn = h(
    "button",
    { type: "button", class: ["insp-font", compact && "compact"], "data-tip": "Font", "aria-label": "Font", "aria-haspopup": "dialog" },
    name,
    icon("chevron-down", { size: "sm", class: "insp-font-chev" })
  );
  const pop = popoverToggle((done) => {
    const hook = p.hook;
    hook?.(true);
    const handle = openFontPickerFor(ctx, btn, () => p.ids, {
      placement: typeof placement === "function" ? placement() : placement,
      onClose: () => {
        hook?.(false);
        done();
      },
    });
    if (!handle || handle.closed) hook?.(false);
    return handle;
  });
  btn.addEventListener("click", () => pop.toggle());
  p.onCleanup(() => pop.close());
  let applied = "";
  const upd = () => {
    const r = p.read((l) => l.font);
    if (r.mixed || !r.value) {
      name.textContent = r.mixed ? "Mixed" : "Font";
      name.style.fontFamily = "";
      applied = "";
      return;
    }
    const fam = r.value;
    const first = p.layers()[0];
    const info = ctx.fonts?.get?.(fam);
    name.textContent = info?.label || fam;
    const key = `${fam}|${first.weight}|${first.italic}`;
    if (applied === key) return;
    const face = () => {
      applied = key;
      name.style.fontFamily = ctx.fonts?.stack?.(fam) || `"${fam}"`;
      name.style.fontWeight = String(first.weight || 400);
      name.style.fontStyle = first.italic ? "italic" : "normal";
    };
    if (!ctx.fonts?.load || info?.source === "system" || ctx.fonts.loaded?.(fam, first.weight, first.italic ? "italic" : "normal")) face();
    else ctx.fonts.load(fam, first.weight, first.italic ? "italic" : "normal").then((ok) => ok && p.read((l) => l.font).value === fam && face());
  };
  upd();
  p.onUpdate(upd);
  return btn;
}

function note(text) {
  return h("p", { class: "insp-note" }, text);
}

function grid2(...children) {
  return h("div", { class: "insp-grid2" }, children);
}

function toolbar(...children) {
  return h("div", { class: "insp-tools" }, children);
}

function divider() {
  return h("span", { class: "insp-tools-div", "aria-hidden": "true" });
}

// ---- text -----------------------------------------------------------------------------

function textSections(p) {
  const ctx = p.ctx;
  const out = [];
  const fontInfo = () => {
    const r = p.read((l) => l.font);
    return r.mixed ? null : ctx.fonts?.get?.(r.value) || null;
  };

  const main = p.section("text", "Text");
  const size = p.num("Size", { get: (l) => l.size, set: (v) => ({ size: v }), min: 8, max: 1000, step: 1, tip: "Font size", undo: "Font size" });
  const align = p.seg({
    options: [
      { value: "left", icon: "text-align-left", label: "Align left" },
      { value: "center", icon: "text-align-center", label: "Center" },
      { value: "right", icon: "text-align-right", label: "Align right" },
    ],
    get: (l) => l.align,
    set: (v) => ({ align: v }),
    undo: "Text alignment",
  });
  const italic = p.dyn(
    () => (fontInfo()?.italic || p.layers().some((l) => l.italic) ? "y" : "n"),
    (sp, k) => (k === "y" ? sp.iconToggle({ icon: "italic", tip: "Italic", get: (l) => l.italic, set: (b) => ({ italic: b }), undo: "Italic" }) : null)
  );
  const upper = p.iconToggle({ icon: "case-upper", tip: "Uppercase", get: (l) => l.uppercase, set: (b) => ({ uppercase: b }), undo: "Uppercase" });
  const weight = p.dyn(
    () => {
      const info = fontInfo();
      if (!info) return "none";
      return info.variable ? `v${info.variable.min}-${info.variable.max}` : info.weights.length > 1 ? `s${info.weights.join(",")}` : "none";
    },
    (sp, k) => {
      const info = fontInfo();
      if (k === "none" || !info) return null;
      const load = (w) => {
        for (const l of sp.layers()) ctx.fonts?.load?.(l.font, w, l.italic ? "italic" : "normal");
      };
      if (info.variable) {
        const min = Math.max(100, info.variable.min);
        const max = Math.min(900, info.variable.max);
        return sp.range("Weight", {
          get: (l) => clamp(l.weight, min, max),
          set: (v) => {
            load(v);
            return { weight: v };
          },
          min,
          max,
          step: 50,
          undo: "Font weight",
          def: clamp(info.defaultWeight || 400, min, max),
        });
      }
      return field(
        "Weight",
        sp.choice({
          options: info.weights.map((w) => ({ value: String(w), label: `${weightName(w)}  ${w}` })),
          get: (l) => l.weight,
          set: (v) => {
            load(Number(v));
            return { weight: Number(v) };
          },
          undo: "Font weight",
          tip: "Font weight",
        })
      );
    }
  );
  main.body.append(fontButton(p), h("div", { class: "insp-text-row" }, size, align, italic, upper), weight);
  out.push(sec(main, 10));

  const color = p.section("text-color", "Color");
  color.body.append(
    p.seg({
      options: [
        { value: "solid", label: "Solid" },
        { value: "gradient", label: "Gradient" },
      ],
      get: (l) => (l.gradient.on ? "gradient" : "solid"),
      set: (v) => ({ gradient: { on: v === "gradient" } }),
      undo: "Text fill",
      full: true,
      size: "sm",
    }),
    p.dyn(
      () => (p.read((l) => l.gradient.on).value ? "g" : "s"),
      (sp, k) =>
        k === "s"
          ? sp.color({ get: (l) => l.color, set: (v) => ({ color: v }), tip: "Text color", undo: "Text color" })
          : sp.gradient({
              from: { get: (l) => l.gradient.from, set: (v) => ({ gradient: { from: v } }) },
              to: { get: (l) => l.gradient.to, set: (v) => ({ gradient: { to: v } }) },
              angle: { get: (l) => l.gradient.angle, set: (v) => ({ gradient: { angle: v } }) },
              swap: (l) => ({ gradient: { from: l.gradient.to, to: l.gradient.from } }),
              undo: "Text gradient",
            })
    )
  );
  out.push(sec(color, 11));

  const stroke = p.section("text-stroke", "Stroke", { toggle: { get: (l) => l.stroke.on, set: (b) => ({ stroke: { on: b } }), undo: "Text stroke" } });
  stroke.body.append(
    p.color({ get: (l) => l.stroke.color, set: (v) => ({ stroke: { color: v } }), tip: "Stroke color", undo: "Stroke color" }),
    p.range("Width", { get: (l) => l.stroke.width, set: (v) => ({ stroke: { width: v } }), min: 0, max: 60, step: 1, unit: " px", undo: "Stroke width", def: 10 })
  );
  out.push(sec(stroke, 12));

  const stroke2 = p.section("text-stroke2", "Outline 2", { open: false, toggle: { get: (l) => l.stroke2.on, set: (b) => ({ stroke2: { on: b } }), undo: "Second outline" } });
  stroke2.body.append(
    p.color({ get: (l) => l.stroke2.color, set: (v) => ({ stroke2: { color: v } }), tip: "Outline color", undo: "Outline color" }),
    p.range("Width", { get: (l) => l.stroke2.width, set: (v) => ({ stroke2: { width: v } }), min: 0, max: 60, step: 1, unit: " px", undo: "Outline width", def: 10 })
  );
  out.push(sec(stroke2, 13));

  const pill = p.section("text-bg", "Background", { open: false, toggle: { get: (l) => l.bg.on, set: (b) => ({ bg: { on: b } }), undo: "Text background" } });
  pill.body.append(
    p.color({ get: (l) => l.bg.color, set: (v) => ({ bg: { color: v } }), tip: "Background color", undo: "Background color" }),
    p.range("Opacity", { get: (l) => Math.round(l.bg.opacity * 100), set: (v) => ({ bg: { opacity: v / 100 } }), min: 0, max: 100, unit: "%", undo: "Background opacity", def: 100 }),
    field(
      "Padding",
      p.num("X", { get: (l) => l.bg.padX, set: (v) => ({ bg: { padX: v } }), min: 0, max: 400, tip: "Side padding", undo: "Background padding" }),
      p.num("Y", { get: (l) => l.bg.padY, set: (v) => ({ bg: { padY: v } }), min: 0, max: 400, tip: "Top and bottom padding", undo: "Background padding" })
    ),
    p.range("Corners", { get: (l) => l.bg.radius, set: (v) => ({ bg: { radius: v } }), min: 0, max: 200, unit: " px", undo: "Background corners", def: 18 })
  );
  out.push(sec(pill, 14));

  const spacing = p.section("text-spacing", "Spacing", { open: false });
  spacing.body.append(
    p.range("Letters", { get: (l) => l.letterSpacing / 10, set: (v) => ({ letterSpacing: Math.round(v * 10) }), min: -20, max: 80, step: 0.5, unit: "%", undo: "Letter spacing", def: 0 }),
    p.range("Lines", { get: (l) => l.lineHeight, set: (v) => ({ lineHeight: v }), min: 0.7, max: 2.5, step: 0.05, decimals: 2, undo: "Line height", def: 1.05 })
  );
  out.push(sec(spacing, 15));
  return out;
}

// ---- image -----------------------------------------------------------------------------

const REFINE_DEFAULT = { size: 48, hardness: 0.6, mode: "erase" };

function refineBrush(ctx) {
  const v = ctx.prefs?.get?.("refineBrush", null);
  return { ...REFINE_DEFAULT, ...(v && typeof v === "object" ? v : {}) };
}

function activeTool(ctx) {
  return ctx.editor?.tool || null;
}

function runTool(ctx, id) {
  const cmd = `tool.${id}`;
  if (ctx.commands?.get?.(cmd)) ctx.commands.run(cmd);
  else ctx.editor?.setTool?.(id);
}

function modelLine(p, { again = false } = {}) {
  const ctx = p.ctx;
  const bg = ctx.bg;
  if (!bg?.providers?.list) return null;
  const pick = h("button", { type: "button", class: "insp-model-pick", "aria-haspopup": "menu", "data-tip": "Choose the background remover" });
  const meta = h("span", { class: "insp-model-meta" });
  const paint = () => {
    const id = bg.defaultProvider;
    const prov = bg.providers.get(id);
    pick.replaceChildren(h("span", null, providerShort(prov?.label)), icon("chevron-down", { size: "sm" }));
    bg.modelInfo(id)
      .then((info) => {
        if (bg.defaultProvider !== id) return;
        meta.textContent = !info ? "" : info.kind === "local" ? "No download" : info.cached ? "Runs on this computer" : `${info.downloadMB || info.sizeMB} MB, once`;
      })
      .catch(() => (meta.textContent = ""));
  };
  paint();
  pick.addEventListener("click", () => {
    const r = pick.getBoundingClientRect();
    const items = bg.providers.list().map((prov) => ({
      label: again ? `${providerShort(prov.label)}: run again` : providerShort(prov.label),
      icon: prov.id === bg.defaultProvider ? "check" : undefined,
      run: () => {
        if (typeof bg.setDefaultProvider === "function") bg.setDefaultProvider(prov.id);
        else ctx.prefs?.set?.("bgProvider", prov.id);
        paint();
        if (again) removeBackground(ctx, p.ids, { provider: prov.id });
      },
    }));
    if (typeof ctx.ui?.menu === "function") ctx.ui.menu(items, { x: r.left, y: r.bottom + 6 });
    else items[(items.findIndex((i) => i.icon === "check") + 1) % items.length].run();
  });
  return h("div", { class: "insp-model" }, h("span", { class: "insp-model-label" }, "Model"), pick, meta);
}

function cutoutBlock(sp, state) {
  const ctx = sp.ctx;
  const layers = sp.layers();
  const first = layers[0];
  const out = [];
  if (state.running) {
    const ring = progressRing();
    const text = h("span", { class: "insp-job-text" });
    const upd = () => {
      const job = sp.layers().map((l) => bgJob(ctx, l.id)).find(Boolean);
      ring.set(job?.progress ?? 0);
      ring.classList.toggle("download", job?.phase === "download");
      text.textContent = jobText(job || { phase: "run" });
    };
    upd();
    sp.onUpdate(upd);
    const cancel = button({
      label: "Cancel",
      kind: "ghost",
      onClick: () => {
        for (const l of sp.layers()) ctx.bg?.cancel?.(l.id);
      },
    });
    out.push(h("div", { class: "insp-job" }, ring, text, cancel));
  } else if (!state.mask) {
    out.push(
      sp.cmd("image.remove-bg", {
        label: layers.length > 1 ? `Remove ${layers.length} backgrounds` : "Remove background",
        icon: "remove-bg",
        kind: "primary",
        wide: true,
        big: true,
      }),
      modelLine(sp)
    );
  } else {
    out.push(sp.cmd("image.restore", { label: "Restore original", icon: "reset", wide: true }));
    // Masks made before trimming existed, or after Refine brought parts back.
    if (layers.length === 1 && typeof ctx.bg?.fitToCutout === "function" && first.frame !== "ellipse" && !(first.radius > 0)) {
      out.push(button({ label: "Fit box to cutout", kind: "ghost", wide: true, onClick: () => ctx.bg.fitToCutout(first.id).catch(console.error) }));
    }
    if (state.tool !== "refine" && layers.length === 1 && ctx.bg?.masks) out.push(edgeControls(sp, first.id));
    out.push(modelLine(sp, { again: true }));
  }
  return out;
}

// Magic eraser and the refine brush, with their settings while one is active.
function toolsBlock(sp, tool) {
  const ctx = sp.ctx;
  const single = sp.ids.length === 1;
  const masked = sp.layers().some((l) => l.mask);
  const magic = button({
    label: tool === "magic" ? "Done" : "Magic eraser",
    icon: "wand",
    tip: "Click a color on the image to remove it",
    kbd: ctx.commands?.keysLabel?.("tool.magic") || "M",
    onClick: () => runTool(ctx, tool === "magic" ? "select" : "magic"),
  });
  const refine = button({
    label: tool === "refine" ? "Done" : masked ? "Refine" : "Erase",
    icon: "brush",
    tip: "Paint to erase or bring back parts of the image",
    kbd: ctx.commands?.keysLabel?.("tool.refine") || "E",
    onClick: () => runTool(ctx, tool === "refine" ? "select" : "refine"),
  });
  magic.classList.toggle("on", tool === "magic");
  refine.classList.toggle("on", tool === "refine");
  magic.disabled = refine.disabled = !single;
  const out = [grid2(magic, refine)];
  if (tool === "magic") out.push(magicControls(sp));
  if (tool === "refine") out.push(refineControls(sp));
  return out;
}

function refineControls(sp) {
  const ctx = sp.ctx;
  const set = (patch) => ctx.prefs?.set?.("refineBrush", { ...refineBrush(ctx), ...patch });
  const size = slider({ label: "Brush size", min: 4, max: 400, step: 1, unit: " px", value: refineBrush(ctx).size, defaultValue: REFINE_DEFAULT.size, onInput: (v) => set({ size: v }), onChange: (v) => set({ size: v }) });
  const hard = slider({ label: "Hardness", min: 0, max: 100, step: 1, unit: "%", value: Math.round(refineBrush(ctx).hardness * 100), defaultValue: 60, onInput: (v) => set({ hardness: v / 100 }), onChange: (v) => set({ hardness: v / 100 }) });
  const mode = segmented({
    options: [
      { value: "erase", label: "Erase", kbd: "X" },
      { value: "restore", label: "Restore", kbd: "X" },
    ],
    value: refineBrush(ctx).mode,
    full: true,
    size: "sm",
    onChange: (v) => set({ mode: v }),
  });
  sp.onUpdate(() => {
    const b = refineBrush(ctx);
    size.set(b.size);
    hard.set(Math.round(b.hardness * 100));
    mode.set(b.mode);
  });
  return h("div", { class: "insp-subpanel" }, mode, size, hard, note("Paint on the image. X switches erase and restore, [ and ] change the size, Shift paints a straight line."));
}

function edgeControls(sp, layerId) {
  const ctx = sp.ctx;
  let busy = false;
  const run = (patch) => {
    busy = true;
    wrap.classList.add("busy");
    applyEdge(ctx, layerId, patch)
      .catch((err) => {
        console.error(err);
        ctx.ui?.toast?.("The edge could not be changed.", { kind: "error" });
      })
      .finally(() => {
        busy = false;
        wrap.classList.remove("busy");
        sp.update();
      });
  };
  const soften = slider({ label: "Soften edge", min: 0, max: 30, step: 1, unit: " px", value: 0, defaultValue: 0, onChange: (v) => run({ soften: v }) });
  const grow = slider({ label: "Shrink or grow", min: -30, max: 30, step: 1, unit: " px", value: 0, defaultValue: 0, onChange: (v) => run({ grow: v }) });
  const wrap = h("div", { class: "insp-edge" }, soften, grow);
  sp.onUpdate(() => {
    if (busy) return;
    const st = edgeState(ctx.store.get(layerId));
    soften.set(st.soften);
    grow.set(st.grow);
  });
  const st = edgeState(ctx.store.get(layerId));
  soften.set(st.soften);
  grow.set(st.grow);
  return wrap;
}

function magicControls(sp) {
  const ctx = sp.ctx;
  const tol = slider({
    label: "Tolerance",
    min: 0,
    max: 100,
    step: 1,
    value: ctx.prefs?.get?.("magicTolerance", 32) ?? 32,
    defaultValue: 32,
    tip: "How similar a color must be to go with it",
    onInput: (v) => ctx.prefs?.set?.("magicTolerance", v),
    onChange: (v) => ctx.prefs?.set?.("magicTolerance", v),
  });
  sp.onUpdate(() => tol.set(ctx.prefs?.get?.("magicTolerance", 32) ?? 32));
  return h("div", { class: "insp-subpanel" }, tol, note("Click a color to remove it. Shift removes it everywhere, Alt brings it back. [ and ] change the tolerance."));
}

function filterControls(p) {
  const ctx = p.ctx;
  const defs = ctx.filters?.list?.() || [];
  if (!defs.length) return null;
  const s = p.section("image-filters", "Filters", { open: false });
  for (const def of defs) {
    const has = (l) => (l.filters || []).some((f) => f.id === def.id);
    const defaults = {};
    for (const prm of def.params || []) defaults[prm.key] = prm.default;
    const param = (l, key) => (l.filters || []).find((f) => f.id === def.id)?.params?.[key] ?? defaults[key];
    const tg = p.toggleRow(def.label, { get: has, set: (b, l) => ({ filters: setFilter(l.filters, def.id, b, b ? defaults : null) }), undo: def.label });
    const body = p.dyn(
      () => (p.every(has) ? "on" : "off"),
      (sp, k) => {
        if (k !== "on" || !(def.params || []).length) return null;
        return h(
          "div",
          { class: "insp-subpanel" },
          def.params.map((prm) =>
            prm.type === "color"
              ? sp.color({ get: (l) => param(l, prm.key), set: (v, l) => ({ filters: setFilter(l.filters, def.id, true, { [prm.key]: v }) }), tip: prm.label, undo: def.label, alpha: false })
              : sp.range(prm.label, {
                  get: (l) => param(l, prm.key),
                  set: (v, l) => ({ filters: setFilter(l.filters, def.id, true, { [prm.key]: v }) }),
                  min: prm.min ?? 0,
                  max: prm.max ?? 100,
                  step: prm.step ?? 1,
                  def: prm.default,
                  undo: def.label,
                })
          )
        );
      }
    );
    s.body.append(tg, body);
  }
  return sec(s, 30);
}

function imageSections(p) {
  const ctx = p.ctx;
  const out = [];

  const cut = p.section("image-bg", "Background");
  const state = () => {
    const ls = p.layers();
    const running = ls.some((l) => !!bgJob(ctx, l.id));
    const mask = ls.length > 0 && ls.every((l) => !!l.mask);
    const tool = activeTool(ctx);
    return { running, mask, tool: tool === "refine" || tool === "magic" ? tool : null, n: ls.length };
  };
  cut.body.append(
    p.dyn(
      () => {
        const st = state();
        return `${st.running}|${st.mask}|${st.tool === "refine"}|${st.n}`;
      },
      (sp) => cutoutBlock(sp, state())
    ),
    p.dyn(
      () => `${state().running ? "busy" : state().tool || "none"}|${p.layers().some((l) => l.mask)}`,
      (sp) => (state().running ? null : toolsBlock(sp, state().tool))
    )
  );
  out.push(sec(cut, 10));

  const frame = p.section("image-frame", "Frame");
  const crop = button({
    label: "Crop",
    icon: "crop",
    tip: "Crop the image",
    kbd: ctx.commands?.keysLabel?.("image.crop") || "Enter",
    onClick: () => {
      if (ctx.commands?.get?.("image.crop")) ctx.commands.run("image.crop");
      else ctx.editor?.startCrop?.(p.ids[0]);
    },
  });
  p.onUpdate(() => (crop.disabled = p.ids.length !== 1));
  crop.disabled = p.ids.length !== 1;
  frame.body.append(
    grid2(
      crop,
      p.seg({
        options: [
          { value: "rect", icon: "ins-frame-rect", label: "Rectangle" },
          { value: "ellipse", icon: "ins-frame-ellipse", label: "Ellipse" },
        ],
        get: (l) => l.frame,
        set: (v) => ({ frame: v }),
        undo: "Frame",
        full: true,
      })
    ),
    p.dyn(
      () => (p.every((l) => l.frame === "rect") ? "rect" : "other"),
      (sp, k) =>
        k === "rect"
          ? sp.range("Corners", {
              get: (l) => l.radius,
              set: (v) => ({ radius: v }),
              min: 0,
              max: Math.max(10, Math.round(Math.min(...sp.layers().map((l) => Math.min(l.w, l.h) / 2)))),
              unit: " px",
              undo: "Corner radius",
              def: 0,
            })
          : null
    )
  );
  out.push(sec(frame, 11));

  const filters = filterControls(p);
  if (filters) out.push(filters);

  const neutral = (l) => Object.values(l.adjust).every((v) => !v);
  const reset = button({ label: "Reset", kind: "ghost", tip: "Reset all adjustments", onClick: () => p.patch(() => ({ adjust: { brightness: 0, contrast: 0, saturation: 0, warmth: 0, hue: 0, blur: 0 } }), "Reset adjustments") });
  reset.classList.add("sm");
  p.onUpdate(() => (reset.disabled = p.every(neutral)));
  reset.disabled = p.every(neutral);
  // Six rarely used sliders start folded so Outline, Shadow and Glow stay in
  // view; a layer that already has adjustments opens with them showing.
  const adjust = p.section("image-adjust", "Adjust", { open: !p.every(neutral), actions: [reset] });
  const adj = (key, label, min = -100, max = 100, unit = "") =>
    p.range(label, { get: (l) => l.adjust[key], set: (v) => ({ adjust: { [key]: v } }), min, max, unit, def: 0, undo: label, tip: "Double-click to reset" });
  adjust.body.append(
    adj("brightness", "Brightness"),
    adj("contrast", "Contrast"),
    adj("saturation", "Saturation"),
    adj("warmth", "Warmth"),
    adj("hue", "Hue", -180, 180, "°"),
    adj("blur", "Blur", 0, 100)
  );
  out.push(sec(adjust, 31));

  const outline = p.section("image-outline", "Outline", { open: false, toggle: { get: (l) => l.outline.on, set: (b) => ({ outline: { on: b } }), undo: "Sticker outline" } });
  outline.body.append(
    p.color({ get: (l) => l.outline.color, set: (v) => ({ outline: { color: v } }), tip: "Outline color", undo: "Outline color" }),
    p.range("Width", { get: (l) => l.outline.width, set: (v) => ({ outline: { width: v } }), min: 1, max: 80, unit: " px", undo: "Outline width", def: 14 }),
    note("Follows the edge of a cutout, like a sticker.")
  );
  out.push(sec(outline, 32));
  return out;
}

// ---- shapes, arrows, drawings ------------------------------------------------------

const RADIUS_SHAPES = new Set(["rect", "triangle", "star"]);

function shapeName(id) {
  try {
    return createLayer("shape", { shape: id }).name;
  } catch {
    return "Shape";
  }
}

function changeShape(ctx, ids, id) {
  const set = new Set(ids);
  ctx.store.update(
    (doc) => {
      for (const l of doc.layers) {
        if (!set.has(l.id) || l.type !== "shape" || l.shape === id) continue;
        if (l.name === shapeName(l.shape) || l.name === ctx.shapes?.get?.(l.shape)?.label) l.name = shapeName(id);
        l.shape = id;
        l.params = {};
      }
    },
    { label: "Change shape" }
  );
}

function shapePicker(p) {
  const ctx = p.ctx;
  const defs = ctx.shapes?.list?.() || [];
  const btns = defs.map((def) => {
    const d = (() => {
      try {
        return shapePreviewPath(def.id, 24, 3);
      } catch {
        return "";
      }
    })();
    const art = d ? svg("svg", { viewBox: "0 0 24 24", class: "i insp-shape-art", "aria-hidden": "true" }, svg("path", { d })) : icon(def.icon || "dot");
    const b = h("button", { type: "button", class: "insp-shape", "data-tip": def.label, "aria-label": def.label, "aria-pressed": "false" }, art);
    b.addEventListener("click", () => changeShape(ctx, p.ids, def.id));
    return [def.id, b];
  });
  const upd = () => {
    const r = p.read((l) => l.shape);
    for (const [id, b] of btns) b.setAttribute("aria-pressed", String(!r.mixed && r.value === id));
  };
  upd();
  p.onUpdate(upd);
  return h("div", { class: "insp-shapes", role: "group", "aria-label": "Shape" }, btns.map(([, b]) => b));
}

function shapeSections(p) {
  const ctx = p.ctx;
  const out = [];
  const main = p.section("shape", "Shape");
  main.body.append(
    shapePicker(p),
    p.dyn(
      () => {
        const r = p.read((l) => l.shape);
        return r.mixed ? "" : r.value;
      },
      (sp, id) => {
        if (!id) return null;
        const def = ctx.shapes?.get?.(id);
        const parts = (def?.params || []).map((prm) =>
          sp.range(prm.label, {
            get: (l) => shapeParams(l, def)[prm.key],
            set: (v) => ({ params: { [prm.key]: v } }),
            min: prm.min,
            max: prm.max,
            step: prm.step ?? 1,
            decimals: prm.step && prm.step < 1 ? String(prm.step).split(".")[1]?.length : undefined,
            def: prm.default,
            undo: prm.label,
          })
        );
        if (RADIUS_SHAPES.has(id)) {
          const max = Math.max(10, Math.round(Math.min(...sp.layers().map((l) => Math.min(l.w, l.h) / 2))));
          parts.push(sp.range("Corners", { get: (l) => l.radius, set: (v) => ({ radius: v }), min: 0, max, unit: " px", undo: "Corner radius", def: 0 }));
        }
        return parts;
      }
    )
  );
  out.push(sec(main, 10));

  const fill = p.section("shape-fill", "Fill", { toggle: { get: (l) => l.fill.on, set: (b) => ({ fill: { on: b } }), undo: "Fill" } });
  fill.body.append(p.color({ get: (l) => l.fill.color, set: (v) => ({ fill: { color: v } }), tip: "Fill color", undo: "Fill color" }));
  out.push(sec(fill, 11));

  const stroke = p.section("shape-stroke", "Stroke", { toggle: { get: (l) => l.stroke.on, set: (b) => ({ stroke: { on: b } }), undo: "Stroke" } });
  stroke.body.append(
    p.color({ get: (l) => l.stroke.color, set: (v) => ({ stroke: { color: v } }), tip: "Stroke color", undo: "Stroke color" }),
    p.range("Width", { get: (l) => l.stroke.width, set: (v) => ({ stroke: { width: v } }), min: 1, max: 60, unit: " px", undo: "Stroke width", def: 8 }),
    p.toggleRow("Dashed", { get: (l) => l.stroke.dash, set: (b) => ({ stroke: { dash: b } }), undo: "Dashed stroke" })
  );
  out.push(sec(stroke, 12));
  return out;
}

function straighten(l) {
  if (!l.c) return null;
  const pts = arrowPoints(l);
  const fit = refitArrow(l, { a: pts.a, b: pts.b, c: null });
  return { x: fit.x, y: fit.y, w: fit.w, h: fit.h, a: fit.a, b: fit.b, c: null };
}

function arrowSections(p) {
  const out = [];
  const main = p.section("arrow", "Arrow");
  const heads = [
    { value: "triangle", icon: "ins-head-triangle", label: "Arrowhead" },
    { value: "line", icon: "ins-head-line", label: "Open arrowhead" },
    { value: "none", icon: "ins-end-none", label: "No head" },
  ];
  const tails = [
    { value: "none", icon: "ins-end-none", label: "No tail" },
    { value: "triangle", icon: "ins-tail-triangle", label: "Arrowhead" },
    { value: "line", icon: "ins-tail-line", label: "Open arrowhead" },
    { value: "dot", icon: "ins-tail-dot", label: "Dot" },
  ];
  const straight = button({ label: "Straighten", icon: "ins-straighten", onClick: () => p.patch((l) => straighten(l), "Straighten") });
  const swapEnds = button({ label: "Swap ends", icon: "arrow-left-right", onClick: () => p.patch((l) => ({ a: l.b, b: l.a }), "Swap ends") });
  const updStraight = () => (straight.disabled = !p.layers().some((l) => l.c));
  updStraight();
  p.onUpdate(updStraight);
  main.body.append(
    p.color({ get: (l) => l.color, set: (v) => ({ color: v }), tip: "Arrow color", undo: "Arrow color" }),
    p.range("Width", { get: (l) => l.width, set: (v) => ({ width: v }), min: 1, max: 60, unit: " px", undo: "Arrow width", def: 14 }),
    field("Head", p.seg({ options: heads, get: (l) => l.head, set: (v) => ({ head: v }), undo: "Arrowhead", full: true })),
    field("Tail", p.seg({ options: tails, get: (l) => l.tail, set: (v) => ({ tail: v }), undo: "Arrow tail", full: true })),
    p.range("Head size", { get: (l) => l.headSize, set: (v) => ({ headSize: v }), min: 1, max: 8, step: 0.1, decimals: 1, unit: "×", undo: "Head size", def: 3.2 }),
    p.toggleRow("Hand-drawn", { get: (l) => l.sketch, set: (b) => ({ sketch: b }), undo: "Hand-drawn" }),
    grid2(straight, swapEnds)
  );
  out.push(sec(main, 10));
  return out;
}

function pathSections(p) {
  const main = p.section("path", "Drawing");
  main.body.append(
    p.color({ get: (l) => l.color, set: (v) => ({ color: v }), tip: "Pen color", undo: "Pen color" }),
    p.range("Width", { get: (l) => l.width, set: (v) => ({ width: v }), min: 1, max: 80, unit: " px", undo: "Pen width", def: 10 }),
    p.range("Smoothing", { get: (l) => Math.round(l.smoothing * 100), set: (v) => ({ smoothing: v / 100 }), min: 0, max: 100, unit: "%", undo: "Smoothing", def: 50 })
  );
  return [sec(main, 10)];
}

// ---- effects, arrange, layer ----------------------------------------------------------

function shadowAngle(l) {
  return shadowPolar(l.shadow, shadowAngles.get(l.id) ?? 90).angle;
}

function effectSections(p) {
  const shadow = p.section("shadow", "Shadow", { open: false, toggle: { get: (l) => l.shadow.on, set: (b) => ({ shadow: { on: b } }), undo: "Shadow" } });
  shadow.body.append(
    p.color({ get: (l) => l.shadow.color, set: (v) => ({ shadow: { color: v } }), tip: "Shadow color", undo: "Shadow color", alpha: false }),
    p.range("Opacity", { get: (l) => Math.round(l.shadow.opacity * 100), set: (v) => ({ shadow: { opacity: v / 100 } }), min: 0, max: 100, unit: "%", undo: "Shadow opacity", def: 60 }),
    p.range("Blur", { get: (l) => l.shadow.blur, set: (v) => ({ shadow: { blur: v } }), min: 0, max: 200, unit: " px", undo: "Shadow blur", def: 24 }),
    grid2(
      p.num("Distance", {
        get: (l) => Math.round(Math.hypot(l.shadow.dx, l.shadow.dy)),
        set: (v, l) => {
          const a = shadowAngle(l);
          shadowAngles.set(l.id, a);
          return { shadow: polarToShadow(v, a) };
        },
        min: 0,
        max: 1000,
        tip: "Shadow distance",
        undo: "Shadow distance",
      }),
      p.num("", {
        icon: "rotate",
        get: (l) => Math.round(shadowAngle(l)),
        set: (v, l) => {
          shadowAngles.set(l.id, v);
          const d = Math.hypot(l.shadow.dx, l.shadow.dy);
          return d < 0.01 ? null : { shadow: polarToShadow(d, v) };
        },
        min: -180,
        max: 180,
        unit: "°",
        tip: "Shadow direction",
        undo: "Shadow direction",
      })
    )
  );
  const glow = p.section("glow", "Glow", { open: false, toggle: { get: (l) => l.glow.on, set: (b) => ({ glow: { on: b } }), undo: "Glow" } });
  glow.body.append(
    p.color({ get: (l) => l.glow.color, set: (v) => ({ glow: { color: v } }), tip: "Glow color", undo: "Glow color", alpha: false }),
    p.range("Opacity", { get: (l) => Math.round(l.glow.opacity * 100), set: (v) => ({ glow: { opacity: v / 100 } }), min: 0, max: 100, unit: "%", undo: "Glow opacity", def: 90 }),
    p.range("Size", { get: (l) => l.glow.size, set: (v) => ({ glow: { size: v } }), min: 0, max: 200, unit: " px", undo: "Glow size", def: 28 })
  );
  return [sec(shadow, 50), sec(glow, 51)];
}

function boxOf(layers) {
  if (!layers.length) return null;
  if (layers.length === 1) {
    const l = layers[0];
    return { l: l.x - l.w / 2, t: l.y - l.h / 2, w: l.w, h: l.h };
  }
  const u = unionBox(layers.map((l) => aabb(l)));
  return u ? { l: u.l, t: u.t, w: u.w, h: u.h } : null;
}

function locked(l) {
  if (aspectLocks.has(l.id)) return aspectLocks.get(l.id);
  return l.type === "image";
}

function arrangeSection(p, order = 80) {
  const ctx = p.ctx;
  const s = p.section("arrange", "Arrange");
  const multi = () => p.ids.length > 1;
  const box = () => boxOf(p.layers());
  const move = (axis) => (v, opts) => {
    const b = box();
    if (!b) return;
    const d = round(v - (axis === "x" ? b.l : b.t), 3);
    if (!d) return;
    p.store.patch(p.ids, (l) => (axis === "x" ? { x: round(l.x + d, 3) } : { y: round(l.y + d, 3) }), opts);
  };
  const sizeSet = (dim) => (v, l) => {
    if (l.type === "text") return dim === "w" ? { wrap: "fixed", w: v } : null;
    const lock = locked(l);
    const w = dim === "w" ? v : lock ? round((v * l.w) / l.h, 2) : l.w;
    const hh = dim === "h" ? v : lock ? round((v * l.h) / l.w, 2) : l.h;
    if (l.rotation) return { w, h: hh };
    return { w, h: hh, x: round(l.x - l.w / 2 + w / 2, 3), y: round(l.y - l.h / 2 + hh / 2, 3) };
  };
  const one = (fn) => () => {
    const b = box();
    return { value: b ? round(fn(b), 1) : 0, mixed: false };
  };
  const x = p.num("X", { read: one((b) => b.l), apply: move("x"), tip: "Left edge", undo: "Move", step: 1, decimals: 0 });
  const y = p.num("Y", { read: one((b) => b.t), apply: move("y"), tip: "Top edge", undo: "Move", step: 1, decimals: 0 });
  const w = p.num("W", { get: (l) => round(l.w, 1), set: sizeSet("w"), read: multi() ? one((b) => b.w) : undefined, min: 1, max: 1e5, tip: "Width", undo: "Resize", decimals: 0, disabled: multi });
  const hgt = p.num("H", {
    get: (l) => round(l.h, 1),
    set: sizeSet("h"),
    read: multi() ? one((b) => b.h) : undefined,
    min: 1,
    max: 1e5,
    tip: "Height",
    undo: "Resize",
    decimals: 0,
    disabled: () => multi() || p.layers().some((l) => l.type === "text"),
  });
  const single = p.layers()[0];
  let link = null;
  if (!multi() && single && single.type !== "text") {
    link = iconButton({ icon: locked(single) ? "link" : "unlink", tip: "Keep proportions", size: "sm", active: locked(single) });
    link.classList.add("insp-link");
    link.addEventListener("click", () => {
      const l = p.layers()[0];
      if (!l) return;
      const next = !locked(l);
      aspectLocks.set(l.id, next);
      link.setActive(next);
      setIcon(link, next ? "link" : "unlink");
    });
  }
  const rot = p.num("", { icon: "rotate", get: (l) => round(l.rotation, 1), set: (v) => ({ rotation: v }), min: -180, max: 180, step: 1, unit: "°", tip: "Rotation", undo: "Rotate", decimals: 0 });
  const flips = [p.cmd("layer.flip-h", { icon: "flip-h", tip: "Flip horizontal" }), p.cmd("layer.flip-v", { icon: "flip-v", tip: "Flip vertical" })];

  const aligns = [
    ["align.left", "align-left", "Align left"],
    ["align.center-h", "align-center-h", "Center horizontally"],
    ["align.right", "align-right", "Align right"],
    ["align.top", "align-top", "Align top"],
    ["align.center-v", "align-center-v", "Center vertically"],
    ["align.bottom", "align-bottom", "Align bottom"],
  ].map(([id, ic, tip]) => p.cmd(id, { icon: ic, tip: p.ids.length > 1 ? tip : `${tip} on the canvas` }));
  const dist = p.ids.length > 2
    ? [p.cmd("align.distribute-h", { icon: "distribute-h", tip: "Space evenly across" }), p.cmd("align.distribute-v", { icon: "distribute-v", tip: "Space evenly down" })]
    : [];

  const atTop = () => {
    const all = p.store.layers();
    const set = new Set(p.ids);
    return all.slice(all.length - set.size).every((l) => set.has(l.id));
  };
  const atBottom = () => {
    const all = p.store.layers();
    const set = new Set(p.ids);
    return all.slice(0, set.size).every((l) => set.has(l.id));
  };
  const orders = [
    p.cmd("layer.front", { icon: "bring-front", tip: "Bring to front", enabled: () => !atTop() }),
    p.cmd("layer.forward", { icon: "bring-forward", tip: "Bring forward", enabled: () => !atTop() }),
    p.cmd("layer.backward", { icon: "send-backward", tip: "Send backward", enabled: () => !atBottom() }),
    p.cmd("layer.back", { icon: "send-back", tip: "Send to back", enabled: () => !atBottom() }),
  ];

  // Dead center in one click comes first; the six edge and axis aligns follow.
  const center = p.cmd("align.center", { icon: "align-center", tip: p.ids.length > 1 ? "Center the group on the canvas" : "Center on the canvas" });

  s.body.append(
    grid2(x, y),
    h("div", { class: ["insp-wh", link && "linked"] }, w, link, hgt),
    h("div", { class: "insp-rot" }, rot, ...flips),
    toolbar(center, divider(), ...aligns.slice(0, 3), divider(), ...aligns.slice(3)),
    toolbar(...orders, dist.length ? divider() : null, ...dist)
  );
  return sec(s, order);
}

function layerSection(p) {
  const multi = p.ids.length > 1;
  const hide = p.iconToggle({ icon: "eye", icons: ["eye", "eye-off"], tips: ["Hide", "Show"], tip: "Hide", kbd: p.ctx.commands?.keysLabel?.("layer.hide"), get: (l) => l.hidden, set: (b) => ({ hidden: b }), undo: "Hide layer" });
  const lock = p.iconToggle({ icon: "unlock", icons: ["unlock", "lock"], tips: ["Lock", "Unlock"], tip: "Lock", kbd: p.ctx.commands?.keysLabel?.("layer.lock"), get: (l) => l.locked, set: (b) => ({ locked: b }), undo: "Lock layer" });
  const s = p.section("layer", "Layer", { actions: [hide, lock] });
  if (!multi) {
    const input = h("input", { type: "text", class: "insp-name", spellcheck: "false", autocomplete: "off", maxlength: 200, "aria-label": "Layer name" });
    const show = () => {
      if (document.activeElement !== input) input.value = p.layers()[0]?.name || "";
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") input.blur();
      else if (e.key === "Escape") {
        input.dataset.cancel = "1";
        input.blur();
      }
    });
    input.addEventListener("blur", () => {
      const l = p.layers()[0];
      const v = input.value.trim();
      if (!input.dataset.cancel && l && v && v !== l.name) p.store.patch(l.id, { name: v }, { label: "Rename" });
      delete input.dataset.cancel;
      show();
    });
    show();
    p.onUpdate(show);
    s.body.append(input);
  } else {
    s.body.append(note(`${p.ids.length} layers selected`));
  }
  s.body.append(
    p.range("Opacity", { get: (l) => Math.round(l.opacity * 100), set: (v) => ({ opacity: v / 100 }), min: 0, max: 100, unit: "%", undo: "Opacity", def: 100 }),
    field("Blend", p.choice({ options: BLEND_MODES.map((b) => ({ value: b.id, label: b.label })), get: (l) => l.blend, set: (v) => ({ blend: v }), undo: "Blend mode", tip: "Blend mode" }))
  );
  return sec(s, 90);
}

// ---- canvas ----------------------------------------------------------------------------

function matchingPreset(ctx, width, height, current) {
  const cur = current ? ctx.presets?.get?.(current) : null;
  if (cur && !cur.custom && cur.width === width && cur.height === height) return current;
  return ctx.presets?.find?.(width, height)?.id ?? null;
}

function presetSelect(p) {
  const ctx = p.ctx;
  const el = h("select", { class: "ctl-select", "aria-label": "Size preset", "data-tip": "Size preset" });
  const groups = ctx.presets?.groups?.() || [];
  for (const g of groups) {
    const items = g.presets.filter((pr) => !pr.custom);
    if (!items.length) continue;
    el.append(h("optgroup", { label: g.label }, items.map((pr) => h("option", { value: pr.id }, `${pr.label}  ·  ${pr.width} × ${pr.height}`))));
  }
  el.append(h("option", { value: "" }, "Custom size"));
  const upd = () => {
    const d = ctx.store.doc;
    const pr = d.preset ? ctx.presets?.get?.(d.preset) : null;
    el.value = pr && !pr.custom ? d.preset : "";
  };
  upd();
  p.onUpdate(upd);
  el.addEventListener("change", async () => {
    const id = el.value;
    if (!id) ctx.store.setDocProps({ preset: null }, { label: "Canvas preset" });
    else {
      const pr = ctx.presets.get(id);
      await ctx.commands.run("canvas.resize", { preset: id, width: pr.width, height: pr.height });
    }
    p.update();
  });
  return el;
}

function canvasSections(p) {
  const ctx = p.ctx;
  const out = [];
  const main = p.section("canvas", "Canvas");
  const resize = (dim) => async (v) => {
    const d = ctx.store.doc;
    await ctx.commands.run("canvas.resize", { width: dim === "w" ? v : d.width, height: dim === "h" ? v : d.height });
    p.update();
  };
  const w = p.num("W", { get: (d) => d.width, apply: resize("w"), live: false, min: 16, max: 8000, tip: "Canvas width", field: "canvas-width", decimals: 0 });
  const hh = p.num("H", { get: (d) => d.height, apply: resize("h"), live: false, min: 16, max: 8000, tip: "Canvas height", field: "canvas-height", decimals: 0 });
  const swap = iconButton({
    icon: "arrow-right-left",
    tip: "Swap width and height",
    size: "sm",
    onClick: async () => {
      const d = ctx.store.doc;
      await ctx.commands.run("canvas.resize", { width: d.height, height: d.width });
      p.update();
    },
  });
  const info = h("p", { class: "insp-note" });
  const paintInfo = () => {
    const d = ctx.store.doc;
    const pr = d.preset ? ctx.presets?.get?.(d.preset) : null;
    const ratio = aspectLabel(d.width, d.height);
    info.textContent = pr && !pr.custom && pr.note ? pr.note : `${ratio}${ratio ? ". " : ""}Any size from 16 to 8000 px.`;
  };
  paintInfo();
  p.onUpdate(paintInfo);
  main.body.append(presetSelect(p), h("div", { class: "insp-wh linked" }, w, swap, hh), info);
  out.push(sec(main, 10));

  const bgSec = p.section("canvas-bg", "Background");
  const remember = () => {
    const b = ctx.store.doc.background;
    if (b.kind === "color") lastBackground.color = b.color;
    if (b.kind === "gradient") lastBackground.gradient = { from: b.from, to: b.to, angle: b.angle };
  };
  remember();
  p.onUpdate(remember);
  bgSec.body.append(
    p.seg({
      options: [
        { value: "color", label: "Color" },
        { value: "gradient", label: "Gradient" },
        { value: "transparent", label: "Transparent" },
      ],
      get: (d) => d.background.kind,
      apply: (v) => {
        const b = v === "color" ? { kind: "color", color: lastBackground.color } : v === "gradient" ? { kind: "gradient", ...lastBackground.gradient } : { kind: "transparent" };
        ctx.store.setDocProps({ background: b }, { label: "Background" });
      },
      full: true,
      size: "sm",
    }),
    p.dyn(
      () => ctx.store.doc.background.kind,
      (sp, kind) => {
        if (kind === "color") return sp.color({ get: (d) => d.background.color, set: (v) => ({ background: { kind: "color", color: v } }), tip: "Background color", undo: "Background color" });
        if (kind === "gradient")
          return sp.gradient({
            from: { get: (d) => d.background.from, set: (v) => ({ background: { from: v } }) },
            to: { get: (d) => d.background.to, set: (v) => ({ background: { to: v } }) },
            angle: { get: (d) => d.background.angle, set: (v) => ({ background: { angle: v } }) },
            swap: (d) => ({ background: { from: d.background.to, to: d.background.from } }),
            undo: "Background gradient",
          });
        return note("Exports keep the transparency as PNG or WebP. JPEG fills it with white.");
      }
    )
  );
  out.push(sec(bgSec, 11));

  const view = p.section("canvas-view", "Guides");
  const viewToggle = (label, cmd, key, tip) => {
    const t = toggle({
      label,
      tip,
      value: !!ctx.prefs?.get?.(key, true),
      onChange: (b) => {
        if (ctx.commands?.get?.(cmd)) ctx.commands.run(cmd);
        else ctx.prefs?.set?.(key, b);
        setTimeout(() => t.set(!!ctx.prefs?.get?.(key, true)), 0);
      },
    });
    p.onUpdate(() => t.set(!!ctx.prefs?.get?.(key, true)));
    return t;
  };
  view.body.append(
    viewToggle("Safe zones", "view.safe-zones", "safeZones", "Show where the platform covers the image"),
    viewToggle("Snapping", "view.snapping", "snap", "Snap to the center, edges and other layers")
  );
  out.push(sec(view, 12));
  return out;
}

// ---- mod sections ----------------------------------------------------------------------

function modSections(p, layers) {
  const ctx = p.ctx;
  const out = [];
  const defs = (ctx.inspector?.list?.() || []).slice().sort((a, b) => (a.order ?? 60) - (b.order ?? 60));
  for (const def of defs) {
    let show = false;
    try {
      show = !!def.when(layers, ctx);
    } catch (err) {
      console.error(err);
    }
    if (!show) continue;
    const s = p.section(`mod:${def.id}`, String(def.title || def.id));
    try {
      const ret = def.render(s.body, layers, ctx);
      if (typeof ret === "function") p.onCleanup(ret);
      else if (ret && typeof ret === "object") {
        if (typeof ret.destroy === "function") p.onCleanup(() => ret.destroy());
        if (typeof ret.update === "function") p.onUpdate(() => ret.update(p.isDoc ? [] : p.layers(), ctx));
      }
    } catch (err) {
      console.error(err);
      s.body.append(note("This section could not be shown."));
    }
    out.push({ el: s.el, order: Number.isFinite(def.order) ? def.order : 60 });
  }
  return out;
}

// ---- commands --------------------------------------------------------------------------

async function askResizeMode(ctx) {
  if (typeof ctx.ui?.dialog !== "function") {
    if (typeof ctx.ui?.confirm === "function") {
      const ok = await ctx.ui.confirm({ title: "Resize canvas", message: "Scale the layers to the new size? Choose Keep positions to leave them as they are.", ok: "Scale content", cancel: "Keep positions" });
      return ok ? "scale" : "keep";
    }
    return "scale";
  }
  return new Promise((resolve) => {
    let done = false;
    let dlg = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      try {
        dlg?.close?.();
      } catch {}
      resolve(v);
    };
    dlg = ctx.ui.dialog({
      title: "Resize canvas",
      body: h("p", { class: "insp-dlg-msg" }, "Scale the layers to fit the new size, or keep their size and their place from the center."),
      actions: [
        { label: "Keep positions", run: () => finish("keep") },
        { label: "Scale content", kind: "primary", run: () => finish("scale") },
      ],
      onClose: () => setTimeout(() => finish(null), 0),
    });
  });
}

function focusCanvasSize(ctx) {
  ctx.store.clearSelection();
  ctx.ui?.closeHome?.();
  requestAnimationFrame(() => {
    const input = document.querySelector('.insp [data-field="canvas-width"] input');
    input?.focus();
  });
}

export async function resizeCanvas(ctx, args = {}) {
  const store = ctx.store;
  const doc = store.doc;
  const a = args || {};
  if (a.width == null && a.height == null && a.preset == null) {
    focusCanvasSize(ctx);
    return false;
  }
  const pr = a.preset ? ctx.presets?.get?.(a.preset) : null;
  const size = (v, fallback) => Math.round(clamp(Number.isFinite(Number(v)) ? Number(v) : fallback, 16, 8000));
  const width = size(a.width ?? pr?.width, doc.width);
  const height = size(a.height ?? pr?.height, doc.height);
  const preset = a.preset !== undefined ? a.preset || null : matchingPreset(ctx, width, height, doc.preset);
  if (width === doc.width && height === doc.height) {
    if (preset !== doc.preset) store.setDocProps({ preset }, { label: "Canvas preset" });
    return true;
  }
  let mode = a.mode === "scale" || a.mode === "keep" ? a.mode : null;
  if (!mode) mode = doc.layers.length ? await askResizeMode(ctx) : "keep";
  if (!mode) return false;
  store.update((d) => resizeDocContent(d, width, height, mode, preset), { label: "Resize canvas" });
  ctx.editor?.zoomToFit?.();
  return true;
}

function toggleNested(ctx, type, key, label) {
  const ids = ctx.store.selected().filter((l) => l.type === type).map((l) => l.id);
  if (!ids.length) return false;
  const allOn = ids.every((id) => ctx.store.get(id)[key].on);
  return ctx.store.patch(ids, { [key]: { on: !allOn } }, { label });
}

function registerCommands(ctx) {
  const d = disposer();
  const reg = (def) => {
    try {
      d(ctx.commands.register(def));
    } catch (err) {
      console.warn(err.message);
    }
  };
  const of = (type) => ctx.store.selected().filter((l) => l.type === type);
  reg({
    id: "image.remove-bg",
    title: "Remove background",
    group: "Image",
    keys: ["Shift+B"],
    icon: "remove-bg",
    keywords: "cutout cut out transparent erase background",
    when: () => of("image").length > 0,
    run: (c, args) => removeBackground(c, args?.ids || of("image").map((l) => l.id), { provider: args?.provider }),
  });
  reg({
    id: "image.restore",
    title: "Restore original image",
    group: "Image",
    icon: "reset",
    keywords: "background mask undo cutout",
    when: () => of("image").some((l) => l.mask),
    run: (c) => restoreImages(c, of("image").map((l) => l.id)),
  });
  reg({
    id: "image.outline",
    title: "Sticker outline",
    group: "Image",
    icon: "ins-outline",
    keywords: "border stroke sticker edge",
    when: () => of("image").length > 0,
    run: (c) => toggleNested(c, "image", "outline", "Sticker outline"),
  });
  reg({
    id: "text.stroke",
    title: "Text stroke",
    group: "Text",
    icon: "ins-stroke",
    keywords: "outline border edge",
    when: () => of("text").length > 0,
    run: (c) => toggleNested(c, "text", "stroke", "Text stroke"),
  });
  reg({
    id: "text.uppercase",
    title: "Uppercase",
    group: "Text",
    icon: "case-upper",
    keywords: "caps capitals all caps",
    when: () => of("text").length > 0,
    run: (c) => {
      const ids = of("text").map((l) => l.id);
      const all = ids.every((id) => c.store.get(id).uppercase);
      return c.store.patch(ids, { uppercase: !all }, { label: "Uppercase" });
    },
  });
  reg({
    id: "canvas.resize",
    title: "Resize canvas",
    group: "Canvas",
    icon: "crop",
    keywords: "size dimensions preset width height",
    run: (c, args) => resizeCanvas(c, args),
  });
  return d.dispose;
}

// ---- mount -----------------------------------------------------------------------------

function kindOf(layers) {
  if (!layers.length) return "canvas";
  const types = new Set(layers.map((l) => l.type));
  return types.size === 1 ? [...types][0] : "mixed";
}

const BUILDERS = { text: textSections, image: imageSections, shape: shapeSections, arrow: arrowSections, path: pathSections };

function scrollHost(el) {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if (oy === "auto" || oy === "scroll") return n;
  }
  return el;
}

export function mountInspector(el, ctx) {
  ensureIcons();
  trackBgJobs(ctx);
  bindColorPicker(ctx);
  bindFontPicker(ctx);
  ctx.ui = ctx.ui || {};
  ctx.ui.openColorPicker = (anchor, opts = {}) => openColorPicker(anchor, { ctx, ...opts });
  ctx.ui.openFontPicker = (anchor, opts = {}) => openFontPicker(anchor, { ctx, ...opts });

  const d = disposer();
  d(registerCommands(ctx));
  const root = h("div", { class: "insp", role: "region", "aria-label": "Inspector" });
  el.append(root);
  d(() => root.remove());

  let panel = null;
  let sig = null;
  let kindSig = null;
  let queued = false;
  let building = false;
  let again = false;

  const sigOf = () => (ctx.store.selection.length ? ctx.store.selection.join(",") : "canvas");

  function build() {
    building = true;
    try {
      buildNow();
    } finally {
      building = false;
    }
    if (again) {
      again = false;
      refresh();
    }
  }

  function buildNow() {
    const host = scrollHost(el);
    const keep = host.scrollTop;
    panel?.destroy();
    const layers = ctx.store.selected();
    const kind = kindOf(layers);
    const nextKind = `${kind}:${layers.length > 1}`;
    const p = kind === "canvas" ? new Panel(ctx, [], { doc: true }) : new Panel(ctx, layers.map((l) => l.id));
    const secs = [];
    if (kind === "canvas") secs.push(...canvasSections(p));
    else {
      if (BUILDERS[kind]) secs.push(...BUILDERS[kind](p));
      if (kind === "mixed") secs.push(arrangeSection(p, 5));
      secs.push(...effectSections(p));
      if (kind !== "mixed") secs.push(arrangeSection(p));
      secs.push(layerSection(p));
    }
    secs.push(...modSections(p, layers));
    secs.sort((a, b) => a.order - b.order);
    root.dataset.kind = kind;
    root.replaceChildren(...secs.map((s) => s.el));
    panel = p;
    sig = sigOf();
    host.scrollTop = nextKind === kindSig ? keep : 0;
    kindSig = nextKind;
  }

  // Destroying a panel can commit an open gesture, which emits a change.
  const refresh = () => {
    if (building) {
      again = true;
      return;
    }
    if (sigOf() !== sig) build();
    else panel?.update();
  };
  // Several app events can arrive in one tick; update once.
  const soon = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      refresh();
    });
  };
  const rebuild = () => {
    sig = null;
    soon();
  };

  // A press anywhere outside the inspector (a handle on the canvas, a layer
  // row) settles the field being edited first: its typed value or arrow-key
  // steps record as their own undo step before the editor opens a Resize or
  // Rotate gesture in its pointerdown. Capture on the document runs before
  // the canvas host's listener.
  const settle = (e) => {
    if (el.contains(e.target) || e.target?.closest?.(".popover, .menu, .pop-fallback")) return;
    const ae = document.activeElement;
    if (!ae || !root.contains(ae)) return;
    ae.blur?.();
    panel?.flush();
  };
  document.addEventListener("pointerdown", settle, true);
  d(() => document.removeEventListener("pointerdown", settle, true));

  const onChange = () => refresh();
  ctx.store.addEventListener("change", onChange);
  ctx.store.addEventListener("selection", onChange);
  d(() => ctx.store.removeEventListener("change", onChange));
  d(() => ctx.store.removeEventListener("selection", onChange));
  for (const type of ["tool", "mode", "bg-progress", "prefs", "refine", "magic", "textedit"]) d(ctx.on(type, soon));
  d(ctx.on("presets", rebuild));
  d(ctx.on("mods", rebuild));
  if (ctx.fonts?.addEventListener) {
    ctx.fonts.addEventListener("change", soon);
    ctx.fonts.addEventListener("load", soon);
    d(() => ctx.fonts.removeEventListener("change", soon));
    d(() => ctx.fonts.removeEventListener("load", soon));
  }
  for (const reg of [ctx.inspector, ctx.shapes, ctx.filters, ctx.presets, ctx.bg?.providers]) {
    if (typeof reg?.onChange === "function") d(reg.onChange(rebuild));
  }
  if (typeof ctx.commands?.onChange === "function") d(ctx.commands.onChange(soon));

  build();
  return {
    destroy() {
      panel?.destroy();
      panel = null;
      d.dispose();
    },
    refresh: rebuild,
  };
}
