# Benchmarks

Miners side by side on one pool, sampled every minute by [`tools/compare.py`](../tools/compare.py): each device's
`/api/system/info` and the pool's per-worker numbers. `samples.csv` is the raw data, `summary.txt` the averages.
The pool's estimate comes from accepted shares, so it is noisy over a few hours; the device figure is what the miner
measures itself. Runs before 0.6.0 call the firmware esp32miner. Only full runs (7.5 h and more) are kept here; the
shorter ones of 2026-10-27/28 are in HISTORY.md.

| Run | Window (UTC) | Pool | Miners | Device KH/s | Pool est. KH/s | Rejects |
|---|---|---|---|---|---|---|
| [run1-v0.2.0](run1-v0.2.0) | 2026-10-27, 8 h | solobtc.nmminer.com | NMMiner nm-tv-154, esp32miner 0.2.0 | -* / 915 | 1041 / 876 | 0.94% / 1.38% |
| [run3-v0.5.2](run3-v0.5.2) | 2026-10-27 23:57 - 10-28 07:37, 7.6 h | solobtc.nmminer.com | NMMiner v2.0.04, esp32miner 0.5.2 | 1036 / 982 | 999 / 1002 | 1.34% / 0.95% |
| [run8-v0.8.0-solobtc](run8-v0.8.0-solobtc) | 2026-10-28 23:23 - 10-29 07:22, 7.7 h | solobtc.nmminer.com | NMMiner v2.0.04 (first 2.7 h only**), 3BMiner 0.8.0 devkit, 3BMiner 0.8.0 ESP32-CAM | 1036 / 1003 / 1003 | 1037 / 992 / 1014 | 1.06% / 1.03% / 1.00% |

\* NMMiner's API returned garbage hashrates in that run (6e15).

\*\* NMMiner fell off the network at 02:04 UTC and stayed off; over the window it was up, device 1036 / 1003 / 1003 KH/s, pool 1054 / 956 / 1016 KH/s, accepted 1121 / 1090 / 1133. Both 3BMiner boards ran the full 7.7 h with no restarts.
