// The floating chrome around the canvas: top bar islands, the tool rail, the
// zoom island, the right panel's splitter and the responsive rules.

import { h, svg, clear, drag } from "./dom.js";
import { icon } from "./icons.js";
import { iconButton } from "./controls.js";
import { keysLabel } from "../app/context.js";
import { createLayer } from "../core/model.js";
import { shapePreviewPath } from "../core/shapes.js";
import { aspectLabel } from "../features/presets.js";
import { kbdNodes } from "./menus.js";
import { session } from "./commands-core.js";

// ---- small shared pieces -----------------------------------------------------------

// The Longitude mark: a globe with a lime meridian (Latitude's has a lime equator).
export function logoMark({ size = 22, className = "" } = {}) {
  return svg(
    "svg",
    { viewBox: "0 0 24 24", width: size, height: size, class: ["logo-mark", className].filter(Boolean).join(" "), "aria-hidden": "true" },
    svg("circle", { cx: "12", cy: "12", r: "9.2", class: "logo-globe" }),
    svg("path", { d: "M2.8 12h18.4", class: "logo-equator" }),
    svg("ellipse", { cx: "12", cy: "12", rx: "3.9", ry: "9.2", class: "logo-meridian" }),
  );
}

export function sizeLabel(w, hgt) {
  return `${Math.round(w)} × ${Math.round(hgt)}`;
}

// A preset's label under its group heading, without the group repeated:
// "YouTube channel banner" under YouTube reads "Channel banner".
export function shortLabel(label, group) {
  const text = String(label ?? "");
  const g = String(group ?? "").trim();
  if (!g || text.length <= g.length + 1 || text.slice(0, g.length + 1).toLowerCase() !== `${g.toLowerCase()} `) return text;
  const rest = text.slice(g.length + 1).trim();
  return rest ? rest[0].toUpperCase() + rest.slice(1) : text;
}

// A small glyph that says what a preset is for.
export function presetGlyph(p) {
  const id = p?.id || "";
  if (p?.custom) return "plus";
  if (/avatar|profile|watermark/.test(id)) return "circle";
  if (/shorts|story|reel/.test(id)) return "smartphone";
  if (/banner|header/.test(id)) return "monitor";
  if (/post/.test(id)) return "message-square";
  if (/^yt-|video/.test(id)) return "play-rect";
  if (/^sp-/.test(id)) return "music";
  if (/square/.test(id)) return "square";
  if (/wide/.test(id)) return "monitor";
  return "image";
}

const clampSide = (v) => Math.max(16, Math.min(8000, Math.round(v)));

function sizeInput(value, label) {
  const input = h("input", { type: "text", inputmode: "numeric", class: "input num size-input", "aria-label": label, spellcheck: "false", autocomplete: "off" });
  input.value = String(Math.round(value));
  return input;
}

// Width x height fields with a proportion lock. onSubmit({ width, height }).
export function sizeForm({ width = 1280, height = 720, submitLabel = "Apply", onSubmit, autofocus = false } = {}) {
  const wIn = sizeInput(width, "Width");
  const hIn = sizeInput(height, "Height");
  let locked = false;
  let ratio = width / height;
  const lock = h("button", { type: "button", class: "icon-btn sm size-lock", "data-tip": "Keep proportions", "aria-label": "Keep proportions", "aria-pressed": "false" }, icon("unlink", { size: "sm" }));
  const hint = h("span", { class: "size-hint num" }, aspectLabel(width, height));
  const go = h("button", { type: "button", class: "btn primary size-go" }, submitLabel);
  if (autofocus) wIn.setAttribute("autofocus", "");

  const read = (el) => {
    const n = parseFloat(String(el.value).replace(",", "."));
    return Number.isFinite(n) ? n : NaN;
  };
  const valid = (n) => Number.isFinite(n) && n >= 16 && n <= 8000;
  function sync(from) {
    const w = read(wIn);
    const hv = read(hIn);
    if (locked && from === "w" && valid(w)) hIn.value = String(clampSide(w / ratio));
    if (locked && from === "h" && valid(hv)) wIn.value = String(clampSide(hv * ratio));
    const W = read(wIn);
    const H = read(hIn);
    wIn.classList.toggle("invalid", !valid(W));
    hIn.classList.toggle("invalid", !valid(H));
    const ok = valid(W) && valid(H);
    hint.textContent = ok ? aspectLabel(W, H) : "16 to 8000 px";
    hint.classList.toggle("bad", !ok);
    go.disabled = !ok;
  }
  function submit() {
    const W = read(wIn);
    const H = read(hIn);
    if (!valid(W) || !valid(H)) return;
    onSubmit?.({ width: Math.round(W), height: Math.round(H) });
  }
  for (const [el, k] of [[wIn, "w"], [hIn, "h"]]) {
    el.addEventListener("input", () => sync(k));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const n = read(el);
        el.value = String(clampSide((Number.isFinite(n) ? n : 0) + (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1)));
        sync(k);
      }
      e.stopPropagation();
    });
    el.addEventListener("focus", () => el.select());
  }
  lock.addEventListener("click", () => {
    locked = !locked;
    const W = read(wIn);
    const H = read(hIn);
    if (valid(W) && valid(H)) ratio = W / H;
    lock.setAttribute("aria-pressed", String(locked));
    lock.replaceChildren(icon(locked ? "link" : "unlink", { size: "sm" }));
  });
  go.addEventListener("click", submit);
  sync();
  return h(
    "div",
    { class: "size-form" },
    h("label", { class: "size-field" }, h("span", { class: "micro" }, "W"), wIn),
    lock,
    h("label", { class: "size-field" }, h("span", { class: "micro" }, "H"), hIn),
    hint,
    go,
  );
}

// A preset's shape drawn to its aspect ratio inside a box.
export function ratioThumb(w, hgt, box = 18, { round = false } = {}) {
  const k = box / Math.max(w, hgt);
  return h("span", {
    class: ["ratio-thumb", round && "round"],
    style: { width: `${Math.max(3, Math.round(w * k))}px`, height: `${Math.max(3, Math.round(hgt * k))}px` },
    "aria-hidden": "true",
  });
}

// "insert.shape.<id>" for a shape id that makes a valid command id, else null.
export function shapeCommandId(shapeId) {
  const id = `insert.shape.${String(shapeId || "").toLowerCase()}`;
  return /^[a-z][a-z0-9._-]{0,63}$/.test(id) && shapeId ? id : null;
}

// The index arrow keys move to in a list (columns 1) or a wrapping grid of
// `columns`, or -1 to stay. Home and End go to the ends.
export function rovingIndex(key, i, count, columns = 1) {
  if (i < 0 || count <= 0) return -1;
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[key];
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (step === undefined) return -1;
  if (columns === 1 && (key === "ArrowLeft" || key === "ArrowRight")) return -1;
  const j = i + step;
  return j >= 0 && j < count ? j : -1;
}

// Arrow-key movement between the buttons of a popover list or grid.
function rovingNav(container, selector, { columns = false } = {}) {
  if (!container) return;
  container.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
    const items = [...container.querySelectorAll(selector)];
    const i = items.indexOf(document.activeElement);
    let cols = 1;
    if (columns && items.length) {
      const top = items[0].offsetTop;
      cols = Math.max(1, items.filter((el) => el.offsetTop === top).length);
    }
    const j = rovingIndex(e.key, i, items.length, cols);
    if (i < 0) return;
    e.preventDefault();
    if (j < 0) return;
    items[j].focus();
    items[j].scrollIntoView?.({ block: "nearest" });
  });
}

// ---- the shell -----------------------------------------------------------------------

const RAIL_ORDER = [["select", "hand"], ["text", "@image", "@shapes"], ["circle", "arrow", "pen"]];
const RAIL_KNOWN = new Set(["select", "hand", "text", "circle", "arrow", "pen", "rect", "ellipse", "refine", "magic"]);
const CONTEXT_TOOLS = ["refine", "magic"];
const SHAPE_SIZE = { rect: [0.56, 0.36], bubble: [0.5, 0.38] };

export function mountShell(ctx, regions = {}) {
  const $id = (id) => regions[id] || document.getElementById(id);
  const topbar = $id("topbar");
  const rail = $id("rail");
  const zoombar = $id("zoombar");
  const panel = $id("panel");
  const splitter = $id("panel-splitter");
  const cmdButtons = [];

  const enabled = (id) => !!ctx.commands.get(id) && ctx.commands.enabled(id);
  const run = (id, args) => ctx.commands.run(id, args);

  // An icon button bound to a command: tooltip keys come from the command.
  function cmdButton(id, iconName, tip, extra = {}) {
    const b = iconButton({ icon: iconName, tip, size: extra.size });
    b.dataset.cmd = id;
    b.addEventListener("click", () => run(id));
    cmdButtons.push(b);
    return b;
  }

  function refreshCommands() {
    for (const b of cmdButtons) b.disabled = !enabled(b.dataset.cmd);
    refreshHistory();
  }

  // ---- top left: mark, name, preset chip, saved state

  const menuBtn = h(
    "button",
    { type: "button", class: "brand-btn", "data-tip": "Menu", "aria-label": "Main menu", "aria-haspopup": "menu" },
    logoMark({ size: 22 }),
    h("span", { class: "wordmark" }, "Longitude"),
  );
  menuBtn.addEventListener("click", () => openMainMenu(menuBtn));

  const nameInput = h("input", { type: "text", class: "doc-name", "aria-label": "Design name", spellcheck: "false", autocomplete: "off", maxlength: "120", "data-tip": "Rename" });
  const nameWrap = h("label", { class: "doc-name-wrap" }, nameInput);
  let nameBefore = "";
  // The design the field shows. Opening another one (Ctrl+O, a drop, the
  // palette) while the field has focus must not rename the new one.
  let nameDocId = null;
  let focusDocId = null;
  nameInput.addEventListener("focus", () => {
    nameBefore = nameInput.value;
    focusDocId = ctx.store?.doc?.id ?? null;
    ctx.ui.hideTip?.();
    requestAnimationFrame(() => nameInput.select());
  });
  nameInput.addEventListener("input", () => (nameWrap.dataset.value = nameInput.value || " "));
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      nameInput.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      nameInput.value = nameBefore;
      nameWrap.dataset.value = nameBefore;
      nameInput.dataset.cancel = "1";
      nameInput.blur();
    }
  });
  nameInput.addEventListener("blur", () => {
    if (nameInput.dataset.cancel) {
      delete nameInput.dataset.cancel;
      return;
    }
    if (focusDocId !== ctx.store.doc.id) {
      showName(ctx.store.doc);
      return;
    }
    const v = nameInput.value.trim();
    if (!v) {
      nameInput.value = ctx.store.doc.name;
      nameWrap.dataset.value = ctx.store.doc.name;
      return;
    }
    if (v !== ctx.store.doc.name) ctx.store.setDocProps({ name: v }, { label: "Rename" });
  });

  const presetChip = h("button", { type: "button", class: "preset-chip", "data-tip": "Canvas size", "aria-haspopup": "dialog" });
  presetChip.addEventListener("click", () => openCanvasSize(presetChip));

  const saveDot = h("span", { class: "save-dot" });
  const saveText = h("span", { class: "save-text" }, "Saved");
  const saveState = h("span", { class: "save-state", hidden: true, "data-state": "draft" }, saveDot, saveText);
  // Shown while a background removal model downloads; a click shows the details.
  const statusPill = h("button", { type: "button", class: "status-pill dl-pill", hidden: true, "aria-haspopup": "dialog", "data-tip": "Background removal is downloading" });
  statusPill.addEventListener("click", () => openDownloads(statusPill));

  const leftIsland = h("div", { class: "island top-island top-left" }, menuBtn, h("span", { class: "top-sep" }), nameWrap, presetChip, saveState, statusPill);

  // ---- top center: search pill

  // Two labels: CSS shows the one that fits (container queries in app.css),
  // or neither when only the icon and the shortcut fit.
  const searchPill = h(
    "button",
    { type: "button", class: "search-pill", "aria-label": "Search or run a command", "data-cmd": "view.palette" },
    icon("search", { size: "sm" }),
    h("span", { class: "search-text", "aria-hidden": "true" }, h("span", { class: "search-long" }, "Search or run a command"), h("span", { class: "search-short" }, "Search")),
    h("span", { class: "search-keys", "aria-hidden": "true" }, kbdNodes(keysLabel("Mod+K"))),
  );
  searchPill.addEventListener("click", () => ctx.ui.openPalette?.());
  const centerIsland = h("div", { class: "island top-island top-center" }, searchPill);

  // ---- top right: history, panel toggle, preview, export

  const undoBtn = cmdButton("edit.undo", "undo", "Undo");
  const redoBtn = cmdButton("edit.redo", "redo", "Redo");
  const panelBtn = iconButton({ icon: "panel-right", tip: "Show panel", active: false });
  panelBtn.classList.add("panel-toggle");
  panelBtn.addEventListener("click", () => togglePanel());
  const previewBtn = h("button", { type: "button", class: "btn ghost top-btn", "data-tip": "Preview in a feed", "data-cmd": "view.feed-preview" }, icon("play-rect", { size: "sm" }), h("span", null, "Preview"));
  previewBtn.addEventListener("click", () => run("view.feed-preview"));
  const exportBtn = h("button", { type: "button", class: "btn primary top-btn export-btn", "data-tip": "Export an image", "data-cmd": "file.export" }, icon("download", { size: "sm" }), h("span", null, "Export"));
  exportBtn.addEventListener("click", () => run("file.export"));
  const rightIsland = h("div", { class: "island top-island top-right" }, undoBtn, redoBtn, h("span", { class: "top-sep" }), panelBtn, previewBtn, exportBtn);

  clear(topbar).append(leftIsland, centerIsland, rightIsland);

  // ---- history state

  function refreshHistory() {
    const labels = ctx.store?.historyLabels?.() || {};
    const u = enabled("edit.undo");
    const r = enabled("edit.redo");
    undoBtn.disabled = !u;
    redoBtn.disabled = !r;
    undoBtn.dataset.tip = u && labels.undo ? `Undo ${labels.undo}` : "Nothing to undo";
    redoBtn.dataset.tip = r && labels.redo ? `Redo ${labels.redo}` : "Nothing to redo";
    undoBtn.setAttribute("aria-label", undoBtn.dataset.tip);
    redoBtn.setAttribute("aria-label", redoBtn.dataset.tip);
    previewBtn.disabled = !enabled("view.feed-preview");
    exportBtn.disabled = !enabled("file.export");
  }

  function pulse(el) {
    el.classList.remove("pulse");
    void el.offsetWidth;
    el.classList.add("pulse");
    setTimeout(() => el.classList.remove("pulse"), 420);
  }

  // ---- doc name and preset chip

  function showName(doc) {
    nameInput.value = doc.name;
    nameWrap.dataset.value = doc.name;
    nameDocId = doc.id;
  }

  function refreshDoc() {
    const doc = ctx.store?.doc;
    if (!doc) return;
    if (document.activeElement !== nameInput) showName(doc);
    else if (doc.id !== nameDocId) {
      // Another design arrived while the field had focus: show its name and
      // start the edit over from it.
      showName(doc);
      nameBefore = doc.name;
      focusDocId = doc.id;
      nameInput.select?.();
    }
    document.title = session.open ? `${doc.name} · Longitude` : "Longitude";
    const p = doc.preset ? ctx.presets?.get?.(doc.preset) : null;
    presetChip.replaceChildren(
      icon(p ? presetGlyph(p) : "frame", { size: "sm" }),
      h("span", { class: "chip-label" }, p ? p.label : "Custom"),
      h("span", { class: "chip-size num" }, sizeLabel(doc.width, doc.height)),
      icon("chevron-down", { size: "sm", class: "chip-chev" }),
    );
  }

  // ---- saved state

  let savedAt = 0;
  function setSaveState(state, info = {}) {
    saveState.dataset.state = state;
    saveState.hidden = state === "draft" || state === "hidden";
    if (info.at) savedAt = info.at;
    const time = savedAt ? new Date(savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    if (state === "saved") {
      saveText.textContent = "Saved";
      // The desktop app keeps designs in its own folder, not a browser's.
      const where = ctx.desktop ? "Saved" : "Saved in this browser";
      saveState.dataset.tip = time ? `${where} at ${time}` : where;
    } else if (state === "pending") {
      saveText.textContent = "Saving…";
      saveState.dataset.tip = "Saving your latest change";
    } else if (state === "error") {
      saveText.textContent = "Not saved";
      saveState.dataset.tip = info.message ? `Not saved: ${info.message}` : "Not saved. Save a project file to keep your work.";
    } else if (state === "memory") {
      saveText.textContent = "Not stored";
      saveState.dataset.tip = ctx.desktop ? "Longitude could not store data on this computer. Save a project file to keep your work." : "This browser is not keeping data for this site. Save a project file to keep your work.";
    }
  }

  // ---- main menu

  function cmdItem(id, label, iconName) {
    const c = ctx.commands.get(id);
    if (!c) return null;
    return { label: label || c.title, icon: iconName || c.icon, kbd: ctx.commands.keysLabel(id), disabled: !ctx.commands.enabled(id), run: () => run(id) };
  }

  function openMainMenu(anchor) {
    const themes = ctx.themes?.list?.() || [];
    const cur = ctx.themes?.current?.()?.id;
    const tools = [cmdItem("tools.compress", "Compress an image"), cmdItem("tools.remove-bg", "Remove a background", "remove-bg"), cmdItem("tools.convert", "Resize or convert")].filter(Boolean);
    // A project file, not an image: its own icon and the extension beside it.
    const saveFile = cmdItem("file.save-copy", "Save project file", "save");
    if (saveFile) saveFile.hint = ".longitude";
    ctx.ui.menu(
      [
        cmdItem("file.home", "Home"),
        cmdItem("file.new", "New design"),
        cmdItem("file.open", "Open a file"),
        saveFile,
        "-",
        cmdItem("file.export", "Export"),
        cmdItem("view.feed-preview", "Preview in a feed", "play-rect"),
        tools.length ? { label: "Quick tools", icon: "zap", submenu: tools } : null,
        "-",
        themes.length ? { label: "Theme", icon: "palette", submenu: themes.map((t) => ({ label: t.name, checked: t.id === cur, hint: t.scheme === "light" ? "Light" : "", run: () => run("view.theme", { id: t.id }) })) } : null,
        cmdItem("help.shortcuts", "Keyboard shortcuts"),
        cmdItem("app.settings", "Settings"),
      ],
      { anchor, placement: "bottom-start", minWidth: 232 },
    );
  }

  // ---- canvas size popover

  function applySize({ width, height, preset }) {
    const doc = ctx.store.doc;
    if (width === doc.width && height === doc.height) {
      ctx.store.setDocProps({ preset: preset ?? null }, { label: "Canvas" });
      return;
    }
    if (ctx.commands.get("canvas.resize")) {
      run("canvas.resize", { width, height, preset: preset ?? null });
    } else {
      ctx.store.setDocProps({ width, height, preset: preset ?? null }, { label: "Resize canvas" });
      ctx.editor?.zoomToFit?.();
    }
  }

  function openCanvasSize(anchor) {
    const doc = ctx.store.doc;
    let pop = null;
    const groups = ctx.presets?.groups?.() || [];
    const rows = [];
    for (const g of groups) {
      const list = g.presets.filter((p) => !p.custom);
      if (!list.length) continue;
      rows.push(h("div", { class: "size-group micro" }, g.label));
      for (const p of list) {
        const current = doc.preset === p.id;
        const b = h(
          "button",
          { type: "button", class: ["size-row", current && "current"], "aria-label": `${p.label}, ${sizeLabel(p.width, p.height)}`, "aria-current": current ? "true" : undefined },
          h("span", { class: "size-thumb" }, ratioThumb(p.width, p.height, 18, { round: presetGlyph(p) === "circle" })),
          h("span", { class: "size-label" }, shortLabel(p.label, g.label)),
          h("span", { class: "size-dim num" }, sizeLabel(p.width, p.height)),
          current ? icon("check", { size: "sm", class: "size-check" }) : h("span", { class: "size-check" }),
        );
        b.addEventListener("click", () => {
          pop?.close();
          applySize({ width: p.width, height: p.height, preset: p.id });
        });
        rows.push(b);
      }
    }
    const form = sizeForm({
      width: doc.width,
      height: doc.height,
      submitLabel: "Apply",
      onSubmit: ({ width, height }) => {
        pop?.close();
        applySize({ width, height, preset: ctx.presets?.find?.(width, height)?.id || null });
      },
    });
    const content = h(
      "div",
      { class: "size-pop" },
      h("div", { class: "pop-head" }, h("span", { class: "pop-title" }, "Canvas size"), h("span", { class: "muted num" }, sizeLabel(doc.width, doc.height))),
      h("div", { class: "size-list" }, rows),
      h("div", { class: "size-custom" }, h("div", { class: "micro" }, "Custom size"), form),
    );
    rovingNav(content.querySelector(".size-list"), ".size-row");
    pop = ctx.ui.popover(anchor, content, { placement: "bottom-start", width: 340, class: "size-popover" });
    content.querySelector(".size-row.current")?.scrollIntoView({ block: "nearest" });
  }

  // ---- rail

  const railMain = h("div", { class: "island rail-island", role: "toolbar", "aria-orientation": "vertical", "aria-label": "Tools" });
  const railBottom = h("div", { class: "island rail-island rail-bottom" });
  const helpBtn = cmdButton("help.shortcuts", "help-circle", "Keyboard shortcuts");
  const settingsBtn = cmdButton("app.settings", "settings", "Settings");
  railBottom.append(helpBtn, settingsBtn);
  clear(rail).append(h("div", { class: "rail-spacer" }), railMain, h("div", { class: "rail-spacer" }), railBottom);

  const toolButtons = new Map();
  let shapesBtn = null;
  let sticky = false;

  function currentTool() {
    return ctx.editor?.tool || "select";
  }

  function toolButton(def) {
    const b = iconButton({ icon: def.icon || "dot", tip: def.label, kbd: def.key || "" });
    b.dataset.tool = def.id;
    b.addEventListener("click", () => ctx.editor?.setTool?.(def.id));
    // Double-click keeps a creation tool after one use.
    b.addEventListener("dblclick", () => {
      ctx.editor?.setTool?.(def.id, { sticky: true });
      sticky = ctx.editor?.toolSticky ?? true;
      paintTools();
    });
    toolButtons.set(def.id, b);
    return b;
  }

  function imageButton() {
    const b = iconButton({ icon: "image-plus", tip: "Add an image", kbd: "I" });
    b.dataset.cmd = "insert.image";
    b.addEventListener("click", () => {
      if (ctx.commands.get("insert.image")) run("insert.image");
      else run("file.open");
    });
    return b;
  }

  function shapeButton() {
    // No key in the tip: R draws a rectangle, it does not open this menu.
    shapesBtn = iconButton({ icon: "shapes", tip: "Shapes. Draw a rectangle with R, an ellipse with O" });
    shapesBtn.setAttribute("aria-haspopup", "dialog");
    shapesBtn.addEventListener("click", () => openShapes(shapesBtn));
    return shapesBtn;
  }

  function insertShape(id) {
    const def = ctx.shapes?.get?.(id);
    const doc = ctx.store.doc;
    const base = Math.min(doc.width, doc.height);
    const [kw, kh] = SHAPE_SIZE[id] || [0.4, 0.4];
    const layer = createLayer("shape", {
      shape: id,
      x: doc.width / 2,
      y: doc.height / 2,
      w: Math.round(base * kw),
      h: Math.round(base * kh),
      fill: def?.defaults?.fill,
      // The outline scales with the box (720 is the reference); clone it,
      // preset defaults are frozen.
      stroke: def?.defaults?.stroke && {
        ...def.defaults.stroke,
        ...(Number.isFinite(def.defaults.stroke.width) && { width: Math.round(def.defaults.stroke.width * (base / 720) * 10) / 10 }),
      },
      params: def?.defaults?.params || {},
      radius: id === "rect" ? Math.round(base * 0.02) : 0,
    });
    const ids = ctx.store.add(layer, { label: `Add ${def?.label?.toLowerCase() || "shape"}` });
    ctx.editor?.setTool?.("select");
    ctx.editor?.flash?.(ids);
  }

  // Every shape is also a command, so the palette finds "star" or "speech
  // bubble" (mod shapes included; rebuilt when the shape list changes).
  let shapeCmdOffs = [];
  function registerShapeCommands() {
    for (const off of shapeCmdOffs) off();
    shapeCmdOffs = [];
    for (const def of ctx.shapes?.list?.() || []) {
      const cmdId = shapeCommandId(def.id);
      if (!cmdId || ctx.commands.get(cmdId)) continue;
      const label = String(def.label || def.id);
      try {
        shapeCmdOffs.push(
          ctx.commands.register({
            id: cmdId,
            title: `Add ${label.toLowerCase()}`,
            group: "Insert",
            icon: def.icon || "shapes",
            keywords: `shape ${label} ${def.id}`,
            when: (c) => !!c.store && session.open && !c.ui.isHomeOpen?.(),
            run: () => insertShape(def.id),
          }),
        );
      } catch (err) {
        console.warn(`Longitude: could not add a command for the shape ${def.id}: ${err.message}`);
      }
    }
  }

  function openShapes(anchor) {
    const list = ctx.shapes?.list?.() || [];
    let pop = null;
    const grid = h("div", { class: "shape-grid" });
    for (const def of list) {
      const d = shapePreviewPath(def.id, 28, 4);
      const preview = d
        ? svg("svg", { viewBox: "0 0 28 28", class: "shape-preview", "aria-hidden": "true" }, svg("path", { d }))
        : icon(def.icon || "square", { class: "shape-preview" });
      const key = def.id === "rect" ? "R" : def.id === "ellipse" ? "O" : "";
      const b = h("button", { type: "button", class: "shape-btn", "data-tip": key ? `${def.label}: click to add, or draw with ${key}` : `${def.label}: click to add`, "aria-label": `Add ${def.label}` }, preview, h("span", { class: "shape-name" }, def.label));
      b.addEventListener("click", () => {
        pop?.close();
        insertShape(def.id);
      });
      grid.append(b);
    }
    const draw = h(
      "div",
      { class: "shape-draw" },
      ...[["rect", "Draw a rectangle", "square", "R"], ["ellipse", "Draw an ellipse", "circle", "O"]]
        .filter(([id]) => ctx.tools.get(id))
        .map(([id, label, ic, k]) => {
          const b = h("button", { type: "button", class: "shape-draw-btn" }, icon(ic, { size: "sm" }), h("span", null, label), h("kbd", null, k));
          b.addEventListener("click", () => {
            pop?.close();
            ctx.editor?.setTool?.(id);
          });
          return b;
        }),
    );
    rovingNav(grid, ".shape-btn", { columns: true });
    const content = h("div", { class: "shapes-pop" }, h("div", { class: "pop-head" }, h("span", { class: "pop-title" }, "Shapes")), grid, draw.childElementCount ? draw : null);
    pop = ctx.ui.popover(anchor, content, { placement: "right-start", width: 272, class: "shapes-popover" });
  }

  function relevant(id) {
    const tool = currentTool();
    if (tool === id) return true;
    const cmdId = `tool.${id}`;
    if (ctx.commands.get(cmdId)) return ctx.commands.enabled(cmdId);
    const sel = ctx.store?.selected?.() || [];
    if (sel.length !== 1 || sel[0].type !== "image") return false;
    return id === "refine" ? !!sel[0].mask : true;
  }

  let contextGroup = null;
  let contextKey = "";

  function renderRail() {
    toolButtons.clear();
    clear(railMain);
    const add = (group) => {
      const nodes = group.filter(Boolean);
      if (!nodes.length) return;
      if (railMain.childElementCount) railMain.append(h("span", { class: "rail-sep" }));
      railMain.append(...nodes);
    };
    for (const group of RAIL_ORDER) {
      add(
        group.map((id) => {
          if (id === "@image") return imageButton();
          if (id === "@shapes") return shapeButton();
          const def = ctx.tools.get(id);
          return def ? toolButton(def) : null;
        }),
      );
    }
    const extras = ctx.tools.list().filter((t) => !RAIL_KNOWN.has(t.id) && !t.id.startsWith("shape") && !t.hidden);
    add(extras.map(toolButton));
    contextGroup = h("div", { class: "rail-context" });
    railMain.append(contextGroup);
    contextKey = "";
    paintContext();
    paintTools();
  }

  function paintContext() {
    if (!contextGroup) return;
    const show = CONTEXT_TOOLS.filter((id) => ctx.tools.get(id) && relevant(id));
    const key = show.join(",");
    if (key === contextKey) return;
    contextKey = key;
    clear(contextGroup);
    for (const id of show) toolButtons.delete(id);
    if (!show.length) {
      contextGroup.hidden = true;
      return;
    }
    contextGroup.hidden = false;
    contextGroup.append(h("span", { class: "rail-sep" }), ...show.map((id) => toolButton(ctx.tools.get(id))));
    paintTools();
  }

  function paintTools() {
    const tool = currentTool();
    for (const [id, b] of toolButtons) {
      const on = id === tool;
      b.setAttribute("aria-pressed", String(on));
      b.classList.toggle("sticky", on && sticky);
    }
    if (shapesBtn) shapesBtn.setAttribute("aria-pressed", String(tool === "rect" || tool === "ellipse" || tool.startsWith("shape")));
  }

  // ---- zoom island

  const zoomValue = h("button", { type: "button", class: "zoom-value num", "data-tip": "Zoom level", "aria-label": "Zoom level", "aria-haspopup": "menu" }, "100%");
  zoomValue.addEventListener("click", () => openZoomMenu(zoomValue));
  const safeBtn = cmdButton("view.safe-zones", "safe-zone", "Safe zones");
  const snapBtn = cmdButton("view.snapping", "magnet", "Snapping");
  const gridBtn = cmdButton("view.grid", "grid", "Grid");
  const zoomIsland = h(
    "div",
    { class: "island zoom-island" },
    cmdButton("view.zoom-out", "minus", "Zoom out", { size: "sm" }),
    zoomValue,
    cmdButton("view.zoom-in", "plus", "Zoom in", { size: "sm" }),
    cmdButton("view.fit", "maximize", "Zoom to fit", { size: "sm" }),
    h("span", { class: "top-sep" }),
    safeBtn,
    snapBtn,
    gridBtn,
  );
  for (const b of [safeBtn, snapBtn, gridBtn]) b.classList.add("sm");
  clear(zoombar).append(zoomIsland);

  function paintZoom(z = ctx.editor?.zoom) {
    if (!Number.isFinite(z)) return;
    const pct = z * 100;
    zoomValue.textContent = `${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`;
    zoomValue.setAttribute("aria-label", `Zoom level ${zoomValue.textContent}`);
  }

  function paintToggles() {
    safeBtn.setAttribute("aria-pressed", String(!!ctx.prefs.get("safeZones", true)));
    snapBtn.setAttribute("aria-pressed", String(!!ctx.prefs.get("snap", true)));
    gridBtn.setAttribute("aria-pressed", String(!!ctx.prefs.get("grid", false)));
  }

  function openZoomMenu(anchor) {
    const z = ctx.editor?.zoom || 1;
    const set = (v) => {
      try {
        ctx.editor?.setZoom?.(v);
      } catch (err) {
        console.error(err);
      }
    };
    ctx.ui.menu(
      [
        ...[0.25, 0.5, 1, 2].map((v) => ({ label: `${v * 100}%`, checked: Math.abs(z - v) < 0.005, kbd: v === 1 ? ctx.commands.keysLabel("view.actual") : "", run: () => set(v) })),
        "-",
        { label: "Zoom to fit", icon: "maximize", kbd: ctx.commands.keysLabel("view.fit"), run: () => run("view.fit") },
      ],
      { anchor, placement: "top", minWidth: 180 },
    );
  }

  // ---- right panel: splitter and responsive collapse

  // Without a saved height the layers list takes about 38% of the panel
  // (160 to 260 px), so a short window leaves the inspector more room.
  const defaultLayersH = () => Math.round(Math.max(160, Math.min(260, (panel?.clientHeight || 0) * 0.38)));
  const wantedLayersH = () => ctx.prefs.get("layersHeight", undefined) ?? defaultLayersH();
  function setLayersHeight(px, save = false) {
    if (!panel) return;
    const max = Math.max(140, panel.clientHeight - 160);
    const v = Math.round(Math.max(120, Math.min(max, px)));
    panel.style.setProperty("--layers-h", `${v}px`);
    splitter?.setAttribute("aria-valuenow", String(v));
    if (save) ctx.prefs.set("layersHeight", v);
    return v;
  }

  if (splitter) {
    splitter.setAttribute("role", "separator");
    splitter.setAttribute("aria-orientation", "horizontal");
    splitter.setAttribute("aria-label", "Resize the layers panel");
    splitter.setAttribute("tabindex", "0");
    splitter.dataset.tip = "Drag to resize";
    splitter.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const layersEl = $id("layers");
      const startH = layersEl ? layersEl.getBoundingClientRect().height : wantedLayersH();
      splitter.classList.add("dragging");
      drag(e, {
        cursor: "row-resize",
        onMove: (ev, start) => setLayersHeight(startH - (ev.clientY - start.y)),
        onUp: (ev, start) => {
          splitter.classList.remove("dragging");
          setLayersHeight(startH - (ev.clientY - start.y), true);
        },
      });
    });
    // Double-click goes back to the automatic height.
    splitter.addEventListener("dblclick", () => {
      ctx.prefs.set("layersHeight", undefined);
      setLayersHeight(defaultLayersH());
    });
    splitter.addEventListener("keydown", (e) => {
      const cur = parseFloat(getComputedStyle(panel).getPropertyValue("--layers-h")) || wantedLayersH();
      if (e.key === "ArrowUp") setLayersHeight(cur + (e.shiftKey ? 64 : 16), true);
      else if (e.key === "ArrowDown") setLayersHeight(cur - (e.shiftKey ? 64 : 16), true);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
  }
  requestAnimationFrame(() => setLayersHeight(wantedLayersH()));
  setLayersHeight(wantedLayersH());
  // The window's height bounds the list: the saved (or automatic) height is
  // applied again after a resize, once per frame.
  let layersFrame = 0;
  addEventListener("resize", () => {
    if (layersFrame) return;
    layersFrame = requestAnimationFrame(() => {
      layersFrame = 0;
      setLayersHeight(wantedLayersH());
    });
  });

  const body = document.body;
  const mqNarrow = matchMedia("(max-width: 1099px)");
  const mqTiny = matchMedia("(max-width: 759px)");
  let tinyNoted = false;

  function panelVisible() {
    return mqNarrow.matches ? body.classList.contains("panel-open") : !body.classList.contains("panel-hidden");
  }

  function paintPanelBtn() {
    const v = panelVisible();
    panelBtn.setAttribute("aria-pressed", String(v));
    panelBtn.dataset.tip = v ? "Hide panel" : "Show panel";
    panelBtn.setAttribute("aria-label", panelBtn.dataset.tip);
  }

  // Narrow windows: the panel is hidden until asked for. Wide windows: shown
  // unless hidden on purpose. (The canvas insets follow from CSS: app.css.)
  function togglePanel(force) {
    if (mqNarrow.matches) body.classList.toggle("panel-open", force ?? !body.classList.contains("panel-open"));
    else body.classList.toggle("panel-hidden", force === undefined ? !body.classList.contains("panel-hidden") : !force);
    paintPanelBtn();
    panelMoved();
  }

  // "panel" { visible } once the panel's 200 ms slide has ended, for anything
  // placed against it.
  let panelTimer = 0;
  function panelMoved() {
    clearTimeout(panelTimer);
    panelTimer = setTimeout(() => ctx.emit("panel", { visible: panelVisible() }), 220);
  }

  function applyNarrow() {
    body.classList.toggle("narrow", mqNarrow.matches);
    if (!mqNarrow.matches) body.classList.remove("panel-open");
    else body.classList.remove("panel-hidden");
    paintPanelBtn();
    if (mqTiny.matches && !tinyNoted) {
      tinyNoted = true;
      ctx.ui.toast?.("Longitude works best on a larger screen. Everything still works here.", { kind: "info", timeout: 6000 });
    }
    setLayersHeight(wantedLayersH());
    panelMoved();
  }
  mqNarrow.addEventListener?.("change", applyNarrow);
  mqTiny.addEventListener?.("change", applyNarrow);
  applyNarrow();

  ctx.on("shell:toggle-panel", () => togglePanel());

  ctx.on("shell:toggle-ui", () => {
    const hidden = body.classList.toggle("ui-hidden");
    panelMoved();
    if (hidden) ctx.ui.toast?.(`Interface hidden. Press ${keysLabel("Mod+\\")} to bring it back.`, { id: "ui-hidden", timeout: 3000 });
  });

  ctx.on("shell:rename", () => {
    nameInput.focus();
  });

  // ---- background removal downloads: a quiet pill, its details, a toast when ready

  let otherDownload = null; // { label, progress, message } from a mod's provider
  let dlPop = null; // { close, paint } while the details are open
  let pillPct = null; // the pill's percentage
  const lastState = new Map(); // providerId -> state

  function downloadsNow() {
    try {
      return ctx.bg?.downloading?.() || [];
    } catch {
      return [];
    }
  }

  function paintDownloads() {
    const list = downloadsNow();
    const bg = ctx.bg;
    if (!list.length && !otherDownload) {
      statusPill.hidden = true;
      dlPop?.paint();
      return;
    }
    const pct = list.length ? Math.round(list.reduce((s, d) => s + bg.describe(d).percent, 0) / list.length) : Math.round(otherDownload.progress * 100);
    statusPill.hidden = false;
    // Built once; each tick only changes the percentage.
    if (!pillPct || !statusPill.contains(pillPct)) {
      pillPct = h("span", { class: "num" });
      statusPill.replaceChildren(icon("download", { size: "sm" }), h("span", { class: "dl-pill-text" }, "Model"), pillPct);
    }
    pillPct.textContent = `${pct}%`;
    const line = list.length ? bg.describe(list[0]).detail : otherDownload.message;
    statusPill.dataset.tip = line ? `Background removal is downloading: ${line}` : "Background removal is downloading";
    statusPill.setAttribute("aria-label", `Background removal download, ${pct}%. Show details`);
    dlPop?.paint();
  }

  function downloadRow(s) {
    const words = ctx.bg.describe(s);
    const bar = h("span", { class: "dl-bar", style: { width: `${words.percent}%` } });
    return h(
      "div",
      { class: "dl-row" },
      h("div", { class: "dl-row-head" }, h("span", { class: "dl-name" }, String(s.label || "Model").replace(/\s*\(.*\)\s*$/, "")), h("span", { class: "dl-pct num" }, `${words.percent}%`)),
      h("div", { class: "dl-track", role: "progressbar", "aria-label": `${s.label} download`, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(words.percent) }, bar),
      h("div", { class: "dl-line num" }, words.detail),
    );
  }

  // Details of the running downloads, live, with Cancel.
  function openDownloads(anchor) {
    if (dlPop) {
      dlPop.close();
      return;
    }
    const rows = h("div", { class: "dl-rows" });
    const cancel = h("button", { type: "button", class: "btn ghost" }, h("span", null, "Cancel download"));
    cancel.addEventListener("click", () => {
      for (const s of downloadsNow()) ctx.bg?.cancelDownload?.(s.id);
    });
    // Every model, its size and the Delete buttons live in Settings.
    const manage = typeof ctx.ui.openSettings === "function" ? h("button", { type: "button", class: "btn ghost" }, h("span", null, "Models")) : null;
    manage?.addEventListener("click", () => {
      dlPop?.close();
      ctx.ui.openSettings({ tab: "background" });
    });
    const body = h(
      "div",
      { class: "dl-pop" },
      h("div", { class: "pop-head" }, h("span", { class: "pop-title" }, "Downloading background removal")),
      rows,
      h("p", { class: "dl-note" }, "A one-time download. Background removal then runs on this computer and works offline. Your images are never uploaded."),
      h("div", { class: "dl-actions" }, ...(manage ? [manage] : []), cancel),
    );
    let shownKey = "";
    const paint = () => {
      const list = downloadsNow();
      if (!list.length && !otherDownload) {
        dlPop?.close();
        return;
      }
      // Rows are drawn again only when the set changes; numbers update in place.
      const key = list.map((s) => s.id).join(",") || "other";
      if (key !== shownKey) {
        shownKey = key;
        rows.replaceChildren(...(list.length ? list.map(downloadRow) : [h("div", { class: "dl-row" }, h("div", { class: "dl-line" }, otherDownload.message || `${otherDownload.label}: ${Math.round(otherDownload.progress * 100)}%`))]));
      } else if (list.length) {
        [...rows.children].forEach((row, i) => {
          const s = list[i];
          const words = ctx.bg.describe(s);
          row.querySelector(".dl-bar").style.width = `${words.percent}%`;
          row.querySelector(".dl-pct").textContent = `${words.percent}%`;
          row.querySelector(".dl-track").setAttribute("aria-valuenow", String(words.percent));
          row.querySelector(".dl-line").textContent = words.detail;
        });
      }
      cancel.hidden = !list.length;
    };
    const handle = ctx.ui.popover?.(anchor, body, {
      placement: "bottom-start",
      width: 320,
      class: "dl-popover",
      onClose: () => {
        dlPop = null;
      },
    });
    // A click on the pill that just closed it (an outside click) opens nothing.
    if (!handle || handle.closed) return;
    dlPop = { close: () => handle.close(), paint };
    paint();
  }

  function modelChanged(s) {
    if (!s?.id) return;
    const was = lastState.get(s.id);
    lastState.set(s.id, s.state);
    paintDownloads();
    if (was !== "downloading" || s.state === "downloading") return;
    // Home's card shows the default model's outcome itself, unless a dialog covers it.
    const onHome = ctx.ui.isHomeOpen?.() && !ctx.ui.isBlocking?.() && s.id === ctx.bg?.defaultProvider;
    if (s.ready) {
      if (onHome) return;
      const name = String(s.label || "").replace(/\s*\(.*\)\s*$/, "");
      const first = s.id === ctx.bg?.defaultProvider || !name;
      ctx.ui.toast?.(first ? "Background removal is ready. It works offline now." : `${name} is ready. It works offline now.`, { kind: "ok", id: "bg-model-ready" });
    } else if (s.state === "error" && s.origin === "prepare" && !onHome) {
      // A removal reports its own failure; this one was a download on its own.
      ctx.ui.toast?.(s.error?.message || "The download stopped.", {
        kind: "error",
        id: "bg-model-error",
        action: { label: "Try again", run: () => ctx.bg?.prepare?.(s.id).catch(() => {}) },
      });
    }
  }

  // ---- wiring

  ctx.on("tool", (d) => {
    sticky = !!(d?.sticky ?? ctx.editor?.toolSticky);
    paintTools();
    paintContext();
  });
  ctx.on("zoom", (d) => paintZoom(d?.zoom));
  ctx.on("prefs", (d) => {
    if (["safeZones", "snap", "grid"].includes(d?.key)) paintToggles();
  });
  ctx.on("project", () => {
    refreshDoc();
    refreshCommands();
  });
  ctx.on("home", () => refreshCommands());
  ctx.on("presets", () => refreshDoc());
  ctx.on("command", (d) => {
    if (d?.id === "edit.undo") pulse(undoBtn);
    if (d?.id === "edit.redo") pulse(redoBtn);
  });
  ctx.on("bg-model", (s) => modelChanged(s));
  // A mod's own provider (or a browser without Cache Storage, where the worker
  // fetches the files itself) reports its download only as bg-progress.
  ctx.on("bg-progress", (d) => {
    if (!d) return;
    if (d.phase !== "download") {
      if (otherDownload?.provider === d.provider) {
        otherDownload = null;
        paintDownloads();
      }
      return;
    }
    // Built-in models' downloads are in their status (bg-model) already.
    if (ctx.bg?.status?.(d.provider)?.state === "downloading") return;
    otherDownload = { provider: d.provider, label: ctx.bg?.providers?.get?.(d.provider)?.label || "Model", progress: Number(d.progress) || 0, message: d.message || "" };
    paintDownloads();
  });
  ctx.tools.onChange(() => renderRail());
  ctx.shapes?.onChange?.(() => registerShapeCommands());
  ctx.commands.onChange?.(() => {
    refreshCommands();
    paintContext();
  });
  ctx.store?.addEventListener("change", (e) => {
    const r = e.detail?.reason;
    if (r === "docprops" || r === "setdoc" || r === "undo" || r === "redo" || r === "doc") refreshDoc();
    if (!e.detail?.transient) refreshCommands();
    paintContext();
  });
  ctx.store?.addEventListener("selection", () => {
    refreshCommands();
    paintContext();
  });
  ctx.store?.addEventListener("history", () => refreshHistory());

  renderRail();
  registerShapeCommands();
  refreshDoc();
  refreshCommands();
  paintZoom();
  paintToggles();

  return {
    setSaveState,
    refresh: () => {
      refreshDoc();
      refreshCommands();
      paintZoom();
      paintToggles();
      paintContext();
    },
    togglePanel,
    openCanvasSize: () => openCanvasSize(presetChip),
  };
}
