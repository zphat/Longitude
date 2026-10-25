// Longitude service worker: makes the app open offline after the first visit.
//
//   app shell (html, css, js, fonts, icons)  cache first, versioned cache
//   mods/ and presets/                       network first, cached copy offline
//   vendor/, models, cross-origin requests   passed through untouched
//
// Cache first is fast and works offline, but would keep serving old files
// after an update. So after each page load (when the page sends its file
// list) the worker quietly re-checks the cached shell. Changed files are
// staged as one set in a separate cache and only switched in when a page next
// opens, so a page starts on one consistent set of files; open pages are told,
// and offer a reload. A new version of this worker waits until a page asks it
// to take over (also a reload). Files a page loads later (the dialogs,
// encoders and background removal) come from the shared cache, so when a page
// hears of an update it fetches and compiles all of them at once, from the
// files it started with (pinOnDemand in js/ui/ondemand.js), before a newer
// set can be switched in. (The background-removal worker starts with its own
// copy of its files.) Bump VERSION to start a fresh cache: every file
// the app can load is precached on install, and the files the old cache held
// beyond that (design fonts, say) are fetched again, so a bump never leaves
// the new cache incomplete. The offline copies of mods and presets carry over.
// ?nosw loads from the network and removes this worker.
//
// tests/shell-boot.test.js checks that PRECACHE lists every file main.js can
// reach (static and dynamic imports, the worker, stylesheets, the UI fonts).

const VERSION = "0.1.0-4";
const SHELL = `longitude-shell-${VERSION}`;
const DATA = `longitude-data-${VERSION}`;
const NEXT = `longitude-next-${VERSION}`;
const OURS = /^longitude-(shell|data|next)-/;
const SCOPE = new URL("./", self.location.href);
const READY = new URL("__longitude-next-ready", SCOPE).href;

const PRECACHE = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/icon-192.png",
  // Every stylesheet index.html links, and the interface fonts.
  "css/tokens.css",
  "css/controls.css",
  "css/app.css",
  "css/editor.css",
  "css/draw.css",
  "css/inspector.css",
  "fonts/ui/manrope.woff2",
  "fonts/ui/syne.woff2",
  "fonts/ui/spacemono-400.woff2",
  "fonts/ui/spacemono-700.woff2",
  "fonts/fonts.json",
  // Everything main.js imports at start.
  "js/main.js",
  "js/app/context.js",
  "js/app/desktop.js",
  "js/core/assets.js",
  "js/core/effects.js",
  "js/core/filters.js",
  "js/core/fonts.js",
  "js/core/geometry.js",
  "js/core/model.js",
  "js/core/project.js",
  "js/core/render.js",
  "js/core/shapes.js",
  "js/core/store.js",
  "js/core/textlayout.js",
  "js/editor/clipboard.js",
  "js/editor/contextmenu.js",
  "js/editor/crop.js",
  "js/editor/cursors.js",
  "js/editor/importer.js",
  "js/editor/index.js",
  "js/editor/recognize.js",
  "js/editor/selection.js",
  "js/editor/snapping.js",
  "js/editor/stage.js",
  "js/editor/textedit.js",
  "js/editor/tools/arrow.js",
  "js/editor/tools/draw.js",
  "js/editor/tools/hand.js",
  "js/editor/tools/magic.js",
  "js/editor/tools/masklib.js",
  "js/editor/tools/pen.js",
  "js/editor/tools/refine.js",
  "js/editor/tools/select.js",
  "js/editor/tools/shape.js",
  "js/editor/tools/text.js",
  "js/editor/transform.js",
  "js/editor/viewport.js",
  "js/features/bgremove/config.js",
  "js/features/bgremove/index.js",
  "js/features/bgremove/pixels.js",
  "js/features/bgremove/trim.js",
  "js/features/presets.js",
  "js/mods/api.js",
  "js/mods/loader.js",
  "js/mods/packs.js",
  "js/mods/paths.js",
  "js/mods/ui.js",
  "js/ui/colorpicker.js",
  "js/ui/commands-core.js",
  "js/ui/controls.js",
  "js/ui/dom.js",
  "js/ui/fontpicker.js",
  "js/ui/home.js",
  "js/ui/icons.js",
  "js/ui/inspector.js",
  "js/ui/keyboard.js",
  "js/ui/layers.js",
  "js/ui/menus.js",
  "js/ui/ondemand.js",
  "js/ui/palette.js",
  "js/ui/quickbar.js",
  "js/ui/shell.js",
  "js/ui/theme.js",
  // Loaded on first use.
  "css/export.css",
  "css/mods.css",
  "js/ui/exportdialog.js",
  "js/ui/feedpreview.js",
  "js/ui/quicktools.js",
  "js/ui/settings.js",
  "js/features/compress.js",
  "js/features/png8.js",
  "js/features/zip.js",
  "js/features/bgremove/mask.js",
  "js/features/bgremove/engine.js",
  "js/features/bgremove/pipeline.js",
  "js/features/bgremove/runner.js",
  "js/features/bgremove/worker.js",
];
const SHELL_EXT = /\.(html|css|js|mjs|json|woff2?|ttf|otf|svg|png|webp|ico|webmanifest)$/i;
const RECHECK_EVERY = 15000;

// Pages opened with ?nosw: everything they ask for comes from the network.
const bypass = new Set();

function relPath(url) {
  return url.href.startsWith(SCOPE.href) ? url.pathname.slice(SCOPE.pathname.length) : null;
}

function route(request) {
  if (request.method !== "GET") return null;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return null;
  const rel = relPath(url);
  if (rel === null) return null;
  if (rel.startsWith("vendor/") || /\.(onnx|wasm|ort)$/i.test(rel) || rel === "sw.js") return null;
  if (rel.startsWith("mods/") || rel.startsWith("presets/")) return "data";
  if (request.mode === "navigate" || rel === "" || SHELL_EXT.test(rel)) return "shell";
  return null;
}

// Only complete, same-origin, successful responses are kept. Never errors.
function cacheable(res) {
  return !!res && res.ok && res.type === "basic" && res.status !== 206;
}

async function put(cacheName, request, response) {
  if (!cacheable(response)) return false;
  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, response);
    return true;
  } catch {
    // Storage full or the request cannot be cached: serving still works.
    return false;
  }
}

const pageKey = () => new Request(new URL("./", SCOPE).href);

// Work on the staged cache runs one step at a time, so a page never opens on
// a half-switched shell.
let gate = Promise.resolve();
function serial(fn) {
  const run = gate.then(fn, fn);
  gate = run.catch(() => {});
  return run;
}

// Switches the staged files in, all at once, before a page starts loading.
function promote() {
  return serial(async () => {
    if (!(await caches.has(NEXT))) return;
    const next = await caches.open(NEXT);
    if (!(await next.match(READY))) return;
    const shell = await caches.open(SHELL);
    for (const req of await next.keys()) {
      if (req.url === READY) continue;
      const res = await next.match(req);
      if (res) await shell.put(req, res);
    }
    await caches.delete(NEXT);
  }).catch(() => {});
}

async function cacheFirst(event) {
  const req = event.request;
  const navigate = req.mode === "navigate";
  if (navigate) {
    // ?nosw: straight from the network, and this worker goes away.
    if (new URL(req.url).searchParams.has("nosw")) {
      if (event.resultingClientId) bypass.add(event.resultingClientId);
      event.waitUntil(self.registration.unregister().catch(() => {}));
      return fetch(req);
    }
    // A page about to load is the one safe moment to switch to updated files.
    await promote();
  }
  const cache = await caches.open(SHELL);
  const hit = navigate ? (await cache.match(pageKey())) || (await cache.match(req, { ignoreSearch: true })) : await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    event.waitUntil(put(SHELL, navigate ? pageKey() : req, res.clone()));
    return res;
  } catch (err) {
    if (navigate) {
      const page = (await cache.match(pageKey())) || (await cache.match(new URL("index.html", SCOPE).href));
      if (page) return page;
    }
    throw err;
  }
}

// The offline copy is one entry per file: a cache-busting query (a mod
// reloaded from disk) updates that entry instead of adding a new one.
function dataKey(req) {
  const url = new URL(req.url);
  if (!url.search) return req;
  url.search = "";
  return new Request(url.href);
}

async function networkFirst(event) {
  const req = event.request;
  const key = dataKey(req);
  try {
    const res = await fetch(req);
    event.waitUntil(put(DATA, key, res.clone()));
    return res;
  } catch (err) {
    const hit = await (await caches.open(DATA)).match(key);
    if (hit) return hit;
    throw err;
  }
}

// ---- keeping the cached shell current --------------------------------------------

async function sameBody(a, b) {
  const tag = (r, k) => r.headers.get(k);
  if (tag(a, "etag") && tag(b, "etag")) return tag(a, "etag") === tag(b, "etag");
  if (tag(a, "last-modified") && tag(b, "last-modified")) {
    return tag(a, "last-modified") === tag(b, "last-modified") && tag(a, "content-length") === tag(b, "content-length");
  }
  const [x, y] = await Promise.all([a.clone().arrayBuffer(), b.clone().arrayBuffer()]);
  if (x.byteLength !== y.byteLength) return false;
  const [hx, hy] = await Promise.all([crypto.subtle.digest("SHA-256", x), crypto.subtle.digest("SHA-256", y)]);
  const ax = new Uint8Array(hx);
  const ay = new Uint8Array(hy);
  return ax.every((v, i) => v === ay[i]);
}

let lastCheck = 0;
let checking = null;

function recheck() {
  if (checking || Date.now() - lastCheck < RECHECK_EVERY) return checking || Promise.resolve();
  lastCheck = Date.now();
  checking = (async () => {
    const shell = await caches.open(SHELL);
    const keys = await shell.keys();
    const changed = [];
    for (let i = 0; i < keys.length; i += 6) {
      await Promise.all(
        keys.slice(i, i + 6).map(async (req) => {
          try {
            const old = await shell.match(req);
            const res = await fetch(req.url, { cache: "no-cache" });
            if (!cacheable(res) || (old && (await sameBody(old, res)))) return;
            changed.push([req, res]);
          } catch {}
        }),
      );
    }
    if (!changed.length) return;
    // Every changed file is fetched before any is staged; the set replaces
    // whatever an earlier check staged and is marked ready last.
    await serial(async () => {
      await caches.delete(NEXT);
      const next = await caches.open(NEXT);
      for (const [req, res] of changed) await next.put(req, res);
      await next.put(new Request(READY), new Response("ready"));
    });
    for (const client of await self.clients.matchAll({ type: "window" })) client.postMessage({ type: "longitude-updated", changed: changed.length });
  })()
    .catch(() => {})
    .finally(() => (checking = null));
  return checking;
}

// ---- lifecycle --------------------------------------------------------------------------

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      // One by one, so a missing file never blocks the install.
      await Promise.all(
        PRECACHE.map(async (path) => {
          const url = new URL(path, SCOPE).href;
          try {
            await put(SHELL, new Request(url), await fetch(url, { cache: "reload" }));
          } catch {}
        }),
      );
      await carryShell();
    })(),
  );
});

// After a VERSION bump: whatever else the old shell cache held (design fonts,
// files loaded on a path PRECACHE does not list) is fetched fresh into the new
// one, a few at a time, so the new version starts as complete offline as the
// old one. Old copies are never moved across: they may be out of date.
async function carryShell() {
  try {
    const shell = await caches.open(SHELL);
    const want = new Set();
    for (const key of await caches.keys()) {
      if (key === SHELL || !/^longitude-shell-/.test(key)) continue;
      for (const req of await (await caches.open(key)).keys()) {
        if (route(req) === "shell" && !(await shell.match(req))) want.add(req.url);
      }
    }
    const urls = [...want];
    for (let i = 0; i < urls.length; i += 6) {
      await Promise.all(
        urls.slice(i, i + 6).map(async (url) => {
          try {
            await put(SHELL, new Request(url), await fetch(url, { cache: "reload" }));
          } catch {}
        }),
      );
    }
  } catch {}
}

// The offline copies of mods and presets do not depend on the version: the
// old cache's entries move into the new one before it is deleted.
async function carryData(from) {
  try {
    const [src, dst] = await Promise.all([caches.open(from), caches.open(DATA)]);
    for (const req of await src.keys()) {
      if (await dst.match(req)) continue;
      const res = await src.match(req);
      if (res) await dst.put(req, res);
    }
  } catch {}
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (!OURS.test(key) || key === SHELL || key === DATA || key === NEXT) continue;
        if (/^longitude-data-/.test(key)) await carryData(key);
        await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.clientId && bypass.has(event.clientId)) return;
  const kind = route(event.request);
  if (kind === "shell") event.respondWith(cacheFirst(event));
  else if (kind === "data") event.respondWith(networkFirst(event));
});

self.addEventListener("message", (event) => {
  const msg = event.data;
  // The page agreed to switch to the waiting version (it reloads next).
  if (msg?.type === "skip-waiting") {
    self.skipWaiting();
    return;
  }
  // The page sends the files it loaded so the next visit works offline, then
  // the cached files are checked for updates.
  if (!msg || msg.type !== "cache-urls" || !Array.isArray(msg.urls)) return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      for (const u of msg.urls.slice(0, 600)) {
        let req;
        try {
          req = new Request(u);
        } catch {
          continue;
        }
        if (route(req) !== "shell" || (await cache.match(req))) continue;
        try {
          await put(SHELL, req, await fetch(req));
        } catch {}
      }
      await recheck();
    })(),
  );
});
