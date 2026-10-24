// Tests for the pure helpers in web/js/ui/colorpicker.js
//   deno test --allow-read tests/inspector-color.test.js

import assert from "node:assert/strict";
import {
  parseHex,
  toHex,
  normalizeHex,
  rgbToHsv,
  hsvToRgb,
  hexToHsva,
  hsvaToHex,
  sameColor,
  pushRecent,
  docColors,
  cleanPalettes,
  popoverRoom,
  STAPLES,
  RECENT_MAX,
} from "../web/js/ui/colorpicker.js";
import { createDoc, createLayer } from "../web/js/core/model.js";

Deno.test("parseHex: 3, 4, 6 and 8 digits, with or without #", () => {
  assert.deepEqual(parseHex("#fff"), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseHex("0a0"), { r: 0, g: 170, b: 0, a: 1 });
  assert.deepEqual(parseHex("#FF2D2D"), { r: 255, g: 45, b: 45, a: 1 });
  assert.deepEqual(parseHex("  #d1ff4a  "), { r: 209, g: 255, b: 74, a: 1 });
  assert.equal(parseHex("#00000080").a, 0.502);
  assert.equal(parseHex("#0008").a, 0.533);
});

Deno.test("parseHex: rejects anything else", () => {
  for (const bad of ["", "#", "#12", "#12345", "#1234567", "#ggg", "red", "rgb(0,0,0)", null, 42]) assert.equal(parseHex(bad), null, String(bad));
});

Deno.test("toHex: lowercases, drops a full alpha, keeps a partial one", () => {
  assert.equal(toHex({ r: 255, g: 45, b: 45 }), "#ff2d2d");
  assert.equal(toHex({ r: 255, g: 45, b: 45, a: 1 }), "#ff2d2d");
  assert.equal(toHex({ r: 0, g: 0, b: 0, a: 0.5 }), "#00000080");
  assert.equal(toHex({ r: 0, g: 0, b: 0, a: 0.5 }, { alpha: false }), "#000000");
  assert.equal(toHex({ r: 300, g: -5, b: 12.6 }), "#ff000d");
});

Deno.test("normalizeHex: one canonical form", () => {
  assert.equal(normalizeHex("FFF"), "#ffffff");
  assert.equal(normalizeHex("#D1FF4AFF"), "#d1ff4a");
  assert.equal(normalizeHex("#d1ff4a80"), "#d1ff4a80");
  assert.equal(normalizeHex("#d1ff4a80", { alpha: false }), "#d1ff4a");
  assert.equal(normalizeHex("nope"), null);
});

Deno.test("rgbToHsv and hsvToRgb: primaries and grays", () => {
  assert.deepEqual(rgbToHsv(255, 0, 0), { h: 0, s: 1, v: 1 });
  assert.deepEqual(rgbToHsv(0, 255, 0), { h: 120, s: 1, v: 1 });
  assert.deepEqual(rgbToHsv(0, 0, 255), { h: 240, s: 1, v: 1 });
  assert.deepEqual(rgbToHsv(0, 0, 0), { h: 0, s: 0, v: 0 });
  const g = rgbToHsv(128, 128, 128);
  assert.equal(g.s, 0);
  assert.ok(Math.abs(g.v - 128 / 255) < 1e-9);
  assert.deepEqual(hsvToRgb(60, 1, 1), { r: 255, g: 255, b: 0 });
  assert.deepEqual(hsvToRgb(300, 1, 1), { r: 255, g: 0, b: 255 });
  assert.deepEqual(hsvToRgb(-60, 1, 1), { r: 255, g: 0, b: 255 });
  assert.deepEqual(hsvToRgb(720, 0, 0.5), { r: 128, g: 128, b: 128 });
});

Deno.test("hex -> hsv -> hex round trips every staple and a sweep", () => {
  for (const c of STAPLES) assert.equal(hsvaToHex(hexToHsva(c)), c);
  for (let r = 0; r < 256; r += 51) {
    for (let g = 0; g < 256; g += 51) {
      for (let b = 0; b < 256; b += 51) {
        const hex = toHex({ r, g, b });
        assert.equal(hsvaToHex(hexToHsva(hex)), hex);
      }
    }
  }
  assert.equal(hsvaToHex(hexToHsva("#12345680")), "#12345680");
  assert.equal(hexToHsva("nope"), null);
  assert.ok(hexToHsva("bad"), "b, a and d are hex digits");
});

Deno.test("sameColor ignores case and an opaque alpha byte", () => {
  assert.ok(sameColor("#FFF", "#ffffffff"));
  assert.ok(!sameColor("#fff", "#fffffe"));
  assert.ok(!sameColor("", "#fff"));
});

Deno.test("pushRecent: newest first, unique, capped", () => {
  assert.deepEqual(pushRecent([], "#FFF"), ["#ffffff"]);
  assert.deepEqual(pushRecent(["#000000", "#ffffff"], "#fff"), ["#ffffff", "#000000"]);
  const many = Array.from({ length: 12 }, (_, i) => toHex({ r: i, g: 0, b: 0 }));
  const out = pushRecent(many, "#abcdef");
  assert.equal(out.length, RECENT_MAX);
  assert.equal(out[0], "#abcdef");
  assert.deepEqual(pushRecent(null, "nope"), []);
  assert.deepEqual(pushRecent(["junk", "#000"], null), ["#000000"]);
});

Deno.test("docColors: what the design uses, most used first", () => {
  const doc = createDoc({ background: { kind: "color", color: "#111111" } });
  doc.layers.push(
    createLayer("text", { color: "#FFE14D", stroke: { on: true, color: "#000000", width: 8 } }),
    createLayer("text", { color: "#ffe14d", stroke: { on: false, color: "#ff0000" } }),
    createLayer("shape", { fill: { on: true, color: "#d1ff4a" } }),
    createLayer("arrow", { color: "#ff2d2d" }),
    createLayer("image", { outline: { on: false, color: "#00ff00" } })
  );
  const out = docColors(doc);
  assert.equal(out[0], "#ffe14d");
  assert.ok(out.includes("#111111"));
  assert.ok(out.includes("#000000"));
  assert.ok(out.includes("#d1ff4a"));
  assert.ok(out.includes("#ff2d2d"));
  assert.ok(!out.includes("#ff0000"), "stroke that is off is not used");
  assert.ok(!out.includes("#00ff00"), "outline that is off is not used");
  assert.equal(docColors(doc, 2).length, 2);
  assert.deepEqual(docColors(null), []);
});

Deno.test("cleanPalettes: keeps valid colors, drops empty palettes", () => {
  const out = cleanPalettes([{ name: "Brand", colors: ["#FFF", "nope", "#fff", "#00000080"] }, { name: "Empty", colors: [] }, null, { colors: ["#123"] }]);
  assert.deepEqual(out, [
    { name: "Brand", colors: ["#ffffff", "#00000080"] },
    { name: "Palette", colors: ["#112233"] },
  ]);
  assert.deepEqual(cleanPalettes([{ name: "A", colors: ["#00000080"] }], { alpha: false }), [{ name: "A", colors: ["#000000"] }]);
  assert.deepEqual(cleanPalettes("x"), []);
});

Deno.test("popoverRoom: beside the anchor it may use the whole window", () => {
  const a = { top: 300, bottom: 340 };
  assert.equal(popoverRoom(a, 700, "left"), 684);
  assert.equal(popoverRoom(a, 700, "right-start"), 684);
  assert.equal(popoverRoom(null, 700, "top"), 684);
});

Deno.test("popoverRoom: keeps the asked-for side while it has enough room", () => {
  // A quick bar at y 330-362 on a 700 px window: 314 above, 322 below.
  const bar = { top: 330, bottom: 362 };
  assert.equal(popoverRoom(bar, 700, "top", { min: 300 }), 314, "above, so the picker never covers the text under the bar");
  assert.equal(popoverRoom(bar, 700, "bottom", { min: 300 }), 322);
  // Too little above: the roomier side wins.
  const high = { top: 90, bottom: 122 };
  assert.equal(popoverRoom(high, 700, "top", { min: 320 }), 562);
  assert.equal(popoverRoom(high, 700, "top-start", { min: 320 }), 562);
});

Deno.test("popoverRoom: never more than the window, never negative", () => {
  assert.equal(popoverRoom({ top: -50, bottom: 2000 }, 700, "bottom"), 0);
  assert.equal(popoverRoom({ top: 900, bottom: 940 }, 700, "top", { min: 100 }), 684);
  assert.equal(popoverRoom({ top: 300, bottom: 340 }, 0, "top"), 0);
});
