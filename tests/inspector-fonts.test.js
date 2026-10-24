// Tests for the font picker's pure helpers (web/js/ui/fontpicker.js)
//   deno test --allow-read tests/inspector-fonts.test.js

import assert from "node:assert/strict";
import { filterFonts, groupFonts, fontMeta, tabStep, CATEGORY_TABS } from "../web/js/ui/fontpicker.js";

const FONTS = [
  { family: "Longitude Meridian", label: "Longitude Meridian", category: "original", tags: ["condensed"], weights: [400] },
  { family: "Anton", label: "Anton", category: "classic", tags: ["impact", "condensed"], weights: [400] },
  { family: "Montserrat", label: "Montserrat", category: "classic", tags: ["geometric"], weights: [100, 900], variable: { min: 100, max: 900 }, italic: true },
  { family: "Impact", label: "Impact", category: "meme", tags: ["meme"], weights: [400] },
  { family: "Bangers", label: "Bangers", category: "meme", tags: ["comic"], weights: [400] },
  { family: "Poppins", label: "Poppins", category: "clean", tags: [], weights: [800, 900], italic: true },
  { family: "Mystery", label: "Mystery", category: "weird", tags: [], weights: [400] },
];

Deno.test("CATEGORY_TABS follow the spec order", () => {
  assert.deepEqual(CATEGORY_TABS.map((t) => t.label), ["Original", "Classics", "Meme", "Display", "Clean", "System", "Yours"]);
});

Deno.test("filterFonts: every word must match family, label, category or tag", () => {
  assert.deepEqual(filterFonts(FONTS, "").length, FONTS.length);
  assert.deepEqual(filterFonts(FONTS, "condensed").map((f) => f.family), ["Longitude Meridian", "Anton"]);
  assert.deepEqual(filterFonts(FONTS, "classics condensed").map((f) => f.family), ["Anton"]);
  assert.deepEqual(filterFonts(FONTS, "MONT").map((f) => f.family), ["Montserrat"]);
  assert.deepEqual(filterFonts(FONTS, "meme").map((f) => f.family), ["Impact", "Bangers"]);
  assert.deepEqual(filterFonts(FONTS, "zzz"), []);
});

Deno.test("groupFonts: tab order, empty groups dropped unless kept", () => {
  const g = groupFonts(FONTS);
  assert.deepEqual(g.map((x) => x.id), ["original", "classic", "meme", "display", "clean"]);
  assert.deepEqual(g.find((x) => x.id === "display").items.map((f) => f.family), ["Mystery"], "unknown categories land in Display");
  const kept = groupFonts(FONTS, { keepEmpty: ["custom"] });
  assert.equal(kept[kept.length - 1].id, "custom");
  assert.equal(kept[kept.length - 1].label, "Yours");
  assert.equal(kept[kept.length - 1].items.length, 0);
});

Deno.test("fontMeta", () => {
  assert.equal(fontMeta(FONTS[2]), "Variable · Italic");
  assert.equal(fontMeta(FONTS[5]), "2 weights · Italic");
  assert.equal(fontMeta(FONTS[1]), "");
});

Deno.test("tabStep: arrows walk the category tabs and wrap, Home and End jump", () => {
  assert.equal(tabStep(0, 7, "ArrowRight"), 1);
  assert.equal(tabStep(6, 7, "ArrowRight"), 0);
  assert.equal(tabStep(0, 7, "ArrowLeft"), 6);
  assert.equal(tabStep(3, 7, "ArrowLeft"), 2);
  assert.equal(tabStep(4, 7, "Home"), 0);
  assert.equal(tabStep(1, 7, "End"), 6);
  assert.equal(tabStep(2, 7, "Enter"), null, "other keys are left alone");
  assert.equal(tabStep(0, 0, "ArrowRight"), null);
});
