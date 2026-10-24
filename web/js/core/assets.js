// Local storage: images (assets) and projects in IndexedDB "longitude", with
// an in-memory fallback when IndexedDB is unavailable (private windows in some
// browsers, tests). Images are keyed by a hash of their bytes, so adding the
// same file twice stores it once. Nothing here ever leaves the machine.

import { normalizeDoc, assetIdsOf } from "./model.js";
import { createCanvas, canvasToBlob } from "./effects.js";

export const DB_NAME = "longitude";
export const DB_VERSION = 1;
// Every module that opens the database must create all four stores.
export const DB_STORES = { assets: "id", projects: "id", fonts: "family", kv: "k" };

const QUOTA_MESSAGE = "Browser storage is full. Delete a few old projects to make room.";

let dbPromise = null;

// Resolves to an IDBDatabase, or null when IndexedDB cannot be used.
export function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let idb = null;
    try {
      idb = globalThis.indexedDB || null;
    } catch {
      idb = null;
    }
    if (!idb) return resolve(null);
    let settled = false;
    const done = (db) => {
      if (settled) return;
      settled = true;
      resolve(db);
    };
    const timer = setTimeout(() => done(null), 6000);
    let req;
    try {
      req = idb.open(DB_NAME, DB_VERSION);
    } catch {
      clearTimeout(timer);
      return done(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, keyPath] of Object.entries(DB_STORES)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath });
      }
    };
    req.onsuccess = () => {
      clearTimeout(timer);
      const db = req.result;
      db.onversionchange = () => db.close();
      done(db);
    };
    req.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
  });
  return dbPromise;
}

// ---- tables -------------------------------------------------------------------

const memory = new Map();
function memStore(name) {
  let m = memory.get(name);
  if (!m) {
    m = new Map();
    memory.set(name, m);
  }
  return m;
}

// Deep copy of plain data that keeps Blobs (and other objects) by reference,
// so the memory fallback behaves like IndexedDB's structured clone.
function copyRecord(v) {
  if (Array.isArray(v)) return v.map(copyRecord);
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = copyRecord(val);
    return o;
  }
  return v;
}

function isQuota(err) {
  return err && (err.name === "QuotaExceededError" || /quota/i.test(String(err.message || "")));
}

function idb(db, name, mode, op) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(name, mode);
    } catch (err) {
      reject(err);
      return;
    }
    let value;
    const req = op(tx.objectStore(name));
    if (req) req.onsuccess = () => (value = req.result);
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error || req?.error);
    tx.onabort = () => reject(tx.error || req?.error || Error("Storage request was canceled."));
  });
}

// A small promise API over one object store (or its memory fallback).
export function table(name) {
  const keyPath = DB_STORES[name];
  if (!keyPath) throw Error(`Unknown store "${name}".`);
  return {
    async get(key) {
      const db = await openDatabase();
      if (!db) return copyRecord(memStore(name).get(key)) ?? undefined;
      return idb(db, name, "readonly", (s) => s.get(key));
    },
    async has(key) {
      const db = await openDatabase();
      if (!db) return memStore(name).has(key);
      return (await idb(db, name, "readonly", (s) => s.count(key))) > 0;
    },
    async put(value) {
      const db = await openDatabase();
      if (!db) {
        memStore(name).set(value[keyPath], copyRecord(value));
        return;
      }
      try {
        await idb(db, name, "readwrite", (s) => s.put(value));
      } catch (err) {
        if (isQuota(err)) throw Error(QUOTA_MESSAGE);
        throw err;
      }
    },
    async delete(key) {
      const db = await openDatabase();
      if (!db) {
        memStore(name).delete(key);
        return;
      }
      await idb(db, name, "readwrite", (s) => s.delete(key));
    },
    async all() {
      const db = await openDatabase();
      if (!db) return [...memStore(name).values()].map(copyRecord);
      return (await idb(db, name, "readonly", (s) => s.getAll())) || [];
    },
    async keys() {
      const db = await openDatabase();
      if (!db) return [...memStore(name).keys()];
      return (await idb(db, name, "readonly", (s) => s.getAllKeys())) || [];
    },
  };
}

// ---- bytes, hashes and data URLs ----------------------------------------------------

function hex(buf) {
  let s = "";
  for (const b of new Uint8Array(buf)) s += b.toString(16).padStart(2, "0");
  return s;
}

function fallbackHash(bytes) {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9 ^ bytes.length;
  let c = 0x27d4eb2f;
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i];
    a = Math.imul(a ^ v, 16777619);
    b = Math.imul(b ^ v, 2246822519) ^ (b >>> 13);
    c = Math.imul(c + v, 3266489917) ^ (c >>> 16);
  }
  return [a, b, c].map((n) => (n >>> 0).toString(16).padStart(8, "0")).join("");
}

export async function hashBytes(bytes) {
  try {
    if (globalThis.crypto?.subtle?.digest) return hex(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  } catch {}
  return fallbackHash(bytes);
}

export async function blobToDataURL(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(s)}`;
}

export function dataURLToBlob(url) {
  const m = /^data:([^;,]*)((?:;[^;,]*)*?)(;base64)?,(.*)$/s.exec(String(url || ""));
  if (!m) throw Error("That is not a valid data URL.");
  const type = m[1] || "application/octet-stream";
  if (!m[3]) return new Blob([decodeURIComponent(m[4])], { type });
  const bin = atob(m[4].replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

const ascii = (b, at, n) => String.fromCharCode(...b.subarray(at, at + n));

// Image type from the first bytes (trusted over the file extension).
export function sniffType(b) {
  if (!b || b.length < 4) return "";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "image/webp";
  if (b.length >= 12 && ascii(b, 4, 4) === "ftyp") {
    const brand = ascii(b, 8, 4);
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (/^(heic|heix|hevc|mif1|msf1)$/.test(brand)) return "image/heic";
  }
  const head = ascii(b, 0, Math.min(b.length, 1024)).replace(/^﻿/, "").trimStart().toLowerCase();
  if (head.startsWith("<svg") || ((head.startsWith("<?xml") || head.startsWith("<!--") || head.startsWith("<!doctype svg")) && head.includes("<svg"))) return "image/svg+xml";
  return "";
}

// ---- decoding -------------------------------------------------------------------------

const UNSUPPORTED = "This image format is not supported. Try PNG, JPEG or WebP.";

function loadImg(blob) {
  if (typeof Image !== "function" || typeof URL?.createObjectURL !== "function") return Promise.resolve(null);
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  return img
    .decode()
    .then(() => img)
    .catch(() => null)
    .finally(() => URL.revokeObjectURL(url));
}

async function svgSize(blob, img) {
  let w = img.naturalWidth || 0;
  let h = img.naturalHeight || 0;
  if (w && h) return [w, h];
  try {
    const text = await blob.text();
    const vb = /viewBox\s*=\s*["']\s*[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+([\d.e]+)/i.exec(text);
    if (vb) {
      w = parseFloat(vb[1]);
      h = parseFloat(vb[2]);
    }
  } catch {}
  return w > 0 && h > 0 ? [w, h] : [1024, 1024];
}

// SVG: drawn through an <img> to a canvas with the longest side at 2048.
async function decodeSvg(blob) {
  const img = await loadImg(blob);
  if (!img) throw Error(UNSUPPORTED);
  const [w, h] = await svgSize(blob, img);
  const s = 2048 / Math.max(w, h);
  const W = Math.max(1, Math.round(w * s));
  const H = Math.max(1, Math.round(h * s));
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0, W, H);
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(c);
    } catch {}
  }
  return c;
}

export async function decodeBlob(blob, type = blob?.type || "") {
  if (type === "image/svg+xml") return decodeSvg(blob);
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob, { imageOrientation: "from-image" });
    } catch {}
    try {
      return await createImageBitmap(blob);
    } catch {}
  }
  const img = await loadImg(blob);
  if (img) {
    if (typeof createImageBitmap === "function") {
      try {
        return await createImageBitmap(img);
      } catch {}
    }
    const c = createCanvas(img.naturalWidth, img.naturalHeight);
    c.getContext("2d").drawImage(img, 0, 0);
    return c;
  }
  throw Error(type === "image/heic" ? "HEIC photos do not open in this browser. Save the photo as JPEG first." : UNSUPPORTED);
}

async function downscale(bmp, maxSide, type) {
  const s = maxSide / Math.max(bmp.width, bmp.height);
  const W = Math.max(1, Math.round(bmp.width * s));
  const H = Math.max(1, Math.round(bmp.height * s));
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  if ("imageSmoothingQuality" in ctx) ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, W, H);
  const outType = type === "image/jpeg" || type === "image/webp" ? type : "image/png";
  let blob = await canvasToBlob(c, outType, outType === "image/png" ? undefined : 0.92);
  if (blob.type !== outType) blob = await canvasToBlob(c, "image/png");
  bmp.close?.();
  let bitmap = c;
  if (typeof createImageBitmap === "function") {
    try {
      bitmap = await createImageBitmap(c);
    } catch {}
  }
  return { blob, bitmap };
}

const metaOf = (rec) => ({ w: rec.w, h: rec.h, type: rec.type, name: rec.name || "", size: rec.size || 0, added: rec.added || 0 });

// ---- assets ---------------------------------------------------------------------------------

// Every open Longitude window holds this lock (shared) for its lifetime, so
// gc() can tell when another window is open and might still need an image.
const LIVE_LOCK = "longitude-live";

// coordinate: take part in the cross-window lock (on in pages; tests opt in).
export class AssetStore extends EventTarget {
  constructor({ maxSide = 4096, memoryBudget = 128e6, coordinate = typeof document !== "undefined" } = {}) {
    super();
    this.maxSide = maxSide;
    // Decoded pixels kept in memory (128 MP is about 512 MB of RGBA). At most
    // a quarter of it goes to images the open design does not use.
    this.budget = memoryBudget;
    this.meta = new Map();
    this.images = new Map();
    this.live = null;
    this._born = new WeakMap(); // bitmap -> when it was decoded
    this.now = () => Date.now();
    this.pixels = 0;
    this.coordinate = !!coordinate;
    this._holding = false;
    this._release = null;
    this.pending = new Map();
    this.failed = new Map();
    this.touched = new Set();
    this.sessionStart = Date.now();
    this.persistent = false;
    this.db = null;
    this._ready = null;
    this._table = table("assets");
  }

  init() {
    if (!this._ready) this._ready = this._load();
    return this._ready;
  }

  async _load() {
    if (this.coordinate) this._holdLock();
    const db = await openDatabase();
    this.persistent = !!db;
    // Shared with FontRegistry, which uses assets.db when it is set.
    this.db = db;
    try {
      for (const rec of await this._table.all()) if (rec?.id) this.meta.set(rec.id, metaOf(rec));
    } catch (err) {
      console.warn("Could not read stored images", err);
    }
  }

  // Store an image file. Very large images are scaled to maxSide (4096 px on
  // the long side) first. Resolves to the asset id.
  async addBlob(blob, { name } = {}) {
    await this.init();
    if (!blob || typeof blob.arrayBuffer !== "function") throw Error("That is not a file.");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!bytes.length) throw Error("That file is empty.");
    const id = `ast_${(await hashBytes(bytes)).slice(0, 20)}`;
    this.touched.add(id);
    if (this.meta.has(id)) return id;
    const type = sniffType(bytes) || String(blob.type || "").toLowerCase();
    if (type && !type.startsWith("image/")) throw Error("That file is not an image.");
    let stored = new Blob([bytes], { type });
    let bmp = await decodeBlob(stored, type);
    if (Math.max(bmp.width, bmp.height) > this.maxSide) ({ blob: stored, bitmap: bmp } = await downscale(bmp, this.maxSide, type));
    return this._store(id, stored, bmp, name ?? blob.name ?? "");
  }

  // Store a canvas (masks, cutouts). Resolves to the asset id.
  async addCanvas(canvas, { type = "image/png", quality, name = "" } = {}) {
    await this.init();
    const blob = await canvasToBlob(canvas, type, quality);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const id = `ast_${(await hashBytes(bytes)).slice(0, 20)}`;
    this.touched.add(id);
    if (this.meta.has(id)) return id;
    let bmp = null;
    if (typeof createImageBitmap === "function") {
      try {
        bmp = await createImageBitmap(canvas);
      } catch {
        bmp = null;
      }
    }
    if (!bmp) bmp = await decodeBlob(blob, blob.type);
    return this._store(id, blob, bmp, name);
  }

  async _store(id, blob, bmp, name) {
    const rec = { id, blob, type: blob.type, name: String(name || "").slice(0, 200), w: bmp.width, h: bmp.height, size: blob.size, added: Date.now() };
    await this._table.put(rec);
    this.meta.set(id, metaOf(rec));
    this.failed.delete(id);
    this._setImage(id, bmp);
    return id;
  }

  async getBlob(id) {
    if (!id) return null;
    await this.init();
    const rec = await this._table.get(id);
    return rec?.blob || null;
  }

  has(id) {
    return this.meta.has(id);
  }

  // Sync. The decoded image, or null while it decodes (a 'ready' event follows).
  getImage(id) {
    if (!id) return null;
    const img = this.images.get(id);
    if (img) {
      if (this.images.size > 1) {
        this.images.delete(id);
        this.images.set(id, img);
      }
      return img;
    }
    if (!this.pending.has(id) && !this.failed.has(id)) this._decode(id).catch(() => {});
    return null;
  }

  async loadImage(id) {
    const img = this.images.get(id);
    if (img) return img;
    this.failed.delete(id);
    return this._decode(id);
  }

  _decode(id) {
    let p = this.pending.get(id);
    if (p) return p;
    this.touched.add(id);
    p = (async () => {
      await this.init();
      const blob = await this.getBlob(id);
      if (!blob) throw Error("Image not found.");
      const bmp = await decodeBlob(blob, blob.type);
      if (!this.meta.has(id)) this.meta.set(id, { w: bmp.width, h: bmp.height, type: blob.type, name: "", size: blob.size, added: 0 });
      this._setImage(id, bmp);
      return bmp;
    })();
    this.pending.set(id, p);
    p.then(
      () => this.pending.delete(id),
      (err) => {
        this.pending.delete(id);
        this.failed.set(id, err);
      },
    );
    return p;
  }

  _setImage(id, bmp) {
    const old = this.images.get(id);
    if (old) {
      this.pixels -= old.width * old.height;
      this.images.delete(id);
    }
    this.images.set(id, bmp);
    this.pixels += bmp.width * bmp.height;
    this._born.set(bmp, this.now());
    this._evict(id);
    this.dispatchEvent(new CustomEvent("ready", { detail: { id } }));
  }

  // The asset ids the open design uses (autosave calls this as the design
  // changes). Decoded images outside it are dropped first: old masks from
  // refine strokes, eraser clicks and edge edits, photos deleted from the
  // design. Undo re-decodes them from storage.
  setLive(ids) {
    this.live = new Set(ids || []);
    this._evict(null);
  }

  // Oldest first. Bitmaps are only dropped from the map, never close()d: a
  // caller of loadImage (background removal, say) may still be using one.
  // Images decoded in the last few seconds are not "unused" yet (an import
  // of several photos adds them to the design after they all decode).
  _evict(keep) {
    const drop = (oid, img) => {
      this.images.delete(oid);
      this.pixels -= img.width * img.height;
    };
    const live = this.live;
    if (live) {
      const settled = this.now() - 10000;
      let spare = 0;
      for (const [oid, img] of this.images) if (!live.has(oid)) spare += img.width * img.height;
      for (const [oid, img] of this.images) {
        if (spare <= this.budget / 4 && this.pixels <= this.budget) break;
        if (oid === keep || live.has(oid) || (this._born.get(img) || 0) > settled) continue;
        spare -= img.width * img.height;
        drop(oid, img);
      }
    }
    for (const [oid, img] of this.images) {
      if (this.pixels <= this.budget) break;
      if (oid !== keep) drop(oid, img);
    }
  }

  // Hold the shared window lock until dispose().
  _holdLock() {
    const locks = globalThis.navigator?.locks;
    if (this._holding || !locks?.request) return;
    try {
      locks
        .request(LIVE_LOCK, { mode: "shared" }, () => {
          this._holding = true;
          return new Promise((resolve) => (this._release = resolve));
        })
        .catch(() => {});
    } catch {}
  }

  // Whether another Longitude window (or tab) is open on this browser profile.
  async otherWindows() {
    const locks = globalThis.navigator?.locks;
    if (!locks?.query) return false;
    try {
      const { held = [] } = await locks.query();
      const clients = new Set(held.filter((l) => l.name === LIVE_LOCK).map((l) => l.clientId));
      return clients.size > (this._holding ? 1 : 0);
    } catch {
      return false;
    }
  }

  dispose() {
    this._release?.();
    this._release = null;
    this._holding = false;
  }

  info(id) {
    const m = this.meta.get(id);
    return m ? { w: m.w, h: m.h, type: m.type, name: m.name } : null;
  }

  async toDataURL(id) {
    const blob = await this.getBlob(id);
    if (!blob) throw Error("Image not found.");
    return blobToDataURL(blob);
  }

  async fromDataURL(dataUrl, { name } = {}) {
    return this.addBlob(dataURLToBlob(dataUrl), { name });
  }

  // Delete stored images that no saved project uses and keepIds does not
  // list. Images added, re-added or shown during this session are always kept
  // (undo may still need them). Resolves to the number removed. Refuses while
  // another window is open: its undo history is invisible from here.
  async gc(keepIds = []) {
    await this.init();
    if (await this.otherWindows()) throw Error("Close the other Longitude windows first. Images they still use could be removed.");
    const keep = new Set(keepIds || []);
    try {
      for (const rec of await table("projects").all()) for (const id of assetIdsOf(rec?.doc)) keep.add(id);
    } catch (err) {
      console.warn(err);
      return 0;
    }
    let removed = 0;
    for (const [id, m] of [...this.meta]) {
      if (keep.has(id) || this.touched.has(id) || !(m.added > 0) || m.added >= this.sessionStart) continue;
      try {
        await this._table.delete(id);
      } catch {
        continue;
      }
      this.meta.delete(id);
      const img = this.images.get(id);
      if (img) {
        this.pixels -= img.width * img.height;
        this.images.delete(id);
      }
      removed++;
    }
    return removed;
  }
}

// ---- projects ---------------------------------------------------------------------------------

const cleanName = (v) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200) : "") || "Untitled thumbnail";

const CONFLICT_MESSAGE = "This design was saved in another Longitude window, so this window stopped saving it. Save a project file to keep the changes made here.";

// sync: tell other windows about saves and refuse to overwrite their newer
// copy (on in pages; tests opt in). Close with dispose().
export class ProjectStore {
  constructor(assetStore = null, { sync = typeof document !== "undefined" } = {}) {
    this.assets = assetStore;
    this._table = table("projects");
    this._kv = table("kv");
    // The thumbnail each design has in storage, as far as this window knows,
    // so a save that keeps it is a single put (the save on page close must
    // not wait for a read).
    this._thumbs = new Map();
    // `updated` of each design as this window last loaded or saved it, and as
    // other windows report saving it.
    this._seen = new Map();
    this._theirs = new Map();
    this._channel = null;
    if (sync && typeof BroadcastChannel === "function") {
      try {
        this._channel = new BroadcastChannel("longitude-projects");
        this._channel.onmessage = (e) => {
          const m = e.data;
          if (typeof m?.saved === "string" && Number.isFinite(m.updated)) this._theirs.set(m.saved, Math.max(this._theirs.get(m.saved) || 0, m.updated));
        };
      } catch {
        this._channel = null;
      }
    }
  }

  dispose() {
    this._channel?.close();
    this._channel = null;
  }

  _saw(r) {
    if (!r?.id) return;
    this._seen.set(r.id, Math.max(this._seen.get(r.id) || 0, r.updated || 0));
    this._thumbs.set(r.id, typeof Blob !== "undefined" && r.thumb instanceof Blob ? r.thumb : null);
  }

  // Newest first.
  async list() {
    const recs = await this._table.all();
    return recs
      .filter((r) => r && typeof r.id === "string")
      .map((r) => ({
        id: r.id,
        name: r.name || r.doc?.name || "Untitled thumbnail",
        width: r.width ?? r.doc?.width ?? 0,
        height: r.height ?? r.doc?.height ?? 0,
        updated: r.updated || 0,
        thumb: typeof Blob !== "undefined" && r.thumb instanceof Blob ? r.thumb : null,
      }))
      .sort((a, b) => b.updated - a.updated);
  }

  async load(id) {
    if (!id) return null;
    const r = await this._table.get(id);
    if (!r?.doc) return null;
    this._saw(r);
    try {
      return normalizeDoc(r.doc);
    } catch {
      return null;
    }
  }

  async has(id) {
    return !!id && (await this._table.has(id));
  }

  // Upsert. thumbBlob undefined keeps the stored thumbnail; null clears it.
  // Resolves to the saved time. Throws (err.code "conflict") instead of
  // writing over a newer copy another window saved since this one loaded it.
  async save(doc, thumbBlob) {
    if (!doc?.id) throw Error("There is no design to save.");
    const id = doc.id;
    if ((this._theirs.get(id) || 0) > (this._seen.get(id) || 0)) throw Object.assign(Error(CONFLICT_MESSAGE), { code: "conflict", id });
    let thumb = thumbBlob;
    let stored = null;
    if (thumb === undefined) {
      if (this._thumbs.has(id)) thumb = this._thumbs.get(id);
      else {
        // Not known here yet: the read starts first, so it sees the record as
        // it was, but the put does not wait for it; the thumbnail is put back
        // after.
        stored = this._table.get(id).then(
          (r) => r?.thumb ?? null,
          () => null,
        );
        thumb = null;
      }
    }
    this._thumbs.set(id, thumb);
    const updated = Math.max(Date.now(), (this._seen.get(id) || 0) + 1);
    const rec = {
      id,
      name: cleanName(doc.name),
      width: doc.width,
      height: doc.height,
      updated,
      doc: { ...doc, meta: { ...(doc.meta || {}), updated } },
      thumb,
    };
    await this._table.put(rec);
    this._seen.set(id, updated);
    const old = stored && (await stored);
    if (old && this._thumbs.get(id) === null && this._seen.get(id) === updated) {
      this._thumbs.set(id, old);
      try {
        await this._table.put({ ...rec, thumb: old });
      } catch {}
    }
    try {
      this._channel?.postMessage({ saved: id, updated });
    } catch {}
    return updated;
  }

  async remove(id) {
    if (!id) return;
    this._thumbs.delete(id);
    await this._table.delete(id);
    if ((await this.lastOpened()) === id) await this.setLastOpened(null);
  }

  async rename(id, name) {
    const r = await this._table.get(id);
    if (!r) return false;
    const n = cleanName(name);
    r.name = n;
    if (r.doc) r.doc.name = n;
    await this._table.put(r);
    return true;
  }

  async lastOpened() {
    const r = await this._kv.get("lastOpened");
    return typeof r?.v === "string" ? r.v : null;
  }

  async setLastOpened(id) {
    if (id) await this._kv.put({ k: "lastOpened", v: id });
    else await this._kv.delete("lastOpened");
  }
}
