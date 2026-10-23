// Drawing and text tools. registerDrawTools(ctx, editor) adds the creation
// tools (text, rectangle, ellipse, highlight circle, arrow, pen), the image
// brushes (refine cutout, magic eraser) and their commands. The editor calls
// it once from createEditor; it returns a dispose function.
//
// The tools share a small kit (styles, snapping, overlay mapping, frames) so
// each tool file stays about its own gesture.

import { svg, isMac } from "../../ui/dom.js";
import { isPlainObject, createLayer } from "../../core/model.js";
import { scaleTextProps } from "../transform.js";
import { textTool, textCommands } from "./text.js";
import { shapeTools } from "./shape.js";
import { arrowTool } from "./arrow.js";
import { penTool } from "./pen.js";
import { refineTool, refineTarget } from "./refine.js";
import { magicTool, hasMagicTarget } from "./magic.js";

export const DRAW_TOOL_IDS = ["text", "rect", "ellipse", "circle", "arrow", "pen", "refine", "magic"];

// Last-used colors and widths per creation tool (prefs "toolColors").
// Widths are doc px on a 1280 px canvas; a remembered width also stores the
// docScale it was set at, so it keeps its look on bigger or smaller canvases.
export const TOOL_DEFAULTS = {
  rect: { color: "#d1ff4a" },
  ellipse: { color: "#d1ff4a" },
  circle: { color: "#ff2d2d", width: 12 },
  arrow: { color: "#ff2d2d", width: 14 },
  pen: { color: "#ff2d2d", width: 10 },
};

// New text when there is no remembered style (prefs "lastTextStyle"), tuned
// for a 1280 px canvas like the tool widths.
export const TEXT_DEFAULTS = {
  font: "Anton",
  weight: 400,
  italic: false,
  size: 120,
  color: "#ffffff",
  stroke: { on: true, color: "#000000", width: 10 },
};

// The props that make up a text style. Position, size of the box and the
// words themselves are not part of it.
export const TEXT_STYLE_KEYS = [
  "font",
  "weight",
  "italic",
  "size",
  "color",
  "gradient",
  "align",
  "lineHeight",
  "letterSpacing",
  "uppercase",
  "stroke",
  "stroke2",
  "bg",
  "shadow",
  "glow",
];

const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const DRAG_PX = 3;

const clone = (v) => (v !== null && typeof v === "object" ? structuredClone(v) : v);

// The docScale a remembered style was saved at (1 for prefs from before it
// was stored, which were nearly all made on 1280 px thumbnails).
const savedScale = (v) => (Number.isFinite(v) && v >= 0.25 && v <= 4 ? v : 1);

// A stroke width carried from one canvas to another (f = new / old scale).
function scaleWidth(w, f) {
  if (Math.abs(f - 1) < 1e-9) return w;
  return Math.min(400, Math.max(0.5, Math.round(w * f * 10) / 10));
}

// The full style of a fresh text layer, so the px values the defaults leave
// to the model (second outline, background pill, shadow, glow) scale too.
let textTemplate = null;
function templateTextStyle() {
  if (!textTemplate) {
    const l = createLayer("text", {});
    textTemplate = {};
    for (const k of TEXT_STYLE_KEYS) if (l[k] !== undefined) textTemplate[k] = l[k];
  }
  return clone(textTemplate);
}

// Runs fn on the next animation frame, or after `fallback` ms when frames
// stall (the desktop app's browser pane can report the page as hidden).
export function nextFrame(fn, fallback = 50) {
  let done = false;
  let raf = 0;
  const run = () => {
    if (done) return;
    done = true;
    if (raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
    clearTimeout(timer);
    fn();
  };
  if (typeof requestAnimationFrame === "function") raf = requestAnimationFrame(run);
  const timer = setTimeout(run, fallback);
  return () => {
    done = true;
    if (raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
    clearTimeout(timer);
  };
}

export const easeOut = (t) => 1 - (1 - t) ** 3;

function cleanStyle(raw, defaults) {
  const out = { ...defaults };
  if (!isPlainObject(raw)) return out;
  if (typeof raw.color === "string" && COLOR_RE.test(raw.color)) out.color = raw.color.toLowerCase();
  if ("width" in defaults && Number.isFinite(raw.width)) {
    out.width = Math.min(400, Math.max(0.5, raw.width));
    const k = savedScale(raw.docScale);
    if (k !== 1) out.docScale = k;
  }
  return out;
}

export function createKit(ctx, editor) {
  const kit = {
    ctx,
    editor,
    frame: nextFrame,
    ease: easeOut,
    get store() {
      return ctx.store;
    },

    // ---- styles ----

    // The remembered style as stored: { color, width?, docScale? }.
    rawStyle(tool) {
      const all = ctx.prefs.get("toolColors", {});
      return cleanStyle(isPlainObject(all) ? all[tool] : null, TOOL_DEFAULTS[tool] || { color: "#ff2d2d" });
    },

    // { color, width? } for a new object on this canvas: the width keeps its
    // size relative to the canvas it was set on.
    style(tool) {
      const raw = kit.rawStyle(tool);
      const out = { color: raw.color };
      if ("width" in raw) out.width = scaleWidth(raw.width, kit.docScale() / (raw.docScale || 1));
      return out;
    },

    // props are doc px on this canvas. A width that differs from style(tool)
    // only by the canvas scaling is not a change.
    saveStyle(tool, props) {
      const defaults = TOOL_DEFAULTS[tool];
      if (!defaults || !isPlainObject(props)) return;
      const all = ctx.prefs.get("toolColors", {});
      const raw = kit.rawStyle(tool);
      const next = { ...raw };
      if (typeof props.color === "string" && COLOR_RE.test(props.color)) next.color = props.color.toLowerCase();
      if ("width" in defaults && Number.isFinite(props.width) && props.width !== kit.style(tool).width) {
        const k = kit.docScale();
        next.width = Math.min(400, Math.max(0.5, props.width));
        if (k !== 1) next.docScale = k;
        else delete next.docScale;
      }
      if (next.color === raw.color && next.width === raw.width && next.docScale === raw.docScale) return;
      ctx.prefs.set("toolColors", { ...(isPlainObject(all) ? all : {}), [tool]: next });
    },

    // Props for a new text layer: the defaults, then the remembered style,
    // scaled from the canvas it was remembered on to this one (size,
    // outlines, background pill and effects together).
    textStyle() {
      const out = templateTextStyle();
      Object.assign(out, clone(TEXT_DEFAULTS));
      const last = ctx.prefs.get("lastTextStyle", null);
      let from = 1;
      if (isPlainObject(last)) {
        for (const k of TEXT_STYLE_KEYS) if (last[k] !== undefined) out[k] = clone(last[k]);
        from = savedScale(last.docScale);
      }
      const f = kit.docScale() / from;
      if (Math.abs(f - 1) < 1e-9 || !Number.isFinite(out.size)) return out;
      Object.assign(out, scaleTextProps(out, f));
      out.size = Math.max(4, Math.round(out.size));
      return out;
    },

    // Stores the style with the docScale of the canvas it is on, so new text
    // elsewhere comes out the same size relative to its canvas.
    rememberText(layer) {
      if (!layer || layer.type !== "text") return;
      const style = {};
      for (const k of TEXT_STYLE_KEYS) style[k] = clone(layer[k]);
      const k = kit.docScale();
      if (k !== 1) style.docScale = k;
      const last = ctx.prefs.get("lastTextStyle", null);
      const keys = [...TEXT_STYLE_KEYS, "docScale"];
      if (isPlainObject(last) && keys.every((key) => JSON.stringify(last[key]) === JSON.stringify(style[key]))) return;
      ctx.prefs.set("lastTextStyle", style);
    },

    // Default sizes are tuned for a 1280 px thumbnail and scale with bigger
    // or smaller canvases so a click always makes something sensibly sized.
    docScale() {
      const d = ctx.store?.doc;
      if (!d) return 1;
      return Math.max(0.25, Math.min(4, Math.max(d.width, d.height) / 1280));
    },

    // ---- undo while a brush is still saving ----

    // "undo" for Mod+Z, "redo" for Mod+Shift+Z and Mod+Y, else null.
    historyKey(e) {
      if (!e || e.altKey || !(isMac ? e.metaKey : e.ctrlKey)) return null;
      const k = String(e.key || "").toLowerCase();
      if (k === "z") return e.shiftKey ? "redo" : "undo";
      if (k === "y" && !e.shiftKey) return "redo";
      return null;
    },

    // Runs undo or redo once `pending` settles. The refine brush and the
    // magic eraser record their step only after the new mask is stored; an
    // undo pressed before that would undo the step before instead.
    afterPending(pending, which) {
      const id = which === "redo" ? "edit.redo" : "edit.undo";
      Promise.resolve(pending)
        .catch(() => {})
        .then(() => {
          if (ctx.commands?.get?.(id)) ctx.commands.run(id);
          else if (which === "redo") ctx.store?.redo?.();
          else ctx.store?.undo?.();
        });
    },

    // ---- pointer helpers ----

    moved(start, e) {
      return Math.hypot(e.clientX - start.cx, e.clientY - start.cy) >= DRAG_PX;
    },

    // Snaps a doc point unless Ctrl is held (which turns snapping off).
    snap(api, pt, e, exclude = []) {
      if (e?.ctrlKey || typeof api.snapPoint !== "function") {
        api.clearGuides?.();
        return pt;
      }
      const out = api.snapPoint(pt, { exclude: exclude.filter(Boolean) });
      return out && Number.isFinite(out.x) && Number.isFinite(out.y) ? out : pt;
    },

    // Coalesced pointer events for smooth strokes (falls back to the event).
    coalesced(e) {
      try {
        const list = e.getCoalescedEvents?.();
        if (list && list.length) return list;
      } catch {}
      return [e];
    },

    // Returns to the select tool after an object is made, unless the tool
    // is sticky (def.sticky, or editor.toolSticky after a double-click on
    // the rail button).
    done(api, def) {
      const ed = api?.editor || editor;
      if (def?.sticky || ed.toolSticky) return;
      if (ed.tool !== "select") ed.setTool("select");
    },

    // Calls fn(e) on Shift/Alt presses and releases while a drag runs (the
    // editor does not pass bare modifier keys to tools). Returns a stop
    // function.
    watchModifiers(fn) {
      const on = (e) => {
        if (e.key !== "Shift" && e.key !== "Alt") return;
        if (e.key === "Alt") e.preventDefault();
        fn(e);
      };
      globalThis.addEventListener("keydown", on);
      globalThis.addEventListener("keyup", on);
      return () => {
        globalThis.removeEventListener("keydown", on);
        globalThis.removeEventListener("keyup", on);
      };
    },

    // ---- overlay ----

    // Maps doc points to the overlay group's own coordinates. k is overlay
    // units per doc px.
    overlayMap(api) {
      const g = api.overlay;
      let inv = null;
      try {
        const m = g?.getScreenCTM?.();
        if (m) inv = m.inverse();
      } catch {
        inv = null;
      }
      let ox = 0;
      let oy = 0;
      if (!inv) {
        const r = g?.ownerSVGElement?.getBoundingClientRect?.();
        if (r) {
          ox = r.left;
          oy = r.top;
        }
      }
      const client = (c) => (inv ? { x: inv.a * c.x + inv.c * c.y + inv.e, y: inv.b * c.x + inv.d * c.y + inv.f } : { x: c.x - ox, y: c.y - oy });
      const pt = (p) => client(api.toScreen(p));
      const o = pt({ x: 0, y: 0 });
      const u = pt({ x: 100, y: 0 });
      const k = Math.hypot(u.x - o.x, u.y - o.y) / 100 || 1;
      // Overlay units per CSS px (1 unless the overlay itself is scaled).
      const unit = inv ? Math.hypot(inv.a, inv.b) || 1 : 1;
      return { pt, client, k, unit };
    },

    clearOverlay(api) {
      const g = api?.overlay;
      if (g) while (g.firstChild) g.firstChild.remove();
    },

    // A small mono pill with a value ("360 × 240"), placed near (x, y) in
    // overlay units.
    pill(parent, text, x, y) {
      if (!parent) return null;
      const w = text.length * 6.7 + 16;
      const g = svg("g", { class: "draw-pill", transform: `translate(${Math.round(x - w / 2)} ${Math.round(y)})` });
      g.append(svg("rect", { width: w, height: 22, rx: 11 }), svg("text", { x: w / 2, y: 15, "text-anchor": "middle", text }));
      parent.append(g);
      return g;
    },
  };
  return kit;
}

// Remember colors, widths and text styles from committed edits, so the next
// object of that kind looks like the last one the user touched.
function rememberFrom(kit, layer) {
  if (!layer) return;
  switch (layer.type) {
    case "text":
      kit.rememberText(layer);
      break;
    case "path":
      kit.saveStyle("pen", { color: layer.color, width: layer.width });
      break;
    case "arrow":
      if (layer.head !== "none" || layer.tail !== "none") kit.saveStyle("arrow", { color: layer.color, width: layer.width });
      break;
    case "shape":
      if (layer.shape === "ellipse" && !layer.fill?.on && layer.stroke?.on) kit.saveStyle("circle", { color: layer.stroke.color, width: layer.stroke.width });
      else if (layer.shape === "ellipse" && layer.fill?.on) kit.saveStyle("ellipse", { color: layer.fill.color });
      else if (layer.shape === "rect" && layer.fill?.on) kit.saveStyle("rect", { color: layer.fill.color });
      break;
  }
}

export function registerDrawTools(ctx, editor) {
  const kit = createKit(ctx, editor);
  const offs = [];
  const tools = [textTool(kit), ...shapeTools(kit), arrowTool(kit), penTool(kit), refineTool(kit), magicTool(kit)];
  for (const t of tools) offs.push(ctx.tools.register(t));

  const setTool = (id) => () => editor.setTool(id);
  const commands = [
    { id: "tool.text", title: "Text", keys: ["T"], icon: "type", keywords: "type words title caption", run: setTool("text") },
    { id: "tool.rect", title: "Rectangle", keys: ["R"], icon: "square", keywords: "box shape banner", run: setTool("rect") },
    { id: "tool.ellipse", title: "Ellipse", keys: ["O"], icon: "circle", keywords: "oval round shape dot", run: setTool("ellipse") },
    { id: "tool.circle", title: "Highlight circle", keys: ["C"], icon: "highlight-circle", keywords: "ring circle red outline mark", run: setTool("circle") },
    { id: "tool.arrow", title: "Arrow", keys: ["A"], icon: "arrow-up-right", keywords: "pointer line", run: setTool("arrow") },
    { id: "tool.pen", title: "Pen", keys: ["P"], icon: "pen", keywords: "draw freehand pencil sketch marker", run: setTool("pen") },
    {
      id: "tool.refine",
      title: "Refine cutout",
      keys: ["E"],
      icon: "brush",
      keywords: "erase restore brush mask background",
      when: (c) => !!refineTarget(c.store),
      run: setTool("refine"),
    },
    {
      id: "tool.magic",
      title: "Magic eraser",
      keys: ["M"],
      icon: "wand",
      keywords: "remove color color background flat erase",
      when: (c) => hasMagicTarget(c.store),
      run: setTool("magic"),
    },
    ...textCommands(kit),
  ];
  for (const c of commands) offs.push(ctx.commands.register({ group: "Tools", ...c }));

  const store = ctx.store;
  if (store?.addEventListener) {
    // Re-measuring (a font finished loading) is not an edit by the user.
    let measuring = false;
    const onRemeasure = () => {
      measuring = true;
      queueMicrotask(() => (measuring = false));
    };
    const onChange = (e) => {
      const d = e.detail || {};
      if (measuring || d.transient || d.reason !== "patch" || !Array.isArray(d.ids) || !d.ids.length || d.ids.length > 6) return;
      for (const id of d.ids) rememberFrom(kit, store.get(id));
    };
    store.addEventListener("remeasure", onRemeasure);
    store.addEventListener("change", onChange);
    offs.push(() => store.removeEventListener("remeasure", onRemeasure));
    offs.push(() => store.removeEventListener("change", onChange));
  }

  return () => {
    while (offs.length) {
      try {
        offs.pop()();
      } catch (err) {
        console.error(err);
      }
    }
  };
}
