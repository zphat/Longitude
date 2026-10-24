// Tiny DOM helpers. Never pass user strings as HTML: children are text nodes.

const SVG_NS = "http://www.w3.org/2000/svg";

function apply(el, props) {
  if (!props) return el;
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class" || k === "className") el.setAttribute("class", Array.isArray(v) ? v.filter(Boolean).join(" ") : v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "text") el.textContent = v;
    else if (k in el && !(el instanceof SVGElement) && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// h("button", { class: "btn", onClick }, "Label", icon("x"))
export function h(tag, props, ...children) {
  if (props instanceof Node || typeof props === "string" || Array.isArray(props)) {
    children.unshift(props);
    props = null;
  }
  return append(apply(document.createElement(tag), props), children);
}

export function svg(tag, props, ...children) {
  if (props instanceof Node || Array.isArray(props)) {
    children.unshift(props);
    props = null;
  }
  const el = document.createElementNS(SVG_NS, tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.setAttribute("class", v);
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "text") el.textContent = v;
      else el.setAttribute(k, v);
    }
  }
  return append(el, children);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

export function on(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  return () => target.removeEventListener(type, fn, opts);
}

// Collects disposers so a component can clean up in one call.
export function disposer() {
  const list = [];
  const d = (fn) => {
    if (typeof fn === "function") list.push(fn);
    return fn;
  };
  d.dispose = () => {
    while (list.length) {
      try {
        list.pop()();
      } catch (err) {
        console.error(err);
      }
    }
  };
  return d;
}

export function debounce(fn, ms) {
  let t = 0;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.flush = (...args) => {
    clearTimeout(t);
    fn(...args);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

// Adds a stylesheet once and resolves when it has loaded (or failed, or after
// `timeout` ms), so a dialog it styles never shows unstyled. A link already
// in the page counts. Without a browser (tests, a fake DOM) it resolves at once.
const styles = new Map(); // absolute href -> Promise
export function loadStyle(href, { timeout = 4000 } = {}) {
  const doc = globalThis.document;
  if (!doc?.head) return Promise.resolve();
  const url = new URL(href, doc.baseURI).href;
  if (styles.has(url)) return styles.get(url);
  const abs = (l) => new URL(l.getAttribute("href") || "", doc.baseURI).href;
  const found = [...doc.querySelectorAll('link[rel="stylesheet"]')].find((l) => abs(l) === url);
  const link = found || h("link", { rel: "stylesheet", href: url });
  const p = new Promise((resolve) => {
    // A browser sets link.sheet once the file is in; a fake DOM has no such property.
    if (link.sheet || !("sheet" in link)) return resolve();
    const done = (ok) => {
      clearTimeout(timer);
      link.removeEventListener("load", onLoad);
      link.removeEventListener("error", onError);
      if (!ok && !found) {
        styles.delete(url); // tried again next time
        link.remove();
      }
      resolve();
    };
    const onLoad = () => done(true);
    const onError = () => done(false);
    const timer = setTimeout(() => done(true), timeout);
    link.addEventListener("load", onLoad);
    link.addEventListener("error", onError);
  });
  styles.set(url, p);
  if (!found) doc.head.append(link);
  return p;
}

// Pointer drag helper with capture. onMove/onUp receive (e, start).
export function drag(e, { onMove, onUp, cursor } = {}) {
  const start = { x: e.clientX, y: e.clientY, e };
  const target = e.currentTarget instanceof Element ? e.currentTarget : e.target;
  try {
    target.setPointerCapture?.(e.pointerId);
  } catch {}
  const prevCursor = document.body.style.cursor;
  if (cursor) document.body.style.cursor = cursor;
  const move = (ev) => onMove?.(ev, start);
  const up = (ev) => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", up);
    target.removeEventListener("pointercancel", up);
    if (cursor) document.body.style.cursor = prevCursor;
    onUp?.(ev, start);
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", up);
  target.addEventListener("pointercancel", up);
  return start;
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

// Any form field has focus: it keeps plain keys (a slider's arrows, a
// checkbox's Space, letters typed into a box).
export function isTyping(target = document.activeElement) {
  if (!target) return false;
  const t = target.tagName;
  return t === "INPUT" || t === "TEXTAREA" || t === "SELECT" || !!target.isContentEditable;
}

// Inputs that take typed text, and with it their own Ctrl+Z, Ctrl+C/V/X and
// Ctrl+A. Ranges, checkboxes, radios, color wells, buttons and file inputs
// do not, and neither does a select.
const TEXT_INPUTS = new Set(["text", "search", "email", "url", "tel", "password", "number", "date", "time", "datetime-local", "month", "week"]);

export function isTextEntry(target = document.activeElement) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const t = target.tagName;
  if (t === "TEXTAREA") return true;
  if (t !== "INPUT") return false;
  const type = String(target.getAttribute?.("type") || target.type || "text").toLowerCase();
  return TEXT_INPUTS.has(type);
}

// Whether a key combo ("Mod+Z", "R", "F2") belongs to the focused field
// instead of the app's shortcuts. Every field keeps its plain keys; only text
// entry keeps Ctrl/Cmd/Alt combos and F keys, so Ctrl+Z, Ctrl+D or F2 still
// work after a slider or a checkbox was used.
export function fieldOwnsCombo(combo, target = document.activeElement) {
  const plain = !/^(Mod|Ctrl|Alt)\+/.test(combo) && !/^F\d+$/.test(combo);
  return plain ? isTyping(target) : isTextEntry(target);
}
