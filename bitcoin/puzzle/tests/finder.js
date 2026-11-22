// The find's stand-ins for the browser tests (found-e2e.js): an engine that "finds" puzzle #20's key
// (0xd2c55) at once, the tests' receipt and transport keys told to the page as the published ones, a page on a fresh
// stack with the outside world caught (outside.js), and the steps every find takes: join the pool, play on /play.
'use strict';
const { stack, VAULT_KEY, TRANSPORT_PUB, sealedPost } = require('./stack.js');
const { outside } = require('./outside.js');
const { sleep } = require('./browser.js');
const { T, K, KEY, FINDER, wif } = require('./engine.js');

const KEY_HEX = KEY.toString(16);
const KEY_STRINGS = ['0x' + KEY_HEX, KEY_HEX.padStart(64, '0')];
// the stand-in engine, installed before the page's scripts by a setter on window.BBP: no GPU needed, and the
// first piece that holds 0xd2c55 "finds" it a moment after Start
const ENGINE = `(function(){
  Object.defineProperty(Navigator.prototype, 'gpu', { configurable: true, get: function () { return { requestAdapter: async function () { return null; } }; } });
  var b; Object.defineProperty(window, 'BBP', { configurable: true, get: function () { return b; }, set: function (v) { b = v;
    v.hasGpu = function () { return true; };
    v.gpuQuiet = async function () { return { K: 24, info: {}, search: function (from, to, targets, onP) {
      var stopped = false, h = { stop: function () { stopped = true; } };
      h.done = (async function () { await new Promise(function (r) { setTimeout(r, 300); }); if (stopped) return null;
        onP({ checked: to - from + 1n, total: to - from + 1n, rate: 2e8, seconds: 1, pos: { chunk: '0', done: 0 } });
        var k = 0x${KEY_HEX}n; return k >= from && k <= to ? k : null; })();
      return h; } }; };
  } });
})();`;

// the tests' server signs receipts with a test key (stack.js): the page is told that one is the published key, by a
// setter on window.BBKit as for the engine (nothing in the site's own code can change it)
const TEST_PUB = K.pubHex(BigInt('0x' + '33'.repeat(32)));
// and the key to seal a find for is the tests' transport key, the same way (window.BBSeal)
const TRANSPORT = `(function(){ var k; Object.defineProperty(window, 'BBSeal', { configurable: true, get: function () { return k; }, set: function (v) { v.TRANSPORT_PUB = '${TRANSPORT_PUB}'; k = v; } }); })();`;
const RECEIPT_KEY = `(function(){ var k; Object.defineProperty(window, 'BBKit', { configurable: true, get: function () { return k; }, set: function (v) { v.RECEIPT_PUB = '${TEST_PUB}'; k = v; } }); })();`;

// a page on a fresh stack, the outside world caught, the stand-in engine in place
async function setup(browser, opts) {
  const st = await stack(opts && opts.env);
  const page = await browser.page(opts && opts.width);
  const out = outside(page, KEY_STRINGS);
  if (opts && opts.cfg) Object.assign(out.cfg, opts.cfg);
  await out.start();
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: ENGINE });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: TRANSPORT });
  if (!(opts && opts.realReceiptKey)) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: RECEIPT_KEY });
  const errors = [];
  page.on((m, p) => { if (m === 'Runtime.exceptionThrown') errors.push(p.exceptionDetails.exception ? p.exceptionDetails.exception.description : p.exceptionDetails.text); });
  // the pages run under nginx's Content-Security-Policy (serve.js sends it): anything it blocks counts as an error
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: "document.addEventListener('securitypolicyviolation', function (e) { console.error('CSP blocked: ' + e.violatedDirective + ' ' + e.blockedURI); });" });
  page.on((m, p) => { if (m === 'Runtime.consoleAPICalled' && p.type === 'error' && p.args[0] && /^CSP blocked/.test(p.args[0].value)) errors.push(p.args[0].value); });
  return { st, page, out, errors };
}
// /pool: the address typed, Start; the searcher's page opens and the search finds the key
async function join(s) {
  await s.page.go(s.st.base + '/pool');
  await waitFor(s.page, "!!document.getElementById('g-addr')");
  await sleep(300);
  await s.page.eval(`var i = document.getElementById('g-addr'); i.value = '${FINDER}'; i.dispatchEvent(new Event('input')); document.getElementById('g-start').click(); 1`);
}
async function waitFor(page, expr, ms) {
  const end = Date.now() + (ms || 15000);
  while (Date.now() < end) { try { if (await page.eval(expr)) return true; } catch (_) { /* navigating */ } await sleep(100); }
  return false;
}
const rec = (page) => page.eval("JSON.parse(localStorage.getItem('bb-win') || 'null')");
const screen = (page) => page.eval("JSON.stringify({ text: document.body.innerText, html: document.documentElement.outerHTML })");
const keyOnScreen = async (page) => { const s = JSON.parse(await screen(page)); return KEY_STRINGS.concat([wif(KEY)]).some((k) => s.text.includes(k) || s.html.includes(k)); };
const relayPosts = (L) => L.filter((x) => x.method === 'POST' && x.kind === 'slipstream' && x.path === '/api/transactions');
const kept = (page) => waitFor(page, "(function(){var r=JSON.parse(localStorage.getItem('bb-win')||'null');return r&&r.server&&r.server.ok})()", 20000);
const findsOf = (st) => fetch(st.base + '/api/pool/finds').then((r) => r.json());
const statusOf = async (st, lease) => (await sealedPost(st.base, '/api/pool/found/status', { lease }))[1];

// /play with #20 made an open prize (the radar's answer changed in the page) and an engine that finds its key at once
const PLAY = `(function(){
  var f = window.fetch; window.fetch = function (u) { return f.apply(this, arguments).then(function (r) {
    if (!/\\/api\\/puzzles$/.test(String(u))) return r;
    return r.json().then(function (d) { d.target = 20; var p = d.puzzles[19]; p.status = 'open'; p.balance = 7.1; p.solved = null; return new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } }); });
  }); };
  var b; Object.defineProperty(window, 'BBP', { configurable: true, get: function () { return b; }, set: function (v) { b = v;
    v.hasGpu = function () { return true; };
    v.gpuQuiet = async function () { return { K: 24, info: {}, search: function (from, to, targets, onP) {
      var h = { stop: function () {} };
      h.done = new Promise(function (r) { setTimeout(function () { onP({ checked: 1000n, total: to - from + 1n, rate: 2e8, seconds: 1 }); r(0x${KEY_HEX}n); }, 300); });
      return h; } }; };
  } });
})();`;
async function playFind(b, opts) {
  const s = await setup(b, opts);
  await s.page.send('Page.addScriptToEvaluateOnNewDocument', { source: PLAY });
  if (opts.addr) await s.page.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('bb-addr', '${opts.addr}'); } catch (_) {}` });
  await s.page.go(s.st.base + '/play?n=lottery');
  await waitFor(s.page, "!!document.getElementById('p-start') && !document.getElementById('p-start').disabled", 15000); await sleep(500);
  await s.page.eval("document.getElementById('p-start').click(); 1");
  return s;
}
// the vault's rows, each with its key opened from its sealed file (vault.js), as the server would
const vaultOf = (st) => new Promise((ok2) => {
  const { DatabaseSync } = require('node:sqlite'), V = require('../api/vault.js').createVault(st.dir + '/vault', Buffer.from(VAULT_KEY, 'hex'));
  const db = new DatabaseSync(st.dir + '/pool.db');
  try { ok2(db.prepare('SELECT * FROM vault').all().map((r) => Object.assign(r, { inDb: r.key, key: (V.get(r.address) || {}).key }))); } finally { db.close(); }
});

module.exports = { KEY_HEX, KEY_STRINGS, ENGINE, TRANSPORT, RECEIPT_KEY, PLAY, setup, join, waitFor, rec, screen, keyOnScreen, relayPosts, kept, findsOf, statusOf, playFind, vaultOf };
