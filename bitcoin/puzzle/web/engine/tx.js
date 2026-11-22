/* BumbleBeam puzzle: claiming a found key. Address decoding (P2PKH, P2SH, bech32 P2WPKH / P2WSH, bech32m P2TR),
   HMAC-SHA256, ECDSA with RFC 6979 nonces and low S, a legacy transaction that sweeps P2PKH outputs of a compressed
   key to the given outputs, and reading such a sweep back with its signatures checked (the server's checks of a
   find, /proof's Verify). Nothing here talks to the network.
   A classic script; needs BBSecp. Exposes BBTx. */
(function (root) {
  'use strict';
  var S = root.BBSecp;
  var N = S.N;

  // ---------- bytes ----------
  function concat() {
    var n = 0, i; for (i = 0; i < arguments.length; i++) n += arguments[i].length;
    var o = new Uint8Array(n), k = 0;
    for (i = 0; i < arguments.length; i++) { o.set(arguments[i], k); k += arguments[i].length; }
    return o;
  }
  function be32(b) { return S.fromHex(b.toString(16).padStart(64, '0')); }
  function num(bytes) { return BigInt('0x' + (S.toHex(bytes) || '0')); }
  function le(n, bytes) { var o = new Uint8Array(bytes), v = BigInt(n); for (var i = 0; i < bytes; i++) { o[i] = Number(v & 0xffn); v >>= 8n; } return o; }
  function varint(n) {
    if (n < 0xfd) return new Uint8Array([n]);
    if (n <= 0xffff) return concat(new Uint8Array([0xfd]), le(n, 2));
    return concat(new Uint8Array([0xfe]), le(n, 4));
  }
  function sha256d(b) { return S.sha256(S.sha256(b)); }
  function rev(b) { return Uint8Array.from(b).reverse(); }

  // ---------- HMAC-SHA256 and RFC 6979 ----------
  function hmac(key, msg) {
    if (key.length > 64) key = S.sha256(key);
    var k = new Uint8Array(64); k.set(key);
    var ip = k.map(function (x) { return x ^ 0x36; }), op = k.map(function (x) { return x ^ 0x5c; });
    return S.sha256(concat(op, S.sha256(concat(ip, msg))));
  }
  function nonce(d, z) { // RFC 6979 with SHA-256, for secp256k1 (qlen = 256)
    var x = be32(d), h = be32(z % N);
    var V = new Uint8Array(32).fill(1), K = new Uint8Array(32);
    K = hmac(K, concat(V, new Uint8Array([0]), x, h)); V = hmac(K, V);
    K = hmac(K, concat(V, new Uint8Array([1]), x, h)); V = hmac(K, V);
    for (;;) {
      V = hmac(K, V);
      var k = num(V);
      if (k >= 1n && k < N) return k;
      K = hmac(K, concat(V, new Uint8Array([0]))); V = hmac(K, V);
    }
  }
  function modN(a) { a %= N; return a < 0n ? a + N : a; }
  function invN(a) { var r = 1n, b = modN(a), e = N - 2n; while (e > 0n) { if (e & 1n) r = r * b % N; b = b * b % N; e >>= 1n; } return r; }
  // ECDSA over the 32-byte digest z (BigInt); low S (BIP 62)
  function sign(d, z) {
    var k = nonce(d, z), R = S.mulG(k), r = R[0] % N;
    var s = modN(invN(k) * (z + r * d));
    if (s > N / 2n) s = N - s;
    return { r: r, s: s };
  }
  function verify(pub, z, sig) {
    var w = invN(sig.s), u1 = modN(z * w), u2 = modN(sig.r * w);
    var p = S.addAffine(u1 ? S.mulG(u1) : null, u2 ? mulPoint(pub, u2) : null);
    return !!p && p[0] % N === sig.r;
  }
  // double-and-add in Jacobian coordinates, as mulG: one inversion at the end (about ten times faster than on
  // affine points, which matters when a claim with a dozen coins is checked signature by signature)
  function mulPoint(P, k) {
    var q = [0n, 1n, 0n];
    for (var i = BigInt(k.toString(2).length - 1); i >= 0n; i--) {
      q = S.jdbl(q);
      if ((k >> i) & 1n) q = S.jadd(q, P[0], P[1]);
    }
    return S.toAffine(q);
  }
  function der(sig) {
    function int(x) { var b = be32(x), i = 0; while (i < 31 && b[i] === 0) i++; b = b.slice(i); if (b[0] & 0x80) b = concat(new Uint8Array([0]), b); return concat(new Uint8Array([2, b.length]), b); }
    var r = int(sig.r), s = int(sig.s);
    return concat(new Uint8Array([0x30, r.length + s.length]), r, s);
  }

  // ---------- addresses -> scriptPubKey ----------
  var B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  function polymod(v) {
    var G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3], chk = 1;
    for (var i = 0; i < v.length; i++) { var b = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ v[i]; for (var j = 0; j < 5; j++) if ((b >>> j) & 1) chk ^= G[j]; }
    return chk >>> 0;
  }
  function bech32Decode(a) {
    var s = a.toLowerCase();
    if (s !== a && a.toUpperCase() !== a) throw new Error('mixed case');
    var p = s.lastIndexOf('1'); if (p < 1 || p + 7 > s.length || s.length > 90) throw new Error('not bech32');
    var hrp = s.slice(0, p), data = [];
    for (var i = p + 1; i < s.length; i++) { var d = B32.indexOf(s[i]); if (d < 0) throw new Error('not bech32'); data.push(d); }
    var exp = [];
    for (i = 0; i < hrp.length; i++) exp.push(hrp.charCodeAt(i) >> 5);
    exp.push(0);
    for (i = 0; i < hrp.length; i++) exp.push(hrp.charCodeAt(i) & 31);
    var c = polymod(exp.concat(data));
    var variant = c === 1 ? 'bech32' : c === 0x2bc830a3 ? 'bech32m' : null;
    if (!variant) throw new Error('bad bech32 checksum');
    return { hrp: hrp, data: data.slice(0, -6), variant: variant };
  }
  function from5(d) {
    var acc = 0, bits = 0, out = [];
    for (var i = 0; i < d.length; i++) { acc = (acc << 5) | d[i]; bits += 5; while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); } }
    if (bits >= 5 || ((acc << (8 - bits)) & 255)) throw new Error('bad padding');
    return new Uint8Array(out);
  }
  function b58check(a) {
    var A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz', n = 0n, i;
    for (i = 0; i < a.length; i++) { var d = A.indexOf(a[i]); if (d < 0) throw new Error('not base58'); n = n * 58n + BigInt(d); }
    var hex = n.toString(16); if (hex.length % 2) hex = '0' + hex;
    var body = S.fromHex(hex), z = 0;
    while (a[z] === '1') z++;
    var b = concat(new Uint8Array(z), body);
    var chk = sha256d(b.slice(0, -4));
    for (i = 0; i < 4; i++) if (chk[i] !== b[b.length - 4 + i]) throw new Error('bad checksum');
    return b.slice(0, -4);
  }
  // mainnet only; returns { type, script (Uint8Array) } or throws
  function addressScript(a) {
    a = String(a || '').trim();
    if (/^bc1/i.test(a)) {
      var d = bech32Decode(a);
      if (d.hrp !== 'bc') throw new Error('not a mainnet address');
      var ver = d.data[0], prog = from5(d.data.slice(1));
      if (ver === 0 && d.variant !== 'bech32') throw new Error('v0 needs bech32');
      if (ver > 0 && d.variant !== 'bech32m') throw new Error('v1+ needs bech32m');
      if (ver === 0 && prog.length === 20) return { type: 'p2wpkh', script: concat(new Uint8Array([0, 20]), prog) };
      if (ver === 0 && prog.length === 32) return { type: 'p2wsh', script: concat(new Uint8Array([0, 32]), prog) };
      if (ver === 1 && prog.length === 32) return { type: 'p2tr', script: concat(new Uint8Array([0x51, 32]), prog) };
      throw new Error('unsupported witness program');
    }
    var b = b58check(a);
    if (b.length !== 21) throw new Error('bad length');
    if (b[0] === 0) return { type: 'p2pkh', script: concat(new Uint8Array([0x76, 0xa9, 20]), b.slice(1), new Uint8Array([0x88, 0xac])) };
    if (b[0] === 5) return { type: 'p2sh', script: concat(new Uint8Array([0xa9, 20]), b.slice(1), new Uint8Array([0x87])) };
    throw new Error('not a mainnet address');
  }
  function isAddress(a) { try { addressScript(a); return true; } catch (_) { return false; } }

  // ---------- the sweep ----------
  // utxos: [{ txid, vout, value (sats) }] all on the P2PKH address of key; outputs: [{ address, value }]
  // returns { hex, txid, size } (legacy, so vsize = size). Inputs signal RBF.
  function sweep(key, utxos, outputs) {
    key = BigInt(key);
    var P = S.mulG(key), pub = S.fromHex(S.compressedHex(P));
    var h160 = S.fromHex(S.wordsToHex(S.hash160Words(P[0], P[1])));
    var spk = concat(new Uint8Array([0x76, 0xa9, 20]), h160, new Uint8Array([0x88, 0xac]));
    var outs = outputs.map(function (o) { var sc = addressScript(o.address).script; return concat(le(o.value, 8), varint(sc.length), sc); });
    function build(scripts) {
      var parts = [le(2, 4), varint(utxos.length)];
      utxos.forEach(function (u, i) { parts.push(rev(S.fromHex(u.txid)), le(u.vout, 4), varint(scripts[i].length), scripts[i], le(0xfffffffd, 4)); });
      parts.push(varint(outs.length));
      outs.forEach(function (o) { parts.push(o); });
      parts.push(le(0, 4));
      return concat.apply(null, parts);
    }
    var sigs = utxos.map(function (u, i) {
      var scripts = utxos.map(function (_, j) { return j === i ? spk : new Uint8Array(0); });
      var z = num(sha256d(concat(build(scripts), le(1, 4))));
      var sg = sign(key, z);
      if (!verify(P, z, sg)) throw new Error('signature does not verify');
      var ds = concat(der(sg), new Uint8Array([1]));
      return concat(new Uint8Array([ds.length]), ds, new Uint8Array([pub.length]), pub);
    });
    var tx = build(sigs);
    return { hex: S.toHex(tx), txid: S.toHex(rev(sha256d(tx))), size: tx.length };
  }
  // the size a sweep of n inputs to these outputs will have (signatures are 71-73 bytes; take 73)
  function sweepSize(nIn, outputs) {
    var o = outputs.reduce(function (s, x) { var l = addressScript(x.address).script.length; return s + 8 + 1 + l; }, 0);
    return 4 + varint(nIn).length + nIn * (32 + 4 + 1 + (1 + 73) + (1 + 33) + 4) + varint(outputs.length).length + o + 4;
  }

  // ---------- reading a signed transaction back (the server's checks of a find, /proof's Verify) ----------
  // legacy only (our sweeps are): { version, ins: [{ txid, vout, script, seq }], outs: [{ value, script }], lock, txid, size }
  function parse(hex) {
    if (typeof hex !== 'string' || !/^([0-9a-f]{2})+$/i.test(hex)) throw new Error('not a transaction in hex');
    var b = S.fromHex(hex.toLowerCase()), p = 0;
    function take(n) { if (p + n > b.length) throw new Error('the transaction is cut short'); var x = b.slice(p, p + n); p += n; return x; }
    function u(n) { var x = take(n), v = 0; for (var i = n - 1; i >= 0; i--) v = v * 256 + x[i]; return v; }
    function vi() { var f = u(1); return f < 0xfd ? f : f === 0xfd ? u(2) : f === 0xfe ? u(4) : u(8); }
    var tx = { version: u(4), ins: [], outs: [] };
    if (b[p] === 0) throw new Error('a segwit transaction: a puzzle sweep is legacy');
    var n = vi(), i;
    if (!n || n > 10000) throw new Error('no inputs');
    for (i = 0; i < n; i++) tx.ins.push({ txid: S.toHex(rev(take(32))), vout: u(4), script: take(vi()), seq: u(4) });
    n = vi();
    if (!n || n > 10000) throw new Error('no outputs');
    for (i = 0; i < n; i++) tx.outs.push({ value: u(8), script: take(vi()) });
    tx.lock = u(4);
    if (p !== b.length) throw new Error('bytes after the end of the transaction');
    tx.txid = S.toHex(rev(sha256d(b))); tx.size = b.length;
    return tx;
  }
  function serialize(tx, scripts) {
    var parts = [le(tx.version, 4), varint(tx.ins.length)];
    tx.ins.forEach(function (x, i) { var sc = scripts ? scripts[i] : x.script; parts.push(rev(S.fromHex(x.txid)), le(x.vout, 4), varint(sc.length), sc, le(x.seq, 4)); });
    parts.push(varint(tx.outs.length));
    tx.outs.forEach(function (o) { parts.push(le(o.value, 8), varint(o.script.length), o.script); });
    parts.push(le(tx.lock, 4));
    return concat.apply(null, parts);
  }
  // every input of a parsed transaction spends key P's P2PKH coin with a valid SIGHASH_ALL signature (DER, low S)
  // and P's compressed public key; throws saying which input is wrong
  function verifySweep(tx, P) {
    var pub = S.compressedHex(P);
    var spk = concat(new Uint8Array([0x76, 0xa9, 20]), S.fromHex(S.wordsToHex(S.hash160Words(P[0], P[1]))), new Uint8Array([0x88, 0xac]));
    tx.ins.forEach(function (x, i) {
      var s = x.script, l1 = s[0], sig = s.slice(1, 1 + l1), l2 = s[1 + l1], pk = s.slice(2 + l1, 2 + l1 + l2);
      if (!l1 || 2 + l1 + l2 !== s.length || S.toHex(pk) !== pub) throw new Error('input ' + i + ' is not signed by the puzzle key');
      if (sig[sig.length - 1] !== 1) throw new Error('input ' + i + ': not SIGHASH_ALL');
      var d = sig.slice(0, -1);
      if (d[0] !== 0x30 || d[1] !== d.length - 2 || d[2] !== 2) throw new Error('input ' + i + ': not a DER signature');
      var rl = d[3], r = num(d.slice(4, 4 + rl));
      if (d[4 + rl] !== 2) throw new Error('input ' + i + ': not a DER signature');
      var sl = d[5 + rl], sv = num(d.slice(6 + rl, 6 + rl + sl));
      if (6 + rl + sl !== d.length || r < 1n || r >= N || sv < 1n || sv > N / 2n) throw new Error('input ' + i + ': a malformed or high-S signature');
      // strict DER (BIP 66, what nodes relay): each integer as short as it can be, never negative
      [d.slice(4, 4 + rl), d.slice(6 + rl, 6 + rl + sl)].forEach(function (n) {
        if (!n.length || n[0] & 0x80 || (n.length > 1 && n[0] === 0 && !(n[1] & 0x80))) throw new Error('input ' + i + ': not a strict DER signature');
      });
      var scripts = tx.ins.map(function (_, j) { return j === i ? spk : new Uint8Array(0); });
      var z = num(sha256d(concat(serialize(tx, scripts), le(1, 4))));
      if (!verify(P, z, { r: r, s: sv })) throw new Error('input ' + i + ': the signature does not verify');
    });
    return true;
  }

  root.BBTx = { addressScript: addressScript, isAddress: isAddress, sign: sign, verify: verify, der: der, hmac: hmac, nonce: nonce, sweep: sweep, sweepSize: sweepSize, parse: parse, verifySweep: verifySweep };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.BBTx;
})(typeof self !== 'undefined' ? self : globalThis);
