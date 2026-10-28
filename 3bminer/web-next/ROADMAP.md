# Web UI / firmware roadmap (from 2026-10-28)

Preview of the next UI: web-next/index.src.html -> `build.py <dir>` -> index.html (local only, not flashed yet).

## Done in the preview (browser side, no firmware change)
- Menu like the BumbleBeam pool header: Dashboard / Swarm / Settings / Firmware; the status pill sits on the right on phones.
- Dashboard: block odds (expected years, 1 in N per day, best diff vs network diff on a log bar), BTC price, block height + halving countdown, fees, next difficulty adjustment (mempool.space, fetched by the browser), average hashrate since the page opened, shares/hour.
- Swarm: the browser scans the subnet (/probe, then /api/system/info), understands NMMiner and AxeOS (Bitaxe/NerdQaxe) answers, sortable table, totals, restart, remembers addresses in localStorage.
- Settings: Payout / Pool / Wi-Fi / Device; host:port parsing; fields the firmware lacks are marked "next fw".
- Firmware: version, kernel, upload with a progress bar, engine check (/api/bench), restart.
- Display layouts moved out of the web UI into `display.src.html` -> `display.html`, a review page only: Miner / Network / Clock screens for 240x240, 320x170, 320x240 drawn from a live miner (`?h=<ip>`). The firmware never serves it; it is the spec for TFT builds.

## Needs firmware
- Fallback pool, pool password, device hostname, status LED (find-me blink on GPIO2), time zone.
- /alive with an on-device subnet scan (as NMMiner) so Swarm works without a browser scan.
- Hashrate/share history kept on the device (ring buffer, e.g. 288 x 5 min) for a 24 h chart.
- Logs page: ring buffer of recent log lines at /api/logs.
- Block height from the coinbase (BIP34) so it shows without internet access from the browser.
- Serve favicon/page with ETag; keep the page under ~12 KB gzip.

## Display builds (later)
- Boards: NMMiner 1.54" 240x240 ST7789, LILYGO T-Display S3 (ESP32-S3: its SHA engine can take a midstate - a separate kernel, likely much faster), ESP32-2432S028 "CYD" 2.8" 320x240 (classic ESP32).
- Draw on core 1 only; measure the effect on the engine first (SPI DMA / bus contention), refresh ~1 Hz.

## Camera board (ESP32-CAM)
- Camera page in the web-next menu (today a separate /camera page in the 0.6 style).
- Optional: the upper 4 MB of the 8 MB PSRAM via himem for a pre-event video buffer (frames kept in 32 KB banks);
  SD card snapshots (the slot shares GPIO4 with the flash LED, GPIO2/12-15 with the card).
