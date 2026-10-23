// Model session lifetime in web/js/features/bgremove/engine.js and the idle
// worker shutdown in runner.js, with a fake onnxruntime module.
// Run: deno test --allow-read tests/bgremove-engine.test.js
import { runJob } from "../web/js/features/bgremove/engine.js";
import { createRunner } from "../web/js/features/bgremove/runner.js";

function eq(a, b, msg = "") {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg} expected ${sb}, got ${sa}`);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (src) => `data:text/javascript,${encodeURIComponent(src)}`;

// Logs create#n / run-ok#n / run-fail#n / release#n into globalThis.__ortlog;
// globalThis.__fail = "memory" | "model" makes the next runs throw.
const FAKE_ORT = js(`
  const log = (globalThis.__ortlog ||= []);
  export const env = { wasm: {}, logLevel: "" };
  export class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } dispose() {} }
  export const InferenceSession = {
    async create() {
      const id = log.filter((l) => l.startsWith("create")).length + 1;
      log.push("create#" + id);
      return {
        inputNames: ["input"], outputNames: ["output"],
        async run() {
          if (globalThis.__fail) {
            log.push("run-fail#" + id);
            throw Error(globalThis.__fail === "memory" ? "std::bad_alloc" : "unexpected output shape");
          }
          log.push("run-ok#" + id);
          return { output: new Tensor("float32", new Float32Array(16).fill(0.5), [1, 1, 4, 4]) };
        },
        async release() { log.push("release#" + id); },
      };
    },
  };
`);

const IDLE = 30;
const plan = {
  modelId: "test", variantId: "fp32", backend: "wasm",
  model: { input: "input", output: "output", inputType: "float32", size: 4, scale: 1 / 255, mean: [0, 0, 0], std: [1, 1, 1], activation: "sigmoid", dims: null },
  file: { url: "data:application/octet-stream;base64,AAAA", file: "model.onnx", bytes: 0, sha256: null, local: true },
  cpuFallback: true,
  runtime: {
    build: "wasm", version: "test", base: "data:,", local: true,
    script: { url: FAKE_ORT, local: true }, glue: { url: "data:,", local: true }, wasm: { url: "data:,", local: true },
  },
  refine: {}, cacheName: "longitude-test", idleReleaseMs: IDLE,
};
const job = () => ({ type: "model", plan, input: new Uint8ClampedArray(4 * 4 * 4), target: { width: 4, height: 4 } });
const log = () => globalThis.__ortlog || [];
const since = (n) => log().slice(n);

Deno.test("engine: the session is released after the idle time", async () => {
  globalThis.__fail = null;
  const n = log().length;
  const res = await runJob(job());
  eq([res.width, res.height], [4, 4]);
  eq(since(n), ["create#1", "run-ok#1"]);
  await wait(IDLE * 4);
  eq(since(n), ["create#1", "run-ok#1", "release#1"]);
});

Deno.test("engine: a run that fails for another reason still gets the idle release", async () => {
  const n = log().length;
  globalThis.__fail = "model";
  let code = "";
  try {
    await runJob(job());
  } catch (err) {
    code = err.code;
  }
  eq(code, "model");
  eq(since(n), ["create#2", "run-fail#2"], "kept for a quick retry");
  await wait(IDLE * 4);
  eq(since(n), ["create#2", "run-fail#2", "release#2"]);
  globalThis.__fail = null;
});

Deno.test("engine: a session that ran out of memory is released at once", async () => {
  const n = log().length;
  globalThis.__fail = "memory";
  let code = "";
  try {
    await runJob(job());
  } catch (err) {
    code = err.code;
  }
  eq(code, "memory");
  eq(since(n), ["create#3", "run-fail#3", "release#3"]);
  globalThis.__fail = null;
  await runJob(job());
  eq(since(n).slice(3), ["create#4", "run-ok#4"], "the next run starts a fresh session");
  await wait(IDLE * 4);
  eq(since(n).at(-1), "release#4");
});

// A stand-in worker speaking worker.js's protocol.
const FAKE_WORKER = js(`
  self.onmessage = (e) => {
    const msg = e.data || {};
    if (msg.type !== "job") return;
    self.postMessage({ type: "result", id: msg.id, result: { alpha: new Uint8ClampedArray(4), width: 2, height: 2, backend: "local", variant: null, gpuFailed: false } });
  };
  self.postMessage({ type: "ready" });
`);

Deno.test("runner: an idle worker is closed, and the next job starts a new one", async () => {
  const runner = createRunner({ url: FAKE_WORKER, idleMs: IDLE });
  try {
    const res = await runner.run({ type: "edge-magic" });
    eq(res.width, 2);
    eq(runner.usesWorker, true, "ran in a worker");
    await wait(IDLE / 3);
    eq(runner.usesWorker, true, "kept for a moment for the next job");
    await wait(IDLE * 3);
    eq(runner.usesWorker, false, "closed when idle, which frees its memory");
    eq((await runner.run({ type: "edge-magic" })).width, 2);
    eq(runner.usesWorker, true, "a new worker for the next job");
    runner.release();
    eq(runner.usesWorker, false, "release() closes an idle worker at once");
  } finally {
    runner.terminate();
  }
});
