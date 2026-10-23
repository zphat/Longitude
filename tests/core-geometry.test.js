// Tests for web/js/core/geometry.js (and shape outlines from shapes.js)
//   deno test --allow-read tests/core-geometry.test.js

import assert from "node:assert/strict";
import {
  Mat,
  aabb,
  arrowGeometry,
  arrowPoints,
  boxMatrix,
  clamp,
  corners,
  dist,
  distToPolyline,
  distToQuad,
  fromLocal,
  hitTest,
  layerMatrix,
  layersInRect,
  pickLayer,
  pointInPolygon,
  pointsToDoc,
  quadBounds,
  quadPoint,
  quadThrough,
  refitArrow,
  refitPoints,
  rotatePoint,
  setAlphaMap,
  snapAngle,
  toBox,
  toLocal,
  unionBox,
} from "../web/js/core/geometry.js";
import { createDoc, createLayer } from "../web/js/core/model.js";
import { shapes, shapePreviewPath } from "../web/js/core/shapes.js";

const near = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, msg || `${a} != ${b}`);
const nearPt = (p, q, eps = 1e-6) => {
  near(p.x, q.x, eps, `x ${p.x} != ${q.x}`);
  near(p.y, q.y, eps, `y ${p.y} != ${q.y}`);
};

Deno.test("Mat: multiply, invert, apply", () => {
  const m = Mat.translate(10, 20).multiply(Mat.rotate(90)).multiply(Mat.scale(2, 3));
  nearPt(m.apply({ x: 1, y: 0 }), { x: 10, y: 22 });
  nearPt(m.apply([0, 1]), { x: 7, y: 20 });
  const inv = m.invert();
  nearPt(inv.apply(m.apply({ x: 3.5, y: -2 })), { x: 3.5, y: -2 });
  assert.ok(m.multiply(inv).toArray().every((v, i) => Math.abs(v - [1, 0, 0, 1, 0, 0][i]) < 1e-9));
  assert.ok(new Mat().isIdentity);
  assert.ok(new Mat(0, 0, 0, 0, 1, 1).invert().isIdentity, "a singular matrix inverts to identity");
  const r = Mat.rotate(30);
  nearPt(r.apply({ x: 1, y: 0 }), rotatePoint({ x: 1, y: 0 }, { x: 0, y: 0 }, 30));
});

Deno.test("layerMatrix / toLocal / fromLocal are inverses, with flips", () => {
  const l = { x: 100, y: 50, w: 80, h: 40, rotation: 33, flipX: true, flipY: false };
  const m = layerMatrix(l);
  for (const p of [{ x: 0, y: 0 }, { x: 40, y: -20 }, { x: -13, y: 7 }]) {
    const d = m.apply(p);
    nearPt(fromLocal(l, p), d);
    nearPt(toLocal(l, d), p);
  }
  nearPt(m.apply({ x: 0, y: 0 }), { x: 100, y: 50 });
  // A flip mirrors content but not the box frame.
  const flat = { x: 0, y: 0, w: 10, h: 10, rotation: 0, flipX: true };
  nearPt(toLocal(flat, { x: 3, y: 1 }), { x: -3, y: 1 });
  nearPt(toBox(flat, { x: 3, y: 1 }), { x: 3, y: 1 });
  nearPt(boxMatrix({ ...flat, rotation: 90 }).apply({ x: 1, y: 0 }), { x: 0, y: 1 });
});

Deno.test("corners are clockwise from the top-left; aabb of a rotated box", () => {
  const l = { x: 0, y: 0, w: 4, h: 2, rotation: 0 };
  assert.deepEqual(corners(l), [{ x: -2, y: -1 }, { x: 2, y: -1 }, { x: 2, y: 1 }, { x: -2, y: 1 }]);
  const r = corners({ ...l, rotation: 90 });
  nearPt(r[0], { x: 1, y: -2 });
  nearPt(r[1], { x: 1, y: 2 });
  const b = aabb({ x: 10, y: 10, w: 4, h: 2, rotation: 90 });
  near(b.w, 2);
  near(b.h, 4);
  near(b.l, 9);
  near(b.t, 8);
  near(b.cx, 10);
  const d = aabb({ x: 0, y: 0, w: 2, h: 2, rotation: 45 });
  near(d.w, 2 * Math.SQRT2);
  assert.equal(b.x, b.l);
  assert.equal(b.y, b.t);
});

Deno.test("unionBox", () => {
  const u = unionBox([{ l: 0, t: 0, r: 10, b: 5 }, { x: -5, y: 2, w: 3, h: 10 }, null]);
  assert.deepEqual(u, { x: -5, y: 0, w: 15, h: 12, l: -5, t: 0, r: 10, b: 12, cx: 2.5, cy: 6 });
  assert.equal(unionBox([]), null);
});

Deno.test("small helpers: dist, clamp, snapAngle, rotatePoint", () => {
  assert.equal(dist({ x: 0, y: 0 }, [3, 4]), 5);
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(snapAngle(44, 45), 45);
  assert.equal(snapAngle(-170, 45), 180);
  assert.equal(snapAngle(7, 15), 0);
  assert.equal(snapAngle(187, 15), 180);
  assert.equal(snapAngle(-188, 15), 165);
  nearPt(rotatePoint({ x: 2, y: 1 }, { x: 1, y: 1 }, 90), { x: 1, y: 2 });
});

Deno.test("quadratic helpers: point, through, bounds, distance", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 100, y: 0 };
  const m = { x: 50, y: 40 };
  const c = quadThrough(a, m, b);
  nearPt(quadPoint(a, c, b, 0.5), m);
  const bb = quadBounds(a, c, b);
  near(bb.t, 0);
  near(bb.b, 40);
  near(distToQuad({ x: 50, y: 45 }, a, c, b), 5, 1e-3);
  near(distToQuad({ x: -3, y: -4 }, a, c, b), 5, 1e-3);
  near(distToQuad({ x: 50, y: 0 }, a, a, b), 0, 1e-6);
  near(distToPolyline({ x: 5, y: 5 }, [[0, 0], [10, 0], [10, 10]]), 5);
  near(distToPolyline({ x: 5, y: 5 }, [[0, 0], [10, 0], [10, 10], [0, 10]], true), 5);
  assert.equal(distToPolyline({ x: 1, y: 1 }, []), Infinity);
  assert.ok(pointInPolygon({ x: 1, y: 1 }, [[0, 0], [4, 0], [0, 4]]));
  assert.ok(!pointInPolygon({ x: 3, y: 3 }, [[0, 0], [4, 0], [0, 4]]));
});

Deno.test("hitTest: text and image boxes, rotation and tolerance", () => {
  const t = createLayer("text", { x: 100, y: 100, w: 200, h: 50, rotation: 90 });
  assert.ok(hitTest(t, { x: 100, y: 190 }, { tol: 0 }), "inside the rotated box");
  assert.ok(!hitTest(t, { x: 190, y: 100 }, { tol: 0 }), "outside once rotated");
  assert.ok(hitTest(t, { x: 128, y: 100 }, { tol: 4 }), "within tolerance");
  assert.ok(!hitTest(t, { x: 128, y: 100 }, { tol: 2 }));
  const ell = createLayer("image", { x: 0, y: 0, w: 100, h: 100, frame: "ellipse" });
  assert.ok(hitTest(ell, { x: 0, y: 0 }, { tol: 0 }));
  assert.ok(!hitTest(ell, { x: 45, y: 45 }, { tol: 0 }), "corner is outside an ellipse frame");
  const rounded = createLayer("image", { x: 0, y: 0, w: 100, h: 100, radius: 30 });
  assert.ok(!hitTest(rounded, { x: 49, y: 49 }, { tol: 0 }));
  assert.ok(hitTest(rounded, { x: 49, y: 0 }, { tol: 0 }));
});

Deno.test("hitTest: masked images use the mask alpha (box until ready)", () => {
  const img = createLayer("image", { x: 50, y: 50, w: 100, h: 100, asset: "ast_img", mask: "ast_mask" });
  const fakeAssets = { getImage: () => null };
  assert.ok(hitTest(img, { x: 5, y: 5 }, { tol: 0, assets: fakeAssets }), "box hit while the mask decodes");
  // 4x4 map, only the right half is opaque.
  const data = new Uint8Array(16);
  for (let y = 0; y < 4; y++) for (let x = 2; x < 4; x++) data[y * 4 + x] = 255;
  setAlphaMap("ast_mask", { w: 4, h: 4, data });
  assert.ok(!hitTest(img, { x: 10, y: 50 }, { tol: 0, assets: fakeAssets }));
  assert.ok(hitTest(img, { x: 90, y: 50 }, { tol: 0, assets: fakeAssets }));
  assert.ok(hitTest(img, { x: 47, y: 50 }, { tol: 6, assets: fakeAssets }), "tolerance reaches the opaque edge");
  const cropped = { ...img, crop: { x: 0, y: 0, w: 0.5, h: 1 } };
  assert.ok(!hitTest(cropped, { x: 90, y: 50 }, { tol: 0, assets: fakeAssets }), "crop maps into the mask");
  const flipped = { ...img, flipX: true };
  assert.ok(hitTest(flipped, { x: 10, y: 50 }, { tol: 0, assets: fakeAssets }), "flips mirror the mask");
});

Deno.test("hitTest: shapes use their outline (fill) or stroke band", () => {
  const ell = createLayer("shape", { shape: "ellipse", x: 0, y: 0, w: 100, h: 100 });
  assert.ok(hitTest(ell, { x: 0, y: 0 }, { tol: 0 }));
  assert.ok(!hitTest(ell, { x: 46, y: 46 }, { tol: 0 }));
  const ring = createLayer("shape", { shape: "ellipse", x: 0, y: 0, w: 100, h: 100, fill: { on: false }, stroke: { on: true, width: 8 } });
  assert.ok(!hitTest(ring, { x: 0, y: 0 }, { tol: 3 }), "the middle of a highlight circle is not a hit");
  assert.ok(hitTest(ring, { x: 46, y: 0 }, { tol: 0 }), "on the stroke");
  assert.ok(hitTest(ring, { x: 0, y: -40 }, { tol: 3 }), "just inside the stroke band with tolerance");
  const star = createLayer("shape", { shape: "star", x: 0, y: 0, w: 100, h: 100 });
  assert.ok(hitTest(star, { x: 0, y: 0 }, { tol: 0 }));
  assert.ok(hitTest(star, { x: 0, y: -48 }, { tol: 0 }), "top point");
  assert.ok(!hitTest(star, { x: -48, y: 48 }, { tol: 0 }), "between the bottom points");
  const tri = createLayer("shape", { shape: "triangle", x: 0, y: 0, w: 100, h: 100 });
  assert.ok(!hitTest(tri, { x: -45, y: -45 }, { tol: 0 }));
  assert.ok(hitTest(tri, { x: 0, y: 40 }, { tol: 0 }));
  const none = createLayer("shape", { x: 0, y: 0, w: 10, h: 10, fill: { on: false } });
  assert.ok(hitTest(none, { x: 0, y: 0 }, { tol: 0 }), "no fill and no stroke falls back to the box");
  const rect = createLayer("shape", { x: 0, y: 0, w: 100, h: 100, radius: 40 });
  assert.ok(!hitTest(rect, { x: 48, y: 48 }, { tol: 0 }), "rounded corners are honoured");
});

Deno.test("hitTest: freehand paths use distance to the polyline", () => {
  const p = createLayer("path", { x: 50, y: 50, w: 100, h: 100, width: 10, points: [[0.1, 0.1, 0.5], [0.9, 0.9, 0.5]] });
  assert.ok(hitTest(p, { x: 50, y: 50 }, { tol: 0 }));
  assert.ok(hitTest(p, { x: 53, y: 47 }, { tol: 0 }), "within half the width");
  assert.ok(!hitTest(p, { x: 80, y: 20 }, { tol: 6 }), "far from the line");
  const dot = createLayer("path", { x: 0, y: 0, w: 30, h: 30, width: 10, points: [[0.5, 0.5, 0.5]] });
  assert.ok(hitTest(dot, { x: 4, y: 0 }, { tol: 0 }));
  assert.ok(!hitTest(createLayer("path", { points: [] }), { x: 640, y: 360 }));
});

Deno.test("hitTest: arrows (shaft, curve, head, dot tail)", () => {
  const a = createLayer("arrow", { x: 0, y: 0, w: 200, h: 100, width: 10, a: [0, 0.5], b: [1, 0.5], head: "triangle", headSize: 3, tail: "dot" });
  assert.ok(hitTest(a, { x: 0, y: 4 }, { tol: 0 }), "on the shaft");
  assert.ok(!hitTest(a, { x: 0, y: 30 }, { tol: 4 }), "away from the shaft");
  assert.ok(hitTest(a, { x: 80, y: 9 }, { tol: 0 }), "inside the head wing, off the shaft");
  assert.ok(!hitTest(a, { x: 85, y: 14 }, { tol: 0 }), "outside the head");
  assert.ok(hitTest(a, { x: -100, y: 10 }, { tol: 0 }), "on the dot tail");
  const bent = createLayer("arrow", { x: 0, y: 0, w: 200, h: 200, width: 10, a: [0, 0.5], b: [1, 0.5], c: [0.5, 0], head: "none" });
  assert.ok(hitTest(bent, { x: 0, y: -50 }, { tol: 0 }), "on the curve at its midpoint");
  assert.ok(!hitTest(bent, { x: 0, y: 0 }, { tol: 6 }), "not on the chord");
  const g = arrowGeometry(a);
  assert.equal(g.head.kind, "triangle");
  near(g.head.tip.x, 100);
  const visibleTip = g.head.poly[0].x + g.head.round / 2;
  assert.ok(visibleTip <= 100 && visibleTip > 100 - 10 * 0.25, "the rounded head ends at the end point, not past it");
  assert.ok(g.shaft.b.x < g.head.poly[0].x, "the shaft stops under the head");
  near(g.tail.r, 11);
  const line = arrowGeometry({ ...a, head: "line", tail: "none" });
  near(line.head.tip.x, 95, 1e-6, "chevron apex sits half a width back for its round join");
  near(line.shaft.b.x, 95, 1e-3);
  near(line.shaft.a.x, -100);
});

Deno.test("pickLayer: topmost hit, skips hidden and locked unless asked", () => {
  const doc = createDoc();
  const bottom = createLayer("shape", { x: 100, y: 100, w: 100, h: 100 });
  const middle = createLayer("shape", { x: 100, y: 100, w: 100, h: 100, locked: true });
  const top = createLayer("shape", { x: 100, y: 100, w: 100, h: 100, hidden: true });
  doc.layers.push(bottom, middle, top);
  assert.equal(pickLayer(doc, { x: 100, y: 100 }), bottom);
  assert.equal(pickLayer(doc, { x: 100, y: 100 }, { includeLocked: true }), middle);
  assert.equal(pickLayer(doc, { x: 100, y: 100 }, { includeLocked: true, includeHidden: true }), top);
  assert.equal(pickLayer(doc, { x: 900, y: 900 }), null);
});

Deno.test("layersInRect: partial overlap counts, rotation respected", () => {
  const doc = createDoc();
  const a = createLayer("shape", { x: 100, y: 100, w: 100, h: 100 });
  const b = createLayer("shape", { x: 400, y: 100, w: 100, h: 100 });
  const diamond = createLayer("shape", { x: 300, y: 400, w: 100, h: 100, rotation: 45 });
  const locked = createLayer("shape", { x: 100, y: 100, w: 10, h: 10, locked: true });
  doc.layers.push(a, b, diamond, locked);
  assert.deepEqual(layersInRect(doc, { x: 140, y: 140, w: 20, h: 20 }), [a]);
  assert.deepEqual(layersInRect(doc, { x: 500, y: 0, w: -200, h: 200 }).map((l) => l.id), [b.id]);
  // The diamond's bounding box covers (240, 340) but the diamond itself does not.
  assert.deepEqual(layersInRect(doc, { l: 245, t: 345, r: 252, b: 352 }), []);
  assert.deepEqual(layersInRect(doc, { l: 295, t: 395, r: 305, b: 405 }), [diamond]);
});

Deno.test("refitPoints: box around the points with padding, keeps rotation", () => {
  const layer = { x: 0, y: 0, rotation: 0, width: 4 };
  const fit = refitPoints(layer, [{ x: 10, y: 20, p: 0.25 }, { x: 110, y: 70, p: 1 }], 8);
  assert.deepEqual([fit.x, fit.y, fit.w, fit.h], [60, 45, 116, 66]);
  assert.deepEqual(fit.points[0], [Math.round((8 / 116) * 1e5) / 1e5, Math.round((8 / 66) * 1e5) / 1e5, 0.25]);
  const back = pointsToDoc({ ...layer, ...fit }, fit.points);
  nearPt(back[0], { x: 10, y: 20 }, 1e-2);
  nearPt(back[1], { x: 110, y: 70 }, 1e-2);
  assert.equal(back[1].p, 1);

  const rotated = { x: 50, y: 50, rotation: 30, width: 10, flipX: true };
  const pts = [[0, 0], [100, 20], [40, 90]];
  const r = refitPoints(rotated, pts);
  assert.equal(r.points[0].length, 2, "no pressure in, none out");
  const docPts = pointsToDoc({ ...rotated, ...r }, r.points);
  pts.forEach((p, i) => nearPt(docPts[i], { x: p[0], y: p[1] }, 1e-2));
  for (const [u, v] of r.points) assert.ok(u > 0 && u < 1 && v > 0 && v < 1);
  // Default pad is max(width * 1.5, 8).
  const d = refitPoints({ x: 0, y: 0, rotation: 0, width: 10 }, [[0, 0], [10, 0]]);
  assert.equal(d.h, 30);
});

Deno.test("refitArrow: hugs the curve, endpoints round-trip", () => {
  const layer = createLayer("arrow", { x: 0, y: 0, rotation: 0, width: 10, headSize: 3 });
  const fit = refitArrow(layer, { a: { x: 0, y: 0 }, b: { x: 200, y: 0 }, c: { x: 100, y: -100 } });
  const pad = Math.max(15, 8, 3 * 10 * 0.55);
  near(fit.h, 50 + pad * 2, 1e-6, "box height is the curve's, not the control point's");
  const placed = { ...layer, ...fit };
  const ends = arrowPoints(placed);
  nearPt(ends.a, { x: 0, y: 0 }, 1e-2);
  nearPt(ends.b, { x: 200, y: 0 }, 1e-2);
  nearPt(ends.c, { x: 100, y: -100 }, 1e-2);
  nearPt(ends.mid, { x: 100, y: -50 }, 1e-2);
  const straight = refitArrow(layer, { a: [0, 0], b: [100, 0] });
  assert.equal(straight.c, null);
});

Deno.test("shapes: built-ins registered, outlines fit their box, previews", () => {
  for (const id of ["rect", "ellipse", "triangle", "star", "burst", "bubble"]) {
    const def = shapes.get(id);
    assert.ok(def, id);
    assert.equal(typeof def.path, "function");
    const pts = def.outline(200, 100, { ...(def.defaults?.params || {}) }, { radius: id === "rect" || id === "bubble" ? 10 : 0 });
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    near(Math.min(...xs), -100, 1.5, `${id} left`);
    near(Math.max(...xs), 100, 1.5, `${id} right`);
    near(Math.min(...ys), -50, 1.5, `${id} top`);
    near(Math.max(...ys), 50, 1.5, `${id} bottom`);
    assert.match(shapePreviewPath(id), /^M[\d.]+ [\d.]+(L[\d.]+ [\d.]+)+Z$/);
  }
  assert.throws(() => shapes.register({ id: "rect", label: "x", path() {} }), /already registered/);
  const off = shapes.register({ id: "mod.blob", label: "Blob", path() {} });
  assert.ok(shapes.has("mod.blob"));
  off();
  assert.ok(!shapes.has("mod.blob"));
});
