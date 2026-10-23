// Quick bar (SPEC 10): a small floating island above the selection (below it
// when the selection is near the top) with the few controls people reach for
// most. It hides while anything is being dragged or typed on the canvas and
// comes back where the selection ended up.

import { h, disposer } from "./dom.js";
import { button, iconButton } from "./controls.js";
import { corners } from "../core/geometry.js";
import { Panel, fontButton, ensureIcons, trackBgJobs, bgJob, jobText, progressRing } from "./inspector.js";

const SHOW_DELAY = 90;

// ---- pure placement (tested in tests/inspector-quickbar.test.js) ----------------------

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Screen-space bounds of a set of points.
export function screenBox(points) {
  let l = Infinity;
  let t = Infinity;
  let r = -Infinity;
  let b = -Infinity;
  for (const p of points) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    l = Math.min(l, p.x);
    t = Math.min(t, p.y);
    r = Math.max(r, p.x);
    b = Math.max(b, p.y);
  }
  return l === Infinity ? null : { l, t, r, b };
}

// box: selection bounds in stage px; bar: { w, h }; view: { w, h }.
// Above the box when it fits under the top chrome, else below it (clear of
// the rotation knob), else inside the top of a very tall selection.
export function placeQuickbar(box, bar, view, { gap = 12, below = 52, margin = 8, inset = {} } = {}) {
  const ins = { top: 0, right: 0, bottom: 0, left: 0, ...inset };
  const minX = ins.left + margin;
  const maxX = view.w - ins.right - margin - bar.w;
  const cx = (box.l + box.r) / 2;
  const x = maxX < minX ? (view.w - bar.w) / 2 : clamp(cx - bar.w / 2, minX, maxX);
  const top = ins.top + margin;
  const bottom = view.h - ins.bottom - margin;
  let y = box.t - gap - bar.h;
  let side = "above";
  if (y < top) {
    y = box.b + below;
    side = "below";
    if (y + bar.h > bottom) {
      y = clamp(box.t + gap, top, Math.max(top, bottom - bar.h));
      side = "inside";
    }
  }
  const visible = box.r > ins.left && box.l < view.w - ins.right && box.b > ins.top && box.t < view.h - ins.bottom;
  return { x: Math.round(x), y: Math.round(y), side, visible };
}

// Room the floating chrome (rail, top bar, inspector, zoom island) takes on
// each side of the stage, so the bar never slides under it.
function chromeInsets(stageEl, bar) {
  const out = { top: 0, right: 0, bottom: 0, left: 0 };
  const sr = stageEl.getBoundingClientRect();
  if (!sr.width || !sr.height) return out;
  for (const el of document.querySelectorAll(".island")) {
    if (el === bar || el.closest(".popover, .menu, .dialog, .toast, .tip, .home, [data-no-inset]")) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8 || r.right <= sr.left || r.left >= sr.right || r.bottom <= sr.top || r.top >= sr.bottom) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.05) continue;
    const x = r.left - sr.left;
    const y = r.top - sr.top;
    const tall = r.height >= r.width * 1.2 || r.height > sr.height * 0.4;
    const cx = x + r.width / 2;
    if (tall && cx < sr.width * 0.4) out.left = Math.max(out.left, x + r.width);
    else if (tall && cx > sr.width * 0.6) out.right = Math.max(out.right, sr.width - x);
    else if (y + r.height / 2 < sr.height / 2) out.top = Math.max(out.top, y + r.height);
    else out.bottom = Math.max(out.bottom, sr.height - y);
  }
  out.left = Math.min(out.left, sr.width * 0.4);
  out.right = Math.min(out.right, sr.width * 0.45);
  out.top = Math.min(out.top, sr.height * 0.3);
  out.bottom = Math.min(out.bottom, sr.height * 0.3);
  return out;
}

// ---- mount ------------------------------------------------------------------------

function kindOf(layers) {
  const types = new Set(layers.map((l) => l.type));
  return types.size === 1 ? [...types][0] : "mixed";
}

// Which paint the shape bar leads with (SPEC 10: "colour, width"), so the
// first dot is always the colour you can see:
//   "outline"  every shape is an outline only (the highlight circle): one
//              Colour swatch for the ring, no Fill dot to flood it by mistake
//   "fill"     a fill shows: Fill, then Stroke
//   "stroke"   nothing is filled: Stroke, then an "Add a fill" dot
export function shapePaint(layers) {
  if (!layers.length) return "fill";
  if (layers.every((l) => !l.fill?.on && l.stroke?.on)) return "outline";
  return layers.some((l) => l.fill?.on) ? "fill" : "stroke";
}

// The part of the bar's layout that depends on more than the selected ids.
function layoutOf(layers) {
  return kindOf(layers) === "shape" ? shapePaint(layers) : "";
}

function sep() {
  return h("span", { class: "qb-sep", "aria-hidden": "true" });
}

export function mountQuickbar(stageEl, ctx) {
  ensureIcons();
  trackBgJobs(ctx);
  const store = ctx.store;
  const d = disposer();
  const inner = h("div", { class: "qb-inner" });
  const bar = h("div", { class: "quickbar island", role: "toolbar", "aria-label": "Quick actions", "data-ui": "quickbar", "data-no-inset": "" }, inner);
  bar.inert = true;
  stageEl.append(bar);
  d(() => bar.remove());

  let panel = null;
  let sig = null;
  let layout = null; // layoutOf() the bar was built for
  let shown = false;
  let side = "above";
  let hold = 0; // popovers opened from the bar
  let pressing = false; // pointer held on the canvas
  let suppressed = false; // a transient change is running
  let editing = false;
  let homeOpen = false;
  let showTimer = 0;
  let placeQueued = false;
  let insets = null;

  const pickSide = () => (side === "above" ? "top" : "bottom");
  const interacting = () => hold > 0 || bar.contains(document.activeElement) || bar.matches(":hover:active");

  // ---- content ----

  function build(layers) {
    panel?.destroy();
    const p = new Panel(ctx, layers.map((l) => l.id));
    p.hook = (open) => {
      hold = Math.max(0, hold + (open ? 1 : -1));
      if (!open) setTimeout(refresh, 0);
    };
    const kind = kindOf(layers);
    const parts = [];
    if (kind === "text") {
      parts.push(
        fontButton(p, { compact: true, placement: pickSide }),
        p.num("", { icon: "ins-size", tip: "Font size", undo: "Font size", get: (l) => l.size, set: (v) => ({ size: v }), min: 8, max: 1000, width: 78 }),
        p.swatchButton({ get: (l) => (l.gradient.on ? l.gradient.from : l.color), set: (v) => ({ color: v, gradient: { on: false } }), tip: "Text colour", undo: "Text colour", placement: pickSide }),
        p.iconToggle({ icon: "ins-stroke", tip: "Stroke", get: (l) => l.stroke.on, set: (b) => ({ stroke: { on: b } }), undo: "Text stroke" })
      );
    } else if (kind === "image") {
      parts.push(
        p.dyn(
          () => {
            const ls = p.layers();
            const running = ls.some((l) => !!bgJob(ctx, l.id));
            return running ? "run" : ls.every((l) => l.mask) ? "mask" : "plain";
          },
          (sp, k) => {
            if (k === "run") {
              const ring = progressRing();
              const text = h("span", { class: "qb-job" });
              const upd = () => {
                const job = sp.layers().map((l) => bgJob(ctx, l.id)).find(Boolean);
                ring.set(job?.progress ?? 0);
                ring.classList.toggle("download", job?.phase === "download");
                text.textContent = job?.phase === "download" ? "Downloading" : "Removing";
              };
              upd();
              sp.onUpdate(upd);
              const cancel = iconButton({ icon: "x", tip: "Cancel", size: "sm", onClick: () => sp.layers().forEach((l) => ctx.bg?.cancel?.(l.id)) });
              ring.setAttribute("aria-label", jobText(sp.layers().map((l) => bgJob(ctx, l.id)).find(Boolean)));
              return h("span", { class: "qb-running" }, ring, text, cancel);
            }
            if (k === "mask") {
              const b = button({ label: "Refine", icon: "brush", tip: "Paint to erase or bring back parts of the cutout", kbd: ctx.commands?.keysLabel?.("tool.refine") || "E", onClick: () => ctx.commands?.run?.("tool.refine") });
              b.classList.add("qb-btn");
              b.disabled = sp.ids.length !== 1;
              return b;
            }
            const b = sp.cmd("image.remove-bg", { label: "Remove background", icon: "remove-bg" });
            b.classList.add("qb-btn", "qb-accent");
            return b;
          }
        ),
        (() => {
          const crop = iconButton({
            icon: "crop",
            tip: "Crop",
            kbd: ctx.commands?.keysLabel?.("image.crop") || undefined,
            size: "sm",
            onClick: () => {
              if (ctx.commands?.get?.("image.crop")) ctx.commands.run("image.crop");
              else ctx.editor?.startCrop?.(p.ids[0]);
            },
          });
          crop.disabled = p.ids.length !== 1;
          return crop;
        })(),
        p.cmd("layer.flip-h", { icon: "flip-h", tip: "Flip" }),
        p.iconToggle({ icon: "ins-outline", tip: "Sticker outline", get: (l) => l.outline.on, set: (b) => ({ outline: { on: b } }), undo: "Sticker outline" })
      );
    } else if (kind === "shape") {
      const paint = shapePaint(layers);
      // An off paint opens the picker on its stored colour, not white.
      const stroke = (tip, undo) =>
        p.swatchButton({ get: (l) => (l.stroke.on ? l.stroke.color : null), initial: (l) => l.stroke.color, set: (v) => ({ stroke: { on: true, color: v } }), tip, undo, placement: pickSide });
      const fill = (tip) =>
        p.swatchButton({ get: (l) => (l.fill.on ? l.fill.color : null), initial: (l) => l.fill.color, set: (v) => ({ fill: { on: true, color: v } }), tip, undo: "Fill colour", placement: pickSide });
      const width = p.num("", {
        icon: "ins-width",
        tip: "Stroke width",
        undo: "Stroke width",
        get: (l) => (l.stroke.on ? l.stroke.width : 0),
        set: (v) => (v > 0 ? { stroke: { on: true, width: v } } : { stroke: { on: false } }),
        // An outline-only shape at width 0 would vanish.
        min: paint === "outline" ? 1 : 0,
        max: 60,
        width: 72,
      });
      if (paint === "outline") parts.push(stroke("Colour", layers.every((l) => l.shape === "ellipse") ? "Circle colour" : "Outline colour"), width);
      else if (paint === "fill") parts.push(fill("Fill"), stroke("Stroke", "Stroke colour"), width);
      else parts.push(stroke("Stroke", "Stroke colour"), fill("Add a fill"), width);
    } else if (kind === "arrow" || kind === "path") {
      parts.push(
        p.swatchButton({ get: (l) => l.color, set: (v) => ({ color: v }), tip: "Colour", undo: kind === "arrow" ? "Arrow colour" : "Pen colour", placement: pickSide }),
        p.num("", { icon: "ins-width", tip: "Width", undo: "Width", get: (l) => l.width, set: (v) => ({ width: v }), min: 1, max: kind === "arrow" ? 60 : 80, width: 72 })
      );
    }
    // One click to dead centre, whatever is selected.
    parts.push(p.cmd("align.center", { icon: "align-center", tip: layers.length > 1 ? "Centre the group on the canvas" : "Centre on the canvas" }));
    const del = p.cmd("edit.delete", { icon: "trash", tip: "Delete" });
    del.classList.add("qb-danger");
    parts.push(sep(), p.cmd("layer.duplicate", { icon: "copy-plus", tip: "Duplicate" }), del);
    inner.replaceChildren(...parts);
    bar.dataset.kind = kind;
    panel = p;
    sig = layers.map((l) => l.id).join(",");
    layout = layoutOf(layers);
  }

  // ---- visibility and position ----

  function wanted() {
    if (!store.selection.length || homeOpen || pressing) return false;
    if (editing || ctx.editor?.textEditing) return false;
    const tool = ctx.editor?.tool;
    if (tool && tool !== "select" && tool !== "hand") return false;
    const mode = ctx.editor?.mode;
    if (mode && mode !== "normal") return false;
    return true;
  }

  function hide() {
    clearTimeout(showTimer);
    showTimer = 0;
    if (!shown && bar.inert) return;
    shown = false;
    bar.classList.remove("on");
    bar.inert = true;
  }

  function place() {
    if (!panel || !ctx.editor?.docToScreen) return false;
    const layers = panel.layers();
    if (!layers.length) return false;
    const sr = stageEl.getBoundingClientRect();
    const pts = [];
    for (const l of layers) for (const c of corners(l)) pts.push(ctx.editor.docToScreen(c));
    const sb = screenBox(pts);
    if (!sb) return false;
    const box = { l: sb.l - sr.left, t: sb.t - sr.top, r: sb.r - sr.left, b: sb.b - sr.top };
    insets ??= chromeInsets(stageEl, bar);
    const pos = placeQuickbar(box, { w: bar.offsetWidth, h: bar.offsetHeight }, { w: sr.width, h: sr.height }, { inset: insets });
    side = pos.side;
    bar.dataset.side = pos.side;
    bar.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
    return pos.visible;
  }

  function show() {
    if (shown) {
      if (!place()) hide();
      return;
    }
    if (showTimer) return;
    showTimer = setTimeout(() => {
      showTimer = 0;
      if (!wanted() || suppressed || !panel) return;
      insets = null;
      if (!place()) return;
      shown = true;
      bar.inert = false;
      bar.classList.add("on");
    }, SHOW_DELAY);
  }

  function refresh() {
    if (!wanted()) {
      // A popover opened from the bar keeps it in place until it closes.
      if (!store.selection.length || homeOpen || !interacting()) hide();
      return;
    }
    const layers = store.selected();
    const s = layers.map((l) => l.id).join(",");
    // A layout change (a fill added to a ring) waits until no popover or
    // field in the bar is in use, so a colour drag is never cut short.
    if (s !== sig || !panel || (layoutOf(layers) !== layout && !interacting())) build(layers);
    else panel.update();
    if (suppressed) return;
    show();
  }

  const queuePlace = () => {
    if (!shown || placeQueued || interacting()) return;
    placeQueued = true;
    const run = () => {
      if (!placeQueued) return;
      placeQueued = false;
      if (shown && !place()) hide();
    };
    requestAnimationFrame(run);
    setTimeout(run, 50);
  };

  // ---- wiring ----

  const onChange = (e) => {
    const transient = !!e.detail?.transient;
    if (transient) {
      if (interacting()) {
        panel?.update();
        return;
      }
      suppressed = true;
      hide();
      return;
    }
    suppressed = false;
    refresh();
  };
  const onSelection = () => refresh();
  store.addEventListener("change", onChange);
  store.addEventListener("selection", onSelection);
  d(() => store.removeEventListener("change", onChange));
  d(() => store.removeEventListener("selection", onSelection));

  d(ctx.on("textedit", (det) => {
    editing = !!det?.id;
    refresh();
  }));
  d(ctx.on("home", (det) => {
    homeOpen = !!det?.open;
    refresh();
  }));
  for (const type of ["tool", "mode", "bg-progress", "refine", "magic"]) d(ctx.on(type, () => queueMicrotask(refresh)));
  for (const type of ["zoom", "view", "pan"]) d(ctx.on(type, queuePlace));
  if (ctx.fonts?.addEventListener) {
    const onFont = () => panel?.update();
    ctx.fonts.addEventListener("load", onFont);
    d(() => ctx.fonts.removeEventListener("load", onFont));
  }
  if (typeof ctx.commands?.onChange === "function") d(ctx.commands.onChange(() => panel?.update()));

  // Pressing on the canvas hides the bar until the pointer is released, so it
  // never flickers under a drag or marquee.
  // A field still focused in the bar settles first, while its own gesture is
  // on top: hiding the bar (inert) only moves focus later, after the editor
  // has opened its Resize or Rotate gesture.
  const down = (e) => {
    if (bar.contains(e.target) || e.button === 2) return;
    const ae = document.activeElement;
    if (ae && bar.contains(ae)) {
      ae.blur?.();
      panel?.flush();
    }
    pressing = true;
    hide();
  };
  const up = () => {
    if (!pressing) return;
    pressing = false;
    setTimeout(refresh, 0);
  };
  stageEl.addEventListener("pointerdown", down, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", up, true);
  const dragMove = (e) => e.buttons && queuePlace();
  stageEl.addEventListener("wheel", queuePlace, { passive: true });
  stageEl.addEventListener("pointermove", dragMove, { passive: true });
  d(() => stageEl.removeEventListener("pointermove", dragMove));
  d(() => stageEl.removeEventListener("pointerdown", down, true));
  d(() => window.removeEventListener("pointerup", up, true));
  d(() => window.removeEventListener("pointercancel", up, true));
  d(() => stageEl.removeEventListener("wheel", queuePlace));
  const onResize = () => {
    insets = null;
    queuePlace();
  };
  window.addEventListener("resize", onResize);
  d(() => window.removeEventListener("resize", onResize));
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(() => {
      if (shown) queuePlace();
    });
    ro.observe(bar);
    d(() => ro.disconnect());
  }
  d(() => clearTimeout(showTimer));
  d(() => panel?.destroy());

  refresh();
  return {
    destroy() {
      d.dispose();
    },
    refresh,
  };
}
