// Tests for the pure helpers in web/js/ui/layers.js
//   deno test --allow-read tests/inspector-layers.test.js

import assert from "node:assert/strict";
import { moveToGap, rangeIds, displayName, thumbKey } from "../web/js/ui/layers.js";
import { createLayer } from "../web/js/core/model.js";

// Doc order is bottom -> top; the panel shows top -> bottom.
const DOC = ["a", "b", "c", "d", "e"]; // panel: e d c b a

Deno.test("moveToGap: one layer to the top and the bottom", () => {
  assert.deepEqual(moveToGap(DOC, ["a"], 0), ["b", "c", "d", "e", "a"]);
  assert.deepEqual(moveToGap(DOC, ["e"], 5), ["e", "a", "b", "c", "d"]);
});

Deno.test("moveToGap: one step up and down in the panel", () => {
  // c sits at panel index 2; gap 1 is between e/d... d/c boundary is gap 2.
  assert.deepEqual(moveToGap(DOC, ["c"], 1), ["a", "b", "d", "c", "e"]);
  assert.deepEqual(moveToGap(DOC, ["c"], 4), ["a", "c", "b", "d", "e"]);
});

Deno.test("moveToGap: dropping a layer next to itself changes nothing", () => {
  assert.deepEqual(moveToGap(DOC, ["c"], 2), DOC);
  assert.deepEqual(moveToGap(DOC, ["c"], 3), DOC);
});

Deno.test("moveToGap: several layers keep their order", () => {
  assert.deepEqual(moveToGap(DOC, ["a", "d"], 0), ["b", "c", "e", "a", "d"]);
  assert.deepEqual(moveToGap(DOC, ["e", "b"], 5), ["b", "e", "a", "c", "d"]);
  assert.deepEqual(moveToGap(DOC, ["b", "d"], 2), ["a", "c", "b", "d", "e"]);
});

Deno.test("moveToGap: unknown ids and out-of-range gaps", () => {
  assert.deepEqual(moveToGap(DOC, ["zz"], 0), DOC);
  assert.deepEqual(moveToGap(DOC, ["a"], -4), ["b", "c", "d", "e", "a"]);
  assert.deepEqual(moveToGap(DOC, ["e"], 99), ["e", "a", "b", "c", "d"]);
});

Deno.test("rangeIds: inclusive in either direction", () => {
  const panel = ["e", "d", "c", "b", "a"];
  assert.deepEqual(rangeIds(panel, "d", "b"), ["d", "c", "b"]);
  assert.deepEqual(rangeIds(panel, "b", "d"), ["d", "c", "b"]);
  assert.deepEqual(rangeIds(panel, "c", "c"), ["c"]);
  assert.deepEqual(rangeIds(panel, "zz", "c"), ["c"]);
  assert.deepEqual(rangeIds(panel, "c", "zz"), []);
});

Deno.test("displayName: default-named text shows its words", () => {
  assert.equal(displayName(createLayer("text", { text: "WAIT\nWHAT" })), "WAIT WHAT");
  assert.equal(displayName(createLayer("text", { text: "x", name: "Title" })), "Title");
  assert.equal(displayName(createLayer("text", { text: "   " })), "Text");
  assert.equal(displayName(createLayer("text", { text: "a".repeat(60) })).length, 40);
  assert.equal(displayName(createLayer("shape", { shape: "star" })), "Star");
});

Deno.test("thumbKey ignores position, name and flags", () => {
  const l = createLayer("shape", { x: 10, y: 10 });
  const moved = { ...l, x: 500, y: 90, name: "Other", hidden: true, locked: true };
  assert.equal(thumbKey(l), thumbKey(moved));
  assert.notEqual(thumbKey(l), thumbKey({ ...l, fill: { on: true, color: "#000000" } }));
  assert.notEqual(thumbKey(l), thumbKey({ ...l, rotation: 30 }));
});
