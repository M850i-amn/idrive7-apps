"""make_oem_icons.py - two OEM-style directions for the amn apps' icons (Nov 2026), custom marks, no stock symbols.

  A  "BMW iDrive": a dark tile like the head unit's own menu, thin white line marks, BMW blue accents (M colours on HUD).
  B  "Apple / Uber": one flat colour tile, one bold white mark, nothing else.

SVG rendered by Chromium (Playwright). Usage:
  python3.10 make_oem_icons.py sheet.png            preview of both directions
  python3.10 make_oem_icons.py --apply A|B          writes apps/<id>/icon.png (140 px)
"""
import math
import os
import sys

from PIL import Image
from playwright.sync_api import sync_playwright

REPO = os.path.expanduser('~/Desktop/mgu-dev/amn-idrive7-apps')
R = 512


def squircle(n=5.0, size=R, pad=4, steps=240):
    c, r = size / 2, size / 2 - pad
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        ct, st = math.cos(t), math.sin(t)
        pts.append('%.2f,%.2f' % (c + r * math.copysign(abs(ct) ** (2 / n), ct), c + r * math.copysign(abs(st) ** (2 / n), st)))
    return 'M' + ' L'.join(pts) + ' Z'


SQ = squircle()


def arc(cx, cy, r, a0, a1):
    x0, y0 = cx + r * math.cos(math.radians(a0)), cy + r * math.sin(math.radians(a0))
    x1, y1 = cx + r * math.cos(math.radians(a1)), cy + r * math.sin(math.radians(a1))
    large = 1 if (a1 - a0) % 360 > 180 else 0
    return 'M%.1f %.1f A%.1f %.1f 0 %d 1 %.1f %.1f' % (x0, y0, r, r, large, x1, y1)


def svg(bg, body):
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d"><defs>'
            '<clipPath id="t"><path d="%s"/></clipPath></defs><g clip-path="url(#t)">%s%s</g></svg>') % (R, R, R, R, SQ, bg, body)


# ---------- direction A: BMW iDrive ----------
A_BG = ('<defs><linearGradient id="a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#232c36"/>'
        '<stop offset="0.6" stop-color="#11161c"/><stop offset="1" stop-color="#07090c"/></linearGradient></defs>'
        '<rect width="512" height="512" fill="url(#a)"/>'
        '<path d="M70 5 H442" stroke="#ffffff" stroke-opacity="0.22" stroke-width="2"/>')
BLUE, LBLUE, RED = '#1c69d4', '#5fb4ff', '#e2001a'
SW = 15
L = 'fill="none" stroke="#fff" stroke-width="%d" stroke-linecap="round" stroke-linejoin="round"' % SW


def a_hud():
    cx, cy, r = 256, 292, 150
    body = '<path d="%s" %s/>' % (arc(cx, cy, r, 160, 340), L)
    # tick marks inside the arc, the last three in the M colours
    for i, a in enumerate(range(160, 381, 22)):
        col = '#fff' if a < 330 else (LBLUE, BLUE, RED)[min(2, (a - 330) // 22)]
        rr0, rr1 = r - 30, r - (52 if i % 2 == 0 else 42)
        ra = math.radians(a)
        body += '<path d="M%.1f %.1f L%.1f %.1f" fill="none" stroke="%s" stroke-width="10" stroke-linecap="round"/>' % (
            cx + rr0 * math.cos(ra), cy + rr0 * math.sin(ra), cx + rr1 * math.cos(ra), cy + rr1 * math.sin(ra), col)
    body += '<path d="%s" fill="none" stroke="%s" stroke-width="%d" stroke-linecap="round"/>' % (arc(cx, cy, r, 346, 380), RED, SW)
    a = math.radians(296)
    body += '<path d="M%d %d L%.1f %.1f" fill="none" stroke="%s" stroke-width="11" stroke-linecap="round"/>' % (
        cx, cy, cx + 128 * math.cos(a), cy + 128 * math.sin(a), RED)
    body += '<circle cx="%d" cy="%d" r="16" fill="#fff"/>' % (cx, cy)
    body += '<path d="M186 384 H326" %s/>' % L
    body += m_stripes(256, 418, 132)
    return svg(A_BG, body)


def m_stripes(x, y, w, h=18, gap=7, slant=0.45):
    """the M colours as three slanted bars (the M logo's), centred at x"""
    seg = (w - 2 * gap) / 3.0
    k = h * slant
    out = ''
    for i, col in enumerate((LBLUE, BLUE, RED)):
        x0 = x - w / 2 + i * (seg + gap)
        out += '<path d="M%.1f %.1f L%.1f %.1f L%.1f %.1f L%.1f %.1f Z" fill="%s"/>' % (
            x0 + k, y, x0 + seg + k, y, x0 + seg, y + h, x0, y + h, col)
    return out


def a_iptv():
    body = '<rect x="106" y="122" width="300" height="204" rx="34" %s/>' % L
    body += '<path d="M232 180 L302 224 L232 268 Z" fill="#fff" stroke="#fff" stroke-width="14" stroke-linejoin="round"/>'
    body += m_stripes(256, 380, 150)
    return svg(A_BG, body)


def a_side():
    # the car from above: body with its front and rear screens and the two mirrors
    body = '<path d="M216 112 Q256 92 296 112 Q316 124 316 160 V352 Q316 392 290 404 Q256 416 222 404 Q196 392 196 352 V160 Q196 124 216 112 Z" %s/>' % L
    body += '<path d="M218 196 Q256 180 294 196" %s/><path d="M222 340 Q256 352 290 340" %s/>' % (L, L)
    body += '<path d="M196 214 H176" %s/><path d="M316 214 H336" %s/>' % (L, L)
    for s_ in (-1, 1):
        x = 256 + s_ * 132
        body += '<path d="M%d 222 L%d 260 L%d 298" fill="none" stroke="%s" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/>' % (
            x, x + s_ * 36, x, LBLUE)
    body += m_stripes(256, 448, 110, 14, 6)
    return svg(A_BG, body)


# ---------- direction B: Apple / Uber ----------
W = 'fill="#fff"'


def b_hud():
    bg = '<rect width="512" height="512" fill="#000"/>'
    cx, cy, r = 256, 286, 158
    body = '<path d="%s" fill="none" stroke="#fff" stroke-width="44" stroke-linecap="round"/>' % arc(cx, cy, r, 150, 330)
    body += '<path d="%s" fill="none" stroke="#ff3b30" stroke-width="44" stroke-linecap="round"/>' % arc(cx, cy, r, 352, 390)
    a = math.radians(312)
    body += '<path d="M%d %d L%.1f %.1f" fill="none" stroke="#fff" stroke-width="34" stroke-linecap="round"/>' % (
        cx, cy, cx + 118 * math.cos(a), cy + 118 * math.sin(a))
    body += '<circle cx="%d" cy="%d" r="34" %s/>' % (cx, cy, W)
    return svg(bg, body)


def b_iptv():
    bg = ('<defs><linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff5e6c"/>'
          '<stop offset="1" stop-color="#e0182d"/></linearGradient></defs><rect width="512" height="512" fill="url(#b)"/>')
    # a rounded play triangle, bold
    body = '<path d="M196 150 Q196 126 218 138 L366 236 Q386 256 366 276 L218 374 Q196 386 196 362 Z" %s/>' % W
    return svg(bg, body)


def b_side():
    bg = ('<defs><linearGradient id="c" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffb340"/>'
          '<stop offset="1" stop-color="#ff8a00"/></linearGradient></defs><rect width="512" height="512" fill="url(#c)"/>')
    body = '<rect x="196" y="96" width="120" height="320" rx="60" %s/>' % W
    body += '<rect x="218" y="170" width="76" height="60" rx="20" fill="#ff9d1c"/><rect x="224" y="330" width="64" height="40" rx="16" fill="#ff9d1c"/>'
    for s in (-1, 1):
        x0 = 256 + s * 92
        body += '<path d="M%d 200 Q%d 256 %d 312" fill="none" stroke="#fff" stroke-width="30" stroke-linecap="round"/>' % (
            x0, x0 + s * 50, x0)
        x1 = 256 + s * 152
        body += '<path d="M%d 168 Q%d 256 %d 344" fill="none" stroke="#fff" stroke-opacity="0.75" stroke-width="30" stroke-linecap="round"/>' % (
            x1, x1 + s * 62, x1)
    return svg(bg, body)


SETS = {'A': [('amn_hudlyrics', a_hud), ('amn_iptv', a_iptv), ('amn_sideview', a_side)],
        'B': [('amn_hudlyrics', b_hud), ('amn_iptv', b_iptv), ('amn_sideview', b_side)]}


def render(svgs, px=R):
    out = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={'width': px, 'height': px})
        for s in svgs:
            s = s.replace('width="%d" height="%d"' % (R, R), 'width="%d" height="%d"' % (px, px), 1)
            pg.set_content('<html><body style="margin:0;background:transparent">' + s + '</body></html>')
            pg.screenshot(path='/tmp/_oem.png', omit_background=True, clip={'x': 0, 'y': 0, 'width': px, 'height': px})
            out.append(Image.open('/tmp/_oem.png').convert('RGBA'))
        b.close()
    return out


if __name__ == '__main__':
    if sys.argv[1] == '--apply':
        imgs = render([f() for _, f in SETS[sys.argv[2]]], 280)
        for (app, _), im in zip(SETS[sys.argv[2]], imgs):
            im.resize((140, 140), Image.BOX).save(os.path.join(REPO, 'apps', app, 'icon.png'))
    else:
        rows = [('A', render([f() for _, f in SETS['A']])), ('B', render([f() for _, f in SETS['B']]))]
        sheet = Image.new('RGBA', (3 * 220 + 40, 2 * 240 + 20), (18, 18, 20, 255))
        for r, (_, imgs) in enumerate(rows):
            for i, im in enumerate(imgs):
                sm = im.resize((140, 140), Image.LANCZOS).resize((180, 180), Image.LANCZOS)
                sheet.paste(sm, (40 + i * 220, 30 + r * 240), sm)
        sheet.save(sys.argv[1])
    print('ok')
