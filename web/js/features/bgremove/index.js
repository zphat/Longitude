// Background removal service (SPEC 11). Everything runs on this machine: the
// model and runtime are downloaded once, cached, and images never leave it.
//
//   const bg = createBgService(ctx);
//   if (await bg.confirmDownload("fast")) await bg.removeLayerBackground(id);
//   bg.status("fast").state       // "ready-bundled", "not-downloaded", "downloading", ...
//   await bg.prepare("fast");     // the one-time download, without a layer
//   ctx.on("bg-model", (s) => …); // every status change, for every view
//
// Providers are a registry, so mods can add their own (docs/BGREMOVE.md).

import { createRegistry } from "../../app/context.js";
import { BG_CONFIG, variantsFor, vendorUrl } from "./config.js";
import { makeCanvas, readPixels, sourceSize } from "./pixels.js";
import { canTrim, cutoutCrop, fitProps, opaqueBounds, sameCrop, unionCrop } from "./trim.js";

export { BG_CONFIG } from "./config.js";

const MB = 1e6;

// ---- sizes and download words (pure; every view shows these) ----------------------
// Decimal megabytes from the byte counts in BG_CONFIG, so Home, the inspector,
// quick tools, Settings and the confirm dialog always say the same number.

export function toMB(bytes) {
  return bytes > 0 ? Math.max(1, Math.round(bytes / MB)) : 0;
}

export function formatMB(bytes) {
  return `${toMB(bytes)} MB`;
}

// "3.2 MB/s", "18 MB/s", "640 KB/s"; "" when unknown.
export function formatSpeed(bytesPerSecond) {
  const v = Number(bytesPerSecond);
  if (!Number.isFinite(v) || v <= 0) return "";
  if (v < MB) return `${Math.max(1, Math.round(v / 1e3))} KB/s`;
  if (v < 9.95 * MB) return `${(Math.round(v / 1e5) / 10).toFixed(1)} MB/s`;
  return `${Math.round(v / MB)} MB/s`;
}

// "A few seconds left", "About 40 s left", "About 3 min left"; "" when unknown.
export function formatEta(seconds) {
  const s = Number(seconds);
  if (seconds == null || !Number.isFinite(s) || s < 0) return "";
  if (s < 8) return "A few seconds left";
  if (s < 55) return `About ${Math.ceil(s / 5) * 5} s left`;
  if (s < 3570) return `About ${Math.max(1, Math.round(s / 60))} min left`;
  return `About ${Math.round(s / 3600)} h left`;
}

// "12 of 69 MB · 3.2 MB/s · About 20 s left". The done part rounds down, so it
// never reads "69 of 69 MB" before the last byte.
export function progressText({ bytes = 0, total = 0, speed = null, eta = null } = {}) {
  const all = toMB(total);
  const done = Math.min(all, Math.floor(Math.max(0, bytes) / MB));
  return [total > 0 ? `${done} of ${all} MB` : "", formatSpeed(speed), formatEta(eta)].filter(Boolean).join(" · ");
}

// Download speed over the last few seconds. now() in milliseconds.
export function createRate({ now = () => Date.now(), window = 5000 } = {}) {
  let samples = [];
  return {
    push(bytes) {
      const t = now();
      samples.push([t, bytes]);
      while (samples.length > 2 && t - samples[0][0] > window) samples.shift();
    },
    // Bytes per second, or null until there is a second's worth to go on.
    speed() {
      if (samples.length < 2) return null;
      const [t0, b0] = samples[0];
      const [t1, b1] = samples[samples.length - 1];
      const dt = (t1 - t0) / 1000;
      return dt >= 1 && b1 >= b0 ? (b1 - b0) / dt : null;
    },
    eta(total) {
      const v = this.speed();
      const last = samples[samples.length - 1]?.[1] ?? 0;
      return v > 0 && total > 0 ? Math.max(0, (total - last) / v) : null;
    },
    reset() {
      samples = [];
    },
  };
}

// ---- file plan without the engine ----------------------------------------------------
// The same URLs engine.js plans (runtimeFiles, modelFile), worked out from
// BG_CONFIG and web/vendor/manifest.json alone, so Home and the inspector can
// tell whether a model is here without loading the engine or asking for the
// graphics card. tests/bgremove-status.test.js keeps the two in step.

function runtimeEntries(build, manifest) {
  const ort = BG_CONFIG.ort;
  const b = ort.builds?.[build];
  if (!b) return null;
  const parts = [b.script, b.glue, b.wasm];
  const local = manifest?.ort?.version === ort.version && parts.every((p) => manifest.ort.files?.includes(p.file));
  const base = local ? vendorUrl("ort/") : ort.base;
  return parts.map((p) => ({ url: new URL(p.file, base).href, file: p.file, bytes: p.bytes || 0, local }));
}

function modelEntry(variant, manifest) {
  const local = !!(variant.file && manifest?.models?.[variant.file]);
  return { url: local ? vendorUrl(`models/${variant.file}`) : variant.url, file: variant.file, bytes: variant.bytes || 0, local };
}

const canWasm = (v) => (v.backends?.length ? v.backends : ["wasm"]).includes("wasm");
const sumBytes = (list) => list.reduce((s, e) => s + (e.bytes || 0), 0);

// Every remote URL the light check looks for in Cache Storage.
export function remoteUrls(modelId) {
  const model = BG_CONFIG.models[modelId];
  const out = Object.values(model?.variants || {}).map((v) => v.url);
  for (const build of Object.keys(BG_CONFIG.ort.builds || {})) out.push(...runtimeEntries(build, null).map((e) => e.url));
  return out;
}

// { ready, bundled, bundledBy, sizeBytes, downloadBytes, modelBytes, file, runtime } for modelId.
//   bundledBy: "app" when the desktop installer put the file there (its
//   manifest says "bundled": "desktop"), "vendor" for tools/fetch_model.py
//   modelBytes: the model file alone (the runtime is shared between models)
//   gpu: the browser has WebGPU (a guess: only the engine asks for the adapter)
//   has(url): the file is in Cache Storage
// A model counts as here when any file this machine could run is present (a
// GPU with shader-f16 may have fetched the fp16 file); the size of a missing
// one is what the engine would most likely fetch.
export function lightPlan(modelId, { manifest = null, gpu = false, has = () => false } = {}) {
  const model = BG_CONFIG.models[modelId];
  if (!model) return null;
  const present = (e) => e.local || !!has(e.url);
  const runnable = Object.values(model.variants || {}).filter((v) => gpu || canWasm(v));
  let file = null;
  for (const v of runnable) {
    const e = modelEntry(v, manifest);
    if (present(e)) {
      file = e;
      break;
    }
  }
  let runtime = null;
  for (const build of gpu ? ["webgpu", "wasm"] : ["wasm"]) {
    const parts = runtimeEntries(build, manifest);
    if (parts?.every(present)) {
      runtime = { build, parts };
      break;
    }
  }
  const want = variantsFor(model, { backend: gpu ? "webgpu" : "wasm", f16: false })[0]?.variant || runnable[0];
  const fileOut = file || (want ? modelEntry(want, manifest) : null);
  const build = gpu ? "webgpu" : "wasm";
  const rt = runtime || { build, parts: runtimeEntries(build, manifest) || [] };
  const all = [...rt.parts, ...(fileOut ? [fileOut] : [])];
  const missing = all.filter((e) => !present(e));
  return {
    ready: !!file && !!runtime,
    bundled: !!file?.local,
    bundledBy: bundledBy(file, manifest),
    sizeBytes: sumBytes(all),
    downloadBytes: sumBytes(missing),
    modelBytes: fileOut?.bytes || 0,
    file: fileOut,
    runtime: rt,
  };
}

// Who put a local file in place: the desktop installer ("app") or fetch_model.py ("vendor").
function bundledBy(file, manifest) {
  if (!file?.local) return null;
  return manifest?.bundled === "desktop" ? "app" : "vendor";
}

// ---- the status of one provider (pure state machine) ----------------------------------
// state: "checking" | "ready-bundled" | "ready-cached" | "downloading" | "not-downloaded" | "error"
//   ready-bundled   the files ship with the app (web/vendor/: the desktop installer
//                   or tools/fetch_model.py), or the provider needs none (Magic)
//   ready-cached    downloaded before, kept in Cache Storage
//   downloading     bytes of total, speed (bytes/s) and eta (s) once known
//   not-downloaded  downloadBytes still to fetch (sizeBytes: the whole first-use download)
//   error           error: { message, code }; prepare() tries again
// Events: checked { ready, bundled, sizeBytes, downloadBytes }, start { total, origin },
// progress { bytes, speed, eta }, done { bundled }, cancel { downloadBytes }, fail { message, code },
// removed { bundled, downloadBytes }.

export const MODEL_STATES = Object.freeze(["checking", "ready-bundled", "ready-cached", "downloading", "not-downloaded", "error"]);

const num = (v, fallback) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const IDLE = { bytes: 0, total: 0, speed: null, eta: null };

export function nextStatus(prev, ev = {}) {
  const s = { ...prev };
  const to = (state, extra = {}) => ({ ...s, ...extra, state, ready: state === "ready-bundled" || state === "ready-cached" });
  switch (ev.type) {
    case "checked": {
      const sizeBytes = num(ev.sizeBytes, s.sizeBytes);
      const modelBytes = num(ev.modelBytes, s.modelBytes);
      // A look while the download runs only corrects the size.
      if (s.state === "downloading") return to("downloading", { sizeBytes, modelBytes });
      // storable: false when the browser keeps no downloads for this site (no
      // Cache Storage, e.g. a plain-http address): nothing to get ready then.
      const storable = ev.storable === undefined ? s.storable !== false : ev.storable !== false;
      if (ev.ready) {
        const bundled = !!ev.bundled;
        return to(bundled ? "ready-bundled" : "ready-cached", { ...IDLE, sizeBytes, modelBytes, downloadBytes: 0, bundled, bundledBy: bundled ? ev.bundledBy || s.bundledBy || null : null, error: null, storable });
      }
      const downloadBytes = num(ev.downloadBytes, sizeBytes);
      // A failed download stays failed (with its Try again) until it works.
      if (s.state === "error") return to("error", { sizeBytes, modelBytes, downloadBytes, bundled: false, bundledBy: null, storable });
      return to("not-downloaded", { ...IDLE, sizeBytes, modelBytes, downloadBytes, bundled: false, bundledBy: null, error: null, storable });
    }
    case "start":
      return to("downloading", { ...IDLE, total: num(ev.total, s.downloadBytes || 0), sizeBytes: num(ev.sizeBytes, s.sizeBytes), modelBytes: num(ev.modelBytes, s.modelBytes), origin: ev.origin || s.origin || null, error: null });
    case "progress":
      if (s.state !== "downloading") return prev;
      return to("downloading", {
        bytes: Math.max(0, Math.min(s.total || Infinity, num(ev.bytes, s.bytes))),
        speed: ev.speed === undefined ? s.speed : ev.speed,
        eta: ev.eta === undefined ? s.eta : ev.eta,
      });
    case "done":
      return to(ev.bundled ? "ready-bundled" : "ready-cached", { ...IDLE, bytes: s.total, total: s.total, downloadBytes: 0, bundled: !!ev.bundled, bundledBy: ev.bundled ? ev.bundledBy || s.bundledBy || null : null, error: null });
    case "cancel":
      return to("not-downloaded", { ...IDLE, downloadBytes: num(ev.downloadBytes, s.downloadBytes), error: null });
    case "fail":
      return to("error", {
        speed: null,
        eta: null,
        downloadBytes: num(ev.downloadBytes, s.downloadBytes),
        error: { message: ev.message || "The download stopped. Try again.", code: ev.code || "network" },
      });
    case "removed":
      if (ev.bundled) return to("ready-bundled", { ...IDLE, downloadBytes: 0, bundled: true, bundledBy: ev.bundledBy || s.bundledBy || null, error: null });
      return to("not-downloaded", { ...IDLE, downloadBytes: num(ev.downloadBytes, s.sizeBytes), bundled: false, bundledBy: null, error: null });
    default:
      return prev;
  }
}

// The words for a status, the same in every view.
//   short: one line for small places ("One-time 69 MB download", "Downloading · 34%")
//   label: what Settings calls the state; detail: a longer line; tip: for a tooltip
// "Included with the app" is the desktop installer's copy; files that
// tools/fetch_model.py put in web/vendor/ (bundledBy "vendor") say so instead.
export function describeStatus(s) {
  if (!s) return { short: "", label: "", detail: "", tip: "", percent: 0 };
  const percent = s.state === "downloading" ? (s.total > 0 ? Math.min(99, Math.floor((s.bytes / s.total) * 100)) : 0) : s.ready ? 100 : 0;
  if (s.kind !== "ml") return { short: "No download", label: "No download needed", detail: "Built in, nothing to download.", tip: "", percent };
  const sizeBytes = s.downloadBytes > 0 ? s.downloadBytes : s.sizeBytes;
  const size = formatMB(sizeBytes);
  switch (s.state) {
    case "ready-bundled":
      if (s.bundledBy === "vendor") return { short: "Runs on this computer", label: "Downloaded for offline use", detail: "Downloaded for offline use (web/vendor). Works offline.", tip: "Downloaded for offline use", percent };
      return { short: "Runs on this computer", label: "Included with the app", detail: "Included with the app. Works offline.", tip: "Included with the app", percent };
    case "ready-cached":
      return { short: "Runs on this computer", label: "Downloaded", detail: `Downloaded once (${formatMB(s.modelBytes || s.sizeBytes)}). Works offline.`, tip: "Downloaded once, works offline", percent };
    case "downloading":
      return { short: `Downloading · ${percent}%`, label: "Downloading", detail: progressText(s) || "Starting the download", tip: "Downloads once, then works offline", percent };
    case "error":
      return { short: "Download stopped", label: "Download stopped", detail: s.error?.message || "The download stopped. Try again.", tip: "", percent };
    case "not-downloaded":
      // A mod's provider that did not say how big its download is.
      if (!(sizeBytes > 0)) return { short: "", label: "Not downloaded", detail: "Downloads on first use.", tip: "", percent };
      if (s.storable === false) {
        return { short: `${size} download`, label: "Not kept", detail: `This browser does not keep downloads for this site, so the ${size} download repeats each time it is needed.`, tip: "", percent };
      }
      return { short: `One-time ${size} download`, label: "Not downloaded", detail: `One-time ${size} download. Runs on this computer and works offline after.`, tip: "", percent };
    default:
      return { short: "", label: "Checking", detail: "", tip: "", percent };
  }
}

// The engine (model planning, downloads, inference), the worker runner and
// the mask helpers (mask.js) are only needed once background removal or a
// cutout edit is used, so they load on first use instead of at startup. The
// service worker keeps them for offline use. A failed load (offline before
// the first use) is retried next time.
let enginePromise = null;
let runnerModule = null;
let maskPromise = null;
let maskModule = null;

// mask.js; also kept for the synchronous ctx.bg.masks once loaded.
function maskLib() {
  maskPromise ||= import("./mask.js").then(
    (m) => (maskModule = m),
    (err) => {
      maskPromise = null;
      throw err;
    },
  );
  return maskPromise;
}

let engineModule = null;
function engine() {
  enginePromise ||= import("./engine.js").then(
    (m) => (engineModule = m),
    (err) => {
      enginePromise = null;
      throw err;
    },
  );
  return enginePromise;
}

function runnerLib() {
  runnerModule ||= import("./runner.js").catch((err) => {
    runnerModule = null;
    throw err;
  });
  return runnerModule;
}

const LOAD_FAILED = "Could not start the background remover in this browser.";

async function asError(err, load = engine) {
  if (err instanceof Error && err.code) return err;
  let info;
  try {
    info = (await load()).friendlyError(err);
  } catch {
    info = { name: "Error", code: "runtime", message: LOAD_FAILED, detail: String(err?.message || err || "") };
  }
  return Object.assign(Error(info.message), { name: info.name, code: info.code, detail: info.detail });
}

// Same error as engine.js abortError(), without loading the engine.
function abortError() {
  return Object.assign(Error("Canceled"), { name: "AbortError", code: "cancelled", detail: "" });
}

// The worker runner, created on first use. release() before then has nothing to free.
function lazyRunner() {
  let made = null;
  const get = () => (made ||= runnerLib().then((m) => m.createRunner())).catch((err) => {
    made = null;
    throw err;
  });
  return {
    run: async (job, opts) => (await get()).run(job, opts),
    release() {
      made?.then((r) => r.release()).catch(() => {});
    },
  };
}

function linkSignal(controller, signal) {
  if (!signal) return;
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
}

// The model sees the image squeezed to size x size. Transparent areas become
// mid gray so they read as plain background.
function modelInput(source, size) {
  const c = makeCanvas(size, size);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "#808080";
  g.fillRect(0, 0, size, size);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(drawable(source), 0, 0, size, size);
  return g.getImageData(0, 0, size, size).data;
}

function drawable(source) {
  if (!source?.data || source.getContext) return source;
  const c = makeCanvas(source.width, source.height);
  const g = c.getContext("2d");
  const img = g.createImageData(source.width, source.height);
  img.data.set(source.data);
  g.putImageData(img, 0, 0);
  return c;
}

// Blob/File -> something drawable. SVG and a few formats only decode through <img>.
async function toBitmap(input) {
  if (typeof Blob === "undefined" || !(input instanceof Blob)) return input;
  for (const opts of [{ imageOrientation: "from-image" }, undefined]) {
    try {
      return await createImageBitmap(input, opts);
    } catch {}
  }
  if (typeof Image !== "undefined") {
    const url = URL.createObjectURL(input);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      if (img.naturalWidth && img.naturalHeight) return img;
    } catch {
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  throw Object.assign(Error("This file is not an image Longitude can read."), { code: "decode" });
}

// A big photo from a file is scaled to maxSide on its long side first: the
// model runs at about 1k anyway, and a full-size cutout canvas of a 12k photo
// can run the tab out of memory.
function capSide(source, maxSide) {
  const { width, height } = sourceSize(source);
  const long = Math.max(width, height);
  if (!(maxSide > 0) || !(long > maxSide)) return source;
  const k = maxSide / long;
  const c = makeCanvas(Math.max(1, Math.round(width * k)), Math.max(1, Math.round(height * k)));
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(source, 0, 0, c.width, c.height);
  source.close?.();
  return c;
}

// Provider object -> its { id, label, note, model } for providers made by
// modelProvider(): those get downloads through prepare() and a status.
const ML = new WeakMap();

// deps (tests): { engine: () => Promise<engine module>, caches, fetch, gpu: bool, now: () => ms }
export function createBgService(ctx, deps = {}) {
  const runner = lazyRunner();
  let avoidGpu = false; // set for the rest of the session once the graphics card fails
  const running = new Map(); // layerId -> { promise, controller }
  // Box trims this session: layerId -> { asset, crop: the crop before trimming,
  // trims: crops the trims set }. "Restore original" puts the crop back while
  // the layer still shows one of those trims (the user has not re-cropped).
  const trims = new Map();

  let lib = null; // the engine module once loaded
  const loadEngine = () => (deps.engine ? deps.engine() : engine()).then((m) => (lib = m));
  const toError = (err) => asError(err, loadEngine);
  const clock = deps.now || (() => Date.now());

  // Resolves once no drag on the canvas holds an undo step open (at most 10 s),
  // so a result that arrives mid-drag is its own undo step (as importer.js does).
  function gestureDone() {
    if (!ctx.editor?.interacting || !ctx.store.inGesture || !ctx.on) return Promise.resolve();
    return new Promise((resolve) => {
      let off = null;
      const done = () => {
        clearTimeout(timer);
        off?.();
        resolve();
      };
      const timer = setTimeout(done, 10000);
      off = ctx.on("interaction", ({ active } = {}) => {
        if (!active) done();
      });
    });
  }

  const providers = createRegistry("bg-providers", {
    validate(def) {
      if (typeof def.label !== "string" || !def.label.trim()) throw Error(`bg-providers: "${def.id}" needs a label`);
      if (typeof def.run !== "function") throw Error(`bg-providers: "${def.id}" needs run()`);
    },
  });

  // ---- where the files are: web/vendor/ and Cache Storage, without the engine -----

  let manifestPromise = null;
  function vendorManifest() {
    manifestPromise ||= (async () => {
      try {
        const res = await (deps.fetch || globalThis.fetch)(vendorUrl("manifest.json"), { cache: "no-cache" });
        if (!res?.ok) return null;
        const json = await res.json();
        return json && typeof json === "object" ? json : null;
      } catch {
        return null;
      }
    })();
    return manifestPromise;
  }

  async function openStore() {
    try {
      const store = "caches" in deps ? deps.caches : globalThis.caches;
      return store ? await store.open(BG_CONFIG.cacheName) : null;
    } catch {
      return null;
    }
  }

  async function cachedSet(urls) {
    const cache = await openStore();
    const out = new Set();
    if (!cache) return out;
    await Promise.all(
      urls.map(async (u) => {
        try {
          if (await cache.match(u)) out.add(u);
        } catch {}
      }),
    );
    return out;
  }

  const hasGpu = () => !avoidGpu && ("gpu" in deps ? !!deps.gpu : !!globalThis.navigator?.gpu?.requestAdapter);

  async function lightCheck(def) {
    const [manifest, store] = await Promise.all([vendorManifest(), openStore()]);
    const have = await cachedSet(remoteUrls(def.model));
    return { ...lightPlan(def.model, { manifest, gpu: hasGpu(), has: (u) => have.has(u) }), storable: !!store };
  }

  // The engine's own plan: the exact variant and runtime build for this machine.
  async function precisePlan(def) {
    const engineLib = lib || (await loadEngine());
    const plan = await engineLib.planModel(def.model, { avoidGpu });
    const entries = [plan.runtime.script, plan.runtime.glue, plan.runtime.wasm, plan.file];
    const here = await Promise.all(entries.map((e) => Promise.resolve(engineLib.isCached(e, plan.cacheName)).catch(() => false)));
    const todo = entries.filter((_, i) => !here[i]);
    return {
      plan,
      todo,
      ready: !todo.length,
      bundled: !!plan.file.local,
      bundledBy: bundledBy(plan.file, await vendorManifest()),
      sizeBytes: sumBytes(entries),
      downloadBytes: sumBytes(todo),
      modelBytes: plan.file.bytes || 0,
      storable: !!(await openStore()),
    };
  }

  // ---- status: one per provider, sent as "bg-model" events ------------------------

  const statuses = new Map(); // providerId -> status
  const emitted = new Map(); // providerId -> { at, timer, state }
  const checks = new Map(); // providerId -> ticket

  function initialStatus(p) {
    const def = ML.get(p);
    const base = { id: p.id, label: p.label, kind: p.kind === "ml" ? "ml" : "local", model: def?.model || null, bundled: false, bundledBy: null, error: null, origin: null, storable: true, ...IDLE };
    if (base.kind !== "ml") return { ...base, state: "ready-bundled", ready: true, bundled: true, sizeBytes: 0, downloadBytes: 0 };
    const est = def ? lightPlan(def.model, { gpu: hasGpu() }) : null;
    const size = est ? est.sizeBytes : Math.max(0, (p.sizeMB || 0) * MB);
    return { ...base, state: "checking", ready: false, sizeBytes: size, downloadBytes: est ? est.downloadBytes : size, modelBytes: est ? est.modelBytes : size };
  }

  function current(id) {
    const p = providers.get(id);
    if (!p) return null;
    let s = statuses.get(id);
    if (!s) {
      s = initialStatus(p);
      statuses.set(id, s);
    } else if (s.label !== p.label) {
      s = { ...s, label: p.label };
      statuses.set(id, s);
    }
    return s;
  }

  // Progress goes out at most every 120 ms (and once more after the last
  // byte of a burst); every change of state goes out at once.
  function emitStatus(id) {
    const rec = emitted.get(id) || { at: -Infinity, timer: 0, state: null };
    emitted.set(id, rec);
    const send = () => {
      clearTimeout(rec.timer);
      rec.timer = 0;
      rec.at = clock();
      const latest = statuses.get(id);
      rec.state = latest?.state || null;
      if (latest) ctx.emit?.("bg-model", { ...latest });
    };
    const s = statuses.get(id);
    if (!s || s.state !== rec.state || s.state !== "downloading" || clock() - rec.at >= 120) send();
    else if (!rec.timer) rec.timer = setTimeout(send, 120);
  }

  function update(id, ev) {
    const prev = current(id);
    if (!prev) return null;
    const next = nextStatus(prev, ev);
    if (next === prev) return prev;
    statuses.set(id, next);
    emitStatus(id);
    return next;
  }

  // Look again (Cache Storage, web/vendor/). With the engine loaded the
  // engine's own plan is used; before that the light check, which neither
  // loads the engine nor asks for the graphics card.
  async function refreshOne(p) {
    const id = p.id;
    current(id);
    if (downloads.has(id)) return statuses.get(id);
    const ticket = (checks.get(id) || 0) + 1;
    checks.set(id, ticket);
    const def = ML.get(p);
    let res;
    try {
      if (def) res = lib ? await precisePlan(def).catch(() => lightCheck(def)) : await lightCheck(def);
      else if (p.kind !== "ml") res = { ready: true, bundled: true, sizeBytes: 0, downloadBytes: 0 };
      else {
        const ready = typeof p.ready === "function" ? !!(await p.ready()) : true;
        const size = Math.max(0, (p.sizeMB || 0) * MB);
        res = { ready, bundled: false, sizeBytes: size, downloadBytes: ready ? 0 : size, modelBytes: size };
      }
    } catch {
      return statuses.get(id);
    }
    if (checks.get(id) !== ticket || !providers.has(id) || downloads.has(id)) return statuses.get(id);
    return update(id, { type: "checked", ...res });
  }

  async function refreshStatus(id) {
    if (id) {
      const p = providers.get(id);
      return p ? { ...(await refreshOne(p)) } : null;
    }
    await Promise.all(providers.list().map((p) => refreshOne(p)));
    return providers.list().map((p) => ({ ...current(p.id) }));
  }

  // Snapshot for one provider (default: the default one). The first call
  // starts a look; until it answers the state is "checking".
  function status(id) {
    const pid = id || bg.defaultProvider;
    const known = statuses.has(pid);
    const s = current(pid);
    if (!s) return null;
    if (!known && s.state === "checking") refreshOne(providers.get(pid));
    return { ...s };
  }

  providers.onChange?.(() => {
    for (const id of [...statuses.keys()]) if (!providers.has(id)) statuses.delete(id);
  });

  // ---- downloads without a layer: prepare(), shared with removals ------------------

  const downloads = new Map(); // providerId -> { promise, controller, keep, waiters, listeners, bytes, total, started, origin }

  function startDownload(id, def, origin) {
    const controller = new AbortController();
    const rate = createRate({ now: clock });
    const rec = { controller, keep: 0, waiters: 0, listeners: new Set(), bytes: 0, total: 0, started: false, early: false, origin };
    downloads.set(id, rec);
    // Show the download at once: loading the engine and asking for the
    // graphics card (the exact plan) can take a few seconds. Only for a model
    // known to be missing, so a removal with the model here shows nothing.
    const was = current(id)?.state;
    if (was === "not-downloaded" || was === "error") {
      rec.early = true;
      update(id, { type: "start", total: 0, origin });
    }
    const tick = (bytes) => {
      rec.bytes = bytes;
      rate.push(bytes);
      update(id, { type: "progress", bytes, speed: rate.speed(), eta: rate.eta(rec.total) });
      for (const fn of rec.listeners) fn(rec);
    };
    rec.promise = (async () => {
      const engineLib = lib || (await loadEngine());
      const pre = await precisePlan(def);
      if (controller.signal.aborted) throw abortError();
      if (pre.ready) return pre;
      if (!pre.storable) {
        // Out of "downloading" first: a look while downloading changes only the size.
        if (rec.early) update(id, { type: "cancel" });
        update(id, { type: "checked", ...pre });
        throw Object.assign(Error("This browser does not keep downloads for this site, so the model downloads each time you remove a background."), { code: "storage" });
      }
      rec.total = pre.downloadBytes;
      rec.started = true;
      update(id, { type: "start", total: rec.total, sizeBytes: pre.sizeBytes, modelBytes: pre.modelBytes, origin: rec.origin });
      for (const fn of rec.listeners) fn(rec);
      let base = 0;
      // Runtime first, then the model; each finished file stays in Cache
      // Storage, so a canceled or failed download goes on from the next file.
      for (const entry of pre.todo) {
        const at = base;
        await engineLib.getBytes(entry, { cacheName: pre.plan.cacheName, signal: controller.signal, onBytes: (n) => tick(at + n) });
        base += entry.bytes || 0;
        if (controller.signal.aborted) throw abortError();
        tick(base);
      }
      // getBytes() keeps going when the browser refuses to store a file (a
      // full disk), so look before saying it works offline.
      const kept = await Promise.all(pre.todo.map((e) => Promise.resolve(engineLib.isCached(e, pre.plan.cacheName)).catch(() => false)));
      if (kept.includes(false)) {
        throw Object.assign(Error(`The download finished, but ${ctx.desktop ? "Longitude" : "the browser"} did not keep it. Free up some disk space and try again.`), { code: "storage" });
      }
      return pre;
    })();
    rec.promise.then(
      (pre) => {
        downloads.delete(id);
        if (!rec.started) {
          // Nothing was missing after all (a "checked" is ignored while downloading).
          update(id, rec.early ? { type: "done", bundled: pre.bundled, bundledBy: pre.bundledBy } : { type: "checked", ...pre });
          return;
        }
        update(id, { type: "done", bundled: pre.bundled, bundledBy: pre.bundledBy });
        // The others share the runtime, so what they still need changed too.
        for (const p of providers.list()) if (p.id !== id) refreshOne(p);
      },
      async (err) => {
        downloads.delete(id);
        const e = await toError(err);
        if (e.code === "cancelled") {
          // Canceled during the plan of a model the status said was here: nothing to undo.
          if (rec.started || rec.early) update(id, { type: "cancel" });
          const p = providers.get(id);
          if (p) refreshOne(p);
        } else {
          update(id, { type: "fail", message: e.message, code: e.code });
        }
      },
    );
    return rec;
  }

  // Waits for rec. Without a signal the caller keeps the download going until
  // cancelDownload(); with one, aborting leaves it, and the download stops
  // once nobody is left waiting for it.
  function join(rec, { signal, onProgress } = {}) {
    if (onProgress) {
      rec.listeners.add(onProgress);
      if (rec.started) onProgress(rec);
    }
    if (signal) rec.waiters++;
    else rec.keep++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const leave = () => {
        settled = true;
        if (onProgress) rec.listeners.delete(onProgress);
        signal?.removeEventListener("abort", onAbort);
        if (signal) rec.waiters--;
      };
      const onAbort = () => {
        if (settled) return;
        leave();
        if (rec.waiters <= 0 && rec.keep <= 0) rec.controller.abort();
        reject(abortError());
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      rec.promise.then(
        (v) => {
          if (settled) return;
          leave();
          resolve(v);
        },
        (err) => {
          if (settled) return;
          leave();
          reject(err);
        },
      );
    });
  }

  function downloadFor(id, def, { signal, onProgress } = {}) {
    let rec = downloads.get(id);
    if (!rec) rec = startDownload(id, def, signal ? "run" : "prepare");
    else if (!signal && rec.origin !== "prepare") {
      // Someone asked for it on purpose (Home, Settings): its outcome gets a toast.
      rec.origin = "prepare";
      const s = statuses.get(id);
      if (s) statuses.set(id, { ...s, origin: "prepare" });
    }
    return join(rec, { signal, onProgress });
  }

  // Download a provider's model and runtime now, without a layer. Resolves
  // with the status once ready; rejects (and the status says "error") if the
  // download fails. A second call while it runs joins the same download.
  async function prepare(id, { signal, onProgress } = {}) {
    const p = resolveProvider(id);
    const def = ML.get(p);
    if (!def) return { ...(await refreshOne(p)) };
    try {
      await downloadFor(p.id, def, { signal, onProgress });
    } catch (err) {
      throw await toError(err);
    }
    return { ...current(p.id) };
  }

  function cancelDownload(id) {
    const rec = downloads.get(id || bg.defaultProvider);
    if (!rec) return false;
    rec.controller.abort();
    return true;
  }

  // Delete a provider's downloaded model (files that ship in web/vendor/
  // stay). The runtime goes too once no downloaded model is left.
  async function remove(id) {
    const p = resolveProvider(id);
    const def = ML.get(p);
    if (!def) return { ...current(p.id) };
    cancelDownload(p.id);
    runner.release();
    const cache = await openStore();
    if (cache) {
      const variantUrls = (m) => Object.values(BG_CONFIG.models[m]?.variants || {}).map((v) => v.url);
      for (const url of variantUrls(def.model)) await Promise.resolve(cache.delete(url)).catch(() => false);
      const models = new Set(providers.list().map((x) => ML.get(x)?.model).filter(Boolean));
      const left = await cachedSet([...models].flatMap(variantUrls));
      if (!left.size) {
        for (const build of Object.keys(BG_CONFIG.ort.builds || {})) {
          for (const e of runtimeEntries(build, null)) await Promise.resolve(cache.delete(e.url)).catch(() => false);
        }
      }
    }
    await refreshStatus();
    return { ...current(p.id) };
  }

  // Disk used by downloaded models and runtimes: { bytes, files, bundledBytes, bundledBy }.
  // bundledBytes: what is in web/vendor/; bundledBy: "app" for the desktop
  // installer's copy, "vendor" for one from tools/fetch_model.py, null for none.
  async function storage() {
    let bytes = 0;
    let files = 0;
    const cache = await openStore();
    if (cache) {
      try {
        for (const req of await cache.keys()) {
          const res = await cache.match(req);
          const n = Number(res?.headers?.get?.("X-Longitude-Bytes"));
          bytes += Number.isFinite(n) && n > 0 ? n : 0;
          files++;
        }
      } catch {}
    }
    const manifest = await vendorManifest();
    let bundledBytes = 0;
    for (const m of Object.values(manifest?.models || {})) bundledBytes += Number(m?.bytes) || 0;
    if (manifest?.ort?.version === BG_CONFIG.ort.version) {
      const sizes = new Map();
      for (const b of Object.values(BG_CONFIG.ort.builds || {})) for (const part of [b.script, b.glue, b.wasm]) sizes.set(part.file, part.bytes || 0);
      for (const f of manifest.ort.files || []) bundledBytes += sizes.get(f) || 0;
    }
    return { bytes, files, bundledBytes, bundledBy: bundledBytes ? (manifest?.bundled === "desktop" ? "app" : "vendor") : null };
  }

  // Download progress in the shape removals report on bg-progress.
  const downloadEvent = (rec) => ({
    phase: "download",
    progress: rec.total > 0 ? Math.min(1, rec.bytes / rec.total) : 0,
    message: rec.total > 0 ? `Downloading · ${progressText({ bytes: rec.bytes, total: rec.total })}` : "Downloading",
  });

  // ---- ML providers built from BG_CONFIG --------------------------------------

  async function mlInfo(def) {
    const model = BG_CONFIG.models[def.model];
    const pre = await precisePlan(def);
    const { plan } = pre;
    const runtimeBytes = plan.runtime.wasm.bytes + plan.runtime.script.bytes + plan.runtime.glue.bytes;
    // The status takes the engine's numbers (unless a download is running).
    const p = providers.get(def.id);
    if (p && ML.get(p)?.model === def.model && !downloads.has(def.id)) update(def.id, { type: "checked", ...pre });
    return {
      id: def.id,
      label: def.label,
      note: def.note || "",
      kind: "ml",
      sizeMB: toMB(pre.sizeBytes),
      downloadMB: toMB(pre.downloadBytes),
      modelMB: toMB(plan.file.bytes),
      runtimeMB: toMB(runtimeBytes),
      cached: pre.ready,
      license: model?.license || "",
      source: model?.source || null,
      page: plan.file.page,
      backend: plan.backend,
      variant: plan.variantId,
      offline: plan.file.local && plan.runtime.local,
    };
  }

  // A provider that runs one of BG_CONFIG.models in the worker.
  // def: { id, label, note?, model: "<BG_CONFIG.models key>" }
  function modelProvider(def) {
    const model = BG_CONFIG.models[def.model];
    if (!model) throw Error(`bg-providers: unknown model "${def.model}"`);
    const first = Object.values(model.variants || {})[0];
    const provider = {
      id: def.id,
      label: def.label,
      note: def.note || "",
      kind: "ml",
      model: def.model,
      sizeMB: toMB(first?.bytes || 0),
      license: model.license || "",
      source: model.source || null,
      page: first?.page || null,
      info: () => mlInfo(def),
      async ready() {
        return (await mlInfo(def)).cached;
      },
      async run(source, { onProgress, signal } = {}) {
        const { width, height } = sourceSize(source);
        if (!width || !height) throw Object.assign(Error("The image has no pixels."), { code: "decode" });
        const [engineLib, { alphaToMask }] = await Promise.all([lib || loadEngine(), maskLib()]);
        // Missing files download through prepare(), so Home, the top bar and
        // Settings show the same progress. Without Cache Storage the worker
        // fetches them for this run only, as before.
        if (await openStore()) await downloadFor(def.id, def, { signal, onProgress: (rec) => onProgress?.(downloadEvent(rec)) });
        const plan = await engineLib.planModel(def.model, { avoidGpu });
        const input = modelInput(source, plan.model.size);
        let res;
        try {
          res = await runner.run({ type: "model", plan, input, target: { width, height } }, { onProgress, signal });
        } catch (err) {
          if (err?.code === "gpu") gpuFailed();
          throw err;
        }
        if (res.gpuFailed) gpuFailed();
        const alpha = res.alpha instanceof Uint8ClampedArray ? res.alpha : new Uint8ClampedArray(res.alpha.buffer || res.alpha);
        return alphaToMask({ width: res.width, height: res.height, data: alpha });
      },
    };
    ML.set(provider, def);
    return provider;
  }

  // The graphics card failed: CPU files for the rest of the session, which can
  // mean another download (Best's fp32 file), so the sizes are looked at again.
  function gpuFailed() {
    if (avoidGpu) return;
    avoidGpu = true;
    refreshStatus().catch(() => {});
  }

  const magicProvider = {
    id: "magic",
    label: "Magic (flat backgrounds)",
    note: "For flat color backgrounds and screenshots. No download.",
    kind: "local",
    sizeMB: 0,
    license: "MIT",
    source: null,
    ready: async () => true,
    async run(source, { onProgress, signal } = {}) {
      const image = readPixels(source);
      const { alphaToMask } = await maskLib();
      const res = await runner.run({ type: "edge-magic", image: { width: image.width, height: image.height, data: image.data }, options: {} }, { onProgress, signal });
      const alpha = res.alpha instanceof Uint8ClampedArray ? res.alpha : new Uint8ClampedArray(res.alpha.buffer || res.alpha);
      return alphaToMask({ width: res.width, height: res.height, data: alpha });
    },
  };

  for (const [id, def] of Object.entries(BG_CONFIG.providers)) providers.register(modelProvider({ id, ...def }));
  providers.register(magicProvider);

  // ---- info and consent --------------------------------------------------------

  function resolveProvider(id) {
    const p = providers.get(id || bg.defaultProvider);
    if (!p) throw Object.assign(Error("That background remover is not available."), { code: "provider" });
    return p;
  }

  // { id, label, note, kind, sizeMB, downloadMB, modelMB, runtimeMB, cached, license, source, page, backend, variant, offline }
  async function modelInfo(providerId) {
    const p = providers.get(providerId || bg.defaultProvider);
    if (!p) return null;
    if (typeof p.info === "function") return p.info();
    const cached = typeof p.ready === "function" ? !!(await p.ready()) : true;
    return {
      id: p.id,
      label: p.label,
      note: p.note || "",
      kind: p.kind || "local",
      sizeMB: p.sizeMB || 0,
      downloadMB: cached ? 0 : p.sizeMB || 0,
      modelMB: p.sizeMB || 0,
      runtimeMB: 0,
      cached,
      license: p.license || "",
      source: p.source || null,
      page: p.page || null,
      backend: p.kind === "ml" ? null : "local",
      variant: null,
      offline: cached,
    };
  }

  // Ask once before the first download. Resolves true when ready to go (and
  // while that download already runs: the user started it).
  async function confirmDownload(providerId) {
    const pid = providerId || bg.defaultProvider;
    if (downloads.has(pid)) return true;
    const info = await modelInfo(pid);
    if (!info || info.cached) return true;
    if (typeof ctx.ui?.confirm !== "function") return true;
    return ctx.ui.confirm({
      title: "Download the background remover?",
      // Same words as the inspector and quick tools.
      message: `Background removal needs a one-time ${info.downloadMB} MB download. It runs on this computer; your image is never uploaded.`,
      ok: "Download",
      cancel: "Not now",
    });
  }

  // ---- fitting the box to the cutout (trim.js) ---------------------------------

  const FULL = { x: 0, y: 0, w: 1, h: 1 };

  function trimRecord(layer) {
    const rec = trims.get(layer?.id);
    return rec && rec.asset === layer.asset && rec.trims.some((c) => sameCrop(c, layer.crop)) ? rec : null;
  }

  function maskBounds(maskSource) {
    try {
      const px = readPixels(maskSource);
      return { bounds: opaqueBounds(px.data, px.width, px.height, { stride: 4 }), width: px.width, height: px.height };
    } catch {
      return null;
    }
  }

  // The crop the layer had before its box was fitted to the cutout, or null.
  // Without a record from this session (after a reload), a crop that is
  // exactly what the trim makes of the whole photo is recognized too.
  function originalCrop(layer) {
    const rec = trimRecord(layer);
    if (rec) return rec.crop;
    if (!layer?.mask || !canTrim(layer)) return null;
    const bmp = ctx.assets?.getImage?.(layer.mask);
    const m = bmp ? maskBounds(bmp) : null;
    const auto = m ? cutoutCrop(m.bounds, m.width, m.height, FULL) : null;
    return auto && !sameCrop(auto, FULL) && sameCrop(auto, layer.crop, 1e-4) ? FULL : null;
  }

  // Props { crop, x, y, w, h } that fit layerId's box to the opaque part of
  // maskSource (a mask canvas or bitmap; default: the layer's mask, when it is
  // decoded), keeping every visible pixel in place. Within the crop the layer
  // had before an earlier trim, else within its current crop (never past a
  // crop the user chose). Null when nothing would change. Put the props in the
  // same patch that sets the mask.
  function cutoutProps(layerId, maskSource = null) {
    const layer = ctx.store.get(layerId);
    if (!canTrim(layer)) return null;
    const source = maskSource || (layer.mask ? ctx.assets?.getImage?.(layer.mask) : null);
    if (!source) return null;
    const m = maskBounds(source);
    const rec = trimRecord(layer);
    const container = originalCrop(layer) || layer.crop || FULL;
    const props = m ? fitProps(layer, cutoutCrop(m.bounds, m.width, m.height, container)) : null;
    if (!props) return null;
    const entry = rec || { asset: layer.asset, crop: { ...container }, trims: [] };
    entry.trims = [props.crop, ...entry.trims.filter((c) => !sameCrop(c, props.crop))].slice(0, 8);
    trims.delete(layerId);
    trims.set(layerId, entry);
    if (trims.size > 200) trims.delete(trims.keys().next().value);
    return props;
  }

  // Props that put back the box from before the trim, or null.
  function untrimProps(layerId) {
    const layer = ctx.store.get(layerId);
    if (!layer || layer.type !== "image") return null;
    const container = originalCrop(layer);
    return container ? fitProps(layer, unionCrop(container, layer.crop)) : null;
  }

  // "Fit box to cutout" for masks made before trimming existed, or after the
  // refine brush brought parts back. One undo step; resolves true if it moved.
  async function fitToCutout(layerId) {
    const layer = ctx.store.get(layerId);
    if (!canTrim(layer) || !layer.mask) return false;
    const mask = await ctx.assets.loadImage(layer.mask);
    await gestureDone();
    const now = ctx.store.get(layerId);
    if (!now || now.mask !== layer.mask) return false;
    const props = cutoutProps(layerId, mask);
    if (!props) return false;
    ctx.store.patch(layerId, props, { label: "Fit box to cutout" });
    ctx.editor?.flash?.([layerId]);
    return true;
  }

  // ---- running -------------------------------------------------------------------

  async function removeLayerBackground(layerId, { provider, signal } = {}) {
    const busy = running.get(layerId);
    if (busy) return busy.promise;
    const layer = ctx.store.get(layerId);
    if (!layer || layer.type !== "image") throw Object.assign(Error("Select an image first."), { code: "layer" });
    const p = resolveProvider(provider);
    const controller = new AbortController();
    linkSignal(controller, signal);
    const emit = (phase, progress, message, extra = {}) =>
      ctx.emit("bg-progress", { layerId, provider: p.id, phase, progress, message, ...extra });

    const promise = (async () => {
      ctx.editor?.setScanning?.(layerId, true);
      emit("run", 0, "Getting ready");
      try {
        // mask.js loads with the image, so every provider (mods too) can use ctx.bg.masks.
        const [bitmap] = await Promise.all([ctx.assets.loadImage(layer.asset), maskLib()]);
        if (controller.signal.aborted) throw abortError();
        const mask = await p.run(bitmap, {
          signal: controller.signal,
          onProgress: (e) => emit(e.phase, e.progress, e.message),
        });
        if (controller.signal.aborted) throw abortError();
        const maskId = await ctx.assets.addCanvas(mask, { type: "image/png" });
        await gestureDone();
        if (controller.signal.aborted) throw abortError();
        const now = ctx.store.get(layerId);
        if (!now || now.asset !== layer.asset) throw Object.assign(Error("The image changed before its background was removed."), { code: "layer" });
        // The box shrinks to the cutout in the same step, so the selection,
        // snapping and the Center pill follow the subject, not the old frame.
        const box = cutoutProps(layerId, mask);
        ctx.store.patch(layerId, { mask: maskId, ...box }, { label: "Remove background" });
        ctx.editor?.flash?.([layerId]);
        emit("done", 1, "Background removed");
        return { layerId, maskId, provider: p.id };
      } catch (err) {
        const e = await toError(err);
        emit("error", 0, e.message, { code: e.code, cancelled: e.code === "cancelled" });
        throw e;
      } finally {
        ctx.editor?.setScanning?.(layerId, false);
        running.delete(layerId);
      }
    })();
    running.set(layerId, { promise, controller });
    return promise;
  }

  // For quick tools: Blob/File/ImageBitmap/canvas in, { mask, cutout } canvases out.
  // A Blob/File input is scaled to maxSide (long side) first; pass 0 to keep it.
  async function removeFromImage(input, { provider, onProgress, signal, maxSide = 4096 } = {}) {
    const p = resolveProvider(provider);
    const report = (e) => {
      onProgress?.(e);
      ctx.emit("bg-progress", { layerId: null, provider: p.id, ...e });
    };
    try {
      const [decoded, { maskToCutout }] = await Promise.all([toBitmap(input), maskLib()]);
      const bitmap = typeof Blob !== "undefined" && input instanceof Blob ? capSide(decoded, maxSide) : decoded;
      const { width, height } = sourceSize(bitmap);
      report({ phase: "run", progress: 0, message: "Getting ready" });
      const mask = await p.run(bitmap, { onProgress: report, signal });
      const cutout = maskToCutout(bitmap, mask);
      report({ phase: "done", progress: 1, message: "Background removed" });
      return { mask, cutout, width, height, provider: p.id };
    } catch (err) {
      const e = await toError(err);
      report({ phase: "error", progress: 0, message: e.message, code: e.code, cancelled: e.code === "cancelled" });
      throw e;
    }
  }

  function restoreLayer(layerId) {
    running.get(layerId)?.controller.abort();
    const layer = ctx.store.get(layerId);
    if (!layer || layer.type !== "image" || !layer.mask) return false;
    ctx.store.patch(layerId, { mask: null, ...untrimProps(layerId) }, { label: "Restore original" });
    return true;
  }

  const bg = {
    providers,
    get defaultProvider() {
      const saved = ctx.prefs?.get?.("bgProvider");
      if (saved && providers.has(saved)) return saved;
      return providers.has(BG_CONFIG.defaultProvider) ? BG_CONFIG.defaultProvider : providers.list()[0]?.id || null;
    },
    setDefaultProvider(id) {
      if (!providers.has(id)) return false;
      ctx.prefs?.set?.("bgProvider", id);
      return true;
    },
    removeLayerBackground,
    removeFromImage,
    restoreLayer,
    fitToCutout,
    cutoutProps,
    untrimProps,
    modelInfo,
    // True once engine.js has loaded (a removal, a model lookup, Settings):
    // modelInfo() for a model then costs no download, and no GPU request.
    get engineLoaded() {
      return !!(engineModule || lib);
    },
    confirmDownload,
    // Download status, the same in every view (see nextStatus above):
    //   status(id?) -> snapshot; refreshStatus(id?) -> look again (all when no id)
    //   prepare(id?, { signal, onProgress }) -> download without a layer
    //   cancelDownload(id?), remove(id?) -> delete a downloaded model
    //   downloading() -> statuses of the downloads running now
    //   storage() -> { bytes, files, bundledBytes, bundledBy }
    // ctx.on("bg-model", (status) => ...) hears every change.
    status,
    refreshStatus,
    prepare,
    cancelDownload,
    remove,
    storage,
    downloading: () => [...statuses.values()].filter((s) => s.state === "downloading" && providers.has(s.id)).map((s) => ({ ...s })),
    describe: describeStatus,
    format: Object.freeze({ mb: formatMB, speed: formatSpeed, eta: formatEta, progress: progressText }),
    cancel(layerId) {
      running.get(layerId)?.controller.abort();
    },
    isRunning: (layerId) => running.has(layerId),
    modelProvider,
    capabilities: async () => (lib || (await loadEngine())).detectCaps(),
    // Frees the loaded model's memory (it is also freed after a few idle minutes).
    release: () => runner.release(),
    // Downloaded models and runtime in Cache Storage: { bytes, files }, and removing them.
    cacheUsage: async () => (lib || (await loadEngine())).cacheUsage(BG_CONFIG.cacheName),
    async clearCache() {
      for (const id of [...downloads.keys()]) cancelDownload(id);
      const ok = await (lib || (await loadEngine())).clearCache(BG_CONFIG.cacheName);
      await refreshStatus();
      return ok;
    },
    config: BG_CONFIG,
    // mask.js helpers (magicMask, paintMask, featherMask, growMask, maskToCutout, …),
    // null until mask.js has loaded: the first removal or cutout edit loads it,
    // and so does loadMasks(), which resolves to the same module.
    get masks() {
      return maskModule;
    },
    loadMasks: maskLib,
  };
  return bg;
}
