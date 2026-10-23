// Quick tools: one dialog with three tabs (compress images, remove a
// background, resize or convert). Everything runs on this computer.
//
// This module also holds the small pieces the export dialog and the feed
// preview share: the sheet (modal), file drop / paste / pick, the before and
// after compare view, and the icons these screens use.

import { h, on, disposer, debounce } from "./dom.js";
import { icon, hasIcon, registerIcons } from "./icons.js";
import { segmented, slider, number, toggle, button, iconButton } from "./controls.js";
import {
  encode,
  encodeToTarget,
  resizeCanvas,
  fileToCanvas,
  readImageFile,
  formatBytes,
  download,
  copyImage,
  makeZip,
  canEncode,
  safeFileName,
} from "../features/compress.js";
import { createDoc, createLayer } from "../core/model.js";

// ---- icons ------------------------------------------------------------------

// Lucide paths (ISC). Only names the shell's set does not already have are added.
const ICON_SET = {
  download: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
  upload: '<path d="M12 3v12"/><path d="m17 8-5-5-5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>',
  "minimize-2": '<path d="m14 10 7-7"/><path d="M20 10h-6V4"/><path d="m3 21 7-7"/><path d="M4 14h6v6"/>',
  scaling: '<path d="M21 3 9 15"/><path d="M12 3H3v18h18v-9"/><path d="M16 3h5v5"/><path d="M14 15H9v-5"/>',
  "square-pen": '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>',
  "alert-triangle": '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  menu: '<path d="M4 12h16"/><path d="M4 6h16"/><path d="M4 18h16"/>',
  bell: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
  mic: '<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/>',
  "more-vertical": '<circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>',
  play: '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>',
  home: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  smartphone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
  library: '<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>',
  cast: '<path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/><path d="M2 12a9 9 0 0 1 8 8"/><path d="M2 16a5 5 0 0 1 4 4"/><path d="M2 20h.01"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  "skip-back": '<path d="M17.971 4.285A2 2 0 0 1 21 6v12a2 2 0 0 1-3.029 1.715l-9.997-5.998a2 2 0 0 1-.003-3.432z"/><path d="M3 20V4"/>',
  "skip-forward": '<path d="M21 4v16"/><path d="M6.029 4.285A2 2 0 0 0 3 6v12a2 2 0 0 0 3.029 1.715l9.997-5.998a2 2 0 0 0 .003-3.432z"/>',
  shuffle: '<path d="m18 14 4 4-4 4"/><path d="m18 2 4 4-4 4"/><path d="M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-7.6a4 4 0 0 1 3.3-1.7H22"/><path d="M2 6h1.972a4 4 0 0 1 3.6 2.2"/><path d="M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45"/>',
  "plus-circle": '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>',
  "chevrons-left-right": '<path d="m9 7-5 5 5 5"/><path d="m15 7 5 5-5 5"/>',
  "chevron-left": '<path d="m15 18-6-6 6-6"/>',
  "zoom-in": '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/><path d="M11 8v6"/><path d="M8 11h6"/>',
};

export function ensureIcons() {
  const missing = {};
  for (const [k, v] of Object.entries(ICON_SET)) if (!hasIcon(k)) missing[k] = v;
  registerIcons(missing);
}

// ---- pure helpers -----------------------------------------------------------

const IMAGE_EXT = /\.(png|jpe?g|jfif|webp|gif|avif|bmp|svg)$/i;
const TYPE_BY_EXT = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};
export const ACCEPT_IMAGES = "image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp,image/svg+xml,.png,.jpg,.jpeg,.jfif,.webp,.gif,.avif,.bmp,.svg";
export const OUTPUT_TYPES = ["image/jpeg", "image/png", "image/webp"];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, fallback) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

export function isImageFile(file) {
  if (!file) return false;
  return String(file.type || "").toLowerCase().startsWith("image/") || IMAGE_EXT.test(file.name || "");
}

// The file's image type, from its MIME type or else its extension.
export function fileType(file) {
  const t = String(file?.type || "").toLowerCase();
  if (t === "image/jpg" || t === "image/pjpeg") return "image/jpeg";
  if (t.startsWith("image/")) return t;
  const m = IMAGE_EXT.exec(file?.name || "");
  return m ? TYPE_BY_EXT[m[1].toLowerCase()] : "";
}

// "keep" keeps JPG and WebP; every other source (PNG, GIF, AVIF, BMP, SVG)
// becomes PNG. WebP also becomes PNG (it keeps transparency) when this
// browser cannot write WebP (webpOk false).
export function outputTypeFor(choice, sourceType, { webpOk = true } = {}) {
  if (OUTPUT_TYPES.includes(choice)) return choice;
  if (sourceType === "image/jpeg" || (sourceType === "image/webp" && webpOk)) return sourceType;
  return "image/png";
}

// "keep" for a WebP file: can this browser write it back as WebP?
const keepWebpOk = (format, srcType) => (format === "keep" && srcType === "image/webp" ? canEncode("image/webp") : true);

export function stripExt(name) {
  const s = String(name ?? "").replace(/^.*[\\/]/, "");
  const i = s.lastIndexOf(".");
  return (i > 0 ? s.slice(0, i) : s).trim();
}

export function outputName(name, type, suffix = "") {
  return safeFileName(`${stripExt(name) || "image"}${suffix}`, type);
}

// Scale (w, h) down to fit inside maxW x maxH, keeping the aspect. Never enlarges.
// A missing or zero limit means no limit on that side.
export function fitWithin(w, h, maxW, maxH) {
  const mw = maxW > 0 ? maxW : Infinity;
  const mh = maxH > 0 ? maxH : Infinity;
  const s = Math.min(1, mw / w, mh / h);
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)), scaled: s < 1 };
}

// Whole percent saved; negative when the output is bigger. Only an empty
// output reads as 100%.
export function percentSaved(before, after) {
  if (!(before > 0) || !(after >= 0)) return 0;
  const p = Math.round((1 - after / before) * 100);
  return after > 0 && p >= 100 ? 99 : p;
}

// rows: [{ size, out: { bytes } | null }]
export function batchTotals(rows) {
  let before = 0;
  let after = 0;
  let done = 0;
  for (const r of rows) {
    if (!r.out) continue;
    before += r.size;
    after += r.out.bytes;
    done++;
  }
  return { count: rows.length, done, before, after, saved: percentSaved(before, after) };
}

export const CONVERT_SIZES = [
  { id: "original", label: "Original size" },
  { id: "1280x720", label: "YouTube thumbnail", width: 1280, height: 720 },
  { id: "1920x1080", label: "Full HD", width: 1920, height: 1080 },
  { id: "1080x1080", label: "Square post", width: 1080, height: 1080 },
  { id: "1080x1920", label: "Vertical", width: 1080, height: 1920 },
  { id: "3000x3000", label: "Podcast cover", width: 3000, height: 3000 },
  { id: "custom", label: "Custom" },
];

// Target size for the resize tool, or null to keep the original size.
export function convertTarget(settings) {
  if (settings?.size === "custom") {
    return { width: Math.round(clamp(num(settings.width, 1280), 1, 8000)), height: Math.round(clamp(num(settings.height, 720), 1, 8000)) };
  }
  const p = CONVERT_SIZES.find((s) => s.id === settings?.size);
  return p?.width ? { width: p.width, height: p.height } : null;
}

const choice = (v, list, fallback) => (list.includes(v) ? v : fallback);
const FORMAT_CHOICES = ["keep", ...OUTPUT_TYPES];

export function normalizeCompressSettings(raw = {}) {
  return {
    format: choice(raw.format, FORMAT_CHOICES, "keep"),
    quality: clamp(num(raw.quality, 0.8), 0.1, 1),
    fit: raw.fit === true,
    fitMB: clamp(num(raw.fitMB, 2), 0.05, 200),
    limit: raw.limit === true,
    maxW: Math.round(clamp(num(raw.maxW, 1920), 16, 8000)),
    maxH: Math.round(clamp(num(raw.maxH, 1920), 16, 8000)),
    png8: raw.png8 !== false,
  };
}

export function normalizeConvertSettings(raw = {}) {
  return {
    size: choice(raw.size, CONVERT_SIZES.map((s) => s.id), "1280x720"),
    width: Math.round(clamp(num(raw.width, 1280), 1, 8000)),
    height: Math.round(clamp(num(raw.height, 720), 1, 8000)),
    fit: choice(raw.fit, ["cover", "contain", "stretch"], "cover"),
    bars: choice(raw.bars, ["black", "white", "clear"], "black"),
    format: choice(raw.format, FORMAT_CHOICES, "keep"),
    quality: clamp(num(raw.quality, 0.92), 0.1, 1),
  };
}

// ---- processing (browser) ---------------------------------------------------

const abortError = () => (typeof DOMException === "function" ? new DOMException("Cancelled", "AbortError") : Object.assign(Error("Cancelled"), { name: "AbortError" }));
const isAbort = (err) => err?.name === "AbortError" || err?.code === "cancelled";
const checkAbort = (signal) => {
  if (signal?.aborted) throw abortError();
};

// Compress one file. Never hands back something bigger than the original
// when nothing else (type, size) changed: then the original is kept. Also
// kept when only the browser's canvas limit would shrink it (keptWhy
// "capped"): shrinking is for Limit size to do. srcW / srcH are the file's
// natural size; capped says the output was shrunk to the browser's limit.
export async function compressFile(file, settings, signal) {
  const s = normalizeCompressSettings(settings);
  const img = await readImageFile(file);
  checkAbort(signal);
  const src = img.canvas;
  const srcW = img.naturalWidth;
  const srcH = img.naturalHeight;
  const userShrink = s.limit && fitWithin(srcW, srcH, s.maxW, s.maxH).scaled;
  let canvas = src;
  if (s.limit) {
    const t = fitWithin(src.width, src.height, s.maxW, s.maxH);
    if (t.scaled) canvas = resizeCanvas(src, t.width, t.height);
  }
  const srcType = fileType(file);
  const webpOk = await keepWebpOk(s.format, srcType);
  checkAbort(signal);
  const type = outputTypeFor(s.format, srcType, { webpOk });
  const res = await encodeToTarget(canvas, {
    type,
    maxBytes: s.fit ? Math.round(s.fitMB * 1e6) : 0,
    quality: s.quality,
    colors: type === "image/png" && s.png8 ? 256 : null,
    signal,
  });
  checkAbort(signal);
  // Same format (WebP the browser can only write as PNG counts) and no size
  // change the user asked for.
  const sameShape = (type === srcType || !webpOk) && !userShrink && res.width === canvas.width && res.height === canvas.height;
  if (sameShape && (img.capped || res.blob.size >= file.size) && (!s.fit || file.size <= s.fitMB * 1e6)) {
    return { blob: file, bytes: file.size, type: srcType, name: file.name, kept: true, keptWhy: img.capped ? "capped" : "smaller", fits: true, srcW, srcH, width: srcW, height: srcH, capped: false };
  }
  return {
    blob: res.blob,
    bytes: res.blob.size,
    type: res.blob.type || type,
    name: outputName(file.name, res.blob.type || type),
    kept: false,
    fits: res.fits,
    srcW,
    srcH,
    width: res.width,
    height: res.height,
    capped: img.capped && !userShrink && res.scale === 1,
  };
}

const BAR_COLORS = { black: "#000000", white: "#ffffff" };

export async function convertFile(file, settings, signal) {
  const s = normalizeConvertSettings(settings);
  const img = await readImageFile(file);
  checkAbort(signal);
  const src = img.canvas;
  const srcType = fileType(file);
  const type = outputTypeFor(s.format, srcType, { webpOk: await keepWebpOk(s.format, srcType) });
  checkAbort(signal);
  const target = convertTarget(s);
  const bars = s.fit === "contain" ? BAR_COLORS[s.bars] || null : null;
  const out = target ? resizeCanvas(src, target.width, target.height, { fit: s.fit, background: bars }) : src;
  const blob = await encode(out, { type, quality: s.quality, background: type === "image/jpeg" ? bars || "#ffffff" : null });
  checkAbort(signal);
  // "Original size" the browser had to shrink: the name says the real size.
  const capped = img.capped && !target;
  return {
    blob,
    bytes: blob.size,
    type,
    name: outputName(file.name, type, target || capped ? `-${out.width}x${out.height}` : ""),
    kept: false,
    fits: true,
    srcW: img.naturalWidth,
    srcH: img.naturalHeight,
    width: out.width,
    height: out.height,
    capped,
  };
}

// ---- sheet (modal) ----------------------------------------------------------

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
// Key events and clipboard events inside a sheet stay inside it, so app
// shortcuts and the editor's paste handler do not act behind the dialog.
const CONTAINED = ["keyup", "keypress", "paste", "copy", "cut", "wheel"];

function trapTab(e, root) {
  const items = [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
  if (!items.length) {
    e.preventDefault();
    root.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && (document.activeElement === first || document.activeElement === root)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

// A modal panel over the app. onKeyDown(e) may return true when it handled
// the key. Escape and clicks on the backdrop close it.
// ui: ctx.ui. The sheet goes on its layer stack, so the app behind is inert
// and ctx.ui.isBlocking() is true while it is open. Escape stays with the
// sheet (onKeyDown may take it first).
export function openSheet({ label, className, onClose, onKeyDown, full = false, ui = null } = {}) {
  ensureIcons();
  const prevFocus = document.activeElement;
  const panel = h("div", { class: ["xp-sheet", className], role: "dialog", "aria-modal": "true", "aria-label": label || "Dialog", tabindex: "-1" });
  const backdrop = h("div", { class: ["xp-backdrop", full && "full"] }, panel);
  const d = disposer();
  let closed = false;
  let downOnBackdrop = false;
  let layer = null;

  const close = () => {
    if (closed) return;
    closed = true;
    // Before focus goes back: an inert element can not take it.
    if (layer) ui.dropLayer?.(layer);
    layer = null;
    d.dispose();
    backdrop.classList.add("closing");
    setTimeout(() => backdrop.remove(), 160);
    try {
      onClose?.();
    } catch (err) {
      console.error(err);
    }
    if (prevFocus?.isConnected && typeof prevFocus.focus === "function") {
      try {
        prevFocus.focus({ preventScroll: true });
      } catch {}
    }
  };

  d(
    on(backdrop, "keydown", (e) => {
      // Stop first: close() removes the other listeners mid-dispatch.
      e.stopPropagation();
      if (onKeyDown?.(e) === true) return;
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        close();
      } else if (e.key === "Tab") {
        trapTab(e, panel);
      }
    }),
  );
  for (const type of CONTAINED) d(on(backdrop, type, (e) => e.stopPropagation(), type === "wheel" ? { passive: true } : undefined));
  d(on(backdrop, "pointerdown", (e) => (downOnBackdrop = e.target === backdrop)));
  d(
    on(backdrop, "click", (e) => {
      if (e.target === backdrop && downOnBackdrop) close();
      downOnBackdrop = false;
    }),
  );

  document.body.append(backdrop);
  if (ui?.pushLayer) layer = ui.pushLayer({ kind: "dialog", el: backdrop, close: () => close(), modal: true, escape: false });
  return {
    el: backdrop,
    panel,
    close,
    get closed() {
      return closed;
    },
    // Focus something inside once the content is in place.
    focus(target) {
      const el = target || panel.querySelector("[data-autofocus]") || panel;
      try {
        el.focus({ preventScroll: true });
      } catch {}
    },
  };
}

// ---- files in: drop, paste, pick ---------------------------------------------

function splitFiles(list) {
  const all = [...(list || [])];
  const images = all.filter(isImageFile);
  return { images, skipped: all.length - images.length };
}

const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");

// Drops on `target` and pastes inside `pasteRoot` call onFiles(files, { skipped }).
export function acceptFiles(target, onFiles, { pasteRoot = target } = {}) {
  let depth = 0;
  const d = disposer();
  const set = (b) => target.classList.toggle("xp-dragging", b);
  d(
    on(target, "dragenter", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      depth++;
      set(true);
    }),
  );
  d(
    on(target, "dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
    }),
  );
  d(
    on(target, "dragleave", (e) => {
      if (!hasFiles(e)) return;
      e.stopPropagation();
      depth = Math.max(0, depth - 1);
      if (!depth) set(false);
    }),
  );
  d(
    on(target, "drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      depth = 0;
      set(false);
      const { images, skipped } = splitFiles(e.dataTransfer.files);
      onFiles(images, { skipped });
    }),
  );
  d(
    on(pasteRoot, "paste", (e) => {
      const { images } = splitFiles(e.clipboardData?.files);
      if (!images.length) return;
      e.preventDefault();
      onFiles(images, { skipped: 0 });
    }),
  );
  return d.dispose;
}

export function pickFiles({ multiple = true } = {}, onFiles) {
  const input = h("input", { type: "file", accept: ACCEPT_IMAGES });
  input.multiple = !!multiple;
  input.addEventListener("change", () => {
    const { images, skipped } = splitFiles(input.files);
    if (images.length || skipped) onFiles(images, { skipped });
  });
  input.click();
}

function dropZone({ title, hint, multiple = true, onFiles }) {
  const pick = () => pickFiles({ multiple }, onFiles);
  const el = h(
    "div",
    { class: "qt-drop" },
    h("div", { class: "qt-drop-icon" }, icon("upload", { size: "lg" })),
    h("div", { class: "qt-drop-title" }, title),
    h("div", { class: "qt-drop-hint" }, hint),
    button({ label: multiple ? "Choose images" : "Choose an image", kind: "primary", big: true, onClick: pick }),
    h("div", { class: "qt-drop-formats" }, "PNG, JPG, WebP, GIF, AVIF, BMP or SVG"),
  );
  el.addEventListener("click", (e) => {
    if (e.target === el) pick();
  });
  return el;
}

// ---- compare view (before | after) --------------------------------------------

const dprNow = () => Math.max(1, Math.min(3, globalThis.devicePixelRatio || 1));

// Two images over each other with a draggable split. Click toggles between
// fit and 100 %; at 100 % drag pans. Sources are canvases or ImageBitmaps;
// the after image is stretched to the before image's size.
export function createCompare({ checker = false, pad = 28 } = {}) {
  ensureIcons();
  const beforeSlot = h("div", { class: "xp-cmp-layer before" });
  const afterSlot = h("div", { class: "xp-cmp-layer after" });
  const handle = h(
    "div",
    { class: "xp-cmp-handle", role: "slider", tabindex: "0", "aria-label": "Before and after", "aria-valuemin": "0", "aria-valuemax": "100", "data-tip": "Drag to compare" },
    h("span", { class: "xp-cmp-knob" }, icon("chevrons-left-right", { size: "sm" })),
  );
  const frame = h("div", { class: "xp-cmp-frame" }, beforeSlot, afterSlot, handle);
  const scroller = h("div", { class: "xp-cmp-scroll" }, frame);
  const tagA = h("span", { class: "xp-cmp-tag a" });
  const tagB = h("span", { class: "xp-cmp-tag b" });
  const zoomText = h("span", { class: "num" }, "100%");
  const zoomPill = h("button", { type: "button", class: "xp-cmp-zoom", "data-tip": "Fit or 100%", "aria-label": "Switch between fit and 100%" }, icon("zoom-in", { size: "sm" }), zoomText);
  const busy = h("span", { class: "xp-cmp-busy" }, h("span", { class: "xp-spin" }), "Updating");
  const el = h("div", { class: ["xp-cmp", "empty", checker && "checker"] }, scroller, tagA, tagB, zoomPill, busy);

  let before = null;
  let after = null;
  let split = 0.5;
  let mode = "fit";
  let fitScale = 1;
  let vBefore = 0;
  let vAfter = 0;
  let keyBefore = "";
  let keyAfter = "";
  let destroyed = false;
  let timer = 0;

  const size = (src) => ({ w: src?.width || 0, h: src?.height || 0 });

  function draw(slot, src, pw, ph) {
    if (!src) {
      slot.replaceChildren();
      return;
    }
    let c;
    const isDomCanvas = typeof HTMLCanvasElement !== "undefined" && src instanceof HTMLCanvasElement;
    if (isDomCanvas && src.width === pw && src.height === ph) c = src;
    else c = resizeCanvas(src, pw, ph);
    c.classList?.add("xp-cmp-img");
    slot.replaceChildren(c);
  }

  function layout() {
    if (destroyed || !before) return;
    const { w: nw, h: nh } = size(before);
    if (!nw || !nh || !scroller.clientWidth) return;
    const aw = Math.max(40, scroller.clientWidth - pad * 2);
    const ah = Math.max(40, scroller.clientHeight - pad * 2);
    fitScale = Math.min(1, aw / nw, ah / nh);
    if (fitScale >= 1 && mode === "actual") mode = "fit";
    const s = mode === "fit" ? fitScale : 1;
    const cw = Math.max(1, Math.round(nw * s));
    const ch = Math.max(1, Math.round(nh * s));
    frame.style.width = `${cw}px`;
    frame.style.height = `${ch}px`;
    const dpr = dprNow();
    const pw = Math.max(1, Math.min(nw, Math.round(cw * dpr)));
    const ph = Math.max(1, Math.min(nh, Math.round(ch * dpr)));
    const kb = `${pw}x${ph}:${vBefore}`;
    const ka = `${pw}x${ph}:${vAfter}`;
    if (kb !== keyBefore) {
      keyBefore = kb;
      draw(beforeSlot, before, pw, ph);
    }
    if (ka !== keyAfter) {
      keyAfter = ka;
      draw(afterSlot, after, pw, ph);
    }
    zoomText.textContent = `${Math.round(s * 100)}%`;
    el.classList.toggle("actual", mode === "actual");
    el.classList.toggle("zoomable", fitScale < 1);
  }

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(layout, 40);
  };

  function setSplit(v) {
    split = clamp(v, 0, 1);
    const pct = `${(split * 100).toFixed(2)}%`;
    afterSlot.style.clipPath = `inset(0 0 0 ${pct})`;
    handle.style.left = pct;
    handle.setAttribute("aria-valuenow", String(Math.round(split * 100)));
  }

  function toggleZoom(e) {
    if (fitScale >= 1) return;
    const r = frame.getBoundingClientRect();
    const fx = e ? clamp((e.clientX - r.left) / r.width, 0, 1) : 0.5;
    const fy = e ? clamp((e.clientY - r.top) / r.height, 0, 1) : 0.5;
    mode = mode === "fit" ? "actual" : "fit";
    layout();
    if (mode === "actual") {
      scroller.scrollLeft = fx * frame.offsetWidth + pad - scroller.clientWidth / 2;
      scroller.scrollTop = fy * frame.offsetHeight + pad - scroller.clientHeight / 2;
    }
  }

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {}
    handle.focus({ preventScroll: true });
    el.classList.add("dragging");
    const move = (ev) => {
      const r = frame.getBoundingClientRect();
      setSplit((ev.clientX - r.left) / r.width);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      el.classList.remove("dragging");
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
  handle.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.2 : 0.05;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") setSplit(split - step);
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") setSplit(split + step);
    else if (e.key === "Home") setSplit(0);
    else if (e.key === "End") setSplit(1);
    else return;
    e.preventDefault();
  });

  frame.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".xp-cmp-handle")) return;
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const sl = scroller.scrollLeft;
    const st = scroller.scrollTop;
    let moved = false;
    try {
      frame.setPointerCapture(e.pointerId);
    } catch {}
    const move = (ev) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      if (mode === "actual") {
        el.classList.add("panning");
        scroller.scrollLeft = sl - dx;
        scroller.scrollTop = st - dy;
      } else if (after) {
        const r = frame.getBoundingClientRect();
        setSplit((ev.clientX - r.left) / r.width);
      }
    };
    const up = (ev) => {
      frame.removeEventListener("pointermove", move);
      frame.removeEventListener("pointerup", up);
      frame.removeEventListener("pointercancel", up);
      el.classList.remove("panning");
      if (!moved && ev.type === "pointerup") toggleZoom(ev);
    };
    frame.addEventListener("pointermove", move);
    frame.addEventListener("pointerup", up);
    frame.addEventListener("pointercancel", up);
  });
  zoomPill.addEventListener("click", () => toggleZoom(null));

  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
  ro?.observe(scroller);
  setSplit(0.5);

  return {
    el,
    setBefore(src, label = "") {
      before = src || null;
      vBefore++;
      tagA.textContent = label;
      el.classList.toggle("empty", !before);
      layout();
      if (before && !scroller.clientWidth) schedule();
    },
    setAfter(src, label = "") {
      after = src || null;
      vAfter++;
      tagB.textContent = label;
      el.classList.toggle("has-after", !!after);
      layout();
    },
    setLabels(a, b) {
      tagA.textContent = a || "";
      tagB.textContent = b || "";
    },
    setBusy(b) {
      el.classList.toggle("busy", !!b);
    },
    setChecker(b) {
      el.classList.toggle("checker", !!b);
    },
    setSplit,
    layout,
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      ro?.disconnect();
    },
  };
}

// ---- shared bits -------------------------------------------------------------

function sectionLabel(text) {
  return h("div", { class: "micro qt-label" }, text);
}

function smallPrint() {
  return h("p", { class: "qt-privacy" }, icon("info", { size: "sm" }), "Nothing is uploaded. Files are processed on this computer.");
}

function formatOptions(webpOk) {
  return [
    { value: "keep", label: "Keep", tip: webpOk ? "Same format as each file" : "Same format as each file. WebP saves as PNG here." },
    { value: "image/jpeg", label: "JPG" },
    { value: "image/webp", label: "WebP", tip: webpOk ? null : "This browser cannot save WebP" },
    { value: "image/png", label: "PNG" },
  ];
}

function disableWebp(seg, ok) {
  if (ok) return;
  const btn = [...seg.querySelectorAll(".seg")].find((b) => b.textContent === "WebP");
  if (btn) {
    btn.disabled = true;
    btn.setAttribute("data-tip", "This browser cannot save WebP");
  }
}

function prefsFor(ctx, key) {
  const all = ctx.prefs?.get?.("quickTools", {}) || {};
  return all && typeof all === "object" ? all[key] || {} : {};
}

function savePrefs(ctx, key, value) {
  const all = { ...(ctx.prefs?.get?.("quickTools", {}) || {}) };
  all[key] = value;
  ctx.prefs?.set?.("quickTools", all);
}

const dims = (w, hgt) => `${w} × ${hgt}`;

const keepQualityLabel = (webpOk) => (webpOk ? "Quality (JPG and WebP)" : "Quality (JPG)");

// After a size the browser's canvas limit chose, not the user.
const cappedNote = () => h("span", { class: "qt-capped", "data-tip": "Shrunk to the largest size this browser can work with" }, "browser limit");

// ---- batch tools (compress, resize or convert) ---------------------------------

function createBatchMode(ctx, cfg) {
  const d = disposer();
  let settings = cfg.load();
  let version = 0;
  let running = false;
  let current = null;
  let note = "";
  const rows = [];
  let nextId = 1;

  const settingsEl = h("aside", { class: "qt-side" });
  const listEl = h("div", { class: "qt-list", role: "list" });
  const progressBar = h("div", { class: "qt-progress-bar" });
  const progressText = h("span", { class: "qt-progress-text" });
  const progress = h("div", { class: "qt-progress" }, progressText, h("div", { class: "qt-progress-track" }, progressBar));
  const noteEl = h("div", { class: "qt-note", role: "status" });
  const addMore = button({ label: "Add images", icon: "plus", kind: "ghost", onClick: () => pickFiles({ multiple: true }, addFiles) });
  const clearAll = button({ label: "Clear", kind: "ghost", onClick: () => removeAll() });
  const listHead = h("div", { class: "qt-list-head" }, progress, h("div", { class: "qt-list-tools" }, addMore, clearAll));
  const summary = h("div", { class: "qt-summary" });
  const downloadBtn = button({ label: "Download all", icon: "download", kind: "primary", onClick: () => downloadAll() });
  const footer = h("div", { class: "qt-foot" }, smallPrint(), h("div", { class: "qt-foot-actions" }, summary, downloadBtn));
  const main = h("div", { class: "qt-main" }, listHead, noteEl, listEl);
  const work = h("div", { class: "qt-work" }, settingsEl, main);
  const empty = dropZone({ title: cfg.emptyTitle, hint: cfg.emptyHint, multiple: true, onFiles: addFiles });
  const body = h("div", { class: "qt-body" }, empty);
  const el = h("div", { class: ["qt-mode", `qt-${cfg.id}`] }, body, footer);

  let webpOk = true;
  canEncode("image/webp").then((ok) => {
    webpOk = ok;
    if (!ok && settings.format === "image/webp") {
      settings = { ...settings, format: "keep" };
      changed();
    }
    paintSettings();
  });

  function paintSettings() {
    settingsEl.replaceChildren(...cfg.settings(settings, update, { webpOk }));
  }

  const saveLater = debounce(() => cfg.save(settings), 400);

  // structural: rebuild the settings panel (which rows show changes).
  function update(patch, { structural = false } = {}) {
    settings = { ...settings, ...patch };
    saveLater();
    if (structural) paintSettings();
    scheduleChanged();
  }

  const scheduleChanged = debounce(() => changed(), 320);
  d(scheduleChanged.cancel);

  function changed() {
    version++;
    current?.controller.abort();
    for (const r of rows) setStatus(r, "waiting");
    paintAll();
    pump();
  }

  function setStatus(row, status) {
    row.status = status;
    if (status === "waiting") row.error = null;
  }

  function addFiles(files, { skipped = 0 } = {}) {
    note = skipped ? `Skipped ${skipped} ${skipped === 1 ? "file that is" : "files that are"} not an image.` : "";
    for (const file of files) {
      const row = {
        id: nextId++,
        file,
        size: file.size,
        url: URL.createObjectURL(file),
        status: "waiting",
        version: -1,
        out: null,
        error: null,
      };
      row.el = rowElement(row);
      rows.push(row);
      listEl.append(row.el);
    }
    paintAll();
    pump();
  }

  function removeRow(row) {
    const i = rows.indexOf(row);
    if (i < 0) return;
    rows.splice(i, 1);
    if (current?.row === row) current.controller.abort();
    URL.revokeObjectURL(row.url);
    row.el.remove();
    paintAll();
  }

  function removeAll() {
    current?.controller.abort();
    for (const r of rows.splice(0)) {
      URL.revokeObjectURL(r.url);
      r.el.remove();
    }
    note = "";
    paintAll();
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      for (;;) {
        const row = rows.find((r) => r.version !== version);
        if (!row) break;
        const v = version;
        const controller = new AbortController();
        current = { row, controller };
        setStatus(row, "working");
        paintRow(row);
        paintProgress();
        try {
          const out = await cfg.process(row.file, settings, controller.signal);
          if (v !== version || !rows.includes(row)) {
            setStatus(row, "waiting");
            continue;
          }
          row.out = out;
          row.status = out.kept ? "kept" : "done";
          row.error = null;
        } catch (err) {
          if (v !== version || !rows.includes(row) || isAbort(err)) {
            setStatus(row, "waiting");
            continue;
          }
          console.error(err);
          row.out = null;
          row.status = "error";
          row.error = err?.message || "This file could not be processed.";
        }
        row.version = v;
        paintRow(row);
        paintProgress();
      }
    } finally {
      running = false;
      current = null;
      paintAll();
    }
  }

  function rowElement(row) {
    const thumb = h("img", { class: "qt-thumb", src: row.url, alt: "", decoding: "async", loading: "lazy", draggable: "false" });
    thumb.addEventListener("error", () => thumb.classList.add("broken"));
    const name = h("div", { class: "qt-name", title: row.file.name }, row.file.name || "Image");
    const meta = h("div", { class: "qt-meta num" });
    const status = h("div", { class: "qt-status" });
    const dl = iconButton({ icon: "download", tip: "Download", size: "sm", onClick: () => row.out && download(row.out.blob, row.out.name) });
    const rm = iconButton({ icon: "x", tip: "Remove", size: "sm", onClick: () => removeRow(row) });
    row.parts = { meta, status, dl };
    return h("div", { class: "qt-row", role: "listitem" }, thumb, h("div", { class: "qt-row-main" }, name, meta), status, h("div", { class: "qt-row-actions" }, dl, rm));
  }

  function paintRow(row) {
    const { meta, status, dl } = row.parts;
    row.el.dataset.status = row.status;
    const out = row.out;
    const fresh = out && row.version === version && (row.status === "done" || row.status === "kept");
    meta.replaceChildren();
    if (fresh) meta.append(...cfg.meta(row, out));
    else meta.append(formatBytes(row.size));
    status.replaceChildren();
    if (row.status === "working") status.append(h("span", { class: "xp-spin" }), h("span", null, cfg.workingLabel));
    else if (row.status === "waiting") status.append(h("span", { class: "qt-wait" }, "Waiting"));
    else if (row.status === "error") status.append(h("span", { class: "qt-err", title: row.error }, row.error));
    else if (row.status === "kept") {
      const tip = out?.keptWhy === "capped" ? "Too large for this browser to recompress without shrinking it" : "The original was already smaller";
      status.append(h("span", { class: "qt-chip", "data-tip": tip }, "Kept original"));
    }
    else if (out) {
      const pct = percentSaved(row.size, out.bytes);
      if (out.fits === false) status.append(h("span", { class: "qt-chip warn", "data-tip": "Could not get under the size limit" }, icon("alert-triangle", { size: "sm" }), "Over limit"));
      else if (pct > 0) status.append(h("span", { class: "qt-chip good" }, `${pct}% smaller`));
      else if (pct < 0) status.append(h("span", { class: "qt-chip warn" }, `${-pct}% bigger`));
      else status.append(h("span", { class: "qt-chip" }, "Same size"));
    }
    dl.setDisabled(!fresh);
  }

  function paintProgress() {
    const total = rows.length;
    const done = rows.filter((r) => r.version === version).length;
    const busy = done < total;
    progress.classList.toggle("on", busy);
    progressBar.style.width = `${total ? (done / total) * 100 : 0}%`;
    progressText.textContent = busy ? `${cfg.verb} ${Math.min(total, done + 1)} of ${total}` : `${total} ${total === 1 ? "image" : "images"}`;
    const ready = rows.filter((r) => r.out && r.version === version);
    const t = batchTotals(ready);
    summary.replaceChildren();
    if (ready.length) {
      summary.append(
        h("span", { class: "num" }, formatBytes(t.before)),
        h("span", { class: "qt-arrow" }, "→"),
        h("span", { class: "num strong" }, formatBytes(t.after)),
        t.saved > 0 ? h("span", { class: "qt-chip good" }, `${t.saved}% smaller`) : null,
      );
    }
    downloadBtn.setDisabled(busy || !ready.length);
    downloadBtn.setLabel(ready.length > 1 ? "Download all (.zip)" : "Download");
  }

  function paintAll() {
    const has = rows.length > 0;
    if (has && empty.isConnected) body.replaceChildren(work);
    if (!has && !empty.isConnected) body.replaceChildren(empty);
    footer.classList.toggle("empty", !has);
    noteEl.textContent = note;
    noteEl.hidden = !note;
    for (const r of rows) paintRow(r);
    paintProgress();
  }

  async function downloadAll() {
    const ready = rows.filter((r) => r.out && r.version === version);
    if (!ready.length) return;
    if (ready.length === 1) {
      download(ready[0].out.blob, ready[0].out.name);
      return;
    }
    downloadBtn.setDisabled(true);
    try {
      const zip = await makeZip(ready.map((r) => ({ name: r.out.name, blob: r.out.blob })));
      download(zip, cfg.zipName);
    } catch (err) {
      note = err?.message || "Could not make the zip file.";
      paintAll();
    } finally {
      paintProgress();
    }
  }

  paintSettings();
  paintAll();
  return {
    el,
    addFiles,
    hasWork: () => rows.length > 0,
    destroy() {
      saveLater.flush();
      d.dispose();
      current?.controller.abort();
      version++;
      for (const r of rows.splice(0)) URL.revokeObjectURL(r.url);
    },
  };
}

function compressMode(ctx) {
  return createBatchMode(ctx, {
    id: "compress",
    verb: "Compressing",
    workingLabel: "Compressing",
    zipName: "compressed-images.zip",
    emptyTitle: "Drop images to make them smaller",
    emptyHint: "One or many. Paste with Ctrl V works too.",
    load: () => normalizeCompressSettings(prefsFor(ctx, "compress")),
    save: (s) => savePrefs(ctx, "compress", s),
    process: compressFile,
    meta(row, out) {
      const parts = [h("span", null, formatBytes(row.size)), h("span", { class: "qt-arrow" }, "→"), h("span", { class: "strong" }, formatBytes(out.bytes))];
      if (out.width !== out.srcW || out.height !== out.srcH) parts.push(h("span", { class: "qt-dim" }, dims(out.width, out.height)));
      if (out.capped) parts.push(cappedNote());
      return parts;
    },
    settings(s, update, { webpOk }) {
      const lossyPossible = s.format !== "image/png";
      const pngPossible = s.format === "keep" || s.format === "image/png";
      const fmt = segmented({ options: formatOptions(webpOk), value: s.format, full: true, onChange: (v) => update({ format: v }, { structural: true }) });
      disableWebp(fmt, webpOk);
      const out = [sectionLabel("Format"), fmt];
      if (lossyPossible) {
        out.push(
          slider({
            label: s.format === "keep" ? keepQualityLabel(webpOk) : "Quality",
            min: 10,
            max: 100,
            step: 1,
            unit: "%",
            value: Math.round(s.quality * 100),
            defaultValue: 80,
            onInput: (v) => update({ quality: v / 100 }),
            onChange: (v) => update({ quality: v / 100 }),
          }),
        );
      }
      const fitMB = number({ value: s.fitMB, min: 0.05, max: 200, step: 0.1, unit: " MB", width: 96, tip: "Largest file size", onChange: (v) => update({ fitMB: v }), onInput: (v) => update({ fitMB: v }) });
      fitMB.setDisabled(!s.fit);
      out.push(switchRow("Fit under", s.fit, (b) => update({ fit: b }, { structural: true }), fitMB));
      const mw = number({ label: "W", value: s.maxW, min: 16, max: 8000, step: 1, tip: "Largest width", onChange: (v) => update({ maxW: v }) });
      const mh = number({ label: "H", value: s.maxH, min: 16, max: 8000, step: 1, tip: "Largest height", onChange: (v) => update({ maxH: v }) });
      out.push(switchRow("Limit size", s.limit, (b) => update({ limit: b }, { structural: true })));
      if (s.limit) out.push(h("div", { class: "qt-pair" }, mw, h("span", { class: "qt-x" }, "×"), mh));
      if (pngPossible) out.push(switchRow("Smaller PNG (256 colors)", s.png8, (b) => update({ png8: b }), null, "PNGs get a 256-color palette. Often 60 to 80% smaller."));
      return [h("div", { class: "qt-side-scroll" }, out)];
    },
  });
}

function convertMode(ctx) {
  return createBatchMode(ctx, {
    id: "convert",
    verb: "Converting",
    workingLabel: "Converting",
    zipName: "resized-images.zip",
    emptyTitle: "Drop images to resize or convert",
    emptyHint: "Pick a size and a format. Paste with Ctrl V works too.",
    load: () => normalizeConvertSettings(prefsFor(ctx, "convert")),
    save: (s) => savePrefs(ctx, "convert", s),
    process: convertFile,
    meta(row, out) {
      const parts = [h("span", null, dims(out.srcW, out.srcH)), h("span", { class: "qt-arrow" }, "→"), h("span", { class: "strong" }, dims(out.width, out.height))];
      if (out.capped) parts.push(cappedNote());
      parts.push(h("span", { class: "qt-dim" }, formatBytes(out.bytes)));
      return parts;
    },
    settings(s, update, { webpOk }) {
      const sizes = h(
        "div",
        { class: "qt-sizes", role: "radiogroup", "aria-label": "Size" },
        CONVERT_SIZES.map((p) => {
          const on = s.size === p.id;
          const b = h(
            "button",
            { type: "button", class: ["qt-size", on && "on"], role: "radio", "aria-checked": String(on) },
            h("span", { class: "qt-size-label" }, p.label),
            p.width ? h("span", { class: "qt-size-dim num" }, dims(p.width, p.height)) : null,
          );
          b.addEventListener("click", () => update({ size: p.id }, { structural: true }));
          return b;
        }),
      );
      const out = [sectionLabel("Size"), sizes];
      if (s.size === "custom") {
        const w = number({ label: "W", value: s.width, min: 1, max: 8000, step: 1, tip: "Width", onChange: (v) => update({ width: v }) });
        const hh = number({ label: "H", value: s.height, min: 1, max: 8000, step: 1, tip: "Height", onChange: (v) => update({ height: v }) });
        out.push(h("div", { class: "qt-pair" }, w, h("span", { class: "qt-x" }, "×"), hh));
      }
      if (s.size !== "original") {
        out.push(
          sectionLabel("Fit"),
          segmented({
            full: true,
            value: s.fit,
            options: [
              { value: "cover", label: "Fill", tip: "Fill the size, crop the edges" },
              { value: "contain", label: "Fit", tip: "Show all of it, add bars" },
              { value: "stretch", label: "Stretch", tip: "Squash to the size" },
            ],
            onChange: (v) => update({ fit: v }, { structural: true }),
          }),
        );
        if (s.fit === "contain") {
          out.push(
            sectionLabel("Bars"),
            segmented({
              full: true,
              value: s.bars,
              options: [
                { value: "black", label: "Black" },
                { value: "white", label: "White" },
                { value: "clear", label: "Clear", tip: "Transparent. JPG makes them white." },
              ],
              onChange: (v) => update({ bars: v }),
            }),
          );
        }
      }
      const fmt = segmented({ options: formatOptions(webpOk), value: s.format, full: true, onChange: (v) => update({ format: v }, { structural: true }) });
      disableWebp(fmt, webpOk);
      out.push(sectionLabel("Format"), fmt);
      if (s.format !== "image/png") {
        out.push(
          slider({
            label: s.format === "keep" ? keepQualityLabel(webpOk) : "Quality",
            min: 10,
            max: 100,
            step: 1,
            unit: "%",
            value: Math.round(s.quality * 100),
            defaultValue: 92,
            onInput: (v) => update({ quality: v / 100 }),
            onChange: (v) => update({ quality: v / 100 }),
          }),
        );
      }
      return [h("div", { class: "qt-side-scroll" }, out)];
    },
  });
}

// A switch, its label and an optional control on one line. row.sw is the switch.
export function switchRow(label, value, onChange, extra = null, tip = null) {
  const sw = toggle({ value, small: true, tip: tip || label, onChange });
  const lab = h("span", { class: "qt-switch-label", "data-tip": tip || null }, label);
  lab.addEventListener("click", () => sw.click());
  const row = h("div", { class: "qt-switch-row" }, sw, lab, extra ? h("div", { class: "qt-switch-extra" }, extra) : null);
  row.sw = sw;
  return row;
}

// ---- remove a background -------------------------------------------------------

export async function openCutoutInEditor(ctx, file, result) {
  if (!ctx.store || !ctx.assets) throw Error("The editor is not ready yet.");
  const assetId = await ctx.assets.addBlob(file, { name: file.name || "Image" });
  const info = ctx.assets.info?.(assetId) || { w: result.width, h: result.height };
  const W = Math.max(1, info.w || result.width);
  const H = Math.max(1, info.h || result.height);
  const maskId = await ctx.assets.addCanvas(result.mask, { type: "image/png", name: "Mask" });
  const name = stripExt(file.name) || "Cutout";
  ctx.store.setDoc(createDoc({ width: W, height: H, name, preset: null, background: { kind: "transparent" } }));
  const ids = ctx.store.add([createLayer("image", { asset: assetId, natW: W, natH: H, x: W / 2, y: H / 2, w: W, h: H, mask: maskId, name })], { label: "Add image" });
  ctx.store.clearHistory?.();
  return ids;
}

function bgMode(ctx, sheet) {
  const bg = ctx.bg || null;
  let provider = bg?.defaultProvider || null;
  let file = null;
  let source = null;
  let result = null;
  let job = null;
  let phase = null;
  let progressValue = 0;
  let message = "";
  let error = "";
  let consent = null;
  let copied = 0;
  let info = null;
  let loadToken = 0;

  const compare = createCompare({ checker: true });
  const empty = dropZone({ title: "Drop an image to remove its background", hint: "People, products, pets. Paste with Ctrl V works too.", multiple: false, onFiles: addFiles });
  const stage = h("div", { class: "qt-bg-stage" }, empty);
  const side = h("aside", { class: "qt-side" });
  const body = h("div", { class: "qt-body" }, h("div", { class: "qt-work qt-bg-work" }, side, stage));
  const footer = h("div", { class: "qt-foot" }, smallPrint());
  const el = h("div", { class: "qt-mode qt-remove-bg" }, body, footer);

  function addFiles(files, { skipped = 0 } = {}) {
    if (!files.length) {
      if (skipped) {
        error = "That file is not an image.";
        paint();
      }
      return;
    }
    load(files[0]);
  }

  async function load(f) {
    cancel();
    const token = ++loadToken;
    file = f;
    result = null;
    error = "";
    consent = null;
    source = null;
    compare.setAfter(null);
    paint();
    try {
      const c = await fileToCanvas(f, { maxSide: 4096 });
      if (token !== loadToken) return;
      source = c;
      compare.setBefore(c, "Original");
      paint();
      start();
    } catch (err) {
      if (token !== loadToken) return;
      file = null;
      error = err?.message || "This file could not be opened.";
      paint();
    }
  }

  function cancel() {
    job?.abort();
    job = null;
    phase = null;
  }

  async function refreshInfo() {
    if (!bg || !provider) return;
    const id = provider;
    try {
      const i = await bg.modelInfo(id);
      if (id === provider) {
        info = i;
        paint();
      }
    } catch {
      info = null;
    }
  }

  async function start({ confirmed = false } = {}) {
    if (!file || !source || !bg) return;
    const pid = provider;
    if (!confirmed) {
      let i = null;
      try {
        i = await bg.modelInfo(pid);
      } catch {}
      if (pid !== provider || !file) return;
      if (i && i.kind === "ml" && !i.cached) {
        consent = i;
        paint();
        return;
      }
    }
    consent = null;
    error = "";
    result = null;
    compare.setAfter(null);
    const controller = new AbortController();
    job = controller;
    phase = "run";
    progressValue = 0;
    message = "Getting ready";
    paint();
    try {
      // The decoded preview (oriented, 4096 px at most, like the editor's
      // images), not the file: a 48 MP photo at full size can exhaust memory.
      const r = await bg.removeFromImage(source, {
        provider: pid,
        signal: controller.signal,
        onProgress: (e) => {
          if (job !== controller) return;
          phase = e.phase || phase;
          progressValue = Number.isFinite(e.progress) ? e.progress : progressValue;
          message = e.message || message;
          paintProgress();
        },
      });
      if (job !== controller) return;
      job = null;
      phase = null;
      result = r;
      compare.setAfter(r.cutout, "Cutout");
      compare.setLabels("Original", "Cutout");
      info = null;
      refreshInfo();
      paint();
    } catch (err) {
      if (job !== controller) return;
      job = null;
      phase = null;
      if (!isAbort(err)) error = err?.message || "The background could not be removed.";
      paint();
    }
  }

  const progressEl = h("div", { class: "qt-bg-progress" });
  function paintProgress() {
    progressEl.replaceChildren();
    if (!phase) return;
    const pct = Math.round(clamp(progressValue, 0, 1) * 100);
    const downloading = phase === "download";
    progressEl.classList.toggle("download", downloading);
    progressEl.append(
      h("div", { class: "qt-bg-progress-line" }, h("span", null, message || (downloading ? "Downloading the model" : "Removing the background")), h("span", { class: "num" }, `${pct}%`)),
      h("div", { class: "qt-progress-track" }, h("div", { class: "qt-progress-bar", style: { width: `${pct}%` } })),
    );
  }

  function providerPicker() {
    const list = bg?.providers?.list?.() || [];
    if (list.length < 2) return null;
    const seg = segmented({
      full: true,
      value: provider,
      options: list.map((p) => ({ value: p.id, label: p.label.replace(/\s*\(.*\)$/, ""), tip: p.note || p.label })),
      onChange: (v) => {
        provider = v;
        if (bg.setDefaultProvider) bg.setDefaultProvider(v);
        else ctx.prefs?.set?.("bgProvider", v);
        info = null;
        refreshInfo();
        if (file && source && !job) start();
        else paint();
      },
    });
    seg.setDisabled(!!job);
    const p = bg.providers.get(provider);
    const status = info ? (info.kind !== "ml" ? "No download needed" : info.cached ? "Ready on this computer" : `${info.downloadMB || info.sizeMB} MB download, once`) : "";
    return [sectionLabel("Model"), seg, p?.note ? h("p", { class: "qt-help" }, p.note) : null, status ? h("p", { class: ["qt-help", info?.cached === false && info.kind === "ml" && "attention"] }, status) : null];
  }

  function paint() {
    // stage
    if (!file && !source) {
      if (!empty.isConnected) stage.replaceChildren(empty);
    } else if (!compare.el.isConnected) {
      stage.replaceChildren(compare.el);
      compare.layout();
    }
    stage.classList.toggle("scanning", !!job);

    // side
    const parts = [];
    if (!bg) {
      parts.push(h("p", { class: "qt-help" }, "Background removal is not available here."));
      side.replaceChildren(h("div", { class: "qt-side-scroll" }, parts));
      return;
    }
    const picker = providerPicker();
    if (picker) parts.push(...picker);

    if (consent) {
      const mb = consent.downloadMB || consent.sizeMB;
      parts.push(
        h(
          "div",
          { class: "qt-consent", role: "alertdialog", "aria-label": "Download the background remover" },
          h("div", { class: "qt-consent-title" }, icon("download", { size: "sm" }), "One-time download"),
          h("p", null, `Background removal downloads a ${mb} MB model once. It runs on this computer; your image is never uploaded.`),
          h(
            "div",
            { class: "qt-consent-actions" },
            button({ label: "Not now", kind: "ghost", onClick: () => ((consent = null), paint()) }),
            button({ label: "Download and remove", kind: "primary", onClick: () => start({ confirmed: true }) }),
          ),
        ),
      );
    } else if (job) {
      paintProgress();
      parts.push(progressEl, button({ label: "Cancel", kind: "ghost", wide: true, onClick: () => (cancel(), paint()) }));
    } else if (result) {
      const copyBtn = button({ label: copied ? "Copied" : "Copy image", icon: copied ? "check" : "copy", wide: true, onClick: copyResult });
      parts.push(
        h(
          "div",
          { class: "qt-result-actions" },
          button({ label: "Download PNG", icon: "download", kind: "primary", big: true, wide: true, onClick: downloadResult }),
          copyBtn,
          button({ label: "Open in editor", icon: "square-pen", wide: true, onClick: openInEditor }),
        ),
        h("p", { class: "qt-help" }, `${dims(result.width, result.height)} · transparent PNG`),
      );
    } else if (file && source) {
      parts.push(button({ label: "Remove background", icon: "remove-bg", kind: "primary", big: true, wide: true, onClick: () => start() }));
    }
    if (error) parts.push(h("p", { class: "qt-err-box", role: "alert" }, error), file && source ? button({ label: "Try again", kind: "ghost", wide: true, onClick: () => start() }) : null);
    if (file || source) parts.push(h("div", { class: "qt-side-bottom" }, button({ label: "Use another image", icon: "image", kind: "ghost", wide: true, onClick: () => pickFiles({ multiple: false }, addFiles) })));
    side.replaceChildren(h("div", { class: "qt-side-scroll" }, parts.filter(Boolean)));
  }

  async function downloadResult() {
    if (!result) return;
    const blob = await encode(result.cutout, { type: "image/png" });
    download(blob, `${stripExt(file?.name) || "image"}-cutout.png`);
  }

  async function copyResult() {
    if (!result) return;
    const ok = await copyImage(result.cutout);
    if (!ok) {
      error = "This browser cannot copy images. Use Download PNG instead.";
      paint();
      return;
    }
    clearTimeout(copied);
    copied = setTimeout(() => {
      copied = 0;
      paint();
    }, 1600);
    paint();
  }

  async function openInEditor() {
    if (!result || !file) return;
    try {
      const ids = await openCutoutInEditor(ctx, file, result);
      sheet.close();
      ctx.ui?.closeHome?.();
      ctx.editor?.zoomToFit?.();
      if (ids?.length) ctx.editor?.flash?.(ids);
    } catch (err) {
      error = err?.message || "Could not open it in the editor.";
      paint();
    }
  }

  refreshInfo();
  paint();
  return {
    el,
    addFiles,
    hasWork: () => !!file,
    shown: () => compare.layout(),
    destroy() {
      cancel();
      loadToken++;
      clearTimeout(copied);
      compare.destroy();
    },
  };
}

// ---- the dialog -----------------------------------------------------------------

export const QUICK_TOOLS = [
  { id: "compress", label: "Compress" },
  { id: "remove-bg", label: "Remove background" },
  { id: "convert", label: "Resize or convert" },
];

let open = null;

export function openQuickTool(kind, ctx, { files } = {}) {
  const want = QUICK_TOOLS.some((t) => t.id === kind) ? kind : "compress";
  if (open && !open.sheet.closed) {
    open.show(want);
    if (files?.length) open.addFiles([...files]);
    return open.handle;
  }

  const modes = new Map();
  let active = null;
  const sheet = openSheet({
    label: "Quick tools",
    className: "qt-sheet",
    ui: ctx.ui,
    onClose: () => {
      for (const m of modes.values()) m.destroy();
      modes.clear();
      if (open?.sheet === sheet) open = null;
    },
  });

  const tabs = segmented({ options: QUICK_TOOLS.map((t) => ({ value: t.id, label: t.label })), value: want, onChange: (v) => show(v) });
  tabs.classList.add("qt-tabs");
  tabs.setAttribute("aria-label", "Quick tools");
  const closeBtn = iconButton({ icon: "x", tip: "Close", kbd: "Esc", onClick: () => sheet.close() });
  const head = h("header", { class: "xp-head" }, h("h2", { class: "xp-title" }, "Quick tools"), tabs, h("div", { class: "xp-head-end" }, closeBtn));
  const host = h("div", { class: "qt-host" });
  const dropHint = h("div", { class: "xp-drop-hint" }, icon("upload", { size: "lg" }), h("span", null, "Drop to add"));
  sheet.panel.append(head, host, dropHint);

  function mode(id) {
    if (!modes.has(id)) {
      const m = id === "remove-bg" ? bgMode(ctx, sheet) : id === "convert" ? convertMode(ctx) : compressMode(ctx);
      modes.set(id, m);
    }
    return modes.get(id);
  }

  function show(id) {
    if (active === id) return;
    active = id;
    tabs.value = id;
    const m = mode(id);
    host.replaceChildren(m.el);
    m.shown?.();
  }

  const addFiles = (files) => {
    if (files.length) mode(active).addFiles(files, {});
  };
  acceptFiles(sheet.panel, (files, info) => mode(active).addFiles(files, info), { pasteRoot: sheet.el });

  show(want);
  if (files?.length) addFiles([...files]);
  sheet.focus(tabs.querySelector(".seg.on"));

  const handle = { close: () => sheet.close() };
  open = { sheet, show, addFiles, handle };
  return handle;
}
