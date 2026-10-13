# BumbleBeam Miner.app

The Mac app of [BumbleBeam Miner](..): a menu bar app that mines Beam for
[pool.bumblebeam.org](https://pool.bumblebeam.org) on the GPU with
[MXBM](https://git.maxnflaxl.dev/maxnflaxl/MXBM) (Metal), or on the CPU with the console miner
`bumblebeam-miner` built from `..`. macOS 12 or later; one install for Apple Silicon, one for Intel.
It is released together with the console miner, under the same version (tags `miner-vX.Y.Z`).

## Install

Download `BumbleBeam-Miner-<version>-macOS-AppleSilicon.dmg` (M1 and later) or `-macOS-Intel.dmg`
from the [latest release](https://github.com/profinch/bumblebeam/releases/latest), open it and
drag the app to Applications. The app is not notarized yet: the first time, right-click it and choose Open (on
newer macOS: System Settings › Privacy & Security › Open Anyway). It lives in the menu bar only.

You need a public offline address from your Beam wallet; the worker name is up to you. GPU mining
runs MXBM, whose author takes a 1% dev fee (36 seconds an hour). The pool's fee is 0.5%, with a
1% bonus to whoever finds a block.

## Build

Needs Xcode with the Metal toolchain, CMake and Rust (targets aarch64- and x86_64-apple-darwin).

```sh
git clone https://git.maxnflaxl.dev/maxnflaxl/MXBM.git && cd MXBM && git am ../bumblebeam/miner/mxbm-patches/*.patch
cd ../bumblebeam/miner/mac
tools/build-mxbm.sh ../../../MXBM  # vendor/arm64/mxbm and vendor/x86_64/mxbm, OpenSSL linked in
./build.sh                         # build/BumbleBeam-Miner-<version>-macOS-AppleSilicon.dmg and -macOS-Intel.dmg
```

`../mxbm-patches/` holds the MXBM changes the apps rely on (macOS build fixes, `--report` on
Metal, the Metal load limit behind the power slider, Metal kernels for older macOS); they are sent
upstream. `build.sh` refuses a binary that needs a newer macOS than 12 or a library outside the
system. `--snapshot <dir>` renders the windows to PNG files without opening the menu bar.

## What it talks to

- Stratum: `stratum.bumblebeam.org:3443` (PPLNS) or `:3444` (SOLO), TLS.
- `GET /api/miners/<address>?worker=&since=`: balance, the pool's view of this worker, blocks.
- `GET /api/stats`: network hashrate, block reward and fee for the daily estimate.
- `POST /api/benchmarks`: only with "Share average speed" on; the Mac model and the average
  speed, no address.

The version comes from `../Cargo.toml`. Logs: `~/Library/Logs/BumbleBeam Miner/`. Changes:
[../CHANGELOG.md](../CHANGELOG.md).
