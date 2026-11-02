# Public repository

Everything here is public. Never commit the owner's personal data or private infrastructure: real names, personal
e-mail addresses, home or private host names and IP addresses, LAN addresses and MACs of real devices, the owner's
wallet addresses, local paths (home directories, Downloads), workplace details. Examples use `192.168.0.x`,
standard example addresses (BIP-173) and placeholders; contacts are `support@bumblebeam.org` / `info@bumblebeam.org`.
Names and addresses in bumblebeam.org's public DNS are fine.

The owner's clones run a pre-commit / commit-msg guard with a private list; if it stops a commit, rephrase
rather than bypass it.

# Design: ui/ first

Every site and app looks the way `ui/` makes it (tokens, base, components, `bb.js`, `tips.js`, `dd.js`, charts;
see `ui/README.md` and `ui/showcase/index.html`). Before writing CSS or a widget for a site, look there.

- Anything a second site could use goes into `ui/`, not into the site's own CSS. Add it as an opt-in piece that
  acts only through its own class, so the sites already on `ui/` do not change, and list it in `ui/README.md`
  under "Opt-in pieces".
- Never redefine a `ui/` rule in a site's CSS with other values (a site's `.note.bad` must look like every
  other's). A site's CSS keeps only what is that site's own; remove dead CSS when a page changes.
- Follow the pool's patterns: the header, the footer (links, the status pill, the copyright line), the 404
  page ("Not found" over the panel, the honeycomb picture), page titles ("What it is | BumbleBeam"), the brand
  word (`<span class="word">Bumble<b>Beam</b> <i class="sub-word">Site</i></span>`), text with a tip wears
  `.tipped`. No native `<select>`: use the card list (`.dd`, `ui/components/dd.js`).
- Generated assets come from their generator (`brand/src/`, e.g. `gen404.py <out> [beam|bitcoin]`), never a
  hand-recoloured copy.
- After changing `ui/`: compare before/after screenshots of the pool and the explorer (1400 and 390 px; they
  must not change beyond live data), and update the status table in `ui/README.md`.
