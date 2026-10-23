// compressFile / convertFile from web/js/ui/quicktools.js against a fake
// decoder and fake canvases, in a browser that cannot write WebP (Safari).
//   deno test --allow-read tests/export-quickfiles.test.js

import assert from "node:assert/strict";

class FakeCanvas {
  constructor(width, height) {
    this.width = Math.round(width);
    this.height = Math.round(height);
  }
  getContext() {
    return {
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "low",
      fillStyle: "#000",
      fillRect() {},
      drawImage() {},
      getImageData(x, y, w, h) {
        const data = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < w * h; i++) data.set([(i % w) * 2, 90, 200, 255], i * 4);
        return { width: w, height: h, data };
      },
    };
  }
  // Sizes in bytes, a thousandth of real ones so the blobs stay small. No WebP encoder.
  async convertToBlob({ type, quality }) {
    const out = type === "image/webp" ? "image/png" : type;
    const px = this.width * this.height;
    const bytes = out === "image/png" ? (px * 3) / 1000 : (px * (0.2 + 2 * quality)) / 1000;
    return new Blob([new Uint8Array(Math.max(1, Math.round(bytes)))], { type: out });
  }
}

const SIZES = new Map();
globalThis.createImageBitmap = async (file) => {
  const [width, height] = SIZES.get(file.name);
  return { width, height, close() {} };
};
globalThis.OffscreenCanvas = FakeCanvas;

const { compressFile, convertFile } = await import("../web/js/ui/quicktools.js");

function image(name, w, h, bytes, type = "image/jpeg") {
  SIZES.set(name, [w, h]);
  return new File([new Uint8Array(bytes)], name, { type });
}

Deno.test("Compress keeps a photo the browser could only shrink", async () => {
  const pano = image("pano.jpg", 20000, 1000, 1_000_000);
  const out = await compressFile(pano, {});
  assert.equal(out.kept, true);
  assert.equal(out.keptWhy, "capped");
  assert.equal(out.blob, pano);
  assert.deepEqual([out.srcW, out.srcH, out.width, out.height], [20000, 1000, 20000, 1000]);
});

Deno.test("Compress reports the natural size and the browser cap when it must shrink", async () => {
  const pano = image("pano2.jpg", 20000, 1000, 1_000_000);
  const fit = await compressFile(pano, { fit: true, fitMB: 0.5 });
  assert.equal(fit.kept, false);
  assert.deepEqual([fit.srcW, fit.srcH, fit.width, fit.height, fit.capped], [20000, 1000, 16384, 819, true]);
  const limited = await compressFile(pano, { limit: true, maxW: 1920, maxH: 1920 });
  assert.deepEqual([limited.srcW, limited.width, limited.height, limited.capped], [20000, 1920, 96, false]);
});

Deno.test("Compress no longer trims 48 MP photos", async () => {
  const out = await compressFile(image("phone.jpg", 8064, 6048, 1_000_000), {});
  assert.equal(out.kept, false);
  assert.deepEqual([out.srcW, out.width, out.height, out.capped], [8064, 8064, 6048, false]);
  assert.equal(out.name, "phone.jpg");
});

Deno.test("Compress with Keep saves WebP as PNG, or keeps the WebP when PNG is no smaller", async () => {
  const small = await compressFile(image("logo.webp", 100, 50, 100, "image/webp"), {});
  assert.equal(small.kept, true);
  assert.equal(small.keptWhy, "smaller");
  assert.equal(small.type, "image/webp");
  const big = await compressFile(image("big.webp", 100, 50, 500_000, "image/webp"), {});
  assert.equal(big.kept, false);
  assert.equal(big.type, "image/png");
  assert.equal(big.name, "big.png");
});

Deno.test("Resize or convert: Keep turns WebP into PNG here", async () => {
  const out = await convertFile(image("cover.webp", 400, 400, 5000, "image/webp"), {});
  assert.equal(out.type, "image/png");
  assert.equal(out.blob.type, "image/png");
  assert.equal(out.name, "cover-1280x720.png");
});

Deno.test("Resize or convert at Original size names a browser-capped file by its real size", async () => {
  const pano = await convertFile(image("wide.jpg", 20000, 1000, 1000), { size: "original" });
  assert.deepEqual([pano.srcW, pano.srcH, pano.width, pano.height, pano.capped], [20000, 1000, 16384, 819, true]);
  assert.equal(pano.name, "wide-16384x819.jpg");
  const phone = await convertFile(image("tall.jpg", 6048, 8064, 1000), { size: "original" });
  assert.deepEqual([phone.srcW, phone.width, phone.height, phone.capped], [6048, 6048, 8064, false]);
  assert.equal(phone.name, "tall.jpg");
});
