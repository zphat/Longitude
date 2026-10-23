// Run: deno test --allow-read tests/compress-target.test.js
// encodeToTarget against a fake canvas whose encoded size depends on pixel
// count and quality, so the search and downscale logic runs without a browser.
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
      fillStyle: "#000",
      fillRect() {},
      drawImage(src, ...args) {
        self.draws.push({ from: [src.width, src.height], args, quality: this.imageSmoothingQuality });
      },
      getImageData(x, y, w, h) {
        // Four flat stripes: an exact palette, so 256-colour PNG is tiny.
        const data = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < w * h; i++) {
          const band = Math.floor(((i % w) / w) * 4);
          data.set([band * 60, 255 - band * 60, 90, 255], i * 4);
        }
        return { width: w, height: h, data };
      },
    };
  }
  async convertToBlob({ type, quality }) {
    const px = this.width * this.height;
    const bytes = type === "image/png" ? px * 3 : Math.round(px * (0.2 + 2 * quality));
    return new Blob([new Uint8Array(bytes)], { type });
  }
}

globalThis.OffscreenCanvas = FakeCanvas;
const { encodeToTarget, encode, resizeCanvas } = await import("../web/js/features/compress.js");

Deno.test("fits by quality alone when possible", async () => {
  const canvas = new FakeCanvas(1280, 720);
  const seen = [];
  const r = await encodeToTarget(canvas, { type: "image/webp", maxBytes: 1_200_000, onStep: (s) => seen.push(s) });
  assert(r.fits);
  assertEquals(r.scale, 1);
  assertEquals([r.width, r.height], [1280, 720]);
  assert(r.bytes <= 1_200_000);
  assert(r.quality > 0.5 && r.quality < 0.6, `quality ${r.quality}`);
  assert(r.steps.length <= 7, `${r.steps.length} steps`);
  assertEquals(seen.length, r.steps.length, "onStep fires once per encode");
  assertEquals(seen.map((s) => s.n), seen.map((_, i) => i + 1));
  assert(!("blob" in seen[0]), "steps carry no blobs");
});

Deno.test("downscales in 10% steps when quality is not enough", async () => {
  const canvas = new FakeCanvas(1280, 720);
  const r = await encodeToTarget(canvas, { type: "image/webp", maxBytes: 400_000 });
  assert(r.fits);
  assertEquals(r.scale, 0.6);
  assertEquals([r.width, r.height], [768, 432]);
  assert(r.bytes <= 400_000);
  assert(r.quality >= 0.35 && r.quality <= 0.51, `quality ${r.quality}`);
  const scales = [...new Set(r.steps.map((s) => s.scale))];
  assertEquals(scales, [1, 0.9, 0.8, 0.7, 0.6]);
});

Deno.test("reports the smallest attempt when nothing fits", async () => {
  const canvas = new FakeCanvas(1280, 720);
  const r = await encodeToTarget(canvas, { type: "image/webp", maxBytes: 1000, allowDownscale: false });
  assertEquals(r.fits, false);
  assertEquals(r.scale, 1);
  assertEquals(r.quality, 0.35);
  assertEquals(r.steps.length, 2);
});

Deno.test("JPG is flattened before encoding", async () => {
  const canvas = new FakeCanvas(200, 100);
  const r = await encodeToTarget(canvas, { type: "image/jpeg", maxBytes: 1_000_000, background: "#0b0c0b" });
  assert(r.fits);
  assertEquals(r.type, "image/jpeg");
  assertEquals(r.quality, 0.92);
});

Deno.test("PNG tries lossless, then a 256-colour palette", async () => {
  const canvas = new FakeCanvas(200, 100);
  const r = await encodeToTarget(canvas, { type: "image/png", maxBytes: 20_000 });
  assert(r.fits);
  assertEquals(r.type, "image/png");
  assertEquals(r.steps.map((s) => s.kind), ["lossless", "colors"]);
  assertEquals(r.colors, 256);
  assert(r.bytes < 2000, `indexed PNG of flat stripes is tiny (${r.bytes})`);
  const head = new Uint8Array(await r.blob.slice(0, 8).arrayBuffer());
  assertEquals([...head], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

Deno.test("PNG with a palette size starts from it", async () => {
  const canvas = new FakeCanvas(64, 32);
  const r = await encodeToTarget(canvas, { type: "image/png", colors: 128 });
  assertEquals(r.steps.map((s) => [s.kind, s.colors]), [["colors", 128]]);
});

Deno.test("minWidth stops the shrinking; fits is then false", async () => {
  const canvas = new FakeCanvas(1280, 720);
  const r = await encodeToTarget(canvas, { type: "image/webp", maxBytes: 400_000, minWidth: 1000 });
  assertEquals(r.fits, false);
  assert(r.steps.every((s) => s.width >= 1000), "never below the floor");
  assertEquals([...new Set(r.steps.map((s) => s.scale))], [1, 0.9, 0.8]);
});

Deno.test("an aborted search rejects", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  let name = "";
  try {
    await encodeToTarget(new FakeCanvas(100, 100), { type: "image/webp", maxBytes: 10, signal: ctrl.signal });
  } catch (err) {
    name = err.name;
  }
  assertEquals(name, "AbortError");
});

Deno.test("an unsupported format is a plain error, not a mislabelled file", async () => {
  const canvas = new FakeCanvas(10, 10);
  canvas.convertToBlob = async () => new Blob([new Uint8Array(4)], { type: "image/png" });
  let message = "";
  try {
    await encode(canvas, { type: "image/webp" });
  } catch (err) {
    message = err.message;
  }
  assert(/cannot save WebP/.test(message), message);
});

Deno.test("resizeCanvas halves in steps for big reductions", () => {
  const src = new FakeCanvas(4000, 2000);
  const out = resizeCanvas(src, 300, 150);
  assertEquals([out.width, out.height], [300, 150]);
  assertEquals(out.draws.length, 1);
  assertEquals(out.draws[0].quality, "high");
  // 4000 -> 2000 -> 1000 -> 500 (each a separate canvas), then 500 -> 300.
  assertEquals(out.draws[0].from, [500, 250]);
  const contain = resizeCanvas(new FakeCanvas(400, 100), 200, 200, { fit: "contain" });
  assertEquals(contain.draws[0].args.slice(4), [0, 75, 200, 50]);
  const tiny = resizeCanvas(new FakeCanvas(5000, 10), 1, 1, { fit: "contain" });
  assertEquals([tiny.width, tiny.height], [1, 1], "extreme aspect ratios terminate");
});
