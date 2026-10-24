// Tests for the refine cutout brush (web/js/editor/tools/refine.js) with a
// small in-memory canvas, so the save path (new mask asset + undo step) can be
// checked under Deno.
//   deno test --allow-read tests/draw-refine.test.js

import assert from "node:assert/strict";

// ---- a canvas that keeps RGBA bytes: just what the brush and mask.js use ----------

class FakeCanvas {
  constructor() {
    this.width = 1;
    this.height = 1;
    this._data = null;
    this._ctx = null;
  }
  get data() {
    const n = this.width * this.height * 4;
    if (!this._data || this._data.length !== n) this._data = new Uint8ClampedArray(n);
    return this._data;
  }
  getContext() {
    if (!this._ctx) this._ctx = fakeContext(this);
    return this._ctx;
  }
}

function fakeContext(c) {
  const copyRows = (src, sw, sx, sy, dst, dw, dx, dy, w, h) => {
    for (let j = 0; j < h; j++) dst.set(src.subarray(((sy + j) * sw + sx) * 4, ((sy + j) * sw + sx + w) * 4), ((dy + j) * dw + dx) * 4);
  };
  return {
    fillStyle: "#000000",
    globalCompositeOperation: "source-over",
    imageSmoothingQuality: "low",
    fillRect(x, y, w, h) {
      const d = c.data;
      for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) d.fill(255, (j * c.width + i) * 4, (j * c.width + i) * 4 + 4);
    },
    drawImage(src) {
      if (src instanceof FakeCanvas && src.width === c.width && src.height === c.height) c.data.set(src.data);
    },
    getImageData(x, y, w, h) {
      const out = new Uint8ClampedArray(w * h * 4);
      copyRows(c.data, c.width, x, y, out, w, 0, 0, w, h);
      return { width: w, height: h, data: out };
    },
    putImageData(img, x, y) {
      copyRows(img.data, img.width, 0, 0, c.data, c.width, x, y, img.width, img.height);
    },
    createImageData(w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
  };
}

globalThis.document = { createElement: () => new FakeCanvas() };

const { createRegistry, createCommands } = await import("../web/js/app/context.js");
const { Store } = await import("../web/js/core/store.js");
const { createLayer } = await import("../web/js/core/model.js");
const { registerDrawTools } = await import("../web/js/editor/tools/draw.js");
const { maskLib } = await import("../web/js/editor/tools/masklib.js");
// The tools load the mask helpers on first use; having them in the module
// map already keeps the short waits below deterministic.
await import("../web/js/features/bgremove/mask.js");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function setup({ slowSave = false } = {}) {
  const store = new Store();
  const shape = createLayer("shape", {});
  const img = createLayer("image", { asset: "ast_photo", x: 640, y: 360, w: 400, h: 300, natW: 64, natH: 48 });
  store.add([shape, img], { select: false });
  store.clearHistory();
  store.select([img.id]);
  const events = new EventTarget();
  const prefs = {};
  const added = [];
  let release = null;
  const loads = [];
  const ctx = {
    events,
    store,
    tools: createRegistry("tools"),
    prefs: { get: (k, f) => (k in prefs ? prefs[k] : f), set: (k, v) => (prefs[k] = v) },
    ui: { toast() {} },
    assets: {
      loadImage: async (id) => {
        loads.push(id);
        return { width: 64, height: 48 };
      },
      getBlob: async () => null,
      addCanvas: async (c) => {
        if (slowSave) await new Promise((r) => (release = r));
        added.push(c);
        return `ast_mask${added.length}`;
      },
    },
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
  const overrides = [];
  const editor = {
    tool: "refine",
    host: null,
    setTool(id) {
      this.tool = id;
    },
    setMaskOverride(id, c) {
      overrides.push(c);
    },
    requestRender() {},
  };
  ctx.editor = editor;
  const dispose = registerDrawTools(ctx, editor);
  const api = {
    ctx,
    editor,
    store,
    toDoc: (e) => ({ x: e.clientX, y: e.clientY }),
    toScreen: (p) => p,
    zoom: 1,
    overlay: null,
    requestRender() {},
    setCursor() {},
    setStatus() {},
    clearGuides() {},
  };
  const tool = ctx.tools.get("refine");
  return { ctx, store, img, prefs, added, loads, overrides, api, tool, dispose, release: () => release?.() };
}

const ev = (x, y, extra = {}) => ({ clientX: x, clientY: y, button: 0, buttons: 1, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, ...extra });

function dab(t, x, y, extra = {}) {
  t.tool.pointerDown(ev(x, y), t.api);
  t.tool.pointerUp({ ...ev(x, y, { buttons: 0 }), ...extra }, t.api);
}

Deno.test("the brush loads the mask helpers when it is picked, not at boot", async () => {
  const t = setup();
  assert.equal(maskLib(), null, "registering the tools loads nothing");
  t.tool.activate(t.api);
  await wait(5);
  assert.equal(typeof maskLib()?.paintMask, "function");
  t.tool.deactivate(t.api);
  t.dispose();
});

Deno.test("a refine dab that changes nothing stores no mask and no undo step", async () => {
  const t = setup();
  t.tool.activate(t.api);
  await wait(5);
  dab(t, 5, 5);
  await wait(5);
  assert.equal(t.added.length, 0, "outside the image");
  t.prefs.refineBrush = { size: 48, hardness: 0.6, mode: "restore" };
  dab(t, 640, 360);
  await wait(5);
  assert.equal(t.added.length, 0, "restoring on an image nothing was erased from");
  assert.equal(t.store.canUndo, false);
  assert.equal(t.store.get(t.img.id).mask, null);
  t.prefs.refineBrush = { size: 48, hardness: 0.6, mode: "erase" };
  dab(t, 640, 360);
  await wait(5);
  assert.equal(t.added.length, 1, "a real erase is saved");
  assert.equal(t.store.get(t.img.id).mask, "ast_mask1");
  assert.equal(t.store.historyLabels().undo, "Refine cutout");
  t.tool.deactivate(t.api);
  t.dispose();
});

Deno.test("a canceled refine stroke is taken back, not saved", async () => {
  const t = setup();
  t.tool.activate(t.api);
  await wait(5);
  const before = t.loads.length;
  dab(t, 640, 360, { type: "pointercancel" });
  await wait(5);
  assert.equal(t.added.length, 0);
  assert.equal(t.store.canUndo, false);
  assert.equal(t.overrides[t.overrides.length - 1], null, "the painted preview is dropped");
  assert.ok(t.loads.length > before, "the canvas is reloaded from the stored mask");
  t.tool.deactivate(t.api);
  t.dispose();
});

Deno.test("Ctrl+Z while a refine stroke is saving undoes that stroke, not the step before", async () => {
  const t = setup({ slowSave: true });
  t.store.add([createLayer("shape", {})], { label: "Add shape", select: false });
  t.store.select([t.img.id]);
  t.tool.activate(t.api);
  await wait(5);
  dab(t, 640, 360);
  await wait(5);
  assert.ok(t.tool.pending, "the save is visible to the toolbar undo");
  assert.equal(t.tool.keyDown({ key: "z", ctrlKey: true, metaKey: true, shiftKey: false, altKey: false }, t.api), true, "held back");
  assert.equal(t.store.layers().length, 3, "'Add shape' is not undone");
  t.release();
  await wait(10);
  assert.equal(t.store.layers().length, 3);
  assert.equal(t.store.get(t.img.id).mask, null, "the stroke was undone");
  assert.equal(t.store.historyLabels().redo, "Refine cutout");
  assert.equal(t.store.historyLabels().undo, "Add shape");
  assert.equal(t.tool.pending, null);
  t.tool.deactivate(t.api);
  t.dispose();
});
