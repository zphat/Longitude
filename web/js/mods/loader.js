// Code mods: reads web/mods/mods.json, imports each enabled entry module and
// runs its activate(api). Each mod gets its own api (api.js) whose register
// functions are tracked, so turning a mod off removes everything it added.
// A failing mod never breaks the app: the error is caught, recorded, shown
// once as a toast and listed in Settings > Mods. Packs (packs.js) are applied
// here too, before the mods start.

import { API_VERSION, buildModApi, createScope } from "./api.js";
import { createPacks } from "./packs.js";
import { cleanModPath, defaultModsBase, resolveInside } from "./paths.js";
import { ensureModIcons, ensureModStyles, openSettings } from "../ui/settings.js";
import { THEMES } from "../ui/theme.js";

export { buildModApi, createScope, scopeOf, API_VERSION } from "./api.js";
export { openSettings } from "../ui/settings.js";
export { importPack } from "./packs.js";

export const MOD_ID_RE = /^[a-z][a-z0-9-]{1,50}$/;
export const MAX_MODS = 64;
const IMPORT_TIMEOUT = 15000;
const ACTIVATE_TIMEOUT = 10000;
const DEACTIVATE_TIMEOUT = 5000;
const KEEP_ERRORS = 5;

// ---- pure validation ---------------------------------------------------------

// One mods.json entry -> { id, entry, enabled }. Throws a plain Error.
export function validateEntry(raw, i = 0) {
  const where = `Entry ${i + 1} in mods.json`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error(`${where} must be an object with an id and an entry.`);
  if (typeof raw.id !== "string" || !MOD_ID_RE.test(raw.id)) {
    throw Error(`${where}: the id must start with a letter and use lowercase letters, digits and dashes (2 to 51 characters).`);
  }
  let entry;
  try {
    entry = cleanModPath(raw.entry, { what: "entry" });
  } catch (err) {
    throw Error(`Mod "${raw.id}": ${err.message}`);
  }
  return { id: raw.id, entry, enabled: raw.enabled !== false };
}

// The whole mods.json -> { mods, errors }. Bad entries are skipped and listed.
export function validateIndex(json) {
  const errors = [];
  if (!json || typeof json !== "object" || !Array.isArray(json.mods)) {
    return { mods: [], errors: ['mods.json needs a "mods" list, like { "mods": [{ "id": "my-mod", "entry": "my-mod/index.js" }] }.'] };
  }
  const mods = [];
  const seen = new Set();
  json.mods.forEach((raw, i) => {
    if (mods.length >= MAX_MODS) {
      if (mods.length === MAX_MODS && i === MAX_MODS) errors.push(`Only the first ${MAX_MODS} mods are loaded.`);
      return;
    }
    try {
      const m = validateEntry(raw, i);
      if (seen.has(m.id)) throw Error(`Mod "${m.id}" is listed twice in mods.json.`);
      seen.add(m.id);
      mods.push(m);
    } catch (err) {
      errors.push(err.message);
    }
  });
  return { mods, errors };
}

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// The module's manifest -> a clean copy. Throws a plain Error.
export function validateManifest(m, id) {
  if (!m || typeof m !== "object") throw Error("The mod does not export a manifest.");
  if (m.apiVersion !== API_VERSION) {
    if (Number.isInteger(m.apiVersion) && m.apiVersion > API_VERSION) {
      throw Error(`It needs mod API ${m.apiVersion}. This Longitude has API ${API_VERSION}.`);
    }
    throw Error(`Its manifest needs apiVersion: ${API_VERSION}.`);
  }
  if (m.id !== id) throw Error(`Its manifest id "${String(m.id)}" does not match "${id}" in mods.json.`);
  const name = str(m.name, 60);
  if (!name) throw Error("Its manifest needs a name.");
  const version = str(m.version, 24);
  if (!version) throw Error("Its manifest needs a version, like \"1.0.0\".");
  const homepage = typeof m.homepage === "string" && /^https:\/\/\S+$/.test(m.homepage) ? m.homepage : "";
  return { id, name, version, author: str(m.author, 60), description: str(m.description, 300), homepage, apiVersion: API_VERSION };
}

// Saved choice (prefs "mods": { id: bool }) wins over mods.json's default.
export function isEnabled(saved, mod) {
  return saved && typeof saved[mod.id] === "boolean" ? saved[mod.id] : mod.enabled !== false;
}

export function errorText(err) {
  const msg = String(err?.message || err || "Unknown error").split("\n")[0].trim();
  return msg.length > 200 ? `${msg.slice(0, 197)}...` : msg;
}

function withTimeout(promise, ms, message) {
  let t = 0;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      t = setTimeout(() => reject(Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

// ---- commands ------------------------------------------------------------------

// Registers app.mods (Settings on the Mods tab) and settings.* shortcuts into
// Settings. Also provides ctx.ui.openSettings. Returns a dispose function.
export function registerModCommands(ctx) {
  ctx.ui ||= {};
  if (typeof ctx.ui.openSettings !== "function") ctx.ui.openSettings = (opts) => openSettings(ctx, opts);
  ensureModIcons();
  const open = (tab) => (c) => openSettings(c || ctx, { tab });
  const defs = [
    { id: "app.mods", title: "Mods", group: "App", icon: "puzzle", keywords: "plugins extensions add-ons scripts settings", run: open("mods") },
    { id: "settings.packs", title: "Theme and preset packs", group: "App", icon: "package", keywords: "import pack themes palettes presets latitude", run: open("packs") },
    { id: "settings.fonts", title: "Manage fonts", group: "App", icon: "type", keywords: "custom fonts add remove typeface", run: open("fonts") },
    // Hidden from the palette: help.shortcuts (Shift+/) is already listed as "Keyboard shortcuts".
    { id: "settings.shortcuts", title: "Keyboard shortcuts", group: "App", icon: "keyboard", keywords: "keys hotkeys help", hidden: true, run: open("shortcuts") },
    { id: "settings.about", title: "About Longitude", group: "App", icon: "info", keywords: "version license credits source github", run: open("about") },
  ];
  const offs = [];
  for (const def of defs) {
    try {
      offs.push(ctx.commands.register(def));
    } catch (err) {
      console.warn(err.message);
    }
  }
  return () => offs.splice(0).forEach((off) => off());
}

// ---- loader --------------------------------------------------------------------

// opts (for tests and unusual hosts): { base, fetch, importer, kv }
//   base      URL of the mods folder (default: <page>/mods/)
//   fetch     fetch implementation for mods.json
//   importer  (url) -> Promise<module>, default dynamic import()
//   kv        { get(k), put(rec) } store for packs (default: IndexedDB "kv")
export async function loadMods(ctx, opts = {}) {
  const base = opts.base || defaultModsBase();
  const fetchFn = opts.fetch || globalThis.fetch?.bind(globalThis);
  const importer = opts.importer || ((url) => import(url));
  // start: false (safe mode) builds the records and restores packs, but never
  // imports or activates a mod; choices made in Settings apply on the next start.
  const startMods = opts.start !== false;
  const records = new Map(); // id -> record
  let indexErrors = [];
  let booting = true;

  ctx.ui ||= {};
  if (typeof ctx.ui.openSettings !== "function") ctx.ui.openSettings = (o) => openSettings(ctx, o);
  ensureModStyles();

  const changed = () => ctx.emit?.("mods", {});
  const saved = () => {
    const v = ctx.prefs?.get("mods", {});
    return v && typeof v === "object" ? v : {};
  };
  const openModsTab = () => ctx.ui.openSettings?.({ tab: "mods" });

  function info(rec) {
    const m = rec.manifest;
    return {
      id: rec.id,
      entry: rec.entry,
      url: rec.url,
      name: m?.name || rec.id,
      version: m?.version || "",
      author: m?.author || "",
      description: m?.description || "",
      homepage: m?.homepage || "",
      enabled: isEnabled(saved(), rec),
      defaultEnabled: rec.enabled,
      status: rec.status,
      error: rec.error,
      runtimeErrors: rec.runtimeErrors.slice(),
      adds: rec.scope ? rec.scope.counts() : {},
    };
  }

  function makeRecord(m) {
    let url = null;
    let error = null;
    try {
      url = resolveInside(m.entry, base);
    } catch (err) {
      error = errorText(err);
    }
    return { ...m, url, status: error ? "error" : "off", error, manifest: null, module: null, scope: null, api: null, importFailed: false, runtimeErrors: [], queue: Promise.resolve() };
  }

  // Runs tasks for one mod one after another (toggle spam, reload while starting).
  function queue(rec, task) {
    const run = rec.queue.then(task, task);
    rec.queue = run.catch(() => {});
    return run;
  }

  function noteRuntimeError(rec, err, where) {
    const message = errorText(err);
    const last = rec.runtimeErrors[rec.runtimeErrors.length - 1];
    if (last && last.message === message && last.where === where) return;
    rec.runtimeErrors.push({ message, where: where || "", at: Date.now() });
    if (rec.runtimeErrors.length > KEEP_ERRORS) rec.runtimeErrors.shift();
    changed();
  }

  async function importModule(rec, fresh) {
    if (!rec.url) throw Error(rec.error || "The entry path is not valid.");
    // A cache-busting query re-reads the file after an edit or a failed import.
    const url = fresh || rec.importFailed ? `${rec.url}?v=${Date.now().toString(36)}` : rec.url;
    try {
      rec.module = await withTimeout(Promise.resolve().then(() => importer(url)), IMPORT_TIMEOUT, "The file took too long to load.");
      rec.importFailed = false;
    } catch (err) {
      rec.importFailed = true;
      rec.module = null;
      throw err;
    }
    rec.manifest = validateManifest(rec.module?.manifest, rec.id);
    return rec.module;
  }

  // Calls deactivate() if the mod started, then every recorded disposer.
  async function teardown(rec) {
    const { module, scope, api } = rec;
    rec.scope = null;
    rec.api = null;
    if (!scope) return;
    if (typeof module?.deactivate === "function") {
      try {
        await withTimeout(Promise.resolve().then(() => module.deactivate(api)), DEACTIVATE_TIMEOUT, "deactivate() took too long.");
      } catch (err) {
        console.error(`Mod "${rec.id}" deactivate():`, err);
      }
    }
    scope.dispose();
  }

  function fail(rec, err, { quiet }) {
    rec.status = "error";
    rec.error = errorText(err);
    console.error(`Mod "${rec.id}" could not start:`, err);
    if (!quiet) {
      ctx.ui?.toast?.(`Mod ${rec.manifest?.name || rec.id} could not start: ${rec.error}`, {
        kind: "error",
        action: { label: "Details", run: openModsTab },
      });
    }
  }

  async function start(rec, { fresh = false, quiet = false } = {}) {
    if (rec.status === "on") return true;
    rec.status = "loading";
    rec.error = null;
    changed();
    try {
      const mod = await importModule(rec, fresh);
      if (typeof mod.activate !== "function") throw Error("The mod needs an activate(api) function.");
      const scope = createScope();
      const api = buildModApi(ctx, rec.manifest, { scope, base: rec.url, onError: (err, where) => noteRuntimeError(rec, err, where) });
      rec.scope = scope;
      rec.api = api;
      const out = await withTimeout(Promise.resolve().then(() => mod.activate(api)), ACTIVATE_TIMEOUT, "activate() took too long.");
      if (typeof out === "function") scope.track(out);
      if (rec.scope !== scope) throw Error("The mod was turned off while it started.");
      rec.status = "on";
      return true;
    } catch (err) {
      await teardown(rec);
      fail(rec, err, { quiet });
      return false;
    } finally {
      changed();
    }
  }

  async function stop(rec) {
    await teardown(rec);
    rec.status = rec.url ? "off" : "error";
    if (rec.url) rec.error = null;
    changed();
    return true;
  }

  // Reads the manifest of a mod that is off, so Settings can show its name.
  async function probe(rec) {
    if (rec.manifest || !rec.url || rec.status !== "off") return;
    try {
      await importModule(rec, false);
    } catch (err) {
      rec.error = errorText(err);
      rec.status = "error";
    }
  }

  async function readIndex() {
    if (!fetchFn) return { mods: [], errors: ["This browser cannot read mods.json."] };
    let res;
    try {
      res = await fetchFn(new URL("mods.json", base).href, { cache: "no-store" });
    } catch (err) {
      return { mods: [], errors: [`mods.json could not be read: ${errorText(err)}`] };
    }
    if (res.status === 404) return { mods: [], errors: [] };
    if (!res.ok) return { mods: [], errors: [`mods.json could not be read (HTTP ${res.status}).`] };
    let json;
    try {
      json = await res.json();
    } catch {
      return { mods: [], errors: ["mods.json is not valid JSON."] };
    }
    return validateIndex(json);
  }

  // Remembers a theme added by a pack or mod, because the theme service falls
  // back to Signal when the saved theme does not exist yet at boot.
  function watchTheme() {
    const builtIn = new Set(THEMES.map((t) => t.id));
    return ctx.on?.("theme", ({ id } = {}) => {
      if (booting) return;
      ctx.prefs?.set("extraTheme", id && !builtIn.has(id) ? id : undefined);
    });
  }

  function restoreTheme() {
    const want = ctx.prefs?.get("extraTheme");
    if (!want || !ctx.themes?.get?.(want)) return;
    if (ctx.themes.current?.()?.id !== want) ctx.themes.apply(want);
  }

  const controller = {
    base,
    packs: null,
    // Safe mode: no mod runs this session.
    safeMode: !startMods,
    get errors() {
      return indexErrors.slice();
    },
    list: () => [...records.values()].map(info),
    get: (id) => (records.has(id) ? info(records.get(id)) : null),

    // Turns a mod on or off and remembers the choice. Resolves true when the
    // mod ended up in the requested state.
    setEnabled(id, on) {
      const rec = records.get(id);
      if (!rec) return Promise.resolve(false);
      ctx.prefs?.set("mods", { ...saved(), [id]: !!on });
      changed();
      return queue(rec, async () => {
        if (!on) return stop(rec);
        if (rec.status === "on" || !startMods) return true;
        // After an error, read the file again in case it was fixed.
        return start(rec, { fresh: rec.status === "error" });
      });
    },

    // Re-imports the entry file (picks up edits) and restarts the mod if it is on.
    reload(id) {
      const rec = records.get(id);
      if (!rec) return Promise.resolve(false);
      return queue(rec, async () => {
        const wasOn = rec.status === "on" || rec.status === "loading" || isEnabled(saved(), rec);
        await stop(rec);
        rec.manifest = null;
        if (!startMods) {
          changed();
          return true;
        }
        if (wasOn) return start(rec, { fresh: true });
        try {
          await importModule(rec, true);
        } catch (err) {
          rec.status = "error";
          rec.error = errorText(err);
        }
        changed();
        return rec.status !== "error";
      });
    },

    // Reads mods.json again: starts new mods, stops removed ones, and follows
    // a changed "enabled" default for mods the user has not switched themselves.
    async refresh() {
      const { mods, errors } = await readIndex();
      indexErrors = errors;
      const ids = new Set(mods.map((m) => m.id));
      for (const rec of [...records.values()]) {
        if (ids.has(rec.id)) continue;
        await queue(rec, () => stop(rec));
        records.delete(rec.id);
      }
      for (const m of mods) {
        const old = records.get(m.id);
        if (old && old.entry === m.entry) {
          const was = isEnabled(saved(), old);
          old.enabled = m.enabled;
          if (isEnabled(saved(), old) !== was) {
            // Checked again inside the queue: a toggle may have run in between.
            await queue(old, async () => {
              if (!isEnabled(saved(), old)) return old.status === "off" || stop(old);
              if (old.status === "on" || !old.url || !startMods) return true;
              return start(old, { fresh: old.status === "error" });
            });
          }
          continue;
        }
        if (old) {
          await queue(old, () => stop(old));
          records.delete(m.id);
        }
        const rec = makeRecord(m);
        records.set(m.id, rec);
        if (rec.url && startMods && isEnabled(saved(), rec)) await queue(rec, () => start(rec, { fresh: true }));
      }
      changed();
      return controller.list();
    },

    // Reads the manifests of mods that are off (imports without activating).
    async describe() {
      if (!startMods) return changed();
      await Promise.all([...records.values()].map((rec) => queue(rec, () => probe(rec))));
      changed();
    },
  };
  ctx.mods = controller;

  // Packs first, so their themes and presets exist before mods start.
  try {
    controller.packs = createPacks(ctx, { modsBase: base, kv: opts.kv });
    await controller.packs.restore();
  } catch (err) {
    console.error("Packs could not be restored.", err);
  }

  const index = await readIndex();
  indexErrors = index.errors;
  for (const m of index.mods) records.set(m.id, makeRecord(m));
  changed();

  const failed = [];
  for (const rec of records.values()) {
    if (!startMods || !isEnabled(saved(), rec)) continue;
    if (!rec.url) {
      failed.push(rec);
      continue;
    }
    const ok = await queue(rec, () => start(rec, { quiet: true }));
    if (!ok) failed.push(rec);
  }

  if (failed.length === 1) {
    const rec = failed[0];
    ctx.ui?.toast?.(`Mod ${rec.manifest?.name || rec.id} could not start: ${rec.error}`, {
      kind: "error",
      action: { label: "Details", run: openModsTab },
    });
  } else if (failed.length > 1) {
    ctx.ui?.toast?.(`${failed.length} mods could not start.`, { kind: "error", action: { label: "Details", run: openModsTab } });
  } else if (indexErrors.length && startMods) {
    ctx.ui?.toast?.("mods.json has a problem. Some mods were skipped.", { kind: "warn", action: { label: "Details", run: openModsTab } });
  }

  restoreTheme();
  booting = false;
  watchTheme();
  changed();
  return controller;
}
