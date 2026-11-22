// A whole local stack for the browser tests: the mock (node, Slipstream), the real API (api/server.js) in
// its own process and data directory, searching puzzle #20 (POOL_TEST_PUZZLE) with a made-up 7.1 BTC coin, and
// the site (serve.js) in front of it. Nothing reaches the real network from the server; the browser's own calls
// to the outside are the test's to intercept.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { createMock } = require('./mock.js');
const { serve } = require('./serve.js');
const { PZ, ADDRESS, POOL, COIN } = require('./engine.js');

// the vault's key the stack's API seals found keys with (vault.js): the tests open its files with it
const VAULT_KEY = '44'.repeat(32);
// the transport key a find is sealed for (web/engine/seal.js), and its public half: the pages are told it is the
// published one (found-e2e.js), the tests here seal with it and open what the pages send
const TRANSPORT_KEY = '55'.repeat(32);
const TRANSPORT_PUB = (() => { const e = require('crypto').createECDH('prime256v1'); e.setPrivateKey(Buffer.from(TRANSPORT_KEY, 'hex')); return e.getPublicKey('hex'); })();
const SEAL = require('../web/engine/seal.js');
// POST a sealed body as a page does; the answer opened ([status, object])
async function sealedPost(base, p, body) {
  const s = await SEAL.seal(p, body, TRANSPORT_PUB);
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(s.body) });
  const j = await r.json();
  return [r.status, r.ok ? await s.open(j) : j];
}
// open what a page sealed for the server (the tests hold its key)
let priv = null;
async function unseal(p, body) { priv = priv || await SEAL.importPrivate(TRANSPORT_KEY, TRANSPORT_PUB); return (await SEAL.open(priv, p, body)).body; }
function freePort() { return new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); }); }

async function stack(env) {
  const mock = await createMock().listen();
  mock.coins[ADDRESS] = [COIN];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-stack-'));
  // the 160 addresses, no history: the radar sees nothing, the pool searches #20 (POOL_TEST_PUZZLE)
  const addr = []; for (let n = 1; n <= 160; n++) addr.push({ address: PZ.address(n), txs: [], checked: Date.now() });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ puzzleTime: 1, addr, events: [], baseline: true, bench: [] }));
  const apiPort = await freePort();
  // the site first, on a port the system picks as it listens: the API reads the pages' own HTML from it (/_tpl/)
  const web = await serve(0, apiPort), webPort = web.address().port;
  const log = [];
  const api = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'api', 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(apiPort), NODE_API: mock.url + '/node', DATA_DIR: dir, POOL_TEST_PUZZLE: '20', POOL_PAYOUT_ADDRESS: POOL, POOL_SECRET: '22'.repeat(32), POOL_RECEIPT_KEY: '33'.repeat(32), POOL_VAULT_KEY: VAULT_KEY, POOL_TRANSPORT_KEY: TRANSPORT_KEY,
      RELAY_SLIPSTREAM_URL: mock.url + '/slip', FOUND_CHECK_SECONDS: '1', POLL_SECONDS: '3600', EXPLORER_URL: 'http://explorer.invalid', PUZZLE_WEB_URL: 'http://127.0.0.1:' + webPort,
    }, env || {}),
    // an IPC channel: the API exits when this process does, even when it is killed (a test's time limit)
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  api.stdout.on('data', (d) => log.push(String(d))); api.stderr.on('data', (d) => log.push(String(d)));
  // ready once the first read of the addresses is over
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${apiPort}/api/puzzles`); if (r.ok) break; } catch (_) { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    mock, dir, log, apiPort, webPort, base: `http://127.0.0.1:${webPort}`,
    // the API writes its state down when it is stopped (SIGTERM): the data directory goes once it is gone
    async stop() {
      const gone = new Promise((r) => { if (api.exitCode !== null) r(); else api.once('exit', r); });
      api.kill(); web.close(); await mock.close(); await gone;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* the OS cleans tmp */ }
    },
  };
}

module.exports = { stack, freePort, VAULT_KEY, TRANSPORT_KEY, TRANSPORT_PUB, sealedPost, unseal };
