"""Draws Longitude's app icons and installer images from the logo. Needs Pillow and numpy.

    python src-tauri/make_art.py

The logo is a matte black sphere with five lime lines of longitude that meet
at the poles. It comes from two files in brand/:

  longitude-logo-1024.png   the master, on a transparent background
  longitude-logo-small.svg  the same sphere drawn for small sizes: wider,
                            evenly spaced stripes and flatter shading

This writes:

  src-tauri/icons/      icon.ico (16 to 256 px frames), 32x32.png,
                        128x128.png, 128x128@2x.png (256 px), icon.png (512 px)
  src-tauri/installer/  header.bmp (150 x 57) and sidebar.bmp (164 x 314), the
                        sizes NSIS's Modern UI expects, 24-bit
  web/icons/            icon-192.png, icon-512.png, maskable-512.png (the
                        sphere inside the 80% safe zone of a workspace-colored
                        square), icon.svg (a copy of brand/longitude-logo.svg,
                        for the manifest) and favicon.svg (a copy of
                        brand/longitude-logo-small.svg, for the browser tab,
                        where the full logo's thin stripes turn to mud)

Sizes from 40 px up are the master, downscaled. The 32 px frame is the small
SVG, whose stripe edges fall on the 32 px pixel grid. The 16, 20 and 24 px
frames are the small SVG fitted to the pixel grid: the sphere is one pixel
narrower than the frame, so the center stripe can sit on a single pixel
column, and each stripe is 1 px wide on its own column at the equator.

The wordmark uses Syne from tools/fonts/cache (python tools/fonts/fetch_fonts.py).
The outputs are committed; run this again only to change the art.
"""

from pathlib import Path
import re
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
ICONS = HERE / "icons"
INSTALLER = HERE / "installer"
WEB_ICONS = ROOT / "web" / "icons"
BRAND = ROOT / "brand"
MASTER = BRAND / "longitude-logo-1024.png"
SMALL_SVG = BRAND / "longitude-logo-small.svg"
MAIN_SVG = BRAND / "longitude-logo.svg"
FONTS = ROOT / "tools" / "fonts" / "cache" / "ofl"

# Signal theme (web/css/tokens.css).
TOP = (0x18, 0x1D, 0x20)
WORKSPACE = (0x07, 0x08, 0x0A)
PANEL = (0x11, 0x15, 0x17)
TEXT = (0xEE, 0xF1, 0xEC)
MUTED = (0xA8, 0xB3, 0xB3)
LIME = (0xD1, 0xFF, 0x4A)

# The master's alpha inside the sphere is 252 to 254, not 255. Everything from
# this level up counts as opaque, so the icons are solid.
OPAQUE = 250

# The sphere's diameter as a share of the master's canvas (it has a small margin).
SPHERE_SHARE = 0.965

# The tiny frames, fitted to the pixel grid by hand: for each frame size, the
# pixel column of each 1 px stripe at the equator, left to right. The sphere
# is size - 1 px across, centered at (size - 1) / 2, so the columns are
# symmetric around the center stripe.
TINY = {
    16: (1, 4, 7, 10, 13),
    20: (2, 5, 9, 13, 16),
    24: (2, 6, 11, 16, 20),
}


# ---- the master ---------------------------------------------------------------


def load_master():
    if not MASTER.exists():
        sys.exit(f"Missing {MASTER}")
    img = Image.open(MASTER).convert("RGBA")
    if img.size != (1024, 1024):
        sys.exit(f"{MASTER} should be 1024 x 1024, not {img.size[0]} x {img.size[1]}")
    a = np.asarray(img).copy()
    alpha = a[..., 3].astype(np.float32) * 255.0 / OPAQUE
    a[..., 3] = np.clip(np.round(alpha), 0, 255).astype(np.uint8)
    return Image.fromarray(a, "RGBA")


def downscale(img, size):
    """Lanczos, clamped to the range of the box-filtered 3 x 3 neighborhood.

    Plain Lanczos leaves dark blue halos beside the thin lime stripes (it
    overshoots below black in the red and green channels); the clamp keeps
    its sharpness without them."""
    sharp = np.asarray(img.resize((size, size), Image.LANCZOS)).astype(np.int16)
    box = img.resize((size, size), Image.BOX)
    lo = np.asarray(box.filter(ImageFilter.MinFilter(3))).astype(np.int16)
    hi = np.asarray(box.filter(ImageFilter.MaxFilter(3))).astype(np.int16)
    return Image.fromarray(np.clip(sharp, lo, hi).astype(np.uint8), "RGBA")


def sphere(master, diameter):
    """The master scaled so the sphere is about `diameter` px across (canvas included)."""
    return downscale(master, max(1, round(diameter / SPHERE_SHARE)))


# ---- the small SVG -------------------------------------------------------------


def find(text, pattern, what):
    m = re.search(pattern, text, re.S)
    if not m:
        sys.exit(f"{SMALL_SVG.name}: could not find {what}; update read_small_svg() to match the file")
    return m


def stops(text, gradient_id):
    body = find(text, r'id="%s"[^>]*>(.*?)</(?:radial|linear)Gradient>' % gradient_id, f"gradient #{gradient_id}").group(1)
    found = re.findall(r'offset="([\d.]+)" stop-color="#([0-9a-fA-F]{6})"', body)
    return [(float(o), tuple(int(c[i : i + 2], 16) for i in (0, 2, 4))) for o, c in found]


def read_small_svg():
    """The sphere, its shading, the five stripes and the rim of longitude-logo-small.svg (512 viewBox).

    Each stripe is a closed shape of four cubic curves: top pole to one edge's
    equator, on to the bottom pole, up to the other edge's equator, back to
    the top pole."""
    text = SMALL_SVG.read_text(encoding="utf-8")
    shade = find(text, r'<radialGradient id="b"[^>]*cx="([-\d.]+)" cy="([-\d.]+)" r="([\d.]+)"', "the shading gradient")
    body = find(text, r'<circle cx="256" cy="256" r="([\d.]+)" fill="url\(#b\)"', "the sphere circle")
    rim = find(text, r'<circle cx="256" cy="256" r="([\d.]+)" fill="none" stroke="#fff" stroke-opacity="([\d.]+)" stroke-width="([\d.]+)"', "the rim circle")
    d = find(text, r'<path d="([^"]+)" fill="url\(#l\)"', "the stripes path").group(1)
    stripes = []
    for sub in re.findall(r"M[^M]+", d):
        nums = [float(n) for n in re.findall(r"-?\d*\.?\d+", sub)]
        pts = list(zip(nums[0::2], nums[1::2]))
        curves, p = [], pts[0]
        for i in range(1, len(pts), 3):
            curves.append((p, pts[i], pts[i + 1], pts[i + 2]))
            p = pts[i + 2]
        if len(curves) != 4:
            sys.exit(f"{SMALL_SVG.name}: each stripe should be four cubic curves")
        stripes.append(curves)
    if len(stripes) != 5:
        sys.exit(f"{SMALL_SVG.name}: expected five stripes, found {len(stripes)}")
    stripes.sort(key=lambda c: c[0][3][0] + c[2][3][0])
    ys = [y for s in stripes for c in s for _, y in c]
    return {
        "shade": (float(shade.group(1)), float(shade.group(2)), float(shade.group(3)), stops(text, "b")),
        "lime": stops(text, "l"),
        "r": float(body.group(1)),
        "rim": (float(rim.group(1)), float(rim.group(2)), float(rim.group(3))),
        "stripes": stripes,
        "top": min(ys),
        "bottom": max(ys),
    }


def ramp(stop_list, t):
    t = np.clip(t, 0.0, 1.0)
    offsets = np.array([s[0] for s in stop_list], np.float32)
    colors = np.array([s[1] for s in stop_list], np.float32)
    return np.stack([np.interp(t, offsets, colors[:, ch]) for ch in range(3)], -1)


def cubic(curve, n=64):
    t = np.linspace(0.0, 1.0, n)[:, None]
    p0, p1, p2, p3 = (np.array(p, np.float64) for p in curve)
    return (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t**2 * p2 + t**3 * p3


def small_logo(logo, size, ss=16):
    """The small SVG at `size` px; fitted to the pixel grid when TINY lists the size."""
    r = logo["r"]
    if size in TINY:
        diameter, center = size - 1, (size - 1) / 2
    else:
        diameter, center = size * 2 * r / 512, size / 2
    k = diameter / (2 * r)  # px per svg unit
    big = size * ss
    yy, xx = (np.mgrid[0:big, 0:big].astype(np.float32) + 0.5) / ss
    ux, uy = (xx - center) / k + 256, (yy - center) / k + 256  # svg units
    dist = np.hypot(ux - 256, uy - 256)
    body = (dist <= r).astype(np.float32)

    sx, sy, sr, shade_stops = logo["shade"]
    rgb = ramp(shade_stops, np.hypot(ux - sx, uy - sy) / sr)

    mask = Image.new("L", (big, big), 0)
    draw = ImageDraw.Draw(mask)
    for i, curves in enumerate(logo["stripes"]):
        edges = sorted((curves[0][3][0], curves[2][3][0]))
        outline = []
        for j, curve in enumerate(curves):
            pts = cubic(curve)
            stretch = 1.0
            if size in TINY:
                # Move this edge sideways so it meets the equator on a pixel boundary.
                xe = curves[0][3][0] if j < 2 else curves[2][3][0]
                target = TINY[size][i] + (0 if xe == edges[0] else 1)
                stretch = (target - center) / ((xe - 256) * k)
            px = ((pts[:, 0] - 256) * k * stretch + center) * ss
            py = ((pts[:, 1] - 256) * k + center) * ss
            outline += list(zip(px.tolist(), py.tolist()))
        draw.polygon(outline, fill=255)
    stripe = np.asarray(mask).astype(np.float32)[..., None] / 255.0
    lime = ramp(logo["lime"], (uy - logo["top"]) / (logo["bottom"] - logo["top"]))
    rgb = rgb * (1 - stripe) + lime * stripe

    rim_r, rim_opacity, rim_width = logo["rim"]
    ring = (np.abs(dist - rim_r) <= rim_width / 2).astype(np.float32)[..., None] * rim_opacity
    rgb = rgb * (1 - ring) + 255.0 * ring

    out = np.dstack([rgb, body[..., None] * 255.0])
    img = Image.fromarray(np.clip(np.round(out), 0, 255).astype(np.uint8), "RGBA")
    return img.resize((size, size), Image.BOX)


def icon(size, master, logo):
    if size <= 32:
        return small_logo(logo, size)
    return downscale(master, size)


# ---- installer art ----------------------------------------------------------


def vertical(w, h, top, bottom):
    t = np.linspace(0.0, 1.0, h, dtype=np.float32)[:, None, None]
    a = np.array(top, np.float32)[None, None, :]
    b = np.array(bottom, np.float32)[None, None, :]
    rgb = np.broadcast_to(a + (b - a) * t, (h, w, 3))
    return Image.fromarray(np.round(rgb).astype(np.uint8), "RGB")


def glow(w, h, cx, cy, r, color, peak):
    """Radial falloff: peak alpha at the center, 0 at r."""
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    d = np.sqrt((x - cx) ** 2 + (y - cy) ** 2) / r
    alpha = np.clip(1.0 - d, 0.0, 1.0) * peak * 255.0
    out = np.zeros((h, w, 4), np.uint8)
    out[..., 0], out[..., 1], out[..., 2] = color
    out[..., 3] = np.round(alpha).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


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


def place(img, mark, cx, cy):
    """Composites `mark` centered on (cx, cy), snapped to whole pixels."""
    img.alpha_composite(mark, (round(cx - mark.size[0] / 2), round(cy - mark.size[1] / 2)))


def header(master):
    """150 x 57, the top-left corner of every installer page."""
    ss = 4
    w, h = 150 * ss, 57 * ss
    img = vertical(w, h, PANEL, WORKSPACE).convert("RGBA")
    img.alpha_composite(glow(w, h, 27.5 * ss, h / 2, 40 * ss, LIME, 0.12))
    font = syne(16 * ss)
    tracking = -0.2 * ss
    left = 50 * ss
    room = w - left - 6 * ss
    while measure("Longitude", font, tracking) > room:
        font = syne(font.size - ss)
    asc, desc = font.getmetrics()
    text_at(img, (left, h / 2 - (asc + desc) / 2 + 1 * ss), "Longitude", font, TEXT + (255,), tracking=tracking)
    img = img.resize((150, 57), Image.LANCZOS)
    # The sphere goes on at full size, after the downscale, so it stays as sharp as the icons.
    place(img, sphere(master, 34), 27.5, 28.5)
    return img.convert("RGB")


def sidebar(master):
    """164 x 314, the left side of the welcome and finish pages."""
    ss = 4
    w, h = 164 * ss, 314 * ss
    img = vertical(w, h, TOP, WORKSPACE).convert("RGBA")
    dots(img, 14 * ss, TEXT, 16, offset=7 * ss)
    cy = 112
    img.alpha_composite(glow(w, h, w / 2, cy * ss, 96 * ss, LIME, 0.16))
    font = syne(24 * ss)
    tw = measure("Longitude", font, -0.4 * ss)
    text_at(img, ((w - tw) / 2, 186 * ss), "Longitude", font, TEXT + (255,), tracking=-0.4 * ss)
    cap = manrope(10 * ss, 600)
    line = "THUMBNAILS AND COVERS"
    cw = measure(line, cap, 0.8 * ss)
    text_at(img, ((w - cw) / 2, 222 * ss), line, cap, MUTED + (255,), tracking=0.8 * ss)
    d = ImageDraw.Draw(img)
    # A lime line of longitude, laid flat, as a short rule under the caption.
    d.rounded_rectangle([w / 2 - 14 * ss, 246 * ss, w / 2 + 14 * ss, 248 * ss], radius=1 * ss, fill=LIME + (255,))
    img = img.resize((164, 314), Image.LANCZOS)
    place(img, sphere(master, 96), 82, cy)
    return img.convert("RGB")


# ---- web icons ----------------------------------------------------------------


def maskable(master, size=512):
    """A full-bleed workspace-colored square with the sphere inside the 80% safe zone.

    Launchers crop maskable icons to their own shape (circle, squircle); only
    the centered circle 80% of the width across is sure to show."""
    img = Image.new("RGBA", (size, size), WORKSPACE + (255,))
    place(img, sphere(master, size * 0.78), size / 2, size / 2)
    return img


def main():
    master = load_master()
    logo = read_small_svg()
    for folder in (ICONS, INSTALLER, WEB_ICONS):
        folder.mkdir(exist_ok=True)

    frames = {s: icon(s, master, logo) for s in (16, 20, 24, 32, 40, 48, 64, 128, 256, 512)}
    frames[32].save(ICONS / "32x32.png", optimize=True)
    frames[128].save(ICONS / "128x128.png", optimize=True)
    frames[256].save(ICONS / "128x128@2x.png", optimize=True)
    frames[512].save(ICONS / "icon.png", optimize=True)
    ico_sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    frames[256].save(ICONS / "icon.ico", format="ICO", sizes=[(s, s) for s in ico_sizes], append_images=[frames[s] for s in ico_sizes if s != 256])

    header(master).save(INSTALLER / "header.bmp", format="BMP")
    sidebar(master).save(INSTALLER / "sidebar.bmp", format="BMP")

    downscale(master, 192).save(WEB_ICONS / "icon-192.png", optimize=True)
    frames[512].save(WEB_ICONS / "icon-512.png", optimize=True)
    maskable(master).save(WEB_ICONS / "maskable-512.png", optimize=True)
    (WEB_ICONS / "icon.svg").write_bytes(MAIN_SVG.read_bytes())
    (WEB_ICONS / "favicon.svg").write_bytes(SMALL_SVG.read_bytes())
    print(f"Wrote {ICONS}, {INSTALLER} and {WEB_ICONS}")


if __name__ == "__main__":
    main()
