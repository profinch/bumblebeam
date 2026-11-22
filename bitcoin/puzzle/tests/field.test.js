// The GPU engine's field arithmetic (web/engine/gpu.js: twenty 13-bit limbs in u32), without a GPU. Each routine is
// a list of assignments that the engine turns into WGSL; here the same list runs on exact numbers. Every result
// is compared with BigInt, and no value may reach 2^32 (a u32 would wrap there and the result would be wrong
// without a sign of it). The worst case comes first: every limb at its limit gives the largest column of limb
// products, the one place that comes near 2^32 (89% of it); after the first carries every limb is below 8192 and
// the later sums stay under 2^30 whatever the input. Then the edge values (0, 1, p - 1, values around the folds) in every loose form,
// and random ones. Run: node bitcoin/puzzle/tests/field.test.js
'use strict';
const S = require('../web/engine/secp.js');
globalThis.BBSecp = S;
require('../web/engine/gpu.js');
const F = globalThis.BBGpu.field, P = S.P;
let maxSeen = 0;
// a routine compiled once: every assignment followed by its check
const compiled = new Map();
function run(prog, ins) {
  let f = compiled.get(prog);
  if (!f) {
    const names = [...new Set(prog.map((s) => s[0]))];
    const body = 'var ' + names.join(', ') + '; ' + prog.map(([n, e]) => `${n} = ${e.replace(/>>/g, '>>>')}; if (!(${n} >= 0 && ${n} < 4294967296)) throw new Error(${JSON.stringify(n + ' = ' + e)} + ' gives ' + ${n}); if (${n} > env.max) env.max = ${n};`).join(' ') + ' return {' + names.map((n) => n + ': ' + n).join(', ') + '};';
    const args = [...new Set(prog.flatMap((s) => s[1].match(/\b[abc]\d+\b/g) || []))];
    f = { args, fn: new Function('env', 'select', ...args, body) };
    compiled.set(prog, f);
  }
  const env = { max: maxSeen };
  const r = f.fn(env, (a, b, c) => (c ? b : a), ...f.args.map((a) => ins[a]));
  maxSeen = env.max;
  return r;
}
const val = (l) => l.reduce((s, x, i) => s + (BigInt(x) << BigInt(13 * i)), 0n);
const named = (p, l) => Object.fromEntries(l.map((x, i) => [p + i, x]));
const out = (env) => { const o = []; for (let i = 0; i < 20; i++) o.push(env['r' + i]); return o; };
const isLoose = (l) => l.every((x, i) => x <= (i < 19 ? 8192 : 511));
let passed = 0, failed = 0;
function ok(c, what) { if (c) passed++; else { failed++; console.log('  FAIL ' + what); } }

// loose values: canonical limbs of a value, some limbs pushed to their limit
let seed = 12345;
const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 2 ** 32; };
function rndBig() { let b = 0n; for (let i = 0; i < 9; i++) b = (b << 32n) | BigInt(Math.floor(rnd() * 2 ** 32)); return b % P; }
const LOOSE_MAX = Array.from({ length: 20 }, (_, i) => (i < 19 ? 8192 : 511));
const edges = [0n, 1n, 2n, P - 1n, P - 2n, (1n << 255n), (1n << 256n) - (1n << 33n), 977n, (1n << 32n) + 977n, P >> 1n, (1n << 247n) - 1n, (1n << 13n) - 1n, 0xffffffffn, (1n << 128n) - 1n, P - 977n, P - (1n << 32n)];
function looseForms(b) { // the canonical limbs, and looser ones of the same value mod p
  const c = F.limbs(b), forms = [c];
  // b + p when it still fits the loose top limb; and limbs carrying an extra 8192 taken from the next
  if (b + P < (1n << 256n) + (1n << 247n)) forms.push(F.limbs(b + P));
  const d = c.slice();
  for (let i = 0; i < 19; i++) if (d[i] === 0 && d[i + 1] > 0) { d[i] = 8192; d[i + 1]--; }
  forms.push(d);
  return forms.filter(isLoose);
}
const subr = (a, b) => out(run(F.progs.subr, Object.assign(named('a', a), named('b', b))));
const sub2r = (a, b, c) => out(run(F.progs.sub2r, Object.assign(named('a', a), named('b', b), named('c', c))));
const mul = (a, b) => out(run(F.progs.mul, Object.assign(named('a', a), named('b', b))));
const sqr = (a) => out(run(F.progs.sqr, named('a', a)));
const norm = (a) => out(run(F.progs.norm, named('a', a)));
const canon = (a) => out(run(F.progs.canon, named('a', a)));
const odd = (a) => run(F.progs.odd, named('a', a)).odd;

console.log('worst-case limbs: nothing overflows, results stay loose');
{
  const rawMax = subr(LOOSE_MAX, Array(20).fill(0)); // the largest raw value of one subtraction
  const raw2Max = sub2r(LOOSE_MAX, Array(20).fill(0), Array(20).fill(0));
  ok(Math.max(...rawMax) <= 24574 && Math.max(...raw2Max) <= 32766, 'raw limbs within their bounds (' + Math.max(...rawMax) + ', ' + Math.max(...raw2Max) + ')');
  // the smallest: never below zero in any limb, with the largest loose values taken off
  ok(subr(Array(20).fill(0), LOOSE_MAX).every((x) => x >= 0) && sub2r(Array(20).fill(0), LOOSE_MAX, LOOSE_MAX).every((x) => x >= 0), 'a raw subtraction never borrows');
  let r = mul(LOOSE_MAX, rawMax);
  ok(isLoose(r) && val(r) % P === val(LOOSE_MAX) * val(rawMax) % P, 'mul(loose max, raw max)');
  r = sqr(LOOSE_MAX);
  ok(isLoose(r) && val(r) % P === val(LOOSE_MAX) * val(LOOSE_MAX) % P, 'sqr(loose max)');
  r = norm(raw2Max);
  ok(isLoose(r) && val(r) % P === val(raw2Max) % P, 'norm(raw max of a - b - c)');
  r = norm(subr(mul(LOOSE_MAX, rawMax), Array(20).fill(0)));
  ok(isLoose(r), 'norm(raw max of a - b)');
  ok(val(canon(LOOSE_MAX)) === val(LOOSE_MAX) % P && odd(LOOSE_MAX) === Number(val(LOOSE_MAX) % P & 1n), 'canon and odd of the largest loose value');
}

console.log('against BigInt: edge values in every loose form, then random ones');
{
  const vals = edges.slice();
  for (let i = 0; i < 300; i++) vals.push(rndBig());
  const forms = vals.map((b) => looseForms(b));
  let n = 0, bad = 0;
  for (let i = 0; i < vals.length; i++) {
    for (const a of forms[i]) {
      const A = val(a);
      const c = canon(a);
      if (val(c) !== A % P || !c.every((x, k) => x <= (k < 19 ? 8191 : 511)) || odd(a) !== Number(A % P & 1n)) bad++;
      const s = sqr(a);
      if (!isLoose(s) || val(s) % P !== A * A % P) bad++;
      n += 2;
    }
    // pairs: edges with everything, random ones with a few
    const others = i < edges.length ? vals.map((_, j) => j) : [0, 3, (i * 7) % vals.length, (i * 13 + 5) % vals.length];
    for (const j of others) for (const a of forms[i]) for (const b of forms[j]) {
      const A = val(a), Bv = val(b);
      const m = mul(a, b);
      if (!isLoose(m) || val(m) % P !== A * Bv % P) bad++;
      const d = subr(a, b), dn = norm(d);
      if (val(d) % P !== ((A - Bv) % P + P) % P || !isLoose(dn) || val(dn) % P !== val(d) % P) bad++;
      // a raw second factor, as the engine multiplies
      const m2 = mul(a, d);
      if (!isLoose(m2) || val(m2) % P !== A * val(d) % P) bad++;
      const e = norm(sub2r(m, a, b));
      if (!isLoose(e) || val(e) % P !== (((A * Bv - A - Bv) % P) + P) % P) bad++;
      n += 4;
    }
  }
  ok(bad === 0, bad + ' of ' + n + ' results wrong');
  console.log('  ' + n + ' results checked');
}
console.log('the largest value any step held: ' + maxSeen + ' (2^32 = 4294967296)');
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
