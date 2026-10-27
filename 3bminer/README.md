# esp32miner — open BTC lottery miner firmware for ESP32-WROOM-32 (ESP-IDF 5.3)

Hardware SHA-256 engine driven directly from a cycle-scheduled Xtensa asm kernel (core 0, interrupts off),
plus nerdSHA256plus software hashing on core 1 in idle time. ~885 KH/s engine + ~30 KH/s software on an
ESP32-D0WD-V3 @240 MHz (NerdMiner v2: ~350 KH/s, NMMiner: ~1 MH/s, closed source + paid license).

## Layout
- `main/mine.S`     asm kernel `hwmine(tbl, nonce, count, E, d2)`: 3 engine blocks per nonce, next block streamed
                    behind the engine's read pointer, LOAD H2 and masked check of digest word 7 (E=68, d2=8 verified).
- `main/miner.c`    core-0 task (chunks of 16384 nonces), genesis self-test at boot, core-1 software task.
- `main/stratum.c`  stratum v1 client (subscribe/authorize/suggest_difficulty/notify/set_difficulty/submit).
- `main/job.c`      header words from a job + extranonce2, software sha256d, share difficulty.
- `main/web.c`      web UI `/`, NMMiner-compatible `/probe`, `/alive`, `/api/system/info`, `/api/swarm/find`,
                    `/api/system/restart`, config `GET/POST /api/config`, OTA `POST /update` (raw .bin).
- `main/secrets.h`  default Wi-Fi/pool/wallet (written to NVS on first boot; change via POST /api/config).
- `partitions.csv`  nvs + otadata + ota_0/ota_1 (1.875 MB each) -> real OTA on 4 MB flash.

## Build / flash / OTA
    . ~/esp/esp-idf/export.sh && idf.py build
    # first time (USB, from Windows):
    py -3 -m esptool --port COM6 --baud 460800 write-flash 0x1000 bootloader.bin 0x8000 partition-table.bin 0xe000 ota_data_initial.bin 0x10000 esp32miner.bin
    # afterwards over Wi-Fi:
    curl -X POST --data-binary @build/esp32miner.bin http://<ip>/update

## Hardware facts (measured)
- Engine block ~66-70 cycles; input words are read streaming (~1 word/cycle), so TEXT[i] may be overwritten only after
  the engine consumed it. LOAD needs ~10+ cycles. BUSY polling right after START is unreliable (flag lags).
- Stores to SHA_TEXT: ~2 cycles from asm; ~7 from C (gcc inserts MEMW after volatile stores). Dual-core stores don't scale.
- mbedtls in IDF uses the same engine and switches its clock off -> CONFIG_MBEDTLS_HARDWARE_SHA=n, never touch mbedtls SHA.
- Core-1 code in IRAM slows the core-0 kernel (shared SRAM banks); the software hasher runs from flash cache.
- Fixed nop windows are non-monotonic in time on LX6 (fetch alignment); the loopnez-delay kernel is faster and verified.
