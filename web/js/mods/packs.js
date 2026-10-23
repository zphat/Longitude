// JSON packs: themes (Latitude's format), size presets, colour palettes and
// fonts that point at files in web/mods/. Packs are data only and never run
// code. They are validated on import, kept in IndexedDB (database "longitude",
// store "kv", key "packs") and applied again on every boot by loadMods.

import { validateThemePack } from "../ui/theme.js";
import { normalizePreset } from "../features/presets.js";
import { CATEGORIES } from "../core/fonts.js";
import { table } from "../core/assets.js";
import { cleanModPath, defaultModsBase } from "./paths.js";

export const PACK_MAX_BYTES = 1_000_000;
export const PACK_LIMITS = Object.freeze({ themes: 8, presets: 24, palettes: 16, colors: 24, fonts: 16, faces: 8 });

const KV_KEY = "packs";
const FONT_EXTS = [".woff2", ".woff", ".ttf", ".otf"];
const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/;
const PACK_CATEGORIES = CATEGORIES.filter((c) => c !== "custom" && c !== "system");

const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function plural(n, word, many = `${word}s`) {
  return `${n} ${n === 1 ? word : many}`;
}

// "a, b and c"
export function listText(parts) {
  const p = parts.filter(Boolean);
  if (p.length < 2) return p[0] || "";
  return `${p.slice(0, -1).join(", ")} and ${p[p.length - 1]}`;
}

function slug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Stable id from the pack name, safe inside theme ids ("pk-<id>-1").
export function packId(name) {
  const s = slug(name).slice(0, 24).replace(/-+$/, "");
  if (/^[a-z]/.test(s)) return s;
  return `p-${s || "pack"}`.slice(0, 24).replace(/-+$/, "");
}

// "#abc" -> "#aabbcc"; keeps 6 and 8 digit colours; lowercase. Null if invalid.
export function normHex(c) {
  if (typeof c !== "string" || !COLOR_RE.test(c.trim())) return null;
  const v = c.trim().toLowerCase();
  if (v.length === 4) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return v;
}

function parsePresets(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw Error("presets must be a list.");
  if (list.length > PACK_LIMITS.presets) throw Error(`A pack can hold up to ${PACK_LIMITS.presets} presets.`);
  // The same validation presets.register() runs, then a plain copy for storage.
  return list.map((p) => structuredClone(normalizePreset({ ...p, source: "pack" }, { source: "mod" })));
}

function parsePalettes(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw Error("palettes must be a list.");
  if (list.length > PACK_LIMITS.palettes) throw Error(`A pack can hold up to ${PACK_LIMITS.palettes} palettes.`);
  return list.map((p, i) => {
    const name = text(p?.name, 40) || `Palette ${i + 1}`;
    if (!Array.isArray(p?.colors) || !p.colors.length) throw Error(`Palette "${name}" needs a list of colours.`);
    if (p.colors.length > PACK_LIMITS.colors) throw Error(`Palette "${name}" can hold up to ${PACK_LIMITS.colors} colours.`);
    const colors = p.colors.map((c) => {
      const hex = normHex(c);
      if (!hex) throw Error(`Palette "${name}": "${String(c).slice(0, 20)}" is not a hex colour like #ff2d2d.`);
      return hex;
    });
    return { name, colors };
  });
}

function parseFonts(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw Error("fonts must be a list.");
  if (list.length > PACK_LIMITS.fonts) throw Error(`A pack can hold up to ${PACK_LIMITS.fonts} fonts.`);
  return list.map((f, i) => {
    const family = text(f?.family, 60);
    if (!FAMILY_RE.test(family)) throw Error(`Font ${i + 1} needs a family name made of letters, digits, spaces, dots or dashes.`);
    if (!Array.isArray(f.faces) || !f.faces.length) throw Error(`Font "${family}" needs at least one face.`);
    if (f.faces.length > PACK_LIMITS.faces) throw Error(`Font "${family}" can have up to ${PACK_LIMITS.faces} faces.`);
    const faces = f.faces.map((x) => {
      const w = Math.round(Number(x?.weight ?? 400));
      return {
        file: cleanModPath(x?.file, { exts: FONT_EXTS, what: "font file" }),
        weight: Number.isFinite(w) ? Math.min(1000, Math.max(1, w)) : 400,
        style: x?.style === "italic" ? "italic" : "normal",
      };
    });
    return {
      family,
      label: text(f.label, 60) || family,
      category: PACK_CATEGORIES.includes(f.category) ? f.category : "display",
      fallback: text(f.fallback, 120).replace(/[;{}<>\\]/g, "") || "sans-serif",
      license: text(f.license, 60),
      credit: text(f.credit, 120),
      sample: text(f.sample, 40),
      tags: Array.isArray(f.tags) ? f.tags.filter((t) => typeof t === "string").map((t) => t.trim().slice(0, 30)).slice(0, 12) : [],
      faces,
    };
  });
}

// Validates a pack object. Accepts Latitude theme packs ({ version: 1, name,
// themes, templates }) and Longitude packs ({ version: 1, name, author?,
// description?, themes?, presets?, palettes?, fonts? }). Throws a plain Error.
// The result is itself a valid pack, so stored packs are parsed again on boot.
export function parsePack(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("A pack is a JSON object with a version and a name.");
  const { name, themes } = validateThemePack(raw);
  const presets = parsePresets(raw.presets);
  const palettes = parsePalettes(raw.palettes);
  const fonts = parseFonts(raw.fonts);
  if (!themes.length && !presets.length && !palettes.length && !fonts.length) {
    throw Error("This pack is empty. Add themes, presets, palettes or fonts.");
  }
  const notes = [];
  if (Array.isArray(raw.templates) && raw.templates.length) {
    notes.push(`${plural(raw.templates.length, "Latitude template")} skipped. Longitude uses the themes.`);
  }
  return {
    version: 1,
    id: packId(name),
    name,
    author: text(raw.author, 60),
    description: text(raw.description, 300),
    themes,
    presets,
    palettes,
    fonts,
    notes,
  };
}

// File, Blob, JSON text or a plain object -> plain object. Throws a plain Error.
export async function readPack(input) {
  let source = input;
  if (input && typeof input === "object" && typeof input.text === "function") {
    if (input.size > PACK_MAX_BYTES) throw Error("This pack is larger than 1 MB.");
    source = await input.text();
  }
  if (typeof source === "string") {
    if (source.length > PACK_MAX_BYTES) throw Error("This pack is larger than 1 MB.");
    try {
      return JSON.parse(source);
    } catch {
      throw Error("This file is not valid JSON.");
    }
  }
  if (source && typeof source === "object") {
    // A round trip through JSON keeps data and drops anything executable.
    const json = JSON.stringify(source);
    if (json.length > PACK_MAX_BYTES) throw Error("This pack is larger than 1 MB.");
    return JSON.parse(json);
  }
  throw Error("Choose a pack file (.json).");
}

export function packCounts(pack) {
  return {
    themes: pack?.themes?.length || 0,
    presets: pack?.presets?.length || 0,
    palettes: pack?.palettes?.length || 0,
    fonts: pack?.fonts?.length || 0,
  };
}

// "2 themes, 3 size presets and 1 colour palette"
export function countsText(counts) {
  return listText([
    counts.themes && plural(counts.themes, "theme"),
    counts.presets && plural(counts.presets, "size preset"),
    counts.palettes && plural(counts.palettes, "colour palette"),
    counts.fonts && plural(counts.fonts, "font"),
  ]);
}

// One paragraph for a confirm dialog.
export function summaryText(preview) {
  const parts = [`Adds ${countsText(packCounts(preview.pack))}.`];
  if (preview.replaces) parts.push("It replaces the installed pack with the same name.");
  for (const s of preview.skipped) parts.push(s);
  for (const n of preview.pack.notes || []) parts.push(n);
  parts.push("Packs are plain data and never run code.");
  return parts.join(" ");
}

export function createPacks(ctx, { modsBase = defaultModsBase(), kv = table("kv") } = {}) {
  let records = []; // [{ id, added, pack }]
  const applied = new Map(); // id -> { offs: fn[], skipped: string[], themeIds: string[] }

  const emit = () => {
    ctx.emit?.("packs", {});
    ctx.emit?.("mods", {});
  };

  async function readStored() {
    try {
      const rec = await kv.get(KV_KEY);
      return Array.isArray(rec?.packs) ? rec.packs : [];
    } catch (err) {
      console.warn("Packs: could not read stored packs.", err);
      return [];
    }
  }

  async function writeStored(list = records) {
    await kv.put({ k: KV_KEY, v: 1, packs: list.map(({ id, added, pack }) => ({ id, added, pack })) });
  }

  // add() and remove() store the new list before they change the app, so a
  // failed write (storage full) changes nothing. Running them one at a time
  // keeps each new list based on the one before it.
  let chain = Promise.resolve();
  function serial(task) {
    const run = chain.then(task, task);
    chain = run.catch(() => {});
    return run;
  }

  // What would not apply because something else already uses the name.
  function conflicts(pack, ignoreId = pack.id) {
    const skipped = [];
    const own = applied.get(ignoreId);
    const ownPresets = new Set(records.find((r) => r.id === ignoreId)?.pack.presets.map((p) => p.id) || []);
    const ownFonts = new Set(records.find((r) => r.id === ignoreId)?.pack.fonts.map((f) => f.family.toLowerCase()) || []);
    for (const p of pack.presets) {
      if (ctx.presets?.has?.(p.id) && !(own && ownPresets.has(p.id))) skipped.push(`The preset "${p.label}" is skipped: one with the id "${p.id}" already exists.`);
    }
    for (const f of pack.fonts) {
      if (ctx.fonts?.get?.(f.family) && !(own && ownFonts.has(f.family.toLowerCase()))) skipped.push(`The font "${f.family}" is skipped: a font with that name already exists.`);
    }
    return skipped;
  }

  function apply(rec) {
    const { pack } = rec;
    const offs = [];
    const skipped = [];
    const themeIds = [];
    const attempt = (what, fn) => {
      try {
        const off = fn();
        if (typeof off === "function") offs.push(off);
        return true;
      } catch (err) {
        skipped.push(`${what}: ${err.message}`);
        return false;
      }
    };
    pack.themes.forEach((t, i) => {
      const id = `pk-${pack.id}-${i + 1}`;
      if (ctx.themes && attempt(`Theme "${t.name}"`, () => ctx.themes.register({ ...t, id }))) themeIds.push(id);
    });
    if (ctx.presets) for (const p of pack.presets) attempt(`Preset "${p.label}"`, () => ctx.presets.register({ ...p, source: "pack" }));
    if (ctx.fonts) {
      for (const f of pack.fonts) {
        attempt(`Font "${f.family}"`, () =>
          ctx.fonts.register({ ...f, base: modsBase, faces: f.faces.map((x) => ({ url: x.file, weight: x.weight, style: x.style })) })
        );
      }
    }
    applied.set(rec.id, { offs, skipped, themeIds });
  }

  function unapply(id) {
    const a = applied.get(id);
    if (!a) return;
    applied.delete(id);
    for (const off of a.offs.reverse()) {
      try {
        off();
      } catch (err) {
        console.error(err);
      }
    }
  }

  // prefs "palettes": the colour picker's list. Entries with a "pack" field
  // belong to packs and are rebuilt here; anything else is left alone.
  function syncPalettes() {
    if (!ctx.prefs) return;
    const current = ctx.prefs.get("palettes", []);
    const keep = Array.isArray(current) ? current.filter((p) => p && !p.pack) : [];
    const fromPacks = records.flatMap((r) =>
      r.pack.palettes.map((p, i) => ({ id: `pk-${r.id}-${i + 1}`, name: p.name, colors: p.colors.slice(), pack: r.id }))
    );
    const next = [...keep, ...fromPacks];
    if (JSON.stringify(next) !== JSON.stringify(current)) ctx.prefs.set("palettes", next);
  }

  function info(rec) {
    const a = applied.get(rec.id);
    return {
      id: rec.id,
      name: rec.pack.name,
      author: rec.pack.author,
      description: rec.pack.description,
      added: rec.added,
      counts: packCounts(rec.pack),
      themes: rec.pack.themes,
      themeIds: a?.themeIds.slice() || [],
      skipped: a?.skipped.slice() || [],
    };
  }

  const service = {
    // Loads stored packs and applies them. Bad entries are skipped.
    async restore() {
      for (const id of [...applied.keys()]) unapply(id);
      records = [];
      const seen = new Set();
      for (const r of await readStored()) {
        try {
          const pack = parsePack(r?.pack);
          if (seen.has(pack.id)) continue;
          seen.add(pack.id);
          records.push({ id: pack.id, added: Number(r.added) || Date.now(), pack });
        } catch (err) {
          console.warn(`Packs: skipped a stored pack (${err.message}).`);
        }
      }
      for (const r of records) apply(r);
      syncPalettes();
      emit();
      return service.list();
    },

    list: () => records.map(info),
    get: (id) => {
      const r = records.find((x) => x.id === id);
      return r ? info(r) : null;
    },

    // File, Blob, JSON text or object -> { pack, replaces, skipped }. Throws a plain Error.
    async preview(input) {
      const pack = parsePack(await readPack(input));
      return { pack, replaces: records.some((r) => r.id === pack.id), skipped: conflicts(pack) };
    },

    // Stores and applies a parsed pack (from preview().pack). Replaces a pack with the same id.
    add: (pack) =>
      serial(async () => {
        const parsed = parsePack(pack);
        const rec = { id: parsed.id, added: Date.now(), pack: parsed };
        const next = [...records.filter((r) => r.id !== parsed.id), rec];
        await writeStored(next);
        try {
          const old = records.find((r) => r.id === parsed.id);
          const wasTheme = ctx.themes?.current?.()?.id;
          const usedOwnTheme = old && applied.get(old.id)?.themeIds.includes(wasTheme);
          if (old) unapply(old.id);
          records = next;
          apply(rec);
          syncPalettes();
          if (usedOwnTheme && ctx.themes?.get?.(wasTheme)) ctx.themes.apply(wasTheme);
        } finally {
          emit();
        }
        return info(rec);
      }),

    remove: (id) =>
      serial(async () => {
        const rec = records.find((r) => r.id === id);
        if (!rec) return false;
        const next = records.filter((r) => r !== rec);
        await writeStored(next);
        try {
          unapply(id);
          records = next;
          syncPalettes();
        } finally {
          emit();
        }
        return true;
      }),

    // Read, validate, review, then add. review(preview) -> Promise<bool>; the
    // default asks with ctx.ui.confirm. Resolves to the pack info, or null if
    // the user said no.
    async importPack(input, { review } = {}) {
      const preview = await service.preview(input);
      const ok = review ? await review(preview) : await defaultReview(ctx, preview);
      if (!ok) return null;
      return service.add(preview.pack);
    },
  };
  return service;
}

async function defaultReview(ctx, preview) {
  if (typeof ctx.ui?.confirm !== "function") return true;
  return ctx.ui.confirm({
    title: `Add the pack "${preview.pack.name}"?`,
    message: summaryText(preview),
    ok: preview.replaces ? "Replace pack" : "Add pack",
    cancel: "Cancel",
  });
}

// Convenience for other modules: ctx.mods.packs.importPack with the default review.
export function importPack(ctx, input, opts) {
  const packs = ctx?.mods?.packs;
  if (!packs) return Promise.reject(Error("Packs are still loading. Try again in a moment."));
  return packs.importPack(input, opts);
}
