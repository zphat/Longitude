// Fitting an image layer's box to its cutout: web/js/features/bgremove/trim.js
// and the trim / restore flow in index.js.
// Run: deno test --allow-read tests/bgremove-trim.test.js
import { canTrim, cutoutCrop, fitProps, MARGIN, opaqueBounds, recrop, sameCrop, unionCrop } from "../web/js/features/bgremove/trim.js";
import { createBgService } from "../web/js/features/bgremove/index.js";
import { fromLocal } from "../web/js/core/geometry.js";
import { createDoc, createLayer } from "../web/js/core/model.js";
import { Store } from "../web/js/core/store.js";

function assert(value, message = "assertion failed") {
  if (!value) throw Error(message);
}

function near(a, b, eps = 1e-9, message = "") {
  if (!(Math.abs(a - b) <= eps)) throw Error(`${message} expected ${b} ± ${eps}, got ${a}`);
}

function eq(a, b, msg = "") {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg} expected ${sb}, got ${sa}`);
}

// Where natural-image point (u, v) (fractions) lands in the doc for a layer.
function docPoint(layer, u, v) {
  const c = layer.crop;
  return fromLocal(layer, { x: ((u - c.x) / c.w - 0.5) * layer.w, y: ((v - c.y) / c.h - 0.5) * layer.h });
}

// Alpha (one byte per pixel) with a solid rectangle [l, r) x [t, b).
function rectAlpha(w, h, l, t, r, b, value = 255) {
  const data = new Uint8ClampedArray(w * h);
  for (let y = t; y < b; y++) for (let x = l; x < r; x++) data[y * w + x] = value;
  return data;
}

function rgbaOf(alpha) {
  const out = new Uint8ClampedArray(alpha.length * 4);
  for (let i = 0; i < alpha.length; i++) out[i * 4 + 3] = alpha[i];
  return out;
}

// ---- pure helpers ---------------------------------------------------------------

Deno.test("opaqueBounds: tight box of the pixels above the threshold", () => {
  const a = rectAlpha(20, 10, 3, 2, 9, 7);
  eq(opaqueBounds(a, 20, 10), { l: 3, t: 2, r: 9, b: 7 });
  eq(opaqueBounds(rgbaOf(a), 20, 10, { stride: 4 }), { l: 3, t: 2, r: 9, b: 7 }, "RGBA");
  a[0] = 8; // at the threshold: not part of the cutout
  eq(opaqueBounds(a, 20, 10), { l: 3, t: 2, r: 9, b: 7 });
  a[19 * 1 + 9 * 20] = 9; // bottom-right pixel, just above it
  eq(opaqueBounds(a, 20, 10), { l: 3, t: 2, r: 20, b: 10 });
  eq(opaqueBounds(new Uint8ClampedArray(200), 20, 10), null, "nothing opaque");
  eq(opaqueBounds(new Uint8ClampedArray(3), 20, 10), null, "short data");
});

Deno.test("cutoutCrop: bounds plus the margin, inside the container", () => {
  const pad = Math.ceil(MARGIN * 200) / 200;
  const c = cutoutCrop({ l: 50, t: 20, r: 100, b: 100 }, 200, 100);
  near(c.x, 0.25 - pad);
  near(c.x + c.w, 0.5 + pad);
  near(c.y, 0.2 - pad * 2);
  near(c.y + c.h, 1, 1e-12, "clipped at the photo's edge");
  const inside = cutoutCrop({ l: 50, t: 20, r: 100, b: 100 }, 200, 100, { x: 0.3, y: 0, w: 0.5, h: 1 });
  near(inside.x, 0.3, 1e-12, "never past the user's crop");
  eq(cutoutCrop({ l: 0, t: 0, r: 10, b: 10 }, 200, 100, { x: 0.5, y: 0, w: 0.5, h: 1 }), null, "subject outside the crop");
  eq(cutoutCrop(null, 200, 100), null);
});

Deno.test("recrop keeps every visible pixel in place, rotated and flipped", () => {
  for (const flips of [[false, false], [true, false], [false, true], [true, true]]) {
    const layer = { type: "image", x: 640, y: 360, w: 800, h: 500, rotation: 30, flipX: flips[0], flipY: flips[1], crop: { x: 0.1, y: 0.2, w: 0.8, h: 0.7 } };
    const crop = { x: 0.3, y: 0.25, w: 0.35, h: 0.5 };
    const next = { ...layer, ...recrop(layer, crop) };
    near(next.w / crop.w, layer.w / layer.crop.w, 1e-9, "same scale");
    for (const [u, v] of [[0.3, 0.25], [0.65, 0.75], [0.5, 0.5], [0.4, 0.7]]) {
      const a = docPoint(layer, u, v);
      const b = docPoint(next, u, v);
      near(b.x, a.x, 1e-6, `x of ${u},${v} flips ${flips}`);
      near(b.y, a.y, 1e-6, `y of ${u},${v} flips ${flips}`);
    }
    const back = { ...next, ...recrop(next, layer.crop) };
    for (const k of ["x", "y", "w", "h"]) near(back[k], layer[k], 1e-6, `round trip ${k}`);
  }
});

Deno.test("fitProps ignores changes too small to see; canTrim guards the frame", () => {
  const layer = { type: "image", x: 640, y: 360, w: 1280, h: 720, rotation: 0, crop: { x: 0, y: 0, w: 1, h: 1 }, frame: "rect", radius: 0, filters: [] };
  eq(fitProps(layer, { x: 0.0005, y: 0, w: 0.999, h: 1 }), null, "under 1.5 doc px");
  assert(fitProps(layer, { x: 0.01, y: 0, w: 0.98, h: 1 }), "about 13 px is a change");
  eq(fitProps(layer, null), null);
  assert(canTrim(layer));
  assert(!canTrim({ ...layer, frame: "ellipse" }), "ellipse");
  assert(!canTrim({ ...layer, radius: 12 }), "rounded corners");
  assert(!canTrim({ ...layer, filters: [{ id: "x", params: {} }] }), "mod filters");
  assert(!canTrim({ ...layer, type: "shape" }));
  eq(unionCrop({ x: 0.2, y: 0.1, w: 0.3, h: 0.3 }, { x: 0.4, y: 0, w: 0.5, h: 0.2 }), { x: 0.2, y: 0, w: 0.7, h: 0.4 });
  assert(sameCrop(null, { x: 0, y: 0, w: 1, h: 1 }));
});

// ---- the service flow --------------------------------------------------------------

const MW = 200;
const MH = 100;

// A canvas-like mask: alpha from rectAlpha, read through getContext("2d").
function fakeMask(alpha) {
  const data = rgbaOf(alpha);
  return { width: MW, height: MH, getContext: () => ({ getImageData: () => ({ width: MW, height: MH, data }) }) };
}

function setup({ layerProps = {}, mask = rectAlpha(MW, MH, 20, 20, 60, 100) } = {}) {
  const store = new Store(createDoc({ width: 1280, height: 720 }));
  const [id] = store.add(createLayer("image", { asset: "ast_photo", natW: MW, natH: MH, x: 640, y: 360, w: 1280, h: 640, ...layerProps }));
  const maskCanvas = fakeMask(mask);
  const images = new Map([["ast_photo", { width: MW, height: MH }], ["ast_mask", maskCanvas]]);
  const ctx = {
    store,
    emit() {},
    assets: {
      loadImage: async (aid) => images.get(aid),
      getImage: (aid) => images.get(aid) || null,
      addCanvas: async () => "ast_mask",
    },
  };
  const bg = createBgService(ctx);
  bg.providers.register({ id: "test", label: "Test", run: async () => maskCanvas });
  return { store, id, bg, ctx, layer: () => store.get(id) };
}

Deno.test("remove background fits the box to the person in the same undo step", async () => {
  const { store, id, bg, layer } = setup();
  const before = layer();
  await bg.removeLayerBackground(id, { provider: "test" });
  const after = layer();
  eq(after.mask, "ast_mask");
  eq(store.historyLabels().undo, "Remove background");
  const pad = Math.ceil(MARGIN * MW);
  near(after.crop.x, (20 - pad) / MW);
  near(after.crop.x + after.crop.w, (60 + pad) / MW);
  near(after.crop.y, (20 - pad) / MH);
  near(after.crop.y + after.crop.h, 1, 1e-12);
  // The person (columns 20..60 of 200) sits left of centre, and so does the box.
  near(after.x, (((20 - pad) + (60 + pad)) / 2 / MW) * 1280, 1e-6);
  assert(after.x < 400 && after.w < 400, "the box follows the person, not the photo");
  for (const [u, v] of [[0.1, 0.2], [0.3, 0.99]]) {
    const a = docPoint(before, u, v);
    const b = docPoint(after, u, v);
    near(b.x, a.x, 1e-6);
    near(b.y, a.y, 1e-6);
  }
  store.undo();
  eq(layer().crop, before.crop, "undo puts the photo frame back");
  eq(layer().mask, null);
  store.redo();
  eq(layer().crop, after.crop);
});

Deno.test("restore original puts the whole photo back where it was", async () => {
  const { store, id, bg, layer } = setup({ layerProps: { rotation: 15, flipX: true } });
  const before = layer();
  await bg.removeLayerBackground(id, { provider: "test" });
  store.patch(id, { x: layer().x + 100, y: layer().y - 40 }, { label: "Move" });
  assert(bg.restoreLayer(id));
  const back = layer();
  eq(store.historyLabels().undo, "Restore original");
  eq(back.mask, null);
  eq(back.crop, before.crop);
  near(back.w, before.w, 1e-6);
  near(back.h, before.h, 1e-6);
  near(back.x, before.x + 100, 1e-6, "keeps the move");
  near(back.y, before.y - 40, 1e-6);
  store.undo();
  assert(layer().mask, "undo brings the cutout back");
  assert(bg.restoreLayer(id), "and restore works again");
  eq(layer().crop, before.crop);
});

Deno.test("restore keeps a crop the user chose after the trim", async () => {
  const { store, id, bg, layer } = setup();
  await bg.removeLayerBackground(id, { provider: "test" });
  const trimmed = layer();
  const crop = { x: trimmed.crop.x + 0.02, y: trimmed.crop.y, w: trimmed.crop.w - 0.02, h: trimmed.crop.h };
  store.patch(id, { crop, w: trimmed.w * (crop.w / trimmed.crop.w) }, { label: "Crop" });
  bg.restoreLayer(id);
  eq(layer().mask, null);
  eq(layer().crop, crop, "only the mask goes");
});

Deno.test("after a reload, a trim of the whole photo is still recognised", async () => {
  const first = setup();
  await first.bg.removeLayerBackground(first.id, { provider: "test" });
  const trimmed = first.layer();
  // A new service has no records from the last session.
  const bg2 = createBgService(first.ctx);
  assert(bg2.untrimProps(first.id), "recognised from the mask");
  bg2.restoreLayer(first.id);
  eq(first.layer().crop, { x: 0, y: 0, w: 1, h: 1 });
  near(first.layer().x, 640, 1e-6);
  near(first.layer().w, 1280, 1e-6);
  assert(trimmed.w < 1280);
});

Deno.test("running removal again fits within the original photo, also after a reload", async () => {
  const { store, id, ctx, layer, bg } = setup();
  await bg.removeLayerBackground(id, { provider: "test" });
  const narrow = layer();
  const wider = fakeMask(rectAlpha(MW, MH, 20, 20, 120, 100));
  for (const service of [bg, createBgService(ctx)]) {
    store.patch(id, { ...narrow }, { label: "Back to the first cutout" });
    service.providers.register({ id: "better", label: "Better", run: async () => wider });
    await service.removeLayerBackground(id, { provider: "better" });
    const pad = Math.ceil(MARGIN * MW);
    near(layer().crop.x + layer().crop.w, (120 + pad) / MW, 1e-9, "grew past the first trim");
    near(layer().crop.x, narrow.crop.x, 1e-9);
  }
});

Deno.test("frames that depend on the box are not trimmed; fitToCutout trims older masks", async () => {
  const ellipse = setup({ layerProps: { frame: "ellipse" } });
  await ellipse.bg.removeLayerBackground(ellipse.id, { provider: "test" });
  eq(ellipse.layer().crop, { x: 0, y: 0, w: 1, h: 1 }, "ellipse keeps its box");
  eq(ellipse.layer().mask, "ast_mask");

  const old = setup({ layerProps: { mask: "ast_mask" } });
  eq(old.bg.untrimProps(old.id), null, "an untrimmed mask is not mistaken for a trim");
  assert(await old.bg.fitToCutout(old.id));
  eq(old.store.historyLabels().undo, "Fit box to cutout");
  assert(old.layer().w < 1280);
  eq(await old.bg.fitToCutout(old.id), false, "already fitted");
  old.bg.restoreLayer(old.id);
  eq(old.layer().crop, { x: 0, y: 0, w: 1, h: 1 });
});

Deno.test("an empty or full mask leaves the box alone", async () => {
  const empty = setup({ mask: new Uint8ClampedArray(MW * MH) });
  await empty.bg.removeLayerBackground(empty.id, { provider: "test" });
  eq(empty.layer().crop, { x: 0, y: 0, w: 1, h: 1 });
  const full = setup({ mask: new Uint8ClampedArray(MW * MH).fill(255) });
  await full.bg.removeLayerBackground(full.id, { provider: "test" });
  eq(full.layer().crop, { x: 0, y: 0, w: 1, h: 1 });
  near(full.layer().w, 1280);
});
