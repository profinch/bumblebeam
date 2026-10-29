#!/usr/bin/env python3
# Side-by-side benchmark of miners on one pool: every minute each device's /api/system/info and the pool's per-worker
# numbers, into <outdir>/samples.csv; at the end summary.txt and report.html.
#   tools/compare.py <hours> <outdir> [pool-api]   e.g. tools/compare.py 8 bench/run8-v0.8.0-solobtc
#   pool-api: the pool's per-address API (public-pool and its forks), solobtc.nmminer.com by default, e.g.
#   https://public-pool.io:40557/api/client/<address>
# DEV, POOL and POOLNAME below are this setup's: the devices' addresses, the pool's per-address API, the worker names.
import json, time, urllib.request, csv, sys, datetime, statistics, os
HOURS = float(sys.argv[1]) if len(sys.argv) > 1 else 8.0
OUT = (sys.argv[2] if len(sys.argv) > 2 else '.').rstrip('/') + '/'; os.makedirs(OUT, exist_ok=True)
DEV = {'nmminer': 'http://192.168.1.232/api/system/info', 'devkit': 'http://192.168.88.228/api/system/info', 'esp32cam': 'http://192.168.88.69/api/system/info'}
POOL = sys.argv[3] if len(sys.argv) > 3 else 'https://solobtc.nmminer.com/api/client/bc1ql05gvhfxgkca6y7wuxzz7sx08qcecdfea90wmc'
POOLNAME = {'nmminer': 'worker', 'devkit': 'esp32', 'esp32cam': 'esp32cam'}
def get(url, t=8):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'compare/1'}), timeout=t) as r: return json.loads(r.read().decode('utf-8', 'replace'))
    except Exception as e: return None
def pdiff(s):
    try:
        s = str(s).strip(); m = {'K': 1e3, 'M': 1e6, 'G': 1e9, 'T': 1e12}
        return float(s[:-1]) * m[s[-1]] if s and s[-1] in m else float(s)
    except Exception: return 0.0
rows = []; t0 = time.time(); n = 0   # a sample on every whole minute from the start, the last one HOURS after the first
with open(OUT + 'samples.csv', 'w', newline='') as f:
    w = csv.writer(f); w.writerow(['time_utc', 'device', 'hash_khs_device', 'hash_khs_pool', 'accepted', 'rejected', 'best_session', 'uptime_s', 'free_heap', 'pool_best', 'rssi', 'engine_khs', 'sw_khs', 'fw'])
    while n <= round(HOURS * 60):
        time.sleep(max(0, t0 + n * 60 - time.time()))
        ts = datetime.datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S'); pool = get(POOL, 15) or {}
        pw = {x.get('name'): x for x in pool.get('workers', [])}
        for dev, url in DEV.items():
            d = get(url) or {}; m = d.get('miner', {}); p = pw.get(POOLNAME[dev], {})
            row = [ts, dev, round(float(m.get('hashRate', 0)) * 1e6, 1), round(float(p.get('hashRate', 0)) / 1e3, 1) if p else '', m.get('sAccepted', ''), m.get('sRejected', ''), pdiff(m.get('bestDiffSession', 0)), m.get('uptimeSeconds', ''), m.get('freeHeap', ''), p.get('bestDifficulty', '') if p else '', d.get('identity', {}).get('rssi', ''),
                   round(float(m['hashRateEngine']) * 1e6, 1) if 'hashRateEngine' in m else '', round(float(m['hashRateSw']) * 1e6, 1) if 'hashRateSw' in m else '', d.get('identity', {}).get('fwVersion', '')]
            w.writerow(row); rows.append(row)
        f.flush(); n += 1
        if n % 10 == 0: print(ts, 'samples', n, flush=True)
# ---- summary
def summarize(dev):
    r = [x for x in rows if x[1] == dev]
    hd = [x[2] for x in r if isinstance(x[2], float) and 0 < x[2] < 1e5]; hp = [x[3] for x in r if isinstance(x[3], float) and 0 < x[3] < 1e5]   # drop garbage API samples (NMMiner once returned 6e15)
    acc = [x[4] for x in r if x[4] != '']; rej = [x[5] for x in r if x[5] != '']; up = [x[7] for x in r if x[7] != '']
    reboots = sum(1 for a, b in zip(up, up[1:]) if b < a); offline = sum(1 for x in r if x[4] == '')
    # shares over the window: sum of positive deltas (handles counter resets on reboot)
    da = sum(max(0, b - a) for a, b in zip(acc, acc[1:])); dr = sum(max(0, b - a) for a, b in zip(rej, rej[1:]))
    best = max([x[6] for x in r] + [0]); pbest = max([float(x[9]) for x in r if x[9] != ''] + [0])
    hours = (len(r) - 1) / 60   # minutes between the first sample and the last
    return dict(dev=dev, samples=len(r), offline=offline, hours=hours, dev_khs=statistics.mean(hd) if hd else 0, dev_min=min(hd) if hd else 0, dev_max=max(hd) if hd else 0, pool_khs=statistics.mean(hp) if hp else 0, acc=da, rej=dr, shares_per_h=da / hours if hours else 0, best=best, pool_best=pbest, reboots=reboots)
S = [summarize(d) for d in DEV]
lines = [f"Comparison over {HOURS:.1f} h, {rows[0][0] if rows else ''} - {rows[-1][0] if rows else ''} UTC, pool {POOL.split('/')[2]}", '']
hdr = f"{'metric':28s}" + ''.join(f"{d:>16s}" for d in DEV); lines.append(hdr); lines.append('-' * len(hdr))
for k, lab in [('dev_khs', 'hashrate, device avg KH/s'), ('dev_min', 'hashrate, device min KH/s'), ('dev_max', 'hashrate, device max KH/s'), ('pool_khs', 'hashrate, pool est. KH/s'), ('acc', 'shares accepted'), ('rej', 'shares rejected'), ('shares_per_h', 'accepted per hour'), ('best', 'best diff (device)'), ('pool_best', 'best diff (pool)'), ('reboots', 'reboots'), ('offline', 'samples unreachable'), ('samples', 'samples')]:
    lines.append(f"{lab:28s}" + ''.join(f"{x[k]:>16.4g}" for x in S))
if S[0]['dev_khs']:
    lines.append('')
    for x in S[1:]: lines.append(f"ratio {x['dev']}/nmminer: device {x['dev_khs']/S[0]['dev_khs']:.3f}, pool {x['pool_khs']/S[0]['pool_khs'] if S[0]['pool_khs'] else 0:.3f}, shares {x['acc']/S[0]['acc'] if S[0]['acc'] else 0:.3f}")
txt = '\n'.join(lines); open(OUT + 'summary.txt', 'w').write(txt + '\n'); print(txt)
html = "<!doctype html><html><head><meta charset=utf-8><title>Miner comparison</title><style>body{font-family:system-ui;background:#111;color:#eee;padding:20px}table{border-collapse:collapse}td,th{padding:6px 14px;border-bottom:1px solid #333;text-align:right}td:first-child,th:first-child{text-align:left}</style></head><body><h2>" + ' vs '.join(DEV) + f", {HOURS:.1f} h</h2><table><tr><th>metric</th>" + ''.join(f"<th>{d}</th>" for d in DEV) + "</tr>"
for l in lines[3:]:
    if l.strip() and not l.startswith('-') and not l.startswith('ratio'): parts = l.split(); n = len(DEV); html += "<tr><td>" + ' '.join(parts[:-n]) + "</td>" + ''.join(f"<td>{v}</td>" for v in parts[-n:]) + "</tr>"
html += "</table><p>" + '<br>'.join(l for l in lines if l.startswith('ratio')) + "</p><p>raw data: samples.csv</p></body></html>"
open(OUT + 'report.html', 'w').write(html)
