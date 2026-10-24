// Tests for web/js/editor/textedit.js (inline text editing sessions), with a
// tiny stand-in for the DOM so the store side can be checked under Deno.
//   deno test --allow-read tests/draw-textedit.test.js

import assert from "node:assert/strict";

// ---- a minimal DOM: just what the text editor touches ----------------------------

class FakeNode extends EventTarget {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.style = {};
    this.attrs = {};
    this.children = [];
    this.parentNode = null;
    this.value = "";
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.clientLeft = 0;
    this.clientTop = 0;
  }
  // Bubbling, so tests can see what reaches the stage.
  dispatchEvent(e) {
    if (!e.stopped) {
      const stop = e.stopPropagation.bind(e);
      e.stopped = { value: false };
      e.stopPropagation = () => {
        e.stopped.value = true;
        stop();
      };
    }
    const out = super.dispatchEvent(e);
    if (e.bubbles && !e.stopped.value && this.parentNode) this.parentNode.dispatchEvent(e);
    return out;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  append(...nodes) {
    for (const n of nodes) {
      n.parentNode = this;
      this.children.push(n);
    }
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === fakeDocument.body;
  }
  get offsetParent() {
    return this.parentNode;
  }
  focus() {
    fakeDocument.activeElement = this;
  }
  setSelectionRange(a, b) {
    this.selectionStart = a;
    this.selectionEnd = b;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
}

const fakeDocument = Object.assign(new EventTarget(), {
  body: new FakeNode("body"),
  activeElement: null,
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (t) => Object.assign(new FakeNode("#text"), { textContent: t }),
});
globalThis.document = fakeDocument;
globalThis.SVGElement ??= class {};
globalThis.Node ??= FakeNode;

const { createTextEditor, textEditorFor } = await import("../web/js/editor/textedit.js");
const { Store } = await import("../web/js/core/store.js");
const { createLayer } = await import("../web/js/core/model.js");
const { installTextNormalizer, layoutText } = await import("../web/js/core/textlayout.js");

function setup(layers = []) {
  const store = new Store();
  const off = installTextNormalizer(store);
  if (layers.length) store.add(layers, { select: false });
  store.clearHistory();
  const events = new EventTarget();
  const emitted = [];
  const ctx = {
    store,
    events,
    ui: { toast() {} },
    emit(type, detail) {
      emitted.push([type, detail]);
      events.dispatchEvent(new CustomEvent(type, { detail }));
    },
    on(type, fn) {
      const l = (e) => fn(e.detail);
      events.addEventListener(type, l);
      return () => events.removeEventListener(type, l);
    },
  };
  const host = new FakeNode("div");
  fakeDocument.body.append(host);
  const view = { panX: 10, panY: 20 };
  const editor = { host, zoom: 2, view, docToScreen: (p) => ({ x: p.x * 2 + view.panX, y: p.y * 2 + view.panY }), requestRender() {} };
  const te = createTextEditor(ctx, editor);
  const textarea = () => host.children.find((c) => c.tagName === "TEXTAREA") || null;
  const type = (value) => {
    const ta = textarea();
    ta.value = value;
    ta.dispatchEvent(new Event("input"));
  };
  const key = (k, extra = {}) => {
    const e = Object.assign(new Event("keydown", { cancelable: true, bubbles: true }), { key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 0, ...extra });
    textarea().dispatchEvent(e);
    return e;
  };
  return {
    store,
    ctx,
    te,
    host,
    view,
    emitted,
    textarea,
    type,
    key,
    done() {
      te.stop(false);
      host.remove();
      off();
    },
  };
}

Deno.test("create adds text, edits it and makes one 'Add text' step", () => {
  const t = setup();
  const id = t.te.create({ text: "Your text", x: 300, y: 200 });
  assert.ok(id);
  assert.equal(textEditorFor(t.ctx), t.te);
  assert.equal(t.te.active, id);
  assert.equal(t.store.inGesture, true);
  const ta = t.textarea();
  assert.equal(ta.value, "Your text");
  assert.deepEqual([ta.selectionStart, ta.selectionEnd], [0, 9], "everything selected");
  assert.equal(fakeDocument.activeElement, ta);
  t.type("Hello\nworld");
  assert.equal(t.store.get(id).text, "Hello\nworld", "live on the canvas");
  assert.equal(t.te.stop(), true);
  assert.equal(t.te.active, null);
  assert.equal(t.textarea(), null);
  assert.equal(t.store.inGesture, false);
  assert.equal(t.store.historyLabels().undo, "Add text");
  t.store.undo();
  assert.equal(t.store.layers().length, 0);
  assert.deepEqual(t.emitted.filter(([k]) => k === "textedit").map(([, d]) => d.id), [id, null]);
  t.done();
});

Deno.test("leaving new text empty removes it without an undo step", () => {
  const t = setup();
  t.te.create({ text: "Your text" });
  t.type("   ");
  t.te.stop();
  assert.equal(t.store.layers().length, 0);
  assert.equal(t.store.canUndo, false);
  t.done();
});

Deno.test("editing existing text is one 'Edit text' step; empty restores it", () => {
  const layer = createLayer("text", { text: "Old" });
  const t = setup([layer]);
  assert.equal(t.te.start(layer.id, { caret: "end" }), true);
  assert.deepEqual([t.textarea().selectionStart, t.textarea().selectionEnd], [3, 3]);
  t.type("New words");
  t.te.stop();
  assert.equal(t.store.get(layer.id).text, "New words");
  assert.equal(t.store.historyLabels().undo, "Edit text");
  t.store.undo();
  assert.equal(t.store.get(layer.id).text, "Old");
  t.store.clearHistory();
  t.te.start(layer.id);
  t.type("");
  t.te.stop();
  assert.equal(t.store.get(layer.id).text, "Old", "empty restores the old text");
  assert.equal(t.store.canUndo, false);
  t.done();
});

Deno.test("Escape and Ctrl+Enter commit, plain Enter does not", () => {
  const layer = createLayer("text", { text: "One" });
  const t = setup([layer]);
  t.te.start(layer.id);
  const enter = t.key("Enter");
  assert.equal(enter.defaultPrevented, false, "Enter types a new line");
  assert.equal(t.te.active, layer.id);
  t.type("Two");
  const esc = t.key("Escape");
  assert.equal(esc.defaultPrevented, true);
  assert.equal(t.te.active, null);
  assert.equal(t.store.get(layer.id).text, "Two");
  t.te.start(layer.id);
  t.type("Three");
  t.key("Enter", { ctrlKey: true, metaKey: true });
  assert.equal(t.te.active, null);
  assert.equal(t.store.get(layer.id).text, "Three");
  t.done();
});

Deno.test("keys typed into the box do not reach app shortcuts", () => {
  const layer = createLayer("text", { text: "Keys" });
  const t = setup([layer]);
  let reached = 0;
  t.host.addEventListener("keydown", () => reached++);
  t.te.start(layer.id);
  t.key("v");
  t.key("Delete");
  t.key("z", { ctrlKey: true, metaKey: true });
  assert.equal(reached, 0);
  t.key("k", { ctrlKey: true, metaKey: true });
  assert.equal(reached, 1, "the command palette shortcut still works");
  t.done();
});

Deno.test("Ctrl+B and Ctrl+I change the weight and italic as part of the edit", () => {
  const layer = createLayer("text", { text: "Bold", weight: 400 });
  const t = setup([layer]);
  t.te.start(layer.id);
  t.key("b", { ctrlKey: true, metaKey: true });
  t.key("i", { ctrlKey: true, metaKey: true });
  assert.equal(t.store.get(layer.id).weight, 700);
  assert.equal(t.store.get(layer.id).italic, true);
  t.te.stop();
  t.store.undo();
  assert.equal(t.store.get(layer.id).weight, 400, "one step with the typing");
  t.done();
});

Deno.test("a press outside the box commits", () => {
  const layer = createLayer("text", { text: "Out" });
  const t = setup([layer]);
  t.te.start(layer.id);
  t.type("Outside");
  fakeDocument.dispatchEvent(new Event("pointerdown"));
  assert.equal(t.te.active, null);
  assert.equal(t.store.historyLabels().undo, "Edit text");
  t.done();
});

Deno.test("undo during an edit ends the session cleanly", () => {
  const layer = createLayer("text", { text: "A" });
  const t = setup([layer]);
  t.te.start(layer.id);
  t.type("AB");
  t.store.undo();
  assert.equal(t.te.active, null);
  assert.equal(t.textarea(), null);
  assert.equal(t.store.get(layer.id).text, "A");
  t.done();
});

Deno.test("locked and hidden text cannot be edited; deleting it ends the edit", () => {
  const locked = createLayer("text", { text: "L", locked: true });
  const hidden = createLayer("text", { text: "H", hidden: true });
  const plain = createLayer("text", { text: "P" });
  const t = setup([locked, hidden, plain]);
  assert.equal(t.te.start(locked.id), false);
  assert.equal(t.te.start(hidden.id), false);
  assert.equal(t.store.inGesture, false);
  t.te.start(plain.id);
  t.store.remove([plain.id]);
  assert.equal(t.te.active, null);
  assert.equal(t.store.inGesture, false);
  t.done();
});

Deno.test("the box follows the layer: font size and transform scale with zoom", () => {
  const layer = createLayer("text", { text: "Zoom", size: 100, x: 400, y: 300, letterSpacing: 100 });
  const t = setup([layer]);
  t.te.start(layer.id);
  const st = t.textarea().style;
  assert.equal(st.fontSize, "200px");
  assert.equal(st.letterSpacing, "20px");
  assert.equal(st.whiteSpace, "pre");
  assert.equal(st.textAlign, "center");
  assert.match(st.transform, /^matrix\(1, 0, 0, 1, /);
  const L = layoutText(t.store.get(layer.id));
  assert.equal(st.lineHeight, `${Math.round(L.lineHeightPx * 2 * 1000) / 1000}px`);
  t.done();
});

Deno.test("a doc point places the caret between the nearest letters", () => {
  const layer = createLayer("text", { text: "ab\ncd", x: 0, y: 0, size: 100, align: "left", stroke: { on: false } });
  const t = setup([layer]);
  const L = layoutText(t.store.get(layer.id));
  const l2 = L.lines[1];
  // Just right of the start of the second line's second letter.
  t.te.start(layer.id, { caret: { x: l2.x + l2.width * 0.6, y: l2.y - 10 } });
  assert.equal(t.textarea().selectionStart, 4);
  t.done();
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const dropEvent = (types) => Object.assign(new Event("drop", { cancelable: true }), { dataTransfer: { types, files: [] } });

Deno.test("a file dropped while typing ends the edit first, so the import is its own step", () => {
  const t = setup();
  const id = t.te.create({ text: "Your text" });
  t.type("IS THIS A SCAM");
  globalThis.dispatchEvent(dropEvent(["text/plain"]));
  assert.equal(t.te.active, id, "dragging words inside the box is still typing");
  globalThis.dispatchEvent(dropEvent(["Files"]));
  assert.equal(t.te.active, null);
  assert.equal(t.store.inGesture, false);
  // What the importer then does with the files.
  t.store.add([createLayer("image", { asset: "ast_face" })], { label: "Add image" });
  assert.equal(t.store.historyLabels().undo, "Add image");
  t.store.undo();
  assert.equal(t.store.layers().length, 1, "undo takes the photo, not the title");
  assert.equal(t.store.layers()[0].text, "IS THIS A SCAM");
  t.done();
});

Deno.test("a drop onto emptied text does not take the dropped file with it", () => {
  const layer = createLayer("text", { text: "Old title" });
  const t = setup([layer]);
  t.te.start(layer.id);
  t.type("");
  globalThis.dispatchEvent(dropEvent(["Files"]));
  assert.equal(t.store.get(layer.id).text, "Old title", "the emptied edit is canceled");
  const [img] = t.store.add([createLayer("image", { asset: "ast_face" })], { label: "Add image" });
  fakeDocument.dispatchEvent(new Event("pointerdown"));
  assert.ok(t.store.get(img), "the photo stays");
  assert.equal(t.store.layers().length, 2);
  t.done();
});

Deno.test("focus moving to another element (the palette) ends the edit", async () => {
  const layer = createLayer("text", { text: "Focus" });
  const t = setup([layer]);
  const other = new FakeNode("input");
  t.te.start(layer.id);
  // Right after starting, a stray blur takes focus back instead.
  other.focus();
  t.textarea().dispatchEvent(new Event("blur"));
  await wait(5);
  assert.equal(t.te.active, layer.id);
  assert.equal(fakeDocument.activeElement, t.textarea());
  await wait(420);
  // The window losing focus leaves the box the active element: keep editing.
  t.textarea().dispatchEvent(new Event("blur"));
  await wait(5);
  assert.equal(t.te.active, layer.id);
  t.type("Palette");
  other.focus();
  t.textarea().dispatchEvent(new Event("blur"));
  await wait(5);
  assert.equal(t.te.active, null);
  assert.equal(t.store.historyLabels().undo, "Edit text");
  assert.equal(t.store.inGesture, false, "whatever the palette runs is its own step");
  t.done();
});

Deno.test("fixed-width text with letter spacing wraps in the box where the canvas wraps", () => {
  for (const [align, spacing] of [["center", 100], ["left", 100], ["right", 100], ["center", -60]]) {
    const layer = createLayer("text", { text: "Is this a scam or not", size: 100, x: 400, y: 300, wrap: "fixed", w: 500, align, letterSpacing: spacing });
    const t = setup([layer]);
    t.te.start(layer.id);
    const L = layoutText(t.store.get(layer.id));
    const st = t.textarea().style;
    const contentW = L.width - 2 * L.pad.x;
    const cut = (v) => Math.round(v * 1000) / 1000;
    assert.equal(st.width, `${cut((contentW + L.spacing) * 2 + 0.5)}px`, `${align} ${spacing}: one spacing wider (or narrower)`);
    const [, , , , e] = st.transform.match(/matrix\((.*)\)/)[1].split(", ").map(Number);
    const left = -L.width / 2 + L.pad.x;
    assert.ok(Math.abs(e - (2 * (400 + left) + 10)) < 0.01, `${align}: box starts at the content's left edge (${e})`);
    t.done();
  }
});

Deno.test("the box follows the view without polling every frame", async () => {
  const layer = createLayer("text", { text: "Follow", x: 300, y: 200 });
  const t = setup([layer]);
  t.te.start(layer.id);
  const ta = t.textarea();
  const before = ta.style.transform;
  assert.match(before, /^matrix\(/);
  // The view pans: the "view" event moves the box at once.
  t.view.panX += 40;
  t.ctx.emit("view", { zoom: 2, panX: t.view.panX, panY: t.view.panY });
  const after = ta.style.transform;
  assert.notEqual(after, before);
  const tx = (m) => Number(m.slice(7, -1).split(",")[4]);
  assert.equal(Math.round(tx(after) - tx(before)), 40);
  // Nothing moves while the view and the text sit still: no frame loop runs.
  let frames = 0;
  const raf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => {
    frames++;
    return raf ? raf(fn) : setTimeout(fn, 0);
  };
  try {
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(frames, 0, "no frames requested while idle");
  } finally {
    globalThis.requestAnimationFrame = raf;
  }
  t.done();
});
