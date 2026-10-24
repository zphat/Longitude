# Longitude build spec (v0.1)

This is the contract every module is built against. If you own a file, you
implement exactly the exports listed for it. If you use someone else's file,
you use only the exports listed here. If something here is wrong or missing,
do the smallest sane thing and write it down in your final report.

Longitude is a lightweight, open-source, local-first image editor for YouTube
and Spotify thumbnails and covers. It is the sibling of Latitude (screen
recorder) and Sundial (planner) and shares their look: graphite surfaces, one
acid-lime accent (#D1FF4A), sun-gold (#FFC56B) as the only second signal
color. No accounts, no fees, no stock library, no telemetry. Everything runs
in the browser on the user's machine; images never leave it.

## 1. What the user must be able to do (acceptance list)

1. Start: home screen with size presets (YouTube thumbnail 1280x720 first),
   recent projects, a big drop zone, and quick tools (Compress, Remove
   background, Resize/convert). Dropping an image on home starts a design.
2. Bring in their own media: drag-drop files anywhere, paste (Ctrl+V) images
   from the clipboard, or the Image button / `I`. PNG, JPEG, WebP, GIF (first
   frame), AVIF, BMP, SVG.
3. Layer, move, resize, rotate, flip, reorder, duplicate, delete, lock, hide,
   rename. Multi-select (Shift-click, marquee). Align and distribute.
4. Snap guides that make "is it centered?" obvious: magnetic snapping to the
   canvas center lines, canvas edges and other layers' edges/centers, with
   bright full-length guide lines and a "Center" label when centered.
5. Text: inline editing on canvas, font picker with live previews, size,
   color (solid or gradient), stroke + stroke color, second outline, shadow,
   glow, background pill, letter spacing, line height, alignment, uppercase.
6. Draw: freehand pen, highlight circle, arrow (straight or bent),
   rectangle/shapes. Holding still at the end of a pen stroke turns a rough
   circle/arrow/line/box into a clean shape.
7. Images: remove background (local ML model, downloaded once on demand),
   refine the cutout with an erase/restore brush, magic eraser for flat
   backgrounds, crop, corner radius or ellipse frame, adjustments
   (brightness, contrast, saturation, warmth, hue, blur), sticker outline,
   shadow, glow.
8. Export: PNG / JPEG / WebP, scale, quality, "fit under N MB" (YouTube's 2 MB
   limit preset), 256-color lossy PNG, live file size, copy to clipboard.
9. Preview in feed: see the thumbnail at real size in a mock YouTube grid,
   sidebar and phone (dark + light), or a Spotify list.
10. Autosave to the browser (IndexedDB). Save/open portable `.longitude`
    files. Undo/redo for everything.
11. Command palette (Ctrl+K or /) for every action. Shortcuts shown in
    tooltips and the palette.
12. Moddable: themes and presets as JSON packs; code mods from `web/mods/`
    (trusted local source) through a small, versioned API.

## 2. Tech rules (all agents)

- Plain ES modules, no build step, no npm, no frameworks. Runs from a static
  server (`serve.py`). Chromium (Edge/Chrome) is the primary target; Firefox
  must work except where an API is missing (EyeDropper, ClipboardItem write
  of some types). Safari is best effort.
- One external runtime dependency, loaded lazily only for background removal:
  `onnxruntime-web` (pinned version, jsDelivr) unless `web/vendor/ort/` exists.
- Start light: boot loads only what the first screen needs. The export
  dialog, feed preview, quick tools, encoders (compress, png8, zip), Settings,
  the mask helpers and the background removal engine load with `import()` on
  first use (`ui/ondemand.js`, `mods/loader.js`, `features/bgremove/index.js`);
  their commands are registered at start and simply wait for the module.
  `css/export.css` and `css/mods.css` load with their dialogs (`loadStyle()`
  in `ui/dom.js`, awaited before the dialog shows). `sw.js` PRECACHE lists
  every file the app can load (boot and on demand, stylesheets, interface
  fonts), so a VERSION bump never leaves the new cache unable to start
  offline. Once a page hears of an update it pins the modules it has not
  loaded yet (`pinOnDemand()`: `<link rel="modulepreload">` from the files it
  started with), so it never links newer files against older ones.
  `tests/shell-boot.test.js` checks all of this.
- Style: 2-space indent, double quotes, semicolons, `const` by default, small
  functions, comments only where intent is not obvious. No TypeScript.
- Never put user strings in `innerHTML`. Use `h()` from `js/ui/dom.js`.
- UI copy: sentence case, short, plain. No exclamation marks, no emoji, no
  "AI magic" talk. Say what happens: "Remove background", "Saved".
- Every user-visible action is a command (section 7) so it appears in the
  palette and can have a shortcut.
- Undo: every document change goes through the store (section 4).
- Rendering must work while `document.hidden` (the desktop app's browser pane
  reports hidden). Use `requestRender()` from the editor; it falls back to
  `setTimeout` when rAF stalls. Do not rely on CSS animations finishing for
  logic.
- Files you do not own: do not edit them. If you need a change there, put it
  in your report.

## 3. File map and owners

```
web/index.html                 shell
web/manifest.webmanifest       shell
web/sw.js                      shell (cache app shell, precache every file the app loads; never cache /mods/ code aggressively)
web/css/tokens.css             PROVIDED (themes, base elements)
web/css/controls.css           PROVIDED
web/css/app.css                shell (layout: top bar, rail, stage, panels, home, palette, menus, toasts, dialogs, tooltips)
web/css/editor.css             editor (text edit overlay, cursors, stage overlays)
web/css/inspector.css          inspector (inspector, layers, color picker, font picker)
web/css/export.css             export (export dialog, quick tools, feed preview; loaded with them)
web/css/mods.css               mods (settings dialog; loaded with it)
web/js/ui/dom.js               PROVIDED
web/js/ui/controls.js          PROVIDED
web/js/ui/theme.js             PROVIDED
web/js/app/context.js          PROVIDED
web/js/ui/icons.js             shell (PROVIDED stub; shell fills the full set, keeps the API)
web/js/main.js                 shell (boot)
web/js/ui/shell.js             shell (top bar, rail, status bar, panel layout)
web/js/ui/home.js              shell
web/js/ui/palette.js           shell
web/js/ui/menus.js             shell (context menu, popover, dialog, confirm, toast, tooltip)
web/js/ui/keyboard.js          shell
web/js/ui/commands-core.js     shell (registers app-level commands: file, edit, arrange, view)
web/js/core/model.js           core
web/js/core/store.js           core
web/js/core/assets.js          core
web/js/core/geometry.js        core
web/js/core/textlayout.js      core
web/js/core/render.js          core
web/js/core/effects.js         core
web/js/core/shapes.js          core
web/js/core/filters.js         core
web/js/core/project.js         core (.longitude file read/write, autosave helpers)
web/js/core/fonts.js           fonts
web/fonts/**                   fonts
tools/fonts/**                 fonts
web/js/features/bgremove/**    bgremove
web/js/features/compress.js    compress
web/js/features/zip.js         compress
web/js/features/png8.js        compress
web/js/features/presets.js     compress
web/presets/presets.json       compress
web/js/editor/**               editor (viewport, stage, selection, transform, snapping, crop, import, clipboard, context menu, select + hand tools)
web/js/editor/tools/draw.js    draw   (registerDrawTools)
web/js/editor/tools/{text,shape,arrow,pen,refine,magic}.js   draw
web/js/editor/textedit.js      draw   (createTextEditor)
web/js/editor/recognize.js     draw   (smart shapes)
web/css/draw.css               draw
web/js/ui/inspector.js         inspector
web/js/ui/layers.js            inspector
web/js/ui/colorpicker.js       inspector
web/js/ui/fontpicker.js        inspector
web/js/ui/quickbar.js          inspector (floating context bar above the selection)
web/js/ui/exportdialog.js      export
web/js/ui/quicktools.js        export
web/js/ui/feedpreview.js       export
web/js/ui/ondemand.js          export (export commands at start; loads the three views above on first use)
web/js/mods/**                 mods
web/mods/**                    mods
web/js/ui/settings.js          mods
docs/MODDING.md                mods
tests/**                       whoever owns the module under test (name tests after the module)
```

## 4. Document model (core/model.js)

Units are document pixels. `x, y` is the CENTER of the layer box. `w, h` is the
unrotated box size. `rotation` is degrees clockwise, normalized to (-180, 180].
Layers are drawn bottom (index 0) to top.

```js
Doc = {
  v: 1,
  id: "doc_…",
  name: "Untitled thumbnail",
  width: 1280, height: 720,
  preset: "yt-thumb" | null,
  background: { kind: "color", color: "#0b0c0b" }
            | { kind: "gradient", from: "#…", to: "#…", angle: 135 }   // CSS angle semantics
            | { kind: "transparent" },
  layers: Layer[],
  meta: { created: ms, updated: ms }
}

LayerBase = {
  id: "lyr_…", type, name,
  x, y, w, h, rotation: 0,
  flipX: false, flipY: false,
  opacity: 1,                 // 0..1
  blend: "normal",            // normal multiply screen overlay darken lighten color-dodge color-burn hard-light soft-light difference exclusion hue saturation color luminosity
  hidden: false, locked: false,
  shadow: { on: false, color: "#000000", opacity: 0.6, blur: 24, dx: 0, dy: 10 },
  glow:   { on: false, color: "#d1ff4a", opacity: 0.9, size: 28 },
}

ImageLayer = LayerBase & {
  type: "image",
  asset: "ast_…", natW, natH,           // natural pixel size of the asset
  crop: { x: 0, y: 0, w: 1, h: 1 },      // normalized region of the natural image shown in the box
  mask: null | "ast_…",                  // alpha mask, same natural size; opaque = keep
  frame: "rect" | "ellipse", radius: 0,  // corner radius in doc px (rect frame)
  adjust: { brightness: 0, contrast: 0, saturation: 0, warmth: 0, hue: 0, blur: 0 },
                                         // -100..100; hue -180..180; blur 0..100 (doc px * 0.2)
  outline: { on: false, color: "#ffffff", width: 14 },   // follows the alpha (sticker outline)
  filters: [],                           // [{ id, params }] from the filters registry (mods)
}

TextLayer = LayerBase & {
  type: "text",
  text: "Your text",
  font: "Anton", weight: 400, italic: false,
  size: 140,                             // doc px
  color: "#ffffff",
  gradient: { on: false, from: "#ffe14d", to: "#ff7a1a", angle: 180 },
  align: "center",                       // left | center | right
  lineHeight: 1.05,                      // multiple of size
  letterSpacing: 0,                      // thousandths of an em, -200..800
  uppercase: false,
  stroke:  { on: true,  color: "#000000", width: 10 },   // outside the glyphs (drawn under the fill)
  stroke2: { on: false, color: "#d1ff4a", width: 10 },   // second outline, outside stroke
  bg: { on: false, color: "#000000", opacity: 1, padX: 28, padY: 14, radius: 18 },
  wrap: "auto" | "fixed",                // auto: w hugs content; fixed: wraps at w
}
// Text w/h are derived by layout. The store keeps them in sync (section 4.2).

ShapeLayer = LayerBase & {
  type: "shape",
  shape: "rect" | "ellipse" | "triangle" | "star" | "burst" | "bubble" | <registry id>,
  fill: { on: true, color: "#d1ff4a" },
  stroke: { on: false, color: "#ffffff", width: 8, dash: false },
  radius: 0,                             // rect corner radius, doc px
  params: {},                            // shape specific (star: { points: 5, inner: 0.45 })
}

PathLayer = LayerBase & {                // freehand pen
  type: "path",
  points: [[u, v, p], …],                // normalized to the box (0..1); p = pressure 0..1
  color: "#ff2d2d", width: 10,           // width in doc px (does not scale with the box)
  smoothing: 0.5,
}

ArrowLayer = LayerBase & {
  type: "arrow",
  a: [u, v], b: [u, v], c: null | [u, v],   // tail, tip, optional quadratic control; normalized to the box
  color: "#ff2d2d", width: 14,
  head: "triangle" | "line" | "none",
  tail: "none" | "triangle" | "line" | "dot",
  headSize: 3.2,                            // multiple of width
  sketch: false,                            // hand-drawn double stroke
}
// Arrow and path boxes are the bbox of their points expanded by max(width*1.5, 8)
// on every side so the box is never zero-sized. Use geometry.refitPoints().
```

### 4.1 model.js exports

```js
uid(prefix) -> "prefix_" + 12 random base36 chars
createDoc({ width, height, name, preset, background }) -> Doc
createLayer(type, props) -> Layer       // full defaults merged with props, new id, default name ("Text", "Image", "Circle", "Arrow", "Drawing", "Shape")
cloneLayer(layer) -> Layer              // deep copy with a new id, name unchanged
normalizeDoc(raw) -> Doc                // validate + clamp + fill defaults; unknown fields dropped; throws Error("…") with a plain message if unusable
normalizeLayer(raw) -> Layer | null
DEFAULTS                                // { base, image, text, shape, path, arrow }
BLEND_MODES                             // array of { id, label }
LAYER_TYPES                             // ["image","text","shape","path","arrow"]
```

### 4.2 store.js

```js
class Store extends EventTarget {
  constructor(doc?)
  doc                                    // current Doc (treat as read-only outside the store)
  selection                              // string[] of layer ids, in selection order
  get(id) -> Layer | undefined
  index(id) -> number
  layers() -> Layer[]                    // bottom -> top (same array as doc.layers; do not mutate)
  selected() -> Layer[]                  // in z order

  setDoc(doc, { history = "reset" | "push" })   // replace the whole document
  update(mutator, { label, coalesce, transient })  // mutator(doc) mutates a working copy in place
  patch(ids, propsOrFn, opts)            // shallow merge per layer; nested objects (stroke, shadow, crop, adjust, …) are merged one level deep; propsOrFn(layer) may return props
  setDocProps(props, opts)               // name, width, height, preset, background
  add(layers, { index, select = true, label })  -> ids
  remove(ids, { label })
  move(id, toIndex)  forward(ids)  backward(ids)  toFront(ids)  toBack(ids)
  duplicate(ids, { offset = 24 }) -> newIds
  select(ids, { additive = false, toggle = false })  clearSelection()  selectAll()

  begin(label)   // start a gesture: snapshot now; following transient changes are not recorded
  commit()       // end the gesture: one history entry (if anything changed)
  cancel()       // restore the snapshot taken by begin()
  inGesture      // bool

  undo()  redo()  canUndo  canRedo  historyLabels() -> { undo: label|null, redo: label|null }

  addNormalizer(fn)   // fn(layer, doc) -> props|undefined, run on every changed layer before 'change'
  remeasure(ids?)     // re-run normalizers (e.g. after a font loads)
}
```

Events (`CustomEvent`, `detail` shown):
- `change` `{ reason: "patch"|"add"|"remove"|"order"|"doc"|"docprops"|"undo"|"redo"|"setdoc", ids: string[]|null, transient: bool }`
- `selection` `{ ids }`
- `history` `{ canUndo, canRedo }`

History keeps snapshots (doc + selection) by reference; docs and layers are
immutable, so never mutate `store.doc` or its layers in place (mods included).
Capped at 200 entries. `coalesce: "key"` merges consecutive commits with the same key
within 900 ms (sliders, nudges, typing). `transient: true` changes are not
recorded (used inside begin/commit). Locked layers can be patched by the store;
tools must refuse to move locked layers.

The text normalizer (registered by core in `render.js` or `textlayout.js` init)
re-measures text layers whenever text-affecting props change and updates `w,h`
keeping the anchor: left edge for `align:left`, right edge for `right`, center
for `center` (in the layer's rotated frame).

## 5. Core modules

### 5.1 assets.js

IndexedDB database `longitude` (version 1) with stores `assets` (key `id`),
`projects` (key `id`), `fonts` (key `family`), `kv` (key `k`).

```js
class AssetStore extends EventTarget {        // event 'ready' { id } when an image finishes decoding
  constructor({ maxSide = 4096, memoryBudget = 128e6, coordinate })   // coordinate: talk to other windows (default: in a page)
  async init()
  async addBlob(blob, { name } = {}) -> id    // id = "ast_" + first 20 hex chars of SHA-256; dedupes
  async addCanvas(canvas, { type = "image/png", quality } = {}) -> id
  async getBlob(id) -> Blob | null
  getImage(id) -> ImageBitmap | null          // sync; null if not decoded yet (starts decoding, fires 'ready')
  async loadImage(id) -> ImageBitmap
  info(id) -> { w, h, type, name } | null
  async toDataURL(id) -> string
  async fromDataURL(dataUrl, { name }) -> id
  async gc(keepIds)                           // delete assets not referenced by any saved project or keepIds; throws while another window is open
  setLive(ids)                                // asset ids the open design uses; other decoded images are evicted first
  async otherWindows() -> bool                // another Longitude window is open
  dispose()
}
class ProjectStore {
  constructor(assetStore, { sync })           // sync: watch saves from other windows (default: in a page)
  async list() -> [{ id, name, width, height, updated, thumb: Blob|null }]   // newest first
  async load(id) -> Doc | null
  async save(doc, thumbBlob)                  // upsert; throws err.code "conflict" instead of overwriting a newer copy saved by another window
  async remove(id)
  async rename(id, name)
  async lastOpened() -> id|null ; async setLastOpened(id)
  dispose()
}
```

### 5.2 geometry.js

```js
// Matrices are geometry.js's own 2D affine type with DOMMatrix-style fields a..f
// (so ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f) works) plus multiply/invert/apply.
// Do not depend on DOMMatrix: tests run in Deno, which lacks it. Points are {x, y}.
layerMatrix(layer) -> Mat                    // local (box centered at 0,0) -> doc
toLocal(layer, pt) -> pt                     // doc -> local
corners(layer) -> [pt, pt, pt, pt]           // doc space, clockwise from top-left
aabb(layer) -> { x, y, w, h, l, t, r, b, cx, cy }   // axis-aligned bounds in doc space (box, not effects)
unionBox(boxes) -> same shape
hitTest(layer, pt, { tol = 6, assets }) -> bool   // see 5.2.1
pickLayer(doc, pt, { tol, assets, includeLocked = false, includeHidden = false }) -> layer | null   // topmost
layersInRect(doc, rect) -> Layer[]           // for marquee: fully or partly inside, unlocked, visible
refitPoints(layer, docPoints, pad) -> { x, y, w, h, points }   // for path/arrow: new box + normalized points, keeps rotation
pointsToDoc(layer, normPoints) -> docPoints
rotatePoint(pt, center, deg) ; dist(a, b) ; clamp(v, a, b) ; snapAngle(deg, step)
quadPoint(a, c, b, t) ; distToQuad(pt, a, c, b) ; distToPolyline(pt, pts)
```

5.2.1 hit testing: image = inside box, and if it has a mask, the mask alpha at
that point > 24 (use a cached small alpha map); text = inside box; shape with
fill = inside the shape path; shape without fill = within stroke band + tol;
path = distance to polyline <= width/2 + tol; arrow = distance to the curve <=
width/2 + tol, or inside the head. `tol` is in doc px (callers pass screen
tolerance / zoom).

### 5.3 textlayout.js

```js
fontString(layer, size = layer.size) -> CSS font shorthand ('italic 700 140px "Anton", sans-serif')
layoutText(layer, fonts?) -> { lines: [{ text, width, x, y }], width, height, ascent, descent, lineHeightPx, pad }
   // in local coords, box centered; x per line already includes alignment; y is the baseline
measureBox(layer) -> { w, h }     // what w/h should be for this text layer (includes stroke/stroke2/bg padding)
installTextNormalizer(store)      // registers the normalizer described in 4.2
```
Use one shared OffscreenCanvas (or canvas) for measuring. Use
`ctx.letterSpacing` when supported, else per-glyph fallback.

### 5.4 shapes.js and filters.js

```js
// shapes.js
export const shapes   // registry (createRegistry from app/context.js), items:
  { id, label, icon, path(w, h, params, layer) -> Path2D (local coords, box centered at 0,0), defaults?: {fill, stroke, params} }
// built-ins: rect (honors layer.radius), ellipse, triangle, star, burst, bubble (speech bubble)

// filters.js
export const filters  // registry, items:
  { id, label, params: [{ key, label, min, max, step, default }], apply(imageData, params) -> ImageData }
// built-ins: none required; ship "grain" and "duotone" as examples.
```

### 5.5 render.js and effects.js

```js
renderDoc(ctx2d, doc, { scale = 1, assets, background = true, skip = null /*Set of ids*/, only = null, editingTextId = null, cache, overrides = null })
   // overrides: { masks: Map<layerId, CanvasImageSource> } — a live mask used instead of layer.mask (refine brush), bypasses the cache for that layer
   // draws at `scale` doc->canvas; caller sets any outer transform; respects hidden layers
renderLayer(ctx2d, layer, { scale, assets, cache, editingText = false })
async renderToCanvas(doc, { scale = 1, width, height, assets, background = true, fonts }) -> HTMLCanvasElement
   // waits for every image asset and font used; for export and thumbnails
async renderThumb(doc, { maxSide = 320, assets, fonts }) -> Blob (image/webp, falls back to png)
createRenderCache() -> cache   // per-layer composite cache keyed by layer id + a hash of render-affecting props + scale bucket
```

effects.js: helpers used by render: `withShadow`, `drawGlow`, `stickerOutline(canvas, width, color)` (stamp the
alpha silhouette around a circle of offsets, 16–48 stamps by width),
`applyAdjust(ctx, adjust)` (canvas `filter` string; warmth via a sepia/hue
mix or a color overlay when `filter` is unsupported), `applyMask(src, mask)`.
Text effects order (bottom to top): glow, shadow, bg pill, stroke2, stroke,
fill. Stroke is drawn with `lineJoin = "round"`, `lineWidth = 2*width` under
the fill so it sits outside the glyph. stroke2 uses `2*(stroke.width+stroke2.width)`.

### 5.6 project.js

```js
async exportProject(doc, assets, fonts) -> Blob   // application/json, ext .longitude
   // { format: "longitude", v: 1, doc, assets: { id: dataURL }, fonts: [{ family, dataURL, weight, style }] }
async importProject(fileOrBlob, assets, fonts) -> Doc   // validates via normalizeDoc, restores assets/custom fonts
importReport(doc) -> { images, fonts, message } | null   // what importProject could not restore for that doc (counts, first error)
importWarning(doc, name?) -> string | null               // the toast text for it ("Opened “X”, but 2 pictures could not be restored…")
```

## 6. Fonts (core/fonts.js, web/fonts/)

`web/fonts/fonts.json`:
```json
{ "v": 1, "families": [
  { "family": "Anton", "label": "Anton", "category": "classic",
    "faces": [{ "file": "anton/Anton-Regular.woff2", "weight": 400, "style": "normal" }],
    "variable": null, "fallback": "Impact, sans-serif",
    "license": "OFL-1.1", "credit": "Vernon Adams", "tags": ["impact", "condensed"], "sample": "WAIT WHAT" }
] }
```
Categories, in picker order: `original` (made for Longitude), `classic`
(thumbnail standards), `meme`, `display` (unique), `clean`, `system`, `custom`.
Variable fonts list `"variable": { "min": 100, "max": 900 }` and one face per
style.

```js
class FontRegistry extends EventTarget {        // events: 'load' { family }, 'change'
  constructor({ assets })
  async init(url = "fonts/fonts.json")
  list() -> FamilyInfo[]                         // { family, label, category, weights: number[], italic: bool, variable, source: "bundled"|"system"|"custom"|"mod", license, credit, sample, tags }
  get(family) -> FamilyInfo | null
  async load(family, weight = 400, style = "normal") -> boolean   // FontFace, lazy, deduped
  loaded(family, weight, style) -> boolean
  stack(family) -> CSS font-family list with quotes and fallbacks
  nearestWeight(family, weight) -> number
  async addCustom(file) -> family                // .ttf .otf .woff .woff2; stored in IndexedDB 'fonts'; category "custom"
  async removeCustom(family)
  register(def) -> dispose                       // mods: { family, label, category, faces: [{ url, weight, style }], … }
  usedIn(doc) -> family[]
  async ensureDoc(doc)                           // load every face the doc's text layers use
}
```
System fonts: offer "Impact" and "Arial Black" when present (detect by
measuring against a fallback) under `system` / `meme`.

## 7. App context, commands, tools (app/context.js — PROVIDED)

`createContext()` returns `ctx`, the object passed to every module and (a frozen
subset of it) to mods. Owners attach their services during boot (main.js):

```
ctx.events        EventTarget for app-wide events (see 7.3)
ctx.commands      command registry (provided)
ctx.tools         registry of editor tools
ctx.inspector     registry of inspector sections (mods can add)
ctx.prefs         persisted preferences (provided)
ctx.store         core Store                  (main.js)
ctx.assets        AssetStore                  (main.js)
ctx.projects      ProjectStore                (main.js)
ctx.fonts         FontRegistry                (main.js)
ctx.shapes        shapes registry             (main.js)
ctx.filters       filters registry            (main.js)
ctx.presets       presets service             (main.js)
ctx.bg            background removal service  (main.js)
ctx.exporter      compress module namespace once loaded, else null (main.js; loads with the first export or quick tool)
ctx.editor        editor API                  (main.js, after createEditor)
ctx.ui            { toast, menu, popover, dialog, confirm, prompt, openColorPicker, openFontPicker, openExport, openFeedPreview, openQuickTool, openSettings, openHome, closeHome }
ctx.themes        theme service (provided ui/theme.js)
ctx.version       "0.1.0"
```

### 7.1 Commands

```js
ctx.commands.register({
  id: "layer.duplicate",            // dotted, lowercase
  title: "Duplicate",
  group: "Layer",                   // palette group
  keys: ["Mod+D"],                  // optional; "Mod" = Ctrl on Windows/Linux, Cmd on macOS
  icon: "copy",                     // optional icon name
  when: (ctx) => ctx.store.selection.length > 0,   // optional enable check
  run: (ctx, args) => {…},
  hidden: false,                    // hide from the palette (still runnable)
  keywords: "clone copy"            // optional extra search words
}) -> dispose
ctx.commands.run(id, args)          // returns run()'s result; no-op + toast if disabled
ctx.commands.list() ; ctx.commands.get(id) ; ctx.commands.match(keyboardEvent) -> command|null
ctx.commands.keysLabel(id) -> "Ctrl+D"   // for tooltips
```
Key strings: modifiers `Mod`, `Ctrl`, `Alt`, `Shift` then the key (`K`, `Delete`,
`ArrowUp`, `[`, `=`, `/`, `Space`, `F2`). `normalizeEvent(e)` in context.js
builds the same string from a KeyboardEvent.

Command ids by owner (implement yours, call others' by id):
- shell (commands-core.js): `file.new`, `file.open`, `file.save-copy` (Mod+Shift+S),
  `file.home`, `edit.undo` (Mod+Z), `edit.redo` (Mod+Shift+Z, Mod+Y), `edit.copy`, `edit.cut`,
  `edit.paste` (system paste is handled by the editor's paste listener; the command
  reads the system clipboard, falling back to the internal clipboard; layers copied in
  Longitude with nothing copied anywhere since paste straight away), `edit.delete` (Delete, Backspace), `edit.select-all` (Mod+A),
  `edit.deselect` (Escape), `layer.duplicate` (Mod+D), `layer.forward` (Mod+]), `layer.backward` (Mod+[),
  `layer.front` (Mod+Shift+]), `layer.back` (Mod+Shift+[), `layer.lock` (Mod+Shift+L), `layer.hide` (Mod+Shift+H),
  `layer.flip-h` (Shift+H), `layer.flip-v` (Shift+V), `align.center` (Shift+C, both axes on canvas),
  `align.center-h`, `align.center-v`, `align.left`, `align.right`, `align.top`, `align.bottom`,
  `align.distribute-h`, `align.distribute-v` (selection vs canvas when one layer is selected),
  `view.palette` (Mod+K, /), `view.fit` (Mod+0, Shift+1), `view.actual` (Mod+1), `view.zoom-in` (Mod+=),
  `view.zoom-out` (Mod+-), `view.snapping` (toggle), `view.safe-zones` (toggle), `view.theme`, `app.settings` (Mod+,),
  `nudge.left/right/up/down` (Arrow keys, Shift = 10 px).
- editor: `tool.select` (V), `tool.hand` (H), `tool.text` (T), `tool.rect` (R), `tool.ellipse` (O),
  `tool.circle` (C — highlight circle: ellipse, no fill, red stroke), `tool.arrow` (A), `tool.pen` (P),
  `tool.refine` (E — refine cutout brush, needs a masked image), `tool.magic` (M — magic eraser on an image),
  `insert.image` (I — file picker), `insert.text` (adds "Your text" centered), `image.crop` (Enter on an image / double-click),
  `text.edit` (Enter on text / double-click).
- inspector: `image.remove-bg` (Shift+B), `image.restore`, `image.outline` (toggle), `text.stroke` (toggle),
  `text.uppercase`, `canvas.resize`.
- export: `file.export` (Mod+E), `file.copy-image` (Mod+Shift+C), `view.feed-preview` (F),
  `tools.compress`, `tools.remove-bg`, `tools.convert`.
- mods: `app.mods`.

### 7.2 Tools

```js
ctx.tools.register({
  id: "pen", label: "Pen", icon: "pen", key: "P", cursor: "crosshair",
  activate(api) {}, deactivate(api) {},
  pointerDown(e, api) {}, pointerMove(e, api) {}, pointerUp(e, api) {},
  keyDown(e, api) -> bool handled,
  drawOverlay(api) {}            // optional; called after each overlay redraw
})
// api = { ctx, editor, store, toDoc(e) -> {x,y}, toScreen(pt) -> {x,y}, zoom (getter), overlay (SVGGElement for this tool, cleared on deactivate),
//         requestRender(), setCursor(css), snapPoint(pt, { exclude }) -> {x,y} (shows guides), clearGuides(), pick(e) -> layer|null, setStatus(text|null) }
// The editor also exposes editor.setMaskOverride(layerId, canvas|null) for the refine brush.
ctx.editor.setTool(id) ; ctx.editor.tool -> id
```
After a creation tool finishes one object it returns to `select` (sticky when
the user double-clicks the tool button or holds Shift).

### 7.3 App events (ctx.events)

Emit with `ctx.emit(type, detail)`, listen with `ctx.on(type, fn) -> off`
(`fn(detail)`). Commands with modifier keys run while a text field has focus
only when they set `allowInFields: true`; plain-letter shortcuts never do.

`tool` { id } · `zoom` { zoom } · `home` { open } · `project` { id, name } ·
`saved` { at } · `theme` { id } · `textedit` { id|null } · `mode` { mode: "normal"|"crop"|"refine"|"magic" } ·
`bg-progress` { layerId, phase: "download"|"run"|"done"|"error", progress: 0..1, message } ·
`prefs` { key, value } · `mods` {} · `panel` { visible } (after the right panel's slide ends)

## 8. Editor (web/js/editor/)

```js
createEditor(ctx, { host }) -> editor
editor = {
  zoom, setZoom(z, { anchor }), zoomToFit(), zoomToActual(), zoomBy(f, anchor)
  docToScreen(pt) ; screenToDoc(pt)       // screen = client coords
  requestRender()
  setTool(id) ; tool
  startTextEdit(id) ; stopTextEdit()
  startCrop(id) ; endCrop(commit = true)
  setMode(mode)                          // "normal" | "crop" | "refine" | "magic"
  flash(ids)                             // brief lime pulse outline
  setScanning(layerId, on)               // bg-removal shimmer over the layer
  importFiles(files, { at })             // images, .longitude, fonts
  setOverlay(key, on)                    // "safe" (preset guides), "grid" (rule of thirds), "center" (crosshair)
  host, canvas, overlaySvg
}
```
- Workspace: full-window canvas behind the floating UI; artboard centered with
  a soft shadow; subtle dot grid + film grain on the workspace; checkerboard
  inside the artboard when the background is transparent.
- Interaction: wheel pans, Ctrl/Cmd+wheel and pinch zoom at the cursor, Space
  or middle-drag pans, double-click empty workspace = fit.
- Selection UI (SVG overlay, screen space): rotated box, 8 handles (corners
  + sides), rotation knob below the box, live pills ("640 × 360", "45°"),
  hover outline on the layer under the pointer. Text: corners scale the font
  size, left/right sides set a fixed wrap width, no top/bottom handles. Image:
  corners keep aspect (Shift frees), sides crop. Shapes and paths: free resize
  (Shift keeps aspect). Alt resizes from the center. Arrows: endpoint dots
  plus a bend handle at the midpoint, no box handles. Multi-select: union
  box, move + corner scale.
- Snapping (snapping.js): see section 1 item 4. Threshold 6 screen px; Ctrl
  held disables it; pref `snap` toggles it. Rotation snaps to 45° multiples
  within 3°, Shift snaps to 15°. Guides are lime with a dark 1 px halo; a
  centered layer gets full-length guides and a "Center" pill.
- Creation tools: drag to create; click without drag creates a default-sized
  object at the point. Defaults remember the last color used per tool (prefs).
  Remembered tool widths and the last text style are stored with the docScale
  of the canvas they were set on (`toolColors[tool].docScale`,
  `lastTextStyle.docScale`; missing means 1) and scale to the current canvas.
- Pen: smooth, pressure-aware strokes. Hold still ~450 ms at the end of a
  stroke to recognize ellipse/circle, line, arrow (line with a hook at the end),
  rectangle and convert to the clean layer type.
- Paste/drop: images become image layers. If the doc has no layers and the
  image aspect is within 3 % of the doc's, it fills the canvas; otherwise it
  fits inside 70 % of the canvas, centered (or at the drop point).
  `.longitude` files open as projects (confirm if the current one has layers);
  font files go to `ctx.fonts.addCustom`.
- Internal clipboard: copy writes layers as JSON (`application/x-longitude` in
  a `text/plain` envelope `{"longitude-layers":[…]}`) plus assets by id; paste
  re-adds with an offset.
- Context menu on right-click via `ctx.ui.menu(items, { x, y })`.
- Inline text editing: a transparent `contenteditable`/`textarea` overlay
  matched to the layer's transform and font; the canvas draws the text while
  editing (caret and selection from the overlay). Enter adds a line,
  Escape/click outside commits. Typing on a selected text layer starts editing.
- Refine mode (`tool.refine`): brush that paints the selected image's mask
  (erase / restore toggle with X, `[` `]` brush size, Shift for a straight
  line). One undo entry per stroke. Uses bgremove's `paintMask`.
- Magic eraser (`tool.magic`): click on a color to remove it (tolerance in
  the quick bar), uses bgremove's `magicMask`.

## 9. Shell (layout and chrome)

Floating islands over a full-bleed workspace (Figma UI3 / Arc feel):
- Top bar island (left): logo mark + "Longitude" wordmark (Syne), editable
  project name, preset chip ("YouTube thumbnail · 1280 × 720"), saved state.
- Top bar island (center): search pill "Search or run a command  Ctrl K".
  The label shortens to fit: "Search", then the icon and Ctrl K, then the
  icon alone.
- Top bar island (right): undo/redo, Preview (F), Export (lime primary).
- Left rail island: Select, Hand, Text, Image, Shapes (flyout), Circle, Arrow,
  Pen; then Refine/Magic only when relevant; bottom: Settings.
- Right island: inspector (scrolls) above a resizable layers panel (about
  38% of the panel, 160 to 260 px, until resized; double-click the splitter
  to go back to that).
- Bottom-center island: zoom −/value/+, Fit, safe zones toggle, snapping
  toggle, grid toggle.
- Home: full-screen overlay. Recent designs in one row under the heading
  (hidden when there are none), then the presets grid (cards drawn to
  scale), quick tools and the drop zone. Opens scrolled to the top. Esc
  closes when a project is open.
- Tooltips: `data-tip="Text"` plus optional `data-kbd="T"` on any element;
  one tooltip system in menus.js.
- Toasts bottom-center above the zoom island; `ctx.ui.toast(msg, { kind:
  "info"|"ok"|"warn"|"error", action: { label, run }, timeout })`.
- Dialog: `ctx.ui.dialog({ title, body: Node, actions: [{ label, kind, run }], wide, onClose }) -> { close, el }`.
- `ctx.ui.popover(anchorEl, contentNode, { placement, onClose }) -> { close, el }`.
- `ctx.ui.menu(items, { x, y })` items: `{ label, icon, kbd, run, disabled, danger }` or `"-"`.
- `ctx.ui.confirm({ title, message, ok, cancel, danger }) -> Promise<bool>`; `ctx.ui.prompt({ title, value, placeholder }) -> Promise<string|null>`.

## 10. Inspector (right island)

Contextual sections by selection; numeric fields are scrubbable (drag the
label). Section order:
- Nothing selected: Canvas (preset, width, height, background color /
  gradient / transparent, safe zones toggle).
- Text: Font (picker with live hover preview), size, weight, italic,
  align, uppercase; Color (solid / gradient; the Solid/Gradient switch sits
  in the section header); Stroke; Outline 2; Background; Spacing (letter,
  line); Effects (shadow, glow); Layer.
- Image: big "Remove background" button (progress ring while running, then
  "Refine" + "Restore original"), Magic eraser, Outline (sticker), Crop +
  Frame (rect radius / ellipse), Filters, Adjust (sliders + reset), Effects,
  Layer.
- Shape: shape picker, Fill, Stroke, Radius, Effects, Layer.
- Arrow: color, width, head, tail, sketch, straighten; Effects, Layer.
- Path: color, width; Effects, Layer.
- Multi: Align & distribute, opacity, Layer order.
- Always last: Arrange (X, Y, W, H, rotation; align to canvas buttons with `align.center` first; order buttons) and Layer (opacity, blend, lock).
Mod sections from `ctx.inspector` registry: `{ id, title, order, when(layers, ctx) -> bool, render(body, layers, ctx) -> optional cleanup }`.

Color picker popover: saturation/value square, hue + alpha sliders, hex
field, EyeDropper button (when supported), document colors, thumbnail
staples (#FFFFFF #000000 #FFE14D #FF2D2D #D1FF4A #2DE2E6 #7B61FF #FF7A1A),
recent colors (prefs `recentColors`, 10).

Font picker popover: search, category tabs (Original, Classics, Meme,
Display, Clean, System, Yours; they wrap to two rows and take the arrow
keys), each family rendered in itself, hover
previews on the selected text layer (transient patch, restored on leave),
"Add a font file" at the bottom.

Quick bar: a small floating island above the selection (below when near the
top): text → font, size, color, stroke toggle; image → Remove background,
Crop, Flip, Outline; shape → the visible paint first (outline-only shapes such
as the highlight circle get one Color swatch for the outline; filled shapes
get Fill then Stroke; otherwise Stroke then Add a fill), width; arrow/path →
color, width; every selection → Center on canvas, then Duplicate and Delete.
Hidden while dragging.

Layers panel: top → bottom list with thumbnail, name (double-click rename),
eye and lock toggles, drag to reorder, click selects (Shift range, Ctrl
toggle), hover highlights on canvas.

## 11. Background removal (web/js/features/bgremove/)

```js
// index.js
export function createBgService(ctx) -> bg
bg = {
  providers,                               // registry: { id, label, note, sizeMB, license, kind: "ml"|"local", run(source, { onProgress, signal }) -> Promise<HTMLCanvasElement /* mask, alpha = keep */>, ready() -> Promise<bool> /* cached? */ }
  defaultProvider,                         // id
  async removeLayerBackground(layerId, { provider }) // full flow on an image layer: progress events on ctx.events 'bg-progress', mask stored via ctx.assets.addCanvas, store.patch(layer, { mask }) with label "Remove background"
  async removeFromImage(blobOrBitmap, { provider, onProgress, signal, maxSide = 4096 }) -> { mask, cutout: HTMLCanvasElement, width, height }   // a Blob input is scaled to maxSide first (0 keeps it)
  restoreLayer(layerId)                    // mask -> null (undoable)
  masks                                    // mask.js once loaded (the first removal or cutout edit), else null
  loadMasks() -> Promise<module>           // mask.js, loading it if needed
}
// pixels.js: sourceSize, makeCanvas, readPixels (always loaded; mask.js re-exports them)
// mask.js (pure helpers, loaded on first use)
export function magicMask(source, { x, y, tolerance = 32, contiguous = true, feather = 1, baseMask }) -> HTMLCanvasElement
export function paintMask(maskCanvas, from, to, { radius, hardness, mode: "erase"|"restore" })  // in natural image px
export function featherMask(mask, px) ; export function growMask(mask, px) ; export function maskToCutout(source, mask) -> canvas
export function maskAlphaMap(maskCanvas, maxSide = 256) -> { w, h, data: Uint8Array }   // for hit testing
```
Model choice: permissive license only (MIT/Apache/BSD). Download on first use
with a confirm dialog that states the size and that nothing is uploaded;
cache in Cache Storage; progress events; WebGPU when available, else WASM.
The model and runtime URLs live in one config object so a fork or mod can
point them elsewhere (or to `web/vendor/`).

## 12. Export and compression

```js
// compress.js
export async function encode(canvas, { type = "image/png", quality = 0.92 }) -> Blob
export async function encodeToTarget(canvas, { type, maxBytes, minQuality = 0.35, allowDownscale = true, onStep, minWidth, minHeight }) -> { blob, quality, width, height, steps }   // never shrinks below minWidth x minHeight
export function downscaleSteps(width, height, { step, minSide, minWidth, minHeight }) -> sizes   // never below minWidth x minHeight
export function resizeCanvas(source, w, h, { fit = "stretch"|"cover"|"contain", background }) -> HTMLCanvasElement   // stepwise high-quality downscale
export const MAX_CANVAS_SIDE = 16384, MAX_CANVAS_PIXELS = 268e6, SAFE_CANVAS_PIXELS = 16777216
export function capDims(w, h, { maxSide, maxPixels }) -> { width, height, capped }
export async function readImageFile(file, { maxSide, maxPixels }) -> { canvas, naturalWidth, naturalHeight, capped }
export async function fileToCanvas(file, { maxSide, maxPixels }) -> HTMLCanvasElement   // default cap: the browser canvas limit
export async function encodePng8(canvas, { colors = 256, dither = true }) -> Blob   // from png8.js
export function formatBytes(n) -> "1.4 MB"
export function download(blob, filename)
export async function copyImage(blob) -> bool
export function extFor(type) -> "png"|"jpg"|"webp"
// zip.js
export function makeZip(files /* [{ name, blob|bytes }] */) -> Promise<Blob>   // store (no compression) + CRC32
// presets.js
export async function loadPresets(ctx, url = "presets/presets.json") -> presets service
presets = { list(), get(id), groups(), register(def) -> dispose }
```
Preset schema (`web/presets/presets.json`):
```json
{ "v": 1, "presets": [
  { "id": "yt-thumb", "group": "YouTube", "label": "YouTube thumbnail", "width": 1280, "height": 720,
    "note": "16:9. Under 2 MB, JPG or PNG.",
    "export": { "type": "image/jpeg", "quality": 0.92, "maxBytes": 2000000 },
    "guides": [
      { "kind": "badge", "x": 0.86, "y": 0.86, "w": 0.115, "h": 0.085, "label": "12:34" },
      { "kind": "bar", "x": 0, "y": 0.985, "w": 1, "h": 0.015, "label": "Watch progress" }
    ] }
] }
```
Guide kinds: `badge` (rounded dark rect with label), `safe` (dashed rect,
label), `circle` (cx, cy, r normalized to width; label), `bar` (filled strip),
`zone` (hatched area that UI covers, label). All coordinates normalized 0..1.

Export dialog: live preview, format segmented control, scale (0.5x, 1x, 2x,
custom), quality, "Fit under" toggle + MB field (defaults from the preset),
256-color PNG toggle, estimated size updates live (debounced), filename,
Download, Copy. Remembers settings per preset.

## 13. Mods

- JSON packs (no code): themes (Latitude-compatible format, see
  `ui/theme.js`), presets, color palettes, font lists pointing at files in
  `web/mods/<pack>/`. Imported through Settings, stored in IndexedDB `kv`.
- Code mods: listed in `web/mods/mods.json` as
  `{ "mods": [{ "id": "meme-classic", "entry": "meme-classic/index.js", "enabled": true }] }`.
  Each entry module exports `manifest = { id, name, version, author,
  description, apiVersion: 1 }`, `activate(api)` and optional `deactivate()`.
  `api` = frozen `{ apiVersion: 1, commands, tools, inspector, shapes, filters, presets, fonts, themes, store, assets, editor, ui: { toast, dialog, confirm, menu }, events, prefs: scoped(id) }`.
  Every `register` returns a dispose function; the loader also tracks them and
  disposes everything on deactivate. Enable/disable from Settings persists
  in prefs. Failures are isolated and shown in Settings.
- This is a lifecycle contract for trusted source, not a sandbox (same as
  Latitude). Never `eval`, never load code from a URL typed by the user.

## 14. Persistence and prefs

Autosave: debounced 700 ms after any committed change; thumbnails regenerate
at most every 4 s. It also saves the state of an open gesture (a drag in
progress) on `visibilitychange` (hidden), `pagehide`, `freeze`, `flush()`, a
design replace and after 2 s idle. The save on hide or close is a single put
that skips the queue. `autosave.markDirty()` queues a save; `autosave.pending`
and `autosave.saving` report its state.
Prefs (`ctx.prefs`, localStorage `longitude.prefs.v1`): `theme`, `snap`,
`safeZones`, `grid`, `recentColors`, `toolColors`, `exportByPreset`,
`mods`, `feedTitle`, `feedChannel`, `layersHeight`, `lastPreset`,
`storageAsked` (bool: `navigator.storage.persist()` was requested once),
`storageKept` (bool: its result).
Other localStorage keys: rescue copies `longitude.rescue.<docId>` =
`{ id, at, doc }` (written when the page hides with a change not yet in
IndexedDB, restored on the next start), and the boot watchdog flag
`longitude.booting` (set while starting; left behind by a start that never
finished, it starts safe mode).

## 15. Design language (all UI agents)

The bar: someone opens Longitude for the first time and makes a thumbnail
without reading anything. It should feel calm, fast, and a little bit from the
future. Fewer, better controls. Every pixel intentional.

- Surfaces: the design sits on a full-bleed dark workspace (`--workspace`,
  faint dot grid, film grain). All chrome floats above it in rounded
  `.island` panels (glass, 18 px radius, soft shadow) with `--gap` (10 px)
  from the window edges. The artboard is the brightest thing on screen.
- Color: graphite neutrals, ONE accent (`--accent`, acid lime) for the
  current tool, the primary action, focus, selection and snap guides.
  `--highlight` (sun-gold) only for "pay attention" moments (spacing guides,
  unsaved, model downloading). Red only for destructive actions and errors.
  Never introduce new hard-coded UI colors; use the tokens.
- Type: Manrope for UI (12-13 px, weights 500-700), Syne for the wordmark and
  big empty-state headings, Space Mono for numbers (sizes, zoom, file size).
  Micro labels: `.micro` (10 px caps, tracked).
- One primary (lime) button per view. Secondary actions are ghost or icon
  buttons with tooltips (`data-tip`, `data-kbd`).
- Motion: 120-200 ms, `--ease` for movement, `--spring` for things that pop
  in (popovers scale from 0.96, menus, the quick bar). Never animate layout
  that the user is dragging. Respect reduced motion (tokens.css does).
- Feedback is immediate and spatial: hover outlines on canvas, live size
  pills, magnetic snaps with guides, a shimmer scan over an image while its
  background is removed, a brief lime pulse on newly added layers.
- Empty states teach: an empty canvas shows a centered hint ("Drop images,
  paste with Ctrl V, or press T for text") that fades once there is a layer.
- Progressive disclosure: the inspector shows only what applies to the
  selection; effect sections (stroke, shadow, glow, outline) are collapsed
  with an on/off switch in their header.
- Keyboard first, mouse friendly: every action has a command; tooltips show
  the shortcut; the command palette is one keystroke away.
- Accessibility: visible focus rings (`:focus-visible`), `aria-label` on icon
  buttons (controls.js does this from `tip`), 4.5:1 text contrast, hit
  targets >= 28 px, no information carried by color alone.
