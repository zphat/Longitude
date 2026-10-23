// Tests for web/js/editor/transform.js
//   deno test --allow-read tests/editor-transform.test.js

import assert from "node:assert/strict";
import { createLayer } from "../web/js/core/model.js";
import { corners, arrowPoints, fromLocal } from "../web/js/core/geometry.js";
import { measureBox } from "../web/js/core/textlayout.js";
import {
  HANDLES,
  isCorner,
  handlesFor,
  resizeBox,
  resizeLayer,
  scaleGroup,
  scaleTextProps,
  rotateFrom,
  constrainAngle,
  moveArrowEnd,
  bendArrow,
} from "../web/js/editor/transform.js";

const near = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, msg || `${a} != ${b}`);
const nearPt = (p, q, eps = 1e-6) => {
  near(p.x, q.x, eps, `x ${p.x} != ${q.x}`);
  near(p.y, q.y, eps, `y ${p.y} != ${q.y}`);
};

Deno.test("handles: corners and sides by type", () => {
  assert.equal(isCorner("nw"), true);
  assert.equal(isCorner("e"), false);
  assert.deepEqual(handlesFor(createLayer("text")), ["nw", "ne", "se", "sw", "e", "w"]);
  assert.equal(handlesFor(createLayer("shape")).length, 8);
  assert.deepEqual(handlesFor(createLayer("arrow")), []);
  assert.deepEqual(handlesFor(createLayer("shape", { locked: true })), []);
});

Deno.test("resizeBox: corner drag keeps the opposite corner", () => {
  const r = resizeBox(100, 50, "se", { x: 50, y: 25 }, { x: 70, y: 45 });
  assert.equal(r.w, 120);
  assert.equal(r.h, 70);
  // old nw corner (-50, -25) stays
  near(r.cx - r.w / 2, -50);
  near(r.cy - r.h / 2, -25);
});

Deno.test("resizeBox: grab offset is kept", () => {
  // grabbed 5 px inside the corner; moving 10 px grows 10 px
  const r = resizeBox(100, 100, "e", { x: 45, y: 0 }, { x: 55, y: 0 });
  assert.equal(r.w, 110);
  assert.equal(r.h, 100);
  near(r.cx, 5);
});

Deno.test("resizeBox: aspect lock on a corner uses the larger scale", () => {
  const r = resizeBox(200, 100, "se", { x: 100, y: 50 }, { x: 300, y: 60 }, { keepAspect: true });
  near(r.w / r.h, 2);
  near(r.w, 400);
});

Deno.test("resizeBox: aspect lock on a side scales around the center line", () => {
  const r = resizeBox(200, 100, "e", { x: 100, y: 0 }, { x: 200, y: 0 }, { keepAspect: true });
  near(r.w, 300);
  near(r.h, 150);
  near(r.cy, 0);
});

Deno.test("resizeBox: from the center grows both sides", () => {
  const r = resizeBox(100, 100, "e", { x: 50, y: 0 }, { x: 60, y: 0 }, { fromCenter: true });
  assert.equal(r.w, 120);
  assert.equal(r.cx, 0);
});

Deno.test("resizeBox: clamps at the minimum instead of flipping", () => {
  const r = resizeBox(100, 100, "e", { x: 50, y: 0 }, { x: -300, y: 0 }, { minW: 4 });
  assert.equal(r.w, 4);
  near(r.cx, -50 + 2);
});

Deno.test("resizeBox: snapping moves the dragged edge onto the target", () => {
  const snapX = (vals) => ({ i: 0, d: 103 - vals[0] });
  const r = resizeBox(100, 100, "e", { x: 50, y: 0 }, { x: 51, y: 0 }, { snapX });
  near(r.cx + r.w / 2, 103);
});

Deno.test("resizeLayer: rotated shape keeps the anchor corner in doc space", () => {
  const l = createLayer("shape", { x: 300, y: 200, w: 200, h: 100, rotation: 30 });
  const [nw0, , se0] = corners(l);
  const p = { x: se0.x + 20, y: se0.y + 15 };
  const props = resizeLayer(l, "se", se0, p);
  const next = { ...l, ...props };
  nearPt(corners(next)[0], nw0, 1e-6);
  nearPt(corners(next)[2], p, 1e-6);
});

Deno.test("resizeLayer: shapes resize freely, Shift keeps the aspect", () => {
  const l = createLayer("shape", { x: 0, y: 0, w: 200, h: 100 });
  const free = resizeLayer(l, "se", { x: 100, y: 50 }, { x: 150, y: 150 });
  assert.equal(free.w, 250);
  assert.equal(free.h, 200);
  const locked = resizeLayer(l, "se", { x: 100, y: 50 }, { x: 150, y: 150 }, { shift: true });
  near(locked.w / locked.h, 2);
});

Deno.test("resizeLayer: image corners keep the aspect unless Shift", () => {
  const l = createLayer("image", { x: 0, y: 0, w: 400, h: 200, natW: 800, natH: 400 });
  const a = resizeLayer(l, "se", { x: 200, y: 100 }, { x: 300, y: 120 });
  near(a.w / a.h, 2);
  const b = resizeLayer(l, "se", { x: 200, y: 100 }, { x: 300, y: 120 }, { shift: true });
  assert.equal(b.w, 500);
  assert.equal(b.h, 220);
});

Deno.test("resizeLayer: image side handles crop without moving the picture", () => {
  const l = createLayer("image", { x: 200, y: 100, w: 400, h: 200, natW: 800, natH: 400 });
  // drag the right edge 100 px inwards
  const p = resizeLayer(l, "e", { x: 400, y: 100 }, { x: 300, y: 100 });
  assert.equal(p.w, 300);
  near(p.crop.x, 0);
  near(p.crop.w, 0.75);
  near(p.x, 150);
  // then drag the left edge in: crop.x grows, the right side stays
  const l2 = { ...l, ...p };
  const q = resizeLayer(l2, "w", { x: 0, y: 100 }, { x: 60, y: 100 });
  near(q.w, 240);
  near(q.crop.x, 0.15);
  near(q.crop.x + q.crop.w, 0.75);
});

Deno.test("resizeLayer: image sides can not grow past the picture", () => {
  const l = createLayer("image", { x: 0, y: 0, w: 400, h: 200, natW: 800, natH: 400, crop: { x: 0.25, y: 0, w: 0.5, h: 1 } });
  // 800 doc px of picture; 0.25 is left of the frame and 0.25 right of it
  const p = resizeLayer(l, "e", { x: 200, y: 0 }, { x: 2000, y: 0 });
  near(p.w, 600);
  near(p.crop.w, 0.75);
  near(p.crop.x, 0.25);
});

Deno.test("resizeLayer: flipped image crops the mirrored side", () => {
  const l = createLayer("image", { x: 0, y: 0, w: 400, h: 200, natW: 800, natH: 400, flipX: true });
  // On screen the right edge of a flipped image is the picture's left side.
  const p = resizeLayer(l, "e", { x: 200, y: 0 }, { x: 100, y: 0 });
  near(p.w, 300);
  near(p.crop.x, 0.25);
  near(p.crop.w, 0.75);
});

Deno.test("resizeLayer: text corners scale the font and the outline", () => {
  const l = createLayer("text", { x: 400, y: 300, size: 100, stroke: { on: true, width: 10 } });
  const m0 = measureBox(l);
  const t = { ...l, w: m0.w, h: m0.h };
  const [nw] = corners(t);
  const se = corners(t)[2];
  const target = { x: se.x + t.w, y: se.y + t.h };
  const p = resizeLayer(t, "se", se, target);
  near(p.size, 200, 0.01);
  near(p.stroke.width, 20, 0.01);
  const after = { ...t, ...p };
  // measured box, top-left corner unchanged
  const m = measureBox(after);
  near(after.w, Math.round(m.w * 100) / 100);
  nearPt(corners(after)[0], nw, 0.02);
});

Deno.test("resizeLayer: text sides set a fixed wrap width and keep the top", () => {
  const l = createLayer("text", { x: 400, y: 300, size: 80, text: "one two three four five" });
  const m0 = measureBox(l);
  const t = { ...l, w: m0.w, h: m0.h };
  const top = t.y - t.h / 2;
  const p = resizeLayer(t, "e", { x: t.x + t.w / 2, y: t.y }, { x: t.x + t.w / 2 - t.w * 0.5, y: t.y });
  assert.equal(p.wrap, "fixed");
  assert.ok(p.w < t.w);
  assert.ok(p.h > t.h, "narrower text wraps onto more lines");
  near(p.y - p.h / 2, top, 0.02);
  // left edge stays
  near(p.x - p.w / 2, t.x - t.w / 2, 0.02);
});

Deno.test("resizeLayer: a text side that ends at the auto width keeps the line whole", () => {
  // At this size the line is 208.1018 wide and the stored auto width rounds
  // to 208.10, a hair under it.
  const l = createLayer("text", { x: 400, y: 300, size: 101.13, text: "WOW" });
  const m0 = measureBox(l);
  const t = { ...l, w: Math.round(m0.w * 100) / 100, h: m0.h };
  assert.ok(t.w < m0.w, "the case under test: rounded down");
  const edge = { x: t.x + t.w / 2, y: t.y };
  const p = resizeLayer(t, "e", edge, edge);
  assert.equal(p.wrap, "fixed");
  assert.ok(p.w >= m0.w, `${p.w} < ${m0.w}`);
  near(p.h, m0.h, 0.01, "still one line");
  // Narrower than the line still wraps.
  const q = resizeLayer({ ...l, w: m0.w, h: m0.h }, "e", { x: l.x + m0.w / 2, y: l.y }, { x: l.x + m0.w / 2 - 20, y: l.y });
  assert.ok(q.w < m0.w);
});

Deno.test("scaleTextProps: scales effects and clamps", () => {
  const l = createLayer("text", { size: 100, shadow: { on: true, blur: 20, dx: 4, dy: 8 }, glow: { on: true, size: 30 }, bg: { on: true, padX: 10, padY: 6, radius: 8 } });
  const p = scaleTextProps(l, 2);
  assert.equal(p.size, 200);
  assert.equal(p.shadow.blur, 40);
  assert.equal(p.shadow.dy, 16);
  assert.equal(p.glow.size, 60);
  assert.equal(p.bg.padX, 20);
  assert.equal(scaleTextProps(l, 100).size, 4000);
});

Deno.test("scaleGroup: scales positions and sizes around the anchor corner", () => {
  const a = createLayer("shape", { id: "a", x: 100, y: 100, w: 100, h: 100 });
  const b = createLayer("shape", { id: "b", x: 300, y: 100, w: 100, h: 100 });
  const box = { l: 50, t: 50, r: 350, b: 150 };
  const res = scaleGroup([a, b], box, "se", { x: 350, y: 150 }, { x: 650, y: 250 });
  near(res.scale, 2);
  const pa = res.props.get("a");
  const pb = res.props.get("b");
  assert.equal(pa.w, 200);
  near(pa.x, 150);
  near(pa.y, 150);
  near(pb.x, 550);
  near(res.box.l, 50);
  near(res.box.r, 650);
});

Deno.test("rotateFrom: snaps near 45° and to 15° steps with Shift", () => {
  const c = { x: 0, y: 0 };
  const start = { x: 100, y: 0 };
  const at = (deg) => ({ x: Math.cos((deg * Math.PI) / 180) * 100, y: Math.sin((deg * Math.PI) / 180) * 100 });
  near(rotateFrom(c, start, at(44), 0), 45);
  near(rotateFrom(c, start, at(40), 0), 40);
  near(rotateFrom(c, start, at(40), 0, { shift: true }), 45);
  near(rotateFrom(c, start, at(22), 0, { shift: true }), 15);
  near(rotateFrom(c, start, at(10), 175), -175);
});

Deno.test("constrainAngle: keeps the distance", () => {
  const p = constrainAngle({ x: 0, y: 0 }, { x: 100, y: 10 }, 15);
  near(p.y, 0);
  near(p.x, Math.hypot(100, 10));
});

Deno.test("moveArrowEnd: moves the tip and keeps the tail", () => {
  const l = createLayer("arrow", { x: 200, y: 100, w: 360, h: 120 });
  const pts = arrowPoints(l);
  const props = moveArrowEnd(l, "b", { x: pts.b.x + 50, y: pts.b.y + 80 });
  const next = { ...l, ...props };
  const after = arrowPoints(next);
  nearPt(after.a, pts.a, 1e-3);
  nearPt(after.b, { x: pts.b.x + 50, y: pts.b.y + 80 }, 1e-3);
});

Deno.test("moveArrowEnd: a bend turns with the moved end", () => {
  const base = createLayer("arrow", { x: 0, y: 0, w: 200, h: 200, a: [0.25, 0.5], b: [0.75, 0.5] });
  const bent = { ...base, ...bendArrow(base, { x: 0, y: -40 }) };
  const p0 = arrowPoints(bent);
  assert.ok(p0.c, "arrow is bent");
  const props = moveArrowEnd(bent, "b", { x: p0.a.x, y: p0.a.y + (p0.b.x - p0.a.x) });
  const p1 = arrowPoints({ ...bent, ...props });
  // rotated 90° around the tail: the bend now sits to the right of the chord
  assert.ok(p1.mid.x > p1.a.x + 30);
});

Deno.test("bendArrow: passes through the handle and straightens near the middle", () => {
  const l = createLayer("arrow", { x: 0, y: 0, w: 200, h: 100, a: [0.1, 0.5], b: [0.9, 0.5] });
  const pts = arrowPoints(l);
  const m = { x: (pts.a.x + pts.b.x) / 2, y: (pts.a.y + pts.b.y) / 2 - 50 };
  const bent = { ...l, ...bendArrow(l, m) };
  nearPt(arrowPoints(bent).mid, m, 1e-3);
  const straight = bendArrow(bent, { x: m.x, y: m.y + 49 }, { straightTol: 4 });
  assert.equal(straight.c, null);
});

Deno.test("HANDLES are unit directions", () => {
  for (const [k, v] of Object.entries(HANDLES)) assert.ok(v.every((n) => n === -1 || n === 0 || n === 1), k);
  // a point placed by fromLocal agrees with corners()
  const l = createLayer("shape", { x: 10, y: 20, w: 40, h: 30, rotation: 90 });
  nearPt(fromLocal(l, { x: -20, y: -15 }), corners(l)[0]);
});
