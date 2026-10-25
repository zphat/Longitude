"""Draws the desktop app's icons and installer images. Needs Pillow and numpy.

    python src-tauri/make_art.py

Writes src-tauri/icons/ (icon.ico with 16 to 256 px frames, 32x32.png,
128x128.png, 128x128@2x.png, icon.png) and src-tauri/installer/ (header.bmp
150 x 57 and sidebar.bmp 164 x 314, the sizes NSIS's Modern UI expects). The
mark is web/icons/icon.svg redrawn at each size, with thicker lines below
48 px so the globe and the lime meridian stay readable in the taskbar. The
wordmark uses Syne from tools/fonts/cache (python tools/fonts/fetch_fonts.py).
The outputs are committed; run this again only to change the art.
"""

from pathlib import Path
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
ICONS = HERE / "icons"
INSTALLER = HERE / "installer"
FONTS = ROOT / "tools" / "fonts" / "cache" / "ofl"

# Signal theme (web/css/tokens.css) and web/icons/icon.svg.
TOP = (0x18, 0x1D, 0x20)
BOTTOM = (0x09, 0x0B, 0x0D)
WORKSPACE = (0x07, 0x08, 0x0A)
PANEL = (0x11, 0x15, 0x17)
TEXT = (0xEE, 0xF1, 0xEC)
MUTED = (0xA8, 0xB3, 0xB3)
LIME = (0xD1, 0xFF, 0x4A)


def vertical(w, h, top, bottom):
    t = np.linspace(0.0, 1.0, h, dtype=np.float32)[:, None, None]
    a = np.array(top, np.float32)[None, None, :]
    b = np.array(bottom, np.float32)[None, None, :]
    rgb = np.broadcast_to(a + (b - a) * t, (h, w, 3))
    return Image.fromarray(np.round(rgb).astype(np.uint8), "RGB")


def glow(w, h, cx, cy, r, color, peak):
    """Radial falloff like the SVG's radialGradient: peak alpha at the center, 0 at r."""
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    d = np.sqrt((x - cx) ** 2 + (y - cy) ** 2) / r
    alpha = np.clip(1.0 - d, 0.0, 1.0) * peak * 255.0
    out = np.zeros((h, w, 4), np.uint8)
    out[..., 0], out[..., 1], out[..., 2] = color
    out[..., 3] = np.round(alpha).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def ring(draw, cx, cy, rx, ry, width, fill):
    draw.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], outline=fill, width=max(1, round(width)))


def draw_mark(layer, cx, cy, scale, px_scale):
    """The globe: equator, ring and lime meridian, in icon.svg units (globe r = 148).

    scale: canvas px per svg unit. px_scale: final px per svg unit, used to keep
    lines at least about 1.2 px wide in the finished image."""
    d = ImageDraw.Draw(layer)
    s = scale / px_scale  # canvas px per final px

    def w(units, min_px):
        return max(units * scale, min_px * s)

    eq = w(12, 1.0)
    d.line([cx - 144 * scale, cy, cx + 144 * scale, cy], fill=TEXT + (77,), width=round(eq))
    for x in (cx - 144 * scale, cx + 144 * scale):
        d.ellipse([x - eq / 2, cy - eq / 2, x + eq / 2, cy + eq / 2], fill=TEXT + (77,))
    gw = w(22, 1.4)
    ring(d, cx, cy, 148 * scale + gw / 2, 148 * scale + gw / 2, gw, TEXT + (255,))
    mw = w(26, 1.7)
    ring(d, cx, cy, 62 * scale + mw / 2, 146 * scale + mw / 2, mw, LIME + (255,))


def icon(size):
    ss = 8 if size <= 64 else 4
    big = size * ss
    k = big / 512
    out = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    mask = Image.new("L", (big, big), 0)
    radius = 112 * k if size >= 32 else 80 * k
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, big - 1, big - 1], radius=radius, fill=255)
    out.paste(vertical(big, big, TOP, BOTTOM), (0, 0), mask)
    if size >= 48:
        out.alpha_composite(glow(big, big, big / 2, big / 2, 210 * k, LIME, 0.13))
        edge = Image.new("RGBA", (big, big), (0, 0, 0, 0))
        ImageDraw.Draw(edge).rounded_rectangle([2 * k, 2 * k, big - 1 - 2 * k, big - 1 - 2 * k], radius=110 * k, outline=(255, 255, 255, 20), width=max(1, round(4 * k)))
        out.alpha_composite(edge)
    mark = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    # Small sizes: a slightly bigger globe fills the tile better.
    grow = 1.0 if size >= 48 else 1.12
    draw_mark(mark, big / 2, big / 2, k * grow, (size / 512) * grow)
    out.alpha_composite(mark)
    # Keep the tile's own corners: nothing may spill outside the rounded square.
    alpha = np.minimum(np.asarray(out.getchannel("A")), np.asarray(mask))
    out.putalpha(Image.fromarray(alpha))
    return out.resize((size, size), Image.LANCZOS)


def syne(px, weight=700):
    path = FONTS / "syne" / "Syne[wght].ttf"
    if not path.exists():
        sys.exit(f"Missing {path}. Run: python tools/fonts/fetch_fonts.py")
    f = ImageFont.truetype(str(path), px)
    f.set_variation_by_axes([weight])
    return f


def manrope(px, weight=600):
    path = FONTS / "manrope" / "Manrope[wght].ttf"
    if not path.exists():
        sys.exit(f"Missing {path}. Run: python tools/fonts/fetch_fonts.py")
    f = ImageFont.truetype(str(path), px)
    f.set_variation_by_axes([weight])
    return f


def text_at(img, xy, s, font, fill, tracking=0.0):
    """Draws text with optional letter spacing (in px) and returns its width."""
    d = ImageDraw.Draw(img)
    x, y = xy
    if not tracking:
        d.text((x, y), s, font=font, fill=fill)
        return d.textlength(s, font=font)
    start = x
    for ch in s:
        d.text((x, y), ch, font=font, fill=fill)
        x += d.textlength(ch, font=font) + tracking
    return x - start - tracking


def measure(s, font, tracking=0.0):
    d = ImageDraw.Draw(Image.new("L", (1, 1)))
    if not tracking:
        return d.textlength(s, font=font)
    return sum(d.textlength(ch, font=font) for ch in s) + tracking * (len(s) - 1)


def dots(img, step, color, alpha, offset=0):
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for y in range(offset, img.size[1], step):
        for x in range(offset, img.size[0], step):
            d.point((x, y), fill=color + (alpha,))
    img.alpha_composite(layer)


def header():
    """150 x 57, the top-left corner of every installer page."""
    ss = 4
    w, h = 150 * ss, 57 * ss
    img = vertical(w, h, PANEL, WORKSPACE).convert("RGBA")
    img.alpha_composite(glow(w, h, 27 * ss, h / 2, 42 * ss, LIME, 0.10))
    mark = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    scale = (15 * ss) / 160  # globe outer radius about 15 px
    draw_mark(mark, 27 * ss, h / 2, scale, scale / ss)
    img.alpha_composite(mark)
    font = syne(16 * ss)
    tracking = -0.2 * ss
    left = 50 * ss
    room = w - left - 6 * ss
    while measure("Longitude", font, tracking) > room:
        font = syne(font.size - ss)
    asc, desc = font.getmetrics()
    text_at(img, (left, h / 2 - (asc + desc) / 2 + 1 * ss), "Longitude", font, TEXT + (255,), tracking=tracking)
    return img.resize((150, 57), Image.LANCZOS).convert("RGB")


def sidebar():
    """164 x 314, the left side of the welcome and finish pages."""
    ss = 4
    w, h = 164 * ss, 314 * ss
    img = vertical(w, h, TOP, WORKSPACE).convert("RGBA")
    dots(img, 14 * ss, TEXT, 16, offset=7 * ss)
    cy = 112 * ss
    img.alpha_composite(glow(w, h, w / 2, cy, 92 * ss, LIME, 0.14))
    mark = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    scale = (46 * ss) / 160
    draw_mark(mark, w / 2, cy, scale, scale / ss)
    img.alpha_composite(mark)
    font = syne(24 * ss)
    tw = measure("Longitude", font, -0.4 * ss)
    text_at(img, ((w - tw) / 2, 186 * ss), "Longitude", font, TEXT + (255,), tracking=-0.4 * ss)
    cap = manrope(10 * ss, 600)
    line = "THUMBNAILS AND COVERS"
    cw = measure(line, cap, 0.8 * ss)
    text_at(img, ((w - cw) / 2, 222 * ss), line, cap, MUTED + (255,), tracking=0.8 * ss)
    d = ImageDraw.Draw(img)
    # The lime meridian again, as a short rule under the caption.
    d.rounded_rectangle([w / 2 - 14 * ss, 246 * ss, w / 2 + 14 * ss, 248 * ss], radius=1 * ss, fill=LIME + (255,))
    return img.resize((164, 314), Image.LANCZOS).convert("RGB")


def main():
    ICONS.mkdir(exist_ok=True)
    INSTALLER.mkdir(exist_ok=True)
    frames = {s: icon(s) for s in (16, 20, 24, 32, 40, 48, 64, 128, 256, 512)}
    frames[32].save(ICONS / "32x32.png")
    frames[128].save(ICONS / "128x128.png")
    frames[256].save(ICONS / "128x128@2x.png")
    frames[512].save(ICONS / "icon.png")
    ico_sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    frames[256].save(ICONS / "icon.ico", format="ICO", sizes=[(s, s) for s in ico_sizes], append_images=[frames[s] for s in ico_sizes if s != 256])
    header().save(INSTALLER / "header.bmp", format="BMP")
    sidebar().save(INSTALLER / "sidebar.bmp", format="BMP")
    print(f"Wrote {ICONS} and {INSTALLER}")


if __name__ == "__main__":
    main()
