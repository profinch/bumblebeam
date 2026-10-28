#!/usr/bin/env python3
# web-next/index.src.html + the exact pool logo -> index.html (+ gzip size); build.py <dir> also copies it there with the favicon for a preview
import gzip, os, shutil, sys
d = os.path.dirname(os.path.abspath(__file__))
s = open(os.path.join(d, 'index.src.html')).read()
s = s.replace('{{LOGO}}', open(os.path.join(d, '_logo.svg')).read()).replace('{{LOGOCSS}}', open(os.path.join(d, '_logo.css')).read())
open(os.path.join(d, 'index.html'), 'w').write(s)
print('index.html', len(s.encode()), 'gzip', len(gzip.compress(s.encode(), 9)))
if len(sys.argv) > 1:
    out = sys.argv[1]; os.makedirs(out, exist_ok=True)
    shutil.copy(os.path.join(d, 'index.html'), out); shutil.copy(os.path.join(d, '..', 'main', 'www', 'favicon.svg'), out)
