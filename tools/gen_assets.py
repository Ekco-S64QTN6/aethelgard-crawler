#!/usr/bin/env python3
"""Generate Aethelgard Crawler's original art and sound into assets/generated/.

Everything here is procedural (numpy noise + PIL drawing + additive synthesis),
so the game ships with art it owns. The optional classic pack
(tools/import_dhplus.py) is layered on top at runtime when present.

Usage: python3 -I tools/gen_assets.py
Deterministic: the same script always writes the same files.
"""
import json
import math
import os
import wave

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "assets", "generated")
T = 64  # texture size

rng_master = np.random.default_rng(1993)


# ── Noise helpers ────────────────────────────────────────────────────────────
def value_noise(size, cells, seed):
    """Tileable value noise in [0,1]."""
    r = np.random.default_rng(seed)
    g = r.random((cells, cells))
    lin = np.linspace(0, cells, size, endpoint=False)
    i0 = np.floor(lin).astype(int)
    f = lin - i0
    f = f * f * (3 - 2 * f)
    i1 = (i0 + 1) % cells
    a = g[np.ix_(i0, i0)]
    b = g[np.ix_(i0, i1)]
    c = g[np.ix_(i1, i0)]
    d = g[np.ix_(i1, i1)]
    fx = f[None, :]
    fy = f[:, None]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def fbm(size, seed, octaves=4, base=4):
    out = np.zeros((size, size))
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        out += amp * value_noise(size, base * 2 ** o, seed + o * 31)
        tot += amp
        amp *= 0.5
    return out / tot


def colorize(v, stops):
    """Map a [0,1] field through colour stops [(t,(r,g,b)),...]."""
    v = np.clip(v, 0, 1)
    out = np.zeros(v.shape + (3,))
    ts = [s[0] for s in stops]
    cols = np.array([s[1] for s in stops], float)
    for ch in range(3):
        out[..., ch] = np.interp(v, ts, cols[:, ch])
    return out


def to_img(rgb, alpha=None):
    rgb = np.clip(rgb, 0, 255).astype(np.uint8)
    if alpha is None:
        return Image.fromarray(rgb, "RGB")
    a = np.clip(alpha, 0, 255).astype(np.uint8)
    return Image.fromarray(np.dstack([rgb, a]), "RGBA")


def crack_mask(size, seed, n=3, length=40, wobble=0.6):
    r = np.random.default_rng(seed)
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    for _ in range(n):
        x, y = r.random() * size, r.random() * size
        ang = r.random() * math.tau
        for _ in range(int(length)):
            ang += (r.random() - 0.5) * wobble
            nx, ny = x + math.cos(ang) * 1.5, y + math.sin(ang) * 1.5
            d.line([(x % size, y % size), (nx % size, ny % size)], fill=255, width=1)
            x, y = nx, ny
            if r.random() < 0.04:  # branch
                bx, by, ba = x, y, ang + (r.random() - 0.5) * 2
                for _ in range(8):
                    nbx, nby = bx + math.cos(ba) * 1.5, by + math.sin(ba) * 1.5
                    d.line([(bx % size, by % size), (nbx % size, nby % size)], fill=160)
                    bx, by = nbx, nby
    return np.asarray(m, float) / 255


def bricks(size, rows, cols, mortar=1, offset=True):
    """Return (mortar_mask, brick_id) for a running-bond pattern."""
    yy, xx = np.mgrid[0:size, 0:size]
    bh = size / rows
    bw = size / cols
    row = (yy // bh).astype(int)
    shift = np.where((row % 2 == 1) & offset, bw / 2, 0)
    col = ((xx + shift) // bw).astype(int) % cols
    ly = yy - row * bh
    lx = (xx + shift) % bw
    m = (ly < mortar) | (lx < mortar)
    return m, row * 97 + col


def shade_bevel(height, strength=60):
    gy, gx = np.gradient(height)
    return (-gx - gy) * strength


# ── Wall / floor / ceiling textures per theme ────────────────────────────────
def tex_aeridor_wall():
    n = fbm(T, 11, 4, 4)
    m, bid = bricks(T, 4, 2, 1)
    tint = (np.vectorize(lambda b: (b * 2654435761 % 1000) / 1000)(bid) - 0.5) * 18
    base = colorize(n * 0.6 + 0.3, [(0, (160, 154, 144)), (0.5, (204, 199, 186)), (1, (226, 222, 212))])
    base += tint[..., None]
    vein = np.abs(fbm(T, 77, 3, 3) - 0.5) < 0.008
    base[vein] = base[vein] * 0.45 + np.array([196, 160, 72]) * 0.55
    cr = crack_mask(T, 5, 2, 30)
    base -= (cr * 55)[..., None]
    base[m] = (120, 112, 104)
    h = np.where(m, 0, 1.0) + n * 0.2
    base += shade_bevel(h, 40)[..., None]
    return to_img(base)


def tex_aeridor_floor():
    n = fbm(T, 21, 4, 4)
    m, bid = bricks(T, 2, 2, 1, offset=False)
    checker = ((bid % 2) == ((bid // 97) % 2))
    base = colorize(n, [(0, (128, 124, 118)), (1, (184, 180, 170))])
    base[checker] *= 0.8
    base -= (crack_mask(T, 9, 2, 40) * 45)[..., None]
    base[m] = (70, 66, 62)
    return to_img(base)


def tex_aeridor_ceil():
    n = fbm(T, 31, 4, 4)
    base = colorize(n, [(0, (84, 80, 76)), (1, (132, 128, 120))])
    yy, xx = np.mgrid[0:T, 0:T]
    ribs = ((xx % 32) < 2) | ((yy % 32) < 2)
    base[ribs] = base[ribs] * 0.5 + np.array([150, 124, 60]) * 0.5
    return to_img(base)


def tex_tunnels_wall():
    n = fbm(T, 41, 5, 4)
    base = colorize(n, [(0, (40, 34, 30)), (0.45, (92, 80, 68)), (0.75, (126, 112, 94)), (1, (150, 136, 116))])
    base += shade_bevel(n, 120)[..., None]
    wood = colorize(fbm(T, 43, 3, 8), [(0, (70, 44, 22)), (1, (120, 80, 42))])
    yy, xx = np.mgrid[0:T, 0:T]
    grain = (np.sin(yy * 0.9 + fbm(T, 44, 2, 4) * 6) * 12)[..., None]
    post = (xx < 8) | (xx >= T - 8)
    beam = yy < 9
    base[post] = (wood + grain)[post]
    base[beam] = (wood + np.sin(xx * 0.9)[..., None] * 10)[beam]
    base[(xx == 8) | (xx == T - 9)] *= 0.4
    base[yy == 9] *= 0.4
    return to_img(base)


def tex_tunnels_floor():
    n = fbm(T, 51, 5, 4)
    base = colorize(n, [(0, (36, 30, 24)), (1, (98, 84, 66))])
    pebbles = fbm(T, 52, 2, 16) > 0.68
    base[pebbles] += 25
    return to_img(base)


def tex_tunnels_ceil():
    n = fbm(T, 61, 5, 4)
    return to_img(colorize(n, [(0, (20, 16, 14)), (1, (66, 56, 46))]))


def draw_bone(d, x, y, length, ang, w, col):
    dx, dy = math.cos(ang) * length / 2, math.sin(ang) * length / 2
    d.line([(x - dx, y - dy), (x + dx, y + dy)], fill=col, width=w)
    for sx, sy in ((x - dx, y - dy), (x + dx, y + dy)):
        px, py = -math.sin(ang) * w * 0.55, math.cos(ang) * w * 0.55
        for k in (-1, 1):
            r = w * 0.65
            d.ellipse([sx + px * k - r, sy + py * k - r, sx + px * k + r, sy + py * k + r], fill=col)


def draw_skull(d, x, y, r, col, dark):
    d.ellipse([x - r, y - r, x + r, y + r * 0.9], fill=col)
    d.rectangle([x - r * 0.55, y + r * 0.5, x + r * 0.55, y + r * 1.2], fill=col)
    for k in (-1, 1):
        d.ellipse([x + k * r * 0.42 - r * 0.28, y - r * 0.05, x + k * r * 0.42 + r * 0.28, y + r * 0.45], fill=dark)
    d.polygon([(x, y + r * 0.45), (x - r * 0.12, y + r * 0.7), (x + r * 0.12, y + r * 0.7)], fill=dark)


def bone_pile(seed, size=T * 2, density=46, skulls=3, bg=(58, 48, 36)):
    r = np.random.default_rng(seed)
    im = Image.new("RGB", (size, size), bg)
    d = ImageDraw.Draw(im)
    for _ in range(density):
        c = int(170 + r.random() * 60)
        col = (c, int(c * 0.93), int(c * 0.78))
        draw_bone(d, r.random() * size, r.random() * size, 18 + r.random() * 34, r.random() * math.pi,
                  int(4 + r.random() * 4), col)
    for _ in range(skulls):
        c = int(200 + r.random() * 40)
        draw_skull(d, r.random() * size, r.random() * size, 9 + r.random() * 6,
                   (c, int(c * 0.94), int(c * 0.8)), (30, 22, 16))
    return im


def tex_bones_wall():
    im = bone_pile(71).resize((T, T), Image.LANCZOS)
    a = np.asarray(im, float)
    n = fbm(T, 72, 3, 4)
    a *= (0.75 + n * 0.4)[..., None]
    calc = fbm(T, 73, 4, 8) > 0.62  # calcified crust
    a[calc] = a[calc] * 0.5 + np.array([210, 200, 176]) * 0.5
    return to_img(a)


def tex_bones_floor():
    im = bone_pile(81, density=30, skulls=1, bg=(44, 36, 28)).resize((T, T), Image.LANCZOS)
    a = np.asarray(im, float) * 0.8
    return to_img(a)


def tex_bones_ceil():
    yy, xx = np.mgrid[0:T, 0:T]
    n = fbm(T, 91, 4, 4)
    base = colorize(n, [(0, (40, 32, 24)), (1, (120, 108, 88))])
    rib = (np.abs(((xx + yy * 0.2) % 16) - 8) < 2.2)
    base[rib] = colorize(n, [(0, (170, 158, 130)), (1, (226, 216, 190))])[rib]
    return to_img(base)


def tex_forge_wall():
    n = fbm(T, 101, 4, 6)
    base = colorize(n, [(0, (34, 32, 34)), (1, (88, 84, 86))])
    yy, xx = np.mgrid[0:T, 0:T]
    seam = ((xx % 32) < 2) | ((yy % 21) < 2)
    glow = colorize(fbm(T, 102, 2, 4), [(0, (180, 60, 10)), (1, (255, 170, 40))])
    base[seam] = glow[seam]
    rivet = (((xx % 32) - 5) ** 2 + ((yy % 21) - 5) ** 2 < 4) | (((xx % 32) - 27) ** 2 + ((yy % 21) - 5) ** 2 < 4)
    base[rivet] = (150, 140, 120)
    base += shade_bevel(n, 50)[..., None]
    return to_img(base)


def tex_forge_floor():
    yy, xx = np.mgrid[0:T, 0:T]
    n = fbm(T, 111, 4, 4)
    base = colorize(n, [(0, (30, 26, 24)), (1, (74, 66, 60))])
    grate = ((xx % 8) < 2) | ((yy % 8) < 2)
    base[grate] = (20, 18, 18)
    hot = (fbm(T, 112, 3, 4) > 0.66) & ~grate
    base[hot] = base[hot] * 0.4 + np.array([230, 90, 20]) * 0.6
    return to_img(base)


def tex_forge_ceil():
    n = fbm(T, 121, 4, 4)
    return to_img(colorize(n, [(0, (14, 10, 10)), (0.8, (60, 40, 30)), (1, (120, 60, 20))]))


def tex_deep_wall():
    n = fbm(T, 131, 5, 4)
    base = colorize(n, [(0, (8, 8, 14)), (0.6, (36, 34, 48)), (1, (60, 58, 76))])
    base += shade_bevel(n, 90)[..., None]
    vein = np.abs(fbm(T, 132, 4, 3) - 0.5) < 0.025
    base[vein] = (150, 70, 220)
    return to_img(base)


def tex_deep_floor():
    n = fbm(T, 141, 5, 4)
    base = colorize(n, [(0, (6, 6, 10)), (1, (44, 42, 56))])
    wet = fbm(T, 142, 3, 4) > 0.6
    base[wet] += 18
    return to_img(base)


def tex_deep_ceil():
    return to_img(colorize(fbm(T, 151, 5, 4), [(0, (2, 2, 4)), (1, (30, 28, 40))]))


def tex_heart_wall():
    n = fbm(T, 161, 5, 4)
    base = colorize(n, [(0, (40, 6, 10)), (0.5, (110, 26, 30)), (1, (170, 70, 64))])
    yy, xx = np.mgrid[0:T, 0:T]
    rib = np.abs(((xx + np.sin(yy / 9.0) * 4) % 21) - 10) < 2.5
    base[rib] = colorize(n, [(0, (170, 150, 120)), (1, (230, 214, 186))])[rib]
    vein = np.abs(fbm(T, 162, 4, 3) - 0.5) < 0.03
    base[vein] = (60, 200, 220)
    blight = fbm(T, 163, 2, 8) > 0.7
    base[blight] = (150, 170, 40)
    base += shade_bevel(n, 70)[..., None]
    return to_img(base)


def tex_heart_floor():
    n = fbm(T, 171, 5, 4)
    base = colorize(n, [(0, (30, 4, 8)), (1, (120, 40, 40))])
    blight = fbm(T, 172, 3, 8) > 0.64
    base[blight] = (110, 130, 30)
    return to_img(base)


def tex_heart_ceil():
    return to_img(colorize(fbm(T, 181, 5, 4), [(0, (16, 2, 4)), (1, (80, 20, 24))]))


# ── Doors, gates, stairs ─────────────────────────────────────────────────────
def door_wood():
    yy, xx = np.mgrid[0:T, 0:T]
    n = fbm(T, 201, 3, 8)
    base = colorize(n, [(0, (70, 42, 20)), (1, (132, 88, 46))])
    base += (np.sin(yy * 1.3 + n * 8) * 10)[..., None]
    plank = (xx % 16) == 0
    base[plank] *= 0.35
    band = ((yy > 10) & (yy < 15)) | ((yy > 48) & (yy < 53))
    base[band] = (58, 56, 60)
    stud = band & ((xx % 16) == 8)
    base[stud] = (160, 156, 150)
    edge = (xx < 2) | (xx > T - 3) | (yy < 2)
    base[edge] = (40, 30, 22)
    return to_img(base)


def door_iron():
    yy, xx = np.mgrid[0:T, 0:T]
    n = fbm(T, 211, 4, 6)
    base = colorize(n, [(0, (44, 46, 52)), (1, (104, 108, 116))])
    rust = fbm(T, 212, 3, 8) > 0.62
    base[rust] = base[rust] * 0.5 + np.array([120, 60, 30]) * 0.5
    frame = (xx < 4) | (xx > T - 5) | (yy < 4)
    base[frame] = (30, 30, 34)
    cross = (np.abs(xx - yy) < 2) | (np.abs(xx + yy - T) < 2)
    base[cross & ~frame] = (70, 72, 80)
    rivet = ((xx % 12) == 6) & ((yy % 12) == 6)
    base[rivet] = (180, 180, 190)
    return to_img(base)


def door_aeridor():
    im = to_img(colorize(fbm(T, 221, 4, 4), [(0, (200, 194, 180)), (1, (244, 240, 230))]))
    d = ImageDraw.Draw(im)
    d.rectangle([1, 1, T - 2, T - 2], outline=(196, 160, 72), width=2)
    d.line([(T // 2, 2), (T // 2, T - 2)], fill=(150, 140, 120))
    draw_triflame(d, T // 2, T // 2 - 2, 13, (196, 160, 72), 2)
    return im


def draw_triflame(d, cx, cy, r, col, w=2):
    """The Aeridorian three-flame seal: three interlocked spirals."""
    for k in range(3):
        a0 = k * math.tau / 3 - math.pi / 2
        ox, oy = cx + math.cos(a0) * r * 0.45, cy + math.sin(a0) * r * 0.45
        pts = []
        for i in range(40):
            t = i / 39
            ang = a0 + math.pi + t * math.tau * 1.15
            rr = r * 0.55 * (1 - t * 0.8)
            pts.append((ox + math.cos(ang) * rr, oy + math.sin(ang) * rr))
        d.line(pts, fill=col, width=w)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=col, width=1)


def portcullis():
    im = Image.new("RGBA", (T, T), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    for x in range(4, T, 10):
        d.rectangle([x, 0, x + 3, T - 1], fill=(64, 62, 66, 255))
        d.line([(x + 1, 0), (x + 1, T - 1)], fill=(120, 118, 124, 255))
        d.polygon([(x - 1, T - 6), (x + 4, T - 6), (x + 1.5, T - 1)], fill=(90, 88, 94, 255))
    for y in (8, 30, 52):
        d.rectangle([0, y, T - 1, y + 3], fill=(54, 52, 56, 255))
        d.line([(0, y + 1), (T - 1, y + 1)], fill=(110, 108, 114, 255))
    return im


def stairs_tex(down=True):
    im = Image.new("RGB", (T, T), (6, 6, 8))
    d = ImageDraw.Draw(im)
    steps = 7
    for i in range(steps):
        t = i / steps
        if down:
            y0 = int(T * 0.42 + t * T * 0.58)
            shade = int(40 + t * 120)
            inset = int((1 - t) * 18)
        else:
            y0 = int(T - (i + 1) * T / steps)
            shade = int(160 - t * 110)
            inset = int(t * 18)
        d.rectangle([inset, y0, T - 1 - inset, y0 + T // steps - 1], fill=(shade, shade - 8, shade - 16))
        d.line([(inset, y0), (T - 1 - inset, y0)], fill=(shade + 40, shade + 30, shade + 20))
    d.rectangle([0, 0, T - 1, T - 1], outline=(90, 84, 76), width=3)
    return im


# ── Wall decorations (RGBA overlays) ─────────────────────────────────────────
def deco_canvas():
    return Image.new("RGBA", (T, T), (0, 0, 0, 0))


def deco_button(on):
    im = deco_canvas()
    d = ImageDraw.Draw(im)
    d.rectangle([24, 26, 40, 42], fill=(60, 56, 52, 255), outline=(20, 18, 16, 255))
    col = (90, 220, 255, 255) if on else (150, 140, 120, 255)
    off = 2 if on else 0
    d.ellipse([27 + off, 29 + off, 37, 39], fill=col, outline=(30, 28, 26, 255))
    return im


def deco_lever(up):
    im = deco_canvas()
    d = ImageDraw.Draw(im)
    d.rectangle([26, 30, 38, 46], fill=(56, 54, 58, 255), outline=(16, 16, 18, 255))
    if up:
        d.line([(32, 38), (36, 14)], fill=(110, 80, 50, 255), width=4)
        d.ellipse([32, 9, 41, 18], fill=(150, 30, 30, 255))
    else:
        d.line([(32, 38), (36, 58)], fill=(110, 80, 50, 255), width=4)
        d.ellipse([32, 54, 41, 63], fill=(150, 30, 30, 255))
    d.ellipse([29, 35, 35, 41], fill=(150, 150, 160, 255))
    return im


def deco_keyhole():
    im = deco_canvas()
    d = ImageDraw.Draw(im)
    d.rectangle([24, 22, 40, 44], fill=(150, 120, 50, 255), outline=(60, 44, 16, 255))
    d.ellipse([29, 27, 35, 33], fill=(10, 8, 6, 255))
    d.polygon([(30, 31), (34, 31), (35, 40), (29, 40)], fill=(10, 8, 6, 255))
    return im


def deco_crystal(active=True, cracked=False):
    im = deco_canvas()
    d = ImageDraw.Draw(im)
    r = np.random.default_rng(301)
    base = (90, 230, 240) if active else (70, 90, 100)
    shards = [(32, 40, 10, 34), (22, 46, 7, 22), (42, 46, 7, 24), (28, 50, 5, 14), (38, 52, 5, 12)]
    if active:
        glow = Image.new("RGBA", (T, T), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow)
        gd.ellipse([8, 12, 56, 60], fill=(60, 220, 255, 110))
        glow = glow.filter(ImageFilter.GaussianBlur(7))
        im.alpha_composite(glow)
        d = ImageDraw.Draw(im)
    for cx, by, w, h in shards:
        pts = [(cx, by - h), (cx + w / 2, by - h * 0.7), (cx + w / 2, by), (cx - w / 2, by), (cx - w / 2, by - h * 0.7)]
        c = tuple(int(v * (0.8 + r.random() * 0.3)) for v in base) + (255,)
        d.polygon(pts, fill=c, outline=(20, 40, 50, 255))
        d.line([(cx, by - h), (cx, by)], fill=tuple(min(255, v + 60) for v in base) + (255,))
    if cracked:
        d.line([(26, 14), (32, 26), (29, 34), (36, 44)], fill=(255, 255, 255, 255), width=1)
        d.line([(40, 24), (35, 30)], fill=(255, 80, 200, 255), width=1)
    return im


def deco_seal(state):
    im = deco_canvas()
    d = ImageDraw.Draw(im)
    d.ellipse([12, 10, 52, 50], fill=(120, 112, 100, 255), outline=(60, 56, 50, 255), width=2)
    col = {"sealed": (196, 160, 72, 255), "awake": (120, 200, 255, 255), "spent": (70, 64, 56, 255)}[state]
    if state == "awake":
        glow = Image.new("RGBA", (T, T), (0, 0, 0, 0))
        ImageDraw.Draw(glow).ellipse([8, 6, 56, 54], fill=(100, 180, 255, 140))
        im.alpha_composite(glow.filter(ImageFilter.GaussianBlur(6)))
        d = ImageDraw.Draw(im)
    draw_triflame(d, 32, 30, 16, col, 2)
    # candle below
    d.rectangle([29, 52, 35, 60], fill=(220, 210, 180, 255))
    if state != "spent":
        d.ellipse([30, 46, 34, 52], fill=(255, 200, 80, 255))
    return im


def deco_inscription():
    im = deco_canvas()
    d = ImageDraw.Draw(im)
    r = np.random.default_rng(311)
    d.rectangle([10, 14, 54, 48], fill=(0, 0, 0, 60))
    for row in range(5):
        x = 13
        y = 18 + row * 6
        while x < 50:
            w = int(2 + r.random() * 5)
            d.line([(x, y), (x + w, y + (1 if r.random() < 0.3 else 0))], fill=(20, 16, 12, 230), width=2)
            x += w + 2
    return im


def deco_sconce():
    im = deco_canvas()
    d = ImageDraw.Draw(im)
    glow = Image.new("RGBA", (T, T), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([16, 2, 48, 34], fill=(255, 170, 60, 120))
    im.alpha_composite(glow.filter(ImageFilter.GaussianBlur(6)))
    d = ImageDraw.Draw(im)
    d.polygon([(26, 30), (38, 30), (35, 40), (29, 40)], fill=(60, 50, 40, 255))
    d.rectangle([30, 40, 34, 50], fill=(50, 40, 30, 255))
    d.polygon([(32, 12), (37, 24), (32, 30), (27, 24)], fill=(255, 190, 70, 255))
    d.polygon([(32, 18), (34, 25), (32, 28), (30, 25)], fill=(255, 250, 200, 255))
    return im


def floor_plate():
    im = Image.new("RGBA", (T, T), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle([14, 14, 50, 50], fill=(90, 86, 80, 255), outline=(30, 28, 26, 255), width=2)
    d.rectangle([18, 18, 46, 46], outline=(130, 124, 116, 255))
    return im


def floor_pit():
    im = Image.new("RGBA", (T, T), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.ellipse([6, 6, 58, 58], fill=(0, 0, 0, 255), outline=(40, 36, 32, 255), width=3)
    return im


# ── Sprites ──────────────────────────────────────────────────────────────────
S = 128  # draw size; downsampled to 64


def finish_sprite(im, outline=(10, 8, 8)):
    im = im.resize((64, 64), Image.LANCZOS)
    a = np.asarray(im).astype(float)
    alpha = a[..., 3]
    mask = alpha > 100
    a[..., 3] = np.where(mask, 255, 0)
    # one-pixel outline
    m = mask
    edge = np.zeros_like(m)
    edge[1:, :] |= m[:-1, :]
    edge[:-1, :] |= m[1:, :]
    edge[:, 1:] |= m[:, :-1]
    edge[:, :-1] |= m[:, 1:]
    edge &= ~m
    a[edge] = (*outline, 255)
    return Image.fromarray(a.astype(np.uint8), "RGBA")


def shaded_ellipse(d, box, col, light=1.0):
    x0, y0, x1, y1 = box
    d.ellipse(box, fill=col)
    hl = tuple(min(255, int(c * 1.35 * light)) for c in col)
    d.ellipse([x0 + (x1 - x0) * 0.2, y0 + (y1 - y0) * 0.12, x0 + (x1 - x0) * 0.5, y0 + (y1 - y0) * 0.4], fill=hl)


def eyes(d, pts, r, col=(255, 60, 40)):
    for x, y in pts:
        d.ellipse([x - r, y - r, x + r, y + r], fill=col)
        d.ellipse([x - r * 0.4, y - r * 0.4, x + r * 0.4, y + r * 0.4], fill=(255, 240, 200))


def spr_undead():
    im = Image.new("RGBA", (S, S))
    d = ImageDraw.Draw(im)
    robe = (60, 56, 70)
    d.polygon([(64, 40), (100, 124), (86, 118), (76, 126), (64, 116), (52, 126), (42, 118), (28, 124)], fill=robe)
    d.polygon([(64, 50), (84, 70), (78, 110), (50, 110), (44, 70)], fill=(40, 36, 48))
    for i in range(4):
        y = 66 + i * 9
        d.line([(50, y), (78, y)], fill=(214, 206, 180), width=4)
    d.line([(64, 60), (64, 104)], fill=(214, 206, 180), width=4)
    d.line([(44, 66), (18, 96)], fill=(214, 206, 180), width=6)
    d.line([(84, 66), (110, 92)], fill=(214, 206, 180), width=6)
    d.line([(110, 92), (118, 40)], fill=(150, 150, 160), width=4)
    draw_skull(d, 64, 34, 17, (226, 218, 192), (20, 10, 10))
    eyes(d, [(57, 36), (71, 36)], 3, (120, 255, 160))
    return finish_sprite(im)


def spr_construct():
    im = Image.new("RGBA", (S, S))
    d = ImageDraw.Draw(im)
    st = (150, 146, 136)
    d.rectangle([34, 40, 94, 100], fill=st)
    d.rectangle([44, 14, 84, 44], fill=(170, 166, 156))
    d.rectangle([14, 44, 34, 96], fill=(130, 126, 118))
    d.rectangle([94, 44, 114, 96], fill=(130, 126, 118))
    d.rectangle([40, 100, 58, 126], fill=(120, 116, 108))
    d.rectangle([70, 100, 88, 126], fill=(120, 116, 108))
    d.rectangle([50, 26, 78, 32], fill=(20, 20, 30))
    d.rectangle([54, 27, 74, 31], fill=(90, 230, 255))
    d.polygon([(64, 56), (76, 70), (64, 86), (52, 70)], fill=(90, 230, 255))
    d.polygon([(64, 62), (70, 70), (64, 80), (58, 70)], fill=(220, 255, 255))
    for x, y in ((38, 44), (90, 44), (38, 96), (90, 96)):
        d.ellipse([x - 3, y - 3, x + 3, y + 3], fill=(80, 76, 70))
    return finish_sprite(im)


def spr_beast():
    im = Image.new("RGBA", (S, S))
    d = ImageDraw.Draw(im)
    fur = (96, 80, 66)
    shaded_ellipse(d, [20, 52, 108, 104], fur)
    shaded_ellipse(d, [40, 26, 88, 74], (110, 92, 76))
    d.polygon([(44, 36), (40, 10), (56, 30)], fill=fur)
    d.polygon([(84, 36), (88, 10), (72, 30)], fill=fur)
    d.polygon([(50, 60), (78, 60), (64, 84)], fill=(80, 64, 52))
    for x in (30, 50, 78, 98):
        d.rectangle([x - 6, 94, x + 6, 124], fill=(80, 66, 54))
    eyes(d, [(54, 48), (74, 48)], 4, (255, 200, 40))
    d.line([(56, 76), (60, 82), (64, 76), (68, 82), (72, 76)], fill=(240, 240, 230), width=2)
    return finish_sprite(im)


def spr_ooze():
    im = Image.new("RGBA", (S, S))
    d = ImageDraw.Draw(im)
    col = (90, 170, 80)
    d.pieslice([10, 40, 118, 170], 180, 360, fill=col)
    d.rectangle([10, 104, 118, 126], fill=col)
    for x in (24, 50, 80, 104):
        d.ellipse([x - 10, 112, x + 10, 128], fill=col)
    d.ellipse([30, 54, 58, 74], fill=(170, 240, 150))
    eyes(d, [(52, 84), (78, 80)], 6, (250, 250, 120))
    return finish_sprite(im)


def spr_dragon():
    im = Image.new("RGBA", (S, S))
    d = ImageDraw.Draw(im)
    sc = (150, 50, 40)
    d.polygon([(64, 60), (6, 20), (20, 60), (4, 70), (40, 82)], fill=(110, 36, 30))
    d.polygon([(64, 60), (122, 20), (108, 60), (124, 70), (88, 82)], fill=(110, 36, 30))
    shaded_ellipse(d, [36, 56, 92, 120], sc)
    d.polygon([(52, 64), (76, 64), (72, 30), (56, 30)], fill=sc)
    shaded_ellipse(d, [46, 10, 82, 40], (170, 60, 46))
    d.polygon([(50, 16), (40, 0), (56, 12)], fill=(220, 210, 180))
    d.polygon([(78, 16), (88, 0), (72, 12)], fill=(220, 210, 180))
    d.polygon([(54, 34), (74, 34), (64, 48)], fill=(255, 150, 40))
    eyes(d, [(56, 22), (72, 22)], 3, (255, 230, 60))
    return finish_sprite(im)


def spr_elemental():
    im = Image.new("RGBA", (S, S))
    d = ImageDraw.Draw(im)
    for i, (w, col) in enumerate(((50, (220, 70, 20)), (36, (255, 150, 30)), (22, (255, 230, 120)))):
        pts = []
        for k in range(24):
            t = k / 23
            y = 124 - t * 116
            ww = w * math.sin(math.pi * (0.15 + t * 0.85)) * (1 - t * 0.5)
            pts.append((64 + ww + math.sin(t * 9 + i) * 8, y))
        for k in range(23, -1, -1):
            t = k / 23
            y = 124 - t * 116
            ww = w * math.sin(math.pi * (0.15 + t * 0.85)) * (1 - t * 0.5)
            pts.append((64 - ww + math.sin(t * 7 + i) * 8, y))
        d.polygon(pts, fill=col)
    eyes(d, [(56, 54), (72, 54)], 4, (40, 10, 0))
    return finish_sprite(im)


def spr_demon():
    im = Image.new("RGBA", (S, S))
    d = ImageDraw.Draw(im)
    sk = (140, 40, 50)
    d.polygon([(60, 50), (0, 14), (12, 60), (40, 80)], fill=(70, 20, 30))
    d.polygon([(68, 50), (128, 14), (116, 60), (88, 80)], fill=(70, 20, 30))
    shaded_ellipse(d, [38, 44, 90, 104], sk)
    d.rectangle([44, 100, 58, 126], fill=sk)
    d.rectangle([70, 100, 84, 126], fill=sk)
    shaded_ellipse(d, [46, 16, 82, 52], (160, 50, 60))
    d.polygon([(50, 24), (36, 2), (56, 18)], fill=(230, 220, 190))
    d.polygon([(78, 24), (92, 2), (72, 18)], fill=(230, 220, 190))
    eyes(d, [(57, 32), (71, 32)], 3, (255, 220, 40))
    d.line([(32, 60), (16, 100)], fill=sk, width=8)
    d.line([(96, 60), (112, 100)], fill=sk, width=8)
    return finish_sprite(im)


def spr_insect():
    im = Image.new("RGBA", (S, S))
    d = ImageDraw.Draw(im)
    ch = (60, 50, 44)
    for k in range(4):
        y = 64 + k * 10
        d.line([(50, y), (20 - k * 4, y - 20), (8, y + 30)], fill=ch, width=4)
        d.line([(78, y), (108 + k * 4, y - 20), (120, y + 30)], fill=ch, width=4)
    shaded_ellipse(d, [36, 66, 92, 118], (80, 66, 56))
    shaded_ellipse(d, [44, 40, 84, 76], (90, 74, 64))
    d.line([(58, 74), (52, 88)], fill=(220, 210, 180), width=3)
    d.line([(70, 74), (76, 88)], fill=(220, 210, 180), width=3)
    eyes(d, [(54, 54), (64, 50), (74, 54), (59, 62), (69, 62)], 3, (255, 40, 40))
    return finish_sprite(im)


def spr_plant():
    im = Image.new("RGBA", (S, S))
    d = ImageDraw.Draw(im)
    r = np.random.default_rng(401)
    for k in range(9):
        x0 = 64 + (r.random() - 0.5) * 40
        pts = [(x0, 126)]
        x, y = x0, 126
        for _ in range(8):
            x += (r.random() - 0.5) * 22
            y -= 12
            pts.append((x, y))
        d.line(pts, fill=(50, 90, 40), width=7)
        for px, py in pts[2::2]:
            d.polygon([(px, py), (px + 8, py - 3), (px + 2, py + 4)], fill=(170, 160, 120))
    shaded_ellipse(d, [34, 30, 94, 84], (70, 120, 50))
    d.pieslice([44, 44, 84, 80], 0, 180, fill=(80, 10, 20))
    for x in range(48, 82, 6):
        d.polygon([(x, 62), (x + 3, 70), (x + 6, 62)], fill=(240, 230, 200))
    eyes(d, [(54, 46), (74, 46)], 3, (220, 255, 60))
    return finish_sprite(im)


def spr_horror():
    im = Image.new("RGBA", (S, S))
    d = ImageDraw.Draw(im)
    r = np.random.default_rng(411)
    for k in range(7):
        x0 = 30 + k * 11
        pts = []
        for i in range(10):
            pts.append((x0 + math.sin(i * 0.8 + k) * 7, 70 + i * 6))
        d.line(pts, fill=(80, 40, 90), width=6)
    shaded_ellipse(d, [18, 14, 110, 96], (100, 56, 120))
    for _ in range(9):
        x, y = 30 + r.random() * 68, 26 + r.random() * 56
        rr = 3 + r.random() * 6
        d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=(240, 236, 220))
        d.ellipse([x - rr * 0.45, y - rr * 0.45, x + rr * 0.45, y + rr * 0.45], fill=(200, 30, 40))
    return finish_sprite(im)


def spr_giant():
    im = Image.new("RGBA", (S, S))
    d = ImageDraw.Draw(im)
    sk = (110, 120, 90)
    shaded_ellipse(d, [22, 34, 106, 104], sk)
    shaded_ellipse(d, [46, 6, 82, 42], (120, 130, 100))
    d.rectangle([34, 96, 56, 126], fill=(90, 98, 74))
    d.rectangle([72, 96, 94, 126], fill=(90, 98, 74))
    d.line([(24, 50), (8, 100)], fill=sk, width=14)
    d.line([(104, 50), (120, 96)], fill=sk, width=14)
    d.line([(120, 96), (108, 30)], fill=(90, 66, 40), width=8)
    d.ellipse([100, 18, 118, 40], fill=(100, 76, 46))
    eyes(d, [(58, 22), (70, 22)], 3, (255, 210, 60))
    d.rectangle([30, 74, 98, 86], fill=(80, 60, 40))
    return finish_sprite(im)


def spr_humanoid():
    im = Image.new("RGBA", (S, S))
    d = ImageDraw.Draw(im)
    cl = (70, 60, 80)
    d.polygon([(64, 24), (98, 124), (30, 124)], fill=cl)
    d.polygon([(64, 30), (86, 120), (42, 120)], fill=(54, 46, 62))
    d.ellipse([48, 14, 80, 46], fill=cl)
    d.ellipse([54, 22, 74, 42], fill=(20, 16, 22))
    eyes(d, [(59, 32), (69, 32)], 2.5, (255, 200, 120))
    d.line([(88, 70), (116, 30)], fill=(190, 196, 210), width=4)
    d.line([(84, 76), (94, 66)], fill=(120, 90, 50), width=6)
    return finish_sprite(im)


def spr_chest(opened):
    im = Image.new("RGBA", (S, S))
    d = ImageDraw.Draw(im)
    wood = (120, 78, 38)
    d.rectangle([24, 70, 104, 116], fill=wood, outline=(50, 30, 14), width=3)
    if opened:
        d.polygon([(24, 70), (104, 70), (96, 40), (32, 40)], fill=(90, 58, 28))
        d.rectangle([30, 66, 98, 74], fill=(255, 210, 80))
    else:
        d.rectangle([24, 52, 104, 74], fill=(140, 92, 46), outline=(50, 30, 14), width=3)
        d.rectangle([58, 64, 70, 80], fill=(210, 180, 80))
    d.rectangle([24, 92, 104, 98], fill=(70, 70, 76))
    return finish_sprite(im)


def item_icon(kind):
    im = Image.new("RGBA", (S, S))
    d = ImageDraw.Draw(im)
    if kind == "weapon":
        d.polygon([(30, 98), (94, 24), (104, 24), (104, 34), (40, 108)], fill=(200, 206, 220))
        d.line([(34, 80), (58, 104)], fill=(150, 120, 60), width=8)
        d.line([(22, 116), (40, 98)], fill=(100, 70, 40), width=9)
    elif kind == "bow":
        d.arc([30, 14, 110, 114], 100, 260, fill=(130, 90, 50), width=8)
        d.line([(58, 20), (58, 108)], fill=(220, 220, 210), width=2)
        d.line([(40, 64), (112, 64)], fill=(150, 120, 80), width=3)
        d.polygon([(112, 64), (100, 58), (100, 70)], fill=(200, 200, 210))
    elif kind == "staff":
        d.line([(34, 118), (86, 22)], fill=(120, 84, 48), width=8)
        d.ellipse([76, 8, 104, 36], fill=(90, 220, 255))
    elif kind == "armor":
        d.polygon([(34, 26), (94, 26), (110, 46), (98, 54), (96, 112), (32, 112), (30, 54), (18, 46)], fill=(140, 144, 156))
        d.line([(64, 30), (64, 108)], fill=(90, 92, 104), width=3)
    elif kind == "head":
        d.pieslice([24, 24, 104, 110], 180, 360, fill=(150, 154, 166))
        d.rectangle([24, 66, 104, 80], fill=(120, 124, 136))
        d.rectangle([58, 66, 70, 100], fill=(120, 124, 136))
    elif kind == "boots":
        d.polygon([(30, 20), (62, 20), (62, 90), (104, 96), (104, 116), (30, 116)], fill=(110, 76, 44))
        d.rectangle([30, 104, 104, 116], fill=(60, 40, 24))
    elif kind == "accessory":
        d.ellipse([28, 36, 100, 108], outline=(220, 190, 80), width=10)
        d.polygon([(64, 18), (80, 38), (64, 54), (48, 38)], fill=(90, 220, 255))
    elif kind in ("potion", "ether", "elixir"):
        col = {"potion": (220, 40, 50), "ether": (60, 120, 255), "elixir": (240, 200, 60)}[kind]
        d.rectangle([54, 14, 74, 40], fill=(200, 210, 220))
        d.rectangle([52, 8, 76, 18], fill=(120, 80, 40))
        d.ellipse([28, 34, 100, 116], fill=(200, 210, 220))
        d.ellipse([34, 54, 94, 112], fill=col)
        d.ellipse([44, 60, 60, 74], fill=(255, 255, 255))
    elif kind == "herb":
        d.line([(64, 120), (64, 40)], fill=(60, 110, 40), width=5)
        for k, (x, y) in enumerate(((44, 60), (84, 52), (40, 90), (88, 84), (64, 30))):
            d.ellipse([x - 14, y - 9, x + 14, y + 9], fill=(70 + k * 15, 150, 60))
    elif kind == "gem":
        d.polygon([(64, 20), (100, 50), (64, 110), (28, 50)], fill=(220, 60, 120))
        d.polygon([(64, 20), (82, 50), (64, 110), (46, 50)], fill=(255, 130, 180))
        d.line([(28, 50), (100, 50)], fill=(255, 220, 240), width=2)
    elif kind == "key":
        d.ellipse([16, 40, 56, 80], outline=(220, 190, 80), width=10)
        d.line([(54, 60), (116, 60)], fill=(220, 190, 80), width=10)
        d.rectangle([92, 60, 100, 82], fill=(220, 190, 80))
        d.rectangle([106, 60, 114, 76], fill=(220, 190, 80))
    elif kind == "page":
        d.polygon([(30, 16), (98, 16), (98, 112), (30, 112)], fill=(220, 206, 170))
        for y in range(30, 104, 12):
            d.line([(40, y), (88, y)], fill=(90, 70, 50), width=3)
        draw_triflame(d, 64, 96, 9, (150, 110, 40), 2)
    elif kind == "shard":
        d.polygon([(64, 10), (88, 50), (74, 118), (50, 118), (40, 50)], fill=(80, 220, 240))
        d.line([(64, 10), (60, 118)], fill=(220, 255, 255), width=3)
    elif kind == "torch":
        d.line([(64, 120), (64, 50)], fill=(110, 76, 40), width=10)
        d.polygon([(64, 10), (82, 46), (64, 60), (46, 46)], fill=(255, 170, 40))
    elif kind == "coin":
        d.ellipse([28, 28, 100, 100], fill=(220, 180, 60), outline=(150, 110, 30), width=4)
        draw_triflame(d, 64, 64, 18, (150, 110, 30), 2)
    else:  # bag / misc
        d.ellipse([24, 40, 104, 120], fill=(130, 100, 64))
        d.polygon([(48, 44), (80, 44), (72, 20), (56, 20)], fill=(110, 84, 54))
        d.line([(48, 44), (80, 44)], fill=(60, 40, 20), width=4)
    return finish_sprite(im)


# ── Portraits ────────────────────────────────────────────────────────────────
SKINS = {"Human": [(224, 180, 150), (180, 130, 96), (120, 82, 56)], "Elf": [(236, 210, 186), (210, 186, 160)],
         "Silvani": [(120, 170, 130), (150, 140, 110), (110, 150, 160)], "Dwarf": [(214, 160, 130), (170, 116, 86)],
         "Glimmerkin": [(240, 196, 160), (200, 150, 110)], "Veiled": [(232, 232, 240), (214, 218, 230)]}
HAIR = [(40, 28, 20), (110, 70, 30), (200, 170, 100), (160, 50, 30), (30, 30, 34), (220, 220, 230)]


def portrait(race, idx, seed):
    r = np.random.default_rng(seed)
    P = 96
    im = Image.new("RGB", (P, P), (0, 0, 0))
    d = ImageDraw.Draw(im)
    bg = tuple(int(v) for v in r.integers(20, 60, 3))
    for y in range(P):
        k = y / P
        d.line([(0, y), (P, y)], fill=tuple(int(c * (1.2 - k * 0.6)) for c in bg))
    skin = SKINS[race][idx % len(SKINS[race])]
    hair = (220, 222, 235) if race == "Veiled" else HAIR[int(r.integers(len(HAIR)))]
    cloth = tuple(int(v) for v in r.integers(40, 160, 3))
    d.pieslice([8, 70, 88, 140], 180, 360, fill=cloth)
    d.rectangle([40, 58, 56, 76], fill=tuple(int(c * 0.85) for c in skin))
    face_w = 30 if race in ("Elf", "Silvani", "Veiled") else 34
    if race == "Dwarf":
        face_w = 38
    if race == "Glimmerkin":
        face_w = 32
    d.ellipse([48 - face_w // 2 - 2, 18, 48 + face_w // 2 + 2, 70], fill=skin)
    if race in ("Elf", "Silvani", "Veiled"):
        d.polygon([(48 - face_w // 2, 40), (48 - face_w // 2 - 12, 26), (48 - face_w // 2 + 2, 48)], fill=skin)
        d.polygon([(48 + face_w // 2, 40), (48 + face_w // 2 + 12, 26), (48 + face_w // 2 - 2, 48)], fill=skin)
    style = int(r.integers(3))
    if style == 0:
        d.pieslice([48 - face_w // 2 - 6, 10, 48 + face_w // 2 + 6, 54], 180, 360, fill=hair)
    elif style == 1:
        d.pieslice([48 - face_w // 2 - 8, 10, 48 + face_w // 2 + 8, 60], 180, 360, fill=hair)
        d.rectangle([48 - face_w // 2 - 8, 32, 48 - face_w // 2, 80], fill=hair)
        d.rectangle([48 + face_w // 2, 32, 48 + face_w // 2 + 8, 80], fill=hair)
    else:
        d.pieslice([48 - face_w // 2 - 4, 12, 48 + face_w // 2 + 4, 44], 180, 360, fill=hair)
    if race == "Dwarf" or (race == "Human" and r.random() < 0.35):
        d.pieslice([48 - face_w // 2, 40, 48 + face_w // 2, 92], 0, 180, fill=hair)
    eye = (90, 200, 220) if race == "Veiled" else (40, 30, 20)
    for k in (-1, 1):
        d.ellipse([48 + k * 8 - 3, 38, 48 + k * 8 + 3, 43], fill=(240, 240, 240))
        d.ellipse([48 + k * 8 - 1.5, 39, 48 + k * 8 + 1.5, 42.5], fill=eye)
        d.line([(48 + k * 8 - 4, 34), (48 + k * 8 + 4, 34 - k * 0)], fill=tuple(int(c * 0.6) for c in hair), width=2)
    d.line([(48, 43), (46, 52), (49, 53)], fill=tuple(int(c * 0.75) for c in skin), width=1)
    d.line([(43, 59), (53, 59)], fill=(120, 60, 50), width=2)
    if race == "Silvani":  # shifting skin pattern
        for _ in range(6):
            x, y = 30 + r.random() * 36, 22 + r.random() * 40
            d.ellipse([x - 3, y - 2, x + 3, y + 2], fill=tuple(min(255, int(c * 1.15)) for c in skin))
    im = im.resize((48, 48), Image.LANCZOS)
    return im


# ── Sound (22.05 kHz mono) ───────────────────────────────────────────────────
SR = 22050


def env(n, a=0.005, d=0.2):
    t = np.arange(n) / SR
    e = np.minimum(1, t / max(a, 1e-4)) * np.exp(-t / max(d, 1e-4))
    return e


def noise(n, seed):
    return np.random.default_rng(seed).uniform(-1, 1, n)


def lowpass(x, k):
    k = max(1, int(k))
    return np.convolve(x, np.ones(k) / k, mode="same")


def tone(freq, dur, kind="sine", seed=0):
    n = int(SR * dur)
    t = np.arange(n) / SR
    if callable(freq):
        ph = np.cumsum(freq(t)) / SR * math.tau
    else:
        ph = t * freq * math.tau
    if kind == "sine":
        return np.sin(ph)
    if kind == "square":
        return np.sign(np.sin(ph)) * 0.6
    if kind == "saw":
        return ((ph / math.tau) % 1) * 2 - 1
    return np.sin(ph)


def mix(*parts):
    """Sum arrays of different lengths (shorter ones are zero-padded)."""
    n = max(len(p) for p in parts)
    out = np.zeros(n)
    for p in parts:
        out[:len(p)] += p
    return out


def delayed(x, sec):
    return np.concatenate([np.zeros(int(SR * sec)), x])


def write_wav(name, x):
    x = np.asarray(x, float)
    peak = np.max(np.abs(x)) or 1
    x = x / peak * 0.85
    pcm = (x * 32767).astype("<i2")
    with wave.open(os.path.join(OUT, "sfx", name + ".wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def sounds():
    n = lambda d: int(SR * d)
    s = {}
    s["step"] = lowpass(noise(n(0.12), 1), 30) * env(n(0.12), 0.002, 0.03)
    s["bump"] = (lowpass(noise(n(0.18), 2), 80) + tone(70, 0.18) * 0.8) * env(n(0.18), 0.002, 0.05)
    s["swing"] = lowpass(noise(n(0.22), 3), 6) * np.sin(np.linspace(0, math.pi, n(0.22))) * 0.8
    s["hit"] = (lowpass(noise(n(0.2), 4), 12) + tone(110, 0.2, "square") * 0.4) * env(n(0.2), 0.001, 0.06)
    s["miss"] = lowpass(noise(n(0.18), 5), 3) * np.sin(np.linspace(0, math.pi, n(0.18))) * 0.4
    s["hurt"] = tone(lambda t: 220 - t * 400, 0.25, "saw") * env(n(0.25), 0.003, 0.1) * 0.7
    s["monster_die"] = tone(lambda t: 160 - t * 140, 0.6, "saw") * env(n(0.6), 0.01, 0.3) + \
        lowpass(noise(n(0.6), 6), 20) * env(n(0.6), 0.01, 0.2) * 0.6
    s["growl"] = tone(lambda t: 70 + 15 * np.sin(t * 40), 0.5, "saw") * env(n(0.5), 0.05, 0.3)
    door = lowpass(noise(n(0.7), 7), 40) * env(n(0.7), 0.05, 0.4)
    s["door"] = door + tone(55, 0.7) * env(n(0.7), 0.01, 0.2) * 0.6
    s["gate"] = mix(np.concatenate([lowpass(noise(n(0.05), 8 + i), 4) * env(n(0.05), 0.001, 0.02) for i in range(12)]),
                    tone(48, 0.6) * 0.5 * env(n(0.6), 0.02, 0.4))
    s["button"] = tone(900, 0.06, "square") * env(n(0.06), 0.001, 0.02) + tone(400, 0.06) * 0.5
    s["lever"] = np.concatenate([lowpass(noise(n(0.08), 20), 6) * env(n(0.08), 0.001, 0.03),
                                 tone(160, 0.2, "square") * env(n(0.2), 0.001, 0.05)])
    s["key"] = mix(tone(700, 0.08, "square") * env(n(0.08), 0.001, 0.02),
                   delayed(lowpass(noise(n(0.15), 26), 4) * env(n(0.15), 0.001, 0.05), 0.07))
    s["plate"] = lowpass(noise(n(0.25), 21), 60) * env(n(0.25), 0.002, 0.08) + tone(90, 0.25) * env(n(0.25), 0.002, 0.08)
    s["pickup"] = tone(lambda t: 500 + t * 1500, 0.12) * env(n(0.12), 0.002, 0.06)
    s["coin"] = (tone(1800, 0.25) + tone(2400, 0.25) * 0.6) * env(n(0.25), 0.001, 0.08)
    s["cast"] = tone(lambda t: 300 + 900 * t, 0.5) * env(n(0.5), 0.02, 0.3) + \
        tone(lambda t: 450 + 1350 * t, 0.5) * env(n(0.5), 0.02, 0.3) * 0.5
    s["heal"] = sum(tone(f, 0.7) * env(n(0.7), 0.05 + i * 0.05, 0.4) for i, f in enumerate((523, 659, 784, 1046)))
    s["fizzle"] = lowpass(noise(n(0.4), 22), 2) * env(n(0.4), 0.01, 0.15) * 0.6
    bleed = tone(lambda t: 120 + 60 * np.sin(t * 23) + 300 * t, 1.1, "saw") * env(n(1.1), 0.02, 0.6)
    s["leybleed"] = bleed + lowpass(noise(n(1.1), 23), 3) * env(n(1.1), 0.3, 0.6) * 0.5
    s["quake"] = lowpass(noise(n(1.4), 24), 120) * env(n(1.4), 0.05, 0.8) * 3
    s["trap"] = np.concatenate([tone(1200, 0.03, "square") * 0.5, lowpass(noise(n(0.3), 25), 5) * env(n(0.3), 0.001, 0.1)])
    s["stairs"] = np.concatenate([lowpass(noise(n(0.1), 30 + i), 30) * env(n(0.1), 0.002, 0.04) * (1 - i * 0.12)
                                  for i in range(6)])
    s["levelup"] = mix(*[delayed(tone(f, 0.5) * env(n(0.5), 0.01, 0.3), 0.09 * i)
                         for i, f in enumerate((392, 523, 659, 784))])
    s["seal"] = sum(tone(f, 1.6) * env(n(1.6), 0.2, 0.9) for f in (220, 330, 440)) + \
        tone(lambda t: 880 + 20 * np.sin(t * 6), 1.6) * env(n(1.6), 0.4, 0.8) * 0.4
    s["death"] = tone(lambda t: 300 - t * 200, 1.2, "saw") * env(n(1.2), 0.01, 0.7)
    for name, x in s.items():
        write_wav(name, x)
    # ambient drones per theme (seamless-ish loops)
    for theme, (base, wob, noi) in {"aeridor": (110, 0.2, 0.08), "tunnels": (55, 0.5, 0.3),
                                    "bones": (65, 0.3, 0.2), "forge": (45, 1.0, 0.5),
                                    "deep": (38, 0.15, 0.15), "heart": (50, 1.2, 0.25)}.items():
        dur = 8.0
        t = np.arange(int(SR * dur)) / SR
        x = np.sin(t * base * math.tau) * 0.5 + np.sin(t * base * 1.5 * math.tau + np.sin(t * wob) * 2) * 0.3
        x += lowpass(noise(len(t), sum(map(ord, theme))), 200) * noi * 6
        if theme == "heart":
            beat = (np.sin(t * math.tau * 1.0) > 0.92).astype(float)
            x += lowpass(beat, 400) * 8
        fade = np.minimum(1, np.minimum(t, dur - t) / 0.5)
        write_wav("amb_" + theme, x * fade)
    return sorted(list(s) + ["amb_" + k for k in ("aeridor", "tunnels", "bones", "forge", "deep", "heart")])


# ── Main ─────────────────────────────────────────────────────────────────────
THEMES = {
    "aeridor": (tex_aeridor_wall, tex_aeridor_floor, tex_aeridor_ceil, "door_aeridor", (8, 10, 18)),
    "tunnels": (tex_tunnels_wall, tex_tunnels_floor, tex_tunnels_ceil, "door_wood", (6, 4, 2)),
    "bones": (tex_bones_wall, tex_bones_floor, tex_bones_ceil, "door_wood", (8, 6, 4)),
    "forge": (tex_forge_wall, tex_forge_floor, tex_forge_ceil, "door_iron", (20, 6, 0)),
    "deep": (tex_deep_wall, tex_deep_floor, tex_deep_ceil, "door_iron", (2, 0, 8)),
    "heart": (tex_heart_wall, tex_heart_floor, tex_heart_ceil, "door_iron", (14, 0, 4)),
}
FAMILIES = {"undead": spr_undead, "construct": spr_construct, "beast": spr_beast, "ooze": spr_ooze,
            "dragon": spr_dragon, "elemental": spr_elemental, "demon": spr_demon, "insect": spr_insect,
            "plant": spr_plant, "horror": spr_horror, "giant": spr_giant, "humanoid": spr_humanoid}
ICONS = ["weapon", "bow", "staff", "armor", "head", "boots", "accessory", "potion", "ether", "elixir", "herb",
         "gem", "key", "page", "shard", "torch", "coin", "bag"]


def main():
    for sub in ("tex", "sprites", "portraits", "sfx"):
        os.makedirs(os.path.join(OUT, sub), exist_ok=True)
    man = {"pack": "generated", "themes": {}, "doors": {}, "decor": {}, "floor_decor": {}, "monsters": {},
           "objects": {}, "icons": {}, "portraits": [], "sfx": {}}

    def save(img, rel):
        img.save(os.path.join(OUT, rel), optimize=True)
        return "generated/" + rel

    for name, (w, f, c, door, fog) in THEMES.items():
        man["themes"][name] = {"wall": save(w(), f"tex/{name}_wall.png"), "floor": save(f(), f"tex/{name}_floor.png"),
                               "ceil": save(c(), f"tex/{name}_ceil.png"), "door": door, "fog": list(fog)}
    man["doors"] = {"door_wood": save(door_wood(), "tex/door_wood.png"),
                    "door_iron": save(door_iron(), "tex/door_iron.png"),
                    "door_aeridor": save(door_aeridor(), "tex/door_aeridor.png"),
                    "portcullis": save(portcullis(), "tex/portcullis.png")}
    man["decor"] = {"stairs_down": save(stairs_tex(True), "tex/stairs_down.png"),
                    "stairs_up": save(stairs_tex(False), "tex/stairs_up.png"),
                    "button_off": save(deco_button(False), "tex/button_off.png"),
                    "button_on": save(deco_button(True), "tex/button_on.png"),
                    "lever_up": save(deco_lever(True), "tex/lever_up.png"),
                    "lever_down": save(deco_lever(False), "tex/lever_down.png"),
                    "keyhole": save(deco_keyhole(), "tex/keyhole.png"),
                    "crystal": save(deco_crystal(True), "tex/crystal.png"),
                    "crystal_cracked": save(deco_crystal(True, True), "tex/crystal_cracked.png"),
                    "crystal_sealed": save(deco_crystal(False), "tex/crystal_sealed.png"),
                    "seal_sealed": save(deco_seal("sealed"), "tex/seal_sealed.png"),
                    "seal_awake": save(deco_seal("awake"), "tex/seal_awake.png"),
                    "seal_spent": save(deco_seal("spent"), "tex/seal_spent.png"),
                    "inscription": save(deco_inscription(), "tex/inscription.png"),
                    "sconce": save(deco_sconce(), "tex/sconce.png")}
    man["floor_decor"] = {"plate": save(floor_plate(), "tex/plate.png"), "pit": save(floor_pit(), "tex/pit.png")}
    for fam, fn in FAMILIES.items():
        man["monsters"][fam] = save(fn(), f"sprites/{fam}.png")
    man["objects"] = {"chest": save(spr_chest(False), "sprites/chest.png"),
                      "chest_open": save(spr_chest(True), "sprites/chest_open.png")}
    for k in ICONS:
        man["icons"][k] = save(item_icon(k), f"sprites/icon_{k}.png")
    i = 0
    for race in SKINS:
        for k in range(4):
            rel = save(portrait(race, k, 500 + i), f"portraits/{race.lower()}_{k}.png")
            man["portraits"].append({"race": race, "src": rel})
            i += 1
    for nm in sounds():
        man["sfx"][nm] = f"generated/sfx/{nm}.wav"
    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump(man, f, indent=1)
        f.write("\n")
    print(f"themes {len(man['themes'])}, decor {len(man['decor'])}, monster families {len(man['monsters'])}, "
          f"icons {len(man['icons'])}, portraits {len(man['portraits'])}, sfx {len(man['sfx'])}")


if __name__ == "__main__":
    main()
