// Tests for web/js/mods/loader.js, api.js and paths.js
//   deno test --allow-read tests/mods-loader.test.js

import assert from "node:assert/strict";
import { isEnabled, loadMods, registerModCommands, validateEntry, validateIndex, validateManifest } from "../web/js/mods/loader.js";
import { buildModApi, createScope, scopeOf } from "../web/js/mods/api.js";
import { cleanModPath, resolveInside } from "../web/js/mods/paths.js";
import { makeCtx, memoryKv } from "./mods-helpers.js";

const BASE = "http://longitude.test/mods/";

// The loader logs every mod failure on purpose; keep the test output readable.
console.error = () => {};
console.warn = () => {};
const manifest = (id, extra = {}) => ({ id, name: `Mod ${id}`, version: "1.0.0", apiVersion: 1, ...extra });

// ---- paths and entries --------------------------------------------------------

Deno.test("cleanModPath: accepts plain relative paths inside web/mods", () => {
  assert.equal(cleanModPath("meme-classic/index.js"), "meme-classic/index.js");
  assert.equal(cleanModPath("  a/b/c.mjs "), "a/b/c.mjs");
  assert.equal(cleanModPath("pack/Font-Bold.woff2", { exts: [".woff2"], what: "font file" }), "pack/Font-Bold.woff2");
});

Deno.test("cleanModPath: rejects urls, absolute paths, traversal and odd characters", () => {
  const bad = [
    "", "   ", 42, null, "../evil.js", "a/../../evil.js", "./a.js", "a/./b.js", "/abs/index.js", "http://x.test/a.js",
    "https://cdn.test/a.js", "//cdn.test/a.js", "data:text/javascript,alert(1)", "javascript:alert(1)", "C:/mods/a.js",
    "a\\b.js", "a.js?x=1", "a.js#frag", "a b/index.js", "mod/index.txt", "mod/index", "a//b.js",
  ];
  for (const p of bad) assert.throws(() => cleanModPath(p), Error, `should reject ${JSON.stringify(p)}`);
});

Deno.test("resolveInside: stays inside the mods folder", () => {
  assert.equal(resolveInside("a/index.js", BASE), `${BASE}a/index.js`);
  assert.throws(() => resolveInside("../x.js", BASE));
  assert.throws(() => resolveInside("https://evil.test/x.js", BASE));
});

Deno.test("validateEntry: id rules match Latitude and enabled defaults to true", () => {
  assert.deepEqual(validateEntry({ id: "my-mod", entry: "my-mod/index.js" }), { id: "my-mod", entry: "my-mod/index.js", enabled: true });
  assert.equal(validateEntry({ id: "ab", entry: "ab/index.js", enabled: false }).enabled, false);
  for (const id of ["a", "My-mod", "1mod", "mod_x", "mod.x", "a".repeat(52), "", undefined]) {
    assert.throws(() => validateEntry({ id, entry: "x/index.js" }), Error, `id ${id}`);
  }
  assert.throws(() => validateEntry({ id: "ok-mod", entry: "../x.js" }), /ok-mod/);
  assert.throws(() => validateEntry("nope"));
});

Deno.test("validateIndex: skips bad entries, reports them, drops duplicates", () => {
  const { mods, errors } = validateIndex({
    mods: [
      { id: "one", entry: "one/index.js" },
      { id: "two", entry: "https://x.test/two.js" },
      { id: "one", entry: "one/other.js" },
      { id: "three", entry: "three/index.js", enabled: false },
    ],
  });
  assert.deepEqual(mods.map((m) => m.id), ["one", "three"]);
  assert.equal(errors.length, 2);
  assert.match(errors[1], /listed twice/);
  assert.equal(validateIndex({}).mods.length, 0);
  assert.equal(validateIndex(null).errors.length, 1);
});

Deno.test("validateManifest: api version, id match, name and version", () => {
  const m = validateManifest(manifest("abc", { author: " Ada ", homepage: "http://insecure.test", extra: 1 }), "abc");
  assert.deepEqual(m, { id: "abc", name: "Mod abc", version: "1.0.0", author: "Ada", description: "", homepage: "", apiVersion: 1 });
  assert.equal(validateManifest(manifest("abc", { homepage: "https://ok.test/x" }), "abc").homepage, "https://ok.test/x");
  assert.throws(() => validateManifest(null, "abc"), /manifest/);
  assert.throws(() => validateManifest(manifest("abc", { apiVersion: 2 }), "abc"), /needs mod API 2/);
  assert.throws(() => validateManifest(manifest("abc", { apiVersion: undefined }), "abc"), /apiVersion: 1/);
  assert.throws(() => validateManifest(manifest("xyz"), "abc"), /does not match/);
  assert.throws(() => validateManifest(manifest("abc", { name: " " }), "abc"), /name/);
  assert.throws(() => validateManifest(manifest("abc", { version: "" }), "abc"), /version/);
});

Deno.test("isEnabled: saved choice wins over the mods.json default", () => {
  assert.equal(isEnabled({}, { id: "a", enabled: true }), true);
  assert.equal(isEnabled({ a: false }, { id: "a", enabled: true }), false);
  assert.equal(isEnabled({ a: true }, { id: "a", enabled: false }), true);
  assert.equal(isEnabled(null, { id: "a", enabled: false }), false);
});

// ---- scope and api ------------------------------------------------------------------

Deno.test("createScope: disposers run once, newest first, and the scope closes", () => {
  const scope = createScope();
  const log = [];
  const a = scope.track(() => log.push("a"), "commands");
  scope.track(() => log.push("b"), "shapes");
  scope.add(() => () => log.push("c"), "shapes");
  assert.deepEqual(scope.counts(), { commands: 1, shapes: 2 });
  a();
  a();
  assert.deepEqual(log, ["a"]);
  assert.deepEqual(scope.counts(), { shapes: 2 });
  scope.dispose();
  scope.dispose();
  assert.deepEqual(log, ["a", "c", "b"]);
  assert.equal(scope.size, 0);
  assert.throws(() => scope.add(() => () => {}), /turned off/);
});

Deno.test("buildModApi: frozen, versioned, and every register is undone by dispose", () => {
  const ctx = makeCtx();
  const api = buildModApi(ctx, manifest("demo"), { base: `${BASE}demo/index.js` });
  assert.ok(Object.isFrozen(api));
  assert.ok(Object.isFrozen(api.store));
  assert.equal(api.apiVersion, 1);
  assert.equal(api.id, "demo");
  assert.equal(api.url("icon.png"), `${BASE}demo/icon.png`);
  assert.equal(typeof api.store.setDoc, "undefined");
  assert.equal(typeof api.store.clearHistory, "undefined");

  api.commands.register({ id: "demo.hello", title: "Hello", run: () => "hi" });
  api.tools.register({ id: "demo-tool", label: "Demo" });
  api.inspector.register({ id: "demo", title: "Demo", when: () => true, render() {} });
  api.shapes.register({ id: "demo-shape", label: "Demo", path: () => null });
  api.filters.register({ id: "demo-filter", label: "Demo", params: [], apply: (img) => img });
  api.presets.register({ id: "demo-size", label: "Demo size", width: 500, height: 500 });
  api.fonts.register({ family: "Demo Sans", faces: [{ url: "demo.woff2" }] });
  api.themes.register({ name: "Demo theme", colors: ctx.themes.list()[0].colors });
  let heard = 0;
  api.events.on("ping", () => heard++);
  api.store.on("change", () => heard++);

  assert.ok(ctx.commands.get("demo.hello"));
  assert.equal(ctx.commands.get("demo.hello").mod, "demo");
  assert.ok(ctx.tools.get("demo-tool"));
  assert.ok(ctx.inspector.get("demo"));
  assert.ok(ctx.shapes.get("demo-shape"));
  assert.ok(ctx.filters.get("demo-filter"));
  assert.ok(ctx.presets.get("demo-size"));
  assert.equal(ctx.fonts.get("Demo Sans").def.base, `${BASE}demo/index.js`);
  assert.ok(ctx.themes.get("demo-demo-theme"));
  ctx.emit("ping");
  assert.equal(heard, 1);

  scopeOf(api).dispose();
  assert.equal(ctx.commands.get("demo.hello"), null);
  assert.equal(ctx.tools.get("demo-tool"), null);
  assert.equal(ctx.inspector.get("demo"), null);
  assert.equal(ctx.shapes.get("demo-shape"), null);
  assert.equal(ctx.filters.get("demo-filter"), null);
  assert.equal(ctx.presets.get("demo-size"), null);
  assert.equal(ctx.fonts.get("Demo Sans"), null);
  assert.equal(ctx.themes.get("demo-demo-theme"), null);
  ctx.emit("ping");
  ctx.store.add({ type: "text" });
  assert.equal(heard, 1);
  assert.throws(() => api.commands.register({ id: "demo.late", title: "Late", run() {} }), /turned off/);
});

Deno.test("buildModApi: commands get the mod api; errors are reported and gestures unwound", async () => {
  const ctx = makeCtx();
  const errors = [];
  const api = buildModApi(ctx, manifest("demo"), { onError: (err, where) => errors.push([err.message, where]) });
  let seen = null;
  api.commands.register({ id: "demo.who", title: "Who", when: (a) => a === api, run: (a, args) => (seen = [a, args]) });
  ctx.commands.run("demo.who", { x: 1 });
  assert.equal(seen[0], api);
  assert.deepEqual(seen[1], { x: 1 });

  api.commands.register({
    id: "demo.broken",
    title: "Broken",
    run: (a) => {
      a.store.begin("Half done");
      a.store.add({ type: "text" });
      throw Error("boom");
    },
  });
  ctx.commands.run("demo.broken");
  assert.equal(ctx.store.inGesture, false);
  assert.equal(ctx.store.layers().length, 0);
  assert.deepEqual(errors[0], ["boom", "command demo.broken"]);
  assert.equal(ctx.ui.toasts.at(-1).msg, "boom");

  api.commands.register({
    id: "demo.async-broken",
    title: "Async broken",
    run: async (a) => {
      a.store.begin("Half done");
      a.store.add({ type: "text" });
      await null;
      throw Error("later");
    },
  });
  await ctx.commands.run("demo.async-broken")?.catch(() => {});
  assert.equal(ctx.store.inGesture, false);
  assert.equal(ctx.store.layers().length, 0);
  assert.equal(errors[1][0], "later");
});

Deno.test("buildModApi: store.transaction makes one undo step and cancels on throw", async () => {
  const ctx = makeCtx();
  const api = buildModApi(ctx, manifest("demo"));
  const ids = api.store.transaction("Two layers", (s) => [...s.add({ type: "text" }), ...s.add({ type: "shape" })]);
  assert.equal(ids.length, 2);
  assert.equal(ctx.store.historyLabels().undo, "Two layers");
  ctx.store.undo();
  assert.equal(ctx.store.layers().length, 0);
  assert.throws(() => api.store.transaction("Nope", (s) => {
    s.add({ type: "text" });
    throw Error("stop");
  }), /stop/);
  assert.equal(ctx.store.layers().length, 0);
  assert.equal(ctx.store.inGesture, false);
  const out = await api.store.transaction("Async", async (s) => {
    await null;
    return s.add({ type: "text" });
  });
  assert.equal(out.length, 1);
  assert.equal(ctx.store.historyLabels().undo, "Async");
});

Deno.test("buildModApi: wrapped callbacks fall back instead of throwing", () => {
  const ctx = makeCtx();
  const errors = [];
  const api = buildModApi(ctx, manifest("demo"), { onError: (err, where) => errors.push(where) });
  api.inspector.register({ id: "bad", title: "Bad", when: () => { throw Error("when"); }, render: () => { throw Error("render"); } });
  api.filters.register({ id: "bad-filter", label: "Bad", apply: () => { throw Error("filter"); } });
  api.shapes.register({ id: "bad-shape", label: "Bad", path: () => null, outline: () => { throw Error("outline"); } });
  api.tools.register({ id: "bad-tool", label: "Bad", keyDown: () => { throw Error("key"); } });
  assert.equal(ctx.inspector.get("bad").when([]), false);
  const appended = [];
  ctx.inspector.get("bad").render({ append: (n) => appended.push(n) }, []);
  const img = { width: 1, height: 1, data: new Uint8ClampedArray(4) };
  assert.equal(ctx.filters.get("bad-filter").apply(img, {}), img);
  assert.equal(ctx.shapes.get("bad-shape").outline(10, 20).length, 4);
  assert.equal(ctx.tools.get("bad-tool").keyDown({}), false);
  assert.deepEqual(errors, ["inspector bad", "inspector bad", "filter bad-filter", "shape bad-shape outline", "tool bad-tool keyDown"]);
});

Deno.test("buildModApi: prefs are scoped to the mod", () => {
  const ctx = makeCtx();
  const api = buildModApi(ctx, manifest("demo"));
  api.prefs.set("size", 3);
  assert.equal(ctx.prefs.get("mod:demo:size"), 3);
  assert.equal(api.prefs.get("size"), 3);
  api.prefs.remove("size");
  assert.equal(api.prefs.get("size", "none"), "none");
});

// ---- loader -----------------------------------------------------------------------

function harness(modules, { index, prefs } = {}) {
  const ctx = makeCtx({ prefs });
  const imported = [];
  const json = index || { mods: Object.keys(modules).map((id) => ({ id, entry: `${id}/index.js`, enabled: modules[id].enabled !== false })) };
  const fetch = async (url) => {
    assert.equal(url, `${BASE}mods.json`);
    return { ok: true, status: 200, json: async () => json };
  };
  const importer = async (url) => {
    imported.push(url);
    const id = new URL(url).pathname.split("/").at(-2);
    const m = modules[id];
    if (!m) throw Error(`Cannot find module ${url}`);
    if (m.importError) throw SyntaxError(m.importError);
    return m.module;
  };
  return { ctx, imported, load: (opts = {}) => loadMods(ctx, { base: BASE, fetch, importer, kv: memoryKv(), ...opts }) };
}

function mod(id, { enabled = true, activate, deactivate, extra } = {}) {
  const log = [];
  return {
    log,
    enabled,
    module: {
      manifest: manifest(id, extra),
      activate:
        activate ||
        ((api) => {
          log.push("activate");
          api.commands.register({ id: `${id}.run`, title: `Run ${id}`, run() {} });
        }),
      deactivate: deactivate === null ? undefined : deactivate || (() => log.push("deactivate")),
    },
  };
}

Deno.test("loadMods: starts enabled mods, skips disabled ones, sets ctx.mods", async () => {
  const a = mod("alpha");
  const b = mod("beta", { enabled: false });
  const { ctx, imported, load } = harness({ alpha: a, beta: b });
  const mods = await load();
  assert.equal(ctx.mods, mods);
  assert.deepEqual(imported, [`${BASE}alpha/index.js`]);
  assert.ok(ctx.commands.get("alpha.run"));
  assert.equal(ctx.commands.get("beta.run"), null);
  const list = mods.list();
  assert.deepEqual(list.map((m) => [m.id, m.status, m.enabled]), [["alpha", "on", true], ["beta", "off", false]]);
  assert.deepEqual(list[0].adds, { commands: 1 });
  assert.equal(list[0].name, "Mod alpha");
  assert.equal(ctx.ui.toasts.length, 0);
});

Deno.test("loadMods: setEnabled persists, disposes and restarts", async () => {
  const a = mod("alpha");
  const { ctx, load } = harness({ alpha: a });
  const mods = await load();
  assert.equal(await mods.setEnabled("alpha", false), true);
  assert.deepEqual(ctx.prefs.get("mods"), { alpha: false });
  assert.equal(ctx.commands.get("alpha.run"), null);
  assert.deepEqual(a.log, ["activate", "deactivate"]);
  assert.equal(mods.get("alpha").status, "off");
  await mods.setEnabled("alpha", true);
  assert.ok(ctx.commands.get("alpha.run"));
  assert.deepEqual(ctx.prefs.get("mods"), { alpha: true });
  assert.equal(await mods.setEnabled("missing", true), false);
});

Deno.test("loadMods: saved prefs override mods.json defaults", async () => {
  const a = mod("alpha");
  const b = mod("beta", { enabled: false });
  const { ctx, load } = harness({ alpha: a, beta: b }, { prefs: { mods: { alpha: false, beta: true } } });
  await load();
  assert.equal(ctx.commands.get("alpha.run"), null);
  assert.ok(ctx.commands.get("beta.run"));
});

Deno.test("loadMods: a failing mod is isolated, cleaned up and reported once", async () => {
  const bad = mod("bad", {
    activate(api) {
      api.commands.register({ id: "bad.half", title: "Half", run() {} });
      throw Error("broken on purpose");
    },
  });
  const good = mod("good");
  const { ctx, load } = harness({ bad, good });
  const mods = await load();
  assert.equal(ctx.commands.get("bad.half"), null, "registrations made before the throw are removed");
  assert.deepEqual(bad.log, ["deactivate"], "deactivate() runs after a failed activate");
  assert.ok(ctx.commands.get("good.run"), "other mods still start");
  const info = mods.get("bad");
  assert.equal(info.status, "error");
  assert.equal(info.error, "broken on purpose");
  assert.equal(ctx.ui.toasts.length, 1);
  assert.equal(ctx.ui.toasts[0].msg, "Mod Mod bad could not start: broken on purpose");
  assert.equal(ctx.ui.toasts[0].kind, "error");
});

Deno.test("loadMods: several failures make one toast; bad manifests and imports are errors", async () => {
  const { ctx, load } = harness({
    wrongid: { module: { manifest: manifest("other"), activate() {} } },
    oldapi: { module: { manifest: manifest("oldapi", { apiVersion: 2 }), activate() {} } },
    syntax: { importError: "Unexpected token" },
    noact: { module: { manifest: manifest("noact") } },
  });
  const mods = await load();
  assert.deepEqual(mods.list().map((m) => m.status), ["error", "error", "error", "error"]);
  assert.match(mods.get("wrongid").error, /does not match/);
  assert.match(mods.get("oldapi").error, /API 2/);
  assert.equal(mods.get("syntax").error, "Unexpected token");
  assert.match(mods.get("noact").error, /activate/);
  assert.equal(ctx.ui.toasts.length, 1);
  assert.equal(ctx.ui.toasts[0].msg, "4 mods could not start.");
});

Deno.test("loadMods: bad mods.json entries are listed and do not stop the rest", async () => {
  const a = mod("alpha");
  const { ctx, load } = harness(
    { alpha: a },
    { index: { mods: [{ id: "alpha", entry: "alpha/index.js" }, { id: "evil", entry: "https://evil.test/x.js" }] } }
  );
  const mods = await load();
  assert.ok(ctx.commands.get("alpha.run"));
  assert.equal(mods.errors.length, 1);
  assert.match(mods.errors[0], /evil/);
  assert.equal(ctx.ui.toasts.length, 1);
  assert.equal(ctx.ui.toasts[0].kind, "warn");
});

Deno.test("loadMods: reload re-imports with a fresh url and restarts", async () => {
  const a = mod("alpha");
  const { ctx, imported, load } = harness({ alpha: a });
  const mods = await load();
  assert.equal(await mods.reload("alpha"), true);
  assert.equal(imported.length, 2);
  assert.match(imported[1], /alpha\/index\.js\?v=/);
  assert.deepEqual(a.log, ["activate", "deactivate", "activate"]);
  assert.ok(ctx.commands.get("alpha.run"));
});

Deno.test("loadMods: describe reads manifests of mods that are off without starting them", async () => {
  const b = mod("beta", { enabled: false, extra: { description: "Does beta things", author: "Someone" } });
  const { ctx, load } = harness({ beta: b });
  const mods = await load();
  assert.equal(mods.get("beta").name, "beta");
  await mods.describe();
  const info = mods.get("beta");
  assert.equal(info.name, "Mod beta");
  assert.equal(info.description, "Does beta things");
  assert.equal(info.status, "off");
  assert.deepEqual(b.log, []);
  assert.equal(ctx.commands.get("beta.run"), null);
});

Deno.test("loadMods: start false (safe mode) lists mods but never imports or starts one", async () => {
  const a = mod("alpha");
  const b = mod("beta", { enabled: false });
  const { ctx, imported, load } = harness({ alpha: a, beta: b });
  const mods = await load({ start: false });
  assert.equal(mods.safeMode, true);
  assert.deepEqual(imported, []);
  assert.deepEqual(mods.list().map((m) => [m.id, m.status, m.enabled]), [["alpha", "off", true], ["beta", "off", false]]);
  // Settings can still turn one off (saved for the next start), and nothing starts.
  assert.equal(await mods.setEnabled("alpha", false), true);
  assert.deepEqual(ctx.prefs.get("mods"), { alpha: false });
  await mods.setEnabled("beta", true);
  await mods.describe();
  await mods.reload("beta");
  await mods.refresh();
  assert.deepEqual(imported, []);
  assert.deepEqual(a.log, []);
  assert.equal(ctx.commands.get("beta.run"), null);
  assert.equal(ctx.ui.toasts.length, 0);
});

Deno.test("loadMods: refresh follows a changed enabled default in mods.json", async () => {
  const a = mod("alpha");
  const b = mod("beta", { enabled: false });
  const index = { mods: [{ id: "alpha", entry: "alpha/index.js" }, { id: "beta", entry: "beta/index.js", enabled: false }] };
  const { ctx, imported, load } = harness({ alpha: a, beta: b }, { index });
  const mods = await load();
  await mods.describe();
  const state = () => mods.list().map((m) => [m.id, m.enabled, m.status]);
  assert.deepEqual(state(), [["alpha", true, "on"], ["beta", false, "off"]]);

  const before = imported.length;
  await mods.refresh();
  assert.equal(imported.length, before, "an unchanged mods.json starts and stops nothing");

  index.mods[0].enabled = false;
  index.mods[1].enabled = true;
  await mods.refresh();
  await mods.describe();
  assert.deepEqual(state(), [["alpha", false, "off"], ["beta", true, "on"]]);
  assert.equal(ctx.commands.get("alpha.run"), null);
  assert.ok(ctx.commands.get("beta.run"));
  assert.deepEqual(a.log, ["activate", "deactivate"]);
  assert.deepEqual(b.log, ["activate"]);

  // A saved choice still wins over the default.
  await mods.setEnabled("beta", true);
  index.mods[1].enabled = false;
  await mods.refresh();
  assert.deepEqual(state(), [["alpha", false, "off"], ["beta", true, "on"]]);
  assert.ok(ctx.commands.get("beta.run"));
});

Deno.test("loadMods: refresh does not retry a broken mod whose default did not change", async () => {
  const bad = mod("bad", { activate() { throw Error("broken on purpose"); } });
  const { ctx, imported, load } = harness({ bad });
  const mods = await load();
  assert.equal(mods.get("bad").status, "error");
  const toasts = ctx.ui.toasts.length;
  const before = imported.length;
  await mods.refresh();
  assert.equal(imported.length, before);
  assert.equal(ctx.ui.toasts.length, toasts);
  assert.equal(mods.get("bad").error, "broken on purpose");
});

Deno.test("loadMods: runtime errors from wrapped callbacks show on the mod", async () => {
  const a = mod("alpha", {
    activate(api) {
      api.events.on("ping", () => {
        throw Error("listener broke");
      });
    },
  });
  const { ctx, load } = harness({ alpha: a });
  const mods = await load();
  ctx.emit("ping");
  ctx.emit("ping");
  const info = mods.get("alpha");
  assert.equal(info.status, "on");
  assert.equal(info.runtimeErrors.length, 1);
  assert.equal(info.runtimeErrors[0].message, "listener broke");
});

Deno.test("registerModCommands: app.mods and settings shortcuts, with a dispose", () => {
  const ctx = makeCtx();
  const off = registerModCommands(ctx);
  for (const id of ["app.mods", "settings.packs", "settings.fonts", "settings.shortcuts", "settings.about"]) assert.ok(ctx.commands.get(id), id);
  assert.equal(typeof ctx.ui.openSettings, "function");
  off();
  assert.equal(ctx.commands.get("app.mods"), null);
});
