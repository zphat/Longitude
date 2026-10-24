// The parts of the app that load the first time they are used instead of at
// start: the export dialog, the feed preview and the quick tools (with
// css/export.css), and the image encoders (features/compress.js). Their
// commands are registered here at start, so the palette, shortcuts and
// tooltips list them; the first run fetches the module (a few ms, from the
// offline cache once installed) and then opens it. Pointing at a button that
// opens one starts the fetch before the click. sw.js precaches every file
// loaded here, so they all work offline.

import { loadStyle } from "./dom.js";
import { renderToCanvas } from "../core/render.js";

// A loader that runs once; a failed load (offline before the first use) is
// tried again next time.
function once(load) {
  let p = null;
  return () =>
    (p ||= load().catch((err) => {
      p = null;
      throw err;
    }));
}

let compress = null;

export const loadCompress = once(() => import("../features/compress.js").then((m) => (compress = m)));

// The compress module once something has loaded it, else null (ctx.exporter).
export const loadedCompress = () => compress;

const exportCss = () => loadStyle(new URL("../../css/export.css", import.meta.url).href);
// The dialog's module, its stylesheet and the encoders it uses, together.
const sheetModule = (load) => once(() => Promise.all([load(), exportCss(), loadCompress()]).then(([m]) => m));

export const loadExportDialog = sheetModule(() => import("./exportdialog.js"));
export const loadFeedPreview = sheetModule(() => import("./feedpreview.js"));
export const loadQuickTools = sheetModule(() => import("./quicktools.js"));

function cannotOpen(ctx, what, err) {
  console.error(`${what} could not load.`, err);
  ctx?.ui?.toast?.(`${what} could not open. Reload Longitude and try again.`, { kind: "error" });
  return { close() {} };
}

// Each resolves to the opened view's handle ({ close }).
export function openExport(ctx, opts) {
  return loadExportDialog().then(
    (m) => m.openExportDialog(ctx, opts || {}),
    (err) => cannotOpen(ctx, "Export", err),
  );
}

export function openFeedPreview(ctx, opts) {
  return loadFeedPreview().then(
    (m) => m.openFeedPreview(ctx, opts),
    (err) => cannotOpen(ctx, "The feed preview", err),
  );
}

export function openQuickTool(kind, ctx, opts) {
  return loadQuickTools().then(
    (m) => m.openQuickTool(kind, ctx, opts || {}),
    (err) => cannotOpen(ctx, "Quick tools", err),
  );
}

// Mod+Shift+C: the design at 1x as a PNG on the clipboard.
export async function copyDesign(ctx) {
  const doc = ctx.store?.doc;
  if (!doc) return false;
  const [{ copyImage }, canvas] = await Promise.all([
    loadCompress(),
    renderToCanvas(doc, { scale: 1, assets: ctx.assets, fonts: ctx.fonts, background: true }),
  ]);
  const ok = await copyImage(canvas);
  ctx.ui?.toast?.(ok ? "Copied as an image" : "This browser cannot copy images. Use Export instead.", { kind: ok ? "ok" : "warn" });
  return ok;
}

// ---- commands -------------------------------------------------------------------

// Export, copy, feed preview and the quick tools. Their icons are in the
// shell's set. Also provides ctx.ui.openExport, openFeedPreview and
// openQuickTool. Returns a dispose function.
export function registerExportCommands(ctx) {
  const offs = [];
  const hasDoc = (c) => !!c.store?.doc;
  const reg = (def) => offs.push(ctx.commands.register(def));
  reg({
    id: "file.export",
    title: "Export",
    group: "File",
    keys: ["Mod+E"],
    icon: "download",
    keywords: "download save jpg jpeg png webp image file size compress",
    when: hasDoc,
    run: (c, args) => openExport(c, args),
  });
  reg({
    id: "file.copy-image",
    title: "Copy image",
    group: "File",
    keys: ["Mod+Shift+C"],
    icon: "copy",
    keywords: "clipboard png copy as image",
    when: hasDoc,
    run: (c) => copyDesign(c),
  });
  reg({
    id: "view.feed-preview",
    title: "Preview in a feed",
    group: "View",
    keys: ["F"],
    icon: "play-rect",
    keywords: "youtube spotify mock home search sidebar up next phone real size",
    when: hasDoc,
    run: (c) => openFeedPreview(c),
  });
  reg({
    id: "tools.compress",
    title: "Compress images",
    group: "Tools",
    icon: "minimize-2",
    keywords: "shrink smaller file size optimize jpg png webp batch",
    run: (c, args) => openQuickTool("compress", c, args),
  });
  reg({
    id: "tools.remove-bg",
    title: "Remove a background",
    group: "Tools",
    icon: "remove-bg",
    keywords: "cutout cut out transparent png erase background",
    run: (c, args) => openQuickTool("remove-bg", c, args),
  });
  reg({
    id: "tools.convert",
    title: "Resize or convert images",
    group: "Tools",
    icon: "scaling",
    keywords: "scale format jpg png webp 1280x720 square batch",
    run: (c, args) => openQuickTool("convert", c, args),
  });

  ctx.ui = ctx.ui || {};
  const mine = {
    openExport: (opts) => openExport(ctx, opts),
    openFeedPreview: (opts) => openFeedPreview(ctx, opts),
    openQuickTool: (kind, opts) => openQuickTool(kind, ctx, opts),
  };
  Object.assign(ctx.ui, mine);
  return () => {
    offs.splice(0).forEach((off) => off());
    for (const [k, fn] of Object.entries(mine)) if (ctx.ui[k] === fn) delete ctx.ui[k];
  };
}

// ---- one version per page --------------------------------------------------------

// Every module the app imports after start: the views above, the settings
// (mods/loader.js), the encoders (features/compress.js) and background removal
// (features/bgremove). tests/shell-boot.test.js keeps the list complete.
export const ON_DEMAND = [
  "./exportdialog.js",
  "./feedpreview.js",
  "./quicktools.js",
  "./settings.js",
  "../features/compress.js",
  "../features/png8.js",
  "../features/zip.js",
  "../features/bgremove/mask.js",
  "../features/bgremove/engine.js",
  "../features/bgremove/pipeline.js",
  "../features/bgremove/runner.js",
].map((p) => new URL(p, import.meta.url).href);

// The service worker serves these from one cache that every tab shares, and
// switches in updated files when any tab reloads. So once this page hears of
// an update (staged files or a new worker version), every module it has not
// loaded yet is fetched and compiled now, without running, from the files it
// started with; later import() calls reuse them, and the page never links a
// newer module against its older ones. Runs once.
let pinned = false;
export function pinOnDemand(doc = globalThis.document) {
  if (pinned || !doc?.head || typeof doc.createElement !== "function") return false;
  pinned = true;
  for (const href of ON_DEMAND) {
    const link = doc.createElement("link");
    link.rel = "modulepreload";
    link.href = href;
    doc.head.append(link);
  }
  return true;
}

// ---- fetching ahead of a click ---------------------------------------------------

// Starts loading a view's module when the pointer reaches (or keyboard focus
// lands on) one of the controls that open it, so the first click opens it at
// once. `extra`: more [selector, loader] pairs. Returns a function that stops.
export function warmOnIntent(root = globalThis.document, extra = []) {
  if (!root?.addEventListener) return () => {};
  const left = new Map([
    ['[data-cmd="file.export"]', loadExportDialog],
    ['[data-cmd="view.feed-preview"]', loadFeedPreview],
    [".tool-card", loadQuickTools],
    ...extra,
  ]);
  const onIntent = (e) => {
    const t = e.target;
    if (typeof t?.closest !== "function") return;
    for (const [sel, load] of left) {
      if (!t.closest(sel)) continue;
      left.delete(sel);
      load().then(
        () => left.size || stop(),
        () => left.set(sel, load),
      );
    }
  };
  const opts = { passive: true, capture: true };
  root.addEventListener("pointerover", onIntent, opts);
  root.addEventListener("focusin", onIntent, opts);
  function stop() {
    root.removeEventListener("pointerover", onIntent, opts);
    root.removeEventListener("focusin", onIntent, opts);
  }
  return stop;
}
