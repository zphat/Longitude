# Integration notes (v0.1)

Integration pass after the ten module builds, before browser testing. Nothing
here has been seen in a real browser yet.

## Where things stand

- `deno run --allow-read tools/check.mjs`: 74 modules ok, 0 failed. No module
  touches a browser global at import time (checked with a verbose variant of
  the script), so nothing should throw while the page loads.
- `deno test --allow-read tests/`: 473 passed, 0 failed.
- Fake-DOM boot (linkedom, a recording 2D canvas, the real `web/js/main.js`
  and the real mods loaded from `web/mods/`): boot finishes in about 1.7 s with
  no "did not load" toast, Home shows 16 presets, 28 font families, all four
  example mods start.
- Command sweep in the same harness: every registered command (87 by default,
  92 with all mods on) was run in seven selection states (nothing, text,
  image, shape, arrow, path, three layers), closing whatever each one opened.
  The only console errors came from the fake image asset that the harness
  never stored. Tool keys V H T R O C A P M switch tools; Ctrl+K opens the
  palette.
- UI flows in the harness, all passing: preset card to design; rectangle,
  arrow and pen by dragging on the canvas; text tool, typing, Escape (one
  "Add text" undo step); inspector sections for text; font picker and color
  picker from the inspector; canvas context menu; export dialog estimate
  ("424 KB · Under 2 MB") and Download with its toast; feed preview; quick
  tools compressing a file; every Settings tab; palette search; dropping the
  example theme pack on the canvas; undo back to an empty design.

The harness scripts are throwaway and live outside the repo, in
`<local scratch folder>/integrator/`
(`env.mjs`, `sweep.mjs`, `flows.mjs`; run with `deno run -A`).

## Cross-checks that came out clean

- `main.js` calls into every module with the signatures their files export:
  `createUI(ctx, roots)`, `AssetStore.init`, `FontRegistry({ assets })`,
  `installTextNormalizer(store, fonts)`, `loadPresets(ctx)`,
  `createBgService(ctx)`, `createEditor(ctx, { host })`, `mountInspector(el, ctx)`,
  `mountLayers(el, ctx)`, `mountQuickbar(stage, ctx)`, `openColorPicker` /
  `openFontPicker(anchor, { ctx, ...opts })`, `openExportDialog(ctx, opts)`,
  `openFeedPreview(ctx)`, `openQuickTool(kind, ctx, opts)`,
  `openSettings(ctx, opts)`, `createPalette`, `mountShell`, `mountHome(ctx, el)`,
  `registerCoreCommands`, `registerExportCommands`, `registerModCommands`,
  `installKeyboard`, `createAutosave`, `loadMods`, `openStoredDesign`,
  `openFiles`. Boot order has no use-before-create: services that need
  `ctx.editor` read it lazily, and the shell repaints its buttons when
  commands register later.
- Editor API: every member that the shell, inspector, quick bar, export, draw
  tools and mods call on `ctx.editor` exists (`setTool`, `tool`, `toolSticky`,
  `zoom*`, `docToScreen`, `flash`, `setScanning`, `setOverlay`, `snapEnabled`,
  `setHover`, `textEditing`, `startTextEdit`, `startCrop`, `setMode`, `mode`,
  `setMaskOverride`, `importFiles`, `copy`, `cut`, `paste`, `nudge`,
  `requestRender`, `canvas`, `host`).
- `ctx.ui`: every function anyone calls exists (menus.js plus the ones
  `main.js` adds: palette, Home, color and font pickers, export, feed preview,
  quick tools, settings).
- Command ids: no id is run or referenced (`run("…")`, `data-cmd`, menus) that
  is not registered. Every id SPEC 7.1 lists is registered. Enter is shared by
  `image.crop` and `text.edit`, whose `when()` checks never overlap.
- Events: everything listened to is emitted by someone. `canvas-settings` had
  no listener (fixed below).
- Prefs keys match between writers and readers, and the defaults agree
  (`snap` true, `safeZones` true, `grid` false).
- Every stylesheet linked from `index.html` exists. Every CSS custom property
  used without a fallback is defined. The feed preview and the font picker
  both use `fp-` class names, but no stylesheet styles the other's classes.
- Every icon name used in code exists in `icons.js`, or is registered as a
  fallback by the module that uses it. No alias points at a missing icon.

## What I changed

| File | Change | Why |
| --- | --- | --- |
| `web/js/ui/keyboard.js` | Enter on a keyboard-focused button, link or tab is left to the browser (same rule as Space). | Otherwise Enter on a focused inspector button with an image selected started crop mode (or text editing) and swallowed the button press. |
| `web/js/editor/importer.js` | Drag-over and drop are ignored while a dialog, menu or one of the modal sheets (export, quick tools, Settings) is open. | The "Drop to add" overlay (z-index 9000) showed over the sheets, and a file dropped beside a sheet's drop target was added to the hidden canvas. |
| `web/js/editor/importer.js` | A dropped or picked `.json` file is sniffed: a theme or preset pack opens Settings on the Packs tab for review; a bare design JSON goes to `file.open`. | Request from mods; packs used to get "Longitude opens images, fonts and .longitude files." |
| `web/js/main.js` | `ctx.on("canvas-settings", () => shell.togglePanel(true))`. | The canvas menu's "Canvas settings" cleared the selection, but nothing showed the panel when it was hidden or collapsed on a narrow window. |
| `web/js/mods/loader.js` | `settings.shortcuts` is `hidden: true`. | Request from shell: the palette listed "Keyboard shortcuts" twice. `help.shortcuts` (Shift+/) stays. |
| `web/js/features/presets.js` | `export.minWidth`, `minHeight` and `maxSide` pass through normalization when present. | Request from export: the dialog prefers them over its built-in table. presets.json does not use them yet. |
| `web/js/features/bgremove/index.js` | `confirmDownload()` uses the same consent words as the inspector and quick tools. | Request from export: one message everywhere ("Background removal downloads a N MB model once. It runs on this computer; your image is never uploaded."). No UI calls it yet; docs/BGREMOVE.md shows it as the way to ask. |
| `tools/check.mjs` | Messages containing `SyntaxError` or `Expression expected` count as failures. | Request from mods: Deno reports a syntax error in a nested import as a TypeError, which the script only warned about. Confirmed with a deliberately broken module. |
| `docs/THIRD-PARTY-NOTICES.md` | Added the Lucide icon notice (shell's text), the on-demand background removal downloads (onnxruntime-web MIT, IS-Net Apache-2.0, BiRefNet MIT), and closed the empty "Other" section. | Shell's request; the bgremove downloads were not listed. |

Requests that were already done when I checked: autosave, text normalizer,
font `load` re-measure and asset gc in `main.js`; `project.js` exporting every
face of a custom family and importing with the family override; the service
worker leaving `longitude-models-*`, `vendor/`, `.onnx`, `.wasm` and
cross-origin requests alone; toasts (1300) and tooltips (1400) above the
sheets (900); keyboard.js staying quiet while an `[aria-modal]` sheet is open;
`view.snapping` / `view.safe-zones` writing `snap` / `safeZones`; Home's quick
tool cards calling `openQuickTool`; circle guides using `cy` as a fraction of
height; the editor passing its render cache, `editingTextId` and mask
overrides to `renderDoc` and re-rendering on assets `ready`; the mods API
exposing `bg`; overlay, pills and hint with `pointer-events: none` above the
text editor's textarea.

## Open issues (not fixed)

1. Typing a letter on a selected text layer does not start editing, which
   SPEC 8 asks for. Single letters are tool shortcuts (T, R, O, ...), so this
   needs a product decision. Enter and double-click do start editing.
2. Possibly browser-reserved shortcuts on Windows: Ctrl+Shift+C (Copy image;
   Chrome and Edge open DevTools inspect), Ctrl+Shift+S (Save a copy; Edge's
   Web capture), Ctrl+1 (tab switch in a normal tab; Shift+0 is also bound).
   Check that the page receives them; rebind if not.
3. The shell's `openFiles` (Home drop, the file.open picker, OS file
   handlers) treats any `.json` as a project, so a theme pack dropped on Home
   says "This file is not a Longitude project." Only a drop on the canvas
   routes packs to Settings.
4. Fixed in review round 1. The export dialog, feed preview, quick tools and
   Settings now go on `ctx.ui`'s layer stack (`pushLayer` / `dropLayer`, with
   `escape: false` so each keeps its own Escape handling): the app behind is
   inert and `ctx.ui.isBlocking()` is true while one is open.
5. `layer.rename` (F2) opens a prompt dialog. The layers panel has inline
   rename (`mountLayers()` returns `rename(id)`), but `main.js` does not keep
   that handle.
6. The service worker serves the app shell cache first, but it no longer
   updates the cache while a page loads. Changed files are staged as one set
   and switched in when the next page opens, so a reload runs the new code
   consistently (never a mix of old and new files); the open page offers that
   reload. `?nosw` now works from `index.html` even when the cached `main.js`
   is broken, so `http://localhost:8770/?nosw` is still the way to test
   edits. VERSION is `0.1.0-2`.
7. Done: `README.md` now exists at the repo root.

## Browser test checklist (in this order)

Start with `python serve.py --open`, or double-click `Start Longitude.cmd`, and
use `http://localhost:8770/?nosw` in Edge with DevTools open.

### P0: boot and the core loop

1. Boot: the console is clean, no "Some parts did not load" toast, the splash
   goes away, Home shows the preset cards drawn to scale, and the UI is in
   Manrope with the Syne wordmark.
2. Pick "YouTube thumbnail": the artboard is centered with its shadow on the
   dot-grid workspace, the empty hint shows, and the zoom fits.
3. Bring in media: drop a 16:9 JPG on the canvas (it fills the canvas, with a
   lime pulse), drop a portrait PNG (fits inside 70 %), paste a screenshot
   with Ctrl+V, use the Image button and I. Also drop on Home.
4. Move, resize, rotate: snap guides and the "Center" pill at the canvas
   center, Ctrl turns snapping off, Alt-drag duplicates, Shift locks an axis.
   Image corners keep the aspect, sides crop. Undo and redo show their labels
   in the top bar.
5. Text: T, click, type, Escape. Check that the textarea caret and selection
   sit exactly on the canvas glyphs (the draw report's biggest risk), that the
   box hugs the text once the font has loaded, that the font picker's hover
   preview works, and that the stroke, second outline, pill, shadow and glow
   look right. Try Anton, Bebas Neue and the four Longitude originals.
6. Export: Ctrl+E. The JPG fits under 2 MB, Download saves a file that opens,
   Copy image pastes into another app, the 256-color PNG is valid, and the
   before/after compare works.
7. Reload: the last design comes back (IndexedDB) and Home's Recent shows its
   thumbnail. Rename, duplicate and delete from Recent.

### P1: features

8. Background removal on a real photo: the consent dialog with the size, the
   download progress, the scan shimmer, then the cutout. Then Refine (E,
   erase/restore with X, `[` `]`), Magic eraser (M) on a flat background,
   Soften edge and Shrink or grow, Restore original. Try "Best" too: the fp16
   file on WebGPU was never verified (see docs/BGREMOVE.md).
9. Drawing: a freehand pen stroke, then hold still at the end of a rough
   circle, arrow and box to get clean shapes; a bent arrow from its bend
   handle; the highlight circle (C).
10. Images: crop mode (Enter or double-click), ellipse frame and corner
    radius, the adjust sliders and Reset, sticker outline on a cutout.
11. Layers panel and quick bar: thumbnails, drag to reorder, double-click
    rename, eye and lock, hover highlight on the canvas. The quick bar sits
    above the selection, below it near the top, and hides while dragging.
12. Feed preview (F): all six views, dark and light, the distance slider.
13. Quick tools from Home: Compress a batch and download the .zip; Remove
    background then Open in editor; Resize or convert.
14. Settings: themes, turn the deep-fry mod on and off, drop
    `web/mods/theme-pack-example.json` on the canvas to import it, then remove
    it.
15. Palette (Ctrl+K and /), the shortcuts sheet (Shift+/), and tooltips with
    keys on the rail and the top bar.

### P2: edges

16. The shortcuts in open issue 2.
17. Service worker: load once without `?nosw`, change a CSS file, reload, and
    check for the "Longitude was updated" toast.
18. Narrow window (under 1100 px), light themes, reduced motion, Firefox.
19. Big inputs: a 6000 px photo, a 3x export of a 3000 px cover, and a design
    with 50 or more layers.

## Review round 1

Integration after the review-and-fix round (fixers worked in parallel on
disjoint areas). Still not seen in a real browser except where the lead
already checked it.

Where things stand:

- `deno run --allow-read tools/check.mjs`: 75 modules ok, 0 failed.
- `deno test --allow-read tests/`: 580 passed, 0 failed (577 from the fixers
  plus 3 new: layout-aware key names, the slider/field key rule, and
  `loadMods(ctx, { start: false })`).
- Fake-DOM harness: `flows.mjs` 0 failed (the context menu now lists Center
  on canvas). `sweep.mjs`: 102 commands in seven selection states, the only
  console output is from the harness's fake image that is never stored, as
  before. New `round1.mjs` next to them (`deno run -A round1.mjs`, and
  `--safe` for a `?safe` boot) checks this round's behavior: 0 failed in both.

### Fixed

Shared files (confirmed review findings):

| Finding | Fix |
| --- | --- |
| [high] A focused range slider counted as typing, so after dragging any inspector slider Ctrl+Z, Ctrl+C/V/X, Delete and tool keys did nothing | `controls.js` `slider()`: a slider moved with the pointer blurs once the press ends (a window `pointerup`/`pointercancel` after its `pointerdown`); one reached with Tab keeps focus and its arrows. `dom.js`: new `isTextEntry()` (text-like inputs, textarea, contenteditable) and `fieldOwnsCombo(combo, target)`: every field keeps plain keys, only text entry keeps Ctrl/Cmd/Alt combos and F keys. `context.js` `match()` and `keyboard.js` `boundCommand()` use it, so Ctrl+Z, Ctrl+D or F2 reach the app with a slider, checkbox, select or color well focused while arrows stay with the slider. `clipboard.js` `ours()` uses `isTextEntry`, so a paste with a slider focused adds the image. The global `isTyping` change first suggested was not used (arrow keys would have nudged the layer instead of moving the slider). `isTyping` now returns a strict boolean. |
| [medium] Letter shortcuts matched physical keys (QWERTZ Ctrl+Z redid, AZERTY lost Ctrl+Z/Ctrl+A, QWERTZ "-" opened the palette) | `context.js` `keyName()`: letters come from `e.key` when it is a Latin letter, else the physical key (Cyrillic, Greek still get Ctrl+Z). Digits stay physical (Shift+1 is still fit; AZERTY Ctrl+0 works). Bound punctuation (`- = / [ ] , . ; ' \`) comes from `e.key`, `?` and `_` name Shift+/ and Shift+-, then the old `e.code` fallbacks. QWERTZ Shift+7 ("/") stays Shift+7, not the palette. Tests cover QWERTZ, AZERTY, Cyrillic, US `?`, Shift+1, brackets. |
| [low] Focus ring invisible on primary buttons and the selected segment | `tokens.css`: `.btn.primary:focus-visible` (and `:hover`) keep `var(--focus)` plus the glow. `controls.css`: `.ctl-seg .seg.on:focus-visible { box-shadow: var(--focus) }`. Targeted overrides, not a global outline. |
| [low] Slider inputs unlabeled | `slider()` sets `aria-label` from the visible label on the range and the number field, and `aria-valuetext` (with the unit, "10 px") on the range. |

Cross-area requests, by the area that asked:

- Editor: SPEC 7.1 `edit.paste` wording (it reads the system clipboard).
  `textlayout.js` wraps with a 0.01 px tolerance. `text.edit` is off while a
  drag is open. bgremove waits for an open canvas drag before patching the
  cutout (`gestureDone()`, same as importer `dragDone()`), also in
  `fitToCutout`. `keyboard.js`: while a drag is open only `edit.undo` /
  `edit.redo` run from keys (Escape stays with the tool). `importFiles` ends a
  text edit first. `cancelActivePointer` and a `pointercancel` call a tool's
  own `cancel(api)` when it has one (not the select tool, which settles).
- Draw: `shell.js` `insertShape` scales the default outline with the box
  (720 reference; a burst on a 3000 px cover gets 33.3 px). `edit.undo` /
  `edit.redo` wait for a draw tool's `pending` save (toolbar and palette).
  SPEC 8 notes the docScale stored with remembered widths and text style.
- Core: the editor clears its cache and redraws when the shapes or filters
  registry changes. Opening a `.longitude` file whose pictures or fonts could
  not be restored shows a warning toast (new `importWarning(doc)` in
  `project.js`, used by `openProjectFile` and the importer's `openFallback`).
  The two-windows toast says changes here are no longer saved and offers Save
  project file. SPEC 4.2 (history by reference, never mutate), 5.1
  (AssetStore/ProjectStore constructors, `setLive`, `otherWindows`,
  `dispose`, `gc` and `save` conflicts), 5.6 (`importReport`,
  `importWarning`), 14 (autosave of open gestures and the hide/close save).
  MODDING says `api.store.doc` and layers are read-only and why.
- Shell: `CONFLICT_MESSAGE` says "Save a project file". Remove background
  uses the `remove-bg` icon in the context menu, the export commands and the
  quick tool; `view.feed-preview` is "Preview in a feed" with `play-rect`
  (the sheet's label too). Sheets and Settings are on the layer stack (open
  issue 4). `loadMods(ctx, { start: false })` restores packs and lists mods
  without importing or starting any (`setEnabled`, `reload`, `refresh` and
  `describe` only save choices); `main.js` uses it in safe mode, and Settings
  > Mods shows a safe-mode note. MODDING documents safe mode, that the
  10-second limit covers only async work, and that a saved choice overrides
  `"enabled"`. SPEC 14 lists `storageAsked`, `storageKept`, the rescue copies
  and the boot flag. Open issue 6 updated.
- Inspector: popovers pass `onEscape` into their layer and menus.js asks it
  first (font picker clears a typed search, color picker reverts an edited
  hex, before closing). `align()` reports a no-op ("Already centered" /
  "Already aligned" in the status pill plus a pulse); `flashStatus` is on the
  public editor. A press on the canvas blurs a focused field outside it so its
  value commits first. The canvas context menu has Center on canvas. SPEC 10
  quick bar line and the Arrange line.
- Export: `bg.removeFromImage` scales a Blob input to 4096 px on the long
  side (`maxSide` option, 0 keeps it). SPEC 11 and 12 (`capDims`,
  `readImageFile`, the canvas limits, `minWidth`/`minHeight`).
- Bgfonts: "Fit box to cutout" button under Restore original (one image, not
  an ellipse frame or rounded corners). Restore original on several images
  also puts back their pre-trim boxes. Refine grows a trimmed box back when it
  picks up the layer and fits it again (after pending saves) when it leaves,
  only for a box it grew. Shrink or grow refits the box. Font loads from
  explicit actions pass `{ retry: true }` (font picker rows, inspector font
  change, inline text edit, Settings > Fonts, opening a design); the
  inspector's per-refresh load and `render.js` keep the throttled default.

### Skipped, and why

- `textlayout.js` `minW` to 1 em: changes the layout of existing narrow
  designs, and the text tool no longer makes boxes under 1.5 em.
- `store.begin()` tokens: an API change across the editor, Panel and mods for
  protection against a bug nobody has hit; optional.
- `runner.js` transfer list: performance only. It would have to tell the
  cached `readPixels` buffers from fresh ones, and a wrong transfer detaches
  the cache.
- `main.js` save chip on transient changes: a canceled drag would leave
  "Saving…" with no save to clear it. The chip already reads "Saving…" for
  `pending`.
- `main.js` "reopen the stored version" on a conflict: `openStoredDesign`
  returns early for the open id and this window holds its lock, so it needs
  its own path. The toast offers Save project file.
- A frozen `doc` for mods in dev mode: documented as read-only instead.
- inspector `FALLBACK_ICONS` `remove-bg`: harmless (`ensureIcons` skips names
  that exist); left.
- Roving tabindex for the segmented control: optional, not done.

### Behavior changes to know about

- Shortcuts follow the printed letter. On QWERTZ, Ctrl and the "+" key now
  zoom in (they used to send Bring forward, Mod+]), and "/" (Shift+7) does
  not open the palette; Ctrl+K does.
- With a slider, checkbox, select or color well focused, Ctrl/Cmd combos and
  F keys go to the app; plain keys stay with the control.
- During a canvas drag, keys other than undo, redo and Escape do nothing.
- Refine on a trimmed cutout adds an undo step when it starts (box grows) and
  one when it ends (box fits). Starting and leaving without painting leaves
  two steps that cancel out.
- In safe mode, switching a mod on in Settings is saved for the next normal
  start; nothing runs now.

### Browser checks for the lead

1. Sliders: drag Opacity, then Ctrl+Z, Delete, V and Space-pan work at once.
   Tab to a slider: the arrows move it and Ctrl+Z undoes. A paste with the
   slider focused adds the image.
2. Focus rings: Tab to a primary button (Export's Download) and to the
   selected segment of a segmented control; the ring shows, also on hover.
   The accessibility tree names sliders by their label with "10 px".
3. Layouts: Windows German (QWERTZ): Ctrl+Z undoes, Ctrl+Y redoes, "-" zooms
   out, Ctrl and "+" zoom in. French (AZERTY): Ctrl+A, Ctrl+Z. Russian:
   Ctrl+Z undoes. The labels in tooltips match the printed keys.
4. Sheets: Export, Quick tools, Feed preview, Settings. Clicks and keys do not
   reach the app behind; Escape inside a sheet closes an open menu or popover
   first, then the sheet; focus goes back to the button that opened it. Quick
   tools from Home, then "Open in editor".
5. Font picker: type a search, Escape clears it, Escape again closes. Color
   picker: edit the hex, Escape reverts, Escape again closes.
6. While dragging a layer: Delete, Ctrl+D and T do nothing; Escape cancels the
   drag; Ctrl+Z ends and undoes it.
7. Background removal that finishes while another layer is being dragged:
   the cutout is its own undo step after the Move.
8. Refine a trimmed cutout: the box grows to the photo, restore strokes bring
   back parts outside the old box, the box fits again on Done. Fit box to
   cutout. Restore original on two cutouts at once. A large Grow: the box
   follows.
9. Undo from the top bar right after a refine stroke or a magic click undoes
   that stroke, not the step before it.
10. Two windows on one design: save in one, the other shows the new toast
    with Save project file, and its next save shows the conflict message.
11. `?safe`: the toast, Settings > Mods lists every mod with the safe-mode
    note; turn one off, Restart normally, it stays off.
12. Open a `.longitude` file with a broken image entry: the warning toast.
13. Insert a burst on the Spotify podcast cover (3000 x 3000): about 33 px of
    outline. Center on canvas twice: "Already centered" and a pulse. The canvas
    context menu has Center on canvas.
14. A Settings > Fonts or font picker visit retries fonts that failed earlier
    (go offline, open the picker, come back online, open it again).

## Polish pass

Spelling: every string is American English (color, center, gray, license,
behavior, canceled); `tests/core-spelling.test.js` and
`tests/export-spelling.test.js` guard it.

### User-visible improvements

- Lighter start: Export, the feed preview, quick tools, Settings, the
  encoders (PNG-8, zip) and background removal load on first use, with their
  stylesheets. Pointing at a button that opens one starts the fetch. Selecting
  an image no longer loads the removal engine or asks for the graphics card:
  the model size fills in when the pointer or focus reaches Remove background
  or the Model line. Export no longer pulls in the feed preview.
- Offline and updates: `sw.js` precaches every file the app can load, so an
  offline start after an update works (VERSION `0.1.0-3`). The offline copies
  of mods and presets carry over to the new cache. A tab that hears of an
  update pins the modules it has not loaded yet, so it never mixes versions.
- Inspector: every control in a section row is 32 px, segmented switches
  included, and a stretched switch centers its buttons. The Solid/Gradient
  switch sits in the Color header and is 28 px. Rarely used Adjust sliders
  start folded. The sticker Outline comes right after Background on images.
- Segmented controls are radio groups: one tab stop, arrows, Home and End.
  After a mouse click the arrows still nudge the layer.
- Focus traps in sheets and dialogs skip unselected segmented buttons, so
  Shift+Tab stays inside Quick tools.
- Home: recent designs in one row under the heading, with one menu per card
  (Rename, Duplicate, Delete). On a narrow card the time ellipsizes and the
  size always shows in full. The open design reads "Editing now", in muted
  text after an accent dot. The storage note's text is in text color, with a
  sun-gold icon.
- Contrast: placeholders use `--muted` (4.6:1 or better in every theme). The
  mixed slider track and the export size meter use `--line`, so you can see
  them.
- Copy: the Convert drop zone reads "Every image gets the size and format you
  set. You can also paste with Ctrl V." Every "no match" empty state uses
  curly quotes.
- Canvas: overlay outlines, guides and handles snap to whole device pixels,
  so they stay sharp while a box moves. Hover outlines no longer repaint the
  design. The view glides along when the panel shows or hides.
- Text: font readiness is tracked per face, not per size, so a resize drag
  no longer runs a font check every frame. Font picker samples that load no
  longer drop the text layouts.

### Browser checks for the lead

1. Inspector, text layer: click Align right, then press ArrowRight. The layer
   moves 1 px and the alignment stays. Tab to the align switch: the arrows
   change the alignment. Check the Size, align and toggle row, and the image
   Crop and Frame row, for one height with no offset pill.
2. Quick tools opened on Remove background: Shift+Tab from the selected tab
   wraps inside the sheet. Do the same with Export and Settings.
3. Select a photo with the Network panel open: no `vendor/` request, and
   `bgremove/engine.js` loads only on hover of Remove background.
4. Updates with two tabs: edit a file in `web/`, reload tab B, then in tab A
   (toast ignored) open Export, Settings and a quick tool for the first time.
   Each opens. DevTools should show `modulepreload` links in tab A's head.
5. Offline after a bump: with the new worker waiting, close every tab, stop
   `serve.py`, then open Longitude. It starts, and Settings, Export and the
   mods work.
6. Home at window widths of about 860 px and 1150 px: recent subtitles end in
   an ellipsis on the time, never on the size. Check "Editing now" and the
   storage note in Chalk and Linen.
7. Placeholders (font search, Settings search, feed preview Title and
   Channel), the mixed slider (two layers with different opacity) and the
   export size meter, in Chalk and Linen.
8. Separate decision, not changed: Chalk's accent `#5e8200` is 4.18:1 as text
   on panels. About `#567600` would pass, but it changes the shared Sundial
   Chalk look.
