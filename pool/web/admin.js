// BumbleBeam pool: the operator's dashboard (/admin). It calls /api/admin/* with the token from
// pool.toml [admin], kept in this browser's localStorage. Every string from the API goes through
// esc() before it is put into HTML.
'use strict';

(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const view = $('#view');
  const GROTH = 1e8;
  const KEY = 'bb-admin-token';

  // ---------- formatting ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const int = (n) => (n == null || !isFinite(n) ? '—' : Math.round(n).toLocaleString('en-US'));
  const beam = (g) => (g == null || !isFinite(g) ? '—' : `${(g / GROTH).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} BEAM`);
  const short = (s) => (s && s.length > 17 ? `${s.slice(0, 8)}…${s.slice(-8)}` : s || '—');
  function hr(v) {
    if (v == null || !isFinite(v)) return '—';
    if (v >= 1e6) return `${(v / 1e6).toFixed(2)} MSol/s`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(2)} kSol/s`;
    return `${v.toFixed(v < 10 ? 2 : 1)} Sol/s`;
  }
  function ago(ts) {
    if (!ts) return '—';
    const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }
  const time = (ts) => (ts ? new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '—');
  const badge = (text, kind) => `<span class="badge ${kind}">${esc(text)}</span>`;
  const statusBadge = (s) => badge(s, s === 'confirmed' || s === 'completed' ? 'ok' : s === 'orphaned' || s === 'failed' ? 'bad' : 'pending');

  // ---------- token and API ----------
  function token() {
    try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
  }
  function setToken(t) {
    try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch { /* private window: asked again next time */ }
  }
  let memToken = token();

  class AuthError extends Error {}
  async function api(path, body) {
    const opt = { headers: { Authorization: `Bearer ${memToken}` }, cache: 'no-store' };
    if (body) {
      opt.method = 'POST';
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    const r = await fetch(`/api/admin/${path}`, opt);
    if (r.status === 401) throw new AuthError('wrong token');
    const j = await r.json().catch(() => ({}));
    if (r.status === 404 && j.error) throw new Error(j.error);
    if (!r.ok && r.status !== 409) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  let flash = null;
  const flashHtml = () => (flash ? `<div class="adm-msg ${flash.ok ? 'ok' : 'err'}">${esc(flash.text)}</div>` : '');
  async function act(path, body, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return;
    try {
      const r = await api(path, body);
      flash = r.ok ? { ok: true, text: r.message } : { ok: false, text: r.error || 'refused' };
    } catch (e) {
      flash = { ok: false, text: e.message };
    }
    render();
  }

  // a payout run takes a few seconds per miner: the button says so until the pool answers
  async function payNow(btn, body, confirmText) {
    if (!window.confirm(confirmText)) return;
    btn.disabled = true;
    btn.textContent = 'Paying…';
    await act('payouts', body);
  }

  // ---------- views ----------
  function signIn(err) {
    $('#tabs').hidden = true;
    view.innerHTML = `
      <div class="page-head"><h1 class="page-title">Operator sign-in</h1></div>
      <section class="panel">
        <p class="hint">The token is <code>[admin] token</code> in the pool's pool.toml. It stays in this browser only.</p>
        ${err ? `<div class="adm-msg err">${esc(err)}</div>` : ''}
        <form class="adm-row" id="signin">
          <input class="adm-field" id="tok" type="password" autocomplete="current-password" placeholder="admin token" aria-label="Admin token">
          <button class="btn" type="submit">Sign in</button>
        </form>
      </section>`;
    $('#signin').addEventListener('submit', (e) => {
      e.preventDefault();
      memToken = $('#tok').value.trim();
      setToken(memToken);
      route();
    });
    $('#tok').focus();
  }

  async function attention() {
    const a = await api('attention');
    setCount(a.blocks.length + a.payments.length);
    const blocks = a.blocks.length
      ? `<div class="table-wrap"><table><thead><tr><th>Height</th><th>Found</th><th>Mode</th><th class="num">Reward</th><th>Why</th><th></th></tr></thead><tbody>
        ${a.blocks.map((b) => `<tr>
          <td><a href="https://explorer.bumblebeam.org/block/${Number(b.height)}" target="_blank" rel="noopener">${int(b.height)}</a><span class="sub">${esc(short(b.hash))}</span></td>
          <td>${ago(b.ts)}</td><td>${esc(b.mode)}</td><td class="num">${beam(b.reward)}</td><td class="wrap">${esc(b.verifiedBy || '')}</td>
          <td class="adm-row"><button class="btn small" data-block="${Number(b.height)}" data-action="confirm">Confirm</button>
              <button class="btn small danger" data-block="${Number(b.height)}" data-action="orphan">Orphan</button></td></tr>`).join('')}
        </tbody></table></div>`
      : '<p class="hint">No unverified blocks.</p>';
    const pays = a.payments.length
      ? `<div class="table-wrap"><table><thead><tr><th>Tx</th><th>Status</th><th>Created</th><th class="num">Amount</th><th class="num">Tries</th><th>To</th><th></th></tr></thead><tbody>
        ${a.payments.map((p) => `<tr>
          <td>${esc(short(p.txId))}</td><td>${statusBadge(p.status)}</td><td>${ago(p.created)}</td><td class="num">${beam(p.amount)}</td><td class="num">${int(p.attempts)}</td>
          <td><a href="#miner/${Number(p.minerId)}">${esc(short(p.address))}</a></td>
          <td class="adm-row"><button class="btn small" data-pay="${esc(p.txId)}" data-action="sent">Sent</button>
              <button class="btn small danger" data-pay="${esc(p.txId)}" data-action="refund">Refund</button></td></tr>`).join('')}
        </tbody></table></div>`
      : '<p class="hint">No payments waiting.</p>';
    view.innerHTML = `
      <div class="page-head"><h1 class="page-title">Needs an operator</h1></div>
      ${flashHtml()}
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Unverified blocks</h2></div>
        <p class="hint">Blocks the automatic checks could not settle. Confirm credits the miners' balances; orphan drops the block.</p>${blocks}</section>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Payout run</h2></div>
        <p class="hint">Pays every miner at the payout threshold now, without waiting for the next scheduled run. A miner below the threshold is paid from its own page.</p>
        <button class="btn" id="pay-all">Pay all due now</button></section>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Payments</h2></div>
        <p class="hint">In review, or created/sending for over an hour. <b>Sent</b>: the transaction is out, the pool polls its kernel.
        <b>Refund</b>: the debit goes back to the miner (refused while the wallet still knows the transaction).</p>${pays}
        <label class="chk"><input type="checkbox" id="force"> force (pending blocks, sending payments, skip the wallet check)</label></section>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Wallet txId deduplication</h2>
        <span class="panel-meta">${a.txidHonored ? `proven: <b>${esc(a.txidHonored)}</b>` : 'not proven: run <b>admin probe-txid</b>'}</span></div></section>`;
    const force = () => $('#force').checked;
    $('#pay-all').addEventListener('click', (e) => payNow(e.target, {}, 'Run a payout for every miner at the threshold now?'));
    view.querySelectorAll('[data-block]').forEach((b) => b.addEventListener('click', () => {
      const h = b.dataset.block, action = b.dataset.action;
      act(`blocks/${h}`, { action, force: force() }, `${action} block ${h}${force() ? ' (forced)' : ''}?`);
    }));
    view.querySelectorAll('[data-pay]').forEach((b) => b.addEventListener('click', () => {
      const tx = b.dataset.pay, action = b.dataset.action;
      act(`payments/${encodeURIComponent(tx)}`, { action, force: force() }, `Mark payment ${tx} as ${action}${force() ? ' (forced)' : ''}?`);
    }));
  }

  const connRow = (c, withMiner = true) => `<tr>
    <td>${esc(c.peer)}<span class="sub">${int(c.port)} · ${esc(c.mode)}${c.tls ? ' · TLS' : ''}</span></td>
    ${withMiner ? `<td>${c.miner ? `<a href="#miner/${Number(c.minerId)}">${esc(short(c.miner))}</a>` : '<span class="dim">not logged in</span>'}<span class="sub">${esc(c.worker)}</span></td>` : `<td>${esc(c.worker)}</td>`}
    <td>${esc(c.agent) || '<span class="dim">—</span>'}</td><td>${ago(c.started).replace(' ago', '')}</td>
    <td class="num">${int(c.diff)}</td><td class="num">${int(c.accepted)}<span class="sub">${int(c.stale)} stale · ${int(c.rejected)} rej</span></td>
    <td>${ago(c.lastShare)}</td>
    <td><button class="btn small danger" data-kick="${Number(c.id)}">End</button></td></tr>`;
  const connHead = (withMiner = true) => `<thead><tr><th>Peer</th><th>${withMiner ? 'Miner / worker' : 'Worker'}</th><th>Agent</th><th>Up</th><th class="num">Diff</th><th class="num">Shares</th><th>Last share</th><th></th></tr></thead>`;
  function bindKick() {
    view.querySelectorAll('[data-kick]').forEach((b) => b.addEventListener('click', () => act(`connections/${b.dataset.kick}/kick`, {}, `End connection ${b.dataset.kick}? The miner will reconnect on its own.`)));
  }

  async function connections() {
    const c = await api('connections');
    const live = c.live.length
      ? `<div class="table-wrap"><table>${connHead()}<tbody>${c.live.map((x) => connRow(x)).join('')}</tbody></table></div>`
      : '<p class="hint">Nobody is connected.</p>';
    const recent = c.recent.length
      ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Peer</th><th>Lasted</th><th>Sent first</th><th>Ended because</th></tr></thead><tbody>
        ${c.recent.map((r) => `<tr><td>${ago(r.ts)}<span class="sub">${time(r.ts)}</span></td>
          <td>${esc(r.peer)}<span class="sub">${int(r.port)} · ${esc(r.mode)}${r.tls ? ' · TLS' : ''}</span></td>
          <td>${int(r.ts - r.started)} s</td><td class="wrap">${esc(r.first)}</td><td class="wrap">${esc(r.reason)}</td></tr>`).join('')}
        </tbody></table></div>`
      : '<p class="hint">None since the pool started.</p>';
    view.innerHTML = `
      <div class="page-head"><h1 class="page-title">Connections</h1><div class="actions"><span class="dim mono">refreshes every 10 s</span></div></div>
      ${flashHtml()}
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Live</h2><span class="panel-meta"><b>${int(c.live.length)}</b> open</span></div>${live}</section>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Ended before a login</h2><span class="panel-meta">since the pool started, newest first</span></div>
        <p class="hint">Rental services' checkers, TLS on a plain port or the other way round, wrong addresses, port scanners.
        "nothing" with no error is a plain port probe.</p>${recent}</section>`;
    bindKick();
  }

  let minerQuery = '';
  async function miners() {
    const r = await api(`miners?limit=200&q=${encodeURIComponent(minerQuery)}`);
    const day = Date.now() / 1000 - 86400;
    const flags = (m) => [
      m.firstSeen > day ? badge('new', 'pending') : '',
      m.workers24h.length === 1 && m.workers24h[0] === 'default' ? badge('no .worker', 'pending') : '',
      (m.type || '').startsWith('regular') ? badge('regular addr', 'bad') : '',
      m.connections ? badge(`${m.connections} live`, 'ok') : '',
    ].join(' ');
    view.innerHTML = `
      <div class="page-head"><h1 class="page-title">Miners</h1></div>
      ${flashHtml()}
      <section class="panel">
        <form class="adm-row" id="mq" style="margin-bottom:12px">
          <input class="adm-field" id="mq-in" placeholder="part of an address" value="${esc(minerQuery)}" aria-label="Search by address">
          <button class="btn" type="submit">Search</button>
        </form>
        <div class="table-wrap"><table><thead><tr><th>Miner</th><th>Flags</th><th>Workers 24h</th><th class="num">Hashrate 24h</th><th>First seen</th><th>Last share</th><th class="num">Unpaid</th><th class="num">Immature</th><th class="num">Paid</th></tr></thead><tbody>
        ${r.miners.map((m) => `<tr class="clickable" data-miner="${Number(m.id)}">
          <td><a href="#miner/${Number(m.id)}">${esc(short(m.address))}</a><span class="sub">#${Number(m.id)} · ${esc(m.type || '?')}</span></td>
          <td>${flags(m)}</td><td class="wrap">${esc(m.workers24h.join(', ')) || '<span class="dim">—</span>'}</td>
          <td class="num">${hr(m.hashrate24h)}</td><td>${ago(m.firstSeen)}</td><td>${ago(m.lastShare)}</td>
          <td class="num">${beam(m.balance)}</td><td class="num">${beam(m.immature)}</td><td class="num">${beam(m.paid)}</td></tr>`).join('') || '<tr><td colspan="9" class="dim">No miners.</td></tr>'}
        </tbody></table></div></section>`;
    $('#mq').addEventListener('submit', (e) => { e.preventDefault(); minerQuery = $('#mq-in').value.trim(); render(); });
    view.querySelectorAll('tr[data-miner]').forEach((tr) => tr.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      location.hash = `miner/${tr.dataset.miner}`;
    }));
  }

  async function miner(id) {
    const m = await api(`miners/${id}`);
    const workers = m.workers.length
      ? `<div class="table-wrap"><table><thead><tr><th>Worker</th><th>Modes</th><th class="num">Shares</th><th class="num">Hashrate</th><th>First</th><th>Last</th></tr></thead><tbody>
        ${m.workers.map((w) => `<tr><td>${esc(w.worker)}</td><td>${esc(w.modes.join(', '))}</td><td class="num">${int(w.shares)}</td>
          <td class="num">${hr(w.difficulty / Math.max(60, w.last - w.first))}</td><td>${ago(w.first)}</td><td>${ago(w.last)}</td></tr>`).join('')}
        </tbody></table></div>`
      : '<p class="hint">No shares in 7 days.</p>';
    const credits = m.credits.length
      ? `<div class="table-wrap"><table><thead><tr><th>Block</th><th>Status</th><th>Found</th><th class="num">Credit</th></tr></thead><tbody>
        ${m.credits.map((c) => `<tr><td>${int(c.height)}</td><td>${statusBadge(c.status)}</td><td>${ago(c.ts)}</td><td class="num">${beam(c.amount)}</td></tr>`).join('')}
        </tbody></table></div>`
      : '<p class="hint">No block credits.</p>';
    const pays = m.payments.length
      ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Status</th><th class="num">Amount</th><th class="num">Fee</th><th>Tx</th></tr></thead><tbody>
        ${m.payments.map((p) => `<tr><td>${ago(p.ts)}</td><td>${statusBadge(p.status)}</td><td class="num">${beam(p.amount)}</td><td class="num">${beam(p.fee)}</td><td>${esc(short(p.txId))}</td></tr>`).join('')}
        </tbody></table></div>`
      : '<p class="hint">Never paid.</p>';
    view.innerHTML = `
      <div class="page-head"><h1 class="page-title">Miner #${Number(m.id)}</h1><div class="actions"><a class="btn ghost small" href="#miners">All miners</a></div></div>
      ${flashHtml()}
      <section class="panel">
        <div class="adm-addr">${esc(m.address)}</div>
        <p class="hint" style="margin-top:8px">${esc(m.type || '?')} · first seen ${time(m.firstSeen)} · last share ${ago(m.lastShare)} ·
          <a href="/miners/${encodeURIComponent(m.address)}" target="_blank" rel="noopener">public page</a></p>
        <div class="tiles">
          <div class="tile"><div class="k">Unpaid</div><div class="v">${beam(m.balance)}</div></div>
          <div class="tile"><div class="k">Immature</div><div class="v">${beam(m.credits.filter((c) => c.status === 'pending' || c.status === 'unverified').reduce((s, c) => s + c.amount, 0))}</div></div>
          <div class="tile"><div class="k">Paid</div><div class="v">${beam(m.paid)}</div></div>
          <div class="tile"><div class="k">Blocks found</div><div class="v">${int(m.blocksFound)}</div></div>
        </div>
      </section>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Pay now</h2></div>
        <p class="hint">Sends the whole unpaid balance now, even below the payout threshold; the network fee comes out of it.</p>
        <button class="btn" id="pay-one"${m.balance > 0 ? '' : ' disabled'}>Pay ${beam(m.balance)} now</button></section>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Live connections</h2></div>
        ${m.connections.length ? `<div class="table-wrap"><table>${connHead(false)}<tbody>${m.connections.map((c) => connRow(c, false)).join('')}</tbody></table></div>` : '<p class="hint">None.</p>'}</section>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Workers, 7 days</h2></div>${workers}</section>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Move to another address</h2></div>
        <p class="hint">For a rig that mined under a wrong address: its shares, block credits (immature ones are paid to the new address when they mature),
        found blocks and unpaid balance go to the address below; its connections are ended first. Payout history stays here: an account never paid is deleted.
        If the rig keeps using the wrong address it comes back as a new miner, so fix the rig (or the rental profile) too.</p>
        <form class="adm-row" id="merge">
          <input class="adm-field" id="merge-to" placeholder="the right Beam address" autocomplete="off" spellcheck="false" aria-label="Address to move to">
          <button class="btn danger" type="submit">Move everything</button>
        </form></section>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Block credits</h2></div>${credits}</section>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Payments</h2></div>${pays}</section>`;
    bindKick();
    $('#pay-one').addEventListener('click', (e) => payNow(e.target, { miner: m.id }, `Pay ${beam(m.balance)} to ${short(m.address)} now?`));
    $('#merge').addEventListener('submit', async (e) => {
      e.preventDefault();
      const to = $('#merge-to').value.replace(/\s+/g, '');
      if (!to) return;
      if (!window.confirm(`Move everything of miner #${m.id} (${short(m.address)}) to ${short(to)}?`)) return;
      try {
        const r = await api(`miners/${m.id}/merge`, { to });
        flash = r.ok ? { ok: true, text: r.message } : { ok: false, text: r.error || 'refused' };
        if (r.ok) { minerQuery = to.slice(0, 16); keepFlash = true; location.hash = 'miners'; return; }
      } catch (err) {
        flash = { ok: false, text: err.message };
      }
      render();
    });
  }

  // ---------- routing ----------
  function setCount(n) {
    const el = $('#n-attention');
    el.hidden = !n;
    el.textContent = n;
  }
  let timer = null;
  async function render() {
    clearTimeout(timer);
    if (!memToken) return signIn();
    const h = location.hash.replace(/^#/, '') || 'attention';
    const [tab, arg] = h.split('/');
    document.querySelectorAll('#tabs [data-tab]').forEach((a) => a.classList.toggle('active', a.dataset.tab === (tab === 'miner' ? 'miners' : tab)));
    try {
      if (tab === 'connections') {
        await connections();
        timer = setTimeout(() => { flash = null; render(); }, 10000);
      } else if (tab === 'miners') await miners();
      else if (tab === 'miner') await miner(Number(arg));
      else await attention();
      // the menu only once the token has been accepted
      $('#tabs').hidden = false;
    } catch (e) {
      if (e instanceof AuthError) {
        memToken = '';
        setToken('');
        return signIn('Wrong token.');
      }
      view.innerHTML = `<div class="page-head"><h1 class="page-title">Operator</h1></div><div class="adm-msg err">${esc(e.message)}</div>`;
    }
  }
  let keepFlash = false;
  function route() {
    if (!keepFlash) flash = null;
    keepFlash = false;
    render();
  }
  window.addEventListener('hashchange', route);
  $('#signout').addEventListener('click', (e) => {
    e.preventDefault();
    memToken = '';
    setToken('');
    signIn();
  });
  // the Attention count shows on every tab
  async function poll() {
    if (memToken) {
      try { const a = await api('attention'); setCount(a.blocks.length + a.payments.length); } catch { /* shown by the view */ }
    }
  }
  route();
  poll();
  setInterval(poll, 60000);
})();
