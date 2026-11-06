// BumbleBeam Wallet engine: the message side of one Beam engine frame (engine.html). The host (engines.js)
// sends { id, fn, args } and gets { id, result } | { id, error }; the engine sends events, consent requests,
// snapshot progress and its node connection's state. Only the parent frame of the same extension may talk
// to it. A keepalive keeps the node connection from idling out: Beam's node closes a WebSocket that sends
// nothing for 30 s (measured 2026-11-05: an idle one closes at 30.4 s), and its wallet is quiet between
// blocks, so it was dropped and reconnected about every 35 s all day.
'use strict';

(() => {
  const post = (m) => parent.postMessage(m, location.origin);
  const W = window.__bbWs;
  W.tell = (state, url) => post({ type: 'ws', state, url: String(url), open: W.open, at: Date.now() });

  let consentNext = 1;
  const consentWait = new Map();
  Beam.onConsent((info, amounts) => new Promise((resolve) => {
    const cid = consentNext++;
    consentWait.set(cid, resolve);
    post({ type: 'consent', cid, info, amounts });
  }));
  Beam.on((msg) => { if (msg.method) post({ type: 'event', method: msg.method, result: msg.result }); });

  // Something the wallet has to ask its node, after 15 s without sending anything: the tip block's details.
  // The node's idle clock counts what the wallet sends (blocks it receives do not reset it). Checked
  // 2026-11-05: block_details and a contract view go to the node; wallet_status, tx_list and
  // get_asset_info are answered locally.
  const KEEPALIVE_MS = 15000;
  setInterval(async () => {
    if (!Beam.running() || Date.now() - W.lastSend < KEEPALIVE_MS) return;
    try {
      const s = await Beam.call('wallet_status', {}, 10000);
      if (s && s.current_height) await Beam.call('block_details', { height: s.current_height }, 20000);
    } catch {}
  }, 5000);

  const FNS = {
    load: (store, keepShared) => Beam.load(store, keepShared),
    call: (m, p, ms) => Beam.call(m, p, ms),
    appCall: (m, p, ms) => Beam.appCall(m, p, ms),
    create: (db, phrase, pass, node, url) => Beam.create(db, phrase, pass, node, url, (step, done, total) => post({ type: 'progress', step, done, total })),
    open: (db, pass, node) => Beam.open(db, pass, node),
    stop: () => Beam.stop(),
    readDb: (db) => Beam.readDb(db),
    importDb: (db, bytes, pass) => Beam.importDb(db, bytes, pass),
    copyFromShared: (src, db, pass) => Beam.copyFromShared(src, db, pass),
    exists: (db) => Beam.exists(db),
    generatePhrase: () => Beam.generatePhrase(),
    isValidPhrase: (p) => Beam.isValidPhrase(p),
    isAllowedWord: (w) => Beam.isAllowedWord(w),
    checkPassword: (db, pass) => Beam.checkPassword(db, pass),
    snapshotInfo: () => Beam.snapshotInfo(),
    dropSnapshot: () => Beam.dropSnapshot(),
    running: () => Beam.running(),
    wsState: () => ({ open: W.open, lastSend: W.lastSend, lastRecv: W.lastRecv, lastOpen: W.lastOpen, lastClose: W.lastClose, sent: W.sent, recv: W.recv }),
  };

  window.addEventListener('message', async (e) => {
    if (e.source !== parent || e.origin !== location.origin || !e.data) return;
    const m = e.data;
    if (m.type === 'consentReply') { const r = consentWait.get(m.cid); if (r) { consentWait.delete(m.cid); r(!!m.ok); } return; }
    if (m.id == null || !Object.hasOwn(FNS, m.fn)) return;
    try {
      const result = await FNS[m.fn](...(m.args || []));
      post({ id: m.id, result });
    } catch (err) {
      post({ id: m.id, error: err && err.message ? err.message : typeof err === 'number' ? `engine exception ${err}` : String(err) });
    }
  });
  // a crash of the engine (an abort) is told to the host, which drops this frame and starts a new one
  window.addEventListener('error', (e) => post({ type: 'crash', message: String(e.message || e.error || 'error') }));
  window.addEventListener('unhandledrejection', (e) => { const r = e.reason; if (r && /Aborted|RuntimeError/.test(String(r.message || r))) post({ type: 'crash', message: String(r.message || r) }); });
  post({ type: 'ready' });
})();
