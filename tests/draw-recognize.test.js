// Tests for web/js/editor/recognize.js (smart shapes for the pen)
//   deno test --allow-read tests/draw-recognize.test.js

import assert from "node:assert/strict";
import { recognize, resample, pathLength, totalTurn, cleanPoints } from "../web/js/editor/recognize.js";

// Deterministic noise so the strokes look hand-drawn but never flake.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Smooth wobble (sum of slow sines) plus a little jitter, like a hand.
function wobble(points, { amp = 2, jitter = 0.6, seed = 1 } = {}) {
  const r = rng(seed);
  const f1 = 0.03 + r() * 0.03;
  const f2 = 0.07 + r() * 0.05;
  const p1 = r() * 6.28;
  const p2 = r() * 6.28;
  return points.map(([x, y], i) => [
    x + amp * Math.sin(i * f1 + p1) + (r() - 0.5) * 2 * jitter,
    y + amp * Math.cos(i * f2 + p2) + (r() - 0.5) * 2 * jitter,
  ]);
}

function polyline(vertices, spacing = 3) {
  const out = [];
  for (let i = 1; i < vertices.length; i++) {
    const [ax, ay] = vertices[i - 1];
    const [bx, by] = vertices[i];
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / spacing));
    for (let j = 0; j < n; j++) out.push([ax + ((bx - ax) * j) / n, ay + ((by - ay) * j) / n]);
  }
  out.push(vertices[vertices.length - 1]);
  return out;
}

function ellipsePoints({ cx, cy, rx, ry, rotation = 0, start = 0, sweep = 1.05, n = 140, dir = 1 }) {
  const r = (rotation * Math.PI) / 180;
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = start + dir * ((i / n) * sweep * Math.PI * 2);
    const x = Math.cos(t) * rx;
    const y = Math.sin(t) * ry;
    out.push([cx + x * Math.cos(r) - y * Math.sin(r), cy + x * Math.sin(r) + y * Math.cos(r)]);
  }
  return out;
}

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ""} ${a} != ${b} (±${eps})`);
const nearPt = (p, q, eps, msg) => {
  near(p.x, q[0], eps, `${msg || ""} x`);
  near(p.y, q[1], eps, `${msg || ""} y`);
};

// ---- helpers ------------------------------------------------------------------

Deno.test("resample spaces points evenly and keeps the ends", () => {
  const pts = resample([[0, 0], [10, 0], [10, 10]], 21);
  assert.equal(pts.length, 21);
  assert.deepEqual(pts[0], { x: 0, y: 0 });
  assert.deepEqual(pts[20], { x: 10, y: 10 });
  for (let i = 1; i < pts.length; i++) near(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y), 1, 1e-6);
});

Deno.test("cleanPoints accepts both point shapes and drops junk", () => {
  const pts = cleanPoints([[1, 2], { x: 3, y: 4 }, [3, 4], [NaN, 1], null, { x: 5, y: 6, p: 0.5 }]);
  assert.deepEqual(pts, [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }]);
  near(pathLength([[0, 0], [3, 4]]), 5, 1e-9);
});

Deno.test("totalTurn is about a full turn for a circle, signed by direction", () => {
  const cw = resample(ellipsePoints({ cx: 0, cy: 0, rx: 50, ry: 50, sweep: 1 }), 96);
  const ccw = resample(ellipsePoints({ cx: 0, cy: 0, rx: 50, ry: 50, sweep: 1, dir: -1 }), 96);
  near((totalTurn(cw) * 180) / Math.PI, 360, 12);
  near((totalTurn(ccw) * 180) / Math.PI, -360, 12);
});

// ---- ellipses -------------------------------------------------------------------

Deno.test("a rough circle becomes a perfect circle", () => {
  const stroke = wobble(ellipsePoints({ cx: 300, cy: 200, rx: 100, ry: 96, start: 2.2, sweep: 1.06 }), { amp: 2.5, seed: 3 });
  const r = recognize(stroke);
  assert.equal(r.kind, "ellipse");
  assert.ok(r.confidence >= 0.6, `confidence ${r.confidence}`);
  near(r.params.cx, 300, 6, "cx");
  near(r.params.cy, 200, 6, "cy");
  assert.equal(r.params.rx, r.params.ry, "snapped to a circle");
  near(r.params.rx, 99, 6, "radius");
  assert.equal(r.params.rotation, 0);
});

Deno.test("a circle drawn anticlockwise with a small gap still counts", () => {
  const stroke = wobble(ellipsePoints({ cx: 0, cy: 0, rx: 60, ry: 60, start: -1, sweep: 0.93, dir: -1 }), { amp: 1.2, seed: 9 });
  const r = recognize(stroke);
  assert.equal(r.kind, "ellipse");
  near(r.params.cx, 0, 6);
  near(r.params.cy, 0, 6);
});

Deno.test("a tilted oval keeps its angle and proportions", () => {
  const stroke = wobble(ellipsePoints({ cx: 640, cy: 360, rx: 170, ry: 80, rotation: 30, start: 0.5, sweep: 1.04 }), { amp: 2.5, seed: 5 });
  const r = recognize(stroke);
  assert.equal(r.kind, "ellipse");
  near(r.params.rotation, 30, 6, "rotation");
  near(r.params.rx, 170, 12, "rx");
  near(r.params.ry, 80, 9, "ry");
  near(r.params.cx, 640, 8);
  near(r.params.cy, 360, 8);
});

Deno.test("an upright oval is reported unrotated with the long side as ry", () => {
  const stroke = wobble(ellipsePoints({ cx: 100, cy: 100, rx: 60, ry: 140, rotation: 3, start: 4, sweep: 1.03 }), { amp: 1.5, seed: 11 });
  const r = recognize(stroke);
  assert.equal(r.kind, "ellipse");
  assert.equal(r.params.rotation, 0);
  near(r.params.rx, 60, 8, "rx");
  near(r.params.ry, 140, 10, "ry");
});

Deno.test("an oval drawn twice around is still an ellipse", () => {
  const stroke = wobble(ellipsePoints({ cx: 0, cy: 0, rx: 120, ry: 70, sweep: 1.35, n: 200 }), { amp: 2, seed: 21 });
  const r = recognize(stroke);
  assert.equal(r.kind, "ellipse");
  near(r.params.rx, 120, 10);
  near(r.params.ry, 70, 8);
});

// ---- lines ------------------------------------------------------------------------

Deno.test("a wobbly stroke between two points is a line", () => {
  const stroke = wobble(polyline([[100, 100], [400, 180]]), { amp: 1.5, seed: 2 });
  const r = recognize(stroke);
  assert.equal(r.kind, "line");
  assert.ok(r.confidence >= 0.6, `confidence ${r.confidence}`);
  nearPt(r.params.a, [100, 100], 4, "a");
  nearPt(r.params.b, [400, 180], 4, "b");
});

Deno.test("a nearly level line is levelled", () => {
  const stroke = polyline([[0, 50], [300, 60]]);
  const r = recognize(stroke);
  assert.equal(r.kind, "line");
  assert.equal(r.params.a.y, r.params.b.y);
  near(r.params.a.y, 55, 0.01);
  near(r.params.b.x - r.params.a.x, Math.hypot(300, 10), 0.05);
});

Deno.test("a nearly vertical line is made vertical", () => {
  const r = recognize(polyline([[200, 400], [190, 100]]));
  assert.equal(r.kind, "line");
  assert.equal(r.params.a.x, r.params.b.x);
  assert.ok(r.params.a.y > r.params.b.y, "keeps the direction");
});

// ---- arrows -----------------------------------------------------------------------

Deno.test("a line with a hook at the end is an arrow", () => {
  const stroke = wobble(polyline([[100, 300], [400, 300], [355, 272]]), { amp: 1.2, seed: 4 });
  const r = recognize(stroke);
  assert.equal(r.kind, "arrow");
  assert.ok(r.confidence >= 0.6, `confidence ${r.confidence}`);
  nearPt(r.params.a, [100, 300], 5, "tail");
  nearPt(r.params.b, [400, 300], 5, "tip");
  assert.equal(r.params.c, null);
});

Deno.test("a line with a V head is an arrow", () => {
  const stroke = wobble(polyline([[100, 300], [400, 300], [360, 268], [400, 300], [362, 334]]), { amp: 1, seed: 6 });
  const r = recognize(stroke);
  assert.equal(r.kind, "arrow");
  nearPt(r.params.b, [400, 300], 6, "tip");
});

Deno.test("a diagonal arrow pointing up and right", () => {
  const stroke = wobble(polyline([[200, 500], [420, 280], [370, 290], [420, 280], [410, 330]]), { amp: 1.2, seed: 8 });
  const r = recognize(stroke);
  assert.equal(r.kind, "arrow");
  nearPt(r.params.a, [200, 500], 6, "tail");
  nearPt(r.params.b, [420, 280], 6, "tip");
});

Deno.test("an arrow with a closed triangle head", () => {
  const stroke = polyline([[0, 0], [300, 0], [262, -24], [262, 24], [300, 0]]);
  const r = recognize(stroke);
  assert.equal(r.kind, "arrow");
  nearPt(r.params.b, [300, 0], 3);
});

Deno.test("a curved shaft gives a bent arrow", () => {
  const shaft = [];
  for (let i = 0; i <= 80; i++) {
    const t = i / 80;
    const u = 1 - t;
    // a (100, 400) c (250, 180) b (420, 380)
    shaft.push([u * u * 100 + 2 * u * t * 250 + t * t * 420, u * u * 400 + 2 * u * t * 180 + t * t * 380]);
  }
  const tip = shaft[shaft.length - 1];
  const stroke = wobble([...shaft, ...polyline([tip, [tip[0] - 8, tip[1] - 45]]).slice(1)], { amp: 0.8, seed: 12 });
  const r = recognize(stroke);
  assert.equal(r.kind, "arrow");
  assert.ok(r.params.c, "has a control point");
  near(r.params.c.x, 250, 25, "control x");
  near(r.params.c.y, 180, 25, "control y");
});

// ---- rectangles -------------------------------------------------------------------

Deno.test("a rough box becomes a rectangle", () => {
  const stroke = wobble(polyline([[250, 210], [550, 212], [548, 390], [252, 388], [250, 214]]), { amp: 2, seed: 7 });
  const r = recognize(stroke);
  assert.equal(r.kind, "rect");
  assert.ok(r.confidence >= 0.6, `confidence ${r.confidence}`);
  near(r.params.cx, 400, 8);
  near(r.params.cy, 300, 8);
  near(r.params.w, 300, 14);
  near(r.params.h, 180, 14);
  assert.equal(r.params.rotation, 0);
});

Deno.test("a tilted square keeps its tilt", () => {
  const a = (20 * Math.PI) / 180;
  const corner = (x, y) => [500 + x * Math.cos(a) - y * Math.sin(a), 300 + x * Math.sin(a) + y * Math.cos(a)];
  const stroke = wobble(polyline([corner(-100, -100), corner(100, -100), corner(100, 100), corner(-100, 100), corner(-100, -92)]), { amp: 1.5, seed: 13 });
  const r = recognize(stroke);
  assert.equal(r.kind, "rect");
  near(r.params.rotation, 20, 5, "rotation");
  near(r.params.w, 200, 14);
  near(r.params.h, 200, 14);
  near(r.params.cx, 500, 8);
  near(r.params.cy, 300, 8);
});

Deno.test("a box drawn anticlockwise from the bottom right", () => {
  const stroke = wobble(polyline([[400, 300], [400, 100], [100, 100], [100, 300], [394, 300]]), { amp: 1.5, seed: 17 });
  const r = recognize(stroke);
  assert.equal(r.kind, "rect");
  near(r.params.w, 300, 14);
  near(r.params.h, 200, 14);
});

Deno.test("circles are not mistaken for rectangles, nor boxes for circles", () => {
  const circle = recognize(ellipsePoints({ cx: 0, cy: 0, rx: 80, ry: 80, sweep: 1.02 }));
  assert.equal(circle.kind, "ellipse");
  const box = recognize(polyline([[0, 0], [160, 0], [160, 160], [0, 160], [0, 4]]));
  assert.equal(box.kind, "rect");
});

// ---- things that should stay freehand ----------------------------------------------

Deno.test("a zigzag scribble is not a shape", () => {
  const pts = [];
  for (let i = 0; i < 14; i++) pts.push([i * 30, i % 2 ? 0 : 60]);
  assert.equal(recognize(polyline(pts)).kind, null);
});

Deno.test("a random scribble is not a shape", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const r = rng(seed);
    const pts = [[0, 0]];
    let x = 0;
    let y = 0;
    let ang = 0;
    for (let i = 0; i < 160; i++) {
      ang += (r() - 0.5) * 1.6;
      x += Math.cos(ang) * 6;
      y += Math.sin(ang) * 6;
      pts.push([x, y]);
    }
    const out = recognize(pts);
    assert.equal(out.kind, null, `seed ${seed} gave ${out.kind} (${out.confidence})`);
  }
});

Deno.test("a spiral is not a circle", () => {
  const pts = [];
  for (let i = 0; i <= 300; i++) {
    const t = (i / 300) * Math.PI * 4;
    const r = 20 + t * 14;
    pts.push([Math.cos(t) * r, Math.sin(t) * r]);
  }
  assert.equal(recognize(pts).kind, null);
});

Deno.test("an open arc is not a circle", () => {
  assert.equal(recognize(ellipsePoints({ cx: 0, cy: 0, rx: 100, ry: 100, sweep: 0.5 })).kind, null);
});

Deno.test("a figure eight is not a shape", () => {
  const pts = [];
  for (let i = 0; i <= 200; i++) {
    const t = (i / 200) * Math.PI * 2;
    pts.push([Math.sin(t) * 120, Math.sin(t) * Math.cos(t) * 80]);
  }
  assert.equal(recognize(pts).kind, null);
});

Deno.test("a tick, a U and a triangle stay freehand", () => {
  assert.equal(recognize(polyline([[0, 0], [30, 40], [110, -70]])).kind, null, "tick");
  assert.equal(recognize(polyline([[0, 0], [0, 120], [90, 120], [90, 0]])).kind, null, "U");
  assert.equal(recognize(polyline([[0, 0], [200, 0], [100, -170], [0, 0]])).kind, null, "triangle");
});

Deno.test("an arrow pointing left", () => {
  const r = recognize(wobble(polyline([[500, 200], [150, 210], [195, 180], [150, 210], [196, 238]]), { amp: 1, seed: 41 }));
  assert.equal(r.kind, "arrow");
  nearPt(r.params.b, [150, 210], 6);
});

Deno.test("tiny strokes and degenerate input give nothing", () => {
  assert.equal(recognize([]).kind, null);
  assert.equal(recognize([[0, 0], [10, 0]]).kind, null);
  assert.equal(recognize([[5, 5], [5, 5], [5, 5], [5, 5]]).kind, null);
  assert.equal(recognize(polyline([[0, 0], [30, 0]]), { minLength: 40 }).kind, null);
  assert.equal(recognize(null).kind, null);
});

Deno.test("results are scale independent", () => {
  const base = wobble(ellipsePoints({ cx: 50, cy: 50, rx: 40, ry: 25, rotation: 15, sweep: 1.04 }), { amp: 0.8, seed: 31 });
  const small = recognize(base);
  const big = recognize(base.map(([x, y]) => [x * 10, y * 10]));
  assert.equal(small.kind, "ellipse");
  assert.equal(big.kind, "ellipse");
  near(big.params.rx, small.params.rx * 10, 1);
  near(big.params.rotation, small.params.rotation, 0.5);
});

Deno.test("points with pressure work the same as plain points", () => {
  const stroke = wobble(polyline([[100, 300], [400, 300], [355, 272]]), { amp: 1.2, seed: 4 }).map(([x, y]) => ({ x, y, p: 0.6 }));
  assert.equal(recognize(stroke).kind, "arrow");
});
