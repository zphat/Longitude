"""Longitude Meridian: glyph skeletons.

Heavy, rounded, slightly condensed caps. Every glyph is a center line stroked
at S units with round caps and joins, so corners and terminals are all round.
Coordinates are font units: the skeleton runs from y=B to y=T so the stroked
caps sit on 0 and 700. Round letters overshoot by OS. x starts wherever is
convenient; the build places the ink using the side bearings.
"""

import math

from skeleton import K, Glyph, Sk, circle, rbox

S = 156            # stroke width (22% of cap height)
R = S / 2
CAP = 700
B, T = R, CAP - R  # skeleton baseline and cap line
OS = 12            # overshoot for round shapes
BAR = 362          # crossbar of E F H
RY = 196           # vertical radius of full-height rounds
DOT = 82           # radius of dots

# side bearings measured from the ink: straight stems, rounds, diagonals
SB_STRAIGHT, SB_ROUND, SB_DIAG = 40, 32, 14

GLYPHS = []
KERNING = {}
ALIASES = {}  # extra codepoints that reuse a glyph (lowercase -> caps, nbsp -> space)


def glyph(name, unicodes, lsb, rsb=None, width=None):
    def deco(fn):
        g = Glyph(name, unicodes if isinstance(unicodes, list) else [unicodes], lsb, lsb if rsb is None else rsb, width)
        fn(g)
        GLYPHS.append(g)
        return fn
    return deco


def st(g, sk, w=S):
    g.stroke(sk, w)


# ---- shared shapes ----------------------------------------------------------

def o_loop(w, x0=0):
    return rbox(x0, B - OS, x0 + w, T + OS, w / 2, RY)


def s_path(x0, y0, x1, y1, spine, top_inset=12, k=K):
    """S center line from the upper terminal to the lower one (untrimmed)."""
    wt = x1 - top_inset
    yt_mid = (y1 + spine) / 2
    yb_mid = (spine + y0) / 2
    xm_t = (x0 + wt) / 2
    xm_b = (x0 + x1) / 2
    s = Sk(wt, yt_mid)
    s.c(wt, y1, xm_t, y1, k).c(x0, y1, x0, yt_mid, k).c(x0, spine, xm_t, spine, k)
    s.c(x1, spine, x1, yb_mid, k).c(x1, y0, xm_b, y0, k).c(x0, y0, x0, yb_mid, k)
    return s


def teardrop(g, hx, hy, tx, ty, head=DOT, tip=24):
    """Comma-like mark: a round head tapering to a small round tip (the hull of two circles)."""
    g.fill(circle(hx, hy, head))
    g.fill(circle(tx, ty, tip))
    dx, dy = tx - hx, ty - hy
    dist = math.hypot(dx, dy)
    ux, uy = dx / dist, dy / dist
    s_ = (head - tip) / dist
    c_ = math.sqrt(1 - s_ * s_)
    quad = []
    for side in (1, -1):
        nx, ny = s_ * ux - side * c_ * uy, s_ * uy + side * c_ * ux
        quad.append(((hx + head * nx, hy + head * ny), (tx + tip * nx, ty + tip * ny)))
    (h1, t1), (h2, t2) = quad
    g.fill(Sk(*h1).l(*t1).l(*t2).l(*h2).z())


# ---- letters ----------------------------------------------------------------

@glyph("A", 0x41, SB_DIAG)
def _(g):
    w, f = 380, 64
    top_l, top_r = w / 2 - f / 2, w / 2 + f / 2
    st(g, Sk(0, B).l(top_l, T).l(top_r, T).l(w, B))
    y = 238
    x = top_l * (y - B) / (T - B)
    st(g, Sk(x, y).l(w - x, y))


@glyph("B", 0x42, SB_STRAIGHT, SB_ROUND)
def _(g):
    w, wy = 318, 360
    wt = w - 20
    rt, rb = (T - wy) / 2, (wy - B) / 2
    st(g, Sk(0, B).l(0, T))
    st(g, Sk(0, T).l(wt - rt, T).c(wt, T, wt, T - rt).c(wt, wy, wt - rt, wy).l(0, wy))
    st(g, Sk(0, wy).l(w - rb, wy).c(w, wy, w, wy - rb).c(w, B, w - rb, B).l(0, B))


@glyph("C", 0x43, SB_ROUND, SB_ROUND - 6)
def _(g):
    st(g, o_loop(334).trim(1.36, 7.64))


@glyph("D", 0x44, SB_STRAIGHT, SB_ROUND)
def _(g):
    w, rx = 338, 178
    st(g, Sk(0, B).l(0, T).l(w - rx, T).c(w, T, w, T - RY).l(w, B + RY).c(w, B, w - rx, B).z())


@glyph("E", 0x45, SB_STRAIGHT, SB_ROUND - 6)
def _(g):
    w = 270
    st(g, Sk(w, T).l(0, T).l(0, B).l(w, B))
    st(g, Sk(0, BAR).l(w - 26, BAR))


@glyph("F", 0x46, SB_STRAIGHT, SB_ROUND - 10)
def _(g):
    w = 266
    st(g, Sk(w, T).l(0, T).l(0, B))
    st(g, Sk(0, BAR - 10).l(w - 30, BAR - 10))


@glyph("G", 0x47, SB_ROUND, SB_STRAIGHT)
def _(g):
    w, gy = 342, 318
    sk = o_loop(w).trim(1.36, 8)
    sk.l(w, gy).l(w / 2 + 18, gy)
    st(g, sk)


@glyph("H", 0x48, SB_STRAIGHT)
def _(g):
    w = 316
    st(g, Sk(0, B).l(0, T))
    st(g, Sk(w, B).l(w, T))
    st(g, Sk(0, BAR).l(w, BAR))


@glyph("I", 0x49, SB_STRAIGHT)
def _(g):
    st(g, Sk(0, B).l(0, T))


@glyph("J", 0x4A, SB_ROUND - 8, SB_STRAIGHT)
def _(g):
    w, ry = 280, 172
    st(g, Sk(w, T).l(w, B - OS + ry).c(w, B - OS, w / 2, B - OS).c(0, B - OS, 0, B - OS + ry * 0.92))


@glyph("K", 0x4B, SB_STRAIGHT, SB_DIAG)
def _(g):
    w, jy = 322, 262
    st(g, Sk(0, B).l(0, T))
    st(g, Sk(w, T).l(0, jy))
    t = 0.40
    jx, jyy = w * t, jy + (T - jy) * t
    st(g, Sk(jx, jyy).l(w + 6, B))


@glyph("L", 0x4C, SB_STRAIGHT, SB_ROUND - 12)
def _(g):
    st(g, Sk(0, T).l(0, B).l(262, B))


@glyph("M", 0x4D, SB_STRAIGHT)
def _(g):
    w, vy = 444, 236
    st(g, Sk(0, B).l(0, T).l(w / 2, vy).l(w, T).l(w, B))


@glyph("N", 0x4E, SB_STRAIGHT)
def _(g):
    w = 330
    st(g, Sk(0, B).l(0, T).l(w, B).l(w, T))


@glyph("O", 0x4F, SB_ROUND)
def _(g):
    st(g, o_loop(352))


@glyph("P", 0x50, SB_STRAIGHT, SB_ROUND)
def _(g):
    w, py = 306, 318
    rp = (T - py) / 2
    st(g, Sk(0, B).l(0, T).l(w - rp, T).c(w, T, w, T - rp).c(w, py, w - rp, py).l(0, py))


@glyph("Q", 0x51, SB_ROUND)
def _(g):
    w = 352
    loop = o_loop(w)
    st(g, loop)
    x, y = loop.point(7.45)
    st(g, Sk(x, y).l(w + 34, B - 82))


@glyph("R", 0x52, SB_STRAIGHT, SB_DIAG + 4)
def _(g):
    w, py = 312, 330
    rp = (T - py) / 2
    st(g, Sk(0, B).l(0, T).l(w - rp, T).c(w, T, w, T - rp).c(w, py, w - rp, py).l(0, py))
    st(g, Sk(w * 0.44, py).l(w + 6, B))


@glyph("S", 0x53, SB_ROUND)
def _(g):
    st(g, s_path(0, B - OS, 316, T + OS, 368).trim(0.42, 5.6))


@glyph("T", 0x54, SB_DIAG + 4)
def _(g):
    w = 346
    st(g, Sk(0, T).l(w, T))
    st(g, Sk(w / 2, T).l(w / 2, B))


@glyph("U", 0x55, SB_STRAIGHT)
def _(g):
    w, ry = 318, 186
    st(g, Sk(0, T).l(0, B - OS + ry).c(0, B - OS, w / 2, B - OS).c(w, B - OS, w, B - OS + ry).l(w, T))


@glyph("V", 0x56, SB_DIAG)
def _(g):
    w, f = 376, 56
    st(g, Sk(0, T).l(w / 2 - f / 2, B).l(w / 2 + f / 2, B).l(w, T))


@glyph("W", 0x57, SB_DIAG)
def _(g):
    w, f, my = 590, 40, 470
    st(g, Sk(0, T).l(128 - f / 2, B).l(128 + f / 2, B).l(w / 2, my).l(w - 128 - f / 2, B).l(w - 128 + f / 2, B).l(w, T))


@glyph("X", 0x58, SB_DIAG)
def _(g):
    w = 360
    st(g, Sk(0, B).l(w, T))
    st(g, Sk(0, T).l(w, B))


@glyph("Y", 0x59, SB_DIAG)
def _(g):
    w, jy = 374, 300
    st(g, Sk(0, T).l(w / 2, jy).l(w, T))
    st(g, Sk(w / 2, jy).l(w / 2, B))


@glyph("Z", 0x5A, SB_ROUND - 4)
def _(g):
    w = 302
    st(g, Sk(0, T).l(w, T).l(0, B).l(w, B))


# ---- figures ----------------------------------------------------------------

@glyph("zero", 0x30, SB_ROUND)
def _(g):
    st(g, rbox(0, B - OS, 322, T + OS, 161, RY + 14))


@glyph("one", 0x31, SB_DIAG + 10, SB_STRAIGHT)
def _(g):
    w = 150
    st(g, Sk(0, T - 128).l(w, T).l(w, B))


@glyph("two", 0x32, SB_ROUND - 4)
def _(g):
    w, ry = 314, 150
    sk = Sk(0, T + OS - ry).c(0, T + OS, w / 2, T + OS).c(w, T + OS, w, T + OS - ry)
    sk.cubic(w, 380, 40, 300, 0, B).l(w + 6, B)
    st(g, sk.trim(0.38, 9))


@glyph("three", 0x33, SB_ROUND - 4)
def _(g):
    w, wy = 304, 376
    wt = w - 14
    rt, rb = (T + OS - wy) / 2, (wy - (B - OS)) / 2
    top = Sk(0, T + OS - rt).c(0, T + OS, wt / 2, T + OS).c(wt, T + OS, wt, T + OS - rt).c(wt, wy, wt / 2 - 20, wy)
    st(g, top.trim(0.40, 9))
    bot = Sk(wt / 2 - 20, wy).c(w, wy, w, wy - rb).c(w, B - OS, w / 2, B - OS).c(0, B - OS, 0, B - OS + rb)
    st(g, bot.trim(0, 2.60))


@glyph("four", 0x34, SB_DIAG + 6, SB_ROUND - 6)
def _(g):
    w, sx, by = 344, 252, 228
    st(g, Sk(sx - 52, T).l(0, by).l(w, by))
    st(g, Sk(sx, T - 120).l(sx, B))


@glyph("five", 0x35, SB_ROUND - 4)
def _(g):
    w, ty = 310, 408
    rb = (ty - (B - OS)) / 2
    st(g, Sk(w - 4, T).l(14, T).l(0, ty - 6))
    bowl = Sk(0, ty - 6).cubic(40, ty + 12, 90, ty + 14, w / 2, ty + 14)
    bowl.c(w, ty + 14, w, ty + 14 - rb).c(w, B - OS, w / 2, B - OS).c(0, B - OS, 0, B - OS + rb)
    st(g, bowl.trim(0, 3.62))


@glyph("six", 0x36, SB_ROUND)
def _(g):
    w, ty = 322, 418
    st(g, rbox(0, B - OS, w, ty, w / 2, (ty - (B - OS)) / 2))
    sk = Sk(0, 250).l(0, T + OS - 170).c(0, T + OS, w / 2, T + OS).c(w, T + OS, w, T + OS - 170)
    st(g, sk.trim(0, 2.36))


@glyph("seven", 0x37, SB_ROUND - 8, SB_ROUND - 4)
def _(g):
    w = 304
    st(g, Sk(0, T).l(w, T).l(96, B))


@glyph("eight", 0x38, SB_ROUND)
def _(g):
    w, wy = 324, 392
    st(g, rbox(14, wy - 12, w - 14, T + OS, (w - 28) / 2, (T + OS - wy + 12) / 2))
    st(g, rbox(0, B - OS, w, wy, w / 2, (wy - (B - OS)) / 2))


@glyph("nine", 0x39, SB_ROUND)
def _(g):
    w, ty = 322, 418
    flip = lambda p: (w - p[0], CAP - p[1])
    st(g, rbox(0, B - OS, w, ty, w / 2, (ty - (B - OS)) / 2).map(flip))
    sk = Sk(0, 250).l(0, T + OS - 170).c(0, T + OS, w / 2, T + OS).c(w, T + OS, w, T + OS - 170)
    st(g, sk.trim(0, 2.36).map(flip))


# ---- punctuation ------------------------------------------------------------

PUNCT_SB = 30
MID = 336  # optical middle of the caps (hyphen, plus, colon)


@glyph("space", 0x20, 0, 0, width=230)
def _(g):
    pass


@glyph("period", 0x2E, PUNCT_SB)
def _(g):
    g.fill(circle(0, DOT - 2, DOT))


COMMA_TAIL = (-44, -96)


@glyph("comma", 0x2C, PUNCT_SB)
def _(g):
    teardrop(g, 0, DOT - 2, *COMMA_TAIL)


@glyph("colon", 0x3A, PUNCT_SB)
def _(g):
    g.fill(circle(0, DOT - 2, DOT))
    g.fill(circle(0, 432, DOT))


@glyph("semicolon", 0x3B, PUNCT_SB)
def _(g):
    teardrop(g, 0, DOT - 2, *COMMA_TAIL)
    g.fill(circle(0, 432, DOT))


@glyph("exclam", 0x21, PUNCT_SB + 6)
def _(g):
    st(g, Sk(0, T).l(0, 290))
    g.fill(circle(0, DOT - 2, DOT))


@glyph("question", 0x3F, SB_ROUND - 6)
def _(g):
    w, ry = 286, 140
    sk = Sk(0, T + OS - ry).c(0, T + OS, w / 2, T + OS).c(w, T + OS, w, T + OS - ry)
    sk.c(w, 384, w / 2 + 16, 384).l(w / 2 + 2, 384).l(w / 2 + 2, 296)
    st(g, sk.trim(0.40, 9))
    g.fill(circle(w / 2 + 2, DOT - 2, DOT))


@glyph("quotesingle", 0x27, PUNCT_SB)
def _(g):
    st(g, Sk(0, T).l(0, T - 118))


@glyph("quotedbl", 0x22, PUNCT_SB)
def _(g):
    st(g, Sk(0, T).l(0, T - 118))
    st(g, Sk(200, T).l(200, T - 118))


QY = CAP - DOT  # head center of a closing quote


QL, QTIP = 172, 24  # quote length (head center to tip center) and tip radius


def quote_right(g, x):
    teardrop(g, x + 44, QY, x, QY - QL, tip=QTIP)


def quote_left(g, x):
    # the closing quote turned 180 degrees inside the same box
    cx = (x - QTIP + x + 44 + DOT) / 2
    cy = (QY - QL - QTIP + QY + DOT) / 2
    teardrop(g, 2 * cx - (x + 44), 2 * cy - QY, 2 * cx - x, 2 * cy - (QY - QL), tip=QTIP)


@glyph("quoteright", 0x2019, PUNCT_SB)
def _(g):
    quote_right(g, 0)


@glyph("quoteleft", 0x2018, PUNCT_SB)
def _(g):
    quote_left(g, 0)


@glyph("quotedblright", 0x201D, PUNCT_SB)
def _(g):
    quote_right(g, 0)
    quote_right(g, 200)


@glyph("quotedblleft", 0x201C, PUNCT_SB)
def _(g):
    quote_left(g, 0)
    quote_left(g, 200)


@glyph("hyphen", [0x2D, 0x2010, 0x2011, 0x2212], PUNCT_SB)
def _(g):
    st(g, Sk(0, MID).l(170, MID))


@glyph("endash", 0x2013, PUNCT_SB - 10)
def _(g):
    st(g, Sk(0, MID).l(360, MID))


@glyph("emdash", 0x2014, PUNCT_SB - 10)
def _(g):
    st(g, Sk(0, MID).l(760, MID))


@glyph("underscore", 0x5F, 10)
def _(g):
    st(g, Sk(0, -110).l(400, -110), 120)


@glyph("ellipsis", 0x2026, PUNCT_SB)
def _(g):
    for i in range(3):
        g.fill(circle(i * 214, DOT - 2, DOT))


@glyph("periodcentered", 0xB7, PUNCT_SB)
def _(g):
    g.fill(circle(0, MID + 10, DOT))


@glyph("bullet", 0x2022, PUNCT_SB + 10)
def _(g):
    g.fill(circle(0, MID + 10, 112))


@glyph("slash", 0x2F, SB_DIAG - 4)
def _(g):
    st(g, Sk(0, B - 40).l(262, T + 40))


@glyph("backslash", 0x5C, SB_DIAG - 4)
def _(g):
    st(g, Sk(262, B - 40).l(0, T + 40))


@glyph("bar", 0x7C, SB_STRAIGHT + 10)
def _(g):
    st(g, Sk(0, -100).l(0, T + 80), 120)


@glyph("parenleft", 0x28, SB_ROUND + 10, SB_ROUND - 6)
def _(g):
    w, top, bot = 112, T + 92, B - 104
    st(g, Sk(w, top).c(0, top, 0, (top + bot) / 2, 0.7).c(0, bot, w, bot, 0.7))


@glyph("parenright", 0x29, SB_ROUND - 6, SB_ROUND + 10)
def _(g):
    w, top, bot = 112, T + 92, B - 104
    st(g, Sk(0, top).c(w, top, w, (top + bot) / 2, 0.7).c(w, bot, 0, bot, 0.7))


@glyph("bracketleft", 0x5B, SB_STRAIGHT, SB_ROUND - 10)
def _(g):
    st(g, Sk(120, T + 92).l(0, T + 92).l(0, B - 104).l(120, B - 104))


@glyph("bracketright", 0x5D, SB_ROUND - 10, SB_STRAIGHT)
def _(g):
    st(g, Sk(0, T + 92).l(120, T + 92).l(120, B - 104).l(0, B - 104))


@glyph("plus", 0x2B, PUNCT_SB)
def _(g):
    h = 138
    st(g, Sk(0, MID).l(2 * h, MID))
    st(g, Sk(h, MID - h).l(h, MID + h))


@glyph("equal", 0x3D, PUNCT_SB)
def _(g):
    w = 140
    st(g, Sk(0, MID - 92).l(276, MID - 92), w - 20)
    st(g, Sk(0, MID + 92).l(276, MID + 92), w - 20)


@glyph("multiply", 0xD7, PUNCT_SB)
def _(g):
    h = 108
    st(g, Sk(0, MID - h).l(2 * h, MID + h), 132)
    st(g, Sk(0, MID + h).l(2 * h, MID - h), 132)


@glyph("less", 0x3C, PUNCT_SB)
def _(g):
    st(g, Sk(250, MID + 168).l(0, MID).l(250, MID - 168), 136)


@glyph("greater", 0x3E, PUNCT_SB)
def _(g):
    st(g, Sk(0, MID + 168).l(250, MID).l(0, MID - 168), 136)


@glyph("asterisk", 0x2A, PUNCT_SB)
def _(g):
    cx, cy, r = 0, 486, 120
    for a in (90, 30, 150):
        dx, dy = r * math.cos(math.radians(a)), r * math.sin(math.radians(a))
        st(g, Sk(cx - dx, cy - dy).l(cx + dx, cy + dy), 108)


@glyph("numbersign", 0x23, SB_DIAG)
def _(g):
    sw, slant = 116, 0.16
    for x in (130, 296):
        st(g, Sk(x - slant * 300, 60).l(x + slant * 300, 640), sw)
    for y in (244, 452):
        st(g, Sk(0, y).l(430, y), sw)


@glyph("dollar", 0x24, SB_ROUND)
def _(g):
    w, y0, y1 = 300, 140, 560
    st(g, s_path(0, y0, w, y1, 360, 10).trim(0.42, 5.6), 136)
    st(g, Sk(w / 2 - 6, y1 - 20).l(w / 2 - 6, y1 + 132), 112)
    st(g, Sk(w / 2 + 6, y0 + 20).l(w / 2 + 6, y0 - 132), 112)


@glyph("percent", 0x25, SB_ROUND - 4)
def _(g):
    sw = 112
    st(g, rbox(0, 384, 168, T + OS, 84, 120), sw)
    st(g, rbox(278, B - OS, 446, 316, 84, 120), sw)
    st(g, Sk(46, B - 10).l(400, T + 10), sw)


@glyph("ampersand", 0x26, SB_ROUND - 4, SB_DIAG)
def _(g):
    sk = Sk(462, B)
    sk.l(176, 430)
    sk.cubic(140, 474, 122, 506, 122, 548)
    sk.c(122, T + OS, 234, T + OS)
    sk.c(346, T + OS, 346, 548)
    sk.cubic(346, 482, 300, 448, 228, 410)
    sk.cubic(110, 346, 40, 300, 40, 214)
    sk.c(40, B - OS, 208, B - OS)
    sk.cubic(334, B - OS, 420, 140, 452, 300)
    st(g, sk, 126)


@glyph("at", 0x40, SB_ROUND - 4)
def _(g):
    sw, cx, cy = 104, 318, 330
    st(g, Sk(cx + 116, cy - 6).l(cx + 116, cy - 120).c(cx + 116, cy - 222, cx + 190, cy - 222, 0.62)
       .c(cx + 290, cy - 222, cx + 300, cy - 40, 0.62).c(cx + 300, cy + 330, cx, cy + 330, 0.62)
       .c(cx - 300, cy + 330, cx - 300, cy, 0.62).c(cx - 300, cy - 330, cx + 20, cy - 330, 0.62)
       .l(cx + 140, cy - 330), sw)
    st(g, rbox(cx - 118, cy - 128, cx + 116, cy + 128, 117, 128), sw)


@glyph("asciicircum", 0x5E, PUNCT_SB)
def _(g):
    st(g, Sk(0, 430).l(140, T).l(280, 430), 128)


@glyph("asciitilde", 0x7E, PUNCT_SB)
def _(g):
    st(g, Sk(0, MID - 40).cubic(50, MID + 90, 150, MID + 90, 200, MID).cubic(250, MID - 90, 350, MID - 90, 400, MID + 40), 130)


@glyph("grave", 0x60, PUNCT_SB)
def _(g):
    st(g, Sk(0, T + 30).l(110, T - 70), 120)


@glyph("braceleft", 0x7B, SB_ROUND + 6, SB_ROUND - 6)
def _(g):
    top, bot, m = T + 92, B - 104, (T + B) / 2 - 12
    sk = Sk(150, top).c(64, top, 64, top - 90, 0.62).l(64, m + 60).c(64, m, 0, m, 0.62)
    st(g, sk, 120)
    sk = Sk(150, bot).c(64, bot, 64, bot + 90, 0.62).l(64, m - 60).c(64, m, 0, m, 0.62)
    st(g, sk, 120)


@glyph("braceright", 0x7D, SB_ROUND - 6, SB_ROUND + 6)
def _(g):
    top, bot, m = T + 92, B - 104, (T + B) / 2 - 12
    sk = Sk(0, top).c(86, top, 86, top - 90, 0.62).l(86, m + 60).c(86, m, 150, m, 0.62)
    st(g, sk, 120)
    sk = Sk(0, bot).c(86, bot, 86, bot + 90, 0.62).l(86, m - 60).c(86, m, 150, m, 0.62)
    st(g, sk, 120)


# The inverted marks are turned and hang below the baseline, as Spanish setting expects.
@glyph("exclamdown", 0xA1, PUNCT_SB + 6)
def _(g):
    st(g, Sk(0, T).l(0, 290).map(lambda p: (p[0], CAP - p[1] - 130)))
    g.fill(circle(0, CAP - (DOT - 2) - 130, DOT))


@glyph("questiondown", 0xBF, SB_ROUND - 6)
def _(g):
    w, ry = 286, 140
    flip = lambda p: (w + 2 - p[0], CAP - p[1] - 130)
    sk = Sk(0, T + OS - ry).c(0, T + OS, w / 2, T + OS).c(w, T + OS, w, T + OS - ry)
    sk.c(w, 384, w / 2 + 16, 384).l(w / 2 + 2, 384).l(w / 2 + 2, 296)
    st(g, sk.trim(0.40, 9).map(flip))
    g.fill(circle(*flip((w / 2 + 2, DOT - 2)), DOT))


@glyph("degree", 0xB0, PUNCT_SB)
def _(g):
    st(g, circle(110, T - 70, 84), 96)


@glyph("arrowright", 0x2192, PUNCT_SB)
def _(g):
    st(g, Sk(0, MID).l(470, MID))
    st(g, Sk(300, MID + 170).l(470, MID).l(300, MID - 170))


@glyph("arrowleft", 0x2190, PUNCT_SB)
def _(g):
    st(g, Sk(470, MID).l(0, MID))
    st(g, Sk(170, MID + 170).l(0, MID).l(170, MID - 170))


@glyph("arrowup", 0x2191, PUNCT_SB)
def _(g):
    st(g, Sk(170, B - 20).l(170, T + 20))
    st(g, Sk(0, T - 150).l(170, T + 20).l(340, T - 150))


@glyph("arrowdown", 0x2193, PUNCT_SB)
def _(g):
    st(g, Sk(170, T + 20).l(170, B - 20))
    st(g, Sk(0, B + 150).l(170, B - 20).l(340, B + 150))


@glyph("heart", 0x2665, PUNCT_SB)
def _(g):
    sk = Sk(230, B + 10).cubic(150, 150, 0, 260, 0, 430).c(0, T, 115, T, 0.6).cubic(185, T, 220, 590, 230, 540)
    sk.cubic(240, 590, 275, T, 345, T).c(460, T, 460, 430, 0.6).cubic(460, 260, 310, 150, 230, B + 10)
    g.fill(sk.z())


@glyph("star", 0x2605, PUNCT_SB)
def _(g):
    cx, cy, ro, ri = 250, 350, 270, 118
    pts = []
    for i in range(10):
        a = math.radians(90 + i * 36)
        r = ro if i % 2 == 0 else ri
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    sk = Sk(*pts[0])
    for p in pts[1:]:
        sk.l(*p)
    g.fill(sk.z())
    st(g, sk, 56)  # rounds the points


# ---- currency, marks and maths ---------------------------------------------------

@glyph("sterling", 0xA3, SB_STRAIGHT - 10, SB_ROUND - 8)
def _(g):
    st(g, Sk(312, 520).c(312, T + OS, 212, T + OS).c(112, T + OS, 112, 520).l(112, B + 20))
    st(g, Sk(0, B).l(318, B))
    st(g, Sk(14, 336).l(232, 336), 128)


@glyph("Euro", 0x20AC, SB_ROUND - 30, SB_ROUND - 6)
def _(g):
    st(g, rbox(80, B - OS, 400, T + OS, 160, RY).trim(1.36, 7.64))
    st(g, Sk(0, 282).l(240, 282), 104)
    st(g, Sk(0, 430).l(240, 430), 104)


def ring_mark(g, cx):
    st(g, circle(cx, 350, 288), 96)


@glyph("copyright", 0xA9, SB_ROUND)
def _(g):
    cx = 336
    ring_mark(g, cx)
    st(g, rbox(cx - 112, 350 - 132, cx + 112, 350 + 132, 112, 112).trim(1.40, 7.60), 92)


@glyph("registered", 0xAE, SB_ROUND)
def _(g):
    cx = 336
    ring_mark(g, cx)
    x0, top, bot, wy = cx - 92, 350 + 132, 350 - 132, 352
    rb = (top - wy) / 2
    st(g, Sk(x0, bot).l(x0, top).l(cx + 40, top).c(cx + 40 + rb, top, cx + 40 + rb, top - rb).c(cx + 40 + rb, wy, cx + 40, wy).l(x0, wy), 92)
    st(g, Sk(cx + 10, wy).l(cx + 104, bot), 92)


@glyph("trademark", 0x2122, PUNCT_SB)
def _(g):
    sw, top, bot = 84, T + 2, 420
    st(g, Sk(0, top).l(200, top), sw)
    st(g, Sk(100, top).l(100, bot), sw)
    st(g, Sk(280, bot).l(280, top).l(380, 520).l(480, top).l(480, bot), sw)


@glyph("guillemotleft", 0xAB, PUNCT_SB)
def _(g):
    for x in (0, 196):
        st(g, Sk(x + 120, MID + 124).l(x, MID).l(x + 120, MID - 124), 112)


@glyph("guillemotright", 0xBB, PUNCT_SB)
def _(g):
    for x in (0, 196):
        st(g, Sk(x, MID + 124).l(x + 120, MID).l(x, MID - 124), 112)


@glyph("guilsinglleft", 0x2039, PUNCT_SB)
def _(g):
    st(g, Sk(120, MID + 124).l(0, MID).l(120, MID - 124), 112)


@glyph("guilsinglright", 0x203A, PUNCT_SB)
def _(g):
    st(g, Sk(0, MID + 124).l(120, MID).l(0, MID - 124), 112)


@glyph("plusminus", 0xB1, PUNCT_SB)
def _(g):
    h, cy = 112, MID + 92
    st(g, Sk(0, cy).l(2 * h, cy), 124)
    st(g, Sk(h, cy - h).l(h, cy + h), 124)
    st(g, Sk(0, 104).l(2 * h, 104), 124)


@glyph("divide", 0xF7, PUNCT_SB)
def _(g):
    st(g, Sk(0, MID).l(276, MID), 128)
    g.fill(circle(138, MID + 172, 70))
    g.fill(circle(138, MID - 172, 70))


# ---- accented capitals ----------------------------------------------------------
# Built from the base letter's skeleton plus a mark centered over its ink.

def _sk_points(sk):
    yield sk.start
    for seg in sk.segs:
        yield from seg[1:]


def _ink_center(g):
    xs = [p[0] for sk, _ in g.strokes for p in _sk_points(sk)] + [p[0] for sk in g.fills for p in _sk_points(sk)]
    return (min(xs) + max(xs)) / 2


ACC_W = 112  # stroke of the marks


def mark_acute(g, cx, _base):
    st(g, Sk(cx - 34, 790).l(cx + 40, 846), ACC_W)


def mark_grave(g, cx, _base):
    st(g, Sk(cx + 34, 790).l(cx - 40, 846), ACC_W)


def mark_circumflex(g, cx, _base):
    st(g, Sk(cx - 92, 786).l(cx, 846).l(cx + 92, 786), 100)


def mark_tilde(g, cx, _base):
    st(g, Sk(cx - 112, 790).cubic(cx - 80, 860, cx - 30, 852, cx, 820).cubic(cx + 30, 788, cx + 80, 780, cx + 112, 850), 96)


def mark_dieresis(g, cx, base):
    gap = 84 if base == "I" else 100
    g.fill(circle(cx - gap, 812, 62))
    g.fill(circle(cx + gap, 812, 62))


def mark_ring(g, cx, _base):
    st(g, circle(cx, 816, 50), 70)


def mark_cedilla(g, cx, _base):
    st(g, Sk(cx + 8, 30).l(cx + 8, -36).c(cx + 8, -112, cx - 62, -112), 92)


def mark_slash(g, cx, _base):
    st(g, Sk(cx - 196, B - 52).l(cx + 196, T + 52), 104)


MARKS = {
    "grave": (mark_grave, 0x300), "acute": (mark_acute, 0x301), "circumflex": (mark_circumflex, 0x302),
    "tilde": (mark_tilde, 0x303), "dieresis": (mark_dieresis, 0x308), "ring": (mark_ring, 0x30A),
    "cedilla": (mark_cedilla, 0x327), "slash": (mark_slash, None),
}

ACCENTED = [
    ("Agrave", 0xC0, "A", "grave"), ("Aacute", 0xC1, "A", "acute"), ("Acircumflex", 0xC2, "A", "circumflex"),
    ("Atilde", 0xC3, "A", "tilde"), ("Adieresis", 0xC4, "A", "dieresis"), ("Aring", 0xC5, "A", "ring"),
    ("Ccedilla", 0xC7, "C", "cedilla"),
    ("Egrave", 0xC8, "E", "grave"), ("Eacute", 0xC9, "E", "acute"), ("Ecircumflex", 0xCA, "E", "circumflex"),
    ("Edieresis", 0xCB, "E", "dieresis"),
    ("Igrave", 0xCC, "I", "grave"), ("Iacute", 0xCD, "I", "acute"), ("Icircumflex", 0xCE, "I", "circumflex"),
    ("Idieresis", 0xCF, "I", "dieresis"),
    ("Ntilde", 0xD1, "N", "tilde"),
    ("Ograve", 0xD2, "O", "grave"), ("Oacute", 0xD3, "O", "acute"), ("Ocircumflex", 0xD4, "O", "circumflex"),
    ("Otilde", 0xD5, "O", "tilde"), ("Odieresis", 0xD6, "O", "dieresis"), ("Oslash", 0xD8, "O", "slash"),
    ("Ugrave", 0xD9, "U", "grave"), ("Uacute", 0xDA, "U", "acute"), ("Ucircumflex", 0xDB, "U", "circumflex"),
    ("Udieresis", 0xDC, "U", "dieresis"),
    ("Yacute", 0xDD, "Y", "acute"), ("Ydieresis", 0x178, "Y", "dieresis"),
]
ACCENT_BASE = {}


def _accented():
    by_name = {g.name: g for g in GLYPHS}
    for name, cp, base, mark in ACCENTED:
        b = by_name[base]
        g = Glyph(name, [cp], b.lsb, b.rsb, b.advance)
        g.strokes = list(b.strokes)
        g.fills = list(b.fills)
        MARKS[mark][0](g, _ink_center(b), base)
        GLYPHS.append(g)
        ACCENT_BASE[name] = base
        lower = 0xFF if cp == 0x178 else cp + 0x20
        ALIASES[lower] = name


_accented()


# ---- aliases and kerning ----------------------------------------------------

for _c in range(26):
    ALIASES[0x61 + _c] = chr(0x41 + _c)
ALIASES[0xA0] = "space"
ALIASES[0xAD] = "hyphen"  # soft hyphen

KERN_PAIRS = """
A V -54  A W -40  A T -50  A Y -58  A quoteright -60  A quotedblright -60
V A -54  W A -40  T A -50  Y A -58
L T -66  L Y -66  L V -60  L W -44  L quoteright -90  L quotedblright -90
F A -40  P A -40  F period -80  F comma -80  P period -84  P comma -84
T period -84  T comma -84  Y period -80  Y comma -80  V period -70  V comma -70  W period -50  W comma -50
T O -14  O T -14  T C -14  T G -14  Y O -18  O Y -18  V O -12  O V -12
L O -18  K O -20  X O -16  O X -16  O A -14  A O -14  D A -18  A C -12  A G -12  A Q -12  A U -10
R V -14  R W -10  R Y -18  R T -14
quoteleft A -60  quotedblleft A -60
"""


def _kern():
    toks = KERN_PAIRS.split()
    for i in range(0, len(toks), 3):
        KERNING[(toks[i], toks[i + 1])] = int(toks[i + 2])
    # accented letters kern like their base letter
    family = {}
    for name, base in ACCENT_BASE.items():
        family.setdefault(base, []).append(name)
    for (a, b), v in list(KERNING.items()):
        for a2 in [a] + family.get(a, []):
            for b2 in [b] + family.get(b, []):
                KERNING.setdefault((a2, b2), v)


_kern()
