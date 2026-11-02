# What the page adds to device values

Audit of 2026-10-31: places where the web UI (web/index.html, then web-next/index.src.html) shows something other than
what the device reports.

## The rule (agreed 2026-11-02)
The page shows what a device sends and only formats numbers. When a value needs words or a nicer name, our own firmware
sends them in the API; other devices' values are shown as they come.

## Done in 1.0.0
| # | What | Now |
|---|---|---|
| - | "v" before versions (vv()) | gone; the firmware sends its own version as v1.0.0 |
| 2 | the word `AxeOS ` before a Bitaxe's version | gone: its `version` as sent |
| 3 | `rev ` before a Bitaxe's board version | gone: `ASICModel, boardVersion` as sent |
| 4 | board ids renamed and upper-cased in the page (BN table) | the firmware sends `identity.boardName` (ESP32-WROOM-32, ESP32-CAM); older firmware: its `board` id as sent |
| 6 | reset reason code -> text from a table in the page (RR) | the firmware sends `miner.resetReasonText`; older firmware: the number |
| 7 | `lastReject` text split by the page | the firmware sends `stratum.lastRejectCode` (number or null) and `stratum.lastRejectMsg`; older firmware: the raw text |

Kept on purpose: 1 (both parts come from the device), 5 (`-` is an empty cell, not data), 8-11 (conveniences that change
no value), 12-20 (number formatting and the page's own calculations). Still to talk over.

## The list as audited

## Adds or changes text

| # | Where | Device gives | Page shows |
|---|---|---|---|
| 1 | Swarm, Firmware | `displayName`/`hwModel` and `fwVersion` apart | glued: `3BMiner 0.10.1`, `NMMiner v2.0.04` |
| 2 | Swarm, Firmware for Bitaxe | `version` only | the word `AxeOS ` of our own |
| 3 | Swarm, Board for Bitaxe | `boardVersion` | `rev ` in front |
| 4 | Board: Dashboard, Firmware, Swarm | `esp32-wroom-32`, `esp32-cam` | `ESP32-WROOM-32`, `ESP32-CAM` (BN(), anything else upper-cased) |
| 5 | Swarm, Board for NMMiner | no board field | `-` |
| 6 | Dashboard, last reset | `resetReason: 1` | text from our table RR: `power on`, `software`, `brownout`… |
| 7 | Dashboard, Rejects | `lastReject: "[21,Job not found,]"` | split into message `Job not found` and code `21` (rejMsg, rejCode) |
| 8 | Pool address tip | `solobtc.nmminer.com:3333` | `stratum+tcp://` in front |
| 9 | Pool copy button | `host:port` | copies without the port |
| 10 | Worker | `bc1q…90wmc.devkit` | address cut to 5…5; the copy button copies the address without `.devkit` |
| 11 | Firmware, Timing | `timing` and `kernel` | glued: `24/35/22/4/8 - kernel 3` |

## Formats numbers (no words of its own)

| # | What | How |
|---|---|---|
| 12 | hashrate | GH/s to KH/s / MH/s (hm) |
| 13 | difficulties | `148.36T` -> `148.36 T`, trailing space dropped (NMMiner gives `"0.0039 "`) (sp) |
| 14 | memory | bytes to KB |
| 15 | RSSI | ` dBm` added |
| 16 | uptime | seconds to `17h 41m` (ut) |

## Computed from device fields

| # | What |
|---|---|
| 17 | reject %, shares per hour, expected time to a block, the "waiting for a share" bar |
| 18 | average hashrate since start when the board has no `avg1hKhs` / `avg24hKhs` |
| 19 | Swarm totals: hashrate, best difficulty, shares |
| 20 | block height, fees, prices, halving: from mempool.space, not the board |

First impression: 1-5 are the same kind as the "v" (text added to or renamed from what the device says);
6-11 translate device values into readable form; number formatting and computed values are normal.
