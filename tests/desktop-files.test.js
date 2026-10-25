// The desktop app's file handling: what it opens from the command line (the
// same list on the Rust side and the page side), how each file is routed, and
// the Save dialog it uses for exports and project files (web/js/app/desktop.js).
//   deno test --allow-read tests/desktop-files.test.js

import assert from "node:assert/strict";
import { OPEN_TYPES, extOf, fileRoute, mimeForName, savePickerOptions, saveWithPicker, toBytes } from "../web/js/app/desktop.js";
import { fileKind } from "../web/js/ui/commands-core.js";

const read = (path) => Deno.readTextFile(new URL(`../${path}`, import.meta.url));

Deno.test("extOf and mimeForName", () => {
  assert.equal(extOf("Thumb final.LONGITUDE"), "longitude");
  assert.equal(extOf("C:\\Users\\x\\photo.JPG"), "jpg");
  assert.equal(extOf("noext"), "");
  assert.equal(extOf(".hidden"), "hidden");
  assert.equal(mimeForName("a.png"), "image/png");
  assert.equal(mimeForName("a.jpeg"), "image/jpeg");
  assert.equal(mimeForName("a.woff2"), "font/woff2");
  assert.equal(mimeForName("a.longitude"), "application/x-longitude");
  assert.equal(mimeForName("a.exe"), "");
});

Deno.test("fileRoute sorts files the way Open a file does", () => {
  for (const name of Object.keys(OPEN_TYPES).map((ext) => `file.${ext}`)) {
    const route = fileRoute(name);
    assert.ok(route, name);
    assert.equal(route, fileKind({ name, type: mimeForName(name) }), `${name}: desktop.js and commands-core agree`);
  }
  assert.equal(fileRoute("design.longitude"), "project");
  assert.equal(fileRoute("cover.webp"), "image");
  assert.equal(fileRoute("Font.OTF"), "font");
  assert.equal(fileRoute("notes.txt"), null);
  assert.equal(fileRoute("setup.exe"), null);
});

Deno.test("the Rust side opens exactly the files the page can route", async () => {
  const rust = await read("src-tauri/src/lib.rs");
  const m = rust.match(/const OPENABLE: \[&str; (\d+)\] = \[([^\]]*)\];/);
  assert.ok(m, "OPENABLE in lib.rs");
  const list = [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  assert.equal(list.length, Number(m[1]), "the array length matches its type");
  assert.deepEqual([...list].sort(), Object.keys(OPEN_TYPES).sort());
});

Deno.test(".longitude is registered with Windows under the name the page uses", async () => {
  const conf = JSON.parse(await read("src-tauri/tauri.conf.json"));
  const assoc = conf.bundle.fileAssociations;
  assert.equal(assoc.length, 1);
  assert.deepEqual(assoc[0].ext, ["longitude"]);
  assert.equal(assoc[0].description, "Longitude design");
  assert.equal(assoc[0].mimeType, OPEN_TYPES.longitude);
});

Deno.test("toBytes: ArrayBuffer, views and number arrays; nothing else", () => {
  const buf = new Uint8Array([1, 2, 3]).buffer;
  assert.deepEqual([...toBytes(buf)], [1, 2, 3]);
  const view = new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4);
  assert.deepEqual([...toBytes(view)], [1, 2, 3]);
  assert.deepEqual([...toBytes(new DataView(buf))], [1, 2, 3]);
  assert.deepEqual([...toBytes([4, 5])], [4, 5]);
  assert.equal(toBytes("text"), null);
  assert.equal(toBytes(null), null);
  assert.equal(toBytes({ length: 2 }), null);
});

Deno.test("savePickerOptions: designs go to Documents, exports to Pictures", () => {
  const p = savePickerOptions("My thumb.longitude", "application/json");
  assert.equal(p.suggestedName, "My thumb.longitude");
  assert.equal(p.id, "longitude-designs");
  assert.equal(p.startIn, "documents");
  assert.deepEqual(p.types, [{ description: "Longitude design", accept: { "application/x-longitude": [".longitude"] } }]);

  const j = savePickerOptions("thumb-1280x720.jpg", "image/jpeg");
  assert.equal(j.id, "longitude-exports");
  assert.equal(j.startIn, "pictures");
  assert.deepEqual(j.types[0].accept, { "image/jpeg": [".jpg", ".jpeg"] });
  assert.deepEqual(savePickerOptions("a.jpeg").types[0].accept, { "image/jpeg": [".jpg", ".jpeg"] });
  assert.deepEqual(savePickerOptions("batch.zip", "application/zip").types[0].accept, { "application/zip": [".zip"] });
  assert.deepEqual(savePickerOptions("noext", "image/webp").types[0].accept, { "image/webp": [".webp"] });
  assert.equal(savePickerOptions("readme", "text/plain").types, undefined, "unknown types get the plain dialog");
  for (const o of [p, j]) {
    assert.ok(/^[A-Za-z0-9_-]{1,32}$/.test(o.id), "a valid picker id");
    for (const t of o.types) for (const exts of Object.values(t.accept)) for (const e of exts) assert.ok(/^\.[a-z0-9]{1,16}$/.test(e), e);
  }
});

function fakePicker(behavior) {
  const calls = { pick: [], written: [], closed: 0, aborted: 0, fallback: 0 };
  const g = {
    showSaveFilePicker(opts) {
      calls.pick.push({ opts, self: this });
      if (behavior === "cancel") return Promise.reject(Object.assign(new Error("The user aborted a request."), { name: "AbortError" }));
      if (behavior === "no-gesture") return Promise.reject(Object.assign(new Error("Must be handling a user gesture"), { name: "SecurityError" }));
      return Promise.resolve({
        createWritable: async () => ({
          write: async (b) => {
            if (behavior === "disk-full") throw Object.assign(new Error("There is not enough space on the disk."), { name: "QuotaExceededError" });
            calls.written.push(b);
          },
          close: async () => void calls.closed++,
          abort: async () => void calls.aborted++,
        }),
      });
    },
  };
  return { g, calls, fallback: () => void calls.fallback++ };
}

Deno.test("saveWithPicker: saved, canceled, no gesture left, no picker, write failure", async () => {
  const blob = new Blob(["x"], { type: "image/png" });

  let f = fakePicker("ok");
  assert.equal(await saveWithPicker(blob, "a.png", { g: f.g, fallback: f.fallback }), "saved");
  assert.equal(f.calls.written[0], blob);
  assert.equal(f.calls.closed, 1);
  assert.equal(f.calls.fallback, 0);
  assert.equal(f.calls.pick[0].self, f.g, "called on the window, not detached");
  assert.equal(f.calls.pick[0].opts.suggestedName, "a.png");

  f = fakePicker("cancel");
  assert.equal(await saveWithPicker(blob, "a.png", { g: f.g, fallback: f.fallback }), "canceled");
  assert.equal(f.calls.fallback, 0, "a closed dialog saves nothing");

  f = fakePicker("no-gesture");
  assert.equal(await saveWithPicker(blob, "a.png", { g: f.g, fallback: f.fallback }), "downloaded");
  assert.equal(f.calls.fallback, 1, "a long export falls back to the download");

  const none = { calls: 0 };
  assert.equal(await saveWithPicker(blob, "a.png", { g: {}, fallback: () => none.calls++ }), "downloaded");
  assert.equal(none.calls, 1);

  f = fakePicker("disk-full");
  await assert.rejects(saveWithPicker(blob, "a.png", { g: f.g, fallback: f.fallback }), /not enough space/);
  assert.equal(f.calls.aborted, 1, "a failed write is aborted, not left half written");
  assert.equal(f.calls.fallback, 0);
});
