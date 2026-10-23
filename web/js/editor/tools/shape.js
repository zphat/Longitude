// Shape tools: rectangle (R), ellipse (O) and the highlight circle (C), the
// red ring every thumbnail needs. Drag from a corner; Shift keeps it square,
// Alt draws from the centre. A click makes a default-sized shape centred at
// the point. The shape is a real layer from the first drag step, so the
// preview is exactly what you get; the whole drag is one undo step.

import { createLayer } from "../../core/model.js";

// A drag that ends smaller than this on screen (both sides) counts as a click.
const MIN_SCREEN = 8;

const SPECS = [
  {
    id: "rect",
    label: "Rectangle",
    icon: "square",
    key: "R",
    shape: "rect",
    name: "Rectangle",
    undo: "Add rectangle",
    size: [240, 240],
    props: (s) => ({ fill: { on: true, color: s.color }, stroke: { on: false } }),
  },
  {
    id: "ellipse",
    label: "Ellipse",
    icon: "circle",
    key: "O",
    shape: "ellipse",
    name: "Ellipse",
    undo: "Add ellipse",
    size: [240, 240],
    props: (s) => ({ fill: { on: true, color: s.color }, stroke: { on: false } }),
  },
  {
    id: "circle",
    label: "Highlight circle",
    icon: "highlight-circle",
    key: "C",
    shape: "ellipse",
    name: "Circle",
    undo: "Add circle",
    size: [360, 220],
    props: (s) => ({ fill: { on: false }, stroke: { on: true, color: s.color, width: s.width, dash: false } }),
  },
];

// Box from a drag: a is where it started, b where the pointer is.
export function dragBox(a, b, { square = false, center = false } = {}) {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  if (square) {
    const s = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * s;
    dy = (dy < 0 ? -1 : 1) * s;
  }
  if (center) return { x: a.x, y: a.y, w: Math.max(1, Math.abs(dx) * 2), h: Math.max(1, Math.abs(dy) * 2) };
  return { x: a.x + dx / 2, y: a.y + dy / 2, w: Math.max(1, Math.abs(dx)), h: Math.max(1, Math.abs(dy)) };
}

function shapeTool(kit, spec) {
  let drag = null;

  const def = {
    id: spec.id,
    label: spec.label,
    icon: spec.icon,
    key: spec.key,
    cursor: "crosshair",

    activate(api) {
      api.setCursor("crosshair");
    },

    deactivate(api) {
      if (drag) cancel(api);
      kit.clearOverlay(api);
    },

    pointerDown(e, api) {
      if (e.button !== 0) return;
      if (drag) finish(api);
      drag = { cx: e.clientX, cy: e.clientY, start: kit.snap(api, api.toDoc(e), e), id: null, last: null, keys: null };
      kit.store.begin(spec.undo);
      watchKeys(api);
    },

    pointerMove(e, api) {
      if (!drag || !(e.buttons & 1)) return;
      if (!drag.id && !kit.moved(drag, e)) return;
      drag.last = { raw: api.toDoc(e), client: { x: e.clientX, y: e.clientY }, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey };
      update(api);
    },

    pointerUp(e, api) {
      if (!drag) return;
      // The OS or a second finger (pinch) took the pointer: not a click.
      if (e?.type === "pointercancel") {
        cancel(api);
        return;
      }
      if (drag.id && drag.last) {
        drag.last = { raw: api.toDoc(e), client: { x: e.clientX, y: e.clientY }, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey };
        update(api);
      }
      finish(api);
    },

    cancel(api) {
      if (drag) cancel(api);
    },

    keyDown(e, api) {
      if (e.key === "Escape") {
        if (drag) cancel(api);
        else api.editor.setTool("select");
        return true;
      }
      return false;
    },

    drawOverlay(api) {
      if (drag?.id) pill(api);
    },
  };

  // Shift and Alt change the box without moving the pointer.
  function watchKeys(api) {
    drag.keys = kit.watchModifiers((ev) => {
      if (!drag?.last) return;
      drag.last = { ...drag.last, shift: ev.shiftKey, alt: ev.altKey };
      update(api);
    });
  }

  function update(api) {
    const l = drag.last;
    const b = kit.snap(api, l.raw, { ctrlKey: l.ctrl }, [drag.id]);
    const box = dragBox(drag.start, b, { square: l.shift, center: l.alt });
    const store = kit.store;
    if (!drag.id) {
      const layer = createLayer("shape", { shape: spec.shape, name: spec.name, ...spec.props(kit.style(spec.id)), ...box });
      [drag.id] = store.add([layer], { label: spec.undo });
    } else {
      store.patch(drag.id, box, { transient: true });
    }
    pill(api);
  }

  function pill(api) {
    kit.clearOverlay(api);
    const layer = drag?.id ? kit.store.get(drag.id) : null;
    if (!layer || !drag.last || !api.overlay) return;
    const m = kit.overlayMap(api);
    const c = m.client(drag.last.client);
    kit.pill(api.overlay, `${Math.round(layer.w)} × ${Math.round(layer.h)}`, c.x, c.y + 18);
  }

  function finish(api) {
    const d = drag;
    drag = null;
    d.keys?.();
    kit.clearOverlay(api);
    api.clearGuides?.();
    const store = kit.store;
    const k = kit.docScale();
    const [w, h] = spec.size.map((v) => Math.round(v * k));
    let created = d.id;
    // A drag smaller than a few screen px was a click that slipped: make the
    // default size, not a speck.
    let clicked = !created;
    if (created) {
      const l = store.get(created);
      const z = Number(api.zoom) || 1;
      if (l && l.w * z < MIN_SCREEN && l.h * z < MIN_SCREEN) {
        store.patch(created, { x: d.start.x, y: d.start.y, w, h }, { transient: true });
        clicked = true;
      }
    } else {
      const layer = createLayer("shape", { shape: spec.shape, name: spec.name, ...spec.props(kit.style(spec.id)), x: d.start.x, y: d.start.y, w, h });
      [created] = store.add([layer], { label: spec.undo });
    }
    store.commit();
    if (created && clicked) api.editor.flash?.([created]);
    kit.done(api, def);
  }

  function cancel(api) {
    const d = drag;
    drag = null;
    d.keys?.();
    kit.clearOverlay(api);
    api.clearGuides?.();
    kit.store.cancel();
  }

  return def;
}

export function shapeTools(kit) {
  return SPECS.map((spec) => shapeTool(kit, spec));
}
