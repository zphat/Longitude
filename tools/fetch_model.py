"""Vendor background removal for offline use. Standard library only.

    python tools/fetch_model.py                 runtime + the Fast model (about 82 MB)
    python tools/fetch_model.py --models all    runtime + every model variant (about 400 MB)
    python tools/fetch_model.py --models fast,best
    python tools/fetch_model.py --list          show what can be fetched and what is here
    python tools/fetch_model.py --check         verify the files already in web/vendor/
    python tools/fetch_model.py --clean         delete web/vendor/
    python tools/fetch_model.py --first-run     what Start Longitude.cmd runs: asks once

    --yes     answer yes to the --first-run question (scripts, CI)
    --quiet   one line per file instead of a progress bar (CI logs)

Files go to web/vendor/ort/ and web/vendor/models/ (git-ignored) and are
listed in web/vendor/manifest.json. Longitude loads them from there first, so
background removal works with no network at all. URLs, sizes and SHA-256
hashes come from the config block in web/js/features/bgremove/config.js, the
same object the app uses, so the two never disagree.

Downloads land in <file>.part first and move into place only after the size
and SHA-256 check, so an interrupted run never leaves a broken file behind.
Running again goes on from the .part file where the server allows it.

Exit codes: 0 done, 1 download failed or stopped (run again to go on),
2 a file did not match its SHA-256 (it was not saved), 3 --check found a problem.
"""

import argparse
import datetime
import hashlib
import http.client
import json
import re
import shutil
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_JS = ROOT / "web" / "js" / "features" / "bgremove" / "config.js"
VENDOR = ROOT / "web" / "vendor"
USER_AGENT = "Longitude fetch_model.py"
CHUNK = 1 << 16


class IntegrityError(Exception):
    """A downloaded file is not the one config.js describes."""


def manifest_path():
    return VENDOR / "manifest.json"


def first_run_path():
    # Start Longitude.cmd asks once; the answer lives here (web/vendor/ is git-ignored).
    return VENDOR / "first-run.json"


def load_config():
    text = CONFIG_JS.read_text(encoding="utf-8")
    m = re.search(r"/\* bgconfig:begin \*/(.*?)/\* bgconfig:end \*/", text, re.S)
    if not m:
        sys.exit(f"Cannot find the bgconfig block in {CONFIG_JS}")
    return json.loads(m.group(1))


# ---- sizes and progress ------------------------------------------------------------


def mb(n):
    """Decimal megabytes, rounded the way the app shows them (at least 1 MB)."""
    if n <= 0:
        return "0 MB"
    return f"{max(1, round(n / 1e6))} MB"


def speed_text(bps):
    if not bps or bps <= 0:
        return ""
    if bps < 1e6:
        return f"{max(1, round(bps / 1e3))} KB/s"
    return f"{bps / 1e6:.1f} MB/s" if bps < 9.95e6 else f"{round(bps / 1e6)} MB/s"


def eta_text(seconds):
    if seconds is None or seconds < 0:
        return ""
    if seconds < 8:
        return "a few seconds left"
    if seconds < 55:
        return f"about {int(-(-seconds // 5) * 5)} s left"
    if seconds < 3570:
        return f"about {max(1, round(seconds / 60))} min left"
    return f"about {round(seconds / 3600)} h left"


def bar_text(fraction, width=24):
    filled = int(round(max(0.0, min(1.0, fraction)) * width))
    return "[" + "#" * filled + "-" * (width - filled) + "]"


class Progress:
    """One bar for the whole download on a console; plain lines in a log."""

    def __init__(self, total, quiet=False, stream=None):
        self.total = total
        self.quiet = quiet
        self.stream = stream or sys.stdout
        self.live = not quiet and hasattr(self.stream, "isatty") and self.stream.isatty()
        self.done = 0
        self.start = time.time()
        self.start_bytes = 0
        self.last = 0.0
        self.width = 0

    def line(self):
        finished = self.done >= self.total
        # Like the app: rounds down while it runs (never "100%" or "69 of 69 MB"
        # before the last byte), whole at the end.
        pct = 100 if finished else min(99, int(self.done * 100 // self.total))
        elapsed = time.time() - self.start
        got = self.done - self.start_bytes
        bps = got / elapsed if elapsed >= 1 and got > 0 else 0
        left = (self.total - self.done) / bps if bps else None
        total_mb = max(1, round(self.total / 1e6)) if self.total > 0 else 0
        done_mb = total_mb if finished else min(total_mb, int(self.done // 1e6))
        parts = [
            f"  {bar_text(self.done / self.total if self.total else 1)} {pct:3d}%",
            f"{done_mb} of {mb(self.total)}",
            speed_text(bps),
            eta_text(left) if self.done < self.total else "",
        ]
        return "  ".join(p for p in parts if p)

    def resume(self, have):
        """Bytes already in .part files when the run starts."""
        self.done += have
        self.start_bytes += have

    def update(self, done):
        self.done = done
        now = time.time()
        if not self.live or now - self.last < 0.2:
            return
        self.last = now
        text = self.line()
        self.width = max(self.width, len(text))
        self.stream.write("\r" + text.ljust(self.width))
        self.stream.flush()

    def note(self, text):
        """A line of its own (a retry, a finished file in a log)."""
        if self.live and self.width:
            self.stream.write("\r" + " " * self.width + "\r")
        self.stream.write(text + "\n")
        self.stream.flush()
        self.last = 0.0

    def finish(self):
        if self.live:
            self.done = self.total
            text = self.line()
            self.stream.write("\r" + text.ljust(self.width) + "\n")
            self.stream.flush()


# ---- files -----------------------------------------------------------------------------


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


def part_path(dest):
    return dest.with_name(dest.name + ".part")


def part_bytes(dest, size):
    part = part_path(dest)
    have = part.stat().st_size if part.exists() else 0
    return have if not size or have <= size else 0


def fetch_to_part(url, dest, size, progress, base):
    """Downloads url into dest.part, going on from what is there when the server allows it."""
    part = part_path(dest)
    have = part_bytes(dest, size)
    if part.exists() and not have:
        part.unlink()
    if size and have == size:
        progress.update(base + have)
        return
    headers = {"User-Agent": USER_AGENT}
    if have:
        headers["Range"] = f"bytes={have}-"
    req = urllib.request.Request(url, headers=headers)
    try:
        res = urllib.request.urlopen(req, timeout=60)
    except urllib.error.HTTPError as err:
        if err.code == 416 and have:
            part.unlink()
            progress.done -= have
            progress.start_bytes -= have
            return fetch_to_part(url, dest, size, progress, base)
        raise
    with res:
        status = getattr(res, "status", None) or res.getcode()
        mode = "wb"
        if have and status == 206:
            m = re.match(r"bytes (\d+)-", res.headers.get("Content-Range", ""))
            if m and int(m.group(1)) == have:
                mode = "ab"
        if mode == "wb" and have:
            # The server sent the whole file again: the count starts over too.
            progress.done -= have
            progress.start_bytes -= have
            have = 0
        got = have
        with open(part, mode) as out:
            while True:
                chunk = res.read(CHUNK)
                if not chunk:
                    break
                out.write(chunk)
                got += len(chunk)
                progress.update(base + got)
                if size and got > size:
                    break
    # http.client returns b"" when a Content-Length body ends early instead of
    # raising: a connection that closed too soon. ConnectionError is an OSError,
    # so download() tries again and goes on from the .part file (Range).
    if size and got < size:
        raise ConnectionError(f"the connection closed after {got} of {size} bytes")


NETWORK_ERRORS = (urllib.error.URLError, http.client.HTTPException, OSError, TimeoutError)


def download(item, progress, base, retries=3):
    """One file: into .part (with retries), checked, then moved into place."""
    url, dest, size, sha, label = item["url"], item["dest"], item["bytes"], item["sha256"], item["label"]
    dest.parent.mkdir(parents=True, exist_ok=True)
    started = time.time()
    for attempt in range(1, retries + 1):
        try:
            fetch_to_part(url, dest, size, progress, base)
            break
        except NETWORK_ERRORS as err:
            if attempt == retries:
                raise
            reason = getattr(err, "reason", None) or err
            progress.note(f"  retry   {label}: {reason} (try {attempt + 1} of {retries})")
            time.sleep(min(10, 2 * attempt))
    part = part_path(dest)
    got = part.stat().st_size
    if size and got != size:
        # Only a file larger than config.js says gets here (a short one is retried above).
        part.unlink()
        raise IntegrityError(f"{label}: expected {size} bytes, got {got}, more than config.js says. The file was not saved.")
    if sha and sha256_file(part) != sha:
        part.unlink()
        raise IntegrityError(f"{label}: the SHA-256 does not match config.js. The file was not saved.")
    part.replace(dest)
    if not progress.live:
        progress.note(f"  get     {label}  {mb(got)} in {time.time() - started:.0f} s")


# ---- what to fetch ---------------------------------------------------------------------------


def read_manifest():
    try:
        return json.loads(manifest_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"v": 1, "ort": None, "models": {}}


def write_manifest(data):
    VENDOR.mkdir(parents=True, exist_ok=True)
    manifest_path().write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


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
                raise SystemExit(f'Unknown model or provider "{n}". Try: {", ".join(list(providers) + list(cfg["models"]))}, all')
    for mid in dict.fromkeys(model_ids):
        for vid, v in cfg["models"][mid]["variants"].items():
            yield mid, vid, v


def plan(cfg, names, with_runtime):
    items = []
    if with_runtime:
        ort = cfg["ort"]
        for part in runtime_parts(cfg):
            items.append({"kind": "ort", "url": ort["base"] + part["file"], "dest": VENDOR / "ort" / part["file"], "bytes": part.get("bytes") or 0, "sha256": part.get("sha256"), "label": part["file"]})
    for mid, vid, v in model_variants(cfg, names):
        items.append({"kind": "model", "model": mid, "variant": vid, "file": v["file"], "url": v["url"], "dest": VENDOR / "models" / v["file"], "bytes": v.get("bytes") or 0, "sha256": v.get("sha256"), "label": f"{mid} {vid}"})
    return items


def what(cfg, names):
    providers = cfg["providers"]
    if names == ["all"]:
        return "every model"
    return " and ".join(f"the {providers[n]['label']} model" if n in providers else n for n in names)


def fetch(cfg, names, with_runtime, quiet=False, retries=3):
    items = plan(cfg, names, with_runtime)
    todo = [i for i in items if not valid(i["dest"], i["bytes"], i["sha256"])]
    total = sum(i["bytes"] for i in todo)
    runtime = f"onnxruntime-web {cfg['ort']['version']}" if with_runtime else ""
    subject = ", ".join(x for x in (runtime, what(cfg, names)) if x)
    manifest = read_manifest()
    manifest.setdefault("models", {})

    # The manifest lists every finished file as soon as it is in place, so the
    # app can use what an interrupted run already got.
    def here(i):
        return i["dest"].exists() and (not i["bytes"] or i["dest"].stat().st_size == i["bytes"])

    def record():
        if with_runtime:
            files = [i["dest"].name for i in items if i["kind"] == "ort" and here(i)]
            old = manifest.get("ort") or {}
            if old.get("version") == cfg["ort"]["version"]:
                files = list(dict.fromkeys([*(old.get("files") or []), *files]))
            manifest["ort"] = {"version": cfg["ort"]["version"], "files": files}
        for i in items:
            if i["kind"] == "model" and here(i):
                manifest["models"][i["file"]] = {"model": i["model"], "variant": i["variant"], "bytes": i["bytes"] or None, "sha256": i["sha256"]}
        write_manifest(manifest)

    if not todo:
        print(f"Background removal is already here ({subject}) in {VENDOR}.")
        record()
        return
    print(f"Downloading background removal for offline use: {subject} ({mb(total)}).")
    progress = Progress(total, quiet=quiet)
    progress.resume(sum(part_bytes(i["dest"], i["bytes"]) for i in todo))
    base = 0
    try:
        for item in todo:
            download(item, progress, base, retries=retries)
            base += item["bytes"]
            record()
    finally:
        if progress.live and progress.width and base < total:
            progress.stream.write("\n")
    progress.finish()
    record()
    print("Done. Background removal works offline now (reload Longitude if it is open).")


def missing_bytes(cfg, names, with_runtime=True):
    """What fetch() would download, by size only (quick: no hashing)."""
    total = 0
    for item in plan(cfg, names, with_runtime):
        dest = item["dest"]
        if not (dest.exists() and (not item["bytes"] or dest.stat().st_size == item["bytes"])):
            total += item["bytes"]
    return total


# ---- the first-run question (Start Longitude.cmd) ----------------------------------------------


# A "yes" whose download did not finish is offered once more ("Finish the
# download?"); after that, or on a "no" to it, the half-finished files go.
FIRST_RUN_TRIES = 2


def read_marker():
    try:
        data = json.loads(first_run_path().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        return {}


def write_marker(data):
    VENDOR.mkdir(parents=True, exist_ok=True)
    first_run_path().write_text(json.dumps(data) + "\n", encoding="utf-8")


def drop_parts(cfg, names):
    """Deletes the half-finished downloads (.part files) of these models and the runtime."""
    gone = 0
    for item in plan(cfg, names, True):
        p = part_path(item["dest"])
        try:
            if p.exists():
                p.unlink()
                gone += 1
        except OSError:
            pass
    return gone


def first_run(cfg, yes=False, quiet=False, ask=input, interactive=None):
    """Asks once whether to download the default model now, and once more to
    finish a download that was stopped. Never fails the start: any problem
    leaves the in-app download in place."""
    names = [cfg.get("defaultProvider") or "fast"]
    need = missing_bytes(cfg, names)
    if not need:
        return 0
    marker = read_marker()
    if marker is not None:
        # "no" stays no. A "yes" from before the done flag counts as done.
        if marker.get("answer") != "yes" or marker.get("done", True) or int(marker.get("tries", 1)) >= FIRST_RUN_TRIES:
            return 0
    resume = marker is not None
    tries = int(marker.get("tries", 1)) + 1 if resume else 1
    if interactive is None:
        # Both ends on a console: on Windows a stdin redirected from NUL also says it is a TTY.
        tty = lambda f: bool(getattr(f, "isatty", lambda: False)())  # noqa: E731
        interactive = tty(sys.stdin) and tty(sys.stdout)
    if yes:
        answer = True
    elif not interactive:
        return 0
    else:
        if resume:
            # What is left, counting the .part files the download goes on from.
            have = sum(part_bytes(i["dest"], i["bytes"]) for i in plan(cfg, names, True) if not valid(i["dest"], i["bytes"], None))
            question = f"Finish the background removal download ({mb(max(1, need - have))} left)? [Y/n] "
        else:
            question = f"Background removal needs a one-time download (about {mb(need)}). Download it now so it works offline? [Y/n] "
        print()
        try:
            reply = ask(question)
        except (EOFError, KeyboardInterrupt):
            print()
            return 0
        answer = reply.strip().lower() in ("", "y", "yes")
    today = datetime.date.today().isoformat()
    if not answer:
        write_marker({"asked": today, "answer": "no"})
        if resume:
            drop_parts(cfg, names)
        print("No problem. Longitude offers the download in the app when you need it.\n")
        return 0
    state = {"asked": today, "answer": "yes", "done": False, "tries": tries}
    write_marker(state)
    last = tries >= FIRST_RUN_TRIES
    print('Longitude opens as soon as this finishes. To skip it now, press Ctrl+C, then answer N to "Terminate batch job".')
    later = "it offers the download in the app" if last else "it offers the download in the app, and the next start offers to finish it"
    done = False
    try:
        fetch(cfg, names, True, quiet=quiet)
        done = True
    except KeyboardInterrupt:
        print(f'\nStopped. If Windows asks "Terminate batch job (Y/N)?", answer N to open Longitude now; {later}.')
    except IntegrityError as err:
        print(f"\n{err}\nLongitude offers the download in the app instead.")
    except NETWORK_ERRORS as err:
        print(f"\nThe download did not finish ({getattr(err, 'reason', None) or err}). Longitude opens anyway; {later}.")
    if done:
        write_marker({**state, "done": True})
    elif last and drop_parts(cfg, names):
        print("The half-finished files were deleted.")
    print()
    return 0


# ---- list, check, main ------------------------------------------------------------------------------


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
    return 3 if bad else 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="Vendor Longitude's background removal runtime and models for offline use.")
    ap.add_argument("--models", default=None, help="comma list of providers or model ids (fast, best, isnet-general, birefnet-lite) or 'all'; default: the app's default model")
    ap.add_argument("--no-runtime", action="store_true", help="skip onnxruntime-web")
    ap.add_argument("--list", action="store_true", help="list what can be fetched")
    ap.add_argument("--check", action="store_true", help="verify vendored files")
    ap.add_argument("--clean", action="store_true", help="delete web/vendor/")
    ap.add_argument("--first-run", action="store_true", help="ask once whether to download the default model now (Start Longitude.cmd)")
    ap.add_argument("--yes", "-y", action="store_true", help="answer yes to the --first-run question")
    ap.add_argument("--quiet", "-q", action="store_true", help="no progress bar: one line per file")
    ap.add_argument("--retries", type=int, default=3, help="tries per file on a network error (default 3)")
    a = ap.parse_args(argv)
    cfg = load_config()
    if a.list:
        list_all(cfg)
        return 0
    if a.check:
        return check(cfg)
    if a.clean:
        if VENDOR.exists():
            shutil.rmtree(VENDOR)
            print(f"Deleted {VENDOR}")
        else:
            print("Nothing to delete.")
        return 0
    if a.first_run:
        return first_run(cfg, yes=a.yes, quiet=a.quiet)
    names = [n.strip() for n in (a.models or cfg.get("defaultProvider") or "fast").split(",") if n.strip()]
    try:
        fetch(cfg, names, not a.no_runtime, quiet=a.quiet, retries=max(1, a.retries))
    except KeyboardInterrupt:
        print("\nStopped. Run it again to go on where it stopped.")
        return 1
    except IntegrityError as err:
        print(f"\n{err}", file=sys.stderr)
        return 2
    except NETWORK_ERRORS as err:
        print(f"\nDownload failed: {getattr(err, 'reason', None) or err}. Run it again to go on where it stopped.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
