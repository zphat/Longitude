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
// opens, so no page ever runs a mix of old and new files; the open page is
// told, and offers a reload. A new version of this worker waits until the page
// asks it to take over (also a reload). Bump VERSION to drop every cached file
// at once. ?nosw loads from the network and removes this worker.

const VERSION = "0.1.0-2";
const SHELL = `longitude-shell-${VERSION}`;
const DATA = `longitude-data-${VERSION}`;
const NEXT = `longitude-next-${VERSION}`;
const OURS = /^longitude-(shell|data|next)-/;
const SCOPE = new URL("./", self.location.href);
const READY = new URL("__longitude-next-ready", SCOPE).href;

const PRECACHE = ["./", "index.html", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "css/tokens.css", "css/controls.css", "css/app.css", "js/main.js"];
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
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (OURS.test(key) && key !== SHELL && key !== DATA && key !== NEXT) await caches.delete(key);
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
