# 2026-10-27-solobtc-0.2.0

2026-10-27 07:17:45 - 2026-10-27 15:16:50 UTC, 7.9 h, pool solobtc.nmminer.com. One sample a minute of each miner's own figures and the pool's per-worker ones; raw data in [samples.csv](samples.csv), the page with the hashrate over the run in [report.html](report.html).

NMMiner nm-tv-154 against our firmware 0.2.0 on the devkit (then called esp32miner). NMMiner's API returned garbage hashrates (6e15 KH/s) in some samples: those are left out of its averages.

| | NMMiner | esp32miner ESP32-WROOM-32 |
|---|---:|---:|
| Hashrate, average | 1036.5 | 915.0 |
| Hashrate, lowest | 1018.8 | 914.0 |
| Hashrate, highest | 1045.0 | 916.0 |
| Pool estimate, average | 1041.2 | 876.1 |
| Pool estimate, median | 1023.0 | 872.1 |
| Shares accepted | 3356 | 2930 |
| Shares rejected | 32 | 41 |
| Rejected | 0.94% | 1.38% |
| Accepted per hour | 425.7 | 371.7 |
| Best difficulty | 7.118 | 6.858 |
| Best difficulty, pool | 7.12 | 6.86 |
| Restarts | 2 | 0 |
| Samples without an answer | 0 | 1 |
| Free memory, first | 51 KB | 133 KB |
| Free memory, last | 53 KB | 132 KB |
| Free memory, lowest | 34 KB | 125 KB |
| Wi-Fi signal | -68 dBm | -71 dBm |
| Samples | 474 | 474 |

Against NMMiner: esp32miner ESP32-WROOM-32 0.883 own hashrate, 0.841 pool estimate.
