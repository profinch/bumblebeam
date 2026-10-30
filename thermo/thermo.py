#!/usr/bin/env python3
"""thermo: every temperature on ultp, plus the fans, voltages, power and load that explain them.

  collect  (root)  every 2 s: hwmon (k10temp, nvme, NIC, ACPI, any later driver), the IT8689E
                   Super I/O read straight from its ports (fans, voltages, board temps; the
                   in-kernel it87 does not know the chip), NVMe SMART over the admin ioctl
                   (thermal-throttle counters, WCTEMP/CCTEMP time, PCIe link, AER), NVML for the
                   GPU, RAPL for CPU power, /proc for load and disk I/O. Writes SQLite + now.json,
                   raises events (thresholds with hysteresis, throttling, a drive leaving the bus).
  web      (user)  the dashboard and a JSON API, read-only over the same database.

stdlib only. Config: /etc/thermo.conf (JSON, every key optional, see thermo.conf.example).
"""
import argparse
import ctypes
import fcntl
import fnmatch
import glob
import json
import os
import re
import signal
import socket
import sqlite3
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULTS = {
    'interval': 2,            # s between samples
    'smart_every': 10,        # s between NVMe SMART log reads
    'db': '/var/lib/thermo/thermo.db',
    'now': '/run/thermo/now.json',
    'listen': '0.0.0.0',
    'port': 9188,
    'raw_hours': 48,          # full-rate samples kept this long
    'm1_days': 120,           # 1-minute min/avg/max kept this long; 10-minute ones forever
    'fast_hz': 4,             # quantized temperatures are read this often and averaged per sample (0 = off)
    'superio': True,          # read the IT8689E directly (off: board temps from gigabyte_wmi)
    'names': {},              # NVMe serial -> short name
    'labels': {},             # sensor key -> label
    'limits': {},             # key glob -> [warn_lo, crit_lo, warn_hi, crit_hi] (null = none)
    'hide': [],               # key globs left out of the dashboard (still recorded)
    'telegram': None,         # {"token": "...", "chat": "..."} -> warn/crit events are sent
}

# Gigabyte AM4 boards with the IT8689E (lm-sensors configs from frankcrawford/it87)
BOARD_TEMP = {1: 'System', 2: 'Chipset', 3: 'CPU (плата)', 4: 'temp4', 5: 'VRM MOS', 6: 'VSOC MOS'}
BOARD_FAN = {1: 'CPU_FAN', 2: 'SYS_FAN1', 3: 'SYS_FAN2', 4: 'fan4', 5: 'fan5', 6: 'fan6'}
# in#: label, external divider (the chip measures in 12 mV steps), nominal V for the ±5/10 % limits
BOARD_VIN = {0: ('CPU Vcore', 1, None), 1: ('+3.3V', 1.649, 3.3), 2: ('+12V', 6, 12.0), 3: ('+5V', 2.5, 5.0),
             4: ('CPU VCORE SOC', 1, None), 5: ('CPU VDDP', 1, None), 6: ('DRAM', 1, None),
             7: ('3VSB', 2, 3.3), 8: ('VBAT', 2, None), 9: ('AVCC3', 2, None)}

# default limits by key glob: (warn_lo, crit_lo, warn_hi, crit_hi); config 'limits' wins
DEFAULT_LIMITS = [
    ('cpu.t*', (None, None, 85, 90)),         # Zen 3 Tjmax 90 °C, Tctl has no offset on the 5900X
    ('board.temp1', (None, None, 60, 70)),
    ('board.temp2', (None, None, 80, 90)),
    ('board.temp3', (None, None, 85, 90)),
    ('board.temp5', (None, None, 90, 105)),
    ('board.temp6', (None, None, 90, 105)),
    ('board.fan1', (None, 300, None, None)),  # CPU fan stalled
    ('board.in8', (2.8, 2.6, None, None)),    # CMOS battery
    ('gpu*.memtemp', (None, None, 95, 105)),
    ('net.*', (None, None, 100, 120)),
]
GROUPS = [('cpu', 'CPU'), ('storage', 'NVMe'), ('gpu', 'GPU'), ('board', 'Плата'), ('net', 'Сеть'), ('other', 'Прочее')]
GPU_REASONS = {0x1: 'idle', 0x2: 'app clocks', 0x4: 'power cap', 0x8: 'HW slowdown', 0x10: 'sync boost',
               0x20: 'SW thermal', 0x40: 'HW thermal', 0x80: 'power brake', 0x100: 'display clock'}
GPU_BAD = 0x8 | 0x20 | 0x40 | 0x80


def load_conf(path):
    conf = dict(DEFAULTS)
    try:
        with open(path) as f:
            conf.update(json.load(f))
    except FileNotFoundError:
        pass
    return conf


def rd(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None


def rdnum(path, div=1.0):
    s = rd(path)
    try:
        return int(s) / div
    except (TypeError, ValueError):
        return None


def natkey(s):
    return [int(t) if t.isdigit() else t for t in re.split(r'(\d+)', s)]


def M(label, grp, kind, unit, ord, lim=(None, None, None, None), note='', hidden=False, prec=1, res=None):
    """res: the sensor's own step; a stepped temperature is averaged over fast reads, so it gets 2 decimals"""
    return {'label': label, 'grp': grp, 'kind': kind, 'unit': unit, 'ord': ord, 'lim': list(lim),
            'note': note, 'hidden': hidden, 'prec': 2 if res else prec, 'res': res}


# ---------------------------------------------------------------- Super I/O (IT8689E)

class SuperIO:
    """IT8689E environment controller read from its own I/O ports. Read-only apart from the
    address register. ACPI (gigabyte_wmi) talks to the same chip without a lock we could take, so
    a sample is dropped when the bank or vendor register shows the chip was being used meanwhile."""
    CHIPS = {0x8689: 'IT8689E'}
    FANS = [(0x0d, 0x18), (0x0e, 0x19), (0x0f, 0x1a), (0x80, 0x81), (0x82, 0x83), (0x4c, 0x4d)]

    def __init__(self):
        self.fd = os.open('/dev/port', os.O_RDWR)
        self.base = None
        cfg = 0x2e
        for b in (0x87, 0x01, 0x55, 0x55):
            self._out(cfg, b)
        cid = self._sio(cfg, 0x20) << 8 | self._sio(cfg, 0x21)
        if cid in self.CHIPS:
            self._out(cfg, 0x07)
            self._out(cfg + 1, 0x04)            # logical device 4: environment controller
            base = self._sio(cfg, 0x60) << 8 | self._sio(cfg, 0x61)
            if self._sio(cfg, 0x30) & 1 and base:
                self.base, self.chip = base, self.CHIPS[cid]
        self._out(cfg, 0x02)
        self._out(cfg + 1, 0x02)                # leave config mode
        if not self.base:
            os.close(self.fd)
            raise RuntimeError(f'no supported Super I/O at 0x2e (id {cid:#06x})')
        self.dropped = 0
        self.lock = threading.Lock()        # the collector tick and the fast reader share the address port

    def _out(self, port, v):
        os.pwrite(self.fd, bytes([v]), port)

    def _in(self, port):
        return os.pread(self.fd, 1, port)[0]

    def _sio(self, cfg, reg):
        self._out(cfg, reg)
        return self._in(cfg + 1)

    def r(self, reg):
        self._out(self.base + 5, reg)
        return self._in(self.base + 6)

    def _clean(self):
        return not (self.r(0x06) & 0xe0) and self.r(0x58) == 0x90

    def _temps(self):
        temps = []
        for i in range(6):
            v = self.r(0x29 + i)
            v = v - 256 if v > 127 else v
            temps.append(None if v in (-128, 127) else float(v))
        return temps

    def temps(self):
        with self.lock:
            if not self._clean():
                return None
            t = self._temps()
            return t if self._clean() else None

    def sample(self):
        with self.lock:
            return self._sample()

    def _sample(self):
        if not self._clean():
            self.dropped += 1
            return None
        temps = self._temps()
        main, ext = self.r(0x13), self.r(0x0c)
        on = [main & 0x10, main & 0x20, main & 0x40, ext & 0x10, ext & 0x20, ext & 0x04]
        fans = []
        for (lo, hi), en in zip(self.FANS, on):
            if not en:
                fans.append(None)
                continue
            for _ in range(3):              # low byte must not move under the high byte
                a, b, c = self.r(lo), self.r(hi), self.r(lo)
                if a == c:
                    break
            v = a | b << 8
            fans.append(None if v == 0 else 0.0 if v == 0xffff else 1350000 / (v * 2))
        vin = [self.r(0x20 + i) for i in range(9)] + [self.r(0x2f)]
        if not self._clean():
            self.dropped += 1
            return None
        return temps, fans, [v * 0.012 for v in vin]


def board_readings(temps, fans, vin, scaled_internal=False):
    out = []
    for i, t in enumerate(temps, 1):
        if t is not None:
            out.append((f'board.temp{i}', t, M(BOARD_TEMP[i], 'board', 'temp', '°C', 400 + i, hidden=i == 4, res=1,
                                               note='не подключён (по конфигу Gigabyte)' if i == 4 else '')))
    for i, f in enumerate(fans, 1):
        if f is not None:
            out.append((f'board.fan{i}', f, M(BOARD_FAN[i], 'board', 'fan', 'RPM', 420 + i, prec=0)))
    for i, raw in enumerate(vin):
        if raw is None or i not in BOARD_VIN:
            continue
        label, div, nom = BOARD_VIN[i]
        v = raw * (1 if scaled_internal and i >= 7 else div)
        lim = (nom * 0.95, nom * 0.90, nom * 1.05, nom * 1.10) if nom else (None, None, None, None)
        out.append((f'board.in{i}', round(v, 4), M(label, 'board', 'volt', 'V', 440 + i, lim, prec=3)))
    return out


# ---------------------------------------------------------------- NVMe admin ioctl

class NvmeCmd(ctypes.Structure):
    _fields_ = [('opcode', ctypes.c_uint8), ('flags', ctypes.c_uint8), ('rsvd1', ctypes.c_uint16),
                ('nsid', ctypes.c_uint32), ('cdw2', ctypes.c_uint32), ('cdw3', ctypes.c_uint32),
                ('metadata', ctypes.c_uint64), ('addr', ctypes.c_uint64), ('metadata_len', ctypes.c_uint32),
                ('data_len', ctypes.c_uint32), ('cdw10', ctypes.c_uint32), ('cdw11', ctypes.c_uint32),
                ('cdw12', ctypes.c_uint32), ('cdw13', ctypes.c_uint32), ('cdw14', ctypes.c_uint32),
                ('cdw15', ctypes.c_uint32), ('timeout_ms', ctypes.c_uint32), ('result', ctypes.c_uint32)]


NVME_IOCTL_ADMIN_CMD = 0xC0484E41


def nvme_admin(dev, opcode, cdw10, nsid=0, size=0):
    buf = ctypes.create_string_buffer(size) if size else None
    cmd = NvmeCmd(opcode=opcode, nsid=nsid, cdw10=cdw10, data_len=size, timeout_ms=2000,
                  addr=ctypes.addressof(buf) if buf else 0)
    fd = os.open(dev, os.O_RDONLY)
    try:
        fcntl.ioctl(fd, NVME_IOCTL_ADMIN_CMD, cmd)
    finally:
        os.close(fd)
    return (buf.raw if buf else b''), cmd.result


def le(b, off, n):
    return int.from_bytes(b[off:off + n], 'little')


def nvme_identify(dev):
    b, _ = nvme_admin(dev, 0x06, 1, size=4096)
    info = {'wctemp': le(b, 266, 2), 'cctemp': le(b, 268, 2), 'hctma': le(b, 322, 2),
            'mntmt': le(b, 324, 2), 'mxtmt': le(b, 326, 2), 'fw': b[64:72].decode(errors='replace').strip()}
    if info['hctma'] & 1:
        try:
            _, res = nvme_admin(dev, 0x0a, 0x10)     # get features: host controlled thermal management
            info['tmt1'], info['tmt2'] = res >> 16, res & 0xffff
        except OSError:
            pass
    return info


def nvme_smart(dev):
    b, _ = nvme_admin(dev, 0x02, (127 << 16) | 0x02, nsid=0xffffffff, size=512)
    return {'cw': b[0], 'temp': le(b, 1, 2), 'spare': b[3], 'used': b[5],
            'written_tb': le(b, 48, 16) * 512000 / 1e12, 'read_tb': le(b, 32, 16) * 512000 / 1e12,
            'hours': le(b, 128, 16), 'unsafe': le(b, 144, 16), 'media_err': le(b, 160, 16),
            'wctemp_min': le(b, 192, 4), 'cctemp_min': le(b, 196, 4),
            'sensors': [le(b, 200 + 2 * i, 2) for i in range(8)],
            'tmt1_n': le(b, 216, 4), 'tmt2_n': le(b, 220, 4), 'tmt1_s': le(b, 224, 4), 'tmt2_s': le(b, 228, 4)}


def short_name(model):
    m = re.match(r'CT\d+([A-Z]\d+)(P?)SSD', model or '')
    if m:
        return m.group(1) + (' Plus' if m.group(2) else '')
    return (model or '?')[:18]


def pci_info(pci):
    def aer(name, field):
        s = rd(f'{pci}/{name}') or ''
        m = re.search(rf'^{field} (\d+)', s, re.M)
        return int(m.group(1)) if m else 0
    return {'link': f"{(rd(pci + '/current_link_speed') or '?').replace(' PCIe', '')} x{rd(pci + '/current_link_width')}",
            'link_max': f"{(rd(pci + '/max_link_speed') or '?').replace(' PCIe', '')} x{rd(pci + '/max_link_width')}",
            'aer_cor': aer('aer_dev_correctable', 'TOTAL_ERR_COR'), 'aer_nonfatal': aer('aer_dev_nonfatal', 'TOTAL_ERR_NONFATAL'),
            'aer_fatal': aer('aer_dev_fatal', 'TOTAL_ERR_FATAL'), 'pci': os.path.basename(pci)}


# ---------------------------------------------------------------- NVML

class FieldValue(ctypes.Structure):
    _fields_ = [('fieldId', ctypes.c_uint), ('scopeId', ctypes.c_uint), ('timestamp', ctypes.c_longlong),
                ('latencyUsec', ctypes.c_longlong), ('valueType', ctypes.c_int), ('nvmlReturn', ctypes.c_int),
                ('value', ctypes.c_ulonglong)]


class Utilization(ctypes.Structure):
    _fields_ = [('gpu', ctypes.c_uint), ('memory', ctypes.c_uint)]


class NVML:
    def __init__(self):
        self.lib = ctypes.CDLL('libnvidia-ml.so.1')
        if self.lib.nvmlInit_v2() != 0:
            raise RuntimeError('nvmlInit failed')
        n = ctypes.c_uint()
        self.lib.nvmlDeviceGetCount_v2(ctypes.byref(n))
        self.devs = []
        for i in range(n.value):
            h = ctypes.c_void_p()
            self.lib.nvmlDeviceGetHandleByIndex_v2(i, ctypes.byref(h))
            name = ctypes.create_string_buffer(96)
            self.lib.nvmlDeviceGetName(h, name, 96)
            th = {}
            for t, k in ((0, 'shutdown'), (1, 'slowdown'), (3, 'gpu_max'), (2, 'mem_max')):
                v = ctypes.c_uint()
                if self.lib.nvmlDeviceGetTemperatureThreshold(h, t, ctypes.byref(v)) == 0:
                    th[k] = v.value
            pl = ctypes.c_uint()
            self.lib.nvmlDeviceGetEnforcedPowerLimit(h, ctypes.byref(pl))
            nf = ctypes.c_uint()
            if self.lib.nvmlDeviceGetNumFans(h, ctypes.byref(nf)) != 0:
                nf.value = 1
            self.devs.append({'h': h, 'i': i, 'name': name.value.decode(), 'th': th, 'plimit': pl.value / 1000,
                              'nfans': nf.value})

    def u(self, fn, h, *args):
        v = ctypes.c_uint()
        return v.value if getattr(self.lib, fn)(h, *args, ctypes.byref(v)) == 0 else None

    def sample(self):
        out, extra = [], {}
        for d in self.devs:
            h, p = d['h'], f"gpu{d['i']}"
            th = d['th']
            gmax = th.get('gpu_max') or th.get('slowdown')
            note = ' · '.join(f'{k} {v}' for k, v in th.items())
            t = self.u('nvmlDeviceGetTemperature', h, 0)
            if t is not None:
                out.append((f'{p}.temp', float(t), M('GPU', 'gpu', 'temp', '°C', 300, (None, None, gmax - 10, gmax) if gmax else (None,) * 4, note, res=1)))
            fv = FieldValue(fieldId=82)              # NVML_FI_DEV_MEMORY_TEMP; GDDR6X junction is not exposed on GeForce
            if self.lib.nvmlDeviceGetFieldValues(h, 1, ctypes.byref(fv)) == 0 and fv.nvmlReturn == 0 and 0 < fv.value < 150:
                out.append((f'{p}.memtemp', float(fv.value), M('GPU память', 'gpu', 'temp', '°C', 301)))
            for f in range(d['nfans']):
                v = self.u('nvmlDeviceGetFanSpeed_v2', h, f)
                if v is not None:
                    out.append((f'{p}.fan{f}', float(v), M(f'Вентилятор {f + 1}', 'gpu', 'util', '%', 310 + f, prec=0)))
            mw = self.u('nvmlDeviceGetPowerUsage', h)
            if mw is not None:
                out.append((f'{p}.power', mw / 1000, M('GPU', 'gpu', 'power', 'W', 320, note=f"лимит {d['plimit']:.0f} W")))
            ut = Utilization()
            if self.lib.nvmlDeviceGetUtilizationRates(h, ctypes.byref(ut)) == 0:
                out.append((f'{p}.util', float(ut.gpu), M('Ядро', 'gpu', 'util', '%', 305, prec=0)))
                out.append((f'{p}.memutil', float(ut.memory), M('Контроллер памяти', 'gpu', 'util', '%', 306, prec=0)))
            for clk, lab, o in ((1, 'SM', 330), (2, 'Память', 331)):
                v = self.u('nvmlDeviceGetClockInfo', h, clk)
                if v is not None:
                    out.append((f'{p}.clk{clk}', float(v), M(lab, 'gpu', 'freq', 'MHz', o, prec=0)))
            r = ctypes.c_ulonglong()
            reasons = r.value if self.lib.nvmlDeviceGetCurrentClocksThrottleReasons(h, ctypes.byref(r)) == 0 else 0
            ps = ctypes.c_int()
            self.lib.nvmlDeviceGetPerformanceState(h, ctypes.byref(ps))
            extra[p] = {'name': d['name'], 'reasons': reasons, 'reason_names': [n for b, n in GPU_REASONS.items() if reasons & b],
                        'pstate': f'P{ps.value}', 'th': th, 'plimit': d['plimit']}
        return out, extra


# ---------------------------------------------------------------- CPU, disks

class Rates:
    """counters -> per-second rates between two samples"""
    def __init__(self):
        self.prev = {}

    def rate(self, key, value, t, wrap=None):
        p = self.prev.get(key)
        self.prev[key] = (value, t)
        if not p or t <= p[1]:
            return None
        d = value - p[0]
        if d < 0:
            if not wrap:
                return None
            d += wrap
        return d / (t - p[1])


def cpu_model():
    s = rd('/proc/cpuinfo') or ''
    m = re.search(r'model name\s*:\s*(.+)', s)
    return re.sub(r'\s+\d+-Core Processor', '', m.group(1)) if m else 'CPU'


def cpu_readings(rates, t):
    out = []
    for z in sorted(glob.glob('/sys/class/powercap/intel-rapl:*')):
        name = rd(z + '/name')
        e = rdnum(z + '/energy_uj')
        if e is None or name != 'package-0':     # the 'core' domain on AMD counts a single core only
            continue
        w = rates.rate('rapl' + z, e, t, rdnum(z + '/max_energy_range_uj'))
        if w is not None:
            out.append(('cpu.pkg_w', w / 1e6, M('CPU пакет', 'cpu', 'power', 'W', 120, note='RAPL package')))
    line = (rd('/proc/stat') or '').split('\n')[0].split()[1:]
    if line:
        v = list(map(int, line))
        idle, total = v[3] + v[4], sum(v[:8])
        p = rates.prev.get('stat')
        rates.prev['stat'] = (idle, total)
        if p and total > p[1]:
            out.append(('cpu.util', 100 * (1 - (idle - p[0]) / (total - p[1])), M('CPU', 'cpu', 'util', '%', 130, prec=0)))
    la = (rd('/proc/loadavg') or '0').split()[0]
    out.append(('cpu.load1', float(la), M('load avg 1m', 'cpu', 'load', '', 131, prec=2)))
    f = [rdnum(p, 1000) for p in glob.glob('/sys/devices/system/cpu/cpu[0-9]*/cpufreq/scaling_cur_freq')]
    f = [x for x in f if x]
    if f:
        out.append(('cpu.mhz_avg', sum(f) / len(f), M('средняя', 'cpu', 'freq', 'MHz', 140, prec=0)))
        out.append(('cpu.mhz_max', max(f), M('макс. ядро', 'cpu', 'freq', 'MHz', 141, prec=0)))
    return out


def disk_readings(rates, t, nvmes):
    out = []
    by_ctrl = {v['ctrl']: (s, v) for s, v in nvmes.items() if v.get('present')}
    for line in (rd('/proc/diskstats') or '').split('\n'):
        f = line.split()
        if len(f) < 10:
            continue
        m = re.fullmatch(r'(nvme\d+)n\d+', f[2])
        if not m or m.group(1) not in by_ctrl:
            continue
        serial, v = by_ctrl[m.group(1)]
        for col, kind, lab, o in ((5, 'rd', 'чтение', 0), (9, 'wr', 'запись', 1)):
            r = rates.rate(f'disk.{serial}.{kind}', int(f[col]) * 512, t)
            if r is not None:
                out.append((f'nvme.{serial}.{kind}', r / 1e6, M(f"{v['name']} {lab}", 'storage', 'io', 'MB/s', 260 + 2 * v['n'] + o)))
    return out


# ---------------------------------------------------------------- hwmon

def hwmon_readings(st):
    out = []
    for h in sorted(glob.glob('/sys/class/hwmon/hwmon*'), key=natkey):
        name = rd(h + '/name') or '?'
        dev = os.path.basename(os.path.realpath(h + '/device')) if os.path.exists(h + '/device') else ''
        temps = sorted(glob.glob(h + '/temp*_input'), key=natkey)
        if name == 'k10temp':
            for p in temps:
                lab = rd(p.replace('_input', '_label')) or os.path.basename(p)
                v = rdnum(p, 1000)
                if v is not None:
                    out.append((f'cpu.{lab.lower()}', v, M(lab, 'cpu', 'temp', '°C', 100 + len(out), res=0.125,
                                                           note='Tctl = Tdie на 5900X' if lab == 'Tctl' else '')))
                    st.fast_paths[f'cpu.{lab.lower()}'] = p
        elif name == 'nvme' and dev in st.nvme_by_ctrl:
            serial = st.nvme_by_ctrl[dev]
            nv = st.nvmes[serial]
            for p in temps:
                n = int(re.search(r'temp(\d+)_', p).group(1))
                v = rdnum(p, 1000)
                if v is None:
                    continue
                lab = rd(p.replace('_input', '_label')) or f'temp{n}'
                lim, note = (None,) * 4, ''
                if n == 1:
                    wc, cc = nv.get('wctemp_c'), nv.get('cctemp_c')
                    if wc:
                        lim = (None, None, round(wc - 12), round(wc, 1))
                        note = ' · '.join(f'{k} {x - 273:.0f}' for k, x in (('TMT1', nv.get('tmt1')), ('TMT2', nv.get('tmt2'))) if x)
                        note = ' · '.join(filter(None, [note, f'WCTEMP {wc:.0f}', cc and f'CCTEMP {cc:.0f}']))
                key = f'nvme.{serial}.' + ('comp' if n == 1 else f's{n - 1}')
                out.append((key, v, M(f"{nv['name']} {lab}", 'storage', 'temp', '°C', 200 + 10 * nv['n'] + n, lim, note, res=1)))
                st.fast_paths[key] = p
        elif name == 'gigabyte_wmi':
            if st.superio is None:
                out += board_readings([rdnum(p, 1000) for p in temps], [], [])
        elif re.fullmatch(r'it8[67]\d+', name):
            st.it87_driver = True
            tv = {int(re.search(r'temp(\d+)', p).group(1)): rdnum(p, 1000) for p in temps}
            fv = {int(re.search(r'fan(\d+)', p).group(1)): rdnum(p) for p in glob.glob(h + '/fan*_input')}
            iv = {int(re.search(r'in(\d+)', p).group(1)): rdnum(p, 1000) for p in glob.glob(h + '/in*_input')}
            out += board_readings([tv.get(i) for i in range(1, 7)], [fv.get(i) for i in range(1, 7)],
                                  [iv.get(i) for i in range(10)], scaled_internal=True)
        else:
            if name.startswith('r8169'):
                grp, base, lab0 = 'net', f'net.{name.split("_")[0]}', 'NIC PHY (RTL8125)'
            elif name.startswith('acpitz'):
                grp, base, lab0 = 'other', f'other.{name}', f'ACPI {name}'
            else:
                grp, base, lab0 = 'other', f'hw.{name}', name
            for p in temps:
                n = re.search(r'temp(\d+)', p).group(1)
                v = rdnum(p, 1000)
                if v is None:
                    continue
                lab = rd(p.replace('_input', '_label'))
                mx, cr = rdnum(p.replace('_input', '_max'), 1000), rdnum(p.replace('_input', '_crit'), 1000)
                lim = (None, None, mx, cr) if (mx or cr) and (mx or 0) < 200 else (None,) * 4
                out.append((f'{base}.t{n}', v, M(f'{lab0} {lab}' if lab else lab0, grp, 'temp', '°C',
                                                 (500 if grp == 'net' else 900) + int(n), lim,
                                                 note='статичное значение ACPI' if grp == 'other' and name.startswith('acpitz') else '',
                                                 hidden=name.startswith('acpitz'))))
            for p in sorted(glob.glob(h + '/fan*_input'), key=natkey):
                n = re.search(r'fan(\d+)', p).group(1)
                v = rdnum(p)
                if v is not None:
                    out.append((f'{base}.fan{n}', v, M(f'{lab0} fan{n}', grp, 'fan', 'RPM', 950 + int(n), prec=0)))
    return out


# ---------------------------------------------------------------- collector

class Store:
    SCHEMA = """
    CREATE TABLE IF NOT EXISTS sensors(id INTEGER PRIMARY KEY, key TEXT UNIQUE, meta TEXT, first INTEGER);
    CREATE TABLE IF NOT EXISTS raw(ts INTEGER, sid INTEGER, v REAL, PRIMARY KEY(ts, sid)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS m1(sid INTEGER, ts INTEGER, mn REAL, av REAL, mx REAL, PRIMARY KEY(sid, ts)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS m10(sid INTEGER, ts INTEGER, mn REAL, av REAL, mx REAL, PRIMARY KEY(sid, ts)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, ts INTEGER, level TEXT, key TEXT, msg TEXT);
    CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
    CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
    """

    def __init__(self, path):
        if path != ':memory:':
            os.makedirs(os.path.dirname(path), exist_ok=True)
        self.db = sqlite3.connect(path, isolation_level=None)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=NORMAL')
        # raw used to be keyed (sid, ts): every sample touched one B-tree leaf per sensor, ~11 GB/day of
        # page writes. Keyed (ts, sid) a sample appends to the last leaf.
        old = self.db.execute("SELECT sql FROM sqlite_master WHERE name='raw'").fetchone()
        if old and 'PRIMARY KEY(sid, ts)' in old[0]:
            self.db.executescript('BEGIN; ALTER TABLE raw RENAME TO raw_old;'
                                  'CREATE TABLE raw(ts INTEGER, sid INTEGER, v REAL, PRIMARY KEY(ts, sid)) WITHOUT ROWID;'
                                  'INSERT INTO raw SELECT ts, sid, v FROM raw_old ORDER BY ts, sid;'
                                  'DROP TABLE raw_old; COMMIT; VACUUM;')
        self.db.executescript(self.SCHEMA)
        self.ids, self.metas = {}, {}
        for sid, key, meta in self.db.execute('SELECT id, key, meta FROM sensors'):
            self.ids[key], self.metas[key] = sid, meta

    def sid(self, key, meta, ts):
        js = json.dumps(meta, ensure_ascii=False, sort_keys=True)
        if key not in self.ids:
            cur = self.db.execute('INSERT INTO sensors(key, meta, first) VALUES(?,?,?)', (key, js, ts))
            self.ids[key] = cur.lastrowid
        elif self.metas.get(key) != js:
            self.db.execute('UPDATE sensors SET meta=? WHERE key=?', (js, key))
        self.metas[key] = js
        return self.ids[key]

    def kv_get(self, k, default=None):
        r = self.db.execute('SELECT v FROM kv WHERE k=?', (k,)).fetchone()
        return json.loads(r[0]) if r else default

    def kv_set(self, k, v):
        self.db.execute('INSERT OR REPLACE INTO kv VALUES(?,?)', (k, json.dumps(v)))


class Alerts:
    """warn/crit per sensor with hysteresis and debounce: up after 2 samples, down after 5"""

    def __init__(self, store, notify):
        self.store, self.notify = store, notify
        self.state = {}       # key -> [level, candidate, count]
        self.active = {}

    def level(self, v, m, cur):
        wl, cl, wh, ch = m['lim']
        hy = 2.0 if m['kind'] == 'temp' else abs((wh or ch or wl or cl or 1)) * 0.03
        def hi(th, lvl):
            return th is not None and v >= th - (hy if cur >= lvl else 0)
        def lo(th, lvl):
            return th is not None and v <= th + (hy if cur >= lvl else 0)
        if hi(ch, 2) or lo(cl, 2):
            return 2
        if hi(wh, 1) or lo(wl, 1):
            return 1
        return 0

    def check(self, ts, key, v, m):
        if not any(x is not None for x in m['lim']):
            return
        s = self.state.setdefault(key, [0, 0, 0])
        lvl = self.level(v, m, s[0])
        if lvl == s[0]:
            s[1], s[2] = lvl, 0
            return
        s[2] = s[2] + 1 if s[1] == lvl else 1
        s[1] = lvl
        if s[2] < (2 if lvl > s[0] else 5):
            return
        old, s[0], s[2] = s[0], lvl, 0
        wl, cl, wh, ch = m['lim']
        val = f"{v:.{m['prec']}f} {m['unit']}".strip()
        if lvl:
            hi_t, lo_t = (ch, cl) if lvl == 2 else (wh, wl)
            th, side = (hi_t, '≥') if hi_t is not None and (lo_t is None or v > lo_t) else (lo_t, '≤')
            msg = f"{m['label']}: {val} {side} {th:g}"
            self.active[key] = {'level': 'crit' if lvl == 2 else 'warn', 'since': ts, 'label': m['label']}
        else:
            msg = f"{m['label']}: снова в норме, {val}"
            self.active.pop(key, None)
        self.event(ts, ['ok', 'warn', 'crit'][lvl] if lvl else ('ok' if old == 2 else 'info'), key, msg)

    def event(self, ts, level, key, msg):
        self.store.db.execute('INSERT INTO events(ts, level, key, msg) VALUES(?,?,?,?)', (ts, level, key, msg))
        print(f'[{level}] {msg}', flush=True)
        if level in ('warn', 'crit', 'ok'):
            self.notify(level, msg)


class FastTemps(threading.Thread):
    """The temperatures come in steps (NVMe 1 K, IT8689E and GPU 1 °C, k10temp 0.125 °C). They are read
    fast_hz times a second and each sample stores the mean: while the true value sits between two steps
    the sensor flickers, and the share of reads on the upper step is the fraction. Fine for a value that
    moves slower than a sample; it cannot add digits a sensor sitting still on one step does not show."""

    def __init__(self, col, hz):
        super().__init__(daemon=True, name='fast-temps')
        self.col, self.dt = col, 1 / hz
        self.acc, self.lock = {}, threading.Lock()

    def take(self):
        with self.lock:
            acc, self.acc = self.acc, {}
        return {k: round(s / n, 3) for k, (s, n) in acc.items()}

    def run(self):
        c = self.col
        nxt = time.monotonic()
        while not c.stop:
            vals = {}
            for key, p in list(c.fast_paths.items()):
                v = rdnum(p, 1000)
                if v is not None:
                    vals[key] = v
            if c.superio and not c.it87_driver:
                t = c.superio.temps()
                for i, v in enumerate(t or [], 1):
                    if v is not None:
                        vals[f'board.temp{i}'] = v
            if c.nvml:
                for d in c.nvml.devs:
                    v = c.nvml.u('nvmlDeviceGetTemperature', d['h'], 0)
                    if v is not None:
                        vals[f"gpu{d['i']}.temp"] = float(v)
            with self.lock:
                for k, v in vals.items():
                    a = self.acc.setdefault(k, [0.0, 0])
                    a[0] += v
                    a[1] += 1
            nxt += self.dt
            time.sleep(max(0.0, nxt - time.monotonic()))


class Collector:
    def __init__(self, conf):
        self.conf = conf
        self.store = Store(conf['db'])
        self.rates = Rates()
        self.alerts = Alerts(self.store, self.telegram)
        self.superio = None
        self.it87_driver = False
        self.nvml = None
        self.gpu_prev = {}
        self.acc = {}                   # sid -> [mn, mx, sum, n] for the current minute
        self.acc_min = None
        self.last_smart = 0
        self.nvmes = self.store.kv_get('nvmes', {})   # serial -> info; survives restarts to notice a missing drive
        for v in self.nvmes.values():
            v['present'] = False
            v.pop('wctemp', None)               # identify again once per start (firmware may change)
        self.nvme_by_ctrl = {}
        self.host = socket.gethostname()
        self.board = ' '.join(filter(None, [rd('/sys/class/dmi/id/board_vendor'), rd('/sys/class/dmi/id/board_name')]))
        self.cpu = cpu_model()
        self.tg_last = 0
        self.stop = False
        self.fast = None
        self.fast_paths = {}                # hwmon temperature files the fast reader averages

    def telegram(self, level, msg):
        tg = self.conf.get('telegram')
        if not tg or time.time() - self.tg_last < 20:
            return
        self.tg_last = time.time()
        icon = {'warn': '🟡', 'crit': '🔴', 'ok': '🟢'}.get(level, '')
        def send():
            try:
                data = urllib.parse.urlencode({'chat_id': tg['chat'], 'text': f'{icon} {self.host}: {msg}'}).encode()
                urllib.request.urlopen(f"https://api.telegram.org/bot{tg['token']}/sendMessage", data, timeout=10)
            except Exception as e:
                print(f'telegram: {e}', flush=True)
        threading.Thread(target=send, daemon=True).start()

    def setup(self):
        ev = self.alerts.event
        ts = int(time.time())
        ev(ts, 'info', '', f'коллектор запущен на {self.host}')
        if any(re.fullmatch(r'it8[67]\d+', rd(h + '/name') or '') for h in glob.glob('/sys/class/hwmon/hwmon*')):
            self.it87_driver = True
        if self.conf['superio'] and not self.it87_driver:
            try:
                self.superio = SuperIO()
                print(f'superio: {self.superio.chip} at {self.superio.base:#x}', flush=True)
            except Exception as e:
                print(f'superio: off ({e})', flush=True)
        try:
            self.nvml = NVML()
        except Exception as e:
            print(f'nvml: off ({e})', flush=True)
        if self.conf['fast_hz'] > 0:
            self.fast = FastTemps(self, self.conf['fast_hz'])
            self.fast.start()

    def scan_nvme(self, ts):
        """which known drives are on the bus, their PCIe link and AER counters; events on change"""
        seen = {}
        for c in sorted(glob.glob('/sys/class/nvme/nvme*'), key=natkey):
            serial = (rd(c + '/serial') or '').strip()
            if serial:
                seen[serial] = os.path.basename(c)
        self.nvme_by_ctrl = {}
        for serial, ctrl in seen.items():
            v = self.nvmes.get(serial)
            pci = os.path.realpath(f'/sys/class/nvme/{ctrl}/device')
            if v is None:
                model = (rd(f'/sys/class/nvme/{ctrl}/model') or '').strip()
                v = self.nvmes[serial] = {'model': model, 'name': self.conf['names'].get(serial) or short_name(model),
                                          'n': len(self.nvmes)}
                self.alerts.event(ts, 'info', f'nvme.{serial}', f"NVMe {v['name']} ({model}, {serial}) найден")
            if not v.get('present') and v.get('was_present') is False:
                self.alerts.event(ts, 'ok', f'nvme.{serial}', f"NVMe {v['name']} снова на шине ({ctrl})")
            v.update(ctrl=ctrl, dev=f'/dev/{ctrl}', present=True, was_present=True)
            p = pci_info(pci)
            for k in ('aer_cor', 'aer_nonfatal', 'aer_fatal'):
                if k in v and p[k] > v[k]:
                    self.alerts.event(ts, 'crit' if k == 'aer_fatal' else 'warn', f'nvme.{serial}',
                                      f"{v['name']}: ошибки PCIe AER {k[4:]} +{p[k] - v[k]} (всего {p[k]})")
            if v.get('link') and p['link'] != v['link']:
                self.alerts.event(ts, 'warn', f'nvme.{serial}', f"{v['name']}: PCIe линк {v['link']} → {p['link']}")
            v.update(p)
            if 'wctemp' not in v:
                try:
                    v.update(nvme_identify(v['dev']))
                    v['wctemp_c'] = v['wctemp'] - 273.15 if v['wctemp'] else None
                    v['cctemp_c'] = v['cctemp'] - 273.15 if v['cctemp'] else None
                except OSError as e:
                    print(f"identify {ctrl}: {e}", flush=True)
            self.nvme_by_ctrl[ctrl] = serial
        for serial, v in self.nvmes.items():
            if serial not in seen and v.get('was_present') is not False:
                v.update(present=False, was_present=False)
                self.alerts.event(ts, 'crit', f'nvme.{serial}', f"NVMe {v['name']} ({serial}) пропал с шины PCIe")

    def smart(self, ts):
        out = []
        for serial, v in self.nvmes.items():
            if not v.get('present'):
                continue
            try:
                s = nvme_smart(v['dev'])
            except OSError as e:
                print(f"smart {v['dev']}: {e}", flush=True)
                continue
            for k, lab in (('tmt1_n', 'TMT1 (лёгкий троттлинг)'), ('tmt2_n', 'TMT2 (сильный троттлинг)'),
                           ('wctemp_min', 'минут выше WCTEMP'), ('cctemp_min', 'минут выше CCTEMP'), ('media_err', 'ошибок носителя')):
                old = v.get('smart', {}).get(k)
                if old is not None and s[k] > old:
                    extra = f", всего {s[k.replace('_n', '_s')]} с" if k.endswith('_n') else ''
                    self.alerts.event(ts, 'warn' if k in ('tmt1_n', 'wctemp_min') else 'crit', f'nvme.{serial}',
                                      f"{v['name']}: {lab} +{s[k] - old}{extra}")
            if s['cw'] and s['cw'] != v.get('smart', {}).get('cw'):
                bits = [n for b, n in ((1, 'spare'), (2, 'температура'), (4, 'надёжность'), (8, 'read-only'), (16, 'backup')) if s['cw'] & b]
                self.alerts.event(ts, 'crit', f'nvme.{serial}', f"{v['name']}: SMART critical warning: {', '.join(bits)}")
            v['smart'] = s
            o = 270 + 10 * v['n']
            for k, lab in (('tmt1_n', 'TMT1 переходов'), ('tmt1_s', 'TMT1 секунд'), ('tmt2_n', 'TMT2 переходов'), ('tmt2_s', 'TMT2 секунд')):
                out.append((f'nvme.{serial}.{k}', float(s[k]), M(f"{v['name']} {lab}", 'storage', 'count', '', o, prec=0, hidden=True)))
                o += 1
            for i, k in enumerate(s['sensors'][1:], 2):      # sensors hwmon does not show
                hw = f'nvme.{serial}.s{i}'
                if k and hw not in self.store.ids:
                    out.append((f'nvme.{serial}.smart_s{i}', k - 273.15, M(f"{v['name']} Sensor {i}", 'storage', 'temp', '°C', 200 + 10 * v['n'] + i)))
        self.store.kv_set('nvmes', {k: {x: y for x, y in v.items() if x != 'present'} for k, v in self.nvmes.items()})
        return out

    def gpu_events(self, ts, extra):
        for p, g in extra.items():
            bad = g['reasons'] & GPU_BAD
            old = self.gpu_prev.get(p, 0)
            if bad != old:
                if bad:
                    names = [n for b, n in GPU_REASONS.items() if bad & b]
                    self.alerts.event(ts, 'crit' if bad & 0x48 else 'warn', p, f"{g['name']}: троттлинг — {', '.join(names)}")
                else:
                    self.alerts.event(ts, 'info', p, f"{g['name']}: троттлинг закончился")
            self.gpu_prev[p] = bad

    def apply_conf(self, key, m):
        c = self.conf
        if key in c['labels']:
            m['label'] = c['labels'][key]
        for pat, lim in DEFAULT_LIMITS:
            if fnmatch.fnmatch(key, pat) and not any(x is not None for x in m['lim']):
                m['lim'] = list(lim)
        for pat, lim in c['limits'].items():
            if fnmatch.fnmatch(key, pat):
                m['lim'] = list(lim)
        if any(fnmatch.fnmatch(key, p) for p in c['hide']):
            m['hidden'] = True
        return m

    def tick(self, ts, t):
        means = self.fast.take() if self.fast else {}
        readings = []
        if self.superio and not self.it87_driver:
            s = self.superio.sample()
            if s:
                readings += board_readings(*s)
        try:
            self.scan_nvme(ts)
        except Exception as e:
            print(f'nvme scan: {e}', flush=True)
        readings += hwmon_readings(self)
        readings += cpu_readings(self.rates, t)
        readings += disk_readings(self.rates, t, self.nvmes)
        gpu = {}
        if self.nvml:
            try:
                r, gpu = self.nvml.sample()
                readings += r
                self.gpu_events(ts, gpu)
            except Exception as e:
                print(f'nvml: {e}', flush=True)
        if ts - self.last_smart >= self.conf['smart_every']:
            self.last_smart = ts
            readings += self.smart(ts)

        db = self.store.db
        minute = ts - ts % 60
        if self.acc_min is not None and minute != self.acc_min:
            self.flush_minute()
        self.acc_min = minute
        now = {}
        db.execute('BEGIN')
        for key, v, m in readings:
            if v is None or v != v:
                continue
            m = self.apply_conf(key, m)
            if key in means:
                v, m['note'] = means[key], ' · '.join(filter(None, [m['note'], f"шаг {m['res']:g}, среднее {self.conf['fast_hz']} опросов/с"]))
            sid = self.store.sid(key, m, ts)
            db.execute('INSERT OR REPLACE INTO raw VALUES(?,?,?)', (ts, sid, v))
            a = self.acc.get(sid)
            if a:
                a[0], a[1], a[2], a[3] = min(a[0], v), max(a[1], v), a[2] + v, a[3] + 1
            else:
                self.acc[sid] = [v, v, v, 1]
            self.alerts.check(ts, key, v, m)
            now[key] = dict(m, v=v, st=self.alerts.state.get(key, [0])[0])
        db.execute('COMMIT')
        self.write_now(ts, now, gpu)

    def flush_minute(self):
        db, m = self.store.db, self.acc_min
        db.execute('BEGIN')
        db.executemany('INSERT OR REPLACE INTO m1 VALUES(?,?,?,?,?)',
                       [(sid, m, a[0], a[2] / a[3], a[1]) for sid, a in self.acc.items()])
        if (m + 60) % 600 == 0:
            b = m + 60 - 600
            db.execute('INSERT OR REPLACE INTO m10 SELECT sid, ?, min(mn), avg(av), max(mx) FROM m1 '
                       'WHERE ts >= ? AND ts < ? GROUP BY sid', (b, b, b + 600))
        if m % 3600 == 0:
            db.execute('DELETE FROM raw WHERE ts < ?', (m - self.conf['raw_hours'] * 3600,))
            db.execute('DELETE FROM m1 WHERE ts < ?', (m - self.conf['m1_days'] * 86400,))
            db.execute('DELETE FROM events WHERE ts < ?', (m - 365 * 86400,))
        db.execute('COMMIT')
        self.acc = {}

    def write_now(self, ts, sensors, gpu):
        nv = {}
        for serial, v in self.nvmes.items():
            nv[serial] = {k: v.get(k) for k in ('name', 'model', 'ctrl', 'present', 'link', 'link_max', 'aer_cor', 'aer_nonfatal',
                                                'aer_fatal', 'wctemp_c', 'cctemp_c', 'tmt1', 'tmt2', 'mntmt', 'mxtmt', 'fw', 'pci', 'n')}
            nv[serial]['smart'] = {k: x for k, x in v.get('smart', {}).items() if k != 'sensors'}
        doc = {'ts': ts, 'host': self.host, 'board': self.board, 'cpu': self.cpu, 'interval': self.conf['interval'],
               'groups': GROUPS, 'sensors': sensors, 'alerts': self.alerts.active, 'nvme': nv, 'gpu': gpu,
               'superio': (f'{self.superio.chip} @ {self.superio.base:#x}, отброшено {self.superio.dropped}'
                           if self.superio else ('драйвер it87' if self.it87_driver else 'нет')),
               'uptime': rdnum('/proc/uptime') and float((rd('/proc/uptime') or '0').split()[0])}
        path = self.conf['now']
        if not path:
            self.last_now = doc
            return
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)

    def run(self):
        os.umask(0o007)
        self.setup()
        signal.signal(signal.SIGTERM, lambda *a: setattr(self, 'stop', True))
        signal.signal(signal.SIGINT, lambda *a: setattr(self, 'stop', True))
        iv = self.conf['interval']
        nxt = (time.time() // iv + 1) * iv
        while not self.stop:
            d = nxt - time.time()
            if d > 0:
                time.sleep(d)
            ts = int(round(nxt))
            try:
                self.tick(ts, time.monotonic())
            except Exception as e:
                print(f'tick: {e!r}', flush=True)
                try:
                    self.store.db.execute('ROLLBACK')
                except sqlite3.Error:
                    pass
            nxt += iv
            if nxt < time.time():           # fell behind (suspend, stall): realign
                nxt = (time.time() // iv + 1) * iv
        if self.acc:
            self.flush_minute()
        self.alerts.event(int(time.time()), 'info', '', 'коллектор остановлен')


# ---------------------------------------------------------------- web

class Web(BaseHTTPRequestHandler):
    conf = None
    local = threading.local()
    STATIC = {'/': ('index.html', 'text/html; charset=utf-8'), '/app.js': ('app.js', 'text/javascript; charset=utf-8'),
              '/style.css': ('style.css', 'text/css; charset=utf-8'), '/favicon.svg': ('favicon.svg', 'image/svg+xml')}
    server_version = 'thermo'

    def log_message(self, *a):
        pass

    def db(self):
        d = getattr(self.local, 'db', None)
        if d is None:
            d = self.local.db = sqlite3.connect(f"file:{self.conf['db']}?mode=ro", uri=True, check_same_thread=False)
        return d

    def send(self, code, body, ctype='application/json', cache='no-store'):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False, separators=(',', ':'))
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', cache)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(body)

    def sensors(self):
        return {key: (sid, json.loads(meta)) for sid, key, meta in self.db().execute('SELECT id, key, meta FROM sensors')}

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        try:
            if u.path in self.STATIC:
                f, ct = self.STATIC[u.path]
                with open(os.path.join(HERE, 'web', f), 'rb') as fh:
                    return self.send(200, fh.read(), ct, 'no-cache')
            if u.path == '/api/now':
                with open(self.conf['now'], 'rb') as fh:
                    return self.send(200, fh.read())
            if u.path == '/api/series':
                return self.send(200, self.series(q.get('group', 'cpu'), int(q.get('range', 3600))))
            if u.path == '/api/stats':
                return self.send(200, self.stats(int(q.get('range', 86400))))
            if u.path == '/api/events':
                lim = min(int(q.get('limit', 200)), 2000)
                rows = self.db().execute('SELECT ts, level, key, msg FROM events ORDER BY id DESC LIMIT ?', (lim,)).fetchall()
                return self.send(200, [{'ts': a, 'level': b, 'key': c, 'msg': d} for a, b, c, d in rows])
            self.send(404, {'error': 'not found'})
        except (FileNotFoundError, sqlite3.OperationalError) as e:
            self.send(503, {'error': str(e)})
        except (ValueError, KeyError) as e:
            self.send(400, {'error': str(e)})

    def source(self, rng):
        iv = self.conf['interval']
        if rng <= 3 * 3600:
            tab, base = 'raw', iv
        elif rng <= 14 * 86400:
            tab, base = 'm1', 60
        else:
            tab, base = 'm10', 600
        step = max(base, -(-rng // 600 // base) * base)
        return tab, step

    def series(self, group, rng):
        rng = max(60, min(rng, 400 * 86400))
        sens = {k: v for k, v in self.sensors().items() if v[1]['grp'] == group and v[1]['kind'] not in ('count', 'volt')}
        tab, step = self.source(rng)
        now = int(time.time())
        t0 = (now - rng) // step * step
        byid = {sid: k for k, (sid, _) in sens.items()}
        out = {k: {} for k in sens}
        if byid:
            ph = ','.join('?' * len(byid))
            if tab == 'raw':
                sql = f'SELECT sid, ts/{step}*{step} b, min(v), avg(v), max(v) FROM raw WHERE sid IN ({ph}) AND ts >= ? GROUP BY sid, b'
            else:
                sql = f'SELECT sid, ts/{step}*{step} b, min(mn), avg(av), max(mx) FROM {tab} WHERE sid IN ({ph}) AND ts >= ? GROUP BY sid, b'
            for sid, b, mn, av, mx in self.db().execute(sql, (*byid, t0)):
                out[byid[sid]][b] = (mn, av, mx)
        ts = list(range(t0, now + 1, step))
        res = {}
        for k, pts in out.items():
            if not pts:
                continue
            p = 2 if sens[k][1]['kind'] in ('temp', 'volt') else 1
            res[k] = {'n': [], 'a': [], 'x': []}
            for b in ts:
                v = pts.get(b)
                for i, f in enumerate('nax'):
                    res[k][f].append(round(v[i], p) if v else None)
        return {'group': group, 'range': rng, 'step': step, 'source': tab, 't': ts,
                'meta': {k: sens[k][1] for k in res}, 's': res}

    def stats(self, rng):
        rng = max(60, min(rng, 400 * 86400))
        sens = self.sensors()
        byid = {sid: k for k, (sid, _) in sens.items()}
        now = int(time.time())
        res = {}
        if rng <= 3 * 3600:
            q = 'SELECT sid, min(v), avg(v), max(v) FROM raw WHERE ts >= ? GROUP BY sid'
            rows = self.db().execute(q, (now - rng,))
        else:
            tab = 'm1' if rng <= 14 * 86400 else 'm10'
            rows = self.db().execute(f'SELECT sid, min(mn), avg(av), max(mx) FROM {tab} WHERE ts >= ? GROUP BY sid', (now - rng,))
        for sid, mn, av, mx in rows:
            if sid in byid:
                res[byid[sid]] = [mn, av, mx]
        return {'range': rng, 'stats': res}


def serve(conf):
    Web.conf = conf
    srv = ThreadingHTTPServer((conf['listen'], conf['port']), Web)
    srv.daemon_threads = True
    print(f"web: http://{conf['listen']}:{conf['port']}/", flush=True)
    srv.serve_forever()


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('mode', choices=['collect', 'web', 'once'])
    ap.add_argument('--conf', default=os.environ.get('THERMO_CONF', '/etc/thermo.conf'))
    a = ap.parse_args()
    conf = load_conf(a.conf)
    if a.mode == 'collect':
        Collector(conf).run()
    elif a.mode == 'web':
        serve(conf)
    else:                                   # two samples to stdout, nothing stored
        c = Collector(dict(conf, db=':memory:', now='', telegram=None))
        c.setup()
        c.tick(int(time.time()), time.monotonic())
        time.sleep(conf['interval'])
        c.tick(int(time.time()), time.monotonic())
        doc = c.last_now
        for key, s in sorted(doc['sensors'].items(), key=lambda kv: kv[1]['ord']):
            print(f"{key:40} {s['v']:10.{s['prec']}f} {s['unit']:5} {s['label']:30} {s['lim']} {s['note']}")
        print('superio:', doc['superio'])
        print(json.dumps({'nvme': doc['nvme'], 'gpu': doc['gpu']}, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
