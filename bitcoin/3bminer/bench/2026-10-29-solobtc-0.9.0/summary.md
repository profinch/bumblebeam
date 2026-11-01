# 2026-10-29-solobtc-0.9.0

2026-10-29 09:08:32 - 2026-10-29 17:08:32 UTC, 8.0 h, pool solobtc.nmminer.com. One sample a minute of each miner's own figures and the pool's per-worker ones; raw data in [samples.csv](samples.csv), the page with the hashrate over the run in [report.html](report.html).

NMMiner v2.0.04 against 3BMiner 0.9.0 on the devkit and the ESP32-CAM. The pool's vardiff gave our boards 0.0039 at times instead of 0.002: fewer, heavier shares, so compare the pool estimate, not the share counts.

| | NMMiner v2.0.04 | 3BMiner ESP32-WROOM-32 0.9.0 | 3BMiner ESP32-CAM 0.9.0 |
|---|---:|---:|---:|
| Hashrate, average | 1035.2 | 1002.5 | 1002.6 |
| Hashrate, lowest | 1010.7 | 963.0 | 978.0 |
| Hashrate, highest | 1044.8 | 1004.0 | 1003.0 |
| Engine | - | 970.7 | 970.8 |
| Software | - | 31.7 | 31.8 |
| Pool estimate, average | 989.2 | 1020.9 | 1013.6 |
| Pool estimate, median | 966.9 | 1017.6 | 1002.8 |
| Shares accepted | 3300 | 3016 | 3005 |
| Shares rejected | 38 | 7 | 14 |
| Rejected | 1.14% | 0.23% | 0.46% |
| Accepted per hour | 412.5 | 377.0 | 375.6 |
| Best difficulty | 31.78 | 10.53 | 6.389 |
| Best difficulty, pool | 31.78 | 10.53 | 6.39 |
| Restarts | 0 | 0 | 0 |
| Samples without an answer | 0 | 0 | 0 |
| Free memory, first | 48 KB | 126 KB | 3.22 MB |
| Free memory, last | 52 KB | 128 KB | 3.22 MB |
| Free memory, lowest | 42 KB | 117 KB | 3.21 MB |
| Wi-Fi signal | -57 dBm | -50 dBm | -49 dBm |
| Samples | 481 | 481 | 481 |

Against NMMiner: 3BMiner ESP32-WROOM-32 0.968 own hashrate, 1.032 pool estimate; 3BMiner ESP32-CAM 0.969 own hashrate, 1.025 pool estimate.
