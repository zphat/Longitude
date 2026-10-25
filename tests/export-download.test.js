// download() resolves false when the desktop Save dialog is canceled (or its
// write failed), so the views that say "Saved" wait for it first (SPEC 12).
//   deno test --allow-read tests/export-download.test.js

import assert from "node:assert/strict";

const read = (p) => Deno.readTextFile(new URL(`../web/js/${p}`, import.meta.url));
// The text of one function, from its declaration to the closing brace at its indent.
function body(src, decl) {
  const at = src.indexOf(decl);
  assert.ok(at >= 0, `${decl} not found`);
  const indent = /^[ \t]*/.exec(src.slice(src.lastIndexOf("\n", at) + 1))[0];
  const end = src.indexOf(`\n${indent}}\n`, at);
  return src.slice(at, end);
}

Deno.test("download() resolves to a boolean in a browser too", async () => {
  const src = await read("features/compress.js");
  const fn = body(src, "export function download(");
  assert.match(fn, /return Promise\.resolve\(true\)/);
  assert.match(fn, /saveHandler\(\)/);
});

Deno.test("Export waits for the Save dialog before closing and saying Saved", async () => {
  const fn = body(await read("ui/exportdialog.js"), "async function doDownload(");
  assert.match(fn, /const saved = await download\(/);
  const check = fn.indexOf("!saved");
  assert.ok(check > 0 && check < fn.indexOf("sheet.close()") && check < fn.indexOf("Saved "), "a canceled dialog leaves the sheet open, with no toast");
});

Deno.test("Save a copy says Saved only once the file is written", async () => {
  const fn = body(await read("ui/commands-core.js"), "async function saveCopy(");
  assert.match(fn, /await exporter\.download\(blob, name\)\) === false\) return/);
  assert.ok(fn.indexOf("=== false) return") < fn.indexOf("Saved the project file"));
});

Deno.test("Quick tools keep their buttons busy until the dialog closes", async () => {
  const src = await read("ui/quicktools.js");
  const all = body(src, "async function downloadAll(");
  assert.equal((all.match(/await download\(/g) || []).length, 2);
  assert.match(body(src, "async function downloadResult("), /await download\(/);
});
