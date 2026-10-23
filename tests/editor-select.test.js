// Tests for web/js/editor/tools/select.js with a small fake editor core
// (doc space = client space, frames run at once).
//   deno test --allow-read tests/editor-select.test.js

import assert from "node:assert/strict";
import { Store } from "../web/js/core/store.js";
import { createDoc, createLayer } from "../web/js/core/model.js";
import { pickLayer } from "../web/js/core/geometry.js";
import { installTextNormalizer } from "../web/js/core/textlayout.js";
import { createSelectTool } from "../web/js/editor/tools/select.js";

function setup(layers, { handle = null, inside = false } = {}) {
  const store = new Store(createDoc());
  installTextNormalizer(store);
  const ids = store.add(layers, { select: false });
  const log = { pans: [], status: [], interaction: [] };
  const core = {
    ctx: { commands: { get: () => null } },
    store,
    viewport: { zoom: 1 },
    state: { guides: [], spacing: [], marquee: null, gesture: null },
    lastPointer: null,
    clientToDoc: (e) => ({ x: e.clientX, y: e.clientY }),
    toLocal: (e) => ({ x: e.clientX, y: e.clientY }),
    overlay: {
      // A handle when the press is within 6 px of it.
      hitHandle: (p) => (handle && Math.hypot(p.x - handle.x, p.y - handle.y) <= 6 ? { cursor: "ew-resize", ...handle } : null),
      selectionContains: () => inside,
    },
    pick: (p) => pickLayer(store.doc, p, { tol: 4 }),
    targets: () => ({ xs: [], ys: [], boxes: [] }),
    snapOn: () => false,
    schedule: (fn) => fn(),
    requestRender() {},
    setHover() {},
    setHoverCursor() {},
    setGestureCursor() {},
    interaction: (on, kind) => log.interaction.push(on ? kind : null),
    flashStatus: (t) => log.status.push(t),
    startPan: (e, opts) => log.pans.push(opts),
  };
  const tool = createSelectTool(core);
  const ev = (type, x, y, extra = {}) => ({ type, clientX: x, clientY: y, pointerType: "mouse", ...extra });
  return { store, ids, tool, log, ev };
}

Deno.test("select: a click on a text side handle changes nothing and records nothing", () => {
  const text = createLayer("text", { text: "WOW", x: 400, y: 300, size: 96 });
  // The fake overlay reports the e handle on the right edge of the measured box.
  const probe = setup([text]);
  const m = probe.store.get(probe.ids[0]);
  const e = { x: m.x + m.w / 2, y: m.y };
  const s = setup([text], { handle: { kind: "resize", handle: "e", ...e } });
  s.store.select([s.ids[0]]);
  const before = structuredClone(s.store.get(s.ids[0]));
  assert.notEqual(before.wrap, "fixed");
  const undo0 = s.store.historyLabels().undo;
  s.tool.pointerDown(s.ev("pointerdown", e.x, e.y));
  s.tool.pointerMove(s.ev("pointermove", e.x + 1, e.y)); // jitter under DRAG_PX
  s.tool.pointerUp(s.ev("pointerup", e.x + 1, e.y));
  assert.deepEqual(s.store.get(s.ids[0]), before);
  assert.equal(s.store.inGesture, false);
  assert.equal(s.store.historyLabels().undo, undo0);
});

Deno.test("select: dragging a handle past the threshold resizes as one step", () => {
  const shape = createLayer("shape", { x: 400, y: 300, w: 200, h: 100 });
  const s = setup([shape], { handle: { kind: "resize", handle: "e", x: 500, y: 300 } });
  s.store.select([s.ids[0]]);
  s.tool.pointerDown(s.ev("pointerdown", 500, 300));
  s.tool.pointerMove(s.ev("pointermove", 502, 300));
  assert.equal(s.store.get(s.ids[0]).w, 200, "nothing moves under the threshold");
  s.tool.pointerMove(s.ev("pointermove", 540, 300));
  s.tool.pointerUp(s.ev("pointerup", 550, 300));
  assert.equal(s.store.get(s.ids[0]).w, 250);
  assert.equal(s.store.historyLabels().undo, "Resize");
  assert.equal(s.store.inGesture, false);
});

Deno.test("select: finish() commits a drag in progress and ignores a press that has not moved", () => {
  const shape = createLayer("shape", { x: 400, y: 300, w: 200, h: 100 });
  const s = setup([shape]);
  s.store.select([s.ids[0]]);
  s.tool.pointerDown(s.ev("pointerdown", 400, 300));
  assert.equal(s.tool.busy, true);
  s.tool.finish();
  assert.equal(s.tool.busy, false);
  assert.equal(s.store.inGesture, false);
  assert.equal(s.store.get(s.ids[0]).x, 400);

  s.tool.pointerDown(s.ev("pointerdown", 400, 300));
  s.tool.pointerMove(s.ev("pointermove", 440, 300));
  assert.equal(s.store.inGesture, true);
  s.tool.finish();
  assert.equal(s.store.inGesture, false);
  assert.equal(s.store.get(s.ids[0]).x, 440);
  assert.equal(s.store.historyLabels().undo, "Move");
  assert.ok(s.log.interaction.at(-1) === null, "the interaction ends");
  // The release that follows is not the tool's any more.
  s.tool.pointerMove(s.ev("pointermove", 600, 300, { buttons: 0 }));
  assert.equal(s.store.get(s.ids[0]).x, 440);
});

Deno.test("select: a touch press on empty canvas pans and may clear on a tap", () => {
  const shape = createLayer("shape", { x: 100, y: 100, w: 50, h: 50 });
  const s = setup([shape]);
  s.tool.pointerDown(s.ev("pointerdown", 600, 400, { pointerType: "touch" }));
  s.tool.pointerDown(s.ev("pointerdown", 600, 400, { pointerType: "touch", shiftKey: true }));
  assert.deepEqual(s.log.pans, [{ tapClear: true }, { tapClear: false }]);
});

Deno.test("select: dragging a hidden selection says it is hidden, not locked", () => {
  const shape = createLayer("shape", { x: 400, y: 300, w: 200, h: 100, hidden: true });
  const s = setup([shape], { inside: true });
  s.store.select([s.ids[0]]);
  s.tool.pointerDown(s.ev("pointerdown", 400, 300));
  s.tool.pointerMove(s.ev("pointermove", 450, 300));
  assert.match(s.log.status.at(-1), /hidden/i);
  assert.equal(s.store.inGesture, false);
});
