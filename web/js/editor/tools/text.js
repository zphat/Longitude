// Text tool (T). Click to add text at the point, drag to set a wrap width,
// click on existing text to edit it there. Also the insert.text and
// text.edit commands.

import { svg } from "../../ui/dom.js";
import { createLayer } from "../../core/model.js";
import { measureBox } from "../../core/textlayout.js";
import { textEditorFor } from "../textedit.js";

// A drag makes a fixed-width box only when it is wider than this many doc px
// (at docScale 1), 1.5 em of the new text and MIN_BOX_SCREEN screen px;
// anything narrower is a sloppy click, not a box one letter wide.
const MIN_BOX = 40;
const MIN_BOX_EM = 1.5;
const MIN_BOX_SCREEN = 12;

// Starts editing a new text layer. Falls back to a plain add + edit when the
// editor was built without createTextEditor.
function addAndEdit(kit, props) {
  const te = textEditorFor(kit.ctx);
  if (te?.create) return te.create(props, { caret: "all" });
  const [id] = kit.store.add([createLayer("text", props)], { label: "Add text" });
  if (id) kit.editor.startTextEdit?.(id);
  return id || null;
}

function editAt(kit, id, pt) {
  const te = textEditorFor(kit.ctx);
  if (te?.start) return te.start(id, { caret: pt });
  return kit.editor.startTextEdit?.(id);
}

// Text props for a click at pt (anchored by alignment) or for a dragged box.
export function newTextProps(kit, { at = null, box = null } = {}) {
  const props = { ...kit.textStyle(), text: "Your text" };
  if (box) {
    props.wrap = "fixed";
    props.w = box.w;
    props.x = box.x + box.w / 2;
    const m = measureBox(createLayer("text", { ...props, y: 0 }));
    props.y = box.y + m.h / 2;
    return props;
  }
  const p = at || { x: (kit.store.doc?.width || 1280) / 2, y: (kit.store.doc?.height || 720) / 2 };
  const m = measureBox(createLayer("text", { ...props, x: 0, y: 0 }));
  props.x = props.align === "left" ? p.x + m.w / 2 : props.align === "right" ? p.x - m.w / 2 : p.x;
  props.y = p.y;
  return props;
}

// Whether a dragged box is wide enough to be a fixed-width text box.
export function bigEnoughBox(kit, box, zoom = 1) {
  if (!box) return false;
  const size = Number(kit.textStyle().size) || 120;
  const minW = Math.max(MIN_BOX * kit.docScale(), MIN_BOX_EM * size);
  return box.w >= minW && box.w * (Number(zoom) || 1) >= MIN_BOX_SCREEN;
}

// Where insert.text puts new text: the canvas centre, or the middle of what
// is on screen when the centre is scrolled out of view (zoomed in).
export function insertPoint(kit) {
  const doc = kit.store.doc || { width: 1280, height: 720 };
  const centre = { x: doc.width / 2, y: doc.height / 2 };
  let v = null;
  try {
    v = kit.editor?.getViewport?.();
  } catch {
    v = null;
  }
  if (!v || !(v.zoom > 0) || !(v.width > 0) || !(v.height > 0)) return centre;
  const l = -v.panX / v.zoom;
  const t = -v.panY / v.zoom;
  const r = (v.width - v.panX) / v.zoom;
  const b = (v.height - v.panY) / v.zoom;
  if (![l, t, r, b].every(Number.isFinite)) return centre;
  if (centre.x >= l && centre.x <= r && centre.y >= t && centre.y <= b) return centre;
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  return { x: clamp((l + r) / 2, 0, doc.width), y: clamp((t + b) / 2, 0, doc.height) };
}

export function textTool(kit) {
  let press = null;

  // A press that will not finish (Escape, or the OS or a second finger
  // cancelled the pointer): nothing is made.
  function cancel(api) {
    press = null;
    kit.clearOverlay(api);
    api.clearGuides?.();
  }

  const def = {
    id: "text",
    label: "Text",
    icon: "type",
    key: "T",
    cursor: "text",

    activate(api) {
      api.setCursor("text");
    },

    deactivate(api) {
      press = null;
      kit.clearOverlay(api);
      api.clearGuides?.();
    },

    pointerDown(e, api) {
      if (e.button !== 0) return;
      const raw = api.toDoc(e);
      const hit = api.pick(e);
      press = {
        cx: e.clientX,
        cy: e.clientY,
        start: hit?.type === "text" ? raw : kit.snap(api, raw, e),
        raw,
        hit: hit?.type === "text" ? hit.id : null,
        moved: false,
        end: null,
      };
    },

    pointerMove(e, api) {
      if (!press || !(e.buttons & 1)) return;
      if (!press.moved && !kit.moved(press, e)) return;
      press.moved = true;
      press.end = kit.snap(api, api.toDoc(e), e);
      draw(api);
    },

    pointerUp(e, api) {
      if (!press) return;
      if (e?.type === "pointercancel") {
        cancel(api);
        return;
      }
      const p = press;
      press = null;
      kit.clearOverlay(api);
      api.clearGuides?.();
      if (!p.moved && p.hit) {
        kit.done(api, def);
        editAt(kit, p.hit, p.raw);
        return;
      }
      const box = p.moved && p.end ? rectOf(p.start, p.end) : null;
      kit.done(api, def);
      if (bigEnoughBox(kit, box, api.zoom)) addAndEdit(kit, newTextProps(kit, { box }));
      else addAndEdit(kit, newTextProps(kit, { at: p.start }));
    },

    cancel(api) {
      if (press) cancel(api);
    },

    keyDown(e, api) {
      if (e.key !== "Escape") return false;
      if (press) cancel(api);
      else api.editor.setTool("select");
      return true;
    },

    drawOverlay(api) {
      if (press?.moved) draw(api);
    },
  };

  function draw(api) {
    kit.clearOverlay(api);
    if (!press?.end || !api.overlay) return;
    const m = kit.overlayMap(api);
    const r = rectOf(press.start, press.end);
    const a = m.pt({ x: r.x, y: r.y });
    const b = m.pt({ x: r.x + r.w, y: r.y + r.h });
    const style = kit.textStyle();
    // At least one line tall, so the box reads as "text goes here".
    const lineH = (style.size || 120) * (style.lineHeight || 1.05) * m.k;
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.max(Math.abs(b.y - a.y), lineH);
    api.overlay.append(svg("rect", { class: "draw-box", x, y, width: w, height: h, rx: 2 }));
    kit.pill(api.overlay, `${Math.round(r.w)}`, x + w / 2, y + h + 8);
  }

  return def;
}

function rectOf(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

export function textCommands(kit) {
  const { ctx, editor } = kit;
  const editing = () => !!textEditorFor(ctx)?.active || !!ctx.editor?.textEditing;
  return [
    {
      id: "insert.text",
      title: "Add text",
      group: "Insert",
      icon: "type",
      keywords: "type words title caption heading",
      when: (c) => !!c.store,
      run: () => {
        if (editor.tool !== "select") editor.setTool("select");
        return addAndEdit(kit, newTextProps(kit, { at: insertPoint(kit) }));
      },
    },
    {
      id: "text.edit",
      title: "Edit text",
      group: "Text",
      keys: ["Enter"],
      icon: "type",
      keywords: "type change words",
      when: (c) => {
        const sel = c.store?.selected?.() || [];
        return sel.length === 1 && sel[0].type === "text" && !sel[0].locked && !sel[0].hidden && !editing() && !c.editor?.interacting;
      },
      run: (c) => {
        const layer = c.store.selected()[0];
        if (!layer) return false;
        return editor.startTextEdit ? editor.startTextEdit(layer.id) : textEditorFor(ctx)?.start(layer.id, { caret: "all" });
      },
    },
  ];
}
