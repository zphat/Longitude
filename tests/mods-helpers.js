// Shared fakes for the mods tests: an app context without a DOM.

import { createCommands, createRegistry } from "../web/js/app/context.js";
import { createThemes } from "../web/js/ui/theme.js";
import { createPresets } from "../web/js/features/presets.js";
import { Store } from "../web/js/core/store.js";
import { createDoc } from "../web/js/core/model.js";

export function fakePrefs(events, initial = {}) {
  const data = { ...initial };
  const prefs = {
    data,
    get: (k, f) => (Object.hasOwn(data, k) ? data[k] : f),
    set(k, v) {
      if (v === undefined) delete data[k];
      else data[k] = v;
      events.dispatchEvent(new CustomEvent("prefs", { detail: { key: k, value: v } }));
    },
    scoped: (p) => ({ get: (k, f) => prefs.get(`mod:${p}:${k}`, f), set: (k, v) => prefs.set(`mod:${p}:${k}`, v) }),
  };
  return prefs;
}

export function fakeFonts() {
  const fams = new Map();
  return {
    loads: [],
    get: (family) => fams.get(family) || null,
    list: () => [...fams.values()],
    load(family, weight) {
      this.loads.push([family, weight]);
      return Promise.resolve(true);
    },
    stack: (family) => `"${family}", sans-serif`,
    register(def) {
      if (fams.has(def.family)) throw Error(`fonts: "${def.family}" is already registered`);
      fams.set(def.family, { family: def.family, source: "mod", def });
      return () => fams.delete(def.family);
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

export function makeCtx({ prefs = {} } = {}) {
  const events = new EventTarget();
  const toasts = [];
  const ctx = {
    version: "0.1.0",
    events,
    prefs: fakePrefs(events, prefs),
    tools: createRegistry("tools"),
    inspector: createRegistry("inspector"),
    shapes: createRegistry("shapes"),
    filters: createRegistry("filters"),
    ui: {
      toasts,
      toast: (msg, opts) => toasts.push({ msg, ...(opts || {}) }),
    },
    emit(type, detail) {
      events.dispatchEvent(new CustomEvent(type, { detail }));
    },
    on(type, fn) {
      const l = (e) => fn(e.detail, e);
      events.addEventListener(type, l);
      return () => events.removeEventListener(type, l);
    },
  };
  ctx.commands = createCommands(ctx);
  ctx.themes = createThemes(ctx);
  ctx.presets = createPresets([]);
  ctx.fonts = fakeFonts();
  ctx.store = new Store(createDoc());
  const flashed = [];
  ctx.editor = { flashed, flash: (ids) => flashed.push(...ids), requestRender() {} };
  return ctx;
}

// An in-memory stand-in for the IndexedDB "kv" table.
export function memoryKv(initial = []) {
  const m = new Map(initial.map((r) => [r.k, structuredClone(r)]));
  return {
    map: m,
    get: async (k) => structuredClone(m.get(k)),
    put: async (rec) => {
      m.set(rec.k, structuredClone(rec));
    },
  };
}

export const tick = () => new Promise((r) => setTimeout(r, 0));
