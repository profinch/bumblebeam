"""Frames for BumbleBeam's animated avatar and the X/Twitter header (honeycomb shimmering to yellow).
python3 gen.py <outdir>  ->  <outdir>/avatar/f###.html, <outdir>/banner/f###.html (one SVG per frame)"""
import math, os, sys

OUT = sys.argv[1]
GRAD = '<linearGradient id="g" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#0b76ff"/><stop offset="1" stop-color="#39fff2"/></linearGradient>'
CLIP = '<clipPath id="c"><rect x="9.5" y="13.5" width="15" height="9" rx="4.5"/></clipPath>'


def tri(t, period):
    """0 -> 1 -> 0 over a period, linearly: SMIL's values="a;b;a" with its default linear interpolation"""
    p = (t / period) % 1.0
    return 2 * p if p < 0.5 else 2 - 2 * p


def bee(t, T):
    """the favicon's logo (32x32 units) at time t, moving as pool/web/favicon.svg does: the wings -32..-16 / 16..32 deg
    and back in 0.44 s, the trail's two lines .25..85 opacity in opposite phase over 1.5 s, both linear, no hover.
    The periods are rounded to divide the loop T (seamless): the nearest whole number of beats and blinks."""
    wp = T / max(1, round(T / 0.44))
    bp = T / max(1, round(T / 1.5))
    w = tri(t, wp)
    left, right = -32 + 16 * w, 16 + 16 * w
    b = tri(t, bp)
    o1, o2 = 0.25 + 0.6 * b, 0.85 - 0.6 * b
    dy = 0
    return f'''<path d="M16 2 28 9v14L16 30 4 23V9z" fill="url(#g)"/>
<g stroke="#fff" stroke-width="1.3" stroke-linecap="round"><path d="M4.5 20h3.5" stroke-opacity="{o1:.3f}"/><path d="M3.5 23.5h2.5" stroke-opacity="{o2:.3f}"/></g>
<g transform="translate(0 {dy:.3f})">
<ellipse cx="14.5" cy="10.8" rx="3.6" ry="2.1" fill="#fff" fill-opacity=".9" stroke="#042548" stroke-width=".6" transform="rotate({left:.2f} 14.5 12.9)"/>
<ellipse cx="20" cy="10.8" rx="3.6" ry="2.1" fill="#fff" fill-opacity=".9" stroke="#042548" stroke-width=".6" transform="rotate({right:.2f} 20 12.9)"/>
<rect x="9.5" y="13.5" width="15" height="9" rx="4.5" fill="#042548"/>
<g clip-path="url(#c)" fill="#f4ce4a"><rect x="13.3" y="13" width="3" height="10"/><rect x="18.6" y="13" width="3" height="10"/></g>
<circle cx="22.6" cy="17" r=".95" fill="#39fff2"/></g>'''


def page(svg, w, h):
    return f'<!doctype html><html><head><style>html,body{{margin:0;background:#031c38}}svg{{display:block}}</style></head><body>{svg}</body></html>'


def avatar(t, T, size):
    return page(f'''<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 100 100">
<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b5a85"/><stop offset="1" stop-color="#031c38"/></linearGradient>{GRAD}{CLIP}</defs>
<rect width="100" height="100" fill="url(#bg)"/><g transform="translate(9.05 8.4) scale(2.6)">{bee(t, T)}</g></svg>''', size, size)


def banner(t, T, W=1500, H=500):
    # pointy-top hexagons like the logo's; a yellow band sweeps across them once per loop (seamless: periodic in t)
    R = 30.0
    hw, vs = math.sqrt(3) * R, 1.5 * R
    cells = []
    cx0, cy0 = 860, 250  # the text block: cells under it are dimmed for legibility
    row = 0
    y = -R
    while y < H + R:
        x = -hw + (hw / 2 if row % 2 else 0)
        while x < W + hw:
            u = (x + 1.1 * y) / (W + 1.1 * H)  # v2: a steeper slant to the right
            band = max(0.0, math.cos(2 * math.pi * (u - t / T))) ** 14
            twinkle = 0.5 + 0.5 * math.sin(2 * math.pi * (t / T) + x * 0.013 + y * 0.021)  # a little life outside the band
            d = math.hypot((x - cx0) / 430, (y - cy0) / 150)
            dim = min(1.0, max(0.18, d - 0.35))
            a = (0.5 * band + 0.03 * twinkle) * dim  # v2: softer
            pts = " ".join(f"{x + R * 0.94 * math.cos(math.radians(60 * k - 30)):.1f},{y + R * 0.94 * math.sin(math.radians(60 * k - 30)):.1f}" for k in range(6))
            edge = 0.05 + 0.35 * band * dim
            cells.append(f'<polygon points="{pts}" fill="#f4ce4a" fill-opacity="{a:.3f}" stroke="#f4ce4a" stroke-opacity="{edge:.3f}" stroke-width="1.2"/>')
            x += hw
        y += vs
        row += 1
    s = 5.6  # the logo: 32 units -> ~180 px
    lx, ly = 445, cy0 - 16 * s
    return page(f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b5a85"/><stop offset=".55" stop-color="#042548"/><stop offset="1" stop-color="#031c38"/></linearGradient>
<linearGradient id="beam" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#0b76ff"/><stop offset="1" stop-color="#39fff2"/></linearGradient>{GRAD}{CLIP}</defs>
<filter id="glow" x="-5%" y="-20%" width="110%" height="140%"><feGaussianBlur in="SourceGraphic" stdDeviation="7" result="b"/>
<feColorMatrix in="b" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1.4 0" result="g"/><feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<rect width="{W}" height="{H}" fill="url(#bg)"/>
<g filter="url(#glow)">{"".join(cells)}</g>
<g transform="translate({lx} {ly}) scale({s})">{bee(t, T)}</g>
<text x="650" y="{cy0 + 10}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-weight="700" font-size="96" fill="#fff">Bumble<tspan fill="url(#beam)">Beam</tspan></text>
<text x="654" y="{cy0 + 62}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="30" fill="rgba(255,255,255,.72)">BEAM Community Ecosystem</text>
<text x="655" y="{cy0 + 108}" font-family="ui-monospace, 'SF Mono', Menlo, monospace" font-weight="700" font-size="24" fill="#00f6d2">https://bumblebeam.org</text>
</svg>''', W, H)


def write(kind, n, make):
    d = os.path.join(OUT, kind)
    os.makedirs(d, exist_ok=True)
    for i in range(n):
        open(os.path.join(d, f"f{i:03d}.html"), "w").write(make(i))


AT, AF = 4.4, 110          # avatar: 4.4 s loop = 10 wing beats of 0.44 s + 3 blinks of 1.47 s (favicon: 1.5), 25 fps
BT, BF = 4.4, 110          # banner: the same 4.4 s loop, 25 fps
write("avatar", AF, lambda i: avatar(i * AT / AF, AT, 800))
write("banner", BF, lambda i: banner(i * BT / BF, BT))
print("frames written")
