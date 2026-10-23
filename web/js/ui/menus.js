// Every floating layer of the UI: toasts, menus, popovers, dialogs, confirm,
// prompt and the [data-tip] tooltip system. createUI(ctx, roots) returns the
// methods main.js puts on ctx.ui.
//
// Layers stack: Escape closes the topmost one, a click outside closes menus and
// popovers (not dialogs), and dialogs trap focus and make the rest of the page
// inert until they close.

import { h, clear, isMac } from "./dom.js";
import { icon } from "./icons.js";

// ---- placement (pure) -----------------------------------------------------------

const OPPOSITE = { top: "bottom", bottom: "top", left: "right", right: "left" };

// Where to put a floating box of `size` next to `anchor` ({ x, y, w, h }) inside
// `viewport` ({ w, h }). placement: "bottom" | "top" | "left" | "right", with an
// optional "-start" or "-end". Flips to the other side when the preferred side
// lacks room, then clamps so the box stays on screen.
export function placeFloating(anchor, size, viewport, { placement = "bottom", gap = 8, margin = 8 } = {}) {
  const [side0, align = "center"] = String(placement).split("-");
  const side = OPPOSITE[side0] ? side0 : "bottom";
  const a = { x: anchor.x, y: anchor.y, w: anchor.w || 0, h: anchor.h || 0 };
  const room = {
    top: a.y - gap - margin,
    bottom: viewport.h - (a.y + a.h) - gap - margin,
    left: a.x - gap - margin,
    right: viewport.w - (a.x + a.w) - gap - margin,
  };
  const need = side === "top" || side === "bottom" ? size.h : size.w;
  let use = side;
  if (room[side] < need) {
    const other = OPPOSITE[side];
    if (room[other] >= need || room[other] > room[side]) use = other;
  }
  let x;
  let y;
  const vertical = use === "top" || use === "bottom";
  if (vertical) {
    y = use === "bottom" ? a.y + a.h + gap : a.y - gap - size.h;
    x = align === "start" ? a.x : align === "end" ? a.x + a.w - size.w : a.x + a.w / 2 - size.w / 2;
  } else {
    x = use === "right" ? a.x + a.w + gap : a.x - gap - size.w;
    y = align === "start" ? a.y : align === "end" ? a.y + a.h - size.h : a.y + a.h / 2 - size.h / 2;
  }
  x = Math.max(margin, Math.min(x, viewport.w - margin - size.w));
  y = Math.max(margin, Math.min(y, viewport.h - margin - size.h));
  return { x: Math.round(x), y: Math.round(y), placement: `${use}${align === "center" ? "" : `-${align}`}`, side: use };
}

// "Ctrl+Shift+Z" -> ["Ctrl", "Shift", "Z"]; "Ctrl++" -> ["Ctrl", "+"]; mac labels stay whole.
export function splitKeys(label) {
  if (!label) return [];
  if (isMac) return [label];
  return String(label).split(/\+(?=.)/);
}

export function kbdNodes(label) {
  return splitKeys(label).map((k) => h("kbd", null, k));
}

// ---- helpers --------------------------------------------------------------------

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

function anchorRect(anchor) {
  if (!anchor) return { x: innerWidth / 2, y: innerHeight / 2, w: 0, h: 0 };
  if (anchor instanceof Element) {
    const r = anchor.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }
  return { x: anchor.x ?? anchor.left ?? 0, y: anchor.y ?? anchor.top ?? 0, w: anchor.w ?? anchor.width ?? 0, h: anchor.h ?? anchor.height ?? 0 };
}

function viewport() {
  return { w: document.documentElement.clientWidth || innerWidth, h: document.documentElement.clientHeight || innerHeight };
}

const later = (fn, ms) => setTimeout(fn, ms);

let uid = 0;
const nextId = (p) => `${p}-${++uid}`;

// ---- the UI service ---------------------------------------------------------------

export function createUI(ctx, roots = {}) {
  const root = {
    toast: roots.toast || document.getElementById("toast-root") || document.body,
    menu: roots.menu || document.getElementById("menu-root") || document.body,
    modal: roots.modal || document.getElementById("modal-root") || document.body,
    tip: roots.tip || document.getElementById("tip-root") || document.body,
  };
  const stack = []; // { kind, el, close, modal, anchor, dismiss }
  const inertReasons = new Map(); // element -> Set of reasons
  let lastOutsideClose = { anchor: null, at: 0 };

  // ---- inert background while a modal is open

  function setInert(el, reason, on) {
    if (!el) return;
    let set = inertReasons.get(el);
    if (!set) inertReasons.set(el, (set = new Set()));
    if (on) set.add(reason);
    else set.delete(reason);
    el.inert = set.size > 0;
  }

  function background() {
    return [document.getElementById("app"), document.getElementById("home")].filter(Boolean);
  }

  function syncModal() {
    const modal = stack.some((l) => l.modal);
    for (const el of background()) setInert(el, "modal", modal);
  }

  // ---- stack

  function pushLayer(layer) {
    stack.push(layer);
    syncModal();
    hideTip();
    return layer;
  }

  function dropLayer(layer) {
    const i = stack.indexOf(layer);
    if (i >= 0) stack.splice(i, 1);
    syncModal();
  }

  const top = () => stack[stack.length - 1] || null;

  function onKeyDownCapture(e) {
    if (e.key !== "Escape" || !stack.length) return;
    const t = top();
    if (t.escape === false) return;
    // The content may use Escape first (clear a typed search, revert a field).
    if (typeof t.onEscape === "function" && t.onEscape(e) === true) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    t.close("escape");
  }

  function onPointerDownCapture(e) {
    hideTip();
    for (let i = stack.length - 1; i >= 0; i--) {
      const l = stack[i];
      if (l.el.contains(e.target)) return;
      if (l.modal) return;
      const onAnchor = l.anchor instanceof Element && l.anchor.contains(e.target);
      if (onAnchor) lastOutsideClose = { anchor: l.anchor, at: performance.now() };
      l.close("outside");
    }
  }

  function reposition() {
    for (const l of stack) l.place?.();
  }

  let keyboardLast = false;
  window.addEventListener("keydown", (e) => {
    if (!["Shift", "Control", "Alt", "Meta"].includes(e.key)) keyboardLast = true;
  }, true);
  window.addEventListener("pointerdown", () => (keyboardLast = false), true);
  window.addEventListener("keydown", onKeyDownCapture, true);
  window.addEventListener("pointerdown", onPointerDownCapture, true);
  window.addEventListener("resize", reposition);
  window.addEventListener("scroll", (e) => {
    if (e.target === document || e.target === window) return;
    for (const l of stack) if (l.anchor instanceof Element && e.target.contains?.(l.anchor)) l.place?.();
  }, true);

  // True when the click that opens this layer is the same click that just
  // closed it (clicking the anchor again toggles it shut).
  const deadHandle = () => ({ el: h("div"), closed: true, close() {}, place() {}, focusFirst() {} });

  function justClosedBy(anchor) {
    return anchor instanceof Element && lastOutsideClose.anchor === anchor && performance.now() - lastOutsideClose.at < 400;
  }

  // ---- floating positioning

  function placeEl(el, anchor, placement, gap) {
    // Layout size, not the bounding box: the pop-in animation scales it.
    const r = { width: el.offsetWidth, height: el.offsetHeight };
    const a = anchor instanceof Element && !anchor.isConnected ? el._lastAnchor || anchorRect(null) : anchorRect(anchor);
    el._lastAnchor = a;
    const pos = placeFloating(a, { w: r.width, h: r.height }, viewport(), { placement, gap });
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
    el.dataset.side = pos.side;
    return pos;
  }

  function animateOut(el, done) {
    el.classList.add("closing");
    later(() => {
      el.remove();
      done?.();
    }, 140);
  }

  // ---- toasts ------------------------------------------------------------------

  const toasts = new Map(); // key -> handle
  const TOAST_ICONS = { info: "info", ok: "check-circle", warn: "alert-triangle", error: "alert-circle" };

  function toast(message, opts = {}) {
    const key = opts.id || null;
    if (key && toasts.has(key)) {
      const t = toasts.get(key);
      t.update(message, opts);
      return t;
    }
    const kind = TOAST_ICONS[opts.kind] ? opts.kind : "info";
    const text = h("span", { class: "toast-text" }, String(message ?? ""));
    const iconWrap = h("span", { class: "toast-icon" }, icon(TOAST_ICONS[kind], { size: "sm" }));
    const actions = h("span", { class: "toast-actions" });
    const closeBtn = h("button", { type: "button", class: "toast-close", "aria-label": "Dismiss" }, icon("x", { size: "sm" }));
    const el = h("div", { class: ["toast", kind], role: kind === "error" ? "alert" : "status" }, iconWrap, text, actions, closeBtn);
    let timer = 0;
    let closed = false;
    let timeout = 0;

    const handle = {
      el,
      close() {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        if (key) toasts.delete(key);
        animateOut(el);
        opts.onClose?.();
      },
      update(msg, o = {}) {
        if (msg !== undefined && msg !== null) text.textContent = String(msg);
        if (o.kind && TOAST_ICONS[o.kind]) {
          el.classList.remove("info", "ok", "warn", "error");
          el.classList.add(o.kind);
          iconWrap.replaceChildren(icon(TOAST_ICONS[o.kind], { size: "sm" }));
        }
        if ("action" in o) setAction(o.action);
        if ("progress" in o) setProgress(o.progress);
        if ("timeout" in o || o.kind) arm(o.timeout ?? defaultTimeout(o.kind || kind, o.action));
        return handle;
      },
    };

    function setAction(action) {
      clear(actions);
      if (!action) return;
      const list = Array.isArray(action) ? action : [action];
      for (const a of list) {
        if (!a?.label) continue;
        actions.append(
          h("button", {
            type: "button",
            class: "toast-action",
            onClick: () => {
              handle.close();
              try {
                a.run?.();
              } catch (err) {
                console.error(err);
              }
            },
          }, a.label),
        );
      }
    }

    let bar = null;
    function setProgress(p) {
      if (p == null) {
        bar?.remove();
        bar = null;
        return;
      }
      if (!bar) {
        bar = h("span", { class: "toast-progress" }, h("span"));
        el.append(bar);
      }
      bar.firstChild.style.width = `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`;
    }

    function arm(ms) {
      clearTimeout(timer);
      timeout = ms;
      if (ms > 0) timer = setTimeout(handle.close, ms);
    }

    closeBtn.addEventListener("click", handle.close);
    el.addEventListener("pointerenter", () => clearTimeout(timer));
    el.addEventListener("pointerleave", () => arm(timeout));
    setAction(opts.action);
    if (opts.progress != null) setProgress(opts.progress);
    root.toast.append(el);
    if (key) toasts.set(key, handle);
    const shown = root.toast.querySelectorAll(".toast:not(.closing)");
    if (shown.length > 4) shown[0].querySelector(".toast-close")?.click();
    arm(opts.timeout ?? defaultTimeout(kind, opts.action));
    return handle;
  }

  function defaultTimeout(kind, action) {
    if (kind === "error") return 7000;
    if (action) return 6000;
    if (kind === "warn") return 5000;
    return 3200;
  }

  // ---- menus -----------------------------------------------------------------------

  // items: { label, icon, kbd, run, disabled, danger, checked, hint, submenu } | "-" | { heading }
  function menu(items, opts = {}) {
    const anchor = opts.anchor || null;
    if (justClosedBy(anchor)) return deadHandle();
    const point = anchor ? null : { x: opts.x ?? innerWidth / 2, y: opts.y ?? innerHeight / 2, w: 0, h: 0 };
    const placement = opts.placement || (anchor ? "bottom-start" : "right-start");
    const prevFocus = document.activeElement;
    const el = h("div", { class: ["menu", opts.class], role: "menu", tabindex: "-1" });
    if (opts.minWidth) el.style.minWidth = `${opts.minWidth}px`;
    const rows = [];
    let active = -1;
    let child = null;
    let closed = false;

    for (const it of items || []) {
      if (!it) continue;
      if (it === "-") {
        if (el.lastChild && !el.lastChild.classList.contains("menu-sep")) el.append(h("div", { class: "menu-sep", role: "separator" }));
        continue;
      }
      if (it.heading) {
        el.append(h("div", { class: "menu-heading micro" }, it.heading));
        continue;
      }
      const leading = it.checked ? icon("check", { size: "sm" }) : it.icon ? icon(it.icon, { size: "sm" }) : h("span", { class: "menu-icon-space" });
      const row = h(
        "button",
        {
          type: "button",
          class: ["menu-item", it.danger && "danger", it.checked && "checked"],
          role: it.checked !== undefined ? "menuitemcheckbox" : "menuitem",
          "aria-checked": it.checked !== undefined ? String(!!it.checked) : undefined,
          "aria-disabled": it.disabled ? "true" : undefined,
          tabindex: "-1",
        },
        leading,
        h("span", { class: "menu-label" }, it.label),
        it.hint ? h("span", { class: "menu-hint" }, it.hint) : null,
        it.kbd ? h("span", { class: "menu-kbd" }, it.kbd) : null,
        it.submenu ? icon("chevron-right", { size: "sm", class: "menu-sub" }) : null,
      );
      const index = rows.length;
      rows.push({ row, it });
      row.addEventListener("pointermove", () => {
        if (active !== index) setActive(index, false);
        if (it.submenu && !it.disabled) openChild(index);
        else if (child) closeChild();
      });
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        activate(index);
      });
      el.append(row);
    }
    if (el.lastChild?.classList.contains("menu-sep")) el.lastChild.remove();

    function setActive(i, focus = true) {
      active = i;
      rows.forEach((r, j) => r.row.classList.toggle("active", j === i));
      if (focus && rows[i]) rows[i].row.focus({ preventScroll: true });
      rows[i]?.row.scrollIntoView?.({ block: "nearest" });
    }

    function move(dir) {
      if (!rows.length) return;
      let i = active;
      for (let n = 0; n < rows.length; n++) {
        i = (i + dir + rows.length) % rows.length;
        if (!rows[i].it.disabled) break;
      }
      setActive(i);
    }

    function openChild(i) {
      const { row, it } = rows[i];
      if (child?.anchorRow === row) return;
      closeChild();
      child = menu(it.submenu, { anchor: row, placement: "right-start", parent: handle });
      if (child) child.anchorRow = row;
    }

    function closeChild() {
      child?.close("parent");
      child = null;
    }

    function activate(i) {
      const r = rows[i];
      if (!r || r.it.disabled) return;
      if (r.it.submenu) {
        openChild(i);
        child?.focusFirst?.();
        return;
      }
      closeAll();
      try {
        r.it.run?.();
      } catch (err) {
        console.error(err);
        toast(err.message || "That did not work.", { kind: "error" });
      }
    }

    function closeAll() {
      let p = handle;
      while (p.parent) p = p.parent;
      p.close("select");
    }

    el.addEventListener("keydown", (e) => {
      const k = e.key;
      if (k === "ArrowDown") move(1);
      else if (k === "ArrowUp") move(-1);
      else if (k === "Home") setActive(rows.findIndex((r) => !r.it.disabled));
      else if (k === "End") setActive(rows.length - 1 - [...rows].reverse().findIndex((r) => !r.it.disabled));
      else if (k === "Enter" || k === " ") {
        if (active >= 0) activate(active);
      } else if (k === "ArrowRight") {
        if (active >= 0 && rows[active].it.submenu) {
          openChild(active);
          child?.focusFirst?.();
        }
      } else if (k === "ArrowLeft") {
        if (opts.parent) handle.close("back");
      } else if (k === "Tab") {
        closeAll();
      } else if (k.length === 1 && /\S/.test(k)) {
        const start = active + 1;
        for (let n = 0; n < rows.length; n++) {
          const j = (start + n) % rows.length;
          if (!rows[j].it.disabled && rows[j].it.label?.toLowerCase().startsWith(k.toLowerCase())) {
            setActive(j);
            break;
          }
        }
      } else return;
      e.preventDefault();
      e.stopPropagation();
    });

    const handle = {
      el,
      parent: opts.parent || null,
      close(reason) {
        if (closed) return;
        closed = true;
        closeChild();
        dropLayer(layer);
        animateOut(el);
        if (!opts.parent && reason !== "outside" && prevFocus?.isConnected) prevFocus.focus?.({ preventScroll: true });
        if (opts.parent && reason === "back") opts.parent.el?.focus?.();
        opts.onClose?.(reason);
      },
      focusFirst() {
        move(1);
      },
    };
    const layer = { kind: "menu", el, close: handle.close, modal: false, anchor: opts.parent ? null : anchor, place: () => placeEl(el, anchor || point, placement, anchor ? 6 : 2) };
    if (opts.parent) layer.anchor = anchor;
    root.menu.append(el);
    pushLayer(layer);
    layer.place();
    el.focus({ preventScroll: true });
    if (opts.keyboard ?? keyboardLast) move(1);
    return handle;
  }

  // ---- popovers ----------------------------------------------------------------------

  function popover(anchor, content, opts = {}) {
    if (justClosedBy(anchor)) return deadHandle();
    const prevFocus = document.activeElement;
    const el = h("div", { class: ["popover", opts.class], role: opts.role || "dialog", tabindex: "-1" }, content);
    if (opts.width) el.style.width = typeof opts.width === "number" ? `${opts.width}px` : opts.width;
    let closed = false;
    const placement = opts.placement || "bottom";
    const handle = {
      el,
      close(reason) {
        if (closed) return;
        closed = true;
        dropLayer(layer);
        ro?.disconnect();
        animateOut(el);
        if (reason === "escape" && prevFocus?.isConnected) prevFocus.focus?.({ preventScroll: true });
        opts.onClose?.(reason);
      },
      place: () => placeEl(el, anchor, placement, opts.gap ?? 8),
    };
    const layer = { kind: "popover", el, close: handle.close, modal: false, anchor, place: handle.place, onEscape: opts.onEscape };
    root.menu.append(el);
    pushLayer(layer);
    handle.place();
    // Content that grows (a section opening) keeps the popover on screen.
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => !closed && handle.place()) : null;
    ro?.observe(el);
    // Focus moves in when asked, when the content has an [autofocus] element, or
    // when the popover was opened from the keyboard. Mouse users keep their focus
    // (an inline text edit must not lose it to a font or colour popover).
    if (opts.focus !== false) {
      const auto = el.querySelector("[autofocus]");
      const first = opts.focus === true || keyboardLast ? auto || focusables(el)[0] || el : auto;
      first?.focus({ preventScroll: true });
    }
    return handle;
  }

  // ---- dialogs ------------------------------------------------------------------------

  // actions: [{ label, kind: "primary"|"danger"|"ghost", run(handle) -> false keeps it open, disabled, icon, autofocus }]
  function dialog({ title, body, actions = [], wide = false, onClose, dismissable = true, className, description } = {}) {
    const prevFocus = document.activeElement;
    const titleId = nextId("dlg-title");
    const bodyEl = h("div", { class: "dialog-body" }, body || null);
    const closeBtn = h("button", { type: "button", class: "icon-btn sm dialog-x", "aria-label": "Close", "data-tip": "Close", "data-kbd": "Esc" }, icon("x", { size: "sm" }));
    const head = h(
      "header",
      { class: "dialog-head" },
      h("div", { class: "dialog-titles" }, h("h2", { id: titleId, class: "dialog-title" }, title || ""), description ? h("p", { class: "dialog-desc" }, description) : null),
      dismissable ? closeBtn : null,
    );
    const foot = h("footer", { class: "dialog-foot" });
    const panel = h("div", { class: ["dialog", wide && "wide", className], role: "dialog", "aria-modal": "true", "aria-labelledby": titleId, tabindex: "-1" }, head, bodyEl);
    const backdrop = h("div", { class: "dialog-backdrop" }, panel);
    let closed = false;

    const buttons = actions.filter(Boolean).map((a) => {
      const b = h(
        "button",
        { type: "button", class: ["btn", a.kind || (a.primary ? "primary" : null)], disabled: !!a.disabled },
        a.icon ? icon(a.icon, { size: "sm" }) : null,
        h("span", null, a.label),
      );
      b.addEventListener("click", async () => {
        if (b.disabled) return;
        let r;
        try {
          b.classList.add("busy");
          r = a.run ? a.run(handle) : undefined;
          if (r && typeof r.then === "function") {
            buttons.forEach((x) => (x.disabled = true));
            r = await r;
          }
        } catch (err) {
          console.error(err);
          toast(err.message || "That did not work.", { kind: "error" });
          r = false;
        } finally {
          b.classList.remove("busy");
          if (!closed) buttons.forEach((x, i) => (x.disabled = !!actions.filter(Boolean)[i].disabled));
        }
        if (r !== false) handle.close("action");
      });
      b._action = a;
      return b;
    });
    if (buttons.length) {
      foot.append(...buttons);
      panel.append(foot);
    }

    const handle = {
      el: panel,
      body: bodyEl,
      buttons,
      close(reason = "close") {
        if (closed) return;
        closed = true;
        dropLayer(layer);
        backdrop.classList.add("closing");
        later(() => backdrop.remove(), 160);
        if (prevFocus?.isConnected) prevFocus.focus?.({ preventScroll: true });
        onClose?.(reason);
      },
      setTitle(t) {
        head.querySelector(".dialog-title").textContent = t;
      },
    };

    closeBtn.addEventListener("click", () => handle.close("close"));
    let downOnBackdrop = false;
    backdrop.addEventListener("pointerdown", (e) => (downOnBackdrop = e.target === backdrop));
    backdrop.addEventListener("click", (e) => {
      if (dismissable && downOnBackdrop && e.target === backdrop) handle.close("backdrop");
      downOnBackdrop = false;
    });
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Tab") {
        const list = focusables(panel);
        if (!list.length) {
          e.preventDefault();
          return;
        }
        const first = list[0];
        const last = list[list.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });

    const layer = { kind: "dialog", el: panel, close: handle.close, modal: true, escape: dismissable };
    root.modal.append(backdrop);
    pushLayer(layer);
    const auto = panel.querySelector("[autofocus]") || buttons.find((b) => b._action.autofocus) || bodyEl.querySelector("input, textarea, select") || buttons.find((b) => b.classList.contains("primary")) || panel;
    later(() => !closed && auto.focus({ preventScroll: true }), 0);
    return handle;
  }

  function confirm({ title = "Are you sure?", message = "", ok = "OK", cancel = "Cancel", danger = false, body } = {}) {
    return new Promise((resolve) => {
      let result = false;
      dialog({
        title,
        body: body || (message ? h("p", { class: "dialog-message" }, message) : null),
        className: "confirm",
        actions: [
          { label: cancel, kind: "ghost", autofocus: danger },
          {
            label: ok,
            kind: danger ? "danger-solid" : "primary",
            autofocus: !danger,
            run: () => {
              result = true;
            },
          },
        ],
        onClose: () => resolve(result),
      });
    });
  }

  function prompt({ title = "Name", message = "", value = "", placeholder = "", ok = "Save", cancel = "Cancel", maxLength = 200 } = {}) {
    return new Promise((resolve) => {
      let result = null;
      const input = h("input", { type: "text", class: "input prompt-input", placeholder, maxlength: String(maxLength), spellcheck: "false", autocomplete: "off" });
      input.value = value;
      const submit = () => {
        result = input.value.trim() || null;
        d.close("action");
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submit();
        }
      });
      const d = dialog({
        title,
        className: "prompt",
        body: h("div", { class: "prompt-body" }, message ? h("p", { class: "dialog-message" }, message) : null, input),
        actions: [
          { label: cancel, kind: "ghost" },
          { label: ok, kind: "primary", run: () => (result = input.value.trim() || null) },
        ],
        onClose: () => resolve(result),
      });
      later(() => {
        input.focus();
        input.select();
      }, 10);
    });
  }

  // ---- tooltips ------------------------------------------------------------------------

  const tipEl = h("div", { class: "tip", role: "tooltip", hidden: true });
  root.tip.append(tipEl);
  let tipTarget = null;
  let tipTimer = 0;
  let tipShown = false;
  let lastHide = 0;

  function tipContent(target) {
    const text = target.getAttribute("data-tip");
    if (!text) return null;
    let kbd = target.getAttribute("data-kbd");
    const cmd = target.getAttribute("data-cmd");
    if (!kbd && cmd && ctx.commands?.keysLabel) kbd = ctx.commands.keysLabel(cmd);
    return [h("span", { class: "tip-text" }, text), kbd ? h("span", { class: "tip-keys" }, kbdNodes(kbd)) : null];
  }

  function showTip(target) {
    if (!target?.isConnected || stack.some((l) => l.kind === "menu")) return;
    const content = tipContent(target);
    if (!content) return;
    tipEl.replaceChildren(...content.filter(Boolean));
    tipEl.hidden = false;
    tipEl.classList.remove("in");
    const place = target.getAttribute("data-tip-place") || target.closest("[data-tip-place]")?.getAttribute("data-tip-place") || "top";
    placeEl(tipEl, target, place, 8);
    void tipEl.offsetWidth;
    tipEl.classList.add("in");
    tipShown = true;
  }

  function hideTip() {
    clearTimeout(tipTimer);
    if (tipShown) lastHide = performance.now();
    tipShown = false;
    tipTarget = null;
    tipEl.hidden = true;
    tipEl.classList.remove("in");
  }

  function scheduleTip(target) {
    clearTimeout(tipTimer);
    const instant = tipShown || performance.now() - lastHide < 500;
    tipTarget = target;
    if (instant) {
      tipShown = false;
      showTip(target);
    } else {
      tipTimer = setTimeout(() => tipTarget === target && showTip(target), 450);
    }
  }

  document.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch" || e.buttons) return;
    const t = e.target.closest?.("[data-tip]");
    if (t === tipTarget) return;
    if (!t) {
      if (tipTarget) hideTip();
      return;
    }
    scheduleTip(t);
  });
  document.addEventListener("pointerout", (e) => {
    if (!tipTarget) return;
    if (e.relatedTarget && tipTarget.contains(e.relatedTarget)) return;
    if (e.relatedTarget?.closest?.("[data-tip]")) return;
    hideTip();
  });
  document.addEventListener("focusin", (e) => {
    const t = e.target.closest?.("[data-tip]");
    if (t && t.matches(":focus-visible")) scheduleTip(t);
  });
  document.addEventListener("focusout", () => tipTarget && !tipTarget.matches(":hover") && hideTip());
  window.addEventListener("keydown", (e) => {
    if (tipShown && !["Shift", "Control", "Alt", "Meta", "Tab"].includes(e.key)) hideTip();
  }, true);
  window.addEventListener("wheel", () => tipShown && hideTip(), { passive: true, capture: true });
  window.addEventListener("blur", hideTip);

  // ---- public ----------------------------------------------------------------------------

  return {
    toast,
    menu,
    popover,
    dialog,
    confirm,
    prompt,
    hideTip,
    pushLayer,
    dropLayer,
    // Open floating layers, bottom to top.
    layers: () => stack.slice(),
    topLayer: top,
    // A dialog, the palette or a menu is open: global shortcuts stay quiet.
    isBlocking: () => stack.some((l) => l.modal || l.kind === "menu"),
    setInert,
  };
}
