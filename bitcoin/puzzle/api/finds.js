// A found puzzle key on the server's side: POST /api/pool/found and everything after it, and the keys kept here for
// good (the vault, POST /api/pool/solo).
//
// The finder's browser comes here last. Before this request it has already put a commitment to the key and its
// payout address on the public OpenTimestamps calendars and sent its own signed split through the private relay
// (MARA Slipstream), so by the time the key arrives, the pool cannot quietly take everything: the finder's
// transaction is out, and a different spend would contradict a commitment made before it.
//
// Here the server checks it all (the key opens the puzzle's address and lies in that lease's piece, the commitment
// is sha256(key ‖ payout ‖ salt), the transaction spends only the puzzle's coins, its signatures verify, and it pays
// nobody but the finder and the pool, the finder the share), closes the piece for good, records the find without
// the key, and keeps the key, the salt and the signed transaction in memory only, until the prize is spent.
// Meanwhile it sends the transaction through Slipstream again from time to time (never through our own node, never
// to the public mempool), and when MARA mines a block without it (only MARA's blocks can hold a Slipstream
// transaction, so other miners' blocks say nothing) it signs it again at a higher fee rate with the same outputs:
// the pool's part pays the extra fee, the finder's output stays exactly as it was. Once the claim is deep enough,
// the key, the salt, the piece and the claim transaction are written down and published (GET /api/pool/finds,
// the /proof page).
//
// A restart forgets the key: the finder's browser keeps everything until the prize is spent and sends the same find
// again on its next visit, which arms the server again (the same lease and commitment: not a replay).
//
// The vault. Some keys are written down here and kept until their prize is spent, because no safe claim went out
// with them: a pool find whose browser could not reach Slipstream (the server then sends the claim itself, and the
// finder's page says to write to support), a key found on /play without a payout address or without Slipstream,
// and the home page's lucky key (nobody claiming that prize in 24 hours, the server sweeps it to the pool's address
// itself). Each is told to the owner (Telegram), never with the key. The key, and anything signed with it before it
// is spent, is sealed in its own file (vault.js, under POOL_VAULT_KEY); the table here says only that it is there.
//
// Environment: RELAY_SLIPSTREAM_URL (the relay; tests point it at a local mock), FOUND_CHECK_SECONDS (60: how often
// a pending find is looked at), FOUND_RESEND_SECONDS (600), FOUND_CONFIRMATIONS (6: the key is published once the
// claim is this deep, so no reorganisation can undo it while the key is public), LUCKY_HOURS (24).
'use strict';

const UA = 'bumblebeam-puzzle/1.0';

function createFinds(o) {
  const S = o.secp, K = o.kit, db = o.db;
  const SLIP = (process.env.RELAY_SLIPSTREAM_URL || 'https://slipstream.mara.com').replace(/\/$/, '');
  const LUCKY_S = Number(process.env.LUCKY_HOURS || 24) * 3600;
  const CHECK_S = Number(process.env.FOUND_CHECK_SECONDS || 60);
  const RESEND_S = Number(process.env.FOUND_RESEND_SECONDS || 600);
  const DEPTH = Number(process.env.FOUND_CONFIRMATIONS || 6);
  const now = o.now || (() => Math.floor(Date.now() / 1000));

  db.exec(`
    CREATE TABLE IF NOT EXISTS finds (commitment TEXT PRIMARY KEY, lease TEXT UNIQUE, puzzle INTEGER, payout TEXT, created INTEGER,
      ots TEXT, receipts TEXT, relays TEXT, txids TEXT, coins TEXT, finder_sats INTEGER, status TEXT,
      spend_txid TEXT, spend_height INTEGER, spend_time INTEGER, piece_from TEXT, piece_to TEXT, key TEXT, salt TEXT, claim_hex TEXT, bumps TEXT);
  `);
  try { db.exec('ALTER TABLE finds ADD COLUMN receipt TEXT'); } catch (_) { /* there already */ }
  // one row per puzzle address: the first key that came for it
  db.exec(`CREATE TABLE IF NOT EXISTS vault (address TEXT PRIMARY KEY, puzzle INTEGER, key TEXT, source TEXT, payout TEXT, lease TEXT,
    commitment TEXT, ots TEXT, created INTEGER, status TEXT, claim_txid TEXT, claim_hex TEXT, sent INTEGER)`);
  // a pool find in the vault also keeps what the server needs to see its claim through after a restart: the salt,
  // the signed transactions (the same txids), the coins they spend, the rate and the finder's share
  if (!db.prepare('PRAGMA table_info(vault)').all().some((c) => c.name === 'held')) db.exec('ALTER TABLE vault ADD COLUMN held TEXT');
  if (!db.prepare('PRAGMA table_info(finds)').all().some((c) => c.name === 'rest')) db.exec('ALTER TABLE finds ADD COLUMN rest TEXT');
  const V = o.vault;
  // keys an older version wrote into this table: moved into the sealed files, then wiped here (secure_delete zeroes
  // the space they took, the checkpoint empties the write-ahead log that still had them)
  const plain = db.prepare('SELECT address, key, held, claim_hex FROM vault WHERE key IS NOT NULL OR held IS NOT NULL OR claim_hex IS NOT NULL').all();
  if (plain.length) {
    for (const r of plain) V.put(r.address, Object.assign(V.get(r.address) || {}, r.key ? { key: r.key } : {}, r.held ? { held: JSON.parse(r.held) } : {}, r.claim_hex ? { claim_hex: r.claim_hex } : {}));
    db.exec('PRAGMA secure_delete = ON');
    db.prepare('UPDATE vault SET key = NULL, held = NULL, claim_hex = NULL').run();
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    console.log(`finds: ${plain.length} vault key(s) moved out of the database into sealed files`);
  }
  const notify = o.notify || (() => {});
  const receiptOf = (f) => (f && f.receipt ? JSON.parse(f.receipt) : null);
  // commitment -> { key, salt, txs: [{ relay, hex, txid }], coins, rate, sent, height }: never written anywhere
  const held = new Map();

  function short(s, n) { return String(s == null ? '' : s).slice(0, n || 300); }
  async function relayPost(url, body) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(url, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', 'user-agent': UA }, body: JSON.stringify(body) });
      const text = await r.text();
      let j = null; try { j = JSON.parse(text); } catch (_) { /* text */ }
      const err = j && j.error ? (j.error.message || j.error) : null;
      return { ok: r.ok && !err, said: short(err || (j && (j.result || j.txid || j.message)) || text || r.status), t: now() };
    } catch (e) { return { ok: false, said: short(e.name === 'AbortError' ? 'no answer in 20 s' : e.message), t: now() }; } finally { clearTimeout(t); }
  }
  async function getJson(url) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 10000);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': UA } });
      if (!r.ok) throw new Error(url + ': ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }
  function send1(t) { return relayPost(SLIP + '/api/transactions', { tx_hex: t.hex }); }
  // the fee rate for a claim built here: the market's next-block rate and Slipstream's minimum (either may be missing)
  async function rateNow() {
    let market = 0, slipMin = 0;
    try { market = Number((await o.node('/v1/fees/recommended')).fastestFee) || 0; } catch (_) { /* the floor */ }
    try { slipMin = Number((await getJson(SLIP + '/api/rates')).submit_fee_rate) || 0; } catch (_) { /* the floor */ }
    return K.chooseRate(market, slipMin);
  }
  // the address's coins as our node sees them
  async function coinsOf(addr) { return ((await o.node(`/address/${addr}/utxo`)) || []).map((x) => ({ txid: x.txid, vout: x.vout, value: x.value, confirmed: !x.status || x.status.confirmed !== false })); }

  // every transaction held for this find through its own relay; their answers are kept (and shown to the finder)
  async function sendAll(f, h) {
    h.sent = now();
    const answers = JSON.parse(f.relays || '{}');
    await Promise.all(h.txs.map(async (t) => { answers[t.relay] = Object.assign({ txid: t.txid }, await send1(t)); }));
    // the claims of coins that came later (watch): sent again with it
    await Promise.all((h.rest || []).map((t) => send1(t)));
    db.prepare('UPDATE finds SET relays = ? WHERE commitment = ?').run(JSON.stringify(answers), f.commitment);
    f.relays = JSON.stringify(answers);
  }

  // ---------- POST /api/pool/found ----------
  async function found(body) {
    const l = o.leaseRow(String(body.lease || ''));
    if (!l) return [404, { error: 'no such lease' }];
    if (!/^0x[0-9a-f]{1,64}$/i.test(String(body.key || ''))) return [400, { error: 'key: 0x and up to 64 hex digits' }];
    const key = BigInt(body.key);
    if (key < 1n || key >= S.N) return [400, { error: 'key: out of range' }];
    const addr = o.address(l.puzzle);
    if (!addr) return [503, { error: 'the puzzle addresses are not read yet' }];
    // the piece first: a cheap comparison before the costly point multiplication
    const piece = o.piece(l);
    if (key < piece.from || key > piece.to) return [422, { error: 'the key is not in this lease’s piece' }];
    if (S.hash160OfKey(key) !== S.addressToHash160(addr)) return [422, { error: 'the key does not open puzzle #' + l.puzzle + '’s address' }];
    // the key is genuine and in its piece: the piece is closed now, whatever else this request gets wrong, so it
    // is never handed out again
    o.close(l);
    if (db.prepare('SELECT 1 FROM finds WHERE puzzle = ? AND lease != ?').get(l.puzzle, l.id)) return [409, { error: 'puzzle #' + l.puzzle + '’s key was already reported from another piece' }];
    const payout = String(body.payout || '').trim();
    if (!l.addr) return [422, { error: 'this piece was searched without a payout address' }];
    if (payout !== l.addr) return [422, { error: 'the payout address is not the one this piece was searched for' }];
    const salt = String(body.salt || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(salt)) return [400, { error: 'salt: 64 hex digits' }];
    const commit = K.commitment(key, payout, salt);
    if (commit !== String(body.commitment || '').toLowerCase()) return [422, { error: 'the commitment does not match the key, the payout address and the salt' }];
    let prev = db.prepare('SELECT * FROM finds WHERE lease = ?').get(l.id);
    if (prev && prev.commitment !== commit) return [409, { error: 'this piece’s find is already recorded with another commitment: refused as a replay' }];
    if (prev && prev.status !== 'pending') {
      // spent already: what the finder sends now is published (a server that restarted had forgotten it)
      if (!prev.key) db.prepare('UPDATE finds SET key = ?, salt = ? WHERE commitment = ?').run('0x' + key.toString(16), salt, commit);
      return [200, { ok: true, already: true, find: status(l.id) }];
    }
    if (prev && held.has(commit)) return [200, { ok: true, already: true, find: status(l.id) }];

    // the .ots file, when there is one, must be for this commitment
    // (a bad one is left out, not the find: one calendar's odd answer must not stop the claim, the piece being closed
    // already; the commitment itself is checked above)
    let ots = null;
    if (body.ots) {
      try {
        const bytes = Buffer.from(String(body.ots), 'base64');
        if (bytes.length > 16384) throw new Error('too large');
        if (K.otsRead(new Uint8Array(bytes)).digest !== commit) throw new Error('it stamps another digest');
        ots = bytes.toString('base64');
      } catch (e) { console.log('finds: the .ots file sent with a find is left out: ' + e.message); }
    }
    // the puzzle's coins, as our node sees them: every input must be one of them
    let utxos;
    try { utxos = await o.node(`/address/${addr}/utxo`); } catch (e) { return [503, { error: 'the puzzle’s coins cannot be read right now: send it again in a minute' }]; }
    const coins = {};
    for (const u of utxos || []) coins[u.txid + ':' + u.vout] = u.value;
    // the prize's own coins: a claim must spend every one of them (a changed page could leave one for itself)
    const prize = (utxos || []).filter((u) => (!u.status || u.status.confirmed !== false) && u.value >= K.MIN_COIN).map((u) => u.txid + ':' + u.vout);
    // the browser's signed claim (Slipstream's; none when it could not build one: the pool builds it below)
    const txs = (Array.isArray(body.txs) ? body.txs : []).filter((t) => t && t.relay === 'slipstream');
    if (txs.length > 1) return [400, { error: 'txs: one signed transaction' }];
    const ok = [], ignored = [];
    for (const t of txs) {
      if (typeof t.hex !== 'string' || t.hex.length > 400000) return [400, { error: 'txs: hex' }];
      let c;
      // a transaction that breaks the rules is set aside, not the find: the key is genuine, so the piece is closed
      // and the pool signs the fair split itself (below)
      try {
        c = K.checkTx(t.hex, { key, coins, payout, poolPayout: o.payout || null });
        const spent = new Set(c.tx.ins.map((x) => x.txid + ':' + x.vout)), left = prize.filter((k) => !spent.has(k));
        if (left.length) throw new Error('it leaves ' + left.length + ' coin(s) of the prize unspent');
      } catch (e) { ignored.push({ relay: t.relay, why: 'refused: ' + e.message, bad: true }); continue; }
      ok.push({ relay: 'slipstream', hex: t.hex.toLowerCase(), txid: c.txid, rate: Math.round(c.fee / c.size), finder: c.finder, ins: c.tx.ins.map((x) => ({ txid: x.txid, vout: x.vout, value: coins[x.txid + ':' + x.vout] })) });
    }
    // nothing the finder sent can be used: the pool builds the split the rules promise itself, with every confirmed
    // coin, and signs it with the key it was just given (the finder's share to the lease's payout address, in full)
    let poolBuilt = false;
    if (!ok.length) {
      try {
        const rate = await rateNow();
        const u = K.spendable((utxos || []).map((x) => ({ txid: x.txid, vout: x.vout, value: x.value, confirmed: !x.status || x.status.confirmed !== false })));
        const b = K.build({ key, utxos: u, payout, poolPayout: o.payout || null, rate });
        const c = K.checkTx(b.slip.hex, { key, coins, payout, poolPayout: o.payout || null });
        ok.push({ relay: 'slipstream', hex: b.slip.hex, txid: c.txid, rate: b.slip.rate, finder: c.finder, ins: c.tx.ins.map((x) => ({ txid: x.txid, vout: x.vout, value: coins[x.txid + ':' + x.vout] })) });
        poolBuilt = true;
        console.log(`finds: ${txs.length ? 'the finder\'s transaction could not be used (' + ignored.map((x) => x.why).join('; ') + ')' : 'the finder\'s browser sent no transaction'}: the pool signed the split itself`);
      } catch (e) { return [422, { error: 'no transaction could be used and the pool could not build one: ' + e.message, ignored }]; }
    }
    // the checks above waited on the node: the same find may have been recorded meanwhile (a request sent again)
    if (!prev) prev = db.prepare('SELECT * FROM finds WHERE lease = ?').get(l.id);
    if (prev && prev.commitment !== commit) return [409, { error: 'this piece’s find is already recorded with another commitment: refused as a replay' }];
    if (prev && prev.status !== 'pending') return [200, { ok: true, already: true, find: status(l.id) }];
    const receipts = {};
    const sl = body.receipts && body.receipts.slipstream;
    if (sl) receipts.slipstream = { ok: !!sl.ok, said: short(sl.said), t: Number(sl.t) || null };
    // the browser could not hand the claim to Slipstream: the key is written down here (the vault) and the owner
    // told, while this server sends the claim itself; the finder's page says to write to support
    const relayFailed = !(sl && sl.ok);
    const first = ok[0];
    const h = { key, salt, txs: ok.map((y) => ({ relay: y.relay, hex: y.hex, txid: y.txid })), coins: first.ins, rate: first.rate, finder: first.finder, sent: 0, height: 0, poolBuilt };
    if (relayFailed) { vaultPut({ key, puzzle: l.puzzle, source: 'pool', payout, lease: l.id, commitment: commit, ots }); keepHeld(l.id, h); }
    if (prev) {
      // the same find again after a restart: armed again. A claim built anew here has another txid: it joins the
      // find's list, so its spend is counted as the pool's own
      held.set(commit, h);
      noteTxids(prev, h.txs);
      keepHeld(l.id, h);
      return [200, { ok: true, already: true, rearmed: true, find: status(l.id) }];
    }
    // the pool's receipt: signed now, before anything else is done with the key, and given back at once
    const received = now();
    const receipt = K.receiptSign(o.receiptKey, { puzzle: l.puzzle, lease: l.id, commitment: commit, payout, finder_sats: h.finder, txids: ok.map((x) => x.txid), received });
    db.prepare(`INSERT INTO finds (commitment, lease, puzzle, payout, created, ots, receipts, relays, txids, coins, finder_sats, status, piece_from, piece_to, bumps, receipt)
      VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, 'pending', ?, ?, '[]', ?)`)
      .run(commit, l.id, l.puzzle, payout, received, ots, JSON.stringify(receipts), JSON.stringify(ok.map((x) => x.txid)), JSON.stringify(h.coins), h.finder,
        '0x' + piece.from.toString(16), '0x' + piece.to.toString(16), JSON.stringify(receipt));
    held.set(commit, h);
    console.log(`finds: puzzle #${l.puzzle} found in lease ${l.id.slice(0, 8)}…, the claim checked, sending it through Slipstream`);
    if (!relayFailed) notify(`🔑 Puzzle #${l.puzzle}: a searcher found the key. The claim went out through Slipstream from the finder's browser; the server sends it again until it is mined`);
    // through the relays at once, from here too (the finder's browser has sent them already)
    const f = db.prepare('SELECT * FROM finds WHERE commitment = ?').get(commit);
    sendAll(f, h).catch((e) => console.error('finds: send', e.message));
    return [200, { ok: true, find: status(l.id), ignored, pool_built: poolBuilt }];
  }

  // ---------- what the finder's browser asks: POST /api/pool/found/status { lease } ----------
  // (in the body, not the address: the lease id is the finder's alone and would end up in every proxy's log)
  function status(lease) {
    const f = db.prepare('SELECT * FROM finds WHERE lease = ?').get(String(lease || ''));
    if (!f) return { recorded: false };
    return {
      recorded: true, puzzle: f.puzzle, payout: f.payout, commitment: f.commitment, created: f.created, status: f.status,
      txids: JSON.parse(f.txids), relays: JSON.parse(f.relays || '{}'), held: held.has(f.commitment),
      spend: f.spend_txid ? { txid: f.spend_txid, height: f.spend_height, time: f.spend_time } : null,
      finder_sats: f.finder_sats, published: !!f.key, receipt: receiptOf(f),
      vault: !!db.prepare('SELECT 1 FROM vault WHERE lease = ?').get(f.lease),
      // when the pool signed the split itself, the finder's page gets its transactions to check them (the lease id is
      // known to the finder alone)
      pool_txs: held.has(f.commitment) && held.get(f.commitment).poolBuilt ? held.get(f.commitment).txs : null,
    };
  }

  // ---------- public: GET /api/pool/finds ----------
  // Before the spend only what gives nothing away: the puzzle, the payout address, the commitment and its .ots
  // (no piece, no transaction: the piece would let anyone search it in minutes). After it, everything.
  function list() {
    return {
      finds: db.prepare('SELECT * FROM finds ORDER BY created DESC').all().map((f) => {
        const pub = { id: f.commitment, puzzle: f.puzzle, address: o.address(f.puzzle), payout: f.payout, commitment: f.commitment, created: f.created, status: f.status, ots: f.ots || null };
        if (f.status === 'pending') return pub;
        return Object.assign(pub, {
          key: f.key || null, salt: f.salt || null, piece: { from: f.piece_from, to: f.piece_to }, coins: JSON.parse(f.coins), finder_sats: f.finder_sats,
          txids: JSON.parse(f.txids), bumps: JSON.parse(f.bumps || '[]'), receipts: JSON.parse(f.receipts || '{}'), relays: JSON.parse(f.relays || '{}'),
          spend: { txid: f.spend_txid, height: f.spend_height, time: f.spend_time }, claim_hex: f.claim_hex || null,
          receipt: receiptOf(f),
        });
      }),
    };
  }

  // ---------- the vault: keys written down for good ----------
  // the first key for a puzzle's address stays; the owner is told which puzzle, where it came from and what to do,
  // never the key
  const WHY = { pool: 'a pool searcher\'s browser could not reach Slipstream: the server sends the claim itself; the finder was told to write to support',
    play: 'found on /play by a browser that could not send the claim itself: the finder was told to write to support',
    lucky: 'the home page\'s lucky key: if its prize is not claimed in ' + Math.round(LUCKY_S / 3600) + ' hours, the server sweeps it to the pool' };
  function vaultPut(v) {
    const addr = o.address(v.puzzle);
    if (!db.prepare('SELECT 1 FROM vault WHERE address = ?').get(addr)) {
      // the sealed key first, then the row that says it is there (a crash between leaves a file the next key for
      // this address writes over)
      V.put(addr, { key: '0x' + BigInt(v.key).toString(16) });
      db.prepare("INSERT INTO vault (address, puzzle, source, payout, lease, commitment, ots, created, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'held')")
        .run(addr, v.puzzle, v.source, v.payout || null, v.lease || null, v.commitment || null, v.ots || null, now());
      console.log(`finds: puzzle #${v.puzzle}'s key is in the vault (${v.source})`);
      notify(`🔐 Puzzle #${v.puzzle}: a key is in the vault (${WHY[v.source] || v.source})${v.payout ? '. Payout address: ' + v.payout : ''}`);
    }
    return db.prepare('SELECT * FROM vault WHERE address = ?').get(addr);
  }
  // POST /api/pool/solo { key, puzzle, source: 'play' | 'lucky', payout?, salt?, commitment?, ots? }: a key found
  // outside the pool's pieces. Only a key that opens a puzzle's address with coins on it is taken (nothing else can
  // be sent here, so it needs no other limit); the answer is the pool's signed receipt
  async function solo(body) {
    const puzzle = Number(body.puzzle), source = body.source === 'lucky' ? 'lucky' : 'play';
    if (!(puzzle >= 1 && puzzle <= 160) || !o.address(puzzle)) return [400, { error: 'puzzle: 1 to 160' }];
    if (!/^0x[0-9a-f]{1,64}$/i.test(String(body.key || ''))) return [400, { error: 'key: 0x and up to 64 hex digits' }];
    const key = BigInt(body.key);
    // a puzzle's key lies in its range: anything else is refused before the costly point multiplication
    if (key < 1n << BigInt(puzzle - 1) || key >= 1n << BigInt(puzzle) || S.hash160OfKey(key) !== S.addressToHash160(o.address(puzzle))) return [422, { error: 'the key does not open puzzle #' + puzzle + '’s address' }];
    let coins;
    try { coins = await coinsOf(o.address(puzzle)); } catch (_) { return [503, { error: 'the puzzle’s coins cannot be read right now: send it again in a minute' }]; }
    if (!coins.some((c) => c.value >= K.MIN_COIN)) return [409, { error: 'puzzle #' + puzzle + '’s prize is spent already' }];
    const payout = body.payout && o.isAddress(String(body.payout)) ? String(body.payout) : null;
    let commitment = null, ots = null;
    if (body.commitment && /^[0-9a-f]{64}$/.test(String(body.salt || ''))) {
      if (K.commitment(key, payout || '', String(body.salt)) !== String(body.commitment)) return [422, { error: 'the commitment does not match the key, the address and the salt' }];
      commitment = String(body.commitment);
      try { if (body.ots && K.otsRead(new Uint8Array(Buffer.from(String(body.ots), 'base64'))).digest === commitment) ots = String(body.ots); } catch (_) { /* no .ots */ }
    }
    const v = vaultPut({ key, puzzle, source, payout, commitment, ots });
    const receipt = K.receiptSign(o.receiptKey, { puzzle, lease: source, commitment: v.commitment || '', payout: v.payout || '', finder_sats: 0, txids: [], received: v.created });
    return [200, { ok: true, kept: v.created, first: V.get(v.address).key === '0x' + key.toString(16), receipt }];
  }
  // a lucky key nobody claimed in LUCKY_S: the whole prize to the pool's address, through Slipstream, sent again
  // until it is mined; any vault key whose coins are gone is marked spent
  async function vaultTick(v) {
    // spent: no coin of the prize left (the dust anyone sends to a puzzle address does not count)
    const coins = (await coinsOf(v.address)).filter((c) => c.value >= K.MIN_COIN);
    if (!coins.length) { db.prepare("UPDATE vault SET status = 'spent' WHERE address = ?").run(v.address); console.log(`finds: puzzle #${v.puzzle}'s vault key: its prize is spent`); return; }
    if (v.source !== 'lucky' || now() - v.created < LUCKY_S || !o.payout) return;
    const sec = V.get(v.address);
    if (!sec || !sec.key) { console.error(`finds: puzzle #${v.puzzle}'s vault row has no sealed key`); return; }
    // the sweep, as a pool find's claim: sent again every RESEND_S, signed again at a higher rate when MARA mines a
    // block without it (the watch's state per address lives in memory: after a restart it starts looking afresh)
    const w = sweeps.get(v.address) || { height: 0, rate: 0 };
    sweeps.set(v.address, w);
    let hex = sec.claim_hex;
    const higher = hex && w.rate && (await maraMissed(w));
    if (!hex || higher) {
      let rate = await rateNow();
      if (higher) rate = Math.min(K.MAX_RATE, Math.max(rate, Math.ceil(w.rate * 1.5)));
      const b = K.build({ key: BigInt(sec.key), utxos: K.spendable(coins), payout: o.payout, poolPayout: null, rate });
      if (!hex) notify(`🔐 Puzzle #${v.puzzle}: nobody claimed the lucky key's prize in ${Math.round(LUCKY_S / 3600)} hours: swept to the pool through Slipstream (${b.slip.txid})`);
      else console.log(`finds: puzzle #${v.puzzle}'s lucky key: MARA mined a block without the sweep, signed again at ${rate} sat/vB`);
      hex = b.slip.hex; w.rate = rate;
      V.update(v.address, { claim_hex: hex });
      db.prepare('UPDATE vault SET claim_txid = ?, sent = 0 WHERE address = ?').run(b.slip.txid, v.address);
    } else if (!w.rate) {
      // after a restart: the rate the kept sweep pays
      try { const c = K.checkTx(hex, { key: BigInt(sec.key), coins: Object.fromEntries(coins.map((x) => [x.txid + ':' + x.vout, x.value])), payout: o.payout, poolPayout: null }); w.rate = Math.round(c.fee / c.size); } catch (_) { w.rate = 10; }
    }
    if (v.status === 'sent' && v.sent && now() - v.sent < RESEND_S && !higher) return;
    const a = await send1({ hex });
    db.prepare("UPDATE vault SET status = 'sent', sent = ? WHERE address = ?").run(now(), v.address);
    console.log(`finds: puzzle #${v.puzzle}'s lucky key: the sweep to the pool ${a.ok ? 'went to' : 'was refused by'} Slipstream: ${a.said}`);
  }
  const sweeps = new Map(); // address -> { height, rate }: a lucky sweep's watch

  // a find's txids grow with every claim it sent (fee bumps, a claim built anew, the claims of later coins)
  function noteTxids(f, txs) {
    const known = JSON.parse(f.txids || '[]'), add = txs.map((t) => t.txid).filter((t) => !known.includes(t));
    if (!add.length) return;
    f.txids = JSON.stringify(known.concat(add));
    db.prepare('UPDATE finds SET txids = ? WHERE commitment = ?').run(f.txids, f.commitment);
  }
  // what a vaulted pool find needs after a restart, sealed beside its key (the signed claims show the public key)
  function keepHeld(lease, h) {
    const r = db.prepare('SELECT address FROM vault WHERE lease = ?').get(lease);
    if (r) V.update(r.address, { held: { salt: h.salt, txs: h.txs, rest: h.rest || [], coins: h.coins, rate: h.rate, finder: h.finder, poolBuilt: !!h.poolBuilt } });
  }
  // after a restart: a pending find whose key is in the vault is armed again from there, with the same signed
  // transactions, and the server sees its claim through as before (without the vault, the finder's browser arms it
  // again when it comes back)
  function rearm(f) {
    const v = db.prepare('SELECT address FROM vault WHERE lease = ?').get(f.lease);
    const sec = v && V.get(v.address);
    if (!sec || !sec.key || !sec.held) return null;
    const k = sec.held;
    const h = { key: BigInt(sec.key), salt: k.salt, txs: k.txs, rest: k.rest || [], coins: k.coins, rate: k.rate, finder: k.finder, poolBuilt: k.poolBuilt, sent: 0, height: 0 };
    held.set(f.commitment, h);
    noteTxids(f, h.txs);
    console.log(`finds: puzzle #${f.puzzle}'s find armed again from the vault after a restart`);
    return h;
  }
  // Coins of the prize the claim does not spend (one that came after the claim was built): swept at once, as soon
  // as they are seen. The first claim mined shows the public key, and a 70-bit key falls to anyone within minutes
  // after that. The finder gets what the rules give on the new total less what the first claim paid, the pool the
  // rest; the fee out of the pool's part
  async function sweepRest(f, h) {
    const taken = new Set(h.coins.map((x) => x.txid + ':' + x.vout).concat(...(h.rest || []).map((t) => t.coins.map((x) => x.txid + ':' + x.vout))));
    const left = (await coinsOf(o.address(f.puzzle))).filter((c) => c.confirmed && c.value >= K.MIN_COIN && !taken.has(c.txid + ':' + c.vout));
    if (!left.length) return false;
    const T = o.tx, before = h.coins.reduce((a, x) => a + x.value, 0) + (h.rest || []).reduce((a, t) => a + t.total, 0);
    const paid = h.finder + (h.rest || []).reduce((a, t) => a + t.finder, 0);
    const total = left.reduce((a, x) => a + x.value, 0), extra = Math.max(0, K.finderShare(before + total) - paid);
    const rate = await rateNow();
    const probe = extra >= K.DUST ? [{ address: f.payout, value: extra }, { address: o.payout, value: 0 }] : [{ address: o.payout, value: 0 }];
    const fee = Math.ceil(T.sweepSize(left.length, probe) * rate);
    const outs = extra >= K.DUST ? [{ address: f.payout, value: extra }, { address: o.payout, value: total - extra - fee }] : [{ address: o.payout, value: total - fee }];
    if (outs[outs.length - 1].value < K.DUST || fee > total * K.MAX_FEE_SHARE + 100000) { console.error(`finds: puzzle #${f.puzzle}: a later coin of ${total} sat is too small to sweep at ${rate} sat/vB`); return false; }
    const t = T.sweep(h.key, left, outs);
    h.rest = (h.rest || []).concat([{ relay: 'slipstream', hex: t.hex, txid: t.txid, coins: left.map((x) => ({ txid: x.txid, vout: x.vout, value: x.value })), total, finder: extra >= K.DUST ? extra : 0 }]);
    noteTxids(f, [{ txid: t.txid }]);
    db.prepare('UPDATE finds SET rest = ? WHERE commitment = ?').run(JSON.stringify(h.rest.map((x) => ({ txid: x.txid, coins: x.coins, finder: x.finder }))), f.commitment);
    keepHeld(f.lease, h);
    const a = await send1({ hex: t.hex });
    console.log(`finds: puzzle #${f.puzzle}: ${left.length} more coin(s) of the prize (${total} sat) swept, ${extra >= K.DUST ? extra + ' sat to the finder' : 'all to the pool'}: Slipstream ${a.ok ? 'took it' : 'said ' + a.said}`);
    notify(`🔑 Puzzle #${f.puzzle}: a later coin of the prize (${total} sat) swept through Slipstream (${t.txid})`);
    return true;
  }

  // ---------- the watch: spent yet? if not, send again, and in a while sign again at a higher rate ----------
  // The key is published only when the claim is DEPTH blocks deep and every coin it spends is spent: a block can
  // be undone by a reorganisation, and with the key public anyone could then take the coins back out of the claim.
  async function watch(f) {
    const coins = JSON.parse(f.coins), c = coins[0], h = held.get(f.commitment) || rearm(f);
    // a coin of the prize that is not in the claim: swept at once (needs the key: in memory or in the vault)
    if (h) await sweepRest(f, h);
    const os = await o.node(`/tx/${c.txid}/outspend/${c.vout}`);
    if (os && os.spent && os.status && os.status.confirmed) {
      const tip = Number(await o.node('/blocks/tip/height'));
      const depth = os.status.block_height ? tip - os.status.block_height + 1 : 0;
      if (depth < DEPTH) { if (h && h.rest && h.rest.length && now() - h.sent >= RESEND_S) await sendAll(f, h); return; } // mined, not deep enough yet
      for (const x of coins.slice(1).concat(...((h && h.rest) || []).map((t) => t.coins))) {
        const o2 = await o.node(`/tx/${x.txid}/outspend/${x.vout}`);
        if (!(o2 && o2.spent && o2.status && o2.status.confirmed)) { if (h && now() - h.sent >= RESEND_S) await sendAll(f, h); return; } // a coin of the claim not spent yet
      }
      // and never while a coin of the prize is still on the address: the key would hand it to anyone
      if ((await coinsOf(o.address(f.puzzle))).some((x) => x.value >= K.MIN_COIN)) { console.log(`finds: puzzle #${f.puzzle}: a coin of the prize is still on the address, the key is not published`); return; }
      return publish(f, os, h);
    }
    if (!h) return;
    if (await maraMissed(h)) return bump(f, h);
    if (now() - h.sent >= RESEND_S) return sendAll(f, h);
  }
  // Only MARA's blocks can hold a Slipstream transaction: a block by anyone else says nothing about the fee. A block
  // MARA mined without the claim does: its fee was too low for MARA then. Read by the coinbase's tag ("MARA Made in
  // USA"); h.height is the last block looked at (none before the first look)
  async function maraMissed(h) {
    const tip = Number(await o.node('/blocks/tip/height'));
    if (!h.height) { h.height = tip; return false; }
    let missed = false;
    for (let n = h.height + 1; n <= tip && n <= h.height + 12; n++) {
      try {
        const hash = String(await o.node(`/block-height/${n}`)).trim();
        const cb = (await o.node(`/block/${hash}/txs/0`))[0];
        if (/MARA/.test(Buffer.from((cb.vin[0] && cb.vin[0].scriptsig) || '', 'hex').toString('latin1'))) missed = true;
      } catch (_) { return missed; } // the rest on the next round
      h.height = n;
    }
    return missed;
  }
  async function publish(f, os, h) {
    const txids = JSON.parse(f.txids), ours = txids.includes(os.txid);
    let hex = null;
    const mine = h && h.txs.concat(h.old || []).find((t) => t.txid === os.txid);
    if (mine) hex = mine.hex;
    else { try { hex = String(await o.node(`/tx/${os.txid}/hex`)).trim(); } catch (_) { /* later, by hand */ } }
    db.prepare('UPDATE finds SET status = ?, spend_txid = ?, spend_height = ?, spend_time = ?, claim_hex = ?, key = ?, salt = ? WHERE commitment = ?')
      .run(ours ? 'claimed' : 'taken', os.txid, os.status.block_height || null, os.status.block_time || null, hex,
        h ? '0x' + h.key.toString(16) : null, h ? h.salt : null, f.commitment);
    held.delete(f.commitment);
    console.log(`finds: puzzle #${f.puzzle}'s coins are spent in ${os.txid} (${ours ? 'our claim' : 'NOT one of ours'}): the key is published`);
  }
  async function bump(f, h) {
    let min = 0, market = 0;
    try { min = Number((await getJson(SLIP + '/api/rates')).submit_fee_rate) || 0; } catch (_) { /* the old minimum */ }
    try { market = Number((await o.node('/v1/fees/recommended')).fastestFee) || 0; } catch (_) { /* half again */ }
    // half again, or the market's next-block rate if that is higher, never under Slipstream's minimum
    const rate = Math.min(K.MAX_RATE, Math.max(Math.ceil(h.rate * 1.5), Math.ceil(min), Math.ceil(market)));
    if (rate <= h.rate) return sendAll(f, h); // at the cap already: the same one again
    let b;
    try {
      b = K.bump({ outs: [{ role: 'you', address: f.payout, value: h.finder }] }, { key: h.key, utxos: h.coins, payout: f.payout, poolPayout: o.payout || null, rate });
    } catch (e) { console.error('finds: no fee bump:', e.message); return sendAll(f, h); }
    h.old = (h.old || []).concat(h.txs);
    h.txs = [{ relay: 'slipstream', hex: b.slip.hex, txid: b.slip.txid }];
    keepHeld(f.lease, h);
    h.rate = rate;
    const txids = JSON.parse(f.txids).concat(h.txs.map((t) => t.txid)), bumps = JSON.parse(f.bumps || '[]').concat([{ t: now(), rate, txids: h.txs.map((t) => t.txid) }]);
    db.prepare('UPDATE finds SET txids = ?, bumps = ? WHERE commitment = ?').run(JSON.stringify(txids), JSON.stringify(bumps), f.commitment);
    f.txids = JSON.stringify(txids); f.bumps = JSON.stringify(bumps);
    console.log(`finds: puzzle #${f.puzzle}: MARA mined a block without the claim, signed again at ${rate} sat/vB (the finder's output unchanged)`);
    return sendAll(f, h);
  }
  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      for (const f of db.prepare("SELECT * FROM finds WHERE status = 'pending'").all()) {
        try { await watch(f); } catch (e) { console.error('finds: watch', e.message); }
      }
      for (const v of db.prepare("SELECT * FROM vault WHERE status IN ('held', 'sent')").all()) {
        try { await vaultTick(v); } catch (e) { console.error('finds: vault', e.message); }
      }
    } finally { ticking = false; }
  }
  setInterval(tick, CHECK_S * 1000).unref();

  // at most 10 keys a minute from one client (each costs a point multiplication)
  const soloSeen = new Map();
  function limitedSolo(req) {
    const k = String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || ''), t = Date.now();
    const list = (soloSeen.get(k) || []).filter((x) => t - x < 60000); list.push(t); soloSeen.set(k, list);
    if (soloSeen.size > 10000) soloSeen.clear();
    return list.length > 10;
  }
  // one find of a lease at a time: a browser that gave up waiting sends the same find again while the first request
  // still runs; the second waits for the first, then sees it recorded
  const inflight = new Map();
  async function once(body) {
    const k = String(body.lease || '');
    while (inflight.has(k)) await inflight.get(k).catch(() => {});
    const p = found(body);
    inflight.set(k, p);
    try { return await p; } finally { if (inflight.get(k) === p) inflight.delete(k); }
  }

  // the pool's pause after a find: since when (null when no find of this puzzle waits for its claim)
  function pendingSince(puzzle) { const r = db.prepare("SELECT created FROM finds WHERE puzzle = ? AND status = 'pending' ORDER BY created LIMIT 1").get(puzzle); return r ? r.created : null; }
  function pending(puzzle) { return !!db.prepare("SELECT 1 FROM finds WHERE puzzle = ? AND status = 'pending'").get(puzzle); }

  // ---------- HTTP ----------
  // A find, a key for the vault and the finder's view come sealed for the transport key (web/engine/seal.js): a key
  // or a signed claim never crosses Cloudflare or a log readable. A plain body is refused before it is read further;
  // the answer goes back sealed, a refusal plain
  async function sealed(req, res, p, max, send, readJson, run) {
    const raw = await readJson(req, max);
    if (!raw) { send(res, 400, { error: 'JSON body' }); return; }
    let x;
    try { x = await o.transport.seal.open(await o.transport.key, p, raw); } catch (_) { send(res, 400, { error: 'a sealed body is required (web/engine/seal.js)' }); return; }
    if (!x.body || typeof x.body !== 'object') { send(res, 400, { error: 'JSON body' }); return; }
    const r = await run(x.body);
    send(res, r[0], r[0] === 200 ? await x.reply(r[1]) : r[1]);
  }
  async function handle(req, res, url, send, readJson) {
    const p = url.pathname;
    if (req.method === 'POST' && p === '/api/pool/found') { await sealed(req, res, p, 3 << 19, send, readJson, once); return true; }
    if (req.method === 'POST' && p === '/api/pool/solo') {
      if (limitedSolo(req)) { send(res, 429, { error: 'too many requests, please slow down' }); return true; }
      await sealed(req, res, p, 98304, send, readJson, solo);
      return true;
    }
    if (req.method === 'POST' && p === '/api/pool/found/status') { await sealed(req, res, p, 16384, send, readJson, async (b) => [200, status(b.lease)]); return true; }
    if (req.method === 'GET' && p === '/api/pool/finds') { send(res, 200, list(), 30); return true; }
    let m;
    if (req.method === 'GET' && (m = p.match(/^\/api\/pool\/finds\/([0-9a-f]{64})\.ots$/))) {
      const f = db.prepare('SELECT ots FROM finds WHERE commitment = ?').get(m[1]);
      if (!f || !f.ots) { send(res, 404, { error: 'no .ots file for this commitment' }); return true; }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="puzzle-find-${m[1].slice(0, 12)}.ots"`, 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' });
      res.end(Buffer.from(f.ots, 'base64'));
      return true;
    }
    return false;
  }

  return { handle, found: once, solo, status, list, tick, pending, pendingSince, vaultPut, _held: held, _vault: V };
}

module.exports = { createFinds };
