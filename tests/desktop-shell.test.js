// The desktop shell around the page: detection, where the bundled background
// remover is loaded from, browser shortcuts and menus, links, and the parts of
// src-tauri/tauri.conf.json the page depends on (versions, CSP, headers).
//   deno test --allow-read tests/desktop-shell.test.js

import assert from "node:assert/strict";
import { blockedShortcut, externalUrl, installDesktop, isDesktop, isTextField, tauri, RELEASES_API } from "../web/js/app/desktop.js";
import { BG_CONFIG, desktopVendorBase, vendorUrl } from "../web/js/features/bgremove/config.js";
import { VERSION } from "../web/js/app/context.js";

const read = (path) => Deno.readTextFile(new URL(`../${path}`, import.meta.url));
const conf = JSON.parse(await read("src-tauri/tauri.conf.json"));

Deno.test("detection: only a page inside the desktop app", () => {
  assert.equal(isDesktop({}), false);
  assert.equal(isDesktop(globalThis), false, "Deno is no desktop app");
  assert.equal(tauri({}), null);
  assert.equal(isDesktop({ __TAURI_INTERNALS__: {} }), true);
  const invoke = () => {};
  const listen = () => {};
  const t = tauri({ __TAURI__: { core: { invoke }, event: { listen } } });
  assert.equal(t.invoke, invoke);
  assert.equal(t.listen, listen);
  assert.equal(tauri({ __TAURI__: { core: {} } }), null, "no invoke, no API");
  assert.equal(installDesktop({ ui: {} }), null, "installDesktop does nothing in a browser");
});

Deno.test("the bundled background remover loads from the vendor protocol in the app, web/vendor/ elsewhere", () => {
  assert.equal(desktopVendorBase(undefined), null);
  assert.equal(desktopVendorBase(new URL("http://localhost:8770/")), null);
  assert.equal(desktopVendorBase(new URL("https://longitude.example/app/")), null);
  assert.equal(desktopVendorBase(new URL("http://tauri.localhost/index.html")), "http://vendor.localhost/");
  assert.equal(desktopVendorBase(new URL("https://tauri.localhost/")), "https://vendor.localhost/");
  assert.equal(desktopVendorBase(new URL("tauri://localhost/js/features/bgremove/worker.js")), "vendor://localhost/");

  const win = new URL("http://tauri.localhost/");
  assert.equal(vendorUrl("manifest.json", win), "http://vendor.localhost/manifest.json");
  assert.equal(vendorUrl("ort/", win), "http://vendor.localhost/ort/");
  assert.equal(new URL("ort-wasm-simd-threaded.wasm", vendorUrl("ort/", win)).href, "http://vendor.localhost/ort/ort-wasm-simd-threaded.wasm");
  assert.equal(vendorUrl("models/isnet-general-int8.onnx", new URL("tauri://localhost/")), "vendor://localhost/models/isnet-general-int8.onnx");
  assert.ok(vendorUrl("models/x.onnx", new URL("http://localhost:8770/")).endsWith("/web/vendor/models/x.onnx"), "the browser keeps web/vendor/");
  assert.ok(vendorUrl("models/x.onnx").endsWith("/web/vendor/models/x.onnx"), "no location: web/vendor/");

  const saved = BG_CONFIG.vendorDir;
  try {
    BG_CONFIG.vendorDir = "my-models/";
    assert.ok(vendorUrl("manifest.json", win).endsWith("/web/my-models/manifest.json"), "a mod's own folder wins in the app too");
  } finally {
    BG_CONFIG.vendorDir = saved;
  }
});

Deno.test("the vendor protocol serves exactly the paths the page asks for", async () => {
  const rust = await read("src-tauri/src/lib.rs");
  assert.match(rust, /register_asynchronous_uri_scheme_protocol\("vendor"/);
  assert.match(rust, /const VENDOR_DIR: &str = "vendor";/);
  assert.deepEqual(conf.bundle.resources, { "vendor/": "vendor/" }, "installed next to the program as <install>/vendor/");
  // Files fetch_model.py writes: plain names the protocol's path check accepts.
  const plain = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  const files = ["manifest.json"];
  for (const b of Object.values(BG_CONFIG.ort.builds)) for (const k of ["script", "glue", "wasm"]) files.push(`ort/${b[k].file}`);
  for (const m of Object.values(BG_CONFIG.models)) for (const v of Object.values(m.variants)) files.push(`models/${v.file}`);
  for (const f of files) for (const seg of f.split("/")) assert.match(seg, plain, f);
  for (const f of files.filter((x) => /\.(mjs|wasm)$/.test(x))) assert.ok(/"mjs" \| "js" => "text\/javascript/.test(rust) && /"wasm" => "application\/wasm"/.test(rust), `${f} gets a MIME type a module import and WebAssembly accept`);
});

Deno.test("blockedShortcut: print, find, view source, caret browsing, back; never the app's keys", () => {
  const k = (key, mods = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
  for (const e of [k("p", { ctrlKey: true }), k("P", { ctrlKey: true, shiftKey: true }), k("f", { ctrlKey: true }), k("g", { ctrlKey: true }), k("u", { ctrlKey: true }), k("j", { ctrlKey: true }), k("p", { metaKey: true }), k("F3"), k("F7"), k("ArrowLeft", { altKey: true }), k("ArrowRight", { altKey: true }), k("BrowserBack")]) {
    assert.equal(blockedShortcut(e), true, JSON.stringify(e));
  }
  // Longitude's own shortcuts (and reload, which autosave makes safe) stay with the app.
  for (const e of [k("z", { ctrlKey: true }), k("s", { ctrlKey: true }), k("e", { ctrlKey: true }), k("k", { ctrlKey: true }), k("o", { ctrlKey: true }), k("r", { ctrlKey: true }), k("F5"), k("p"), k("f"), k("ArrowLeft"), k("ArrowLeft", { altKey: true, ctrlKey: true }), k("H", { ctrlKey: true, shiftKey: true })]) {
    assert.equal(blockedShortcut(e), false, JSON.stringify(e));
  }
});

Deno.test("blocked shortcuts are bound to no command", async () => {
  const src = [];
  for (const dir of ["web/js", "web/mods"]) {
    const walk = async (d) => {
      for await (const e of Deno.readDir(new URL(`../${d}`, import.meta.url))) {
        if (e.isDirectory) await walk(`${d}/${e.name}`);
        else if (e.name.endsWith(".js")) src.push(await read(`${d}/${e.name}`));
      }
    };
    await walk(dir);
  }
  const keys = src.join("\n").match(/keys: \[[^\]]*\]/g) || [];
  for (const combo of ["Mod+P", "Mod+F", "Mod+G", "Mod+U", "Mod+J", "F3", "F7", "Alt+ArrowLeft", "Alt+ArrowRight"]) {
    assert.ok(!keys.some((k) => k.includes(`"${combo}"`)), `${combo} is a command shortcut`);
  }
});

Deno.test("isTextField: inputs that take text, textareas, contenteditable", () => {
  const el = (tagName, attrs = {}, extra = {}) => ({ nodeType: 1, tagName, getAttribute: (n) => attrs[n] ?? null, closest: () => null, ...extra });
  assert.equal(isTextField(el("INPUT")), true, "no type is text");
  assert.equal(isTextField(el("INPUT", { type: "search" })), true);
  assert.equal(isTextField(el("INPUT", { type: "NUMBER" })), true);
  assert.equal(isTextField(el("TEXTAREA")), true);
  assert.equal(isTextField(el("DIV", {}, { isContentEditable: true })), true);
  assert.equal(isTextField(el("SPAN", {}, { closest: () => ({}) })), true, "inside a contenteditable");
  assert.equal(isTextField(el("INPUT", { type: "range" })), false);
  assert.equal(isTextField(el("INPUT", { type: "checkbox" })), false);
  assert.equal(isTextField(el("BUTTON")), false);
  assert.equal(isTextField(el("CANVAS")), false);
  assert.equal(isTextField(null), false);
  assert.equal(isTextField({ nodeType: 3 }), false, "a text node");
});

Deno.test("externalUrl: other sites over http(s) only", () => {
  const base = "http://tauri.localhost/index.html";
  assert.equal(externalUrl("https://github.com/zphat/Longitude", base), "https://github.com/zphat/Longitude");
  assert.equal(externalUrl("http://example.com/a?b#c", base), "http://example.com/a?b#c");
  assert.equal(externalUrl("docs/MODDING.md", base), null, "same origin");
  assert.equal(externalUrl("http://tauri.localhost/x", base), null);
  assert.equal(externalUrl("#top", base), null);
  assert.equal(externalUrl("mailto:someone@example.com", base), null);
  assert.equal(externalUrl("javascript:alert(1)", base), null);
  assert.equal(externalUrl("file:///C:/Windows/notepad.exe", base), null);
  assert.equal(externalUrl("ms-settings:", base), null);
  assert.equal(externalUrl("http://[bad", base), null);
});

Deno.test("one version everywhere: tauri.conf.json, Cargo.toml, package.json, the page", async () => {
  const cargo = await read("src-tauri/Cargo.toml");
  const pkg = JSON.parse(await read("package.json"));
  const cargoVersion = cargo.match(/^\[package\][\s\S]*?^version = "([^"]+)"/m)?.[1];
  assert.equal(conf.version, VERSION);
  assert.equal(cargoVersion, VERSION);
  assert.equal(pkg.version, VERSION);
  assert.equal(conf.identifier, "app.longitude.desktop");
  assert.equal(conf.productName, "Longitude");
});

Deno.test("main window: no white flash, HTML5 file drops, sizes", () => {
  const [w] = conf.app.windows;
  assert.equal(conf.app.withGlobalTauri, true, "desktop.js reads window.__TAURI__");
  assert.equal(w.label, "main", "lib.rs and the capability use this label");
  assert.equal(w.dragDropEnabled, false, "otherwise WebView2 swallows dropped files");
  assert.equal(w.backgroundColor.toLowerCase(), "#07080a", "the Signal workspace (--workspace)");
  assert.equal(w.theme, "Dark");
  // Windows keeps a window at its minimum even when maximized, so the minimum
  // must fit a 1366 x 768 screen at 125% (about 1093 x 543 inside a maximized
  // window). The page has layouts down to 759 px wide and 560 px tall, and the
  // tool rail scrolls below that.
  assert.ok(w.minWidth >= 720 && w.minWidth <= 860 && w.minHeight >= 480 && w.minHeight <= 540, "min size must fit a 1366x768 screen at 125%");
  assert.equal(conf.build.frontendDist, "../web");
  assert.equal(conf.bundle.windows.nsis.installMode, "currentUser");
});

Deno.test("cross-origin isolation headers, so the background remover can use threads", () => {
  const h = conf.app.security.headers;
  assert.equal(h["Cross-Origin-Opener-Policy"], "same-origin");
  assert.ok(["require-corp", "credentialless"].includes(h["Cross-Origin-Embedder-Policy"]));
});

Deno.test("the CSP allows every host the app talks to, and nothing it does not", async () => {
  const csp = conf.app.security.csp;
  const list = (d) => (Array.isArray(csp[d]) ? csp[d] : String(csp[d] || "").split(/\s+/)).filter(Boolean);
  const allowed = (directive, url) => {
    const u = new URL(url);
    return list(directive).some((src) => {
      if (src === "'self'") return false;
      if (/^[a-z][a-z0-9+.-]*:$/.test(src)) return u.protocol === src;
      const m = /^([a-z][a-z0-9+.-]*):\/\/(\*\.)?([^/:]+)$/.exec(src);
      if (!m || u.protocol !== `${m[1]}:`) return false;
      return m[2] ? u.hostname.endsWith(`.${m[3]}`) : u.hostname === m[3];
    });
  };
  // Every remote URL in the background remover's config, and where Hugging Face redirects downloads.
  const urls = [BG_CONFIG.ort.base, RELEASES_API];
  for (const m of Object.values(BG_CONFIG.models)) for (const v of Object.values(m.variants)) urls.push(v.url);
  urls.push("https://cdn-lfs.huggingface.co/x", "https://cdn-lfs-us-1.hf.co/x", "https://cas-bridge.xethub.hf.co/x");
  for (const u of urls) assert.ok(allowed("connect-src", u), `connect-src allows ${u}`);
  // The bundled files: fetched, and imported as a module (the runtime).
  for (const u of ["http://vendor.localhost/manifest.json", "vendor://localhost/manifest.json"]) {
    assert.ok(allowed("connect-src", u), u);
    assert.ok(allowed("script-src", u), u);
  }
  assert.ok(list("script-src").includes("'wasm-unsafe-eval'"), "WebAssembly may compile");
  assert.ok(list("script-src").includes("blob:"), "the runtime's thread script loads from a blob");
  assert.ok(list("worker-src").includes("blob:") && list("worker-src").includes("'self'"));
  assert.ok(list("connect-src").includes("ipc:") && list("connect-src").includes("http://ipc.localhost"), "Tauri's IPC");
  assert.ok(!list("script-src").includes("'unsafe-eval'") && !list("script-src").includes("'unsafe-inline'"));
  assert.ok(list("style-src").includes("'unsafe-inline'"), "inline style attributes and mod <style> tags");
  assert.deepEqual(conf.app.security.dangerousDisableAssetCspModification, ["style-src"], "a style nonce would switch 'unsafe-inline' off");
  for (const d of ["img-src", "font-src"]) for (const s of ["'self'", "data:", "blob:"]) assert.ok(list(d).includes(s), `${d} ${s}`);
  assert.ok(!allowed("connect-src", "https://example.com/"), "no other site");
  assert.ok(!allowed("img-src", "https://example.com/a.png"), "no remote images");
});

Deno.test("every remote URL in the app's code is covered by the CSP", async () => {
  const csp = conf.app.security.csp;
  const hosts = (Array.isArray(csp["connect-src"]) ? csp["connect-src"] : []).join(" ");
  const seen = new Set();
  const walk = async (d) => {
    for await (const e of Deno.readDir(new URL(`../${d}`, import.meta.url))) {
      if (e.isDirectory) await walk(`${d}/${e.name}`);
      else if (e.name.endsWith(".js")) {
        const text = await read(`${d}/${e.name}`);
        for (const m of text.matchAll(/fetch\(\s*["'`](https?:\/\/[^/"'`]+)/g)) seen.add(m[1]);
      }
    }
  };
  await walk("web/js");
  for (const origin of seen) assert.ok(hosts.includes(origin), `${origin} is fetched but not in connect-src`);
});
