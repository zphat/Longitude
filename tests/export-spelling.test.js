// The export dialog, quick tools and feed preview use American spelling
// ("color", "center", "gray", "license"), in UI text and in code.
//   deno test --allow-read tests/export-spelling.test.js

import assert from "node:assert/strict";

const FILES = ["web/js/ui/exportdialog.js", "web/js/ui/quicktools.js", "web/js/ui/feedpreview.js", "web/css/export.css"];
const BRITISH = /colour|centre|\bgrey|licence|behaviour|favourite/gi;

Deno.test("export, quick tools and feed preview use American spelling", async () => {
  for (const file of FILES) {
    const text = await Deno.readTextFile(new URL(`../${file}`, import.meta.url));
    const hits = [...text.matchAll(BRITISH)].map((m) => m[0]);
    assert.deepEqual(hits, [], `${file}: ${hits.join(", ")}`);
  }
});
