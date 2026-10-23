// Colour picker popover: saturation/value square, hue and alpha sliders, hex
// field, eyedropper, document colours, thumbnail staples, recent colours and
// saved palettes. The conversions are pure functions (tested in
// tests/inspector-color.test.js); the UI is built on demand.
//
//   openColorPicker(anchorEl, { value, alpha = true, onInput, onChange, onClose }) -> { close, set }
//
// onInput(hex) fires live while dragging; onChange(hex) once per finished
// gesture (pointer up, a swatch click, a hex commit, a burst of arrow keys).

import { h, on } from "./dom.js";
import { iconButton, number } from "./controls.js";

export const STAPLES = ["#ffffff", "#000000", "#ffe14d", "#ff2d2d", "#d1ff4a", "#2de2e6", "#7b61ff", "#ff7a1a"];
export const RECENT_MAX = 10;
const KEY_COMMIT_MS = 450;

let boundCtx = null;

// The inspector binds the app context once so callers only pass an anchor.
export function bindColorPicker(ctx) {
  boundCtx = ctx || null;
}

// ---- pure conversions -----------------------------------------------------

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const hex2 = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");

// "#abc", "abc", "#aabbcc", "#aabbccdd" (also 4 digits) -> { r, g, b, a } or null.
export function parseHex(str) {
  if (typeof str !== "string") return null;
  let s = str.trim().replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(s)) return null;
  if (s.length === 3 || s.length === 4) s = [...s].map((c) => c + c).join("");
  if (s.length !== 6 && s.length !== 8) return null;
  const n = (i) => parseInt(s.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: s.length === 8 ? Math.round((n(6) / 255) * 1000) / 1000 : 1 };
}

// { r, g, b, a } -> "#rrggbb", or "#rrggbbaa" when a < 1 and alpha is allowed.
export function toHex({ r, g, b, a = 1 }, { alpha = true } = {}) {
  const base = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  const aa = Math.round(clamp(Number.isFinite(a) ? a : 1, 0, 1) * 255);
  return alpha && aa < 255 ? base + hex2(aa) : base;
}

export function normalizeHex(str, { alpha = true } = {}) {
  const c = parseHex(str);
  return c ? toHex(c, { alpha }) : null;
}

// r, g, b 0..255 -> { h 0..360, s 0..1, v 0..1 }
export function rgbToHsv(r, g, b) {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const d = max - min;
  let hue = 0;
  if (d > 0) {
    if (max === R) hue = ((G - B) / d) % 6;
    else if (max === G) hue = (B - R) / d + 2;
    else hue = (R - G) / d + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return { h: hue, s: max === 0 ? 0 : d / max, v: max };
}

// h 0..360, s 0..1, v 0..1 -> { r, g, b } 0..255 integers
export function hsvToRgb(hue, s, v) {
  const H = (((hue % 360) + 360) % 360) / 60;
  const C = v * s;
  const X = C * (1 - Math.abs((H % 2) - 1));
  const m = v - C;
  let rgb;
  if (H < 1) rgb = [C, X, 0];
  else if (H < 2) rgb = [X, C, 0];
  else if (H < 3) rgb = [0, C, X];
  else if (H < 4) rgb = [0, X, C];
  else if (H < 5) rgb = [X, 0, C];
  else rgb = [C, 0, X];
  const [r, g, b] = rgb.map((c) => Math.round((c + m) * 255));
  return { r, g, b };
}

export function hexToHsva(hex) {
  const c = parseHex(hex);
  if (!c) return null;
  return { ...rgbToHsv(c.r, c.g, c.b), a: c.a };
}

export function hsvaToHex({ h: hue, s, v, a = 1 }, { alpha = true } = {}) {
  return toHex({ ...hsvToRgb(hue, s, v), a }, { alpha });
}

// Same colour, ignoring case and a fully opaque alpha byte.
export function sameColor(a, b) {
  const x = normalizeHex(a || "");
  const y = normalizeHex(b || "");
  return !!x && x === y;
}

// Most recent first, no duplicates, at most `max`.
export function pushRecent(list, color, max = RECENT_MAX) {
  const c = normalizeHex(color || "");
  const prev = Array.isArray(list) ? list.map((x) => normalizeHex(String(x))).filter(Boolean) : [];
  if (!c) return prev.slice(0, max);
  return [c, ...prev.filter((x) => x !== c)].slice(0, max);
}

// Colours a design already uses, most used first.
export function docColors(doc, max = 12) {
  const counts = new Map();
  const add = (c) => {
    const n = normalizeHex(c || "");
    if (n) counts.set(n, (counts.get(n) || 0) + 1);
  };
  const bg = doc?.background;
  if (bg?.kind === "color") add(bg.color);
  if (bg?.kind === "gradient") add(bg.from), add(bg.to);
  for (const l of doc?.layers || []) {
    if (l.shadow?.on) add(l.shadow.color);
    if (l.glow?.on) add(l.glow.color);
    switch (l.type) {
      case "text":
        if (l.gradient?.on) add(l.gradient.from), add(l.gradient.to);
        else add(l.color);
        if (l.stroke?.on) add(l.stroke.color);
        if (l.stroke2?.on) add(l.stroke2.color);
        if (l.bg?.on) add(l.bg.color);
        break;
      case "shape":
        if (l.fill?.on) add(l.fill.color);
        if (l.stroke?.on) add(l.stroke.color);
        break;
      case "image":
        if (l.outline?.on) add(l.outline.color);
        break;
      default:
        add(l.color);
    }
  }
  return [...counts.entries()]
    .map(([c, n], i) => ({ c, n, i }))
    .sort((x, y) => y.n - x.n || x.i - y.i)
    .slice(0, max)
    .map((x) => x.c);
}

// Saved palettes from prefs: [{ name, colors }] -> cleaned, skipping empties.
export function cleanPalettes(list, { alpha = true } = {}) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const p of list) {
    if (!p || !Array.isArray(p.colors)) continue;
    const colors = [...new Set(p.colors.map((c) => normalizeHex(String(c), { alpha })).filter(Boolean))].slice(0, 32);
    if (!colors.length) continue;
    out.push({ name: String(p.name || "Palette").slice(0, 40), colors });
  }
  return out.slice(0, 12);
}

// ---- popover host ------------------------------------------------------------

// Uses the shell's popover when there is one, otherwise a small fixed panel
// that closes on Escape or a click outside. onEscape(e) lets the content use
// Escape first (clear a search, revert a field): returning true keeps the
// popover open.
export function showPopover(ctx, anchorEl, content, { placement, onClose, onEscape, className } = {}) {
  const place = placement || (anchorEl?.closest?.(".insp") ? "left" : "bottom");
  if (typeof ctx?.ui?.popover === "function") {
    const pop = ctx.ui.popover(anchorEl, content, { placement: place, onClose, onEscape, class: className });
    if (className) pop?.el?.classList?.add(className);
    return pop;
  }
  const wrap = h("div", { class: ["pop-fallback", className], role: "dialog" }, content);
  document.body.append(wrap);
  const r = anchorEl?.getBoundingClientRect?.() || { left: 100, top: 100, right: 100, bottom: 100, width: 0, height: 0 };
  const w = wrap.offsetWidth;
  const ht = wrap.offsetHeight;
  let x = place === "left" ? r.left - w - 10 : r.left + r.width / 2 - w / 2;
  let y = place === "left" ? r.top - 8 : r.bottom + 10;
  x = clamp(x, 8, window.innerWidth - w - 8);
  y = clamp(y, 8, window.innerHeight - ht - 8);
  wrap.style.left = `${Math.round(x)}px`;
  wrap.style.top = `${Math.round(y)}px`;
  let closed = false;
  const offs = [];
  const close = () => {
    if (closed) return;
    closed = true;
    offs.forEach((f) => f());
    wrap.remove();
    onClose?.();
  };
  setTimeout(() => {
    if (closed) return;
    offs.push(on(document, "pointerdown", (e) => {
      if (!wrap.contains(e.target) && !anchorEl?.contains?.(e.target)) close();
    }, true));
    offs.push(on(document, "keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (onEscape?.(e) === true) {
          e.preventDefault();
          return;
        }
        close();
      }
    }, true));
  }, 0);
  requestAnimationFrame(() => wrap.querySelector("[autofocus]")?.focus?.({ preventScroll: true }));
  return { close, el: wrap };
}

// What open* returns when the popover did not open (the same click closed it).
export const DEAD_POPOVER = Object.freeze({ el: null, closed: true, close() {}, set() {} });

// ---- the picker ----------------------------------------------------------------

function swatchButton(color, tip, onPick) {
  const b = h("button", { type: "button", class: "cp-sw", "data-tip": tip || color.toUpperCase(), "aria-label": tip || color.toUpperCase() }, h("span", { style: { background: color } }));
  b.addEventListener("click", () => onPick(color));
  return b;
}

function swatchGroup(title, colors, onPick, extra) {
  if (!colors.length) return null;
  return h("div", { class: "cp-group" }, h("div", { class: "cp-group-head" }, h("span", { class: "micro" }, title), extra), h("div", { class: "cp-swatches" }, colors.map((c) => swatchButton(c, null, onPick))));
}

// Drag on el and report the pointer position normalised to el's box.
function track(el, fn, onEnd) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.focus({ preventScroll: true });
    try {
      el.setPointerCapture(e.pointerId);
    } catch {}
    const at = (ev) => {
      const r = el.getBoundingClientRect();
      fn(clamp((ev.clientX - r.left) / (r.width || 1), 0, 1), clamp((ev.clientY - r.top) / (r.height || 1), 0, 1));
    };
    at(e);
    const move = (ev) => at(ev);
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      onEnd();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  });
}

export function openColorPicker(anchorEl, { value = "#ffffff", alpha = true, onInput, onChange, onClose, ctx = boundCtx, placement, title } = {}) {
  const fmt = (st) => hsvaToHex(st, { alpha });
  const original = normalizeHex(value || "", { alpha }) || "#ffffff";
  const st = hexToHsva(original) || { h: 0, s: 0, v: 1, a: 1 };
  if (!alpha) st.a = 1;
  let current = fmt(st);
  let keyTimer = 0;
  let pendingKeys = false;

  const emitInput = () => {
    current = fmt(st);
    paint();
    onInput?.(current);
  };
  const emitChange = () => {
    current = fmt(st);
    clearTimeout(keyTimer);
    pendingKeys = false;
    onChange?.(current);
    rememberRecent(ctx, current);
  };
  // Arrow keys: live input now, one change after the burst.
  const keyChange = () => {
    pendingKeys = true;
    clearTimeout(keyTimer);
    keyTimer = setTimeout(emitChange, KEY_COMMIT_MS);
  };
  const setHex = (hex, { input = true, change = true } = {}) => {
    const next = hexToHsva(hex);
    if (!next) return;
    // Keep the hue when the new colour is grey or black.
    if (next.s === 0 || next.v === 0) next.h = st.h;
    Object.assign(st, next);
    if (!alpha) st.a = 1;
    if (input) emitInput();
    else paint();
    if (change) emitChange();
  };

  // Square
  const svHandle = h("span", { class: "cp-sv-handle" });
  const sv = h("div", { class: "cp-sv", tabindex: 0, role: "slider", "aria-label": "Saturation and brightness" }, svHandle);
  track(sv, (x, y) => {
    st.s = x;
    st.v = 1 - y;
    emitInput();
  }, emitChange);
  sv.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    st.s = clamp(st.s + d[0], 0, 1);
    st.v = clamp(st.v + d[1], 0, 1);
    emitInput();
    keyChange();
  });

  // Hue and alpha
  const hueThumb = h("span", { class: "cp-thumb" });
  const hue = h("div", { class: "cp-bar cp-hue", tabindex: 0, role: "slider", "aria-label": "Hue", "aria-valuemin": "0", "aria-valuemax": "360" }, hueThumb);
  track(hue, (x) => {
    st.h = x * 360;
    if (st.h >= 360) st.h = 359.999;
    emitInput();
  }, emitChange);
  hue.addEventListener("keydown", (e) => {
    const d = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : 0;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    st.h = (st.h + d * (e.shiftKey ? 10 : 1) + 360) % 360;
    emitInput();
    keyChange();
  });

  const alphaFill = h("span", { class: "cp-alpha-fill" });
  const alphaThumb = h("span", { class: "cp-thumb" });
  const alphaBar = h("div", { class: "cp-bar cp-alpha", tabindex: 0, role: "slider", "aria-label": "Opacity", "aria-valuemin": "0", "aria-valuemax": "100" }, alphaFill, alphaThumb);
  track(alphaBar, (x) => {
    st.a = Math.round(x * 100) / 100;
    emitInput();
  }, emitChange);
  alphaBar.addEventListener("keydown", (e) => {
    const d = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : 0;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    st.a = clamp(Math.round((st.a + d * (e.shiftKey ? 0.1 : 0.01)) * 100) / 100, 0, 1);
    emitInput();
    keyChange();
  });

  // Before / after preview: click the left half to go back.
  const prevOld = h("button", { type: "button", class: "cp-prev-old", "data-tip": "Original colour", "aria-label": "Back to the original colour" });
  prevOld.style.setProperty("--c", original);
  prevOld.addEventListener("click", () => setHex(original));
  const prevNew = h("span", { class: "cp-prev-new" });
  const preview = h("div", { class: "cp-prev" }, prevOld, prevNew);

  const hasDropper = typeof window !== "undefined" && "EyeDropper" in window;
  const dropper = hasDropper
    ? iconButton({
        icon: "pipette",
        tip: "Pick a colour from the screen",
        size: "sm",
        onClick: async () => {
          try {
            const res = await new window.EyeDropper().open();
            if (res?.sRGBHex) setHex(normalizeHex(res.sRGBHex) || res.sRGBHex);
          } catch {}
        },
      })
    : null;

  // Hex and alpha fields
  const hexInput = h("input", { type: "text", class: "cp-hex num", spellcheck: "false", autocomplete: "off", maxlength: 9, "aria-label": "Hex colour" });
  const commitHex = () => {
    const n = normalizeHex(hexInput.value, { alpha });
    if (n && n !== current) setHex(n);
    else paintFields(true);
  };
  hexInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commitHex();
      hexInput.select();
    } else if (e.key === "Escape") {
      paintFields(true);
    }
  });
  hexInput.addEventListener("blur", commitHex);
  hexInput.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text") || "";
    const n = normalizeHex(text, { alpha });
    if (n) {
      e.preventDefault();
      setHex(n);
    }
  });
  const alphaNum = alpha
    ? number({
        label: "A",
        tip: "Opacity",
        min: 0,
        max: 100,
        step: 1,
        unit: "%",
        value: Math.round(st.a * 100),
        width: 72,
        onInput: (v) => {
          st.a = v / 100;
          emitInput();
        },
        onChange: (v) => {
          st.a = v / 100;
          emitInput();
          emitChange();
        },
      })
    : null;

  const pick = (c) => setHex(c);
  const doc = ctx?.store?.doc;
  const recent = (ctx?.prefs?.get?.("recentColors", []) || []).map((c) => normalizeHex(String(c), { alpha })).filter(Boolean);
  const palettes = cleanPalettes(ctx?.prefs?.get?.("palettes", []), { alpha });
  const docList = doc ? docColors(doc, 16).map((c) => normalizeHex(c, { alpha })).filter(Boolean) : [];

  const root = h(
    "div",
    { class: ["cp", !alpha && "no-alpha"], "aria-label": title || "Colour" },
    sv,
    h("div", { class: "cp-controls" }, dropper, h("div", { class: "cp-bars" }, hue, alpha ? alphaBar : null), preview),
    h("div", { class: "cp-fields" }, h("label", { class: "cp-hex-wrap" }, h("span", { class: "cp-hash" }, "#"), hexInput), alphaNum),
    h(
      "div",
      { class: "cp-lists" },
      swatchGroup("In this design", [...new Set(docList)], pick),
      swatchGroup("Staples", alpha ? STAPLES : STAPLES.map((c) => normalizeHex(c, { alpha: false })), pick),
      swatchGroup("Recent", [...new Set(recent)], pick),
      palettes.map((p) => swatchGroup(p.name, p.colors, pick))
    )
  );
  root.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" && e.key !== "Tab") e.stopPropagation();
  });

  function paintFields(force = false) {
    if (force || document.activeElement !== hexInput) hexInput.value = current.slice(1).toUpperCase();
    alphaNum?.set(Math.round(st.a * 100));
  }

  function paint() {
    const pure = hsvaToHex({ h: st.h, s: 1, v: 1, a: 1 }, { alpha: false });
    const opaque = hsvaToHex({ ...st, a: 1 }, { alpha: false });
    sv.style.setProperty("--hue", pure);
    svHandle.style.left = `${st.s * 100}%`;
    svHandle.style.top = `${(1 - st.v) * 100}%`;
    svHandle.style.setProperty("--c", opaque);
    hueThumb.style.left = `${(st.h / 360) * 100}%`;
    hueThumb.style.setProperty("--c", pure);
    hue.setAttribute("aria-valuenow", String(Math.round(st.h)));
    alphaFill.style.setProperty("--c", opaque);
    alphaThumb.style.left = `${st.a * 100}%`;
    alphaThumb.style.setProperty("--c", opaque);
    alphaBar.setAttribute("aria-valuenow", String(Math.round(st.a * 100)));
    prevNew.style.setProperty("--c", current);
    sv.setAttribute("aria-valuetext", current.toUpperCase());
    paintFields();
  }
  paint();

  let closed = false;
  const pop = showPopover(ctx, anchorEl, root, {
    placement,
    className: "cp-pop",
    // Escape in a hex field that was typed in puts the colour back; the next
    // Escape closes. (Closing with a half-typed value would commit it on blur.)
    onEscape: (e) => {
      if (e.target !== hexInput || hexInput.value.toUpperCase() === current.slice(1).toUpperCase()) return false;
      paintFields(true);
      hexInput.select();
      return true;
    },
    onClose: () => {
      if (closed) return;
      closed = true;
      if (pendingKeys) emitChange();
      onClose?.();
    },
  });
  if (!pop || pop.closed) {
    closed = true;
    return DEAD_POPOVER;
  }

  return {
    el: root,
    close: () => pop?.close?.(),
    // Update from outside (for example after undo) without firing callbacks.
    set(hex) {
      const n = normalizeHex(hex || "", { alpha });
      if (n && n !== current) setHex(n, { input: false, change: false });
      current = fmt(st);
      paint();
    },
  };
}

function rememberRecent(ctx, color) {
  const prefs = ctx?.prefs;
  if (!prefs?.get || !prefs?.set) return;
  prefs.set("recentColors", pushRecent(prefs.get("recentColors", []), color));
}
