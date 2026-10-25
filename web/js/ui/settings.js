// Settings: one modal with seven tabs. General (theme, canvas aids, storage),
// Background removal (models, downloads, default), Fonts, Mods, Packs,
// Shortcuts and About.
// openSettings(ctx, { tab }) opens it, or switches tabs when it is open.
// The app loads this module on demand (mods/loader.js openSettings), so it
// imports nothing that is not already loaded at boot.

import { h, svg, clear, disposer, isMac } from "./dom.js";
import { button, iconButton, toggle, segmented } from "./controls.js";
import { icon } from "./icons.js";
import { keysLabel } from "../app/context.js";
import { THEMES } from "./theme.js";
import { countsText, packCounts, plural, listText } from "../mods/packs.js";
import { ensureModIcons, ensureModStyles } from "../mods/ui.js";

export { ensureModIcons, ensureModStyles } from "../mods/ui.js";

export const LINKS = Object.freeze({
  source: "https://github.com/zphat/Longitude",
  modding: "https://github.com/zphat/Longitude/blob/main/docs/MODDING.md",
  latitude: "https://github.com/zphat/Latitude",
  sundial: "https://github.com/zphat/Sundial",
});

const TABS = [
  { id: "general", label: "General", icon: "sliders-horizontal", render: generalTab },
  { id: "background", label: "Background removal", icon: "remove-bg", render: bgTab },
  { id: "fonts", label: "Fonts", icon: "type", render: fontsTab },
  { id: "mods", label: "Mods", icon: "puzzle", render: modsTab },
  { id: "packs", label: "Packs", icon: "package", render: packsTab },
  { id: "shortcuts", label: "Shortcuts", icon: "keyboard", render: shortcutsTab },
  { id: "about", label: "About", icon: "info", render: aboutTab },
];

const WEIGHT_NAMES = { 100: "Thin", 200: "Extra light", 300: "Light", 400: "Regular", 500: "Medium", 600: "Semibold", 700: "Bold", 800: "Extra bold", 900: "Black" };
const GROUP_ORDER = ["File", "Edit", "Tools", "Tool", "Insert", "Layer", "Arrange", "Align", "Text", "Image", "Shape", "View", "Export", "App"];

const FONT_FILE = /\.(ttf|otf|woff2?)$/i;
const PACK_FILE = /\.json$/i;

let current = null;

// Decimal units, rounded up, the same way the export dialog shows sizes
// (features/compress.js), without loading the export engine for one helper.
export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1000) return `${Math.ceil(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1000;
  let u = 0;
  for (;;) {
    let decimals = 1;
    let rounded = Math.ceil(v * 10 - 1e-9) / 10;
    if (rounded >= 100) {
      decimals = 0;
      rounded = Math.ceil(v - 1e-9);
    }
    if (rounded >= 1000 && u < units.length - 1) {
      v /= 1000;
      u++;
      continue;
    }
    return `${rounded.toFixed(decimals)} ${units[u]}`;
  }
}

// Files dropped on Settings -> { fonts: File[], pack: File | null }. Fonts and
// .json packs are told apart by name; a file of another kind goes to the tab
// on screen (Fonts or Packs), which then says what it takes.
export function sortDrop(files, tab = "") {
  const fonts = [];
  const packs = [];
  const other = [];
  for (const f of files || []) {
    if (!f) continue;
    const name = f.name || "";
    if (FONT_FILE.test(name) || /^font\//.test(f.type || "")) fonts.push(f);
    else if (PACK_FILE.test(name) || f.type === "application/json") packs.push(f);
    else other.push(f);
  }
  if (tab === "fonts") fonts.push(...other);
  else if (tab === "packs" && !packs.length && other.length) packs.push(other[0]);
  return { fonts, pack: packs[0] || null };
}

// openSettings(ctx, { tab = "general", pack }) -> { close }
//   pack: a File, JSON text or object to review on the Packs tab right away.
export function openSettings(ctx, { tab = "general", pack = null } = {}) {
  if (!globalThis.document) return { close() {} };
  ensureModStyles();
  ensureModIcons();
  if (!current) current = createSettings(ctx);
  const want = tab === "bg" ? "background" : tab;
  current.show(TABS.some((t) => t.id === want) ? want : "general");
  if (pack) current.reviewPack(pack);
  return { close: current.close };
}

// ---- modal -------------------------------------------------------------------

function createSettings(ctx) {
  const prevFocus = document.activeElement;
  const offs = disposer();
  let view = null; // { id, d: disposer, hooks }
  let closed = false;
  let layer = null;

  const heading = h("h2", { class: "settings-h", id: "settings-heading" });
  const body = h("div", { class: "settings-body", role: "tabpanel", tabindex: "-1", "aria-labelledby": "settings-heading" });
  const tabButtons = new Map();
  const nav = h("nav", { class: "settings-nav", role: "tablist", "aria-orientation": "vertical", "aria-label": "Settings sections" });
  nav.append(h("div", { class: "settings-brand micro" }, "Settings"));
  for (const t of TABS) {
    const b = h(
      "button",
      { type: "button", class: "settings-tab", role: "tab", id: `settings-tab-${t.id}`, "aria-selected": "false", tabindex: "-1", onClick: () => show(t.id) },
      icon(t.icon, { size: "sm" }),
      h("span", null, t.label)
    );
    tabButtons.set(t.id, b);
    nav.append(b);
  }
  nav.addEventListener("keydown", (e) => {
    const keys = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
    if (!(e.key in keys) && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const i = TABS.findIndex((t) => t.id === view?.id);
    const n = e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : (i + keys[e.key] + TABS.length) % TABS.length;
    show(TABS[n].id);
    tabButtons.get(TABS[n].id).focus();
  });

  const closeBtn = iconButton({ icon: "x", tip: "Close", kbd: "Esc", onClick: () => close() });
  const panel = h(
    "div",
    { class: "settings island", role: "dialog", "aria-modal": "true", "aria-label": "Settings" },
    nav,
    h("div", { class: "settings-main" }, h("header", { class: "settings-head" }, heading, closeBtn), body)
  );
  const scrim = h("div", { class: "settings-scrim", onClick: () => close() });
  const root = h("div", { class: "settings-layer" }, scrim, panel);

  // Keys inside Settings never reach the editor's shortcuts.
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (!view?.hooks.escape?.()) close();
    } else if (e.key === "Tab") {
      trapFocus(panel, e);
    }
    e.stopPropagation();
  });
  const outsideKeys = (e) => {
    if (root.contains(e.target)) return;
    if (e.target !== document.body && e.target !== document.documentElement) return;
    e.stopPropagation();
    if (e.key === "Escape") close();
    else tabButtons.get(view?.id)?.focus();
  };
  window.addEventListener("keydown", outsideKeys, true);
  offs(() => window.removeEventListener("keydown", outsideKeys, true));

  // Files dropped anywhere on Settings: fonts are added, a pack opens its
  // review. The ring around the dialog says it will take them. dragover
  // repeats while files hover, so the ring goes once it stops.
  let dragTimer = 0;
  const dragEnd = () => {
    clearTimeout(dragTimer);
    panel.classList.remove("dropping");
  };
  root.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    panel.classList.add("dropping");
    clearTimeout(dragTimer);
    dragTimer = setTimeout(dragEnd, 160);
  });
  root.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragEnd();
    takeFiles([...e.dataTransfer.files]);
  });
  offs(dragEnd);

  document.body.append(root);
  // On ctx.ui's layer stack: the app behind is inert and shortcuts stay
  // quiet. Escape stays with Settings (a tab may take it first).
  layer = ctx.ui?.pushLayer?.({ kind: "dialog", el: root, close: () => close(), modal: true, escape: false }) || null;
  requestAnimationFrame(() => root.classList.add("open"));
  setTimeout(() => root.classList.add("open"), 30);

  function show(id) {
    if (closed) return;
    if (view?.id === id) return;
    view?.d.dispose();
    const tab = TABS.find((t) => t.id === id) || TABS[0];
    for (const [tid, b] of tabButtons) {
      const on = tid === tab.id;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle("on", on);
    }
    heading.textContent = tab.label;
    body.setAttribute("aria-labelledby", `settings-tab-${tab.id}`);
    clear(body);
    body.scrollTop = 0;
    view = { id: tab.id, d: disposer(), hooks: {} };
    const env = { d: view.d, hooks: view.hooks, show, close };
    try {
      body.append(tab.render(ctx, env));
    } catch (err) {
      console.error(err);
      body.append(note(`This section could not open: ${err.message}`, "error"));
    }
    if (!panel.contains(document.activeElement)) tabButtons.get(tab.id).focus();
  }

  function close() {
    if (closed) return;
    closed = true;
    // Before focus goes back: an inert element can not take it.
    if (layer) ctx.ui.dropLayer?.(layer);
    layer = null;
    view?.d.dispose();
    offs.dispose();
    current = null;
    root.classList.remove("open");
    root.classList.add("closing");
    setTimeout(() => root.remove(), 180);
    if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === "function") prevFocus.focus();
  }

  function reviewPack(input) {
    show("packs");
    view?.hooks.importPack?.(input);
  }

  function takeFiles(files) {
    if (closed || !files.length) return;
    const { fonts, pack } = sortDrop(files, view?.id);
    if (!fonts.length && !pack) {
      toast(ctx, "Settings takes font files (.ttf, .otf, .woff, .woff2) and packs (.json).", { kind: "warn" });
      return;
    }
    if (pack) reviewPack(pack);
    else show("fonts");
    if (fonts.length) (view?.hooks.addFonts || ((list) => addFontFiles(ctx, list)))(fonts);
  }

  return { show, close, reviewPack };
}

const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");

// Tab order: tabs and theme cards keep only their current item reachable
// (tabindex -1 on the rest), so those are left out of the wrap-around.
const FOCUSABLE = ["button", "[href]", "input", "select", "textarea", "summary", "[tabindex]"].map((s) => `${s}:not([tabindex="-1"])`).join(", ");

function trapFocus(panel, e) {
  const items = [...panel.querySelectorAll(FOCUSABLE)].filter((el) => !el.disabled && !el.hidden && el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

// ---- small building blocks -----------------------------------------------------

function group(title, text, ...children) {
  return h(
    "section",
    { class: "set-group" },
    h("div", { class: "set-group-head" }, h("h3", { class: "set-group-title" }, title), text ? h("p", { class: "set-note" }, text) : null),
    ...children
  );
}

// kind: "info" | "attention" | "error"
function note(text, kind = "info", iconName) {
  const name = iconName || (kind === "error" ? "alert-circle" : kind === "attention" ? "shield" : "info");
  return h("div", { class: ["set-callout", kind] }, icon(name, { size: "sm" }), h("div", null, text));
}

function linkButton(label, href, iconName, kind = "ghost") {
  return h(
    "a",
    { class: ["btn", kind], href, target: "_blank", rel: "noopener noreferrer" },
    iconName ? icon(iconName, { size: "sm" }) : null,
    h("span", null, label),
    icon("external-link", { size: "sm", class: "set-ext" })
  );
}

function kbd(text) {
  return h("kbd", null, text);
}

function toast(ctx, msg, opts) {
  ctx.ui?.toast?.(msg, opts);
}

// A remove button that asks inline before it acts.
function removeButton({ label = "Remove", question = "Remove?", tip, onConfirm }) {
  const wrap = h("div", { class: "set-confirm" });
  const idle = () => {
    clear(wrap).append(iconButton({ icon: "trash-2", tip: tip || label, size: "sm", onClick: ask }));
  };
  const ask = () => {
    clear(wrap);
    const no = button({ label: "Keep", kind: "ghost", onClick: () => {
      idle();
      wrap.querySelector("button")?.focus();
    } });
    const yes = button({ label, kind: "danger", onClick: async () => {
      yes.setDisabled(true);
      no.setDisabled(true);
      try {
        await onConfirm();
      } catch (err) {
        console.error(err);
        idle();
      }
    } });
    wrap.append(h("span", { class: "set-confirm-q" }, question), no, yes);
    yes.focus();
  };
  idle();
  return wrap;
}

function themeCard(theme, { active = false, onPick = null, badge = "" } = {}) {
  const c = theme.colors;
  const preview = h(
    "span",
    { class: "tc-preview", style: { background: c.bg } },
    h(
      "span",
      { class: "tc-island", style: { background: c.panel, borderColor: c.line } },
      h("span", { class: "tc-line", style: { background: c.text } }),
      h("span", { class: "tc-line short", style: { background: c.muted } }),
      h("span", { class: "tc-pill", style: { background: c.accent } })
    ),
    h("span", { class: "tc-dots" }, ["highlight", "red", "green"].map((k) => h("span", { class: "tc-dot", style: { background: c[k] } })))
  );
  const meta = h(
    "span",
    { class: "tc-meta" },
    h("span", { class: "tc-name" }, theme.name, badge ? h("span", { class: "tc-badge" }, badge) : null),
    theme.note ? h("span", { class: "tc-note" }, theme.note) : null
  );
  const check = h("span", { class: "tc-check" }, icon("check", { size: "sm" }));
  if (!onPick) return h("div", { class: "theme-card static" }, preview, meta);
  const card = h("button", { type: "button", class: "theme-card", role: "radio", onClick: () => onPick(theme.id) }, preview, meta, check);
  card.setActive = (on) => {
    card.classList.toggle("on", on);
    card.setAttribute("aria-checked", String(on));
    card.setAttribute("tabindex", on ? "0" : "-1");
  };
  card.setActive(active);
  return card;
}

function weightsText(info) {
  const parts = [];
  if (info.variable) parts.push(`Variable, ${info.variable.min} to ${info.variable.max}`);
  else parts.push(listText((info.weights || [400]).map((w) => WEIGHT_NAMES[w] || String(w))));
  if (info.italic) parts.push("italic");
  return parts.join(", ");
}

function swatches(colors) {
  return h("span", { class: "set-swatches" }, colors.map((c) => h("span", { class: "set-swatch", style: { background: c }, title: c })));
}

function simpleRow(title, sub, ...extra) {
  return h(
    "div",
    { class: "set-row" },
    h("div", { class: "set-row-main" }, h("div", { class: "set-row-title" }, title), sub ? h("div", { class: "set-row-sub" }, sub) : null),
    ...extra
  );
}

// ---- General -------------------------------------------------------------------

function generalTab(ctx, env) {
  const el = h("div", { class: "set-stack" });
  el.append(themeGroup(ctx, env), canvasGroup(ctx, env));
  if (ctx.bg?.providers) el.append(bgPointer(ctx, env));
  // The desktop app registers the update check (app/desktop.js); a browser has none.
  if (ctx.commands?.get?.("app.check-updates")) el.append(updatesGroup(ctx, env));
  el.append(storageGroup(ctx, env));
  return el;
}

// The desktop app's daily look at GitHub's latest release (prefs updateCheck, on by default).
function updatesGroup(ctx, env) {
  const sw = toggle({
    value: ctx.prefs.get("updateCheck", true) !== false,
    tip: "Check for updates once a day",
    onChange: (on) => ctx.prefs.set("updateCheck", on),
  });
  const label = h(
    "div",
    { class: "set-row-main" },
    h("div", { class: "set-row-title" }, "Check for updates once a day"),
    h("div", { class: "set-row-sub" }, "Once a day, Longitude asks GitHub whether a newer version is out. Nothing about you or your designs is sent."),
  );
  label.addEventListener("click", () => sw.click());
  env.d(ctx.on("prefs", ({ key, value } = {}) => {
    if (key === "updateCheck") sw.value = value !== false;
  }));
  const now = button({ label: "Check now", kind: "ghost", onClick: () => ctx.commands.run("app.check-updates") });
  const version = ctx.version ? `This is Longitude ${ctx.version}.` : "";
  return group(
    "Updates",
    version || null,
    h(
      "div",
      { class: "set-list plain" },
      h("div", { class: "set-row toggle-row" }, label, sw),
      h("div", { class: "set-row" }, h("div", { class: "set-row-main" }, h("div", { class: "set-row-title" }, "Look now"), h("div", { class: "set-row-sub" }, "Your designs never leave this computer.")), now),
    ),
  );
}

// Where background removal stands, with the way to its own tab.
function bgPointer(ctx, env) {
  const sub = h("div", { class: "set-row-sub" });
  const paint = () => {
    const s = ctx.bg.status?.();
    const p = ctx.bg.providers.get(ctx.bg.defaultProvider);
    const words = s && ctx.bg.describe ? ctx.bg.describe(s) : null;
    const state = !s ? "" : s.kind !== "ml" ? "no download" : s.state === "checking" ? "" : words.label.toLowerCase();
    sub.textContent = [p ? shortName(p.label) : "", state].filter(Boolean).join(", ");
  };
  paint();
  env.d(ctx.on("bg-model", (s) => s?.id === ctx.bg.defaultProvider && paint()));
  env.d(ctx.on("prefs", ({ key } = {}) => key === "bgProvider" && paint()));
  const open = button({ label: "Manage", kind: "ghost", onClick: () => env.show("background") });
  return group(
    "Background removal",
    null,
    h("div", { class: "set-list plain" }, h("div", { class: "set-row" }, h("div", { class: "set-row-main" }, h("div", { class: "set-row-title" }, "Default model"), sub), open)),
  );
}

function themeGroup(ctx, env) {
  const grid = h("div", { class: "theme-grid", role: "radiogroup", "aria-label": "Theme" });
  let cards = new Map();
  const builtIn = new Set(THEMES.map((t) => t.id));
  // One card is in the tab order: the current theme, else the first.
  const reachable = () => {
    const list = [...cards.values()];
    if (list.length && !list.some((c) => c.getAttribute("tabindex") === "0")) list[0].setAttribute("tabindex", "0");
  };
  const paint = () => {
    const hadFocus = grid.contains(document.activeElement);
    clear(grid);
    cards = new Map();
    const list = ctx.themes?.list() || [];
    const active = ctx.themes?.current()?.id;
    for (const t of list) {
      const badge = builtIn.has(t.id) ? "" : t.id.startsWith("pk-") ? "Pack" : "Mod";
      const card = themeCard(t, { active: t.id === active, badge, onPick: (id) => ctx.themes.apply(id) });
      cards.set(t.id, card);
      grid.append(card);
    }
    reachable();
    if (hadFocus) (cards.get(active) || grid.firstChild)?.focus();
  };
  // Arrow keys move through the themes and apply each one, like any radio group.
  grid.addEventListener("keydown", (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    const list = [...cards.values()];
    const i = list.indexOf(e.target);
    if (!step || i < 0) return;
    e.preventDefault();
    const next = list[(i + step + list.length) % list.length];
    next.focus();
    next.click();
  });
  paint();
  env.d(ctx.on("themes", paint));
  env.d(ctx.on("theme", ({ id } = {}) => {
    for (const [tid, card] of cards) card.setActive(tid === id);
    reachable();
  }));
  return group("Theme", "Themes color Longitude itself, never your designs.", grid);
}

const CANVAS_PREFS = [
  { key: "snap", fallback: true, label: "Snap to guides", text: "Layers pull to the center, the edges and other layers while you drag. Hold Ctrl to move freely." },
  { key: "safeZones", fallback: true, overlay: "safe", label: "Safe zones", text: "Shows what YouTube and Spotify cover, like the video length badge." },
  { key: "grid", fallback: false, overlay: "grid", label: "Rule-of-thirds grid", text: "Splits the canvas in thirds, for placing faces and big text." },
];

function canvasGroup(ctx, env) {
  const rows = new Map();
  const list = h("div", { class: "set-list plain" });
  for (const p of CANVAS_PREFS) {
    const sw = toggle({
      value: !!ctx.prefs.get(p.key, p.fallback),
      tip: p.label,
      onChange: (on) => {
        ctx.prefs.set(p.key, on);
        if (p.overlay) ctx.editor?.setOverlay?.(p.overlay, on);
        if (p.key === "snap" && ctx.editor && "snapEnabled" in ctx.editor) ctx.editor.snapEnabled = on;
        ctx.editor?.requestRender?.();
      },
    });
    const label = h("div", { class: "set-row-main" }, h("div", { class: "set-row-title" }, p.label), h("div", { class: "set-row-sub" }, p.text));
    label.addEventListener("click", () => sw.click());
    rows.set(p.key, { sw, p });
    list.append(h("div", { class: "set-row toggle-row" }, label, sw));
  }
  env.d(ctx.on("prefs", ({ key, value } = {}) => {
    const r = rows.get(key);
    if (r) r.sw.value = value === undefined ? r.p.fallback : !!value;
  }));
  return group("Canvas", "These stay on or off until you change them, here or under the canvas.", list);
}

const shortName = (label) => String(label || "").replace(/\s*\(.*\)\s*$/, "") || "Model";

// The Background removal tab's privacy note, the Models subtitle and the
// runtime line, from the model statuses: what is already on this computer
// (the desktop installer, or tools/fetch_model.py's web/vendor/) never
// downloads, so the copy names only what still does. Models built from
// BG_CONFIG only (status.model); Magic and mods' providers do not count.
export function bgCopy(statuses = []) {
  const ml = statuses.filter((s) => s?.kind === "ml" && s.model);
  const here = ml.filter((s) => s.state === "ready-bundled");
  const join = (n) => (n.length > 1 ? `${n.slice(0, -1).join(", ")} and ${n.at(-1)}` : n[0] || "");
  const names = (list, ...more) => join([...list.map((s) => shortName(s.label)), ...more]);
  const lead = "Background removal runs on this computer. Your images are never uploaded.";
  if (!here.length) {
    return {
      note: `${lead} Its only network requests are these one-time downloads: models from Hugging Face, the runtime from jsDelivr.`,
      models: "Each model downloads once, then works offline.",
      runtime: "which comes once, with the first one",
    };
  }
  // The installer bundles the runtime with Fast; fetch_model.py fetches both too.
  const where = here.some((s) => s.bundledBy !== "vendor") ? "included with the app" : "already on this computer (web/vendor)";
  const rest = ml.filter((s) => s.state !== "ready-bundled");
  const one = rest.length === 1;
  return {
    note: `${lead} ${names(here, "the runtime")} are ${where}.${rest.length ? ` Only ${names(rest)} ${one ? "downloads" : "download"}, once, from Hugging Face.` : " Nothing here needs a download."}`,
    models: rest.length ? `${names(rest)} ${one ? "downloads" : "download"} once, then ${one ? "works" : "work"} offline.` : "Everything here works offline.",
    runtime: `which is ${where}`,
  };
}

// ---- Background removal ----------------------------------------------------------

function bgTab(ctx, env) {
  const el = h("div", { class: "set-stack" });
  const bg = ctx.bg;
  if (!bg?.providers) {
    el.append(note("Background removal is not available here.", "error"));
    return el;
  }
  // The engine's exact sizes (the runtime build and model file this machine
  // uses); until they arrive the status shows its estimate.
  for (const p of bg.providers.list()) if (p.kind === "ml") bg.modelInfo?.(p.id).catch(() => {});
  bg.refreshStatus?.().catch?.(() => {});
  // The copy follows what is here; the first paint is often still "checking".
  const copy = () => bgCopy(bg.providers.list().map((p) => bg.status?.(p.id)));
  const privacy = note(copy().note, "attention", "shield");
  el.append(modelsGroup(ctx, env, copy), defaultGroup(ctx, env), bgStorageGroup(ctx, env), privacy);
  env.d(ctx.on("bg-model", () => {
    privacy.lastChild.textContent = copy().note;
  }));
  return el;
}

function modelsGroup(ctx, env, copy = () => bgCopy([])) {
  const bg = ctx.bg;
  const list = h("div", { class: "set-list bg-models" });
  const rows = new Map(); // providerId -> { el, key, paint }

  const meta = (p) => {
    const bits = [];
    if (p.license) bits.push(h("span", null, p.license));
    const link = (label, href) => h("a", { class: "set-link", href, target: "_blank", rel: "noopener noreferrer" }, label, icon("external-link", { size: "sm", class: "set-ext" }));
    if (p.page) bits.push(link("Model page", p.page));
    if (p.source && p.source !== p.page) bits.push(link("Project", p.source));
    return h("div", { class: "bg-model-meta" }, bits.flatMap((b, i) => (i ? [h("span", { class: "dotsep", "aria-hidden": "true" }, "·"), b] : [b])));
  };

  function actionsFor(p, s) {
    // Only models built from BG_CONFIG (s.model) can be downloaded or deleted here.
    if (s.kind !== "ml" || !s.model) return [];
    if (s.state === "downloading") return [button({ label: "Cancel", kind: "ghost", onClick: () => bg.cancelDownload?.(p.id) })];
    // Nothing to keep in a browser that keeps no downloads for this site.
    if ((s.state === "not-downloaded" || s.state === "error") && s.storable !== false) {
      return [
        button({
          label: s.state === "error" ? "Try again" : "Download",
          icon: s.state === "error" ? "refresh-cw" : "download",
          kind: "ghost",
          onClick: () => bg.prepare?.(p.id).catch(() => {}),
        }),
      ];
    }
    if (s.state === "ready-cached") {
      return [
        removeButton({
          label: "Delete",
          question: "Delete this download?",
          tip: `Delete the ${shortName(p.label)} download`,
          onConfirm: async () => {
            await bg.remove?.(p.id);
            toast(ctx, `Deleted. ${shortName(p.label)} downloads again the next time you use it.`, { kind: "ok" });
          },
        }),
      ];
    }
    return [];
  }

  function rowFor(p) {
    const s = bg.status?.(p.id);
    if (!s) return null;
    const words = bg.describe(s);
    const chip = h("span", { class: ["bg-chip", s.state, s.kind !== "ml" && "local"] }, words.label);
    // While downloading the progress line says it all, and the row's key stays
    // the same, so the row (and its Cancel) is updated in place, not rebuilt.
    // A ready model counts its own file: the runtime is shared (the foot says so).
    let sizeText = "";
    if (s.kind !== "ml" || s.state === "checking" || s.state === "downloading") sizeText = "";
    else if (s.state === "ready-bundled") sizeText = s.bundledBy === "vendor" ? "In web/vendor. To remove it, run python tools/fetch_model.py --clean" : "";
    else if (s.ready) sizeText = `${bg.format.mb(s.modelBytes || s.sizeBytes)} on this computer`;
    else sizeText = words.short;
    const main = h(
      "div",
      { class: "set-row-main" },
      h("div", { class: "bg-model-title" }, h("span", { class: "set-row-title" }, shortName(p.label)), chip),
      p.note ? h("div", { class: "set-row-sub" }, p.note) : null,
      sizeText || s.state === "error" ? h("div", { class: ["set-row-sub", "num", s.state === "error" && "bg-model-err"] }, s.state === "error" ? words.detail : sizeText) : null,
      meta(p),
    );
    const body = [main];
    let live = null;
    if (s.state === "downloading") {
      const bar = h("span", { class: "bg-bar" });
      const track = h("div", { class: "bg-track", role: "progressbar", "aria-label": `${shortName(p.label)} download`, "aria-valuemin": "0", "aria-valuemax": "100" }, bar);
      const line = h("div", { class: "set-row-sub num" });
      main.append(track, line);
      live = (st) => {
        const w = bg.describe(st);
        bar.style.width = `${w.percent}%`;
        track.setAttribute("aria-valuenow", String(w.percent));
        line.textContent = w.detail;
      };
      live(s);
    }
    const acts = actionsFor(p, s);
    if (acts.length) body.push(h("div", { class: "set-actions bg-model-actions" }, acts));
    const el = h("div", { class: "set-row bg-model", "data-id": p.id }, body);
    return { el, key: `${s.state}|${s.label}|${sizeText}|${s.error?.message || ""}`, live };
  }

  const paintAll = () => {
    const hadFocus = list.contains(document.activeElement) ? document.activeElement.closest?.(".bg-model")?.dataset.id : null;
    rows.clear();
    clear(list);
    for (const p of bg.providers.list()) {
      const r = rowFor(p);
      if (!r) continue;
      rows.set(p.id, r);
      list.append(r.el);
    }
    if (hadFocus) (rows.get(hadFocus)?.el.querySelector("button") || list).focus?.();
  };

  const paintOne = (s) => {
    const r = rows.get(s?.id);
    const p = bg.providers.get(s?.id);
    if (!r || !p) return paintAll();
    const next = rowFor(p);
    if (!next) return;
    if (next.key === r.key) {
      r.live?.(s);
      return;
    }
    const hadFocus = r.el.contains(document.activeElement);
    r.el.replaceWith(next.el);
    rows.set(p.id, next);
    if (hadFocus) (next.el.querySelector("button") || next.el).focus?.();
  };

  const ort = bg.config?.ort;
  const runtime = ort ? h("p", { class: "set-foot" }) : null;
  const sec = group("Models", " ", list, runtime);
  const sub = sec.querySelector(".set-group-head .set-note");
  const paintCopy = () => {
    const c = copy();
    if (sub) sub.textContent = c.models;
    if (runtime) runtime.textContent = `Every model runs on ONNX Runtime Web ${ort.version} (${ort.license || "MIT"}), ${c.runtime}.`;
  };
  paintAll();
  paintCopy();
  env.d(ctx.on("bg-model", (s) => {
    paintOne(s);
    paintCopy();
  }));
  if (typeof bg.providers.onChange === "function") env.d(bg.providers.onChange(paintAll));
  return sec;
}

function defaultGroup(ctx, env) {
  const bg = ctx.bg;
  const providers = bg.providers.list();
  const seg = segmented({
    options: providers.map((p) => ({ value: p.id, label: shortName(p.label) })),
    value: bg.defaultProvider,
    full: true,
    onChange: (id) => bg.setDefaultProvider?.(id),
  });
  env.d(ctx.on("prefs", ({ key } = {}) => {
    if (key === "bgProvider" && seg.value !== bg.defaultProvider) seg.set?.(bg.defaultProvider);
  }));
  return group("Default model", "What Remove background uses in the editor and in quick tools. You can switch for one image there too.", seg);
}

function bgStorageGroup(ctx, env) {
  const bg = ctx.bg;
  const row = h("div", { class: "set-row" });
  let busy = false;
  const paint = async () => {
    let usage = null;
    try {
      usage = (await bg.storage?.()) || (await bg.cacheUsage?.());
    } catch {}
    clear(row);
    // The same rounding as the model rows above ("58 MB on this computer").
    const size = (n) => (bg.format?.mb ? bg.format.mb(n) : formatBytes(n));
    const parts = [];
    if (usage?.bytes) parts.push(`${size(usage.bytes)} downloaded`);
    if (usage?.bundledBytes) parts.push(`${size(usage.bundledBytes)} ${usage.bundledBy === "vendor" ? "in web/vendor" : "included with the app"}`);
    const main = h("div", { class: "set-row-main" }, h("div", { class: "set-row-title" }, "Space used"), h("div", { class: "set-row-sub num" }, parts.join(" · ") || "Nothing downloaded yet."));
    row.append(main);
    if (!usage?.bytes) return;
    row.append(
      removeButton({
        label: "Delete all",
        question: "Delete all downloads?",
        tip: "Delete every downloaded model",
        onConfirm: async () => {
          try {
            await bg.release?.();
          } catch {}
          const ok = await bg.clearCache?.();
          toast(ctx, ok ? "Deleted. A model downloads again the next time you need it." : "The downloads could not be deleted.", { kind: ok ? "ok" : "error" });
          paint();
        },
      }),
    );
  };
  paint();
  // Sizes change when a download finishes or one is deleted.
  env.d(ctx.on("bg-model", (s) => {
    if (busy || s?.state === "downloading" || s?.state === "checking") return;
    busy = true;
    setTimeout(() => {
      busy = false;
      paint();
    }, 150);
  }));
  return group("Storage", "Downloads stay on this computer until you delete them.", h("div", { class: "set-list plain" }, row));
}

function storageGroup(ctx, env) {
  const fill = h("span", { class: "set-meter-fill" });
  const meter = h("div", { class: "set-meter", role: "img", "aria-label": "Storage used" }, fill);
  const usage = h("p", { class: "set-note" }, "Checking storage...");
  const keepRow = h("div", { class: "set-row" });
  const storage = globalThis.navigator?.storage;

  const refresh = async () => {
    let est = null;
    try {
      est = await storage?.estimate?.();
    } catch {}
    if (!est || !Number.isFinite(est.usage)) {
      meter.hidden = true;
      usage.textContent = ctx.desktop ? "Longitude cannot tell how much space it uses." : "This browser does not say how much space Longitude uses.";
      return;
    }
    const pct = est.quota > 0 ? Math.min(100, (est.usage / est.quota) * 100) : 0;
    fill.style.width = `${Math.max(pct, est.usage > 0 ? 1.5 : 0)}%`;
    // Nearly full: the meter turns sun-gold, the color for "pay attention".
    meter.classList.toggle("high", pct >= 80);
    meter.setAttribute("aria-label", `${formatBytes(est.usage)} used`);
    usage.textContent = est.quota > 0
      ? `Designs, images and fonts use ${formatBytes(est.usage)} of about ${formatBytes(est.quota)} ${ctx.desktop ? "Longitude can use" : "this browser allows"}.`
      : `Designs, images and fonts use ${formatBytes(est.usage)}.`;
  };

  const paintKeep = async () => {
    clear(keepRow);
    // The desktop app has a storage folder of its own; main.js asks for
    // persistence once, quietly (keepStorage).
    if (ctx.desktop || typeof storage?.persisted !== "function") return;
    let kept = false;
    try {
      kept = await storage.persisted();
    } catch {}
    if (kept) {
      keepRow.append(h("div", { class: "set-row-main" }, h("div", { class: "set-row-title" }, "Kept safe"), h("div", { class: "set-row-sub" }, "The browser keeps your designs even when the disk runs low.")));
      return;
    }
    const keep = button({
      label: "Keep my designs",
      kind: "ghost",
      onClick: async () => {
        let ok = false;
        try {
          ok = await storage.persist();
        } catch {}
        toast(ctx, ok ? "The browser will keep your designs." : "The browser did not allow it. Save important designs as .longitude files.", { kind: ok ? "ok" : "warn" });
        paintKeep();
      },
    });
    keepRow.append(h("div", { class: "set-row-main" }, h("div", { class: "set-row-title" }, "Ask the browser to keep data"), h("div", { class: "set-row-sub" }, "Without this, the browser may clear saved designs when the disk is nearly full.")), keep);
  };

  const gc = button({
    label: "Clear unused images",
    icon: "trash-2",
    onClick: async () => {
      if (!ctx.assets?.gc) return;
      gc.setDisabled(true);
      gc.setLabel("Clearing...");
      try {
        const keep = ctx.store?.referencedAssets?.() || [];
        const n = await ctx.assets.gc([...keep]);
        toast(ctx, n ? `Cleared ${plural(n, "unused image")}.` : "No unused images to clear.", { kind: n ? "ok" : "info" });
      } catch (err) {
        toast(ctx, err.message || "The images could not be cleared.", { kind: "error" });
      } finally {
        gc.setDisabled(false);
        gc.setLabel("Clear unused images");
        refresh();
      }
    },
  });
  gc.setDisabled(!ctx.assets?.gc);
  const gcRow = h(
    "div",
    { class: "set-row" },
    h("div", { class: "set-row-main" }, h("div", { class: "set-row-title" }, "Unused images"), h("div", { class: "set-row-sub" }, "Removes images no saved design uses. Images from this session stay until you reload.")),
    gc
  );
  refresh();
  paintKeep();
  return group("Storage", null, meter, usage, h("div", { class: "set-list plain" }, gcRow, keepRow));
}

// ---- Fonts ---------------------------------------------------------------------

// Adds font files to this browser and says how it went. busy: the button to
// show "Adding..." on while it works (optional).
async function addFontFiles(ctx, files, busy = null) {
  const fonts = ctx.fonts;
  if (!fonts?.addCustom) {
    toast(ctx, "Fonts are still loading. Try again in a moment.", { kind: "warn" });
    return;
  }
  busy?.setDisabled(true);
  busy?.setLabel("Adding...");
  const added = [];
  try {
    for (const f of files) {
      try {
        added.push(await fonts.addCustom(f));
      } catch (err) {
        toast(ctx, `${f.name}: ${err.message}`, { kind: "error" });
      }
    }
  } finally {
    busy?.setDisabled(false);
    busy?.setLabel("Add a font file");
  }
  if (added.length === 1) toast(ctx, `Added ${added[0]}. Find it under Yours in the font picker.`, { kind: "ok" });
  else if (added.length > 1) toast(ctx, `Added ${plural(new Set(added).size, "font")}. Find them under Yours in the font picker.`, { kind: "ok" });
}

function fontsTab(ctx, env) {
  const el = h("div", { class: "set-stack" });
  const fonts = ctx.fonts;
  if (!fonts) {
    el.append(note("Fonts are still loading. Open this tab again in a moment."));
    return el;
  }
  const input = h("input", { type: "file", accept: ".ttf,.otf,.woff,.woff2", multiple: true, hidden: true });
  const add = button({ label: "Add a font file", icon: "upload", kind: "primary", onClick: () => input.click() });
  input.addEventListener("change", () => {
    const files = [...input.files];
    input.value = "";
    if (files.length) addFontFiles(ctx, files, add);
  });
  env.hooks.addFonts = (files) => addFontFiles(ctx, files, add);

  const yours = h("div", { class: "set-list drop-target" });
  const fromMods = h("div", { class: "set-list" });
  const modGroup = group("From mods and packs", "Mods and packs can add fonts. Turn the mod off or remove the pack to remove them.", fromMods);
  const footer = h("p", { class: "set-foot" });

  const row = (info, removable) => {
    fonts.load(info.family, info.defaultWeight || 400, "normal", { retry: true }).catch(() => {});
    const sample = h("span", { class: "font-sample", style: { fontFamily: fonts.stack(info.family) }, "aria-hidden": "true" }, "Aa");
    const main = h(
      "div",
      { class: "set-row-main" },
      h("div", { class: "set-row-title" }, info.label || info.family),
      h("div", { class: "set-row-sub" }, [weightsText(info), info.license].filter(Boolean).join(" · "))
    );
    const remove = removable
      ? removeButton({
          tip: `Remove ${info.label || info.family}`,
          question: "Remove this font?",
          onConfirm: async () => {
            await fonts.removeCustom(info.family);
            toast(ctx, `Removed ${info.label || info.family}. Text that used it falls back to another font.`, { kind: "ok" });
          },
        })
      : null;
    return h("div", { class: "set-row" }, sample, main, remove);
  };

  const paint = () => {
    const all = fonts.list();
    const custom = all.filter((f) => f.source === "custom");
    const mod = all.filter((f) => f.source === "mod");
    clear(yours);
    if (custom.length) for (const f of custom) yours.append(row(f, true));
    else yours.append(h("div", { class: "set-empty" }, `No fonts added yet. Fonts you add stay ${ctx.desktop ? "in Longitude" : "in this browser"} and travel inside .longitude files.`));
    clear(fromMods);
    for (const f of mod) fromMods.append(row(f, false));
    modGroup.hidden = !mod.length;
    const bundled = all.filter((f) => f.source === "bundled").length;
    const originals = all.filter((f) => f.category === "original").length;
    footer.textContent = !bundled
      ? ""
      : originals
        ? `Longitude comes with ${plural(bundled, "font")}, ${originals} of them made just for it.`
        : `Longitude comes with ${plural(bundled, "font")}.`;
  };
  paint();
  const onChange = () => paint();
  fonts.addEventListener("change", onChange);
  env.d(() => fonts.removeEventListener("change", onChange));

  el.append(
    group(
      "Your fonts",
      "Add .ttf, .otf, .woff or .woff2 files, or drop them here or on the canvas.",
      h("div", { class: "set-actions" }, add, input),
      yours
    ),
    modGroup,
    footer
  );
  return el;
}

// ---- Mods ----------------------------------------------------------------------

const ADD_WORDS = {
  shapes: ["shape", "shapes"],
  filters: ["filter", "filters"],
  tools: ["tool", "tools"],
  themes: ["theme", "themes"],
  presets: ["size preset", "size presets"],
  fonts: ["font", "fonts"],
  bg: ["background remover", "background removers"],
  inspector: ["inspector section", "inspector sections"],
  commands: ["command", "commands"],
};

function addsText(adds) {
  const parts = Object.entries(ADD_WORDS)
    .filter(([k]) => adds?.[k] > 0)
    .map(([k, [one, many]]) => plural(adds[k], one, many));
  return parts.length ? `Adds ${listText(parts)}.` : "";
}

function modCard(ctx) {
  let mod = null;
  const name = h("span", { class: "mod-name" });
  const version = h("span", { class: "mod-ver num" });
  const by = h("div", { class: "mod-by" });
  const desc = h("p", { class: "mod-desc" });
  const status = h("div", { class: "mod-status", role: "status" });
  const sw = toggle({
    tip: "Turn on or off",
    onChange: (on) => {
      if (!mod) return;
      ctx.mods.setEnabled(mod.id, on);
    },
  });
  const reload = iconButton({
    icon: "refresh-cw",
    tip: "Reload from disk",
    size: "sm",
    onClick: async () => {
      if (!mod) return;
      const label = mod.name;
      reload.classList.add("spin");
      reload.setDisabled(true);
      let ok = false;
      try {
        ok = await ctx.mods.reload(mod.id);
      } catch (err) {
        console.error(err);
      } finally {
        reload.classList.remove("spin");
        reload.setDisabled(false);
      }
      if (ok) toast(ctx, `Reloaded ${label}.`, { kind: "ok" });
    },
  });
  // The manifest's homepage (https only, checked by the loader), for updates.
  const home = h("a", { class: "icon-btn sm", target: "_blank", rel: "noopener noreferrer", hidden: true }, icon("external-link", { size: "sm" }));
  const el = h(
    "article",
    { class: "mod-card" },
    h("div", { class: "mod-glyph", "aria-hidden": "true" }, icon("puzzle")),
    h("div", { class: "mod-main" }, h("div", { class: "mod-title" }, name, version), by, desc, status),
    h("div", { class: "mod-side" }, home, reload, sw)
  );
  el.update = (m) => {
    mod = m;
    el.dataset.status = m.status;
    name.textContent = m.name;
    version.textContent = m.version ? `v${m.version}` : "";
    version.hidden = !m.version;
    home.hidden = !m.homepage;
    if (m.homepage) {
      home.href = m.homepage;
      home.dataset.tip = `${m.name} homepage`;
      home.setAttribute("aria-label", `${m.name} homepage`);
    }
    by.textContent = [m.author && `by ${m.author}`, m.id].filter(Boolean).join(" · ");
    desc.textContent = m.description;
    desc.hidden = !m.description;
    sw.value = m.enabled;
    sw.setAttribute("aria-label", `${m.name} on or off`);
    sw.dataset.tip = m.enabled ? `Turn ${m.name} off` : `Turn ${m.name} on`;
    clear(status);
    if (m.status === "loading") status.append(h("span", { class: "muted" }, "Starting..."));
    else if (m.status === "error") {
      status.append(h("span", { class: "mod-err" }, icon("alert-circle", { size: "sm" }), h("span", null, `${m.enabled ? "Could not start" : "Could not be read"}: ${m.error}`)));
    } else if (m.status === "on") {
      const adds = addsText(m.adds);
      if (adds) status.append(h("span", { class: "muted" }, adds));
      const last = m.runtimeErrors[m.runtimeErrors.length - 1];
      if (last) status.append(h("span", { class: "mod-warn" }, icon("alert-circle", { size: "sm" }), h("span", null, `Last error${last.where ? ` in ${last.where}` : ""}: ${last.message}`)));
    }
    status.hidden = !status.firstChild;
  };
  return el;
}

function modsTab(ctx, env) {
  const el = h("div", { class: "set-stack" });
  el.append(
    h("p", { class: "set-lead" }, "Mods add commands, shapes, filters and inspector sections. Each mod is a folder in web/mods, listed in web/mods/mods.json."),
    note("Mods run with full access to Longitude and your designs. Only turn on mods you trust.", "attention")
  );
  const check = button({
    label: "Check for new mods",
    icon: "refresh-cw",
    kind: "ghost",
    onClick: async () => {
      if (!ctx.mods) return;
      check.setDisabled(true);
      const before = new Set(ctx.mods.list().map((m) => m.id));
      try {
        const list = await ctx.mods.refresh();
        await ctx.mods.describe();
        const fresh = list.filter((m) => !before.has(m.id)).length;
        if (ctx.mods.errors.length) {
          const lead = fresh ? `Found ${plural(fresh, "new mod")}, but mods.json` : "mods.json";
          toast(ctx, `${lead} has a problem. It is shown above the list.`, { kind: "warn" });
        } else {
          toast(ctx, fresh ? `Found ${plural(fresh, "new mod")}.` : "No new mods in mods.json.", { kind: fresh ? "ok" : "info" });
        }
      } catch (err) {
        toast(ctx, err.message || "mods.json could not be read.", { kind: "error" });
      } finally {
        check.setDisabled(false);
      }
    },
  });
  el.append(h("div", { class: "set-actions" }, linkButton("How to make a mod", LINKS.modding, "book-open"), check));

  const problems = h("div", { class: "set-problems" });
  const list = h("div", { class: "mod-list" });
  el.append(problems, list);
  el.append(
    h(
      "p",
      { class: "set-foot" },
      "Browsers cannot open folders, so Longitude cannot install mods for you. To add one, copy its folder into web/mods, add a line for it to mods.json, then choose Check for new mods."
    )
  );

  const cards = new Map();
  const paint = () => {
    const mods = ctx.mods;
    clear(problems);
    if (!mods) {
      clear(list).append(h("div", { class: "set-empty" }, "Mods are still loading."));
      check.setDisabled(true);
      return;
    }
    check.setDisabled(false);
    if (mods.safeMode) problems.append(note("Safe mode: no mod runs until Longitude restarts normally. Choices made here apply then.", "attention"));
    for (const msg of mods.errors) problems.append(note(msg, "error"));
    const items = mods.list();
    if (!items.length) {
      cards.clear();
      clear(list).append(h("div", { class: "set-empty" }, "No mods listed in web/mods/mods.json."));
      return;
    }
    list.querySelector(".set-empty")?.remove();
    const ids = new Set(items.map((m) => m.id));
    for (const [id, card] of cards) {
      if (!ids.has(id)) {
        card.remove();
        cards.delete(id);
      }
    }
    items.forEach((m, i) => {
      let card = cards.get(m.id);
      if (!card) {
        card = modCard(ctx);
        cards.set(m.id, card);
      }
      card.update(m);
      if (list.children[i] !== card) list.insertBefore(card, list.children[i] || null);
    });
  };
  paint();
  env.d(ctx.on("mods", paint));
  ctx.mods?.describe?.().catch(() => {});
  return el;
}

// ---- Packs ---------------------------------------------------------------------

function reviewPanel(preview, { onCancel, onAdd }) {
  const { pack } = preview;
  const parts = [];
  parts.push(
    h("div", { class: "micro" }, "Review before adding"),
    h("h3", { class: "pack-review-name" }, pack.name),
    pack.author || pack.description ? h("p", { class: "set-note" }, [pack.author && `by ${pack.author}`, pack.description].filter(Boolean).join(". ")) : null,
    h("p", { class: "pack-review-sum" }, `Adds ${countsText(packCounts(pack))}.`)
  );
  if (preview.replaces) parts.push(note(`You already have a pack called ${pack.name}. Adding it again replaces it.`, "attention", "info"));
  if (pack.themes.length) {
    parts.push(h("div", { class: "pack-review-label micro" }, "Themes"), h("div", { class: "theme-grid small" }, pack.themes.map((t) => themeCard(t))));
  }
  if (pack.presets.length) {
    parts.push(
      h("div", { class: "pack-review-label micro" }, "Size presets"),
      h("div", { class: "set-list" }, pack.presets.map((p) => simpleRow(p.label, p.group, h("span", { class: "num set-dim" }, `${p.width} × ${p.height}`))))
    );
  }
  if (pack.palettes.length) {
    parts.push(
      h("div", { class: "pack-review-label micro" }, "Color palettes"),
      h("div", { class: "set-list" }, pack.palettes.map((p) => simpleRow(p.name, null, swatches(p.colors))))
    );
  }
  if (pack.fonts.length) {
    parts.push(
      h("div", { class: "pack-review-label micro" }, "Fonts"),
      h("div", { class: "set-list" }, pack.fonts.map((f) => simpleRow(f.label, plural(f.faces.length, "file"))))
    );
  }
  const skipped = [...preview.skipped, ...(pack.notes || [])];
  if (skipped.length) parts.push(note(skipped.join(" "), "attention", "alert-circle"));
  const cancel = button({ label: "Cancel", kind: "ghost", onClick: onCancel });
  const add = button({ label: preview.replaces ? "Replace pack" : "Add pack", kind: "primary", onClick: onAdd });
  parts.push(h("div", { class: "pack-review-foot" }, h("span", { class: "set-note" }, "Packs are plain data and never run code."), h("div", { class: "set-actions" }, cancel, add)));
  const el = h("div", { class: "pack-review", role: "group", "aria-label": `Review ${pack.name}` }, parts);
  el.focusMain = () => add.focus();
  return el;
}

function packsTab(ctx, env) {
  const el = h("div", { class: "set-stack" });
  el.append(
    h("p", { class: "set-lead" }, "Packs add themes, size presets, color palettes and fonts. They are plain JSON files and never run code. Theme packs from Latitude work too.")
  );

  const input = h("input", { type: "file", accept: ".json,application/json", hidden: true });
  const choose = button({ label: "Choose a pack", icon: "upload", kind: "primary", onClick: () => input.click() });
  const example = button({
    label: "Try the example pack",
    kind: "ghost",
    onClick: async () => {
      try {
        const base = ctx.mods?.base || new URL("mods/", document.baseURI).href;
        const res = await fetch(new URL("theme-pack-example.json", base), { cache: "no-store" });
        if (!res.ok) throw Error("The example pack is missing from web/mods.");
        startImport(await res.text());
      } catch (err) {
        toast(ctx, err.message, { kind: "error" });
      }
    },
  });
  const drop = h(
    "div",
    { class: "pack-drop" },
    h("span", { class: "pack-drop-icon" }, icon("upload", { size: "lg" })),
    h("div", { class: "pack-drop-title" }, "Drop a pack here"),
    h("div", { class: "set-note" }, "A .json file up to 1 MB"),
    h("div", { class: "set-actions center" }, choose, example, input)
  );
  const reviewSlot = h("div", { class: "pack-review-slot" });
  const list = h("div", { class: "set-list" });
  el.append(drop, reviewSlot, group("Installed", null, list));

  let pending = null; // resolve() of the review on screen
  const endReview = (ok) => {
    const r = pending;
    pending = null;
    clear(reviewSlot);
    drop.hidden = false;
    r?.(ok);
  };
  const review = (preview) =>
    new Promise((resolve) => {
      if (pending) pending(false);
      pending = resolve;
      drop.hidden = true;
      const panel = reviewPanel(preview, { onCancel: () => endReview(false), onAdd: () => endReview(true) });
      clear(reviewSlot).append(panel);
      panel.focusMain();
    });
  env.hooks.escape = () => {
    if (!pending) return false;
    endReview(false);
    choose.focus();
    return true;
  };
  env.d(() => {
    if (pending) {
      const r = pending;
      pending = null;
      r(false);
    }
  });

  async function startImport(source) {
    const packs = ctx.mods?.packs;
    if (!packs) {
      toast(ctx, "Packs are still loading. Try again in a moment.", { kind: "warn" });
      return;
    }
    try {
      const info = await packs.importPack(source, { review });
      if (!info) return;
      const themeId = info.themeIds[0];
      toast(ctx, `Added ${info.name}.`, {
        kind: "ok",
        action: themeId ? { label: "Use its theme", run: () => ctx.themes?.apply(themeId) } : undefined,
      });
    } catch (err) {
      endReview(false);
      toast(ctx, err.message || "This pack could not be added.", { kind: "error" });
    }
  }
  env.hooks.importPack = startImport;

  // Drops anywhere on Settings arrive through the dialog (takeFiles), which
  // lights this zone up while files hover.
  input.addEventListener("change", () => {
    const f = input.files[0];
    input.value = "";
    if (f) startImport(f);
  });

  // "Use theme" turns into "Theme in use" while one of the pack's themes is on.
  let useButtons = [];
  const syncUse = () => {
    const id = ctx.themes?.current?.()?.id;
    for (const { btn, ids } of useButtons) {
      const on = ids.includes(id);
      btn.setLabel(on ? "Theme in use" : "Use theme");
      btn.setAttribute("aria-pressed", String(on));
    }
  };

  const packRow = (p) => {
    const accent = p.themes[0]?.colors;
    const glyph = accent
      ? h("span", { class: "pack-glyph", style: { background: accent.bg, borderColor: accent.line } }, h("span", { class: "pack-glyph-dot", style: { background: accent.accent } }))
      : h("span", { class: "pack-glyph" }, icon("package", { size: "sm" }));
    const sub = [countsText(p.counts), p.author && `by ${p.author}`].filter(Boolean).join(" · ");
    const main = h(
      "div",
      { class: "set-row-main" },
      h("div", { class: "set-row-title" }, p.name),
      h("div", { class: "set-row-sub" }, sub),
      p.skipped.length ? h("div", { class: "set-row-warn" }, p.skipped.join(" ")) : null
    );
    const use = p.themeIds.length
      ? button({ label: "Use theme", icon: "check", kind: "ghost set-use", onClick: () => ctx.themes?.apply(p.themeIds[0]) })
      : null;
    if (use) useButtons.push({ btn: use, ids: p.themeIds });
    const remove = removeButton({
      tip: `Remove ${p.name}`,
      question: "Remove this pack?",
      onConfirm: async () => {
        try {
          await ctx.mods.packs.remove(p.id);
        } catch (err) {
          toast(ctx, err.message || `${p.name} could not be removed.`, { kind: "error" });
          throw err;
        }
        toast(ctx, `Removed ${p.name}. Your designs are not changed.`, { kind: "ok" });
      },
    });
    return h("div", { class: "set-row" }, glyph, main, use, remove);
  };

  const paint = () => {
    clear(list);
    useButtons = [];
    const packs = ctx.mods?.packs?.list() || [];
    if (!packs.length) {
      list.append(h("div", { class: "set-empty" }, `No packs yet. Packs you add stay ${ctx.desktop ? "in Longitude" : "in this browser"}.`));
      return;
    }
    for (const p of packs) list.append(packRow(p));
    syncUse();
  };
  paint();
  env.d(ctx.on("packs", paint));
  env.d(ctx.on("theme", syncUse));
  return el;
}

// ---- Shortcuts -----------------------------------------------------------------

function gestureRows() {
  const mod = isMac ? "⌘" : "Ctrl";
  return [
    ["Pan the canvas", [kbd("Space"), " + drag, or scroll"]],
    ["Zoom at the pointer", [kbd(mod), " + scroll, or pinch"]],
    ["Fit the design to the window", ["Double-click empty space"]],
    ["Select several layers", [kbd(isMac ? "⇧" : "Shift"), " + click, or drag a box"]],
    ["Move without snapping", ["Hold ", kbd("Ctrl"), " while dragging"]],
    ["Keep or free the proportions", ["Hold ", kbd(isMac ? "⇧" : "Shift"), " while resizing"]],
    ["Resize from the center", ["Hold ", kbd(isMac ? "⌥" : "Alt"), " while resizing"]],
    ["Rotate in 15° steps", ["Hold ", kbd(isMac ? "⇧" : "Shift"), " while rotating"]],
    ["Turn a pen stroke into a clean shape", ["Hold still at the end of the stroke"]],
  ];
}

function shortcutsTab(ctx, env) {
  const el = h("div", { class: "set-stack" });
  const search = h("input", { type: "search", class: "set-search", placeholder: "Search shortcuts", "aria-label": "Search shortcuts", spellcheck: "false", autocomplete: "off" });
  const list = h("div", { class: "keys" });
  el.append(h("div", { class: "set-search-wrap" }, icon("search", { size: "sm" }), search), list);

  const paint = () => {
    const q = search.value.trim().toLowerCase();
    const match = (...hay) => !q || hay.join(" ").toLowerCase().includes(q);
    const groups = new Map();
    for (const c of ctx.commands?.list() || []) {
      if (!c.keys?.length) continue;
      const labels = c.keys.map((k, i) => (i === 0 ? ctx.commands.keysLabel(c.id) : keysLabel(k)));
      const g = c.group || "Other";
      if (!match(c.title, g, c.keywords || "", ...labels)) continue;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push({ title: c.title, how: labels.flatMap((l, i) => (i ? [h("span", { class: "keys-or" }, "or"), kbd(l)] : [kbd(l)])) });
    }
    const order = (g) => {
      const i = GROUP_ORDER.indexOf(g);
      return i < 0 ? GROUP_ORDER.length : i;
    };
    const sorted = [...groups.entries()].sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]));
    const gestures = gestureRows().filter(([title, how]) => match(title, ...how.map((x) => (typeof x === "string" ? x : x.textContent))));
    if (gestures.length) sorted.push(["Mouse and trackpad", gestures.map(([title, how]) => ({ title, how }))]);
    clear(list);
    if (!sorted.length) {
      list.append(h("div", { class: "set-empty" }, `No shortcuts match “${search.value.trim()}”.`));
      return;
    }
    for (const [g, rows] of sorted) {
      list.append(
        h(
          "section",
          { class: "keys-group" },
          h("h3", { class: "set-group-title" }, g),
          rows.map((r) => h("div", { class: "keys-row" }, h("span", { class: "keys-title" }, r.title), h("span", { class: "keys-how" }, r.how)))
        )
      );
    }
  };
  search.addEventListener("input", paint);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && search.value) {
      e.preventDefault();
      e.stopPropagation();
      search.value = "";
      paint();
    }
  });
  paint();
  if (ctx.commands?.onChange) env.d(ctx.commands.onChange(paint));
  el.append(h("p", { class: "set-foot" }, "Every action is also in the command palette. Press ", kbd(ctx.commands?.keysLabel("view.palette") || (isMac ? "⌘K" : "Ctrl+K")), " and type what you want to do."));
  return el;
}

// ---- About ---------------------------------------------------------------------

function logoMark() {
  return svg(
    "svg",
    { class: "about-mark", viewBox: "0 0 40 40", "aria-hidden": "true" },
    svg("circle", { cx: "20", cy: "20", r: "15" }),
    svg("ellipse", { cx: "20", cy: "20", rx: "6.5", ry: "15" }),
    svg("path", { d: "M20 5v30" })
  );
}

function aboutTab(ctx) {
  const el = h("div", { class: "set-stack" });
  el.append(
    h(
      "div",
      { class: "about-hero" },
      logoMark(),
      h("div", null, h("div", { class: "about-word" }, "Longitude"), h("div", { class: "about-ver num" }, `Version ${ctx.version || "0.1.0"}`))
    ),
    h(
      "p",
      { class: "set-lead" },
      `A small editor for YouTube thumbnails, Spotify covers and any image that needs to be quick and sharp. It runs ${ctx.desktop ? "on your computer" : "in your browser"}, saves to this device and never uploads your pictures. No accounts, no fees, no tracking.`
    ),
    h("div", { class: "set-actions" }, linkButton("Source code", LINKS.source, "code"), linkButton("Modding guide", LINKS.modding, "book-open")),
    group(
      "Sibling apps",
      "Longitude shares its look with two other free, open-source apps.",
      h(
        "div",
        { class: "about-sibs" },
        h("a", { class: "about-sib", href: LINKS.latitude, target: "_blank", rel: "noopener noreferrer" }, h("span", { class: "about-sib-name" }, "Latitude"), h("span", { class: "set-row-sub" }, "Screen recorder"), icon("external-link", { size: "sm", class: "set-ext" })),
        h("a", { class: "about-sib", href: LINKS.sundial, target: "_blank", rel: "noopener noreferrer" }, h("span", { class: "about-sib-name" }, "Sundial"), h("span", { class: "set-row-sub" }, "Planner"), icon("external-link", { size: "sm", class: "set-ext" }))
      )
    ),
    group("License", null, h("p", { class: "set-note" }, "Longitude is free and open source under the MIT license. Use it, change it, share it. Fonts and models keep their own licenses, listed below.")),
    credits(ctx)
  );
  return el;
}

function credits(ctx) {
  const rows = [];
  const line = (name, by, license, href) =>
    h(
      "div",
      { class: "credit" },
      href ? h("a", { href, target: "_blank", rel: "noopener noreferrer" }, name) : h("span", { class: "credit-name" }, name),
      by ? h("span", { class: "credit-by" }, by) : null,
      license ? h("span", { class: "credit-lic num" }, license) : null
    );
  rows.push(h("div", { class: "pack-review-label micro" }, "Interface"));
  rows.push(line("Manrope", "Mikhail Sharanda", "OFL-1.1"), line("Syne", "Bonjour Monde", "OFL-1.1"), line("Space Mono", "Colophon Foundry", "OFL-1.1"), line("Lucide icons", "Lucide contributors", "ISC"));
  const bundled = (ctx.fonts?.list() || []).filter((f) => f.source === "bundled");
  if (bundled.length) {
    rows.push(h("div", { class: "pack-review-label micro" }, "Fonts"));
    for (const f of bundled) rows.push(line(f.label || f.family, f.credit, f.license));
  }
  const cfg = ctx.bg?.config;
  if (cfg) {
    rows.push(h("div", { class: "pack-review-label micro" }, "Background removal"));
    for (const m of Object.values(cfg.models || {})) rows.push(line(m.label, null, m.license, m.source));
    if (cfg.ort) rows.push(line("ONNX Runtime Web", "Microsoft", cfg.ort.license, cfg.ort.source));
  }
  return h("details", { class: "about-credits" }, h("summary", null, "Credits and licenses"), h("div", { class: "credit-list" }, rows));
}
