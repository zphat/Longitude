// Tests for web/js/core/assets.js and web/js/core/project.js in memory mode
// (Deno has no IndexedDB, so the in-memory fallback is what runs here).
//   deno test --allow-read tests/core-assets.test.js

import assert from "node:assert/strict";
import { AssetStore, ProjectStore, blobToDataURL, dataURLToBlob, sniffType } from "../web/js/core/assets.js";
import { createAutosave, exportProject, importProject, importReport, projectFileName } from "../web/js/core/project.js";
import { createDoc, createLayer } from "../web/js/core/model.js";
import { Store } from "../web/js/core/store.js";

// 3x2 opaque red PNG.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAFElEQVR4nGP8z8DwnwEKmGAMEA0ALx8CArQqqWoAAAAASUVORK5CYII=";
const pngBytes = () => Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));
const pngBlob = () => new Blob([pngBytes()], { type: "" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function quiet(fn) {
  const w = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = w;
  }
}

Deno.test("sniffType and data URLs", async () => {
  assert.equal(sniffType(pngBytes()), "image/png");
  assert.equal(sniffType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffType(new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="x"/>')), "image/svg+xml");
  assert.equal(sniffType(new TextEncoder().encode("hello world")), "");
  const url = await blobToDataURL(new Blob([pngBytes()], { type: "image/png" }));
  assert.ok(url.startsWith("data:image/png;base64,iVBOR"));
  const back = dataURLToBlob(url);
  assert.equal(back.type, "image/png");
  assert.deepEqual(new Uint8Array(await back.arrayBuffer()), pngBytes());
  assert.equal(await dataURLToBlob("data:text/plain,hi%20there").text(), "hi there");
  assert.throws(() => dataURLToBlob("nope"), /not a valid data URL/);
});

Deno.test("AssetStore: add, dedupe, info, decode, data URLs", async () => {
  const assets = new AssetStore();
  await assets.init();
  assert.equal(assets.persistent, false);
  const ready = [];
  assets.addEventListener("ready", (e) => ready.push(e.detail.id));
  const id = await assets.addBlob(pngBlob(), { name: "red.png" });
  assert.match(id, /^ast_[0-9a-f]{20}$/);
  assert.equal(await assets.addBlob(pngBlob()), id, "same bytes, same id");
  assert.deepEqual(assets.info(id), { w: 3, h: 2, type: "image/png", name: "red.png" });
  const img = assets.getImage(id);
  assert.equal(img.width, 3);
  assert.deepEqual(ready, [id]);
  const url = await assets.toDataURL(id);
  assert.equal(await assets.fromDataURL(url), id);
  assert.equal((await assets.getBlob(id)).type, "image/png");
  assert.equal(await assets.getBlob("ast_missing"), null);
  await assert.rejects(() => assets.loadImage("ast_missing"), /Image not found/);
  await assert.rejects(() => assets.addBlob(new Blob(["just text"], { type: "text/plain" })), /not an image/);
  await assert.rejects(() => assets.addBlob(new Blob([])), /empty/);
});

Deno.test("AssetStore: getImage decodes lazily and fires 'ready'", async () => {
  const first = new AssetStore();
  const id = await first.addBlob(pngBlob());
  const second = new AssetStore();
  await second.init();
  assert.ok(second.info(id), "metadata is loaded at init");
  const got = new Promise((resolve) => second.addEventListener("ready", (e) => resolve(e.detail.id)));
  assert.equal(second.getImage(id), null);
  assert.equal(await got, id);
  assert.equal(second.getImage(id).height, 2);
  assert.equal((await second.loadImage(id)).width, 3);
});

Deno.test("AssetStore: gc keeps images used this session, removes old unused ones", async () => {
  const older = new AssetStore();
  const oldId = await older.addBlob(new Blob([pngBytes(), new Uint8Array([1])]));
  const usedId = await older.addBlob(pngBlob());
  await wait(2);
  const assets = new AssetStore();
  await assets.init();
  assert.equal(await assets.addBlob(pngBlob()), usedId, "re-added this session");
  const fresh = await assets.addBlob(new Blob([pngBytes(), new Uint8Array([2])]));
  assert.equal(await assets.gc([]), 1);
  assert.equal(assets.info(oldId), null, "unused image from an earlier session is gone");
  assert.ok(assets.info(usedId));
  assert.ok(assets.info(fresh));
});

Deno.test("ProjectStore: save, list, load, rename, remove, last opened", async () => {
  const projects = new ProjectStore(new AssetStore());
  const a = createDoc({ name: "First" });
  const b = createDoc({ name: "Second" });
  a.layers.push(createLayer("text"));
  await projects.save(a, new Blob(["thumb"], { type: "image/webp" }));
  await wait(2);
  await projects.save(b);
  const list = await projects.list();
  const mine = list.filter((p) => p.id === a.id || p.id === b.id);
  assert.deepEqual(mine.map((p) => p.name), ["Second", "First"], "newest first");
  assert.equal(mine[1].thumb.type, "image/webp");
  assert.equal(mine[0].thumb, null);
  assert.equal(mine[1].width, 1280);

  await projects.save({ ...a, name: "First again" });
  const kept = (await projects.list()).find((p) => p.id === a.id);
  assert.ok(kept.thumb, "saving without a thumbnail keeps the old one");

  const loaded = await projects.load(a.id);
  assert.equal(loaded.layers.length, 1);
  assert.equal(loaded.layers[0].font, "Anton");
  assert.equal(await projects.load("doc_missing"), null);
  assert.equal(await projects.has(a.id), true);

  assert.equal(await projects.rename(b.id, "  Renamed  "), true);
  assert.equal((await projects.load(b.id)).name, "Renamed");
  assert.equal(await projects.rename("doc_missing", "x"), false);

  await projects.setLastOpened(b.id);
  assert.equal(await projects.lastOpened(), b.id);
  await projects.remove(b.id);
  assert.equal(await projects.lastOpened(), null);
  assert.equal(await projects.has(b.id), false);
});

Deno.test("project files: export then import restores the design", async () => {
  const assets = new AssetStore();
  const id = await assets.addBlob(pngBlob());
  const doc = createDoc({ name: "Thumb: v2/final" });
  doc.layers.push(createLayer("image", { asset: id, natW: 3, natH: 2 }), createLayer("text", { text: "WAIT", font: "Mine" }));
  const fonts = { usedIn: () => ["Mine"], get: () => ({ source: "custom" }) };
  const blob = await exportProject(doc, assets, fonts);
  assert.equal(blob.type, "application/json");
  const json = JSON.parse(await blob.text());
  assert.equal(json.format, "longitude");
  assert.equal(json.v, 1);
  assert.ok(json.assets[id].startsWith("data:image/png;base64,"));
  assert.deepEqual(json.fonts, [], "no stored font records without IndexedDB");

  const back = await importProject(new Blob([JSON.stringify(json)]), new AssetStore(), null);
  assert.notEqual(back.id, doc.id, "opening a file makes a new project");
  assert.equal(back.name, doc.name);
  assert.deepEqual(back.layers, doc.layers);
  assert.equal(projectFileName(doc), "Thumb v2 final.longitude");
});

Deno.test("project files: custom fonts come back under their family", async () => {
  const calls = [];
  const fonts = {
    get: (f) => (f === "Have" ? { source: "custom" } : null),
    addCustom: async (file, opts) => {
      calls.push({ name: file.name, ...opts });
      return opts.family === "Renamed" ? "Renamed (yours)" : opts.family;
    },
  };
  const fontURL = await blobToDataURL(new Blob([new Uint8Array([0, 1, 0, 0])], { type: "font/ttf" }));
  const doc = createDoc();
  doc.layers.push(createLayer("text", { font: "Renamed" }), createLayer("text", { font: "Have" }));
  const file = {
    format: "longitude",
    v: 1,
    doc,
    assets: {},
    fonts: [
      { family: "Renamed", dataURL: fontURL, weight: 700, style: "italic", name: "renamed-bold.ttf" },
      { family: "Renamed", dataURL: fontURL, weight: 400, style: "normal", name: "renamed.ttf" },
      { family: "Have", dataURL: fontURL, weight: 400, style: "normal", name: "have.ttf" },
    ],
  };
  const back = await importProject(new Blob([JSON.stringify(file)]), new AssetStore(), fonts);
  assert.equal(calls.length, 2, "both faces of the new family, none for the one already here");
  assert.deepEqual(calls[0], { name: "renamed-bold.ttf", family: "Renamed", weight: 700, style: "italic" });
  assert.equal(back.layers[0].font, "Renamed (yours)");
  assert.equal(back.layers[1].font, "Have");
});

Deno.test("project files: junk is refused with a plain message", async () => {
  await assert.rejects(() => importProject(new Blob(["not json"]), new AssetStore()), /not a Longitude project/);
  await assert.rejects(() => importProject(new Blob(['{"hello":1}']), new AssetStore()), /not a Longitude project/);
  const bare = await importProject(new Blob([JSON.stringify({ width: 500, height: 500, layers: [{ type: "shape" }] })]), new AssetStore());
  assert.equal(bare.width, 500);
  assert.equal(bare.layers.length, 1);
  const missing = await quiet(() => importProject(new Blob([JSON.stringify({ format: "longitude", doc: { layers: [] }, assets: { ast_x: "data:image/png;base64,AAAA" } })]), new AssetStore()));
  assert.equal(missing.layers.length, 0);
});

Deno.test("autosave: debounced save after committed changes, skips blank designs", async () => {
  const store = new Store();
  const projects = new ProjectStore();
  const saved = [];
  const auto = createAutosave({ store, projects, delay: 10, thumbEvery: 10_000, onSaved: (e) => saved.push(e.id) });
  try {
    await quiet(async () => {
      store.setDocProps({ name: "Blank" });
      await wait(30);
      assert.equal(saved.length, 0, "an empty, never-saved design is not saved");

      store.begin("Move");
      store.add(createLayer("text"));
      await wait(30);
      assert.equal(saved.length, 0, "transient changes wait for the commit");
      store.commit();
      store.patch(store.layers()[0].id, { x: 1 });
      await wait(40);
      assert.deepEqual(saved, [store.doc.id], "one save for a burst of changes");
      assert.equal((await projects.load(store.doc.id)).layers[0].x, 1);

      store.patch(store.layers()[0].id, { x: 2 });
      const firstId = store.doc.id;
      const next = createDoc({ name: "Next" });
      store.setDoc(next);
      await auto.flush();
      assert.equal((await projects.load(firstId)).layers[0].x, 2, "switching designs saves the previous one first");
      assert.equal(await projects.has(next.id), false);
    });
  } finally {
    auto.dispose();
  }
});

Deno.test("project files: custom fonts come from the registry when they are not stored", async () => {
  const face = new Blob([new Uint8Array([0, 1, 0, 0])], { type: "font/ttf" });
  const fonts = {
    usedIn: () => ["mine"],
    get: () => ({ source: "custom" }),
    getCustom: (f) => (f.toLowerCase() === "mine" ? { family: "Mine", faces: [{ blob: face, weight: 700, style: "italic", name: "mine-bold.ttf" }] } : null),
  };
  const doc = createDoc();
  doc.layers.push(createLayer("text", { text: "HI", font: "mine" }));
  const json = JSON.parse(await (await exportProject(doc, new AssetStore(), fonts)).text());
  assert.equal(json.fonts.length, 1, "kept without IndexedDB");
  assert.deepEqual({ ...json.fonts[0], dataURL: undefined }, { family: "mine", dataURL: undefined, weight: 700, style: "italic", name: "mine-bold.ttf" });
  assert.equal(json.fonts[0].dataURL, await blobToDataURL(face));
});

Deno.test("project files: what could not be restored is reported", async () => {
  const fontURL = await blobToDataURL(new Blob([new Uint8Array([0, 1, 0, 0])], { type: "font/ttf" }));
  const fonts = {
    get: () => null,
    addCustom: async () => {
      throw Error("This font file could not be read.");
    },
  };
  const file = {
    format: "longitude",
    v: 1,
    doc: { layers: [{ type: "image", asset: "ast_x" }, { type: "text", font: "Gone" }] },
    assets: { ast_x: "data:image/png;base64,AAAA", ast_y: 42, ast_ok: "data:image/png;base64," + PNG_B64 },
    fonts: [{ family: "Gone", dataURL: fontURL, weight: 400, style: "normal", name: "gone.ttf" }],
  };
  const doc = await quiet(() => importProject(new Blob([JSON.stringify(file)]), new AssetStore(), fonts));
  const report = importReport(doc);
  assert.equal(report.images, 2, "the broken image and the entry that is not a data URL");
  assert.equal(report.fonts, 1);
  assert.ok(report.message);
  const clean = await importProject(new Blob([JSON.stringify({ format: "longitude", doc: { layers: [] }, assets: {} })]), new AssetStore());
  assert.equal(importReport(clean), null);
  assert.equal(Object.keys(doc).includes("report"), false, "the doc itself stays clean");
});

// A projects store that records what was saved, for autosave tests.
function recordingProjects() {
  const saves = [];
  return {
    saves,
    has: async (id) => saves.some((s) => s.id === id),
    save: async (doc) => {
      saves.push(structuredClone(doc));
      return Date.now();
    },
  };
}

Deno.test("autosave: text typed in an open edit is saved when the page hides", async () => {
  const store = new Store();
  const projects = recordingProjects();
  const auto = createAutosave({ store, projects, delay: 10, liveDelay: 0, thumbEvery: 1e9 });
  try {
    await quiet(async () => {
      const [shape] = store.add(createLayer("shape"));
      await wait(30);
      assert.equal(projects.saves.length, 1);

      store.begin("Add text");
      const [id] = store.add(createLayer("text", { text: "" }));
      store.patch(id, { text: "MY BIG TITLE" }, { transient: true });
      assert.equal(auto.pending, true, "a gesture holding edits counts as unsaved");
      globalThis.dispatchEvent(new Event("pagehide"));
      await auto.flush();
      assert.equal(projects.saves.length, 2);
      assert.deepEqual(projects.saves[1].layers.map((l) => l.text ?? l.type), ["shape", "MY BIG TITLE"]);
      assert.equal(store.inGesture, true, "the edit stays open");

      store.patch(id, { text: "" }, { transient: true });
      globalThis.dispatchEvent(new Event("pagehide"));
      await auto.flush();
      assert.deepEqual(projects.saves[2].layers.map((l) => l.id), [shape], "a new text left empty is left out");
      store.commit();

      store.begin("Edit text");
      store.patch(id, { text: "" }, { transient: true });
      store.patch(shape, { x: 5 }, { transient: true });
      globalThis.dispatchEvent(new Event("pagehide"));
      await auto.flush();
      const last = projects.saves.at(-1);
      assert.equal(last.layers.find((l) => l.id === id).text, "", "committed empty text stays as committed");
      assert.equal(last.layers.find((l) => l.id === shape).x, 5);
      store.cancel();
    });
  } finally {
    auto.dispose();
  }
});

Deno.test("autosave: an existing text emptied mid-edit is saved as it was", async () => {
  const store = new Store();
  const projects = recordingProjects();
  const auto = createAutosave({ store, projects, delay: 10, liveDelay: 0, thumbEvery: 1e9 });
  try {
    await quiet(async () => {
      const [id] = store.add(createLayer("text", { text: "OLD TITLE" }));
      await wait(30);
      store.begin("Edit text");
      store.patch(id, { text: "" }, { transient: true });
      await auto.flush();
      assert.equal(projects.saves.at(-1).layers[0].text, "OLD TITLE");
      store.cancel();
    });
  } finally {
    auto.dispose();
  }
});

Deno.test("autosave: replacing the design mid-edit saves the typed text first", async () => {
  const store = new Store();
  const projects = recordingProjects();
  const auto = createAutosave({ store, projects, delay: 10, liveDelay: 0, thumbEvery: 1e9 });
  try {
    await quiet(async () => {
      store.add(createLayer("shape"));
      await wait(30);
      const first = store.doc.id;
      store.begin("Add text");
      const [id] = store.add(createLayer("text", { text: "" }));
      store.patch(id, { text: "TYPED" }, { transient: true });
      store.setDoc(createDoc({ name: "Opened file" }), { history: "reset" });
      assert.equal(store.inGesture, false);
      await auto.flush();
      const saved = projects.saves.filter((s) => s.id === first).at(-1);
      assert.deepEqual(saved.layers.map((l) => l.text ?? l.type), ["shape", "TYPED"]);
    });
  } finally {
    auto.dispose();
  }
});

Deno.test("autosave: a pause in an open edit saves it, font previews do not", async () => {
  const store = new Store();
  const projects = recordingProjects();
  const auto = createAutosave({ store, projects, delay: 10, liveDelay: 20, thumbEvery: 1e9 });
  try {
    await quiet(async () => {
      const [id] = store.add(createLayer("text", { text: "A" }));
      await wait(30);
      const n = projects.saves.length;
      store.patch(id, { font: "Preview" }, { transient: true });
      await wait(40);
      assert.equal(projects.saves.length, n, "a transient change outside a gesture is not saved");
      store.patch(id, { font: "Anton" }, { transient: true });
      store.begin("Edit text");
      store.patch(id, { text: "AB" }, { transient: true });
      await wait(40);
      assert.equal(projects.saves.length, n + 1);
      assert.equal(projects.saves.at(-1).layers[0].text, "AB");
      store.commit();
    });
  } finally {
    auto.dispose();
  }
});

Deno.test("autosave: the save on close goes out at once and an older queued write never lands on top", async () => {
  const store = new Store();
  const saves = [];
  let release;
  const projects = {
    has: () => new Promise((r) => (release = r)),
    save: async (doc) => {
      saves.push(structuredClone(doc));
      return Date.now();
    },
  };
  const auto = createAutosave({ store, projects, delay: 1e9, liveDelay: 0, thumbEvery: 1e9 });
  try {
    await quiet(async () => {
      store.setDocProps({ name: "Named" });
      const stuck = auto.flush();
      await wait(5);
      assert.equal(auto.saving, true, "the first write waits");
      store.add(createLayer("shape"));
      globalThis.dispatchEvent(new Event("pagehide"));
      await Promise.resolve();
      assert.equal(saves.length, 1, "the close save did not wait behind it");
      assert.equal(saves[0].layers.length, 1);
      release(true);
      await stuck;
      await auto.flush();
      assert.equal(saves.length, 1, "the older copy was not written over the newer one");
      assert.equal(auto.saving, false);
    });
  } finally {
    auto.dispose();
  }
});

Deno.test("ProjectStore: a save after load does not read first", async () => {
  const projects = new ProjectStore();
  const doc = createDoc({ name: "Kept" });
  doc.layers.push(createLayer("shape"));
  await projects.save(doc, new Blob(["thumb"], { type: "image/webp" }));
  const fresh = new ProjectStore();
  await fresh.load(doc.id);
  let reads = 0;
  const get = fresh._table.get;
  fresh._table.get = (...a) => (reads++, get(...a));
  await fresh.save({ ...doc, name: "Kept 2" });
  assert.equal(reads, 0);
  assert.equal((await fresh.list()).find((p) => p.id === doc.id).thumb.type, "image/webp", "the thumbnail is kept");
  const other = new ProjectStore();
  await other.save({ ...doc, name: "Kept 3" });
  assert.equal((await other.list()).find((p) => p.id === doc.id).thumb.type, "image/webp", "unknown designs keep it too");
});

Deno.test("ProjectStore: a window does not write over a newer copy saved in another window", async () => {
  const a = new ProjectStore(null, { sync: true });
  const b = new ProjectStore(null, { sync: true });
  try {
    const doc = createDoc({ name: "Shared" });
    doc.layers.push(createLayer("shape"));
    await a.save(doc);
    await b.load(doc.id);
    await a.load(doc.id);
    await b.save({ ...doc, name: "From B" });
    await wait(20);
    await assert.rejects(() => a.save({ ...doc, name: "Stale A" }), (err) => err.code === "conflict" && /another Longitude window/.test(err.message));
    assert.equal((await a.load(doc.id)).name, "From B");
    await a.save({ ...doc, name: "A after reopening" });
  } finally {
    a.dispose();
    b.dispose();
  }
});

Deno.test("AssetStore: images the open design does not use leave memory first", () => {
  const assets = new AssetStore({ memoryBudget: 1000 });
  const img = () => ({ width: 10, height: 10 });
  let t = 0;
  assets.now = () => t;
  assets.setLive(["a", "b"]);
  for (const id of ["a", "b", "c", "d", "e"]) assets._setImage(id, img());
  assert.equal(assets.images.size, 5, "just decoded: not counted as unused yet (an import adds them after)");
  t += 20000;
  assets.setLive(["a", "b"]);
  assert.deepEqual([...assets.images.keys()], ["a", "b", "d", "e"], "at most a quarter of the budget for unused images");
  t += 20000;
  assets._setImage("f", img());
  assert.deepEqual([...assets.images.keys()], ["a", "b", "e", "f"]);
  assets.setLive(["e"]);
  assert.deepEqual([...assets.images.keys()], ["b", "e", "f"], "the oldest unused image goes when the design changes");
  assert.equal(assets.pixels, 300);
  assets.setLive(["e", "f", "g", "h"]);
  assets._setImage("g", { width: 20, height: 20 });
  assets._setImage("h", { width: 20, height: 20 });
  assets._setImage("i", { width: 20, height: 20 });
  assert.ok(assets.pixels <= 1000);
  assert.ok(assets.images.has("i"), "the image just decoded stays");
});

Deno.test("AssetStore: gc waits until other windows are closed", async () => {
  if (!globalThis.navigator?.locks?.query) return;
  const other = new AssetStore({ coordinate: true });
  await other.init();
  await wait(5);
  const assets = new AssetStore();
  try {
    await assert.rejects(() => assets.gc([]), /Close the other Longitude windows/);
  } finally {
    other.dispose();
  }
  await wait(5);
  assert.equal(typeof (await assets.gc([])), "number");
});

Deno.test("autosave: markDirty stores a design that arrived with content", async () => {
  const store = new Store();
  const projects = recordingProjects();
  const auto = createAutosave({ store, projects, delay: 1e9, liveDelay: 0, thumbEvery: 1e9 });
  try {
    await quiet(async () => {
      const doc = createDoc({ name: "From a file" });
      doc.layers.push(createLayer("shape"));
      store.setDoc(doc);
      assert.equal(projects.saves.length, 0, "opening alone is not a change");
      await auto.markDirty();
      assert.deepEqual(projects.saves.map((s) => s.name), ["From a file"]);
    });
  } finally {
    auto.dispose();
  }
});
