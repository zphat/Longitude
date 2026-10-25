"""Stages the background remover the desktop installer bundles. Standard library only.

    python tools/fetch_model.py --models fast     runtime + the Fast model into web/vendor/
    python src-tauri/stage_vendor.py --move       check them, move them into src-tauri/vendor/

The installer copies src-tauri/vendor/ next to the program (bundle.resources in
tauri.conf.json) and the app reads it from there (the "vendor" protocol in
src/lib.rs). This script takes exactly what config.js lists for the runtime
(every build) and the default provider's model, checks each file's size and
SHA-256 against that same config block, copies it, and writes a manifest of
the copied files only. Anything else in web/vendor/ (Best, a first-run
marker, half-finished downloads) stays out of the installer.

--move   delete web/vendor/ afterwards. Everything in web/ is compiled into
         the program, so a build with web/vendor/ still there carries the
         model twice (src-tauri/build.rs warns).
--root   the repository root (default: this file's parent folder's parent).

Exit codes: 0 staged, 1 a file is missing or does not match config.js.
In GitHub Actions the problems are printed as ::error:: annotations.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from pathlib import Path


def load_config(root):
    path = root / "web" / "js" / "features" / "bgremove" / "config.js"
    text = path.read_text(encoding="utf-8")
    m = re.search(r"/\* bgconfig:begin \*/(.*?)/\* bgconfig:end \*/", text, re.S)
    if not m:
        raise SystemExit(f"Cannot find the bgconfig block in {path}")
    return json.loads(m.group(1))


def wanted(cfg):
    """[(folder, file, bytes, sha256)] for every runtime build and the default provider's model."""
    out = []
    for build in cfg["ort"]["builds"].values():
        for key in ("script", "glue", "wasm"):
            part = build[key]
            out.append(("ort", part["file"], part.get("bytes"), part.get("sha256")))
    provider = cfg["providers"][cfg.get("defaultProvider") or "fast"]
    model_id = provider["model"]
    variants = cfg["models"][model_id]["variants"]
    for vid, v in variants.items():
        out.append(("models", v["file"], v.get("bytes"), v.get("sha256")))
    return out, model_id, variants


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def problem(msg):
    if os.environ.get("GITHUB_ACTIONS") == "true":
        print(f"::error title=Bundled background remover::{msg}")
    else:
        print(f"  {msg}")


def stage(root, move=False):
    cfg = load_config(root)
    src = root / "web" / "vendor"
    dst = root / "src-tauri" / "vendor"
    files, model_id, variants = wanted(cfg)
    bad = 0
    for folder, name, size, digest in files:
        path = src / folder / name
        if not path.is_file():
            problem(f"web/vendor/{folder}/{name} is missing. Run: python tools/fetch_model.py --models fast")
            bad += 1
            continue
        if size and path.stat().st_size != size:
            problem(f"web/vendor/{folder}/{name} is {path.stat().st_size} bytes; config.js says {size}.")
            bad += 1
            continue
        if digest and sha256(path) != digest:
            problem(f"web/vendor/{folder}/{name} does not match its SHA-256 in config.js.")
            bad += 1
    if bad:
        print(f"Not staged: {bad} problem(s). src-tauri/vendor/ was left as it was.")
        return 1

    if dst.exists():
        shutil.rmtree(dst)
    (dst / "ort").mkdir(parents=True)
    (dst / "models").mkdir()
    total = 0
    for folder, name, _size, _digest in files:
        shutil.copy2(src / folder / name, dst / folder / name)
        total += (dst / folder / name).stat().st_size
    manifest = {
        "v": 1,
        "bundled": "desktop",
        "ort": {"version": cfg["ort"]["version"], "files": [name for folder, name, _s, _d in files if folder == "ort"]},
        "models": {
            v["file"]: {"model": model_id, "variant": vid, "bytes": v.get("bytes") or None, "sha256": v.get("sha256")}
            for vid, v in variants.items()
        },
    }
    (dst / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Staged onnxruntime-web {cfg['ort']['version']} and {model_id} in {dst} ({round(total / 1e6)} MB, {len(files)} files).")
    if move:
        shutil.rmtree(src)
        print(f"Removed {src}, so the program does not carry a second copy.")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="Copy the checked background remover into src-tauri/vendor/ for the desktop installer.")
    ap.add_argument("--move", action="store_true", help="delete web/vendor/ afterwards")
    ap.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent, help="repository root")
    args = ap.parse_args(argv)
    return stage(args.root.resolve(), move=args.move)


if __name__ == "__main__":
    sys.exit(main())
