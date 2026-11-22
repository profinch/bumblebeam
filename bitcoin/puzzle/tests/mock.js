// A stand-in for everything outside the pool's server that the found-key flow talks to, on one local port:
//   /node/...    a Bitcoin node's esplora-style REST API (tip, block hashes, a block's coinbase with its miner's tag,
//                a puzzle address's made-up coins, a coin's spend, a transaction's hex and status, fee rates): what
//                NODE_API points at in the tests
//   /slip/...    MARA Slipstream (GET /api/rates, POST /api/transactions)
// Nothing here reaches the real network. A test sets the coins, switches Slipstream off (slipDown), "mines" a
// transaction (mine(txid): its coins become spent in a confirmed block) and says which blocks MARA mined (mara: a
// Set of heights). Every request is logged.
'use strict';
const http = require('http');
const { T } = require('./engine.js');

function createMock(opts) {
  const m = {
    coins: {},            // address -> [{ txid, vout, value }]
    txs: {},              // txid -> hex, every transaction posted to a relay
    spent: {},            // 'txid:vout' -> { txid, height, time }
    confirmed: {},        // txid -> { height, time }
    log: [],              // { t, method, path, body }
    slipRate: 2, utxoDown: false, slipDown: false, fees: { fastestFee: 12, halfHourFee: 8, hourFee: 5, economyFee: 2, minimumFee: 1 },
    tip: 900000, mara: new Set(),
  };
  Object.assign(m, opts || {});
  function json(res, code, v) { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(v)); }
  function text(res, code, v) { res.writeHead(code, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }); res.end(String(v)); }
  function keep(hex) { const tx = T.parse(hex); m.txs[tx.txid] = hex.toLowerCase(); return tx.txid; }
  // mined in the next block (or at height), with depth - 1 blocks on top of it (6 deep unless said)
  m.mine = function (txid, height, depth) {
    const tx = T.parse(m.txs[txid]), h = height || m.tip + 1, time = Math.floor(Date.now() / 1000);
    m.tip = Math.max(m.tip, h + (depth == null ? 6 : depth) - 1);
    m.confirmed[txid] = { height: h, time };
    for (const x of tx.ins) m.spent[x.txid + ':' + x.vout] = { txid, height: h, time };
  };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x'), p = u.pathname;
      m.log.push({ t: Date.now(), method: req.method, path: p, body: body.slice(0, 2000) });
      let x;
      // ---- the node ----
      if (p === '/node/blocks/tip/height') return text(res, 200, m.tip);
      if ((x = p.match(/^\/node\/block-height\/(\d+)$/))) return text(res, 200, Number(x[1]).toString(16).padStart(64, '0'));
      // a block's first transactions: the coinbase, with MARA's tag in the blocks the test says MARA mined
      if ((x = p.match(/^\/node\/block\/([0-9a-f]{64})\/txs\/0$/))) return json(res, 200, [{ txid: 'cb' + x[1].slice(2), vin: [{ is_coinbase: true, scriptsig: Buffer.from('\x03xyz' + (m.mara.has(parseInt(x[1], 16)) ? ' MARA Made in USA ' : '/slush/')).toString('hex') }] }]);
      if ((x = p.match(/^\/node\/address\/([^/]+)\/utxo$/))) return m.utxoDown ? text(res, 503, 'down') : json(res, 200, (m.coins[x[1]] || []).filter((c) => !m.spent[c.txid + ':' + c.vout]).map((c) => ({ txid: c.txid, vout: c.vout, value: c.value, status: { confirmed: true, block_height: 800000 } })));
      if ((x = p.match(/^\/node\/address\/([^/]+)$/))) return json(res, 200, { address: x[1], chain_stats: { tx_count: 0 }, mempool_stats: { tx_count: 0 } });
      if ((x = p.match(/^\/node\/tx\/([0-9a-f]{64})\/outspend\/(\d+)$/))) {
        const s = m.spent[x[1] + ':' + x[2]];
        return json(res, 200, s ? { spent: true, txid: s.txid, vin: 0, status: { confirmed: true, block_height: s.height, block_time: s.time } } : { spent: false });
      }
      if ((x = p.match(/^\/node\/tx\/([0-9a-f]{64})\/hex$/))) return m.txs[x[1]] ? text(res, 200, m.txs[x[1]]) : text(res, 404, 'not found');
      if ((x = p.match(/^\/node\/tx\/([0-9a-f]{64})\/status$/))) { const c = m.confirmed[x[1]]; return json(res, 200, c ? { confirmed: true, block_height: c.height, block_time: c.time } : { confirmed: false }); }
      if (p === '/node/v1/fees/recommended') return json(res, 200, m.fees);
      if (p === '/node/v1/prices') return json(res, 200, { USD: 90000 });
      if (req.method === 'POST' && p.startsWith('/node/')) return text(res, 405, 'the node never takes a transaction in these tests');
      // ---- MARA Slipstream ----
      if (p === '/slip/api/rates') return m.slipDown ? text(res, 503, 'down') : json(res, 200, { submit_fee_rate: m.slipRate, market_rate: 1 });
      if (req.method === 'POST' && p === '/slip/api/transactions') {
        if (m.slipDown) return text(res, 503, 'down');
        try { const id = keep(JSON.parse(body).tx_hex); return json(res, 200, { message: 'Transaction submitted', txid: id }); } catch (e) { return json(res, 400, { error: e.message }); }
      }
      text(res, 404, 'not found');
    });
  });
  m.listen = () => new Promise((ok) => srv.listen(0, '127.0.0.1', () => { m.port = srv.address().port; m.url = 'http://127.0.0.1:' + m.port; ok(m); }));
  m.close = () => new Promise((ok) => srv.close(() => ok()));
  srv.keepAliveTimeout = 1;
  return m;
}

module.exports = { createMock };
