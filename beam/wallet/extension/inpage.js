// BumbleBeam Wallet: the provider a website sees (EIP-1193), in the page's own world. It is announced to the
// page by EIP-6963 (a dApp lists every wallet and lets the user pick); window.ethereum is set only when no other
// wallet took it (MetaMask, Rabby…). It only passes requests to content.js (window messages, this page only) and
// their answers back: what a site may do is decided in the wallet, never here.
(() => {
  'use strict';
  if (window.bumblebeam) return;
  const ICON = 'data:image/png;base64,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';
  const pending = new Map();
  const listeners = new Map();
  let next = 1, accounts = [];
  const emit = (ev, data) => { for (const f of listeners.get(ev) || []) { try { f(data); } catch (e) { console.error(e); } } };
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    window.postMessage({ target: 'bumblebeam-content', id, method, params }, location.origin);
  });
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin || !e.data || e.data.target !== 'bumblebeam-inpage') return;
    const m = e.data;
    if (m.event) {
      if (m.event === 'accountsChanged') accounts = m.data || [];
      return emit(m.event, m.data);
    }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(Object.assign(new Error(m.error.message || 'request failed'), { code: m.error.code }));
    else {
      if (m.method === 'eth_requestAccounts' || m.method === 'eth_accounts') {
        const a = m.result || [];
        if (String(a) !== String(accounts)) { accounts = a; emit('accountsChanged', a); }
      }
      p.resolve(m.result);
    }
  });
  const provider = {
    isBumbleBeam: true,
    isMetaMask: false,
    chainId: '0x1',
    networkVersion: '1',
    get selectedAddress() { return accounts[0] || null; },
    isConnected: () => true,
    request(args) {
      if (!args || typeof args.method !== 'string') return Promise.reject(Object.assign(new Error('request({ method, params })'), { code: -32600 }));
      return send(args.method, args.params);
    },
    on(ev, f) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(f); return provider; },
    removeListener(ev, f) { const l = listeners.get(ev); if (l) l.delete(f); return provider; },
    off(ev, f) { return provider.removeListener(ev, f); },
    // old ways some sites still use
    enable: () => send('eth_requestAccounts', []),
    send(a, b) {
      if (typeof a === 'string') return send(a, b);
      if (typeof b === 'function') { send(a.method, a.params).then((r) => b(null, { id: a.id, jsonrpc: '2.0', result: r }), (e) => b(e)); return undefined; }
      return send(a.method, a.params);
    },
    sendAsync(a, cb) { send(a.method, a.params).then((r) => cb(null, { id: a.id, jsonrpc: '2.0', result: r }), (e) => cb(e)); },
  };
  Object.defineProperty(window, 'bumblebeam', { value: provider });
  if (!window.ethereum) { try { Object.defineProperty(window, 'ethereum', { value: provider, configurable: true, writable: true }); } catch {} }
  const info = Object.freeze({ uuid: (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2), name: 'BumbleBeam Wallet', icon: ICON, rdns: 'org.bumblebeam.wallet' });
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
  send('eth_accounts', []).then((a) => { emit('connect', { chainId: '0x1' }); return a; }).catch(() => {});
})();
