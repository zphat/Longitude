// Run: deno test --allow-read tests/bgremove-mask.test.js
import {
  alphaFromRGBA,
  brushRect,
  downsampleAlpha,
  edgeMagicAlpha,
  estimateBorder,
  featherAlpha,
  growAlpha,
  magicAlpha,
  oklab,
  paintAlpha,
  rgbaFromAlpha,
  toleranceToDistance,
} from "../web/js/features/bgremove/mask.js";

function assert(value, message = "assertion failed") {
  if (!value) throw Error(message);
}

function near(a, b, eps, message = "") {
  if (!(Math.abs(a - b) <= eps)) throw Error(`${message} expected ${b} ± ${eps}, got ${a}`);
}

// RGBA image filled by fn(x, y) -> [r, g, b, a?]
function image(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a = 255] = fn(x, y);
      data.set([r, g, b, a], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}

function alphaMap(w, h, fn) {
  const data = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = fn(x, y);
  return { width: w, height: h, data };
}

const at = (a, x, y) => a.data[y * a.width + x];

// Deterministic noise for "photo-like" pixels.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

Deno.test("oklab maps white, black and gray sensibly", () => {
  const w = oklab(255, 255, 255);
  near(w[0], 1, 1e-3, "white L");
  near(w[1], 0, 1e-3, "white a");
  near(w[2], 0, 1e-3, "white b");
  const k = oklab(0, 0, 0);
  near(k[0], 0, 1e-6, "black L");
  const g = oklab(128, 128, 128);
  assert(g[0] > 0.55 && g[0] < 0.65, `gray L ${g[0]}`);
  const red = oklab(255, 0, 0);
  assert(red[1] > 0.2, "red has positive a");
});

Deno.test("toleranceToDistance is monotonic and bounded", () => {
  let prev = -1;
  for (let t = 0; t <= 100; t += 5) {
    const d = toleranceToDistance(t);
    assert(d > prev, `not increasing at ${t}`);
    prev = d;
  }
  near(toleranceToDistance(-20), toleranceToDistance(0), 0, "clamps low");
  near(toleranceToDistance(500), toleranceToDistance(100), 0, "clamps high");
  assert(toleranceToDistance(0) < 0.01, "tolerance 0 is near exact");
});

// Left half white, right half red, with a white island inside the red.
const twoTone = image(20, 10, (x, y) => {
  if (x >= 14 && x <= 16 && y >= 3 && y <= 5) return [255, 255, 255];
  return x < 10 ? [255, 255, 255] : [220, 20, 30];
});

Deno.test("magicAlpha contiguous removes only the connected color", () => {
  const a = magicAlpha(twoTone, { x: 2, y: 2, tolerance: 20, contiguous: true, feather: 0 });
  assert(a.data.length === 200, "one byte per pixel");
  assert(at(a, 0, 0) === 0 && at(a, 9, 9) === 0, "white half removed");
  assert(at(a, 12, 2) === 255, "red kept");
  assert(at(a, 15, 4) === 255, "unconnected island kept");
});

Deno.test("magicAlpha global removes every match", () => {
  const a = magicAlpha(twoTone, { x: 2, y: 2, tolerance: 20, contiguous: false, feather: 0 });
  assert(at(a, 15, 4) === 0, "island removed");
  assert(at(a, 12, 2) === 255, "red kept");
});

Deno.test("magicAlpha multiplies into the base mask", () => {
  const base = alphaMap(20, 10, (x) => (x < 15 ? 200 : 100));
  const a = magicAlpha(twoTone, { x: 12, y: 1, tolerance: 20, feather: 0, base });
  assert(at(a, 2, 2) === 200, "white keeps base alpha");
  assert(at(a, 12, 1) === 0, "red removed");
  assert(at(a, 15, 4) === 100, "island keeps base alpha");
});

Deno.test("magicAlpha softens the border of the selection", () => {
  // A smooth ramp: pixels just past the tolerance are partly removed.
  const ramp = image(64, 1, (x) => [255 - x * 3, 255 - x * 3, 255 - x * 3]);
  const a = magicAlpha(ramp, { x: 0, y: 0, tolerance: 10, feather: 0 });
  const values = Array.from(a.data);
  assert(values[0] === 0, "seed removed");
  assert(values[63] === 255, "far end kept");
  assert(values.some((v) => v > 0 && v < 255), "has a soft edge");
  for (let i = 1; i < values.length; i++) assert(values[i] >= values[i - 1], "keep never decreases away from the seed");
});

Deno.test("magicAlpha with tolerance 0 still removes the clicked pixel", () => {
  const noisy = image(8, 8, (x, y) => [100 + ((x * 7 + y * 3) % 5), 100, 100]);
  const a = magicAlpha(noisy, { x: 3, y: 3, tolerance: 0, feather: 0 });
  assert(at(a, 3, 3) === 0, "seed removed");
});

// Light gray studio background with sensor noise and a dark subject touching nothing.
function studio(seed = 1) {
  const r = rng(seed);
  return image(60, 40, (x, y) => {
    if (x >= 20 && x < 40 && y >= 12 && y < 30) return [40, 30, 60];
    const n = Math.round((r() - 0.5) * 6);
    return [238 + n, 238 + n, 240 + n];
  });
}

Deno.test("estimateBorder finds the flat background", () => {
  const est = estimateBorder(studio());
  assert(!est.transparent, "opaque");
  assert(est.coverage > 0.95, `coverage ${est.coverage}`);
  near(est.lab[0], oklab(238, 238, 240)[0], 0.02, "background lightness");
  assert(est.spread < 0.03, `spread ${est.spread}`);
});

Deno.test("edgeMagicAlpha removes the background and keeps the subject", () => {
  const a = edgeMagicAlpha(studio(), { feather: 0 });
  assert(at(a, 0, 0) === 0 && at(a, 59, 39) === 0 && at(a, 10, 20) === 0, "background removed");
  assert(at(a, 30, 20) === 255 && at(a, 21, 13) === 255, "subject kept");
});

Deno.test("edgeMagicAlpha refuses busy edges and transparent images", () => {
  const r = rng(7);
  const busy = image(40, 30, () => [r() * 255, r() * 255, r() * 255]);
  let code = "";
  try {
    edgeMagicAlpha(busy);
  } catch (err) {
    code = err.code;
  }
  assert(code === "not-flat", `busy edges: ${code}`);
  const clear = image(20, 20, (x, y) => (x > 5 && x < 15 && y > 5 && y < 15 ? [10, 10, 10, 255] : [0, 0, 0, 0]));
  code = "";
  try {
    edgeMagicAlpha(clear);
  } catch (err) {
    code = err.code;
  }
  assert(code === "already-transparent", `transparent: ${code}`);
});

Deno.test("featherAlpha keeps flat areas and softens a hard edge", () => {
  const flat = alphaMap(16, 16, () => 200);
  const f0 = featherAlpha(flat, 6);
  assert(f0.data.every((v) => v === 200), "flat stays flat");
  const copy = featherAlpha(flat, 0);
  assert(copy.data !== flat.data && copy.data.every((v) => v === 200), "px 0 copies");

  const edge = alphaMap(40, 4, (x) => (x < 20 ? 255 : 0));
  for (const px of [1, 4, 10]) {
    const f = featherAlpha(edge, px);
    const row = Array.from(f.data.subarray(40, 80));
    assert(row[0] === 255 && row[39] === 0, `ends stay put (px ${px})`);
    assert(row[19] < 255 && row[20] > 0, `edge softened (px ${px})`);
    for (let i = 1; i < 40; i++) assert(row[i] <= row[i - 1], `monotonic (px ${px})`);
    near(row[19] + row[20], 255, 2, `symmetric around the edge (px ${px})`);
  }
});

Deno.test("growAlpha grows and shrinks by about the radius", () => {
  const dot = alphaMap(21, 21, (x, y) => (x === 10 && y === 10 ? 255 : 0));
  const g = growAlpha(dot, 3);
  assert(at(g, 13, 10) === 255 && at(g, 10, 7) === 255, "reaches 3 px straight");
  assert(at(g, 14, 10) === 0, "not 4 px");
  assert(at(g, 12, 12) === 255, "reaches the diagonal at 2.8 px");
  assert(at(g, 13, 13) === 0, "corner of a square is not reached");

  const square = alphaMap(21, 21, (x, y) => (x >= 5 && x <= 15 && y >= 5 && y <= 15 ? 255 : 0));
  const s = growAlpha(square, -2);
  assert(at(s, 7, 7) === 255 && at(s, 13, 13) === 255, "inner square kept");
  assert(at(s, 6, 10) === 0 && at(s, 10, 14) === 0, "two px eaten from each side");

  const same = growAlpha(square, 0);
  assert(same.data.every((v, i) => v === square.data[i]), "0 copies");
});

Deno.test("growAlpha reaches across the image border and shrink ignores the frame", () => {
  const row = alphaMap(12, 1, (x) => (x === 0 ? 255 : 0));
  const g = growAlpha(row, 4);
  assert(at(g, 4, 0) === 255 && at(g, 5, 0) === 0, "4 px along a one-row image");
  const full = alphaMap(10, 10, () => 255);
  const s = growAlpha(full, -3);
  assert(s.data.every((v) => v === 255), "the frame edge does not erode the mask");
});

Deno.test("growAlpha matches a brute-force dilation with the same shape", () => {
  // The structuring element is what one centered pixel grows into.
  const r = 5;
  const n = 2 * r + 3;
  const probe = growAlpha(alphaMap(n, n, (x, y) => (x === r + 1 && y === r + 1 ? 255 : 0)), r);
  const se = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (at(probe, x, y)) se.push([x - r - 1, y - r - 1]);
  const rand = rng(3);
  const src = alphaMap(17, 13, () => (rand() < 0.08 ? Math.floor(rand() * 256) : 0));
  const got = growAlpha(src, r);
  for (let y = 0; y < 13; y++) {
    for (let x = 0; x < 17; x++) {
      let m = 0;
      for (const [dx, dy] of se) {
        const sx = x - dx;
        const sy = y - dy;
        if (sx >= 0 && sy >= 0 && sx < 17 && sy < 13) m = Math.max(m, at(src, sx, sy));
      }
      assert(at(got, x, y) === m, `mismatch at ${x},${y}: ${at(got, x, y)} vs ${m}`);
    }
  }
});

Deno.test("paintAlpha erases and restores with a soft round brush", () => {
  const a = alphaMap(50, 50, () => 255);
  const rect = paintAlpha(a, { x: 25, y: 25 }, { x: 25, y: 25 }, { radius: 10, hardness: 0.5, mode: "erase" });
  assert(rect && rect.x <= 15 && rect.x + rect.w >= 35, "dirty rect covers the brush");
  assert(at(a, 25, 25) === 0, "center erased");
  assert(at(a, 25, 40) === 255, "outside untouched");
  const mid = at(a, 25, 33);
  assert(mid > 0 && mid < 255, `soft falloff, got ${mid}`);

  paintAlpha(a, { x: 25, y: 25 }, { x: 25, y: 25 }, { radius: 10, hardness: 1, mode: "restore" });
  assert(at(a, 25, 25) === 255 && at(a, 25, 33) === 255, "restore brings pixels back");

  paintAlpha(a, { x: 5, y: 5 }, { x: 5, y: 5 }, { radius: 3, hardness: 1, mode: "erase", strength: 0.5 });
  near(at(a, 5, 5), 128, 1, "half strength");
});

Deno.test("paintAlpha paints a continuous line between two points", () => {
  const a = alphaMap(60, 20, () => 255);
  paintAlpha(a, { x: 5, y: 10 }, { x: 55, y: 10 }, { radius: 3, hardness: 1, mode: "erase" });
  for (let x = 5; x <= 55; x++) assert(at(a, x, 10) === 0, `gap at ${x}`);
  assert(at(a, 30, 2) === 255, "line stays thin");
});

Deno.test("brushRect clips to the image", () => {
  assert(brushRect(10, 10, { x: -50, y: -50 }, { x: -40, y: -40 }, 5) === null, "fully outside");
  const r = brushRect(10, 10, { x: 0, y: 0 }, { x: 0, y: 0 }, 4);
  assert(r.x === 0 && r.y === 0 && r.w <= 10 && r.h <= 10, "clipped");
});

Deno.test("downsampleAlpha area-averages to the longest side", () => {
  const full = alphaMap(512, 256, () => 255);
  const d = downsampleAlpha(full, 256);
  assert(d.w === 256 && d.h === 128, `size ${d.w}x${d.h}`);
  assert(d.data.every((v) => v === 255), "flat stays flat");
  const checker = alphaMap(64, 64, (x, y) => ((x + y) % 2 ? 255 : 0));
  const c = downsampleAlpha(checker, 16);
  assert(c.data.every((v) => Math.abs(v - 128) <= 1), "checkerboard averages to gray");
  const small = downsampleAlpha(alphaMap(10, 5, () => 7), 256);
  assert(small.w === 10 && small.h === 5 && small.data[0] === 7, "never upsamples");
});

Deno.test("alpha and RGBA convert both ways", () => {
  const a = alphaMap(3, 2, (x, y) => x * 40 + y * 100);
  const rgba = rgbaFromAlpha(a);
  assert(rgba.length === 24, "4 bytes per pixel");
  assert(rgba[0] === 255 && rgba[1] === 255 && rgba[2] === 255, "white");
  const back = alphaFromRGBA({ width: 3, height: 2, data: rgba });
  assert(back.data.every((v, i) => v === a.data[i]), "round trip");
});
