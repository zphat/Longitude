// Tests for the example mods in web/mods/ and web/mods/mods.json
//   deno test --allow-read tests/mods-examples.test.js

import assert from "node:assert/strict";
import { buildModApi, scopeOf } from "../web/js/mods/api.js";
import { validateIndex, validateManifest } from "../web/js/mods/loader.js";
import * as memeClassic from "../web/mods/meme-classic/index.js";
import * as stickerShapes from "../web/mods/sticker-shapes/index.js";
import * as deepFry from "../web/mods/deep-fry/index.js";
import * as starterLayouts from "../web/mods/starter-layouts/index.js";
import { makeCtx } from "./mods-helpers.js";

const MODS = { "meme-classic": memeClassic, "sticker-shapes": stickerShapes, "deep-fry": deepFry, "starter-layouts": starterLayouts };

function start(mod, ctx = makeCtx()) {
  const api = buildModApi(ctx, validateManifest(mod.manifest, mod.manifest.id), { base: `http://longitude.test/mods/${mod.manifest.id}/index.js` });
  mod.activate(api);
  return { ctx, api, stop: () => scopeOf(api).dispose() };
}

Deno.test("mods.json lists the four example mods with the right defaults", async () => {
  const json = JSON.parse(await Deno.readTextFile(new URL("../web/mods/mods.json", import.meta.url)));
  const { mods, errors } = validateIndex(json);
  assert.deepEqual(errors, []);
  assert.deepEqual(mods.map((m) => [m.id, m.enabled]), [
    ["meme-classic", true],
    ["sticker-shapes", true],
    ["deep-fry", false],
    ["starter-layouts", false],
  ]);
  for (const m of mods) {
    const module = MODS[m.id];
    assert.equal(m.entry, `${m.id}/index.js`);
    const manifest = validateManifest(module.manifest, m.id);
    assert.equal(manifest.id, m.id);
    // Settings > Mods links each example to its source.
    assert.equal(manifest.homepage, `https://github.com/zphat/Longitude/tree/main/web/mods/${m.id}`);
    assert.equal(typeof module.activate, "function");
  }
});

Deno.test("meme-classic: adds top and bottom text as one undo step", async () => {
  const { ctx, stop } = start(memeClassic);
  await ctx.commands.run("meme-classic.add");
  const layers = ctx.store.layers();
  assert.deepEqual(layers.map((l) => l.name), ["Top text", "Bottom text"]);
  for (const l of layers) {
    assert.equal(l.type, "text");
    assert.equal(l.font, "Anton", "falls back to Anton when Impact is missing");
    assert.equal(l.color, "#ffffff");
    assert.equal(l.uppercase, true);
    assert.equal(l.stroke.on, true);
    assert.equal(l.stroke.color, "#000000");
    assert.equal(l.wrap, "fixed");
    assert.equal(l.size, 115);
  }
  assert.ok(layers[0].y < 360 && layers[1].y > 360);
  assert.equal(ctx.store.historyLabels().undo, "Classic meme text");
  assert.deepEqual(ctx.fonts.loads[0], ["Anton", 400]);
  ctx.store.undo();
  assert.equal(ctx.store.layers().length, 0);
  stop();
  assert.equal(ctx.commands.get("meme-classic.add"), null);
  assert.equal(ctx.inspector.get("meme-classic"), null);
});

Deno.test("meme-classic: Impact when installed; the Meme section and command restyle text", () => {
  const ctx = makeCtx();
  ctx.fonts.get = (f) => (f === "Impact" ? { family: "Impact", available: true } : null);
  start(memeClassic, ctx);
  const [id] = ctx.store.add({ type: "text", text: "hi", color: "#ff0000", stroke: { on: false }, size: 200 });
  const section = ctx.inspector.get("meme-classic");
  assert.equal(section.when(ctx.store.selected()), true);
  assert.equal(section.when([{ type: "image" }]), false);
  assert.equal(section.when([]), false);
  assert.equal(ctx.commands.enabled("meme-classic.apply"), true);
  ctx.commands.run("meme-classic.apply");
  const l = ctx.store.get(id);
  assert.equal(l.font, "Impact");
  assert.equal(l.color, "#ffffff");
  assert.equal(l.stroke.on, true);
  assert.equal(l.stroke.width, 13);
  assert.equal(ctx.store.historyLabels().undo, "Make it classic");
});

Deno.test("sticker-shapes: four shapes with outlines and insert commands", () => {
  const { ctx, stop } = start(stickerShapes);
  for (const id of ["badge", "heart", "lightning", "callout-arrow"]) {
    const def = ctx.shapes.get(id);
    assert.ok(def, id);
    assert.equal(def.mod, "sticker-shapes");
    const pts = def.outline(200, 100, { notch: 0.35, head: 0.38, shaft: 0.5 }, { radius: 0 });
    assert.ok(pts.length >= 6, `${id} outline`);
    for (const p of pts) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
      assert.ok(Math.abs(p.x) <= 100.01 && Math.abs(p.y) <= 50.01, `${id} stays in its box`);
    }
    ctx.commands.run(`sticker-shapes.${id}`);
    const layer = ctx.store.layers().at(-1);
    assert.equal(layer.shape, id);
    assert.equal(layer.name, def.label);
    assert.equal(layer.fill.color, def.defaults.fill.color);
    assert.equal(ctx.store.historyLabels().undo, `Add ${def.label.toLowerCase()}`);
  }
  assert.equal(ctx.editor.flashed.length, 4);
  stop();
  assert.equal(ctx.shapes.get("heart"), null);
  assert.equal(ctx.commands.get("sticker-shapes.heart"), null);
});

Deno.test("deep-fry: the filter is deterministic, keeps alpha and does nothing at zero", () => {
  const make = () => {
    const data = new Uint8ClampedArray(6 * 6 * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = (i * 7) % 255;
      data[i + 1] = (i * 3) % 255;
      data[i + 2] = 120;
      data[i + 3] = i % 8 ? 255 : 90;
    }
    return { width: 6, height: 6, data };
  };
  const a = deepFry.deepFry(make(), { amount: 70, sharpen: 60, noise: 30 });
  const b = deepFry.deepFry(make(), { amount: 70, sharpen: 60, noise: 30 });
  assert.deepEqual(a.data, b.data);
  assert.notDeepEqual(a.data, make().data);
  for (let i = 3; i < a.data.length; i += 4) assert.equal(a.data[i], make().data[i]);
  assert.deepEqual(deepFry.deepFry(make(), { amount: 0, sharpen: 0, noise: 0 }).data, make().data);
});

Deno.test("deep-fry: command fries selected images once; remove and the section work", () => {
  const { ctx, stop } = start(deepFry);
  assert.ok(ctx.filters.get("deep-fry"));
  assert.equal(ctx.commands.enabled("deep-fry.apply"), false);
  const [img] = ctx.store.add({ type: "image", natW: 10, natH: 10 });
  ctx.store.add({ type: "text" }, { select: false });
  assert.equal(ctx.commands.enabled("deep-fry.apply"), true);
  assert.equal(ctx.commands.enabled("deep-fry.remove"), false);
  ctx.commands.run("deep-fry.apply");
  assert.deepEqual(ctx.store.get(img).filters, [{ id: "deep-fry", params: { amount: 70, sharpen: 60, noise: 30 } }]);
  ctx.commands.run("deep-fry.apply");
  assert.equal(ctx.store.get(img).filters.length, 1);
  assert.match(ctx.ui.toasts.at(-1).msg, /Already deep fried/);
  const section = ctx.inspector.get("deep-fry");
  assert.equal(section.order, 33);
  assert.equal(section.when(ctx.store.selected()), true);
  assert.equal(section.when([{ type: "image" }, { type: "text" }]), false);
  ctx.commands.run("deep-fry.remove");
  assert.deepEqual(ctx.store.get(img).filters, []);
  assert.equal(ctx.commands.enabled("deep-fry.remove"), false);
  stop();
  assert.equal(ctx.filters.get("deep-fry"), null);
});

Deno.test("starter-layouts: each layout is one undo step, panels below, text selected", async () => {
  const { ctx, stop } = start(starterLayouts);
  const [photo] = ctx.store.add({ type: "image", natW: 10, natH: 10, name: "My photo" });
  const cases = [
    ["starter-layouts.face-text", "Face and big text layout", "Big text"],
    ["starter-layouts.versus", "Versus layout", "Left label"],
    ["starter-layouts.before-after", "Before and after layout", "Before label"],
  ];
  for (const [id, label, focus] of cases) {
    const before = ctx.store.layers().length;
    await ctx.commands.run(id);
    assert.equal(ctx.store.historyLabels().undo, label);
    const layers = ctx.store.layers();
    assert.ok(layers.length > before + 3, `${id} adds a composition`);
    assert.equal(ctx.store.selected().length, 1);
    assert.equal(ctx.store.selected()[0].name, focus);
    assert.ok(ctx.store.index(photo) > 0, "panels go under the photo");
    assert.ok(layers.every((l) => ["shape", "text", "image"].includes(l.type)));
    ctx.store.undo();
    assert.equal(ctx.store.layers().length, before);
  }
  stop();
  assert.equal(ctx.commands.get("starter-layouts.versus"), null);
});
