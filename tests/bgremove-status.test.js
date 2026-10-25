// Download status in web/js/features/bgremove/index.js: the words and sizes
// every view shows, the state machine, the light check that needs no engine,
// and prepare / cancel / remove with a stand-in engine and Cache Storage.
// Run: deno test --allow-read tests/bgremove-status.test.js
import assert from "node:assert/strict";
import {
  BG_CONFIG,
  createBgService,
  createRate,
  describeStatus,
  formatEta,
  formatMB,
  formatSpeed,
  lightPlan,
  MODEL_STATES,
  nextStatus,
  progressText,
  remoteUrls,
  toMB,
} from "../web/js/features/bgremove/index.js";
import { detectCaps, friendlyError, planModel } from "../web/js/features/bgremove/engine.js";

const fast = BG_CONFIG.models[BG_CONFIG.providers.fast.model];
const best = BG_CONFIG.models[BG_CONFIG.providers.best.model];
const buildBytes = (b) => ["script", "glue", "wasm"].reduce((s, k) => s + BG_CONFIG.ort.builds[b][k].bytes, 0);
const FAST_GPU = fast.variants.int8.bytes + buildBytes("webgpu");
const FAST_CPU = fast.variants.int8.bytes + buildBytes("wasm");

// ---- words and sizes ---------------------------------------------------------------

Deno.test("sizes are decimal megabytes, the same everywhere", () => {
  assert.equal(toMB(0), 0);
  assert.equal(toMB(-5), 0);
  assert.equal(toMB(1), 1, "anything is at least 1 MB");
  assert.equal(toMB(44_229_662), 44);
  assert.equal(formatMB(FAST_GPU), "69 MB", "Fast plus the WebGPU runtime");
  assert.equal(formatMB(FAST_CPU), "58 MB", "Fast plus the CPU runtime");
  assert.equal(formatMB(0), "0 MB");
});

Deno.test("speed and time left read plainly", () => {
  assert.equal(formatSpeed(null), "");
  assert.equal(formatSpeed(0), "");
  assert.equal(formatSpeed(640_000), "640 KB/s");
  assert.equal(formatSpeed(400), "1 KB/s");
  assert.equal(formatSpeed(3_240_000), "3.2 MB/s");
  assert.equal(formatSpeed(9_960_000), "10 MB/s", "no 10.0");
  assert.equal(formatSpeed(18_400_000), "18 MB/s");
  assert.equal(formatEta(null), "");
  assert.equal(formatEta(undefined), "");
  assert.equal(formatEta(-1), "");
  assert.equal(formatEta(3), "A few seconds left");
  assert.equal(formatEta(12), "About 15 s left");
  assert.equal(formatEta(54), "About 55 s left");
  assert.equal(formatEta(56), "About 1 min left");
  assert.equal(formatEta(200), "About 3 min left");
  assert.equal(formatEta(7200), "About 2 h left");
});

Deno.test("progress line: done part rounds down, total from the same MB", () => {
  assert.equal(progressText({ bytes: 12_600_000, total: FAST_GPU, speed: 3_200_000, eta: 18 }), "12 of 69 MB · 3.2 MB/s · About 20 s left");
  assert.equal(progressText({ bytes: FAST_GPU - 1, total: FAST_GPU }), "68 of 69 MB", "never 69 of 69 before the end");
  assert.equal(progressText({ bytes: 0, total: 0 }), "");
  assert.equal(progressText({ bytes: 5e6, total: 10e6, speed: null, eta: null }), "5 of 10 MB");
});

Deno.test("speed is measured over the last seconds", () => {
  let t = 0;
  const rate = createRate({ now: () => t, window: 5000 });
  rate.push(0);
  assert.equal(rate.speed(), null, "nothing to go on");
  t = 500;
  rate.push(1e6);
  assert.equal(rate.speed(), null, "half a second is too little");
  t = 2000;
  rate.push(4e6);
  assert.equal(rate.speed(), 2e6);
  assert.equal(rate.eta(10e6), 3);
  t = 9000;
  rate.push(11e6);
  assert.equal(Math.round(rate.speed()), 1e6, "old samples drop out");
  rate.reset();
  assert.equal(rate.speed(), null);
});

// ---- the state machine ---------------------------------------------------------------

const fresh = (extra = {}) => ({ id: "fast", label: "Fast", kind: "ml", state: "checking", ready: false, bundled: false, sizeBytes: FAST_GPU, downloadBytes: FAST_GPU, bytes: 0, total: 0, speed: null, eta: null, error: null, origin: null, ...extra });

Deno.test("status: checked, download, done", () => {
  assert.deepEqual(MODEL_STATES, ["checking", "ready-bundled", "ready-cached", "downloading", "not-downloaded", "error"]);
  let s = nextStatus(fresh(), { type: "checked", ready: false, sizeBytes: FAST_GPU, downloadBytes: FAST_GPU });
  assert.equal(s.state, "not-downloaded");
  assert.equal(s.ready, false);
  s = nextStatus(s, { type: "start", total: FAST_GPU, origin: "prepare" });
  assert.equal(s.state, "downloading");
  assert.equal(s.total, FAST_GPU);
  assert.equal(s.origin, "prepare");
  s = nextStatus(s, { type: "progress", bytes: 2e7, speed: 4e6, eta: 12 });
  assert.deepEqual([s.bytes, s.speed, s.eta], [2e7, 4e6, 12]);
  s = nextStatus(s, { type: "progress", bytes: FAST_GPU * 3 });
  assert.equal(s.bytes, FAST_GPU, "never past the total");
  const look = nextStatus(s, { type: "checked", ready: true, bundled: false, sizeBytes: FAST_GPU });
  assert.equal(look.state, "downloading", "a look does not end a running download");
  s = nextStatus(s, { type: "done", bundled: false });
  assert.equal(s.state, "ready-cached");
  assert.equal(s.ready, true);
  assert.equal(s.downloadBytes, 0);
  assert.equal(s.speed, null);
  assert.equal(nextStatus(s, { type: "progress", bytes: 1 }), s, "progress after the end is ignored");
});

Deno.test("status: bundled, cancel, failure and retry, removal", () => {
  const bundled = nextStatus(fresh(), { type: "checked", ready: true, bundled: true, sizeBytes: FAST_GPU });
  assert.equal(bundled.state, "ready-bundled");
  assert.equal(bundled.bundled, true);

  let s = nextStatus(fresh({ state: "not-downloaded" }), { type: "start", total: FAST_GPU });
  s = nextStatus(s, { type: "cancel", downloadBytes: fast.variants.int8.bytes });
  assert.equal(s.state, "not-downloaded");
  assert.equal(s.downloadBytes, fast.variants.int8.bytes, "the runtime that finished stays");

  s = nextStatus(nextStatus(s, { type: "start", total: s.downloadBytes }), { type: "fail", message: "Could not download the model.", code: "network" });
  assert.equal(s.state, "error");
  assert.deepEqual(s.error, { message: "Could not download the model.", code: "network" });
  const looked = nextStatus(s, { type: "checked", ready: false, sizeBytes: FAST_GPU, downloadBytes: 1e6 });
  assert.equal(looked.state, "error", "stays failed, with its Try again");
  assert.equal(looked.downloadBytes, 1e6);
  const healed = nextStatus(s, { type: "checked", ready: true, sizeBytes: FAST_GPU });
  assert.equal(healed.state, "ready-cached", "a removal that downloaded it heals the error");
  assert.equal(healed.error, null);
  s = nextStatus(s, { type: "start", total: 1e6 });
  assert.equal(s.state, "downloading");
  assert.equal(s.error, null, "trying again clears the error");

  const gone = nextStatus(healed, { type: "removed", downloadBytes: FAST_GPU });
  assert.equal(gone.state, "not-downloaded");
  assert.equal(gone.downloadBytes, FAST_GPU);
  assert.equal(nextStatus(bundled, { type: "removed", bundled: true }).state, "ready-bundled", "files that ship with the app stay");
  assert.equal(nextStatus(s, { type: "nonsense" }), s);
});

Deno.test("describeStatus: the copy for each state", () => {
  const nd = nextStatus(fresh(), { type: "checked", ready: false, sizeBytes: FAST_GPU, downloadBytes: FAST_GPU });
  assert.equal(describeStatus(nd).short, "One-time 69 MB download");
  assert.match(describeStatus(nd).detail, /^One-time 69 MB download\. Runs on this computer and works offline after\.$/);
  // Best after Fast: the runtime is shared, so only the model is left.
  const bestLeft = nextStatus(fresh({ id: "best", sizeBytes: 223e6 }), { type: "checked", ready: false, sizeBytes: 223e6, downloadBytes: best.variants.fp32.bytes });
  assert.equal(describeStatus(bestLeft).short, "One-time 200 MB download");
  let dl = nextStatus(nd, { type: "start", total: FAST_GPU });
  assert.equal(describeStatus(dl).short, "Downloading · 0%");
  assert.equal(describeStatus(dl).detail, "0 of 69 MB");
  dl = nextStatus(dl, { type: "progress", bytes: FAST_GPU / 2, speed: 5e6, eta: 7 });
  assert.equal(describeStatus(dl).short, "Downloading · 50%");
  assert.equal(describeStatus(dl).detail, "34 of 69 MB · 5.0 MB/s · A few seconds left");
  dl = nextStatus(dl, { type: "progress", bytes: FAST_GPU - 1 });
  assert.equal(describeStatus(dl).percent, 99, "100% only once it is ready");
  const ready = nextStatus(dl, { type: "done" });
  assert.equal(describeStatus(ready).short, "Runs on this computer");
  assert.equal(describeStatus(ready).label, "Downloaded");
  const inApp = nextStatus(nd, { type: "checked", ready: true, bundled: true });
  assert.equal(describeStatus(inApp).label, "Included with the app");
  assert.equal(describeStatus(inApp).short, "Runs on this computer", "the bundled state stays quiet");
  const failed = nextStatus(dl, { type: "fail", message: "Could not download the model. Check your connection and try again." });
  assert.equal(describeStatus(failed).short, "Download stopped");
  assert.match(describeStatus(failed).detail, /connection/);
  assert.equal(describeStatus({ id: "magic", kind: "local", state: "ready-bundled", ready: true }).short, "No download");
  assert.equal(describeStatus(fresh()).short, "", "nothing while checking");
  assert.equal(describeStatus(null).short, "");
});

// ---- the light check -------------------------------------------------------------------

Deno.test("lightPlan: nothing here, part cached, vendored", () => {
  const none = lightPlan("isnet-general", { gpu: true });
  assert.equal(none.ready, false);
  assert.equal(none.sizeBytes, FAST_GPU);
  assert.equal(none.downloadBytes, FAST_GPU);
  assert.equal(lightPlan("isnet-general", { gpu: false }).sizeBytes, FAST_CPU);

  // The runtime came with Best: only the Fast model is left.
  const rt = new Set(["script", "glue", "wasm"].map((k) => new URL(BG_CONFIG.ort.builds.webgpu[k].file, BG_CONFIG.ort.base).href));
  const part = lightPlan("isnet-general", { gpu: true, has: (u) => rt.has(u) });
  assert.equal(part.ready, false);
  assert.equal(part.downloadBytes, fast.variants.int8.bytes);

  const all = new Set([...rt, fast.variants.int8.url]);
  const cached = lightPlan("isnet-general", { gpu: true, has: (u) => all.has(u) });
  assert.equal(cached.ready, true);
  assert.equal(cached.bundled, false);
  assert.equal(cached.downloadBytes, 0);

  // A CPU runtime counts on a GPU machine too (the engine can run it).
  const cpuRt = new Set([...["script", "glue", "wasm"].map((k) => new URL(BG_CONFIG.ort.builds.wasm[k].file, BG_CONFIG.ort.base).href), fast.variants.int8.url]);
  assert.equal(lightPlan("isnet-general", { gpu: true, has: (u) => cpuRt.has(u) }).ready, true);
  // ... but a WebGPU runtime is no use without WebGPU.
  const gpuOnly = new Set([...rt, fast.variants.int8.url]);
  assert.equal(lightPlan("isnet-general", { gpu: false, has: (u) => gpuOnly.has(u) }).ready, false);

  const manifest = {
    v: 1,
    ort: { version: BG_CONFIG.ort.version, files: Object.values(BG_CONFIG.ort.builds).flatMap((b) => [b.script.file, b.glue.file, b.wasm.file]) },
    models: { [fast.variants.int8.file]: { model: "isnet-general", variant: "int8", bytes: fast.variants.int8.bytes } },
  };
  const vend = lightPlan("isnet-general", { gpu: true, manifest });
  assert.equal(vend.ready, true);
  assert.equal(vend.bundled, true);
  assert.ok(vend.file.url.endsWith("/web/vendor/models/" + fast.variants.int8.file), vend.file.url);
  assert.equal(lightPlan("birefnet-lite", { gpu: true, manifest }).ready, false, "Best is not in this installer");

  // A GPU with shader-f16 may have fetched Best's fp16 file: that counts.
  const f16 = new Set([...rt, best.variants.fp16.url]);
  assert.equal(lightPlan("birefnet-lite", { gpu: true, has: (u) => f16.has(u) }).ready, true);
  assert.equal(lightPlan("birefnet-lite", { gpu: false, has: (u) => f16.has(u) }).ready, false, "the fp16 file needs the GPU");
  assert.equal(lightPlan("nope"), null);
});

Deno.test("lightPlan names the files engine.js plans", async () => {
  const caps = await detectCaps();
  const gpu = caps.backend === "webgpu";
  for (const [modelId, opts] of [["isnet-general", {}], ["birefnet-lite", { avoidGpu: true }]]) {
    const plan = await planModel(modelId, opts);
    const light = lightPlan(modelId, { gpu: gpu && !opts.avoidGpu });
    assert.equal(light.file.url, plan.file.url, `${modelId}: model file`);
    assert.deepEqual(light.runtime.parts.map((e) => e.url), [plan.runtime.script.url, plan.runtime.glue.url, plan.runtime.wasm.url], `${modelId}: runtime`);
    assert.equal(light.sizeBytes, plan.file.bytes + plan.runtime.script.bytes + plan.runtime.glue.bytes + plan.runtime.wasm.bytes, `${modelId}: size`);
  }
  const urls = remoteUrls("isnet-general");
  assert.ok(urls.includes(fast.variants.int8.url) && urls.length === 1 + 6, "model plus both runtime builds");
});

// ---- the service with a stand-in engine and Cache Storage ---------------------------------

function fakeCaches() {
  const stores = new Map();
  const key = (r) => (typeof r === "string" ? r : r.url);
  return {
    stores,
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name);
      return {
        async match(r) {
          const v = m.get(key(r));
          return v ? new Response(v.body, { headers: v.headers }) : undefined;
        },
        async put(r, res) {
          m.set(key(r), { body: new Uint8Array(await res.arrayBuffer()), headers: Object.fromEntries(res.headers) });
        },
        async delete(r) {
          return m.delete(key(r));
        },
        async keys() {
          return [...m.keys()].map((url) => ({ url }));
        },
      };
    },
    async delete(name) {
      return stores.delete(name);
    },
  };
}

const pause = () => new Promise((r) => setTimeout(r, 2));
const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw Error("timed out");
    await pause();
  }
};

// Plans like engine.js on a machine without WebGPU (opts.manifest: what
// web/vendor/ holds); downloads in four chunks.
function fakeEngine(caches, opts = {}) {
  const log = { plans: 0, fetched: [], loads: 0 };
  const mod = {
    async planModel(modelId) {
      log.plans++;
      const lp = lightPlan(modelId, { gpu: false, manifest: opts.manifest || null });
      const [script, glue, wasm] = lp.runtime.parts;
      return { modelId, variantId: "x", backend: "wasm", file: { ...lp.file, page: null }, runtime: { build: "wasm", local: lp.runtime.parts[0].local, script, glue, wasm }, cacheName: BG_CONFIG.cacheName, model: { size: 8 } };
    },
    async isCached(entry, cacheName) {
      if (entry.local) return true;
      const c = await caches.open(cacheName);
      return !!(await c.match(entry.url));
    },
    async getBytes(entry, { cacheName, onBytes, signal } = {}) {
      log.fetched.push(entry.file);
      for (let i = 1; i <= 4; i++) {
        await (opts.gate ? opts.gate(entry) : pause());
        if (signal?.aborted) throw Object.assign(Error("Canceled"), { name: "AbortError", code: "cancelled" });
        if (opts.failOn?.(entry, i)) throw Object.assign(Error("Could not download the model. Check your connection and try again."), { code: "network" });
        onBytes?.(Math.round((entry.bytes * i) / 4));
      }
      const c = await caches.open(cacheName);
      await c.put(entry.url, new Response(new Uint8Array(4), { headers: { "X-Longitude-Bytes": String(entry.bytes) } }));
      return new Uint8Array(4);
    },
    friendlyError,
  };
  const load = () => {
    log.loads++;
    return Promise.resolve(mod);
  };
  load.log = log;
  return load;
}

function fakeCtx() {
  const events = [];
  const prefs = new Map();
  return {
    events,
    models: () => events.filter(([t]) => t === "bg-model").map(([, d]) => d),
    emit: (type, detail) => events.push([type, detail]),
    on: () => () => {},
    prefs: { get: (k, d) => (prefs.has(k) ? prefs.get(k) : d), set: (k, v) => prefs.set(k, v) },
    store: { get: () => null },
    assets: {},
    ui: {},
  };
}

const noVendor = async () => new Response("", { status: 404 });

function service({ caches = fakeCaches(), fetch = noVendor, engineOpts } = {}) {
  const ctx = fakeCtx();
  const engine = fakeEngine(caches, engineOpts);
  const bg = createBgService(ctx, { engine, caches, fetch, gpu: false });
  return { ctx, bg, caches, engine, log: () => engine.log };
}

Deno.test("service: the first look needs no engine", async () => {
  const { bg, ctx, engine } = service();
  const loads = () => engine.log.loads;
  const first = bg.status("fast");
  assert.equal(first.state, "checking");
  assert.equal(first.sizeBytes, FAST_CPU, "an estimate from BG_CONFIG right away");
  const s = await bg.refreshStatus("fast");
  assert.equal(s.state, "not-downloaded");
  assert.equal(s.downloadBytes, FAST_CPU);
  assert.equal(bg.describe(s).short, "One-time 58 MB download");
  assert.equal(loads(), 0, "the engine did not load");
  assert.equal(bg.engineLoaded, false);
  assert.equal(bg.status("magic").state, "ready-bundled");
  assert.equal(bg.describe(bg.status("magic")).short, "No download");
  assert.ok(ctx.models().some((m) => m.id === "fast" && m.state === "not-downloaded"), "a bg-model event went out");
});

Deno.test("service: prepare downloads without a layer, and shares the runtime", async () => {
  const { bg, ctx, caches } = service();
  await bg.refreshStatus();
  const done = await bg.prepare("fast");
  assert.equal(done.state, "ready-cached");
  assert.equal(bg.status("fast").ready, true);
  assert.equal(bg.engineLoaded, true);
  const states = ctx.models().filter((m) => m.id === "fast").map((m) => m.state);
  assert.deepEqual([...new Set(states)], ["not-downloaded", "downloading", "ready-cached"]);
  const progress = ctx.models().filter((m) => m.state === "downloading");
  // Progress is throttled by time, so a fast machine can finish inside one window: at least one, never one per chunk.
  assert.ok(progress.length >= 1 && progress.length < 20, `progress is sent, but not for every chunk (${progress.length})`);
  // The first one goes out at once, before the engine has planned (total not known yet).
  assert.equal(progress[0].total, 0);
  assert.ok(progress.slice(1).every((m) => m.total === FAST_CPU));
  assert.equal(caches.stores.get(BG_CONFIG.cacheName).size, 4, "runtime (3 files) and model in Cache Storage");
  await until(() => bg.status("best").downloadBytes === best.variants.fp32.bytes);
  assert.equal(bg.status("best").state, "not-downloaded", "Best only needs its model now");
  const again = await bg.prepare("fast");
  assert.equal(again.state, "ready-cached", "a second prepare is a no-op");
  const usage = await bg.storage();
  assert.equal(usage.files, 4);
  assert.equal(usage.bytes, FAST_CPU);
  assert.equal(usage.bundledBytes, 0);
});

Deno.test("service: cancel keeps finished files, and the next try goes on from there", async () => {
  let hold = null;
  const gate = (entry) => (entry.file === fast.variants.int8.file && hold ? hold : pause());
  const { bg, log } = service({ engineOpts: { gate } });
  await bg.refreshStatus();
  let release;
  hold = new Promise((r) => (release = r));
  const p = bg.prepare("fast");
  await until(() => log().fetched.includes(fast.variants.int8.file));
  assert.equal(bg.status("fast").state, "downloading");
  assert.equal(bg.downloading().length, 1);
  assert.equal(bg.cancelDownload("fast"), true);
  release();
  await assert.rejects(p, (err) => err.code === "cancelled" && err.message === "Canceled");
  await until(() => bg.status("fast").state === "not-downloaded" && bg.status("fast").downloadBytes === fast.variants.int8.bytes);
  assert.equal(bg.downloading().length, 0);
  hold = null;
  const before = log().fetched.length;
  await bg.prepare("fast");
  assert.deepEqual(log().fetched.slice(before), [fast.variants.int8.file], "only the model again");
  assert.equal(bg.cancelDownload("fast"), false, "nothing left to cancel");
});

Deno.test("service: a failed download says so, and Try again works", async () => {
  let fail = true;
  const { bg, ctx } = service({ engineOpts: { failOn: (entry, i) => fail && entry.file === fast.variants.int8.file && i === 2 } });
  await assert.rejects(bg.prepare("fast"), (err) => err.code === "network" && /connection/.test(err.message));
  const s = bg.status("fast");
  assert.equal(s.state, "error");
  assert.match(s.error.message, /connection/);
  assert.equal(s.origin, "prepare");
  await bg.refreshStatus("fast");
  assert.equal(bg.status("fast").state, "error", "a look keeps the error and its Try again");
  fail = false;
  assert.equal((await bg.prepare("fast")).state, "ready-cached");
  assert.equal(ctx.models().at(-1).error, null);
});

Deno.test("service: a removal's download stops with it, unless someone asked for it", async () => {
  const { bg } = service();
  await bg.refreshStatus();
  // A waiter with a signal (what a removal does) leaves; nobody else waits: it stops.
  const a = new AbortController();
  const p1 = bg.prepare("fast", { signal: a.signal });
  await until(() => bg.status("fast").state === "downloading");
  assert.equal(bg.status("fast").origin, "run");
  a.abort();
  await assert.rejects(p1, (err) => err.code === "cancelled");
  await until(() => bg.status("fast").state === "not-downloaded");

  // Started on purpose (Home, Settings): a removal that joins and is canceled leaves it running.
  const kept = bg.prepare("fast");
  await until(() => bg.status("fast").state === "downloading");
  const b = new AbortController();
  const progress = [];
  const p2 = bg.prepare("fast", { signal: b.signal, onProgress: (rec) => progress.push(rec.bytes) });
  await until(() => progress.length > 0);
  b.abort();
  await assert.rejects(p2, (err) => err.code === "cancelled");
  assert.equal((await kept).state, "ready-cached", "the download carried on");
});

Deno.test("service: remove deletes a model, then the runtime once none is left", async () => {
  const { bg, caches } = service();
  await bg.prepare("fast");
  await bg.prepare("best");
  const store = () => caches.stores.get(BG_CONFIG.cacheName);
  assert.equal(store().size, 5);
  let s = await bg.remove("fast");
  assert.equal(s.state, "not-downloaded");
  assert.equal(s.downloadBytes, fast.variants.int8.bytes, "the runtime stays for Best");
  assert.equal(store().size, 4);
  assert.equal(bg.status("best").state, "ready-cached");
  s = await bg.remove("best");
  assert.equal(s.state, "not-downloaded");
  assert.equal(store().size, 0, "runtime gone with the last model");
  assert.equal(bg.status("fast").downloadBytes, FAST_CPU);
  assert.equal((await bg.storage()).bytes, 0);
  assert.equal((await bg.remove("magic")).state, "ready-bundled", "nothing to delete for Magic");
});

Deno.test("service: files in web/vendor/ are ready-bundled and need no download", async () => {
  // What src-tauri/stage_vendor.py writes for the desktop installer.
  const manifest = {
    v: 1,
    bundled: "desktop",
    ort: { version: BG_CONFIG.ort.version, files: Object.values(BG_CONFIG.ort.builds).flatMap((b) => [b.script.file, b.glue.file, b.wasm.file]) },
    models: { [fast.variants.int8.file]: { model: "isnet-general", variant: "int8", bytes: fast.variants.int8.bytes } },
  };
  const fetch = async (url) => (String(url).endsWith("/vendor/manifest.json") ? new Response(JSON.stringify(manifest), { status: 200 }) : new Response("", { status: 404 }));
  const { bg, log, engine } = service({ fetch, engineOpts: { manifest } });
  const s = await bg.refreshStatus("fast");
  assert.equal(s.state, "ready-bundled");
  assert.equal(s.bundledBy, "app");
  assert.equal(bg.describe(s).label, "Included with the app");
  assert.equal((await bg.refreshStatus("best")).state, "not-downloaded");
  assert.equal(engine.log.loads, 0, "still no engine");
  assert.equal((await bg.prepare("fast")).state, "ready-bundled");
  assert.deepEqual(log().fetched, [], "nothing fetched");
  const usage = await bg.storage();
  assert.equal(usage.bundledBytes, fast.variants.int8.bytes + buildBytes("webgpu") + buildBytes("wasm"));
  assert.equal(usage.bytes, 0);
});

Deno.test("service: a web/vendor/ folder from fetch_model.py is not called part of the app", async () => {
  // fetch_model.py writes no "bundled" key.
  const manifest = {
    v: 1,
    ort: { version: BG_CONFIG.ort.version, files: Object.values(BG_CONFIG.ort.builds).flatMap((b) => [b.script.file, b.glue.file, b.wasm.file]) },
    models: { [fast.variants.int8.file]: { model: "isnet-general", variant: "int8", bytes: fast.variants.int8.bytes } },
  };
  const fetch = async (url) => (String(url).endsWith("/vendor/manifest.json") ? new Response(JSON.stringify(manifest), { status: 200 }) : new Response("", { status: 404 }));
  const { bg } = service({ fetch, engineOpts: { manifest } });
  const s = await bg.refreshStatus("fast");
  assert.equal(s.state, "ready-bundled");
  assert.equal(s.bundledBy, "vendor");
  assert.equal(bg.describe(s).label, "Downloaded for offline use");
  assert.doesNotMatch(bg.describe(s).detail, /Included with the app/);
  // The engine's plan says the same.
  assert.equal((await bg.prepare("fast")).bundledBy, "vendor");
});

Deno.test("service: Download shows at once, before the engine has planned", async () => {
  let releasePlan;
  const held = new Promise((r) => (releasePlan = r));
  const caches = fakeCaches();
  const inner = fakeEngine(caches);
  // An engine whose plan waits (loading it and asking for the graphics card can take seconds).
  const engine = async () => {
    const mod = await inner();
    return { ...mod, planModel: async (...a) => (await held, mod.planModel(...a)) };
  };
  const ctx = fakeCtx();
  const bg = createBgService(ctx, { engine, caches, fetch: noVendor, gpu: false });
  await bg.refreshStatus();
  assert.equal(bg.status("fast").state, "not-downloaded");
  const p = bg.prepare("fast");
  assert.equal(bg.status("fast").state, "downloading", "right away");
  assert.equal(bg.downloading().length, 1);
  assert.equal(bg.describe(bg.status("fast")).detail, "Starting the download");
  // Canceled before the plan answers: back to not downloaded, not stuck.
  assert.equal(bg.cancelDownload("fast"), true);
  releasePlan();
  await assert.rejects(p, (err) => err.code === "cancelled");
  await until(() => bg.status("fast").state === "not-downloaded");
  assert.equal(bg.downloading().length, 0);
  assert.equal((await bg.prepare("fast")).state, "ready-cached", "and it still downloads after");
});

Deno.test("service: a model already here when the plan answers ends ready, not downloading", async () => {
  const caches = fakeCaches();
  const { bg } = service({ caches });
  await bg.refreshStatus();
  // Another tab downloaded it meanwhile: the status still says not downloaded.
  const plan = lightPlan("isnet-general", { gpu: false });
  const c = await caches.open(BG_CONFIG.cacheName);
  for (const e of [...plan.runtime.parts, plan.file]) await c.put(e.url, new Response(new Uint8Array(4), { headers: { "X-Longitude-Bytes": String(e.bytes) } }));
  assert.equal(bg.status("fast").state, "not-downloaded");
  const s = await bg.prepare("fast");
  assert.equal(s.state, "ready-cached");
  assert.equal(bg.status("fast").state, "ready-cached");
  assert.equal(bg.downloading().length, 0);
});

Deno.test("service: a removal with the model here shows no download", async () => {
  const { bg, ctx } = service();
  await bg.prepare("fast");
  const before = ctx.models().length;
  // What a removal does (with a signal) on a model that is here.
  await bg.prepare("fast", { signal: new AbortController().signal });
  assert.ok(ctx.models().slice(before).every((m) => m.state !== "downloading"), "no downloading flash");
});

Deno.test("status: sizes after a download count the model, not the shared runtime", () => {
  const nd = nextStatus(fresh({ modelBytes: fast.variants.int8.bytes }), { type: "checked", ready: false, sizeBytes: FAST_GPU, downloadBytes: FAST_GPU, modelBytes: fast.variants.int8.bytes });
  assert.equal(nd.modelBytes, fast.variants.int8.bytes);
  const ready = nextStatus(nextStatus(nd, { type: "start", total: FAST_GPU }), { type: "done" });
  assert.equal(ready.modelBytes, fast.variants.int8.bytes);
  assert.equal(describeStatus(ready).detail, "Downloaded once (44 MB). Works offline.");
});

Deno.test("status: a mod's ml provider of unknown size offers no 0 MB download", async () => {
  const { bg } = service();
  bg.providers.register({ id: "mod-ml", label: "Mod model", kind: "ml", ready: async () => false, run: async () => null });
  const s = await bg.refreshStatus("mod-ml");
  assert.equal(s.state, "not-downloaded");
  assert.equal(s.model, null, "not built by modelProvider: nothing prepare() can fetch");
  assert.equal(bg.describe(s).short, "");
  assert.doesNotMatch(bg.describe(s).detail, /0 MB/);
});

Deno.test("service: without Cache Storage a prepare explains why it cannot keep the files", async () => {
  const ctx = fakeCtx();
  const engine = fakeEngine(fakeCaches());
  const bg = createBgService(ctx, { engine, caches: null, fetch: noVendor, gpu: false });
  await assert.rejects(bg.prepare("fast"), (err) => err.code === "storage");
  assert.equal(bg.status("fast").state, "error");
  assert.equal(bg.status("fast").storable, false, "so no view offers Try again");
  assert.equal(bg.downloading().length, 0);
});

Deno.test("service: confirmDownload does not ask again while the download runs", async () => {
  let asked = 0;
  const { bg, ctx } = service();
  ctx.ui.confirm = async () => (asked++, true);
  const p = bg.prepare("fast");
  await until(() => bg.status("fast").state === "downloading");
  assert.equal(await bg.confirmDownload("fast"), true);
  assert.equal(asked, 0);
  await p;
  assert.equal(await bg.confirmDownload("best"), true);
  assert.equal(asked, 1, "Best still asks first");
});

// ---- a browser that keeps nothing -------------------------------------------------------

Deno.test("status: storable says whether the browser keeps downloads, and sticks", () => {
  let s = nextStatus(fresh(), { type: "checked", ready: false, sizeBytes: FAST_GPU, downloadBytes: FAST_GPU, storable: false });
  assert.equal(s.storable, false);
  assert.equal(describeStatus(s).label, "Not kept");
  assert.equal(describeStatus(s).short, "69 MB download", "no one-time promise it cannot keep");
  assert.match(describeStatus(s).detail, /does not keep downloads/);
  s = nextStatus(s, { type: "checked", ready: false, sizeBytes: FAST_GPU, downloadBytes: FAST_GPU });
  assert.equal(s.storable, false, "a look without the flag keeps what was known");
  s = nextStatus(s, { type: "checked", ready: false, sizeBytes: FAST_GPU, downloadBytes: FAST_GPU, storable: true });
  assert.equal(s.storable, true);
  assert.equal(describeStatus(s).short, "One-time 69 MB download");
  assert.equal(nextStatus(fresh(), { type: "checked", ready: false, sizeBytes: FAST_GPU }).storable, true, "assumed until told otherwise");
});

Deno.test("service: without Cache Storage the first look says so, with no engine", async () => {
  const ctx = fakeCtx();
  const engine = fakeEngine(fakeCaches());
  const bg = createBgService(ctx, { engine, caches: null, fetch: noVendor, gpu: false });
  const s = await bg.refreshStatus("fast");
  assert.equal(s.state, "not-downloaded");
  assert.equal(s.storable, false);
  assert.equal(engine.log.loads, 0);
});

Deno.test("service: a download the browser did not keep is an error, not ready", async () => {
  const caches = fakeCaches();
  const open = caches.open.bind(caches);
  // A full disk: every put is dropped.
  caches.open = async (name) => ({ ...(await open(name)), put: async () => {} });
  const { bg } = service({ caches });
  await assert.rejects(bg.prepare("fast"), (err) => err.code === "storage" && /did not keep it/.test(err.message));
  const s = bg.status("fast");
  assert.equal(s.state, "error");
  assert.equal(s.ready, false);
  assert.equal(s.storable, true, "it can keep files in principle: Try again stays");
});
