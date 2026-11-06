// BumbleBeam Wallet host: the Beam engines. Each Beam wallet runs in an engine of its own, a hidden frame
// (engine.html) with its own copy of Beam's wasm client and its own IndexedDB store (see beam.js for why).
// The host (offscreen.js) holds them here:
//   Engine          one frame: rpc to it, its events, consent requests, snapshot progress, node connection
//   Engines.util()  an engine without a wallet: seed phrase words and checks, the snapshot cache, migration
// An engine is never restarted in place: restart = drop the frame (after the wallet has stopped and written
// its database) and make a new one. A crashed engine (an abort) tells the host, which does the same.
'use strict';

const Engines = (() => {
  const store = (walletId) => `/bw_${walletId}`;
  const dbOf = (walletId) => `${store(walletId)}/wallet.db`;

  class Engine {
    constructor(name) {
      this.name = name;                         // the wallet id, or 'util'
      this.frame = null;
      this.next = 1;
      this.wait = new Map();
      this.on = { event: () => {}, consent: async () => false, progress: () => {}, ws: () => {}, crash: () => {} };
      this.ws = { open: 0, lastOpen: 0, lastClose: 0 };
      this.dead = false;
      this.listener = (e) => this.message(e);
    }

    boot(timeoutMs = 60000) {
      return new Promise((resolve, reject) => {
        // a frame that does not come up in time goes (not left holding a wasm module)
        const t = setTimeout(() => { this.drop(); reject(new Error('the Beam engine did not start')); }, timeoutMs);
        this.ready = () => { clearTimeout(t); resolve(this); };
        window.addEventListener('message', this.listener);
        this.frame = document.createElement('iframe');
        this.frame.src = 'engine.html';
        this.frame.hidden = true;
        document.body.appendChild(this.frame);
      });
    }

    message(e) {
      if (!this.frame || e.source !== this.frame.contentWindow || e.origin !== location.origin || !e.data) return;
      const m = e.data;
      if (m.type === 'ready') { if (this.ready) this.ready(); return; }
      if (m.type === 'event') return this.on.event(m);
      if (m.type === 'progress') return this.on.progress(m.step, m.done, m.total);
      if (m.type === 'ws') {
        this.ws.open = m.open;
        if (m.state === 'open') this.ws.lastOpen = m.at; else this.ws.lastClose = m.at;
        return this.on.ws(m);
      }
      if (m.type === 'consent') {
        Promise.resolve(this.on.consent(m.info, m.amounts)).catch(() => false)
          .then((ok) => this.post({ type: 'consentReply', cid: m.cid, ok: !!ok }));
        return;
      }
      if (m.type === 'crash') {
        // a dead engine answers nothing: everything waiting on it fails now, not at its timeout
        this.dead = true;
        for (const w of this.wait.values()) w.reject(new Error(`the Beam engine stopped: ${m.message}`));
        this.wait.clear();
        return this.on.crash(m.message);
      }
      const w = m.id != null && this.wait.get(m.id);
      if (!w) return;
      this.wait.delete(m.id);
      if (m.error) w.reject(new Error(m.error)); else w.resolve(m.result);
    }

    post(m) { if (this.frame && this.frame.contentWindow) this.frame.contentWindow.postMessage(m, location.origin); }

    // fn(...args) in the engine; an answer or, after ms, a timeout (an engine that died answers nothing)
    rpc(fn, args = [], ms = 120000) {
      if (this.dead || !this.frame) return Promise.reject(new Error('the Beam engine is not running'));
      const id = this.next++;
      return new Promise((resolve, reject) => {
        this.wait.set(id, { resolve, reject });
        setTimeout(() => { if (this.wait.delete(id)) reject(new Error(`the Beam engine did not answer ${fn} in ${ms / 1000} s`)); }, ms);
        this.post({ id, fn, args });
      });
    }
    call(method, params, ms = 60000) { return this.rpc('call', [method, params, ms], ms + 5000); }
    appCall(method, params, ms = 60000) { return this.rpc('appCall', [method, params, ms], ms + 5000); }

    // the wallet stops and writes its database, then the frame goes (whatever the stop answers, or not)
    async close() {
      if (!this.frame) return;
      if (!this.dead) await this.rpc('stop', [], 25000).catch(() => {});
      this.drop();
    }
    drop() {
      window.removeEventListener('message', this.listener);
      for (const w of this.wait.values()) w.reject(new Error('the Beam engine closed'));
      this.wait.clear();
      if (this.frame) this.frame.remove();
      this.frame = null; this.dead = true;
    }
  }

  // one engine without a wallet, made when first needed. withShared: the old shared folder mounted (read)
  let util = null;
  async function utilEngine() {
    if (util && !util.dead) return util;
    const e = new Engine('util');
    await e.boot();
    await e.rpc('load', [null, true]);
    util = e;
    return e;
  }

  // a fresh engine for a wallet: its own store loaded (the old shared folder too only for a migration)
  async function fresh(walletId, keepShared = false) {
    const e = new Engine(walletId);
    await e.boot();
    try { await e.rpc('load', [store(walletId), keepShared]); }
    catch (err) { e.drop(); throw err; }
    return e;
  }

  // a wallet's IndexedDB store, removed with the wallet (IDBFS names the database after the mount point)
  function dropStore(walletId) {
    return new Promise((resolve) => {
      const r = indexedDB.deleteDatabase(store(walletId));
      r.onsuccess = r.onerror = r.onblocked = () => resolve();
    });
  }

  return { Engine, store, dbOf, util: utilEngine, fresh, dropStore };
})();
