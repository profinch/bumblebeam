#!/usr/bin/env python3
# main/www/index.html -> main/www/index.html.gz, embedded in the firmware and served gzip-compressed
import gzip, os
d = os.path.join(os.path.dirname(__file__), '..', 'main', 'www')
src = open(os.path.join(d, 'index.html'), 'rb').read()
open(os.path.join(d, 'index.html.gz'), 'wb').write(gzip.compress(src, 9, mtime=0))
print(len(src), '->', os.path.getsize(os.path.join(d, 'index.html.gz')))
