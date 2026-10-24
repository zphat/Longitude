// The editor: a full-window canvas behind the floating UI. createEditor()
// builds the stage (canvas + SVG overlay + pills + empty hint), wires pointer,
// wheel, touch and keyboard input to the active tool, renders on demand and
// returns the API in SPEC 8 plus the extras listed below it.

import { h, svg, clear, isTyping, isMac } from "../ui/dom.js";
import { hasIcon, registerIcons } from "../ui/icons.js";
import { keysLabel } from "../app/context.js";
import { pickLayer, refitArrow, arrowPoints } from "../core/geometry.js";
import { createRenderCache } from "../core/render.js";
import { createViewport, detectInsets, freeArea, refitPlan, fitView, fitRectView, zoomAround, stepZoom, clampZoom, clampPan, wheelZoomFactor } from "./viewport.js";
import { createStage, backgroundLightness } from "./stage.js";
import { createSelectionOverlay } from "./selection.js";
import { SNAP_PX, buildTargets, snapPoint as snapPt, pointGuides } from "./snapping.js";
import { createCrop } from "./crop.js";
import { createImporter } from "./importer.js";
import { createClipboard } from "./clipboard.js";
import { createContextMenu } from "./contextmenu.js";
import { createSelectTool } from "./tools/select.js";
import { createHandTool } from "./tools/hand.js";
import { registerDrawTools } from "./tools/draw.js";
import { createTextEditor } from "./textedit.js";

const MODES = ["normal", "crop", "refine", "magic"];
const OVERLAY_PREFS = { safe: "safeZones", grid: "grid", center: "center" };
const OVERLAY_DEFAULTS = { safe: true, grid: false, center: false };
const LOCKED = "This layer is locked. Unlock it to move it.";
const TAP_PX = 8; // a touch that moves less than this is a tap (select.js DRAG_PX.touch)

// Icons the editor uses, for any the shell's set does not have yet (Lucide
// paths, ISC license).
const FALLBACK_ICONS = {
  pointer: '<path d="M4.04 4.69a.5.5 0 0 1 .65-.65l16 6.5a.5.5 0 0 1-.06.95l-6.13 1.58a2 2 0 0 0-1.43 1.43l-1.58 6.13a.5.5 0 0 1-.95.06z"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2 2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  "copy-plus": '<path d="M15 12v6"/><path d="M12 15h6"/><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  clipboard: '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  "chevron-up": '<path d="m18 15-6-6-6 6"/>',
  "chevrons-up": '<path d="m17 11-5-5-5 5"/><path d="m17 18-5-5-5 5"/>',
  "chevrons-down": '<path d="m7 6 5 5 5-5"/><path d="m7 13 5 5 5-5"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  unlock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  "eye-off": '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.39-1.61"/><path d="m2 2 20 20"/>',
  wand: '<path d="m21.64 3.64-1.28-1.28a1.2 1.2 0 0 0-1.72 0L2.36 18.64a1.2 1.2 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/>',
  type: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  "select-all": '<path d="M5 3a2 2 0 0 0-2 2"/><path d="M19 3a2 2 0 0 1 2 2"/><path d="M21 19a2 2 0 0 1-2 2"/><path d="M5 21a2 2 0 0 1-2-2"/><path d="M9 3h1"/><path d="M9 21h1"/><path d="M14 3h1"/><path d="M14 21h1"/><path d="M3 9v1"/><path d="M21 9v1"/><path d="M3 14v1"/><path d="M21 14v1"/>',
  canvas: '<rect width="18" height="14" x="3" y="5" rx="2"/><path d="M7 15h4"/>',
  maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  "image-plus": '<path d="M16 5h6"/><path d="M19 2v6"/><path d="M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/><circle cx="9" cy="9" r="2"/>',
};

function ensureIcons() {
  const missing = {};
  for (const [k, v] of Object.entries(FALLBACK_ICONS)) if (!hasIcon(k)) missing[k] = v;
  if (Object.keys(missing).length) registerIcons(missing);
}

function pointerInfo(e) {
  return {
    clientX: e.clientX,
    clientY: e.clientY,
    shiftKey: !!e.shiftKey,
    altKey: !!e.altKey,
    ctrlKey: !!e.ctrlKey,
    metaKey: !!e.metaKey,
    pointerType: e.pointerType || "mouse",
    pointerId: e.pointerId,
  };
}

export function createEditor(ctx, { host } = {}) {
  if (!host) throw Error("createEditor needs a host element.");
  const store = ctx.store;
  ensureIcons();

  // ---- DOM ------------------------------------------------------------------------

  host.classList.add("ed-host");
  if (getComputedStyle(host).position === "static") host.style.position = "relative";
  const canvas = h("canvas", { class: "ed-canvas", role: "img", "aria-label": "Design canvas" });
  const overlaySvg = svg("svg", { class: "ed-overlay", "aria-hidden": "true" });
  const pillsEl = h("div", { class: "ed-pills", "aria-hidden": "true" });
  const statusEl = h("div", { class: "ed-status", role: "status", "aria-live": "polite" });
  const hint = buildHint();
  host.append(canvas, overlaySvg, hint.el, pillsEl, statusEl);

  function buildHint() {
    const kbd = (combo) => {
      const label = keysLabel(combo);
      const parts = isMac ? [...label] : label.split("+");
      return parts.map((p) => h("kbd", null, p));
    };
    const btn = h("button", { type: "button", class: "btn ghost ed-hint-btn" }, h("span", null, "Choose images"));
    btn.addEventListener("click", () => importer.pick());
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    const el = h(
      "div",
      { class: "ed-hint", "aria-hidden": "true" },
      h("div", { class: "ed-hint-mark" }, svg("svg", { viewBox: "0 0 24 24", class: "i lg" }, svg("path", { d: "M16 5h6M19 2v6M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5" }), svg("path", { d: "m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21" }), svg("circle", { cx: "9", cy: "9", r: "2" }))),
      h("p", { class: "ed-hint-text" }, "Drop images, paste with ", h("span", { class: "ed-hint-keys" }, kbd("Mod+V")), ", or press ", h("span", { class: "ed-hint-keys" }, h("kbd", null, "T")), " for text"),
      btn,
    );
    return { el, btn };
  }

  // ---- state ----------------------------------------------------------------------

  const state = {
    mode: "normal",
    hoverId: null,
    panelHoverId: null,
    guides: [],
    spacing: [],
    marquee: null,
    gesture: null,
    flashes: [],
    scanning: new Map(),
    overlays: {},
    pointer: null,
  };
  for (const k of Object.keys(OVERLAY_PREFS)) state.overlays[k] = !!ctx.prefs.get(OVERLAY_PREFS[k], OVERLAY_DEFAULTS[k]);

  const cache = createRenderCache();
  cache.attach(ctx.assets || null);
  const maskOverrides = new Map();
  let currentId = "select";
  let sticky = false;
  let toolCursor = null;
  let hoverCursor = null;
  let gestureCursor = null;
  let lastCursor = "";
  let spaceDown = false;
  let panning = null;
  let pinch = null;
  let active = null;
  let owner = null; // who the active pointer belongs to: "crop" | "tool", fixed at press
  let interacting = null;
  let homeOpen = false;
  let autoFit = true; // the view is the automatic fit until the user zooms or pans
  let fitPending = true;
  let fitArea = null; // the free area (host size + chrome insets) last fitted to
  let chromeArea = null; // the free area as last measured (layout changes update it)
  let explicitInsets = null;
  let docId = store.doc.id;
  let docW = store.doc.width;
  let docH = store.doc.height;
  let statusPersistent = null;
  let statusTemp = null;
  let statusTimer = 0;
  let tcache = null;
  let destroyed = false;
  let textEditor = null;
  let lastPointer = null;
  const touches = new Map();
  const jobs = new Set();
  const disposers = [];

  const viewport = createViewport({
    host,
    canvas,
    onChange: ({ zoomChanged }) => {
      if (zoomChanged) ctx.emit("zoom", { zoom: viewport.zoom });
      ctx.emit("view", { zoom: viewport.zoom, panX: viewport.panX, panY: viewport.panY });
      if (active !== null && currentId === "select") selectTool.refresh({});
      requestRender();
    },
    // The host or the free area between the chrome changed (window resize,
    // the panel shown or hidden, the interface hidden, a DPR change).
    onResize: ({ resized } = {}) => layoutChanged(resized),
  });

  // ---- rendering ---------------------------------------------------------------------

  let scheduled = false;
  let phase = null; // "jobs" | "draw" while a frame runs
  let rerender = false;
  let canvasDirty = true; // the canvas pass must run (else only the SVG overlay updates)
  let rafId = 0;
  let timerId = 0;

  // Anything that can change the pixels: the doc, the view, the selection
  // (off-artboard ghosts), modes and overlays.
  function requestRender() {
    canvasDirty = true;
    requestFrame();
  }

  // Overlay-only changes (hover outline, guides, marquee, pills): the canvas
  // keeps its pixels, so hovering over a big design costs next to nothing.
  function requestOverlay() {
    requestFrame();
  }

  function requestFrame() {
    // Changes made by this frame's queued pointer moves are drawn by it;
    // requests while drawing (a tool's overlay animating) get a next frame.
    if (phase === "jobs") return;
    if (phase === "draw") {
      rerender = true;
      return;
    }
    if (scheduled || destroyed) return;
    scheduled = true;
    if (typeof document !== "undefined" && document.hidden) {
      timerId = setTimeout(frame, 16);
    } else {
      rafId = requestAnimationFrame(frame);
      // The desktop app's browser pane can stall rAF without reporting hidden.
      timerId = setTimeout(frame, 120);
    }
  }

  function frame() {
    if (!scheduled) return;
    scheduled = false;
    cancelAnimationFrame(rafId);
    clearTimeout(timerId);
    if (destroyed) return;
    let again = false;
    rerender = false;
    phase = "jobs";
    try {
      const now = performance.now();
      again = viewport.tick(now) || again;
      const run = [...jobs];
      jobs.clear();
      for (const fn of run) fn();
      phase = "draw";
      if (canvasDirty) {
        canvasDirty = false;
        again = stage.draw(now) || again;
      }
      overlay.update();
      crop.drawOverlay(overlay.cropGroup);
      const def = ctx.tools.get(currentId);
      if (def?.drawOverlay) def.drawOverlay(api);
      placeHint();
    } catch (err) {
      console.error(err);
    } finally {
      phase = null;
    }
    if (again || state.scanning.size) requestRender();
    else if (rerender) requestFrame();
  }

  // Runs fn at the start of the next frame. Jobs that change the doc or the
  // view mark the canvas through their change events.
  function schedule(fn) {
    jobs.add(fn);
    requestFrame();
  }

  // Draws now rather than next frame: a resize clears the canvas, and inside
  // a ResizeObserver callback the next frame would come after this paint.
  function renderNow() {
    if (phase || destroyed) {
      requestRender();
      return;
    }
    canvasDirty = true;
    scheduled = true;
    frame();
  }

  function placeHint() {
    if (!hint.el.classList.contains("on")) return;
    const c = viewport.docToLocal({ x: store.doc.width / 2, y: store.doc.height / 2 });
    const artW = store.doc.width * viewport.zoom;
    const artH = store.doc.height * viewport.zoom;
    hint.el.classList.toggle("small", artW < 460 || artH < 220);
    hint.el.classList.toggle("tiny", artW < 240 || artH < 120);
    const tf = `translate(${Math.round(c.x)}px, ${Math.round(c.y)}px) translate(-50%, -50%)`;
    if (hint.el.style.transform !== tf) hint.el.style.transform = tf;
  }

  function updateHint() {
    const show = store.doc.layers.length === 0 && !isHomeOpen();
    hint.el.classList.toggle("on", show);
    hint.el.classList.toggle("light", backgroundLightness(store.doc.background) > 0.62);
    hint.el.setAttribute("aria-hidden", show ? "false" : "true");
  }

  // ---- view -----------------------------------------------------------------------------

  function isHomeOpen() {
    try {
      return homeOpen || !!ctx.ui?.isHomeOpen?.();
    } catch {
      return homeOpen;
    }
  }

  function insets() {
    return explicitInsets || detectInsets(host);
  }

  // The host size and chrome insets, measured now (and kept for the pills).
  const area = () => (chromeArea = freeArea(viewport.width, viewport.height, insets()));

  function setView(view, opts) {
    const v = clampPan({ zoom: clampZoom(view.zoom), panX: view.panX, panY: view.panY }, store.doc.width, store.doc.height, viewport.width, viewport.height);
    viewport.set(v, opts);
    requestRender();
  }

  function fitNow(animate) {
    if (!viewport.width || !viewport.height) {
      viewport.syncSize();
      if (!viewport.width || !viewport.height) {
        fitPending = true;
        return;
      }
    }
    fitPending = false;
    fitArea = area();
    viewport.set(fitView(store.doc.width, store.doc.height, viewport.width, viewport.height, fitArea.insets, { maxZoom: 8 }), { animate, ms: 200 });
    requestRender();
  }

  // Fits again when the free area changed while the view is still the
  // automatic fit (no zoom or pan by the user since). The chrome moving on
  // its own (the panel shown or hidden) glides along with it; a window
  // resize follows at once.
  function refit() {
    const now = area();
    if (isHomeOpen()) return;
    const plan = refitPlan(fitArea, now, { auto: autoFit, pending: fitPending });
    if (plan) fitNow(plan.animate);
  }

  // resized: the canvas backing store changed (undefined: measure now).
  function layoutChanged(resized) {
    if (destroyed) return;
    if (resized === undefined) resized = viewport.syncSize();
    refit();
    if (resized) renderNow();
  }

  // Center of the free area (between the chrome), host-local.
  function viewCenter() {
    const i = insets();
    return { x: i.left + (viewport.width - i.left - i.right) / 2, y: i.top + (viewport.height - i.top - i.bottom) / 2 };
  }

  function anchorLocal(anchor) {
    if (anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) return viewport.clientToLocal(anchor.x, anchor.y);
    return viewCenter();
  }

  function setZoom(z, { anchor, animate = true } = {}) {
    autoFit = false;
    viewport.measure();
    setView(zoomAround(viewport.view(), z, anchorLocal(anchor)), { animate, ms: 160 });
  }

  // ---- status pill ------------------------------------------------------------------

  function paintStatus() {
    const text = statusTemp ?? statusPersistent;
    statusEl.classList.toggle("on", !!text);
    if (text && statusEl.textContent !== text) statusEl.textContent = text;
  }

  function setStatus(text) {
    statusPersistent = text ? String(text) : null;
    paintStatus();
  }

  function flashStatus(text, ms = 1600) {
    clearTimeout(statusTimer);
    statusTemp = String(text);
    paintStatus();
    statusTimer = setTimeout(() => {
      statusTemp = null;
      paintStatus();
    }, ms);
  }

  // ---- cursor ----------------------------------------------------------------------------

  function applyCursor() {
    let c;
    if (panning) c = "grabbing";
    else if (spaceDown) c = "grab";
    else c = gestureCursor || hoverCursor || toolCursor || ctx.tools.get(currentId)?.cursor || "default";
    if (c !== lastCursor) {
      canvas.style.cursor = c;
      lastCursor = c;
    }
  }

  // ---- picking and snapping ------------------------------------------------------------

  function pick(p, { pointerType = "mouse" } = {}) {
    const tol = (pointerType === "touch" ? 10 : 4) / viewport.zoom;
    return pickLayer(store.doc, p, { tol, assets: ctx.assets });
  }

  function safeBoxes(doc) {
    const p = ctx.presets?.get?.(doc.preset);
    return (p?.guides || [])
      .filter((g) => g.kind === "safe")
      .map((g) => ({ l: g.x * doc.width, t: g.y * doc.height, r: (g.x + g.w) * doc.width, b: (g.y + g.h) * doc.height, src: "guide" }));
  }

  function targets(exclude = []) {
    const doc = store.doc;
    const key = `${[...exclude].join(",")}|${state.overlays.safe ? 1 : 0}`;
    if (tcache && tcache.doc === doc && tcache.key === key) return tcache.T;
    const T = buildTargets(doc, { exclude, extra: state.overlays.safe ? safeBoxes(doc) : [] });
    tcache = { doc, key, T };
    return T;
  }

  function snapEnabled() {
    return ctx.prefs.get("snap", true) !== false;
  }

  function snapOn(ev) {
    return snapEnabled() && !(ev?.ctrlKey || ev?.metaKey);
  }

  // ---- modes, tools, interaction --------------------------------------------------------

  function setModeInternal(mode) {
    if (!MODES.includes(mode) || mode === state.mode) return;
    state.mode = mode;
    host.dataset.mode = mode;
    ctx.emit("mode", { mode });
    requestRender();
  }

  function interaction(on, kind = null) {
    const next = on ? kind || "drag" : null;
    if (next === interacting) return;
    interacting = next;
    if (next) host.dataset.interacting = next;
    else delete host.dataset.interacting;
    ctx.emit("interaction", { active: !!next, kind: next });
  }

  function currentTool() {
    return ctx.tools.get(currentId) || selectTool;
  }

  function setTool(id, opts = {}) {
    const def = ctx.tools.get(id);
    if (!def) return false;
    if (crop.active) crop.end(true);
    if (id === currentId) {
      sticky = !!(opts.sticky || def.sticky);
      return true;
    }
    if (textEditor?.active) textEditor.stop(true);
    const prev = ctx.tools.get(currentId);
    if (active !== null) cancelActivePointer();
    try {
      prev?.deactivate?.(api);
    } catch (err) {
      console.error(err);
    }
    clear(overlay.toolGroup);
    toolCursor = null;
    hoverCursor = null;
    state.guides = [];
    state.spacing = [];
    if (state.mode === "refine" || state.mode === "magic") setModeInternal("normal");
    currentId = id;
    sticky = !!(opts.sticky || def.sticky);
    try {
      def.activate?.(api);
    } catch (err) {
      console.error(err);
    }
    applyCursor();
    host.dataset.tool = id;
    ctx.emit("tool", { id });
    requestRender();
    return true;
  }

  // Ends whatever the active pointer started (a second finger arrived, the
  // tool changed).
  function cancelActivePointer() {
    const id = active;
    const was = owner;
    active = null;
    owner = null;
    if (id === null) return;
    if (was === "crop") {
      crop.pointerUp();
      return;
    }
    const def = currentTool();
    if (def === selectTool) {
      selectTool.cancel();
      return;
    }
    // Tools with their own cancel(api) (the draw tools, mod tools) get it.
    if (typeof def.cancel === "function") {
      try {
        def.cancel(api);
      } catch (err) {
        console.error(err);
      }
      return;
    }
    const lp = lastPointer || { clientX: 0, clientY: 0 };
    const init = { clientX: lp.clientX, clientY: lp.clientY, pointerId: id, pointerType: lp.pointerType || "mouse", bubbles: false };
    const ev = typeof PointerEvent === "function" ? new PointerEvent("pointercancel", init) : { type: "pointercancel", ...init };
    try {
      def.pointerUp?.(ev, api);
    } catch (err) {
      console.error(err);
    }
  }

  // Ends a select or crop press as if the button came up where the pointer
  // last was (a crop or text edit is starting, something is being pasted):
  // a drag keeps what it did and gets its own undo step. Presses of other
  // tools are theirs to finish. The button may still be down; its later
  // moves only hover and its release is ignored.
  function settlePointer() {
    if (active === null || panning || pinch) return;
    if (owner !== "crop" && currentTool() !== selectTool) return;
    const id = active;
    const was = owner;
    active = null;
    owner = null;
    try {
      if (canvas.hasPointerCapture?.(id)) canvas.releasePointerCapture(id);
    } catch {}
    try {
      if (was === "crop") crop.pointerUp();
      else selectTool.finish();
    } catch (err) {
      console.error(err);
    }
    applyCursor();
    requestRender();
  }

  // Closes whatever holds an undo step open on the canvas (a text edit, a
  // crop; with settle, a select drag too) so the next change records alone.
  function closeSessions({ settle = false } = {}) {
    if (settle) settlePointer();
    if (textEditor?.active) editor.stopTextEdit();
    if (crop.active) crop.end(true);
  }

  // ---- panning and pinch ----------------------------------------------------------------

  // tapClear: the select tool's touch press on empty canvas; released without
  // panning it is a tap, which clears the selection like a mouse click does.
  function startPan(e, { tapClear = false } = {}) {
    autoFit = false;
    viewport.stop();
    panning = { id: e.pointerId, x: e.clientX, y: e.clientY, view: viewport.view(), tapClear };
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {}
    state.gesture = { kind: "pan" };
    interaction(true, "pan");
    applyCursor();
    requestRender();
  }

  function panMove(e) {
    const v = panning.view;
    if (Math.hypot(e.clientX - panning.x, e.clientY - panning.y) >= TAP_PX) panning.far = true;
    setView({ zoom: v.zoom, panX: v.panX + (e.clientX - panning.x), panY: v.panY + (e.clientY - panning.y) });
  }

  // e: the pointerup that ended the pan (none when a pinch takes over).
  function endPan(e) {
    const p = panning;
    if (p && active === p.id) {
      active = null;
      owner = null;
    }
    const tap = p?.tapClear && !p.far && e?.type === "pointerup" && Math.hypot(e.clientX - p.x, e.clientY - p.y) < TAP_PX;
    if (tap && store.selection.length) store.clearSelection();
    panning = null;
    if (state.gesture?.kind === "pan") state.gesture = null;
    if (currentId === "select") selectTool.reset();
    interaction(false);
    applyCursor();
    requestRender();
  }

  function beginPinch() {
    if (active !== null) cancelActivePointer();
    if (panning) endPan();
    const [a, b] = [...touches.values()];
    viewport.measure();
    pinch = {
      d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      c0: viewport.clientToLocal((a.x + b.x) / 2, (a.y + b.y) / 2),
      view0: viewport.view(),
    };
    autoFit = false;
    interaction(true, "pinch");
  }

  function pinchMove() {
    const [a, b] = [...touches.values()];
    if (!a || !b) return;
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const c = viewport.clientToLocal((a.x + b.x) / 2, (a.y + b.y) / 2);
    const v0 = pinch.view0;
    const z = clampZoom((v0.zoom * d) / pinch.d0);
    const dx = (pinch.c0.x - v0.panX) / v0.zoom;
    const dy = (pinch.c0.y - v0.panY) / v0.zoom;
    setView({ zoom: z, panX: c.x - dx * z, panY: c.y - dy * z });
  }

  // ---- pointer input -------------------------------------------------------------------

  function onPointerDown(e) {
    if (e.target !== canvas) return;
    // A field outside the canvas (an inspector number) still has focus: end
    // its edit now, so its value commits before the press and keys go to the canvas.
    const ae = document.activeElement;
    if (ae && ae !== document.body && isTyping(ae) && !host.contains(ae)) ae.blur?.();
    viewport.measure();
    lastPointer = pointerInfo(e);
    if (e.pointerType === "touch") {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        beginPinch();
        return;
      }
      if (touches.size > 2 || pinch) return;
    }
    if (textEditor?.active) textEditor.stop(true);
    if (e.button === 1 || (e.button === 0 && spaceDown)) {
      e.preventDefault();
      active = e.pointerId;
      owner = null;
      startPan(e);
      return;
    }
    if (e.button !== 0) return;
    if (active !== null) return;
    active = e.pointerId;
    // The press keeps its owner to the end: crop mode starting or ending
    // mid-drag must not hand the release to someone else.
    owner = crop.active ? "crop" : "tool";
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {}
    if (owner === "crop") {
      crop.pointerDown(e);
      return;
    }
    try {
      currentTool().pointerDown?.(e, api);
    } catch (err) {
      console.error(err);
    }
    applyCursor();
  }

  function onPointerMove(e) {
    lastPointer = pointerInfo(e);
    state.pointer = viewport.clientToLocal(e.clientX, e.clientY);
    if (touches.has(e.pointerId)) {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch) {
        pinchMove();
        return;
      }
    }
    if (panning) {
      if (e.pointerId === panning.id) panMove(e);
      return;
    }
    if (pinch) return;
    if (active === null && e.target !== canvas) return;
    if (active !== null && e.pointerId !== active) return;
    if (active !== null ? owner === "crop" : crop.active) {
      crop.pointerMove(e);
    } else {
      try {
        currentTool().pointerMove?.(e, api);
      } catch (err) {
        console.error(err);
      }
    }
    applyCursor();
    if (state.gesture?.pillAt === "pointer") requestOverlay();
  }

  function onPointerUp(e) {
    lastPointer = pointerInfo(e);
    touches.delete(e.pointerId);
    if (pinch) {
      if (touches.size < 2) {
        pinch = null;
        interaction(false);
        touches.clear();
      }
      return;
    }
    if (panning) {
      if (e.pointerId === panning.id) endPan(e);
      return;
    }
    if (active === null || e.pointerId !== active) return;
    const was = owner;
    active = null;
    owner = null;
    try {
      if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    } catch {}
    if (was === "crop") {
      crop.pointerUp(e);
    } else {
      try {
        const def = currentTool();
        if (e.type === "pointercancel" && def !== selectTool && typeof def.cancel === "function") def.cancel(api);
        else def.pointerUp?.(e, api);
      } catch (err) {
        console.error(err);
      }
    }
    applyCursor();
    requestRender();
  }

  function onPointerLeave() {
    if (active !== null || panning) return;
    if (state.hoverId) {
      state.hoverId = null;
      requestOverlay();
    }
    hoverCursor = null;
    state.pointer = null;
  }

  // The inline text editor sits on the canvas and follows the view, so the
  // wheel (and pinch, which arrives as Ctrl+wheel) over it still pans and
  // zooms the canvas rather than the browser page.
  const isTextEditBox = (el) => !!el?.classList?.contains("text-edit");

  function onWheel(e) {
    if (isTyping(e.target) && !isTextEditBox(e.target)) return;
    e.preventDefault();
    viewport.measure();
    autoFit = false;
    viewport.stop();
    if (e.ctrlKey || e.metaKey) {
      const anchor = viewport.clientToLocal(e.clientX, e.clientY);
      setView(zoomAround(viewport.view(), viewport.zoom * wheelZoomFactor(e), anchor));
      return;
    }
    let dx = e.deltaX;
    let dy = e.deltaY;
    if (e.deltaMode === 1) {
      dx *= 16;
      dy *= 16;
    } else if (e.deltaMode === 2) {
      dx *= viewport.width;
      dy *= viewport.height;
    }
    if (e.shiftKey && !dx) {
      dx = dy;
      dy = 0;
    }
    setView({ zoom: viewport.zoom, panX: viewport.panX - dx, panY: viewport.panY - dy });
  }

  let gestureZoom = 1;
  function onGestureStart(e) {
    e.preventDefault();
    gestureZoom = viewport.zoom;
  }
  function onGestureChange(e) {
    e.preventDefault();
    autoFit = false;
    setView(zoomAround(viewport.view(), gestureZoom * e.scale, viewport.clientToLocal(e.clientX, e.clientY)));
  }

  function onDblClick(e) {
    if (e.target !== canvas) return;
    if (crop.active) {
      crop.end(true);
      return;
    }
    if (currentId !== "select" || state.mode !== "normal") return;
    const local = viewport.clientToLocal(e.clientX, e.clientY);
    const hd = overlay.hitHandle(local, "mouse");
    const one = store.selected()[0];
    if (hd?.kind === "resize" && (hd.handle === "e" || hd.handle === "w") && one?.type === "text" && one.wrap === "fixed") {
      store.patch(one.id, { wrap: "auto" }, { label: "Auto width" });
      return;
    }
    if (hd?.kind === "bend" && one?.type === "arrow" && one.c) {
      const p = arrowPoints(one);
      store.patch(one.id, refitArrow(one, { a: p.a, b: p.b, c: null }), { label: "Straighten" });
      return;
    }
    const hit = pick(viewport.clientToDoc(e.clientX, e.clientY));
    if (hit?.type === "text") editor.startTextEdit(hit.id);
    else if (hit?.type === "image") editor.startCrop(hit.id);
    else if (!hit) editor.zoomToFit();
  }

  // ---- keyboard ------------------------------------------------------------------------

  const MOD_KEYS = ["Shift", "Alt", "Control", "Meta"];

  function modsOf(e) {
    return { shiftKey: !!e.shiftKey, altKey: !!e.altKey, ctrlKey: !!e.ctrlKey, metaKey: !!e.metaKey };
  }

  function blockedTarget(e) {
    return !!e.target?.closest?.("dialog, [role=dialog], [role=menu], [role=listbox]");
  }

  // Mod+= / Mod+- / Mod+0 / Mod+1 typed into the inline text editor: the zoom
  // command id, or null. App shortcuts skip text fields, and left alone the
  // browser would zoom the whole page.
  const ZOOM_KEYS = { "=": "view.zoom-in", "+": "view.zoom-in", "-": "view.zoom-out", _: "view.zoom-out", 0: "view.fit", 1: "view.actual" };
  const ZOOM_CODES = { Equal: "=", NumpadAdd: "+", Minus: "-", NumpadSubtract: "-", Digit0: "0", Numpad0: "0", Digit1: "1", Numpad1: "1" };
  function textZoomCommand(e) {
    if (!textEditor?.active || !isTextEditBox(e.target) || e.altKey) return null;
    if (!(isMac ? e.metaKey : e.ctrlKey)) return null;
    const id = ZOOM_KEYS[e.key] || ZOOM_KEYS[ZOOM_CODES[e.code]];
    return id && ctx.commands.get?.(id) ? id : null;
  }

  // Keys the editor claims before app shortcuts run. Returns true if handled.
  function handleKey(e) {
    if (e.defaultPrevented || destroyed || e.isComposing || isHomeOpen()) return false;
    const zoomCmd = textZoomCommand(e);
    if (zoomCmd) {
      ctx.commands.run(zoomCmd);
      return true;
    }
    if (isTyping(e.target) || textEditor?.active || blockedTarget(e) || ctx.ui?.isBlocking?.()) return false;
    if (MOD_KEYS.includes(e.key)) {
      if (currentId === "select") selectTool.refresh(modsOf(e));
      return false;
    }
    if (e.code === "Space" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const ae = document.activeElement;
      if (ae && ae !== document.body && ae.matches?.(":focus-visible") && ae.closest?.("button, a, summary, [role=button], [role=switch], [role=tab], [role=menuitem]")) return false;
      if (!spaceDown) {
        spaceDown = true;
        applyCursor();
      }
      return true;
    }
    if (crop.active) return crop.keyDown(e);
    const def = currentTool();
    try {
      if (def.keyDown?.(e, api)) return true;
    } catch (err) {
      console.error(err);
    }
    if (e.key === "Escape" && currentId !== "select") {
      setTool("select");
      return true;
    }
    return false;
  }

  function onKeyDown(e) {
    if (handleKey(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function onKeyUp(e) {
    if (e.code === "Space" && spaceDown) {
      spaceDown = false;
      applyCursor();
    }
    if (MOD_KEYS.includes(e.key)) {
      if (currentId === "select") selectTool.refresh(modsOf(e));
      if (e.key === "Alt" && interacting) e.preventDefault();
    }
  }

  function onBlur() {
    spaceDown = false;
    touches.clear();
    pinch = null;
    applyCursor();
  }

  // ---- the internal core shared by the editor's modules ----------------------------------

  const core = {
    ctx,
    store,
    host,
    canvas,
    overlaySvg,
    pillsEl,
    viewport,
    state,
    cache,
    maskOverrides,
    flashNextAdd: false,
    get toolId() {
      return currentId;
    },
    get textEditing() {
      return textEditor?.active || null;
    },
    get homeOpen() {
      return isHomeOpen();
    },
    get lastPointer() {
      return lastPointer;
    },
    requestRender,
    requestOverlay,
    schedule,
    // The free area between the chrome as last measured ({ w, h, insets }).
    freeArea: () => chromeArea,
    toLocal: (e) => viewport.clientToLocal(e.clientX, e.clientY),
    clientToDoc: (e) => viewport.clientToDoc(e.clientX, e.clientY),
    pick: (p) => pick(p, { pointerType: lastPointer?.pointerType }),
    targets,
    snapOn,
    setHover(id) {
      if (state.hoverId === id) return;
      state.hoverId = id;
      requestOverlay();
    },
    setHoverCursor(css) {
      hoverCursor = css || null;
      applyCursor();
    },
    setGestureCursor(css) {
      gestureCursor = css || null;
      applyCursor();
    },
    setStatus,
    flashStatus,
    interaction,
    startPan,
    settlePointer,
    closeSessions,
    setModeInternal,
  };

  const overlay = createSelectionOverlay(core);
  core.overlay = overlay;
  const crop = createCrop(core);
  core.crop = crop;
  const stage = createStage(core);
  const importer = createImporter(core);
  core.importer = importer;
  const clipboard = createClipboard(core);
  const selectTool = createSelectTool(core);
  const handTool = createHandTool(core);

  // ---- tool api (SPEC 7.2) -----------------------------------------------------------------

  const api = {
    ctx,
    editor: null,
    store,
    toDoc: (e) => viewport.clientToDoc(e.clientX, e.clientY),
    toScreen: (pt) => viewport.docToClient(pt),
    get zoom() {
      return viewport.zoom;
    },
    overlay: overlay.toolGroup,
    requestRender,
    setCursor(css) {
      toolCursor = css || null;
      applyCursor();
    },
    snapPoint(pt, { exclude = [] } = {}) {
      if (!snapOn(lastPointer)) {
        if (state.guides.length) api.clearGuides();
        return { x: pt.x, y: pt.y };
      }
      const T = targets(exclude);
      const s = snapPt(pt, T, SNAP_PX / viewport.zoom);
      const out = { x: s.x, y: s.y };
      state.guides = s.sx || s.sy ? pointGuides(out, T) : [];
      state.spacing = [];
      requestOverlay();
      return out;
    },
    clearGuides() {
      if (!state.guides.length && !state.spacing.length) return;
      state.guides = [];
      state.spacing = [];
      requestOverlay();
    },
    pick: (e) => pick(viewport.clientToDoc(e.clientX, e.clientY), { pointerType: e.pointerType }),
    setStatus,
  };

  // ---- public API (SPEC 8 + extras) ------------------------------------------------------------

  const editor = {
    host,
    canvas,
    overlaySvg,
    get zoom() {
      return viewport.zoom;
    },
    setZoom,
    zoomToFit() {
      autoFit = true;
      fitNow(true);
    },
    zoomToActual() {
      setZoom(1);
    },
    zoomBy(f, anchor) {
      setZoom(viewport.zoom * (Number(f) || 1), { anchor });
    },
    zoomIn(anchor) {
      setZoom(stepZoom(viewport.zoom, 1), { anchor });
    },
    zoomOut(anchor) {
      setZoom(stepZoom(viewport.zoom, -1), { anchor });
    },
    fitRect(rect) {
      if (!rect) return;
      const r = { l: rect.l ?? rect.x, t: rect.t ?? rect.y, r: rect.r ?? rect.x + rect.w, b: rect.b ?? rect.y + rect.h };
      if (![r.l, r.t, r.r, r.b].every(Number.isFinite)) return;
      autoFit = false;
      viewport.measure();
      setView(fitRectView(r, viewport.width, viewport.height, insets(), { pad: 72, maxZoom: 8 }), { animate: true });
    },
    getViewport() {
      return { zoom: viewport.zoom, panX: viewport.panX, panY: viewport.panY, width: viewport.width, height: viewport.height };
    },
    setInsets(v) {
      explicitInsets = v ? { top: v.top || 0, right: v.right || 0, bottom: v.bottom || 0, left: v.left || 0 } : null;
      refit();
    },
    docToScreen: (pt) => viewport.docToClient(pt),
    screenToDoc: (pt) => viewport.clientToDoc(pt.x, pt.y),
    hitTest(clientX, clientY) {
      viewport.measure();
      return pick(viewport.clientToDoc(clientX, clientY));
    },
    // Client rect around the selection (for the quick bar), or null.
    selectionBounds() {
      const r = overlay.selectionRect();
      if (!r) return null;
      const a = viewport.localToClient({ x: r.l, y: r.t });
      const b = viewport.localToClient({ x: r.r, y: r.b });
      return { left: a.x, top: a.y, right: b.x, bottom: b.y, width: b.x - a.x, height: b.y - a.y };
    },
    requestRender,

    get tool() {
      return currentId;
    },
    get toolSticky() {
      return sticky;
    },
    setTool,

    get textEditing() {
      return !!textEditor?.active;
    },
    startTextEdit(id) {
      const l = store.get(id);
      if (!l || l.type !== "text" || l.locked || !textEditor) return false;
      // Enter mid-drag: the drag commits first, then the edit opens its own step.
      settlePointer();
      if (crop.active) crop.end(true);
      if (!(store.selection.length === 1 && store.selection[0] === id)) store.select([id]);
      textEditor.start(id, { caret: "all" });
      requestRender();
      return true;
    },
    stopTextEdit() {
      textEditor?.stop(true);
      requestRender();
    },

    get mode() {
      return state.mode;
    },
    setMode(mode) {
      if (!MODES.includes(mode)) return false;
      if (mode === "crop") {
        const one = store.selected();
        return one.length === 1 ? crop.start(one[0].id) : false;
      }
      if (crop.active) crop.end(true);
      setModeInternal(mode);
      return true;
    },
    startCrop(id) {
      return crop.start(id);
    },
    endCrop(commit = true) {
      return crop.end(commit);
    },
    get cropping() {
      return crop.active;
    },

    flash(ids) {
      const now = performance.now();
      // Skip layers already pulsing (several callers may flash one add).
      const recent = new Set(state.flashes.filter((f) => now - f.start < 150).flatMap((f) => f.ids));
      const list = (Array.isArray(ids) ? ids : [ids]).filter((id) => id && !recent.has(id));
      if (!list.length) return;
      state.flashes.push({ ids: list, start: now });
      requestRender();
    },
    setScanning(layerId, on) {
      if (!layerId) return;
      if (on) {
        if (!state.scanning.has(layerId)) state.scanning.set(layerId, performance.now());
      } else {
        state.scanning.delete(layerId);
      }
      requestRender();
    },
    setMaskOverride(layerId, maskCanvas) {
      if (!layerId) return;
      if (maskCanvas) maskOverrides.set(layerId, maskCanvas);
      else maskOverrides.delete(layerId);
      requestRender();
    },
    setHover(id) {
      const next = id || null;
      if (state.panelHoverId === next) return;
      state.panelHoverId = next;
      requestOverlay();
    },

    importFiles: (files, opts) => importer.importFiles(files, opts),
    pickFiles: () => importer.pick(),
    copy: () => clipboard.copy(),
    cut: () => clipboard.cut(),
    paste: () => clipboard.paste(),
    nudge(dx, dy) {
      if (crop.active) return false;
      const sel = store.selected();
      const ids = sel.filter((l) => !l.locked).map((l) => l.id);
      if (!ids.length) {
        if (sel.length) flashStatus(LOCKED);
        return false;
      }
      return store.patch(ids, (l) => ({ x: l.x + dx, y: l.y + dy }), { label: "Nudge", coalesce: "nudge" });
    },

    get snapEnabled() {
      return snapEnabled();
    },
    set snapEnabled(v) {
      ctx.prefs.set("snap", !!v);
    },
    setOverlay(key, on) {
      if (!(key in OVERLAY_PREFS)) return;
      const v = !!on;
      state.overlays[key] = v;
      if (ctx.prefs.get(OVERLAY_PREFS[key], OVERLAY_DEFAULTS[key]) !== v) ctx.prefs.set(OVERLAY_PREFS[key], v);
      tcache = null;
      requestRender();
    },
    getOverlay(key) {
      return !!state.overlays[key];
    },
    get interacting() {
      return interacting;
    },
    handleKey,
    setStatus,
    flashStatus,
    dispose,
  };
  api.editor = editor;
  core.editor = editor;
  ctx.editor = editor;

  // ---- tools and commands ------------------------------------------------------------------------

  disposers.push(ctx.tools.register(selectTool));
  disposers.push(ctx.tools.register(handTool));

  const single = () => (store.selection.length === 1 ? store.get(store.selection[0]) : null);
  const reg = (def) => disposers.push(ctx.commands.register(def));
  reg({ id: "tool.select", title: "Select", group: "Tools", keys: ["V"], icon: "pointer", keywords: "move pointer arrow choose", run: () => setTool("select") });
  reg({ id: "tool.hand", title: "Hand", group: "Tools", keys: ["H"], icon: "hand", keywords: "pan grab scroll move view", run: () => setTool("hand") });
  reg({
    id: "insert.image",
    title: "Add image",
    group: "Insert",
    keys: ["I"],
    icon: "image",
    keywords: "picture photo upload file import open font",
    run: () => importer.pick(),
  });
  reg({
    id: "image.crop",
    title: "Crop",
    group: "Image",
    keys: ["Enter"],
    icon: "crop",
    keywords: "trim frame cut reframe",
    when: () => {
      const l = single();
      return !!l && l.type === "image" && !l.locked && !l.hidden && state.mode === "normal" && !textEditor?.active && !interacting;
    },
    run: () => {
      const l = single();
      if (l) crop.start(l.id);
    },
  });

  try {
    textEditor = createTextEditor(ctx, editor);
  } catch (err) {
    console.error("Text editing failed to start", err);
  }
  try {
    registerDrawTools(ctx, editor);
  } catch (err) {
    console.error("Drawing tools failed to start", err);
  }

  // ---- events ---------------------------------------------------------------------------------

  function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    disposers.push(() => target.removeEventListener(type, fn, opts));
  }

  on(host, "pointerdown", onPointerDown);
  on(host, "pointermove", onPointerMove);
  on(host, "pointerup", onPointerUp);
  on(host, "pointercancel", onPointerUp);
  on(host, "pointerleave", onPointerLeave);
  on(host, "wheel", onWheel, { passive: false });
  on(host, "gesturestart", onGestureStart);
  on(host, "gesturechange", onGestureChange);
  on(host, "dblclick", onDblClick);
  on(canvas, "dragstart", (e) => e.preventDefault());
  on(window, "keydown", onKeyDown, true);
  on(window, "keyup", onKeyUp, true);
  on(window, "blur", onBlur);
  // Settled at the start of the next frame: by then the shell's media
  // queries have moved the chrome (the panel folds away under 1100 px), so
  // the fit sees the new insets. The ResizeObserver catches the rest.
  const onWindowResize = () => layoutChanged();
  on(window, "resize", () => schedule(onWindowResize));

  let remeasureTimer = 0;
  const onFontLoad = () => {
    clearTimeout(remeasureTimer);
    remeasureTimer = setTimeout(() => {
      if (!store.inGesture) store.remeasure();
      requestRender();
    }, 40);
    requestRender();
  };

  on(store, "change", (e) => {
    const d = e.detail || {};
    const doc = store.doc;
    if (doc.id !== docId) {
      docId = doc.id;
      cache.clear();
      crop.abort();
      selectTool.reset();
      state.flashes = [];
      state.hoverId = null;
      autoFit = true;
      fitNow(false);
    } else {
      if ((d.reason === "undo" || d.reason === "redo" || d.reason === "setdoc") && !d.transient) {
        crop.abort();
        selectTool.reset();
      }
      if ((doc.width !== docW || doc.height !== docH) && autoFit) fitNow(true);
    }
    docW = doc.width;
    docH = doc.height;
    if (crop.active && !store.get(crop.active)) crop.abort({ commit: true });
    if (d.reason === "add" && !d.transient && d.ids?.length && (core.flashNextAdd || currentId === "select")) editor.flash(d.ids);
    core.flashNextAdd = false;
    tcache = null;
    updateHint();
    requestRender();
  });

  on(store, "selection", () => {
    if (crop.active && !(store.selection.length === 1 && store.selection[0] === crop.active)) crop.end(true);
    if (state.hoverId && store.selection.includes(state.hoverId)) state.hoverId = null;
    requestRender();
  });

  if (ctx.assets?.addEventListener) on(ctx.assets, "ready", () => requestRender());
  if (ctx.fonts?.addEventListener) {
    on(ctx.fonts, "load", onFontLoad);
    on(ctx.fonts, "change", onFontLoad);
  }
  if (typeof document !== "undefined" && document.fonts?.addEventListener) on(document.fonts, "loadingdone", () => requestRender());
  on(document, "visibilitychange", () => requestRender());

  disposers.push(
    ctx.on("theme", () => {
      stage.readTheme();
      requestRender();
    }),
  );
  disposers.push(
    ctx.on("prefs", ({ key, value }) => {
      for (const [k, pref] of Object.entries(OVERLAY_PREFS)) {
        if (key === pref) {
          state.overlays[k] = !!value;
          tcache = null;
          requestRender();
        }
      }
    }),
  );
  disposers.push(
    ctx.on("home", ({ open }) => {
      homeOpen = !!open;
      if (!homeOpen) {
        viewport.syncSize();
        if (autoFit) fitNow(false);
      }
      updateHint();
      requestRender();
    }),
  );
  disposers.push(ctx.on("textedit", () => requestRender()));
  disposers.push(
    ctx.tools.onChange(() => {
      if (currentId && !ctx.tools.get(currentId)) {
        currentId = null;
        setTool("select");
      }
    }),
  );
  // A mod turned on or off can add or remove a shape or filter: redraw.
  for (const reg of [ctx.shapes, ctx.filters]) {
    const off = reg?.onChange?.(() => {
      cache.clear();
      requestRender();
    });
    if (typeof off === "function") disposers.push(off);
  }

  function dispose() {
    destroyed = true;
    cancelAnimationFrame(rafId);
    clearTimeout(timerId);
    clearTimeout(statusTimer);
    clearTimeout(remeasureTimer);
    for (const d of disposers.splice(0).reverse()) {
      try {
        d();
      } catch (err) {
        console.error(err);
      }
    }
    importer.dispose();
    clipboard.dispose();
    contextMenu.dispose();
    crop.dispose();
    viewport.dispose();
    cache.dispose();
    canvas.remove();
    overlaySvg.remove();
    pillsEl.remove();
    statusEl.remove();
    hint.el.remove();
    host.classList.remove("ed-host");
  }

  const contextMenu = createContextMenu(core);

  // ---- start -------------------------------------------------------------------------------------

  host.dataset.tool = currentId;
  host.dataset.mode = state.mode;
  viewport.syncSize();
  viewport.observe();
  fitNow(false);
  updateHint();
  applyCursor();
  requestRender();
  return editor;
}
