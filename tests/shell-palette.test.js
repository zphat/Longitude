// Tests for the palette's fuzzy matching (web/js/ui/palette.js)
//   deno test --allow-read tests/shell-palette.test.js

import assert from "node:assert/strict";
import { fuzzyMatch, scoreItem, highlightRuns, rankItems } from "../web/js/ui/palette.js";

Deno.test("fuzzyMatch: empty query matches everything with score 0", () => {
  assert.deepEqual(fuzzyMatch("", "Anything"), { score: 0, indices: [] });
});

Deno.test("fuzzyMatch: substring hits are contiguous and case-insensitive", () => {
  const r = fuzzyMatch("EXP", "Export");
  assert.ok(r);
  assert.deepEqual(r.indices, [0, 1, 2]);
});

Deno.test("fuzzyMatch: characters must appear in order", () => {
  assert.equal(fuzzyMatch("xe", "Export"), null);
  assert.equal(fuzzyMatch("toolong", "tool"), null);
});

Deno.test("fuzzyMatch: prefers word starts (acronyms)", () => {
  const r = fuzzyMatch("btf", "Bring to front");
  assert.ok(r);
  assert.deepEqual(r.indices, [0, 6, 9]);
});

Deno.test("fuzzyMatch: a prefix outranks a scattered match", () => {
  const a = fuzzyMatch("sa", "Select all");
  const b = fuzzyMatch("sa", "Safe zones");
  assert.ok(a && b);
  assert.ok(b.score > a.score);
  assert.ok(fuzzyMatch("dh", "Distribute horizontally").score > fuzzyMatch("dh", "Hide or show").score);
});

Deno.test("fuzzyMatch: camelCase boundaries count as word starts", () => {
  const r = fuzzyMatch("ff", "fileFormat");
  assert.deepEqual(r.indices, [0, 4]);
});

Deno.test("scoreItem: every word must match title, keywords or group", () => {
  const item = { title: "Align left", group: "Align", keywords: "edge arrange" };
  assert.ok(scoreItem("al le", item));
  assert.ok(scoreItem("edge", item));
  assert.equal(scoreItem("zoom", item), null);
});

Deno.test("scoreItem: title hits beat keyword hits and give highlight indices", () => {
  const byTitle = scoreItem("crop", { title: "Crop image", keywords: "" });
  const byKeyword = scoreItem("crop", { title: "Frame", keywords: "crop mask" });
  assert.ok(byTitle.score > byKeyword.score);
  assert.deepEqual(byTitle.indices, [0, 1, 2, 3]);
  assert.deepEqual(byKeyword.indices, []);
});

Deno.test("highlightRuns: groups consecutive hits", () => {
  assert.deepEqual(highlightRuns("Export", [0, 1, 3]), [
    { text: "Ex", hit: true },
    { text: "p", hit: false },
    { text: "o", hit: true },
    { text: "rt", hit: false },
  ]);
});

Deno.test("rankItems: empty query keeps group order and drops query-only items", () => {
  const items = [
    { title: "Zoom in", group: "View" },
    { title: "Undo", group: "Edit" },
    { title: "New YouTube thumbnail", group: "New design", queryOnly: true },
    { title: "New design", group: "File" },
  ];
  const groups = rankItems(items, "");
  assert.deepEqual(groups.map((g) => g.group), ["File", "Edit", "View"]);
});

Deno.test("rankItems: with a query the best match's group comes first", () => {
  const items = [
    { title: "Zoom in", group: "View" },
    { title: "Export", group: "Export" },
    { title: "Expand", group: "View" },
    { title: "New YouTube thumbnail", group: "New design", queryOnly: true },
  ];
  const groups = rankItems(items, "exp");
  assert.equal(groups[0].group, "Export");
  assert.equal(groups[0].rows[0].it.title, "Export");
  assert.ok(rankItems(items, "youtube").some((g) => g.group === "New design"));
});

Deno.test("scoreItem: keywords need the whole word, not scattered letters", () => {
  assert.equal(scoreItem("flip", { title: "New YouTube profile picture", keywords: "profile picture avatar icon logo pfp" }), null);
  assert.ok(scoreItem("pfp", { title: "New YouTube profile picture", keywords: "profile picture avatar icon logo pfp" }));
  assert.ok(scoreItem("algn", { title: "Align left", keywords: "" }));
});
