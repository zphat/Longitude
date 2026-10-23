// Font picker popover: search, category tabs that jump through one list, each
// family drawn in its own face (loaded lazily as rows scroll into view), the
// family's sample on hover, live preview while hovering or moving with the
// arrow keys, and "Add a font file".
//
//   openFontPicker(anchorEl, { value, weight, onPreview(family), onPreviewEnd(), onChange(family), onClose }) -> { close }

import { h, on } from "./dom.js";
import { icon } from "./icons.js";
import { showPopover, DEAD_POPOVER } from "./colorpicker.js";

export const CATEGORY_TABS = [
  { id: "original", label: "Original" },
  { id: "classic", label: "Classics" },
  { id: "meme", label: "Meme" },
  { id: "display", label: "Display" },
  { id: "clean", label: "Clean" },
  { id: "system", label: "System" },
  { id: "custom", label: "Yours" },
];
const FONT_ACCEPT = ".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2";
const PREVIEW_DELAY = 60;

let boundCtx = null;

export function bindFontPicker(ctx) {
  boundCtx = ctx || null;
}

// ---- pure helpers -----------------------------------------------------------------

const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

// Families matching every word of the query (family, label, category, tags).
export function filterFonts(list, query) {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return list.slice();
  return list.filter((f) => {
    const tab = CATEGORY_TABS.find((t) => t.id === f.category);
    const hay = norm([f.family, f.label, f.category, tab?.label, ...(f.tags || [])].join(" "));
    return words.every((w) => hay.includes(w));
  });
}

// [{ id, label, items }] in tab order. Unknown categories land in "display".
// keepEmpty lists categories that stay even when they have no families.
export function groupFonts(list, { keepEmpty = [] } = {}) {
  const ids = CATEGORY_TABS.map((t) => t.id);
  const groups = CATEGORY_TABS.map((t) => ({ id: t.id, label: t.label, items: [] }));
  for (const f of list) {
    const i = ids.indexOf(f.category);
    groups[i >= 0 ? i : ids.indexOf("display")].items.push(f);
  }
  return groups.filter((g) => g.items.length || keepEmpty.includes(g.id));
}

// Short note for a family: "Variable", "4 weights", "Italic".
export function fontMeta(f) {
  const parts = [];
  if (f.variable) parts.push("Variable");
  else if ((f.weights || []).length > 1) parts.push(`${f.weights.length} weights`);
  if (f.italic) parts.push("Italic");
  return parts.join(" · ");
}

// ---- the picker -------------------------------------------------------------------

export function openFontPicker(anchorEl, { value, weight = 400, onPreview, onPreviewEnd, onChange, onClose, ctx = boundCtx, placement } = {}) {
  const fonts = ctx?.fonts;
  const offs = [];
  let query = "";
  let rows = []; // [{ el, info }]
  let active = -1;
  let previewing = null;
  let previewTimer = 0;
  let observer = null;
  let picked = false;

  const search = h("input", { type: "search", class: "fp-search-input", placeholder: "Search fonts", spellcheck: "false", autocomplete: "off", autofocus: true, "aria-label": "Search fonts" });
  const tabs = h("div", { class: "fp-tabs", role: "tablist" });
  const list = h("div", { class: "fp-list", role: "listbox", "aria-label": "Fonts", tabindex: -1 });
  const fileInput = h("input", { type: "file", accept: FONT_ACCEPT, multiple: true, hidden: true });
  const addBtn = h("button", { type: "button", class: "fp-add" }, icon("plus", { size: "sm" }), h("span", null, "Add a font file"), h("span", { class: "fp-add-note" }, "TTF, OTF, WOFF"));
  const root = h(
    "div",
    { class: "fp", "aria-label": "Fonts" },
    h("div", { class: "fp-search" }, icon("search", { size: "sm" }), search),
    tabs,
    list,
    h("div", { class: "fp-foot" }, addBtn, fileInput)
  );

  // ---- preview ----

  const preview = (family) => {
    clearTimeout(previewTimer);
    if (family === previewing) return;
    previewTimer = setTimeout(() => {
      previewing = family;
      onPreview?.(family);
    }, PREVIEW_DELAY);
  };
  const endPreview = () => {
    clearTimeout(previewTimer);
    if (previewing === null) return;
    previewing = null;
    onPreviewEnd?.();
  };
  const choose = (family) => {
    clearTimeout(previewTimer);
    picked = true;
    previewing = null;
    onChange?.(family);
    pop?.close?.();
  };

  // ---- faces ----

  const applyFace = (row) => {
    if (row.faced) return;
    const f = row.info;
    // The current family shows at the layer's weight, the others at their default.
    const w = row.el.classList.contains("current") && fonts?.nearestWeight ? fonts.nearestWeight(f.family, weight) : f.defaultWeight || 400;
    const set = () => {
      row.faced = true;
      const stack = fonts?.stack?.(f.family) || `"${f.family}"`;
      for (const el of [row.name, row.sample]) {
        el.style.fontFamily = stack;
        el.style.fontWeight = String(w);
      }
      row.el.classList.add("faced");
    };
    if (f.source === "system" || !fonts?.load) return set();
    row.faced = "loading";
    fonts
      .load(f.family, w, "normal", { retry: true })
      .then((ok) => {
        if (ok) set();
        else row.faced = false;
      })
      .catch(() => (row.faced = false));
  };

  const observe = (row) => {
    if (typeof IntersectionObserver === "undefined") return applyFace(row);
    observer ??= new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const row = rows.find((r) => r.el === e.target);
          if (row) applyFace(row);
          observer.unobserve(e.target);
        }
      },
      { root: list, rootMargin: "120px 0px" }
    );
    observer.observe(row.el);
  };

  // ---- list ----

  const setActive = (i, { scroll = true, previewIt = true } = {}) => {
    if (!rows.length) return;
    active = Math.max(0, Math.min(rows.length - 1, i));
    rows.forEach((r, j) => r.el.classList.toggle("active", j === active));
    const row = rows[active];
    list.setAttribute("aria-activedescendant", row.el.id);
    if (scroll) row.el.scrollIntoView({ block: "nearest" });
    if (previewIt) preview(row.info.family);
  };

  function makeRow(f, idx) {
    const name = h("span", { class: "fp-name" }, f.label || f.family);
    const sample = h("span", { class: "fp-sample" }, f.sample || "Aa");
    const meta = h("span", { class: "fp-meta" }, fontMeta(f));
    const current = value && norm(value) === norm(f.family);
    const el = h(
      "div",
      { class: ["fp-row", current && "current"], role: "option", id: `fp-${idx}`, "aria-selected": String(!!current), "data-tip": f.credit ? `${f.label || f.family} by ${f.credit}` : null },
      name,
      h("span", { class: "fp-right" }, meta, sample),
      current ? icon("check", { size: "sm", class: "fp-check" }) : null
    );
    const row = { el, info: f, name, sample, faced: false };
    el.addEventListener("pointerenter", () => {
      const i = rows.indexOf(row);
      if (i >= 0) setActive(i, { scroll: false });
    });
    el.addEventListener("click", () => choose(f.family));
    return row;
  }

  function build() {
    observer?.disconnect();
    rows = [];
    active = -1;
    const all = fonts?.list?.() || [];
    const matches = filterFonts(all, query);
    const groups = groupFonts(matches, { keepEmpty: query ? [] : ["custom"] });
    list.replaceChildren();
    tabs.replaceChildren();
    let idx = 0;
    for (const g of groups) {
      const head = h("div", { class: "fp-group micro", id: `fp-g-${g.id}`, dataset: { group: g.id } }, g.label);
      list.append(head);
      if (!g.items.length && g.id === "custom") {
        list.append(h("div", { class: "fp-hint" }, "Fonts you add show up here. They stay on this computer."));
      }
      for (const f of g.items) {
        const row = makeRow(f, idx++);
        rows.push(row);
        list.append(row.el);
        observe(row);
      }
      const tab = h("button", { type: "button", class: "fp-tab", role: "tab", dataset: { group: g.id } }, g.label);
      tab.addEventListener("click", () => {
        list.scrollTo({ top: head.offsetTop - 2, behavior: "smooth" });
        markTab(g.id);
      });
      tabs.append(tab);
    }
    if (!rows.length) {
      list.append(
        h("div", { class: "fp-empty" }, h("p", null, query ? `No fonts match "${query}"` : "No fonts yet"), h("p", { class: "muted" }, "Add a font file to use it here."))
      );
    }
    const cur = rows.findIndex((r) => r.el.classList.contains("current"));
    if (cur >= 0 && !query) {
      active = cur;
      rows[cur].el.classList.add("active");
      requestAnimationFrame(() => {
        const el = rows[cur]?.el;
        if (el) list.scrollTop = Math.max(0, el.offsetTop - list.clientHeight / 2 + el.offsetHeight / 2);
        spy();
      });
    } else {
      requestAnimationFrame(spy);
    }
  }

  function markTab(id) {
    for (const t of tabs.children) {
      const on = t.dataset.group === id;
      t.classList.toggle("on", on);
      t.setAttribute("aria-selected", String(on));
      if (on) t.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  // Highlight the tab of the group at the top of the list.
  function spy() {
    const heads = [...list.querySelectorAll(".fp-group")];
    if (!heads.length) return;
    const top = list.scrollTop + 8;
    let cur = heads[0];
    for (const hd of heads) if (hd.offsetTop <= top) cur = hd;
    if (list.scrollTop > 0 && list.scrollTop + list.clientHeight >= list.scrollHeight - 2) cur = heads[heads.length - 1];
    markTab(cur.dataset.group);
  }

  // ---- events ----

  list.addEventListener("scroll", () => requestAnimationFrame(spy), { passive: true });
  list.addEventListener("pointerleave", endPreview);
  search.addEventListener("input", () => {
    query = search.value;
    endPreview();
    build();
    list.scrollTop = 0;
  });
  search.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive(active < 0 ? 0 : active + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      setActive((active < 0 ? 0 : active) + (e.key === "PageDown" ? 8 : -8));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[active] || (rows.length === 1 ? rows[0] : null);
      if (row) choose(row.info.family);
    } else if (e.key === "Escape") {
      // Normally the popover's onEscape gets here first; this covers hosts
      // that let the key through.
      if (search.value) {
        e.preventDefault();
        clearSearch();
      } else {
        pop?.close?.();
      }
    }
  });
  function clearSearch() {
    search.value = "";
    query = "";
    endPreview();
    build();
    list.scrollTop = 0;
  }
  root.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" && e.key !== "Tab") e.stopPropagation();
  });

  const addFiles = async (files) => {
    const list = [...(files || [])].filter((f) => /\.(ttf|otf|woff2?)$/i.test(f.name) || /^font\//.test(f.type));
    if (!list.length) return;
    if (!fonts?.addCustom) return;
    let family = null;
    for (const file of list) {
      try {
        family = await fonts.addCustom(file);
      } catch (err) {
        ctx?.ui?.toast?.(err?.message || "That font could not be added.", { kind: "error" });
      }
    }
    if (family) {
      ctx?.ui?.toast?.(`Added ${family}`, { kind: "ok" });
      choose(family);
    }
  };
  addBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    addFiles(fileInput.files);
    fileInput.value = "";
  });
  root.addEventListener("dragover", (e) => {
    if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === "file")) {
      e.preventDefault();
      e.stopPropagation();
      root.classList.add("drop");
    }
  });
  root.addEventListener("dragleave", (e) => {
    if (!root.contains(e.relatedTarget)) root.classList.remove("drop");
  });
  root.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    root.classList.remove("drop");
    addFiles(e.dataTransfer?.files);
  });
  if (fonts?.addEventListener) {
    const onFonts = () => {
      if (!document.contains(root)) return;
      const keep = list.scrollTop;
      build();
      list.scrollTop = keep;
    };
    fonts.addEventListener("change", onFonts);
    offs.push(() => fonts.removeEventListener("change", onFonts));
  }

  build();

  const pop = showPopover(ctx, anchorEl, root, {
    placement,
    className: "fp-pop",
    // Escape clears a search first (back to browsing); the next one closes.
    onEscape: () => {
      if (!search.value) return false;
      clearSearch();
      return true;
    },
    onClose: () => {
      clearTimeout(previewTimer);
      observer?.disconnect();
      offs.forEach((f) => f());
      if (!picked && previewing !== null) {
        previewing = null;
        onPreviewEnd?.();
      }
      onClose?.();
    },
  });
  if (!pop || pop.closed) {
    observer?.disconnect();
    offs.forEach((f) => f());
    return DEAD_POPOVER;
  }
  offs.push(on(window, "blur", endPreview));
  // Typing searches straight away, whichever way the picker was opened.
  requestAnimationFrame(() => document.activeElement !== search && search.focus({ preventScroll: true }));
  return { el: root, close: () => pop?.close?.() };
}
