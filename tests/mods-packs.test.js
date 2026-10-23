// Tests for web/js/mods/packs.js and web/mods/theme-pack-example.json
//   deno test --allow-read tests/mods-packs.test.js

import assert from "node:assert/strict";
import { countsText, createPacks, normHex, packId, parsePack, readPack, summaryText } from "../web/js/mods/packs.js";
import { THEMES } from "../web/js/ui/theme.js";
import { makeCtx, memoryKv } from "./mods-helpers.js";

console.warn = () => {};

const BASE = "http://longitude.test/mods/";
const colors = { ...THEMES[0].colors };
const theme = (name, extra = {}) => ({ name, note: "A note", scheme: "dark", texture: "grain", colors: { ...colors }, ...extra });
const longPack = (extra = {}) => ({
  version: 1,
  name: "Night shift",
  author: "Someone",
  description: "Themes and sizes for late uploads",
  themes: [theme("Night shift")],
  presets: [{ id: "night-banner", group: "Night", label: "Night banner", width: 2560, height: 1440 }],
  palettes: [{ name: "Neon", colors: ["#f0f", "#00FFAA", "#11223344"] }],
  fonts: [{ family: "Night Sans", category: "display", faces: [{ file: "night/NightSans.woff2", weight: 700 }] }],
  ...extra,
});

Deno.test("the example pack is a valid Latitude theme pack", async () => {
  const raw = JSON.parse(await Deno.readTextFile(new URL("../web/mods/theme-pack-example.json", import.meta.url)));
  assert.equal(raw.version, 1);
  assert.ok(Array.isArray(raw.templates), "Latitude packs carry a templates list");
  const pack = parsePack(raw);
  assert.equal(pack.name, "Neon receipt");
  assert.equal(pack.id, "neon-receipt");
  assert.deepEqual(pack.themes.map((t) => [t.name, t.scheme]), [["Neon receipt", "dark"], ["Thermal paper", "light"]]);
  assert.deepEqual(pack.notes, []);
});

Deno.test("parsePack: Latitude templates are skipped with a note", () => {
  const pack = parsePack({ version: 1, name: "Lat", themes: [theme("A")], templates: [{ name: "T" }, { name: "U" }] });
  assert.equal(pack.notes.length, 1);
  assert.match(pack.notes[0], /2 Latitude templates skipped/);
});

Deno.test("parsePack: Longitude packs with presets, palettes and fonts", () => {
  const pack = parsePack(longPack());
  assert.equal(pack.presets[0].id, "night-banner");
  assert.equal(pack.presets[0].source, "pack");
  assert.equal(Object.isFrozen(pack.presets[0]), false, "stored presets are plain copies");
  assert.deepEqual(pack.palettes[0].colors, ["#ff00ff", "#00ffaa", "#11223344"]);
  assert.deepEqual(pack.fonts[0].faces, [{ file: "night/NightSans.woff2", weight: 700, style: "normal" }]);
  assert.equal(parsePack(pack).name, pack.name, "parsed packs parse again");
});

Deno.test("parsePack: plain errors for bad input", () => {
  assert.throws(() => parsePack(null), /JSON object/);
  assert.throws(() => parsePack([]), /JSON object/);
  assert.throws(() => parsePack({ version: 2, name: "x", themes: [theme("A")] }), /version 1/);
  assert.throws(() => parsePack({ version: 1, themes: [theme("A")] }), /needs a name/);
  assert.throws(() => parsePack({ version: 1, name: "x", themes: [theme("A", { colors: { ...colors, bg: "red" } })] }), /bg must be a six-digit/);
  assert.throws(() => parsePack({ version: 1, name: "x" }), /empty/);
  assert.throws(() => parsePack(longPack({ presets: [{ id: "x", label: "X", width: 5, height: 10 }] })), /width/);
  assert.throws(() => parsePack(longPack({ presets: {} })), /presets must be a list/);
  assert.throws(() => parsePack(longPack({ palettes: [{ name: "P", colors: ["#zzz"] }] })), /not a hex color/);
  assert.throws(() => parsePack(longPack({ palettes: [{ name: "P", colors: [] }] })), /list of colors/);
  assert.throws(() => parsePack(longPack({ fonts: [{ family: "F", faces: [{ file: "../F.woff2" }] }] })), /font file/);
  assert.throws(() => parsePack(longPack({ fonts: [{ family: "F", faces: [{ file: "https://x.test/F.woff2" }] }] })), /not a URL/);
  assert.throws(() => parsePack(longPack({ fonts: [{ family: "F", faces: [{ file: "f/F.exe" }] }] })), /\.woff2/);
  assert.throws(() => parsePack(longPack({ fonts: [{ family: 'Bad"; x', faces: [{ file: "f/F.woff2" }] }] })), /family name/);
  assert.throws(() => parsePack({ version: 1, name: "x", themes: Array.from({ length: 9 }, (_, i) => theme(`T${i}`)) }), /eight themes/);
});

Deno.test("readPack: files, text and objects; code is dropped", async () => {
  assert.equal((await readPack('{"version":1}')).version, 1);
  assert.equal((await readPack(new Blob(['{"name":"blob"}']))).name, "blob");
  const obj = await readPack({ version: 1, name: "x", sneaky: () => 1 });
  assert.equal("sneaky" in obj, false);
  await assert.rejects(() => readPack("{nope"), /not valid JSON/);
  await assert.rejects(() => readPack("x".repeat(1_000_001)), /larger than 1 MB/);
  await assert.rejects(() => readPack(42), /Choose a pack/);
});

Deno.test("small helpers: ids, colors and text", () => {
  assert.equal(packId("Neon Receipt!"), "neon-receipt");
  assert.equal(packId("2025 pack"), "p-2025-pack");
  assert.equal(packId("!!!"), "p-pack");
  assert.ok(packId("x".repeat(80)).length <= 24);
  assert.equal(normHex("#ABC"), "#aabbcc");
  assert.equal(normHex("#12345"), null);
  assert.equal(countsText({ themes: 2, presets: 1, palettes: 1, fonts: 0 }), "2 themes, 1 size preset and 1 color palette");
  const text = summaryText({ pack: parsePack(longPack()), replaces: true, skipped: [] });
  assert.match(text, /^Adds 1 theme, 1 size preset, 1 color palette and 1 font\./);
  assert.match(text, /replaces/);
  assert.match(text, /never run code/);
});

Deno.test("createPacks: add applies themes, presets, palettes and fonts; remove undoes it", async () => {
  const ctx = makeCtx({ prefs: { palettes: [{ name: "Mine", colors: ["#000000"] }] } });
  const kv = memoryKv();
  const packs = createPacks(ctx, { modsBase: BASE, kv });
  const events = [];
  ctx.on("packs", () => events.push("packs"));

  const preview = await packs.preview(longPack());
  assert.equal(preview.replaces, false);
  assert.deepEqual(preview.skipped, []);
  const info = await packs.add(preview.pack);
  assert.equal(info.id, "night-shift");
  assert.deepEqual(info.counts, { themes: 1, presets: 1, palettes: 1, fonts: 1 });
  assert.deepEqual(info.themeIds, ["pk-night-shift-1"]);
  assert.ok(ctx.themes.get("pk-night-shift-1"));
  assert.equal(ctx.presets.get("night-banner").source, "pack");
  const font = ctx.fonts.get("Night Sans").def;
  assert.equal(font.base, BASE);
  assert.deepEqual(font.faces, [{ url: "night/NightSans.woff2", weight: 700, style: "normal" }]);
  assert.deepEqual(ctx.prefs.get("palettes"), [
    { name: "Mine", colors: ["#000000"] },
    { id: "pk-night-shift-1", name: "Neon", colors: ["#ff00ff", "#00ffaa", "#11223344"], pack: "night-shift" },
  ]);
  assert.equal(kv.map.get("packs").packs.length, 1);
  assert.ok(events.length >= 1);

  assert.equal(await packs.remove("night-shift"), true);
  assert.equal(ctx.themes.get("pk-night-shift-1"), null);
  assert.equal(ctx.presets.get("night-banner"), null);
  assert.equal(ctx.fonts.get("Night Sans"), null);
  assert.deepEqual(ctx.prefs.get("palettes"), [{ name: "Mine", colors: ["#000000"] }]);
  assert.equal(kv.map.get("packs").packs.length, 0);
  assert.equal(await packs.remove("night-shift"), false);
});

Deno.test("createPacks: re-adding replaces; conflicts are skipped and reported", async () => {
  const ctx = makeCtx();
  ctx.presets.register({ id: "taken", label: "Taken", width: 100, height: 100 });
  const packs = createPacks(ctx, { modsBase: BASE, kv: memoryKv() });
  await packs.add(parsePack(longPack()));
  const again = await packs.preview(longPack({ presets: [{ id: "night-banner", label: "Night banner", width: 1000, height: 500 }, { id: "taken", label: "Clash", width: 100, height: 100 }] }));
  assert.equal(again.replaces, true);
  assert.equal(again.skipped.length, 1);
  assert.match(again.skipped[0], /Clash/);
  const info = await packs.add(again.pack);
  assert.equal(packs.list().length, 1);
  assert.equal(ctx.presets.get("night-banner").width, 1000);
  assert.equal(ctx.presets.get("taken").label, "Taken");
  assert.equal(info.skipped.length, 1);
});

Deno.test("createPacks: restore re-applies stored packs and skips broken ones", async () => {
  const kv = memoryKv([{ k: "packs", v: 1, packs: [{ id: "night-shift", added: 5, pack: longPack() }, { id: "broken", pack: { version: 1 } }] }]);
  const ctx = makeCtx();
  const packs = createPacks(ctx, { modsBase: BASE, kv });
  const list = await packs.restore();
  assert.equal(list.length, 1);
  assert.equal(list[0].added, 5);
  assert.ok(ctx.themes.get("pk-night-shift-1"));
  assert.equal(ctx.prefs.get("palettes").length, 1);
});

Deno.test("createPacks: a failed write leaves the app and storage as they were", async () => {
  const kv = memoryKv();
  const realPut = kv.put;
  let full = false;
  kv.put = async (rec) => {
    if (full) throw Error("Browser storage is full.");
    return realPut(rec);
  };
  const ctx = makeCtx({ prefs: { palettes: [{ name: "Mine", colors: ["#000000"] }] } });
  const packs = createPacks(ctx, { modsBase: BASE, kv });

  full = true;
  await assert.rejects(() => packs.add(parsePack(longPack())), /storage is full/);
  assert.deepEqual(packs.list(), []);
  assert.equal(ctx.themes.get("pk-night-shift-1"), null);
  assert.equal(ctx.presets.get("night-banner"), null);
  assert.equal(ctx.fonts.get("Night Sans"), null);
  assert.deepEqual(ctx.prefs.get("palettes"), [{ name: "Mine", colors: ["#000000"] }]);
  assert.equal(kv.map.has("packs"), false);
  assert.deepEqual(await createPacks(makeCtx(), { modsBase: BASE, kv }).restore(), [], "nothing to restore after a reload");

  full = false;
  await packs.add(parsePack(longPack()));
  full = true;
  await assert.rejects(() => packs.remove("night-shift"), /storage is full/);
  assert.deepEqual(packs.list().map((p) => p.id), ["night-shift"]);
  assert.ok(ctx.themes.get("pk-night-shift-1"));
  assert.ok(ctx.presets.get("night-banner"));
  assert.equal(ctx.prefs.get("palettes").length, 2);
  assert.equal(kv.map.get("packs").packs.length, 1);

  // A replace that cannot be stored keeps the installed version applied.
  await assert.rejects(() => packs.add(parsePack(longPack({ presets: [{ id: "night-banner", label: "Night banner", width: 1000, height: 500 }] }))), /storage is full/);
  assert.equal(ctx.presets.get("night-banner").width, 2560);
  assert.ok(ctx.themes.get("pk-night-shift-1"));
});

Deno.test("createPacks: adds and removes started together all land", async () => {
  const kv = memoryKv();
  const ctx = makeCtx();
  const packs = createPacks(ctx, { modsBase: BASE, kv });
  await Promise.all([
    packs.add(parsePack(longPack())),
    packs.add(parsePack({ version: 1, name: "Second", palettes: [{ name: "Two", colors: ["#222222"] }] })),
  ]);
  assert.deepEqual(packs.list().map((p) => p.id), ["night-shift", "second"]);
  assert.deepEqual(kv.map.get("packs").packs.map((p) => p.id), ["night-shift", "second"]);
  await Promise.all([packs.remove("night-shift"), packs.remove("second")]);
  assert.deepEqual(packs.list(), []);
  assert.deepEqual(kv.map.get("packs").packs, []);
});

Deno.test("createPacks: importPack reviews first and respects a no", async () => {
  const ctx = makeCtx();
  const packs = createPacks(ctx, { modsBase: BASE, kv: memoryKv() });
  let seen = null;
  const no = await packs.importPack(JSON.stringify(longPack()), { review: async (p) => ((seen = p), false) });
  assert.equal(no, null);
  assert.equal(seen.pack.name, "Night shift");
  assert.equal(packs.list().length, 0);
  ctx.ui.confirm = async ({ message }) => /never run code/.test(message);
  const yes = await packs.importPack(longPack());
  assert.equal(yes.name, "Night shift");
  await assert.rejects(() => packs.importPack("{bad"), /not valid JSON/);
});
