# BumbleBeam Miner for Windows and Linux

The tray app of [BumbleBeam Miner](..), the same as the Mac app ([`../mac`](../mac)) in a
webview ([Tauri](https://tauri.app)): it mines Beam for [pool.bumblebeam.org](https://pool.bumblebeam.org)
on the GPU with [MXBM](https://git.maxnflaxl.dev/maxnflaxl/MXBM) (CUDA on NVIDIA, OpenCL on
others) or on the CPU with the console miner. It is released with the console miner and the Mac
app under one version (tags `miner-vX.Y.Z`).

## Install

From the [latest release](https://github.com/profinch/bumblebeam/releases/latest):

- Windows 10/11 x64: `BumbleBeam-Miner-<version>-Windows-x64-setup.exe`, installed for the current
  user. It is not code-signed yet, so SmartScreen may warn: More info › Run anyway.
  Or `BumbleBeam-Miner-<version>-Windows-x64-portable.zip`: unpack it anywhere and run
  `BumbleBeam Miner.exe`, nothing to install (settings and logs go to the same places).
- Linux x86-64: `BumbleBeam-Miner-<version>-Linux-x86_64.deb` (Debian, Ubuntu, Mint:
  `sudo apt install ./BumbleBeam-Miner-*.deb`) or the `.AppImage` (`chmod +x` and run). The tray
  icon needs AppIndicator support: built into Cinnamon, KDE and most desktops; GNOME needs the
  AppIndicator extension.

GPU mining needs the card's driver (NVIDIA: CUDA comes with it). You need a public offline
address from your Beam wallet.

## The power slider

- NVIDIA: it sets the board's power limit, from the card's minimum at 10 % to its default at
  100 %, which is what lowers the draw (an RTX 3090 at 200 W: 32 sol/s drawing 198 W). That
  needs administrator rights, asked once per mining session for the small helper `bb-power`:
  Windows shows a UAC prompt; on Linux the .deb installs a polkit rule
  (`linux/org.bumblebeam.miner.power.policy`) that lets the desktop user run it without a
  password, the AppImage asks for it. The limit goes back to the default when mining stops, the
  app quits or crashes.
- Without those rights, and on other GPUs: fewer GPU blocks run at once (MXBM_LOAD, our patch
  0006), which lowers the speed but hardly the draw; the window says so.
- CPU: the number of threads.

## Build

Needs Rust and Node (for the Tauri CLI); on Linux `libwebkit2gtk-4.1-dev
libayatana-appindicator3-dev librsvg2-dev`. CI (`.github/workflows/desktop.yml`) builds MXBM
with `../mxbm-patches` for CUDA and OpenCL and the installers. By hand, put the bundled
programs in `src-tauri/binaries/` as `<name>-<target triple>` (mxbm, bumblebeam-miner from `..`,
bb-power from `bb-power/`), then:

```sh
npx @tauri-apps/cli@2 build
```

`tools/icons.sh` (on a Mac) redraws the icons. Logs: `~/.local/share/org.bumblebeam.miner/logs/`
on Linux, `%APPDATA%\org.bumblebeam.miner\logs\` on Windows. Changes: [../CHANGELOG.md](../CHANGELOG.md).
