// puzzle.bumblebeam.org API: the state of the 160 Bitcoin puzzle addresses, read from a Bitcoin node's
// mempool/esplora-style REST API, and the puzzle radar (what changed, with an optional Telegram post).
// Node 20+, no dependencies.
//
// The 2015 puzzle transaction pays address n (output n-1) a key from [2^(n-1), 2^n - 1]. For each of the
// first 160 outputs this keeps the address's whole confirmed history and works out:
//   solved    the first spend that took (net of change) at least half of what it held: the prize
//   exposed   an earlier spend (a day or more before the solve): the public key is on the chain, so
//             Pollard's kangaroo applies
//             (the creator did this for #65, #70, ..., #160 in 2019)
//   claiming  a spend from the address waiting in the mempool: someone is taking the prize right now
// Environment:
//   NODE_API        the node's REST API base, e.g. https://node.example/api (required; never in the repo)
//   DATA_DIR        where state.json lives (default /data)
//   PORT            8080
//   POLL_SECONDS    open puzzles are polled this often (60); solved ones every 30 minutes
//   TG_BOT_TOKEN, TG_CHAT_ID   radar posts to Telegram; nothing is sent while either is empty
//   TG_LANG         en | ru (en)
//   PUBLIC_URL      https://puzzle.bumblebeam.org (links in the posts)
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8080);
const NODE_API = (process.env.NODE_API || '').replace(/\/$/, '');
const DATA_DIR = process.env.DATA_DIR || '/data';
const POLL_MS = Number(process.env.POLL_SECONDS || 60) * 1000;
const SOLVED_POLL_MS = 30 * 60 * 1000;
const TG_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT = process.env.TG_CHAT_ID || '';
const TG_LANG = process.env.TG_LANG === 'ru' ? 'ru' : 'en';
const PUBLIC = (process.env.PUBLIC_URL || 'https://puzzle.bumblebeam.org').replace(/\/$/, '');
const UA = 'bumblebeam-puzzle/1.0';

const PUZZLE_TX = '08389f34c98c606322740c0be6a7125d9860bb8d5cb182c02f98461e5fa6cd15';
const PUZZLES = 160;
const SAT = 1e8;

if (!NODE_API) { console.error('NODE_API is not set'); process.exit(1); }

// ---------- node ----------
async function node(p, timeoutMs = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(NODE_API + p, { signal: ctl.signal, headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error(`${p}: node answered ${r.status}`);
    const ct = r.headers.get('content-type') || '';
    return ct.includes('json') ? r.json() : r.text();
  } finally { clearTimeout(t); }
}

// all confirmed txs of an address, newest first, down to (not including) a txid we already have
async function newConfirmed(addr, knownIds) {
  const out = [];
  let after = '';
  for (let page = 0; page < 500; page++) {
    const txs = await node(`/address/${addr}/txs${after ? `?after_txid=${after}` : ''}`, 60000);
    const conf = txs.filter((x) => x.status && x.status.confirmed);
    if (!conf.length) break;
    for (const x of conf) {
      if (knownIds.has(x.txid)) return out;
      out.push(x);
    }
    after = conf[conf.length - 1].txid;
    if (txs.length < 10) break;
  }
  return out;
}

// ---------- state ----------
// state.addr[n-1] = { address, txs: [{txid, time, height, in, out}] (in/out = sats to/from the address), checked }
const STATE_FILE = path.join(DATA_DIR, 'state.json');
let state = { puzzleTime: 0, addr: [], events: [], baseline: false, bench: [] };
try { state = Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch (_) { /* first start */ }
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state));
      fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
    } catch (e) { console.error('save:', e.message); }
  }, 2000);
}

const live = { tip: null, btcUsd: null, pricesAt: 0, mempool: {}, lastPoll: 0, lastError: null, ready: false };

function slim(addr, x) {
  let i = 0, o = 0;
  for (const v of x.vin || []) if (v.prevout && v.prevout.scriptpubkey_address === addr) i += v.prevout.value;
  for (const v of x.vout || []) if (v.scriptpubkey_address === addr) o += v.value;
  return { txid: x.txid, time: x.status.block_time || 0, height: x.status.block_height || 0, in: o, out: i };
}

// the facts of one puzzle from its history (txs after the puzzle transaction only: #1 was used before)
function analyse(n) {
  const a = state.addr[n - 1];
  const txs = a.txs.filter((t) => t.time >= state.puzzleTime).sort((x, y) => x.time - y.time || x.height - y.height);
  let bal = 0, peak = 0, solved = null, exposed = null;
  for (const t of txs) {
    const before = bal;
    bal += t.in - t.out;
    // by the net amount: solvers often send change back to the same address
    if (t.out > 0 && !solved) {
      if (before > 0 && t.out - t.in >= before * 0.5) solved = { time: t.time, txid: t.txid, height: t.height, amount: before };
      else if (!exposed) exposed = { time: t.time, txid: t.txid };
    }
    peak = Math.max(peak, bal);
  }
  // a spend shortly before the solve is the solver's own (splitting, testing the key), not an earlier exposure
  if (solved && exposed && solved.time - exposed.time < 86400) exposed = null;
  const mp = live.mempool[a.address] || null;
  return {
    n,
    address: a.address,
    bits: n,
    range: { from: n === 1 ? '1' : '2^' + (n - 1), to: '2^' + n + ' - 1' },
    balance: bal / SAT,
    peak: peak / SAT,
    status: solved || bal <= 0 ? 'solved' : 'open',
    solved: solved ? { time: solved.time, txid: solved.txid, height: solved.height, amount: solved.amount / SAT } : null,
    exposed: exposed ? { time: exposed.time, txid: exposed.txid } : null,
    claiming: mp && mp.spending ? { txid: mp.txid, seen: mp.seen } : null,
    txs: txs.length,
  };
}

function snapshot() {
  const list = [];
  for (let n = 1; n <= state.addr.length; n++) list.push(analyse(n));
  const open = list.filter((p) => p.status === 'open');
  // the pool's target: the smallest open puzzle with a hidden public key (brute force only); the next one when it falls
  const target = open.find((p) => !p.exposed) || null;
  return {
    updated: live.lastPoll ? Math.floor(live.lastPoll / 1000) : null,
    tip: live.tip,
    btc_usd: live.btcUsd,
    target: target ? target.n : null,
    open: open.length,
    open_btc: Math.round(open.reduce((s, p) => s + p.balance, 0) * SAT) / SAT,
    solved: list.length - open.length,
    puzzles: list,
  };
}

// ---------- radar ----------
const fmtBtc = (x) => (Math.round(x * 1e4) / 1e4).toString();
const T = {
  en: {
    solved: (p) => `🧩 Puzzle #${p.n} is solved: ${fmtBtc(p.solved.amount)} BTC taken from ${p.address}`,
    claiming: (p) => `🚨 Puzzle #${p.n}: a transaction spending ${fmtBtc(p.balance)} BTC is in the mempool right now`,
    exposed: (p) => `🔑 Puzzle #${p.n}: its public key is now on the chain (kangaroo applies)`,
    topup: (p, d) => `➕ Puzzle #${p.n}: +${fmtBtc(d)} BTC, prize now ${fmtBtc(p.balance)} BTC`,
    target: (from, to) => `🎯 The pool target moves from #${from} to #${to}`,
  },
  ru: {
    solved: (p) => `🧩 Пазл #${p.n} решён: с ${p.address} забрали ${fmtBtc(p.solved.amount)} BTC`,
    claiming: (p) => `🚨 Пазл #${p.n}: в мемпуле прямо сейчас транзакция, которая тратит ${fmtBtc(p.balance)} BTC`,
    exposed: (p) => `🔑 Пазл #${p.n}: его публичный ключ появился в блокчейне (работает кенгуру)`,
    topup: (p, d) => `➕ Пазл #${p.n}: +${fmtBtc(d)} BTC, приз теперь ${fmtBtc(p.balance)} BTC`,
    target: (from, to) => `🎯 Цель пула меняется с #${from} на #${to}`,
  },
};

async function telegram(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: `${text}\n${PUBLIC}`, disable_web_page_preview: true }),
    });
    if (!r.ok) console.error('telegram:', r.status, await r.text());
  } catch (e) { console.error('telegram:', e.message); }
}

function event(kind, p, extra = {}) {
  const ev = Object.assign({ time: Math.floor(Date.now() / 1000), kind, n: p ? p.n : null }, extra);
  state.events.unshift(ev);
  state.events = state.events.slice(0, 200);
  save();
  console.log('event', JSON.stringify(ev));
  if (!state.baseline) return;
  const t = T[TG_LANG];
  const text = kind === 'target' ? t.target(extra.from, extra.to) : kind === 'topup' ? t.topup(p, extra.delta) : t[kind](p);
  telegram(text);
}

let prev = null;
function compare() {
  const now = snapshot();
  if (prev) {
    for (const p of now.puzzles) {
      const q = prev.puzzles[p.n - 1];
      if (!q) continue;
      if (p.status === 'solved' && q.status === 'open' && p.solved) event('solved', p, { txid: p.solved.txid, amount: p.solved.amount });
      if (p.claiming && !q.claiming && p.status === 'open') event('claiming', p, { txid: p.claiming.txid, amount: p.balance });
      if (p.exposed && !q.exposed && p.status === 'open') event('exposed', p, { txid: p.exposed.txid });
      if (p.status === 'open' && p.balance - q.balance >= 0.01) event('topup', p, { delta: p.balance - q.balance });
    }
    if (now.target !== prev.target && prev.target && now.target) event('target', null, { from: prev.target, to: now.target });
  }
  prev = now;
  return now;
}

// ---------- polling ----------
async function refreshAddress(n) {
  const a = state.addr[n - 1];
  const s = await node(`/address/${a.address}`);
  const count = s.chain_stats.tx_count;
  if (count !== a.txs.length) {
    const fresh = await newConfirmed(a.address, new Set(a.txs.map((t) => t.txid)));
    a.txs = fresh.map((x) => slim(a.address, x)).concat(a.txs);
  }
  // mempool: is someone spending from it right now?
  if (s.mempool_stats && s.mempool_stats.tx_count > 0) {
    const mtx = await node(`/address/${a.address}/txs/mempool`);
    const spend = mtx.find((x) => (x.vin || []).some((v) => v.prevout && v.prevout.scriptpubkey_address === a.address));
    const was = live.mempool[a.address];
    live.mempool[a.address] = spend ? { spending: true, txid: spend.txid, seen: was && was.txid === spend.txid ? was.seen : Math.floor(Date.now() / 1000) } : null;
  } else live.mempool[a.address] = null;
  a.checked = Date.now();
}

async function pool(items, k, fn) {
  let i = 0;
  const errs = [];
  await Promise.all(Array.from({ length: k }, async () => {
    while (i < items.length) {
      const it = items[i++];
      try { await fn(it); } catch (e) { errs.push(e.message); }
    }
  }));
  return errs;
}

async function init() {
  if (!state.puzzleTime || state.addr.length < PUZZLES) {
    const tx = await node(`/tx/${PUZZLE_TX}`);
    state.puzzleTime = tx.status.block_time;
    state.addr = tx.vout.slice(0, PUZZLES).map((o, i) => (state.addr[i] && state.addr[i].address === o.scriptpubkey_address ? state.addr[i] : { address: o.scriptpubkey_address, txs: [], checked: 0 }));
    save();
  }
}

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    if (!state.addr.length) await init();
    const cur = prev || snapshot();
    const due = [];
    for (let n = 1; n <= state.addr.length; n++) {
      const a = state.addr[n - 1];
      const solved = cur.puzzles[n - 1] && cur.puzzles[n - 1].status === 'solved' && a.txs.length;
      if (!solved || Date.now() - (a.checked || 0) > SOLVED_POLL_MS) due.push(n);
    }
    const errs = await pool(due, 4, refreshAddress);
    try { live.tip = Number(await node('/blocks/tip/height')); } catch (e) { errs.push(e.message); }
    if (Date.now() - live.pricesAt > 10 * 60 * 1000) {
      try { const pr = await node('/v1/prices'); live.btcUsd = pr.USD || null; live.pricesAt = Date.now(); } catch (e) { errs.push(e.message); }
    }
    live.lastError = errs.length ? `${errs.length} errors, first: ${errs[0]}` : null;
    if (errs.length) console.error('poll:', live.lastError);
    live.lastPoll = Date.now();
    live.ready = true;
    compare();
    if (!state.baseline && !errs.length) { state.baseline = true; save(); console.log('baseline taken: radar posts on from now'); }
    save();
  } catch (e) {
    live.lastError = e.message;
    console.error('poll:', e.message);
  } finally {
    polling = false;
  }
}

// ---------- HTTP ----------
function send(res, status, body, maxAge = 0) {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': maxAge ? `public, max-age=${maxAge}` : 'no-cache',
    'access-control-allow-origin': '*',
  });
  res.end(s);
}

// ---------- benchmark results (/bench): what visitors' GPUs and CPUs did ----------
const benchSeen = new Map(); // client -> last post time
function benchTable() {
  const by = new Map();
  for (const b of state.bench || []) {
    const k = b.kind + ':' + b.gpu.toLowerCase().replace(/\s+/g, ' ');
    if (!by.has(k)) by.set(k, { gpu: b.gpu, kind: b.kind, rates: [] });
    by.get(k).rates.push(b.rate);
  }
  const rows = [...by.values()].map((g) => {
    const r = g.rates.sort((a, b) => a - b);
    return { gpu: g.gpu, kind: g.kind, runs: r.length, best: r[r.length - 1], median: r[Math.floor(r.length / 2)] };
  });
  return rows.sort((a, b) => b.best - a.best).slice(0, 200);
}
function benchPost(req, res) {
  const who = req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.socket.remoteAddress || '';
  const now = Date.now();
  if (now - (benchSeen.get(who) || 0) < 60000) return send(res, 429, { error: 'one result a minute' });
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
  req.on('end', () => {
    let b;
    try { b = JSON.parse(body); } catch (_) { return send(res, 400, { error: 'JSON body' }); }
    const gpu = String(b.gpu || '').replace(/[^\w .,+()\-/·]/g, '').trim().slice(0, 60);
    const rate = Number(b.rate);
    const kind = b.kind === 'cpu' ? 'cpu' : 'gpu';
    if (!gpu || !(rate > 1000 && rate < 1e12)) return send(res, 400, { error: 'gpu (a name) and rate (keys/s) are needed' });
    benchSeen.set(who, now);
    if (benchSeen.size > 10000) benchSeen.clear();
    state.bench = (state.bench || []).concat([{ time: Math.floor(now / 1000), gpu, kind, rate: Math.round(rate), cfg: String(b.cfg || '').slice(0, 20), info: String(b.info || '').slice(0, 120) }]).slice(-5000);
    save();
    send(res, 200, { ok: true });
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/bench' && req.method === 'POST') return benchPost(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'GET only' });
  if (url.pathname === '/api/bench') return send(res, 200, { rows: benchTable() }, 30);
  if (url.pathname === '/api/health') {
    const ok = live.ready && Date.now() - live.lastPoll < POLL_MS * 5;
    return send(res, ok ? 200 : 503, { ok, last_poll: live.lastPoll ? Math.floor(live.lastPoll / 1000) : null, error: live.lastError, tip: live.tip });
  }
  if (!live.ready) return send(res, 503, { error: 'starting: reading the puzzle addresses from the node' });
  if (url.pathname === '/api/puzzles') return send(res, 200, prev || snapshot(), 20);
  let m;
  if ((m = url.pathname.match(/^\/api\/puzzles\/(\d{1,3})$/))) {
    const n = Number(m[1]);
    if (n < 1 || n > state.addr.length) return send(res, 404, { error: 'puzzle 1..160' });
    const a = state.addr[n - 1];
    return send(res, 200, Object.assign(analyse(n), { history: a.txs.filter((t) => t.time >= state.puzzleTime).map((t) => ({ txid: t.txid, time: t.time, height: t.height, in: t.in / SAT, out: t.out / SAT })) }), 20);
  }
  if (url.pathname === '/api/events') return send(res, 200, { events: state.events.slice(0, 100) }, 20);
  send(res, 404, { error: 'not found', endpoints: ['/api/puzzles', '/api/puzzles/{n}', '/api/events', '/api/bench', '/api/health'] });
}).listen(PORT, () => console.log(`puzzle-api on :${PORT}, node ${NODE_API.replace(/\/\/[^/]+/, '//…')}`));

poll();
setInterval(poll, POLL_MS);
