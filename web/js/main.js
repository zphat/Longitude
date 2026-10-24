// Boot. Builds the app context, attaches every service in order (SPEC 7) and
// mounts the UI. One part failing never takes the rest down: each step is
// isolated, logged and reported once in a toast. Only a failure of the core
// (store, storage) shows the fatal screen. Views most sessions open late or
// never (export, feed preview, quick tools, Settings, the background removal
// internals) are not imported here: they load on first use (SPEC 2).

import { createContext } from "./app/context.js";
import { createThemes } from "./ui/theme.js";
import { createUI } from "./ui/menus.js";
import { AssetStore, ProjectStore } from "./core/assets.js";
import { FontRegistry } from "./core/fonts.js";
import { Store } from "./core/store.js";
import { normalizeDoc } from "./core/model.js";
import { renderThumb } from "./core/render.js";
import { installTextNormalizer } from "./core/textlayout.js";
import { shapes } from "./core/shapes.js";
import { filters } from "./core/filters.js";
import { createAutosave } from "./core/project.js";
import { loadPresets } from "./features/presets.js";
import { createBgService } from "./features/bgremove/index.js";
import { createEditor } from "./editor/index.js";
import { mountInspector } from "./ui/inspector.js";
import { mountLayers } from "./ui/layers.js";
import { mountQuickbar } from "./ui/quickbar.js";
import { openColorPicker } from "./ui/colorpicker.js";
import { openFontPicker } from "./ui/fontpicker.js";
// Export, feed preview, quick tools, the encoders and Settings load on first use.
import { registerExportCommands, openExport, openFeedPreview, openQuickTool, loadedCompress, warmOnIntent, pinOnDemand } from "./ui/ondemand.js";
import { loadMods, loadSettings, openSettings, registerModCommands, validateIndex } from "./mods/loader.js";
import { defaultModsBase } from "./mods/paths.js";
import { createPalette } from "./ui/palette.js";
import { mountShell } from "./ui/shell.js";
import { mountHome } from "./ui/home.js";
import { installKeyboard } from "./ui/keyboard.js";
import {
  registerCoreCommands,
  session,
  openStoredDesign,
  openFiles,
  rememberOpened,
  designOpenElsewhere,
  collectGarbage,
  holdWindowLock,
  connectWindows,
  announce,
  writeRescue,
  clearRescue,
  readRescues,
  rescueIsNewer,
} from "./ui/commands-core.js";
import { h } from "./ui/dom.js";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];

function fail(part, err) {
  console.error(`Longitude: ${part} did not load.`, err);
  failures.push({ part, message: String(err?.message || err || "Unknown error") });
}

function attempt(part, fn) {
  try {
    return fn();
  } catch (err) {
    fail(part, err);
    return null;
  }
}

async function attemptAsync(part, fn) {
  try {
    return await fn();
  } catch (err) {
    fail(part, err);
    return null;
  }
}

function showFatal(err) {
  console.error("Longitude could not start.", err);
  bootFinished();
  $("boot")?.remove();
  const box = $("fatal");
  if (!box) return;
  const detail = box.querySelector("[data-detail]");
  if (detail) detail.textContent = String(err?.stack || err?.message || err || "Unknown error");
  box.hidden = false;
}

function reportFailures(ctx) {
  if (!failures.length || !ctx.ui.toast) return;
  // A snapshot: Details builds its list when clicked, long after this returns.
  const list = failures.splice(0);
  const parts = [...new Set(list.map((f) => f.part))];
  ctx.ui.toast(`Some parts did not load: ${parts.join(", ")}. Everything else works.`, {
    kind: "warn",
    timeout: 10000,
    action: {
      label: "Details",
      run: () =>
        ctx.ui.dialog({
          title: "What did not load",
          description: "The rest of Longitude works. Reloading the page often fixes this.",
          body: h(
            "div",
            { class: "fail-list" },
            list.map((f) => h("div", { class: "fail-row" }, h("strong", null, f.part), h("code", null, f.message))),
          ),
          actions: [{ label: "Reload", kind: "primary", run: () => location.reload() }],
        }),
    },
  });
}

// ---- safe mode ---------------------------------------------------------------------
//
// A mod (or a design) that blocks the page synchronously cannot be stopped by
// a timeout. A flag set while booting and cleared once the app is usable shows
// on the next start that the last one never finished; that start, and any with
// ?safe in the address, skips mods and does not reopen a design.

const BOOT_FLAG = "longitude.booting";
const BOOT_LOCK = "longitude-booting";

function lsGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

// "asked" (?safe), "stuck" (the last start never finished) or "".
async function safeModeReason() {
  if (new URLSearchParams(location.search).has("safe")) return "asked";
  const flag = Number(lsGet(BOOT_FLAG));
  if (!flag) return "";
  // Another window that is starting right now holds the boot lock; only a
  // start that died (or has hung for a long time) leaves the flag alone.
  let held = false;
  try {
    held = !!(await navigator.locks?.query?.())?.held?.some((l) => l.name === BOOT_LOCK);
  } catch {}
  return !held || Date.now() - flag > 15000 ? "stuck" : "";
}

let booted = false;
let releaseBootLock = () => {};

function markBooting() {
  lsSet(BOOT_FLAG, String(Date.now()));
  try {
    navigator.locks
      ?.request?.(BOOT_LOCK, { mode: "shared" }, () => (booted ? undefined : new Promise((r) => (releaseBootLock = r))))
      ?.catch?.(() => {});
  } catch {}
}

function bootFinished() {
  booted = true;
  lsSet(BOOT_FLAG, null);
  releaseBootLock();
}

function restartNormally() {
  const url = new URL(location.href);
  url.searchParams.delete("safe");
  location.replace(url.href);
}

async function turnModsOff(ctx) {
  try {
    const res = await fetch(new URL("mods.json", defaultModsBase()).href, { cache: "no-store" });
    const { mods } = validateIndex(await res.json());
    const saved = { ...(ctx.prefs.get("mods", {}) || {}) };
    for (const m of mods) saved[m.id] = false;
    ctx.prefs.set("mods", saved);
    ctx.prefs.flush();
    ctx.ui.toast?.(`Turned off ${mods.length} mod${mods.length === 1 ? "" : "s"}. Turn the ones you want back on in Settings, Mods.`, {
      kind: "ok",
      timeout: 0,
      id: "safe-mode",
      action: { label: "Restart", run: restartNormally },
    });
  } catch (err) {
    console.error(err);
    ctx.ui.toast?.("The mod list could not be read. Set a mod's \"enabled\" to false in web/mods/mods.json instead.", { kind: "error" });
  }
}

function safeModeToast(ctx, reason) {
  const why = reason === "stuck" ? "Longitude did not finish starting last time, so this is safe mode" : "Safe mode";
  ctx.ui.toast?.(`${why}: mods are off and no design was reopened.`, {
    kind: "warn",
    timeout: 0,
    id: "safe-mode",
    action: [
      { label: "Turn all mods off", run: () => turnModsOff(ctx) },
      { label: "Restart normally", run: restartNormally },
    ],
  });
}

// ---- service worker --------------------------------------------------------------

function isLocalHost() {
  const host = location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
}

const flushBriefly = () => Promise.race([Promise.resolve(session.autosave?.flush?.({ thumb: false })).catch(() => {}), sleep(2000)]);

async function serviceWorker(ctx) {
  const sw = navigator.serviceWorker;
  if (!sw) return;
  if (location.protocol !== "https:" && !isLocalHost()) return;
  // ?nosw: development escape hatch. Removes the worker and its caches
  // (index.html does the same before this module loads).
  if (new URLSearchParams(location.search).has("nosw")) {
    for (const r of await sw.getRegistrations()) await r.unregister();
    for (const k of await caches.keys()) if (/^longitude-(shell|data|next)-/.test(k)) await caches.delete(k);
    console.info("Longitude: service worker removed for this session.");
    return;
  }
  const reload = async () => {
    await flushBriefly();
    location.reload();
  };
  // Changed files are staged by the worker and used from the next page load.
  const offerReload = () =>
    ctx.ui.toast?.("Longitude was updated. Reload to use the new version.", { id: "sw-update", timeout: 0, action: { label: "Reload", run: reload } });
  // A new worker waits until the page agrees, so code never switches halfway through a session.
  let switching = false;
  const offerWaiting = (worker) =>
    ctx.ui.toast?.("A new version of Longitude is ready. Reload to use it.", {
      id: "sw-update",
      timeout: 0,
      action: {
        label: "Reload",
        run: async () => {
          await flushBriefly();
          switching = true;
          worker.postMessage({ type: "skip-waiting" });
          setTimeout(() => location.reload(), 3000);
        },
      },
    });
  try {
    // Either kind of update: the modules this page loads later are taken
    // from the files it started with first (see pinOnDemand).
    sw.addEventListener("message", (e) => {
      if (e.data?.type !== "longitude-updated") return;
      pinOnDemand();
      offerReload();
    });
    sw.addEventListener("controllerchange", () => {
      if (switching) location.reload();
    });
    const reg = await sw.register("sw.js", { scope: "./" });
    const watch = (worker) => {
      if (!worker) return;
      const check = () => {
        if (worker.state !== "installed" || !sw.controller) return;
        pinOnDemand();
        offerWaiting(worker);
      };
      check();
      worker.addEventListener("statechange", check);
    };
    watch(reg.waiting || reg.installing);
    reg.addEventListener("updatefound", () => watch(reg.installing));
    // Hand the worker every file this page loaded so the next visit works
    // offline; it then checks the cached files for updates.
    const ready = await sw.ready;
    const urls = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((u) => u.startsWith(location.origin));
    urls.push(new URL("./", location.href).href);
    (ready.active || reg.active)?.postMessage({ type: "cache-urls", urls });
  } catch (err) {
    console.warn("Longitude: service worker not registered.", err);
  }
}

// ---- storage -------------------------------------------------------------------------

// Remembers the doc object each save wrote, so closing the window can tell
// whether the newest change is in storage.
class TrackedProjectStore extends ProjectStore {
  constructor(...args) {
    super(...args);
    this.written = new Map();
    this.onWrite = null;
  }

  async save(doc, ...rest) {
    const at = await super.save(doc, ...rest);
    this.written.set(doc.id, doc);
    this.onWrite?.(doc);
    return at;
  }
}

// Rescue copies left by a window that closed before its last save landed.
// Resolves to the id of the newest one applied, or null.
async function restoreRescues(ctx) {
  let latest = null;
  for (const { id, rec } of readRescues()) {
    // That window is still open and will save it itself.
    if (await designOpenElsewhere(id)) continue;
    try {
      const stored = await ctx.projects.load(id);
      if (rescueIsNewer(rec, id, stored?.meta?.updated || 0)) {
        const doc = normalizeDoc(rec.doc);
        doc.id = id;
        const thumb = await Promise.race([renderThumb(doc, { assets: ctx.assets, fonts: ctx.fonts }).catch(() => undefined), sleep(3000).then(() => undefined)]);
        await ctx.projects.save(doc, thumb);
        if (!latest || rec.at > latest.at) latest = { id, at: rec.at };
      }
      clearRescue(id);
    } catch (err) {
      console.warn("Longitude: a rescued design could not be restored.", err);
    }
  }
  if (latest) await ctx.projects.setLastOpened(latest.id).catch(() => {});
  return latest?.id || null;
}

// Reopens the design open last time. A design that no longer exists is
// forgotten quietly; one open in another window leaves this one on Home.
async function reopenLast(ctx) {
  const lastId = await ctx.projects.lastOpened().catch(() => null);
  if (!lastId) return false;
  if (!(await ctx.projects.has(lastId).catch(() => false))) {
    ctx.projects.setLastOpened(null).catch(() => {});
    return false;
  }
  session.lastOpened = lastId;
  if (await attemptAsync("Last design", () => openStoredDesign(ctx, lastId, { quiet: true }))) return true;
  if (await designOpenElsewhere(lastId)) {
    ctx.ui.toast?.("Your last design is open in another window, so this one starts at Home.", { kind: "info", id: "open-elsewhere" });
  }
  return false;
}

// Asks the browser once to keep this site's data under storage pressure.
let storageChecked = false;
async function keepStorage(ctx) {
  if (storageChecked) return;
  storageChecked = true;
  const s = globalThis.navigator?.storage;
  if (!s?.persist || !s.persisted || ctx.prefs.get("storageAsked", false)) return;
  try {
    if (await s.persisted()) return;
    const kept = await s.persist();
    ctx.prefs.set("storageAsked", true);
    ctx.prefs.set("storageKept", !!kept);
    if (!kept) {
      ctx.ui.toast?.("This browser may clear saved designs when the disk is nearly full. Save a project file of anything you want to keep.", {
        kind: "info",
        timeout: 12000,
        id: "storage-kept",
        action: { label: "Save project file", run: () => ctx.commands.run("file.save-copy") },
      });
    }
  } catch {}
}

// ---- boot ---------------------------------------------------------------------------

async function boot() {
  const safe = await safeModeReason();
  markBooting();
  const ctx = createContext();
  globalThis.longitude = ctx; // handy in the console; mods get their own frozen api

  // Theme first, so nothing flashes in the wrong colors.
  ctx.themes = createThemes(ctx);
  attempt("Theme", () => ctx.themes.apply());

  // Floating UI next, so every later step can report a problem.
  Object.assign(ctx.ui, createUI(ctx, { toast: $("toast-root"), menu: $("menu-root"), modal: $("modal-root"), tip: $("tip-root") }));

  // Storage and the document. These are the core: if they fail, nothing can work.
  ctx.assets = new AssetStore();
  await ctx.assets.init();
  ctx.projects = new TrackedProjectStore(ctx.assets);
  ctx.fonts = new FontRegistry({ assets: ctx.assets });
  await attemptAsync("Fonts", () => ctx.fonts.init());
  ctx.store = new Store();
  attempt("Text layout", () => installTextNormalizer(ctx.store, ctx.fonts));
  let remeasureTimer = 0;
  ctx.fonts.addEventListener("load", () => {
    clearTimeout(remeasureTimer);
    remeasureTimer = setTimeout(() => ctx.store.remeasure(), 30);
  });

  ctx.shapes = shapes;
  ctx.filters = filters;
  ctx.presets = await loadPresets(ctx);
  ctx.bg = attempt("Background removal", () => createBgService(ctx));
  // The encoders (features/compress.js) once the first export or quick tool loaded them, else null.
  Object.defineProperty(ctx, "exporter", { get: loadedCompress, enumerable: true, configurable: true });

  // Canvas and panels.
  ctx.editor = attempt("Canvas", () => createEditor(ctx, { host: $("stage") }));
  attempt("Inspector", () => mountInspector($("inspector"), ctx));
  attempt("Layers", () => mountLayers($("layers"), ctx));
  attempt("Quick bar", () => mountQuickbar($("stage"), ctx));

  // The rest of ctx.ui.
  Object.assign(ctx.ui, {
    openColorPicker: (anchor, opts = {}) => openColorPicker(anchor, { ctx, ...opts }),
    openFontPicker: (anchor, opts = {}) => openFontPicker(anchor, { ctx, ...opts }),
    openExport: (opts) => openExport(ctx, opts),
    openFeedPreview: (opts) => openFeedPreview(ctx, opts),
    openQuickTool: (kind, opts = {}) => openQuickTool(kind, ctx, opts),
    openSettings: (opts = {}) => openSettings(ctx, opts),
  });
  // Pointing at Export, Preview, Settings or a quick tool starts loading it.
  warmOnIntent(document, [['[data-cmd="app.settings"]', loadSettings]]);
  const palette = attempt("Command palette", () => createPalette(ctx));
  if (palette) {
    ctx.ui.openPalette = (q) => palette.open(q);
    ctx.ui.closePalette = () => palette.close();
  }

  const shell = attempt("Top bar and tools", () => mountShell(ctx));
  // "Canvas settings" in the canvas menu clears the selection; make sure the panel showing them is visible.
  ctx.on("canvas-settings", () => shell?.togglePanel(true));
  const home = attempt("Home", () => mountHome(ctx, $("home")));
  ctx.ui.openHome = (opts) => home?.open(opts);
  ctx.ui.closeHome = () => home?.close();
  ctx.ui.isHomeOpen = () => !!home?.isOpen();

  // Commands and keys.
  attempt("Commands", () => registerCoreCommands(ctx));
  attempt("Export", () => registerExportCommands(ctx));
  attempt("Mods", () => registerModCommands(ctx));
  attempt("Keyboard", () => installKeyboard(ctx));

  // Autosave and the saved indicator; other windows of Longitude.
  wireAutosave(ctx, shell);
  holdWindowLock();
  attempt("Windows", () => connectWindows(ctx));

  // Files handed over by the operating system ("Open with Longitude"). The
  // consumer is set before the last design reopens so a launch with files
  // starts from them instead; later launches always start a new design.
  let launch = null;
  let launchReady = false;
  if ("launchQueue" in window) {
    window.launchQueue.setConsumer((params) => {
      const handles = [...(params?.files || [])];
      if (!handles.length) return;
      const files = Promise.all(handles.map((f) => f.getFile())).catch(() => []);
      if (!launchReady) launch = files;
      else files.then((list) => list.length && openFiles(ctx, list, { fresh: true }));
    });
  }

  // Mods load last; a broken mod is reported in Settings, never fatal, and a
  // slow one never holds the app back for more than a few seconds.
  // In safe mode the mods are listed (Settings, Mods can turn one off) but none starts.
  await Promise.race([attemptAsync("Mods", () => loadMods(ctx, { start: !safe })), sleep(4000)]);

  // Open what the OS handed over, else the last design, else Home.
  if ("launchQueue" in window && !launch) await sleep(30);
  launchReady = true;
  if (!safe) await attemptAsync("Rescued designs", () => restoreRescues(ctx));
  let opened = false;
  if (launch) {
    const files = await launch;
    if (files.length) await openFiles(ctx, files, { fresh: true });
    opened = session.open;
  }
  if (!opened && !safe) opened = await reopenLast(ctx);
  if (!opened && !ctx.ui.isHomeOpen()) ctx.ui.openHome({ focus: null });

  shell?.refresh();
  document.body.classList.remove("booting");
  const splash = $("boot");
  if (splash) {
    splash.classList.add("done");
    setTimeout(() => splash.remove(), 400);
  }
  bootFinished();
  reportFailures(ctx);
  if (safe) safeModeToast(ctx, safe);
  if (!ctx.assets.persistent) shell?.setSaveState("memory");

  // Old images nothing uses any more.
  setTimeout(() => Promise.resolve(collectGarbage(ctx)).catch(() => {}), 20000);
  if (document.readyState === "complete") serviceWorker(ctx);
  else addEventListener("load", () => serviceWorker(ctx), { once: true });
  return ctx;
}

function wireAutosave(ctx, shell) {
  let errorShown = false;
  let failed = false;
  const setState = (s, info) => shell?.setSaveState(s, info);
  const onSaved = ({ at, id }) => {
    session.savedIds.add(id);
    failed = false;
    errorShown = false;
    if (session.open && id === ctx.store.doc.id) {
      setState(ctx.assets.persistent ? "saved" : "memory", { at });
      // Remembered for the next start only once it really is stored.
      rememberOpened(ctx, id);
      if (ctx.store.doc.layers.length) keepStorage(ctx);
    }
    ctx.emit("saved", { at, id });
    announce({ type: "saved", id, at });
  };
  const onError = (err) => {
    failed = true;
    setState("error", { message: err?.message });
    if (errorShown) return;
    errorShown = true;
    ctx.ui.toast?.(err?.message || "Your latest changes could not be saved.", {
      kind: "error",
      timeout: 0,
      id: "save-error",
      action: { label: "Save project file", run: () => ctx.commands.run("file.save-copy") },
    });
  };
  const autosave = createAutosave({ store: ctx.store, projects: ctx.projects, assets: ctx.assets, fonts: ctx.fonts, onSaved, onError });
  session.autosave = autosave;
  // A design that arrives with content is stored by commands-core right away.
  session.onStored = onSaved;
  session.onStoreError = onError;

  ctx.store.addEventListener("change", (e) => {
    const d = e.detail || {};
    if (d.transient || d.reason === "setdoc") return;
    const doc = ctx.store.doc;
    if (!doc.layers.length && !session.savedIds.has(doc.id)) setState("draft");
    else setState(failed ? "error" : "pending");
  });
  ctx.on("project", (d) => {
    if (!d?.id) return setState("draft");
    if (d.fromStorage) setState(ctx.assets.persistent ? "saved" : "memory", { at: ctx.store.doc.meta?.updated });
    else setState(ctx.store.doc.layers.length ? "pending" : "draft");
  });

  // Rescue copies: IndexedDB cannot finish a save while the page unloads, so
  // a change not yet stored is copied to localStorage when the page hides.
  const written = ctx.projects.written || new Map();
  const rescued = new Set();
  ctx.on("project", (d) => {
    if (d?.fromStorage) written.set(ctx.store.doc.id, ctx.store.doc);
  });
  ctx.projects.onWrite = (doc) => {
    // The newest version (or the final one of a design no longer open) is stored.
    if (rescued.has(doc.id) && (doc.id !== ctx.store.doc.id || doc === ctx.store.doc)) {
      rescued.delete(doc.id);
      clearRescue(doc.id);
    }
  };
  const rescue = () => {
    const doc = ctx.store.doc;
    if (!session.open || !doc?.id || written.get(doc.id) === doc) return;
    if (!doc.layers.length && !session.savedIds.has(doc.id)) return;
    if (writeRescue(doc)) rescued.add(doc.id);
  };

  // Pending changes are written when the page hides or closes (createAutosave
  // listens for that); the rescue copy and prefs go with them.
  addEventListener("pagehide", () => {
    rescue();
    ctx.prefs.flush();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") return;
    rescue();
    ctx.prefs.flush();
  });
  addEventListener("beforeunload", (e) => {
    const unsaved = failed && autosave.pending;
    // Starts the save as early as possible; a reload usually lets it finish.
    autosave.flush({ thumb: false });
    if (unsaved) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
}

// Only in a page (tools/check.mjs imports this module under Deno).
if (typeof document !== "undefined") boot().catch(showFatal);
