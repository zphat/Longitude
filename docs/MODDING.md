# Extending Longitude

Longitude has two ways in:

- **Packs** are JSON files with themes, size presets, color palettes and
  fonts. They never run code. Import them in Settings > Packs.
- **Code mods** are small JavaScript modules in `web/mods/`. They add
  commands, tools, inspector sections, shapes, filters and more through a
  versioned API. They run with full access to the app, so only use mods you
  trust.

Anything a mod cannot reach is plain, MIT-licensed source. Fork it and change
it.

Contents: [Packs](#packs) · [Code mods](#code-mods) · [The mod API](#the-mod-api) ·
[Registry items](#registry-items) · [Safety](#safety) · [Sharing a mod](#sharing-a-mod) ·
[Source map](#source-map)

---

## Packs

A pack is one `.json` file, up to 1 MB. Import it from Settings > Packs (drop
it on the drop zone or choose it). Longitude shows what the pack adds before
anything changes. Packs are stored in this browser (IndexedDB database
`longitude`, store `kv`, key `packs`) and applied again on every start.
Removing a pack removes everything it added. Your designs are never changed.

Every pack needs `"version": 1` and a `"name"`. A pack with the same name as
an installed one replaces it.

### Theme packs (Latitude format)

Longitude reads Latitude's theme packs unchanged. A Latitude pack's
`templates` are skipped; the review screen says so.

```json
{
  "version": 1,
  "name": "Neon receipt",
  "themes": [
    {
      "name": "Neon receipt",
      "note": "After-hours ink: hot pink on violet black",
      "scheme": "dark",
      "texture": "scan",
      "colors": {
        "bg": "#0b0a10", "panel": "#15121d", "panel2": "#1f1a2b", "line": "#3b3352",
        "text": "#f5effa", "muted": "#bcb2cc", "faint": "#a69cba",
        "accent": "#ff5fd2", "highlight": "#7ef3ff", "ink": "#2b0a23",
        "green": "#9bf0b4", "red": "#ff8f9c", "amber": "#ffd68c"
      }
    }
  ],
  "templates": []
}
```

The full example is `web/mods/theme-pack-example.json` (Settings > Packs >
Try the example pack).

| Field | Rule |
| --- | --- |
| `name` | Required, up to 32 characters. |
| `note` | Optional, up to 100 characters. Shown on the theme card. |
| `scheme` | `"dark"` or `"light"`. Sets form controls and scroll bars. |
| `texture` | `"grain"` (default), `"scan"` (faint scan lines) or `"none"`. |
| `colors` | All 13 keys, each a six-digit hex color. |

| Color key | Colors |
| --- | --- |
| `bg` | Window background. The workspace is derived from it. |
| `panel`, `panel2` | Floating islands, and fields and cards inside them. |
| `line` | Borders and dividers. |
| `text`, `muted`, `faint` | Main text, secondary text, labels and hints. |
| `accent` | The current tool, the primary button, focus rings, selection. One accent per theme. |
| `highlight` | "Pay attention" moments: spacing guides, unsaved state, downloads. |
| `ink` | Text on top of `accent` (the primary button label). |
| `green`, `red`, `amber` | Success, errors and destructive actions, warnings. |

Keep text readable: `text`, `muted` and `faint` need 4.5:1 contrast on `bg`,
`panel` and `panel2`, and `ink` needs 4.5:1 on `accent`. Themes color
Longitude itself, never the user's design. A pack holds up to eight themes.

### Longitude packs

A Longitude pack can also carry presets, palettes and fonts. Every section is
optional, but a pack must add something.

```json
{
  "version": 1,
  "name": "Night shift",
  "author": "Your name",
  "description": "Sizes and colors for the late uploads.",
  "themes": [],
  "presets": [
    {
      "id": "night-banner",
      "group": "YouTube",
      "label": "Channel banner",
      "width": 2560,
      "height": 1440,
      "note": "Keep text inside the middle 1546 × 423.",
      "export": { "type": "image/jpeg", "quality": 0.9, "maxBytes": 6000000 },
      "guides": [{ "kind": "safe", "x": 0.198, "y": 0.353, "w": 0.604, "h": 0.294, "label": "Safe on every device" }]
    }
  ],
  "palettes": [
    { "name": "Night shift", "colors": ["#0b0a10", "#ff5fd2", "#7ef3ff", "#ffe14d", "#ffffff"] }
  ],
  "fonts": [
    {
      "family": "Night Sans",
      "category": "display",
      "license": "OFL-1.1",
      "credit": "Your name",
      "faces": [{ "file": "night-shift/NightSans-Bold.woff2", "weight": 700, "style": "normal" }]
    }
  ]
}
```

**Presets** are validated exactly like `presets.register()` (see
[presets](#presets)). A preset whose id already exists is skipped and the
review screen says which.

**Palettes** are `{ name, colors }` with 1 to 24 colors as `#rgb`, `#rrggbb`
or `#rrggbbaa`. They appear in the color picker. Longitude keeps them in the
`palettes` preference as `{ id, name, colors, pack }`.

**Fonts** point at files inside `web/mods/`. A pack cannot download a font
from the internet: copy the font files into a folder such as
`web/mods/night-shift/` first. `file` follows the same rules as a mod entry
(relative, no `..`, no URL) and must end in `.woff2`, `.woff`, `.ttf` or
`.otf`. `category` is one of `original`, `classic`, `meme`, `display` or
`clean` (default `display`). Optional fields: `label`, `fallback`,
`license`, `credit`, `sample`, `tags`. Only ship fonts whose license allows
it.

Limits: 8 themes, 24 presets, 16 palettes of up to 24 colors, 16 fonts with
up to 8 faces each, 1 MB per file.

---

## Code mods

### Where mods live

Each mod is a folder in `web/mods/` with an entry module, listed in
`web/mods/mods.json`:

```json
{
  "mods": [
    { "id": "meme-classic", "entry": "meme-classic/index.js", "enabled": true },
    { "id": "deep-fry", "entry": "deep-fry/index.js", "enabled": false }
  ]
}
```

- `id`: 2 to 51 characters, starts with a letter, then lowercase letters,
  digits and dashes. Same rule as Latitude.
- `entry`: a relative path inside `web/mods/`, ending in `.js` or `.mjs`. No
  `..`, no leading slash, no URL, no `?` or `#`. Anything else is refused.
- `enabled`: the default. The user's choice in Settings > Mods is saved (in
  the `mods` preference) and wins over it. Change the default and press
  **Check for new mods**: a mod the user never switched starts or stops to
  match.

A browser cannot open folders, so Longitude cannot install a mod for you.
Copy the folder in, add the line, then press **Check for new mods** in
Settings > Mods (or reload the page).

### The entry module

```js
export const manifest = {
  id: "hello",              // must match mods.json
  name: "Hello",            // shown in Settings
  version: "1.0.0",
  author: "Your name",      // optional
  description: "Says hello.", // optional, one or two sentences
  homepage: "https://…",    // optional, https only
  apiVersion: 1,            // required; this Longitude speaks API 1
};

export function activate(api) {
  // register things here
}

export function deactivate(api) {
  // optional: undo anything you did outside the api
}
```

### Lifecycle

1. On start, after the editor is ready, Longitude applies stored packs, reads
   `mods.json` and imports each **enabled** entry in list order.
2. It checks the manifest, builds a fresh `api` for the mod and calls
   `activate(api)`. `activate` may be `async`. If it returns a function, that
   function runs when the mod stops.
3. Every `register()` through the api is recorded. When the mod is turned off,
   Longitude calls `deactivate(api)` (if exported), then disposes every
   recorded registration, listener, dialog and style, newest first. Disposing
   is idempotent.
4. Turned-off mods are not started. When Settings > Mods opens, Longitude
   imports them only to read their manifest, so keep module top-level code
   free of side effects: do everything in `activate`.
5. **Reload** in Settings re-imports the entry file with a fresh URL and
   restarts the mod. Files the entry imports stay cached until the page
   reloads.

A failing mod never breaks the app. If importing, the manifest check or
`activate` fails (or takes more than 10 seconds), Longitude calls
`deactivate`, disposes whatever the mod registered, shows one toast ("Mod X
could not start: …") and lists the error in Settings > Mods. Errors thrown
later by a mod's callbacks are caught, logged to the console and shown on the
mod's card as "Last error".

The 10-second limit covers only async work (an `await` that never settles).
A synchronous loop freezes the whole page, and no timeout can stop it. Safe
mode is the way out of that:

- **Safe mode** starts when the address has `?safe`
  (`http://localhost:8770/?safe`), or on its own after a start that never
  finished (the page froze or crashed while booting).
- In safe mode no mod is imported or started, and no design is reopened.
  Settings > Mods still lists every mod, so you can turn the bad one off
  there; the choice applies on the next normal start.
- The safe-mode toast has **Turn all mods off** (saves "off" for every mod in
  `mods.json`) and **Restart normally** (drops `?safe` and reloads).

A choice saved in Settings > Mods always overrides `"enabled"` in
`mods.json`. To force a mod off for everyone, remove its line from
`mods.json`.

### Hello mod in four steps

1. Create `web/mods/hello/index.js`:

   ```js
   export const manifest = { id: "hello", name: "Hello", version: "1.0.0", author: "You", description: "Adds a hello text layer.", apiVersion: 1 };

   export function activate(api) {
     api.commands.register({
       id: "hello.say",
       title: "Say hello",
       group: "Insert",
       keywords: "greeting",
       run(api) {
         const { width, height } = api.store.doc;
         const ids = api.store.add({ type: "text", text: "Hello", x: width / 2, y: height / 2 }, { label: "Add hello" });
         api.editor.flash(ids);
       },
     });
   }
   ```

2. Add `{ "id": "hello", "entry": "hello/index.js" }` to `web/mods/mods.json`.
3. Open Settings > Mods and press **Check for new mods**.
4. Press Ctrl K, type "hello" and run **Say hello**. Ctrl Z removes the layer.

The four example mods show one extension point each:

| Mod | Shows |
| --- | --- |
| `meme-classic` | A command that adds layers as one undo step, and an inspector section for text. |
| `sticker-shapes` | Shapes with `path` and `outline`, custom icons, an insert command per shape. |
| `deep-fry` | A pixel filter, a command that adds it, an inspector section with sliders kept in sync with undo. |
| `starter-layouts` | Whole compositions built in one `store.transaction`. |

---

## The mod API

`api` is frozen. Everything below is stable for API version 1. Ids you
register should start with your mod id (`hello.say`, `hello-tool`) so they
never clash.

### Identity and helpers

| Member | What it is |
| --- | --- |
| `apiVersion` | `1` |
| `appVersion` | Longitude's version, for example `"0.1.0"` |
| `id`, `manifest` | Your mod's id and a frozen copy of its checked manifest |
| `url(path)` | Absolute URL of a file next to your entry module, for images or JSON |
| `onDispose(fn) -> dispose` | Run `fn` when the mod stops. Use it for timers, DOM you added yourself, workers |

### Registries

Every `register(def)` returns a dispose function. You rarely need it: the
loader disposes everything when the mod stops.

| Member | Methods |
| --- | --- |
| `commands` | `register(def)`, `run(id, args)`, `get(id)`, `list()`, `enabled(id)`, `keysLabel(id)` |
| `tools` | `register(def)`, `get(id)`, `list()` |
| `inspector` | `register(def)`, `list()` |
| `shapes` | `register(def)`, `get(id)`, `list()`, plus `polygonPath(points, radii)`, `polygonOutline(points, radii)`, `params(layer, def?)` |
| `filters` | `register(def)`, `get(id)`, `list()`, `defaults(idOrDef)` |
| `presets` | `register(def)`, `get(id)`, `list()`, `groups()` |
| `fonts` | `register(def)`, `get(family)`, `list()`, `load(family, weight, style) -> Promise<bool>`, `stack(family)`, `on(type, fn) -> off` (`"load"`, `"change"`) |
| `themes` | `register(def)`, `list()`, `current()`, `apply(id)` |
| `bg` | `providers.register(def)`, `providers.get(id)`, `providers.list()`, `config`, `masks`, `defaultProvider`, `removeLayerBackground(layerId, opts)`, `removeFromImage(source, opts)`, `restoreLayer(layerId)` |

`bg.config` is the live background removal config (model and runtime URLs,
see `web/js/features/bgremove/config.js`). Change it before the first
removal to point at your own files. `bg.masks` holds the mask helpers
(`magicMask`, `paintMask`, `featherMask`, `growMask`, `maskToCutout`,
`maskAlphaMap`).

### Document: `api.store`

The document lives in one store with undo. Every change through it is
undoable. Layers follow the model in `docs/SPEC.md` section 4: `x, y` is the
center of the box, `w, h` its size, `rotation` in degrees.

| Read | |
| --- | --- |
| `doc` | The current document. Read-only: never change it or its layers in place (see below). |
| `selection` | Selected layer ids, in selection order |
| `get(id)`, `index(id)` | One layer, or its position (0 is the bottom) |
| `layers()`, `selected()` | All layers bottom to top, selected layers in z order |

`doc`, `get()`, `layers()` and `selected()` return the live objects, and the
undo history keeps those same objects by reference (docs and layers are
immutable). A mod that writes `layer.x = 10` or pushes into `doc.layers`
changes past undo steps too and corrupts the history. Copy what you read, and
change the design only through `patch`, `update`, `add` and the other writes.
| `inGesture`, `canUndo`, `canRedo`, `historyLabels()` | History state |
| `referencedAssets()` | Image ids the document and its history use |

| Write | |
| --- | --- |
| `add(layers, { index, select = true, label }) -> ids` | Raw objects are fine: `{ type: "text", text: "Hi" }` gets every default. |
| `patch(ids, propsOrFn, { label, coalesce })` | Shallow merge; nested objects (`stroke`, `shadow`, `adjust`…) merge one level deep. |
| `update(mutator, { label })` | `mutator(doc)` edits a working copy. |
| `remove(ids)`, `duplicate(ids)`, `move(id, index)`, `forward`, `backward`, `toFront`, `toBack` | |
| `setDocProps({ name, width, height, preset, background })` | |
| `select(ids, { additive, toggle })`, `clearSelection()`, `selectAll()` | |
| `begin(label)`, `commit()`, `cancel()` | A gesture: changes in between become one undo step. |
| `transaction(label, fn)` | `begin`, run `fn(store)`, `commit`; `cancel` if it throws. `fn` may be async. Returns what `fn` returns. |
| `undo()`, `redo()`, `remeasure(ids?)` | |
| `on(type, fn) -> off` | `"change"`, `"selection"`, `"history"`; `fn(detail)` |
| `addNormalizer(fn) -> dispose` | `fn(layer, doc, prev) -> props` runs on every changed layer. Use sparingly. |

`setDoc` and `clearHistory` are left out on purpose: they replace the
user's design or wipe their undo history.

Make one user action one undo step. Use one `add([...])` call, a `patch` with
a `label`, or a `transaction`. Keep transactions short: load fonts and images
**before** you open one, because changes the user makes while it is open fold
into it. If a command throws while one of your gestures is open, Longitude
cancels the gesture for you.

### Images: `api.assets`

`addBlob(blob, { name }) -> id`, `addCanvas(canvas, { type, quality }) -> id`,
`getBlob(id)`, `getImage(id)` (sync, `null` until decoded), `loadImage(id)`,
`info(id) -> { w, h, type, name }`, `has(id)`, `toDataURL(id)`,
`fromDataURL(url, { name })`. Images are deduplicated and stay on this
device.

### Editor: `api.editor`

`available`, `tool`, `zoom`, `canvas`, and `requestRender()`, `setTool(id)`,
`flash(ids)` (the lime pulse on new layers), `docToScreen(pt)`,
`screenToDoc(pt)`, `zoomToFit()`, `zoomToActual()`, `setZoom(z, { anchor })`,
`zoomBy(f, anchor)`, `importFiles(files, { at })`, `startTextEdit(id)`,
`stopTextEdit()`, `startCrop(id)`, `setOverlay(key, on)`. Calls do nothing
until the editor exists.

### Interface: `api.ui`

| Method | |
| --- | --- |
| `toast(message, { kind, action, timeout })` | `kind`: `"info"`, `"ok"`, `"warn"`, `"error"`; `action`: `{ label, run }` |
| `dialog({ title, body, actions, wide, onClose }) -> { close, el }` | `actions`: `[{ label, kind, run }]` |
| `confirm({ title, message, ok, cancel, danger }) -> Promise<bool>` | |
| `prompt({ title, value, placeholder }) -> Promise<string or null>` | |
| `menu(items, { x, y })` | items: `{ label, icon, kbd, run, disabled, danger }` or `"-"` |
| `popover(anchor, content, { placement, onClose }) -> { close, el }` | |

Dialogs, menus and popovers a mod opens are closed when it stops.

Build matching UI with the same helpers the app uses:

| Member | |
| --- | --- |
| `h(tag, props, ...children)`, `svg(tag, props, ...children)` | DOM builders from `web/js/ui/dom.js`. Children are text nodes, never HTML. |
| `controls` | `slider`, `number`, `toggle`, `segmented`, `select`, `button`, `iconButton`, `swatch`, `field`, `row`, `section` from `web/js/ui/controls.js`. Value controls call `onInput(v)` while dragging and `onChange(v)` once at the end. |
| `icon(name, { size })` | An icon from the app's set |
| `registerIcons({ name: "<svg body>" })` | Adds 24 × 24 stroke icons. Prefix names with your mod id. Existing names are not replaced. |
| `addStyles(css) -> dispose` | Adds a `<style>` that is removed when the mod stops. Use the theme tokens (`var(--accent)`, `var(--panel2)`, `var(--r-s)`…), never fixed colors. |

CSS classes you can use inside inspector sections: `mod-hint` (a short muted
explanation line), `mod-stack` (a column with the inspector's spacing) and
everything in `web/css/controls.css`.

### Events: `api.events`

`on(type, fn) -> off` listens to app events (`fn(detail)`); listeners are
removed when the mod stops. `emit(type, detail)` sends one; prefix your own
types with your mod id.

| Event | Detail |
| --- | --- |
| `tool` | `{ id }` |
| `zoom` | `{ zoom }` |
| `home` | `{ open }` |
| `project` | `{ id, name }` |
| `saved` | `{ at }` |
| `theme` | `{ id }` |
| `textedit` | `{ id or null }` |
| `mode` | `{ mode }`: `"normal"`, `"crop"`, `"refine"`, `"magic"` |
| `bg-progress` | `{ layerId, phase, progress, message }` |
| `prefs` | `{ key, value }` |
| `command` | `{ id }` after a command runs |
| `mods`, `packs`, `themes`, `presets` | `{}` when those lists change |

### Preferences: `api.prefs`

`get(key, fallback)`, `set(key, value)`, `remove(key)`. Values must be
JSON-safe. Keys are stored as `mod:<id>:<key>` in the browser, so mods cannot
read or overwrite each other's settings by accident.

---

## Registry items

### Commands

```js
api.commands.register({
  id: "hello.say",            // dotted, lowercase
  title: "Say hello",         // sentence case, shown in the palette
  group: "Insert",            // palette group: File, Edit, Insert, Layer, Text, Image, View, App…
  keys: ["Mod+Shift+H"],      // optional; Mod = Ctrl on Windows and Linux, Cmd on macOS
  icon: "type",               // optional
  keywords: "greeting",       // optional extra search words
  hidden: false,              // hide from the palette, still runnable
  allowInFields: false,       // run Mod/Alt shortcuts while a text field has focus
  when: (api) => api.store.selection.length > 0,  // optional
  run: (api, args) => {},     // may be async
});
```

Mod commands receive **the mod api**, not the app context. Every command
appears in the command palette (Ctrl K) and in Settings > Shortcuts if it has
keys. Pick keys that are free: check Settings > Shortcuts first.

### Tools

```js
api.tools.register({
  id: "hello-stamp", label: "Stamp", icon: "dot", key: "S", cursor: "crosshair",
  activate(t) {}, deactivate(t) {},
  pointerDown(e, t) {}, pointerMove(e, t) {}, pointerUp(e, t) {},
  keyDown(e, t) { return false; },   // true when handled
  drawOverlay(t) {},
});
```

Tool callbacks receive the editor's tool helper `t`: `{ ctx, editor, store,
toDoc(e), toScreen(pt), zoom, overlay, requestRender(), setCursor(css),
snapPoint(pt, { exclude }), clearGuides(), pick(e), setStatus(text) }`.
Prefer the `api` you got in `activate`. After a creation tool finishes one
object, switch back with `api.editor.setTool("select")`. Tools must refuse to
move locked layers.

### Inspector sections

```js
api.inspector.register({
  id: "hello", title: "Hello", order: 80,
  when: (layers, api) => layers.length > 0 && layers.every((l) => l.type === "text"),
  render(body, layers, api) {
    body.append(api.controls.button({ label: "Wave", wide: true, onClick() {} }));
    return () => {};   // optional cleanup, runs when the section goes away
  },
});
```

`when` decides if the section shows; keep it cheap. The inspector asks again
when the selection changes, not on every edit, so a section whose content
depends on the layers' values should update itself: listen with
`api.store.on("change", fn)` and return a cleanup that removes the listener
(see `web/mods/deep-fry/index.js`), or return `{ update(layers, api),
destroy() }`. If `render` throws, the section shows a short error instead of
breaking the inspector. `order` places the section: the built-in sections use
10 to 15 for the main controls, 30 to 32 for image adjustments, 50 and 51 for
effects, 80 for Arrange and 90 for Layer; the default is 60.

### Shapes

```js
api.shapes.register({
  id: "hello-ticket", label: "Ticket", icon: "hello-ticket",
  path: (w, h, params, layer) => api.shapes.polygonPath(points(w, h, params), layer.radius),
  outline: (w, h, params, layer) => api.shapes.polygonOutline(points(w, h, params), layer.radius),
  defaults: { fill: { on: true, color: "#ff2d2d" }, stroke: { on: false, color: "#ffffff", width: 8, dash: false }, params: { notch: 0.2 } },
  params: [{ key: "notch", label: "Notch", min: 0, max: 0.5, step: 0.01, default: 0.2 }],
});
```

`path` returns a `Path2D` in local coordinates with the box centered on 0,0
(`x` from `-w/2` to `w/2`). `outline` returns the same outline as points; hit
testing and the shape picker use it, so always provide it. `params` become
sliders in the inspector and their values arrive in `params`. The built-in
ids are `rect`, `ellipse`, `triangle`, `star`, `burst`, `bubble`.

### Filters

```js
api.filters.register({
  id: "hello-invert", label: "Invert",
  params: [
    { key: "amount", label: "Amount", min: 0, max: 100, step: 1, default: 100 },
    { key: "tint", label: "Tint", type: "color", default: "#ffffff" },
  ],
  apply(imageData, params) {
    // change imageData.data in place (RGBA, not premultiplied) and return it
    return imageData;
  },
});
```

An image layer lists its filters as `filters: [{ id, params }]`. The renderer
runs them in order on the cropped, masked image and caches the result, so
`apply` must be pure and deterministic: same input, same output (seed any
randomness). It runs on the main thread, so keep it linear in the pixel
count. Built-ins: `grain`, `duotone`.

### Presets

```js
api.presets.register({
  id: "hello-square", group: "Social", label: "Square post", width: 1080, height: 1080,
  note: "1:1.", keywords: "instagram",
  background: { kind: "color", color: "#000000" },       // optional
  export: { type: "image/jpeg", quality: 0.9, maxBytes: 8000000, formats: ["image/jpeg", "image/png"] },
  guides: [{ kind: "safe", x: 0.05, y: 0.05, w: 0.9, h: 0.9, label: "Safe zone" }],
});
```

Sides are 16 to 8000 px. Guide kinds: `badge`, `safe`, `bar`, `zone` (rects:
`x, y, w, h`, fractions of the canvas) and `circle` (`cx, cy, r`, r as a
fraction of the width). Each guide can carry a `label` and a `note`.

### Fonts

```js
api.fonts.register({
  family: "Hello Display", label: "Hello Display", category: "display",
  faces: [{ url: "fonts/HelloDisplay-Bold.woff2", weight: 700, style: "normal" }],
  fallback: "Impact, sans-serif", license: "OFL-1.1", credit: "You", sample: "BIG NEWS", tags: ["condensed"],
});
```

Relative `url`s resolve against your mod's folder. Faces load lazily when a
text layer uses them. Categories: `original`, `classic`, `meme`, `display`,
`clean`, `system`. Faces without a `url` describe a font that must already be
installed on the computer.

### Themes

```js
api.themes.register({ id: "hello-night", name: "Hello night", note: "…", scheme: "dark", texture: "grain", colors: { /* the 13 keys */ } });
```

Same fields as a theme in a pack. Without an `id`, Longitude makes one from
your mod id and the name. If the user picked your theme, it comes back on the
next start.

### Background removal providers

```js
api.bg.providers.register({
  id: "hello-chroma", label: "Green screen", note: "For green backdrops.", kind: "local", sizeMB: 0, license: "MIT",
  ready: async () => true,
  async run(source, { onProgress, signal }) {
    // return an HTMLCanvasElement the size of the source whose alpha is the mask (opaque = keep)
  },
});
```

`kind` is `"ml"` (downloads a model) or `"local"`. Report progress with
`onProgress(0..1)` and stop when `signal` aborts.

---

## Safety

- Code mods are a lifecycle contract for trusted, local code. **They are not a
  sandbox.** A mod runs in the page with the same access as Longitude: it can
  read and change every design, every stored image and the network.
- Longitude only loads mod code from files inside `web/mods/`, listed in
  `mods.json`. It never runs code from a URL someone types, from a pack, from
  a project file or from the clipboard, and it never uses `eval`.
- Packs are data. They are validated field by field; anything executable is
  dropped and unknown fields are ignored.
- Read a mod's code before you turn it on. Settings > Mods says this too.
- Turning a mod off removes everything it registered through the api. It
  cannot undo changes made around the api; put those in `deactivate` or
  `api.onDispose`.
- Do not send the user's images anywhere without asking them first, in plain
  words, every time.

## Sharing a mod

1. Keep everything in one folder: the entry module, any helper modules, icons,
   fonts. Use relative imports (`./shapes.js`) and `api.url()` for files.
2. Add a `README.md` with what the mod does and its `mods.json` line, and a
   `LICENSE` (MIT is what Longitude uses). Only ship fonts and images you are
   allowed to share.
3. Put the folder in a GitHub repository or a zip. To install, people copy the
   folder into their `web/mods/`, add the line to `mods.json` and press
   **Check for new mods**.
4. Set `homepage` in the manifest so people can find updates. Raise `version`
   when you change behavior. If a future Longitude changes the API, it will
   ask for a new `apiVersion` and tell the user which mods need an update.

Want it in Longitude itself? Open a pull request at
https://github.com/zphat/Longitude with the folder under `web/mods/` and a
line in `mods.json` set to `"enabled": false`.

## Source map

| File | What it does |
| --- | --- |
| `web/mods/mods.json` | The list of code mods and their defaults |
| `web/mods/<mod>/index.js` | Example mods |
| `web/mods/theme-pack-example.json` | Example Latitude-format theme pack |
| `web/js/mods/loader.js` | Reads `mods.json`, starts and stops mods, `ctx.mods` |
| `web/js/mods/api.js` | Builds the per-mod `api` and tracks registrations |
| `web/js/mods/packs.js` | Validates, stores and applies packs |
| `web/js/mods/paths.js` | The rules for paths inside `web/mods/` |
| `web/js/ui/settings.js` | Settings: General, Fonts, Mods, Packs, Shortcuts, About |
| `web/js/ui/theme.js` | Built-in themes and the theme pack format |
| `docs/SPEC.md` | The document model and every module's contract |
