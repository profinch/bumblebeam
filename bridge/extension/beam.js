// The Beam wallet: a thin promise layer over Beam's wasm-client (vendor/, built by BeamMW's CI from
// master after HF6). Calls go through the regular Beam wallet API (sendRequest); the same calls the
// official web wallet makes (BeamMW/web-wallet src/app/core/WasmWallet.ts).
'use strict';

const Beam = (() => {
  const DB = '/beam_wallet/wallet.db';        // IDBFS mount, persisted by wallet_db on every commit
  const RECOVERY = '/recovery.bin';            // MEMFS, only while a seed restore runs
  let M = null, WC = null, client = null;
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();

  async function load() {
    if (M) return;
    M = await BeamModule();
    WC = M.WasmWalletClient;
    await new Promise((resolve, reject) => WC.MountFS((err) => (err ? reject(err) : resolve())));
  }

  function onMessage(json) {
    let msg;
    try { msg = JSON.parse(json); } catch { return; }
    const p = msg.id != null && pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    // notifications carry their name in id: { id: 'ev_system_state', result }
    if (!msg.method && typeof msg.id === 'string') msg.method = msg.id;
    for (const fn of listeners) fn(msg);
  }

  function call(method, params) {
    if (!client) return Promise.reject(new Error('wallet is not running'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      client.sendRequest(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  // words are space-separated in the UI and for GeneratePhrase/IsValidPhrase, ';' for CreateWallet
  const words = (phrase) => phrase.trim().toLowerCase().split(/[\s;,]+/).filter(Boolean);

  function start(pass, node) {
    client = new WC(DB, pass, node);
    client.subscribe(onMessage);
    client.startWallet();
  }

  function stop() {
    if (!client) return Promise.resolve();
    return new Promise((resolve) => client.stopWallet(() => { client = null; resolve(); }));
  }

  const checkPassword = (pass) => new Promise((resolve) => WC.CheckPassword(DB, pass, (ok) => resolve(!!ok)));

  // Seed restore through the published recovery snapshot (what the mobile "Automatic restore" and the
  // web wallet use), so no node with the wallet's owner key is needed. ~320 MB, read straight into
  // one buffer of the announced length.
  async function downloadRecovery(url, onProgress) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`recovery snapshot: HTTP ${res.status}`);
    const total = +res.headers.get('Content-Length') || 0;
    const reader = res.body.getReader();
    let buf = new Uint8Array(total || 64 << 20), got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (got + value.length > buf.length) { const b = new Uint8Array(Math.max(buf.length * 2, got + value.length)); b.set(buf); buf = b; }
      buf.set(value, got);
      got += value.length;
      onProgress(got, total);
    }
    return buf.subarray(0, got);
  }

  return {
    load,
    call,
    on: (fn) => listeners.add(fn),
    running: () => !!client && client.isRunning(),
    hasWallet: () => WC.IsInitialized(DB),
    generatePhrase: () => WC.GeneratePhrase(),
    isValidPhrase: (phrase) => WC.IsValidPhrase(words(phrase).join(' ')),
    isAllowedWord: (w) => WC.IsAllowedWord(w),
    checkPassword,

    // A new wallet and a seed restore are the same: create the database from the phrase, then let
    // the wallet import the snapshot as it starts. The snapshot also carries the headers, so a new
    // wallet does not sync ~4 M of them from genesis (an hour in a browser).
    async create(phrase, pass, node, url, onProgress) {
      const data = await downloadRecovery(url, (d, t) => onProgress('download', d, t));
      if (WC.IsInitialized(DB)) WC.DeleteWallet(DB);
      WC.CreateWallet(words(phrase).join(';'), DB, pass);
      M.FS.writeFile(RECOVERY, data);
      client = new WC(DB, pass, node);
      client.subscribe(onMessage);
      await new Promise((resolve, reject) => {
        client.importRecoveryFromFile(RECOVERY, (err, done, total) => {
          if (err) return reject(err);
          onProgress('import', done, total);
          if (total && done === total) resolve();
        });
        client.startWallet();
      });
      try { M.FS.unlink(RECOVERY); } catch {}
    },

    async open(pass, node) {
      if (!(await checkPassword(pass))) throw new Error('wrong password');
      start(pass, node);
    },

    stop,

    // Backup: the wallet.db file itself (encrypted with the wallet password by Beam), read while the
    // wallet is stopped so the file is consistent.
    async exportDb(pass, node) {
      await stop();
      const bytes = M.FS.readFile(DB);
      start(pass, node);
      return bytes;
    },

    async importDb(bytes) {
      await stop();
      if (WC.IsInitialized(DB)) WC.DeleteWallet(DB);
      M.FS.writeFile(DB, bytes);
      await new Promise((resolve, reject) => M.FS.syncfs(false, (err) => (err ? reject(err) : resolve())));
    },

    async remove() {
      await stop();
      if (WC.IsInitialized(DB)) WC.DeleteWallet(DB);
    },
  };
})();
