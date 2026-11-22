// Does anything move while a changed page loads? Each page at 390, 820 and 1100 px: the place and height of every
// block of <main> and the footer at DOMContentLoaded, against the same 4 s later (data in, fonts, the find's run).
// The pages the found-key flow changed: /rules, /proof (empty, and with a published find), /pool,
// and a searcher's own page holding a find (sent and waiting; spent). Run: node bitcoin/puzzle/tests/layout.js
'use strict';
const { launch, sleep } = require('./browser.js');
const { stack, sealedPost } = require('./stack.js');
const { outside } = require('./outside.js');
const { K, KEY, FINDER, POOL, ADDRESS, COIN, PUZZLE, ok, done } = require('./engine.js');

const SNAP = "function(){ return [...document.querySelectorAll('main > *, main section, main .panel, main .tiles, footer')].map(function(e,i){ var b=e.getBoundingClientRect(); return (e.id||((e.querySelector('.panel-title')||{}).textContent)||e.className||e.tagName).toString().slice(0,26)+'@'+i+':'+Math.round(b.top+scrollY)+'/'+Math.round(b.height); }); }";

// a find kept in the browser, as found.js leaves it: sent through both relays, told to the server (and spent)
function kept(spent) {
  const salt = '5a'.repeat(32), b = K.build({ key: KEY, utxos: [COIN], payout: FINDER, poolPayout: POOL, rate: 12, shield: null });
  const tx = { hex: b.slip.hex, txid: b.slip.txid, rate: 12, total: COIN.value, finder: 600000000, pool: b.slip.outs[1].value, fee: b.slip.fee };
  const r = { v: 2, key: '0x' + KEY.toString(16), puzzle: PUZZLE, address: ADDRESS, payout: FINDER, poolPayout: POOL, lease: 'ab'.repeat(16), from: '0x80000', to: '0xfffff', t: Date.now() - 60000,
    salt, commit: K.commitment(KEY, FINDER, salt), stamped: true, cal: [1, 2, 3, 4].map((i) => ({ url: 'https://cal' + i + '.example', ok: true, stamp: '' })), ots: null,
    tx: { slipstream: tx }, notes: [], checked: true, relays: { slipstream: { ok: true, said: 'Transaction submitted', t: Date.now() - 59000 } }, relayed: true,
    server: { ok: true, said: 'checked and kept it', t: Date.now() - 58000 }, told: true, serverTried: true };
  if (spent) r.spent = { txid: b.slip.txid, ours: true, t: Date.now() };
  return r;
}

// a find published on the server: leased, sent with its commitment and transactions, mined
async function publishedFind(st) {
  const post = (path, body) => fetch(st.base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const L = await post('/api/pool/lease', { addr: FINDER });
  const salt = '6b'.repeat(32), commitment = K.commitment(KEY, FINDER, salt);
  const b = K.build({ key: KEY, utxos: [COIN], payout: FINDER, poolPayout: POOL, rate: 12, shield: null });
  const stamp = Uint8Array.from([0x00, 0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e, 21, 20].concat(Array.from(new TextEncoder().encode('https://cal.example/'))));
  const [, r] = await sealedPost(st.base, '/api/pool/found', { lease: L.lease, key: '0x' + KEY.toString(16), salt, payout: FINDER, commitment, ots: K.b64(K.otsFile(commitment, [stamp])), txs: [{ relay: 'slipstream', hex: b.slip.hex }], receipts: {} });
  if (!r.ok) throw new Error('the find was refused: ' + JSON.stringify(r));
  st.mock.txs[b.slip.txid] = b.slip.hex; st.mock.mine(b.slip.txid);
  for (let i = 0; i < 50; i++) { if ((await (await fetch(st.base + '/api/pool/finds')).json()).finds[0].key) return; await sleep(200); }
  throw new Error('not published');
}

(async () => {
  const st = await stack();
  const st2 = await stack();
  await publishedFind(st2);
  const b = await launch();
  const cases = [
    ['/', null], ['/play', null], ['/learn', null], ['/bench', null], ['/rules', null], ['/proof', null], ['/proof', null, 'a find published', st2], ['/pool', null], ['/puzzle/20', null], ['/puzzle/71', null, 'a find published', st2],
    ['/pool/' + FINDER, kept(false), 'a find sent, waiting'], ['/pool/' + FINDER, kept(true), 'a find spent'],
  ];
  let moved = 0;
  for (const w of [390, 820, 1100]) {
    for (const [p, rec, label, on] of cases) {
      const page = await b.page(w);
      const out = outside(page, []);
      await out.start();
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('bb-addr', ${JSON.stringify(FINDER)}); ${rec ? `localStorage.setItem('bb-win', ${JSON.stringify(JSON.stringify(rec))});` : ''} } catch (_) {} document.addEventListener('DOMContentLoaded', function () { window.__p0 = (${SNAP})(); });` });
      await page.go((on || st).base + p); await sleep(4000);
      const [a, z] = JSON.parse(await page.eval(`JSON.stringify([window.__p0, (${SNAP})()])`));
      const diff = [];
      for (let i = 0; i < Math.min(a.length, z.length); i++) if (a[i] !== z[i]) diff.push(a[i] + ' -> ' + z[i].split(':')[1]);
      if (a.length !== z.length) diff.push(a.length + ' blocks -> ' + z.length);
      if (on) {
        // a published find: the list (the page's last block) grows when it comes; nothing above it may move
        const above = diff.filter((d) => !/^(finds|Finds|Puzzle #|foot)@/.test(d));
        ok(!above.length, `${p} (${label}) @${w}: nothing above the list moves (the list grows, the footer goes down: ${diff.filter((d) => /^foot@/.test(d)).join('') || 'no'})`, above.slice(0, 6));
      } else ok(!diff.length, `${p}${label ? ' (' + label + ')' : ''} @${w}: nothing moves`, diff.slice(0, 6));
      moved += diff.length ? 1 : 0;
      await page.close();
    }
  }
  b.close(); await st.stop(); await st2.stop();
  done();
  process.exit(process.exitCode);
})();
