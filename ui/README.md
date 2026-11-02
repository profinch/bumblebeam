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
| [`components/tips.js`](components/tips.js) | the sites' own tooltips: any element with a `title` gets them (mouse, focus, tap) |
| [`charts/`](charts) | `charts.js`: sparkline, time-series line/area chart with crosshair, donut; see [charts/README.md](charts/README.md) |

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
<script src="ui/components/tips.js"></script>
<script src="ui/charts/charts.js"></script>
<!-- the site's own CSS after, for what is only its own -->
```

No build tool of its own: each site takes `ui/` the way it already ships.

| Site ships as | How it takes `ui/` | Sites |
|---|---|---|
| a Docker image built by CI from the repo root | `COPY ui/ /usr/share/nginx/html/ui/` in its Dockerfile; links carry `?v=dev`, which the Dockerfile's existing `sed` turns into the release version. Also `!ui` in the root `.dockerignore` (a whitelist) and `ui/**` in `.github/workflows/images.yml` paths, so a ui change rebuilds the images | pool, explorer, puzzle |
| files copied to a box | its install script copies `ui/` next to the page | thermo, NiceHash dashboard |
| one gzipped page in firmware | its own `web/build.py` reads the `ui/` files into the page, as it already does with `{{LOGO}}` | 3BMiner |
| an extension or desktop bundle | the `ui/` files copied into the bundle at packaging | wallet, desktop miner |
| SwiftUI | the colours copied into its `Theme.swift` from `tokens.css` (a generator when it migrates) | Mac miner |

A site keeps only what is its own in its own CSS; anything a second site needs moves here.

## Status (2026-11-02)

| Site | On ui/ |
|---|---|
| pool (`beam/pool/web`) | yes: its `styles.css` keeps only pool-only rules (block-time bars, payouts table, trackers, the hashrate head) |
| explorer (`beam/explorer/web`) | yes: ui/ plus its own `explorer.css`; no longer copies the pool's stylesheet or tooltips |
| puzzle (`bitcoin/puzzle/web`) | yes, from day one: `data-chain="bitcoin"`, tokens, base, components, `bb.js`, `tips.js`; its own `puzzle.css` (header without search, target card, calculator, radar) |
| thermo (`rig/thermo/web`) | yes: tokens, base, components, `bb.js` (ecosystem bar), `tips.js`; its install script copies them; the group charts stay thermo's own (threshold lines, series toggles, a tooltip with every series) in the `--chart-*` colours |
| NiceHash dashboard (private repo) | yes: links `/ui/` from the pool site, then the pool's `/styles.css`, and `/ui/components/tips.js` |
| 3BMiner (`bitcoin/3bminer/web`) | tokens: yes, `data-chain="bitcoin"`; its `web/build.py` inlines only the tokens the page uses (fails on a missing one). Components: not yet (`components.css` is too big for the firmware page as is) |
| desktop miner, wallet | not yet |

The pool's look is the reference: `base.css` and `components.css` are its former shared rules with the
accent as tokens, checked against before/after screenshots of every pool and explorer page (desktop and
phone widths: no visual change). The vocabulary is the pool's: `.bar` is yellow, `.bar.accent` the accent;
`.pill-status` live / `.demo` / `.off`; a `.dd-list` is shown and hidden with the `hidden` attribute.
