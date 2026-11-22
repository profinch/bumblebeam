// Unit tests of the claim's code shared by the browser and the server: engine/tx.js (reading a sweep back,
// checking its signatures) and engine/claimkit.js (the split, building, re-signing at a higher fee, checking a
// signed sweep, the commitment, the OpenTimestamps file). Run: node bitcoin/puzzle/tests/kit.test.js
'use strict';
const crypto = require('crypto');
const { S, T, K, KEY, FINDER, POOL, SHIELD, p2wpkh, COIN, FUND_HEX, ok, eq, throws, done } = require('./engine.js');

const coins = { [COIN.txid + ':' + COIN.vout]: COIN.value };
function outsOf(hex) { return T.parse(hex).outs.map((o) => ({ script: S.toHex(o.script), value: o.value })); }
const spk = (a) => S.toHex(T.addressScript(a).script);

console.log('tx.js: a sweep read back');
{
  const two = [COIN, { txid: 'ab'.repeat(32), vout: 3, value: 25000 }];
  const t = T.sweep(KEY, two, [{ address: FINDER, value: 600000000 }, { address: POOL, value: 110000000 + 25000 - 3000 }]);
  const p = T.parse(t.hex);
  eq(p.txid, t.txid, 'parse: the same txid');
  eq(p.ins.length, 2, 'parse: two inputs');
  eq(p.ins[1].txid + ':' + p.ins[1].vout, 'ab'.repeat(32) + ':3', 'parse: the input points at its coin');
  eq(p.outs[0].value, 600000000, 'parse: the first output\'s amount');
  eq(S.toHex(p.outs[1].script), spk(POOL), 'parse: the second output\'s script');
  ok(T.verifySweep(p, S.mulG(KEY)), 'verifySweep: both signatures verify');
  throws(() => T.verifySweep(p, S.mulG(KEY + 1n)), /not signed by the puzzle key/, 'verifySweep: another key is refused');
  // one bit of the first signature's s flipped
  const bad = T.parse(t.hex); bad.ins[0].script = bad.ins[0].script.slice(); bad.ins[0].script[40] ^= 1;
  throws(() => T.verifySweep(bad, S.mulG(KEY)), /signature|DER|high-S/, 'verifySweep: a changed signature is refused');
  // the outputs changed after signing: the signatures no longer verify
  const moved = T.parse(t.hex); moved.outs[0].value -= 1; moved.outs[1].value += 1;
  throws(() => T.verifySweep(moved, S.mulG(KEY)), /does not verify/, 'verifySweep: an output changed after signing is refused');
  throws(() => T.parse(t.hex + '00'), /after the end/, 'parse: trailing bytes are refused');
  throws(() => T.parse(t.hex.slice(0, 100)), /cut short/, 'parse: a cut transaction is refused');
}

console.log('claimkit.js: the split');
{
  eq(K.finderShare(710000000), 600000000, '7.1 BTC: 6 to the finder');
  eq(K.finderShare(720000000), 600000000, '7.2 BTC: 6 to the finder');
  eq(K.finderShare(800000000), 700000000, '8.0 BTC: 7 to the finder');
  eq(K.finderShare(150000000), 0, '1.5 BTC: no whole bitcoin but one, the finder\'s share is 0');
  const o = K.split(710000000, 5000, FINDER, POOL);
  eq(o[0].value, 600000000, 'the finder\'s output'); eq(o[1].value, 110000000 - 5000, 'the pool\'s output pays the fee');
  const solo = K.split(710000000, 5000, FINDER, null);
  eq(solo.length, 1, 'no pool address: one output'); eq(solo[0].value, 710000000 - 5000, 'no pool address: all to the finder less the fee');
  throws(() => K.check([{ address: FINDER, value: 500000000, role: 'you' }, { address: POOL, value: 210000000 - 5000, role: 'the pool' }], 710000000, 5000, FINDER), /smaller than the share/, 'check: a finder\'s output under the share is refused');
  throws(() => K.check([{ address: FINDER, value: 600000000, role: 'you' }, { address: POOL, value: 80000000, role: 'the pool' }], 710000000, 30000000, FINDER), /more than 0.3%/, 'check: fees over 0.3% of the prize are refused');
  throws(() => K.check([{ address: FINDER, value: 600000000, role: 'you' }, { address: POOL, value: 100, role: 'the pool' }], 710000000, 109999900, FINDER), /not valid/, 'check: a dust output is refused');
}

console.log('claimkit.js: the fee rate, chosen without the finder');
{
  eq(K.chooseRate(3, 2), 10, 'a quiet market: the floor of 10 sat/vB');
  eq(K.chooseRate(45, 2), 45, 'the market\'s next-block rate');
  eq(K.chooseRate(12, 80), 80, 'the relay\'s minimum when it is higher');
  throws(() => K.chooseRate(5, 5000), /more than the most we pay/, 'a relay asking more than the cap is refused');
}

console.log('claimkit.js: build, check, bump');
{
  const b = K.build({ key: KEY, utxos: [COIN], payout: FINDER, poolPayout: POOL, rate: 20 });
  ok(!('rebar' in b), 'one transaction, for Slipstream (no Rebar any more)');
  const c = K.checkTx(b.slip.hex, { key: KEY, coins, payout: FINDER, poolPayout: POOL });
  eq(c.finder, 600000000, 'Slipstream\'s: 6 BTC to the finder'); eq(c.fee, b.slip.fee, 'Slipstream\'s: the fee as built');
  ok(c.fee / c.size >= 20 && c.fee / c.size < 21, 'Slipstream\'s: about 20 sat/vB', c.fee / c.size);
  throws(() => K.checkTx(b.slip.hex, { key: KEY, coins: { ['11'.repeat(32) + ':0']: COIN.value }, payout: FINDER, poolPayout: POOL }), /not one of the coins of the puzzle/, 'a transaction spending another coin is refused');
  throws(() => K.checkTx(b.slip.hex, { key: KEY, coins, payout: p2wpkh(3), poolPayout: POOL }), /neither the finder nor the pool/, 'a transaction for another payout address is refused');
  // a sweep that underpays the finder, and one that pays a stranger, both signed with the real key
  const under = T.sweep(KEY, [COIN], [{ address: FINDER, value: 500000000 }, { address: POOL, value: 209990000 }]);
  throws(() => K.checkTx(under.hex, { key: KEY, coins, payout: FINDER, poolPayout: POOL }), /less than the share/, 'a sweep paying the finder 5 of 7.1 BTC is refused');
  const stranger = T.sweep(KEY, [COIN], [{ address: FINDER, value: 600000000 }, { address: POOL, value: 100000000 }, { address: '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH', value: 9990000 }]);
  throws(() => K.checkTx(stranger.hex, { key: KEY, coins, payout: FINDER, poolPayout: POOL }), /neither the finder nor the pool/, 'a sweep paying a stranger is refused');
  // a fee bump at every rate up to the cap: the finder's output never changes, the pool's pays for it
  let prev = b.slip, steady = true, poolDown = true;
  for (let rate = 30; rate <= K.MAX_RATE; rate = Math.min(K.MAX_RATE, Math.ceil(rate * 1.5))) {
    const n = K.bump(prev, { key: KEY, utxos: [COIN], payout: FINDER, poolPayout: POOL, rate });
    const cn = K.checkTx(n.slip.hex, { key: KEY, coins, payout: FINDER, poolPayout: POOL });
    if (cn.finder !== 600000000 || outsOf(n.slip.hex)[0].script !== spk(FINDER)) steady = false;
    if (!(cn.pool < K.checkTx(prev.hex, { key: KEY, coins, payout: FINDER, poolPayout: POOL }).pool)) poolDown = false;
    prev = n.slip;
    if (rate === K.MAX_RATE) break;
  }
  ok(steady, 'bump 30 → 2000 sat/vB: the finder\'s output stays 6 BTC to the same address every time');
  ok(poolDown, 'bump: the pool\'s output pays every increase');
  // with no pool part, the finder's output is all but the fee: a higher fee would make it smaller, so no bump
  const solo = K.build({ key: KEY, utxos: [COIN], payout: FINDER, poolPayout: null, rate: 20 });
  throws(() => K.bump(solo.slip, { key: KEY, utxos: [COIN], payout: FINDER, poolPayout: null, rate: 100 }), /shrink the output of the finder/, 'bump with no pool part to pay for it: refused');
  throws(() => K.build({ key: KEY, utxos: [COIN], payout: FINDER, poolPayout: POOL, rate: 5000 }), /outside 1 to 2000/, 'build: a rate above the cap is refused');
}

console.log('claimkit.js: the commitment');
{
  const salt = 'a5'.repeat(32);
  const want = crypto.createHash('sha256').update(Buffer.concat([Buffer.from(KEY.toString(16).padStart(64, '0'), 'hex'), Buffer.from(FINDER, 'utf8'), Buffer.from(salt, 'hex')])).digest('hex');
  eq(K.commitment(KEY, FINDER, salt), want, 'sha256(key32 ‖ payout UTF-8 ‖ salt32), as Node\'s crypto computes it');
  ok(K.commitment(KEY, FINDER, 'a6'.repeat(32)) !== want, 'another salt: another commitment');
  ok(K.commitment(KEY, POOL, salt) !== want, 'another payout: another commitment');
  eq(K.preimage(KEY, FINDER, salt).length, 32 + FINDER.length + 32, 'the committed bytes: 32 + the address + 32');
  throws(() => K.commitment(KEY, FINDER, 'a5'), /32 bytes/, 'a short salt is refused');
}

console.log('claimkit.js: the OpenTimestamps file');
{
  // a real answer of a.pool.opentimestamps.org to POST /digest with 32 random bytes (2026-11-19)
  const digest = '890c135f64eeef3c4dd94ff1335af84f50239b8201ed38c3fce180f5105890f0';
  const real = S.fromHex('f00856c36962086b4f0608f010ccd6d9f97f0ee2cf0252f400bda347a008f120d9943155ba716e69242ddadcd6912f13cd36222d9ff685f6c49e481c035b602308f020395c100df27eb9cf2c076eb494e017527a3e1805bb8c0c6c7198a928e4ebf7b508f020e32e724950608fad6290f44a2cde1c8f64f77f4848e876352af0e81d6aaefac708f1046afed88af00814808292e3476d7a0083dfe30d2ef90c8e2e2d68747470733a2f2f616c6963652e6274632e63616c656e6461722e6f70656e74696d657374616d70732e6f7267');
  const one = K.otsFile(digest, [real]);
  // with one calendar, the file is the header, the version, sha256, the digest and the calendar's answer as it came
  const head = '004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294' + '01' + '08' + digest;
  eq(S.toHex(one), head + S.toHex(real), 'one calendar: header ‖ 01 ‖ 08 ‖ digest ‖ its answer, byte for byte');
  const r1 = K.otsRead(one);
  eq(r1.digest, digest, 'read back: the digest'); eq(r1.pending.join(), 'https://alice.btc.calendar.opentimestamps.org', 'read back: the calendar it waits on');
  // a second calendar (a made-up answer: append 8 bytes, sha256, pending at another URL): two branches, a fork
  const uri = new TextEncoder().encode('https://b.example.org');
  const other = Uint8Array.from([0xf0, 8, 1, 2, 3, 4, 5, 6, 7, 8, 0x08, 0x00, 0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e, uri.length + 1, uri.length].concat(Array.from(uri)));
  const two = K.otsFile(digest, [real, other]);
  const r2 = K.otsRead(two);
  eq(r2.pending.length, 2, 'two calendars: both pending attestations'); eq(two[head.length / 2], 0xff, 'two calendars: the first branch marked 0xff');
  eq(S.toHex(K.otsFile(digest, [real, real])), S.toHex(one), 'the same answer twice merges into one');
  throws(() => K.otsRead(one.slice(0, 40)), /cut short/, 'a cut file is refused');
  throws(() => K.otsRead(Uint8Array.from([1, 2, 3])), /not an OpenTimestamps file/, 'not a .ots file');
  eq(S.toHex(K.unb64(K.b64(two))), S.toHex(two), 'base64 there and back');
}

console.log('claimkit.js: the prize\'s own coins, never the dust');
{
  // #71 as it is: three coins of the prize and 70 small ones anyone sent (196,696 sat in all), 7.10196696 BTC
  const big = [639000000, 63900000, 7100000].map((v, i) => ({ txid: (i + 1).toString(16).padStart(64, '0'), vout: 0, value: v }));
  const dust = []; let left = 196696;
  for (let i = 0; i < 70; i++) { const v = i < 69 ? 2850 : left; dust.push({ txid: (100 + i).toString(16).padStart(64, '0'), vout: 1, value: v }); left -= v; }
  const coins = dust.slice(0, 30).concat(big, dust.slice(30));
  eq(coins.reduce((a, x) => a + x.value, 0), 710196696, 'the coins add up to 7.10196696 BTC');
  const u = K.spendable(coins);
  eq(u.map((x) => x.value).join(), '639000000,63900000,7100000', 'spendable: the three coins of the prize, largest first, no dust');
  const low = K.build({ key: KEY, utxos: u, payout: FINDER, poolPayout: POOL, rate: 10 });
  ok(T.parse(low.slip.hex).ins.length === 3 && low.slip.outs[0].value === 600000000, 'at 10 sat/vB: 3 inputs, the finder gets 6 BTC (' + low.slip.fee + ' sat in fees)');
  const hi = K.build({ key: KEY, utxos: u, payout: FINDER, poolPayout: POOL, rate: K.MAX_RATE });
  ok(hi.slip.fee <= 710000000 * 0.003, 'even at the most we pay (' + K.MAX_RATE + ' sat/vB) the fee is within 0.3% (' + hi.slip.fee + ' sat): hundreds of dust coins sent to the address change nothing');
  const flood = dust.concat(Array.from({ length: 500 }, (_, i) => ({ txid: (1000 + i).toString(16).padStart(64, '0'), vout: 0, value: 600 }))).concat(big);
  eq(K.spendable(flood).length, 3, 'with 570 dust coins on the address: still the three');
  eq(K.spendable(dust).length, 20, 'an address with no coin of the prize: its largest coins, at most 20');
}

console.log('claimkit.js: the pool\'s receipt');
{
  const d = BigInt('0x' + '33'.repeat(32));
  const body = { puzzle: 20, lease: 'ab'.repeat(16), commitment: 'cd'.repeat(32), payout: FINDER, finder_sats: 600000000, txids: ['ef'.repeat(32)], received: 1795000000 };
  const rc = K.receiptSign(d, body);
  ok(K.receiptVerify(rc), 'a receipt verifies');
  eq(rc.pub, K.pubHex(d), 'with the signer\'s public key');
  ok(!K.receiptVerify(Object.assign({}, rc, { body: Object.assign({}, body, { finder_sats: 1 }) })), 'a changed share: refused');
  ok(!K.receiptVerify(Object.assign({}, rc, { body: Object.assign({}, body, { payout: POOL }) })), 'another address: refused');
  ok(!K.receiptVerify(Object.assign({}, rc, { pub: K.pubHex(d + 1n) })), 'another key: refused');
  ok(!K.receiptVerify(Object.assign({}, rc, { sig: '00'.repeat(64) })), 'a zero signature: refused');
  ok(!K.receiptVerify(null) && !K.receiptVerify({}), 'nothing: refused');
  ok(/^04[0-9a-f]{128}$/.test(K.RECEIPT_PUB) && K.RECEIPT_PUB !== rc.pub, 'the published key is a public key, not the test one');
}

console.log('a coin\'s amount, from the transaction that made it');
{
  eq(K.outValue(FUND_HEX, COIN.txid, 0), 710000000, 'a legacy transaction: the amount, and it hashes to the txid');
  // the same transaction with a witness: the txid leaves the witness out, so it is the same
  const seg = FUND_HEX.slice(0, 8) + '0001' + FUND_HEX.slice(8, -8) + '01' + '02' + 'beef' + FUND_HEX.slice(-8);
  eq(K.outValue(seg, COIN.txid, 0), 710000000, 'a segwit one: the same txid, the same amount');
  const lower = FUND_HEX.replace((710000000).toString(16).padStart(16, '0').match(/../g).reverse().join(''), (610000000).toString(16).padStart(16, '0').match(/../g).reverse().join(''));
  throws(() => K.outValue(lower, COIN.txid, 0), /hashes to something else/, 'an amount changed by 1 BTC: it no longer hashes to the txid');
  throws(() => K.outValue(FUND_HEX, COIN.txid, 1), /no output 1/, 'an output that is not there');
  throws(() => K.outValue(FUND_HEX.slice(0, -2), COIN.txid, 0), /cut short|after the end/, 'a cut transaction');
}

done();
