# 3BMiner changelog

What changed per version. Which image ran where and what it measured: [HISTORY.md](HISTORY.md).

## 0.6.1 (not released yet)
- Hashrate history on the board: a sample a minute for 24 h (`GET /api/history`), averages for the last hour and day
  in `/api/system/info` (`avg1hKhs`, `avg24hKhs`, `historyMinutes`), the software hash counter (`swHashes`), and an
  all-time average across restarts (`avgAllKhs`, `allSeconds`; totals saved to NVS every 10 minutes).
- Solo or shared pool from the job itself: `stratum.solo` is true when the coinbase pays the configured address
  (bech32, bech32m, P2PKH and P2SH addresses), no list of pool names.
- The board's clock from NTP (pool.ntp.org) once Wi-Fi is up, as `identity.time` (Unix seconds, 0 until set).
- `/api/system/info` also gives the build time, ESP-IDF version and running slot (`identity.build`, `idf`, `slot`) and the live kernel and engine waits (`miner.kernel`, `miner.timing`).
- `GET /api/wifi/scan`: the access points in reach (SSID, BSSID, RSSI, channel), for picking the AP lock.
- Two time servers, pool.ntp.org and time.google.com as the fallback; `identity.ntp` names the one that answered.
- The clock's last NTP sync and its server in `/api/system/info` (`identity.ntpSync`, `identity.ntp`, with `identity.tz`).
- A time zone setting (`tz` in `/api/config`, a POSIX TZ string such as `GMT0BST,M3.5.0/1,M10.5.0`), applied to the board's clock.
- The new web UI (web-next) is the board's page: Dashboard, Swarm, Settings, Firmware and, on camera boards, Camera at
  `/`, `/swarm`, `/settings`, `/firmware`, `/camera`; minified, 23 KB gzipped. The old camera page is gone.
- Audit, robustness: pool messages checked before use (missing or non-string fields, extranonce1 over 16 bytes,
  extranonce2 size outside 1..8, coinbase or branch hex that is odd or does not fit, difficulty that is not a positive
  number) instead of crashing or mining a cut coinbase; `client.reconnect` reconnects (to the configured pool);
  send timeout and TCP keepalive on the pool socket; `stratum.authorized` in `/api/system/info`.
- Audit, settings: `POST /api/config` reads the whole body, checks every value (lengths, port 1..65535, no quotes,
  backslashes or control characters in strings that end up in JSON and stratum lines) and changes nothing when one
  is wrong, answering 400 with the reason.
- Audit, cross-site writes: POSTs that change the board (settings, restart, firmware, camera save) are refused with
  403 when the browser says they come from a site outside the LAN; the board's own page, other miners' pages on the
  LAN and a local preview file still work.
- Audit, OTA: the upload size is checked against the slot, only the image's size is erased, a stalled upload gives
  up after 10 timeouts; the camera's stream server is waited for before the camera stops.
- Audit, flash and RAM: the all-time totals are written to NVS from the main task instead of the timer task; Wi-Fi no
  longer keeps its own copy of the settings in NVS (`CONFIG_ESP_WIFI_NVS_ENABLED=n`, they come from the settings at
  every start); IPv6 off; only kernels 0 and 3 are built (k8, k7, k5, k4 removed, 1.3 KB of IRAM); `/api/bench?k=`
  takes 0 or 3.

## 0.6.0 (2026-10-28)
- Renamed from esp32miner, moved into the BumbleBeam repository. One source tree, one version, a build per board
  (`boards/<id>`, `tools/build.sh <id>`, `dist/3bminer-<board>-<version>.bin`); images name their board and OTA refuses
  an image for another board.
- AI-Thinker ESP32-CAM: the CameraWebServer API (`/capture`, `/bmp`, `/status`, `/control`, `/xclk`, `/reg`, `/greg`,
  `/pll`, `/resolution`, MJPEG `:81/stream`), the flash LED, settings kept in NVS, a camera page in the pool's style.
  Frame buffers and large allocations in PSRAM; the camera's grab task under lwip's priority, grabbing on demand.
- `mining` on/off in the settings (off by default on the camera board); stratum user agent `3BMiner/<version>`.
- Web pages are gzipped by the build instead of being kept in git.
- ESP32-CAM: OTA works (the camera is stopped while the image is written; it crashed the board before), mining runs
  next to the camera: ~981 KH/s idle, ~946 KH/s while streaming 640x480 at 24 fps (stratum stack in PSRAM, 8 KB
  mining stacks, internal RAM and its use in `/api/system/info` as `freeInternal`).

## 0.5.6 (2026-10-28)
- The pool's logo and favicon byte for byte; network difficulty from nbits; CORS on config, update and restart.
- Rejects sorted by the pool's error code (21 = job not found, i.e. stale).

## 0.5.2 (2026-10-27)
- Kernel with START after 6 header words and the hit test of the previous nonce inside the engine wait: 252
  cycles/nonce, ~952 KH/s engine (+2.9%). Socket limit 16 (httpd ran out of sockets), interrupt watchdog on, the
  on-board bench bails out on broken timings, `/api/swbench`.

## 0.4.0 (2026-10-27)
- Per-stage engine waits instead of one, tuned with `/api/bench` on the board: 260 cycles/nonce, ~925 KH/s (+4.5%).

## 0.3.0 (2026-10-27)
- Exact hit mask (128x fewer candidates), 20 ms stratum poll, shares for previous non-clean jobs, reject reasons and
  the reset reason in the API.

## 0.2.0 (2026-10-27)
- First release: asm kernel at 270 cycles/nonce (~885 KH/s), software hasher on core 1, stratum v1, NMMiner API, OTA.
