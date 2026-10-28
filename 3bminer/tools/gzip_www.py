#!/usr/bin/env python3
# gzip_www.py <in> <out>: gzip -9 with a fixed mtime, so the same page gives the same image
import gzip, sys
src = open(sys.argv[1], 'rb').read()
open(sys.argv[2], 'wb').write(gzip.compress(src, 9, mtime=0))
