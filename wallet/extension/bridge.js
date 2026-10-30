// The official Beam <-> Ethereum bridge for BEAM (BeamMW beam-bridge-reverse-app / -ethapp / -ethrelay).
// Beam side: the pipe contract, called with the app shader the official DApp ships. Ethereum side:
// the pipe and the WBEAM token; the official relayer moves messages between them.
'use strict';

const Bridge = (() => {
  const PIPE_CID = 'e63bd26ca5b226558686dd191122a8e5d6861a97597db9f40bda48aef6dbe835';
  const ETH_PIPE = '0x6063024646E8A1561970840a4b0e0f1082f5a670';
  const WBEAM = '0xE5AcBB03D73267c03349c76EaD672Ee4d941F499';
  const PROCESS_REMOTE = '0x6efe7df5';         // processRemoteMessage(uint64 msgId, uint256 relayerFee, uint256 amount, address receiver)
  const GROTH = 1e8;                           // BEAM and WBEAM both have 8 decimals
  const RELAY_GAS = 120000;                    // ETH_PIPE_PUSH_REMOTE_GAS_LIMIT of the relayer
  // over the relayer's own minimum. The fee is fixed in the message for good and the minimum moves
  // with gas and ETH/BEAM; under it the relayer waits, and nothing can top the fee up later
  const FEE_MARGIN = 3;
  const ETH_RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com'];

  let shader = null;
  async function contract() {
    if (!shader) shader = Array.from(new Uint8Array(await (await fetch('shaders/pipe_app.wasm')).arrayBuffer()));
    return shader;
  }

  // runs the app shader (through the wallet's app API); a call that makes a transaction returns its
  // txid once the consent handler approved it, a view returns its output
  async function invoke(args, tx = false) {
    const res = await Beam.appCall('invoke_contract', { contract: await contract(), args: `${args},cid=${PIPE_CID}`, create_tx: false });
    if (tx) {
      if (!res.raw_data) throw new Error(`the contract made no transaction: ${res.output || ''}`);
      return (await Beam.appCall('process_invoke_data', { data: res.raw_data })).txid;
    }
    const out = JSON.parse(res.output || '{}');
    if (out.error) throw new Error(`contract: ${out.error}`);
    return out;
  }

  async function getJSON(url, body) {
    const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    if (!r.ok) throw new Error(`${new URL(url).host}: HTTP ${r.status}`);
    return r.json();
  }

  async function eth(method, params) {
    let last;
    for (const url of ETH_RPCS) {
      try {
        const d = await getJSON(url, { jsonrpc: '2.0', id: 1, method, params });
        if (d.result !== undefined) return d.result;
        last = d.error && d.error.message;
      } catch (e) { last = e.message; }
    }
    throw new Error(`Ethereum RPC ${method}: ${last}`);
  }

  async function rates() {
    try {
      const d = await getJSON('https://api.coingecko.com/api/v3/simple/price?ids=ethereum,beam&vs_currencies=usd');
      return { eth: d.ethereum.usd, beam: d.beam.usd, src: 'CoinGecko' };
    } catch {
      const d = await getJSON('https://explorer-api.beam.mw/bridges/rates');
      return { eth: d.ethereum.usd, beam: d.beam.usd, src: 'explorer-api.beam.mw' };
    }
  }

  // The relayer's own minimum (beam-bridge-ethrelay utils/eth_fee.js + eth_gas.js): 120000 gas at
  // maxFeePerGas = 2 * baseFee + median tip (0.01..3 gwei), priced in BEAM. A lower fee is not
  // lost: the message waits until gas is cheap enough.
  async function relayerFee() {
    const h = await eth('eth_feeHistory', ['0xa', 'latest', [50]]);
    const base = parseInt(h.baseFeePerGas[h.baseFeePerGas.length - 1], 16);
    const tips = (h.reward || []).map((r) => parseInt(r[0], 16)).sort((a, b) => a - b);
    const tip = Math.min(Math.max(tips.length ? tips[tips.length >> 1] : 1e7, 1e7), 3e9);
    const gwei = (2 * base + tip) / 1e9;
    const r = await rates();
    const min = (RELAY_GAS * gwei * r.eth) / 1e9 / r.beam;
    return { min, fee: Math.ceil(min * FEE_MARGIN * 100) / 100, gwei, ethUsd: r.eth, beamUsd: r.beam, src: r.src };
  }

  const toGroth = (x) => {
    const v = Math.round(parseFloat(String(x).replace(',', '.')) * GROTH);
    if (!(v > 0)) throw new Error('the amount must be above zero');
    return v;
  };
  const isEthAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(a);

  // ---------- BEAM -> WBEAM ----------
  // The wallet pays amount + relayerFee (the contract consumes both) plus the Beam network fee.
  const sendToEth = (amountG, receiver, feeG) =>
    invoke(`role=user,action=send,amount=${amountG},receiver=${receiver.slice(2).toLowerCase()},relayerFee=${feeG}`, true);

  // recent processRemoteMessage calls on the Ethereum pipe, decoded from their input: msgId -> release
  async function ethReleases(pages = 3) {
    const out = new Map();
    let q = '';
    for (let i = 0; i < pages; i++) {
      const d = await getJSON(`https://eth.blockscout.com/api/v2/addresses/${ETH_PIPE}/transactions${q}`);
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

  // our messages among the pipe's last `scan`, joined with their Ethereum releases
  async function outgoing(receiver, scan = 40) {
    const rcv = receiver.slice(2).toLowerCase();
    const count = Number((await invoke('role=user,action=local_msg_count')).count || 0);
    const rel = await ethReleases().catch(() => new Map());
    const msgs = [];
    for (let id = count; id > Math.max(count - scan, 0); id--) {
      const m = await invoke(`role=user,action=local_msg,msgId=${id}`);
      if (String(m.receiver || '').toLowerCase().replace(/^0x/, '') !== rcv) continue;
      const r = rel.get(id);
      msgs.push({ id, amount: Number(m.amount), fee: Number(m.relayerFee), height: m.height, eth: r || null,
        state: r ? (r.ok ? 'done' : 'failed') : 'waiting' });
    }
    return { count, msgs };
  }

  // ---------- WBEAM -> BEAM ----------
  // The key the Ethereum side sends to (33 bytes): derived from the pipe's cid by this wallet.
  const beamKey = async () => (await invoke('role=user,action=get_pk')).pubkey;
  // messages the relayer has pushed to the Beam pipe for this wallet and that are not received yet
  const incoming = async () => (await invoke('role=manager,action=view_incoming,startFrom=0')).incoming || [];
  const receive = (msgId) => invoke(`role=user,action=receive,msgId=${msgId}`, true);

  return { PIPE_CID, ETH_PIPE, WBEAM, GROTH, relayerFee, toGroth, isEthAddress, sendToEth, outgoing, beamKey, incoming, receive };
})();
