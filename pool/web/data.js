// bumblebeam pool web UI: data layer.
//
// Two sources:
//  - the pool's own API (pool/API.md) at the page's origin. From localhost, ?api=<url> points the
//    UI at another server; on a public host the parameter is ignored, so a crafted link cannot
//    feed the page foreign data.
//  - live Beam network data: the pool server's /api/network and /api/network/blocks (our node, and
//    who found each block from the pools' own APIs) when they exist; else our explorer
//    (explorer.bumblebeam.org), and the Beam Explorer's public APIs (beamterminal.0xmx.net,
//    explorer.0xmx.net) only as the last resort.
//
// Everything that leaves this file is typed: numbers are finite numbers or null, strings are
// length-capped strings. Views still escape strings before putting them in HTML.
'use strict';

const BB = (() => {
  const params = new URLSearchParams(location.search);
  const DEV = location.protocol === 'file:' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const POOL_API = ((DEV && params.get('api')) || (location.protocol.startsWith('http') ? location.origin : '')).replace(/\/$/, '');
  const TERMINAL = 'https://beamterminal.0xmx.net/api';
  const EXPLORER = 'https://explorer.0xmx.net/api';
  const OUR_EXPLORER = 'https://explorer.bumblebeam.org/api';

  const GROTH = 1e8;
  const MATURITY = 240;          // coinbase maturity, blocks
  const FEE = 0.5;               // percent, PPLNS and SOLO
  const MIN_PAYOUT = 0.1 * GROTH;
  const PAYOUT_INTERVAL = 7200;  // seconds

  let netCache = null; // last good network() result

  // ---------- Beam emission (core Rules::get_Emission, mainnet) ----------
  // 100 BEAM per block in year one (80 to miners, 20 treasury), halving every four years after
  // that; the treasury took 10 of the 50 in years two to five and nothing since. So miners get
  // 80, 40, 25, 12.5, ... Confirmed against coinbase outputs in the explorer (25 BEAM at height
  // 4,0xx,xxx in 2026).
  const DROP0 = 525600, DROP1 = 2102400; // one year, four years of 60 s blocks
  const HEIGHT_FALLBACK = 4068800;        // mainnet tip on 2026-10-07; used only when no height is known at all
  function emissionAt(height) {
    const known = Number(height) || (netCache && netCache.height) || HEIGHT_FALLBACK;
    const h = Math.max(0, Math.floor(known));
    if (h < DROP0) return { reward: 80, next: DROP0 };
    const n = 1 + Math.floor((h - DROP0) / DROP1);
    const full = 100 / 2 ** n, treasury = n === 1 ? 10 : 0;
    return { reward: full - treasury, next: DROP0 + n * DROP1 };
  }
  const blockReward = (height) => Math.round(emissionAt(height).reward * GROTH);
  function nextRewardChange(height) {
    const e = emissionAt(height);
    return { height: e.next, reward: Math.round(emissionAt(e.next).reward * GROTH) };
  }

  // ---------- typing helpers ----------
  const num = (x) => {
    if (x == null || x === '') return null;
    const n = typeof x === 'string' ? Number(x.replace(/,/g, '')) : Number(x);
    return Number.isFinite(n) ? n : null;
  };
  const str = (x, max = 200) => (x == null ? '' : String(x).slice(0, max));
  const series = (s) => (Array.isArray(s)
    ? s.map((p) => (Array.isArray(p) ? [num(p[0]), num(p[1])] : [num(p && p.ts), num(p && p.value)])).filter((p) => p[0] != null && p[1] != null)
    : []);
  // the range's highest one-minute hashrate, [ts, value], from servers that send it
  const peakOf = (p) => (Array.isArray(p) && num(p[0]) != null && num(p[1]) != null ? [num(p[0]), num(p[1])] : null);
  const tsOf = (x) => (typeof x === 'string' && /[^\d.]/.test(x) ? num(Date.parse(x) / 1000) : num(x));

  async function getJSON(url, timeoutMs = 8000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  }

  // ---------- live network ----------

  function normPool(x) {
    return {
      id: str(x.id, 40), name: str(x.name, 40) || 'unknown', website: str(x.website, 200), scheme: str(x.payout_scheme ?? x.scheme, 12),
      fee: num(x.fee), hashrate: num(x.hashrate) || 0, miners: num(x.miners), workers: num(x.workers),
      blocks24h: num(x.blocks_past_24h ?? x.blocks_24h ?? x.blocks24h), blocks24hHours: num(x.blocks24hHours), lastTs: tsOf(x.last_block_ts ?? x.lastTs),
      series: series(x.hashrate_series ?? x.series),
    };
  }

  let netAt = 0, proxyFailedAt = 0;
  async function network() {
    if (netCache && Date.now() - netAt < 25000) return netCache;
    const out = { ok: false, pools: [], hashrate: null, height: null, difficulty: null, avgBlock: null, blocks24h: null, priceUsd: null, othersHashrate: null, source: null };

    // The pool server caches the explorer for all visitors; use it when it answers.
    if (POOL_API && Date.now() - proxyFailedAt > 60000) {
      try {
        const p = await getJSON(`${POOL_API}/api/network`, 3000);
        out.ok = true;
        out.source = 'pool';
        out.hashrate = num(p.hashrate);
        out.height = num(p.height);
        out.difficulty = num(p.difficulty);
        out.avgBlock = num(p.avgBlock);
        out.blocks24h = num(p.blocks24h);
        out.priceUsd = num(p.priceUsd);
        out.othersHashrate = num(p.othersHashrate);
        out.pools = (Array.isArray(p.pools) ? p.pools : []).map(normPool);
        netCache = out; netAt = Date.now();
        return out;
      } catch (e) {
        proxyFailedAt = Date.now();
      }
    }

    const [pools, hdrs] = await Promise.allSettled([
      getJSON(`${TERMINAL}/mining/pools`),
      getJSON(`${OUR_EXPLORER}/hdrs?nMax=61&cols=Td`).catch(() => getJSON(`${EXPLORER}/hdrs?nMax=61&cols=Td`)),
    ]);
    out.source = 'explorer';
    if (pools.status === 'fulfilled') {
      const p = pools.value;
      out.ok = true;
      out.hashrate = num(p.network_hashrate);
      out.height = num(p.block_height);
      out.blocks24h = num(p.blocks_24h_total);
      out.pools = (Array.isArray(p.pools) ? p.pools : []).map(normPool);
    }
    if (hdrs.status === 'fulfilled') {
      const rows = (hdrs.value.value || []).slice(1);
      if (rows.length > 1) {
        out.ok = true;
        out.height = out.height || num(rows[0][0] && rows[0][0].value);
        out.difficulty = num(rows[0][2]);
        const t0 = num(rows[0][1] && rows[0][1].value), t1 = num(rows[rows.length - 1][1] && rows[rows.length - 1][1].value);
        if (t0 != null && t1 != null) out.avgBlock = (t0 - t1) / (rows.length - 1);
      }
    }
    if (out.ok) { netCache = out; netAt = Date.now(); }
    return out;
  }

  // The latest blocks with the pool that mined each: the pool server's list (our node's headers,
  // each pool's own API checked against them). Without it: heights and times from our explorer
  // with only our blocks named; the Beam Terminal last.
  async function networkBlocks(limit = 30) {
    const pooled = !!POOL_API;
    if (pooled) {
      try {
        const r = await getJSON(`${POOL_API}/api/network/blocks?limit=${limit}`, 5000);
        const bl = (Array.isArray(r.blocks) ? r.blocks : []).map((b) => ({ height: num(b.height), ts: tsOf(b.ts), by: str(b.poolName, 40) }));
        if (bl.length) return bl;
      } catch (e) { /* our explorer below */ }
    }
    try {
      const [hdrs, ours] = await Promise.all([
        getJSON(`${OUR_EXPLORER}/hdrs?nMax=${Math.min(100, limit)}&cols=T`),
        pooled ? getJSON(`${POOL_API}/api/blocks/heights`, 5000).catch(() => null) : null,
      ]);
      const mine = new Set((ours && Array.isArray(ours.blocks) ? ours.blocks : []).filter((b) => Array.isArray(b) && b[2] !== 'orphaned').map((b) => num(b[0])));
      const bl = (hdrs.value || []).slice(1).map((row) => {
        const height = num(row[0] && row[0].value);
        return { height, ts: tsOf(row[1] && row[1].value), by: mine.has(height) ? 'BumbleBeam' : null };
      }).filter((b) => b.height != null);
      if (bl.length) return bl;
    } catch (e) { /* the terminal below */ }
    const r = await getJSON(`${TERMINAL}/mining/blocks?limit=${limit}`);
    return (Array.isArray(r.blocks) ? r.blocks : []).map((b) => ({ height: num(b.height), ts: tsOf(b.ts), by: str(b.mined_by, 40) }));
  }

  // ---------- pool API: normalisation ----------

  const STATUS = ['pending', 'confirmed', 'orphaned'];
  function normStats(r) {
    r = r || {};
    const c = r.config || {}, s = r.stats || {}, node = (Array.isArray(r.nodes) && r.nodes[0]) || {};
    const height = num(node.height);
    const fee = num(c.fee) ?? FEE;
    const minPay = num(r.minPay);
    return {
      hashrate: num(r.hashrate) || 0, minersTotal: num(r.minersTotal) || 0, workersTotal: num(r.workersTotal) || 0,
      lastBlockFound: num(s.lastBlockFound), roundShares: num(s.roundShares),
      height, difficulty: num(node.difficulty), networkHashrate: num(node.networkhashps),
      fee, soloFee: num(c.soloFee) ?? fee, finderBonus: num(c.finderBonus) || 0, minPayout: minPay != null ? Math.round(minPay * GROTH) : MIN_PAYOUT, scheme: str(r.feeType, 16) || 'PPLNS',
      pplnsWindow: num(c.pplnsWindow), maturity: num(c.maturity) ?? MATURITY, payoutInterval: num(c.payoutInterval) ?? PAYOUT_INTERVAL,
      blockReward: num(c.blockReward) ?? blockReward(height),
      stratumHost: str(c.stratumHost, 253),
      nodeAddr: str(c.nodeAddr, 260),
      minerPaysTxFee: c.minerPaysTxFee !== false,
      coinbase: c.coinbase === true,
      shieldedFee: num(c.txFee && c.txFee.shielded) ?? 1000100,
      ports: {
        pplns: num(c.ports && c.ports.pplns) ?? 3333, solo: num(c.ports && c.ports.solo) ?? 3334,
        pplnsTls: num(c.ports && c.ports.pplnsTls) ?? 3443, soloTls: num(c.ports && c.ports.soloTls) ?? 3444,
      },
      chart: series(r.charts && r.charts.hashrate), chartPeak: peakOf(r.charts && r.charts.peak),
      blocks24h: num(r.blocksFound24H), effort24h: num(r.effort24h), blocksPending: num(r.immatureTotal),
      // PPLNS and solo as two pools; null from servers that do not split them
      modes: r.modes && r.modes.pplns && r.modes.solo ? Object.fromEntries(['pplns', 'solo'].map((k) => {
        const m = r.modes[k];
        return [k, { hashrate: num(m.hashrate) || 0, miners: num(m.miners) || 0, workers: num(m.workers) || 0, blocks24h: num(m.blocks24h) || 0,
          lastBlockFound: num(m.lastBlockFound), series: series(m.series) }];
      })) : null,
    };
  }
  const normModes = (v) => (Array.isArray(v) ? v.filter((x) => x === 'pplns' || x === 'solo') : []);
  const normBlock = (b) => ({
    height: num(b.height) || 0, hash: str(b.hash, 64), ts: num(b.timestamp), reward: num(b.reward) || 0, fees: num(b.fees) || 0,
    effort: num(b.effort), status: STATUS.includes(b.status) ? b.status : 'pending', confirmations: num(b.confirmations) || 0,
    finder: str(b.finder, 64), mode: b.mode === 'solo' ? 'solo' : 'pplns',
  });
  const normMinerRow = (m) => ({
    hashrate: num(m.hashrate) || 0, hashrate24h: num(m.hashrate24h), workers: num(m.workers) || 0, lastShare: num(m.lastShare),
    modes: normModes(m.modes),
  });
  const normWorker = (w) => ({
    name: str(w.name, 64), hashrate: num(w.hashrate) || 0, hashrate24h: num(w.hashrate24h), lastShare: num(w.lastShare), online: !!w.online,
    stale: num(w.stale), rejected: num(w.rejected), modes: normModes(w.modes),
  });
  const normPayment = (p) => ({
    ts: num(p.ts), amount: num(p.amount) || 0, miners: num(p.miners), kernel: str(p.kernel, 96), status: str(p.status, 16),
    // a transaction still confirming has no kernel yet
    txs: (Array.isArray(p.txs) ? p.txs : []).slice(0, 500).map((t) => ({ kernel: str(t && t.kernel, 64), amount: num(t && t.amount) || 0 })),
  });
  const normMiner = (m) => ({
    payoutFailures: m.payoutFailures && m.payoutFailures.count ? m.payoutFailures : null,
    address: str(m.address, 600), hashrate: num(m.hashrate) || 0, hashrate24h: num(m.hashrate24h), balance: num(m.balance) || 0,
    modes: normModes(m.modes),
    immature: num(m.immature) || 0, paid: num(m.paid) || 0, sending: num(m.sending) || 0, lastShare: num(m.lastShare),
    workers: (Array.isArray(m.workers) ? m.workers : []).map(normWorker), chart: series(m.charts && m.charts.hashrate), chartPeak: peakOf(m.charts && m.charts.peak),
    payments: (Array.isArray(m.payments) ? m.payments : []).map(normPayment),
    blocksFound: num(m.blocksFound) || 0, blocks24h: num(m.blocks24h) || 0, lastBlockAt: num(m.lastBlockAt),
    blocks: (Array.isArray(m.blocks) ? m.blocks : []).map(normBlock),
    addressType: str(m.addressType, 16),
    // coinbase accounts (paid in the blocks themselves): their pair stock and what blocks paid them
    coinbase: m.coinbase && typeof m.coinbase === 'object' ? {
      stockPairs: num(m.coinbase.stockPairs) || 0, stockValue: num(m.coinbase.stockValue) || 0,
      minedPairs: num(m.coinbase.minedPairs) || 0, minedValue: num(m.coinbase.minedValue) || 0, blocks: num(m.coinbase.blocks) || 0,
      expiredPairs: num(m.coinbase.expiredPairs) || 0, expiresAt: num(m.coinbase.expiresAt),
    } : null,
  });
  function normalize(path, r) {
    const p = path.split('?')[0];
    if (p === 'stats') return normStats(r);
    if (p === 'blocks') return { blocks: (Array.isArray(r && r.blocks) ? r.blocks : []).map(normBlock) };
    if (p === 'payments') return { payments: (Array.isArray(r && r.payments) ? r.payments : []).map(normPayment) };
    if (p === 'miners') return { miners: (Array.isArray(r && r.miners) ? r.miners : []).map(normMinerRow) };
    if (p.startsWith('miners/')) return normMiner(r || {});
    return r;
  }

  // ---------- pool API ----------
  // No demo stand-in any more (audit 2026-10-23): a slow first answer used to switch the site to generated
  // numbers. A failure now throws and the view shows it; `stats` (every view asks for it) is shared for 10 s.

  let mode = null; // 'live' once the pool answered, 'offline' while it does not
  const memo = new Map();
  async function pool(path) {
    const key = path.startsWith('stats') ? path : null;
    if (key && memo.has(key) && Date.now() - memo.get(key).at < 10000) return memo.get(key).v;
    try {
      const r = await getJSON(`${POOL_API}/api/${path}`, 8000);
      mode = 'live';
      const v = normalize(path, r);
      if (key) memo.set(key, { at: Date.now(), v });
      return v;
    } catch (e) {
      mode = 'offline';
      throw e;
    }
  }

  // The pool's own check (/api/health): the stratum process answers and the node gave a block
  // template in the last 10 minutes. 'live', 'degraded' (the API answers, mining does not work:
  // `reason` says why) or 'offline' (no answer at all).
  async function health() {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(`${POOL_API}/api/health`, { signal: ctl.signal, cache: 'no-store' });
      const h = await r.json().catch(() => null);
      if (!h || typeof h.ok !== 'boolean') return { state: 'offline' };
      if (h.ok) return { state: 'live' };
      return { state: 'degraded', reason: h.stratum === 'down' ? 'stratum down' : !h.node ? 'no node' : 'node stalled' };
    } catch (e) {
      return { state: 'offline' };
    } finally {
      clearTimeout(t);
    }
  }

  return {
    GROTH, MATURITY, FEE,
    blockReward, nextRewardChange,
    network, networkBlocks, pool, health,
    get mode() { return mode; },
    get dev() { return DEV; },
    stratumHost: (stats) => (stats && stats.stratumHost) || (mode === 'live' && POOL_API ? new URL(POOL_API).hostname : '<pool-host>'),
  };
})();
