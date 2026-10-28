# esptool for a CH340 whose Windows driver accepts only the first port reconfiguration after open:
# set 115200 once by hand, then let esptool run with reconfiguration errors swallowed (the port keeps 115200)
import sys, time, serial, serial.serialwin32 as sw
s = serial.Serial(); s.port = sys.argv[sys.argv.index('--port') + 1]; s.baudrate = 9600; s.dtr = False; s.rts = False; s.open(); s.baudrate = 115200; s.close()
_orig = sw.Serial._reconfigure_port
def _reconf(self, *a, **k):
    try: _orig(self, *a, **k)
    except serial.SerialException as e:
        if '31' not in str(e): raise
sw.Serial._reconfigure_port = _reconf
import esptool
esptool.main(sys.argv[1:])
