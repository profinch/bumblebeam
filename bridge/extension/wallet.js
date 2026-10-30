// BumbleBeam Bridge: the wallet tab. Screens for creating, restoring and unlocking the wallet, then
// tabs for the wallet, both bridge directions and settings. Every string from the wallet, the
// contract or the network goes through esc() before it is put into HTML.
'use strict';

(() => {
  // our pool node's WebSocket door (deploy/docker wss.conf). The official web wallet's
  // web-wallet.beam.mw:8200 is still on the pre-HF6 chain ("incompatible with HF 6", stuck at 3928666).
  const DEFAULT_NODE = 'wss.bumblebeam.org:443';
  const RECOVERY_URL = 'https://mobile-restore.beam.mw/mainnet/mainnet_recovery.bin';
  const ETH_PAGE = 'http://127.0.0.1:8771/';                  // bridge/web, served locally: Rabby does not inject into extension pages
  const G = Bridge.GROTH;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const amt = (groth, d = 4) => (groth == null || !isFinite(groth) ? '—'
    : (groth / G).toLocaleString('en-US', { minimumFractionDigits: Math.min(2, d), maximumFractionDigits: d }));
  const store = {
    get: (k) => new Promise((r) => chrome.storage.local.get(k, (v) => r(v[k]))),
    set: (k, v) => new Promise((r) => chrome.storage.local.set({ [k]: v }, r)),
  };
  const fail = (id) => (e) => { $(id).textContent = e && e.message ? e.message : String(e); };

  let pass = null, node = DEFAULT_NODE, avail = 0;

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
  document.querySelectorAll('.back').forEach((b) => { b.onclick = () => show('s-welcome'); });

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
  let consentCtx = null;
  Beam.onConsent((info, amounts) => {
    const ctx = consentCtx || { title: 'Contract transaction', rows: [], note: 'Not started by this page: reject it unless you know what it is.' };
    const rows = [...ctx.rows];
    for (const a of Array.isArray(amounts) ? amounts : []) {
      const asset = Number(a.assetID ?? a.asset_id ?? 0);
      rows.push([`Wallet ${a.spend ? 'spends' : 'receives'}`, `${amt(Number(a.amount), 8)} ${asset ? `asset ${asset}` : 'BEAM'}`]);
    }
    if (info && info.fee != null) rows.push(['Beam network fee', `${amt(Number(info.fee), 8)} BEAM`]);
    if (info && info.comment) rows.push(['Contract says', String(info.comment)]);
    return confirmBox(ctx.title, rows, ctx.note);
  });
  async function withConsent(ctx, fn) {
    consentCtx = ctx;
    try { return await fn(); } finally { consentCtx = null; }
  }

  const passwordPair = (a, b) => {
    const p = $(a).value;
    if (p.length < 8) throw new Error('use a password of 8 characters or more');
    if (p !== $(b).value) throw new Error('the passwords differ');
    return p;
  };

  // ---------- create ----------
  let phrase = '', checks = [];
  $('goCreate').onclick = () => {
    phrase = Beam.generatePhrase();
    const w = phrase.split(' ');
    $('seedWords').innerHTML = w.map((x) => `<li>${esc(x)}</li>`).join('');
    checks = [];
    while (checks.length < 3) { const i = Math.floor(Math.random() * w.length); if (!checks.includes(i)) checks.push(i); }
    checks.sort((a, b) => a - b);
    $('checkIdx').textContent = checks.map((i) => `#${i + 1}`).join(', ');
    $('seedCheck').value = ''; $('createErr').textContent = '';
    show('s-create');
  };
  const progress = (bar, text) => (step, done, total) => {
    const pc = total ? Math.floor((done / total) * 100) : 0;
    $(bar).style.width = `${pc}%`;
    $(text).textContent = step === 'download'
      ? `downloading Beam's snapshot ${pc}% (${(done / 2 ** 20).toFixed(0)} of ${(total / 2 ** 20).toFixed(0)} MB)`
      : `importing it ${pc}%`;
  };

  $('doCreate').onclick = async () => {
    $('createErr').textContent = '';
    try {
      const w = phrase.split(' ');
      const typed = $('seedCheck').value.trim().toLowerCase().split(/\s+/);
      if (typed.join(' ') !== checks.map((i) => w[i]).join(' ')) throw new Error('the check words do not match: look at the list again');
      const p = passwordPair('cPass', 'cPass2');
      $('doCreate').disabled = true; $('cProg').hidden = false;
      await Beam.create(phrase, p, node, RECOVERY_URL, progress('cBar', 'cText'));
      phrase = '';
      $('seedWords').innerHTML = '';
      started(p);
    } catch (e) { fail('createErr')(e); }
    $('doCreate').disabled = false;
  };

  // ---------- restore ----------
  $('goRestore').onclick = () => { $('restoreErr').textContent = ''; show('s-restore'); };
  $('doRestore').onclick = async () => {
    $('restoreErr').textContent = '';
    try {
      const seed = $('rSeed').value;
      const bad = seed.trim().toLowerCase().split(/[\s;,]+/).filter((x) => x && !Beam.isAllowedWord(x));
      if (bad.length) throw new Error(`not seed words: ${bad.join(', ')}`);
      if (!Beam.isValidPhrase(seed)) throw new Error('this is not a valid 12-word Beam seed phrase');
      const p = passwordPair('rPass', 'rPass2');
      $('doRestore').disabled = true; $('rProg').hidden = false;
      await Beam.create(seed, p, node, RECOVERY_URL, progress('rBar', 'rText'));
      $('rSeed').value = '';
      started(p);
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
      await Beam.importDb(new Uint8Array(await f.arrayBuffer()));
      await Beam.open($('iPass').value, node);
      started($('iPass').value);
    } catch (e) { fail('importErr')(e); }
  };

  // ---------- unlock ----------
  async function unlock() {
    $('unlockErr').textContent = '';
    try { await Beam.open($('uPass').value, node); started($('uPass').value); } catch (e) { fail('unlockErr')(e); }
  }
  $('doUnlock').onclick = unlock;
  $('uPass').onkeydown = (e) => { if (e.key === 'Enter') unlock(); };

  // ---------- running wallet ----------
  async function started(p) {
    pass = p;
    $('uPass').value = $('cPass').value = $('cPass2').value = $('rPass').value = $('rPass2').value = '';
    tab('wallet');
    await Beam.call('ev_subunsub', { ev_sync_progress: true, ev_system_state: true, ev_txs_changed: true, ev_utxos_changed: true }).catch(() => {});
    status(); txs();
  }

  Beam.on((msg) => {
    if (msg.method === 'ev_sync_progress' && msg.result) {
      const { done, total } = msg.result;
      $('sync').textContent = total && done < total ? `syncing ${Math.floor((done / total) * 100)}%` : '';
    }
    if (msg.method === 'ev_system_state' || msg.method === 'ev_utxos_changed') status();
    if (msg.method === 'ev_txs_changed') txs();
  });

  async function status() {
    try {
      const w = await Beam.call('wallet_status');
      avail = w.available || 0;
      $('avail').textContent = amt(avail);
      $('pend').textContent = `${amt(w.receiving || 0, 2)} / ${amt(w.sending || 0, 2)} / ${amt(w.maturing || 0, 2)}`;
      $('height').textContent = w.current_height ?? '—';
      if (!$('sync').textContent.startsWith('syncing')) $('sync').textContent = `${node} · ${w.current_height ?? '?'}`;
    } catch (e) { $('sync').textContent = e.message; }
  }

  async function txs() {
    try {
      const list = await Beam.call('tx_list', { count: 30 });
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
      const a = await Beam.call('create_address', { type, expiration: 'auto', comment: `bridge ${type}` });
      $('addr').textContent = a; $('addrBox').hidden = false;
      $('qr').innerHTML = '';
      new QRCode($('qr'), { text: a, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.L });
    } catch (e) { fail('addrErr')(e); }
  }
  $('mkRegular').onclick = () => mkAddress('regular');
  $('mkOffline').onclick = () => mkAddress('offline');
  $('copyAddr').onclick = () => navigator.clipboard.writeText($('addr').textContent);

  $('doSend').onclick = async () => {
    $('sendErr').textContent = $('sendOk').textContent = '';
    try {
      const address = $('sAddr').value.trim();
      const value = Bridge.toGroth($('sAmt').value);
      if (!(await confirmBox('Send BEAM', [['Amount', `${amt(value, 8)} BEAM`], ['To', address]], 'Plus the Beam network fee.'))) return;
      const r = await Beam.call('tx_send', { value, address, asset_id: 0 });
      $('sendOk').textContent = `sent, transaction ${r.txId}`;
      txs();
    } catch (e) { fail('sendErr')(e); }
  };

  // ---------- BEAM -> WBEAM ----------
  let feeData = null;
  async function fee() {
    try {
      feeData = await Bridge.relayerFee();
      if (!$('eFee').dataset.touched) $('eFee').value = feeData.fee;
      $('eFeeInfo').textContent = `The relayer's minimum is ${feeData.min.toFixed(2)} BEAM (gas ${feeData.gwei.toFixed(3)} gwei, ETH $${Math.round(feeData.ethUsd)}, BEAM $${feeData.beamUsd}, ${feeData.src}); suggested ×1.5. If gas rises above it, the transfer waits, it is not lost.`;
    } catch (e) { $('eFeeInfo').textContent = `could not price the relayer fee: ${e.message}`; }
  }
  $('eFee').oninput = () => { $('eFee').dataset.touched = 1; };
  $('eMax').onclick = () => {
    const f = parseFloat($('eFee').value) || 0;
    $('eAmt').value = Math.max(0, Math.floor((avail / G - f - 0.02) * 1e4) / 1e4);
  };
  $('eRcv').oninput = () => { store.set('ethAddress', $('eRcv').value.trim()); outgoing(); };

  $('eSend').onclick = async () => {
    $('eErr').textContent = $('eOk').textContent = '';
    try {
      const rcv = $('eRcv').value.trim();
      if (!Bridge.isEthAddress(rcv)) throw new Error('the Ethereum address must be 0x and 40 hex characters');
      const a = Bridge.toGroth($('eAmt').value), f = Bridge.toGroth($('eFee').value);
      const fd = feeData || await Bridge.relayerFee();
      if (f < Math.round(fd.min * G)) throw new Error(`the fee is below the relayer's minimum (${fd.min.toFixed(2)} BEAM): the transfer would wait for cheaper gas`);
      if (a + f + 2e6 > avail) throw new Error(`not enough: ${amt(avail, 8)} BEAM available, needed amount + fee + ~0.02`);
      const txid = await withConsent({
        title: 'Send to Ethereum',
        rows: [['WBEAM to receive', amt(a, 8)], ['Relayer fee', `${amt(f, 8)} BEAM`], ['Ethereum address', rcv]],
        note: 'The official bridge pipe on Beam, released by its relayer on Ethereum. It cannot be undone.',
      }, () => Bridge.sendToEth(a, rcv, f));
      $('eOk').textContent = `sent, Beam transaction ${txid}. It shows up below once a block confirms it.`;
      txs(); setTimeout(outgoing, 90000);
    } catch (e) { fail('eErr')(e); }
  };

  async function outgoing() {
    const rcv = $('eRcv').value.trim();
    if (!Bridge.isEthAddress(rcv) || !Beam.running()) return;
    $('eMsgErr').textContent = '';
    try {
      const d = await Bridge.outgoing(rcv);
      const names = { done: 'arrived', waiting: 'waiting for the relayer', failed: 'failed on Ethereum' };
      $('eMsgs').innerHTML = d.msgs.map((m) => `<tr><td>${m.id}</td><td class="r">${amt(m.amount)}</td><td class="r">${amt(m.fee, 2)}</td>
        <td><span class="pill ${m.state}">${names[m.state]}</span></td>
        <td>${m.eth ? `<a href="https://etherscan.io/tx/${esc(m.eth.hash)}" target="_blank" rel="noopener">${esc(new Date(m.eth.time).toLocaleString())}</a>` : ''}</td></tr>`).join('')
        || `<tr><td colspan="5" class="dim">none to this address among the last 40 bridge messages (${d.count} in all)</td></tr>`;
    } catch (e) { fail('eMsgErr')(e); }
  }

  // ---------- WBEAM -> BEAM ----------
  async function beamKey() {
    try {
      const k = await Bridge.beamKey();
      $('bKey').textContent = k;
      $('ethPage').href = `${ETH_PAGE}#key=${encodeURIComponent(k)}`;
    } catch (e) { $('bKey').textContent = e.message; }
  }
  $('copyKey').onclick = () => navigator.clipboard.writeText($('bKey').textContent);

  async function incoming() {
    if (!Beam.running()) return;
    $('inErr').textContent = '';
    try {
      const list = await Bridge.incoming();
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
      const txid = await withConsent({
        title: 'Receive from Ethereum',
        rows: [['Bridge message', `#${id}`]],
        note: 'Takes the BEAM the relayer brought over for this wallet.',
      }, () => Bridge.receive(id));
      $('inOk').textContent = `receiving message #${id}, Beam transaction ${txid}`;
      txs();
    } catch (err) { fail('inErr')(err); e.target.disabled = false; }
  };

  // ---------- settings ----------
  $('saveNode').onclick = async () => {
    node = $('node').value.trim() || DEFAULT_NODE;
    await store.set('node', node);
    await Beam.stop();
    await Beam.open(pass, node);
    started(pass);
  };
  $('doBackup').onclick = async () => {
    const bytes = await Beam.exportDb(pass, node);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    a.download = `beam-bridge-wallet-${new Date().toISOString().slice(0, 10)}.db`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    started(pass);
  };
  $('doLock').onclick = async () => { await Beam.stop(); pass = null; show('s-unlock'); };
  $('doDelete').onclick = async () => {
    const ok = await confirmBox('Delete this wallet', [['Balance', `${amt(avail, 8)} BEAM`]],
      'The wallet file is removed from this browser. Only the seed phrase or a backup file can bring it back.');
    if (!ok) return;
    await Beam.remove(); pass = null; show('s-welcome');
  };

  // ---------- boot ----------
  setInterval(() => { if (Beam.running()) { status(); } }, 20000);
  setInterval(() => {
    if (!Beam.running()) return;
    if (!$('t-toeth').hidden) { fee(); outgoing(); }
    if (!$('t-frometh').hidden) incoming();
  }, 60000);

  (async () => {
    try {
      if (!self.crossOriginIsolated) throw new Error('the page is not cross-origin isolated: the wasm wallet needs SharedArrayBuffer');
      node = (await store.get('node')) || DEFAULT_NODE;
      $('node').value = node;
      $('eRcv').value = (await store.get('ethAddress')) || '';
      await Beam.load();
      show(Beam.hasWallet() ? 's-unlock' : 's-welcome');
    } catch (e) { fail('bootErr')(e); }
  })();
})();
