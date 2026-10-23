// Runs engine jobs in worker.js, or on the main thread when a module worker
// cannot start (old browser, blocked by policy). Same results either way.
//
// Memory: a WebAssembly heap only grows, so freeing the model session inside
// the worker leaves its gigabyte or so allocated. Instead, the worker itself
// is closed after BG_CONFIG.idleReleaseMs without a job (or by release()),
// and the next job starts a fresh one; the runtime and model come back from
// Cache Storage in a few seconds. On the main-thread fallback the heap can
// only be returned by reloading the page.

import { BG_CONFIG } from "./config.js";
import { abortError, friendlyError, releaseModel, runJob } from "./engine.js";

const READY_TIMEOUT = 10000;

function toError(info) {
  const err = Error(info?.message || "Background removal did not work on this image.");
  err.name = info?.name || "Error";
  err.code = info?.code || "model";
  err.detail = info?.detail || "";
  return err;
}

export function createRunner({ url = new URL("./worker.js", import.meta.url), idleMs = null } = {}) {
  let worker = null;
  let ready = null;
  let broken = typeof Worker === "undefined";
  let seq = 0;
  let idleTimer = 0;
  const pending = new Map(); // id -> { resolve, reject, onProgress, done }

  function failAll(message) {
    for (const p of [...pending.values()]) p.done(toError({ message, code: "runtime" }));
  }

  function stop() {
    clearTimeout(idleTimer);
    idleTimer = 0;
    worker?.terminate();
    worker = null;
    ready = null;
  }

  // Close the idle worker (and its heap) once nothing has run for idleMs.
  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = 0;
    const ms = idleMs ?? BG_CONFIG.idleReleaseMs; // read late: mods may change the config
    if (!worker || pending.size || !(ms > 0)) return;
    const w = worker;
    idleTimer = setTimeout(() => {
      idleTimer = 0;
      if (worker === w && !pending.size) stop();
    }, ms);
  }

  function start() {
    if (broken) return Promise.resolve(false);
    if (ready) return ready;
    try {
      worker = new Worker(url, { type: "module", name: "longitude-bgremove" });
    } catch {
      broken = true;
      return Promise.resolve(false);
    }
    const w = worker;
    ready = new Promise((resolve) => {
      let alive = false;
      const timer = setTimeout(() => {
        if (alive) return;
        broken = true;
        stop();
        resolve(false);
      }, READY_TIMEOUT);
      w.addEventListener("message", (e) => {
        const msg = e.data || {};
        if (msg.type === "ready") {
          alive = true;
          clearTimeout(timer);
          resolve(true);
          return;
        }
        const p = pending.get(msg.id);
        if (!p) return;
        if (msg.type === "progress") p.onProgress?.({ phase: msg.phase, progress: msg.progress, message: msg.message });
        else if (msg.type === "result") p.done(null, msg.result);
        else if (msg.type === "error") {
          // A runtime that failed to start may be stuck; begin with a fresh worker next time.
          if (msg.error?.code === "runtime") setTimeout(() => worker === w && !pending.size && stop(), 0);
          p.done(toError(msg.error));
        }
      });
      w.addEventListener("error", (e) => {
        e.preventDefault?.();
        console.error("Longitude: background removal worker error", e.message || e);
        if (!alive) {
          clearTimeout(timer);
          broken = true;
          stop();
          resolve(false);
          return;
        }
        if (worker === w) stop();
        failAll("The background remover stopped. Try again.");
      });
      w.addEventListener("messageerror", () => failAll("The background remover stopped. Try again."));
    });
    return ready;
  }

  function viaWorker(job, { onProgress, signal }) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const onAbort = () => {
        worker?.postMessage({ type: "cancel", id });
        done(abortError());
      };
      function done(err, result) {
        if (!pending.has(id)) return;
        pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        armIdle();
        if (err) reject(err);
        else resolve(result);
      }
      pending.set(id, { onProgress, done });
      signal?.addEventListener("abort", onAbort, { once: true });
      worker.postMessage({ type: "job", id, job });
    });
  }

  async function inline(job, opts) {
    try {
      return await runJob(job, opts);
    } catch (err) {
      throw toError(friendlyError(err));
    }
  }

  return {
    // Resolves { alpha: Uint8ClampedArray|ArrayBuffer view, width, height, backend, variant, gpuFailed }.
    async run(job, { onProgress, signal } = {}) {
      clearTimeout(idleTimer);
      idleTimer = 0;
      if (signal?.aborted) throw abortError();
      const ok = await start();
      if (signal?.aborted) {
        armIdle();
        throw abortError();
      }
      return ok && worker ? viaWorker(job, { onProgress, signal }) : inline(job, { onProgress, signal });
    },
    // Free the loaded model's memory now: close the worker when it is idle,
    // else free the session once the running job is done.
    release() {
      if (worker && !pending.size) stop();
      else if (worker) worker.postMessage({ type: "release" });
      else releaseModel();
    },
    get usesWorker() {
      return !broken && !!worker;
    },
    terminate() {
      failAll("Cancelled");
      stop();
    },
  };
}
