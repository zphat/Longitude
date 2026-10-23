// Bringing files in: drag and drop anywhere in the window (with a lime "Drop
// to add" overlay), the file picker (insert.image, key I) and pasted files.
// Images become image layers, .longitude files open as projects and font
// files are added to the font list.

import { h } from "../ui/dom.js";
import { createLayer } from "../core/model.js";
import { isProjectFile, importProject, importWarning } from "../core/project.js";

const FONT_RE = /\.(ttf|otf|woff2?)$/i;
const IMAGE_RE = /\.(png|apng|jpe?g|jfif|pjpeg|pjp|webp|gif|avif|bmp|svg|ico|heic|heif)$/i;
const ACCEPT = "image/*,.svg,.avif,.longitude,.ttf,.otf,.woff,.woff2";

// "image" | "font" | "project" | "other"
export function classifyFile(file) {
  if (!file) return "other";
  if (isProjectFile(file)) return "project";
  const type = String(file.type || "").toLowerCase();
  const name = String(file.name || "");
  if (type.startsWith("font/") || /(opentype|truetype|woff|font-sfnt|x-font)/.test(type) || FONT_RE.test(name)) return "font";
  if (type.startsWith("image/") || IMAGE_RE.test(name)) return "image";
  // Clipboard blobs can arrive without a type; the asset store sniffs bytes.
  if (!type && !/\.[a-z0-9]{1,8}$/i.test(name)) return "image";
  return "other";
}

// Where a new image goes (SPEC 8): on an empty design an image within 3 % of
// the canvas aspect fills it; otherwise it fits inside 70 % of the canvas,
// centred or at the drop point. Small images are not blown up past 2x.
export function placeImage(doc, natW, natH, { at = null, index = 0, fill = false } = {}) {
  const W = doc.width;
  const H = doc.height;
  const iw = Math.max(1, natW);
  const ih = Math.max(1, natH);
  if (fill && Math.abs(iw / ih - W / H) / (W / H) <= 0.03) return { x: W / 2, y: H / 2, w: W, h: H };
  const s = Math.min((W * 0.7) / iw, (H * 0.7) / ih, 2);
  const w = Math.round(iw * s * 100) / 100;
  const h = Math.round(ih * s * 100) / 100;
  let x = at ? at.x : W / 2;
  let y = at ? at.y : H / 2;
  x += index * 24;
  y += index * 24;
  x = Math.min(W, Math.max(0, x));
  y = Math.min(H, Math.max(0, y));
  return { x, y, w, h };
}

// What a drag carries, from dataTransfer.types: "files", "link" (a URL from
// another tab or app, no file) or null (text, or nothing we handle).
export function dragKind(types) {
  const t = [...(types || [])];
  if (t.includes("Files")) return "files";
  if (t.includes("text/uri-list")) return "link";
  return null;
}

// A .json file: a bare design ("project"), a theme or preset pack ("pack"), or neither (null).
async function jsonKind(file) {
  if (file.size > 1e6) return "project";
  try {
    const raw = JSON.parse(await file.text());
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (raw.format === "longitude" || Array.isArray(raw.layers)) return "project";
    return ["themes", "presets", "palettes", "fonts"].some((k) => Array.isArray(raw[k])) ? "pack" : null;
  } catch {
    return null;
  }
}

// A layer name from a file name: "beach-day.jpg" -> "beach-day".
export function nameFromFile(name) {
  const base = String(name || "")
    .replace(/\.[a-z0-9]{1,8}$/i, "")
    .replace(/[\u0000-\u001f]/g, " ")
    .trim()
    .slice(0, 80);
  if (!base || /^image$/i.test(base) || /^blob$/i.test(base)) return "Image";
  return base;
}

export function createImporter(core) {
  const { ctx, store } = core;
  const toast = (msg, opts) => ctx.ui?.toast?.(msg, opts);
  let input = null;
  let hideTimer = 0;
  let busy = 0;

  const dropEl = h("div", { class: "ed-drop", "aria-hidden": "true" }, h("div", { class: "ed-drop-chip" }, "Drop to add"));
  document.body.append(dropEl);

  async function openFallback(file) {
    try {
      const doc = await importProject(file, ctx.assets, ctx.fonts);
      if (store.doc.layers.length && ctx.ui?.confirm) {
        const ok = await ctx.ui.confirm({ title: "Open this project?", message: "The current design is saved in Recent.", ok: "Open" });
        if (!ok) return;
      }
      store.setDoc(doc);
      const warning = importWarning(doc);
      toast(warning || "Project opened", { kind: warning ? "warn" : "ok" });
    } catch (err) {
      toast(err.message || "This file could not be opened.", { kind: "error" });
    }
  }

  async function addFont(file) {
    try {
      const family = await ctx.fonts.addCustom(file);
      const texts = store.selected().filter((l) => l.type === "text" && !l.locked);
      const action = texts.length
        ? { label: "Use it", run: () => store.patch(texts.map((l) => l.id), { font: family }, { label: "Font" }) }
        : undefined;
      toast(`Font added: ${family}`, { kind: "ok", action });
    } catch (err) {
      toast(err.message || "That font could not be added.", { kind: "error" });
    }
  }

  async function addImages(files, at) {
    const layers = [];
    const fill = store.doc.layers.length === 0 && files.length === 1;
    for (const file of files) {
      try {
        const id = await ctx.assets.addBlob(file, { name: file.name || "" });
        const info = ctx.assets.info(id) || { w: 1, h: 1 };
        const box = placeImage(store.doc, info.w, info.h, { at, index: layers.length, fill });
        layers.push(createLayer("image", { asset: id, natW: info.w, natH: info.h, ...box, name: nameFromFile(file.name) }));
      } catch (err) {
        toast(err.message || "That image could not be added.", { kind: "error" });
      }
    }
    if (!layers.length) return [];
    // The pictures get their own undo step: let a drag on the canvas finish,
    // and close a text edit or crop (a drop fires no click that would).
    await dragDone();
    core.closeSessions?.();
    core.flashNextAdd = true;
    return store.add(layers, { label: layers.length > 1 ? "Add images" : "Add image" });
  }

  // Resolves once no drag on the canvas holds an undo step open (at most 10 s).
  function dragDone() {
    if (!core.editor?.interacting || !store.inGesture || !ctx.on) return Promise.resolve();
    return new Promise((resolve) => {
      let off = null;
      const done = () => {
        clearTimeout(timer);
        off?.();
        resolve();
      };
      const timer = setTimeout(done, 10000);
      off = ctx.on("interaction", ({ active } = {}) => {
        if (!active) done();
      });
    });
  }

  // files: File[] or FileList. at: doc point to centre on (drop point) or null.
  async function importFiles(files, { at = null } = {}) {
    const list = [...(files || [])].filter(Boolean);
    if (!list.length) return [];
    // End a text edit first (mods' ed.importFiles, the file picker), so the
    // import is its own undo step, as a drop is (textedit.js onDrop).
    if (core.editor?.textEditing) core.editor.stopTextEdit();
    const groups = { project: [], font: [], image: [], other: [] };
    for (const f of list) groups[classifyFile(f)].push(f);
    if (groups.project.length) {
      const file = groups.project[0];
      if (ctx.commands.get("file.open")) ctx.commands.run("file.open", { file });
      else await openFallback(file);
    }
    busy++;
    if (groups.image.length) core.setStatus(groups.image.length > 1 ? "Adding images" : "Adding image");
    let ids = [];
    try {
      for (const f of groups.font) await addFont(f);
      if (groups.image.length) ids = await addImages(groups.image, at);
    } finally {
      busy--;
      if (!busy && groups.image.length) core.setStatus(null);
    }
    if (groups.other.length && !groups.image.length && !groups.font.length && !groups.project.length) {
      const json = groups.other.find((f) => /\.json$/i.test(f.name || "") || f.type === "application/json");
      const kind = json ? await jsonKind(json) : null;
      // Packs (themes, presets, palettes) are reviewed in Settings before anything applies.
      if (kind === "pack" && ctx.ui?.openSettings) ctx.ui.openSettings({ tab: "packs", pack: json });
      else if (kind === "project" && ctx.commands.get("file.open")) ctx.commands.run("file.open", { file: json });
      else toast("Longitude opens images, fonts and .longitude files.", { kind: "warn" });
    }
    return ids;
  }

  function pick() {
    if (!input) {
      input = h("input", { type: "file", multiple: true, accept: ACCEPT, class: "ed-file-input", tabindex: "-1", "aria-hidden": "true" });
      input.addEventListener("change", () => {
        const files = [...(input.files || [])];
        input.value = "";
        if (files.length) {
          ctx.ui?.closeHome?.();
          importFiles(files);
        }
      });
      document.body.append(input);
    }
    input.click();
  }

  // ---- drag and drop ----------------------------------------------------------------

  const hasFiles = (e) => dragKind(e.dataTransfer?.types) === "files";
  // A link dragged in from another tab: left alone, the browser would drop it
  // by navigating away from the app. Text fields still take it as text.
  const isLink = (e) => dragKind(e.dataTransfer?.types) === "link" && !e.target?.closest?.("input, textarea, [contenteditable]");

  // Export, quick tools and Settings mount their own modal sheets outside
  // ctx.ui's stack. Files dropped on them must not land on the hidden canvas.
  function sheetOpen() {
    for (const el of document.querySelectorAll('[aria-modal="true"]')) {
      if (el.id !== "home" && !el.closest("[hidden], .closing")) return true;
    }
    return false;
  }

  function show() {
    clearTimeout(hideTimer);
    if (!dropEl.classList.contains("on")) dropEl.classList.add("on");
    // dragover repeats while files hover the window; when it stops, hide.
    hideTimer = setTimeout(hide, 160);
  }

  function hide() {
    clearTimeout(hideTimer);
    dropEl.classList.remove("on");
  }

  function onDragOver(e) {
    if (isLink(e)) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      return;
    }
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    if (core.homeOpen || ctx.ui?.isBlocking?.() || sheetOpen()) {
      hide();
      return;
    }
    show();
  }

  function onDrop(e) {
    if (isLink(e)) {
      if (e.defaultPrevented) return;
      e.preventDefault();
      if (!core.homeOpen && !ctx.ui?.isBlocking?.() && !sheetOpen()) toast("Drag the image file in, or copy the image and paste it here.", { kind: "info" });
      return;
    }
    if (!hasFiles(e)) return;
    hide();
    if (e.defaultPrevented) return;
    e.preventDefault();
    if (ctx.ui?.isBlocking?.() || sheetOpen()) return;
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    core.viewport.measure();
    const p = core.viewport.clientToDoc(e.clientX, e.clientY);
    const doc = store.doc;
    const inside = !core.homeOpen && p.x >= 0 && p.y >= 0 && p.x <= doc.width && p.y <= doc.height;
    if (core.homeOpen) ctx.ui?.closeHome?.();
    importFiles(files, { at: inside ? p : null });
  }

  window.addEventListener("dragenter", onDragOver);
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("drop", onDrop);
  window.addEventListener("blur", hide);

  return {
    importFiles,
    pick,
    dispose() {
      window.removeEventListener("dragenter", onDragOver);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("blur", hide);
      dropEl.remove();
      input?.remove();
    },
  };
}
