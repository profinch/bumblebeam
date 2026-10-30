# Thermo

Every temperature on a Linux box, plus the fans, voltages, power and load that explain them, in a
dashboard in the BumbleBeam look. Written for the pool's home node `ultp` (Ryzen 9 5900X, Gigabyte
B550I AORUS PRO AX, RTX 3090, Crucial T705 + P3 Plus), generic wherever the hardware allows.
Python 3 stdlib only, no build step.

```
thermo.py collect   root, every 2 s -> /var/lib/thermo/thermo.db (SQLite WAL) + /run/thermo/now.json
thermo.py web       user thermo, read-only, http://<host>:9188/
thermo.py once      two samples to stdout, nothing stored (sudo, for checking a host)
```

## Sources

| What | How | Notes |
|---|---|---|
| CPU Tctl, Tccd1, Tccd2 | hwmon `k10temp` | 0.125 °C steps; Tctl = Tdie on the 5900X |
| CPU package power | RAPL `intel-rapl:0` energy counter | the `core` domain is skipped: on AMD it counts one core |
| CPU load, clocks | `/proc/stat`, `/proc/loadavg`, cpufreq | |
| Board temps, fans, voltages | **IT8689E read directly** over `/dev/port` | the in-kernel `it87` does not know the chip; see below |
| NVMe temps | hwmon `nvme` | Composite + every implemented sensor |
| NVMe health | admin ioctl: SMART log, Identify, HCTM feature | TMT1/TMT2 throttle transitions and seconds, minutes above WCTEMP/CCTEMP, critical warning, wear |
| NVMe on the bus | `/sys/class/nvme`, PCIe link, AER counters | a known drive leaving the bus is a `crit` event |
| NVMe I/O | `/proc/diskstats` | read/write MB/s, to read temperature against load |
| GPU | NVML via ctypes | temp + its slowdown/shutdown thresholds, fans, power, clocks, throttle reasons; GDDR6X junction is not exposed on GeForce |
| NIC PHY, ACPI zones, anything else | hwmon, generic | ACPI zones are static on this board and hidden |

### IT8689E

Read-only apart from the address register: chip id and the environment controller base come from the
Super I/O config space once at start, then each sample reads temp1-6, fan1-6 (16-bit tachometers,
`1350000 / (2 * count)`), in0-in9 (12 mV ADC, Gigabyte dividers for +3.3/+5/+12 V). ACPI
(`gigabyte_wmi`) uses the same chip without a lock we can take, so a sample is dropped when the bank or
vendor register shows a foreign access; the count is on the dashboard. Labels follow the lm-sensors
configs for Gigabyte AM4 boards (frankcrawford/it87). If the out-of-tree `it87` driver is ever loaded,
the collector uses its hwmon device instead and keeps the same sensor keys.

## Storage

`raw` every sample for 48 h, `m1` (min/avg/max per minute) for 120 days, `m10` forever. Charts take
the min-max of each bucket as a band under the average line, so a 2-second spike survives any zoom.

## Events

Thresholds per sensor (`warn`/`crit`, high and low) with hysteresis (2 °C or 3 %) and debounce (2
samples up, 5 down). Defaults: Zen 3 85/90 °C, NVMe WCTEMP-12 / WCTEMP from the drive itself, GPU
gpu_max-10 / gpu_max from NVML, VRM 90/105, CPU fan < 300 RPM, ATX rails ±5/10 %, CMOS battery.
Plus: NVMe throttle counters going up, AER errors, link changes, a drive vanishing or coming back,
GPU thermal/power-brake throttling. Optional Telegram for warn/crit.

## Config

`/etc/thermo.conf`, JSON, every key optional (`thermo.conf.example`): `interval`, `port`,
`names` (NVMe serial -> name), `labels` (key -> label), `limits` (key glob ->
`[warn_lo, crit_lo, warn_hi, crit_hi]`), `hide` (key globs), `telegram` (`{"token", "chat"}`).
Sensor keys are on the dashboard under "Все датчики группы".

## Install

```
sudo ./deploy/install.sh      # user thermo, /opt/thermo, two systemd units, enables and starts them
```

API: `/api/now`, `/api/series?group=cpu&range=3600`, `/api/stats?range=86400`, `/api/events?limit=200`.
