// The GPU engine itself (web/engine/gpu.js), not a stand-in: headless Chromium with WebGPU on SwiftShader (a
// software GPU, slow but exact), the engine loaded as the pages load it. What it proves: every planted key is found
// where it was put, also 32 at once (the hit list never overflows); a stopped search continues from its pos and
// finds what lies after it; a pos made by an engine of another shape starts its chunk again, so nothing is skipped;
// a new search started the moment the last one is stopped waits for it, and both end cleanly; a search whose
// callback throws leaves the engine usable; the ranges where
// the point addition would meet two equal points (a range from key K + 1, a centre that is a multiple of the
// segment) lose no key; another shape on the same compiled engine (reshape, tune) passes the self-test and finds
// its keys, also with 257 keys a step.
// Usage: node gpu.js (CHROME=<path> picks the binary). About two minutes.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const WEB = path.join(__dirname, '..', 'web');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function chromePath() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = path.join(os.homedir(), '.cache', 'ms-playwright');
  for (const d of fs.existsSync(base) ? fs.readdirSync(base).filter((x) => x.startsWith('chromium-')).sort().reverse() : []) {
    for (const sub of ['chrome-linux64', 'chrome-linux']) { const p = path.join(base, d, sub, 'chrome'); if (fs.existsSync(p)) return p; }
  }
  throw new Error('no Chromium: set CHROME');
}

let failed = 0, passed = 0;
function ok(c, what) { if (c) { passed++; console.log('  ok   ' + what); } else { failed++; console.log('  FAIL ' + what); } }

// in the page: the engine's helpers the cases below share
const LIB = `
window.T = {
  S: null,
  async engine(K, threads) {
    const e = await BBGpu.create({ K, threads, nonce: 'test-' + K + '-' + threads });
    await e.selftest();
    return e;
  },
  // key at thread t, offset o into its segment
  at(e, from, to, t, o) { return from + BigInt(t) * e.seg(from, to) + BigInt(o); },
  // search [from, to] for these keys (side targets; the main one is a key outside the range): the keys found,
  // the last pos, and how it ended. stopAt: stop once that share of the range is checked
  async run(e, from, to, keys, opts) {
    opts = opts || {};
    const S = BBSecp, got = [], list = [S.hash160OfKey(from - 1n)].concat(keys.map((k) => S.hash160OfKey(k)));
    let pos = null, last = null;
    const h = e.search(from, to, list, (x) => { pos = x.pos; last = x; if (opts.stopAt && Number(x.checked) >= opts.stopAt * Number(x.total)) h.stop(); }, { resume: opts.resume || null, onHit: (k, i) => { if (i > 0) got.push(k); } });
    if (opts.handle) opts.handle(h);
    const r = await h.done;
    return { r, got, pos, checked: last && last.checked, total: last && last.total };
  },
};`;

(async () => {
  // the engine's files as the site serves them, and a blank page to load them into
  const srv = http.createServer((q, s) => {
    const u = q.url.split('?')[0];
    if (u === '/') { s.writeHead(200, { 'content-type': 'text/html' }); s.end('<!doctype html><meta charset="utf-8"><body>'); return; }
    const f = path.join(WEB, u);
    if (!f.startsWith(WEB)) { s.writeHead(403); s.end(); return; }
    fs.readFile(f, (e, b) => { if (e) { s.writeHead(404); s.end(); return; } s.writeHead(200, { 'content-type': 'text/javascript' }); s.end(b); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = 9400 + Math.floor(Math.random() * 500);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-gpu-'));
  const proc = spawn(chromePath(), ['--headless', '--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-webgpu-adapter=swiftshader', '--enable-unsafe-swiftshader', `--user-data-dir=${dir}`, `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore' });
  let tabs;
  for (let i = 0; i < 100 && !tabs; i++) { try { tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch (_) { await sleep(100); } }
  const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  const send = (method, params) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  async function ev(expr) {
    const d = await send('Runtime.evaluate', { expression: '(async () => {' + expr + '})()', awaitPromise: true, returnByValue: true, timeout: 600000 });
    if (d.result && d.result.exceptionDetails) throw new Error(JSON.stringify(d.result.exceptionDetails.exception && d.result.exceptionDetails.exception.description || d.result.exceptionDetails));
    return d.result && d.result.result && d.result.result.value;
  }
  const done = async () => {
    try { ws.close(); } catch (_) { /* gone */ }
    proc.kill(); srv.close();
    await new Promise((r) => { if (proc.exitCode !== null) r(); else proc.once('exit', r); });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* the OS cleans tmp */ }
  };
  try {
    await send('Page.navigate', { url: `http://127.0.0.1:${srv.address().port}/` });
    await sleep(800);
    await ev(`for (const s of ['/engine/secp.js', '/engine/gpu.js']) await new Promise((ok, no) => { const e = document.createElement('script'); e.src = s; e.onload = ok; e.onerror = no; document.head.appendChild(e); });` + LIB + 'return !!navigator.gpu;');

    console.log('planted keys, the whole range');
    let r = await ev(`const e = window.A = await T.engine(24, 1024), from = 1n << 40n, to = from + (1n << 21n) - 1n;
      const keys = [from, from + 1n, to, to - 49n, T.at(e, from, to, 0, 24), T.at(e, from, to, 513, 0), T.at(e, from, to, Number((to - from) / e.seg(from, to)), 1), (from + to) / 2n]; // the last thread that starts in range
      const x = await T.run(e, from, to, keys);
      return { ended: x.r === null, all: keys.every((k) => x.got.includes(k)), n: x.got.length, of: keys.length, checked: String(x.checked), total: String(x.total) };`);
    ok(r.ended && r.all && r.n === r.of, `every planted key found (${r.n} of ${r.of}: the range's ends, the segments' edges, the middle), the range ends with no main key`);
    ok(r.checked === r.total, 'the progress ends at the whole range (' + r.total + ' keys)');

    console.log('32 targets in one range: the hit list holds them all');
    r = await ev(`const e = window.A, from = (1n << 40n) + (1n << 22n), to = from + (1n << 21n) - 1n;
      const keys = []; for (let i = 0; i < 31; i++) keys.push(from + BigInt(i) * 66000n + 7n);
      const x = await T.run(e, from, to, keys);
      return { all: keys.every((k) => x.got.includes(k)), n: x.got.length };`);
    ok(r.all && r.n === 31, `31 side keys and the main target, all in one chunk: ${r.n} of 31 found`);

    console.log('stop and continue on the same engine');
    r = await ev(`const e = window.A, from = (1n << 40n) + (1n << 23n), to = from + (1n << 21n) - 1n, seg = e.seg(from, to);
      const early = T.at(e, from, to, 7, 3), late = T.at(e, from, to, 7, Number(seg) - 2), other = T.at(e, from, to, 900, Number(seg) - 30);
      const a = await T.run(e, from, to, [early, late, other], { stopAt: 0.4 });
      const b = await T.run(e, from, to, [early, late, other], { resume: a.pos });
      return { stopped: a.r === null && Number(a.checked) < Number(a.total), shape: a.pos.shape, firstEarly: a.got.includes(early), firstLate: a.got.includes(late), againEarly: b.got.includes(early), late: b.got.includes(late) && b.got.includes(other), startedAt: String(b.checked) };`);
    ok(r.stopped && r.firstEarly && !r.firstLate, 'stopped at about 40%: the key early in a segment found, the late one not yet');
    ok(r.late && !r.againEarly, 'continued from the pos: the late keys found, the early one not searched twice (pos ' + r.shape + ')');
    ok(BigInt(r.startedAt) > 0n, 'the continued search counts the keys searched before it (it did not start over)');

    console.log('a pos from an engine of another shape');
    r = await ev(`const a = window.A, b = await T.engine(32, 512), from = (1n << 40n) + (1n << 24n), to = from + (1n << 21n) - 1n;
      const keys = [T.at(a, from, to, 3, 5), T.at(a, from, to, 600, 100), T.at(b, from, to, 3, 5), T.at(b, from, to, 300, Number(b.seg(from, to)) - 3), to];
      const x = await T.run(a, from, to, keys, { stopAt: 0.5 });
      const y = await T.run(b, from, to, keys, { resume: x.pos });
      const all = keys.filter((k) => x.got.includes(k) || y.got.includes(k));
      // and the other way round
      const x2 = await T.run(b, from, to, keys, { stopAt: 0.5 });
      const y2 = await T.run(a, from, to, keys, { resume: x2.pos });
      const all2 = keys.filter((k) => x2.got.includes(k) || y2.got.includes(k));
      return { n: all.length, n2: all2.length, of: keys.length, restarted: y.got.length === keys.length && y2.got.length === keys.length };`);
    ok(r.n === r.of && r.n2 === r.of, `K24/1024 → K32/512 and back: ${r.n} and ${r.n2} of ${r.of} planted keys found (the old engine left holes here)`);
    ok(r.restarted, 'the other shape searched its chunk again from the start');

    console.log('several chunks (a small segMax): keys at their edges');
    r = await ev(`const e = window.A, from = (1n << 40n) + (1n << 28n), to = from + (1n << 22n) - 1n, segMax = 512;
      const S = BBSecp, B = BigInt(e.B), seg = e.seg(from, to, segMax), chunk = seg * BigInt(e.npts);
      const keys = [from, from + chunk - 1n, from + chunk, from + 3n * chunk + 5n, to];
      const list = [S.hash160OfKey(from - 1n)].concat(keys.map((k) => S.hash160OfKey(k))), got = [];
      const h = e.search(from, to, list, null, { segMax, onHit: (k, i) => { if (i > 0) got.push(k); } });
      const res = await h.done;
      return { chunks: Number((to - from + 1n + chunk - 1n) / chunk), n: got.length, all: keys.every((k) => got.includes(k)), once: new Set(got.map(String)).size === got.length, res: res === null };`);
    ok(r.chunks >= 4 && r.all && r.once && r.res, `${r.chunks} chunks: every key at a chunk's edge found once (${r.n} of 5)`);

    console.log('Stop, then a new search at once');
    r = await ev(`const e = window.A, from = (1n << 40n) + (1n << 25n), to = from + (1n << 21n) - 1n, k = T.at(e, from, to, 11, 17);
      let h1; const p1 = T.run(e, from, to, [k], { handle: (h) => { h1 = h; } });
      await new Promise((r) => setTimeout(r, 300)); h1.stop();
      const p2 = T.run(e, from, to, [k]);
      const [a, b] = await Promise.all([p1, p2]);
      // (stopped at 300 ms: no answer may have come yet, or one well short of the whole range)
      return { a: a.r === null && (a.checked == null || Number(a.checked) < Number(a.total)), b: b.got.includes(k) };`);
    ok(r.a && r.b, 'the stopped search ends early (not by running out of keys), the new one runs after it and finds its key (no read buffer mapped twice)');

    console.log('a callback that throws');
    r = await ev(`const e = window.A, from = (1n << 40n) + (1n << 27n), to = from + (1n << 21n) - 1n, k = T.at(e, from, to, 11, 17);
      let err = ''; const h = e.search(from, to, [BBSecp.hash160OfKey(from - 1n)], () => { throw new Error('boom'); }, {});
      try { await h.done; } catch (x) { err = x.message; }
      const b = await T.run(e, from, to, [k]);
      return { err, b: b.got.includes(k), ended: b.r === null && b.checked === b.total };`);
    ok(r.err === 'boom' && r.b && r.ended, 'the search ends with that error, and the next one runs to its end and finds its key (no read left in flight)');

    console.log('ranges where two equal points would be added');
    // from = K + 1: the first centre is key 2K + 1, the very point each step moves by
    r = await ev(`const e = window.A, from = BigInt(e.K + 1), to = from + 99999n;
      const keys = [from, from + 1n, from + BigInt(e.K), from + BigInt(2 * e.K), from + BigInt(2 * e.K + 1), from + 5000n, to];
      const x = await T.run(e, from, to, keys);
      // stopped and continued: the pos of the lowered first chunk leads back to it
      const a = await T.run(e, from, to, keys, { stopAt: 0.3 }), b = await T.run(e, from, to, keys, { resume: a.pos });
      return { n: x.got.length, of: keys.length, all: keys.every((k) => x.got.includes(k)), again: keys.every((k) => a.got.includes(k) || b.got.includes(k)), checked: String(x.checked), total: String(x.total) };`);
    ok(r.all && r.n === r.of && r.checked === r.total, `a range from key K + 1: ${r.n} of ${r.of} planted keys found, the first block among them`);
    ok(r.again, 'the same range stopped and continued: every key found');
    // the first chunk's centre a multiple of seg: thread 262 = 1·256 + 6 starts where the two init tables met
    r = await ev(`const e = window.A, seg = 490n, from = 250n * seg - BigInt(e.K), to = from + 1024n * seg - 1n;
      const keys = [T.at(e, from, to, 262, 5), T.at(e, from, to, 262, 489), T.at(e, from, to, 261, 7), T.at(e, from, to, 263, 0)];
      const x = await T.run(e, from, to, keys);
      return { seg: String(e.seg(from, to)), n: x.got.length, of: keys.length, all: keys.every((k) => x.got.includes(k)) };`);
    ok(r.seg === '490' && r.all, `a centre that is a multiple of the segment (seg ${r.seg}): ${r.n} of ${r.of} keys of the threads around the meeting point found`);

    console.log('another shape on the same compiled engine');
    r = await ev(`const e = window.A, from = (1n << 40n) + (1n << 26n), to = from + (1n << 21n) - 1n;
      const k24 = [T.at(e, from, to, 5, 11), to - 3n];
      const x = await T.run(e, from, to, k24, { stopAt: 0.5 });
      e.reshape(128, 256); await e.selftest();
      const k128 = [from, T.at(e, from, to, 255, 0), T.at(e, from, to, 100, 256), T.at(e, from, to, 100, 257), to].concat(k24);
      const y = await T.run(e, from, to, k128, { resume: x.pos });
      let busy = ''; const h = e.search(from, to, [BBSecp.hash160OfKey(1n)], null, {}); try { e.reshape(24, 1024); } catch (err) { busy = err.message; } h.stop(); await h.done;
      e.reshape(24, 1024); await e.selftest();
      const z = await T.run(e, from, to, k24);
      return { shape: y.pos.shape, all: k128.every((k) => y.got.includes(k)), n: y.got.length, of: k128.length, busy, back: k24.every((k) => z.got.includes(k)) };`);
    ok(r.all && r.n === r.of, `reshaped to 257 keys a step, 256 threads (pos ${r.shape}): the self-test passes, ${r.n} of ${r.of} planted keys found, the old shape's pos starts its chunk again`);
    ok(/while a search runs/.test(r.busy), 'no reshape while a search runs');
    ok(r.back, 'and back to the first shape: the self-test passes, its keys found');
    r = await ev(`const e = window.A, seen = [];
      const s = await e.tune({ seconds: 0.3, warm: 0.2, onShape: (x, rate) => seen.push(x.K + '/' + x.threads + ' ' + Math.round(rate)) });
      await e.selftest();
      return { s, seen, K: e.K, threads: e.threads };`);
    ok(r.s.K === r.K && r.s.threads === r.threads && r.s.rate > 0 && r.seen.length >= 1, `tune picks a shape and leaves the engine in it, self-test passed (${r.K}/${r.threads}; tried ${r.seen.join(', ')})`);
  } catch (err) {
    failed++; console.log('  FAIL ' + (err && err.message || err));
  } finally { await done(); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
