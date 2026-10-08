// bumblebeam pool web UI: data layer.
//
// Two sources:
//  - the pool's own API (pool/API.md) at the page's origin. While the pool server does not exist
//    yet, a seeded generator stands in and the UI says so. From localhost, ?api=<url> points the
//    UI at another server; on a public host the parameter is ignored, so a crafted link cannot
//    feed the page foreign data.
//  - live Beam network data: the pool server's /api/network cache when it exists, else the Beam
//    Explorer's public APIs (CORS open): beamterminal.0xmx.net/api/mining/* and
//    explorer.0xmx.net/api/hdrs.
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
  const tsOf = (x) => (typeof x === 'string' && /[^\d.]/.test(x) ? num(Date.parse(x) / 1000) : num(x));

  async function getJSON(url, timeoutMs = 8000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
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
      blocks24h: num(x.blocks_past_24h ?? x.blocks_24h ?? x.blocks24h), lastTs: tsOf(x.last_block_ts ?? x.lastTs),
      series: series(x.hashrate_series ?? x.series),
    };
  }

  let netAt = 0, proxyFailedAt = 0;
  async function network() {
    if (netCache && Date.now() - netAt < 25000) return netCache;
    const out = { ok: false, pools: [], hashrate: null, height: null, difficulty: null, avgBlock: null, blocks24h: null, source: null };

    // The pool server caches the explorer for all visitors; use it when it answers.
    if (POOL_API && mode !== 'demo' && Date.now() - proxyFailedAt > 60000) {
      try {
        const p = await getJSON(`${POOL_API}/api/network`, 3000);
        out.ok = true;
        out.source = 'pool';
        out.hashrate = num(p.hashrate);
        out.height = num(p.height);
        out.difficulty = num(p.difficulty);
        out.avgBlock = num(p.avgBlock);
        out.blocks24h = num(p.blocks24h);
        out.pools = (Array.isArray(p.pools) ? p.pools : []).map(normPool);
        netCache = out; netAt = Date.now();
        return out;
      } catch (e) {
        proxyFailedAt = Date.now();
      }
    }

    const [pools, hdrs] = await Promise.allSettled([
      getJSON(`${TERMINAL}/mining/pools`),
      getJSON(`${EXPLORER}/hdrs?nMax=61&cols=Td`),
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

  async function networkBlocks(limit = 30) {
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
    return {
      hashrate: num(r.hashrate) || 0, minersTotal: num(r.minersTotal) || 0, workersTotal: num(r.workersTotal) || 0,
      lastBlockFound: num(s.lastBlockFound), roundShares: num(s.roundShares),
      height, difficulty: num(node.difficulty), networkHashrate: num(node.networkhashps),
      fee, soloFee: num(c.soloFee) ?? fee, finderBonus: num(c.finderBonus) || 0, minPayout: num(c.minPayout) ?? MIN_PAYOUT, scheme: str(c.payoutScheme, 16) || 'PPLNS',
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
      chart: series(r.charts && r.charts.hashrate),
      blocks24h: num(r.blocks24h), effort24h: num(r.effort24h),
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
    height: num(b.height) || 0, hash: str(b.hash, 64), ts: num(b.ts), reward: num(b.reward) || 0, fees: num(b.fees) || 0,
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
    txs: (Array.isArray(p.txs) ? p.txs : []).slice(0, 500).map((t) => ({ kernel: str(t && t.kernel, 64), amount: num(t && t.amount) || 0 })).filter((t) => t.kernel),
  });
  const normMiner = (m) => ({
    address: str(m.address, 600), hashrate: num(m.hashrate) || 0, hashrate24h: num(m.hashrate24h), balance: num(m.balance) || 0,
    modes: normModes(m.modes),
    immature: num(m.immature) || 0, paid: num(m.paid) || 0, lastShare: num(m.lastShare),
    workers: (Array.isArray(m.workers) ? m.workers : []).map(normWorker), chart: series(m.charts && m.charts.hashrate),
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

  // ---------- pool API, or the demo stand-in ----------

  let mode = null; // 'live' | 'demo'
  let liveTriedAt = 0;
  async function pool(path) {
    // In demo mode, try the real server again once a minute so it is picked up when it comes up.
    if (POOL_API && (mode !== 'demo' || Date.now() - liveTriedAt > 60000)) {
      liveTriedAt = Date.now();
      try {
        const r = await getJSON(`${POOL_API}/api/${path}`, 4000);
        mode = 'live';
        return normalize(path, r);
      } catch (e) {
        if (mode === 'live') throw e;
      }
    }
    mode = 'demo';
    return normalize(path, Demo.get(path, await network().catch(() => null)));
  }

  // ---------- demo generator (deterministic per 10 minutes, anchored to the live chain) ----------

  const Demo = (() => {
    function rng(seed) {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    function strSeed(s) {
      let h = 2166136261;
      for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
      return h >>> 0;
    }
    const hex = (r, n) => Array.from({ length: n }, () => '0123456789abcdef'[(r() * 16) | 0]).join('');

    // Pool hashrate over a chart range, at the API's resolution for that range.
    function demoSeries(now, range, base) {
      const [span, step] = range === '30d' ? [30 * 86400, 14400] : range === '7d' ? [7 * 86400, 3600] : [86400, 600];
      const out = [];
      for (let t = Math.floor((now - span) / step) * step + step; t <= now; t += step) {
        const w = Math.sin(t / 7000) * 0.06 + Math.sin(t / 2300) * 0.03 + Math.sin(t / 400000) * 0.12;
        out.push([t, base * (1 + w + (rng(t)() - 0.5) * 0.08)]);
      }
      return out;
    }

    let world = null, worldKey = '';
    function build(net) {
      const now = Math.floor(Date.now() / 1000);
      const key = `${Math.floor(now / 600)}`;
      if (world && worldKey === key) return world;
      const r = rng(20261006);
      const netHash = (net && net.hashrate) || 45000;
      const height = (net && net.height) || 4068700;
      const reward = blockReward(height);
      const base = 1650; // Sol/s, ~3.5% of the network

      const series = demoSeries(now, '24h', base);
      const hashrate = series[series.length - 1][1];

      const miners = [];
      let left = hashrate;
      for (let i = 0; i < 37; i++) {
        const share = i === 36 ? left : Math.min(left * 0.5, hashrate * (0.25 / (i + 1)) * (0.6 + r()));
        left -= share;
        const nW = 1 + ((r() * 4) | 0);
        miners.push({ address: hex(r, 66), hashrate: share, hashrate24h: share * (0.92 + r() * 0.12), workers: nW, lastShare: now - ((r() * 50) | 0) });
      }
      miners.sort((a, b) => b.hashrate - a.hashrate);

      // Blocks: Poisson process at the pool's share of 1440 blocks/day.
      const perSec = (base / netHash) / 60;
      const blocks = [];
      let t = now - ((r() * 300) | 0);
      while (t > now - 86400 * 3) {
        const h = height - Math.round((now - t) / 60);
        const conf = height - h;
        const orphan = conf > 2 && r() < 0.012;
        blocks.push({
          height: h, hash: hex(r, 64), ts: t, reward, fees: Math.round(r() * 3e6),
          effort: -Math.log(1 - r() * 0.999), confirmations: conf,
          status: orphan ? 'orphaned' : conf >= MATURITY ? 'confirmed' : 'pending',
          finder: `rig${1 + ((r() * 9) | 0)}`, mode: r() < 0.08 ? 'solo' : 'pplns',
        });
        t -= Math.max(20, Math.round(-Math.log(1 - r()) / perSec));
      }

      const payments = [];
      for (let pt = Math.floor(now / PAYOUT_INTERVAL) * PAYOUT_INTERVAL; pt > now - 86400 * 3; pt -= PAYOUT_INTERVAL) {
        const n = 12 + ((r() * 20) | 0), txs = [];
        for (let i = 0; i < n; i++) txs.push({ kernel: hex(r, 64), amount: Math.round((0.02 + r() * 0.1) * PAYOUT_INTERVAL * perSec * reward) });
        payments.push({ ts: pt, amount: txs.reduce((s, t) => s + t.amount, 0), miners: n, kernel: txs[n - 1].kernel, txs });
      }

      const day = blocks.filter((b) => b.ts > now - 86400);
      world = {
        now, base, hashrate, series, miners, blocks, payments, height, netHash,
        stats: {
          hashrate, minersTotal: miners.length, workersTotal: miners.reduce((s, m) => s + m.workers, 0),
          stats: { lastBlockFound: blocks[0] ? blocks[0].ts : null, roundShares: 0 },
          nodes: [{ name: 'beam-node-1', height: String(height), difficulty: String((net && net.difficulty) || 2.72e6), networkhashps: String(netHash), lastBeat: String(now) }],
          config: { fee: FEE, soloFee: FEE, finderBonus: 1, minPayout: MIN_PAYOUT, payoutScheme: 'PPLNS', pplnsWindow: 2.0, blockReward: reward, maturity: MATURITY, payoutInterval: PAYOUT_INTERVAL },
          charts: { hashrate: series },
          blocks24h: day.length,
          effort24h: day.length ? day.reduce((s, b) => s + b.effort, 0) / day.length : null,
        },
      };
      worldKey = key;
      return world;
    }

    function miner(w, address, range) {
      const known = w.miners.find((m) => m.address === address);
      // like the server: an address that never mined here gets an empty record
      if (!known) return { address, hashrate: 0, hashrate24h: 0, balance: 0, immature: 0, paid: 0, lastShare: null, workers: [], charts: { hashrate: [] }, payments: [] };
      const r = rng(strSeed(address));
      const hr = known ? known.hashrate : (r() < 0.25 ? 0 : 20 + r() * 300);
      const nW = known ? known.workers : 1 + ((r() * 3) | 0);
      const workers = Array.from({ length: nW }, (_, i) => {
        const h = hr / nW * (0.7 + r() * 0.6);
        return { name: `rig${i + 1}`, hashrate: h, hashrate24h: h * (0.9 + r() * 0.15), lastShare: w.now - ((r() * 40) | 0), online: hr > 0, stale: r() * 0.02, rejected: r() * 0.003 };
      });
      const series = demoSeries(w.now, range, w.base).map(([t, v]) => [t, hr ? hr * (v / w.hashrate) * (0.9 + r() * 0.2) : 0]);
      const payments = w.payments.slice(0, 12).map((p) => ({ ts: p.ts, amount: Math.round(p.amount * (hr / w.hashrate)), kernel: p.kernel }));
      const reward = blockReward(w.height);
      return {
        address, hashrate: hr, hashrate24h: hr * 0.97, balance: Math.round(r() * MIN_PAYOUT), immature: Math.round(hr / w.hashrate * 6 * reward),
        paid: Math.round(hr / w.hashrate * 900 * reward), lastShare: hr ? w.now - 5 : null, workers, charts: { hashrate: series }, payments,
      };
    }

    function get(path, net) {
      const w = build(net);
      const [p, q] = path.split('?');
      const qs = new URLSearchParams(q || '');
      const limit = Math.min(500, Number(qs.get('limit')) || 50);
      const before = Number(qs.get('before')) || Infinity;
      const range = qs.get('range') || '24h';
      if (p === 'stats') return { ...w.stats, charts: { hashrate: demoSeries(w.now, range, w.base) } };
      if (p === 'blocks') return { blocks: w.blocks.filter((b) => b.height < before).slice(0, limit) };
      if (p === 'payments') return { payments: w.payments.slice(0, limit) };
      if (p === 'miners') return { miners: w.miners.slice(0, limit).map(({ address, ...m }) => m) };
      if (p.startsWith('miners/')) return miner(w, decodeURIComponent(p.slice(7)), range);
      throw new Error(`demo: unknown path ${path}`);
    }

    return { get };
  })();

  return {
    GROTH, MATURITY, FEE,
    blockReward, nextRewardChange,
    network, networkBlocks, pool,
    get mode() { return mode; },
    get dev() { return DEV; },
    stratumHost: (stats) => (stats && stats.stratumHost) || (mode === 'live' && POOL_API ? new URL(POOL_API).hostname : '<pool-host>'),
  };
})();
