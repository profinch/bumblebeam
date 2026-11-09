// BumbleBeam Wallet: the popup under the toolbar icon (and the same page in a tab, ⤢). Only a view:
// the wallets run in the host (offscreen.js) and every action is a message to it. Start screens (create,
// restore, backup file, Ethereum key, unlock), then four tabs: Wallet (both networks, send and receive),
// Bridge (both directions, this wallet's own accounts at both ends), Activity and Settings. Every string
// from the wallet, the contract or the network goes through esc() before it is put into HTML.
'use strict';

(() => {
  const GROTH = 1e8;
  const inTab = new URLSearchParams(location.search).has('tab');
  const inWin = new URLSearchParams(location.search).has('win');   // the window where a site's request is answered
  if (!inTab) document.documentElement.classList.add('popup');
  // the request window (popup.html?win=1): the popup's layout at the window's own size, not the popup's 400 x 600
  if (new URLSearchParams(location.search).has('win')) document.documentElement.classList.add('win');

  // ---------- small things ----------
  const $ = (id) => document.getElementById(id);
  const qa = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const amt = (groth, d = 4) => (groth == null || !isFinite(groth) ? '—'
    : (groth / GROTH).toLocaleString('en-US', { minimumFractionDigits: Math.min(2, d), maximumFractionDigits: d }));
  // a decimal string of smallest units, as a number for display (exact enough for display), and exactly
  const units = (s, dec) => { try { const v = BigInt(s || 0); const p = 10n ** BigInt(dec); return Number(v / p) + Number(v % p) / Number(p); } catch { return NaN; } };
  const exact = (s, dec) => { const v = BigInt(s || 0), p = 10n ** BigInt(dec); const f = (v % p).toString().padStart(dec, '0').replace(/0+$/, ''); return `${v / p}${f ? '.' + f : ''}`; };
  const num = (x, max = 4) => (x == null || !isFinite(x) ? '—' : x.toLocaleString('en-US', { maximumFractionDigits: x !== 0 && Math.abs(x) < 1 ? Math.max(max, 6) : max }));
  const usd = (x) => (x == null || !isFinite(x) ? '' : `$${x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const short = (a) => (a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '');
  // dates as dd.mm.yyyy everywhere; the time in 24 or 12 hours, as chosen in Settings (kept in this browser)
  const pad = (n) => String(n).padStart(2, '0');
  let time12 = false;
  const fdate = (t) => { const d = new Date(t); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`; };
  const ftime = (t) => {
    const d = new Date(t), h = d.getHours();
    return time12 ? `${h % 12 || 12}:${pad(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}` : `${pad(h)}:${pad(d.getMinutes())}`;
  };
  const fdt = (t) => `${fdate(t)} ${ftime(t)}`;
  const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : fdate(t); };
  const msg = (e) => (e && e.message ? e.message : String(e));
  const toGroth = (x) => {
    const t = String(x).trim().replace(',', '.');
    if (!/^\d*\.?\d{0,8}$/.test(t) || t === '' || t === '.') throw new Error('an amount with at most 8 decimals');
    const [i, f = ''] = t.split('.');
    const v = Number(i || 0) * GROTH + Number((f + '00000000').slice(0, 8));
    if (!(v > 0)) throw new Error('the amount must be above zero');
    return v;
  };
  const isEthAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(a);
  const norm = (p) => String(p).trim().toLowerCase().split(/[\s;,]+/).filter(Boolean).join(' ');   // as Eth.normPhrase
  // the error and ok notes of a screen: the .note.bad / .note.ok inside it
  const note = (scope, kind, text, html) => {
    const el = typeof scope === 'string' ? (/\b(note|msg)\b/.test($(scope).className) ? $(scope) : $(scope).querySelector(`.note.${kind}`)) : scope;
    if (!el) return;
    if (html) el.innerHTML = text || ''; else el.textContent = text || '';
    el.hidden = !text;
  };
  const clearNotes = (id) => qa('.note', $(id)).forEach((n) => { n.hidden = true; n.textContent = ''; });
  const copy = async (btn, text) => {
    try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; } catch { btn.textContent = 'Failed'; }
    setTimeout(() => { btn.textContent = 'Copy'; }, 1400);
  };
  const SVG_IN = '<svg viewBox="0 0 24 24"><path d="M12 4v14M6 12l6 6 6-6"/></svg>';
  const SVG_OUT = '<svg viewBox="0 0 24 24"><path d="M12 20V6M6 12l6-6 6 6"/></svg>';
  const SVG_BRIDGE = '<svg viewBox="0 0 24 24"><path d="M4 9h14l-4-4M20 15H6l4 4"/></svg>';

  // ---------- the host ----------
  let port = null, rpcNext = 1;
  const rpcWait = new Map();
  const handlers = { event: () => {}, progress: () => {}, consent: () => {}, consentDone: () => {} };
  function connect() {
    port = chrome.runtime.connect({ name: 'wallet-ui' });
    port.onMessage.addListener((m) => {
      if (m.type) return handlers[m.type] && handlers[m.type](m);
      const w = rpcWait.get(m.id);
      if (!w) return;
      rpcWait.delete(m.id);
      if (m.error) w.reject(new Error(m.error)); else w.resolve(m.result);
    });
    port.onDisconnect.addListener(() => {
      port = null;
      for (const w of rpcWait.values()) w.reject(new Error('the wallet host went away'));
      rpcWait.clear();
    });
  }
  const host = (op, ...args) => new Promise((resolve, reject) => {
    if (!port) connect();
    const id = rpcNext++;
    rpcWait.set(id, { resolve, reject });
    port.postMessage({ id, op, args });
  });

  // the account menu's icons, drawn as the header's (stroked, round ends)
  const ICON = {
    add: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
    import: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14"/></svg>',
    rename: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
    remove: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 12h8"/></svg>',
  };

  // ---------- state ----------
  let st = null, rates = null, beamStatus = null, ethData = null, feeData = null;
  const W = () => st && st.wallets && st.wallets.find((w) => w.id === st.active);
  const acct = () => {
    const w = W();
    if (!w || !w.accounts.length) return null;
    const i = st.activeEth[w.id];
    return w.accounts.find((a) => a.i === i) || w.accounts[0];
  };
  const allAccounts = () => (st && st.wallets ? st.wallets.flatMap((w) => w.accounts.map((a) => ({ ...a, wallet: w }))) : []);
  // this wallet's Beam engine: running (all of them run while unlocked), and connected to its node

  // ---------- screens, tabs, sheets ----------
  let curTab = 'home';
  function show(id) {
    qa('.screen').forEach((s) => { s.hidden = s.id !== id; });
    const inside = id.startsWith('t-') || id.startsWith('x-');
    $('tabs').hidden = !inside;
    // adding a wallet from an open one: the way back and Settings beside the lock
    const adding = id === 's-welcome' && !!(st && st.phase === 'unlocked');
    $('setBtn').hidden = !inside && !adding;
    $('backBtn').hidden = !adding;
    $('actBar').hidden = id !== 't-activity';
    $('setBtn').classList.toggle('on', id === 't-settings');
    $('brand').hidden = inside;      // the brand on the start and lock screens only: the wallet itself has no room for it
    $('foot').hidden = !inside && id !== 's-unlock' && id !== 's-welcome';      // the copyright line: in the wallet, under the lock and the welcome
    $('walletDd').hidden = !(st && st.wallets && st.wallets.length) || !inside;
    $('lockBtn').hidden = !(st && st.phase === 'unlocked');
    window.scrollTo(0, 0); document.querySelector('main').scrollTop = 0;
  }
  function tab(name) {
    curTab = name;
    qa('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
    show(`t-${name}`);
    paint(name);
  }
  // a tab's data drawn again, the screen as it is
  function paint(name) {
    if (name === 'home') { renderBeam(); beamRefresh(); ethRefresh(); dappRefresh(); }
    if (name === 'bridge') bridgeOpen();
    if (name === 'activity') activity();
    if (name === 'settings') settingsOpen();
  }
  $('tabs').onclick = (e) => { const a = e.target.closest('a[data-tab]'); if (a) { e.preventDefault(); tab(a.dataset.tab); } };
  function sheet(name) { show(`x-${name}`); clearNotes(`x-${name}`); SHEETS[name] && SHEETS[name](); }
  document.addEventListener('click', (e) => {
    const s = e.target.closest('[data-sheet]'); if (s) return sheet(s.dataset.sheet);
    if (e.target.closest('[data-close]')) return tab('home');
    const b = e.target.closest('[data-bridge]'); if (b) { tab('bridge'); setDir(b.dataset.bridge); }
  });
  $('lockBtn').onclick = async () => { await host('lock'); };
  $('backBtn').onclick = () => tab(curTab === 'settings' ? 'settings' : 'home');
  $('setBtn').onclick = () => tab(curTab === 'settings' && !$('t-settings').hidden ? 'home' : 'settings');

  // ---------- the dialog: confirm, password, one input ----------
  let dlgBusy = Promise.resolve();
  function ask({ title, before = null, rows = [], note: n = '', password = false, passLabel = 'Wallet password', input = null, yes = 'Confirm', no = 'Cancel', html = null, check = null }) {
    const run = () => new Promise((resolve) => {
      if (before && !before()) return resolve({ ok: false, pass: '', input: '' });     // no longer asked
      $('dTitle').textContent = title;
      $('dBody').innerHTML = html != null ? html : rows.length ? `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : '';
      $('dNote').textContent = n; $('dNote').hidden = !n;
      $('dPassBox').hidden = !password; $('dPass').value = ''; $('dPassLabel').textContent = passLabel;
      $('dInputBox').hidden = !input; $('dInput').value = input ? input.value || '' : '';
      $('dInputLabel').textContent = input ? input.label : '';
      $('dInput').classList.toggle('secret', !!(input && input.secret));
      note('dErr', 'bad', '');
      $('dYes').textContent = yes; $('dNo').textContent = no; $('dNo').hidden = !no;
      $('dlg').showModal();
      (password ? $('dPass') : input ? $('dInput') : $('dYes')).focus();
      const inVal = () => (input && input.secret ? $('dInput').value : $('dInput').value.trim());
      const done = (ok) => { dlgCancel = null; $('dlg').close(); resolve({ ok, pass: $('dPass').value, input: inVal() }); $('dPass').value = ''; $('dInput').value = ''; };
      dlgCancel = () => done(false);
      // A check may answer { title, html, note }: the same dialog, still open, then shows that (a seed phrase,
      // a key) with one button. Closing a modal dialog and opening the next at once lost the popup's focus on
      // Windows, and Chrome closes a popup that loses focus.
      let shown = false;
      $('dYes').onclick = async () => {
        if (check && !shown) {
          $('dYes').disabled = true;
          let res;
          try { res = await check({ pass: $('dPass').value, input: inVal() }); }
          catch (e) { note('dErr', 'bad', msg(e)); $('dYes').disabled = false; return; }
          $('dYes').disabled = false;
          if (res && res.html != null) {
            shown = true;
            const pass = $('dPass').value;
            $('dTitle').textContent = res.title || title; $('dBody').innerHTML = res.html;
            $('dNote').textContent = res.note || ''; $('dNote').hidden = !res.note;
            $('dPassBox').hidden = true; $('dInputBox').hidden = true; $('dPass').value = pass;
            $('dYes').textContent = res.yes || 'Done'; $('dNo').hidden = true;
            // no focus moved onto the button (it showed a ring): the hidden field's focus goes to the page
            if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
            return;
          }
        }
        done(true);
      };
      $('dNo').onclick = () => done(false);
      $('dlg').oncancel = (e) => { e.preventDefault(); done(false); };
      // Enter presses the button and nothing else: its default action, left to Chrome, took the popup's focus on
      // Windows (traced 2026-11-06: blur 2 ms after Enter, before any answer), and a popup that loses it closes
      $('dPass').onkeydown = $('dInput').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); $('dYes').click(); } };
    });
    const p = dlgBusy.then(run);
    dlgBusy = p.catch(() => {});
    return p;
  }
  const confirmBox = async (title, rows, n) => (await ask({ title, rows, note: n })).ok;

  // Beam's own consent hands amounts and the fee as decimal strings already in coins ("10", "9.64504489",
  // beamAmountToUIString in wasm_beamapi.cpp), not in groth. An asset other than BEAM is named from its
  // metadata (SN=, the short name) when the wallet knows it.
  // Every asset's metadata, from the node (assets_list with refresh: get_asset_info knows only the assets
  // the wallet has already seen), once per wallet while the popup is open: asset id -> { N, SN, UN, … }
  const assetMetaP = new Map(), assetMetaDone = new Map();
  const assetMeta = (wid) => {
    if (!assetMetaP.has(wid)) {
      assetMetaP.set(wid, host('beam', wid, 'assets_list', { refresh: true })
        .then((r) => { const m = new Map(((r && r.assets) || []).map((a) => [Number(a.asset_id), a.metadata_pairs || {}])); assetMetaDone.set(wid, m); return m; })
        .catch(() => { assetMetaP.delete(wid); return new Map(); }));
    }
    return assetMetaP.get(wid);
  };
  // the short name, as Beam's DEX shows it (SN), else the unit's name (UN)
  const assetSym = (m) => (m && (m.SN || m.UN)) || '';
  const assetSymOf = async (aid) => { const w = W(), m = w ? (await assetMeta(w.id)).get(aid) : null; return assetSym(m); };
  const coins = (v) => { const t = String(v ?? '').trim(); return /^\d+(\.\d+)?$/.test(t) ? t : '—'; };
  const consentRows = async (info, amounts) => {
    // an amount by its asset's short name ("0.00003264 bETH"); each asset other than BEAM then has a row
    // of its own with its id ("Asset ID 36 (bETH)"); one the wallet cannot name: "0.5 asset 36", no row
    const rows = [], ids = [];
    for (const a of Array.isArray(amounts) ? amounts : []) {
      const aid = Number(a.assetID ?? a.asset_id ?? 0), n = aid ? await assetSymOf(aid) : 'BEAM';
      rows.push([`Wallet ${a.spend ? 'spends' : 'receives'}`, `${coins(a.amount)} ${n || `asset ${aid}`}`]);
      if (aid && n && !ids.some((x) => x[0] === aid)) ids.push([aid, n]);
    }
    for (const [aid, n] of ids) rows.push(['Asset ID', `${aid} (${n})`]);
    if (info && info.fee != null) rows.push(['Beam network fee', `${coins(info.fee)} BEAM`]);
    if (info && info.comment) rows.push(['Contract says', String(info.comment)]);
    return rows;
  };

  // The wallet asks for consent on every contract transaction with what it computed itself:
  // the amounts it moves and the fee. The bridge context (address, relayer fee) goes on top.
  // a box answered in another popup, or expired in the host (5 min), closes here too
  const consentGone = new Set();
  let consentShown = null, dlgCancel = null;
  handlers.consentDone = ({ id }) => { consentGone.add(id); if (consentShown === id && dlgCancel) dlgCancel(); };
  handlers.consent = async ({ id, info, amounts, ctx }) => {
    const c = ctx || { title: 'Contract transaction', rows: [], note: 'Not started by this wallet: reject it unless you know what it is.' };
    const rows = [...(c.rows || []), ...await consentRows(info, amounts)];
    const r = await ask({ title: c.title, rows, note: c.note, before: () => { consentShown = id; return !consentGone.has(id); } });
    consentShown = null;
    if (!consentGone.has(id)) port && port.postMessage({ type: 'consent', id, ok: r.ok });
  };

  // ---------- passwords on the start screens ----------
  // the first wallet sets the password (two fields); a further one asks for it again (one field)
  function pwFields() {
    const first = !st || st.phase === 'new';
    qa('.pw-new').forEach((d) => {
      d.innerHTML = first
        ? '<label class="field">New wallet password<input type="text" class="secret p1" autocomplete="off" autocapitalize="off" spellcheck="false"></label><label class="field">Repeat it<input type="text" class="secret p2" autocomplete="off" autocapitalize="off" spellcheck="false"></label><p class="hint">It opens this extension and encrypts the seeds and keys in it. At least 8 characters.</p>'
        : '<label class="field">Your wallet password<input type="text" class="secret p1" autocomplete="off" autocapitalize="off" spellcheck="false"></label>';
    });
  }
  function readPw(screen) {
    const d = $(screen).querySelector('.pw-new');
    const p = d.querySelector('.p1').value, p2 = d.querySelector('.p2');
    if (p2) {
      if (p.length < 8) throw new Error('use a password of 8 characters or more');
      if (p !== p2.value) throw new Error('the passwords differ');
    } else if (!p) throw new Error('type your wallet password');
    return p;
  }
  const clearPw = () => qa('.pw-new input').forEach((i) => { i.value = ''; });
  // addWallet's arguments: the first wallet sets the password, a further one proves it
  const addArgs = (o, p) => (st.phase === 'new' ? [o, p] : [{ ...o, dbPass: p }, null]);

  let progressScreen = null;
  handlers.progress = ({ wallet, step, done, total }) => {
    // a restore of a wallet that exists: its card shows it
    if (wallet && st && st.beam && st.beam[wallet]) { st.beam[wallet].progress = { step, done, total }; if (wallet === st.active) renderBeam(); return; }
    if (!progressScreen) return;
    const box = $(progressScreen).querySelector('.progress');
    box.hidden = false;
    const pc = total ? Math.floor((done / total) * 100) : 0;
    box.querySelector('i').style.width = `${pc}%`;
    box.querySelector('span').textContent = step === 'download'
      ? `downloading Beam's snapshot ${pc}% (${(done / 2 ** 20).toFixed(0)} of ${(total / 2 ** 20).toFixed(0)} MB)`
      : step === 'cached' ? 'Beam snapshot: the one downloaded lately' : `importing it ${pc}%`;
  };
  async function longOp(screen, btn, fn) {
    clearNotes(screen);
    $(btn).disabled = true;
    progressScreen = screen;
    try { await fn(); }
    catch (e) { note(screen, 'bad', msg(e)); }
    finally { $(btn).disabled = false; progressScreen = null; const pb = $(screen).querySelector('.progress'); if (pb) pb.hidden = true; }
  }

  // ---------- start: welcome / add ----------
  function welcome() {
    pwFields();
    $('welcomeTitle').textContent = st && st.phase === 'unlocked' ? 'Add a wallet' : 'Welcome';
    show('s-welcome');
  }
  qa('[data-go]').forEach((b) => { b.onclick = () => go(b.dataset.go); });
  async function go(what) {
    // choosing a file can close Chrome's popup (it loses focus to the file dialog): the backup file is
    // opened in a tab, the one step that needs it
    if (what === 'import' && !inTab) { chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?tab=1#import') }); return window.close(); }
    pwFields();
    if (what === 'create') return showPhrase(await host('newPhrase'));
    clearNotes(`s-${what}`);
    show(`s-${what}`);
  }
  qa('[data-back]').forEach((b) => { b.onclick = () => { host('dropPhrase'); if (st && st.phase === 'unlocked') tab(curTab === 'settings' ? 'settings' : 'home'); else welcome(); }; });

  let checks = [];
  function showPhrase(phrase) {
    const w = phrase.split(' ');
    $('seedWords').innerHTML = w.map((x) => `<li>${esc(x)}</li>`).join('');
    checks = [];
    while (checks.length < 3) { const i = Math.floor(Math.random() * w.length); if (!checks.includes(i)) checks.push(i); }
    checks.sort((a, b) => a - b);
    $('checkIdx').textContent = checks.map((i) => `#${i + 1}`).join(', ');
    $('seedCheck').value = '';
    clearNotes('s-create');
    show('s-create');
  }
  $('copySeed').onclick = async () => copy($('copySeed'), (await host('phrase')) || '');
  $('doCreate').onclick = () => longOp('s-create', 'doCreate', async () => {
    const w = ((await host('phrase')) || '').split(' ');
    const typed = $('seedCheck').value.trim().toLowerCase().split(/\s+/);
    if (typed.join(' ') !== checks.map((i) => w[i]).join(' ')) throw new Error('the check words do not match: look at the list again');
    const p = readPw('s-create');
    await host('addWallet', ...addArgs({ kind: 'new', name: $('cName').value }, p));
    $('seedWords').innerHTML = ''; $('cName').value = ''; clearPw();
    curTab = 'home'; await enter();
  });

  // restore: what kind of phrase it is, as it is typed
  let kindTimer = 0;
  $('rSeed').oninput = () => {
    clearTimeout(kindTimer);
    kindTimer = setTimeout(async () => {
      const p = norm($('rSeed').value);
      if (!p) { $('rKind').textContent = ''; return; }
      const k = await host('checkPhrase', p);
      $('rBeamBox').hidden = !k.beam;
      $('rKind').textContent = k.beam && k.eth ? 'A 12-word phrase: Beam and Ethereum.'
        : k.eth ? `An Ethereum phrase (${k.words} words): the Ethereum part only. Beam phrases are 12 words.`
        : k.beam ? 'A Beam phrase: Beam only.' : k.words >= 12 ? 'Not a valid phrase yet: check the words and their order.' : `${k.words} words…`;
    }, 250);
  };
  $('doRestore').onclick = () => longOp('s-restore', 'doRestore', async () => {
    const words = norm($('rSeed').value).split(' ').filter(Boolean);
    const k = await host('checkPhrase', words.join(' '));
    if (!k.beam && !k.eth) {
      const bad = [];
      for (const x of words) if (!(await host('isAllowedWord', x))) bad.push(x);
      throw new Error(bad.length ? `not seed words: ${bad.join(', ')}` : 'this is not a valid seed phrase (a word or the order is wrong)');
    }
    const p = readPw('s-restore');
    await host('addWallet', ...addArgs({ kind: 'restore', phrase: words.join(' '), beam: k.beam && $('rBeam').checked, name: $('rName').value }, p));
    $('rSeed').value = ''; $('rName').value = ''; $('rKind').textContent = ''; clearPw();
    curTab = 'home'; await enter();
  });

  $('doImport').onclick = () => longOp('s-import', 'doImport', async () => {
    const f = $('iFile').files[0];
    if (!f) throw new Error('choose the backup file');
    const p = readPw('s-import');
    const u8 = new Uint8Array(await f.arrayBuffer());
    let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    await host('addWallet', ...addArgs({ kind: 'backup', b64: btoa(s), pass: $('iPass').value, name: $('iName').value }, p));
    $('iPass').value = ''; $('iName').value = ''; $('iFile').value = ''; clearPw();
    curTab = 'home'; await enter();
  });

  $('doEthKey').onclick = () => longOp('s-ethkey', 'doEthKey', async () => {
    const key = $('kKey').value.trim();
    if (!(await host('isEthKey', key))) throw new Error('a private key is 64 hex characters (0x optional)');
    const p = readPw('s-ethkey');
    await host('addWallet', ...addArgs({ kind: 'ethkey', key, name: $('kName').value }, p));
    $('kKey').value = ''; $('kName').value = ''; clearPw();
    curTab = 'home'; await enter();
  });

  // ---------- unlock ----------
  // a form: Enter in the field or the button unlocks; the message under it is plain yellow text
  async function unlock() {
    $('unlockMsg').textContent = '';
    if (!$('uPass').value) { $('unlockMsg').textContent = 'type the password'; return $('uPass').focus(); }
    $('doUnlock').disabled = true;
    try { await host('unlock', $('uPass').value); $('uPass').value = ''; await enter(); }
    catch (e) { $('unlockMsg').textContent = unlockText(e); $('uPass').select(); }
    $('doUnlock').disabled = false;
  }
  // what the person can act on: a wrong password as it is; the two rare technical failures in plain words
  function unlockText(e) {
    const m = msg(e);
    if (/went away|not answer|no answer/i.test(m)) return 'the wallet was restarting: try again';
    if (/^storage/i.test(m)) return 'the browser could not read the wallet\'s data: close and reopen the browser, then try again';
    return m;
  }
  $('doUnlock').onclick = () => unlock();
  $('uPass').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); unlock(); } };

  // ---------- the running wallet ----------
  const walletDd = BB.dropdown($('walletDd'), async (v) => {
    if (v === '__add') { walletDd.set(st.active); return welcome(); }
    try { await host('switchWallet', v); } catch (e) { return ask({ title: 'Not switched', note: msg(e), yes: 'OK', no: null }); }
    await load(); tab('home');                      // a chosen wallet always opens on its Wallet tab
  });
  const acctDd = BB.dropdown($('acctDd'), async (v) => {
    const w = W();
    try {
      if (v === '__add') await host('addEthAccount', w.id);
      else if (v === '__import') { if (!(await importAccount(w))) return load(); }
      else if (v === '__rename') { await renameAccount(); }
      else if (v === '__remove') { await removeAccount(w); return load().then(() => { renderEth(); ethRefresh(); }); }
      else await host('setActiveEth', w.id, Number(v));
    } catch (e) { await ask({ title: 'Not added', note: msg(e), yes: 'OK', no: null }); }
    await load(); renderEth(); ethRefresh();
  });
  // an account from another phrase or a private key, into this wallet
  async function importAccount(w) {
    const r = await ask({ title: `Import an account into ${w.name}`, input: { label: 'A private key (64 hex) or a seed phrase (its first account)', secret: true }, yes: 'Import',
      note: 'For an account you already have in MetaMask, Rabby or another wallet. It is kept encrypted here like the rest.',
      check: async ({ input }) => {
        const isKey = await host('isEthKey', input);
        if (!isKey && !(await host('checkPhrase', input)).eth) throw new Error('neither a BIP-39 phrase nor a 64-hex private key');
        await host('importEthAccount', w.id, isKey ? { key: input } : { phrase: input });
      } });
    return r.ok;
  }
  // remove the account shown: a phrase account comes back with "+ Add an account", an imported one only
  // from its own key or phrase; a balance on it is said first
  async function removeAccount(w) {
    const a = acct();
    if (!a) return;
    if (w.accounts.length < 2) return ask({ title: 'The last account stays', note: 'A wallet keeps at least one Ethereum account. To remove the whole wallet: Settings → Wallets → remove.', yes: 'OK', no: null });
    const rows = [['Account', `${a.name} ${a.address}`]];
    if (ethData && ethFor === a.address) {
      const held = [`${num(units(ethData.eth, 18), 6)} ETH`, ...ethData.tokens.filter((t) => units(t.balance, t.decimals) > 0).map((t) => `${num(units(t.balance, t.decimals), 4)} ${t.symbol}`)].filter((x) => !/^0 ETH$/.test(x));
      if (held.length) rows.push(['On it now', held.join(', ')]);
    }
    const imported = a.kind === 'key' || a.kind === 'phrase';
    await ask({ title: 'Remove this account', rows, password: true, yes: 'Remove',
      note: imported
        ? 'Imported: its key is deleted from this extension. Only your own copy of the key or phrase brings it back, and whatever is on the address stays there on Ethereum.'
        : 'From this wallet\'s phrase: it only leaves the list. "+ Add an account" brings the same address back. Whatever is on it stays there on Ethereum.',
      check: async ({ pass }) => { await host('removeEthAccount', w.id, a.i, pass); } });
  }

  // rename the account shown
  async function renameAccount() {
    const w = W(), a = acct();
    if (!a) return;
    const r = await ask({ title: 'Rename the account', input: { label: 'Name', value: a.name }, yes: 'Save' });
    if (!r.ok || !r.input) return;
    try { await host('renameEthAccount', w.id, a.i, r.input); } catch (e) { return ask({ title: 'Not renamed', note: msg(e), yes: 'OK', no: null }); }
    await load(); ethRefresh();
  }

  async function load() {
    st = await host('state');
    if (st.phase !== 'unlocked') return st;
    walletDd.options([...st.wallets.map((w) => ({ v: w.id, label: w.name })), { group: ' ' }, { v: '__add', label: '+ Add a wallet' }], st.active);
    const w = W();
    $('teFrom').textContent = $('feTo').textContent = w ? w.name : 'Beam';
    if (w && w.accounts.length) {
      const a = acct();
      // the accounts: the name on the left (cut with … if long), the address on the right; a line; then what
      // can be done, each with its icon in a column of its own so the words line up
      const six = (x) => `${x.slice(0, 8)}…${x.slice(-6)}`;
      const act = (v, icon, text) => ({ v, label: text, html: `<span class="mi">${icon}</span><span>${esc(text)}</span>` });
      acctDd.options([...w.accounts.map((x) => ({ v: String(x.i), label: `${x.name} ${six(x.address)}`, html: `<span class="nm">${esc(x.name)}</span><span class="ad">${six(x.address)}</span>`,
        btn: `<span class="acc-b"><span class="nm">${esc(x.name)}</span><span class="ad">${six(x.address)}</span></span>` })),
        { sep: true },
        ...(w.hd ? [act('__add', ICON.add, 'Add an account')] : []), act('__import', ICON.import, 'Import an account'),
        act('__rename', ICON.rename, 'Rename this account'), ...(w.accounts.length > 1 ? [act('__remove', ICON.remove, 'Remove this account')] : [])], String(a.i));
      // the accounts in a box of their own that scrolls past 4, inside the list; the actions stay below it
      const list = $('acctDd').querySelector('.dd-list');
      const rows = [...list.querySelectorAll(':scope > [role="option"]')].filter((li) => !li.dataset.v.startsWith('__'));
      const box = document.createElement('li'), ul = document.createElement('ul');
      box.className = 'dd-scroll'; box.setAttribute('role', 'presentation'); ul.setAttribute('role', 'group');
      rows.forEach((li) => ul.appendChild(li));
      box.appendChild(ul); list.insertBefore(box, list.firstChild);
    }
    return st;
  }

  async function enter() {
    await load();
    if (st.phase !== 'unlocked') return route();
    if (inWin) return dappScreen();
    tab(curTab);
    priceTick();
  }

  // Events change data, never the screen: what is shown is drawn again from the new state; a sheet with a
  // form being filled stays as it is.
  handlers.event = (m) => {
    const here = st && st.active && m.wallet === st.active;
    switch (m.method) {
      case 'bb_changed':                              // wallets added, removed, renamed
        if (progressScreen === 's-progress') { progressScreen = null; route(); }
        else if (progressScreen) break;
        else if (!$('tabs').hidden) load().then(() => (st.phase === 'unlocked' ? (curTab && !$(`t-${curTab}`).hidden ? paint(curTab) : null) : route()));
        else if (!$('s-boot').hidden || !$('s-unlock').hidden) route();
        break;
      case 'bb_wallet': case 'bb_net': {              // a wallet's Beam part changed status, or its node; or a switch
        const before = st && st.active, acctBefore = acct() && acct().address;
        if (st && st.phase === 'unlocked') load().then(() => {
          const switched = st.active !== before || (acct() && acct().address) !== acctBefore;
          if (switched || m.wallet === st.active) { renderBeam(); renderEth(); if (curTab === 'home') { beamSoon(); if (switched) ethRefresh(); } }
          if (curTab === 'settings' && !$('t-settings').hidden) settingsOpen();
        });
        break;
      }
      case 'bb_failed': if (progressScreen === 's-progress') note('s-progress', 'bad', m.result); break;
      case 'bb_locked': st = null; route(); break;
      case 'bb_error': if (!$('tabs').hidden) note('bErr', 'bad', m.result); break;
      case 'bb_bridge': if (curTab === 'bridge') bridgeLists(); break;
      case 'bb_dapp': if (inWin && st && st.phase === 'unlocked') dappScreen(); else dappRefresh(); break;
      case 'ev_sync_progress':
        if (m.wallet && st && st.beam && st.beam[m.wallet]) { st.beam[m.wallet].sync = m.result && m.result.total ? { done: m.result.done, total: m.result.total } : null; if (here) renderBeam(); }
        break;
      case 'ev_system_state': case 'ev_utxos_changed': if (here) beamSoon(); break;
      case 'ev_txs_changed': if (here) { beamSoon(); if (curTab === 'activity') activity(); } break;
    }
  };
  // a network's state on its card: the dot by its name (its colour: live; yellow: starting, syncing,
  // reconnecting; red: missing, not running, disconnected, no RPC) with the state in its tip
  function netDot(id, state, tip) { const d = $(id); d.classList.toggle('warn', state === 'warn'); d.classList.toggle('down', state === 'down'); d.title = tip || ''; }
  // Beam's corner: always two lines. The first, grey: what there is (block: N, at: N, the restore's step, a
  // link); the second, under it in the same place every time: the state, yellow (warn) or red (bad), or grey
  // (backup). An empty line keeps its room, so the second never moves.
  function beamMeta(first, state = '', cls = '', tip = '') {
    const m = $('beamMeta');
    m.innerHTML = `<span class="l1">${first || '&nbsp;'}</span><span class="l2 ${cls}">${state || '&nbsp;'}</span>`;
    m.title = tip;
  }
  const blockAt = (h) => `block: <b>${esc((h || 0).toLocaleString('en-US'))}</b>`;
  const share = (d, t) => (t ? Math.min(100, Math.floor((d / t) * 100)) : 0);

  // ---------- Wallet tab: Beam ----------
  // Per wallet, by its id: its last wallet_status (never shown for another wallet), when its node was lost,
  // whether it was ever connected since the popup opened. The host's state (st.beam[id]) says the rest.
  const beamView = new Map();                         // id -> { s, seq, lostAt, seen }
  const view = (id) => { if (!beamView.has(id)) beamView.set(id, { s: null, seq: 0, lostAt: 0, seen: false }); return beamView.get(id); };
  const beamOf = (w) => (w && st && st.beam ? st.beam[w.id] : null);
  const beamHere = () => { const b = beamOf(W()); return !!(b && b.status === 'running'); };
  // its wallet_status, asked once for many events in a row; an answer older than the last one asked is dropped
  let beamTimer = 0;
  function beamSoon() { clearTimeout(beamTimer); beamTimer = setTimeout(beamRefresh, 250); }
  async function beamRefresh() {
    const w = W();
    if (!w || !beamHere()) return renderBeam();
    const v = view(w.id), seq = ++v.seq;
    try {
      // The balance is BEAM's line of `totals` (asset 0): its sums count regular coins and those of the
      // shielded pool (offline, public, max privacy). The top-level fields count regular coins only.
      const raw = await host('beam', w.id, 'wallet_status');
      if (seq !== v.seq) return;
      const t = (raw.totals || []).find((x) => Number(x.asset_id) === 0);
      v.s = t ? { ...raw, available: t.available, receiving: t.receiving, sending: t.sending, maturing: t.maturing,
        maturing_mp: t.maturing_mp || 0, maturing_regular: t.maturing_regular || 0, available_mp: t.available_mp || 0 } : raw;
    } catch { if (seq !== v.seq) return; }
    renderBeam();
  }

  // The Beam card, drawn only from the active wallet's own data: the host's status for it and its own last
  // wallet_status. Every field is written each time, so nothing of another wallet can stay on it.
  function renderBeam() {
    const w = W(), b = beamOf(w);
    $('beamBody').hidden = !(w && w.beam); $('beamNone').hidden = !!(w && w.beam);
    const v = w ? view(w.id) : null, s = b && b.status === 'running' && v ? v.s : null;
    beamStatus = s;
    $('beamCard').classList.toggle('nodata', !s);
    $('beamAvail').textContent = s ? amt(s.available || 0) : '';
    $('beamUsd').textContent = s && rates ? usd((s.available || 0) / GROTH * rates.beam) : '';
    $('beamMinor').innerHTML = s ? chips(s) : '';
    if (!(w && w.beam)) beamTokens(false, true); else beamRows();
    if (s && w && (s.totals || []).some((t) => Number(t.asset_id) !== 0 && t.available)) { assetMeta(w.id); beamPricesLoad(w.id); }
    total();
    if (!w || !w.beam || !b) { $('beamMeta').innerHTML = ''; netDot('beamDot', '', ''); return; }
    const restore = '<a href="#" class="text-link" data-go-restore>restore</a>';
    switch (b.status) {
      case 'missing': beamMeta(restore, 'database missing', 'bad'); return netDot('beamDot', 'down', '');
      case 'failed': beamMeta('', 'not running', 'bad'); return netDot('beamDot', 'down', '');
      case 'restoring': {
        const p = b.progress;
        beamMeta(p ? (p.step === 'import' ? 'importing wallet' : 'downloading the snapshot') : '', `restoring${p && p.total ? ` ${share(p.done, p.total)}%` : '…'}`, 'warn');
        return netDot('beamDot', 'warn', '');
      }
      case 'running': break;
      case 'stopped': if (b.reason === 'paused') { beamMeta('while another wallet restores', 'paused', 'warn'); return netDot('beamDot', 'warn', ''); }
      // falls through: stopped (in the queue), starting, stopping
      default: beamMeta('', 'starting…', 'warn'); return netDot('beamDot', 'warn', '');
    }
    const h = s && s.current_height ? s.current_height : 0;
    // no node: connecting (never connected yet), reconnecting (lost, first minute), disconnected (after it)
    if (!b.connected) v.lostAt ||= Date.now(); else { v.lostAt = 0; v.seen = true; }
    const node = b.node || st.node;
    if (v.lostAt && Date.now() - v.lostAt > 60000) { beamMeta(h ? blockAt(h) : '', 'disconnected', 'bad'); return netDot('beamDot', 'down', ''); }
    if (v.lostAt) { beamMeta(h ? blockAt(h) : '', v.seen ? 'reconnecting' : 'connecting', 'warn'); return netDot('beamDot', 'warn', ''); }
    // syncing: its % from the sync's own progress, else the word; the block once the wallet has one
    if (b.sync && b.sync.total && b.sync.done < b.sync.total) { beamMeta(h ? blockAt(h).replace('block:', 'at:') : '', `syncing ${share(b.sync.done, b.sync.total)}%`, 'warn'); return netDot('beamDot', 'warn', ''); }
    if (!s || !h || s.is_in_sync === false) { beamMeta(h ? blockAt(h) : '', 'syncing…', 'warn'); return netDot('beamDot', 'warn', ''); }
    beamMeta(blockAt(h));
    netDot('beamDot', '', '');
  }
  $('beamMeta').onclick = (e) => { if (e.target.closest('[data-go-restore]')) { e.preventDefault(); tab('settings'); } };

  // what is not spendable yet, as chips in the explorer's way: one colour per state
  // what is not spendable yet, as chips in the explorer's way: one colour per state, "name: amount" (to the
  // hundredth), what each is in its tip; the line scrolls when they do not fit
  function chips(s) {
    const two = (g) => (g / GROTH).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const chip = (cls, text, tip) => `<span class="badge ${cls} chip" title="${esc(tip)}">${text}</span>`;
    const MATURING = 'Maturing: not spendable yet. Mostly a mined block\'s reward, which Beam releases 240 blocks (about 4 hours) after its block';
    const out = [];
    if (s.receiving) out.push(chip('ok', `incoming: +${two(s.receiving)}`, 'Incoming: a transfer to this wallet still being made. It joins the balance once a block confirms it. To a regular address, this wallet must stay open and unlocked until then'));
    if (s.sending) out.push(chip('pending', `outgoing: −${two(s.sending)}`, 'Outgoing: a transfer from this wallet not in a block yet. While the receiver has not answered, it can be cancelled under Activity'));
    if (s.maturing_regular) out.push(chip('info', `maturing: ${two(s.maturing_regular)}`, MATURING));
    // max privacy coins wait for the pool to grow, or 72 h at most (Beam's MaxPrivacyLockTimeLimitHours)
    if (s.maturing_mp) out.push(chip('solo', `max privacy ≤72h: ${two(s.maturing_mp)}`, 'Max privacy: received through the shielded pool. Beam unlocks them once enough other coins have joined the pool after them, or 72 hours after they arrived at the latest'));
    else if (s.maturing && !s.maturing_regular) out.push(chip('info', `maturing: ${two(s.maturing)}`, MATURING));
    return out.join('');
  }

  // ---------- Wallet tab: Ethereum ----------
  const CPI = $('ethCopy').innerHTML;                 // the copy icon (two sheets), as in 3BMiner
  // Per address: its last balances and whether the last read failed; the card shows only the shown account's
  // own (nothing of another account or wallet), or "syncing…" until they come.
  const ethView = new Map();                          // address -> { d, err, seq }
  const eview = (addr) => { if (!ethView.has(addr)) ethView.set(addr, { d: null, err: '', seq: 0 }); return ethView.get(addr); };
  let ethFor = null;
  async function ethRefresh() {
    const a = acct();
    renderEth();
    if (!a) return;
    const v = eview(a.address), seq = ++v.seq;
    try { const d = await host('ethBalances', a.address); if (seq !== v.seq) return; v.d = d; v.err = ''; }
    catch (e) { if (seq !== v.seq) return; v.err = msg(e); }
    renderEth();
  }
  function renderEth() {
    const a = acct();
    $('ethBody').hidden = !a; $('ethNone').hidden = !!a; $('acctDd').hidden = !a;
    ethFor = a ? a.address : null;
    const v = a ? eview(a.address) : null;
    ethData = v && v.d ? v.d : null;
    if (a) {
      $('ethAddr').textContent = a.address;
      if (ethData) ethRows();
      else $('ethAssets').innerHTML = v.err ? `<div class="empty">no Ethereum RPC answers: ${esc(v.err)}</div>` : '<div class="empty">syncing…</div>';
      netDot('ethDot', v.err ? 'down' : '', v.err ? `Ethereum: no RPC answers (${v.err})${ethData ? '; the balances shown may be old' : ''}` : '');
    }
    total();
  }
  // the Ethereum card's rows from the last balances, at the current prices: drawn again when prices come
  // (the balances can arrive first, and their dollars stayed empty)
  // ETH and WBEAM first, always; then the tokens worth $1 or more (dearest first); the others (cheaper, or
  // with no price: mostly airdropped junk) only after "load low-value tokens", until another account is shown.
  // Each token: a link to its contract on Etherscan and a button that copies the contract's address.
  let ethShowLow = null;                              // the address whose low-value tokens are shown
  const LINK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2h5v5M14 2 7.5 8.5M12 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function ethRows() {
    const d = ethData;
    if (!d) return;
    const wb = st.contracts.wbeam;
    const val = (t) => (t.address.toLowerCase() === wb ? (rates ? units(t.balance, 8) * (rates.wbeam || rates.beam) : null) : t.usd != null ? units(t.balance, t.decimals) * t.usd : null);
    const rows = [{ sym: 'ETH', v: units(d.eth, 18), u: rates ? units(d.eth, 18) * rates.eth : null, addr: null }];
    const w = d.tokens.find((t) => t.address.toLowerCase() === wb);
    if (w) rows.push({ sym: w.symbol, v: units(w.balance, w.decimals), u: val(w), addr: w.address });
    const rest = d.tokens.filter((t) => t !== w).map((t) => ({ sym: t.symbol, v: t.balance == null ? NaN : units(t.balance, t.decimals), u: val(t), addr: t.address }))
      .sort((x, y) => (y.u || 0) - (x.u || 0));
    const high = rest.filter((r) => r.u != null && r.u >= 1), low = rest.filter((r) => !(r.u != null && r.u >= 1));
    const showLow = ethShowLow === ethFor;
    // ETH (no contract) as Beam's balance: the amount, then its symbol, from the left edge
    const row = (r) => (!r.addr ? `<div class="asset native"><span class="lead"><span class="amt">${num(r.v)}</span><span class="unit">${esc(r.sym)}</span></span><span class="usd">${usd(r.u)}</span></div>` : `<div class="asset"><span class="tok">${r.addr ? `<a class="cp" href="https://etherscan.io/token/${esc(r.addr)}" target="_blank" rel="noopener" title="Open on Etherscan">${LINK}</a><button type="button" class="cp" data-cp="${esc(r.addr)}" data-tip-wide title="Copy the token's contract address
${esc(r.addr)}">${CPI}</button>` : ''}</span><span class="sym">${esc(r.sym)}</span><span class="amt">${num(r.v)}</span><span class="usd">${usd(r.u)}</span></div>`);
    $('ethAssets').innerHTML = [...rows, ...high, ...(showLow ? low : [])].map(row).join('')
      + (low.length && !showLow ? `<div class="more"><button type="button" class="btn ghost small" data-more>load low-value tokens (${low.length})</button></div>` : '');
  }
  $('ethAssets').onclick = (e) => {
    const c = e.target.closest('[data-cp]');
    if (c) return copyFlash(c, c.dataset.cp);
    if (e.target.closest('[data-more]')) { ethShowLow = ethFor; ethRows(); }
  };
  // the address's copy button: a tick for 2 s once copied (as in 3BMiner)
  const OKI = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function copyFlash(btn, text) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      btn.innerHTML = OKI; btn.classList.add('done');
      clearTimeout(btn._t); btn._t = setTimeout(() => { btn.innerHTML = CPI; btn.classList.remove('done'); }, 2000);
    }).catch(() => {});
  }
  $('ethCopy').onclick = () => copyFlash($('ethCopy'), $('ethAddr').textContent);

  // ---------- Beam's tokens ----------
  // "Tokens" grows the Beam card down over the Ethereum one: its bottom edge on Ethereum's, to the pixel.
  // BEAM's line and its chips stay where they are; the list comes under them, the buttons go to the bottom.
  // The Ethereum card stays in its place underneath (the Beam card's bottom margin takes back what it grows),
  // faded out. Each token as on Ethereum: its page in the explorer, a button that copies its asset id, its
  // short name, the amount available.
  let beamTok = false, beamH0 = 0, beamMb0 = 0, beamTokT = 0;
  function beamFit() {
    if (!beamTok) return;
    const c = $('beamCard'), H = $('ethCard').getBoundingClientRect().bottom - c.getBoundingClientRect().top;
    c.style.height = `${H}px`; c.style.marginBottom = `${beamMb0 - (H - beamH0)}px`;
  }
  function beamTokens(on, now) {
    const c = $('beamCard'), b = $('beamTokBtn');
    if (on === beamTok) return;
    clearTimeout(beamTokT);
    // no scroll bar while the card moves (the list is shorter than its rows until the end); after it, one
    // only when the tokens do not all fit
    c.classList.add('moving');
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
    $('ethCard').classList.toggle('under', on);
    if (on) {
      if (!c.classList.contains('tok')) {
        beamH0 = c.getBoundingClientRect().height; beamMb0 = parseFloat(getComputedStyle(c).marginBottom) || 0;
        c.style.height = `${beamH0}px`; c.style.marginBottom = `${beamMb0}px`;
        c.classList.add('tok'); $('beamAssets').hidden = false;
        void c.offsetHeight;                         // the start of the transition
      }
      beamTok = true; beamFit(); beamRows();
      // once fully out, the button says what it does now
      beamTokT = setTimeout(() => { c.classList.remove('moving'); b.textContent = 'Collapse'; }, 260);
    } else {
      beamTok = false;
      c.style.height = `${beamH0}px`; c.style.marginBottom = `${beamMb0}px`;
      const end = () => { if (beamTok) return; b.textContent = 'Tokens'; c.classList.remove('tok', 'moving'); $('beamAssets').hidden = true; c.style.height = ''; c.style.marginBottom = ''; };
      if (now) end(); else beamTokT = setTimeout(end, 260);
    }
  }
  $('beamTokBtn').onclick = () => beamTokens(!beamTok);
  new ResizeObserver(() => beamFit()).observe($('ethCard'));
  let beamRowsSeq = 0;
  async function beamRows() {
    if (!beamTok) return;
    const w = W(), s = beamStatus, seq = ++beamRowsSeq;
    if (!s) { $('beamAssets').innerHTML = '<div class="empty">syncing…</div>'; return; }
    const list = (s.totals || []).filter((t) => Number(t.asset_id) !== 0 && (t.available || t.receiving || t.maturing))
      .sort((x, y) => Number(x.asset_id) - Number(y.asset_id));
    if (!list.length) { $('beamAssets').innerHTML = '<div class="empty">no tokens in this wallet</div>'; return; }
    // the rows at once (named from what is known), again once the names come from the node
    const known = w && assetMetaDone.get(w.id);
    const draw = (meta) => { $('beamAssets').innerHTML = list.map((t) => {
      const aid = Number(t.asset_id), sym = assetSym(meta.get(aid)) || `asset ${aid}`;
      return `<div class="asset"><span class="tok"><a class="cp" href="https://explorer.bumblebeam.org/asset/${aid}" target="_blank" rel="noopener" title="Open in the explorer">${LINK}</a><button type="button" class="cp" data-cp="${aid}" title="Copy the asset id
${aid}">${CPI}</button></span><span class="sym">${esc(sym)}</span><span class="amt">${num((t.available || 0) / GROTH)}</span><span class="usd">${usd(beamTokUsd(aid, t.available))}</span></div>`;
    }).join(''); };
    draw(known || new Map());
    if (!w) return;
    let meta = known;
    if (!known) { meta = await assetMeta(w.id); if (seq === beamRowsSeq && beamTok) draw(meta); }
    if (beamPricesFresh(w.id)) return;
    await beamPricesLoad(w.id);
    if (seq === beamRowsSeq && beamTok) draw(meta || new Map());
  }
  // the tokens' dollars: their price in BEAM from Beam DEX's pools (the host's beamPrices), times BEAM's
  let beamPx = { wid: null, at: 0, p: {} }, beamPxP = null;
  const beamPricesFresh = (wid) => beamPx.wid === wid && Date.now() - beamPx.at < 60000;
  function beamPricesLoad(wid) {
    if (beamPricesFresh(wid)) return Promise.resolve();
    if (!beamPxP) beamPxP = host('beamPrices', wid).then((p) => { beamPx = { wid, at: Date.now(), p: p || {} }; total(); }, () => {}).finally(() => { beamPxP = null; });
    return beamPxP;
  }
  const beamTokUsd = (aid, groth) => { const w = W(), px = w && beamPx.wid === w.id ? beamPx.p[aid] : undefined; return rates && px > 0 ? ((groth || 0) / GROTH) * px * rates.beam : null; };
  $('beamAssets').onclick = (e) => { const c = e.target.closest('[data-cp]'); if (c) copyFlash(c, c.dataset.cp); };

  function total() {
    if (!rates) { $('totalUsd').textContent = '—'; $('totalCh').textContent = ''; return; }
    // t: now; t0: the same holdings at the prices of 24 h ago (an asset with no 24 h change counts unchanged)
    let t = 0, t0 = 0;
    const ch = rates.ch || {};
    const add = (usdNow, pct) => { t += usdNow; t0 += isFinite(pct) ? usdNow / (1 + pct / 100) : usdNow; };
    // BEAM: available and maturing (still the wallet's own: max privacy coins unlock within 72 h)
    if (beamStatus) { const b = ((beamStatus.available || 0) + (beamStatus.maturing || 0)) / GROTH; add(b * rates.beam, ch.beam); }
    // Beam's tokens priced by Beam DEX (in BEAM): with BEAM's 24 h change, their price follows it
    if (beamStatus) for (const x of beamStatus.totals || []) { const v = Number(x.asset_id) ? beamTokUsd(Number(x.asset_id), x.available) : null; if (v > 0) add(v, ch.beam); }
    if (ethData) {
      add(units(ethData.eth, 18) * rates.eth, ch.eth);
      for (const x of ethData.tokens) {
        const v = units(x.balance, x.decimals);
        if (!(v > 0)) continue;
        if (x.address.toLowerCase() === st.contracts.wbeam) add(v * (rates.wbeam || rates.beam), ch.wbeam);
        else if (x.usd) add(v * x.usd, NaN);
      }
    }
    $('totalUsd').textContent = usd(t);
    // the 24 h change of the total in %: −0.73% 24h; none without prices or a balance
    const d = t - t0, pc = t0 > 0 ? (d / t0) * 100 : 0;
    $('totalCh').textContent = rates.ch && t >= 0.01 ? `${pc < 0 ? '−' : '+'}${Math.abs(pc).toFixed(2)}% 24h` : '';
  }
  async function priceTick() {
    try {
      rates = await host('rates'); total(); ethRows();
      if (beamStatus) $('beamUsd').textContent = usd((beamStatus.available || 0) / GROTH * rates.beam);
    } catch {}
  }

  $('ethAddNew').onclick = async () => {
    const w = W();
    const r = await ask({ title: 'Create Ethereum accounts', note: 'A new Ethereum seed phrase for this wallet. It is shown once now: write it down. Settings → Wallets shows it again with the password.', yes: 'Create' });
    if (!r.ok) return;
    let phrase;
    try { phrase = await host('addEthPart', w.id, { kind: 'new' }); }
    catch (e) { return ask({ title: 'Not created', note: msg(e), yes: 'OK', no: null }); }
    await load(); ethRefresh();
    if (phrase) await ask({ title: 'Your Ethereum seed phrase', html: `<ol class="seed">${phrase.split(' ').map((x) => `<li>${esc(x)}</li>`).join('')}</ol>`, note: 'It restores this wallet\'s Ethereum accounts here, in MetaMask or Rabby. The Beam part has its own phrase (or backup file).', yes: 'Written down', no: null });
  };
  $('ethAddImport').onclick = async () => {
    const w = W();
    const r = await ask({ title: 'Import into this wallet', input: { label: 'An Ethereum seed phrase (12 or 24 words) or a private key', secret: true }, yes: 'Import',
      check: async ({ input }) => { if (!(await host('isEthKey', input)) && !(await host('checkPhrase', input)).eth) throw new Error('neither a BIP-39 phrase nor a 64-hex private key'); } });
    if (!r.ok) return;
    try {
      const isKey = await host('isEthKey', r.input);
      await host('addEthPart', w.id, isKey ? { kind: 'key', key: r.input } : { kind: 'phrase', phrase: r.input });
    } catch (e) { return ask({ title: 'Not imported', note: msg(e), yes: 'OK', no: null }); }
    await load(); ethRefresh();
  };

  // ---------- sheets ----------
  let addrType = 'regular';
  const ADDR_HINT = {
    regular: 'Give it to the sender. Online while this wallet is the open one and unlocked. The transfer completes while both wallets are online. The popup may be closed.',
    offline: 'Takes payments while this wallet is off, up to 10 (one-time vouchers inside the address); the sender pays 0.011 BEAM and the coins arrive shielded. For many payments use Public.',
    max_privacy: 'One payment, maximum anonymity (the shielded pool). The coins mature over a while before they can be spent.',
    public_offline: 'A public offline address: any number of payments, the wallet need not run (for a pool\'s payouts, an exchange, donations). The sender pays 0.011 BEAM; the coins arrive shielded and mature for a while. Less private than the others: all payments go to one public key.',
  };
  // Receive shows the newest address of the chosen type (made once if there is none); "New address" makes
  // another. "My addresses" lists every address this wallet made, with the payments that came in to each
  // (tx_list joined on the address: Beam's chain has no addresses, so the wallet's own records are all there is).
  const TYPE_NAME = { regular: 'Regular', regular_new: 'Regular', offline: 'Offline', max_privacy: 'Max privacy', public_offline: 'Public' };
  let addrs = [], shownAddr = null;
  async function loadAddrs() {
    const [list, txs] = await Promise.all([host('beam', W().id, 'addr_list', { own: true }), host('beam', W().id, 'tx_list', { count: 1000 }).catch(() => [])]);
    const got = new Map();
    for (const t of txs) {
      if (!t.income) continue;
      for (const k of [t.receiver, t.token, t.address, t.receiver_identity]) {
        if (!k) continue;
        const g = got.get(k) || { n: 0, sum: 0 };
        if (t.status === 3) { g.n++; g.sum += t.value || 0; }
        got.set(k, g);
      }
    }
    const txText = txs.map((t) => JSON.stringify(t));
    addrs = list.map((x) => {
      const g = got.get(x.address) || (x.identity && got.get(x.identity)) || { n: 0, sum: 0 };
      // any transaction at all (in or out, finished or not) that names this address or its identity
      const touched = txText.some((j) => j.includes(x.address) || (x.identity && j.includes(x.identity)));
      return { ...x, n: g.n, sum: g.sum, touched: touched || g.n > 0 };
    }).sort((p1, p2) => (p2.create_time || 0) - (p1.create_time || 0));
    renderAddrs();
  }
  const sameType = (x, type) => x.type === type || (type === 'regular' && x.type === 'regular_new');
  const ago2 = (sec) => (sec ? fdate(sec * 1000) : '');
  const expiry = (x) => (x.expired ? 'expired' : !x.duration ? 'no expiry' : `until ${fdate((x.create_time + x.duration) * 1000)}`);
  function renderAddrs() {
    $('addrCount').textContent = `${addrs.length}`;
    $('addrList').innerHTML = addrs.map((x, k) => `<div class="li addr${x.address === shownAddr ? ' on' : ''}" data-k="${k}">
      <span class="badge ${x.expired ? 'bad' : 'ok'}">${esc(TYPE_NAME[x.type] || x.type)}</span>
      <span class="what">${esc(x.comment || short(x.address))}<span class="sub">${x.comment ? esc(short(x.address)) + ' · ' : ''}${esc(ago2(x.create_time))} · ${esc(expiry(x))}</span></span>
      <span class="amt ${x.n ? 'pos' : ''}">${x.n ? `${x.n} in · ${amt(x.sum, 2)}` : 'unused'}</span></div>`).join('') || '<div class="empty">none yet</div>';
  }
  function showAddr(x) {
    shownAddr = x.address;
    $('beamAddr').textContent = x.address; $('beamQrWrap').hidden = false;
    $('beamAddrMeta').innerHTML = `<b>${esc(x.comment || 'no name')}</b> · ${esc(TYPE_NAME[x.type] || x.type)} · ${esc(expiry(x))}${x.n ? ` · ${x.n} payment(s) in` : ''}`;
    $('beamQr').innerHTML = '';
    new QRCode($('beamQr'), { text: x.address, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.L });
    renderAddrs();
  }
  async function newAddress(type) {
    const a = await host('beam', W().id, 'create_address', { type, expiration: type === 'public_offline' ? 'never' : 'auto', comment: '' });
    await loadAddrs();
    showAddr(addrs.find((x) => x.address === a) || { address: a, type, comment: '', create_time: Date.now() / 1000, duration: 0, n: 0 });
  }
  async function showType(type, fresh = false) {
    note('x-beamRecv', 'bad', '');
    $('addrHint').textContent = ADDR_HINT[type];
    try {
      if (!fresh) {
        await loadAddrs();
        const have = addrs.find((x) => sameType(x, type) && !x.expired);
        if (have) return showAddr(have);
      }
      await newAddress(type);
    } catch (e) { note('x-beamRecv', 'bad', msg(e)); }
  }
  $('addrType').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    qa('#addrType button').forEach((x) => x.classList.toggle('on', x === b));
    addrType = b.dataset.t; showType(addrType);
  };
  $('newBeamAddr').onclick = () => showType(addrType, true);
  $('nameBeamAddr').onclick = async () => {
    const x = addrs.find((y) => y.address === shownAddr);
    if (!x) return;
    const r = await ask({ title: 'Name the address', input: { label: 'Who it was given to (only you see it)', value: x.comment || '' }, yes: 'Save' });
    if (!r.ok) return;
    try { await host('beam', W().id, 'edit_address', { address: x.address, comment: r.input }); await loadAddrs(); showAddr(addrs.find((y) => y.address === x.address) || x); }
    catch (e) { note('x-beamRecv', 'bad', msg(e)); }
  };
  // Remove unused: only addresses with no transaction of any kind, no name, and not the one the other
  // wallets send to. A removed address stops taking payments, so the dialog says how many go and stay.
  $('addrClean').onclick = async () => {
    note('x-beamRecv', 'bad', '');
    try {
      await loadAddrs();
      const own = (W() && W().beamAddress) || '';
      // a name you gave, not one the wallet wrote itself ("regular 2026-11-05", "wallet offline", "default",
      // "for my other wallets", "probe")
      const AUTO = /^(?:(?:regular|offline|max_privacy|public_offline) \d{4}-\d{2}-\d{2}|wallet (?:regular|offline)|default|for my other wallets|probe)?$/;
      const named = (x) => !AUTO.test(String(x.comment || '').trim());
      const keep = (x) => x.touched || named(x) || x.address === own;
      const gone = addrs.filter((x) => !keep(x));
      if (!gone.length) return ask({ title: 'Nothing to remove', note: 'Every address here has a transaction, a name, or is the one your other wallets send to.', yes: 'OK', no: null });
      const ok = await confirmBox('Remove unused addresses', [['Removed', String(gone.length)], ['Kept', `${addrs.length - gone.length} (with a transaction, a name, or for your other wallets)`]],
        'A removed address stops taking payments. If you gave one of these to someone and still expect coins on it, name it first (Name it): named ones stay. Coins already received are not affected.');
      if (!ok) return;
      let n = 0;
      for (const x of gone) { try { await host('beam', W().id, 'delete_address', { address: x.address }); n++; } catch {} }
      if (gone.some((x) => x.address === shownAddr)) shownAddr = null;
      await loadAddrs();
      if (!shownAddr) await showType(addrType); else renderAddrs();
      await ask({ title: 'Done', note: `${n} removed, ${addrs.length} left.`, yes: 'OK', no: null });
    } catch (e) { note('x-beamRecv', 'bad', msg(e)); }
  };
  $('addrList').onclick = (e) => {
    const row = e.target.closest('[data-k]'); if (!row) return;
    const x = addrs[Number(row.dataset.k)];
    if (!x) return;
    addrType = Object.keys(ADDR_HINT).find((t) => sameType(x, t)) || addrType;
    qa('#addrType button').forEach((b) => b.classList.toggle('on', b.dataset.t === addrType));
    $('addrHint').textContent = ADDR_HINT[addrType] || '';
    showAddr(x);
    $('beamQrWrap').scrollIntoView({ block: 'nearest' });
  };
  $('copyBeamAddr').onclick = () => copy($('copyBeamAddr'), $('beamAddr').textContent);

  // my other Beam wallets as receivers: the offline address each keeps for this (made once it has run)
  const bsOwn = BB.dropdown($('bsOwn'), (v) => { if (v) { $('bsAddr').value = v; $('bsAddr').oninput(); } });
  function bsOwnFill() {
    const others = st.wallets.filter((w) => w.beam && w.id !== st.active);
    const ready = others.filter((w) => w.beamAddress);
    bsOwn.options([{ v: '', label: 'My wallets…' }, ...ready.map((w) => ({ v: w.beamAddress, label: w.name }))], '');
    $('bsOwn').hidden = $('bsOwnL').hidden = !ready.length;
    const missing = others.filter((w) => !w.beamAddress).map((w) => w.name);
    $('bsOwnHint').textContent = missing.length ? `${missing.join(', ')}: shown here once opened (switched to) once — a wallet makes its address while it runs.` : '';
  }
  let bsType = null;
  $('bsAddr').oninput = async () => {
    const a = $('bsAddr').value.trim();
    bsType = null; $('bsKind').textContent = '';
    if (!a || !beamHere()) return;
    // Beam's validate_address calls almost any word a valid token, so the shape is checked first: an SBBS
    // address is 60-70 hex characters, a token (offline, max privacy, the new regular) a long base58 string
    if (!/^[0-9a-fA-F]{60,70}$/.test(a) && !/^[1-9A-HJ-NP-Za-km-z]{80,}$/.test(a)) { $('bsKind').textContent = 'not a Beam address'; return; }
    try {
      const v = await host('beam', W().id, 'validate_address', { address: a });
      if ($('bsAddr').value.trim() !== a) return;          // an older answer for an address since changed
      if (!v.is_valid) { $('bsKind').textContent = 'not a valid Beam address'; return; }
      bsType = v.type;
      $('bsKind').textContent = `${({ max_privacy: 'max-privacy', regular_new: 'regular', public_offline: 'public offline' })[v.type] || v.type || 'regular'} address${v.is_mine ? ', one of this wallet\'s own' : ''}${v.payments != null ? ` · ${v.payments} payment(s) left` : ''}`;
    } catch {}
  };
  const beamFee = () => (bsType === 'offline' || bsType === 'max_privacy' || bsType === 'public_offline' ? 1100000 : 100000);
  $('bsMax').onclick = () => { const a = (beamStatus && beamStatus.available) || 0; $('bsAmt').value = Math.max(0, (a - beamFee()) / GROTH).toFixed(8).replace(/\.?0+$/, ''); };
  $('doBeamSend').onclick = async () => {
    clearNotes('x-beamSend');
    if ($('doBeamSend').disabled) return;
    $('doBeamSend').disabled = true;
    try {
      const address = $('bsAddr').value.trim();
      if (!address) throw new Error('paste the address');
      await $('bsAddr').oninput();
      if (bsType === null) throw new Error('not a valid Beam address');
      const value = toGroth($('bsAmt').value), fee = beamFee();
      if (value + fee > ((beamStatus && beamStatus.available) || 0)) throw new Error(`not enough: ${amt((beamStatus && beamStatus.available) || 0, 8)} BEAM available, ${amt(value + fee, 8)} needed with the fee`);
      if (!(await confirmBox('Send BEAM', [['From wallet', W().name], ['Amount', `${amt(value, 8)} BEAM`], ['Network fee', `${amt(fee, 8)} BEAM`], ['To', address], ['Address type', bsType || 'regular']],
        bsType === 'regular' || !bsType ? 'A regular transfer completes when both wallets are online: keep this browser open until it does.' : ''))) return;
      const r = await host('beam', W().id, 'tx_send', { value, fee, address, asset_id: 0, comment: $('bsNote').value.trim() || undefined });
      note('x-beamSend', 'ok', `Sent: transaction ${r.txId}. It shows under Activity.`);
      $('bsAmt').value = ''; $('bsNote').value = '';
      beamRefresh();
    } catch (e) { note('x-beamSend', 'bad', msg(e)); }
    finally { $('doBeamSend').disabled = false; }
  };

  const esAsset = BB.dropdown($('esAsset'), () => esAvail());
  function esTokens() {
    const list = [{ v: 'ETH', label: 'ETH', dec: 18, bal: ethData ? ethData.eth : '0', token: null }];
    for (const t of (ethData ? ethData.tokens : [])) list.push({ v: t.address, label: t.symbol, dec: t.decimals, bal: t.balance || '0', token: { address: t.address, decimals: t.decimals, symbol: t.symbol } });
    return list;
  }
  const esCur = () => esTokens().find((x) => x.v === esAsset.value()) || esTokens()[0];
  function esAvail() { const c = esCur(); $('esAvail').textContent = `Available ${num(units(c.bal, c.dec), 8)} ${c.label}${c.token ? ' · gas is paid in ETH' : ' · keep some ETH for gas'}`; }
  $('esMax').onclick = () => {
    const c = esCur();
    if (c.token) $('esAmt').value = exact(c.bal, c.dec);
    else { const keepWei = 2n * 10n ** 15n; const v = BigInt(c.bal) > keepWei ? BigInt(c.bal) - keepWei : 0n; $('esAmt').value = exact(v.toString(), 18); }
  };
  // my own accounts as receivers (every wallet's, but the sender)
  const esOwn = BB.dropdown($('esOwn'), (v) => { if (v) { $('esTo').value = v; $('esTo').oninput(); } });
  function esOwnFill() {
    const me = acct();
    const opts = [{ v: '', label: 'My accounts…' }];
    for (const w of st.wallets) {
      const list = w.accounts.filter((a) => !me || a.address.toLowerCase() !== me.address.toLowerCase());
      if (!list.length) continue;
      opts.push({ group: w.name });
      for (const a of list) opts.push({ v: a.address, label: `${a.name} · ${short(a.address)}` });
    }
    esOwn.options(opts, '');
    $('esOwn').hidden = $('esOwnL').hidden = opts.length < 2;
  }
  $('esTo').oninput = () => {
    const t = $('esTo').value.trim();
    const own = allAccounts().find((a) => a.address.toLowerCase() === t.toLowerCase());
    $('esToHint').textContent = !t ? '' : !isEthAddress(t) ? '0x and 40 hex characters' : own ? `your own: ${own.wallet.name} · ${own.name}` : Object.values(st.contracts).includes(t.toLowerCase()) ? 'a contract, not a person: tokens sent to it are lost. For the bridge use the Bridge tab' : '';
  };
  $('doEthSend').onclick = async () => {
    clearNotes('x-ethSend');
    $('doEthSend').disabled = true;
    try {
      const c = esCur(), a = acct(), to = $('esTo').value.trim();
      if (!isEthAddress(to)) throw new Error('the address must be 0x and 40 hex characters');
      if (Object.values(st.contracts).includes(to.toLowerCase())) throw new Error('that is the WBEAM token or the bridge contract: tokens sent there are lost. Use the Bridge tab');
      const p = await host('ethPrepare', { from: a.address, to, amount: $('esAmt').value, token: c.token });
      const feeNow = units(p.feeNow, 18), feeMax = units(p.feeMax, 18);
      const ok = await confirmBox(`Send ${p.symbol}`, [
        ['Amount', `${p.amountExact} ${p.symbol}`], ['From', `${a.name} ${short(a.address)}`], ['To', p.to],
        ['Network fee', `≈ ${num(feeNow, 6)} ETH ${rates ? usd(feeNow * rates.eth) : ''} (at most ${num(feeMax, 6)})`],
        ['Gas', `${Number(p.gasLimit).toLocaleString('en-US')} limit · base ${p.baseGwei.toFixed(2)} gwei`]],
        'Signed here and sent through a public Ethereum RPC. It cannot be undone.');
      if (!ok) return;
      const hash = await host('ethSend', p.id);
      note('x-ethSend', 'ok', `Sent: <a href="https://etherscan.io/tx/${esc(hash)}" target="_blank" rel="noopener">${esc(short(hash))}</a>. It shows under Activity once mined.`, true);
      $('esAmt').value = '';
      setTimeout(ethRefresh, 15000);
    } catch (e) { note('x-ethSend', 'bad', msg(e)); }
    finally { $('doEthSend').disabled = false; }
  };

  const SHEETS = {
    beamRecv: () => { qa('#addrType button').forEach((x) => x.classList.toggle('on', x.dataset.t === addrType)); showType(addrType); },
    beamSend: () => { bsOwnFill(); $('bsAvail').textContent = `${amt((beamStatus && beamStatus.available) || 0, 8)} BEAM`; },
    ethRecv: () => {
      const a = acct(); $('ethRecvAddr').textContent = a.address; $('ethQr').innerHTML = '';
      new QRCode($('ethQr'), { text: a.address, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M });
    },
    ethSend: () => { esAsset.options(esTokens().map((x) => ({ v: x.v, label: x.label })), esAsset.value() || 'ETH'); esAvail(); esOwnFill(); $('esTo').oninput(); },
  };
  $('copyEthAddr').onclick = () => copy($('copyEthAddr'), $('ethRecvAddr').textContent);

  // ---------- Bridge ----------
  let dir = 'toEth';
  function setDir(d) {
    dir = d;
    qa('#bridgeDir button').forEach((b) => b.classList.toggle('on', b.dataset.d === d));
    $('b-toEth').hidden = d !== 'toEth'; $('b-fromEth').hidden = d !== 'fromEth';
    if (d === 'toEth') fee(); else fromEthOpen();
  }
  $('bridgeDir').onclick = (e) => { const b = e.target.closest('button'); if (b) setDir(b.dataset.d); };

  const accountOptions = (extra) => {
    const out = [];
    for (const w of st.wallets) {
      if (!w.accounts.length) continue;
      out.push({ group: w.name });
      for (const a of w.accounts) out.push({ v: a.address, label: `${a.name} · ${short(a.address)}` });
    }
    if (extra) out.push({ group: ' ' }, { v: '__other', label: 'Another address…' });
    return out;
  };
  const teTo = BB.dropdown($('teTo'), (v) => { $('teOtherBox').hidden = v !== '__other'; });
  const feFrom = BB.dropdown($('feFrom'), () => feBal());

  function bridgeOpen() {
    const w = W();
    const a = acct();
    teTo.options(accountOptions(true), teTo.value() && teTo.value() !== '' ? teTo.value() : a ? a.address : '__other');
    $('teOtherBox').hidden = teTo.value() !== '__other';
    feFrom.options(accountOptions(false), feFrom.value() || (a ? a.address : ''));
    $('teFromBal').textContent = beamStatus ? `${amt(beamStatus.available || 0)} BEAM available` : w && w.beam ? '' : 'no Beam part';
    setDir(dir);
    bridgeLists();
  }

  // BEAM -> WBEAM: the relayer takes a message once relayGas (120000) x (2 base fee + tip) x ETH/BEAM is at most
  // its fee. Each choice shows the base fee it covers and how much of the last 24 h it would have been enough.
  const covers = (feeBeam) => feeData ? ((feeBeam * feeData.rate.beam / feeData.rate.eth) * 1e18 / feeData.relayGas - feeData.tip * 1e9) / 2 / 1e9 : null;   // bridge.js coversBase, with its numbers
  const shareOf = (gwei) => feeData && feeData.dayBase.length ? feeData.dayBase.filter((b) => b / 1e9 <= gwei).length / feeData.dayBase.length : null;
  const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
  const NAMES = { cheap: 'Cheap', normal: 'Normal', safe: 'Safe' };
  function feeInfo() {
    const f = parseFloat(String($('teFee').value).replace(',', '.'));
    qa('#teOpts button').forEach((b) => b.classList.toggle('on', Math.abs(+b.dataset.fee - f) < 0.005));
    if (!feeData || !(f > 0)) { $('teFeeInfo').textContent = ''; return; }
    const up = covers(f);
    $('teFeeInfo').textContent = f < feeData.min
      ? `Below the relayer's minimum now (${feeData.min.toFixed(2)} BEAM): it would wait until the base fee drops to ${up > 0 ? up.toFixed(3) : '—'} gwei (${pct(shareOf(up))} of the last 24 h).`
      : `Enough while the base fee is at most ${up.toFixed(3)} gwei: ${pct(shareOf(up))} of the last 24 h. ≈ ${usd(f * feeData.rate.beam)}. Paying more does not speed it up (the relayer takes ~1 h either way). It only covers gas rising meanwhile. The fee is fixed for good.`;
  }
  async function fee() {
    try {
      feeData = await host('relayerFee');
      const d = feeData.day;
      $('teGas').innerHTML = `Gas now <b class="${esc(feeData.level)}">${feeData.base.toFixed(3)} gwei, ${esc(feeData.level)}</b> · 24 h median ${d.p50.toFixed(2)}, 9 in 10 under ${d.p90.toFixed(2)} · minimum now <b>${feeData.min.toFixed(2)} BEAM</b> (${usd(feeData.min * feeData.rate.beam)})`;
      $('teOpts').innerHTML = feeData.options.map((o) => `<button class="feeopt" data-fee="${o.fee}"><span class="t">${NAMES[o.key]}</span><span class="f">${o.fee.toFixed(2)}</span><span class="s">gas ≤ ${o.upTo.toFixed(2)} · ${pct(o.share)} of 24 h</span></button>`).join('');
      if (!$('teFee').dataset.touched) $('teFee').value = feeData.fee;
      feeInfo();
    } catch (e) { $('teGas').textContent = `could not price the relayer fee: ${msg(e)}`; }
  }
  $('teOpts').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; $('teFee').value = b.dataset.fee; $('teFee').dataset.touched = 1; feeInfo(); };
  $('teFee').oninput = () => { $('teFee').dataset.touched = 1; feeInfo(); };
  $('teMax').onclick = () => {
    const f = parseFloat($('teFee').value) || 0, av = ((beamStatus && beamStatus.available) || 0) / GROTH;
    $('teAmt').value = Math.max(0, Math.floor((av - f - 0.02) * 1e4) / 1e4);
  };
  $('doToEth').onclick = async () => {
    clearNotes('b-toEth');
    if ($('doToEth').disabled) return;
    $('doToEth').disabled = true;
    try {
      if (!beamHere()) throw new Error('this wallet has no running Beam part');
      const rcv = teTo.value() === '__other' ? $('teOther').value.trim() : teTo.value();
      if (!isEthAddress(rcv)) throw new Error('the Ethereum address must be 0x and 40 hex characters');
      const own = allAccounts().find((a) => a.address.toLowerCase() === rcv.toLowerCase());
      const a = toGroth($('teAmt').value), f = toGroth($('teFee').value);
      const fd = feeData || await host('relayerFee');
      if (f < Math.round(fd.min * GROTH)) {
        const up = covers(f / GROTH);
        const ok = await confirmBox('Fee under the minimum', [['Relayer minimum now', `${fd.min.toFixed(2)} BEAM`], ['This fee', `${amt(f, 8)} BEAM`],
          ['Released once the base fee is', `≤ ${up > 0 ? up.toFixed(3) : '—'} gwei (${pct(shareOf(up))} of the last 24 h)`]],
          'The relayer keeps the message and takes it when gas gets that cheap. If it never does, the BEAM stay locked: nothing can raise the fee later.');
        if (!ok) return;
      }
      const av = (beamStatus && beamStatus.available) || 0;
      if (a + f + 2e6 > av) throw new Error(`not enough: ${amt(av, 8)} BEAM available, needed amount + fee + ~0.02`);
      const txid = await host('sendToEth', W().id, {
        title: 'Bridge BEAM → WBEAM',
        rows: [['WBEAM to receive', amt(a, 8)], ['Relayer fee', `${amt(f, 8)} BEAM`],
          ['Fee covers', `base fee up to ${(covers(f / GROTH) ?? 0).toFixed(3)} gwei (${pct(shareOf(covers(f / GROTH)))} of the last 24 h); ×${(f / GROTH / fd.min).toFixed(1)} today's minimum`],
          ['To', own ? `${own.wallet.name} · ${own.name} ${rcv}` : `${rcv} (not one of this wallet's accounts)`]],
        note: 'The official bridge pipe on Beam, released by its relayer on Ethereum in about an hour. It cannot be undone.',
      }, a, rcv, f);
      note('b-toEth', 'ok', `Sent: Beam transaction ${txid}. It shows under Transfers once a block confirms it.`);
      $('teAmt').value = '';
      beamRefresh(); setTimeout(bridgeLists, 90000);
    } catch (e) { note('b-toEth', 'bad', msg(e)); }
    finally { $('doToEth').disabled = false; }
  };

  // WBEAM -> BEAM
  let feBalData = null;
  async function feBal() {
    const from = feFrom.value();
    $('feFromBal').textContent = '';
    feBalData = null;
    if (!isEthAddress(from)) return;
    try {
      const d = await host('ethBalances', from);
      const wb = d.tokens.find((t) => t.address.toLowerCase() === st.contracts.wbeam);
      feBalData = { wbeam: wb ? wb.balance : '0', eth: d.eth };
      $('feFromBal').textContent = `${num(units(feBalData.wbeam, 8), 4)} WBEAM · ${num(units(d.eth, 18), 5)} ETH for gas`;
    } catch (e) { $('feFromBal').textContent = msg(e); }
  }
  async function fromEthOpen() {
    feBal();
    $('feKey').textContent = 'bridge key …';
    if (!beamHere()) { $('feKey').textContent = 'no running Beam part'; return; }
    try { const k = await host('beamKey', W().id); $('feKey').textContent = `key ${k.slice(0, 8)}…${k.slice(-6)}`; $('feKey').dataset.tip = `The bridge key of this wallet's Beam part: ${k}`; }
    catch (e) { $('feKey').textContent = msg(e); }
  }
  $('feMax').onclick = () => {
    if (!feBalData) return;
    const f = BigInt(Math.round((parseFloat($('feFee').value) || 0) * 1e8));
    const v = BigInt(feBalData.wbeam) - f;
    $('feAmt').value = v > 0n ? exact(v.toString(), 8) : '0';
  };
  $('doFromEth').onclick = async () => {
    clearNotes('b-fromEth');
    $('doFromEth').disabled = true;
    try {
      if (!beamHere()) throw new Error('this wallet has no running Beam part to receive');
      const from = feFrom.value();
      if (!isEthAddress(from)) throw new Error('choose the Ethereum account');
      const p = await host('fromEthPrepare', { from, wallet: W().id, amount: $('feAmt').value, fee: $('feFee').value });
      const fn = units(p.feeNow, 18), fm = units(p.feeMax, 18);
      if (!p.enoughGas) throw new Error(`not enough ETH for gas on ${short(from)}: up to ${num(fm, 6)} ETH needed, ${num(units(p.ethBalance, 18), 6)} there`);
      const acc = allAccounts().find((a) => a.address.toLowerCase() === from.toLowerCase());
      const ok = await confirmBox('Bridge WBEAM → BEAM', [
        ['BEAM to receive', exact(p.value, 8)], ['Relayer fee', `${exact(p.fee, 8)} WBEAM`],
        ['From', `${acc ? `${acc.wallet.name} · ${acc.name} ` : ''}${p.from}`], ['To', `${p.beamWallet}: Beam bridge key ${p.key.slice(0, 10)}…`],
        ['Ethereum transactions', p.approve ? '2: approve WBEAM to the bridge, then send' : '1: send'],
        ['Gas', `≈ ${num(fn, 6)} ETH ${rates ? usd(fn * rates.eth) : ''} (at most ${num(fm, 6)})`]],
        'The approval is for exactly this amount. Once the relayer has brought it to Beam (usually under an hour), claim it under "Arrived on Beam".');
      if (!ok) return;
      note('b-fromEth', 'ok', p.approve ? 'Approving WBEAM… then sending (the popup may be closed: it goes on).' : 'Sending…');
      const rec = await host('fromEthSend', p.id);
      note('b-fromEth', 'ok', `Confirmed on Ethereum: <a href="https://etherscan.io/tx/${esc(rec.hash)}" target="_blank" rel="noopener">${esc(short(rec.hash))}</a>. The relayer brings it to Beam; then claim it below.`, true);
      $('feAmt').value = '';
      feBal(); bridgeLists();
    } catch (e) { note('b-fromEth', 'bad', msg(e)); }
    finally { $('doFromEth').disabled = false; }
  };

  // the lists: what arrived to claim, and both directions' transfers
  async function bridgeLists() {
    note('inErr', 'bad', ''); note('bErr', 'bad', '');
    if (beamHere()) {
      host('incoming', W().id).then((list) => {
        $('inList').innerHTML = list.map((m) => `<div class="li"><span class="ic in">${SVG_IN}</span><span class="what">Message #${esc(m.MsgId)}<span class="sub">from Ethereum</span></span>
          <span class="amt pos">${amt(Number(m.amount))} BEAM</span><button class="btn solid small" data-msg="${esc(m.MsgId)}" data-amount="${esc(m.amount)}">Claim</button></div>`).join('')
          || '<div class="empty">nothing waiting</div>';
      }).catch((e) => note('inErr', 'bad', msg(e)));
    } else $('inList').innerHTML = '<div class="empty">this wallet has no running Beam part</div>';

    const extra = teTo.value() === '__other' ? $('teOther').value.trim() : '';
    const [out, ins] = await Promise.all([
      Object.values(st.beam || {}).some((b) => b.status === 'running') ? host('outgoing', extra).catch((e) => { note('bErr', 'bad', msg(e)); return { msgs: [] }; }) : { msgs: [] },
      host('bridgeIn').catch(() => []),
    ]);
    const OUT = { done: ['ok', 'arrived'], waiting: ['pending', 'waiting for the relayer'], failed: ['bad', 'failed on Ethereum'], unknown: ['warn', 'see the bridge monitor'] };
    const IN = { approving: ['pending', 'approving'], sending: ['pending', 'sending'], sent: ['pending', 'mining'], unconfirmed: ['warn', 'not mined yet'], confirmed: ['ok', 'sent to Beam'], failed: ['bad', 'failed'] };
    const rows = [
      ...out.msgs.map((m) => ({ t: m.eth ? Date.parse(m.eth.time) : Infinity, html: `<div class="li"><span class="ic out">${SVG_BRIDGE}</span>
        <span class="what">BEAM → WBEAM #${m.id}<span class="sub">to ${esc(short(m.receiver))} · fee ${amt(m.fee, 2)}${m.eth ? ` · <a href="https://etherscan.io/tx/${esc(m.eth.hash)}" target="_blank" rel="noopener">${esc(fdt(m.eth.time))}</a>` : ''}</span></span>
        <span class="amt">${amt(m.amount)}</span><span class="badge ${OUT[m.state][0]}">${OUT[m.state][1]}</span></div>` })),
      ...ins.map((r) => ({ t: r.time, html: `<div class="li"><span class="ic in">${SVG_BRIDGE}</span>
        <span class="what">WBEAM → BEAM<span class="sub">from ${esc(short(r.from))} · ${esc(ago(r.time))}${r.hash ? ` · <a href="https://etherscan.io/tx/${esc(r.hash)}" target="_blank" rel="noopener">tx</a>` : ''}${r.error ? ` · ${esc(r.error)}` : ''}</span></span>
        <span class="amt">${num(units(r.value, 8), 4)}</span><span class="badge ${(IN[r.state] || IN.sent)[0]}">${(IN[r.state] || IN.sent)[1]}</span></div>` })),
    ].sort((a, b) => b.t - a.t);
    $('bList').innerHTML = rows.map((r) => r.html).join('') || '<div class="empty">none yet</div>';
  }
  $('inRefresh').onclick = (e) => { e.preventDefault(); bridgeLists(); };
  $('inList').onclick = async (e) => {
    const b = e.target.closest('button[data-msg]');
    if (!b) return;
    note('inErr', 'bad', '');
    b.disabled = true;
    try {
      const txid = await host('receive', W().id, {
        title: 'Claim from the bridge', rows: [['Bridge message', `#${b.dataset.msg}`], ['BEAM', amt(Number(b.dataset.amount), 8)]],
        note: 'Takes the BEAM the relayer brought over for this wallet.',
      }, b.dataset.msg);
      b.textContent = 'Claimed'; b.title = `Beam transaction ${txid}`;
      beamRefresh();
    } catch (err) { note('inErr', 'bad', msg(err)); b.disabled = false; }
  };

  // ---------- Activity ----------
  let actNet = 'beam';
  $('actNet').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; actNet = b.dataset.n; qa('#actNet button').forEach((x) => x.classList.toggle('on', x === b)); activity(); };
  const BEAM_STATUS = { 0: ['pending', 'pending'], 1: ['pending', 'in progress'], 2: ['bad', 'cancelled'], 3: ['ok', 'completed'], 4: ['bad', 'failed'], 5: ['pending', 'registering'] };
  async function activity() {
    const box = $('actList');
    if (actNet === 'beam') {
      if (!beamHere()) { box.innerHTML = '<div class="empty">this wallet has no running Beam part</div>'; return; }
      try {
        const list = await host('beam', W().id, 'tx_list', { count: 50 });
        box.innerHTML = list.map((t) => {
          const contract = t.tx_type_string === 'contract';
          const what = contract ? (t.comment || 'contract') : t.income ? 'Received' : 'Sent';
          const [cls, label] = BEAM_STATUS[t.status] || ['pending', t.status_string || String(t.status)];
          const link = t.kernel && !/^0+$/.test(t.kernel) ? ` · <a href="https://explorer.bumblebeam.org/kernel/${esc(t.kernel)}" target="_blank" rel="noopener">kernel</a>` : '';
          const cancel = !t.income && !contract && (t.status === 0 || t.status === 1) ? ` · <a href="#" class="text-link" data-cancel="${esc(t.txId)}">cancel</a>` : '';
          return `<div class="li"><span class="ic ${t.income ? 'in' : 'out'}">${contract ? SVG_BRIDGE : t.income ? SVG_IN : SVG_OUT}</span>
            <span class="what">${esc(what)}<span class="sub">${esc(t.create_time ? fdt(t.create_time * 1000) : '')}${t.fee ? ` · fee ${amt(t.fee, 3)}` : ''}${link}${cancel}</span></span>
            <span class="amt ${t.income ? 'pos' : ''}">${t.value ? `${t.income ? '+' : '−'}${amt(t.value)}` : ''}</span><span class="badge ${cls}">${esc(t.status_string || label)}</span></div>`;
        }).join('') || '<div class="empty">no transactions yet</div>';
      } catch (e) { box.innerHTML = `<div class="empty">${esc(msg(e))}</div>`; }
    } else {
      const a = acct();
      if (!a) { box.innerHTML = '<div class="empty">this wallet has no Ethereum part</div>'; return; }
      box.innerHTML = '<div class="empty">loading…</div>';
      try {
        const list = await host('ethHistory', a.address);
        box.innerHTML = list.map((t) => {
          const v = t.token ? `${num(units(t.token.value, t.token.decimals), 4)} ${t.token.symbol}` : units(t.value, 18) > 0 ? `${num(units(t.value, 18), 5)} ETH` : '';
          const what = t.method && !t.token ? t.method : t.out ? 'Sent' : 'Received';
          const other = t.out ? t.to : t.from;
          return `<div class="li"><span class="ic ${t.out ? 'out' : 'in'}">${t.out ? SVG_OUT : SVG_IN}</span>
            <span class="what">${esc(what)}<span class="sub">${t.out ? 'to' : 'from'} ${esc(short(other))} · <a href="https://etherscan.io/tx/${esc(t.hash)}" target="_blank" rel="noopener">${esc(t.time ? fdt(t.time) : 'pending')}</a></span></span>
            <span class="amt ${t.out ? '' : 'pos'}">${v ? `${t.out ? '−' : '+'}${esc(v)}` : ''}</span><span class="badge ${t.pending ? 'pending' : t.ok ? 'ok' : 'bad'}">${t.pending ? 'pending' : t.ok ? 'ok' : 'failed'}</span></div>`;
        }).join('') || '<div class="empty">no transactions yet</div>';
      } catch (e) { box.innerHTML = `<div class="empty">${esc(msg(e))}</div>`; }
    }
  }
  $('actList').onclick = async (e) => {
    const c = e.target.closest('[data-cancel]');
    if (!c) return;
    e.preventDefault();
    if (!(await confirmBox('Cancel the transfer', [['Transaction', c.dataset.cancel]], 'Only a transfer the other wallet has not signed yet can be cancelled.'))) return;
    try { await host('beam', W().id, 'tx_cancel', { txId: c.dataset.cancel }); activity(); } catch (err) { ask({ title: 'Not done', note: msg(err), yes: 'OK', no: null }); }
  };

  // ---------- Settings ----------
  const autoLockDd = BB.dropdown($('autoLock'), (v) => host('setAutoLock', Number(v)));
  const timeDd = BB.dropdown($('timeFmt'), (v) => { time12 = v === '12'; chrome.storage.local.set({ time12 }).catch(() => {}); });
  chrome.storage.local.get('time12').then((v) => { time12 = !!v.time12; }).catch(() => {});
  async function settingsOpen() {
    $('ver').textContent = chrome.runtime.getManifest().version;
    $('node').value = st.node; $('ethRpc').value = st.ethRpc || '';
    $('backupNodes').value = (st.nodes || []).filter((n) => n !== st.node).join(', ');
    autoLockDd.set(String(st.autoLock));
    timeDd.set(time12 ? '12' : '24');
    $('wList').innerHTML = st.wallets.map((w) => `<div class="wcard${w.id === st.active ? ' on' : ''}" data-w="${esc(w.id)}">
      <div class="wname"><b>${esc(w.name)}</b>${w.id === st.active ? '<span class="badge ok">active</span>' : ''}
        ${w.beam ? '<span class="badge net-beam">Beam</span>' : ''}${w.eth ? `<span class="badge net-eth">Ethereum${w.accounts.length > 1 ? ` ×${w.accounts.length}` : ''}</span>` : ''}</div>
      <div class="wacts">
        ${w.id !== st.active ? '<a href="#" class="text-link" data-a="use">use</a>' : ''}
        <a href="#" class="text-link" data-a="rename">rename</a>
        ${w.phraseKnown ? '<a href="#" class="text-link" data-a="phrase">seed phrase</a>' : ''}
        ${w.ethKind === 'phrase' ? '<a href="#" class="text-link" data-a="ethPhrase">Ethereum phrase</a>' : ''}
        ${w.eth ? '<a href="#" class="text-link" data-a="ethKey">private key</a>' : ''}
        ${w.beam ? '<a href="#" class="text-link" data-a="backup">Beam backup</a>' : ''}
        ${w.beam && st.beam && st.beam[w.id] && ['missing', 'failed'].includes(st.beam[w.id].status) ? '<a href="#" class="text-link" data-a="restoreBeam">restore Beam</a>' : ''}
        <a href="#" class="text-link danger" data-a="remove">remove</a>
      </div></div>`).join('');
    dappListOpen();
    $('tokList').innerHTML = (st.tokens || []).map((t) => `<div class="li"><span class="what">${esc(t.symbol)}<span class="sub hash">${esc(t.address)}</span></span><a href="#" class="text-link" data-tok="${esc(t.address)}">remove</a></div>`).join('')
      || '<div class="empty">no tokens added</div>';
    host('snapshotInfo').then((s) => { $('snapInfo').textContent = s ? `${(s.size / 2 ** 20).toFixed(0)} MB, ${ago(s.at)}` : 'none kept'; $('dropSnap').hidden = !s; });
  }
  $('addWallet').onclick = () => welcome();

  // ---------- dApps ----------
  const six = (x) => (x ? `${x.slice(0, 8)}…${x.slice(-6)}` : '');
  const ethAmt = (wei) => `${num(units(wei, 18), 6)} ETH`;
  // the window's screen: the oldest waiting request, what it asks, Approve / Reject; none left: the window closes
  let dpCur = null;
  async function dappScreen() {
    let list = [];
    try { list = await host('dappPending'); } catch {}
    if (!list.length) { dpCur = null; if (inWin) return window.close(); return; }
    const r = dpCur = list[0];
    clearNotes('s-dapp');
    const acc = r.address ? (st.wallets || []).flatMap((w) => w.accounts.map((a) => ({ w, a }))).find((x) => x.a.address.toLowerCase() === r.address.toLowerCase()) : null;
    // the name, then the whole address on the next line (they do not fit on one)
    const accRow = r.address ? [['Account', `${acc ? `${acc.a.name}\n` : ''}${r.address}`]] : [['Account', 'this wallet has no Ethereum account']];
    const kv = (rows) => `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
    $('dpSite').textContent = r.origin;
    // Beam: the account is the open wallet (its name), as the Ethereum one is the chosen account
    const wRow = r.wallet ? [['Account', `${r.wallet.name}${r.wallet.beam ? '' : ' (no Beam part)'}`]] : [];
    if (r.kind === 'beamConnect') {
      $('dpTitle').textContent = 'Connect to Beam';
      $('dpBody').innerHTML = kv([['App', r.appname || ''], ...wRow]);
      $('dpNote').textContent = r.wallet && !r.wallet.beam ? 'The open wallet has no Beam part: open a wallet with one first.'
        : 'The site sees this account\'s Beam balance, assets and its own transactions, and can ask for contract transactions. Each one is asked here first. For another account, open it in the wallet first.';
      $('dpYes').textContent = 'Connect';
      $('dpYes').disabled = !(r.wallet && r.wallet.beam);
      $('dpMore').textContent = list.length > 1 ? `${list.length - 1} more waiting` : '';
      return show('s-dapp');
    }
    if (r.kind === 'beamtx') {
      $('dpTitle').textContent = 'Beam contract transaction';
      const rows = [['App', r.appname || ''], ...wRow, ...await consentRows(r.info, r.amounts)];
      $('dpBody').innerHTML = kv(rows);
      $('dpNote').textContent = 'What it spends and receives is the wallet\'s own reading of the transaction, not the site\'s.';
      $('dpYes').textContent = 'Approve';
      $('dpYes').disabled = false;
      $('dpMore').textContent = list.length > 1 ? `${list.length - 1} more waiting` : '';
      return show('s-dapp');
    }
    if (r.kind === 'connect') {
      $('dpTitle').textContent = 'Connect this site';
      $('dpBody').innerHTML = kv(accRow);
      $('dpNote').textContent = 'The site will see this account\'s address and balances. It can ask to sign or send, and nothing is signed without asking you here. For another account, choose it in the wallet first.';
      $('dpYes').textContent = 'Connect';
    } else if (r.kind === 'sign') {
      $('dpTitle').textContent = r.method === 'personal_sign' ? 'Sign a message' : 'Sign typed data';
      const what = r.method === 'personal_sign' ? r.text : JSON.stringify(r.typed, null, 2);
      $('dpBody').innerHTML = kv(accRow) + `<pre class="dp-msg">${esc(what || '')}</pre>`;
      $('dpNote').textContent = 'A signature costs nothing and sends nothing, but it can prove agreement to what it says (some sites use it to approve token spending). Sign only what you understand.';
      $('dpYes').textContent = 'Sign';
    } else {
      $('dpTitle').textContent = 'Send a transaction';
      const t = r.tx || {};
      const rows = [...accRow, ['To', t.to || '(creates a contract)'], ['Value', ethAmt(t.value || '0')],
        ['Data', !t.data || t.data === '0x' ? 'none' : `${t.data.slice(0, 10)}… (${(t.data.length - 2) / 2} bytes)`],
        ['Network fee', r.fee ? `${ethAmt(r.fee.now)} now, up to ${ethAmt(r.fee.max)}` : r.feeErr ? (/insufficient funds/i.test(r.feeErr) ? 'not enough ETH for the value and the fee' : /revert/i.test(r.feeErr) ? 'the contract refuses it (it would revert)' : `not priced: ${r.feeErr.slice(0, 120)}`) : '…']];
      $('dpBody').innerHTML = kv(rows);
      $('dpNote').textContent = r.feeErr ? 'The network says this transaction would fail. Sending it may only cost the fee.' : 'Sent from this account on Ethereum mainnet once you confirm.';
      $('dpYes').textContent = 'Send';
    }
    $('dpYes').disabled = r.kind !== 'connect' && !r.address;
    $('dpMore').textContent = list.length > 1 ? `${list.length - 1} more waiting` : '';
    show('s-dapp');
  }
  async function dappReply(ok) {
    if (!dpCur) return;
    $('dpYes').disabled = $('dpNo').disabled = true;
    try { await host('dappAnswer', dpCur.id, ok); }
    catch (e) { note('s-dapp', 'bad', msg(e)); }
    $('dpYes').disabled = $('dpNo').disabled = false;
    dappScreen();
  }
  $('dpYes').onclick = () => dappReply(true);
  $('dpNo').onclick = () => dappReply(false);

  // the open tab's site and its status, right of the total
  let siteOrigin = null;
  async function dappRefresh() {
    siteOrigin = null;
    if (!inTab && !inWin) {
      try { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); const u = t && t.url ? new URL(t.url) : null; if (u && /^https?:$/.test(u.protocol)) siteOrigin = u.origin; } catch {}
    }
    const box = $('dappBox');
    box.className = 'dapp-box';
    box.hidden = !siteOrigin;                          // not a website (a new tab, chrome://): nothing at all
    if (!siteOrigin) return;
    let s = { connected: false, waiting: false, address: null };
    try { s = await host('dappStatus', siteOrigin); } catch {}
    const hostName = new URL(siteOrigin).hostname;
    if (s.waiting) { box.classList.add('warn'); $('dappSt').textContent = 'request waiting'; $('dappSub').textContent = hostName; }
    else if (s.connected) { box.classList.add('ok'); $('dappSt').textContent = 'connected'; $('dappSub').textContent = [s.beam ? 'Beam' : '', s.address ? six(s.address) : ''].filter(Boolean).join(' · '); }
    else { $('dappSt').textContent = 'not connected'; $('dappSub').textContent = hostName; }
    box.title = '';
  }
  $('dappBox').onclick = async () => {
    if (!siteOrigin) return;
    const s = await host('dappStatus', siteOrigin).catch(() => null);
    if (!s) return;
    if (s.waiting) { chrome.runtime.sendMessage({ op: 'dappWindow' }).catch(() => {}); return; }
    if (s.connected) {
      const named = s.address && (st.wallets || []).flatMap((w) => w.accounts).find((a) => a.address.toLowerCase() === s.address.toLowerCase());
      const r = await ask({ title: new URL(siteOrigin).hostname, rows: [['Site', siteOrigin], ...(s.beam ? [['Beam', 'connected']] : []), ...(s.address ? [['Ethereum', `${named ? `${named.name}\n` : ''}${s.address}`]] : [])], note: 'Disconnected, the site sees nothing of the wallet until you connect it again.', yes: 'Disconnect', no: 'Close' });
      if (r.ok) { await host('dappDisconnect', siteOrigin); dappRefresh(); }
      return;
    }
    await ask({ title: new URL(siteOrigin).hostname, note: 'Not connected. On the site, choose "Connect wallet", pick BumbleBeam Wallet and approve it here.', yes: 'OK', no: null });
  };
  async function dappListOpen() {
    const l = await host('dappList').catch(() => []);
    $('dappList').innerHTML = l.map((d) => `<div class="li"><span class="what">${esc(new URL(d.origin).hostname)}<span class="sub">${esc([d.beam ? `Beam: ${d.beam}` : '', d.address ? six(d.address) : '', fdate(d.at)].filter(Boolean).join(' · '))}</span></span><a href="#" class="text-link" data-dapp="${esc(d.origin)}">disconnect</a></div>`).join('')
      || '<div class="empty">no site connected</div>';
  }
  $('dappList').onclick = async (e) => {
    const a = e.target.closest('[data-dapp]');
    if (!a) return;
    e.preventDefault();
    await host('dappDisconnect', a.dataset.dapp); dappListOpen(); dappRefresh();
  };
  $('wList').onclick = (e) => {
    const a = e.target.closest('[data-a]');
    if (!a) return;
    e.preventDefault();
    const w = st.wallets.find((x) => x.id === a.closest('[data-w]').dataset.w);
    const act = a.dataset.a;
    walletAct(w, act);
  };
  async function walletAct(w, act) {
    try {
      if (act === 'use') { await host('switchWallet', w.id); await load(); settingsOpen(); }
      if (act === 'restoreBeam') {
        // the Beam part rebuilt from the seed phrase: the stored one, or typed for a wallet that has none
        const r = await ask({ title: `Restore Beam: ${w.name}`, password: true, yes: 'Restore',
          input: w.phraseKnown ? null : { label: 'Seed phrase of this wallet (12 words)', value: '' },
          note: `Rebuilds this wallet's Beam part from its seed phrase${w.phraseKnown ? ' (the one kept in this wallet)' : ''} through Beam's recovery snapshot (~320 MB, a few minutes). The coins come back, the history and address names do not. Only when its Beam database is gone.` });
        if (!r.ok) return;
        // it runs in the host (the popup may close); the wallet's card shows its progress
        await host('switchWallet', w.id); await load(); tab('home');
        host('restoreBeam', w.id, r.pass, r.input || '').catch((err) => ask({ title: 'Not restored', note: msg(err), yes: 'OK', no: null }));
        return;
      }
      if (act === 'rename') {
        const r = await ask({ title: 'Rename the wallet', input: { label: 'Name', value: w.name }, yes: 'Save' });
        if (r.ok && r.input) { await host('renameWallet', w.id, r.input); await load(); settingsOpen(); }
      }
      if (act === 'phrase' || act === 'ethPhrase') {
        await ask({ title: act === 'phrase' ? 'Seed phrase' : 'Ethereum seed phrase', password: true, yes: 'Show',
          note: 'Anyone who sees these words owns the wallet. Make sure no one is watching the screen.',
          check: async ({ pass }) => {
            const phrase = await host('reveal', w.id, pass, act);
            if (!phrase) throw new Error('no phrase is kept for this wallet');
            return { title: `${w.name}: ${act === 'phrase' ? 'seed phrase' : 'Ethereum seed phrase'}`, html: `<ol class="seed">${phrase.split(' ').map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` };
          } });
      }
      if (act === 'ethKey') {
        const a2 = w.accounts.find((x) => x.i === (st.activeEth[w.id] ?? w.accounts[0].i)) || w.accounts[0];
        await ask({ title: `Private key of ${a2.name}`, password: true, yes: 'Show', note: `${a2.address}. Whoever has the key controls this account; import it only into a wallet you trust.`,
          check: async ({ pass }) => ({ title: `${a2.name}: private key`, html: `<div class="hash box">${esc(await host('reveal', w.id, pass, 'ethKey', a2.i))}</div>` }) });
      }
      if (act === 'backup') {
        let out = null;
        // the file's password, if it is not the wallet's, in the same dialog; then the file, saved by the service
        // worker (Chrome's download bubble takes the focus and may close the popup: the file is saved anyway)
        const r = await ask({ title: `Back up ${w.name}`, password: true, yes: 'Save the file',
          note: 'Saves the Beam part as a wallet.db: keys, addresses and history, encrypted by Beam. Opening it later is instant, unlike a seed restore.',
          check: async (x) => {
            out = await host('exportBeam', w.id, x.pass);
            if (out.samePassword) return null;
            const dbp = await host('reveal', w.id, x.pass, 'beamPass');
            return { title: 'The file\'s password', html: `<div class="hash box">${esc(dbp)}</div>`, yes: 'Save the file', note: 'This file opens with the password the wallet had when it was created or imported, not with today\'s. Keep it with the file.' };
          } });
        if (!r.ok || !out) return;
        const name = `bumblebeam-${w.name.replace(/[^\w-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.db`;
        const r2 = await chrome.runtime.sendMessage({ op: 'download', b64: out.b64, name }).catch((e) => ({ error: e.message }));
        if (r2 && r2.error) await ask({ title: 'Not saved', note: r2.error, yes: 'OK', no: null });
      }
      if (act === 'remove') {
        const r = await ask({ title: `Remove ${w.name}`, password: true, yes: 'Remove', rows: [['Parts', [w.beam && 'Beam', w.eth && 'Ethereum'].filter(Boolean).join(' + ')]],
          note: 'Its seeds, keys and Beam database are deleted from this browser. Only the seed phrase, a private key or a backup file can bring it back.',
          check: async ({ pass }) => { await host('removeWallet', w.id, pass); } });
        if (r.ok) { await load(); if (st.phase === 'unlocked' && st.wallets.length) settingsOpen(); else route(); }
      }
    } catch (err) { ask({ title: 'Not done', note: msg(err), yes: 'OK', no: null }); }
  }
  $('chPass').onclick = async () => {
    let old = '';
    const r1 = await ask({ title: 'Change the password', password: true, yes: 'Next', check: async ({ pass }) => { old = pass; await host('verify', pass); } });
    if (!r1.ok) return;
    const r2 = await ask({ title: 'New password', input: { label: 'New password (8 characters or more)', secret: true }, password: true, passLabel: 'Repeat it', yes: 'Change',
      note: 'Beam backup files saved before keep opening with the password they were saved with.',
      check: async ({ input, pass }) => {
        if (input !== pass) throw new Error('the two differ');
        if (input !== input.trim()) throw new Error('a password that starts or ends with a space is easy to lose: leave the spaces out');
        await host('changePassword', old, input);
      } });
    if (r2.ok) await ask({ title: 'Password changed', note: 'The new password opens the wallet from now on.', yes: 'OK', no: null });
  };
  $('saveNode').onclick = async () => { note('netErr', 'bad', ''); try { st.node = await host('setNode', $('node').value.trim()); $('node').value = st.node; } catch (e) { note('netErr', 'bad', msg(e)); } };
  $('saveBackups').onclick = async () => {
    note('netErr', 'bad', '');
    try { const l = await host('setBackupNodes', $('backupNodes').value); $('backupNodes').value = l.join(', '); } catch (e) { note('netErr', 'bad', msg(e)); }
  };
  $('saveRpc').onclick = async () => {
    note('netErr', 'bad', '');
    const url = $('ethRpc').value.trim();
    try {
      if (url) {
        const origin = new URL(url).origin + '/*';
        if (!(await chrome.permissions.request({ origins: [origin] }))) throw new Error('the browser did not allow that address');
      }
      await host('setEthRpc', url); st.ethRpc = url;
    } catch (e) { note('netErr', 'bad', msg(e)); }
  };
  $('addTok').onclick = async () => {
    note('tokErr', 'bad', '');
    try { await host('addToken', $('tokAddr').value.trim()); $('tokAddr').value = ''; await load(); settingsOpen(); } catch (e) { note('tokErr', 'bad', msg(e)); }
  };
  $('tokList').onclick = async (e) => { const t = e.target.closest('[data-tok]'); if (!t) return; e.preventDefault(); await host('removeToken', t.dataset.tok); await load(); settingsOpen(); };
  $('dropSnap').onclick = async (e) => { e.preventDefault(); await host('dropSnapshot'); settingsOpen(); };

  // the auto-lock counts only what the user does here: a click or a key tells the host, at most every 15 s
  let touched = 0;
  const touch = () => { if (st && st.phase === 'unlocked' && Date.now() - touched > 15000) { touched = Date.now(); host('touch').catch(() => {}); } };
  document.addEventListener('click', touch, true);
  document.addEventListener('keydown', touch, true);
  // Enter in a field has no default here (no forms); left to Chrome, it took the popup's focus on Windows
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') e.preventDefault(); }, true);

  // ---------- boot and routing ----------
  async function route() {
    st = await host('state');
    if (st.progress && !(st.beam && st.beam[st.progress.wallet])) {   // a new wallet is still being made in the host
      show('s-progress'); progressScreen = 's-progress'; handlers.progress(st.progress);
      return;
    }
    if (st.phrase && st.phase !== 'locked' && st.phase !== 'legacy') { pwFields(); return showPhrase(await host('phrase')); }
    if (st.phase === 'unlocked') return enter();
    if (st.phase === 'new') return welcome();
    $('unlockLead').textContent = st.phase === 'legacy'
      ? 'Version 0.2: one password now opens all your wallets. Type the password of your Beam wallet: it becomes this password.'
      : st.beamRunning ? 'Your regular Beam addresses go offline\nonce the transfers in progress are done.' : 'Your regular Beam addresses are offline\nwhile the wallet is locked.';
    show('s-unlock');
    $('uPass').focus();
  }

  const timers = [
    setInterval(() => { if (curTab === 'home' && !$('t-home').hidden) beamRefresh(); }, 20000),
    setInterval(() => {
      if (!st || st.phase !== 'unlocked') return;
      priceTick();
      if (!$('t-home').hidden) ethRefresh();
      if (!$('t-bridge').hidden) { if (dir === 'toEth') fee(); bridgeLists(); }
    }, 60000),
  ];
  window.addEventListener('pagehide', () => timers.forEach(clearInterval));

  (async () => {
    try {
      // right after the browser starts the service worker may not listen yet: a few tries
      let r;
      for (let i = 0; ; i++) {
        try { r = await chrome.runtime.sendMessage({ op: 'ensureHost' }); break; }
        catch (e) { if (i >= 5) throw e; await new Promise((res) => setTimeout(res, 300 * (i + 1))); }
      }
      if (r && r.error) throw new Error(r.error);
      // The host document may exist but still be loading its scripts (the service worker made it at browser
      // start): a port opened then finds no listener and closes at once. Ask until it answers (up to ~10 s).
      for (let i = 0; ; i++) {
        try { await host('state'); break; }
        catch (e) { if (i >= 40 || !/went away/.test(e.message)) throw e; await new Promise((res) => setTimeout(res, 250)); }
      }
      await route();
      if (inTab && location.hash === '#import' && st && (st.phase === 'new' || st.phase === 'unlocked')) go('import');
    } catch (e) { note('bootErr', 'bad', msg(e)); }
  })();
})();
