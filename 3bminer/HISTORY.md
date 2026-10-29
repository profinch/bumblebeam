# 3BMiner history

Every image that ran on a board, when, how it got there and what it measured. What changed in each version is in
[CHANGELOG.md](CHANGELOG.md); the images up to 0.5.6 are kept outside git (`Downloads\esp32miner\v<version>` and
`~/esp/esp32miner-releases`), from 0.6.0 on `tools/build.sh` puts them in `dist/`.

## Versions

| Version | Date (UTC) | Image | Kernel, cycles/nonce | Hashrate (devkit) | Notes |
|---|---|---|---|---|---|
| 0.2.0 | 2026-10-27 | 873,888 B | 270 | 885 + 30 = 915 KH/s | first release as esp32miner; 8 h next to NMMiner: 0.84-0.88 of it, rejects 1.4% |
| 0.3.0 | 2026-10-27 | 876,848 B | 270 | 915 KH/s | share path fixed (exact mask, 20 ms poll, old jobs, reject reasons) |
| 0.3.1-0.3.2 | 2026-10-27 | | 270-283 | | on-board bench, per-stage waits, reset reason (dev builds) |
| 0.4.0 | 2026-10-27 | 878,736 B | 260 | 925 + 30 = 955 KH/s | per-stage waits 30/36/23/6/7 |
| 0.4.1-0.4.4 | 2026-10-27 | | | | kernel variants, socket limit, interrupt watchdog, bench bail-out (dev builds) |
| 0.5.0 | 2026-10-27 | 880,976 B | 253 | 951 + 29 = 980 KH/s | kernel hwmine_k6 (START after 6 words, deferred hit test) |
| 0.5.2 | 2026-10-27 | 881,440 B | 252 | 952 + 29 = 981 KH/s | 7.6 h next to NMMiner: device 982 vs 1036 KH/s, pool 1002 vs 999, rejects 0.95% vs 1.34% |
| 0.5.3 | 2026-10-28 | 881,504 B | 251 | 981 KH/s | rejects sorted by stratum code |
| 0.5.4-0.5.6 | 2026-10-28 | 883,840-884,976 B | 251 | 981 KH/s | network difficulty, gzipped pool-style page, the pool's logo and favicon |
| 0.6.0 | 2026-10-28 | devkit 886,384 B, esp32cam 1,036,976 B | 251 | devkit 981 KH/s; ESP32-CAM 981 idle, 946 streaming VGA | renamed 3BMiner, BumbleBeam repo, builds per board, ESP32-CAM; 5.4 h three-way run below |
| 0.7.0 | 2026-10-28 | see the flash log | 251 | 951 + 31 = 983 KH/s on both boards | developed as 0.6.1: history, solo detection, NTP and time zone, web-next as the page, code audit, best ever in NVS, camera stream 32 KB TCP buffer, microSD, audit 2 (LAN-only access, health checks, background swarm search), own SHA-256d software hasher |
| 0.8.0 | 2026-10-28 | devkit 883,472 B, esp32cam 1,091,952 B | 246-247 | 970 + 31 = ~1002 KH/s on both boards | engine waits 24/35/22/4/8, Scan network run by the board, Forget on the board, KH/s up to 10 MH/s |
| 0.9.0 | 2026-10-29 | devkit 884,640 B, esp32cam 1,093,152 B | 246-248 | 971 + 32 = ~1003 KH/s on both boards | best difficulty on high-difficulty pools (candidates down to 0.001), share wait on the dashboard, connectedAgo/shareAgo, page reloads after a restart |
| 0.10.0 | 2026-10-29 | devkit 887,312 B, esp32cam 1,095,808 B | 246-248 | ~1003 KH/s on both boards | hashrate by accepted shares, uptimeEver across restarts, dashboard and swarm polish (two-line values, tips), Firmware page in two columns with Supported boards, mining switch |

## Boards

| Board | MAC | Address | Flash backup |
|---|---|---|---|
| ESP32-WROOM-32 devkit (CP2102, COM6) | e4:65:b8:da:0e:98 | 192.168.88.228 (MikroTik), 192.168.1.16 before 2026-10-28 11:20 | NerdMiner V1.8.3 image, `Downloads\esp32s-board\backup-full-4MB.bin` |
| AI-Thinker ESP32-CAM on ESP32-CAM-MB (CH340, COM7) | e0:5a:1b:a6:76:28 | 192.168.88.69 (MikroTik), 192.168.1.231 before | CameraWebServer (arduino-esp32 3.3.6), `Downloads\esp32cam\original-full-4MB.bin` |

## Flash log

| When (UTC) | Board | Image | How |
|---|---|---|---|
| 2026-10-27 | devkit | 0.2.0 .. 0.5.2 | USB first, then OTA for each step |
| 2026-10-28 07:38 | devkit | 0.5.3 | OTA |
| 2026-10-28 08:18-08:20 | devkit | 0.5.4, 0.5.5, 0.5.6 | OTA (0.5.6 runs since) |
| 2026-10-28 10:58 | ESP32-CAM | 0.6.0 (esp32miner name, camera only) | USB, after the full backup |
| 2026-10-28 11:12-11:43 | ESP32-CAM | 0.6.0 (3BMiner) builds | USB and OTA while fixing OTA and internal RAM |
| 2026-10-28 11:43 | ESP32-CAM | 0.6.0, mining switched on | USB, then `POST /api/config {"mining":true}` |
| 2026-10-28 11:58 | devkit | 0.6.0 (3BMiner, from c2a1804) | OTA from 0.5.6; 981 KH/s, 251 cycles/nonce |
| 2026-10-28 17:29 | devkit | 0.6.1 (audit, web-next as the page), 894,752 B | OTA from 0.6.0; 981 KH/s, bench 251.7 cycles/nonce 0 bad in 1M, shares accepted, all pages without JS errors |
| 2026-10-28 17:47 | ESP32-CAM | 0.6.1 (audit, web-next) | OTA from 0.6.0; 5 NVS writes during a VGA stream: stream kept running, no restart |
| 2026-10-28 18:0x | ESP32-CAM | 0.6.1 builds | two OTA uploads with the camera running hung (camera stopped, image not written, no restart), the retries with the camera already stopped went through; since then a failed OTA restarts a camera board and OTA erases as it writes, later uploads with the camera running all passed |
| 2026-10-28 18:20-18:33 | ESP32-CAM | 0.6.1, TCP send buffer 32 KB / 64 KB | OTA; stream 1280x720 q4 3.9 -> 6.3 fps, 400x296 q4 21 -> 42 fps (first noted as UXGA and VGA: framesize 13 and 8 are HD and CIF); mining off measured no faster; 64 KB same as 32 KB |
| 2026-10-28 18:39-18:43 | ESP32-CAM | 0.6.1 with microSD | OTA; SanDisk 8 GB (SA08G) formatted FAT from the page in 5 s, photos written |
| 2026-10-28 18:44-19:23 | devkit, ESP32-CAM | 0.6.1 final page (loader fix) | OTA; both mining, best ever kept across the updates |
| 2026-10-28 19:30-21:54 | devkit, ESP32-CAM | 0.6.1 builds: audit 2, swarm search, own hasher | OTA; the camera "hangs" were it joining the Linksys (empty AP lock); hasher 5-9 -> 31 KH/s |
| 2026-10-28 21:59 | devkit, ESP32-CAM | 0.7.0, devkit 881,792 B, esp32cam 1,090,272 B | OTA; 983 KH/s on both, shares accepted |
| 2026-10-28 22:15-22:24 | devkit, ESP32-CAM | 0.7.1 (dev), engine waits 24/35/22/4/8 | OTA; devkit 1003 KH/s (971 + 32), 246 cycles/nonce |
| 2026-10-28 23:14 | devkit, ESP32-CAM | 0.8.0 (dev; 0.7.1 renamed), board-side subnet scan | OTA; 192.168.1.0 scanned by the camera in 31 s, NMMiner found on the first pass |
| 2026-10-29 07:53-07:57 | devkit, ESP32-CAM | 0.8.0 + unreleased (difficulty-0.001 candidates, share wait on the dashboard), on public-pool.io:21496 | OTA; pool difficulty 1, best difficulty moving (0.05-0.08 in 2 min), 246-248 cycles/nonce, 1003 KH/s |
| 2026-10-29 09:00 | devkit, ESP32-CAM | 0.9.0 | OTA; then pool.nerdminers.org (ckpool) for the next run: it answers 3BMiner's subscribe with "Only allowed user agents may subscribe" and closes (a user-agent allow-list set by its operator; NMMiner got in), so the run went to solobtc.nmminer.com instead; workers now devkit / devcam / nmminer |
| 2026-10-29 17:09-17:11 | devkit, ESP32-CAM | 0.10.0 | OTA after run9; uptimeEver 72,054 s (all-time), 248 cycles/nonce; then pool.solomining.de:3333 (public-pool fork): our boards in, NMMiner dropped at subscribe like on public-pool.io (it went back to solobtc); a run started like that was stopped |

## Comparisons

| Run | Window (UTC) | Miners | Result |
|---|---|---|---|
| run7-v0.6.0-three-miners-partial | 2026-10-28 12:00-17:25, 5.4 h (stopped early for the 0.6.1 test) | NMMiner v2.0.04, devkit 0.6.0, ESP32-CAM 0.6.0 | device 1036 / 981.5 / 980.8 KH/s, pool 1029 / 1005 / 996 KH/s, accepted 2057 / 1966 / 1972, rejects 1.34% / 1.16% / 1.45%, no restarts; `Downloads\miner-compare\run7-v0.6.0-three-miners-partial` |
| run8-v0.8.0-solobtc (not counted: NMMiner gone after 2.7 h) | 2026-10-28 23:23 - 10-29 07:22, 8 h | NMMiner v2.0.04, devkit 0.8.0, ESP32-CAM 0.8.0 | device 1036 / 1002.9 / 1002.6 KH/s (engine 970.9 + software 31.9 on both boards), pool 1037 / 992 / 1014 KH/s, rejects 1.06% / 1.03% / 1.00%, no restarts, heap flat; NMMiner off the network from 02:04 (2.7 h in), over its 2.7 h: pool 1054 / 956 / 1016, accepted 1121 / 1090 / 1133; `Downloads\miner-compare\run8-v0.8.0-solobtc-nmminer-dropped` |
| run9-v0.9.0-solobtc | 2026-10-29 09:08-17:08, 8 h, 481 samples each | NMMiner v2.0.04, devkit 0.9.0, ESP32-CAM 0.9.0 | device 1035.2 / 1002.5 / 1002.6 KH/s (engine 970.7-970.8 + software 31.7-31.8), pool 989 / 1021 / 1014 KH/s, accepted 3301 / 3033 / 3013, rejects 1.14% / 0.23% / 0.46%, best 31.78 / 10.53 / 6.39, no restarts, all answering all run (NMMiner at 192.168.88.68), heap flat; the pool's vardiff gave our boards 0.0039 at times (fewer, heavier shares); `bench/run9-v0.9.0-solobtc` |
