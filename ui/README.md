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
| [`components/bb.js`](components/bb.js) | web components: `<bb-logo>` (the animated bee on the chain's hexagon), `<bb-eco here="pool">` (the ecosystem bar; the site list lives here); and two helpers for page scripts: `BB.esc(text)` (safe in HTML content and quoted attributes) and `BB.short(address)` (first 8 and last 6 characters) |
| [`components/tips.js`](components/tips.js) | the sites' own tooltips: any element with a `title` gets them (mouse, focus, tap). Text that has a tip wears `.tipped` (dotted underline, help cursor); chips and status pills keep just the cursor |
| [`components/dd.js`](components/dd.js) | `BB.dropdown(el, onPick)`: the card list (`.dd`) in place of a native `<select>`, with `options([...])` for lists filled at run time. Never a native `<select>`: the browser draws its open list itself |
| [`components/confetti.js`](components/confetti.js) | the win's confetti with bees: `BB.confetti(el)` puts a canvas `.fw` after `el` (the page's CSS places it) |
| [`components/stepper.js`](components/stepper.js) | number steppers: any `<input type="number" class="stepper">` gets the accent up / down chevrons in place of the browser's spin buttons (hold to repeat); `BB.steppers(root)` for inputs added later |
| [`components/qr.js`](components/qr.js) | QR codes in the site's colours (the puzzle invite's look): `BB.qr(el, text, size)`, `BB.qrSave(text, name, at)` (a 1024 px png), `BB.qrBlob(text, at)` (the same png as a Blob, to share); needs [`vendor/qr-code-styling.js`](vendor) (MIT, its licence beside it) |
| [`charts/`](charts) | `charts.js`: sparkline, time-series line/area chart with crosshair, donut; see [charts/README.md](charts/README.md) |

## Chains

| | Beam (default) | Bitcoin |
|---|---|---|
| Switch | nothing | `<html data-chain="bitcoin">`, or `data-chain="bitcoin"` on a block (both chains on one page) |
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
<script src="ui/components/dd.js"></script>
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

## Opt-in pieces

Added after the pool's reference look (2026-11-02, from the puzzle site). Each acts only through its own
class, so a page without it looks exactly as before; a site turns one on when it wants it.

| Class | What |
|---|---|
| `.search.bad` | the header's search holding something it cannot open |
| `.foot .pill-status` | the footer's status pill with the help cursor (the pool's own rule, now shared) |
| `.log` | a few lines of what a long job is doing, scrolling; empty = not shown |
| `.actions-row` | buttons in a row with a note after them |
| `.check` | a checkbox with its words, in the accent |
| `.badge.dimmed` | a badge not (yet) earned |
| `.accent-text` | text in the accent |
| `.seg button:disabled` | a disabled segment |
| `.gauge` + `components/gauge.js` | a speedometer for one live rate (240° arc, needle, reading under the hub, optional log scale): `BB.gauge(el, {min, max, log, ticks, marks}).set(v, text, unit)`; marks are yardsticks outside the arc |
| `[hidden]` on `.tiles`, `.row`, `.actions-row`, `.note`, `.bar`, `.panel`, `.log` | these set their own `display`, so `hidden` alone did not hide them |

The 404 picture is generated per chain by `brand/src/gen404.py <out.svg> [beam|bitcoin]`; never recolour a copy by hand.
Each acts only through its own class, so pages that do not use it do not change.

| Class | What | First used by |
|---|---|---|
| `.page-lead` | a lead paragraph under the page title | pool connect page |
| `.howto` | an `<ol>`/`<ul>` of instructions in running text; its `<code>` is a small chip | pool connect page |
| `.faq` | questions that open in place: `<div class="faq"><details><summary>Q</summary><div>A</div></details>…</div>` | pool connect page |
| `code.mark` | a technical name in running text (`secp256k1`, `SHA-256`), in the chain's `--mark` (green on Bitcoin, yellow on Beam: never the links' colour); `.howto`, `.faq` and `.page-lead` code look the same | puzzle bench |
| `.log.term` (+ `.term-k` title) | a terminal: one height from the start, kept when empty, a blinking cursor after the last line | puzzle bench, play, pool |
| `.note.closable` + `.note-x` | a note with a close cross in its corner, the words kept clear of it | puzzle pool |
| `.bb-wait` | a value still on its way: `<span class="bb-wait"><i></i><i></i><i></i></span>`, three honeycomb cells lighting up in turn | puzzle bench, pool |
| `.bb-fade` | a value that has just come in fades in (add it again after a reflow for each new value) | puzzle bench |
| `.btn.swap` | A button whose word changes (`<span>Copy</span><span>Copied</span>`, `.done` shows the second) keeps one width for both |
| `.msg` (`.msg.bad`) | a short message in running text, a result or an error: mono, yellow (red), no frame; empty = hidden | wallet (3BMiner's style) |
| `.checks` | a list of checks or steps (`<ul class="checks"><li class="ok"><b>Name</b><span>what happened</span></li>…`), each line marked by its class: `ok` ✓, `bad` ✗, `warn` !, `wait` … (breathing), `off` –; the words go under the name on a phone | puzzle (a find's steps, /proof's Verify) |
| `<bb-socials>` / `.socials` | the social accounts as a row of icons (list and icons in `bb.js`; `only="x telegram"` picks some), grey until hover, then each network's colour (`--c`) | pool and explorer footers, puzzle |

## Status (2026-11-02)

| Site | On ui/ |
|---|---|
| pool (`beam/pool/web`) | yes: its `styles.css` keeps only pool-only rules (block-time bars, payouts table, trackers, the hashrate head) |
| explorer (`beam/explorer/web`) | yes: ui/ plus its own `explorer.css`; no longer copies the pool's stylesheet or tooltips |
| puzzle (`bitcoin/puzzle/web`) | yes, from day one: `data-chain="bitcoin"`, tokens, base, components, `bb.js`, `tips.js`, `dd.js`, the pool's header (search, Start, My stats) and footer, log, checks, the `.checks` list (a find's steps, /proof's Verify); its own `puzzle.css` keeps only the puzzle's pieces (target card, calculator, radar, the 160 table, the learning race, invite and claim) |
| thermo (`rig/thermo/web`) | yes: tokens, base, components, `bb.js` (ecosystem bar), `tips.js`; its install script copies them; the group charts stay thermo's own (threshold lines, series toggles, a tooltip with every series) in the `--chart-*` colours |
| NiceHash dashboard (private repo) | yes: links `/ui/` from the pool site, then the pool's `/styles.css`, and `/ui/components/tips.js` |
| 3BMiner (`bitcoin/3bminer/web`) | tokens: yes, `data-chain="bitcoin"`; its `web/build.py` inlines only the tokens the page uses (fails on a missing one). Components: not yet (`components.css` is too big for the firmware page as is) |
| wallet (`beam/wallet/extension`) | yes (0.2): tokens, base, components, `bb.js`, `dd.js`, `tips.js`, copied into the extension by `beam/wallet/sync-ui.sh`; its own `wallet.css` (popup frame, asset rows, lists, the bridge's route and fee choices, the dialog) |
| desktop miner | not yet |

The pool's look is the reference: `base.css` and `components.css` are its former shared rules with the
accent as tokens, checked against before/after screenshots of every pool and explorer page (desktop and
phone widths: no visual change). The vocabulary is the pool's: `.bar` is yellow, `.bar.accent` the accent;
`.pill-status` live / `.demo` / `.off`; a `.dd-list` is shown and hidden with the `hidden` attribute.
