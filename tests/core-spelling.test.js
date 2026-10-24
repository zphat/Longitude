// The engine and the shared UI pieces use American spelling ("color",
// "center", "gray", "license", "canceled"), in UI text and in code.
//   deno test --allow-read tests/core-spelling.test.js

import assert from "node:assert/strict";

const DIRS = ["web/js/core", "web/js/features"];
const FILES = ["web/css/tokens.css", "web/css/controls.css", "web/js/ui/controls.js", "web/js/ui/dom.js", "web/js/ui/theme.js", "web/js/app/context.js"];
const BRITISH = /colour|centre|\bgrey|licence|behaviour|favourite/gi;
// Messages say "Canceled"; the error code and event field "cancelled" are API
// (mods and the UI read them), so only the message forms are checked.
const CANCEL = /\bCancelled\b|\bwas cancelled\b|\ba cancelled\b/g;

async function* walk(dir) {
  for await (const e of Deno.readDir(new URL(`../${dir}`, import.meta.url))) {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory) yield* walk(path);
    else if (/\.(js|css)$/.test(e.name)) yield path;
  }
}

Deno.test("engine and shared controls use American spelling", async () => {
  const files = [...FILES];
  for (const dir of DIRS) for await (const f of walk(dir)) files.push(f);
  assert.ok(files.length > 20, "found the files");
  for (const file of files) {
    const text = await Deno.readTextFile(new URL(`../${file}`, import.meta.url));
    const hits = [...text.matchAll(BRITISH), ...text.matchAll(CANCEL)].map((m) => m[0]);
    assert.deepEqual(hits, [], `${file}: ${hits.join(", ")}`);
  }
});
