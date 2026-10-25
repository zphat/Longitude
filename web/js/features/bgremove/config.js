// Background removal configuration: every URL, model and runtime setting in
// one object so a fork or a mod can point Longitude somewhere else.
//
// The block between the bgconfig markers must stay strict JSON (double
// quotes, no comments, no trailing commas): tools/fetch_model.py reads it to
// vendor the same files into web/vendor/ for offline use.
//
// Mods can change it at runtime before the first removal, for example:
//   api.bg.config.models["birefnet-lite"].variants.fp32.url = "https://…/model.onnx";
// A variant's sha256 is checked after download; set it to null when you point
// a variant at a different file.
//
// Sources and licenses: docs/BGREMOVE.md.

export const BG_CONFIG = /* bgconfig:begin */ {
  "cacheName": "longitude-models-v1",
  "vendorDir": "vendor/",
  "defaultProvider": "fast",
  "threads": { "max": 6 },
  "idleReleaseMs": 180000,
  "ort": {
    "version": "1.27.0",
    "base": "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/",
    "license": "MIT",
    "source": "https://github.com/microsoft/onnxruntime",
    "builds": {
      "webgpu": {
        "script": { "file": "ort.webgpu.min.mjs", "bytes": 67169, "sha256": "46988a5a025f49449850f39f95eb0d21e40e67b3beb13a0b54efd3ab5d83f60e" },
        "glue": { "file": "ort-wasm-simd-threaded.asyncify.mjs", "bytes": 47507, "sha256": "7236653b8565da4046e459cd0e274123419a1d9f1f8f18fd36c28058346ca655" },
        "wasm": { "file": "ort-wasm-simd-threaded.asyncify.wasm", "bytes": 24254953, "sha256": "7e83cd6cee77e478bc96a7e91b198144fb5e4126287daf1f9b54bb195ebcd55a" }
      },
      "wasm": {
        "script": { "file": "ort.wasm.min.mjs", "bytes": 50069, "sha256": "9608e98a3fba9716f0cbd0bca0c94808b71dae2e9265ca3fe742ddc393a53ebc" },
        "glue": { "file": "ort-wasm-simd-threaded.mjs", "bytes": 24180, "sha256": "0a1e718d99c41b22c21f2520ff4f9e883a6b5533856e398d21816ee8eb8185d3" },
        "wasm": { "file": "ort-wasm-simd-threaded.wasm", "bytes": 13479978, "sha256": "d1ab1b94b16a65b29d710d0b587b29e7bed336827577623913479b8afe8113e6" }
      }
    }
  },
  "models": {
    "isnet-general": {
      "label": "IS-Net general use",
      "license": "Apache-2.0",
      "source": "https://github.com/xuebinqin/DIS",
      "input": "input",
      "output": "output",
      "inputType": "float32",
      "size": 1024,
      "scale": 0.00392156862745098,
      "mean": [0.5, 0.5, 0.5],
      "std": [1, 1, 1],
      "activation": "minmax",
      "dims": { "batch_size": 1, "height": 1024, "width": 1024 },
      "refine": { "lo": 0.2, "hi": 0.98, "curve": 0.6 },
      "variants": {
        "int8": {
          "file": "isnet-general-int8.onnx",
          "url": "https://huggingface.co/xrds/isnet-general-onnx-int8/resolve/71eff2372ec9c8edbc6ca637ded591423d23b65a/onnx/model_quantized.onnx",
          "page": "https://huggingface.co/xrds/isnet-general-onnx-int8",
          "license": "MIT (ONNX conversion), Apache-2.0 (weights)",
          "bytes": 44229662,
          "sha256": "3b21a6706dc8d6e4ba9f5b31ebc6940f6c785b58862e27bb25daa9dd4424b87f",
          "backends": ["webgpu", "wasm"]
        }
      }
    },
    "birefnet-lite": {
      "label": "BiRefNet lite",
      "license": "MIT",
      "source": "https://github.com/ZhengPeng7/BiRefNet",
      "input": "input_image",
      "output": "output_image",
      "inputType": "float32",
      "size": 1024,
      "scale": 0.00392156862745098,
      "mean": [0.485, 0.456, 0.406],
      "std": [0.229, 0.224, 0.225],
      "activation": "sigmoid",
      "dims": null,
      "variants": {
        "fp16": {
          "file": "birefnet-lite-webgpu-fp16.onnx",
          "url": "https://huggingface.co/runes/birefnet-lite-webgpu/resolve/d553b221039609f1ab170e3c2e651b59f363c98a/birefnet_lite_webgpu_fp16.onnx",
          "page": "https://huggingface.co/runes/birefnet-lite-webgpu",
          "license": "MIT",
          "bytes": 123224205,
          "sha256": "348c075771a9f6631d6ac991a1ac613d33910390cf943afa752f3a73c36fca03",
          "backends": ["webgpu"],
          "needs": "shader-f16"
        },
        "fp32": {
          "file": "birefnet-lite-fp32.onnx",
          "url": "https://huggingface.co/CoderViking/birefnet-lite-onnx/resolve/dc06453148f01ef4131f17e9b791345e32e8ee78/birefnet-lite-1024.onnx",
          "page": "https://huggingface.co/CoderViking/birefnet-lite-onnx",
          "license": "MIT",
          "bytes": 199681624,
          "sha256": "50a57872cc739192446da2a934159f957c81af8b5a161dfda8e3daa51660ca67",
          "backends": ["webgpu", "wasm"]
        }
      }
    }
  },
  "providers": {
    "fast": {
      "label": "Fast",
      "note": "Quick and good for most photos.",
      "model": "isnet-general"
    },
    "best": {
      "label": "Best",
      "note": "Finer hair and edges. Slower, larger download.",
      "model": "birefnet-lite"
    }
  },
  "refine": { "blur": true, "lo": 0.1, "hi": 0.97, "curve": 0.5 }
} /* bgconfig:end */;

// web/ root, so "vendor/" resolves to web/vendor/ wherever this module is loaded from.
export const WEB_ROOT = new URL("../../../", import.meta.url).href;

// The desktop app (docs/DESKTOP.md) installs the runtime and the Fast model
// next to the program and serves them on their own origin, the "vendor"
// protocol: http://vendor.localhost/ on Windows (https when the app runs on
// https://tauri.localhost), vendor://localhost/ elsewhere. Read from the
// location, so it works in the page and in the background-removal worker.
// Null in a browser.
export function desktopVendorBase(loc = globalThis.location) {
  if (!loc) return null;
  if (loc.hostname === "tauri.localhost") return `${loc.protocol}//vendor.localhost/`;
  if (loc.protocol === "tauri:") return "vendor://localhost/";
  return null;
}

// A mod that points vendorDir somewhere else keeps its folder in the desktop app too.
export function vendorUrl(path = "", loc = globalThis.location) {
  const desktop = BG_CONFIG.vendorDir === "vendor/" ? desktopVendorBase(loc) : null;
  return desktop ? new URL(path, desktop).href : new URL(BG_CONFIG.vendorDir + path, WEB_ROOT).href;
}

// The variants a model can run with on this machine, best first.
export function variantsFor(model, caps) {
  const out = [];
  for (const [id, v] of Object.entries(model.variants || {})) {
    const backends = v.backends?.length ? v.backends : ["wasm"];
    if (v.needs === "shader-f16" && !(caps.backend === "webgpu" && caps.f16)) continue;
    const backend = backends.includes(caps.backend) ? caps.backend : backends.includes("wasm") ? "wasm" : null;
    if (!backend) continue;
    out.push({ id, variant: v, backend });
  }
  return out;
}
