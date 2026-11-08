// The Ethereum side of the wallet: accounts from a seed phrase (BIP-44 m/44'/60'/0'/0/i, the path of
// MetaMask, Rabby and the rest, so the same phrase shows the same addresses there) or from a private key;
// balances, history, and transactions signed here and sent through public RPCs. Keys and signing are
// ethers v6 (vendor/ethers.umd.min.js, its own audited noble crypto). Amounts cross the port as decimal
// strings of the smallest unit (wei, token units): BigInt does not go through chrome.runtime ports.
'use strict';

const Eth = (() => {
  const CHAIN_ID = 1n;
  const DEFAULT_RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com', 'https://eth.drpc.org', 'https://1rpc.io/eth'];
  const BLOCKSCOUT = 'https://eth.blockscout.com/api/v2';
  const WBEAM = '0xE5AcBB03D73267c03349c76EaD672Ee4d941F499';
  const PATH = (i) => `m/44'/60'/0'/0/${i}`;
  let rpcs = DEFAULT_RPCS.slice();

  async function getJSON(url, body) {
    // a stalled server is a failure after 15 s, so the next RPC gets its turn
    const r = await fetch(url, { ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`${new URL(url).host}: HTTP ${r.status}`);
    return r.json();
  }

  // the first RPC that answers; an RPC's own error (a revert, a nonce too low) is the answer, not a reason to try the next
  async function rpc(method, params = []) {
    let last, answer;                         // an RPC's own error says more than another's HTTP 429
    for (const url of rpcs) {
      let d;
      try { d = await getJSON(url, { jsonrpc: '2.0', id: 1, method, params }); }
      catch (e) { last = e.message; continue; }
      if (d.result !== undefined) return d.result;
      const m = (d.error && d.error.message) || 'no result';
      // a transaction's own verdict is final; a provider's limit (range, credits, rate) is not: the next RPC tries
      if (/revert|nonce too low|nonce too high|insufficient funds|outoffunds|underpriced|already known|known transaction|exceeds block gas limit|intrinsic gas/i.test(m)) throw new Error(m);
      answer = answer || m;
    }
    throw new Error(`Ethereum RPC ${method}: ${answer || last}`);
  }
  const setRpc = (url) => { rpcs = url ? [url, ...DEFAULT_RPCS] : DEFAULT_RPCS.slice(); };

  // ---------- keys ----------
  // one normal form of a phrase everywhere: lower case, single spaces (commas and semicolons count as spaces)
  const normPhrase = (p) => String(p).trim().toLowerCase().split(/[\s;,]+/).filter(Boolean).join(' ');
  const isPhrase = (p) => { try { return ethers.Mnemonic.isValidMnemonic(normPhrase(p)); } catch { return false; } };
  const isKey = (k) => /^(0x)?[0-9a-fA-F]{64}$/.test(String(k).trim());
  const normKey = (k) => { const h = String(k).trim().replace(/^0x/i, '').toLowerCase(); return '0x' + h; };
  // secret: { phrase, i } or { key }
  function signer(secret) {
    if (secret.key) return new ethers.Wallet(normKey(secret.key));
    return ethers.HDNodeWallet.fromPhrase(normPhrase(secret.phrase), undefined, PATH(secret.i || 0));
  }
  const addressOf = (secret) => signer(secret).address;
  const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(a);
  // EIP-55: a mixed-case address must carry the right checksum
  const checkAddress = (a) => {
    if (!isAddress(a)) throw new Error('an Ethereum address is 0x and 40 hex characters');
    try { return ethers.getAddress(a); } catch { throw new Error('this address has a wrong checksum (a typo?)'); }
  };

  // ---------- ERC-20 ----------
  const word = (n) => BigInt(n).toString(16).padStart(64, '0');
  const addrWord = (a) => a.slice(2).toLowerCase().padStart(64, '0');
  const ERC20 = {
    balanceOf: (owner) => '0x70a08231' + addrWord(owner),
    allowance: (owner, spender) => '0xdd62ed3e' + addrWord(owner) + addrWord(spender),
    transfer: (to, v) => '0xa9059cbb' + addrWord(to) + word(v),
    approve: (spender, v) => '0x095ea7b3' + addrWord(spender) + word(v),
  };
  const call = async (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
  const callBig = async (to, data) => { const r = await call(to, data); return r && r !== '0x' ? BigInt(r) : 0n; };

  async function tokenInfo(addr) {
    const a = checkAddress(addr);
    if ((await rpc('eth_getCode', [a, 'latest'])) === '0x') throw new Error('no contract at this address (a person\'s account?)');
    const decRaw = await call(a, '0x313ce567');
    if (!decRaw || decRaw === '0x') throw new Error('not an ERC-20 token (no decimals)');
    const dec = Number(BigInt(decRaw));
    let symbol = '?';
    try {
      const r = await call(a, '0x95d89b41');
      const hex = r.slice(2);
      // string ABI (offset, length, bytes) or a bytes32 symbol
      const raw = hex.length >= 192 ? hex.slice(128, 128 + 2 * parseInt(hex.slice(64, 128), 16)) : hex;
      symbol = new TextDecoder().decode(Uint8Array.from(raw.match(/../g) || [], (b) => parseInt(b, 16))).replace(/\0/g, '').trim() || '?';
    } catch {}
    if (!(dec >= 0 && dec <= 36)) throw new Error('not an ERC-20 token');
    return { address: a, symbol: symbol.slice(0, 12), decimals: dec };
  }

  // ---------- reading ----------
  // ETH, WBEAM and the extra tokens (their own list), read from the chain; other tokens Blockscout knows a
  // price for come along (unpriced ones are mostly airdropped spam and stay out)
  // known: the tokens this address had before (the host keeps them). Blockscout's list is not always whole: it
  // fails, or answers an empty list for an address it has not indexed. So the known tokens it does not name are
  // read on the chain itself (balanceOf), with their last known price, instead of vanishing. listed: whether
  // Blockscout answered at all.
  async function balances(address, extra = [], known = []) {
    const [eth, wbeam] = await Promise.all([rpc('eth_getBalance', [address, 'latest']), callBig(WBEAM, ERC20.balanceOf(address))]);
    const tokens = [{ address: WBEAM, symbol: 'WBEAM', decimals: 8, balance: wbeam.toString(), pinned: true }];
    const seen = new Set([WBEAM.toLowerCase()]);
    const mine = extra.filter((t) => !seen.has(t.address.toLowerCase()) && seen.add(t.address.toLowerCase()));
    const bals = await Promise.all(mine.map((t) => callBig(t.address, ERC20.balanceOf(address)).catch(() => null)));
    mine.forEach((t, k) => tokens.push({ ...t, balance: bals[k] == null ? null : bals[k].toString(), custom: true }));
    let listed = false;
    try {
      const list = await getJSON(`${BLOCKSCOUT}/addresses/${address}/token-balances`);
      for (const x of list || []) {
        const t = x.token || {};
        if (t.type !== 'ERC-20' || !t.address_hash || seen.has(t.address_hash.toLowerCase()) || !t.exchange_rate) continue;
        seen.add(t.address_hash.toLowerCase());
        tokens.push({ address: t.address_hash, symbol: String(t.symbol || '?').slice(0, 12), decimals: Number(t.decimals || 18),
          balance: String(x.value || '0'), usd: Number(t.exchange_rate) || null });
      }
      listed = true;
    } catch {}
    const rest = known.filter((t) => t && t.address && !seen.has(t.address.toLowerCase()) && seen.add(t.address.toLowerCase()));
    const kb = await Promise.all(rest.map((t) => callBig(t.address, ERC20.balanceOf(address)).catch(() => null)));
    rest.forEach((t, k) => { if (kb[k] != null) tokens.push({ address: t.address, symbol: t.symbol, decimals: t.decimals, balance: kb[k].toString(), usd: t.usd || null, cached: true }); });
    return { eth: BigInt(eth).toString(), tokens, listed };
  }

  // the account's last transactions and token transfers, newest first (Blockscout)
  async function history(address) {
    const a = address.toLowerCase();
    const [txs, tts] = await Promise.all([
      getJSON(`${BLOCKSCOUT}/addresses/${address}/transactions`).catch(() => ({ items: [] })),
      getJSON(`${BLOCKSCOUT}/addresses/${address}/token-transfers?type=ERC-20`).catch(() => ({ items: [] })),
    ]);
    const out = new Map();
    for (const t of txs.items || []) {
      out.set(t.hash, {
        hash: t.hash, time: t.timestamp, ok: t.status === 'ok', pending: !t.block_number && !t.block,
        out: (t.from && t.from.hash || '').toLowerCase() === a,
        from: t.from && t.from.hash, to: t.to && t.to.hash, value: t.value || '0', fee: (t.fee && t.fee.value) || '0',
        method: t.method || null, token: null,
      });
    }
    for (const t of tts.items || []) {
      const h = t.transaction_hash || t.tx_hash;
      const tok = t.token || {};
      const prev = out.get(h) || { hash: h, time: t.timestamp, ok: true, fee: '0', method: t.method || null };
      out.set(h, { ...prev, from: t.from && t.from.hash, to: t.to && t.to.hash, out: (t.from && t.from.hash || '').toLowerCase() === a,
        token: { symbol: tok.symbol || '?', decimals: Number(tok.decimals || (t.total && t.total.decimals) || 18), value: (t.total && t.total.value) || '0', address: tok.address_hash || tok.address } });
    }
    return [...out.values()].sort((x, y) => String(y.time).localeCompare(String(x.time))).slice(0, 50);
  }

  // ---------- writing ----------
  // An EIP-1559 transaction priced from the chain: the tip the last blocks paid (median, 0.05..3 gwei),
  // a max fee of 2 x base fee + tip (as the wallets do: it survives six full blocks of rising base fee).
  async function price(tx) {
    const [h, nonce, gas] = await Promise.all([
      rpc('eth_feeHistory', ['0x5', 'latest', [50]]),
      rpc('eth_getTransactionCount', [tx.from, 'pending']),
      rpc('eth_estimateGas', [{ from: tx.from, to: tx.to, data: tx.data || '0x', value: '0x' + BigInt(tx.value || 0).toString(16) }]),
    ]);
    const base = BigInt(h.baseFeePerGas[h.baseFeePerGas.length - 1]);
    const tips = (h.reward || []).map((x) => BigInt(x[0])).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let tip = tips.length ? tips[tips.length >> 1] : 100000000n;
    tip = tip < 50000000n ? 50000000n : tip > 3000000000n ? 3000000000n : tip;
    const gasLimit = (BigInt(gas) * 6n) / 5n + 1000n;       // 20 % over the estimate; unused gas is not paid
    const maxFee = 2n * base + tip;
    return {
      from: tx.from, to: tx.to, data: tx.data || '0x', value: BigInt(tx.value || 0).toString(),
      nonce: Number(BigInt(nonce)), gasLimit: gasLimit.toString(), maxFeePerGas: maxFee.toString(), maxPriorityFeePerGas: tip.toString(),
      // what it costs at today's base fee, and at most
      feeNow: (BigInt(gas) * (base + tip)).toString(), feeMax: (gasLimit * maxFee).toString(), perGasNow: (base + tip).toString(), baseGwei: Number(base) / 1e9,
    };
  }

  async function sign(secret, p) {
    const w = signer(secret);
    if (w.address.toLowerCase() !== p.from.toLowerCase()) throw new Error('the key does not match the sending account');
    return w.signTransaction({
      type: 2, chainId: CHAIN_ID, nonce: p.nonce, to: p.to, data: p.data, value: BigInt(p.value),
      gasLimit: BigInt(p.gasLimit), maxFeePerGas: BigInt(p.maxFeePerGas), maxPriorityFeePerGas: BigInt(p.maxPriorityFeePerGas),
    });
  }

  // The hash is the transaction's own (keccak of the signed bytes). An RPC that says "already known" (or "nonce
  // too low" for this very transaction) means an earlier try got through even if its answer was lost: that is
  // a success, not a failure to retry (a retry would be priced with the next nonce and send it twice).
  async function broadcast(raw) {
    const own = ethers.keccak256(raw);
    try {
      const hash = await rpc('eth_sendRawTransaction', [raw]);
      if (String(hash).toLowerCase() !== own.toLowerCase()) console.warn('the RPC answered another hash than the transaction\'s own', hash);
      return own;                       // the transaction's own hash, whatever an RPC says
    } catch (e) {
      if (/already known|known transaction/i.test(e.message)) return own;
      if (/nonce too low/i.test(e.message) && (await rpc('eth_getTransactionByHash', [own]).catch(() => null))) return own;
      // the answer may have been lost on the way: if the network has it, it went
      if (await rpc('eth_getTransactionByHash', [own]).catch(() => null)) return own;
      throw e;
    }
  }

  async function receipt(hash, timeoutMs = 15 * 60 * 1000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const r = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null);
      if (r) { if (r.status !== '0x1') throw new Error(`Ethereum transaction ${hash} failed`); return r; }
      await new Promise((res) => setTimeout(res, 4000));
    }
    throw new Error(`no receipt for ${hash} in ${timeoutMs / 60000} min: it may still confirm, see Activity`);
  }

  // decimal string <-> smallest units, exact (BigInt), at most `dec` decimals
  // A comma is a decimal point ("1,5"), but "1,000" could be a thousand: refused rather than guessed.
  function toUnits(s, dec) {
    const raw = String(s).trim();
    if (/^\d{1,3}(,\d{3})+$/.test(raw) || (raw.includes(',') && raw.includes('.'))) throw new Error(`"${raw}": write the amount without thousands separators, with one decimal point`);
    const t = raw.replace(',', '.');
    if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') throw new Error('not a number');
    const [i, f = ''] = t.split('.');
    if (f.length > dec) throw new Error(`at most ${dec} decimals`);
    return BigInt(i || '0') * 10n ** BigInt(dec) + BigInt((f + '0'.repeat(dec)).slice(0, dec) || '0');
  }

  const fromUnits = (v, dec) => { const x = BigInt(v), p = 10n ** BigInt(dec); const f = (x % p).toString().padStart(dec, '0').replace(/0+$/, ''); return `${x / p}${f ? '.' + f : ''}`; };

  return {
    fromUnits,
    WBEAM, ERC20, rpc, setRpc, DEFAULT_RPCS,
    isPhrase, normPhrase, isKey, normKey, signer, addressOf, isAddress, checkAddress,
    call, callBig, tokenInfo, balances, history, price, sign, broadcast, receipt, toUnits, getJSON,
    newPhrase: () => ethers.Wallet.createRandom().mnemonic.phrase,
    blockNumber: async () => Number(BigInt(await rpc('eth_blockNumber'))),
  };
})();
