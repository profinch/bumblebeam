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
  if (inWin) document.documentElement.classList.add('win');

  // ---------- what comes in later fades in ----------
  // Anything on the wallet's screens that fills in as it loads appears gradually instead of at once: a value
  // written where there was none (empty, '—', '…', a 'loading…' or 'syncing…' placeholder), and a row of a card
  // that was hidden until its data came (the Ethereum card's nonce, ENS, avatar…). A value that only changes, or
  // a list drawn again, does not blink. Screens and dropdown lists are left alone.
  const BLANK = new Set(['', '—', '…', '-']);
  // a QR code drawn again (another address) counts as new too: it fades in each time
  const blank = (nodes) => [...nodes].every((n) => (n.nodeType === 1 && n.classList.contains('empty')) || BLANK.has((n.textContent || '').trim()));
  const fadeIn = (el) => { el.classList.remove('fade'); void el.offsetWidth; el.classList.add('fade'); };
  new MutationObserver((list) => {
    const done = new Set();
    for (const m of list) {
      const el = m.target;
      if (el.nodeType !== 1 || done.has(el) || el.closest('.dd-list, #bb-tip, dialog, .tabs, .bx, .bx-feeline')) continue;      // the bridge's cards and fee line: their own motion (the turn); its baselines are measured by a mark put in and taken out, which read as "written where there was none" and blinked the balances
      if (m.type === 'attributes') {
        // a card's row or line shown once its data came (not a screen, a tab or a whole card)
        if (!el.hidden && el.closest('.panel') && !el.matches('.screen, .panel, section')) { done.add(el); fadeIn(el); }
        continue;
      }
      // blank before: what was taken out was blank, or nothing was there (all it holds came in now)
      // (nothing there: the first nodes put in had no neighbours on either side)
      const was = m.removedNodes.length ? blank(m.removedNodes) : m.addedNodes.length && !m.previousSibling && !m.nextSibling;
      if (!was) continue;
      // content is text, or a picture (a QR code's canvas, an image, an icon)
      const now = (el.textContent || '').trim(), pic = !!el.querySelector('canvas, img');
      if ((BLANK.has(now) && !pic) || (el.children.length === 1 && el.firstElementChild.classList.contains('empty'))) continue;
      done.add(el); fadeIn(el);
    }
  }).observe(document.querySelector('main') || document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });

  // ---------- small things ----------
  const $ = (id) => document.getElementById(id);
  const qa = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // the decimals amounts show (Settings, Display: 2, 4, 6 or 8; kept in this browser). Confirmations pass 8: what is
  // signed is shown whole
  let decShown = 6;
  const amt = (groth, d = decShown) => (groth == null || !isFinite(groth) ? ''
    : (groth / GROTH).toLocaleString('en-US', { minimumFractionDigits: Math.min(2, d), maximumFractionDigits: d }).replace(/,/g, '\u2060\u2009\u2060'));
  // a decimal string of smallest units, as a number for display (exact enough for display), and exactly
  const units = (s, dec) => { try { const v = BigInt(s || 0); const p = 10n ** BigInt(dec); return Number(v / p) + Number(v % p) / Number(p); } catch { return NaN; } };
  const exact = (s, dec) => { const v = BigInt(s || 0), p = 10n ** BigInt(dec); const f = (v % p).toString().padStart(dec, '0').replace(/0+$/, ''); return `${v / p}${f ? '.' + f : ''}`; };
  const num = (x, max = decShown) => (x == null || !isFinite(x) ? '' : x.toLocaleString('en-US', { maximumFractionDigits: x !== 0 && Math.abs(x) < 1 ? Math.max(max, 6) : max }).replace(/,/g, '\u2060\u2009\u2060'));
  // thousands are set apart by a thin space, not a comma (no mix-up with the decimal point): 132 796.34; word
  // joiners round it keep a number on one line
  const usd = (x) => (x == null || !isFinite(x) ? '' : `$${x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/,/g, '\u2060\u2009\u2060')}`);
  // one way to shorten everywhere: an Ethereum address 0x + its first 6 … its last 6, anything else (a Beam
  // address, a key, a transaction id) its first 6 … its last 6
  const short = (a) => (!a ? '' : /^0x/i.test(a) ? (a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a) : a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-6)}` : a);
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
  // what is wrong with an amount as typed ('' when nothing): said at once under the field, in place of Available
  const amtIssue = (x, dec, max) => {
    const t = String(x).trim().replace(',', '.');
    if (!t) return '';
    if (t === '.') return '';                                      // a point alone: an amount on its way (BB.amountField lets nothing else in)
    if ((t.split('.')[1] || '').length > dec) return `at most ${dec} decimals`;
    if (max != null && Number(t) > max) return 'more than available';
    return '';
  };
  // Send's amount, checked before anything is sent: what is wrong with it shows only on its own line (in place of
  // Available), never beside the button; an empty one asks for it. true: it can go
  // (asked once, the empty field keeps asking through any redraw of its line until something is typed)
  const amtReady = (input, redraw) => {
    input.dataset.need = '1'; redraw();
    return !input.classList.contains('bad');
  };
  // the left of the line under an amount: Available, or what is wrong with the amount (the field outlined)
  const amtLine = (input, left, availHtml, issue) => {
    if (!issue && input.dataset.need && !input.value.trim()) issue = 'enter an amount';
    input.classList.toggle('bad', !!issue);
    const html = issue ? `<span class="warn-own">${esc(issue)}</span>` : availHtml;
    if (left.innerHTML !== html) left.innerHTML = html;      // the same text is not written again (no fade, no blink)
  };
  // An action's error: in yellow right of its button (or under the field a Save/Add button sits in), the field it
  // is about outlined in red, both gone once that field is edited or the action runs again. The field: the one the
  // error was thrown for (fieldErr), else the first of `guess` whose pattern matches the message.
  const fieldErr = (field, text) => Object.assign(new Error(text), { field });
  function actErr(btn, e, guess = {}) {
    const row = btn.closest('.row'), fld = btn.closest('.field');
    let m = row ? row.querySelector('.act-msg') : fld && fld.nextElementSibling && fld.nextElementSibling.classList.contains('act-msg') ? fld.nextElementSibling : null;
    if (!m) {
      m = document.createElement(row ? 'span' : 'p'); m.className = row ? 'act-msg' : 'act-msg under';
      if (row) row.appendChild(m); else (fld || btn).after(m);
    }
    const box = btn.closest('section, .panel') || document;
    qa('.err', box).forEach((x) => x.classList.remove('err'));
    clearTimeout(m._fade); m.classList.remove('ok', 'going');
    m.textContent = e ? msg(e) : '';
    if (!e) return;
    // turned down in its own confirmation ("Call is rejected by user", Beam's word): not an error, no field
    // outlined; it fades as a done word does, after 5 s
    // so is the bridge's "not enough …" (a balance short, said in one line: nothing to fix in a field)
    if (/rejected by user|user rejected|rejected the request|user (closed|cancell?ed)/i.test(msg(e)) || (btn.id === 'bxGo' && /^not enough /i.test(msg(e)))) {
      m._fade = setTimeout(() => {
        m.classList.add('going');
        m._fade = setTimeout(() => { if (m.classList.contains('going')) { m.textContent = ''; m.classList.remove('going'); } }, 600);
      }, 5000);
      return;
    }
    let id = e.field;
    if (!id) for (const [k, re] of Object.entries(guess)) if (re.test(msg(e))) { id = k; break; }
    if (!id && !row && fld) { const i = fld.querySelector('input, textarea'); id = i && i.id; }
    // a field with a line of its own under it (an address's): the error goes there, not beside the button
    const UNDER = { bsAddr: 'bsKind', esTo: 'esToHint' };
    if (id && UNDER[id]) { m.textContent = ''; $(UNDER[id]).innerHTML = `<span class="warn-own">${esc(msg(e))}</span>`; }
    const el = id && $(id), target = el && el.classList.contains('dd') ? el.querySelector('.dd-btn') : el;
    if (target) {
      target.classList.add('err');
      const clear = () => { target.classList.remove('err'); m.textContent = ''; };
      if (el.matches('input, textarea')) el.addEventListener('input', clear, { once: true });
    }
  }
  // An action that went: said in a few words right of its button, as its errors are, in the accent (html: a link).
  // It fades away after 5 s; one still in progress (stay: "sending…") stays until the next word replaces it.
  function actOk(btn, html, stay = false) {
    actErr(btn, null);
    const m = (btn.closest('.row') || btn.parentElement).querySelector('.act-msg');
    if (!m) return;
    clearTimeout(m._fade); m.classList.remove('going');
    m.innerHTML = html; m.classList.add('ok');
    if (stay) return;
    m._fade = setTimeout(() => {
      m.classList.add('going');
      m._fade = setTimeout(() => { if (m.classList.contains('going')) { m.textContent = ''; m.classList.remove('going', 'ok'); } }, 600);
    }, 5000);
  }
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
    el.hidden = !text && !el.classList.contains('keep');      // .keep: its room stays, empty
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
    remove: '<svg viewBox="0 0 24 24"><path d="M3.75 6.75h16.5M9.75 6.75V4.5h4.5v2.25M6 6.75l1.05 12.9a1.5 1.5 0 0 0 1.5 1.35h6.9a1.5 1.5 0 0 0 1.5-1.35l1.05-12.9M10.05 10.5v6.75M13.95 10.5v6.75"/></svg>',      // the trash, as Receive's
  };

  // ---------- state ----------
  let st = null, rates = null, beamStatus = null, ethData = null, feeData = null;
  const W = () => st && st.wallets && st.wallets.find((w) => w.id === st.active);
  // an answer that comes after a switch is another wallet's: drawn only while its wallet is still the open one
  const isOpen = (wid) => !!W() && W().id === wid;
  const acct = () => {
    const w = W();
    if (!w || !w.accounts.length) return null;
    const i = st.activeEth[w.id];
    return w.accounts.find((a) => a.i === i) || w.accounts[0];
  };
  const allAccounts = () => (st && st.wallets ? st.wallets.flatMap((w) => w.accounts.map((a) => ({ ...a, wallet: w }))) : []);
  // ---------- screens, tabs, sheets ----------
  let curTab = 'home';
  // how far the wallet tab's Ethereum card reaches past the end of main's content (into its bottom padding):
  // measured where it shows (fonts differ between systems), so dApps scrolled to its end ends on the same line
  let homeOver = 2;
  function show(id) {
    // a screen left behind takes its action errors with it
    qa(".err").forEach((x) => x.classList.remove("err")); qa(".act-msg").forEach((x) => { x.textContent = ""; });
    qa('[data-need]').forEach((x) => { delete x.dataset.need; });
    if (!$('t-home').hidden) {
      const mm = document.querySelector('main'), e = $('ethCard').getBoundingClientRect();
      if (e.height) homeOver = e.bottom - (mm.getBoundingClientRect().bottom - (parseFloat(getComputedStyle(mm).paddingBottom) || 0));
    }
    qa('.screen').forEach((s) => { s.hidden = s.id !== id; });
    const inside = id.startsWith('t-') || id.startsWith('x-');
    $('tabs').hidden = !inside;
    // adding a wallet from an open one: the way back and Settings beside the lock
    const adding = id === 's-welcome' && !!(st && st.phase === 'unlocked');
    $('setBtn').hidden = !inside && !adding;
    // a sheet (Receive, Send): the way back is the header's arrow beside the lock; dApps, as Settings, closes by
    // its own icon again
    $('backBtn').hidden = !adding && !(id.startsWith('x-') && id !== 'x-dapps');
    $('actBar').hidden = id !== 't-activity';
    $('dappBar').hidden = id !== 'x-dapps';
    $('setBar').hidden = id !== 't-settings';
    // every screen but the wallet tab keeps the scroll bar's room on both sides (wallet.css): main's padding less
    // by as much, so the content lines up with the wallet tab's
    const m = document.querySelector('main');
    m.style.paddingLeft = m.style.paddingRight = m.style.paddingBottom = '';
    if (id !== 't-home' && document.documentElement.classList.contains('popup')) {
      const g = (m.offsetWidth - m.clientWidth) / 2, pad = parseFloat(getComputedStyle(m).paddingLeft) || 0;
      m.style.paddingLeft = m.style.paddingRight = `${Math.max(0, pad - g)}px`;
      if (id === 'x-dapps' || id === 'x-beamRecv' || id === 't-settings') m.style.paddingBottom = `${Math.max(0, (parseFloat(getComputedStyle(m).paddingBottom) || 0) - homeOver)}px`;
    }
    $('setBtn').classList.toggle('on', id === 't-settings');
    $('dappsBtn').hidden = $('setBtn').hidden; $('dappsBtn').classList.toggle('on', id === 'x-dapps');
    // dApps is not part of a tab (as Settings): no tab underlined; Receive, Send and the like stay their tab's
    if (id === 'x-dapps') qa('#tabs a').forEach((a) => { a.classList.remove('active'); a.setAttribute('aria-selected', 'false'); });
    else if (id.startsWith('t-') || id.startsWith('x-')) qa('#tabs a').forEach((a) => { a.classList.toggle('active', a.dataset.tab === curTab); a.setAttribute('aria-selected', String(a.dataset.tab === curTab)); });
    $('brand').hidden = inside;      // the brand on the start and lock screens only: the wallet itself has no room for it
    $('foot').hidden = !inside && id !== 's-unlock' && id !== 's-welcome';      // the copyright line: in the wallet, under the lock and the welcome
    $('walletDd').hidden = !(st && st.wallets && st.wallets.length) || !inside;
    $('lockBtn').hidden = !(st && st.phase === 'unlocked');
    window.scrollTo(0, 0); document.querySelector('main').scrollTop = 0;
  }
  // the last of the main tabs (Wallet, Bridge, Activity, any later one): where Settings and dApps go back to
  let mainTab = 'home';
  function tab(name) {
    // another tab: Beam's tokens folded away at once, so the wallet tab comes back as it was before them
    if (name !== 'home') beamTokens(false, true);
    curTab = name;
    if (name !== 'settings') mainTab = name;
    qa('#tabs a').forEach((a) => { a.classList.toggle('active', a.dataset.tab === name); a.setAttribute('aria-selected', String(a.dataset.tab === name)); });
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
  // the cube: dApps (the connected sites, the catalog)
  // the cube and the gear open dApps and Settings; again, back to the main tab they were opened from
  $('dappsBtn').onclick = () => ($('x-dapps').hidden ? sheet('dapps') : tab(mainTab));
  $('setBtn').onclick = () => tab(curTab === 'settings' && !$('t-settings').hidden ? mainTab : 'settings');

  // The lock leaves nothing typed behind: Send on both networks, the bridge and the token field go back to
  // empty (a fee to its default), the lists to their first choice, the lines under them and any error away.
  function resetForms() {
    for (const el of qa('#x-beamSend input, #x-beamSend textarea, #x-ethSend input, #x-ethSend textarea, #t-bridge input, #t-bridge textarea, #tokAddr')) {
      el.value = el.defaultValue || ''; el.classList.remove('bad', 'err'); delete el.dataset.need; delete el.dataset.touched;
    }
    for (const id of ['bsKind', 'esToHint']) if ($(id)) $(id).textContent = '';
    qa('.err').forEach((x) => x.classList.remove('err')); qa('.act-msg').forEach((x) => { x.textContent = ''; });
    try { bsOwn.set(''); esOwn.set(''); bsAsset.set('0'); esAsset.set('ETH'); } catch {}
    bsType = null; bsMine = ''; esQuote = null;
    bxWallet = null;                                  // the bridge drawn anew at the next open: its typed address gone too
    clearNotes('x-beamSend'); clearNotes('x-ethSend'); clearNotes('t-bridge');
    clearStart();
  }

  // ---------- the dialog: confirm, password, one input ----------
  let dlgBusy = Promise.resolve(), lockN = 0;      // lockN: how many locks so far
  // an Ethereum address field takes no more than an address (42); a pasted one is trimmed first, so spaces round it
  // do not push its last letters out
  for (const id of ['esTo', 'bxAddrIn']) $(id).addEventListener('paste', (e) => {
    const t = (e.clipboardData && e.clipboardData.getData('text')) || '';
    if (t.trim() === t) return;
    e.preventDefault(); e.target.setRangeText(t.trim(), e.target.selectionStart, e.target.selectionEnd, 'end'); e.target.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const NAME_MAX = 32;                                // a wallet's, an account's, an address's name: as the host keeps it (offscreen slice(0, 32))
  const unring = () => { const a = document.activeElement; if (a && a !== document.body && a.matches('button, a, .li[tabindex]')) a.blur(); };
  // and when the popup gets its focus back (a file chooser, the download bubble), the same for the button it lands on
  window.addEventListener('focus', () => setTimeout(() => unring(), 0));
  function ask({ title, before = null, rows = [], note: n = '', password = false, passLabel = 'Wallet password', input = null, yes = 'Confirm', no = 'Cancel', html = null, check = null }) {
    const ln = lockN;      // asked before a lock: not shown after it
    const run = () => new Promise((resolve) => {
      if (ln !== lockN || (before && !before())) return resolve({ ok: false, pass: '', input: '' });     // no longer asked
      $('dTitle').textContent = title;
      $('dBody').innerHTML = html != null ? html : rows.length ? kvHtml(rows) : '';
      $('dNote').textContent = n; $('dNote').hidden = !n;
      $('dPassBox').hidden = !password; $('dPass').value = ''; $('dPassLabel').textContent = passLabel;
      $('dInputBox').hidden = !input; $('dInput').value = input ? input.value || '' : '';
      // the limit said in the label: "Name (up to 32 characters)", or inside its own brackets
      const lim = input && input.max ? `up to ${input.max} characters` : '';
      $('dInputLabel').textContent = !input ? '' : !lim ? input.label : /\)$/.test(input.label) ? input.label.replace(/\)$/, `, ${lim})`) : `${input.label} (${lim})`;
      $('dInput').placeholder = (input && input.placeholder) || '';
      // a name no longer than the wallet keeps (input.max): typing stops there, as the wallet names' own fields
      if (input && input.max) $('dInput').maxLength = input.max; else $('dInput').removeAttribute('maxlength');
      $('dInput').classList.toggle('secret', !!(input && input.secret));
      // a dialog that takes something typed keeps the room for its error, so nothing moves when one shows
      $('dErr').classList.toggle('keep', !!(input || password || check));
      note('dErr', 'bad', ''); $('dInput').classList.remove('err'); $('dPass').classList.remove('err');
      $('dYes').textContent = yes; $('dNo').textContent = no; $('dNo').hidden = !no;
      $('dlg').showModal();
      (password ? $('dPass') : input ? $('dInput') : $('dYes')).focus();
      const inVal = () => (input && input.secret ? $('dInput').value : $('dInput').value.trim());
      // the button that opened it gets the focus back from the dialog, and Chrome would ring it: not a key's focus
      let finished = false, checking = false;      // closed (answered elsewhere too); its check under way
      const done = (ok) => { if (finished) return; finished = true; dlgCancel = null; $('dlg').close(); $('dBody').innerHTML = ''; unring(); resolve({ ok, pass: $('dPass').value, input: inVal() }); $('dPass').value = ''; $('dInput').value = ''; };
      dlgCancel = () => done(false);
      // A check may answer { title, html, note }: the same dialog, still open, then shows that (a seed phrase,
      // a key) with one button. Closing a modal dialog and opening the next at once lost the popup's focus on
      // Windows, and Chrome closes a popup that loses focus.
      let shown = false;
      $('dYes').onclick = async () => {
        if (check && !shown) {
          $('dYes').disabled = true; checking = true;
          let res;
          try { res = await check({ pass: $('dPass').value, input: inVal() }); }
          catch (e) {
            checking = false;
            // closed meanwhile (answered in another window, or the request gone): its answer is not this dialog's
            if (finished) return;
            // in yellow above the buttons, the field outlined in red until it is edited, as on the screens
            note('dErr', 'bad', msg(e)); $('dYes').disabled = false;
            const f = !$('dInputBox').hidden ? $('dInput') : !$('dPassBox').hidden ? $('dPass') : null;
            if (f) { f.classList.add('err'); f.addEventListener('input', () => { f.classList.remove('err'); note('dErr', 'bad', ''); }, { once: true }); }
            return;
          }
          checking = false;
          if (finished) return;
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
      // Cancel and Esc close it while its check runs too (a backup's import takes minutes); what the host does goes on,
      // and the check's late answer is dropped (finished)
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
  // warn: a caution in yellow under the rows (a transfer to the open wallet's own address)
  // A null among the rows starts a group of its own: each group's values line up on its own longest label, so a
  // whole address fits beside short labels (Amount, From, To) while the fee's rows keep theirs
  const kvGroups = (rows) => rows.reduce((g, r) => { if (r === null) g.push([]); else g[g.length - 1].push(r); return g; }, [[]]).filter((g) => g.length);
  function kvHtml(rows) { return kvGroups(rows).map((g) => `<dl class="kv">${g.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`).join(''); }
  const confirmBox = async (title, rows, n, warn = '') => (await ask({ title, note: n,
    html: `${kvHtml(rows)}${warn ? `<p class="warn-own dlg-warn">⚠️ ${esc(warn)}</p>` : ''}` })).ok;

  // Beam's own consent hands amounts and the fee as decimal strings already in coins ("10", "9.64504489",
  // beamAmountToUIString in wasm_beamapi.cpp), not in groth. An asset other than BEAM is named from its
  // metadata (SN=, the short name) when the wallet knows it.
  // asset names (metadata pairs) by asset id, per wallet, from the host's beamAssets (the wallet's own list,
  // then the node's); what is known is kept here, what is missing asked again next time
  const assetMetaDone = new Map();                     // wallet id -> Map(aid -> pairs)
  const assetMeta = async (wid, ids) => {
    if (!assetMetaDone.has(wid)) assetMetaDone.set(wid, new Map());
    const m = assetMetaDone.get(wid), need = ids.filter((a) => a && !m.has(a));
    if (need.length) { try { const r = await host('beamAssets', wid, need); for (const [a, v] of Object.entries(r || {})) m.set(Number(a), v); } catch {} }
    return m;
  };
  // the short name, as Beam's DEX shows it (SN), else the unit's name (UN)
  const assetSym = (m) => (m && (m.SN || m.UN)) || '';
  const assetSymOf = async (aid) => { const w = W(), m = w ? (await assetMeta(w.id, [aid])).get(aid) : null; return assetSym(m); };
  const coins = (v) => { const t = String(v ?? '').trim(); return /^\d+(\.\d+)?$/.test(t) ? t : ''; };
  const consentRows = async (info, amounts) => {
    // an amount by its asset's short name ("0.00003264 bETH"); each asset other than BEAM then has a row
    // of its own with its id ("Asset ID 36 (bETH)"); one the wallet cannot name: "0.5 asset 36", no row
    const rows = [], ids = [];
    for (const a of Array.isArray(amounts) ? amounts : []) {
      const aid = Number(a.assetID ?? a.asset_id ?? 0), n = aid ? await assetSymOf(aid) : 'BEAM';
      rows.push([`Wallet ${a.spend ? 'spends' : 'receives'}`, `${coins(a.amount)} ${n || `asset ${aid}`}`]);
      if (aid && n && !ids.some((x) => x[0] === aid)) ids.push([aid, n]);
    }
    // an asset other than BEAM named as a well-known coin (anyone can make one called BEAM): said so
    const FAMOUS = /^(BEAM|W?BTC|W?ETH|USDT|USDC|DAI|BNB)$/i;
    for (const [aid, n] of ids) rows.push(['Asset ID', `${aid} (${n})${FAMOUS.test(String(n).trim()) ? ` ⚠️ not ${String(n).trim().toUpperCase() === 'BEAM' ? 'BEAM itself' : `the real ${String(n).trim()}`}: a Beam asset of that name` : ''}`]);
    if (info && info.fee != null) rows.push(['Beam net fee', `${coins(info.fee)} BEAM`]);
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
    const rows = [...(c.rows || []), null, ...await consentRows(info, amounts)];
    const r = await ask({ title: c.title, rows, note: c.note, before: () => { consentShown = id; return !consentGone.has(id); } });
    consentShown = null;
    if (!consentGone.has(id)) port && port.postMessage({ type: 'consent', id, ok: r.ok });
  };

  // ---------- a forgotten password ----------
  // It cannot be got back (the vault is sealed with it alone). Said plainly; then, if wanted, everything of the
  // wallets is deleted here and the start screen opens, to bring them back from their seed phrases
  $('forgotPass').onclick = async (e) => {
    e.preventDefault();
    const r = await ask({ title: 'Forgot the password', yes: 'Reset BumbleBeam', no: 'Cancel',
      input: { label: 'To delete it all, type RESET', value: '', placeholder: 'RESET' },
      note: 'The password cannot be recovered: the wallets are encrypted with it alone, and nobody has a copy.\nWhat you can do is start again: every wallet is deleted from this browser, then you restore each one from its seed phrase (or import a backup with the password it was made with). The coins stay on their chains. Beam history and address names come back from an exported wallet data file, accounts imported by a private key only from that key.',
      check: async ({ input }) => { if (input !== 'RESET') throw new Error('type RESET (capital letters) to delete it all'); await host('resetAll', input); } });
    if (!r.ok) return;
    try { await chrome.storage.local.remove(['actKeep']); } catch {}
    keep = null;
    await load(); route();
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
    pwFields();
    if (what === 'bkimport') bmScreen();
    if (what === 'create') { try { return showPhrase(await host('newPhrase')); } catch (e) { return note('s-welcome', 'bad', msg(e)); } }
    clearNotes(`s-${what}`);
    show(`s-${what}`);
  }
  // a BumbleBeam backup on the start screen: with no wallet yet it becomes the wallets (its password the wallet
  // password); from an open wallet, what it has and this one does not is added (both passwords)
  $('bmFileBtn').onclick = () => $('bmFile').click();
  $('bmFile').addEventListener('change', () => { const f = $('bmFile').files && $('bmFile').files[0]; $('bmFileName').textContent = f ? f.name : 'none chosen'; $('bmFileName').classList.toggle('on', !!f); });
  function bmScreen() {
    const open = !!(st && st.phase === 'unlocked');
    $('bmCurBox').hidden = !open;
    $('bmHint').textContent = open
      ? 'The wallets the file has and this extension does not are added. Nothing here is changed.'
      : 'Every wallet in the file comes back: phrases and keys, names, accounts, and Beam history if it was saved with it. The wallet password is then the one the backup was made with.';
  }
  $('doBmImport').onclick = () => longOp('s-bkimport', 'doBmImport', async () => {
    const f = $('bmFile').files && $('bmFile').files[0];
    if (!f) throw new Error('choose the backup file');
    const text = await f.text(), fp = $('bmPass').value;
    if (!fp) throw new Error('the password it was made with');
    if (st && st.phase === 'unlocked') {
      const res = await host('backupImport', text, fp, $('bmCur').value);
      if (!res.added.length) throw new Error(`nothing new in it${res.skipped.length ? `: ${res.skipped.join(', ')} already here` : ''}`);
    } else await host('backupRestore', text, fp);
    $('bmPass').value = ''; $('bmCur').value = ''; $('bmFile').value = ''; $('bmFileName').textContent = 'none chosen';
    curTab = 'home'; await enter();
  });

  // Back from a way of adding a wallet: to the choice of ways (the header's arrow there goes back to the wallet)
  // the start screens leave no phrase, key or password typed behind (Back, and the lock)
  function clearStart() {
    for (const id of ['kKey', 'rSeed', 'bmPass', 'bmCur', 'seedCheck']) if ($(id)) $(id).value = '';
    if ($('seedWords')) $('seedWords').innerHTML = '';
    clearPw();
  }
  qa('[data-back]').forEach((b) => { b.onclick = () => { host('dropPhrase'); clearStart(); welcome(); }; });

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
    $('seedWords').innerHTML = ''; $('cName').value = ''; $('seedCheck').value = ''; clearPw();
    curTab = 'home'; await enter();
  });

  // restore: what kind of phrase it is, as it is typed
  let kindTimer = 0, kindN = 0;
  $('rSeed').oninput = () => {
    clearTimeout(kindTimer);
    const n = ++kindN;
    kindTimer = setTimeout(async () => {
      const p = norm($('rSeed').value);
      if (!p) { $('rKind').textContent = ''; $('rBeamBox').hidden = true; return; }
      let k; try { k = await host('checkPhrase', p); } catch { return; }
      if (n !== kindN) return;      // typed on meanwhile: the newer answer draws
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
  // Enter in a field of a way of adding a wallet (a backup's import, a restore, a key, a new wallet) presses that
  // screen's own button, as on the lock screen
  for (const id of ['s-bkimport', 's-restore', 's-ethkey', 's-create']) $(id).addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.matches('input')) return;
    const b = $(id).querySelector('.row .btn.solid'); if (!b || b.disabled) return;
    e.preventDefault(); b.click();
  });

  // ---------- an account picker's rows dragged to order them ----------
  // The same in every picker (the wallet tab's, the bridge's, a wallet's card in Settings): an account's row held and
  // moved, a line above or below the row it would go to (as Beam's addresses); let go, the wallet's accounts take
  // that order, every picker drawn again from it. Only within one wallet. The lists keep the pointer's mousedown
  // (the focus stays on the button), so this is the pointer's own drag, not the browser's
  function accDrag(list, rowInfo, onOrder) {
    if (list.dataset.drag) return; list.dataset.drag = '1';
    let from = null, sx = 0, sy = 0, moving = false;
    const rows = () => [...list.querySelectorAll('[role="option"]')].filter((li) => rowInfo(li));
    const marks = () => list.querySelectorAll('.drop-above, .drop-below, .dragging').forEach((r) => r.classList.remove('drop-above', 'drop-below', 'dragging'));
    list.addEventListener('pointerdown', (e) => { const li = e.target.closest('[role="option"]'); if (!li || !rowInfo(li) || e.button !== 0) return; from = li; sx = e.clientX; sy = e.clientY; moving = false; });
    list.addEventListener('pointermove', (e) => {
      if (!from) return;
      if (!moving && Math.hypot(e.clientX - sx, e.clientY - sy) < 5) return;
      if (!moving) { moving = true; from.classList.add('dragging'); try { list.setPointerCapture(e.pointerId); } catch {} }
      list.querySelectorAll('.drop-above, .drop-below').forEach((r) => r.classList.remove('drop-above', 'drop-below'));
      const el = document.elementFromPoint(e.clientX, e.clientY), r = el && el.closest('[role="option"]');
      if (!r || r === from || !rowInfo(r) || rowInfo(r).wallet !== rowInfo(from).wallet) return;
      const b = r.getBoundingClientRect(); r.classList.add(e.clientY < b.top + b.height / 2 ? 'drop-above' : 'drop-below');
      // the line on whole pixels (the rows sit at fractions): sharp ends, no bevel
      // on the screen's own pixels (Windows scales by 1.25 and the like): inward, never past the row (the list clips it)
      const k = window.devicePixelRatio || 1, up = (x) => Math.ceil(x * k) / k, dn = (x) => Math.floor(x * k) / k;
      r.style.setProperty('--dl', `${up(b.left) - b.left}px`); r.style.setProperty('--dr', `${b.right - dn(b.right)}px`);
      r.style.setProperty('--dt', `${up(b.top) - b.top}px`); r.style.setProperty('--db', `${b.bottom - dn(b.bottom)}px`);
      r.style.setProperty('--dh', `${Math.max(1, Math.round(2 * k)) / k}px`);
    });
    const end = async (e) => {
      if (!from) return;
      const was = from, moved = moving; from = null; moving = false;
      const to = list.querySelector('.drop-above, .drop-below'), above = to && to.classList.contains('drop-above');
      marks();
      if (!moved) return;
      // a drag is not a pick: the click that follows the pointer's release is swallowed
      list.addEventListener('click', (c) => { c.stopPropagation(); c.preventDefault(); }, { capture: true, once: true });
      if (!to) return;
      const w = rowInfo(was).wallet, ids = rows().filter((li) => rowInfo(li).wallet === w).map((li) => rowInfo(li).i);
      const a = rowInfo(was).i, b = rowInfo(to).i;
      const order = ids.filter((x) => x !== a); order.splice(order.indexOf(b) + (above ? 0 : 1), 0, a);
      try { await host('orderEthAccounts', w, order); } catch (err) { return ask({ title: 'Not moved', note: msg(err), yes: 'OK', no: null }); }
      onOrder();
    };
    list.addEventListener('pointerup', end);
    list.addEventListener('pointercancel', () => { from = null; moving = false; marks(); });
  }
  // after an order changed: every picker drawn again from the wallets as they are now
  async function accOrdered() {
    await load();
    try { renderEth(); } catch {}
    try { if (!$('t-bridge').hidden) fillAccts(); } catch {}
    try { if (!$('t-settings').hidden) drawWallets(); } catch {}
  }

  // ---------- the running wallet ----------
  const walletDd = BB.dropdown($('walletDd'), async (v) => {
    if (v === '__add') { walletDd.set(st.active); return welcome(); }
    // the same place in the wallet chosen: its tab (Wallet, Bridge, Activity, Settings) or dApps, drawn for it; a
    // Receive or Send page (the other wallet's addresses) goes to the Wallet tab. Where one is is read before
    // the switch: the events of the switch (the new wallet's Beam part starting) come in while it is made
    const shown = qa('.screen').find((x) => !x.hidden), was = shown ? shown.id : 't-home';
    try { await host('switchWallet', v); } catch (e) { return ask({ title: 'Not switched', note: msg(e), yes: 'OK', no: null }); }
    await load();
    if (was === 'x-dapps') sheet('dapps');
    else tab(was.startsWith('t-') ? was.slice(2) : 'home');      // Settings stays Settings (its section too), drawn for the wallet chosen
  });
  const acctDd = BB.dropdown($('acctDd'), async (v) => {
    const w = W();
    try {
      if (v === '__add') await host('addEthAccount', w.id);
      else if (v === '__import') { if (!(await importAccount(w))) return load(); }
      else if (v === '__rename') { await renameAccount(); }
      else if (v === '__remove') { await removeAccount(w); return load().then(() => { renderEth(); ethRefresh(); }); }
      else await host('setActiveEth', w.id, Number(v));
    } catch (e) { await ask({ title: v === '__add' || v === '__import' ? 'Not added' : 'Not done', note: msg(e), yes: 'OK', no: null }); }
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
  async function removeAccount(w, a = acct()) {
    if (!a) return;
    if (w.accounts.length < 2) return ask({ title: 'The last account stays', note: 'A wallet keeps at least one Ethereum account. To remove the whole wallet: Settings → Wallets → remove.', yes: 'OK', no: null });
    const rows = [['Account', `${a.name}\n${a.address}`]];      // the name, the whole address on a line of its own
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
  async function renameAccount(w = W(), a = acct()) {
    if (!a) return;
    const r = await ask({ title: 'Rename the account', input: { label: 'Name', value: a.name, max: NAME_MAX }, yes: 'Save',
      check: async ({ input }) => { if (!input) throw new Error('a name, please'); await host('renameEthAccount', w.id, a.i, input); } });
    if (!r.ok) return;
    await load(); ethRefresh();
  }

  async function load() {
    st = await host('state');
    if (st.phase !== 'unlocked') return st;
    walletDd.options([...st.wallets.map((w) => ({ v: w.id, label: w.name })), { group: ' ' }, { v: '__add', label: '+ Add a wallet' }], st.active);
    const w = W();
    if (w && w.accounts.length) {
      const a = acct();
      // the accounts: the name on the left (cut with … if long), the address on the right; a line; then what
      // can be done, each with its icon in a column of its own so the words line up
      const act = (v, icon, text) => ({ v, label: text, html: `<span class="mi">${icon}</span><span>${esc(text)}</span>` });
      acctDd.options([...w.accounts.map((x) => ({ v: String(x.i), label: `${x.name} ${short(x.address)}`, html: `<span class="nm">${esc(x.name)}</span><span class="ad">${short(x.address)}</span>`,
        btn: `<span class="acc-b"><span class="nm">${esc(x.name)}</span><span class="ad">${short(x.address)}</span></span>` })),
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
      accDrag(list, (li) => { const v = li.dataset.v; return v && !v.startsWith('__') ? { wallet: W().id, i: Number(v) } : null; }, accOrdered);
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
          // another wallet opened (here or in another window): no screen keeps the one before's data
          if (switched) {
            const sheet = qa('.screen.sheet').find((x) => !x.hidden && x.id !== 'x-dapps');
            if (sheet) tab('home');
            else if (curTab === 'activity' && !$('t-activity').hidden) activity();
            else if (curTab === 'bridge' && !$('t-bridge').hidden) bridgeOpen();
          }
          if (curTab === 'settings' && !$('t-settings').hidden) { drawWallets(); if (setSec === 'general') bkInfo(); }
          // a wallet's address for My wallets came (read in the background): the open Send lists it
          if (!$('x-beamSend').hidden) bsOwnFill();
          // Receive opened while the Beam part was starting: filled once it runs
          if (!$('x-beamRecv').hidden && !shownAddr && beamHere() && (switched || m.wallet === st.active) && !recvBusy) { recvBusy = true; Promise.resolve(recvOpen()).finally(() => { recvBusy = false; }); }
        });
        break;
      }
      case 'bb_failed': if (progressScreen === 's-progress') note('s-progress', 'bad', m.result); break;
      // the open dialog closed (a key or phrase typed into it goes with it), the waiting ones dropped
      case 'bb_locked': st = null; lockN++; if (dlgCancel) dlgCancel(); resetForms(); route(); break;
      case 'bb_error': if (!$('tabs').hidden) note('bErr', 'bad', m.result); break;
      case 'bb_bridge': if (!$('t-bridge').hidden) listsSoon(); break;
      case 'bb_dapp': if (inWin && st && st.phase === 'unlocked') dappScreen(); else { dappRefresh(); if (!$('x-dapps').hidden) dappListOpen(); } break;
      // a request ended or a site was disconnected (here or in another window): the request window shows
      // what is still waiting (it closes when nothing is); a popup its site's state, the sites list, the balances
      case 'bb_dapp_done':
        if (inWin) { if (!dpBusy && st && st.phase === 'unlocked') dappScreen(); break; }
        dappRefresh();
        if (!$('x-dapps').hidden) dappListOpen();
        if (curTab === 'home' && !$('t-home').hidden) ethRefresh();
        break;
      case 'ev_sync_progress':
        if (m.wallet && st && st.beam && st.beam[m.wallet]) { st.beam[m.wallet].sync = m.result && m.result.total ? { done: m.result.done, total: m.result.total } : null; if (here) renderBeam(); }
        break;
      case 'ev_system_state': case 'ev_utxos_changed': if (here) beamSoon(); break;
      case 'ev_txs_changed': if (here) { beamSoon(); if (!$('t-activity').hidden) actSoon(); } break;      // shown only, and once for a burst
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
  const blockAt = (h) => `block: <b>${esc((h || 0).toLocaleString('en-US').replace(/,/g, '\u2060\u2009\u2060'))}</b>`;
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
  // Activity and the bridge's transfers: a burst of events (a tx's states, one after another) asks once
  let actTimer = 0, listsTimer = 0;
  function actSoon() { clearTimeout(actTimer); actTimer = setTimeout(activity, 400); }
  function listsSoon() { clearTimeout(listsTimer); listsTimer = setTimeout(bridgeLists, 400); }
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
  // the price of one BEAM by the card's name (ui's .price-chip, as on the pool and the explorer); none until the
  // prices come
  const priceFmt = (x) => (x >= 1 ? usd(x) : `$${Number(x.toPrecision(3))}`);
  // a price chip's markup (ui .price-chip): the price, then its 24 h change in red or green; '' with no price
  const pxChip = (p, tip, plain) => {
    if (!(p > 0)) return '';
    // the plain one (ETH's row) reads as a product: 0.0101 ETH × $2 016.97 = the dollars right of it
    return `<span class="${plain ? 'price-plain' : 'price-chip'}"${tip ? ` title="${esc(tip)}"` : ''}>${plain ? '<i class="x">×</i>' : ''}<b>${esc(priceFmt(p))}</b></span>`;
  };
  function beamPriceChip() {
    const p = rates && rates.beam;
    $('beamPx').hidden = !(p > 0);
    if (!(p > 0)) return;
    $('beamPxV').textContent = priceFmt(p);
  }
  function renderBeam() {
    const w = W(), b = beamOf(w);
    $('beamBody').hidden = !(w && w.beam); $('beamNone').hidden = !!(w && w.beam);
    const v = w ? view(w.id) : null, s = b && b.status === 'running' && v ? v.s : null;
    beamStatus = s;
    $('beamCard').classList.toggle('nodata', !s);
    $('beamAvail').textContent = s ? amt(s.available || 0) : '';
    $('beamUsd').textContent = s && rates ? usd((s.available || 0) / GROTH * rates.beam) : '';
    fitBig($('beamAvail'));
    beamPriceChip();
    $('beamMinor').innerHTML = s ? chips(s) : '';
    // another wallet open: its card starts with the tokens folded
    if (!(w && w.beam) || (w && beamTokFor && beamTokFor !== w.id)) beamTokens(false, true); else beamRows();
    beamTokFor = w ? w.id : null;
    if (s && w && (s.totals || []).some((t) => Number(t.asset_id) !== 0 && t.available)) beamPricesLoad(w.id);
    total();
    balancesFollow();
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
  $('beamMeta').onclick = (e) => { if (e.target.closest('[data-go-restore]')) { e.preventDefault(); const w = W(); if (w) walletAct(w, 'restoreBeam'); } };

  // a big amount (24 px) that does not fit its line with its unit and dollars gets smaller, down to 12 px: up to
  // 99 999 999.99999999 BEAM fits the popup
  function fitBig(el) {
    const line = el.parentElement;
    let px = 24;
    el.style.fontSize = '';
    while (px > 12 && line.scrollWidth > line.clientWidth) el.style.fontSize = `${--px}px`;
  }
  // what is not spendable yet, as chips in the explorer's way: one colour per state, "name: amount" (to the
  // hundredth), what each is in its tip; the line scrolls when they do not fit
  function chips(s) {
    const two = (g) => (g / GROTH).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/,/g, '\u2060\u2009\u2060');
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
  // a screen open while its balances come (Send on either network, the bridge) draws them once they do: Available
  // was left empty until the screen was opened again
  function balancesFollow() {
    try {
      if (!$('x-beamSend').hidden) bsAssetFill();
      if (!$('x-ethSend').hidden) { esAsset.options(esTokens().map((x) => ({ v: x.v, label: x.label })), esAsset.value() || 'ETH'); esAvail(); }
      if (!$('t-bridge').hidden) bxCalc();
    } catch {}
  }
  const accAd = () => $('acctDd').querySelector('.acc-b .ad');
  let shownEth = null;                                // the account last drawn: a change of it is animated
  function renderEth() {
    const a = acct();
    $('ethBody').hidden = !a; $('ethNone').hidden = !!a; $('acctDd').hidden = !a;
    ethFor = a ? a.address : null;
    const v = a ? eview(a.address) : null;
    ethData = v && v.d ? v.d : null;
    if (a) {
      // another account than the one shown: its address runs as random hex and settles (BB.decode), on the
      // account's button and on the address line
      if (shownEth && shownEth !== a.address) {
        BB.decode(accAd, short(a.address));            // looked up each frame: a load() meanwhile draws the button again
        BB.decode($('ethAddr'), a.address, 620);
      } else $('ethAddr').textContent = a.address;
      shownEth = a.address;
      if (ethData) ethRows();
      else $('ethAssets').innerHTML = v.err ? `<div class="empty">no Ethereum RPC answers: ${esc(v.err)}</div>` : '<div class="empty">syncing…</div>';
      netDot('ethDot', v.err ? 'down' : '', v.err ? `Ethereum: no RPC answers (${v.err})${ethData ? '; the balances shown may be old' : ''}` : '');
    }
    balancesFollow();
    total();
  }
  // the Ethereum card's rows from the last balances, at the current prices: drawn again when prices come
  // (the balances can arrive first, and their dollars stayed empty)
  // ETH and WBEAM first, always; then the tokens worth $1 or more (dearest first); the others (cheaper, or
  // with no price: mostly airdropped junk) only after "load low-value tokens", until another account is shown.
  // Each token: a link to its contract on Etherscan and a button that copies the contract's address.
  let ethShowLow = null;                              // the address whose low-value tokens are shown
  const LINK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2h5v5M14 2 7.5 8.5M12 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // Links to Beam's chain go to our explorer; when it does not answer (3 s; known for a minute), the same page
  // on Beam's official one: a kernel by the block that holds it (/block?kernel_id=), an asset by its id.
  // Checked 2026-11-09: explorer.beam.mw opens both.
  const EXP = 'https://explorer.bumblebeam.org', EXP_OFF = 'https://explorer.beam.mw';
  let expUp = null;
  async function explorerUp() {
    if (expUp && Date.now() - expUp.at < 60000) return expUp.ok;
    let ok = false;
    try { const r = await fetch(`${EXP}/api/status`, { signal: AbortSignal.timeout(3000), cache: 'no-store' }); ok = r.ok && Number((await r.json()).height) > 0; } catch {}
    expUp = { ok, at: Date.now() };
    return ok;
  }
  const officialOf = (u) => {
    const m = /^https:\/\/explorer\.bumblebeam\.org\/(kernel|asset)\/([0-9a-fA-F]+)/.exec(u);
    return !m ? `${EXP_OFF}/` : m[1] === 'kernel' ? `${EXP_OFF}/block?kernel_id=${m[2]}` : `${EXP_OFF}/asset/${m[2]}`;
  };
  document.addEventListener('click', async (e) => {
    const a = e.target.closest(`a[href^="${EXP}/"]`);
    if (!a || e.button !== 0) return;
    e.preventDefault();
    const url = (await explorerUp()) ? a.href : officialOf(a.href);
    try { await chrome.tabs.create({ url }); } catch { window.open(url, '_blank', 'noopener'); }
  });
  explorerUp();                                       // known before the first click
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
    // ETH's row: its price in the amount column, right-aligned as the tokens' amounts under it
    const row = (r) => (!r.addr ? `<div class="asset native"><span class="lead"><span class="amt">${num(r.v)}</span><span class="unit">${esc(r.sym)}</span></span>${pxChip(rates && rates.eth, '', true)}<span class="usd">${usd(r.u)}</span></div>` : `<div class="asset"><span class="tok">${r.addr ? `<a class="cp" href="https://etherscan.io/token/${esc(r.addr)}" target="_blank" rel="noopener" title="Open on Etherscan">${LINK}</a><button type="button" class="cp" data-cp="${esc(r.addr)}" data-tip-wide title="Copy the token's contract address
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
  let beamTok = false, beamH0 = 0, beamMb0 = 0, beamTokT = 0, beamTokFor = null;
  function beamFit() {
    if (!beamTok) return;
    const c = $('beamCard'), e = $('ethCard').getBoundingClientRect();
    if (!e.height || !c.offsetParent) return;          // not on screen (a sheet over the tab): fitted again when back
    const H = e.bottom - c.getBoundingClientRect().top;
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
    // the Beam card lets through what is under it: Ethereum's goes at once when it grows, and comes back
    // only once it has folded (never seen through the moving card)
    if (on) { const e = $('ethCard'); e.classList.add('still', 'under'); void e.offsetHeight; e.classList.remove('still'); }
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
      const end = () => { if (beamTok) return; b.textContent = 'Tokens'; $('ethCard').classList.remove('under'); c.classList.remove('tok', 'moving'); $('beamAssets').hidden = true; c.style.height = ''; c.style.marginBottom = ''; };
      // at once (another tab, another wallet): no transition at all, the card and Ethereum's just as before
      if (now) { c.classList.add('still'); $('ethCard').classList.add('still'); end(); void c.offsetHeight; c.classList.remove('still'); $('ethCard').classList.remove('still'); }
      else beamTokT = setTimeout(end, 260);
    }
  }
  $('beamTokBtn').onclick = () => beamTokens(!beamTok);
  new ResizeObserver(() => beamFit()).observe($('ethCard'));
  let beamRowsSeq = 0, beamNamesT = 0;
  async function beamRows() {
    if (!beamTok) return;
    const w = W(), s = beamStatus, seq = ++beamRowsSeq;
    if (!s) { $('beamAssets').innerHTML = '<div class="empty">syncing…</div>'; return; }
    // as Ethereum's: the dearest first, then those with no price (by asset id)
    const list = (s.totals || []).filter((t) => Number(t.asset_id) !== 0 && (t.available || t.receiving || t.maturing))
      .sort((x, y) => (beamTokUsd(Number(y.asset_id), y.available) ?? -1) - (beamTokUsd(Number(x.asset_id), x.available) ?? -1) || Number(x.asset_id) - Number(y.asset_id));
    if (!list.length) { $('beamAssets').innerHTML = '<div class="empty">no tokens in this wallet</div>'; return; }
    // the rows at once (named from what is known), again once the names come; a name still missing is
    // asked for again in 15 s while the list is open
    const known = w && assetMetaDone.get(w.id), ids = list.map((t) => Number(t.asset_id));
    // a name that comes in place of 'asset N' fades in, as anything that loads later
    const draw = (meta) => {
      const before = new Map(qa('#beamAssets .sym[data-aid]').map((x) => [x.dataset.aid, x.textContent]));
      $('beamAssets').innerHTML = list.map((t) => {
      const aid = Number(t.asset_id), sym = assetSym(meta.get(aid)) || `asset ${aid}`;
      return `<div class="asset"><span class="tok"><a class="cp" href="https://explorer.bumblebeam.org/asset/${aid}" target="_blank" rel="noopener" title="Open in the explorer">${LINK}</a><button type="button" class="cp" data-cp="${aid}" title="Copy the asset id
${aid}">${CPI}</button></span><span class="sym" data-aid="${aid}">${esc(sym)}</span><span class="amt">${num((t.available || 0) / GROTH)}</span><span class="usd">${usd(beamTokUsd(aid, t.available))}</span></div>`;
      }).join('');
      for (const x of qa('#beamAssets .sym[data-aid]')) if (/^asset \d+$/.test(before.get(x.dataset.aid) || '') && !/^asset \d+$/.test(x.textContent)) fadeIn(x);
    };
    draw(known || new Map());
    if (!w) return;
    let meta = known;
    if (!known || ids.some((a) => !known.has(a))) {
      meta = await assetMeta(w.id, ids);
      if (seq !== beamRowsSeq || !beamTok) return;
      draw(meta);
      clearTimeout(beamNamesT);
      if (ids.some((a) => !meta.has(a))) beamNamesT = setTimeout(() => { if (beamTok) beamRows(); }, 15000);
    }
    if (beamPricesFresh(w.id)) return;
    await beamPricesLoad(w.id);
    if (seq === beamRowsSeq && beamTok) draw(meta || new Map());
  }
  // the tokens' dollars: their price in BEAM from Beam DEX's pools (the host's beamPrices), times BEAM's
  let beamPx = { wid: null, at: 0, p: {} }, beamPxP = null;
  const beamPricesFresh = (wid) => beamPx.wid === wid && Date.now() - beamPx.at < 60000;
  function beamPricesLoad(wid) {
    if (beamPricesFresh(wid)) return Promise.resolve();
    if (beamPxP && beamPxP.wid === wid) return beamPxP;
    const p = host('beamPrices', wid).then((x) => { beamPx = { wid, at: Date.now(), p: x || {} }; total(); }, () => { beamPx = { wid, at: Date.now(), p: {} }; })      // a failure rests a minute too
      .finally(() => { if (beamPxP === p) beamPxP = null; });
    p.wid = wid; beamPxP = p;
    return p;
  }
  const beamTokUsd = (aid, groth) => { const w = W(), px = w && beamPx.wid === w.id ? beamPx.p[aid] : undefined; return rates && px > 0 ? ((groth || 0) / GROTH) * px * rates.beam : null; };
  $('beamAssets').onclick = (e) => { const c = e.target.closest('[data-cp]'); if (c) copyFlash(c, c.dataset.cp); };

  function total() {
    if (!rates) { $('totalUsd').textContent = ''; $('totalCh').textContent = ''; return; }
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
      beamPriceChip();
    } catch {}
  }

  $('ethAddNew').onclick = async () => {
    const w = W(); let made = false;
    // made in the window itself (an error shows there in yellow), which then shows the phrase
    const r = await ask({ title: 'Create Ethereum accounts', note: 'A new Ethereum seed phrase for this wallet. It is shown once now: write it down. Settings → Wallets shows it again with the password.', yes: 'Create',
      check: async () => {
        const phrase = await host('addEthPart', w.id, { kind: 'new' });
        made = true;
        return phrase ? { title: 'Your Ethereum seed phrase', html: `<ol class="seed">${phrase.split(' ').map((x) => `<li>${esc(x)}</li>`).join('')}</ol>`, note: 'It restores this wallet\'s Ethereum accounts here, in MetaMask or Rabby. The Beam part has its own phrase (or backup file).', yes: 'Written down' } : null;
      } });
    if (!r.ok && !made) return;      // made, then closed with Esc: the accounts are there all the same
    await load(); ethRefresh();
  };
  $('ethAddImport').onclick = async () => {
    const w = W();
    const r = await ask({ title: 'Import into this wallet', input: { label: 'An Ethereum seed phrase (12 or 24 words) or a private key', secret: true }, yes: 'Import',
      check: async ({ input }) => {
        const isKey = await host('isEthKey', input);
        if (!isKey && !(await host('checkPhrase', input)).eth) throw new Error('neither a BIP-39 phrase nor a 64-hex private key');
        await host('addEthPart', w.id, isKey ? { kind: 'key', key: input } : { kind: 'phrase', phrase: input });
      } });
    if (!r.ok) return;
    await load(); ethRefresh();
  };

  // ---------- sheets ----------
  const ADDR_HINT = {
    regular: 'Give it to the sender. Online while this wallet is the open one and unlocked. The transfer completes while both wallets are online. The popup may be closed.',
    offline: 'Takes payments while this wallet is off: as many as the one-time keys inside it (5 in one made here; Payments shows how many are left), then more while it is online. The coins arrive shielded. For many payments use public offline.',
    max_privacy: 'One payment, maximum anonymity (the shielded pool). The coins mature over a while before they can be spent.',
    public_offline: 'Public offline: any number of payments, also while this wallet is off (a pool\'s payouts, an exchange, donations). The coins arrive shielded and mature for a while. Less private than the others: all payments go to one public key.',
  };
  // Receive shows the newest address of the chosen type (made once if there is none); "New address" makes
  // another. "My addresses" lists every address this wallet made, with the payments that came in to each
  // (tx_list joined on the address: Beam's chain has no addresses, so the wallet's own records are all there is).
  const TYPE_NAME = { regular: 'regular', regular_new: 'regular', offline: 'offline', max_privacy: 'max privacy', public_offline: 'public offline' };
  let addrs = [], shownAddr = null;
  // the favourites first (a star on the row), then the others, each newest first
  let favs = new Set();
  // Beam's own list, and the addresses added manually (the host keeps them): those are this wallet's only as far
  // as a payment to them shows it, so each is verified once its history has an incoming transfer that names it
  // true when drawn; false when another wallet was opened meanwhile (its answer is not drawn)
  async function loadAddrs() {
    const wid = W().id;
    const [list, fav, ext] = await Promise.all([host('beam', wid, 'addr_list', { own: true }), host('addrFavs', wid).catch(() => []), host('addrExt', wid).catch(() => [])]);
    if (!isOpen(wid)) return false;      // an older answer: the favourites are another wallet's
    favs = new Set(fav); favOrder = fav.slice();
    const own = new Set(list.map((x) => x.address));
    // an address once verified stays so: only the others are checked
    const open = ext.filter((e) => !e.verified);
    let txs = [];
    if (open.length) txs = (await host('beam', wid, 'tx_list', { count: 1000 }).catch(() => [])).filter((t) => t.income && t.receiver).map((t) => String(t.receiver));
    if (!isOpen(wid)) return false;
    // a public offline address is this wallet's when it carries the wallet's own offline key (Beam makes every
    // public offline address of a wallet from one key of its seed): the same long run of bytes as one it made
    // (and against the wallet's kept reference: the list may have none of its own)
    const mine = list.filter((x) => x.type === 'public_offline').map((x) => b58(x.address));
    if (open.some((e) => e.type === 'public_offline')) { const ref = await host('offlineRef', wid).catch(() => null); if (ref) mine.push(b58(ref)); }
    if (!isOpen(wid)) return false;
    const added = ext.filter((e) => !own.has(e.address)).map((e) => {
      if (e.verified) return { address: e.address, comment: e.name, type: e.type, create_time: e.at / 1000, ext: true, verified: true, key: e.verified === 'key', n: 0 };
      const n = txs.filter((rc) => rc === e.address || tokenHas(e.address, rc)).length;      // a payment TO it (not one from it): its receiver is the token, or its SBBS id inside it
      const key = e.type === 'public_offline' && mine.some((m) => sameRun(m, b58(e.address)) >= 64);
      // verified now: kept, never checked again
      if (key || n > 0) host('setAddrExt', wid, { ...e, verified: key ? 'key' : 'payment' }).catch(() => {});
      return { address: e.address, comment: e.name, type: e.type, create_time: e.at / 1000, ext: true, verified: key || n > 0, n, key };
    });
    // one added by hand that is now among Beam's own (an import gave Beam its key number): still marked as added,
    // and verified (Beam took it as this seed's), its verification kept
    const extOf = new Map(ext.map((e) => [e.address, e]));
    const ownMarked = list.map((x) => {
      const e = extOf.get(x.address); if (!e) return x;
      if (!e.verified) host('setAddrExt', wid, { ...e, verified: 'own' }).catch(() => {});
      return { ...x, ext: true, verified: true, key: e.verified === 'key' && x.type === 'public_offline', own: true };      // the offline key only says it of a public offline one
    });
    addrs = [...ownMarked, ...added].sort(byFav);
    renderAddrs();
    return true;
  }
  // favourites first, in their order (the last marked on top, or as dragged), then the others oldest first: a new
  // address goes to the end
  let favOrder = [];
  const favAt = (a) => { const i = favOrder.indexOf(a); return i < 0 ? Infinity : i; };
  // base58 to bytes, and the longest run two byte strings share (checked 2026-11-10: two public offline addresses of
  // one wallet share 206 bytes, of two wallets at most 12)
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const b58 = (str) => {
    let v = 0n; for (const ch of str) { const i = B58.indexOf(ch); if (i < 0) return new Uint8Array(0); v = v * 58n + BigInt(i); }
    const out = []; while (v > 0n) { out.unshift(Number(v & 255n)); v >>= 8n; }
    return Uint8Array.from(out);
  };
  // An address has two forms: its token (what is handed out: the long base58 string) and its SBBS id (hex, what a
  // transaction names as sender or receiver). The token carries the SBBS id inside it
  const tokHex = new Map();
  const tokenHas = (token, sbbs) => {
    if (!token || !sbbs || !/^[0-9a-f]{40,}$/i.test(String(sbbs))) return false;
    if (!tokHex.has(token)) tokHex.set(token, [...b58(token)].map((x) => x.toString(16).padStart(2, '0')).join(''));
    return tokHex.get(token).includes(String(sbbs).toLowerCase().replace(/^0+/, ''));
  };
  const sameRun = (a, b) => {
    let best = 0;
    for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
      if (a[i] !== b[j] || (i && j && a[i - 1] === b[j - 1])) continue;
      let k = 0; while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
      if (k > best) best = k;
    }
    return best;
  };
  const byFav = (p1, p2) => (favAt(p1.address) - favAt(p2.address)) || (p1.create_time || 0) - (p2.create_time || 0);
  const sameType = (x, type) => x.type === type || (type === 'regular' && x.type === 'regular_new');
  const ago2 = (sec) => (sec ? fdate(sec * 1000) : '');
  // an address past its expiry (Beam says so, or its time is up): its row tinted red (ui .li.bad)
  const addrExpired = (x) => (!x.ext || x.own) && (!!x.expired || (x.duration > 0 && (x.create_time + x.duration) * 1000 < Date.now()));
  const expiry = (x) => (x.ext && !x.own ? (x.type === 'public_offline' ? 'never' : 'unknown') : x.expired ? 'expired' : !x.duration ? 'never' : fdate((x.create_time + x.duration) * 1000));
  // My addresses: a row each (one added manually and not verified: its name in yellow): a star (a favourite: filled,
  // first in the list, the last marked on top or as dragged), its name (else the address,
  // shortened), its type right, the trash that removes it; the one shown above stays lit
  const XI = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';      // the list's cross, as the icons
  const STAR = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2l1.8 3.7 4 .6-2.9 2.8.7 4L8 11.2 4.4 13.1l.7-4L2.2 6.3l4-.6z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  function renderAddrs() {
    $('addrList').innerHTML = addrs.map((x, k) => `<div class="li addr${x.address === shownAddr ? ' on' : ''}${addrExpired(x) ? ' bad' : ''}${favs.has(x.address) ? ' fav-row' : ''}" data-k="${k}"${favs.has(x.address) ? ' draggable="true"' : ''}>
      <button type="button" class="cp fav${favs.has(x.address) ? ' is' : ''}" data-fav="${k}" title="${favs.has(x.address) ? 'A favourite: first in the list. Click to unmark' : 'Mark as a favourite: first in the list'}">${STAR}</button>
      <span class="a-name${x.ext && !x.verified ? ' unver' : ''}"${x.ext && !x.verified ? ' title="⚠️ Added manually, not verified: no payment to it found in this wallet yet"' : ''}>${esc(x.comment || short(x.address))}</span>
      <span class="a-t">${esc(TYPE_NAME[x.type] || x.type)}</span><button type="button" class="cp a-x" data-del="${k}" title="${x.ext && !x.own ? 'Remove it from this list' : 'Remove this address'}">${XI}</button></div>`).join('') || '<div class="empty">none yet</div>';
  }
  function showAddr(x) {
    shownAddr = x.address;
    host('setRecvSel', W().id, x.address).catch(() => {});      // opened next time on it, until the lock
    $('beamAddr').textContent = x.address; $('beamQrWrap').hidden = false;
    // right of the QR: its name (Unnamed in grey when it has none), its type, when it was made, when it expires, its length
    $('beamAddrName').textContent = x.comment || 'Unnamed'; $('beamAddrName').classList.toggle('dim', !x.comment);
    const tKey = Object.keys(ADDR_HINT).find((t) => sameType(x, t));
    $('beamAddrType').innerHTML = tKey ? `<span class="tipped" title="${esc(ADDR_HINT[tKey])}">${esc(TYPE_NAME[x.type] || x.type)}</span>` : esc(TYPE_NAME[x.type] || x.type);
    $('beamAddrMade').textContent = ago2(x.create_time);
    $('beamAddrExp').textContent = expiry(x);
    $('beamAddrLen').textContent = String(x.address.length);      // how long it is: 67 for a regular one, hundreds for the offline kinds
    // an address added manually: whether a payment to it showed it is this wallet's
    $('beamAddrStK').hidden = $('beamAddrSt').hidden = !x.ext;
    // why it counts as this wallet's: the tip says how it was verified (or how it would be)
    const vTip = x.own && !x.key ? 'Added manually, then taken by Beam as this wallet\'s own from imported wallet data: Beam checked its key number against this seed phrase'
      : x.key ? 'Added manually: a public offline address carrying this wallet\'s own offline key (Beam makes every public offline address of a wallet from one key of its seed phrase)'
      : 'Added manually: a payment to it arrived and shows in this wallet\'s history (one sent from another of your wallets counts the same: only this wallet can take it)';
    $('beamAddrSt').innerHTML = !x.ext ? '' : x.verified ? `<span class="tipped" title="${esc(vTip)}">verified</span>`
      : '<span class="tipped" title="Added manually: whose an address of this kind is cannot be checked. It becomes verified once a payment to it shows in this wallet\'s history, or imported wallet data makes it Beam\'s own">not verified</span>';
    $('beamAddrSt').classList.toggle('warn', !!x.ext && !x.verified);
    addrPayments(x);
    // an address too long for a QR code (an offline one of 10 keys, ~3,200 symbols): its words only, copied
    try { BB.qr($('beamQr'), x.address, QR_SIZE); $('beamQr').classList.remove('too-long'); $('saveBeamQr').hidden = false; }
    catch { $('beamQr').innerHTML = '<span>too long for a QR code: copy it</span>'; $('beamQr').classList.add('too-long'); $('saveBeamQr').hidden = true; }
    renderAddrs();
  }
  // An offline or max privacy address carries one-time keys (Beam's vouchers): each payment to it takes one. How many
  // it carries Beam tells (validate_address: payments); the payments that came to it are counted from the history.
  // Offline: once a sender has none left, its wallet asks this one for new keys over Beam's messages (they come
  // while this wallet is open and online). Max privacy: one key, one payment.
  const vouchersIn = new Map();      // address -> keys it carries (fixed in the address)
  async function addrPayments(x) {
    const box = [$('beamAddrPayK'), $('beamAddrPay')], wid = W().id;
    const kind = x.type === 'offline' ? 'offline' : x.type === 'max_privacy' ? 'max' : '';
    box.forEach((el) => { el.hidden = !kind; }); $('beamAddrPay').textContent = kind ? '…' : '';
    if (!kind) return;
    try {
      let n = vouchersIn.get(x.address);
      // max privacy: always one key (Beam's GenerateMaxPrivacyToken; validate_address counts only an offline one's)
      if (n == null && kind === 'max') n = 1;
      if (n == null) { const v = await host('beam', wid, 'validate_address', { address: x.address }); n = v && v.payments != null ? Number(v.payments) : null; }
      if (!(n > 0)) { if (shownAddr === x.address) $('beamAddrPay').textContent = 'unknown'; return; }
      vouchersIn.set(x.address, n);
      const txs = await host('beam', wid, 'tx_list', { count: 1000 }).catch(() => []);
      const nid = (v) => String(v || '').toLowerCase().replace(/^0+/, '');
      // an offline payment (a push) to it: a regular transfer to the same SBBS id used no key of it
      const got = txs.filter((t) => t.income && t.receiver && t.status !== 2 && t.status !== 4 && /push/i.test(t.tx_type_string || '')
        && ((x.wallet_id && nid(t.receiver) === nid(x.wallet_id)) || t.receiver === x.address || tokenHas(x.address, String(t.receiver)))).length;
      if (shownAddr !== x.address || W().id !== wid) return;
      const left = Math.max(0, n - got);
      const tip = kind === 'max'
        ? `A max privacy address carries one one-time key: it takes one payment. ${got ? 'It has had its payment: make a new one for the next.' : 'Make a new one for each payment.'}`
        : `It carries ${n} one-time key${n === 1 ? '' : 's'}: each payment to it takes one (${got} came so far). When a sender's wallet has none left, it asks this wallet for new ones over Beam's messages: they come while this wallet is open and online, so a payment then waits for that. A sender keeps its own copy of the address: counted here from the payments that came.`;
      $('beamAddrPay').innerHTML = `<span class="tipped${left ? '' : ' warn'}" title="${esc(tip)}">${left} of ${n} left</span>`;
    } catch { if (shownAddr === x.address) $('beamAddrPay').textContent = 'unknown'; }
  }
  const QR_SIZE = BB.qrSizes.s;                       // the receive cards' QR: ui's size S (180 px), the popup's width
  async function newAddress(type, comment = '') {
    const a = await host('beam', W().id, 'create_address', { type, expiration: type === 'public_offline' ? 'never' : 'auto', comment, ...(type === 'offline' ? { offline_payments: 5 } : {}) });      // 5 one-time keys (the API alone gives 1; Beam's desktop 10, ~3,200 symbols: too long for a QR code; 5 ~1,700)
    if (!(await loadAddrs())) return;
    showAddr(addrs.find((x) => x.address === a) || { address: a, type, comment, create_time: Date.now() / 1000, duration: 0 });
  }
  // Receive opens on (in this order) the address shown last since the unlock (the host remembers it), else the
  // first favourite, else the first in the list; never an unverified one added manually, even shown last or a
  // favourite. No address is ever made by itself: with none, New makes one.
  let recvBusy = false;      // Receive being filled on an event: one at a time
  async function recvOpen() {
    note('x-beamRecv', 'bad', '');
    // nothing of the wallet shown before stays on screen while this one's addresses come
    addrs = []; shownAddr = null; $('beamQrWrap').hidden = true; $('addrList').innerHTML = '<div class="empty">loading…</div>';
    // its Beam part still starting (the popup opened straight on Receive): no error, it opens by itself once it runs
    if (!beamHere()) { $('addrList').innerHTML = '<div class="empty">Beam is starting… the addresses show once it runs</div>'; return; }
    try {
      const [sel, fresh] = await Promise.all([host('recvSel', W().id).catch(() => null), loadAddrs()]);
      if (!fresh) return;
      openDefault(sel);
    } catch (e) { note('x-beamRecv', 'bad', msg(e)); }
  }
  function openDefault(sel) {
    const ok = (y) => !(y.ext && !y.verified);
    const x = addrs.find((y) => y.address === sel && ok(y)) || addrs.find((y) => favs.has(y.address) && ok(y)) || addrs.find(ok);
    if (x) return showAddr(x);
    shownAddr = null; $('beamQrWrap').hidden = true;
    if (!addrs.length) $('addrList').innerHTML = '<div class="empty">no address yet: New makes one</div>';
  }
  // New: a window to choose the type (each with what it is), and a name if wanted
  // two addresses never share a name (an empty one, Unnamed, may repeat); the case does not make it another
  const nameTaken = (name, except) => { const n = String(name || '').trim().toLowerCase(); return n ? addrs.find((x) => x.address !== except && String(x.comment || '').trim().toLowerCase() === n) : null; };
  const nameCheck = (except) => ({ input }) => { const x = nameTaken(input, except); if (x) throw new Error(`another address is named "${String(x.comment).trim()}" already`); };
  let newType = 'regular';      // the type picked in New's window (the window's content is gone once it closes)
  $('newAddr').onclick = async () => {
    newType = 'regular';
    const types = ['regular', 'offline', 'public_offline', 'max_privacy'];
    const html = `<div class="seg mini" id="newType">${types.map((t, k) => `<button type="button" data-t="${t}"${k ? '' : ' class="on"'}>${esc(TYPE_NAME[t])}</button>`).join('')}</div><div class="hint type-hints" id="newTypeHint">${types.map((t, k) => `<span data-t="${t}"${k ? ' class="off"' : ''}>${esc(ADDR_HINT[t])}</span>`).join('')}</div>`;
    const r = await ask({ title: `New ${TYPE_NAME.regular} address`, html, input: { label: 'Name (visible only to you)', value: '', placeholder: 'optional', max: NAME_MAX }, yes: 'Create', check: nameCheck(null) });
    if (!r.ok) return;
    try { await newAddress(newType, r.input || ''); } catch (e) { note('x-beamRecv', 'bad', msg(e)); }
  };
  document.addEventListener('click', (e) => {
    const b = e.target.closest('#newType button'); if (!b) return;
    qa('#newType button').forEach((x) => x.classList.toggle('on', x === b)); newType = b.dataset.t;
    qa('#newTypeHint span').forEach((x) => x.classList.toggle('off', x.dataset.t !== b.dataset.t));
    $('dTitle').textContent = `New ${TYPE_NAME[b.dataset.t]} address`;      // the window's title names the type chosen
  });
  $('saveBeamQr').onclick = () => { const x = addrs.find((y) => y.address === shownAddr); BB.qrSave($('beamAddr').textContent, `beam-${(x && x.type) || 'address'}-address`, 'png'); };
  $('nameBeamAddr').onclick = async (e) => {
    e.preventDefault();
    const x = addrs.find((y) => y.address === shownAddr), wid = W().id;
    if (!x) return;
    const r = await ask({ title: 'Name the address', input: { label: 'Name (visible only to you)', value: x.comment || '', max: NAME_MAX }, yes: 'Save', check: nameCheck(x.address) });
    if (!r.ok) return;
    try {
      if (!isOpen(wid)) return;      // another wallet opened meanwhile: the address is not its
      if (x.ext && !x.own) await host('setAddrExt', wid, { address: x.address, name: r.input, type: x.type, at: x.create_time * 1000, verified: x.verified ? (x.key ? 'key' : 'payment') : undefined });
      else await host('beam', wid, 'edit_address', { address: x.address, comment: r.input });      // Beam's own (one added by hand too, once an import made it Beam's)
      if (!(await loadAddrs())) return; showAddr(addrs.find((y) => y.address === x.address) || x);
    }
    catch (e) { note('x-beamRecv', 'bad', msg(e)); }
  };
  // removes an address once asked (it stops taking payments): the list's trash and the card's
  async function removeAddr(x) {
    if (!x) return;
    const wid = W().id, lo = x.ext && !x.own;      // only the list's: Beam does not know it
    const r = await ask({ title: lo ? 'Remove it from the list' : 'Remove this address', rows: [['Address', short(x.address)], ['Name', x.comment || 'Unnamed'], ['Type', TYPE_NAME[x.type] || x.type]],
      note: lo ? 'Only this list forgets it: payments to it are not affected.' : 'It stops taking payments. Coins it already brought stay in the wallet.', yes: 'Remove' });
    if (!r.ok) return;
    try {
      if (!isOpen(wid)) return;      // another wallet opened meanwhile: nothing removed from it
      if (!lo) await host('beam', wid, 'delete_address', { address: x.address });
      if (x.ext) await host('setAddrExt', wid, null, x.address);
      const was = x.address === shownAddr;
      if (!(await loadAddrs())) return;
      if (was) openDefault(null);
    } catch (er) { note('x-beamRecv', 'bad', msg(er)); }
  }
  // Add: an address of this wallet that Beam does not list. A public offline address is checked before it is added:
  // Beam makes every public offline address of a wallet from one key of its seed, so it must carry the same key as
  // one this wallet makes. The other kinds come from keys numbered by the wallet that made them, so whose they are
  // cannot be told: added not verified (a payment to it in the history, or an import of wallet data, verifies it)
  $('addAddr').onclick = async () => {
    // checked in the window itself: what is wrong shows there in yellow, the window stays open
    const wid = W().id;
    const r = await ask({ title: 'Add an address', input: { label: 'Address', value: '' },
      note: 'A public offline address is checked to belong to this wallet\'s seed phrase. An address of another kind is added not verified (in yellow): it becomes verified once a payment to it shows in this wallet\'s history, or an imported wallet data file makes it Beam\'s own.', yes: 'Add',
      check: async ({ input }) => {
        const a = String(input || '').trim();
        if (!a) throw new Error('paste the address');
        const v = await host('beam', wid, 'validate_address', { address: a });
        if (!v || !v.is_valid) throw new Error('that is not a valid Beam address');
        if (addrs.some((x) => x.address === a)) throw new Error('this address is in the list already');
        // another kind cannot be checked: added as it is, not verified yet
        if (v.type !== 'public_offline') { await host('setAddrExt', wid, { address: a, name: '', type: v.type, at: Date.now() }); return; }
        // this wallet's own public offline addresses and its kept reference to compare with
        const mine = [...addrs.filter((x) => !x.ext && x.type === 'public_offline').map((x) => x.address), await host('offlineRef', wid).catch(() => null)].filter(Boolean);
        if (!mine.some((m) => sameRun(b58(m), b58(a)) >= 64)) throw new Error('this public offline address belongs to another seed phrase, not this wallet\'s');
        await host('setAddrExt', wid, { address: a, name: '', type: v.type, at: Date.now(), verified: 'key' });
      } });
    if (!r.ok) return;
    try {
      if (!(await loadAddrs())) return;
      const x = addrs.find((y) => y.address === r.input); if (x) showAddr(x);
    } catch (e) { note('x-beamRecv', 'bad', msg(e)); }
  };
  $('delBeamAddr').onclick = () => removeAddr(addrs.find((y) => y.address === shownAddr));
  // dragging a favourite among the favourites: a line shows where it goes, the order is kept
  let dragK = -1;
  const favRow = (e) => { const r = e.target.closest('.li.addr.fav-row'); return r && $('addrList').contains(r) ? r : null; };
  const clearMarks = () => qa('#addrList .drop-above, #addrList .drop-below').forEach((r) => r.classList.remove('drop-above', 'drop-below'));
  $('addrList').addEventListener('dragstart', (e) => { const r = favRow(e); if (!r) return e.preventDefault(); dragK = Number(r.dataset.k); r.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
  $('addrList').addEventListener('dragend', () => { dragK = -1; clearMarks(); qa('#addrList .dragging').forEach((r) => r.classList.remove('dragging')); });
  $('addrList').addEventListener('dragover', (e) => {
    const r = favRow(e); if (dragK < 0 || !r) return;
    e.preventDefault(); clearMarks();
    const b = r.getBoundingClientRect(); r.classList.add(e.clientY < b.top + b.height / 2 ? 'drop-above' : 'drop-below');
  });
  $('addrList').addEventListener('drop', async (e) => {
    const r = favRow(e); if (dragK < 0 || !r) return;
    e.preventDefault();
    const above = r.classList.contains('drop-above'); clearMarks();
    const moved = addrs[dragK].address, target = addrs[Number(r.dataset.k)].address;
    if (moved === target) return;
    const order = favOrder.filter((a) => a !== moved);
    order.splice(order.indexOf(target) + (above ? 0 : 1), 0, moved);
    favOrder = order; addrs.sort(byFav); renderAddrs();
    try { favOrder = await host('setAddrFavOrder', W().id, order); } catch (er) { note('x-beamRecv', 'bad', msg(er)); }
  });
  $('addrList').onclick = async (e) => {
    // the trash: this address removed, once asked
    const del = e.target.closest('[data-del]');
    if (del) return removeAddr(addrs[Number(del.dataset.del)]);
    // the star: a favourite or not, and the list sorted again
    const fv = e.target.closest('[data-fav]');
    if (fv) {
      const x = addrs[Number(fv.dataset.fav)]; if (!x) return;
      try { favOrder = await host('setAddrFav', W().id, x.address, !favs.has(x.address)); favs = new Set(favOrder); } catch (er) { return note('x-beamRecv', 'bad', msg(er)); }
      addrs.sort(byFav);
      return renderAddrs();
    }
    const row = e.target.closest('[data-k]'); if (!row) return;
    const x = addrs[Number(row.dataset.k)];
    if (!x) return;
    showAddr(x);
    $('beamQrWrap').scrollIntoView({ block: 'nearest' });
  };
  $('copyBeamAddr').onclick = () => copyFlash($('copyBeamAddr'), $('beamAddr').textContent);

  // my other Beam wallets as receivers: the offline address each keeps for this (made once it has run)
  const bsOwn = BB.dropdown($('bsOwn'), (v) => { if (v) { $('bsAddr').value = v; $('bsAddr').oninput(); } });
  // one of the other wallets' addresses added by hand and not verified: whose ("Main, not verified"), or ''
  const otherUnver = (address) => { for (const w of st.wallets) { if (w.id === st.active) continue; const a = (w.beamAddresses || []).find((x) => x.address === address && x.unverified); if (a) return w.name; } return ''; };
  function bsOwnFill() {
    const others = st.wallets.filter((w) => w.beam && w.id !== st.active);
    // each other wallet by its offline and public offline addresses (both take a payment while it does not run),
    // its name and the address's name left, the kind right; one with none known is listed greyed
    const rows = [];
    for (const w of others) {
      const l = (w.beamAddresses && w.beamAddresses.length) ? w.beamAddresses : w.beamAddress ? [{ address: w.beamAddress, type: 'public_offline', name: '' }] : [];
      rows.push({ group: w.name });
      if (!l.length) { rows.push({ v: `-${w.id}`, label: w.name, disabled: true, html: `${esc(w.name)}: no offline address known yet` }); continue; }
      for (const a of l) rows.push({ v: a.address, label: `${w.name} | ${a.name || TYPE_NAME[a.type] || a.type}`, html: `<span class="nm${a.unverified ? ' unver' : ''}">${esc(a.name || short(a.address))}</span><span class="ad">${a.unverified ? 'not verified, ' : ''}${esc(TYPE_NAME[a.type] || a.type)}</span>` });      // one added by hand and not verified in yellow: a payment to it that arrives verifies it
    }
    const cur = $('bsAddr').value.trim();      // a redraw (the state changed) keeps the one picked while it is still there
    bsOwn.options([{ v: '', label: 'My wallets…' }, ...rows], rows.some((x) => x.v === cur) ? cur : '');
    $('bsOwn').hidden = $('bsOwnL').hidden = !others.length;
  }
  // the asset to send: BEAM, then every asset this wallet holds (named as on the card); the fee is BEAM's
  const bsAsset = BB.dropdown($('bsAsset'), () => { $('bsAmt').value = ''; bsAvail(); });
  const bsHeld = () => ((beamStatus && beamStatus.totals) || []).filter((t) => Number(t.asset_id) !== 0 && t.available);
  async function bsAssetFill() {
    const w = W(), held = bsHeld(), ids = held.map((t) => Number(t.asset_id));
    const opts = (m) => [{ v: '0', label: 'BEAM' }, ...held.map((t) => ({ v: String(t.asset_id), label: assetSym(m.get(Number(t.asset_id))) || `asset ${t.asset_id}` }))];
    const keep = held.some((t) => String(t.asset_id) === bsAsset.value()) ? bsAsset.value() : '0';
    bsAsset.options(opts((w && assetMetaDone.get(w.id)) || new Map()), keep);
    $('bsAsset').classList.toggle('one', !held.length);
    if (w && ids.length) { const m = await assetMeta(w.id, ids); if (W() && W().id === w.id) bsAsset.options(opts(m), bsAsset.value() || keep); }
    bsAvail();
  }
  const bsAid = () => Number(bsAsset.value() || 0);
  const bsSym = () => { const o = $('bsAsset').querySelector('.dd-btn'); return (o && o.textContent.trim()) || 'BEAM'; };
  const bsHave = () => { const aid = bsAid(); if (!aid) return (beamStatus && beamStatus.available) || 0; const t = bsHeld().find((x) => Number(x.asset_id) === aid); return t ? t.available : 0; };
  function bsAvail() {
    const have = bsHave(), max = beamStatus ? Math.max(0, have - (bsAid() ? 0 : beamFee())) / GROTH : null;
    // the amount white, its unit grey after it (as on the fee)
    amtLine($('bsAmt'), $('bsLeft'), (beamStatus ? `<span class="all"><span class="lb">available</span> <b>${esc(amt(have))}</b> <span class="unit">${esc(bsSym())}</span></span>` : ''), amtIssue($('bsAmt').value, 8, max));
    $('bsFee').innerHTML = `${esc(amt(beamFee(), 8))} <span class="unit">BEAM</span>`;
  }
  // every amount field takes only digits and one point (or comma), BB.amountField: nothing else gets in to be
  // complained about; at most 8 digits before the point (up to 99 999 999). Beam's and WBEAM's amounts at most
  // 8 decimals (a groth); Ethereum's Send by its token's decimals, said under it as before (the bridge's amount: its
  // own section)
  BB.amountField($('bsAmt'), 8, 8);
  BB.amountField($('esAmt'), null, 8);
  $('bsAmt').oninput = () => { delete $('bsAmt').dataset.need; bsAvail(); };
  let bsType = null, bsMine = '';      // the address's type; whether it is the open wallet's own ('yes', 'unverified')
  const kindRow = (k, v, more = '') => `<span class="k">${esc(k)}:</span> <span class="v">${esc(v)}</span>${more ? ` <span class="k">${esc(more)}</span>` : ''}`;
  $('bsAddr').oninput = async () => {
    const a = $('bsAddr').value.trim();
    // My wallets follows the field: another wallet's address picks its name, anything else "My wallets…"
    const hit = !!a && st.wallets.some((w) => w.id !== st.active && (w.beamAddress === a || (w.beamAddresses || []).some((x) => x.address === a)));
    bsOwn.set(hit ? a : '');
    bsType = null; bsMine = ''; $('bsKind').textContent = ''; bsAvail();
    if (!a || !beamHere()) return;
    // Beam's validate_address calls almost any word a valid token, so the shape is checked first: an SBBS
    // address is 60-70 hex characters, a token (offline, max privacy, the new regular) a long base58 string
    if (!/^[0-9a-fA-F]{60,70}$/.test(a) && !/^[1-9A-HJ-NP-Za-km-z]{80,}$/.test(a)) { $('bsKind').innerHTML = '<span class="warn-own">not a Beam address</span>'; return; }
    try {
      const v = await host('beam', W().id, 'validate_address', { address: a });
      if ($('bsAddr').value.trim() !== a) return;          // an older answer for an address since changed
      if (!v.is_valid) { $('bsKind').innerHTML = '<span class="warn-own">not a valid Beam address</span>'; return; }
      bsType = v.type;
      // an address of the open wallet itself (Beam lists it, or one added manually and verified): the coins
      // would come back to it, so it is said with a caution
      // Beam says is_mine for its own SBBS addresses only, not for its tokens (offline, max privacy, public
      // offline): those are looked up in the wallet's own list, and among those added manually and verified
      // one added manually and not verified yet is said so ("unverified")
      let mine = v.is_mine ? 'yes' : '';
      if (!mine) {
        const [own, ext] = await Promise.all([host('beam', W().id, 'addr_list', { own: true }).catch(() => []), host('addrExt', W().id).catch(() => [])]);
        const x = (ext || []).find((y) => y.address === a);
        mine = (own || []).some((y) => y.address === a) || (x && x.verified) ? 'yes' : x ? 'unverified' : '';
      }
      if ($('bsAddr').value.trim() !== a) return;
      bsMine = mine;
      // the type, then a caution for one's own wallet, then what the address has left, each by its emoji
      const left = v.payments != null ? `${v.payments} payment${v.payments === 1 ? '' : 's'} left` : '';
      $('bsKind').innerHTML = kindRow('Address type', TYPE_NAME[v.type] || v.type || 'regular')
        + (mine ? ` <span class="warn-own">⚠️ your current wallet${mine === 'unverified' ? ' (unverified)' : ''}</span>` : '') + (left ? ` <span class="k">ℹ️ ${esc(left)}</span>` : '');
      bsAvail();
    } catch {}
  };
  const beamFee = () => (bsType === 'offline' || bsType === 'max_privacy' || bsType === 'public_offline' ? 1100000 : 100000);
  // All: the whole of a token (the fee is paid in BEAM), BEAM less the fee
  // Available is All, as the bridge's balance: a click sends all of it (but the fee)
  $('bsLeft').onclick = (e) => {
    if (!e.target.closest('.all')) return; const a = bsHave(), keep = bsAid() ? 0 : beamFee(); $('bsAmt').value = Math.max(0, (a - keep) / GROTH).toFixed(8).replace(/\.?0+$/, '') || '0'; bsAvail(); };
  $('doBeamSend').onclick = async () => {
    clearNotes('x-beamSend'); actErr($('doBeamSend'), null);
    if ($('doBeamSend').disabled) return;
    $('doBeamSend').disabled = true;
    try {
      const wid = W().id;      // the wallet the confirmation names is the one that sends (another chosen meanwhile: nothing goes)
      const address = $('bsAddr').value.trim();
      if (!address) throw fieldErr('bsAddr', 'paste the address');
      await $('bsAddr').oninput();
      if (bsType === null) throw fieldErr('bsAddr', 'not a valid Beam address');
      if (!amtReady($('bsAmt'), bsAvail)) return;
      const value = toGroth($('bsAmt').value), fee = beamFee(), aid = bsAid(), sym = bsSym(), beam = (beamStatus && beamStatus.available) || 0;
      if (!(value > 0)) throw new Error('the amount must be above zero');
      if (!aid && value + fee > beam) throw new Error(`not enough: ${amt(beam, 8)} BEAM available, ${amt(value + fee, 8)} needed with the fee`);
      if (aid && value > bsHave()) throw new Error(`not enough: ${amt(bsHave(), 8)} ${sym} available`);
      if (aid && fee > beam) throw new Error(`the fee is paid in BEAM: ${amt(fee, 8)} needed, ${amt(beam, 8)} available`);
      if (!(await confirmBox(`Send ${sym}`, [['From wallet', W().name], ['Amount', `${amt(value, 8)} ${sym}`], ...(aid ? [['Asset ID', String(aid)]] : []), ['Network fee', `${amt(fee, 8)} BEAM`], ['To', address], ['Address type', TYPE_NAME[bsType] || bsType || 'regular']],
        bsType === 'regular' || bsType === 'regular_new' || !bsType ? 'A regular transfer completes when both wallets are online: keep this browser open until it does.' : '',
        bsMine ? `your current wallet${bsMine === 'unverified' ? ' (unverified)' : ''}: the coins come back to it, less the fee`
          : otherUnver(address) ? `${otherUnver(address)}: added there by hand and not verified. If the address is that wallet's, this payment verifies it. If not, the coins go to whoever it belongs to.` : ''))) return;
      if (!isOpen(wid)) throw new Error('another wallet was opened meanwhile: nothing was sent');
      // to an offline address: an offline payment (Beam's API since 6.0 makes it a regular, online one unless asked: the receiver then has to be online)
      const r = await host('beam', wid, 'tx_send', { value, fee, address, asset_id: aid, comment: $('bsNote').value.trim() || undefined, ...(bsType === 'offline' ? { offline: true } : {}) });
      actOk($('doBeamSend'), `transaction ${esc(r.txId)} sent`);
      // to a regular address of another of one's wallets: it completes once that wallet is opened (this one keeps
      // running meanwhile, its transfer under way)
      if ((bsType === 'regular' || bsType === 'regular_new') && st.wallets.some((w) => w.id !== st.active && (w.beamAddresses || []).some((x) => x.address === address))) ask({ title: 'Now open the other wallet', note: 'A regular transfer completes when both wallets are online. Switch to the receiving wallet (the picker at the top): this one keeps running until its transfer is done.', yes: 'OK', no: null });
      $('bsAmt').value = ''; delete $('bsAmt').dataset.need; $('bsNote').value = ''; bsAvail();
      beamRefresh();
    } catch (e) { actErr($('doBeamSend'), e, { bsAmt: /amount|enough|decimal|available|zero|fee/i, bsAddr: /address|token/i }); }
    finally { $('doBeamSend').disabled = false; }
  };

  const esAsset = BB.dropdown($('esAsset'), () => { esQuote = null; esAvail(); esFee(true); });
  function esTokens() {
    const list = [{ v: 'ETH', label: 'ETH', dec: 18, bal: ethData ? ethData.eth : '0', token: null }];
    for (const t of (ethData ? ethData.tokens : [])) list.push({ v: t.address, label: t.symbol, dec: t.decimals, bal: t.balance || '0', token: { address: t.address, decimals: t.decimals, symbol: t.symbol } });
    return list;
  }
  const esCur = () => esTokens().find((x) => x.v === esAsset.value()) || esTokens()[0];
  // the fee, from the chain (the host's ethFeeQuote): asked when the screen opens, the asset or the address
  // changes; paid in ETH whatever is sent
  let esQuote = null, esQSeq = 0, esQT = 0;
  function esFee(now) {
    clearTimeout(esQT);
    esQT = setTimeout(async () => {
      const a = acct(), c = esCur(), seq = ++esQSeq;
      if (!a) return;
      const to = $('esTo').value.trim();
      try { const q = await host('ethFeeQuote', a.address, isEthAddress(to) ? to : '', c.token ? c.token.address : null); if (seq === esQSeq) { esQuote = q; esAvail(); } }
      catch { if (seq === esQSeq) { esQuote = null; esAvail(); } }
    }, now ? 0 : 400);
  }
  function esAvail() {
    const c = esCur(), f = esQuote ? units(esQuote.feeNow, 18) : null;
    // its two parts made once; then each written only when its text changes, so typing an amount does not
    // redraw the line (it blinked: the fade took each redraw for new data)
    if (!$('esLeft')) $('esAvail').innerHTML = '<span id="esLeft"></span><span id="esRight"></span>';
    const rightHtml = `<span><span class="tipped" title="${esc(`Gas for this transfer at today's base fee and tip${f != null && rates ? ` (${usd(f * rates.eth)})` : ''}. Paid in ETH whatever is sent.`)}">network fee</span> <b class="fee-v eth">${f == null ? '…' : `≈ ${esc(num(f, 6))} <span class="unit">ETH</span>`}</b></span>`;
    if ($('esRight').innerHTML !== rightHtml) $('esRight').innerHTML = rightHtml;
    amtLine($('esAmt'), $('esLeft'), ethData ? `<span class="all"><span class="lb">available</span> <b>${esc(num(units(c.bal, c.dec), 8))}</b> <span class="unit">${esc(c.label)}</span></span>` : '', amtIssue($('esAmt').value, c.dec, units(c.bal, c.dec)));
  }
  $('esAmt').oninput = () => { delete $('esAmt').dataset.need; esAvail(); };
  // All: the whole of a token; of ETH, all but the most the transfer may cost (its quote, else 0.002 ETH)
  $('esAvail').onclick = (e) => {      // (its left part, Available, is made with the line)
    if (!e.target.closest('.all')) return;
    const c = esCur();
    if (c.token) $('esAmt').value = exact(c.bal, c.dec);
    else { const keepWei = esQuote ? BigInt(esQuote.feeMax) : 2n * 10n ** 15n; const v = BigInt(c.bal) > keepWei ? BigInt(c.bal) - keepWei : 0n; $('esAmt').value = exact(v.toString(), 18); }
    esAvail();
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
      // as the account picker on the wallet tab: the name left, 0x+6…6 right; on the button name | address, the
      // address left out when the name does not leave it room
      for (const a of list) {
        const ad = short(a.address);
        opts.push({ v: a.address, label: `${a.name} ${ad}`, html: `<span class="nm">${esc(a.name)}</span><span class="ad">${ad}</span>`,
          btn: `<span class="acc-b"><span class="nm">${esc(a.name)}</span><span class="ad">${ad}</span></span>` });
      }
    }
    esOwn.options(opts, '');
    $('esOwn').hidden = $('esOwnL').hidden = opts.length < 2;
  }
  $('esTo').oninput = () => {
    const t = $('esTo').value.trim();
    // My accounts follows the field: one of one's accounts picks its name, anything else "My accounts…"
    const oa = allAccounts().find((x) => x.address.toLowerCase() === t.toLowerCase() && (!acct() || x.address.toLowerCase() !== acct().address.toLowerCase()));
    esOwn.set(oa ? oa.address : '');
    const own = allAccounts().find((a) => a.address.toLowerCase() === t.toLowerCase());
    esFee();
    // one's own account: another wallet's by its name (grey label, white name); the open wallet's own, in
    // yellow as on BEAM Send
    $('esToHint').innerHTML = !t ? '' : !isEthAddress(t) ? '<span class="warn-own">0x and 40 hex characters</span>'
      // the sending account itself: cautioned; another account of this wallet: its name; another wallet's: that wallet
      : own ? (acct() && own.address.toLowerCase() === acct().address.toLowerCase() ? '<span class="warn-own">⚠️ the account you send from</span>'
        : own.wallet.id === st.active ? `<span class="k">Your account:</span> <span class="v">${esc(own.name)}</span>`
        : `<span class="k">Your wallet:</span> <span class="v">${esc(own.wallet.name)}</span>`)
      : Object.values(st.contracts).includes(t.toLowerCase()) ? '<span class="warn-own">a contract, not a person: tokens sent to it are lost. For the bridge use the Bridge tab</span>' : '';
  };
  $('doEthSend').onclick = async () => {
    clearNotes('x-ethSend'); actErr($('doEthSend'), null);
    $('doEthSend').disabled = true;
    try {
      const c = esCur(), a = acct(), to = $('esTo').value.trim();
      if (!to) throw fieldErr('esTo', 'paste the address');
      if (!isEthAddress(to)) throw fieldErr('esTo', '0x and 40 hex characters');
      if (Object.values(st.contracts).includes(to.toLowerCase())) throw fieldErr('esTo', 'that is the WBEAM token or the bridge contract: tokens sent there are lost. Use the Bridge tab');
      if (!amtReady($('esAmt'), esAvail)) return;
      const p = await host('ethPrepare', { from: a.address, to, amount: $('esAmt').value, token: c.token });
      const feeNow = units(p.feeNow, 18), feeMax = units(p.feeMax, 18);
      // the amount in dollars at today's price, after a bar: ETH's, WBEAM's market, a token's from its list
      const wb = c.token && c.token.address.toLowerCase() === st.contracts.wbeam;
      const tok = c.token && ethData ? ethData.tokens.find((x) => x.address.toLowerCase() === c.token.address.toLowerCase()) : null;
      const unitUsd = !rates ? null : !c.token ? rates.eth : wb ? (rates.wbeam || rates.beam) : tok && tok.usd ? tok.usd : null;
      const inUsd = unitUsd ? ` | ≈ ${usd(Number(p.amountExact) * unitUsd)}` : '';
      const ok = await confirmBox(`Send ${p.symbol}`, [
        ['Amount', `${p.amountExact} ${p.symbol}${inUsd}`], ['From', `${a.name} ${short(a.address)}`], ['To', p.to],
        // the fee it should cost (gas estimate x today's base fee + tip), and the most it can (gas limit x max fee per gas)
        ['Network fee', `≈ ${num(feeNow, 6)} ETH${rates ? ` | ${usd(feeNow * rates.eth)}` : ''}`],
        ['Max fee', `${num(feeMax, 6)} ETH${rates ? ` | ${usd(feeMax * rates.eth)}` : ''}`],
        // under them what each goes by: the gas price (the fee), the gas limit (the max fee)
        ['Gas base', `${p.baseGwei.toFixed(2)} gwei`], ['Gas limit', Number(p.gasLimit).toLocaleString('en-US').replace(/,/g, '\u2060\u2009\u2060')]],
        'Signed here and sent through a public Ethereum RPC.\nIt cannot be undone.',
        a.address.toLowerCase() === p.to.toLowerCase() ? 'the account you send from: the tokens come back to it, only the gas is spent' : '');
      if (!ok) return;
      const hash = await host('ethSend', p.id);
      actOk($('doEthSend'), `transaction <a class="text-link" href="https://etherscan.io/tx/${esc(hash)}" target="_blank" rel="noopener">${esc(short(hash))}</a> sent`);
      $('esAmt').value = ''; delete $('esAmt').dataset.need; esAvail();
      setTimeout(ethRefresh, 15000);
    } catch (e) { actErr($('doEthSend'), e, { esAmt: /amount|enough|decimal|number|separator|zero/i, esTo: /address|contract|0x/i }); }
    finally { $('doEthSend').disabled = false; }
  };

  const SHEETS = {
    beamRecv: () => recvOpen(),
    beamSend: () => { bsOwnFill(); bsAssetFill(); if ($('bsAddr').value) $('bsAddr').oninput(); },
    ethRecv: () => {
      const a = acct(); $('ethRecvAddr').textContent = a.address; $('ethRecvName').textContent = a.name;
      // its nonce (transactions sent) and ENS name (when it has one), from the network
      // (shown once they come: nothing while they load, nothing if the network does not answer)
      // its EIP-7702 delegation (the contract its account runs, or none), and the ENS name's avatar: a row only
      // with the name and only when the record is there and its picture loads (drawn by ENS's metadata service,
      // which reads every kind of record: a link, ipfs://, an NFT)
      const pair = (k) => [$(k + 'K'), $(k)];
      for (const k of ['ethRecvNonce', 'ethRecvEns', 'ethRecvAva', 'ethRecvDel']) for (const e of pair(k)) e.hidden = true;
      $('ethRecvAvaImg').removeAttribute('src');
      host('ethInfo', a.address).then((i) => {
        if (!acct() || acct().address !== a.address) return;
        const show = (k) => { for (const e of pair(k)) e.hidden = false; };
        $('ethRecvNonce').textContent = String(i.nonce); show('ethRecvNonce');
        if (i.ens) { $('ethRecvEns').textContent = i.ens; show('ethRecvEns'); }
        if (i.ens && i.avatar) {
          const img = $('ethRecvAvaImg');
          img.onload = () => { if (acct() && acct().address === a.address) show('ethRecvAva'); };
          img.onerror = () => {};
          img.src = `https://metadata.ens.domains/mainnet/avatar/${encodeURIComponent(i.ens)}`;
        }
        if (i.delegate !== undefined) {
          $('ethRecvDel').innerHTML = i.delegate
            ? `<a class="text-link" href="https://etherscan.io/address/${esc(i.delegate)}" target="_blank" rel="noopener" title="Delegated by EIP-7702: this account runs the code of ${esc(i.delegate)}">${esc(short(i.delegate))}</a>`
            : '<span class="tipped" title="EIP-7702: the account runs no contract&#39;s code, it is a plain account">none</span>';
          show('ethRecvDel');
        }
      }, () => {});
      BB.qr($('ethQr'), a.address, QR_SIZE);
    },
    dapps: () => dappListOpen(),
    ethSend: () => { esAsset.options(esTokens().map((x) => ({ v: x.v, label: x.label })), esAsset.value() || 'ETH'); esQuote = null; esAvail(); esOwnFill(); $('esTo').oninput(); esFee(true); },
  };
  // the account's own actions, as in its menu: renamed (the card shows the new name), removed (back to the wallet)
  $('renEthAcct').onclick = async () => { try { await renameAccount(); } catch (e) { return ask({ title: 'Not renamed', note: msg(e), yes: 'OK', no: null }); } await load(); renderEth(); const a = acct(); if (a) $('ethRecvName').textContent = a.name; };
  $('delEthAcct').onclick = async () => {
    const w = W(), before = acct() && acct().address;
    try { await removeAccount(w); } catch (e) { return ask({ title: 'Not removed', note: msg(e), yes: 'OK', no: null }); }
    await load(); renderEth(); ethRefresh();
    if (!acct() || acct().address !== before) tab('home');
  };
  $('saveEthQr').onclick = () => BB.qrSave($('ethRecvAddr').textContent, 'ethereum-address', 'png');
  $('copyEthAddr').onclick = () => copyFlash($('copyEthAddr'), $('ethRecvAddr').textContent);

  // ---------- Bridge ----------
  // Two cards, From over To, the switch between them turning the way round (the content tears and comes back the
  // other way). Beam's side: the wallet's Beam part, its name and dot in its card's corner, its bridge key when it
  // receives. Ethereum's side: an account (the wallet tab's picker, laid over its place in the card), or any address
  // typed in when it receives. The bridge is 1 : 1: what is sent arrives whole, the relayer's fee is paid on top of
  // it. (Worked out in lab/bridge.html.)
  let dir = 'toEth', level = 'normal';
  let cur = '', mine = '', other = '';               // the account picked (an address, or 'typed'), the last own one, the address typed
  const FE_FEE = '0.02';                              // WBEAM -> BEAM: the relayer takes no minimum; recent transfers paid 0.02
  const wbOf = {};                                    // an Ethereum address -> { wbeam, eth } (numbers), as last read
  const keyOf = {};                                   // a wallet -> its Beam part's bridge key
  const PEN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/></svg>';
  const bx = document.querySelector('.bx'), bxCards = [$('bxSend'), $('bxRecv')];
  const opt = () => (feeData ? feeData.options.find((o) => o.key === level) || feeData.options[0] : null);
  // the fee towards Ethereum: the gauge's level's ("auto"), or one typed into the Beam card's corner
  let feeOwn = null;
  const feeNow = () => (feeOwn != null ? feeOwn : opt() ? opt().fee : null);
  // the needle by the fee itself: -60° at cheap, 0° at normal, 60° at safe, on a smooth scale between them, leaning
  // further under cheap (to the relayer's minimum) and over safe (to twice it)
  function feeAngle(f) {
    const o = feeData.options, pts = [[feeData.min, -85], [o[0].fee, -60], [o[1].fee, 0], [o[2].fee, 60], [o[2].fee * 2, 85]];
    if (f <= pts[0][0]) return -88;
    for (let i = 1; i < pts.length; i++) if (f <= pts[i][0]) { const [a, x] = pts[i - 1], [b, y] = pts[i]; return b > a ? x + (y - x) * (f - a) / (b - a) : y; }
    return 88;
  }
  const feeLow = (f) => !!feeData && f != null && f < feeData.min;
  const feeHigh = (f) => !!feeData && f != null && f > feeData.options[feeData.options.length - 1].fee * 2;
  const ownAccts = () => { const w = W(); return [...(w ? w.accounts.map((a) => ({ ...a, wallet: w })) : []), ...allAccounts().filter((a) => !w || a.wallet.id !== w.id)]; };
  const addrOf = (v) => (v === 'typed' ? other : v);
  const beamHave = () => (beamStatus && beamStatus.available != null ? beamStatus.available / GROTH : null);

  // the Ethereum account's picker: the wallet tab's look (name | short address; the accounts scroll past 4, this
  // wallet's first, the others' under their names); going to Ethereum, "Enter an address" below them
  const bxAcct = BB.dropdown($('bxAcct'), (v) => {
    if (v === '__type') { bxAcct.set(cur); return typeIn(); }
    pick(v);
  });
  const bxAccAd = () => $('bxAcct').querySelector('.acc-b .ad');
  function fillAccts() {
    const row = (v, nm, ad) => ({ v, label: `${nm} ${short(ad)}`, html: `<span class="nm">${esc(nm)}</span><span class="ad">${short(ad)}</span>`,
      btn: `<span class="acc-b"><span class="nm">${esc(nm)}</span><span class="ad">${short(ad)}</span></span>` });
    const w = W(), rows = [];
    let group = null;
    for (const a of ownAccts()) {
      if (a.wallet.id !== (w && w.id) && a.wallet.id !== group) { group = a.wallet.id; rows.push({ group: a.wallet.name }); }
      rows.push(row(a.address, a.name, a.address));
    }
    if (dir === 'toEth' && other) rows.push(row('typed', 'Other address', other));
    const acts = dir === 'toEth' ? [{ sep: true }, { v: '__type', label: 'Enter an address', html: `<span class="mi">${PEN}</span><span>Enter an address</span>` }] : [];
    bxAcct.options([...rows, ...acts], cur);
    accDrag($('bxAcct').querySelector('.dd-list'), (li) => { const x = allAccounts().find((y) => y.address === li.dataset.v); return x ? { wallet: x.wallet.id, i: x.i } : null; }, accOrdered);
    // the accounts (and the other wallets' names) in a box of their own that scrolls past 4, the action below it
    const list = $('bxAcct').querySelector('.dd-list'), box = document.createElement('li'), ul = document.createElement('ul');
    box.className = 'dd-scroll'; box.setAttribute('role', 'presentation'); ul.setAttribute('role', 'group');
    for (const li of [...list.children]) { if (li.classList.contains('dd-sep') || (li.dataset.v || '').startsWith('__')) break; ul.appendChild(li); }
    box.appendChild(ul); list.insertBefore(box, list.firstChild);
    bxStill();
  }
  function pick(v, run = true) {
    const was = cur;
    cur = v; if (v !== 'typed') mine = v;
    bxAcct.set(v);
    if (run && v !== was) BB.decode(bxAccAd, short(addrOf(v)));
    bxStill(); readEth(addrOf(v)); bxCalc();
    toMain(v);
  }
  // one of the open wallet's accounts picked on the bridge is the wallet tab's too (as the wallet tab's picked follows
  // here); once the picking stops (the wheel steps through several)
  let toMainTimer = 0;
  function toMain(v) {
    clearTimeout(toMainTimer);
    const w = W(), a = w && w.accounts.find((x) => x.address === v);
    if (!a || (acct() && acct().address === v)) return;
    toMainTimer = setTimeout(async () => {
      if (!isOpen(w.id)) return;      // another wallet opened meanwhile
      try { await host('setActiveEth', w.id, a.i); bxMain = v; await load(); renderEth(); ethRefresh(); } catch { /* the wallet tab keeps its own */ }
    }, 400);
  }
  // an Ethereum address's WBEAM (and ETH, for gas): read, then drawn
  async function readEth(a) {
    if (!isEthAddress(a)) return;
    try {
      const d = await host('ethBalances', a);
      const wb = d.tokens.find((t) => t.address.toLowerCase() === st.contracts.wbeam);
      wbOf[a.toLowerCase()] = { wbeam: units(wb ? wb.balance : '0', 8), eth: units(d.eth, 18), raw: wb ? wb.balance : '0' };
    } catch { wbOf[a.toLowerCase()] = { err: true }; }
    bxCalc();
  }
  const wbAt = (a) => (a ? wbOf[a.toLowerCase()] : null);
  // the still copy in the card, and the picker laid over it
  function bxStill() { $('bxGearBox').innerHTML = `<div class="dd compact acct"><button type="button" class="dd-btn" tabindex="-1">${$('bxAcct').querySelector('.dd-btn').innerHTML}</button></div>`; }
  function bxLay() {
    const b = bx.getBoundingClientRect(), r = $('bxGearBox').getBoundingClientRect();
    if (!r.width) return;                             // the tab hidden: laid when it shows
    Object.assign($('bxAcct').style, { left: `${r.left - b.left}px`, top: `${r.top - b.top}px`, width: `${r.width}px` });
    // the copy's field: the page's gradient, fixed to the window, is drawn inside a torn (moved) strip as if the whole
    // page were the button; its own place in the window says where it is cut from
    const g = $('bxGearBox').style;
    g.setProperty('--gx', `${-r.left}px`); g.setProperty('--gy', `${-r.top}px`); g.setProperty('--gw', `${innerWidth}px`); g.setProperty('--gh', `${innerHeight}px`);
    // the fee field likewise: its torn copies cut from the gradient where the field stands
    const fi = $('bxFeeIn').getBoundingClientRect(), fs = $('bxFeeBox').style;
    if (fi.width) { fs.setProperty('--gx', `${-fi.left}px`); fs.setProperty('--gy', `${-fi.top}px`); fs.setProperty('--gw', `${innerWidth}px`); fs.setProperty('--gh', `${innerHeight}px`); }
  }
  addEventListener('resize', bxLay);
  // and whenever the cards change size: a scroll bar that comes (the transfers loaded) narrows them, and the picker,
  // laid over its place by figures, stayed where it was (nearer the right edge below than on top)
  new ResizeObserver(() => { if (!turning) bxLay(); }).observe(bx);
  // an address typed in, in the picker's place: Enter (or leaving it) with a good address takes it, Escape (or
  // leaving it empty) puts the account back
  function typeIn() { const inp = $('bxAddrIn'); $('bxAcct').classList.add('typing'); inp.hidden = false; inp.value = ''; inp.classList.remove('bad'); inp.focus(); }
  function typed(take) {
    const inp = $('bxAddrIn'), v = inp.value.trim();
    if (take && v && !isEthAddress(v)) { inp.classList.add('bad'); return false; }
    inp.hidden = true; inp.value = ''; $('bxAcct').classList.remove('typing');      // emptied: a later blur takes nothing
    if (take && v) { other = v; cur = 'none'; fillAccts(); pick('typed'); }
    return true;
  }
  $('bxAddrIn').onkeydown = (e) => { if (e.key === 'Enter') typed(true); if (e.key === 'Escape') typed(false); };
  $('bxAddrIn').oninput = () => $('bxAddrIn').classList.remove('bad');
  $('bxAddrIn').onblur = () => { if (!$('bxAddrIn').hidden && !typed(true)) typed(false); };
  // the wheel over it steps through one's own accounts, without opening the list
  let wheelAt = 0;
  $('bxAcct').querySelector('.dd-btn').addEventListener('wheel', (e) => {
    const l = ownAccts();
    if (!l.length) return;
    e.preventDefault();
    const now = performance.now();
    if (now - wheelAt < 180) return;
    wheelAt = now;
    const k = Math.max(0, l.findIndex((a) => a.address === mine));
    pick(l[(k + (e.deltaY > 0 ? 1 : -1) + l.length) % l.length].address);
  }, { passive: false });

  // each side in its card: its network on the title line (Beam's key at the bottom left when it receives),
  // Ethereum's picker
  const capMeter = document.createElement('canvas').getContext('2d');
  // the middle of a word's capitals in its card, from the card's padding edge (as top is): its baseline less half a
  // capital's height, read from the font
  function capMid(word, card) {
    if (!word || !word.getClientRects().length) return null;
    word.insertAdjacentHTML('beforeend', '<i style="display:inline-block;width:0;height:0"></i>');
    const baseY = word.lastElementChild.getBoundingClientRect().top; word.lastElementChild.remove();
    capMeter.font = getComputedStyle(word).font;
    return baseY - capMeter.measureText('E').actualBoundingBoxAscent / 2 - card.getBoundingClientRect().top - card.clientTop;
  }
  function bxPlace() {
    const beam = dir === 'toEth' ? $('bxSend') : $('bxRecv'), eth = dir === 'toEth' ? $('bxRecv') : $('bxSend'), bk = $('bxKey'), w = W();
    // each card's network in its left corner, as the wallet tab's card titles with the way before it: FROM ● BEAM,
    // TO ● ETHEREUM (Beam's key at the right of its line when it receives)
    const way = (card) => (card === $('bxSend') ? 'From' : 'To');
    beam.appendChild($('bxNetB')); $('bxNetB').innerHTML = `<span class="way">${way(beam)}</span><i class="chain beam"></i><span class="nm">Beam</span>`;
    eth.appendChild($('bxNetE')); $('bxNetE').innerHTML = `<span class="way">${way(eth)}</span><i class="chain eth"></i><span class="nm">Ethereum</span>`;
    $('bxNetB').classList.toggle('low', beam === $('bxRecv')); $('bxNetE').classList.toggle('low', eth === $('bxRecv'));
    bk.hidden = dir === 'toEth';
    if (dir !== 'toEth') {
      $('bxRecv').appendChild(bk);
      const k = w && keyOf[w.id];
      // the whole key in its copy button's tip, as a token's contract address on the wallet tab
      bk.innerHTML = (k ? `<button type="button" class="cp" data-cp="${esc(k)}" data-tip-wide title="Copy the bridge key\n${esc(k)}">${CPI}</button>` : '')
        + `<span class="tipped" title="The bridge key of this wallet's Beam part: the Ethereum side sends to it">key</span> ${k ? esc(short(k)) : beamHere() ? '…' : 'no running Beam part'}`;
      // on TO ● BEAM's line, measured (their sizes differ, and so do fonts)
      const base = (el) => { el.insertAdjacentHTML('beforeend', '<i style="display:inline-block;width:0;height:0"></i>'); const y = el.lastElementChild.getBoundingClientRect().top; el.lastElementChild.remove(); return y; };
      bk.style.transform = '';
      bk.style.transform = `translateY(${(base($('bxNetB').querySelector('.nm')) - base(bk)).toFixed(1)}px)`;      // the word's own line: the label is a flex box, a mark in it sits at its middle
    }
    eth.appendChild($('bxGearBox'));
    // Beam on top: the fee typed by hand in its card's top right, its middle on BEAM's capitals' middle
    const fb = $('bxFeeBox');
    fb.hidden = dir !== 'toEth';
    if (dir === 'toEth') {
      $('bxSend').appendChild(fb);
      const mid = capMid($('bxNetB').querySelector('.nm'), $('bxSend'));
      if (mid != null) fb.style.top = `${(mid - fb.offsetHeight / 2).toFixed(1)}px`;
    }
    // the picker shares its line with FROM / TO ● ETHEREUM (top or bottom): it begins 10 px after them, at most as
    // wide as the wallet tab's
    const g = $('bxGearBox');
    g.style.width = '';
    const c = eth.getBoundingClientRect(), n = $('bxNetE').getBoundingClientRect(), right = c.right - parseFloat(getComputedStyle(g).right);
    if (n.width) g.style.width = `${Math.min(g.offsetWidth, Math.floor(right - n.right - 10))}px`;
    // the picker as far from its card's edge on top as below (5 px, wallet.css): ETHEREUM's capitals centred on it, not
    // it on them (a font's own measure put it 4 px from the bottom and 6 from the top with Windows' fonts)
    const ne = $('bxNetE');
    ne.style.transform = '';
    const mid = capMid(ne.querySelector('.nm'), eth), b = g.querySelector('.dd-btn');
    if (mid != null && b) {
      const bb = b.getBoundingClientRect(), bMid = (bb.top + bb.bottom) / 2 - eth.getBoundingClientRect().top - eth.clientTop;
      ne.style.transform = `translateY(${(bMid - mid).toFixed(1)}px)`;
    }
    bxLay();
  }
  const amount = () => { const t = $('bxAmt').value.trim().replace(',', '.'); return /^\d*\.?\d*$/.test(t) && t && t !== '.' ? Number(t) : null; };
  function bxCalc() {
    if ($('t-bridge').hidden && !bx.classList.contains('turning')) return;
    const toEth = dir === 'toEth', s = amount(), o = opt();
    const from = !toEth ? wbAt(addrOf(cur)) : null, to = toEth ? wbAt(addrOf(cur)) : null;
    const have = toEth ? beamHave() : from && !from.err ? from.wbeam : null;
    const fN = feeNow(), f = toEth ? (fN || 0) : Number(FE_FEE);
    const total = (s || 0) + f + (toEth ? 0.02 : 0);   // with the fee (and, from Beam, its own ~0.02)
    const issue = s > 0 && have != null && total > have ? 'over balance + fee' : '';
    $('bxAmt').classList.toggle('bad', !!issue);
    $('bxIssue').textContent = issue;
    const unitHave = toEth ? 'BEAM' : 'WBEAM';
    $('bxHave').innerHTML = have != null ? `${num(have)} <span class="u">${unitHave}</span>` : `<span class="u">${toEth ? (W() && W().beam ? '…' : 'no Beam part') : from && from.err ? 'unread' : '…'}</span>`;
    // the lower card: what the receiving side holds now; under To, how long it takes
    const there = toEth ? (to && !to.err ? to.wbeam : null) : beamHave();
    $('bxThereHave').innerHTML = there != null ? `${num(there)} <span class="u">${toEth ? 'WBEAM' : 'BEAM'}</span>` : '<span class="u">…</span>';
    $('bxWhen').textContent = toEth ? 'usually about an hour' : 'about an hour, then claim';
    // when, by the clock: now and an hour (as the line under it says), on the line of the balance's figures
    $('bxEta').innerHTML = `arrives ≈ <b>${esc(ftime(Date.now() + 3600e3))}</b>`;
    const mark = (el) => { el.insertAdjacentHTML('beforeend', '<i style="display:inline-block;width:0;height:0"></i>'); const y = el.lastElementChild.getBoundingClientRect().top; el.lastElementChild.remove(); return y; };
    $('bxEta').style.transform = '';
    if ($('bxEta').offsetParent) $('bxEta').style.transform = `translateY(${(mark($('bxThereHave')) - mark($('bxEta'))).toFixed(1)}px)`;
    $('bxGo').innerHTML = s > 0 && !issue ? `<span>Bridge ${num(s, 4)} ${unitHave}</span>` : 'Bridge';
    // the fee: the gauge's three levels this way, fixed the other; what it is for in two short lines
    $('bxFee').hidden = !toEth;
    const keys = feeData ? feeData.options.map((x) => x.key) : ['cheap', 'normal', 'safe'], li = keys.indexOf(level);
    const low = toEth && feeLow(fN), high = toEth && feeHigh(fN);
    // the arcs lit up to the fee (its own figure: the levels it reaches), yellow where it is too low or too high
    const reach = feeOwn != null && feeData ? feeData.options.filter((x) => fN >= x.fee - 0.005).length - 1 : li;
    qa('#bxFee .arc').forEach((a, k) => { a.classList.toggle('on', !!o && k <= reach && !high); a.classList.toggle('warn', (low && k === 0) || (high && k === keys.length - 1)); a.setAttribute('aria-checked', String(feeOwn == null && k === li)); });
    $('bxNeedle').style.transform = `rotate(${feeOwn != null && feeData ? feeAngle(fN) : (li - 1) * 60}deg)`;
    $('bxFeeLv').innerHTML = o ? `<span class="w">${feeOwn != null ? 'own' : esc(level)}</span> <b>${fN.toFixed(2)}</b>` : '';
    // the corner field: the fee in force (not while it is being typed in), outlined yellow too low or too high; the
    // level's dots beside it
    $('bxFeeBox').hidden = !toEth;
    if (document.activeElement !== $('bxFeeIn')) $('bxFeeIn').value = fN != null ? fN.toFixed(2) : '';
    $('bxFeeIn').classList.toggle('warn', low || high);
    lvlDraw(fN);
    let l1, l2;
    if (toEth) {
      l1 = feeData ? `gas now <b>${feeData.base.toFixed(3)}</b> gwei, ${esc(feeData.level)}` : feeErr ? 'not priced' : 'pricing…';
      const up = feeOwn != null ? covers(fN) : o && o.upTo;
      l2 = s > 0 && o ? `total <b>${num(s + fN, 4)}</b> BEAM` : o ? `covers to <b>${up > 0 ? up.toFixed(2) : '0'}</b> for <b>${usd(fN * feeData.rate.beam)}</b>` : '';
    } else {
      l1 = `<b>${FE_FEE}</b> WBEAM to the relayer`;
      l2 = s > 0 ? `total <b>${num(s + Number(FE_FEE), 4)}</b> WBEAM` : from && !from.err ? `gas from <b>${num(from.eth, 5)}</b> ETH` : 'its gas paid in ETH';
    }
    $('bxFeeInfo').innerHTML = `<span>${l1}</span><span>${l2}</span>`;
    feeSay();
    bxFit();
  }
  // the amount: 24 px down to 12 when long, ending where the right's column begins; its figures halfway between the
  // foot of Ethereum's picker (where it stands in the upper card) and the cut below; a problem on the balance's line
  function bxFit() {
    const inp = $('bxAmt');
    if (!inp.offsetParent) return;
    inp.style.marginRight = `${Math.max($('bxHave').offsetWidth, $('bxAvail').offsetWidth) + 12}px`;
    let px = 24;
    inp.style.fontSize = `${px}px`;
    while (px > 12 && inp.scrollWidth > inp.clientWidth) inp.style.fontSize = `${--px}px`;
    if (inp.scrollWidth <= inp.clientWidth) inp.scrollLeft = 0;
    inp.style.transform = '';
    const mark = '<i style="display:inline-block;width:0;height:0"></i>';      // an empty inline-block sits on the baseline
    const probe = document.createElement('span'), cs = getComputedStyle(inp);
    Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', font: cs.font, lineHeight: `${inp.offsetHeight}px`, height: `${inp.offsetHeight}px`, top: `${inp.offsetTop}px`, left: '0' });
    probe.innerHTML = `0${mark}`;
    inp.offsetParent.appendChild(probe);
    $('bxHave').insertAdjacentHTML('beforeend', mark);
    const hb = $('bxHave').lastElementChild;
    const px2 = parseFloat(inp.style.fontSize), card = $('bxSend').getBoundingClientRect();
    const cutTop = $('bxSwap').getBoundingClientRect().top - 5;
    const ddFoot = card.top + 6 + $('bxGearBox').offsetHeight;
    const want = Math.min((ddFoot + cutTop) / 2 + 0.36 * px2, cutTop - 3);
    const dy = want - probe.lastElementChild.getBoundingClientRect().top;
    const iss = $('bxIssue'), haveBase = hb.getBoundingClientRect().top;
    iss.style.top = '0px';
    iss.insertAdjacentHTML('beforeend', mark);
    iss.style.top = `${Math.round(haveBase - iss.lastElementChild.getBoundingClientRect().top)}px`;
    iss.lastElementChild.remove();
    probe.remove(); hb.remove();
    inp.style.transform = `translateY(${Math.round(dy)}px)`;
  }
  // all of it: a click on the balance puts in the most that can go, the fee (and from Beam its ~0.02) left for
  $('bxAll').onclick = () => {
    const toEth = dir === 'toEth', o = opt(), from = wbAt(addrOf(cur));
    // in whole units of 1e-8 (a groth, WBEAM's smallest), so all of it goes to the last digit, no dust left
    const have = toEth ? (beamStatus && beamStatus.available != null ? BigInt(Math.round(beamStatus.available)) : null) : from && !from.err ? BigInt(from.raw || '0') : null;
    if (have == null) return;
    const keep = toEth ? BigInt(Math.round((feeNow() || 0) * 1e8)) + 2000000n : 2000000n;      // the fee, and from Beam its ~0.02
    let m = have - keep;
    if (m > 9999999999999999n) m = 9999999999999999n;                                             // as typed: at most 99 999 999.99999999
    $('bxAmt').value = m > 0n ? exact(m.toString(), 8) : '';
    bxCalc(); $('bxAmt').focus();
  };
  BB.amountField($('bxAmt'), 8, 8);                    // digits and one point (or comma) only: up to 99 999 999.99999999 (BEAM's and WBEAM's 8 decimals)
  $('bxAmt').oninput = () => { actErr($('bxGo'), null); feeSay(); bxCalc(); };
  // the gauge: a click on an arc, or anywhere on the dial (its third under the pointer), or dragged across
  const gauge = document.querySelector('#bxFee .bx-gauge');
  const byX = (e) => { const r = gauge.getBoundingClientRect(), keys = feeData.options.map((x) => x.key); return keys[Math.min(keys.length - 1, Math.max(0, Math.floor((e.clientX - r.left) / r.width * keys.length)))]; };
  let dragging = false;
  gauge.addEventListener('pointerdown', (e) => { if (!feeData) return; dragging = true; gauge.setPointerCapture(e.pointerId); level = byX(e); feeOwn = null; bxCalc(); });
  gauge.addEventListener('pointermove', (e) => { if (!dragging) return; const k = byX(e); if (k !== level) { level = k; feeOwn = null; bxCalc(); } });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) gauge.addEventListener(ev, () => { dragging = false; });
  // and from the keyboard: the arrows move the level, as a slider's
  gauge.addEventListener('keydown', (e) => {
    if (!feeData || !/^Arrow(Left|Right|Up|Down)$/.test(e.key)) return;
    e.preventDefault();
    const keys = feeData.options.map((x) => x.key), k = keys.indexOf(level) + (/Right|Up/.test(e.key) ? 1 : -1);
    if (k >= 0 && k < keys.length) { level = keys[k]; feeOwn = null; bxCalc(); }
  });
  // the fee typed in the corner: the needle follows it; auto puts the level's back
  BB.amountField($('bxFeeIn'), 4, 4);
  $('bxFeeIn').oninput = () => { const t = $('bxFeeIn').value.replace(',', '.'); const v = Number(t); if (t !== '' && t !== '.' && isFinite(v)) { feeOwn = v; bxCalc(); } };
  $('bxFeeIn').onblur = () => bxCalc();
  $('bxFeeIn').onkeydown = (e) => { if (e.key === 'Enter') $('bxFeeIn').blur(); if (e.key === 'Escape') { feeOwn = null; $('bxFeeIn').blur(); } };
  // the level beside the field: three dots on a circle (Beam's sign), the level's at the top and lit; a click on a dot
  // takes its level, anywhere else the next one, the wheel steps through them; a figure of your own stops the circle
  // between, no dot lit
  function lvlDraw(f) {
    if (!feeData || f == null) return;
    const o = feeData.options, k = feeOwn == null ? o.findIndex((x) => x.key === level) : -1;
    const pos = k >= 0 ? k : f <= o[0].fee ? 0 : f >= o[2].fee ? 2 : f <= o[1].fee ? (f - o[0].fee) / (o[1].fee - o[0].fee) : 1 + (f - o[1].fee) / (o[2].fee - o[1].fee);
    qa('#bxLvl .vd').forEach((d, i) => d.classList.toggle('on', i === k));
    $('bxLvl').classList.toggle('own', k < 0);
    // its corner to the top, the shorter way round
    const g = $('bxLvlSpin'), from = g._a ?? -pos * 120;
    let to = -pos * 120; while (to - from > 180) to -= 360; while (from - to > 180) to += 360;
    if (Math.abs(to - from) < 0.1) { g._a = to; g.setAttribute('transform', `rotate(${to.toFixed(1)} 9 9)`); return; }
    const t0 = performance.now(), run = (g._run = (g._run || 0) + 1);
    const step = (now) => { if (g._run !== run) return; const t = Math.min(1, (now - t0) / 500), e = 1 - Math.pow(1 - t, 3), cur = from + (to - from) * e; g._a = cur;
      g.setAttribute('transform', `rotate(${cur.toFixed(1)} 9 9)`); if (t < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  const lvlTo = (k) => { if (!feeData) return; level = feeData.options[(k + 3) % 3].key; feeOwn = null; bxCalc(); };
  $('bxLvl').onclick = (e) => {
    if (!feeData) return;
    const d = e.target.closest('.vd');
    if (d) return lvlTo(+d.dataset.l);
    const k = feeData.options.findIndex((x) => x.key === level);
    lvlTo(feeOwn != null ? k : k + 1);
  };
  $('bxLvl').addEventListener('wheel', (e) => {
    if (!feeData) return;
    e.preventDefault();
    const k = feeData.options.findIndex((x) => x.key === level);
    lvlTo(Math.max(0, Math.min(2, k + (e.deltaY < 0 ? 1 : -1))));
  }, { passive: false });

  // a turn: the content (not the titles) tears into strips that jerk sideways, turns to the other way at the middle,
  // and comes back torn, settling
  const TURN = 460;
  let turning = false;
  // the strips: 7 copies of each card made once per half of the turn (its content changes at the middle), only
  // their cuts and shifts drawn anew each frame (3 to 7 of them shown)
  let torn = null;                                    // card -> its strip copies, for the half running
  function tearCopies() {
    torn = new Map(bxCards.map((c) => {
      let lay = c.querySelector('.bx-tear');
      if (!lay) { lay = document.createElement('div'); lay.className = 'bx-tear'; c.appendChild(lay); }
      lay.textContent = '';
      const strips = Array.from({ length: 7 }, () => {
        const s = document.createElement('div');
        s.className = 'bx-strip';
        for (const ch of c.children) if (!ch.classList.contains('bx-tear')) s.appendChild(ch.cloneNode(true));
        s.querySelectorAll('[id]').forEach((e) => e.removeAttribute('id'));      // copies without ids: $() finds the real ones
        lay.appendChild(s);
        return s;
      });
      return [c, strips];
    }));
  }
  function tear(t) {
    const d = Math.sin(Math.PI * t);
    if (!torn) tearCopies();
    for (const [c, strips] of torn) {
      const h = c.clientHeight, n = 3 + Math.floor(Math.random() * 5);
      const cuts = [0, ...Array.from({ length: n - 1 }, () => Math.random() * h).sort((a, b) => a - b), h];
      strips.forEach((s, k) => {
        if (k >= n) { s.style.display = 'none'; return; }
        s.style.display = '';
        s.style.clipPath = `inset(${cuts[k].toFixed(1)}px 0 ${(h - cuts[k + 1]).toFixed(1)}px 0)`;
        s.style.transform = `translateX(${Math.random() < 0.3 ? 0 : ((Math.random() - 0.5) * 80 * d).toFixed(1)}px)`;
      });
    }
    bx.style.setProperty('--fade', String(1 - d * 0.65));
  }
  // the way turned: from Ethereum only one's own account can send (an address typed in gives way to the last own one)
  function turned() {
    $('bxSwap').classList.toggle('back', dir === 'fromEth');
    if (dir === 'fromEth' && cur === 'typed') cur = mine;
    bxAccAd._bbDecode = (bxAccAd._bbDecode || 0) + 1;      // a decode still running would write the old address on the new button
    fillAccts(); bxAcct.set(cur); bxStill();
    $('bxAmt').value = ''; actErr($('bxGo'), null);
    bxPlace(); bxCalc();
    feeSay();
    if (dir === 'toEth') fee(); else beamKey();
  }
  $('bxSwap').onclick = () => {
    if (turning) return;
    turning = true;
    if ($('bxAcct').classList.contains('typing')) typed(false);
    bxLay();
    bx.classList.add('turning');
    const t0 = performance.now();
    let swapped = false;
    const frame = (now) => {
      const t = Math.min(1, (now - t0) / TURN);
      if (!swapped && t >= 0.5) { swapped = true; dir = dir === 'toEth' ? 'fromEth' : 'toEth'; turned(); torn = null; }      // the other way's content copied for the second half
      if (t < 1) { tear(t); requestAnimationFrame(frame); }
      else { torn = null; bxCards.forEach((c) => c.querySelector('.bx-tear')?.remove()); bx.classList.remove('turning'); bx.style.removeProperty('--fade'); turning = false; bxLay(); }
    };
    requestAnimationFrame(frame);
  };
  // a way chosen from elsewhere (a Bridge button on the wallet tab): at once, no turn
  function setDir(d) { if (d !== 'toEth' && d !== 'fromEth' || d === dir) return; dir = d; turned(); }

  async function beamKey() {
    const w = W();
    if (!w || keyOf[w.id] || !beamHere()) return bxPlace();
    try { keyOf[w.id] = await host('beamKey', w.id); } catch { /* said as "…" */ }
    if (isOpen(w.id)) bxPlace();
  }
  let bxWallet = null;                                // the wallet the form was drawn for
  let bxMain = null;                                  // the wallet tab's Ethereum account when the bridge last opened
  function bridgeOpen() {
    const a = acct(), l = ownAccts(), w = W();
    if (w && w.id !== bxWallet) {                     // another wallet: its own account, nothing carried over
      bxWallet = w.id; mine = ''; other = ''; feeOwn = null; if (cur === 'typed') cur = '';
      $('bxAmt').value = ''; bxShown = 5; actErr($('bxGo'), null);
      bxRows = []; bxRowsW = null; $('bList').innerHTML = '<div class="empty">loading…</div>'; $('bMore').hidden = true;
      if ($('bxAcct').classList.contains('typing')) typed(false);
    }
    // the wallet tab's account changed since the bridge last looked: the bridge takes it (one picked on the bridge
    // itself stays while the wallet tab's does not change)
    if (a && a.address !== bxMain) { bxMain = a.address; mine = a.address; if (cur !== 'typed') cur = ''; }
    if (!l.some((x) => x.address === mine)) mine = a ? a.address : l[0] ? l[0].address : '';
    if (cur !== 'typed' || dir !== 'toEth') cur = mine;
    fillAccts(); bxAcct.set(cur); bxStill();
    $('bxSwap').classList.toggle('back', dir === 'fromEth');
    bxPlace(); bxCalc();
    readEth(addrOf(cur));
    if (dir === 'toEth') fee(); else beamKey();
    bridgeLists();
  }

  // BEAM -> WBEAM: the relayer takes a message once relayGas (120000) x (2 base fee + tip) x ETH/BEAM is at most
  // its fee; the gauge's levels are its options (each covering a base fee up to upTo, share of the last 24 h)
  const covers = (feeBeam) => feeData ? ((feeBeam * feeData.rate.beam / feeData.rate.eth) * 1e18 / feeData.relayGas - feeData.tip * 1e9) / 2 / 1e9 : null;   // bridge.js coversBase, with its numbers
  const shareOf = (gwei) => feeData && feeData.dayBase.length ? feeData.dayBase.filter((b) => b / 1e9 <= gwei).length / feeData.dayBase.length : null;
  const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
  // a fee that could not be priced: said short, in the line under the button (the full reason in its tip), gone once
  // it is priced
  let feeErr = '';
  const FEE_SHORT = [[/price to trust/i, 'no price for the fee now, try in a minute'], [/rpc|fetch|network|timeout/i, 'Ethereum did not answer, fee not priced']];
  function feeSay() {
    const m = document.querySelector('.bx-go .act-msg');
    if (!m) return;
    const f = feeNow();
    const say = dir !== 'toEth' ? '' : feeErr ? (FEE_SHORT.find(([re]) => re.test(feeErr)) || [0, 'fee not priced, try in a minute'])[1]
      // under the minimum the relayer takes it only when gas falls that low; a fee that covers next to no gas may never go
      : feeLow(f) ? (covers(f) < 0.0005 ? `under minimum ${feeData.min.toFixed(2)}: may get stuck for good` : `under minimum ${feeData.min.toFixed(2)}: stuck till gas ≤ ${covers(f).toFixed(3)} gwei`)
      : feeHigh(f) ? 'over twice safe: paying for nothing, not faster' : '';      // one line under the button
    if (say) { if (m.textContent && !m.dataset.fee) return; m.textContent = say; m.title = feeErr || ''; m.dataset.fee = '1'; m.classList.remove('ok'); }      // an action's own word is not written over
    else if (m.dataset.fee) { m.textContent = ''; m.title = ''; delete m.dataset.fee; }
  }
  async function fee() {
    try { feeData = await host('relayerFee'); feeErr = ''; } catch (e) { feeErr = msg(e); }
    bxCalc(); feeSay();
  }
  async function goToEth() {
    const bxWid = W().id;      // the wallet the confirmation names is the one that sends
    if (!beamHere()) throw new Error('this wallet has no running Beam part');
    const rcv = addrOf(cur);
    if (!isEthAddress(rcv)) throw fieldErr('bxAcct', 'choose the Ethereum account, or enter an address');
    const own = allAccounts().find((a) => a.address.toLowerCase() === rcv.toLowerCase());
    const fd = feeData || (feeData = await host('relayerFee').catch((e) => { throw Object.assign(e instanceof Error ? e : new Error(msg(e)), { pricing: true }); }));
    const o = fd.options.find((x) => x.key === level) || fd.options[0];
    if (feeOwn != null && !(feeOwn > 0)) throw fieldErr('bxFeeIn', 'a fee above zero');
    const a = toGroth($('bxAmt').value), f = toGroth(String(feeOwn != null ? feeOwn : o.fee));
    if (f < Math.round(fd.min * GROTH)) {
      const up = covers(f / GROTH);
      const ok = await confirmBox('Fee under the minimum', [['Relayer minimum now', `${fd.min.toFixed(2)} BEAM`], ['This fee', `${amt(f, 8)} BEAM`],
        ['Released once the base fee is', `≤ ${up > 0 ? up.toFixed(3) : '—'} gwei (${pct(shareOf(up))} of the last 24 h)`]],
        'The relayer keeps the message and takes it when gas gets that cheap. If it never does, the BEAM stay locked: nothing can raise the fee later.');
      if (!ok) return;
    }
    const av = (beamStatus && beamStatus.available) || 0;
    if (a + f + 2e6 > av) throw new Error('not enough BEAM with the fee');      // short, one line under the button (it goes after 5 s)
    if (!isOpen(bxWid)) throw new Error('another wallet was opened meanwhile: nothing was sent');
    const txid = await host('sendToEth', bxWid, {
      title: 'Bridge BEAM → WBEAM',
      rows: [['Receive', `${amt(a, 8)} WBEAM`], ['Relayer fee', `${amt(f, 8)} BEAM (${feeOwn != null ? 'your own' : level})`],
        ['Fee covers', `base fee up to ${(covers(f / GROTH) ?? o.upTo).toFixed(3)} gwei (${pct(shareOf(covers(f / GROTH)))} of the last 24 h); ×${(f / GROTH / fd.min).toFixed(1)} today's minimum`],
        null, ['To', own ? `${own.wallet.name} | ${own.name}\n${rcv}` : `${rcv}\n(not one of this wallet's accounts)`]],      // the name, the whole address on a line of its own
      note: 'The official bridge pipe on Beam, released by its relayer on Ethereum in about an hour.\nIt cannot be undone.',
    }, a, rcv, f);
    actOk($('bxGo'), `transaction ${esc(txid)} sent`);
    $('bxAmt').value = ''; bxCalc();
    beamRefresh(); setTimeout(bridgeLists, 90000);
  }
  // WBEAM -> BEAM: approve (the first time) and send from the account, gas in ETH; then claim it on Beam
  async function goFromEth() {
    if (!beamHere()) throw new Error('this wallet has no running Beam part to receive');
    const from = addrOf(cur);
    if (!isEthAddress(from)) throw fieldErr('bxAcct', 'choose the Ethereum account');
    const p = await host('fromEthPrepare', { from, wallet: W().id, amount: $('bxAmt').value.replace(',', '.'), fee: FE_FEE });
    const fn = units(p.feeNow, 18), fm = units(p.feeMax, 18);
    if (!p.enoughGas) throw new Error(`not enough ETH for gas on ${short(from)}`);
    const acc = allAccounts().find((a) => a.address.toLowerCase() === from.toLowerCase());
    const ok = await confirmBox('Bridge WBEAM → BEAM', [
      ['Receive', `${exact(p.value, 8)} BEAM`], ['Relayer fee', `${exact(p.fee, 8)} WBEAM`],
      null, ['From', `${acc ? `${acc.wallet.name} | ${acc.name}\n` : ''}${p.from}`], ['To', `${p.beamWallet}\nBeam bridge key: ${short(p.key)}`], null,
      ['Transactions', p.approve ? 'Ethereum: 2\napprove WBEAM to the bridge, then send' : 'Ethereum: 1\nsend'],
      // the gas as Ethereum Send says it: what it should cost, and the most it can
      ['Net fee', `≈ ${num(fn, 6)} ETH${rates ? ` | ${usd(fn * rates.eth)}` : ''}`],
      ['Max fee', `${num(fm, 6)} ETH${rates ? ` | ${usd(fm * rates.eth)}` : ''}`]],
      'The approval is for exactly this amount. Once the relayer has brought it to Beam (usually under an hour), claim it in the transfers below.');
    if (!ok) return;
    actOk($('bxGo'), p.approve ? 'approving WBEAM, then sending…' : 'sending…', true);
    const rec = await host('fromEthSend', p.id);
    actOk($('bxGo'), `transaction <a class="text-link" href="https://etherscan.io/tx/${esc(rec.hash)}" target="_blank" rel="noopener">${esc(short(rec.hash))}</a> confirmed`);
    $('bxAmt').value = '';
    readEth(from); bridgeLists();
  }
  $('bxGo').onclick = async () => {
    actErr($('bxGo'), null);
    // no amount (empty, or 0): said as Send says it, the amount's card outlined, the words under the button
    if (!(amount() > 0)) return actErr($('bxGo'), fieldErr('bxSend', 'enter an amount'));
    $('bxGo').disabled = true;
    try { if (dir === 'toEth') await goToEth(); else await goFromEth(); }
    catch (e) {
      const said = e.pricing && FEE_SHORT.find(([re]) => re.test(msg(e)));      // the fee's pricing that failed: said short
      actErr($('bxGo'), said ? new Error(said[1]) : e, { bxAmt: /amount|enough|decimal|available|zero|number/i, bxAcct: /address|0x|account|gas/i });
    }
    finally { $('bxGo').disabled = false; }
  };

  // the transfers, both ways and what arrived to claim, in one list: what waits for a claim on top, then newest
  // first. Each row: the way and its number (the Beam side's message), whom to or from, when (the date in full, the
  // time as Settings has it), the amount over the fee paid, the state. The amounts' and the states' columns one width
  // down the list. The last 5 shown, "10 more" adds ten at a time
  let bxRows = [], bxShown = 5, bxRowsW = null;      // the transfers drawn, and whose wallet they are
  const bxClaimed = new Set();      // `${wallet}:${MsgId}` claimed here: not offered again while its transaction is mined
  const BADGE_OUT = { done: ['ok', 'arrived'], waiting: ['pending', 'relaying'], failed: ['bad', 'failed'], unknown: ['pending', 'unknown', 'not in the releases read: see the bridge monitor'] };
  const BADGE_IN = { approving: ['pending', 'approving'], sending: ['pending', 'sending'], sent: ['pending', 'mining'], unconfirmed: ['pending', 'unmined', 'not mined yet'], confirmed: ['ok', 'sent'], failed: ['bad', 'failed'] };
  let bxListSeq = 0;
  async function bridgeLists() {
    note('bErr', 'bad', '');
    const wid = W() && W().id, seq = ++bxListSeq;      // a slower older answer never draws over a newer one
    const extra = cur === 'typed' ? other : '';
    const [claims, out, ins] = await Promise.all([
      beamHere() ? host('incoming', wid).catch((e) => { note('bErr', 'bad', msg(e)); return []; }) : [],
      Object.values(st.beam || {}).some((b) => b.status === 'running') ? host('outgoing', extra).catch((e) => { note('bErr', 'bad', msg(e)); return { msgs: [] }; }) : { msgs: [] },
      host('bridgeIn').catch(() => []),
    ]);
    if ((wid && !isOpen(wid)) || seq !== bxListSeq) return;
    const rows = [
      ...claims.map((m) => ({ t: Infinity, claim: !bxClaimed.has(`${wid}:${m.MsgId}`), badge: ['pending', 'claiming'], way: 'in', no: m.MsgId, who: 'from Ethereum', when: 'arrived on Beam', amount: Number(m.amount) / GROTH, fee: null, msg: m.MsgId, raw: m.amount })),
      ...out.msgs.map((m) => ({ t: m.eth ? Date.parse(m.eth.time) : Infinity - 1, way: 'out', no: m.id, who: `to ${short(m.receiver)}`,
        when: m.eth ? fdt(m.eth.time) : m.state === 'waiting' ? 'on Beam, not released yet' : '', hash: m.eth && m.eth.hash, amount: m.amount / GROTH, fee: m.fee / GROTH, badge: BADGE_OUT[m.state] || BADGE_OUT.unknown })),
      ...ins.map((r) => ({ t: r.time, way: 'in', no: null, who: `from ${short(r.from)}`, when: fdt(r.time), hash: r.hash, amount: units(r.value, 8), fee: r.fee != null ? units(r.fee, 8) : null,
        badge: BADGE_IN[r.state] || BADGE_IN.sent, err: r.error })),
    ].sort((a, b) => (b.claim ? 1 : 0) - (a.claim ? 1 : 0) || b.t - a.t);
    bxRows = rows; bxRowsW = wid;
    transfers();
  }
  function transfers() {
    const rows = bxRows.slice(0, bxShown);
    $('bList').innerHTML = rows.map((r) => {
      const way = r.way === 'out' ? 'BEAM → WBEAM' : 'WBEAM → BEAM';
      const end = r.claim ? `<button type="button" class="btn solid small" data-msg="${esc(r.msg)}" data-amount="${esc(r.raw)}" data-w="${esc(bxRowsW || '')}">Claim</button>`
        : `<span class="badge ${r.badge[0]}"${r.err || r.badge[2] ? ` title="${esc(r.err || r.badge[2])}"` : ''}>${r.badge[1]}</span>`;
      return `<div class="li bx-tr"><span class="what">${way}${r.no != null ? ` <span class="no">#${esc(r.no)}</span>` : ''}<span class="sub">${esc(r.who)}</span><span class="sub">${esc(r.when) || '&nbsp;'}${r.hash ? `<a class="cp tx" href="https://etherscan.io/tx/${esc(r.hash)}" target="_blank" rel="noopener" title="Open the transaction on Etherscan">${LINK}</a>` : ''}</span></span>`
        + `<span class="money"><span class="amt">${num(r.amount)}</span><span class="fee">${r.fee != null ? `fee ${num(r.fee, 2)}` : '&nbsp;'}</span></span><span class="end">${end}</span></div>`;
    }).join('') || '<div class="empty">none yet</div>';
    const w = Math.max(0, ...qa('#bList .money').map((m) => m.scrollWidth));
    $('bList').style.setProperty('--amtw', `${Math.ceil(w)}px`);
    const left = bxRows.length - bxShown;
    $('bMore').hidden = left <= 0;
    $('bMore').innerHTML = left > 0 ? `<button type="button" class="btn ghost small">load older transfers (${left})</button>` : '';      // as the low-value tokens'
  }
  $('bMore').onclick = (e) => { if (!e.target.closest('button')) return; bxShown += 10; transfers(); };
  $('bxKey').onclick = (e) => { const c = e.target.closest('[data-cp]'); if (c) copyFlash(c, c.dataset.cp); };
  $('bList').onclick = async (e) => {
    const b = e.target.closest('button[data-msg]');
    if (!b) return;
    const wid = W() && W().id;
    if (!wid || b.dataset.w !== wid) return;      // a list of the wallet open before: its claim is not this one's
    note('bErr', 'bad', '');
    b.disabled = true;
    try {
      const txid = await host('receive', wid, {
        title: 'Claim from the bridge', rows: [['Bridge message', `#${b.dataset.msg}`], ['BEAM', amt(Number(b.dataset.amount), 8)]],
        note: 'Takes the BEAM the relayer brought over for this wallet.',
      }, b.dataset.msg);
      b.textContent = 'Claimed'; b.title = `Beam transaction ${txid}`; bxClaimed.add(`${wid}:${b.dataset.msg}`);
      beamRefresh();
    } catch (err) { note('bErr', 'bad', msg(err)); b.disabled = false; }
  };

  // ---------- Activity's memory ----------
  // What Activity worked out once, kept in this browser (chrome.storage.local, trusted pages only) per wallet:
  //   tx  txId -> { k: kernel, b: block, o: 1 our pool's, t: its time } only what Beam did not give (a receipt's
  //       kernel from the pool's list, its block from the coins it made): a spent coin or an old payout keeps it
  //   coins  a coin with no record of its own (found on the chain, from a wallet of this seed): its row stays once spent
  //   bt  block height -> its time (blocks do not change)
  //   ls  the list as last shown, per network and account (it opens at once and refreshes behind), 300 rows at most
  // A removed wallet's goes by itself; Settings clears what is older than a month, 3 months, a year, or all.
  let keep = null, keepT = 0;
  const keepAll = async () => { if (!keep) { try { keep = (await chrome.storage.local.get('actKeep')).actKeep || {}; } catch { keep = {}; } } return keep; };
  const keepOf = async (wid) => { const k = await keepAll(); return (k[wid] ||= { tx: {}, bt: {}, ls: {}, coins: {} }); };
  const keepSave = () => { clearTimeout(keepT); keepT = setTimeout(() => { chrome.storage.local.set({ actKeep: keep }).catch(() => {}); if (!$('t-settings').hidden && setSec === 'storage') keepInfo(); }, 600); };
  // the wallets gone from the extension take theirs with them
  const keepTidy = async () => {
    if (!st || !st.wallets || !st.wallets.length) return;      // nothing known yet: nothing dropped
    const k = await keepAll(), ws = new Map(st.wallets.map((w) => [w.id, w])); let n = 0;
    for (const id of Object.keys(k)) {
      const w = ws.get(id);
      if (!w) { delete k[id]; n++; continue; }
      // a list kept for an Ethereum account no longer in the wallet goes too
      const have = new Set(w.accounts.map((a) => `eth|${a.address.toLowerCase()}`));
      for (const key of Object.keys(k[id].ls || {})) if (key.startsWith('eth|') && !have.has(key)) { delete k[id].ls[key]; n++; }
    }
    if (n) keepSave();
  };
  async function keepInfo() {
    if (!$('keepInfo')) return;
    const k = await keepAll(); let tx = 0, coins = 0, bt = 0, ls = 0;
    for (const w of Object.values(k)) { tx += Object.keys(w.tx || {}).length; coins += Object.keys(w.coins || {}).length; bt += Object.keys(w.bt || {}).length; ls += Object.keys(w.ls || {}).length; }
    $('keepSize').textContent = `${Math.ceil(JSON.stringify(k).length / 1024)} KB`;
    $('keepInfo').innerHTML = `<dt>Transfers</dt><dd>${tx}</dd><dt>Spent coins</dt><dd>${coins}</dd><dt>Blocks' times</dt><dd>${bt}</dd><dt>Lists</dt><dd>${ls}</dd>`;
  }
  const keepAge = BB.dropdown($('keepAge'), () => {});
  keepAge.set('90');
  $('keepClear').onclick = async () => {
    const days = Number(keepAge.value()), k = await keepAll();
    if (!days) { for (const id of Object.keys(k)) delete k[id]; }
    else {
      const cut = Date.now() - days * 864e5;
      for (const w of Object.values(k)) {
        for (const [id, x] of Object.entries(w.tx || {})) if (!x.t || x.t < cut) delete w.tx[id];
        for (const [id, x] of Object.entries(w.coins || {})) if (!x.t || x.t < cut) delete w.coins[id];
        for (const [h, t] of Object.entries(w.bt || {})) if (t * 1000 < cut) delete w.bt[h];
        for (const [key, l] of Object.entries(w.ls || {})) { w.ls[key] = (l || []).filter((r) => r.st === 'pending' || (r.t && r.t >= cut)); if (!w.ls[key].length) delete w.ls[key]; }
      }
    }
    await chrome.storage.local.set({ actKeep: k }).catch(() => {});
    actOk($('keepClear'), 'cleared'); keepInfo();
    actFor = ''; if (!$('t-activity').hidden) activity();      // Activity works it out again
  };

  // ---------- Activity ----------
  // (worked out in lab/activity.html) By day (Today, Yesterday, 9 Nov; another year's with its year), each day's net
  // in the network's coin, and what is under way above them all. A row says who and what, the date and time, the
  // amount with its unit (an asset by its name) and its dollars; a failed one in red, a cancelled one faded. A click
  // opens its card: the details, the ids to copy, the explorers, what can be done. All / In / Out / Bridge / dApps,
  // and a search in their place; 30 rows, then Older. A refresh keeps the list drawn until the new one is ready.
  let actNet = 'beam', actKind = 'all', actQ = '', actShown = 30, actRows = [], actFor = '';
  const actOpen = new Set();
  $('actNet').onclick = (e) => { const b = e.target.closest('button[data-n]'); if (!b) return; actNet = b.dataset.n; qa('#actNet button').forEach((x) => x.classList.toggle('on', x === b)); actOpen.clear(); actShown = 30; activity(); };
  const SVG_DAPP = '<svg viewBox="0 0 24 24"><path d="M12 2.8 20 7.2v9.6L12 21.2 4 16.8V7.2z"/><path d="M4 7.2 12 11.6l8-4.4M12 11.6v9.6"/></svg>';
  const SVG_SHIELD = '<svg viewBox="0 0 24 24"><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>';
  const SVG_POOL = '<svg viewBox="0 0 24 24"><path d="M12 3 3 8l9 5 9-5z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></svg>';
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day0 = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const dayName = (t) => { const k = Math.round((day0(Date.now()) - day0(t)) / 864e5), d = new Date(t); return k === 0 ? 'Today' : k === 1 ? 'Yesterday' : `${d.getDate()} ${MON[d.getMonth()]}${d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : ''}`; };
  const POOL_NOTE = 'BumbleBeam pool payout';           // what our pool writes on its payouts (beam/pool payouts.rs)
  const EXPL = 'https://explorer.bumblebeam.org', SCAN = 'https://etherscan.io';
  const BEAM_STATUS = { 0: 'pending', 1: 'pending', 5: 'pending', 2: 'cancelled', 4: 'failed' };
  // a coin no transaction of this wallet made, as a received transfer: another wallet of the same phrase made it
  const blockTime = new Map();
  const FOUND_TIP = {
    'from a wallet of this seed': 'Sent by a wallet of this seed phrase (a pool\'s payouts, the wallet CLI) to one of its addresses that another wallet of the phrase took: this wallet has the coins but no record of the transfer',
    'found on the chain': 'Another wallet of this seed phrase (the mobile or desktop one) took this transfer: this wallet has the coins but no record of it',
  };
  const zeroK = (k) => !k || /^0+$/.test(k);

  // Beam: the wallet's transactions and the coins no transaction of its made, as rows
  async function beamActRows(wid) {
    const [txs, coins, pool] = await Promise.all([host('beam', wid, 'tx_list', { count: 1000 }),
      host('beam', wid, 'get_utxo', { count: 500, sort: { field: 'maturity', direction: 'desc' } }).catch(() => []),
      host('poolPayments').catch(() => [])]);
    // our pool's payouts: a transaction by its kernel; a coin with no record by its amount, near the run's time.
    // The pool pays from a fresh address each day and its note does not reach the receiver, so neither tells
    const poolK = new Set(pool.map((p) => p.kernel).filter(Boolean));
    // by amount: each payout taken once (two receipts of one amount are not both the pool's), within 2 days of its run
    const byAmt = new Map();
    for (const p of pool) { if (!byAmt.has(p.amount)) byAmt.set(p.amount, []); byAmt.get(p.amount).push(p); }
    const poolPay = (g, t) => { const l = byAmt.get(g); if (!l) return null; const k = l.findIndex((p) => Math.abs(p.ts - t) < 2 * 86400); return k < 0 ? null : l.splice(k, 1)[0]; };
    const ids = new Set(txs.map((t) => t.txId)), cs = Array.isArray(coins) ? coins : [];
    // a transfer that also gave this seed change came from a wallet of this seed too (a pool's payouts, the wallet CLI)
    const ownSent = new Set(cs.filter((c) => c.type === 'chng' && c.createTxId).map((c) => c.createTxId));
    // a transaction's block from the coins it made, when Beam gives it no height (some receipts come with no kernel and no height)
    const madeAt = new Map(cs.filter((c) => c.createTxId && c.maturity > 0).map((c) => [c.createTxId, c.maturity]));
    const found = cs.filter((c) => c.type === 'norm' && (!c.createTxId || !ids.has(c.createTxId)) && c.maturity > 0).slice(0, 60);
    const kp = await keepOf(wid);
    for (const [h, t] of Object.entries(kp.bt)) if (!blockTime.has(Number(h))) blockTime.set(Number(h), t);
    await Promise.all([...new Set(found.map((c) => c.maturity))].filter((h) => !blockTime.has(h)).map((h) =>
      host('beam', wid, 'block_details', { height: h }).then((b) => { blockTime.set(h, Number(b.timestamp) || 0); if (b.timestamp) kp.bt[h] = Number(b.timestamp); }, () => {})));
    const syms = new Map();
    for (const aid of new Set([...txs, ...found].map((t) => Number(t.asset_id || 0)).filter(Boolean))) syms.set(aid, (await assetSymOf(aid).catch(() => '')) || `asset ${aid}`);
    // which of this wallet's addresses a payment came to: Beam's own by their SBBS id, one added by hand by the id inside its token
    const ownL = await host('beam', wid, 'addr_list', { own: true }).catch(() => []), extL = await host('addrExt', wid).catch(() => []);
    // One SBBS id can stand behind several addresses of different kinds (a regular, an offline and a max privacy
    // token of one id): all of them are named, the kind the payment used first (a push, Beam's offline payment, to
    // the offline kinds; a simple transfer to a regular one)
    const OFFL = ['offline', 'public_offline', 'max_privacy'];
    const receivedAt = (sbbs, push) => {
      if (!sbbs) return null;
      const id = String(sbbs).toLowerCase().replace(/^0+/, '');
      const l = [...ownL.filter((a) => String(a.wallet_id || '').toLowerCase().replace(/^0+/, '') === id).map((o) => ({ name: o.comment || '', address: o.address, type: o.type })),
        ...extL.filter((x) => tokenHas(x.address, sbbs)).map((e) => ({ name: e.name || '', address: e.address, type: e.type }))].filter((a, k, all) => all.findIndex((b) => b.address === a.address) === k);
      if (!l.length) return [{ name: '', address: sbbs, type: '' }];
      return l.sort((a, b) => (OFFL.includes(b.type) === !!push) - (OFFL.includes(a.type) === !!push));
    };
    const cid = st.bridgeCid;
    const rows = txs.map((t) => {
      const aid = Number(t.asset_id || 0), contract = t.tx_type_string === 'contract', s = BEAM_STATUS[t.status] || '';
      const inv = JSON.stringify(t.invoke_data || t.contract_cids || '');
      const bridge = contract && ((cid && inv.includes(cid)) || /^(send|receive) funds$/i.test(String(t.comment || '').trim()));
      const kind = bridge ? (t.income ? 'br-in' : 'br-out') : contract ? 'dapp' : t.income ? 'in' : 'out';
      const ss = String(t.status_string || '');
      return {
        id: t.txId, kind, t: (t.create_time || 0) * 1000, g: Number(t.value) || 0, v: (Number(t.value) || 0) / GROTH, sym: aid ? syms.get(aid) : 'BEAM', asset: aid || null,
        peer: contract ? null : (t.income ? t.sender : t.receiver) || null, at: !contract && t.income ? receivedAt(t.receiver, /push/i.test(t.tx_type_string || '')) : null, comment: contract ? '' : t.comment || '',
        what: contract && !bridge ? (t.comment || 'Contract call') : '', app: t.appname || '',
        st: s, fee: (Number(t.fee) || 0) / GROTH, kern: zeroK(t.kernel) ? '' : t.kernel, block: t.height || madeAt.get(t.txId) || null, beamK: zeroK(t.kernel) ? '' : t.kernel, beamB: t.height || null,
        stage: /waiting for receiver/i.test(ss) ? 'waiting for the receiver to come online' : /waiting for sender/i.test(ss) ? 'waiting for the sender'
          : t.status === 5 ? 'registering on the chain' : bridge ? 'on its way to the chain' : ss || 'in progress',
        why: s === 'failed' ? (t.failure_reason || ss || 'failed') : s === 'cancelled' ? (t.income ? 'by the sender' : 'by you before the receiver signed') : '',
        cancel: !t.income && !contract && (t.status === 0 || t.status === 1),
        // our pool's: its kernel in the pool's list; with no kernel from Beam, its amount (a payout taken once); a
        // comment proves nothing (anyone can write it)
        ours: !!t.income && !contract && (zeroK(t.kernel) ? !s && !!(t.poolP = poolPay(Number(t.value), t.create_time || 0)) : poolK.has(t.kernel)),      // by amount: a completed receipt only (a failed one takes no payout)
        poolK: zeroK(t.kernel) && t.poolP ? t.poolP.kernel : null,
      };
    });
    for (const c of found) {
      const own = ownSent.has(c.createTxId);
      const tm = blockTime.get(c.maturity) || 0;
      rows.push({ id: `coin-${c.id || c.createTxId || c.maturity}-${c.amount}`, x: c.createTxId || null, kind: 'in', t: tm * 1000, g: c.amount, v: c.amount / GROTH, ours: !c.asset_id && !!(c.poolP = poolPay(Number(c.amount), tm)), poolK: c.poolP ? c.poolP.kernel : null,
        sym: c.asset_id ? syms.get(Number(c.asset_id)) : 'BEAM', asset: Number(c.asset_id) || null, peer: null, st: '', block: c.maturity,
        found: own ? 'from a wallet of this seed' : 'found on the chain' });
    }
    // a coin with no record, once spent, is no longer among the coins: the one kept stays in the list
    // A transaction that came in since (an import of wallet data) is that coin's record: the coin's row goes, kept
    // or not (by its transaction id, or for one kept before, the same amount in the same block), never twice
    const txRows = rows.filter((r) => !r.found);
    const recorded = (c) => (c.x && ids.has(c.x)) || txRows.some((r) => r.g === c.g && r.block && r.block === c.b && came(r));
    kp.coins ||= {};
    for (let k = rows.length - 1; k >= 0; k--) { const r = rows[k]; if (r.found && recorded({ x: r.x, g: r.g, b: r.block })) { rows.splice(k, 1); delete kp.coins[r.id]; } }
    const now = new Set(rows.map((r) => r.id));
    for (const [id, c] of Object.entries(kp.coins)) {
      if (recorded(c)) { delete kp.coins[id]; continue; }
      if (!now.has(id)) rows.push({ id, kind: 'in', t: c.t, g: c.g, v: c.g / GROTH, ours: !!c.o, sym: c.a ? syms.get(c.a) || `asset ${c.a}` : 'BEAM', asset: c.a || null, peer: null, st: '', block: c.b, found: c.f, x: c.x });
    }
    for (const r of rows) if (r.found && r.t) kp.coins[r.id] = { t: r.t, g: r.g, a: r.asset || 0, b: r.block, f: r.found, o: r.ours ? 1 : 0, x: r.x || null };
    // our pool's payout with no kernel from Beam (a receipt often has none): the pool's list has it
    for (const r of rows) if (r.ours && !r.kern && r.poolK) r.kern = r.poolK;      // the very payout matched above
    // what was worked out before fills what is missing now (the coin since spent, the payout gone from the pool's
    // list); what is worked out now and Beam did not give is kept
    const ids2 = new Set(rows.map((r) => r.id));
    for (const r of rows) {
      const m = kp.tx[r.id];
      if (m) { if (!r.kern && m.k) r.kern = m.k; if (!r.block && m.b) r.block = m.b; if (m.o) r.ours = true; }
      if (r.st || r.found) continue;
      const own = { k: r.kern && r.kern !== r.beamK ? r.kern : undefined, b: r.block && r.block !== r.beamB ? r.block : undefined, o: r.ours ? 1 : undefined };
      if (own.k || own.b || own.o) kp.tx[r.id] = { ...own, t: r.t };
    }
    for (const id of Object.keys(kp.tx)) if (!ids2.has(id) && !id.startsWith('coin-')) delete kp.tx[id];      // a transaction Beam no longer lists
    keepSave();
    // payouts in a day as one row: our pool's (known above); another's when one address pays three times or more
    const key = (r) => `${r.peer}|${day0(r.t)}|${r.comment}`, n = new Map();
    for (const r of rows) if (r.kind === 'in' && !r.st && r.peer) n.set(key(r), (n.get(key(r)) || 0) + 1);
    for (const r of rows) if (r.kind === 'in' && !r.st && (r.ours || (r.peer && n.get(key(r)) >= 3))) r.pool = true;
    return rows.sort((a, b) => b.t - a.t);
  }

  // Ethereum: the account's transactions and token transfers, as rows
  function ethActRows(list) {
    const wb = st.contracts.wbeam, pipe = st.contracts.ethPipe, zero = '0x0000000000000000000000000000000000000000';
    return list.map((t) => {
      const to = String(t.to || '').toLowerCase(), from = String(t.from || '').toLowerCase(), called = String(t.called || '').toLowerCase(), tok = t.token;
      const isWb = !!(tok && tok.address && tok.address.toLowerCase() === wb);
      const v = tok ? units(tok.value, tok.decimals) : units(t.value, 18), sym = isWb ? 'WBEAM' : tok ? tok.symbol : 'ETH';      // the bridge's token is called BEAM on its contract: WBEAM here, as on the wallet tab
      const r = { id: t.hash, hash: t.hash, t: t.time ? Date.parse(t.time) : Date.now(), v, sym, tokAddr: tok && tok.address, peer: t.out ? t.to : t.from,
        st: t.pending ? 'pending' : !t.ok ? 'failed' : '', stage: 'waiting for a block', why: 'the transaction reverted: its gas is spent, nothing else moved',
        fee: units(t.fee, 18), block: t.block || null };
      // to Beam: the bridge called, its WBEAM burnt (sent to 0x0) on the way
      if (t.out && (to === pipe || called === pipe || (isWb && to === zero))) Object.assign(r, { kind: 'br-out', peer: null });
      else if (!t.out && isWb && (from === pipe || from === zero)) Object.assign(r, { kind: 'br-in', peer: null });
      else if (t.out && !tok && /^approve/i.test(t.method || '')) Object.assign(r, { kind: 'approve', what: to === wb ? 'Approve WBEAM for the bridge' : `Approve ${short(t.to)}`, v: null, sym: '', peer: null });
      else if (t.out && !tok && t.method && !/^transfer/i.test(t.method)) Object.assign(r, { kind: 'dapp', what: t.method, app: short(t.to), contract: t.to });
      else r.kind = t.out ? 'out' : 'in';
      return r;
    }).sort((a, b) => (b.st === 'pending') - (a.st === 'pending') || b.t - a.t);
  }

  // whom an address is: one of this extension's accounts ("Wallet | Account"), or none
  const ethName = (a) => { const x = a && allAccounts().find((y) => y.address.toLowerCase() === a.toLowerCase()); return x ? (x.wallet.id === (W() && W().id) ? x.name : `${x.wallet.name} | ${x.name}`) : ''; };
  const nameOf = (a) => (actNet === 'eth' ? ethName(a) : '');
  // a pool's payouts in a day as one row with their count and sum (in groth for Beam)
  function folded(list) {
    const out = [], at = new Map();
    for (const r of list) {
      if (!r.pool) { out.push(r); continue; }
      const k = `${r.ours ? 'ours' : r.peer}|${day0(r.t)}`, g = at.get(k);
      if (g) { g.items.push(r); g.g += r.g; g.v += r.v; continue; }
      const ng = { ...r, id: `pool-${r.id}`, items: [r], group: true };
      at.set(k, ng); out.push(ng);
    }
    return out.map((r) => (r.group && r.items.length < 2 ? r.items[0] : r));
  }
  const actTitle = (r) => ({ in: r.group ? 'Pool payouts' : r.pool ? 'Pool payout' : 'Received', out: 'Sent', 'br-out': actNet === 'beam' ? 'Bridge → Ethereum' : 'Bridge → Beam', 'br-in': actNet === 'beam' ? 'Bridge ← Ethereum' : 'Bridge ← Beam', dapp: r.what || 'Contract call', approve: r.what })[r.kind];
  const actWho = (r) => {
    if (r.kind === 'br-out' || r.kind === 'br-in' || r.kind === 'approve') return '';
    if (r.kind === 'dapp') return r.app ? `in <b>${esc(r.app)}</b>` : '';
    if (r.pool) return r.ours ? '<span class="ours">BumbleBeam</span>' : '';      // our pool by its name in its colour; another: its count alone
    if (r.found) return `<span title="${esc(FOUND_TIP[r.found] || '')}">${esc(r.found)}</span>`;
    if (r.from) return `from <b>${esc(r.from)}</b>`;
    if (!r.peer) return '';
    return `${r.kind === 'in' ? 'from' : 'to'} <b>${esc(nameOf(r.peer) || short(r.peer))}</b>`;
  };
  // Beam → Ethereum in the accent on either side, Ethereum → Beam purple (as in the lab)
  const actIc = (r) => (r.kind === 'in' ? ['in', r.group || r.pool ? SVG_POOL : SVG_IN] : r.kind === 'out' ? ['out', SVG_OUT]
    : r.kind === 'br-out' || r.kind === 'br-in' ? [(r.kind === 'br-out') === (actNet === 'beam') ? 'br to-eth' : 'br', SVG_BRIDGE] : r.kind === 'dapp' ? ['dapp', SVG_DAPP] : ['ok2', SVG_SHIELD]);
  const came = (r) => r.kind === 'in' || r.kind === 'br-in';
  const vShown = (r, d) => (actNet === 'beam' ? amt(r.g, d) : num(r.v, d));
  // a price by what a coin is, not by its name (anyone can name a token ETH or an asset BEAM): BEAM itself (no asset
  // id), ETH (no token), WBEAM by its contract, the three dollar coins by theirs
  const STABLE = new Set(['0xdac17f958d2ee523a2206206994597c13d831ec7', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', '0x6b175474e89094c44da98b954eedeac495271d0f']);
  const rateOf = (coin) => (!rates ? null : coin === 'BEAM' ? rates.beam : coin === 'ETH' ? rates.eth : null);
  const rateOfRow = (r) => {
    if (!rates) return null;
    if (actNet === 'beam') return r.asset ? null : rates.beam;
    const a = String(r.tokAddr || '').toLowerCase();
    if (!a) return rates.eth;
    if (a === st.contracts.wbeam) return rates.wbeam || rates.beam;
    return STABLE.has(a) ? 1 : null;
  };
  const isMain = (r) => (actNet === 'beam' ? !r.asset : !r.tokAddr);
  const usdSmall = (x) => (x > 0 && x < 0.01 ? '< $0.01' : usd(x));
  const actFits = (r, k = actKind) => {
    if (k === 'in' && !came(r)) return false;
    if (k === 'out' && r.kind !== 'out') return false;
    if (k === 'bridge' && !r.kind.startsWith('br') && r.kind !== 'approve') return false;
    if (k === 'dapp' && r.kind !== 'dapp') return false;
    if (!actQ) return true;
    const s = [actTitle(r), r.peer, nameOf(r.peer), r.comment, r.app, r.what, r.found, String(r.v), r.sym, r.id, r.kern, r.hash, ...(r.items || []).map((x) => String(x.v))].filter(Boolean).join(' ').toLowerCase();
    return actQ.toLowerCase().split(/\s+/).every((w) => s.includes(w));
  };
  // the icons after what they are for: copy first, then the explorer, 6 px apart (as the wallet tab's tokens')
  const cpI = (v, what) => `<button type="button" class="cp" data-cp="${esc(v)}" data-tip-wide title="Copy ${esc(what)}\n${esc(v)}">${CPI}</button>`;
  const lnI = (href, what) => `<a class="cp" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(what)}">${LINK}</a>`;
  const ics = (...xs) => `<span class="ics">${xs.filter(Boolean).join('')}</span>`;
  const OUR_POOL = `BumbleBeam pool${ics(lnI('https://pool.bumblebeam.org/', 'Open the BumbleBeam pool'))}`;
  const addrDd = (a) => `${nameOf(a) ? `${esc(nameOf(a))}\n` : ''}${esc(a)}${ics(cpI(a, 'the address'), /^0x/i.test(a) && lnI(`${SCAN}/address/${a}`, 'Open the address on Etherscan'))}`;

  function actRow(r) {
    const [c, svg] = actIc(r), live = r.st === 'pending', open = actOpen.has(r.id);
    const state = r.st === 'failed' ? `<span class="st bad">failed: ${esc(r.why)}</span>` : r.st === 'cancelled' ? '<span class="st bad">cancelled</span>' : '';
    const when = r.group ? `${fdate(r.t)} ${ftime(r.items[r.items.length - 1].t)}–${ftime(r.items[0].t)}` : r.t ? fdt(r.t) : '';
    const sub = [when, state, r.comment && !r.ours ? `<span class="cm">${esc(r.comment)}</span>` : ''].filter(Boolean).join('<i class="sp"></i>');
    const amtH = r.kind === 'approve' ? '<span class="amt zero">&nbsp;</span>' : r.v ? `<span class="amt">${came(r) ? '+' : '−'}${vShown(r)}<u>${esc(r.sym)}</u></span>` : '<span class="amt zero">&nbsp;</span>';
    const rate = rateOfRow(r);
    const usdH = r.kind === 'approve' ? '<span class="usd">allowance</span>' : !r.v ? '<span class="usd">&nbsp;</span>' : rate ? `<span class="usd">${usdSmall(r.v * rate)}</span>` : '<span class="usd">no price</span>';
    const cls = ['li', 'ar', r.st === 'failed' ? 'bad' : '', r.st === 'cancelled' ? 'dim' : '', open ? 'open' : ''].filter(Boolean).join(' ');
    return `<div class="${cls}" data-id="${esc(r.id)}" tabindex="0" role="button" aria-expanded="${open}"><span class="ic ${c}${live ? ' spin' : ''}">${svg}</span>
      <span class="what">${esc(actTitle(r))}${r.group ? `<span class="x">×${r.items.length}</span>` : ''} <span class="who">${actWho(r)}</span><span class="sub">${sub}</span></span>
      <span class="ar-r">${amtH}${usdH}</span></div>${open ? actCard(r) : ''}`;
  }

  // a row's card: When, Now / Why and the address lined up on one column, the rest under them (no address: one
  // column), then what can be done
  // each payout of a folded row: its transaction in the explorer by its kernel, else its block
  const payLink = (x) => (x.kern ? ics(lnI(`${EXPL}/kernel/${x.kern}`, 'Open the transaction in the explorer'))
    : x.block ? ics(lnI(`${EXPL}/block/${x.block}`, 'Open its block in the explorer (Beam gave no kernel to open the transaction by)')) : '');
  // the addresses of this wallet a receipt came to (every address of its SBBS id, the one paid first)
  const atHtml = (at) => at.map((x) => `${x.name ? `${esc(x.name)}\n` : ''}${esc(short(x.address))}${x.type ? ` (${esc(TYPE_NAME[x.type] || x.type)})` : ''}`).join('\n');
  function actCard(r) {
    if (r.group) {
      // the payouts' address(es) here: each once (a pool pays one address; a coin with no record names none)
      const seen = new Map(); for (const x of r.items) for (const a of (Array.isArray(x.at) ? x.at : [])) if (!seen.has(a.address)) seen.set(a.address, a);
      return `<div class="ar-more">${r.items.map((x) => `<div class="sub-li"><span>${fdt(x.t)}${payLink(x)}${x.block ? `<span class="bk">block ${x.block}</span>` : ''}</span><b>+${vShown(x)} <u>${esc(x.sym)}</u></b></div>`).join('')}
        <dl class="kv" style="margin-top:8px"><dt>From</dt><dd>${r.ours ? OUR_POOL : r.peer ? addrDd(r.peer) : ''}</dd>${seen.size ? `<dt>To</dt><dd>${atHtml([...seen.values()])}</dd>` : ''}</dl></div>`;      // our pool pays from a fresh address each day: by its name
    }
    const rows = [], coin = actNet === 'beam' ? 'BEAM' : 'ETH';
    if (r.t) rows.push(['When', fdt(r.t)]);
    if (r.st === 'pending') rows.push(['Now', `<span class="st">${esc(r.stage)}</span>`]);
    if (r.st === 'failed' || r.st === 'cancelled') rows.push(['Why', `<span class="st bad">${r.st === 'failed' ? 'failed: ' : 'cancelled '}${esc(r.why)}</span>`]);
    if (r.ours) { rows.push(['From', `${OUR_POOL}${r.peer ? `\n${addrDd(r.peer)}` : ''}`]); if (Array.isArray(r.at) && r.at.length) rows.push(['To', atHtml(r.at)]); rows.push(null); }
    else if (r.peer) {
      // a receipt: From is the sender's SBBS id (Beam names the sending side so), To the address of this wallet it came to
      rows.push([came(r) ? 'From' : 'To', addrDd(r.peer)]);
      const at = Array.isArray(r.at) ? r.at : r.at ? [r.at] : [];      // kept by an earlier version: one object
      if (came(r) && at.length) rows.push(['To', atHtml(at)]);      // every address of that id, the one paid first
      rows.push(null);
    }
    else if (r.found) rows.push(['From', `<span title="${esc(FOUND_TIP[r.found] || '')}">${esc(r.found)}</span>`]);
    if (r.kind === 'dapp' && r.contract) rows.push(['Contract', `${esc(r.contract)}${ics(cpI(r.contract, 'the contract address'), lnI(`${SCAN}/address/${r.contract}`, 'Open the contract on Etherscan'))}`]);
    if (r.asset) rows.push(['Asset', `${esc(r.sym)} (id ${r.asset})${ics(cpI(String(r.asset), 'the asset id'), lnI(`${EXPL}/asset/${r.asset}`, 'Open the asset in the explorer'))}`]);
    if (r.tokAddr && r.sym !== 'ETH') rows.push(['Token', `${esc(r.sym)}${ics(cpI(r.tokAddr, 'the token\'s contract address'), lnI(`${SCAN}/token/${r.tokAddr}`, 'Open the token on Etherscan'))}`]);
    if (r.fee) rows.push([actNet === 'beam' ? 'Net fee' : 'Gas', `${num(r.fee, 8)} ${coin}${rateOf(coin) ? ` | ${usdSmall(r.fee * rateOf(coin))}` : ''}`]);
    if (r.comment && !r.ours) rows.push(['Comment', esc(r.comment)]);
    // the transaction in our explorer by its kernel; Beam gives a receipt none at times (then this wallet's own id, to copy)
    if (actNet === 'beam' && r.kern) rows.push(['Transaction', `${esc(short(r.kern))}${ics(lnI(`${EXPL}/kernel/${r.kern}`, 'Open the transaction in the explorer'))}`]);
    // no kernel: its block in the explorer (from the coins it made), else this wallet's own id to copy
    else if (actNet === 'beam' && r.block && !r.st) rows.push(['Transaction', `in block ${r.block}${ics(lnI(`${EXPL}/block/${r.block}`, 'Open its block in the explorer (Beam gave no kernel to open the transaction by)'))}`]);
    else if (actNet === 'beam' && r.id && !r.found && !String(r.id).startsWith('coin-')) rows.push(['Transaction', `${esc(short(r.id))}${ics(cpI(r.id, 'this wallet\'s id of the transaction (Beam gave no kernel to look it up by)'))}`]);
    if (actNet === 'eth' && r.hash) rows.push(['Transaction', `${esc(short(r.hash))}${ics(lnI(`${SCAN}/tx/${r.hash}`, 'Open the transaction on Etherscan'))}`]);
    if (r.block && !r.st && !(actNet === 'beam' && !r.kern)) rows.push(['Block', `${r.block}${ics(lnI(actNet === 'beam' ? `${EXPL}/block/${r.block}` : `${SCAN}/block/${r.block}`, actNet === 'beam' ? 'Open the block in the explorer' : 'Open the block on Etherscan'))}`]);
    const acts = [];
    if (r.cancel) acts.push(`<button type="button" class="btn warn" data-cancel="${esc(r.id)}">Cancel</button>`);
    const groups = rows.reduce((g, x) => { if (x === null) g.push([]); else g[g.length - 1].push(x); return g; }, [[]]).filter((g) => g.length);
    return `<div class="ar-more">${groups.map((g) => `<dl class="kv">${g.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`).join('')}${acts.length ? `<div class="ar-acts">${acts.join('')}</div>` : ''}</div>`;
  }

  function actDraw() {
    const base = folded(actRows), all = base.filter((r) => actFits(r));
    const live = all.filter((r) => r.st === 'pending'), rest = all.filter((r) => r.st !== 'pending');
    let html = '';
    if (live.length) html += `<div class="ad-day now"><span>Under way</span><span class="sum">${live.length}</span></div>${live.map(actRow).join('')}`;
    const days = new Map();
    for (const r of rest.slice(0, actShown)) { const k = day0(r.t); if (!days.has(k)) days.set(k, []); days.get(k).push(r); }
    const main = actNet === 'beam' ? 'BEAM' : 'ETH';
    for (const [k, rs] of days) {
      // the day's net: what came minus what went, in the network's coin, done ones only
      const sum = rs.filter((r) => isMain(r) && !r.st && r.v).reduce((s, r) => s + (came(r) ? r.v : r.kind === 'out' || r.kind === 'br-out' ? -r.v : 0), 0);
      html += `<div class="ad-day"><span>${dayName(k)}</span><span class="sum">${Math.abs(sum) >= 1e-9 ? `<b>${sum > 0 ? '+' : '−'}${num(Math.abs(sum), 4)}</b> ${main}` : ''}</span></div>${rs.map(actRow).join('')}`;
    }
    $('actList').innerHTML = html || `<div class="empty">${actQ || actKind !== 'all' ? 'nothing like that here' : 'no transactions yet'}</div>`;
    // more as the low-value tokens: a quiet button with how many are left
    const left = rest.length - actShown;
    $('afMore').hidden = left <= 0;
    $('afMore').innerHTML = left > 0 ? `<button type="button" class="btn ghost small">load older transactions (${left})</button>` : '';
    // the filters' counts, for what is in the list now
    for (const b of qa('#afKind button')) {
      const k = b.dataset.k, c = base.filter((r) => actFits(r, k)).length;
      b.innerHTML = `${k === 'dapp' ? 'dApps' : k[0].toUpperCase() + k.slice(1)}${k !== 'all' ? `<span class="n">${c}</span>` : ''}`;
    }
  }

  let actSeq = 0;
  async function activity() {
    const box = $('actList'), seq = ++actSeq, wid = W() && W().id, stale = () => seq !== actSeq || !isOpen(wid);
    const say = (t) => { actRows = []; box.innerHTML = `<div class="empty">${esc(t)}</div>`; $('afMore').hidden = true; };
    // the list stays while it refreshes; another wallet, network or account starts from loading…
    const a = acct(), forNow = `${wid}|${actNet}|${actNet === 'eth' && a ? a.address : ''}`;
    // whose list it is on Ethereum: the wallet tab's account, by name and short address at the bar's right end
    $('actAcct').hidden = actNet !== 'eth' || !a;
    if (actNet === 'eth' && a) { $('actAcct').innerHTML = `<span class="nm">${esc(a.name)}</span><span>|</span><span class="ad">${esc(short(a.address))}</span>`; }
    keepTidy();
    const lsKey = `${actNet}|${actNet === 'eth' && a ? a.address.toLowerCase() : ''}`;
    if (forNow !== actFor) {
      actFor = forNow; actRows = []; actOpen.clear(); actShown = 30;
      box.innerHTML = '<div class="empty">loading…</div>'; $('afMore').hidden = true;      // the other list off at once
      // the list as last shown opens at once (from Activity's memory), the new one replaces it when it comes
      const kept = wid ? ((await keepOf(wid)).ls || {})[lsKey] : null;
      if (stale()) { if (actFor === forNow) actFor = ''; return; }
      if (kept && kept.length) { actRows = kept; actDraw(); }      // (else loading… stays, no button under it)
    }
    try {
      let rows;
      if (actNet === 'beam') {
        if (!beamHere()) return say('this wallet has no running Beam part');
        rows = await beamActRows(wid);
        if (stale()) return;
      } else {
        if (!a) return say('this wallet has no Ethereum part');
        const list = await host('ethHistory', a.address);
        if (stale() || !acct() || acct().address !== a.address) return;
        rows = ethActRows(list);
      }
      actRows = rows;
      actDraw();
      // kept as shown, for the next opening (these rows, not whatever is shown by then): the newest 300, without what
      // is only for drawing and without Cancel (a kept transfer may be done by the next opening)
      const kp = await keepOf(wid);
      if (rows.length) kp.ls[lsKey] = rows.slice(0, 300).map(({ beamK, beamB, items, group, cancel, ...r }) => r); else delete kp.ls[lsKey];
      keepSave();
    } catch (e) { if (!stale()) say(msg(e)); }
  }

  $('afKind').onclick = (e) => { const b = e.target.closest('button[data-k]'); if (!b) return; actKind = b.dataset.k; qa('#afKind button').forEach((x) => x.classList.toggle('on', x === b)); actDraw(); };
  // the search takes the filters' place and shows all it finds (the filter back to All); closed, the filters come back
  $('afFind').onclick = () => {
    const r = $('afSearchRow'), on = r.hidden;
    r.hidden = !on; $('afKind').hidden = on; $('afFind').classList.toggle('on', on);
    if (on) { actKind = 'all'; qa('#afKind button').forEach((x) => x.classList.toggle('on', x.dataset.k === 'all')); $('afQ').focus(); } else { actQ = ''; $('afQ').value = ''; }
    actDraw();
  };
  $('afQ').onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); $('afFind').click(); } };
  $('afQ').oninput = () => { actQ = $('afQ').value.trim(); actDraw(); };
  $('afX').onclick = () => { $('afQ').value = ''; actQ = ''; actDraw(); $('afQ').focus(); };
  $('afMore').onclick = (e) => { if (!e.target.closest('button')) return; actShown += 30; actDraw(); };
  $('actList').onclick = async (e) => {
    const c = e.target.closest('[data-cp]');
    if (c) return copyFlash(c, c.dataset.cp);
    const x = e.target.closest('[data-cancel]');
    if (x) {
      if (!(await confirmBox('Cancel the transfer', [['Transaction', x.dataset.cancel]], 'Only a transfer the other wallet has not signed yet can be cancelled.'))) return;
      try { await host('beam', W().id, 'tx_cancel', { txId: x.dataset.cancel }); activity(); } catch (err) { ask({ title: 'Not done', note: msg(err), yes: 'OK', no: null }); }
      return;
    }
    if (e.target.closest('.ar-more') || e.target.closest('a')) return;
    const li = e.target.closest('.li.ar'); if (!li) return;
    if (actOpen.has(li.dataset.id)) actOpen.delete(li.dataset.id); else actOpen.add(li.dataset.id);
    actDraw();
  };
  $('actList').onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.li.ar')) { e.preventDefault(); e.target.click(); } };

  // ---------- Settings ----------
  // (worked out in lab/settings.html) Quiet tabs in the header: Wallets, General, Networks, Storage, About
  let setSec = 'wallets';
  $('setNav').onclick = (e) => {
    const b = e.target.closest('button[data-s]'); if (!b) return;
    setSec = b.dataset.s;
    qa('#setNav button').forEach((x) => x.classList.toggle('on', x === b));
    qa('#t-settings .sp-sec').forEach((s) => { s.hidden = s.dataset.s !== setSec; });
    document.querySelector('main').scrollTop = 0;
    setSecOpen();
  };
  const autoLockDd = BB.dropdown($('autoLock'), (v) => host('setAutoLock', Number(v)));
  // under each display picker, how it shows: white, BEAM grey
  const dispEx = () => {
    const t = new Date(2026, 10, 11, 14, 5).getTime();
    $('timeEx').textContent = fdt(t);
    $('decEx').innerHTML = `${esc(amt(123412345679, decShown))} <span class="u">BEAM</span>`;
  };
  const timeDd = BB.dropdown($('timeFmt'), (v) => { time12 = v === '12'; chrome.storage.local.set({ time12 }).catch(() => {}); dispEx(); });
  chrome.storage.local.get('time12').then((v) => { time12 = !!v.time12; }).catch(() => {});
  // how many decimals amounts show: drawn again at once where they are (the wallet tab, the bridge)
  const decDd = BB.dropdown($('decFmt'), (v) => {
    decShown = Number(v) || 6; chrome.storage.local.set({ decShown }).catch(() => {});
    dispEx();
    try { renderBeam(); ethRows(); bxCalc(); transfers(); } catch {}
  });
  chrome.storage.local.get('decShown').then((v) => { if ([2, 4, 6, 8].includes(v.decShown)) decShown = v.decShown; decDd.set(String(decShown)); }).catch(() => {});
  async function settingsOpen() {
    autoLockDd.set(String(st.autoLock));
    timeDd.set(time12 ? '12' : '24'); decDd.set(String(decShown)); dispEx();
    keepTidy().then(keepInfo);
    drawWallets();
    setSecOpen();
  }
  // what a section reads when it is shown
  function setSecOpen() {
    if (setSec === 'general') bkInfo();
    if (setSec === 'networks') { drawNodes(); drawRpcs(); (window.requestIdleCallback || setTimeout)(() => probeAll(), { timeout: 1000 }); }      // once the popup is idle after drawing
    probeLoop();
    if (setSec === 'storage') { snapInfo(); keepTidy().then(keepInfo); }
    if (setSec === 'about') drawAbout();
  }
  $('addWallet').onclick = () => welcome();

  // ---------- Settings: Wallets ----------
  // one row each: its networks' dots, its name, what it holds, the open one marked current (the header's picker
  // switches); a click opens its card: This wallet (Rename, Seed phrase) and Ethereum (its own Seed phrase when added
  // by one, Private key) side by side, the account picker under them as the wallet tab's, Remove last
  const wOpen = new Set(), wPick = {};
  // the card's account: the one picked here while it is still the wallet's, else the wallet tab's, else the first
  const pickOf = (w) => { const has = (i) => i != null && w.accounts.some((x) => x.i === i); return has(wPick[w.id]) ? wPick[w.id] : has(st.activeEth[w.id]) ? st.activeEth[w.id] : w.accounts[0].i; };
  // drawn again in place: a row or a card is replaced only when what it shows changed (a switch changes two rows'
  // marks), so an open card's picker does not blink
  const WPEN = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13h3l7.5-7.5-3-3L3 10z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';      // the rename pencil, as a Beam address's
  const wRowSig = (w) => JSON.stringify([w.name, !!w.beam, !!w.eth, w.accounts.length, w.id === st.active]);
  // its Beam database gone (or not starting): Restore Beam offered on its card
  const beamLost = (w) => !!(w.beam && st.beam && st.beam[w.id] && ['missing', 'failed'].includes(st.beam[w.id].status));
  const wCardSig = (w) => JSON.stringify([w.accounts.map((a) => [a.i, a.name, a.address, a.kind]), w.phraseKnown, w.ethKind, !!w.eth, w.hd, beamLost(w)]);
  function wRowHtml(w) {
    const isOpen = wOpen.has(w.id);
    const holds = [w.beam ? 'Beam' : '', w.eth ? `Ethereum ×${w.accounts.length}` : ''].filter(Boolean).join('<i class="sp"></i>');
    return `<div class="li wr${isOpen ? ' open' : ''}" data-w="${esc(w.id)}" data-sig="${esc(wRowSig(w))}" tabindex="0" role="button" aria-expanded="${isOpen}">
      <span class="what"><span class="nets">${w.beam ? '<i class="chain beam"></i>' : ''}${w.eth ? '<i class="chain eth"></i>' : ''}</span>${esc(w.name)}<button type="button" class="cp w-ren" data-ren="${esc(w.id)}" title="Rename the wallet">${WPEN}</button><span class="sub">${holds}</span></span>
      ${w.id === st.active ? '<span class="end">current</span>' : '<span></span>'}</div>`;
  }
  const html1 = (h) => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstElementChild; };
  function drawWallets() {
    const box = $('wList'), ids = new Set(st.wallets.map((w) => w.id));
    for (const li of qa('#wList .li.wr')) if (!ids.has(li.dataset.w)) { const c = li.nextElementSibling; if (c && c.classList.contains('wcard2')) c.remove(); li.remove(); }
    let at = null;      // the last element placed
    for (const w of st.wallets) {
      let li = box.querySelector(`.li.wr[data-w="${CSS.escape(w.id)}"]`);
      if (!li || li.dataset.sig !== wRowSig(w)) { const n = html1(wRowHtml(w)); if (li) li.replaceWith(n); li = n; }
      if (at ? at.nextElementSibling !== li : box.firstElementChild !== li) { if (at) at.after(li); else box.prepend(li); }
      at = li;
      let c = li.nextElementSibling && li.nextElementSibling.classList.contains('wcard2') ? li.nextElementSibling : null;
      if (!wOpen.has(w.id)) { if (c) c.remove(); continue; }
      if (!c || c.dataset.sig !== wCardSig(w)) {
        const n = html1(wCard(w)); if (c) c.replaceWith(n); else li.after(n); c = n;
        const d = c.querySelector('[data-acct]'); if (d) { wAcctDd(d, w); ethPhraseBtn(w); }
      }
      at = c;
    }
  }
  function wCard(w) {
    const g = (cap, acts) => `<div class="grp"><div class="cap">${cap}</div><div class="acts">${acts.join('')}</div></div>`;
    const b = (a, t, cls = '') => `<button type="button" class="sbtn${cls ? ` ${cls}` : ''}" data-a="${a}">${t}</button>`;
    // the Beam file: Beam's own exchange file of this wallet (addresses, their names, contacts, transactions; no keys),
    // as Beam's CLI and mobile wallets save and take it; and one taken in
    const mine = [w.phraseKnown ? b('phrase', 'Seed phrase') : '', w.beam ? b('backup', 'Export data') : ''].filter(Boolean);      // Rename is the pencil by the name
    // Ethereum's Seed phrase: the picked account's own (imported by a phrase), or the Ethereum part's when added by one
    const eth = w.eth && w.accounts.length ? [b('ethKey', 'Private key'), b('ethPhrase', 'Seed phrase')] : [];      // the key first (every account has one), its phrase after
    const picker = eth.length ? `<div class="acct-row"><div class="dd compact acct" data-acct="${esc(w.id)}"><button type="button" class="dd-btn" aria-haspopup="listbox" aria-expanded="false"></button><ul class="dd-list" role="listbox" tabindex="-1" hidden></ul></div></div>` : '';
    return `<div class="wcard2" data-sig="${esc(wCardSig(w))}"><div class="cols">${mine.length ? g('This wallet', mine) : '<div></div>'}${eth.length ? g('Ethereum', eth) : ''}</div>${picker}${g('Manage', [beamLost(w) ? b('restoreBeam', 'Restore Beam') : '', w.beam ? b('beamIn', 'Import wallet data') : '', b('remove', 'Remove the wallet', 'warn')].filter(Boolean))}</div>`;      // Manage: what changes the wallet
  }
  const hasEthPhrase = (w, i) => { const a = w.accounts.find((x) => x.i === i); return !!a && (a.kind === 'phrase' || (a.kind === 'hd' && w.ethKind === 'phrase')); };
  // the Ethereum Seed phrase button only for an account that has one
  const ethPhraseBtn = (w) => { const c = qa('#wList .wcard2').find((x) => x.previousElementSibling.dataset.w === w.id), btn = c && c.querySelector('[data-a="ethPhrase"]'); if (btn) btn.hidden = !hasEthPhrase(w, pickOf(w)); };
  // the card's account picker, as the wallet tab's (its accounts, then add / import / rename / remove), opened on the
  // wallet tab's account; picked here, it is the card's only (the wallet tab keeps its own); its address runs and settles
  function wAcctDd(d, w) {
    const at = pickOf(w);
    const act = (v, icon, text) => ({ v, label: text, html: `<span class="mi">${icon}</span><span>${esc(text)}</span>` });
    const dd = BB.dropdown(d, async (v) => {
      try {
        if (v === '__add') await host('addEthAccount', w.id);
        else if (v === '__import') { if (!(await importAccount(w))) return; }
        else if (v === '__rename') await renameAccount(w, w.accounts.find((x) => x.i === pickOf(w)));
        else if (v === '__remove') await removeAccount(w, w.accounts.find((x) => x.i === pickOf(w)));
        else {
          const was = pickOf(w); wPick[w.id] = Number(v);
          const a = w.accounts.find((x) => x.i === Number(v)), ad = d.querySelector('.dd-btn .ad');
          if (a && ad && Number(v) !== was) BB.decode(ad, short(a.address));
          ethPhraseBtn(w);
          return;
        }
      } catch (e) { await ask({ title: 'Not done', note: msg(e), yes: 'OK', no: null }); }
      await load(); drawWallets();
    });
    dd.options([...w.accounts.map((x) => ({ v: String(x.i), label: `${x.name} ${short(x.address)}`, html: `<span class="nm">${esc(x.name)}</span><span class="ad">${short(x.address)}</span>`,
      btn: `<span class="acc-b"><span class="nm">${esc(x.name)}</span><span class="ad">${short(x.address)}</span></span>` })),
      { sep: true },
      ...(w.hd ? [act('__add', ICON.add, 'Add an account')] : []), act('__import', ICON.import, 'Import an account'),
      act('__rename', ICON.rename, 'Rename this account'), ...(w.accounts.length > 1 ? [act('__remove', ICON.remove, 'Remove this account')] : [])], String(at));
    accDrag(d.querySelector('.dd-list'), (li) => { const v = li.dataset.v; return v && !v.startsWith('__') ? { wallet: w.id, i: Number(v) } : null; }, accOrdered);
  }
  $('wList').onclick = (e) => {
    const rn = e.target.closest('[data-ren]');
    if (rn) return walletAct(st.wallets.find((x) => x.id === rn.dataset.ren), 'rename');
    const a = e.target.closest('[data-a]');
    if (a) { const w = st.wallets.find((x) => x.id === a.closest('.wcard2').previousElementSibling.dataset.w); return walletAct(w, a.dataset.a); }
    if (e.target.closest('.wcard2')) return;
    const li = e.target.closest('.li.wr'); if (!li) return;
    // only this wallet's card opens or closes: the others (their pickers) stay as they are, nothing blinks
    const id = li.dataset.w, w = st.wallets.find((x) => x.id === id), was = li.nextElementSibling && li.nextElementSibling.classList.contains('wcard2') ? li.nextElementSibling : null;
    if (wOpen.has(id)) { wOpen.delete(id); if (was) was.remove(); }
    else if (w) {
      wOpen.add(id); drawWallets();
    }
    li.classList.toggle('open', wOpen.has(id)); li.setAttribute('aria-expanded', String(wOpen.has(id)));
  };
  $('wList').onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.li.wr')) { e.preventDefault(); e.target.click(); } };

  // a Beam file into a wallet: its addresses, names, contacts and transactions added (the same seed's wallet)
  let bdFor = null;
  $('bdFile').onchange = async () => {
    const f = $('bdFile').files && $('bdFile').files[0], w = bdFor; if (!f || !w) return;
    const text = await f.text();
    const r = await ask({ title: `Import wallet data into ${w.name}`, password: true, yes: 'Import', note: `${f.name}\nIts addresses, their names, contacts and transactions are added to this wallet. It should come from a wallet of the same seed phrase.`,
      check: async ({ pass }) => { await host('beamData', w.id, pass, text); } });
    if (!r.ok) return;
    // the addresses added by hand and not verified yet are checked again against what came in: one now among the
    // wallet's own (Beam took it from the file with its key number) or named by an imported payment is verified
    const open0 = (await host('addrExt', w.id).catch(() => [])).filter((e) => !e.verified);
    let now = 0;
    if (open0.length && isOpen(w.id)) {
      const own = new Set((await host('beam', w.id, 'addr_list', { own: true }).catch(() => [])).map((x) => x.address));
      for (const e of open0) if (own.has(e.address)) { await host('setAddrExt', w.id, { ...e, verified: 'own' }).catch(() => {}); now++; }
      await loadAddrs().catch(() => {});
      now = open0.length - (await host('addrExt', w.id).catch(() => [])).filter((e) => !e.verified).length;
    }
    ask({ title: 'Imported', yes: 'OK', no: null, html: `<p class="imp-res">The addresses and the history are in this wallet now.${open0.length ? `<br>Manually added and not verified addresses: <b>${open0.length}</b>${isOpen(w.id) ? `<br>Verified now: <b>${now}</b>` : '<br>They are checked again when this wallet is opened'}` : ''}</p>` });
  };

  // ---------- Settings: Backup ----------
  // one file with every wallet (the vault as stored, sealed with the wallet password), Beam's databases if asked
  async function bkInfo() {
    $('bkLast').innerHTML = st.lastBackup ? `<span>last: <b>${esc(fdt(st.lastBackup))}</b>${st.lastBackupId != null ? `<button type="button" class="cp bk-show" title="Show the file in its folder">${DLI}</button>` : ''}</span>` : '<span>none yet</span>';
    try { const n = await host('beamDbSize'); $('bkSize').textContent = n ? `~${Math.max(1, Math.round(n / 2 ** 20))} MB now` : ''; } catch {}
  }
  // Make: the backup made and kept in this browser (its time by the title); Download: that one saved into
  // Downloads/BumbleBeam, counted only once it is complete on disk (the icon by the time then shows it in its folder)
  $('bkSave').onclick = async () => {
    let out = null;
    const r = await ask({ title: 'Make a backup', password: true, yes: 'Make it',
      note: `Every wallet of BumbleBeam in one file, encrypted with the wallet password${$('bkDb').checked ? ', with Beam history and address names' : ''}. It opens only with the password it was made with. Download it to keep it outside the browser.`,
      check: async ({ pass }) => { out = await host('backupMake', pass, $('bkDb').checked); } });
    if (!r.ok || !out) return;
    st.lastBackup = out.at; st.lastBackupId = null; bkInfo(); bkSay('made: download it to keep it');
    if (out.left && out.left.length) ask({ title: 'Made, without some Beam databases', note: `Beam's database of ${out.left.join(', ')} could not be read (missing, or a transfer under way): those wallets are in it by their keys only. Their history comes back from the chain or an exported wallet data file.`, yes: 'OK', no: null });
  };
  $('bkDown').onclick = async () => {
    const last = await host('backupLast').catch(() => null);
    if (!last) return bkSay('make a backup first');
    const d = new Date(last.at), name = `bumblebeam-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.bbk`;
    bkSay('saving…');
    const r2 = await chrome.runtime.sendMessage({ op: 'download', b64: last.b64, name }).catch((e) => ({ error: e.message }));
    if (!r2 || r2.error || !r2.result) { bkSay(''); return ask({ title: 'Not saved', note: (r2 && r2.error) || 'the browser did not save it', yes: 'OK', no: null }); }
    await host('backupSaved', r2.result.id).catch(() => {});
    st.lastBackupId = r2.result.id; bkInfo(); bkSay('saved into Downloads/BumbleBeam');
  };
  // the backup's word, in yellow on its own line under the buttons (its room kept), gone after 5 s
  let bkT = 0;
  let bkT2 = 0;
  const bkSay = (t) => { const m = $('bkMsg'); m.textContent = t; m.classList.remove('going'); clearTimeout(bkT); clearTimeout(bkT2); bkT = setTimeout(() => { m.classList.add('going'); bkT2 = setTimeout(() => { m.textContent = ''; m.classList.remove('going'); }, 600); }, 5000); };
  // the download icon by the time: the file in its folder (Chrome's own Show in folder); gone, it says so
  const DLI = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v7.5M4.8 7l3.2 3.2L11.2 7M3 13.5h10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  $('bkLast').onclick = async (e) => {
    if (!e.target.closest('.bk-show')) return;
    const [d] = await chrome.downloads.search({ id: st.lastBackupId }).catch(() => []);
    if (d && d.exists !== false && d.state === 'complete') chrome.downloads.show(st.lastBackupId);
    else bkSay('that file is no longer where it was saved');
  };
  $('bkImport').onclick = () => { $('bkFile').value = ''; $('bkFile').click(); };
  $('bkFile').onchange = async () => {
    const f = $('bkFile').files && $('bkFile').files[0]; if (!f) return;
    const text = await f.text();
    let res = null, filePass = '';
    const r1 = await ask({ title: 'Import a backup', input: { label: 'The password the file was saved with', secret: true }, yes: 'Next', note: f.name,
      check: async ({ input }) => { filePass = input; if (!input) throw new Error('its password, please'); } });
    if (!r1.ok) return;
    const r2 = await ask({ title: 'Import a backup', password: true, yes: 'Import', note: 'The wallets it has and this extension does not are added. A Beam part without its database in the file comes back from its phrase through the recovery snapshot, which takes a few minutes.',
      check: async ({ pass }) => { res = await host('backupImport', text, filePass, pass); } });
    if (!r2.ok || !res) return;
    await load(); drawWallets(); bkSay(res.added.length ? `imported: ${res.added.join(', ')}` : 'nothing new in the file');
    ask({ title: res.added.length ? 'Imported' : 'Nothing new', rows: [['Added', res.added.join('\n') || 'none'], ...(res.skipped.length ? [['Already here', res.skipped.join('\n')]] : [])], yes: 'OK', no: null });
  };

  // ---------- Settings: Networks ----------
  // Beam's nodes as one list (the first is used, the others in turn from the top), each probed for whether it answers
  // and how fast; Ethereum's own RPC above the public ones. A click opens what is behind a row
  const XI2 = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  const BEHIND = {
    'wss.bumblebeam.org:443': [['What', 'BumbleBeam Beam node'], ['Through', 'BumbleBeam WebSocket door'], ['Also', 'BumbleBeam pool\'s node']],
    'wsb.bumblebeam.org:443': [['What', 'backup door - a Cloudflare Worker to BeamMW\'s public nodes'], ['Passes to', 'in a random order:\n188.245.67.32:8100\n188.245.67.33:8100\n188.245.67.34:8100\n188.245.67.35:8100\n5.161.152.212:8100\n195.201.121.246:10000 sunpool\nBumbleBeam Beam node']],
  };
  const OURS = ['wss.bumblebeam.org:443', 'wsb.bumblebeam.org:443'];      // our two nodes: moved, never removed
  const PUBLIC_RPCS = ['ethereum-rpc.publicnode.com', 'eth.llamarpc.com', 'eth.drpc.org', '1rpc.io/eth'];
  const probe = {}, nOpen = new Set();
  const behind = (key, rows) => (nOpen.has(key) ? `<div class="nd-more"><dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>` : '');
  // a check by hand, left of the time: that row asked again now, the 30 s counted from here
  const RE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 7.5A5.5 5.5 0 0 1 12.2 4.6M12.6 1.8v3h-3M13.5 8.5A5.5 5.5 0 0 1 3.8 11.4M3.4 14.2v-3h3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';      // two arrows round
  const reI = (k) => `<button type="button" class="cp re" data-re="${esc(k)}" title="Check it now">${RE}</button>`;
  const stOf = (p) => (!p ? '' : p.bad ? 'bad' : p.ms > 500 ? 'slow' : 'ok');
  const msOf = (p) => (!p ? '' : p.bad ? 'no answer' : `${p.ms} ms`);      // nothing until it is measured
  function drawNodes() {
    const list = st.nodes || [st.node];
    $('nodes').innerHTML = list.map((h, i) => `<div class="node${i === 0 ? ' use' : ''}${nOpen.has(h) ? ' open' : ''}" draggable="true" data-i="${i}" data-k="${esc(h)}"><i class="st ${stOf(probe[h])}"></i><span class="h">${esc(h)}</span><span class="meta">${reI(h)}<span class="t">${msOf(probe[h])}</span></span>${OURS.includes(h) ? '<span></span>' : `<button type="button" class="cp a-x" data-x="${i}" title="Remove this node">${XI2}</button>`}</div>${behind(h, BEHIND[h] || [['What', 'a node added by you'], ['Answers', msOf(probe[h])]])}`).join('');
    const h = beamStatus && beamStatus.current_height;
    $('beamNet').innerHTML = h ? `<span>block: <b>${esc(h.toLocaleString('en-US').replace(/,/g, '⁠ ⁠'))}</b></span>` : '';
  }
  function drawRpcs() {
    const own = st.ethRpc || '';
    $('rpcs').innerHTML = (own ? `<div class="node use${nOpen.has(own) ? ' open' : ''}" data-k="${esc(own)}"><i class="st ${stOf(probe[own])}"></i><span class="h">${esc(own.replace(/^https:\/\//, ''))}</span><span class="meta"><span class="t">${msOf(probe[own])}</span></span><button type="button" class="cp a-x" data-rx="1" title="Remove this RPC">${XI2}</button></div>${behind(own, [['What', 'an RPC added by you, asked first']])}` : '')
      + `<div class="node${own ? '' : ' use'}${nOpen.has('public') ? ' open' : ''}" data-k="public"><i class="st ${stOf(probe.public)}"></i><span class="h">public RPCs</span><span class="meta end"><span class="t"><span class="tipped" title="Four public RPCs, asked in turn: when one does not answer, the next one is">${PUBLIC_RPCS.length}</span></span></span></div>${behind('public', [['Asked in turn', PUBLIC_RPCS.join('\n')], ['Activity from', 'eth.blockscout.com']])}`;
    const b = probe.ethBlock;
    $('ethNet').innerHTML = b ? `<span>block: <b>${esc(b.toLocaleString('en-US').replace(/,/g, '⁠ ⁠'))}</b></span>` : '';
  }
  // whether each answers: a node by opening its WebSocket, an RPC by asking its last block (5 s at most)
  const probeWs = (h) => new Promise((res) => {
    const t0 = performance.now(); let ws, done = false;
    const end = (p) => { if (done) return; done = true; try { ws.close(); } catch {} res(p); };
    try { ws = new WebSocket(`wss://${h}`); } catch { return res({ bad: true }); }
    ws.onopen = () => end({ ms: Math.round(performance.now() - t0) });
    ws.onerror = () => end({ bad: true });
    setTimeout(() => end({ bad: true }), 5000);
  });
  const probeRpc = async (url) => {
    const t0 = performance.now();
    try {
      const c = new AbortController(), t = setTimeout(() => c.abort(), 5000);
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }), signal: c.signal });
      clearTimeout(t);
      const j = await r.json(); if (!j.result) throw new Error('no answer');
      return { ms: Math.round(performance.now() - t0), block: parseInt(j.result, 16) };
    } catch { return { bad: true }; }
  };
  // while Networks is on screen, the probes again every 30 s (the figures change in place)
  let probeT = 0;
  function probeLoop() {
    clearInterval(probeT);
    if (setSec !== 'networks') return;
    probeT = setInterval(() => { if ($('t-settings').hidden || setSec !== 'networks') return clearInterval(probeT); probeAll(); }, 30000);
  }
  // A node's time: a first connection only warms the way up (the name lookup, the TLS handshake, and on opening a
  // popup still busy with its start: seconds that say nothing of the node), then two measured, the faster shown
  async function nodeTime(h) {
    await probeWs(h);
    const a = await probeWs(h), b = await probeWs(h);
    return a.bad && b.bad ? a : { ms: Math.min(a.bad ? Infinity : a.ms, b.bad ? Infinity : b.ms) };
  }
  async function recheck(k) {
    probeLoop();      // the 30 s start again from now
    const spin = qa(`[data-re="${CSS.escape(k)}"]`); spin.forEach((b) => b.classList.add('turning'));
    if (k === 'public') { probe.public = { bad: true }; for (const u of PUBLIC_RPCS) { const p = await probeRpc(`https://${u}`); if (!p.bad) { probe.public = p; if (p.block) probe.ethBlock = Math.max(probe.ethBlock || 0, p.block); break; } } drawRpcs(); return; }
    if (/^https:/.test(k)) { probe[k] = await probeRpc(k); drawRpcs(); return; }
    probe[k] = await nodeTime(k);
    drawNodes();
  }
  let probeGen = 0;
  async function probeAll() {
    const g = ++probeGen;
    for (const h of st.nodes || []) nodeTime(h).then((p) => { if (g !== probeGen) return; probe[h] = p; if (setSec === 'networks') drawNodes(); });
    const pub = PUBLIC_RPCS.map((x) => `https://${x}`).filter((u) => u !== st.ethRpc);
    const urls = [...(st.ethRpc ? [st.ethRpc] : []), ...pub];
    let pubDone = false, pubLeft = pub.length;
    for (const u of urls) probeRpc(u).then((p) => {
      if (g !== probeGen) return;
      if (u === st.ethRpc) probe[u] = p;
      else if (!pubDone && !p.bad) { pubDone = true; probe.public = p; }
      else if (!pubDone && !--pubLeft) probe.public = { bad: true };      // none of them answered
      if (p.block) probe.ethBlock = Math.max(probe.ethBlock || 0, p.block);
      if (setSec === 'networks') drawRpcs();
    });
  }
  const setNodes = async (list) => { try { st.nodes = await host('setNodes', list); st.node = st.nodes[0]; } catch (e) { await ask({ title: 'Not changed', note: msg(e), yes: 'OK', no: null }); } drawNodes(); probeAll(); };
  // dragged as Beam's addresses: a line above or below the row it would go to
  let nDrag = null;
  const nMarks = () => qa('#nodes .drop-above, #nodes .drop-below').forEach((r) => r.classList.remove('drop-above', 'drop-below'));
  $('nodes').addEventListener('dragstart', (e) => { const r = e.target.closest('.node'); if (!r) return; nDrag = Number(r.dataset.i); r.classList.add('dragging'); });
  $('nodes').addEventListener('dragend', () => { nDrag = null; nMarks(); qa('#nodes .dragging').forEach((r) => r.classList.remove('dragging')); });
  $('nodes').addEventListener('dragover', (e) => {
    e.preventDefault(); const r = e.target.closest('.node'); nMarks(); if (!r || Number(r.dataset.i) === nDrag) return;
    const b = r.getBoundingClientRect(); r.classList.add(e.clientY < b.top + b.height / 2 ? 'drop-above' : 'drop-below');
  });
  $('nodes').addEventListener('drop', (e) => {
    e.preventDefault(); const r = e.target.closest('.node'); if (!r || nDrag == null) return nMarks();
    const above = r.classList.contains('drop-above'); nMarks();
    const list = (st.nodes || []).slice(); let to = Number(r.dataset.i) + (above ? 0 : 1); const [n] = list.splice(nDrag, 1); if (nDrag < to) to--; list.splice(to, 0, n); nDrag = null;
    if (list.join() !== (st.nodes || []).join()) setNodes(list);      // dropped where it was: nothing to do
  });
  $('nodes').onclick = (e) => {
    const re = e.target.closest('[data-re]'); if (re) return recheck(re.dataset.re);
    const x = e.target.closest('[data-x]');
    if (x) { const list = (st.nodes || []).slice(); list.splice(Number(x.dataset.x), 1); return setNodes(list); }
    const r = e.target.closest('.node'); if (!r) return; const k = r.dataset.k; if (nOpen.has(k)) nOpen.delete(k); else nOpen.add(k); drawNodes();
  };
  $('nodeAdd').onclick = async () => {
    actErr($('nodeAdd'), null);
    const v = $('nodeIn').value.trim().replace(/^wss:\/\//, '').replace(/\/$/, '');
    if (!/^[\w.-]+:\d{1,5}$/.test(v)) return actErr($('nodeAdd'), new Error('host:port, a WebSocket door'));
    $('nodeIn').value = ''; await setNodes([...(st.nodes || []), v]);
  };
  $('rpcs').onclick = async (e) => {
    const re = e.target.closest('[data-re]'); if (re) return recheck(re.dataset.re);
    if (e.target.closest('[data-rx]')) {
      const was = st.ethRpc;
      try { await host('setEthRpc', ''); st.ethRpc = ''; if (was) chrome.permissions.remove({ origins: [new URL(was).origin + '/*'] }).catch(() => {}); } catch (err) { actErr($('rpcAdd'), err); }
      drawRpcs(); return;
    }
    const r = e.target.closest('.node[data-k]'); if (!r) return; const k = r.dataset.k; if (nOpen.has(k)) nOpen.delete(k); else nOpen.add(k); drawRpcs();
  };
  $('rpcAdd').onclick = async () => {
    actErr($('rpcAdd'), null);
    const url = $('ethRpc').value.trim();
    try {
      if (!url) throw new Error('an https:// address');
      if (new URL(url).protocol !== 'https:') throw new Error('an https:// address (not http)');
      const origin = new URL(url).origin + '/*';
      if (!(await chrome.permissions.request({ origins: [origin] }))) throw new Error('the browser did not allow that address');
      await host('setEthRpc', url); st.ethRpc = url; $('ethRpc').value = ''; drawRpcs(); probeAll();
    } catch (e) { actErr($('rpcAdd'), e); }
  };
  // ---------- Settings: Storage and About ----------
  async function snapInfo() {
    const s = await host('snapshotInfo').catch(() => null);
    $('snapSize').textContent = s ? `${(s.size / 2 ** 20).toFixed(0)} MB` : '';
    $('snapInfo').innerHTML = s ? `Beam's snapshot kept from the last restore: <b>${esc(fdate(s.at))}</b><br>A restore from a seed phrase starts from it instead of downloading it again (<b>~320 MB</b>, a few minutes).` : 'None kept: a restore from a seed phrase downloads it (~320 MB, a few minutes).';
    $('snapRow').hidden = !s;
  }
  function drawAbout() {
    const PIPE = 'e63bd26ca5b226558686dd191122a8e5d6861a97597db9f40bda48aef6dbe835', ETHP = '0x6063024646E8A1561970840a4b0e0f1082f5a670';
    const s7 = (a) => `${a.slice(0, 7)}…${a.slice(-7)}`;
    const cpI2 = (v, what) => `<button type="button" class="cp" data-cp="${esc(v)}" data-tip-wide title="Copy ${esc(what)}\n${esc(v)}">${CPI}</button>`;
    const lnI2 = (href, what) => `<a class="cp" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(what)}">${LINK}</a>`;
    $('aboutKv').innerHTML = `<dt>Version</dt><dd><a class="text-link" href="https://github.com/profinch/bumblebeam/blob/main/beam/wallet/CHANGELOG.md" target="_blank" rel="noopener">${esc(chrome.runtime.getManifest().version)}</a> changelog</dd>
      <dt>Beam engine</dt><dd>BeamMW wasm-client 7.5.14548\nafter HF6</dd>
      <dt>Bridge</dt><dd>${esc(s7(PIPE))}<span class="ar-ics">${cpI2(PIPE, 'the bridge\'s contract id')}${lnI2(`https://explorer.bumblebeam.org/contract/${PIPE}`, 'Open the contract in the explorer')}</span> on Beam\n${esc(short(ETHP))}<span class="ar-ics">${cpI2(ETHP, 'the bridge\'s contract address')}${lnI2(`https://etherscan.io/address/${ETHP}`, 'Open the contract on Etherscan')}</span> on Ethereum</dd>
      <dt>Source</dt><dd><a class="text-link" href="https://github.com/profinch/bumblebeam/tree/main/beam/wallet" target="_blank" rel="noopener">github.com/profinch/bumblebeam</a></dd>
      <dt>Licence</dt><dd>Apache-2.0</dd>`;
  }
  $('aboutKv').onclick = (e) => { const c = e.target.closest('[data-cp]'); if (c) copyFlash(c, c.dataset.cp); };
  // the explanations fold open and shut by their link and arrow (the catalog's)
  qa('#t-settings .fold-arrow').forEach((a) => { a.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'; });
  $('t-settings').addEventListener('click', (e) => { const h = e.target.closest('.fold-h, .fold-arrow'); if (h) { e.preventDefault(); h.parentElement.classList.toggle('open'); } });

  // ---------- dApps ----------
  const six = short;
  const ethAmt = (wei) => `${num(units(wei, 18), 6)} ETH`;
  // the window's screen: the oldest waiting request, what it asks, Approve / Reject; none left: the window closes
  let dpCur = null, dpShown = null;                 // the request in the window; the one last put in it
  // a request just shown: its button waits 0.6 s, so a quick second click meant for the one before cannot agree to
  // it (every kind, Beam's too)
  function dpHold(r, can) {
    if (!can || r.id === dpShown) return;
    dpShown = r.id; $('dpYes').disabled = true;
    setTimeout(() => { if (dpCur && dpCur.id === r.id && !dpBusy) $('dpYes').disabled = false; }, 600);
  }
  let dpSeq = 0;      // each drawing numbered: one that awaited is not drawn over a newer one (Approve answers what shows)
  async function dappScreen() {
    const seq = ++dpSeq;
    let list = [];
    try { list = await host('dappPending'); } catch {}
    if (seq !== dpSeq) return;
    // a Beam contract transaction's reading, made before anything is drawn or taken as the current request
    const pre = list[0] && list[0].kind === 'beamtx' ? await consentRows(list[0].info, list[0].amounts).catch(() => [['Reading', 'not available']]) : null;
    if (seq !== dpSeq) return;
    $('dpNote').classList.remove('warn-own');
    if (!list.length) { dpCur = null; if (inWin) { await host('dappWinDone').catch(() => {}); return window.close(); } return; }
    const same = dpCur && dpCur.id === list[0].id;
    const r = dpCur = list[0];
    if (!same) clearNotes('s-dapp');      // the same request again (its answer failed): its error stays
    const acc = r.address ? (st.wallets || []).flatMap((w) => w.accounts.map((a) => ({ w, a }))).find((x) => x.a.address.toLowerCase() === r.address.toLowerCase()) : null;
    // the name, then the whole address on the next line (they do not fit on one)
    const accRow = r.address ? [['Account', `${acc ? `${acc.a.name}\n` : ''}${r.address}`]] : [['Account', 'this wallet has no Ethereum account']];
    const kv = (rows) => `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
    $('dpSite').textContent = r.origin;
    // Beam: the account is the open wallet (its name), as the Ethereum one is the chosen account
    const wRow = r.wallet ? [['Account', `${r.wallet.name}${r.wallet.beam ? '' : ' (no Beam part)'}`]] : [];
    if (r.kind === 'beamConnect') {
      $('dpTitle').textContent = 'Connect to Beam';
      $('dpBody').innerHTML = kv([['Calls itself', r.appname || ''], ...wRow]);      // the site's own word for its name (the site above it is Chrome's)
      $('dpNote').textContent = r.wallet && !r.wallet.beam ? 'The open wallet has no Beam part: open a wallet with one first.'
        : 'The site sees this account\'s Beam balance, assets and its own transactions, and can ask for contract transactions. Each one is asked here first. For another account, open it in the wallet first.';
      $('dpYes').textContent = 'Connect';
      $('dpYes').disabled = !(r.wallet && r.wallet.beam);
      $('dpMore').textContent = list.length > 1 ? `${list.length - 1} more waiting` : '';
      dpHold(r, !!(r.wallet && r.wallet.beam));
      return show('s-dapp');
    }
    if (r.kind === 'beamtx') {
      $('dpTitle').textContent = 'Beam contract transaction';
      const rows = [['Calls itself', r.appname || ''], ...wRow, ...pre];
      $('dpBody').innerHTML = kv(rows);
      $('dpNote').textContent = 'What it spends and receives is the wallet\'s own reading of the transaction, not the site\'s.';
      $('dpYes').textContent = 'Approve';
      $('dpYes').disabled = false;
      $('dpMore').textContent = list.length > 1 ? `${list.length - 1} more waiting` : '';
      dpHold(r, true);
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
        ['Data', !t.data || t.data === '0x' ? 'none' : `${String(t.data).slice(0, 10)}… (${(String(t.data).length - 2) / 2} bytes)`],
        ['Network fee', r.fee ? `${ethAmt(r.fee.now)} now, up to ${ethAmt(r.fee.max)}` : r.feeErr ? (/insufficient funds/i.test(r.feeErr) ? 'not enough ETH for the value and the fee' : /revert/i.test(r.feeErr) ? 'the contract refuses it (it would revert)' : `not priced: ${r.feeErr.slice(0, 120)}`) : '…']];
      // a token call read out (the host decoded it): who may take what, or what moves where
      const c = r.call, tok = c && c.token ? ` ${c.token.symbol}` : ' (in the token\'s smallest units)';
      let risky = false;
      if (c && (c.name === 'approve' || c.name === 'increaseAllowance')) {
        risky = !!c.unlimited;
        rows.splice(rows.length - 1, 0, ['Lets spend', c.unlimited ? `all your${tok}, with no limit` : `${c.amount}${tok}`], ['Spender', c.args.spender]);
      } else if (c && c.name === 'transfer') rows.splice(rows.length - 1, 0, ['Sends', `${c.amount}${tok}`], ['To', c.args.to]);
      else if (c && c.name === 'transferFrom') rows.splice(rows.length - 1, 0, ['Moves', `${c.amount}${tok}`], ['From', c.args.from], ['To', c.args.to]);
      else if (c && c.name === 'setApprovalForAll') {
        risky = !!c.args.approved;
        rows.splice(rows.length - 1, 0, ['Lets manage', c.args.approved ? 'every token of this collection you hold' : 'nothing (takes the right back)'], ['Operator', c.args.operator]);
      }
      $('dpBody').innerHTML = kv(rows);
      $('dpNote').textContent = r.feeErr ? 'The network says this transaction would fail. Sending it may only cost the fee.'
        : risky ? 'This lets the spender take all of it at any time, now or later, without asking again. Confirm only for a site you trust.'
        : 'Sent from this account on Ethereum mainnet once you confirm.';
      $('dpNote').classList.toggle('warn-own', risky);
      $('dpYes').textContent = 'Send';
    }
    const can = r.kind === 'connect' || !!r.address;
    $('dpYes').disabled = !can;
    dpHold(r, can);
    $('dpMore').textContent = list.length > 1 ? `${list.length - 1} more waiting` : '';
    show('s-dapp');
  }
  let dpBusy = false;                                 // an answer on its way: the window moves on once it is done
  async function dappReply(ok) {
    if (!dpCur) return;
    $('dpYes').disabled = $('dpNo').disabled = true;
    dpBusy = true;
    try { await host('dappAnswer', dpCur.id, ok); }
    catch (e) { note('s-dapp', 'bad', msg(e)); }
    dpBusy = false;
    $('dpNo').disabled = false;                       // Yes: as dappScreen decides for the next request
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
    // connected: the account's address on Ethereum, else (Beam only) the site
    else if (s.connected) { box.classList.add('ok'); $('dappSt').textContent = 'connected'; $('dappSub').textContent = s.address ? six(s.address) : hostName; }
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
  // Connected sites, one network at a time (as Activity): each site a link to it with "disconnect" right of it;
  // under them what it is connected to and since when
  let dappNet = 'beam';
  async function dappListOpen() {
    qa('#dappBar button[data-n]').forEach((b) => b.classList.toggle('on', b.dataset.n === dappNet));
    const cat = dappNet === 'cat';
    $('dappCatalog').hidden = !cat; $('dappSitesCard').hidden = cat;
    $('dappTitle').textContent = cat ? 'Catalog' : 'Connected sites';
    if (cat) return catalogOpen();
    const l = await host('dappList').catch(() => []);
    const named = (a) => (st.wallets || []).flatMap((w) => w.accounts).find((x) => x.address.toLowerCase() === a.toLowerCase());
    const rows = l.filter((d) => (dappNet === 'beam' ? d.beam : d.address)).map((d) => {
      const n = dappNet === 'eth' && named(d.address);
      const what = dappNet === 'beam' ? d.beam : `${n ? `${n.name} | ` : ''}${six(d.address)}`;
      return `<div class="li site"><a class="site-a" href="${esc(d.origin)}" target="_blank" rel="noopener">${esc(new URL(d.origin).host)}</a><a href="#" class="text-link" data-dapp="${esc(d.origin)}">disconnect</a><span class="sub">${esc(what)}</span><span class="sub">${esc(fdate(d.at))}</span></div>`;
    });
    $('dappList').innerHTML = rows.join('') || `<div class="empty">no site connected on ${dappNet === 'beam' ? 'Beam' : 'Ethereum'}</div>`;
  }
  // The catalog: Beam's own sites and ours. "dApp": it connects to this wallet (Beam's web wallet protocol, or
  // Ethereum for the bridge). Checked 2026-11-09: each answers; the dApps' pages carry the protocol.
  const CATALOG = [
    { title: 'Beam official', fold: 'official', items: [
      ['dex.beam.mw', 'Beam DEX', 'Swaps and liquidity pools of Beam assets', 'dApp'],
      ['bridge.beam.mw', 'Beam Bridge', 'BEAM to Ethereum and back (WBEAM)', 'Ethereum dApp'],
      ['gallery.beam.mw', 'NFT Gallery', 'Art and collectibles on Beam', 'dApp'],
      ['bans.beam.mw', 'BANS', 'Names on Beam', 'dApp'],
      ['minter.beam.mw', 'Asset Minter', 'Your own confidential asset', 'dApp'],
      ['faucet.beam.mw', 'Faucet', 'Beam\'s faucet', 'dApp'],
      ['beamx.beam.mw', 'BeamX DAO', 'The DAO and its BEAMX token', ''],
      ['explorer.beam.mw', 'Beam Explorer', 'Blocks, assets and DEX analytics', ''],
      ['beam.mw', 'beam.mw', 'Beam itself: news, wallets, docs', ''],
    ] },
    { title: 'BumbleBeam whitelisted', items: [
      ['explorer.bumblebeam.org', 'Explorer', 'Blocks, kernels, assets, DEX, contracts', ''],
      ['pool.bumblebeam.org', 'Mining pool', 'Beam mining, PPLNS and solo', ''],
      ['puzzle.bumblebeam.org', 'Puzzle', 'The Bitcoin puzzle, searched together in the browser', ''],
      ['buybeam.my', 'Buy BEAM', 'Any token on any chain swapped to BEAM, no account', 'Ethereum dApp'],      // checked 2026-11-11: pays from an Ethereum wallet (window.ethereum, eth_requestAccounts); BEAM goes to the address given
    ] },
  ];
  // a group with fold folds by a click on its head (an arrow right of it): Beam's official sites start folded, the
  // choice is kept (this browser's storage); ours do not fold
  const foldOpen = (k) => { try { return localStorage.getItem(`bb.catalog.${k}`) === 'open'; } catch { return false; } };
  const CHEV = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function catalogOpen() {
    $('dappCatalog').innerHTML = CATALOG.map((g) => {
      const open = !g.fold || foldOpen(g.fold);
      return `<div class="panel${g.fold ? ' fold' : ''}${open ? '' : ' folded'}"${g.fold ? ` data-fold="${g.fold}"` : ''}><div class="panel-head"><h3 class="panel-title">${esc(g.title)}</h3>${g.fold ? `<span class="panel-meta fold-arrow">${CHEV}</span>` : ''}</div><div class="list">${g.items.map(([h, name, what, tag]) =>
      `<div class="li site"><a class="site-a" href="https://${esc(h)}/" target="_blank" rel="noopener">${esc(name)}</a><span class="cat-tag">${esc(tag)}</span><span class="sub">${esc(what)}</span><span class="sub">${esc(h)}</span></div>`).join('')}</div></div>`;
    }).join('');
  }
  // it slides as Beam's tokens do: the list's height from what it is to what it will be in 0.25 s
  $('dappCatalog').onclick = (e) => {
    const head = e.target.closest('.fold > .panel-head'); if (!head) return;
    const p = head.parentElement, l = p.querySelector('.list'), open = p.classList.contains('folded');
    clearTimeout(l._t);
    // the list's own height, its rows' margins in (scrollHeight leaves the last one out: a jump at the end)
    const full = () => { const was = l.style.height; l.style.height = 'auto'; const h = l.getBoundingClientRect().height; l.style.height = was; return h; };
    if (open) { p.classList.remove('folded'); const h = full(); l.style.height = '0px'; void l.offsetHeight; l.style.height = `${h}px`; }
    else { l.style.height = `${full()}px`; void l.offsetHeight; p.classList.add('folded'); l.style.height = '0px'; }
    l._t = setTimeout(() => { l.style.height = ''; }, 260);
    try { localStorage.setItem(`bb.catalog.${p.dataset.fold}`, open ? 'open' : 'folded'); } catch {}
  };
  $('dappBar').onclick = (e) => { const b = e.target.closest('button[data-n]'); if (b) { dappNet = b.dataset.n; dappListOpen(); } };
  $('dappList').onclick = async (e) => {
    const a = e.target.closest('[data-dapp]');
    if (!a) return;
    e.preventDefault();
    await host('dappDisconnect', a.dataset.dapp, dappNet); dappListOpen(); dappRefresh();
  };
  async function walletAct(w, act) {
    try {
      if (act === 'restoreBeam') {
        // the Beam part rebuilt from the seed phrase: the stored one, or typed for a wallet that has none
        const r = await ask({ title: `Restore Beam: ${w.name}`, password: true, yes: 'Restore',
          input: w.phraseKnown ? null : { label: 'Seed phrase of this wallet (12 words)', value: '', secret: true },
          note: `Rebuilds this wallet's Beam part from its seed phrase${w.phraseKnown ? ' (the one kept in this wallet)' : ''} through Beam's recovery snapshot (~320 MB, a few minutes). The coins come back; the history and the address names come back only from an exported wallet data file. Only when its Beam database is gone.` });
        if (!r.ok) return;
        // it runs in the host (the popup may close); the wallet's card shows its progress
        await host('switchWallet', w.id); await load(); tab('home');
        host('restoreBeam', w.id, r.pass, r.input || '').catch((err) => ask({ title: 'Not restored', note: msg(err), yes: 'OK', no: null }));
        return;
      }
      if (act === 'rename') {
        const r = await ask({ title: 'Rename the wallet', input: { label: 'Name', value: w.name, max: NAME_MAX }, yes: 'Save',
          check: async ({ input }) => { if (!input) throw new Error('a name, please'); await host('renameWallet', w.id, input); } });
        if (r.ok) { await load(); drawWallets(); }
      }
      if (act === 'phrase' || act === 'ethPhrase') {
        await ask({ title: act === 'phrase' ? 'Seed phrase' : 'Ethereum seed phrase', password: true, yes: 'Show',
          note: 'Anyone who sees these words owns the wallet. Make sure no one is watching the screen.',
          check: async ({ pass }) => {
            const phrase = await host('reveal', w.id, pass, act, act === 'ethPhrase' ? (pickOf(w)) : undefined);
            if (!phrase) throw new Error('no phrase is kept for this wallet');
            return { title: `${w.name}: ${act === 'phrase' ? 'seed phrase' : 'Ethereum seed phrase'}`, html: `<ol class="seed">${phrase.split(' ').map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` };
          } });
      }
      if (act === 'ethKey') {
        const a2 = w.accounts.find((x) => x.i === (pickOf(w))) || w.accounts[0];      // the card's picked account
        await ask({ title: `Private key of ${a2.name}`, password: true, yes: 'Show', html: `<p class="key-addr">${esc(a2.address)}</p>`, note: 'Whoever has the key controls this account. Import it only into a wallet you trust.',
          check: async ({ pass }) => ({ title: `${a2.name}: private key`, html: `<div class="hash box">${esc(await host('reveal', w.id, pass, 'ethKey', a2.i))}</div>` }) });
      }
      if (act === 'backup') {
        let json = null;
        const r = await ask({ title: `Export wallet data: ${w.name}`, password: true, yes: 'Save the file',
          note: 'Beam\'s wallet data of this wallet (a JSON file): its addresses with their names, contacts and transactions, as Beam\'s CLI (export_data) and mobile wallets export it. No keys: it goes into a wallet restored from the same seed phrase, here or in another Beam wallet.',
          check: async ({ pass }) => { json = await host('beamData', w.id, pass); } });
        if (!r.ok || json == null) return;
        const b64 = btoa(unescape(encodeURIComponent(json)));
        const name = `beam-wallet-data-${w.name.replace(/[^\w-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.json`;
        const r2 = await chrome.runtime.sendMessage({ op: 'download', b64, name }).catch((e) => ({ error: e.message }));
        if (!r2 || r2.error) await ask({ title: 'Not saved', note: (r2 && r2.error) || 'the browser did not save it', yes: 'OK', no: null });
        else ask({ title: 'Saved', note: `Downloads/BumbleBeam/${name}`, yes: 'OK', no: null });
      }
      if (act === 'beamIn') {
        bdFor = w; $('bdFile').value = ''; $('bdFile').click();
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
  // the Add buttons beside a field: the room for their message under the field from the start
  for (const b of ['nodeAdd', 'rpcAdd']) if ($(b)) actErr($(b), null);
  $('dropSnap').onclick = async () => {
    const r = await ask({ title: 'Remove the snapshot', note: 'A restore from a seed phrase then downloads it again (~320 MB, a few minutes).', yes: 'Remove' });
    if (!r.ok) return;
    await host('dropSnapshot').catch((e) => ask({ title: 'Not removed', note: msg(e), yes: 'OK', no: null }));
    snapInfo();
  };

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
      if (!$('t-bridge').hidden) { if (dir === 'toEth') fee(); readEth(addrOf(cur)); bridgeLists(); }
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
    } catch (e) { note('bootErr', 'bad', msg(e)); }
  })();
})();
