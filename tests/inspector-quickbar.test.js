// Tests for the quick bar's placement (web/js/ui/quickbar.js)
//   deno test --allow-read tests/inspector-quickbar.test.js

import assert from "node:assert/strict";
import { placeQuickbar, screenBox, shapePaint } from "../web/js/ui/quickbar.js";

Deno.test("shapePaint: a ring leads with its color, never an empty Fill dot", () => {
  const ring = { fill: { on: false, color: "#ffffff" }, stroke: { on: true, color: "#ff2d2d" } };
  const solid = { fill: { on: true, color: "#ffe14d" }, stroke: { on: false } };
  const both = { fill: { on: true }, stroke: { on: true } };
  const bare = { fill: { on: false }, stroke: { on: false } };
  assert.equal(shapePaint([ring]), "outline");
  assert.equal(shapePaint([ring, ring]), "outline");
  assert.equal(shapePaint([solid]), "fill");
  assert.equal(shapePaint([both]), "fill");
  assert.equal(shapePaint([ring, solid]), "fill");
  assert.equal(shapePaint([bare]), "stroke");
  assert.equal(shapePaint([ring, bare]), "stroke");
  assert.equal(shapePaint([]), "fill");
});

const VIEW = { w: 1200, h: 800 };
const BAR = { w: 240, h: 40 };

Deno.test("screenBox: bounds of the points, null when empty", () => {
  assert.deepEqual(screenBox([{ x: 10, y: 20 }, { x: -5, y: 40 }, { x: 30, y: 0 }]), { l: -5, t: 0, r: 30, b: 40 });
  assert.equal(screenBox([]), null);
  assert.equal(screenBox([{ x: NaN, y: 1 }]), null);
});

Deno.test("placeQuickbar: centered above the selection", () => {
  const p = placeQuickbar({ l: 400, t: 300, r: 600, b: 400 }, BAR, VIEW);
  assert.equal(p.side, "above");
  assert.equal(p.x, 380);
  assert.equal(p.y, 300 - 12 - 40);
  assert.equal(p.visible, true);
});

Deno.test("placeQuickbar: below when the top is too close, clear of the rotation knob", () => {
  const p = placeQuickbar({ l: 400, t: 40, r: 600, b: 200 }, BAR, VIEW, { inset: { top: 60 } });
  assert.equal(p.side, "below");
  assert.equal(p.y, 200 + 52);
});

Deno.test("placeQuickbar: inside a selection that fills the view", () => {
  const p = placeQuickbar({ l: 0, t: -50, r: 1200, b: 900 }, BAR, VIEW, { inset: { top: 60 } });
  assert.equal(p.side, "inside");
  assert.equal(p.y, 68);
});

Deno.test("placeQuickbar: stays clear of side panels", () => {
  const right = placeQuickbar({ l: 1100, t: 300, r: 1180, b: 400 }, BAR, VIEW, { inset: { right: 310 } });
  assert.equal(right.x, 1200 - 310 - 8 - 240);
  const left = placeQuickbar({ l: 0, t: 300, r: 20, b: 400 }, BAR, VIEW, { inset: { left: 70 } });
  assert.equal(left.x, 78);
});

Deno.test("placeQuickbar: reports a selection outside the view", () => {
  assert.equal(placeQuickbar({ l: 1300, t: 300, r: 1400, b: 400 }, BAR, VIEW).visible, false);
  assert.equal(placeQuickbar({ l: 400, t: -300, r: 600, b: -10 }, BAR, VIEW).visible, false);
});

Deno.test("placeQuickbar: a view narrower than the bar centers it", () => {
  const p = placeQuickbar({ l: 10, t: 300, r: 50, b: 400 }, BAR, { w: 200, h: 800 });
  assert.equal(p.x, -20);
});
