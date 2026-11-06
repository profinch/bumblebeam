// BumbleBeam Wallet: the wallet host. A hidden offscreen document that runs Beam's wasm wallet for as
// long as the browser runs, so it keeps syncing and receiving with the popup closed (the popup is only
// a view: Chrome closes it on the first click outside), and holds the unlocked vault (vault.js): the
// wallets' seed phrases, Beam database passwords and Ethereum keys. The popup talks to it over a port:
//   popup -> { id, op, args }            host -> { id, result } | { id, error }
//   host -> { type: 'event' | 'progress' | 'consent', ... }   popup -> { type: 'consent', id, ok }
// Only the operations in `api` exist. Secrets never leave this document, except a phrase or key the
// user asks to see with the password, and a Beam backup file (encrypted by Beam).
//
// Wallets: each has a name and up to two parts. Beam: its own wallet.db in an engine of its own (engines.js;
// all of them run while the wallet is unlocked, so every regular address of every wallet is online). Ethereum:
// accounts m/44'/60'/0'/0/i of a phrase, or one private key. A new or restored wallet takes both parts
// from one 12-word phrase, so the same words restore it in Beam's wallets and in MetaMask or Rabby.
'use strict';

(() => {
  // our pool node's WebSocket door (deploy/docker wss.conf). The official web wallet's
  // web-wallet.beam.mw:8200 is still on the pre-HF6 chain ("incompatible with HF 6", stuck at 3928666).
  const DEFAULT_NODE = 'wss.bumblebeam.org:443';
  // the backup door: wsb.bumblebeam.org, a Cloudflare Worker to BeamMW's public nodes (deploy/cloudflare/wsb),
  // so a wallet keeps working when our server or node does not answer
  const DEFAULT_BACKUPS = ['wsb.bumblebeam.org:443'];
  const RECOVERY_URL = 'https://mobile-restore.beam.mw/mainnet/mainnet_recovery.bin';
  // wallet API methods the popup may call; contracts go through Bridge (the app API)
  const BEAM_READ = new Set(['wallet_status', 'tx_list', 'addr_list', 'validate_address', 'tx_status', 'get_version']);
  const BEAM_WRITE = new Set(['create_address', 'tx_send', 'tx_cancel', 'edit_address', 'delete_address']);

  let node = DEFAULT_NODE, progress = null, pendingPhrase = null;
  let vaultRec = null, data = null, vk = null;          // the stored record; unlocked: its contents and key
  let settings = { autoLock: 60, active: null, activeEth: {}, tokens: [], ethRpc: '', beamAddr: {} };
  let lastActive = Date.now();
  const ports = new Set();
  const broadcast = (msg) => { for (const p of ports) { try { p.postMessage(msg); } catch {} } };

  // chrome.storage through the service worker (an offscreen document has chrome.runtime only)
  const kv = {
    // a storage error is an error: read as "nothing there", it would offer to create a vault over the real one
    get: async (key) => {
      const r = await chrome.runtime.sendMessage({ op: 'get', key });
      if (!r || r.error) throw new Error(`storage: ${r ? r.error : 'no answer'}`);
      return r.result;
    },
    set: async (key, value) => {
      const r = await chrome.runtime.sendMessage({ op: 'set', key, value });
      if (!r || r.error) throw new Error(`storage: ${r ? r.error : 'no answer'} (not saved)`);
    },
  };
  const { b64: toB64, unb64: fromB64 } = Vault;

  // one wallet-changing operation at a time (switching, creating, contract transactions)
  let chain = Promise.resolve();
  const serial = (fn) => { const r = chain.then(fn, fn); chain = r.catch(() => {}); return r; };

  // ---------- consent: asked of the open popup, refused if there is none ----------
  let consentNext = 1, ctx = null;
  const consentWait = new Map();                       // id -> { resolve, ports }
  function askConsent(info, amounts) {
    return new Promise((resolve) => {
      if (!ports.size) return resolve(false);
      const id = consentNext++;
      const done = (ok) => { if (!consentWait.has(id)) return; consentWait.delete(id); resolve(ok); broadcast({ type: 'consentDone', id }); };
      consentWait.set(id, { resolve: done, ports: new Set(ports) });
      broadcast({ type: 'consent', id, info, amounts, ctx });
      setTimeout(() => done(false), 5 * 60 * 1000);
    });
  }
  // what the popup says the next contract transaction is; it goes into the consent box
  const withCtx = (c, fn) => serial(async () => { ctx = c; try { return await fn(); } finally { ctx = null; } });

  // a running snapshot import is not idle time (it ends by itself: beam.js gives up on a stalled one)
  const onProgress = (step, done, total) => { progress = { step, done, total }; lastActive = Date.now(); broadcast({ type: 'progress', ...progress }); };

  // ---------- the Beam engines: one per Beam wallet ----------
  // All Beam wallets run while the wallet is unlocked: every regular address of every wallet is online.
  // Locking stops them, except one with a transfer still being made (it runs until that ends: a regular
  // transfer needs both wallets online to complete). The browser's start runs none until the first unlock.
  // A crashed engine, or one without its node for a minute, is replaced by a new one (on the next node in
  // the list, if there is another).
  const engines = new Map();                           // wallet id -> { e, cfg: { db, pass }, node, nodeIx, since, lingering }
  const restarting = new Set();
  const nodeList = () => [...new Set([node, ...(settings.backupNodes || DEFAULT_BACKUPS)].filter(Boolean))];
  const PENDING = new Set([0, 1, 5]);                  // tx statuses: pending, in progress, registering

  function wire(e, id) {
    e.on.consent = askConsent;
    e.on.progress = onProgress;
    e.on.event = (m) => {
      broadcast({ type: 'event', method: m.method, result: m.result, wallet: id });
      if (m.method === 'ev_txs_changed') setTimeout(badge, 3000);
    };
    e.on.ws = () => broadcast({ type: 'event', method: 'bb_net', wallet: id });
    e.on.crash = (msg) => {
      console.warn(`Beam engine of ${id} crashed: ${msg}`);
      broadcast({ type: 'event', method: 'bb_error', result: `the Beam engine stopped (${msg}); starting it again` });
      restartEngine(id).catch(() => {});
    };
  }

  // an engine is running for this wallet: registered, events subscribed, its own address made
  async function register(id, e, cfg, n, nodeIx) {
    engines.set(id, { e, cfg, node: n, nodeIx, since: Date.now(), lingering: false });
    await e.call('ev_subunsub', { ev_sync_progress: true, ev_system_state: true, ev_txs_changed: true, ev_utxos_changed: true, ev_connection_changed: true }).catch(() => {});
    broadcast({ type: 'event', method: 'bb_changed' });
    ownAddress(id).catch(() => {});
  }

  // one start per wallet at a time: startAll's queue and a switch to a wallet still in it share it
  const starting = new Map();
  // why a wallet's Beam part did not start (the last failure; cleared when it starts), for Settings
  const startErr = new Map();
  function startEngine(id, cfg, nodeIx = 0) {
    if (engines.has(id)) return Promise.resolve(engines.get(id).e);
    if (!starting.has(id)) {
      starting.set(id, startEngine1(id, cfg, nodeIx)
        .then((e) => { startErr.delete(id); return e; }, (err) => { startErr.set(id, String(err && err.message || err)); throw err; })
        .finally(() => starting.delete(id)));
    }
    return starting.get(id);
  }
  async function startEngine1(id, cfg, nodeIx) {
    const list = nodeList(), n = list[nodeIx % list.length];
    const e = await Engines.fresh(id);
    wire(e, id);
    try { await e.rpc('open', [cfg.db, cfg.pass, n]); }
    catch (err) { e.drop(); throw err; }
    await register(id, e, cfg, n, nodeIx % list.length);
    return e;
  }

  async function stopEngine(id) {
    const x = engines.get(id);
    if (!x) return;
    engines.delete(id);
    await x.e.close();
    broadcast({ type: 'event', method: 'bb_changed' });
  }

  // a new engine for the same wallet (crash, lost node, a backup read, a new node); nextNode: the next in the list
  async function restartEngine(id, nextNode = false) {
    const x = engines.get(id);
    if (!x || restarting.has(id)) return;
    restarting.add(id);
    try {
      const lingering = x.lingering;
      await stopEngine(id);
      const e = await startEngine(id, x.cfg, x.nodeIx + (nextNode ? 1 : 0));
      if (lingering) engines.get(id).lingering = true;
      return e;
    } finally { restarting.delete(id); }
  }

  // the wallets' Beam parts, all of them (one after another: each loads a wasm engine)
  async function startAll() {
    if (!data) return;
    // the open wallet first: the popup shows it, and a slow or stuck start of another must not hold it
    const order = [...data.wallets].sort((a, b) => (b.id === settings.active) - (a.id === settings.active));
    for (const w of order) {
      if (!w.beam || engines.has(w.id)) { if (engines.has(w.id)) engines.get(w.id).lingering = false; continue; }
      try { await startEngine(w.id, { db: w.beam.db, pass: w.beam.pass }); }
      catch (err) { broadcast({ type: 'event', method: 'bb_error', result: `${w.name}: ${err.message}` }); }
    }
  }

  // locked: an engine with a transfer still being made keeps running until it ends; the others stop
  async function stopIdle() {
    for (const [id, x] of [...engines]) {
      let busy = false;
      try { busy = (await x.e.call('tx_list', { count: 100 }, 20000)).some((t) => PENDING.has(t.status)); } catch {}
      if (data) return;                                // unlocked meanwhile: everything stays
      if (busy) x.lingering = true; else await stopEngine(id);
    }
  }

  // Each Beam wallet keeps one public offline address of its own for the others: Send offers it under "my
  // wallets". Public offline (as pools and exchanges are paid): any number of payments, and the wallet that
  // receives need not run. A plain offline address holds a few one-time vouchers (10), each payment uses one;
  // its extra privacy does not matter between one's own wallets. An older offline one is replaced.
  async function ownAddress(id) {
    const x = engines.get(id);
    if (!x) return;
    const have = settings.beamAddr[id];
    if (have) {
      const v = await x.e.call('validate_address', { address: have.address }).catch(() => null);
      if (v && v.is_valid && v.is_mine && v.type === 'public_offline') return;
    }
    const address = await x.e.call('create_address', { type: 'public_offline', expiration: 'never', comment: 'for my other wallets' });
    settings.beamAddr[id] = { address, at: Date.now() };
    await saveSettings();
    broadcast({ type: 'event', method: 'bb_changed' });
  }

  // Version 0.1 and early 0.2 kept every database in one shared folder; each moves into its wallet's own
  // store (a copy, checked with its password; the old file stays as it was, as a copy to fall back on).
  async function migrate() {
    for (const w of data.wallets) {
      if (!w.beam || !w.beam.db.startsWith('/beam_wallet/')) continue;
      const to = Engines.dbOf(w.id);
      const e = await Engines.fresh(w.id, true);
      try { await e.rpc('copyFromShared', [w.beam.db, to, w.beam.pass]); }
      finally { e.drop(); }
      await mutate((d) => { const x = wallet(w.id, d); x.beam = { db: to, pass: x.beam.pass, movedFrom: x.beam.db }; });
    }
  }

  // watchdog: an engine without a node connection for a minute gets a new engine, on the next node if any
  setInterval(() => {
    const now = Date.now();
    for (const [id, x] of engines) {
      if (restarting.has(id) || x.e.ws.open > 0) continue;
      const lostSince = Math.max(x.e.ws.lastClose || 0, x.since);
      if (now - lostSince > 60000) {
        console.warn(`Beam engine of ${id}: no node for ${Math.round((now - lostSince) / 1000)} s, restarting`);
        restartEngine(id, nodeList().length > 1).catch(() => {});
      }
    }
  }, 15000);
  // A node that answers but lags: Beam makes a block about every minute, so a tip more than 10 minutes old
  // means the node is behind (on 2026-11-05 several of BeamMW's public nodes were, one stuck before HF6).
  // The engine then moves to the next node (through wsb that is another server, picked at random). The tip's
  // time is the chain's own, signed in the block: nothing outside is asked. A new engine gets 5 min to sync.
  const STALE_MS = 10 * 60000, GRACE_MS = 5 * 60000;
  setInterval(async () => {
    for (const [id, x] of [...engines]) {
      if (restarting.has(id) || Date.now() - x.since < GRACE_MS || x.e.ws.open === 0) continue;
      let ts = 0;
      try { ts = Number((await x.e.call('wallet_status', {}, 20000)).current_state_timestamp || 0) * 1000; } catch { continue; }
      if (!ts || Date.now() - ts < STALE_MS || engines.get(id) !== x) continue;
      console.warn(`Beam engine of ${id}: the node's last block is ${Math.round((Date.now() - ts) / 60000)} min old on ${x.node}, trying another`);
      broadcast({ type: 'event', method: 'bb_error', result: `the Beam node lags (last block ${Math.round((Date.now() - ts) / 60000)} min ago): trying another` });
      restartEngine(id, nodeList().length > 1).catch(() => {});
    }
  }, 60000);

  // Back to the main node: an engine on a backup tries the main one every 2 min (a short WebSocket that opens
  // and closes, through the same door), and after two answers in a row moves back, unless it is in the middle
  // of a transfer (then on a later round, once the transfer is done).
  function probe(n, ms = 10000) {
    return new Promise((resolve) => {
      let ws;
      const done = (ok) => { clearTimeout(t); try { ws.close(); } catch {} resolve(ok); };
      const t = setTimeout(() => done(false), ms);
      try { ws = new WebSocket(`wss://${n}`); } catch { return done(false); }
      ws.onopen = () => done(true);
      ws.onerror = () => done(false);
    });
  }
  setInterval(async () => {
    const main = nodeList()[0];
    for (const [id, x] of [...engines]) {
      if (x.nodeIx === 0 || restarting.has(id) || x.lingering) { x.mainOk = 0; continue; }
      x.mainOk = (await probe(main)) ? (x.mainOk || 0) + 1 : 0;
      if (x.mainOk < 2) continue;
      let busy = true;
      try { busy = (await x.e.call('tx_list', { count: 100 }, 20000)).some((t) => PENDING.has(t.status)); } catch {}
      if (busy || engines.get(id) !== x) continue;
      console.warn(`Beam engine of ${id}: the main node answers again, moving back from ${x.node}`);
      x.nodeIx = -1;                                    // restartEngine(+1) -> index 0, the main node
      await restartEngine(id, true).catch(() => {});
    }
  }, 120000);

  // while locked: lingering engines stop once their transfers are done
  setInterval(() => { if (!data && engines.size) stopIdle().catch(() => {}); }, 60000);

  // ---------- the vault ----------
  const need = () => { if (!data) throw new Error('the wallet is locked'); };
  // seals what is unlocked now; a lock during the seal does not matter (the sealed copy is whole), but a
  // save with nothing unlocked would write an empty vault over the real one
  // Every change to the vault goes through mutate(): one at a time, made on a copy, sealed, written, and only
  // then the live data. A failed write changes nothing (no account that exists only in memory), a lock in
  // between writes nothing, and two writes cannot land out of order (or one with an old password's key).
  let vaultChain = Promise.resolve();
  function mutate(fn, k2) {
    const run = async () => {
      need();
      const d0 = data, k = k2 || vk;
      const d = structuredClone(d0);
      const out = await fn(d);
      if (!Array.isArray(d.wallets)) throw new Error('nothing to save');
      const rec = await Vault.seal(k, d);
      if (data !== d0) throw new Error('the wallet was locked meanwhile: nothing changed');
      await kv.set('vault', rec);
      vaultRec = rec; data = d; vk = k;
      return out;
    };
    const r = vaultChain.then(run, run);
    vaultChain = r.catch(() => {});
    return r;
  }
  // the first vault (no data yet): written once, then live
  async function createVault(k, d) {
    const rec = await Vault.seal(k, d);
    await kv.set('vault', rec);
    vaultRec = rec; data = d; vk = k;
    lockIcon();
  }
  const saveSettings = () => kv.set('settings', settings);
  const wallet = (id, d = data) => { need(); const w = d.wallets.find((x) => x.id === id); if (!w) throw new Error('no such wallet'); return w; };
  // a Beam operation is for one wallet, named by the popup, and goes to that wallet's own engine
  function beamFor(id) {
    need();
    const x = engines.get(id);
    if (!x || x.e.dead) throw new Error('the Beam part of this wallet is not running');
    return { w: wallet(id), e: x.e };
  }
  const uint = (v, what) => { const s = String(v); if (!/^\d{1,18}$/.test(s) || !(Number(s) > 0) || !Number.isSafeInteger(Number(s))) throw new Error(`${what}: a positive whole number`); return Number(s); };
  const newId = () => Vault.randomHex(6);

  async function verify(pass) {
    need();
    await Vault.open(vaultRec, pass);       // throws 'wrong password'
  }

  // the util engine: seed phrase words and checks, the snapshot cache, the old shared folder
  const util = () => Engines.util();
  let legacyDb = false;                                // a 0.1 wallet.db in the old shared folder, no vault yet

  // An account's key: its own (imported by key or by another phrase) or the wallet's phrase at index i.
  // Imported accounts take ids from 1000 up, so the phrase's own indices stay 0, 1, 2, …
  const IMPORTED = 1000;
  const ethSecret = (w, i) => {
    if (!w.eth) throw new Error('this wallet has no Ethereum part');
    const a = w.eth.accounts.find((x) => x.i === i);
    if (!a) throw new Error('no such account');
    if (a.key) return { key: a.key };
    if (a.phrase) return { phrase: a.phrase, i: a.pi || 0 };
    return w.eth.key ? { key: w.eth.key } : { phrase: w.eth.phrase, i };
  };
  const accountKind = (w, a) => (a.key || (w.eth.key && !a.phrase) ? 'key' : a.phrase ? 'phrase' : 'hd');
  function ethAccounts(w) { return w.eth ? w.eth.accounts.map((a) => ({ i: a.i, name: a.name, address: a.address, kind: accountKind(w, a) })) : []; }
  function findEth(address) {
    need();
    for (const w of data.wallets) for (const a of (w.eth ? w.eth.accounts : [])) {
      if (a.address.toLowerCase() === String(address).toLowerCase()) return { w, a, secret: ethSecret(w, a.i) };
    }
    throw new Error('not an account of this wallet: ' + address);
  }
  function ethPart(phrase, key) {
    if (key) return { key: Eth.normKey(key), accounts: [{ i: 0, name: 'Account 1', address: Eth.addressOf({ key }) }] };
    const p = Eth.normPhrase(phrase);
    return { phrase: p, accounts: [{ i: 0, name: 'Account 1', address: Eth.addressOf({ phrase: p, i: 0 }) }] };
  }

  // the toolbar icon: a lock on it while there is a wallet and it is locked (sent only when it changes)
  let iconLocked = null;
  function lockIcon() {
    const locked = !data && !!(vaultRec || legacyDb);
    if (locked === iconLocked) return;
    iconLocked = locked;
    chrome.runtime.sendMessage({ op: 'icon', locked }).catch(() => { iconLocked = null; });
  }

  function lock() {
    data = null; vk = null; pendingPhrase = null;
    lockIcon();
    for (const p of prepared.values()) clearTimeout(p.t);
    prepared.clear();
    broadcast({ type: 'event', method: 'bb_locked' });
    // Beam goes offline with the lock, except a wallet still making a transfer (until it is done)
    stopIdle().catch(() => {});
  }

  // ---------- Ethereum transactions: priced first, shown, then signed ----------
  // One account signs one transaction at a time, with a nonce that no other transaction of this wallet has
  // taken: the chain's pending count or the next after the last one sent from here, whichever is higher
  // (a bridge's sendFunds and a send priced while its approval mined would otherwise share one).
  // If the chain has fewer pending than this host sent and its last one is gone from the network (dropped),
  // the count goes back to the chain's: no gap that every later transaction would wait behind.
  const nonceNext = new Map(), lastSent = new Map(), signChain = new Map(), inFlight = new Set();
  function signSend(secret, p) {
    const a = p.from.toLowerCase();
    const run = async () => {
      const pending = Number(BigInt(await Eth.rpc('eth_getTransactionCount', [p.from, 'pending'])));
      let mine = nonceNext.get(a) || 0;
      if (mine > pending && lastSent.has(a) && !(await Eth.rpc('eth_getTransactionByHash', [lastSent.get(a)]).catch(() => true))) mine = pending;
      const nonce = Math.max(pending, mine);
      const hash = await Eth.broadcast(await Eth.sign(secret, { ...p, nonce }));
      nonceNext.set(a, nonce + 1); lastSent.set(a, hash);
      return hash;
    };
    const r = (signChain.get(a) || Promise.resolve()).then(run, run);
    signChain.set(a, r.catch(() => {}));
    return r;
  }
  // the bridge's Ethereum-side log: one write at a time, so two transfers do not overwrite each other
  let logChain = Promise.resolve();
  function logIn(rec) {
    const run = async () => {
      const l = ((await kv.get('bridgeIn')) || []).filter((r) => r.time !== rec.time);
      l.unshift({ ...rec });
      await kv.set('bridgeIn', l.sort((x, y) => y.time - x.time).slice(0, 50));
    };
    logChain = logChain.then(run, run);
    return logChain.catch(() => {});
  }
  const prepared = new Map();
  let prepNext = 1;
  function keep(p) {
    const id = prepNext++;
    p.t = setTimeout(() => prepared.delete(id), 5 * 60 * 1000);
    prepared.set(id, p);
    return id;
  }
  function take(id, kind) {
    const p = prepared.get(id);
    if (!p || p.kind !== kind) throw new Error('this transaction expired: price it again');
    prepared.delete(id); clearTimeout(p.t);
    return p;
  }

  const api = {
    state() {
      lockIcon();
      const base = {
        phase: data ? 'unlocked' : vaultRec ? 'locked' : legacyDb ? 'legacy' : 'new',
        progress, phrase: !!pendingPhrase, node, beamRunning: engines.size > 0, autoLock: settings.autoLock,
        // the contracts the popup must never send tokens to (they would be lost): from bridge.js, not retyped
        contracts: { wbeam: Bridge.WBEAM.toLowerCase(), ethPipe: Bridge.ETH_PIPE.toLowerCase() },
      };
      if (!data) return base;
      return {
        ...base,
        active: settings.active, activeEth: settings.activeEth, tokens: settings.tokens, ethRpc: settings.ethRpc,
        // each Beam wallet's engine: running, connected to its node (the WebSocket open), which node
        engines: Object.fromEntries([...engines].map(([id, x]) => [id, { running: !x.e.dead, connected: x.e.ws.open > 0, node: x.node }])),
        // the wallets whose Beam part is not running: starting now, or why it failed
        beamDown: Object.fromEntries((data ? data.wallets : []).filter((w) => w.beam && !engines.has(w.id)).map((w) => [w.id, starting.has(w.id) ? 'starting' : startErr.get(w.id) || 'not started'])),
        nodes: nodeList(),
        wallets: data.wallets.map((w) => ({
          id: w.id, name: w.name, created: w.created, phraseKnown: !!w.phrase,
          beam: !!w.beam, eth: !!w.eth, hd: !!(w.eth && w.eth.phrase),
          ethKind: w.eth ? (w.eth.key ? 'key' : !w.eth.phrase ? 'imported' : w.eth.phrase === w.phrase ? 'same' : 'phrase') : null,
          beamAddress: (settings.beamAddr[w.id] || {}).address || null,
          accounts: ethAccounts(w),
        })),
      };
    },
    touch() {},

    // first password (no vault yet) or unlock; a 0.1 wallet (wallet.db, no vault) moves into a vault here
    async unlock(pass) {
      if (data) return verify(pass);
      if (vaultRec) {
        const o = await Vault.open(vaultRec, pass);
        data = o.data; vk = o.k;
        lockIcon();
      } else if (legacyDb) {
        if (!(await (await util()).rpc('checkPassword', ['/beam_wallet/wallet.db', pass]))) throw new Error('wrong password');
        const d = { v: 1, wallets: [{ id: newId(), name: 'Wallet 1', created: Date.now(), phrase: null, beam: { db: '/beam_wallet/wallet.db', pass }, eth: null }] };
        await createVault(await Vault.keyFor(pass), d);
        settings.active = d.wallets[0].id;
        await saveSettings();
      } else throw new Error('no wallet yet');
      lastActive = Date.now();
      broadcast({ type: 'event', method: 'bb_changed' });
      // the databases of the old shared folder move into their own stores, then every Beam wallet starts
      serial(async () => {
        try { await migrate(); } catch (e) { broadcast({ type: 'event', method: 'bb_error', result: `moving a Beam database: ${e.message}` }); }
        await startAll();
      }).catch(() => {});
    },
    lock,

    // a new seed lives here until the wallet is created, so closing the popup to write it down loses nothing
    newPhrase: async () => (pendingPhrase = await (await util()).rpc('generatePhrase')),
    phrase: () => pendingPhrase,
    dropPhrase: () => { pendingPhrase = null; },
    isAllowedWord: async (w) => (await util()).rpc('isAllowedWord', [w]),
    checkPhrase: async (p) => ({ beam: await (await util()).rpc('isValidPhrase', [p]), eth: Eth.isPhrase(p), words: Eth.normPhrase(p).split(' ').filter(Boolean).length }),
    isEthKey: (k) => Eth.isKey(k),

    // Adds a wallet (the first one also sets the password):
    //   { kind: 'new' }                      the phrase from newPhrase: Beam + Ethereum
    //   { kind: 'restore', phrase, beam }    Beam (if it is a Beam phrase and beam) + Ethereum (if BIP-39)
    //   { kind: 'backup', b64, pass }        a Beam wallet.db and its password
    //   { kind: 'ethkey', key }              one Ethereum account
    addWallet: (o, password) => serial(async () => {
      if (!data) {
        if (vaultRec || legacyDb) throw new Error('the wallet is locked');
        if (!password || password.length < 8) throw new Error('use a password of 8 characters or more');
      }
      const id = newId();
      const first = !data;
      const wallets = data ? data.wallets : [];
      const name = (o.name || '').trim().slice(0, 32) || `Wallet ${wallets.length + 1}`;
      const pass = first ? password : null;
      const w = { id, name, created: Date.now(), phrase: null, beam: null, eth: null };
      // The Beam database password: random, kept in the vault (Settings shows it with a backup file). Not the
      // wallet password: wallet.db sits in the browser profile and in backups, and its cipher is Beam's; a
      // guess tried against it must not open the vault, and the vault's password must not open it.
      const dbPass = Vault.randomHex(24);
      if (!first) await verify(o.dbPass);   // re-typed: proves who adds it
      let made = null;                        // the new wallet's Beam engine, running once it is made
      try {
        if (o.kind === 'new' || o.kind === 'restore') {
          const phrase = o.kind === 'new' ? pendingPhrase : String(o.phrase || '');
          if (!phrase) throw new Error('no seed phrase');
          const p = Eth.normPhrase(phrase);
          const beamOk = await (await util()).rpc('isValidPhrase', [p]), ethOk = Eth.isPhrase(p);
          if (!beamOk && !ethOk) throw new Error('this is not a valid seed phrase');
          w.phrase = p;
          if (ethOk) w.eth = ethPart(p);
          if (beamOk && (o.kind === 'new' || o.beam !== false)) {
            progress = { step: 'download', done: 0, total: 0 };
            const db = Engines.dbOf(id);
            made = await Engines.fresh(id);
            wire(made, id);
            try { await made.rpc('create', [db, p, dbPass, node, RECOVERY_URL], 40 * 60 * 1000); }
            finally { progress = null; }
            w.beam = { db, pass: dbPass };
          }
          if (o.kind === 'new') pendingPhrase = null;
        } else if (o.kind === 'backup') {
          const db = Engines.dbOf(id);
          made = await Engines.fresh(id);
          wire(made, id);
          await made.rpc('importDb', [db, fromB64(o.b64), o.pass]);
          await made.rpc('open', [db, o.pass, node]);
          w.beam = { db, pass: o.pass };
        } else if (o.kind === 'ethkey') {
          if (!Eth.isKey(o.key)) throw new Error('a private key is 64 hex characters');
          w.eth = ethPart(null, o.key);
        } else throw new Error('unknown kind');
        if (first) await createVault(await Vault.keyFor(pass), { v: 1, wallets: [w] });
        else await mutate((d) => { d.wallets.push(w); });
        lastActive = Date.now();          // a long snapshot import is not idle time
      } catch (e) {
        if (made) { await made.close(); await Engines.dropStore(id); }
        broadcast({ type: 'event', method: 'bb_failed', result: e.message });
        throw e;
      }
      settings.active = id;
      await saveSettings();
      if (made) await register(id, made, { db: w.beam.db, pass: w.beam.pass }, node, 0);
      broadcast({ type: 'event', method: 'bb_changed' });
      return id;
    }),

    // every Beam wallet runs already: switching only changes what the popup shows
    switchWallet: async (id) => {
      const w = wallet(id); settings.active = id; await saveSettings(); broadcast({ type: 'event', method: 'bb_changed' });
      // a wallet whose Beam part has not started yet (startAll still busy with others) starts now
      if (w.beam && !engines.has(id)) startEngine(id, { db: w.beam.db, pass: w.beam.pass }).catch((err) => broadcast({ type: 'event', method: 'bb_error', result: `${w.name}: ${err.message}` }));
    },
    renameWallet: (id, name) => mutate((d) => { const w = wallet(id, d); w.name = String(name).trim().slice(0, 32) || w.name; }),
    removeWallet: (id, pass) => serial(async () => {
      await verify(pass);
      const w = wallet(id);
      // out of the vault first: if that write fails, nothing is gone (the database is deleted only after)
      await mutate((d) => { d.wallets = d.wallets.filter((x) => x.id !== id); });
      await stopEngine(id);
      if (w.beam && w.beam.db.startsWith('/bw_')) await Engines.dropStore(id);   // a file left in the old shared folder stays
      if (settings.active === id) settings.active = data.wallets[0] ? data.wallets[0].id : null;
      delete settings.activeEth[id]; delete settings.beamAddr[id];
      await saveSettings();
      broadcast({ type: 'event', method: 'bb_changed' });
    }),
    // a wallet without one part gets it: Ethereum from a new or given phrase or a key
    // the new phrase is returned only once it is saved, and shown once to write down
    addEthPart: (id, o) => mutate((d) => {
      const w = wallet(id, d);
      if (w.eth) throw new Error('this wallet has an Ethereum part');
      if (o.kind === 'new') w.eth = ethPart(Eth.newPhrase());
      else if (o.kind === 'phrase') { if (!Eth.isPhrase(o.phrase)) throw new Error('not a valid BIP-39 phrase'); w.eth = ethPart(o.phrase); }
      else if (o.kind === 'key') { if (!Eth.isKey(o.key)) throw new Error('a private key is 64 hex characters'); w.eth = ethPart(null, o.key); }
      else throw new Error('unknown kind');
      return w.eth.phrase && w.eth.phrase !== w.phrase ? w.eth.phrase : null;
    }),
    // the lowest index not shown, so an account taken off the list comes back with "add"
    async addEthAccount(id) {
      const i = await mutate((d) => {
        const w = wallet(id, d);
        if (!w.eth || !w.eth.phrase) throw new Error('only a wallet with a seed phrase gives more accounts: import one instead');
        let n = 0;
        while (w.eth.accounts.some((a) => a.i === n)) n++;
        w.eth.accounts.push({ i: n, name: `Account ${n + 1}`, address: Eth.addressOf({ phrase: w.eth.phrase, i: n }) });
        w.eth.accounts.sort((a, b) => a.i - b.i);
        return n;
      });
      settings.activeEth[id] = i; await saveSettings();
      return i;
    },
    // an account from elsewhere into this wallet: a private key, or a phrase (its first account)
    async importEthAccount(id, o) {
      const acc = { name: String(o.name || '').trim().slice(0, 32) };
      if (o.key) {
        if (!Eth.isKey(o.key)) throw new Error('a private key is 64 hex characters');
        acc.key = Eth.normKey(o.key); acc.address = Eth.addressOf({ key: acc.key });
      } else {
        if (!Eth.isPhrase(o.phrase || '')) throw new Error('neither a BIP-39 phrase nor a 64-hex private key');
        acc.phrase = Eth.normPhrase(o.phrase); acc.pi = 0; acc.address = Eth.addressOf({ phrase: acc.phrase, i: 0 });
      }
      for (const w of data.wallets) for (const a of (w.eth ? w.eth.accounts : [])) {
        if (a.address.toLowerCase() === acc.address.toLowerCase()) throw new Error(`already here: ${w.name} · ${a.name}`);
      }
      const i = await mutate((d) => {
        const w = wallet(id, d);
        if (!w.eth) w.eth = { accounts: [] };
        let n = IMPORTED;
        while (w.eth.accounts.some((a) => a.i === n)) n++;
        w.eth.accounts.push({ ...acc, i: n, name: acc.name || `Imported ${n - IMPORTED + 1}` });
        return n;
      });
      settings.activeEth[id] = i; await saveSettings();
      return i;
    },
    renameEthAccount: (id, i, name) => mutate((d) => {
      const a = (wallet(id, d).eth || { accounts: [] }).accounts.find((x) => x.i === i);
      if (a) a.name = String(name).trim().slice(0, 32) || a.name;
    }),
    // off the list (a phrase account: "+ Add an account" brings the same one back; an imported one: its key
    // is gone from here). The password again, and never the last account of a wallet.
    removeEthAccount: async (id, i, pass) => { await verify(pass); return api.hideEthAccount(id, i); },
    hideEthAccount: (id, i) => mutate((d) => {
      const w = wallet(id, d);
      if (!w.eth || w.eth.accounts.length < 2) throw new Error('the last account stays');
      w.eth.accounts = w.eth.accounts.filter((a) => a.i !== i);
    }),
    async setActiveEth(id, i) { settings.activeEth[id] = i; await saveSettings(); },

    // what only the password shows: the seed phrase, an Ethereum key, the Beam database password
    async reveal(id, pass, what, i) {
      await verify(pass);
      const w = wallet(id);
      if (what === 'phrase') return w.phrase || null;
      if (what === 'ethPhrase') return w.eth && w.eth.phrase || null;
      if (what === 'ethKey') return Eth.signer(ethSecret(w, i)).privateKey;
      if (what === 'beamPass') return w.beam ? (w.beam.pass === pass ? '' : w.beam.pass) : null;   // '' = the wallet password
      throw new Error('nothing to show');
    },
    verify: (pass) => verify(pass),
    // in the vault's own chain: the new key counts only once the record sealed with it is on disk
    async changePassword(oldPass, newPass) {
      if (!newPass || newPass.length < 8) throw new Error('use a password of 8 characters or more');
      await verify(oldPass);
      await mutate(() => {}, await Vault.keyFor(newPass));
    },
    async exportBeam(id, pass) {
      await verify(pass);
      const w = wallet(id);
      if (!w.beam) throw new Error('this wallet has no Beam part');
      // read while the wallet is stopped (its engine closed, the database written); then a new engine runs it
      const b64 = await serial(async () => {
        const wasRunning = engines.has(id);
        await stopEngine(id);
        const e = await Engines.fresh(id);
        try { return toB64(await e.rpc('readDb', [w.beam.db])); }
        finally { e.drop(); if (wasRunning) await startEngine(id, { db: w.beam.db, pass: w.beam.pass }).catch(() => {}); }
      });
      return { b64, samePassword: w.beam.pass === pass };
    },

    // ---------- settings ----------
    async setNode(n) {
      need();
      node = String(n || '').trim() || DEFAULT_NODE;
      await kv.set('node', node);
      // every engine starts again on the new node
      await serial(async () => { for (const id of [...engines.keys()]) { const x = engines.get(id); x.nodeIx = -1; await restartEngine(id, true).catch(() => {}); } });
      return node;
    },
    async setEthRpc(url) {
      need();
      url = String(url || '').trim();
      if (url && !/^https:\/\/[^\s]+$/.test(url)) throw new Error('an https:// URL');
      settings.ethRpc = url; Eth.setRpc(url); await saveSettings();
    },
    async setAutoLock(min) { need(); settings.autoLock = Math.max(0, Math.min(1440, Number(min) || 0)); await saveSettings(); },
    async addToken(addr) {
      need();
      const t = await Eth.tokenInfo(addr);
      if (!settings.tokens.some((x) => x.address.toLowerCase() === t.address.toLowerCase())) settings.tokens.push(t);
      await saveSettings();
      return t;
    },
    async removeToken(addr) { need(); settings.tokens = settings.tokens.filter((x) => x.address.toLowerCase() !== String(addr).toLowerCase()); await saveSettings(); },
    snapshotInfo: async () => (await util()).rpc('snapshotInfo'),
    dropSnapshot: async () => { need(); return (await util()).rpc('dropSnapshot'); },
    // backup Beam nodes (wss host:port), tried in turn when the main one does not answer for a minute
    async setBackupNodes(list) {
      need();
      const clean = (Array.isArray(list) ? list : String(list || '').split(/[\s,]+/)).map((x) => String(x).trim()).filter((x) => /^[\w.-]+:\d{1,5}$/.test(x));
      settings.backupNodes = [...new Set(clean)].slice(0, 5); await saveSettings();
      return settings.backupNodes;
    },

    // ---------- Beam ----------
    beam(walletId, method, params) {
      if (!BEAM_READ.has(method) && !BEAM_WRITE.has(method)) throw new Error(`not allowed: ${method}`);
      return beamFor(walletId).e.call(method, params);
    },

    // ---------- Ethereum ----------
    rates: () => Bridge.rates(),
    ethBalances: (address) => Eth.balances(address, settings.tokens),
    ethHistory: (address) => Eth.history(address),
    // { from, to, amount (decimal string), token: null | { address, decimals, symbol } } -> priced, kept for ethSend
    // A token's decimals are read from its contract here, never taken from the popup or Blockscout; the
    // confirmation shows the exact amount that will be signed, as the host computed it.
    async ethPrepare(o) {
      const { w, a } = findEth(o.from);
      const to = Eth.checkAddress(o.to);
      if ([Bridge.WBEAM, Bridge.ETH_PIPE].some((c) => c.toLowerCase() === to.toLowerCase())) throw new Error('that is the WBEAM token or the bridge contract: tokens sent there are lost. Use the Bridge tab');
      const token = o.token ? await Eth.tokenInfo(o.token.address) : null;
      const dec = token ? token.decimals : 18;
      const want = Eth.toUnits(o.amount, dec);
      if (!(want > 0n)) throw new Error('the amount must be above zero');
      const tx = token
        ? { from: a.address, to: token.address, data: Eth.ERC20.transfer(to, want), value: 0n }
        : { from: a.address, to, data: '0x', value: want };
      const have = token ? await Eth.callBig(token.address, Eth.ERC20.balanceOf(a.address)) : BigInt(await Eth.rpc('eth_getBalance', [a.address, 'latest']));
      const sym = token ? token.symbol : 'ETH';
      if (have < want) throw new Error(`not enough ${sym}: ${Eth.fromUnits(want, dec)} to send, ${Eth.fromUnits(have, dec)} there`);
      const p = await Eth.price(tx);
      return { id: keep({ kind: 'send', wallet: w.id, p }), ...p, to, symbol: sym, amountExact: Eth.fromUnits(want, dec) };
    },
    async ethSend(prepId) {
      const x = take(prepId, 'send');
      const { secret } = findEth(x.p.from);
      return signSend(secret, x.p);
    },

    // ---------- the bridge ----------
    relayerFee: () => Bridge.relayerFee(),
    // the bridge's messages to any of this wallet's Ethereum accounts (and to `extra`)
    outgoing(extra) {
      need();
      const mine = data.wallets.flatMap((w) => ethAccounts(w).map((a) => a.address));
      // the pipe's messages are the same for every wallet: any running engine reads them
      const x = [...engines.values()].find((y) => !y.e.dead);
      if (!x) throw new Error('no Beam wallet is running');
      return Bridge.outgoing(x.e, [...mine, ...(extra && Eth.isAddress(extra) ? [extra] : [])]);
    },
    beamKey: (walletId) => Bridge.beamKey(beamFor(walletId).e),
    incoming: (walletId) => Bridge.incoming(beamFor(walletId).e),
    // the shader's arguments are a comma-separated string: only whole numbers and a checked address go in, and
    // the confirmation names the wallet that spends (from the host, not from the popup)
    sendToEth: (walletId, c, a, rcv, f) => {
      const w = beamFor(walletId);
      const args = [uint(a, 'amount'), Eth.checkAddress(rcv), uint(f, 'relayer fee')];
      return withCtx({ ...c, rows: [['Beam wallet', w.name], ...((c && c.rows) || [])] }, () => Bridge.sendToEth(beamFor(walletId).e, ...args));
    },
    receive: (walletId, c, msgId) => {
      const w = beamFor(walletId);
      const id = uint(msgId, 'message');
      return withCtx({ ...c, rows: [['Beam wallet', w.name], ...((c && c.rows) || [])] }, () => Bridge.receive(beamFor(walletId).e, id));
    },

    // WBEAM -> BEAM from one of this wallet's Ethereum accounts to the running Beam wallet's bridge key:
    // approve (if the pipe may not take enough yet) and sendFunds, priced together, signed after a yes
    async fromEthPrepare(o) {
      const { w, a } = findEth(o.from);
      const bw = beamFor(o.wallet).w;                  // the Beam wallet that receives: the one the popup named
      const key = await Bridge.beamKey(beamFor(o.wallet).e);
      beamFor(o.wallet);
      const value = Eth.toUnits(o.amount, 8), fee = Eth.toUnits(o.fee, 8);
      if (value <= 0n) throw new Error('the amount must be above zero');
      const total = value + fee;
      const [bal, allow] = await Promise.all([
        Eth.callBig(Bridge.WBEAM, Eth.ERC20.balanceOf(a.address)), Eth.callBig(Bridge.WBEAM, Eth.ERC20.allowance(a.address, Bridge.ETH_PIPE)),
      ]);
      if (bal < total) throw new Error(`not enough WBEAM on ${a.address.slice(0, 8)}…: ${Number(total) / 1e8} needed, ${Number(bal) / 1e8} there`);
      const send = { from: a.address, to: Bridge.ETH_PIPE, data: Bridge.sendFundsData(value, fee, key), value: 0n };
      let approve = null, sendP;
      if (allow < total) {
        approve = await Eth.price({ from: a.address, to: Bridge.WBEAM, data: Eth.ERC20.approve(Bridge.ETH_PIPE, total), value: 0n });
        // sendFunds cannot be estimated before the approval: priced like the approval, with the gas sendFunds
        // took on mainnet (50-60 000) and room above it; it is priced again once the approval is in
        const gas = 110000n;
        sendP = { ...approve, data: send.data, to: send.to, nonce: approve.nonce + 1, gasLimit: gas.toString(),
          feeNow: (75000n * BigInt(approve.perGasNow)).toString(), feeMax: (gas * BigInt(approve.maxFeePerGas)).toString() };
      } else sendP = await Eth.price(send);
      const ethBal = BigInt(await Eth.rpc('eth_getBalance', [a.address, 'latest']));
      const feeMax = BigInt(sendP.feeMax) + (approve ? BigInt(approve.feeMax) : 0n);
      return {
        id: keep({ kind: 'fromEth', wallet: w.id, from: a.address, send, approve, total: total.toString(), key, value: value.toString(), fee: fee.toString(), sendFeeMax: sendP.feeMax }),
        key, beamWallet: bw.name, from: a.address, value: value.toString(), fee: fee.toString(), approve: !!approve,
        feeNow: (BigInt(sendP.feeNow) + (approve ? BigInt(approve.feeNow) : 0n)).toString(), feeMax: feeMax.toString(),
        ethBalance: ethBal.toString(), enoughGas: ethBal >= feeMax,
      };
    },
    async fromEthSend(prepId) {
      const x = take(prepId, 'fromEth');
      const { secret } = findEth(x.from);
      const rec = { from: x.from, value: x.value, fee: x.fee, key: x.key, time: Date.now(), approve: null, hash: null, state: 'approving' };
      inFlight.add(rec.time);
      const tell = async () => { await logIn(rec); broadcast({ type: 'event', method: 'bb_bridge', result: rec }); };
      await tell();
      try {
        if (x.approve) {
          rec.approve = await signSend(secret, x.approve);
          await tell();
          await Eth.receipt(rec.approve);
        }
        rec.state = 'sending'; await tell();
        const p = await Eth.price(x.send);
        // signed without asking again only within what was confirmed (+50 % for the estimate's room)
        if (BigInt(p.feeMax) > (BigInt(x.sendFeeMax) * 3n) / 2n) {
          throw new Error(`gas rose while the approval mined: sendFunds would cost up to ${Number(BigInt(p.feeMax)) / 1e18} ETH, more than confirmed. The approval is in place: send again`);
        }
        rec.hash = await signSend(secret, p);
        rec.state = 'sent'; await tell();
        await Eth.receipt(rec.hash);
        rec.state = 'confirmed'; await tell();
        return rec;
      } catch (e) {
        // a transaction that went out but did not confirm in time is not a failure: it may still mine, and
        // bridgeIn looks again; only a reverted one, or one that never went out, failed
        const out = rec.state === 'sent' ? rec.hash : rec.state === 'approving' ? rec.approve : null;
        rec.state = out && !/failed/.test(e.message) ? 'unconfirmed' : 'failed';
        rec.error = e.message; await tell();
        throw e;
      } finally { inFlight.delete(rec.time); }
    },
    // the log, with what was left unconfirmed looked up again on the chain
    // (a record this host is not working on and left half way: the browser closed between approve and send)
    async bridgeIn() {
      const l = (await kv.get('bridgeIn')) || [];
      for (const r of l) {
        if (inFlight.has(r.time)) continue;
        if (r.state === 'approving' || r.state === 'sending') {
          if (!r.approve) { r.state = 'failed'; r.error = 'stopped before anything was sent: nothing left the account'; await logIn(r); continue; }
          r.state = 'unconfirmed'; r.hash = null;
        }
        if (r.state !== 'unconfirmed' && r.state !== 'sent') continue;
        const h = r.hash || r.approve;
        const rc = h ? await Eth.rpc('eth_getTransactionReceipt', [h]).catch(() => null) : null;
        if (!rc) continue;
        if (r.hash) { r.state = rc.status === '0x1' ? 'confirmed' : 'failed'; delete r.error; await logIn(r); }
        else if (rc.status !== '0x1') { r.state = 'failed'; await logIn(r); }
        else { r.state = 'failed'; r.error = 'the approval went through but sendFunds was never sent: send again (the approval is used)'; await logIn(r); }
      }
      return l;
    },

  };
  // Idle means no click or key in the popup: it sends 'touch' on those (and unlocking counts). Its timed
  // refreshes (balances, the bridge lists, prices) are not activity and never keep the vault open.
  const ACTIVE = new Set(['touch', 'unlock']);

  // every operation waits for the engine; a failed start is the answer to all of them
  const ready = (async () => {
    if (!self.crossOriginIsolated) throw new Error('the wallet host is not cross-origin isolated: the wasm wallet needs SharedArrayBuffer');
    node = (await kv.get('node')) || DEFAULT_NODE;
    vaultRec = (await kv.get('vault')) || null;
    settings = { ...settings, ...((await kv.get('settings')) || {}) };
    settings.beamAddr = settings.beamAddr || {};
    if (settings.ethRpc) Eth.setRpc(settings.ethRpc);
    // the util engine reads the old shared folder: is there a 0.1 wallet.db waiting for its first unlock?
    if (!vaultRec) legacyDb = !!(await (await util()).rpc('exists', ['/beam_wallet/wallet.db']));
    lockIcon();
  })();
  ready.catch(() => {});                       // reported to each operation instead

  // auto-lock: the vault closes after the chosen idle time (and the Beam engines stop, see stopIdle)
  setInterval(() => {
    if (data && settings.autoLock > 0 && Date.now() - lastActive > settings.autoLock * 60000) lock();
  }, 20000);

  // the toolbar badge: WBEAM that arrived on Beam for the running wallets and waits for Claim (checked every
  // 5 min while engines run: a read of the pipe, nothing is signed)
  async function badge() {
    let n = 0;
    for (const x of engines.values()) { try { n += (await Bridge.incoming(x.e)).length; } catch {} }
    chrome.runtime.sendMessage({ op: 'badge', text: n ? String(n) : '' }).catch(() => {});
  }
  setInterval(badge, 5 * 60 * 1000);

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'wallet-ui' || port.sender.id !== chrome.runtime.id) return port.disconnect();
    ports.add(port);
    port.onDisconnect.addListener(() => {
      ports.delete(port);
      // a consent box that only this popup showed is a no
      for (const w of [...consentWait.values()]) { w.ports.delete(port); if (![...w.ports].some((p) => ports.has(p))) w.resolve(false); }
    });
    port.onMessage.addListener(async (m) => {
      if (m.type === 'consent') { const w = consentWait.get(m.id); if (w) w.resolve(!!m.ok); return; }
      if (!Object.hasOwn(api, m.op)) return port.postMessage({ id: m.id, error: `no such operation: ${m.op}` });
      if (ACTIVE.has(m.op)) lastActive = Date.now();
      try { await ready; port.postMessage({ id: m.id, result: await api[m.op](...(m.args || [])) }); }
      catch (e) { try { port.postMessage({ id: m.id, error: e && e.message ? e.message : String(e) }); } catch {} }
    });
  });
})();
