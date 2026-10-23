// Shared controls. Every value control calls onInput(v) while the user drags
// or types (live, no history) and onChange(v) once when the gesture ends
// (commit, one undo step). Callers usually wire onInput to a transient store
// patch inside store.begin()/commit(), or to patch(..., { coalesce }).
//
// Each control returns its root element with:
//   el.value          current value (get/set; set does not fire callbacks)
//   el.set(v)         same as setting value
//   el.setDisabled(b)

import { h } from "./dom.js";
import { icon } from "./icons.js";

const clampN = (v, min, max) => Math.min(max, Math.max(min, v));
const roundTo = (v, step) => {
  const d = (String(step).split(".")[1] || "").length;
  return Number((Math.round(v / step) * step).toFixed(d));
};

function tipAttrs(tip, kbd) {
  const a = {};
  if (tip) {
    a["data-tip"] = tip;
    a["aria-label"] = tip;
  }
  if (kbd) a["data-kbd"] = kbd;
  return a;
}

// Drag horizontally on `handle` to change a number. Shift = x10, Alt = x0.1.
function scrub(handle, { get, set, step, min, max, onEnd }) {
  handle.classList.add("scrub");
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const start = get();
    let moved = false;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("scrubbing");
    const move = (ev) => {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < 3) return;
      moved = true;
      const mult = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      const range = max - min;
      const perPx = range > 0 && range <= 2 ? step : step * Math.max(0.25, Math.min(4, range / 400));
      set(clampN(roundTo(start + Math.round(dx) * perPx * mult, step * (ev.altKey ? 0.1 : 1)), min, max), false);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      document.body.classList.remove("scrubbing");
      if (moved) onEnd?.();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
}

function numberInput({ value, min, max, step, unit, decimals, commit, live }) {
  const input = h("input", {
    type: "text",
    inputmode: "decimal",
    class: "ctl-num-input num",
    spellcheck: "false",
    autocomplete: "off",
  });
  const fmt = (v) => {
    const d = decimals ?? (String(step).split(".")[1] || "").length;
    return Number(v).toFixed(d).replace(/\.0+$/, "") + (unit || "");
  };
  input.value = fmt(value);
  const parse = () => {
    const n = parseFloat(String(input.value).replace(",", ".").replace(/[^\d.+-]/g, ""));
    return Number.isFinite(n) ? clampN(n, min, max) : null;
  };
  input.addEventListener("focus", () => {
    input.value = input.value.replace(unit || "\u0000", "");
    requestAnimationFrame(() => input.select());
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      input.dataset.cancel = "1";
      input.blur();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const cur = parse() ?? 0;
      const next = clampN(roundTo(cur + (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1), step), min, max);
      input.value = String(next);
      live?.(next);
    }
    e.stopPropagation();
  });
  input.addEventListener("blur", () => {
    if (input.dataset.cancel) {
      delete input.dataset.cancel;
      commit(null);
      return;
    }
    commit(parse());
  });
  return { input, fmt };
}

// Slider: label + value on one line, track underneath.
export function slider({ label, min = 0, max = 100, step = 1, value = 0, unit = "", decimals, defaultValue, onInput, onChange, tip }) {
  let v = value;
  const range = h("input", { type: "range", class: "ctl-range", min, max, step });
  range.value = v;
  const { input, fmt } = numberInput({
    value: v,
    min,
    max,
    step,
    unit,
    decimals,
    commit: (n) => {
      if (n === null) {
        input.value = fmt(v);
        return;
      }
      setV(n, true);
      onChange?.(v);
    },
    live: (n) => setV(n, false),
  });
  const lab = h("span", { class: "ctl-label", ...tipAttrs(tip) }, label);
  // The visible label names both inputs (the span's aria-label is the tip).
  if (typeof label === "string" && label) {
    range.setAttribute("aria-label", label);
    input.setAttribute("aria-label", label);
  }
  range.setAttribute("aria-valuetext", fmt(v));
  const el = h("div", { class: "ctl ctl-slider" }, h("div", { class: "ctl-line" }, lab, input), range);
  const paint = () => {
    const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
    range.style.setProperty("--pct", `${pct}%`);
  };
  function setV(n, silent = true) {
    v = clampN(n, min, max);
    range.value = v;
    range.setAttribute("aria-valuetext", fmt(v));
    if (document.activeElement !== input) input.value = fmt(v);
    paint();
    if (!silent) onInput?.(v);
  }
  range.addEventListener("input", () => setV(Number(range.value), false));
  range.addEventListener("change", () => onChange?.(v));
  // Browsers keep focus on a range after it is dragged, and a focused field
  // keeps plain keys (Delete, tool letters, Space) from the canvas. A slider
  // moved with the pointer lets go of focus once the press ends; one reached
  // with Tab keeps it, with its arrow keys.
  range.addEventListener("pointerdown", () => {
    const up = () => {
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      setTimeout(() => {
        if (document.activeElement === range) range.blur();
      }, 0);
    };
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
  });
  scrub(lab, { get: () => v, set: setV, step, min, max, onEnd: () => onChange?.(v) });
  lab.addEventListener("dblclick", () => {
    if (defaultValue === undefined) return;
    setV(defaultValue, false);
    onChange?.(v);
  });
  paint();
  Object.defineProperty(el, "value", { get: () => v, set: (n) => setV(n, true) });
  el.set = (n) => setV(n, true);
  el.setDisabled = (b) => {
    el.classList.toggle("disabled", !!b);
    range.disabled = input.disabled = !!b;
  };
  return el;
}

// Compact numeric field. The label (or icon) is the scrub handle.
export function number({ label, icon: iconName, value = 0, min = -1e6, max = 1e6, step = 1, unit = "", decimals, onInput, onChange, tip, width }) {
  let v = value;
  const { input, fmt } = numberInput({
    value: v,
    min,
    max,
    step,
    unit,
    decimals,
    commit: (n) => {
      if (n === null) {
        input.value = fmt(v);
        return;
      }
      const changed = n !== v;
      setV(n, true);
      if (changed) onChange?.(v);
      else input.value = fmt(v);
    },
    live: (n) => {
      setV(n, false);
    },
  });
  const handle = h("span", { class: "ctl-num-label", ...tipAttrs(tip) }, iconName ? icon(iconName, { size: "sm" }) : label);
  const el = h("label", { class: "ctl ctl-number", style: width ? { width: typeof width === "number" ? `${width}px` : width } : null }, handle, input);
  function setV(n, silent = true) {
    v = clampN(n, min, max);
    if (document.activeElement !== input) input.value = fmt(v);
    if (!silent) onInput?.(v);
  }
  scrub(handle, { get: () => v, set: setV, step, min, max, onEnd: () => onChange?.(v) });
  Object.defineProperty(el, "value", { get: () => v, set: (n) => setV(n, true) });
  el.set = (n) => setV(n, true);
  el.setDisabled = (b) => {
    el.classList.toggle("disabled", !!b);
    input.disabled = !!b;
  };
  return el;
}

// On/off switch. With a label it renders as a full row.
export function toggle({ label, value = false, onChange, tip, small }) {
  let v = !!value;
  const sw = h("button", { type: "button", class: ["ctl-switch", small && "sm"], role: "switch", ...tipAttrs(tip || label) }, h("span", { class: "knob" }));
  const el = label ? h("div", { class: "ctl ctl-toggle" }, h("span", { class: "ctl-label" }, label), sw) : sw;
  const paint = () => {
    sw.setAttribute("aria-checked", String(v));
    sw.classList.toggle("on", v);
  };
  sw.addEventListener("click", (e) => {
    e.stopPropagation();
    v = !v;
    paint();
    onChange?.(v);
  });
  if (label) el.querySelector(".ctl-label").addEventListener("click", () => sw.click());
  paint();
  Object.defineProperty(el, "value", {
    get: () => v,
    set: (b) => {
      v = !!b;
      paint();
    },
  });
  el.set = (b) => (el.value = b);
  el.setDisabled = (b) => {
    sw.disabled = !!b;
    el.classList.toggle("disabled", !!b);
  };
  return el;
}

// Segmented buttons. options: [{ value, label?, icon?, tip? }]
export function segmented({ options, value, onChange, size, full }) {
  let v = value;
  const el = h("div", { class: ["ctl-seg", size, full && "full"], role: "radiogroup" });
  const btns = options.map((o) => {
    const b = h(
      "button",
      { type: "button", class: "seg", role: "radio", ...tipAttrs(o.tip || (o.icon ? o.label : null), o.kbd) },
      o.icon ? icon(o.icon, { size: "sm" }) : null,
      o.icon && !o.showLabel ? null : o.label
    );
    b.addEventListener("click", () => {
      if (v === o.value) return;
      v = o.value;
      paint();
      onChange?.(v);
    });
    el.append(b);
    return [o.value, b];
  });
  const paint = () => {
    for (const [val, b] of btns) {
      b.classList.toggle("on", val === v);
      b.setAttribute("aria-checked", String(val === v));
    }
  };
  paint();
  Object.defineProperty(el, "value", {
    get: () => v,
    set: (n) => {
      v = n;
      paint();
    },
  });
  el.set = (n) => (el.value = n);
  el.setDisabled = (b) => btns.forEach(([, x]) => (x.disabled = !!b));
  return el;
}

export function select({ options, value, onChange, tip }) {
  const el = h("select", { class: "ctl-select", ...tipAttrs(tip) }, options.map((o) => h("option", { value: o.value }, o.label)));
  el.value = value;
  el.addEventListener("change", () => onChange?.(el.value));
  el.set = (n) => (el.value = n);
  el.setDisabled = (b) => (el.disabled = !!b);
  return el;
}

export function button({ label, icon: iconName, kind, onClick, tip, kbd, wide, big, disabled }) {
  const el = h(
    "button",
    { type: "button", class: ["btn", kind, wide && "wide", big && "big"], disabled, ...tipAttrs(tip, kbd) },
    iconName ? icon(iconName, { size: "sm" }) : null,
    label ? h("span", null, label) : null
  );
  if (onClick) el.addEventListener("click", onClick);
  el.setDisabled = (b) => (el.disabled = !!b);
  el.setLabel = (t) => {
    const s = el.querySelector("span");
    if (s) s.textContent = t;
  };
  return el;
}

export function iconButton({ icon: iconName, tip, kbd, onClick, active, size, disabled }) {
  const el = h("button", { type: "button", class: ["icon-btn", size], disabled, ...tipAttrs(tip, kbd) }, icon(iconName, { size: size === "sm" ? "sm" : undefined }));
  if (active !== undefined) el.setAttribute("aria-pressed", String(!!active));
  if (onClick) el.addEventListener("click", onClick);
  el.setActive = (b) => el.setAttribute("aria-pressed", String(!!b));
  el.setDisabled = (b) => (el.disabled = !!b);
  return el;
}

// Colour chip button. Supports "#rrggbb" and "#rrggbbaa". Shows a checkerboard
// under translucent colours.
export function swatch({ value = "#ffffff", onClick, tip, size }) {
  let v = value;
  const fill = h("span", { class: "fill" });
  const el = h("button", { type: "button", class: ["ctl-swatch", size], ...tipAttrs(tip) }, fill);
  const paint = () => {
    fill.style.background = v || "transparent";
    el.classList.toggle("none", !v);
  };
  if (onClick) el.addEventListener("click", (e) => onClick(e, el));
  paint();
  Object.defineProperty(el, "value", {
    get: () => v,
    set: (n) => {
      v = n;
      paint();
    },
  });
  el.set = (n) => (el.value = n);
  return el;
}

// Labelled row: field("Size", number(...))
export function field(label, ...controls) {
  return h("div", { class: "ctl-field" }, h("span", { class: "ctl-label" }, label), h("div", { class: "ctl-field-body" }, controls));
}

export function row(...children) {
  return h("div", { class: "ctl-row" }, children);
}

// Inspector section. With `toggle`, the header carries an on/off switch and the
// body collapses when off (Stroke, Shadow, Glow, Outline).
export function section({ title, open = true, collapsible = true, actions = [], toggle: tg, id }) {
  const body = h("div", { class: "sec-body" });
  const head = h("div", { class: "sec-head" });
  const titleEl = h("button", { type: "button", class: "sec-title", "aria-expanded": String(open) }, collapsible ? icon("chevron-down", { size: "sm", class: "sec-chev" }) : null, h("span", null, title));
  head.append(titleEl, h("div", { class: "sec-actions" }, actions));
  const el = h("section", { class: "sec", dataset: id ? { sec: id } : undefined }, head, body);
  let isOpen = open;
  let sw = null;
  const paint = () => {
    const on = sw ? sw.value : true;
    el.classList.toggle("closed", !isOpen || !on);
    el.classList.toggle("off", !on);
    titleEl.setAttribute("aria-expanded", String(isOpen && on));
  };
  if (tg) {
    sw = toggle({
      value: tg.value,
      small: true,
      tip: tg.tip || `${title} on or off`,
      onChange: (b) => {
        if (b) isOpen = true;
        paint();
        tg.onChange?.(b);
      },
    });
    head.querySelector(".sec-actions").append(sw);
  }
  if (collapsible)
    titleEl.addEventListener("click", () => {
      if (sw && !sw.value) {
        sw.click();
        return;
      }
      isOpen = !isOpen;
      paint();
    });
  paint();
  return {
    el,
    body,
    head,
    setOpen(b) {
      isOpen = !!b;
      paint();
    },
    setOn(b) {
      if (sw) {
        sw.value = b;
        paint();
      }
    },
  };
}
