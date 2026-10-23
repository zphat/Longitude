// Tests for the pure parts of web/js/ui/quicktools.js
//   deno test --allow-read tests/export-quicktools.test.js

import assert from "node:assert/strict";
import {
  isImageFile,
  fileType,
  outputTypeFor,
  stripExt,
  outputName,
  fitWithin,
  percentSaved,
  batchTotals,
  convertTarget,
  normalizeCompressSettings,
  normalizeConvertSettings,
  CONVERT_SIZES,
  QUICK_TOOLS,
} from "../web/js/ui/quicktools.js";

const f = (name, type = "") => ({ name, type, size: 10 });

Deno.test("isImageFile accepts images by type or extension", () => {
  assert.equal(isImageFile(f("a.png", "image/png")), true);
  assert.equal(isImageFile(f("a.JPG")), true);
  assert.equal(isImageFile(f("x.webp", "application/octet-stream")), true);
  assert.equal(isImageFile(f("pic", "image/heic")), true);
  assert.equal(isImageFile(f("notes.txt", "text/plain")), false);
  assert.equal(isImageFile(f("design.longitude", "application/json")), false);
  assert.equal(isImageFile(null), false);
});

Deno.test("fileType normalises MIME types and falls back to the extension", () => {
  assert.equal(fileType(f("a.jpg", "image/jpg")), "image/jpeg");
  assert.equal(fileType(f("a.jpeg", "image/pjpeg")), "image/jpeg");
  assert.equal(fileType(f("a.jfif")), "image/jpeg");
  assert.equal(fileType(f("a.SVG")), "image/svg+xml");
  assert.equal(fileType(f("a.webp", "image/webp")), "image/webp");
  assert.equal(fileType(f("a.bin")), "");
});

Deno.test("outputTypeFor keeps JPG and WebP, turns the rest into PNG", () => {
  assert.equal(outputTypeFor("keep", "image/jpeg"), "image/jpeg");
  assert.equal(outputTypeFor("keep", "image/webp"), "image/webp");
  assert.equal(outputTypeFor("keep", "image/png"), "image/png");
  assert.equal(outputTypeFor("keep", "image/gif"), "image/png");
  assert.equal(outputTypeFor("keep", "image/svg+xml"), "image/png");
  assert.equal(outputTypeFor("keep", ""), "image/png");
  assert.equal(outputTypeFor("image/webp", "image/png"), "image/webp");
  assert.equal(outputTypeFor("image/jpeg", "image/png"), "image/jpeg");
  assert.equal(outputTypeFor("image/gif", "image/jpeg"), "image/jpeg");
});

Deno.test("outputTypeFor: Keep saves WebP as PNG where the browser cannot write WebP", () => {
  assert.equal(outputTypeFor("keep", "image/webp", { webpOk: false }), "image/png");
  assert.equal(outputTypeFor("keep", "image/jpeg", { webpOk: false }), "image/jpeg");
  assert.equal(outputTypeFor("keep", "image/webp", { webpOk: true }), "image/webp");
  assert.equal(outputTypeFor("image/jpeg", "image/webp", { webpOk: false }), "image/jpeg");
});

Deno.test("stripExt and outputName", () => {
  assert.equal(stripExt("photo.final.jpeg"), "photo.final");
  assert.equal(stripExt(".hidden"), ".hidden");
  assert.equal(stripExt("C:\\pics\\holiday.png"), "holiday");
  assert.equal(stripExt("a/b/c.webp"), "c");
  assert.equal(stripExt("noext"), "noext");
  assert.equal(outputName("photo.png", "image/jpeg"), "photo.jpg");
  assert.equal(outputName("photo.png", "image/jpeg", "-1280x720"), "photo-1280x720.jpg");
  assert.equal(outputName("", "image/png"), "image.png");
  assert.equal(outputName("my.photo.webp", "image/webp"), "my.photo.webp");
});

Deno.test("fitWithin shrinks to fit, never enlarges", () => {
  assert.deepEqual(fitWithin(4000, 3000, 1920, 1920), { width: 1920, height: 1440, scaled: true });
  assert.deepEqual(fitWithin(800, 600, 1920, 1920), { width: 800, height: 600, scaled: false });
  assert.deepEqual(fitWithin(4000, 3000, 0, 1000), { width: 1333, height: 1000, scaled: true });
  assert.deepEqual(fitWithin(4000, 3000, null, null), { width: 4000, height: 3000, scaled: false });
  assert.deepEqual(fitWithin(1000, 10, 100, 100), { width: 100, height: 1, scaled: true });
});

Deno.test("percentSaved and batchTotals", () => {
  assert.equal(percentSaved(1000, 250), 75);
  assert.equal(percentSaved(1000, 1500), -50);
  assert.equal(percentSaved(0, 5), 0);
  assert.equal(percentSaved(1000, 1000), 0);
  assert.equal(percentSaved(900_000, 129), 99);
  assert.equal(percentSaved(1000, 0), 100);
  const t = batchTotals([
    { size: 1000, out: { bytes: 300 } },
    { size: 3000, out: { bytes: 700 } },
    { size: 5000, out: null },
  ]);
  assert.deepEqual(t, { count: 3, done: 2, before: 4000, after: 1000, saved: 75 });
  assert.deepEqual(batchTotals([]), { count: 0, done: 0, before: 0, after: 0, saved: 0 });
});

Deno.test("convertTarget resolves presets and custom sizes", () => {
  assert.equal(convertTarget({ size: "original" }), null);
  assert.deepEqual(convertTarget({ size: "1280x720" }), { width: 1280, height: 720 });
  assert.deepEqual(convertTarget({ size: "3000x3000" }), { width: 3000, height: 3000 });
  assert.deepEqual(convertTarget({ size: "custom", width: 500.4, height: 99999 }), { width: 500, height: 8000 });
  assert.equal(convertTarget({ size: "nope" }), null);
  assert.ok(CONVERT_SIZES.every((s) => s.id === "original" || s.id === "custom" || s.id === `${s.width}x${s.height}`));
});

Deno.test("settings normalisers repair saved prefs", () => {
  assert.deepEqual(normalizeCompressSettings({}), { format: "keep", quality: 0.8, fit: false, fitMB: 2, limit: false, maxW: 1920, maxH: 1920, png8: true });
  const c = normalizeCompressSettings({ format: "image/gif", quality: 4, fit: true, fitMB: 0, limit: "yes", maxW: 5, maxH: 1e9, png8: false });
  assert.equal(c.format, "keep");
  assert.equal(c.quality, 1);
  assert.equal(c.fit, true);
  assert.equal(c.fitMB, 0.05);
  assert.equal(c.limit, false);
  assert.equal(c.maxW, 16);
  assert.equal(c.maxH, 8000);
  assert.equal(c.png8, false);
  assert.deepEqual(normalizeConvertSettings({}), { size: "1280x720", width: 1280, height: 720, fit: "cover", bars: "black", format: "keep", quality: 0.92 });
  const v = normalizeConvertSettings({ size: "custom", width: 0, fit: "fill", bars: "red", format: "image/webp" });
  assert.equal(v.size, "custom");
  assert.equal(v.width, 1);
  assert.equal(v.fit, "cover");
  assert.equal(v.bars, "black");
  assert.equal(v.format, "image/webp");
});

Deno.test("the three quick tools have the command kinds", () => {
  assert.deepEqual(QUICK_TOOLS.map((t) => t.id), ["compress", "remove-bg", "convert"]);
});
