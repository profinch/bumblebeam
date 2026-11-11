#!/usr/bin/env python3
# usage: resync.py <live db> <copy>
# Re-copy the chunks of a live SQLite file that differ from the copy (read-only on the source)
import sys, os, struct, time
src, dst = sys.argv[1], sys.argv[2]
CH = 1 << 20
def counter(f):
    f.seek(24); return struct.unpack(">I", f.read(4))[0]
t0 = time.time()
with open(src, "rb", buffering=0) as s, open(dst, "r+b", buffering=0) as d:
    c1 = counter(s)
    size = os.fstat(s.fileno()).st_size
    d.truncate(size)
    off = n = 0
    while off < size:
        s.seek(off); a = s.read(CH)
        d.seek(off); b = d.read(len(a))
        if a != b:
            d.seek(off); d.write(a); n += 1
        off += CH
    c2 = counter(s)
print(f"changed chunks {n}, counter {c1}->{c2}, size {size}, {time.time()-t0:.0f}s", flush=True)
