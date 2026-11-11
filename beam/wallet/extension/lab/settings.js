// The Settings lab: the Settings screen's next design, worked on apart from the wallet; made-up wallets, nothing is
// saved. It moves into the wallet once it is right.
//   - quiet tabs in the header (Wallets, General, Networks, Storage, About) instead of one long page
//   - Wallets: one row each (its networks' dots, its name, what it holds, the open one marked current, the others
//     switched by the header's picker); a click opens its card: This wallet (Rename, Seed phrase); Ethereum when
//     it has accounts (its own Seed phrase when added by one, an account's Private key, the account picked); Remove
//     apart, last
//   - General: security (short) and display side by side, with an example of both
//   - Networks: Beam's nodes as one list as Beam's addresses (the one in use lit, whether each answers and how fast,
//     drag to order with a line where it goes, the list's cross, add); Ethereum's RPCs the same way (public ones
//     lit while none of one's own)
//   Planned, not here: adding a token moves to the wallet tab, by its token list; Arbitrum later, as a network of its own here
//   - Storage: the recovery snapshot (moved from About) and Activity's memory, each with its size and its clearing
//   - About: the version, the engine, the bridge's contracts with copy and explorer icons, the source, the changelog
(() => {
  const $ = (id) => document.getElementById(id);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const sh = (a) => (a.startsWith('0x') ? `${a.slice(0, 8)}…${a.slice(-6)}` : `${a.slice(0, 7)}…${a.slice(-7)}`);      // Beam's 7…7, as long as Ethereum's 0x+6…6
  const CP = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
  const OK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const LN = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2h5v5M14 2 7.5 8.5M12 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const cp = (v, what) => `<button type="button" class="cp" data-cp="${esc(v)}" data-tip-wide title="Copy ${esc(what)}\n${esc(v)}">${CP}</button>`;
  const ln = (href, what) => `<a class="cp" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(what)}">${LN}</a>`;
  const XI = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';      // the list's cross, as Beam's addresses'
  const ics = (...xs) => `<span class="ics">${xs.filter(Boolean).join('')}</span>`;

  // made up: three wallets, one open
  const W = [
    { id: 'a', name: 'Main', beam: true, eth: true, accounts: ['Account 1', 'Account 2', 'mevin very very long name for an account'], phrase: true, ethKind: 'phrase', beamSt: 'running', main: 1 },
    { id: 'b', name: 'Second', beam: true, eth: true, accounts: ['Account 1'], phrase: true, ethKind: 'phrase', beamSt: 'stopped' },
    { id: 'c', name: 'Ledger watch, imported by key', beam: false, eth: true, accounts: ['Imported 1'], phrase: false, ethKind: 'key' },
    { id: 'd', name: 'Old mining', beam: true, eth: false, accounts: [], phrase: true },
  ];
  let active = 'a';
  const ADDR = ['0x70997970C51812dc3A010C7d01b50e0d17dc79C8', '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', '0x90F79bf6EB2c4f870365E785982E1f101E93b906'];
  const open = new Set();
  const wd = BB.dropdown($('walletDd'), (v) => { active = v; drawWallets(); });
  const wdFill = () => wd.options(W.map((w) => ({ v: w.id, label: w.name })), active);
  wdFill();

  // the sections, as quiet tabs in the header
  $('setNav').onclick = (e) => {
    const b = e.target.closest('button[data-s]'); if (!b) return;
    qa('#setNav button').forEach((x) => x.classList.toggle('on', x === b));
    qa('.sp-sec').forEach((s) => { s.hidden = s.dataset.s !== b.dataset.s; });
    document.querySelector('main').scrollTop = 0;
  };

  // ---------- Wallets ----------
  function drawWallets() {
    $('wList').innerHTML = W.map((w) => {
      const on = w.id === active, isOpen = open.has(w.id);
      const holds = [w.beam ? 'Beam' : '', w.eth ? `Ethereum ×${w.accounts.length}` : ''].filter(Boolean).join('<i class="sp"></i>');
      return `<div class="li wr${isOpen ? ' open' : ''}" data-w="${w.id}" tabindex="0" role="button" aria-expanded="${isOpen}">
        <span class="what"><span class="nets">${w.beam ? '<i class="chain beam"></i>' : ''}${w.eth ? '<i class="chain eth"></i>' : ''}</span>${esc(w.name)}<span class="sub">${holds}</span></span>
        ${on ? '<span class="end">current</span>' : '<span></span>'}</div>${isOpen ? card(w) : ''}`;      // the open one marked, the others switched by the header's picker
    }).join('');
  }
  function card(w) {
    const g = (cap, acts, extra = '') => `<div class="grp"><div class="cap">${cap}</div>${extra}<div class="acts">${acts.join('')}</div></div>`;
    const b = (a, t, cls = '') => `<button type="button" class="sbtn${cls ? ` ${cls}` : ''}" data-a="${a}">${t}</button>`;
    // this wallet: its name, its seed phrase (Beam and Ethereum from the same words). Its Beam part's file goes with
    // General's backup
    const mine = [b('rename', 'Rename'), w.phrase ? b('phrase', 'Seed phrase') : ''].filter(Boolean);
    // Ethereum, when it has accounts: its own phrase (one added by a phrase, not by a key) and an account's key
    // the account, as the wallet tab's picker (name | address), at first the one the wallet tab shows; picked here,
    // it is only for this card (the wallet tab keeps its own)
    // In the wallet: its address runs as random hex and settles on a pick (BB.decode), as the wallet tab's and the bridge's
    const acct = w.accounts.length > 1 ? `<div class="acct"><div class="dd compact acct key-acct" data-acct="${w.id}"><button type="button" class="dd-btn" aria-haspopup="listbox" aria-expanded="false"></button><ul class="dd-list" role="listbox" tabindex="-1" hidden></ul></div></div>` : '';
    const eth = w.eth && w.accounts.length ? [w.ethKind === 'phrase' ? b('ethPhrase', 'Seed phrase') : '', b('ethKey', 'Private key')].filter(Boolean) : [];
    // This wallet and Ethereum side by side; Ethereum's account picker under both, the card's width (its name and
    // address need it)
    return `<div class="wcard2">
      <div class="cols">${g('This wallet', mine)}${eth.length ? g('Ethereum', eth) : ''}</div>
      ${eth.length && acct ? `<div class="acct-row">${acct}</div>` : ''}
      ${g('Remove', [b('remove', 'Remove the wallet', 'warn')])}
    </div>`;
  }
  $('wList').onclick = (e) => {
    const a = e.target.closest('[data-a]'), li = e.target.closest('[data-w]');
    if (a) { a.textContent = `${a.textContent.trim()}: (lab)`; return; }
    if (e.target.closest('.wcard2')) return;
    if (!li) return;
    if (open.has(li.dataset.w)) open.delete(li.dataset.w); else open.add(li.dataset.w);
    drawWallets();
    for (const d of qa('[data-acct]')) {
      const w = W.find((x) => x.id === d.dataset.acct);
      BB.dropdown(d, (v) => { w.picked = Number(v); }).options(w.accounts.map((n, i) => ({ v: String(i), label: `${n} ${sh(ADDR[i])}`, html: `<span class="nm">${esc(n)}</span><span class="ad">${sh(ADDR[i])}</span>`,
        btn: `<span class="acc-b"><span class="nm">${esc(n)}</span><span class="ad">${sh(ADDR[i])}</span></span>` })), String(w.picked ?? w.main ?? 0));
    }
  };
  $('wList').onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.li.wr')) { e.preventDefault(); e.target.click(); } };
  $('addWallet').onclick = () => { $('addWallet').textContent = '+ Add a wallet: the start screen (lab)'; };
  drawWallets();

  // ---------- General ----------
  const ex = { t: '24', d: '6' };
  // under each picker, how it shows: white, BEAM grey
  const dispEx = () => {
    $('timeEx').textContent = `11.11.2026 ${ex.t === '12' ? '2:05 PM' : '14:05'}`;
    $('decEx').innerHTML = `${(1234.123456789).toLocaleString('en-US', { minimumFractionDigits: Math.min(2, ex.d), maximumFractionDigits: Number(ex.d) }).replace(/,/g, '\u2060\u2009\u2060')} <span class="u">BEAM</span>`;      // thousands apart as the wallet's
  };
  BB.dropdown($('autoLock'), () => {}).set('60');
  BB.dropdown($('timeFmt'), (v) => { ex.t = v; dispEx(); }).set('24');
  BB.dropdown($('decFmt'), (v) => { ex.d = v; dispEx(); }).set('6');
  dispEx();

  // Backup: one file with every wallet (encrypted with the wallet password), Beam's databases if asked, saved when
  // asked. An import adds what the file has and the extension does not
  const bk = { last: '09.11.2026 21:40' };
  const bkDraw = () => { $('bkLast').innerHTML = `<span>last: <b>${bk.last}</b></span>`; };
  $('bkSave').onclick = () => { bk.last = '11.11.2026 14:05'; bkDraw(); $('bkMsg').textContent = `saved${$('bkDb').checked ? ', with Beam\'s databases' : ''} (lab)`; };
  $('bkImport').onclick = () => { $('bkMsg').textContent = 'a file, then its password (lab)'; };
  bkDraw();

  // ---------- Networks ----------
  const nodes = [
    { h: 'wss.bumblebeam.org:443', st: 'ok', ms: 42 },
    { h: 'wsb.bumblebeam.org:443', st: 'ok', ms: 118 },
    { h: 'eu-node01.mainnet.beam.mw:8200', st: 'slow', ms: 640 },
    { h: 'old.example.org:8100', st: 'bad' },
  ];
  // what is behind a node or the public RPCs, shown under its row on a click (as a transaction's card in Activity)
  const BEHIND = {
    'wss.bumblebeam.org:443': [['What', 'own Beam node'], ['Through', 'BumbleBeam WebSocket door'], ['Also', 'BumbleBeam pool\'s node']],
    'wsb.bumblebeam.org:443': [['What', 'the backup door - a Cloudflare Worker to BeamMW\'s public nodes'], ['Passes to', 'in a random order:\n188.245.67.32:8100\n188.245.67.33:8100\n188.245.67.34:8100\n188.245.67.35:8100\n5.161.152.212:8100\nsunpool, 195.201.121.246:10000\nthen our node, last']],
  };
  const openN = new Set();
  const behind = (key, rows) => (openN.has(key) ? `<div class="nd-more"><dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>` : '');
  const nodeRows = (n) => BEHIND[n.h] || [['What', 'a node added by you'], ['Answers', n.st === 'bad' ? 'not now' : `in ${n.ms} ms`]];
  function drawNodes() {
    // the first is the one in use, the others in turn from the top down
    $('nodes').innerHTML = nodes.map((n, i) => `<div class="node${i === 0 ? ' use' : ''}${openN.has(n.h) ? ' open' : ''}" draggable="true" data-i="${i}" data-k="${esc(n.h)}"><i class="st ${n.st}"></i><span class="h">${esc(n.h)}</span><span class="meta">${n.st === 'bad' ? 'no answer' : `${n.ms} ms`}</span><button type="button" class="cp a-x" data-x="${i}" title="Remove this node">${XI}</button></div>${behind(n.h, nodeRows(n))}`).join('');
    $('beamNet').innerHTML = `<span>block: <b>${(4119939).toLocaleString('en-US').replace(/,/g, '\u2060\u2009\u2060')}</b></span>`;      // one item of the meta's flex (its gap is 14 px), as the wallet tab's
  }
  // dragged as Beam's addresses: a line above or below the row it would go to
  let drag = null;
  const clearMarks = () => qa('#nodes .drop-above, #nodes .drop-below').forEach((r) => r.classList.remove('drop-above', 'drop-below'));
  $('nodes').addEventListener('dragstart', (e) => { const r = e.target.closest('.node'); drag = Number(r.dataset.i); r.classList.add('dragging'); });
  $('nodes').addEventListener('dragend', () => { clearMarks(); qa('#nodes .dragging').forEach((r) => r.classList.remove('dragging')); });
  $('nodes').addEventListener('dragover', (e) => {
    e.preventDefault(); const r = e.target.closest('.node'); clearMarks(); if (!r || Number(r.dataset.i) === drag) return;
    const b = r.getBoundingClientRect(); r.classList.add(e.clientY < b.top + b.height / 2 ? 'drop-above' : 'drop-below');
  });
  $('nodes').addEventListener('drop', (e) => {
    e.preventDefault(); const r = e.target.closest('.node'); if (!r || drag == null) return clearMarks();
    const above = r.classList.contains('drop-above'); clearMarks();
    let to = Number(r.dataset.i) + (above ? 0 : 1); const [n] = nodes.splice(drag, 1); if (drag < to) to--; nodes.splice(to, 0, n); drag = null; drawNodes();
  });
  $('nodes').onclick = (e) => {
    const x = e.target.closest('[data-x]'); if (x) { nodes.splice(Number(x.dataset.x), 1); drawNodes(); return; }
    const r = e.target.closest('.node'); if (!r) return; const k = r.dataset.k; if (openN.has(k)) openN.delete(k); else openN.add(k); drawNodes();
  };
  $('nodeAdd').onclick = () => { const v = $('nodeIn').value.trim(); if (!/^[\w.-]+:\d{2,5}$/.test(v)) return; nodes.push({ h: v, st: 'ok', ms: 200 }); $('nodeIn').value = ''; drawNodes(); };
  drawNodes();
  // Ethereum: the public RPCs as one row, lit while there is none of one's own. One's own goes above them, in use
  const rpcs = [];
  function drawRpcs() {
    $('rpcs').innerHTML = [...rpcs.map((u, i) => `<div class="node${i === 0 ? ' use' : ''}" data-r="${i}" data-k="${esc(u)}"><i class="st ok"></i><span class="h">${esc(u.replace(/^https:\/\//, ''))}</span><span class="meta">96 ms</span><button type="button" class="cp a-x" data-rx="${i}" title="Remove this RPC">${XI}</button></div>${behind(u, [['What', 'an RPC added by you, asked first']])}`),
      `<div class="node solo${rpcs.length ? '' : ' use'}${openN.has('public') ? ' open' : ''}" data-k="public"><i class="st ok"></i><span class="h">public RPCs</span><span class="meta end"><span class="tipped" title="Four public RPCs, asked in turn: when one does not answer, the next one is">4</span></span></div>${behind('public', [['Asked in turn', 'ethereum-rpc.publicnode.com\neth.llamarpc.com\neth.drpc.org\n1rpc.io/eth'], ['Activity from', 'eth.blockscout.com']])}`].join('');
    $('ethNet').innerHTML = `<span>block: <b>${(23781200).toLocaleString('en-US').replace(/,/g, '\u2060\u2009\u2060')}</b></span>`;      // one item of the meta's flex (its gap is 14 px), as the wallet tab's
  }
  $('rpcs').onclick = (e) => {
    const x = e.target.closest('[data-rx]'); if (x) { rpcs.splice(Number(x.dataset.rx), 1); drawRpcs(); return; }
    const r = e.target.closest('.node[data-k]'); if (!r) return; const k = r.dataset.k; if (openN.has(k)) openN.delete(k); else openN.add(k); drawRpcs();
  };
  $('rpcAdd').onclick = () => { const v = $('ethRpc').value.trim(); if (!/^https:\/\/\S+$/.test(v)) return; rpcs.unshift(v); $('ethRpc').value = ''; drawRpcs(); };
  drawRpcs();

  // ---------- Storage ----------
  const keep = { tx: 214, coins: 38, bt: 61, ls: 3, kb: 96 };
  const drawKeep = () => {
    $('keepSize').textContent = `${keep.kb} KB`;
    $('keepKv').innerHTML = `<dt>Transfers</dt><dd>${keep.tx}</dd><dt>Spent coins</dt><dd>${keep.coins}</dd><dt>Blocks' times</dt><dd>${keep.bt}</dd><dt>Lists</dt><dd>${keep.ls}</dd>`;
  };
  const age = BB.dropdown($('keepAge'), () => {}); age.set('90');
  $('keepClear').onclick = () => { const all = age.value() === '0'; for (const k of Object.keys(keep)) keep[k] = all ? 0 : Math.round(keep[k] * 0.6); drawKeep(); };
  drawKeep();
  $('snapDrop').onclick = () => { $('snapMsg').textContent = 'removed (lab)'; };

  // ---------- About ----------
  const PIPE = 'e63bd26ca5b226558686dd191122a8e5d6861a97597db9f40bda48aef6dbe835', ETHP = '0x6063024646E8A1561970840a4b0e0f1082f5a670';
  $('aboutKv').innerHTML = `<dt>Version</dt><dd><a class="text-link" href="https://github.com/profinch/bumblebeam/blob/main/beam/wallet/CHANGELOG.md" target="_blank" rel="noopener">0.4.0</a> changelog</dd>
    <dt>Beam engine</dt><dd>BeamMW wasm-client 7.5.14548\nafter HF6</dd>
    <dt>Bridge</dt><dd>${esc(sh(PIPE))}${ics(cp(PIPE, 'the bridge\'s contract id'), ln(`https://explorer.bumblebeam.org/contract/${PIPE}`, 'Open the contract in the explorer'))} on Beam\n${esc(sh(ETHP))}${ics(cp(ETHP, 'the bridge\'s contract address'), ln(`https://etherscan.io/address/${ETHP}`, 'Open the contract on Etherscan'))} on Ethereum</dd>
    <dt>Source</dt><dd><a class="text-link" href="https://github.com/profinch/bumblebeam/tree/main/beam/wallet" target="_blank" rel="noopener">github.com/profinch/bumblebeam</a></dd>
    <dt>Licence</dt><dd>Apache-2.0</dd>`;

  // the explanations fold open and shut by their heads
  const CHEV = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';      // the catalog's arrow
  qa('.fold-arrow').forEach((a) => { a.innerHTML = CHEV; });
  document.addEventListener('click', (e) => { const h = e.target.closest('.fold-h, .fold-arrow'); if (h) { e.preventDefault(); h.parentElement.classList.toggle('open'); } });

  // copy, as the wallet's: a tick for 2 s
  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-cp]'); if (!c) return;
    navigator.clipboard.writeText(c.dataset.cp).then(() => { c.innerHTML = OK; c.classList.add('done'); clearTimeout(c._t); c._t = setTimeout(() => { c.innerHTML = CP; c.classList.remove('done'); }, 2000); }).catch(() => {});
  });
})();
