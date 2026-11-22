/* The claim's rules, one copy for the browser (the find, the manual claim, /proof's Verify) and the server
   (api/finds.js), so both build and check the same thing:
   - the split: the finder gets the coins' whole bitcoins but one (6 of 7.1 BTC on #71), the pool the rest; the
     fees come out of the pool's part, so a higher fee never makes the finder's output smaller;
   - building the sweep for MARA Slipstream (a normal miner fee) and building it again at a higher fee rate with the
     same outputs;
   - checking a signed sweep: it spends only the puzzle's coins, every signature verifies, and it pays nobody but
     the finder and the pool, the finder the share;
   - the commitment sha256(key ‖ payout address as UTF-8 ‖ salt) and the OpenTimestamps file for it.
   Pure: nothing here talks to the network. A classic script; needs BBSecp and BBTx. Exposes BBKit. */
(function (root) {
  'use strict';
  var S = root.BBSecp, T = root.BBTx;
  var DUST = 546, MAX_RATE = 2000, MAX_FEE_SHARE = 0.003, MAX_VSIZE = 99000, INPUT_VB = 148;
  // the smallest coin a claim spends: the prize's own coins (6.39, 0.639 and 0.071 BTC on #71), never the dust
  // anyone can send to the address (each such coin would only make the claim bigger and dearer, and hundreds of them
  // could push its fee past the cap); a coin left behind is worth less than the fee it would cost
  var MIN_COIN = 100000;

  function btc(sats) { return (sats / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, ''); }
  function hex32(key) { return BigInt(key).toString(16).padStart(64, '0'); }

  // ---------- the split ----------
  function finderShare(total) { return Math.max(0, Math.floor(total / 1e8) - 1) * 1e8; }
  // outputs for a total and a fee; with no pool address (or too little left for it) the finder takes the rest
  function split(total, fee, payout, poolPayout) {
    var finder = finderShare(total);
    var pool = total - finder - fee;
    var outs = [];
    if (poolPayout && pool >= DUST) outs.push({ address: payout, value: finder, role: 'you' }, { address: poolPayout, value: pool, role: 'the pool' });
    else outs.push({ address: payout, value: total - fee, role: 'you' });
    return outs;
  }
  // the outputs must be whole satoshis above dust, add up with the fee to the total, give the finder the full
  // share (or everything but the fees when there is no pool part), and the fees must stay small
  function check(outs, total, fee, payout) {
    var sum = 0, mine = 0;
    outs.forEach(function (o) {
      if (!Number.isSafeInteger(o.value) || o.value < DUST) throw new Error('an output of ' + o.value + ' sat to ' + o.address + ' is not valid');
      sum += o.value;
      if (o.address === payout && o.role === 'you') mine += o.value;
    });
    if (!Number.isSafeInteger(fee) || fee < 0 || sum + fee !== total) throw new Error('outputs and fee do not add up to the coins spent');
    if (fee > total * MAX_FEE_SHARE) throw new Error('the fees (' + btc(fee) + ' BTC) are more than ' + (MAX_FEE_SHARE * 100) + '% of the prize: refused');
    if (mine < Math.min(finderShare(total), total - fee)) throw new Error('the output of the finder is smaller than the share: refused');
  }

  // ---------- building ----------
  // the prize's own coins: every confirmed coin of at least MIN_COIN, the largest first, at most 20 (if the address
  // held no such coin, its largest ones)
  function spendable(utxos) {
    var u = utxos.filter(function (x) { return x.confirmed !== false; });
    u.sort(function (a, b) { return b.value - a.value || (a.txid + a.vout < b.txid + b.vout ? -1 : 1); });
    var big = u.filter(function (x) { return x.value >= MIN_COIN; });
    return (big.length ? big : u).slice(0, 20);
  }
  // the fee rate, chosen without asking anyone: at least the market's next-block rate and the relay's minimum,
  // never under FLOOR (a find is worth a few thousand satoshis of fee), never above MAX_RATE
  var FLOOR = 10;
  function chooseRate(market, relayMin) {
    var r = Math.max(FLOOR, Math.ceil(Number(market) || 0), Math.ceil(Number(relayMin) || 0));
    if (r > MAX_RATE) throw new Error('the relay asks for ' + r + ' sat/vB, more than the most we pay (' + MAX_RATE + ')');
    return r;
  }
  // o: { key, utxos, payout, poolPayout, rate }
  // returns { slip: { hex, txid, size, outs, fee, rate, relay, total } }
  function build(o) {
    var u = o.utxos, rate = Math.ceil(o.rate);
    if (!u.length) throw new Error('no coins to spend');
    if (!(rate >= 1 && rate <= MAX_RATE)) throw new Error('a fee rate of ' + rate + ' sat/vB is outside 1 to ' + MAX_RATE);
    if (!T.isAddress(o.payout)) throw new Error('the payout address is not a Bitcoin mainnet address');
    var total = u.reduce(function (s, x) { return s + x.value; }, 0);
    var probe = split(total, 0, o.payout, o.poolPayout);
    var fee = Math.ceil(T.sweepSize(u.length, probe) * rate);
    var slipOuts = split(total, fee, o.payout, o.poolPayout);
    check(slipOuts, total, fee, o.payout);
    var slip = T.sweep(o.key, u, slipOuts);
    Object.assign(slip, { outs: slipOuts, fee: fee, rate: rate, relay: 'slipstream', total: total });
    if (slip.size > MAX_VSIZE) throw new Error('the transaction would be too large');
    return { slip: slip };
  }
  // the same coins and outputs at a higher rate: the pool's output pays the extra fee, the finder's stays exactly
  // as it was (refused otherwise). prev: the transaction it replaces (its outs); o as for build()
  function bump(prev, o) {
    var b = build(o), was = prev.outs.filter(function (x) { return x.role === 'you'; })[0];
    [b.slip].forEach(function (t) {
      var now = t.outs.filter(function (x) { return x.role === 'you'; })[0];
      if (!was || !now || now.address !== was.address || now.value < was.value) throw new Error('a higher fee would shrink the output of the finder: refused');
    });
    return b;
  }

  // ---------- checking a signed sweep (the server's and /proof's view) ----------
  // ctx: { key (or point P), coins: { 'txid:vout': value }, payout, poolPayout }
  // returns { txid, total, fee, finder, pool, size } or throws why it is refused
  function checkTx(hex, ctx) {
    var tx = T.parse(hex), P = ctx.P || S.mulG(BigInt(ctx.key));
    if (tx.size > MAX_VSIZE) throw new Error('it is larger than a standard transaction');
    // the form our sweeps have, and nothing that could hold it back: version 2, no lock time, every input final but
    // replaceable (0xfffffffd, so a fee bump can replace it)
    if (tx.version !== 2) throw new Error('version ' + tx.version + ': a claim is version 2');
    if (tx.lock !== 0) throw new Error('a lock time of ' + tx.lock + ': a claim is sent to be mined at once');
    tx.ins.forEach(function (x) { if (x.seq !== 0xfffffffd) throw new Error('an input with sequence ' + x.seq.toString(16) + ': the inputs of a claim are 0xfffffffd'); });
    var seen = {}, total = 0;
    tx.ins.forEach(function (x) {
      var id = x.txid + ':' + x.vout;
      if (seen[id]) throw new Error('it spends ' + id + ' twice');
      seen[id] = 1;
      if (!(id in ctx.coins)) throw new Error('it spends ' + id + ', which is not one of the coins of the puzzle');
      total += ctx.coins[id];
    });
    T.verifySweep(tx, P);
    var role = {}, mine = 0, pool = 0, sum = 0;
    function mark(addr, r) { if (addr) role[S.toHex(T.addressScript(addr).script)] = role[S.toHex(T.addressScript(addr).script)] || r; }
    mark(ctx.payout, 'finder'); mark(ctx.poolPayout, 'pool');
    tx.outs.forEach(function (o) {
      var r = role[S.toHex(o.script)];
      if (!r) throw new Error('it pays someone who is neither the finder nor the pool');
      if (o.value < DUST) throw new Error('an output below dust');
      sum += o.value;
      if (r === 'finder') mine += o.value; else pool += o.value;
    });
    var fee = total - sum;
    if (fee < 0) throw new Error('it pays out more than the coins hold');
    if (fee > total * MAX_FEE_SHARE) throw new Error('its fees are more than ' + (MAX_FEE_SHARE * 100) + '% of the prize');
    if (mine < Math.min(finderShare(total), total - fee)) throw new Error('it pays the finder ' + btc(mine) + ' BTC, less than the share of ' + btc(finderShare(total)) + ' BTC');
    // and the pool its part: everything that is not the finder's share or the fees (a changed page could pay the
    // finder everything and the pool nothing)
    var poolWant = total - finderShare(total) - fee;
    if (ctx.poolPayout && poolWant >= DUST && pool < poolWant) throw new Error('it pays the pool ' + btc(pool) + ' BTC, less than its part of ' + btc(poolWant) + ' BTC');
    return { txid: tx.txid, total: total, fee: fee, finder: mine, pool: pool, size: tx.size, tx: tx };
  }

  // ---------- a coin's amount, proven ----------
  // The amount of output `vout` of the transaction `hex`, which must hash to `txid`: a coin's txid is the hash of the
  // transaction that made it, so an explorer cannot change the amount without the hash failing. A puzzle sweep's
  // signatures do not cover the amounts, so a coin given as smaller than it is would hand the difference to the
  // miner; read this way, no source has to be trusted for it. Legacy and segwit transactions (the txid leaves the
  // witness out).
  function outValue(hex, txid, vout) {
    if (typeof hex !== 'string' || !/^([0-9a-f]{2})+$/i.test(hex)) throw new Error('not a transaction in hex');
    var b = S.fromHex(hex.toLowerCase()), p = 0;
    function take(n) { if (p + n > b.length) throw new Error('the transaction is cut short'); p += n; return b.subarray(p - n, p); }
    function u(n) { var x = take(n), v = 0; for (var i = n - 1; i >= 0; i--) v = v * 256 + x[i]; return v; }
    function vi() { var f = u(1); return f < 0xfd ? f : f === 0xfd ? u(2) : f === 0xfe ? u(4) : u(8); }
    take(4);
    var seg = b[p] === 0 && b[p + 1] === 1;
    if (seg) p += 2;
    var body = p, nIn = vi(), i, values = [], scripts = [];
    if (!nIn || nIn > 100000) throw new Error('no inputs');
    for (i = 0; i < nIn; i++) { take(36); take(vi()); take(4); }
    var nOut = vi();
    if (!nOut || nOut > 100000) throw new Error('no outputs');
    for (i = 0; i < nOut; i++) { values.push(u(8)); scripts.push(S.toHex(take(vi()))); }
    var bodyEnd = p;
    if (seg) for (i = 0; i < nIn; i++) { var k = vi(); for (var j = 0; j < k; j++) take(vi()); }
    var lock = p;
    take(4);
    if (p !== b.length) throw new Error('bytes after the end of the transaction');
    var plain = new Uint8Array(4 + (bodyEnd - body) + 4);
    plain.set(b.subarray(0, 4)); plain.set(b.subarray(body, bodyEnd), 4); plain.set(b.subarray(lock, lock + 4), 4 + bodyEnd - body);
    var id = S.toHex(Uint8Array.from(S.sha256(S.sha256(plain))).reverse());
    if (id !== String(txid).toLowerCase()) throw new Error('the transaction given for ' + String(txid).slice(0, 12) + '… hashes to something else');
    if (!(vout >= 0 && vout < values.length)) throw new Error('that transaction has no output ' + vout);
    // the output must pay the address it is said to be on (opts.script, hex): a real coin of someone else's address
    // would make a claim that no miner takes
    if (outValue.script !== undefined && scripts[vout] !== outValue.script) throw new Error('that output is not on the address of the puzzle');
    return values[vout];
  }
  // the same, also checking the output's script: outOn(hex, txid, vout, address)
  function outOn(hex, txid, vout, address) {
    outValue.script = S.toHex(T.addressScript(address).script);
    try { return outValue(hex, txid, vout); } finally { outValue.script = undefined; }
  }

  // ---------- the commitment ----------
  // the bytes committed to: the key (32 bytes, big-endian), the payout address as UTF-8, the salt (32 bytes)
  function preimage(key, payout, salt) {
    var a = S.fromHex(hex32(key)), b = new TextEncoder().encode(String(payout)), c = typeof salt === 'string' ? S.fromHex(salt) : salt;
    if (c.length !== 32) throw new Error('the salt must be 32 bytes');
    var o = new Uint8Array(a.length + b.length + c.length);
    o.set(a); o.set(b, a.length); o.set(c, a.length + b.length);
    return o;
  }
  function commitment(key, payout, salt) { return S.toHex(S.sha256(preimage(key, payout, salt))); }

  // ---------- OpenTimestamps ----------
  // A calendar answers POST /digest with a timestamp: the operations from our digest to its pending attestation.
  // The .ots file is the standard one: the magic header, version 1, the file's hash operation (sha256), the digest,
  // then the timestamps of every calendar merged into one tree (a fork marked 0xff before every branch but the
  // last). The "file" it stamps is the committed bytes themselves: sha256 of them is the commitment.
  var MAGIC = [0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00, 0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94];
  var PENDING = '83dfe30d2ef90c8e', BITCOIN = '0588960d73d71901';
  var UNARY = { 0x08: 'sha256', 0x02: 'sha1', 0x03: 'ripemd160', 0x67: 'keccak256', 0xf2: 'reverse', 0xf3: 'hexlify' };
  function reader(b) {
    var p = 0;
    var r = {
      byte: function () { if (p >= b.length) throw new Error('the timestamp is cut short'); return b[p++]; },
      bytes: function (n) { if (p + n > b.length) throw new Error('the timestamp is cut short'); var x = b.slice(p, p + n); p += n; return x; },
      uint: function () { var v = 0, s = 1, c; do { c = r.byte(); v += (c & 0x7f) * s; s *= 128; } while (c & 0x80); return v; },
      varbytes: function () { var n = r.uint(); if (n > 8192) throw new Error('a field too long'); return r.bytes(n); },
      end: function () { return p >= b.length; },
    };
    return r;
  }
  function uint(n) { var o = []; do { var c = n % 128; n = Math.floor(n / 128); o.push(n ? c | 0x80 : c); } while (n); return o; }
  function varbytes(b) { return uint(b.length).concat(Array.prototype.slice.call(b)); }
  // a timestamp as a tree: { atts: [{ tag (hex), payload }], ops: [{ tag, arg, sub }] }
  function readStamp(r, depth) {
    if (depth > 256) throw new Error('the timestamp is nested too deep');
    var t = { atts: [], ops: [] };
    function one(tag) {
      if (tag === 0x00) { var at = S.toHex(r.bytes(8)); t.atts.push({ tag: at, payload: r.varbytes() }); return; }
      var op = { tag: tag };
      if (tag === 0xf0 || tag === 0xf1) op.arg = r.varbytes();
      else if (!UNARY[tag]) throw new Error('an unknown operation 0x' + tag.toString(16));
      op.sub = readStamp(r, depth + 1);
      t.ops.push(op);
    }
    var tag = r.byte();
    while (tag === 0xff) { one(r.byte()); tag = r.byte(); }
    one(tag);
    return t;
  }
  function sameOp(a, b) { return a.tag === b.tag && (a.arg ? b.arg && S.toHex(a.arg) === S.toHex(b.arg) : !b.arg); }
  function merge(a, b) {
    b.atts.forEach(function (x) { if (!a.atts.some(function (y) { return y.tag === x.tag && S.toHex(y.payload) === S.toHex(x.payload); })) a.atts.push(x); });
    b.ops.forEach(function (x) { var y = a.ops.filter(function (z) { return sameOp(z, x); })[0]; if (y) merge(y.sub, x.sub); else a.ops.push(x); });
    return a;
  }
  function writeStamp(t, out) {
    var items = t.atts.map(function (x) { return function () { out.push(0x00); Array.prototype.push.apply(out, Array.prototype.slice.call(S.fromHex(x.tag))); Array.prototype.push.apply(out, varbytes(x.payload)); }; })
      .concat(t.ops.map(function (x) { return function () { out.push(x.tag); if (x.arg) Array.prototype.push.apply(out, varbytes(x.arg)); writeStamp(x.sub, out); }; }));
    if (!items.length) throw new Error('an empty timestamp');
    items.forEach(function (f, i) { if (i < items.length - 1) out.push(0xff); f(); });
  }
  // digest: 32 bytes (or hex); stamps: each calendar's answer (bytes). Returns the .ots file's bytes
  function otsFile(digest, stamps) {
    var d = typeof digest === 'string' ? S.fromHex(digest) : digest, tree = { atts: [], ops: [] };
    stamps.forEach(function (s) { var r = reader(s); merge(tree, readStamp(r, 0)); if (!r.end()) throw new Error('bytes after the timestamp of a calendar'); });
    var out = MAGIC.concat([0x01, 0x08], Array.prototype.slice.call(d));
    writeStamp(tree, out);
    return new Uint8Array(out);
  }
  // a .ots file: { digest (hex), pending: [calendar URLs], bitcoin: [block heights] }; throws when it is not one
  function otsRead(bytes) {
    var r = reader(bytes);
    MAGIC.forEach(function (m) { if (r.byte() !== m) throw new Error('not an OpenTimestamps file'); });
    if (r.uint() !== 1) throw new Error('an OpenTimestamps file of another version');
    if (r.byte() !== 0x08) throw new Error('the file is not stamped by its SHA-256');
    var digest = S.toHex(r.bytes(32)), tree = readStamp(r, 0), pending = [], bitcoin = [];
    if (!r.end()) throw new Error('bytes after the timestamp');
    (function walk(t) {
      t.atts.forEach(function (a) {
        if (a.tag === PENDING) pending.push(new TextDecoder().decode(reader(a.payload).varbytes()));
        else if (a.tag === BITCOIN) bitcoin.push(reader(a.payload).uint());
      });
      t.ops.forEach(function (o) { walk(o.sub); });
    })(tree);
    return { digest: digest, pending: pending, bitcoin: bitcoin };
  }
  // ---------- the pool's receipt for a find ----------
  // What the pool's server signs the moment it accepts a find: the puzzle, the lease, the commitment, the payout
  // address, the finder's satoshis and the transactions it was given, and when. Its key is published (RECEIPT_PUB:
  // here, on /rules and in the repository's history), so if the prize is ever spent in a way that does not pay this
  // finder, the receipt is the pool's own signed word against it. Signed as ECDSA over sha256 of a fixed text.
  var RECEIPT_PUB = '042c604f34ebfc297f0065d69130bbc2207cfb77e6be6d3332a56af7d284e196fe87b7aefc2d6c9dbe02a7fa02e7b9291390074c0dd7cb9dc28bf23e151ee8e1f3';
  var N_ = S.N;
  function receiptText(r) {
    return JSON.stringify(['bumblebeam-puzzle-receipt', 1, r.puzzle, r.lease, r.commitment, r.payout, r.finder_sats, r.txids, r.received]);
  }
  function receiptZ(r) { return BigInt('0x' + S.toHex(S.sha256(new TextEncoder().encode(receiptText(r))))) % N_; }
  function pubHex(d) { var P = S.mulG(BigInt(d)); return '04' + P[0].toString(16).padStart(64, '0') + P[1].toString(16).padStart(64, '0'); }
  function receiptSign(d, r) {
    var sig = T.sign(BigInt(d), receiptZ(r));
    return { body: r, sig: sig.r.toString(16).padStart(64, '0') + sig.s.toString(16).padStart(64, '0'), pub: pubHex(d) };
  }
  // true when sig is the holder of pub signing this very receipt (pub: '04' x y); the caller compares pub with
  // RECEIPT_PUB to know it is the pool's published key
  function receiptVerify(rc) {
    try {
      if (!rc || !rc.body || !/^[0-9a-f]{128}$/.test(rc.sig) || !/^04[0-9a-f]{128}$/.test(rc.pub)) return false;
      var pub = [BigInt('0x' + rc.pub.slice(2, 66)), BigInt('0x' + rc.pub.slice(66))];
      var r = BigInt('0x' + rc.sig.slice(0, 64)), s = BigInt('0x' + rc.sig.slice(64));
      if (!r || !s || r >= N_ || s >= N_) return false;
      return T.verify(pub, receiptZ(rc.body), { r: r, s: s });
    } catch (_) { return false; }
  }

  function b64(bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
  function unb64(s) { var t = atob(s), o = new Uint8Array(t.length); for (var i = 0; i < t.length; i++) o[i] = t.charCodeAt(i); return o; }

  root.BBKit = {
    DUST: DUST, MIN_COIN: MIN_COIN, MAX_RATE: MAX_RATE, MAX_FEE_SHARE: MAX_FEE_SHARE, MAX_VSIZE: MAX_VSIZE, INPUT_VB: INPUT_VB,
    btc: btc, finderShare: finderShare, split: split, check: check, spendable: spendable, chooseRate: chooseRate, build: build, bump: bump, checkTx: checkTx, outValue: outValue, outOn: outOn,
    preimage: preimage, commitment: commitment, otsFile: otsFile, otsRead: otsRead, b64: b64, unb64: unb64,
    RECEIPT_PUB: RECEIPT_PUB, receiptText: receiptText, receiptSign: receiptSign, receiptVerify: receiptVerify, pubHex: pubHex,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.BBKit;
})(typeof self !== 'undefined' ? self : globalThis);
