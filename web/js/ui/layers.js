// Layers panel (SPEC 10): top-to-bottom list with live thumbnails, inline
// rename, eye and lock toggles, drag to reorder with a lime drop line, click
// to select (Shift for a range, Ctrl or Cmd to toggle) and hover highlights
// on the canvas.

import { h, disposer, isMac } from "./dom.js";
import { icon } from "./icons.js";
import { iconButton } from "./controls.js";
import { renderLayerThumb } from "../core/render.js";
import { fontString, displayText } from "../core/textlayout.js";
import { parseHex } from "./colorpicker.js";
import { ensureIcons } from "./inspector.js";

const THUMB_W = 34;
const THUMB_H = 26;
const THUMB_EVERY = 140; // ms between thumbnail passes
const DRAG_START = 4;

// ---- pure helpers (tested in tests/inspector-layers.test.js) ----------------------

// docIds: bottom -> top. gap: an insertion point in the panel's top -> bottom
// list (0 = above the first row, n = below the last). Returns the new doc order.
export function moveToGap(docIds, moving, gap) {
  const panel = docIds.slice().reverse();
  const set = new Set(moving);
  const block = panel.filter((id) => set.has(id));
  if (!block.length) return docIds.slice();
  const g = Math.max(0, Math.min(panel.length, Math.round(gap)));
  const before = panel.slice(0, g).filter((id) => set.has(id)).length;
  const rest = panel.filter((id) => !set.has(id));
  const at = g - before;
  rest.splice(at, 0, ...block);
  return rest.reverse();
}

// Ids from a to b inclusive in list order (either direction).
export function rangeIds(list, a, b) {
  const i = list.indexOf(a);
  const j = list.indexOf(b);
  if (i < 0 || j < 0) return j >= 0 ? [b] : [];
  const [lo, hi] = i < j ? [i, j] : [j, i];
  return list.slice(lo, hi + 1);
}

// The name a row shows: default-named text layers show their words.
export function displayName(layer) {
  if (layer?.type === "text" && (layer.name === "Text" || !layer.name)) {
    const words = String(layer.text || "").replace(/\s+/g, " ").trim();
    if (words) return words.length > 40 ? `${words.slice(0, 39)}…` : words;
  }
  return layer?.name || "Layer";
}

// Everything that changes a thumbnail (not position, name or flags).
export function thumbKey(layer) {
  const { x, y, name, hidden, locked, id, ...rest } = layer;
  return JSON.stringify(rest);
}

const sameOrder = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function luminance(hex) {
  const c = parseHex(hex || "");
  if (!c) return 1;
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
}

// ---- thumbnails -------------------------------------------------------------------

function drawTextThumb(g, l, w, ht) {
  const words = displayText(l).replace(/\s+/g, " ").trim();
  const glyphs = [...(words || "T")].slice(0, 2).join("");
  const size = ht * 0.7;
  g.font = fontString({ ...l, size }, size);
  g.textAlign = "center";
  g.textBaseline = "middle";
  const tw = g.measureText(glyphs).width;
  if (tw > w - 4) {
    const k = (w - 4) / tw;
    g.font = fontString({ ...l, size: size * k }, size * k);
  }
  let fill = l.color;
  if (l.gradient?.on) {
    const grad = g.createLinearGradient(0, 0, 0, ht);
    grad.addColorStop(0, l.gradient.from);
    grad.addColorStop(1, l.gradient.to);
    fill = grad;
  }
  const cx = w / 2;
  const cy = ht / 2 + 1;
  g.lineJoin = "round";
  if (l.stroke?.on && l.stroke.width > 0) {
    g.lineWidth = Math.max(1, Math.min(3, (l.stroke.width / Math.max(1, l.size)) * size * 2));
    g.strokeStyle = l.stroke.color;
    g.strokeText(glyphs, cx, cy);
  } else if (!l.gradient?.on && luminance(l.color) < 0.22) {
    // Dark text without a stroke still needs to read on the dark panel.
    g.lineWidth = 2;
    g.strokeStyle = "rgba(255, 255, 255, 0.55)";
    g.strokeText(glyphs, cx, cy);
  }
  g.fillStyle = fill;
  g.fillText(glyphs, cx, cy);
}

// ---- mount ----------------------------------------------------------------------

export function mountLayers(el, ctx) {
  ensureIcons();
  const store = ctx.store;
  const d = disposer();
  const rows = new Map(); // id -> row
  const dirty = new Set();
  let anchorId = null;
  let renaming = null;
  let drag = null;
  let thumbTimer = 0;
  let lastThumbs = 0;
  let hoverId = null;

  const count = h("span", { class: "lyr-count num" });
  const head = h("div", { class: "lyr-head" }, h("span", { class: "lyr-title" }, "Layers"), count);
  const rowsEl = h("div", { class: "lyr-rows" });
  const dropLine = h("div", { class: "lyr-drop", "aria-hidden": "true" });
  const list = h("div", { class: "lyr-list", role: "listbox", "aria-label": "Layers", "aria-multiselectable": "true", tabindex: "0" }, rowsEl, dropLine);
  const empty = h("div", { class: "lyr-empty" }, icon("layers", { size: "lg" }), h("p", null, "Layers show up here"));
  const root = h("div", { class: "lyr" }, head, list, empty);
  el.append(root);
  d(() => root.remove());

  const panelIds = () => store.layers().map((l) => l.id).reverse();

  // ---- rows ----

  function makeRow(id) {
    const canvas = h("canvas", { class: "lyr-thumb", "aria-hidden": "true" });
    const name = h("span", { class: "lyr-name" });
    const eye = iconButton({ icon: "eye", tip: "Hide", size: "sm" });
    const lock = iconButton({ icon: "unlock", tip: "Lock", size: "sm" });
    eye.classList.add("lyr-eye");
    lock.classList.add("lyr-lock");
    eye.tabIndex = -1;
    lock.tabIndex = -1;
    const elRow = h("div", { class: "lyr-row", role: "option", id: `lyr-${id}`, dataset: { id } }, h("span", { class: "lyr-thumb-wrap" }, canvas), name, h("span", { class: "lyr-btns" }, eye, lock));
    const row = { id, el: elRow, canvas, name, eye, lock, layer: null, key: null, flags: "" };
    eye.addEventListener("click", (e) => {
      e.stopPropagation();
      const l = store.get(id);
      if (l) store.patch(id, { hidden: !l.hidden }, { label: l.hidden ? "Show layer" : "Hide layer" });
    });
    lock.addEventListener("click", (e) => {
      e.stopPropagation();
      const l = store.get(id);
      if (l) store.patch(id, { locked: !l.locked }, { label: l.locked ? "Unlock layer" : "Lock layer" });
    });
    for (const b of [eye, lock]) b.addEventListener("dblclick", (e) => e.stopPropagation());
    return row;
  }

  function setBtn(btn, iconName, tip, pressed) {
    const flag = `${iconName}|${pressed}`;
    if (btn.dataset.flag === flag) return;
    btn.dataset.flag = flag;
    btn.replaceChildren(icon(iconName, { size: "sm" }));
    btn.dataset.tip = tip;
    btn.setAttribute("aria-label", tip);
    btn.setActive(pressed);
  }

  function paintRow(row, l, selected) {
    if (row.layer !== l) {
      if (renaming !== row.id) row.name.textContent = displayName(l);
      row.el.dataset.type = l.type;
      row.el.classList.toggle("is-hidden", !!l.hidden);
      row.el.classList.toggle("is-locked", !!l.locked);
      setBtn(row.eye, l.hidden ? "eye-off" : "eye", l.hidden ? "Show" : "Hide", !!l.hidden);
      setBtn(row.lock, l.locked ? "lock" : "unlock", l.locked ? "Unlock" : "Lock", !!l.locked);
      row.el.setAttribute("aria-label", `${displayName(l)}, ${l.type}${l.hidden ? ", hidden" : ""}${l.locked ? ", locked" : ""}`);
      row.layer = l;
      dirty.add(row.id);
    }
    row.el.classList.toggle("selected", selected);
    row.el.setAttribute("aria-selected", String(selected));
  }

  function sync() {
    const layers = store.layers();
    const sel = new Set(store.selection);
    for (const [id, row] of rows) {
      if (store.get(id)) continue;
      row.el.remove();
      rows.delete(id);
      dirty.delete(id);
    }
    const order = layers.map((l) => l.id).reverse();
    for (const l of layers) {
      let row = rows.get(l.id);
      if (!row) {
        row = makeRow(l.id);
        rows.set(l.id, row);
      }
      paintRow(row, l, sel.has(l.id));
    }
    const current = [...rowsEl.children].map((n) => n.dataset.id);
    if (!sameOrder(current, order)) rowsEl.replaceChildren(...order.map((id) => rows.get(id).el));
    const n = layers.length;
    count.textContent = n ? String(n) : "";
    root.classList.toggle("is-empty", n === 0);
    list.setAttribute("aria-activedescendant", store.selection.length ? `lyr-${store.selection[store.selection.length - 1]}` : "");
    if (dirty.size) scheduleThumbs();
  }

  // ---- thumbnails ----

  function scheduleThumbs() {
    if (thumbTimer) return;
    const wait = Math.max(16, THUMB_EVERY - (performance.now() - lastThumbs));
    thumbTimer = setTimeout(flushThumbs, wait);
  }

  function flushThumbs() {
    thumbTimer = 0;
    lastThumbs = performance.now();
    const dpr = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
    for (const id of dirty) {
      const row = rows.get(id);
      const l = store.get(id);
      if (!row || !l) continue;
      const key = thumbKey(l);
      if (key === row.key && row.dpr === dpr) continue;
      row.key = key;
      row.dpr = dpr;
      drawThumb(row, l, dpr);
    }
    dirty.clear();
  }

  function drawThumb(row, l, dpr) {
    const c = row.canvas;
    const cw = Math.round(THUMB_W * dpr);
    const ch = Math.round(THUMB_H * dpr);
    if (c.width !== cw) c.width = cw;
    if (c.height !== ch) c.height = ch;
    const g = c.getContext("2d");
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cw, ch);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    try {
      if (l.type === "text") drawTextThumb(g, l, THUMB_W, THUMB_H);
      else renderLayerThumb(g, { ...l, opacity: Math.max(0.35, l.opacity) }, { x: 0, y: 0, w: THUMB_W, h: THUMB_H, assets: ctx.assets, pad: 2 });
    } catch (err) {
      console.warn("Layers: could not draw a thumbnail.", err);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
  }

  const redrawWhere = (test) => {
    for (const [id, row] of rows) {
      const l = store.get(id);
      if (l && test(l)) {
        row.key = null;
        dirty.add(id);
      }
    }
    if (dirty.size) scheduleThumbs();
  };

  // ---- selection ----

  function selectRow(id, e) {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (e.shiftKey && anchorId && store.get(anchorId)) {
      const ids = rangeIds(panelIds(), anchorId, id);
      store.select(ids, { additive: mod });
      return;
    }
    if (mod) {
      store.select([id], { toggle: true });
      anchorId = id;
      return;
    }
    store.select([id]);
    anchorId = id;
  }

  // ---- drag to reorder ----

  function gapAt(clientY) {
    const els = [...rowsEl.children];
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return els.length;
  }

  function showDrop(gap) {
    const els = [...rowsEl.children];
    if (!els.length) return;
    const order = store.layers().map((l) => l.id);
    const next = moveToGap(order, drag.moving, gap);
    const changes = !sameOrder(order, next);
    dropLine.classList.toggle("on", changes);
    if (!changes) return;
    const y = gap < els.length ? els[gap].offsetTop : els[els.length - 1].offsetTop + els[els.length - 1].offsetHeight;
    dropLine.style.transform = `translateY(${Math.round(y - 1)}px)`;
  }

  function autoScroll() {
    if (!drag?.active) return;
    const r = list.getBoundingClientRect();
    const edge = 28;
    let v = 0;
    if (drag.y < r.top + edge) v = -Math.ceil((r.top + edge - drag.y) / 3);
    else if (drag.y > r.bottom - edge) v = Math.ceil((drag.y - (r.bottom - edge)) / 3);
    if (v) {
      list.scrollTop += v;
      showDrop(gapAt(drag.y));
    }
    drag.raf = setTimeout(autoScroll, 16);
  }

  function endDrag(apply) {
    if (!drag) return;
    const dr = drag;
    drag = null;
    clearTimeout(dr.raf);
    root.classList.remove("dragging");
    dropLine.classList.remove("on");
    for (const id of dr.moving) rows.get(id)?.el.classList.remove("moving");
    if (!apply || !dr.active) return;
    const order = store.layers().map((l) => l.id);
    const next = moveToGap(order, dr.moving, gapAt(dr.y));
    if (sameOrder(order, next)) return;
    if (dr.moving.length === 1) store.move(dr.moving[0], next.indexOf(dr.moving[0]), { label: "Reorder" });
    else {
      store.update(
        (doc) => {
          const byId = new Map(doc.layers.map((l) => [l.id, l]));
          doc.layers = next.map((id) => byId.get(id)).filter(Boolean);
        },
        { label: "Reorder" }
      );
    }
  }

  // A mouse click selects without moving keyboard focus into the list, so the
  // arrow keys keep nudging the layer (SPEC 10) instead of walking the list.
  // Tab still focuses the list for arrow-key navigation. (A press on the
  // list itself, which is its scrollbar, keeps the default.)
  list.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target === list || e.target.closest("button, input")) return;
    e.preventDefault();
  });

  list.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest("button, input")) return;
    // With focus no longer moving on a click, commit whatever field was being
    // edited (an inspector value, an open rename) before the selection changes.
    const ae = document.activeElement;
    if (ae && ae !== document.body && ae !== list) ae.blur?.();
    const rowEl = e.target.closest(".lyr-row");
    if (!rowEl) return;
    const id = rowEl.dataset.id;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (e.shiftKey || mod) {
      selectRow(id, e);
      return;
    }
    const wasSelected = store.selection.includes(id);
    if (!wasSelected) selectRow(id, e);
    const panel = panelIds();
    const moving = wasSelected ? panel.filter((x) => store.selection.includes(x)) : [id];
    drag = { id, moving, startY: e.clientY, y: e.clientY, active: false, wasSelected, raf: 0, pointerId: e.pointerId };
  });

  // Tracked on the window (no pointer capture) so click and double-click
  // still reach the row under the pointer.
  const move = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.y = e.clientY;
    if (!drag.active) {
      if (Math.abs(e.clientY - drag.startY) < DRAG_START) return;
      drag.active = true;
      root.classList.add("dragging");
      for (const id of drag.moving) rows.get(id)?.el.classList.add("moving");
      ctx.editor?.setHover?.(null);
      autoScroll();
    }
    showDrop(gapAt(e.clientY));
  };

  const up = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dr = drag;
    if (!dr.active && dr.wasSelected && store.selection.length > 1) {
      store.select([dr.id]);
      anchorId = dr.id;
    } else if (!dr.active && dr.wasSelected) {
      anchorId = dr.id;
    }
    endDrag(e.type === "pointerup");
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
  d(() => window.removeEventListener("pointermove", move));
  d(() => window.removeEventListener("pointerup", up));
  d(() => window.removeEventListener("pointercancel", up));

  // ---- hover ----

  list.addEventListener("pointerover", (e) => {
    if (drag?.active) return;
    const id = e.target.closest?.(".lyr-row")?.dataset.id || null;
    if (id === hoverId) return;
    hoverId = id;
    ctx.editor?.setHover?.(id);
  });
  list.addEventListener("pointerleave", () => {
    hoverId = null;
    ctx.editor?.setHover?.(null);
  });

  // ---- rename ----

  function startRename(id) {
    const row = rows.get(id);
    const l = store.get(id);
    if (!row || !l || renaming) return;
    renaming = id;
    // Only a rename started from the focused list (F2, Enter) hands focus back
    // to it; one started with a double-click leaves the arrows to nudge.
    const fromList = document.activeElement === list;
    const input = h("input", { type: "text", class: "lyr-rename", spellcheck: "false", autocomplete: "off", maxlength: 200, "aria-label": "Layer name" });
    input.value = l.name;
    row.name.replaceWith(input);
    row.el.classList.add("renaming");
    input.focus();
    input.select();
    let done = false;
    // viaKey: ended with Enter or Escape. A blur (a click on the canvas, say)
    // never pulls focus back into the list.
    const finish = (save, viaKey = false) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      renaming = null;
      row.el.classList.remove("renaming");
      input.replaceWith(row.name);
      const now = store.get(id);
      if (save && now && v && v !== now.name) store.patch(id, { name: v }, { label: "Rename" });
      if (now) row.name.textContent = displayName(store.get(id));
      if (viaKey && fromList) list.focus({ preventScroll: true });
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true, true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false, true);
      }
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("pointerdown", (e) => e.stopPropagation());
  }

  list.addEventListener("dblclick", (e) => {
    const rowEl = e.target.closest(".lyr-row");
    if (!rowEl || e.target.closest("button, input")) return;
    startRename(rowEl.dataset.id);
  });

  // ---- context menu ----

  list.addEventListener("contextmenu", (e) => {
    const rowEl = e.target.closest(".lyr-row");
    if (!rowEl || typeof ctx.ui?.menu !== "function") return;
    e.preventDefault();
    const id = rowEl.dataset.id;
    if (!store.selection.includes(id)) {
      store.select([id]);
      anchorId = id;
    }
    const l = store.get(id);
    const run = (cmd) => () => ctx.commands?.run?.(cmd);
    const kbd = (cmd) => ctx.commands?.keysLabel?.(cmd) || "";
    const many = store.selection.length > 1;
    ctx.ui.menu(
      [
        { label: "Rename", icon: "rename", kbd: "F2", disabled: many, run: () => startRename(id) },
        { label: "Duplicate", icon: "copy-plus", kbd: kbd("layer.duplicate"), run: run("layer.duplicate") },
        "-",
        { label: "Bring to front", icon: "bring-front", kbd: kbd("layer.front"), run: run("layer.front") },
        { label: "Send to back", icon: "send-back", kbd: kbd("layer.back"), run: run("layer.back") },
        "-",
        { label: l?.hidden ? "Show" : "Hide", icon: l?.hidden ? "eye" : "eye-off", kbd: kbd("layer.hide"), run: run("layer.hide") },
        { label: l?.locked ? "Unlock" : "Lock", icon: l?.locked ? "unlock" : "lock", kbd: kbd("layer.lock"), run: run("layer.lock") },
        "-",
        { label: "Delete", icon: "trash", kbd: kbd("edit.delete"), danger: true, run: run("edit.delete") },
      ],
      { x: e.clientX, y: e.clientY }
    );
  });

  // ---- keyboard ----

  list.addEventListener("keydown", (e) => {
    if (e.target !== list) return;
    const ids = panelIds();
    if (!ids.length) return;
    const cur = store.selection[store.selection.length - 1];
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      const i = ids.indexOf(cur);
      const next = ids[Math.max(0, Math.min(ids.length - 1, i < 0 ? 0 : i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (e.shiftKey && anchorId) store.select(rangeIds(ids, anchorId, next));
      else {
        store.select([next]);
        anchorId = next;
      }
      rows.get(next)?.el.scrollIntoView({ block: "nearest" });
    } else if ((e.key === "F2" || e.key === "Enter") && cur && store.selection.length === 1) {
      e.preventDefault();
      e.stopPropagation();
      startRename(cur);
    }
  });

  // ---- wiring ----

  let lastSel = "";
  const onChange = () => {
    sync();
    const sel = store.selection.join(",");
    if (sel !== lastSel) {
      lastSel = sel;
      const last = store.selection[store.selection.length - 1];
      if (last && !drag) rows.get(last)?.el.scrollIntoView({ block: "nearest" });
    }
  };
  store.addEventListener("change", onChange);
  store.addEventListener("selection", onChange);
  d(() => store.removeEventListener("change", onChange));
  d(() => store.removeEventListener("selection", onChange));

  if (ctx.assets?.addEventListener) {
    const onReady = (e) => {
      const id = e.detail?.id;
      if (id) redrawWhere((l) => l.type === "image" && (l.asset === id || l.mask === id));
    };
    ctx.assets.addEventListener("ready", onReady);
    d(() => ctx.assets.removeEventListener("ready", onReady));
  }
  if (ctx.fonts?.addEventListener) {
    const onFont = () => redrawWhere((l) => l.type === "text");
    ctx.fonts.addEventListener("load", onFont);
    d(() => ctx.fonts.removeEventListener("load", onFont));
  }
  d(ctx.on("theme", () => redrawWhere(() => true)));
  // Moving the window to a screen with another pixel ratio redraws the
  // thumbnails sharp (the query is for the current ratio, so it fires once).
  const watchDpr = () => {
    const mq = globalThis.matchMedia?.(`(resolution: ${globalThis.devicePixelRatio || 1}dppx)`);
    if (typeof mq?.addEventListener !== "function") return;
    const onDpr = () => {
      redrawWhere(() => true);
      watchDpr();
    };
    mq.addEventListener("change", onDpr, { once: true });
    d(() => mq.removeEventListener("change", onDpr));
  };
  watchDpr();
  d(() => clearTimeout(thumbTimer));
  d(() => endDrag(false));

  sync();
  return {
    destroy() {
      d.dispose();
    },
    rename: startRename,
  };
}
