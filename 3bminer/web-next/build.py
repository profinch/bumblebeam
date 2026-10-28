#!/usr/bin/env python3
# web-next/*.src.html + the exact pool logo -> index.html (the next web UI) and display.html (review page for the
# screens of display boards, never served by the firmware); build.py <dir> also copies them there with the favicon
import gzip, os, shutil, sys
d = os.path.dirname(os.path.abspath(__file__))
logo, logocss = open(os.path.join(d, '_logo.svg')).read(), open(os.path.join(d, '_logo.css')).read()
for name in ('index', 'display'):
    s = open(os.path.join(d, name + '.src.html')).read().replace('{{LOGO}}', logo).replace('{{LOGOCSS}}', logocss)
    open(os.path.join(d, name + '.html'), 'w').write(s)
    print(name + '.html', len(s.encode()), 'gzip', len(gzip.compress(s.encode(), 9)))
if len(sys.argv) > 1:
    out = sys.argv[1]; os.makedirs(out, exist_ok=True)
    for f in ('index.html', 'display.html'): shutil.copy(os.path.join(d, f), out)
    shutil.copy(os.path.join(d, '..', 'main', 'www', 'favicon.svg'), out)
