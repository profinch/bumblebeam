// The coordinator of puzzle.bumblebeam.org's shared search: hands out non-overlapping chunks of the current
// puzzle's range with planted check keys, takes the reports, keeps the totals, the players and their referrals.
//
// Chunks. Puzzle n's range [2^(n-1), 2^n) is cut into chunks of 2^CHUNK_BITS keys. Which chunk comes next is a
// secret pseudo-random permutation of the chunk numbers (a Feistel network keyed from POOL_SECRET), so nobody
// can tell which parts are done. A "Shuffle" is one such permutation plus a counter of how many chunks it has
// given out; every 210 blocks (boundaries at heights divisible by 210) a new Shuffle starts, keyed from the
// secret and that block's hash. A chunk is skipped when an earlier Shuffle already gave it out (its inverse
// permutation is below that Shuffle's counter). Chunks given out but never reported go to a retry list and are
// handed out again first. So the whole bookkeeping is a few counters, not a bitmap of 2^36 chunks.
//
// Check keys. Each lease carries 3-7 keys at random places in its chunk, sent only as hash160s among decoys
// (10 targets in all), so the client never knows how many are real. A report must name all the real ones:
// whoever skipped part of the chunk misses some with high odds and gets nothing. The puzzle's own target is
// always the first one; when a browser finds it, it sends its own claim through the private relays first and only
// then the key here (finds.js), which closes that chunk for good (status 'found': never handed out again).
//
// Storage: SQLite (node:sqlite) in DATA_DIR/pool.db. The secret: POOL_SECRET (hex), or DATA_DIR/pool-secret,
// created on first start. Never in the repository.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createPool(o) {
  const S = o.secp, TX = o.tx, KIT = o.kit;
  const CHUNK_BITS = Number(process.env.POOL_CHUNK_BITS || 33); // 8.6e9 keys: minutes on a gaming GPU, half an hour on a weak one
  // Check keys per piece: a random number between CHECKS_MIN and CHECKS_MAX, padded with decoys (hash160s of
  // keys outside the piece) to TARGETS - 1, so a client cannot tell when it has found them all: stopping early
  // risks the whole piece (no credit, and the piece goes to someone else), it never gets credit for half a piece.
  const CHECKS_MIN = Number(process.env.POOL_CHECKS_MIN || 3);
  const CHECKS_MAX = Number(process.env.POOL_CHECKS_MAX || 7);
  const TARGETS = 10; // the puzzle's own + checks + decoys
  const LEASE_MIN = Number(process.env.POOL_LEASE_MINUTES || 90);
  // A piece's lease lasts LEASE_MIN; a browser still searching it (its pings) keeps it alive past that, up to
  // LEASE_MAX in all, so a slow card or a background tab never loses a piece it is about to finish. A report is
  // taken up to GRACE seconds after the lease ran out (a report lost to the network and sent again).
  const LEASE_MAX = 4 * LEASE_MIN * 60, GRACE = 600;
  // A piece whose browser went silent (pinged, then stopped pinging without the "kept for later" word: a crash,
  // a lost network) goes back to the pool after SILENT seconds instead of waiting out its lease
  const SILENT = 300;
  // the most a browser's reported speed counts for (keys a second; the fastest card today does about 2e9): a made-up
  // speed cannot blow up the pool's shown speed
  const RATE_MAX = 1e10;
  // Open pieces per client (a keyed hash of the IP): an office or a mobile network puts many browsers behind one IP,
  // and each holds two (the one it searches and the next, asked for ahead)
  const MAX_OPEN_PER_CLIENT = Number(process.env.POOL_MAX_OPEN || 32);
  // after a find the pool waits for its claim; if the claim is still not confirmed after this long, the pool moves
  // on to the next puzzle (the server keeps pushing the claim meanwhile): the found puzzle is never searched again
  const PAUSE_MAX = Number(process.env.POOL_PAUSE_HOURS || 24) * 3600;
  const PAYOUT = process.env.POOL_PAYOUT_ADDRESS || ''; // the pool's share of a prize goes here (from the env only)
  // the split: the finder gets the prize's whole bitcoins but one (6 of 7.1 BTC on #71), the pool keeps 1 BTC
  // and the fraction, and pays the fees from it
  const prizeBtc = (n) => n / 10;
  const finderBtc = (n) => Math.max(0, Math.floor(prizeBtc(n)) - 1);
  const SHUFFLE_BLOCKS = 210;

  // ---------- the secret ----------
  if (process.env.POOL_SECRET && !/^([0-9a-f]{2}){16,}$/i.test(process.env.POOL_SECRET)) throw new Error('POOL_SECRET must be hex, 32 characters or more');
  let secret = process.env.POOL_SECRET ? Buffer.from(process.env.POOL_SECRET, 'hex') : null;
  if (!secret || secret.length < 16) {
    const f = path.join(o.dataDir, 'pool-secret');
    try { secret = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex'); } catch (_) { /* first start */ }
    if (!secret || secret.length < 16) {
      secret = crypto.randomBytes(32);
      fs.mkdirSync(o.dataDir, { recursive: true });
      fs.writeFileSync(f, secret.toString('hex'), { mode: 0o600 });
    }
  }
  const hmac = (...parts) => crypto.createHmac('sha256', secret).update(parts.join('|')).digest();
  // the key the pool signs its receipts for found keys with (finds.js): POOL_RECEIPT_KEY (hex), else a file in
  // DATA_DIR made on first start. Its public key must be the one published in claimkit.js (RECEIPT_PUB): a receipt
  // under any other key is worth nothing to a finder, and the finder's page says so
  let receiptKey = /^[0-9a-f]{64}$/i.test(process.env.POOL_RECEIPT_KEY || '') ? BigInt('0x' + process.env.POOL_RECEIPT_KEY) : 0n;
  if (!receiptKey) {
    const f = path.join(o.dataDir, 'receipt-key');
    try { receiptKey = BigInt('0x' + fs.readFileSync(f, 'utf8').trim()); } catch (_) { /* first start */ }
    if (!receiptKey) {
      const b = crypto.randomBytes(32).toString('hex');
      fs.mkdirSync(o.dataDir, { recursive: true });
      fs.writeFileSync(f, b, { mode: 0o600 });
      receiptKey = BigInt('0x' + b);
    }
  }

  // the vault's key (vault.js: found keys written down, sealed with it): POOL_VAULT_KEY (hex) from the deploy's .env,
  // never written on this server. Without one (tests, a local preview) a key is made in DATA_DIR, next to what it
  // seals: server.js refuses to start that way outside of testing
  if (process.env.POOL_VAULT_KEY && !/^[0-9a-f]{64}$/i.test(process.env.POOL_VAULT_KEY)) throw new Error('POOL_VAULT_KEY must be 64 hex digits');
  let vaultKey = process.env.POOL_VAULT_KEY ? Buffer.from(process.env.POOL_VAULT_KEY, 'hex') : null;
  const vaultKeyOnDisk = !vaultKey;
  if (!vaultKey) {
    const f = path.join(o.dataDir, 'vault-key');
    try { vaultKey = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex'); } catch (_) { /* first start */ }
    if (!vaultKey || vaultKey.length !== 32) {
      vaultKey = crypto.randomBytes(32);
      fs.mkdirSync(o.dataDir, { recursive: true });
      fs.writeFileSync(f, vaultKey.toString('hex'), { mode: 0o600 });
    }
  }

  // the transport key (web/engine/seal.js): a find's key comes to POST /api/pool/found and /solo sealed for this
  // key, so nothing between the page and here can read it. POOL_TRANSPORT_KEY (P-256, hex) from the deploy's .env,
  // else a file in DATA_DIR made on first start; its public half must be the one published in seal.js
  // (TRANSPORT_PUB): server.js does not start with another outside of testing
  const SEAL = (() => { for (const p of [path.join(__dirname, 'seal.js'), path.join(__dirname, '../web/engine/seal.js')]) if (fs.existsSync(p)) return require(p); throw new Error('seal.js not found'); })();
  if (process.env.POOL_TRANSPORT_KEY && !/^[0-9a-f]{64}$/i.test(process.env.POOL_TRANSPORT_KEY)) throw new Error('POOL_TRANSPORT_KEY must be 64 hex digits');
  let transportD = process.env.POOL_TRANSPORT_KEY || '';
  if (!transportD) {
    const f = path.join(o.dataDir, 'transport-key');
    try { transportD = fs.readFileSync(f, 'utf8').trim(); } catch (_) { /* first start */ }
    if (!/^[0-9a-f]{64}$/i.test(transportD)) {
      const e = crypto.createECDH('prime256v1'); e.generateKeys();
      transportD = e.getPrivateKey('hex').padStart(64, '0');
      fs.mkdirSync(o.dataDir, { recursive: true });
      fs.writeFileSync(f, transportD, { mode: 0o600 });
    }
  }
  const transportEcdh = crypto.createECDH('prime256v1');
  transportEcdh.setPrivateKey(Buffer.from(transportD, 'hex'));
  const transportPub = transportEcdh.getPublicKey('hex');
  const transport = { seal: SEAL, key: SEAL.importPrivate(transportD, transportPub) };
  transportD = null;

  // ---------- database ----------
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(o.dataDir, 'pool.db'));
  // Every statement is compiled once and kept (finds.js shares the db, so it gets the same): compiling one costs
  // more than running it, and a ping or a lease runs several. A statement is run to its end each time (get, all,
  // run), so one object can serve every caller in turn.
  const stmts = new Map(), compile = db.prepare.bind(db);
  db.prepare = (sql) => { let st = stmts.get(sql); if (!st) { st = compile(sql); stmts.set(sql, st); } return st; };
  // WAL with synchronous NORMAL: a commit no longer waits for the disk (a crash of the process loses nothing; a
  // power cut may lose the last commits whole, a lease with its counter, never one without the other)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS shuffles (puzzle INTEGER, idx INTEGER, height INTEGER, hash TEXT, counter INTEGER, PRIMARY KEY (puzzle, idx));
    CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, puzzle INTEGER, chunk TEXT, addr TEXT, client TEXT, issued INTEGER,
      expires INTEGER, checks TEXT, status TEXT, rate REAL, done_at INTEGER);
    CREATE INDEX IF NOT EXISTS leases_open ON leases (status, expires);
    CREATE INDEX IF NOT EXISTS leases_done ON leases (status, done_at);
    CREATE TABLE IF NOT EXISTS retry (puzzle INTEGER, chunk TEXT, PRIMARY KEY (puzzle, chunk));
    CREATE TABLE IF NOT EXISTS players (addr TEXT PRIMARY KEY, ref TEXT, first INTEGER, last INTEGER, chunks INTEGER DEFAULT 0, keys REAL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS totals (puzzle INTEGER PRIMARY KEY, chunks INTEGER DEFAULT 0, keys REAL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS leases_client ON leases (client, status, done_at);
    CREATE INDEX IF NOT EXISTS leases_addr ON leases (addr, status, done_at);
    CREATE INDEX IF NOT EXISTS players_ref ON players (ref);
    CREATE INDEX IF NOT EXISTS players_keys ON players (keys);
  `);
  // who invited a searcher is written down with the searcher's first credited piece, not when it first asks for a
  // piece (anyone can ask in any address's name): the lease carries the invite until then
  if (!db.prepare('PRAGMA table_info(leases)').all().some((c) => c.name === 'ref')) {
    db.exec('ALTER TABLE leases ADD COLUMN ref TEXT');
    db.exec('UPDATE players SET ref = NULL WHERE chunks = 0'); // invites recorded the old way, for nobody who searched
  }
  // What the limits do, kept to decide them later (api/limits.js reads it): with each lease, how many pieces its
  // client (the keyed hash of an IP) and its payout address held open at that moment, how often pings stretched it
  // and whether it was taken back because its browser fell silent; every request the limits turned away. Nothing
  // here is an IP: the client is the same keyed hash the limits use.
  for (const [c, t] of [['open_client', 'INTEGER'], ['open_addr', 'INTEGER'], ['ext', 'INTEGER DEFAULT 0'], ['silent', 'INTEGER DEFAULT 0']]) {
    if (!db.prepare('PRAGMA table_info(leases)').all().some((x) => x.name === c)) db.exec(`ALTER TABLE leases ADD COLUMN ${c} ${t}`);
  }
  // when an address joined: its first credited piece, written with it (the recent list's "joined" lines read this
  // column instead of looking up every searcher's first piece on each request)
  if (!db.prepare('PRAGMA table_info(players)').all().some((c) => c.name === 'joined')) {
    db.exec('ALTER TABLE players ADD COLUMN joined INTEGER');
    db.exec("UPDATE players SET joined = (SELECT MIN(done_at) FROM leases l WHERE l.addr = players.addr AND l.status = 'done') WHERE chunks > 0");
  }
  db.exec('CREATE INDEX IF NOT EXISTS players_joined ON players (joined)');
  db.exec(`CREATE TABLE IF NOT EXISTS limit_log (t INTEGER, kind TEXT, client TEXT, addr TEXT, open_client INTEGER, open_addr INTEGER);
    CREATE INDEX IF NOT EXISTS limit_log_t ON limit_log (t);`);
  // one row per client and kind a minute at most (a flood of refused requests is one fact, not thousands of rows)
  const refusedAt = new Map();
  function refused(kind, client, addr) {
    const k = kind + ':' + client;
    if (now() - (refusedAt.get(k) || 0) < 60) return;
    refusedAt.set(k, now());
    if (refusedAt.size > 20000) refusedAt.clear();
    try {
      const n = (sql, v) => db.prepare(sql).get(v, now()).n;
      db.prepare('INSERT INTO limit_log (t, kind, client, addr, open_client, open_addr) VALUES (?, ?, ?, ?, ?, ?)').run(now(), kind, client, addr || null,
        n("SELECT COUNT(*) AS n FROM leases WHERE client = ? AND status = 'open' AND +expires > ?", client), addr ? n("SELECT COUNT(*) AS n FROM leases WHERE addr = ? AND status = 'open' AND +expires > ?", addr) : null);
    } catch (e) { console.error('limit_log:', e.message); }
  }

  // The order of the pieces is keyed from the secret and counted in chunks of CHUNK_BITS: with either changed, pieces
  // handed out before would be handed out again and as many others never. Their fingerprint is kept with the
  // database, and the pool refuses to start on another one (a lost secret file, a new value in the env)
  db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
  {
    const fp = hmac('fingerprint').toString('hex').slice(0, 16) + '/' + CHUNK_BITS;
    const was = db.prepare("SELECT v FROM meta WHERE k = 'fingerprint'").get();
    if (!was) db.prepare("INSERT INTO meta (k, v) VALUES ('fingerprint', ?)").run(fp);
    else if (was.v !== fp) throw new Error('the pool\'s secret or POOL_CHUNK_BITS is not the one this database was made with: the order of the pieces would break (restore the secret, or start a new database)');
  }

  // several statements as one: all of them or none (a crash in between must not lose a piece)
  function atomic(f) {
    db.exec('BEGIN IMMEDIATE');
    try { const r = f(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  const now = () => Math.floor(Date.now() / 1000);
  // the heartbeat: a searching browser pings every 5 s with its speed over those 5 s. Kept in memory only
  // (lease id -> { rate, seen }), never written per ping; after a restart a lease counts from its issue time
  // until its next ping. Six missed pings (30 s) and it counts as gone.
  const ALIVE = 30, beats = new Map();

  // ---------- the permutation: a Feistel network over w bits, cycle-walking down to the chunk count ----------
  function feistel(key, w) {
    const h = Math.ceil(w / 2), lo = BigInt(w - h), hiBits = BigInt(h);
    const maskL = (1n << lo) - 1n, maskH = (1n << hiBits) - 1n;
    const F = (r, x, bits) => BigInt('0x' + crypto.createHmac('sha256', key).update(r + ':' + x.toString(16)).digest('hex').slice(0, 16)) & ((1n << bits) - 1n);
    // split x into L (high, h bits) and R (low, w - h bits); four unbalanced rounds alternate the halves
    function enc(x) {
      let L = x >> lo, R = x & maskL;
      for (let r = 0; r < 4; r++) {
        if (r % 2 === 0) L = (L ^ F(r, R, hiBits)) & maskH; else R = (R ^ F(r, L, lo)) & maskL;
      }
      return (L << lo) | R;
    }
    function dec(y) {
      let L = y >> lo, R = y & maskL;
      for (let r = 3; r >= 0; r--) {
        if (r % 2 === 0) L = (L ^ F(r, R, hiBits)) & maskH; else R = (R ^ F(r, L, lo)) & maskL;
      }
      return (L << lo) | R;
    }
    return { enc, dec };
  }
  function permFor(puzzle, sh) {
    const count = chunkCount(puzzle);
    const w = Math.max(2, (count - 1n).toString(2).length);
    const f = feistel(hmac('shuffle', puzzle, sh.idx, sh.hash), w);
    return {
      fwd(x) { let y = f.enc(x); while (y >= count) y = f.enc(y); return y; },
      inv(y) { let x = f.dec(y); while (x >= count) x = f.dec(x); return x; },
    };
  }
  function chunkCount(puzzle) { return 1n << BigInt(Math.max(0, puzzle - 1 - CHUNK_BITS)); }
  function chunkSize(puzzle) { return puzzle - 1 > CHUNK_BITS ? 1n << BigInt(CHUNK_BITS) : 1n << BigInt(puzzle - 1); }

  // ---------- Shuffles ----------
  const permCache = new Map();
  function shuffles(puzzle) { return db.prepare('SELECT * FROM shuffles WHERE puzzle = ? ORDER BY idx').all(puzzle); }
  function perm(puzzle, sh) {
    const k = puzzle + ':' + sh.idx;
    if (!permCache.has(k)) permCache.set(k, permFor(puzzle, sh));
    return permCache.get(k);
  }
  // starts a new Shuffle when the chain has passed a boundary since the last one
  async function maybeShuffle(puzzle) {
    const tip = o.tip();
    if (!tip) return;
    const boundary = tip - (tip % SHUFFLE_BLOCKS);
    const list = shuffles(puzzle), last = list[list.length - 1];
    if (last && last.height >= boundary) return;
    let hash;
    try { hash = await o.blockHash(boundary); } catch (e) { console.error('shuffle: block hash', e.message); return; }
    const idx = last ? last.idx + 1 : 1;
    db.prepare('INSERT OR IGNORE INTO shuffles (puzzle, idx, height, hash, counter) VALUES (?, ?, ?, ?, 0)').run(puzzle, idx, boundary, hash);
    console.log(`pool: Shuffle ${Math.floor((boundary % 210000) / SHUFFLE_BLOCKS)}/1000 (the pool's #${idx}) for #${puzzle} at block ${boundary}`);
  }
  // the next chunk to give out: a retry first, then the current Shuffle's next one nobody had before
  function nextChunk(puzzle) {
    const r = db.prepare('SELECT chunk FROM retry WHERE puzzle = ? LIMIT 1').get(puzzle);
    if (r) { db.prepare('DELETE FROM retry WHERE puzzle = ? AND chunk = ?').run(puzzle, r.chunk); return { chunk: BigInt(r.chunk), retry: true }; }
    const list = shuffles(puzzle);
    if (!list.length) return null;
    const cur = list[list.length - 1], count = chunkCount(puzzle), P = perm(puzzle, cur);
    let ctr = BigInt(cur.counter);
    for (let guard = 0; guard < 100000 && ctr < count; guard++) {
      const c = P.fwd(ctr); ctr++;
      const taken = list.slice(0, -1).some((sh) => perm(puzzle, sh).inv(c) < BigInt(sh.counter));
      if (!taken) {
        db.prepare('UPDATE shuffles SET counter = ? WHERE puzzle = ? AND idx = ?').run(Number(ctr), puzzle, cur.idx);
        return { chunk: c, retry: false };
      }
    }
    db.prepare('UPDATE shuffles SET counter = ? WHERE puzzle = ? AND idx = ?').run(Number(ctr), puzzle, cur.idx);
    return null; // this Shuffle is used up (or the range is done)
  }

  // ---------- leases ----------
  function randBelow(n) { // uniform in [0, n)
    const bytes = Math.ceil(n.toString(16).length / 2) + 8;
    return BigInt('0x' + crypto.randomBytes(bytes).toString('hex')) % n;
  }
  const clientLeases = new Map(); // client -> request times (rate limit)
  function limited(client) {
    const t = Date.now(), list = (clientLeases.get(client) || []).filter((x) => t - x < 60000);
    list.push(t); clientLeases.set(client, list);
    if (clientLeases.size > 20000) clientLeases.clear();
    return list.length > 30;
  }

  // the puzzle to search: the radar's targets in order (the smallest open puzzle with a hidden public key first),
  // past one whose find has waited for its claim longer than PAUSE_MAX
  function target() {
    const list = o.targets ? o.targets() : [o.target()];
    for (const n of list || []) {
      if (!n) continue;
      const since = finds.pendingSince(n);
      if (since && now() - since > PAUSE_MAX) continue;
      return n;
    }
    return null;
  }

  async function lease(body, client) {
    const puzzle = target();
    if (!puzzle) return [503, { error: 'no open puzzle to search' }];
    // a payout address is required: it goes into the commitment and the transactions the moment a browser finds
    // the key, so it must be known before the search
    const addr = String(body.addr || '').trim() || null;
    if (!addr) return [400, { error: 'a payout address is required to search: if your browser finds the key, your share goes to it' }];
    if (!TX.isAddress(addr)) return [400, { error: 'not a Bitcoin mainnet address' }];
    for (let n = 1; n <= 160; n++) if (o.address(n) === addr) return [400, { error: 'that is a puzzle address, not yours' }];
    let ref = String(body.ref || '').trim() || null;
    if (ref && (!TX.isAddress(ref) || ref === addr)) ref = null;
    if (limited(client)) { refused('rate', client, addr); return [429, { error: 'too many requests, please slow down' }]; }
    // the client's own open pieces, found through its index (client, status): `+expires` keeps SQLite from walking
    // every open piece of the pool through (status, expires) instead, which made a lease cost grow with the pool
    const open = db.prepare("SELECT COUNT(*) AS n FROM leases WHERE client = ? AND status = 'open' AND +expires > ?").get(client, now()).n;
    if (open >= MAX_OPEN_PER_CLIENT) { refused('open', client, addr); return [429, { error: 'too many pieces open at once. Finish or release one first' }]; }
    const openAddr = db.prepare("SELECT COUNT(*) AS n FROM leases WHERE addr = ? AND status = 'open' AND +expires > ?").get(addr, now()).n;
    // a key reported and its prize not yet spent: the search waits for the claim (no piece would hold the key)
    // a find of this puzzle waits for its claim: the search is paused, and every searcher is told why
    if (finds.pending(puzzle)) return [503, { error: 'puzzle #' + puzzle + '’s key was found. The search is paused; the details and the proof follow once the claim is confirmed', found: true }];
    await maybeShuffle(puzzle);
    const id = crypto.randomBytes(16).toString('hex'), exp = now() + LEASE_MIN * 60, size = chunkSize(puzzle);
    // the next chunk taken and its lease written in one go: a crash between the two would lose the chunk for good
    // (the counter moved on, and no lease or retry entry holds it)
    let nc = null, from = 0n, offsets = [];
    atomic(() => {
      nc = nextChunk(puzzle);
      if (!nc) return;
      from = (1n << BigInt(puzzle - 1)) + nc.chunk * size;
      const nChecks = CHECKS_MIN + Number(randBelow(BigInt(CHECKS_MAX - CHECKS_MIN + 1)));
      while (offsets.length < nChecks) { const x = randBelow(size); if (!offsets.some((y) => y === x)) offsets.push(x); }
      db.prepare("INSERT INTO leases (id, puzzle, chunk, addr, client, issued, expires, checks, status, ref, open_client, open_addr) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)")
        .run(id, puzzle, nc.chunk.toString(), addr, client, now(), exp, JSON.stringify(offsets.map((x) => x.toString(16))), ref, open + 1, openAddr + 1);
      db.prepare('INSERT INTO players (addr, first, last) VALUES (?, ?, ?) ON CONFLICT(addr) DO UPDATE SET last = excluded.last').run(addr, now(), now());
    });
    if (!nc) return [503, { error: 'no chunk available right now' }];
    const checks = offsets.map((x) => S.hash160OfKey(from + x));
    // decoys: random 160-bit values; no key in the piece hashes to them (the odds are 2^-127 per piece)
    while (checks.length < TARGETS - 1) checks.push(crypto.randomBytes(20).toString('hex'));
    // the main target first; the checks in a random order after it
    const order = checks.map((c) => [crypto.randomBytes(4).readUInt32LE(), c]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    return [200, {
      lease: id, puzzle, address: o.address(puzzle), from: '0x' + from.toString(16), to: '0x' + (from + size - 1n).toString(16),
      keys: Number(size), targets: [S.addressToHash160(o.address(puzzle))].concat(order), expires: exp,
      // where the pool's part of a prize goes: the browser that finds the key needs it at that moment, when our
      // server may not answer
      pool_payout: PAYOUT || null,
    }];
  }

  function report(body, client) {
    const l = db.prepare('SELECT * FROM leases WHERE id = ?').get(String(body.lease || ''));
    if (!l) return [404, { error: 'no such lease' }];
    if (l.status !== 'open') return [409, { error: 'this lease is ' + l.status }];
    if (l.expires + GRACE < now()) return [410, { error: 'the lease expired' }];
    const size = chunkSize(l.puzzle), from = (1n << BigInt(l.puzzle - 1)) + BigInt(l.chunk) * size;
    const want = JSON.parse(l.checks).map((x) => from + BigInt('0x' + x));
    let got = [];
    try { got = (body.keys || []).map((k) => BigInt(String(k).startsWith('0x') ? k : '0x' + k)); } catch (_) { got = []; }
    const ok = want.every((w) => got.some((g) => g === w));
    const rate = Math.max(0, Math.min(RATE_MAX, Number(body.rate) || 0));
    beats.delete(l.id);
    if (!ok) {
      atomic(() => {
        db.prepare("UPDATE leases SET status = 'failed', done_at = ? WHERE id = ?").run(now(), l.id);
        db.prepare('INSERT OR IGNORE INTO retry (puzzle, chunk) VALUES (?, ?)').run(l.puzzle, l.chunk);
      });
      return [422, { error: 'the check keys are not all there: the chunk goes back to the pool, no credit' }];
    }
    atomic(() => {
      db.prepare("UPDATE leases SET status = 'done', done_at = ?, rate = ? WHERE id = ?").run(now(), rate, l.id);
      db.prepare('INSERT INTO totals (puzzle, chunks, keys) VALUES (?, 1, ?) ON CONFLICT(puzzle) DO UPDATE SET chunks = chunks + 1, keys = keys + excluded.keys').run(l.puzzle, Number(size));
      if (l.addr) {
        // the first credited piece writes down who invited this searcher, if anyone did and nobody was written yet
        db.prepare('UPDATE players SET ref = ? WHERE addr = ? AND ref IS NULL AND chunks = 0 AND ? IS NOT NULL').run(l.ref || null, l.addr, l.ref || null);
        db.prepare('UPDATE players SET joined = COALESCE(joined, ?), chunks = chunks + 1, keys = keys + ?, last = ? WHERE addr = ?').run(now(), Number(size), now(), l.addr);
      }
    });
    statsCache = null;
    return [200, { ok: true, credited: Number(size) }];
  }

  // the heartbeat: still searching this lease, at this speed
  function ping(body) {
    const l = db.prepare("SELECT id, issued, expires FROM leases WHERE id = ? AND status = 'open'").get(String(body.lease || ''));
    if (!l) return [404, { error: 'no such open lease' }];
    const rate = Math.max(0, Math.min(RATE_MAX, Number(body.rate) || 0));
    // idle: the browser stopped (or closed the tab) but keeps the piece to continue it later
    beats.set(l.id, body.idle ? { rate: 0, seen: 0, idle: true } : { rate, seen: now() });
    // still searching near the end of the lease: ten more minutes, up to LEASE_MAX from the issue
    const t = now();
    if (!body.idle && l.expires < t + 600 && l.expires < l.issued + LEASE_MAX) {
      const exp = Math.min(l.issued + LEASE_MAX, t + 600);
      db.prepare('UPDATE leases SET expires = ?, ext = ext + 1 WHERE id = ?').run(exp, l.id);
      return [200, { ok: true, expires: exp }];
    }
    return [200, { ok: true }];
  }

  function release(body) {
    const l = db.prepare("SELECT * FROM leases WHERE id = ? AND status = 'open'").get(String(body.lease || ''));
    if (!l) return [404, { error: 'no such open lease' }];
    atomic(() => {
      db.prepare("UPDATE leases SET status = 'released', done_at = ? WHERE id = ?").run(now(), l.id);
      db.prepare('INSERT OR IGNORE INTO retry (puzzle, chunk) VALUES (?, ?)').run(l.puzzle, l.chunk);
    });
    beats.delete(l.id);
    return [200, { ok: true }];
  }

  // a lease's piece: its first and last key
  function piece(l) {
    const size = chunkSize(l.puzzle), from = (1n << BigInt(l.puzzle - 1)) + BigInt(l.chunk) * size;
    return { from, to: from + size - 1n };
  }
  // the piece that holds the key is closed for good: its lease (and any other open one on the same piece) becomes
  // 'found', which nothing hands out again, and it leaves the retry list
  function closePiece(l) {
    db.prepare("UPDATE leases SET status = 'found', done_at = COALESCE(done_at, ?) WHERE id = ? OR (puzzle = ? AND chunk = ? AND status = 'open')").run(now(), l.id, l.puzzle, l.chunk);
    db.prepare('DELETE FROM retry WHERE puzzle = ? AND chunk = ?').run(l.puzzle, l.chunk);
    beats.delete(l.id);
  }
  // the found key's own part (finds.js): checks, the piece closed, the relays, the proof
  const finds = require('./finds.js').createFinds({
    db, secp: S, tx: TX, kit: KIT, node: o.node, address: o.address, payout: PAYOUT, piece, close: closePiece, now: o.now, receiptKey,
    notify: o.notify, isAddress: TX.isAddress, transport, vault: require('./vault.js').createVault(path.join(o.dataDir, 'vault'), vaultKey),
    leaseRow: (id) => db.prepare('SELECT * FROM leases WHERE id = ?').get(id),
  });

  // expired leases give their chunks back once the grace for a late report is over (a report sent again after a
  // network failure still counts); so do leases whose browser went silent for SILENT seconds (pinged before, and
  // never said it keeps the piece for later). A lease with no ping heard since a restart waits out its lease.
  function sweep() {
    const t = now();
    db.prepare('DELETE FROM limit_log WHERE t < ?').run(t - 180 * 86400); // half a year is enough to decide
    const rows = db.prepare("SELECT id, puzzle, chunk FROM leases WHERE status = 'open' AND expires < ?").all(t - GRACE);
    for (const [id, b] of beats) if (!b.idle && b.seen && b.seen < t - SILENT) { const l = db.prepare("SELECT id, puzzle, chunk FROM leases WHERE id = ? AND status = 'open'").get(id); if (l) rows.push(Object.assign(l, { silent: 1 })); beats.delete(id); }
    if (!rows.length) return;
    atomic(() => {
      for (const l of rows) {
        db.prepare("UPDATE leases SET status = 'expired', silent = ? WHERE id = ?").run(l.silent || 0, l.id);
        db.prepare('INSERT OR IGNORE INTO retry (puzzle, chunk) VALUES (?, ?)').run(l.puzzle, l.chunk);
      }
    });
    console.log(`pool: ${rows.length} leases expired or went silent, their chunks go back`);
  }

  // ---------- stats ----------
  // asked for by every page and every live push: worked out at most once a second
  let statsCache = null;
  function stats() {
    const tc = Date.now();
    if (statsCache && tc - statsCache.t < 1000) return statsCache.v;
    statsCache = { t: tc, v: statsNow() };
    return statsCache.v;
  }
  function statsNow() {
    const puzzle = target();
    const t = (puzzle && db.prepare('SELECT * FROM totals WHERE puzzle = ?').get(puzzle)) || { chunks: 0, keys: 0 };
    // who searches now: every open lease whose browser pinged in the last 30 s (or that is newer than that):
    // a searching browser holds one piece at a time, so a live lease is a browser, even when several share an
    // IP. The speed: the sum of their latest pinged speeds (a lease not pinged yet: its client's last finished
    // piece, until its first ping)
    const tn = now();
    let speed = 0, active = 0;
    const byClient = new Map();
    for (const r of db.prepare("SELECT id, client, issued FROM leases WHERE puzzle = ? AND status = 'open' AND expires > ?").all(puzzle, tn)) {
      const b = beats.get(r.id);
      if (b ? b.idle || b.seen <= tn - ALIVE : r.issued <= tn - ALIVE) continue;
      active++;
      let v = b && b.rate;
      if (!v) { const d = db.prepare("SELECT rate FROM leases WHERE client = ? AND status = 'done' ORDER BY done_at DESC LIMIT 1").get(r.client); v = (d && d.rate) || 0; }
      // at most 3 cards' worth per client (an IP's open pieces can each claim a speed)
      byClient.set(r.client, Math.min(3 * RATE_MAX, (byClient.get(r.client) || 0) + v));
    }
    for (const v of byClient.values()) speed += v;
    // a searcher: an address with at least one finished piece (one that only took a piece and left is not)
    const players = db.prepare('SELECT COUNT(*) AS n FROM players WHERE chunks > 0').get().n;
    const week = db.prepare('SELECT COUNT(*) AS n FROM players WHERE chunks > 0 AND last > ?').get(tn - 7 * 86400).n;
    const list = puzzle ? shuffles(puzzle) : [];
    const range = puzzle ? Math.pow(2, puzzle - 1) : 0;
    return {
      puzzle, address: puzzle ? o.address(puzzle) : null,
      chunk_keys: puzzle ? Number(chunkSize(puzzle)) : null, chunks_total: puzzle ? Number(chunkCount(puzzle)) : null,
      chunks_done: t.chunks, keys_done: t.keys, share_done: range ? t.keys / range : 0,
      speed, active, players, players_week: week,
      // a find waiting for its claim: the pool is paused (lease answers 503), the pages say the key was found
      found: puzzle && finds.pendingSince(puzzle) ? { puzzle, since: finds.pendingSince(puzzle) } : null,
      // shown by the chain: 1000 Shuffles per halving (210 000 / 210), numbered from the halving's first block
      shuffle: list.length ? shuffleInfo(list[list.length - 1]) : null,
      prize_btc: puzzle ? prizeBtc(puzzle) : null, finder_btc: puzzle ? finderBtc(puzzle) : null, payout_address: PAYOUT || null, checks: [CHECKS_MIN, CHECKS_MAX], lease_minutes: LEASE_MIN,
    };
  }
  function shuffleInfo(sh) {
    return {
      number: Math.floor((sh.height % 210000) / SHUFFLE_BLOCKS), of: 210000 / SHUFFLE_BLOCKS, halving: Math.floor(sh.height / 210000),
      height: sh.height, next: sh.height + SHUFFLE_BLOCKS, here: sh.idx,
    };
  }
  function short(a) { return a.length > 16 ? a.slice(0, 8) + '…' + a.slice(-6) : a; }
  // the top: whole addresses (each is a link to that searcher's page, which shows it anyway)
  function top() {
    const rows = db.prepare('SELECT p.addr, p.chunks, p.keys, p.last, (SELECT COUNT(*) FROM players r WHERE r.ref = p.addr) AS refs FROM players p WHERE p.chunks > 0 ORDER BY p.keys DESC LIMIT 50').all();
    return { players: rows.map((r) => ({ addr: r.addr, chunks: r.chunks, keys: r.keys, refs: r.refs, last: r.last })) };
  }

  // ---------- the pool's speed over time, from the finished pieces themselves ----------
  // A finished piece's keys are spread evenly over the time it was out (issued to reported), so a bucket's speed
  // is the keys that fell into it over its length: what the pool really checked, pauses included, and it needs no
  // samples kept. The last point is the speed the browsers report right now.
  const RANGES = { '24h': [86400, 300], '7d': [7 * 86400, 1800], '30d': [30 * 86400, 7200] };
  // Kept per range between answers: the buckets and the last second whose finished pieces are in them. A finished
  // piece never changes, so a minute later only the pieces finished since are added and the window moves on (the
  // buckets that fell out of it dropped, new empty ones at its end): the same numbers as adding up every piece of
  // the span again, which took a third of a second a minute per range with 300,000 pieces in 30 days.
  const histCache = new Map(), histAcc = new Map();
  function history(range) {
    const r = (Object.hasOwn(RANGES, range) && RANGES[range]) || RANGES['24h'], key = Object.hasOwn(RANGES, range) ? range : '24h';
    const c = histCache.get(key), tn = now();
    if (c && c.t > tn - 60) return Object.assign({}, c.v, { now: [tn, stats().speed] });
    const [span, step] = r, t0 = Math.floor((tn - span) / step) * step, n = Math.ceil((tn - t0) / step);
    // the pieces finished up to the last whole second (one finished later in this second comes with the next)
    let acc = histAcc.get(key), since = t0;
    const keys = new Float64Array(n);
    if (acc && acc.t0 <= t0 && acc.upto > t0) {
      const drop = (t0 - acc.t0) / step;
      keys.set(acc.keys.subarray(drop, Math.min(acc.keys.length, drop + n)));
      since = acc.upto;
    }
    for (const l of db.prepare("SELECT puzzle, issued, done_at FROM leases WHERE status = 'done' AND done_at > ? AND done_at <= ?").all(since, tn - 1)) {
      const size = Number(chunkSize(l.puzzle)), a = l.issued, b = Math.max(l.done_at, l.issued + 1), per = size / (b - a);
      for (let i = Math.max(0, Math.floor((a - t0) / step)); i < n && t0 + i * step < b; i++) {
        const lo = Math.max(a, t0 + i * step), hi = Math.min(b, t0 + (i + 1) * step);
        if (hi > lo) keys[i] += per * (hi - lo);
      }
    }
    histAcc.set(key, { t0, keys, upto: tn - 1 });
    const points = [];
    for (let i = 0; i < n; i++) points.push([t0 + i * step + step / 2, keys[i] / step]);
    const v = { range: key, step, points };
    histCache.set(key, { t: tn, v });
    return Object.assign({}, v, { now: [tn, stats().speed] });
  }

  // ---------- what happened lately: pieces finished, pieces that failed their checks, new searchers ----------
  function recent() {
    const ev = [];
    for (const l of db.prepare("SELECT puzzle, addr, done_at, rate, status FROM leases WHERE status IN ('done', 'failed') AND done_at IS NOT NULL ORDER BY done_at DESC LIMIT 60").all()) {
      ev.push({ t: l.done_at, kind: l.status === 'done' ? 'piece' : 'failed', addr: l.addr || null, puzzle: l.puzzle, keys: Number(chunkSize(l.puzzle)), rate: l.rate || 0 });
    }
    // joined: the first finished piece of an address (its first lease may have come to nothing)
    for (const p of db.prepare('SELECT addr, joined AS t, ref FROM players WHERE joined IS NOT NULL ORDER BY joined DESC LIMIT 20').all()) {
      if (p.t) ev.push({ t: p.t, kind: 'joined', addr: p.addr, ref: p.ref ? short(p.ref) : null });
    }
    ev.sort((a, b) => b.t - a.t || (a.kind === 'joined' ? -1 : 1));
    return { events: ev.slice(0, 60) };
  }
  function me(addr) {
    if (!TX.isAddress(addr)) return [400, { error: 'not a Bitcoin mainnet address' }];
    const p = db.prepare('SELECT * FROM players WHERE addr = ?').get(addr);
    const refs = db.prepare('SELECT COUNT(*) AS n FROM players WHERE ref = ?').get(addr).n;
    const refKeys = db.prepare('SELECT COALESCE(SUM(keys), 0) AS k FROM players WHERE ref = ?').get(addr).k;
    // whoever came through this address's invite link, the most keys first
    const referrals = db.prepare('SELECT addr, chunks, keys, first, last FROM players WHERE ref = ? ORDER BY keys DESC, first DESC LIMIT 200').all(addr);
    if (!p) return [200, { addr, chunks: 0, keys: 0, refs, ref_keys: refKeys, rank: null, referrals }];
    const rank = db.prepare('SELECT COUNT(*) AS n FROM players WHERE keys > ?').get(p.keys).n + 1;
    return [200, { addr, chunks: p.chunks, keys: p.keys, refs, ref_keys: refKeys, rank, first: p.first, last: p.last, ref: p.ref ? short(p.ref) : null, referrals }];
  }

  // ---------- live: the pool's numbers pushed to every open page (Server-Sent Events) ----------
  // A worker taking, finishing or giving back a piece, or pinging its speed, sends the new numbers to all pages
  // at once (a quarter second later, so a burst goes out as one); every 5 s they are checked anyway, so a
  // browser that vanished without a word drops out when its pings stop. A comment every 25 s keeps idle
  // connections open through Cloudflare and nginx.
  const LIVE_MAX = 5000, live = new Set();
  let lastLive = '', liveTimer = null;
  function push(force) {
    if (!live.size) return;
    const s = JSON.stringify(stats());
    if (s === lastLive && !force) return;
    lastLive = s;
    for (const res of live) res.write('data: ' + s + '\n\n');
  }
  // a change goes out a quarter second later, and never more than once a second (pings from many browsers
  // become one message)
  let lastPush = 0;
  function changed() {
    if (liveTimer) return;
    liveTimer = setTimeout(() => { liveTimer = null; lastPush = Date.now(); push(); }, Math.max(250, 1000 - (Date.now() - lastPush)));
  }
  // per client (a keyed hash of the IP) at most LIVE_PER_CLIENT streams, so one client cannot take every slot; a
  // page turned away polls /api/pool instead
  const LIVE_PER_CLIENT = 16, liveBy = new Map();
  function liveOpen(req, res, client) {
    const mine = liveBy.get(client) || 0;
    if (live.size >= LIVE_MAX || mine >= LIVE_PER_CLIENT) { refused(mine >= LIVE_PER_CLIENT ? 'live' : 'live_all', client, null); res.writeHead(503, { 'content-type': 'text/plain' }); res.end('too many live pages; poll /api/pool'); return; }
    liveBy.set(client, mine + 1);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no', 'access-control-allow-origin': '*' });
    res.write('retry: 5000\n\ndata: ' + JSON.stringify(stats()) + '\n\n');
    live.add(res);
    let gone = false;
    const bye = () => {
      if (gone) return;
      gone = true; live.delete(res);
      const n = (liveBy.get(client) || 1) - 1;
      if (n > 0) liveBy.set(client, n); else liveBy.delete(client);
    };
    req.on('close', bye); res.on('error', bye);
  }
  setInterval(() => { push(false); const t = now(); for (const [id, b] of beats) if (!b.idle && b.seen < t - 600) beats.delete(id); }, 5000).unref();
  // a kept (idle) piece's beat goes once its lease is no longer open (it ran out, was reported or released)
  setInterval(() => { const open = db.prepare("SELECT 1 FROM leases WHERE id = ? AND status = 'open'"); for (const [id, b] of beats) if (b.idle && !open.get(id)) beats.delete(id); }, 300000).unref();
  setInterval(() => { for (const res of live) res.write(': keep\n\n'); }, 25000).unref();

  // ---------- HTTP ----------
  // only a JSON body (application/json): a page on another site can send a "simple" form or text POST with its
  // visitors' IPs, never this one without a preflight
  function readJson(req, max) {
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) { req.resume(); return Promise.resolve(null); }
    return new Promise((resolve) => {
      let b = '';
      req.on('data', (c) => { b += c; if (b.length > (max || 8192)) { resolve(null); req.destroy(); } });
      req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve(null); } });
      req.on('error', () => resolve(null));
    });
  }
  // the network a client is counted by: an IPv4 address as it is, an IPv6 one by its /64 (one home or phone gets a
  // whole /64, so per address the limits would count nothing)
  function clientNet(ip) {
    ip = ip.replace(/^::ffff:/i, '');
    if (ip.indexOf(':') < 0) return ip;
    const [head, tail] = ip.split('::'), h = head ? head.split(':') : [], t = tail !== undefined && tail ? tail.split(':') : [];
    const full = h.concat(Array(Math.max(0, 8 - h.length - t.length)).fill('0'), t);
    return full.slice(0, 4).map((x) => parseInt(x || '0', 16).toString(16)).join(':') + '::/64';
  }
  // returns true when it answered
  async function handle(req, res, url, send) {
    if (!url.pathname.startsWith('/api/pool')) return false;
    // the client is a keyed hash of its IP: enough for the limits, and no address is kept
    const client = hmac('client', clientNet(String(req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.socket.remoteAddress || ''))).toString('hex').slice(0, 16);
    const p = url.pathname;
    try {
      if (await finds.handle(req, res, url, send, readJson)) return true;
      if (req.method === 'GET' && p === '/api/pool') { send(res, 200, stats(), 5); return true; }
      if (req.method === 'GET' && p === '/api/pool/live') { liveOpen(req, res, client); return true; }
      if (req.method === 'GET' && p === '/api/pool/top') { send(res, 200, top(), 30); return true; }
      if (req.method === 'GET' && p === '/api/pool/history') { send(res, 200, history(url.searchParams.get('range') || '24h'), 60); return true; }
      if (req.method === 'GET' && p === '/api/pool/recent') { send(res, 200, recent(), 10); return true; }
      if (req.method === 'GET' && p === '/api/pool/me') { const r = me(url.searchParams.get('addr') || ''); send(res, r[0], r[1]); return true; }
      if (req.method === 'POST' && ['/api/pool/lease', '/api/pool/report', '/api/pool/release', '/api/pool/ping'].includes(p)) {
        const body = await readJson(req);
        if (!body) { send(res, 400, { error: 'JSON body' }); return true; }
        const r = p === '/api/pool/lease' ? await lease(body, client) : p === '/api/pool/report' ? report(body, client) : p === '/api/pool/ping' ? ping(body) : release(body);
        send(res, r[0], r[1]);
        // a ping changes only the speed, which a second-old answer may show: the numbers are worked out again at
        // most once a second however many browsers ping (a lease, a report or a release shows at once)
        if (r[0] === 200) { if (p !== '/api/pool/ping') statsCache = null; changed(); }
        return true;
      }
      send(res, 404, { error: 'not found', endpoints: ['GET /api/pool', 'GET /api/pool/live (event stream)', 'GET /api/pool/top', 'GET /api/pool/history?range=24h|7d|30d', 'GET /api/pool/recent', 'GET /api/pool/me?addr=', 'POST /api/pool/lease', 'POST /api/pool/report', 'POST /api/pool/release', 'POST /api/pool/ping', 'POST /api/pool/found', 'GET /api/pool/found?lease=', 'GET /api/pool/finds', 'GET /api/pool/finds/{commitment}.ots'] });
    } catch (e) {
      console.error('pool:', e);
      send(res, 500, { error: 'internal error' });
    }
    return true;
  }

  setInterval(sweep, 60000).unref();
  return { receiptPub: KIT.pubHex(receiptKey), transportPub, transportPublished: SEAL.TRANSPORT_PUB, vaultKeyOnDisk, clientNet, handle, sweep, stats, nextChunk, chunkCount, permFor, maybeShuffle, db, finds, lease, report, release, ping, piece, target };
}

module.exports = { createPool };
