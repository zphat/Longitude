"""Render a PNG specimen of a font file with Pillow (used by build_original.py).

    python tools/fonts/specimen.py tools/fonts/out/LongitudeMeridian-Regular.ttf
"""

import sys
from pathlib import Path

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent / "out"
BG, INK, MUTED, ACCENT = (11, 12, 11), (238, 241, 236), (130, 140, 135), (209, 255, 74)
LINES = ["IS THIS A SCAM?", "WAIT WHAT", "I TRIED IT", "DON'T BUY THIS", "Hello world, quick fox."]


def render(path, out=None):
    path = Path(path)
    font = TTFont(str(path))
    cmap = font.getBestCmap()
    # skip lowercase that only repeats the capitals (Meridian)
    chars = [c for c in sorted(cmap) if c > 0x20 and c != 0xA0 and not (0x61 <= c <= 0x7A and cmap[c] == cmap.get(c - 32))]
    font.close()
    W = 2000
    big = ImageFont.truetype(str(path), 120)
    cell = 150
    cols = W // cell
    rows = (len(chars) + cols - 1) // cols
    sample = ImageFont.truetype(str(path), 150)
    small = [ImageFont.truetype(str(path), s) for s in (48, 28, 16)]
    H = 60 + rows * cell + 40 + len(LINES[:4]) * 185 + 360 + 120
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    label = ImageFont.truetype("arial.ttf", 18) if Path("C:/Windows/Fonts/arial.ttf").exists() else None
    d.text((20, 18), path.stem, fill=MUTED, font=label)
    y0 = 60
    for i, c in enumerate(chars):
        x = (i % cols) * cell
        y = y0 + (i // cols) * cell
        d.rectangle([x + 4, y + 4, x + cell - 4, y + cell - 4], outline=(34, 38, 36))
        d.line([x + 4, y + 125, x + cell - 4, y + 125], fill=(40, 60, 30))
        d.text((x + cell / 2, y + 125), chr(c), font=big, fill=INK, anchor="ms")
    y = y0 + rows * cell + 30
    for line in LINES[:4]:
        d.text((40, y + 150), line, font=sample, fill=(255, 255, 255), anchor="ls", stroke_width=10, stroke_fill=(0, 0, 0))
        y += 185
    d.text((40, y + 60), "THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG 0123456789", font=small[0], fill=ACCENT, anchor="ls")
    d.text((40, y + 120), "Sphinx of black quartz, judge my vow! $49.99 & 100% (yes) @longitude #1", font=small[0], fill=INK, anchor="ls")
    d.text((40, y + 170), "AVATAR TAVERN LYNX WAVY FLY TO 'QUOTE' \u201cCURLY\u201d \u2018ONE\u2019 \u2192 \u2665 \u2605 \u00d7", font=small[1], fill=INK, anchor="ls")
    d.text((40, y + 210), "SMALL SIZE LEGIBILITY: I TRIED THE $5 PHONE FOR 30 DAYS", font=small[2], fill=INK, anchor="ls")
    d.text((40, y + 260), LINES[4], font=small[0], fill=INK, anchor="ls")
    out = Path(out) if out else OUT / f"{path.stem}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)
    return out


if __name__ == "__main__":
    for p in sys.argv[1:]:
        print(render(p))
