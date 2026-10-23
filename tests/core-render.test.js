// Smoke tests for web/js/core/render.js and effects.js against a recording
// fake 2D canvas (Deno has no real one). They check that every layer type and
// effect renders without errors, that the composite cache hits and misses
// when it should, and how layers are placed. Pixels are checked in a browser.
//   deno test --allow-read tests/core-render.test.js

import assert from "node:assert/strict";

// ---- fake canvas ------------------------------------------------------------

const stats = { paints: 0, draws: [], texts: 0 };

class FakeCtx {
  constructor(canvas) {
    this.canvas = canvas;
    this.m = [1, 0, 0, 1, 0, 0];
    this.stack = [];
    this.filter = "none";
    this.letterSpacing = "0px";
    this.textRendering = "auto";
    this.font = "10px sans-serif";
    this.globalAlpha = 1;
    this.globalCompositeOperation = "source-over";
    this.imageSmoothingQuality = "low";
  }
  save() {
    this.stack.push({ m: [...this.m], filter: this.filter, globalAlpha: this.globalAlpha, op: this.globalCompositeOperation, ls: this.letterSpacing });
  }
  restore() {
    const s = this.stack.pop();
    if (!s) return;
    this.m = s.m;
    this.filter = s.filter;
    this.globalAlpha = s.globalAlpha;
    this.globalCompositeOperation = s.op;
    this.letterSpacing = s.ls;
  }
  setTransform(a, b, c, d, e, f) {
    this.m = [a, b, c, d, e, f];
  }
  getTransform() {
    const [a, b, c, d, e, f] = this.m;
    return { a, b, c, d, e, f };
  }
  transform(a, b, c, d, e, f) {
    const [A, B, C, D, E, F] = this.m;
    this.m = [A * a + C * b, B * a + D * b, A * c + C * d, B * c + D * d, A * e + C * f + E, B * e + D * f + F];
  }
  translate(x, y) {
    this.transform(1, 0, 0, 1, x, y);
  }
  scale(x, y) {
    this.transform(x, 0, 0, y, 0, 0);
  }
  rotate(r) {
    this.transform(Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0);
  }
  drawImage(img, ...args) {
    if (!img || !(img.width >= 0)) throw TypeError("drawImage needs an image");
    stats.draws.push({ target: this.canvas, img, args, m: [...this.m], alpha: this.globalAlpha, op: this.globalCompositeOperation });
  }
  measureText(s) {
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1]) || 10;
    const ls = parseFloat(this.letterSpacing) || 0;
    const n = [...s].length;
    return { width: n * size * 0.5 + n * ls, actualBoundingBoxAscent: size * 0.7, actualBoundingBoxDescent: size * 0.1, fontBoundingBoxAscent: size * 0.9, fontBoundingBoxDescent: size * 0.25 };
  }
  fillText() {
    stats.texts++;
  }
  strokeText() {
    stats.texts++;
  }
  getImageData(x, y, w, h) {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  }
  createLinearGradient() {
    return { addColorStop() {} };
  }
  isPointInPath() {
    return false;
  }
  isPointInStroke() {
    return false;
  }
}
for (const name of ["clearRect", "fillRect", "rect", "beginPath", "moveTo", "lineTo", "arc", "arcTo", "ellipse", "quadraticCurveTo", "closePath", "clip", "fill", "stroke", "putImageData", "setLineDash", "roundRect"]) {
  FakeCtx.prototype[name] = function () {};
}

class FakeCanvas {
  constructor(w = 300, h = 150) {
    this.width = w;
    this.height = h;
  }
  getContext() {
    this._ctx ||= new FakeCtx(this);
    return this._ctx;
  }
  async convertToBlob({ type = "image/png" } = {}) {
    return new Blob([new Uint8Array([1, 2, 3])], { type });
  }
}

class FakePath {}
for (const name of ["moveTo", "lineTo", "arc", "arcTo", "ellipse", "closePath", "rect", "roundRect", "quadraticCurveTo"]) FakePath.prototype[name] = function () {};

globalThis.OffscreenCanvas = FakeCanvas;
globalThis.Path2D = FakePath;

const { renderDoc, createRenderCache, renderToCanvas, renderThumb, renderLayerThumb, freehandSpine } = await import("../web/js/core/render.js");
const fx = await import("../web/js/core/effects.js");
const { createDoc, createLayer } = await import("../web/js/core/model.js");

// ---- helpers ------------------------------------------------------------------

function fakeAssets(ready = true) {
  const img = { width: 400, height: 300 };
  const mask = { width: 400, height: 300 };
  const target = new EventTarget();
  target.ready = ready;
  target.getImage = (id) => (target.ready ? (id === "ast_mask" ? mask : img) : null);
  target.loadImage = async (id) => (id === "ast_mask" ? mask : img);
  return target;
}

function everything() {
  const doc = createDoc();
  const fxOn = { shadow: { on: true }, glow: { on: true } };
  doc.layers.push(
    createLayer("image", { asset: "ast_img", mask: "ast_mask", natW: 400, natH: 300, frame: "ellipse", outline: { on: true }, adjust: { brightness: 20, warmth: 30, blur: 10 }, filters: [{ id: "grain", params: {} }, { id: "duotone", params: {} }], ...fxOn }),
    createLayer("image", { asset: "ast_img", radius: 20, crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, blend: "multiply", opacity: 0.5 }),
    createLayer("text", { text: "WAIT\nWHAT", rotation: 12, stroke2: { on: true }, bg: { on: true }, gradient: { on: true }, letterSpacing: 50, ...fxOn }),
    createLayer("text", { text: "", italic: true, wrap: "fixed", w: 300 }),
    ...["rect", "ellipse", "triangle", "star", "burst", "bubble", "missing.shape"].map((shape, i) =>
      createLayer("shape", { shape, x: 100 + i * 50, radius: 12, stroke: { on: true, dash: i % 2 === 0 }, flipX: i % 2 === 1 }),
    ),
    createLayer("path", { points: Array.from({ length: 40 }, (_, i) => [i / 39, 0.5 + Math.sin(i / 5) * 0.4, (i % 10) / 10]), w: 300, h: 100, ...fxOn }),
    createLayer("path", { points: [[0.5, 0.5, 0.5]] }),
    createLayer("arrow", { c: [0.5, 0.1], tail: "dot" }),
    createLayer("arrow", { head: "line", tail: "triangle", sketch: true, flipY: true }),
    createLayer("arrow", { head: "triangle", tail: "line", sketch: true, rotation: -30, ...fxOn }),
    createLayer("shape", { hidden: true }),
  );
  return doc;
}

const screen = (w = 1600, h = 900) => {
  const c = new FakeCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.setTransform(1.5, 0, 0, 1.5, 40, 30);
  return { c, ctx };
};

// ---- tests --------------------------------------------------------------------

Deno.test("renderDoc: every layer type and effect renders without errors", () => {
  const { ctx, c } = screen();
  const doc = everything();
  const errors = [];
  const original = console.error;
  console.error = (e) => errors.push(e);
  let onScreen;
  try {
    stats.draws.length = 0;
    renderDoc(ctx, doc, { scale: 0.5, assets: fakeAssets(), cache: createRenderCache() });
    onScreen = stats.draws.filter((d) => d.target === c);
    assert.equal(onScreen.length, doc.layers.length - 1, "one placement per visible layer");
    stats.draws.length = 0;
    renderDoc(ctx, doc, { scale: 2, assets: fakeAssets() });
    const zoomed = stats.draws.filter((d) => d.target === c);
    assert.ok(zoomed.length < onScreen.length && zoomed.length > 0, "layers entirely off the canvas are skipped");
    onScreen = onScreen.concat(zoomed);
  } finally {
    console.error = original;
  }
  assert.deepEqual(errors, []);
  const multiply = onScreen.find((d) => d.op === "multiply");
  assert.ok(multiply && Math.abs(multiply.alpha - 0.5) < 1e-9, "blend and opacity applied at placement");
  for (const d of onScreen) {
    assert.deepEqual(d.m, [1, 0, 0, 1, 0, 0], "composites are placed in device pixels");
    assert.ok(Number.isInteger(d.args[0]) && Number.isInteger(d.args[1]), "on whole pixels");
  }
});

Deno.test("cache: moving or fading a layer reuses its composite; edits re-render", () => {
  const { ctx } = screen();
  const cache = createRenderCache();
  const assets = fakeAssets();
  let doc = createDoc();
  const t = createLayer("text", { text: "Hello", shadow: { on: true } });
  doc.layers.push(t);
  renderDoc(ctx, doc, { assets, cache });
  const first = cache.entries.get(t.id);
  assert.ok(first && first.complete);
  const canvas = first.canvas;
  const key = first.key;

  doc = { ...doc, layers: [{ ...t, x: t.x + 37, opacity: 0.4, blend: "screen" }] };
  renderDoc(ctx, doc, { assets, cache });
  assert.equal(cache.entries.get(t.id).key, key, "same composite after a move");
  assert.equal(cache.entries.get(t.id).canvas, canvas);

  doc = { ...doc, layers: [{ ...doc.layers[0], text: "Hello!" }] };
  renderDoc(ctx, doc, { assets, cache });
  assert.notEqual(cache.entries.get(t.id).key, key, "new text, new composite");

  renderDoc(ctx, doc, { assets, cache, scale: 2 });
  assert.equal(cache.entries.get(t.id).k, 3, "zoom renders at the new device scale");

  renderDoc(ctx, doc, { assets, cache, editingTextId: t.id });
  assert.equal(cache.entries.get(t.id).k, 3, "the layer being edited bypasses the cache");
});

Deno.test("cache: images drawn before decoding are redrawn once ready", () => {
  const { ctx } = screen();
  const cache = createRenderCache();
  const assets = fakeAssets(false);
  const doc = createDoc();
  const img = createLayer("image", { asset: "ast_img" });
  doc.layers.push(img);
  renderDoc(ctx, doc, { assets, cache });
  assert.equal(cache.entries.get(img.id).complete, false);
  assets.ready = true;
  assets.dispatchEvent(new CustomEvent("ready", { detail: { id: "ast_img" } }));
  assert.equal(cache.entries.has(img.id), false, "'ready' drops the placeholder composite");
  renderDoc(ctx, doc, { assets, cache });
  assert.equal(cache.entries.get(img.id).complete, true);
  cache.dispose();
});

Deno.test("renderDoc: skip, only, hidden and live mask overrides", () => {
  const { ctx, c } = screen();
  const doc = createDoc();
  const a = createLayer("shape");
  const b = createLayer("shape", { hidden: true });
  const m = createLayer("image", { asset: "ast_img", mask: "ast_mask" });
  doc.layers.push(a, b, m);
  const count = (opts) => {
    stats.draws.length = 0;
    renderDoc(ctx, doc, { assets: fakeAssets(), background: false, ...opts });
    return stats.draws.filter((d) => d.target === c).length;
  };
  assert.equal(count({}), 2);
  assert.equal(count({ skip: new Set([a.id]) }), 1);
  assert.equal(count({ only: [a.id, b.id] }), 1);
  const live = new FakeCanvas(400, 300);
  stats.draws.length = 0;
  const cache = createRenderCache();
  renderDoc(ctx, doc, { assets: fakeAssets(), cache, overrides: { masks: new Map([[m.id, live]]) } });
  assert.ok(stats.draws.some((d) => d.img === live), "the live mask is used");
  assert.equal(cache.entries.has(m.id), false, "and not cached");
});

Deno.test("renderDoc: a rotated outer transform still works", () => {
  const c = new FakeCanvas(800, 600);
  const ctx = c.getContext("2d");
  ctx.rotate(0.3);
  const doc = everything();
  renderDoc(ctx, doc, { assets: fakeAssets(), cache: createRenderCache() });
});

Deno.test("renderToCanvas and renderThumb", async () => {
  const doc = everything();
  const canvas = await renderToCanvas(doc, { scale: 2, assets: fakeAssets() });
  assert.equal(canvas.width, 2560);
  assert.equal(canvas.height, 1440);
  const fitted = await renderToCanvas(doc, { width: 640, assets: fakeAssets() });
  assert.equal(fitted.height, 360);
  const huge = await renderToCanvas(createDoc({ width: 8000, height: 8000 }), { scale: 4 });
  assert.ok(huge.width <= 16384 && huge.width * huge.height <= 268e6);
  const thumb = await renderThumb(doc, { assets: fakeAssets() });
  assert.equal(thumb.type, "image/webp");
});

Deno.test("renderLayerThumb fits the layer into the rect", () => {
  const c = new FakeCanvas(64, 64);
  const ctx = c.getContext("2d");
  stats.draws.length = 0;
  renderLayerThumb(ctx, createLayer("shape", { x: 900, y: 500, w: 400, h: 200 }), { x: 0, y: 0, w: 64, h: 64 });
  const d = stats.draws.find((x) => x.target === c);
  assert.ok(d, "drawn");
  assert.ok(d.args[0] >= -2 && d.args[0] <= 2, "starts at the left of the rect");
});

Deno.test("freehandSpine: smoothed, tapered, pressure-aware", () => {
  const layer = createLayer("path", { w: 200, h: 200, width: 10, points: Array.from({ length: 30 }, (_, i) => [0.1 + (i / 29) * 0.8, 0.5, i < 15 ? 0.2 : 0.9]) });
  const spine = freehandSpine(layer);
  assert.ok(spine.length > 30, "resampled");
  const mid = spine[Math.floor(spine.length / 2)].r;
  assert.ok(spine[0].r < mid && spine.at(-1).r < spine[Math.floor(spine.length * 0.8)].r, "ends taper");
  assert.ok(spine[Math.floor(spine.length * 0.8)].r > spine[Math.floor(spine.length * 0.2)].r, "more pressure, wider");
  assert.deepEqual(freehandSpine({ ...layer, points: [] }), []);
});

Deno.test("effects helpers", () => {
  assert.deepEqual(fx.parseColor("#abc"), { r: 170, g: 187, b: 204, a: 1 });
  assert.equal(fx.rgba("#ff000080", 0.5), "rgba(255, 0, 0, 0.251)");
  assert.equal(fx.adjustFilter({ brightness: 0, contrast: 0, saturation: 0, hue: 0, blur: 0 }), "none");
  assert.equal(fx.adjustFilter({ brightness: 100, hue: 30, blur: 10 }, 2), "brightness(1.700) hue-rotate(30deg) blur(4.00px)");
  assert.equal(fx.warmthTint({ warmth: 0 }), null);
  assert.equal(fx.warmthTint({ warmth: -50 }).color, "#3d8bff");
  const m = fx.adjustMatrix({ saturation: -100 });
  const img = { data: new Uint8ClampedArray([255, 0, 0, 255]) };
  fx.applyColorMatrix(img, m);
  assert.ok(Math.abs(img.data[0] - img.data[1]) <= 1 && Math.abs(img.data[1] - img.data[2]) <= 1, "fully desaturated is gray");
  const r1 = fx.mulberry32(fx.hashString("lyr_x"));
  const r2 = fx.mulberry32(fx.hashString("lyr_x"));
  assert.equal(r1(), r2(), "seeded randomness repeats");
  const out = fx.stickerOutline(new FakeCanvas(50, 50), 10, "#fff");
  assert.equal(out.width, 50);
});

Deno.test("cache: turning a shape or filter mod on or off redraws cached composites", async () => {
  const { shapes } = await import("../web/js/core/shapes.js");
  const { filters } = await import("../web/js/core/filters.js");
  const { ctx } = screen();
  const cache = createRenderCache();
  const assets = fakeAssets();
  let blobs = 0;
  const off = shapes.register({ id: "test.blob", label: "Blob", path: () => (blobs++, new FakePath()) });
  const doc = createDoc();
  const s = createLayer("shape", { shape: "test.blob" });
  const img = createLayer("image", { asset: "ast_img", filters: [{ id: "test.fry", params: {} }] });
  doc.layers.push(s, img);
  renderDoc(ctx, doc, { assets, cache });
  const first = cache.entries.get(s.id);
  renderDoc(ctx, doc, { assets, cache });
  assert.equal(cache.entries.get(s.id), first, "cached while nothing changes");
  assert.equal(blobs, 1);
  off();
  renderDoc(ctx, doc, { assets, cache });
  assert.notEqual(cache.entries.get(s.id), first, "redrawn once the shape is gone");
  assert.equal(blobs, 1, "with the fallback shape");

  const plain = cache.entries.get(img.id);
  assert.equal(cache.sources.has(img.id), false, "no pixel pass for an unknown filter");
  let fried = 0;
  const offFilter = filters.register({ id: "test.fry", label: "Fry", apply: (d) => (fried++, d) });
  renderDoc(ctx, doc, { assets, cache });
  assert.notEqual(cache.entries.get(img.id), plain, "redrawn once the filter is there");
  assert.equal(fried, 1);
  offFilter();
  cache.dispose();
});

Deno.test("export: the clip at the canvas edge leaves room for a sticker outline", () => {
  const c = new FakeCanvas(1280, 720);
  const ctx = c.getContext("2d");
  const doc = createDoc();
  const base = { asset: "ast_img", natW: 400, natH: 300, x: 100, y: 360, w: 400, h: 300 };
  const placeX = (layer) => {
    doc.layers = [layer];
    stats.draws.length = 0;
    renderDoc(ctx, doc, { assets: fakeAssets(), background: false });
    return stats.draws.filter((d) => d.target === c)[0].args[0];
  };
  assert.ok(placeX(createLayer("image", base)) >= -2, "plain images are clipped right at the edge");
  assert.ok(placeX(createLayer("image", { ...base, outline: { on: true, width: 40 } })) <= -40, "the silhouette just outside is drawn so its outline reaches in");
});

Deno.test("filters run on the same pixels in the editor and in the export", async () => {
  const big = { width: 3000, height: 2250 };
  const assets = new EventTarget();
  assets.getImage = () => big;
  assets.loadImage = async () => big;
  const doc = createDoc();
  const layer = createLayer("image", { asset: "ast_big", natW: 3000, natH: 2250, x: 640, y: 360, w: 1200, h: 900, filters: [{ id: "grain", params: { size: 1 } }] });
  doc.layers.push(layer);
  const { ctx } = screen();
  const cache = createRenderCache();
  renderDoc(ctx, doc, { assets, cache });
  const editor = cache.sources.get(layer.id).canvas;
  await renderToCanvas(doc, { assets });
  const exported = fx.scratchCanvas("r-source");
  assert.ok(editor.width >= 2400 && editor.width < 2900, `about two source px per doc px, not the view's 2048 cap (${editor.width})`);
  assert.deepEqual([exported.width, exported.height], [editor.width, editor.height]);
  const key = cache.sources.get(layer.id).key;
  renderDoc(ctx, { ...doc, layers: [{ ...layer, w: 1210, h: 907.5 }] }, { assets, cache });
  assert.equal(cache.sources.get(layer.id).key, key, "a small resize does not filter again");
  cache.dispose();
});
