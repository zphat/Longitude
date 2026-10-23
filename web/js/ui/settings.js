// Settings: one modal with six tabs. General (theme, canvas aids, background
// removal, storage), Fonts, Mods, Packs, Shortcuts and About.
// openSettings(ctx, { tab }) opens it, or switches tabs when it is open.

import { h, svg, clear, disposer, isMac } from "./dom.js";
import { button, iconButton, toggle, segmented } from "./controls.js";
import { icon, hasIcon, registerIcons } from "./icons.js";
import { keysLabel } from "../app/context.js";
import { THEMES } from "./theme.js";
import { formatBytes } from "../features/compress.js";
import { countsText, packCounts, plural, listText } from "../mods/packs.js";

export const LINKS = Object.freeze({
  source: "https://github.com/zphat/Longitude",
  modding: "https://github.com/zphat/Longitude/blob/main/docs/MODDING.md",
  latitude: "https://github.com/zphat/Latitude",
  sundial: "https://github.com/zphat/Sundial",
});

const TABS = [
  { id: "general", label: "General", icon: "sliders-horizontal", render: generalTab },
  { id: "fonts", label: "Fonts", icon: "type", render: fontsTab },
  { id: "mods", label: "Mods", icon: "puzzle", render: modsTab },
  { id: "packs", label: "Packs", icon: "package", render: packsTab },
  { id: "shortcuts", label: "Shortcuts", icon: "keyboard", render: shortcutsTab },
  { id: "about", label: "About", icon: "info", render: aboutTab },
];

// Lucide paths (ISC), registered only when the shell's set lacks them.
const FALLBACK_ICONS = {
  "sliders-horizontal": '<path d="M21 4h-7"/><path d="M10 4H3"/><path d="M21 12h-9"/><path d="M8 12H3"/><path d="M21 20h-5"/><path d="M12 20H3"/><path d="M14 2v4"/><path d="M8 10v4"/><path d="M16 18v4"/>',
  type: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
  puzzle: '<path d="M19.44 7.85c-.05.32.06.65.29.88l1.57 1.57c.47.47.7 1.09.7 1.7s-.23 1.24-.7 1.71l-1.61 1.61a.98.98 0 0 1-.84.28c-.47-.07-.8-.48-.97-.93a2.5 2.5 0 1 0-3.21 3.21c.45.17.86.5.93.97a.98.98 0 0 1-.28.84l-1.61 1.61a2.4 2.4 0 0 1-1.7.7 2.4 2.4 0 0 1-1.71-.7l-1.57-1.57a1.03 1.03 0 0 0-.88-.29c-.49.07-.84.5-1.02.97a2.5 2.5 0 1 1-3.24-3.24c.46-.18.9-.53.97-1.02a1.03 1.03 0 0 0-.29-.88l-1.57-1.57A2.4 2.4 0 0 1 2 12c0-.62.24-1.23.7-1.7l1.53-1.53c.24-.24.58-.35.92-.3.51.08.87.53 1.07 1.01a2.5 2.5 0 1 0 3.26-3.26c-.48-.2-.93-.56-1.01-1.07-.05-.34.06-.68.3-.92L10.3 2.7A2.4 2.4 0 0 1 12 2c.62 0 1.23.24 1.7.7l1.57 1.57c.23.23.56.34.88.29.49-.07.84-.5 1.02-.97a2.5 2.5 0 1 1 3.24 3.24c-.46.18-.9.53-.97 1.02Z"/>',
  package: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  keyboard: '<path d="M10 8h.01"/><path d="M12 12h.01"/><path d="M14 8h.01"/><path d="M16 12h.01"/><path d="M18 8h.01"/><path d="M6 8h.01"/><path d="M7 16h10"/><path d="M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  "trash-2": '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  "refresh-cw": '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  "external-link": '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  "alert-circle": '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  "book-open": '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
};

const WEIGHT_NAMES = { 100: "Thin", 200: "Extra light", 300: "Light", 400: "Regular", 500: "Medium", 600: "Semibold", 700: "Bold", 800: "Extra bold", 900: "Black" };
const GROUP_ORDER = ["File", "Edit", "Tools", "Tool", "Insert", "Layer", "Arrange", "Align", "Text", "Image", "Shape", "View", "Export", "App"];

let current = null;

// Loads web/css/mods.css once (for pages whose index.html does not link it).
export function ensureModStyles() {
  const doc = globalThis.document;
  if (!doc?.head || doc.querySelector('link[href$="css/mods.css"], link[data-mods-css]')) return;
  doc.head.append(h("link", { rel: "stylesheet", href: new URL("../../css/mods.css", import.meta.url).href, "data-mods-css": "" }));
}

// Adds the icons Settings and the mod commands use when the shell's set lacks them.
export function ensureModIcons() {
  const missing = {};
  for (const [k, v] of Object.entries(FALLBACK_ICONS)) if (!hasIcon(k)) missing[k] = v;
  registerIcons(missing);
}

// openSettings(ctx, { tab = "general", pack }) -> { close }
//   pack: a File, JSON text or object to review on the Packs tab right away.
export function openSettings(ctx, { tab = "general", pack = null } = {}) {
  if (!globalThis.document) return { close() {} };
  ensureModStyles();
  ensureModIcons();
  if (!current) current = createSettings(ctx);
  current.show(TABS.some((t) => t.id === tab) ? tab : "general");
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

  return { show, close, reviewPack };
}

function trapFocus(panel, e) {
  const items = [...panel.querySelectorAll('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')].filter(
    (el) => !el.disabled && !el.hidden && el.offsetParent !== null
  );
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
  if (ctx.bg?.providers) el.append(bgGroup(ctx, env));
  el.append(storageGroup(ctx, env));
  return el;
}

function themeGroup(ctx, env) {
  const grid = h("div", { class: "theme-grid", role: "radiogroup", "aria-label": "Theme" });
  let cards = new Map();
  const builtIn = new Set(THEMES.map((t) => t.id));
  const paint = () => {
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
  };
  paint();
  env.d(ctx.on("themes", paint));
  env.d(ctx.on("theme", ({ id } = {}) => {
    for (const [tid, card] of cards) card.setActive(tid === id);
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

function bgGroup(ctx, env) {
  const providers = ctx.bg.providers.list();
  const text = h("p", { class: "set-note" });
  let token = 0;
  const describe = async (id) => {
    const p = providers.find((x) => x.id === id);
    const mine = ++token;
    text.textContent = p?.note || "";
    if (!p) return;
    let extra = "";
    if (p.kind !== "ml") extra = "No download needed.";
    else {
      try {
        const info = await p.info?.();
        if (info) extra = info.cached ? "Downloaded and ready." : `Downloads about ${Math.max(1, Math.round(info.downloadMB))} MB once, then works offline.`;
        else if (p.sizeMB) extra = `Downloads about ${Math.round(p.sizeMB)} MB once.`;
      } catch {
        if (p.sizeMB) extra = `Downloads about ${Math.round(p.sizeMB)} MB once.`;
      }
    }
    if (mine === token) text.textContent = [p.note, extra].filter(Boolean).join(" ");
  };
  const seg = segmented({
    options: providers.map((p) => ({ value: p.id, label: p.label })),
    value: ctx.bg.defaultProvider,
    full: true,
    onChange: (id) => {
      ctx.bg.setDefaultProvider?.(id);
      describe(id);
    },
  });
  describe(ctx.bg.defaultProvider);

  const cacheRow = h("div", { class: "set-row" });
  const paintCache = async () => {
    let usage = null;
    try {
      usage = await ctx.bg.cacheUsage?.();
    } catch {}
    clear(cacheRow);
    if (!usage || !usage.bytes) {
      cacheRow.append(h("div", { class: "set-row-main" }, h("div", { class: "set-row-sub" }, "Nothing downloaded yet. The model downloads the first time you remove a background.")));
      return;
    }
    const del = button({
      label: "Delete download",
      kind: "ghost danger",
      icon: "trash-2",
      onClick: async () => {
        del.setDisabled(true);
        try {
          await ctx.bg.release?.();
        } catch {}
        const ok = await ctx.bg.clearCache?.();
        toast(ctx, ok ? "Deleted. The model downloads again the next time you need it." : "The download could not be deleted.", { kind: ok ? "ok" : "error" });
        paintCache();
        describe(seg.value);
      },
    });
    cacheRow.append(
      h("div", { class: "set-row-main" }, h("div", { class: "set-row-title" }, "Downloaded models"), h("div", { class: "set-row-sub num" }, formatBytes(usage.bytes))),
      del
    );
  };
  paintCache();
  return group("Background removal", "Runs on this device. Your images are never uploaded.", seg, text, h("div", { class: "set-list plain" }, cacheRow));
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
      usage.textContent = "This browser does not say how much space Longitude uses.";
      return;
    }
    const pct = est.quota > 0 ? Math.min(100, (est.usage / est.quota) * 100) : 0;
    fill.style.width = `${Math.max(pct, est.usage > 0 ? 1.5 : 0)}%`;
    meter.setAttribute("aria-label", `${formatBytes(est.usage)} used`);
    usage.textContent = est.quota > 0
      ? `Designs, images and fonts use ${formatBytes(est.usage)} of about ${formatBytes(est.quota)} this browser allows.`
      : `Designs, images and fonts use ${formatBytes(est.usage)}.`;
  };

  const paintKeep = async () => {
    clear(keepRow);
    if (typeof storage?.persisted !== "function") return;
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

function fontsTab(ctx, env) {
  const el = h("div", { class: "set-stack" });
  const fonts = ctx.fonts;
  if (!fonts) {
    el.append(note("Fonts are still loading. Open this tab again in a moment."));
    return el;
  }
  const input = h("input", { type: "file", accept: ".ttf,.otf,.woff,.woff2", multiple: true, hidden: true });
  const add = button({ label: "Add a font file", icon: "upload", kind: "primary", onClick: () => input.click() });
  input.addEventListener("change", async () => {
    const files = [...input.files];
    input.value = "";
    if (!files.length) return;
    add.setDisabled(true);
    add.setLabel("Adding...");
    const added = [];
    for (const f of files) {
      try {
        added.push(await fonts.addCustom(f));
      } catch (err) {
        toast(ctx, `${f.name}: ${err.message}`, { kind: "error" });
      }
    }
    add.setDisabled(false);
    add.setLabel("Add a font file");
    if (added.length === 1) toast(ctx, `Added ${added[0]}. Find it under Yours in the font picker.`, { kind: "ok" });
    else if (added.length > 1) toast(ctx, `Added ${plural(new Set(added).size, "font")}. Find them under Yours in the font picker.`, { kind: "ok" });
  });

  const yours = h("div", { class: "set-list" });
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
    else yours.append(h("div", { class: "set-empty" }, "No fonts added yet. Fonts you add stay in this browser and travel inside .longitude files."));
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
      "Add .ttf, .otf, .woff or .woff2 files. You can also drop font files onto the canvas.",
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
      const ok = await ctx.mods.reload(mod.id);
      reload.classList.remove("spin");
      reload.setDisabled(false);
      if (ok) toast(ctx, `Reloaded ${label}.`, { kind: "ok" });
    },
  });
  const el = h(
    "article",
    { class: "mod-card" },
    h("div", { class: "mod-glyph", "aria-hidden": "true" }, icon("puzzle")),
    h("div", { class: "mod-main" }, h("div", { class: "mod-title" }, name, version), by, desc, status),
    h("div", { class: "mod-side" }, reload, sw)
  );
  el.update = (m) => {
    mod = m;
    el.dataset.status = m.status;
    name.textContent = m.name;
    version.textContent = m.version ? `v${m.version}` : "";
    version.hidden = !m.version;
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
        toast(ctx, fresh ? `Found ${plural(fresh, "new mod")}.` : "No new mods in mods.json.", { kind: fresh ? "ok" : "info" });
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

  input.addEventListener("change", () => {
    const f = input.files[0];
    input.value = "";
    if (f) startImport(f);
  });
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  drop.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", (e) => {
    if (!drop.contains(e.relatedTarget)) drop.classList.remove("over");
  });
  drop.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    drop.classList.remove("over");
    const f = e.dataTransfer.files[0];
    if (f) startImport(f);
  });

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
      ? button({ label: "Use theme", kind: "ghost", onClick: () => ctx.themes?.apply(p.themeIds[0]) })
      : null;
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
    const packs = ctx.mods?.packs?.list() || [];
    if (!packs.length) {
      list.append(h("div", { class: "set-empty" }, "No packs yet. Packs you add stay in this browser."));
      return;
    }
    for (const p of packs) list.append(packRow(p));
  };
  paint();
  env.d(ctx.on("packs", paint));
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
      list.append(h("div", { class: "set-empty" }, `No shortcuts match "${search.value.trim()}".`));
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
      "A small editor for YouTube thumbnails, Spotify covers and any image that needs to be quick and sharp. It runs in your browser, saves to this device and never uploads your pictures. No accounts, no fees, no tracking."
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
