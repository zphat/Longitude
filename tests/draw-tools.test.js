// Tests for the drawing and text tools (web/js/editor/tools/*.js), driven
// with a fake tool api and a real Store. No DOM: the overlay is absent, so
// only the document side of each gesture is checked here.
//   deno test --allow-read tests/draw-tools.test.js

import assert from "node:assert/strict";
import { createRegistry, createCommands } from "../web/js/app/context.js";
import { Store } from "../web/js/core/store.js";
import { createLayer } from "../web/js/core/model.js";
import { arrowPoints, setAlphaMap } from "../web/js/core/geometry.js";
import { installTextNormalizer, measureBox } from "../web/js/core/textlayout.js";
import { registerDrawTools, createKit, TOOL_DEFAULTS } from "../web/js/editor/tools/draw.js";
import { dragBox } from "../web/js/editor/tools/shape.js";
import { snapDirection } from "../web/js/editor/tools/arrow.js";
import { cleanLayer, morphTargets, strokePathData } from "../web/js/editor/tools/pen.js";
import { maskPoint, maskScale, cleanBrush, refineTarget } from "../web/js/editor/tools/refine.js";
import { imagePoint, imageAt, magicTolerance, hasMagicTarget } from "../web/js/editor/tools/magic.js";
import { newTextProps, bigEnoughBox, insertPoint } from "../web/js/editor/tools/text.js";

const near = (a, b, eps = 1e-6, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} != ${b} (±${eps})`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fakePrefs(init = {}) {
  const data = { ...init };
  return {
    data,
    get: (k, f) => (Object.hasOwn(data, k) ? data[k] : f),
    set: (k, v) => {
      if (v === undefined) delete data[k];
      else data[k] = v;
    },
  };
}

function setup({ prefs = {}, layers = [] } = {}) {
  const store = new Store();
  const offText = installTextNormalizer(store);
  if (layers.length) store.add(layers, { select: false });
  store.clearHistory();
  const events = new EventTarget();
  const ctx = {
    events,
    prefs: fakePrefs(prefs),
    tools: createRegistry("tools"),
    store,
    ui: { toast() {} },
    emit(type, detail) {
      events.dispatchEvent(new CustomEvent(type, { detail }));
    },
    on(type, fn) {
      const l = (e) => fn(e.detail);
      events.addEventListener(type, l);
      return () => events.removeEventListener(type, l);
    },
  };
  ctx.commands = createCommands(ctx);
  const edits = [];
  const editor = {
    tool: "select",
    setTool(id) {
      this.tool = id;
    },
    startTextEdit(id) {
      edits.push(id);
      return true;
    },
    setMaskOverride() {},
    flash() {},
    requestRender() {},
  };
  ctx.editor = editor;
  const dispose = registerDrawTools(ctx, editor);
  let status = null;
  const api = {
    ctx,
    editor,
    store,
    toDoc: (e) => ({ x: e.clientX, y: e.clientY }),
    toScreen: (p) => ({ x: p.x, y: p.y }),
    zoom: 1,
    overlay: null,
    requestRender() {},
    setCursor() {},
    snapPoint: (p) => p,
    clearGuides() {},
    pick: () => null,
    setStatus(t) {
      status = t;
    },
    get status() {
      return status;
    },
  };
  const tool = (id) => {
    editor.tool = id;
    const t = ctx.tools.get(id);
    t.activate?.(api);
    return t;
  };
  return { ctx, store, editor, api, tool, edits, dispose: () => (dispose(), offText()) };
}

let clock = 1000;
function ev(x, y, extra = {}) {
  clock += 8;
  return { clientX: x, clientY: y, button: 0, buttons: 1, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, pointerType: "mouse", timeStamp: clock, ...extra };
}

function dragWith(t, api, from, to, mods = {}, steps = 6) {
  t.pointerDown(ev(from[0], from[1], mods), api);
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    t.pointerMove(ev(from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k, mods), api);
  }
  t.pointerUp(ev(to[0], to[1], { ...mods, buttons: 0 }), api);
}

// ---- registration ------------------------------------------------------------------

Deno.test("registerDrawTools adds every tool and command, and removes them again", () => {
  const { ctx, dispose } = setup();
  for (const id of ["text", "rect", "ellipse", "circle", "arrow", "pen", "refine", "magic"]) assert.ok(ctx.tools.get(id), `tool ${id}`);
  for (const id of ["tool.text", "tool.rect", "tool.ellipse", "tool.circle", "tool.arrow", "tool.pen", "tool.refine", "tool.magic", "insert.text", "text.edit"]) {
    assert.ok(ctx.commands.get(id), `command ${id}`);
  }
  assert.deepEqual(ctx.commands.get("tool.circle").keys, ["C"]);
  assert.deepEqual(ctx.commands.get("text.edit").keys, ["Enter"]);
  dispose();
  assert.equal(ctx.tools.list().length, 0);
  assert.equal(ctx.commands.list().length, 0);
});

Deno.test("tool commands switch tools; refine and magic need an image", () => {
  const img = createLayer("image", { asset: "ast_one", natW: 800, natH: 600 });
  const masked = createLayer("image", { asset: "ast_two", mask: "ast_mask", natW: 800, natH: 600 });
  const { ctx, store, editor, dispose } = setup();
  assert.equal(ctx.commands.enabled("tool.magic"), false);
  assert.equal(ctx.commands.enabled("tool.refine"), false);
  ctx.commands.run("tool.pen");
  assert.equal(editor.tool, "pen");
  store.add([img, masked], { select: false });
  assert.equal(ctx.commands.enabled("tool.magic"), true);
  store.select([img.id]);
  assert.equal(ctx.commands.enabled("tool.refine"), true, "a plain image gets an eraser");
  store.select([masked.id]);
  assert.equal(ctx.commands.enabled("tool.refine"), true);
  store.select([img.id, masked.id]);
  assert.equal(ctx.commands.enabled("tool.refine"), false, "one image at a time");
  dispose();
});

Deno.test("text.edit runs on exactly one unlocked text layer", () => {
  const t = createLayer("text", { text: "Hi" });
  const locked = createLayer("text", { text: "Locked", locked: true });
  const { ctx, store, edits, dispose } = setup({ layers: [t, locked] });
  assert.equal(ctx.commands.enabled("text.edit"), false);
  store.select([t.id]);
  assert.equal(ctx.commands.enabled("text.edit"), true);
  ctx.commands.run("text.edit");
  assert.deepEqual(edits, [t.id]);
  store.select([locked.id]);
  assert.equal(ctx.commands.enabled("text.edit"), false);
  dispose();
});

// ---- shapes -----------------------------------------------------------------------

Deno.test("dragBox handles corners, squares and centre drags", () => {
  assert.deepEqual(dragBox({ x: 100, y: 100 }, { x: 300, y: 250 }), { x: 200, y: 175, w: 200, h: 150 });
  assert.deepEqual(dragBox({ x: 100, y: 100 }, { x: 0, y: 40 }), { x: 50, y: 70, w: 100, h: 60 });
  assert.deepEqual(dragBox({ x: 100, y: 100 }, { x: 300, y: 150 }, { square: true }), { x: 200, y: 200, w: 200, h: 200 });
  assert.deepEqual(dragBox({ x: 100, y: 100 }, { x: 150, y: 130 }, { center: true }), { x: 100, y: 100, w: 100, h: 60 });
});

Deno.test("dragging the rectangle tool makes one filled rectangle in one undo step", () => {
  const { store, editor, api, tool, dispose } = setup();
  const t = tool("rect");
  dragWith(t, api, [100, 100], [300, 250]);
  const layers = store.layers();
  assert.equal(layers.length, 1);
  const l = layers[0];
  assert.equal(l.type, "shape");
  assert.equal(l.shape, "rect");
  assert.equal(l.name, "Rectangle");
  assert.equal(l.fill.on, true);
  assert.equal(l.fill.color, TOOL_DEFAULTS.rect.color);
  assert.equal(l.stroke.on, false);
  assert.deepEqual([l.x, l.y, l.w, l.h], [200, 175, 200, 150]);
  assert.equal(store.historyLabels().undo, "Add rectangle");
  store.undo();
  assert.equal(store.layers().length, 0, "one step removes it");
  assert.equal(editor.tool, "select", "back to select");
  dispose();
});

Deno.test("Shift draws a circle, Alt draws from the centre", () => {
  const { store, api, tool, dispose } = setup();
  dragWith(tool("ellipse"), api, [100, 100], [260, 180], { shiftKey: true });
  let l = store.layers()[0];
  assert.equal(l.shape, "ellipse");
  assert.equal(l.w, l.h);
  near(l.w, 160);
  dragWith(tool("ellipse"), api, [500, 400], [560, 440], { altKey: true });
  l = store.layers()[1];
  assert.deepEqual([l.x, l.y, l.w, l.h], [500, 400, 120, 80]);
  dispose();
});

Deno.test("a click with the highlight circle makes the classic red ring", () => {
  const { store, api, tool, dispose } = setup();
  const t = tool("circle");
  t.pointerDown(ev(640, 360), api);
  t.pointerUp(ev(640, 360, { buttons: 0 }), api);
  const l = store.layers()[0];
  assert.equal(l.name, "Circle");
  assert.equal(l.shape, "ellipse");
  assert.equal(l.fill.on, false);
  assert.deepEqual(l.stroke, { on: true, color: "#ff2d2d", width: 12, dash: false });
  assert.deepEqual([l.x, l.y, l.w, l.h], [640, 360, 360, 220]);
  assert.equal(store.historyLabels().undo, "Add circle");
  dispose();
});

Deno.test("Escape during a drag leaves nothing behind", () => {
  const { store, api, tool, dispose } = setup();
  const t = tool("rect");
  t.pointerDown(ev(10, 10), api);
  t.pointerMove(ev(200, 200), api);
  assert.equal(store.layers().length, 1);
  assert.equal(t.keyDown({ key: "Escape" }, api), true);
  assert.equal(store.layers().length, 0);
  assert.equal(store.canUndo, false);
  dispose();
});

Deno.test("shapes use the remembered colour and width", () => {
  const { store, api, tool, dispose } = setup({ prefs: { toolColors: { circle: { color: "#FFE14D", width: 20 } } } });
  const t = tool("circle");
  t.pointerDown(ev(100, 100), api);
  t.pointerUp(ev(100, 100, { buttons: 0 }), api);
  assert.deepEqual(store.layers()[0].stroke, { on: true, color: "#ffe14d", width: 20, dash: false });
  dispose();
});

// ---- arrows ----------------------------------------------------------------------------

Deno.test("snapDirection rounds the angle and keeps the length", () => {
  const b = snapDirection({ x: 0, y: 0 }, { x: 100, y: 8 }, 15);
  near(b.y, 0, 1e-9);
  near(b.x, Math.hypot(100, 8), 1e-9);
  const c = snapDirection({ x: 0, y: 0 }, { x: 70, y: -74 }, 15);
  near(Math.atan2(c.y, c.x) * (180 / Math.PI), -45, 1e-9);
});

Deno.test("dragging the arrow tool puts the tail and tip where the pointer went", () => {
  const { store, editor, api, tool, dispose } = setup();
  dragWith(tool("arrow"), api, [100, 400], [500, 100]);
  const l = store.layers()[0];
  assert.equal(l.type, "arrow");
  assert.equal(l.head, "triangle");
  assert.equal(l.color, "#ff2d2d");
  assert.equal(l.width, 14);
  const p = arrowPoints(l);
  near(p.a.x, 100, 0.01);
  near(p.a.y, 400, 0.01);
  near(p.b.x, 500, 0.01);
  near(p.b.y, 100, 0.01);
  assert.equal(store.historyLabels().undo, "Add arrow");
  assert.deepEqual(store.selection, [l.id]);
  assert.equal(editor.tool, "select");
  dispose();
});

Deno.test("Shift snaps the arrow to 15 degree steps; a click makes a default arrow", () => {
  const { store, api, tool, dispose } = setup();
  dragWith(tool("arrow"), api, [100, 100], [400, 112], { shiftKey: true });
  let p = arrowPoints(store.layers()[0]);
  near(p.b.y, 100, 0.01);
  const t = tool("arrow");
  t.pointerDown(ev(640, 360), api);
  t.pointerUp(ev(640, 360, { buttons: 0 }), api);
  p = arrowPoints(store.layers()[1]);
  near(Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y), 260, 1e-2);
  assert.ok(p.b.x > p.a.x && p.b.y < p.a.y, "points up and right");
  near((p.a.x + p.b.x) / 2, 640, 1e-2);
  near((p.a.y + p.b.y) / 2, 360, 1e-2);
  dispose();
});

// ---- pen ---------------------------------------------------------------------------------

function circleStroke(cx, cy, r, n = 60, sweep = 1.04) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2 * sweep;
    out.push([cx + Math.cos(t) * r + Math.sin(i * 0.7) * 1.5, cy + Math.sin(t) * r]);
  }
  return out;
}

Deno.test("a pen stroke becomes a drawing and the pen stays active", () => {
  const { store, editor, api, tool, dispose } = setup();
  const t = tool("pen");
  assert.equal(api.status, "Hold still to perfect the shape", "first-use hint");
  const pts = [];
  for (let i = 0; i <= 40; i++) pts.push([100 + i * 8, 300 + Math.sin(i / 3) * 40]);
  t.pointerDown(ev(...pts[0]), api);
  for (const p of pts.slice(1)) t.pointerMove(ev(...p), api);
  t.pointerUp(ev(...pts[pts.length - 1], { buttons: 0 }), api);
  const l = store.layers()[0];
  assert.equal(l.type, "path");
  assert.equal(l.color, "#ff2d2d");
  assert.equal(l.width, 10);
  assert.ok(l.points.length >= 30, `points ${l.points.length}`);
  assert.ok(l.points.every((p) => p.length === 3 && p[2] > 0 && p[2] <= 1), "pressure kept");
  assert.equal(store.historyLabels().undo, "Add drawing");
  assert.equal(editor.tool, "pen", "sticky");
  t.deactivate(api);
  dispose();
});

Deno.test("holding still at the end of a rough circle makes a clean circle", async () => {
  const { store, api, tool, dispose } = setup();
  const t = tool("pen");
  const pts = circleStroke(400, 300, 120);
  t.pointerDown(ev(...pts[0]), api);
  for (const p of pts.slice(1)) t.pointerMove(ev(...p), api);
  await wait(520);
  t.pointerUp(ev(...pts[pts.length - 1], { buttons: 0 }), api);
  const l = store.layers()[0];
  assert.equal(l.type, "shape");
  assert.equal(l.shape, "ellipse");
  assert.equal(l.fill.on, false);
  assert.equal(l.stroke.color, "#ff2d2d");
  assert.equal(l.stroke.width, 10);
  near(l.x, 400, 6);
  near(l.y, 300, 6);
  near(l.w, 250, 14);
  assert.equal(l.w, l.h);
  assert.equal(store.historyLabels().undo, "Add circle");
  t.deactivate(api);
  dispose();
});

Deno.test("moving on after the snap keeps drawing freehand", async () => {
  const { store, api, tool, dispose } = setup();
  const t = tool("pen");
  const pts = circleStroke(400, 300, 120);
  t.pointerDown(ev(...pts[0]), api);
  for (const p of pts.slice(1)) t.pointerMove(ev(...p), api);
  await wait(520);
  const last = pts[pts.length - 1];
  for (let i = 1; i <= 10; i++) t.pointerMove(ev(last[0] + i * 12, last[1] + i * 9), api);
  t.pointerUp(ev(last[0] + 120, last[1] + 90, { buttons: 0 }), api);
  assert.equal(store.layers()[0].type, "path");
  t.deactivate(api);
  dispose();
});

Deno.test("cleanLayer builds clean layers for each kind", () => {
  const style = { color: "#00ff00", width: 8 };
  const e = cleanLayer({ kind: "ellipse", params: { cx: 10, cy: 20, rx: 50, ry: 30, rotation: 15 } }, style);
  assert.deepEqual([e.type, e.shape, e.w, e.h, e.rotation, e.stroke.width, e.fill.on], ["shape", "ellipse", 108, 68, 15, 8, false]);
  const r = cleanLayer({ kind: "rect", params: { cx: 0, cy: 0, w: 100, h: 60, rotation: 0 } }, style);
  assert.deepEqual([r.shape, r.name, r.w, r.h], ["rect", "Rectangle", 108, 68]);
  const line = cleanLayer({ kind: "line", params: { a: { x: 0, y: 0 }, b: { x: 200, y: 0 } } }, style);
  assert.deepEqual([line.type, line.head, line.name, line.color, line.width], ["arrow", "none", "Line", "#00ff00", 8]);
  const arrow = cleanLayer({ kind: "arrow", params: { a: { x: 0, y: 0 }, b: { x: 200, y: 100 }, c: { x: 120, y: -40 } } }, style);
  assert.equal(arrow.head, "triangle");
  const p = arrowPoints(arrow);
  near(p.a.x, 0, 0.01);
  near(p.b.x, 200, 0.01);
  near(p.c.x, 120, 0.01);
  near(p.c.y, -40, 0.01);
  assert.equal(cleanLayer({ kind: null, params: null }, style), null);
});

Deno.test("morph targets start where the stroke starts and lie on the shape", () => {
  const src = [];
  for (let i = 0; i < 96; i++) {
    const t = 1 + (i / 95) * Math.PI * 2;
    src.push({ x: Math.cos(t) * 100, y: Math.sin(t) * 100 });
  }
  const tgt = morphTargets({ kind: "ellipse", params: { cx: 0, cy: 0, rx: 90, ry: 90, rotation: 0 } }, src);
  assert.equal(tgt.length, 96);
  for (const p of tgt) near(Math.hypot(p.x, p.y), 90, 1e-6);
  near(Math.atan2(tgt[0].y, tgt[0].x), 1, 1e-6);
  assert.ok(Math.atan2(tgt[5].y, tgt[5].x) > 1, "same direction as the stroke");
  const rect = morphTargets({ kind: "rect", params: { cx: 0, cy: 0, w: 200, h: 100, rotation: 0 } }, [{ x: -100, y: -50 }, { x: 0, y: -52 }, { x: 100, y: -50 }]);
  for (const p of rect) assert.ok(Math.abs(Math.abs(p.x) - 100) < 1e-6 || Math.abs(Math.abs(p.y) - 50) < 1e-6, "on the outline");
});

Deno.test("strokePathData draws discs and joins", () => {
  const d = strokePathData([{ x: 0, y: 0, p: 0.5 }, { x: 40, y: 0, p: 0.5 }, { x: 80, y: 10, p: 0.6 }], 10);
  assert.ok(d.startsWith("M"));
  assert.ok(d.includes("A"));
  assert.ok(d.includes("L"));
  assert.equal(strokePathData([], 10), "");
});

// ---- text --------------------------------------------------------------------------------

Deno.test("a click with the text tool adds 'Your text' in the default style and edits it", () => {
  const { store, editor, api, tool, edits, dispose } = setup();
  const t = tool("text");
  t.pointerDown(ev(300, 200), api);
  t.pointerUp(ev(300, 200, { buttons: 0 }), api);
  const l = store.layers()[0];
  assert.equal(l.type, "text");
  assert.equal(l.text, "Your text");
  assert.equal(l.font, "Anton");
  assert.equal(l.size, 120);
  assert.equal(l.color, "#ffffff");
  assert.deepEqual(l.stroke, { on: true, color: "#000000", width: 10 });
  assert.equal(l.x, 300);
  assert.equal(l.y, 200);
  assert.deepEqual(edits, [l.id]);
  assert.equal(editor.tool, "select");
  dispose();
});

Deno.test("dragging with the text tool makes a fixed-width box from the drag", () => {
  const { store, api, tool, dispose } = setup();
  dragWith(tool("text"), api, [100, 100], [500, 160]);
  const l = store.layers()[0];
  assert.equal(l.wrap, "fixed");
  near(l.w, 400, 0.01);
  near(l.x, 300, 0.01);
  near(l.y - l.h / 2, 100, 0.01, "top edge at the drag");
  dispose();
});

Deno.test("new text uses the last text style", () => {
  const style = { font: "Bangers", size: 90, color: "#ffe14d", uppercase: true, stroke: { on: false, color: "#000000", width: 4 } };
  const { store, api, tool, dispose } = setup({ prefs: { lastTextStyle: style } });
  const t = tool("text");
  t.pointerDown(ev(0, 0), api);
  t.pointerUp(ev(0, 0, { buttons: 0 }), api);
  const l = store.layers()[0];
  assert.equal(l.font, "Bangers");
  assert.equal(l.size, 90);
  assert.equal(l.color, "#ffe14d");
  assert.equal(l.uppercase, true);
  assert.equal(l.stroke.on, false);
  dispose();
});

Deno.test("left-aligned text starts at the click", () => {
  const { ctx, dispose } = setup({ prefs: { lastTextStyle: { align: "left" } } });
  const kit = createKit(ctx, ctx.editor);
  const props = newTextProps(kit, { at: { x: 100, y: 50 } });
  const m = measureBox(createLayer("text", props));
  assert.ok(Math.abs(props.x - m.w / 2 - 100) < 0.01, `left edge ${props.x - m.w / 2}`);
  dispose();
});

Deno.test("insert.text centres new text on the canvas", () => {
  const { ctx, store, edits, dispose } = setup();
  ctx.commands.run("insert.text");
  const l = store.layers()[0];
  assert.equal(l.x, store.doc.width / 2);
  assert.equal(l.y, store.doc.height / 2);
  assert.deepEqual(edits, [l.id]);
  dispose();
});

// ---- remembered styles ----------------------------------------------------------------------

Deno.test("committed edits update the remembered colours and text style", () => {
  const arrow = createLayer("arrow", {});
  const text = createLayer("text", { text: "Hello" });
  const { ctx, store, dispose } = setup({ layers: [arrow, text] });
  store.patch(arrow.id, { color: "#2de2e6", width: 22 });
  assert.deepEqual(ctx.prefs.get("toolColors").arrow, { color: "#2de2e6", width: 22 });
  store.patch(text.id, { font: "Bebas Neue", color: "#ff7a1a" });
  const last = ctx.prefs.get("lastTextStyle");
  assert.equal(last.font, "Bebas Neue");
  assert.equal(last.color, "#ff7a1a");
  assert.equal(last.text, undefined, "words are not part of a style");
  store.begin("Drag");
  store.patch(arrow.id, { color: "#000000" }, { transient: true });
  assert.equal(ctx.prefs.get("toolColors").arrow.color, "#2de2e6", "transient changes are ignored");
  store.commit();
  dispose();
});

Deno.test("re-measuring text after a font loads does not change the remembered style", async () => {
  const a = createLayer("text", { text: "First", font: "Anton" });
  const b = createLayer("text", { text: "Second", font: "Oswald", size: 40 });
  const { ctx, store, dispose } = setup({ layers: [a, b] });
  store.patch(a.id, { color: "#ffe14d" });
  assert.equal(ctx.prefs.get("lastTextStyle").font, "Anton");
  // Make b's box stale (as if its font just loaded) so the re-measure changes it.
  store.doc = { ...store.doc, layers: store.doc.layers.map((l) => (l.id === b.id ? { ...l, w: 5 } : l)) };
  let changed = null;
  store.addEventListener("change", (e) => (changed = e.detail), { once: true });
  store.remeasure();
  assert.deepEqual(changed?.ids, [b.id], "the re-measure did change b");
  assert.equal(ctx.prefs.get("lastTextStyle").font, "Anton");
  await Promise.resolve();
  store.patch(b.id, { color: "#2de2e6" });
  assert.equal(ctx.prefs.get("lastTextStyle").font, "Oswald", "real edits still count");
  dispose();
});

// ---- refine and magic helpers ----------------------------------------------------------------

Deno.test("refine maps doc points to mask pixels through crop and flips", () => {
  const l = createLayer("image", { x: 500, y: 300, w: 400, h: 200, natW: 1000, natH: 1000, crop: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } });
  let p = maskPoint(l, 1000, 1000, { x: 300, y: 200 });
  near(p.x, 500);
  near(p.y, 500);
  p = maskPoint(l, 1000, 1000, { x: 700, y: 400 });
  near(p.x, 1000);
  near(p.y, 1000);
  p = maskPoint({ ...l, flipX: true }, 1000, 1000, { x: 300, y: 200 });
  near(p.x, 1000, 1e-9, "flipped");
  near(maskScale(l, 1000, 1000), (500 / 400 + 500 / 200) / 2);
});

Deno.test("refine brush settings are cleaned and the target needs a mask", () => {
  assert.deepEqual(cleanBrush({ size: 9999, hardness: -1, mode: "restore" }), { size: 400, hardness: 0, mode: "restore" });
  assert.deepEqual(cleanBrush(null), { size: 48, hardness: 0.6, mode: "erase" });
  const masked = createLayer("image", { asset: "ast_a", mask: "ast_m" });
  const plain = createLayer("image", { asset: "ast_b" });
  const { store, dispose } = setup({ layers: [masked, plain] });
  store.select([plain.id]);
  assert.equal(refineTarget(store, { needMask: true }), null);
  assert.equal(refineTarget(store)?.id, plain.id);
  store.select([masked.id, plain.id]);
  assert.equal(refineTarget(store), null, "one image only");
  dispose();
});

Deno.test("magic eraser finds the image under the point, selected first", () => {
  const back = createLayer("image", { asset: "ast_back", x: 640, y: 360, w: 1280, h: 720 });
  const front = createLayer("image", { asset: "ast_front", x: 640, y: 360, w: 300, h: 300, frame: "ellipse" });
  const text = createLayer("text", { text: "Over", x: 640, y: 360 });
  const { ctx, store, dispose } = setup({ layers: [back, front, text] });
  assert.equal(imageAt(store, { x: 640, y: 360 }).id, front.id, "text above is ignored");
  assert.equal(imageAt(store, { x: 500, y: 220 }).id, back.id, "outside the ellipse frame");
  store.select([back.id]);
  assert.equal(imageAt(store, { x: 640, y: 360 }).id, back.id, "selected image wins");
  const ip = imagePoint(front, { x: 640, y: 360 });
  near(ip.u, 0.5);
  near(ip.v, 0.5);
  assert.equal(ip.inside, true);
  assert.equal(magicTolerance(ctx.prefs), 32);
  ctx.prefs.set("magicTolerance", 250);
  assert.equal(magicTolerance(ctx.prefs), 100);
  assert.equal(hasMagicTarget(store), true);
  dispose();
});

Deno.test("the magic eraser reaches the image under a cutout's cleared area", () => {
  const back = createLayer("image", { asset: "ast_back2", x: 640, y: 360, w: 1280, h: 720 });
  const cut = createLayer("image", { asset: "ast_person", mask: "ast_person_mask", x: 640, y: 360, w: 400, h: 400 });
  // The cutout's mask: the left half cleared, the right half kept.
  const data = new Uint8Array(16 * 16);
  for (let y = 0; y < 16; y++) for (let x = 8; x < 16; x++) data[y * 16 + x] = 255;
  setAlphaMap("ast_person_mask", { w: 16, h: 16, data });
  const { store, dispose } = setup({ layers: [back, cut] });
  store.select([cut.id]);
  const cleared = { x: 500, y: 360 };
  const kept = { x: 780, y: 360 };
  assert.equal(imageAt(store, cleared).id, back.id, "the photo you can see, not the selected cutout");
  assert.equal(imageAt(store, kept).id, cut.id, "the person is still picked where it is visible");
  assert.equal(imageAt(store, cleared, { restore: true }).id, cut.id, "Alt brings colour back to the cutout");
  assert.equal(imageAt(store, { x: 100, y: 100 }, { restore: true }), null, "nothing to bring back on a plain image");
  dispose();
});

// ---- canvas size ------------------------------------------------------------------------

const resize = (store, w, h) => (store.doc = { ...store.doc, width: w, height: h });

Deno.test("new text keeps its size relative to the canvas it was styled on", () => {
  const { ctx, store, dispose } = setup();
  const kit = createKit(ctx, ctx.editor);
  // No remembered style: the defaults scale, outline included.
  resize(store, 3000, 3000);
  let s = kit.textStyle();
  assert.equal(s.size, 281);
  near(s.stroke.width, 23.44, 0.01);
  near(s.bg.padX, 28 * 2.34375, 0.01, "the pill padding scales too");
  // A thumbnail title at 220 px...
  resize(store, 1280, 720);
  kit.rememberText(createLayer("text", { text: "IS THIS A SCAM", size: 220, stroke: { on: true, color: "#000000", width: 16 } }));
  s = kit.textStyle();
  assert.equal(s.size, 220, "same canvas, same size");
  assert.equal(s.stroke.width, 16);
  // ...is 17% of the width on a Spotify cover too.
  resize(store, 3000, 3000);
  s = kit.textStyle();
  assert.equal(s.size, Math.round(220 * 2.34375));
  near(s.stroke.width, 16 * 2.34375, 0.01);
  // And the other way round: a cover title comes back thumbnail sized.
  kit.rememberText(createLayer("text", { text: "COVER", size: 300 }));
  assert.equal(ctx.prefs.get("lastTextStyle").docScale, 2.34375);
  resize(store, 1280, 720);
  assert.equal(kit.textStyle().size, 128);
  dispose();
});

Deno.test("touching remembered text on another canvas rewrites only the scale", () => {
  const { ctx, store, dispose } = setup();
  const kit = createKit(ctx, ctx.editor);
  const t = createLayer("text", { text: "A", size: 150 });
  kit.rememberText(t);
  assert.equal(ctx.prefs.get("lastTextStyle").docScale, undefined, "1280 needs no scale");
  resize(store, 2560, 1440);
  kit.rememberText(t);
  assert.equal(ctx.prefs.get("lastTextStyle").docScale, 2, "same style, other canvas");
  dispose();
});

Deno.test("tool widths scale with the canvas and round-trip without rewriting prefs", () => {
  const { ctx, store, api, tool, dispose } = setup();
  const kit = createKit(ctx, ctx.editor);
  resize(store, 3000, 3000);
  near(kit.style("circle").width, 28.1, 1e-9);
  near(kit.style("arrow").width, 32.8, 1e-9);
  near(kit.style("pen").width, 23.4, 1e-9);
  // Saving back what style() gave is not a change.
  kit.saveStyle("circle", { width: 28.1 });
  assert.equal(ctx.prefs.get("toolColors", undefined), undefined);
  // A click with the highlight circle: ring and box in proportion.
  const t = tool("circle");
  t.pointerDown(ev(1500, 1500), api);
  t.pointerUp(ev(1500, 1500, { buttons: 0 }), api);
  let l = store.layers()[0];
  assert.equal(l.stroke.width, 28.1);
  assert.deepEqual([l.w, l.h], [Math.round(360 * 2.34375), Math.round(220 * 2.34375)]);
  assert.equal(ctx.prefs.get("toolColors", undefined), undefined, "the commit did not rewrite prefs");
  // A width set on the cover is remembered with its scale.
  store.patch(l.id, { stroke: { width: 30 } });
  assert.deepEqual(ctx.prefs.get("toolColors").circle, { color: "#ff2d2d", width: 30, docScale: 2.34375 });
  assert.equal(kit.style("circle").width, 30);
  resize(store, 1280, 720);
  near(kit.style("circle").width, 12.8, 1e-9);
  resize(store, 300, 300);
  near(kit.style("arrow").width, 3.5, 1e-9, "watermark");
  dispose();
});

Deno.test("pen [ and ] work in doc px on the canvas, and the pill leaves with the pen", () => {
  const { ctx, store, api, tool, dispose } = setup();
  resize(store, 3000, 3000);
  const t = tool("pen");
  assert.equal(t.keyDown({ key: "]" }, api), true);
  const w = Math.round(23.4 * 1.25 + 1);
  assert.equal(api.status, `Pen width ${w}`);
  assert.equal(createKit(ctx, ctx.editor).style("pen").width, w);
  t.deactivate(api);
  assert.equal(api.status, null, "no 'Pen width' pill left in the next tool");
  dispose();
});

// ---- cancelled pointers ------------------------------------------------------------------

Deno.test("a cancelled press (pinch, OS gesture) leaves nothing behind in any creation tool", () => {
  const { store, api, tool, edits, dispose } = setup();
  for (const id of ["rect", "ellipse", "circle", "arrow", "pen", "text"]) {
    const t = tool(id);
    t.pointerDown(ev(400, 300, { pointerType: "touch" }), api);
    t.pointerUp({ ...ev(400, 300, { pointerType: "touch", buttons: 0 }), type: "pointercancel" }, api);
    assert.equal(store.layers().length, 0, `${id} left a layer`);
    assert.equal(store.inGesture, false, `${id} left a gesture open`);
    assert.equal(store.canUndo, false, `${id} left an undo step`);
    t.deactivate?.(api);
  }
  assert.deepEqual(edits, [], "no text editor opened");
  // After a drag too, and through the tools' cancel().
  const r = tool("rect");
  r.pointerDown(ev(10, 10), api);
  r.pointerMove(ev(200, 200), api);
  r.cancel(api);
  const p = tool("pen");
  p.pointerDown(ev(10, 10), api);
  p.pointerMove(ev(80, 40), api);
  p.cancel(api);
  assert.equal(store.layers().length, 0);
  assert.equal(store.canUndo, false);
  p.deactivate(api);
  dispose();
});

// ---- sloppy clicks -----------------------------------------------------------------------

Deno.test("a slipped click makes default-sized shapes and arrows, not specks", () => {
  const { store, api, tool, dispose } = setup();
  const c = tool("circle");
  c.pointerDown(ev(640, 360), api);
  c.pointerMove(ev(644, 361), api);
  assert.equal(store.layers().length, 1, "the drag had started");
  c.pointerUp(ev(644, 361, { buttons: 0 }), api);
  let l = store.layers()[0];
  assert.deepEqual([l.x, l.y, l.w, l.h], [640, 360, 360, 220]);
  assert.equal(store.historyLabels().undo, "Add circle");
  const a = tool("arrow");
  a.pointerDown(ev(300, 300), api);
  a.pointerMove(ev(305, 300), api);
  a.pointerUp(ev(305, 300, { buttons: 0 }), api);
  const p = arrowPoints(store.layers()[1]);
  near(Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y), 260, 1e-2);
  near((p.a.x + p.b.x) / 2, 300, 1e-2);
  store.undo();
  assert.equal(store.layers().length, 1, "still one step");
  // Zoomed in, the same few doc px are a real drag.
  api.zoom = 4;
  const r = tool("rect");
  dragWith(r, api, [100, 100], [104, 104]);
  l = store.layers()[1];
  assert.deepEqual([l.w, l.h], [4, 4]);
  dispose();
});

Deno.test("a narrow text drag is a click, not a box one letter wide", () => {
  const { ctx, store, api, tool, dispose } = setup();
  dragWith(tool("text"), api, [300, 200], [340, 200]);
  const l = store.layers()[0];
  assert.equal(l.wrap, "auto");
  assert.equal(l.x, 300);
  const kit = createKit(ctx, ctx.editor);
  assert.equal(bigEnoughBox(kit, { w: 179 }, 1), false, "under 1.5 em of 120 px text");
  assert.equal(bigEnoughBox(kit, { w: 200 }, 1), true);
  assert.equal(bigEnoughBox(kit, { w: 200 }, 0.05), false, "10 screen px");
  dispose();
});

// ---- add text in view ----------------------------------------------------------------------

Deno.test("Add text lands in view when the canvas centre is scrolled away", () => {
  const { ctx, store, edits, dispose } = setup();
  const kit = createKit(ctx, ctx.editor);
  assert.deepEqual(insertPoint(kit), { x: 640, y: 360 }, "no viewport: the centre");
  ctx.editor.getViewport = () => ({ zoom: 0.5, panX: 100, panY: 50, width: 1000, height: 600 });
  assert.deepEqual(insertPoint(kit), { x: 640, y: 360 }, "centre on screen: the centre");
  // 300% on the top-left corner.
  ctx.editor.getViewport = () => ({ zoom: 3, panX: 0, panY: 0, width: 900, height: 600 });
  assert.deepEqual(insertPoint(kit), { x: 150, y: 100 });
  ctx.commands.run("insert.text");
  const l = store.layers()[0];
  assert.deepEqual([l.x, l.y], [150, 100]);
  assert.deepEqual(edits, [l.id]);
  // Panned past the canvas edge: clamped onto the canvas.
  ctx.editor.getViewport = () => ({ zoom: 2, panX: -2400, panY: 0, width: 400, height: 300 });
  assert.deepEqual(insertPoint(kit), { x: 1280, y: 75 });
  dispose();
});

// ---- undo while a mask is saving -----------------------------------------------------------

Deno.test("undo pressed while a brush is saving waits for the brush's step", async () => {
  const { ctx, store, dispose } = setup();
  const kit = createKit(ctx, ctx.editor);
  const mod = { ctrlKey: true, metaKey: true, shiftKey: false, altKey: false };
  assert.equal(kit.historyKey({ ...mod, key: "z" }), "undo");
  assert.equal(kit.historyKey({ ...mod, key: "Z", shiftKey: true }), "redo");
  assert.equal(kit.historyKey({ ...mod, key: "y" }), "redo");
  assert.equal(kit.historyKey({ key: "z", ctrlKey: false, metaKey: false }), null);
  store.add([createLayer("shape", {})], { label: "Add shape" });
  let release;
  const pending = new Promise((r) => (release = r));
  kit.afterPending(pending, "undo");
  await wait(5);
  assert.equal(store.layers().length, 1, "nothing undone yet");
  const img = createLayer("image", { asset: "ast_x" });
  store.add([img], { label: "Magic eraser" });
  release();
  await wait(5);
  assert.equal(store.layers().length, 1, "the brush's own step was undone");
  assert.equal(store.layers()[0].type, "shape");
  dispose();
});
