// The found-key flow in a real (headless) browser against the real API, end to end, on puzzle #20 (key 0xd2c55)
// with a made-up 7.1 BTC coin: the stand-in engine "finds" the key in the first piece, then the page does the rest
// by itself. The outside world (calendars, relays, mempool.space) is outside.js's stand-ins; the server talks to
// mock.js. Nothing reaches a real relay. Run: node bitcoin/puzzle/tests/found-e2e.js [scenario name filter]
'use strict';
const { launch, sleep } = require('./browser.js');
const { S, T, K, KEY, FINDER, POOL, ADDRESS, COIN, wif, ok, eq, done } = require('./engine.js');
const { KEY_STRINGS, PLAY, setup, join, waitFor, rec, keyOnScreen, relayPosts, kept, findsOf, statusOf, playFind, vaultOf } = require('./finder.js');


const only = process.argv[2] || '';
const scenarios = [];
function scenario(name, fn) { scenarios.push({ name, fn }); }


// ---------------------------------------------------------------------------------------------------------------
scenario('happy path: calendars → Slipstream → server, the key hidden until the spend', async (b) => {
  const s = await setup(b);
  const t0 = Date.now();
  await join(s);
  ok(await waitFor(s.page, "(function(){var r=JSON.parse(localStorage.getItem('bb-win')||'null');return r&&r.server&&r.server.ok})()", 20000), 'the find runs through to the server by itself');
  const took = Date.now() - t0;
  const r = await rec(s.page);
  const L = s.out.ev.log;
  const cal = L.filter((x) => x.kind === 'calendar' && x.method === 'POST'), relays = relayPosts(L);
  const found = L.filter((x) => x.kind === 'found' && x.method === 'POST' && x.path === '/api/pool/found');
  eq(cal.length, 4, 'all four calendars were asked');
  ok(cal.every((x) => x.digest === r.commit), 'each got exactly the commitment\'s 32 bytes, nothing else');
  eq(relays.length, 1, 'Slipstream got the transaction');
  eq(L.filter((x) => x.kind === 'rebar').length, 0, 'Rebar is never asked');
  eq(found.length, 1, 'the server was told once');
  const lastCal = Math.max(...cal.map((x) => x.t)), firstRelay = Math.min(...relays.map((x) => x.t)), lastRelayAnswer = Math.max(...relays.map((x) => x.answered));
  ok(lastCal <= firstRelay, 'order: the calendars before Slipstream');
  ok(lastRelayAnswer <= found[0].t, 'order: Slipstream had answered before the server was told');
  ok(found[0].hasKey && found[0].sealed, 'the key went to the server, sealed for it (web/engine/seal.js)');
  eq(s.out.ev.keyIn.length, 0, 'no request of the whole page carries the key in the clear');
  eq(s.out.ev.sealedKey.length, 1, 'and it is in exactly one sealed request');
  ok(s.out.ev.sealedKey[0] && /\/api\/pool\/found$/.test(s.out.ev.sealedKey[0].url), '... that one: POST /api/pool/found');
  ok(s.out.ev.sealedKey[0] && s.out.ev.sealedKey[0].t >= lastRelayAnswer, '... sent after Slipstream answered');
  ok(!L.filter((x) => x.kind === 'found' && x.method === 'POST').some((x) => !x.sealed), 'every request to the server about the find is sealed (the status asks too)');
  console.log(`  (from Start to the server's answer: ${(took / 1000).toFixed(1)} s, incl. the page load and the stand-in search)`);
  const ms = (x) => '+' + (x - r.t) + ' ms';
  console.log(`  (the find's own timing, from the key found: calendars asked ${ms(Math.min(...cal.map((x) => x.t)))}, Slipstream asked ${ms(firstRelay)}, Slipstream answered ${ms(lastRelayAnswer)}, server asked ${ms(found[0].t)}, server answered ${ms(r.server.t)})`);
  // what the relays got: the split, checked independently here
  const coins = { [s.st.mock.coins[ADDRESS][0].txid + ':0']: 710000000 };
  const c = K.checkTx(s.out.ev.sent.slipstream[0], { key: KEY, coins, payout: FINDER, poolPayout: POOL });
  eq(c.finder, 600000000, 'Slipstream\'s transaction: 6 BTC to the finder'); ok(c.pool > 109000000 && c.fee > 0, 'the rest to the pool, the fee out of its part');
  ok(K.otsRead(K.unb64(r.ots)).digest === r.commit && K.otsRead(K.unb64(r.ots)).pending.length === 4, 'the .ots file stamps the commitment, four calendars pending');
  const text = await claimText(s.page);
  ok(/6 BTC is on its way to your address/.test(text), 'the finder reads "6 BTC is on its way to your address"', text.slice(0, 200));
  const tid = T.parse(s.out.ev.sent.slipstream[0]).txid;
  ok(text.includes(tid.slice(0, 8) + '…' + tid.slice(-8)), 'with the txid (its first and last eight)');
  ok(/MARA Slipstream\s+submitted, transaction/.test(text), 'and that Slipstream took it');
  ok(!/support@/.test(text), 'nothing about support: all went well');
  ok(r.receiptOk && r.receiptPublished, 'the pool\'s receipt: about this find, signed with the published key', { ok: r.receiptOk, pub: r.receiptPublished });
  ok(/signed with the published key/.test(text) && !/Save the receipt/.test(text), '"signed with the published key" on the page (its Save comes with the key, once the prize is safe)');
  ok(!(await keyOnScreen(s.page)), 'the key is nowhere on the page (text or HTML)');
  // the server's side
  await sleep(500);
  const st = await statusOf(s.st, r.lease);
  ok(st.recorded && st.status === 'pending' && st.held, 'the server recorded it, holds the key, waits for the spend');
  ok(s.st.mock.log.some((x) => x.path === '/slip/api/transactions'), 'the server sent it through Slipstream again itself');
  const lease = await (await fetch(s.st.base + '/api/pool/lease', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ addr: POOL }) })).json();
  ok(/was found/.test(lease.error || ''), 'no more pieces of #20 go out', lease);
  let pub = (await findsOf(s.st)).finds[0];
  ok(pub && !pub.key && !pub.piece && pub.commitment === r.commit, '/api/pool/finds: the commitment only, no key and no piece yet');
  // the spend: mined, the server publishes, the page shows the key after a reload
  s.st.mock.mine(T.parse(s.out.ev.sent.slipstream[0]).txid);
  s.out.cfg.mined.add(T.parse(s.out.ev.sent.slipstream[0]).txid);
  ok(await waitFor(s.page, 'true', 100) && await (async () => { for (let i = 0; i < 50; i++) { pub = (await findsOf(s.st)).finds[0]; if (pub.key) return true; await sleep(200); } return false; })(), 'once mined, the server publishes the key');
  await s.page.go(s.st.base + '/pool/' + FINDER);
  ok(await waitFor(s.page, "(function(){var r=JSON.parse(localStorage.getItem('bb-win')||'null');return r&&r.spent})()", 15000), 'the page sees the spend');
  await sleep(300);
  ok(await keyOnScreen(s.page), 'and shows the key now');
  ok(/The prize is spent: 6 BTC went to your address/.test(await s.page.eval('document.getElementById("claim").innerText')), '"The prize is spent: 6 BTC went to your address"');
  eq(s.errors.length, 0, 'no script errors', s.errors);
  s.keep = { st: s.st, page: s.page, pub };
  return s;
});


// a find that has stopped moving: every step that will happen has happened
const settled = (page) => waitFor(page, "(function(){var r=JSON.parse(localStorage.getItem('bb-win')||'null');return r&&(r.serverTried||r.buildError)&&!(window.BBFound&&BBFound.busy())})()", 30000);
// the find's card as read, its fold of steps opened
const claimText = (page) => page.eval('(function(){var c=document.getElementById(\'claim\');c.querySelectorAll(\'details\').forEach(function(d){d.open=true});return c.innerText})()');
const reload = async (s) => { await s.page.go(s.st.base + '/pool/' + FINDER); await waitFor(s.page, "!!document.getElementById('claim') && !document.getElementById('claim').hidden"); };
// the key reached the server only after Slipstream had answered, and in no other request
function keyAfterRelays(s, name) {
  const posts = relayPosts(s.out.ev.log).filter((x) => x.answered), lastAnswer = Math.max(0, ...posts.map((x) => x.answered));
  ok(!s.out.ev.keyIn.length && s.out.ev.sealedKey.length >= 1 && s.out.ev.sealedKey.every((k) => /\/api\/pool\/found$/.test(k.url) && k.t >= lastAnswer), name + ': the key left the page only in POST /api/pool/found, sealed, after Slipstream answered', { clear: s.out.ev.keyIn, sealed: s.out.ev.sealedKey });
}
// the page's word when the server keeps the key: write to support, the timestamp and the receipt prove the find
async function supportNote(s, name) {
  const t = await claimText(s.page);
  ok(/kept on our server/.test(t) && /needs nothing more from you/.test(t) && /write to support@bumblebeam\.org/.test(t) && /proof that your address found this key/.test(t), name + ': "the key is kept on our server, nothing more needed, write to support@bumblebeam.org to be safe", with the proof', t.slice(0, 500));
  ok(await s.page.eval("!document.querySelector('#claim .key-info.attn')"), name + ': no red attention block, only an info one');
  ok(!(await keyOnScreen(s.page)), name + ': the key is not on the page');
}

scenario('reload while Slipstream has not answered: it carries on, the server still last', async (b) => {
  const s = await setup(b, { cfg: { slip: 'hold' } });
  await join(s);
  ok(await (async () => { for (let i = 0; i < 100; i++) { if (s.out.ev.held.length >= 1) return true; await sleep(100); } return false; })(), 'Slipstream has the request, unanswered');
  const before = await rec(s.page);
  ok(before && before.commit && !before.relayed && !before.server, 'kept: the commitment, not yet relayed, server not told');
  eq(s.out.ev.keyIn.length + s.out.ev.sealedKey.length, 0, 'the key has gone nowhere');
  // the tab reloads; Slipstream answers from now on
  s.out.cfg.slip = 'ok';
  await reload(s);
  ok(await kept(s.page), 'after the reload the flow carries on to the server');
  const after = await rec(s.page);
  eq(after.commit, before.commit, 'the same commitment (no new salt)');
  eq(s.out.ev.log.filter((x) => x.kind === 'calendar' && x.method === 'POST').length, 4, 'the calendars were not asked again');
  eq(relayPosts(s.out.ev.log).length, 2, 'Slipstream got it again (1 cancelled, 1 answered)');
  keyAfterRelays(s, 'after the reload');
  return s;
});

scenario('reload while the server is being told: Slipstream is not asked again', async (b) => {
  const s = await setup(b, { cfg: { found: 'hold' } });
  await join(s);
  ok(await (async () => { for (let i = 0; i < 150; i++) { if (s.out.ev.held.some((h) => h.kind === 'found')) return true; await sleep(100); } return false; })(), 'the request to the server is on its way (held)');
  s.out.cfg.found = 'ok';
  await reload(s);
  ok(await kept(s.page), 'after the reload the server is told');
  eq(relayPosts(s.out.ev.log).length, 1, 'Slipstream had it already: not sent again');
  const st = await statusOf(s.st, (await rec(s.page)).lease);
  ok(st.recorded && st.held, 'the server has it');
  ok(!(await keyOnScreen(s.page)), 'the key is not on the page');
  return s;
});

scenario('no calendar answers: the claim goes on without the timestamp', async (b) => {
  const s = await setup(b, { cfg: { calAll: 'down' } });
  await join(s); await settled(s.page);
  const r = await rec(s.page);
  ok(r.server && r.server.ok && r.ots === null, 'Slipstream and the server done, no .ots');
  ok(/no calendar answered/.test(await claimText(s.page)), 'the page says so');
  ok(!(await keyOnScreen(s.page)), 'the key is not on the page');
  return s;
});

scenario('one calendar fails: the .ots has the other three', async (b) => {
  const s = await setup(b, { cfg: { cal: { 'b.pool.opentimestamps.org': 'fail' } } });
  await join(s); await settled(s.page);
  const r = await rec(s.page);
  eq(K.otsRead(K.unb64(r.ots)).pending.length, 3, 'the .ots has the three calendars that answered');
  ok(r.server.ok && r.relays.slipstream.ok, 'Slipstream and the server took it');
  ok(/3 of 4 calendars/.test(await claimText(s.page)), 'the page says 3 of 4 calendars stamped it');
  return s;
});

for (const mode of ['fail', 'down']) {
  scenario('Slipstream ' + (mode === 'fail' ? 'refuses' : 'cannot be reached') + ': the key goes to the server, which keeps it and sends the claim itself; the page says to write to support', async (b) => {
    const s = await setup(b, { cfg: { slip: mode } });
    await join(s); await settled(s.page);
    const r = await rec(s.page);
    ok(r.relayed && !r.relays.slipstream.ok && r.server.ok, 'Slipstream ✗, server ✓');
    await supportNote(s, 'Slipstream ' + mode);
    await sleep(500);
    const st = await statusOf(s.st, r.lease);
    ok(st.vault === true && st.held, 'the server has the key in its vault and holds the claim');
    ok(s.st.mock.log.some((x) => x.path === '/slip/api/transactions'), 'the server sent the claim through Slipstream itself');
    keyAfterRelays(s, 'Slipstream ' + mode);
    return s;
  });
}

scenario('Slipstream fine, our server down: sent, the server told on the next visit', async (b) => {
  const s = await setup(b, { cfg: { found: 'down' } });
  await join(s); await settled(s.page);
  const r = await rec(s.page);
  ok(r.relays.slipstream.ok && !r.server.ok && !r.told, 'Slipstream ✓, server not reached');
  ok(s.out.ev.urls.some((u) => /\/api\/pool\/ping$/.test(u)), 'meanwhile the page keeps the piece\'s lease alive (a silent piece would go to the next searcher, the key in it)');
  ok(/is on its way to your address/.test(await claimText(s.page)) && !(await keyOnScreen(s.page)), 'the page: sent, the key hidden');
  s.out.cfg.found = 'ok';
  await reload(s);
  ok(await kept(s.page), 'on the next visit the server is told');
  eq(relayPosts(s.out.ev.log).length, 1, 'Slipstream is not asked again');
  return s;
});

scenario('Slipstream and the server unreachable: kept in this browser, "write to support" with the sealed find', async (b) => {
  const s = await setup(b, { cfg: { slip: 'down', found: 'down' } });
  await join(s); await settled(s.page);
  await sleep(300);
  const t = await claimText(s.page);
  ok(/kept in this browser only/.test(t) && /Write to support@bumblebeam\.org now/.test(t), 'the page: kept in this browser, write to support', t.slice(0, 400));
  ok(!(await keyOnScreen(s.page)), 'the key is not shown by itself');
  ok(await s.page.eval("!!document.querySelector('#claim [data-sealed]') && !document.querySelector('#claim [data-manual]')"), 'a button saves the find sealed for our server (no claim by hand)');
  // the file the button saves: caught on its way to the download
  await s.page.eval("window.__files = []; URL.createObjectURL = function (b) { window.__files.push(b); return 'blob:sealed'; }; HTMLAnchorElement.prototype.click = function () {}; document.querySelector('#claim [data-sealed]').click(); 1");
  ok(await waitFor(s.page, "window.__files.length === 1", 5000), 'pressed: a file is saved');
  const file = JSON.parse(await s.page.eval("window.__files[0].text()"));
  ok(file.path === '/api/pool/found' && file.sealed && file.sealed.seal === 1 && file.sealed.epk && !JSON.stringify(file).includes(KEY.toString(16)) && !(await keyOnScreen(s.page)), 'the file: the sealed request, the key nowhere in it in the clear, nor on the page', Object.keys(file));
  // support gives its sealed part to the server as it is: the find is taken, as if the page had sent it
  const sr = await fetch(s.st.base + file.path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(file.sealed) });
  eq(sr.status, 200, 'support posts the sealed part to /api/pool/found: the server takes the find');
  ok((await findsOf(s.st)).finds.some((f) => f.commitment === file.commitment), '... and records it');
  ok(s.out.ev.keyIn.length === 0 && s.out.ev.sealedKey.length === 3, 'the key went out only in the three failed attempts to reach the server, sealed', { clear: s.out.ev.keyIn.length, sealed: s.out.ev.sealedKey.length });
  // everything back: the next visit tries Slipstream again, then the server
  Object.assign(s.out.cfg, { slip: 'ok', found: 'ok' });
  await reload(s);
  ok(await waitFor(s.page, "(function(){var r=JSON.parse(localStorage.getItem('bb-win')||'null');return r&&r.server&&r.server.ok&&r.relays.slipstream.ok})()", 25000), 'next visit: Slipstream ✓ then server ✓');
  const posts = relayPosts(s.out.ev.log), found = s.out.ev.log.filter((x) => x.kind === 'found' && x.method === 'POST' && x.path === '/api/pool/found');
  ok(Math.max(...posts.filter((x) => x.answered && x.t > found[2].t).map((x) => x.answered)) <= found[found.length - 1].t, 'Slipstream answered before the server was told again');
  return s;
});

scenario('the coins cannot be read: nothing built here, the key to the server, which builds and sends the claim; "write to support"', async (b) => {
  const s = await setup(b, { cfg: { mempool: 'down', blockstream: 'down' } });
  await join(s); await settled(s.page);
  const r = await rec(s.page);
  ok(!r.tx && /did not answer|cannot be reached/.test(r.buildError || ''), 'no transaction here: the coins could not be read', r.buildError);
  eq(relayPosts(s.out.ev.log).length, 0, 'nothing went to Slipstream from the page');
  ok(r.server && r.server.ok, 'the server took the key');
  await supportNote(s, 'no coins read');
  await sleep(500);
  const st = await statusOf(s.st, r.lease);
  ok(st.vault && st.pool_txs && st.pool_txs.length === 1, 'the server built the claim itself and keeps the key');
  ok(await waitFor(s.page, "(function(){var r=JSON.parse(localStorage.getItem('bb-win')||'null');return r&&r.receiptOk})()", 90000), 'the pool\'s receipt is judged good (the page built no transaction of its own to compare it with)');
  return s;
});

scenario('mempool.space down: blockstream.info alone, the amount checked against its transaction', async (b) => {
  const s = await setup(b, { cfg: { mempool: 'down' } });
  await join(s); await settled(s.page);
  const r = await rec(s.page);
  ok(r.server.ok && r.checked === false, 'sent, from one explorer');
  ok(s.out.ev.log.some((x) => x.host === 'blockstream.info' && x.path === '/api/tx/' + COIN.txid + '/hex'), 'the coin\'s own transaction was read to check its amount');
  ok(/one explorer, amounts checked/.test(await claimText(s.page)), 'the page says so');
  return s;
});

scenario('an explorer gives the coin as 1 BTC smaller: the amount comes from its transaction', async (b) => {
  const s = await setup(b, { cfg: { lowball: 'mempool' } });
  await join(s); await settled(s.page);
  const r = await rec(s.page);
  const tx = s.out.ev.sent.slipstream[0], c = tx && K.checkTx(tx, { key: KEY, coins: { [COIN.txid + ':' + COIN.vout]: COIN.value }, payout: FINDER, poolPayout: POOL });
  ok(r.server.ok && c && c.fee < 1e6, 'sent, and its fee is a fee (not the 1 BTC the explorer hid)', c && c.fee);
  eq(c && c.finder, 600000000, 'the finder\'s 6 BTC');
  return s;
});

scenario('the claim never asks our own server for the coins or the fees', async (b) => {
  const s = await setup(b, {});
  await join(s); await settled(s.page);
  ok((await rec(s.page)).server.ok, 'sent and told');
  const asked = s.out.ev.urls.filter((u) => /\/api\/(puzzles\/\d+\/utxos|fees)/.test(u));
  eq(asked.length, 0, 'no request for the puzzle\'s coins or the fees went to our server', asked);
  return s;
});

scenario('the server refuses: shown, Slipstream\'s transaction stands', async (b) => {
  const s = await setup(b, { cfg: { found: 'refuse' } });
  await join(s); await settled(s.page);
  const r = await rec(s.page), t = await claimText(s.page);
  ok(r.server.refused && r.relays.slipstream.ok, 'refused by the server, taken by Slipstream');
  ok(/said no: refused by the test/.test(t) && /is on its way to your address/.test(t) && !(await keyOnScreen(s.page)), 'the page says so, the key stays hidden');
  return s;
});

scenario('a payout address is required to search', async (b) => {
  const s = await setup(b);
  await s.page.go(s.st.base + '/pool');
  await waitFor(s.page, "!!document.getElementById('g-start')"); await sleep(300);
  await s.page.eval("document.getElementById('g-start').click(); 1"); await sleep(500);
  eq(await s.page.eval('location.pathname'), '/pool', 'Start with no address stays on /pool');
  ok(/enter your Bitcoin address first/.test(await s.page.eval("document.getElementById('g-addr-note').textContent")), 'and says an address is needed');
  eq((await fetch(s.st.base + '/pool/search', { redirect: 'manual' })).status, 404, 'there is no page to search without an address (/pool/search: a 404)');
  const r = await fetch(s.st.base + '/api/pool/lease', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  eq(r.status, 400, 'the API: a lease without an address is refused');
  return s;
});

scenario('every combination of calendars × Slipstream × server ends in a sane state', async (b) => {
  // sane: the key never shows by itself and never leaves the page before Slipstream answered; Slipstream or the
  // server took the claim, or (neither reached) the page says it is kept here and to write to support
  let n = 0;
  for (const calAll of ['ok', 'down']) for (const slip of ['ok', 'fail', 'down']) for (const found of ['ok', 'down']) {
    const s = await setup(b, { cfg: { calAll, slip, found } });
    await join(s); await settled(s.page);
    const r = await rec(s.page), shown = await keyOnScreen(s.page), t = await claimText(s.page);
    const took = (r.relays.slipstream && r.relays.slipstream.ok) || (r.server && r.server.ok);
    const posts = relayPosts(s.out.ev.log).filter((x) => x.answered), lastAnswer = Math.max(0, ...posts.map((x) => x.answered));
    const early = s.out.ev.keyIn.concat(s.out.ev.sealedKey.filter((k) => k.t < lastAnswer || !/\/api\/pool\/found$/.test(k.url)));
    const said = r.relays.slipstream.ok ? /is on its way to your address/.test(t) : r.server && r.server.ok ? /kept on our server/.test(t) : /kept in this browser only/.test(t);
    ok(!shown && said && !early.length && !!r.serverTried, `calendars ${calAll}, Slipstream ${slip}, server ${found}: ${r.relays.slipstream.ok ? 'sent' : took ? 'kept on the server, write to support' : 'kept here, write to support'}, key hidden`, { took, shown, said, early: early.length, server: r.server });
    n++;
    await s.page.close().catch(() => {}); await s.st.stop();
  }
  eq(n, 12, 'all 12 combinations ran');
  return null;
});

scenario('/play: a key for an open prize with no payout address: kept on the server, "write to support"', async (b) => {
  const s = await playFind(b, {});
  ok(await waitFor(s.page, "/kept on our server/.test((document.getElementById('p-claim')||{}).innerText||'')", 25000), 'the page says the key is kept on our server');
  const t = await s.page.eval("document.getElementById('p-claim').innerText");
  ok(/Write to support@bumblebeam\.org now/.test(t) && /no payout address/.test(t) && /timestamped/.test(t), '"write to support@bumblebeam.org now", why, and that the commitment is timestamped', t.slice(0, 400));
  const v = await vaultOf(s.st);
  ok(v.length === 1 && v[0].source === 'play' && v[0].key === '0x' + KEY.toString(16) && !v[0].inDb && v[0].commitment, 'the server\'s vault has the key (sealed in its file, not in the database), with its commitment');
  eq(relayPosts(s.out.ev.log).length, 0, 'nothing went to Slipstream');
  ok(!(await keyOnScreen(s.page)), 'the key is nowhere on the page (text or HTML)');
  ok(!s.out.ev.keyIn.length && s.out.ev.sealedKey.length >= 1 && s.out.ev.sealedKey.every((k) => /\/api\/pool\/solo$/.test(k.url)), 'the key went only to POST /api/pool/solo, sealed', { clear: s.out.ev.keyIn.length });
  return s;
});

scenario('/play: with a payout address the prize is sent through Slipstream; Slipstream down: kept on the server', async (b) => {
  let s = await playFind(b, { addr: FINDER });
  ok(await waitFor(s.page, "/submitted, transaction/.test((document.getElementById('p-claim')||{}).innerText||'')", 25000), 'sent through Slipstream by itself');
  const tx = s.out.ev.sent.slipstream[0], c = tx && K.checkTx(tx, { key: KEY, coins: { [COIN.txid + ':0']: COIN.value }, payout: FINDER, poolPayout: null });
  ok(c && c.finder === COIN.value - c.fee, 'all of it to the player\'s address, less the fee');
  eq((await vaultOf(s.st)).length, 0, 'nothing kept on the server');
  ok(!(await keyOnScreen(s.page)), 'the key is nowhere on the page (text or HTML), nor the transaction\'s hex', await s.page.eval("document.getElementById('f-hex').textContent"));
  ok(!(await s.page.eval("document.documentElement.outerHTML")).includes(tx), '... the hex (it shows the public key) is not on the page either');
  ok(await waitFor(s.page, "/Waiting for a MARA block/.test(document.getElementById('p-claim').innerText)", 10000), 'it says the key shows once the prize is 6 blocks deep');
  // a reload before it is mined: the same transaction to Slipstream again, still no key
  await s.page.go(s.st.base + '/play');
  ok(await waitFor(s.page, "/is on its way to your address/.test((document.getElementById('p-claim')||{}).innerText||'')", 15000), 'a reload: shown as sent');
  await sleep(1000);
  const again = s.out.ev.sent.slipstream;
  ok(again.length === 2 && again[1] === again[0], '... the same signed transaction given to Slipstream again, not a new one', again.length);
  ok(!(await keyOnScreen(s.page)), '... the key still hidden');
  // mined and 6 deep (mempool.space's stand-in: confirmed at 900001, the tip at 900006, no coin left): shown
  s.out.cfg.mined.add(T.parse(tx).txid);
  await s.page.go(s.st.base + '/play');
  ok(await waitFor(s.page, "/Spent and 6 blocks deep/.test((document.getElementById('p-claim')||{}).innerText||'')", 15000), 'mined and 6 blocks deep: the page says so');
  ok(await keyOnScreen(s.page), '... and shows the key now');
  s.out.cfg.mined.clear();
  await s.page.close().catch(() => {}); await s.st.stop();
  s = await playFind(b, { addr: FINDER, cfg: { slip: 'down' } });
  ok(await waitFor(s.page, "/kept on our server/.test((document.getElementById('p-claim')||{}).innerText||'')", 30000), 'Slipstream down: the key kept on our server, "write to support"');
  const v = await vaultOf(s.st);
  ok(v.length === 1 && v[0].payout === FINDER, '... with the player\'s address');
  ok(!(await keyOnScreen(s.page)), '... and the key is not on the page');
  return s;
});

// the home page's lucky key on #20 made the open target (PLAY), its draw made to hit: the browser's random numbers,
// for the five open digits, are 0xd2c55's (the first digit's values run from 8, the others from 0), once: a find
// kept in this browser means it hit already
const HIT = `(function(){ var g = crypto.getRandomValues.bind(crypto); crypto.getRandomValues = function (a) { if (a instanceof Uint32Array && a.length === 5 && !localStorage.getItem('bb-lucky-win')) { a.set([5, 2, 12, 5, 5]); return a; } return g(a); }; })();`;
async function luckyHit(b, opts) {
  const s = await setup(b, opts);
  await s.page.send('Page.addScriptToEvaluateOnNewDocument', { source: PLAY });
  await s.page.send('Page.addScriptToEvaluateOnNewDocument', { source: HIT });
  if (opts.addr) await s.page.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('bb-addr', '${opts.addr}'); } catch (_) {}` });
  await s.page.go(s.st.base + '/');
  return s;
}
scenario('home: the lucky key hits an open prize: the key hidden at once, the prize sent to the saved address; no address: kept on the server', async (b) => {
  let s = await luckyHit(b, { addr: FINDER });
  ok(await waitFor(s.page, "!!document.querySelector('#target-try.found')", 20000), 'a draw opens #20');
  await sleep(500);
  ok(!(await keyOnScreen(s.page)) && await s.page.eval("Array.prototype.every.call(document.querySelectorAll('#target-try i.o'), function (i) { return i.textContent === '•'; }) && document.querySelector('#target-try .cp').hidden"), 'the key is nowhere on the page: its digits are dots, no copy button');
  ok(await waitFor(s.page, "/submitted, transaction/.test((document.getElementById('lucky-claim')||{}).innerText||'')", 30000), 'the prize sent through Slipstream by itself, under the card');
  const tx = s.out.ev.sent.slipstream[0], c = tx && K.checkTx(tx, { key: KEY, coins: { [COIN.txid + ':0']: COIN.value }, payout: FINDER, poolPayout: null });
  ok(c && c.finder === COIN.value - c.fee, 'all of it to the visitor\'s address, less the fee');
  ok(!(await keyOnScreen(s.page)) && !(await s.page.eval("document.documentElement.outerHTML")).includes(tx), 'still no key, nor the transaction\'s hex');
  await s.page.go(s.st.base + '/');
  ok(await waitFor(s.page, "!!document.querySelector('#target-try.found') && /lucky one/.test(document.getElementById('target-try-title').textContent)", 20000), 'a reload: the tile comes back found, the winner\'s title on it');
  await sleep(2000);
  ok(!(await keyOnScreen(s.page)) && await s.page.eval("Array.prototype.every.call(document.querySelectorAll('#target-try i.o'), function (i) { return i.textContent === '•'; }) && document.querySelector('#target-try .cp').hidden"), '... the key still dots, no copy button, no draws');
  s.out.cfg.mined.add(T.parse(tx).txid);
  await s.page.go(s.st.base + '/');
  ok(await waitFor(s.page, "/Spent and 6 blocks deep/.test((document.getElementById('lucky-claim')||{}).innerText||'')", 20000) && await keyOnScreen(s.page), 'mined and 6 deep: on the next visit the key is shown');
  ok(await waitFor(s.page, "Array.prototype.map.call(document.querySelectorAll('#target-try i.o'), function (i) { return i.textContent; }).join('') === 'd2c55' && !document.querySelector('#target-try .cp').hidden", 10000), '... and in the tile too, with its copy button');
  await s.page.close().catch(() => {}); await s.st.stop();
  s = await luckyHit(b, {});
  ok(await waitFor(s.page, "/kept on our server/.test((document.getElementById('lucky-claim')||{}).innerText||'')", 30000), 'no payout address: the key kept on our server, "write to support"');
  const v = await vaultOf(s.st);
  ok(v.length === 1 && v[0].source === 'lucky' && v[0].key === '0x' + KEY.toString(16), '... in the vault as the lucky key\'s');
  ok(!(await keyOnScreen(s.page)) && !s.out.ev.keyIn.length, '... the key on no page and in no request in the clear');
  return s;
});

scenario('a receipt signed with a key that is not the published one: shown as worthless', async (b) => {
  const s = await setup(b, { realReceiptKey: true });
  await join(s);
  ok(await waitFor(s.page, "(function(){var r=JSON.parse(localStorage.getItem('bb-win')||'null');return r&&r.server&&r.server.ok&&r.receipt})()", 20000), 'a find, told, a receipt given');
  const r = await rec(s.page);
  ok(r.receiptOk && !r.receiptPublished, 'its signature holds, but the key is not the published one');
  ok(/NOT with the key the pool publishes/.test(await claimText(s.page)), 'and the page says it proves nothing');
  return s;
});

scenario('/proof: a spent find verifies in the browser; tampered ones are flagged', async (b) => {
  const s = await setup(b);
  await join(s);
  ok(await waitFor(s.page, "(function(){var r=JSON.parse(localStorage.getItem('bb-win')||'null');return r&&r.server&&r.server.ok})()", 20000), 'a find, sent and told');
  // before the spend: the commitment only
  await s.page.go(s.st.base + '/proof');
  ok(await waitFor(s.page, "!!document.querySelector('.proof-find')"), '/proof lists the find');
  let t = await s.page.eval("document.querySelector('.proof-find').innerText");
  ok(/waiting for the prize to be spent/.test(t) && !(await keyOnScreen(s.page)) && await s.page.eval("document.querySelector('[data-verify]').disabled"), 'pending: commitment and .ots only, no key, Verify off');
  // mined; the server publishes
  const txid = T.parse(s.out.ev.sent.slipstream[0]).txid;
  s.st.mock.mine(txid); s.out.cfg.mined.add(txid);
  for (let i = 0; i < 50 && !(await findsOf(s.st)).finds[0].key; i++) await sleep(200);
  async function verifyWith(tamper) {
    // the test changes the server's answer on its way into the page (as a hacked server or a man in the middle would)
    await s.page.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__tamper = ${JSON.stringify(tamper || null)}; (function(){ var f = window.fetch; window.fetch = function (u, o) { return f.apply(this, arguments).then(function (r) { if (!window.__tamper || String(u).indexOf('/api/pool/finds') < 0 || /\\.ots$/.test(String(u))) return r; return r.json().then(function (j) { var x = j.finds[0], t = window.__tamper; Object.keys(t).forEach(function (k) { x[k] = typeof t[k] === 'function' ? t[k](x[k]) : t[k]; }); return new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } }); }); }); }; })();` });
    await s.page.go(s.st.base + '/proof');
    await waitFor(s.page, "!!document.querySelector('[data-verify]') && !document.querySelector('[data-verify]').disabled");
    await s.page.eval("document.querySelector('[data-verify]').click(); 1");
    await waitFor(s.page, "document.querySelector('.proof-checks').dataset.result");
    return s.page.eval("({ result: document.querySelector('.proof-checks').dataset.result, bad: [...document.querySelectorAll('.proof-checks li.bad b')].map(function (b) { return b.textContent; }), text: document.querySelector('.proof-checks').innerText })");
  }
  // a receipt file checked on /proof: the one the finder's card saves, then one with its share changed
  async function checkFile(tamper) {
    await s.page.go(s.st.base + '/proof');
    await waitFor(s.page, "!!document.getElementById('rc-file') && !!document.querySelector('.proof-find')");
    await s.page.eval(`(function(){ var r = JSON.parse(localStorage.getItem('bb-win')).receipt; ${tamper ? 'r = JSON.parse(JSON.stringify(r)); r.body.finder_sats += 100000000;' : ''}
      var dt = new DataTransfer(); dt.items.add(new File([JSON.stringify({ puzzle: r.body.puzzle, signed_receipt: r })], 'receipt.json', { type: 'application/json' }));
      var i = document.getElementById('rc-file'); i.files = dt.files; i.dispatchEvent(new Event('change')); return 1; })()`);
    await waitFor(s.page, "!!document.getElementById('rc-out').dataset.result");
    return s.page.eval("({ result: document.getElementById('rc-out').dataset.result, text: document.getElementById('rc-out').innerText })");
  }
  let rf = await checkFile(false);
  ok(rf.result === 'ok' && /Signature\s+it holds/.test(rf.text) && /On this page\s+the find of puzzle #20/.test(rf.text), 'a saved receipt checked on /proof: the signature holds, the pool key, the find found', rf.text);
  rf = await checkFile(true);
  ok(rf.result === 'bad' && /does not hold/.test(rf.text), 'a receipt with its share changed: the signature does not hold', rf.text);
  let v = await verifyWith(null);
  eq(v.result, 'ok', 'Verify: every check passes', v.text);
  ok(/Key/.test(v.text) && /Commitment/.test(v.text) && /Timestamp/.test(v.text) && /BTC to bc1q/.test(v.text) && /checked with mempool.space/.test(v.text), 'it checked key → address, the commitment, the .ots, the claim with mempool.space', v.text);
  const pub = (await findsOf(s.st)).finds[0];
  ok(/Pool receipt/.test(v.text) && !v.bad.includes('Pool receipt'), 'the pool\'s receipt verifies on /proof', v.text);
  const badReceipt = JSON.parse(JSON.stringify(pub.receipt)); badReceipt.body.finder_sats = 1;
  v = await verifyWith({ receipt: badReceipt });
  ok(v.result === 'bad' && v.bad.includes('Pool receipt'), 'a receipt with a changed share: flagged', v.bad);
  v = await verifyWith({ salt: 'ab'.repeat(32) });
  ok(v.result === 'bad' && v.bad.includes('Commitment'), 'a changed salt: the commitment is flagged', v.bad);
  v = await verifyWith({ key: '0xd2c56' });
  ok(v.result === 'bad' && v.bad.includes('Key'), 'a changed key: the key is flagged', v.bad);
  v = await verifyWith({ payout: POOL });
  ok(v.result === 'bad' && v.bad.includes('Commitment') && v.bad.includes('Transaction'), 'another payout address: the commitment and the transaction are flagged', v.bad);
  // the claim's first output moved by one satoshi to the second: the txid and the signature no longer match
  const tx = T.parse(pub.claim_hex); tx.outs[0].value -= 1; tx.outs[1].value += 1;
  const le8 = (n) => { let h = ''; for (let i = 0; i < 8; i++) { h += (n % 256).toString(16).padStart(2, '0'); n = Math.floor(n / 256); } return h; };
  const forged = pub.claim_hex.replace(le8(tx.outs[0].value + 1), le8(tx.outs[0].value)).replace(le8(tx.outs[1].value - 1), le8(tx.outs[1].value));
  v = await verifyWith({ claim_hex: forged });
  ok(v.result === 'bad' && v.bad.includes('Transaction'), 'a changed claim transaction is flagged', v.bad);
  v = await verifyWith({ piece: { from: '0x80000', to: '0x8ffff' } });
  ok(v.result === 'bad' && v.bad.includes('Piece'), 'another piece: flagged', v.bad);
  v = await verifyWith({ ots: K.b64(K.otsFile('cd'.repeat(32), [Uint8Array.from([0x00, 0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e, 2, 1, 0x41])])) });
  ok(v.result === 'bad' && v.bad.includes('Timestamp'), 'a .ots for something else: flagged', v.bad);
  v = await verifyWith({ status: 'taken' });
  ok(v.result === 'bad' && v.bad.includes('Transaction'), 'coins spent by someone else: flagged', v.bad);
  eq(s.errors.length, 0, 'no script errors', s.errors);
  return s;
});

module.exports = { scenario, scenarios, setup, join, waitFor, rec, keyOnScreen, findsOf, statusOf, relayPosts, KEY_STRINGS };

if (require.main === module) {
  (async () => {
    const b = await launch();
    for (const sc of scenarios) {
      if (only && !sc.name.includes(only)) continue;
      console.log('\n' + sc.name);
      let s;
      try { s = await sc.fn(b); } catch (e) { ok(false, 'ran without throwing', e.stack); }
      if (s && s.st) { if (process.env.KEEP_LOG) console.log(s.st.log.join('')); await s.page.close().catch(() => {}); await s.st.stop(); }
    }
    b.close();
    done();
    process.exit(process.exitCode);
  })();
}
