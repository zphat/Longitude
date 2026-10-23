// Magic eraser (M). Click a color on an image to remove it and the similar
// colors touching it; Shift removes that color everywhere in the image,
// Alt brings it back. Tolerance comes from prefs "magicTolerance" (0..100,
// default 32; [ and ] change it). Each click is one undo step ("Magic
// eraser") that stores a new mask, combined with the one already there.

import { svg } from "../../ui/dom.js";
import { toLocal, setAlphaMap, hitTest } from "../../core/geometry.js";
import * as maskLib from "../../features/bgremove/mask.js";

export const MAGIC_DEFAULT_TOLERANCE = 32;
const HINT = "Click a color to remove it · Shift: everywhere · Alt: bring back";

export function magicTolerance(prefs) {
  const t = Number(prefs?.get?.("magicTolerance", MAGIC_DEFAULT_TOLERANCE));
  return Number.isFinite(t) ? Math.min(100, Math.max(0, Math.round(t))) : MAGIC_DEFAULT_TOLERANCE;
}

export function hasMagicTarget(store) {
  return !!store?.layers?.().some((l) => l.type === "image" && !l.hidden && !l.locked && l.asset);
}

// Image-local position of a doc point: { u, v } in 0..1 of the natural
// image, and whether it falls inside the layer's frame.
export function imagePoint(layer, pt) {
  const p = toLocal(layer, pt);
  const hw = layer.w / 2;
  const hh = layer.h / 2;
  let inside = Math.abs(p.x) <= hw && Math.abs(p.y) <= hh;
  if (inside && layer.frame === "ellipse") inside = (p.x * p.x) / (hw * hw) + (p.y * p.y) / (hh * hh) <= 1;
  const crop = layer.crop || { x: 0, y: 0, w: 1, h: 1 };
  return { u: crop.x + (p.x / layer.w + 0.5) * crop.w, v: crop.y + (p.y / layer.h + 0.5) * crop.h, inside };
}

// The image under a doc point: a selected one first, then the topmost
// visible, unlocked image (text or shapes above it do not get in the way).
// To erase, a cutout counts only where it is still visible, so a click on
// its cleared background reaches the image you can see underneath. To bring
// color back (restore), the transparent parts are the point: any image
// with a mask whose frame holds the point will do.
export function imageAt(store, pt, { restore = false, assets = null } = {}) {
  const layers = store.layers();
  const sel = new Set(store.selection);
  const fits = (l) => {
    if (l.type !== "image" || l.hidden || l.locked || !l.asset || !imagePoint(l, pt).inside) return false;
    if (restore) return !!l.mask;
    return !l.mask || hitTest(l, pt, { tol: 0, assets });
  };
  for (let i = layers.length - 1; i >= 0; i--) if (sel.has(layers[i].id) && fits(layers[i])) return layers[i];
  for (let i = layers.length - 1; i >= 0; i--) if (fits(layers[i])) return layers[i];
  return null;
}

function newCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

// base + selection: what the click brings back is added to the old mask.
function restoreInto(base, keep) {
  const w = keep.width;
  const h = keep.height;
  const sel = newCanvas(w, h);
  const sg = sel.getContext("2d");
  sg.fillStyle = "#ffffff";
  sg.fillRect(0, 0, w, h);
  sg.globalCompositeOperation = "destination-out";
  sg.drawImage(keep, 0, 0);
  const out = newCanvas(w, h);
  const og = out.getContext("2d");
  og.drawImage(base, 0, 0, w, h);
  og.drawImage(sel, 0, 0);
  return out;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export function magicTool(kit) {
  const { ctx } = kit;
  let busy = false;
  let pending = null; // the click being worked on, until its step is recorded
  let api0 = null;
  let statusTimer = 0;

  const announce = () => ctx.emit("magic", { active: !!api0, tolerance: magicTolerance(ctx.prefs) });

  const def = {
    id: "magic",
    label: "Magic eraser",
    icon: "wand",
    key: "M",
    cursor: "crosshair",

    activate(api) {
      api0 = api;
      api.setCursor("crosshair");
      if (api.editor?.mode !== "magic") api.editor?.setMode?.("magic");
      api.setStatus(HINT);
      announce();
    },

    deactivate(api) {
      clearTimeout(statusTimer);
      api.setStatus(null);
      kit.clearOverlay(api);
      api0 = null;
      announce();
    },

    pointerDown(e, api) {
      if (e.button !== 0 || busy) return;
      const p = run(e, api);
      pending = p;
      p.finally(() => {
        if (pending === p) pending = null;
      });
    },

    pointerMove() {},
    pointerUp() {},

    // The click still being worked on (null when idle), so undo can wait
    // for its step.
    get pending() {
      return pending;
    },

    keyDown(e, api) {
      // Undo while a click is still being worked on waits for its step.
      const which = pending ? kit.historyKey(e) : null;
      if (which) {
        kit.afterPending(pending, which);
        return true;
      }
      if (e.ctrlKey || e.metaKey) return false;
      if (e.key === "Escape" || e.key === "Enter") {
        api.editor.setTool("select");
        return true;
      }
      if (e.key === "[" || e.key === "]") {
        const t = Math.min(100, Math.max(0, magicTolerance(ctx.prefs) + (e.key === "]" ? 8 : -8)));
        ctx.prefs.set("magicTolerance", t);
        flash(api, `Tolerance ${t}`);
        announce();
        return true;
      }
      return false;
    },
  };

  function flash(api, text) {
    clearTimeout(statusTimer);
    api.setStatus(text);
    statusTimer = setTimeout(() => api0 && api0.setStatus(HINT), 1400);
  }

  function ripple(api, e, restore) {
    if (!api.overlay) return;
    const m = kit.overlayMap(api);
    const c = m.client({ x: e.clientX, y: e.clientY });
    const g = svg("g", { class: `magic-ripple${restore ? " restore" : ""}`, transform: `translate(${Math.round(c.x)} ${Math.round(c.y)})` });
    g.append(svg("circle", { r: 26 }), svg("circle", { class: "dot", r: 3 }));
    api.overlay.append(g);
    setTimeout(() => g.remove(), 700);
  }

  async function run(e, api) {
    const store = kit.store;
    const docPt = api.toDoc(e);
    const restore = e.altKey;
    const contiguous = !e.shiftKey;
    const layer = imageAt(store, docPt, { restore, assets: ctx.assets }) || (restore ? imageAt(store, docPt, { assets: ctx.assets }) : null);
    if (!layer) {
      flash(api, "Click on an image");
      return;
    }
    if (typeof maskLib.magicMask !== "function") {
      ctx.ui?.toast?.("The magic eraser is not available.", { kind: "error" });
      return;
    }
    const at = imagePoint(layer, docPt);
    ripple(api, e, restore);
    if (!layer.mask && restore) {
      flash(api, "Nothing to bring back here");
      return;
    }
    busy = true;
    try {
      const [img, base] = await Promise.all([ctx.assets.loadImage(layer.asset), layer.mask ? ctx.assets.loadImage(layer.mask) : null]);
      // Let the ripple paint before the pixel work.
      await pause(16);
      const x = Math.min(img.width - 1, Math.max(0, at.u * img.width));
      const y = Math.min(img.height - 1, Math.max(0, at.v * img.height));
      const tolerance = magicTolerance(ctx.prefs);
      let mask;
      if (restore) {
        const keep = maskLib.magicMask(img, { x, y, tolerance, contiguous, feather: 1, baseMask: null });
        mask = restoreInto(base, keep);
      } else {
        mask = maskLib.magicMask(img, { x, y, tolerance, contiguous, feather: 1, baseMask: base });
      }
      const id = await ctx.assets.addCanvas(mask);
      if (typeof maskLib.maskAlphaMap === "function") setAlphaMap(id, maskLib.maskAlphaMap(mask));
      const now = store.get(layer.id);
      if (!now || now.type !== "image") return;
      store.patch(layer.id, { mask: id }, { label: "Magic eraser" });
      if (store.selection.length !== 1 || store.selection[0] !== layer.id) store.select([layer.id]);
    } catch (err) {
      console.error(err);
      ctx.ui?.toast?.(err?.message || "That did not work.", { kind: "error" });
    } finally {
      busy = false;
    }
  }

  return def;
}
