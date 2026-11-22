// Unit tests of the server's side of a find (api/pool.js + api/finds.js), in-process, on puzzle #20 (key 0xd2c55)
// cut into 8 pieces of 2^16 keys, with a made-up 7.1 BTC coin served by the local mock (tests/mock.js) as the node,
// MARA Slipstream. Nothing here reaches the network. Run: node bitcoin/puzzle/tests/finds.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { S, T, K, PZ, KEY, PUZZLE, ADDRESS, FINDER, POOL, COIN, p2wpkh, ok, eq, done } = require('./engine.js');
const { createMock } = require('./mock.js');

(async () => {
  const mock = await createMock().listen();
  mock.coins[ADDRESS] = [COIN];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-finds-'));
  Object.assign(process.env, {
    POOL_CHUNK_BITS: '16', POOL_PAYOUT_ADDRESS: POOL, POOL_SECRET: '11'.repeat(32), POOL_VAULT_KEY: '44'.repeat(32),
    RELAY_SLIPSTREAM_URL: mock.url + '/slip', FOUND_CHECK_SECONDS: '3600',
  });
  async function node(p) {
    const r = await fetch(mock.url + '/node' + p);
    if (!r.ok) throw new Error(p + ': ' + r.status);
    return (r.headers.get('content-type') || '').includes('json') ? r.json() : r.text();
  }
  const pool = require('../api/pool.js').createPool({
    dataDir: dir, secp: S, tx: T, kit: K, node, target: () => PUZZLE, address: (n) => PZ.address(n), tip: () => 900000, blockHash: async (h) => h.toString(16).padStart(64, '0'),
  });
  const db = pool.db, F = pool.finds;
  const leaseOf = (id) => db.prepare('SELECT * FROM leases WHERE id = ?').get(id);

  console.log('leases: a payout address is required');
  eq((await pool.lease({}, 'c0'))[0], 400, 'no address: 400');
  ok(/payout address is required/.test((await pool.lease({}, 'c0'))[1].error), 'no address: says an address is required');
  eq((await pool.lease({ addr: ADDRESS }, 'c0'))[0], 400, 'a puzzle address as the payout: 400');

  // lease the 8 pieces of #20 (2^16 keys each), two clients so the open-piece limit does not bite
  const leases = [];
  for (let i = 0; i < 8; i++) { const r = await pool.lease({ addr: FINDER }, 'c' + (i % 2)); eq(r[0], 200, 'lease ' + (i + 1) + ' of 8'); leases.push(r[1]); }
  const piece = (L) => [BigInt(L.from), BigInt(L.to)];
  const mine = leases.find((L) => KEY >= piece(L)[0] && KEY <= piece(L)[1]);
  const other = leases.find((L) => L !== mine);
  ok(!!mine && !!other, 'the key is in exactly one of them');

  // an honest find, as the browser makes it
  function honest(L, o) {
    o = o || {};
    const salt = o.salt || crypto.randomBytes(32).toString('hex');
    const payout = o.payout || FINDER;
    const commitment = K.commitment(o.key || KEY, payout, salt);
    const stamp = Uint8Array.from([0xf0, 4, 9, 9, 9, 9, 0x08, 0x00, 0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e, 21, 20].concat(Array.from(new TextEncoder().encode('https://cal.example/'))));
    const ots = K.b64(K.otsFile(commitment, [stamp]));
    const b = K.build({ key: KEY, utxos: [COIN], payout: FINDER, poolPayout: POOL, rate: 20 });
    return {
      body: { lease: L.lease, key: '0x' + (o.key || KEY).toString(16), salt, payout, commitment, ots,
        txs: [{ relay: 'slipstream', hex: b.slip.hex }],
        receipts: { slipstream: { ok: o.slipFailed ? false : true, said: o.slipFailed ? 'cannot be reached' : 'Transaction submitted', t: 1 } } },
      b,
    };
  }

  console.log('POST /api/pool/found: refused');
  let r = await F.found(Object.assign(honest(mine).body, { key: '0xd2c56' }));
  eq(r[0], 422, 'a wrong key: 422'); ok(/does not open/.test(r[1].error), 'a wrong key: says so', r[1]);
  eq(leaseOf(mine.lease).status, 'open', 'a wrong key: the piece stays open');
  r = await F.found(honest(other).body);
  eq(r[0], 422, 'the real key in another lease: 422'); ok(/not in this lease/.test(r[1].error), 'the real key outside the lease: says so', r[1]);
  eq(leaseOf(other.lease).status, 'open', 'the real key outside the lease: that piece stays open');
  r = await F.found(Object.assign(honest(mine).body, { commitment: 'ab'.repeat(32) }));
  eq(r[0], 422, 'a wrong commitment: 422'); ok(/commitment does not match/.test(r[1].error), 'a wrong commitment: says so', r[1]);
  eq(leaseOf(mine.lease).status, 'found', 'the genuine key in its piece closes the piece at once, even with the rest wrong');
  eq(db.prepare('SELECT COUNT(*) AS n FROM finds').get().n, 0, '... but no find is recorded');
  r = await F.found(honest(mine, { payout: p2wpkh(3) }).body);
  eq(r[0], 422, 'a payout address other than the lease\'s: 422'); ok(/not the one this piece was searched for/.test(r[1].error), 'another payout: says so', r[1]);
  eq(db.prepare('SELECT COUNT(*) AS n FROM finds').get().n, 0, 'nothing recorded by any refused request');
  ok(!mock.log.some((x) => x.method === 'POST'), 'no refused request sent anything to a relay');

  console.log('POST /api/pool/found: an honest find');
  const H = honest(mine);
  r = await F.found(H.body);
  eq(r[0], 200, 'accepted'); eq(r[1].find.status, 'pending', 'pending until the spend');
  const rc = r[1].find.receipt;
  ok(rc && K.receiptVerify(rc), 'the pool\'s receipt comes back, its signature holds');
  ok(rc && rc.body.commitment === H.body.commitment && rc.body.payout === FINDER && rc.body.finder_sats === 600000000 && rc.body.txids.length === 1 && rc.body.puzzle === PUZZLE, '... about this find: the commitment, the address, 6 BTC, the transaction');
  ok(rc && rc.pub === K.pubHex(BigInt('0x' + fs.readFileSync(path.join(dir, 'receipt-key'), 'utf8').trim())), '... signed with the key the server keeps (a file in DATA_DIR without POOL_RECEIPT_KEY)');
  const row = db.prepare('SELECT * FROM finds').get();
  ok(row && row.key === null && row.salt === null, 'recorded without the key and without the salt');
  ok(!JSON.stringify(row).includes(KEY.toString(16).padStart(64, '0')) && !JSON.stringify(row).includes('d2c55'), 'the key is nowhere in the row');
  ok(!JSON.stringify(row).includes(H.b.slip.hex), 'the signed transactions (with the public key) are not in the row');
  eq(JSON.parse(row.txids).join(), H.b.slip.txid, 'the txid is');
  eq(db.prepare('SELECT COUNT(*) AS n FROM vault').get().n, 0, 'Slipstream took it from the browser: nothing in the vault');
  eq(row.payout, FINDER, 'the payout address is'); eq(row.commitment, H.body.commitment, 'the commitment is');
  await new Promise((ok2) => setTimeout(ok2, 300));
  const sent = mock.log.filter((x) => x.method === 'POST');
  ok(sent.some((x) => x.path === '/slip/api/transactions' && x.body.includes(H.b.slip.hex)), 'the server sent it through Slipstream at once');
  ok(!sent.some((x) => x.path.startsWith('/node/')), 'the server never gave a transaction to the node');
  eq((await pool.lease({ addr: FINDER }, 'c9'))[0], 503, 'while the prize is unspent, no more pieces of #20 are given out');

  console.log('replays, and the same find again');
  r = await F.found(honest(mine).body); // a fresh salt: another commitment for the same piece
  eq(r[0], 409, 'the same piece with another commitment: 409 (a replay)');
  r = await F.found(H.body);
  eq(r[0], 200, 'the very same find again: 200'); ok(r[1].already === true, '... marked already');
  eq(db.prepare('SELECT COUNT(*) AS n FROM finds').get().n, 1, '... and still one find');
  F._held.clear(); // a restart: the key was only in memory
  r = await F.found(H.body);
  ok(r[0] === 200 && r[1].rearmed === true, 'after a restart the same find arms the server again');
  // a browser that gave up waiting sends it again while the first request still runs
  F._held.clear();
  const both = await Promise.all([F.found(H.body), F.found(H.body)]);
  ok(both.every((x) => x[0] === 200), 'the same find twice at once: both answered 200, no error', both.map((x) => x[0]));
  eq(db.prepare('SELECT COUNT(*) AS n FROM finds').get().n, 1, '... one find recorded');

  console.log('the piece is never handed out again');
  // every other lease expires and goes back; then all of #20 is leased out again
  db.prepare("UPDATE leases SET expires = 0 WHERE status = 'open'").run();
  pool.sweep();
  ok(!db.prepare('SELECT 1 FROM retry WHERE chunk = ?').get(leaseOf(mine.lease).chunk), 'its piece is not on the retry list');
  db.prepare("UPDATE finds SET status = 'paused' WHERE 1").run(); // let leasing go on for this check only
  const again = [];
  for (let i = 0; i < 10; i++) { const x = await pool.lease({ addr: FINDER }, 'd' + i); if (x[0] === 200) again.push(x[1]); }
  db.prepare("UPDATE finds SET status = 'pending' WHERE 1").run();
  eq(again.length, 7, 'the 7 other pieces come back, one by one');
  ok(!again.some((L) => KEY >= BigInt(L.from) && KEY <= BigInt(L.to)), 'the piece with the key is never among them');
  r = pool.report({ lease: mine.lease, keys: [] });
  eq(r[0], 409, 'its lease cannot be reported or reused');

  console.log('public before the spend');
  let pub = F.list().finds[0];
  ok(pub && pub.commitment === H.body.commitment && pub.ots, 'the commitment and its .ots are public at once');
  ok(!('key' in pub) && !('salt' in pub) && !('piece' in pub) && !('txids' in pub), 'no key, salt, piece or txids before the spend');
  const st = F.status(mine.lease);
  ok(st.recorded && st.held && !JSON.stringify(st).includes('d2c55'), 'the finder\'s status: recorded, held, no key');

  console.log('the fee bump: only after a block of MARA\'s without the claim');
  mock.log.length = 0;
  const h = F._held.get(H.body.commitment);
  // new transactions posted (the same one sent again does not count)
  const slipPosts = () => mock.log.filter((x) => x.method === 'POST' && x.path === '/slip/api/transactions').map((x) => JSON.parse(x.body).tx_hex).filter((x) => x !== H.b.slip.hex);
  await F.tick(); // the first look: where the chain stands
  mock.tip += 3; await F.tick();
  eq(slipPosts().length, 0, 'three blocks by other miners: not signed again (only MARA can mine a Slipstream transaction)');
  mock.tip += 1; mock.mara.add(mock.tip); await F.tick();
  const bumped = slipPosts()[0];
  ok(!!bumped, 'MARA mined a block without it: signed again and sent to Slipstream');
  const coins = { [COIN.txid + ':0']: COIN.value };
  const c0 = K.checkTx(H.b.slip.hex, { key: KEY, coins, payout: FINDER, poolPayout: POOL }), c1 = K.checkTx(bumped, { key: KEY, coins, payout: FINDER, poolPayout: POOL });
  eq(c1.finder, c0.finder, 'the finder\'s output is exactly as before (6 BTC)');
  eq(S.toHex(c1.tx.outs.find((o) => o.value === c1.finder).script), S.toHex(T.addressScript(FINDER).script), '... to the same address');
  ok(c1.fee > c0.fee && c1.pool === c0.pool - (c1.fee - c0.fee), 'the pool\'s output pays the extra fee', { before: c0.fee, after: c1.fee });
  eq(Math.round(c1.fee / c1.size), Math.ceil(h.rate), 'at half again the rate');
  eq(c1.tx.ins.map((x) => x.txid + ':' + x.vout).join(), COIN.txid + ':0', 'spending the same coin (it replaces the first)');
  ok(JSON.parse(db.prepare('SELECT txids FROM finds').get().txids).includes(T.parse(bumped).txid), 'the new txid is recorded');
  // the cap: once at 2000 sat/vB, no further bump
  h.rate = K.MAX_RATE; mock.log.length = 0;
  mock.tip += 1; mock.mara.add(mock.tip); await F.tick();
  const capped = mock.log.filter((x) => x.method === 'POST' && x.path === '/slip/api/transactions').map((x) => JSON.parse(x.body).tx_hex)[0];
  eq(capped, bumped, 'at the cap: the same transaction again, no higher fee');

  console.log('the spend');
  mock.mine(T.parse(bumped).txid, null, 1);
  await F.tick();
  eq(db.prepare('SELECT status FROM finds').get().status, 'pending', 'mined, one block deep: not published yet (a reorganisation could undo it)');
  ok(db.prepare('SELECT key FROM finds').get().key === null && F._held.size === 1, '... the key still only in memory');
  mock.tip += 4; await F.tick();
  eq(db.prepare('SELECT status FROM finds').get().status, 'pending', 'five deep: still not');
  mock.tip += 1; await F.tick();
  const done1 = db.prepare('SELECT * FROM finds').get();
  eq(done1.status, 'claimed', 'claimed by our own transaction');
  eq(done1.key, '0x' + KEY.toString(16), 'the key is written down now (nothing left to steal)');
  eq(done1.salt, H.body.salt, 'and the salt');
  eq(done1.claim_hex, bumped, 'and the claim transaction');
  eq(F._held.size, 0, 'the key is out of memory');
  pub = F.list().finds[0];
  ok(pub.key && pub.salt && pub.piece.from === mine.from && pub.claim_hex === bumped, 'all of it public now: key, salt, piece, transaction');
  eq(K.commitment(BigInt(pub.key), pub.payout, pub.salt), pub.commitment, 'and it checks: sha256(key ‖ payout ‖ salt) = the commitment');
  eq(F.pending(PUZZLE), false, 'nothing pending');
  r = await F.found(H.body);
  ok(r[0] === 200 && r[1].already, 'the finder\'s browser sending it once more changes nothing');

  console.log('HTTP: GET /api/pool/finds/<commitment>.ots and a too large body');
  const http = require('http');
  const srv = http.createServer((q, s) => pool.handle(q, s, new URL(q.url, 'http://x'), (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }));
  await new Promise((a) => srv.listen(0, '127.0.0.1', a));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const ots = new Uint8Array(await (await fetch(base + '/api/pool/finds/' + H.body.commitment + '.ots')).arrayBuffer());
  eq(K.otsRead(ots).digest, H.body.commitment, 'the .ots file downloads and stamps the commitment');
  const big = await fetch(base + '/api/pool/found', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 'a'.repeat(1600000) }) }).then((x) => x.status).catch(() => 'closed');
  ok(big === 400 || big === 'closed', 'a body over 1.5 MB (a 1 MB find, sealed) is refused', big);
  const sq = await require('../web/engine/seal.js').seal('/api/pool/found/status', { lease: mine.lease }, pool.transportPub);
  const viaPost = await sq.open(await (await fetch(base + '/api/pool/found/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sq.body) })).json());
  ok(viaPost.recorded && viaPost.commitment === H.body.commitment, 'the finder\'s status: POST /api/pool/found/status with the lease in the body');
  eq((await fetch(base + '/api/pool/found?lease=' + mine.lease)).status, 404, 'never with the lease in the address');
  srv.close();

  // ---------- transactions that break the rules, the key genuine: set aside; with none usable the pool signs ----------
  console.log('POST /api/pool/found: bad transactions set aside, the pool signs the fair split itself');
  mock.coins[ADDRESS] = [COIN]; mock.spent = {}; // unspent again (the honest find above was mined)
  async function fresh(told) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-finds-'));
    const p = require('../api/pool.js').createPool({
      dataDir: d, secp: S, tx: T, kit: K, node, target: () => PUZZLE, address: (n) => PZ.address(n), tip: () => 900000, blockHash: async (h) => h.toString(16).padStart(64, '0'),
      notify: (m) => { if (told) told.push(m); },
    });
    const ls = [];
    for (let i = 0; i < 8; i++) ls.push((await p.lease({ addr: FINDER }, 'c' + (i % 2)))[1]);
    return { p, d, L: ls.find((x) => KEY >= BigInt(x.from) && KEY <= BigInt(x.to)) };
  }
  const coinsMap = { [COIN.txid + ':' + COIN.vout]: COIN.value };
  const BAD = [
    ['paying the finder 5 of 7.1 BTC', () => T.sweep(KEY, [COIN], [{ address: FINDER, value: 500000000 }, { address: POOL, value: 209990000 }]).hex, /less than the share/],
    ['paying someone else', () => T.sweep(KEY, [COIN], [{ address: FINDER, value: 600000000 }, { address: p2wpkh(5), value: 109990000 }]).hex, /neither the finder nor the pool/],
    ['spending a coin that is not the puzzle\'s', () => T.sweep(KEY, [{ txid: '22'.repeat(32), vout: 1, value: 710000000 }], [{ address: FINDER, value: 600000000 }, { address: POOL, value: 109990000 }]).hex, /./],
    ['paying the finder everything and the pool nothing', () => T.sweep(KEY, [COIN], [{ address: FINDER, value: 709990000 }]).hex, /less than its part/],
    ['paying the pool a little less than its part', () => T.sweep(KEY, [COIN], [{ address: FINDER, value: 600010000 }, { address: POOL, value: 109980000 }]).hex, /less than its part/],
    ['with a lock time', (h) => h.b.slip.hex.slice(0, -8) + 'a0860100', /lock time/],
    ['of version 1', (h) => '01' + h.b.slip.hex.slice(2), /version 1/],
    ['with a broken signature', (h) => { const t = T.parse(h.b.slip.hex); return h.b.slip.hex.replace(S.toHex(t.ins[0].script).slice(10, 30), 'ff'.repeat(10)); }, /./],
  ];
  for (const [name, make, why] of BAD) {
    const f = await fresh(), h = honest(f.L);
    h.body.txs = [{ relay: 'slipstream', hex: make(h) }];
    const before = mock.log.length;
    const r2 = await f.p.finds.found(h.body);
    eq(r2[0], 200, 'a transaction ' + name + ': the find is accepted');
    ok(r2[1].pool_built && r2[1].ignored.some((x) => x.bad && why.test(x.why)), '... the bad one set aside, saying why, and the pool built its own', r2[1].ignored);
    eq(f.p.db.prepare('SELECT status FROM leases WHERE id = ?').get(f.L.lease).status, 'found', '... the piece closed');
    const own = r2[1].find.pool_txs || [];
    const c = own.length && K.checkTx(own[0].hex, { key: KEY, coins: coinsMap, payout: FINDER, poolPayout: POOL });
    ok(c && c.finder === 600000000, '... the pool\'s split pays the finder 6 BTC', c && c.finder);
    const rc = r2[1].find.receipt;
    ok(rc && K.receiptVerify(rc) && rc.body.txids.join() === own.map((t) => t.txid).join() && rc.body.finder_sats === 600000000, '... and its receipt names the pool\'s transactions and 6 BTC');
    await new Promise((a) => setTimeout(a, 200));
    const posted = mock.log.slice(before).filter((x) => x.method === 'POST').map((x) => x.body).join('');
    ok(own.every((t) => posted.includes(t.hex)) && !posted.includes(h.body.txs[0].hex), '... it sent its own through the relays, never the bad one');
    fs.rmSync(f.d, { recursive: true, force: true });
  }
  {
    const f = await fresh(), h = honest(f.L);
    h.body.txs[0].hex = BAD[0][1](h);
    const r2 = await f.p.finds.found(h.body);
    ok(r2[0] === 200 && r2[1].pool_built && r2[1].find.txids.length === 1 && r2[1].find.txids[0] !== h.b.slip.txid, 'the one transaction bad: set aside, the pool built its own', r2[1]);
    fs.rmSync(f.d, { recursive: true, force: true });
  }

  console.log('the vault: Slipstream not reached from the finder\'s browser');
  {
    mock.coins[ADDRESS] = [COIN]; mock.spent = {};
    const told = [], f = await fresh(told), h = honest(f.L, { slipFailed: true });
    const r2 = await f.p.finds.found(h.body);
    eq(r2[0], 200, 'the find is taken');
    const v = f.p.db.prepare('SELECT * FROM vault').get(), sec = f.p.finds._vault.get(v.address);
    ok(v && sec && sec.key === '0x' + KEY.toString(16) && v.source === 'pool' && v.payout === FINDER && v.lease === f.L.lease && v.commitment === h.body.commitment, 'the key is written down in the vault, with the finder\'s address, the lease and the commitment');
    // sealed: its own file, the API's user only, nothing readable in it or in the database
    const file = path.join(f.d, 'vault', v.address + '.key'), text = fs.readFileSync(file, 'utf8');
    eq(fs.statSync(file).mode & 0o777, 0o600, 'the key\'s file: read and write by the API\'s own user only (0600)');
    eq(fs.statSync(path.join(f.d, 'vault')).mode & 0o777, 0o700, '... in a directory only it can open (0700)');
    ok(!v.key && !v.held && !v.claim_hex, 'the database says the key is in the vault, and holds neither it nor the signed claim');
    const raw = fs.readFileSync(path.join(f.d, 'pool.db')).toString('latin1') + (fs.existsSync(path.join(f.d, 'pool.db-wal')) ? fs.readFileSync(path.join(f.d, 'pool.db-wal')).toString('latin1') : '');
    ok(!raw.includes('d2c55') && !raw.includes(h.b.slip.hex.slice(0, 200)), '... not even in the database\'s files (the write-ahead log too)');
    ok(!text.includes('d2c55') && !text.includes(h.b.slip.hex.slice(0, 40)) && sec.held && sec.held.txs[0].hex === h.b.slip.hex, 'the file has the key and the signed claim, sealed: neither readable in it');
    const { createVault } = require('../api/vault.js');
    let err = null; try { createVault(path.join(f.d, 'vault'), Buffer.alloc(32, 0x55)).get(v.address); } catch (e) { err = e; }
    ok(err && /does not open/.test(err.message), 'another vault key: the file does not open', err && err.message);
    fs.copyFileSync(file, path.join(f.d, 'vault', ADDRESS.replace(/.$/, 'x') + '.key'));
    err = null; try { f.p.finds._vault.get(ADDRESS.replace(/.$/, 'x')); } catch (e) { err = e; }
    ok(err && /does not open/.test(err.message), 'the file renamed to another address: it does not open (the address is sealed into it)');
    ok(r2[1].find.vault === true, 'the finder\'s status says so (the page asks to write to support)');
    await new Promise((a) => setTimeout(a, 200));
    ok(mock.log.some((x) => x.method === 'POST' && x.path === '/slip/api/transactions' && x.body.includes(h.b.slip.hex)), 'the server sends the finder\'s claim through Slipstream itself');
    ok(told.length === 1 && /vault/.test(told[0]) && /Puzzle #20/.test(told[0]) && !told.join().includes('d2c55'), 'the owner is told (Telegram), without the key', told);
    fs.rmSync(f.d, { recursive: true, force: true });
  }
  {
    mock.spent = {};
    const f = await fresh(), h = honest(f.L, { slipFailed: true });
    h.body.txs = []; // the coins could not be read in the browser: nothing built there
    const r2 = await f.p.finds.found(h.body);
    const own = r2[1].find && r2[1].find.pool_txs;
    ok(r2[0] === 200 && r2[1].pool_built && own && K.checkTx(own[0].hex, { key: KEY, coins: { [COIN.txid + ':0']: COIN.value }, payout: FINDER, poolPayout: POOL }).finder === 600000000, 'no transaction from the browser: the pool builds the fair split (6 BTC to the finder) and sends it');
    ok(!!f.p.db.prepare("SELECT 1 FROM vault WHERE source = 'pool'").get(), '... and the key is in the vault');
    fs.rmSync(f.d, { recursive: true, force: true });
  }

  console.log('the vault: a key found on /play, and the lucky key');
  {
    await new Promise((a) => setTimeout(a, 300)); // the last test's server sends its claim a moment later
    mock.coins[ADDRESS] = [COIN]; mock.spent = {}; mock.log.length = 0;
    const told = [], f = await fresh(told), V = f.p.finds;
    const salt = '7e'.repeat(32), commitment = K.commitment(KEY, FINDER, salt);
    let r2 = await V.solo({ key: '0x' + KEY.toString(16), puzzle: PUZZLE, source: 'play', payout: FINDER, salt, commitment });
    ok(r2[0] === 200 && r2[1].first && K.receiptVerify(r2[1].receipt) && r2[1].receipt.body.commitment === commitment && r2[1].receipt.body.lease === 'play', '/play: kept, with the pool\'s signed receipt for the commitment');
    const v = f.p.db.prepare('SELECT * FROM vault').get();
    ok(v.source === 'play' && v.payout === FINDER && V._vault.get(v.address).key === '0x' + KEY.toString(16) && !v.key, '... in the vault with the player\'s address (the key sealed in its file)');
    r2 = await V.solo({ key: '0x' + KEY.toString(16), puzzle: PUZZLE, source: 'lucky' });
    ok(r2[0] === 200 && f.p.db.prepare('SELECT source FROM vault').get().source === 'play', 'the same key again (from the lucky key): the first record stays');
    eq((await V.solo({ key: '0xd2c56', puzzle: PUZZLE, source: 'play' }))[0], 422, 'a key that does not open the address: 422');
    eq((await V.solo({ key: '0x' + 'f'.repeat(64), puzzle: PUZZLE, source: 'play' }))[0], 422, 'a key outside the puzzle\'s range: 422, before any point multiplication');
    eq((await V.solo({ key: '0x' + KEY.toString(16), puzzle: PUZZLE, source: 'play', payout: FINDER, salt, commitment: 'ab'.repeat(32) }))[0], 422, 'a commitment that does not match: 422');
    ok(told.length === 1 && !told.join().includes('d2c55'), 'the owner is told once, without the key');
    eq(mock.log.filter((x) => x.method === 'POST').length, 0, 'a /play key is not sent anywhere by itself (support sees it through)');
    fs.rmSync(f.d, { recursive: true, force: true });
  }
  {
    // a puzzle address holding only dust: the prize is gone
    mock.coins[ADDRESS] = [{ txid: 'aa'.repeat(32), vout: 0, value: 700 }]; mock.spent = {};
    const f = await fresh();
    eq((await f.p.finds.solo({ key: '0x' + KEY.toString(16), puzzle: PUZZLE, source: 'lucky' }))[0], 409, 'only dust left on the address: the prize is spent, nothing kept');
    fs.rmSync(f.d, { recursive: true, force: true });
  }
  {
    mock.coins[ADDRESS] = [COIN, { txid: 'aa'.repeat(32), vout: 0, value: 700 }]; mock.spent = {}; mock.log.length = 0;
    const told = [], f = await fresh(told), V = f.p.finds;
    await V.solo({ key: '0x' + KEY.toString(16), puzzle: PUZZLE, source: 'lucky' });
    await V.tick();
    eq(mock.log.filter((x) => x.method === 'POST').length, 0, 'the lucky key, just found: the prize is the visitor\'s to take, nothing sent');
    f.p.db.prepare('UPDATE vault SET created = created - 25 * 3600').run();
    await V.tick();
    const sweep = mock.log.filter((x) => x.method === 'POST' && x.path === '/slip/api/transactions').map((x) => JSON.parse(x.body).tx_hex)[0];
    const tx = sweep && T.parse(sweep);
    ok(tx && tx.ins.length === 1 && tx.outs.length === 1 && S.toHex(tx.outs[0].script) === S.toHex(T.addressScript(POOL).script) && tx.outs[0].value > COIN.value - 100000, 'unclaimed after 24 hours: the prize\'s coin swept to the pool\'s address through Slipstream (the dust left)');
    eq(f.p.db.prepare('SELECT status FROM vault').get().status, 'sent', '... the vault row says sent');
    await V.tick(); mock.tip += 2; await V.tick();
    eq(mock.log.filter((x) => x.method === 'POST' && x.path === '/slip/api/transactions').length, 1, 'blocks by other miners: the sweep is not signed again');
    mock.tip += 1; mock.mara.add(mock.tip); await V.tick();
    const again = mock.log.filter((x) => x.method === 'POST' && x.path === '/slip/api/transactions').map((x) => JSON.parse(x.body).tx_hex)[1];
    const fee = (h) => { const t = T.parse(h); return COIN.value - t.outs[0].value; };
    ok(again && T.parse(again).txid !== tx.txid && fee(again) > fee(sweep), 'MARA mined a block without it: signed again at a higher fee, the same coin, still all to the pool');
    const tx2 = T.parse(again);
    ok(told.some((m) => /swept to the pool/.test(m)), '... and the owner is told');
    mock.mine(tx2.txid); await V.tick();
    eq(f.p.db.prepare('SELECT status FROM vault').get().status, 'spent', 'mined: spent (the dust still on the address does not count)');
    fs.rmSync(f.d, { recursive: true, force: true });
  }
  mock.coins[ADDRESS] = [COIN]; mock.spent = {};

  console.log('a bad .ots, a claim leaving a coin of the prize');
  {
    mock.coins[ADDRESS] = [COIN]; mock.spent = {};
    const f = await fresh(), h = honest(f.L);
    h.body.ots = K.b64(K.otsFile('cd'.repeat(32), [Uint8Array.from([0x00, 0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e, 2, 1, 0x41])]));
    const r2 = await f.p.finds.found(h.body);
    ok(r2[0] === 200 && r2[1].find.recorded, 'a .ots for another digest (one calendar\'s odd answer): the find is taken all the same');
    ok(!f.p.finds.list().finds[0].ots, '... without the .ots');
    fs.rmSync(f.d, { recursive: true, force: true });
  }
  {
    const SECOND = { txid: 'b2'.repeat(32), vout: 1, value: 7100000 };
    mock.coins[ADDRESS] = [COIN, SECOND]; mock.spent = {};
    const f = await fresh(), h = honest(f.L); // the browser's claim spends COIN only
    const r2 = await f.p.finds.found(h.body);
    const own = r2[1].find.pool_txs || [];
    ok(r2[0] === 200 && r2[1].pool_built && r2[1].ignored.some((x) => /leaves 1 coin/.test(x.why)), 'a claim that leaves a coin of the prize: set aside, the pool builds its own', r2[1].ignored);
    ok(own.length === 1 && T.parse(own[0].hex).ins.length === 2, '... spending both coins');
    fs.rmSync(f.d, { recursive: true, force: true });
    mock.coins[ADDRESS] = [COIN];
  }

  console.log('the vault after a restart: the claim seen through with the same transaction');
  {
    mock.coins[ADDRESS] = [COIN]; mock.spent = {}; mock.mara.clear();
    await new Promise((a) => setTimeout(a, 300)); mock.log.length = 0;
    const f = await fresh(), h = honest(f.L, { slipFailed: true });
    await f.p.finds.found(h.body);
    const first = JSON.parse(f.p.db.prepare('SELECT txids FROM finds').get().txids);
    await new Promise((a) => setTimeout(a, 300));
    f.p.finds._held.clear(); mock.log.length = 0; // a restart: nothing in memory
    await f.p.finds.tick();
    const posted = mock.log.filter((x) => x.method === 'POST' && x.path === '/slip/api/transactions').map((x) => T.parse(JSON.parse(x.body).tx_hex).txid);
    ok(posted.length === 1 && posted[0] === first[0], 'after the restart the server sends the same claim again by itself (the same txid)', { posted, first });
    ok(f.p.finds._held.size === 1, '... and holds it again (fee bumps, the watch)');
    mock.tip += 1; mock.mara.add(mock.tip); await f.p.finds.tick(); mock.tip += 1; mock.mara.add(mock.tip); await f.p.finds.tick();
    const txids = JSON.parse(f.p.db.prepare('SELECT txids FROM finds').get().txids);
    ok(txids.length >= 2 && txids[0] === first[0], 'a fee bump after the restart: its txid joins the find\'s list', txids);
    mock.mine(txids[txids.length - 1]); await f.p.finds.tick();
    eq(f.p.db.prepare('SELECT status FROM finds').get().status, 'claimed', 'mined 6 deep: claimed by our own claim, not "taken"');
    fs.rmSync(f.d, { recursive: true, force: true });
  }

  console.log('a coin of the prize that comes after the claim');
  {
    mock.coins[ADDRESS] = [COIN]; mock.spent = {};
    await new Promise((a) => setTimeout(a, 300)); mock.log.length = 0;
    const f = await fresh(), h = honest(f.L);
    await f.p.finds.found(h.body);
    const LATE = { txid: 'c3'.repeat(32), vout: 0, value: 150000000 };
    mock.coins[ADDRESS] = [COIN, LATE];
    await new Promise((a) => setTimeout(a, 300)); mock.log.length = 0;
    await f.p.finds.tick();
    const late = mock.log.filter((x) => x.method === 'POST' && x.path === '/slip/api/transactions').map((x) => JSON.parse(x.body).tx_hex).find((x) => T.parse(x).ins[0].txid === LATE.txid);
    const lt = late && T.parse(late);
    ok(!!lt, 'a later coin of 1.5 BTC is swept at once, before the claim is even mined');
    const toFinder = lt && lt.outs.find((x) => S.toHex(x.script) === S.toHex(T.addressScript(FINDER).script));
    eq(toFinder && toFinder.value, 100000000, '... 7.1 + 1.5 = 8.6 BTC in all: the finder gets 7, 1 more than the first claim paid');
    mock.mine(T.parse(h.b.slip.hex).txid);
    await f.p.finds.tick();
    eq(f.p.db.prepare('SELECT key FROM finds').get().key, null, 'the first claim 6 deep, the later coin not yet spent: the key is not published');
    mock.mine(lt.txid); await f.p.finds.tick();
    ok(!!f.p.db.prepare('SELECT key FROM finds').get().key, 'both spent and deep: published');
    fs.rmSync(f.d, { recursive: true, force: true });
    mock.coins[ADDRESS] = [COIN]; mock.spent = {};
  }

  console.log('the vault: keys an older version wrote into the database');
  {
    mock.coins[ADDRESS] = [COIN]; mock.spent = {};
    const f = await fresh(), h = honest(f.L, { slipFailed: true });
    await f.p.finds.found(h.body);
    await new Promise((a) => setTimeout(a, 300));
    // as the old version left it: the key and the signed claim in the table, no file
    const v = f.p.db.prepare('SELECT * FROM vault').get(), sec = f.p.finds._vault.get(v.address);
    f.p.db.prepare('UPDATE vault SET key = ?, held = ? WHERE address = ?').run(sec.key, JSON.stringify(sec.held), v.address);
    fs.rmSync(path.join(f.d, 'vault', v.address + '.key'));
    f.p.db.close();
    const p2 = require('../api/pool.js').createPool({ dataDir: f.d, secp: S, tx: T, kit: K, node, target: () => PUZZLE, address: (n) => PZ.address(n), tip: () => 900000, blockHash: async (x) => x.toString(16).padStart(64, '0') });
    const v2 = p2.db.prepare('SELECT * FROM vault').get(), s2 = p2.finds._vault.get(v2.address);
    ok(s2 && s2.key === '0x' + KEY.toString(16) && s2.held && s2.held.txs[0].hex === h.b.slip.hex, 'on start: moved into the sealed file');
    ok(!v2.key && !v2.held, '... and wiped from the table');
    const raw = fs.readFileSync(path.join(f.d, 'pool.db')).toString('latin1') + (fs.existsSync(path.join(f.d, 'pool.db-wal')) ? fs.readFileSync(path.join(f.d, 'pool.db-wal')).toString('latin1') : '');
    ok(!raw.includes('d2c55') && !raw.includes(h.b.slip.hex.slice(0, 200)), '... and from the database\'s files');
    p2.finds._held.clear(); mock.log.length = 0;
    await p2.finds.tick();
    ok(mock.log.some((x) => x.method === 'POST' && x.path === '/slip/api/transactions' && x.body.includes(h.b.slip.hex)), 'the find armed again from the file: the same claim sent');
    p2.db.close();
    fs.rmSync(f.d, { recursive: true, force: true });
  }

  console.log('sealed requests (web/engine/seal.js): over HTTP, as a page sends them');
  {
    mock.coins[ADDRESS] = [COIN]; mock.spent = {};
    const f = await fresh(), h = honest(f.L), SEAL = require('../web/engine/seal.js'), http = require('http');
    const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const srv = http.createServer((q, r) => f.p.handle(q, r, new URL('http://x' + q.url), send).then((done) => { if (!done) send(r, 404, {}); }));
    await new Promise((a) => srv.listen(0, '127.0.0.1', a));
    const base = 'http://127.0.0.1:' + srv.address().port, pub = f.p.transportPub;
    const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return [r.status, await r.json()]; };
    let r = await post('/api/pool/found', h.body);
    ok(r[0] === 400 && /sealed body is required/.test(r[1].error), 'a find in the clear: refused, nothing read from it');
    eq(f.p.db.prepare('SELECT COUNT(*) AS n FROM finds').get().n, 0, '... and nothing recorded');
    let s1 = await SEAL.seal('/api/pool/found/status', h.body, pub);
    r = await post('/api/pool/found', s1.body);
    eq(r[0], 400, 'sealed for another endpoint (the path is bound in): refused');
    s1 = await SEAL.seal('/api/pool/found', h.body, pub);
    const bad = Object.assign({}, s1.body, { data: s1.body.data.slice(0, -8) + (s1.body.data.slice(-8, -4) === 'AAAA' ? 'BBBB' : 'AAAA') + s1.body.data.slice(-4) });
    eq((await post('/api/pool/found', bad))[0], 400, 'a sealed body changed on the way: refused');
    const other = require('crypto').createECDH('prime256v1'); other.generateKeys();
    eq((await post('/api/pool/found', (await SEAL.seal('/api/pool/found', h.body, other.getPublicKey('hex'))).body))[0], 400, 'sealed for another key: refused');
    r = await post('/api/pool/found', s1.body);
    ok(r[0] === 200 && r[1].seal === 1 && !r[1].ok && !JSON.stringify(r[1]).includes(h.b.slip.txid), 'sealed: taken, and the answer comes back sealed (nothing of it readable)');
    const a = await s1.open(r[1]);
    ok(a.ok && a.find && a.find.recorded && a.find.commitment === h.body.commitment, '... the page opens it: the find, recorded');
    const s2 = await SEAL.seal('/api/pool/found/status', { lease: f.L.lease }, pub);
    r = await post('/api/pool/found/status', s2.body);
    ok(r[0] === 200 && (await s2.open(r[1])).recorded, 'the finder\'s status: asked and answered sealed');
    eq((await post('/api/pool/found/status', { lease: f.L.lease }))[0], 400, '... asked in the clear: refused');
    eq((await post('/api/pool/solo', { key: '0x' + KEY.toString(16), puzzle: PUZZLE, source: 'lucky' }))[0], 400, 'a key for the vault in the clear: refused');
    eq(f.p.transportPub.length, 130, 'the transport key\'s public half: an uncompressed P-256 point');
    srv.close();
    await new Promise((a2) => setTimeout(a2, 300));
    fs.rmSync(f.d, { recursive: true, force: true });
  }

  console.log('the pause: a find waiting for its claim');
  {
    const f = await fresh();
    await f.p.finds.found(honest(f.L).body);
    const r2 = await f.p.lease({ addr: FINDER }, 'c9');
    ok(r2[0] === 503 && r2[1].found && /key was found\. The search is paused/.test(r2[1].error), 'no more pieces: the key was found, the search paused', r2[1]);
    ok(f.p.stats().found && f.p.stats().found.puzzle === PUZZLE, 'the stats say so (the pages show it)');
    fs.rmSync(f.d, { recursive: true, force: true });
  }

  await mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
  done();
  process.exit(process.exitCode);
})().catch((e) => { console.error(e); process.exit(1); });
