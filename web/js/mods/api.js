// The object a code mod receives in activate(api). It is a thin, frozen layer
// over the app context: every register() is tracked so turning a mod off
// removes everything it added, and mod callbacks are wrapped so a broken mod
// reports its error instead of breaking the editor. This is a lifecycle
// contract for trusted local code, not a sandbox (see docs/MODDING.md).

import { h, svg } from "../ui/dom.js";
import * as controlsModule from "../ui/controls.js";
import { icon, registerIcons, hasIcon } from "../ui/icons.js";
import { polygonPath, polygonOutline, shapeParams } from "../core/shapes.js";
import { filterDefaults } from "../core/filters.js";

export const API_VERSION = 1;

const THEME_ID_RE = /^[a-z][a-z0-9-]{1,40}$/;
const controls = Object.freeze({ ...controlsModule });
const iconOwners = new Map(); // icon name -> mod id that registered it
const scopes = new WeakMap(); // api -> scope

// A list of disposers. track() returns an idempotent function that runs the
// disposer once and forgets it; dispose() runs everything left, newest first,
// and closes the scope so later registrations fail loudly.
export function createScope() {
  const live = new Set();
  const counts = {};
  let closed = false;
  const scope = {
    get closed() {
      return closed;
    },
    get size() {
      return live.size;
    },
    // How many things of each kind are registered now: { commands: 2, shapes: 4 }.
    counts() {
      const out = {};
      for (const [k, n] of Object.entries(counts)) if (n > 0) out[k] = n;
      return out;
    },
    track(fn, kind = null) {
      if (typeof fn !== "function") return () => {};
      let done = false;
      if (kind) counts[kind] = (counts[kind] || 0) + 1;
      const once = () => {
        if (done) return;
        done = true;
        live.delete(once);
        if (kind) counts[kind]--;
        try {
          fn();
        } catch (err) {
          console.error(err);
        }
      };
      live.add(once);
      return once;
    },
    // Runs register() only while the scope is open and tracks what it returns.
    add(register, kind = null) {
      if (closed) throw Error("This mod is turned off.");
      return scope.track(register(), kind);
    },
    dispose() {
      closed = true;
      for (const fn of [...live].reverse()) fn();
    },
  };
  return scope;
}

// The scope behind an api object (the loader and tests use it to dispose).
export function scopeOf(api) {
  return scopes.get(api) || null;
}

const slug = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const STORE_READS = ["get", "index", "layers", "selected", "historyLabels", "referencedAssets"];
const STORE_WRITES = [
  "add", "patch", "update", "remove", "setDocProps", "duplicate", "move", "forward", "backward", "toFront", "toBack",
  "select", "clearSelection", "selectAll", "undo", "redo", "remeasure",
];
const EDITOR_METHODS = [
  "requestRender", "setTool", "flash", "docToScreen", "screenToDoc", "zoomToFit", "zoomToActual", "setZoom", "zoomBy",
  "importFiles", "startTextEdit", "stopTextEdit", "startCrop", "setOverlay",
];
const ASSET_METHODS = ["addBlob", "addCanvas", "getBlob", "getImage", "loadImage", "info", "has", "toDataURL", "fromDataURL"];
const TOOL_CALLBACKS = ["activate", "deactivate", "pointerDown", "pointerMove", "pointerUp", "keyDown", "drawOverlay"];

// buildModApi(ctx, manifest, { scope, base, onError })
//   scope    createScope() result; the loader disposes it on deactivate
//   base     URL of the mod's entry module; relative font and asset URLs resolve against it
//   onError  (err, where) called when a wrapped mod callback throws
export function buildModApi(ctx, manifest, { scope = createScope(), base = null, onError = null } = {}) {
  const modId = manifest?.id;
  if (typeof modId !== "string" || !modId) throw Error("buildModApi needs a manifest with an id.");
  let openGestures = 0;
  let api = null;

  const report = (err, where) => {
    console.error(`Mod "${modId}"${where ? ` (${where})` : ""}:`, err);
    try {
      onError?.(err, where);
    } catch {}
  };
  const need = (key, label) => {
    const s = ctx[key];
    if (!s) throw Error(`${label} is not available yet.`);
    return s;
  };
  // Wraps a mod callback: errors are reported and the fallback is returned.
  const guard = (fn, where, fallback) =>
    function guarded(...args) {
      try {
        return fn.apply(this, args);
      } catch (err) {
        report(err, where);
        return typeof fallback === "function" ? fallback(...args) : fallback;
      }
    };
  const unwind = (depth) => {
    while (openGestures > depth) {
      openGestures--;
      try {
        ctx.store?.cancel();
      } catch (err) {
        console.error(err);
      }
    }
  };
  // Runs a command body: a throw (sync or async) cancels any gesture the mod
  // left open, is reported, and is rethrown so the command registry shows it.
  const runGuarded = (fn, where) => {
    const depth = openGestures;
    const fail = (err) => {
      unwind(depth);
      report(err, where);
      throw err;
    };
    let out;
    try {
      out = fn();
    } catch (err) {
      fail(err);
    }
    return out && typeof out.then === "function" ? out.then(undefined, fail) : out;
  };
  const resolveUrl = (path) => {
    try {
      return new URL(path, base || globalThis.document?.baseURI || globalThis.location?.href).href;
    } catch {
      return String(path);
    }
  };

  scope.track(() => unwind(0));

  // ---- registries -----------------------------------------------------------

  const commands = Object.freeze({
    register(def) {
      if (!def || typeof def.run !== "function") throw Error("commands.register needs a run() function.");
      const where = `command ${def.id}`;
      const wrapped = {
        ...def,
        mod: modId,
        run: (_ctx, args) => runGuarded(() => def.run(api, args), where),
        when: typeof def.when === "function"
          ? () => {
              try {
                return !!def.when(api);
              } catch {
                return false;
              }
            }
          : undefined,
      };
      return scope.add(() => need("commands", "Commands").register(wrapped), "commands");
    },
    run: (id, args) => need("commands", "Commands").run(id, args),
    get: (id) => ctx.commands?.get(id) || null,
    list: () => ctx.commands?.list() || [],
    enabled: (id) => !!ctx.commands?.enabled?.(id),
    keysLabel: (id) => ctx.commands?.keysLabel(id) || "",
  });

  const tools = Object.freeze({
    register(def) {
      if (!def || typeof def !== "object") throw Error("tools.register needs a tool definition.");
      const wrapped = { ...def, mod: modId };
      for (const k of TOOL_CALLBACKS) {
        if (typeof def[k] === "function") wrapped[k] = guard(def[k], `tool ${def.id} ${k}`, k === "keyDown" ? false : undefined);
      }
      return scope.add(() => need("tools", "Tools").register(wrapped), "tools");
    },
    get: (id) => ctx.tools?.get(id) || null,
    list: () => ctx.tools?.list() || [],
  });

  const inspector = Object.freeze({
    register(def) {
      if (!def || typeof def.render !== "function" || typeof def.when !== "function") {
        throw Error("inspector.register needs when() and render().");
      }
      const where = `inspector ${def.id}`;
      const wrapped = {
        ...def,
        mod: modId,
        when: (layers) => {
          try {
            return !!def.when(layers, api);
          } catch (err) {
            report(err, where);
            return false;
          }
        },
        // render may return a cleanup function or { update(layers, api), destroy() }.
        render: (body, layers) => {
          try {
            const out = def.render(body, layers, api);
            if (typeof out === "function") return guard(out, `${where} cleanup`);
            if (out && typeof out === "object") {
              const handle = {};
              if (typeof out.update === "function") handle.update = guard((next) => out.update(next, api), `${where} update`);
              if (typeof out.destroy === "function") handle.destroy = guard(() => out.destroy(), `${where} cleanup`);
              return handle;
            }
            return undefined;
          } catch (err) {
            report(err, where);
            try {
              body?.append?.(h("p", { class: "mod-section-error" }, "This section could not load. Check the mod in Settings."));
            } catch {}
            return undefined;
          }
        },
      };
      return scope.add(() => need("inspector", "The inspector").register(wrapped), "inspector");
    },
    list: () => ctx.inspector?.list() || [],
  });

  const shapes = Object.freeze({
    register(def) {
      if (!def || typeof def.path !== "function") throw Error("shapes.register needs a path() function.");
      const rect = (w, hh) => [
        { x: -w / 2, y: -hh / 2 },
        { x: w / 2, y: -hh / 2 },
        { x: w / 2, y: hh / 2 },
        { x: -w / 2, y: hh / 2 },
      ];
      const wrapped = {
        ...def,
        mod: modId,
        path: guard(def.path, `shape ${def.id}`, (w, hh) => polygonPath(rect(w, hh))),
      };
      if (typeof def.outline === "function") wrapped.outline = guard(def.outline, `shape ${def.id} outline`, rect);
      return scope.add(() => need("shapes", "Shapes").register(wrapped), "shapes");
    },
    get: (id) => ctx.shapes?.get(id) || null,
    list: () => ctx.shapes?.list() || [],
    // Helpers from core/shapes.js so mod shapes match the built-ins.
    polygonPath,
    polygonOutline,
    params: shapeParams,
  });

  const filters = Object.freeze({
    register(def) {
      if (!def || typeof def.apply !== "function") throw Error("filters.register needs an apply() function.");
      const wrapped = { ...def, mod: modId, apply: guard(def.apply, `filter ${def.id}`, (img) => img) };
      return scope.add(() => need("filters", "Filters").register(wrapped), "filters");
    },
    get: (id) => ctx.filters?.get(id) || null,
    list: () => ctx.filters?.list() || [],
    defaults: (idOrDef) => filterDefaults(typeof idOrDef === "string" ? ctx.filters?.get(idOrDef) : idOrDef),
  });

  const presets = Object.freeze({
    register: (def) => scope.add(() => need("presets", "Presets").register(def), "presets"),
    get: (id) => ctx.presets?.get(id) || null,
    list: () => ctx.presets?.list() || [],
    groups: () => ctx.presets?.groups() || [],
  });

  const fonts = Object.freeze({
    // Relative face URLs resolve against the mod's own folder.
    register: (def) => scope.add(() => need("fonts", "Fonts").register({ base: base || undefined, ...def }), "fonts"),
    get: (family) => ctx.fonts?.get(family) || null,
    list: () => ctx.fonts?.list() || [],
    load: (family, weight, style) => (ctx.fonts ? ctx.fonts.load(family, weight, style) : Promise.resolve(false)),
    stack: (family) => (ctx.fonts ? ctx.fonts.stack(family) : `"${family}", sans-serif`),
    on(type, fn) {
      return scope.add(() => {
        const target = need("fonts", "Fonts");
        const l = guard((e) => fn(e.detail, e), `fonts ${type} listener`);
        target.addEventListener(type, l);
        return () => target.removeEventListener(type, l);
      });
    },
  });

  const themes = Object.freeze({
    register(def) {
      const id = def?.id && THEME_ID_RE.test(def.id) ? def.id : `${modId}-${slug(def?.name) || "theme"}`.slice(0, 41).replace(/-+$/, "");
      return scope.add(() => need("themes", "Themes").register({ ...def, id }), "themes");
    },
    list: () => ctx.themes?.list() || [],
    current: () => ctx.themes?.current() || null,
    apply: (id) => need("themes", "Themes").apply(id),
  });

  const bgProviders = Object.freeze({
    register: (def) => scope.add(() => need("bg", "Background removal").providers.register({ ...def, mod: modId }), "bg"),
    get: (id) => ctx.bg?.providers.get(id) || null,
    list: () => ctx.bg?.providers.list() || [],
  });
  const bg = Object.freeze({
    providers: bgProviders,
    // The live config object (model and runtime URLs). Change it before the first removal.
    get config() {
      return ctx.bg?.config || null;
    },
    get masks() {
      return ctx.bg?.masks || null;
    },
    get defaultProvider() {
      return ctx.bg?.defaultProvider || null;
    },
    removeLayerBackground: (layerId, opts) => need("bg", "Background removal").removeLayerBackground(layerId, opts),
    removeFromImage: (source, opts) => need("bg", "Background removal").removeFromImage(source, opts),
    restoreLayer: (layerId) => need("bg", "Background removal").restoreLayer(layerId),
  });

  // ---- document, assets, editor ---------------------------------------------

  const store = (() => {
    const s = () => need("store", "The document");
    const o = {
      get doc() {
        return s().doc;
      },
      get selection() {
        return s().selection;
      },
      get inGesture() {
        return s().inGesture;
      },
      get canUndo() {
        return s().canUndo;
      },
      get canRedo() {
        return s().canRedo;
      },
    };
    for (const m of [...STORE_READS, ...STORE_WRITES]) o[m] = (...args) => s()[m](...args);
    o.begin = (label) => {
      const out = s().begin(label);
      openGestures++;
      return out;
    };
    o.commit = () => {
      if (openGestures > 0) openGestures--;
      return s().commit();
    };
    o.cancel = () => {
      if (openGestures > 0) openGestures--;
      return s().cancel();
    };
    // Several changes as one undo step. fn may be async; a throw cancels.
    o.transaction = (label, fn) => {
      o.begin(label);
      const end = (ok) => (ok ? o.commit() : o.cancel());
      let out;
      try {
        out = fn(o);
      } catch (err) {
        end(false);
        throw err;
      }
      if (out && typeof out.then === "function") {
        return out.then(
          (v) => {
            end(true);
            return v;
          },
          (err) => {
            end(false);
            throw err;
          }
        );
      }
      end(true);
      return out;
    };
    o.on = (type, fn) =>
      scope.add(() => {
        const target = s();
        const l = guard((e) => fn(e.detail, e), `store ${type} listener`);
        target.addEventListener(type, l);
        return () => target.removeEventListener(type, l);
      });
    o.addNormalizer = (fn) => scope.add(() => s().addNormalizer(guard(fn, "normalizer", undefined)));
    return Object.freeze(o);
  })();

  const assets = Object.freeze(Object.fromEntries(ASSET_METHODS.map((m) => [m, (...args) => need("assets", "Images")[m](...args)])));

  const editor = (() => {
    const o = {
      get available() {
        return !!ctx.editor;
      },
      get tool() {
        return ctx.editor?.tool ?? null;
      },
      get zoom() {
        return ctx.editor?.zoom ?? 1;
      },
      get canvas() {
        return ctx.editor?.canvas ?? null;
      },
    };
    // Calls are skipped quietly before the editor exists.
    for (const m of EDITOR_METHODS) o[m] = (...args) => ctx.editor?.[m]?.(...args);
    return Object.freeze(o);
  })();

  // ---- ui, events, prefs -------------------------------------------------------

  const closer = (handle) => {
    if (handle && typeof handle.close === "function") scope.track(() => handle.close());
    return handle;
  };
  const ui = Object.freeze({
    toast: (msg, opts) => ctx.ui?.toast?.(msg, opts),
    dialog(opts) {
      if (typeof ctx.ui?.dialog !== "function") throw Error("Dialogs are not available yet.");
      return closer(ctx.ui.dialog(opts));
    },
    confirm: (opts) => (ctx.ui?.confirm ? ctx.ui.confirm(opts) : Promise.resolve(false)),
    prompt: (opts) => (ctx.ui?.prompt ? ctx.ui.prompt(opts) : Promise.resolve(null)),
    menu: (items, opts) => closer(ctx.ui?.menu?.(items, opts)),
    popover: (anchor, content, opts) => closer(ctx.ui?.popover?.(anchor, content, opts)),
  });

  const events = Object.freeze({
    on(type, fn) {
      return scope.add(() => ctx.on(type, guard(fn, `${type} listener`)));
    },
    emit: (type, detail) => ctx.emit(type, detail),
  });

  const scoped = ctx.prefs.scoped(modId);
  const prefs = Object.freeze({
    get: (key, fallback) => scoped.get(key, fallback),
    set: (key, value) => scoped.set(key, value),
    remove: (key) => scoped.set(key, undefined),
  });

  // Icons stay registered after a mod turns off (they are only strings), but a
  // mod cannot replace an icon the app or another mod already uses.
  function addIcons(map) {
    const mine = {};
    for (const [name, body] of Object.entries(map || {})) {
      if (typeof body !== "string") continue;
      const owner = iconOwners.get(name);
      if (hasIcon(name) && owner !== modId) {
        console.warn(`Mod "${modId}": the icon "${name}" already exists, so it was not replaced.`);
        continue;
      }
      iconOwners.set(name, modId);
      mine[name] = body;
    }
    registerIcons(mine);
  }

  function addStyles(css) {
    return scope.add(() => {
      const el = globalThis.document?.createElement("style");
      if (!el) return () => {};
      el.dataset.mod = modId;
      el.textContent = String(css || "");
      globalThis.document.head.append(el);
      return () => el.remove();
    });
  }

  api = Object.freeze({
    apiVersion: API_VERSION,
    appVersion: ctx.version,
    id: modId,
    manifest: Object.freeze({ ...manifest }),
    commands,
    tools,
    inspector,
    shapes,
    filters,
    presets,
    fonts,
    themes,
    bg,
    store,
    assets,
    editor,
    ui,
    events,
    prefs,
    h,
    svg,
    controls,
    icon,
    registerIcons: addIcons,
    addStyles,
    url: resolveUrl,
    onDispose: (fn) => scope.track(fn),
  });
  scopes.set(api, scope);
  return api;
}
