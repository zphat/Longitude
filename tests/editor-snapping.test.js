// Tests for web/js/editor/snapping.js
//   deno test --allow-read tests/editor-snapping.test.js

import assert from "node:assert/strict";
import { createDoc, createLayer } from "../web/js/core/model.js";
import { refitPoints } from "../web/js/core/geometry.js";
import {
  SNAP_PX,
  boxOf,
  offsetBox,
  visualBox,
  buildTargets,
  best,
  snapMove,
  snapPoint,
  alignGuides,
  spacingCandidates,
  spacingGuides,
  pointGuides,
} from "../web/js/editor/snapping.js";

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

function docWith(layers) {
  const doc = createDoc();
  doc.layers = layers;
  return doc;
}

Deno.test("buildTargets: canvas first, hidden and excluded layers left out", () => {
  const a = createLayer("shape", { id: "a", x: 100, y: 100, w: 100, h: 100 });
  const b = createLayer("shape", { id: "b", x: 500, y: 100, w: 100, h: 100, hidden: true });
  const c = createLayer("shape", { id: "c", x: 900, y: 100, w: 100, h: 100 });
  const T = buildTargets(docWith([a, b, c]), { exclude: ["c"] });
  assert.equal(SNAP_PX, 6);
  assert.equal(T.xs[0].src, "canvas");
  assert.equal(T.xs[1].v, 640);
  assert.equal(T.boxes.length, 1);
  assert.equal(T.xs.length, 6);
});

Deno.test("best: nearest target within the threshold; canvas wins ties", () => {
  const T = buildTargets(docWith([createLayer("shape", { x: 640, y: 100, w: 100, h: 100 })]));
  const hit = best([636], T.xs, 6);
  assert.equal(hit.v, 640);
  assert.equal(hit.t.src, "canvas");
  assert.equal(best([600], T.xs, 6), null);
});

Deno.test("snapMove: pulls a box onto the canvas center and reports it", () => {
  const T = buildTargets(docWith([]));
  const box = boxOf(537, 300, 737, 400); // center x 637
  const s = snapMove(box, T, 6);
  near(s.dx, 3);
  assert.equal(s.x, true);
  const fin = offsetBox(box, s.dx, s.dy);
  const guides = alignGuides(fin, T);
  const center = guides.find((g) => g.axis === "x" && g.center);
  assert.ok(center, "center guide");
  assert.equal(center.from, 0);
  assert.equal(center.to, 720);
});

Deno.test("snapMove: edges snap to other layers; locked axes stay", () => {
  const other = createLayer("shape", { x: 300, y: 300, w: 100, h: 100 }); // l 250 r 350
  const T = buildTargets(docWith([other]));
  const box = boxOf(353, 500, 453, 560);
  const s = snapMove(box, T, 6);
  near(s.dx, -3);
  const locked = snapMove(box, T, 6, { lockX: true });
  assert.equal(locked.dx, 0);
  assert.equal(locked.x, false);
  const guides = alignGuides(offsetBox(box, s.dx, 0), T);
  const g = guides.find((x) => x.axis === "x" && Math.abs(x.v - 350) < 1e-6);
  assert.ok(g);
  assert.equal(g.from, 250);
  assert.equal(g.to, 560);
  assert.equal(g.center, false);
});

Deno.test("snapMove: an edge on the canvas center line is not called centered", () => {
  const T = buildTargets(docWith([]));
  const guides = alignGuides(boxOf(640, 100, 700, 200), T);
  const g = guides.find((x) => x.axis === "x" && x.v === 640);
  assert.ok(g?.canvas);
  assert.equal(g.center, false);
});

Deno.test("spacing: centered between two neighbors", () => {
  const a = createLayer("shape", { x: 150, y: 300, w: 100, h: 100 }); // r 200
  const b = createLayer("shape", { x: 650, y: 300, w: 100, h: 100 }); // l 600
  const T = buildTargets(docWith([a, b]));
  // a 100 wide box between them belongs at l = 350
  const box = boxOf(347, 300, 447, 340);
  assert.ok(spacingCandidates(box, T.boxes, "x").some((v) => Math.abs(v - 350) < 1e-6));
  const s = snapMove(box, T, 6);
  near(s.dx, 3);
  const segs = spacingGuides(offsetBox(box, s.dx, 0), T.boxes);
  assert.equal(segs.length, 2);
  assert.deepEqual(
    segs.map((x) => x.label),
    ["150", "150"],
  );
});

Deno.test("spacing: continues the gap of a row", () => {
  const a = createLayer("shape", { x: 100, y: 300, w: 100, h: 100 }); // 50..150
  const b = createLayer("shape", { x: 300, y: 300, w: 100, h: 100 }); // 250..350 gap 100
  const T = buildTargets(docWith([a, b]));
  const box = boxOf(452, 280, 552, 380); // wants l = 450
  const s = snapMove(box, T, 6);
  near(s.dx, -2);
  const segs = spacingGuides(offsetBox(box, s.dx, s.dy), T.boxes);
  assert.ok(segs.length >= 2);
  assert.ok(segs.every((x) => x.label === "100"));
});

Deno.test("snapPoint and pointGuides", () => {
  const T = buildTargets(docWith([]));
  const s = snapPoint({ x: 3, y: 357 }, T, 6);
  assert.equal(s.x, 0);
  assert.equal(s.y, 360);
  const guides = pointGuides({ x: s.x, y: s.y }, T);
  assert.equal(guides.length, 2);
  assert.ok(guides.find((g) => g.axis === "y" && g.center));
});

Deno.test("visualBox: paths drop their padding, arrows hug the stroke", () => {
  const base = createLayer("path", { x: 0, y: 0, width: 10 });
  const fit = refitPoints(base, [
    { x: 100, y: 100 },
    { x: 300, y: 100 },
    { x: 300, y: 200 },
  ]);
  const path = { ...base, ...fit };
  const vb = visualBox(path);
  near(vb.l, 95);
  near(vb.r, 305);
  near(vb.t, 95);
  near(vb.b, 205);
  const arrow = createLayer("arrow", { x: 200, y: 100, w: 360, h: 120, width: 14 });
  const ab = visualBox(arrow);
  assert.ok(ab.w < arrow.w && ab.h < arrow.h);
});
