// bumblebeam pool web UI: data layer.
//
// Two sources:
//  - the pool's own API (pool/API.md), at ?api=<url> or the page's origin. While the pool server
//    does not exist yet, a seeded generator stands in and the UI says so.
//  - live Beam network data from the Beam Explorer's public APIs (CORS open):
//    beamterminal.0xmx.net/api/mining/* and explorer.0xmx.net/api/hdrs.
'use strict';

const BB = (() => {
  const params = new URLSearchParams(location.search);
  const POOL_API = (params.get('api') || (location.protocol.startsWith('http') ? location.origin : '')).replace(/\/$/, '');
  const TERMINAL = 'https://beamterminal.0xmx.net/api';
  const EXPLORER = 'https://explorer.0xmx.net/api';

  const GROTH = 1e8;
  const BLOCK_REWARD = 25 * GROTH;
  const MATURITY = 240;
  const FEE = 0.5;          // percent, PPLNS and SOLO
  const MIN_PAYOUT = 0.1 * GROTH;

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

  let netCache = null, netAt = 0;
  async function network() {
    if (netCache && Date.now() - netAt < 25000) return netCache;
    const [pools, hdrs] = await Promise.allSettled([
      getJSON(`${TERMINAL}/mining/pools`),
      getJSON(`${EXPLORER}/hdrs?nMax=61&cols=Td`),
    ]);
    const out = { ok: false, pools: [], hashrate: null, height: null, difficulty: null, avgBlock: null, blocks24h: null };
    if (pools.status === 'fulfilled') {
      const p = pools.value;
      out.ok = true;
      out.hashrate = p.network_hashrate;
      out.height = p.block_height;
      out.blocks24h = p.blocks_24h_total;
      out.pools = (p.pools || []).map((x) => ({
        id: x.id, name: x.name, website: x.website, scheme: x.payout_scheme, fee: x.fee,
        hashrate: x.hashrate || 0, miners: x.miners, workers: x.workers,
        blocks24h: x.blocks_past_24h ?? x.blocks_24h, lastTs: x.last_block_ts ? Date.parse(x.last_block_ts) / 1000 : null,
        series: (x.hashrate_series || []).map((s) => [s.ts, s.value]),
      }));
    }
    if (hdrs.status === 'fulfilled') {
      const rows = (hdrs.value.value || []).slice(1);
      const parse = (s) => Number(String(s).replace(/,/g, ''));
      if (rows.length > 1) {
        out.ok = true;
        out.height = out.height || rows[0][0].value;
        out.difficulty = parse(rows[0][2]);
        out.avgBlock = (rows[0][1].value - rows[rows.length - 1][1].value) / (rows.length - 1);
      }
    }
    if (out.ok) { netCache = out; netAt = Date.now(); }
    return out;
  }

  async function networkBlocks(limit = 30) {
    const r = await getJSON(`${TERMINAL}/mining/blocks?limit=${limit}`);
    return (r.blocks || []).map((b) => ({ height: b.height, ts: Date.parse(b.ts) / 1000, by: b.mined_by }));
  }

  // ---------- pool API, or the demo stand-in ----------

  let mode = null; // 'live' | 'demo'
  async function pool(path) {
    if (mode !== 'demo' && POOL_API) {
      try {
        const r = await getJSON(`${POOL_API}/api/${path}`, 4000);
        mode = 'live';
        return r;
      } catch (e) {
        if (mode === 'live') throw e;
      }
    }
    mode = 'demo';
    return Demo.get(path, await network().catch(() => null));
  }

  // ---------- demo generator (deterministic per hour, anchored to the live chain) ----------

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

    let world = null, worldKey = '';
    function build(net) {
      const now = Math.floor(Date.now() / 1000);
      const key = `${Math.floor(now / 600)}`;
      if (world && worldKey === key) return world;
      const r = rng(20261006);
      const netHash = (net && net.hashrate) || 45000;
      const height = (net && net.height) || 4068700;
      const base = 1650; // Sol/s, ~3.6% of the network

      const series = [];
      for (let t = now - 86400; t <= now; t += 600) {
        const w = Math.sin(t / 7000) * 0.06 + Math.sin(t / 2300) * 0.03;
        series.push([t, base * (1 + w + (rng(t)() - 0.5) * 0.08)]);
      }
      const hashrate = series[series.length - 1][1];

      const miners = [];
      let left = hashrate;
      for (let i = 0; i < 37; i++) {
        const share = i === 36 ? left : Math.min(left * 0.5, hashrate * (0.25 / (i + 1)) * (0.6 + r()));
        left -= share;
        const nW = 1 + ((r() * 4) | 0);
        const addr = hex(r, 66);
        miners.push({ address: addr, hashrate: share, hashrate24h: share * (0.92 + r() * 0.12), workers: nW, lastShare: now - ((r() * 50) | 0) });
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
          height: h, hash: hex(r, 64), ts: t, reward: BLOCK_REWARD, fees: Math.round(r() * 3e6),
          effort: -Math.log(1 - r() * 0.999), confirmations: conf,
          status: orphan ? 'orphaned' : conf >= MATURITY ? 'confirmed' : 'pending',
          finder: `rig${1 + ((r() * 9) | 0)}`, mode: r() < 0.08 ? 'solo' : 'pplns',
        });
        t -= Math.max(20, Math.round(-Math.log(1 - r()) / perSec));
      }

      const payments = [];
      for (let pt = Math.floor(now / 7200) * 7200; pt > now - 86400 * 3; pt -= 7200) {
        payments.push({ ts: pt, amount: Math.round((0.6 + r() * 0.8) * 2 * 3600 * perSec * BLOCK_REWARD), miners: 12 + ((r() * 20) | 0), kernel: hex(r, 64) });
      }

      const blocks24h = blocks.filter((b) => b.ts > now - 86400).length;
      world = {
        now, hashrate, series, miners, blocks, payments, height, netHash,
        stats: {
          hashrate, minersTotal: miners.length, workersTotal: miners.reduce((s, m) => s + m.workers, 0),
          stats: { lastBlockFound: blocks[0] ? blocks[0].ts : null, roundShares: 0 },
          nodes: [{ name: 'beam-node-1', height: String(height), difficulty: String((net && net.difficulty) || 2.72e6), networkhashps: String(netHash), lastBeat: String(now) }],
          config: { fee: FEE, soloFee: FEE, minPayout: MIN_PAYOUT, payoutScheme: 'PPLNS', pplnsWindow: 2.0, blockReward: BLOCK_REWARD, maturity: MATURITY },
          charts: { hashrate: series },
          blocks24h,
          luck24h: blocks24h / Math.max(1, 1440 * (base / netHash)),
        },
      };
      worldKey = key;
      return world;
    }

    function miner(w, address) {
      const known = w.miners.find((m) => m.address === address);
      const r = rng(strSeed(address));
      const hr = known ? known.hashrate : (r() < 0.25 ? 0 : 20 + r() * 300);
      const nW = known ? known.workers : 1 + ((r() * 3) | 0);
      const workers = Array.from({ length: nW }, (_, i) => {
        const h = hr / nW * (0.7 + r() * 0.6);
        return { name: `rig${i + 1}`, hashrate: h, hashrate24h: h * (0.9 + r() * 0.15), lastShare: w.now - ((r() * 40) | 0), online: hr > 0 };
      });
      const series = w.series.map(([t, v]) => [t, hr ? hr * (v / w.hashrate) * (0.9 + r() * 0.2) : 0]);
      const payments = w.payments.slice(0, 12).map((p) => ({ ts: p.ts, amount: Math.round(p.amount * (hr / w.hashrate)), kernel: p.kernel }));
      return {
        address, hashrate: hr, hashrate24h: hr * 0.97, balance: Math.round(r() * MIN_PAYOUT), immature: Math.round(hr / w.hashrate * 6 * BLOCK_REWARD),
        paid: Math.round(hr / w.hashrate * 900 * BLOCK_REWARD), lastShare: hr ? w.now - 5 : null, workers, charts: { hashrate: series }, payments,
      };
    }

    function get(path, net) {
      const w = build(net);
      const [p, q] = path.split('?');
      const limit = Number(new URLSearchParams(q || '').get('limit') || 50);
      if (p === 'stats') return w.stats;
      if (p === 'blocks') return { blocks: w.blocks.slice(0, limit) };
      if (p === 'payments') return { payments: w.payments.slice(0, limit) };
      if (p === 'miners') return { miners: w.miners.slice(0, limit) };
      if (p.startsWith('miners/')) return miner(w, decodeURIComponent(p.slice(7)));
      throw new Error(`demo: unknown path ${path}`);
    }

    return { get };
  })();

  return {
    GROTH, BLOCK_REWARD, MATURITY, FEE,
    network, networkBlocks, pool,
    get mode() { return mode; },
    stratumHost: () => (mode === 'live' && POOL_API ? new URL(POOL_API).hostname : '<pool-host>'),
  };
})();
