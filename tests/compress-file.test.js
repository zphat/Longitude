// Run: deno test --allow-read tests/compress-file.test.js
// readImageFile / fileToCanvas with a fake decoder and fake canvases: big
// images keep their natural size up to the browser's canvas limits, and a
// browser that refuses a big canvas (Safari) gets a smaller one.
import { assert, assertEquals } from "./compress-assert.js";

class FakeCanvas {
  constructor(width, height) {
    this.width = Math.round(width);
    this.height = Math.round(height);
    this.draws = [];
  }
  getContext() {
    const self = this;
    return {
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "low",
      drawImage(src, ...args) {
        self.draws.push({ from: [src.width, src.height], args });
      },
    };
  }
}

// Safari: no 2D context for a canvas over 16.7 MP.
class SafariCanvas extends FakeCanvas {
  getContext() {
    return this.width * this.height > 16_777_216 ? null : super.getContext();
  }
}

const SIZES = new Map();
globalThis.createImageBitmap = async (file) => {
  const size = SIZES.get(file.name);
  if (!size) throw Error("not an image");
  return { width: size[0], height: size[1], close() {} };
};
globalThis.OffscreenCanvas = FakeCanvas;

const { readImageFile, fileToCanvas } = await import("../web/js/features/compress.js");

function photo(name, w, h) {
  SIZES.set(name, [w, h]);
  return new File([new Uint8Array(8)], name, { type: "image/jpeg" });
}

Deno.test("big photos keep their natural size", async () => {
  for (const [w, h] of [[8064, 6048], [9504, 6336], [16384, 4000]]) {
    const r = await readImageFile(photo(`p${w}.jpg`, w, h));
    assertEquals([r.canvas.width, r.canvas.height], [w, h], `${w} x ${h}`);
    assertEquals([r.naturalWidth, r.naturalHeight, r.capped], [w, h, false]);
  }
});

Deno.test("past the canvas limit it shrinks and says so", async () => {
  const r = await readImageFile(photo("pano.jpg", 20000, 1000));
  assertEquals([r.canvas.width, r.canvas.height], [16384, 819]);
  assertEquals([r.naturalWidth, r.naturalHeight, r.capped], [20000, 1000, true]);
});

Deno.test("maxSide still caps for callers that ask (fileToCanvas)", async () => {
  const c = await fileToCanvas(photo("phone.jpg", 8064, 6048), { maxSide: 4096 });
  assertEquals([c.width, c.height], [4096, 3072]);
});

Deno.test("a refused canvas falls back to one Safari takes, in one draw", async () => {
  globalThis.OffscreenCanvas = SafariCanvas;
  try {
    const r = await readImageFile(photo("dslr.jpg", 9000, 9000));
    assertEquals([r.canvas.width, r.canvas.height], [4096, 4096]);
    assertEquals([r.naturalWidth, r.capped], [9000, true]);
    assertEquals(r.canvas.draws.length, 1);
    assertEquals(r.canvas.draws[0].from, [9000, 9000]);
    const small = await readImageFile(photo("ok.jpg", 4000, 3000));
    assertEquals([small.canvas.width, small.capped], [4000, false]);
  } finally {
    globalThis.OffscreenCanvas = FakeCanvas;
  }
});

Deno.test("an image with no size is an error", async () => {
  let message = "";
  try {
    await readImageFile(photo("empty.jpg", 0, 0));
  } catch (err) {
    message = err.message;
  }
  assert(/no size/.test(message), message);
});
