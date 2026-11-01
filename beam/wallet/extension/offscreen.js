// BumbleBeam Wallet: the wallet host. A hidden offscreen document that runs Beam's wasm wallet for as
// long as the browser runs, so it keeps syncing and receiving with the popup closed (the popup is only
// a view: Chrome closes it on the first click outside). The popup talks to it over a runtime port:
//   popup -> { id, op, args }            host -> { id, result } | { id, error }
//   host -> { type: 'event' | 'progress' | 'consent', ... }   popup -> { type: 'consent', id, ok }
// Only the operations in `api` exist; contract transactions still need the popup's consent.
'use strict';

(() => {
  // our pool node's WebSocket door (deploy/docker wss.conf). The official web wallet's
  // web-wallet.beam.mw:8200 is still on the pre-HF6 chain ("incompatible with HF 6", stuck at 3928666).
  const DEFAULT_NODE = 'wss.bumblebeam.org:443';
  const RECOVERY_URL = 'https://mobile-restore.beam.mw/mainnet/mainnet_recovery.bin';
  // wallet API methods the popup may call directly; contracts go through Bridge (the app API)
  const WALLET_METHODS = new Set(['wallet_status', 'tx_list', 'create_address', 'tx_send']);

  let node = DEFAULT_NODE, pass = null, phrase = null, progress = null;
  const ports = new Set();
  const broadcast = (msg) => { for (const p of ports) { try { p.postMessage(msg); } catch {} } };

  // ---------- consent: asked of the open popup, refused if there is none ----------
  let consentNext = 1, ctx = null;
  const consentWait = new Map();
  Beam.onConsent((info, amounts) => new Promise((resolve) => {
    if (!ports.size) return resolve(false);
    const id = consentNext++;
    consentWait.set(id, resolve);
    broadcast({ type: 'consent', id, info, amounts, ctx });
    setTimeout(() => { if (consentWait.delete(id)) resolve(false); }, 5 * 60 * 1000);
  }));
  // what the popup says the next contract transaction is; it goes into the consent box
  const withCtx = async (c, fn) => { ctx = c; try { return await fn(); } finally { ctx = null; } };

  Beam.on((msg) => { if (msg.method) broadcast({ type: 'event', method: msg.method, result: msg.result }); });

  const started = async (p) => {
    pass = p;
    await Beam.call('ev_subunsub', { ev_sync_progress: true, ev_system_state: true, ev_txs_changed: true, ev_utxos_changed: true }).catch(() => {});
    broadcast({ type: 'event', method: 'bb_started' });   // a popup opened while the snapshot imported moves on
  };
  const onProgress = (step, done, total) => { progress = { step, done, total }; broadcast({ type: 'progress', ...progress }); };

  // chrome.storage through the service worker (an offscreen document has chrome.runtime only)
  const kv = {
    get: async (key) => (await chrome.runtime.sendMessage({ op: 'get', key }) || {}).result,
    set: (key, value) => chrome.runtime.sendMessage({ op: 'set', key, value }),
  };
  const toB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
  const fromB64 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));

  const api = {
    state: () => ({ hasWallet: Beam.hasWallet(), running: Beam.running(), node, phrase: !!phrase, progress }),

    // a new seed lives here until the wallet is created, so closing the popup to write it down loses nothing
    newPhrase: () => (phrase = Beam.generatePhrase()),
    phrase: () => phrase,
    dropPhrase: () => { phrase = null; },
    isAllowedWord: (w) => Beam.isAllowedWord(w),
    isValidPhrase: (p) => Beam.isValidPhrase(p),

    async create(words, p) {
      progress = { step: 'download', done: 0, total: 0 };
      try { await Beam.create(words || phrase, p, node, RECOVERY_URL, onProgress); }
      finally { progress = null; }
      phrase = null;
      await started(p);
    },
    async open(p) { await Beam.open(p, node); await started(p); },
    async lock() { await Beam.stop(); pass = null; },
    async remove() { await Beam.remove(); pass = null; },
    async exportDb() { return toB64(await Beam.exportDb(pass, node)); },
    async importDb(b64, p) { await Beam.importDb(fromB64(b64)); await Beam.open(p, node); await started(p); },
    async setNode(n) {
      node = n || DEFAULT_NODE;
      await kv.set('node', node);
      if (Beam.running()) { await Beam.stop(); await Beam.open(pass, node); await started(pass); }
      return node;
    },

    wallet(method, params) {
      if (!WALLET_METHODS.has(method)) throw new Error(`not allowed: ${method}`);
      return Beam.call(method, params);
    },

    relayerFee: () => Bridge.relayerFee(),
    outgoing: (rcv) => Bridge.outgoing(rcv),
    beamKey: () => Bridge.beamKey(),
    incoming: () => Bridge.incoming(),
    sendToEth: (c, a, rcv, f) => withCtx(c, () => Bridge.sendToEth(a, rcv, f)),
    receive: (c, msgId) => withCtx(c, () => Bridge.receive(msgId)),
  };

  // every operation waits for the engine; a failed start is the answer to all of them
  const ready = (async () => {
    if (!self.crossOriginIsolated) throw new Error('the wallet host is not cross-origin isolated: the wasm wallet needs SharedArrayBuffer');
    node = (await kv.get('node')) || DEFAULT_NODE;
    await Beam.load();
  })();
  ready.catch(() => {});                       // reported to each operation instead

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'wallet-ui' || port.sender.id !== chrome.runtime.id) return port.disconnect();
    ports.add(port);
    port.onDisconnect.addListener(() => ports.delete(port));
    port.onMessage.addListener(async (m) => {
      if (m.type === 'consent') { const r = consentWait.get(m.id); if (r) { consentWait.delete(m.id); r(!!m.ok); } return; }
      if (!Object.hasOwn(api, m.op)) return port.postMessage({ id: m.id, error: `no such operation: ${m.op}` });
      try { await ready; port.postMessage({ id: m.id, result: await api[m.op](...(m.args || [])) }); }
      catch (e) { port.postMessage({ id: m.id, error: e && e.message ? e.message : String(e) }); }
    });
  });


})();
