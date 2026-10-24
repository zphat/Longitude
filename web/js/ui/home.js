// Home: the full-screen start overlay. Recent designs in one row under the
// heading, sizes drawn to scale, a big drop zone and the quick tools. Esc
// closes it when a design is open.

import { h, clear, isTyping, debounce } from "./dom.js";
import { icon } from "./icons.js";
import { logoMark, presetGlyph, sizeLabel, sizeForm, shortLabel } from "./shell.js";
import { aspectLabel } from "../features/presets.js";
import { keysLabel } from "../app/context.js";
import { kbdNodes } from "./menus.js";
import { foreignModal } from "./keyboard.js";
import { session, openFiles, newDesign, openStoredDesign, duplicateDesign, deleteDesign, renameDesign, pickFiles, OPEN_ACCEPT } from "./commands-core.js";

// ---- pure helpers -------------------------------------------------------------------

export function relativeTime(ms, now = Date.now()) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const s = Math.round((now - ms) / 1000);
  if (s < 45) return "Just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return hr === 1 ? "1 hour ago" : `${hr} hours ago`;
  const d = Math.round(hr / 24);
  if (d <= 1) return "Yesterday";
  if (d < 7) return `${d} days ago`;
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

// The largest w x h with the same aspect that fits inside boxW x boxH.
export function fitBox(w, hgt, boxW, boxH) {
  if (!(w > 0) || !(hgt > 0)) return { w: boxW, h: boxH };
  const k = Math.min(boxW / w, boxH / hgt);
  return { w: Math.round(w * k * 10) / 10, h: Math.round(hgt * k * 10) / 10 };
}

// How many cards of at least `min` px fit in one row of `width` px with
// `gap` between them (the same count CSS auto-fill makes).
export function rowCapacity(width, min, gap) {
  if (!(width > 0) || !(min > 0)) return 0;
  return Math.max(1, Math.floor((width + gap) / (min + gap)));
}

// Arrow-key movement between cards laid out in a wrapping grid.
function gridNav(container, selector) {
  container.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key) || isTyping(e.target)) return;
    const items = [...container.querySelectorAll(selector)].filter((el) => el.offsetParent !== null);
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    let target = null;
    if (e.key === "ArrowLeft") target = items[i - 1];
    else if (e.key === "ArrowRight") target = items[i + 1];
    else {
      const r = items[i].getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const down = e.key === "ArrowDown";
      const rects = items.map((el) => el.getBoundingClientRect());
      const cands = items.filter((_, j) => (down ? rects[j].top > r.bottom - 4 : rects[j].bottom < r.top + 4));
      if (cands.length) {
        const tops = cands.map((el) => el.getBoundingClientRect().top);
        const rowY = down ? Math.min(...tops) : Math.max(...tops);
        const row = cands.filter((el) => Math.abs(el.getBoundingClientRect().top - rowY) < 6);
        const dx = (el) => {
          const q = el.getBoundingClientRect();
          return Math.abs(q.left + q.width / 2 - cx);
        };
        target = row.sort((a, b) => dx(a) - dx(b))[0];
      }
    }
    if (target) {
      e.preventDefault();
      target.focus();
      target.scrollIntoView({ block: "nearest" });
    }
  });
}

const QUICK_TOOLS = [
  { kind: "compress", icon: "image-down", title: "Compress an image", text: "Make a file smaller, for example under YouTube's 2 MB." },
  { kind: "remove-bg", icon: "remove-bg", title: "Remove a background", text: "Cut out a person or an object. Runs on this computer." },
  { kind: "convert", icon: "scaling", title: "Resize or convert", text: "New size or format: PNG, JPG or WebP." },
];

const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");

// ---- home --------------------------------------------------------------------------------

const LEDE_RETURN = "Pick a size, drop an image, or pick up where you left off.";
const LEDE_FIRST = "Pick a size or drop an image to start.";
// Recent cards: the narrowest a card gets, the gap between them, and how many
// are drawn before "Show all" (more than ever fit in one row).
const RECENT_MIN = 256;
const RECENT_GAP = 10;
const RECENT_ROW_MAX = 12;

export function mountHome(ctx, el = document.getElementById("home")) {
  let isOpen = false;
  let thumbs = new Map(); // "id:updated:size" -> object URL, reused across refreshes
  let showAll = false;
  let recentCache = [];
  let recentCols = 0;
  let pendingFocus = null;

  el.classList.add("home", "grain");
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", "Home");
  el.tabIndex = -1;

  // Actions started from Home report their own failures.
  const go = (p) =>
    Promise.resolve(p).catch((err) => {
      console.error(err);
      ctx.ui.toast?.(err?.message || "That did not work.", { kind: "error" });
    });

  // ---- header

  const closeBtn = h("button", { type: "button", class: "btn ghost home-close", "data-tip": "Back to your design", "data-kbd": "Esc" }, icon("x", { size: "sm" }), h("span", null, "Close"));
  closeBtn.addEventListener("click", () => close());
  const openBtn = h("button", { type: "button", class: "btn ghost" }, icon("folder-open", { size: "sm" }), h("span", null, "Open a file"));
  openBtn.addEventListener("click", () => ctx.commands.run("file.open"));
  const themeBtn = h("button", { type: "button", class: "icon-btn", "data-tip": "Switch theme", "aria-label": "Switch theme", "data-cmd": "view.theme" }, icon("palette"));
  themeBtn.addEventListener("click", () => ctx.commands.run("view.theme"));
  const settingsBtn = h("button", { type: "button", class: "icon-btn", "data-tip": "Settings", "aria-label": "Settings", "data-cmd": "app.settings" }, icon("settings"));
  settingsBtn.addEventListener("click", () => ctx.commands.run("app.settings"));
  const header = h(
    "header",
    { class: "home-top" },
    h("div", { class: "home-brand" }, logoMark({ size: 26 }), h("span", { class: "wordmark" }, "Longitude")),
    h("div", { class: "home-actions" }, openBtn, themeBtn, settingsBtn, closeBtn),
  );

  // ---- hero

  const lede = h("p", { class: "home-lede" }, LEDE_FIRST);
  const hero = h("section", { class: "home-hero" }, h("h1", { class: "home-title", id: "home-title" }, "What are we making?"), lede);
  el.setAttribute("aria-labelledby", "home-title");

  // ---- drop zone

  const chooseBtn = h("button", { type: "button", class: "btn" }, icon("image-plus", { size: "sm" }), h("span", null, "Choose an image"));
  const drop = h(
    "div",
    { class: "home-drop" },
    h("span", { class: "drop-icon" }, icon("upload", { size: "lg" })),
    h("span", { class: "drop-title" }, "Drop an image to start, or paste one"),
    h("span", { class: "drop-sub" }, "PNG, JPG, WebP, GIF, AVIF or SVG. It stays on this computer."),
    h("span", { class: "drop-actions" }, chooseBtn, h("span", { class: "drop-paste" }, kbdNodes(keysLabel("Mod+V")), " to paste")),
  );
  chooseBtn.addEventListener("click", async () => {
    const files = await pickFiles({ accept: OPEN_ACCEPT, multiple: true });
    if (files.length) go(openFiles(ctx, files));
  });
  // The whole zone is a big target for the mouse; the button is the keyboard way in.
  drop.addEventListener("click", (e) => {
    if (!e.target.closest("button")) chooseBtn.click();
  });

  // ---- presets

  const presetsEl = h("div", { class: "home-presets" });

  function presetCard(p, group) {
    const box = fitBox(p.width, p.height, 92, 44);
    const round = presetGlyph(p) === "circle";
    const shape = h(
      "span",
      { class: ["preset-shape", round && "round"], style: { width: `${box.w}px`, height: `${box.h}px` } },
      icon(presetGlyph(p), { size: "sm" }),
    );
    const card = h(
      "button",
      { type: "button", class: "preset-card", "aria-label": `${p.label}, ${sizeLabel(p.width, p.height)}`, "data-tip": p.note || null, "data-tip-place": "bottom" },
      h("span", { class: "preset-preview" }, shape),
      h("span", { class: "preset-label" }, shortLabel(p.label, group)),
      h("span", { class: "preset-size" }, h("span", { class: "num" }, sizeLabel(p.width, p.height)), h("span", { class: "preset-ratio" }, aspectLabel(p.width, p.height))),
    );
    card.addEventListener("click", () => go(newDesign(ctx, { preset: p.id })));
    return card;
  }

  function customCard() {
    const shape = h("span", { class: "preset-shape custom", style: { width: "56px", height: "40px" } }, icon("plus", { size: "sm" }));
    const card = h(
      "button",
      { type: "button", class: "preset-card custom", "aria-haspopup": "dialog" },
      h("span", { class: "preset-preview" }, shape),
      h("span", { class: "preset-label" }, "Custom size"),
      h("span", { class: "preset-size" }, h("span", null, "16 to 8000 px")),
    );
    card.addEventListener("click", () => {
      let pop = null;
      const last = ctx.prefs.get("lastCustomSize", { width: 1280, height: 720 });
      const form = sizeForm({
        width: last?.width || 1280,
        height: last?.height || 720,
        submitLabel: "Create",
        autofocus: true,
        onSubmit: ({ width, height }) => {
          pop?.close();
          ctx.prefs.set("lastCustomSize", { width, height });
          go(newDesign(ctx, { width, height }));
        },
      });
      pop = ctx.ui.popover(card, h("div", { class: "custom-pop" }, h("div", { class: "pop-head" }, h("span", { class: "pop-title" }, "Custom size")), form), { placement: "bottom-start", width: 330, focus: true });
    });
    return card;
  }

  function renderPresets() {
    clear(presetsEl);
    const groups = ctx.presets?.groups?.() || [];
    for (const g of groups) {
      const cards = g.presets.filter((p) => !p.custom).map((p) => presetCard(p, g.label));
      if (g.id === "Custom" || g.presets.some((p) => p.custom)) cards.push(customCard());
      if (!cards.length) continue;
      presetsEl.append(h("section", { class: "preset-group" }, h("h2", { class: "home-h micro" }, g.id === "Custom" ? "Custom size" : g.label), h("div", { class: "preset-grid" }, cards)));
    }
    if (!groups.some((g) => g.presets.some((p) => p.custom))) {
      presetsEl.append(h("section", { class: "preset-group" }, h("h2", { class: "home-h micro" }, "Custom size"), h("div", { class: "preset-grid" }, customCard())));
    }
  }
  gridNav(presetsEl, ".preset-card");

  // ---- quick tools

  const toolsEl = h("div", { class: "tool-grid" });
  for (const t of QUICK_TOOLS) {
    const card = h(
      "button",
      { type: "button", class: "tool-card" },
      h("span", { class: "tool-icon" }, icon(t.icon)),
      h("span", { class: "tool-text" }, h("span", { class: "tool-title" }, t.title), h("span", { class: "tool-desc" }, t.text)),
    );
    card.addEventListener("click", () => ctx.ui.openQuickTool?.(t.kind, {}));
    card.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      card.classList.add("drag-over");
      el.classList.remove("dragging");
    });
    card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
    card.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      card.classList.remove("drag-over");
      ctx.ui.openQuickTool?.(t.kind, { files: [...e.dataTransfer.files] });
    });
    toolsEl.append(card);
  }
  gridNav(toolsEl, ".tool-card");

  // ---- recent

  const recentGrid = h("div", { class: "recent-grid", role: "list", "aria-labelledby": "home-recent-h" });
  const recentMore = h("button", { type: "button", class: "btn ghost recent-more", hidden: true, "aria-expanded": "false" });
  recentMore.addEventListener("click", () => {
    showAll = !showAll;
    renderRecent(recentCache);
  });
  const storageNote = h("p", { class: "home-note", hidden: true }, icon("alert-triangle", { size: "sm" }), h("span", null, "This browser is not keeping data for this site, so designs last until you close the tab. Save a project file of each one to keep it."));
  const recentSection = h("section", { class: "home-recent", hidden: true }, h("div", { class: "home-row-head" }, h("h2", { class: "home-h micro", id: "home-recent-h" }, "Recent"), recentMore), recentGrid);
  gridNav(recentGrid, ".recent-open");

  // Rename, duplicate and delete live in one menu per card: the "more" button
  // or a right click (the menu key and Shift+F10 too). F2 and Delete work on a
  // focused card.
  function cardMenu(p, at) {
    const isCurrent = session.open && ctx.store?.doc?.id === p.id;
    ctx.ui.menu(
      [
        { label: isCurrent ? "Back to this design" : "Open", icon: "folder-open", run: () => go(openStoredDesign(ctx, p.id)) },
        { label: "Rename", icon: "edit", kbd: "F2", run: () => go(rename(p)) },
        { label: "Duplicate", icon: "copy-plus", run: () => go(duplicate(p)) },
        "-",
        { label: "Delete", icon: "trash", kbd: "Del", danger: true, run: () => go(remove(p)) },
      ],
      at instanceof Element ? { anchor: at, placement: "bottom-end", minWidth: 200 } : { x: at.x, y: at.y, minWidth: 200 },
    );
  }

  function thumbUrl(p, next) {
    if (!p.thumb) return null;
    const key = `${p.id}:${p.updated}:${p.thumb.size}`;
    const url = thumbs.get(key) || next.get(key) || URL.createObjectURL(p.thumb);
    next.set(key, url);
    return url;
  }

  function recentCard(p, next) {
    const url = thumbUrl(p, next);
    const isCurrent = session.open && ctx.store?.doc?.id === p.id;
    const thumb = h(
      "span",
      { class: "recent-thumb" },
      url ? h("img", { src: url, alt: "", draggable: "false", decoding: "async", loading: "lazy" }) : h("span", { class: "recent-blank" }, icon("image", { size: "sm" })),
    );
    // The time gives way (an ellipsis) before the size does on a narrow card.
    const when = h("span", { class: isCurrent ? "recent-when recent-now" : "recent-when" }, isCurrent ? "Editing now" : relativeTime(p.updated));
    const main = h(
      "button",
      { type: "button", class: "recent-open", "aria-label": `${isCurrent ? "Back to" : "Open"} ${p.name}` },
      thumb,
      h(
        "span",
        { class: "recent-meta" },
        h("span", { class: "recent-name" }, p.name),
        h("span", { class: "recent-sub" }, when, h("span", { class: "dotsep" }, "·"), h("span", { class: "num" }, sizeLabel(p.width, p.height))),
      ),
    );
    main.addEventListener("click", () => go(openStoredDesign(ctx, p.id)));
    const more = h("button", { type: "button", class: "icon-btn sm recent-menu", "data-tip": "Rename, duplicate or delete", "aria-label": `More for ${p.name}`, "aria-haspopup": "menu" }, icon("more-horizontal", { size: "sm" }));
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      cardMenu(p, more);
    });
    const card = h("div", { class: ["recent-card", isCurrent && "current"], role: "listitem", "data-id": p.id }, main, more);
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      cardMenu(p, { x: e.clientX, y: e.clientY });
    });
    main.addEventListener("keydown", (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Delete" || e.key === "Backspace") go(remove(p));
      else if (e.key === "F2") go(rename(p));
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    return card;
  }

  async function rename(p) {
    const name = await ctx.ui.prompt({ title: "Rename design", value: p.name, placeholder: "Design name", ok: "Rename", maxLength: 120 });
    if (!name || name === p.name) return;
    await renameDesign(ctx, p.id, name);
    if (session.open && ctx.store.doc.id === p.id) await session.autosave?.flush?.({ thumb: false });
    refresh();
  }

  async function duplicate(p) {
    try {
      const copy = await duplicateDesign(ctx, p.id, { thumb: p.thumb });
      ctx.ui.toast(`Made a copy: ${copy.name}`, { kind: "ok" });
      refresh();
    } catch (err) {
      ctx.ui.toast(err.message || "That design could not be copied.", { kind: "error" });
    }
  }

  async function remove(p) {
    const ok = await ctx.ui.confirm({
      title: "Delete this design?",
      message: `“${p.name}” will be removed from this browser. This cannot be undone.`,
      ok: "Delete",
      cancel: "Keep it",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteDesign(ctx, p.id);
      ctx.ui.toast(`Deleted “${p.name}”`, { kind: "info" });
    } catch (err) {
      ctx.ui.toast(err.message || "That design could not be deleted.", { kind: "error" });
    }
    paintClose();
    refresh();
  }

  function renderRecent(list) {
    // Keep the keyboard where it was when the cards are drawn again.
    const focusedCard = recentGrid.contains(document.activeElement) ? document.activeElement.closest?.(".recent-card") : null;
    const focusedId = focusedCard?.dataset.id;
    const focusedAt = focusedCard ? [...recentGrid.children].indexOf(focusedCard) : -1;
    const focusedMenu = !!document.activeElement?.classList?.contains("recent-menu");
    const next = new Map();
    const shown = showAll ? list : list.slice(0, RECENT_ROW_MAX);
    clear(recentGrid).append(...shown.map((p) => recentCard(p, next)));
    for (const [key, url] of thumbs) if (!next.has(key)) URL.revokeObjectURL(url);
    thumbs = next;
    if (!list.length) showAll = false;
    recentSection.hidden = !list.length;
    lede.textContent = list.length ? LEDE_RETURN : LEDE_FIRST;
    storageNote.hidden = ctx.assets?.persistent !== false;
    recentCols = 0;
    fitRecent();
    if (focusedCard) {
      // The same design, or (it was deleted) the card that took its place.
      const cards = [...recentGrid.children].filter((c) => !c.hidden);
      const card = cards.find((c) => c.dataset.id === focusedId) || cards[Math.min(focusedAt, cards.length - 1)];
      (card?.querySelector(focusedMenu ? ".recent-menu" : ".recent-open") || presetsEl.querySelector(".preset-card"))?.focus({ preventScroll: true });
    }
    applyFocus();
  }

  // One row of cards unless "Show all" is on; the rest wait behind the button.
  function fitRecent() {
    const cols = rowCapacity(recentGrid.clientWidth, RECENT_MIN, RECENT_GAP) || 4;
    if (cols !== recentCols) {
      recentCols = cols;
      const cards = recentGrid.children;
      for (let i = 0; i < cards.length; i++) cards[i].hidden = !showAll && i >= cols;
      recentMore.hidden = recentCache.length <= cols;
      recentMore.textContent = showAll ? "Show fewer" : `Show all ${recentCache.length}`;
      recentMore.setAttribute("aria-expanded", String(showAll));
    }
    // A name cut short shows in full in the card's tooltip.
    for (const name of recentGrid.querySelectorAll(".recent-name")) {
      const btn = name.closest(".recent-open");
      if (!btn) continue;
      if (name.scrollWidth > name.clientWidth + 1) btn.dataset.tip = name.textContent;
      else delete btn.dataset.tip;
    }
  }
  if (typeof ResizeObserver === "function") new ResizeObserver(() => isOpen && fitRecent()).observe(recentGrid);

  let refreshing = 0;
  async function refresh() {
    const ticket = ++refreshing;
    let list = [];
    try {
      list = (await ctx.projects?.list?.()) || [];
    } catch (err) {
      console.error(err);
    }
    if (ticket !== refreshing) return;
    recentCache = list;
    renderRecent(list);
  }
  const refreshSoon = debounce(() => isOpen && refresh(), 250);

  // ---- layout

  const footer = h(
    "footer",
    { class: "home-foot" },
    h("span", null, icon("shield", { size: "sm" }), "Everything stays on this computer. No account, no uploads."),
    h("span", { class: "muted" }, `Longitude ${ctx.version || ""} · open source`),
  );

  const dragHint = h("div", { class: "home-drag-hint", "aria-hidden": "true" }, icon("upload", { size: "lg" }), h("span", null, "Drop to start a design"));

  const main = h(
    "div",
    { class: "home-scroll" },
    h(
      "div",
      { class: "home-inner" },
      header,
      hero,
      storageNote,
      recentSection,
      h(
        "div",
        { class: "home-grid" },
        h("div", { class: "home-main" }, presetsEl),
        h("aside", { class: "home-side" }, drop, h("section", { class: "home-tools" }, h("h2", { class: "home-h micro" }, "Quick tools"), toolsEl)),
      ),
      footer,
    ),
  );
  clear(el).append(main, dragHint);

  // ---- drag and drop, paste

  let dragTimer = 0;
  el.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    el.classList.add("dragging");
    clearTimeout(dragTimer);
    dragTimer = setTimeout(() => el.classList.remove("dragging"), 160);
  });
  el.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove("dragging");
    const files = [...e.dataTransfer.files];
    if (files.length) go(openFiles(ctx, files));
  });

  // Capture phase, so the editor's paste handler never sees a paste meant for
  // Home. A sheet opened over Home (quick tools, Settings) gets its own pastes.
  window.addEventListener(
    "paste",
    (e) => {
      if (!isOpen || isTyping(e.target) || ctx.ui.isBlocking?.() || foreignModal()) return;
      const files = [...(e.clipboardData?.files || [])];
      if (!files.length) {
        for (const item of e.clipboardData?.items || []) {
          if (item.kind === "file") {
            const f = item.getAsFile();
            if (f) files.push(f);
          }
        }
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      const images = files.filter((f) => /^image\//.test(f.type));
      if (images.length) go(openFiles(ctx, images));
      else ctx.ui.toast?.("Copy an image first, then paste it here to start.", { kind: "info", id: "home-paste" });
    },
    true,
  );

  window.addEventListener("keydown", (e) => {
    if (!isOpen || e.key !== "Escape" || e.defaultPrevented || ctx.ui.isBlocking?.() || foreignModal()) return;
    if (session.open) {
      e.preventDefault();
      close();
    }
  });

  ctx.on("saved", refreshSoon);
  ctx.on("saved-elsewhere", refreshSoon);
  ctx.on("presets", () => renderPresets());

  // ---- open and close

  const appEl = document.getElementById("app");

  function paintClose() {
    closeBtn.hidden = !session.open;
  }

  // focus: "presets" (New design) or "recent" (Go to home) puts the keyboard
  // on the first card of that row; for "recent" once the list is drawn.
  function applyFocus() {
    if (!isOpen || !pendingFocus) return;
    const want = pendingFocus;
    pendingFocus = null;
    const firstPreset = presetsEl.querySelector(".preset-card");
    const target = want === "recent" ? recentGrid.querySelector(".recent-card:not([hidden]) .recent-open") || firstPreset : firstPreset;
    target?.focus({ preventScroll: true });
  }

  function open({ focus } = {}) {
    paintClose();
    if (!isOpen) {
      isOpen = true;
      clearTimeout(closeTimer);
      el.hidden = false;
      el.classList.remove("closing");
      el.classList.add("opening");
      setTimeout(() => el.classList.remove("opening"), 220);
      if (ctx.ui.setInert) ctx.ui.setInert(appEl, "home", true);
      else if (appEl) appEl.inert = true;
      ctx.ui.hideTip?.();
      ctx.emit("home", { open: true });
    }
    pendingFocus = focus === "presets" || focus === "recent" ? focus : null;
    // Home always opens at the top, where the recent designs are.
    main.scrollTop = 0;
    renderPresets();
    refresh();
    // Fresh thumbnails for the design that was just open.
    Promise.resolve(session.autosave?.flush?.({ thumb: true }))
      .catch(() => {})
      .then(() => isOpen && refresh());
    setTimeout(() => {
      if (!isOpen) return;
      if (pendingFocus === "presets") applyFocus();
      else if (!el.contains(document.activeElement)) el.focus({ preventScroll: true });
      main.scrollTop = 0;
    }, 30);
  }

  let closeTimer = 0;
  function close() {
    if (!isOpen || !session.open) return false;
    isOpen = false;
    el.classList.add("closing");
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (!isOpen) {
        el.hidden = true;
        el.classList.remove("closing");
      }
    }, 200);
    if (ctx.ui.setInert) ctx.ui.setInert(appEl, "home", false);
    else if (appEl) appEl.inert = false;
    if (el.contains(document.activeElement)) document.activeElement.blur();
    ctx.ui.hideTip?.();
    ctx.emit("home", { open: false });
    return true;
  }

  el.hidden = true;
  renderPresets();

  return {
    open,
    close,
    refresh,
    isOpen: () => isOpen,
  };
}
