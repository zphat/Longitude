// Font registry. Knows every family Longitude can draw with: the bundled ones
// listed in fonts/fonts.json, a few system fonts (offered only when installed),
// font files the user adds (kept in IndexedDB) and fonts registered by mods.
// Faces load lazily through FontFace, once each, and announce themselves with
// a 'load' event so text can be measured again.

export const CATEGORIES = ["original", "classic", "meme", "display", "clean", "system", "custom"];
export const CATEGORY_LABELS = {
  original: "Original",
  classic: "Classics",
  meme: "Meme",
  display: "Display",
  clean: "Clean",
  system: "System",
  custom: "Yours",
};

const FACE_TIMEOUT = 3000;
// A face that failed to load (offline, a mod's 404) is retried at once, then
// after 1, 2, 4 … seconds, at most every RETRY_MAX ms, so a repaint loop does
// not fetch and warn on every frame. Explicit retries and going online skip it.
const RETRY_MAX = 30000;
const retryDelay = (failures) => (failures <= 1 ? 0 : Math.min(RETRY_MAX, 1000 * 2 ** (failures - 2)));
const MAX_FONT_BYTES = 40 * 1024 * 1024;
const DB_NAME = "longitude";
const DB_VERSION = 1;
const DB_STORES = { assets: "id", projects: "id", fonts: "family", kv: "k" };
const GENERIC = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "math", "emoji", "fangsong",
  "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded",
]);
// UI fonts: a user file with one of these names would restyle the app itself.
const RESERVED = new Set(["manrope", "syne", "space mono"]);
const PROBE_TEXT = "WAIT WHAT mmmmmmmmmmlli 0123456789 @#&";
const MIME = { ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2" };

// ---- small pure helpers ---------------------------------------------------

const keyOf = (family) => String(family || "").trim().toLowerCase();
const isItalic = (style) => style === "italic" || style === "oblique";
const normStyle = (style) => (isItalic(style) ? "italic" : "normal");
const clampWeight = (w) => Math.min(1000, Math.max(1, Math.round(Number(w) || 400)));

// CSS font-family value for one name: generic keywords stay bare, others are quoted.
export function quoteFamily(name) {
  const n = String(name).trim();
  if (GENERIC.has(n.toLowerCase())) return n.toLowerCase();
  return `"${n.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function splitFamilies(list) {
  return String(list || "")
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, "").trim())
    .filter(Boolean);
}

// Which of `list` (weights or [min, max] ranges) CSS font matching picks for
// `desired`. Returns the index, or -1 for an empty list.
export function matchWeight(list, desired) {
  if (!list.length) return -1;
  const d = Number(desired) || 400;
  const ranges = list.map((w, i) => ({ i, lo: Array.isArray(w) ? w[0] : w, hi: Array.isArray(w) ? w[1] : w }));
  const exact = ranges.find((r) => d >= r.lo && d <= r.hi);
  if (exact) return exact.i;
  const lighter = ranges.filter((r) => r.hi < d).sort((a, b) => b.hi - a.hi);
  const heavier = ranges.filter((r) => r.lo > d).sort((a, b) => a.lo - b.lo);
  if (d >= 400 && d <= 500) {
    const upTo500 = heavier.filter((r) => r.lo <= 500);
    return (upTo500[0] || lighter[0] || heavier[0]).i;
  }
  if (d < 400) return (lighter[0] || heavier[0]).i;
  return (heavier[0] || lighter[0]).i;
}

function weightSteps(min, max) {
  const out = [min];
  for (let w = Math.ceil((min + 1) / 100) * 100; w < max; w += 100) out.push(w);
  if (max !== min) out.push(max);
  return out;
}

function withTimeout(promise, ms, fallback) {
  let t = 0;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((resolve) => {
      t = setTimeout(() => resolve(fallback), ms);
    }),
  ]);
}

async function blobToDataURL(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(bin)}`;
}

function dataURLToBlob(url) {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(String(url || ""));
  if (!m) throw Error("A font in this project is damaged.");
  const raw = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new Blob([bytes], { type: m[1] || "application/octet-stream" });
}

// ---- reading font files ----------------------------------------------------

const WEIGHT_WORDS = [
  [/hairline|thin/, 100],
  [/extra-?light|ultra-?light/, 200],
  [/light/, 300],
  [/semi-?bold|demi-?bold/, 600],
  [/extra-?bold|ultra-?bold/, 800],
  [/black|heavy/, 900],
  [/bold/, 700],
  [/medium/, 500],
];

function weightFromName(text) {
  const t = String(text || "").toLowerCase();
  for (const [re, w] of WEIGHT_WORDS) if (re.test(t)) return w;
  return 400;
}

const STYLE_WORDS = /[-_ ]+(?:hairline|thin|extra-?light|ultra-?light|light|regular|book|normal|roman|medium|semi-?bold|demi-?bold|extra-?bold|ultra-?bold|bold|black|heavy|italic|oblique|variable|vf)(?![a-z])/i;

// "OpenSans-BoldItalic.woff2" -> { family: "Open Sans", weight: 700, style: "italic", variable: null }
export function guessFromFileName(fileName) {
  const base = String(fileName || "Font").replace(/^.*[\\/]/, "").replace(/\.[a-z0-9]+$/i, "");
  const variable = /\[[^\]]*wght|variable|[-_]vf(?![a-z])/i.test(base);
  const stem = base.replace(/\[[^\]]*\]/g, "").replace(/([a-z])([A-Z])/g, "$1 $2");
  const m = STYLE_WORDS.exec(stem);
  const fam = (m ? stem.slice(0, m.index) : stem).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  const rest = m ? stem.slice(m.index) : "";
  return {
    family: fam || "Custom font",
    weight: variable ? 400 : weightFromName(rest),
    style: /italic|oblique/i.test(rest) ? "italic" : "normal",
    variable: variable ? { min: 100, max: 900 } : null,
  };
}

const tagAt = (view, at) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));

async function inflate(bytes) {
  if (typeof DecompressionStream === "undefined") throw Error("no DecompressionStream");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Map of table tag -> DataView for the tables we read, from a TTF/OTF or WOFF 1.
async function readTables(buffer, format, want) {
  const view = new DataView(buffer);
  const out = new Map();
  if (format === "woff") {
    const n = view.getUint16(12);
    for (let i = 0; i < n; i++) {
      const at = 44 + i * 20;
      const tag = tagAt(view, at);
      if (!want.includes(tag)) continue;
      const offset = view.getUint32(at + 4);
      const compLength = view.getUint32(at + 8);
      const origLength = view.getUint32(at + 12);
      if (offset + compLength > buffer.byteLength) throw Error("table out of range");
      let bytes = new Uint8Array(buffer, offset, compLength);
      if (compLength < origLength) bytes = await inflate(bytes);
      out.set(tag, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    }
    return out;
  }
  const n = view.getUint16(4);
  for (let i = 0; i < n; i++) {
    const at = 12 + i * 16;
    const tag = tagAt(view, at);
    if (!want.includes(tag)) continue;
    const offset = view.getUint32(at + 8);
    const length = view.getUint32(at + 12);
    if (offset + length > buffer.byteLength) throw Error("table out of range");
    out.set(tag, new DataView(buffer, offset, length));
  }
  return out;
}

function decodeName(view, at, length, platform, encoding) {
  if (platform === 0 || platform === 3) {
    let s = "";
    for (let i = 0; i + 1 < length; i += 2) s += String.fromCharCode(view.getUint16(at + i));
    return s;
  }
  if (platform === 1 && encoding === 0) {
    let s = "";
    for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(at + i));
    return s;
  }
  return "";
}

// name table -> { [nameID]: string }, preferring Windows English, then any Unicode, then Mac Roman.
function readNames(name) {
  const count = name.getUint16(2);
  const strings = name.getUint16(4);
  const best = {};
  const rank = (p, e, l) => (p === 3 && l === 0x409 ? 0 : p === 3 ? 1 : p === 0 ? 2 : p === 1 && e === 0 && l === 0 ? 3 : 9);
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 12;
    if (at + 12 > name.byteLength) break;
    const platform = name.getUint16(at);
    const encoding = name.getUint16(at + 2);
    const lang = name.getUint16(at + 4);
    const id = name.getUint16(at + 6);
    const length = name.getUint16(at + 8);
    const offset = name.getUint16(at + 10);
    const r = rank(platform, encoding, lang);
    if (r === 9 || (best[id] && best[id].r <= r)) continue;
    if (strings + offset + length > name.byteLength) continue;
    const text = decodeName(name, strings + offset, length, platform, encoding).replace(/\0/g, "").trim();
    if (text) best[id] = { r, text };
  }
  return Object.fromEntries(Object.entries(best).map(([k, v]) => [k, v.text]));
}

function readWghtAxis(fvar) {
  const axesAt = fvar.getUint16(4);
  const count = fvar.getUint16(8);
  const size = fvar.getUint16(10);
  for (let i = 0; i < count; i++) {
    const at = axesAt + i * size;
    if (tagAt(fvar, at) !== "wght") continue;
    const min = fvar.getInt32(at + 4) / 65536;
    const max = fvar.getInt32(at + 12) / 65536;
    return { min: clampWeight(min), max: clampWeight(max) };
  }
  return null;
}

// Reads family, weight, style and the weight axis from a font file. TTF, OTF
// and WOFF are read from their tables; WOFF2 (Brotli) falls back to the file
// name. Throws an Error with a plain message for anything that is not a font.
export async function parseFontFile(buffer, fileName = "") {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 12) throw Error("This file is not a font Longitude can read.");
  const view = new DataView(buffer);
  const sig = view.getUint32(0);
  const tag = tagAt(view, 0);
  let format = "";
  if (sig === 0x00010000 || tag === "true") format = "ttf";
  else if (tag === "OTTO") format = "otf";
  else if (tag === "wOFF") format = "woff";
  else if (tag === "wOF2") format = "woff2";
  else if (tag === "ttcf") throw Error("Font collections (.ttc) are not supported. Use a .ttf or .otf file.");
  else throw Error("This file is not a font. Use a .ttf, .otf, .woff or .woff2 file.");
  const guess = guessFromFileName(fileName);
  if (format === "woff2") return { ...guess, format, mime: MIME.woff2 };
  let tables;
  try {
    tables = await readTables(buffer, format, ["name", "OS/2", "head", "fvar"]);
  } catch {
    return { ...guess, format, mime: MIME[format] };
  }
  const names = tables.has("name") ? readNames(tables.get("name")) : {};
  const family = names[16] || names[1] || guess.family;
  const sub = names[17] || names[2] || "";
  let weight = weightFromName(sub);
  let italic = /italic|oblique/i.test(sub);
  const os2 = tables.get("OS/2");
  if (os2 && os2.byteLength >= 64) {
    let w = os2.getUint16(4);
    if (w > 0 && w < 10) w *= 100; // a few old fonts store 1..9
    if (w >= 1 && w <= 1000) weight = w;
    italic = italic || (os2.getUint16(62) & 0x201) !== 0;
  }
  const head = tables.get("head");
  if (head && head.byteLength >= 46) italic = italic || (head.getUint16(44) & 0x2) !== 0;
  const variable = tables.has("fvar") ? readWghtAxis(tables.get("fvar")) : null;
  return {
    family: GENERIC.has(keyOf(family)) ? guess.family : family,
    weight: variable ? Math.min(variable.max, Math.max(variable.min, weight)) : weight,
    style: italic ? "italic" : "normal",
    variable,
    format,
    mime: MIME[format],
  };
}

// ---- storage ---------------------------------------------------------------

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getIndexedDB() {
  try {
    return globalThis.indexedDB || null;
  } catch {
    return null; // some sandboxed pages throw on access
  }
}

// Opens the shared "longitude" database. Creates all four stores, as
// assets.js does, because whichever module opens it first runs the upgrade.
function openDb(idb) {
  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [store, keyPath] of Object.entries(DB_STORES)) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(Error("Longitude is open in another tab with an older version."));
  });
}

// Custom font records in the "fonts" store: { family, blob, weight, style, name,
// variable?, faces?: [{ blob, weight, style, name, variable? }] } (faces holds
// the second and later faces of the same family).
function idbStorage(getDb) {
  const run = async (mode, fn) => {
    const db = await getDb();
    const tx = db.transaction("fonts", mode);
    const result = await promisify(fn(tx.objectStore("fonts")));
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || Error("Saving the font was cancelled."));
    });
    return result;
  };
  return {
    getAll: () => run("readonly", (s) => s.getAll()),
    put: (record) => run("readwrite", (s) => s.put(record)),
    delete: (family) => run("readwrite", (s) => s.delete(family)),
  };
}

function browserMeasure() {
  let ctx = null;
  return (font, text) => {
    if (!ctx) {
      const canvas = globalThis.document?.createElement?.("canvas") ||
        (typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(8, 8) : null);
      ctx = canvas?.getContext("2d") || null;
      if (!ctx) return 0;
    }
    ctx.font = font;
    return ctx.measureText(text).width;
  };
}

// ---- the registry ------------------------------------------------------------

export class FontRegistry extends EventTarget {
  // env is for tests and unusual hosts: { FontFace, fontSet, fetch, storage, measure, timeout, baseURL,
  // now (clock, ms), window (where 'online' fires) }
  constructor({ assets = null, env = {} } = {}) {
    super();
    this.assets = assets;
    this._env = env;
    this._families = new Map(); // key -> family record
    this._infoCache = null;
    this._installed = new Map(); // key -> bool, for families we only measure
    this._storage = env.storage || null;
    this._db = null;
    this._ready = false;
  }

  // ---- setup ----

  async init(url = "fonts/fonts.json") {
    const base = this._env.baseURL || globalThis.document?.baseURI || globalThis.location?.href;
    let manifest = null;
    try {
      const href = base ? new URL(url, base).href : url;
      const res = await (this._env.fetch || globalThis.fetch)(href);
      if (!res.ok) throw Error(`HTTP ${res.status}`);
      manifest = { href, data: await res.json() };
    } catch (err) {
      console.error("Fonts: could not read the font list.", err);
    }
    if (manifest) {
      for (const def of manifest.data?.families || []) {
        if (this._families.has(keyOf(def?.family))) continue;
        try {
          const system = def.source === "system" || (def.faces || []).every((x) => !x.file && !x.url);
          this._add(this._makeFamily(def, { base: manifest.href, source: system ? "system" : "bundled" }));
        } catch (err) {
          console.warn("Fonts: skipped an entry in fonts.json.", err.message);
        }
      }
    }
    this._detectSystem();
    await this._restoreCustom();
    this._watchOnline();
    this._ready = true;
    this._changed("init");
    return this;
  }

  get ready() {
    return this._ready;
  }

  // ---- queries ----

  list() {
    if (!this._infoCache) {
      const order = (f) => CATEGORIES.indexOf(f.category);
      this._infoCache = [...this._families.values()]
        .filter((f) => f.source !== "system" || f.available)
        .map((f, i) => ({ f, i }))
        .sort((a, b) => order(a.f) - order(b.f) || a.i - b.i)
        .map(({ f }) => this._info(f));
    }
    return this._infoCache.slice();
  }

  get(family) {
    const f = this._families.get(keyOf(family));
    return f ? this._info(f) : null;
  }

  // Families whose label, family, category or tags match every word of q.
  search(q) {
    const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return this.list();
    return this.list().filter((info) => {
      const hay = [info.family, info.label, info.category, CATEGORY_LABELS[info.category], ...info.tags].join(" ").toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }

  stack(family) {
    const f = this._families.get(keyOf(family));
    const name = f ? f.family : String(family || "").trim() || "sans-serif";
    const parts = [name, ...splitFamilies(f?.fallback)];
    const seen = new Set();
    const out = [];
    for (const p of parts) {
      const k = keyOf(p);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(quoteFamily(p));
    }
    if (!out.some((p) => GENERIC.has(p))) out.push("sans-serif");
    return out.join(", ");
  }

  nearestWeight(family, weight = 400) {
    const f = this._families.get(keyOf(family));
    const w = clampWeight(weight);
    if (!f || !f.faces.length) return w;
    const styleFaces = f.faces.filter((x) => !isItalic(x.style));
    const pool = styleFaces.length ? styleFaces : f.faces;
    const list = pool.map((x) => (x.variable ? [x.variable.min, x.variable.max] : x.weight));
    const face = pool[matchWeight(list, w)];
    if (face.variable) return Math.min(face.variable.max, Math.max(face.variable.min, w));
    return face.weight;
  }

  loaded(family, weight = 400, style = "normal") {
    const f = this._families.get(keyOf(family));
    if (!f) return this._isInstalled(family);
    if (f.source === "system") return f.available;
    const face = this._pick(f, weight, style);
    return !!face && face.status === "loaded";
  }

  // Families the text layers of doc use, in first-use order.
  usedIn(doc) {
    const out = [];
    const seen = new Set();
    for (const layer of doc?.layers || []) {
      if (layer?.type !== "text" || !layer.font) continue;
      const k = keyOf(layer.font);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(layer.font);
    }
    return out;
  }

  // ---- loading ----

  // Loads the face CSS matching would use for (weight, style). Resolves true
  // when the family can be drawn: a bundled/custom/mod face loaded, or a system
  // font is installed. A missing system font loads its bundled fallback (Impact
  // -> Anton) and resolves with that result.
  // A face that failed recently resolves false without fetching again (see
  // RETRY_MAX); pass { retry: true } when the user asked for this font (picker,
  // inspector, opening a design) to try again now.
  async load(family, weight = 400, style = "normal", { retry = false } = {}) {
    const f = this._families.get(keyOf(family));
    if (!f) return this._isInstalled(family);
    if (f.source === "system") {
      if (f.available) return true;
      const fb = splitFamilies(f.fallback)
        .map((n) => this._families.get(keyOf(n)))
        .find((x) => x && x.source !== "system" && x !== f);
      return fb ? this.load(fb.family, weight, style, { retry }) : false;
    }
    const face = this._pick(f, weight, style);
    return face ? this._loadFace(f, face, { retry }) : false;
  }

  // Loads every face the doc's text layers use. Each face gets FACE_TIMEOUT ms;
  // a slow face keeps loading and fires 'load' later. Resolves with the
  // families that could not be loaded (empty when everything is ready).
  // { retry: true } (opening a design) also retries faces that failed recently.
  async ensureDoc(doc, { retry = false } = {}) {
    const wants = new Map();
    for (const layer of doc?.layers || []) {
      if (layer?.type !== "text" || !layer.font) continue;
      const weight = clampWeight(layer.weight);
      const style = layer.italic ? "italic" : "normal";
      wants.set(`${keyOf(layer.font)}|${weight}|${style}`, { family: layer.font, weight, style });
    }
    const missing = new Set();
    const timeout = this._env.timeout ?? FACE_TIMEOUT;
    await Promise.all([...wants.values()].map(async ({ family, weight, style }) => {
      const ok = await withTimeout(this.load(family, weight, style, { retry }).catch(() => false), timeout, false);
      if (!ok) missing.add(family);
    }));
    return [...missing];
  }

  // ---- custom fonts ----

  // Adds a font file (File or Blob). Returns the family name it is listed
  // under. opts { family, weight, style, name } overrides what the file says
  // (used when a project file brings its fonts along).
  async addCustom(file, opts = {}) {
    if (!file || typeof file.arrayBuffer !== "function") throw Error("Choose a font file to add.");
    if (file.size > MAX_FONT_BYTES) throw Error("That font file is too large.");
    const name = opts.name || file.name || "Font";
    const buffer = await file.arrayBuffer();
    const meta = await parseFontFile(buffer, name);
    let family = String(opts.family || meta.family).trim() || "Custom font";
    const existing = this._families.get(keyOf(family));
    if (!opts.family && ((existing && existing.source !== "custom") || RESERVED.has(keyOf(family)))) {
      // Same name as a bundled font: list it as "Name (yours)", and add later
      // files of that font to the same family.
      family = `${family} (yours)`;
      const taken = this._families.get(keyOf(family));
      if (taken && taken.source !== "custom") family = this._freeName(family);
    } else if (opts.family && existing && existing.source !== "custom") {
      return existing.family; // the project uses a font this install already has
    }
    const face = {
      blob: new Blob([buffer], { type: meta.mime || file.type || "application/octet-stream" }),
      weight: clampWeight(opts.weight ?? meta.weight),
      style: normStyle(opts.style ?? meta.style),
      name,
      variable: meta.variable,
    };
    let f = this._families.get(keyOf(family));
    const created = !f;
    if (created) {
      f = this._makeFamily({ family, label: family, category: "custom", faces: [] }, { source: "custom" });
    }
    const before = f.faces;
    const same = before.find((x) => x.weight === face.weight && x.style === face.style);
    const record = this._makeFace(f, face);
    f.faces = before.filter((x) => x !== same).concat(record);
    this._refreshFamily(f);
    if (!(await this._loadFace(f, record, { quiet: true })) && this._canLoad()) {
      this._dropFace(record);
      f.faces = before;
      this._refreshFamily(f);
      throw Error("This font file could not be read. It may be damaged.");
    }
    if (same) this._dropFace(same);
    if (created) this._add(f);
    await this._persist(f);
    this._changed("custom");
    return f.family;
  }

  async removeCustom(family) {
    const f = this._families.get(keyOf(family));
    if (!f || f.source !== "custom") return false;
    for (const face of f.faces) this._dropFace(face);
    this._families.delete(keyOf(family));
    try {
      await this._store()?.delete(f.family);
    } catch (err) {
      console.warn("Fonts: could not remove the stored font.", err);
    }
    this._changed("custom");
    return true;
  }

  // Custom fonts as stored: { family, faces: [{ blob, weight, style, name }] } or null.
  getCustom(family) {
    const f = this._families.get(keyOf(family));
    if (!f || f.source !== "custom") return null;
    return { family: f.family, faces: f.faces.map(({ blob, weight, style, name }) => ({ blob, weight, style, name })) };
  }

  // For .longitude files: the custom fonts doc uses, as { family, dataURL, weight, style }.
  async exportFonts(doc) {
    const used = new Set(this.usedIn(doc).map(keyOf));
    const out = [];
    for (const f of this._families.values()) {
      if (f.source !== "custom" || !used.has(keyOf(f.family))) continue;
      for (const face of f.faces) {
        out.push({ family: f.family, dataURL: await blobToDataURL(face.blob), weight: face.weight, style: face.style });
      }
    }
    return out;
  }

  // Restores fonts from a .longitude file. Returns the family names added or
  // already present; entries that fail are skipped (reported in the console).
  async importFonts(list) {
    const out = [];
    for (const item of Array.isArray(list) ? list : []) {
      if (!item?.family || !item.dataURL) continue;
      try {
        const blob = dataURLToBlob(item.dataURL);
        out.push(await this.addCustom(blob, { family: item.family, weight: item.weight, style: item.style, name: item.family }));
      } catch (err) {
        console.warn(`Fonts: could not restore "${item.family}".`, err.message);
      }
    }
    return [...new Set(out)];
  }

  // ---- mods ----

  // def: { family, label?, category?, faces: [{ url, weight?, style? }], variable?, fallback?,
  //        license?, credit?, sample?, tags?, defaultWeight?, base? }
  // Faces without a url describe a font that must already be installed (source "system").
  // Relative urls resolve against def.base (pass import.meta.url) or the page.
  register(def) {
    if (!def || typeof def.family !== "string" || !def.family.trim()) throw Error("fonts: register() needs a family name");
    if (!Array.isArray(def.faces) || !def.faces.length) throw Error(`fonts: "${def.family}" needs at least one face`);
    if (this._families.has(keyOf(def.family))) throw Error(`fonts: "${def.family}" is already registered`);
    const system = def.faces.every((x) => !x.url && !x.file);
    const base = def.base || this._env.baseURL || globalThis.document?.baseURI || globalThis.location?.href;
    const f = this._makeFamily(def, { base, source: system ? "system" : "mod" });
    this._add(f);
    if (system) this._detectSystem([f]);
    this._changed("mod");
    return () => {
      if (this._families.get(keyOf(f.family)) !== f) return;
      for (const face of f.faces) this._dropFace(face);
      this._families.delete(keyOf(f.family));
      this._changed("mod");
    };
  }

  // ---- internals ----

  _makeFamily(def, { base, source }) {
    const family = String(def.family || "").trim();
    if (!family) throw Error("missing family");
    const category = source === "custom" ? "custom" : CATEGORIES.includes(def.category) ? def.category : source === "system" ? "system" : "display";
    const v = def.variable && Number.isFinite(+def.variable.min) && Number.isFinite(+def.variable.max)
      ? { min: clampWeight(def.variable.min), max: clampWeight(def.variable.max) }
      : null;
    const f = {
      family,
      label: String(def.label || family),
      category,
      source,
      fallback: typeof def.fallback === "string" ? def.fallback : "sans-serif",
      license: String(def.license || ""),
      credit: String(def.credit || ""),
      sample: String(def.sample || "Aa"),
      tags: Array.isArray(def.tags) ? def.tags.map(String) : [],
      defaultWeight: def.defaultWeight,
      variable: v,
      available: source !== "system",
      faces: [],
    };
    const resolve = (src) => {
      try {
        return new URL(src, base).href;
      } catch {
        return src;
      }
    };
    for (const x of def.faces || []) {
      const src = x.url || x.file;
      if (!src && source !== "system") continue;
      f.faces.push(this._makeFace(f, {
        url: src ? resolve(src) : null,
        weight: clampWeight(x.weight ?? 400),
        style: normStyle(x.style),
        variable: v,
      }));
    }
    this._refreshFamily(f);
    return f;
  }

  _makeFace(f, { url = null, blob = null, weight, style, name = "", variable = null }) {
    return { url, blob, weight, style, name, variable, status: "idle", promise: null, fontFace: null, family: f.family };
  }

  // Descriptor weights: a variable face covers its axis; a style with a single
  // static face claims every weight so the browser never fakes a bold.
  _refreshFamily(f) {
    for (const style of ["normal", "italic"]) {
      const faces = f.faces.filter((x) => normStyle(x.style) === style);
      for (const x of faces) {
        x.descriptor = x.variable ? `${x.variable.min} ${x.variable.max}` : faces.length === 1 ? "1 1000" : String(x.weight);
        if (x.fontFace && x.fontFace.weight !== x.descriptor) {
          try {
            x.fontFace.weight = x.descriptor;
          } catch {}
        }
      }
    }
    this._infoCache = null;
  }

  _info(f) {
    const weights = new Set();
    let variable = null;
    for (const x of f.faces) {
      if (x.variable) {
        variable = variable ? { min: Math.min(variable.min, x.variable.min), max: Math.max(variable.max, x.variable.max) } : { ...x.variable };
        for (const w of weightSteps(x.variable.min, x.variable.max)) weights.add(w);
      } else {
        weights.add(x.weight);
      }
    }
    const list = [...weights].sort((a, b) => a - b);
    const wanted = Number(f.defaultWeight);
    const defaultWeight = Number.isFinite(wanted) ? this.nearestWeight(f.family, wanted) : list.includes(400) ? 400 : this.nearestWeight(f.family, 400);
    return {
      family: f.family,
      label: f.label,
      category: f.category,
      source: f.source,
      weights: list.length ? list : [400],
      italic: f.faces.some((x) => isItalic(x.style)),
      variable,
      defaultWeight,
      available: f.available,
      fallback: f.fallback,
      license: f.license,
      credit: f.credit,
      sample: f.sample,
      tags: f.tags.slice(),
    };
  }

  _add(f) {
    this._families.set(keyOf(f.family), f);
    this._infoCache = null;
  }

  _changed(reason) {
    this._infoCache = null;
    this.dispatchEvent(new CustomEvent("change", { detail: { reason } }));
  }

  _freeName(name) {
    let n = name;
    for (let i = 2; this._families.has(keyOf(n)); i++) n = `${name} ${i}`;
    return n;
  }

  _pick(f, weight, style) {
    if (!f.faces.length) return null;
    const want = isItalic(style);
    let pool = f.faces.filter((x) => isItalic(x.style) === want);
    if (!pool.length) pool = f.faces.filter((x) => !isItalic(x.style));
    if (!pool.length) pool = f.faces;
    if (pool.length === 1) return pool[0];
    const list = pool.map((x) => (x.variable ? [x.variable.min, x.variable.max] : x.weight));
    return pool[matchWeight(list, clampWeight(weight))];
  }

  _canLoad() {
    return typeof (this._env.FontFace || globalThis.FontFace) === "function";
  }

  _now() {
    return (this._env.now || Date.now)();
  }

  // After going back online, faces that failed are worth trying again now;
  // 'change' makes text re-render, which asks for them.
  _watchOnline() {
    if (this._onlineHooked) return;
    const target = this._env.window || (globalThis.document ? globalThis : null);
    if (typeof target?.addEventListener !== "function") return;
    this._onlineHooked = true;
    target.addEventListener("online", () => {
      let any = false;
      for (const f of this._families.values()) {
        for (const face of f.faces) {
          if (face.status !== "error") continue;
          face.failures = 0;
          any = true;
        }
      }
      if (any) this._changed("online");
    });
  }

  _loadFace(f, face, { quiet = false, retry = false } = {}) {
    if (face.status === "loaded") return Promise.resolve(true);
    if (face.promise) return face.promise;
    const FontFaceImpl = this._env.FontFace || globalThis.FontFace;
    const fontSet = this._env.fontSet || globalThis.document?.fonts;
    if (typeof FontFaceImpl !== "function") return Promise.resolve(false);
    if (face.status === "error" && !retry && this._now() - (face.failedAt || 0) < retryDelay(face.failures || 0)) {
      return Promise.resolve(false);
    }
    face.status = "loading";
    face.promise = (async () => {
      try {
        const source = face.blob ? await face.blob.arrayBuffer() : `url(${JSON.stringify(face.url)})`;
        const ff = new FontFaceImpl(f.family, source, { weight: face.descriptor, style: face.style, display: "swap" });
        await ff.load();
        if (face.status !== "loading") return false; // removed while loading
        fontSet?.add(ff);
        face.fontFace = ff;
        face.status = "loaded";
        face.failures = 0;
        this.dispatchEvent(new CustomEvent("load", { detail: { family: f.family, weight: face.weight, style: face.style } }));
        return true;
      } catch (err) {
        // Warned once per face; the next tries stay quiet.
        if (!quiet && !face.warned) console.warn(`Fonts: could not load ${f.family} ${face.weight} ${face.style}.`, err?.message || err);
        if (!quiet) face.warned = true;
        face.status = "error";
        face.promise = null;
        face.failures = (face.failures || 0) + 1;
        face.failedAt = this._now();
        return false;
      }
    })();
    return face.promise;
  }

  _dropFace(face) {
    const fontSet = this._env.fontSet || globalThis.document?.fonts;
    if (face.fontFace) {
      try {
        fontSet?.delete(face.fontFace);
      } catch {}
    }
    face.fontFace = null;
    face.status = "removed";
    face.promise = null;
  }

  _measure() {
    if (!this._measureFn) this._measureFn = this._env.measure || browserMeasure();
    return this._measureFn;
  }

  _isInstalled(family) {
    const k = keyOf(family);
    if (!k) return false;
    if (GENERIC.has(k)) return true;
    if (!this._installed.has(k)) {
      const measure = this._measure();
      let found = false;
      try {
        for (const base of ["monospace", "serif", "sans-serif"]) {
          if (measure(`72px ${base}`, PROBE_TEXT) !== measure(`72px ${quoteFamily(family)}, ${base}`, PROBE_TEXT)) {
            found = true;
            break;
          }
        }
      } catch {
        found = false;
      }
      this._installed.set(k, found);
    }
    return this._installed.get(k);
  }

  _detectSystem(list = [...this._families.values()]) {
    for (const f of list) {
      if (f.source === "system") f.available = this._isInstalled(f.family);
    }
    this._infoCache = null;
  }

  _store() {
    if (this._storage) return this._storage;
    const idb = getIndexedDB();
    if (!idb) return null;
    // Share the asset store's connection when it has one open.
    const getDb = () => {
      const shared = this.assets?.db;
      if (shared && typeof shared.transaction === "function") return Promise.resolve(shared);
      if (!this._db) {
        this._db = openDb(idb).catch((err) => {
          this._db = null;
          throw err;
        });
      }
      return this._db;
    };
    this._storage = idbStorage(getDb);
    return this._storage;
  }

  async _restoreCustom() {
    const store = this._store();
    if (!store) return;
    let records = [];
    try {
      records = await store.getAll();
    } catch (err) {
      console.warn("Fonts: could not read your saved fonts.", err);
      return;
    }
    for (const rec of records || []) {
      if (!rec?.family || this._families.has(keyOf(rec.family))) continue;
      const f = this._makeFamily({ family: rec.family, label: rec.family, category: "custom", faces: [] }, { source: "custom" });
      for (const x of [rec, ...(Array.isArray(rec.faces) ? rec.faces : [])]) {
        if (!(x?.blob instanceof Blob)) continue;
        f.faces.push(this._makeFace(f, {
          blob: x.blob,
          weight: clampWeight(x.weight),
          style: normStyle(x.style),
          name: x.name || "",
          variable: x.variable || null,
        }));
      }
      if (!f.faces.length) continue;
      this._refreshFamily(f);
      this._add(f);
    }
  }

  async _persist(f) {
    const store = this._store();
    if (!store) return;
    const [first, ...rest] = f.faces;
    const face = (x) => ({ blob: x.blob, weight: x.weight, style: x.style, name: x.name, variable: x.variable || null });
    const record = { family: f.family, ...face(first) };
    if (rest.length) record.faces = rest.map(face);
    try {
      await store.put(record);
    } catch (err) {
      console.warn("Fonts: could not save the font. It works until you close Longitude.", err);
    }
  }
}
