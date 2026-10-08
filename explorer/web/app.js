// BumbleBeam Explorer: a Beam block explorer over the HTTP API of Beam's own explorer-node.
// No framework, no build step; the pool's styles.css plus explorer.css.
//
// Data comes from /api/* (explorer-web proxies it to our explorer-node). From localhost,
// ?api=<url> points the page at another explorer API, e.g. https://explorer.0xmx.net/api.
//
// Every value from the API is typed here (numbers, length-capped strings, hex checked) and
// every string still goes through esc() before it is put into HTML.
'use strict';

(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const view = $('#view');
  const params = new URLSearchParams(location.search);
  const DEV = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const API = ((DEV && params.get('api')) || '/api').replace(/\/$/, '');
  const GROTH = 1e8;
  const PAGE = 30;

  // ---------- formatting and typing ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (x) => {
    if (x == null || x === '') return null;
    const n = typeof x === 'string' ? Number(x.replace(/,/g, '')) : Number(x);
    return Number.isFinite(n) ? n : null;
  };
  const hex = (x, max = 70) => (typeof x === 'string' && /^[0-9a-f]+$/i.test(x) && x.length <= max ? x.toLowerCase() : '');
  const int = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));
  const beam = (g, d = 4) => (g == null ? '—' : `${(g / GROTH).toLocaleString('en-US', { maximumFractionDigits: d })} BEAM`);
  const diff = (d) => (d == null ? '—' : d >= 1e6 ? `${(d / 1e6).toFixed(2)}M` : int(d));
  const short = (s, a = 10, b = 8) => (s && s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s || '—');
  function ago(ts) {
    if (!ts) return '—';
    const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }
  const utc = (ts) => (ts ? new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '—');
  const tile = (k, v, s = '', cls = '') => `<div class="tile"><div class="k">${k}</div><div class="v ${cls}">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
  const blockHref = (h) => `/block/${Math.round(Number(h) || 0)}`;
  const kernelHref = (k) => `/kernel/${hex(k)}`;

  async function get(path, timeoutMs = 10000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(`${API}/${path}`, { signal: ctl.signal, cache: 'no-store' });
      if (!r.ok) throw new Error(`explorer API answered ${r.status}`);
      return await r.json();
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? 'explorer API timed out' : e.message);
    } finally {
      clearTimeout(t);
    }
  }

  function normStatus(s) {
    return { height: num(s && s.height), hash: hex(s && s.hash), ts: num(s && s.timestamp), peers: num(s && s.peers_count),
      chainwork: typeof (s && s.chainwork) === 'string' ? s.chainwork.slice(0, 60) : '', shielded24h: num(s && s.shielded_outputs_per_24h),
      shieldedTotal: num(s && s.shielded_outputs_total) };
  }
  function normBlock(b) {
    if (!b || b.found === false) return null;
    const arr = (x) => (Array.isArray(x) ? x.slice(0, 5000) : []);
    return {
      height: num(b.height), hash: hex(b.hash), prev: hex(b.prev), ts: num(b.timestamp), difficulty: num(b.difficulty),
      subsidy: num(b.subsidy), chainwork: typeof b.chainwork === 'string' ? b.chainwork.slice(0, 60) : '',
      kernels: arr(b.kernels).map((k) => ({ id: hex(k && k.id), fee: num(k && k.fee), min: num(k && k.minHeight), max: num(k && k.maxHeight) })),
      inputs: arr(b.inputs).map((i) => ({ commitment: hex(i && i.commitment, 70), height: num(i && i.height) })),
      outputs: arr(b.outputs).map((o) => ({ commitment: hex(o && o.commitment, 70), coinbase: o && o.type === 'Coinbase', value: num(o && o.Value),
        maturity: num(o && o.Maturity), spent: num(o && o.spent) })),
    };
  }
  // /hdrs?hMax=<height>&nMax=<count> answers a table, newest first: a header row, then
  // [height, hash, time, difficulty, fee, txs, outputs, inputs, ...], each cell a plain value or {type, value}.
  function normHdrs(t) {
    const rows = t && Array.isArray(t.value) ? t.value.slice(1, PAGE + 1) : [];
    const v = (c) => (c && typeof c === 'object' ? c.value : c);
    return rows.map((r) => ({ height: num(v(r[0])), hash: hex(v(r[1])), ts: num(v(r[2])), difficulty: num(v(r[3])), fee: num(v(r[4])),
      txs: num(v(r[5])), outputs: num(v(r[6])), inputs: num(v(r[7])) })).filter((r) => r.height != null);
  }

  // ---------- views ----------
  const views = {};

  function hdrRows(rows) {
    return rows.map((b) => `<tr><td><a href="${blockHref(b.height)}">${int(b.height)}</a></td><td class="dim">${ago(b.ts)}</td>
      <td class="mono dim"><a href="${blockHref(b.height)}">${esc(short(b.hash))}</a></td><td class="num">${diff(b.difficulty)}</td>
      <td class="num">${int(b.txs)}</td><td class="num">${int(b.outputs)} / ${int(b.inputs)}</td><td class="num dim">${b.fee ? beam(b.fee, 6) : '—'}</td></tr>`).join('');
  }

  views.home = async () => {
    const st = normStatus(await get('status'));
    const rows = st.height ? normHdrs(await get(`hdrs?hMax=${st.height}&nMax=${PAGE}`)) : [];
    const last = rows[rows.length - 1];
    return `<div class="page-head"><h1 class="page-title">Beam blocks</h1></div>
      <div class="tiles">
        ${tile('Height', int(st.height), st.ts ? `last block ${ago(st.ts)}` : '', 'accent')}
        ${tile('Difficulty', diff(rows[0] && rows[0].difficulty))}
        ${tile('Peers', int(st.peers), 'connected to our node')}
        ${tile('Shielded outputs 24h', int(st.shielded24h), `${int(st.shieldedTotal)} in total`)}
      </div>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Latest blocks</h2><div class="panel-meta"><span>Outputs / inputs are Mimblewimble UTXOs</span></div></div>
        ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Height</th><th>Age</th><th>Hash</th><th class="num">Difficulty</th><th class="num">Txs</th><th class="num">Out / in</th><th class="num">Fees</th></tr></thead>
        <tbody id="hdr-body">${hdrRows(rows)}</tbody></table></div>
        ${last && last.height > 1 ? `<div class="more"><button class="btn ghost" id="more-hdrs" data-before="${last.height - 1}">Load older blocks</button></div>` : ''}`
        : '<div class="empty">No blocks yet: the node is still syncing headers</div>'}
      </section>`;
  };

  function bindHome() {
    const btn = $('#more-hdrs');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Loading…';
      try {
        const rows = normHdrs(await get(`hdrs?hMax=${Number(btn.dataset.before) || 1}&nMax=${PAGE}`));
        $('#hdr-body').insertAdjacentHTML('beforeend', hdrRows(rows));
        const last = rows[rows.length - 1];
        if (!last || last.height <= 1) btn.remove();
        else { btn.dataset.before = String(last.height - 1); btn.disabled = false; btn.textContent = 'Load older blocks'; }
      } catch (e) {
        btn.textContent = 'Could not load';
      }
    });
  }

  async function blockView(b, hit = '') {
    const fees = b.kernels.reduce((s, k) => s + (k.fee || 0), 0);
    const coinbase = b.outputs.filter((o) => o.coinbase).reduce((s, o) => s + (o.value || 0), 0);
    const kRows = b.kernels.map((k) => `<tr class="${k.id && k.id === hit ? 'hit' : ''}"><td class="mono"><a href="${kernelHref(k.id)}">${esc(short(k.id, 16, 12))}</a></td>
      <td class="num">${k.fee ? beam(k.fee, 8) : '0'}</td><td class="num dim">${int(k.min)}</td><td class="num dim">${int(k.max)}</td></tr>`).join('');
    const iRows = b.inputs.map((i) => `<tr><td class="mono dim">${esc(short(i.commitment, 16, 12))}</td><td class="num">${i.height ? `<a href="${blockHref(i.height)}">${int(i.height)}</a>` : '—'}</td></tr>`).join('');
    const oRows = b.outputs.map((o) => `<tr><td class="mono dim">${esc(short(o.commitment, 16, 12))}</td>
      <td>${o.coinbase ? '<span class="badge ok">coinbase</span>' : '<span class="dim">confidential</span>'}</td>
      <td class="num">${o.coinbase && o.value != null ? beam(o.value, 4) : '—'}</td><td class="num dim">${o.maturity ? int(o.maturity) : '—'}</td>
      <td class="num">${o.spent ? `<a href="${blockHref(o.spent)}">${int(o.spent)}</a>` : '<span class="dim">unspent</span>'}</td></tr>`).join('');
    return `<div class="page-head"><h1 class="page-title">Block ${int(b.height)}</h1>
        <div class="actions pager">${b.height > 0 ? `<a class="btn ghost small" href="${blockHref(b.height - 1)}">← ${int(b.height - 1)}</a>` : ''}<a class="btn ghost small" href="${blockHref(b.height + 1)}">${int(b.height + 1)} →</a></div></div>
      <div class="tiles">
        ${tile('Mined', ago(b.ts), esc(utc(b.ts)))}
        ${tile('Difficulty', diff(b.difficulty))}
        ${tile('Reward', beam(b.subsidy, 2), coinbase && coinbase !== b.subsidy ? `coinbase ${beam(coinbase, 4)}` : '', 'accent')}
        ${tile('Fees', beam(fees, 6))}
        ${tile('Kernels / out / in', `${int(b.kernels.length)} / ${int(b.outputs.length)} / ${int(b.inputs.length)}`)}
      </div>
      <section class="panel"><dl class="kv">
        <dt>Hash</dt><dd>${esc(b.hash) || '—'}</dd>
        <dt>Previous</dt><dd>${b.height > 0 ? `<a href="${blockHref(b.height - 1)}">${esc(b.prev) || '—'}</a>` : '—'}</dd>
        <dt>Chainwork</dt><dd>${esc(b.chainwork) || '—'}</dd>
      </dl></section>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Kernels</h2><div class="panel-meta"><span>one per transaction; amounts are hidden by design</span></div></div>
        ${kRows ? `<div class="table-wrap"><table><thead><tr><th>Kernel ID</th><th class="num">Fee</th><th class="num">Min height</th><th class="num">Max height</th></tr></thead><tbody>${kRows}</tbody></table></div>` : '<div class="empty">No kernels</div>'}</section>
      <div class="grid2">
        <section class="panel"><div class="panel-head"><h2 class="panel-title">Outputs</h2></div>
          ${oRows ? `<div class="table-wrap"><table><thead><tr><th>Commitment</th><th>Type</th><th class="num">Value</th><th class="num">Matures</th><th class="num">Spent in</th></tr></thead><tbody>${oRows}</tbody></table></div>` : '<div class="empty">No outputs</div>'}</section>
        <section class="panel"><div class="panel-head"><h2 class="panel-title">Inputs</h2></div>
          ${iRows ? `<div class="table-wrap"><table><thead><tr><th>Commitment</th><th class="num">Created in</th></tr></thead><tbody>${iRows}</tbody></table></div>` : '<div class="empty">No inputs</div>'}</section>
      </div>`;
  }

  const notFound = (what) => `<div class="page-head"><h1 class="page-title">Not found</h1></div>
    <div class="panel empty">${esc(what)} is not on the chain we know. The node may still be syncing. <a href="/">Latest blocks</a></div>`;

  // Beam's explorer API finds a block by height or by one of its kernels, not by block hash.
  views.block = async (arg) => {
    if (!/^\d{1,10}$/.test(arg || '')) return notFound(`Block ${String(arg || '').slice(0, 80)}`);
    const b = normBlock(await get(`block?height=${Number(arg)}`));
    return b ? blockView(b) : notFound(`Block ${arg}`);
  };

  views.kernel = async (arg) => {
    const k = hex(arg, 64);
    if (k.length !== 64) return notFound(`Kernel ${String(arg || '').slice(0, 80)}`);
    // without a valid kernel argument the API answers with the tip, so check the kernel is there
    const b = normBlock(await get(`block?kernel=${k}`));
    const kern = b && b.kernels.find((x) => x.id === k);
    if (!kern) return notFound(`Kernel ${short(k)}`);
    return `<div class="page-head"><h1 class="page-title">Kernel</h1></div>
      <section class="panel"><dl class="kv">
        <dt>Kernel ID</dt><dd>${esc(k)}</dd>
        <dt>In block</dt><dd><a href="${blockHref(b.height)}">${int(b.height)}</a> · ${esc(ago(b.ts))} · ${esc(utc(b.ts))}</dd>
        <dt>Fee</dt><dd>${kern.fee ? beam(kern.fee, 8) : '0'}</dd>
        <dt>Valid heights</dt><dd>${int(kern.min)} – ${int(kern.max)}</dd>
      </dl><p class="hint" style="margin:14px 0 0">A kernel proves a transaction happened; Beam keeps amounts and parties private, so there is nothing more to show.</p></section>
      ${await blockView(b, k)}`;
  };

  views.notfound = async () => notFound('This page');

  // ---------- status: footer pill and a banner while the node catches up ----------
  async function setStatus() {
    let st = null;
    try { st = normStatus(await get('status', 6000)); } catch (e) { st = null; }
    const pill = $('#foot-status'), txt = $('#foot-status-text'), banner = $('#sync-banner');
    const behind = st && st.ts ? Date.now() / 1000 - st.ts > 600 : true;
    pill.className = `pill-status ${!st ? 'off' : behind ? 'demo' : ''}`;
    txt.textContent = !st ? 'offline' : `${behind ? 'syncing' : 'live'}${st.height ? ` · ${int(st.height)}` : ''}`;
    banner.hidden = !(st && behind);
    if (st && behind) banner.innerHTML = `<b>Syncing.</b> Our explorer node is at block ${int(st.height)}${st.ts ? `, mined ${esc(ago(st.ts))}` : ''}; newer blocks appear once it catches up.`;
  }

  // ---------- search: block height or kernel ID ----------
  function search(q) {
    q = q.replace(/\s+/g, '').replace(/,/g, '');
    if (/^\d{1,10}$/.test(q)) return blockHref(q);
    if (hex(q, 64).length === 64) return kernelHref(q);
    return null;
  }

  // ---------- routing: clean paths over the History API ----------
  function parse() {
    const p = location.pathname.replace(/^\/+|\/+$/g, '');
    if (!p) return { route: 'home', arg: null };
    const [route, ...rest] = p.split('/');
    let arg = null;
    try { arg = rest.length ? decodeURIComponent(rest.join('/')) : null; } catch (e) { return { route: 'notfound', arg: null }; }
    return { route: ['block', 'kernel'].includes(route) && arg ? route : 'notfound', arg };
  }
  function go(path) {
    if (path !== location.pathname) history.pushState(null, '', path + location.search);
    render(true);
  }

  let seq = 0;
  async function render(scrollTop = true) {
    const { route, arg } = parse();
    const my = ++seq;
    document.querySelectorAll('#main-nav a[data-route]').forEach((a) => a.classList.toggle('active', a.dataset.route === route || (route === 'block' && a.dataset.route === 'home')));
    if (scrollTop && !view.innerHTML) view.innerHTML = '<div class="empty">Loading…</div>';
    try {
      const html = await views[route](arg);
      if (my !== seq) return;
      view.innerHTML = html;
      if (route === 'home') bindHome();
      if (scrollTop) window.scrollTo(0, 0);
    } catch (e) {
      if (my === seq) view.innerHTML = `<div class="panel empty err">Could not load: ${esc(e.message)}</div>`;
    }
    setStatus();
  }

  window.addEventListener('popstate', () => render(true));
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
    e.preventDefault();
    go(url.pathname);
  });
  $('#search').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#search-input'), q = input.value.trim();
    if (!q) return;
    const path = search(q);
    if (!path) { input.setCustomValidity('Enter a block height or a kernel ID'); input.reportValidity(); return; }
    input.value = '';
    input.blur();
    go(path);
  });
  $('#search-input').addEventListener('input', (e) => e.target.setCustomValidity(''));
  window.addEventListener('keydown', (e) => {
    const t = e.target, typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); $('#search-input').focus(); }
    else if (e.key === 'Escape' && t === $('#search-input')) t.blur();
  });
  // The latest blocks refresh every 30 s unless older ones were loaded.
  setInterval(() => {
    if (document.hidden || parse().route !== 'home' || ($('#hdr-body') && $('#hdr-body').children.length > PAGE)) return;
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    render(false);
  }, 30000);
  render(true);
})();
