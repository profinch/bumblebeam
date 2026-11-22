// The benchmark table's proof (api/server.js: /api/bench/challenge, /api/bench/check, /api/bench), against the real
// API in its own process (tests/stack.js): a run that searched its whole range gets in with the server's own timing;
// one that stopped early, a made-up id, a form post and too many results a day do not; the table ranks by the median.
// The search here is the reference in Node (slow), so the challenges ask for a low rate. Run: node bench.test.js
'use strict';
const { S, ok, eq, done } = require('./engine.js');
const { stack } = require('./stack.js');

(async () => {
  const st = await stack();
  const api = 'http://127.0.0.1:' + st.apiPort;
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
  // (once more on a dropped connection: the search below blocks this process for seconds, and the server closes an idle
  // kept-alive socket meanwhile)
  const post = async (p, body, type, ip) => {
    const go = () => fetch(api + p, { method: 'POST', headers: { 'content-type': type || 'application/json', 'user-agent': UA, 'cf-connecting-ip': ip || '10.1.0.1' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    const r = await go().catch(go);
    return [r.status, await r.json().catch(() => ({}))];
  };
  // search a challenge's range with the reference, as a page would with its engine; stopAfter: give up after that many
  function solve(c, stopAfter) {
    const s = new S.Searcher(BigInt(c.from), BigInt(c.to), c.targets, 256), got = [];
    for (;;) {
      const r = s.next(1 << 16);
      r.hits.forEach((h) => { if (h.index > 0) got.push('0x' + h.key.toString(16)); });
      if (r.done || (stopAfter && got.length >= stopAfter)) return got;
    }
  }
  try {
    console.log('a proven run');
    let [code, c] = await post('/api/bench/challenge', { kind: 'cpu', rate: 2e5 });
    ok(code === 200 && c.id && c.targets.length === 24, 'a challenge: a range and 24 targets (the hidden keys among decoys)', c.targets && c.targets.length);
    const n = BigInt(c.to) - BigInt(c.from) + 1n;
    ok(n === 1000000n, 'its range: five seconds at the rate asked for, never under a million keys (' + n + ')');
    const keys = solve(c);
    ok(keys.length >= 8 && keys.length <= 16, 'between 8 and 16 keys are hidden in it (' + keys.length + ' found)');
    let r = await post('/api/bench/check', { id: c.id, keys });
    ok(r[0] === 200 && r[1].rate > 0, 'all of them sent back: the server\'s own rate', r[1]);
    r = await post('/api/bench', { id: c.id, threads: 8, cfg: 'test' });
    eq(r[0], 200, 'the result goes in the table');
    let table = await (await fetch(api + '/api/bench')).json();
    ok(table.rows.length === 1 && Math.abs(table.rows[0].median - r[1].rate) <= 1, 'the table shows the server\'s rate, not the page\'s');

    console.log('runs that must not get in');
    [code, c] = await post('/api/bench/challenge', { kind: 'cpu', rate: 2e5 }, null, '10.1.0.2');
    const some = solve(c, 4);
    r = await post('/api/bench/check', { id: c.id, keys: some }, null, '10.1.0.2');
    eq(r[0], 422, 'stopped after 4 keys (the old fixed count): refused, the range was not searched in full');
    eq((await post('/api/bench', { id: c.id, threads: 8 }, null, '10.1.0.2'))[0], 400, '... and it cannot be sent to the table');
    eq((await post('/api/bench', { id: 'ab'.repeat(16), threads: 8 }, null, '10.1.0.2'))[0], 400, 'a made-up id: refused');
    eq((await post('/api/bench', { kind: 'gpu', rate: 9e11, info: 'nvidia ampere' }, null, '10.1.0.2'))[0], 400, 'a rate typed in, no proof: refused');
    eq((await post('/api/bench/challenge', 'kind=cpu&rate=200000', 'application/x-www-form-urlencoded', '10.1.0.2'))[0], 400, 'a form post (another site\'s page could send one): refused');
    eq((await post('/api/bench/challenge', { kind: 'cpu', rate: 1001 }, null, '10.1.0.2'))[0], 400, 'a rate too low to mean anything: refused');
    eq((await post('/api/bench/challenge', { id: { toString: null }, rate: { valueOf: null } }, null, '10.1.0.2'))[0], 400, 'a malformed body: a 400, nothing hangs');

    console.log('the table ranks by the median');
    table = await (await fetch(api + '/api/bench')).json();
    ok(table.rows.every((x, i, a) => !i || a[i - 1].median >= x.median), 'sorted by the median');
  } catch (e) {
    ok(false, 'the test ran: ' + (e && e.message)); console.log(st.log.join('').slice(-1500));
  } finally { await st.stop(); }
  done();
})();
