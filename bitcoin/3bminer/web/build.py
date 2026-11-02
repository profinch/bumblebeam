#!/usr/bin/env python3
# web/index.html (the board's page) and web/display.html (review page for the screens of display boards, never served
# by the firmware) + the exact pool logo -> web/out/; index.html also goes to firmware/main/www/ for the firmware;
# build.py <dir> also copies both there with the favicon.
# The page goes into the firmware gzipped: CSS and HTML comments are dropped and the script is minified with terser
# (when installed: names stay, so inline handlers keep working); the source stays readable.
import gzip, os, re, shutil, subprocess, sys
d = os.path.dirname(os.path.abspath(__file__))
logo, logocss = open(os.path.join(d, 'logo.svg')).read(), open(os.path.join(d, 'logo.css')).read()
def slim(s):
    s = re.sub(r'<!--.*?-->', '', s, flags=re.S)
    # CSS: comments out, no whitespace next to { } ; , > or after a property's colon, other runs to one space
    def css(m):
        c = re.sub(r'/\*.*?\*/', '', m.group(2), flags=re.S)
        c = re.sub(r'\s*([{};,>])\s*', r'\1', c); c = re.sub(r'(--[\w-]+|[a-z-]+):\s+', r'\1:', c); c = re.sub(r'\s+', ' ', c).replace(';}', '}')
        return m.group(1) + c.strip() + m.group(3)
    s = re.sub(r'(<style>)(.*?)(</style>)', css, s, flags=re.S)
    if not shutil.which('terser'): sys.exit('terser is needed: npm i -g terser')
    if True:
        def js(m):
            r = subprocess.run(['terser', '-c', '-m'], input=m.group(2), capture_output=True, text=True)
            if r.returncode or not r.stdout: sys.exit('terser failed (a syntax error in the script?):\n' + r.stderr[:2000])   # never ship a broken page
            return m.group(1) + r.stdout + m.group(3)
        s = re.sub(r'(<script>)(.*?)(</script>)', js, s, flags=re.S)
    return s
o = os.path.join(d, 'out'); os.makedirs(o, exist_ok=True)
www = os.path.join(d, '..', 'firmware', 'main', 'www')
# The shared design tokens (ui/tokens.css at the repository root), Bitcoin's accent: 3BMiner is always data-chain=bitcoin,
# so the chain's values are folded into one :root, and only the variables the page uses (and those they refer to) go in
def ui_tokens(page):
    t = re.sub(r'/\*.*?\*/', '', open(os.path.join(d, '..', '..', '..', 'ui', 'tokens.css')).read(), flags=re.S)
    decl = {}
    for sel, body in re.findall(r'([^{}]+)\{([^{}]*)\}', t):
        if sel.strip() not in (':root', ':root[data-chain="bitcoin"]'): continue
        for k, v in re.findall(r'(--[\w-]+)\s*:\s*([^;]+);', body): decl[k] = re.sub(r'\s+', ' ', v.strip())
    need, todo = set(), set(re.findall(r'var\((--[\w-]+)', page))
    while todo:
        k = todo.pop()
        if k in need or k not in decl: continue
        need.add(k); todo |= set(re.findall(r'var\((--[\w-]+)', decl[k]))
    miss = set(re.findall(r'var\((--[\w-]+)', page)) - set(decl) - set(re.findall(r'(--[\w-]+)\s*:', page))
    if miss: sys.exit('variables the page uses that ui/tokens.css does not have: ' + ', '.join(sorted(miss)))
    return ':root{' + ';'.join(k + ':' + decl[k] for k in sorted(need)) + '}'
for name in ('index', 'display'):
    s = open(os.path.join(d, name + '.html')).read().replace('{{LOGO}}', logo).replace('{{LOGOCSS}}', logocss)
    s = s.replace('{{UI_TOKENS}}', ui_tokens(s))
    s = slim(s)
    open(os.path.join(o, name + '.html'), 'w').write(s)
    print(name + '.html', len(s.encode()), 'gzip', len(gzip.compress(s.encode(), 9)))
# the firmware serves the built page as firmware/main/www/index.html
shutil.copy(os.path.join(o, 'index.html'), os.path.join(www, 'index.html'))
if len(sys.argv) > 1:
    out = sys.argv[1]; os.makedirs(out, exist_ok=True)
    for f in ('index.html', 'display.html'): shutil.copy(os.path.join(o, f), out)
    shutil.copy(os.path.join(www, 'favicon.svg'), out)
