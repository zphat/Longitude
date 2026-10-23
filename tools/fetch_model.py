"""Vendor background removal for offline use. Standard library only.

    python tools/fetch_model.py                 runtime + the Fast model (about 82 MB)
    python tools/fetch_model.py --models all    runtime + every model variant (about 400 MB)
    python tools/fetch_model.py --models fast,best
    python tools/fetch_model.py --list          show what can be fetched and what is here
    python tools/fetch_model.py --check         verify the files already in web/vendor/
    python tools/fetch_model.py --clean         delete web/vendor/

Files go to web/vendor/ort/ and web/vendor/models/ (git-ignored) and are
listed in web/vendor/manifest.json. Longitude loads them from there first, so
background removal works with no network at all. URLs, sizes and SHA-256
hashes come from the config block in web/js/features/bgremove/config.js, the
same object the app uses, so the two never disagree.
"""

import argparse
import hashlib
import json
import re
import shutil
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_JS = ROOT / "web" / "js" / "features" / "bgremove" / "config.js"
VENDOR = ROOT / "web" / "vendor"
MANIFEST = VENDOR / "manifest.json"


def load_config():
    text = CONFIG_JS.read_text(encoding="utf-8")
    m = re.search(r"/\* bgconfig:begin \*/(.*?)/\* bgconfig:end \*/", text, re.S)
    if not m:
        sys.exit(f"Cannot find the bgconfig block in {CONFIG_JS}")
    return json.loads(m.group(1))


def mb(n):
    return f"{n / 1e6:.0f} MB" if n >= 1e6 else f"{n / 1e3:.0f} KB"


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def valid(path, size, sha):
    if not path.exists():
        return False
    if size and path.stat().st_size != size:
        return False
    return not sha or sha256_file(path) == sha


def download(url, dest, size, sha, label):
    if valid(dest, size, sha):
        print(f"  ok      {label} (already here)")
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "Longitude fetch_model.py"})
    start = time.time()
    with urllib.request.urlopen(req, timeout=60) as res, open(tmp, "wb") as out:
        total = size or int(res.headers.get("Content-Length") or 0)
        got = 0
        last = 0.0
        while True:
            chunk = res.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
            got += len(chunk)
            now = time.time()
            if now - last > 0.25:
                last = now
                pct = f"{got * 100 / total:5.1f}%" if total else ""
                print(f"\r  get     {label}  {pct}  {mb(got)}", end="", flush=True)
    print(f"\r  get     {label}  {mb(got)} in {time.time() - start:.0f} s".ljust(70))
    if size and tmp.stat().st_size != size:
        tmp.unlink()
        sys.exit(f"{label}: expected {size} bytes, got {got}. Try again.")
    if sha and sha256_file(tmp) != sha:
        tmp.unlink()
        sys.exit(f"{label}: the SHA-256 does not match the config. The file was not saved.")
    tmp.replace(dest)


def read_manifest():
    try:
        return json.loads(MANIFEST.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"v": 1, "ort": None, "models": {}}


def write_manifest(data):
    VENDOR.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def runtime_parts(cfg):
    ort = cfg["ort"]
    for build in ort["builds"].values():
        for key in ("script", "glue", "wasm"):
            yield build[key]


def model_variants(cfg, names):
    providers = cfg["providers"]
    if names == ["all"]:
        model_ids = list(cfg["models"].keys())
    else:
        model_ids = []
        for n in names:
            if n in providers:
                model_ids.append(providers[n]["model"])
            elif n in cfg["models"]:
                model_ids.append(n)
            else:
                sys.exit(f'Unknown model or provider "{n}". Try: {", ".join(list(providers) + list(cfg["models"]))}, all')
    for mid in dict.fromkeys(model_ids):
        for vid, v in cfg["models"][mid]["variants"].items():
            yield mid, vid, v


def fetch(cfg, names, with_runtime):
    manifest = read_manifest()
    manifest.setdefault("models", {})
    if with_runtime:
        ort = cfg["ort"]
        print(f"onnxruntime-web {ort['version']} -> {VENDOR / 'ort'}")
        files = []
        for part in runtime_parts(cfg):
            download(ort["base"] + part["file"], VENDOR / "ort" / part["file"], part.get("bytes"), part.get("sha256"), part["file"])
            files.append(part["file"])
        manifest["ort"] = {"version": ort["version"], "files": files}
        write_manifest(manifest)
    print(f"models -> {VENDOR / 'models'}")
    for mid, vid, v in model_variants(cfg, names):
        download(v["url"], VENDOR / "models" / v["file"], v.get("bytes"), v.get("sha256"), f"{mid} {vid} ({mb(v.get('bytes') or 0)})")
        manifest["models"][v["file"]] = {"model": mid, "variant": vid, "bytes": v.get("bytes"), "sha256": v.get("sha256")}
        write_manifest(manifest)
    print(f"Done. Longitude will use {VENDOR} first (restart it or reload the page).")


def list_all(cfg):
    manifest = read_manifest()
    here = set((manifest.get("models") or {}).keys())
    ort = cfg["ort"]
    rt = sum(p.get("bytes") or 0 for p in runtime_parts(cfg))
    have_rt = (manifest.get("ort") or {}).get("version") == ort["version"]
    print(f"runtime  onnxruntime-web {ort['version']}  {mb(rt)}  {'here' if have_rt else '-'}")
    for pid, p in cfg["providers"].items():
        m = cfg["models"][p["model"]]
        for vid, v in m["variants"].items():
            mark = "here" if v["file"] in here else "-"
            print(f"{pid:<8} {p['model']} {vid:<5} {mb(v.get('bytes') or 0):>7}  {m['license']}  {mark}")


def check(cfg):
    manifest = read_manifest()
    bad = 0
    ort = manifest.get("ort") or {}
    if ort.get("version") and ort["version"] != cfg["ort"]["version"]:
        print(f"runtime {ort['version']} is vendored but the app wants {cfg['ort']['version']}: run this tool again")
        bad += 1
    parts = {p["file"]: p for p in runtime_parts(cfg)}
    for f in ort.get("files") or []:
        p = parts.get(f, {})
        ok = valid(VENDOR / "ort" / f, p.get("bytes"), p.get("sha256"))
        bad += not ok
        print(f"  {'ok ' if ok else 'BAD'} ort/{f}")
    for f, info in (manifest.get("models") or {}).items():
        ok = valid(VENDOR / "models" / f, info.get("bytes"), info.get("sha256"))
        bad += not ok
        print(f"  {'ok ' if ok else 'BAD'} models/{f}")
    if not ort and not manifest.get("models"):
        print("Nothing vendored yet.")
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser(description="Vendor Longitude's background removal runtime and models for offline use.")
    ap.add_argument("--models", default="fast", help="comma list of providers or model ids (fast, best, isnet-general, birefnet-lite) or 'all'")
    ap.add_argument("--no-runtime", action="store_true", help="skip onnxruntime-web")
    ap.add_argument("--list", action="store_true", help="list what can be fetched")
    ap.add_argument("--check", action="store_true", help="verify vendored files")
    ap.add_argument("--clean", action="store_true", help="delete web/vendor/")
    a = ap.parse_args()
    cfg = load_config()
    if a.list:
        list_all(cfg)
    elif a.check:
        sys.exit(check(cfg))
    elif a.clean:
        if VENDOR.exists():
            shutil.rmtree(VENDOR)
            print(f"Deleted {VENDOR}")
        else:
            print("Nothing to delete.")
    else:
        names = [n.strip() for n in a.models.split(",") if n.strip()]
        try:
            fetch(cfg, names, not a.no_runtime)
        except KeyboardInterrupt:
            print("\nStopped. Run it again to resume.")
            sys.exit(1)
        except OSError as err:
            sys.exit(f"\nDownload failed: {err}")


if __name__ == "__main__":
    main()
