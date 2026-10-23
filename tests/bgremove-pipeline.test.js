// Run: deno test --allow-read tests/bgremove-pipeline.test.js
import {
  activate,
  blur121,
  edgeCurve,
  fromHalf,
  outputToAlpha,
  resizeBicubic,
  toFloat32,
  toHalf,
  toHalfArray,
  toInputTensor,
} from "../web/js/features/bgremove/pipeline.js";

function assert(value, message = "assertion failed") {
  if (!value) throw Error(message);
}

function near(a, b, eps, message = "") {
  if (!(Math.abs(a - b) <= eps)) throw Error(`${message} expected ${b} ± ${eps}, got ${a}`);
}

Deno.test("toInputTensor writes planar RGB with the model's normalization", () => {
  // 2x1 image: white, then pure red.
  const rgba = new Uint8ClampedArray([255, 255, 255, 255, 255, 0, 0, 255]);
  const isnet = toInputTensor(rgba, 2, 1, { scale: 1 / 255, mean: [0.5, 0.5, 0.5], std: [1, 1, 1] });
  assert(isnet.length === 6, "3 planes of 2");
  near(isnet[0], 0.5, 1e-6, "R white");
  near(isnet[1], 0.5, 1e-6, "R red");
  near(isnet[2], 0.5, 1e-6, "G white");
  near(isnet[3], -0.5, 1e-6, "G red");
  near(isnet[5], -0.5, 1e-6, "B red");

  const imagenet = toInputTensor(rgba, 2, 1, { scale: 1 / 255, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] });
  near(imagenet[0], (1 - 0.485) / 0.229, 1e-5, "R white imagenet");
  near(imagenet[3], (0 - 0.456) / 0.224, 1e-5, "G red imagenet");
});

Deno.test("half floats round trip", () => {
  assert(toHalf(1) === 0x3c00, "1.0");
  assert(toHalf(0.5) === 0x3800, "0.5");
  assert(toHalf(-2) === 0xc000, "-2");
  assert(toHalf(65504) === 0x7bff, "max half");
  assert(toHalf(1e6) === 0x7c00, "overflow to infinity");
  assert(toHalf(0) === 0 && toHalf(1e-9) === 0, "zero and underflow");
  assert(toHalf(2 ** -24) === 1, "smallest subnormal");
  assert(Number.isNaN(fromHalf(toHalf(NaN))), "NaN");
  for (const v of [0.1, -0.333, 3.14159, 1000.5, 6e-5, -0.0001]) {
    const back = fromHalf(toHalf(v));
    assert(Math.abs(back - v) <= Math.abs(v) * 1e-3 + 6e-8, `${v} -> ${back}`);
  }
  const arr = toHalfArray(new Float32Array([1, 0.5]));
  assert(arr instanceof Uint16Array && arr[0] === 0x3c00 && arr[1] === 0x3800, "array");
  const f = toFloat32(arr, "float16");
  assert(f[0] === 1 && f[1] === 0.5, "toFloat32 from half");
  const same = new Float32Array([2]);
  assert(toFloat32(same) === same, "float32 passes through");
});

Deno.test("activate handles logits, probabilities and flat outputs", () => {
  const s = activate(new Float32Array([0, 20, -20]), "sigmoid");
  near(s[0], 0.5, 1e-6, "sigmoid 0");
  near(s[1], 1, 1e-6, "sigmoid big");
  near(s[2], 0, 1e-6, "sigmoid small");

  const m = activate(new Float32Array([0.1, 0.5, 0.9]), "minmax");
  near(m[0], 0, 1e-6, "min");
  near(m[2], 1, 1e-6, "max");
  near(m[1], 0.5, 1e-6, "mid");

  const flat = activate(new Float32Array([0.01, 0.02, 0.03]), "minmax");
  assert(flat[2] < 0.05, "an empty prediction stays empty");

  const c = activate(new Float32Array([-1, 0.3, 2]), "clamp");
  assert(c[0] === 0 && Math.abs(c[1] - 0.3) < 1e-6 && c[2] === 1, "clamp");
});

Deno.test("resizeBicubic keeps constants, matches identity and is smooth", () => {
  const flat = new Float32Array(16).fill(0.7);
  for (const [dw, dh] of [[4, 4], [13, 9], [2, 3], [50, 1]]) {
    const out = resizeBicubic(flat, 4, 4, dw, dh);
    assert(out.length === dw * dh, "size");
    for (const v of out) near(v, 0.7, 1e-5, `constant ${dw}x${dh}`);
  }
  const src = Float32Array.from({ length: 12 }, (_, i) => i / 11);
  const same = resizeBicubic(src, 4, 3, 4, 3);
  assert(same !== src && same.every((v, i) => v === src[i]), "identity copies");

  // A step upscaled 8x rises monotonically (no blocks) through the edge.
  const step = new Float32Array([0, 0, 1, 1]);
  const up = resizeBicubic(step, 4, 1, 32, 1);
  for (let i = 1; i < 32; i++) assert(up[i] >= up[i - 1] - 0.08, "no big dips");
  assert(up[0] < 0.05 && up[31] > 0.95, "ends");
  const distinct = new Set(Array.from(up.subarray(10, 22), (v) => v.toFixed(3)));
  assert(distinct.size > 6, "smooth ramp, not nearest neighbor");

  // Downscale averages: a fine checkerboard becomes gray.
  const checker = Float32Array.from({ length: 64 * 64 }, (_, i) => ((i % 64) + Math.floor(i / 64)) % 2);
  const down = resizeBicubic(checker, 64, 64, 8, 8);
  for (const v of down) near(v, 0.5, 0.06, "checker -> gray");
});

Deno.test("blur121 softens only edges", () => {
  const d = new Float32Array([0, 0, 1, 1, 0, 0, 1, 1]);
  blur121(d, 4, 2);
  near(d[0], 0, 1e-6, "flat left");
  near(d[1], 0.25, 1e-6, "edge left");
  near(d[2], 0.75, 1e-6, "edge right");
  near(d[3], 1, 1e-6, "flat right");
});

Deno.test("edgeCurve clears haze, fills solids and keeps the middle", () => {
  assert(edgeCurve(0.01) === 0, "haze cleared");
  assert(edgeCurve(0.99) === 1, "solid filled");
  near(edgeCurve(0.5), 0.5, 1e-6, "middle kept");
  let prev = -1;
  for (let v = 0; v <= 1; v += 0.01) {
    const c = edgeCurve(v);
    assert(c >= prev, "monotonic");
    prev = c;
  }
  assert(edgeCurve(0.3, { curve: 1 }) < edgeCurve(0.3, { curve: 0 }), "curve bends toward smoothstep");
});

Deno.test("outputToAlpha maps logits to a keep mask at the natural size", () => {
  // 4x4 logits: left half background, right half subject.
  const raw = Float32Array.from({ length: 16 }, (_, i) => (i % 4 < 2 ? -12 : 12));
  const alpha = outputToAlpha(raw, 4, 4, 40, 20, { activation: "sigmoid", refine: {} });
  assert(alpha instanceof Uint8ClampedArray && alpha.length === 800, "natural size");
  assert(alpha[0] === 0 && alpha[39] === 255, "corners");
  assert(alpha[20 * 10 + 2] === 0 && alpha[20 * 10 + 37] === 255, "middle row");
  const mid = alpha[10 * 40 + 20];
  assert(mid > 40 && mid < 215, `soft transition at the edge, got ${mid}`);

  const probs = new Float32Array(16).fill(0.8);
  const kept = outputToAlpha(probs, 4, 4, 8, 8, { activation: "clamp", refine: { blur: false, lo: 0, hi: 1, curve: 0 } });
  assert(kept.every((v) => v === 204), "plain probabilities pass through when the curve is off");
});
