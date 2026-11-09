// BumbleBeam Wallet: between a website's page (inpage.js, window messages of this page only) and the wallet (a
// port named 'dapp'). The wallet takes the site from the port's sender, as Chrome gives it; nothing a page says
// about itself counts. Requests and answers pass through unchanged.
(() => {
  'use strict';
  let port = null;
  const waiting = new Map();                     // id -> method, until its answer comes
  function connect() {
    // the wallet's host page may not be up yet (the browser just started): ask the service worker for it first
    return chrome.runtime.sendMessage({ op: 'ensureHost' }).catch(() => {}).then(() => {
      port = chrome.runtime.connect({ name: 'dapp' });
      port.onMessage.addListener((m) => {
        const method = m.id != null ? waiting.get(m.id) : undefined;
        if (m.id != null) waiting.delete(m.id);
        window.postMessage({ target: 'bumblebeam-inpage', ...m, method }, location.origin);
      });
      port.onDisconnect.addListener(() => {
        port = null;
        // the wallet went away (an update, a restart): what waited for it fails, the next request connects again
        for (const id of [...waiting.keys()]) window.postMessage({ target: 'bumblebeam-inpage', id, error: { code: 4900, message: 'the wallet is not available' } }, location.origin);
        waiting.clear();
      });
    });
  }
  let ready = null;
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin || !e.data || e.data.target !== 'bumblebeam-content') return;
    const { id, method, params } = e.data;
    if (id == null || typeof method !== 'string') return;
    if (!port) ready = ready || connect().finally(() => { ready = null; });
    Promise.resolve(ready).then(() => {
      if (!port) throw new Error('no wallet');
      waiting.set(id, method);
      port.postMessage({ id, method, params });
    }).catch(() => window.postMessage({ target: 'bumblebeam-inpage', id, error: { code: 4900, message: 'the wallet is not available' } }, location.origin));
  });
})();
