// Tests for web/js/core/store.js (and the text normalizer from textlayout.js)
//   deno test --allow-read tests/core-store.test.js

import assert from "node:assert/strict";
import { Store, mergeLayer } from "../web/js/core/store.js";
import { createDoc, createLayer } from "../web/js/core/model.js";
import { installTextNormalizer, measureBox } from "../web/js/core/textlayout.js";

function setup(n = 3) {
  const store = new Store(createDoc());
  const events = [];
  for (const type of ["change", "selection", "history"]) store.addEventListener(type, (e) => events.push({ type, ...e.detail }));
  let t = 1000;
  store.now = () => t;
  const ids = store.add(Array.from({ length: n }, (_, i) => createLayer("shape", { name: `S${i}`, x: 100 * (i + 1) })), { select: false });
  events.length = 0;
  return { store, ids, events, tick: (ms) => (t += ms) };
}

const order = (store) => store.layers().map((l) => l.name);

Deno.test("add: inserts on top, selects, records one undo step", () => {
  const store = new Store();
  const ids = store.add(createLayer("text"));
  assert.equal(ids.length, 1);
  assert.deepEqual(store.selection, ids);
  assert.equal(store.layers().length, 1);
  assert.equal(store.canUndo, true);
  assert.equal(store.historyLabels().undo, "Add text");
  store.undo();
  assert.equal(store.layers().length, 0);
  assert.deepEqual(store.selection, []);
  store.redo();
  assert.equal(store.layers().length, 1);
  assert.deepEqual(store.selection, ids);
});

Deno.test("add: index, no select, duplicate ids replaced, junk ignored", () => {
  const { store, ids } = setup(2);
  const [a] = store.add([{ type: "shape", id: ids[0], name: "New" }, { type: "nope" }], { index: 0, select: false });
  assert.notEqual(a, ids[0]);
  assert.equal(store.layers()[0].name, "New");
  assert.deepEqual(store.selection, []);
  assert.deepEqual(store.add([]), []);
});

Deno.test("patch: shallow merge, nested one level, new objects only for changed layers", () => {
  const { store, ids } = setup(2);
  const before = store.layers();
  const untouched = before[1];
  store.patch(ids[0], { x: 5, stroke: { on: true }, shadow: { blur: 40 } });
  const l = store.get(ids[0]);
  assert.equal(l.x, 5);
  assert.deepEqual(l.stroke, { on: true, color: "#ffffff", width: 8, dash: false });
  assert.equal(l.shadow.blur, 40);
  assert.equal(l.shadow.dy, 10);
  assert.notEqual(l, before[0]);
  assert.equal(store.get(ids[1]), untouched);
  assert.notEqual(store.layers(), before);
  assert.equal(before[0].x, 100, "old layer object not mutated");
});

Deno.test("patch: function form, rotation normalized, id/type/unknown keys ignored", () => {
  const { store, ids } = setup(2);
  store.patch(ids, (l) => ({ x: l.x + 1, rotation: 270, id: "hijack", type: "text", bogus: 1 }));
  for (const id of ids) {
    const l = store.get(id);
    assert.equal(l.rotation, -90);
    assert.equal(l.type, "shape");
    assert.equal("bogus" in l, false);
  }
  assert.equal(store.get(ids[0]).x, 101);
});

Deno.test("patch: no-op patches do not touch history or emit", () => {
  const { store, ids, events } = setup(1);
  const depth = store._undo.length;
  assert.equal(store.patch(ids[0], { x: 100 }), false);
  assert.equal(store.patch(ids[0], { stroke: { on: false } }), false);
  assert.equal(store._undo.length, depth);
  assert.equal(events.length, 0);
});

Deno.test("mutators are safe with ids that do not exist", () => {
  const { store, events } = setup(2);
  const doc = store.doc;
  assert.equal(store.patch("nope", { x: 1 }), false);
  assert.equal(store.patch([], { x: 1 }), false);
  assert.equal(store.remove(["nope"]), false);
  assert.equal(store.move("nope", 0), false);
  assert.equal(store.forward(["nope"]), false);
  assert.equal(store.backward("nope"), false);
  assert.equal(store.toFront(null), false);
  assert.equal(store.toBack(undefined), false);
  assert.deepEqual(store.duplicate(["nope"]), []);
  assert.equal(store.select(["nope"]), false);
  assert.equal(store.get("nope"), undefined);
  assert.equal(store.index("nope"), -1);
  assert.equal(store.doc, doc);
  assert.equal(events.length, 0);
});

Deno.test("remove: prunes the selection and undo restores both", () => {
  const { store, ids } = setup(3);
  store.select([ids[0], ids[2]]);
  store.remove(ids[0]);
  assert.deepEqual(store.selection, [ids[2]]);
  assert.equal(store.layers().length, 2);
  store.undo();
  assert.equal(store.layers().length, 3);
  assert.deepEqual(store.selection, [ids[0], ids[2]]);
});

Deno.test("order: move, forward, backward, toFront, toBack", () => {
  const { store, ids } = setup(4);
  assert.deepEqual(order(store), ["S0", "S1", "S2", "S3"]);
  store.forward([ids[0], ids[1]]);
  assert.deepEqual(order(store), ["S2", "S0", "S1", "S3"]);
  store.backward([ids[1]]);
  assert.deepEqual(order(store), ["S2", "S1", "S0", "S3"]);
  store.toFront([ids[2], ids[0]]);
  assert.deepEqual(order(store), ["S1", "S3", "S2", "S0"], "front keeps their relative order");
  store.toBack([ids[3]]);
  assert.deepEqual(order(store), ["S3", "S1", "S2", "S0"]);
  store.move(ids[3], 99);
  assert.deepEqual(order(store), ["S1", "S2", "S0", "S3"]);
  assert.equal(store.forward([ids[3]]), false, "already on top");
  assert.equal(store.toBack([ids[1]]), false, "already at the bottom");
  store.undo();
  assert.deepEqual(order(store), ["S3", "S1", "S2", "S0"]);
});

Deno.test("duplicate: offset copies above their sources, selected", () => {
  const { store, ids } = setup(2);
  const copies = store.duplicate(ids, { offset: 10 });
  assert.equal(copies.length, 2);
  assert.deepEqual(order(store), ["S0", "S0", "S1", "S1"]);
  assert.deepEqual(store.selection, copies);
  assert.equal(store.get(copies[0]).x, 110);
  assert.equal(store.get(copies[0]).y, 370);
  store.undo();
  assert.equal(store.layers().length, 2);
});

Deno.test("selection: replace, additive, toggle, all, clear and events", () => {
  const { store, ids, events } = setup(3);
  store.patch(ids[2], { locked: true }, { transient: true });
  events.length = 0;
  store.select(ids[1]);
  store.select([ids[0], ids[1]], { additive: true });
  assert.deepEqual(store.selection, [ids[1], ids[0]]);
  store.select(ids[1], { toggle: true });
  assert.deepEqual(store.selection, [ids[0]]);
  assert.deepEqual(store.selected().map((l) => l.id), [ids[0]]);
  store.selectAll();
  assert.deepEqual(store.selection, [ids[0], ids[1]], "locked layers are skipped");
  assert.equal(store.select([ids[0], ids[1]]), false, "same selection, no event");
  store.clearSelection();
  assert.deepEqual(store.selection, []);
  assert.deepEqual(events.map((e) => e.type), ["selection", "selection", "selection", "selection", "selection"]);
  assert.equal(store.canUndo, true);
  assert.equal(store._undo.length, 1, "selection alone is not history");
});

Deno.test("events: change detail and order (change, selection, history)", () => {
  const { store, ids, events } = setup(1);
  store.patch(ids[0], { x: 1 }, { label: "Move" });
  assert.deepEqual(events.map((e) => e.type), ["change", "history"]);
  assert.deepEqual(events[0], { type: "change", reason: "patch", ids: [ids[0]], transient: false });
  assert.deepEqual(events[1], { type: "history", canUndo: true, canRedo: false });
  events.length = 0;
  const [id] = store.add(createLayer("text"));
  assert.deepEqual(events.map((e) => e.type), ["change", "selection", "history"]);
  assert.equal(events[0].reason, "add");
  assert.deepEqual(events[1].ids, [id]);
  events.length = 0;
  store.undo();
  assert.equal(events[0].reason, "undo");
  assert.equal(events[0].ids, null);
});

Deno.test("history: labels, redo cleared by a new change, cap of 200", () => {
  const { store, ids, tick } = setup(1);
  store.patch(ids[0], { x: 1 }, { label: "Move" });
  assert.deepEqual(store.historyLabels(), { undo: "Move", redo: null });
  store.undo();
  assert.deepEqual(store.historyLabels(), { undo: "Add shape", redo: "Move" });
  store.patch(ids[0], { y: 1 }, { label: "Nudge" });
  assert.equal(store.canRedo, false);
  for (let i = 0; i < 250; i++) {
    tick(1000);
    store.patch(ids[0], { x: i + 10 });
  }
  assert.equal(store._undo.length, 200);
  let n = 0;
  while (store.undo()) n++;
  assert.equal(n, 200);
  assert.equal(store.canUndo, false);
});

Deno.test("history: undo restores the selection captured with the change", () => {
  const { store, ids } = setup(2);
  store.select(ids[0]);
  store.patch(ids[0], { x: 9 });
  store.select(ids[1]);
  store.undo();
  assert.deepEqual(store.selection, [ids[0]]);
  store.select([]);
  store.redo();
  assert.deepEqual(store.selection, [ids[1]], "redo restores the selection from when undo ran");
});

Deno.test("coalesce: same key within 900 ms makes one entry", () => {
  const { store, ids, tick } = setup(1);
  const depth = store._undo.length;
  for (let i = 0; i < 5; i++) {
    tick(300);
    store.patch(ids[0], { opacity: 0.9 - i * 0.1 }, { coalesce: "opacity", label: "Opacity" });
  }
  assert.equal(store._undo.length, depth + 1);
  tick(1000);
  store.patch(ids[0], { opacity: 0.2 }, { coalesce: "opacity" });
  assert.equal(store._undo.length, depth + 2, "a pause starts a new entry");
  tick(100);
  store.patch(ids[0], { x: 3 }, { coalesce: "x" });
  tick(100);
  store.patch(ids[0], { opacity: 0.1 }, { coalesce: "opacity" });
  assert.equal(store._undo.length, depth + 4, "another key in between breaks the run");
  store.undo();
  store.undo();
  store.undo();
  assert.equal(store.get(ids[0]).opacity, 0.5);
  store.undo();
  assert.equal(store.get(ids[0]).opacity, 1);
});

Deno.test("coalesce: undo ends the run", () => {
  const { store, ids, tick } = setup(1);
  store.patch(ids[0], { x: 1 }, { coalesce: "nudge" });
  store.undo();
  tick(100);
  store.patch(ids[0], { x: 2 }, { coalesce: "nudge" });
  store.undo();
  assert.equal(store.get(ids[0]).x, 100);
});

Deno.test("transient: applied and emitted but not recorded", () => {
  const { store, ids, events } = setup(1);
  const depth = store._undo.length;
  store.patch(ids[0], { font: "x", x: 50 }, { transient: true });
  assert.equal(store.get(ids[0]).x, 50);
  assert.equal(store._undo.length, depth);
  assert.equal(events[0].transient, true);
  assert.equal(events.some((e) => e.type === "history"), false);
});

Deno.test("gesture: transient changes inside, one entry on commit", () => {
  const { store, ids, events } = setup(2);
  const depth = store._undo.length;
  store.begin("Move");
  assert.equal(store.inGesture, true);
  for (let i = 1; i <= 10; i++) store.patch(ids, (l) => ({ x: l.x + 1 }));
  assert.ok(events.every((e) => e.type !== "change" || e.transient));
  assert.equal(store._undo.length, depth);
  assert.equal(store.historyLabels().undo, "Move");
  events.length = 0;
  assert.equal(store.commit(), true);
  assert.equal(store.inGesture, false);
  assert.equal(store._undo.length, depth + 1);
  assert.deepEqual(events.map((e) => e.type), ["change", "history"]);
  assert.equal(events[0].transient, false);
  assert.deepEqual(events[0].ids.sort(), [...ids].sort());
  store.undo();
  assert.equal(store.get(ids[0]).x, 100);
  assert.equal(store.get(ids[1]).x, 200);
  store.redo();
  assert.equal(store.get(ids[0]).x, 110);
});

Deno.test("gesture: commit with no net change records nothing", () => {
  const { store, ids } = setup(1);
  const depth = store._undo.length;
  store.begin("Preview font");
  store.patch(ids[0], { x: 5 });
  store.patch(ids[0], { x: 100 });
  assert.equal(store.commit(), false);
  assert.equal(store._undo.length, depth);
  store.begin("Nothing");
  assert.equal(store.commit(), false);
  assert.equal(store.commit(), false, "commit without begin is a no-op");
});

Deno.test("gesture: cancel restores the snapshot and selection", () => {
  const { store, ids } = setup(2);
  store.select(ids[0]);
  store.begin("Drag");
  store.patch(ids[0], { x: 999 });
  store.remove(ids[1]);
  store.select([]);
  assert.equal(store.cancel(), true);
  assert.equal(store.layers().length, 2);
  assert.equal(store.get(ids[0]).x, 100);
  assert.deepEqual(store.selection, [ids[0]]);
  assert.equal(store.inGesture, false);
  assert.equal(store.cancel(), false);
});

Deno.test("gesture: nested gestures make one entry with the outer label", () => {
  const { store, ids } = setup(1);
  const depth = store._undo.length;
  store.begin("Outer");
  store.patch(ids[0], { x: 1 });
  store.begin("Inner");
  store.patch(ids[0], { y: 1 });
  store.commit();
  assert.equal(store.inGesture, true);
  store.begin("Inner 2");
  store.patch(ids[0], { w: 50 });
  store.cancel();
  assert.equal(store.get(ids[0]).w, 360);
  store.commit();
  assert.equal(store._undo.length, depth + 1);
  assert.equal(store.historyLabels().undo, "Outer");
  store.undo();
  assert.equal(store.get(ids[0]).x, 100);
  assert.equal(store.get(ids[0]).y, 360);
});

Deno.test("gesture: undo during a gesture commits it first", () => {
  const { store, ids } = setup(1);
  store.begin("Drag");
  store.patch(ids[0], { x: 7 });
  store.undo();
  assert.equal(store.inGesture, false);
  assert.equal(store.get(ids[0]).x, 100);
  assert.equal(store.historyLabels().redo, "Drag");
});

Deno.test("update: mutator on a working copy; unchanged layers keep identity", () => {
  const { store, ids } = setup(3);
  const keep = store.get(ids[1]);
  store.update((doc) => {
    doc.layers[0].x = 1;
    doc.layers.pop();
    doc.name = "Renamed";
    doc.layers.push({ type: "text", text: "hi" });
  }, { label: "Batch" });
  assert.equal(store.get(ids[0]).x, 1);
  assert.equal(store.get(ids[1]), keep);
  assert.equal(store.get(ids[2]), undefined);
  assert.equal(store.doc.name, "Renamed");
  assert.equal(store.layers()[2].type, "text");
  assert.equal(store.layers()[2].font, "Anton", "added layers are normalized");
  assert.equal(store.update(() => {}), false);
  store.undo();
  assert.equal(store.layers().length, 3);
  assert.equal(store.doc.name, "Untitled thumbnail");
});

Deno.test("setDocProps and setDoc", () => {
  const { store, ids } = setup(1);
  store.setDocProps({ width: 3000, height: 3000, preset: "spotify-cover", background: { color: "#ff0000" } });
  assert.equal(store.doc.width, 3000);
  assert.deepEqual(store.doc.background, { kind: "color", color: "#ff0000" });
  store.setDocProps({ background: { kind: "gradient", from: "#000", to: "#fff", angle: 90 } });
  assert.equal(store.doc.background.kind, "gradient");
  assert.equal(store.setDocProps({ width: 3000 }), false);
  store.undo();
  store.undo();
  assert.equal(store.doc.width, 1280);

  store.select(ids);
  const next = createDoc({ name: "Other" });
  store.setDoc(next);
  assert.equal(store.doc.name, "Other");
  assert.deepEqual(store.selection, []);
  assert.equal(store.canUndo, false);
  store.setDoc(createDoc({ name: "Third" }), { history: "push" });
  assert.equal(store.canUndo, true);
  store.undo();
  assert.equal(store.doc.name, "Other");
});

Deno.test("normalizers run on changed layers with the previous layer", () => {
  const { store, ids } = setup(2);
  const seen = [];
  const off = store.addNormalizer((layer, doc, prev) => {
    seen.push([layer.id, prev?.x]);
    if (layer.type === "shape" && layer.w !== layer.h) return { h: layer.w };
  });
  store.patch(ids[0], { x: 5 });
  assert.deepEqual(seen, [[ids[0], 100]]);
  assert.equal(store.get(ids[0]).h, 360);
  assert.equal(store.get(ids[1]).h, 240, "untouched layers are not normalized");
  const [added] = store.add(createLayer("shape", { w: 50, h: 10 }));
  assert.equal(store.get(added).h, 50);
  assert.equal(seen.at(-1)[1], undefined, "new layers have no previous layer");
  seen.length = 0;
  assert.equal(store.remeasure(), true);
  assert.equal(store.get(ids[1]).h, 360);
  assert.equal(store.remeasure(), false, "nothing left to change");
  off();
  store.patch(ids[0], { w: 10 });
  assert.equal(store.get(ids[0]).h, 360);
});

Deno.test("normalizers: a throwing normalizer does not break the store", () => {
  const { store, ids } = setup(1);
  const err = console.error;
  console.error = () => {};
  try {
    store.addNormalizer(() => {
      throw Error("boom");
    });
    assert.equal(store.patch(ids[0], { x: 3 }), true);
    assert.equal(store.get(ids[0]).x, 3);
  } finally {
    console.error = err;
  }
});

Deno.test("text normalizer: boxes follow the text, anchored by alignment", () => {
  const store = new Store();
  installTextNormalizer(store);
  const [id] = store.add(createLayer("text", { text: "Hi", x: 500, y: 300, align: "left" }));
  let l = store.get(id);
  const box = measureBox(l);
  assert.equal(l.w, Math.round(box.w * 100) / 100);
  assert.equal(l.x, 500, "a new layer keeps its center");
  const left = l.x - l.w / 2;
  const top = l.y - l.h / 2;
  store.patch(id, { text: "Hello there" });
  l = store.get(id);
  assert.ok(l.w > box.w);
  assert.ok(Math.abs(l.x - l.w / 2 - left) < 0.02, "left edge stays for left-aligned text");
  store.patch(id, { text: "Hello there\nsecond line" });
  l = store.get(id);
  assert.ok(Math.abs(l.y - l.h / 2 - top) < 0.02, "top edge stays while typing");

  store.patch(id, { align: "right" });
  l = store.get(id);
  const right = l.x + l.w / 2;
  const cy = l.y;
  store.patch(id, { size: 200 });
  l = store.get(id);
  assert.ok(Math.abs(l.x + l.w / 2 - right) < 0.02, "right edge stays for right-aligned text");
  assert.ok(Math.abs(l.y - cy) < 0.02, "style changes keep the vertical center");

  store.patch(id, { align: "center" });
  l = store.get(id);
  const cx = l.x;
  store.patch(id, { letterSpacing: 300, stroke: { width: 30 } });
  l = store.get(id);
  assert.ok(Math.abs(l.x - cx) < 0.02, "center-aligned text keeps its center");
});

Deno.test("text normalizer: anchors in the rotated frame, fixed wrap keeps w", () => {
  const store = new Store();
  installTextNormalizer(store);
  const [id] = store.add(createLayer("text", { text: "A", x: 0, y: 0, align: "left", rotation: 90 }));
  let l = store.get(id);
  const leftEdge = { x: l.x - Math.cos(Math.PI / 2) * (l.w / 2), y: l.y - Math.sin(Math.PI / 2) * (l.w / 2) };
  store.patch(id, { text: "AAAAAA" });
  l = store.get(id);
  const now = { x: l.x - Math.cos(Math.PI / 2) * (l.w / 2), y: l.y - Math.sin(Math.PI / 2) * (l.w / 2) };
  assert.ok(Math.abs(now.x - leftEdge.x) < 0.02 && Math.abs(now.y - leftEdge.y) < 0.02);

  store.patch(id, { wrap: "fixed", w: 300, rotation: 0, text: "one two three four five six seven" });
  l = store.get(id);
  assert.equal(l.w, 300);
  assert.ok(l.h > 300, "long text wraps onto several lines");
});

Deno.test("mergeLayer returns the same object when nothing changes", () => {
  const l = createLayer("shape");
  assert.equal(mergeLayer(l, { x: l.x, fill: { on: true } }), l);
  const m = mergeLayer(l, { fill: { color: "#000000" } });
  assert.notEqual(m, l);
  assert.equal(l.fill.color, "#d1ff4a");
});

Deno.test("referencedAssets covers the doc, history and gestures", () => {
  const store = new Store();
  const [id] = store.add(createLayer("image", { asset: "ast_one" }));
  store.patch(id, { mask: "ast_mask" });
  store.patch(id, { asset: "ast_two", mask: null });
  assert.deepEqual([...store.referencedAssets()].sort(), ["ast_mask", "ast_one", "ast_two"]);
});

Deno.test("coalesce: a nudge on another layer starts a new entry", () => {
  const { store, ids, tick } = setup(2);
  const depth = store._undo.length;
  store.select(ids[0]);
  for (let i = 1; i <= 3; i++) {
    tick(100);
    store.patch(ids[0], { x: 100 + i }, { coalesce: "nudge", label: "Nudge" });
  }
  assert.equal(store._undo.length, depth + 1, "one entry for the run on the first layer");
  tick(300);
  store.select(ids[1]);
  tick(300);
  store.patch(ids[1], { x: 201 }, { coalesce: "nudge", label: "Nudge" });
  assert.equal(store._undo.length, depth + 2, "the other layer's nudge is its own step");
  store.undo();
  assert.equal(store.get(ids[1]).x, 200);
  assert.equal(store.get(ids[0]).x, 103, "the first layer's nudges stay");
  assert.deepEqual(store.selection, [ids[1]]);
  store.undo();
  assert.equal(store.get(ids[0]).x, 100);
});

Deno.test("history: snapshots share unchanged layers instead of copying them", () => {
  const { store, ids } = setup(2);
  const points = Array.from({ length: 2000 }, (_, i) => [i / 1999, 0.5, 0.5]);
  const [path] = store.add(createLayer("path", { points }), { select: false });
  const kept = store.get(path);
  store.patch(ids[0], { x: 1 });
  store.begin("Move");
  const moving = store._gestures[0].doc;
  assert.equal(moving, store.doc, "begin keeps the doc by reference");
  store.patch(ids[1], { y: 5 });
  store.commit();
  store.patch(ids[0], { x: 2 });
  for (const entry of store._undo) {
    const p = entry.doc.layers.find((l) => l.id === path);
    if (p) assert.equal(p, kept, "the long stroke is stored once");
  }
  store.undo();
  store.undo();
  assert.equal(store.get(ids[1]).y, 360);
  assert.equal(store.get(path), kept);
  store.redo();
  assert.equal(store.get(ids[1]).y, 5);
  assert.equal(store._redo.at(-1).doc.layers.find((l) => l.id === path), kept);
});

Deno.test("gesture: a drag that returns to its start records nothing, a real change still records", () => {
  const { store, ids } = setup(2);
  const depth = store._undo.length;
  store.begin("Drag");
  store.patch(ids[0], { x: 300 });
  store.patch(ids[0], { x: 100 });
  assert.equal(store.commit(), false, "new layer object, same content");
  assert.equal(store._undo.length, depth);
  store.begin("Rename");
  store.setDocProps({ name: "Other" });
  assert.equal(store.commit(), true, "doc props count");
  store.begin("Reorder");
  store.toFront(ids[0]);
  assert.equal(store.commit(), true, "order counts");
  assert.equal(store._undo.length, depth + 2);
});

Deno.test("index and selection stay right across patches, reorders and normalizers", () => {
  const { store, ids } = setup(4);
  store.clearHistory();
  const seen = [];
  store.addNormalizer((layer, doc, prev) => {
    seen.push([layer.id, doc.layers.indexOf(layer), prev?.name ?? null]);
  });
  store.select([ids[1], ids[3]]);
  // A patch keeps every id where it was: the same selection array, fresh lookups.
  const sel = store.selection;
  store.patch(ids[3], { x: 7 });
  assert.equal(store.selection, sel, "selection untouched by a patch");
  assert.equal(store.get(ids[3]).x, 7);
  assert.deepEqual(ids.map((id) => store.index(id)), [0, 1, 2, 3]);
  assert.deepEqual(seen.at(-1), [ids[3], 3, "S3"]);
  // A reorder moves the index with it.
  store.toFront(ids[0]);
  assert.deepEqual(ids.map((id) => store.index(id)), [3, 0, 1, 2]);
  store.patch(ids[0], { x: 9 });
  assert.equal(store.get(ids[0]).x, 9);
  assert.deepEqual(seen.at(-1), [ids[0], 3, "S0"]);
  // update() can reorder and edit in one go; normalizers still see the right layer.
  store.update((d) => {
    d.layers.reverse();
    d.layers[0].x = 42;
  });
  const first = store.layers()[0];
  assert.equal(first.x, 42);
  assert.equal(store.get(first.id), first);
  assert.ok(seen.some(([id, i]) => id === first.id && i === 0), "normalizer saw the moved layer at its new index");
  // remove prunes; remeasure keeps lookups working.
  store.remove(ids[1]);
  assert.deepEqual(store.selection, [ids[3]]);
  assert.equal(store.index(ids[1]), -1);
  store.remeasure();
  for (const l of store.layers()) assert.equal(store.get(l.id), l);
  // Undo back through all of it: lookups follow the restored doc.
  while (store.undo());
  assert.deepEqual(ids.map((id) => store.index(id)), [0, 1, 2, 3]);
  assert.deepEqual(store.layers().map((l) => l.x), [100, 200, 300, 400]);
});
