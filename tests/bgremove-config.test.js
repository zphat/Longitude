// Run: deno test --allow-read tests/bgremove-config.test.js
import { BG_CONFIG, variantsFor, vendorUrl } from "../web/js/features/bgremove/config.js";
import { detectCaps, friendlyError, planModel, runJob } from "../web/js/features/bgremove/engine.js";

function assert(value, message = "assertion failed") {
  if (!value) throw Error(message);
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

Deno.test("the config block is strict JSON for tools/fetch_model.py", async () => {
  const text = await Deno.readTextFile(new URL("../web/js/features/bgremove/config.js", import.meta.url));
  const m = text.match(/\/\* bgconfig:begin \*\/([\s\S]*?)\/\* bgconfig:end \*\//);
  assert(m, "markers present");
  const parsed = JSON.parse(m[1]);
  assert(same(parsed, BG_CONFIG), "JSON block equals the exported object");
});

Deno.test("every provider points at a complete model", () => {
  assert(BG_CONFIG.providers[BG_CONFIG.defaultProvider], "default provider exists");
  for (const [id, p] of Object.entries(BG_CONFIG.providers)) {
    const model = BG_CONFIG.models[p.model];
    assert(model, `${id}: model ${p.model}`);
    assert(p.label && p.note, `${id}: label and note`);
    for (const key of ["input", "output", "size", "mean", "std", "activation", "license", "source"]) assert(model[key] !== undefined, `${p.model}: ${key}`);
    for (const [vid, v] of Object.entries(model.variants)) {
      assert(/^https:\/\//.test(v.url) && v.file && v.page, `${vid}: url, file, page`);
      assert(Number.isInteger(v.bytes) && v.bytes > 1e6, `${vid}: bytes`);
      assert(/^[0-9a-f]{64}$/.test(v.sha256), `${vid}: sha256`);
      assert(/\/resolve\/[0-9a-f]{40}\//.test(v.url), `${vid}: pinned to a commit`);
    }
  }
  assert(BG_CONFIG.ort.base.includes(`onnxruntime-web@${BG_CONFIG.ort.version}/`), "runtime pinned to the configured version");
  for (const b of Object.values(BG_CONFIG.ort.builds)) {
    for (const part of [b.script, b.glue, b.wasm]) assert(part.file && part.bytes > 0 && /^[0-9a-f]{64}$/.test(part.sha256), `runtime part ${part.file}`);
  }
});

Deno.test("Fast stays under 50 MB", () => {
  const fast = BG_CONFIG.models[BG_CONFIG.providers.fast.model];
  for (const v of Object.values(fast.variants)) assert(v.bytes < 50e6, `${v.file} is ${v.bytes}`);
});

Deno.test("variantsFor picks the right file for each machine", () => {
  const best = BG_CONFIG.models["birefnet-lite"];
  const gpu16 = variantsFor(best, { backend: "webgpu", f16: true });
  assert(gpu16[0].id === "fp16" && gpu16[0].backend === "webgpu", "fp16 on a GPU with shader-f16");
  const gpu32 = variantsFor(best, { backend: "webgpu", f16: false });
  assert(gpu32.length === 1 && gpu32[0].id === "fp32" && gpu32[0].backend === "webgpu", "fp32 on a GPU without f16");
  const cpu = variantsFor(best, { backend: "wasm", f16: false });
  assert(cpu.length === 1 && cpu[0].id === "fp32" && cpu[0].backend === "wasm", "fp32 on the CPU");
  const fast = BG_CONFIG.models["isnet-general"];
  assert(variantsFor(fast, { backend: "webgpu", f16: true })[0].backend === "webgpu", "fast on GPU");
  assert(variantsFor(fast, { backend: "wasm", f16: false })[0].backend === "wasm", "fast on CPU");
});

Deno.test("vendorUrl resolves inside web/", () => {
  assert(vendorUrl("models/x.onnx").endsWith("/web/vendor/models/x.onnx"), vendorUrl("models/x.onnx"));
});

Deno.test("planModel plans for the CPU after a GPU failure", async () => {
  const plan = await planModel("birefnet-lite", { avoidGpu: true });
  assert(plan.variantId === "fp32" && plan.backend === "wasm" && plan.cpuFallback, "fp32 on the CPU");
  assert(plan.model.input === "input_image" && plan.model.size === 1024, "model fields");
  assert(plan.file.url === BG_CONFIG.models["birefnet-lite"].variants.fp32.url && !plan.file.local, "remote file");
  assert(plan.runtime.wasm.url.startsWith(BG_CONFIG.ort.base), "runtime from the CDN");
  assert(plan.refine.lo === BG_CONFIG.refine.lo, "global edge curve");
  assert(same(JSON.parse(JSON.stringify(plan)), plan), "plan is plain data for postMessage");
});

Deno.test("planModel uses the GPU-only file only where it fits", async () => {
  const caps = await detectCaps();
  const plan = await planModel("birefnet-lite");
  if (caps.backend === "webgpu" && caps.f16) {
    assert(plan.variantId === "fp16" && plan.backend === "webgpu" && !plan.cpuFallback, "fp16 on the GPU, no CPU fallback");
    assert(plan.runtime.build === "webgpu", "webgpu runtime");
  } else {
    assert(plan.variantId === "fp32" && plan.cpuFallback, "fp32 elsewhere");
  }
  const fast = await planModel("isnet-general");
  assert(fast.variantId === "int8" && fast.cpuFallback, "fast can always fall back");
  assert(fast.refine.lo === BG_CONFIG.models["isnet-general"].refine.lo, "per-model edge curve wins");
});

Deno.test("friendlyError gives plain messages", () => {
  const abort = friendlyError(Object.assign(Error("x"), { name: "AbortError" }));
  assert(abort.code === "cancelled" && abort.message === "Canceled", "cancel");
  const oom = friendlyError(Error("failed to call OrtRun(). error code = 6. std::bad_alloc"));
  assert(oom.code === "memory" && !/OrtRun/.test(oom.message), "memory");
  const other = friendlyError(Error("Unexpected input data type"));
  assert(other.code === "model" && other.detail.includes("Unexpected"), "generic keeps the detail");
  const gpu = friendlyError(Object.assign(Error("This model could not run on your graphics card. Try again to use the processor instead."), { code: "gpu" }));
  assert(gpu.code === "gpu" && gpu.message.includes("graphics card"), "gpu failures keep their code");
  const flat = friendlyError(Object.assign(Error("The edges are not one flat color. Try Fast or Best."), { code: "not-flat" }));
  assert(flat.code === "not-flat" && flat.message.startsWith("The edges"), "provider messages pass through");
});

Deno.test("runJob runs the flat-background job without a model", async () => {
  const w = 30;
  const h = 20;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const x = i % w;
    const y = Math.floor(i / w);
    const inside = x > 9 && x < 20 && y > 5 && y < 15;
    data.set(inside ? [200, 30, 30, 255] : [250, 250, 250, 255], i * 4);
  }
  const events = [];
  const res = await runJob({ type: "edge-magic", image: { width: w, height: h, data }, options: { feather: 0 } }, { onProgress: (e) => events.push(e) });
  assert(res.width === w && res.height === h && res.alpha.length === w * h, "size");
  assert(res.alpha[0] === 0 && res.alpha[10 * w + 15] === 255, "background out, subject in");
  assert(events.length && events.every((e) => e.phase === "run"), "progress events");
});
