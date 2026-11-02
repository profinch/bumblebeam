/* BumbleBeam puzzle engine on WebGPU: brute force over a key range, written from scratch in WGSL.
   secp256k1 field arithmetic on eight 32-bit limbs (32x32->64 products from 16-bit halves: WGSL has no 64-bit
   integers); each thread checks the 2K + 1 keys around a centre point with one shared inversion per step;
   SHA-256 and RIPEMD-160 and the hash160 comparison on the GPU. Before any search it tests itself against the
   BigInt reference (secp.js). The shader is generated: unrolled parts run faster but take browsers (D3D on
   Windows above all) far longer to compile, so each part has a rolled form too (CFG below).
   A classic script; needs BBSecp. Exposes BBGpu. */
(function (root) {
  'use strict';
  var S = root.BBSecp;

  // ---------- WGSL ----------
  function hex(x) { return '0x' + (x >>> 0).toString(16) + 'u'; }
  function limbs(b) { var o = []; for (var i = 0; i < 8; i++) { o.push(hex(Number(b & 0xffffffffn))); b >>= 32n; } return 'Fe(' + o.join(', ') + ')'; }

  function shaCode() {
    var K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    var c = 'fn sha256_33(m: array<u32, 16>) -> array<u32, 8> {\n';
    for (var i = 0; i < 16; i++) c += '  let w' + i + ' = m[' + i + '];\n';
    for (i = 16; i < 64; i++) c += '  let w' + i + ' = w' + (i - 16) + ' + ssig0(w' + (i - 15) + ') + w' + (i - 7) + ' + ssig1(w' + (i - 2) + ');\n';
    c += '  var a = 0x6a09e667u; var b = 0xbb67ae85u; var c = 0x3c6ef372u; var d = 0xa54ff53au; var e = 0x510e527fu; var f = 0x9b05688cu; var g = 0x1f83d9abu; var h = 0x5be0cd19u;\n  var t1: u32; var t2: u32;\n';
    for (i = 0; i < 64; i++) c += '  t1 = h + bsig1(e) + ((e & f) ^ (~e & g)) + ' + hex(K[i]) + ' + w' + i + '; t2 = bsig0(a) + ((a & b) ^ (a & c) ^ (b & c)); h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;\n';
    c += '  return array<u32, 8>(a + 0x6a09e667u, b + 0xbb67ae85u, c + 0x3c6ef372u, d + 0xa54ff53au, e + 0x510e527fu, f + 0x9b05688cu, g + 0x1f83d9abu, h + 0x5be0cd19u);\n}\n';
    return c;
  }
  function ripemdCode() {
    var RL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8, 3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12, 1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2, 4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13];
    var RR = [5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12, 6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2, 15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13, 8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14, 12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11];
    var SL = [11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8, 7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12, 11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5, 11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12, 9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6];
    var SR = [8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6, 9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11, 9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5, 15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8, 8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11];
    var KL = [0, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e], KR = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0];
    function f(j, x, y, z) {
      if (j < 16) return '(' + x + ' ^ ' + y + ' ^ ' + z + ')';
      if (j < 32) return '((' + x + ' & ' + y + ') | (~' + x + ' & ' + z + '))';
      if (j < 48) return '((' + x + ' | ~' + y + ') ^ ' + z + ')';
      if (j < 64) return '((' + x + ' & ' + z + ') | (' + y + ' & ~' + z + '))';
      return '(' + x + ' ^ (' + y + ' | ~' + z + '))';
    }
    var c = 'fn ripemd160_32(m: array<u32, 16>) -> array<u32, 5> {\n';
    for (var i = 0; i < 16; i++) c += '  let x' + i + ' = m[' + i + '];\n';
    c += '  var al = 0x67452301u; var bl = 0xefcdab89u; var cl = 0x98badcfeu; var dl = 0x10325476u; var el = 0xc3d2e1f0u;\n';
    c += '  var ar = al; var br = bl; var cr = cl; var dr = dl; var er = el; var t: u32;\n';
    for (var j = 0; j < 80; j++) {
      var r = j >> 4;
      c += '  t = rotl(al + ' + f(j, 'bl', 'cl', 'dl') + ' + x' + RL[j] + (KL[r] ? ' + ' + hex(KL[r]) : '') + ', ' + SL[j] + 'u) + el; al = el; el = dl; dl = rotl(cl, 10u); cl = bl; bl = t;\n';
      c += '  t = rotl(ar + ' + f(79 - j, 'br', 'cr', 'dr') + ' + x' + RR[j] + (KR[r] ? ' + ' + hex(KR[r]) : '') + ', ' + SR[j] + 'u) + er; ar = er; er = dr; dr = rotl(cr, 10u); cr = br; br = t;\n';
    }
    c += '  return array<u32, 5>(0xefcdab89u + cl + dr, 0x98badcfeu + dl + er, 0x10325476u + el + ar, 0xc3d2e1f0u + al + br, 0x67452301u + bl + cr);\n}\n';
    return c;
  }

  // fe_mul as straight-line code: the 8x8 limb product into t0..t15, then the reduction by 2^256 = 2^32 + 977
  function mulCode() {
    var c = 'fn fe_mul(a: Fe, b: Fe) -> Fe {\n';
    var i, j;
    for (i = 0; i < 8; i++) c += '  let a' + i + ' = a[' + i + ']; let b' + i + ' = b[' + i + '];\n';
    for (i = 0; i < 16; i++) c += '  var t' + i + ' = 0u;\n';
    c += '  var m: vec2<u32>; var s: vec2<u32>; var c = 0u;\n';
    for (i = 0; i < 8; i++) {
      c += '  c = 0u;\n';
      for (j = 0; j < 8; j++) c += '  m = mw(a' + i + ', b' + j + '); s = adc(t' + (i + j) + ', m.x, c); t' + (i + j) + ' = s.x; c = m.y + s.y;\n';
      c += '  t' + (i + 8) + ' = c;\n';
    }
    c += reduceCode();
    return c;
  }

  function reduceCode() {
    var c = '', i;
    // r = L + (H << 32): r0..r8 plus r9
    c += '  var r0 = t0; var r1: u32; var r2: u32; var r3: u32; var r4: u32; var r5: u32; var r6: u32; var r7: u32; var r8: u32; var r9: u32;\n  c = 0u;\n';
    for (i = 0; i < 8; i++) c += '  s = adc(' + (i + 1 < 8 ? 't' + (i + 1) : '0u') + ', t' + (i + 8) + ', c); r' + (i + 1) + ' = s.x; c = s.y;\n';
    c += '  r9 = c; c = 0u;\n';
    // + H * 977
    for (i = 0; i < 8; i++) c += '  m = mw(t' + (i + 8) + ', 977u); s = adc(r' + i + ', m.x, c); r' + i + ' = s.x; c = m.y + s.y;\n';
    c += '  s = adc(r8, c, 0u); r8 = s.x; r9 = r9 + s.y;\n';
    // fold r8 + r9 * 2^32 once more
    c += '  let m0 = mw(r8, 977u);\n  var o: Fe;\n';
    c += '  s = adc(r0, m0.x, 0u); o[0] = s.x;\n';
    c += '  s = adc(r1, m0.y + r9 * 977u, s.y); let c1 = s.y; s = adc(s.x, r8, 0u); o[1] = s.x; c = c1 + s.y;\n';
    c += '  s = adc(r2, r9, c); o[2] = s.x; c = s.y;\n';
    for (i = 3; i < 8; i++) c += '  s = adc(r' + i + ', 0u, c); o[' + i + '] = s.x; c = s.y;\n';
    c += '  if (c != 0u) { o = add_c(o); }\n  if (ge_p(o)) { o = add_c(o); }\n  return o;\n}\n';
    return c;
  }
  // a² with each cross product once (doubled), then the squares on the diagonal
  function sqrCode() {
    var c = 'fn fe_sqr(a: Fe) -> Fe {\n', i, j;
    for (i = 0; i < 8; i++) c += '  let a' + i + ' = a[' + i + '];\n';
    for (i = 0; i < 16; i++) c += '  var t' + i + ' = 0u;\n';
    c += '  var m: vec2<u32>; var s: vec2<u32>; var c = 0u;\n';
    for (i = 0; i < 7; i++) {
      c += '  c = 0u;\n';
      for (j = i + 1; j < 8; j++) c += '  m = mw(a' + i + ', a' + j + '); s = adc(t' + (i + j) + ', m.x, c); t' + (i + j) + ' = s.x; c = m.y + s.y;\n';
      c += '  t' + (i + 8) + ' = c;\n';
    }
    for (i = 15; i > 0; i--) c += '  t' + i + ' = (t' + i + ' << 1u) | (t' + (i - 1) + ' >> 31u);\n';
    c += '  t0 = t0 << 1u;\n  c = 0u;\n';
    for (i = 0; i < 8; i++) c += '  m = mw(a' + i + ', a' + i + '); s = adc(t' + (2 * i) + ', m.x, c); t' + (2 * i) + ' = s.x; s = adc(t' + (2 * i + 1) + ', m.y, s.y); t' + (2 * i + 1) + ' = s.x; c = s.y;\n';
    c += reduceCode();
    return c;
  }
  // ---------- rolled forms ----------
  var SHA_K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  var RMD = {
    RL: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8, 3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12, 1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2, 4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13],
    RR: [5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12, 6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2, 15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13, 8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14, 12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11],
    SL: [11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8, 7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12, 11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5, 11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12, 9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6],
    SR: [8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6, 9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11, 9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5, 15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8, 8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11],
  };
  // the constant tables after the step table in `tbl`: SHA-256's 64 K, then RIPEMD-160's RL, RR, SL, SR
  function constTable() { return SHA_K.concat(RMD.RL, RMD.RR, RMD.SL, RMD.SR); }

  // SHA-256 as four passes of 16 unrolled rounds over a rolling 16-word schedule; K from tbl
  function shaRolled() {
    var c = 'fn sha256_33(m: array<u32, 16>) -> array<u32, 8> {\n', i;
    for (i = 0; i < 16; i++) c += '  var w' + i + ' = m[' + i + '];\n';
    c += '  var a = 0x6a09e667u; var b = 0xbb67ae85u; var c = 0x3c6ef372u; var d = 0xa54ff53au; var e = 0x510e527fu; var f = 0x9b05688cu; var g = 0x1f83d9abu; var h = 0x5be0cd19u;\n  var t1: u32; var t2: u32;\n';
    c += '  for (var blk = 0u; blk < 4u; blk++) {\n    let kb = CT + blk * 16u;\n';
    for (i = 0; i < 16; i++) {
      c += '    if (blk > 0u) { w' + i + ' = w' + i + ' + ssig0(w' + ((i + 1) % 16) + ') + w' + ((i + 9) % 16) + ' + ssig1(w' + ((i + 14) % 16) + '); }\n';
      c += '    t1 = h + bsig1(e) + ((e & f) ^ (~e & g)) + tbl[kb + ' + i + 'u] + w' + i + '; t2 = bsig0(a) + ((a & b) ^ (a & c) ^ (b & c)); h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;\n';
    }
    c += '  }\n  return array<u32, 8>(a + 0x6a09e667u, b + 0xbb67ae85u, c + 0x3c6ef372u, d + 0xa54ff53au, e + 0x510e527fu, f + 0x9b05688cu, g + 0x1f83d9abu, h + 0x5be0cd19u);\n}\n';
    return c;
  }
  // RIPEMD-160 as one loop of 80 steps per line; word order and rotations from tbl
  var RMD_ROLLED = `
fn rmd_f(r: u32, x: u32, y: u32, z: u32) -> u32 {
  switch r {
    case 0u: { return x ^ y ^ z; }
    case 1u: { return (x & y) | (~x & z); }
    case 2u: { return (x | ~y) ^ z; }
    case 3u: { return (x & z) | (y & ~z); }
    default: { return x ^ (y | ~z); }
  }
}
fn rmd_kl(r: u32) -> u32 { switch r { case 0u: { return 0u; } case 1u: { return 0x5a827999u; } case 2u: { return 0x6ed9eba1u; } case 3u: { return 0x8f1bbcdcu; } default: { return 0xa953fd4eu; } } }
fn rmd_kr(r: u32) -> u32 { switch r { case 0u: { return 0x50a28be6u; } case 1u: { return 0x5c4dd124u; } case 2u: { return 0x6d703ef3u; } case 3u: { return 0x7a6d76e9u; } default: { return 0u; } } }
fn ripemd160_32(m: array<u32, 16>) -> array<u32, 5> {
  var x = m;
  var al = 0x67452301u; var bl = 0xefcdab89u; var cl = 0x98badcfeu; var dl = 0x10325476u; var el = 0xc3d2e1f0u;
  var ar = al; var br = bl; var cr = cl; var dr = dl; var er = el; var t: u32;
  for (var j = 0u; j < 80u; j++) {
    let r = j / 16u;
    t = rotl(al + rmd_f(r, bl, cl, dl) + x[tbl[CT + 64u + j]] + rmd_kl(r), tbl[CT + 224u + j]) + el; al = el; el = dl; dl = rotl(cl, 10u); cl = bl; bl = t;
    t = rotl(ar + rmd_f(4u - r, br, cr, dr) + x[tbl[CT + 144u + j]] + rmd_kr(r), tbl[CT + 304u + j]) + er; ar = er; er = dr; dr = rotl(cr, 10u); cr = br; br = t;
  }
  return array<u32, 5>(0xefcdab89u + cl + dr, 0x98badcfeu + dl + er, 0x10325476u + el + ar, 0xc3d2e1f0u + al + br, 0x67452301u + bl + cr);
}
`;
  var MUL_LOOP = `
fn fe_mul(a: Fe, b: Fe) -> Fe {
  var t: array<u32, 16>;
  for (var i = 0u; i < 8u; i++) {
    var c = 0u;
    for (var j = 0u; j < 8u; j++) { let m = mw(a[i], b[j]); let s = adc(t[i + j], m.x, c); t[i + j] = s.x; c = m.y + s.y; }
    t[i + 8u] = c;
  }
  var r: array<u32, 10>;
  for (var i = 0u; i < 8u; i++) { r[i] = t[i]; }
  var c = 0u;
  for (var i = 0u; i < 8u; i++) { let s = adc(r[i + 1u], t[i + 8u], c); r[i + 1u] = s.x; c = s.y; }
  r[9] = c; c = 0u;
  for (var i = 0u; i < 8u; i++) { let m = mw(t[i + 8u], 977u); let s = adc(r[i], m.x, c); r[i] = s.x; c = m.y + s.y; }
  var s = adc(r[8], c, 0u); r[8] = s.x; r[9] = r[9] + s.y;
  let m0 = mw(r[8], 977u);
  var o: Fe;
  s = adc(r[0], m0.x, 0u); o[0] = s.x;
  s = adc(r[1], m0.y + r[9] * 977u, s.y); let c1 = s.y; s = adc(s.x, r[8], 0u); o[1] = s.x; c = c1 + s.y;
  s = adc(r[2], r[9], c); o[2] = s.x; c = s.y;
  for (var i = 3u; i < 8u; i++) { s = adc(r[i], 0u, c); o[i] = s.x; c = s.y; }
  if (c != 0u) { o = add_c(o); }
  if (ge_p(o)) { o = add_c(o); }
  return o;
}
fn fe_sqr(a: Fe) -> Fe { return fe_mul(a, a); }
`;
  var INV_CHAIN = `
fn fe_sqrn(a: Fe, n: u32) -> Fe { var r = a; for (var i = 0u; i < n; i++) { r = fe_sqr(r); } return r; }
fn fe_inv(a: Fe) -> Fe {
  let x2 = fe_mul(fe_sqr(a), a);
  let x3 = fe_mul(fe_sqr(x2), a);
  let x6 = fe_mul(fe_sqrn(x3, 3u), x3);
  let x9 = fe_mul(fe_sqrn(x6, 3u), x3);
  let x11 = fe_mul(fe_sqrn(x9, 2u), x2);
  let x22 = fe_mul(fe_sqrn(x11, 11u), x11);
  let x44 = fe_mul(fe_sqrn(x22, 22u), x22);
  let x88 = fe_mul(fe_sqrn(x44, 44u), x44);
  let x176 = fe_mul(fe_sqrn(x88, 88u), x88);
  let x220 = fe_mul(fe_sqrn(x176, 44u), x44);
  let x223 = fe_mul(fe_sqrn(x220, 3u), x3);
  var t = fe_mul(fe_sqrn(x223, 23u), x22);
  t = fe_mul(fe_sqrn(t, 5u), a);
  t = fe_mul(fe_sqrn(t, 3u), x2);
  return fe_mul(fe_sqrn(t, 2u), a);
}
`;
  // a^(p-2) by the same chain, as a loop over (from, squarings, times): two call sites instead of 26
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

  // the step body: three hash call sites (centre, +, -) or one inside a loop over the sides
  function stepBody(sites) {
    if (sites === 3) return `
    if (hit(hash160(cx, cy), tg0, tg4)) { report(t, s, K); }
    var acc: Fe; acc[0] = 1u;
    for (var i = 0u; i <= K; i++) { pref[i] = acc; acc = fe_mul(acc, fe_sub(tbl_pt(i, 0u), cx)); }
    var iv = fe_inv(acc);
    var nx: Fe; var ny: Fe;
    for (var ii: i32 = i32(K); ii >= 0; ii--) {
      let i = u32(ii);
      let tx = tbl_pt(i, 0u); let ty = tbl_pt(i, 1u);
      let id = fe_mul(iv, pref[i]);
      iv = fe_mul(iv, fe_sub(tx, cx));
      let lp = fe_mul(fe_sub(ty, cy), id);
      let xp = fe_sub(fe_sub(fe_sqr(lp), cx), tx);
      let yp = fe_sub(fe_mul(lp, fe_sub(cx, xp)), cy);
      if (i == K) { nx = xp; ny = yp; continue; }
      if (hit(hash160(xp, yp), tg0, tg4)) { report(t, s, K + i + 1u); }
      let lm = fe_mul(fe_sub(fe_sub(Fe(0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u), ty), cy), id);
      let xm = fe_sub(fe_sub(fe_sqr(lm), cx), tx);
      let ym = fe_sub(fe_mul(lm, fe_sub(cx, xm)), cy);
      if (hit(hash160(xm, ym), tg0, tg4)) { report(t, s, K - i - 1u); }
    }
    cx = nx; cy = ny;`;
    return `
    var acc: Fe; acc[0] = 1u;
    for (var i = 0u; i <= K; i++) { pref[i] = acc; acc = fe_mul(acc, fe_sub(tbl_pt(i, 0u), cx)); }
    var iv = fe_inv(acc);
    var nx: Fe; var ny: Fe;
    for (var ii: i32 = i32(K); ii >= 0; ii--) {
      let i = u32(ii);
      let tx = tbl_pt(i, 0u); let ty = tbl_pt(i, 1u);
      let id = fe_mul(iv, pref[i]);
      iv = fe_mul(iv, fe_sub(tx, cx));
      // side 0: C + T, side 1: C - T (the same denominator, -ty); the last entry is the move, in whose round
      // the centre itself is hashed
      for (var side = 0u; side < 2u; side++) {
        if (i == K && side == 1u) { break; }
        var hx = cx; var hy = cy; var off = K;
        var ly = fe_sub(ty, cy);
        if (side == 1u) { ly = fe_sub(fe_sub(Fe(0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u), ty), cy); }
        let l = fe_mul(ly, id);
        let x3 = fe_sub(fe_sub(fe_sqr(l), cx), tx);
        let y3 = fe_sub(fe_mul(l, fe_sub(cx, x3)), cy);
        if (i == K) { nx = x3; ny = y3; }
        else { hx = x3; hy = y3; off = select(K - i - 1u, K + i + 1u, side == 0u); }
        if (hit(hash160(hx, hy), tg0, tg4)) { report(t, s, off); }
      }
    }
    cx = nx; cy = ny;`;
  }

  // cfg: { mul: 'unrolled' | 'loop', inv: 'chain' | 'loop', hash: 'unrolled' | 'rolled', sites: 1 | 3 }
  function wgsl(K, WG, cfg, nonce) {
    cfg = cfg || {};
    var fast = cfg.mul === 'unrolled';
    return (nonce ? '// ' + nonce + '\n' : '') + `
alias Fe = array<u32, 8>;
struct Params { start: array<vec4<u32>, 2>, tgt: array<vec4<u32>, 2>, npts: u32, seg: u32, steps: u32, step_base: u32 };
@group(0) @binding(0) var<uniform> prm: Params;
@group(0) @binding(1) var<storage, read_write> pts: array<u32>;
@group(0) @binding(2) var<storage, read_write> outb: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> ini: array<u32>;
@group(0) @binding(4) var<storage, read> tbl: array<u32>;

const K: u32 = ${K}u;
const CT: u32 = ${(K + 1) * 16}u;

fn mw(a: u32, b: u32) -> vec2<u32> {
  let a0 = a & 0xffffu; let a1 = a >> 16u; let b0 = b & 0xffffu; let b1 = b >> 16u;
  let p00 = a0 * b0; let p01 = a0 * b1; let p10 = a1 * b0; let p11 = a1 * b1;
  let mid = p01 + p10; let mc = select(0u, 0x10000u, mid < p01);
  let lo = p00 + (mid << 16u); let lc = select(0u, 1u, lo < p00);
  return vec2<u32>(lo, p11 + (mid >> 16u) + mc + lc);
}
fn adc(a: u32, b: u32, c: u32) -> vec2<u32> {
  let s = a + b; let c1 = select(0u, 1u, s < a); let s2 = s + c; let c2 = select(0u, 1u, s2 < s);
  return vec2<u32>(s2, c1 + c2);
}
fn ge_p(r: Fe) -> bool {
  if ((r[7] & r[6] & r[5] & r[4] & r[3] & r[2]) != 0xffffffffu) { return false; }
  return r[1] > 0xfffffffeu || (r[1] == 0xfffffffeu && r[0] >= 0xfffffc2fu);
}
// + 2^256 - p (= 0x1000003d1), mod 2^256
fn add_c(a: Fe) -> Fe {
  var r = a; var s = adc(r[0], 0x3d1u, 0u); r[0] = s.x; s = adc(r[1], 1u, s.y); r[1] = s.x;
  for (var i = 2u; i < 8u; i++) { s = adc(r[i], 0u, s.y); r[i] = s.x; }
  return r;
}
fn fe_sub(a: Fe, b: Fe) -> Fe {
  var r: Fe; var br = 0u;
  for (var i = 0u; i < 8u; i++) {
    let d = a[i] - b[i]; let b1 = select(0u, 1u, a[i] < b[i]); let d2 = d - br; let b2 = select(0u, 1u, d < br);
    r[i] = d2; br = b1 + b2;
  }
  if (br != 0u) { // r - 0x1000003d1, mod 2^256
    let d0 = r[0] - 0x3d1u; var bo = select(0u, 1u, r[0] < 0x3d1u); r[0] = d0;
    let d1 = r[1] - 1u - bo; bo = select(0u, 1u, r[1] < 1u + bo); r[1] = d1;
    for (var i = 2u; i < 8u; i++) { let d = r[i] - bo; bo = select(0u, 1u, r[i] < bo); r[i] = d; }
  }
  return r;
}
${fast ? mulCode() + sqrCode() : MUL_LOOP}
${cfg.inv === 'chain' ? INV_CHAIN : INV_LOOP}
fn rotr(x: u32, n: u32) -> u32 { return (x >> n) | (x << (32u - n)); }
fn rotl(x: u32, n: u32) -> u32 { return (x << n) | (x >> (32u - n)); }
fn ssig0(x: u32) -> u32 { return rotr(x, 7u) ^ rotr(x, 18u) ^ (x >> 3u); }
fn ssig1(x: u32) -> u32 { return rotr(x, 17u) ^ rotr(x, 19u) ^ (x >> 10u); }
fn bsig0(x: u32) -> u32 { return rotr(x, 2u) ^ rotr(x, 13u) ^ rotr(x, 22u); }
fn bsig1(x: u32) -> u32 { return rotr(x, 6u) ^ rotr(x, 11u) ^ rotr(x, 25u); }
fn bswap(x: u32) -> u32 { return (x >> 24u) | ((x >> 8u) & 0xff00u) | ((x << 8u) & 0xff0000u) | (x << 24u); }
${cfg.hash === 'unrolled' ? shaCode() + ripemdCode() : shaRolled() + RMD_ROLLED}
// hash160 of the compressed public key (x, y), as five little-endian words
fn hash160(x: Fe, y: Fe) -> array<u32, 5> {
  var m: array<u32, 16>;
  m[0] = ((2u + (y[0] & 1u)) << 24u) | (x[7] >> 8u);
  for (var i = 1u; i < 8u; i++) { m[i] = (x[8u - i] << 24u) | (x[7u - i] >> 8u); }
  m[8] = (x[0] << 24u) | 0x800000u;
  m[15] = 264u;
  let h = sha256_33(m);
  var r: array<u32, 16>;
  for (var i = 0u; i < 8u; i++) { r[i] = bswap(h[i]); }
  r[8] = 0x80u; r[14] = 256u;
  return ripemd160_32(r);
}

// points: limb-major (coordinate c of point p at c * npts + p), x then y
fn load(p: u32, which: u32) -> Fe {
  var r: Fe; let n = prm.npts;
  for (var c = 0u; c < 8u; c++) { r[c] = pts[(which * 8u + c) * n + p]; }
  return r;
}
fn store(p: u32, which: u32, v: Fe) {
  let n = prm.npts;
  for (var c = 0u; c < 8u; c++) { pts[(which * 8u + c) * n + p] = v[c]; }
}
fn ini_pt(i: u32, which: u32) -> Fe {
  var r: Fe;
  for (var c = 0u; c < 8u; c++) { r[c] = ini[(i * 2u + which) * 8u + c]; }
  return r;
}
fn tbl_pt(i: u32, which: u32) -> Fe {
  var r: Fe;
  for (var c = 0u; c < 8u; c++) { r[c] = tbl[(i * 2u + which) * 8u + c]; }
  return r;
}
fn hit(h: array<u32, 5>, tg0: vec4<u32>, tg4: u32) -> bool {
  return h[0] == tg0.x && h[1] == tg0.y && h[2] == tg0.z && h[3] == tg0.w && h[4] == tg4;
}
fn report(t: u32, s: u32, off: u32) {
  let n = atomicAdd(&outb[0], 1u);
  if (n == 0u) { atomicStore(&outb[1], t); atomicStore(&outb[2], prm.step_base + s); atomicStore(&outb[3], off); }
}

// the centre points from two small tables the host computed (Q_j = S + j·D, R_i = i·J·D, J = prm.steps here):
// thread p = i·J + j starts at Q_j + R_i, one affine addition
@compute @workgroup_size(${WG})
fn init(@builtin(global_invocation_id) gid: vec3<u32>) {
  let p = gid.x;
  if (p >= prm.npts) { return; }
  let J = prm.steps; let j = p % J; let i = p / J;
  let qx = ini_pt(j, 0u); let qy = ini_pt(j, 1u);
  if (i == 0u) { store(p, 0u, qx); store(p, 1u, qy); return; }
  let rx = ini_pt(J + i, 0u); let ry = ini_pt(J + i, 1u);
  let l = fe_mul(fe_sub(ry, qy), fe_inv(fe_sub(rx, qx)));
  let x3 = fe_sub(fe_sub(fe_sqr(l), qx), rx);
  store(p, 0u, x3);
  store(p, 1u, fe_sub(fe_mul(l, fe_sub(qx, x3)), qy));
}

// each thread holds one centre point C (key c) and per step checks the block c-K .. c+K: C ± i·G share the
// denominator x(i·G) - x(C), so one inversion (over K + 1 values, the last one for the move) serves 2K + 1 keys.
// Then C moves by (2K + 1)·G. tbl holds i·G for i = 1..K and (2K + 1)·G.
@compute @workgroup_size(${WG})
fn step(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = gid.x;
  if (t >= prm.npts) { return; }
  var cx = load(t, 0u); var cy = load(t, 1u);
  var pref: array<Fe, K + 1u>;
  let tg0 = prm.tgt[0]; let tg4 = prm.tgt[1].x;
  for (var s = 0u; s < prm.steps; s++) {${stepBody(cfg.sites)}
  }
  store(t, 0u, cx); store(t, 1u, cy);
}
`;
  }

  // the default: unrolled multiply and hashes, the inversion as a loop, one hash call site. In Chrome on Windows
  // (RTX 3060 Laptop) it compiles in 6-8 s from cold and runs as fast as the fully unrolled shader, which took
  // 30-50 s to compile and froze the browser; all loops compile in 2 s but run at less than half the speed.
  var CFG = { mul: 'unrolled', inv: 'loop', hash: 'unrolled', sites: 1 };
  var INIT_CFG = { mul: 'loop', inv: 'loop', hash: 'rolled', sites: 1 };

  // ---------- engine ----------
  function u32le(b) { var o = []; for (var i = 0; i < 8; i++) { o.push(Number(b & 0xffffffffn)); b >>= 32n; } return o; }

  function Engine(device, adapterInfo, opts) {
    this.device = device; this.info = adapterInfo || {};
    this.K = opts.K; this.WG = opts.WG; this.threads = opts.threads;
    // one centre point per thread; a step checks B = 2K + 1 keys around it
    this.npts = this.threads; this.B = 2 * this.K + 1;
    this.J = Math.min(256, this.npts);
    if (this.npts % this.J) throw new Error('threads must be a multiple of ' + this.J);
    var d = device, cfg = Object.assign({}, CFG, opts.cfg || {});
    this.cfg = cfg;
    this.modInit = d.createShaderModule({ code: wgsl(this.K, this.WG, INIT_CFG, opts.nonce) });
    this.modStep = d.createShaderModule({ code: wgsl(this.K, this.WG, cfg, opts.nonce) });
    var bgl = d.createBindGroupLayout({ entries: [0, 1, 2, 3, 4].map(function (b) {
      return { binding: b, visibility: GPUShaderStage.COMPUTE, buffer: { type: b === 0 ? 'uniform' : b === 4 ? 'read-only-storage' : 'storage' } };
    }) });
    this.layout = d.createPipelineLayout({ bindGroupLayouts: [bgl] });
    this.uni = d.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.pts = d.createBuffer({ size: this.npts * 16 * 4, usage: GPUBufferUsage.STORAGE });
    this.out = d.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.ini = d.createBuffer({ size: (this.J + this.npts / this.J) * 16 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.read = d.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    // i·G for i = 1..K, then (2K + 1)·G, then the hash constants
    var ct = constTable(), tb = new Uint32Array((this.K + 1) * 16 + ct.length);
    for (var i = 0; i <= this.K; i++) {
      var q = S.mulG(BigInt(i < this.K ? i + 1 : this.B));
      tb.set(u32le(q[0]), i * 16); tb.set(u32le(q[1]), i * 16 + 8);
    }
    tb.set(ct, (this.K + 1) * 16);
    this.tbl = d.createBuffer({ size: tb.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(this.tbl, 0, tb);
    this.bg = d.createBindGroup({ layout: bgl, entries: [this.uni, this.pts, this.out, this.ini, this.tbl].map(function (b, i) { return { binding: i, resource: { buffer: b } }; }) });
  }
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
  Engine.prototype.params = function (start, targetHex, seg, steps, stepBase) {
    var a = new Uint32Array(20), s = u32le(BigInt(start)), t = S.hexToWords(targetHex || '0000000000000000000000000000000000000000');
    for (var i = 0; i < 8; i++) a[i] = s[i];
    for (i = 0; i < 5; i++) a[8 + i] = t[i];
    a[16] = this.npts; a[17] = seg; a[18] = steps; a[19] = stepBase;
    this.device.queue.writeBuffer(this.uni, 0, a);
  };
  Engine.prototype.dispatch = function (pipe, n) {
    var enc = this.device.createCommandEncoder(), pass = enc.beginComputePass();
    pass.setPipeline(pipe); pass.setBindGroup(0, this.bg);
    pass.dispatchWorkgroups(Math.ceil(n / this.WG));
    pass.end();
    this.device.queue.submit([enc.finish()]);
  };
  Engine.prototype.readOut = async function () {
    var enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.out, 0, this.read, 0, 16);
    this.device.queue.submit([enc.finish()]);
    await this.read.mapAsync(GPUMapMode.READ, 0, 16);
    var r = new Uint32Array(this.read.getMappedRange(0, 16).slice(0));
    this.read.unmap();
    return r;
  };
  Engine.prototype.clearOut = function () { this.device.queue.writeBuffer(this.out, 0, new Uint32Array(4)); };
  // centre of thread p = centre + p·seg: the host makes Q_j and R_i (a few hundred additions), the GPU adds them
  Engine.prototype.initPoints = async function (centre, seg) {
    var J = this.J, I = this.npts / J, a = new Uint32Array((J + I) * 16), d = S.mulG(BigInt(seg));
    var q = S.mulG(BigInt(centre)), i;
    for (i = 0; i < J; i++) { a.set(u32le(q[0]), i * 16); a.set(u32le(q[1]), i * 16 + 8); q = S.addAffine(q, d); }
    var jd = S.mulG(BigInt(seg) * BigInt(J)), r = jd;
    for (i = 1; i < I; i++) { a.set(u32le(r[0]), (J + i) * 16); a.set(u32le(r[1]), (J + i) * 16 + 8); r = S.addAffine(r, jd); }
    this.device.queue.writeBuffer(this.ini, 0, a);
    this.params(centre, null, seg, J, 0);
    this.dispatch(this.pInit, this.npts);
    await this.readOut();
  };

  // end to end against the reference: keys planted at the centre, on both sides and at the block's edges must be
  // found exactly where they were put, once, and nothing found without a target
  Engine.prototype.selftest = async function (log) {
    log = log || function () {};
    var start = (1n << 69n) + 0x123456789abcdefn, seg = 1000003, n = this.npts, B = BigInt(this.B), K = this.K;
    await this.initPoints(start + BigInt(K), seg);
    var base = 0, plants = [[n >> 2, 0, 0], [n - 1, 1, 3], [3, 2, -2], [0, 0, K], [n >> 1, 3, -K], [J1(n), 1, 1]];
    function J1(x) { return Math.min(x - 1, 257); }
    for (var i = 0; i < plants.length; i++) {
      var pp = plants[i][0], ss = plants[i][1], d = plants[i][2];
      var key = start + BigInt(pp) * BigInt(seg) + BigInt(base + ss) * B + BigInt(K + d);
      this.params(start + BigInt(K), S.hash160OfKey(key), seg, 4, base);
      this.clearOut();
      this.dispatch(this.pStep, n);
      var o = await this.readOut();
      if (o[0] !== 1 || o[1] !== pp || o[2] !== base + ss || o[3] !== K + d) throw new Error('self-test: the key planted at thread ' + pp + ', step ' + (base + ss) + ', offset ' + d + ' was not found there (' + Array.prototype.join.call(o, ',') + ')');
      base += 4;
    }
    log('planted keys are found exactly: at the centre, on both sides, at the block edges, across threads');
    this.params(start + BigInt(K), '0000000000000000000000000000000000000000', seg, 4, base);
    this.clearOut();
    this.dispatch(this.pStep, n);
    if ((await this.readOut())[0] !== 0) throw new Error('self-test: a key was "found" with no target');
    log('nothing is found where nothing is planted');
    return true;
  };

  // Steps per dispatch adapt so that one dispatch keeps the GPU busy for about `ms` (default 60): on a laptop
  // the same GPU draws the screen, and long dispatches freeze the browser or the whole desktop.
  function Pacer(ms) { this.ms = ms || 60; this.steps = 1; }
  Pacer.prototype.next = function (max) { return Math.max(1, Math.min(this.steps, max)); };
  Pacer.prototype.took = function (steps, ms) {
    if (ms <= 0) return;
    var want = steps * this.ms / ms;
    this.steps = Math.max(1, Math.min(256, Math.round(this.steps * 0.5 + want * 0.5)));
  };

  // brute force [from, to] (BigInt); calls onProgress({checked, total, rate, seconds}) and resolves with the key or null.
  // stop() on the returned handle ends it early. opts: ms (target dispatch time), segMax, isPaused.
  // Thread p covers keys chunk + p·seg .. + seg - 1, its centre starting K above the first.
  Engine.prototype.search = function (from, to, targetHex, onProgress, opts) {
    var self = this; opts = opts || {};
    var stopped = false, handle = { stop: function () { stopped = true; } };
    from = BigInt(from); to = BigInt(to);
    var total = to - from + 1n, n = BigInt(this.npts), B = BigInt(this.B), K = BigInt(this.K);
    var segMax = BigInt(opts.segMax || 1 << 22);
    var seg = (total + n - 1n) / n;
    if (seg > segMax) seg = segMax;
    seg = ((seg + B - 1n) / B) * B;
    var segSteps = Number(seg / B), pace = new Pacer(opts.ms);
    handle.done = (async function () {
      var chunk = from, checked = 0n, t0 = performance.now();
      while (chunk <= to && !stopped) {
        await self.initPoints(chunk + K, Number(seg));
        self.clearOut();
        for (var done = 0; done < segSteps && !stopped;) {
          if (opts.isPaused && opts.isPaused()) {
            var p0 = performance.now();
            while (opts.isPaused() && !stopped) await new Promise(function (r) { setTimeout(r, 250); });
            t0 += performance.now() - p0;
            if (stopped) break;
          }
          var st = pace.next(segSteps - done), d0 = performance.now();
          self.params(chunk + K, targetHex, Number(seg), st, done);
          self.dispatch(self.pStep, self.npts);
          var o = await self.readOut();
          pace.took(st, performance.now() - d0);
          done += st;
          checked += BigInt(st) * B * n;
          if (o[0] > 0) {
            var key = chunk + BigInt(o[1]) * seg + BigInt(o[2]) * B + BigInt(o[3]);
            if (key >= from && key <= to && S.hash160OfKey(key) === targetHex) return key;
            self.clearOut();
          }
          var sec = (performance.now() - t0) / 1000;
          if (onProgress) onProgress({ checked: checked > total ? total : checked, total: total, rate: Number(checked) / sec, seconds: sec });
        }
        chunk += seg * n;
      }
      return null;
    })();
    return handle;
  };

  // keys per second on a chunk far from any target, for `seconds`, paced like the search
  Engine.prototype.bench = async function (seconds, onProgress, ms) {
    var start = (1n << 70n) + 12345n, keys = 0, seg = 1 << 30, pace = new Pacer(ms);
    await this.initPoints(start, seg);
    var t0 = performance.now();
    for (var base = 0; (performance.now() - t0) / 1000 < seconds;) {
      var st = pace.next(1 << 20), d0 = performance.now();
      this.params(start, null, seg, st, base);
      this.dispatch(this.pStep, this.npts);
      await this.readOut();
      pace.took(st, performance.now() - d0);
      base += st;
      keys += st * this.B * this.npts;
      if (onProgress) onProgress(keys / ((performance.now() - t0) / 1000));
    }
    return keys / ((performance.now() - t0) / 1000);
  };

  // opts: K, WG, threads, cfg, log (gets the adapter before the compile), nonce (tests: skip the shader cache)
  async function create(opts) {
    opts = Object.assign({ K: 24, WG: 64, threads: 1 << 15, powerPreference: 'high-performance' }, opts || {});
    if (!root.navigator || !navigator.gpu) throw new Error('This browser has no WebGPU');
    var adapter = await navigator.gpu.requestAdapter({ powerPreference: opts.powerPreference });
    if (!adapter) throw new Error('No GPU adapter');
    var info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
    if (opts.log) opts.log('Adapter: ' + ([info.vendor, info.architecture, info.description].filter(Boolean).join(' · ') || 'unnamed') + (adapter.isFallbackAdapter ? ' (software fallback)' : ''));
    var device = await adapter.requestDevice();
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

  root.BBGpu = { create: create, wgsl: wgsl, CFG: CFG };
})(typeof self !== 'undefined' ? self : globalThis);
