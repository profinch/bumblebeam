/* BumbleBeam puzzle engine: the reference implementation in plain JS (BigInt). secp256k1, SHA-256, RIPEMD-160,
   base58check, and a brute-force search over a key range with batched affine additions. Slow next to the GPU, but
   simple enough to trust: the WebGPU engine checks itself against it.
   A classic script: works in a page, a Web Worker (importScripts), Node (require) and Deno. Exposes BBSecp. */
(function (root) {
  'use strict';

  var P = (1n << 256n) - (1n << 32n) - 977n;
  var N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  var GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
  var GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

  function mod(a) { a %= P; return a < 0n ? a + P : a; }
  function pow(b, e) {
    var r = 1n; b = mod(b);
    while (e > 0n) { if (e & 1n) r = r * b % P; b = b * b % P; e >>= 1n; }
    return r;
  }
  function inv(a) { return pow(a, P - 2n); }

  // Jacobian (a = 0): double and mixed add, for scalar multiplication
  function jdbl(p) {
    if (p[2] === 0n) return p;
    var X = p[0], Y = p[1], Z = p[2];
    var A = X * X % P, B = Y * Y % P, C = B * B % P;
    var D = mod(2n * (mod((X + B) * (X + B)) - A - C));
    var E = 3n * A % P, F = E * E % P;
    var X3 = mod(F - 2n * D), Y3 = mod(E * mod(D - X3) - 8n * C), Z3 = 2n * Y * Z % P;
    return [X3, Y3, Z3];
  }
  function jadd(p, x2, y2) {
    if (p[2] === 0n) return [x2, y2, 1n];
    var X1 = p[0], Y1 = p[1], Z1 = p[2];
    var Z1Z1 = Z1 * Z1 % P, U2 = x2 * Z1Z1 % P, S2 = y2 * Z1 % P * Z1Z1 % P;
    var H = mod(U2 - X1), r = mod(2n * (S2 - Y1));
    if (H === 0n) return r === 0n ? jdbl([x2, y2, 1n]) : [0n, 1n, 0n];
    var HH = H * H % P, I = 4n * HH % P, J = H * I % P, V = X1 * I % P;
    var X3 = mod(r * r - J - 2n * V), Y3 = mod(r * mod(V - X3) - 2n * Y1 * J);
    var Z3 = mod((Z1 + H) * (Z1 + H) - Z1Z1 - HH);
    return [X3, Y3, Z3];
  }
  function toAffine(p) {
    if (p[2] === 0n) return null;
    var zi = inv(p[2]), zi2 = zi * zi % P;
    return [p[0] * zi2 % P, p[1] * zi2 % P * zi % P];
  }
  // k·G for 1 <= k < n
  function mulG(k) {
    k = BigInt(k);
    var q = [0n, 1n, 0n];
    for (var i = BigInt(k.toString(2).length - 1); i >= 0n; i--) {
      q = jdbl(q);
      if ((k >> i) & 1n) q = jadd(q, GX, GY);
    }
    return toAffine(q);
  }
  function addAffine(a, b) {
    if (!a) return b; if (!b) return a;
    if (a[0] === b[0]) { if (mod(a[1] + b[1]) === 0n) return null; return toAffine(jdbl([a[0], a[1], 1n])); }
    var l = mod(b[1] - a[1]) * inv(mod(b[0] - a[0])) % P;
    var x = mod(l * l - a[0] - b[0]);
    return [x, mod(l * (a[0] - x) - a[1])];
  }

  // ---------- hashes on 32-bit words ----------
  var KS = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  var W = new Uint32Array(64);
  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
  // SHA-256 of one padded 64-byte block given as 16 big-endian words; returns 8 words
  function sha256Block(m) {
    var i;
    for (i = 0; i < 16; i++) W[i] = m[i];
    for (i = 16; i < 64; i++) {
      var a = W[i - 15], b = W[i - 2];
      W[i] = (W[i - 16] + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + W[i - 7] + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) >>> 0;
    }
    var h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a, h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    var A = h0, B = h1, C = h2, D = h3, E = h4, F = h5, G = h6, H = h7;
    for (i = 0; i < 64; i++) {
      var t1 = (H + (rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25)) + ((E & F) ^ (~E & G)) + KS[i] + W[i]) >>> 0;
      var t2 = ((rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22)) + ((A & B) ^ (A & C) ^ (B & C))) >>> 0;
      H = G; G = F; F = E; E = (D + t1) >>> 0; D = C; C = B; B = A; A = (t1 + t2) >>> 0;
    }
    return [(h0 + A) >>> 0, (h1 + B) >>> 0, (h2 + C) >>> 0, (h3 + D) >>> 0, (h4 + E) >>> 0, (h5 + F) >>> 0, (h6 + G) >>> 0, (h7 + H) >>> 0];
  }
  function sha256(bytes) { // any length, for the address checksum and tests
    var len = bytes.length, nb = ((len + 9 + 63) >> 6), buf = new Uint8Array(nb * 64);
    buf.set(bytes); buf[len] = 0x80;
    var bits = len * 8;
    buf[nb * 64 - 4] = (bits >>> 24) & 255; buf[nb * 64 - 3] = (bits >>> 16) & 255; buf[nb * 64 - 2] = (bits >>> 8) & 255; buf[nb * 64 - 1] = bits & 255;
    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    for (var b = 0; b < nb; b++) {
      var i;
      for (i = 0; i < 16; i++) { var o = b * 64 + i * 4; W[i] = ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0; }
      for (i = 16; i < 64; i++) { var a = W[i - 15], c = W[i - 2]; W[i] = (W[i - 16] + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + W[i - 7] + (rotr(c, 17) ^ rotr(c, 19) ^ (c >>> 10))) >>> 0; }
      var A = h[0], B = h[1], C = h[2], D = h[3], E = h[4], F = h[5], G = h[6], H = h[7];
      for (i = 0; i < 64; i++) {
        var t1 = (H + (rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25)) + ((E & F) ^ (~E & G)) + KS[i] + W[i]) >>> 0;
        var t2 = ((rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22)) + ((A & B) ^ (A & C) ^ (B & C))) >>> 0;
        H = G; G = F; F = E; E = (D + t1) >>> 0; D = C; C = B; B = A; A = (t1 + t2) >>> 0;
      }
      h = [(h[0] + A) >>> 0, (h[1] + B) >>> 0, (h[2] + C) >>> 0, (h[3] + D) >>> 0, (h[4] + E) >>> 0, (h[5] + F) >>> 0, (h[6] + G) >>> 0, (h[7] + H) >>> 0];
    }
    var out = new Uint8Array(32);
    for (var j = 0; j < 8; j++) { out[j * 4] = h[j] >>> 24; out[j * 4 + 1] = (h[j] >>> 16) & 255; out[j * 4 + 2] = (h[j] >>> 8) & 255; out[j * 4 + 3] = h[j] & 255; }
    return out;
  }

  var RL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8, 3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12, 1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2, 4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13];
  var RR = [5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12, 6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2, 15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13, 8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14, 12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11];
  var SL = [11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8, 7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12, 11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5, 11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12, 9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6];
  var SR = [8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6, 9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11, 9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5, 15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8, 8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11];
  var KL = [0, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e], KR = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0];
  function rotl(x, n) { return (x << n) | (x >>> (32 - n)); }
  function rf(j, x, y, z) {
    if (j < 16) return x ^ y ^ z;
    if (j < 32) return (x & y) | (~x & z);
    if (j < 48) return (x | ~y) ^ z;
    if (j < 64) return (x & z) | (y & ~z);
    return x ^ (y | ~z);
  }
  // RIPEMD-160 of one padded block given as 16 little-endian words; returns 5 words (little-endian)
  function ripemdBlock(X) {
    var h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
    var al = h0, bl = h1, cl = h2, dl = h3, el = h4, ar = h0, br = h1, cr = h2, dr = h3, er = h4, t;
    for (var j = 0; j < 80; j++) {
      var r = j >> 4;
      t = (rotl((al + rf(j, bl, cl, dl) + X[RL[j]] + KL[r]) | 0, SL[j]) + el) | 0;
      al = el; el = dl; dl = rotl(cl, 10); cl = bl; bl = t;
      t = (rotl((ar + rf(79 - j, br, cr, dr) + X[RR[j]] + KR[r]) | 0, SR[j]) + er) | 0;
      ar = er; er = dr; dr = rotl(cr, 10); cr = br; br = t;
    }
    t = (h1 + cl + dr) | 0;
    return [t >>> 0, (h2 + dl + er) >>> 0, (h3 + el + ar) >>> 0, (h4 + al + br) >>> 0, (h0 + bl + cr) >>> 0];
  }
  function bswap(x) { return ((x >>> 24) | ((x >>> 8) & 0xff00) | ((x << 8) & 0xff0000) | (x << 24)) >>> 0; }

  // hash160 of the compressed public key of point (x, y), as 5 little-endian words (the order the bytes come in)
  var M = new Uint32Array(16), R = new Uint32Array(16);
  function xWords(x) { // 8 big-endian 32-bit words of x
    var w = [], i;
    for (i = 7; i >= 0; i--) { w[i] = Number(x & 0xffffffffn); x >>= 32n; }
    return w;
  }
  function hash160Words(x, y) {
    var w = xWords(x), pre = (y & 1n) ? 3 : 2;
    M[0] = ((pre << 24) | (w[0] >>> 8)) >>> 0;
    for (var i = 1; i < 8; i++) M[i] = ((w[i - 1] << 24) | (w[i] >>> 8)) >>> 0;
    M[8] = ((w[7] << 24) | 0x800000) >>> 0;
    M[9] = M[10] = M[11] = M[12] = M[13] = M[14] = 0; M[15] = 264;
    var h = sha256Block(M);
    for (var j = 0; j < 8; j++) R[j] = bswap(h[j]);
    R[8] = 0x80; R[9] = R[10] = R[11] = R[12] = R[13] = 0; R[14] = 256; R[15] = 0;
    return ripemdBlock(R);
  }
  function wordsToHex(w) { return w.map(function (x) { return bswap(x).toString(16).padStart(8, '0'); }).join(''); }
  function hexToWords(hex) { var w = []; for (var i = 0; i < 5; i++) w.push(bswap(parseInt(hex.slice(i * 8, i * 8 + 8), 16))); return w; }
  function hash160OfKey(k) { var p = mulG(k); return wordsToHex(hash160Words(p[0], p[1])); }

  // ---------- base58check P2PKH ----------
  var B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function toHex(b) { return Array.prototype.map.call(b, function (x) { return x.toString(16).padStart(2, '0'); }).join(''); }
  function fromHex(h) { var b = new Uint8Array(h.length / 2); for (var i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16); return b; }
  function addressToHash160(addr) {
    var n = 0n;
    for (var i = 0; i < addr.length; i++) { var d = B58.indexOf(addr[i]); if (d < 0) throw new Error('not base58'); n = n * 58n + BigInt(d); }
    var hex = n.toString(16).padStart(50, '0');
    var bytes = fromHex(hex);
    if (bytes.length !== 25 || bytes[0] !== 0) throw new Error('not a P2PKH address');
    var chk = sha256(sha256(bytes.slice(0, 21)));
    for (var j = 0; j < 4; j++) if (chk[j] !== bytes[21 + j]) throw new Error('bad checksum');
    return toHex(bytes.slice(1, 21));
  }
  function hash160ToAddress(h) {
    var body = new Uint8Array(21); body.set(fromHex(h), 1);
    var chk = sha256(sha256(body)), full = new Uint8Array(25);
    full.set(body); full.set(chk.slice(0, 4), 21);
    var n = BigInt('0x' + toHex(full)), s = '';
    while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
    for (var i = 0; i < full.length && full[i] === 0; i++) s = '1' + s;
    return s;
  }

  // ---------- brute force over [from, to] ----------
  // Searcher: B points P_i = (from + i)·G, stepped together by B·G with one shared inversion per step.
  // next(maxKeys) checks up to maxKeys keys in order and returns { checked, found (BigInt key or null), done }.
  function Searcher(from, to, targetHex, batch) {
    var B = batch || 256, tw = hexToWords(targetHex);
    from = BigInt(from); to = BigInt(to);
    var pts = [], p = mulG(from), i;
    for (i = 0; i < B; i++) { pts.push(p); p = addAffine(p, [GX, GY]); }
    var step = mulG(BigInt(B)), sx = step[0], sy = step[1];
    var base = from, pref = new Array(B);
    this.next = function (maxKeys) {
      var checked = 0;
      while (checked < maxKeys) {
        if (base > to) return { checked: checked, found: null, done: true };
        var j;
        for (j = 0; j < B; j++) {
          if (base + BigInt(j) > to) break;
          var h = hash160Words(pts[j][0], pts[j][1]);
          if (h[0] === tw[0] && h[1] === tw[1] && h[2] === tw[2] && h[3] === tw[3] && h[4] === tw[4]) return { checked: checked + j + 1, found: base + BigInt(j), done: true };
        }
        checked += j;
        // step every point by B·G: batch inversion of (sx - x_i)
        var acc = 1n;
        for (j = 0; j < B; j++) { pref[j] = acc; acc = acc * mod(sx - pts[j][0]) % P; }
        var iv = inv(acc);
        for (j = B - 1; j >= 0; j--) {
          var dx = mod(sx - pts[j][0]), id = iv * pref[j] % P;
          iv = iv * dx % P;
          var l = mod(sy - pts[j][1]) * id % P, x3 = mod(l * l - pts[j][0] - sx);
          pts[j] = [x3, mod(l * (pts[j][0] - x3) - pts[j][1])];
        }
        base += BigInt(B);
      }
      return { checked: checked, found: null, done: base > to };
    };
  }

  // pts[i] + adds[i] for every i with one shared inversion; a pair with the same x (a doubling, or a point
  // and its negation) is done on its own, so it cannot zero the shared product
  function batchAdd(pts, adds) {
    var n = pts.length, pref = new Array(n), acc = 1n, i, out = new Array(n), odd = [];
    for (i = 0; i < n; i++) {
      pref[i] = acc;
      var d = mod(adds[i][0] - pts[i][0]);
      if (d === 0n) { odd.push(i); continue; }
      acc = acc * d % P;
    }
    for (i = 0; i < odd.length; i++) out[odd[i]] = addAffine(pts[odd[i]], adds[odd[i]]);
    var iv = inv(acc);
    for (i = n - 1; i >= 0; i--) {
      if (out[i] !== undefined) continue;
      var dx = mod(adds[i][0] - pts[i][0]), id = iv * pref[i] % P;
      iv = iv * dx % P;
      var l = mod(adds[i][1] - pts[i][1]) * id % P, x3 = mod(l * l - pts[i][0] - adds[i][0]);
      out[i] = [x3, mod(l * (pts[i][0] - x3) - pts[i][1])];
    }
    return out;
  }
  function neg(p) { return [p[0], mod(-p[1])]; }
  function compressedHex(p) { return ((p[1] & 1n) ? '03' : '02') + p[0].toString(16).padStart(64, '0'); }

  var api = {
    batchAdd: batchAdd, neg: neg, compressedHex: compressedHex,
    P: P, N: N, GX: GX, GY: GY, mod: mod, inv: inv, mulG: mulG, addAffine: addAffine, jdbl: jdbl, jadd: jadd, toAffine: toAffine,
    sha256: sha256, sha256Block: sha256Block, ripemdBlock: ripemdBlock, hash160Words: hash160Words, hash160OfKey: hash160OfKey,
    wordsToHex: wordsToHex, hexToWords: hexToWords, addressToHash160: addressToHash160, hash160ToAddress: hash160ToAddress,
    toHex: toHex, fromHex: fromHex, Searcher: Searcher,
  };
  root.BBSecp = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
