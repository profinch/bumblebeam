// The Beam wallet engine: a thin promise layer over Beam's wasm-client (vendor/, built by BeamMW's CI from
// master after HF6), for ONE wallet. It runs inside engine.html, a frame of the host of its own (engines.js
// in the host makes one per Beam wallet), never in the host itself:
//  - Beam's client cannot be restarted in a page: a second WasmWalletClient throws while the first lives,
//    and freeing the first (embind delete) blocks on its threads, which a browser's main thread may not
//    do: the whole engine aborts (2026-11-05, after a transfer between two wallets). So an engine is
//    started once, and "restart" means the host drops the frame and makes a new one.
//  - Every engine has its own IndexedDB store (/bw_<wallet id>). Beam persists by syncing a whole mounted
//    folder (FS.syncfs), which overwrites files whose time differs and deletes files it does not have:
//    two engines on one shared folder would overwrite each other's databases. The shared /beam_wallet of
//    version 0.1 and early 0.2 is only read (by the migration), then unmounted.
'use strict';

const Beam = (() => {
  const SHARED = '/beam_wallet';              // the old shared folder: read only, for migrating out of it
  const RECOVERY = '/recovery.bin';           // MEMFS, only while a snapshot imports
  let M = null, WC = null, client = null, cur = null;
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();

  const syncfs = (populate) => new Promise((resolve, reject) => M.FS.syncfs(!!populate, (err) => (err ? reject(err) : resolve())));
  const existsPath = (p) => { try { M.FS.stat(p); return true; } catch { return false; } };

  // store: this engine's own folder ('/bw_<id>'), mounted on its own IndexedDB database. keepShared: the
  // migration also reads the old shared folder; any other engine unmounts it, so its syncs never touch it.
  async function load(store, keepShared = false) {
    if (M) return;
    M = await BeamModule();
    WC = M.WasmWalletClient;
    await new Promise((resolve, reject) => WC.MountFS((err) => (err ? reject(err) : resolve())));   // sets Beam's "mounted" flag
    if (store) {
      if (!existsPath(store)) M.FS.mkdir(store);
      M.FS.mount(M.FS.filesystems.IDBFS, {}, store);
      if (!keepShared) M.FS.unmount(SHARED);
      await syncfs(true);
    }
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

  // every call has an answer: the wallet's, or after `ms` a timeout (nothing waits forever on a lost reply)
  function settleLater(map, id, ms, method) {
    setTimeout(() => { const p = map.get(id); if (p) { map.delete(id); p.reject(new Error(`Beam ${method}: no answer in ${ms / 1000} s`)); } }, ms);
  }
  function call(method, params, ms = 60000) {
    if (!client) return Promise.reject(new Error('the Beam wallet is not running'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      settleLater(pending, id, ms, method);
      client.sendRequest(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  // words are space-separated in the UI and for GeneratePhrase/IsValidPhrase, ';' for CreateWallet
  const words = (phrase) => String(phrase).trim().toLowerCase().split(/[\s;,]+/).filter(Boolean);

  // Contracts run only through an app API (the wallet API answers invoke_contract with "Feature is
  // not supported"), as for the official DApps. A transaction an app asks for comes back to the
  // consent handler with the wallet's own view of it (what it spends, the fee); nothing is signed
  // until that handler approves.
  let app = null, appNext = 1, consent = null;
  const appPending = new Map();
  const APP_NAME = 'BumbleBeam Wallet';

  function onAppMessage(json) {
    let msg;
    try { msg = JSON.parse(json); } catch { return; }
    const p = msg.id != null && appPending.get(msg.id);
    if (!p) return;
    appPending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  }

  function appApi() {
    if (app) return app;
    app = new Promise((resolve, reject) => {
      // the host's origin names the app (the frame has the same one): one app id for every engine
      const appid = WC.GenerateAppID(APP_NAME, location.origin);
      client.createAppAPI('current', '', appid, APP_NAME, (err, api) => {
        if (err) { app = null; return reject(new Error(String(err))); }
        api.setHandler(onAppMessage);
        resolve(api);
      });
    });
    return app;
  }

  async function appCall(method, params, ms = 60000) {
    if (!client) throw new Error('the Beam wallet is not running');
    const api = await appApi();
    if (!client) throw new Error('the Beam wallet stopped');
    const id = appNext++;
    return new Promise((resolve, reject) => {
      appPending.set(id, { resolve, reject });
      settleLater(appPending, id, ms, method);
      api.callWalletApi(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  // beforeStart: what has to be set on the client before startWallet (the snapshot import)
  function start(db, pass, node, beforeStart) {
    if (client || cur) throw new Error('this engine has run a wallet already: a new engine is needed');
    client = new WC(db, pass, node);
    cur = { db, node };
    client.subscribe(onMessage);
    client.setApproveContractInfoHandler(async (req, info, amounts, cb) => {
      let ok = false;
      try { ok = !!consent && (await consent(JSON.parse(info || '{}'), JSON.parse(amounts || '[]'))); } catch {}
      if (ok) cb.contractInfoApproved(req); else cb.contractInfoRejected(req);
    });
    // the bridge never sends plain transfers through the app API: refuse any that come
    client.setApproveSendHandler((req, info, cb) => cb.sendRejected(req));
    if (beforeStart) beforeStart();
    client.startWallet();
    app = null;
  }

  // The wallet stops and writes its database; the client object is left as it is (never deleted: see the
  // top). The engine is done after this: the host drops its frame.
  function stop(ms = 20000) {
    if (!client) return Promise.resolve();
    for (const p of [...pending.values(), ...appPending.values()]) p.reject(new Error('the Beam wallet stopped'));
    pending.clear(); appPending.clear();
    const c = client;
    client = null; app = null;
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);                       // a stop that never reports is not waited for forever
      try { c.stopWallet(() => { clearTimeout(t); resolve(); }); } catch { clearTimeout(t); resolve(); }
    }).then(() => syncfs(false).catch(() => {}));
  }

  const checkPassword = (db, pass) => new Promise((resolve) => WC.CheckPassword(db, pass, (ok) => resolve(!!ok)));
  // bytes of a database: do they open with pass? (a scratch file in memory, outside every IndexedDB mount)
  async function checkBytes(bytes, pass) {
    const f = '/scratch-check.db';
    try { M.FS.writeFile(f, bytes); return await checkPassword(f, pass); }
    catch { return false; }
    finally { try { M.FS.unlink(f); } catch {} }
  }

  // Beam's recovery snapshot (what the mobile "Automatic restore" and the web wallet use): ~320 MB,
  // refreshed daily. It is kept in the extension's private file system (OPFS) for a few days, so a
  // second wallet only imports it; an older one is fine too (the wallet syncs the blocks after it).
  const SNAP = 'recovery.bin', SNAP_PART = 'recovery.part', SNAP_DAYS = 3;
  async function snapshotDir() { try { return await navigator.storage.getDirectory(); } catch { return null; } }

  async function snapshotInfo() {
    const dir = await snapshotDir();
    if (!dir) return null;
    try { const f = await (await dir.getFileHandle(SNAP)).getFile(); return { size: f.size, at: f.lastModified }; } catch { return null; }
  }

  async function dropSnapshot() {
    const dir = await snapshotDir();
    if (!dir) return;
    for (const n of [SNAP, SNAP_PART]) await dir.removeEntry(n).catch(() => {});
  }

  const readSnap = async (dir) => new Uint8Array(await (await (await dir.getFileHandle(SNAP)).getFile()).arrayBuffer());

  async function snapshot(url, onProgress) {
    const dir = await snapshotDir();
    const have = await snapshotInfo();
    if (have && Date.now() - have.at < SNAP_DAYS * 86400e3) {
      onProgress('cached', have.size, have.size);
      return readSnap(dir);
    }
    // a download that stops sending is given up after a minute without data (not left hanging forever)
    const ctl = new AbortController();
    let idle = setTimeout(() => ctl.abort(), 60000);
    const alive = () => { clearTimeout(idle); idle = setTimeout(() => ctl.abort(), 60000); };
    const res = await fetch(url, { cache: 'no-store', signal: ctl.signal }).catch((e) => { throw new Error(`recovery snapshot: ${ctl.signal.aborted ? 'no data for a minute' : e.message}`); });
    if (!res.ok) { clearTimeout(idle); throw new Error(`recovery snapshot: HTTP ${res.status}`); }
    const total = +res.headers.get('Content-Length') || 0;
    const r0 = res.body.getReader();
    const reader = { read: async () => { try { const x = await r0.read(); alive(); if (x.done) clearTimeout(idle); return x; } catch (e) { clearTimeout(idle); throw new Error(`recovery snapshot: ${ctl.signal.aborted ? 'no data for a minute' : e.message}`); } } };
    let got = 0;
    if (dir) {
      // straight to disk, then read back once: no 320 MB buffer growing in memory while it downloads
      const part = await dir.getFileHandle(SNAP_PART, { create: true });
      const w = await part.createWritable();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await w.write(value);
          got += value.length;
          onProgress('download', got, total);
        }
        await w.close();
      } catch (e) { await w.abort().catch(() => {}); throw e; }
      if (total && got !== total) throw new Error(`recovery snapshot: ${got} of ${total} bytes`);
      await dir.removeEntry(SNAP).catch(() => {});
      await part.move(SNAP);
      return readSnap(dir);
    }
    let buf = new Uint8Array(total || 64 << 20);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (got + value.length > buf.length) { const b = new Uint8Array(Math.max(buf.length * 2, got + value.length)); b.set(buf); buf = b; }
      buf.set(value, got);
      got += value.length;
      onProgress('download', got, total);
    }
    return buf.subarray(0, got);
  }

  // wasm throws C++ exceptions as bare numbers: a step names where it happened
  async function step(name, fn) {
    try { return await fn(); }
    catch (e) { throw new Error(`Beam ${name}: ${e && e.message ? e.message : typeof e === 'number' ? `engine exception ${e}` : String(e)}`); }
  }

  return {
    SHARED,
    load,
    call,
    appCall,
    // consent(info, amounts) -> Promise<boolean>: the one place a contract transaction is approved
    onConsent: (fn) => { consent = fn; },
    on: (fn) => listeners.add(fn),
    running: () => !!client && client.isRunning(),
    current: () => (cur ? cur.db : null),
    exists: (db) => WC.IsInitialized(db),
    generatePhrase: () => WC.GeneratePhrase(),
    isValidPhrase: (phrase) => WC.IsValidPhrase(words(phrase).join(' ')),
    isAllowedWord: (w) => WC.IsAllowedWord(w),
    checkPassword,
    checkBytes,
    snapshotInfo,
    dropSnapshot,

    // A new wallet and a seed restore are the same: create the database from the phrase, then let
    // the wallet import the snapshot as it starts. The snapshot also carries the headers, so a new
    // wallet does not sync ~4 M of them from genesis (an hour in a browser). The wallet keeps running.
    async create(db, phrase, pass, node, url, onProgress) {
      if (WC.IsInitialized(db)) throw new Error('a wallet already exists at ' + db);
      let data = await step('snapshot', () => snapshot(url, onProgress));
      await step('create', () => WC.CreateWallet(words(phrase).join(';'), db, pass));
      await step('write snapshot', () => M.FS.writeFile(RECOVERY, data));
      data = null;                            // MEMFS has its own copy: ~310 MB less held while it imports
      try {
        // an import that reports nothing for 5 minutes is given up (and its snapshot dropped: it may be bad)
        await new Promise((resolve, reject) => {
          let quiet = setTimeout(() => reject(new Error('the snapshot import stopped (no progress for 5 min)')), 300000);
          let last = '0/0';
          start(db, pass, node, () => client.importRecoveryFromFile(RECOVERY, (err, done, total) => {
            clearTimeout(quiet);
            if (err) return reject(new Error(`the snapshot import failed at ${last}: ${typeof err === 'number' ? `engine exception ${err}` : String(err)}`));
            last = `${done}/${total}`;
            onProgress('import', done, total);
            if (total && done >= total) return resolve();
            quiet = setTimeout(() => reject(new Error('the snapshot import stopped (no progress for 5 min)')), 300000);
          }));
        });
      } catch (e) {
        await stop();
        try { M.FS.unlink(db); } catch {}
        await syncfs(false).catch(() => {});
        await dropSnapshot().catch(() => {});
        throw e;
      } finally {
        try { M.FS.unlink(RECOVERY); } catch {}
      }
    },

    async open(db, pass, node) {
      if (!WC.IsInitialized(db)) throw new Error('this Beam wallet has no database in this browser');
      if (!(await checkPassword(db, pass))) throw new Error('wrong password');
      start(db, pass, node);
    },

    stop,

    // the database file as it is on disk (a backup: read once the wallet has stopped)
    readDb: (db) => M.FS.readFile(db),

    // a backup file becomes this engine's wallet, if pass opens it
    async importDb(db, bytes, pass) {
      if (WC.IsInitialized(db)) throw new Error('a wallet already exists at ' + db);
      M.FS.writeFile(db, bytes);
      if (!(await checkPassword(db, pass))) {
        try { M.FS.unlink(db); } catch {}
        throw new Error('this password does not open that file (or it is not a Beam wallet.db)');
      }
      await syncfs(false);
    },

    // migration: a database of the old shared folder copied into this engine's own store, checked with its
    // password; the old file stays where it was (a copy to fall back on), nothing is written there
    async copyFromShared(src, db, pass) {
      if (!existsPath(src)) throw new Error('no such file in the old folder: ' + src);
      if (WC.IsInitialized(db)) return 'present';
      M.FS.writeFile(db, M.FS.readFile(src));
      if (!(await checkPassword(db, pass))) { try { M.FS.unlink(db); } catch {} throw new Error('the copy does not open with its password'); }
      await syncfs(false);
      return 'copied';
    },
  };
})();
