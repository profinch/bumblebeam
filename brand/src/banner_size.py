"""The static banner at another size: the same honeycomb, wave (frame 25), logo and text as frames.py's banner,
with the logo+text block centred and every element scaled by k (1.0 = the 1500x500 header's sizes).
python3 banner_size.py <W> <H> <k> <out.html> [u] [notext]   ->   then render.sh / headless Chrome at <W>,<H>
u = where the yellow wave sits, 0..1 along the slanted diagonal (frame 25 of the loop = 0.227; a very wide banner wants it nearer the centred block)
notext = the honeycomb and wave only: no logo, no text, nothing dimmed (a background)
  1024x576  k=1.0 (16:9)      1920x640  k=1.28 (3:1)     2560x1440  k=1.5 (YouTube: block inside the 1546x423 safe area)
  4000x192  k=0.7 u=0.33 (Reddit banner, any monitor width)     2160x256  k=0.9 (Reddit mobile banner, 2x of 1080x128)
  2560x1440 k=1.5 notext (honeycomb background)"""
import math, sys, os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import frames as F

SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
MONO = "ui-monospace, 'SF Mono', Menlo, monospace"


def banner(t, T, W, H, k=1.0, text=True):
    R = 30.0 * k
    hw, vs = math.sqrt(3) * R, 1.5 * R
    s = 5.6 * k                              # the logo: 32 units -> ~180 px at k=1
    logo_w, gap, text_w = 32 * s, 25 * k, 580 * k
    lx = (W - (logo_w + gap + text_w)) / 2   # the block centred
    tx = lx + logo_w + gap
    cy0 = H / 2
    cx0 = tx + text_w / 2 - 60 * k           # dim centre: cells under the text are dimmed for legibility
    cells = []
    row, y = 0, -R
    while y < H + R:
        x = -hw + (hw / 2 if row % 2 else 0)
        while x < W + hw:
            u = (x + 1.1 * y) / (W + 1.1 * H)
            band = max(0.0, math.cos(2 * math.pi * (u - t / T))) ** 14
            twinkle = 0.5 + 0.5 * math.sin(2 * math.pi * (t / T) + x * 0.013 + y * 0.021)
            d = math.hypot((x - cx0) / (430 * k), (y - cy0) / (150 * k))
            dim = min(1.0, max(0.18, d - 0.35)) if text else 1.0
            a = (0.5 * band + 0.03 * twinkle) * dim
            pts = " ".join(f"{x + R * 0.94 * math.cos(math.radians(60 * i - 30)):.1f},{y + R * 0.94 * math.sin(math.radians(60 * i - 30)):.1f}" for i in range(6))
            edge = 0.05 + 0.35 * band * dim
            cells.append(f'<polygon points="{pts}" fill="#f4ce4a" fill-opacity="{a:.3f}" stroke="#f4ce4a" stroke-opacity="{edge:.3f}" stroke-width="{1.2 * k:.2f}"/>')
            x += hw
        y += vs
        row += 1
    ly = cy0 - 16 * s
    block = "" if not text else f'''<g transform="translate({lx:.1f} {ly:.1f}) scale({s})">{F.bee(t, T)}</g>
<text x="{tx:.1f}" y="{cy0 + 10 * k:.1f}" font-family="{SANS}" font-weight="700" font-size="{96 * k:.1f}" fill="#fff">Bumble<tspan fill="url(#beam)">Beam</tspan></text>
<text x="{tx + 4 * k:.1f}" y="{cy0 + 62 * k:.1f}" font-family="{SANS}" font-size="{30 * k:.1f}" fill="rgba(255,255,255,.72)">BEAM Community Ecosystem</text>
<text x="{tx + 5 * k:.1f}" y="{cy0 + 108 * k:.1f}" font-family="{MONO}" font-weight="700" font-size="{24 * k:.1f}" fill="#00f6d2">https://bumblebeam.org</text>
'''
    return F.page(f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b5a85"/><stop offset=".55" stop-color="#042548"/><stop offset="1" stop-color="#031c38"/></linearGradient>
<linearGradient id="beam" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#0b76ff"/><stop offset="1" stop-color="#39fff2"/></linearGradient>{F.GRAD}{F.CLIP}</defs>
<filter id="glow" x="-5%" y="-20%" width="110%" height="140%"><feGaussianBlur in="SourceGraphic" stdDeviation="{7 * k:.1f}" result="b"/>
<feColorMatrix in="b" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1.4 0" result="g"/><feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<rect width="{W}" height="{H}" fill="url(#bg)"/>
<g filter="url(#glow)">{"".join(cells)}</g>
{block}</svg>''', W, H)


if __name__ == "__main__":
    W, H, k, out = int(sys.argv[1]), int(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
    u = float(sys.argv[5]) if len(sys.argv) > 5 else 25 / F.BF
    open(out, "w").write(banner(u * F.BT, F.BT, W, H, k, text="notext" not in sys.argv[6:]))
    print(out)
