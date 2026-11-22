// Headless Chromium driven over the DevTools protocol, for the browser tests: no framework, Node 22's WebSocket.
// CHROME=<path> picks the binary (else Playwright's cached Chromium). WebGPU is not needed: the tests put a
// stand-in engine in place of the GPU one.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function chromePath() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = path.join(os.homedir(), '.cache', 'ms-playwright');
  for (const d of fs.existsSync(base) ? fs.readdirSync(base).filter((x) => x.startsWith('chromium-')).sort().reverse() : []) {
    for (const sub of ['chrome-linux64', 'chrome-linux']) { const p = path.join(base, d, sub, 'chrome'); if (fs.existsSync(p)) return p; }
  }
  throw new Error('no Chromium: set CHROME');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const port = 9400 + Math.floor(Math.random() * 500);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-chrome-'));
  const proc = spawn(chromePath(), ['--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${dir}`, `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore' });
  let ver;
  for (let i = 0; i < 100 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch (_) { await sleep(100); } }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let id = 0;
  const pend = new Map(), handlers = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.no(new Error(d.error.message)) : p.ok(d.result); return; }
    if (d.method) handlers.forEach((h) => h(d.method, d.params, d.sessionId));
  };
  function send(method, params, sessionId) {
    return new Promise((ok, no) => { const i = ++id; pend.set(i, { ok, no }); ws.send(JSON.stringify(Object.assign({ id: i, method, params: params || {} }, sessionId ? { sessionId } : {}))); });
  }
  // a fresh page in its own browser context (its own storage): { send, on, eval, close }
  async function page(width) {
    const { browserContextId } = await send('Target.createBrowserContext');
    const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const s = (m, p) => send(m, p, sessionId);
    const listeners = [];
    handlers.push((m, p, sid) => { if (sid === sessionId) listeners.forEach((f) => f(m, p)); });
    await s('Page.enable'); await s('Runtime.enable');
    await s('Emulation.setDeviceMetricsOverride', { width: width || 1100, height: 900, deviceScaleFactor: 1, mobile: (width || 1100) < 500 });
    return {
      send: s,
      on: (f) => listeners.push(f),
      async eval(expr) {
        const r = await s('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
        return r.result.value;
      },
      async go(url) { await s('Page.navigate', { url }); },
      close: () => send('Target.disposeBrowserContext', { browserContextId }),
    };
  }
  return { send, page, close() { try { ws.close(); } catch (_) { /* gone */ } proc.kill(); setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 500); } };
}

module.exports = { launch, sleep };
