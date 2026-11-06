// The official Beam <-> Ethereum bridge for BEAM (BeamMW beam-bridge-reverse-app / -ethapp / -ethrelay).
// Beam side: the pipe contract, called with the app shader the official DApp ships. Ethereum side:
// the pipe and the WBEAM token, signed by this wallet's own Ethereum account (eth.js); the official
// relayer moves messages between them.
'use strict';

const Bridge = (() => {
  const PIPE_CID = 'e63bd26ca5b226558686dd191122a8e5d6861a97597db9f40bda48aef6dbe835';
  const ETH_PIPE = '0x6063024646E8A1561970840a4b0e0f1082f5a670';
  const WBEAM = '0xE5AcBB03D73267c03349c76EaD672Ee4d941F499';
  const PROCESS_REMOTE = '0x6efe7df5';         // processRemoteMessage(uint64 msgId, uint256 relayerFee, uint256 amount, address receiver)
  const SEND_FUNDS = '0x4d5dd2bc';             // sendFunds(uint256 value, uint256 relayerFee, bytes pubKey), checked against real calls
  const GROTH = 1e8;                           // BEAM and WBEAM both have 8 decimals
  const RELAY_GAS = 120000;                    // ETH_PIPE_PUSH_REMOTE_GAS_LIMIT of the relayer
  // The fee is fixed in the message for good; the relayer's minimum moves with gas and ETH/BEAM, and
  // under it the relayer waits (it retries every ~30 min). Paying more does not make it faster: over
  // 99 releases (Sep-Oct 2026) the 3.5-15 BEAM fees went in 48-62 min like the rest, median 63 min;
  // the slow ones (5-11 h) came in groups, whatever their fee. So the choice is how much gas rise to
  // cover while the message waits its hour.
  const FEE_OPTIONS = {
    cheap: 1.15,   // over today's minimum: waits if gas rises at all
    normal: 1.5,
    safe: 2.5,
  };

  let shader = null;
  async function contract() {
    if (!shader) shader = Array.from(new Uint8Array(await (await fetch('shaders/pipe_app.wasm')).arrayBuffer()));
    return shader;
  }

  // runs the app shader through a wallet's engine (its app API, engines.js); a call that makes a transaction
  // returns its txid once the consent handler approved it, a view returns its output
  async function invoke(e, args, tx = false) {
    const res = await e.appCall('invoke_contract', { contract: await contract(), args: `${args},cid=${PIPE_CID}`, create_tx: false });
    if (tx) {
      if (!res.raw_data) throw new Error(`the contract made no transaction: ${res.output || ''}`);
      // this one waits for the consent box (up to 5 min), so it gets longer than the default minute
      return (await e.appCall('process_invoke_data', { data: res.raw_data }, 6 * 60 * 1000)).txid;
    }
    const out = JSON.parse(res.output || '{}');
    if (out.error) throw new Error(`contract: ${out.error}`);
    return out;
  }

  // BEAM and ETH in USD, cached a minute; the last good price is kept for 10 min if every source fails.
  // BEAM: Beam's own on-chain price oracle (the median of its providers), read by our pool's node, as the
  // pool site shows it; then CoinGecko, then Coinpaprika. Not explorer-api.beam.mw/bridges/rates: on
  // 2026-11-05 it said $0.0325 while the oracle and the markets said $0.0067-0.0071, and a BEAM price
  // 4.5x too high prices the relayer's minimum 4.5x too low (a transfer that then waits for cheap gas).
  // A source more than 3x away from another one that answered is left out.
  const SOURCES = {
    beam: [
      ['Beam oracle', async () => (await Eth.getJSON('https://pool.bumblebeam.org/api/network')).priceUsd],
      ['CoinGecko', async () => (await Eth.getJSON('https://api.coingecko.com/api/v3/simple/price?ids=beam&vs_currencies=usd')).beam.usd],
      ['Coinpaprika', async () => (await Eth.getJSON('https://api.coinpaprika.com/v1/tickers/beam-beam')).quotes.USD.price],
    ],
    eth: [
      ['CoinGecko', async () => (await Eth.getJSON('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd')).ethereum.usd],
      ['Coinpaprika', async () => (await Eth.getJSON('https://api.coinpaprika.com/v1/tickers/eth-ethereum')).quotes.USD.price],
    ],
  };
  async function priceOf(list) {
    const got = (await Promise.all(list.map(async ([name, fn]) => {
      try { const v = Number(await fn()); return v > 0 && isFinite(v) ? { name, v } : null; } catch { return null; }
    }))).filter(Boolean);
    if (!got.length) return null;
    if (got.length === 1) return got[0];
    // the sources that agree with at least one other (within 3x); of those, the median, named by its source
    const near = (a, b) => a.v / b.v < 3 && b.v / a.v < 3;
    const ok = got.filter((a) => got.some((b) => b !== a && near(a, b))).sort((a, b) => a.v - b.v);
    if (!ok.length) return null;                     // all disagree: the last good price, or none
    return ok[(ok.length - 1) >> 1];
  }
  let rateCache = null, lastGood = null;
  async function rates() {
    if (rateCache && Date.now() - rateCache.at < 60000) return rateCache.r;
    const [b, e] = await Promise.all([priceOf(SOURCES.beam), priceOf(SOURCES.eth)]);
    if (!b || !e) {
      if (lastGood && Date.now() - lastGood.at < 600000) return lastGood.r;
      throw new Error(`no ${!b ? 'BEAM' : 'ETH'} price to trust: the sources failed or disagree (more than 3x)`);
    }
    const r = { eth: e.v, beam: b.v, src: `BEAM: ${b.name}, ETH: ${e.name}` };
    rateCache = lastGood = { at: Date.now(), r };
    return r;
  }

  // The relayer's own minimum (beam-bridge-ethrelay utils/eth_fee.js + eth_gas.js): 120000 gas at
  // maxFeePerGas = 2 * baseFee + median tip (0.01..3 gwei), priced in BEAM.
  const minAt = (base, tip, r) => (RELAY_GAS * (2 * base + tip) * r.eth) / 1e18 / r.beam;
  // the base fee a fee covers: the relayer takes it while base <= this (wei)
  const coversBase = (feeBeam, tip, r) => ((feeBeam * r.beam / r.eth) * 1e18 / RELAY_GAS - tip) / 2;

  // the last 24 h of base fees (7 x 1024 blocks, one sample in 8), cached 10 min
  let hist = null;
  async function baseFees24h() {
    if (hist && Date.now() - hist.at < 600000) return hist.fees;
    const fees = [];
    let newest = 'latest';
    for (let i = 0; i < 7; i++) {
      const h = await Eth.rpc('eth_feeHistory', ['0x400', newest, []]);
      const b = h.baseFeePerGas.slice(0, -1).map((x) => parseInt(x, 16));
      for (let k = 0; k < b.length; k += 8) fees.push(b[k]);
      newest = '0x' + (parseInt(h.oldestBlock, 16) - 1).toString(16);
    }
    hist = { at: Date.now(), fees };
    return fees;
  }

  async function relayerFee() {
    const h = await Eth.rpc('eth_feeHistory', ['0xa', 'latest', [50]]);
    const base = parseInt(h.baseFeePerGas[h.baseFeePerGas.length - 1], 16);
    const tips = (h.reward || []).map((x) => parseInt(x[0], 16)).sort((a, b) => a - b);
    const tip = Math.min(Math.max(tips.length ? tips[tips.length >> 1] : 1e7, 1e7), 3e9);
    const r = await rates();
    const min = minAt(base, tip, r);
    const day = (await baseFees24h().catch(() => [])).slice().sort((a, b) => a - b);
    const q = (p) => (day.length ? day[Math.min(day.length - 1, Math.floor(p * day.length))] : base);
    // share of the last 24 h in which a fee would have been enough
    const share = (fee) => (day.length ? day.filter((b) => b <= coversBase(fee, tip, r)).length / day.length : null);
    const option = (k) => {
      const fee = Math.ceil(min * FEE_OPTIONS[k] * 100) / 100;
      return { key: k, fee, upTo: coversBase(fee, tip, r) / 1e9, share: share(fee), usd: fee * r.beam };
    };
    const level = base <= q(0.25) ? 'cheap' : base >= q(0.75) ? 'expensive' : 'usual';
    return {
      min, fee: option('normal').fee, gwei: (2 * base + tip) / 1e9, base: base / 1e9, tip: tip / 1e9,
      day: { p10: q(0.1) / 1e9, p50: q(0.5) / 1e9, p90: q(0.9) / 1e9, n: day.length }, level,
      options: Object.keys(FEE_OPTIONS).map(option),
      // for a fee typed by hand: the popup recomputes these from the same numbers
      rate: { eth: r.eth, beam: r.beam }, relayGas: RELAY_GAS, dayBase: day.length ? day.filter((_, i) => i % 4 === 0) : [],
      ethUsd: r.eth, beamUsd: r.beam, src: r.src,
    };
  }

  // ---------- BEAM -> WBEAM ----------
  // The wallet pays amount + relayerFee (the contract consumes both) plus the Beam network fee.
  const sendToEth = (e, amountG, receiver, feeG) =>
    invoke(e, `role=user,action=send,amount=${amountG},receiver=${receiver.slice(2).toLowerCase()},relayerFee=${feeG}`, true);

  // recent processRemoteMessage calls on the Ethereum pipe, decoded from their input: msgId -> release
  async function ethReleases(pages = 3) {
    const out = new Map();
    let q = '';
    for (let i = 0; i < pages; i++) {
      const d = await Eth.getJSON(`https://eth.blockscout.com/api/v2/addresses/${ETH_PIPE}/transactions${q}`);
      for (const t of d.items || []) {
        const raw = t.raw_input || '';
        if (!raw.startsWith(PROCESS_REMOTE) || raw.length < 10 + 64 * 4) continue;
        const w = (k) => raw.slice(10 + 64 * k, 10 + 64 * (k + 1));
        out.set(parseInt(w(0), 16), {
          amount: parseInt(w(2), 16), fee: parseInt(w(1), 16), receiver: '0x' + w(3).slice(24),
          hash: t.hash, time: t.timestamp, ok: t.status === 'ok',
        });
      }
      if (!d.next_page_params) break;
      q = '?' + new URLSearchParams(d.next_page_params);
    }
    return out;
  }

  // The pipe's messages and their releases do not change once written: each is read once and kept (in
  // memory). The first look reads the last `scan` messages, later looks only the new ones, ten at a time.
  // Releases are looked up on Ethereum (Blockscout) only while one of ours lacks one, at most once a minute.
  const msgCache = new Map(), relCache = new Map();
  let scannedTo = 0, relAt = 0, relOk = false;
  async function outgoing(e, receivers, scan = 60) {
    const want = new Set(receivers.map((r) => r.slice(2).toLowerCase()));
    const count = Number((await invoke(e, 'role=user,action=local_msg_count')).count || 0);
    const from = Math.max(scannedTo, count - scan, 0);
    const ids = [];
    for (let id = count; id > from; id--) if (!msgCache.has(id)) ids.push(id);
    for (let k = 0; k < ids.length; k += 10) {
      await Promise.all(ids.slice(k, k + 10).map(async (id) => {
        const m = await invoke(e, `role=user,action=local_msg,msgId=${id}`);
        msgCache.set(id, { id, amount: Number(m.amount), fee: Number(m.relayerFee), height: m.height,
          receiver: String(m.receiver || '').toLowerCase().replace(/^0x/, '') });
      }));
    }
    scannedTo = Math.max(scannedTo, count);
    const mine = [...msgCache.values()].filter((m) => want.has(m.receiver)).sort((a, b) => b.id - a.id);
    if (mine.some((m) => !relCache.has(m.id)) && Date.now() - relAt > 60000) {
      relAt = Date.now();
      try { for (const [id, r] of await ethReleases()) relCache.set(id, r); relOk = true; } catch { relOk = false; }
    }
    // a message older than the releases read is not "waiting": its release is just out of sight
    const oldest = relCache.size ? Math.min(...relCache.keys()) : Infinity;
    return {
      count,
      msgs: mine.map((m) => {
        const r = relCache.get(m.id);
        const state = r ? (r.ok ? 'done' : 'failed') : !relOk || m.id < oldest ? 'unknown' : 'waiting';
        return { ...m, receiver: '0x' + m.receiver, eth: r || null, state };
      }),
    };
  }

  // ---------- WBEAM -> BEAM ----------
  // The key the Ethereum side sends to (33 bytes): derived from the pipe's cid by this wallet.
  const beamKey = async (e) => (await invoke(e, 'role=user,action=get_pk')).pubkey;
  // messages the relayer has pushed to the Beam pipe for this wallet and that are not received yet
  const incoming = async (e) => (await invoke(e, 'role=manager,action=view_incoming,startFrom=0')).incoming || [];
  const receive = (e, msgId) => invoke(e, `role=user,action=receive,msgId=${msgId}`, true);
  // the Ethereum call: the pipe takes value + relayerFee WBEAM (approved before) and the Beam key
  const word = (n) => BigInt(n).toString(16).padStart(64, '0');
  function sendFundsData(value, fee, key) {
    const k = String(key).replace(/^0x/, '').toLowerCase();
    if (!/^[0-9a-f]{66}$/.test(k)) throw new Error('the Beam bridge key is 33 bytes: 66 hex characters');
    return SEND_FUNDS + word(value) + word(fee) + word(0x60) + word(33) + k.padEnd(128, '0');
  }

  return { PIPE_CID, ETH_PIPE, WBEAM, GROTH, coversBase, rates, relayerFee, sendToEth, outgoing, beamKey, incoming, receive, sendFundsData };
})();
