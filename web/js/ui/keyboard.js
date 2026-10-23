// One global keydown listener for every command shortcut, Space for the
// temporary hand tool, and the keyboard shortcuts sheet.
//
// Order of precedence: open menus, popovers, dialogs and the palette handle
// their own keys (menus.js closes the top one on Escape); the editor and its
// tools call preventDefault() on keys they use; whatever is left goes to
// ctx.commands.match().

import { h, isTyping, isMac, fieldOwnsCombo } from "./dom.js";
import { keysLabel, normalizeEvent, normalizeKeys } from "../app/context.js";
import { kbdNodes } from "./menus.js";
import { GROUP_ORDER } from "./palette.js";

// Commands that make sense while Home covers the canvas.
const HOME_OK = /^(file\.new|file\.open|view\.palette|view\.theme|app\.|help\.|tools\.)/;

export function allowedOnHome(cmd) {
  return !!cmd && (cmd.home === true || HOME_OK.test(cmd.id));
}

// Commands a key may run while a drag on the canvas is open.
const MID_DRAG_OK = new Set(["edit.undo", "edit.redo"]);

// A modal that other modules mount on their own (export, quick tools,
// settings) is open: app shortcuts must not act on the hidden canvas, and
// Home must not take its keys or pastes.
export function foreignModal() {
  for (const el of document.querySelectorAll('[aria-modal="true"]')) {
    if (el.id === "home" || el.closest("[hidden], .closing")) continue;
    return true;
  }
  return false;
}

// Browser shortcuts that keep working when the app's command for the same
// keys cannot run: clipboard and undo in page text, page zoom, tab switching.
const BROWSER_KEEPS = /^Mod\+(?:C|X|V|A|Z|Y|0|=|-|[1-9])$|^Mod\+Shift\+Z$/;

// A combo the browser should not get even though no command ran for it: one
// bound to a command that is disabled right now (Ctrl+S on Home would open
// "Save page as", Ctrl+D a bookmark). Only modifier combos; plain keys such as
// the arrows keep scrolling and moving focus.
export function swallowCombo(combo) {
  return /^(?:Mod|Ctrl|Alt)\+/.test(combo) && !BROWSER_KEEPS.test(combo);
}

// The command bound to this event whether or not it can run now (the same
// typing rules as ctx.commands.match), or null.
export function boundCommand(commands, e) {
  const combo = normalizeEvent(e);
  const typing = fieldOwnsCombo(combo, e.target);
  for (const c of commands) {
    if (!c.keys) continue;
    for (const k of c.keys) {
      if (normalizeKeys(k) !== combo) continue;
      const plain = !/^(Mod|Ctrl|Alt)\+/.test(combo) && !/^F\d+$/.test(combo);
      if (typing && (plain || c.allowInFields !== true)) continue;
      return c;
    }
  }
  return null;
}

export function installKeyboard(ctx) {
  let spaceHeld = false;
  let toolBefore = null;

  const homeOpen = () => !!ctx.ui.isHomeOpen?.();
  const textEditing = () => !!ctx.editor?.textEditing;

  function startSpace() {
    const ed = ctx.editor;
    if (!ed?.setTool) return;
    spaceHeld = true;
    toolBefore = ed.tool;
    if (toolBefore !== "hand") ed.setTool("hand", { temporary: true });
  }

  function endSpace() {
    if (!spaceHeld) return;
    spaceHeld = false;
    const ed = ctx.editor;
    if (ed?.setTool && toolBefore && toolBefore !== "hand" && ed.tool === "hand") ed.setTool(toolBefore, { temporary: true });
    toolBefore = null;
  }

  // A control reached with the keyboard keeps Space and Enter for activation.
  function focusedControl() {
    const ae = document.activeElement;
    return !!ae && ae !== document.body && !!ae.matches?.(":focus-visible") && !!ae.closest?.("button, a, summary, [role=button], [role=switch], [role=tab], [role=menuitem]");
  }

  function onKeyDown(e) {
    if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
    if (ctx.ui.isBlocking?.() || foreignModal()) return;
    // A popover (canvas size, shapes) keeps its plain keys: arrows move through
    // its list and Delete must not remove the layer behind it.
    const plainKey = !e.ctrlKey && !e.metaKey && !e.altKey;
    if (plainKey && e.target?.nodeType && ctx.ui.layers?.().some((l) => l.el?.contains?.(e.target))) return;

    // The editor pans with Space itself; this is the fallback for when it
    // does not claim the key.
    if (e.code === "Space" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (isTyping(e.target) || textEditing() || homeOpen()) return;
      if (focusedControl()) return;
      e.preventDefault();
      if (!e.repeat && !spaceHeld) startSpace();
      return;
    }
    // Enter on a focused button presses it instead of running image.crop or text.edit.
    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey && focusedControl()) return;

    const cmd = ctx.commands.match(e);
    if (!cmd || (homeOpen() && !allowedOnHome(cmd))) {
      swallowIdle(e);
      return;
    }
    // Mid-drag a command would land inside the open Move or Resize step
    // (Delete, Duplicate, a pasted layer): only undo and redo run, and they
    // close the drag first. Escape is the tool's (it cancels the drag).
    if (ctx.editor?.interacting && !MID_DRAG_OK.has(cmd.id)) {
      e.preventDefault();
      return;
    }
    if (cmd.nativeKeys) return;
    e.preventDefault();
    ctx.commands.run(cmd.id, { source: "keyboard", shiftKey: e.shiftKey, altKey: e.altKey, repeat: e.repeat });
  }

  // Keys bound to a command that cannot run now stay away from the browser.
  function swallowIdle(e) {
    const combo = normalizeEvent(e);
    if (!swallowCombo(combo)) return;
    const c = boundCommand(ctx.commands.list(), e);
    if (!c || c.nativeKeys) return;
    e.preventDefault();
    if (homeOpen() && !allowedOnHome(c)) ctx.ui.toast?.("Open or start a design first.", { kind: "info", id: "home-blocked", timeout: 2000 });
  }

  function onKeyUp(e) {
    if (e.code === "Space" && spaceHeld) {
      e.preventDefault();
      endSpace();
    }
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", endSpace);
  const offVis = () => document.hidden && endSpace();
  document.addEventListener("visibilitychange", offVis);

  return {
    dispose() {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", endSpace);
      document.removeEventListener("visibilitychange", offVis);
    },
    get spaceHeld() {
      return spaceHeld;
    },
  };
}

// ---- the shortcuts sheet --------------------------------------------------------

// Things you do with the mouse or a held key that are not commands.
const MOD = isMac ? "⌘" : "Ctrl";
const ALT = isMac ? "⌥" : "Alt";
const GESTURES = [
  ["Pan the canvas", "Space + drag, or scroll"],
  ["Zoom at the pointer", `${MOD} + scroll, or pinch`],
  ["Skip snapping while dragging", `Hold ${MOD}`],
  ["Resize from the center", `Hold ${ALT}`],
  ["Keep proportions or free them", "Hold Shift"],
  ["Rotate in 15° steps", "Shift while rotating"],
  ["Add to the selection", "Shift + click"],
  ["Keep a tool after one use", "Double-click its button"],
  ["Edit text or crop an image", "Double-click it"],
  ["Fit the canvas", "Double-click empty space"],
];

export function shortcutGroups(commands) {
  const groups = new Map();
  for (const c of commands) {
    if (c.hidden && !c.keys?.length) continue;
    const g = c.group || "Other";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }
  const order = (g) => {
    const i = GROUP_ORDER.indexOf(g);
    return i < 0 ? GROUP_ORDER.length : i;
  };
  return [...groups.entries()].sort((a, b) => order(a[0]) - order(b[0])).map(([group, list]) => ({ group, list }));
}

function keysCell(keys) {
  const cell = h("span", { class: "sheet-keys" });
  (keys || []).forEach((k, i) => {
    if (i) cell.append(h("span", { class: "sheet-or" }, "or"));
    cell.append(h("span", { class: "sheet-combo" }, kbdNodes(keysLabel(k))));
  });
  return cell;
}

export function openShortcuts(ctx) {
  const all = ctx.commands.list();
  const nudges = all.filter((c) => c.id.startsWith("nudge."));
  const list = all.filter((c) => !c.id.startsWith("nudge."));
  const search = h("input", { type: "search", class: "input sheet-search", placeholder: "Filter shortcuts", spellcheck: "false", autocomplete: "off", "aria-label": "Filter shortcuts" });
  const cols = h("div", { class: "sheet-cols" });

  const nudgeRow = () =>
    h(
      "div",
      { class: "sheet-row" },
      h("span", { class: "sheet-title" }, "Nudge 1 px, with Shift 10 px"),
      h("span", { class: "sheet-keys" }, h("span", { class: "sheet-combo" }, ["←", "↑", "→", "↓"].map((k) => h("kbd", null, k)))),
    );

  function render() {
    const q = search.value.trim().toLowerCase();
    const match = (t) => !q || t.toLowerCase().includes(q);
    cols.replaceChildren();
    for (const { group, list: cmds } of shortcutGroups(list)) {
      const rows = cmds
        .filter((c) => match(`${c.title} ${c.group || ""} ${c.keywords || ""}`))
        .sort((a, b) => (b.keys?.length ? 1 : 0) - (a.keys?.length ? 1 : 0))
        .map((c) => h("div", { class: ["sheet-row", !c.keys?.length && "no-keys"] }, h("span", { class: "sheet-title" }, c.title), c.keys?.length ? keysCell(c.keys) : null));
      if (group === "Align" && nudges.length && match("nudge move arrow keys")) rows.push(nudgeRow());
      if (!rows.length) continue;
      cols.append(h("section", { class: "sheet-group" }, h("h3", { class: "micro" }, group), rows));
    }
    const gestures = GESTURES.filter(([a, b]) => match(`${a} ${b}`));
    if (gestures.length) {
      cols.append(h("section", { class: "sheet-group" }, h("h3", { class: "micro" }, "Mouse and trackpad"), gestures.map(([a, b]) => h("div", { class: "sheet-row" }, h("span", { class: "sheet-title" }, a), h("span", { class: "sheet-gesture" }, b)))));
    }
    if (!cols.childElementCount) cols.append(h("p", { class: "muted sheet-empty" }, `No shortcuts match "${search.value.trim()}".`));
  }

  search.addEventListener("input", render);
  render();
  return ctx.ui.dialog({
    title: "Keyboard shortcuts",
    description: `Every action is also one search away: press ${keysLabel("Mod+K")}.`,
    wide: true,
    className: "sheet",
    body: h("div", { class: "sheet-body" }, search, cols),
  });
}
