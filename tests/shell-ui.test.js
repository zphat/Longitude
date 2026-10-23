// Tests for pure helpers in web/js/ui/menus.js, home.js, keyboard.js and icons.js
//   deno test --allow-read tests/shell-ui.test.js

import assert from "node:assert/strict";
import { placeFloating, splitKeys } from "../web/js/ui/menus.js";
import { relativeTime, fitBox } from "../web/js/ui/home.js";
import { allowedOnHome, shortcutGroups, swallowCombo, boundCommand } from "../web/js/ui/keyboard.js";
import { rovingIndex, shapeCommandId } from "../web/js/ui/shell.js";
import { iconNames, iconBody, hasIcon } from "../web/js/ui/icons.js";
import { normalizeEvent } from "../web/js/app/context.js";
import { fieldOwnsCombo, isTextEntry } from "../web/js/ui/dom.js";

const vp = { w: 1000, h: 800 };

Deno.test("placeFloating: below the anchor, centred", () => {
  const p = placeFloating({ x: 400, y: 100, w: 100, h: 30 }, { w: 200, h: 100 }, vp, { placement: "bottom", gap: 8 });
  assert.deepEqual([p.x, p.y, p.side], [350, 138, "bottom"]);
});

Deno.test("placeFloating: flips to the top when there is no room below", () => {
  const p = placeFloating({ x: 400, y: 740, w: 100, h: 30 }, { w: 200, h: 100 }, vp, { placement: "bottom-start", gap: 8 });
  assert.equal(p.side, "top");
  assert.equal(p.y, 740 - 8 - 100);
  assert.equal(p.x, 400);
  assert.equal(p.placement, "top-start");
});

Deno.test("placeFloating: clamps to the viewport on the cross axis", () => {
  const p = placeFloating({ x: 960, y: 100, w: 30, h: 30 }, { w: 300, h: 100 }, vp, { placement: "bottom-start", gap: 8, margin: 8 });
  assert.equal(p.x, 1000 - 8 - 300);
  const q = placeFloating({ x: 0, y: 100, w: 10, h: 10 }, { w: 300, h: 100 }, vp, { placement: "bottom-end" });
  assert.equal(q.x, 8);
});

Deno.test("placeFloating: right side flips left near the edge (context menus)", () => {
  const p = placeFloating({ x: 900, y: 300, w: 0, h: 0 }, { w: 220, h: 200 }, vp, { placement: "right-start", gap: 2 });
  assert.equal(p.side, "left");
  assert.equal(p.x, 900 - 2 - 220);
  assert.equal(p.y, 300);
  const low = placeFloating({ x: 100, y: 780, w: 0, h: 0 }, { w: 220, h: 200 }, vp, { placement: "right-start", gap: 2 });
  assert.equal(low.y, 800 - 8 - 200);
});

Deno.test("splitKeys: splits on plus but keeps a plus key", () => {
  assert.deepEqual(splitKeys("Ctrl+Shift+Z"), ["Ctrl", "Shift", "Z"]);
  assert.deepEqual(splitKeys("Ctrl++"), ["Ctrl", "+"]);
  assert.deepEqual(splitKeys("+"), ["+"]);
  assert.deepEqual(splitKeys(""), []);
});

Deno.test("relativeTime: plain words", () => {
  const now = Date.UTC(2026, 9, 23, 12, 0, 0);
  assert.equal(relativeTime(now - 10_000, now), "Just now");
  assert.equal(relativeTime(now - 5 * 60_000, now), "5 min ago");
  assert.equal(relativeTime(now - 60 * 60_000, now), "1 hour ago");
  assert.equal(relativeTime(now - 5 * 3600_000, now), "5 hours ago");
  assert.equal(relativeTime(now - 26 * 3600_000, now), "Yesterday");
  assert.equal(relativeTime(now - 3 * 86400_000, now), "3 days ago");
  assert.ok(relativeTime(now - 40 * 86400_000, now).length > 0);
  assert.equal(relativeTime(0, now), "");
});

Deno.test("fitBox: keeps the aspect inside the box", () => {
  assert.deepEqual(fitBox(1280, 720, 104, 58), { w: 103.1, h: 58 });
  assert.deepEqual(fitBox(1080, 1920, 104, 58), { w: 32.6, h: 58 });
  assert.deepEqual(fitBox(3000, 3000, 104, 58), { w: 58, h: 58 });
});

Deno.test("allowedOnHome: only start-up commands run over Home", () => {
  assert.ok(allowedOnHome({ id: "file.new" }));
  assert.ok(allowedOnHome({ id: "view.palette" }));
  assert.ok(allowedOnHome({ id: "tools.compress" }));
  assert.ok(allowedOnHome({ id: "mod.thing", home: true }));
  assert.ok(!allowedOnHome({ id: "edit.delete" }));
  assert.ok(!allowedOnHome({ id: "tool.text" }));
});

Deno.test("shortcutGroups: groups in palette order, hidden commands only with keys", () => {
  const groups = shortcutGroups([
    { id: "view.fit", title: "Zoom to fit", group: "View", keys: ["Mod+0"] },
    { id: "edit.undo", title: "Undo", group: "Edit", keys: ["Mod+Z"] },
    { id: "x.hidden", title: "Hidden", group: "Edit", hidden: true },
    { id: "file.new", title: "New design", group: "File" },
  ]);
  assert.deepEqual(groups.map((g) => g.group), ["File", "Edit", "View"]);
  assert.equal(groups[1].list.length, 1);
});

Deno.test("icons: every body is well-formed SVG shapes and the UI set exists", () => {
  const shape = /^(?:<(?:path|circle|rect|line|polyline|polygon|ellipse)(?:\s+[a-z-]+="[^"<>]*")+\s*\/>)+$/;
  for (const name of iconNames()) assert.match(iconBody(name), shape, `icon "${name}"`);
  const needed = [
    "pointer", "hand", "type", "image", "square", "circle", "highlight-circle", "arrow-up-right", "arrow-curve", "pen", "eraser", "wand",
    "crop", "scissors", "layers", "eye", "eye-off", "lock", "unlock", "trash", "copy", "clipboard", "undo", "redo", "zoom-in", "zoom-out",
    "maximize", "grid", "magnet", "safe-zone", "sun", "moon", "settings", "help-circle", "search", "download", "upload", "share", "play",
    "monitor", "smartphone", "file", "folder-open", "save", "image-down", "align-left", "align-center-h", "align-right", "align-top",
    "align-center-v", "align-bottom", "distribute-h", "distribute-v", "flip-h", "flip-v", "rotate", "bring-forward", "send-backward",
    "bring-front", "send-back", "text-align-left", "text-align-center", "text-align-right", "bold", "italic", "case-upper",
    "letter-spacing", "line-height", "droplet", "stroke", "shadow", "glow", "frame", "sliders", "palette", "font", "more-horizontal",
    "external-link", "info", "alert-triangle", "puzzle", "keyboard", "music", "play-rect", "star", "burst", "message-square",
    "message-circle", "triangle", "dot", "x", "check", "chevron-down", "chevron-right", "plus", "minus", "reset", "remove-bg",
  ];
  for (const n of needed) assert.ok(hasIcon(n), `missing icon "${n}"`);
});

Deno.test("swallowCombo: browser shortcuts a disabled command must not leak to", () => {
  for (const c of ["Mod+S", "Mod+Shift+S", "Mod+D", "Mod+E", "Mod+Shift+C", "Mod+O", "Alt+X"]) assert.ok(swallowCombo(c), c);
  // Clipboard and undo in page text, page zoom and tab switching stay with the browser.
  for (const c of ["Mod+C", "Mod+X", "Mod+V", "Mod+A", "Mod+Z", "Mod+Y", "Mod+Shift+Z", "Mod+0", "Mod+=", "Mod+-", "Mod+1"]) assert.ok(!swallowCombo(c), c);
  // Plain keys keep scrolling and moving focus.
  for (const c of ["S", "ArrowDown", "Delete", "Shift+H", "F2"]) assert.ok(!swallowCombo(c), c);
});

Deno.test("boundCommand: finds the binding whether or not it can run, with the typing rules", () => {
  const cmds = [
    { id: "file.save", keys: ["Mod+S"], allowInFields: true, when: () => false },
    { id: "layer.duplicate", keys: ["Mod+D"] },
    { id: "tool.rect", keys: ["R"] },
  ];
  const ev = (key, code, init = {}, tagName = "BODY") => ({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init, target: { tagName } });
  assert.equal(boundCommand(cmds, ev("s", "KeyS", { ctrlKey: true }))?.id, "file.save");
  assert.equal(boundCommand(cmds, ev("d", "KeyD", { ctrlKey: true }))?.id, "layer.duplicate");
  assert.equal(boundCommand(cmds, ev("r", "KeyR"))?.id, "tool.rect");
  assert.equal(boundCommand(cmds, ev("q", "KeyQ", { ctrlKey: true })), null);
  // In a text field only allowInFields modifier combos count.
  assert.equal(boundCommand(cmds, ev("s", "KeyS", { ctrlKey: true }, "INPUT"))?.id, "file.save");
  assert.equal(boundCommand(cmds, ev("d", "KeyD", { ctrlKey: true }, "INPUT")), null);
  assert.equal(boundCommand(cmds, ev("r", "KeyR", {}, "INPUT")), null);
});

Deno.test("normalizeEvent: letters and punctuation as printed, digits by position", () => {
  const ev = (key, code, init = {}) => ({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init });
  // QWERTZ: the key labelled Z has code KeyY.
  assert.equal(normalizeEvent(ev("z", "KeyY", { ctrlKey: true })), "Mod+Z");
  assert.equal(normalizeEvent(ev("y", "KeyZ", { ctrlKey: true })), "Mod+Y");
  assert.equal(normalizeEvent(ev("Z", "KeyY", { ctrlKey: true, shiftKey: true })), "Mod+Shift+Z");
  // AZERTY: A is KeyQ.
  assert.equal(normalizeEvent(ev("a", "KeyQ", { ctrlKey: true })), "Mod+A");
  // Cyrillic: no Latin letter, so the physical key.
  assert.equal(normalizeEvent(ev("я", "KeyZ", { ctrlKey: true })), "Mod+Z");
  // QWERTZ "-" sits where US has "/": zoom out, not the palette.
  assert.equal(normalizeEvent(ev("-", "Slash")), "-");
  assert.equal(normalizeEvent(ev("+", "BracketRight", { ctrlKey: true })), "Mod+=");
  // US: "/" opens the palette, Shift+/ ("?") the shortcuts sheet.
  assert.equal(normalizeEvent(ev("/", "Slash")), "/");
  assert.equal(normalizeEvent(ev("?", "Slash", { shiftKey: true })), "Shift+/");
  // QWERTZ "/" is Shift+7, which stays Shift+7.
  assert.equal(normalizeEvent(ev("/", "Digit7", { shiftKey: true })), "Shift+7");
  // Digits by position: Shift+1 is still 1.
  assert.equal(normalizeEvent(ev("!", "Digit1", { shiftKey: true })), "Shift+1");
  assert.equal(normalizeEvent(ev("à", "Digit0", { ctrlKey: true })), "Mod+0");
  // Brackets fall back to the physical key when the printed one is something else.
  assert.equal(normalizeEvent(ev("{", "BracketLeft", { ctrlKey: true, shiftKey: true })), "Mod+Shift+[");
  assert.equal(normalizeEvent(ev("ü", "BracketLeft", { ctrlKey: true })), "Mod+[");
});

Deno.test("fieldOwnsCombo: sliders and checkboxes keep plain keys, text fields keep combos too", () => {
  const el = (tagName, type) => ({ tagName, getAttribute: (k) => (k === "type" ? type ?? null : null) });
  const range = el("INPUT", "range");
  const text = el("INPUT", "text");
  const bare = el("INPUT");
  assert.equal(isTextEntry(range), false);
  assert.equal(isTextEntry(el("INPUT", "checkbox")), false);
  assert.equal(isTextEntry(el("SELECT")), false);
  assert.equal(isTextEntry(text), true);
  assert.equal(isTextEntry(bare), true);
  assert.equal(isTextEntry(el("TEXTAREA")), true);
  assert.equal(isTextEntry({ tagName: "DIV", isContentEditable: true }), true);
  // A focused slider keeps its arrows, but Ctrl+Z and F2 go to the app.
  assert.equal(fieldOwnsCombo("ArrowLeft", range), true);
  assert.equal(fieldOwnsCombo("Mod+Z", range), false);
  assert.equal(fieldOwnsCombo("F2", range), false);
  assert.equal(fieldOwnsCombo("Mod+Z", text), true);
  assert.equal(fieldOwnsCombo("R", text), true);
  assert.equal(fieldOwnsCombo("R", { tagName: "BODY" }), false);
  // boundCommand follows the same rule.
  const cmds = [{ id: "edit.undo", keys: ["Mod+Z"] }];
  const key = (target) => ({ key: "z", code: "KeyZ", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, target });
  assert.equal(boundCommand(cmds, key(range))?.id, "edit.undo");
  assert.equal(boundCommand(cmds, key(text)), null);
});

Deno.test("rovingIndex: arrows in a list and a wrapping grid", () => {
  assert.equal(rovingIndex("ArrowDown", 0, 5), 1);
  assert.equal(rovingIndex("ArrowUp", 0, 5), -1);
  assert.equal(rovingIndex("ArrowDown", 4, 5), -1);
  assert.equal(rovingIndex("ArrowRight", 2, 5), -1);
  assert.equal(rovingIndex("End", 1, 5), 4);
  assert.equal(rovingIndex("Home", 3, 5), 0);
  assert.equal(rovingIndex("ArrowDown", 1, 10, 3), 4);
  assert.equal(rovingIndex("ArrowUp", 4, 10, 3), 1);
  assert.equal(rovingIndex("ArrowRight", 2, 10, 3), 3);
  assert.equal(rovingIndex("ArrowDown", 8, 10, 3), -1);
  assert.equal(rovingIndex("ArrowDown", -1, 10, 3), -1);
  assert.equal(rovingIndex("x", 1, 10, 3), -1);
});

Deno.test("shapeCommandId: a valid command id per shape, or none", () => {
  assert.equal(shapeCommandId("star"), "insert.shape.star");
  assert.equal(shapeCommandId("callout-arrow"), "insert.shape.callout-arrow");
  assert.equal(shapeCommandId("MyShape"), "insert.shape.myshape");
  assert.equal(shapeCommandId("bad id!"), null);
  assert.equal(shapeCommandId(""), null);
  assert.equal(shapeCommandId("x".repeat(80)), null);
});
