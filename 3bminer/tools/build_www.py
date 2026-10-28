#!/usr/bin/env python3
# main/www/index.html -> main/www/index.html.gz, embedded in the firmware and served gzip-compressed
import gzip, os
d = os.path.join(os.path.dirname(__file__), '..', 'main', 'www')
# favicon.svg is BumbleBeam's pool/web/favicon.svg, byte for byte
for f in ('index.html', 'favicon.svg'):
    src = open(os.path.join(d, f), 'rb').read()
    open(os.path.join(d, f + '.gz'), 'wb').write(gzip.compress(src, 9, mtime=0))
    print(f, len(src), '->', os.path.getsize(os.path.join(d, f + '.gz')))
