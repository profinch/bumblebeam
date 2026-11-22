/* BumbleBeam puzzle engine on WebGPU: brute force over a key range, written from scratch in WGSL.
   secp256k1 field arithmetic on twenty 13-bit limbs: WGSL has no 64-bit integers and no high half of a 32-bit
   product, and with 13-bit limbs a whole column of twenty limb products fits one u32, so a multiplication is 400
   plain multiplies and adds with the carries done once at the end. Each thread checks the 2K + 1 keys around a
   centre point with one shared inversion per step (the prefix products live in a storage buffer, so K is a
   number the host picks, not part of the shader); SHA-256 and RIPEMD-160 and the hash160 comparison on the GPU.
   Before any search it tests itself against the BigInt reference (secp.js). The shader is generated: the
   multiplication and the hashes are straight-line code, the inversion is a loop (unrolled it took browsers on
   D3D most of a minute to compile).
   A classic script; needs BBSecp. Exposes BBGpu. */
(function (root) {
  'use strict';
  var S = root.BBSecp;

  // ---------- WGSL ----------
  function hex(x) { return '0x' + (x >>> 0).toString(16) + 'u'; }
  function rotr(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }

  // SHA-256 of a compressed key's 33 bytes: one block whose words 9..15 are padding, the same for every key (zeros
  // and the length, 264 bits). They are folded in here: the schedule loses every term that is zero, and a constant
  // word joins its round's constant.
  function shaCode() {
    var K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    var sig = {
      ssig0: function (x) { return (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0; },
      ssig1: function (x) { return (rotr(x, 17) ^ rotr(x, 19) ^ (x >>> 10)) >>> 0; },
    };
    // w[i]: the name of a variable, or a number known here
    var w = [], i, c = 'fn sha256_33(m: array<u32, 9>) -> array<u32, 8> {\n';
    for (i = 0; i < 9; i++) { c += '  let w' + i + ' = m[' + i + '];\n'; w.push('w' + i); }
    for (i = 9; i < 15; i++) w.push(0);
    w.push(264);
    for (i = 16; i < 64; i++) {
      var k = 0, terms = [];
      [[w[i - 16]], [w[i - 15], 'ssig0'], [w[i - 7]], [w[i - 2], 'ssig1']].forEach(function (t) {
        if (typeof t[0] === 'number') k = (k + (t[1] ? sig[t[1]](t[0]) : t[0])) >>> 0;
        else terms.push(t[1] ? t[1] + '(' + t[0] + ')' : t[0]);
      });
      if (!terms.length) { w.push(k); continue; }
      c += '  let w' + i + ' = ' + terms.join(' + ') + (k ? ' + ' + hex(k) : '') + ';\n';
      w.push('w' + i);
    }
    c += '  var a = 0x6a09e667u; var b = 0xbb67ae85u; var c = 0x3c6ef372u; var d = 0xa54ff53au; var e = 0x510e527fu; var f = 0x9b05688cu; var g = 0x1f83d9abu; var h = 0x5be0cd19u;\n  var t1: u32; var t2: u32;\n';
    for (i = 0; i < 64; i++) {
      var kw = typeof w[i] === 'number' ? hex((K[i] + w[i]) >>> 0) : hex(K[i]) + ' + ' + w[i];
      c += '  t1 = h + bsig1(e) + ((e & f) ^ (~e & g)) + ' + kw + '; t2 = bsig0(a) + ((a & b) ^ (a & c) ^ (b & c)); h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;\n';
    }
    c += '  return array<u32, 8>(a + 0x6a09e667u, b + 0xbb67ae85u, c + 0x3c6ef372u, d + 0xa54ff53au, e + 0x510e527fu, f + 0x9b05688cu, g + 0x1f83d9abu, h + 0x5be0cd19u);\n}\n';
    return c;
  }
  // RIPEMD-160 of those 32 bytes: again one block, its words 8..15 padding (0x80, zeros, the length 256 in word
  // 14), folded into each step's constant
  function ripemdCode() {
    var RL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8, 3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12, 1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2, 4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13];
    var RR = [5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12, 6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2, 15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13, 8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14, 12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11];
    var SL = [11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8, 7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12, 11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5, 11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12, 9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6];
    var SR = [8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6, 9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11, 9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5, 15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8, 8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11];
    var KL = [0, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e], KR = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0];
    var PAD = { 8: 0x80, 14: 256 }; // words 8..15; the others are zero
    function f(j, x, y, z) {
      if (j < 16) return '(' + x + ' ^ ' + y + ' ^ ' + z + ')';
      if (j < 32) return '((' + x + ' & ' + y + ') | (~' + x + ' & ' + z + '))';
      if (j < 48) return '((' + x + ' | ~' + y + ') ^ ' + z + ')';
      if (j < 64) return '((' + x + ' & ' + z + ') | (' + y + ' & ~' + z + '))';
      return '(' + x + ' ^ (' + y + ' | ~' + z + '))';
    }
    // the message word and the round constant of a step, as one sum
    function xk(word, k) {
      var n = word < 8 ? k : (k + (PAD[word] || 0)) >>> 0;
      return (word < 8 ? ' + x' + word : '') + (n ? ' + ' + hex(n) : '');
    }
    var c = 'fn ripemd160_32(m: array<u32, 8>) -> array<u32, 5> {\n';
    for (var i = 0; i < 8; i++) c += '  let x' + i + ' = m[' + i + '];\n';
    c += '  var al = 0x67452301u; var bl = 0xefcdab89u; var cl = 0x98badcfeu; var dl = 0x10325476u; var el = 0xc3d2e1f0u;\n';
    c += '  var ar = al; var br = bl; var cr = cl; var dr = dl; var er = el; var t: u32;\n';
    for (var j = 0; j < 80; j++) {
      var r = j >> 4;
      c += '  t = rotl(al + ' + f(j, 'bl', 'cl', 'dl') + xk(RL[j], KL[r]) + ', ' + SL[j] + 'u) + el; al = el; el = dl; dl = rotl(cl, 10u); cl = bl; bl = t;\n';
      c += '  t = rotl(ar + ' + f(79 - j, 'br', 'cr', 'dr') + xk(RR[j], KR[r]) + ', ' + SR[j] + 'u) + er; ar = er; er = dr; dr = rotl(cr, 10u); cr = br; br = t;\n';
    }
    c += '  return array<u32, 5>(0xefcdab89u + cl + dr, 0x98badcfeu + dl + er, 0x10325476u + el + ar, 0xc3d2e1f0u + al + br, 0x67452301u + bl + cr);\n}\n';
    return c;
  }

  // ---------- the field ----------
  // A field element is twenty limbs of 13 bits, least significant first (260 bits for 256). Limbs are allowed to
  // run a little over, and values to stay a little above p, as long as nothing overflows a u32 on the way:
  //   loose: limbs 0..18 at most 8192, limb 19 at most 511 (so the value is below 2^256 + 2^235, less than 2p);
  //          what every routine below returns unless it says "raw", and what the centre points are kept as
  //   raw:   loose values added and subtracted limb by limb with no carries, a multiple of p added so that no
  //          limb goes below zero (fe_subr: a - b, limbs up to 24574; fe_sub2r: a - b - c, up to 32765). A raw
  //          a - b may be the second factor of fe_mul (20 * 8192 * 24574 is still below 2^32); any raw value
  //          becomes loose in fe_norm
  //   canonical: the one representation below p with every limb below 8192 (fe_canon), for hashing
  // 2^260 = 2^36 + 15632 (mod p) is limbs (7440, 1, 1024); 2^256 = 2^32 + 977 is limbs (977, 0, 64): the two folds.
  // Each routine is a list of assignments [name, expression] over u32 values, written once and used twice: as WGSL
  // here, and in tests/field.test.js run on exact numbers against BigInt, where the worst-case inputs prove that
  // no intermediate value reaches 2^32.
  var NL = 20, LB = 13;
  function fe13(b) { var o = []; b = BigInt(b); for (var i = 0; i < NL; i++) { o.push(Number(b & 8191n)); b >>= 13n; } return o; }
  // 2k·p with k borrowed from every limb into the one below: as a value still a multiple of p, but every limb is
  // then at least k times the largest loose limb, so "a + padP(k) - b" never goes below zero in any limb while b
  // is k loose values added up
  function padP(k) {
    var c = fe13(BigInt(2 * k) * S.P);
    for (var i = 0; i < NL - 1; i++) { c[i] += k * 8192; c[i + 1] -= k; }
    for (i = 0; i < NL; i++) if (c[i] < k * (i < NL - 1 ? 8192 : 511)) throw new Error('padP');
    return c;
  }
  function chain(st, v, n) { // carries along v0..v(n-1); the last carry is left in c
    for (var k = 0; k < n; k++) { if (k) st.push([v + k, v + k + ' + c']); st.push(['c', v + k + ' >> 13']); st.push([v + k, v + k + ' & 8191']); }
  }
  // a·b (or a² when sq: each cross product once, against the doubled limb). a loose, b loose or raw. Result r0..r19.
  function mulProg(sq) {
    var st = [], i, j, k;
    if (sq) for (i = 1; i < NL; i++) st.push(['d' + i, 'a' + i + ' * 2']);
    // the 39 columns of the product: at most 20 terms each
    for (k = 0; k < 2 * NL - 1; k++) {
      var terms = [];
      for (i = Math.max(0, k - NL + 1); i <= Math.min(k, NL - 1); i++) {
        j = k - i;
        if (!sq) terms.push('a' + i + ' * b' + j);
        else if (i < j) terms.push('a' + i + ' * d' + j);
        else if (i === j) terms.push('a' + i + ' * a' + i);
      }
      st.push(['t' + k, terms.join(' + ')]);
    }
    chain(st, 't', 39);
    st.push(['t39', 'c']);
    // limbs 20..39 stand for multiples of 2^260: folded down by (7440, 1, 1024) into r0..r21
    for (j = 0; j < 22; j++) {
      var e = [];
      if (j < 20) e.push('t' + j, '7440 * t' + (20 + j));
      if (j >= 1 && j <= 20) e.push('t' + (19 + j));
      if (j >= 2) e.push('1024 * t' + (18 + j));
      st.push(['r' + j, e.join(' + ')]);
    }
    chain(st, 'r', 22);
    st.push(['r22', 'c']);
    // what is left above 2^256: the top of limb 19 (by 2^256) and r20..r22 (by 2^260), folded once more; it is a
    // small number now, so the carries run out within the first limbs
    st.push(['g', 'r19 >> 9'], ['r19', 'r19 & 511']);
    st.push(['r0', 'r0 + 977 * g + 7440 * r20'], ['r1', 'r1 + r20 + 7440 * r21'], ['r2', 'r2 + 64 * g + 1024 * r20 + r21 + 7440 * r22'], ['r3', 'r3 + 1024 * r21 + r22'], ['r4', 'r4 + 1024 * r22']);
    chain(st, 'r', 6);
    st.push(['r6', 'r6 + c']);
    return st;
  }
  // a raw value made loose: the carries, then what stands above 2^256 folded back
  function normProg() {
    var st = [['r0', 'a0']], i;
    for (i = 0; i < NL - 1; i++) st.push(['c', 'r' + i + ' >> 13'], ['r' + i, 'r' + i + ' & 8191'], ['r' + (i + 1), 'a' + (i + 1) + ' + c']);
    st.push(['g', 'r19 >> 9'], ['r19', 'r19 & 511']);
    st.push(['r0', 'r0 + 977 * g'], ['c', 'r0 >> 13'], ['r0', 'r0 & 8191'], ['r1', 'r1 + c'], ['c', 'r1 >> 13'], ['r1', 'r1 & 8191']);
    st.push(['r2', 'r2 + 64 * g + c'], ['c', 'r2 >> 13'], ['r2', 'r2 & 8191'], ['r3', 'r3 + c']);
    return st;
  }
  // The carries of a + (2^256 - p): the bit that comes out at 2^256 says a >= p (a loose, so below 2p). With it,
  // the canonical form is that sum without the bit (a - p); without it, a with its own carries done.
  function geChain(st, keep) {
    for (var i = 0; i < NL; i++) {
      var e = 'a' + i + (i === 0 ? ' + 977' : i === 2 ? ' + 64' : '') + (i ? ' + c' : '');
      if (keep) { st.push(['w' + i, e]); if (i < NL - 1) st.push(['c', 'w' + i + ' >> 13'], ['w' + i, 'w' + i + ' & 8191']); }
      else if (i < NL - 1) st.push(['c', '(' + e + ') >> 13']);
      else st.push(['ge', '(' + e + ') >> 9']);
    }
    if (keep) st.push(['ge', 'w19 >> 9'], ['w19', 'w19 & 511']);
  }
  function canonProg() {
    var st = [['u0', 'a0']], i;
    for (i = 0; i < NL - 1; i++) st.push(['c', 'u' + i + ' >> 13'], ['u' + i, 'u' + i + ' & 8191'], ['u' + (i + 1), 'a' + (i + 1) + ' + c']);
    geChain(st, true);
    for (i = 0; i < NL; i++) st.push(['r' + i, 'select(u' + i + ', w' + i + ', ge == 1)']);
    return st;
  }
  // whether the canonical form of a (loose) is odd: p is odd, so taking it off flips the lowest bit
  function oddProg() {
    var st = [];
    geChain(st, false);
    st.push(['odd', '(a0 ^ ge) & 1']);
    return st;
  }
  var each = function (f) { var o = []; for (var i = 0; i < NL; i++) o.push(f(i)); return o; };
  // a - b and a - b - c, raw: with 2p and 4p added limb by limb (padP)
  function subrProg() { var c = padP(1); return each(function (i) { return ['r' + i, 'a' + i + ' + ' + c[i] + ' - b' + i]; }); }
  function sub2rProg() { var c = padP(2); return each(function (i) { return ['r' + i, 'a' + i + ' + ' + c[i] + ' - b' + i + ' - c' + i]; }); }
  var PROGS = { mul: mulProg(false), sqr: mulProg(true), norm: normProg(), canon: canonProg(), odd: oddProg(), subr: subrProg(), sub2r: sub2rProg() };

  // a routine as a WGSL function: `ins` are its Fe arguments, read into a0.., b0..; numbers get their u suffix
  function fnCode(name, ins, prog, ret) {
    var count = {}, seen = {}, c = 'fn ' + name + '(' + ins.map(function (v) { return v + ': Fe'; }).join(', ') + ') -> ' + (ret ? 'u32' : 'Fe') + ' {\n';
    prog.forEach(function (s) { count[s[0]] = (count[s[0]] || 0) + 1; });
    ins.forEach(function (v) { c += '  ' + each(function (i) { return 'let ' + v + i + ' = ' + v + '[' + i + '];'; }).join(' ') + '\n'; });
    prog.forEach(function (s) {
      c += '  ' + (seen[s[0]] ? '' : count[s[0]] > 1 ? 'var ' : 'let ') + s[0] + ' = ' + s[1].replace(/\b\d+\b/g, '$&u') + ';\n';
      seen[s[0]] = 1;
    });
    return c + '  return ' + (ret || 'Fe(' + each(function (i) { return 'r' + i; }).join(', ') + ')') + ';\n}\n';
  }
  // the same multiplication as loops, for the init pipeline: it runs once per chunk, and compiles in no time
  var MUL_LOOP = `
fn fe_mul(a: Fe, b: Fe) -> Fe {
  var t: array<u32, 40>;
  for (var i = 0u; i < 20u; i++) { for (var j = 0u; j < 20u; j++) { t[i + j] += a[i] * b[j]; } }
  var c = 0u;
  for (var k = 0u; k < 39u; k++) { let v = t[k] + c; t[k] = v & 8191u; c = v >> 13u; }
  t[39] = c;
  var r: array<u32, 23>;
  for (var j = 0u; j < 20u; j++) { let h = t[20u + j]; r[j] += t[j] + 7440u * h; r[j + 1u] += h; r[j + 2u] += 1024u * h; }
  c = 0u;
  for (var k = 0u; k < 22u; k++) { let v = r[k] + c; r[k] = v & 8191u; c = v >> 13u; }
  r[22] = c;
  let g = r[19] >> 9u; r[19] &= 511u;
  r[0] += 977u * g + 7440u * r[20]; r[1] += r[20] + 7440u * r[21]; r[2] += 64u * g + 1024u * r[20] + r[21] + 7440u * r[22];
  r[3] += 1024u * r[21] + r[22]; r[4] += 1024u * r[22];
  c = 0u;
  for (var k = 0u; k < 6u; k++) { let v = r[k] + c; r[k] = v & 8191u; c = v >> 13u; }
  r[6] += c;
  var o: Fe;
  for (var k = 0u; k < 20u; k++) { o[k] = r[k]; }
  return o;
}
fn fe_sqr(a: Fe) -> Fe { return fe_mul(a, a); }
`;
  // a^(p-2) by the usual addition chain (255 squarings, 15 multiplications), as a loop over (from, squarings,
  // times): two call sites instead of 26, which is what keeps the compile short
  var INV_LOOP = `
fn fe_inv(a: Fe) -> Fe {
  var v: array<Fe, 16>;
  v[0] = a;
  var prog = array<vec3<u32>, 15>(
    vec3<u32>(0u, 1u, 0u), vec3<u32>(1u, 1u, 0u), vec3<u32>(2u, 3u, 2u), vec3<u32>(3u, 3u, 2u), vec3<u32>(4u, 2u, 1u),
    vec3<u32>(5u, 11u, 5u), vec3<u32>(6u, 22u, 6u), vec3<u32>(7u, 44u, 7u), vec3<u32>(8u, 88u, 8u), vec3<u32>(9u, 44u, 7u),
    vec3<u32>(10u, 3u, 2u), vec3<u32>(11u, 23u, 6u), vec3<u32>(12u, 5u, 0u), vec3<u32>(13u, 3u, 1u), vec3<u32>(14u, 2u, 0u));
  for (var k = 0u; k < 15u; k++) {
    let pr = prog[k];
    var r = v[pr.x];
    for (var n = 0u; n < pr.y; n++) { r = fe_sqr(r); }
    v[k + 1u] = fe_mul(r, v[pr.z]);
  }
  return v[15];
}
`;
  // Every target's hash160 belongs to at most one key of a range, and a chunk checks each key once, so a chunk
  // never has more hits than targets: with room for one per target the hit list cannot overflow (see handle1)
  var MAXTARGETS = 32;
  var MAXHITS = MAXTARGETS;

  // the eight 32-bit words of a canonical element c, least significant first: each from the limbs that reach into it
  function words32() {
    var o = [];
    for (var j = 0; j < 8; j++) {
      var parts = [];
      for (var i = 0; i < NL; i++) {
        var sh = LB * i - 32 * j;
        if (sh >= 32 || sh <= -LB) continue;
        parts.push(sh === 0 ? 'c[' + i + ']' : sh > 0 ? '(c[' + i + '] << ' + sh + 'u)' : '(c[' + i + '] >> ' + (-sh) + 'u)');
      }
      o.push('  let x' + j + ' = ' + parts.join(' | ') + ';\n');
    }
    return o.join('');
  }
  // an Fe read from 20 words `step` apart in a buffer, and written back
  function feRead(buf, base, step) { return 'Fe(' + each(function (i) { return buf + '[' + base + (i ? ' + ' + (step ? i + 'u * ' + step : i + 'u') : '') + ']'; }).join(', ') + ')'; }

  // part: 'init' (the centre points of a chunk: the looped multiplication, no hashes) or 'step' (the search)
  function wgsl(WG, part, nonce) {
    var step = part !== 'init';
    return (nonce ? '// ' + nonce + '\n' : '') + `
alias Fe = array<u32, 20>;
struct Params { npts: u32, steps: u32, step_base: u32, K: u32 };
@group(0) @binding(0) var<uniform> prm: Params;
@group(0) @binding(1) var<storage, read_write> pts: array<u32>;
@group(0) @binding(2) var<storage, read_write> outb: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read> ini: array<u32>;
@group(0) @binding(4) var<storage, read> tbl: array<u32>;
@group(0) @binding(5) var<storage, read> tgs: array<u32>;
@group(0) @binding(6) var<storage, read_write> pre: array<u32>;

${step ? fnCode('fe_mul', ['a', 'b'], PROGS.mul) + fnCode('fe_sqr', ['a'], PROGS.sqr) : MUL_LOOP}
${fnCode('fe_norm', ['a'], PROGS.norm)}
${fnCode('fe_subr', ['a', 'b'], PROGS.subr)}
${fnCode('fe_sub2r', ['a', 'b', 'c'], PROGS.sub2r)}
${INV_LOOP}
// points: limb-major (limb c of point p at c * npts + p), x then y, loose
fn load(p: u32, which: u32) -> Fe {
  let n = prm.npts; let b = which * 20u * n + p;
  return ${feRead('pts', 'b', 'n')};
}
fn store(p: u32, which: u32, v: Fe) {
  let n = prm.npts; let b = which * 20u * n + p;
  ${each(function (i) { return 'pts[b + ' + i + 'u * n] = v[' + i + '];'; }).join(' ')}
}
` + (step ? `
${fnCode('fe_canon', ['a'], PROGS.canon)}
${fnCode('fe_odd', ['a'], PROGS.odd, 'odd')}
fn rotr(x: u32, n: u32) -> u32 { return (x >> n) | (x << (32u - n)); }
fn rotl(x: u32, n: u32) -> u32 { return (x << n) | (x >> (32u - n)); }
fn ssig0(x: u32) -> u32 { return rotr(x, 7u) ^ rotr(x, 18u) ^ (x >> 3u); }
fn ssig1(x: u32) -> u32 { return rotr(x, 17u) ^ rotr(x, 19u) ^ (x >> 10u); }
fn bsig0(x: u32) -> u32 { return rotr(x, 2u) ^ rotr(x, 13u) ^ rotr(x, 22u); }
fn bsig1(x: u32) -> u32 { return rotr(x, 6u) ^ rotr(x, 11u) ^ rotr(x, 25u); }
fn bswap(x: u32) -> u32 { return (x >> 24u) | ((x >> 8u) & 0xff00u) | ((x << 8u) & 0xff0000u) | (x << 24u); }
${shaCode() + ripemdCode()}
// hash160 of the compressed public key of the point (x, y), both loose, as five little-endian words
fn hash160(x: Fe, y: Fe) -> array<u32, 5> {
  let c = fe_canon(x);
${words32()}  let h = sha256_33(array<u32, 9>(((2u + fe_odd(y)) << 24u) | (x7 >> 8u), (x7 << 24u) | (x6 >> 8u), (x6 << 24u) | (x5 >> 8u), (x5 << 24u) | (x4 >> 8u),
    (x4 << 24u) | (x3 >> 8u), (x3 << 24u) | (x2 >> 8u), (x2 << 24u) | (x1 >> 8u), (x1 << 24u) | (x0 >> 8u), (x0 << 24u) | 0x800000u));
  return ripemd160_32(array<u32, 8>(bswap(h[0]), bswap(h[1]), bswap(h[2]), bswap(h[3]), bswap(h[4]), bswap(h[5]), bswap(h[6]), bswap(h[7])));
}
// the table: entry i is x, y and -y of (i + 1)·G for i < K, entry K those of (2K + 1)·G; canonical
fn tbl_pt(i: u32, which: u32) -> Fe {
  let b = (i * 3u + which) * 20u;
  return ${feRead('tbl', 'b', '')};
}
// the prefix products of a step, per thread: K + 1 loose elements, two limbs to a word, limb-major as the points
fn pre_put(t: u32, i: u32, v: Fe) {
  let n = prm.npts; let b = i * 10u * n + t;
  ${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(function (w) { return 'pre[b + ' + w + 'u * n] = v[' + 2 * w + '] | (v[' + (2 * w + 1) + '] << 14u);'; }).join(' ')}
}
fn pre_get(t: u32, i: u32) -> Fe {
  let n = prm.npts; let b = i * 10u * n + t;
  ${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(function (w) { return 'let w' + w + ' = pre[b + ' + w + 'u * n];'; }).join(' ')}
  return Fe(${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(function (w) { return 'w' + w + ' & 0x3fffu, w' + w + ' >> 14u'; }).join(', ')});
}
// targets: tgs[0] = how many, then five words each (room for ${MAXTARGETS}), then the sieve: 65536 bits, one set per target at
// the low 16 bits of its first word. All but one key in thousands stop there with one look, however many targets
// there are. Walking the list for every key cost 5% of the speed with ten targets and 13% with 32; so did a sieve
// of 1024 bits: one thread that goes on to the list holds up its whole group.
fn check(h: array<u32, 5>, t: u32, s: u32, off: u32) {
  let bit = h[0] & 65535u;
  if (((tgs[${1 + MAXTARGETS * 5}u + (bit >> 5u)] >> (bit & 31u)) & 1u) == 0u) { return; }
  let n = tgs[0];
  for (var i = 0u; i < n; i++) {
    let b = 1u + i * 5u;
    if (h[0] == tgs[b] && h[1] == tgs[b + 1u] && h[2] == tgs[b + 2u] && h[3] == tgs[b + 3u] && h[4] == tgs[b + 4u]) {
      let k = atomicAdd(&outb[0], 1u);
      if (k < ${MAXHITS}u) { let o = 1u + k * 4u; atomicStore(&outb[o], t); atomicStore(&outb[o + 1u], prm.step_base + s); atomicStore(&outb[o + 2u], off); atomicStore(&outb[o + 3u], i); }
    }
  }
}

// each thread holds one centre point C (key c) and per step checks the block c-K .. c+K: C ± i·G share the
// denominator x(i·G) - x(C), so one inversion (over K + 1 values, the last one for the move) serves 2K + 1 keys.
// Then C moves by (2K + 1)·G.
@compute @workgroup_size(${WG})
fn step(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = gid.x;
  if (t >= prm.npts) { return; }
  let K = prm.K;
  var cx = load(t, 0u); var cy = load(t, 1u);
  for (var s = 0u; s < prm.steps; s++) {
    var acc = Fe(1u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u);
    for (var i = 0u; i <= K; i++) { pre_put(t, i, acc); acc = fe_mul(acc, fe_subr(tbl_pt(i, 0u), cx)); }
    var iv = fe_inv(acc);
    var nx: Fe; var ny: Fe;
    for (var ii = i32(K); ii >= 0; ii--) {
      let i = u32(ii);
      let tx = tbl_pt(i, 0u);
      let id = fe_mul(iv, pre_get(t, i));
      iv = fe_mul(iv, fe_subr(tx, cx));
      // side 0: C + T, side 1: C - T (the same denominator, -y from the table); the last entry is the move, in
      // whose round the centre itself is hashed
      for (var side = 0u; side < 2u; side++) {
        if (i == K && side == 1u) { break; }
        let l = fe_mul(id, fe_subr(tbl_pt(i, 1u + side), cy));
        let x3 = fe_norm(fe_sub2r(fe_sqr(l), cx, tx));
        let y3 = fe_norm(fe_subr(fe_mul(l, fe_subr(cx, x3)), cy));
        var hx = cx; var hy = cy; var off = K;
        if (i == K) { nx = x3; ny = y3; }
        else { hx = x3; hy = y3; off = select(K - i - 1u, K + i + 1u, side == 0u); }
        check(hash160(hx, hy), t, s, off);
      }
    }
    cx = nx; cy = ny;
  }
  store(t, 0u, cx); store(t, 1u, cy);
}
` : `
fn ini_pt(i: u32, which: u32) -> Fe {
  let b = (i * 2u + which) * 20u;
  return ${feRead('ini', 'b', '')};
}
// the centre points from two small tables the host computed (Q_j and R_i, J = prm.steps of the first): thread
// p = i·J + j starts at Q_j + R_i, one affine addition (the host keeps the two tables apart: initPoints)
@compute @workgroup_size(${WG})
fn init(@builtin(global_invocation_id) gid: vec3<u32>) {
  let p = gid.x;
  if (p >= prm.npts) { return; }
  let J = prm.steps; let j = p % J; let i = p / J;
  let qx = ini_pt(j, 0u); let qy = ini_pt(j, 1u);
  let rx = ini_pt(J + i, 0u); let ry = ini_pt(J + i, 1u);
  let l = fe_mul(fe_inv(fe_norm(fe_subr(rx, qx))), fe_subr(ry, qy));
  let x3 = fe_norm(fe_sub2r(fe_sqr(l), qx, rx));
  store(p, 0u, x3);
  store(p, 1u, fe_norm(fe_subr(fe_mul(l, fe_subr(qx, x3)), qy)));
}
`);
  }

  // ---------- engine ----------
  // The engine's shape is how many keys a step checks around each centre (2K + 1) and how many threads there are.
  // Both are numbers the host sets (reshape), not part of the shader: one compile serves every shape.
  function Engine(device, adapterInfo, opts) {
    this.device = device; this.info = adapterInfo || {};
    this.WG = opts.WG;
    var d = device;
    this.modInit = d.createShaderModule({ code: wgsl(this.WG, 'init', opts.nonce) });
    this.modStep = d.createShaderModule({ code: wgsl(this.WG, 'step', opts.nonce) });
    this.bgl = d.createBindGroupLayout({ entries: [0, 1, 2, 3, 4, 5, 6].map(function (b) {
      return { binding: b, visibility: GPUShaderStage.COMPUTE, buffer: { type: b === 0 ? 'uniform' : b >= 3 && b <= 5 ? 'read-only-storage' : 'storage' } };
    }) });
    this.layout = d.createPipelineLayout({ bindGroupLayouts: [this.bgl] });
    this.uni = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.outBytes = (1 + MAXHITS * 4) * 4;
    this.out = d.createBuffer({ size: this.outBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.tgs = d.createBuffer({ size: (1 + MAXTARGETS * 5 + 2048) * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.read = d.createBuffer({ size: this.outBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    // a second one, so a search reads the last dispatch's answer while the next dispatch already runs (readTo)
    this.read2 = d.createBuffer({ size: this.outBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.reshape(opts.K, opts.threads);
  }
  // the bytes of the largest buffer of a shape: the prefix products, K + 1 per thread at 40 bytes each
  function preBytes(K, threads) { return threads * (K + 1) * 40; }
  // whether this device can hold that shape (a storage buffer's size has a limit, 128 MB unless the card offers more)
  Engine.prototype.fits = function (K, threads) {
    var lim = this.device.limits || {};
    return preBytes(K, threads) <= Math.min(lim.maxStorageBufferBindingSize || 134217728, lim.maxBufferSize || 268435456);
  };
  // Another shape on the same compiled engine: the buffers that depend on it are made anew. Not while a search
  // runs. A resume pos of the old shape then starts its chunk again (see search).
  Engine.prototype.reshape = function (K, threads) {
    var d = this.device, self = this;
    if (this.busy) throw new Error('the shape cannot change while a search runs');
    if (!(K >= 1 && K <= 4096) || K !== Math.floor(K)) throw new Error('K must be a whole number from 1 to 4096');
    // one centre point per thread; a step checks B = 2K + 1 keys around it
    var J = Math.min(256, threads);
    if (!(threads >= 1) || threads % J) throw new Error('threads must be a multiple of ' + J);
    if (!this.fits(K, threads)) throw new Error('this graphics card cannot hold ' + threads + ' threads of ' + (2 * K + 1) + ' keys a step');
    ['pts', 'ini', 'tbl', 'pre'].forEach(function (k) { if (self[k]) self[k].destroy(); });
    this.K = K; this.threads = this.npts = threads; this.B = 2 * K + 1; this.J = J;
    this.iniFor = null; this.stepMs = 0;
    this.pts = d.createBuffer({ size: threads * 40 * 4, usage: GPUBufferUsage.STORAGE });
    this.ini = d.createBuffer({ size: (J + threads / J) * 40 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.pre = d.createBuffer({ size: preBytes(K, threads), usage: GPUBufferUsage.STORAGE });
    // i·G for i = 1..K, then (2K + 1)·G: x, y, -y each
    var tb = new Uint32Array((K + 1) * 60), g = [S.GX, S.GY], q = g;
    for (var i = 0; i <= K; i++) {
      if (i === K) q = S.mulG(BigInt(this.B));
      tb.set(fe13(q[0]), i * 60); tb.set(fe13(q[1]), i * 60 + 20); tb.set(fe13(S.mod(-q[1])), i * 60 + 40);
      q = S.addAffine(q, g);
    }
    this.tbl = d.createBuffer({ size: tb.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(this.tbl, 0, tb);
    this.bg = d.createBindGroup({ layout: this.bgl, entries: [this.uni, this.pts, this.out, this.ini, this.tbl, this.tgs, this.pre].map(function (b, i) { return { binding: i, resource: { buffer: b } }; }) });
  };
  // reshape where the card may lack the memory: false, and the shape as it was, if it does not fit or the buffers
  // could not be made
  Engine.prototype.tryShape = async function (K, threads) {
    if (!this.fits(K, threads)) return false;
    var was = [this.K, this.threads];
    this.device.pushErrorScope('out-of-memory');
    this.reshape(K, threads);
    if (!(await this.device.popErrorScope())) return true;
    this.reshape(was[0], was[1]);
    return false;
  };
  // compiles both pipelines without blocking the page; returns the milliseconds it took
  Engine.prototype.compile = async function () {
    var d = this.device, L = this.layout, t0 = performance.now();
    var mods = [this.modInit, this.modStep];
    for (var i = 0; i < mods.length; i++) {
      var ci = mods[i].getCompilationInfo ? await mods[i].getCompilationInfo() : null;
      var errs = ci ? ci.messages.filter(function (m) { return m.type === 'error'; }) : [];
      if (errs.length) throw new Error('WGSL: ' + errs[0].message + ' (line ' + errs[0].lineNum + ')');
    }
    var r = await Promise.all([
      d.createComputePipelineAsync({ layout: L, compute: { module: this.modInit, entryPoint: 'init' } }),
      d.createComputePipelineAsync({ layout: L, compute: { module: this.modStep, entryPoint: 'step' } }),
    ]);
    this.pInit = r[0]; this.pStep = r[1];
    return performance.now() - t0;
  };
  // the hash160s to look for (hex strings); an empty list finds nothing
  Engine.prototype.targets = function (list) {
    if (list.length > MAXTARGETS) throw new Error('at most ' + MAXTARGETS + ' targets');
    var at = 1 + MAXTARGETS * 5, a = new Uint32Array(at + 2048);
    a[0] = list.length;
    list.forEach(function (h, i) {
      var w = S.hexToWords(h), bit = w[0] & 65535;
      a.set(w, 1 + i * 5);
      a[at + (bit >>> 5)] |= 1 << (bit & 31);
    });
    this.device.queue.writeBuffer(this.tgs, 0, a);
  };
  // steps of this dispatch, and the number of its first one (a hit reports base + its step)
  Engine.prototype.params = function (steps, stepBase) {
    this.device.queue.writeBuffer(this.uni, 0, new Uint32Array([this.npts, steps, stepBase, this.K]));
  };
  Engine.prototype.dispatch = function (pipe, n) {
    var enc = this.device.createCommandEncoder(), pass = enc.beginComputePass();
    pass.setPipeline(pipe); pass.setBindGroup(0, this.bg);
    pass.dispatchWorkgroups(Math.ceil(n / this.WG));
    pass.end();
    this.device.queue.submit([enc.finish()]);
  };
  Engine.prototype.readOut = async function () {
    var n = this.outBytes, enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.out, 0, this.read, 0, n);
    this.device.queue.submit([enc.finish()]);
    await this.read.mapAsync(GPUMapMode.READ, 0, n);
    var r = new Uint32Array(this.read.getMappedRange(0, n).slice(0));
    this.read.unmap();
    return r;
  };
  // the out buffer copied into read buffer i (0 or 1) after everything queued so far: a promise of its words. The
  // search queues its next dispatch before it waits for this, so the GPU never idles between dispatches (an idle
  // gap every 60 ms makes the driver keep a laptop GPU at half its clock: 27 W and ~1.1 GHz instead of 75 W)
  Engine.prototype.readTo = function (i) {
    var buf = i ? this.read2 : this.read, n = this.outBytes, enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.out, 0, buf, 0, n);
    this.device.queue.submit([enc.finish()]);
    return buf.mapAsync(GPUMapMode.READ, 0, n).then(function () { var r = new Uint32Array(buf.getMappedRange(0, n).slice(0)); buf.unmap(); return r; });
  };
  // the hits in a readOut: [{ t, s, off, ti }], from entry `from` on (the ones not seen yet)
  function hits(o, from) { var r = []; for (var k = from || 0; k < Math.min(o[0], MAXHITS); k++) r.push({ t: o[1 + k * 4], s: o[2 + k * 4], off: o[3 + k * 4], ti: o[4 + k * 4] }); return r; }
  Engine.prototype.clearOut = function () { this.device.queue.writeBuffer(this.out, 0, new Uint32Array(1 + MAXHITS * 4)); };
  // base, base + d, base + 2d, ...: n points (affine), added in Jacobian coordinates with one inversion for all
  function row(base, d, n) {
    var js = [], pref = [], acc = 1n, q = [base[0], base[1], 1n], i, out = new Array(n);
    for (i = 0; i < n; i++) { js.push(q); pref.push(acc); acc = acc * q[2] % S.P; q = S.jadd(q, d[0], d[1]); }
    var iv = S.inv(acc);
    for (i = n - 1; i >= 0; i--) {
      var zi = iv * pref[i] % S.P, zi2 = zi * zi % S.P;
      iv = iv * js[i][2] % S.P;
      out[i] = [js[i][0] * zi2 % S.P, js[i][1] * zi2 % S.P * zi % S.P];
    }
    return out;
  }
  // Centre of thread p = centre + p·seg. The host makes two small tables, the GPU adds them: thread p = i·J + j gets
  // Q_j + R_i with Q_j = (centre - Z + j·seg)·G and R_i = (Z + i·J·seg)·G. Z is far above any key searched, so a
  // Q is never an R or its negative (the addition has no case for equal points: with Z = 0, a chunk whose centre
  // was a multiple of seg gave one thread a wrong point, and its keys went unchecked). R depends on seg alone
  // and is kept for the next chunk.
  var Z = 1n << 200n;
  Engine.prototype.initPoints = async function (centre, seg) {
    var J = this.J, I = this.npts / J, c = this.iniFor, put = function (a, pts, at) { pts.forEach(function (p, i) { a.set(fe13(p[0]), (at + i) * 40); a.set(fe13(p[1]), (at + i) * 40 + 20); }); };
    if (BigInt(centre) + BigInt(seg) * BigInt(this.npts) >= Z) throw new Error('keys from 2^200 on are not searched here');
    var d = S.mulG(BigInt(seg));
    if (!c || c.seg !== seg) {
      c = this.iniFor = { seg: seg, a: new Uint32Array((J + I) * 40) };
      put(c.a, row(S.mulG(Z), S.mulG(BigInt(seg) * BigInt(J)), I), J);
    }
    put(c.a, row(S.mulG(S.N + BigInt(centre) - Z), d, J), 0);
    this.device.queue.writeBuffer(this.ini, 0, c.a);
    this.params(J, 0);
    this.dispatch(this.pInit, this.npts);
    await this.readOut();
  };

  // end to end against the reference: keys planted at the centre, on both sides, at the block's edges and across
  // threads must each be found exactly where they were put, under the right target, and nothing without targets
  Engine.prototype.selftest = async function (log) {
    log = log || function () {};
    var start = (1n << 69n) + 0x123456789abcdefn, seg = 1000003, n = this.npts, B = BigInt(this.B), K = this.K;
    var centre = start + BigInt(K);
    await this.initPoints(centre, seg);
    function keyAt(t, st, d) { return start + BigInt(t) * BigInt(seg) + BigInt(st) * B + BigInt(K + d); }
    var decoy = S.hash160OfKey(start - 5n); // a target that is not in the chunk
    var base = 0, rounds = [
      [[n >> 2, 0, 0], [n - 1, 1, 3]],
      [[3, 2, -2], [0, 0, K]],
      [[n >> 1, 3, -K], [Math.min(n - 1, 257), 1, 1], [n >> 3, 2, -1]],
    ];
    for (var r = 0; r < rounds.length; r++) {
      var plants = rounds[r], list = [decoy];
      plants.forEach(function (p) { list.push(S.hash160OfKey(keyAt(p[0], base + p[1], p[2]))); });
      this.targets(list);
      this.params(4, base);
      this.clearOut();
      this.dispatch(this.pStep, n);
      var got = hits(await this.readOut());
      for (var i = 0; i < plants.length; i++) {
        var p = plants[i], h = got.filter(function (x) { return x.ti === i + 1; })[0];
        if (!h || got.length !== plants.length || h.t !== p[0] || h.s !== base + p[1] || h.off !== K + p[2]) throw new Error('self-test: the key planted at thread ' + p[0] + ', step ' + (base + p[1]) + ', offset ' + p[2] + ' was not found there (' + JSON.stringify(got) + ')');
      }
      base += 4;
    }
    log('planted keys are found exactly: at the centre, on both sides, at the block edges, across threads, several at once');
    // with a target that is in none of these keys (an empty list would never even reach the comparison): nothing
    this.targets([decoy]);
    this.params(4, base);
    this.clearOut();
    this.dispatch(this.pStep, n);
    if ((await this.readOut())[0] !== 0) throw new Error('self-test: a key was "found" that is not the target');
    log('nothing is found where nothing is planted');
    return true;
  };

  // Steps per dispatch adapt so that one dispatch keeps the GPU busy for about `ms` (default 60): on a laptop
  // the same GPU draws the screen, and long dispatches freeze the browser or the whole desktop. stepMs: what one
  // step took when this engine last measured it in this shape (a search, bench or tune), to start from; else
  // from one step.
  function Pacer(ms, stepMs) { this.ms = ms || 60; this.steps = stepMs ? Math.max(1, Math.min(256, Math.round(this.ms / stepMs))) : 1; }
  Pacer.prototype.next = function (max) { return Math.max(1, Math.min(this.steps, max)); };
  Pacer.prototype.took = function (steps, ms) {
    if (ms <= 0) return;
    var want = steps * this.ms / ms;
    this.steps = Math.max(1, Math.min(256, Math.round(this.steps * 0.5 + want * 0.5)));
  };
  // the same from a time the dispatch took at most: only ever more steps (a hidden tab, see search)
  Pacer.prototype.grow = function (steps, ms) {
    var want = steps * this.ms / ms;
    if (want >= this.steps + 0.5) this.steps = Math.min(256, Math.max(this.steps + 1, Math.round(this.steps * 0.5 + want * 0.5)));
  };

  // brute force [from, to] (BigInt) for one target (a hash160 hex) or several (an array; the first is the main one).
  // onProgress({checked, total, rate, seconds}); opts.onHit(key, index) for every hit, checked against the reference.
  // Resolves with the main target's key, or null when the range ends or stop() is called.
  // opts: ms (target dispatch time), segMax, isPaused, resume. Thread p covers chunk + p·seg .. + seg - 1, its centre
  // K above. onProgress also gets pos { chunk, done, shape }: where the search stands (the outer chunk's offset from
  // `from` as a decimal string, the steps done in it, and the engine's shape K/threads/seg those steps mean);
  // opts.resume = such a pos continues from there (each step moves every centre by B keys, so the points start done·B
  // further on). Steps of another shape cover other keys: a pos of another shape (or none, from an older page)
  // continues at the start of its chunk, so no key is ever skipped.
  // One search at a time per engine: a new one waits until the one before has read its last answer (a fast Stop
  // and Start would otherwise map the same read buffer twice).
  // each thread's segment of a chunk, in keys: the range spread over the threads, at most segMax, whole steps
  Engine.prototype.seg = function (from, to, segMax) {
    var n = BigInt(this.npts), B = BigInt(this.B), seg = (BigInt(to) - BigInt(from) + n) / n, max = BigInt(segMax || 1 << 22);
    if (seg > max) seg = max;
    return ((seg + B - 1n) / B) * B;
  };
  // what a search's steps mean: a resume pos of another shape cannot continue on this engine
  Engine.prototype.shape = function (from, to, segMax) { return this.K + '/' + this.npts + '/' + this.seg(from, to, segMax); };
  Engine.prototype.search = function (from, to, targets, onProgress, opts) {
    var self = this; opts = opts || {};
    var list = (Array.isArray(targets) ? targets : [targets]).map(function (t) { return String(t).toLowerCase(); });
    var stopped = false, handle = { stop: function () { stopped = true; } };
    from = BigInt(from); to = BigInt(to);
    var total = to - from + 1n, n = BigInt(this.npts), B = BigInt(this.B), K = BigInt(this.K);
    var seg = this.seg(from, to, opts.segMax);
    var segSteps = Number(seg / B), pace = new Pacer(opts.ms, this.stepMs), seen = {};
    var shape = this.shape(from, to, opts.segMax);
    var before = this.running;
    this.busy = (this.busy || 0) + 1;
    handle.done = this.running = (async function () {
      if (before) await before.catch(function () { /* its own caller saw that */ });
      // A centre at key 2K + 1 would move by adding (2K + 1)·G to itself, and the addition has no case for equal
      // points: the first thread of a range that starts at key K + 1 would lose its first block and every key
      // after it. Such a range starts one key lower; the key below it is dropped like any hit outside the range.
      var chunk = from === K + 1n ? from - 1n : from, checked = 0n, t0 = performance.now(), first = 0;
      if (opts.resume) {
        chunk = from + BigInt(opts.resume.chunk);
        first = opts.resume.shape === shape ? Math.max(0, Math.min(segSteps, Number(opts.resume.done) || 0)) : 0;
        checked = (chunk - from) + BigInt(first) * B * n;
        if (checked < 0n) checked = 0n;
      }
      var checked0 = checked; // the rate counts only this run's keys
      self.targets(list);
      while (chunk <= to && !stopped) {
        await self.initPoints(chunk + K + BigInt(first) * B, Number(seg));
        self.clearOut();
        // one dispatch always waits in the queue while the answer to the one before is read: `pend` is that read,
        // with how far the search stood when it was queued. The out buffer is not cleared inside a chunk (a clear
        // would race the queued dispatch): its count only grows, and `used` says how many entries are handled
        var pend = null, cur = null, rb = 0, used = 0, lastT = performance.now(), found = null;
        var handle1 = function (o, at) {
          // more hits than targets cannot happen (MAXHITS); if it ever did, some would be lost, so the search ends
          // with an error rather than report a piece it may not have searched in full
          if (o[0] > MAXHITS) throw new Error('the engine reported more hits than targets (' + o[0] + '): the piece is not reported');
          var hs = hits(o, used); used = o[0];
          for (var i = 0; i < hs.length; i++) {
            var h = hs[i], key = chunk + BigInt(h.t) * seg + BigInt(h.s) * B + BigInt(h.off);
            if (key < from || key > to || seen[key] || S.hash160OfKey(key) !== list[h.ti]) continue;
            seen[key] = 1;
            if (opts.onHit) opts.onHit(key, h.ti);
            if (h.ti === 0) found = key;
          }
          var now = performance.now();
          if (at.visible) { pace.took(at.steps, now - lastT); self.stepMs = pace.ms / pace.steps; }
          else if (at.batch > 1) pace.grow(at.st, (now - lastT + 1000) / at.batch);
          lastT = now;
          var sec = (now - t0) / 1000;
          if (onProgress) onProgress({ checked: at.checked > total ? total : at.checked, total: total, rate: Number(at.checked - checked0) / sec, seconds: sec, pos: { chunk: (chunk - from).toString(), done: at.done, shape: shape } });
        };
        for (var done = first; done < segSteps && !stopped && found === null;) {
          if (opts.isPaused && opts.isPaused()) {
            if (pend) { handle1(await pend.p, pend); pend = null; }
            var p0 = performance.now();
            while (opts.isPaused() && !stopped) await new Promise(function (r) { setTimeout(r, 250); });
            t0 += performance.now() - p0; lastT = performance.now();
            if (stopped || found !== null) break;
          }
          // A hidden tab (searching in the background) gets its GPU answers about once a second, as Chrome
          // slows its timers: so queue about two seconds of dispatches before one answer, and keep the pace
          // learned while visible (it would read the slow answers as a slow GPU and shrink to nothing): the
          // engine remembers what a step took, from one search to the next and from tune. Without any of that
          // (a kept shape, first started hidden) the pace only grows, from the most a dispatch can have taken: an
          // answer comes at most a second late or early, so a batch lasted no longer than the time since the last
          // answer plus that second. Where answers do come once a second, that never shows a batch shorter than
          // two seconds, and such a search runs single steps until the tab is seen.
          var visible = document.visibilityState !== 'hidden';
          var st = pace.next(segSteps - done), base = done;
          var batch = visible ? 1 : Math.max(1, Math.round(2000 / pace.ms));
          for (var b = 0; b < batch && done < segSteps; b++) {
            st = Math.max(1, Math.min(st, segSteps - done));
            self.params(st, done);
            self.dispatch(self.pStep, self.npts);
            done += st;
            checked += BigInt(st) * B * n;
          }
          cur = { p: self.readTo(rb), done: done, checked: checked, steps: done - base, visible: visible && batch === 1, st: st, batch: batch };
          rb ^= 1;
          // the one before is read while this one runs. If handling it fails (a caller's callback throws), this
          // one's read is still waited for: the next search must not find a read buffer mapped
          if (pend) { try { handle1(await pend.p, pend); } catch (err) { await cur.p.catch(function () {}); throw err; } }
          pend = cur;
        }
        // the last answer of the chunk (or of a stop): nothing is left mapped or unread
        if (pend) { handle1(await pend.p, pend); pend = null; }
        if (found !== null) return found;
        chunk += seg * n; first = 0;
      }
      return null;
    })();
    var free = function () { self.busy--; };
    handle.done.then(free, free);
    return handle;
  };

  // keys per second on a chunk far from any target, for `seconds`, paced like the search
  Engine.prototype.bench = async function (seconds, onProgress, ms) {
    var start = (1n << 70n) + 12345n, keys = 0, seg = 1 << 30, pace = new Pacer(ms, this.stepMs);
    this.targets([S.hash160OfKey(3n)]);
    await this.initPoints(start, seg);
    // as the search: the next dispatch is queued before the answer to the one before is awaited
    var t0 = performance.now(), lastT = t0, pend = null, rb = 0;
    for (var base = 0; (performance.now() - t0) / 1000 < seconds;) {
      var st = pace.next(1 << 20);
      this.params(st, base);
      this.dispatch(this.pStep, this.npts);
      base += st;
      var cur = { p: this.readTo(rb), st: st }; rb ^= 1;
      if (pend) {
        await pend.p;
        var now = performance.now();
        pace.took(pend.st, now - lastT); lastT = now;
        keys += pend.st * this.B * this.npts;
        if (onProgress) { var sec = (now - t0) / 1000; onProgress(keys / sec, keys, sec); } // the average so far, and what it is made of
      }
      pend = cur;
    }
    if (pend) { await pend.p; keys += pend.st * this.B * this.npts; }
    var rate = keys / ((performance.now() - t0) / 1000);
    this.stepMs = this.B * this.npts / rate * 1000;
    return rate;
  };

  // The shapes tune() walks, as [K, threads]: a step of each checks about twice the keys of the one before
  var LADDER = [[32, 2048], [32, 4096], [64, 4096], [64, 8192], [128, 8192], [128, 16384], [128, 32768], [128, 65536], [128, 131072]];
  // Picks the shape for this card: up the ladder while the speed still grows and a step stays short. One dispatch
  // is at least one step, and the same card draws the screen: a slow card with a large shape would freeze it. A
  // larger shape saves inversions (more keys share one) and fills a large card (more threads), but holds more
  // memory: the prefix products of the largest are 0.7 GB, which only a card fast enough to get there is given.
  // opts: seconds (measured per shape, 0.5), warm (seconds before the first, 1: clocks going up), stepMs (the
  // longest step, 25), onShape({K, threads}, rate). Leaves the engine in the shape it picked: { K, threads, rate }.
  Engine.prototype.tune = async function (opts) {
    opts = opts || {};
    var sec = opts.seconds || 0.5, stepMs = opts.stepMs || 25, best = null;
    for (var i = 0; i < LADDER.length; i++) {
      var K = LADDER[i][0], T = LADDER[i][1];
      if (!(await this.tryShape(K, T))) break;
      if (!i && opts.warm !== 0) await this.bench(opts.warm || 1);
      var rate = await this.bench(sec);
      if (opts.onShape) opts.onShape({ K: K, threads: T }, rate);
      if (best && (T * (2 * K + 1) / rate * 1000 > stepMs || rate < best.rate * 1.02)) break;
      best = { K: K, threads: T, rate: rate };
    }
    if (!best) throw new Error('the graphics card could not hold the buffers of the engine');
    if (this.K !== best.K || this.threads !== best.threads) this.reshape(best.K, best.threads);
    this.stepMs = best.threads * (2 * best.K + 1) / best.rate * 1000;
    return best;
  };

  // opts: K, threads (the shape, see reshape; without them a small one that suits any card, for tune to raise), WG,
  // log (gets the adapter before the compile), nonce (tests: skip the shader cache)
  async function create(opts) {
    opts = Object.assign({ K: 64, WG: 64, threads: 4096, powerPreference: 'high-performance' }, opts || {});
    if (!root.navigator || !navigator.gpu) throw new Error('This browser has no WebGPU');
    var adapter = await navigator.gpu.requestAdapter({ powerPreference: opts.powerPreference });
    if (!adapter) throw new Error('No GPU adapter');
    var info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
    if (opts.log) opts.log('Adapter: ' + ([info.vendor, info.architecture, info.description].filter(Boolean).join(' — ') || 'unnamed') + (adapter.isFallbackAdapter ? ' (software fallback)' : ''));
    // the prefix products of a large shape need a storage buffer above the default limit: ask for what the card offers
    var lim = {}, al = adapter.limits || {};
    ['maxStorageBufferBindingSize', 'maxBufferSize'].forEach(function (k) { if (al[k]) lim[k] = al[k]; });
    var device = await adapter.requestDevice({ requiredLimits: lim });
    var lost = null;
    device.lost.then(function (l) { lost = l; });
    var e = new Engine(device, info, opts);
    e.lostReason = function () { return lost ? (lost.message || lost.reason || 'device lost') : null; };
    try { e.compileMs = await e.compile(); }
    catch (err) {
      if (lost || /dropped|lost/i.test(err && err.message)) throw new Error('the GPU driver reset while compiling the engine (' + (e.lostReason() || err.message) + '). The CPU engine still works.');
      throw err;
    }
    return e;
  }

  root.BBGpu = { create: create, wgsl: wgsl, field: { progs: PROGS, limbs: fe13, padP: padP } };
})(typeof self !== 'undefined' ? self : globalThis);
