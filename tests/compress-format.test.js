// Run: deno test --allow-read tests/compress-format.test.js
import { assert, assertEquals } from "./compress-assert.js";
import {
  capDims,
  downscaleSteps,
  extFor,
  fitRects,
  flattenColor,
  formatBytes,
  labelFor,
  safeFileName,
  searchQuality,
  MAX_CANVAS_SIDE,
  MAX_CANVAS_PIXELS,
  SAFE_CANVAS_PIXELS,
} from "../web/js/features/compress.js";

Deno.test("formatBytes uses decimal units and never under-reports", () => {
  const cases = [
    [0, "0 B"],
    [-5, "0 B"],
    [NaN, "0 B"],
    [1, "1 B"],
    [999, "999 B"],
    [1000, "1.0 KB"],
    [1001, "1.1 KB"],
    [9950, "10.0 KB"],
    [99_999, "100 KB"],
    [512_000, "512 KB"],
    [999_999, "1.0 MB"],
    [1_000_000, "1.0 MB"],
    [1_400_000, "1.4 MB"],
    [1_999_999, "2.0 MB"],
    [2_000_000, "2.0 MB"],
    [2_000_001, "2.1 MB"],
    [2_040_000, "2.1 MB"],
    [12_345_678, "12.4 MB"],
    [150_000_000, "150 MB"],
    [3_200_000_000, "3.2 GB"],
  ];
  for (const [n, want] of cases) assertEquals(formatBytes(n), want, `formatBytes(${n})`);
});

Deno.test("anything over 2,000,000 bytes never reads as 2.0 MB or less", () => {
  for (let n = 2_000_001; n < 2_200_000; n += 997) {
    const shown = parseFloat(formatBytes(n));
    assert(shown > 2, `${n} -> ${formatBytes(n)}`);
  }
});

Deno.test("extensions and labels", () => {
  assertEquals(extFor("image/png"), "png");
  assertEquals(extFor("image/jpeg"), "jpg");
  assertEquals(extFor("image/webp"), "webp");
  assertEquals(extFor("IMAGE/JPEG"), "jpg");
  assertEquals(extFor("application/octet-stream"), "png");
  assertEquals(labelFor("image/jpeg"), "JPG");
  assertEquals(labelFor("image/webp"), "WebP");
});

Deno.test("safe file names", () => {
  assertEquals(safeFileName("My thumbnail", "image/jpeg"), "My thumbnail.jpg");
  assertEquals(safeFileName("cover.png", "image/jpeg"), "cover.jpg");
  assertEquals(safeFileName('a<b>:c"d/e\\f|g?h*', "image/png"), "a b c d e f g h.png");
  assertEquals(safeFileName("  ...hidden. ", "image/webp"), "hidden.webp");
  assertEquals(safeFileName("", "image/png"), "longitude.png");
  assertEquals(safeFileName("CON", "image/png"), "CON-image.png");
  assertEquals(safeFileName("plain"), "plain");
  assertEquals(safeFileName("x".repeat(300), "image/png").length, 124);
});

Deno.test("JPEG's other extensions are replaced, not doubled", () => {
  assertEquals(safeFileName("photo.jfif", "image/jpeg"), "photo.jpg");
  assertEquals(safeFileName("scan.JPE", "image/jpeg"), "scan.jpg");
  assertEquals(safeFileName("old.pjpeg", "image/jpeg"), "old.jpg");
  assertEquals(safeFileName("photo.jfif", "image/png"), "photo.png");
  assertEquals(safeFileName("photo.jpg", "image/jpeg"), "photo.jpg");
});

Deno.test("capDims shrinks only past the browser's canvas limits", () => {
  assertEquals(capDims(9504, 6336), { width: 9504, height: 6336, capped: false }, "61 MP camera");
  assertEquals(capDims(8064, 6048), { width: 8064, height: 6048, capped: false }, "48 MP phone");
  assertEquals(capDims(16384, 100), { width: 16384, height: 100, capped: false });
  assertEquals(capDims(20000, 1000), { width: 16384, height: 819, capped: true }, "panorama");
  const huge = capDims(30000, 30000);
  assert(huge.capped);
  assert(huge.width <= MAX_CANVAS_SIDE && huge.width * huge.height <= MAX_CANVAS_PIXELS, `${huge.width} x ${huge.height}`);
  assertEquals(capDims(9000, 9000, { maxPixels: SAFE_CANVAS_PIXELS }), { width: 4096, height: 4096, capped: true });
  assertEquals(capDims(8064, 6048, { maxSide: 4096 }), { width: 4096, height: 3072, capped: true });
});

Deno.test("flattenColor follows the document background", () => {
  assertEquals(flattenColor({ background: { kind: "color", color: "#0b0c0b" } }), "#0b0c0b");
  assertEquals(flattenColor({ background: { kind: "gradient", from: "#ff0000", to: "#00ff00" } }), "#ff0000");
  assertEquals(flattenColor({ background: { kind: "transparent" } }), "#ffffff");
  assertEquals(flattenColor(null), "#ffffff");
});

Deno.test("fit rectangles", () => {
  const cover = fitRects(2000, 1000, 500, 500, "cover");
  assertEquals(cover.src, { x: 500, y: 0, w: 1000, h: 1000 });
  assertEquals(cover.dst, { x: 0, y: 0, w: 500, h: 500 });
  const contain = fitRects(2000, 1000, 500, 500, "contain");
  assertEquals(contain.src, { x: 0, y: 0, w: 2000, h: 1000 });
  assertEquals(contain.dst, { x: 0, y: 125, w: 500, h: 250 });
  const stretch = fitRects(2000, 1000, 500, 500);
  assertEquals(stretch.dst, { x: 0, y: 0, w: 500, h: 500 });
});

Deno.test("downscale steps go down by 10% and stop at 16 px", () => {
  const steps = downscaleSteps(1280, 720);
  assertEquals(steps.map((s) => s.scale), [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1]);
  assertEquals(steps[0], { scale: 0.9, width: 1152, height: 648 });
  assertEquals(steps.at(-1), { scale: 0.1, width: 128, height: 72 });
  assertEquals(downscaleSteps(100, 20).map((s) => s.height), [18, 16]);
});

Deno.test("downscale steps stop at a platform's smallest size", () => {
  assertEquals(downscaleSteps(1280, 720, { minWidth: 640 }).at(-1), { scale: 0.5, width: 640, height: 360 });
  assertEquals(downscaleSteps(1280, 720, { minWidth: 640, minHeight: 640 }).map((s) => s.scale), [0.9]);
  assertEquals(downscaleSteps(640, 360, { minWidth: 640 }), []);
});

// A fake encoder whose size grows with quality.
function fakeEncoder(sizeAt) {
  const calls = [];
  const encodeAt = async (q) => {
    calls.push(q);
    return { quality: q, size: sizeAt(q) };
  };
  return { encodeAt, calls };
}

Deno.test("quality search finds the best fit in at most 7 encodes", async () => {
  const { encodeAt, calls } = fakeEncoder((q) => 1000 + 9000 * q);
  const { best, tries } = await searchQuality(encodeAt, { maxBytes: 6000, lo: 0.35, hi: 0.92 });
  assert(tries <= 7, `${tries} tries`);
  assertEquals(calls.length, tries);
  assertEquals(calls.slice(0, 2), [0.92, 0.35], "tests both ends first");
  assert(best.size <= 6000, "fits");
  assert(best.quality > 0.53 && best.quality <= 0.556, `quality ${best.quality} is close to the limit 0.556`);
});

Deno.test("quality search stops early when the top fits or the bottom does not", async () => {
  let f = fakeEncoder(() => 10);
  let r = await searchQuality(f.encodeAt, { maxBytes: 100, lo: 0.35, hi: 0.92 });
  assertEquals(r.tries, 1);
  assertEquals(r.best.quality, 0.92);

  f = fakeEncoder(() => 1000);
  r = await searchQuality(f.encodeAt, { maxBytes: 100, lo: 0.35, hi: 0.92 });
  assertEquals(r.tries, 2);
  assertEquals(r.best, null);
  assertEquals(r.smallest.size, 1000);

  f = fakeEncoder(() => 1000);
  r = await searchQuality(f.encodeAt, { maxBytes: 100, lo: 0.35, hi: 0.92, order: "lo-first" });
  assertEquals(r.tries, 1, "lo-first bails after one encode");
  assertEquals(f.calls, [0.35]);
});

Deno.test("quality search respects maxSteps", async () => {
  const { encodeAt } = fakeEncoder((q) => 1000 + 9000 * q);
  const r = await searchQuality(encodeAt, { maxBytes: 6000, lo: 0.1, hi: 1, maxSteps: 3 });
  assertEquals(r.tries, 3);
  assert(r.best && r.best.size <= 6000);
});
