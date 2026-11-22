// The site's engine in Node, as the server loads it (classic scripts that set globals and module.exports), and
// the test fixtures: puzzle #20 (solved in 2015, key 0xd2c55) and a payout address.
'use strict';
const S = require('../web/engine/secp.js');
const T = require('../web/engine/tx.js');
const K = require('../web/engine/claimkit.js');
require('../web/engine/puzzles.js');
const PZ = globalThis.BBPuzzles;

const KEY = 0xd2c55n;
const PUZZLE = 20;
const ADDRESS = PZ.address(PUZZLE);
// BIP-173's example addresses: never anyone's money
const FINDER = 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3';
const POOL = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
// a P2WPKH address of a small test key (bech32, BIP-173): key 1 gives BIP-173's own example, POOL above
function p2wpkh(k) {
  const A = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l', G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const prog = Array.from(S.fromHex(S.hash160OfKey(BigInt(k)))), data = [0];
  let acc = 0, bits = 0;
  for (const b of prog) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; data.push((acc >> bits) & 31); } }
  if (bits) data.push((acc << (5 - bits)) & 31);
  const pm = (v) => { let c = 1; for (const x of v) { const t = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((t >>> i) & 1) c ^= G[i]; } return c >>> 0; };
  const mod = pm([3, 3, 0, 2, 3].concat(data, [0, 0, 0, 0, 0, 0])) ^ 1, chk = [];
  for (let i = 0; i < 6; i++) chk.push((mod >>> (5 * (5 - i))) & 31);
  return 'bc1' + data.concat(chk).map((d) => A[d]).join('');
}
const SHIELD = p2wpkh(2);
// the key as a wallet would show it (WIF, compressed): one more form the tests look for on the page
function wif(k) {
  const body = new Uint8Array(34); body[0] = 0x80; body.set(S.fromHex(BigInt(k).toString(16).padStart(64, '0')), 1); body[33] = 1;
  const full = new Uint8Array(38); full.set(body); full.set(S.sha256(S.sha256(body)).slice(0, 4), 34);
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let n = BigInt('0x' + S.toHex(full)), out = '';
  while (n > 0n) { out = A[Number(n % 58n)] + out; n /= 58n; }
  return out;
}
// a made-up 7.1 BTC coin on #20's address, from a made-up funding transaction (its hex hashes to the coin's txid,
// so a page can check the amount against it, as it does with real coins)
const FUND_HEX = (() => {
  const le = (v, n) => { const o = []; for (let i = 0; i < n; i++) { o.push(Number(BigInt(v) >> BigInt(8 * i) & 0xffn)); } return o; };
  const script = [0x76, 0xa9, 0x14].concat(Array.from(S.fromHex(S.addressToHash160(ADDRESS))), [0x88, 0xac]);
  const bytes = [].concat(le(1, 4), [1], Array(32).fill(0xab), le(0, 4), [0], le(0xffffffff, 4), [1], le(710000000, 8), [script.length], script, le(0, 4));
  return S.toHex(Uint8Array.from(bytes));
})();
const COIN = { txid: S.toHex(Uint8Array.from(S.sha256(S.sha256(S.fromHex(FUND_HEX)))).reverse()), vout: 0, value: 710000000 };

let failed = 0, passed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  ok   ' + name); } else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function eq(a, b, name) { ok(a === b, name, a === b ? undefined : { got: a, want: b }); }
function throws(f, re, name) {
  try { f(); ok(false, name, 'did not throw'); } catch (e) { ok(re.test(e.message), name, e.message); }
}
function done() { console.log(`\n${passed} passed, ${failed} failed`); process.exitCode = failed ? 1 : 0; }

module.exports = { wif, p2wpkh, SHIELD, S, T, K, PZ, KEY, PUZZLE, ADDRESS, FINDER, POOL, COIN, FUND_HEX, ok, eq, throws, done };
