// Arrow tool (A). Drag from tail to tip; Shift snaps the angle to 15 degree
// steps; both ends snap to the canvas and other layers. A click makes a
// default arrow pointing up and to the right, centered on the point.

import { createLayer } from "../../core/model.js";
import { refitArrow } from "../../core/geometry.js";

const DEG = 180 / Math.PI;
const DEFAULT_LENGTH = 260;
// A drag that ends shorter than this on screen counts as a click.
const MIN_SCREEN = 8;

// The arrow layer for doc-space endpoints a (tail) and b (tip).
export function arrowLayer(style, a, b, c = null, props = {}) {
  const base = createLayer("arrow", { color: style.color, width: style.width, head: "triangle", tail: "none", ...props });
  return { ...base, ...refitArrow({ ...base, x: 0, y: 0, rotation: 0, flipX: false, flipY: false }, { a, b, c }) };
}

// b moved so the a -> b direction lands on a multiple of `step` degrees.
export function snapDirection(a, b, step = 15) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const ang = Math.round((Math.atan2(b.y - a.y, b.x - a.x) * DEG) / step) * step;
  return { x: a.x + Math.cos(ang / DEG) * len, y: a.y + Math.sin(ang / DEG) * len };
}

export function arrowTool(kit) {
  let drag = null;

  const def = {
    id: "arrow",
    label: "Arrow",
    icon: "arrow-up-right",
    key: "A",
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
      drag = { cx: e.clientX, cy: e.clientY, a: kit.snap(api, api.toDoc(e), e), id: null, last: null };
      kit.store.begin("Add arrow");
      // Shift snaps or frees the angle without moving the pointer.
      drag.keys = kit.watchModifiers((ev) => {
        if (!drag?.last || ev.key !== "Shift") return;
        drag.last = { ...drag.last, shift: ev.shiftKey };
        update(api);
      });
    },

    pointerMove(e, api) {
      if (!drag || !(e.buttons & 1)) return;
      if (!drag.id && !kit.moved(drag, e)) return;
      drag.last = { raw: api.toDoc(e), client: { x: e.clientX, y: e.clientY }, shift: e.shiftKey, ctrl: e.ctrlKey };
      update(api);
    },

    pointerUp(e, api) {
      if (!drag) return;
      // The OS or a second finger (pinch) took the pointer: not a click.
      if (e?.type === "pointercancel") {
        cancel(api);
        return;
      }
      if (drag.id) {
        drag.last = { raw: api.toDoc(e), client: { x: e.clientX, y: e.clientY }, shift: e.shiftKey, ctrl: e.ctrlKey };
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

  function tipFor(api, l) {
    if (l.shift) {
      api.clearGuides?.();
      return snapDirection(drag.a, l.raw, 15);
    }
    return kit.snap(api, l.raw, { ctrlKey: l.ctrl }, [drag.id]);
  }

  function update(api) {
    const b = tipFor(api, drag.last);
    if (Math.hypot(b.x - drag.a.x, b.y - drag.a.y) < 1) return;
    const store = kit.store;
    const style = kit.style("arrow");
    if (!drag.id) {
      [drag.id] = store.add([arrowLayer(style, drag.a, b)], { label: "Add arrow" });
    } else {
      const layer = store.get(drag.id);
      if (!layer) return;
      store.patch(drag.id, refitArrow({ ...layer, x: 0, y: 0, rotation: 0, flipX: false, flipY: false }, { a: drag.a, b }), { transient: true });
    }
    drag.b = b;
    pill(api);
  }

  function pill(api) {
    kit.clearOverlay(api);
    if (!drag?.b || !drag.last || !api.overlay) return;
    const m = kit.overlayMap(api);
    const c = m.client(drag.last.client);
    let ang = Math.round(-Math.atan2(drag.b.y - drag.a.y, drag.b.x - drag.a.x) * DEG);
    if (ang <= -180) ang += 360;
    kit.pill(api.overlay, `${ang}°`, c.x, c.y + 18);
  }

  function finish(api) {
    const d = drag;
    drag = null;
    d.keys?.();
    kit.clearOverlay(api);
    api.clearGuides?.();
    const store = kit.store;
    const half = (DEFAULT_LENGTH * kit.docScale()) / 2;
    const u = { x: Math.SQRT1_2, y: -Math.SQRT1_2 };
    const a = { x: d.a.x - u.x * half, y: d.a.y - u.y * half };
    const b = { x: d.a.x + u.x * half, y: d.a.y + u.y * half };
    let created = d.id;
    let clicked = !created;
    if (created) {
      // A drag shorter than a few screen px was a click that slipped: make
      // the default arrow, not a blob.
      const layer = store.get(created);
      const z = Number(api.zoom) || 1;
      if (layer && d.b && Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y) * z < MIN_SCREEN) {
        store.patch(created, refitArrow({ ...layer, x: 0, y: 0, rotation: 0, flipX: false, flipY: false }, { a, b }), { transient: true });
        clicked = true;
      }
    } else {
      [created] = store.add([arrowLayer(kit.style("arrow"), a, b)], { label: "Add arrow" });
    }
    store.commit();
    if (created) store.select([created]);
    if (created && clicked) api.editor.flash?.([created]);
    kit.done(api, def);
  }

  function cancel(api) {
    drag?.keys?.();
    drag = null;
    kit.clearOverlay(api);
    api.clearGuides?.();
    kit.store.cancel();
  }

  return def;
}
