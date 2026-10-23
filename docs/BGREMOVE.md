# Background removal

Longitude removes backgrounds on your own computer. The first time you use it,
it downloads a model and the runtime that executes it, keeps them in the
browser's Cache Storage, and from then on works without a network. Your images
are never uploaded anywhere: the only network requests are the one-time
downloads of the model and runtime files listed below.

Code lives in `web/js/features/bgremove/`:

| File | What it does |
| --- | --- |
| `config.js` | `BG_CONFIG`: every URL, size, hash and model setting in one object |
| `index.js` | `createBgService(ctx)`, the service the app and mods use (`ctx.bg`) |
| `engine.js` | Planning, downloads, Cache Storage, onnxruntime-web, inference |
| `worker.js` | Module worker wrapper around `engine.js` |
| `runner.js` | Talks to the worker; runs on the main thread if a worker cannot start |
| `pipeline.js` | Pure pre/post-processing (tensor layout, sigmoid, bicubic resize, edge curve) |
| `mask.js` | Mask helpers for the editor (magic eraser, refine brush, feather, grow, cutout) |
| `trim.js` | Pure geometry that fits an image layer's box to its cutout (and back) |

## What runs where

1. **Main thread** (`index.js`): reads the image layer's pixels, squeezes a copy
   to the model's input size (1024 x 1024) on a canvas, and sends it to the worker.
2. **Worker** (`worker.js` + `engine.js`): downloads what is missing (with
   progress), checks size and SHA-256, stores files in Cache Storage
   `longitude-models-v1`, loads onnxruntime-web, runs the model on the GPU
   (WebGPU) or the CPU (WebAssembly), and turns the output into a mask at the
   photo's full size.
3. **Main thread** again: wraps the mask in a canvas, stores it with
   `ctx.assets.addCanvas`, and sets `layer.mask` with one undo step
   ("Remove background"). The same step fits the box to the cutout (below),
   so the selection, snapping and the Center pill follow the person instead
   of the old photo frame. The original image is never changed, so
   "Restore original" sets `mask: null` and puts the photo's box back.

If a module worker cannot start, the same engine runs on the main thread. The
editor stays usable during downloads either way; inference on the main thread
would pause the UI while it runs, which is why the worker is the normal path.

### Fitting the box to the cutout

After removal the layer's `crop` shrinks to the mask's opaque pixels (alpha
above 8) plus a margin of 2.5% of the photo's longer side, and `x, y, w, h`
change to match, so no visible pixel moves (rotation and flips included). The
margin leaves room for "Shrink or grow" and "Soften edge". The box never
reaches past the crop the layer had before removal, and layers whose look
depends on the box (ellipse frame, rounded corners, mod filters) keep their box.

The service remembers the crop from before each trim for the session. "Restore
original" puts it back while the layer still shows that trim; if the user has
re-cropped since, only the mask goes. After a reload, a crop that is exactly
what the trim makes of the whole photo is recognized and restored the same
way. Running removal again on a trimmed layer fits within the original crop,
so a better model can bring back what a weaker one cut off, and
`bg.fitToCutout(layerId)` does the same for a mask the refine brush changed.

## Providers

| Provider | Model | File | Download | License | Runs on |
| --- | --- | --- | --- | --- | --- |
| **Fast** (default) | IS-Net general use, int8 weights | [xrds/isnet-general-onnx-int8](https://huggingface.co/xrds/isnet-general-onnx-int8) `model_quantized.onnx` | 44 MB + runtime | Apache-2.0 weights ([DIS](https://github.com/xuebinqin/DIS/blob/main/LICENSE.md)), MIT conversion | WebGPU or CPU |
| **Best** | BiRefNet lite (Swin-T) | GPU with fp16: [runes/birefnet-lite-webgpu](https://huggingface.co/runes/birefnet-lite-webgpu) (123 MB) / otherwise: [CoderViking/birefnet-lite-onnx](https://huggingface.co/CoderViking/birefnet-lite-onnx) (200 MB) | 123 or 200 MB + runtime | MIT ([BiRefNet](https://github.com/ZhengPeng7/BiRefNet/blob/main/LICENSE), [weights](https://huggingface.co/ZhengPeng7/BiRefNet_lite)) | WebGPU, or CPU (fp32 file) |
| **Magic (flat backgrounds)** | None: color flood fill from the edges | none | 0 | MIT (Longitude) | CPU, instant |

The runtime is [onnxruntime-web](https://github.com/microsoft/onnxruntime)
1.27.0 (MIT) from jsDelivr: about 24 MB for the WebGPU build or 13.5 MB for the
CPU-only build, downloaded once and shared by both models.

Every model URL is pinned to a Hugging Face commit and every file has a SHA-256
in `config.js`, so what you download is exactly what was tested. All URLs were
checked to send `Access-Control-Allow-Origin` on the final (redirected)
response, which the browser needs.

### Why these models

The brief: weights and code under MIT, Apache-2.0 or BSD; an ONNX export that
onnxruntime-web can run; a small "Fast" (under about 50 MB) and a better "Best".

| Candidate | License | Verdict |
| --- | --- | --- |
| BiRefNet / BiRefNet lite ([code](https://github.com/ZhengPeng7/BiRefNet), [weights](https://huggingface.co/ZhengPeng7/BiRefNet_lite)) | MIT | **Best.** State of the art for dichotomous segmentation; hair and fine edges are clearly better than IS-Net. Full BiRefNet is 490 MB in fp16, too big; lite is the sweet spot. |
| [onnx-community/BiRefNet_lite-ONNX](https://huggingface.co/onnx-community/BiRefNet_lite-ONNX) | MIT | Not used. This stock export fails in browsers: Concat nodes with up to 1024 inputs exceed WebGPU's storage-buffer limit, and the deformable convolutions run out of wasm memory (`std::bad_alloc`). Documented on both re-export cards below and in [onnxruntime#21968](https://github.com/microsoft/onnxruntime/issues/21968). |
| [runes/birefnet-lite-webgpu](https://huggingface.co/runes/birefnet-lite-webgpu) | MIT | Used for Best on GPUs with `shader-f16`. Same weights after graph surgery for WebGPU (cascaded Concat/Split, no variadic Sum, constant-folded, fp16 with float32 I/O). Its author measured about 0.7 s per image on an RTX 4090 in Chrome with onnxruntime-web 1.27. |
| [CoderViking/birefnet-lite-onnx](https://huggingface.co/CoderViking/birefnet-lite-onnx) | MIT | Used for Best everywhere else. Static 1024 x 1024 fp32 export with deformable convolution rewritten as GridSample taps, verified by its author on both the WebGPU and wasm backends. |
| IS-Net general use ([DIS](https://github.com/xuebinqin/DIS)) | Apache-2.0 | **Fast.** The general-purpose model behind rembg's `isnet-general-use`. The int8 file stores only the convolution weights as int8 (weight-only QDQ) and computes in float32, so quality matches the 176 MB fp32 model (mean difference 0.0005 in our check) at a quarter of the size, and it runs on WebGPU as well as the CPU. |
| [onnx-community/ISNet-ONNX](https://huggingface.co/onnx-community/ISNet-ONNX) | tagged AGPL-3.0 | Not used, because of the AGPL tag on that repository. |
| [@imgly/background-removal](https://github.com/imgly/background-removal-js) | AGPL-3.0 | Not used (license). |
| [BRIA RMBG-1.4 / 2.0](https://huggingface.co/briaai/RMBG-2.0) | non-commercial | Not used (license). |
| U2-Net / u2netp ([U-2-Net](https://github.com/xuebinqin/U-2-Net)) | Apache-2.0 | Not used. u2netp is tiny (4.6 MB, [BritishWerewolf/U-2-Netp](https://huggingface.co/BritishWerewolf/U-2-Netp)) but works at 320 x 320 and gives blobby edges; IS-Net is the same authors' successor. |
| MODNet ([code](https://github.com/ZHKKKe/MODNet), [Xenova/modnet](https://huggingface.co/Xenova/modnet)) | Apache-2.0 | Not used by default. Small (6.6 to 26 MB) and good at hair, but trained for portraits only; products, logos and game art fail. A good candidate for a mod (see below). |
| [ormbg](https://huggingface.co/onnx-community/ormbg-ONNX) | Apache-2.0 | Not used. IS-Net architecture trained on synthetic people; no better than IS-Net general use on objects. |
| [BEN2](https://huggingface.co/PramaLLC/BEN2) | MIT | Not used. 219 MB in fp16 for a small gain over BiRefNet lite. |

### The default

**Fast** is the default. On a typical laptop with WebGPU it takes a couple of
seconds, and on the CPU roughly 5 to 15 seconds depending on the cores, after a
one-time download of 58 to 69 MB (model plus runtime). Its cutouts of people and
products are clean for thumbnails. **Best** is one click away for hair and fine
detail, at the cost of a bigger download (148 MB with fp16 on the GPU, 213 to
224 MB otherwise) and more time on machines without a capable GPU. Change the default in `BG_CONFIG.defaultProvider`,
or per user with `ctx.bg.setDefaultProvider(id)` (stored in prefs as `bgProvider`).

## Runtime details

- onnxruntime-web is imported only when a removal is first requested, never at
  startup. On machines with WebGPU the `ort.webgpu.min.mjs` build is used
  (WebGPU and CPU in one runtime); otherwise the smaller `ort.wasm.min.mjs`.
  Execution providers are `["webgpu", "wasm"]` or `["wasm"]`.
- WebGPU is used when `navigator.gpu.requestAdapter()` returns a real
  (non-fallback) adapter. Best's fp16 file is used only when the adapter has
  `shader-f16`.
- Threads: when the page is cross-origin isolated (`serve.py` sends
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: credentialless`) the CPU path uses up to
  `min(6, cores / 2)` threads, else one.
- The runtime's three files (script, glue, wasm) are cached like the models and
  loaded from blob URLs with `env.wasm.wasmPaths = { mjs }` and
  `env.wasm.wasmBinary`, so a cached runtime also works offline.
- GPU failures: if WebGPU fails while creating the session or running, Fast
  and Best's fp32 file retry on the CPU automatically. Best's fp16 file cannot
  run on the CPU (it runs out of memory), so it stops with the message "This
  model could not run on your graphics card. Try again to use the processor
  instead." For the rest of the session the service then plans CPU-capable
  files; `modelInfo("best")` reports the 200 MB fp32 download, so the usual
  confirm dialog asks before fetching it.
- The model session stays loaded for quick repeat removals and is released
  after 3 idle minutes (`BG_CONFIG.idleReleaseMs`) or by `ctx.bg.release()`,
  also after a failed or cancelled run. A session that ran out of memory is
  released at once. Because a WebAssembly heap never shrinks, the runner also
  closes the idle worker after the same 3 minutes (and on `release()`), which
  hands its memory back; the next removal starts a new worker and loads the
  runtime and model from Cache Storage in a few seconds. On the main-thread
  fallback the heap is only returned by reloading the page.

### Pre- and post-processing

Both models take float32 NCHW `[1, 3, 1024, 1024]` RGB, squeezed (not
letterboxed) to 1024 x 1024, and return `[1, 1, 1024, 1024]`.

| | Input name | Normalization | Output | Activation |
| --- | --- | --- | --- | --- |
| IS-Net | `input` | `x / 255 - 0.5` (mean 0.5, std 1) | `output` (already a sigmoid; the file has 11 more side outputs, we fetch only this one) | min-max stretch, as rembg does |
| BiRefNet lite | `input_image` | ImageNet mean `[0.485, 0.456, 0.406]`, std `[0.229, 0.224, 0.225]` | `output_image` (logits) | sigmoid |

Input and output names were read from the files' graphs. Transparent pixels
are shown to the model as mid gray. The 1024 x 1024 result is resized to the
photo's natural size with a separable bicubic filter (wider kernel when
shrinking), softened with a 1-2-1 blur, and passed through a contrast curve
(`BG_CONFIG.refine`, overridable per model): values below `lo` become fully
transparent, above `hi` fully opaque, and the middle bends toward a smoothstep.
This removes the light halo that soft edges otherwise pick up from the old
background while keeping in-between values for hair. IS-Net uses a firmer curve
(`lo 0.2`) because its edges are softer.

### Verification

The engine (`runJob` with the real onnxruntime-web 1.27.0 files) was run under
Deno 2.9 on this repository's development machine (RTX 5060 Ti) and compared
with the reference Python onnxruntime output for the same image:

| Model | Backend | Time (first run, includes session start) | Agreement with reference |
| --- | --- | --- | --- |
| Fast | WebGPU | 1.7 to 2.5 s | IoU 0.999 |
| Fast | CPU, 1 thread | 12 to 14 s | IoU 0.999 |
| Best fp32 | CPU, 1 thread | 33 s | IoU 0.9996 |

The online path (download with progress, SHA-256 check, Cache Storage, blob
URL imports) and the offline path (`web/vendor/`) were both exercised. Deno's
WebGPU implementation (wgpu) rejected one fp16 shader that Chrome's compiler
handles differently, so Best on the GPU still needs a check in Chrome or Edge;
if it fails there, delete the `fp16` variant from `BG_CONFIG.models["birefnet-lite"]`
and Best will use the fp32 file on the GPU with CPU fallback.

## Offline mode

```
python tools/fetch_model.py                 runtime + Fast (about 82 MB)
python tools/fetch_model.py --models all    runtime + every model file
python tools/fetch_model.py --list          what can be fetched, and what is here
python tools/fetch_model.py --check         verify what is here
python tools/fetch_model.py --clean         delete web/vendor/
```

The tool reads the same `BG_CONFIG` block (it is strict JSON between the
`bgconfig:begin` / `bgconfig:end` markers), downloads into `web/vendor/ort/` and
`web/vendor/models/`, verifies sizes and SHA-256 hashes, and writes
`web/vendor/manifest.json`. At runtime the engine reads that manifest first and
uses any file listed there instead of the network, with no Cache Storage copy.
`web/vendor/` is git-ignored.

## Privacy

- Images are processed in the browser tab (worker) on this computer. No image,
  mask or metadata is sent anywhere.
- The only requests are plain `GET`s for the files in `BG_CONFIG`, made with
  `credentials: "omit"`, and only after the user confirms the download.
- Delete the downloaded files with `ctx.bg.clearCache()` (Settings can offer
  this; `ctx.bg.cacheUsage()` returns `{ bytes, files }`).

## Using the service (`ctx.bg`)

```js
const bg = createBgService(ctx);           // main.js does this once: ctx.bg = bg

await bg.modelInfo("fast");
// { id, label, note, kind: "ml" | "local", sizeMB, downloadMB, modelMB, runtimeMB,
//   cached, license, source, page, backend: "webgpu" | "wasm" | "local", variant, offline }

if (await bg.confirmDownload("fast")) {    // shows the one-time confirm only when needed
  await bg.removeLayerBackground(layerId, { provider: "fast", signal });
}
bg.cancel(layerId);  bg.isRunning(layerId);  bg.restoreLayer(layerId);
await bg.fitToCutout(layerId);             // "Fit box to cutout": one undo step; true if the box changed
bg.cutoutProps(layerId, maskCanvas?);      // { crop, x, y, w, h } fitting the box to a mask, or null
bg.untrimProps(layerId);                   // { crop, x, y, w, h } back to the box before the trim, or null
const { mask, cutout } = await bg.removeFromImage(file, { provider, onProgress, signal });
```

- `sizeMB`: the full first-use download (model plus runtime). `downloadMB`: what
  is still missing now (0 when `cached`). Numbers are decimal megabytes.
- Progress: `ctx.on("bg-progress", ({ layerId, provider, phase, progress, message, code, cancelled }) => …)`.
  Phases: `download` (0 to 1, "Downloading · 34 of 69 MB"), `run` ("Getting ready",
  "Starting the model", "Finding the subject", "Refining edges"), `done`, `error`.
  `removeFromImage` emits the same events with `layerId: null`.
- Errors reject with an `Error` whose `message` is ready to show and whose
  `code` is one of `cancelled`, `network`, `http`, `integrity`, `runtime`,
  `memory`, `gpu`, `model`, `not-flat`, `already-transparent`, `decode`,
  `layer`, `provider`.
- The service shows the scanning shimmer with `ctx.editor.setScanning` and a
  lime pulse with `ctx.editor.flash` when the mask lands.

## Mask helpers (`mask.js`)

Masks are canvases at the image's natural size; alpha is how much to keep, RGB
is white. All coordinates are natural image pixels.

```js
magicMask(source, { x, y, tolerance = 32, contiguous = true, feather = 1, baseMask }) -> canvas
paintMask(maskCanvas, from, to, { radius = 24, hardness = 0.6, mode: "erase" | "restore", strength = 1 }) -> dirty rect | null
endMaskStroke(maskCanvas)          // optional, call on pointerup
featherMask(mask, px) -> canvas    growMask(mask, px) -> canvas   // + grows, - shrinks
maskToCutout(source, mask) -> canvas
maskAlphaMap(maskCanvas, maxSide = 256) -> { w, h, data: Uint8Array }
createMask(width, height, value = 255) -> canvas   readAlpha(mask)   alphaToMask(alpha)
```

- `magicMask` compares colors in OKLab (a perceptual space), so tolerance
  behaves the same in darks and lights. Tolerance 0 removes just that color,
  100 almost everything. Pixels just past the tolerance are partly removed so
  edges stay smooth. The result multiplies into `baseMask`.
- `paintMask` paints a continuous soft round brush along the segment (no dabs).
  Consecutive calls where `from` is the previous `to` form one stroke and blend
  against the alpha from the start of the stroke, so soft edges do not build up
  where segments meet.
- `growMask` uses an octagon (close to a disc) and is O(pixels) at any radius;
  the image border does not erode the mask.
- The pure cores (`magicAlpha`, `edgeMagicAlpha`, `paintAlpha`, `featherAlpha`,
  `growAlpha`, `downsampleAlpha`) work on `{ width, height, data }` objects and
  are covered by `tests/bgremove-mask.test.js`.
- `readPixels(source, { cache: true })` keeps a decoded image's pixels for the
  next read (the magic eraser reads the same image on every click): two images
  at most, none over 16 megapixels, dropped after 15 idle seconds or by
  `clearReadCache()`. Other reads keep nothing.

## Adding a provider

Any object with `id`, `label` and `run(source, { onProgress, signal })` that
resolves to a mask canvas can be registered. From a mod:

```js
export function activate(api) {
  return api.bg.providers.register({
    id: "chroma-green",
    label: "Green screen",
    note: "Removes a green backdrop.",
    kind: "local",
    sizeMB: 0,
    license: "MIT",
    ready: async () => true,
    async run(source, { onProgress, signal }) {
      onProgress?.({ phase: "run", progress: 0.5, message: "Keying" });
      return api.bg.masks.magicMask(source, { x: 0, y: 0, tolerance: 40, contiguous: false });
    },
  });
}
```

(`api.bg` assumes the mods API exposes `ctx.bg`; inside the app use `ctx.bg`.
`ctx.bg.masks` is the whole of `mask.js`, which app modules can also import
directly from `js/features/bgremove/mask.js`.)

To add another ONNX model, describe it in `BG_CONFIG.models` and register a
model provider; it then gets downloads, caching, the worker, WebGPU with CPU
fallback and the edge refinement for free:

```js
ctx.bg.config.models.modnet = {
  label: "MODNet", license: "Apache-2.0", source: "https://github.com/ZHKKKe/MODNet",
  input: "input", output: "output", inputType: "float32", size: 512,
  scale: 1 / 255, mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5], activation: "clamp", dims: null,
  variants: { fp32: { file: "modnet.onnx", url: "https://huggingface.co/Xenova/modnet/resolve/<commit>/onnx/model.onnx",
    page: "https://huggingface.co/Xenova/modnet", bytes: 25888640, sha256: null, backends: ["webgpu", "wasm"] } },
};
ctx.bg.providers.register(ctx.bg.modelProvider({ id: "portrait", label: "Portrait", note: "People only.", model: "modnet" }));
```

Check the model's real input and output names and normalization first (for
example with Python `onnx.load(path).graph.input`); `engine.js` falls back to the
first input and output if a name does not match. Set `sha256: null` when you do
not have a hash, and `size` to the input size the model was trained at.

## Updating the runtime or a model

1. Change `ort.version` and `ort.base` (or a variant's `url`) in `config.js`.
2. Update `bytes` and `sha256` for every changed file
   (`curl -sL <url> | sha256sum`).
3. Run the tests:
   `deno test --allow-read tests/bgremove-mask.test.js tests/bgremove-pipeline.test.js tests/bgremove-config.test.js`.
4. Bump `cacheName` only if you want old downloads dropped; new URLs are new
   cache entries anyway.
