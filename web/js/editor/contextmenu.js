// Right-click menu on the canvas. On a layer it acts on the selection (the
// layer is selected first; locked layers are included so they can be
// unlocked); on empty canvas it offers paste, select all and canvas settings.
// Items run commands, so shortcuts and enabled states match the palette.

import { keysLabel } from "../app/context.js";
import { pickLayer } from "../core/geometry.js";

export function createContextMenu(core) {
  const { ctx, store } = core;

  function cmd(id, label, icon, extra = {}) {
    if (!ctx.commands.get(id)) return null;
    return { label, icon, kbd: ctx.commands.keysLabel(id), disabled: !ctx.commands.enabled(id), run: () => ctx.commands.run(id), ...extra };
  }

  function layerItems() {
    const sel = store.selected();
    const one = sel.length === 1 ? sel[0] : null;
    const allLocked = sel.length > 0 && sel.every((l) => l.locked);
    const items = [
      cmd("layer.duplicate", "Duplicate", "copy-plus"),
      { label: "Copy", icon: "copy", kbd: keysLabel("Mod+C"), run: () => core.editor.copy() },
      { label: "Paste", icon: "clipboard", kbd: keysLabel("Mod+V"), run: () => core.editor.paste() },
      "-",
      cmd("layer.forward", "Bring forward", "chevron-up"),
      cmd("layer.backward", "Send backward", "chevron-down"),
      cmd("layer.front", "Bring to front", "chevrons-up"),
      cmd("layer.back", "Send to back", "chevrons-down"),
      "-",
      cmd("align.center", "Center on canvas", "align-center"),
      "-",
      cmd("layer.lock", allLocked ? "Unlock" : "Lock", allLocked ? "unlock" : "lock"),
      cmd("layer.hide", "Hide", "eye-off"),
    ];
    if (one?.type === "image") {
      items.push("-", cmd("image.crop", "Crop", "crop"), cmd("image.remove-bg", "Remove background", "remove-bg"));
    }
    if (one?.type === "text") items.push("-", cmd("text.edit", "Edit text", "type"));
    items.push("-", cmd("edit.delete", "Delete", "trash", { danger: true }));
    return tidy(items);
  }

  function canvasItems() {
    return tidy([
      { label: "Paste", icon: "clipboard", kbd: keysLabel("Mod+V"), run: () => core.editor.paste() },
      cmd("edit.select-all", "Select all", "select-all"),
      "-",
      {
        label: "Canvas settings",
        icon: "canvas",
        run: () => {
          store.clearSelection();
          ctx.emit("canvas-settings", {});
        },
      },
      cmd("view.fit", "Zoom to fit", "maximize"),
    ]);
  }

  // Drop missing commands and doubled or dangling separators.
  function tidy(items) {
    const out = [];
    for (const it of items) {
      if (!it) continue;
      if (it === "-" && (!out.length || out[out.length - 1] === "-")) continue;
      out.push(it);
    }
    while (out[out.length - 1] === "-") out.pop();
    return out;
  }

  function onContextMenu(e) {
    if (e.target !== core.canvas) return;
    e.preventDefault();
    if (!ctx.ui?.menu) return;
    if (core.crop.active) core.crop.end(true);
    if (core.textEditing) core.editor.stopTextEdit();
    core.viewport.measure();
    const p = core.viewport.clientToDoc(e.clientX, e.clientY);
    const hit = pickLayer(store.doc, p, { tol: 4 / core.viewport.zoom, assets: ctx.assets, includeLocked: true });
    if (hit && !store.selection.includes(hit.id)) store.select([hit.id]);
    if (!hit && store.selection.length) store.clearSelection();
    ctx.ui.menu(hit ? layerItems() : canvasItems(), { x: e.clientX, y: e.clientY });
  }

  core.host.addEventListener("contextmenu", onContextMenu);

  return {
    dispose() {
      core.host.removeEventListener("contextmenu", onContextMenu);
    },
  };
}
