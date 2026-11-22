// Unit tests of the coordinator (api/pool.js), in-process, without the network: leases and their limits, the
// lease kept alive by pings, the grace for a late report, a silent browser's piece going back, invites written down
// with the first credited piece, the pool moving on past a find whose claim is stuck, the live stream's per-client
// limit, and how fast the pages' queries stay with many searchers. Run: node bitcoin/puzzle/tests/pool.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { S, T, K, PZ, FINDER, POOL, ok, eq, done } = require('./engine.js');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-pool-'));
  Object.assign(process.env, { POOL_CHUNK_BITS: '16', POOL_PAYOUT_ADDRESS: POOL, POOL_SECRET: '22'.repeat(32), FOUND_CHECK_SECONDS: '3600' });
  let clock = 1_800_000_000, targets = [24, 25];
  const realNow = Date.now;
  Date.now = () => clock * 1000; // the coordinator's clock, moved by the tests
  const pool = require('../api/pool.js').createPool({
    dataDir: dir, secp: S, tx: T, kit: K, node: async () => { throw new Error('no node in these tests'); },
    target: () => targets[0], targets: () => targets, address: (n) => PZ.address(n), tip: () => 900000, blockHash: async (h) => h.toString(16).padStart(64, '0'),
  });
  const db = pool.db;
  const leaseOf = (id) => db.prepare('SELECT * FROM leases WHERE id = ?').get(id);
  const A = (k) => require('./engine.js').p2wpkh(k);
  // the check keys of a lease, as a browser that searched the whole piece reports them
  function checks(L) {
    const l = leaseOf(L.lease), size = 1n << 16n, from = (1n << BigInt(l.puzzle - 1)) + BigInt(l.chunk) * size;
    return JSON.parse(l.checks).map((x) => '0x' + (from + BigInt('0x' + x)).toString(16));
  }

  console.log('leases');
  let r0;
  const L1 = (await pool.lease({ addr: FINDER }, 'c1'))[1];
  ok(L1.lease && L1.puzzle === 24, 'a lease of the first target (#24)');
  const open = [];
  // (three seconds apart: the rate limit allows 30 requests a minute per client)
  for (let i = 0; i < 31; i++) { clock += 3; open.push((await pool.lease({ addr: A(100 + i) }, 'c2'))[1]); }
  ok(open.every((L) => L.lease), '31 pieces open for one client (an office behind one IP)');
  clock += 3; eq((await pool.lease({ addr: A(200) }, 'c2'))[0], 200, 'the 32nd too');
  clock += 3; r0 = await pool.lease({ addr: A(201) }, 'c2');
  ok(r0[0] === 429 && /too many pieces open/.test(r0[1].error), 'the 33rd: too many open at once');
  const lg = db.prepare("SELECT * FROM limit_log WHERE kind = 'open'").all();
  ok(lg.length === 1 && lg[0].client === 'c2' && lg[0].open_client === 32 && lg[0].addr === A(201), 'the refusal is logged: the client, the address, 32 open');
  const counts = open.map((L) => leaseOf(L.lease).open_client);
  ok(counts[0] === 1 && counts[30] === 31, 'each lease keeps how many its client held at that moment (1 … 31)');
  for (const L of open) pool.release({ lease: L.lease });

  console.log('a lease is written with its chunk in one go');
  const before = db.prepare('SELECT counter FROM shuffles').get().counter;
  const orig = db.prepare.bind(db);
  db.prepare = (q) => { if (/^INSERT INTO leases/.test(q)) throw new Error('crash'); return orig(q); };
  let threw = false;
  try { await pool.lease({ addr: FINDER }, 'c3'); } catch (_) { threw = true; }
  db.prepare = orig;
  eq(db.prepare('SELECT counter FROM shuffles').get().counter, before, 'a crash while writing the lease leaves the Shuffle\'s counter where it was (the chunk is not lost)');
  ok(threw, '(the crash was real)');

  console.log('pings keep a lease alive; a late report within the grace counts');
  const L2 = (await pool.lease({ addr: FINDER }, 'c4'))[1];
  clock += 85 * 60; // 5 minutes before its end
  let r = pool.ping({ lease: L2.lease, rate: 1e8 });
  ok(r[1].expires && r[1].expires >= clock + 600, 'a ping near the end gives ten more minutes (' + (r[1].expires - clock) + ' s)');
  clock += 9 * 60; pool.ping({ lease: L2.lease, rate: 1e8 });
  clock += 9 * 60; pool.ping({ lease: L2.lease, rate: 1e8 });
  pool.sweep();
  eq(leaseOf(L2.lease).status, 'open', 'searched past its 90 minutes: still open');
  // the piece is done; its report was lost to the network and goes again two minutes after the last ping
  clock += 120;
  pool.sweep();
  eq(leaseOf(L2.lease).status, 'open', 'two minutes after its last ping: still open');
  r = pool.report({ lease: L2.lease, keys: checks(L2), rate: 1e8 });
  eq(r[0], 200, 'the report sent again is credited');
  // a lease that never heard a ping (the server restarted meanwhile) ran out 5 minutes ago: the grace still takes it
  const L2b = (await pool.lease({ addr: FINDER }, 'c4'))[1];
  clock = leaseOf(L2b.lease).expires + 300;
  pool.sweep();
  eq(leaseOf(L2b.lease).status, 'open', 'ran out 5 min ago, no ping heard: not swept yet (the grace)');
  eq(pool.report({ lease: L2b.lease, keys: checks(L2b), rate: 1e8 })[0], 200, 'its late report is credited');
  const L3 = (await pool.lease({ addr: FINDER }, 'c4'))[1];
  clock = leaseOf(L3.lease).expires + 700;
  pool.sweep();
  eq(leaseOf(L3.lease).status, 'expired', 'past the grace: swept, its chunk goes back');
  ok(!!db.prepare('SELECT 1 FROM retry WHERE chunk = ?').get(leaseOf(L3.lease).chunk), 'the chunk is on the retry list');
  // a lease cannot be kept forever by pings
  const L4 = (await pool.lease({ addr: FINDER }, 'c4'))[1];
  for (let i = 0; i < 80; i++) { clock += 5 * 60; pool.ping({ lease: L4.lease, rate: 1e8 }); }
  ok(leaseOf(L4.lease).expires <= leaseOf(L4.lease).issued + 4 * 90 * 60, 'pings extend a lease to at most four times its length');
  ok(leaseOf(L4.lease).ext > 0 && leaseOf(L2.lease).ext >= 2, 'how often pings stretched a lease is kept');
  pool.release({ lease: L4.lease });

  console.log('a silent browser\'s piece goes back early; a kept one does not');
  const L5 = (await pool.lease({ addr: FINDER }, 'c5'))[1], L6 = (await pool.lease({ addr: FINDER }, 'c5'))[1];
  pool.ping({ lease: L5.lease, rate: 1e8 }); pool.ping({ lease: L6.lease, idle: true });
  clock += 6 * 60; pool.sweep();
  eq(leaseOf(L5.lease).status, 'expired', 'pinged, then silent for 6 minutes: back to the pool');
  eq(leaseOf(L5.lease).silent, 1, '... marked as gone silent (for the limits\' log)');
  eq(leaseOf(L6.lease).status, 'open', 'stopped and kept for later (idle): still yours');
  pool.release({ lease: L6.lease });

  console.log('invites are written down with the first credited piece');
  const NEW = A(300), INV = A(301);
  const L7 = (await pool.lease({ addr: NEW, ref: INV }, 'c6'))[1];
  r = pool.finds && db.prepare('SELECT ref FROM players WHERE addr = ?').get(NEW);
  ok(r && r.ref === null, 'a piece asked for: nobody written as the inviter yet');
  pool.release({ lease: L7.lease });
  eq(db.prepare('SELECT COUNT(*) AS n FROM players WHERE ref = ?').get(INV).n, 0, 'released without a piece: the invite does not count');
  const L8 = (await pool.lease({ addr: NEW, ref: INV }, 'c6'))[1];
  pool.ping({ lease: L8.lease, rate: 1e8 });
  eq(pool.report({ lease: L8.lease, keys: checks(L8), rate: 1e8 })[0], 200, 'the first piece credited');
  eq(db.prepare('SELECT ref FROM players WHERE addr = ?').get(NEW).ref, INV, 'now the inviter is written down');
  const L9 = (await pool.lease({ addr: NEW, ref: A(302) }, 'c6'))[1];
  pool.report({ lease: L9.lease, keys: checks(L9), rate: 1e8 });
  eq(db.prepare('SELECT ref FROM players WHERE addr = ?').get(NEW).ref, INV, 'a later link changes nothing');
  // someone asks for pieces in a stranger's name with their own link: it does not stick
  const STRANGER = A(303), SQUAT = A(304);
  pool.release({ lease: (await pool.lease({ addr: STRANGER, ref: SQUAT }, 'c7'))[1].lease });
  const L10 = (await pool.lease({ addr: STRANGER }, 'c8'))[1];
  pool.report({ lease: L10.lease, keys: checks(L10), rate: 1e8 });
  eq(db.prepare('SELECT ref FROM players WHERE addr = ?').get(STRANGER).ref, null, 'a link used in a stranger\'s name before they searched: not theirs');

  console.log('a find whose claim is stuck: the pool moves on after 24 hours');
  const orig2 = pool.finds.pendingSince;
  let since = clock;
  pool.finds.pendingSince = (n) => (n === 24 ? since : null);
  pool.finds.pending = (n) => n === 24;
  eq(pool.target(), 24, 'a find just now: the target stays (#24), paused');
  r = await pool.lease({ addr: FINDER }, 'c9');
  ok(r[0] === 503 && r[1].found, 'pieces of #24: paused, "the key was found"');
  since = clock - 25 * 3600;
  eq(pool.target(), 25, 'the claim not confirmed after 25 hours: the pool searches #25');
  r = await pool.lease({ addr: FINDER }, 'c9');
  ok(r[0] === 200 && r[1].puzzle === 25, 'pieces of #25 handed out');
  pool.release({ lease: r[1].lease });
  pool.finds.pendingSince = orig2; pool.finds.pending = () => false;

  console.log('the live stream: at most 16 per client');
  const srv = http.createServer((q, s) => pool.handle(q, s, new URL(q.url, 'http://x'), (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }));
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port, reqs = [];
  function stream(ip) {
    return new Promise((res) => {
      const q = http.get({ host: '127.0.0.1', port, path: '/api/pool/live', headers: { 'cf-connecting-ip': ip } }, (s) => { res(s.statusCode); if (s.statusCode !== 200) s.resume(); });
      reqs.push(q);
    });
  }
  const codes = [];
  for (let i = 0; i < 17; i++) codes.push(await stream('10.0.0.1'));
  eq(codes.filter((c) => c === 200).length, 16, '16 streams from one IP open');
  eq(codes[16], 503, 'the 17th is turned away (the page polls instead)');
  eq(await stream('10.0.0.2'), 200, 'another IP still gets one');
  reqs[0].destroy(); await new Promise((res) => setTimeout(res, 100));
  eq(await stream('10.0.0.1'), 200, 'one closed: the first IP gets one again');
  reqs.forEach((q) => q.destroy()); srv.close();

  console.log('made-up speeds, IPv6 networks, form posts, a changed secret');
  {
    const L = (await pool.lease({ addr: A(400) }, 'speedy'))[1];
    pool.ping({ lease: L.lease, rate: 1e13 });
    const sp = pool.stats();
    ok(sp.speed <= 3e10, 'a ping claiming 10^13 keys/s counts for at most 3 cards\' worth (' + sp.speed.toExponential(1) + ')');
    pool.release({ lease: L.lease });
    eq(pool.clientNet('2001:db8:1:2:3:4:5:6'), pool.clientNet('2001:db8:1:2:ffff::1'), 'two IPv6 addresses of one /64: one client');
    ok(pool.clientNet('2001:db8:1:3::1') !== pool.clientNet('2001:db8:1:2::1'), 'another /64: another client');
    eq(pool.clientNet('::ffff:10.0.0.7'), '10.0.0.7', 'an IPv4 address as it is');
    const form = await new Promise((res) => pool.handle({ method: 'POST', headers: { 'content-type': 'text/plain' }, socket: {}, resume() {} }, null, new URL('http://x/api/pool/lease'), (_, code) => res(code)));
    eq(form, 400, 'a POST that is not application/json (a form from another site): refused');
    const was = process.env.POOL_SECRET;
    process.env.POOL_SECRET = '33'.repeat(32);
    let threw = '';
    try { require('../api/pool.js').createPool({ dataDir: dir, secp: S, tx: T, kit: K, node: async () => { throw new Error('no'); }, target: () => 24, address: (n) => PZ.address(n), tip: () => 900000, blockHash: async () => '00' }); } catch (e) { threw = e.message; }
    ok(/secret or POOL_CHUNK_BITS is not the one/.test(threw), 'another secret on the same database: the pool will not start', threw);
    process.env.POOL_SECRET = 'xyz';
    threw = '';
    try { require('../api/pool.js').createPool({ dataDir: dir, secp: S, tx: T, kit: K, node: async () => { throw new Error('no'); }, target: () => 24, address: (n) => PZ.address(n), tip: () => 900000, blockHash: async () => '00' }); } catch (e) { threw = e.message; }
    ok(/must be hex/.test(threw), 'a secret that is not hex: refused (it was cut short silently before)');
    process.env.POOL_SECRET = was;
  }

  console.log('the pages\' queries with 20,000 searchers and 300,000 pieces');
  db.exec('BEGIN');
  const ip = db.prepare('INSERT INTO players (addr, ref, first, last, chunks, keys) VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 20000; i++) ip.run('x' + i, i % 10 ? 'x' + (i % 50) : null, i, i, 5, 1e10 + i);
  const il = db.prepare("INSERT INTO leases (id, puzzle, chunk, addr, client, issued, expires, checks, status, rate, done_at) VALUES (?, 24, '1', ?, ?, ?, ?, '[]', 'done', 1e8, ?)");
  for (let i = 0; i < 300000; i++) il.run('y' + i, 'x' + (i % 20000), 'k' + (i % 20000), clock - 3e6 + i * 10, clock + i, clock - 3e6 + i * 10 + 100);
  db.exec('COMMIT');
  const http2 = (u) => new Promise((res) => pool.handle({ method: 'GET', headers: {}, socket: {} }, null, new URL(u, 'http://x'), (_, code, body) => res([code, body])));
  for (const u of ['/api/pool', '/api/pool/top', '/api/pool/recent', '/api/pool/me?addr=' + FINDER, '/api/pool/history?range=30d']) {
    const t0 = performance.now(); const [code] = await http2(u); const ms = performance.now() - t0;
    // the history walks every piece of the range's span once a minute (cached in between): it may take longer
    ok(code === 200 && ms < (/history/.test(u) ? 2000 : 400), u + ': ' + ms.toFixed(0) + ' ms');
  }

  console.log('the speed history, kept between minutes, is the one worked out anew');
  {
    // pieces finished since, then the clock past the minute: the kept buckets plus the new pieces against a pool
    // with nothing kept (a second one on the same database)
    const hist = (pl, r) => new Promise((res) => pl.handle({ method: 'GET', headers: {}, socket: {} }, null, new URL('/api/pool/history?range=' + r, 'http://x'), (_, code, body) => res(body)));
    for (const r of ['24h', '7d', '30d']) await hist(pool, r);
    for (const step of [61, 3600, 86400 + 7]) {
      clock += step;
      // finished since the last answer, as reports are (a piece's done_at is the moment it is written)
      for (let i = 0; i < 50; i++) { const d = clock - 1 - Math.floor(i * (step - 2) / 50); il.run('h' + clock + '_' + i, 'x' + i, 'k' + i, d - 3000 - i * 37, clock + 600, d); }
      const fresh = require('../api/pool.js').createPool({
        dataDir: dir, secp: S, tx: T, kit: K, node: async () => { throw new Error('no node in these tests'); },
        target: () => targets[0], targets: () => targets, address: (n) => PZ.address(n), tip: () => 900000, blockHash: async (h) => h.toString(16).padStart(64, '0'),
      });
      for (const r of ['24h', '7d', '30d']) {
        const a = await hist(pool, r), b = await hist(fresh, r);
        ok(a.points.length === b.points.length && a.points.every((pt, i) => pt[0] === b.points[i][0] && Math.abs(pt[1] - b.points[i][1]) <= 1e-9 * Math.max(1, b.points[i][1])), r + ', ' + step + ' s later: the same ' + a.points.length + ' points');
      }
      fresh.db.close();
    }
  }

  Date.now = realNow;
  console.log('the report of what the limits did (api/limits.js)');
  const rep = require('child_process').execFileSync(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'api', 'limits.js'), dir, '100000']).toString();
  ok(/Per day/.test(rep) && /What a limit of N would have refused/.test(rep) && /per address 3/.test(rep) && /refused: open/.test(rep), 'it runs on the pool\'s database and answers each question');
  ok(/per IP\s+\d+\s+\d+\s+\d+\s+32/.test(rep), 'it sees the 32 pieces one IP held at once', rep.split('\n').filter((l) => /^per IP /.test(l))[0]);
  fs.rmSync(dir, { recursive: true, force: true });
  done();
})();
