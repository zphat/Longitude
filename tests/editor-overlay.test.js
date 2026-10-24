// Tests for the screen-space overlay in web/js/editor/selection.js: pixel
// snapping of outlines, handles and guides, and the hover outline, with a
// tiny stand-in for the SVG DOM.
//   deno test --allow-read tests/editor-overlay.test.js

import assert from "node:assert/strict";

class FakeEl {
  constructor(tag) {
    this.tagName = tag;
    this.attrs = {};
    this.style = {};
    this.children = [];
    this.parentNode = null;
    this.textContent = "";
    this.className = "";
    const set = new Set();
    this.classList = {
      toggle: (c, on) => (on ? set.add(c) : set.delete(c)),
      contains: (c) => set.has(c),
    };
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  append(...nodes) {
    for (const n of nodes) this.appendChild(n);
  }
  appendChild(n) {
    n.parentNode = this;
    this.children.push(n);
    return n;
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  replaceWith(n) {
    const p = this.parentNode;
    const i = p.children.indexOf(this);
    p.children[i] = n;
    n.parentNode = p;
    this.parentNode = null;
  }
}

globalThis.Node ??= FakeEl;
globalThis.SVGElement ??= FakeEl;
globalThis.document ??= {
  createElement: (tag) => new FakeEl(tag),
  createElementNS: (_ns, tag) => new FakeEl(tag),
  createTextNode: (t) => Object.assign(new FakeEl("#text"), { textContent: t }),
};

const { createSelectionOverlay, snapLine, axisAligned } = await import("../web/js/editor/selection.js");
const { Store } = await import("../web/js/core/store.js");
const { createDoc, createLayer } = await import("../web/js/core/model.js");

function setup(layers, { zoom = 0.5, panX = 100.3, panY = 50.7, dpr = 1, width = 0, height = 0, insets = null } = {}) {
  const store = new Store(createDoc());
  const ids = store.add(layers, { select: false });
  const viewport = { zoom, panX, panY, dpr, width, height, docToLocal: (p) => ({ x: panX + p.x * zoom, y: panY + p.y * zoom }) };
  const core = {
    store,
    viewport,
    state: { mode: "normal", guides: [], spacing: [], marquee: null, gesture: null, hoverId: null, panelHoverId: null },
    toolId: "select",
    textEditing: null,
    overlaySvg: new FakeEl("svg"),
    pillsEl: new FakeEl("div"),
    freeArea: () => (insets ? { w: width, h: height, insets } : null),
  };
  const overlay = createSelectionOverlay(core);
  const group = (cls) => core.overlaySvg.children.find((g) => g.attrs.class === cls);
  return { store, ids, core, overlay, group };
}

// Fractional part of a coordinate, in [0, 1).
const frac = (v) => ((v % 1) + 1) % 1;
const nums = (d) => (d.match(/-?\d+(\.\d+)?/g) || []).map(Number);

Deno.test("snapLine puts odd-width strokes on pixel centers, even ones on pixel edges", () => {
  // 1 and 1.5 px at 1x cover one device pixel: centered on it.
  assert.equal(snapLine(10.2, 1, 1), 10.5);
  assert.equal(snapLine(10.9, 1.5, 1), 10.5);
  // 1 px at 2x covers two device pixels: on the boundary between them.
  assert.equal(snapLine(10.2, 1, 2), 10);
  assert.equal(snapLine(10.3, 1, 2), 10.5);
  // 1.5 px at 2x covers three: centered on the middle one.
  assert.equal(snapLine(10.2, 1.5, 2), 10.25);
  // Snapping twice changes nothing.
  for (const [w, d] of [[1, 1], [1.5, 1], [1, 2], [1.5, 2], [1.25, 1.5]]) {
    const v = snapLine(37.37, w, d);
    assert.equal(snapLine(v, w, d), v);
    assert.ok(Math.abs(v - 37.37) <= 0.5 / d + 1e-9, "never moves a line by more than half a device pixel");
  }
});

Deno.test("axisAligned: upright and quarter turns only", () => {
  assert.equal(axisAligned({ rotation: 0 }), true);
  assert.equal(axisAligned({}), true);
  assert.equal(axisAligned({ rotation: 90 }), true);
  assert.equal(axisAligned({ rotation: -180 }), true);
  assert.equal(axisAligned({ rotation: 270.001 }), true);
  assert.equal(axisAligned({ rotation: 12 }), false);
  assert.equal(axisAligned({ rotation: 45 }), false);
});

Deno.test("an upright selection draws its outline and handles on whole pixels", () => {
  const t = setup([createLayer("shape", { shape: "rect", x: 401.3, y: 300.9, w: 333.3, h: 211.1 })]);
  t.store.select([t.ids[0]]);
  t.overlay.update();
  const sel = t.group("ed-g-sel").children;
  assert.equal(sel.length, 2, "halo and line");
  for (const v of nums(sel[1].attrs.d)) assert.equal(frac(v), 0.5, `outline at ${v}`);
  const handles = t.group("ed-g-handles");
  const cornersG = handles.children.find((c) => c.attrs.class === "ed-corners");
  assert.equal(cornersG.children.length, 4);
  for (const r of cornersG.children) {
    assert.equal(r.attrs.width, "10");
    assert.equal(frac(Number(r.attrs.x)), 0.5, "corner handle edges on pixel centers");
    assert.equal(frac(Number(r.attrs.y)), 0.5);
  }
  // Each corner handle is centered on its outline corner.
  const pts = nums(sel[1].attrs.d);
  const xs = new Set([pts[0], pts[2]]);
  for (const r of cornersG.children) assert.ok(xs.has(Number(r.attrs.x) + 5));
  // The rotation knob and its stem sit on the same pixel column.
  const knob = handles.children.find((c) => c.attrs.class === "ed-knob");
  const stem = handles.children.find((c) => c.attrs.class === "ed-knob-stem");
  const kx = nums(knob.attrs.transform)[0];
  const [sx, , ex] = nums(stem.attrs.d);
  assert.equal(sx, ex, "the stem is a straight vertical line");
  assert.equal(sx, kx);
});

Deno.test("a rotated selection is left exactly where it is", () => {
  const t = setup([createLayer("shape", { shape: "rect", x: 400, y: 300, w: 300, h: 200, rotation: 17 })]);
  t.store.select([t.ids[0]]);
  t.overlay.update();
  const d = t.group("ed-g-sel").children[1].attrs.d;
  assert.ok(nums(d).some((v) => frac(v) !== 0.5), "no snapping on a tilted box");
});

Deno.test("hover gets a halo so it reads on light pictures; guides land on whole pixels", () => {
  const t = setup([createLayer("shape", { shape: "rect", x: 300, y: 300, w: 200, h: 200 }), createLayer("shape", { shape: "rect", x: 800, y: 300, w: 200, h: 200 })], { dpr: 2 });
  t.core.state.hoverId = t.ids[1];
  t.core.state.guides = [{ axis: "x", v: 640.37, from: 0, to: 720, canvas: true, center: true }];
  t.overlay.update();
  const hover = t.group("ed-g-hover").children;
  assert.deepEqual(
    hover.map((p) => p.attrs.class),
    ["ed-hover ed-halo", "ed-hover"],
  );
  const guide = t.group("ed-g-snap").children[1];
  const x = nums(guide.attrs.d)[0];
  // 1.25 px at 2x is two device pixels: on a device pixel edge.
  assert.equal(frac(x * 2), 0);
  assert.equal(t.core.pillsEl.children[0]?.textContent, "Center");
});

Deno.test("the marquee rectangle sits on pixel centers", () => {
  const t = setup([]);
  t.core.state.marquee = { x0: 10.2, y0: 20.8, x1: 110.6, y1: 70.1 };
  t.overlay.update();
  const m = t.group("ed-g-marquee").children[0];
  assert.equal(frac(Number(m.attrs.x)), 0.5);
  assert.equal(frac(Number(m.attrs.y)), 0.5);
  assert.equal(frac(Number(m.attrs.width)), 0);
  assert.ok(Number(m.attrs.width) >= 99 && Number(m.attrs.width) <= 101);
});

Deno.test("size pills stay clear of the chrome: above the box when the zoom island is below it", () => {
  const chrome = { top: 68, right: 316, bottom: 64, left: 72 };
  const t = setup([createLayer("shape", { shape: "rect", x: 700, y: 560, w: 600, h: 520 })], { zoom: 1, panX: 0, panY: 0, width: 1600, height: 900, insets: chrome });
  t.store.select([t.ids[0]]);
  t.core.state.gesture = { kind: "resize", pill: "600 × 520", pillAt: null };
  t.overlay.update();
  const pill = t.core.pillsEl.children[0];
  assert.equal(pill.textContent, "600 × 520");
  const [x, y] = nums(pill.style.transform);
  assert.ok(y + 22 <= 900 - chrome.bottom, `pill top ${y} keeps it above the zoom island`);
  assert.equal(y, 300 - 12 - 22, "just above the box");
  assert.equal(x, 700);
  // Room below: it stays under the box, past the rotation knob.
  const t2 = setup([createLayer("shape", { shape: "rect", x: 700, y: 300, w: 600, h: 200 })], { zoom: 1, panX: 0, panY: 0, width: 1600, height: 900, insets: chrome });
  t2.store.select([t2.ids[0]]);
  t2.core.state.gesture = { kind: "resize", pill: "600 × 200", pillAt: null };
  t2.overlay.update();
  const [, y2] = nums(t2.core.pillsEl.children[0].style.transform);
  assert.ok(y2 > 400 + 26, "below the knob");
  // The rotation pill near the right edge flips to the left of the pointer.
  t2.core.state.gesture = { kind: "rotate", pill: "45°", pillAt: "pointer" };
  t2.core.state.pointer = { x: 1250, y: 300 };
  t2.overlay.update();
  const p = t2.core.pillsEl.children[0];
  assert.match(p.style.transform, /translate\(-100%, 0\)$/);
  // A Center pill never hides under the top bar when the artboard top is off screen.
  const t3 = setup([], { zoom: 2, panX: -500, panY: -400, width: 1600, height: 900, insets: chrome });
  t3.core.state.guides = [{ axis: "x", v: 640, from: 0, to: 720, canvas: true, center: true }];
  t3.overlay.update();
  const [, cy] = nums(t3.core.pillsEl.children[0].style.transform);
  assert.ok(cy >= chrome.top, `Center pill at ${cy}`);
});
