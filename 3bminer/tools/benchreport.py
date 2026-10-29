#!/usr/bin/env python3
# A benchmark run's summary.md (a table GitHub shows as is) and report.html (the page in the dashboard's look, with the
# hashrate over the run), both from the run's samples.csv and run.json.
#   tools/benchreport.py <run dir> [<run dir> ...]
# run.json: {"pool": "solobtc.nmminer.com", "note": "..."} (tools/compare.py writes it; the note is optional)
import csv, json, os, statistics, sys, html as H

NAMES = {'nmminer': 'NMMiner', 'devkit': '3BMiner ESP32-WROOM-32', 'devcam': '3BMiner ESP32-CAM', 'esp32miner': 'esp32miner ESP32-WROOM-32'}   # our miners by their board
COLORS = {'nmminer': '#f4ce4a', 'devkit': '#00f6d2', 'devcam': '#39a0ff', 'esp32miner': '#00f6d2'}
OK = lambda v: isinstance(v, float) and 0 < v < 1e5   # NMMiner once reported 6e15 KH/s: such samples are dropped


def num(s):
    try:
        s = str(s).strip(); m = {'K': 1e3, 'M': 1e6, 'G': 1e9, 'T': 1e12}
        return float(s[:-1]) * m[s[-1]] if s and s[-1] in m else float(s)
    except Exception:
        return None


def load(run):
    rows = list(csv.DictReader(open(os.path.join(run, 'samples.csv'))))
    meta = json.load(open(os.path.join(run, 'run.json'))) if os.path.exists(os.path.join(run, 'run.json')) else {}
    devs = list(dict.fromkeys(r['device'] for r in rows))
    return rows, meta, devs


def summarize(rows, dev):
    r = [x for x in rows if x['device'] == dev]
    f = lambda k: [num(x.get(k)) for x in r]
    hd = [v for v in f('hash_khs_device') if OK(v)]; hp = [v for v in f('hash_khs_pool') if OK(v)]
    acc = [v for v in f('accepted') if v is not None]; rej = [v for v in f('rejected') if v is not None]
    up = [v for v in f('uptime_s') if v is not None]; heap = [v for v in f('free_heap') if v]
    da = sum(max(0, b - a) for a, b in zip(acc, acc[1:])); dr = sum(max(0, b - a) for a, b in zip(rej, rej[1:]))
    hours = (len(r) - 1) / 60
    eng = [v for v in f('engine_khs') if v]; sw = [v for v in f('sw_khs') if v]; rssi = [v for v in f('rssi') if v]
    fw = [x.get('fw') for x in r if x.get('fw')]
    return dict(
        samples=len(r), offline=sum(1 for x in r if x.get('accepted', '') == ''), hours=hours,
        dev=statistics.mean(hd) if hd else None, dmin=min(hd) if hd else None, dmax=max(hd) if hd else None,
        eng=statistics.mean(eng) if eng else None, sw=statistics.mean(sw) if sw else None,
        pool=statistics.mean(hp) if hp else None, pmed=statistics.median(hp) if hp else None,
        acc=da, rej=dr, rejp=100 * dr / (da + dr) if da + dr else None, acch=da / hours if hours else None,
        best=max([v for v in f('best_session') if v is not None] + [0]), pbest=max([v for v in f('pool_best') if v is not None] + [0]),
        reboots=sum(1 for a, b in zip(up, up[1:]) if b < a), heap0=heap[0] if heap else None, heap1=heap[-1] if heap else None,
        heapmin=min(heap) if heap else None, rssi=statistics.mean(rssi) if rssi else None, fw=fw[-1] if fw else '')


def fmt(v, k):
    if v is None: return '-'
    if k in ('dev', 'dmin', 'dmax', 'pool', 'pmed', 'eng', 'sw', 'acch'): return f'{v:.1f}'
    if k == 'rejp': return f'{v:.2f}%'
    if k in ('best', 'pbest'): return f'{v:.4g}'
    if k in ('heap0', 'heap1', 'heapmin'): return f'{v / 1024:.0f} KB' if v < 1e6 else f'{v / 1048576:.2f} MB'
    if k == 'rssi': return f'{v:.0f} dBm'
    return f'{v:.0f}' if isinstance(v, float) else str(v)


ROWS = [('dev', 'Hashrate, average', 'KH/s, the miner\'s own figure'), ('dmin', 'Hashrate, lowest', 'KH/s'), ('dmax', 'Hashrate, highest', 'KH/s'),
        ('eng', 'Engine', 'KH/s, 3BMiner only'), ('sw', 'Software', 'KH/s, 3BMiner only'),
        ('pool', 'Pool estimate, average', 'KH/s, from accepted shares'), ('pmed', 'Pool estimate, median', 'KH/s'),
        ('acc', 'Shares accepted', ''), ('rej', 'Shares rejected', ''), ('rejp', 'Rejected', ''), ('acch', 'Accepted per hour', ''),
        ('best', 'Best difficulty', 'the miner\'s'), ('pbest', 'Best difficulty, pool', ''), ('reboots', 'Restarts', ''),
        ('offline', 'Samples without an answer', ''), ('heap0', 'Free memory, first', ''), ('heap1', 'Free memory, last', ''),
        ('heapmin', 'Free memory, lowest', 'of the samples'), ('rssi', 'Wi-Fi signal', 'average'), ('samples', 'Samples', 'one a minute')]


def ratios(S, devs):
    if 'nmminer' not in S or not S['nmminer']['dev']: return []
    n = S['nmminer']; out = []
    for d in devs:
        if d == 'nmminer': continue
        x = S[d]; out.append((d, x['dev'] / n['dev'] if x['dev'] else None, x['pool'] / n['pool'] if x['pool'] and n['pool'] else None))
    return out


def markdown(run, rows, meta, devs, S):
    t0, t1 = rows[0]['time_utc'], rows[-1]['time_utc']; h = max(s['hours'] for s in S.values())
    L = [f"# {os.path.basename(run.rstrip('/'))}", '', f"{t0} - {t1} UTC, {h:.1f} h, pool {meta.get('pool', '?')}. "
         "One sample a minute of each miner's own figures and the pool's per-worker ones; raw data in [samples.csv](samples.csv), "
         "the page with the hashrate over the run in [report.html](report.html).", '']
    if meta.get('note'): L += [meta['note'], '']
    L.append('| | ' + ' | '.join(NAMES.get(d, d) + (f" {S[d]['fw']}" if S[d]['fw'] else '') for d in devs) + ' |')
    L.append('|---|' + '---:|' * len(devs))
    for k, lab, _ in ROWS:
        vals = [fmt(S[d][k], k) for d in devs]
        if all(v == '-' for v in vals): continue
        L.append(f'| {lab} | ' + ' | '.join(vals) + ' |')
    R = ratios(S, devs)
    if R:
        L += ['', 'Against NMMiner: ' + '; '.join(f"{NAMES.get(d, d)} {a:.3f} own hashrate" + (f", {b:.3f} pool estimate" if b else '') for d, a, b in R if a) + '.']
    return '\n'.join(L) + '\n'


def chart(rows, devs, key, title, unit, win=10):
    # one line per miner, averaged over win minutes so the pool's noisy estimate reads
    W, Ht, pl, pr, pt, pb = 900, 260, 52, 14, 14, 26
    series = {}
    for d in devs:
        pts = [(i, num(x.get(key))) for i, x in enumerate(r for r in rows if r['device'] == d)]
        pts = [(i, v) for i, v in pts if OK(v)]
        if len(pts) < 2: continue
        sm = []
        for i, _ in pts:
            w = [v for j, v in pts if i - win < j <= i]; sm.append((i, sum(w) / len(w)))
        series[d] = sm
    if not series: return ''
    n = max(i for s in series.values() for i, _ in s) or 1
    vals = [v for s in series.values() for _, v in s]; lo, hi = min(vals), max(vals); pad = max(5, (hi - lo) * .15); lo -= pad; hi += pad
    X = lambda i: pl + (W - pl - pr) * i / n; Y = lambda v: pt + (Ht - pt - pb) * (1 - (v - lo) / (hi - lo))
    g = []
    for k in range(5):
        v = lo + (hi - lo) * k / 4; y = Y(v)
        g.append(f'<line x1={pl} x2={W - pr} y1={y:.1f} y2={y:.1f} class=gl /><text x={pl - 6} y={y + 4:.1f} class=ax text-anchor=end>{v:.0f}</text>')
    hours = n / 60
    for hh in range(0, int(hours) + 1):
        x = X(hh * 60); g.append(f'<text x={x:.1f} y={Ht - 6} class=ax text-anchor=middle>{hh} h</text>')
    for d, s in series.items():
        g.append(f'<polyline fill=none stroke="{COLORS.get(d, "#fff")}" stroke-width=1.6 stroke-linejoin=round points="' + ' '.join(f'{X(i):.1f},{Y(v):.1f}' for i, v in s) + '"/>')
    leg = ''.join(f'<span><i style="background:{COLORS.get(d, "#fff")}"></i>{H.escape(NAMES.get(d, d))}</span>' for d in series)
    return f'<div class=p><div class=k>{title}</div><div class=leg>{leg}</div><svg viewBox="0 0 {W} {Ht}" class=ch role=img aria-label="{H.escape(title)}">{"".join(g)}</svg><p class=hint>{unit}</p></div>'


CSS = """:root{--a:#00f6d2;--y:#f4ce4a;--r:#f25f5b;--m:rgba(255,255,255,.5);--td:rgba(255,255,255,.8);--b:rgba(255,255,255,.07);--s:rgba(255,255,255,.04);--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
html{background:#0a5a80}body{margin:0;min-height:100vh;color:#fff;font:14px -apple-system,'Segoe UI',Roboto,Arial,sans-serif;background:linear-gradient(180deg,#031d35,#043a5b 55%,#0a5a80) fixed}
main{max-width:1100px;margin:0 auto;padding:24px 16px 40px}h1{font:700 22px var(--mono);margin:0 0 4px}h1 b{color:var(--a)}.sub{color:var(--m);font:12px var(--mono);margin:0 0 18px;line-height:1.6}
.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:12px}.p{background:var(--s);border:1px solid var(--b);border-radius:8px;padding:16px;margin-bottom:12px;min-width:0}
.k{font:700 10px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--m)}.v{font:700 26px var(--mono);margin-top:6px}.v small{font-size:12px;color:var(--m);font-weight:400}.sm{font-size:12px;color:var(--m);line-height:1.6;margin-top:4px}
.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:8px;vertical-align:0}
table{width:100%;border-collapse:collapse;font:12px var(--mono)}td,th{padding:7px 10px;border-bottom:1px solid var(--b);text-align:right;white-space:nowrap}td:first-child,th:first-child{text-align:left;color:var(--m)}th{color:var(--m);font-size:10px;text-transform:uppercase;letter-spacing:.05em}td small{display:block;color:var(--m);font-size:10px}td:first-child{white-space:normal;min-width:120px}tbody tr:hover{background:rgba(255,255,255,.03)}
.sc{overflow-x:auto;margin-top:10px}.ch{width:100%;height:auto;margin-top:10px}.gl{stroke:rgba(255,255,255,.07)}.ax{fill:rgba(255,255,255,.45);font:10px var(--mono)}
.leg{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:10px;font:12px var(--mono);color:var(--td)}.leg i{display:inline-block;width:14px;height:3px;border-radius:2px;margin-right:6px;vertical-align:3px}
.hint{font:11px var(--mono);color:var(--m);margin:6px 0 0}.note{color:var(--td);font-size:13px;line-height:1.6}.y{color:var(--y)}a{color:var(--a)}
footer{margin-top:24px}.foot-copy{margin:4px 0 0;text-align:center;font:400 11px var(--mono);letter-spacing:.02em;color:rgba(255,255,255,.4)}.foot-copy a{color:var(--m);text-decoration:underline dotted rgba(255,255,255,.25);text-underline-offset:3px}.foot-copy a:hover{color:#fff;text-decoration-color:rgba(255,255,255,.5)}"""


# the dashboard's footer
FOOTER = ('<footer><p class=foot-copy>&copy; 2026 <a href="https://bumblebeam.org" target=_blank rel=noopener>BumbleBeam</a> &middot; a community PoW miner for '
          '<a href="https://bitcoin.org" target=_blank rel=noopener>Bitcoin</a> (BTC) &middot; open source under Apache-2.0 on '
          '<a href="https://github.com/profinch/bumblebeam/tree/main/3bminer" target=_blank rel=noopener>GitHub</a></p></footer>')


def page(run, rows, meta, devs, S):
    name = os.path.basename(run.rstrip('/')); t0, t1 = rows[0]['time_utc'], rows[-1]['time_utc']; h = max(s['hours'] for s in S.values())
    cards = ''
    for d in devs:
        s = S[d]
        cards += (f'<div class=p><div class=k><span class=sw style="background:{COLORS.get(d, "#fff")}"></span>{H.escape(NAMES.get(d, d))}'
                  f'{(" " + H.escape(s["fw"])) if s["fw"] else ""}</div><div class=v>{fmt(s["dev"], "dev")}<small> KH/s</small></div>'
                  f'<div class=sm>pool estimate {fmt(s["pool"], "pool")} KH/s<br>rejected {fmt(s["rejp"], "rejp")} &middot; restarts {s["reboots"]}'
                  + '</div></div>')
    head = ''.join(f'<th>{H.escape(NAMES.get(d, d))}</th>' for d in devs)
    body = ''
    for k, lab, unit in ROWS:
        vals = [fmt(S[d][k], k) for d in devs]
        if all(v == '-' for v in vals): continue
        body += f'<tr><td>{lab}{(" <small>" + H.escape(unit) + "</small>") if unit else ""}</td>' + ''.join(f'<td>{v}</td>' for v in vals) + '</tr>'
    note = f'<div class=p><div class=k>Note</div><p class=note>{H.escape(meta["note"])}</p></div>' if meta.get('note') else ''
    return (f'<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">'
            f'<title>3BMiner benchmark {H.escape(name)}</title><style>{CSS}</style></head><body><main>'
            f'<h1><b>3BMiner</b> benchmark</h1><p class=sub>{H.escape(name)}<br>{t0} - {t1} UTC &middot; {h:.1f} h &middot; pool {H.escape(meta.get("pool", "?"))}'
            f' &middot; one sample a minute</p><div class=g>{cards}</div>{note}'
            + chart(rows, devs, 'hash_khs_device', 'Hashrate, the miner\'s own', 'KH/s, 10-minute averages')
            + chart(rows, devs, 'hash_khs_pool', 'Hashrate, the pool\'s estimate', 'KH/s, hourly averages of the pool\'s per-worker figure: noisy, it counts random shares', 60)
            + f'<div class=p><div class=k>All figures</div><div class=sc><table><thead><tr><th></th>{head}</tr></thead><tbody>{body}</tbody></table></div></div>'
            + FOOTER + '</main></body></html>\n')


def build(run):
    rows, meta, devs = load(run)
    S = {d: summarize(rows, d) for d in devs}
    open(os.path.join(run, 'summary.md'), 'w').write(markdown(run, rows, meta, devs, S))
    open(os.path.join(run, 'report.html'), 'w').write(page(run, rows, meta, devs, S))
    return S


if __name__ == '__main__':
    for run in sys.argv[1:]:
        build(run); print('wrote', os.path.join(run, 'summary.md'), 'and report.html')
