// Tests for web/js/core/textlayout.js. Deno has no 2D canvas, so these run on
// the approximate measurer; the browser uses real glyph metrics.
//   deno test --allow-read tests/core-textlayout.test.js

import assert from "node:assert/strict";
import { bumpTextEpoch, fontString, layoutText, measureBox, textPad, useFonts, wrapParagraph } from "../web/js/core/textlayout.js";
import { createLayer } from "../web/js/core/model.js";

const near = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, msg || `${a} != ${b}`);
const text = (props) => createLayer("text", { stroke: { on: false }, ...props });

Deno.test("fontString: weight, italic, size and a fallback stack", () => {
  assert.equal(fontString(text({ font: "Anton", weight: 400 })), '400 140px "Anton", Impact, "Arial Narrow Bold", sans-serif');
  assert.equal(fontString(text({ font: "My Font", weight: 700, italic: true }), 50.123), 'italic 700 50.12px "My Font", sans-serif');
});

Deno.test("fontString: uses the registry's stack when one is set", () => {
  useFonts({ stack: (f) => `"${f}", "Fallback", serif` });
  try {
    assert.equal(fontString(text({ font: "Grotto" }), 10), '400 10px "Grotto", "Fallback", serif');
  } finally {
    useFonts(null);
  }
  assert.equal(fontString(text({ font: "Grotto" }), 10), '400 10px "Grotto", sans-serif');
});

Deno.test("wrapParagraph: greedy on spaces, hard-breaks long words", () => {
  const m = (s) => s.length;
  assert.deepEqual(wrapParagraph("aaa bbb ccc", 7, m), ["aaa bbb", "ccc"]);
  assert.deepEqual(wrapParagraph("aaaaaaaaaa", 4, m), ["aaaa", "aaaa", "aa"]);
  assert.deepEqual(wrapParagraph("hi aaaaaaaaa x", 4, m), ["hi", "aaaa", "aaaa", "a x"]);
  assert.deepEqual(wrapParagraph("short", 40, m), ["short"]);
  assert.deepEqual(wrapParagraph("", 4, m), [""]);
});

Deno.test("textPad: room for stroke, second outline and the pill", () => {
  assert.deepEqual(textPad(text({ stroke: { on: true, width: 10 } })), { x: 10, y: 10 });
  assert.deepEqual(textPad(text({ stroke: { on: true, width: 10 }, stroke2: { on: true, width: 6 } })), { x: 16, y: 16 });
  assert.deepEqual(textPad(text({ stroke: { on: false, width: 10 }, stroke2: { on: true, width: 6 } })), { x: 6, y: 6 });
  assert.deepEqual(textPad(text({ stroke: { on: true, width: 4 }, bg: { on: true, padX: 28, padY: 14 } })), { x: 28, y: 14 });
});

Deno.test("layoutText: lines, baselines and the box", () => {
  const l = text({ text: "One\nTwo lines", size: 100, lineHeight: 1.2, stroke: { on: true, width: 10 } });
  const L = layoutText(l);
  assert.equal(L.lines.length, 2);
  assert.equal(L.lines[0].text, "One");
  near(L.lines[1].y - L.lines[0].y, 120);
  near(L.pad.x, 10);
  near(L.width, L.contentWidth + 20);
  near(L.height, L.ascent + L.descent + 120 + 20);
  near(L.lines[0].y, -L.height / 2 + 10 + L.ascent, 1e-9, "first baseline sits one ascent below the padded top");
  assert.deepEqual(measureBox(l), { w: L.width, h: L.height });
  for (const line of L.lines) near(line.x, -line.width / 2, 1e-9, "centered lines");
});

Deno.test("layoutText: alignment puts each line's left edge in place", () => {
  const base = { text: "A\nlonger line", size: 50 };
  const left = layoutText(text({ ...base, align: "left" }));
  for (const line of left.lines) near(line.x, -left.width / 2 + left.pad.x);
  const right = layoutText(text({ ...base, align: "right" }));
  for (const line of right.lines) near(line.x + line.width, right.width / 2 - right.pad.x);
});

Deno.test("layoutText: uppercase, letter spacing and the empty string", () => {
  const up = layoutText(text({ text: "wait what", uppercase: true }));
  assert.equal(up.lines[0].text, "WAIT WHAT");
  const tight = layoutText(text({ text: "ABCD", letterSpacing: 0 }));
  const wide = layoutText(text({ text: "ABCD", letterSpacing: 100 }));
  near(wide.lines[0].width - tight.lines[0].width, 3 * 0.1 * 140, 1e-6, "spacing between glyphs, not after the last");
  const empty = layoutText(text({ text: "" }));
  assert.ok(empty.width > 0 && empty.height > 0, "an empty text layer still has a box");
});

Deno.test("layoutText: fixed wrap keeps the width and wraps the text", () => {
  const l = text({ text: "this is a long title that needs to wrap", size: 40, wrap: "fixed", w: 300 });
  const L = layoutText(l);
  assert.equal(L.width, 300);
  assert.ok(L.lines.length > 1);
  for (const line of L.lines) assert.ok(line.width <= 300 - L.pad.x * 2 + 1e-6, `"${line.text}" fits`);
  const auto = layoutText({ ...l, wrap: "auto" });
  assert.equal(auto.lines.length, 1);
});

Deno.test("layoutText: cached per props, dropped when fonts change", () => {
  const l = text({ text: "Cache me" });
  const a = layoutText(l);
  assert.equal(layoutText({ ...l, x: 999, rotation: 45 }), a, "position does not affect layout");
  assert.notEqual(layoutText({ ...l, size: 141 }), a);
  bumpTextEpoch();
  assert.notEqual(layoutText(l), a);
});
