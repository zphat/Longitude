// Tests for web/js/ui/settings.js helpers and web/js/mods/ui.js, and for the
// promise that starting Longitude does not load the Settings dialog.
//   deno test --allow-read tests/mods-settings.test.js

import assert from "node:assert/strict";
import { formatBytes as exportFormatBytes } from "../web/js/features/compress.js";
import { formatBytes, sortDrop, ensureModIcons as fromSettings } from "../web/js/ui/settings.js";
import { FALLBACK_ICONS, ensureModIcons } from "../web/js/mods/ui.js";
import { openSettings, registerModCommands } from "../web/js/mods/loader.js";
import { hasIcon } from "../web/js/ui/icons.js";
import { makeCtx } from "./mods-helpers.js";

const file = (name, type = "") => ({ name, type });
const names = (list) => list.map((f) => f.name);
const source = (path) => Deno.readTextFile(new URL(`../web/js/${path}`, import.meta.url));
// Static `import ... from "x"` and `export ... from "x"` specifiers of a module.
const staticDeps = (text) => [...text.matchAll(/^\s*(?:import|export)\b[^;'"]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1]);

Deno.test("sortDrop: fonts and packs are told apart by name or type", () => {
  const out = sortDrop([file("Anton.ttf"), file("logo.WOFF2"), file("neon.json"), file("x", "font/otf"), file("pack", "application/json")]);
  assert.deepEqual(names(out.fonts), ["Anton.ttf", "logo.WOFF2", "x"]);
  assert.equal(out.pack.name, "neon.json");
});

Deno.test("sortDrop: other files go to the tab on screen, else nowhere", () => {
  const files = [file("photo.png", "image/png"), file("notes.txt", "text/plain")];
  assert.deepEqual(sortDrop(files, "general"), { fonts: [], pack: null });
  assert.deepEqual(names(sortDrop(files, "fonts").fonts), ["photo.png", "notes.txt"]);
  assert.equal(sortDrop(files, "packs").pack.name, "photo.png");
  // A real pack wins over a stray file on the Packs tab.
  assert.equal(sortDrop([file("photo.png"), file("neon.json")], "packs").pack.name, "neon.json");
  assert.deepEqual(sortDrop(null), { fonts: [], pack: null });
});

Deno.test("formatBytes in Settings matches the export engine's", () => {
  const values = [NaN, -1, 0, 1, 999, 1000, 1001, 1049, 99_949, 99_951, 999_499, 999_951, 1_000_000, 2_000_001, 123_456_789, 999_999_999, 5e12, 7.3e15];
  for (const n of values) assert.equal(formatBytes(n), exportFormatBytes(n), String(n));
});

Deno.test("ensureModIcons registers the fallback icons and Settings re-exports it", () => {
  assert.equal(fromSettings, ensureModIcons);
  ensureModIcons();
  for (const name of Object.keys(FALLBACK_ICONS)) assert.ok(hasIcon(name), name);
});

Deno.test("boot stays light: the loader opens Settings on demand", async () => {
  assert.ok(!staticDeps(await source("mods/loader.js")).some((d) => d.includes("ui/settings.js")), "loader.js must not import ui/settings.js statically");
  assert.ok(!staticDeps(await source("mods/index.js")).some((d) => d.includes("ui/settings.js")), "mods/index.js must not import ui/settings.js statically");
  assert.ok(!staticDeps(await source("ui/settings.js")).some((d) => d.includes("features/")), "settings.js must not pull in feature modules");
});

Deno.test("openSettings from the loader resolves to { close } (no DOM here)", async () => {
  const ctx = makeCtx();
  registerModCommands(ctx);
  const handle = await openSettings(ctx, { tab: "mods" });
  assert.equal(typeof handle.close, "function");
  const viaUi = await ctx.ui.openSettings({ tab: "about" });
  assert.equal(typeof viaUi.close, "function");
  assert.deepEqual(ctx.ui.toasts, []);
});
