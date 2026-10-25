// The line under the inspector's Remove background button: the size before
// the first use, the state while the model downloads, nothing once it is here.
//   deno test --allow-read tests/inspector-bghint.test.js

import assert from "node:assert/strict";
import { removeActionLabel, removeHint } from "../web/js/ui/inspector.js";
import { BG_CONFIG, describeStatus, nextStatus } from "../web/js/features/bgremove/index.js";

const fast = BG_CONFIG.models[BG_CONFIG.providers.fast.model];
const runtime = ["script", "glue", "wasm"].reduce((s, k) => s + BG_CONFIG.ort.builds.webgpu[k].bytes, 0);
const SIZE = fast.variants.int8.bytes + runtime;
const base = { id: "fast", label: "Fast", kind: "ml", state: "checking", ready: false, sizeBytes: SIZE, downloadBytes: SIZE, bytes: 0, total: 0, speed: null, eta: null };

Deno.test("removeHint: the size first, the progress while downloading, then nothing", () => {
  assert.equal(removeHint(base, describeStatus), "", "nothing while the first look runs");
  let s = nextStatus(base, { type: "checked", ready: false, sizeBytes: SIZE, downloadBytes: SIZE });
  assert.equal(removeHint(s, describeStatus), "One-time 69 MB download");
  s = nextStatus(s, { type: "start", total: SIZE });
  assert.equal(removeHint(s, describeStatus), "Downloading · 0%");
  s = nextStatus(s, { type: "progress", bytes: SIZE / 2 });
  assert.equal(removeHint(s, describeStatus), "Downloading · 50%");
  s = nextStatus(s, { type: "fail", message: "Could not download the model. Check your connection and try again.", code: "network" });
  assert.equal(removeHint(s, describeStatus), "Download stopped");
  s = nextStatus(s, { type: "start", total: SIZE });
  s = nextStatus(s, { type: "done" });
  assert.equal(removeHint(s, describeStatus), "", "ready: the button is just its label");
});

Deno.test("removeHint: bundled and local providers never show a line", () => {
  const bundled = nextStatus(base, { type: "checked", ready: true, bundled: true, sizeBytes: SIZE });
  assert.equal(bundled.state, "ready-bundled");
  assert.equal(removeHint(bundled, describeStatus), "", "included with the app stays quiet");
  const magic = { ...base, id: "magic", kind: "local", state: "ready-bundled", ready: true };
  assert.equal(removeHint(magic, describeStatus), "");
  assert.equal(removeHint(null, describeStatus), "");
  assert.equal(removeHint(base, null), "", "no describe(): nothing");
});

Deno.test("removeActionLabel: the consent names the download when there is one", () => {
  assert.equal(removeActionLabel({ id: "fast", kind: "ml", cached: false }), "Download and remove");
  assert.equal(removeActionLabel({ id: "best", kind: "ml", cached: true }), "Remove background", "already here");
  assert.equal(removeActionLabel({ id: "magic", kind: "local", cached: true }), "Remove background", "Magic downloads nothing");
  assert.equal(removeActionLabel(null), "Remove background", "unknown: no promise of a download");
});
