// Tests for the pure parts of web/js/editor/importer.js and clipboard.js
//   deno test --allow-read tests/editor-import.test.js

import assert from "node:assert/strict";
import { createDoc, createLayer } from "../web/js/core/model.js";
import { classifyFile, placeImage, nameFromFile, dragKind } from "../web/js/editor/importer.js";
import { CLIP_KEY, serializeLayers, parseLayers, pasteOffset, textLayerFrom } from "../web/js/editor/clipboard.js";

const file = (name, type = "") => ({ name, type });

Deno.test("classifyFile", () => {
  assert.equal(classifyFile(file("a.png", "image/png")), "image");
  assert.equal(classifyFile(file("photo.HEIC", "")), "image");
  assert.equal(classifyFile(file("logo.svg", "image/svg+xml")), "image");
  assert.equal(classifyFile(file("Bangers.woff2", "font/woff2")), "font");
  assert.equal(classifyFile(file("x.otf", "application/vnd.ms-opentype")), "font");
  assert.equal(classifyFile(file("x.ttf", "")), "font");
  assert.equal(classifyFile(file("design.longitude", "")), "project");
  assert.equal(classifyFile(file("notes.txt", "text/plain")), "other");
  assert.equal(classifyFile(file("", "")), "image");
});

Deno.test("placeImage: fills an empty canvas when the aspect matches", () => {
  const doc = createDoc();
  assert.deepEqual(placeImage(doc, 1920, 1080, { fill: true }), { x: 640, y: 360, w: 1280, h: 720 });
  // 4 % off: fits instead
  const fitted = placeImage(doc, 1920, 1124, { fill: true });
  assert.ok(fitted.h <= 720 * 0.7 + 1e-9);
});

Deno.test("placeImage: fits inside 70 % of the canvas, centred or at a point", () => {
  const doc = createDoc();
  const big = placeImage(doc, 4000, 1000);
  assert.ok(big.w <= 1280 * 0.7 + 1e-9);
  assert.equal(big.x, 640);
  const small = placeImage(doc, 200, 100, { at: { x: 100, y: 90 } });
  assert.equal(small.w, 400);
  assert.equal(small.x, 100);
  const tiny = placeImage(doc, 20, 20);
  assert.equal(tiny.w, 40);
  const mid = placeImage(doc, 640, 360);
  assert.equal(mid.w, 896);
  const second = placeImage(doc, 200, 100, { index: 1 });
  assert.equal(second.x, 664);
});

Deno.test("nameFromFile", () => {
  assert.equal(nameFromFile("beach-day.jpg"), "beach-day");
  assert.equal(nameFromFile("image.png"), "Image");
  assert.equal(nameFromFile(""), "Image");
});

Deno.test("clipboard envelope round trip", () => {
  const a = createLayer("shape", { x: 100, y: 100 });
  const text = serializeLayers([a]);
  assert.ok(text.includes(CLIP_KEY));
  const back = parseLayers(text);
  assert.equal(back.length, 1);
  assert.equal(back[0].x, 100);
  assert.equal(parseLayers("hello"), null);
  assert.equal(parseLayers(`{"${CLIP_KEY}": 3}`), null);
  assert.equal(parseLayers(`{"${CLIP_KEY}": [{"type": "nope"}]}`), null);
});

Deno.test("pasteOffset: steps, and recentres when off the canvas", () => {
  const doc = createDoc();
  const a = createLayer("shape", { x: 100, y: 100, w: 50, h: 50 });
  assert.deepEqual(pasteOffset([a], 2, doc), { dx: 48, dy: 48 });
  assert.deepEqual(pasteOffset([a], 0, doc), { dx: 0, dy: 0 });
  const far = createLayer("shape", { x: 5000, y: 5000, w: 50, h: 50 });
  const o = pasteOffset([far], 1, doc);
  assert.equal(far.x + o.dx, 640);
  assert.equal(far.y + o.dy, 360);
});

Deno.test("textLayerFrom: sizes by length and wraps long text", () => {
  const doc = createDoc();
  const short = textLayerFrom("WAIT", doc);
  assert.equal(short.type, "text");
  assert.equal(short.size, 140);
  assert.equal(short.wrap, "auto");
  const long = textLayerFrom("This is a much longer line of pasted text from somewhere", doc);
  assert.equal(long.wrap, "fixed");
  assert.ok(long.size < 100);
  assert.equal(textLayerFrom("   ", doc), null);
});

Deno.test("dragKind: files, a link from another tab, or nothing to handle", () => {
  assert.equal(dragKind(["Files"]), "files");
  // Chrome adds Files to an image dragged from a page: that imports.
  assert.equal(dragKind(["text/uri-list", "text/html", "Files"]), "files");
  assert.equal(dragKind(["text/uri-list", "text/plain", "text/html"]), "link");
  assert.equal(dragKind(["text/x-moz-url", "text/uri-list", "text/plain"]), "link");
  assert.equal(dragKind(["text/plain"]), null);
  assert.equal(dragKind(undefined), null);
});
