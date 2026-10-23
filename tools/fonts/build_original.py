"""Build the original Longitude fonts.

    python tools/fonts/build_original.py            build all four families
    python tools/fonts/build_original.py --specimen also render PNG specimens

Families (SIL Open Font License 1.1, Copyright Longitude contributors):
  Longitude Meridian        heavy rounded caps, from skeletons in meridian.py
  Longitude Meridian Slant  the same sheared 12 degrees
  Longitude Gridline        5x7 pixel font with lowercase, from gridline.txt
  Longitude Gridline Dot    the same grid drawn with round dots

Needs fontTools, skia-pathops and brotli:
  pip install --user fonttools skia-pathops brotli
Writes WOFF2 files to web/fonts/original/, TTF files and specimens to
tools/fonts/out/ (git-ignored) and licence texts to web/fonts/LICENSES/.
The output is deterministic: same sources, same bytes.
"""

import argparse
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import pathops  # noqa: E402
from fontTools.agl import UV2AGL  # noqa: E402
from fontTools.feaLib.builder import addOpenTypeFeaturesFromString  # noqa: E402
from fontTools.fontBuilder import FontBuilder  # noqa: E402
from fontTools.pens.cu2quPen import Cu2QuPen  # noqa: E402
from fontTools.pens.transformPen import TransformPen  # noqa: E402
from fontTools.pens.ttGlyphPen import TTGlyphPen  # noqa: E402
from fontTools.ttLib import TTFont, newTable  # noqa: E402
from fontTools.ttLib.tables._k_e_r_n import KernTable_format_0  # noqa: E402

from skeleton import Sk, circle, rect  # noqa: E402

ROOT = HERE.parent.parent
OUT_WEB = ROOT / "web" / "fonts" / "original"
OUT_LIC = ROOT / "web" / "fonts" / "LICENSES"
OUT_TMP = HERE / "out"

UPM = 1000
VERSION = "1.000"
YEAR = "2026"
COPYRIGHT = f"Copyright {YEAR} Longitude contributors"
LICENSE_DESC = (
    "This Font Software is licensed under the SIL Open Font License, Version 1.1. "
    "This license is available with a FAQ at: https://openfontlicense.org"
)
LICENSE_URL = "https://openfontlicense.org"
VENDOR = "LNGT"


# ---- outlines -----------------------------------------------------------------

def _near(a, b):
    return abs(a[0] - b[0]) < 1e-6 and abs(a[1] - b[1]) < 1e-6


def sk_path(sk):
    path = pathops.Path()
    pen = path.getPen()
    pen.moveTo(sk.start)
    drawn = 0
    for seg in sk.segs:
        if seg[0] == "L":
            if _near(seg[1], seg[2]):
                continue
            pen.lineTo(seg[2])
        else:
            if all(_near(seg[1], p) for p in seg[2:]):
                continue
            pen.curveTo(seg[2], seg[3], seg[4])
        drawn += 1
    if sk.closed:
        pen.closePath()
    else:
        if drawn == 0:  # a dot: a zero-length stroke still gets round caps
            pen.lineTo((sk.start[0] + 0.01, sk.start[1]))
        pen.endPath()
    return path


def union(parts):
    """Union of closed paths. Each part is simplified on its own first so all of
    them share one orientation; then a nonzero simplify merges the overlaps."""
    total = pathops.Path()
    for p in parts:
        p.convertConicsToQuads()
        p.simplify(fix_winding=True, keep_starting_points=False, clockwise=True)
        total.addPath(p)
    total.simplify(fix_winding=True, keep_starting_points=False, clockwise=True)
    total.convertConicsToQuads()
    return total


def glyph_outline(g):
    """Union of every stroke and fill of a skeleton glyph as one pathops.Path."""
    parts = []
    for sk, width in g.strokes:
        p = sk_path(sk)
        p.stroke(width, pathops.LineCap.ROUND_CAP, pathops.LineJoin.ROUND_JOIN, 4)
        parts.append(p)
    parts.extend(sk_path(sk) for sk in g.fills)
    return union(parts)


def bounds(path):
    if not list(path.segments):
        return None
    return path.bounds  # (xMin, yMin, xMax, yMax)


def contour_area(points):
    a = 0.0
    for i in range(len(points)):
        x0, y0 = points[i - 1]
        x1, y1 = points[i]
        a += x0 * y1 - x1 * y0
    return a / 2


def to_tt(path, transform):
    """Draw a pathops path into a TrueType glyph through transform."""
    tt = TTGlyphPen(None)
    pen = TransformPen(Cu2QuPen(tt, max_err=0.6, reverse_direction=False), transform)
    path.draw(pen)
    return tt.glyph()  # rounds to integers


def clean_glyph(glyph):
    """Drop degenerate contours and collinear on-curve points after rounding."""
    if glyph.numberOfContours <= 0:
        return glyph, []
    coords = list(glyph.coordinates)
    flags = list(glyph.flags)
    ends = list(glyph.endPtsOfContours)
    out_c, out_f, out_e = [], [], []
    start = 0
    dropped = []
    for end in ends:
        pts = coords[start:end + 1]
        fl = flags[start:end + 1]
        start = end + 1
        keep = []
        n = len(pts)
        for i in range(n):
            p, f = pts[i], fl[i] & 1
            prev = pts[i - 1]
            nxt = pts[(i + 1) % n]
            if p == prev and n > 1:
                continue
            if f and (fl[i - 1] & 1) and (fl[(i + 1) % n] & 1):
                cross = (p[0] - prev[0]) * (nxt[1] - p[1]) - (p[1] - prev[1]) * (nxt[0] - p[0])
                if cross == 0:
                    continue
            keep.append((p, fl[i]))
        if len(keep) < 3 or abs(contour_area([k[0] for k in keep])) < 40:
            dropped.append(len(pts))
            continue
        out_c.extend(k[0] for k in keep)
        out_f.extend(k[1] for k in keep)
        out_e.append(len(out_c) - 1)
    from fontTools.ttLib.tables._g_l_y_f import GlyphCoordinates
    glyph.coordinates = GlyphCoordinates(out_c)
    glyph.flags = bytearray(out_f)
    glyph.endPtsOfContours = out_e
    glyph.numberOfContours = len(out_e)
    return glyph, dropped


def notdef_glyph(width, height):
    outer = rect(60, 0, width - 60, height)
    inner = Sk(130, 70).l(130, height - 70).l(width - 130, height - 70).l(width - 130, 70).z()
    path = pathops.Path()
    for sk in (outer, inner):
        path.addPath(sk_path(sk))
    path.fillType = pathops.FillType.EVEN_ODD
    path.simplify(fix_winding=True, keep_starting_points=False, clockwise=True)
    return path


# ---- font assembly --------------------------------------------------------------

def glyph_name(cp):
    return UV2AGL.get(cp, f"uni{cp:04X}")


def build_font(spec):
    """spec: family, style, description, glyphs [(name, unicodes, path, lsb, rsb, advance)],
    aliases {codepoint: glyph name}, kerning {(left, right): value}, ascender, descender,
    capHeight, xHeight, weight, italicAngle (sheared around half the cap height), originX
    (pixel fonts: fixed x offset instead of side bearings)."""
    order = [".notdef"]
    cmap = {}
    glyf = {}
    hmtx = {}
    report = []
    shear = math.tan(math.radians(spec.get("italicAngle", 0) * -1))
    yc = spec["capHeight"] / 2

    def place(name, path, lsb, rsb, advance):
        b = bounds(path)
        if b is None:
            glyf[name] = TTGlyphPen(None).glyph()
            hmtx[name] = (int(advance or lsb + rsb), 0)
            return
        xmin, _, xmax, _ = b
        if "originX" in spec:
            dx = spec["originX"]
            adv = advance
        elif advance:
            dx = (advance - (xmax - xmin)) / 2 - xmin
            adv = advance
        else:
            dx = lsb - xmin
            adv = round(xmax - xmin + lsb + rsb)
        transform = (1, 0, shear, 1, dx - shear * yc, 0)
        g, dropped = clean_glyph(to_tt(path, transform))
        if dropped:
            report.append(f"{name}: dropped {len(dropped)} degenerate contour(s)")
        glyf[name] = g
        hmtx[name] = (int(adv), 0)

    nd = notdef_glyph(520, spec["capHeight"])
    place(".notdef", nd, 60, 60, 0)
    for name, unicodes, path, lsb, rsb, advance in spec["glyphs"]:
        order.append(name)
        for u in unicodes:
            cmap[u] = name
        place(name, path, lsb, rsb, advance)
    for cp, target in spec.get("aliases", {}).items():
        if target in glyf and cp not in cmap:
            cmap[cp] = target

    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyf)
    glyf_table = fb.font["glyf"]
    metrics = {}
    for name in order:
        g = glyf_table[name]
        g.recalcBounds(glyf_table)
        metrics[name] = (hmtx[name][0], getattr(g, "xMin", 0) if g.numberOfContours else 0)
    fb.setupHorizontalMetrics(metrics)

    italic = spec.get("italicAngle", 0) != 0
    asc, desc = spec["ascender"], spec["descender"]
    fb.setupHorizontalHeader(
        ascent=asc, descent=desc, lineGap=0,
        caretSlopeRise=UPM if italic else 1, caretSlopeRun=round(UPM * shear) if italic else 0,
    )
    family, style = spec["family"], spec["style"]
    ps_family = family.replace(" ", "")
    fb.setupNameTable({
        "copyright": COPYRIGHT,
        "familyName": family,
        "styleName": style,
        "uniqueFontIdentifier": f"{VERSION};{VENDOR};{ps_family}-{style}",
        "fullName": f"{family} {style}" if style != "Regular" else family,
        "version": f"Version {VERSION}",
        "psName": f"{ps_family}-{style}",
        "manufacturer": "Longitude contributors",
        "designer": "Longitude contributors",
        "description": spec.get("description", ""),
        "licenseDescription": LICENSE_DESC,
        "licenseInfoURL": LICENSE_URL,
    }, windows=True, mac=False)
    ymin = min((getattr(glyf_table[n], "yMin", 0) for n in order if glyf_table[n].numberOfContours), default=desc)
    ymax = max((getattr(glyf_table[n], "yMax", 0) for n in order if glyf_table[n].numberOfContours), default=asc)
    fs_selection = (0x01 if italic else 0x40) | 0x80  # italic or regular, USE_TYPO_METRICS
    fb.setupOS2(
        version=4, achVendID=VENDOR, usWeightClass=spec.get("weight", 400), usWidthClass=5,
        fsType=0, fsSelection=fs_selection,
        sTypoAscender=asc, sTypoDescender=desc, sTypoLineGap=0,
        usWinAscent=max(asc, int(math.ceil(ymax))), usWinDescent=max(-desc, int(math.ceil(-ymin))),
        sxHeight=spec.get("xHeight", spec["capHeight"]), sCapHeight=spec["capHeight"],
        ySubscriptXSize=650, ySubscriptYSize=600, ySubscriptYOffset=75,
        ySuperscriptXSize=650, ySuperscriptYSize=600, ySuperscriptYOffset=350,
        yStrikeoutSize=60, yStrikeoutPosition=330,
        usDefaultChar=0, usBreakChar=32, usMaxContext=2 if spec.get("kerning") else 0,
    )
    fb.setupPost(italicAngle=spec.get("italicAngle", 0), underlinePosition=-150, underlineThickness=60)
    head = fb.font["head"]
    head.fontRevision = float(VERSION)
    head.macStyle = 0x02 if italic else 0
    head.created = head.modified = 3875558400  # 2026-10-23, fixed so builds are reproducible
    if spec.get("kerning"):
        add_kerning(fb.font, spec["kerning"], set(order))
    return fb.font, report


def add_kerning(font, kerning, names):
    pairs = [(a, b, v) for (a, b), v in sorted(kerning.items()) if a in names and b in names]
    lines = "\n".join(f"  pos {a} {b} {v};" for a, b, v in pairs)
    fea = f"languagesystem DFLT dflt;\nlanguagesystem latn dflt;\nfeature kern {{\n{lines}\n}} kern;\n"
    addOpenTypeFeaturesFromString(font, fea)
    # A legacy 'kern' table as well, for renderers without GPOS (Pillow previews).
    kern = newTable("kern")
    kern.version = 0
    sub = KernTable_format_0()
    sub.version, sub.format, sub.coverage, sub.tupleIndex = 0, 0, 1, 0
    sub.kernTable = {(a, b): v for a, b, v in pairs}
    kern.kernTables = [sub]
    font["kern"] = kern


def save(font, stem):
    OUT_TMP.mkdir(parents=True, exist_ok=True)
    OUT_WEB.mkdir(parents=True, exist_ok=True)
    ttf = OUT_TMP / f"{stem}.ttf"
    font.recalcTimestamp = False  # keep head.modified fixed so builds are reproducible
    font.save(str(ttf))
    woff = TTFont(str(ttf), recalcTimestamp=False)
    woff.flavor = "woff2"
    dest = OUT_WEB / f"{stem}.woff2"
    woff.save(str(dest))
    return ttf, dest


# ---- validation -------------------------------------------------------------------

def _inside(pt, poly):
    x, y = pt
    hit = False
    for i in range(len(poly)):
        (x0, y0), (x1, y1) = poly[i - 1], poly[i]
        if (y0 > y) != (y1 > y) and x < x0 + (y - y0) * (x1 - x0) / (y1 - y0):
            hit = not hit
    return hit


def validate(path):
    """Contours are closed, non-degenerate and wound consistently: outer
    contours clockwise, holes counter-clockwise (TrueType), judged by nesting."""
    font = TTFont(str(path))
    glyf = font["glyf"]
    problems = []
    for name in font.getGlyphOrder():
        g = glyf[name]
        if g.numberOfContours <= 0:
            continue
        coords, ends, _ = g.getCoordinates(glyf)
        polys = []
        start = 0
        for end in ends:
            polys.append(list(coords[start:end + 1]))
            start = end + 1
        for i, poly in enumerate(polys):
            area = contour_area(poly)
            if len(poly) < 3 or abs(area) < 40:
                problems.append(f"{name}: degenerate contour ({len(poly)} points, area {area:.0f})")
                continue
            probe = min(poly)  # leftmost point lies on the contour's outside edge
            probe = (probe[0] - 0.01, probe[1] + 0.003)
            depth = sum(1 for j, other in enumerate(polys) if j != i and _inside(probe, other))
            if (depth % 2 == 0) != (area < 0):
                problems.append(f"{name}: contour {i} winds the wrong way (depth {depth})")
    cmap = font.getBestCmap()
    font.close()
    return problems, len(cmap)


# ---- Meridian ----------------------------------------------------------------------

def meridian_specs():
    import meridian as m

    glyphs = []
    for g in m.GLYPHS:
        glyphs.append((g.name, g.unicodes, glyph_outline(g), g.lsb, g.rsb, g.advance))
    base = {
        "glyphs": glyphs,
        "aliases": dict(m.ALIASES),
        "kerning": m.KERNING,
        "ascender": 900, "descender": -200, "capHeight": m.CAP, "xHeight": m.CAP,
        "weight": 400,
    }
    upright = dict(base, family="Longitude Meridian", style="Regular",
                   description="Heavy rounded caps for thumbnails. Made for Longitude.")
    slant = dict(base, family="Longitude Meridian Slant", style="Italic", italicAngle=-12,
                 description="Longitude Meridian sheared 12 degrees. Made for Longitude.")
    return [(upright, "LongitudeMeridian-Regular"), (slant, "LongitudeMeridianSlant-Italic")]


# ---- Gridline ----------------------------------------------------------------------

PIXEL = 100
GRID_ROWS_ABOVE = 7
DOT_RADIUS = 0.43  # of a pixel; leaves a small gap between dots


def parse_gridline(text):
    glyphs = []
    cur = None
    for raw in text.splitlines():
        line = raw.rstrip()
        if line.startswith("//"):
            continue
        if line.startswith("@") and (cur is None or len(line) > 1 and not set(line) <= set(".#")):
            if cur:
                glyphs.append(cur)
            key, *rest = line[1:].split(" ")
            if key.startswith("U+") and len(key) > 2:
                cp = int(key[2:], 16)
            elif key == "space":
                cp = 0x20
            else:
                cp = ord(key)
            cur = {"cp": cp, "rows": [], "width": int(rest[0]) if rest else None}
            continue
        if not line:
            if cur:
                glyphs.append(cur)
                cur = None
            continue
        if cur is None or not set(line) <= set(".#"):
            raise ValueError(f"gridline.txt: unexpected line {raw!r}")
        cur["rows"].append(line)
    if cur:
        glyphs.append(cur)
    return glyphs


def pixel_path(rows, dots, top=0):
    """rows[0] is grid row `top`; row 0 is the cap line, row 6 sits on the baseline."""
    parts = []
    for r, row in enumerate(rows):
        for c, ch in enumerate(row):
            if ch != "#":
                continue
            x0 = c * PIXEL
            y0 = (GRID_ROWS_ABOVE - 1 - (top + r)) * PIXEL
            if dots:
                shape = circle(x0 + PIXEL / 2, y0 + PIXEL / 2, PIXEL * DOT_RADIUS)
            else:
                shape = rect(x0, y0, x0 + PIXEL, y0 + PIXEL)
            parts.append(sk_path(shape))
    return union(parts)


# Accent marks for the pixel font, keyed by mark then glyph width. Two rows,
# drawn one row above lowercase letters (with a gap) and right on top of capitals.
PIXEL_MARKS = {
    "grave": {5: [".#...", "..#.."], 3: ["#..", ".#."]},
    "acute": {5: ["...#.", "..#.."], 3: ["..#", ".#."]},
    "circumflex": {5: ["..#..", ".#.#."], 3: [".#.", "#.#"]},
    "tilde": {5: [".#..#", "#.##."], 3: [".##", "##."]},
    "dieresis": {5: [".....", ".#.#."], 3: ["...", "#.#"]},
    "ring": {5: ["..#..", ".#.#."], 3: [".#.", "#.#"]},
}
PIXEL_ACCENTS = [
    ("A", "grave", 0xC0), ("A", "acute", 0xC1), ("A", "circumflex", 0xC2), ("A", "tilde", 0xC3),
    ("A", "dieresis", 0xC4), ("A", "ring", 0xC5), ("E", "grave", 0xC8), ("E", "acute", 0xC9),
    ("E", "circumflex", 0xCA), ("E", "dieresis", 0xCB), ("I", "grave", 0xCC), ("I", "acute", 0xCD),
    ("I", "circumflex", 0xCE), ("I", "dieresis", 0xCF), ("N", "tilde", 0xD1), ("O", "grave", 0xD2),
    ("O", "acute", 0xD3), ("O", "circumflex", 0xD4), ("O", "tilde", 0xD5), ("O", "dieresis", 0xD6),
    ("U", "grave", 0xD9), ("U", "acute", 0xDA), ("U", "circumflex", 0xDB), ("U", "dieresis", 0xDC),
    ("Y", "acute", 0xDD), ("Y", "dieresis", 0x178),
]
DOTLESS_I = ["...", "...", "##.", ".#.", ".#.", ".#.", "###"]


def compose_pixel_accents(by_cp):
    """Accented capitals and lowercase from the base bitmaps."""
    out = []
    for base, mark, cp in PIXEL_ACCENTS:
        for upper in (True, False):
            code = cp if upper else (0xFF if cp == 0x178 else cp + 0x20)
            if code in by_cp:
                continue
            rows = list(by_cp[ord(base if upper else base.lower())]["rows"])
            if not upper and base == "I":
                rows = DOTLESS_I
            width = max(len(r) for r in rows)
            acc = PIXEL_MARKS[mark].get(width)
            if acc is None:
                continue
            first = next(i for i, r in enumerate(rows) if "#" in r)
            gap = 0 if upper else 1
            acc_top = first - gap - len(acc)
            grid = {}
            for i, r in enumerate(rows):
                grid[i] = r.ljust(width, ".")
            for i, r in enumerate(acc):
                row = acc_top + i
                cur = grid.get(row, "." * width)
                grid[row] = "".join("#" if a == "#" or b == "#" else "." for a, b in zip(cur, r.ljust(width, ".")))
            lo = min(grid)
            merged = [grid.get(i, "." * width) for i in range(lo, max(grid) + 1)]
            out.append({"cp": code, "rows": merged, "top": lo, "width": None})
    # cedilla
    for base, code in (("C", 0xC7), ("c", 0xE7)):
        rows = list(by_cp[ord(base)]["rows"]) + ["..#..", ".##.."]
        out.append({"cp": code, "rows": rows, "top": 0, "width": None})
    return out


def gridline_specs():
    data = parse_gridline((HERE / "gridline.txt").read_text(encoding="utf-8"))
    by_cp = {}
    for item in data:
        if item["cp"] in by_cp:
            raise ValueError(f"gridline.txt: U+{item['cp']:04X} defined twice")
        by_cp[item["cp"]] = item
    data += compose_pixel_accents(by_cp)
    specs = []
    for dots, family, stem, desc in (
        (False, "Longitude Gridline", "LongitudeGridline-Regular", "A 5x7 pixel font with lowercase. Made for Longitude."),
        (True, "Longitude Gridline Dot", "LongitudeGridlineDot-Regular", "Longitude Gridline drawn with round dots. Made for Longitude."),
    ):
        glyphs = []
        for item in data:
            cols = max((len(r) for r in item["rows"]), default=0) or item["width"] or 3
            path = pixel_path(item["rows"], dots, item.get("top", 0))
            glyphs.append((glyph_name(item["cp"]), [item["cp"]], path, None, None, (cols + 1) * PIXEL))
        specs.append(({
            "family": family, "style": "Regular", "description": desc,
            "glyphs": glyphs,
            "aliases": {0xA0: "space", 0xAD: "hyphen"},
            "ascender": 900, "descender": -200, "capHeight": 700, "xHeight": 500, "weight": 400,
            "originX": PIXEL / 2,  # keep the grid: column 0 starts half a pixel in
        }, stem))
    return specs


# ---- licence -------------------------------------------------------------------------

OFL_TEXT = """Copyright {year} Longitude contributors

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
https://openfontlicense.org


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) and the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
"""

LICENSE_SLUGS = ["longitude-meridian", "longitude-meridian-slant", "longitude-gridline", "longitude-gridline-dot"]


def write_licences():
    OUT_LIC.mkdir(parents=True, exist_ok=True)
    for slug in LICENSE_SLUGS:
        (OUT_LIC / f"{slug}.txt").write_text(OFL_TEXT.format(year=YEAR), encoding="utf-8", newline="\n")


# ---- main ----------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Build the original Longitude fonts.")
    ap.add_argument("--specimen", action="store_true", help="render PNG specimens into tools/fonts/out/")
    args = ap.parse_args()
    failed = False
    built = []
    for spec, stem in meridian_specs() + gridline_specs():
        font, report = build_font(spec)
        ttf, woff2 = save(font, stem)
        problems, ncmap = validate(ttf)
        for line in report:
            print(f"  note {stem}: {line}")
        for line in problems:
            print(f"  PROBLEM {stem}: {line}")
            failed = True
        print(f"{stem:<34} {ncmap:4d} chars  {woff2.stat().st_size / 1024:6.1f} KB  -> {woff2.relative_to(ROOT)}")
        built.append(ttf)
    write_licences()
    if args.specimen:
        import specimen
        for ttf in built:
            print("specimen", specimen.render(ttf))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
