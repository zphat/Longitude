// The desktop app (Tauri 2, docs/DESKTOP.md). main.js calls installDesktop()
// at boot; in a normal browser isDesktop() is false, installDesktop() returns
// null and nothing here runs. What the desktop build changes:
// - <html data-desktop="tauri"> for styles, and ctx.desktop, which the views ask
//   to say "Save", "in Longitude" and "on this computer" instead of browser words
// - no service worker: every file is inside the program (main.js skips it)
// - exports and project files go through a Save dialog (showSaveFilePicker),
//   with the plain download as the fallback (compress.js download(), loaded
//   right after start so "Save a copy" uses it too)
// - files from the command line or a second launch open like "Open a file"
// - links open in the default browser; the browser's own context menu and
//   browser-only shortcuts (print, find, caret browsing, back) are off
// - the window title follows the design name
// - closing the window waits for the last autosave (src-tauri/src/lib.rs)
// - at most once a day, a look at the latest GitHub release (prefs
//   "updateCheck", on by default; commands app.check-updates, app.update-checks)
// The pure helpers are covered by tests/desktop-*.test.js.

import { vendorUrl } from "../features/bgremove/config.js";

export const REPO = "zphat/Longitude";
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
export const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000;
export const EVENTS = Object.freeze({ openFiles: "longitude://open-files", closeRequested: "longitude://close-requested" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- detection ----------------------------------------------------------------

// The Tauri API this page can use ({ invoke, listen, window }), or null in a
// browser. withGlobalTauri in tauri.conf.json puts it on window.__TAURI__.
export function tauri(g = globalThis) {
  const t = g?.__TAURI__;
  if (typeof t?.core?.invoke !== "function") return null;
  return {
    invoke: t.core.invoke,
    listen: typeof t.event?.listen === "function" ? t.event.listen : null,
    window: t.window || null,
  };
}

export function isDesktop(g = globalThis) {
  return !!(g?.__TAURI__ || g?.__TAURI_INTERNALS__);
}

// ---- versions -----------------------------------------------------------------

// "v1.2.3", "1.2", "1.2.3-beta.2" -> { nums: [1, 2, 3], pre: ["beta", 2] }, or null.
export function parseVersion(v) {
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(String(v ?? ""));
  if (!m) return null;
  return {
    nums: [m[1], m[2], m[3]].map((n) => Number(n || 0)),
    pre: m[4] ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [],
  };
}

// -1, 0 or 1 like a sort comparator; null when either side is not a version.
// A pre-release comes before its release (1.0.0-beta.2 < 1.0.0).
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = typeof p === "number";
    const qn = typeof q === "number";
    if (pn && qn) return p < q ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

// The release page to open: GitHub's link when it points into this repository's releases, else the latest one.
export function releasePage(url) {
  const s = String(url || "");
  return s.startsWith(`https://github.com/${REPO}/releases/`) ? s : RELEASES_PAGE;
}

// GitHub's "latest release" JSON -> { version, tag, name, url } when it is
// newer than `current`, else null. Drafts and pre-releases never count.
export function newerRelease(json, current) {
  if (!json || typeof json !== "object" || json.draft || json.prerelease) return null;
  const tag = String(json.tag_name || "").trim();
  if (compareVersions(tag, current) !== 1) return null;
  return { version: tag.replace(/^v/i, ""), tag, name: String(json.name || `Longitude ${tag}`), url: releasePage(json.html_url) };
}

// Automatic checks: on, and the last one a day or more ago (a clock set back counts as due).
export function updateDue({ enabled = true, lastCheck = 0, now = Date.now() } = {}) {
  if (!enabled) return false;
  const last = Number(lastCheck) || 0;
  return last > now || now - last >= UPDATE_EVERY_MS;
}

// ---- files --------------------------------------------------------------------

// What the desktop app opens; the same list as OPENABLE in src-tauri/src/lib.rs.
export const OPEN_TYPES = Object.freeze({
  longitude: "application/x-longitude",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
});

export function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ""));
  return m ? m[1].toLowerCase() : "";
}

export function mimeForName(name) {
  return OPEN_TYPES[extOf(name)] || "";
}

// "project" | "image" | "font" | null, as fileKind in ui/commands-core.js sorts them.
export function fileRoute(name) {
  const type = mimeForName(name);
  if (type === "application/x-longitude") return "project";
  if (type.startsWith("font/")) return "font";
  if (type.startsWith("image/")) return "image";
  return null;
}

// Bytes from a Tauri command: an ArrayBuffer for tauri::ipc::Response, a
// typed array or a plain number array from older bridges. Null otherwise.
export function toBytes(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return Uint8Array.from(data);
  return null;
}

// ---- saving -------------------------------------------------------------------

const SAVE_TYPES = {
  longitude: { description: "Longitude design", accept: { "application/x-longitude": [".longitude"] } },
  png: { description: "PNG image", accept: { "image/png": [".png"] } },
  jpg: { description: "JPEG image", accept: { "image/jpeg": [".jpg", ".jpeg"] } },
  webp: { description: "WebP image", accept: { "image/webp": [".webp"] } },
  avif: { description: "AVIF image", accept: { "image/avif": [".avif"] } },
  gif: { description: "GIF image", accept: { "image/gif": [".gif"] } },
  zip: { description: "Zip archive", accept: { "application/zip": [".zip"] } },
};
const EXT_BY_TYPE = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/avif": "avif", "image/gif": "gif", "application/zip": "zip" };

// Options for showSaveFilePicker. Designs start in Documents and exports in
// Pictures; each remembers the folder last used (the picker's id).
export function savePickerOptions(name, type = "") {
  let ext = extOf(name) || EXT_BY_TYPE[type] || "";
  if (ext === "jpeg") ext = "jpg";
  const project = ext === "longitude";
  const opts = { suggestedName: String(name || "longitude"), id: project ? "longitude-designs" : "longitude-exports", startIn: project ? "documents" : "pictures" };
  if (SAVE_TYPES[ext]) opts.types = [SAVE_TYPES[ext]];
  return opts;
}

// Asks where to save, then writes the file. Resolves "saved", "canceled"
// (the dialog was closed) or "downloaded" (no dialog here, or no click left
// to open one after a long export: the plain download ran instead). Rejects
// when writing fails.
export async function saveWithPicker(blob, name, { fallback, g = globalThis } = {}) {
  const pick = g?.showSaveFilePicker;
  if (typeof pick !== "function") {
    fallback?.();
    return "downloaded";
  }
  let handle;
  try {
    handle = await pick.call(g, savePickerOptions(name, blob?.type));
  } catch (err) {
    if (err?.name === "AbortError") return "canceled";
    fallback?.();
    return "downloaded";
  }
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (err) {
    try {
      await writable.abort();
    } catch {}
    throw err;
  }
  return "saved";
}

// compress.js download() asks for this: fn(blob, name, fallback) -> Promise<boolean>, or null in a browser.
let saver = null;
export function saveHandler() {
  return saver;
}

// ---- the page -----------------------------------------------------------------

export function isTextField(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.isContentEditable || el.closest?.('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]')) return true;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName !== "INPUT") return false;
  const type = String(el.getAttribute?.("type") || "text").toLowerCase();
  return ["text", "search", "url", "email", "tel", "password", "number"].includes(type);
}

// Browser shortcuts with no place in the app: print, find, find next, view
// source, downloads, caret browsing, back and forward.
export function blockedShortcut(e) {
  const key = String(e?.key || "");
  const mod = !!(e?.ctrlKey || e?.metaKey);
  if (mod && !e.altKey && ["p", "f", "g", "u", "j"].includes(key.toLowerCase())) return true;
  if (key === "F3" || key === "F7") return true;
  if (e?.altKey && !mod && (key === "ArrowLeft" || key === "ArrowRight" || key === "Home")) return true;
  return key === "BrowserBack" || key === "BrowserForward" || key === "BrowserHome";
}

// An http(s) link to another site, as an absolute URL, or null (same-origin, mailto:, javascript:, broken).
export function externalUrl(href, base) {
  try {
    const u = new URL(String(href ?? ""), base);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.origin === new URL(base).origin) return null;
    return u.href;
  } catch {
    return null;
  }
}

// ---- install ------------------------------------------------------------------

// opts.openFiles(files): opens files the way "Open a file" does (main.js passes commands-core's openFiles).
// opts.flush(): resolves once pending autosaves are written (main.js passes flushBriefly).
// opts.preload(): loads the export module after start (main.js passes ondemand's loadCompress), so every save,
//   "Save a copy" included, goes through the Save dialog. The files are on this computer: it costs nothing.
export function installDesktop(ctx, { openFiles, flush, preload } = {}) {
  const g = globalThis;
  if (!isDesktop(g) || !g.document) return null;
  const doc = g.document;
  doc.documentElement.dataset.desktop = "tauri";
  const api = tauri(g);
  const toast = (msg, opts) => ctx.ui?.toast?.(msg, opts);

  const openExternal = async (url) => {
    const target = externalUrl(url, g.location?.href || "http://tauri.localhost/");
    if (!target) return false;
    try {
      if (api) {
        await api.invoke("open_url", { url: target });
        return true;
      }
    } catch (err) {
      console.warn("Longitude: could not open the link.", err);
    }
    toast("That link could not be opened.", { kind: "error" });
    return false;
  };

  saver = async (blob, name, fallback) => {
    try {
      return (await saveWithPicker(blob, name, { fallback, g })) !== "canceled";
    } catch (err) {
      console.error(err);
      toast(`${name} could not be saved. ${err?.message || ""}`.trim(), { kind: "error" });
      return false;
    }
  };

  // Links to other sites open in the default browser, never in a window of the app.
  const onLink = (e) => {
    if (e.defaultPrevented || (e.type === "auxclick" && e.button !== 1)) return;
    const a = e.target?.closest?.("a[href]");
    if (!a || a.hasAttribute("download")) return;
    const url = externalUrl(a.getAttribute("href"), g.location?.href);
    if (!url) return;
    e.preventDefault();
    openExternal(url);
  };
  doc.addEventListener("click", onLink, true);
  doc.addEventListener("auxclick", onLink, true);

  // The browser's menu (Back, Reload, Print, Save page) only where text is
  // edited; the canvas and the panels bring their own.
  doc.addEventListener("contextmenu", (e) => {
    if (!e.defaultPrevented && !isTextField(e.target)) e.preventDefault();
  });
  // After the app's own key handlers (keyboard.js listens on window too).
  g.addEventListener("keydown", (e) => {
    if (blockedShortcut(e)) e.preventDefault();
  });
  // Mouse back and forward buttons.
  const noHistory = (e) => {
    if (e.button === 3 || e.button === 4) e.preventDefault();
  };
  g.addEventListener("mousedown", noHistory);
  g.addEventListener("mouseup", noHistory);

  // The window title follows the page's ("Design name · Longitude").
  const win = (() => {
    try {
      return api?.window?.getCurrentWindow?.() || null;
    } catch {
      return null;
    }
  })();
  const titleEl = doc.querySelector("title");
  if (win?.setTitle && titleEl) {
    let last = "";
    const syncTitle = () => {
      const t = doc.title || "Longitude";
      if (t === last) return;
      last = t;
      Promise.resolve(win.setTitle(t)).catch(() => {});
    };
    if (typeof g.MutationObserver === "function") new g.MutationObserver(syncTitle).observe(titleEl, { childList: true, characterData: true, subtree: true });
    syncTitle();
  }

  // Files handed over by the system: the first launch's arguments, then any
  // later launch (the Rust side queues them; this side takes them).
  let booted = false;
  let resolveBoot = () => {};
  const bootPromise = new Promise((r) => (resolveBoot = r));
  const takeFiles = async () => {
    if (!api) return [];
    let list = [];
    try {
      list = await api.invoke("take_opened_files");
    } catch (err) {
      console.warn("Longitude: could not ask for the files to open.", err);
      return [];
    }
    const files = [];
    for (const f of Array.isArray(list) ? list : []) {
      try {
        const bytes = toBytes(await api.invoke("read_opened_file", { id: f.id }));
        if (!bytes) throw Error("No data");
        files.push(new File([bytes], String(f.name || "file"), { type: mimeForName(f.name) }));
      } catch (err) {
        console.warn(`Longitude: could not read ${f?.name}.`, err);
        toast(`${f?.name || "A file"} could not be opened. ${typeof err === "string" ? err : err?.message || ""}`.trim(), { kind: "error" });
      }
    }
    return files;
  };
  let openQueue = Promise.resolve();
  const openLater = () => {
    openQueue = openQueue
      .then(() => bootPromise)
      .then(takeFiles)
      .then((files) => (files.length ? openFiles?.(files) : null))
      .catch((err) => console.error(err));
  };
  api?.listen?.(EVENTS.openFiles, openLater)?.catch?.(() => {});

  // Closing: save, then close (src-tauri/src/lib.rs waits up to 4 s for this).
  let closing = false;
  const onClose = async () => {
    if (closing) return;
    closing = true;
    try {
      // The same save the page makes when a browser tab closes (autosave, rescue copy, prefs).
      g.dispatchEvent?.(new Event("pagehide"));
      await Promise.race([Promise.resolve(flush?.()), sleep(2500)]);
    } catch (err) {
      console.error(err);
    }
    api.invoke("close_now").catch(() => {});
  };
  if (api?.listen) {
    Promise.resolve(api.listen(EVENTS.closeRequested, onClose))
      .then(() => api.invoke("close_handshake"))
      .catch((err) => console.warn("Longitude: closing will not wait for the last save.", err));
  }

  // Updates: a look at the latest GitHub release, at most once a day.
  const checkForUpdates = async ({ manual = false } = {}) => {
    let json = null;
    try {
      const res = await g.fetch(RELEASES_API, { headers: { Accept: "application/vnd.github+json" }, credentials: "omit", cache: "no-store" });
      if (res.status !== 404) {
        if (!res.ok) throw Error(`GitHub answered ${res.status}`);
        json = await res.json();
      }
    } catch (err) {
      console.warn("Longitude: update check failed.", err);
      if (manual) toast("GitHub could not be reached to check for updates. Try again later.", { kind: "warn", id: "app-update" });
      return null;
    }
    ctx.prefs.set("updateCheckedAt", Date.now());
    const rel = newerRelease(json, ctx.version);
    if (!rel) {
      if (manual) toast(`Longitude ${ctx.version} is the latest version.`, { kind: "ok", id: "app-update" });
      return null;
    }
    if (!manual && ctx.prefs.get("updateSkipped") === rel.version) return rel;
    toast(`Longitude ${rel.version} is available. You have ${ctx.version}.`, {
      id: "app-update",
      timeout: 0,
      action: [
        { label: "Download", run: () => openExternal(rel.url) },
        { label: "Skip this version", run: () => ctx.prefs.set("updateSkipped", rel.version) },
      ],
    });
    return rel;
  };
  const maybeCheck = () => {
    if (updateDue({ enabled: ctx.prefs.get("updateCheck", true) !== false, lastCheck: ctx.prefs.get("updateCheckedAt", 0) })) checkForUpdates();
  };
  // Turned back on (the command below, or a switch in Settings on the same pref): check now if a day has passed.
  try {
    ctx.on?.("prefs", ({ key, value } = {}) => {
      if (key === "updateCheck" && value !== false && booted) maybeCheck();
    });
  } catch {}

  const reg = (def) => {
    try {
      ctx.commands?.register?.(def);
    } catch (err) {
      console.warn(`Longitude: could not register ${def.id}: ${err.message}`);
    }
  };
  reg({
    id: "app.check-updates",
    title: "Check for updates",
    group: "App",
    icon: "download",
    home: true,
    allowInFields: true,
    keywords: "update new version release download github",
    run: () => checkForUpdates({ manual: true }),
  });
  reg({
    id: "app.update-checks",
    title: "Automatic update checks on or off",
    group: "App",
    icon: "refresh-cw",
    home: true,
    keywords: "update check daily automatic github network privacy",
    run: () => {
      const on = ctx.prefs.get("updateCheck", true) === false;
      ctx.prefs.set("updateCheck", on);
      toast(on ? "Longitude looks for a new version once a day." : "Automatic update checks are off. Run Check for updates from the command palette any time.", { kind: "ok", id: "app-update" });
    },
  });

  // What the installer bundled (vendor/manifest.json): { runtime, models: [file names] }.
  const bundled = async () => {
    try {
      const res = await g.fetch(vendorUrl("manifest.json"), { cache: "no-store" });
      const m = res.ok ? await res.json() : null;
      return { runtime: !!m?.ort?.version, models: Object.keys(m?.models || {}) };
    } catch {
      return { runtime: false, models: [] };
    }
  };

  const desktop = {
    app: "tauri",
    // Files from the first launch's command line, for main.js to open instead of the last design.
    launchFiles: () => takeFiles(),
    // main.js: the app has finished starting; later launches may open files now, and the daily check may run.
    bootDone() {
      if (booted) return;
      booted = true;
      resolveBoot();
      setTimeout(() => {
        try {
          Promise.resolve(preload?.()).catch(() => {});
        } catch {}
      }, 1500);
      setTimeout(maybeCheck, 6000);
      setInterval(maybeCheck, 60 * 60 * 1000);
    },
    checkForUpdates,
    openExternal,
    bundled,
  };
  ctx.desktop = desktop;
  return desktop;
}
