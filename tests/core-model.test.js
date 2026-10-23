// Tests for web/js/core/model.js
//   deno test --allow-read tests/core-model.test.js

import assert from "node:assert/strict";
import {
  BLEND_MODES,
  DEFAULTS,
  LAYER_TYPES,
  assetIdsOf,
  cloneLayer,
  createDoc,
  createLayer,
  deepEqual,
  isColor,
  normAngle,
  normalizeDoc,
  normalizeLayer,
  uid,
} from "../web/js/core/model.js";

Deno.test("uid: prefix plus 12 base36 characters, unique", () => {
  const a = uid("lyr");
  assert.match(a, /^lyr_[0-9a-z]{12}$/);
  const seen = new Set(Array.from({ length: 500 }, () => uid("x")));
  assert.equal(seen.size, 500);
});

Deno.test("createDoc: spec defaults", () => {
  const d = createDoc();
  assert.equal(d.v, 1);
  assert.match(d.id, /^doc_/);
  assert.equal(d.name, "Untitled thumbnail");
  assert.equal(d.width, 1280);
  assert.equal(d.height, 720);
  assert.equal(d.preset, "yt-thumb");
  assert.deepEqual(d.background, { kind: "color", color: "#0b0c0b" });
  assert.deepEqual(d.layers, []);
  assert.ok(d.meta.created > 0 && d.meta.updated >= d.meta.created);
});

Deno.test("createDoc: custom size clamps, has no preset unless given", () => {
  const d = createDoc({ width: 3000.4, height: 2, name: "  Cover  " });
  assert.equal(d.width, 3000);
  assert.equal(d.height, 16);
  assert.equal(d.preset, null);
  assert.equal(d.name, "Cover");
  assert.equal(createDoc({ width: 3000, height: 3000, preset: "spotify-cover" }).preset, "spotify-cover");
  assert.equal(createDoc({ preset: null }).preset, null);
  assert.deepEqual(createDoc({ background: { kind: "transparent" } }).background, { kind: "transparent" });
});

Deno.test("createLayer: full defaults, new ids, names by type", () => {
  const names = { image: "Image", text: "Text", shape: "Rectangle", path: "Drawing", arrow: "Arrow" };
  for (const type of LAYER_TYPES) {
    const l = createLayer(type);
    assert.equal(l.type, type);
    assert.match(l.id, /^lyr_/);
    assert.equal(l.name, names[type]);
    for (const k of Object.keys(DEFAULTS.base)) assert.ok(k in l, `${type} has ${k}`);
    for (const k of Object.keys(DEFAULTS[type])) assert.ok(k in l, `${type} has ${k}`);
    assert.deepEqual(l.shadow, DEFAULTS.base.shadow);
    assert.deepEqual(l.glow, DEFAULTS.base.glow);
  }
  assert.equal(createLayer("shape", { shape: "ellipse" }).name, "Circle");
  assert.equal(createLayer("shape", { shape: "bubble" }).name, "Speech bubble");
  assert.equal(createLayer("shape", { shape: "mod.heart" }).name, "Shape");
  assert.equal(createLayer("text", { name: "Title" }).name, "Title");
  assert.notEqual(createLayer("text").id, createLayer("text").id);
});

Deno.test("createLayer: text defaults match the spec", () => {
  const t = createLayer("text");
  assert.equal(t.text, "Your text");
  assert.equal(t.font, "Anton");
  assert.equal(t.weight, 400);
  assert.equal(t.size, 140);
  assert.equal(t.align, "center");
  assert.equal(t.lineHeight, 1.05);
  assert.deepEqual(t.stroke, { on: true, color: "#000000", width: 10 });
  assert.deepEqual(t.stroke2, { on: false, color: "#d1ff4a", width: 10 });
  assert.deepEqual(t.bg, { on: false, color: "#000000", opacity: 1, padX: 28, padY: 14, radius: 18 });
  assert.deepEqual(t.gradient, { on: false, from: "#ffe14d", to: "#ff7a1a", angle: 180 });
  assert.equal(t.wrap, "auto");
});

Deno.test("createLayer: nested props merge one level, unknown type throws", () => {
  const t = createLayer("text", { stroke: { color: "#FF0000" }, x: 10 });
  assert.deepEqual(t.stroke, { on: true, color: "#ff0000", width: 10 });
  assert.equal(t.x, 10);
  const s = createLayer("shape", { fill: { color: "#123" } });
  assert.deepEqual(s.fill, { on: true, color: "#123" });
  assert.throws(() => createLayer("video"), /Unknown layer type/);
});

Deno.test("cloneLayer: deep copy with a new id and the same name", () => {
  const a = createLayer("path", { points: [[0, 0, 0.5], [1, 1, 0.5]], name: "Squiggle" });
  const b = cloneLayer(a);
  assert.notEqual(a.id, b.id);
  assert.equal(b.name, "Squiggle");
  b.points[0][0] = 0.5;
  b.shadow.on = true;
  assert.equal(a.points[0][0], 0);
  assert.equal(a.shadow.on, false);
});

Deno.test("normalizeLayer: clamps numbers and keeps types", () => {
  const l = normalizeLayer({
    type: "text",
    id: "lyr_ok",
    opacity: 4,
    size: "200",
    weight: 651.7,
    letterSpacing: -900,
    lineHeight: 0,
    w: -5,
    x: Infinity,
    flipX: "yes",
    shadow: { on: true, blur: -3, opacity: 2, dx: 1e9 },
    bg: { padX: 99999 },
  });
  assert.equal(l.id, "lyr_ok");
  assert.equal(l.opacity, 1);
  assert.equal(l.size, 200);
  assert.equal(l.weight, 652);
  assert.equal(l.letterSpacing, -200);
  assert.equal(l.lineHeight, 0.5);
  assert.equal(l.w, 1);
  assert.equal(l.x, DEFAULTS.base.x);
  assert.equal(l.flipX, false);
  assert.deepEqual(l.shadow, { on: true, color: "#000000", opacity: 1, blur: 0, dx: 2000, dy: 10 });
  assert.equal(l.bg.padX, 2000);
});

Deno.test("normalizeLayer: rotation lands in (-180, 180]", () => {
  const r = (v) => normalizeLayer({ type: "shape", rotation: v }).rotation;
  assert.equal(r(270), -90);
  assert.equal(r(-180), 180);
  assert.equal(r(540), 180);
  assert.equal(r(-190), 170);
  assert.equal(r(360), 0);
  assert.equal(r("nope"), 0);
  assert.equal(normAngle(-0), 0);
  assert.ok(Object.is(normAngle(-360), 0));
});

Deno.test("normalizeLayer: colours accept #rgb, #rrggbb, #rrggbbaa only", () => {
  assert.ok(isColor("#abc") && isColor("#A1B2C3") && isColor("#a1b2c3d4"));
  assert.ok(!isColor("#abcd") && !isColor("red") && !isColor("#12345") && !isColor("rgb(0,0,0)") && !isColor(null));
  const l = normalizeLayer({ type: "shape", fill: { color: "#ABC" }, stroke: { color: "blue" }, shadow: { color: "#11223344" } });
  assert.equal(l.fill.color, "#abc");
  assert.equal(l.stroke.color, DEFAULTS.shape.stroke.color);
  assert.equal(l.shadow.color, "#11223344");
  const t = normalizeLayer({ type: "text", gradient: { from: "#fff", to: "nope" } });
  assert.equal(t.gradient.from, "#fff");
  assert.equal(t.gradient.to, DEFAULTS.text.gradient.to);
});

Deno.test("normalizeLayer: unknown fields dropped, enums checked", () => {
  const l = normalizeLayer({ type: "arrow", hacked: true, head: "spear", tail: "dot", blend: "plus", shadow: { extra: 1 } });
  assert.equal("hacked" in l, false);
  assert.equal("extra" in l.shadow, false);
  assert.equal(l.head, "triangle");
  assert.equal(l.tail, "dot");
  assert.equal(l.blend, "normal");
  assert.ok(BLEND_MODES.some((b) => b.id === "soft-light"));
  assert.equal(normalizeLayer({ type: "text", align: "justify", wrap: "fixed" }).align, "center");
  assert.equal(normalizeLayer({ type: "text", wrap: "fixed" }).wrap, "fixed");
});

Deno.test("normalizeLayer: junk gives null, missing id is repaired", () => {
  assert.equal(normalizeLayer(null), null);
  assert.equal(normalizeLayer([]), null);
  assert.equal(normalizeLayer({ type: "video" }), null);
  const l = normalizeLayer({ type: "image", id: "bad id with spaces" });
  assert.match(l.id, /^lyr_/);
});

Deno.test("normalizeLayer: image fields", () => {
  const l = normalizeLayer({ type: "image", asset: "ast_abc123", mask: "<script>", crop: { x: 0.8, y: -1, w: 0.9, h: 2 }, frame: "ellipse", filters: [{ id: "grain", params: { amount: 30, bad: {} } }, { id: "Bad Id" }] });
  assert.equal(l.asset, "ast_abc123");
  assert.equal(l.mask, null);
  assert.equal(l.crop.x, 0.8);
  assert.ok(Math.abs(l.crop.w - 0.2) < 1e-9);
  assert.equal(l.crop.y, 0);
  assert.equal(l.crop.h, 1);
  assert.equal(l.frame, "ellipse");
  assert.deepEqual(l.filters, [{ id: "grain", params: { amount: 30 } }]);
  assert.equal(normalizeLayer({ type: "image", mask: "ast_m1" }).mask, "ast_m1");
});

Deno.test("normalizeLayer: path points and arrow endpoints", () => {
  const p = normalizeLayer({ type: "path", points: [[0, 0], [0.5, "x"], "nope", [1, 1, 3], [0.2, 0.3, -1]] });
  assert.deepEqual(p.points, [[0, 0, 0.5], [1, 1, 1], [0.2, 0.3, 0]]);
  const a = normalizeLayer({ type: "arrow", a: [0.1, 0.2], b: "x", c: [0.5, 0.9] });
  assert.deepEqual(a.a, [0.1, 0.2]);
  assert.deepEqual(a.b, DEFAULTS.arrow.b);
  assert.deepEqual(a.c, [0.5, 0.9]);
  assert.equal(normalizeLayer({ type: "arrow", c: [1] }).c, null);
  assert.equal(normalizeLayer({ type: "arrow" }).c, null);
});

Deno.test("normalizeLayer: text and shape strings", () => {
  const t = normalizeLayer({ type: "text", text: "a\r\nb", font: 'Bad"; font' });
  assert.equal(t.text, "a\nb");
  assert.equal(t.font, "Bad font");
  assert.equal(normalizeLayer({ type: "text", font: "" }).font, "Anton");
  const s = normalizeLayer({ type: "shape", shape: "my-mod.heart", params: { points: 7, label: "x", nested: { a: 1 } } });
  assert.equal(s.shape, "my-mod.heart");
  assert.deepEqual(s.params, { points: 7, label: "x" });
  assert.equal(normalizeLayer({ type: "shape", shape: "Not An Id" }).shape, "rect");
});

Deno.test("normalizeDoc: fills defaults, repairs duplicate and missing ids, drops junk layers", () => {
  const d = normalizeDoc({
    name: "",
    width: 99999,
    height: "720",
    background: { kind: "gradient", from: "#000", to: "#fff" },
    layers: [{ type: "text", id: "same" }, { type: "shape", id: "same" }, { type: "nope" }, null, { type: "arrow" }],
    extra: 1,
  });
  assert.equal(d.name, "Untitled thumbnail");
  assert.equal(d.width, 8192);
  assert.equal(d.height, 720);
  assert.equal(d.preset, null);
  assert.deepEqual(d.background, { kind: "gradient", from: "#000", to: "#fff", angle: 135 });
  assert.equal(d.layers.length, 3);
  const ids = d.layers.map((l) => l.id);
  assert.equal(new Set(ids).size, 3);
  assert.equal(ids[0], "same");
  assert.equal("extra" in d, false);
  assert.match(d.id, /^doc_/);
});

Deno.test("normalizeDoc: recoverable problems never throw", () => {
  const d = normalizeDoc({ width: 640, layers: "nope", background: { kind: "plaid" }, meta: { created: "x" } });
  assert.deepEqual(d.layers, []);
  assert.deepEqual(d.background, { kind: "color", color: "#0b0c0b" });
  assert.ok(d.meta.created > 0);
  assert.equal(normalizeDoc({ layers: [] }).width, 1280);
});

Deno.test("normalizeDoc: unusable input throws a plain message", () => {
  assert.throws(() => normalizeDoc(null), /not a Longitude design/);
  assert.throws(() => normalizeDoc("x"), /not a Longitude design/);
  assert.throws(() => normalizeDoc({ hello: 1 }), /does not contain a design/);
});

Deno.test("normalizeDoc: round-trips its own output", () => {
  const d = createDoc();
  d.layers.push(createLayer("text"), createLayer("image", { asset: "ast_a", mask: "ast_b" }), createLayer("arrow", { c: [0.5, 0.1] }));
  const n = normalizeDoc(structuredClone(d));
  assert.ok(deepEqual(n, d));
  assert.deepEqual([...assetIdsOf(n)], ["ast_a", "ast_b"]);
});
