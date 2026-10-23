// Portable .longitude files and autosave.
//
// File format (JSON):
//   { format: "longitude", v: 1, app, doc,
//     assets: { "ast_…": "data:image/…;base64,…" },
//     fonts: [{ family, dataURL, weight, style, name }] }   // custom fonts only

import { normalizeDoc, assetIdsOf, uid } from "./model.js";
import { openDatabase, blobToDataURL, dataURLToBlob } from "./assets.js";
import { renderThumb } from "./render.js";

export const PROJECT_EXT = ".longitude";
export const PROJECT_TYPE = "application/json";
const NOT_A_PROJECT = "This file is not a Longitude project.";

async function readFontRecord(family) {
  const db = await openDatabase();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction("fonts", "readonly").objectStore("fonts").get(family);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

const FONT_EXT = { "font/woff2": "woff2", "font/woff": "woff", "font/ttf": "ttf", "font/otf": "otf", "application/font-woff": "woff", "application/x-font-ttf": "ttf" };

export async function exportProject(doc, assets, fonts) {
  if (!doc) throw Error("There is no design to save.");
  const out = {};
  for (const id of assetIdsOf(doc)) {
    try {
      out[id] = await assets.toDataURL(id);
    } catch (err) {
      console.warn(`Image ${id} is missing and was left out.`, err);
    }
  }
  const fontList = [];
  let families = [];
  try {
    families = fonts?.usedIn?.(doc) || [];
  } catch {
    families = [];
  }
  for (const family of families) {
    if (fonts.get?.(family)?.source !== "custom") continue;
    // The registry holds every custom face in memory, including fonts that
    // could not be stored (no IndexedDB, storage full), which is exactly when
    // "Save a copy" is offered. The stored record is the fallback; it holds the
    // first face and later faces of the family sit in rec.faces. `family`
    // stays the layer's spelling so importProject's remap lines up.
    let custom = null;
    try {
      custom = fonts.getCustom?.(family) || null;
    } catch {
      custom = null;
    }
    const rec = custom?.faces?.length ? null : await readFontRecord(family);
    const faces = custom?.faces?.length ? custom.faces : rec ? [rec, ...(Array.isArray(rec.faces) ? rec.faces : [])] : [];
    for (const face of faces) {
      if (!(face?.blob instanceof Blob)) continue;
      fontList.push({
        family,
        dataURL: await blobToDataURL(face.blob),
        weight: Number(face.weight) || 400,
        style: face.style === "italic" ? "italic" : "normal",
        name: typeof face.name === "string" ? face.name : "",
      });
    }
  }
  const payload = { format: "longitude", v: 1, app: "Longitude", doc, assets: out, fonts: fontList };
  return new Blob([JSON.stringify(payload)], { type: PROJECT_TYPE });
}

function fontFile(entry, blob) {
  const ext = FONT_EXT[blob.type] || (/\.(woff2?|ttf|otf)$/i.exec(entry.name || "")?.[1] || "ttf").toLowerCase();
  const base = (entry.name || entry.family || "font").replace(/\.(woff2?|ttf|otf)$/i, "").replace(/[\\/:*?"<>|]+/g, "-");
  return new File([blob], `${base}.${ext}`, { type: blob.type || "font/ttf" });
}

const reports = new WeakMap();

// What importProject could not restore, for the doc it returned:
// { images, fonts, message } (counts, and the first error's message, which
// says what to do for a HEIC photo, say), or null when everything came back.
export function importReport(doc) {
  return (doc && reports.get(doc)) || null;
}

// The toast text for a doc that importProject could not fully restore, or null.
export function importWarning(doc, name = doc?.name || "the design") {
  const r = importReport(doc);
  if (!r) return null;
  const parts = [];
  if (r.images) parts.push(`${r.images} ${r.images === 1 ? "picture" : "pictures"} could not be restored and show as empty boxes`);
  if (r.fonts) parts.push(`${r.fonts} ${r.fonts === 1 ? "font" : "fonts"} could not be restored and use a fallback font`);
  let msg = `Opened “${name}”, but ${parts.join(", and ")}.`;
  if (/heic/i.test(r.message || "")) msg += ` ${r.message}`;
  return msg;
}

// Reads a .longitude file (or a bare doc JSON), restores its images and custom
// fonts and returns the normalized doc with a fresh id, so opening a file
// never overwrites a project already in this browser. Images and fonts that
// fail to restore are skipped; importReport(doc) counts them.
export async function importProject(fileOrBlob, assets, fonts) {
  let raw;
  try {
    raw = JSON.parse(await fileOrBlob.text());
  } catch {
    throw Error(NOT_A_PROJECT);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error(NOT_A_PROJECT);
  const envelope = raw.format === "longitude";
  if (!envelope && !Array.isArray(raw.layers)) throw Error(NOT_A_PROJECT);
  const doc = normalizeDoc(envelope ? raw.doc : raw);

  const assetMap = new Map();
  const missing = [];
  let firstError = "";
  if (envelope && raw.assets && typeof raw.assets === "object") {
    for (const [id, url] of Object.entries(raw.assets)) {
      if (typeof url !== "string" || !url.startsWith("data:")) {
        missing.push(id);
        continue;
      }
      try {
        const nid = await assets.fromDataURL(url, {});
        if (nid !== id) assetMap.set(id, nid);
      } catch (err) {
        console.warn(err);
        missing.push(id);
        firstError ||= err?.message || "";
      }
    }
  }

  const fontMap = new Map();
  const failedFonts = new Set();
  if (envelope && Array.isArray(raw.fonts) && fonts?.addCustom) {
    const entries = raw.fonts.filter((e) => e && typeof e.family === "string" && e.family.trim() && typeof e.dataURL === "string");
    // Families this browser already has stay as they are.
    const existing = new Set(entries.filter((e) => fonts.get?.(e.family)).map((e) => e.family));
    for (const entry of entries) {
      if (existing.has(entry.family)) continue;
      try {
        const blob = dataURLToBlob(entry.dataURL);
        const family = await fonts.addCustom(fontFile(entry, blob), {
          family: entry.family,
          weight: Number(entry.weight) || 400,
          style: entry.style === "italic" ? "italic" : "normal",
          name: entry.name || undefined,
        });
        if (family && family !== entry.family) fontMap.set(entry.family, family);
      } catch (err) {
        console.warn(err);
        failedFonts.add(entry.family);
        firstError ||= err?.message || "";
      }
    }
  }

  for (const l of doc.layers) {
    if (l.type === "image") {
      if (assetMap.has(l.asset)) l.asset = assetMap.get(l.asset);
      if (l.mask && assetMap.has(l.mask)) l.mask = assetMap.get(l.mask);
    } else if (l.type === "text" && fontMap.has(l.font)) {
      l.font = fontMap.get(l.font);
    }
  }
  doc.id = uid("doc");
  if (missing.length) console.warn(`${missing.length} image(s) in this file could not be restored.`);
  // Pictures that will show as empty boxes: entries that failed, and layers
  // whose image is neither in the file nor in this browser.
  const lost = new Set(missing);
  if (typeof assets?.has === "function" && assetIdsOf(doc).size) {
    await assets.init?.();
    for (const id of assetIdsOf(doc)) if (!assets.has(id)) lost.add(id);
  }
  // A family counts as failed only when none of its faces came back.
  for (const family of failedFonts) if (fontMap.has(family) || fonts?.get?.(family)) failedFonts.delete(family);
  if (lost.size || failedFonts.size) reports.set(doc, { images: lost.size, fonts: failedFonts.size, message: firstError });
  return doc;
}

export function projectFileName(doc) {
  const base = String(doc?.name || "Untitled thumbnail")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${base || "Untitled thumbnail"}${PROJECT_EXT}`;
}

export function isProjectFile(file) {
  return !!file && (/\.longitude$/i.test(file.name || "") || file.type === "application/x-longitude");
}

// Autosave: saves the store's doc 700 ms after the last committed change and
// when the page is hidden, frozen or closed. Thumbnails are rendered at most
// every 4 s (a later save refreshes a stale one). Switching to another design
// saves the previous one first. Empty designs that were never saved are
// skipped so Recent does not fill up with blanks. Saves run one at a time, in
// order, except the save on hide/close, which goes out at once (saveNow).
//
// Changes inside an open gesture (text being typed, a crop or refine session,
// a drag) are transient and wait for the commit, but what they show is also
// saved when the page hides or closes, on flush(), when the design is
// replaced, and after `liveDelay` ms without input, so closing the tab
// mid-edit never loses it. A text layer left empty by an open edit is saved as
// it was before (or left out, if the edit created it), as the editor would do.
//
// It also tells the asset store which images the open design uses
// (assets.setLive), so decoded images it no longer needs leave memory first.
export function createAutosave({ store, projects, assets = null, fonts = null, delay = 700, liveDelay = 2000, thumbEvery = 4000, onSaved, onError } = {}) {
  let timer = 0;
  let liveTimer = 0;
  let thumbTimer = 0;
  let lastThumb = 0;
  let queue = Promise.resolve();
  let pending = null;
  let live = null; // the doc as an open gesture left it, not saved yet
  let baseLayers = store.doc.layers; // layers as of the last committed change
  const stale = new Set(); // designs whose stored thumbnail is out of date
  let currentId = store.doc.id;
  let disposed = false;
  let seq = 0;
  let busy = 0;
  const issued = new Map(); // doc id -> newest write whose save went out
  const waiting = new Map(); // doc id -> { doc, n } of its newest queued write
  const known = new Set();

  const follow = () => {
    try {
      assets?.setLive?.(assetIdsOf(store.doc));
    } catch {}
  };
  follow();

  // doc with the text layers an open edit emptied put back as they were
  // (left out when the edit created them).
  function settle(doc) {
    let base = null;
    let changed = false;
    const layers = [];
    for (const l of doc.layers) {
      if (l.type === "text" && !String(l.text ?? "").trim()) {
        base ??= new Map(baseLayers.map((b) => [b.id, b]));
        const before = base.get(l.id);
        if (before !== l) {
          changed = true;
          if (before) layers.push(before);
          continue;
        }
      }
      layers.push(l);
    }
    return changed ? { ...doc, layers } : doc;
  }

  // What is on screen now, settled.
  const current = () => (store.inGesture ? settle(store.doc) : store.doc);

  function takeLive() {
    if (live && live.id === store.doc.id) pending = settle(store.doc);
    live = null;
  }

  async function write(doc, { thumb = true, forceThumb = false, n = ++seq } = {}) {
    if (!doc.layers.length && !known.has(doc.id) && !(await projects.has?.(doc.id))) return false;
    let blob;
    // Thumbnail skipped for now (too soon after the last one): redo it later.
    let retry = false;
    const wantThumb = thumb && stale.has(doc.id);
    if (wantThumb && (forceThumb || Date.now() - lastThumb >= thumbEvery)) {
      try {
        blob = await renderThumb(doc, { assets, fonts });
        lastThumb = Date.now();
        if (store.doc === doc || store.doc.id !== doc.id) stale.delete(doc.id);
      } catch (err) {
        // Not retried on a timer, which would save again and again while it
        // keeps failing; the next change tries again.
        console.warn("Could not render the thumbnail", err);
      }
    } else {
      retry = wantThumb;
    }
    // A newer copy of this design went out while this one waited (the page
    // was hidden mid-thumbnail): never write the older one over it. The
    // thumbnail is redone by the retry below.
    const superseded = (issued.get(doc.id) || 0) > n;
    if (superseded) {
      if (blob !== undefined && store.doc.id === doc.id) {
        stale.add(doc.id);
        retry = true;
      }
      blob = undefined;
    } else {
      issued.set(doc.id, n);
      if ((waiting.get(doc.id)?.n || 0) <= n) waiting.delete(doc.id);
      const at = await projects.save(doc, blob);
      known.add(doc.id);
      onSaved?.({ at, id: doc.id });
    }
    if (retry && !disposed) {
      clearTimeout(thumbTimer);
      thumbTimer = setTimeout(() => {
        if (store.doc.id !== doc.id) return;
        pending ??= current();
        flush();
      }, Math.max(50, thumbEvery - (Date.now() - lastThumb)));
    }
    return !superseded;
  }

  const done = (r) => {
    busy--;
    return r;
  };
  const failed = (doc) => (err) => {
    busy--;
    console.error(err);
    if (!pending && store.doc.id === doc.id) pending = current();
    onError?.(err);
    return false;
  };

  function enqueue(doc, opts) {
    const n = ++seq;
    busy++;
    waiting.set(doc.id, { doc, n });
    queue = queue.then(() => write(doc, { ...opts, n })).then(done, failed(doc));
    return queue;
  }

  function flush({ thumb = true } = {}) {
    clearTimeout(timer);
    clearTimeout(liveTimer);
    takeLive();
    const doc = pending;
    pending = null;
    if (!doc) return queue;
    return enqueue(doc, { thumb });
  }

  // Page hidden, frozen or closing: the page may never run another task, so
  // the save starts right here and reaches its single put within this event
  // (ProjectStore.save does not read first once it knows the design's
  // thumbnail). Writes still queued behind a thumbnail render go out the same
  // way; when they finish later they see they were superseded.
  function saveNow() {
    clearTimeout(timer);
    clearTimeout(liveTimer);
    takeLive();
    const docs = pending ? [pending] : [];
    pending = null;
    for (const [id, w] of waiting) {
      if ((issued.get(id) || 0) >= w.n) waiting.delete(id);
      else if (!docs.some((d) => d.id === id)) docs.push(w.doc);
    }
    if (!docs.length) return queue;
    const runs = docs.map((doc) => {
      busy++;
      return write(doc, { thumb: false, n: ++seq }).then(done, failed(doc));
    });
    queue = Promise.all([queue, ...runs]).then((r) => r[1]);
    return queue;
  }

  const onChange = (e) => {
    const d = e.detail || {};
    if (d.transient) {
      // Transient changes outside a gesture (font previews) are not edits.
      if (!store.inGesture || store.doc.id !== currentId) return;
      live = store.doc;
      follow();
      clearTimeout(liveTimer);
      if (liveDelay > 0) liveTimer = setTimeout(() => flush({ thumb: false }), liveDelay);
      return;
    }
    clearTimeout(liveTimer);
    if (d.reason === "setdoc" && store.doc.id !== currentId) {
      // The design was replaced. What it showed is saved first, including an
      // open gesture that the replace dropped without committing.
      const previous = live && live.id === currentId ? settle(live) : pending;
      live = null;
      baseLayers = store.doc.layers;
      currentId = store.doc.id;
      pending = null;
      clearTimeout(timer);
      follow();
      if (previous) {
        stale.add(previous.id);
        enqueue(previous, { thumb: true, forceThumb: true });
      }
      return;
    }
    live = null;
    baseLayers = store.doc.layers;
    pending = store.doc;
    stale.add(store.doc.id);
    clearTimeout(timer);
    timer = setTimeout(flush, delay);
    follow();
  };

  const onVisibility = () => {
    if (globalThis.document?.visibilityState === "hidden") saveNow();
  };
  const onPageHide = () => saveNow();

  store.addEventListener("change", onChange);
  globalThis.document?.addEventListener?.("visibilitychange", onVisibility);
  globalThis.document?.addEventListener?.("freeze", onPageHide);
  globalThis.addEventListener?.("pagehide", onPageHide);

  return {
    flush,
    // The open design counts as changed (it arrived with content: an image,
    // a .longitude file) and is saved now, with a thumbnail.
    markDirty() {
      clearTimeout(timer);
      takeLive();
      const doc = pending || current();
      pending = null;
      stale.add(doc.id);
      return enqueue(doc, { thumb: true, forceThumb: true });
    },
    // Changes not written yet (committed, or held by an open gesture).
    get pending() {
      return !!pending || !!live;
    },
    // A write is queued or in flight.
    get saving() {
      return busy > 0;
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(liveTimer);
      clearTimeout(thumbTimer);
      store.removeEventListener("change", onChange);
      globalThis.document?.removeEventListener?.("visibilitychange", onVisibility);
      globalThis.document?.removeEventListener?.("freeze", onPageHide);
      globalThis.removeEventListener?.("pagehide", onPageHide);
    },
  };
}
