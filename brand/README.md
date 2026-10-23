# BumbleBeam brand

The logo is `pool/web/favicon.svg` (animated); these are its static and social-media versions.

| File | What | For |
|---|---|---|
| `logo.svg`, `logo-512.png`, `logo-1024.png` | the logo, transparent background (its white trail wants a dark background) | anywhere |
| `avatar.svg`, `avatar-400/512/1024.png` | the logo on the site's dark blue, full bleed (platforms crop it to a circle) | X (400), Telegram, Discord, GitHub, Reddit (512/1024) |
| `avatar-800.mp4` | the avatar moving as the favicon does (wings 0.44 s, the trail blinking) | Telegram video avatar (a GIF of it: `src/README.md`) |
| `banner-1500x500.png` | header: honeycomb with a yellow wave, logo, "BEAM Community Ecosystem", https://bumblebeam.org | X header (static only) |
| `banner-1500x500.mp4` | the header animated | video posts (a GIF of it: `src/README.md`) |
| `banner-1024x576.png`, `banner-1920x640.png` | the header recomposed at 16:9 and 3:1, logo+text centred | video thumbnails, Telegram/Discord/GitHub headers |
| `banner-youtube-2560x1440.png` | YouTube channel art: logo+text inside the 1546×423 safe area, the honeycomb fills the TV frame | YouTube |

`src/` makes the animated files (headless Chrome + ffmpeg) and the other banner sizes (`src/banner_size.py`), see `src/README.md`.
