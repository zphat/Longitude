"""Skeleton strokes for monoline fonts.

A skeleton is a centre line made of straight lines and cubic curves. The build
strokes it with round caps and joins (skia-pathops), unions everything into
clean outlines and writes TrueType quadratic contours. Coordinates are font
units, y up.
"""

import math

# How square the corner curves are: 0.5523 draws a circular quarter arc,
# larger values push the curve towards the corner (a squircle).
K = 0.6


def lerp(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def split_cubic(p0, p1, p2, p3, t):
    a, b, c = lerp(p0, p1, t), lerp(p1, p2, t), lerp(p2, p3, t)
    d, e = lerp(a, b, t), lerp(b, c, t)
    f = lerp(d, e, t)
    return (p0, a, d, f), (f, e, c, p3)


def cut_segment(seg, t0, t1):
    if seg[0] == "L":
        return ("L", lerp(seg[1], seg[2], t0), lerp(seg[1], seg[2], t1))
    pts = seg[1:]
    if t1 < 1:
        pts, _ = split_cubic(*pts, t1)
    if t0 > 0:
        _, pts = split_cubic(*pts, t0 / t1 if t1 else 0)
    return ("C", *pts)


class Sk:
    """A skeleton path. Methods return self so shapes read like a pen."""

    def __init__(self, x, y):
        self.start = (x, y)
        self.segs = []
        self.closed = False

    @property
    def end(self):
        return self.segs[-1][-1] if self.segs else self.start

    def l(self, x, y):
        self.segs.append(("L", self.end, (x, y)))
        return self

    def c(self, cx, cy, x, y, k=K):
        """Corner curve: leave towards the corner (cx, cy), arrive at (x, y) coming from it."""
        p0, p3, cn = self.end, (x, y), (cx, cy)
        self.segs.append(("C", p0, lerp(p0, cn, k), lerp(p3, cn, k), p3))
        return self

    def cubic(self, x1, y1, x2, y2, x, y):
        self.segs.append(("C", self.end, (x1, y1), (x2, y2), (x, y)))
        return self

    def z(self):
        if self.end != self.start:
            self.l(*self.start)
        self.closed = True
        return self

    def trim(self, a, b):
        """Open sub-path between segment parameters a and b (index + t)."""
        n = len(self.segs)
        a, b = max(0.0, a), min(float(n), b)
        out = []
        i = int(math.floor(a))
        while i < n and i < b:
            t0 = a - i if i == math.floor(a) else 0.0
            t1 = b - i if b < i + 1 else 1.0
            if t1 > t0:
                out.append(cut_segment(self.segs[i], t0, t1))
            i += 1
        sk = Sk(*out[0][1])
        sk.segs = out
        return sk

    def map(self, fn):
        """New skeleton with every point passed through fn((x, y)) -> (x, y)."""
        sk = Sk(*fn(self.start))
        sk.segs = [(s[0], *[fn(p) for p in s[1:]]) for s in self.segs]
        sk.closed = self.closed
        return sk

    def point(self, u):
        i = min(int(u), len(self.segs) - 1)
        seg = cut_segment(self.segs[i], 0, max(1e-6, u - i))
        return seg[-1]


def rbox(x0, y0, x1, y1, rx, ry, k=K):
    """Closed rounded box starting at the bottom of the right side, running
    counter-clockwise. Segment indices: 0 right side, 1 top-right corner,
    2 top, 3 top-left corner, 4 left side, 5 bottom-left corner, 6 bottom,
    7 bottom-right corner. Zero-length sides are kept so indices stay stable."""
    s = Sk(x1, y0 + ry)
    s.l(x1, y1 - ry).c(x1, y1, x1 - rx, y1, k).l(x0 + rx, y1).c(x0, y1, x0, y1 - ry, k)
    s.l(x0, y0 + ry).c(x0, y0, x0 + rx, y0, k).l(x1 - rx, y0).c(x1, y0, x1, y0 + ry, k)
    s.closed = True
    return s


def circle(cx, cy, r, k=0.5523):
    return rbox(cx - r, cy - r, cx + r, cy + r, r, r, k)


def rect(x0, y0, x1, y1):
    return Sk(x0, y0).l(x1, y0).l(x1, y1).l(x0, y1).z()


class Glyph:
    """Strokes (centre lines with a width) and fills (closed areas)."""

    def __init__(self, name, unicodes, lsb, rsb, width=None):
        self.name = name
        self.unicodes = unicodes
        self.lsb = lsb
        self.rsb = rsb
        self.advance = width  # fixed advance (centres the ink) when set
        self.strokes = []
        self.fills = []

    def stroke(self, sk, width):
        self.strokes.append((sk, width))
        return sk

    def fill(self, sk):
        self.fills.append(sk)
        return sk
