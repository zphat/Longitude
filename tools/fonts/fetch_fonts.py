"""Download the upstream font files listed in sources.json from google/fonts.

    python tools/fonts/fetch_fonts.py            fetch anything missing
    python tools/fonts/fetch_fonts.py --force    fetch everything again

Files land in tools/fonts/cache/<repo dir>/ (git-ignored). Then run
build_bundled.py to subset them into web/fonts/. Standard library only.
"""

import argparse
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache"


def wanted(sources):
    seen = set()
    for item in sources["ui"]:
        seen.add((item["dir"], item["src"]))
    for fam in sources["families"]:
        seen.add((fam["dir"], fam["license"]))
        for f in fam["files"]:
            seen.add((fam["dir"], f["src"]))
    return sorted(seen)


def fetch(repo, folder, name, force):
    dest = CACHE / folder / name
    if dest.exists() and dest.stat().st_size > 0 and not force:
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    url = f"{repo}/{folder}/{urllib.parse.quote(name)}"
    req = urllib.request.Request(url, headers={"User-Agent": "longitude-fonts"})
    with urllib.request.urlopen(req, timeout=60) as res:
        data = res.read()
    if not data:
        raise RuntimeError(f"empty download: {url}")
    dest.write_bytes(data)
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--force", action="store_true", help="download again even when cached")
    args = ap.parse_args()
    sources = json.loads((HERE / "sources.json").read_text(encoding="utf-8"))
    got = 0
    failed = []
    for folder, name in wanted(sources):
        try:
            if fetch(sources["repo"], folder, name, args.force):
                got += 1
                print(f"fetched {folder}/{name}")
        except Exception as err:  # keep going; report at the end
            failed.append(f"{folder}/{name}: {err}")
    for line in failed:
        print(f"FAILED {line}", file=sys.stderr)
    print(f"done, {got} downloaded, {len(failed)} failed, cache in {CACHE}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
