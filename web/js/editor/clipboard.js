// Copy, cut and paste. Layers travel as JSON in a text/plain envelope
// {"longitude-layers":[…]} (also under application/x-longitude where the
// browser allows it); images stay in this browser's asset store and are
// referenced by id. System paste events bring in images, Longitude layers or
// plain text (which becomes a text layer). The shell's edit.copy / edit.cut /
// edit.paste commands call copy() / cut() / paste().

import { isTextEntry } from "../ui/dom.js";
import { keysLabel } from "../app/context.js";
import { normalizeLayer, cloneLayer, createLayer } from "../core/model.js";
import { aabb, unionBox } from "../core/geometry.js";

export const CLIP_KEY = "longitude-layers";
export const CLIP_MIME = "application/x-longitude";
const STEP = 24;

export function serializeLayers(layers) {
  return JSON.stringify({ [CLIP_KEY]: layers });
}

// Layers from clipboard text, normalised, or null when it is not ours.
export function parseLayers(text) {
  if (typeof text !== "string" || !text.includes(CLIP_KEY)) return null;
  try {
    const v = JSON.parse(text);
    const list = v && typeof v === "object" ? v[CLIP_KEY] : null;
    if (!Array.isArray(list)) return null;
    const out = list.map((l) => normalizeLayer(l)).filter(Boolean);
    return out.length ? out : null;
  } catch {
    return null;
  }
}

// How far the n-th paste moves the layers. A group that would land wholly
// off the canvas is centred on it instead.
export function pasteOffset(layers, n, doc, step = STEP) {
  const box = unionBox(layers.map(aabb));
  let dx = n * step;
  let dy = n * step;
  if (box) {
    const off = box.r + dx < 0 || box.b + dy < 0 || box.l + dx > doc.width || box.t + dy > doc.height;
    if (off) {
      dx = doc.width / 2 - box.cx;
      dy = doc.height / 2 - box.cy;
    }
  }
  return { dx, dy };
}

// Text pasted from elsewhere as a new text layer, sized to its length.
export function textLayerFrom(text, doc) {
  const t = String(text || "").replace(/\r\n?/g, "\n").trim().slice(0, 2000);
  if (!t) return null;
  const longest = Math.max(...t.split("\n").map((s) => s.length));
  const size = longest > 60 ? 48 : longest > 28 ? 72 : longest > 14 ? 100 : 140;
  const wrap = longest > 28 ? "fixed" : "auto";
  return createLayer("text", { text: t, size, wrap, w: Math.round(doc.width * 0.8), x: doc.width / 2, y: doc.height / 2 });
}

export function createClipboard(core) {
  const { ctx, store } = core;
  let clip = null; // { layers, json, pastes }
  let lastPaste = 0;
  // clip is still the newest thing copied: nothing was copied in a text field
  // here and the window has not lost focus (a screenshot, another app) since.
  let fresh = false;
  const stale = () => {
    fresh = false;
  };
  const onVisibility = () => {
    if (document.hidden) stale();
  };

  const toast = (msg, opts) => ctx.ui?.toast?.(msg, opts);

  function snapshot(pastesFrom = 0) {
    const sel = store.selected();
    if (!sel.length) return null;
    const layers = sel.map((l) => structuredClone(l));
    clip = { layers, json: serializeLayers(layers), pastes: pastesFrom };
    fresh = true;
    return clip;
  }

  // A paste lands in its own undo step: finish a drag on the canvas and close
  // a text edit or crop first.
  function settle() {
    core.closeSessions?.({ settle: true });
  }

  function pasteLayers(layers, src) {
    settle();
    const n = src ? ++src.pastes : 1;
    const { dx, dy } = pasteOffset(layers, n, store.doc);
    const out = layers.map((l) => {
      const c = cloneLayer(l);
      c.x += dx;
      c.y += dy;
      return c;
    });
    core.flashNextAdd = true;
    const ids = store.add(out, { label: "Paste" });
    const missing = out.some((l) => l.type === "image" && ((l.asset && !ctx.assets?.has?.(l.asset)) || (l.mask && !ctx.assets?.has?.(l.mask))));
    if (missing) toast("Some pictures were not found in this browser and show as empty boxes.", { kind: "warn" });
    return ids;
  }

  function pasteText(text) {
    const layer = textLayerFrom(text, store.doc);
    if (!layer) return [];
    settle();
    core.flashNextAdd = true;
    return store.add([layer], { label: "Paste" });
  }

  function copy() {
    const c = snapshot(0);
    if (!c) return false;
    try {
      navigator.clipboard?.writeText?.(c.json)?.catch?.(() => {});
    } catch {}
    core.flashStatus(c.layers.length > 1 ? `Copied ${c.layers.length} layers` : "Copied");
    return true;
  }

  function cut() {
    const ids = store.selected().filter((l) => !l.locked).map((l) => l.id);
    if (!ids.length) return false;
    store.select(ids);
    const c = snapshot(-1);
    if (!c) return false;
    try {
      navigator.clipboard?.writeText?.(c.json)?.catch?.(() => {});
    } catch {}
    store.remove(ids, { label: "Cut" });
    return true;
  }

  // The paste command (menus, palette). Layers copied here, with nothing
  // copied anywhere since, paste straight away; otherwise the system
  // clipboard is read first (a screenshot or text copied in another app wins;
  // the browser may ask for permission) and the internal clipboard is the
  // fallback when it is empty or can not be read.
  async function paste() {
    lastPaste = Date.now();
    if (clip && fresh) return pasteLayers(clip.layers, clip);
    const got = await readSystem();
    if (got?.files.length) return core.importer.importFiles(got.files);
    if (got?.text.trim()) return pasteFromText(got.text);
    if (clip) return pasteLayers(clip.layers, clip);
    if (!got) toast(`Press ${keysLabel("Mod+V")} to paste from other apps.`, { kind: "info" });
    return [];
  }

  // { files, text } from the system clipboard, or null when it can not be read.
  async function readSystem() {
    const cb = navigator.clipboard;
    try {
      if (cb?.read) {
        const items = await cb.read();
        const files = [];
        let text = "";
        for (const it of items) {
          const type = it.types.find((t) => t.startsWith("image/"));
          if (type) {
            const blob = await it.getType(type);
            files.push(new File([blob], `image.${type.split("/")[1] || "png"}`, { type }));
          } else if (!text && it.types.includes("text/plain")) {
            text = await (await it.getType("text/plain")).text();
          }
        }
        return { files, text };
      }
      if (cb?.readText) return { files: [], text: String((await cb.readText()) || "") };
    } catch {}
    return null;
  }

  function pasteFromText(text) {
    if (clip && text === clip.json) {
      fresh = true;
      return pasteLayers(clip.layers, clip);
    }
    const layers = parseLayers(text);
    if (layers) {
      clip = { layers, json: text, pastes: 0 };
      fresh = true;
      return pasteLayers(layers, clip);
    }
    return pasteText(text);
  }

  // Whether a native clipboard event is ours to handle.
  function ours(e) {
    if (core.homeOpen || core.textEditing || ctx.ui?.isBlocking?.()) return false;
    // A focused slider or checkbox has no clipboard of its own; text fields do.
    if (isTextEntry(e.target) || isTextEntry()) return false;
    if (e.target?.closest?.("dialog, [role=dialog]")) return false;
    const sel = globalThis.getSelection?.();
    if (sel && !sel.isCollapsed && String(sel).trim()) return false;
    return true;
  }

  function onCopy(e) {
    if (!ours(e) || !store.selection.length) return;
    const c = snapshot(0);
    if (!c) return;
    e.preventDefault();
    e.clipboardData?.setData("text/plain", c.json);
    try {
      e.clipboardData?.setData(CLIP_MIME, c.json);
    } catch {}
    core.flashStatus(c.layers.length > 1 ? `Copied ${c.layers.length} layers` : "Copied");
  }

  function onCut(e) {
    if (!ours(e)) return;
    const ids = store.selected().filter((l) => !l.locked).map((l) => l.id);
    if (!ids.length) return;
    store.select(ids);
    const c = snapshot(-1);
    e.preventDefault();
    e.clipboardData?.setData("text/plain", c.json);
    try {
      e.clipboardData?.setData(CLIP_MIME, c.json);
    } catch {}
    store.remove(ids, { label: "Cut" });
  }

  function onPaste(e) {
    if (!ours(e)) return;
    // The paste command may already have run for this keystroke.
    if (Date.now() - lastPaste < 400) {
      e.preventDefault();
      return;
    }
    lastPaste = Date.now();
    const dt = e.clipboardData;
    if (!dt) return;
    const files = [...(dt.files || [])];
    if (files.length) {
      e.preventDefault();
      core.importer.importFiles(files);
      return;
    }
    let text = "";
    try {
      text = dt.getData(CLIP_MIME) || dt.getData("text/plain") || "";
    } catch {
      text = "";
    }
    if (text.trim()) {
      e.preventDefault();
      pasteFromText(text);
      return;
    }
    if (clip) {
      e.preventDefault();
      pasteLayers(clip.layers, clip);
    }
  }

  // Any copy marks the internal clipboard stale first (capture runs before
  // the text box stops the event); onCopy / onCut then refresh it when the
  // copy was of layers.
  document.addEventListener("copy", stale, true);
  document.addEventListener("cut", stale, true);
  document.addEventListener("copy", onCopy);
  document.addEventListener("cut", onCut);
  document.addEventListener("paste", onPaste);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("blur", stale);

  return {
    copy,
    cut,
    paste,
    get hasClip() {
      return !!clip;
    },
    dispose() {
      document.removeEventListener("copy", stale, true);
      document.removeEventListener("cut", stale, true);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("paste", onPaste);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", stale);
    },
  };
}
