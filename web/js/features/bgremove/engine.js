// Background removal engine: plans which model file and runtime build to use,
// downloads them once into Cache Storage, loads onnxruntime-web on demand and
// runs inference. The same code runs inside worker.js and, if the worker
// cannot start, on the main thread. Nothing here touches the DOM.

import { BG_CONFIG, variantsFor, vendorUrl } from "./config.js";
import { outputToAlpha, toFloat32, toHalfArray, toInputTensor } from "./pipeline.js";

const MB = 1e6;

// ---- errors -----------------------------------------------------------------

const MESSAGES = {
  cancelled: "Canceled",
  network: "Could not download the model. Check your connection and try again.",
  integrity: "The download was damaged. Try again.",
  runtime: "Could not start the background remover in this browser.",
  gpu: "This model could not run on your graphics card. Try again to use the processor instead.",
  memory: "Not enough memory for this one. Try Fast, or a smaller image.",
  model: "Background removal did not work on this image.",
};

function tagged(code, cause, extra = {}) {
  const err = Error(MESSAGES[code] || String(cause?.message || cause));
  err.code = code;
  err.detail = cause ? String(cause?.message || cause) : "";
  return Object.assign(err, extra);
}

export function abortError() {
  return tagged("cancelled", null, { name: "AbortError" });
}

export function isAbort(err) {
  return err?.name === "AbortError" || err?.code === "cancelled";
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

const looksLikeMemory = (msg) => /bad_alloc|out of memory|memory access out of bounds|RangeError|Array buffer allocation|OOM/i.test(msg);
const looksLikeRuntime = (msg) => /no available backend|initializeWebAssembly|dynamically imported module|WebAssembly\.(instantiate|Module)|SIMD is not supported/i.test(msg);

// Session or run failure -> tagged error. A runtime that failed to start is
// dropped so the next attempt imports it afresh.
function sessionError(err) {
  if (isAbort(err) || err?.code === "gpu") return err;
  const msg = String(err?.message || err);
  if (looksLikeRuntime(msg)) {
    ortState = null;
    current = null;
    return tagged("runtime", err);
  }
  return tagged(looksLikeMemory(msg) ? "memory" : "model", err);
}

// Any error -> { name, code, message, detail } with a plain message for the UI.
export function friendlyError(err) {
  if (isAbort(err)) return { name: "AbortError", code: "cancelled", message: MESSAGES.cancelled, detail: "" };
  const detail = String(err?.detail || err?.message || err || "");
  if (err?.code && (MESSAGES[err.code] || ["http", "not-flat", "already-transparent", "decode", "layer", "provider"].includes(err.code))) {
    return { name: "Error", code: err.code, message: err.message, detail };
  }
  const code = looksLikeMemory(detail) ? "memory" : "model";
  return { name: "Error", code, message: MESSAGES[code], detail };
}

// ---- capabilities -------------------------------------------------------------

let capsPromise = null;

// { backend: "webgpu" | "wasm", f16, reason }. Cached for the page/worker.
export function detectCaps() {
  if (capsPromise) return capsPromise;
  capsPromise = (async () => {
    const gpu = globalThis.navigator?.gpu;
    if (!gpu?.requestAdapter) return { backend: "wasm", f16: false, reason: "no-webgpu" };
    let timer = 0;
    try {
      const adapter = await Promise.race([
        gpu.requestAdapter(),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), 4000);
        }),
      ]);
      if (!adapter) return { backend: "wasm", f16: false, reason: "no-adapter" };
      if (adapter.info?.isFallbackAdapter || adapter.isFallbackAdapter) return { backend: "wasm", f16: false, reason: "software-adapter" };
      return { backend: "webgpu", f16: !!adapter.features?.has?.("shader-f16"), reason: "" };
    } catch {
      return { backend: "wasm", f16: false, reason: "no-adapter" };
    } finally {
      clearTimeout(timer);
    }
  })();
  return capsPromise;
}

export function threadCount() {
  if (!globalThis.crossOriginIsolated) return 1;
  const cores = globalThis.navigator?.hardwareConcurrency || 4;
  return Math.max(1, Math.min(BG_CONFIG.threads?.max || 4, Math.ceil(cores / 2)));
}

// ---- offline vendor files (tools/fetch_model.py) --------------------------------

let manifestPromise = null;

export function vendorManifest() {
  if (manifestPromise) return manifestPromise;
  manifestPromise = (async () => {
    try {
      const res = await fetch(vendorUrl("manifest.json"), { cache: "no-cache" });
      if (!res.ok) return null;
      const json = await res.json();
      return json && typeof json === "object" ? json : null;
    } catch {
      return null;
    }
  })();
  return manifestPromise;
}

// ---- planning -------------------------------------------------------------------

function runtimeFiles(build, manifest) {
  const ort = BG_CONFIG.ort;
  const b = ort.builds[build];
  const names = [b.script.file, b.glue.file, b.wasm.file];
  const local = manifest?.ort?.version === ort.version && names.every((f) => manifest.ort.files?.includes(f));
  const base = local ? vendorUrl("ort/") : ort.base;
  const entry = (part) => ({ url: new URL(part.file, base).href, file: part.file, bytes: part.bytes || 0, sha256: part.sha256 || null, local });
  return { build, version: ort.version, base, local, script: entry(b.script), glue: entry(b.glue), wasm: entry(b.wasm) };
}

function modelFile(variant, manifest) {
  const local = !!(variant.file && manifest?.models?.[variant.file]);
  return {
    url: local ? vendorUrl(`models/${variant.file}`) : variant.url,
    file: variant.file,
    bytes: variant.bytes || 0,
    sha256: variant.sha256 || null,
    page: variant.page || null,
    local,
  };
}

// Everything a worker needs to run one model, as plain data.
// avoidGpu: the graphics card failed earlier this session, plan for the CPU.
export async function planModel(modelId, { avoidGpu = false } = {}) {
  const model = BG_CONFIG.models[modelId];
  if (!model) throw Error(`Unknown background removal model "${modelId}".`);
  const detected = await detectCaps();
  const caps = avoidGpu ? { backend: "wasm", f16: false, reason: "gpu-failed" } : detected;
  const manifest = await vendorManifest();
  const options = variantsFor(model, caps);
  if (!options.length) throw tagged("runtime", "no variant for this device");
  // A variant already on disk beats downloading a different one.
  let choice = options[0];
  for (const o of options) {
    if (await isCached(modelFile(o.variant, manifest))) {
      choice = o;
      break;
    }
  }
  let build = choice.backend === "webgpu" ? "webgpu" : "wasm";
  if (build === "wasm" && detected.backend === "webgpu" && (await isCached(runtimeFiles("webgpu", manifest).wasm))) build = "webgpu";
  return {
    modelId,
    variantId: choice.id,
    backend: choice.backend,
    model: {
      input: model.input,
      output: model.output,
      inputType: model.inputType || "float32",
      size: model.size,
      scale: model.scale ?? 1 / 255,
      mean: model.mean,
      std: model.std,
      activation: model.activation || "sigmoid",
      dims: model.dims || null,
    },
    file: modelFile(choice.variant, manifest),
    cpuFallback: (choice.variant.backends || ["wasm"]).includes("wasm"),
    runtime: runtimeFiles(build, manifest),
    refine: { ...(BG_CONFIG.refine || {}), ...(model.refine || {}) },
    cacheName: BG_CONFIG.cacheName,
    idleReleaseMs: BG_CONFIG.idleReleaseMs || 0,
  };
}

// ---- downloads and Cache Storage ------------------------------------------------

async function openCache(name = BG_CONFIG.cacheName) {
  try {
    return globalThis.caches ? await globalThis.caches.open(name) : null;
  } catch {
    return null;
  }
}

export async function isCached(entry, cacheName = BG_CONFIG.cacheName) {
  if (entry.local) return true;
  const cache = await openCache(cacheName);
  if (!cache) return false;
  try {
    return !!(await cache.match(entry.url));
  } catch {
    return false;
  }
}

async function sha256Hex(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const hash = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function readBody(res, total, onBytes) {
  if (!res.body?.getReader) {
    const all = new Uint8Array(await res.arrayBuffer());
    onBytes?.(all.length);
    return all;
  }
  const reader = res.body.getReader();
  let buf = total > 0 ? new Uint8Array(total) : null;
  let chunks = buf ? null : [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (buf && received + value.length > buf.length) {
      chunks = [buf.subarray(0, received)];
      buf = null;
    }
    if (buf) buf.set(value, received);
    else chunks.push(value);
    received += value.length;
    onBytes?.(received);
  }
  if (buf) return received === buf.length ? buf : buf.slice(0, received);
  const out = new Uint8Array(received);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// Bytes of one file: from Cache Storage when present, else downloaded with
// progress, checked (size, sha256) and cached for next time.
export async function getBytes(entry, { cacheName = BG_CONFIG.cacheName, onBytes, signal } = {}) {
  const cache = entry.local ? null : await openCache(cacheName);
  if (cache) {
    const hit = await cache.match(entry.url).catch(() => null);
    if (hit) {
      const bytes = new Uint8Array(await hit.arrayBuffer());
      if (!entry.bytes || bytes.length === entry.bytes) return bytes;
      await cache.delete(entry.url).catch(() => {});
    }
  }
  throwIfAborted(signal);
  let res;
  try {
    res = await fetch(entry.url, { signal, credentials: entry.local ? "same-origin" : "omit" });
  } catch (err) {
    if (isAbort(err) || signal?.aborted) throw abortError();
    throw tagged("network", err);
  }
  if (!res.ok) {
    const err = Error(`The model download failed (error ${res.status}). Try again later.`);
    err.code = "http";
    err.status = res.status;
    throw err;
  }
  let bytes;
  try {
    bytes = await readBody(res, entry.bytes || Number(res.headers.get("content-length")) || 0, onBytes);
  } catch (err) {
    if (isAbort(err) || signal?.aborted) throw abortError();
    throw tagged("network", err);
  }
  if (entry.bytes && bytes.length !== entry.bytes) throw tagged("integrity", `expected ${entry.bytes} bytes, got ${bytes.length}`);
  if (entry.sha256 && !entry.local) {
    const hex = await sha256Hex(bytes);
    if (hex && hex !== entry.sha256) throw tagged("integrity", `sha256 ${hex}`);
  }
  if (cache) {
    try {
      await cache.put(entry.url, new Response(bytes, {
        headers: { "Content-Type": "application/octet-stream", "X-Longitude-Bytes": String(bytes.length) },
      }));
    } catch (err) {
      console.warn("Longitude: could not cache", entry.url, err);
    }
  }
  return bytes;
}

// { bytes, files } stored in the model cache.
export async function cacheUsage(cacheName = BG_CONFIG.cacheName) {
  const cache = await openCache(cacheName);
  if (!cache) return { bytes: 0, files: 0 };
  let bytes = 0;
  const keys = await cache.keys();
  for (const req of keys) {
    const res = await cache.match(req);
    const n = Number(res?.headers.get("X-Longitude-Bytes"));
    bytes += Number.isFinite(n) && n > 0 ? n : (await res?.blob())?.size || 0;
  }
  return { bytes, files: keys.length };
}

export async function clearCache(cacheName = BG_CONFIG.cacheName) {
  try {
    return globalThis.caches ? await globalThis.caches.delete(cacheName) : false;
  } catch {
    return false;
  }
}

// ---- onnxruntime-web ----------------------------------------------------------------

let ortState = null; // { build, version, ort }

function blobUrl(bytes) {
  return URL.createObjectURL(new Blob([bytes], { type: "text/javascript" }));
}

// Import the runtime once per worker. Remote files come from Cache Storage as
// blob URLs, so a cached runtime also works offline.
async function loadOrt(runtime, files) {
  if (ortState) return ortState.ort;
  let mod;
  try {
    mod = await import(runtime.local ? runtime.script.url : blobUrl(files.script));
  } catch (err) {
    throw tagged("runtime", err);
  }
  const ort = mod.InferenceSession ? mod : mod.default;
  if (!ort?.InferenceSession) throw tagged("runtime", "onnxruntime-web did not load");
  ort.env.logLevel = "error";
  ort.env.wasm.numThreads = threadCount();
  ort.env.wasm.proxy = false;
  if (runtime.local) {
    ort.env.wasm.wasmPaths = runtime.base;
  } else {
    ort.env.wasm.wasmPaths = { mjs: blobUrl(files.glue) };
    ort.env.wasm.wasmBinary = files.wasm;
  }
  ortState = { build: runtime.build, version: runtime.version, ort };
  return ort;
}

// ---- sessions -----------------------------------------------------------------------

let current = null; // { url, backend, session, input, output }
let idleTimer = 0;

async function releaseSession() {
  clearTimeout(idleTimer);
  const s = current;
  current = null;
  if (s) {
    try {
      await s.session.release();
    } catch {}
  }
}

function scheduleRelease(ms) {
  clearTimeout(idleTimer);
  if (ms > 0) idleTimer = setTimeout(() => releaseModel(), ms);
}

async function createSession(ort, plan, bytes, backend) {
  const options = {
    executionProviders: backend === "webgpu" ? ["webgpu", "wasm"] : ["wasm"],
    graphOptimizationLevel: "all",
    logSeverityLevel: 3,
  };
  if (plan.model.dims) options.freeDimensionOverrides = plan.model.dims;
  const session = await ort.InferenceSession.create(bytes, options);
  // The runtime has started by now; its wasm bytes are no longer needed.
  if (ort.env.wasm.wasmBinary) ort.env.wasm.wasmBinary = undefined;
  const input = session.inputNames.includes(plan.model.input) ? plan.model.input : session.inputNames[0];
  const output = session.outputNames.includes(plan.model.output) ? plan.model.output : session.outputNames[0];
  return { url: plan.file.url, backend, session, input, output };
}

async function infer(ort, s, plan, pixels) {
  const S = plan.model.size;
  const data = toInputTensor(pixels, S, S, plan.model);
  const tensor = plan.model.inputType === "float16"
    ? new ort.Tensor("float16", toHalfArray(data), [1, 3, S, S])
    : new ort.Tensor("float32", data, [1, 3, S, S]);
  const results = await s.session.run({ [s.input]: tensor }, [s.output]);
  const out = results[s.output];
  const raw = typeof out.getData === "function" ? await out.getData() : out.data;
  const dims = out.dims;
  const values = toFloat32(raw, out.type);
  out.dispose?.();
  tensor.dispose?.();
  return { values, width: dims[dims.length - 1], height: dims[dims.length - 2] };
}

// ---- jobs ---------------------------------------------------------------------------

function reporter(onProgress) {
  let last = { phase: "", progress: -1, t: 0 };
  return (phase, progress, message) => {
    const p = Math.max(0, Math.min(1, progress));
    const now = Date.now();
    if (phase === last.phase && p < 1 && p - last.progress < 0.01 && now - last.t < 150) return;
    last = { phase, progress: p, t: now };
    onProgress?.({ phase, progress: p, message });
  };
}

const mb = (bytes) => Math.max(1, Math.round(bytes / MB));

// Whatever happens, a loaded session gets its idle timer again, so a failed or
// canceled run does not keep the model in memory for the rest of the session.
// A session that just ran out of memory is a poor bet for the next run: it is
// released at once.
async function runModel(job, opts) {
  clearTimeout(idleTimer);
  try {
    return await runModelOnce(job, opts);
  } catch (err) {
    if (err?.code === "memory") await releaseSession();
    throw err;
  } finally {
    if (current) scheduleRelease(job.plan?.idleReleaseMs || 0);
  }
}

async function runModelOnce(job, { onProgress, signal }) {
  const { plan, input, target } = job;
  const report = reporter(onProgress);
  const files = {};

  // One download bar for everything this run still needs.
  const wanted = [];
  if (!ortState && !plan.runtime.local) {
    wanted.push(["script", plan.runtime.script], ["glue", plan.runtime.glue], ["wasm", plan.runtime.wasm]);
  }
  const reuse = current && current.url === plan.file.url;
  if (!reuse) wanted.push(["model", plan.file]);
  const cached = await Promise.all(wanted.map(([, e]) => isCached(e, plan.cacheName)));
  const total = wanted.reduce((sum, [, e], i) => sum + (cached[i] ? 0 : e.bytes), 0);
  let done = 0;
  if (total > 0) report("download", 0, `Downloading · 0 of ${mb(total)} MB`);
  for (let i = 0; i < wanted.length; i++) {
    const [key, entry] = wanted[i];
    const base = done;
    const onBytes = cached[i] || !total ? null : (n) => report("download", (base + n) / total, `Downloading · ${Math.round((base + n) / MB)} of ${mb(total)} MB`);
    files[key] = await getBytes(entry, { cacheName: plan.cacheName, onBytes, signal });
    if (!cached[i]) done += entry.bytes || files[key].length;
    throwIfAborted(signal);
  }

  report("run", 0.05, "Starting the model");
  const ort = await loadOrt(plan.runtime, files);
  throwIfAborted(signal);
  let backend = ortState.build === "wasm" ? "wasm" : plan.backend;
  let gpuFailed = false;

  const fallBackToCpu = async (err) => {
    if (backend !== "webgpu" || isAbort(err)) throw err;
    // Some files only fit the GPU (the CPU would run out of memory on them).
    if (!plan.cpuFallback) throw tagged("gpu", err, { gpuFailed: true });
    console.warn("Longitude: WebGPU failed, using the CPU instead.", err);
    gpuFailed = true;
    backend = "wasm";
    await releaseSession();
    const bytes = files.model || (await getBytes(plan.file, { cacheName: plan.cacheName, signal }));
    current = await createSession(ort, plan, bytes, "wasm");
  };

  if (!reuse || current.backend !== backend) {
    await releaseSession();
    const bytes = files.model || (await getBytes(plan.file, { cacheName: plan.cacheName, signal }));
    try {
      current = await createSession(ort, plan, bytes, backend);
    } catch (err) {
      try {
        await fallBackToCpu(err);
      } catch (e) {
        throw sessionError(e);
      }
    }
  }
  backend = current.backend;
  clearTimeout(idleTimer);
  throwIfAborted(signal);

  report("run", 0.3, "Finding the subject");
  let out;
  try {
    out = await infer(ort, current, plan, input);
  } catch (err) {
    try {
      await fallBackToCpu(err);
      out = await infer(ort, current, plan, input);
    } catch (e) {
      throw sessionError(e);
    }
  }
  throwIfAborted(signal);

  report("run", 0.85, "Refining edges");
  const alpha = outputToAlpha(out.values, out.width, out.height, target.width, target.height, {
    activation: plan.model.activation,
    refine: plan.refine,
  });
  return { alpha, width: target.width, height: target.height, backend: current.backend, variant: plan.variantId, gpuFailed };
}

// mask.js loads with the first edge-magic job, so planning and model runs
// never parse it.
async function runEdgeMagic(job, { onProgress }) {
  onProgress?.({ phase: "run", progress: 0.3, message: "Finding the background" });
  const { edgeMagicAlpha } = await import("./mask.js");
  const a = edgeMagicAlpha(job.image, job.options || {});
  onProgress?.({ phase: "run", progress: 0.9, message: "Refining edges" });
  return { alpha: a.data, width: a.width, height: a.height, backend: "local", variant: null, gpuFailed: false };
}

let queue = Promise.resolve();

// Run one job; jobs queue so a session is never used by two runs at once.
//   { type: "model", plan, input: RGBA bytes at plan.model.size², target: { width, height } }
//   { type: "edge-magic", image: { width, height, data }, options }
// Resolves { alpha: Uint8ClampedArray, width, height, backend, variant, gpuFailed }.
export function runJob(job, { onProgress, signal } = {}) {
  const task = queue.then(async () => {
    throwIfAborted(signal);
    if (job.type === "edge-magic") return runEdgeMagic(job, { onProgress });
    if (job.type === "model") return runModel(job, { onProgress, signal });
    throw Error(`Unknown job "${job.type}".`);
  });
  queue = task.catch(() => {});
  return task;
}

// Free the model session (also done after a few idle minutes). Queued, so it
// never frees a session in the middle of a run.
export function releaseModel() {
  const task = queue.then(releaseSession);
  queue = task.catch(() => {});
  return task;
}
