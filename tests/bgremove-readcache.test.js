// The opt-in pixel cache of readPixels in web/js/features/bgremove/mask.js:
// only callers that ask keep pixels, at most two images, none over the budget.
// Run: deno test --allow-read tests/bgremove-readcache.test.js
import { clearReadCache, magicMask, readPixels } from "../web/js/features/bgremove/mask.js";

function eq(a, b, msg = "") {
  if (a !== b) throw new Error(`${msg} expected ${b}, got ${a}`);
}

// Deno has no ImageBitmap or OffscreenCanvas; stand-ins that count reads.
function withFakeCanvas(fn) {
  const saved = { ImageBitmap: globalThis.ImageBitmap, OffscreenCanvas: globalThis.OffscreenCanvas };
  const reads = new Map(); // source label -> getImageData count
  class FakeBitmap {
    constructor(label, width = 4, height = 4) {
      this.label = label;
      this.width = width;
      this.height = height;
    }
  }
  class FakeCanvas {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.drawn = null;
    }
    getContext() {
      const c = this;
      return {
        drawImage(src) {
          c.drawn = src;
        },
        getImageData(x, y, w, h) {
          const label = c.drawn?.label || "canvas";
          reads.set(label, (reads.get(label) || 0) + 1);
          return { width: w, height: h, data: new Uint8ClampedArray(Math.min(w * h, 64) * 4).fill(255) };
        },
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData() {},
      };
    }
  }
  globalThis.ImageBitmap = FakeBitmap;
  globalThis.OffscreenCanvas = FakeCanvas;
  try {
    return fn({ FakeBitmap, reads: (label) => reads.get(label) || 0 });
  } finally {
    clearReadCache(); // also stops its idle timer
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  }
}

Deno.test("readPixels keeps nothing unless asked", () => {
  withFakeCanvas(({ FakeBitmap, reads }) => {
    const a = new FakeBitmap("a");
    readPixels(a);
    readPixels(a);
    eq(reads("a"), 2);
    const p = readPixels(a, { cache: true });
    eq(readPixels(a, { cache: true }), p, "a cached read returns the same pixels");
    eq(reads("a"), 3);
  });
});

Deno.test("readPixels cache: two images, most recent first, a budget per image", () => {
  withFakeCanvas(({ FakeBitmap, reads }) => {
    const [a, b, c] = ["a", "b", "c"].map((l) => new FakeBitmap(l));
    for (const s of [a, b, a, c]) readPixels(s, { cache: true }); // the hit on a moves it to the front
    readPixels(a, { cache: true });
    eq(reads("a"), 1, "a stayed");
    readPixels(b, { cache: true });
    eq(reads("b"), 2, "b was dropped");
    const big = new FakeBitmap("big", 5000, 4000); // 20 MP
    readPixels(big, { cache: true });
    readPixels(big, { cache: true });
    eq(reads("big"), 2, "too big to keep");
    clearReadCache();
    readPixels(a, { cache: true });
    eq(reads("a"), 2, "cleared");
  });
});

Deno.test("magicMask keeps the image between clicks but not the base mask", () => {
  withFakeCanvas(({ FakeBitmap, reads }) => {
    const img = new FakeBitmap("img");
    for (let i = 0; i < 3; i++) magicMask(img, { x: 1, y: 1, baseMask: new FakeBitmap(`mask${i}`) });
    eq(reads("img"), 1, "the image is read once");
    eq(reads("mask0") + reads("mask1") + reads("mask2"), 3, "each base mask read once, not kept");
    readPixels(new FakeBitmap("other"), { cache: true });
    magicMask(img, { x: 1, y: 1 });
    eq(reads("img"), 1, "base masks no longer push the image out");
  });
});
