// App context: registries, commands, prefs, events. Every module and every mod
// talks to the rest of Longitude through the object createContext() returns.

import { isMac, fieldOwnsCombo } from "../ui/dom.js";

export const VERSION = "0.1.1";
const ID_RE = /^[a-z][a-z0-9._-]{0,63}$/;

// A keyed list with change events. register() returns a dispose function.
export function createRegistry(name, { validate } = {}) {
  const items = new Map();
  const events = new EventTarget();
  const changed = () => events.dispatchEvent(new CustomEvent("change", { detail: { name } }));
  return {
    name,
    register(def) {
      if (!def || typeof def.id !== "string" || !ID_RE.test(def.id)) throw Error(`${name}: invalid id "${def?.id}"`);
      if (items.has(def.id)) throw Error(`${name}: "${def.id}" is already registered`);
      validate?.(def);
      items.set(def.id, def);
      changed();
      return () => {
        if (items.get(def.id) === def) {
          items.delete(def.id);
          changed();
        }
      };
    },
    get: (id) => items.get(id) || null,
    has: (id) => items.has(id),
    list: () => [...items.values()],
    onChange(fn) {
      events.addEventListener("change", fn);
      return () => events.removeEventListener("change", fn);
    },
  };
}

// ---- keys ---------------------------------------------------------------

const KEY_ALIASES = { " ": "Space", Esc: "Escape", Del: "Delete", "+": "=", Plus: "=" };

// Punctuation that shortcuts use, read from the key as printed (e.key), so
// "-" on a German keyboard zooms out instead of opening the palette. The
// shifted forms of "/" and "-" name the same key ("?" is Shift+/).
const BOUND_PUNCT = new Set(["-", "=", "/", "[", "]", ",", ".", ";", "'", "\\"]);
const SHIFTED_PUNCT = { "?": "/", _: "-" };

function keyName(e) {
  let k = typeof e.key === "string" ? e.key : "";
  if (KEY_ALIASES[k]) k = KEY_ALIASES[k];
  // Letters: the letter printed on the key, so Ctrl+Z is undo on QWERTZ and
  // AZERTY too. Non-Latin layouts (Cyrillic, Greek) fall back to the
  // physical key, so Ctrl+Z still works there.
  if (/^[a-z]$/i.test(k)) return k.toUpperCase();
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  // Digits: the physical key, so Shift+1 stays "1" (and AZERTY's Ctrl+0 works).
  if (/^Digit[0-9]$/.test(e.code)) return e.code.slice(5);
  if (BOUND_PUNCT.has(k)) return k;
  if (SHIFTED_PUNCT[k]) return SHIFTED_PUNCT[k];
  if (e.code === "BracketLeft") return "[";
  if (e.code === "BracketRight") return "]";
  if (e.code === "Equal" || e.code === "NumpadAdd") return "=";
  if (e.code === "Minus" || e.code === "NumpadSubtract") return "-";
  if (e.code === "Slash") return "/";
  if (e.code === "Comma") return ",";
  if (e.code === "Period") return ".";
  if (k.length === 1) return k.toUpperCase();
  return k;
}

// KeyboardEvent -> "Mod+Shift+K". "Mod" is Ctrl on Windows/Linux and Cmd on macOS.
export function normalizeEvent(e) {
  const parts = [];
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod) parts.push("Mod");
  if (isMac && e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  const k = keyName(e);
  if (!["Control", "Meta", "Alt", "Shift"].includes(k)) parts.push(k);
  return parts.join("+");
}

export function normalizeKeys(str) {
  const parts = str.split("+").map((p) => p.trim()).filter(Boolean);
  const key = parts.pop();
  const mods = new Set(parts.map((p) => (p === "Cmd" || p === "Meta" ? "Mod" : p === "Ctrl" && !isMac ? "Mod" : p)));
  const out = [];
  for (const m of ["Mod", "Ctrl", "Alt", "Shift"]) if (mods.has(m)) out.push(m);
  out.push(key.length === 1 ? key.toUpperCase() : KEY_ALIASES[key] || key);
  return out.join("+");
}

export function keysLabel(str) {
  if (!str) return "";
  return normalizeKeys(str)
    .split("+")
    .map((p) => {
      if (p === "Mod") return isMac ? "⌘" : "Ctrl";
      if (p === "Alt") return isMac ? "⌥" : "Alt";
      if (p === "Shift") return isMac ? "⇧" : "Shift";
      if (p === "ArrowUp") return "↑";
      if (p === "ArrowDown") return "↓";
      if (p === "ArrowLeft") return "←";
      if (p === "ArrowRight") return "→";
      if (p === "Escape") return "Esc";
      if (p === "Delete") return "Del";
      if (p === "=") return "+";
      return p;
    })
    .join(isMac ? "" : "+");
}

// ---- commands -----------------------------------------------------------

export function createCommands(ctx) {
  const reg = createRegistry("commands", {
    validate(def) {
      if (typeof def.run !== "function") throw Error(`commands: "${def.id}" needs run()`);
      if (typeof def.title !== "string" || !def.title.trim()) throw Error(`commands: "${def.id}" needs a title`);
    },
  });
  const enabled = (c) => {
    try {
      return !c.when || !!c.when(ctx);
    } catch {
      return false;
    }
  };
  return {
    register: reg.register,
    get: reg.get,
    list: reg.list,
    onChange: reg.onChange,
    enabled: (id) => {
      const c = reg.get(id);
      return !!c && enabled(c);
    },
    run(id, args) {
      const c = reg.get(id);
      if (!c) {
        console.warn(`Unknown command ${id}`);
        return undefined;
      }
      if (!enabled(c)) return undefined;
      try {
        const out = c.run(ctx, args);
        if (out && typeof out.catch === "function") {
          out.catch((err) => {
            console.error(err);
            ctx.ui?.toast?.(err.message || "That did not work.", { kind: "error" });
          });
        }
        ctx.events.dispatchEvent(new CustomEvent("command", { detail: { id } }));
        return out;
      } catch (err) {
        console.error(err);
        ctx.ui?.toast?.(err.message || "That did not work.", { kind: "error" });
        return undefined;
      }
    },
    // Find the enabled command bound to this keyboard event. Plain-letter
    // shortcuts are ignored while the user is typing in a field.
    match(e) {
      const combo = normalizeEvent(e);
      const typing = fieldOwnsCombo(combo, e.target);
      const plain = !/^(Mod|Ctrl|Alt)\+/.test(combo) && !/^F\d+$/.test(combo);
      for (const c of reg.list()) {
        if (!c.keys) continue;
        for (const k of c.keys) {
          if (normalizeKeys(k) !== combo) continue;
          if (typing && (plain || c.allowInFields !== true)) continue;
          if (enabled(c)) return c;
        }
      }
      return null;
    },
    keysLabel(id) {
      const c = reg.get(id);
      return c?.keys?.length ? keysLabel(c.keys[0]) : "";
    },
  };
}

// ---- prefs --------------------------------------------------------------

const PREFS_KEY = "longitude.prefs.v1";

export function createPrefs(events) {
  let data = {};
  try {
    data = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") || {};
  } catch {
    data = {};
  }
  let t = 0;
  const persist = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(data));
      } catch {}
    }, 150);
  };
  const prefs = {
    get(key, fallback) {
      return Object.hasOwn(data, key) ? data[key] : fallback;
    },
    set(key, value) {
      if (value === undefined) delete data[key];
      else data[key] = value;
      persist();
      events.dispatchEvent(new CustomEvent("prefs", { detail: { key, value } }));
    },
    // A namespaced view for one mod: keys become "mod:<id>:<key>".
    scoped(prefix) {
      return {
        get: (k, f) => prefs.get(`mod:${prefix}:${k}`, f),
        set: (k, v) => prefs.set(`mod:${prefix}:${k}`, v),
      };
    },
    flush() {
      clearTimeout(t);
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(data));
      } catch {}
    },
  };
  return prefs;
}

// ---- context ------------------------------------------------------------

export function createContext() {
  const events = new EventTarget();
  const ctx = {
    version: VERSION,
    events,
    prefs: createPrefs(events),
    tools: createRegistry("tools", {
      validate(def) {
        if (typeof def.label !== "string") throw Error(`tools: "${def.id}" needs a label`);
      },
    }),
    inspector: createRegistry("inspector", {
      validate(def) {
        if (typeof def.render !== "function" || typeof def.when !== "function")
          throw Error(`inspector: "${def.id}" needs when() and render()`);
      },
    }),
    ui: {},
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
  return ctx;
}
