// Background removal service (SPEC 11). Everything runs on this machine: the
// model and runtime are downloaded once, cached, and images never leave it.
//
//   const bg = createBgService(ctx);
//   if (await bg.confirmDownload("fast")) await bg.removeLayerBackground(id);
//
// Providers are a registry, so mods can add their own (docs/BGREMOVE.md).

import { createRegistry } from "../../app/context.js";
import { BG_CONFIG } from "./config.js";
import { abortError, cacheUsage, clearCache, detectCaps, friendlyError, isCached, planModel } from "./engine.js";
import * as masks from "./mask.js";
import { alphaToMask, makeCanvas, maskToCutout, readPixels, sourceSize } from "./mask.js";
import { createRunner } from "./runner.js";
import { canTrim, cutoutCrop, fitProps, opaqueBounds, sameCrop, unionCrop } from "./trim.js";

export { BG_CONFIG } from "./config.js";

const MB = 1e6;
const toMB = (bytes) => (bytes > 0 ? Math.max(1, Math.round(bytes / MB)) : 0);

function asError(err) {
  if (err instanceof Error && err.code) return err;
  const info = friendlyError(err);
  return Object.assign(Error(info.message), { name: info.name, code: info.code, detail: info.detail });
}

function linkSignal(controller, signal) {
  if (!signal) return;
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
}

// The model sees the image squeezed to size x size. Transparent areas become
// mid grey so they read as plain background.
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

export function createBgService(ctx) {
  const runner = createRunner();
  let avoidGpu = false; // set for the rest of the session once the graphics card fails
  const running = new Map(); // layerId -> { promise, controller }
  // Box trims this session: layerId -> { asset, crop: the crop before trimming,
  // trims: crops the trims set }. "Restore original" puts the crop back while
  // the layer still shows one of those trims (the user has not re-cropped).
  const trims = new Map();

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

  // ---- ML providers built from BG_CONFIG --------------------------------------

  async function mlInfo(def) {
    const model = BG_CONFIG.models[def.model];
    const plan = await planModel(def.model, { avoidGpu });
    const runtimeBytes = plan.runtime.wasm.bytes + plan.runtime.script.bytes + plan.runtime.glue.bytes;
    const [modelCached, runtimeCached] = await Promise.all([
      isCached(plan.file, plan.cacheName),
      isCached(plan.runtime.wasm, plan.cacheName),
    ]);
    const download = (modelCached ? 0 : plan.file.bytes) + (runtimeCached ? 0 : runtimeBytes);
    return {
      id: def.id,
      label: def.label,
      note: def.note || "",
      kind: "ml",
      sizeMB: toMB(plan.file.bytes + runtimeBytes),
      downloadMB: toMB(download),
      modelMB: toMB(plan.file.bytes),
      runtimeMB: toMB(runtimeBytes),
      cached: download === 0,
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
    return {
      id: def.id,
      label: def.label,
      note: def.note || "",
      kind: "ml",
      model: def.model,
      sizeMB: toMB(first?.bytes || 0),
      license: model.license || "",
      source: model.source || null,
      info: () => mlInfo(def),
      async ready() {
        return (await mlInfo(def)).cached;
      },
      async run(source, { onProgress, signal } = {}) {
        const { width, height } = sourceSize(source);
        if (!width || !height) throw Object.assign(Error("The image has no pixels."), { code: "decode" });
        const plan = await planModel(def.model, { avoidGpu });
        const input = modelInput(source, plan.model.size);
        let res;
        try {
          res = await runner.run({ type: "model", plan, input, target: { width, height } }, { onProgress, signal });
        } catch (err) {
          if (err?.code === "gpu") avoidGpu = true;
          throw err;
        }
        if (res.gpuFailed) avoidGpu = true;
        const alpha = res.alpha instanceof Uint8ClampedArray ? res.alpha : new Uint8ClampedArray(res.alpha.buffer || res.alpha);
        return alphaToMask({ width: res.width, height: res.height, data: alpha });
      },
    };
  }

  const magicProvider = {
    id: "magic",
    label: "Magic (flat backgrounds)",
    note: "For flat colour backgrounds and screenshots. No download.",
    kind: "local",
    sizeMB: 0,
    license: "MIT",
    source: null,
    ready: async () => true,
    async run(source, { onProgress, signal } = {}) {
      const image = readPixels(source);
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

  // Ask once before the first download. Resolves true when ready to go.
  async function confirmDownload(providerId) {
    const info = await modelInfo(providerId);
    if (!info || info.cached) return true;
    if (typeof ctx.ui?.confirm !== "function") return true;
    return ctx.ui.confirm({
      title: "Download the background remover?",
      // Same words as the inspector and quick tools.
      message: `Background removal downloads a ${info.downloadMB} MB model once. It runs on this computer; your image is never uploaded.`,
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
  // exactly what the trim makes of the whole photo is recognised too.
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
        const bitmap = await ctx.assets.loadImage(layer.asset);
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
        // snapping and the Centre pill follow the subject, not the old frame.
        const box = cutoutProps(layerId, mask);
        ctx.store.patch(layerId, { mask: maskId, ...box }, { label: "Remove background" });
        ctx.editor?.flash?.([layerId]);
        emit("done", 1, "Background removed");
        return { layerId, maskId, provider: p.id };
      } catch (err) {
        const e = asError(err);
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
      let bitmap = await toBitmap(input);
      if (typeof Blob !== "undefined" && input instanceof Blob) bitmap = capSide(bitmap, maxSide);
      const { width, height } = sourceSize(bitmap);
      report({ phase: "run", progress: 0, message: "Getting ready" });
      const mask = await p.run(bitmap, { onProgress: report, signal });
      const cutout = maskToCutout(bitmap, mask);
      report({ phase: "done", progress: 1, message: "Background removed" });
      return { mask, cutout, width, height, provider: p.id };
    } catch (err) {
      const e = asError(err);
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
    confirmDownload,
    cancel(layerId) {
      running.get(layerId)?.controller.abort();
    },
    isRunning: (layerId) => running.has(layerId),
    modelProvider,
    capabilities: detectCaps,
    // Frees the loaded model's memory (it is also freed after a few idle minutes).
    release: () => runner.release(),
    // Downloaded models and runtime in Cache Storage: { bytes, files }, and removing them.
    cacheUsage: () => cacheUsage(BG_CONFIG.cacheName),
    clearCache: () => clearCache(BG_CONFIG.cacheName),
    config: BG_CONFIG,
    // mask.js helpers (magicMask, paintMask, featherMask, growMask, maskToCutout, …) for mods.
    masks,
  };
  return bg;
}
