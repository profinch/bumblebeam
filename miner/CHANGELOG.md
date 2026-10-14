# BumbleBeam Miner: changes

BumbleBeam Miner is the console miner `bumblebeam-miner` (Linux, Windows, macOS; the CPU) and the
Mac app BumbleBeam Miner.app (the menu bar; MXBM on the GPU or this miner on the CPU), released
together under one version with tags `miner-vX.Y.Z`. Before 0.4.0 the app had its own versions,
kept below as "Mac app".

## 0.5.1 (2026-10-14)

- Windows: the app answers the terminal's cursor position query that ConPTY sends as the miner
  starts. Without the answer ConPTY held all of the miner's output, so the window stayed at
  Starting with no speed or shares (0.5.0 was withdrawn for this).
- Windows portable: `BumbleBeam-Miner-<version>-Windows-x64-portable.zip`, the app and its
  programs in one folder, run without installing.

## 0.5.0 (2026-10-13, withdrawn)

- BumbleBeam Miner for Windows and Linux: the Mac app's tray app (miner/desktop, Tauri), with
  MXBM on NVIDIA (CUDA) and other GPUs (OpenCL) or the console miner on the CPU. Installers:
  `BumbleBeam-Miner-<version>-Windows-x64-setup.exe`, `-Linux-x86_64.deb` and `.AppImage`.
- The power slider on NVIDIA sets the board's power limit, which is what lowers the draw there
  (an RTX 3090 at 239 W draws 238 W); it needs administrator rights once per mining session (UAC
  on Windows; on Linux the .deb's polkit rule allows it without a password, the AppImage asks).
  The limit goes back to the default when mining stops or the app is gone. Without the rights
  the slider runs fewer GPU blocks at once (MXBM_LOAD), and the window says that this lowers the
  speed but hardly the draw.
- MXBM patches in `miner/mxbm-patches/`, now with the CUDA load limit (0006).
- The Mac app is as in 0.4.0, under the new version.

## 0.4.0 (2026-10-13)

- One product, one version: the console miner and the Mac app come in the same release.
- Console miner: a macOS Intel (x86_64) build; the macOS builds run on macOS 12 and later;
  archives are named `bumblebeam-miner-<version>-<os>-<arch>`.
- Mac app: lives in `miner/mac/`; installs are `BumbleBeam-Miner-<version>-macOS-AppleSilicon.dmg`
  and `-macOS-Intel.dmg`; the app itself is as in Mac app 0.3.3.

## Mac app 0.3.3 (2026-10-13)

- Links keep the ordinary arrow cursor: the pointing hand landed off target inside the popover.
- Build copies of the app are kept out of Spotlight and Launchpad, so only the installed app shows.

## Mac app 0.3.2 (2026-10-13)

- Link cursor set the SwiftUI way (did not hold inside the popover; dropped in 0.3.3).

## Mac app 0.3.1 (2026-10-13)

- Links are plain buttons that open the browser.
- The MXBM line at the bottom of Settings is split in two: "GPU mining runs MXBM by maxnflaxl"
  and "MXBM dev fee: 1%, 36 sec per hour".
- Shorter caption under "Share average speed".

## Mac app 0.3.0 (2026-10-13)

- Runs on macOS 12 and later. Two installs: Apple Silicon and Intel.
- mxbm is built with OpenSSL linked in and its Metal kernels for Metal 2.4, so it needs no
  Homebrew library and no macOS 26; same speed and the same verified solutions.
- The power figure next to the slider is the miner's own GPU draw, not the whole GPU's.
- Settings: "Start mining at login" (macOS 13+) and "Share average speed" (off by default:
  sends the Mac model and the average speed, no address, to the pool's /api/benchmarks).
- "Blocks found this session" is counted by the pool, for this Mac's worker since Start.
- The rate card says when the pool site does not answer or why the miner is not connected,
  without moving anything else in the window.
- Stop no longer freezes the window; a miner that fails to start is retried every 10 s; the log
  rotates at 5 MB while mining.
- A miner left running by a crash or force quit is stopped at the next launch; kill, logout and
  Ctrl-C stop the miner before the app exits.
- No speeds of one particular Mac built into the app.

## Mac app 0.2.0 (2026-10-12)

- The logo moves as on the pool site: the bee bobs, its wings flutter, the trail streams, the
  eye blinks.
- One window size for every screen; the power scale's numbers sit under the slider's marks.
- "pool shows" next to the miner's own rate; Unpaid, Immature, Shares, Est. per day and
  Blocks found (this session and total).
- Keep Mac awake while mining: off on battery, back on with the adapter.
- Only public offline Beam addresses are accepted, checked by the Beam wallet's own rules.
- Copy, paste and select all work in the text fields.
- Settings: Pool mode (PPLNS or SOLO), show sol/s in the menu bar, the app's version.
- Shares and speed reach the window as the miner reports them (the miner writes to a
  pseudo-terminal, not a block-buffered pipe).

## Mac app 0.1.0 (2026-10-12)

- First build: a menu bar app for pool.bumblebeam.org.
- GPU mining with MXBM on Metal, CPU mining with bumblebeam-miner.
- A power slider from 10 to 100%. For the GPU it limits how many threadgroups MXBM keeps in
  flight (our MXBM patch), so the GPU works continuously at a lower draw: on an M5 Pro
  10.5 sol/s at 19.6 W at 100%, 0.9 sol/s at 3.7 W at 10%. For the CPU it picks the threads.
- First-run setup, the balance from the pool's API, keep-awake while mining, menu bar icon
  with play, pause and no-connection badges.

## 0.1.0 (2026-10-07)

- The console miner: BeamHash III on the CPU with bucketed rounds, about a hundred times faster
  than the Beam core's reference solver, every solution checked by the oracle before it is sent.
- Beam stratum to any pool, TLS by default; `bench` and `check` commands; refuses to start without
  about 7 GB of free memory rather than dying mid-run.
- Builds for Linux x86-64, macOS (Apple Silicon) and Windows x86-64.
