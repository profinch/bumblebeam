// BumbleBeam API: a clean JSON API (/v1) over Beam's explorer-node and the pool, and an MCP server
// (/mcp) for agents. Node 20+, no dependencies.
//
// explorer-node answers typed documents ({type, value} cells, tables with header rows, amounts in
// the smallest units); /v1 turns them into plain JSON: amounts as decimal strings in whole units
// with each asset's own precision, times as ISO and unix, and the things the explorer UI works out
// itself (BEAM issued, asset decimals, DEX pools, BANS registration heights, block times by height).
'use strict';

const http = require('http');

const PORT = Number(process.env.PORT || 8080);
const EXPLORER = (process.env.EXPLORER_URL || 'http://explorer-node:8888').replace(/\/$/, '');
const POOL = (process.env.POOL_URL || 'http://pool:8080').replace(/\/$/, '');
const PUBLIC = (process.env.PUBLIC_URL || 'https://explorer.bumblebeam.org').replace(/\/$/, '');
const VERSION = '1.0.0';
const GROTH = 100000000n;

// ---------- upstream ----------
async function fetchJson(url, timeoutMs = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new HttpError(502, `upstream answered ${r.status}`);
    return await r.json();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, e.name === 'AbortError' ? 'upstream timed out' : `upstream: ${e.message}`);
  } finally {
    clearTimeout(t);
  }
}
const node = (path, timeoutMs) => fetchJson(`${EXPLORER}/${path}`, timeoutMs);
const pool = (path) => fetchJson(`${POOL}/api/${path}`);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function cached(ms, fn) {
  let at = 0, val = null, pending = null;
  return async () => {
    if (val && Date.now() - at < ms) return val;
    if (!pending) pending = fn().then((v) => { val = v; at = Date.now(); return v; }).finally(() => { pending = null; });
    return pending;
  };
}

// ---------- typed values ----------
const isCell = (x) => x && typeof x === 'object' && !Array.isArray(x) && typeof x.type === 'string' && 'value' in x;
const cv = (c) => (isCell(c) ? c.value : c);
const num = (x) => {
  if (x == null || x === '') return null;
  const n = typeof x === 'string' ? Number(x.replace(/,/g, '')) : Number(x);
  return Number.isFinite(n) ? n : null;
};
const hex = (x, max = 200) => (typeof x === 'string' && /^[0-9a-f]+$/i.test(x) && x.length <= max ? x.toLowerCase() : null);
const rowsOf = (t) => (isCell(t) && Array.isArray(t.value) ? t.value.slice(1).filter(Array.isArray) : []);
const iso = (ts) => (ts ? new Date(ts * 1000).toISOString() : null);

// an integer amount (maybe signed, maybe a string) in units of `ratio` per whole unit -> decimal string
function units(raw, ratio = 100000000) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim(), neg = s.startsWith('-'), digits = s.replace(/^[+-]/, '');
  if (!/^\d+$/.test(digits)) return null;
  const r = Number(ratio) > 0 ? Number(ratio) : 100000000;
  const d = Math.log10(r);
  if (Number.isInteger(d)) {
    const big = BigInt(digits), p = 10n ** BigInt(d);
    const whole = big / p, frac = (big % p).toString().padStart(d, '0').replace(/0+$/, '');
    return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
  }
  return `${neg ? '-' : ''}${Number(digits) / r}`;
}

function meta(text) {
  const out = {};
  if (typeof text !== 'string' || !text.startsWith('STD:')) return out;
  for (const kv of text.slice(4).split(';')) { const i = kv.indexOf('='); if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1); }
  return out;
}

// typed document -> plain JSON; tables with a header row become arrays of objects
function plain(x, scale = 100000000) {
  if (x == null || x === '') return null;
  if (Array.isArray(x)) return x.map((y) => plain(y, scale));
  if (isCell(x)) {
    const v = x.value;
    switch (x.type) {
      case 'aid': return { asset_id: num(v) };
      case 'amount': return units(v, scale);
      case 'blob': case 'cid': return hex(String(v)) || v;
      case 'height': return num(v);
      case 'time': return iso(num(v));
      case 'group': return Array.isArray(v) ? v.map((r) => plainRow(r)) : [];
      case 'table': {
        const rows = Array.isArray(v) ? v : [];
        const head = rows[0] && Array.isArray(rows[0]) && rows[0].every((c) => isCell(c) && c.type === 'th') ? rows[0].map((c) => String(c.value)) : null;
        const body = head ? rows.slice(1) : rows;
        if (head) {
          const extra = body.reduce((w, r) => Math.max(w, ...(isCell(r) && r.type === 'group' ? (r.value || []) : [r]).map((x) => (Array.isArray(x) ? x.length : 0))), 0);
          // explorer-node's call histories leave Emission out of the header
          if (extra === head.length + 1 && head.includes('Funds') && head[head.length - 1] === 'Keys' && !head.includes('Emission')) head.splice(head.length - 1, 0, 'Emission');
        }
        return body.map((r) => {
          if (isCell(r) && r.type === 'group') return { calls: (r.value || []).map((sub) => (head ? objRow(head, sub) : plainRow(sub))) };
          return head ? objRow(head, r) : plainRow(r);
        });
      }
      default: return plain(v, scale);
    }
  }
  if (typeof x === 'object') { const o = {}; for (const [k, v] of Object.entries(x)) o[k] = plain(v, scale); return o; }
  return x;
}
const rowScale = (r) => { const a = Array.isArray(r) ? r.find((c) => isCell(c) && c.type === 'aid') : null; return a ? scaleOf(num(a.value)) : 100000000; };
// rows without a header: [asset, amount] pairs (funds, emission, locked funds) become objects
function plainRow(r) {
  const sc = rowScale(r);
  if (Array.isArray(r) && r.length === 2 && isCell(r[0]) && r[0].type === 'aid' && isCell(r[1]) && r[1].type === 'amount') return { asset_id: num(r[0].value), amount: plain(r[1], sc) };
  return Array.isArray(r) ? r.map((c) => plain(c, sc)) : plain(r);
}
function objRow(head, r) {
  const o = {}, sc = rowScale(r), cells = Array.isArray(r) ? r : [r];
  head.forEach((h, i) => { o[h || `col${i}`] = plain(cells[i], sc); });
  for (let i = head.length; i < cells.length; i++) o[`col${i}`] = plain(cells[i], sc);
  return o;
}

// ---------- assets ----------
const DECIMALS = 8, MAX_BEAM = 262800000;
const assetIndex = cached(600000, async () => {
  const t = await node('assets', 30000);
  const list = rowsOf(t).map((r) => {
    const m = meta(cv(r[5]));
    const ratio = m.NTH_RATIO != null ? num(m.NTH_RATIO) : null;
    const scale = ratio > 0 ? ratio : 100000000;
    return {
      asset_id: num(cv(r[0])), name: m.N || null, ticker: m.SN || null, unit: m.UN || null, smallest_unit: m.NTHUN || null,
      nth_ratio: ratio, decimals: ratio == null ? DECIMALS : ratio > 0 && Number.isInteger(Math.log10(ratio)) ? Math.log10(ratio) : null,
      supply: units(cv(r[3]), scale), supply_raw: String(cv(r[3]) ?? ''), owner_key: hex(cv(r[1])), deposit_beam: units(cv(r[2])),
      lock_height: num(cv(r[4])), short_description: m.OPT_SHORT_DESC || null, long_description: m.OPT_LONG_DESC || null,
      site_url: https(m.OPT_SITE_URL), docs_url: https(m.OPT_PDF_URL), logo_url: https(m.OPT_LOGO_URL), metadata: typeof cv(r[5]) === 'string' ? cv(r[5]) : null,
      _scale: scale,
    };
  }).filter((a) => a.asset_id != null);
  return { height: num(t && t.h), list, byId: new Map(list.map((a) => [a.asset_id, a])) };
});
let scaleCache = new Map();
const scaleOf = (aid) => (aid == null || aid === 0 ? 100000000 : scaleCache.get(aid) || 100000000);
async function loadScales() { const ix = await assetIndex(); scaleCache = new Map(ix.list.map((a) => [a.asset_id, a._scale])); return ix; }
const https = (u) => (typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/.test(u) ? u : null);
const assetName = (aid, ix) => (aid === 0 ? 'BEAM' : (ix && ix.byId.get(aid) && (ix.byId.get(aid).ticker || ix.byId.get(aid).name)) || `#${aid}`);
const publicAsset = (a) => { const { _scale, ...rest } = a; return rest; };

function beamIssued(h) {
  if (!h) return null;
  const Y = 525600, C = 4 * Y;
  let total = BigInt(Math.min(h, Y)) * 100n * GROTH, from = Y, per = 50n * GROTH;
  while (from < h && per > 0n) { total += BigInt(Math.min(h - from, C)) * per; from += C; per /= 2n; }
  return units(total.toString());
}

// ---------- contracts, DEX, BANS ----------
function kindOf(k) {
  if (typeof k === 'string') return { kind: k, shader: null };
  if (k && typeof k === 'object' && typeof k.Wrapper === 'string') return { kind: k.Wrapper, shader: hex(cv(k.subtype)) };
  return { kind: null, shader: hex(cv(k)) };
}
const contractIndex = cached(600000, async () => {
  await loadScales();
  const t = await node('contracts', 30000);
  return rowsOf(t).map((r) => {
    const { kind, shader } = kindOf(r[1]);
    const locked = (isCell(r[3]) && Array.isArray(r[3].value) ? r[3].value : []).map((x) => ({ asset_id: num(cv(x[0])), amount: units(cv(x[1]), scaleOf(num(cv(x[0])))) }));
    const owned = (isCell(r[4]) && Array.isArray(r[4].value) ? r[4].value : []).map((x) => { const m = meta(cv(x[1])); return { asset_id: num(cv(x[0])), name: m.N || null, ticker: m.SN || null, emission: units(cv(x[2]), scaleOf(num(cv(x[0])))) }; });
    return { contract_id: hex(cv(r[0])), kind, shader, deployed_height: num(cv(r[2])), locked_funds: locked, owned_assets: owned };
  }).filter((c) => c.contract_id);
});
const findKind = async (re) => ((await contractIndex()).find((c) => c.kind && re.test(c.kind)) || {}).contract_id || null;
const stateOf = (cid) => node(`contract?id=${cid}&nMaxTxs=0&funds_locked=0&assets_owned=0&ver_info=0`, 30000);

const FEE_TIER = { Low: '0.05%', Medium: '0.3%', High: '1%' };
const dexPools = cached(60000, async () => {
  const ix = await loadScales();
  const cid = await findKind(/^DEX\b/);
  if (!cid) return { contract_id: null, pools: [] };
  const d = await stateOf(cid);
  const pools = rowsOf(d && d.State && d.State.Pools).map((r) => {
    const a1 = num(cv(r[0])), a2 = num(cv(r[1])), lp = num(cv(r[3]));
    return {
      asset1: a1, asset1_name: assetName(a1, ix), asset2: a2, asset2_name: assetName(a2, ix), volatility: typeof r[2] === 'string' ? r[2] : null,
      fee: FEE_TIER[r[2]] || null, lp_token: lp, reserve1: units(cv(r[4]), scaleOf(a1)), reserve2: units(cv(r[5]), scaleOf(a2)),
      lp_supply: units(cv(r[6]), scaleOf(lp)), rate_1_2: num(cv(r[7])), rate_2_1: num(cv(r[8])),
    };
  }).filter((x) => x.asset1 != null);
  return { contract_id: cid, pools };
});

const bansState = cached(120000, async () => {
  const cid = await findKind(/^Bans\b/);
  if (!cid) return { contract_id: null, names: [] };
  const d = await stateOf(cid);
  const names = rowsOf(d && d.State && d.State.Domains).map((r) => ({
    name: typeof r[0] === 'string' ? r[0] : null, owner_key: hex(cv(r[1])), expires_height: num(cv(r[2])),
    status: typeof r[3] === 'string' && r[3] ? r[3] : 'Active',
    sell_price: Array.isArray(r[4]) && r[4].length === 2 ? { asset_id: num(cv(r[4][0])), amount: units(cv(r[4][1]), scaleOf(num(cv(r[4][0])))) } : null,
  })).filter((x) => x.name);
  return { contract_id: cid, names };
});
const bansRegistrations = cached(600000, async () => {
  const { contract_id: cid } = await bansState();
  const map = new Map();
  if (!cid) return map;
  let hMax = null;
  for (let i = 0; i < 20; i++) {
    const d = await node(`contract?id=${cid}&nMaxTxs=100000&state=0&assets_owned=0&funds_locked=0&ver_info=0${hMax != null ? `&hMax=${hMax}` : ''}`, 60000);
    const t = d && d['Calls history'];
    for (const g of (isCell(t) && Array.isArray(t.value) ? t.value.slice(1) : [])) {
      const first = isCell(g) && g.type === 'group' && Array.isArray(g.value) ? g.value[0] : g;
      if (!Array.isArray(first) || first[3] !== 'Register') continue;
      const h = num(cv(first[0])), name = first[4] && typeof first[4].name === 'string' ? first[4].name : '';
      if (h != null && name && !(map.get(name) > h)) map.set(name, h);
    }
    hMax = t && t.more ? num(t.more.hMax) : null;
    if (hMax == null) break;
  }
  return map;
});

// ---------- block heights -> time ----------
const status = cached(15000, () => node('status'));
const anchors = cached(3600000, async () => {
  const st = await status(), tip = num(st.height) || 0;
  const step = Math.max(50000, Math.ceil(tip / 12 / 50000) * 50000), hs = [];
  for (let h = step; h < tip; h += step) hs.push(h);
  hs.push(tip);
  const pts = (await Promise.all(hs.map((h) => node(`hdrs?hMax=${h}&nMax=1`).then((t) => { const r = rowsOf(t)[0]; return r ? [num(cv(r[0])), num(cv(r[2]))] : null; }).catch(() => null))))
    .filter((p) => p && p[0] != null && p[1]).sort((a, b) => a[0] - b[0]);
  return pts;
});
async function timeAt(h) {
  const pts = await anchors();
  if (!h || !pts.length) return null;
  const last = pts[pts.length - 1];
  if (h >= last[0]) return Math.round(last[1] + (h - last[0]) * 60);
  if (h <= pts[0][0]) return Math.round(pts[0][1] - (pts[0][0] - h) * 60);
  for (let i = 1; i < pts.length; i++) if (h <= pts[i][0]) { const [h0, t0] = pts[i - 1], [h1, t1] = pts[i]; return Math.round(t0 + ((h - h0) / (h1 - h0)) * (t1 - t0)); }
  return null;
}

// ---------- /v1 handlers ----------
const clampLimit = (v, d, max) => Math.max(1, Math.min(max, Number(v) || d));
function headerRow(r) {
  return { height: num(cv(r[0])), hash: hex(cv(r[1])), time: iso(num(cv(r[2]))), timestamp: num(cv(r[2])), difficulty: num(cv(r[3])),
    fees_beam: units(cv(r[4])), transactions: num(cv(r[5])), outputs: num(cv(r[6])) || 0, inputs: num(cv(r[7])) || 0,
    shielded_outputs: num(cv(r[8])) || 0, shielded_inputs: num(cv(r[9])) || 0, contract_calls: num(cv(r[10])) || 0 };
}

async function v1Status() {
  const st = await node('status');
  return { height: num(st.height), hash: hex(st.hash), time: iso(num(st.timestamp)), timestamp: num(st.timestamp), peers: num(st.peers_count),
    chainwork: st.chainwork || null, shielded_outputs_24h: num(st.shielded_outputs_per_24h), shielded_outputs_total: num(st.shielded_outputs_total) };
}

async function v1Blocks(q) {
  const limit = clampLimit(q.get('limit'), 20, 500);
  const before = q.get('before') ? Number(q.get('before')) : null;
  const top = before != null ? before - 1 : num((await status()).height);
  const t = await node(`hdrs?hMax=${top}&nMax=${limit}`);
  const blocks = rowsOf(t).slice(0, limit).map(headerRow);
  return { blocks, next_before: blocks.length ? blocks[blocks.length - 1].height : null };
}

async function v1Block(height) {
  if (!/^\d{1,10}$/.test(height)) throw new HttpError(400, 'height must be a number');
  await loadScales();
  const b = await node(`block?height=${Number(height)}`);
  if (!b || b.found === false) throw new HttpError(404, `block ${height} not found`);
  return normBlock(b);
}
function normBlock(b) {
  const kernels = (b.kernels || []).map((k) => {
    const extra = Object.fromEntries(Object.entries(k).filter(([key]) => !['id', 'fee', 'minHeight', 'maxHeight'].includes(key)).map(([key, v]) => [key, plain(v)]));
    return { id: hex(k.id), fee_beam: units(k.fee), min_height: num(k.minHeight), max_height: num(k.maxHeight), ...(Object.keys(extra).length ? { data: extra } : {}) };
  });
  return {
    height: num(b.height), hash: hex(b.hash), previous: hex(b.prev), time: iso(num(b.timestamp)), timestamp: num(b.timestamp),
    difficulty: num(b.difficulty), chainwork: b.chainwork || null, reward_beam: units(b.subsidy),
    fees_beam: units((b.kernels || []).reduce((s, k) => s + BigInt(Math.round(num(k.fee) || 0)), 0n).toString()),
    kernels,
    outputs: (b.outputs || []).map((o) => ({ commitment: hex(o.commitment), coinbase: o.type === 'Coinbase', value_beam: o.type === 'Coinbase' ? units(o.Value) : null, maturity_height: num(o.Maturity), spent_height: num(o.spent) })),
    inputs: (b.inputs || []).map((i) => ({ commitment: hex(i.commitment), created_height: num(i.height) })),
  };
}

async function v1Kernel(id) {
  const k = hex(id, 64);
  if (!k || k.length !== 64) throw new HttpError(400, 'kernel id must be 64 hex characters');
  await loadScales();
  const b = await node(`block?kernel=${k}`);
  const blk = b && b.found !== false ? normBlock(b) : null;
  const kern = blk && blk.kernels.find((x) => x.id === k);
  if (!kern) throw new HttpError(404, `kernel ${k} not found`);
  return { kernel: kern, block: { height: blk.height, hash: blk.hash, time: blk.time } };
}

async function v1Supply() {
  const st = await status();
  return { asset_id: 0, ticker: 'BEAM', decimals: DECIMALS, height: num(st.height), issued: beamIssued(num(st.height)), max_supply: String(MAX_BEAM),
    note: 'issued by the emission schedule: 100 BEAM a block in year one, 50 in years two to five, then half every four years (miners and treasury together)' };
}

async function v1Assets(q) {
  const ix = await loadScales();
  const query = (q.get('q') || '').trim().toLowerCase().replace(/^#/, '');
  const beam = { asset_id: 0, name: 'Beam', ticker: 'BEAM', unit: 'BEAM', decimals: DECIMALS, supply: beamIssued(ix.height), native: true };
  const list = [beam, ...ix.list.map(publicAsset)]
    .filter((a) => !query || String(a.asset_id) === query || [a.name, a.ticker, a.unit].some((x) => x && x.toLowerCase().includes(query)) || (query.length >= 6 && a.owner_key && a.owner_key.includes(query)));
  return { assets: list.map(({ metadata, long_description, ...a }) => a), count: list.length };
}

async function v1Asset(id) {
  if (!/^\d{1,10}$/.test(id)) throw new HttpError(400, 'asset id must be a number');
  const aid = Number(id);
  const [ix, dex] = await Promise.all([loadScales(), dexPools()]);
  const pools = dex.pools.filter((p) => (p.asset1 === aid || p.asset2 === aid || p.lp_token === aid) && (Number(p.reserve1) || Number(p.reserve2)));
  if (aid === 0) {
    const cs = await contractIndex();
    const locked = cs.reduce((s, c) => s + c.locked_funds.filter((x) => x.asset_id === 0).reduce((t, x) => t + BigInt(Math.round(Number(x.amount) * 1e8)), 0n), 0n);
    return { ...(await v1Supply()), name: 'Beam', native: true, locked_in_contracts: units(locked.toString()), dex_pools: pools };
  }
  const a = ix.byId.get(aid);
  const d = await node(`asset?id=${aid}&nMaxOps=100`, 30000);
  if (!a && !(rowsOf(d && d['Asset history']).length)) throw new HttpError(404, `asset ${aid} not found`);
  return { ...(a ? publicAsset(a) : { asset_id: aid }), history: plain(d && d['Asset history'], scaleOf(aid)), distribution: plain(d && d['Asset distribution'], scaleOf(aid)), dex_pools: pools };
}

async function v1Pools(q) {
  const dex = await dexPools();
  const asset = q.get('asset'), tier = q.get('tier'), all = q.get('all') === '1';
  const pools = dex.pools.filter((p) => (all || Number(p.reserve1) || Number(p.reserve2))
    && (!tier || (p.volatility || '').toLowerCase() === tier.toLowerCase())
    && (asset == null || asset === '' || [p.asset1, p.asset2, p.lp_token].map(String).includes(asset) || [p.asset1_name, p.asset2_name].some((n) => n.toLowerCase() === asset.toLowerCase())));
  return { contract_id: dex.contract_id, pools, count: pools.length };
}

async function v1Names(q) {
  await loadScales();
  const [b, regs] = await Promise.all([bansState(), bansRegistrations().catch(() => new Map())]);
  const query = (q.get('q') || '').trim().toLowerCase(), st = (q.get('status') || '').toLowerCase(), sale = q.get('for_sale') === '1';
  const tip = num((await status()).height);
  const names = await Promise.all(b.names
    .filter((x) => (!query || x.name.toLowerCase().includes(query)) && (!st || x.status.toLowerCase().replace(' ', '_') === st) && (!sale || x.sell_price))
    .map(async (x) => {
      const reg = regs.get(x.name) || null;
      return { ...x, registered_height: reg, registered_time: iso(await timeAt(reg)), expires_time: iso(x.expires_height > tip ? (await timeAt(tip)) + (x.expires_height - tip) * 60 : await timeAt(x.expires_height)) };
    }));
  return { contract_id: b.contract_id, names, count: names.length };
}

async function v1Name(name) {
  const r = await v1Names(new URLSearchParams({ q: name }));
  const n = r.names.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
  if (!n) throw new HttpError(404, `name ${name} not found`);
  return n;
}

async function v1Contracts(q) {
  const cs = await contractIndex();
  const query = (q.get('q') || '').trim().toLowerCase(), kind = (q.get('kind') || '').toLowerCase();
  const list = cs.filter((c) => (!query || c.contract_id.includes(query) || (c.kind || '').toLowerCase().includes(query) || (c.shader || '').includes(query))
    && (!kind || (c.kind || '').toLowerCase().startsWith(kind)));
  return { contracts: list, count: list.length };
}

async function v1Contract(id, q) {
  const cid = hex(id, 64);
  if (!cid || cid.length !== 64) throw new HttpError(400, 'contract id must be 64 hex characters');
  await loadScales();
  const limit = clampLimit(q.get('calls'), 20, 500);
  const d = await node(`contract?id=${cid}&nMaxTxs=${limit}`, 30000);
  const versions = plain(d && d['Version History']) || [];
  if (!versions.length) throw new HttpError(404, `contract ${cid} not found`);
  const { kind, shader } = kindOf(d.kind);
  const calls = d['Calls history'];
  return {
    contract_id: cid, kind, shader, versions, state: plain(d.State), locked_funds: plain(d['Locked Funds']), owned_assets: plain(d['Owned assets']),
    calls: plain(calls), calls_next_before: calls && calls.more ? num(calls.more.hMax) : null,
  };
}

async function v1Search(qs) {
  const raw = (qs.get('q') || '').trim();
  const q = raw.replace(/[\s,]+/g, '');
  if (!q) throw new HttpError(400, 'q is required');
  if (/^\d{1,10}$/.test(q)) return { type: 'block', height: Number(q), url: `${PUBLIC}/v1/blocks/${Number(q)}` };
  const am = raw.match(/^(?:asset\s*|#|a)(\d{1,10})$/i);
  if (am) return { type: 'asset', asset_id: Number(am[1]), url: `${PUBLIC}/v1/assets/${am[1]}` };
  const h = hex(q, 64);
  if (h && h.length === 64) {
    const b = await node(`block?kernel=${h}`).catch(() => null);
    if (b && b.found !== false && (b.kernels || []).some((k) => k.id === h)) return { type: 'kernel', id: h, block_height: num(b.height), url: `${PUBLIC}/v1/kernels/${h}` };
    const c = await node(`contract?id=${h}&nMaxTxs=1&state=0&assets_owned=0&funds_locked=0`).catch(() => null);
    if (c && rowsOf(c['Version History']).length) return { type: 'contract', id: h, url: `${PUBLIC}/v1/contracts/${h}` };
    return { type: 'none', note: 'not a known kernel or contract; Beam\'s API has no block lookup by hash' };
  }
  const l = raw.toLowerCase();
  if (l === 'beam') return { type: 'asset', asset_id: 0, url: `${PUBLIC}/v1/assets/0` };
  const ix = await loadScales();
  const assets = ix.list.filter((a) => [a.ticker, a.unit, a.name].some((y) => y && y.toLowerCase() === l));
  if (assets.length) return { type: 'assets', assets: assets.map((a) => ({ asset_id: a.asset_id, name: a.name, ticker: a.ticker })) };
  const b = await bansState();
  const n = b.names.find((x) => x.name.toLowerCase() === l);
  if (n) return { type: 'name', name: n.name, url: `${PUBLIC}/v1/names/${encodeURIComponent(n.name)}` };
  const cs = (await contractIndex()).filter((c) => c.kind && c.kind.toLowerCase().startsWith(l));
  if (cs.length) return { type: 'contracts', contracts: cs.map((c) => ({ contract_id: c.contract_id, kind: c.kind, url: `${PUBLIC}/v1/contracts/${c.contract_id}` })) };
  return { type: 'none' };
}

async function v1Peers() {
  const list = await node('peers');
  return { peers: (Array.isArray(list) ? list : []).filter((p) => typeof p === 'string').map((p) => { const m = p.match(/^\[?([^\]]+?)\]?:(\d+)$/); return m ? { ip: m[1], port: Number(m[2]) } : { ip: p, port: null }; }) };
}

// ---------- routing ----------
const ROUTES = [
  ['/v1', () => index()],
  ['/v1/openapi.json', () => OPENAPI],
  ['/v1/status', () => v1Status()],
  ['/v1/supply', () => v1Supply()],
  ['/v1/search', (m, q) => v1Search(q)],
  ['/v1/blocks', (m, q) => v1Blocks(q)],
  [/^\/v1\/blocks\/([^/]+)$/, (m) => v1Block(m[1])],
  [/^\/v1\/kernels\/([^/]+)$/, (m) => v1Kernel(m[1])],
  ['/v1/assets', (m, q) => v1Assets(q)],
  [/^\/v1\/assets\/([^/]+)$/, (m) => v1Asset(m[1])],
  ['/v1/dex/pools', (m, q) => v1Pools(q)],
  ['/v1/names', (m, q) => v1Names(q)],
  [/^\/v1\/names\/([^/]+)$/, (m) => v1Name(decodeURIComponent(m[1]))],
  ['/v1/contracts', (m, q) => v1Contracts(q)],
  [/^\/v1\/contracts\/([^/]+)$/, (m, q) => v1Contract(m[1], q)],
  ['/v1/peers', () => v1Peers()],
];
function index() {
  return { name: 'BumbleBeam API', version: VERSION, docs: 'https://github.com/profinch/bumblebeam/blob/main/explorer/API.md', openapi: `${PUBLIC}/v1/openapi.json`, mcp: `${PUBLIC}/mcp`,
    endpoints: ROUTES.map(([p]) => (typeof p === 'string' ? p : p.source.replace(/\\\//g, '/').replace(/^\^|\$$/g, '').replace('([^/]+)', '{id}'))) };
}

// ---------- MCP (Streamable HTTP, stateless, JSON responses) ----------
const MCP_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const str = (description) => ({ type: 'string', description });
const intp = (description) => ({ type: 'integer', description });
const TOOLS = [
  ['explorer_status', 'Beam chain tip as seen by BumbleBeam\'s own node: height, hash, time, peers, shielded output counts.', {}, () => v1Status()],
  ['explorer_search', 'Resolve anything: a block height, kernel ID, contract ID, asset number (#7), asset name or ticker, or a BANS name.', { q: str('what to look up') }, (a) => v1Search(new URLSearchParams({ q: a.q || '' })), ['q']],
  ['explorer_latest_blocks', 'Latest Beam block headers, newest first: height, hash, time, difficulty, transactions, outputs/inputs, shielded counts, contract calls, fees.', { limit: intp('how many, 1-500 (default 20)'), before: intp('only blocks below this height, for paging') }, (a) => v1Blocks(new URLSearchParams(Object.entries(a).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])))],
  ['explorer_block', 'One Beam block by height: hash, time, reward, fees, kernels (with decoded contract calls), outputs and inputs. Amounts and parties stay private by design.', { height: intp('block height') }, (a) => v1Block(String(a.height)), ['height']],
  ['explorer_kernel', 'A transaction kernel by its 64-hex ID: fee, valid heights, decoded contract calls and the block it is in.', { id: str('kernel ID, 64 hex characters') }, (a) => v1Kernel(String(a.id || '')), ['id']],
  ['explorer_supply', 'BEAM supply: issued so far by the emission schedule and the maximum (262,800,000).', {}, () => v1Supply()],
  ['explorer_assets', 'Confidential assets on Beam with decimals, supply in whole units, issuer key and descriptions. Filter with a query (name, ticker, #id, key).', { q: str('optional filter') }, (a) => v1Assets(new URLSearchParams({ q: a.q || '' }))],
  ['explorer_asset', 'One asset by ID (0 is BEAM): metadata, decimals, supply, history, which contracts hold it, its DEX pools.', { id: intp('asset ID') }, (a) => v1Asset(String(a.id)), ['id']],
  ['explorer_dex_pools', 'Liquidity pools of Beam\'s on-chain DEX: pair, fee tier, reserves in whole units, rates, LP token.', { asset: str('optional asset ID or ticker'), tier: str('optional Low, Medium or High'), all: { type: 'boolean', description: 'include empty pools' } }, (a) => v1Pools(new URLSearchParams({ ...(a.asset != null ? { asset: String(a.asset) } : {}), ...(a.tier ? { tier: a.tier } : {}), ...(a.all ? { all: '1' } : {}) }))],
  ['explorer_names', 'BANS (Beam Anonymous Name Service) names: owner key, status, registration and expiry heights and dates, sale price.', { q: str('optional name filter'), status: str('optional active, on_hold or expired'), for_sale: { type: 'boolean', description: 'only names listed for sale' } }, (a) => v1Names(new URLSearchParams({ q: a.q || '', status: a.status || '', ...(a.for_sale ? { for_sale: '1' } : {}) }))],
  ['explorer_contracts', 'Deployed Beam contracts: kind (when Beam\'s parser knows it), shader hash, deployment height, locked funds, owned assets.', { q: str('optional filter by kind, ID or shader'), kind: str('optional kind prefix, e.g. DEX') }, (a) => v1Contracts(new URLSearchParams({ q: a.q || '', kind: a.kind || '' }))],
  ['explorer_contract', 'One contract by ID: decoded state, locked funds, owned assets, versions and recent calls.', { id: str('contract ID, 64 hex characters'), calls: intp('how many recent calls, 1-500 (default 20)') }, (a) => v1Contract(String(a.id || ''), new URLSearchParams(a.calls ? { calls: String(a.calls) } : {})), ['id']],
  ['pool_stats', 'BumbleBeam pool statistics: hashrate (Sol/s), miners, workers, blocks in 24h, effort, fee, payout settings and the hashrate chart.', { range: str('optional chart range: 24h, 7d or 30d') }, (a) => pool(`stats${a.range ? `?range=${encodeURIComponent(a.range)}` : ''}`)],
  ['pool_blocks', 'Blocks found by the BumbleBeam pool, newest first, with status, confirmations, effort and finder.', { limit: intp('how many, 1-500 (default 50)'), before: intp('only blocks below this height') }, (a) => pool(`blocks?limit=${clampLimit(a.limit, 50, 500)}${a.before ? `&before=${Number(a.before)}` : ''}`)],
  ['pool_miner', 'One miner on the BumbleBeam pool by payout address: hashrate, unpaid and immature balance, paid total, workers, payments, blocks found.', { address: str('the miner\'s Beam payout address'), range: str('optional chart range: 24h, 7d or 30d') }, (a) => pool(`miners/${encodeURIComponent(String(a.address || '').replace(/\s+/g, ''))}${a.range ? `?range=${encodeURIComponent(a.range)}` : ''}`), ['address']],
  ['pool_miners', 'Top miners on the BumbleBeam pool by hashrate (no addresses: Beam is private).', { limit: intp('how many, 1-500 (default 50)') }, (a) => pool(`miners?limit=${clampLimit(a.limit, 50, 500)}`)],
  ['pool_payments', 'Payout runs of the BumbleBeam pool with amounts and kernels.', { limit: intp('how many, 1-500 (default 50)') }, (a) => pool(`payments?limit=${clampLimit(a.limit, 50, 500)}`)],
  ['pool_network', 'Beam network numbers and every Beam mining pool with hashrate and blocks in 24h, as the pool sees them.', {}, () => pool('network')],
  ['pool_health', 'Whether the BumbleBeam pool is up and has work from its node.', {}, () => pool('health')],
].map(([name, description, properties, run, required]) => ({ name, description, inputSchema: { type: 'object', properties, ...(required ? { required } : {}), additionalProperties: false }, run, annotations: { readOnlyHint: true, openWorldHint: true } }));

// two MCP servers on one process: the explorer's (/mcp) knows the chain, the pool's (/mcp/pool,
// served as pool.bumblebeam.org/mcp) knows mining on BumbleBeam
const MCP_SERVERS = {
  explorer: {
    tools: TOOLS.filter((t) => t.name.startsWith('explorer_')),
    info: { name: 'bumblebeam-explorer', title: 'BumbleBeam Explorer: the Beam blockchain', version: VERSION },
    instructions: 'Read-only tools for the Beam (BEAM) blockchain via BumbleBeam\'s own archival explorer node. Beam is private: no addresses, balances or transfer amounts are on the chain; blocks, kernels, assets, contracts, DEX pools and BANS names are. For mining on BumbleBeam use https://pool.bumblebeam.org/mcp.',
  },
  pool: {
    tools: TOOLS.filter((t) => t.name.startsWith('pool_')),
    info: { name: 'bumblebeam-pool', title: 'BumbleBeam Pool: Beam mining', version: VERSION },
    instructions: 'Read-only tools for the BumbleBeam mining pool for Beam (BEAM, BeamHash III, PPLNS): pool and network stats, blocks the pool found, a miner by payout address (hashrate, balances, workers, payments), payouts, health. Hashrate is in Sol/s, amounts in BEAM. For the blockchain itself use https://explorer.bumblebeam.org/mcp.',
  },
};

async function mcp(msg, server = MCP_SERVERS.explorer) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'invalid request');
  const isNotification = msg.id === undefined;
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params && msg.params.protocolVersion;
      return reply({ protocolVersion: MCP_PROTOCOLS.includes(asked) ? asked : MCP_PROTOCOLS[0], capabilities: { tools: { listChanged: false } },
        serverInfo: server.info, instructions: server.instructions });
    }
    case 'notifications/initialized': case 'notifications/cancelled': return null;
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: server.tools.map(({ run, ...t }) => t) });
    case 'tools/call': {
      const tool = server.tools.find((t) => t.name === (msg.params && msg.params.name));
      if (!tool) return fail(-32602, `unknown tool ${msg.params && msg.params.name}`);
      try {
        const out = await tool.run((msg.params && msg.params.arguments) || {});
        return reply({ content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: Array.isArray(out) ? { items: out } : out, isError: false });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
      }
    }
    default: return isNotification ? null : fail(-32601, `method not found: ${msg.method}`);
  }
}

// ---------- OpenAPI ----------
const p = (name, where, description, type = 'string') => ({ name, in: where, required: where === 'path', description, schema: { type } });
const op = (summary, params = []) => ({ get: { summary, parameters: params, responses: { 200: { description: 'JSON' }, 400: { description: 'bad parameter' }, 404: { description: 'not found' }, 502: { description: 'the node did not answer' } } } });
const OPENAPI = {
  openapi: '3.1.0',
  info: { title: 'BumbleBeam API', version: VERSION, description: 'Plain JSON for the Beam blockchain from BumbleBeam\'s own explorer node. Amounts are decimal strings in whole units with each asset\'s own precision; times are ISO 8601 and unix seconds. Read-only, no key, rate-limited per IP.' },
  servers: [{ url: PUBLIC }],
  paths: {
    '/v1/status': op('Chain tip, peers, shielded counts'),
    '/v1/supply': op('BEAM issued and maximum supply'),
    '/v1/search': op('Resolve a height, kernel, contract, asset or BANS name', [p('q', 'query', 'what to look up')]),
    '/v1/blocks': op('Block headers, newest first', [p('limit', 'query', '1-500, default 20', 'integer'), p('before', 'query', 'only blocks below this height', 'integer')]),
    '/v1/blocks/{height}': op('One block', [p('height', 'path', 'block height', 'integer')]),
    '/v1/kernels/{id}': op('A kernel and its block', [p('id', 'path', '64 hex characters')]),
    '/v1/assets': op('Confidential assets', [p('q', 'query', 'filter: name, ticker, #id or owner key')]),
    '/v1/assets/{id}': op('One asset (0 is BEAM)', [p('id', 'path', 'asset ID', 'integer')]),
    '/v1/dex/pools': op('DEX liquidity pools', [p('asset', 'query', 'asset ID or ticker'), p('tier', 'query', 'Low, Medium or High'), p('all', 'query', '1 to include empty pools')]),
    '/v1/names': op('BANS names', [p('q', 'query', 'name filter'), p('status', 'query', 'active, on_hold or expired'), p('for_sale', 'query', '1 for names listed for sale')]),
    '/v1/names/{name}': op('One BANS name', [p('name', 'path', 'the name')]),
    '/v1/contracts': op('Deployed contracts', [p('q', 'query', 'filter by kind, ID or shader'), p('kind', 'query', 'kind prefix')]),
    '/v1/contracts/{id}': op('One contract', [p('id', 'path', '64 hex characters'), p('calls', 'query', 'recent calls, 1-500', 'integer')]),
    '/v1/peers': op('Peers of the node'),
  },
};

// ---------- server ----------
function send(res, status, body, extra = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache', ...extra });
  res.end(data);
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/mcp' || url.pathname === '/mcp/pool') {
      const server = url.pathname === '/mcp/pool' ? MCP_SERVERS.pool : MCP_SERVERS.explorer;
      if (req.method === 'OPTIONS') return send(res, 204, {}, { 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, Accept' });
      if (req.method !== 'POST') return send(res, 405, { error: 'POST JSON-RPC to /mcp (Streamable HTTP, stateless)' }, { Allow: 'POST' });
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 1e6) return send(res, 413, { error: 'too large' }); }
      let msg;
      try { msg = JSON.parse(body); } catch (e) { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
      if (Array.isArray(msg)) {
        const out = (await Promise.all(msg.map((m) => mcp(m, server)))).filter(Boolean);
        return out.length ? send(res, 200, out) : (res.writeHead(202), res.end());
      }
      const out = await mcp(msg, server);
      return out ? send(res, 200, out) : (res.writeHead(202), res.end());
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'GET only' });
    const path = url.pathname.replace(/\/+$/, '') || '/';
    for (const [pattern, fn] of ROUTES) {
      const m = typeof pattern === 'string' ? (path === pattern ? [path] : null) : path.match(pattern);
      if (m) return send(res, 200, await fn(m, url.searchParams));
    }
    send(res, 404, { error: 'no such endpoint', see: `${PUBLIC}/v1` });
  } catch (e) {
    send(res, e.status || 500, { error: e.status ? e.message : 'internal error' });
    if (!e.status) console.error(e);
  }
});
server.listen(PORT, () => console.log(`bumblebeam api on :${PORT}, explorer ${EXPLORER}, pool ${POOL}`));
