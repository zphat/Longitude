// Tests for the crop maths in web/js/editor/crop.js
//   deno test --allow-read tests/editor-crop.test.js

import assert from "node:assert/strict";
import { createLayer } from "../web/js/core/model.js";
import { fromLocal } from "../web/js/core/geometry.js";
import { cropFrames, cropResult, panImage, scaleImage, resizeFrame } from "../web/js/editor/crop.js";

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

const image = (props = {}) => createLayer("image", { x: 400, y: 300, w: 400, h: 200, natW: 1600, natH: 800, ...props });

Deno.test("cropFrames and cropResult round trip", () => {
  for (const props of [{}, { crop: { x: 0.2, y: 0.1, w: 0.5, h: 0.6 } }, { rotation: 35, flipX: true, crop: { x: 0.1, y: 0.3, w: 0.4, h: 0.5 } }]) {
    const l = image(props);
    const { F, I } = cropFrames(l);
    const r = cropResult(l, F, I);
    near(r.x, l.x);
    near(r.y, l.y);
    near(r.w, l.w);
    near(r.h, l.h);
    for (const k of ["x", "y", "w", "h"]) near(r.crop[k], l.crop[k]);
  }
});

Deno.test("panImage keeps the picture over the frame", () => {
  const l = image({ crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } });
  const { F, I } = cropFrames(l);
  const moved = panImage(F, I, 50, 0);
  near(moved.l, I.l + 50);
  const far = panImage(F, I, 5000, -5000);
  near(far.l, F.l);
  near(far.t + far.h, F.b);
  const r = cropResult(l, F, far);
  near(r.crop.x, 0);
  near(r.crop.y, 0.5);
});

Deno.test("panning a rotated, flipped picture keeps the box where it is", () => {
  const l = image({ rotation: 60, flipY: true, crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } });
  const { F, I } = cropFrames(l);
  const r = cropResult(l, F, panImage(F, I, -30, 20));
  near(r.x, l.x);
  near(r.y, l.y);
  near(r.crop.x, 0.25 + 30 / I.w);
  near(r.crop.y, 0.25 - 20 / I.h);
});

Deno.test("scaleImage grows around the opposite corner and keeps covering the frame", () => {
  const l = image({ crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } });
  const { F, I } = cropFrames(l);
  const big = scaleImage(F, I, 1, 1, { x: I.l + I.w * 1.5, y: I.t + I.h * 1.5 });
  near(big.w, I.w * 1.5);
  near(big.l, I.l);
  near(big.w / big.h, I.w / I.h);
  const small = scaleImage(F, I, 1, 1, { x: I.l, y: I.t });
  assert.ok(small.l <= F.l + 1e-9 && small.l + small.w >= F.r - 1e-9);
  assert.ok(small.t <= F.t + 1e-9 && small.t + small.h >= F.b - 1e-9);
});

Deno.test("resizeFrame stays inside the picture with a minimum size", () => {
  const l = image({ crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } });
  const { F, I } = cropFrames(l);
  const wide = resizeFrame(F, I, 1, 0, { x: 99999, y: 0 });
  near(wide.r, I.l + I.w);
  const tiny = resizeFrame(F, I, -1, -1, { x: 99999, y: 99999 }, { minSize: 8 });
  near(tiny.r - tiny.l, 8);
  near(tiny.b - tiny.t, 8);
  const aspect = resizeFrame(F, I, 1, 1, { x: F.r + 100, y: F.b + 10 }, { keepAspect: true });
  near((aspect.r - aspect.l) / (aspect.b - aspect.t), (F.r - F.l) / (F.b - F.t));
});

Deno.test("cropResult moves the box centre with the frame in a rotated layer", () => {
  const l = image({ rotation: 90 });
  const { F, I } = cropFrames(l);
  const next = { ...F, r: F.r - 100 };
  const r = cropResult(l, next, I);
  const expect = fromLocal(l, { x: (next.l + next.r) / 2, y: 0 });
  near(r.x, expect.x);
  near(r.y, expect.y);
  near(r.crop.w, 0.75);
});
