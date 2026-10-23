// Tests for the view maths in web/js/editor/viewport.js
//   deno test --allow-read tests/editor-viewport.test.js

import assert from "node:assert/strict";
import { MIN_ZOOM, MAX_ZOOM, clampZoom, zoomAround, fitView, fitRectView, stepZoom, clampPan, wheelZoomFactor } from "../web/js/editor/viewport.js";

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

Deno.test("fitView centres the artboard in the free area", () => {
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
