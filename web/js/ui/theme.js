// UI themes. The colour keys match Latitude's theme packs exactly, so a
// Latitude pack (version 1) imports into Longitude unchanged. Themes colour the
// app, never the user's design.

export const COLOR_KEYS = ["bg", "panel", "panel2", "line", "text", "muted", "faint", "accent", "highlight", "ink", "green", "red", "amber"];

export const THEMES = [
  {
    id: "signal",
    name: "Signal",
    note: "Midnight graphite and electric lime",
    scheme: "dark",
    texture: "grain",
    colors: {
      bg: "#090b0d", panel: "#111517", panel2: "#1b2023", line: "#30383d",
      text: "#eef1ec", muted: "#a8b3b3", faint: "#8d9a9a",
      accent: "#d1ff4a", highlight: "#ffc56b", ink: "#16200d",
      green: "#a7d9a0", red: "#ff8f98", amber: "#eed09a",
    },
  },
  {
    id: "sundial",
    name: "Sundial",
    note: "Recessed black wells, acid and sun-gold",
    scheme: "dark",
    texture: "scan",
    colors: {
      bg: "#060706", panel: "#0f110f", panel2: "#181b18", line: "#2a302a",
      text: "#e9ece2", muted: "#9ba392", faint: "#7e8679",
      accent: "#d1ff4a", highlight: "#ffc56b", ink: "#0b0d06",
      green: "#b9e58c", red: "#ff6a7a", amber: "#ffc56b",
    },
  },
  {
    id: "latitude",
    name: "Golden latitude",
    note: "Ocean ink and sundial brass",
    scheme: "dark",
    texture: "grain",
    colors: {
      bg: "#0b1013", panel: "#121b20", panel2: "#1b2a30", line: "#34484f",
      text: "#f1ebdc", muted: "#b8c5c1", faint: "#a5b6b4",
      accent: "#e1ba76", highlight: "#efcf8e", ink: "#302b20",
      green: "#add2ac", red: "#ffa8a3", amber: "#e9c787",
    },
  },
  {
    id: "dusk",
    name: "Dusk",
    note: "A quiet, warm dark mode",
    scheme: "dark",
    texture: "grain",
    colors: {
      bg: "#100f14", panel: "#19171f", panel2: "#24212c", line: "#3d3748",
      text: "#eeeaf2", muted: "#b6b0bf", faint: "#a7a0b1",
      accent: "#cbbbe2", highlight: "#eac2ad", ink: "#2a2335",
      green: "#bdd7b2", red: "#f9a9b5", amber: "#e5c694",
    },
  },
  {
    id: "tide",
    name: "Tide",
    note: "Deep teal and warm coral",
    scheme: "dark",
    texture: "grain",
    colors: {
      bg: "#080e11", panel: "#101c21", panel2: "#192b32", line: "#31464e",
      text: "#e5efea", muted: "#b0c5c4", faint: "#9db5b5",
      accent: "#ffa990", highlight: "#ffd3a8", ink: "#24211b",
      green: "#a6dbb6", red: "#ffabac", amber: "#f2ca92",
    },
  },
  {
    id: "chalk",
    name: "Chalk",
    note: "Sundial's light theme",
    scheme: "light",
    texture: "grain",
    colors: {
      bg: "#e4e5da", panel: "#f7f7ef", panel2: "#ecede3", line: "#cdd1bf",
      text: "#15170f", muted: "#5d6452", faint: "#6b7362",
      accent: "#5e8200", highlight: "#b86e00", ink: "#f7f7ef",
      green: "#3f7a2a", red: "#c42b3b", amber: "#8a5a00",
    },
  },
  {
    id: "linen",
    name: "Linen",
    note: "Soft light, without the glare",
    scheme: "light",
    texture: "grain",
    colors: {
      bg: "#e9e7e0", panel: "#f4f1e9", panel2: "#dfddd6", line: "#c6c2b9",
      text: "#2d3535", muted: "#59625f", faint: "#626a67",
      accent: "#375b59", highlight: "#355e4b", ink: "#f8f6ee",
      green: "#306341", red: "#a02f48", amber: "#805c22",
    },
  },
];

const HEX = /^#[0-9a-f]{6}$/i;

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const rgba = (hex, a) => `rgba(${hexToRgb(hex).join(", ")}, ${a})`;

function mix(a, b, t) {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  const c = x.map((v, i) => Math.round(v + (y[i] - v) * t));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}

// Everything the CSS reads. Derived tokens keep packs down to 13 colours.
export function themeVars(theme) {
  const c = theme.colors;
  const dark = theme.scheme !== "light";
  return {
    "--bg": c.bg,
    "--panel": c.panel,
    "--panel2": c.panel2,
    "--line": c.line,
    "--text": c.text,
    "--muted": c.muted,
    "--faint": c.faint,
    "--accent": c.accent,
    "--highlight": c.highlight,
    "--ink": c.ink,
    "--green": c.green,
    "--red": c.red,
    "--amber": c.amber,
    "--workspace": dark ? mix(c.bg, "#000000", 0.25) : mix(c.bg, "#000000", 0.06),
    "--glass": rgba(c.panel, dark ? 0.78 : 0.82),
    "--glass-strong": rgba(c.panel, 0.96),
    "--line-soft": rgba(c.line, dark ? 0.7 : 0.8),
    "--hover": rgba(c.text, dark ? 0.06 : 0.05),
    "--active": rgba(c.text, dark ? 0.1 : 0.09),
    "--accent-soft": rgba(c.accent, dark ? 0.14 : 0.16),
    "--accent-line": rgba(c.accent, 0.45),
    "--highlight-soft": rgba(c.highlight, 0.16),
    "--red-soft": rgba(c.red, 0.14),
    "--shadow": dark ? "rgba(0, 0, 0, 0.55)" : "rgba(20, 23, 16, 0.16)",
    "--dot": rgba(c.text, dark ? 0.07 : 0.1),
    "--grain-op": dark ? "0.07" : "0.05",
    "--grain-blend": dark ? "screen" : "multiply",
    "--scan-op": theme.texture === "scan" ? (dark ? "0.025" : "0.03") : "0",
  };
}

export function validateTheme(t, i = 0) {
  const name = typeof t?.name === "string" ? t.name.trim().slice(0, 32) : "";
  if (!name) throw Error(`Theme ${i + 1} needs a name.`);
  const colors = {};
  for (const k of COLOR_KEYS) {
    if (!HEX.test(t?.colors?.[k] || "")) throw Error(`Theme ${i + 1}: ${k} must be a six-digit hex colour.`);
    colors[k] = t.colors[k].toLowerCase();
  }
  return {
    name,
    note: typeof t.note === "string" ? t.note.trim().slice(0, 100) : "",
    scheme: t.scheme === "light" ? "light" : "dark",
    texture: ["grain", "scan", "none"].includes(t.texture) ? t.texture : "grain",
    colors,
  };
}

// Accepts Latitude packs ({ version: 1, name, themes, templates }) and
// Longitude packs ({ version: 1, name, themes, presets, palettes }). Only the
// themes are read here; templates are Latitude-only and ignored.
export function validateThemePack(v) {
  if (!v || v.version !== 1) throw Error("Use a pack with version 1.");
  const name = typeof v.name === "string" ? v.name.trim().slice(0, 60) : "";
  if (!name) throw Error("This pack needs a name.");
  if (v.themes && !Array.isArray(v.themes)) throw Error("themes must be a list.");
  if ((v.themes?.length || 0) > 8) throw Error("A pack can hold up to eight themes.");
  return { name, themes: (v.themes || []).map(validateTheme) };
}

export function createThemes(ctx) {
  const extra = new Map();
  let currentId = ctx.prefs.get("theme", "signal");

  const list = () => [...THEMES, ...extra.values()];
  const get = (id) => list().find((t) => t.id === id) || null;

  function apply(id = currentId) {
    const theme = get(id) || THEMES[0];
    currentId = theme.id;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(themeVars(theme))) root.style.setProperty(k, v);
    root.dataset.theme = theme.id;
    root.dataset.scheme = theme.scheme;
    root.style.colorScheme = theme.scheme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme.colors.bg);
    ctx.prefs.set("theme", theme.id);
    ctx.emit?.("theme", { id: theme.id });
    return theme;
  }

  return {
    list,
    get,
    apply,
    current: () => get(currentId) || THEMES[0],
    // Mods and packs. Returns a dispose function.
    register(def) {
      const t = { ...validateTheme(def), id: def.id && /^[a-z][a-z0-9-]{1,40}$/.test(def.id) ? def.id : `custom-${extra.size}` };
      if (get(t.id)) throw Error(`Theme "${t.id}" already exists.`);
      extra.set(t.id, t);
      ctx.emit?.("themes", {});
      return () => {
        extra.delete(t.id);
        if (currentId === t.id) apply("signal");
        ctx.emit?.("themes", {});
      };
    },
    validatePack: validateThemePack,
  };
}
