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
  // Times are UTC by default and shown in the viewer's time zone when the browser tells us which
  // one it is (Intl); the zone is always labelled, and the UTC time is in the title.
  const TZ = (() => {
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!zone || /^(UTC|Etc\/(UTC|GMT|Universal|Zulu))$/i.test(zone)) return null;
      const label = (new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName') || {}).value;
      return { zone, label: label || zone };
    } catch (e) { return null; }
  })();
  function local(ts) {
    if (!ts) return '—';
    const d = new Date(ts * 1000), z = (n) => String(n).padStart(2, '0');
    if (!TZ) return `${d.getUTCFullYear()}-${z(d.getUTCMonth() + 1)}-${z(d.getUTCDate())} ${z(d.getUTCHours())}:${z(d.getUTCMinutes())}:${z(d.getUTCSeconds())} UTC`;
    const label = (() => { try { return (new Intl.DateTimeFormat('en-GB', { timeZone: TZ.zone, timeZoneName: 'short' }).formatToParts(d).find((x) => x.type === 'timeZoneName') || {}).value; } catch (e) { return ''; } })() || TZ.label;
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())} ${label}`;
  }
  const when = (ts) => `<span title="${esc(utc(ts))}">${esc(local(ts))}</span>`;
  const tile = (k, v, s = '', cls = '') => `<div class="tile"><div class="k">${k}</div><div class="v ${cls}">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
  const blockHref = (h) => `/block/${Math.round(Number(h) || 0)}`;
  const kernelHref = (k) => `/kernel/${hex(k)}`;

  // explorer-node answers one request at a time and slowly while it syncs, so wait long enough
  async function get(path, timeoutMs = 25000) {
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
      kernels: arr(b.kernels).map((k) => ({ id: hex(k && k.id), fee: num(k && k.fee), min: num(k && k.minHeight), max: num(k && k.maxHeight),
        extra: k && typeof k === 'object' ? Object.fromEntries(Object.entries(k).filter(([key]) => !['id', 'fee', 'minHeight', 'maxHeight'].includes(key))) : {} })),
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

  // ---------- the API's typed documents ----------
  // Contracts, assets and contract calls come as nested documents: plain values, objects, arrays,
  // and typed cells {type, value} where type is aid (asset ID), amount (groth, maybe signed), blob,
  // cid (contract ID), height, time, th (table header), table (rows) or group (a call with its
  // sub-calls). doc() renders any of it; IDs and heights become links.
  let assetIndex = null; // { at, byId: Map(aid -> {name, ticker, ...}), list }
  function meta(text) {
    const out = {};
    if (typeof text !== 'string' || !text.startsWith('STD:')) return out;
    for (const kv of text.slice(4).split(';')) { const i = kv.indexOf('='); if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1).slice(0, 200); }
    return out;
  }
  async function assets() {
    if (assetIndex && Date.now() - assetIndex.at < 600000) return assetIndex;
    const t = await get('assets');
    const rows = t && Array.isArray(t.value) ? t.value.slice(1) : [];
    const v = (c) => (c && typeof c === 'object' ? c.value : c);
    const list = rows.map((r) => { const m = meta(v(r[5])); return { aid: num(v(r[0])), owner: hex(v(r[1])), deposit: num(v(r[2])), supply: num(v(r[3])),
      lock: num(v(r[4])), name: m.N || '', ticker: m.SN || '', unit: m.UN || '', metaText: typeof v(r[5]) === 'string' ? v(r[5]).slice(0, 2000) : '' }; }).filter((a) => a.aid != null);
    assetIndex = { at: Date.now(), h: num(t && t.h), list, byId: new Map(list.map((a) => [a.aid, a])) };
    return assetIndex;
  }
  // BEAM itself (asset 0) is not in the API's asset list. Issued so far by the emission schedule:
  // 100 BEAM a block in year one, 50 in years two to five, then halving every four years
  // (miners and treasury together); 262,800,000 at most. Every amount on Beam, BEAM and assets
  // alike, is an integer count of 10^-8 units, so all of them have 8 decimals.
  const DECIMALS = 8, MAX_BEAM = 262800000;
  function beamIssued(h) {
    if (!h) return null;
    const Y = 525600, C = 4 * Y;
    let total = Math.min(h, Y) * 100, from = Y, per = 50;
    while (from < h && per >= 1e-8) { total += Math.min(h - from, C) * per; from += C; per /= 2; }
    return Math.round(total * GROTH);
  }
  const assetName = (aid) => (aid === 0 ? 'BEAM' : (assetIndex && assetIndex.byId.get(aid) && (assetIndex.byId.get(aid).ticker || assetIndex.byId.get(aid).name)) || `asset #${aid}`);
  const assetHref = (aid) => `/asset/${Math.round(Number(aid) || 0)}`;
  const contractHref = (cid) => `/contract/${hex(cid, 64)}`;
  function amount(v) {
    const s = String(v ?? ''), sign = /^[+-]/.test(s) ? s[0] : '', n = num(s.replace(/^[+-]/, ''));
    if (n == null) return esc(s.slice(0, 60));
    return `<span class="amt ${sign === '-' ? 'neg' : sign === '+' ? 'pos' : ''}">${sign}${(n / GROTH).toLocaleString('en-US', { maximumFractionDigits: 8 })}</span>`;
  }
  const isCell = (x) => x && typeof x === 'object' && !Array.isArray(x) && typeof x.type === 'string' && 'value' in x;
  function cell(c, colHead = '') {
    if (c == null || c === '') return '';
    if (typeof c === 'number') return /height/i.test(colHead) && Number.isInteger(c) && c >= 0 ? `<a href="${blockHref(c)}">${int(c)}</a>` : esc(c.toLocaleString('en-US', { maximumFractionDigits: 8 }));
    if (typeof c === 'boolean') return c ? 'yes' : 'no';
    if (typeof c === 'string') {
      const m = meta(c);
      if (m.N || m.SN) return `<span title="${esc(c.slice(0, 2000))}">${esc(m.N || m.SN)}${m.SN && m.N ? ` <span class="dim">${esc(m.SN)}</span>` : ''}</span>`;
      return esc(c.slice(0, 2000));
    }
    if (Array.isArray(c)) return c.every(Array.isArray) ? table({ value: c }, true) : c.map((x) => cell(x, colHead)).join(', ');
    if (isCell(c)) {
      const v = c.value;
      switch (c.type) {
        case 'aid': { const a = num(v); return a == null ? '' : `<a href="${assetHref(a)}">${esc(assetName(a))}</a>`; }
        case 'amount': return amount(v);
        case 'blob': { const h = hex(v, 200); return `<span class="mono dim" title="${esc(h)}">${esc(short(h, 8, 6))}</span>`; }
        case 'cid': { const h = hex(v, 64); return h ? `<a class="mono" href="${contractHref(h)}" title="${esc(h)}">${esc(short(h, 8, 6))}</a>` : ''; }
        case 'height': { const h = num(v); return h == null ? '' : `<a href="${blockHref(h)}">${int(h)}</a>`; }
        case 'time': return esc(utc(num(v)));
        case 'table': return table(c, true);
        case 'group': return table({ value: v }, true);
        default: return cell(v, colHead);
      }
    }
    return obj(c);
  }
  function obj(o) {
    const entries = Object.entries(o).filter(([k]) => k !== 'more' && k !== 'h');
    if (!entries.length) return '';
    return `<dl class="kv">${entries.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${cell(v, k)}</dd>`).join('')}</dl>`;
  }
  const isHead = (row) => Array.isArray(row) && row.length && row.every((x) => isCell(x) && x.type === 'th');
  // table rows; a group is one call and its sub-calls, drawn as one block of rows
  function bodyRows(rows, heads) {
    return rows.map((row) => {
      if (isCell(row) && row.type === 'group' && Array.isArray(row.value)) {
        return row.value.map((r, i) => `<tr class="${i ? 'grp-sub' : 'grp-first'}">${(Array.isArray(r) ? r : [r]).map((c, j) => `<td>${cell(c, heads[j])}</td>`).join('')}</tr>`).join('');
      }
      return `<tr>${(Array.isArray(row) ? row : [row]).map((c, j) => `<td>${cell(c, heads[j])}</td>`).join('')}</tr>`;
    }).join('');
  }
  function table(t, nested = false, bodyId = '') {
    const rows = Array.isArray(t && t.value) ? t.value.slice(0, 5000) : [];
    const head = isHead(rows[0]) ? rows[0].map((h) => String(h.value)) : [];
    const body = head.length ? rows.slice(1) : rows;
    if (!body.length) return nested ? '' : '<div class="empty">Nothing here</div>';
    const html = `<table class="${nested ? 'nested' : 'doc'}">${head.length ? `<thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>` : ''}<tbody${bodyId ? ` id="${bodyId}"` : ''}>${bodyRows(body, head)}</tbody></table>`;
    return nested ? html : `<div class="table-wrap">${html}</div>`;
  }
  // A section of a document; a table that has older rows gets a "load older" button.
  function section(title, v, pager = null) {
    const id = `t${Math.random().toString(36).slice(2, 8)}`;
    const more = isCell(v) && v.type === 'table' && v.more && num(v.more.hMax);
    const body = isCell(v) && v.type === 'table' ? table(v, false, id) : `<div class="doc-obj">${cell(v)}</div>`;
    return `<section class="panel"><div class="panel-head"><h2 class="panel-title">${esc(title)}</h2></div>${body}
      ${pager && more != null ? `<div class="more"><button class="btn ghost" data-pager="${esc(pager)}" data-hmax="${more}" data-body="${id}" data-title="${esc(title)}">Load older</button></div>` : ''}</section>`;
  }
  // Contracts found by kind in the contract list (their IDs could change with an upgrade).
  let contractIx = null;
  async function contractsByKind() {
    if (contractIx && Date.now() - contractIx.at < 600000) return contractIx;
    const t = await get('contracts');
    const rows = isCell(t) && Array.isArray(t.value) ? t.value.slice(1) : [];
    const v = (c) => (isCell(c) ? c.value : c);
    const list = rows.map((r) => ({ cid: hex(v(r[0]), 64), kind: typeof r[1] === 'string' ? r[1] : '', locked: isCell(r[3]) && Array.isArray(r[3].value) ? r[3].value : [] }));
    contractIx = { at: Date.now(), list };
    return contractIx;
  }
  const findKind = async (re) => ((await contractsByKind()).list.find((c) => re.test(c.kind)) || {}).cid || '';
  const stateOf = (cid) => get(`contract?id=${cid}&nMaxTxs=0&funds_locked=0&assets_owned=0&ver_info=0`);
  const rowsOf = (t) => (isCell(t) && Array.isArray(t.value) ? t.value.slice(1).filter(Array.isArray) : []);
  const cv = (c) => (isCell(c) ? c.value : c);

  let dexCache = null;
  async function dexPools() {
    if (dexCache && Date.now() - dexCache.at < 60000) return dexCache;
    const cid = await findKind(/^DEX\b/);
    if (!cid) return { at: Date.now(), cid: '', pools: [] };
    const d = await stateOf(cid);
    const pools = rowsOf(d && d.State && d.State.Pools).map((r) => ({
      a1: num(cv(r[0])), a2: num(cv(r[1])), vol: typeof r[2] === 'string' ? r[2] : '', lp: num(cv(r[3])),
      r1: num(String(cv(r[4]))), r2: num(String(cv(r[5]))), lpSupply: num(String(cv(r[6]))), rate12: num(cv(r[7])), rate21: num(cv(r[8])),
    })).filter((x) => x.a1 != null && x.a2 != null);
    dexCache = { at: Date.now(), cid, pools };
    return dexCache;
  }
  const FEE_TIER = { Low: '0.05%', Medium: '0.3%', High: '1%' };
  function poolRows(pools) {
    return pools.map((x) => `<tr><td><a href="${assetHref(x.a1)}">${esc(assetName(x.a1))}</a> / <a href="${assetHref(x.a2)}">${esc(assetName(x.a2))}</a></td>
      <td class="dim">${esc(x.vol)}${FEE_TIER[x.vol] ? ` · ${FEE_TIER[x.vol]}` : ''}</td>
      <td class="num">${amount(x.r1)} <span class="dim">${esc(assetName(x.a1))}</span></td><td class="num">${amount(x.r2)} <span class="dim">${esc(assetName(x.a2))}</span></td>
      <td class="num">${x.rate12 != null ? `${esc(x.rate12.toLocaleString('en-US', { maximumSignificantDigits: 6 }))}` : '—'}</td>
      <td>${x.lp != null ? `<a href="${assetHref(x.lp)}">${esc(assetName(x.lp))}</a>` : '—'}</td></tr>`).join('');
  }
  const poolTable = (pools) => `<div class="table-wrap"><table><thead><tr><th>Pair</th><th>Volatility · fee</th><th class="num">Reserve 1</th><th class="num">Reserve 2</th><th class="num">Rate 1:2</th><th>LP token</th></tr></thead><tbody>${poolRows(pools)}</tbody></table></div>`;

  let bansCache = null;
  async function bansNames() {
    if (bansCache && Date.now() - bansCache.at < 120000) return bansCache;
    const cid = await findKind(/^Bans\b/);
    if (!cid) return { at: Date.now(), cid: '', h: null, names: [] };
    const d = await stateOf(cid);
    const names = rowsOf(d && d.State && d.State.Domains).map((r) => ({
      name: typeof r[0] === 'string' ? r[0].slice(0, 64) : '', owner: hex(cv(r[1]), 80), exp: num(cv(r[2])),
      status: typeof r[3] === 'string' && r[3] ? r[3] : 'Active',
      price: Array.isArray(r[4]) && r[4].length === 2 ? { aid: num(cv(r[4][0])), amount: num(String(cv(r[4][1]))) } : null,
    })).filter((x) => x.name);
    bansCache = { at: Date.now(), cid, h: num(d && d.h), names };
    return bansCache;
  }

  // the "load older" buttons on asset and contract pages
  view.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-pager]');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = 'Loading…';
    try {
      const d = await get(`${btn.dataset.pager}&hMax=${Number(btn.dataset.hmax)}`);
      const t = d && d[btn.dataset.title];
      const rows = isCell(t) && Array.isArray(t.value) ? t.value : [];
      const heads = isHead(rows[0]) ? rows[0].map((h) => String(h.value)) : [];
      document.getElementById(btn.dataset.body).insertAdjacentHTML('beforeend', bodyRows(heads.length ? rows.slice(1) : rows, heads));
      const more = t && t.more && num(t.more.hMax);
      if (more == null) btn.remove();
      else { btn.dataset.hmax = String(more); btn.disabled = false; btn.textContent = 'Load older'; }
    } catch (err) {
      btn.textContent = 'Could not load';
    }
  });

  // ---------- views ----------
  const views = {};

  function hdrRows(rows) {
    return rows.map((b) => `<tr><td><a href="${blockHref(b.height)}">${int(b.height)}</a></td><td class="dim nowrap">${when(b.ts)}</td><td class="dim">${ago(b.ts)}</td>
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
        ${tile('Peers', `<a href="/peers">${int(st.peers)}</a>`, 'connected to our node')}
        ${tile('Shielded outputs 24h', int(st.shielded24h), `${int(st.shieldedTotal)} in total`)}
      </div>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Latest blocks</h2><div class="panel-meta"><span>Outputs / inputs are Mimblewimble UTXOs</span></div></div>
        ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Height</th><th>Time</th><th>Age</th><th>Hash</th><th class="num">Difficulty</th><th class="num">Txs</th><th class="num">Out / in</th><th class="num">Fees</th></tr></thead>
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
    const withExtra = b.kernels.filter((k) => Object.keys(k.extra).length);
    if (withExtra.length) await assets().catch(() => null);
    const calls = withExtra.length ? `<section class="panel"><div class="panel-head"><h2 class="panel-title">Contract calls and other kernel data</h2></div>
      ${withExtra.map((k) => `<div class="doc-kernel"><div class="dim mono" style="font-size:11px;margin:4px 0 6px">kernel <a href="${kernelHref(k.id)}">${esc(short(k.id, 16, 12))}</a></div>
        ${Object.entries(k.extra).map(([name, v]) => (isCell(v) && v.type === 'table' ? table(v) : `<dl class="kv"><dt>${esc(name)}</dt><dd>${cell(v, name)}</dd></dl>`)).join('')}</div>`).join('')}</section>` : '';
    const coinbase = b.outputs.filter((o) => o.coinbase).reduce((s, o) => s + (o.value || 0), 0);
    const kRows = b.kernels.map((k) => `<tr class="${k.id && k.id === hit ? 'hit' : ''}"><td class="mono"><a href="${kernelHref(k.id)}">${esc(short(k.id, 16, 12))}</a></td>
      <td class="num">${k.fee ? beam(k.fee, 8) : '0'}</td><td class="num dim">${int(k.min)}</td><td class="num dim">${int(k.max)}</td><td>${Object.keys(k.extra).length ? '<span class="badge solo">contract</span>' : ''}</td></tr>`).join('');
    const iRows = b.inputs.map((i) => `<tr><td class="mono dim">${esc(short(i.commitment, 16, 12))}</td><td class="num">${i.height ? `<a href="${blockHref(i.height)}">${int(i.height)}</a>` : '—'}</td></tr>`).join('');
    const oRows = b.outputs.map((o) => `<tr><td class="mono dim">${esc(short(o.commitment, 16, 12))}</td>
      <td>${o.coinbase ? '<span class="badge ok">coinbase</span>' : '<span class="dim">confidential</span>'}</td>
      <td class="num">${o.coinbase && o.value != null ? beam(o.value, 4) : '—'}</td><td class="num dim">${o.maturity ? int(o.maturity) : '—'}</td>
      <td class="num">${o.spent ? `<a href="${blockHref(o.spent)}">${int(o.spent)}</a>` : '<span class="dim">unspent</span>'}</td></tr>`).join('');
    return `<div class="page-head"><h1 class="page-title">Block ${int(b.height)}</h1>
        <div class="actions pager">${b.height > 0 ? `<a class="btn ghost small" href="${blockHref(b.height - 1)}">← ${int(b.height - 1)}</a>` : ''}<a class="btn ghost small" href="${blockHref(b.height + 1)}">${int(b.height + 1)} →</a></div></div>
      <div class="tiles">
        ${tile('Mined', esc(local(b.ts)).replace(' ', '<br>'), `${esc(ago(b.ts))} · ${esc(utc(b.ts))}`)}
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
        ${kRows ? `<div class="table-wrap"><table><thead><tr><th>Kernel ID</th><th class="num">Fee</th><th class="num">Min height</th><th class="num">Max height</th><th></th></tr></thead><tbody>${kRows}</tbody></table></div>` : '<div class="empty">No kernels</div>'}</section>
      ${calls}
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
        <dt>In block</dt><dd><a href="${blockHref(b.height)}">${int(b.height)}</a> · ${when(b.ts)} · ${esc(ago(b.ts))}</dd>
        <dt>Fee</dt><dd>${kern.fee ? beam(kern.fee, 8) : '0'}</dd>
        <dt>Valid heights</dt><dd>${int(kern.min)} – ${int(kern.max)}</dd>
      </dl><p class="hint" style="margin:14px 0 0">A kernel proves a transaction happened; Beam keeps amounts and parties private, so there is nothing more to show.</p></section>
      ${await blockView(b, k)}`;
  };

  const ASSET_PAGE = 50, CALLS_PAGE = 50;

  views.assets = async (filter) => {
    const ix = await assets();
    const q = String(filter || '').toLowerCase();
    const beamRow = { aid: 0, name: 'Beam', ticker: 'BEAM', unit: 'BEAM', supply: beamIssued(ix.h), deposit: null, owner: '', native: true };
    const all = [beamRow, ...ix.list];
    const list = q ? all.filter((a) => [a.name, a.ticker, a.unit].some((x) => x && x.toLowerCase().includes(q))) : all;
    const rows = list.map((a) => `<tr><td><a href="${assetHref(a.aid)}">#${int(a.aid)}</a></td><td><a href="${assetHref(a.aid)}">${esc(a.name || '—')}</a></td><td>${esc(a.ticker)}</td>
      <td class="num">${amount(a.supply)}${a.native ? ' <span class="dim">issued</span>' : ''}</td><td class="num dim">${DECIMALS}</td>
      <td class="num dim">${a.native ? 'native coin' : amount(a.deposit)}</td><td class="mono dim" title="${esc(a.owner)}">${a.native ? '—' : esc(short(a.owner, 8, 6))}</td></tr>`).join('');
    return `<div class="page-head"><h1 class="page-title">${q ? `Assets matching “${esc(filter)}”` : 'Assets'}</h1></div>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Confidential assets</h2><div class="panel-meta"><span>${int(list.length)} of ${int(all.length)}</span></div></div>
      <p class="hint">Tokens issued on Beam, each with an asset ID. Balances and transfers stay private like BEAM's; supply, issuer key and history are public.</p>
      ${rows ? `<div class="table-wrap"><table><thead><tr><th>ID</th><th>Name</th><th>Ticker</th><th class="num">Supply</th><th class="num">Decimals</th><th class="num">Deposit (BEAM)</th><th>Owner key</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">No assets match</div>'}</section>`;
  };

  views.asset = async (arg) => {
    if (!/^\d{1,10}$/.test(arg || '')) return notFound(`Asset ${String(arg || '').slice(0, 40)}`);
    const aid = Number(arg);
    if (aid === 0) return beamView();
    const pager = `asset?id=${aid}&nMaxOps=${ASSET_PAGE}`;
    const [d, ix, dex] = await Promise.all([get(pager), assets().catch(() => null), dexPools().catch(() => null)]);
    const pools = dex ? dex.pools.filter((x) => (x.a1 === aid || x.a2 === aid || x.lp === aid) && (x.r1 || x.r2)) : [];
    const hist = d && d['Asset history'], a = ix && ix.byId.get(aid);
    if (!a && !(isCell(hist) && Array.isArray(hist.value) && hist.value.length > 1)) return notFound(`Asset ${aid}`);
    const m = a ? meta(a.metaText) : {};
    const sections = Object.entries(d || {}).filter(([k]) => k !== 'h').map(([k, v]) => section(k, v, k === 'Asset history' ? pager : null)).join('');
    return `<div class="page-head"><h1 class="page-title">${esc((a && (a.name || a.ticker)) || `Asset #${aid}`)}</h1><div class="actions"><a class="btn ghost small" href="/assets">all assets</a></div></div>
      <div class="tiles">
        ${tile('Asset ID', `#${int(aid)}`, esc(a && a.ticker ? a.ticker : ''), 'accent')}
        ${tile('Supply', a ? amount(a.supply) : '—', esc(a && a.unit ? a.unit : ''))}
        ${tile('Deposit', a ? `${amount(a.deposit)} BEAM` : '—', 'locked by the issuer')}
        ${tile('Decimals', String(DECIMALS), 'amounts in 10⁻⁸ units, as BEAM')}
        ${tile('Lock height', a && a.lock ? `<a href="${blockHref(a.lock)}">${int(a.lock)}</a>` : '—')}
      </div>
      ${pools.length ? `<section class="panel"><div class="panel-head"><h2 class="panel-title">DEX pools</h2><div class="panel-meta"><a href="/dex">all pools →</a></div></div>${poolTable(pools)}</section>` : ''}
      ${a ? `<section class="panel"><dl class="kv"><dt>Owner key</dt><dd>${esc(a.owner) || '—'}</dd>${Object.entries(m).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></section>` : ''}
      ${sections}`;
  };

  views.contracts = async () => {
    const [t] = await Promise.all([get('contracts'), assets().catch(() => null)]);
    const n = isCell(t) && Array.isArray(t.value) ? t.value.length - 1 : 0;
    return `<div class="page-head"><h1 class="page-title">Contracts</h1></div>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Deployed contracts</h2><div class="panel-meta"><span>${int(Math.max(0, n))}</span></div></div>
      <p class="hint">Beam's smart contracts (shaders): DApps such as the DEX, DAO vaults and the Nephrite stablecoin, with the funds they hold.</p>
      ${table(t)}</section>`;
  };

  views.contract = async (arg) => {
    const cid = hex(arg, 64);
    if (cid.length !== 64) return notFound(`Contract ${String(arg || '').slice(0, 80)}`);
    const pager = `contract?id=${cid}&nMaxTxs=${CALLS_PAGE}&state=0&assets_owned=0&funds_locked=0&ver_info=0`;
    const [d] = await Promise.all([get(`contract?id=${cid}&nMaxTxs=${CALLS_PAGE}`), assets().catch(() => null)]);
    const ver = d && d['Version History'];
    const versions = isCell(ver) && Array.isArray(ver.value) ? ver.value.slice(1) : [];
    if (!versions.length) return notFound(`Contract ${short(cid)}`);
    const first = versions[versions.length - 1], deployed = num(isCell(first[0]) ? first[0].value : first[0]);
    const order = ['State', 'Locked Funds', 'Owned assets', 'Version History', 'Calls history'];
    const keys = Object.keys(d).filter((k) => !['h', 'kind'].includes(k)).sort((x, y) => (order.indexOf(x) + 99) % 99 - (order.indexOf(y) + 99) % 99);
    return `<div class="page-head"><h1 class="page-title">${esc(typeof d.kind === 'string' ? d.kind.slice(0, 80) : 'Contract')}</h1><div class="actions"><a class="btn ghost small" href="/contracts">all contracts</a></div></div>
      <div class="tiles">
        ${tile('Kind', esc(typeof d.kind === 'string' ? d.kind.slice(0, 80) : 'unknown'), 'decoded by Beam\'s explorer parser', 'accent')}
        ${tile('Deployed', deployed != null ? `<a href="${blockHref(deployed)}">${int(deployed)}</a>` : '—', `${int(versions.length)} version${versions.length === 1 ? '' : 's'}`)}
      </div>
      <section class="panel"><dl class="kv"><dt>Contract ID</dt><dd>${esc(cid)}</dd></dl></section>
      ${keys.map((k) => section(k, d[k], k === 'Calls history' ? pager : null)).join('')}`;
  };

  async function beamView() {
    const [ix, cs, dex, st] = await Promise.all([assets().catch(() => null), contractsByKind().catch(() => null), dexPools().catch(() => null), get('status').catch(() => null)]);
    const h = (st && num(st.height)) || (ix && ix.h);
    const issued = beamIssued(h);
    const locked = cs ? cs.list.reduce((sum, c) => sum + c.locked.filter((r) => Array.isArray(r) && num(cv(r[0])) === 0).reduce((t, r) => t + (num(String(cv(r[1]))) || 0), 0), 0) : null;
    const pools = dex ? dex.pools.filter((x) => (x.a1 === 0 || x.a2 === 0) && (x.r1 || x.r2)) : [];
    return `<div class="page-head"><h1 class="page-title">Beam</h1><div class="actions"><a class="btn ghost small" href="/assets">all assets</a></div></div>
      <div class="tiles">
        ${tile('Asset ID', '#0', 'BEAM, the native coin', 'accent')}
        ${tile('Issued', amount(issued), `of ${int(MAX_BEAM)} max, by the emission schedule`)}
        ${tile('Decimals', String(DECIMALS), '1 BEAM = 10⁸ groth')}
        ${tile('Locked in contracts', locked != null ? amount(locked) : '—', 'DEX, DAO, Nephrite and the rest')}
      </div>
      <section class="panel"><p class="hint" style="margin:0">BEAM is emitted with every block: 100 a block in the first year, 50 in years two to five, then half
        as much every four years, shared between the miner and, until year five, the treasury. Balances are private; what contracts hold is public.</p></section>
      ${pools.length ? `<section class="panel"><div class="panel-head"><h2 class="panel-title">DEX pools with BEAM</h2><div class="panel-meta"><a href="/dex">all pools →</a></div></div>${poolTable(pools)}</section>` : ''}`;
  }

  views.dex = async () => {
    const [dex] = await Promise.all([dexPools(), assets().catch(() => null)]);
    if (!dex.cid) return notFound('The DEX contract');
    const live = dex.pools.filter((x) => x.r1 || x.r2).sort((x, y) => (y.a1 === 0 ? y.r1 : 0) - (x.a1 === 0 ? x.r1 : 0));
    return `<div class="page-head"><h1 class="page-title">DEX pools</h1><div class="actions"><a class="btn ghost small" href="${contractHref(dex.cid)}">the DEX contract</a></div></div>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Liquidity pools</h2><div class="panel-meta"><span>${int(live.length)} with liquidity, ${int(dex.pools.length - live.length)} empty</span></div></div>
      <p class="hint">Beam's on-chain DEX: each pool holds two assets at a fee tier (Low 0.05%, Medium 0.3%, High 1%). Rates are as the contract reports them.</p>
      ${live.length ? poolTable(live) : '<div class="empty">No pools with liquidity</div>'}</section>`;
  };

  let namesAll = false;
  view.addEventListener('click', (e) => { if (e.target.closest('[data-names-all]')) { namesAll = !namesAll; render(false); } });
  views.names = async (filter) => {
    const [b, st] = await Promise.all([bansNames(), get('status').catch(() => null)]);
    if (!b.cid) return notFound('The name service contract');
    const tip = (st && num(st.height)) || b.h;
    const q = String(filter || '').toLowerCase();
    const showAll = q || namesAll;
    const order = { Active: 0, 'On Hold': 1, Expired: 2 };
    const list = b.names.filter((x) => (q ? x.name.toLowerCase().includes(q) : showAll || x.status !== 'Expired'))
      .sort((x, y) => (order[x.status] ?? 3) - (order[y.status] ?? 3) || x.name.localeCompare(y.name));
    const badge = (s) => `<span class="badge ${s === 'Active' ? 'ok' : s === 'Expired' ? 'bad' : 'pending'}">${esc(s)}</span>`;
    const expires = (x) => (x.exp ? `<a href="${blockHref(x.exp)}">${int(x.exp)}</a>${tip ? ` <span class="dim">≈ ${esc(local(Date.now() / 1000 + (x.exp - tip) * 60).slice(0, 10))}</span>` : ''}` : '—');
    const rows = list.map((x) => `<tr><td class="mono">${esc(x.name)}</td><td>${badge(x.status)}</td><td class="num">${expires(x)}</td>
      <td class="num">${x.price ? `${amount(x.price.amount)} <span class="dim">${esc(assetName(x.price.aid))}</span>` : ''}</td><td class="mono dim" title="${esc(x.owner)}">${esc(short(x.owner, 8, 6))}</td></tr>`).join('');
    const counts = b.names.reduce((m, x) => ((m[x.status] = (m[x.status] || 0) + 1), m), {});
    return `<div class="page-head"><h1 class="page-title">${q ? `Names matching “${esc(filter)}”` : 'Names'}</h1><div class="actions"><a class="btn ghost small" href="${contractHref(b.cid)}">the BANS contract</a></div></div>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Beam Anonymous Name Service</h2>
        <div class="panel-meta"><span>Active <b>${int(counts.Active || 0)}</b></span><span>On hold <b>${int(counts['On Hold'] || 0)}</b></span><span>Expired <b>${int(counts.Expired || 0)}</b></span>
          ${q ? '' : `<button type="button" class="btn ghost small" data-names-all>${showAll ? 'hide expired' : 'show expired'}</button>`}</div></div>
      <p class="hint">Names registered in BANS, owned by a key and renewed by period. Expiry dates are estimated from one block a minute.</p>
      ${rows ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Status</th><th class="num">Expires at block</th><th class="num">For sale</th><th>Owner key</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty">No names match</div>'}</section>`;
  };

  views.peers = async () => {
    const list = await get('peers');
    const peers = (Array.isArray(list) ? list : []).filter((p) => typeof p === 'string').map((p) => {
      const m = p.slice(0, 80).match(/^\[?([^\]]+?)\]?:(\d+)$/);
      return m ? { ip: m[1], port: Number(m[2]) } : { ip: p.slice(0, 80), port: null };
    });
    const key = (ip) => (/^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip.split('.').map((n) => n.padStart(3, '0')).join('.') : `z${ip}`);
    peers.sort((x, y) => key(x.ip).localeCompare(key(y.ip)) || (x.port || 0) - (y.port || 0));
    return `<div class="page-head"><h1 class="page-title">Peers</h1></div>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Nodes our node knows</h2><div class="panel-meta"><span>${int(peers.length)}</span></div></div>
      ${peers.length ? `<div class="table-wrap"><table class="peer-table"><thead><tr><th>#</th><th>IP address</th><th class="num">Port</th></tr></thead><tbody>
        ${peers.map((x, i) => `<tr><td class="dim">${i + 1}</td><td class="mono">${esc(x.ip)}</td><td class="num mono">${x.port != null ? int(x.port).replace(/,/g, '') : '—'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No peers</div>'}</section>`;
  };

  views.notfound = async () => notFound('This page');

  // ---------- status: footer pill and a banner while the node catches up ----------
  async function setStatus() {
    let st = null;
    try { st = normStatus(await get('status')); } catch (e) { st = null; }
    const pill = $('#foot-status'), txt = $('#foot-status-text'), banner = $('#sync-banner');
    const behind = st && st.ts ? Date.now() / 1000 - st.ts > 600 : true;
    pill.className = `pill-status ${!st ? 'off' : behind ? 'demo' : ''}`;
    txt.textContent = !st ? 'offline' : `${behind ? 'syncing' : 'live'}${st.height ? ` · ${int(st.height)}` : ''}`;
    banner.hidden = !(st && behind);
    if (st && behind) banner.innerHTML = `<b>Syncing.</b> Our explorer node is at block ${int(st.height)}${st.ts ? `, mined ${esc(ago(st.ts))}` : ''}; newer blocks appear once it catches up.`;
  }

  // ---------- search: block height, kernel or contract ID, asset number, name or ticker ----------
  async function search(raw) {
    const q = raw.trim(), compact = q.replace(/[\s,]+/g, '');
    if (/^\d{1,10}$/.test(compact)) return blockHref(compact);
    const a = q.match(/^(?:asset\s*|#|a)(\d{1,10})$/i);
    if (a) return assetHref(a[1]);
    const h = hex(compact, 64);
    if (h.length === 64) {
      try {
        const b = normBlock(await get(`block?kernel=${h}`));
        if (b && b.kernels.some((x) => x.id === h)) return kernelHref(h);
        const c = await get(`contract?id=${h}&nMaxTxs=1&state=0&assets_owned=0&funds_locked=0`);
        const ver = c && c['Version History'];
        if (isCell(ver) && Array.isArray(ver.value) && ver.value.length > 1) return contractHref(h);
      } catch (e) { /* not found below */ }
      return kernelHref(h);
    }
    if (q.length >= 2 && q.length <= 60) {
      try {
        const ix = await assets(), l = q.toLowerCase();
        if (l === 'beam') return assetHref(0);
        const exact = ix.list.filter((x) => [x.ticker, x.unit, x.name].some((y) => y && y.toLowerCase() === l));
        if (exact.length === 1) return assetHref(exact[0].aid);
        const b = await bansNames().catch(() => null);
        if (b && b.names.some((x) => x.name.toLowerCase() === l)) return `/names/${encodeURIComponent(q)}`;
        return `/assets/${encodeURIComponent(q)}`;
      } catch (e) { return null; }
    }
    return null;
  }

  // ---------- routing: clean paths over the History API ----------
  function parse() {
    const p = location.pathname.replace(/^\/+|\/+$/g, '');
    if (!p) return { route: 'home', arg: null };
    const [route, ...rest] = p.split('/');
    let arg = null;
    try { arg = rest.length ? decodeURIComponent(rest.join('/')) : null; } catch (e) { return { route: 'notfound', arg: null }; }
    if (['assets', 'contracts', 'peers', 'dex', 'names'].includes(route)) return { route, arg };
    return { route: ['block', 'kernel', 'asset', 'contract'].includes(route) && arg ? route : 'notfound', arg };
  }
  function go(path) {
    if (path !== location.pathname) history.pushState(null, '', path + location.search);
    render(true);
  }

  let seq = 0;
  async function render(scrollTop = true) {
    const { route, arg } = parse();
    const my = ++seq;
    document.querySelectorAll('#main-nav a[data-route]').forEach((a) => a.classList.toggle('active', a.dataset.route === route || (['block', 'kernel', 'peers'].includes(route) && a.dataset.route === 'home') || (route === 'asset' && a.dataset.route === 'assets') || (route === 'names' && a.dataset.route === 'names') || (route === 'dex' && a.dataset.route === 'dex') || (route === 'contract' && a.dataset.route === 'contracts')));
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
    const path = await search(q);
    if (!path) { input.setCustomValidity('Enter a block height, a kernel or contract ID, or an asset name'); input.reportValidity(); return; }
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
