// Tests for the view maths in web/js/editor/viewport.js
//   deno test --allow-read tests/editor-viewport.test.js

import assert from "node:assert/strict";
import { MIN_ZOOM, MAX_ZOOM, clampZoom, zoomAround, fitView, fitRectView, stepZoom, clampPan, wheelZoomFactor, freeArea, refitPlan } from "../web/js/editor/viewport.js";

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

Deno.test("clampZoom", () => {
  assert.equal(clampZoom(0), 1);
  assert.equal(clampZoom(1e-9), MIN_ZOOM);
  assert.equal(clampZoom(1e9), MAX_ZOOM);
  assert.equal(clampZoom(NaN), 1);
});

Deno.test("zoomAround keeps the anchored doc point still", () => {
  const view = { zoom: 0.5, panX: 100, panY: 40 };
  const anchor = { x: 420, y: 300 };
  const before = { x: (anchor.x - view.panX) / view.zoom, y: (anchor.y - view.panY) / view.zoom };
  const next = zoomAround(view, 2, anchor);
  near(next.panX + before.x * next.zoom, anchor.x);
  near(next.panY + before.y * next.zoom, anchor.y);
});

Deno.test("fitView centers the artboard in the free area", () => {
  const v = fitView(1280, 720, 1600, 1000, { left: 70, right: 300, top: 60, bottom: 70 }, { pad: 40 });
  const w = 1280 * v.zoom;
  const h = 720 * v.zoom;
  assert.ok(v.panX >= 70 + 39 && v.panX + w <= 1600 - 300 - 39);
  assert.ok(v.panY >= 60 + 39 && v.panY + h <= 1000 - 70 - 39);
  near(v.panX + w / 2, 70 + (1600 - 370) / 2);
});

Deno.test("fitView ignores insets that leave no room", () => {
  const v = fitView(1000, 1000, 500, 400, { left: 300, right: 300 });
  assert.ok(v.zoom > 0.2);
});

Deno.test("fitRectView frames a doc rect", () => {
  const v = fitRectView({ l: 100, t: 100, r: 300, b: 200 }, 1000, 800, {}, { pad: 0 });
  near(v.zoom, 5);
  near(v.panX + 200 * v.zoom, 500);
  near(v.panY + 150 * v.zoom, 400);
});

Deno.test("stepZoom walks the presets", () => {
  assert.equal(stepZoom(1, 1), 1.25);
  assert.equal(stepZoom(1, -1), 0.75);
  assert.equal(stepZoom(0.7, 1), 0.75);
  assert.equal(stepZoom(MAX_ZOOM, 1), MAX_ZOOM);
  assert.equal(stepZoom(MIN_ZOOM, -1), MIN_ZOOM);
});

Deno.test("clampPan keeps part of the artboard on screen", () => {
  const v = clampPan({ zoom: 1, panX: -5000, panY: 5000 }, 1280, 720, 1600, 900, 64);
  assert.equal(v.panX, 64 - 1280);
  assert.equal(v.panY, 900 - 64);
});

Deno.test("wheelZoomFactor: mouse notches step, pinches are smooth", () => {
  near(wheelZoomFactor({ deltaY: -100, deltaMode: 0 }), 1.2);
  near(wheelZoomFactor({ deltaY: 100, deltaMode: 0 }), 1 / 1.2);
  const pinch = wheelZoomFactor({ deltaY: -3.5, deltaMode: 0 });
  assert.ok(pinch > 1 && pinch < 1.06);
});

Deno.test("freeArea keys the host size and chrome insets in whole px", () => {
  const a = freeArea(1920.3, 1080, { top: 68, right: 316, bottom: 64, left: 72 });
  assert.equal(a.w, 1920);
  assert.equal(a.h, 1080);
  assert.deepEqual(a.insets, { top: 68, right: 316, bottom: 64, left: 72 });
  assert.equal(freeArea(1920, 1080.2, { top: 68, right: 316.4, bottom: 64, left: 72 }).key, a.key, "sub-pixel noise is not a change");
  assert.notEqual(freeArea(1920, 1080, { top: 68, right: 10, bottom: 64, left: 72 }).key, a.key);
  assert.deepEqual(freeArea(800, 600).insets, { top: 0, right: 0, bottom: 0, left: 0 });
});

Deno.test("refitPlan: the automatic fit follows the free area, never the user's view", () => {
  const wide = freeArea(1920, 1080, { top: 68, right: 316, bottom: 64, left: 72 });
  const panelHidden = freeArea(1920, 1080, { top: 68, right: 10, bottom: 64, left: 72 });
  const narrow = freeArea(1024, 700, { top: 68, right: 10, bottom: 64, left: 72 });
  assert.equal(refitPlan(wide, wide), null, "nothing changed");
  assert.deepEqual(refitPlan(wide, panelHidden), { animate: true }, "the panel folding away glides");
  assert.deepEqual(refitPlan(narrow, wide), { animate: false }, "a window resize snaps (and sees the new insets)");
  assert.deepEqual(refitPlan(wide, narrow), { animate: false });
  assert.equal(refitPlan(wide, narrow, { auto: false }), null, "the user zoomed or panned: leave the view alone");
  assert.deepEqual(refitPlan(null, wide), { animate: false }, "first fit");
  assert.deepEqual(refitPlan(wide, wide, { auto: false, pending: true }), { animate: false }, "a fit waiting for a size runs");
});

Deno.test("refitPlan + fitView: coming back from a narrow window keeps the artboard clear of the panel", () => {
  // 1024 px: the panel is folded away. 1920 px: it is back, 316 px wide.
  const narrow = freeArea(1024, 700, { top: 68, right: 10, bottom: 64, left: 72 });
  const wide = freeArea(1920, 1080, { top: 68, right: 316, bottom: 64, left: 72 });
  assert.ok(refitPlan(narrow, wide));
  const v = fitView(1280, 720, wide.w, wide.h, wide.insets, { maxZoom: 8 });
  assert.ok(v.panX + 1280 * v.zoom <= 1920 - 316, "right edge stays left of the inspector");
  assert.ok(v.panX >= 72);
});
