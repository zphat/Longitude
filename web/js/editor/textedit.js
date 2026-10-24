// Inline text editing. A transparent textarea sits exactly over the text
// layer, with the same font, size, spacing, alignment and transform as the
// canvas glyphs, so the caret and selection come from the browser while the
// canvas keeps drawing the real text underneath. Each keystroke is a
// transient store patch; the whole session is one undo step.
//
// createTextEditor(ctx, editor) -> {
//   start(id, { caret = "end" | "all" | "start" | { x, y } (doc point) }) -> bool
//   create(props, { caret = "all" }) -> id | null   new text layer, edited at once ("Add text")
//   stop(commit = true) -> bool
//   active -> id | null
//   reposition()
// }

import { h, isMac } from "../ui/dom.js";
import { createLayer } from "../core/model.js";
import { fromLocal, toLocal } from "../core/geometry.js";
import { layoutText, fontStack, glyphOffsets, displayText } from "../core/textlayout.js";

const instances = new WeakMap();

// The text editor created for this app context, for tools that need more
// than editor.startTextEdit (the text tool and insert.text use create()).
export function textEditorFor(ctx) {
  return instances.get(ctx) || null;
}

// Keys that mean something while typing, even with Ctrl/Cmd held. They stay
// inside the text box instead of reaching app shortcuts.
const EDIT_KEYS = new Set(["a", "c", "v", "x", "y", "z", "arrowleft", "arrowright", "arrowup", "arrowdown", "home", "end", "backspace", "delete", "enter", "pageup", "pagedown"]);

// Events that belong to the text box, not to the stage or app shortcuts
// (drops still reach the editor so files dropped here import as usual; a
// file drop ends the edit first, so the import is its own undo step).
const STOP_EVENTS = ["pointerdown", "mousedown", "click", "dblclick", "contextmenu", "paste", "copy", "cut"];

// The press that opened the editor can still move focus away right after;
// a blur this soon after starting takes focus back instead of ending.
const REFOCUS_MS = 400;

const hasFiles = (e) => [...(e?.dataTransfer?.types || [])].includes("Files");

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function frame(fn, fallback = 120) {
  let done = false;
  let raf = 0;
  const run = () => {
    if (done) return;
    done = true;
    if (raf) cancelAnimationFrame(raf);
    clearTimeout(timer);
    fn();
  };
  if (typeof requestAnimationFrame === "function") raf = requestAnimationFrame(run);
  const timer = setTimeout(run, fallback);
  return () => {
    done = true;
    if (raf) cancelAnimationFrame(raf);
    clearTimeout(timer);
  };
}

const cut = (v) => Math.round(v * 1000) / 1000;

// UTF-16 offset of the first `count` code points of s.
function codeUnits(s, count) {
  let n = 0;
  let i = 0;
  for (const ch of s) {
    if (n >= count) break;
    i += ch.length;
    n++;
  }
  return i;
}

export function createTextEditor(ctx, editor) {
  let s = null;

  const store = () => ctx.store;
  const host = () => editor.host || editor.canvas?.parentElement || document.body;

  // ---- geometry -------------------------------------------------------------

  // Client coords of a content-space point of the layer.
  function screenOf(layer, x, y) {
    return editor.docToScreen(fromLocal(layer, { x, y }));
  }

  function position() {
    if (!s) return;
    const layer = store().get(s.id);
    if (!layer || layer.type !== "text") return;
    const ta = s.ta;
    const L = layoutText(layer, ctx.fonts);
    const fixed = layer.wrap === "fixed";
    const contentW = fixed ? Math.max(1, L.width - 2 * L.pad.x) : L.contentWidth;
    // Room to grow while typing, on the side(s) the text grows toward.
    const slack = fixed ? 0 : layer.size * 1.2;
    let left;
    let width;
    if (fixed) {
      // CSS letter spacing also follows the last glyph of a line, so each
      // CSS line is one spacing wider than the canvas measures it. Widen
      // (or, for negative spacing, narrow) the box by that much so the
      // browser wraps where the canvas does; the extra space then lands on
      // the trailing side and every alignment lines up as it is.
      left = -L.width / 2 + L.pad.x;
      width = Math.max(1, contentW + L.spacing);
    } else {
      if (layer.align === "left") {
        left = -L.width / 2 + L.pad.x;
        width = contentW + slack;
      } else if (layer.align === "right") {
        left = L.width / 2 - L.pad.x - contentW - slack;
        width = contentW + slack;
      } else {
        left = -contentW / 2 - slack;
        width = contentW + 2 * slack;
      }
      // The same trailing spacing, for lines that do not wrap: centered and
      // right-aligned lines shift by it.
      if (layer.align === "center") left += L.spacing / 2;
      else if (layer.align === "right") left += L.spacing;
    }
    // CSS centers the font's ascent + descent in each line box; the canvas
    // puts the first baseline at pad + ascent.
    const baseline = -L.height / 2 + L.pad.y + L.ascent;
    const top = baseline - (L.lineHeightPx + L.ascent - L.descent) / 2;
    const height = (L.lines.length + 1) * L.lineHeightPx;

    const p0 = screenOf(layer, left, top);
    const px = screenOf(layer, left + 100, top);
    const py = screenOf(layer, left, top + 100);
    const ux = { x: (px.x - p0.x) / 100, y: (px.y - p0.y) / 100 };
    const uy = { x: (py.x - p0.x) / 100, y: (py.y - p0.y) / 100 };
    const z = Math.hypot(ux.x, ux.y) || 1;
    const zy = Math.hypot(uy.x, uy.y) || 1;
    const op = ta.offsetParent;
    const r = op ? op.getBoundingClientRect() : { left: 0, top: 0 };
    const ox = r.left + (op ? op.clientLeft - op.scrollLeft : 0);
    const oy = r.top + (op ? op.clientTop - op.scrollTop : 0);

    const style = {
      fontFamily: fontStack(layer.font),
      fontWeight: String(layer.weight),
      fontStyle: layer.italic ? "italic" : "normal",
      fontSize: `${cut(layer.size * z)}px`,
      lineHeight: `${cut(L.lineHeightPx * z)}px`,
      letterSpacing: `${cut(L.spacing * z)}px`,
      textAlign: layer.align,
      textTransform: layer.uppercase ? "uppercase" : "none",
      whiteSpace: fixed ? "pre-wrap" : "pre",
      width: `${cut(width * z + (fixed ? 0.5 : 0))}px`,
      height: `${cut(height * z)}px`,
      transform: `matrix(${cut(ux.x / z)}, ${cut(ux.y / z)}, ${cut(uy.x / zy)}, ${cut(uy.y / zy)}, ${cut(p0.x - ox)}, ${cut(p0.y - oy)})`,
    };
    const key = JSON.stringify(style);
    if (key !== s.styleKey) {
      s.styleKey = key;
      Object.assign(ta.style, style);
    }
    if (ta.scrollTop || ta.scrollLeft) {
      ta.scrollTop = 0;
      ta.scrollLeft = 0;
    }
  }

  // Index into layer.text nearest to a doc point.
  function caretIndexAt(layer, docPt) {
    const L = layoutText(layer, ctx.fonts);
    if (!L.lines.length) return 0;
    const p = toLocal(layer, docPt);
    const firstTop = L.lines[0].y - L.ascent;
    const li = Math.max(0, Math.min(L.lines.length - 1, Math.floor((p.y - firstTop) / L.lineHeightPx)));
    const line = L.lines[li];
    const offs = glyphOffsets(line, L);
    const rel = p.x - line.x;
    let ci = offs.length;
    for (let i = 0; i < offs.length; i++) {
      const next = i + 1 < offs.length ? offs[i + 1].x : line.width;
      if (rel < (offs[i].x + next) / 2) {
        ci = i;
        break;
      }
    }
    // Walk the source text: lines end at a newline or at a wrap space.
    const src = displayText(layer);
    let pos = 0;
    for (let i = 0; i < li; i++) {
      pos += L.lines[i].text.length;
      if (src[pos] === "\n" || src[pos] === " ") pos++;
    }
    return Math.min(String(layer.text).length, pos + codeUnits(line.text, ci));
  }

  function setCaret(caret) {
    if (!s) return;
    const ta = s.ta;
    const n = ta.value.length;
    if (caret === "all") ta.setSelectionRange(0, n);
    else if (caret === "start") ta.setSelectionRange(0, 0);
    else if (caret && typeof caret === "object" && Number.isFinite(caret.x) && Number.isFinite(caret.y)) {
      const layer = store().get(s.id);
      const i = layer ? caretIndexAt(layer, caret) : n;
      ta.setSelectionRange(i, i);
    } else ta.setSelectionRange(n, n);
  }

  // ---- session ----------------------------------------------------------------

  function ensureFont(layer) {
    const fonts = ctx.fonts;
    if (!fonts?.load || !fonts.loaded) return;
    const style = layer.italic ? "italic" : "normal";
    try {
      if (fonts.loaded(layer.font, layer.weight, style)) return;
      const id = layer.id;
      Promise.resolve(fonts.load(layer.font, layer.weight, style, { retry: true }))
        .then((ok) => {
          if (!ok || !s || s.id !== id) return;
          store().remeasure([id]);
          position();
        })
        .catch(() => {});
    } catch {}
  }

  function onKeyDown(e) {
    if (!s) return;
    if (e.isComposing || e.keyCode === 229 || s.composing) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (e.key === "Escape" || (e.key === "Enter" && mod)) {
      e.preventDefault();
      e.stopPropagation();
      api.stop(true);
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const k = String(e.key).toLowerCase();
    if (mod && !e.altKey && !e.shiftKey && (k === "b" || k === "i")) {
      e.preventDefault();
      e.stopPropagation();
      toggleStyle(k === "b" ? "bold" : "italic");
      return;
    }
    if (!mod || EDIT_KEYS.has(k)) e.stopPropagation();
  }

  // Ctrl/Cmd+B and +I while typing: bold (to the nearest heavier or regular
  // face the font has) and italic, for the whole layer.
  function toggleStyle(kind) {
    const layer = store().get(s.id);
    if (!layer) return;
    let props;
    if (kind === "bold") {
      const want = layer.weight >= 600 ? 400 : 700;
      const w = Number(ctx.fonts?.nearestWeight?.(layer.font, want)) || want;
      if (w === layer.weight) return;
      props = { weight: w };
    } else {
      props = { italic: !layer.italic };
    }
    store().patch(s.id, props, { transient: true });
    ensureFont(store().get(s.id));
    position();
  }

  function onBeforeInput(e) {
    // The Enter that opened the editor must not also type a new line.
    if (s && (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") && now() - s.startedAt < 80) e.preventDefault();
  }

  function onInput() {
    if (!s) return;
    const text = s.ta.value.replace(/\r\n?/g, "\n");
    store().patch(s.id, { text }, { transient: true, label: "Edit text" });
    position();
  }

  function onStoreChange(e) {
    if (!s) return;
    const d = e.detail || {};
    // These end any open gesture inside the store, so the session is over.
    if (d.reason === "setdoc" || d.reason === "undo" || d.reason === "redo") {
      teardown();
      return;
    }
    if (d.ids && !d.ids.includes(s.id)) return;
    const layer = store().get(s.id);
    if (!layer || layer.type !== "text" || layer.hidden) {
      api.stop(true);
      return;
    }
    const value = s.ta.value.replace(/\r\n?/g, "\n");
    if (!s.composing && layer.text !== value) {
      const { selectionStart, selectionEnd } = s.ta;
      s.ta.value = layer.text;
      s.ta.setSelectionRange(Math.min(selectionStart, layer.text.length), Math.min(selectionEnd, layer.text.length));
    }
    position();
  }

  function onOutside(e) {
    if (!s || e.target === s.ta) return;
    api.stop(true);
  }

  // Files dragged in from the desktop fire no pointerdown. End the edit
  // before the importer adds them, or they would join the text's undo step
  // (and an empty-text cancel would take them away again).
  function onDrop(e) {
    if (s && hasFiles(e)) api.stop(true);
  }

  // Focus went to something else (the command palette, a menu opened from
  // the keyboard): the edit is over, so whatever runs next is its own step.
  // When the whole window loses focus the box stays the active element, and
  // the edit goes on.
  function onBlur() {
    const sess = s;
    if (!sess) return;
    if (now() - sess.startedAt < REFOCUS_MS) {
      setTimeout(() => s === sess && sess.ta.focus({ preventScroll: true }), 0);
      return;
    }
    setTimeout(() => {
      if (s !== sess) return;
      const ae = document.activeElement;
      if (ae && ae !== sess.ta && ae !== document.body) api.stop(true);
    }, 0);
  }

  function open(id, { caret = "end", created = false } = {}) {
    const layer = store().get(id);
    if (!layer || layer.type !== "text") return false;
    const ta = h("textarea", {
      class: "text-edit",
      spellcheck: "false",
      autocomplete: "off",
      autocorrect: "off",
      autocapitalize: "off",
      "aria-label": "Edit text",
      rows: 1,
    });
    ta.maxLength = 10000;
    ta.value = layer.text;
    host().append(ta);
    s = { id, ta, created, startedAt: now(), composing: false, styleKey: "", offs: [], loop: null };
    const listen = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      s.offs.push(() => target.removeEventListener(type, fn, opts));
    };
    listen(ta, "keydown", onKeyDown);
    listen(ta, "beforeinput", onBeforeInput);
    listen(ta, "input", onInput);
    listen(ta, "compositionstart", () => s && (s.composing = true));
    listen(ta, "compositionend", () => {
      if (!s) return;
      s.composing = false;
      onInput();
    });
    listen(ta, "blur", onBlur);
    listen(ta, "scroll", () => {
      ta.scrollTop = 0;
      ta.scrollLeft = 0;
    });
    for (const type of STOP_EVENTS) listen(ta, type, (e) => e.stopPropagation());
    listen(document, "pointerdown", onOutside, true);
    listen(globalThis, "drop", onDrop, true);
    listen(globalThis, "resize", position);
    listen(store(), "change", onStoreChange);
    // The box follows the view (zoom, pan, fit), font loads and the layer;
    // nothing runs while the view and the text sit still.
    s.offs.push(ctx.on("view", () => position()));
    for (const type of ["load", "change"]) if (ctx.fonts?.addEventListener) listen(ctx.fonts, type, position);
    const docFonts = globalThis.document?.fonts;
    if (docFonts?.addEventListener) listen(docFonts, "loadingdone", position);
    s.offs.push(
      ctx.on("tool", (d) => {
        if (d?.id && d.id !== "select" && d.id !== "text") api.stop(true);
      }),
    );
    s.offs.push(ctx.on("home", (d) => d?.open && api.stop(true)));

    position();
    try {
      ta.focus({ preventScroll: true });
    } catch {
      ta.focus();
    }
    setCaret(caret);
    if (store().selection.length !== 1 || store().selection[0] !== id) store().select([id]);
    ensureFont(layer);
    // Once more after the first layout, in case the host moved meanwhile.
    s.loop = frame(position);
    ctx.emit("textedit", { id });
    editor.requestRender?.();
    return true;
  }

  // Removes the overlay without touching the store.
  function teardown({ emit = true } = {}) {
    if (!s) return null;
    const sess = s;
    s = null;
    sess.loop?.();
    for (const off of sess.offs.splice(0)) {
      try {
        off();
      } catch {}
    }
    const hadFocus = document.activeElement === sess.ta;
    sess.ta.remove();
    if (hadFocus) {
      try {
        editor.host?.focus?.({ preventScroll: true });
      } catch {}
    }
    if (emit) {
      ctx.emit("textedit", { id: null });
      editor.requestRender?.();
    }
    return sess;
  }

  const api = {
    get active() {
      return s ? s.id : null;
    },

    start(id, { caret = "end" } = {}) {
      if (s && s.id === id) {
        try {
          s.ta.focus({ preventScroll: true });
        } catch {}
        setCaret(caret);
        return true;
      }
      if (s) api.stop(true);
      const st = store();
      const layer = st?.get(id);
      if (!layer || layer.type !== "text" || layer.hidden) return false;
      if (layer.locked) {
        ctx.ui?.toast?.("Unlock this layer to edit its text.", { kind: "info" });
        return false;
      }
      st.begin("Edit text");
      if (!open(id, { caret, created: false })) {
        st.cancel();
        return false;
      }
      return true;
    },

    // A new text layer that is edited straight away. The add and the typing
    // are one undo step; leaving it empty removes it without a trace.
    create(props = {}, { caret = "all" } = {}) {
      if (s) api.stop(true);
      const st = store();
      let layer;
      try {
        layer = createLayer("text", props);
      } catch (err) {
        console.error(err);
        return null;
      }
      st.begin("Add text");
      const [id] = st.add([layer], { label: "Add text" });
      if (!id || !open(id, { caret, created: true })) {
        st.cancel();
        return null;
      }
      return id;
    },

    stop(commit = true) {
      const sess = teardown({ emit: false });
      if (!sess) return false;
      const st = store();
      if (st.inGesture) {
        const layer = st.get(sess.id);
        const empty = !layer || !String(layer.text).trim();
        if (layer && (!commit || empty)) st.cancel();
        else st.commit();
      }
      ctx.emit("textedit", { id: null });
      editor.requestRender?.();
      return true;
    },

    reposition() {
      position();
    },
  };

  instances.set(ctx, api);
  return api;
}
