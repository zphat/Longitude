// Settings > Background removal names only what still downloads: nothing
// about jsDelivr when the runtime is installed with the app, and a
// web/vendor/ folder from tools/fetch_model.py is not called part of the app.
//   deno test --allow-read tests/mods-settings-bgcopy.test.js

import assert from "node:assert/strict";
import { bgCopy } from "../web/js/ui/settings.js";

const fast = (state, extra = {}) => ({ id: "fast", label: "Fast", kind: "ml", model: "isnet-general", state, ...extra });
const best = (state, extra = {}) => ({ id: "best", label: "Best (fine detail)", kind: "ml", model: "birefnet-lite", state, ...extra });
const magic = { id: "magic", label: "Magic (flat backgrounds)", kind: "local", model: null, state: "ready-bundled", bundled: true };

Deno.test("bgCopy: a plain browser keeps the one-time download copy", () => {
  const c = bgCopy([fast("not-downloaded"), best("not-downloaded"), magic]);
  assert.match(c.note, /models from Hugging Face, the runtime from jsDelivr/);
  assert.equal(c.models, "Each model downloads once, then works offline.");
  assert.equal(c.runtime, "which comes once, with the first one");
  assert.deepEqual(bgCopy([fast("ready-cached"), best("checking"), magic]), c, "downloaded is not included");
});

Deno.test("bgCopy: Magic's ready-bundled state never counts as included", () => {
  assert.match(bgCopy([magic]).note, /jsDelivr/);
  // A mod's ml provider (no model) neither.
  assert.match(bgCopy([{ id: "mod", label: "Mod", kind: "ml", model: null, state: "ready-bundled" }]).note, /jsDelivr/);
});

Deno.test("bgCopy: the desktop app names Fast and the runtime as included", () => {
  const c = bgCopy([fast("ready-bundled", { bundledBy: "app" }), best("not-downloaded"), magic]);
  assert.equal(c.note, "Background removal runs on this computer. Your images are never uploaded. Fast and the runtime are included with the app. Only Best downloads, once, from Hugging Face.");
  assert.doesNotMatch(c.note, /jsDelivr/);
  assert.equal(c.models, "Best downloads once, then works offline.");
  assert.equal(c.runtime, "which is included with the app");
  const all = bgCopy([fast("ready-bundled", { bundledBy: "app" }), best("ready-bundled", { bundledBy: "app" }), magic]);
  assert.match(all.note, /Fast, Best and the runtime are included with the app\. Nothing here needs a download\./);
  assert.equal(all.models, "Everything here works offline.");
});

Deno.test("bgCopy: a fetch_model.py folder is on this computer, not part of the app", () => {
  const c = bgCopy([fast("ready-bundled", { bundledBy: "vendor" }), best("not-downloaded")]);
  assert.match(c.note, /Fast and the runtime are already on this computer \(web\/vendor\)\./);
  assert.doesNotMatch(c.note, /included with the app/);
  assert.equal(c.runtime, "which is already on this computer (web/vendor)");
});
