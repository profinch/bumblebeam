/* BumbleBeam puzzle engine, CPU side: a Web Worker running one of three searches on the BigInt reference.
     { mode: 'brute', from, to, target }          keys from..to against a hash160 (needs only the address)
     { mode: 'bsgs', from, to, pub: [x, y] }      baby-step giant-step: ~2·√range operations, √range memory
     { mode: 'kangaroo', from, to, pub: [x, y] }  Pollard's kangaroo: ~2·√range jumps, almost no memory
   Numbers travel as hex strings. Posts { type: 'progress', ops, ... }, then { type: 'done', key } (key null if
   the range holds no answer). { pause: true/false } pauses and resumes; terminate() stops it. */
/* global importScripts, BBSecp */
importScripts('secp.js');
var S = BBSecp, paused = false, job = null;

self.onmessage = function (e) {
  var m = e.data;
  if ('pause' in m) { paused = m.pause; return; }
  var from = BigInt('0x' + m.from), to = BigInt('0x' + m.to);
  var pub = m.pub ? [BigInt('0x' + m.pub[0]), BigInt('0x' + m.pub[1])] : null;
  job = m.mode === 'bsgs' ? bsgs(from, to, pub) : m.mode === 'kangaroo' ? kangaroo(from, to, pub, m.seed || 1) : brute(from, to, m.target);
  tick();
};

// a job is an iterator of small pieces of work, so pause messages get through between them
function tick() {
  if (paused) { setTimeout(tick, 200); return; }
  var t = Date.now(), r;
  do { r = job.next(); } while (!r.done && Date.now() - t < 120);
  if (r.done) { self.postMessage({ type: 'done', key: r.value == null ? null : r.value.toString(16) }); return; }
  self.postMessage(Object.assign({ type: 'progress' }, r.value));
  setTimeout(tick, 0);
}

function* brute(from, to, target) {
  var s = new S.Searcher(from, to, target, 256), ops = 0;
  for (;;) {
    var r = s.next(2048);
    ops += r.checked;
    if (r.found != null) return r.found;
    if (r.done) return null;
    yield { ops: ops, pos: Number(BigInt(ops) * 10000n / (to - from + 1n)) / 10000 };
  }
}

// points start + i·step for i = 0, 1, 2, ... in batches of B, one inversion per batch
function* progression(start, step, B) {
  var pts = [start], i;
  for (i = 1; i < B; i++) pts.push(S.addAffine(pts[i - 1], step));
  var big = S.addAffine(pts[B - 1], S.neg(start)), bigStep = S.addAffine(big, step), adds = new Array(B);
  for (i = 0; i < B; i++) adds[i] = bigStep;
  for (;;) {
    yield pts;
    pts = S.batchAdd(pts, adds);
  }
}

function xkey(p) { return Number(p[0] & 0xfffffffffffffn); }

function* bsgs(from, to, pub) {
  var range = to - from + 1n, m = 1n, G = [S.GX, S.GY];
  while (m * m < range) m <<= 1n;
  var mn = Number(m), table = new Map(), ops = 0, B = 256;
  // the target relative to the range start: Q = P - from·G, so Q = k'·G with 0 <= k' < range
  var Q = S.addAffine(pub, S.neg(S.mulG(from)));
  if (Q === null) return from;
  // baby steps j·G, j = 1..m
  var baby = progression(G, G, B), j = 1;
  while (j <= mn) {
    var pts = baby.next().value;
    for (var i = 0; i < B && j <= mn; i++, j++) table.set(xkey(pts[i]), j);
    ops += B;
    yield { ops: ops, phase: 'baby', pos: j / mn / 2, mem: table.size };
  }
  // giant steps Q - i·m·G
  var mG = S.neg(S.mulG(m)), giant = progression(Q, mG, B), gi = 0n;
  while (gi * m <= range) {
    var gp = giant.next().value;
    for (var g = 0; g < B; g++, gi++) {
      var hit = table.get(xkey(gp[g]));
      if (hit !== undefined) {
        // x matches for +j and -j: check both
        var c1 = from + gi * m + BigInt(hit), c2 = from + gi * m - BigInt(hit);
        var hp = S.mulG(c1);
        if (c1 <= to && hp[0] === pub[0] && hp[1] === pub[1]) return c1;
        hp = c2 >= 1n ? S.mulG(c2) : null;
        if (hp && hp[0] === pub[0] && hp[1] === pub[1]) return c2;
      }
    }
    ops += B;
    yield { ops: ops, phase: 'giant', pos: 0.5 + Math.min(0.5, Number(gi) / Number(m) / 2), mem: table.size };
  }
  return null;
}

// tame kangaroos start in the middle of the range at known keys; wild ones start at the target point P and
// carry their distance from it. Both jump by 2^t·G, t from the point's x, so two that land on the same point
// follow the same path. Distinguished points (x with the low bits zero) are kept; a tame and a wild one at
// the same point give the key: tame key - wild distance.
function* kangaroo(from, to, pub, seed) {
  var range = to - from + 1n, NK = 32, ops = 0;
  var sqrtW = Math.sqrt(Number(range));
  // jumps 2^0..2^(J-1): their mean (2^J - 1)/J close to NK·√w/4 (van Oorschot-Wiener)
  var J = 2, want = NK * sqrtW / 4;
  while (J < 60 && (Math.pow(2, J + 1) - 1) / (J + 1) <= want) J++;
  var jumps = [], jd = [];
  for (var t = 0; t < J; t++) { jd.push(1n << BigInt(t)); jumps.push(S.mulG(1n << BigInt(t))); }
  // distinguished points: about NK·2^dp extra jumps, kept near √w/8
  var dpBits = Math.max(0, Math.floor(Math.log2(sqrtW / (8 * NK)))), dpMask = (1 << Math.min(dpBits, 30)) - 1;
  var rnd = seed >>> 0;
  function rand(n) { rnd = (rnd * 1103515245 + 12345) >>> 0; return BigInt(rnd) % n; }
  var pts = [], dist = [], tame = [];
  var mid = from + range / 2n;
  for (var i = 0; i < NK; i++) {
    var off = rand(range / 4n + 1n);
    if (i % 2 === 0) { dist.push(mid + off); pts.push(S.mulG(mid + off)); tame.push(true); }
    else { dist.push(off); pts.push(off === 0n ? pub : S.addAffine(pub, S.mulG(off))); tame.push(false); }
  }
  var dps = new Map(), found = [];
  for (;;) {
    for (var r = 0; r < 16; r++) {
      var adds = new Array(NK), idx = new Array(NK);
      for (i = 0; i < NK; i++) { idx[i] = Number(pts[i][0] % BigInt(J)); adds[i] = jumps[idx[i]]; }
      pts = S.batchAdd(pts, adds);
      for (i = 0; i < NK; i++) {
        dist[i] += jd[idx[i]];
        if ((Number(pts[i][0] & 0xffffffffn) & dpMask) === 0) {
          var k = xkey(pts[i]), prev = dps.get(k);
          if (prev && prev.tame !== tame[i]) {
            var key = tame[i] ? dist[i] - prev.dist : prev.dist - dist[i];
            var hp = key > 0n ? S.mulG(key) : null;
            if (hp && hp[0] === pub[0] && hp[1] === pub[1]) return key;
          }
          if (prev && prev.tame === tame[i]) { // same herd met: that one follows the other's path now, restart it
            var o2 = rand(range / 4n + 1n);
            if (tame[i]) { dist[i] = mid + o2; pts[i] = S.mulG(dist[i]); } else { dist[i] = o2; pts[i] = S.addAffine(pub, S.mulG(o2)); }
          } else dps.set(k, { tame: tame[i], dist: dist[i] });
          found.push({ tame: tame[i], at: tame[i] ? Number((dist[i] - from) * 10000n / range) / 10000 : null });
        }
      }
      ops += NK;
    }
    var fr = found; found = [];
    yield { ops: ops, dps: dps.size, marks: fr };
  }
}
