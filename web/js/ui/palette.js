// Command palette (Ctrl K or /): fuzzy search over every command, plus layers,
// presets and themes. Recent commands first when the query is empty.

import { h, clear } from "./dom.js";
import { icon } from "./icons.js";
import { kbdNodes } from "./menus.js";

// ---- fuzzy matching (pure) ------------------------------------------------------

const SEPARATORS = " -_./:()·,+";
const NEG = -1e9;

function isWordStart(text, i) {
  if (i === 0) return true;
  const prev = text[i - 1];
  if (SEPARATORS.includes(prev)) return true;
  const c = text[i];
  return prev === prev.toLowerCase() && c !== c.toLowerCase() && c === c.toUpperCase();
}

// Best alignment of query's characters, in order, inside text. Rewards word
// starts and runs of consecutive characters, penalises gaps. Returns
// { score, indices } or null when the characters do not all appear.
export function fuzzyMatch(query, text) {
  const q = String(query || "").toLowerCase();
  const t = String(text || "");
  const tl = t.toLowerCase();
  if (!q) return { score: 0, indices: [] };
  const m = q.length;
  const n = t.length;
  if (m > n) return null;

  const sub = tl.indexOf(q);
  if (sub >= 0) {
    const start = isWordStart(t, sub);
    const score = 100 + m * 12 + (sub === 0 ? 40 : 0) + (start ? 25 : 0) - sub * 0.5 - (n - m) * 0.1;
    return { score, indices: Array.from({ length: m }, (_, k) => sub + k) };
  }

  // score[i][j]: best score with q[i] matched at t[j]; from[i][j]: where q[i-1] sat.
  const score = Array.from({ length: m }, () => new Float64Array(n).fill(NEG));
  const from = Array.from({ length: m }, () => new Int32Array(n).fill(-1));
  for (let j = 0; j < n; j++) {
    if (tl[j] !== q[0]) continue;
    score[0][j] = 10 + (isWordStart(t, j) ? 12 : 0) + (j === 0 ? 6 : 0) - j * 0.3;
  }
  for (let i = 1; i < m; i++) {
    let g = NEG;
    let gArg = -1;
    for (let j = 1; j < n; j++) {
      // g: best score[i-1][p] - (j - p - 1) over p <= j - 2.
      if (j >= 2) {
        g -= 1;
        const cand = score[i - 1][j - 2] - 1;
        if (cand > g) {
          g = cand;
          gArg = j - 2;
        }
      }
      if (tl[j] !== q[i]) continue;
      const bonus = 10 + (isWordStart(t, j) ? 12 : 0);
      const cons = score[i - 1][j - 1] > NEG / 2 ? score[i - 1][j - 1] + 8 : NEG;
      if (cons >= g && cons > NEG / 2) {
        score[i][j] = cons + bonus;
        from[i][j] = j - 1;
      } else if (g > NEG / 2) {
        score[i][j] = g + bonus;
        from[i][j] = gArg;
      }
    }
  }
  let best = NEG;
  let end = -1;
  for (let j = 0; j < n; j++) {
    if (score[m - 1][j] > best) {
      best = score[m - 1][j];
      end = j;
    }
  }
  if (end < 0 || best <= NEG / 2) return null;
  const indices = new Array(m);
  for (let i = m - 1, j = end; i >= 0; i--) {
    indices[i] = j;
    j = from[i][j];
  }
  return { score: best - (n - m) * 0.1, indices };
}

// A word found inside keywords or a group name (no scattered matches there:
// they read as noise). Word-start hits score higher.
function wordHit(word, text) {
  const tl = String(text || "").toLowerCase();
  const i = tl.indexOf(word);
  if (i < 0) return null;
  return 60 + word.length * 8 + (isWordStart(String(text), i) ? 30 : 0);
}

// Every word of the query must match the title (fuzzy), the keywords or the
// group. Returns { score, indices } where indices point into the title, or null.
export function scoreItem(query, item) {
  const words = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { score: 0, indices: [] };
  const title = item.title || "";
  let total = 0;
  const hits = new Set();
  for (const w of words) {
    let inTitle = fuzzyMatch(w, title);
    // Scattered title matches must still be fairly tight.
    if (inTitle && inTitle.score < w.length * 7) inTitle = null;
    const inKeys = item.keywords ? wordHit(w, item.keywords) : null;
    const inGroup = item.group ? wordHit(w, item.group) : null;
    const options = [inTitle && { s: inTitle.score, r: inTitle }, inKeys && { s: inKeys * 0.7 }, inGroup && { s: inGroup * 0.5 }].filter(Boolean);
    if (!options.length) return null;
    const pick = options.reduce((a, b) => (b.s > a.s ? b : a));
    total += pick.s;
    if (pick.r) for (const i of pick.r.indices) hits.add(i);
  }
  const phrase = title.toLowerCase().indexOf(words.join(" "));
  if (words.length > 1 && phrase >= 0) total += 60;
  return { score: total + (item.boost || 0), indices: [...hits].sort((a, b) => a - b) };
}

// Split text into [{ text, hit }] runs for highlighting.
export function highlightRuns(text, indices) {
  const set = new Set(indices || []);
  const runs = [];
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    const last = runs[runs.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else runs.push({ text: text[i], hit });
  }
  return runs;
}

export const GROUP_ORDER = ["Recent", "File", "Edit", "Insert", "Tools", "Layer", "Arrange", "Align", "Text", "Image", "Canvas", "View", "Export", "Mods", "App", "Help", "New design", "Layers", "Themes"];

function groupRank(g) {
  const i = GROUP_ORDER.indexOf(g);
  return i < 0 ? GROUP_ORDER.length : i;
}

// Rank items for a query and bucket them into groups. With a query, the group
// that holds the best match comes first; without one, groups keep GROUP_ORDER.
export function rankItems(items, query, { limit = 60 } = {}) {
  const q = String(query || "").trim();
  let scored;
  if (!q) {
    scored = items.filter((it) => !it.queryOnly).map((it, i) => ({ it, score: 0, indices: [], i }));
    scored.sort((a, b) => groupRank(a.it.group) - groupRank(b.it.group) || a.i - b.i);
  } else {
    scored = [];
    items.forEach((it, i) => {
      const r = scoreItem(q, it);
      if (r) scored.push({ it, score: r.score, indices: r.indices, i });
    });
    scored.sort((a, b) => b.score - a.score || a.i - b.i);
    scored = scored.slice(0, limit);
  }
  const groups = [];
  const byName = new Map();
  for (const s of scored) {
    const g = s.it.group || "Other";
    if (!byName.has(g)) {
      const entry = { group: g, rows: [] };
      byName.set(g, entry);
      groups.push(entry);
    }
    byName.get(g).rows.push(s);
  }
  return groups;
}

// ---- the palette ---------------------------------------------------------------------

const RECENT_KEY = "recentCommands";
const RECENT_MAX = 6;

const ON_HOME = (id) => /^(file\.new|file\.open|view\.palette|view\.theme|app\.|help\.|tools\.)/.test(id);

export function createPalette(ctx) {
  let state = null;

  function recent() {
    const list = ctx.prefs.get(RECENT_KEY, []);
    return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
  }

  function remember(id) {
    const list = [id, ...recent().filter((x) => x !== id)].slice(0, RECENT_MAX);
    ctx.prefs.set(RECENT_KEY, list);
  }

  function homeOpen() {
    return !!ctx.ui.isHomeOpen?.();
  }

  function collect() {
    const items = [];
    const onHome = homeOpen();
    const commands = ctx.commands.list().filter((c) => !c.hidden && ctx.commands.enabled(c.id) && (!onHome || c.home || ON_HOME(c.id)));
    const recents = recent();
    for (const id of recents) {
      const c = commands.find((x) => x.id === id);
      if (c) items.push(commandItem(c, { group: "Recent", recent: true }));
    }
    for (const c of commands) items.push(commandItem(c, { duplicateOfRecent: recents.includes(c.id) }));
    for (const p of ctx.presets?.list?.() || []) {
      if (p.custom) continue;
      items.push({
        key: `preset:${p.id}`,
        title: `New ${p.label}`,
        group: "New design",
        icon: "file-plus",
        hint: `${p.width} × ${p.height}`,
        keywords: `new create start ${p.group} ${p.keywords || ""} ${p.width}x${p.height}`,
        queryOnly: true,
        run: () => ctx.commands.run("file.new", { preset: p.id }),
      });
    }
    if (!onHome) {
      const layers = (ctx.store?.layers() || []).slice().reverse();
      for (const l of layers) {
        items.push({
          key: `layer:${l.id}`,
          title: `Select layer: ${l.name || "Layer"}`,
          group: "Layers",
          icon: { image: "image", text: "type", shape: "square", path: "pen", arrow: "arrow-up-right" }[l.type] || "layers",
          hint: l.hidden ? "Hidden" : l.locked ? "Locked" : "",
          keywords: `layer select ${l.type}`,
          queryOnly: true,
          run: () => {
            ctx.store.select([l.id]);
            ctx.editor?.flash?.([l.id]);
          },
        });
      }
    }
    const current = ctx.themes?.current?.()?.id;
    for (const t of ctx.themes?.list?.() || []) {
      items.push({
        key: `theme:${t.id}`,
        title: `Theme: ${t.name}`,
        group: "Themes",
        icon: t.scheme === "light" ? "sun" : "moon",
        hint: t.id === current ? "Current" : t.note || "",
        keywords: "theme colour color appearance look dark light",
        queryOnly: true,
        run: () => ctx.commands.run("view.theme", { id: t.id }),
      });
    }
    return items;
  }

  function commandItem(c, { group, recent, duplicateOfRecent } = {}) {
    return {
      key: `${recent ? "recent" : "cmd"}:${c.id}`,
      id: c.id,
      title: c.title,
      group: group || c.group || "Other",
      icon: c.icon,
      kbd: ctx.commands.keysLabel(c.id),
      keywords: `${c.keywords || ""} ${c.id.replace(/[.-]/g, " ")}`,
      // Recents show only for an empty query; with a query the real entry ranks.
      recentOnly: !!recent,
      boost: duplicateOfRecent ? 4 : 0,
      run: () => {
        remember(c.id);
        return ctx.commands.run(c.id);
      },
    };
  }

  function open(initial = "") {
    if (state) {
      state.input.focus();
      state.input.select();
      return;
    }
    const input = h("input", {
      type: "text",
      class: "palette-input",
      placeholder: homeOpen() ? "Search: new design, open, settings" : "Search or run a command",
      spellcheck: "false",
      autocomplete: "off",
      "aria-label": "Search commands",
      role: "combobox",
      "aria-expanded": "true",
      "aria-controls": "palette-list",
      "aria-autocomplete": "list",
    });
    const list = h("div", { class: "palette-list", id: "palette-list", role: "listbox" });
    const foot = h(
      "div",
      { class: "palette-foot" },
      h("span", null, h("kbd", null, "↑"), h("kbd", null, "↓"), " to move"),
      h("span", null, h("kbd", null, "Enter"), " to run"),
      h("span", null, h("kbd", null, "Esc"), " to close"),
    );
    const panel = h(
      "div",
      { class: "palette", role: "dialog", "aria-modal": "true", "aria-label": "Command palette" },
      h("div", { class: "palette-field" }, icon("search", { class: "palette-search" }), input, h("kbd", { class: "palette-esc" }, "Esc")),
      list,
      foot,
    );
    const backdrop = h("div", { class: "palette-backdrop" }, panel);
    const prevFocus = document.activeElement;
    const items = collect();
    state = { input, list, panel, backdrop, items, rows: [], active: 0, prevFocus };

    const layer = {
      kind: "palette",
      el: panel,
      modal: true,
      close: () => close(),
    };
    state.layer = layer;

    input.addEventListener("input", () => render());
    input.addEventListener("keydown", onKey);
    backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === backdrop) close();
    });
    document.getElementById("modal-root")?.append(backdrop) ?? document.body.append(backdrop);
    ctx.ui.pushLayer?.(layer);
    input.value = initial;
    render();
    input.focus();
  }

  function close() {
    if (!state) return;
    const s = state;
    state = null;
    ctx.ui.dropLayer?.(s.layer);
    s.backdrop.classList.add("closing");
    setTimeout(() => s.backdrop.remove(), 140);
    if (s.prevFocus?.isConnected) s.prevFocus.focus?.({ preventScroll: true });
  }

  function render() {
    const s = state;
    const q = s.input.value;
    const empty = !q.trim();
    const groups = rankItems(empty ? s.items : s.items.filter((it) => !it.recentOnly), q);
    clear(s.list);
    s.rows = [];
    for (const g of groups) {
      const groupEl = h("div", { class: "palette-group", role: "group", "aria-label": g.group }, h("div", { class: "palette-heading micro" }, g.group));
      for (const { it, indices } of g.rows) {
        const index = s.rows.length;
        const title = h("span", { class: "palette-title" }, highlightRuns(it.title, indices).map((r) => (r.hit ? h("mark", null, r.text) : r.text)));
        const row = h(
          "div",
          { class: "palette-row", role: "option", id: `palette-opt-${index}`, "aria-selected": "false" },
          h("span", { class: "palette-icon" }, icon(it.icon || "command", { size: "sm" })),
          title,
          it.hint ? h("span", { class: "palette-hint" }, it.hint) : null,
          it.kbd ? h("span", { class: "palette-kbd" }, kbdNodes(it.kbd)) : null,
        );
        row.addEventListener("pointermove", () => {
          if (s.active !== index) setActive(index, false);
        });
        row.addEventListener("click", () => runRow(index));
        groupEl.append(row);
        s.rows.push({ row, it });
      }
      s.list.append(groupEl);
    }
    if (!s.rows.length) {
      s.list.append(
        h(
          "div",
          { class: "palette-empty" },
          h("div", { class: "palette-empty-title" }, `Nothing matches "${q.trim()}"`),
          h("div", { class: "muted" }, "Try a shorter word, like “align” or “export”."),
        ),
      );
    }
    setActive(0, true);
  }

  function setActive(i, scroll = true) {
    const s = state;
    if (!s || !s.rows.length) return;
    s.active = Math.max(0, Math.min(s.rows.length - 1, i));
    s.rows.forEach((r, j) => {
      const on = j === s.active;
      r.row.classList.toggle("active", on);
      r.row.setAttribute("aria-selected", String(on));
    });
    s.input.setAttribute("aria-activedescendant", `palette-opt-${s.active}`);
    if (scroll) s.rows[s.active].row.scrollIntoView({ block: "nearest" });
  }

  function onKey(e) {
    const s = state;
    if (!s) return;
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey) || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      setActive(s.active + 1 >= s.rows.length ? 0 : s.active + 1);
    } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey) || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      setActive(s.active - 1 < 0 ? s.rows.length - 1 : s.active - 1);
    } else if (e.key === "PageDown") {
      e.preventDefault();
      setActive(s.active + 8);
    } else if (e.key === "PageUp") {
      e.preventDefault();
      setActive(s.active - 8);
    } else if (e.key === "Enter") {
      e.preventDefault();
      runRow(s.active);
    } else if ((e.ctrlKey || e.metaKey) && e.code === "KeyK") {
      // The palette shortcut again closes it (and keeps the browser's own Ctrl K away).
      e.preventDefault();
      close();
    }
    e.stopPropagation();
  }

  function runRow(i) {
    const r = state?.rows[i];
    if (!r) return;
    close();
    try {
      r.it.run();
    } catch (err) {
      console.error(err);
      ctx.ui.toast?.(err.message || "That did not work.", { kind: "error" });
    }
  }

  return {
    open,
    close,
    toggle: (q) => (state ? close() : open(q)),
    get isOpen() {
      return !!state;
    },
  };
}
