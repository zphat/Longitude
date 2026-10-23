// Refine cutout (E). A soft brush that paints the selected image's mask:
// erase takes pixels away, restore brings them back (X switches, Alt flips it
// while held). [ and ] change the size, Shift+click paints a straight line
// from the last point. Each stroke is one undo step ("Refine cutout").
//
// The mask is painted on a working canvas the editor draws live (through
// editor.setMaskOverride); on release it is stored as a new mask asset.
// Brush settings live in prefs "refineBrush" { size, hardness, mode } (size is
// the diameter in screen px); every change is announced with
// ctx.emit("refine", state) so the inspector can show the controls.

import { svg } from "../../ui/dom.js";
import { toLocal, fromLocal, setAlphaMap } from "../../core/geometry.js";
import * as maskLib from "../../features/bgremove/mask.js";

export const BRUSH_DEFAULTS = { size: 48, hardness: 0.6, mode: "erase" };
const MIN_SIZE = 4;
const MAX_SIZE = 400;

const f = (v) => Math.round(v * 100) / 100;

// The image the brush works on: exactly one selected, visible, unlocked
// image. Without a mask the brush starts from a fully opaque one, so it
// doubles as a plain eraser.
export function refineTarget(store, { needMask = false } = {}) {
  const sel = store?.selected?.() || [];
  if (sel.length !== 1) return null;
  const l = sel[0];
  if (l.type !== "image" || l.hidden || l.locked || !l.asset) return null;
  if (needMask && !l.mask) return null;
  return l;
}

export function cleanBrush(raw) {
  const b = raw && typeof raw === "object" ? raw : {};
  const size = Number.isFinite(b.size) ? Math.round(Math.min(MAX_SIZE, Math.max(MIN_SIZE, b.size))) : BRUSH_DEFAULTS.size;
  const hardness = Number.isFinite(b.hardness) ? Math.min(1, Math.max(0, b.hardness)) : BRUSH_DEFAULTS.hardness;
  const mode = b.mode === "restore" ? "restore" : "erase";
  return { size, hardness, mode };
}

// Doc point -> natural mask pixel, through the layer transform and crop.
export function maskPoint(layer, w, h, pt) {
  const p = toLocal(layer, pt);
  const crop = layer.crop || { x: 0, y: 0, w: 1, h: 1 };
  const u = crop.x + (p.x / layer.w + 0.5) * crop.w;
  const v = crop.y + (p.y / layer.h + 0.5) * crop.h;
  return { x: u * w, y: v * h };
}

// Mask pixels per doc pixel (the average of both axes).
export function maskScale(layer, w, h) {
  const crop = layer.crop || { x: 0, y: 0, w: 1, h: 1 };
  return ((w * crop.w) / layer.w + (h * crop.h) / layer.h) / 2;
}

function newCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

function snapshot(canvas) {
  const c = newCanvas(canvas.width, canvas.height);
  c.getContext("2d").drawImage(canvas, 0, 0);
  return c;
}

export function refineTool(kit) {
  const { ctx, editor } = kit;
  let api0 = null;
  let target = null; // { id, mask, asset, canvas, w, h, opaque }
  let loadToken = 0;
  let stroke = null; // { last, mode, queue, pending, dirty }
  let stale = false; // a cancelled stroke left paint on the canvas: reload after the saves
  let lastPt = null;
  let hover = null; // { client, alt }
  let saving = 0;
  let chain = Promise.resolve();
  let offs = [];
  let ghost = null; // { url, asset }
  let els = null; // overlay groups
  let exiting = false;
  let expanded = null; // id of the layer whose trimmed box this tool grew back

  const brush = () => cleanBrush(ctx.prefs.get("refineBrush", BRUSH_DEFAULTS));
  const state = () => ({ ...brush(), active: !!api0, layerId: target?.id || null, ready: !!target?.canvas });
  const announce = () => ctx.emit("refine", state());

  function setBrush(patch) {
    ctx.prefs.set("refineBrush", cleanBrush({ ...brush(), ...patch }));
  }

  const def = {
    id: "refine",
    label: "Refine cutout",
    icon: "brush",
    key: "E",
    cursor: "none",

    activate(api) {
      api0 = api;
      exiting = false;
      const layer = refineTarget(kit.store, { needMask: false });
      if (!layer) {
        exit("Select an image to refine first.");
        return;
      }
      api.setCursor("none");
      if (api.editor?.mode !== "refine") api.editor?.setMode?.("refine");
      listen();
      retarget(layer);
      status();
      announce();
    },

    deactivate(api) {
      if (stroke) endStroke();
      for (const off of offs.splice(0)) off();
      if (target && !saving) editor.setMaskOverride?.(target.id, null);
      if (target && expanded === target.id) refit(target.id);
      expanded = null;
      revokeGhost();
      api.setStatus(null);
      kit.clearOverlay(api);
      els = null;
      api0 = null;
      loadToken++;
      target = null;
      hover = null;
      ctx.emit("refine", { ...brush(), active: false, layerId: null, ready: false });
    },

    pointerDown(e, api) {
      if (e.button !== 0 || !target) return;
      if (!target.canvas) {
        api.setStatus("Loading the cutout…");
        return;
      }
      const layer = kit.store.get(target.id);
      if (!layer) return;
      const pt = maskPoint(layer, target.w, target.h, api.toDoc(e));
      const mode = modeFor(e);
      stroke = { last: pt, mode, queue: [], pending: null, dirty: false };
      paint(e.shiftKey && lastPt ? lastPt : pt, pt);
      hover = { client: { x: e.clientX, y: e.clientY }, alt: e.altKey };
      drawCursor();
    },

    pointerMove(e, api) {
      hover = { client: { x: e.clientX, y: e.clientY }, alt: e.altKey };
      if (stroke && target?.canvas) {
        if (!(e.buttons & 1)) {
          endStroke();
        } else {
          const layer = kit.store.get(target.id);
          if (layer) for (const ev of kit.coalesced(e)) stroke.queue.push(maskPoint(layer, target.w, target.h, api.toDoc(ev)));
          if (!stroke.pending) stroke.pending = kit.frame(flush, 16);
        }
      }
      drawCursor();
    },

    pointerUp(e) {
      if (!stroke) return;
      // The OS or a second finger (pinch) took the pointer: take the dab back.
      if (e?.type === "pointercancel") cancelStroke();
      else endStroke();
    },

    cancel() {
      if (stroke) cancelStroke();
    },

    // Settles once every finished stroke is stored and recorded (null when
    // nothing is saving), so undo can wait for the stroke's own step.
    get pending() {
      return saving ? chain : null;
    },

    keyDown(e) {
      // Undo while a stroke is still being saved waits for its step.
      const which = saving ? kit.historyKey(e) : null;
      if (which) {
        kit.afterPending(chain, which);
        return true;
      }
      if (e.ctrlKey || e.metaKey) return false;
      const k = e.key;
      if (k === "x" || k === "X") {
        setBrush({ mode: brush().mode === "erase" ? "restore" : "erase" });
        return true;
      }
      if (k === "[" || k === "]") {
        const s = brush().size;
        setBrush({ size: k === "]" ? Math.max(s + 2, s * 1.25) : Math.min(s - 2, s / 1.25) });
        return true;
      }
      if (k === "Escape" || k === "Enter") {
        exit();
        return true;
      }
      return false;
    },

    drawOverlay() {
      drawCursor();
    },
  };

  function exit(message) {
    if (exiting) return;
    exiting = true;
    if (message) ctx.ui?.toast?.(message, { kind: "info" });
    // Leave from outside the current tool call.
    setTimeout(() => {
      if (editor.tool === "refine") editor.setTool("select");
    }, 0);
  }

  function modeFor(e) {
    const m = brush().mode;
    return e?.altKey ? (m === "erase" ? "restore" : "erase") : m;
  }

  function status() {
    if (!api0) return;
    const m = brush().mode;
    api0.setStatus(m === "erase" ? "Erasing · X to restore · [ ] brush size" : "Restoring · X to erase · [ ] brush size");
  }

  function listen() {
    const store = kit.store;
    const onChange = (e) => {
      const d = e.detail || {};
      if (!target || (d.ids && !d.ids.includes(target.id))) return;
      const layer = store.get(target.id);
      if (!layer || layer.type !== "image") {
        exit();
        return;
      }
      if (layer.mask !== target.mask && !stroke && !saving) reload(layer);
      drawCursor();
    };
    const onSelection = () => {
      const layer = refineTarget(store, { needMask: false });
      if (!layer) exit();
      else if (layer.id !== target?.id) retarget(layer);
    };
    const onLeave = () => {
      hover = null;
      drawCursor();
    };
    store.addEventListener("change", onChange);
    store.addEventListener("selection", onSelection);
    offs.push(() => store.removeEventListener("change", onChange));
    offs.push(() => store.removeEventListener("selection", onSelection));
    const host = editor.host;
    if (host) {
      host.addEventListener("pointerleave", onLeave);
      offs.push(() => host.removeEventListener("pointerleave", onLeave));
    }
    // Alt flips erase and restore while held; the ring shows it at once.
    offs.push(
      kit.watchModifiers((e) => {
        if (e.key !== "Alt" || !hover) return;
        hover.alt = e.type === "keydown";
        drawCursor();
      }),
    );
    offs.push(
      ctx.on("prefs", (d) => {
        if (d?.key !== "refineBrush") return;
        status();
        drawCursor();
        announce();
      }),
    );
  }

  function retarget(layer) {
    if (stroke) endStroke();
    if (target && target.id !== layer.id && !saving) editor.setMaskOverride?.(target.id, null);
    if (target && target.id !== layer.id && expanded === target.id) {
      refit(target.id);
      expanded = null;
    }
    lastPt = null;
    target = { id: layer.id, mask: layer.mask, asset: layer.asset, canvas: null, w: 0, h: 0 };
    expandBox(layer);
    reload(layer);
    loadGhost(layer);
  }

  // A box fitted to the cutout (bgremove trims it) would clip restore strokes
  // and the ghost to the trimmed box, so parts the model cut off outside it
  // could not be painted back. While refining, the layer gets its whole box
  // back; it is fitted again when the tool leaves it.
  function expandBox(layer) {
    const box = layer.mask ? ctx.bg?.untrimProps?.(layer.id) : null;
    if (!box) return;
    kit.store.patch(layer.id, box, { label: "Refine cutout" });
    expanded = layer.id;
  }

  // Fits the box to the stored mask once every stroke has been saved.
  function refit(id) {
    if (typeof ctx.bg?.cutoutProps !== "function") return;
    chain
      .then(async () => {
        const layer = kit.store.get(id);
        if (!layer?.mask || (api0 && target?.id === id)) return;
        const mask = await ctx.assets.loadImage(layer.mask);
        const now = kit.store.get(id);
        // The tool came back to this layer meanwhile, or the mask changed.
        if (!now || now.mask !== layer.mask || (api0 && target?.id === id)) return;
        const fit = ctx.bg.cutoutProps(id, mask);
        if (fit) kit.store.patch(id, fit, { label: "Refine cutout" });
      })
      .catch((err) => console.error(err));
  }

  // Load the layer's mask (or a fully opaque one) into the working canvas.
  async function reload(layer) {
    const token = ++loadToken;
    const t = target;
    stale = false;
    t.mask = layer.mask;
    t.canvas = null;
    try {
      const src = await ctx.assets.loadImage(layer.mask || layer.asset);
      if (token !== loadToken || target !== t) return;
      const canvas = newCanvas(src.width, src.height);
      const g = canvas.getContext("2d", { willReadFrequently: true });
      if (layer.mask) {
        g.drawImage(src, 0, 0);
      } else {
        g.fillStyle = "#ffffff";
        g.fillRect(0, 0, canvas.width, canvas.height);
      }
      t.canvas = canvas;
      t.w = canvas.width;
      t.h = canvas.height;
      // Nothing erased yet: restoring cannot change anything.
      t.opaque = !layer.mask;
      editor.setMaskOverride?.(t.id, null);
      if (api0?.setStatus) status();
      announce();
      drawCursor();
    } catch (err) {
      console.error(err);
      if (token === loadToken) exit("This image could not be loaded.");
    }
  }

  function brushRadius(layer) {
    const zoom = Number(api0?.zoom) || 1;
    return Math.max(0.5, (brush().size / 2 / zoom) * maskScale(layer, target.w, target.h));
  }

  // Paints one segment. The stroke is dirty (worth saving) only once the
  // brush has touched the mask and could change it: a dab outside the image,
  // or restoring on a mask nothing was erased from, leaves no undo step.
  function paint(from, to) {
    const layer = kit.store.get(target.id);
    if (!layer || !target.canvas || typeof maskLib.paintMask !== "function") return;
    const b = brush();
    const mode = stroke?.mode || b.mode;
    if (mode === "restore" && target.opaque) return;
    const r = maskLib.paintMask(target.canvas, from, to, { radius: brushRadius(layer), hardness: b.hardness, mode });
    if (!r) return;
    if (stroke) stroke.dirty = true;
    if (mode === "erase") target.opaque = false;
    editor.setMaskOverride?.(target.id, target.canvas);
    api0?.requestRender();
  }

  function flush() {
    if (!stroke) return;
    stroke.pending = null;
    for (const p of stroke.queue.splice(0)) {
      if (Math.hypot(p.x - stroke.last.x, p.y - stroke.last.y) < 0.25) continue;
      paint(stroke.last, p);
      stroke.last = p;
    }
  }

  function endStroke() {
    flush();
    stroke.pending?.();
    const s = stroke;
    stroke = null;
    lastPt = s.last;
    maskLib.endMaskStroke?.(target.canvas);
    if (s.dirty) save();
  }

  // Drops the stroke and puts the canvas back to the stored mask. While an
  // earlier stroke is still being saved, the brush waits (no canvas) and the
  // save's finally step reloads once it has landed.
  function cancelStroke() {
    stroke.pending?.();
    const s = stroke;
    stroke = null;
    maskLib.endMaskStroke?.(target?.canvas);
    if (!s.dirty || !target) return;
    if (saving) {
      stale = true;
      target.canvas = null;
      drawCursor();
      return;
    }
    const layer = kit.store.get(target.id);
    editor.setMaskOverride?.(target.id, null);
    editor.requestRender?.();
    if (layer && layer.type === "image") reload(layer);
  }

  // Store the painted mask as a new asset and point the layer at it. Saves
  // run in order so a quick second stroke never lands before the first.
  function save() {
    const t = target;
    if (!t?.canvas) return;
    const copy = snapshot(t.canvas);
    saving++;
    chain = chain
      .then(async () => {
        const id = await ctx.assets.addCanvas(copy);
        if (typeof maskLib.maskAlphaMap === "function") setAlphaMap(id, maskLib.maskAlphaMap(copy));
        const layer = kit.store.get(t.id);
        if (!layer || layer.type !== "image") return;
        t.mask = id;
        kit.store.patch(t.id, { mask: id }, { label: "Refine cutout" });
      })
      .catch((err) => {
        console.error(err);
        ctx.ui?.toast?.(err?.message || "The cutout could not be saved.", { kind: "error" });
      })
      .finally(() => {
        saving--;
        if (saving || stroke) return;
        editor.setMaskOverride?.(t.id, null);
        editor.requestRender?.();
        const layer = kit.store.get(t.id);
        if (target === t && layer && (layer.mask !== t.mask || stale)) reload(layer);
      });
  }

  // ---- overlay: brush ring, and the removed parts faintly while restoring ----

  async function loadGhost(layer) {
    revokeGhost();
    try {
      const blob = await ctx.assets.getBlob(layer.asset);
      if (!blob || !target || target.id !== layer.id) return;
      ghost = { url: URL.createObjectURL(blob), asset: layer.asset };
      drawCursor();
    } catch {}
  }

  function revokeGhost() {
    if (ghost?.url) URL.revokeObjectURL(ghost.url);
    ghost = null;
  }

  // Two layers in the tool overlay: the ghost (rebuilt only when the view,
  // the layer or the mode changes) and the brush ring (moves with the pointer).
  function overlayEls(api) {
    if (els && els.root === api.overlay && els.ghost.isConnected) return els;
    kit.clearOverlay(api);
    els = { root: api.overlay, ghost: svg("g", { class: "refine-ghost" }), cursor: svg("g"), key: "" };
    api.overlay.append(els.ghost, els.cursor);
    return els;
  }

  function currentMode() {
    const m = brush().mode;
    return hover?.alt ? (m === "erase" ? "restore" : "erase") : m;
  }

  function drawGhost(api, m) {
    const e = overlayEls(api);
    const layer = target ? kit.store.get(target.id) : null;
    const show = !!(layer && ghost && currentMode() === "restore");
    const o = show ? m.pt(fromLocal(layer, { x: 0, y: 0 })) : null;
    const ux = show ? m.pt(fromLocal(layer, { x: 1, y: 0 })) : null;
    const uy = show ? m.pt(fromLocal(layer, { x: 0, y: 1 })) : null;
    const matrix = show ? [ux.x - o.x, ux.y - o.y, uy.x - o.x, uy.y - o.y, o.x, o.y].map(f).join(" ") : "";
    const key = show ? [matrix, ghost.url, layer.w, layer.h, layer.frame, layer.radius, JSON.stringify(layer.crop)].join("|") : "";
    if (key === e.key) return;
    e.key = key;
    while (e.ghost.firstChild) e.ghost.firstChild.remove();
    if (!show) return;
    const crop = layer.crop || { x: 0, y: 0, w: 1, h: 1 };
    const w = layer.w;
    const h = layer.h;
    const g = svg("g", { transform: `matrix(${matrix})` });
    const clip = svg("clipPath", { id: "lg-refine-clip", clipPathUnits: "userSpaceOnUse" });
    if (layer.frame === "ellipse") clip.append(svg("ellipse", { cx: 0, cy: 0, rx: w / 2, ry: h / 2 }));
    else clip.append(svg("rect", { x: -w / 2, y: -h / 2, width: w, height: h, rx: Math.min(layer.radius || 0, w / 2, h / 2) }));
    g.append(
      clip,
      svg("image", {
        href: ghost.url,
        x: -w / 2 - (crop.x / crop.w) * w,
        y: -h / 2 - (crop.y / crop.h) * h,
        width: w / crop.w,
        height: h / crop.h,
        preserveAspectRatio: "none",
        "clip-path": "url(#lg-refine-clip)",
      }),
    );
    e.ghost.append(g);
  }

  function drawCursor() {
    const api = api0;
    if (!api?.overlay) return;
    const m = kit.overlayMap(api);
    drawGhost(api, m);
    const e = overlayEls(api);
    while (e.cursor.firstChild) e.cursor.firstChild.remove();
    if (!hover) return;
    const mode = currentMode();
    const c = m.client(hover.client);
    const r = (brush().size / 2) * m.unit;
    const g = svg("g", { class: `brush-cursor ${mode}${target?.canvas ? "" : " loading"}`, transform: `translate(${f(c.x)} ${f(c.y)})` });
    const s = Math.min(5, Math.max(3, r * 0.3));
    const sign = mode === "restore" ? `M${-s} 0H${s}M0 ${-s}V${s}` : `M${-s} 0H${s}`;
    g.append(
      svg("circle", { class: "halo", r: f(r) }),
      svg("circle", { class: "ring", r: f(r) }),
      svg("path", { class: "sign-halo", d: sign }),
      svg("path", { class: "sign", d: sign }),
    );
    e.cursor.append(g);
  }

  return def;
}

