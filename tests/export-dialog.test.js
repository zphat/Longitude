// Tests for the pure parts of web/js/ui/exportdialog.js
//   deno test --allow-read tests/export-dialog.test.js

import assert from "node:assert/strict";
import {
  slugify,
  exportBaseName,
  exportFileName,
  exportDims,
  exportDefaults,
  normalizeExportSettings,
  sizeLimit,
  limitLabel,
  platformLimits,
  shrinkFloor,
  exportWarnings,
  settingsKey,
  outputLabel,
  latestGuard,
  presetKey,
  MAX_EXPORT_SIDE,
  MAX_EXPORT_PIXELS,
} from "../web/js/ui/exportdialog.js";
import { createPresets } from "../web/js/features/presets.js";

const presets = createPresets(JSON.parse(await Deno.readTextFile(new URL("../web/presets/presets.json", import.meta.url))).presets);
const yt = presets.get("yt-thumb");
const album = presets.get("sp-album");
const podcast = presets.get("sp-podcast");

Deno.test("slugify makes short, safe, readable names", () => {
  assert.equal(slugify("Is this a scam?"), "is-this-a-scam");
  assert.equal(slugify("Untitled thumbnail"), "untitled-thumbnail");
  assert.equal(slugify("Crème brûlée!!"), "creme-brulee");
  assert.equal(slugify("Don’t stop"), "dont-stop");
  assert.equal(slugify("  --  "), "");
  assert.equal(slugify(null), "");
  assert.equal(slugify("猫の動画 2"), "猫の動画-2");
  const long = slugify("word ".repeat(40));
  assert.ok(long.length <= 60);
  assert.ok(!long.endsWith("-"));
});

Deno.test("file names carry the slug, the size and the right extension", () => {
  assert.equal(exportFileName("Is this a scam?", 1280, 720, "image/jpeg"), "is-this-a-scam-1280x720.jpg");
  assert.equal(exportFileName("", 1080, 1080, "image/png"), "longitude-1080x1080.png");
  assert.equal(exportFileName("Cover", 3000, 3000, "image/webp"), "cover-3000x3000.webp");
  assert.equal(exportBaseName("A/B: c", 640, 360), "a-b-c-640x360");
});

Deno.test("exportDims follows the scale and keeps the aspect", () => {
  assert.deepEqual(exportDims(1280, 720, { scale: "1" }), { width: 1280, height: 720, capped: false });
  assert.deepEqual(exportDims(1280, 720, { scale: "0.5" }), { width: 640, height: 360, capped: false });
  assert.deepEqual(exportDims(1280, 720, { scale: "2" }), { width: 2560, height: 1440, capped: false });
  assert.deepEqual(exportDims(1280, 720, { scale: "3" }), { width: 3840, height: 2160, capped: false });
  assert.deepEqual(exportDims(1280, 720, { scale: "custom", width: 1000 }), { width: 1000, height: 563, capped: false });
  assert.equal(exportDims(1280, 720, { scale: "custom", width: 3 }).width, 16);
  assert.equal(exportDims(1280, 720, { scale: "custom", width: "nope" }).width, 1280);
});

Deno.test("exportDims stays inside the canvas limits and matches the renderer's rounding", () => {
  const big = exportDims(8000, 8000, { scale: "3" });
  assert.equal(big.capped, true);
  assert.ok(big.width <= MAX_EXPORT_SIDE && big.height <= MAX_EXPORT_SIDE);
  assert.ok(big.width * big.height <= MAX_EXPORT_PIXELS);
  const strip = exportDims(8000, 16, { scale: "3" });
  assert.equal(strip.width, MAX_EXPORT_SIDE);
  assert.equal(strip.height, Math.round(16 * (MAX_EXPORT_SIDE / 8000)));
  for (const [w, h] of [[1280, 720], [1080, 1920], [3000, 3000], [2660, 1140], [333, 777]]) {
    for (const scale of ["0.5", "1", "2", "3"]) {
      const d = exportDims(w, h, { scale });
      assert.equal(d.height, Math.max(1, Math.round(h * (d.width / w))), `${w}x${h} @${scale}`);
      assert.ok(d.width <= MAX_EXPORT_SIDE && d.height <= MAX_EXPORT_SIDE);
      assert.ok(d.width * d.height <= MAX_EXPORT_PIXELS);
    }
  }
});

Deno.test("defaults come from the preset", () => {
  assert.deepEqual(exportDefaults(yt), { type: "image/jpeg", scale: "1", width: 1280, quality: 0.92, fit: true, fitMB: 2, png8: false });
  const none = exportDefaults(null);
  assert.equal(none.type, "image/png");
  assert.equal(none.fit, false);
  assert.equal(none.fitMB, 2);
});

Deno.test("normalizeExportSettings keeps valid saved values and repairs the rest", () => {
  const s = normalizeExportSettings(undefined, yt, 1280);
  assert.equal(s.type, "image/jpeg");
  assert.equal(s.fit, true);
  assert.equal(s.width, 1280);
  const saved = normalizeExportSettings({ type: "image/webp", scale: "2", quality: 0.7, fit: false, fitMB: 1.5, png8: true, width: 900 }, yt, 1280);
  assert.deepEqual(saved, { type: "image/webp", scale: "2", width: 900, quality: 0.7, fit: false, fitMB: 1.5, png8: true });
  const junk = normalizeExportSettings({ type: "image/gif", scale: 7, quality: 9, fit: "yes", fitMB: -1, width: 2 }, yt, 1280);
  assert.equal(junk.type, "image/jpeg");
  assert.equal(junk.scale, "1");
  assert.equal(junk.quality, 1);
  assert.equal(junk.fit, true);
  assert.equal(junk.fitMB, 2);
  assert.equal(junk.width, 1280);
  assert.equal(normalizeExportSettings({ scale: 2 }, yt, 1280).scale, "2");
});

Deno.test("sizeLimit uses the smaller of the preset limit and the fit target", () => {
  const off = { fit: false, fitMB: 1 };
  assert.equal(sizeLimit(yt, off), 2_000_000);
  assert.equal(sizeLimit(yt, { fit: true, fitMB: 1 }), 1_000_000);
  assert.equal(sizeLimit(yt, { fit: true, fitMB: 5 }), 2_000_000);
  assert.equal(sizeLimit(null, { fit: true, fitMB: 3 }), 3_000_000);
  assert.equal(sizeLimit(null, off), null);
  assert.equal(sizeLimit(podcast, off), null);
});

Deno.test("limitLabel reads like the platforms write it", () => {
  assert.equal(limitLabel(2_000_000), "2 MB");
  assert.equal(limitLabel(1_500_000), "1.5 MB");
  assert.equal(limitLabel(500_000), "500 KB");
  assert.equal(limitLabel(1_234_567), "1.3 MB");
});

Deno.test("platformLimits merges the table with preset fields", () => {
  assert.deepEqual(platformLimits(yt), { minWidth: 640 });
  assert.equal(platformLimits(null), null);
  assert.equal(platformLimits({ id: "x", export: {} }), null);
  assert.deepEqual(platformLimits({ id: "x", export: { minWidth: 100, maxSide: 900 } }), { minWidth: 100, maxSide: 900 });
});

const texts = (list) => list.map((w) => w.text);
const base = (over = {}) => ({ type: "image/jpeg", scale: "1", width: 1280, quality: 0.92, fit: false, fitMB: 2, png8: false, ...over });

Deno.test("exportWarnings: sizes and formats", () => {
  assert.deepEqual(exportWarnings({ preset: yt, settings: base(), dims: { width: 640, height: 360 } }), []);
  assert.deepEqual(texts(exportWarnings({ preset: yt, settings: base(), dims: { width: 600, height: 338 } })), ["YouTube thumbnail needs at least 640 px wide."]);
  assert.deepEqual(texts(exportWarnings({ preset: yt, settings: base({ type: "image/webp" }), dims: { width: 1280, height: 720 } })), ["YouTube thumbnail takes JPG or PNG."]);
  assert.deepEqual(texts(exportWarnings({ preset: album, settings: base({ type: "image/png" }), dims: { width: 12000, height: 12000 } })), [
    "Spotify album cover takes up to 10000 px per side.",
    "A very large export. It can take a few seconds.",
  ]);
  assert.deepEqual(texts(exportWarnings({ preset: podcast, settings: base(), dims: { width: 1080, height: 1080 } })), ["Spotify podcast cover looks best at 1400 × 1400 px or larger."]);
  const capped = exportWarnings({ preset: null, settings: base(), dims: { width: 16384, height: 16384, capped: true } });
  assert.equal(capped.length, 1);
  assert.equal(capped[0].kind, "info");
  assert.match(capped[0].text, /^Capped at 16384 × 16384/);
  assert.deepEqual(texts(exportWarnings({ preset: null, settings: base(), dims: { width: 9000, height: 9000 } })), ["A very large export. It can take a few seconds."]);
});

Deno.test("exportWarnings: transparency and file size", () => {
  const t = exportWarnings({ preset: null, settings: base(), dims: { width: 10, height: 10 }, transparent: true });
  assert.equal(t.length, 1);
  assert.equal(t[0].kind, "info");
  assert.match(t[0].text, /no transparency/);
  assert.deepEqual(exportWarnings({ preset: null, settings: base({ type: "image/png" }), dims: { width: 10, height: 10 }, transparent: true }), []);

  const dims = { width: 1280, height: 720 };
  const over = exportWarnings({ preset: yt, settings: base(), dims, result: { bytes: 2_500_000, fits: true, scale: 1 } });
  assert.deepEqual(texts(over), ["Over the 2 MB limit for YouTube thumbnail. Turn on Fit under."]);
  const failed = exportWarnings({ preset: yt, settings: base({ fit: true }), dims, result: { bytes: 2_500_000, fits: false, scale: 0.5 } });
  assert.deepEqual(texts(failed), ["Could not get under 2 MB. This is the smallest it gets."]);
  const shrunk = exportWarnings({ preset: yt, settings: base({ fit: true, fitMB: 0.1 }), dims, result: { bytes: 90_000, fits: true, scale: 0.8, width: 1024, height: 576 } });
  assert.deepEqual(texts(shrunk), ["Shrunk to 1024 × 576 to fit under 100 KB."]);
  assert.deepEqual(exportWarnings({ preset: yt, settings: base({ fit: true }), dims, result: { bytes: 400_000, fits: true, scale: 1 } }), []);
});

Deno.test("exportWarnings: a Fit under above the preset's limit is explained", () => {
  const dims = { width: 3840, height: 2160 };
  const five = base({ fit: true, fitMB: 5 });
  assert.deepEqual(texts(exportWarnings({ preset: yt, settings: five, dims, result: { bytes: 4_500_000, fits: true, scale: 1 } })), [
    "Over the 2 MB limit for YouTube thumbnail. Set Fit under to 2 MB or less.",
  ]);
  // The encoder aimed for 5 MB, so that is the number "could not get under" names.
  assert.deepEqual(texts(exportWarnings({ preset: yt, settings: five, dims, result: { bytes: 6_000_000, fits: false, scale: 0.5, width: 1920, height: 1080 } })), [
    "Could not get under 5 MB. This is the smallest it gets.",
    "Over the 2 MB limit for YouTube thumbnail. Set Fit under to 2 MB or less.",
  ]);
  assert.deepEqual(exportWarnings({ preset: yt, settings: five, dims, result: { bytes: 1_500_000, fits: true, scale: 1 } }), []);
});

Deno.test("exportWarnings: a file shrunk under the platform minimum warns", () => {
  const dims = { width: 1280, height: 720 };
  const tiny = exportWarnings({ preset: yt, settings: base({ fit: true, fitMB: 0.05 }), dims, result: { bytes: 49_000, fits: true, scale: 0.4, width: 512, height: 288 } });
  assert.deepEqual(texts(tiny), ["YouTube thumbnail needs at least 640 px wide.", "Shrunk to 512 × 288 to fit under 50 KB."]);
  assert.equal(tiny[0].kind, "warn");
  const fine = exportWarnings({ preset: yt, settings: base({ fit: true, fitMB: 0.2 }), dims, result: { bytes: 190_000, fits: true, scale: 0.6, width: 768, height: 432 } });
  assert.deepEqual(texts(fine), ["Shrunk to 768 × 432 to fit under 200 KB."]);
});

Deno.test("shrinkFloor is the platform's hard minimum only", () => {
  assert.deepEqual(shrinkFloor(yt), { minWidth: 640, minHeight: 0 });
  assert.deepEqual(shrinkFloor(album), { minWidth: 640, minHeight: 640 });
  assert.deepEqual(shrinkFloor(podcast), { minWidth: 0, minHeight: 0 }, "a soft minimum does not stop the shrinking");
  assert.deepEqual(shrinkFloor(null), { minWidth: 0, minHeight: 0 });
});

Deno.test("settingsKey ignores settings that do not change the file", () => {
  const dims = { width: 1280, height: 720 };
  const png = base({ type: "image/png" });
  assert.equal(settingsKey(png, dims), settingsKey({ ...png, quality: 0.5 }, dims));
  assert.notEqual(settingsKey(png, dims), settingsKey({ ...png, png8: true }, dims));
  const jpg = base();
  assert.notEqual(settingsKey(jpg, dims), settingsKey({ ...jpg, quality: 0.5 }, dims));
  assert.equal(settingsKey(jpg, dims), settingsKey({ ...jpg, png8: true }, dims));
  assert.equal(settingsKey(jpg, dims), settingsKey({ ...jpg, fitMB: 9 }, dims));
  assert.notEqual(settingsKey({ ...jpg, fit: true }, dims), settingsKey({ ...jpg, fit: true, fitMB: 9 }, dims));
  assert.notEqual(settingsKey(jpg, dims), settingsKey(jpg, { width: 640, height: 360 }));
});

Deno.test("outputLabel names the format and quality", () => {
  assert.equal(outputLabel({ type: "image/jpeg", quality: 0.84 }), "JPG · 84%");
  assert.equal(outputLabel({ type: "image/webp", quality: 0.9 }), "WebP · 90%");
  assert.equal(outputLabel({ type: "image/png", colors: 256 }), "PNG · 256 colors");
  assert.equal(outputLabel({ type: "image/png", colors: null }), "PNG · lossless");
  assert.equal(outputLabel(null), "");
});

Deno.test("latestGuard tells stale work from current work", () => {
  const g = latestGuard();
  const a = g.next();
  assert.equal(g.isCurrent(a), true);
  const b = g.next();
  assert.equal(g.isCurrent(a), false);
  assert.equal(g.isCurrent(b), true);
  assert.equal(g.value, b);
});

Deno.test("presetKey falls back for designs without a preset", () => {
  assert.equal(presetKey({ preset: "yt-thumb" }), "yt-thumb");
  assert.equal(presetKey({ preset: null }), "none");
  assert.equal(presetKey(null), "none");
});
