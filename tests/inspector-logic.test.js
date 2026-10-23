// Tests for the pure logic in web/js/ui/inspector.js and the Panel binder's
// gesture handling (one undo step per drag), against the real Store.
//   deno test --allow-read tests/inspector-logic.test.js

import assert from "node:assert/strict";
import {
  readMixed,
  sameValue,
  shadowPolar,
  polarToShadow,
  weightName,
  fontSwitchProps,
  isBackdrop,
  scaleLayer,
  resizeDocContent,
  setFilter,
  edgeState,
  jobText,
  Panel,
  resizeCanvas,
} from "../web/js/ui/inspector.js";
import { Store } from "../web/js/core/store.js";
import { createDoc, createLayer } from "../web/js/core/model.js";

function setup() {
  const store = new Store(createDoc());
  let t = 1000;
  store.now = () => (t += 10);
  return store;
}

const fakeFonts = {
  info: {
    Anton: { family: "Anton", weights: [400], italic: false, defaultWeight: 400 },
    Rubik: { family: "Rubik", weights: [300, 400, 500, 600, 700, 800, 900], variable: { min: 300, max: 900 }, italic: true, defaultWeight: 900 },
    Poppins: { family: "Poppins", weights: [800, 900], italic: true, defaultWeight: 800 },
  },
  get(f) {
    return this.info[f] || null;
  },
  nearestWeight(f, w) {
    const ws = this.info[f]?.weights || [400];
    return ws.reduce((a, b) => (Math.abs(b - w) < Math.abs(a - w) ? b : a));
  },
};

Deno.test("readMixed: value of the first layer, mixed when any differs", () => {
  const a = createLayer("text", { size: 100 });
  const b = createLayer("text", { size: 100 });
  const c = createLayer("text", { size: 80 });
  assert.deepEqual(readMixed([a, b], (l) => l.size), { value: 100, mixed: false });
  assert.deepEqual(readMixed([a, c], (l) => l.size), { value: 100, mixed: true });
  assert.deepEqual(readMixed([], (l) => l.size), { value: undefined, mixed: false });
  assert.equal(readMixed([a, b], (l) => l.stroke).mixed, false, "objects compare deeply");
  assert.ok(sameValue(0.1 + 0.2, 0.3));
});

Deno.test("shadow distance and direction convert both ways", () => {
  assert.deepEqual(shadowPolar({ dx: 0, dy: 10 }), { distance: 10, angle: 90 });
  assert.deepEqual(shadowPolar({ dx: -10, dy: 0 }), { distance: 10, angle: 180 });
  assert.deepEqual(shadowPolar({ dx: 0, dy: 0 }, 45), { distance: 0, angle: 45 });
  assert.deepEqual(polarToShadow(10, 90), { dx: 0, dy: 10 });
  assert.deepEqual(polarToShadow(20, 0), { dx: 20, dy: 0 });
  assert.deepEqual(polarToShadow(0, 33), { dx: 0, dy: 0 });
  for (const [d, a] of [[12, 45], [30, -135], [5, 170]]) {
    const back = shadowPolar(polarToShadow(d, a));
    assert.ok(Math.abs(back.distance - d) < 0.2, `${d}`);
    assert.ok(Math.abs(back.angle - a) < 1, `${a}`);
  }
});

Deno.test("weightName", () => {
  assert.equal(weightName(400), "Regular");
  assert.equal(weightName(900), "Black");
  assert.equal(weightName(650), "650");
});

Deno.test("fontSwitchProps: keeps weights the family has, takes the default otherwise", () => {
  const onDefault = createLayer("text", { font: "Anton", weight: 400 });
  assert.deepEqual(fontSwitchProps(fakeFonts, onDefault, "Rubik"), { font: "Rubik", weight: 900, italic: false });
  const chosen = createLayer("text", { font: "Rubik", weight: 500, italic: true });
  assert.deepEqual(fontSwitchProps(fakeFonts, chosen, "Poppins"), { font: "Poppins", weight: 800, italic: true });
  assert.deepEqual(fontSwitchProps(fakeFonts, chosen, "Anton"), { font: "Anton", weight: 400, italic: false }, "Anton has no italic");
  assert.deepEqual(fontSwitchProps(null, chosen, "Unknown"), { font: "Unknown", weight: 500, italic: true });
});

Deno.test("isBackdrop: unrotated image or shape covering the canvas", () => {
  assert.ok(isBackdrop(createLayer("image", { x: 640, y: 360, w: 1280, h: 720 }), 1280, 720));
  assert.ok(isBackdrop(createLayer("image", { x: 640, y: 360, w: 1300, h: 740 }), 1280, 720));
  assert.ok(!isBackdrop(createLayer("image", { x: 640, y: 360, w: 1000, h: 720 }), 1280, 720));
  assert.ok(!isBackdrop(createLayer("image", { x: 640, y: 360, w: 1280, h: 720, rotation: 5 }), 1280, 720));
  assert.ok(!isBackdrop(createLayer("text", { x: 640, y: 360, w: 1280, h: 720 }), 1280, 720));
});

Deno.test("scaleLayer scales size-like props by type", () => {
  const t = scaleLayer(createLayer("text", { size: 100, w: 400, h: 120, stroke: { on: true, width: 10 }, shadow: { on: true, blur: 20, dx: 0, dy: 8 } }), 0.5);
  assert.equal(t.size, 50);
  assert.equal(t.stroke.width, 5);
  assert.equal(t.shadow.blur, 10);
  assert.equal(t.shadow.dy, 4);
  assert.equal(t.bg.padX, 14);
  const a = scaleLayer(createLayer("arrow", { width: 14 }), 2);
  assert.equal(a.width, 28);
  const s = scaleLayer(createLayer("shape", { radius: 20, stroke: { on: true, width: 8 } }), 1.5);
  assert.equal(s.radius, 30);
  assert.equal(s.stroke.width, 12);
});

Deno.test("resizeDocContent keep: sizes stay, offsets from the center stay", () => {
  const doc = createDoc();
  doc.layers.push(createLayer("shape", { x: 640, y: 360, w: 100, h: 100 }), createLayer("text", { x: 100, y: 100 }));
  resizeDocContent(doc, 1080, 1080, "keep", "square");
  assert.equal(doc.width, 1080);
  assert.equal(doc.height, 1080);
  assert.equal(doc.preset, "square");
  assert.deepEqual([doc.layers[0].x, doc.layers[0].y, doc.layers[0].w], [540, 540, 100]);
  assert.deepEqual([doc.layers[1].x, doc.layers[1].y], [0, 280]);
});

Deno.test("resizeDocContent scale: content fits, backdrops cover", () => {
  const doc = createDoc();
  doc.layers.push(
    createLayer("image", { x: 640, y: 360, w: 1280, h: 720, natW: 1280, natH: 720 }),
    createLayer("text", { x: 640, y: 180, size: 120 })
  );
  resizeDocContent(doc, 1080, 1080, "scale");
  const [bg, text] = doc.layers;
  assert.equal(bg.h, 1080, "backdrop covers the new height");
  assert.equal(bg.w, 1920);
  assert.deepEqual([bg.x, bg.y], [540, 540]);
  const k = 1080 / 1280;
  assert.equal(text.size, Math.round(120 * k * 100) / 100);
  assert.equal(text.x, 540);
  assert.equal(text.y, Math.round((540 - 180 * k) * 100) / 100);
});

Deno.test("setFilter adds, updates and removes one filter", () => {
  let list = setFilter([], "grain", true, { amount: 24 });
  assert.deepEqual(list, [{ id: "grain", params: { amount: 24 } }]);
  list = setFilter(list, "grain", true, { size: 2 });
  assert.deepEqual(list, [{ id: "grain", params: { amount: 24, size: 2 } }]);
  list = setFilter(list, "duotone", true, {});
  assert.equal(list.length, 2);
  assert.deepEqual(setFilter(list, "grain", false).map((f) => f.id), ["duotone"]);
});

Deno.test("edgeState of an untouched mask is its own base", () => {
  assert.deepEqual(edgeState({ mask: "ast_x" }), { base: "ast_x", soften: 0, grow: 0 });
  assert.deepEqual(edgeState(null), { base: null, soften: 0, grow: 0 });
});

Deno.test("jobText", () => {
  assert.equal(jobText({ phase: "download", progress: 0.42, message: "" }), "Downloading the model 42%");
  assert.equal(jobText({ phase: "download", progress: 0.3, message: "Downloading · 12 of 44 MB" }), "Downloading · 12 of 44 MB");
  assert.equal(jobText({ phase: "run", progress: 0, message: "Refining edges" }), "Refining edges");
  assert.equal(jobText({ phase: "run", progress: 0, message: "" }), "Removing background");
  assert.equal(jobText(null), "");
});

Deno.test("Panel: a drag is one undo step, a click is one labeled step", () => {
  const store = setup();
  const [id] = store.add(createLayer("text", { size: 100 }));
  const p = new Panel({ store }, [id]);
  const size = p.patcher("Font size", (v) => ({ size: v }));
  const before = store._undo.length;
  size.input(110);
  size.input(120);
  size.input(130);
  assert.equal(store.inGesture, true);
  size.change(140);
  assert.equal(store.inGesture, false);
  assert.equal(store.get(id).size, 140);
  assert.equal(store._undo.length, before + 1);
  assert.equal(store.historyLabels().undo, "Font size");
  store.undo();
  assert.equal(store.get(id).size, 100);
  size.change(90);
  assert.equal(store.get(id).size, 90);
  assert.equal(store.historyLabels().undo, "Font size");
});

Deno.test("Panel: destroy commits a drag left open", () => {
  const store = setup();
  const [id] = store.add(createLayer("shape"));
  const p = new Panel({ store }, [id]);
  const r = p.patcher("Corner radius", (v) => ({ radius: v }));
  r.input(12);
  p.destroy();
  assert.equal(store.inGesture, false);
  assert.equal(store.get(id).radius, 12);
  assert.equal(store.historyLabels().undo, "Corner radius");
});

Deno.test("Panel: a late end() never pops the editor's gesture", async () => {
  const store = setup();
  const [id] = store.add(createLayer("shape", { w: 200, h: 120, opacity: 1 }));
  const p = new Panel({ store }, [id]);
  const opacity = p.patcher("Opacity", (v) => ({ opacity: v }));
  opacity.input(0.98); // arrow key in the field: gesture open until focusout
  store.begin("Resize"); // a handle grabbed before the field's focusout ran
  opacity.end(); // the late focusout
  assert.equal(store._gestures.at(-1)?.label, "Resize", "the editor's gesture stays on top");
  store.patch(id, { w: 260, h: 168 });
  store.commit(); // pointerup
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(store.inGesture, false, "the field's gesture closes once it is on top again");
  assert.equal(store.get(id).w, 260);
  assert.equal(store.get(id).opacity, 0.98);
});

Deno.test("Panel: flush() settles open fields before the canvas opens a gesture", () => {
  const store = setup();
  const [id] = store.add(createLayer("shape", { w: 200, h: 120, opacity: 1 }));
  const p = new Panel({ store }, [id]);
  const sub = p.child();
  const opacity = sub.patcher("Opacity", (v) => ({ opacity: v }));
  opacity.input(0.99);
  opacity.input(0.98);
  p.flush(); // pointerdown outside the inspector
  assert.equal(store.inGesture, false);
  assert.equal(store.historyLabels().undo, "Opacity");
  store.begin("Resize");
  store.patch(id, { w: 260 });
  opacity.end(); // the focusout that follows is a no-op now
  assert.equal(store._gestures.at(-1)?.label, "Resize");
  store.commit();
  assert.equal(store.historyLabels().undo, "Resize");
  store.undo();
  assert.equal(store.get(id).w, 200, "one undo reverts the resize only");
  assert.equal(store.get(id).opacity, 0.98);
  store.undo();
  assert.equal(store.get(id).opacity, 1);
  p.flush(); // nothing open: harmless
  assert.equal(store.inGesture, false);
});

Deno.test("Panel: a typed value commits under its own label when flushed first", () => {
  const store = setup();
  const [id] = store.add(createLayer("text", { size: 100 }));
  const p = new Panel({ store }, [id]);
  const size = p.patcher("Font size", (v) => ({ size: v }));
  size.change(48); // blur commit, run by the pointerdown settle
  store.begin("Resize");
  store.patch(id, { x: 10 });
  store.cancel(); // Escape mid-drag
  assert.equal(store.get(id).size, 48, "cancelling the drag keeps the typed size");
  assert.equal(store.historyLabels().undo, "Font size");
});

Deno.test("Panel: edits every selected layer, doc mode edits the canvas", () => {
  const store = setup();
  const ids = store.add([createLayer("shape", { radius: 0 }), createLayer("shape", { radius: 4 })]);
  const p = new Panel({ store }, ids);
  assert.equal(p.read((l) => l.radius).mixed, true);
  p.patch(() => ({ radius: 9 }), "Corner radius");
  assert.deepEqual(ids.map((id) => store.get(id).radius), [9, 9]);
  assert.equal(p.read((l) => l.radius).mixed, false);
  assert.equal(p.every((l) => l.radius === 9), true);

  const docPanel = new Panel({ store }, [], { doc: true });
  const bg = docPanel.patcher("Background color", (v) => ({ background: { kind: "color", color: v } }));
  bg.input("#ff0000");
  bg.change("#00ff00");
  assert.deepEqual(store.doc.background, { kind: "color", color: "#00ff00" });
  assert.equal(store.historyLabels().undo, "Background color");
});

Deno.test("resizeCanvas: one undo step, preset follows the size", async () => {
  const store = setup();
  store.add(createLayer("shape", { x: 640, y: 360, w: 100, h: 100 }));
  const presets = {
    get: (id) => ({ square: { id: "square", width: 1080, height: 1080 }, "yt-thumb": { id: "yt-thumb", width: 1280, height: 720 } })[id] || null,
    find: (w, h) => (w === 1080 && h === 1080 ? { id: "square" } : null),
  };
  const ctx = { store, presets, ui: {} };
  const undoBefore = store._undo.length;
  assert.equal(await resizeCanvas(ctx, { width: 1080, height: 1080, mode: "keep" }), true);
  assert.equal(store.doc.width, 1080);
  assert.equal(store.doc.preset, "square");
  assert.equal(store.layers()[0].x, 540);
  assert.equal(store._undo.length, undoBefore + 1);
  assert.equal(store.historyLabels().undo, "Resize canvas");
  await resizeCanvas(ctx, { preset: "yt-thumb", mode: "scale" });
  assert.equal(store.doc.width, 1280);
  assert.equal(store.doc.preset, "yt-thumb");
  store.undo();
  assert.equal(store.doc.width, 1080);
  await resizeCanvas(ctx, { width: 999, height: 999, mode: "keep" });
  assert.equal(store.doc.preset, null, "a size no preset has is custom");
});
