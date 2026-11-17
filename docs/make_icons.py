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


COMMON = ('<linearGradient id="chrome" gradientUnits="userSpaceOnUse" x1="0" y1="90" x2="0" y2="430">'
          '<stop offset="0" stop-color="#ffffff"/><stop offset="0.55" stop-color="#eef2f6"/><stop offset="1" stop-color="#b9c4cf"/></linearGradient>'
          '<filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur in="SourceAlpha" stdDeviation="5"/>'
          '<feOffset dy="6"/><feComponentTransfer><feFuncA type="linear" slope="0.55"/></feComponentTransfer>'
          '<feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>'
          '<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="7" result="g"/>'
          '<feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'
          '<radialGradient id="toplight" cx="0.5" cy="0" r="0.8"><stop offset="0" stop-color="#ffffff" stop-opacity="0.13"/>'
          '<stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>'
          '<radialGradient id="vig" cx="0.5" cy="0.45" r="0.72"><stop offset="0.6" stop-color="#000" stop-opacity="0"/>'
          '<stop offset="1" stop-color="#000" stop-opacity="0.45"/></radialGradient>'
          '<linearGradient id="rimg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.32"/>'
          '<stop offset="0.3" stop-color="#fff" stop-opacity="0.06"/><stop offset="1" stop-color="#fff" stop-opacity="0.12"/></linearGradient>')


def svg(bg, body):
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d"><defs>%s'
            '<clipPath id="t"><path d="%s"/></clipPath></defs><g clip-path="url(#t)">%s'
            '<rect width="512" height="512" fill="url(#toplight)"/><rect width="512" height="512" fill="url(#vig)"/>'
            '<g filter="url(#sh)">%s</g></g><path d="%s" fill="none" stroke="url(#rimg)" stroke-width="3"/></svg>') % (
        R, R, R, R, COMMON, SQ, bg, body, SQ)


# ---------- direction A: BMW iDrive ----------
A_BG = ('<defs><linearGradient id="a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#232c36"/>'
        '<stop offset="0.6" stop-color="#11161c"/><stop offset="1" stop-color="#07090c"/></linearGradient></defs>'
        '<rect width="512" height="512" fill="url(#a)"/>'
        )
BLUE, LBLUE, RED = '#1c69d4', '#5fb4ff', '#e2001a'
SW = 15
L = 'fill="none" stroke="url(#chrome)" stroke-width="%d" stroke-linecap="round" stroke-linejoin="round"' % SW


def a_hud():
    cx, cy, r = 256, 300, 156
    body = '<path d="%s" %s/>' % (arc(cx, cy, r, 160, 316), L)
    m = ''
    for a0, a1, col in ((318, 338, LBLUE), (340, 360, BLUE), (362, 380, RED)):
        m += '<path d="%s" fill="none" stroke="%s" stroke-width="%d" stroke-linecap="butt"/>' % (arc(cx, cy, r, a0, a1), col, SW + 4)
    body += '<g filter="url(#glow)">%s</g>' % m
    for i, a in enumerate(range(160, 317, 22)):
        rr0, rr1 = r - 32, r - (54 if i % 2 == 0 else 44)
        ra = math.radians(a)
        body += '<path d="M%.1f %.1f L%.1f %.1f" fill="none" stroke="url(#chrome)" stroke-width="%d" stroke-linecap="round"/>' % (
            cx + rr0 * math.cos(ra), cy + rr0 * math.sin(ra), cx + rr1 * math.cos(ra), cy + rr1 * math.sin(ra), 10 if i % 2 == 0 else 8)
    a = math.radians(300)
    tip = (cx + 136 * math.cos(a), cy + 136 * math.sin(a))
    nx, ny = -math.sin(a), math.cos(a)
    body += '<path d="M%.1f %.1f L%.1f %.1f L%.1f %.1f Z" fill="url(#chrome)"/>' % (
        cx + nx * 9, cy + ny * 9, tip[0], tip[1], cx - nx * 9, cy - ny * 9)
    body += '<circle cx="%d" cy="%d" r="22" fill="#0d1218" stroke="url(#chrome)" stroke-width="8"/>' % (cx, cy)
    body += '<circle cx="%d" cy="%d" r="6" fill="%s"/>' % (cx, cy, RED)
    body += '<path d="M186 396 H326" %s/>' % L
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


def m_badge(x, y, h=40, w=9, gap=5, slant=0.35, bg=None):
    """a small M badge: three slanted bars (light blue, dark blue, red) from x, h tall; bg: a pad behind it"""
    k = h * slant
    out = ''
    if bg:
        total = 3 * w + 2 * gap + k
        out += '<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="6" fill="%s"/>' % (x - 7, y - 7, total + 14, h + 14, bg)
    for i, col in enumerate((LBLUE, BLUE, RED)):
        x0 = x + i * (w + gap)
        out += '<path d="M%.1f %.1f L%.1f %.1f L%.1f %.1f L%.1f %.1f Z" fill="%s"/>' % (
            x0 + k, y, x0 + k + w, y, x0 + w, y + h, x0, y + h, col)
    return out


TILE = '#121820'


def a_iptv():
    body = '<rect x="96" y="128" width="320" height="216" rx="36" %s/>' % L
    body += '<path d="M206 400 H306" %s/>' % L
    body += '<path d="M226 178 Q226 162 240 170 L318 222 Q330 236 318 250 L240 302 Q226 310 226 294 Z" fill="url(#chrome)"/>'
    body += ('<defs><clipPath id="scr"><rect x="104" y="136" width="304" height="200" rx="30"/></clipPath>'
             '<linearGradient id="gl" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.10"/>'
             '<stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>'
             '<path d="M96 128 L300 128 L150 344 L96 344 Z" fill="url(#gl)" clip-path="url(#scr)"/>')
    # the M badge on the frame's right edge, low, as a car's gill badge
    body += m_badge(392, 262, 44, 9, 5, 0.32, TILE)
    return svg(A_BG, body)


def a_side():
    """the car from above (the icons_bmw7 drawing), arrows each side, a small M badge on its right flank"""
    car = 'M216 112 Q256 92 296 112 Q316 124 316 160 V352 Q316 392 290 404 Q256 416 222 404 Q196 392 196 352 V160 Q196 124 216 112 Z'
    body = '<path d="%s" %s/>' % (car, L)
    body += '<path d="M214 198 Q256 180 298 198" %s/><path d="M218 340 Q256 354 294 340" %s/>' % (L, L)
    body += '<path d="M196 216 H174" %s/><path d="M316 216 H338" %s/>' % (L, L)
    body += m_badge(268, 236, 36, 7, 4, 0.32)
    for s_ in (-1, 1):
        x = 256 + s_ * 134
        body += '<path d="M%d 224 L%d 262 L%d 300" %s/>' % (x, x + s_ * 36, x, L)
    return svg(A_BG, body)


def side_v1():
    """a wing mirror (seen from behind the car) with a camera lens, and the M badge on its arm"""
    mirror = 'M150 196 C150 160 180 146 236 146 L330 150 C372 152 392 172 392 214 L392 262 C392 300 370 322 326 324 L222 330 C178 332 150 312 150 276 Z'
    body = '<path d="%s" %s/>' % (mirror, L)
    body += '<path d="M392 236 L430 236 L436 300" %s/>' % L                      # the arm into the door
    body += '<circle cx="262" cy="240" r="46" fill="none" stroke="url(#chrome)" stroke-width="12"/>'
    body += '<circle cx="262" cy="240" r="22" fill="url(#chrome)"/><circle cx="254" cy="232" r="7" fill="#0d1218"/>'
    body += m_badge(320, 282, 24, 5, 3, 0.32)
    return svg(A_BG, body)


def side_v2():
    """a camera lens between the two signal chevrons"""
    body = '<circle cx="256" cy="256" r="98" fill="none" stroke="url(#chrome)" stroke-width="14"/>'
    body += '<circle cx="256" cy="256" r="60" fill="none" stroke="url(#chrome)" stroke-width="10"/>'
    body += '<circle cx="256" cy="256" r="28" fill="url(#chrome)"/><circle cx="246" cy="246" r="8" fill="#0d1218"/>'
    for s_ in (-1, 1):
        x = 256 + s_ * 150
        body += '<path d="M%d 214 L%d 256 L%d 298" %s/>' % (x, x + s_ * 38, x, L)
    body += m_badge(312, 330, 30, 6, 3.5, 0.32)
    return svg(A_BG, body)


def side_v3():
    """the car from above, minimal, with the two side cameras' views as thin lines from the mirrors"""
    car = ('M256 110 C226 110 214 122 212 150 L210 360 C210 392 226 404 256 404 C286 404 302 392 302 360 L300 150 C298 122 286 110 256 110 Z')
    body = '<path d="%s" %s/>' % (car, L)
    body += '<path d="M222 222 Q256 208 290 222" %s/>' % L
    body += '<path d="M224 340 Q256 350 288 340" %s/>' % L
    for s_ in (-1, 1):
        mx = 256 + s_ * 50
        body += '<path d="M%d 232 L%d 232" %s/>' % (mx, mx + s_ * 20, L)
        # the camera's view: two thin lines fanning out
        for dy, op in ((-70, 1), (70, 1)):
            body += '<path d="M%d 232 L%d %d" fill="none" stroke="url(#chrome)" stroke-opacity="0.55" stroke-width="7" stroke-linecap="round"/>' % (
                mx + s_ * 22, mx + s_ * 150, 232 + dy)
    body += m_badge(270, 160, 28, 5.5, 3, 0.32)
    return svg(A_BG, body)


def side_n1():
    """the cluster's turn-signal symbol: two arrows, outlined in chrome, the M badge between them"""
    def arrow(d):  # d = -1 left, 1 right; tip at 256 + d*190
        tip = 256 + d * 186
        base = 256 + d * 58
        neck = 256 + d * 112
        return ('M%d 256 L%d 186 L%d 222 L%d 222 L%d 290 L%d 290 L%d 326 Z' % (tip, neck, neck, base, base, neck, neck))
    body = '<path d="%s" %s/>' % (arrow(-1), L)
    body += '<path d="%s" %s/>' % (arrow(1), L)
    body += m_badge(238, 238, 36, 7, 4, 0.32)
    return svg(A_BG, body)


def side_n2():
    """the car from the front: low wide body, twin kidneys, slim lights; a signal chevron each side"""
    body = '<path d="M150 300 L156 236 Q162 206 196 200 L230 168 Q256 158 282 168 L316 200 Q350 206 356 236 L362 300 Q362 316 346 316 L166 316 Q150 316 150 300 Z" %s/>' % L
    body += '<path d="M150 300 L150 334 M362 300 L362 334" %s/>' % L
    # the kidneys
    body += '<rect x="226" y="236" width="26" height="40" rx="9" fill="none" stroke="url(#chrome)" stroke-width="9"/>'
    body += '<rect x="260" y="236" width="26" height="40" rx="9" fill="none" stroke="url(#chrome)" stroke-width="9"/>'
    # slim lights
    body += '<path d="M176 246 L212 252 M336 246 L300 252" fill="none" stroke="url(#chrome)" stroke-width="9" stroke-linecap="round"/>'
    body += '<path d="M228 198 Q256 190 284 198" fill="none" stroke="url(#chrome)" stroke-width="8" stroke-linecap="round"/>'
    for s_ in (-1, 1):
        x = 256 + s_ * 170
        body += '<path d="M%d 226 L%d 256 L%d 286" %s/>' % (x, x + s_ * 30, x, L)
    body += m_badge(320, 284, 18, 4, 2.5, 0.32)
    return svg(A_BG, body)


def side_n3():
    """the car from behind: a low coupe with L-shaped tail-lights"""
    body = '<path d="M140 312 L148 252 Q154 222 186 214 L222 176 Q256 164 290 176 L326 214 Q358 222 364 252 L372 312 Q372 330 354 330 L158 330 Q140 330 140 312 Z" %s/>' % L
    body += '<path d="M150 330 L150 356 M362 330 L362 356" %s/>' % L
    # the L lights
    body += '<path d="M164 244 L214 248 L214 270" fill="none" stroke="url(#chrome)" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>'
    body += '<path d="M348 244 L298 248 L298 270" fill="none" stroke="url(#chrome)" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>'
    body += '<path d="M226 206 Q256 196 286 206" fill="none" stroke="url(#chrome)" stroke-width="8" stroke-linecap="round"/>'
    body += '<rect x="232" y="292" width="48" height="16" rx="4" fill="none" stroke="url(#chrome)" stroke-width="6"/>'
    body += m_badge(312, 290, 18, 4, 2.5, 0.32)
    return svg(A_BG, body)


def side_n4():
    """blind-spot symbol: the car from behind, its side camera's zone fanning out beside it"""
    car = 'M186 300 L192 244 Q196 222 220 216 L240 190 Q256 184 272 190 L292 216 Q316 222 320 244 L326 300 Q326 314 312 314 L200 314 Q186 314 186 300 Z'
    body = '<path d="M330 250 L452 196 L452 350 L330 300 Z" fill="url(#chrome)" fill-opacity="0.16"/>'
    body += '<path d="M330 250 L452 196 M330 300 L452 350" fill="none" stroke="url(#chrome)" stroke-opacity="0.6" stroke-width="7" stroke-linecap="round"/>'
    body += '<path d="M180 250 L60 196 L60 350 L180 300 Z" fill="url(#chrome)" fill-opacity="0.16"/>'
    body += '<path d="M180 250 L60 196 M180 300 L60 350" fill="none" stroke="url(#chrome)" stroke-opacity="0.6" stroke-width="7" stroke-linecap="round"/>'
    body += '<path d="%s" %s/>' % (car, L)
    body += '<path d="M196 314 L196 336 M316 314 L316 336" %s/>' % L
    body += '<path d="M204 250 L232 252 M308 250 L280 252" fill="none" stroke="url(#chrome)" stroke-width="9" stroke-linecap="round"/>'
    body += m_badge(286, 284, 16, 3.5, 2.2, 0.32)
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
    if sys.argv[1] == '--side':
        imgs = render([side_n1(), side_n2(), side_n3(), side_n4()], 280)
        sheet = Image.new('RGBA', (4 * 300 + 20, 470), (10, 14, 20, 255))
        for i, im in enumerate(imgs):
            sm = im.resize((140, 140), Image.BOX)
            big = sm.resize((280, 280), Image.LANCZOS)
            sheet.paste(big, (20 + i * 300, 10), big); sheet.paste(sm, (90 + i * 300, 310), sm)
        sheet.save(sys.argv[2]); print('ok'); sys.exit(0)
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
