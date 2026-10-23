// Select tool (V): click to select (Shift or Ctrl adds and removes), drag to
// move with snapping (Shift locks the axis, Alt drags a copy), drag empty
// space for a marquee, and drag handles to resize, rotate, scale a group or
// shape an arrow. Locked layers can not be moved from the canvas; clicks on
// them reach the layer below. Pointer moves are applied once per frame.

import { aabb, unionBox, layersInRect, arrowPoints } from "../../core/geometry.js";
import { resizeLayer, scaleGroup, rotateFrom, moveArrowEnd, bendArrow, constrainAngle } from "../transform.js";
import { SNAP_PX, best, snapMove, snapPoint, alignGuides, spacingGuides, pointGuides, visualBox, offsetBox, boxOf } from "../snapping.js";

const DRAG_PX = { mouse: 3, pen: 4, touch: 8 };
const round2 = (v) => Math.round(v * 100) / 100;
const LOCKED = "This layer is locked. Unlock it to move it.";
const HIDDEN = "This layer is hidden. Show it to move it.";
const DRAGS = ["move", "resize", "scale", "rotate", "arrow", "bend"];

function info(e) {
  return {
    clientX: e.clientX,
    clientY: e.clientY,
    shiftKey: !!e.shiftKey,
    altKey: !!e.altKey,
    ctrlKey: !!e.ctrlKey,
    metaKey: !!e.metaKey,
    pointerType: e.pointerType || "mouse",
  };
}

export function createSelectTool(core) {
  const { ctx, store } = core;
  let g = null; // the current press: pending or active gesture
  let last = null; // latest pointer info for the active gesture

  const zoom = () => core.viewport.zoom;
  const thr = () => SNAP_PX / zoom();

  function clearFeedback() {
    core.state.guides = [];
    core.state.spacing = [];
    core.state.marquee = null;
    core.state.gesture = null;
  }

  function setGesture(kind, pill = null, pillAt = null) {
    core.state.gesture = { kind, pill, pillAt };
  }

  // ---- press -----------------------------------------------------------------

  function pointerDown(e) {
    const p = core.clientToDoc(e);
    const local = core.toLocal(e);
    const hd = core.overlay.hitHandle(local, e.pointerType);
    if (hd) {
      startHandle(hd, e, p);
      return;
    }
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const hit = core.pick(p);
    const sel = store.selection;
    if (hit) {
      if (additive) {
        store.select([hit.id], { toggle: true });
        g = store.selection.includes(hit.id) ? { kind: "pending-move", start: info(e), startDoc: p, collapseTo: null } : { kind: "none" };
      } else if (sel.includes(hit.id)) {
        g = { kind: "pending-move", start: info(e), startDoc: p, collapseTo: sel.length > 1 ? hit.id : null };
      } else {
        store.select([hit.id]);
        g = { kind: "pending-move", start: info(e), startDoc: p, collapseTo: null };
      }
      return;
    }
    if (!additive && core.overlay.selectionContains(local)) {
      g = { kind: "pending-move", start: info(e), startDoc: p, collapseTo: null };
      return;
    }
    if (e.pointerType === "touch") {
      g = { kind: "none" };
      core.startPan(e, { tapClear: !additive });
      return;
    }
    g = { kind: "pending-marquee", start: info(e), startLocal: local, startDoc: p, additive, base: additive ? [...sel] : [] };
  }

  function startHandle(hd, e, p) {
    const sel = store.selected();
    last = info(e);
    if (hd.kind === "rotate") {
      const l = sel[0];
      store.begin("Rotate");
      g = { kind: "rotate", layer0: l, center: { x: l.x, y: l.y }, startDoc: p };
      setGesture("rotate", `${Math.round(l.rotation)}°`, "pointer");
    } else if (hd.kind === "arrow" || hd.kind === "bend") {
      const l = sel[0];
      const pts = arrowPoints(l);
      const at = hd.kind === "bend" ? pts.mid : hd.handle === "a" ? pts.a : pts.b;
      store.begin(hd.kind === "bend" ? "Bend arrow" : "Edit arrow");
      g = { kind: hd.kind, which: hd.handle, layer0: l, off: { x: at.x - p.x, y: at.y - p.y }, T: core.targets([l.id]) };
      setGesture(hd.kind);
    } else if (hd.kind === "scale") {
      const layers0 = sel.filter((l) => !l.locked);
      const b = unionBox(sel.map(aabb));
      store.begin("Resize");
      g = { kind: "scale", handle: hd.handle, layers0, box0: b, startDoc: p, T: core.targets(layers0.map((l) => l.id)) };
      setGesture("scale", "100%");
    } else {
      const l = sel[0];
      store.begin("Resize");
      g = { kind: "resize", handle: hd.handle, layer0: l, startDoc: p, T: core.targets([l.id]) };
      setGesture("resize", sizeLabel(l));
    }
    // Nothing changes until the pointer travels DRAG_PX: a click on a handle
    // (or the first click of a double-click) is not a resize.
    g.start = info(e);
    g.moved = false;
    core.setGestureCursor(hd.cursor);
    core.interaction(true, g.kind);
    core.requestRender();
  }

  function sizeLabel(l) {
    return `${Math.round(l.w)} × ${Math.round(l.h)}`;
  }

  // ---- moves -----------------------------------------------------------------

  function beginMove(ev) {
    const sel = store.selected();
    let ids = sel.filter((l) => !l.locked && !l.hidden).map((l) => l.id);
    if (!ids.length) {
      core.flashStatus(sel.some((l) => l.locked) ? LOCKED : HIDDEN);
      g = { kind: "none" };
      return;
    }
    const dup = ev.altKey;
    store.begin(dup ? "Duplicate" : "Move");
    if (dup) ids = store.duplicate(ids, { offset: 0, label: "Duplicate" });
    const layers0 = ids.map((id) => store.get(id)).filter(Boolean);
    g = {
      kind: "move",
      ids,
      starts: new Map(layers0.map((l) => [l.id, { x: l.x, y: l.y }])),
      startDoc: g.startDoc,
      box0: unionBox(layers0.map(visualBox)),
      T: core.targets(ids),
    };
    setGesture("move");
    core.setHover(null);
    core.setGestureCursor(dup ? "copy" : "move");
    core.interaction(true, "move");
  }

  function applyMove(ev) {
    const p = core.clientToDoc(ev);
    let dx = p.x - g.startDoc.x;
    let dy = p.y - g.startDoc.y;
    let lockX = false;
    let lockY = false;
    if (ev.shiftKey) {
      if (Math.abs(dx) >= Math.abs(dy)) {
        dy = 0;
        lockY = true;
      } else {
        dx = 0;
        lockX = true;
      }
    }
    let guides = [];
    let spacing = [];
    if (core.snapOn(ev) && g.box0) {
      const s = snapMove(offsetBox(g.box0, dx, dy), g.T, thr(), { lockX, lockY });
      dx += s.dx;
      dy += s.dy;
      const fin = offsetBox(g.box0, dx, dy);
      guides = alignGuides(fin, g.T);
      spacing = spacingGuides(fin, g.T.boxes);
    }
    dx = round2(dx);
    dy = round2(dy);
    core.state.guides = guides;
    core.state.spacing = spacing;
    store.patch(g.ids, (l) => {
      const s = g.starts.get(l.id);
      return s ? { x: s.x + dx, y: s.y + dy } : null;
    });
  }

  // Box-frame snap functions for an unrotated layer (or a group box).
  function edgeSnaps(ev, cx, cy, T, rotated) {
    if (rotated || !core.snapOn(ev)) return { snapX: null, snapY: null };
    const t = thr();
    return {
      snapX: (vals) => best(vals.map((v) => cx + v), T.xs, t),
      snapY: (vals) => best(vals.map((v) => cy + v), T.ys, t),
    };
  }

  function applyResize(ev) {
    const p = core.clientToDoc(ev);
    const l0 = g.layer0;
    const rotated = Math.abs(l0.rotation || 0) > 0.01;
    const snaps = edgeSnaps(ev, l0.x, l0.y, g.T, rotated);
    const props = resizeLayer(l0, g.handle, g.startDoc, p, {
      shift: ev.shiftKey,
      alt: ev.altKey,
      minSize: Math.max(1, 4 / zoom()),
      ...snaps,
    });
    store.patch(l0.id, props);
    const live = store.get(l0.id) || { ...l0, ...props };
    core.state.guides = snaps.snapX ? alignGuides(boxOf(...edges(live)), g.T) : [];
    core.state.spacing = [];
    const corner = g.handle.length === 2;
    setGesture("resize", live.type === "text" && corner ? `${Math.round(live.size)} px` : sizeLabel(live));
  }

  function edges(l) {
    const a = aabb(l);
    return [a.l, a.t, a.r, a.b];
  }

  function applyScale(ev) {
    const p = core.clientToDoc(ev);
    const b = g.box0;
    const cx = (b.l + b.r) / 2;
    const cy = (b.t + b.b) / 2;
    const snaps = edgeSnaps(ev, cx, cy, g.T, false);
    const res = scaleGroup(g.layers0, b, g.handle, g.startDoc, p, { alt: ev.altKey, minSize: Math.max(1, 4 / zoom()), ...snaps });
    store.patch(
      g.layers0.map((l) => l.id),
      (l) => res.props.get(l.id),
    );
    core.state.guides = snaps.snapX ? alignGuides(boxOf(res.box.l, res.box.t, res.box.r, res.box.b), g.T) : [];
    setGesture("scale", `${Math.round(res.scale * 100)}%`);
  }

  function applyRotate(ev) {
    const p = core.clientToDoc(ev);
    const deg = rotateFrom(g.center, g.startDoc, p, g.layer0.rotation || 0, { shift: ev.shiftKey });
    store.patch(g.layer0.id, { rotation: deg });
    setGesture("rotate", `${Math.round(deg)}°`, "pointer");
  }

  function applyArrow(ev) {
    const p = core.clientToDoc(ev);
    let target = { x: p.x + g.off.x, y: p.y + g.off.y };
    const l0 = g.layer0;
    let guides = [];
    if (g.kind === "bend") {
      store.patch(l0.id, bendArrow(l0, target, { straightTol: 8 / zoom() }));
    } else {
      const pts = arrowPoints(l0);
      const fixed = g.which === "a" ? pts.b : pts.a;
      if (ev.shiftKey) {
        target = constrainAngle(fixed, target, 15);
      } else if (core.snapOn(ev)) {
        const s = snapPoint(target, g.T, thr());
        target = { x: s.x, y: s.y };
        if (s.sx || s.sy) guides = pointGuides(target, g.T);
      }
      store.patch(l0.id, moveArrowEnd(l0, g.which, target));
    }
    core.state.guides = guides;
  }

  function applyMarquee(ev) {
    const local = core.toLocal(ev);
    const s = g.startLocal;
    core.state.marquee = { x0: s.x, y0: s.y, x1: local.x, y1: local.y };
    const a = g.startDoc;
    const b = core.clientToDoc(ev);
    const rect = { l: Math.min(a.x, b.x), t: Math.min(a.y, b.y), r: Math.max(a.x, b.x), b: Math.max(a.y, b.y) };
    const inside = layersInRect(store.doc, rect).map((l) => l.id);
    store.select(g.additive ? [...new Set([...g.base, ...inside])] : inside);
  }

  function apply(ev) {
    if (!g) return;
    switch (g.kind) {
      case "move":
        return applyMove(ev);
      case "resize":
        return applyResize(ev);
      case "scale":
        return applyScale(ev);
      case "rotate":
        return applyRotate(ev);
      case "arrow":
      case "bend":
        return applyArrow(ev);
      case "marquee":
        return applyMarquee(ev);
    }
  }

  // Runs at the start of each frame with the newest pointer position.
  function flush() {
    if (!last || !g) return;
    const ev = last;
    last = null;
    apply(ev);
  }

  function pointerMove(e) {
    if (!g) {
      hover(e);
      return;
    }
    const ev = info(e);
    const far = () => Math.hypot(ev.clientX - g.start.clientX, ev.clientY - g.start.clientY) >= (DRAG_PX[ev.pointerType] || 3);
    if (g.moved === false) {
      if (!far()) return;
      g.moved = true;
    }
    if (g.kind === "pending-move" || g.kind === "pending-marquee") {
      if (!far()) return;
      if (g.kind === "pending-move") beginMove(ev);
      else {
        g = { ...g, kind: "marquee" };
        setGesture("marquee");
        core.setHover(null);
        core.interaction(true, "marquee");
      }
    }
    if (g.kind === "none") return;
    last = ev;
    core.schedule(flush);
  }

  function pointerUp(e) {
    if (!g) return;
    const cur = g;
    if (cur.kind === "pending-move") {
      if (cur.collapseTo && !(e.shiftKey || e.ctrlKey || e.metaKey)) store.select([cur.collapseTo]);
    } else if (cur.kind === "pending-marquee") {
      if (!cur.additive) store.clearSelection();
    } else if (cur.kind !== "none") {
      settle(info(e), e.type === "pointercancel");
    }
    g = null;
    last = null;
    clearFeedback();
    core.setGestureCursor(null);
    core.interaction(false);
    hover(e);
    core.requestRender();
  }

  // Close the active drag: apply the newest pointer (ev, if any) and commit
  // it as one undo step, or cancel. A handle that never moved was a click:
  // its gesture is dropped and nothing is recorded.
  function settle(ev, cancelled) {
    const cur = g;
    const still = cur.moved === false;
    if (ev && !cancelled && !still) apply(ev);
    last = null;
    if (cur.kind === "marquee") return;
    if (cancelled || still) store.cancel();
    else store.commit();
  }

  // End the press now, as if released where the pointer last was (a crop or
  // a text edit is starting): a drag keeps what it did; a press that has not
  // moved yet does nothing.
  function finish() {
    if (!g) return false;
    if (DRAGS.includes(g.kind) || g.kind === "marquee") settle(last, false);
    reset();
    core.requestRender();
    return true;
  }

  // Abandon the press without touching history (the store moved on).
  function reset() {
    g = null;
    last = null;
    clearFeedback();
    core.setGestureCursor(null);
    core.interaction(false);
  }

  function cancel() {
    if (!g) return false;
    const cur = g;
    if (DRAGS.includes(cur.kind)) store.cancel();
    if (cur.kind === "marquee") store.select(cur.base);
    reset();
    core.requestRender();
    return true;
  }

  function hover(e) {
    if (!e || e.clientX === undefined) return;
    const local = core.toLocal(e);
    const hd = core.overlay.hitHandle(local, e.pointerType);
    if (hd) {
      core.setHover(null);
      core.setHoverCursor(hd.cursor);
      return;
    }
    const hit = core.pick(core.clientToDoc(e));
    core.setHover(hit && !store.selection.includes(hit.id) ? hit.id : null);
    const overSel = (hit && store.selection.includes(hit.id)) || (!hit && core.overlay.selectionContains(local));
    core.setHoverCursor(overSel && store.selected().some((l) => !l.locked && !l.hidden) ? "move" : null);
  }

  // Re-run the active gesture when Shift, Alt or Ctrl change mid-drag.
  function refresh(mods) {
    if (!g || !DRAGS.includes(g.kind) || g.moved === false) return;
    const base = last || core.lastPointer;
    if (!base) return;
    last = { ...base, ...mods };
    core.schedule(flush);
  }

  return {
    id: "select",
    label: "Select",
    icon: "pointer",
    key: "V",
    cursor: "default",
    activate() {},
    deactivate() {
      cancel();
      core.setHover(null);
      core.setHoverCursor(null);
    },
    pointerDown,
    pointerMove,
    pointerUp,
    keyDown(e) {
      if (e.key === "Escape") {
        if (cancel()) return true;
        if (!ctx.commands.get("edit.deselect") && store.selection.length) {
          store.clearSelection();
          return true;
        }
      }
      return false;
    },
    // Editor-internal extras (not part of the tool contract).
    refresh,
    reset,
    cancel,
    finish,
    get busy() {
      return !!g && g.kind !== "none";
    },
  };
}
