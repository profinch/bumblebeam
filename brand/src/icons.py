#!/usr/bin/env python3
"""App icons from the logo, filling their whole square.

    python3 brand/src/icons.py <out-dir> [--hex] [16 32 48 128 ...]

Default: the bee alone, as large as the square allows (its wings and body touch the edges), with a thin
outline in the Beam accent so its dark-blue body stays visible on a dark toolbar. The wallet extension's
icon (2026-11-05: "only the bee, as big as possible"). --hex: the whole logo, its hexagon from the top edge
to the bottom one (the logo's 32-unit box keeps 2 units of air around it).

Writes <out-dir>/icon.svg and <out-dir>/icon-<size>.png on a transparent background, rendered by headless
Chrome ($CHROME, else Playwright's chrome-headless-shell; on Linux/WSL `chrome --headless=new
--screenshot` hangs, the headless shell does not). Used for beam/wallet/extension/icons.
"""
import glob
import os
import subprocess
import sys
import tempfile

# the logo's bee alone (brand/logo.svg without the hexagon and the trail), the box cut to its outline;
# the body gets an accent edge (on the hexagon the gradient was its background)
BEE = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="BOX">
  <defs><clipPath id="c"><rect x="9.5" y="13.5" width="15" height="9" rx="4.5"/></clipPath></defs>
  <ellipse cx="14.5" cy="10.8" rx="3.6" ry="2.1" fill="#fff" stroke="#042548" stroke-width=".6" transform="rotate(-24 14.5 12.9)"/>
  <ellipse cx="20" cy="10.8" rx="3.6" ry="2.1" fill="#fff" stroke="#042548" stroke-width=".6" transform="rotate(24 20 12.9)"/>
  <rect x="9.5" y="13.5" width="15" height="9" rx="4.5" fill="#042548" stroke="#39fff2" stroke-width=".7"/>
  <g clip-path="url(#c)" fill="#f4ce4a"><rect x="13.3" y="13" width="3" height="10"/><rect x="18.6" y="13" width="3" height="10"/></g>
  <circle cx="22.6" cy="17" r=".95" fill="#39fff2"/>
</svg>
"""
BEE_BOX = '9.05 7.6 15.9 15.9'   # measured: the bee spans x 9.1-24.9, y 8.2-22.9

# brand/logo.svg with the viewBox cut to the hexagon's height (y 2..30), centred on it (x 2..30)
SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="2 2 28 28">
  <defs>
    <linearGradient id="g" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#0b76ff"/><stop offset="1" stop-color="#39fff2"/></linearGradient>
    <clipPath id="c"><rect x="9.5" y="13.5" width="15" height="9" rx="4.5"/></clipPath>
  </defs>
  <path d="M16 2 28 9v14L16 30 4 23V9z" fill="url(#g)"/>
  <g stroke="#fff" stroke-width="1.3" stroke-linecap="round">
    <path d="M4.5 20h3.5" stroke-opacity=".85"/>
    <path d="M3.5 23.5h2.5" stroke-opacity=".55"/>
  </g>
  <ellipse cx="14.5" cy="10.8" rx="3.6" ry="2.1" fill="#fff" fill-opacity=".9" stroke="#042548" stroke-width=".6" transform="rotate(-24 14.5 12.9)"/>
  <ellipse cx="20" cy="10.8" rx="3.6" ry="2.1" fill="#fff" fill-opacity=".9" stroke="#042548" stroke-width=".6" transform="rotate(24 20 12.9)"/>
  <rect x="9.5" y="13.5" width="15" height="9" rx="4.5" fill="#042548"/>
  <g clip-path="url(#c)" fill="#f4ce4a"><rect x="13.3" y="13" width="3" height="10"/><rect x="18.6" y="13" width="3" height="10"/></g>
  <circle cx="22.6" cy="17" r=".95" fill="#39fff2"/>
</svg>
"""


def chrome():
    if os.environ.get('CHROME'):
        return os.environ['CHROME']
    found = sorted(glob.glob(os.path.expanduser('~/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell')))
    if not found:
        sys.exit('no headless Chrome: set CHROME')
    return found[-1]


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    out = os.path.abspath(sys.argv[1])
    hexa = '--hex' in sys.argv[2:]
    sizes = [int(s) for s in sys.argv[2:] if s != '--hex'] or [16, 32, 48, 128]
    svg = SVG if hexa else BEE.replace('BOX', os.environ.get('BOX', BEE_BOX))
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, 'icon.svg'), 'w') as f:
        f.write(svg)
    with tempfile.TemporaryDirectory() as tmp:
        for n in sizes:
            page = os.path.join(tmp, f'{n}.html')
            with open(page, 'w') as f:
                f.write(f'<!doctype html><html><body style="margin:0;background:transparent">'
                        f'<img src="file://{out}/icon.svg" width="{n}" height="{n}" style="display:block"></body></html>')
            subprocess.run([chrome(), '--headless', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
                            '--default-background-color=00000000', f'--user-data-dir={tmp}/prof{n}',
                            f'--window-size={n},{n}', f'--screenshot={out}/icon-{n}.png', f'file://{page}'],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
            print(f'{out}/icon-{n}.png')


if __name__ == '__main__':
    main()
