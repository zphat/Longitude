// App-level commands (file, edit, layer, align, view) and the design
// lifecycle the shell shares: new, open, start from an image, duplicate,
// delete. Every user action here is a command so the palette, the shortcuts
// sheet and mods see it.

import { createDoc, createLayer, uid } from "../core/model.js";
import { aabb, unionBox } from "../core/geometry.js";
import { exportProject, importProject, importWarning, projectFileName, isProjectFile } from "../core/project.js";
import { renderThumb } from "../core/render.js";
import { placeImage } from "../editor/importer.js";
import { openShortcuts } from "./keyboard.js";

// Shell-wide state. `open` is true once a design is on the canvas (home can
// close); `autosave`, `onStored` and `onStoreError` are set by main.js.
// `lock` is this window's hold on the open design, `lastOpened` the id last
// written as "reopen this next time".
export const session = { open: false, autosave: null, savedIds: new Set(), lock: null, lastOpened: null, channel: null, onStored: null, onStoreError: null };

// ---- pure helpers -------------------------------------------------------------

const round2 = (v) => Math.round(v * 100) / 100;

// Moves that line boxes up with target ({ l, t, r, b, cx, cy }).
export function alignDeltas(boxes, mode, target) {
  return boxes.map((b) => {
    switch (mode) {
      case "left":
        return { dx: target.l - b.l, dy: 0 };
      case "right":
        return { dx: target.r - b.r, dy: 0 };
      case "center-h":
        return { dx: target.cx - b.cx, dy: 0 };
      case "top":
        return { dx: 0, dy: target.t - b.t };
      case "bottom":
        return { dx: 0, dy: target.b - b.b };
      case "center-v":
        return { dx: 0, dy: target.cy - b.cy };
      case "center":
        return { dx: target.cx - b.cx, dy: target.cy - b.cy };
      default:
        return { dx: 0, dy: 0 };
    }
  });
}

// Equal gaps between boxes along an axis ("h" or "v"). The outermost edges stay
// put; boxes keep their order by centre. Fewer than three boxes do not move.
export function distributeDeltas(boxes, axis = "h") {
  const out = boxes.map(() => ({ dx: 0, dy: 0 }));
  if (boxes.length < 3) return out;
  const lo = axis === "h" ? "l" : "t";
  const hi = axis === "h" ? "r" : "b";
  const mid = axis === "h" ? "cx" : "cy";
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a][mid] - boxes[b][mid] || a - b);
  const start = Math.min(...boxes.map((b) => b[lo]));
  const end = Math.max(...boxes.map((b) => b[hi]));
  const total = boxes.reduce((s, b) => s + (b[hi] - b[lo]), 0);
  const gap = (end - start - total) / (boxes.length - 1);
  let pos = start;
  for (const i of order) {
    const d = pos - boxes[i][lo];
    out[i] = axis === "h" ? { dx: d, dy: 0 } : { dx: 0, dy: d };
    pos += boxes[i][hi] - boxes[i][lo] + gap;
  }
  return out;
}

// Normalised crop that makes an image of natW x natH cover a w x h box.
export function coverCrop(natW, natH, w, h) {
  const ia = natW / natH;
  const ba = w / h;
  if (!(ia > 0) || !(ba > 0) || Math.abs(ia - ba) < 1e-6) return { x: 0, y: 0, w: 1, h: 1 };
  if (ia > ba) {
    const cw = ba / ia;
    return { x: (1 - cw) / 2, y: 0, w: cw, h: 1 };
  }
  const ch = ia / ba;
  return { x: 0, y: (1 - ch) / 2, w: 1, h: ch };
}

// "YouTube thumbnail" -> "Untitled thumbnail"; "Square post" -> "Untitled square post".
export function untitledName(preset) {
  if (!preset || preset.custom) return "Untitled design";
  let label = preset.label || "";
  if (preset.group && label.toLowerCase().startsWith(preset.group.toLowerCase() + " ")) label = label.slice(preset.group.length + 1);
  label = label.trim();
  if (!label) return "Untitled design";
  const lower = /^[A-Z][a-z]/.test(label) ? label[0].toLowerCase() + label.slice(1) : label;
  return `Untitled ${lower}`;
}

export function copyName(name) {
  const base = String(name || "Untitled design").trim();
  const m = /^(.*) copy(?: (\d+))?$/.exec(base);
  if (!m) return `${base} copy`;
  return `${m[1]} copy ${m[2] ? Number(m[2]) + 1 : 2}`;
}

export function layerNameFromFile(name) {
  const base = String(name || "").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_]+/g, " ").trim();
  return base ? base.slice(0, 60) : "Image";
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i;
const FONT_EXT = /\.(ttf|otf|woff2?)$/i;

export function fileKind(file) {
  if (!file) return null;
  const name = file.name || "";
  if (isProjectFile(file) || /\.json$/i.test(name)) return "project";
  if (FONT_EXT.test(name) || /^font\//.test(file.type || "")) return "font";
  if (/^image\//.test(file.type || "") || IMAGE_EXT.test(name)) return "image";
  return null;
}

// ---- one window per design ---------------------------------------------------------
//
// Each window holds a Web Lock on the design it shows, so a second window (the
// launcher started twice, or a browser tab beside the app) never edits the
// same design and silently overwrites the other's saves. Windows talk over a
// BroadcastChannel: "release" asks the holder to save and let go, "saved" and
// "renamed" keep Recent and names current. Without these APIs everything
// still works, just without the guard.

export const WINDOW_LOCK = "longitude-window";
export const docLockName = (id) => `longitude-doc-${id}`;
const lockApi = () => globalThis.navigator?.locks || null;

// Resolves to a release function, or null when another window holds the
// design (wait: ms to wait for it instead of giving up at once).
export function lockDesign(id, { wait = 0 } = {}) {
  const api = lockApi();
  if (!api?.request || !id) return Promise.resolve(() => {});
  return new Promise((resolve) => {
    let timer = 0;
    const opts = {};
    if (wait > 0) {
      const ac = new AbortController();
      opts.signal = ac.signal;
      timer = setTimeout(() => ac.abort(), wait);
    } else opts.ifAvailable = true;
    api
      .request(docLockName(id), opts, (lock) => {
        clearTimeout(timer);
        if (!lock) return resolve(null);
        return new Promise((release) => resolve(() => release()));
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(wait > 0 ? null : () => {});
      });
  });
}

async function heldLocks() {
  try {
    return (await lockApi()?.query?.())?.held || [];
  } catch {
    return [];
  }
}

// Another window has this design open right now.
export async function designOpenElsewhere(id) {
  if (!id || session.lock?.id === id) return false;
  return (await heldLocks()).some((l) => l.name === docLockName(id));
}

// Another Longitude window is running (each holds a shared window lock).
export async function otherWindowsOpen() {
  return (await heldLocks()).filter((l) => l.name === WINDOW_LOCK).length > 1;
}

// Held for the life of the page; otherWindowsOpen() counts them.
export function holdWindowLock() {
  try {
    lockApi()?.request?.(WINDOW_LOCK, { mode: "shared" }, () => new Promise(() => {}))?.catch?.(() => {});
  } catch {}
}

export function announce(msg) {
  try {
    session.channel?.postMessage(msg);
  } catch {}
}

// Listens for the other windows. Returns the channel, or null without BroadcastChannel.
export function connectWindows(ctx) {
  if (typeof BroadcastChannel !== "function") return null;
  let ch;
  try {
    ch = new BroadcastChannel("longitude");
  } catch {
    return null;
  }
  session.channel = ch;
  ch.onmessage = (e) => {
    const m = e.data || {};
    if (typeof m.id !== "string") return;
    const mine = session.open && ctx.store.doc.id === m.id;
    if (m.type === "release" && mine) handOver(ctx).catch((err) => console.error(err));
    else if (m.type === "renamed" && mine && typeof m.name === "string" && m.name && m.name !== ctx.store.doc.name) ctx.store.setDocProps({ name: m.name }, { label: "Rename" });
    else if (m.type === "saved") {
      ctx.emit("saved-elsewhere", { id: m.id, at: m.at });
      if (mine) {
        ctx.ui.toast?.("This design was changed in another window. Changes made here are no longer saved; save a project file to keep them.", {
          kind: "warn",
          id: "two-windows",
          timeout: 0,
          action: { label: "Save project file", run: () => ctx.commands.run("file.save-copy") },
        });
      }
    }
  };
  return ch;
}

// Another window asked for the open design: save it, let go and show Home.
async function handOver(ctx) {
  const name = ctx.store.doc.name;
  await withTimeout(session.autosave?.flush?.({ thumb: false }), 4000);
  closeDesign(ctx);
  ctx.ui.openHome?.({ focus: null });
  ctx.ui.toast?.(`“${name}” is open in another window now.`, { kind: "info" });
}

function askOpenElsewhere(ctx, name) {
  if (!ctx.ui.dialog) return Promise.resolve(null);
  return new Promise((resolve) => {
    let choice = null;
    ctx.ui.dialog({
      title: "Open in another window",
      description: `“${name}” is open in another Longitude window. Editing it in two places at once would lose changes.`,
      className: "confirm",
      actions: [
        { label: "Cancel", kind: "ghost" },
        { label: "Make a copy", run: () => (choice = "copy") },
        { label: "Open it here", kind: "primary", autofocus: true, run: () => (choice = "here") },
      ],
      onClose: () => resolve(choice),
    });
  });
}

// Old images nothing uses any more. Skipped while another window is open: its
// undo history may still need images this window does not know about.
export async function collectGarbage(ctx) {
  if (await otherWindowsOpen()) return 0;
  return ctx.assets?.gc?.(ctx.store.referencedAssets?.() || []) ?? 0;
}

// ---- rescue copies ---------------------------------------------------------------------
//
// IndexedDB cannot finish a save while the page unloads, so when the window
// hides or closes with a change not yet stored, a copy goes to localStorage
// (synchronous). The next start applies it when it is newer than the stored design.

export const RESCUE_PREFIX = "longitude.rescue.";

export function writeRescue(doc, at = Date.now()) {
  try {
    localStorage.setItem(RESCUE_PREFIX + doc.id, JSON.stringify({ id: doc.id, at, doc }));
    return true;
  } catch {
    return false;
  }
}

export function clearRescue(id) {
  try {
    localStorage.removeItem(RESCUE_PREFIX + id);
  } catch {}
}

// [{ key, id, rec }] for every rescue copy in localStorage (rec null when unreadable).
export function readRescues() {
  const out = [];
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(RESCUE_PREFIX)) keys.push(k);
    }
    for (const key of keys) {
      let rec = null;
      try {
        rec = JSON.parse(localStorage.getItem(key));
      } catch {
        rec = null;
      }
      out.push({ key, id: key.slice(RESCUE_PREFIX.length), rec });
    }
  } catch {}
  return out;
}

// Whether a rescue copy should replace what storage holds (storedUpdated: the
// stored design's meta.updated, 0 when it was never stored).
export function rescueIsNewer(rec, id, storedUpdated = 0) {
  if (!rec || rec.id !== id || !rec.doc || typeof rec.doc !== "object" || !Array.isArray(rec.doc.layers)) return false;
  if (!Number.isFinite(rec.at)) return false;
  if (!storedUpdated && !rec.doc.layers.length) return false;
  return rec.at > (storedUpdated || 0);
}

// ---- design lifecycle ------------------------------------------------------------

// Resolves to p's value, or null once ms pass or p fails.
function withTimeout(p, ms) {
  let timer = 0;
  return Promise.race([Promise.resolve(p).catch(() => null), new Promise((r) => (timer = setTimeout(() => r(null), ms)))]).finally(() => clearTimeout(timer));
}

// Writes "reopen this design next time"; only ever for a design that is stored.
export function rememberOpened(ctx, id) {
  if (!id || session.lastOpened === id) return;
  session.lastOpened = id;
  ctx.projects?.setLastOpened?.(id)?.catch?.(() => {});
}

// A design that arrives with content (an image, a .longitude file) is stored
// at once: it may be closed before anything is edited.
async function storeNew(ctx, doc) {
  try {
    // Autosave's own queue when it has one, so saves stay in order.
    if (session.autosave?.markDirty) return await session.autosave.markDirty();
    const thumb = (await withTimeout(renderThumb(doc, { assets: ctx.assets, fonts: ctx.fonts }), 3000)) || null;
    // Edited meanwhile: autosave writes the newer version.
    if (ctx.store.doc !== doc) return;
    const at = await ctx.projects.save(doc, thumb);
    session.onStored?.({ at, id: doc.id });
  } catch (err) {
    console.error(err);
    session.onStoreError?.(err);
  }
}

// Takes the open design off the canvas (after a delete, or when another window takes it).
function closeDesign(ctx) {
  const held = session.lock;
  session.lock = null;
  session.open = false;
  ctx.store.setDoc(createDoc(), { history: "reset" });
  ctx.emit("project", { id: null, name: null });
  held?.release();
}

// Put a doc on the canvas: fonts first (briefly), then the store, then the view.
// lock: a release function from lockDesign() when the caller already holds it.
export async function loadDesign(ctx, doc, { fromStorage = false, lock = null } = {}) {
  // The design being replaced is written (with a fresh thumbnail) first.
  if (session.open) await withTimeout(session.autosave?.flush?.({ thumb: true }), 2500);
  await withTimeout(ctx.fonts?.ensureDoc?.(doc, { retry: true }), 1500);
  const previous = session.lock;
  const same = previous?.id === doc.id;
  const release = same ? previous.release : lock || (await lockDesign(doc.id));
  ctx.store.setDoc(doc, { history: "reset" });
  session.open = true;
  const id = ctx.store.doc.id;
  session.lock = release ? { id, release } : null;
  // The design that was open is let go once its last save has landed.
  if (previous && !same) withTimeout(session.autosave?.flush?.({ thumb: false }), 4000).then(() => previous.release());
  if (fromStorage) {
    session.savedIds.add(id);
    rememberOpened(ctx, id);
  } else if (ctx.store.doc.layers.length) {
    storeNew(ctx, ctx.store.doc);
  }
  if (ctx.store.doc.preset) ctx.prefs.set("lastPreset", ctx.store.doc.preset);
  ctx.emit("project", { id: ctx.store.doc.id, name: ctx.store.doc.name, fromStorage });
  ctx.ui.closeHome?.();
  try {
    ctx.editor?.zoomToFit?.();
  } catch (err) {
    console.error(err);
  }
  return ctx.store.doc;
}

// New design from a preset id, or from width/height. opts.layers seeds it.
export async function newDesign(ctx, opts = {}) {
  const p = opts.preset ? ctx.presets?.get?.(opts.preset) : null;
  const width = Math.round(opts.width ?? p?.width ?? 1280);
  const height = Math.round(opts.height ?? p?.height ?? 720);
  let presetId = p && !p.custom ? p.id : null;
  if (!presetId) presetId = ctx.presets?.find?.(width, height)?.id || null;
  const preset = presetId ? ctx.presets?.get?.(presetId) : p;
  const doc = createDoc({
    width,
    height,
    preset: presetId,
    name: opts.name || untitledName(preset),
    background: opts.background || preset?.background || undefined,
  });
  if (Array.isArray(opts.layers)) doc.layers = opts.layers;
  return loadDesign(ctx, doc);
}

// Where an image starting a new W x H design goes: the same rule as a drop on
// an empty canvas (SPEC 8). Within 3 % of the canvas aspect it fills the
// canvas (the sliver left over is cropped, never stretched); otherwise it
// fits inside 70 % and nothing is cut off.
export function startBox(natW, natH, W, H) {
  const box = placeImage({ width: W, height: H }, natW, natH, { fill: true });
  const fills = box.w === W && box.h === H;
  return fills ? { ...box, crop: coverCrop(natW, natH, W, H) } : box;
}

// A new design (default: YouTube thumbnail) built around one image.
export async function startFromImage(ctx, file, { preset = "yt-thumb" } = {}) {
  const id = await ctx.assets.addBlob(file, { name: file.name || "" });
  const info = ctx.assets.info(id) || { w: 1280, h: 720 };
  const p = ctx.presets?.get?.(preset) || { id: "yt-thumb", width: 1280, height: 720 };
  const W = p.width;
  const H = p.height;
  const layer = createLayer("image", {
    asset: id,
    natW: info.w,
    natH: info.h,
    ...startBox(info.w, info.h, W, H),
    name: layerNameFromFile(file.name),
  });
  const doc = await newDesign(ctx, { preset: p.id, width: W, height: H, layers: [layer] });
  ctx.editor?.flash?.([layer.id]);
  return doc;
}

// quiet: no questions and no error toast (boot reopening the last design).
export async function openStoredDesign(ctx, id, { quiet = false } = {}) {
  if (session.open && ctx.store.doc.id === id) {
    ctx.ui.closeHome?.();
    return ctx.store.doc;
  }
  let release = await lockDesign(id);
  if (!release) {
    if (quiet) return null;
    const name = (await ctx.projects.load(id).catch(() => null))?.name || "This design";
    const choice = await askOpenElsewhere(ctx, name);
    if (choice === "copy") {
      const copy = await duplicateDesign(ctx, id);
      return openStoredDesign(ctx, copy.id);
    }
    if (choice !== "here") return null;
    announce({ type: "release", id });
    release = await lockDesign(id, { wait: 6000 });
    if (!release) {
      ctx.ui.toast?.("The other window is still using it. Close it there, then try again.", { kind: "warn" });
      return null;
    }
  }
  let doc = null;
  try {
    doc = await ctx.projects.load(id);
  } catch (err) {
    release();
    throw err;
  }
  if (!doc) {
    release();
    if (!quiet) ctx.ui.toast?.("This design could not be opened.", { kind: "error" });
    return null;
  }
  return loadDesign(ctx, doc, { fromStorage: true, lock: release });
}

export async function openProjectFile(ctx, file) {
  try {
    const doc = await importProject(file, ctx.assets, ctx.fonts);
    const prev = session.open && !ctx.ui.isHomeOpen?.() && ctx.store.doc.layers.length ? { id: ctx.store.doc.id, name: ctx.store.doc.name } : null;
    await loadDesign(ctx, doc);
    // Pictures or fonts that could not be restored are said, not hidden.
    const warning = importWarning(doc);
    ctx.ui.toast?.(warning || `Opened “${doc.name}”`, {
      kind: warning ? "warn" : "ok",
      timeout: warning ? 9000 : undefined,
      action: prev ? { label: `Back to ${prev.name.length > 24 ? prev.name.slice(0, 23) + "…" : prev.name}`, run: () => openStoredDesign(ctx, prev.id) } : undefined,
    });
    return doc;
  } catch (err) {
    console.error(err);
    ctx.ui.toast?.(err.message || "This file could not be opened.", { kind: "error" });
    return null;
  }
}

// Images into the open design. Uses the editor's importer; the fallback keeps
// "add an image" working if the editor failed to load.
async function importIntoDesign(ctx, files, opts = {}) {
  if (ctx.editor?.importFiles) return ctx.editor.importFiles(files, opts);
  const doc = ctx.store.doc;
  const layers = [];
  for (const f of files) {
    const id = await ctx.assets.addBlob(f, { name: f.name || "" });
    const info = ctx.assets.info(id) || { w: 400, h: 300 };
    const k = Math.min(1, (doc.width * 0.7) / info.w, (doc.height * 0.7) / info.h);
    layers.push(createLayer("image", { asset: id, natW: info.w, natH: info.h, x: doc.width / 2, y: doc.height / 2, w: round2(info.w * k), h: round2(info.h * k), name: layerNameFromFile(f.name) }));
  }
  return ctx.store.add(layers);
}

export async function addFonts(ctx, files) {
  for (const f of files) {
    try {
      const family = await ctx.fonts.addCustom(f);
      ctx.ui.toast?.(`Added the font ${family}`, { kind: "ok" });
    } catch (err) {
      ctx.ui.toast?.(err.message || `${f.name} is not a font Longitude can read.`, { kind: "error" });
    }
  }
}

// Files from a picker, a drop, the OS (file handlers) or a paste. fresh: the
// first image always starts a new design (files opened from the OS).
export async function openFiles(ctx, files, { at, fresh = false } = {}) {
  const list = [...(files || [])].filter(Boolean);
  if (!list.length) return;
  const byKind = { project: [], image: [], font: [] };
  for (const f of list) byKind[fileKind(f)]?.push(f);
  if (!byKind.project.length && !byKind.image.length && !byKind.font.length) {
    ctx.ui.toast?.("Longitude opens images, .longitude files and fonts.", { kind: "warn" });
    return;
  }
  try {
    if (byKind.font.length) await addFonts(ctx, byKind.font);
    if (byKind.project.length) {
      await openProjectFile(ctx, byKind.project[0]);
      if (byKind.project.length > 1) ctx.ui.toast?.("Opened the first project. Open the others one at a time.", { kind: "info" });
      if (byKind.image.length && session.open) await importIntoDesign(ctx, byKind.image, { at });
      return;
    }
    if (byKind.image.length) {
      let rest = byKind.image;
      if (fresh || !session.open || ctx.ui.isHomeOpen?.()) {
        await startFromImage(ctx, rest[0], { preset: "yt-thumb" });
        rest = rest.slice(1);
      }
      if (rest.length) await importIntoDesign(ctx, rest, { at });
    }
  } catch (err) {
    console.error(err);
    ctx.ui.toast?.(err.message || "That file could not be opened.", { kind: "error" });
  }
}

export async function duplicateDesign(ctx, id, { thumb = null } = {}) {
  if (session.open && ctx.store.doc.id === id) await session.autosave?.flush?.({ thumb: false });
  const doc = await ctx.projects.load(id);
  if (!doc) throw Error("This design could not be copied.");
  const copy = structuredClone(doc);
  copy.id = uid("doc");
  copy.name = copyName(doc.name);
  copy.meta = { created: Date.now(), updated: Date.now() };
  await ctx.projects.save(copy, thumb || null);
  return copy;
}

export async function deleteDesign(ctx, id) {
  if (await designOpenElsewhere(id)) throw Error("This design is open in another window. Close it there first.");
  const current = ctx.store.doc.id === id;
  if (current) await session.autosave?.flush?.({ thumb: false });
  await ctx.projects.remove(id);
  session.savedIds.delete(id);
  if (session.lastOpened === id) session.lastOpened = null;
  clearRescue(id);
  if (current) closeDesign(ctx);
  setTimeout(() => Promise.resolve(collectGarbage(ctx)).catch(() => {}), 500);
}

export async function renameDesign(ctx, id, name) {
  if (session.open && ctx.store.doc.id === id) return ctx.store.setDocProps({ name }, { label: "Rename" });
  const done = await ctx.projects.rename(id, name);
  // A window that has it open takes the new name, so its next save keeps it.
  announce({ type: "renamed", id, name });
  return done;
}

// A file picker. Resolves to the chosen files ([] when cancelled).
export function pickFiles({ accept = "", multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = "none";
    let done = false;
    const finish = (files) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => finish([...(input.files || [])]));
    input.addEventListener("cancel", () => finish([]));
    document.body.append(input);
    input.click();
  });
}

export const OPEN_ACCEPT = ".longitude,.json,image/*,.png,.jpg,.jpeg,.webp,.gif,.avif,.bmp,.svg,.ttf,.otf,.woff,.woff2";

// ---- commands ------------------------------------------------------------------------

const has = (ctx) => !!ctx.store && session.open && !ctx.ui.isHomeOpen?.();
const selected = (ctx) => (has(ctx) ? ctx.store.selected() : []);
const movable = (ctx) => selected(ctx).filter((l) => !l.locked);
const canvasBox = (doc) => ({ l: 0, t: 0, r: doc.width, b: doc.height, cx: doc.width / 2, cy: doc.height / 2 });

function applyDeltas(ctx, layers, deltas, label) {
  const map = new Map();
  layers.forEach((l, i) => {
    const d = deltas[i];
    if (Math.abs(d.dx) > 1e-6 || Math.abs(d.dy) > 1e-6) map.set(l.id, d);
  });
  if (!map.size) return false;
  ctx.store.patch([...map.keys()], (l) => {
    const d = map.get(l.id);
    return { x: round2(l.x + d.dx), y: round2(l.y + d.dy) };
  }, { label });
  ctx.editor?.flash?.([...map.keys()]);
  return true;
}

function align(ctx, mode) {
  const all = selected(ctx).filter((l) => !l.hidden);
  const layers = all.filter((l) => !l.locked);
  if (!layers.length) return;
  const boxes = layers.map(aabb);
  const doc = ctx.store.doc;
  let moved;
  if (mode === "center" && layers.length > 1) {
    const u = unionBox(boxes);
    const d = { dx: doc.width / 2 - u.cx, dy: doc.height / 2 - u.cy };
    moved = applyDeltas(ctx, layers, boxes.map(() => d), "Centre on canvas");
  } else {
    const target = all.length > 1 && mode !== "center" ? unionBox(all.map(aabb)) : canvasBox(doc);
    moved = applyDeltas(ctx, layers, alignDeltas(boxes, mode, target), mode === "center" ? "Centre on canvas" : "Align");
  }
  // Nothing moved: say so, so the click does not look ignored.
  if (!moved) {
    ctx.editor?.flash?.(layers.map((l) => l.id));
    const msg = mode === "center" ? "Already centred" : "Already aligned";
    if (ctx.editor?.flashStatus) ctx.editor.flashStatus(msg);
    else ctx.ui.toast?.(msg, { kind: "info", id: "align-noop" });
  }
}

function distribute(ctx, axis) {
  const layers = movable(ctx).filter((l) => !l.hidden);
  if (layers.length < 3) return;
  applyDeltas(ctx, layers, distributeDeltas(layers.map(aabb), axis), "Distribute");
}

function flip(ctx, axis) {
  const layers = movable(ctx);
  if (!layers.length) return;
  const key = axis === "h" ? "flipX" : "flipY";
  const label = axis === "h" ? "Flip horizontal" : "Flip vertical";
  if (layers.length === 1) {
    ctx.store.patch(layers[0].id, { [key]: !layers[0][key] }, { label });
    return;
  }
  // Several layers mirror as a group around their shared centre.
  const u = unionBox(layers.map(aabb));
  ctx.store.patch(layers.map((l) => l.id), (l) => ({
    [key]: !l[key],
    x: axis === "h" ? round2(2 * u.cx - l.x) : l.x,
    y: axis === "v" ? round2(2 * u.cy - l.y) : l.y,
    rotation: -l.rotation || 0,
  }), { label });
}

function nudge(ctx, dx, dy, args) {
  const step = Number(args?.step) || (args?.shiftKey ? 10 : 1);
  if (ctx.editor?.nudge) return ctx.editor.nudge(dx * step, dy * step);
  const ids = movable(ctx).map((l) => l.id);
  if (ids.length) ctx.store.patch(ids, (l) => ({ x: l.x + dx * step, y: l.y + dy * step }), { label: "Move", coalesce: "nudge" });
}

function cycleTheme(ctx, args) {
  const themes = ctx.themes?.list?.() || [];
  if (!themes.length) return;
  let id = args?.id;
  if (!id || !ctx.themes.get(id)) {
    const cur = ctx.themes.current().id;
    const i = themes.findIndex((t) => t.id === cur);
    id = themes[(i + 1) % themes.length].id;
  }
  const t = ctx.themes.apply(id);
  ctx.ui.toast?.(`Theme: ${t.name}`, { id: "theme", timeout: 1600 });
}

async function saveCopy(ctx) {
  const doc = ctx.store.doc;
  const blob = await exportProject(doc, ctx.assets, ctx.fonts);
  const name = projectFileName(doc);
  if (ctx.exporter?.download) ctx.exporter.download(blob, name);
  else {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  ctx.ui.toast?.(`Saved the project file ${name}`, { kind: "ok" });
}

function toggleOverlay(ctx, pref, overlay, fallback, label) {
  const on = !ctx.prefs.get(pref, fallback);
  ctx.prefs.set(pref, on);
  try {
    ctx.editor?.setOverlay?.(overlay, on);
  } catch (err) {
    console.error(err);
  }
  ctx.ui.toast?.(`${label} ${on ? "on" : "off"}`, { id: `overlay-${pref}`, timeout: 1400 });
  return on;
}

function toggleSnap(ctx) {
  // The editor reads the "snap" pref on every drag.
  const on = !ctx.prefs.get("snap", true);
  ctx.prefs.set("snap", on);
  ctx.ui.toast?.(on ? "Snapping on" : "Snapping off. Hold Ctrl while dragging to skip it once.", { id: "overlay-snap", timeout: on ? 1400 : 2600 });
}

async function renameLayer(ctx) {
  const l = selected(ctx)[0];
  if (!l) return;
  const name = await ctx.ui.prompt?.({ title: "Rename layer", value: l.name || "", placeholder: "Layer name", ok: "Rename", maxLength: 80 });
  if (name) ctx.store.patch(l.id, { name: name.slice(0, 80) }, { label: "Rename layer" });
}

export function registerCoreCommands(ctx) {
  const disposers = [];
  const reg = (def) => {
    try {
      disposers.push(ctx.commands.register(def));
    } catch (err) {
      console.warn(`Longitude: could not register ${def.id}: ${err.message}`);
    }
  };
  const anySel = (ctx) => selected(ctx).length > 0;
  const anyMovable = (ctx) => movable(ctx).length > 0;

  // ---- file
  reg({
    id: "file.new",
    title: "New design",
    group: "File",
    icon: "file-plus",
    keywords: "create start blank preset size thumbnail cover",
    home: true,
    run: (ctx, args) => (args?.preset || args?.width ? newDesign(ctx, args) : ctx.ui.openHome?.({ focus: "presets" })),
  });
  reg({
    id: "file.open",
    title: "Open a file",
    group: "File",
    icon: "folder-open",
    keys: ["Mod+O"],
    allowInFields: true,
    keywords: "import load longitude project image font",
    home: true,
    run: async (ctx, args) => {
      if (args?.id) return openStoredDesign(ctx, args.id);
      const files = args?.files || (args?.file ? [args.file] : await pickFiles({ accept: OPEN_ACCEPT }));
      return openFiles(ctx, files);
    },
  });
  reg({
    id: "file.save",
    title: "Save now",
    group: "File",
    icon: "save",
    keys: ["Mod+S"],
    allowInFields: true,
    keywords: "store autosave browser",
    when: has,
    run: async (ctx) => {
      await session.autosave?.flush?.({ thumb: true });
      ctx.ui.toast?.(ctx.assets?.persistent === false ? "This browser is not keeping data for this site. Save a project file to keep your work." : "Saved in this browser", {
        kind: ctx.assets?.persistent === false ? "warn" : "ok",
        id: "save",
        action: { label: "Save project file", run: () => ctx.commands.run("file.save-copy") },
      });
    },
  });
  reg({
    id: "file.save-copy",
    title: "Save project file (.longitude)",
    group: "File",
    icon: "save",
    keys: ["Mod+Shift+S"],
    allowInFields: true,
    keywords: "save a copy download backup project file portable longitude",
    when: has,
    run: (ctx) => saveCopy(ctx),
  });
  reg({
    id: "file.home",
    title: "Go to home",
    group: "File",
    icon: "home",
    keywords: "recent projects designs start",
    when: (ctx) => !ctx.ui.isHomeOpen?.(),
    run: (ctx) => ctx.ui.openHome?.({ focus: "recent" }),
  });
  reg({
    id: "file.rename",
    title: "Rename design",
    group: "File",
    icon: "edit",
    keywords: "name title project",
    when: has,
    run: (ctx) => ctx.emit("shell:rename", {}),
  });

  // ---- edit
  // A draw tool still saving a stroke or magic click (its `pending` promise)
  // finishes first, so undo does not take back the step before it.
  const afterToolSave = (ctx, fn) => {
    const p = ctx.tools?.get?.(ctx.editor?.tool)?.pending;
    return p ? Promise.resolve(p).catch(() => {}).then(fn) : fn();
  };
  reg({ id: "edit.undo", title: "Undo", group: "Edit", icon: "undo", keys: ["Mod+Z"], when: (ctx) => has(ctx) && ctx.store.canUndo, run: (ctx) => afterToolSave(ctx, () => ctx.store.undo()) });
  reg({ id: "edit.redo", title: "Redo", group: "Edit", icon: "redo", keys: ["Mod+Shift+Z", "Mod+Y"], when: (ctx) => has(ctx) && ctx.store.canRedo, run: (ctx) => afterToolSave(ctx, () => ctx.store.redo()) });
  reg({ id: "edit.copy", title: "Copy", group: "Edit", icon: "copy", keys: ["Mod+C"], when: anySel, run: (ctx) => ctx.editor?.copy?.() });
  reg({ id: "edit.cut", title: "Cut", group: "Edit", icon: "scissors", keys: ["Mod+X"], when: anyMovable, run: (ctx) => ctx.editor?.cut?.() });
  reg({
    id: "edit.paste",
    title: "Paste",
    group: "Edit",
    icon: "clipboard",
    // Ctrl+V stays with the browser so the editor's paste listener gets
    // clipboard images; the keys are listed for tooltips and the sheet.
    keys: ["Mod+V"],
    nativeKeys: true,
    keywords: "clipboard image",
    when: has,
    run: (ctx) => ctx.editor?.paste?.(),
  });
  reg({
    id: "edit.delete",
    title: "Delete",
    group: "Edit",
    icon: "trash",
    keys: ["Delete", "Backspace"],
    keywords: "remove erase",
    when: anySel,
    run: (ctx) => {
      const ids = movable(ctx).map((l) => l.id);
      if (!ids.length) {
        ctx.ui.toast?.("Unlock the layer to delete it.", { kind: "info" });
        return;
      }
      ctx.store.remove(ids, { label: ids.length > 1 ? "Delete layers" : "Delete" });
    },
  });
  reg({ id: "edit.select-all", title: "Select all", group: "Edit", icon: "square-dashed", keys: ["Mod+A"], when: (ctx) => has(ctx) && ctx.store.layers().length > 0, run: (ctx) => ctx.store.selectAll() });
  reg({
    id: "edit.deselect",
    title: "Deselect",
    group: "Edit",
    icon: "x",
    keys: ["Escape"],
    keywords: "clear selection none",
    when: (ctx) => {
      if (!has(ctx)) return false;
      const mode = ctx.editor?.mode;
      if (mode && mode !== "normal") return false;
      const tool = ctx.editor?.tool;
      return ctx.store.selection.length > 0 || (tool && tool !== "select" && tool !== "hand");
    },
    run: (ctx) => {
      const tool = ctx.editor?.tool;
      if (tool && tool !== "select" && tool !== "hand") ctx.editor.setTool("select");
      else ctx.store.clearSelection();
    },
  });

  // ---- layer
  reg({
    id: "layer.duplicate",
    title: "Duplicate",
    group: "Layer",
    icon: "copy-plus",
    keys: ["Mod+D"],
    keywords: "clone copy",
    when: anySel,
    run: (ctx) => {
      const ids = ctx.store.duplicate(ctx.store.selection, { offset: 24 });
      if (ids.length) ctx.editor?.flash?.(ids);
    },
  });
  reg({ id: "layer.forward", title: "Bring forward", group: "Layer", icon: "bring-forward", keys: ["Mod+]"], keywords: "order up raise", when: anySel, run: (ctx) => ctx.store.forward(ctx.store.selection) });
  reg({ id: "layer.backward", title: "Send backward", group: "Layer", icon: "send-backward", keys: ["Mod+["], keywords: "order down lower", when: anySel, run: (ctx) => ctx.store.backward(ctx.store.selection) });
  reg({ id: "layer.front", title: "Bring to front", group: "Layer", icon: "bring-front", keys: ["Mod+Shift+]"], keywords: "order top", when: anySel, run: (ctx) => ctx.store.toFront(ctx.store.selection) });
  reg({ id: "layer.back", title: "Send to back", group: "Layer", icon: "send-back", keys: ["Mod+Shift+["], keywords: "order bottom", when: anySel, run: (ctx) => ctx.store.toBack(ctx.store.selection) });
  reg({
    id: "layer.lock",
    title: "Lock or unlock",
    group: "Layer",
    icon: "lock",
    keys: ["Mod+Shift+L"],
    keywords: "lock unlock freeze pin",
    when: anySel,
    run: (ctx) => {
      const sel = ctx.store.selected();
      const lock = sel.some((l) => !l.locked);
      ctx.store.patch(sel.map((l) => l.id), { locked: lock }, { label: lock ? "Lock" : "Unlock" });
    },
  });
  reg({
    id: "layer.hide",
    title: "Hide or show",
    group: "Layer",
    icon: "eye-off",
    keys: ["Mod+Shift+H"],
    keywords: "hide show visible visibility",
    when: anySel,
    run: (ctx) => {
      const sel = ctx.store.selected();
      const hide = sel.some((l) => !l.hidden);
      ctx.store.patch(sel.map((l) => l.id), { hidden: hide }, { label: hide ? "Hide" : "Show" });
    },
  });
  reg({ id: "layer.flip-h", title: "Flip horizontal", group: "Layer", icon: "flip-h", keys: ["Shift+H"], keywords: "mirror", when: anyMovable, run: (ctx) => flip(ctx, "h") });
  reg({ id: "layer.flip-v", title: "Flip vertical", group: "Layer", icon: "flip-v", keys: ["Shift+V"], keywords: "mirror upside down", when: anyMovable, run: (ctx) => flip(ctx, "v") });
  reg({ id: "layer.rename", title: "Rename layer", group: "Layer", icon: "edit", keys: ["F2"], keywords: "name", when: (ctx) => selected(ctx).length === 1, run: (ctx) => renameLayer(ctx) });

  // ---- align
  const alignDefs = [
    ["align.center", "Centre on canvas", "align-center", ["Shift+C"], "center middle both"],
    ["align.center-h", "Align horizontal centres", "align-center-h", null, "center middle"],
    ["align.center-v", "Align vertical centres", "align-center-v", null, "center middle"],
    ["align.left", "Align left", "align-left", null, "edge"],
    ["align.right", "Align right", "align-right", null, "edge"],
    ["align.top", "Align top", "align-top", null, "edge"],
    ["align.bottom", "Align bottom", "align-bottom", null, "edge"],
  ];
  for (const [id, title, iconName, keys, kw] of alignDefs) {
    reg({ id, title, group: "Align", icon: iconName, keys: keys || undefined, keywords: `align arrange ${kw} canvas selection`, when: anyMovable, run: (ctx) => align(ctx, id.slice(6)) });
  }
  reg({ id: "align.distribute-h", title: "Distribute horizontally", group: "Align", icon: "distribute-h", keywords: "space evenly spacing gap", when: (ctx) => movable(ctx).length >= 3, run: (ctx) => distribute(ctx, "h") });
  reg({ id: "align.distribute-v", title: "Distribute vertically", group: "Align", icon: "distribute-v", keywords: "space evenly spacing gap", when: (ctx) => movable(ctx).length >= 3, run: (ctx) => distribute(ctx, "v") });

  // ---- nudge (arrow keys; Shift moves 10 px)
  const nudges = [
    ["left", -1, 0, "ArrowLeft"],
    ["right", 1, 0, "ArrowRight"],
    ["up", 0, -1, "ArrowUp"],
    ["down", 0, 1, "ArrowDown"],
  ];
  for (const [dir, dx, dy, key] of nudges) {
    reg({
      id: `nudge.${dir}`,
      title: `Nudge ${dir}`,
      group: "Arrange",
      icon: `arrow-${dir}`,
      keys: [key, `Shift+${key}`],
      hidden: true,
      when: anyMovable,
      run: (ctx, args) => nudge(ctx, dx, dy, args),
    });
  }

  // ---- view
  reg({ id: "view.palette", title: "Search commands", group: "View", icon: "search", keys: ["Mod+K", "/"], allowInFields: true, home: true, hidden: true, keywords: "palette command find run action", run: (ctx) => ctx.ui.openPalette?.() });
  reg({ id: "view.fit", title: "Zoom to fit", group: "View", icon: "maximize", keys: ["Mod+0", "Shift+1"], keywords: "zoom fit screen whole", when: has, run: (ctx) => ctx.editor?.zoomToFit?.() });
  reg({ id: "view.actual", title: "Actual size", group: "View", icon: "zoom-in", keys: ["Mod+1", "Shift+0"], keywords: "zoom 100% real pixels", when: has, run: (ctx) => ctx.editor?.zoomToActual?.() });
  reg({ id: "view.zoom-in", title: "Zoom in", group: "View", icon: "zoom-in", keys: ["Mod+=", "="], when: has, run: (ctx) => ctx.editor?.zoomBy?.(1.25) });
  reg({ id: "view.zoom-out", title: "Zoom out", group: "View", icon: "zoom-out", keys: ["Mod+-", "-"], when: has, run: (ctx) => ctx.editor?.zoomBy?.(0.8) });
  reg({ id: "view.snapping", title: "Snapping on or off", group: "View", icon: "magnet", keywords: "snap guides magnet centre", when: has, run: (ctx) => toggleSnap(ctx) });
  reg({ id: "view.safe-zones", title: "Safe zones on or off", group: "View", icon: "safe-zone", keys: ["Mod+;"], keywords: "guides badge timestamp overlay ui", when: has, run: (ctx) => toggleOverlay(ctx, "safeZones", "safe", true, "Safe zones") });
  reg({ id: "view.grid", title: "Grid on or off", group: "View", icon: "grid", keys: ["Mod+'"], keywords: "thirds rule composition", when: has, run: (ctx) => toggleOverlay(ctx, "grid", "grid", false, "Grid") });
  reg({ id: "view.theme", title: "Switch theme", group: "View", icon: "palette", keywords: "theme dark light colours appearance", home: true, run: (ctx, args) => cycleTheme(ctx, args) });
  reg({ id: "view.ui", title: "Hide or show the interface", group: "View", icon: "maximize", keys: ["Mod+\\"], keywords: "focus chrome panels clean", when: has, run: (ctx) => ctx.emit("shell:toggle-ui", {}) });
  reg({ id: "view.panel", title: "Show or hide the side panel", group: "View", icon: "panel-right", keywords: "inspector layers properties", when: has, run: (ctx) => ctx.emit("shell:toggle-panel", {}) });

  // ---- app
  reg({ id: "app.settings", title: "Settings", group: "App", icon: "settings", keys: ["Mod+,"], allowInFields: true, home: true, keywords: "preferences options mods themes", run: (ctx, args) => ctx.ui.openSettings?.(args || {}) });
  reg({ id: "help.shortcuts", title: "Keyboard shortcuts", group: "Help", icon: "keyboard", keys: ["Shift+/"], home: true, keywords: "keys help cheat sheet hotkeys", run: (ctx) => openShortcuts(ctx) });

  return () => disposers.forEach((d) => d());
}
