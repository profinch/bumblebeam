// The browser's view of the outside world in the tests: every https:// request the page makes is caught over the
// DevTools protocol (Fetch) and answered here, so nothing reaches a real relay, calendar or explorer. Stand-ins for
// the OpenTimestamps calendars, MARA Slipstream and the two explorers, each switchable per test (Rebar Shield is not
// used any more: a request to it is logged, as kind 'rebar', and fails):
//   cfg.cal[host] / cfg.calAll   'ok' | 'fail' (HTTP 500) | 'down' (no connection)
//   cfg.slip                     'ok' | 'fail' (Slipstream refuses) | 'down' | 'hold' (no answer until released)
//   cfg.mempool, cfg.blockstream 'ok' | 'down' (the two explorers, alike);  cfg.mined: txids they report as confirmed;
//                                cfg.lowball: the explorer that gives the coin as 1 BTC smaller than it is
//   cfg.found                    'ok' | 'down' (POST /api/pool/found cannot connect) | 'hold' | 'refuse' (a 422)
// Every request is logged with its time; ev.keyIn lists every request whose URL or body carries the key in the clear,
// ev.sealedKey every request to our server whose sealed body (web/engine/seal.js, opened here with the tests'
// transport key) carries it.
'use strict';
const { S, T, ADDRESS, COIN, FUND_HEX } = require('./engine.js');
const { unseal } = require('./stack.js');

const PENDING = [0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e];
function stampFor(host) {
  const uri = Array.from(new TextEncoder().encode('https://' + host)), nonce = Array.from({ length: 8 }, () => Math.floor(Math.random() * 256));
  return Uint8Array.from([0xf0, 8].concat(nonce, [0x08, 0x00], PENDING, [uri.length + 1, uri.length], uri));
}

function outside(page, keyStrings) {
  const cfg = { cal: {}, calAll: 'ok', slip: 'ok', mempool: 'ok', blockstream: 'ok', lowball: null, mined: new Set(), txs: {}, found: 'ok', slipRate: 2 };
  const ev = { log: [], keyIn: [], sealedKey: [], held: [], sent: { slipstream: [] }, urls: [] };
  const cors = [{ name: 'access-control-allow-origin', value: '*' }, { name: 'access-control-allow-headers', value: 'content-type' }, { name: 'access-control-allow-methods', value: 'GET, POST, OPTIONS' }];
  function reply(id, code, body, type) {
    const b = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body || []);
    return page.send('Fetch.fulfillRequest', { requestId: id, responseCode: code, responseHeaders: cors.concat([{ name: 'content-type', value: type || 'application/json' }]), body: b.toString('base64') }).catch(() => {});
  }
  const json = (id, code, v) => reply(id, code, JSON.stringify(v));
  const fail = (id) => page.send('Fetch.failRequest', { requestId: id, errorReason: 'ConnectionRefused' }).catch(() => {});
  function bodyOf(r) {
    if (r.postDataEntries) return Buffer.concat(r.postDataEntries.map((e) => Buffer.from(e.bytes || '', 'base64')));
    return Buffer.from(r.postData || '');
  }
  page.on(async (method, p) => {
    if (method === 'Network.requestWillBeSent') {
      const r = p.request, text = r.url + ' ' + (r.postData || '');
      if (keyStrings.some((k) => text.includes(k))) ev.keyIn.push({ t: Date.now(), url: r.url });
      ev.urls.push(r.url);
      return;
    }
    if (method !== 'Fetch.requestPaused') return;
    const r = p.request, u = new URL(r.url), id = p.requestId, body = bodyOf(r), t = Date.now();
    const host = u.host, m = r.method;
    let kind = 'other';
    if (/opentimestamps\.org|eternitywall\.com|catallaxy\.com/.test(host)) kind = 'calendar';
    else if (host === 'slipstream.mara.com') kind = 'slipstream';
    else if (host === 'shield.rebarlabs.io') kind = 'rebar';
    else if (host === 'mempool.space' || host === 'blockstream.info') kind = 'mempool';
    else if (u.pathname === '/api/pool/found' || u.pathname === '/api/pool/found/status' || u.pathname === '/api/pool/solo') kind = 'found';
    const entry = { t, kind, method: m, path: u.pathname, host };
    ev.log.push(entry);
    if (m === 'OPTIONS') return reply(id, 204, '');
    if (kind === 'calendar') {
      const mode = cfg.cal[host] || cfg.calAll;
      if (mode === 'down') return fail(id);
      if (mode === 'fail') return reply(id, 500, 'calendar error', 'text/plain');
      entry.digest = body.toString('hex');
      return reply(id, 200, stampFor(host), 'application/vnd.opentimestamps.v1');
    }
    if (kind === 'rebar') return fail(id);
    if (kind === 'slipstream') {
      if (u.pathname === '/api/rates') return cfg.slip === 'down' ? fail(id) : json(id, 200, { submit_fee_rate: cfg.slipRate, market_rate: 1 });
      const mode = cfg.slip, hex = JSON.parse(body.toString()).tx_hex;
      entry.hex = hex;
      const answer = () => {
        entry.answered = Date.now();
        if (mode === 'down') return fail(id);
        if (mode === 'fail') return json(id, 400, { error: 'transaction rejected: test' });
        ev.sent.slipstream.push(hex); cfg.txs[T.parse(hex).txid] = hex;
        return json(id, 200, { message: 'Transaction submitted', txid: T.parse(hex).txid });
      };
      if (mode === 'hold') { ev.held.push({ kind, answer, id }); return; }
      return answer();
    }
    if (kind === 'mempool') {
      const name = host === 'mempool.space' ? 'mempool' : 'blockstream';
      if (cfg[name] === 'down') return fail(id);
      let x;
      if ((x = u.pathname.match(/^\/api\/address\/([^/]+)\/utxo$/))) {
        const spent = [...cfg.mined].length > 0;
        return json(id, 200, x[1] === ADDRESS && !spent ? [{ txid: COIN.txid, vout: COIN.vout, value: COIN.value - (cfg.lowball === name ? 1e8 : 0), status: { confirmed: true, block_height: 800000 } }] : []);
      }
      if (u.pathname === '/api/tx/' + COIN.txid + '/hex') return reply(id, 200, FUND_HEX, 'text/plain');
      if (u.pathname === '/api/fee-estimates') return json(id, 200, { 1: 12, 2: 10, 6: 5 });
      if ((x = u.pathname.match(/^\/api\/tx\/([0-9a-f]{64})\/status$/))) return cfg.mined.has(x[1]) ? json(id, 200, { confirmed: true, block_height: 900001 }) : reply(id, 404, 'Transaction not found', 'text/plain');
      if ((x = u.pathname.match(/^\/api\/tx\/([0-9a-f]{64})$/)) && cfg.mined.has(x[1]) && cfg.txs[x[1]]) {
        const tx = T.parse(cfg.txs[x[1]]);
        return json(id, 200, { txid: x[1], vin: tx.ins.map((i) => ({ txid: i.txid, vout: i.vout, prevout: { value: i.txid === COIN.txid ? COIN.value : 0 } })), status: { confirmed: true, block_height: 900001 } });
      }
      if (u.pathname === '/api/v1/fees/recommended') return json(id, 200, { fastestFee: 12, halfHourFee: 8, hourFee: 5 });
      if (u.pathname === '/api/blocks/tip/height') return reply(id, 200, String(cfg.tip || 900006), 'text/plain');
      return reply(id, 404, 'not found', 'text/plain');
    }
    if (kind === 'found') {
      // what the page sent, opened as the server would
      let opened = null;
      try { opened = JSON.stringify(await unseal(u.pathname, JSON.parse(body.toString()))); } catch (_) { /* not sealed */ }
      entry.sealed = !!opened;
      entry.hasKey = keyStrings.some((k) => (opened || '').includes(k));
      if (entry.hasKey) ev.sealedKey.push({ t, url: r.url });
      if (cfg.found === 'down') return fail(id);
      const claim = u.pathname === '/api/pool/found'; // not the status asks: those only go down with the server
      if (cfg.found === 'refuse' && m === 'POST' && claim) return json(id, 422, { error: 'refused by the test' });
      if (cfg.found === 'hold' && claim) { ev.held.push({ kind, id, answer: () => page.send('Fetch.continueRequest', { requestId: id }).catch(() => {}) }); return; }
      return page.send('Fetch.continueRequest', { requestId: id }).catch(() => {});
    }
    // anything else on the internet: as if offline
    return page.send('Fetch.failRequest', { requestId: id, errorReason: 'InternetDisconnected' }).catch(() => {});
  });
  async function start() {
    await page.send('Network.enable');
    await page.send('Fetch.enable', { patterns: [{ urlPattern: 'https://*', requestStage: 'Request' }, { urlPattern: '*/api/pool/found*', requestStage: 'Request' }, { urlPattern: '*/api/pool/solo', requestStage: 'Request' }] });
  }
  return { cfg, ev, start, release: (kind) => { const h = ev.held.filter((x) => !kind || x.kind === kind); ev.held = ev.held.filter((x) => h.indexOf(x) < 0); h.forEach((x) => x.answer()); } };
}

module.exports = { outside, stampFor };
