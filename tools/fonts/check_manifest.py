"""Check web/fonts/fonts.json against the font files it points at.

    python tools/fonts/check_manifest.py

For every bundled face: the file opens, it covers A-Z, 0-9 and the family's
sample text, and its weight axis matches "variable" in fonts.json. When the
OpenType Sanitizer is installed (pip install --user opentype-sanitizer) every
file also goes through it, as browsers do before they use a web font. Prints
the total size of the design fonts. Exits non-zero on a problem.
"""

import json
import os
import sys
from pathlib import Path

from fontTools.ttLib import TTFont

try:
    import ots
except ImportError:  # optional
    ots = None

FONTS = Path(__file__).resolve().parent.parent.parent / "web" / "fonts"
BUDGET = 4 * 1024 * 1024


def main():
    manifest = json.loads((FONTS / "fonts.json").read_text(encoding="utf-8"))
    problems = []
    total = 0
    seen_files = set()
    for fam in manifest["families"]:
        name = fam["family"]
        for face in fam["faces"]:
            if "file" not in face:
                continue
            path = FONTS / face["file"]
            if face["file"] not in seen_files:
                seen_files.add(face["file"])
                total += path.stat().st_size
            font = TTFont(str(path))
            cmap = font.getBestCmap()
            need = set("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") | set(fam["sample"].replace(" ", ""))
            missing = sorted(c for c in need if ord(c) not in cmap)
            if missing:
                problems.append(f"{name} ({face['file']}) lacks {''.join(missing)}")
            axis = None
            if "fvar" in font:
                axis = next((a for a in font["fvar"].axes if a.axisTag == "wght"), None)
            var = fam.get("variable")
            if var and (not axis or (axis.minValue, axis.maxValue) != (var["min"], var["max"])):
                got = f"{axis.minValue:g}-{axis.maxValue:g}" if axis else "none"
                problems.append(f"{name}: fonts.json says wght {var['min']}-{var['max']}, file has {got}")
            if not var and axis:
                problems.append(f"{name}: file is variable but fonts.json has no variable range")
            lower = sum(1 for c in "abcdefghijklmnopqrstuvwxyz" if ord(c) in cmap)
            font.close()
            if ots:
                res = ots.sanitize(str(path), os.devnull, capture_output=True)
                if res.returncode != 0:
                    problems.append(f"{name} ({face['file']}) fails the OpenType Sanitizer: {res.stderr.decode(errors='replace').strip()}")
            print(f"ok  {name:<26} {face['weight']} {face['style']:<6} {path.stat().st_size / 1024:6.1f} KB  lowercase {lower}/26")
    print(f"\n{len(seen_files)} files, {total / 1024:.0f} KB (budget {BUDGET // 1024} KB)")
    print("OpenType Sanitizer: " + ("checked" if ots else "not installed, skipped"))
    if total > BUDGET:
        problems.append("design fonts are over the size budget")
    for p in problems:
        print("PROBLEM", p)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
