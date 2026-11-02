# BumbleBeam · Bitcoin

The Bitcoin direction of [BumbleBeam](../README.md).

| Part | What it is | Status |
|---|---|---|
| [`3bminer/`](3bminer) | 3BMiner: open firmware for ESP32 boards that mines Bitcoin solo on the chip's SHA-256 engine (~1 MH/s on an ESP32-WROOM-32, NMMiner-compatible API) and keeps the board's own job, such as the ESP32-CAM's camera. One source, a build per board; releases tagged `3bminer-v*` | see its [CHANGELOG](3bminer/CHANGELOG.md) |
| [`puzzle/`](puzzle) | [puzzle.bumblebeam.org](https://puzzle.bumblebeam.org): the Bitcoin puzzle live from our node (status of all 160, odds calculator, radar); next, a coordinated search for the keys in the browser (WebGPU) and on GPUs | stage 1 live |
