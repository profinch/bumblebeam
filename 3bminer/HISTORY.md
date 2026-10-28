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
| 0.6.1 | 2026-10-28 | devkit 895,536 B, esp32cam 1,103,728 B | 251 | devkit 952 + 30 = 981 KH/s; ESP32-CAM 951 + 9 = 960 KH/s | history, solo detection, NTP and time zone, web-next as the page, code audit, best ever in NVS, camera stream 32 KB TCP buffer, microSD |

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
| 2026-10-28 18:20-18:33 | ESP32-CAM | 0.6.1, TCP send buffer 32 KB / 64 KB | OTA; stream UXGA q4 3.9 -> 6.3 fps, VGA q4 21 -> 42 fps; mining off measured no faster; 64 KB same as 32 KB |
| 2026-10-28 18:39-18:43 | ESP32-CAM | 0.6.1 with microSD | OTA; SanDisk 8 GB (SA08G) formatted FAT from the page in 5 s, photos written |
| 2026-10-28 18:44-19:23 | devkit, ESP32-CAM | 0.6.1 final page (loader fix) | OTA; both mining, best ever kept across the updates |

## Comparisons

| Run | Window (UTC) | Miners | Result |
|---|---|---|---|
| run7-v0.6.0-three-miners-partial | 2026-10-28 12:00-17:25, 5.4 h (stopped early for the 0.6.1 test) | NMMiner v2.0.04, devkit 0.6.0, ESP32-CAM 0.6.0 | device 1036 / 981.5 / 980.8 KH/s, pool 1029 / 1005 / 996 KH/s, accepted 2057 / 1966 / 1972, rejects 1.34% / 1.16% / 1.45%, no restarts; `Downloads\miner-compare\run7-v0.6.0-three-miners-partial` |
