# 3BMiner changelog

What changed per version. Which image ran where and what it measured: [HISTORY.md](HISTORY.md).

## 0.8.0 (not released yet)
- Swarm: Scan network asks the board to scan the subnet (`POST /api/swarm/scan {"ip":"a.b.c.0"}`, `/alive` says
  `"scanning"`): 8 connects at a time, 0.8 s each, ~31 s for a /24, the found miners in its list. The browser scan missed
  miners: an aborted fetch leaves Chrome's connection attempt to an empty address alive until the OS gives up (~21 s), 254
  of them fill its socket pool, and the probes behind wait past their timeout. Boards without it are scanned from the
  browser as before. The board's own background pass uses the same parallel scan; `LWIP_MAX_SOCKETS` 20 -> 32.
- Engine waits 24/35/22/4/8 instead of 25/36/23/6/8: 246.75 cycles a nonce instead of 251.77 (+2%, ~972 KH/s from the
  engine), as few engine errors over ~100M nonces each (2 against 4); 23 for the first wait gives 10-16 errors in 16M.
  On the ESP32-CAM the same (5 against 11 errors in 64M); a running stream adds ~10-20 errors per 16M with either timing.
- Swarm: a miner on another subnet was found only by the second network scan (its first answer to the router's ARP came
  the 1.5 s probe timeout; 3 s now, 32 at a time (see above for the real cause and fix). The board's own search waits 0.8 s.
- Swarm: Forget asks first, and the board drops the miner too (`POST /api/swarm/forget`); before, it came back from the
  board's list on the next page load.
- The web server's health check restarts after 5 misses in a row (2.5 minutes) instead of 4, and waits while a long request holds it (engine check, card format): back-to-back engine
  checks no longer read as a hung server and restart the board.

## 0.7.0 (2026-10-28)
Developed as 0.6.1 (the images flashed during the day report that number).
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
- The best share ever (`bestDiffEver`) is kept in NVS: it survives restarts and firmware updates.
- ESP32-CAM stream speed: the limit was the 5.7 KB TCP send buffer (~290 KB/s at any frame size); 32 KB, with Wi-Fi and
  lwip buffers in PSRAM: 1280x720 quality 4 3.9 -> 6.3 fps, 400x296 quality 4 21 -> 42 fps, quality 10 40 -> 49 fps,
  internal RAM free 76 -> 104 KB. Mining on or off made no measurable difference (they share no core).
- ESP32-CAM microSD (1-bit SDMMC, the flash LED keeps GPIO4): `GET /api/sd` (card, size, free), `POST /api/sd/format`,
  `POST /api/sd/snap` (a photo to `photos/<date>_<time>.jpg`); a Memory card panel on the Camera tab.
- A failed OTA restarts a camera board (the camera did not always come back in place); OTA erases as it writes.
- Settings: Mining on/off; Wi-Fi fields in the order network name, password, device name, the AP lock on its own row.
  Swarm: this board is listed from the first answer, the saved miners come back without a scan.
- The loading screen (the bee and the honeycomb) sits a little above the middle of the screen.
- Audit 2, security: the board's JSON answers (wallet, Wi-Fi name) may be read only by a page on the LAN or localhost
  (CORS names that origin instead of `*`); a POST from "null" (a sandboxed frame or a file) is refused like one from the
  internet; GETs that change something (`/control`, `/xclk`, `/reg`, `/pll`, `/resolution`, `/api/bench`) are refused when
  the browser marks them cross-site from a page outside the LAN. Programs (curl, VLC, Home Assistant) are not affected.
  The preview is served from localhost now (`python3 -m http.server` in its folder).
- Audit 2, health: the main loop runs under the task watchdog (60 s); a board whose Wi-Fi stays down 5 minutes or whose
  web server does not answer itself 4 times in a row (5 since 0.8.0) restarts and reports why (`miner.restartWhy`, shown after "last
  reset" on the dashboard).
- The board looks for other miners itself, like NMMiner: its own /24 in the background (one address at a time, a pass
  every 30 minutes, the known ones every 2 minutes, paused during an OTA or a camera stream), the list in NVS, served
  by `/alive` (NMMiner's format plus `lastScanAgo`); `POST /api/swarm/add` keeps a miner added by hand. The Swarm page
  takes the list from there, "last scan" is the latest of the board's pass and a browser scan, and opening the Swarm
  no longer scans the network.
- The software hasher is our own SHA-256d instead of the unrolled nerdSHA256plus: rounds unrolled by 8 with renamed
  variables, the job's constant part once, the second hash stopped at word 7; 9.4 KB of code, ~31 KH/s on both boards in
  every build (nerdSHA ran 5 to 29 KH/s depending on where the linker put other code, 9 on the ESP32-CAM), ~983 KH/s in
  all; its hits use the engine's pool-difficulty mask. nerdsha.c is gone.
- The page is served with an ETag (the image's SHA-256) and `no-cache`: 304 when unchanged, a new firmware's page at once.
- Fixed: Settings saved before the board's Wi-Fi scan answered stored an empty AP lock (with two APs of one name the
  camera then joined the other one and seemed gone); a save before the settings were read, or without a Wi-Fi name, is
  refused; the stream's 5 s refresh no longer resets the controls; a hidden tab polls nothing and drops the stream.
- Swarm: Board is the hardware (ESP32-WROOM-32, ESP32-CAM), Firmware whose firmware and version (3BMiner v0.7.0,
  NMMiner v2.0.04); versions shown with a v on the page.
- The AP lock list names MikroTik access points "MikroTik" (the pool's `/api/3bminer/oui` maps its "Routerboard.com"
  registration).

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
