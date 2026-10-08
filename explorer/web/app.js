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
  // every hash, key and ID is shortened the same way, on both sites: first 8 … last 8
  const short = (s) => (s && s.length > 17 ? `${s.slice(0, 8)}…${s.slice(-8)}` : s || '—');
  // a shortened value that is not a link copies its full form on click
  const copyHash = (h) => (h ? `<span class="mono dim copy" data-copy="${esc(h)}">${esc(short(h))}</span>` : '—');
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
  // columns: height, hash, time, difficulty, fee, txs, MW outputs, MW inputs, shielded outputs,
  // shielded inputs, contract calls
  function normHdrs(t, limit = PAGE) {
    const rows = t && Array.isArray(t.value) ? t.value.slice(1, limit + 1) : [];
    const v = (c) => (c && typeof c === 'object' ? c.value : c);
    return rows.map((r) => ({ height: num(v(r[0])), hash: hex(v(r[1])), ts: num(v(r[2])), difficulty: num(v(r[3])), fee: num(v(r[4])),
      txs: num(v(r[5])), outputs: num(v(r[6])), inputs: num(v(r[7])), shOut: num(v(r[8])), shIn: num(v(r[9])), calls: num(v(r[10])) })).filter((r) => r.height != null);
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
    for (const kv of text.slice(4).split(';')) { const i = kv.indexOf('='); if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1).slice(0, 1000); }
    return out;
  }
  async function assets() {
    if (assetIndex && Date.now() - assetIndex.at < 600000) return assetIndex;
    const t = await get('assets');
    const rows = t && Array.isArray(t.value) ? t.value.slice(1) : [];
    const v = (c) => (c && typeof c === 'object' ? c.value : c);
    const list = rows.map((r) => { const m = meta(v(r[5])); return { aid: num(v(r[0])), owner: hex(v(r[1])), deposit: num(v(r[2])), supply: num(v(r[3])), ratio: m.NTH_RATIO != null ? num(m.NTH_RATIO) : null,
      lock: num(v(r[4])), name: m.N || '', ticker: m.SN || '', unit: m.UN || '', metaText: typeof v(r[5]) === 'string' ? v(r[5]).slice(0, 2000) : '' }; }).filter((a) => a.aid != null);
    assetIndex = { at: Date.now(), h: num(t && t.h), list, byId: new Map(list.map((a) => [a.aid, a])) };
    return assetIndex;
  }
  // BEAM itself (asset 0) is not in the API's asset list. Issued so far by the emission schedule:
  // 100 BEAM a block in year one, 50 in years two to five, then halving every four years
  // (miners and treasury together); 262,800,000 at most. Every amount on Beam, BEAM and assets
  // alike, is an integer count of 10^-8 units, so all of them have 8 decimals.
  const DECIMALS = 8, MAX_BEAM = 262800000;
  // An asset's precision is its metadata's NTH_RATIO (smallest units per unit); without one, Beam
  // wallets use 10^8 like BEAM. Every amount of an asset is scaled by its own ratio.
  function scaleOf(aid) {
    if (aid == null || aid === 0) return GROTH;
    const a = assetIndex && assetIndex.byId.get(aid);
    return a && a.ratio > 0 ? a.ratio : GROTH;
  }
  function decimalsOf(a) {
    if (!a || a.ratio == null) return { text: String(DECIMALS), note: 'Beam default, no NTH_RATIO' };
    if (a.ratio === 0) return { text: '—', note: 'NTH_RATIO is 0' };
    const d = Math.log10(a.ratio);
    if (Number.isInteger(d)) return { text: String(d), note: `NTH_RATIO ${int(a.ratio)}` };
    return { text: `1/${int(a.ratio)}`, note: 'NTH_RATIO is not a power of ten' };
  }
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
  function amount(v, scale = GROTH) {
    const s = String(v ?? ''), sign = /^[+-]/.test(s) ? s[0] : '', n = num(s.replace(/^[+-]/, ''));
    if (n == null) return esc(s.slice(0, 60));
    const digits = Math.min(12, Math.max(0, Math.ceil(Math.log10(scale || 1))));
    return `<span class="amt ${sign === '-' ? 'neg' : sign === '+' ? 'pos' : ''}">${sign}${(n / (scale || 1)).toLocaleString('en-US', { maximumFractionDigits: digits })}</span>`;
  }
  const amountOf = (v, aid) => amount(v, scaleOf(aid));
  // tiles have little room: whole numbers with two decimals at most
  function amountTile(v, scale = GROTH) {
    const n = num(String(v ?? '').replace(/^[+-]/, ''));
    if (n == null) return '—';
    const x = n / (scale || 1);
    return `<span class="amt">${x.toLocaleString('en-US', { maximumFractionDigits: x >= 1 ? 2 : Math.min(12, Math.ceil(Math.log10(scale || 1))) })}</span>`;
  }
  const safeUrl = (u) => (typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/.test(u) ? u : '');
  function metaLinks(m) {
    return [['Site', m.OPT_SITE_URL], ['Docs', m.OPT_PDF_URL]].map(([l, u]) => safeUrl(u) && `<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener">${l}</a>`).filter(Boolean).join(' · ');
  }
  // an asset's metadata in a table: name and ticker, the short description, and the long one with
  // links behind more / less
  function metaCell(m) {
    const name = `${esc(m.N || m.SN)}${m.SN && m.N && m.SN !== m.N ? ` <span class="dim">${esc(m.SN)}</span>` : ''}`;
    const links = metaLinks(m), long = m.OPT_LONG_DESC && m.OPT_LONG_DESC !== m.OPT_SHORT_DESC ? m.OPT_LONG_DESC : '';
    return `<div class="meta-cell"><div>${name}</div>${m.OPT_SHORT_DESC ? `<div class="dim small wrap">${esc(m.OPT_SHORT_DESC)}</div>` : ''}${long || links ? `<div class="meta-long wrap" hidden>${long ? `<div>${esc(long)}</div>` : ''}${links ? `<div class="small">${links}</div>` : ''}</div><button type="button" class="link-btn" data-more>more</button>` : ''}</div>`;
  }
  const isCell = (x) => x && typeof x === 'object' && !Array.isArray(x) && typeof x.type === 'string' && 'value' in x;
  function cell(c, colHead = '', scale = GROTH) {
    if (c == null || c === '') return '';
    if (typeof c === 'number') return /height/i.test(colHead) && Number.isInteger(c) && c >= 0 ? `<a href="${blockHref(c)}">${int(c)}</a>` : esc(c.toLocaleString('en-US', { maximumFractionDigits: 8 }));
    if (typeof c === 'boolean') return c ? 'yes' : 'no';
    if (typeof c === 'string') {
      const m = meta(c);
      if (m.N || m.SN) return metaCell(m);
      return esc(c.slice(0, 2000));
    }
    if (Array.isArray(c)) return c.every(Array.isArray) ? table({ value: c }, true) : c.map((x) => cell(x, colHead)).join(', ');
    if (isCell(c)) {
      const v = c.value;
      switch (c.type) {
        case 'aid': { const a = num(v); return a == null ? '' : `<a href="${assetHref(a)}">${esc(assetName(a))}</a>`; }
        case 'amount': return amount(v, scale);
        case 'blob': return copyHash(hex(v, 200));
        case 'cid': { const h = hex(v, 64); return h ? `<a class="mono" href="${contractHref(h)}" title="${esc(h)}">${esc(short(h))}</a>` : ''; }
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
  // the scale for a row's amounts: the asset named in the same row, if any
  const rowScale = (r) => { const a = Array.isArray(r) ? r.find((c) => isCell(c) && c.type === 'aid') : null; return a ? scaleOf(num(a.value)) : GROTH; };
  function bodyRows(rows, heads) {
    const tr = (r, cls = '') => { const cells = Array.isArray(r) ? r : [r], sc = rowScale(cells); return `<tr${cls ? ` class="${cls}"` : ''}>${cells.map((c, j) => `<td>${cell(c, heads[j], sc)}</td>`).join('')}</tr>`; };
    return rows.map((row) => {
      if (isCell(row) && row.type === 'group' && Array.isArray(row.value)) return row.value.map((r, i) => tr(r, i ? 'grp-sub' : 'grp-first')).join('');
      return tr(row);
    }).join('');
  }
  // explorer-node's contract call history names 7 columns but sends 8: Emission is missing from
  // the header, between Funds and Keys (the per-block call tables have it). Put it back, and give any
  // other extra column an empty header, so cells stay under the right names.
  function fixHead(head, body) {
    if (!head.length) return;
    const width = body.reduce((w, r) => {
      const rr = isCell(r) && r.type === 'group' && Array.isArray(r.value) ? r.value : [r];
      return Math.max(w, ...rr.map((x) => (Array.isArray(x) ? x.length : 1)));
    }, 0);
    if (width === head.length + 1 && head.includes('Funds') && head[head.length - 1] === 'Keys' && !head.includes('Emission')) head.splice(head.length - 1, 0, 'Emission');
    while (head.length < width) head.push('');
  }
  function table(t, nested = false, bodyId = '') {
    const rows = Array.isArray(t && t.value) ? t.value.slice(0, 5000) : [];
    const head = isHead(rows[0]) ? rows[0].map((h) => String(h.value)) : [];
    const body = head.length ? rows.slice(1) : rows;
    fixHead(head, body);
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
      <td class="num">${amountOf(x.r1, x.a1)} <span class="dim">${esc(assetName(x.a1))}</span></td><td class="num">${amountOf(x.r2, x.a2)} <span class="dim">${esc(assetName(x.a2))}</span></td>
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

  // more / less on long asset descriptions
  view.addEventListener('click', (e) => {
    const b = e.target.closest('[data-more]');
    if (!b) return;
    const box = b.parentElement.querySelector('.meta-long');
    if (!box) return;
    box.hidden = !box.hidden;
    b.textContent = box.hidden ? 'more' : 'less';
  });

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
      fixHead(heads, heads.length ? rows.slice(1) : rows);
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
    return rows.map((b) => `<tr class="${ours.map.has(b.height) ? 'ours' : ''}"><td>${heightLink(b.height)}</td><td class="dim">${when(b.ts)}</td><td class="dim">${ago(b.ts)}</td>
      <td class="mono dim"><a href="${blockHref(b.height)}">${esc(short(b.hash))}</a></td><td class="num">${diff(b.difficulty)}</td>
      <td class="num">${int(b.txs)}</td><td class="num">${int(b.outputs || 0)} / ${int(b.inputs || 0)}${b.shOut || b.shIn ? `<div class="dim small">shielded ${int(b.shOut || 0)} / ${int(b.shIn || 0)}</div>` : ''}</td>
      <td class="num">${b.calls ? `<span class="badge solo">${int(b.calls)}</span>` : '<span class="dim">—</span>'}</td><td class="num dim">${b.fee ? beam(b.fee, 6) : '—'}</td></tr>`).join('');
  }

  // Blocks found by our pool, from the pool's API (it allows any origin): height -> { mode, status }.
  // Refreshed at most once a minute; without the pool the explorer just shows no marks.
  const POOL_API = 'https://pool.bumblebeam.org/api';
  const ours = { map: new Map(), at: 0, loading: null };
  function ourBlocks() {
    if (Date.now() - ours.at < 60000) return Promise.resolve(ours.map);
    if (!ours.loading) {
      ours.loading = fetch(`${POOL_API}/blocks?limit=500`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((d) => {
        const m = new Map();
        for (const b of (d && Array.isArray(d.blocks) ? d.blocks : [])) {
          const h = num(b.height);
          if (h != null && b.status !== 'orphaned') m.set(h, { mode: b.mode === 'solo' ? 'solo' : 'PPLNS', status: String(b.status || '') });
        }
        ours.map = m;
        ours.at = Date.now();
      }).catch(() => { ours.at = Date.now(); }).finally(() => { ours.loading = null; });
    }
    return ours.loading.then(() => ours.map);
  }
  const ourTitle = (o) => `Found by the BumbleBeam pool · ${o.mode}`;
  const heightLink = (h) => {
    const o = ours.map.get(h);
    return o ? `<a class="badge ok ours-h" href="${blockHref(h)}" title="${esc(ourTitle(o))}">${int(h)}</a>` : `<a href="${blockHref(h)}">${int(h)}</a>`;
  };

  // Blocks: the latest ones, more on request; search and filters run over what is loaded, and a
  // height typed in and Enter opens that block.
  const bk = { q: '', tx: false, calls: false, sh: false, fees: false, ours: false, rows: [], next: null, tip: null, looked: new Map(), timer: null };
  const bkFiltering = () => bk.q.trim() || bk.tx || bk.calls || bk.sh || bk.fees || bk.ours;
  function blocksFiltered() {
    const q = bk.q.trim().toLowerCase().replace(/,/g, '');
    // "Our pool" lists every block the pool found, loaded or not; the others are fetched one by one
    const base = bk.ours ? [...ours.map.keys()].sort((a, b) => b - a).map((h) => bk.rows.find((r) => r.height === h) || bk.looked.get(h)).filter((r) => r && r !== 'loading') : bk.rows;
    return base.filter((b) => (!q || String(b.height).includes(q) || (b.hash && b.hash.startsWith(q)))
      && (!bk.tx || b.txs > 1) && (!bk.calls || b.calls > 0) && (!bk.sh || b.shOut || b.shIn) && (!bk.fees || b.fee > 0));
  }
  async function loadOurs() {
    const missing = [...ours.map.keys()].filter((h) => !bk.rows.some((r) => r.height === h) && !bk.looked.has(h)).sort((a, b) => b - a);
    for (let i = 0; i < missing.length; i += 4) {
      await Promise.all(missing.slice(i, i + 4).map(async (h) => {
        bk.looked.set(h, 'loading');
        try { bk.looked.set(h, normHdrs(await get(`hdrs?hMax=${h}&nMax=1`), 1).find((b) => b.height === h) || null); } catch (e) { bk.looked.delete(h); }
      }));
      if (!bk.ours || !$('#hdr-body')) return;
      blocksBody();
    }
  }
  // a height that is not loaded is fetched from the node and shown on its own
  function lookupHeight(h) {
    clearTimeout(bk.timer);
    bk.timer = setTimeout(async () => {
      if (bk.looked.has(h)) return;
      bk.looked.set(h, 'loading');
      try { bk.looked.set(h, normHdrs(await get(`hdrs?hMax=${h}&nMax=1`), 1).find((b) => b.height === h) || null); } catch (e) { bk.looked.set(h, null); }
      if ($('#hdr-body') && bk.q.trim().replace(/,/g, '') === String(h)) blocksBody();
    }, 250);
  }
  function blocksBody() {
    let rows = blocksFiltered();
    const q = bk.q.trim().replace(/[,\s]/g, ''), height = /^\d{1,10}$/.test(q) ? Number(q) : null;
    let note = '';
    if (height != null && !rows.some((b) => b.height === height)) {
      if (bk.tip && height > bk.tip) note = `Block ${int(height)} is not mined yet; the tip is ${int(bk.tip)}.`;
      else {
        const got = bk.looked.get(height);
        if (got === undefined || got === 'loading') { note = `Looking up block ${int(height)}…`; if (got === undefined) lookupHeight(height); }
        else if (got) rows = [got, ...rows];
        else note = `Block ${int(height)} is not on the chain we know.`;
      }
    } else if (q && !rows.length && /^[0-9a-f]+$/i.test(q)) note = 'No loaded block matches. A hash is searched among loaded blocks only; Beam\'s API has no lookup by block hash.';
    else if (bk.ours && !ours.map.size) note = 'The BumbleBeam pool has not found a block yet.';
    else if (bk.ours && [...bk.looked.values()].includes('loading')) note = 'Loading the pool\'s blocks…';
    $('#hdr-body').innerHTML = hdrRows(rows) + (note ? `<tr><td colspan="9" class="empty">${esc(note)}</td></tr>` : '')
      || '<tr><td colspan="9" class="empty">No loaded block matches the filters; load older blocks to search further back</td></tr>';
    const oldest = bk.rows.length ? bk.rows[bk.rows.length - 1].height : null;
    $('#blocks-count').innerHTML = `<b>${int(rows.length)}</b> of ${int(bk.rows.length)} loaded${oldest ? ` · back to ${int(oldest)}` : ''}`;
    [['#bk-tx', bk.tx], ['#bk-calls', bk.calls], ['#bk-sh', bk.sh], ['#bk-fees', bk.fees], ['#bk-ours', bk.ours]].forEach(([id, on]) => $(id).classList.toggle('on', on));
    // while something is typed, a height is looked up directly, so loading more would change nothing
    const btn = $('#more-hdrs');
    if (btn) {
      btn.parentElement.style.display = bk.q.trim() || bk.ours ? 'none' : '';
      if (!btn.disabled) btn.textContent = bkFiltering() ? 'Load 200 older blocks' : 'Load older blocks';
    }
  }

  views.home = async () => {
    const [st] = await Promise.all([get('status').then(normStatus), ourBlocks()]);
    bk.tip = st.height;
    const fresh = st.height ? normHdrs(await get(`hdrs?hMax=${st.height}&nMax=${PAGE}`)) : [];
    // keep what was loaded and searched while new blocks come in (auto-refresh)
    if (bk.rows.length && bkFiltering()) {
      const top = bk.rows[0].height;
      bk.rows = [...fresh.filter((b) => b.height > top), ...bk.rows];
    } else {
      bk.rows = fresh;
      bk.next = fresh.length ? fresh[fresh.length - 1].height - 1 : null;
    }
    return `<div class="page-head"><h1 class="page-title">Beam blocks</h1></div>
      <div class="tiles">
        ${tile('Height', int(st.height), st.ts ? `last block ${ago(st.ts)}` : '', 'accent')}
        ${tile('Difficulty', diff(fresh[0] && fresh[0].difficulty))}
        ${tile('Peers', `<a href="/peers">${int(st.peers)}</a>`, 'connected to our node')}
        ${tile('Shielded outputs 24h', int(st.shielded24h), `${int(st.shieldedTotal)} in total`)}
      </div>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Latest blocks</h2><div class="panel-meta"><span id="blocks-count"></span></div></div>
        ${bk.rows.length ? `<div class="names-tools">
          <input id="bk-q" class="names-q" placeholder="Any height, or a hash among loaded blocks…" autocomplete="off" spellcheck="false" aria-label="Search blocks" value="${esc(bk.q)}">
          <div class="seg"><button type="button" id="bk-tx">With transactions</button><button type="button" id="bk-calls">Contract calls</button><button type="button" id="bk-sh">Shielded</button><button type="button" id="bk-fees">With fees</button><button type="button" id="bk-ours" title="Blocks found by the BumbleBeam pool">Our pool${ours.map.size ? ` · ${int(ours.map.size)}` : ''}</button></div>
        </div>
        <div class="table-wrap"><table id="blocks-table"><colgroup><col class="w-h"><col class="w-t"><col class="w-a"><col><col class="w-d"><col class="w-tx"><col class="w-io"><col class="w-c"><col class="w-f"></colgroup>
          <thead><tr><th>Height</th><th>Time</th><th>Age</th><th>Hash</th><th class="num">Difficulty</th><th class="num">Txs</th><th class="num">Out / in</th><th class="num">Calls</th><th class="num">Fees</th></tr></thead>
        <tbody id="hdr-body"></tbody></table></div>
        ${bk.next && bk.next > 0 ? '<div class="more"><button class="btn ghost" id="more-hdrs">Load older blocks</button></div>' : ''}
        <p class="hint" style="margin:12px 0 0">Outputs / inputs are Mimblewimble UTXOs; shielded ones are Lelantus. Calls count contract invocations. Search and filters work on the blocks loaded so far.</p>`
        : '<div class="empty">No blocks yet: the node is still syncing headers</div>'}
      </section>`;
  };

  function bindHome() {
    const q = $('#bk-q');
    if (!q) return;
    blocksBody();
    q.addEventListener('input', () => { bk.q = q.value; blocksBody(); });
    q.addEventListener('keydown', (e) => {
      const h = q.value.trim().replace(/[,\s]/g, '');
      if (e.key === 'Enter' && /^\d{1,10}$/.test(h)) { e.preventDefault(); bk.q = ''; go(blockHref(h)); }
    });
    [['#bk-tx', 'tx'], ['#bk-calls', 'calls'], ['#bk-sh', 'sh'], ['#bk-fees', 'fees'], ['#bk-ours', 'ours']].forEach(([id, k]) => $(id).addEventListener('click', () => {
      bk[k] = !bk[k];
      blocksBody();
      if (k === 'ours' && bk.ours) loadOurs();
    }));
    if (bk.ours) loadOurs();
    const btn = $('#more-hdrs');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Loading…';
      try {
        const n = bkFiltering() ? 200 : PAGE;
        const rows = normHdrs(await get(`hdrs?hMax=${bk.next}&nMax=${n}`), n);
        bk.rows.push(...rows);
        const last = rows[rows.length - 1];
        bk.next = last ? last.height - 1 : 0;
        btn.disabled = false;
        if (!last || bk.next <= 0) btn.remove();
        blocksBody();
      } catch (e) {
        btn.textContent = 'Could not load';
        btn.disabled = false;
      }
    });
  }

  async function blockView(b, hit = '') {
    const fees = b.kernels.reduce((s, k) => s + (k.fee || 0), 0);
    const withExtra = b.kernels.filter((k) => Object.keys(k.extra).length);
    if (withExtra.length) await assets().catch(() => null);
    const calls = withExtra.length ? `<section class="panel"><div class="panel-head"><h2 class="panel-title">Contract calls and other kernel data</h2></div>
      ${withExtra.map((k) => `<div class="doc-kernel"><div class="dim mono" style="font-size:11px;margin:4px 0 6px">kernel <a href="${kernelHref(k.id)}">${esc(short(k.id))}</a></div>
        ${Object.entries(k.extra).map(([name, v]) => (isCell(v) && v.type === 'table' ? table(v) : `<dl class="kv"><dt>${esc(name)}</dt><dd>${cell(v, name)}</dd></dl>`)).join('')}</div>`).join('')}</section>` : '';
    const coinbase = b.outputs.filter((o) => o.coinbase).reduce((s, o) => s + (o.value || 0), 0);
    const kRows = b.kernels.map((k) => `<tr class="${k.id && k.id === hit ? 'hit' : ''}"><td class="mono"><a href="${kernelHref(k.id)}">${esc(short(k.id))}</a></td>
      <td class="num">${k.fee ? beam(k.fee, 8) : '0'}</td><td class="num dim">${int(k.min)}</td><td class="num dim">${int(k.max)}</td><td>${Object.keys(k.extra).length ? '<span class="badge solo">contract</span>' : ''}</td></tr>`).join('');
    const iRows = b.inputs.map((i) => `<tr><td>${copyHash(i.commitment)}</td><td class="num">${i.height ? `<a href="${blockHref(i.height)}">${int(i.height)}</a>` : '—'}</td></tr>`).join('');
    const oRows = b.outputs.map((o) => `<tr><td>${copyHash(o.commitment)}</td>
      <td>${o.coinbase ? '<span class="badge ok">coinbase</span>' : '<span class="dim">confidential</span>'}</td>
      <td class="num">${o.coinbase && o.value != null ? beam(o.value, 4) : '—'}</td><td class="num dim">${o.maturity ? int(o.maturity) : '—'}</td>
      <td class="num">${o.spent ? `<a href="${blockHref(o.spent)}">${int(o.spent)}</a>` : '<span class="dim">unspent</span>'}</td></tr>`).join('');
    await ourBlocks();
    const our = ours.map.get(b.height);
    return `<div class="page-head"><h1 class="page-title">Block ${int(b.height)}${our ? ` <span class="badge ok ours-tag" title="${esc(ourTitle(our))}">BumbleBeam · ${esc(our.mode)}</span>` : ''}</h1>
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

  // Assets: the whole list is one API table, so search, filter and sorting run in the page.
  const as = { q: '', described: false, sort: 'aid', dir: 1, all: [] };
  function assetsFiltered() {
    // "#39" is an asset ID; a key is searched from 6 characters on, so short numbers don't match keys
    const raw = as.q.trim().toLowerCase(), byId = /^#\d+$/.test(raw), q = raw.replace(/^#/, '');
    const hit = (a) => (byId ? String(a.aid) === q
      : [a.name, a.ticker, a.unit].some((x) => x && x.toLowerCase().includes(q)) || String(a.aid) === q || (q.length >= 6 && a.owner && a.owner.includes(q)));
    const rows = as.all.filter((a) => (!q || hit(a))
      && (!as.described || a.native || meta(a.metaText).OPT_SHORT_DESC || meta(a.metaText).OPT_LONG_DESC));
    const key = { aid: (a) => a.aid, name: (a) => (a.name || '').toLowerCase(), ticker: (a) => (a.ticker || '').toLowerCase(), supply: (a) => (a.supply || 0) / scaleOf(a.aid) }[as.sort];
    return rows.sort((x, y) => { const a = key(x), b = key(y); return (a < b ? -1 : a > b ? 1 : x.aid - y.aid) * as.dir; });
  }
  function assetsBody() {
    const rows = assetsFiltered();
    $('#assets-body').innerHTML = rows.map((a) => `<tr><td><a href="${assetHref(a.aid)}">#${int(a.aid)}</a></td><td class="name-cell"><a href="${assetHref(a.aid)}">${esc(a.name || '—')}</a></td>
      <td>${a.native ? '<span class="dim">—</span>' : copyHash(a.owner)}</td><td class="name-cell">${esc(a.ticker)}</td>
      <td class="num">${amountOf(a.supply, a.aid)}${a.native ? ' <span class="dim">issued</span>' : ''}</td><td class="num dim">${a.native ? DECIMALS : esc(decimalsOf(a).text)}</td>
      <td class="num dim">${a.native ? 'native coin' : amount(a.deposit)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No assets match</td></tr>';
    $('#assets-count').innerHTML = `<b>${int(rows.length)}</b> of ${int(as.all.length)}`;
    $('#assets-described').classList.toggle('on', as.described);
    document.querySelectorAll('#assets-table th[data-sort]').forEach((th) => { th.dataset.dir = th.dataset.sort === as.sort ? (as.dir > 0 ? '▲' : '▼') : ''; });
  }
  views.assets = async (filter) => {
    const ix = await assets();
    as.all = [{ aid: 0, name: 'Beam', ticker: 'BEAM', unit: 'BEAM', supply: beamIssued(ix.h), deposit: null, owner: '', native: true, metaText: '' }, ...ix.list];
    if (filter != null) as.q = String(filter);
    const th = (key, label, cls = '') => `<th class="${cls} sortable" data-sort="${key}">${label}</th>`;
    return `<div class="page-head"><h1 class="page-title">Assets</h1></div>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Confidential assets</h2><div class="panel-meta"><span id="assets-count"></span></div></div>
        <div class="names-tools">
          <input id="assets-q" class="names-q" placeholder="Search by name, ticker, ID or owner key…" autocomplete="off" spellcheck="false" aria-label="Search assets" value="${esc(as.q)}">
          <div class="seg"><button type="button" id="assets-described">With description</button></div>
        </div>
        <div class="table-wrap"><table id="assets-table"><colgroup><col class="w-id"><col><col class="w-key"><col class="w-tick"><col class="w-sup"><col class="w-dec"><col class="w-dep"></colgroup>
          <thead><tr>${th('aid', 'ID')}${th('name', 'Name')}<th>Owner key</th>${th('ticker', 'Ticker')}${th('supply', 'Supply', 'num')}<th class="num">Decimals</th><th class="num">Deposit (BEAM)</th></tr></thead>
          <tbody id="assets-body"></tbody></table></div>
        <p class="hint" style="margin:12px 0 0">Tokens issued on Beam, each with an asset ID. Balances and transfers stay private like BEAM's; supply, issuer key and history are public. Click a key to copy it.</p></section>`;
  };
  function bindAssets() {
    const q = $('#assets-q');
    if (!q) return;
    assetsBody();
    q.addEventListener('input', () => { as.q = q.value; assetsBody(); });
    $('#assets-described').addEventListener('click', () => { as.described = !as.described; assetsBody(); });
    $('#assets-table thead').addEventListener('click', (e) => {
      const th = e.target.closest('th[data-sort]');
      if (!th) return;
      as.dir = as.sort === th.dataset.sort ? -as.dir : (th.dataset.sort === 'supply' ? -1 : 1);
      as.sort = th.dataset.sort;
      assetsBody();
    });
  }

  // The asset's own description from its metadata: logo, short and long text, links; the other
  // metadata fields underneath.
  const SHOWN = new Set(['OPT_SHORT_DESC', 'OPT_LONG_DESC', 'OPT_SITE_URL', 'OPT_PDF_URL', 'OPT_LOGO_URL', 'OPT_FAVICON_URL']);
  function assetAbout(a, m) {
    const logo = safeUrl(m.OPT_LOGO_URL), links = metaLinks(m);
    const rest = Object.entries(m).filter(([k]) => !SHOWN.has(k));
    return `<section class="panel"><div class="asset-about">${logo ? `<img class="asset-logo" src="${esc(logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
      <div>${m.OPT_SHORT_DESC ? `<p class="about-short">${esc(m.OPT_SHORT_DESC)}</p>` : ''}${m.OPT_LONG_DESC && m.OPT_LONG_DESC !== m.OPT_SHORT_DESC ? `<p class="hint about-long">${esc(m.OPT_LONG_DESC)}</p>` : ''}
        ${links ? `<p class="about-links">${links}</p>` : ''}${!m.OPT_SHORT_DESC && !m.OPT_LONG_DESC && !links ? '<p class="hint" style="margin:0">The issuer gave no description.</p>' : ''}</div></div>
      <dl class="kv" style="margin-top:14px"><dt>Owner key</dt><dd>${a.owner ? `<span class="mono copy" data-copy="${esc(a.owner)}">${esc(a.owner)}</span>` : '—'}</dd>
        ${rest.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></section>`;
  }

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
        ${tile('Supply', a ? amountTile(a.supply, scaleOf(aid)) : '—', esc(a && a.unit ? a.unit : ''))}
        ${tile('Deposit', a ? `${amount(a.deposit)} BEAM` : '—', 'locked by the issuer')}
        ${tile('Decimals', esc(decimalsOf(a).text), esc(decimalsOf(a).note))}
        ${tile('Lock height', a && a.lock ? `<a href="${blockHref(a.lock)}">${int(a.lock)}</a>` : '—')}
      </div>
      ${pools.length ? `<section class="panel"><div class="panel-head"><h2 class="panel-title">DEX pools</h2><div class="panel-meta"><a href="/dex">all pools →</a></div></div>${poolTable(pools)}</section>` : ''}
      ${a ? assetAbout(a, m) : ''}
      ${sections}`;
  };

  // Contracts: the list is one API table, so search, filters and sorting run in the page. A cell
  // with more than one asset shows the first and a more / less toggle that opens the whole row.
  const cs = { q: '', known: false, funds: false, sort: 'deployed', dir: -1, open: new Set(), list: [], tip: null };
  function contractRows(t) {
    return rowsOf(t).map((r) => {
      const k = r[1];
      let kind = '', shader = '';
      if (typeof k === 'string') kind = k.slice(0, 80);
      else if (k && typeof k === 'object' && typeof k.Wrapper === 'string') { kind = k.Wrapper.slice(0, 40); shader = hex(cv(k.subtype), 64); }
      else shader = hex(cv(k), 64);
      const locked = rowsOf({ type: 'table', value: [[], ...(isCell(r[3]) && Array.isArray(r[3].value) ? r[3].value : [])] })
        .map((x) => ({ aid: num(cv(x[0])), amount: num(String(cv(x[1]))) })).filter((x) => x.aid != null);
      const owned = rowsOf({ type: 'table', value: [[], ...(isCell(r[4]) && Array.isArray(r[4].value) ? r[4].value : [])] })
        .map((x) => ({ aid: num(cv(x[0])), meta: meta(cv(x[1])), emission: num(String(cv(x[2]))) })).filter((x) => x.aid != null);
      return { cid: hex(cv(r[0]), 64), kind, shader, deployed: num(cv(r[2])), locked, owned, beam: locked.filter((x) => x.aid === 0).reduce((s, x) => s + (x.amount || 0), 0) };
    }).filter((c) => c.cid);
  }
  function contractsFiltered() {
    const q = cs.q.trim().toLowerCase();
    const hit = (c) => !q || c.cid.includes(q) || c.kind.toLowerCase().includes(q) || c.shader.includes(q)
      || [...c.locked, ...c.owned].some((x) => assetName(x.aid).toLowerCase().includes(q) || (x.meta && [x.meta.N, x.meta.SN].some((y) => y && y.toLowerCase().includes(q))));
    const rows = cs.list.filter((c) => hit(c) && (!cs.known || (c.kind && !c.shader)) && (!cs.funds || c.locked.length));
    const key = { kind: (c) => (c.kind || `~${c.shader}`).toLowerCase(), deployed: (c) => c.deployed || 0, beam: (c) => c.beam }[cs.sort];
    return rows.sort((a, b) => { const ka = key(a), kb = key(b); return (ka < kb ? -1 : ka > kb ? 1 : 0) * cs.dir; });
  }
  function pastHeight(h) {
    if (!h) return '—';
    const t = timeAt(h);
    return `<a href="${blockHref(h)}">${int(h)}</a>${t ? `<div class="dim small">${esc(local(t).slice(0, 10))}</div>` : ''}`;
  }
  function stack(items, open, draw) {
    if (!items.length) return '<span class="dim">—</span>';
    const shown = open ? items : items.slice(0, 1);
    return shown.map((x) => `<div class="stack-line">${draw(x)}</div>`).join('');
  }
  function contractsBody() {
    const rows = contractsFiltered();
    const fund = (x) => `${amountOf(x.amount, x.aid)} <a href="${assetHref(x.aid)}" class="dim">${esc(assetName(x.aid))}</a>`;
    const own = (x) => `<a href="${assetHref(x.aid)}">${esc((x.meta && (x.meta.SN || x.meta.N)) || assetName(x.aid))}</a> <span class="dim">${amountOf(x.emission, x.aid)}</span>`;
    $('#contracts-body').innerHTML = rows.map((c) => {
      const open = cs.open.has(c.cid), more = Math.max(c.locked.length, c.owned.length) - 1;
      return `<tr class="${open ? 'open' : ''}"><td><a class="mono" href="${contractHref(c.cid)}">${esc(short(c.cid))}</a></td>
        <td>${c.kind ? `${esc(c.kind)}${c.shader ? `<div>${copyHash(c.shader)}</div>` : ''}` : copyHash(c.shader)}</td>
        <td class="num">${pastHeight(c.deployed)}</td>
        <td class="num">${stack(c.locked, open, fund)}</td>
        <td>${stack(c.owned, open, own)}</td>
        <td class="num">${more > 0 ? `<button type="button" class="btn ghost small" data-open="${c.cid}">${open ? 'less' : 'more'}</button>` : ''}</td></tr>`;
    }).join('') || '<tr><td colspan="6" class="empty">No contracts match</td></tr>';
    $('#contracts-count').innerHTML = `<b>${int(rows.length)}</b> of ${int(cs.list.length)}`;
    $('#contracts-known').classList.toggle('on', cs.known);
    $('#contracts-funds').classList.toggle('on', cs.funds);
    document.querySelectorAll('#contracts-table th[data-sort]').forEach((th) => { th.dataset.dir = th.dataset.sort === cs.sort ? (cs.dir > 0 ? '▲' : '▼') : ''; });
  }

  views.contracts = async () => {
    const [t, st] = await Promise.all([get('contracts'), get('status').catch(() => null), assets().catch(() => null)]);
    cs.list = contractRows(t);
    cs.tip = st && num(st.height);
    const named = cs.list.filter((c) => c.kind && !c.shader).length, withFunds = cs.list.filter((c) => c.locked.length).length;
    const th = (key, label, cls = '') => `<th class="${cls} sortable" data-sort="${key}">${label}</th>`;
    return `<div class="page-head"><h1 class="page-title">Contracts</h1></div>
      <div class="tiles">
        ${tile('Contracts', int(cs.list.length), 'deployed on Beam', 'accent')}
        ${tile('Known kinds', int(named), 'decoded by the explorer parser')}
        ${tile('Holding funds', int(withFunds), 'with assets locked inside')}
        ${tile('BEAM locked', amountTile(cs.list.reduce((s, c) => s + c.beam, 0)), 'across all contracts')}
      </div>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Deployed contracts</h2><div class="panel-meta"><span id="contracts-count"></span></div></div>
        <div class="names-tools">
          <input id="contracts-q" class="names-q" placeholder="Search by kind, contract ID or asset…" autocomplete="off" spellcheck="false" aria-label="Search contracts" value="${esc(cs.q)}">
          <div class="seg"><button type="button" id="contracts-known">Known kinds</button><button type="button" id="contracts-funds">Holding funds</button></div>
        </div>
        <div class="table-wrap"><table id="contracts-table"><colgroup><col class="w-cid"><col class="w-kind"><col class="w-dep"><col class="w-fund"><col><col class="w-more"></colgroup>
          <thead><tr><th>Contract</th>${th('kind', 'Kind')}${th('deployed', 'Deployed', 'num')}${th('beam', 'Locked funds', 'num')}<th>Owned assets</th><th></th></tr></thead>
          <tbody id="contracts-body"></tbody></table></div>
        <p class="hint" style="margin:12px 0 0">Beam's smart contracts (shaders). Kinds the explorer's parser knows are named; the others show their shader hash (click to copy). Locked funds sort by the BEAM held.</p></section>`;
  };

  function bindContracts() {
    const q = $('#contracts-q');
    if (!q) return;
    contractsBody();
    if (cs.tip) heightClock(cs.tip).then(() => { if ($('#contracts-body')) contractsBody(); }).catch(() => {});
    q.addEventListener('input', () => { cs.q = q.value; contractsBody(); });
    $('#contracts-known').addEventListener('click', () => { cs.known = !cs.known; contractsBody(); });
    $('#contracts-funds').addEventListener('click', () => { cs.funds = !cs.funds; contractsBody(); });
    $('#contracts-table thead').addEventListener('click', (e) => {
      const th = e.target.closest('th[data-sort]');
      if (!th) return;
      cs.dir = cs.sort === th.dataset.sort ? -cs.dir : (th.dataset.sort === 'kind' ? 1 : -1);
      cs.sort = th.dataset.sort;
      contractsBody();
    });
    $('#contracts-body').addEventListener('click', (e) => {
      const b = e.target.closest('[data-open]');
      if (!b) return;
      if (cs.open.has(b.dataset.open)) cs.open.delete(b.dataset.open); else cs.open.add(b.dataset.open);
      contractsBody();
    });
  }

  // What each known kind of contract is, for the description block on its page.
  const KIND_INFO = [
    [/^DEX\b/, 'Beam\'s on-chain exchange (AMM): liquidity pools of asset pairs at three fee tiers. Calls add and withdraw liquidity and trade; the state lists every pool with its reserves.'],
    [/^Nephrite\b/, 'A stablecoin protocol: users lock BEAM as collateral in troves and mint the Nph token against it; a stability pool absorbs liquidations. Prices come from the oracle.'],
    [/^DaoVault\b/, 'The Beam DAO\'s treasury vault: protocol fees from other contracts (DEX, Nephrite, BANS) are deposited here.'],
    [/^DaoCore/, 'The core of the Beam DAO: it issued the BeamX governance token and runs its distribution.'],
    [/^DaoVote\b/, 'Beam DAO governance: proposals and votes, weighted by staked BeamX.'],
    [/^DaoAccumulator\b/, 'A Beam DAO farming contract: liquidity locked here earns BeamX rewards over time.'],
    [/^Oracle/, 'A price oracle: providers feed prices, and other contracts (Nephrite, BANS) read them.'],
    [/^Bans\b/, 'BANS, the Beam Anonymous Name Service: names registered to a key for a period, renewed, transferred and sold. See the Names page.'],
    [/^VaultAnon\b/, 'An anonymous vault: it holds funds for a key until the owner withdraws them (BANS pays name sellers through it).'],
    [/^Faucet/, 'A faucet: it hands out small amounts of an asset to anyone, within a limit per period.'],
    [/Gallery/, 'The Beam Gallery: an NFT art gallery where artists publish artworks and collectors buy and sell them.'],
    [/^BlackHole\b/, 'A black hole: what is sent here can never be withdrawn, a provable burn.'],
    [/^Minter\b/, 'An asset minter: it issues confidential assets on behalf of their owners.'],
    [/^upgradable/, 'An upgradable wrapper: the contract\'s code can be replaced by its admins, after a delay, while its ID and funds stay.'],
  ];
  function kindOf(k) {
    if (typeof k === 'string') return { name: k.slice(0, 80), shader: '' };
    if (k && typeof k === 'object' && typeof k.Wrapper === 'string') return { name: k.Wrapper.slice(0, 40), shader: hex(cv(k.subtype), 64) };
    return { name: '', shader: hex(cv(k), 64) };
  }

  views.contract = async (arg) => {
    const cid = hex(arg, 64);
    if (cid.length !== 64) return notFound(`Contract ${String(arg || '').slice(0, 80)}`);
    const pager = `contract?id=${cid}&nMaxTxs=${CALLS_PAGE}&state=0&assets_owned=0&funds_locked=0&ver_info=0`;
    const [d, , st] = await Promise.all([get(`contract?id=${cid}&nMaxTxs=${CALLS_PAGE}`), assets().catch(() => null), get('status').catch(() => null)]);
    const ver = d && d['Version History'];
    const versions = isCell(ver) && Array.isArray(ver.value) ? ver.value.slice(1) : [];
    if (!versions.length) return notFound(`Contract ${short(cid)}`);
    const first = versions[versions.length - 1], deployed = num(isCell(first[0]) ? first[0].value : first[0]);
    if (st && num(st.height)) await heightClock(num(st.height)).catch(() => null);
    const k = kindOf(d.kind);
    const about = (KIND_INFO.find(([re]) => re.test(k.name)) || [])[1]
      || 'A contract whose kind the explorer\'s parser does not know, so its state and calls are shown as the node reports them.';
    const lockedT = d['Locked Funds'];
    const beamLocked = rowsOf(lockedT).filter((r) => num(cv(r[0])) === 0).reduce((t, r) => t + (num(String(cv(r[1]))) || 0), 0);
    const order = ['State', 'Locked Funds', 'Owned assets', 'Version History', 'Calls history'];
    const keys = Object.keys(d).filter((x) => !['h', 'kind'].includes(x)).sort((x, y) => (order.indexOf(x) + 99) % 99 - (order.indexOf(y) + 99) % 99);
    const t = deployed != null ? timeAt(deployed) : null;
    return `<div class="page-head"><h1 class="page-title">${esc(k.name || 'Contract')}</h1><div class="actions"><a class="btn ghost small" href="/contracts">all contracts</a></div></div>
      <div class="tiles">
        ${tile('Kind', k.name ? esc(k.name) : copyHash(k.shader), k.name ? (k.shader ? 'wrapper around a shader' : 'decoded by Beam\'s explorer parser') : 'shader hash, not decoded', 'accent')}
        ${tile('Deployed', deployed != null ? `<a href="${blockHref(deployed)}">${int(deployed)}</a>` : '—', t ? esc(local(t)) : '')}
        ${tile('Versions', int(versions.length), versions.length > 1 ? 'upgraded since deployment' : 'as deployed')}
        ${tile('BEAM locked', amountTile(beamLocked), 'held by the contract')}
      </div>
      <section class="panel"><p class="hint" style="margin:0 0 12px">${esc(about)}</p>
        <dl class="kv"><dt>Contract ID</dt><dd><span class="mono copy" data-copy="${esc(cid)}">${esc(cid)}</span></dd>
        ${k.shader ? `<dt>Shader</dt><dd><span class="mono copy" data-copy="${esc(k.shader)}">${esc(k.shader)}</span></dd>` : ''}</dl></section>
      ${keys.map((x) => section(x, d[x], x === 'Calls history' ? pager : null)).join('')}`;
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
        ${tile('Issued', amountTile(issued), `of ${int(MAX_BEAM)} max, by the emission schedule`)}
        ${tile('Decimals', String(DECIMALS), '1 BEAM = 10⁸ groth')}
        ${tile('Locked in contracts', locked != null ? amountTile(locked) : '—', 'DEX, DAO, Nephrite and the rest')}
      </div>
      <section class="panel"><p class="hint" style="margin:0">BEAM is emitted with every block: 100 a block in the first year, 50 in years two to five, then half
        as much every four years, shared between the miner and, until year five, the treasury. Balances are private; what contracts hold is public.</p></section>
      ${pools.length ? `<section class="panel"><div class="panel-head"><h2 class="panel-title">DEX pools with BEAM</h2><div class="panel-meta"><a href="/dex">all pools →</a></div></div>${poolTable(pools)}</section>` : ''}`;
  }

  const ds = { q: '', tier: 'All', empty: false, sort: 'r1', dir: -1, pools: [] };
  function dexFiltered() {
    const q = ds.q.trim().toLowerCase();
    const names = (x) => [assetName(x.a1), assetName(x.a2), assetName(x.lp)].map((n) => n.toLowerCase());
    const rows = ds.pools.filter((x) => (ds.empty || x.r1 || x.r2) && (ds.tier === 'All' || x.vol === ds.tier) && (!q || names(x).some((n) => n.includes(q)) || `${names(x)[0]}/${names(x)[1]}`.includes(q.replace(/\s+/g, '')) || [x.a1, x.a2].map(String).includes(q.replace(/^#/, ''))));
    const key = { pair: (x) => `${assetName(x.a1)}/${assetName(x.a2)}`.toLowerCase(), r1: (x) => (x.r1 || 0) / scaleOf(x.a1), r2: (x) => (x.r2 || 0) / scaleOf(x.a2), rate: (x) => x.rate12 ?? -1 }[ds.sort];
    return rows.sort((x, y) => { const a = key(x), b = key(y); return (a < b ? -1 : a > b ? 1 : 0) * ds.dir; });
  }
  function dexBody() {
    const rows = dexFiltered();
    $('#dex-body').innerHTML = poolRows(rows) || '<tr><td colspan="6" class="empty">No pools match</td></tr>';
    $('#dex-count').innerHTML = `<b>${int(rows.length)}</b> of ${int(ds.pools.length)}`;
    document.querySelectorAll('#dex-tier [data-tier]').forEach((b) => b.classList.toggle('on', b.dataset.tier === ds.tier));
    $('#dex-empty').classList.toggle('on', ds.empty);
    document.querySelectorAll('#dex-table th[data-sort]').forEach((th) => { th.dataset.dir = th.dataset.sort === ds.sort ? (ds.dir > 0 ? '▲' : '▼') : ''; });
  }
  views.dex = async () => {
    const [dex] = await Promise.all([dexPools(), assets().catch(() => null)]);
    if (!dex.cid) return notFound('The DEX contract');
    ds.pools = dex.pools;
    const live = dex.pools.filter((x) => x.r1 || x.r2).length;
    const th = (key, label, cls = '') => `<th class="${cls} sortable" data-sort="${key}">${label}</th>`;
    return `<div class="page-head"><h1 class="page-title">DEX pools</h1><div class="actions"><a class="btn ghost small" href="${contractHref(dex.cid)}">DEX contract</a></div></div>
      <div class="tiles">
        ${tile('Pools', int(dex.pools.length), 'pairs at a fee tier', 'accent')}
        ${tile('With liquidity', int(live), 'reserves on both sides')}
        ${tile('Empty', int(dex.pools.length - live), 'created, no liquidity now')}
        ${tile('BEAM in pools', amountTile(dex.pools.reduce((t, x) => t + (x.a1 === 0 ? x.r1 || 0 : 0) + (x.a2 === 0 ? x.r2 || 0 : 0), 0)), 'one side of the BEAM pairs')}
      </div>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Liquidity pools</h2><div class="panel-meta"><span id="dex-count"></span></div></div>
        <div class="names-tools">
          <input id="dex-q" class="names-q" placeholder="Search by asset, pair (beam/nph) or asset ID…" autocomplete="off" spellcheck="false" aria-label="Search pools" value="${esc(ds.q)}">
          <div class="seg" id="dex-tier" role="group" aria-label="Fee tier">${['All', 'Low', 'Medium', 'High'].map((t) => `<button type="button" data-tier="${t}">${t === 'All' ? 'All' : `${t} ${FEE_TIER[t]}`}</button>`).join('')}</div>
          <div class="seg"><button type="button" id="dex-empty">Show empty</button></div>
        </div>
        <div class="table-wrap"><table id="dex-table"><colgroup><col><col class="w-vol"><col class="w-res"><col class="w-res"><col class="w-rate"><col class="w-lp"></colgroup>
          <thead><tr>${th('pair', 'Pair')}<th>Volatility · fee</th>${th('r1', 'Reserve 1', 'num')}${th('r2', 'Reserve 2', 'num')}${th('rate', 'Rate 1:2', 'num')}<th>LP token</th></tr></thead>
          <tbody id="dex-body"></tbody></table></div>
        <p class="hint" style="margin:12px 0 0">Beam's on-chain DEX: each pool holds two assets at a fee tier (Low 0.05%, Medium 0.3%, High 1%). Rates are as the contract reports them.</p></section>`;
  };
  function bindDex() {
    const q = $('#dex-q');
    if (!q) return;
    dexBody();
    q.addEventListener('input', () => { ds.q = q.value; dexBody(); });
    $('#dex-tier').addEventListener('click', (e) => { const b = e.target.closest('[data-tier]'); if (b) { ds.tier = b.dataset.tier; dexBody(); } });
    $('#dex-empty').addEventListener('click', () => { ds.empty = !ds.empty; dexBody(); });
    $('#dex-table thead').addEventListener('click', (e) => {
      const th = e.target.closest('th[data-sort]');
      if (!th) return;
      ds.dir = ds.sort === th.dataset.sort ? -ds.dir : (th.dataset.sort === 'pair' ? 1 : -1);
      ds.sort = th.dataset.sort;
      dexBody();
    });
  }

  // When each name was registered is not in the contract state, only in its call history: the
  // latest Register call per name. Loaded after the table shows (about 0.4 MB, cached).
  let bansRegs = null;
  async function bansRegistrations(cid) {
    if (bansRegs && bansRegs.cid === cid && Date.now() - bansRegs.at < 600000) return bansRegs.map;
    const map = new Map();
    let hMax = null;
    for (let i = 0; i < 20; i++) {
      const d = await get(`contract?id=${cid}&nMaxTxs=100000&state=0&assets_owned=0&funds_locked=0&ver_info=0${hMax != null ? `&hMax=${hMax}` : ''}`, 60000);
      const t = d && d['Calls history'];
      for (const g of rowsOrGroups(t)) {
        const first = isCell(g) && g.type === 'group' && Array.isArray(g.value) ? g.value[0] : g;
        if (!Array.isArray(first) || first[3] !== 'Register') continue;
        const h = num(cv(first[0])), name = first[4] && typeof first[4].name === 'string' ? first[4].name : '';
        if (h != null && name && !(map.get(name) > h)) map.set(name, h);
      }
      hMax = t && t.more ? num(t.more.hMax) : null;
      if (hMax == null) break;
    }
    bansRegs = { cid, at: Date.now(), map };
    return map;
  }
  const rowsOrGroups = (t) => (isCell(t) && Array.isArray(t.value) ? t.value.slice(1) : []);

  // Block height -> time: real timestamps of a dozen blocks across the chain, interpolated between
  // them (a flat minute a block drifts by days over millions of blocks); ahead of the tip, a minute a block.
  let anchors = null;
  async function heightClock(tip) {
    if (anchors && anchors.tip >= tip - 1000) return anchors;
    const step = Math.max(50000, Math.ceil(tip / 12 / 50000) * 50000);
    const hs = []; for (let h = step; h < tip; h += step) hs.push(h); hs.push(tip);
    const pts = (await Promise.all(hs.map((h) => get(`hdrs?hMax=${h}&nMax=1`).then((t) => normHdrs(t)[0]).catch(() => null))))
      .filter((r) => r && r.ts).map((r) => [r.height, r.ts]).sort((a, b) => a[0] - b[0]);
    anchors = { tip, pts };
    return anchors;
  }
  function timeAt(h) {
    const pts = anchors && anchors.pts;
    if (!h || !pts || !pts.length) return null;
    const last = pts[pts.length - 1];
    if (h >= last[0]) return last[1] + (h - last[0]) * 60;
    if (h <= pts[0][0]) return pts[0][1] - (pts[0][0] - h) * 60;
    for (let i = 1; i < pts.length; i++) {
      if (h <= pts[i][0]) { const [h0, t0] = pts[i - 1], [h1, t1] = pts[i]; return t0 + ((h - h0) / (h1 - h0)) * (t1 - t0); }
    }
    return null;
  }

  // BANS: the whole registry is one contract-state table, so search, filters, sorting and paging
  // all run in the page; only the table body is redrawn while typing.
  const NAMES_PAGE = 50;
  const ns = { q: '', status: 'All', sale: false, sort: 'name', dir: 1, page: 0, tip: null, list: [], cid: '', regsLoaded: false };
  const STATUS_ORDER = { Active: 0, 'On Hold': 1, Expired: 2 };
  function namesFiltered() {
    const q = ns.q.trim().toLowerCase();
    const rows = ns.list.filter((x) => (!q || x.name.toLowerCase().includes(q)) && (ns.status === 'All' || x.status === ns.status) && (!ns.sale || x.price));
    const key = {
      name: (x) => x.name.toLowerCase(),
      exp: (x) => x.exp || 0,
      reg: (x) => x.reg || 0,
      status: (x) => STATUS_ORDER[x.status] ?? 3,
      price: (x) => (x.price ? (x.price.aid === 0 ? x.price.amount : x.price.amount + 1e18) : Infinity),
    }[ns.sort];
    return rows.sort((a, b) => { const ka = key(a), kb = key(b); return (ka < kb ? -1 : ka > kb ? 1 : a.name.localeCompare(b.name)) * ns.dir; });
  }
  function relHeight(h) {
    if (!h || !ns.tip) return '';
    const at = timeAt(h), s = at ? at - Date.now() / 1000 : (h - ns.tip) * 60, a = Math.abs(s);
    const t = a < 3600 ? `${Math.round(a / 60)}m` : a < 86400 ? `${Math.round(a / 3600)}h` : a < 86400 * 365 ? `${Math.round(a / 86400)}d` : `${(a / 86400 / 365).toFixed(1)}y`;
    return s >= 0 ? `in ${t}` : `${t} ago`;
  }
  // a height with its relative time and date (from the anchors, else a minute a block)
  function heightCell(h, pending = '') {
    if (!h) return pending ? `<span class="dim">${pending}</span>` : '—';
    const t = timeAt(h) || (ns.tip ? Date.now() / 1000 + (h - ns.tip) * 60 : null);
    return `<a href="${blockHref(h)}">${int(h)}</a><div class="dim small">${esc(relHeight(h))}${t ? ` · ${esc(local(t).slice(0, 10))}` : ''}</div>`;
  }
  function namesBody() {
    const rows = namesFiltered(), pages = Math.max(1, Math.ceil(rows.length / NAMES_PAGE));
    ns.page = Math.min(ns.page, pages - 1);
    const slice = rows.slice(ns.page * NAMES_PAGE, (ns.page + 1) * NAMES_PAGE);
    const badge = (s) => `<span class="badge ${s === 'Active' ? 'ok' : s === 'Expired' ? 'bad' : 'pending'}">${esc(s)}</span>`;
    $('#names-body').innerHTML = slice.map((x) => `<tr><td class="mono name-cell">${esc(x.name)}</td><td>${copyHash(x.owner)}</td>
      <td class="num">${heightCell(x.reg, ns.regsLoaded ? '' : '…')}</td>
      <td class="num">${heightCell(x.exp)}</td>
      <td>${badge(x.status)}${x.price ? ' <span class="badge solo">for sale</span>' : ''}</td>
      <td class="num">${x.price ? `${amountOf(x.price.amount, x.price.aid)} <span class="dim">${esc(assetName(x.price.aid))}</span>` : '<span class="dim">—</span>'}</td></tr>`).join('')
      || '<tr><td colspan="6" class="empty">No names match</td></tr>';
    $('#names-count').innerHTML = `<b>${int(rows.length)}</b> of ${int(ns.list.length)}`;
    $('#names-page').textContent = `Page ${ns.page + 1} of ${pages}`;
    $('#names-prev').disabled = ns.page === 0;
    $('#names-next').disabled = ns.page >= pages - 1;
    document.querySelectorAll('#names-filter [data-status]').forEach((b) => b.classList.toggle('on', b.dataset.status === ns.status));
    $('#names-sale').classList.toggle('on', ns.sale);
    document.querySelectorAll('#names-table th[data-sort]').forEach((th) => { th.dataset.dir = th.dataset.sort === ns.sort ? (ns.dir > 0 ? '▲' : '▼') : ''; });
  }

  views.names = async (filter) => {
    const [b, st] = await Promise.all([bansNames(), get('status').catch(() => null)]);
    if (!b.cid) return notFound('The name service contract');
    ns.list = b.names;
    ns.cid = b.cid;
    ns.tip = (st && num(st.height)) || b.h;
    ns.regsLoaded = !!(bansRegs && bansRegs.cid === b.cid);
    if (ns.regsLoaded) ns.list.forEach((x) => { x.reg = bansRegs.map.get(x.name) || null; });
    if (filter != null) { ns.q = String(filter); ns.status = 'All'; ns.sale = false; ns.page = 0; }
    const counts = b.names.reduce((m, x) => ((m[x.status] = (m[x.status] || 0) + 1), m), {});
    const forSale = b.names.filter((x) => x.price).length;
    const th = (key, label, cls = '') => `<th class="${cls} sortable" data-sort="${key}">${label}</th>`;
    return `<div class="page-head"><h1 class="page-title">Names</h1><div class="actions"><a class="btn ghost small" href="${contractHref(b.cid)}">BANS contract</a></div></div>
      <div class="tiles">
        ${tile('Total', int(b.names.length), 'registered names', 'accent')}
        ${tile('Active', int(counts.Active || 0), 'not yet expired')}
        ${tile('On hold', int(counts['On Hold'] || 0), 'grace period after expiry')}
        ${tile('Expired', int(counts.Expired || 0), 'past the expiry height')}
        ${tile('For sale', int(forSale), 'listed with a price')}
      </div>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Beam Anonymous Name Service</h2><div class="panel-meta"><span id="names-count"></span></div></div>
        <div class="names-tools">
          <input id="names-q" class="names-q" placeholder="Search by name…" autocomplete="off" spellcheck="false" aria-label="Search names" value="${esc(ns.q)}">
          <div class="seg" id="names-filter" role="group" aria-label="Status">${['All', 'Active', 'On Hold', 'Expired'].map((s) => `<button type="button" data-status="${s}">${s === 'On Hold' ? 'On hold' : s}</button>`).join('')}</div>
          <div class="seg"><button type="button" id="names-sale">For sale only</button></div>
          <div class="names-pager"><button type="button" class="btn ghost small" id="names-prev">‹ Prev</button><span class="dim" id="names-page"></span><button type="button" class="btn ghost small" id="names-next">Next ›</button></div>
        </div>
        <div class="table-wrap"><table id="names-table"><colgroup><col><col class="w-key"><col class="w-h"><col class="w-h"><col class="w-st"><col class="w-pr"></colgroup><thead><tr>${th('name', 'Name')}<th>Owner key</th>${th('reg', 'Registered', 'num')}${th('exp', 'Expires', 'num')}${th('status', 'Status')}${th('price', 'Sell price', 'num')}</tr></thead>
        <tbody id="names-body"></tbody></table></div>
        <p class="hint" style="margin:12px 0 0">Registration is the latest Register call for the name. Dates of past blocks come from block times; future expiry dates assume a block a minute. Click a key to copy it.</p></section>`;
  };

  function bindNames() {
    const q = $('#names-q');
    if (!q) return;
    namesBody();
    // registrations and block times arrive after the table; redraw when they do
    Promise.all([bansRegistrations(ns.cid), ns.tip ? heightClock(ns.tip) : null]).then(([map]) => {
      ns.list.forEach((x) => { x.reg = map.get(x.name) || null; });
      ns.regsLoaded = true;
      if ($('#names-body')) namesBody();
    }).catch(() => { ns.regsLoaded = true; if ($('#names-body')) namesBody(); });
    q.addEventListener('input', () => { ns.q = q.value; ns.page = 0; namesBody(); });
    $('#names-filter').addEventListener('click', (e) => { const b = e.target.closest('[data-status]'); if (b) { ns.status = b.dataset.status; ns.page = 0; namesBody(); } });
    $('#names-sale').addEventListener('click', () => { ns.sale = !ns.sale; ns.page = 0; namesBody(); });
    $('#names-prev').addEventListener('click', () => { ns.page -= 1; namesBody(); });
    $('#names-next').addEventListener('click', () => { ns.page += 1; namesBody(); });
    $('#names-table thead').addEventListener('click', (e) => {
      const th = e.target.closest('th[data-sort]');
      if (!th) return;
      ns.dir = ns.sort === th.dataset.sort ? -ns.dir : 1;
      ns.sort = th.dataset.sort;
      namesBody();
    });
  }

  views.peers = async () => {
    const list = await get('peers');
    const peers = (Array.isArray(list) ? list : []).filter((p) => typeof p === 'string').map((p) => {
      const m = p.slice(0, 80).match(/^\[?([^\]]+?)\]?:(\d+)$/);
      return m ? { ip: m[1], port: Number(m[2]) } : { ip: p.slice(0, 80), port: null };
    });
    const key = (ip) => (/^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip.split('.').map((n) => n.padStart(3, '0')).join('.') : `z${ip}`);
    peers.sort((x, y) => key(x.ip).localeCompare(key(y.ip)) || (x.port || 0) - (y.port || 0));
    return `<div class="page-head"><h1 class="page-title">Peers</h1></div>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Nodes our node knows</h2><div class="panel-meta"><span>Peers <b>${int(peers.length)}</b></span></div></div>
      ${peers.length ? `<div class="table-wrap"><table class="peer-table"><thead><tr><th>#</th><th>IP address</th><th class="num">Port</th></tr></thead><tbody>
        ${peers.map((x, i) => `<tr><td class="dim">${i + 1}</td><td class="mono">${esc(x.ip)}</td><td class="num mono">${x.port != null ? int(x.port).replace(/,/g, '') : '—'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No peers</div>'}</section>`;
  };

  const API_DOC_RAW = 'https://raw.githubusercontent.com/profinch/bumblebeam/main/explorer/API.md';
  const API_DOC_PAGE = 'https://github.com/profinch/bumblebeam/blob/main/explorer/API.md';
  let apiDoc = null; // { text, at }

  // Inline Markdown: code spans first, everything else escaped, then **bold** and [links](url).
  // Relative links resolve against the file on GitHub; only https links are kept.
  function mdInline(raw, { inTable = false } = {}) {
    const code = (t) => `<code>${inTable ? esc(t).replace(/([/?&=])/g, '$1<wbr>') : esc(t)}</code>`;
    const span = (txt) => txt.split(/(`[^`]+`)/).map((t) => (/^`[^`]+`$/.test(t) ? code(t.slice(1, -1))
      : esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>'))).join('');
    // links first, so their text may hold code: [`/v1/openapi.json`](https://…)
    return raw.split(/(\[[^\]]+\]\([^)\s]+\))/).map((t) => {
      const m = t.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      if (!m) return span(t);
      let url;
      try { url = new URL(m[2], API_DOC_PAGE); } catch (e) { return span(m[1]); }
      return url.protocol === 'https:' ? `<a href="${esc(url.href)}" target="_blank" rel="noopener">${span(m[1])}</a>` : span(m[1]);
    }).join('');
  }


  // The Markdown that API.md uses: headings, fenced code, tables, lists, paragraphs.
  function mdRender(src) {
    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let para = [];
    const flush = () => { if (para.length) out.push(`<p>${mdInline(para.join(' '))}</p>`); para = []; };
    const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => mdInline(c.trim(), { inTable: true }));
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^```/.test(l)) {
        flush();
        const code = [];
        while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
        out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      } else if (/^#{1,4}\s/.test(l)) {
        flush();
        const n = l.match(/^#+/)[0].length;
        out.push(`<h${n + 1}>${mdInline(l.replace(/^#+\s+/, ''))}</h${n + 1}>`);
      } else if (/^\|/.test(l)) {
        flush();
        const rows = [];
        for (; i < lines.length && /^\|/.test(lines[i]); i++) rows.push(lines[i]);
        i--;
        const body = rows.slice(/^\|?[\s:|-]+$/.test(rows[1] || '') ? 2 : 1);
        out.push(`<div class="table-wrap"><table><thead><tr>${cells(rows[0]).map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${
          body.map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      } else if (/^\s*([-*]|\d+\.)\s/.test(l)) {
        flush();
        const ordered = /^\s*\d+\./.test(l), items = [];
        for (; i < lines.length; i++) {
          const m = lines[i].match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
          if (m) items.push(m[1]);
          else if (/^\s+\S/.test(lines[i]) && items.length) items[items.length - 1] += ` ${lines[i].trim()}`;
          else break;
        }
        i--;
        const tag = ordered ? 'ol' : 'ul';
        out.push(`<${tag}>${items.map((x) => `<li>${mdInline(x)}</li>`).join('')}</${tag}>`);
      } else if (!l.trim()) {
        flush();
      } else {
        para.push(l.trim());
      }
    }
    flush();
    return out.join('\n');
  }

  views.api = async () => {
    if (!apiDoc || Date.now() - apiDoc.at > 600000) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      try {
        const r = await fetch(API_DOC_RAW, { signal: ctl.signal, cache: 'no-cache' });
        if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
        apiDoc = { text: (await r.text()).slice(0, 200000), at: Date.now() };
      } catch (e) {
        if (!apiDoc) {
          return `<div class="page-head"><h1 class="page-title">API</h1></div>
            <div class="panel empty err">Could not load the API description from GitHub. Read it at <a href="${API_DOC_PAGE}" target="_blank" rel="noopener">github.com</a>.</div>`;
        }
      } finally {
        clearTimeout(t);
      }
    }
    return `<div class="page-head"><h1 class="page-title">API</h1>
        <div class="actions"><a class="btn ghost" href="${API_DOC_PAGE}" target="_blank" rel="noopener">View on GitHub</a></div></div>
      <section class="panel md">${mdRender(apiDoc.text)}</section>`;
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
    if (['assets', 'contracts', 'peers', 'dex', 'names', 'api'].includes(route)) return { route, arg };
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
      if (route === 'names') bindNames();
      if (route === 'contracts') bindContracts();
      if (route === 'assets') bindAssets();
      if (route === 'dex') bindDex();
      if (scrollTop) window.scrollTo(0, 0);
    } catch (e) {
      if (my === seq) view.innerHTML = `<div class="panel empty err">Could not load: ${esc(e.message)}</div>`;
    }
    setStatus();
  }

  // click-to-copy for shortened hashes: the full value goes to the clipboard and the text says
  // "copied" for a moment, at the same width so the table does not move
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(() => true, () => copyFallback(text));
    return Promise.resolve(copyFallback(text));
  }
  function copyFallback(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }
  view.addEventListener('click', (e) => {
    const el = e.target.closest('.copy[data-copy]');
    if (!el || el.dataset.busy) return;
    const label = el.textContent;
    el.dataset.busy = '1';
    el.style.display = 'inline-block';
    el.style.minWidth = `${el.getBoundingClientRect().width}px`;
    copyText(el.dataset.copy).then((ok) => {
      el.textContent = ok ? 'copied' : 'failed';
      setTimeout(() => { el.textContent = label; el.style.minWidth = ''; el.style.display = ''; delete el.dataset.busy; }, 1200);
    });
  });

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
    // Esc in a search box: clear it (the results follow), and leave it once it is empty
    else if (e.key === 'Escape' && t && t.tagName === 'INPUT' && (t.id === 'search-input' || t.classList.contains('names-q'))) {
      if (t.value) { t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); } else t.blur();
    }
  });
  // The latest blocks refresh every 30 s unless older ones were loaded.
  setInterval(() => {
    // the block list refreshes unless older blocks were loaded without a search to keep up with
    if (document.hidden || parse().route !== 'home' || (bk.rows.length > PAGE && !bkFiltering())) return;
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    render(false);
  }, 30000);
  render(true);
})();
