#!/usr/bin/env python3
# Side-by-side benchmark of miners on one pool: every minute each device's /api/system/info and the pool's per-worker
# numbers, into <outdir>/samples.csv; at the end summary.md and report.html (tools/benchreport.py).
#   tools/compare.py <hours> <outdir> [pool-api]   e.g. MINERS='devkit=192.168.0.21' tools/compare.py 8 bench/2026-10-29-solobtc-0.9.0 <pool-api>
#   (a run's folder: the day it starts, the pool, our firmware version)
#   pool-api: the pool's per-address API (or POOL_URL): public-pool and its forks, e.g.
#   https://public-pool.io:40557/api/client/<address>, or ckpool's, e.g. https://pool.nerdminers.org/users/<address>
# MINERS names the devices and their addresses; POOLNAME below maps a name to the pool's worker name (default: the same).
# A device may have several addresses (NMMiner has no access-point lock and moves between the two networks on one SSID):
# the one that answered last is asked first, the others when it does not answer.
import json, time, urllib.request, csv, sys, datetime, statistics, os
HOURS = float(sys.argv[1]) if len(sys.argv) > 1 else 8.0
OUT = (sys.argv[2] if len(sys.argv) > 2 else '.').rstrip('/') + '/'; os.makedirs(OUT, exist_ok=True)
# the miners from MINERS, e.g. MINERS='nmminer=192.168.0.23 devkit=192.168.0.21 devcam=192.168.0.22' (a name may list
# several addresses, comma-separated); the pool's per-address stats URL as the third argument or POOL_URL
DEV = {n: a.split(',') for n, a in (p.split('=', 1) for p in os.environ.get('MINERS', '').split())}
POOL = sys.argv[3] if len(sys.argv) > 3 else os.environ.get('POOL_URL', '')
if not DEV or not POOL: sys.exit('set MINERS and the pool stats URL (argument 3 or POOL_URL)')
POOLNAME = {'nmminer': 'nmminer', 'devkit': 'devkit', 'devcam': 'devcam'}
def get(url, t=8):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'compare/1'}), timeout=t) as r: return json.loads(r.read().decode('utf-8', 'replace'))
    except Exception as e: return None
def device(dev):
    for ip in DEV[dev]:
        d = get(f'http://{ip}/api/system/info')
        if d: DEV[dev].remove(ip); DEV[dev].insert(0, ip); return d, ip
    return None, ''
def workers(pool):
    # worker name (after the address's dot) -> {'hashRate': H/s, 'bestDifficulty': ...}, from public-pool's or ckpool's answer
    if 'workers' in pool: return {x.get('name'): x for x in pool['workers']}
    return {(w.get('workername') or '').partition('.')[2] or 'worker': {'hashRate': pdiff(w.get('hashrate5m', 0)), 'bestDifficulty': w.get('bestshare', '')} for w in pool.get('worker', [])}
def pdiff(s):
    try:
        s = str(s).strip(); m = {'K': 1e3, 'M': 1e6, 'G': 1e9, 'T': 1e12}
        return float(s[:-1]) * m[s[-1]] if s and s[-1] in m else float(s)
    except Exception: return 0.0
rows = []; t0 = time.time(); n = 0   # a sample on every whole minute from the start, the last one HOURS after the first
with open(OUT + 'samples.csv', 'w', newline='') as f:
    w = csv.writer(f); w.writerow(['time_utc', 'device', 'hash_khs_device', 'hash_khs_pool', 'accepted', 'rejected', 'best_session', 'uptime_s', 'free_heap', 'pool_best', 'rssi', 'engine_khs', 'sw_khs', 'fw', 'ip'])
    while n <= round(HOURS * 60):
        time.sleep(max(0, t0 + n * 60 - time.time()))
        ts = datetime.datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S'); pool = get(POOL, 15) or {}
        pw = workers(pool)
        for dev in DEV:
            d, ip = device(dev); d = d or {}; m = d.get('miner', {}); p = pw.get(POOLNAME.get(dev, dev), {})
            row = [ts, dev, round(float(m.get('hashRate', 0)) * 1e6, 1), round(float(p.get('hashRate', 0)) / 1e3, 1) if p else '', m.get('sAccepted', ''), m.get('sRejected', ''), pdiff(m.get('bestDiffSession', 0)), m.get('uptimeSeconds', ''), m.get('freeHeap', ''), p.get('bestDifficulty', '') if p else '', d.get('identity', {}).get('rssi', ''),
                   round(float(m['hashRateEngine']) * 1e6, 1) if 'hashRateEngine' in m else '', round(float(m['hashRateSw']) * 1e6, 1) if 'hashRateSw' in m else '', d.get('identity', {}).get('fwVersion', ''), ip]
            w.writerow(row); rows.append(row)
        f.flush(); n += 1
        if n % 10 == 0: print(ts, 'samples', n, flush=True)
# ---- summary.md and report.html, from samples.csv and run.json
json.dump({'pool': POOL.split('/')[2].split(':')[0], 'pool_api': POOL}, open(OUT + 'run.json', 'w'), indent=1)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); import benchreport
benchreport.build(OUT); print(open(OUT + 'summary.md').read())
