# BumbleBeam Miner for Mac: changes

## 0.3.3 (2026-10-13)

- Links keep the ordinary arrow cursor: the pointing hand landed off target inside the popover.
- Build copies of the app are kept out of Spotlight and Launchpad, so only the installed app shows.

## 0.3.2 (2026-10-13)

- Link cursor set the SwiftUI way (did not hold inside the popover; dropped in 0.3.3).

## 0.3.1 (2026-10-13)

- Links are plain buttons that open the browser.
- The MXBM line at the bottom of Settings is split in two: "GPU mining runs MXBM by maxnflaxl"
  and "MXBM dev fee: 1%, 36 sec per hour".
- Shorter caption under "Share average speed".

## 0.3.0 (2026-10-13)

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

## 0.2.0 (2026-10-12)

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

## 0.1.0 (2026-10-12)

- First build: a menu bar app for pool.bumblebeam.org.
- GPU mining with MXBM on Metal, CPU mining with bumblebeam-miner.
- A power slider from 10 to 100%. For the GPU it limits how many threadgroups MXBM keeps in
  flight (our MXBM patch), so the GPU works continuously at a lower draw: on an M5 Pro
  10.5 sol/s at 19.6 W at 100%, 0.9 sol/s at 3.7 W at 10%. For the CPU it picks the threads.
- First-run setup, the balance from the pool's API, keep-awake while mining, menu bar icon
  with play, pause and no-connection badges.
