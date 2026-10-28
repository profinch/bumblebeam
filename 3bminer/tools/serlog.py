# serial logger (Windows, pyserial) for a board, also the ESP32-CAM on a CH340 that takes one reconfiguration: 115200 set once, later errors swallowed,
# then a reset through RTS (EN) with DTR (IO0) high so it boots the app; every line timestamped to the log file
import sys, time, serial, serial.serialwin32 as sw
port, secs, out = sys.argv[1], float(sys.argv[2]), sys.argv[3]
reset = 'noreset' not in sys.argv[4:]
s = serial.Serial(); s.port = port; s.baudrate = 9600; s.dtr = False; s.rts = False; s.open(); s.baudrate = 115200; s.close()
_orig = sw.Serial._reconfigure_port
def _reconf(self, *a, **k):
    try: _orig(self, *a, **k)
    except serial.SerialException as e:
        if '31' not in str(e): raise
sw.Serial._reconfigure_port = _reconf
s = serial.Serial(); s.port = port; s.baudrate = 115200; s.timeout = 0.5; s.dtr = False; s.rts = False; s.open()
if reset: s.rts = True; time.sleep(0.2); s.rts = False
t0 = time.time(); f = open(out, 'w', encoding='utf-8', errors='replace'); buf = b''
while time.time() - t0 < secs:
    buf += s.read(4096)
    while b'\n' in buf:
        line, buf = buf.split(b'\n', 1)
        f.write('%8.2f %s\n' % (time.time() - t0, line.decode('utf-8', 'replace').rstrip())); f.flush()
f.close()
