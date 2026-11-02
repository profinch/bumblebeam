# BumbleBeam · UI

The one design library for every BumbleBeam site and app: one brand (the dark Beam blue, system type,
the components), an accent per chain. No framework, no npm, no network: plain CSS and classic
scripts, so the same files work in a Docker-served site, a page copied to a box, the ESP32 firmware
page, the MV3 wallet extension and Chromium 83 (the Beam desktop wallet's browser).

Open [`showcase/index.html`](showcase/index.html) straight from disk to see every piece in both
accents (`#bitcoin` in the URL starts in the Bitcoin one).

| File | What |
|---|---|
| [`tokens.css`](tokens.css) | colours, type scale, spacing, radii, chart colours; the chain accents |
| [`base.css`](base.css) | the page: gradient background, type, links, focus, thin scrollbars, reduced motion |
| [`components.css`](components.css) | ecosystem bar, header, panels, tiles, tables, buttons, pills, badges, fields, card list, notes, code, steps, chart and donut styles, footer |
| [`components/bb.js`](components/bb.js) | web components: `<bb-logo>` (the animated bee on the chain's hexagon), `<bb-eco here="pool">` (the ecosystem bar; the site list lives here) |
| [`charts/`](charts) | `charts.js`: sparkline, time-series line/area chart with crosshair, donut; see [charts/README.md](charts/README.md) |
| [`build.py`](build.py) | delivers the library into a site: `copy`, `inline`, `swift` |

## Chains

| | Beam (default) | Bitcoin |
|---|---|---|
| Switch | nothing | `<html data-chain="bitcoin">` |
| `--accent` | `#00f6d2` | `#f7931a` |
| `--gradient-accent`, logo hexagon | `#0b76ff → #39fff2` | `#f7931a → #ffc46b` |
| Sites | pool, explorer, wallet, desktop miner, DEX | puzzle, 3BMiner |

thermo and other rig tools take the default. Everything else (background, surfaces, text, red,
yellow, the chart series) is the same on both chains. Write the accent only as `var(--accent)` or
`rgba(var(--accent-rgb), a)`, never as a literal, or a page will not follow its chain.

## Scales

| Tokens | Values |
|---|---|
| Type `--fs-xs/s/m/base/body/l/xl` | 10 / 11 / 12 / 13 / 14 / 19 / 22 px |
| Spacing `--sp-1..6` | 4 / 8 / 12 / 16 / 24 / 36 px |
| Radii `--radius-s/m/l/pill` | 4 / 6 / 8 / 999 px |
| Breakpoints (numbers only: media queries cannot read variables) | 480 phone, 820 tablet, 1080 narrow desktop |

## Using it in a site

Link the files relative to the page (or `ui/ui.css`, the three CSS files in one):

```html
<link rel="stylesheet" href="ui/tokens.css">
<link rel="stylesheet" href="ui/base.css">
<link rel="stylesheet" href="ui/components.css">
<script src="ui/components/bb.js"></script>
<script src="ui/charts/charts.js"></script>
<!-- the site's own CSS after, for what is only its own -->
```

Then deliver the library the way the site ships:

| Site ships as | Command | Sites |
|---|---|---|
| files (a Docker image, files copied to a box) | `ui/build.py copy <site dir>` → `<site dir>/ui/` with `VERSION` | pool, explorer, thermo, NiceHash dashboard, puzzle |
| one HTML file | `ui/build.py inline in.html out.html` | 3BMiner firmware page, wallet popup |
| SwiftUI | `ui/build.py swift Theme.generated.swift` | Mac miner |

A site keeps only what is its own in its own CSS; anything a second site needs moves here.

## Status (2026-11-02)

The library exists; no site uses it yet. Migration, one site at a time, each checked against
screenshots before and after: pool and explorer first (live), then puzzle (built on it from the
start), thermo, NiceHash dashboard, desktop miner, wallet, 3BMiner. The 2026-11-02 audit found the
palette in 8+ copies under four naming schemes, about 20 font sizes, 12 radii and 11 breakpoints;
this library is the pool's set, tokenised.
