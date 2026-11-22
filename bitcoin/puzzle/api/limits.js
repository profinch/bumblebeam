// What the pool's limits did, to decide them (32 open pieces per IP, none per address, a silent piece back after
// 5 minutes): read from the pool's own database, nothing else. Usage: node limits.js [DATA_DIR] [days, 30]
//
// It answers:
// - how many pieces an IP and an address really hold at once (the counts saved with every lease), and how many
//   leases a limit of N would have refused: per IP and, for a limit per address, per address;
// - who hits the limits (the refusals kept in limit_log), and whether they look like offices behind one IP (many
//   addresses, pieces done) or like someone grabbing pieces (pieces taken back unsearched);
// - how many pieces go back because their browser fell silent, run out, or are given up, and how often pings
//   stretched a lease past its 90 minutes.
// A client is the keyed hash of an IP the pool keeps for its limits, never the IP.
'use strict';
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dir = process.argv[2] || process.env.DATA_DIR || path.join(__dirname, 'data');
const days = Number(process.argv[3] || 30);
const db = new DatabaseSync(path.join(dir, 'pool.db'), { readOnly: true });
const since = Math.floor(Date.now() / 1000) - days * 86400;
const q = (sql, ...v) => db.prepare(sql).all(...v);
const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0);
const short = (s) => (s && s.length > 16 ? s.slice(0, 8) + '…' + s.slice(-6) : s || '');
const share = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : '-');
function table(head, rows) {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((c, i) => (typeof c === 'number' ? String(c).padStart(w[i]) : String(c).padEnd(w[i]))).join('  ');
  console.log(line(head)); rows.forEach((r) => console.log(line(r))); console.log('');
}

const L = q('SELECT id, client, addr, issued, done_at, status, open_client, open_addr, ext, silent FROM leases WHERE issued > ?', since);
console.log(`The pool's limits over the last ${days} days: ${L.length} leases, ${new Set(L.map((l) => l.client)).size} clients (IPs), ${new Set(L.map((l) => l.addr)).size} payout addresses\n`);
if (!L.length) process.exit(0);

console.log('Per day');
const byDay = new Map();
for (const l of L) {
  const d = new Date(l.issued * 1000).toISOString().slice(0, 10);
  const x = byDay.get(d) || { n: 0, c: new Set(), a: new Set(), done: 0, failed: 0, released: 0, expired: 0, silent: 0, ext: 0 };
  x.n++; x.c.add(l.client); x.a.add(l.addr); if (x[l.status] !== undefined) x[l.status]++; if (l.silent) x.silent++; if (l.ext) x.ext++;
  byDay.set(d, x);
}
const R = q('SELECT t, kind, client, addr, open_client, open_addr FROM limit_log WHERE t > ?', since);
const refusedOn = (d, k) => R.filter((r) => r.kind === k && new Date(r.t * 1000).toISOString().slice(0, 10) === d).length;
table(['day', 'leases', 'IPs', 'addresses', 'done', 'failed', 'released', 'expired', 'of them silent', 'stretched', 'refused: open', 'refused: rate', 'refused: live'],
  [...byDay.keys()].sort().map((d) => { const x = byDay.get(d); return [d, x.n, x.c.size, x.a.size, x.done, x.failed, x.released, x.expired, x.silent, x.ext, refusedOn(d, 'open'), refusedOn(d, 'rate'), refusedOn(d, 'live') + refusedOn(d, 'live_all')]; }));

console.log('Pieces held at once, counted when each lease was handed out (this one included)');
const oc = L.map((l) => l.open_client).filter((x) => x != null).sort((a, b) => a - b), oa = L.map((l) => l.open_addr).filter((x) => x != null).sort((a, b) => a - b);
table(['', 'median', 'p95', 'p99', 'max'], [['per IP', pct(oc, 0.5), pct(oc, 0.95), pct(oc, 0.99), oc[oc.length - 1] || 0], ['per address', pct(oa, 0.5), pct(oa, 0.95), pct(oa, 0.99), oa[oa.length - 1] || 0]]);

console.log('What a limit of N would have refused (the leases handed out beyond it, and whose)');
const what = (key, field) => [2, 3, 4, 8, 16, 32, 64].map((n) => {
  const over = L.filter((l) => l[field] > n);
  return [key + ' ' + n, over.length, share(over.length, L.length), new Set(over.map((l) => l[key === 'per IP' ? 'client' : 'addr'])).size, over.filter((l) => l.status === 'done').length];
});
table(['limit', 'leases refused', 'of all', 'distinct holders', 'of them finished honestly'], what('per IP', 'open_client').concat(what('per address', 'open_addr')));

console.log('The IPs holding the most at once: many addresses and pieces done look like an office or a mobile network');
const by = (key) => {
  const m = new Map();
  for (const l of L) {
    const x = m.get(l[key]) || { peak: 0, n: 0, done: 0, back: 0, silent: 0, other: new Set() };
    x.peak = Math.max(x.peak, (key === 'client' ? l.open_client : l.open_addr) || 0); x.n++;
    if (l.status === 'done') x.done++; if (l.status === 'expired' || l.status === 'released') x.back++; if (l.silent) x.silent++;
    x.other.add(key === 'client' ? l.addr : l.client);
    m.set(l[key], x);
  }
  return [...m.entries()];
};
const refusedBy = (key, id) => R.filter((r) => r[key] === id && r.kind === 'open').length;
table(['IP (hash)', 'peak open', 'leases', 'addresses', 'done', 'back unfinished', 'silent', 'refused (open)'],
  by('client').sort((a, b) => b[1].peak - a[1].peak).slice(0, 15).map(([id, x]) => [id.slice(0, 10), x.peak, x.n, x.other.size, x.done, x.back, x.silent, refusedBy('client', id)]));

console.log('The addresses holding the most at once: many IPs and pieces done look like a farm of machines');
table(['address', 'peak open', 'leases', 'IPs', 'done', 'back unfinished', 'silent'],
  by('addr').sort((a, b) => b[1].peak - a[1].peak).slice(0, 15).map(([id, x]) => [short(id), x.peak, x.n, x.other.size, x.done, x.back, x.silent]));

console.log('Pieces taken and not searched: the most leases back unfinished (a grab looks like many back, few done)');
table(['IP (hash)', 'leases', 'back unfinished', 'share', 'done', 'addresses'],
  by('client').filter(([, x]) => x.back >= 5).sort((a, b) => b[1].back / b[1].n - a[1].back / a[1].n).slice(0, 15).map(([id, x]) => [id.slice(0, 10), x.n, x.back, share(x.back, x.n), x.done, x.other.size]));

console.log('How long a finished piece took (handed out to reported), and the leases pings stretched');
const dur = L.filter((l) => l.status === 'done' && l.done_at).map((l) => l.done_at - l.issued).sort((a, b) => a - b);
const min = (s) => (s / 60).toFixed(1) + ' min';
table(['finished pieces', 'median', 'p95', 'max', 'stretched past 90 min', 'stretched most'], [[dur.length, min(pct(dur, 0.5)), min(pct(dur, 0.95)), min(dur[dur.length - 1] || 0), L.filter((l) => l.ext).length, L.reduce((m, l) => Math.max(m, l.ext || 0), 0) + ' × 10 min']]);
