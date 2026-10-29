# Benchmarks

Miners side by side on one pool, sampled every minute by [`tools/compare.py`](../tools/compare.py): each miner's
`/api/system/info` and the pool's per-worker numbers. A run's folder is named after the day it starts, the pool and our
firmware version. In it: `samples.csv` (the raw data), `run.json` (the pool, a note), `summary.md` (the table, readable on
GitHub) and `report.html` (the same with the hashrate over the run, in the dashboard's look; open it in a browser), both
made by [`tools/benchreport.py`](../tools/benchreport.py).

The miner's own figure is what it measures; the pool's estimate comes from accepted shares and is noisy over a few hours.
Our firmware was called esp32miner before 0.6.0. Only full runs (7.5 h and more, every miner answering) are kept; the
others are in HISTORY.md.

| Run | Window (UTC) | Pool | Miners | Own KH/s | Pool estimate KH/s | Rejected | |
|---|---|---|---|---|---|---|---|
| [2026-10-27-solobtc-0.2.0](2026-10-27-solobtc-0.2.0) | 2026-10-27 07:17 - 15:16, 7.9 h | solobtc.nmminer.com | NMMiner, esp32miner ESP32-WROOM-32 | 1036.5 / 915.0 | 1041.2 / 876.1 | 0.94% / 1.38% | [summary](2026-10-27-solobtc-0.2.0/summary.md) · [report](2026-10-27-solobtc-0.2.0/report.html) |
| [2026-10-27-solobtc-0.5.2](2026-10-27-solobtc-0.5.2) | 2026-10-27 23:57 - 10-28 07:37, 7.6 h | solobtc.nmminer.com | NMMiner, esp32miner ESP32-WROOM-32 | 1036.1 / 981.7 | 999.2 / 1002.1 | 1.34% / 0.95% | [summary](2026-10-27-solobtc-0.5.2/summary.md) · [report](2026-10-27-solobtc-0.5.2/report.html) |
| [2026-10-29-solobtc-0.9.0](2026-10-29-solobtc-0.9.0) | 2026-10-29 09:08 - 17:08, 8.0 h | solobtc.nmminer.com | NMMiner v2.0.04, 3BMiner ESP32-WROOM-32 0.9.0, 3BMiner ESP32-CAM 0.9.0 | 1035.2 / 1002.5 / 1002.6 | 989.2 / 1020.9 / 1013.6 | 1.14% / 0.23% / 0.46% | [summary](2026-10-29-solobtc-0.9.0/summary.md) · [report](2026-10-29-solobtc-0.9.0/report.html) |
