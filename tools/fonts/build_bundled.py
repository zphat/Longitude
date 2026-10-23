"""Subset the upstream fonts to Latin and write WOFF2 files into web/fonts/.

    python tools/fonts/fetch_fonts.py      (once, downloads into tools/fonts/cache/)
    python tools/fonts/build_bundled.py

Needs fontTools and brotli (pip install --user fonttools brotli). Variable
axes and their full ranges are kept. Hinting is dropped for design fonts (they
are drawn large on a canvas) and kept for the UI fonts. License texts are
copied to web/fonts/LICENSES/<slug>.txt.

Fonts whose OFL names a Reserved Font Name are copied byte for byte instead
(their "out" ends in .ttf): subsetting or converting them would make a
Modified Version, which may not use the reserved name.
"""

import json
import shutil
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache"
WEB_FONTS = HERE.parent.parent / "web" / "fonts"


def ranges(*spans):
    out = set()
    for s in spans:
        if isinstance(s, tuple):
            out.update(range(s[0], s[1] + 1))
        else:
            out.add(s)
    return out


# Google Fonts' "latin" subset, Latin Extended-A (Central European, Turkish,
# Baltic), Romanian comma-below letters, arrows and a few symbols people put
# on thumbnails. Codepoints a font does not have are skipped by the subsetter.
LATIN = ranges(
    (0x0020, 0x007E), (0x00A0, 0x00FF), (0x0100, 0x017F), (0x0218, 0x021B), 0x1E9E, (0x02BB, 0x02BC),
    0x02C6, 0x02DA, 0x02DC, 0x0304, 0x0308, 0x0329, (0x2000, 0x206F), 0x20AC, 0x20BF,
    0x2116, 0x2122, (0x2190, 0x2199), 0x2212, 0x2215, 0x221E, 0x2248, 0x2260, 0x2264,
    0x2265, 0x25CF, 0x2605, 0x2665, 0x2713, 0x2717, 0xFEFF, 0xFFFD,
)
# The UI also shows Mac shortcut glyphs and a few key symbols.
UI_EXTRA = ranges(0x2318, 0x21E7, 0x2325, 0x2303, 0x21B5, 0x232B, 0x238B, 0x23CE, 0x21E5, 0x2191, 0x2193)

NAME_IDS = [0, 1, 2, 3, 4, 5, 6, 13, 14]


def build(src, dest, unicodes, hinting):
    opts = subset.Options()
    opts.flavor = "woff2"
    opts.layout_features = opts.layout_features + ["case", "tnum", "lnum"]
    opts.name_IDs = NAME_IDS
    opts.name_languages = [0x0409]
    opts.hinting = hinting
    opts.notdef_outline = True
    opts.recalc_bounds = True
    opts.drop_tables += ["DSIG"]
    font = subset.load_font(str(src), opts)
    font.recalcTimestamp = False  # same input, same bytes
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=sorted(unicodes))
    sub.subset(font)
    dest.parent.mkdir(parents=True, exist_ok=True)
    subset.save_font(font, str(dest), opts)
    font.close()
    return dest.stat().st_size


def has_reserved_name(license_text):
    """True when the copyright header (above the license body) reserves a font name."""
    header = license_text.split("This Font Software is licensed", 1)[0]
    return "reserved font name" in header.lower()


def check(path):
    font = TTFont(str(path))
    cmap = font.getBestCmap()
    missing = [chr(c) for c in range(0x41, 0x5B) if c not in cmap]
    axes = [f"{a.axisTag} {a.minValue:g}-{a.maxValue:g}" for a in font["fvar"].axes] if "fvar" in font else []
    font.close()
    return missing, axes


def main():
    sources = json.loads((HERE / "sources.json").read_text(encoding="utf-8"))
    total = 0
    ui_total = 0
    problems = []
    for item in sources["ui"]:
        src = CACHE / item["dir"] / item["src"]
        dest = WEB_FONTS / item["out"]
        size = build(src, dest, LATIN | UI_EXTRA, hinting=True)
        ui_total += size
        missing, axes = check(dest)
        print(f"ui   {item['out']:<48} {size / 1024:7.1f} KB  {' '.join(axes)}")
        if missing:
            problems.append(f"{item['out']} lacks {''.join(missing)}")
    lic_dir = WEB_FONTS / "LICENSES"
    lic_dir.mkdir(parents=True, exist_ok=True)
    for fam in sources["families"]:
        license = CACHE / fam["dir"] / fam["license"]
        shutil.copyfile(license, lic_dir / f"{fam['slug']}.txt")
        reserved = has_reserved_name(license.read_text(encoding="utf-8", errors="replace"))
        for f in fam["files"]:
            src = CACHE / fam["dir"] / f["src"]
            dest = WEB_FONTS / f["out"]
            if reserved != dest.suffix.lower().endswith("ttf"):
                problems.append(f"{f['out']}: Reserved Font Name means copy as .ttf, otherwise build .woff2")
                continue
            if reserved:
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(src, dest)
                size = dest.stat().st_size
            else:
                size = build(src, dest, LATIN, hinting=False)
            total += size
            missing, axes = check(dest)
            note = "(unmodified, reserved name)" if reserved else " ".join(axes)
            print(f"font {f['out']:<48} {size / 1024:7.1f} KB  {note}")
            if missing:
                problems.append(f"{f['out']} lacks {''.join(missing)}")
    print(f"\nUI fonts {ui_total / 1024:.0f} KB, design fonts {total / 1024:.0f} KB (Manrope and Syne reuse the UI files)")
    for p in problems:
        print("PROBLEM", p)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
