// BumbleBeam Wallet: the popup under the toolbar icon (and the same page in a tab, ⤢). Only a view:
// the wallet runs in the host (offscreen.js) and every action is a message to it. Screens for creating,
// restoring and unlocking, then tabs for the wallet, both bridge directions and settings. Every string
// from the wallet, the contract or the network goes through esc() before it is put into HTML.
'use strict';

(() => {
  const ETH_PAGE = 'http://127.0.0.1:8771/';                  // wallet/web, served locally: Rabby does not inject into extension pages
  const GROTH = 1e8;
  const inTab = new URLSearchParams(location.search).has('tab');
  if (!inTab) document.documentElement.classList.add('popup');

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const amt = (groth, d = 4) => (groth == null || !isFinite(groth) ? '—'
    : (groth / GROTH).toLocaleString('en-US', { minimumFractionDigits: Math.min(2, d), maximumFractionDigits: d }));
  const fail = (id) => (e) => { $(id).textContent = e && e.message ? e.message : String(e); };
  const toGroth = (x) => {
    const v = Math.round(parseFloat(String(x).replace(',', '.')) * GROTH);
    if (!(v > 0)) throw new Error('the amount must be above zero');
    return v;
  };
  const isEthAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(a);

  // ---------- the host ----------
  let port = null, rpcNext = 1;
  const rpcWait = new Map();
  const handlers = { event: () => {}, progress: () => {}, consent: () => {} };
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

  let node = '', avail = 0;

  // ---------- screens ----------
  function show(id) {
    document.querySelectorAll('.screen').forEach((s) => { s.hidden = s.id !== id; });
    $('tabs').hidden = !id.startsWith('t-');
  }
  function tab(name) {
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    show(`t-${name}`);
    if (name === 'toeth') { fee(); outgoing(); }
    if (name === 'frometh') { beamKey(); incoming(); }
  }
  $('tabs').onclick = (e) => { if (e.target.dataset.tab) tab(e.target.dataset.tab); };
  document.querySelectorAll('.back').forEach((b) => { b.onclick = () => { host('dropPhrase'); show('s-welcome'); }; });
  $('expand').onclick = () => { chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?tab=1') }); if (!inTab) window.close(); };
  $('expand').hidden = inTab;

  function confirmBox(title, rows, note) {
    $('cTitle').textContent = title;
    $('cBody').innerHTML = rows.map(([k, v]) => `<div><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('');
    $('cNote').textContent = note || '';
    $('confirm').showModal();
    return new Promise((resolve) => {
      $('cYes').onclick = () => { $('confirm').close(); resolve(true); };
      $('cNo').onclick = () => { $('confirm').close(); resolve(false); };
    });
  }

  // The wallet asks for consent on every contract transaction with what it computed itself:
  // the amounts it moves and the fee. The bridge context (address, relayer fee) goes on top.
  handlers.consent = async ({ id, info, amounts, ctx }) => {
    const c = ctx || { title: 'Contract transaction', rows: [], note: 'Not started by this wallet: reject it unless you know what it is.' };
    const rows = [...(c.rows || [])];
    for (const a of Array.isArray(amounts) ? amounts : []) {
      const asset = Number(a.assetID ?? a.asset_id ?? 0);
      rows.push([`Wallet ${a.spend ? 'spends' : 'receives'}`, `${amt(Number(a.amount), 8)} ${asset ? `asset ${asset}` : 'BEAM'}`]);
    }
    if (info && info.fee != null) rows.push(['Beam network fee', `${amt(Number(info.fee), 8)} BEAM`]);
    if (info && info.comment) rows.push(['Contract says', String(info.comment)]);
    const ok = await confirmBox(c.title, rows, c.note);
    port && port.postMessage({ type: 'consent', id, ok });
  };

  const passwordPair = (a, b) => {
    const p = $(a).value;
    if (p.length < 8) throw new Error('use a password of 8 characters or more');
    if (p !== $(b).value) throw new Error('the passwords differ');
    return p;
  };

  // snapshot download and import, shown on whichever screen started it
  let progressBar = null;
  handlers.progress = ({ step, done, total }) => {
    if (!progressBar) return;
    const [bar, text] = progressBar;
    const pc = total ? Math.floor((done / total) * 100) : 0;
    $(bar).style.width = `${pc}%`;
    $(text).textContent = step === 'download'
      ? `downloading Beam's snapshot ${pc}% (${(done / 2 ** 20).toFixed(0)} of ${(total / 2 ** 20).toFixed(0)} MB)`
      : `importing it ${pc}%`;
  };

  // ---------- create ----------
  let checks = [];
  function showPhrase(phrase) {
    const w = phrase.split(' ');
    $('seedWords').innerHTML = w.map((x) => `<li>${esc(x)}</li>`).join('');
    checks = [];
    while (checks.length < 3) { const i = Math.floor(Math.random() * w.length); if (!checks.includes(i)) checks.push(i); }
    checks.sort((a, b) => a - b);
    $('checkIdx').textContent = checks.map((i) => `#${i + 1}`).join(', ');
    $('seedCheck').value = ''; $('createErr').textContent = '';
    show('s-create');
  }
  $('goCreate').onclick = async () => showPhrase(await host('newPhrase'));
  $('doCreate').onclick = async () => {
    $('createErr').textContent = '';
    try {
      const w = (await host('phrase') || '').split(' ');
      const typed = $('seedCheck').value.trim().toLowerCase().split(/\s+/);
      if (typed.join(' ') !== checks.map((i) => w[i]).join(' ')) throw new Error('the check words do not match: look at the list again');
      const p = passwordPair('cPass', 'cPass2');
      $('doCreate').disabled = true; $('cProg').hidden = false; progressBar = ['cBar', 'cText'];
      await host('create', null, p);
      $('seedWords').innerHTML = '';
      started();
    } catch (e) { fail('createErr')(e); }
    $('doCreate').disabled = false;
  };

  // ---------- restore ----------
  $('goRestore').onclick = () => { $('restoreErr').textContent = ''; show('s-restore'); };
  $('doRestore').onclick = async () => {
    $('restoreErr').textContent = '';
    try {
      const seed = $('rSeed').value;
      const words = seed.trim().toLowerCase().split(/[\s;,]+/).filter(Boolean);
      const bad = [];
      for (const x of words) if (!(await host('isAllowedWord', x))) bad.push(x);
      if (bad.length) throw new Error(`not seed words: ${bad.join(', ')}`);
      if (!(await host('isValidPhrase', words.join(' ')))) throw new Error('this is not a valid 12-word Beam seed phrase');
      const p = passwordPair('rPass', 'rPass2');
      $('doRestore').disabled = true; $('rProg').hidden = false; progressBar = ['rBar', 'rText'];
      await host('create', words.join(' '), p);
      $('rSeed').value = '';
      started();
    } catch (e) { fail('restoreErr')(e); }
    $('doRestore').disabled = false;
  };

  // ---------- backup file ----------
  $('goImport').onclick = () => { $('importErr').textContent = ''; show('s-import'); };
  $('doImport').onclick = async () => {
    $('importErr').textContent = '';
    try {
      const f = $('iFile').files[0];
      if (!f) throw new Error('choose the backup file');
      const u8 = new Uint8Array(await f.arrayBuffer());
      let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
      await host('importDb', btoa(s), $('iPass').value);
      $('iPass').value = '';
      started();
    } catch (e) { fail('importErr')(e); }
  };

  // ---------- unlock ----------
  async function unlock() {
    $('unlockErr').textContent = '';
    try { await host('open', $('uPass').value); $('uPass').value = ''; started(); } catch (e) { fail('unlockErr')(e); }
  }
  $('doUnlock').onclick = unlock;
  $('uPass').onkeydown = (e) => { if (e.key === 'Enter') unlock(); };

  // ---------- running wallet ----------
  function started() {
    for (const id of ['cPass', 'cPass2', 'rPass', 'rPass2']) $(id).value = '';
    progressBar = null;
    tab('wallet');
    status(); txs();
  }

  handlers.event = (msg) => {
    if (msg.method === 'bb_started') { if ($('tabs').hidden) started(); return; }
    if (msg.method === 'ev_sync_progress' && msg.result) {
      const { done, total } = msg.result;
      $('sync').textContent = total && done < total ? `syncing ${Math.floor((done / total) * 100)}%` : '';
    }
    if (msg.method === 'ev_system_state' || msg.method === 'ev_utxos_changed') status();
    if (msg.method === 'ev_txs_changed') txs();
  };

  async function status() {
    try {
      const w = await host('wallet', 'wallet_status');
      avail = w.available || 0;
      $('avail').textContent = amt(avail);
      $('pend').textContent = `${amt(w.receiving || 0, 2)} / ${amt(w.sending || 0, 2)} / ${amt(w.maturing || 0, 2)}`;
      $('height').textContent = w.current_height ?? '—';
      if (!$('sync').textContent.startsWith('syncing')) { $('sync').textContent = `● ${w.current_height ?? '?'}`; $('sync').title = `node ${node}`; }
    } catch (e) { $('sync').textContent = e.message; }
  }

  async function txs() {
    try {
      const list = await host('wallet', 'tx_list', { count: 30 });
      $('txs').innerHTML = list.map((t) => {
        const when = t.create_time ? new Date(t.create_time * 1000).toLocaleString() : '';
        const what = t.tx_type_string === 'contract' ? (t.comment || 'contract') : (t.income ? 'received' : 'sent');
        return `<tr><td>${esc(when)}</td><td>${esc(what)}</td><td class="r">${t.value ? amt(t.value) : ''}</td><td>${esc(t.status_string ?? t.status)}</td></tr>`;
      }).join('') || '<tr><td colspan="4" class="dim">none yet</td></tr>';
    } catch {}
  }

  // receive / send
  async function mkAddress(type) {
    $('addrErr').textContent = '';
    try {
      const a = await host('wallet', 'create_address', { type, expiration: 'auto', comment: `wallet ${type}` });
      $('addr').textContent = a; $('addrBox').hidden = false;
      $('qr').innerHTML = '';
      new QRCode($('qr'), { text: a, width: 200, height: 200, correctLevel: QRCode.CorrectLevel.L });
    } catch (e) { fail('addrErr')(e); }
  }
  $('mkRegular').onclick = () => mkAddress('regular');
  $('mkOffline').onclick = () => mkAddress('offline');
  $('copyAddr').onclick = () => navigator.clipboard.writeText($('addr').textContent);

  $('doSend').onclick = async () => {
    $('sendErr').textContent = $('sendOk').textContent = '';
    try {
      const address = $('sAddr').value.trim();
      const value = toGroth($('sAmt').value);
      if (!(await confirmBox('Send BEAM', [['Amount', `${amt(value, 8)} BEAM`], ['To', address]], 'Plus the Beam network fee.'))) return;
      const r = await host('wallet', 'tx_send', { value, address, asset_id: 0 });
      $('sendOk').textContent = `sent, transaction ${r.txId}`;
      txs();
    } catch (e) { fail('sendErr')(e); }
  };

  // ---------- BEAM -> WBEAM ----------
  let feeData = null;
  async function fee() {
    try {
      feeData = await host('relayerFee');
      if (!$('eFee').dataset.touched) $('eFee').value = feeData.fee;
      $('eFeeInfo').textContent = `The relayer's minimum is ${feeData.min.toFixed(2)} BEAM (gas ${feeData.gwei.toFixed(3)} gwei, ETH $${Math.round(feeData.ethUsd)}, BEAM $${feeData.beamUsd}, ${feeData.src}); suggested ×1.5. If gas rises above it, the transfer waits, it is not lost.`;
    } catch (e) { $('eFeeInfo').textContent = `could not price the relayer fee: ${e.message}`; }
  }
  $('eFee').oninput = () => { $('eFee').dataset.touched = 1; };
  $('eMax').onclick = () => {
    const f = parseFloat($('eFee').value) || 0;
    $('eAmt').value = Math.max(0, Math.floor((avail / GROTH - f - 0.02) * 1e4) / 1e4);
  };
  $('eRcv').oninput = () => { chrome.storage.local.set({ ethAddress: $('eRcv').value.trim() }); outgoing(); };

  $('eSend').onclick = async () => {
    $('eErr').textContent = $('eOk').textContent = '';
    try {
      const rcv = $('eRcv').value.trim();
      if (!isEthAddress(rcv)) throw new Error('the Ethereum address must be 0x and 40 hex characters');
      const a = toGroth($('eAmt').value), f = toGroth($('eFee').value);
      const fd = feeData || await host('relayerFee');
      if (f < Math.round(fd.min * GROTH)) throw new Error(`the fee is below the relayer's minimum (${fd.min.toFixed(2)} BEAM): the transfer would wait for cheaper gas`);
      if (a + f + 2e6 > avail) throw new Error(`not enough: ${amt(avail, 8)} BEAM available, needed amount + fee + ~0.02`);
      const txid = await host('sendToEth', {
        title: 'Send to Ethereum',
        rows: [['WBEAM to receive', amt(a, 8)], ['Relayer fee', `${amt(f, 8)} BEAM`], ['Ethereum address', rcv]],
        note: 'The official bridge pipe on Beam, released by its relayer on Ethereum. It cannot be undone.',
      }, a, rcv, f);
      $('eOk').textContent = `sent, Beam transaction ${txid}. It shows up below once a block confirms it.`;
      txs(); setTimeout(outgoing, 90000);
    } catch (e) { fail('eErr')(e); }
  };

  async function outgoing() {
    const rcv = $('eRcv').value.trim();
    if (!isEthAddress(rcv)) return;
    $('eMsgErr').textContent = '';
    try {
      const d = await host('outgoing', rcv);
      const names = { done: 'arrived', waiting: 'waiting for the relayer', failed: 'failed on Ethereum' };
      $('eMsgs').innerHTML = d.msgs.map((m) => `<tr><td>${m.id}</td><td class="r">${amt(m.amount)}</td><td class="r">${amt(m.fee, 2)}</td>
        <td><span class="pill ${esc(m.state)}">${names[m.state]}</span></td>
        <td>${m.eth ? `<a href="https://etherscan.io/tx/${esc(m.eth.hash)}" target="_blank" rel="noopener">${esc(new Date(m.eth.time).toLocaleString())}</a>` : ''}</td></tr>`).join('')
        || `<tr><td colspan="5" class="dim">none to this address among the last 40 bridge messages (${d.count} in all)</td></tr>`;
    } catch (e) { fail('eMsgErr')(e); }
  }

  // ---------- WBEAM -> BEAM ----------
  async function beamKey() {
    try {
      const k = await host('beamKey');
      $('bKey').textContent = k;
      $('ethPage').href = `${ETH_PAGE}#key=${encodeURIComponent(k)}`;
    } catch (e) { $('bKey').textContent = e.message; }
  }
  $('copyKey').onclick = () => navigator.clipboard.writeText($('bKey').textContent);

  async function incoming() {
    $('inErr').textContent = '';
    try {
      const list = await host('incoming');
      $('inMsgs').innerHTML = list.map((m) => `<tr><td>${esc(m.MsgId)}</td><td class="r">${amt(m.amount)}</td>
        <td class="r"><button class="small" data-msg="${esc(m.MsgId)}">Receive</button></td></tr>`).join('')
        || '<tr><td colspan="3" class="dim">nothing yet</td></tr>';
    } catch (e) { fail('inErr')(e); }
  }
  $('inMsgs').onclick = async (e) => {
    const id = e.target.dataset && e.target.dataset.msg;
    if (!id) return;
    $('inErr').textContent = $('inOk').textContent = '';
    e.target.disabled = true;
    try {
      const txid = await host('receive', {
        title: 'Receive from Ethereum', rows: [['Bridge message', `#${id}`]],
        note: 'Takes the BEAM the relayer brought over for this wallet.',
      }, id);
      $('inOk').textContent = `receiving message #${id}, Beam transaction ${txid}`;
      txs();
    } catch (err) { fail('inErr')(err); e.target.disabled = false; }
  };

  // ---------- settings ----------
  $('saveNode').onclick = async () => { node = await host('setNode', $('node').value.trim()); $('node').value = node; status(); };
  $('doBackup').onclick = async () => {
    const b64 = await host('exportDb');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'application/octet-stream' }));
    a.download = `bumblebeam-wallet-${new Date().toISOString().slice(0, 10)}.db`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  };
  $('doLock').onclick = async () => { await host('lock'); show('s-unlock'); };
  $('doDelete').onclick = async () => {
    const ok = await confirmBox('Delete this wallet', [['Balance', `${amt(avail, 8)} BEAM`]],
      'The wallet file is removed from this browser. Only the seed phrase or a backup file can bring it back.');
    if (!ok) return;
    await host('remove'); show('s-welcome');
  };

  // ---------- boot ----------
  const timers = [
    setInterval(() => { if (!$('tabs').hidden) status(); }, 20000),
    setInterval(() => {
      if (!$('t-toeth').hidden) { fee(); outgoing(); }
      if (!$('t-frometh').hidden) incoming();
    }, 60000),
  ];
  window.addEventListener('unload', () => timers.forEach(clearInterval));

  (async () => {
    try {
      const r = await chrome.runtime.sendMessage({ op: 'ensureHost' });
      if (r && r.error) throw new Error(r.error);
      const st = await host('state');
      node = st.node; $('node').value = node;
      $('eRcv').value = (await chrome.storage.local.get('ethAddress')).ethAddress || '';
      if (st.running) return started();
      if (st.progress) {                         // a create or restore is still running in the host
        show('s-restore'); $('rProg').hidden = false; progressBar = ['rBar', 'rText'];
        handlers.progress(st.progress);
        return;
      }
      if (st.phrase) return showPhrase(await host('phrase'));
      show(st.hasWallet ? 's-unlock' : 's-welcome');
      if (st.hasWallet) $('uPass').focus();
    } catch (e) { fail('bootErr')(e); }
  })();
})();
