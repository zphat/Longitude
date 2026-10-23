// Export dialog (SPEC 12): live preview with a before/after compare, format,
// scale, quality, "fit under", 256-color PNG, a live file size, download and
// copy. registerExportCommands() also wires the feed preview and quick tools.

import { h, on, debounce, disposer } from "./dom.js";
import { icon } from "./icons.js";
import { segmented, slider, number, button, iconButton } from "./controls.js";
import { renderToCanvas } from "../core/render.js";
import {
  encodeToTarget,
  formatBytes,
  download,
  copyImage,
  extFor,
  labelFor,
  flattenColor,
  canEncode,
  safeFileName,
  MAX_CANVAS_SIDE,
  MAX_CANVAS_PIXELS,
} from "../features/compress.js";
import { openSheet, createCompare, ensureIcons, openQuickTool, switchRow } from "./quicktools.js";
import { openFeedPreview } from "./feedpreview.js";
import { keysLabel } from "../app/context.js";

// ---- pure helpers ---------------------------------------------------------------

export const EXPORT_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const SCALES = ["0.5", "1", "2", "3", "custom"];
export const MAX_EXPORT_SIDE = MAX_CANVAS_SIDE;
export const MAX_EXPORT_PIXELS = MAX_CANVAS_PIXELS;
export const ESTIMATE_DELAY = 250;
export const LARGE_EXPORT_PIXELS = 50e6;

// Platform sizes the presets' sources state but presets.json has no field
// for. A preset's export.minWidth / minHeight / maxSide win when present.
export const PLATFORM_LIMITS = {
  "yt-thumb": { minWidth: 640 },
  "yt-shorts": { minHeight: 640 },
  "yt-banner": { minWidth: 2048, minHeight: 1152 },
  "yt-watermark": { minWidth: 150, minHeight: 150 },
  "sp-podcast": { minWidth: 1400, minHeight: 1400, soft: true },
  "sp-album": { minWidth: 640, minHeight: 640, maxSide: 10000 },
  "sp-header": { minWidth: 2660, minHeight: 1140 },
  "sp-avatar": { minWidth: 750, minHeight: 750 },
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const round2 = (v) => Math.round(v * 100) / 100;

// "Is this a scam?" -> "is-this-a-scam". Keeps letters of any script, drops
// accents from Latin letters, joins words with dashes.
export function slugify(text, max = 60) {
  const s = String(text ?? "")
    .replace(/[À-ɏḀ-ỿ]/g, (c) => c.normalize("NFKD").replace(/[̀-ͯ]/g, ""))
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, max).replace(/-+$/, "");
}

export function exportBaseName(name, width, height) {
  return `${slugify(name) || "longitude"}-${width}x${height}`;
}

// "is-this-a-scam-1280x720.jpg"
export function exportFileName(name, width, height, type) {
  return safeFileName(exportBaseName(name, width, height), type);
}

export function presetKey(doc) {
  return doc?.preset || "none";
}

export function exportDefaults(preset) {
  const e = preset?.export || {};
  const max = isNum(e.maxBytes) && e.maxBytes > 0 ? e.maxBytes : 0;
  return {
    type: EXPORT_TYPES.includes(e.type) ? e.type : "image/png",
    scale: "1",
    width: isNum(preset?.width) ? preset.width : 1280,
    quality: isNum(e.quality) ? clamp(e.quality, 0.1, 1) : 0.92,
    fit: max > 0,
    fitMB: max > 0 ? round2(max / 1e6) : 2,
    png8: false,
  };
}

// Saved or partial settings -> complete, valid settings.
export function normalizeExportSettings(raw, preset, docWidth) {
  const d = exportDefaults(preset);
  const r = raw && typeof raw === "object" ? raw : {};
  const scale = String(r.scale ?? "");
  return {
    type: EXPORT_TYPES.includes(r.type) ? r.type : d.type,
    scale: SCALES.includes(scale) ? scale : d.scale,
    width: isNum(r.width) && r.width >= 16 ? Math.round(clamp(r.width, 16, MAX_EXPORT_SIDE)) : Math.round(docWidth || d.width),
    quality: isNum(r.quality) ? clamp(r.quality, 0.1, 1) : d.quality,
    fit: typeof r.fit === "boolean" ? r.fit : d.fit,
    fitMB: isNum(r.fitMB) && r.fitMB > 0 ? clamp(r.fitMB, 0.05, 500) : d.fitMB,
    png8: typeof r.png8 === "boolean" ? r.png8 : d.png8,
  };
}

// Output size for a design. Height follows the width the same way
// renderToCanvas computes it, and both stay under the browser's canvas limits.
export function exportDims(docW, docH, { scale = "1", width } = {}) {
  let w = scale === "custom" ? Math.round(clamp(Number(width) || docW, 16, MAX_EXPORT_SIDE)) : Math.round(docW * (Number(scale) || 1));
  w = Math.max(1, w);
  const hOf = (x) => Math.max(1, Math.round(docH * (x / docW)));
  let h = hOf(w);
  let capped = false;
  const limit = Math.min(1, MAX_EXPORT_SIDE / Math.max(w, h), Math.sqrt(MAX_EXPORT_PIXELS / (w * h)));
  if (limit < 1) {
    capped = true;
    w = Math.max(1, Math.floor(w * limit));
    h = hOf(w);
  }
  while (w > 1 && (h > MAX_EXPORT_SIDE || w * h > MAX_EXPORT_PIXELS)) {
    capped = true;
    w--;
    h = hOf(w);
  }
  return { width: w, height: h, capped };
}

// The file size to check against: the preset's limit, or the "fit under"
// target, whichever is smaller. null when there is none.
export function sizeLimit(preset, settings) {
  const p = isNum(preset?.export?.maxBytes) && preset.export.maxBytes > 0 ? preset.export.maxBytes : null;
  const f = settings?.fit && settings.fitMB > 0 ? Math.round(settings.fitMB * 1e6) : null;
  if (p && f) return Math.min(p, f);
  return p || f || null;
}

// "2 MB" for round limits, else formatBytes.
export function limitLabel(bytes) {
  if (bytes >= 1e6 && bytes % 1e5 === 0) return `${bytes / 1e6} MB`;
  if (bytes >= 1e3 && bytes < 1e6 && bytes % 1e3 === 0) return `${bytes / 1e3} KB`;
  return formatBytes(bytes);
}

export function platformLimits(preset) {
  if (!preset) return null;
  const base = PLATFORM_LIMITS[preset.id] || {};
  const e = preset.export || {};
  const out = { ...base };
  for (const k of ["minWidth", "minHeight", "maxSide"]) if (isNum(e[k]) && e[k] > 0) out[k] = e[k];
  return Object.keys(out).length ? out : null;
}

// The smallest size "Fit under" may shrink to: the platform's hard minimum
// (a soft one only looks worse, so it does not stop the shrinking).
export function shrinkFloor(preset) {
  const lim = platformLimits(preset);
  if (!lim || lim.soft) return { minWidth: 0, minHeight: 0 };
  return { minWidth: lim.minWidth || 0, minHeight: lim.minHeight || 0 };
}

function joinOr(list) {
  if (list.length <= 1) return list.join("");
  return `${list.slice(0, -1).join(", ")} or ${list[list.length - 1]}`;
}

// What to tell the user about this export. kind "warn" needs attention,
// "info" explains. Never blocks.
export function exportWarnings({ preset = null, settings, dims, result = null, transparent = false }) {
  const out = [];
  const label = preset?.label || "";
  const lim = platformLimits(preset);
  // A file "Fit under" shrank is checked at the size it really has.
  const size = result && result.scale < 1 && result.width > 0 && result.height > 0 ? { width: result.width, height: result.height } : dims;
  if (lim && label) {
    const lowW = lim.minWidth && size.width < lim.minWidth;
    const lowH = lim.minHeight && size.height < lim.minHeight;
    if (lowW || lowH) {
      let need;
      if (lim.minWidth && lim.minHeight) need = `${lim.minWidth} × ${lim.minHeight} px`;
      else if (lim.minWidth) need = `${lim.minWidth} px wide`;
      else need = `${lim.minHeight} px tall`;
      const text = lim.soft ? `${label} looks best at ${need} or larger.` : `${label} needs at least ${need}.`;
      out.push({ kind: "warn", text });
    }
    if (lim.maxSide && Math.max(size.width, size.height) > lim.maxSide) {
      out.push({ kind: "warn", text: `${label} takes up to ${lim.maxSide} px per side.` });
    }
  }
  const formats = preset?.export?.formats || [];
  if (label && formats.length && !formats.includes(settings.type)) {
    out.push({ kind: "warn", text: `${label} takes ${joinOr(formats.map(labelFor))}.` });
  }
  if (transparent && settings.type === "image/jpeg") {
    out.push({ kind: "info", text: "JPG has no transparency, so see-through areas turn white." });
  }
  if (dims.capped) {
    out.push({ kind: "info", text: `Capped at ${dims.width} × ${dims.height}, the largest this browser can export.` });
  } else if (dims.width * dims.height > LARGE_EXPORT_PIXELS) {
    out.push({ kind: "info", text: "A very large export. It can take a few seconds." });
  }
  if (result) {
    const presetMax = isNum(preset?.export?.maxBytes) && preset.export.maxBytes > 0 ? preset.export.maxBytes : null;
    // What the encoder aimed for: the user's Fit under number, as typed.
    const target = settings.fit && settings.fitMB > 0 ? Math.round(settings.fitMB * 1e6) : null;
    if (target && result.fits === false) {
      out.push({ kind: "warn", text: `Could not get under ${limitLabel(target)}. This is the smallest it gets.` });
    } else if (target && result.scale < 1) {
      out.push({ kind: "info", text: `Shrunk to ${result.width} × ${result.height} to fit under ${limitLabel(target)}.` });
    }
    if (presetMax && result.bytes > presetMax) {
      const over = `Over the ${limitLabel(presetMax)} limit${label ? ` for ${label}` : ""}.`;
      if (!settings.fit) out.push({ kind: "warn", text: `${over} Turn on Fit under.` });
      else if (target > presetMax) out.push({ kind: "warn", text: `${over} Set Fit under to ${limitLabel(presetMax)} or less.` });
    }
  }
  return out;
}

// What makes two encodes the same. Fields that do not affect the output are left out.
export function settingsKey(settings, dims) {
  const lossy = settings.type !== "image/png";
  return JSON.stringify([
    settings.type,
    dims.width,
    dims.height,
    lossy ? round2(settings.quality) : null,
    settings.fit ? round2(settings.fitMB) : null,
    !lossy && settings.png8,
  ]);
}

export function outputLabel(result) {
  if (!result) return "";
  const type = result.type || result.settings?.type;
  if (type === "image/png") return result.colors ? `PNG · ${result.colors} colors` : "PNG · lossless";
  return `${labelFor(type)} · ${Math.round((result.quality ?? 0.92) * 100)}%`;
}

// A counter that tells stale async results from current ones.
export function latestGuard() {
  let n = 0;
  return {
    next: () => ++n,
    isCurrent: (t) => t === n,
    get value() {
      return n;
    },
  };
}

const FORMAT_HINTS = {
  "image/jpeg": "Smallest for photos. No transparency.",
  "image/png": "Lossless and sharp. Keeps transparency.",
  "image/webp": "Small and keeps transparency. Not every site takes it.",
};

const isAbort = (err) => err?.name === "AbortError" || err?.stale === true;

// ---- copy -----------------------------------------------------------------------

// Mod+Shift+C: the design at 1x as a PNG on the clipboard.
export async function copyDesign(ctx) {
  const doc = ctx.store?.doc;
  if (!doc) return false;
  const canvas = await renderToCanvas(doc, { scale: 1, assets: ctx.assets, fonts: ctx.fonts, background: true });
  const ok = await copyImage(canvas);
  ctx.ui?.toast?.(ok ? "Copied as an image" : "This browser cannot copy images. Use Export instead.", { kind: ok ? "ok" : "warn" });
  return ok;
}

// ---- the dialog -----------------------------------------------------------------

let current = null;

const OPTION_KEYS = ["type", "scale", "width", "quality", "fit", "fitMB", "png8"];

export function openExportDialog(ctx, opts = {}) {
  if (current && !current.sheet.closed) return current.handle;
  const store = ctx.store;
  if (!store?.doc) {
    ctx.ui?.toast?.("Open a design first.", { kind: "warn" });
    return { close() {} };
  }
  ensureIcons();

  let doc = store.doc;
  const preset = ctx.presets?.get?.(doc.preset) || null;
  const pkey = presetKey(doc);
  const all = ctx.prefs?.get?.("exportByPreset", {}) || {};
  const overrides = {};
  for (const k of OPTION_KEYS) if (opts && opts[k] !== undefined) overrides[k] = opts[k];
  let s = normalizeExportSettings({ ...(all[pkey] || {}), ...overrides }, preset, doc.width);

  const d = disposer();
  const guard = latestGuard();
  let docRev = 0;
  let renderCache = null;
  let result = null;
  let inflight = null;
  let shownCanvas = null;
  let bitmap = null;
  let error = "";
  let nameEdited = false;
  let saving = false;
  let copiedTimer = 0;
  let pending = false;

  const transparent = () => doc.background?.kind === "transparent";
  const dimsNow = () => exportDims(doc.width, doc.height, s);
  // Encodes are reused only for the same settings, size and document revision.
  const keyNow = () => `${settingsKey(s, dimsNow())}#${docRev}`;

  const sheet = openSheet({
    label: "Export",
    className: "xp-export",
    ui: ctx.ui,
    onClose() {
      persistLater.cancel();
      persist();
      d.dispose();
      inflight?.controller.abort();
      guard.next();
      compare.destroy();
      bitmap?.close?.();
      clearTimeout(copiedTimer);
      if (current?.sheet === sheet) current = null;
    },
    onKeyDown(e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        doDownload();
        return true;
      }
      return false;
    },
  });

  // ---- header
  const chip = h("span", { class: "chip", "data-tip": preset?.note || null }, `${preset?.label || "Custom size"} · ${doc.width} × ${doc.height}`);
  const head = h(
    "header",
    { class: "xp-head" },
    h("h2", { class: "xp-title" }, "Export"),
    chip,
    h("div", { class: "xp-head-end" }, iconButton({ icon: "x", tip: "Close", kbd: "Esc", onClick: () => sheet.close() })),
  );

  // ---- preview
  const compare = createCompare({ checker: transparent() });
  const hintCompare = h("span", null, "Drag the line to compare. ");
  const hint = h("div", { class: "xp-preview-hint" }, hintCompare, h("span", { class: "xp-hint-zoom" }, "Click to view at 100%."));
  const errorBox = h("div", { class: "xp-preview-error", role: "alert", hidden: true });
  const preview = h("div", { class: "xp-preview" }, compare.el, hint, errorBox);

  // ---- settings
  const fmt = segmented({
    full: true,
    value: s.type,
    options: [
      { value: "image/jpeg", label: "JPG" },
      { value: "image/png", label: "PNG" },
      { value: "image/webp", label: "WebP" },
    ],
    onChange: (v) => set({ type: v }),
  });
  const fmtHint = h("p", { class: "xp-hint" });

  const scaleSeg = segmented({
    full: true,
    value: s.scale,
    options: [
      { value: "0.5", label: "0.5×" },
      { value: "1", label: "1×" },
      { value: "2", label: "2×" },
      { value: "3", label: "3×" },
      { value: "custom", label: "Custom" },
    ],
    onChange: (v) => {
      if (v === "custom" && s.scale !== "custom") set({ scale: v, width: dimsNow().width });
      else set({ scale: v });
    },
  });
  const customW = number({ label: "W", value: s.width, min: 16, max: MAX_EXPORT_SIDE, step: 1, tip: "Width in pixels", onChange: (v) => set({ width: v }) });
  const customH = h("span", { class: "xp-custom-h num" });
  const customRow = h("div", { class: "xp-custom" }, customW, h("span", { class: "qt-x" }, "×"), customH);
  const dimsLine = h("div", { class: "xp-dims num" });

  const quality = slider({
    label: "Quality",
    min: 10,
    max: 100,
    step: 1,
    unit: "%",
    value: Math.round(s.quality * 100),
    defaultValue: Math.round(exportDefaults(preset).quality * 100),
    onInput: (v) => set({ quality: v / 100 }),
    onChange: (v) => set({ quality: v / 100 }),
  });
  const fitMB = number({
    value: s.fitMB,
    min: 0.05,
    max: 500,
    step: 0.1,
    unit: " MB",
    width: 96,
    tip: "Largest file size",
    onInput: (v) => set({ fitMB: v }),
    onChange: (v) => set({ fitMB: v }),
  });
  const fitRow = switchRow("Fit under", s.fit, (b) => set({ fit: b }), fitMB, "Lower the quality until the file fits");
  const png8Row = switchRow("Smaller PNG (256 colors)", s.png8, (b) => set({ png8: b }), null, "A 256-color palette. Often 60 to 80% smaller.");

  const nameInput = h("input", { type: "text", class: "xp-name-input", spellcheck: "false", autocomplete: "off", "aria-label": "File name" });
  const nameExt = h("span", { class: "xp-name-ext num" });
  const nameField = h("label", { class: "xp-name" }, nameInput, nameExt);
  nameInput.addEventListener("input", () => {
    nameEdited = nameInput.value.trim() !== "" && nameInput.value !== exportBaseName(doc.name, dimsNow().width, dimsNow().height);
  });
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doDownload();
    }
  });

  // ---- estimate + actions
  const estNum = h("span", { class: "xp-est-num num" }, "…");
  const estUnit = h("span", { class: "xp-est-unit" });
  const badge = h("span", { class: "xp-badge", hidden: true });
  const estDetail = h("div", { class: "xp-est-detail num" });
  const est = h(
    "div",
    { class: "xp-est", "aria-live": "polite" },
    h("div", { class: "xp-est-head" }, h("span", { class: "micro" }, "File size"), h("span", { class: "xp-est-busy" }, h("span", { class: "xp-spin" }), "Measuring")),
    h("div", { class: "xp-est-line" }, h("span", { class: "xp-est-value" }, estNum, estUnit), badge),
    estDetail,
  );
  const warnList = h("ul", { class: "xp-warn" });

  const copyBtn = button({ label: "Copy image", icon: "copy", onClick: () => doCopy() });
  const downloadBtn = button({ label: "Download", icon: "download", kind: "primary", big: true, tip: "Download", kbd: keysLabel("Mod+Enter"), onClick: () => doDownload() });
  downloadBtn.setAttribute("data-autofocus", "");
  downloadBtn.classList.add("xp-download");

  const settingsCol = h(
    "div",
    { class: "xp-side-scroll" },
    h("div", { class: "xp-group" }, h("div", { class: "micro" }, "Format"), fmt, fmtHint),
    h("div", { class: "xp-group" }, h("div", { class: "micro" }, "Size"), scaleSeg, customRow, dimsLine),
    h("div", { class: "xp-group xp-compress" }, quality, fitRow, png8Row),
    h("div", { class: "xp-group" }, h("div", { class: "micro" }, "File name"), nameField),
  );
  const side = h(
    "aside",
    { class: "xp-side" },
    settingsCol,
    h("div", { class: "xp-side-foot" }, est, warnList, h("div", { class: "xp-actions" }, copyBtn, downloadBtn)),
  );
  const body = h("div", { class: "xp-export-body" }, preview, side);
  sheet.panel.append(head, body);

  // ---- state -> UI

  function persist() {
    const prev = ctx.prefs?.get?.("exportByPreset", {}) || {};
    ctx.prefs?.set?.("exportByPreset", { ...prev, [pkey]: { ...s } });
  }

  const persistLater = debounce(persist, 400);

  function set(patch) {
    s = normalizeExportSettings({ ...s, ...patch }, preset, doc.width);
    persistLater();
    paintControls();
    schedule();
  }

  function paintControls() {
    const dims = dimsNow();
    const lossy = s.type !== "image/png";
    fmt.value = s.type;
    fmtHint.textContent = FORMAT_HINTS[s.type] || "";
    scaleSeg.value = s.scale;
    customRow.hidden = s.scale !== "custom";
    customW.value = s.width;
    customH.textContent = `${dims.height} px`;
    dimsLine.textContent = `${dims.width} × ${dims.height} px`;
    quality.hidden = !lossy;
    png8Row.hidden = lossy;
    fitRow.sw.value = s.fit;
    fitMB.setDisabled(!s.fit);
    nameExt.textContent = `.${extFor(s.type)}`;
    if (!nameEdited) nameInput.value = exportBaseName(doc.name, dims.width, dims.height);
    compare.setChecker(transparent());
    hintCompare.hidden = !(lossy || s.png8);
    paintResult();
  }

  function paintResult() {
    const dims = dimsNow();
    const fresh = !!result && result.key === keyNow();
    const show = result;
    const busy = !!inflight || pending;
    est.classList.toggle("busy", busy);
    est.classList.toggle("stale", !fresh);
    compare.setBusy(busy && !!shownCanvas);
    if (show) {
      const [n, unit] = formatBytes(show.bytes).split(" ");
      estNum.textContent = n;
      estUnit.textContent = unit || "";
      estDetail.textContent = `${show.width} × ${show.height} · ${outputLabel(show)}`;
    } else {
      estNum.textContent = "…";
      estUnit.textContent = "";
      estDetail.textContent = `${dims.width} × ${dims.height}`;
    }
    const limit = sizeLimit(preset, s);
    badge.hidden = !(show && limit);
    if (show && limit) {
      const ok = show.bytes <= limit;
      badge.className = `xp-badge ${ok ? "ok" : "bad"}`;
      badge.replaceChildren(icon(ok ? "check" : "alert-triangle", { size: "sm" }), `${ok ? "Under" : "Over"} ${limitLabel(limit)}`);
    }
    const warnings = exportWarnings({ preset, settings: s, dims, result: fresh ? result : null, transparent: transparent() });
    if (error) warnings.unshift({ kind: "error", text: error });
    warnList.replaceChildren(
      ...warnings.map((w) => h("li", { class: w.kind }, icon(w.kind === "info" ? "info" : "alert-triangle", { size: "sm" }), h("span", null, w.text))),
    );
    warnList.hidden = !warnings.length;
  }

  // ---- rendering and encoding

  function getRender(dims) {
    if (renderCache && renderCache.width === dims.width && renderCache.rev === docRev) return renderCache.promise;
    const promise = renderToCanvas(doc, { width: dims.width, assets: ctx.assets, fonts: ctx.fonts, background: true });
    renderCache = { width: dims.width, rev: docRev, promise };
    promise.catch(() => {
      if (renderCache?.promise === promise) renderCache = null;
    });
    return promise;
  }

  async function showOutput(out) {
    const lossy = out.type !== "image/png" || !!out.colors;
    if (!lossy) {
      compare.setAfter(null);
      bitmap?.close?.();
      bitmap = null;
      return;
    }
    try {
      const bmp = await createImageBitmap(out.blob);
      if (result !== out || sheet.closed) {
        bmp.close?.();
        return;
      }
      const old = bitmap;
      bitmap = bmp;
      compare.setAfter(bmp, outputLabel(out));
      old?.close?.();
    } catch {
      compare.setAfter(null);
    }
  }

  function run() {
    pending = false;
    const dims = dimsNow();
    const key = keyNow();
    if (result?.key === key) {
      paintResult();
      return Promise.resolve(result);
    }
    if (inflight?.key === key) return inflight.promise;
    inflight?.controller.abort();
    const token = guard.next();
    const controller = new AbortController();
    const settings = { ...s };
    const stale = () => Object.assign(Error("Stale"), { stale: true });
    const promise = (async () => {
      const canvas = await getRender(dims).catch((err) => {
        console.error(err);
        throw Error(dims.width * dims.height > 4e6 ? "Could not draw the design at this size. Try a smaller size." : "Could not draw the design. Try again in a moment.");
      });
      if (!guard.isCurrent(token)) throw stale();
      if (shownCanvas !== canvas) {
        shownCanvas = canvas;
        compare.setBefore(canvas, "Original");
      }
      const r = await encodeToTarget(canvas, {
        type: settings.type,
        maxBytes: settings.fit ? Math.round(settings.fitMB * 1e6) : 0,
        quality: settings.quality,
        colors: settings.type === "image/png" && settings.png8 ? 256 : null,
        background: settings.type === "image/jpeg" ? flattenColor(doc) : null,
        signal: controller.signal,
        ...shrinkFloor(preset),
      });
      if (!guard.isCurrent(token)) throw stale();
      const out = { ...r, key, settings, dims };
      result = out;
      error = "";
      errorBox.hidden = true;
      showOutput(out);
      return out;
    })();
    inflight = { key, promise, controller };
    paintResult();
    promise
      .catch((err) => {
        if (!guard.isCurrent(token) || isAbort(err)) return;
        error = err?.message || "Could not make this image.";
        errorBox.textContent = error;
        errorBox.hidden = !!shownCanvas;
      })
      .finally(() => {
        if (inflight?.promise === promise) inflight = null;
        if (!sheet.closed) paintResult();
      });
    return promise;
  }

  const runLater = debounce(run, ESTIMATE_DELAY);
  function schedule() {
    pending = true;
    paintResult();
    runLater();
  }

  // The result for the current settings, waiting for (or starting) the encode.
  async function ensureResult() {
    runLater.cancel();
    for (let i = 0; i < 4; i++) {
      try {
        const r = await run();
        if (r.key === keyNow()) return r;
      } catch (err) {
        if (!err?.stale) throw err;
      }
    }
    return run();
  }

  // The suggested name carries the size; a file "Fit under" shrank gets its real one.
  function fileName(r) {
    const dims = dimsNow();
    const auto = exportBaseName(doc.name, dims.width, dims.height);
    let base = nameInput.value.trim() || auto;
    if (base === auto && r?.scale < 1 && r.width > 0) base = exportBaseName(doc.name, r.width, r.height);
    return safeFileName(base, s.type);
  }

  async function doDownload() {
    if (saving || sheet.closed) return;
    saving = true;
    downloadBtn.setDisabled(true);
    downloadBtn.setLabel("Saving");
    try {
      const r = await ensureResult();
      if (sheet.closed) return;
      const name = fileName(r);
      download(r.blob, name);
      sheet.close();
      ctx.ui?.toast?.(`Saved ${name} · ${formatBytes(r.bytes)}`, { kind: "ok" });
    } catch (err) {
      if (sheet.closed) return;
      error = err?.message || "Could not save the image.";
      paintResult();
    } finally {
      saving = false;
      if (!sheet.closed) {
        downloadBtn.setDisabled(false);
        downloadBtn.setLabel("Download");
      }
    }
  }

  async function doCopy() {
    copyBtn.setDisabled(true);
    try {
      const canvas = await getRender(dimsNow());
      const ok = await copyImage(canvas);
      if (sheet.closed) return;
      if (!ok) {
        error = "This browser cannot copy images. Use Download instead.";
        paintResult();
        return;
      }
      copyBtn.classList.add("done");
      copyBtn.setLabel("Copied");
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => {
        copyBtn.classList.remove("done");
        copyBtn.setLabel("Copy image");
      }, 1600);
    } catch (err) {
      if (!sheet.closed) {
        error = err?.message || "Could not copy the image.";
        paintResult();
      }
    } finally {
      if (!sheet.closed) copyBtn.setDisabled(false);
    }
  }

  // Fonts that finish loading (or autosave remeasures) re-render the preview.
  d(
    on(store, "change", (e) => {
      if (e.detail?.transient) return;
      doc = store.doc;
      docRev++;
      renderCache = null;
      result = null;
      schedule();
    }),
  );

  canEncode("image/webp").then((ok) => {
    if (ok || sheet.closed) return;
    const b = [...fmt.querySelectorAll(".seg")].find((x) => x.textContent === "WebP");
    if (b) {
      b.disabled = true;
      b.setAttribute("data-tip", "This browser cannot save WebP");
    }
    if (s.type === "image/webp") set({ type: exportDefaults(preset).type === "image/webp" ? "image/png" : exportDefaults(preset).type });
  });

  paintControls();
  run();
  sheet.focus(downloadBtn);

  const handle = { close: () => sheet.close() };
  current = { sheet, handle };
  return handle;
}

// ---- commands -------------------------------------------------------------------

export function registerExportCommands(ctx) {
  ensureIcons();
  const d = disposer();
  const hasDoc = (c) => !!c.store?.doc;
  const reg = (def) => d(ctx.commands.register(def));
  reg({
    id: "file.export",
    title: "Export",
    group: "File",
    keys: ["Mod+E"],
    icon: "download",
    keywords: "download save jpg jpeg png webp image file size compress",
    when: hasDoc,
    run: (c, args) => openExportDialog(c, args || {}),
  });
  reg({
    id: "file.copy-image",
    title: "Copy image",
    group: "File",
    keys: ["Mod+Shift+C"],
    icon: "copy",
    keywords: "clipboard png copy as image",
    when: hasDoc,
    run: (c) => copyDesign(c),
  });
  reg({
    id: "view.feed-preview",
    title: "Preview in a feed",
    group: "View",
    keys: ["F"],
    icon: "play-rect",
    keywords: "youtube spotify mock home search sidebar up next phone real size",
    when: hasDoc,
    run: (c) => openFeedPreview(c),
  });
  reg({
    id: "tools.compress",
    title: "Compress images",
    group: "Tools",
    icon: "minimize-2",
    keywords: "shrink smaller file size optimize optimize jpg png webp batch",
    run: (c, args) => openQuickTool("compress", c, args || {}),
  });
  reg({
    id: "tools.remove-bg",
    title: "Remove a background",
    group: "Tools",
    icon: "remove-bg",
    keywords: "cutout cut out transparent png erase background",
    run: (c, args) => openQuickTool("remove-bg", c, args || {}),
  });
  reg({
    id: "tools.convert",
    title: "Resize or convert images",
    group: "Tools",
    icon: "scaling",
    keywords: "scale format jpg png webp 1280x720 square batch",
    run: (c, args) => openQuickTool("convert", c, args || {}),
  });

  ctx.ui = ctx.ui || {};
  const mine = {
    openExport: (opts) => openExportDialog(ctx, opts || {}),
    openFeedPreview: () => openFeedPreview(ctx),
    openQuickTool: (kind, opts) => openQuickTool(kind, ctx, opts || {}),
  };
  Object.assign(ctx.ui, mine);
  d(() => {
    for (const [k, fn] of Object.entries(mine)) if (ctx.ui[k] === fn) delete ctx.ui[k];
  });
  return d.dispose;
}
