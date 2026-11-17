"""make_glass_icons.py - the amn apps' icons in iOS 26 "Liquid Glass" style (Nov 2026).

A squircle tile (superellipse n=5) in a vivid two-stop gradient with a soft light bloom and a bright glass rim; on it a
symbol from Phosphor Icons (MIT, github.com/phosphor-icons/core 2.1.1) drawn as frosted glass: a white-to-translucent
fill, a bright top edge, a darker lower edge and a soft shadow under it. SVG rendered by Chromium (Playwright) at 512 px,
downscaled to the 140 px the head unit shows.

  /usr/local/bin/python3.10 make_glass_icons.py <phosphor assets dir> [preview.png]
"""
import math
import os
import re
import sys

from PIL import Image
from playwright.sync_api import sync_playwright

REPO = os.path.expanduser('~/Desktop/mgu-dev/amn-idrive7-apps')
R = 512


def squircle(n=5.0, size=R, pad=6, steps=240):
    c, r = size / 2, size / 2 - pad
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        ct, st = math.cos(t), math.sin(t)
        x = c + r * math.copysign(abs(ct) ** (2 / n), ct)
        y = c + r * math.copysign(abs(st) ** (2 / n), st)
        pts.append('%.2f,%.2f' % (x, y))
    return 'M' + ' L'.join(pts) + ' Z'


def glyph(assets, name):
    s = open(os.path.join(assets, 'fill', name + '-fill.svg')).read()
    return re.findall(r'<path[^>]*\sd="([^"]+)"', s)


def symbol_group(paths, scale, tx, ty):
    """paths in Phosphor's 256 box, placed at (tx, ty) with scale"""
    d = ''.join('<path d="%s"/>' % p for p in paths)
    return '<g transform="translate(%.1f %.1f) scale(%.4f)">%s</g>' % (tx, ty, scale, d)


def icon_svg(top, bottom, glow, symbols):
    """symbols: [(paths, scale, tx, ty)] - drawn as one glass layer"""
    sq = squircle()
    sym = ''.join(symbol_group(*s) for s in symbols)
    return '''<svg xmlns="http://www.w3.org/2000/svg" width="{R}" height="{R}" viewBox="0 0 {R} {R}">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1">
    <stop offset="0" stop-color="{top}"/><stop offset="1" stop-color="{bottom}"/>
  </linearGradient>
  <radialGradient id="bloom" cx="0.3" cy="0.18" r="0.75">
    <stop offset="0" stop-color="{glow}" stop-opacity="0.75"/><stop offset="0.55" stop-color="{glow}" stop-opacity="0.12"/>
    <stop offset="1" stop-color="{glow}" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#fff" stop-opacity="0.75"/><stop offset="0.45" stop-color="#fff" stop-opacity="0.12"/>
    <stop offset="1" stop-color="#fff" stop-opacity="0.35"/>
  </linearGradient>
  <linearGradient id="glass" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#fff" stop-opacity="0.98"/><stop offset="0.55" stop-color="#fff" stop-opacity="0.82"/>
    <stop offset="1" stop-color="#fff" stop-opacity="0.62"/>
  </linearGradient>
  <linearGradient id="edge" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#fff" stop-opacity="1"/><stop offset="0.5" stop-color="#fff" stop-opacity="0"/>
  </linearGradient>
  <clipPath id="tile"><path d="{sq}"/></clipPath>
  <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
    <feGaussianBlur in="SourceAlpha" stdDeviation="12"/><feOffset dy="14"/>
    <feComponentTransfer><feFuncA type="linear" slope="0.38"/></feComponentTransfer>
  </filter>
  <filter id="frost" x="-10%" y="-10%" width="120%" height="120%">
    <feGaussianBlur in="SourceAlpha" stdDeviation="5" result="b"/>
    <feComposite in="SourceAlpha" in2="b" operator="arithmetic" k2="1" k3="-1" result="inner"/>
    <feFlood flood-color="#000" flood-opacity="0.22"/><feComposite in2="inner" operator="in" result="innerShade"/>
    <feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="innerShade"/></feMerge>
  </filter>
</defs>
<g clip-path="url(#tile)">
  <rect width="{R}" height="{R}" fill="url(#bg)"/>
  <rect width="{R}" height="{R}" fill="url(#bloom)"/>
  <g fill="#000" filter="url(#shadow)">{sym}</g>
  <g fill="url(#glass)" filter="url(#frost)">{sym}</g>
  <g fill="none" stroke="url(#edge)" stroke-width="3.2">{sym}</g>
</g>
<path d="{sq}" fill="none" stroke="url(#rim)" stroke-width="5"/>
</svg>'''.format(R=R, top=top, bottom=bottom, glow=glow, sq=sq, sym=sym)


def build(assets):
    car, left, right = glyph(assets, 'car'), glyph(assets, 'caret-left'), glyph(assets, 'caret-right')
    return [
        ('amn_hudlyrics', icon_svg('#7b6cff', '#2a1f9c', '#c9b8ff', [(glyph(assets, 'gauge'), 1.46, 69, 66)])),
        ('amn_iptv', icon_svg('#ff5a6e', '#a3123b', '#ffc2b8', [(glyph(assets, 'monitor-play'), 1.40, 77, 72)])),
        ('amn_sideview', icon_svg('#ffb84d', '#e05a00', '#fff1b0', [
            (car, 0.92, 138, 140), (left, 0.5, 46, 184), (right, 0.5, 338, 184)])),
    ]


def render(items):
    out = {}
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={'width': R, 'height': R}, device_scale_factor=1)
        for app, svg in items:
            pg.set_content('<html><body style="margin:0;background:transparent">' + svg + '</body></html>')
            path = '/tmp/_icon_%s.png' % app
            pg.screenshot(path=path, omit_background=True, clip={'x': 0, 'y': 0, 'width': R, 'height': R})
            out[app] = Image.open(path).convert('RGBA')
            os.remove(path)
        b.close()
    return out


if __name__ == '__main__':
    assets = sys.argv[1]
    imgs = render(build(assets))
    made = []
    for app, im in imgs.items():
        small = im.resize((140, 140), Image.LANCZOS)
        small.save(os.path.join(REPO, 'apps', app, 'icon.png'))
        made.append(im)
    if len(sys.argv) > 2:
        sheet = Image.new('RGBA', (3 * 300 + 20, 320), (12, 12, 14, 255))
        for i, im in enumerate(made):
            big = im.resize((260, 260), Image.LANCZOS)
            sheet.paste(big, (20 + i * 300, 30), big)
        sheet.save(sys.argv[2])
    print('ok')
