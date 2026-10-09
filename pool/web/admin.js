// BumbleBeam pool: the operator dashboard (/admin). It calls /api/admin/* with the token from
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
  const explorerBlock = (h) => `<a href="https://explorer.bumblebeam.org/block/${Number(h)}" target="_blank" rel="noopener">${int(h)}</a>`;
  // a payout's transaction: its kernel in our explorer once the pool knows it, the bare tx id before
  const explorerTx = (p) => (p.kernel
    ? `<a href="https://explorer.bumblebeam.org/kernel/${encodeURIComponent(p.kernel)}" target="_blank" rel="noopener" title="${esc(p.txId)}">${esc(short(p.txId || p.kernel))}</a>`
    : esc(short(p.txId)));
  const tile = (k, v, s = '', cls = '') => `<div class="tile"><div class="k">${k}</div><div class="v ${cls}">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
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

  // A confirmation in the site's own look instead of window.confirm: resolves true on the button
  // (or Enter), false on Cancel, Esc or a click outside. Text only, never HTML.
  function ask(title, text, { ok = 'Confirm', danger = false } = {}) {
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'adm-ask-bg';
      back.innerHTML = `<div class="adm-ask${danger ? ' danger' : ''}" role="alertdialog" aria-modal="true" aria-labelledby="adm-ask-t" aria-describedby="adm-ask-d">
        <h3 id="adm-ask-t"></h3><div id="adm-ask-d"></div>
        <div class="adm-row"><button class="btn ghost" data-a="no">Cancel</button><button class="btn${danger ? ' danger' : ''}" data-a="yes"></button></div></div>`;
      $('#adm-ask-t', back).textContent = title;
      // text, or a list of strings and { b: text } for bold parts; never HTML
      const d = $('#adm-ask-d', back);
      for (const part of Array.isArray(text) ? text : [text]) {
        if (part && typeof part === 'object') { const b = document.createElement('b'); b.textContent = part.b; d.append(b); } else d.append(String(part));
      }
      $('[data-a="yes"]', back).textContent = ok;
      const before = document.activeElement;
      const done = (v) => {
        document.removeEventListener('keydown', key, true);
        back.remove();
        if (before && before.focus) before.focus();
        resolve(v);
      };
      const key = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); done(false); }
        else if (e.key === 'Enter' && document.activeElement !== $('[data-a="no"]', back)) { e.preventDefault(); done(true); }
        else if (e.key === 'Tab') { // keep the focus inside the dialog
          const b = [...back.querySelectorAll('button')], i = b.indexOf(document.activeElement);
          e.preventDefault();
          b[(i + (e.shiftKey ? b.length - 1 : 1)) % b.length].focus();
        }
      };
      back.addEventListener('click', (e) => {
        const a = e.target.closest('[data-a]');
        if (a) done(a.dataset.a === 'yes');
        else if (e.target === back) done(false);
      });
      document.addEventListener('keydown', key, true);
      document.body.appendChild(back);
      requestAnimationFrame(() => back.classList.add('on'));
      $('[data-a="yes"]', back).focus();
    });
  }

  let flash = null;
  const flashHtml = () => (flash ? `<div class="adm-msg ${flash.ok ? 'ok' : 'err'}">${esc(flash.text)}</div>` : '');
  async function act(path, body, q) {
    if (q && !(await ask(q.title, q.text, q))) return;
    try {
      const r = await api(path, body);
      flash = r.ok ? { ok: true, text: r.message } : { ok: false, text: r.error || 'refused' };
    } catch (e) {
      flash = { ok: false, text: e.message };
    }
    render();
  }

  // a payout run takes a few seconds per miner: the button says so until the pool answers
  async function payNow(btn, body, text) {
    if (!(await ask('Payout', text, { ok: 'Pay now' }))) return;
    btn.disabled = true;
    btn.textContent = 'Paying…';
    await act('payouts', body);
  }

  // ---------- copy buttons (data-copy), as on the pool's pages ----------
  function copyFallback(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
  view.addEventListener('click', (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    const text = b.dataset.copy;
    const done = (ok) => { b.textContent = ok ? 'copied' : 'failed'; setTimeout(() => (b.textContent = 'copy'), 1500); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(() => done(true), () => done(copyFallback(text)));
    else done(copyFallback(text));
  });

  // ---------- the pool site's block cells: mode, effort, status ----------
  const MATURITY = 240;
  const modeBadge = (m) => (m === 'solo' ? '<span class="badge solo">solo</span>' : '<span class="badge ok">pplns</span>');
  const effortColor = (e) => (e == null ? 'inherit' : e > 1.5 ? 'var(--color-red)' : e < 0.7 ? 'var(--accent)' : 'inherit');
  const blockStatus = (b) => (b.status === 'confirmed' ? '<span class="badge ok">confirmed</span>'
    : b.status === 'orphaned' ? '<span class="badge bad">orphaned</span>'
    : b.status === 'unverified' ? '<span class="badge bad">unverified</span>'
    : `<span class="badge pending">${int(Math.min(b.confirmations, MATURITY))}/${MATURITY}</span>`);

  // A listbox in place of a native <select> (the pool site's dropdown(), the same .dd styles):
  // arrows, Home/End, Enter or Space to pick, Esc or Tab to close.
  function dropdown(root, onPick) {
    const btn = root.querySelector('.dd-btn'), list = root.querySelector('.dd-list');
    const items = [...list.querySelectorAll('[role="option"]')];
    let active = -1;
    const isOpen = () => !list.hidden;
    function mark(i) {
      active = i;
      items.forEach((li, j) => li.classList.toggle('active', j === i));
      if (items[i]) items[i].scrollIntoView({ block: 'nearest' });
    }
    function set(v) {
      const li = items.find((x) => x.dataset.v === v) || items.find((x) => x.dataset.v === '');
      items.forEach((x) => x.setAttribute('aria-selected', String(x === li)));
      root.dataset.value = li ? li.dataset.v : '';
      btn.textContent = li ? li.textContent : '';
    }
    function open() {
      list.hidden = false;
      root.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      mark(Math.max(0, items.findIndex((x) => x.getAttribute('aria-selected') === 'true')));
    }
    function close(focus = true) {
      list.hidden = true;
      root.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      if (focus) btn.focus();
    }
    function pick(i) {
      const li = items[i];
      if (!li) return;
      set(li.dataset.v);
      close();
      onPick(li.dataset.v);
    }
    btn.addEventListener('click', () => (isOpen() ? close() : open()));
    list.addEventListener('mousedown', (e) => e.preventDefault());
    list.addEventListener('click', (e) => { const li = e.target.closest('[role="option"]'); if (li) pick(items.indexOf(li)); });
    list.addEventListener('mousemove', (e) => { const li = e.target.closest('[role="option"]'); if (li && items.indexOf(li) !== active) mark(items.indexOf(li)); });
    btn.addEventListener('keydown', (e) => {
      const k = e.key;
      if (!isOpen()) {
        if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(k)) { e.preventDefault(); open(); }
        return;
      }
      if (k === 'ArrowDown') { e.preventDefault(); mark(Math.min(items.length - 1, active + 1)); }
      else if (k === 'ArrowUp') { e.preventDefault(); mark(Math.max(0, active - 1)); }
      else if (k === 'Home') { e.preventDefault(); mark(0); }
      else if (k === 'End') { e.preventDefault(); mark(items.length - 1); }
      else if (k === 'Enter' || k === ' ') { e.preventDefault(); pick(active); }
      else if (k === 'Escape') { e.preventDefault(); close(); }
      else if (k === 'Tab') close(false);
    });
    document.addEventListener('click', (e) => { if (isOpen() && !root.contains(e.target)) close(false); });
    set(root.dataset.value || '');
  }
  const ddHtml = (id, label, value, opts) => `<div class="dd compact" id="${id}" data-value="${esc(value)}"><button type="button" class="dd-btn" aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(label)}"></button>
    <ul class="dd-list" role="listbox" tabindex="-1" hidden>${opts.map(([v, t]) => `<li role="option" data-v="${esc(v)}">${esc(t)}</li>`).join('')}</ul></div>`;

  // ---------- a miner's found blocks: sort by mode, effort or finder, filter by mode and finder ----------
  const FB_PAGE = 10;
  const fb = { id: 0, blocks: [], credit: new Map(), mode: '', finder: '', sort: '', dir: 1, shown: FB_PAGE };
  const FB_SORTS = {
    mode: (a, b) => a.mode.localeCompare(b.mode),
    finder: (a, b) => String(a.finder || '').localeCompare(String(b.finder || ''), 'en', { numeric: true }),
    effort: (a, b) => (a.effort ?? Infinity) - (b.effort ?? Infinity),
  };
  function fbList() {
    const list = fb.blocks.filter((b) => (!fb.mode || b.mode === fb.mode) && (!fb.finder || b.finder === fb.finder));
    const by = FB_SORTS[fb.sort];
    const last = (a, b) => (fb.sort === 'effort' ? (a.effort == null) - (b.effort == null) : 0);
    return list.sort((a, b) => last(a, b) || (by ? by(a, b) * fb.dir : 0) || b.height - a.height);
  }
  const fbRow = (b) => `<tr>
    <td>${explorerBlock(b.height)}</td><td class="dim">${ago(b.ts)}</td><td>${modeBadge(b.mode)}</td>
    <td class="num" style="color:${effortColor(b.effort)}">${b.effort == null ? '—' : `${(b.effort * 100).toFixed(0)}%`}</td>
    <td class="dim">${esc(b.finder || '—')}</td>
    <td class="num">${beam(b.reward + (b.fees || 0))}<span class="sub">${b.status === 'confirmed' ? (b.fees ? `incl. ${beam(b.fees)} tx fees` : 'no tx fees') : 'tx fees known at maturity'}</span></td>
    <td class="num">${fb.credit.has(b.height) ? beam(fb.credit.get(b.height)) : '—'}</td><td class="num">${blockStatus(b)}</td></tr>`;
  function foundPanel() {
    if (!fb.blocks.length) return '<section class="panel"><div class="panel-head"><h2 class="panel-title">Blocks found</h2></div><p class="hint">This miner has not found a block.</p></section>';
    const modes = [...new Set(fb.blocks.map((b) => b.mode))].sort();
    const finders = [...new Set(fb.blocks.map((b) => b.finder).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    const th = (key, text, cls = '') => `<th class="sortable${cls}" data-sort="${key}" tabindex="0" aria-label="Sort by ${text.toLowerCase()}">${text}</th>`;
    return `<section class="panel" id="fb"><div class="panel-head"><h2 class="panel-title">Blocks found</h2>
        <div class="panel-meta"><span id="fb-count"></span>
          ${ddHtml('fb-mode', 'Filter by mode', fb.mode, [['', 'All modes'], ...modes.map((v) => [v, v === 'solo' ? 'Solo' : 'PPLNS'])])}
          ${ddHtml('fb-finder', 'Filter by finder', fb.finder, [['', 'All finders'], ...finders.map((v) => [v, v])])}</div></div>
      <div class="table-wrap"><table><thead><tr><th>Height</th><th>Found</th>${th('mode', 'Mode')}${th('effort', 'Effort', ' num')}${th('finder', 'Finder')}<th class="num">Earned</th><th class="num">Credit</th><th class="num">Status</th></tr></thead>
        <tbody id="fb-body"></tbody></table></div>
      <div class="more" id="fb-more" hidden><button class="btn ghost">Show more</button></div></section>`;
  }
  function drawFound() {
    const list = fbList();
    $('#fb-body').innerHTML = list.length ? list.slice(0, fb.shown).map(fbRow).join('') : '<tr><td colspan="8" class="dim">No blocks match</td></tr>';
    $('#fb-more').hidden = list.length <= fb.shown;
    $('#fb-count').textContent = list.length === fb.blocks.length ? `${int(list.length)} blocks` : `${int(list.length)} of ${int(fb.blocks.length)}`;
    view.querySelectorAll('#fb th[data-sort]').forEach((t) => {
      const on = t.dataset.sort === fb.sort;
      t.dataset.dir = on ? (fb.dir > 0 ? '▲' : '▼') : '';
      t.setAttribute('aria-sort', on ? (fb.dir > 0 ? 'ascending' : 'descending') : 'none');
    });
  }
  function bindFound() {
    if (!$('#fb')) return;
    dropdown($('#fb-mode'), (v) => { fb.mode = v; fb.shown = FB_PAGE; drawFound(); });
    dropdown($('#fb-finder'), (v) => { fb.finder = v; fb.shown = FB_PAGE; drawFound(); });
    const sortBy = (key) => {
      // first click ascending, again descending, a third time back to newest first
      if (fb.sort !== key) { fb.sort = key; fb.dir = 1; } else if (fb.dir > 0) fb.dir = -1; else { fb.sort = ''; fb.dir = 1; }
      drawFound();
    };
    view.querySelectorAll('#fb th[data-sort]').forEach((t) => {
      t.addEventListener('click', () => sortBy(t.dataset.sort));
      t.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sortBy(t.dataset.sort); } });
    });
    $('#fb-more button').addEventListener('click', () => { fb.shown += FB_PAGE; drawFound(); });
    drawFound();
  }

  // ---------- views ----------
  function signIn(err) {
    $('#tabs').hidden = true;
    nextPay = null; // the countdown sits outside the menu: hidden with it
    frozenLeft = null;
    tick();
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
    setNext(a);
    const blocks = a.blocks.length
      ? `<div class="table-wrap"><table><thead><tr><th>Height</th><th>Found</th><th>Mode</th><th class="num">Reward</th><th>Why</th><th></th></tr></thead><tbody>
        ${a.blocks.map((b) => `<tr>
          <td>${explorerBlock(b.height)}<span class="sub">${esc(short(b.hash))}</span></td>
          <td>${ago(b.ts)}</td><td>${esc(b.mode)}</td><td class="num">${beam(b.reward)}</td><td class="wrap">${esc(b.verifiedBy || '')}</td>
          <td class="adm-row"><button class="btn small" data-block="${Number(b.height)}" data-action="confirm">Confirm</button>
              <button class="btn small danger" data-block="${Number(b.height)}" data-action="orphan">Orphan</button></td></tr>`).join('')}
        </tbody></table></div>`
      : '<p class="hint">No unverified blocks.</p>';
    const pays = a.payments.length
      ? `<div class="table-wrap"><table><thead><tr><th>Tx</th><th>Status</th><th>Created</th><th class="num">Amount</th><th class="num">Tries</th><th>To</th><th></th></tr></thead><tbody>
        ${a.payments.map((p) => `<tr>
          <td>${explorerTx(p)}</td><td>${statusBadge(p.status)}</td><td>${ago(p.created)}</td><td class="num">${beam(p.amount)}</td><td class="num">${int(p.attempts)}</td>
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
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Payout run</h2>
        <span class="panel-meta">${a.nextPayout ? `<b id="next-pay-panel"></b> · every ${Math.round(a.payoutInterval / 60)} min` : 'payouts are off'}</span></div>
        <p class="hint">Pays every miner at the payout threshold now, without waiting for the next scheduled run. A miner below the threshold is paid from its own page.</p>
        <button class="btn" id="pay-all">Pay all due now</button></section>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Payments</h2></div>
        <p class="hint">In review, or created/sending for over an hour. <b>Sent</b>: the transaction is out, the pool polls its kernel.
        <b>Refund</b>: the debit goes back to the miner (refused while the wallet still knows the transaction).</p>${pays}
        <label class="chk"><input type="checkbox" id="force"> force (pending blocks, sending payments, skip the wallet check)</label></section>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Wallet txId deduplication</h2>
        <span class="panel-meta">${a.txidHonored ? `proven: <b>${esc(a.txidHonored)}</b>` : 'not proven: run <b>admin probe-txid</b>'}</span></div></section>`;
    const force = () => $('#force').checked;
    $('#pay-all').addEventListener('click', (e) => payNow(e.target, {}, 'Run a payout now for every miner at the payout threshold?'));
    view.querySelectorAll('[data-block]').forEach((b) => b.addEventListener('click', () => {
      const h = b.dataset.block, action = b.dataset.action;
      act(`blocks/${h}`, { action, force: force() }, {
        title: `${action} block`, ok: action === 'orphan' ? 'Orphan' : 'Confirm', danger: action === 'orphan',
        text: `${action === 'orphan' ? 'Drop' : 'Confirm'} block ${h}${force() ? ' (forced)' : ''}? ${action === 'orphan' ? 'Its credits are not paid.' : 'Its credits go into the miners\' balances.'}`,
      });
    }));
    view.querySelectorAll('[data-pay]').forEach((b) => b.addEventListener('click', () => {
      const tx = b.dataset.pay, action = b.dataset.action;
      act(`payments/${encodeURIComponent(tx)}`, { action, force: force() }, {
        title: action === 'refund' ? 'Refund payment' : 'Payment sent', ok: action === 'refund' ? 'Refund' : 'Mark sent', danger: action === 'refund',
        text: `${action === 'refund' ? 'Return the debit of' : 'Mark as sent'} payment ${tx}${force() ? ' (forced)' : ''}?`,
      });
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
    view.querySelectorAll('[data-kick]').forEach((b) => b.addEventListener('click', () => act(`connections/${b.dataset.kick}/kick`, {}, { title: 'End connection', ok: 'End', danger: true, text: `End connection ${b.dataset.kick}? The miner will reconnect on its own.` })));
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
    // the blocks this miner found, from the public API (its own credits are in every PPLNS block)
    // the public API: every block this miner found, and the numbers of its page on the pool site
    const pub = (path) => fetch(`/api/${path}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const [fj, pm, st] = await Promise.all([pub(`blocks?limit=500&miner=${encodeURIComponent(m.address)}`), pub(`miners/${encodeURIComponent(m.address)}?range=24h`), pub('stats')]);
    const found = (fj && fj.blocks) || [];
    const p = pm || {};
    const minPayout = st && st.config ? st.config.minPayout : null;
    if (fb.id !== m.id) Object.assign(fb, { id: m.id, mode: '', finder: '', sort: '', dir: 1, shown: FB_PAGE });
    fb.blocks = found;
    fb.credit = new Map(m.credits.map((c) => [c.height, c.amount]));
    const workers = m.workers.length
      ? `<div class="table-wrap"><table><thead><tr><th>Worker</th><th>Modes</th><th class="num">Shares</th><th class="num">Hashrate</th><th>First</th><th>Last</th></tr></thead><tbody>
        ${m.workers.map((w) => `<tr><td>${esc(w.worker)}</td><td>${w.modes.map(modeBadge).join(' ')}</td><td class="num">${int(w.shares)}</td>
          <td class="num">${hr(w.difficulty / Math.max(60, w.last - w.first))}</td><td>${ago(w.first)}</td><td>${ago(w.last)}</td></tr>`).join('')}
        </tbody></table></div>`
      : '<p class="hint">No shares in 7 days.</p>';
    const credits = m.credits.length
      ? `<div class="table-wrap"><table><thead><tr><th>Block</th><th>Status</th><th>Found</th><th class="num">Credit</th></tr></thead><tbody>
        ${m.credits.map((c) => `<tr><td>${explorerBlock(c.height)}</td><td>${statusBadge(c.status)}</td><td>${ago(c.ts)}</td><td class="num">${beam(c.amount)}</td></tr>`).join('')}
        </tbody></table></div>`
      : '<p class="hint">No block credits.</p>';
    const pays = m.payments.length
      ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Status</th><th class="num">Amount</th><th class="num">Fee</th><th>Tx</th></tr></thead><tbody>
        ${m.payments.map((p) => `<tr><td>${ago(p.ts)}</td><td>${statusBadge(p.status)}</td><td class="num">${beam(p.amount)}</td><td class="num">${beam(p.fee)}</td><td>${explorerTx(p)}</td></tr>`).join('')}
        </tbody></table></div>`
      : '<p class="hint">Never paid.</p>';
    view.innerHTML = `
      <div class="page-head"><h1 class="page-title">Miner #${Number(m.id)}</h1><span class="dim mono adm-seen">first seen ${time(m.firstSeen)}</span>
        <div class="actions"><a class="btn ghost small" href="#miners">All miners</a></div></div>
      ${flashHtml()}
      <div class="panel addr"><span>${esc(m.address)}</span><button class="btn small" data-copy="${esc(m.address)}">copy</button>
        <a class="btn small" href="/miners/${encodeURIComponent(m.address)}" target="_blank" rel="noopener">public</a></div>
      <div class="tiles">
        ${tile('Hashrate', hr(p.hashrate), `24h avg ${hr(p.hashrate24h)}`, 'accent')}
        ${tile('Unpaid', beam(m.balance), minPayout ? `owed by the pool · ${Math.round(Math.min(1, m.balance / minPayout) * 100)}% of the ${beam(minPayout)} threshold` : 'owed by the pool')}
        ${tile('Immature', beam(m.credits.filter((c) => c.status === 'pending' || c.status === 'unverified').reduce((s, c) => s + c.amount, 0)), 'blocks still confirming')}
        ${tile('Paid', beam(m.paid))}
        ${tile('Blocks found', int(m.blocksFound), m.blocksFound ? `${int(p.blocks24h)} in 24h · last ${ago(p.lastBlockAt)}` : 'by its shares')}
        ${tile('Last share', ago(m.lastShare))}
      </div>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Pay now</h2></div>
        <p class="hint">Sends the whole unpaid balance now, even below the payout threshold (the network fee comes out of it).</p>
        <button class="btn" id="pay-one"${m.balance > 0 ? '' : ' disabled'}>Pay now</button></section>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Live connections</h2></div>
        ${m.connections.length ? `<div class="table-wrap"><table>${connHead(false)}<tbody>${m.connections.map((c) => connRow(c, false)).join('')}</tbody></table></div>` : '<p class="hint">None.</p>'}</section>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Workers, 7 days</h2></div>${workers}</section>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Move to another address</h2></div>
        <p class="hint">For a rig that mined under the wrong address: its shares, block credits (immature ones are paid to the new address when they mature),
        found blocks, and unpaid balance go to the address below; its connections are ended first. Payout history stays here: an account that has never paid is deleted.
        If the rig keeps using the wrong address, it comes back as a new miner, so fix the rig (or the rental profile) too.</p>
        <form class="adm-row" id="merge">
          <input class="adm-field" id="merge-to" placeholder="the right Beam address" autocomplete="off" spellcheck="false" aria-label="Address to move to">
          <button class="btn danger" type="submit">Move everything</button>
        </form></section>
      ${foundPanel()}
      <section class="panel"><div class="panel-head"><h2 class="panel-title">PPLNS credits</h2><span class="panel-meta">latest 50</span></div>
        <p class="hint">Its share of every block the pool found while its shares were in the PPLNS window, whoever found the block.</p>${credits}</section>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Payments</h2></div>${pays}</section>`;
    bindKick();
    bindFound();
    $('#pay-one').addEventListener('click', (e) => payNow(e.target, { miner: m.id }, ['Pay ', { b: beam(m.balance) }, ' now?\nAddress: ', m.address]));
    $('#merge').addEventListener('submit', async (e) => {
      e.preventDefault();
      const to = $('#merge-to').value.replace(/\s+/g, '');
      if (!to) return;
      if (!(await ask('Move to another address', `Move the shares, block credits, found blocks and unpaid balance of miner #${m.id} (${short(m.address)}) to ${short(to)}? Its connections are ended first.`, { ok: 'Move everything', danger: true }))) return;
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

  // ---------- the next scheduled payout ----------
  let nextPay = null; // in this browser's clock: the server's time minus its offset from ours
  let frozenLeft = null; // seconds left on a countdown the operator has frozen
  function setNext(a) {
    nextPay = a.nextPayout ? a.nextPayout - a.now + Date.now() / 1000 : null;
    frozenLeft = a.payoutsFrozen ? a.frozenLeft : null;
    tick();
  }
  function left() {
    const s = frozenLeft != null ? frozenLeft : Math.round(nextPay - Date.now() / 1000);
    if (s <= 0) return 'now';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(sec).padStart(2, '0')}`;
  }
  function tick() {
    const top = $('#next-pay'), panel = $('#next-pay-panel'), fz = $('#freeze');
    top.hidden = fz.hidden = nextPay == null;
    if (nextPay == null) return;
    const frozen = frozenLeft != null;
    fz.textContent = frozen ? 'Resume' : 'Freeze';
    fz.classList.toggle('frozen', frozen);
    fz.title = frozen ? 'Resume the scheduled payouts: the countdown goes on from where it stopped' : 'Freeze the scheduled payouts: the countdown stops, no run starts until resumed';
    top.classList.toggle('frozen', frozen);
    if (frozen) {
      top.innerHTML = `payouts frozen <b>${esc(left())}</b>`;
      top.title = 'Scheduled payouts are frozen; Pay now still works';
      if (panel) panel.textContent = `scheduled runs frozen, ${left()} left`;
      return;
    }
    const at = new Date(nextPay * 1000).toISOString().slice(11, 16);
    top.innerHTML = `payout in <b>${esc(left())}</b>`;
    top.title = `Next scheduled payout run at ${at} UTC (the pool looks once a minute)`;
    if (panel) panel.textContent = `next run in ${left()} (${at} UTC)`;
  }
  $('#freeze').addEventListener('click', async () => {
    const freeze = frozenLeft == null;
    const ok = await ask(freeze ? 'Freeze payouts' : 'Resume payouts', freeze
      ? `Stop the payout countdown at ${left()}? No scheduled run starts until you resume it, also after a pool restart. Pay now still works.`
      : `Resume the scheduled payouts? The next run is in ${left()}.`, { ok: freeze ? 'Freeze' : 'Resume', danger: freeze });
    if (!ok) return;
    // the countdown itself shows the result; only a refusal gets a message
    flash = null;
    try {
      const r = await api('payouts/freeze', { freeze });
      if (!r.ok) flash = { ok: false, text: r.error || 'refused' };
    } catch (e) {
      flash = { ok: false, text: e.message };
    }
    keepFlash = !!flash;
    await poll();
    route();
  });
  setInterval(tick, 1000);

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
    nextPay = null;
    signIn();
  });
  // the Attention count shows on every tab
  async function poll() {
    if (memToken) {
      try { const a = await api('attention'); setCount(a.blocks.length + a.payments.length); setNext(a); } catch { /* shown by the view */ }
    }
  }
  route();
  poll();
  setInterval(poll, 30000);
})();
