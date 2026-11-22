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
//   PUBLIC_URL      https://puzzle.bumblebeam.org (links in the posts)
//   EXPLORER_URL    the block explorer the site links to (from the .env, mempool.space if unset)
//   POOL_TEST_PUZZLE  tests only: the pool searches this (long solved) puzzle instead of the radar's target, so the
//                   found-key flow can run end to end on #20's known key with made-up coins. Never set in production
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8080);
const NODE_API = (process.env.NODE_API || '').replace(/\/$/, '');
const DATA_DIR = process.env.DATA_DIR || '/data';
const POLL_MS = Number(process.env.POLL_SECONDS || 60) * 1000;
const SOLVED_POLL_MS = 30 * 60 * 1000;
const TG_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT = process.env.TG_CHAT_ID || '';
const PUBLIC = (process.env.PUBLIC_URL || 'https://puzzle.bumblebeam.org').replace(/\/$/, '');
const EXPLORER = (process.env.EXPLORER_URL || 'https://mempool.space').replace(/\/$/, '');
const UA = 'bumblebeam-puzzle/1.0';

const PUZZLE_TX = '08389f34c98c606322740c0be6a7125d9860bb8d5cb182c02f98461e5fa6cd15';
const PUZZLES = 160;
const SAT = 1e8;

if (!NODE_API) { console.error('NODE_API is not set'); process.exit(1); }

// the browser engine's reference (secp256k1, hashes) and address checks, shared with the site
function load(name) {
  for (const p of [path.join(__dirname, name), path.join(__dirname, '../web/engine', name), path.join(__dirname, '../web', name)]) if (fs.existsSync(p)) return require(p);
  throw new Error(name + ' not found');
}
const SECP = load('secp.js');
const GPUNAME = load('gpuname.js'); // the benchmark table's card names, made from what the browser tells
const TXL = load('tx.js');
const KIT = load('claimkit.js'); // the claim's split and checks, shared with the site
const RENDER = load('render.js'); // the pages' live numbers as HTML, shared with the site (pages.js)
// where puzzle-web serves the pages' own HTML (pages.js reads them from there: /_tpl/<file>)
const WEB_URL = (process.env.PUZZLE_WEB_URL || 'http://puzzle-web:8080').replace(/\/$/, '');
const TEST_PUZZLE = Number(process.env.POOL_TEST_PUZZLE) || 0;
if (TEST_PUZZLE) console.log(`POOL_TEST_PUZZLE: the pool searches #${TEST_PUZZLE}, for tests only`);

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
    // every open puzzle with a hidden public key, smallest first: the pool moves to the next one past a find whose
    // claim is stuck (pool.js)
    targets: open.filter((p) => !p.exposed).map((p) => p.n),
    open: open.length,
    open_btc: Math.round(open.reduce((s, p) => s + p.balance, 0) * SAT) / SAT,
    solved: list.length - open.length,
    puzzles: list,
  };
}

// ---------- knocks ----------
// small payments (under 0.01 BTC) into an open puzzle address, with nothing going out: someone 'knocking'. Nobody
// knows why (marks, tests, luck), but they show which puzzles are watched. Topups of 0.01 BTC and more are radar
// events instead (the creator raising a prize).
const KNOCK_MAX = 0.01 * SAT;
// knock notes: the OP_RETURN text of each knock's transaction, read once from the node and kept in the state; shown
// only for the txids approved in knock-notes.json (in the repo: a reviewed commit is the approval)
let APPROVED = new Set();
try { APPROVED = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, 'knock-notes.json'), 'utf8')).approved || []); } catch (e) { console.error('knock-notes.json:', e.message); }
function opReturnText(tx) {
  for (const o of tx.vout || []) {
    if (o.scriptpubkey_type !== 'op_return') continue;
    const hex = String(o.scriptpubkey_asm || '').split(' ').filter((p) => !p.startsWith('OP_') && /^[0-9a-f]+$/.test(p)).join('');
    const text = Buffer.from(hex, 'hex').toString('utf8');
    // readable text only: no control characters, no replacement characters, 1 to 80 characters
    if (text && text.length <= 80 && !/[\u0000-\u001f\u007f\ufffd]/.test(text)) return text.trim();
  }
  return '';
}
async function refreshNotes() {
  state.notes = state.notes || {};
  const todo = [];
  // the radar's knocks first, then the small payments into every other puzzle address (each puzzle's page shows
  // the notes of all its transactions); 40 reads a round
  for (const k of knocks(0, 100000).knocks) if (!(k.txid in state.notes) && !todo.includes(k.txid)) todo.push(k.txid);
  for (const a of state.addr) {
    if (todo.length >= 40) break;
    for (const t of a.txs) if (t.time >= state.puzzleTime && t.out === 0 && t.in > 0 && t.in < KNOCK_MAX && !(t.txid in state.notes) && !todo.includes(t.txid)) todo.push(t.txid);
  }
  for (const txid of todo.slice(0, 40)) {
    try {
      const text = opReturnText(await node(`/tx/${txid}`));
      state.notes[txid] = text;
      if (text && !APPROVED.has(txid)) console.log('knock note waiting for approval:', txid, JSON.stringify(text));
    } catch (e) { break; }
  }
}
// every transaction of puzzle n's address since the puzzle began, newest first, with its note when the note is
// approved (knock-notes.json, as on the radar)
function history(n) {
  return state.addr[n - 1].txs.filter((t) => t.time >= state.puzzleTime).map((t) => {
    const note = APPROVED.has(t.txid) && state.notes && state.notes[t.txid];
    return Object.assign({ txid: t.txid, time: t.time, height: t.height, in: t.in / SAT, out: t.out / SAT }, note ? { note } : {});
  });
}

function knocks(offset, limit) {
  const snap = prev || snapshot(), out = [];
  for (const p of snap.puzzles) {
    if (p.status !== 'open') continue;
    for (const t of state.addr[p.n - 1].txs) {
      if (t.time >= state.puzzleTime && t.out === 0 && t.in > 0 && t.in < KNOCK_MAX) {
        const note = APPROVED.has(t.txid) && state.notes && state.notes[t.txid];
        out.push(Object.assign({ n: p.n, time: t.time, sats: t.in, txid: t.txid }, note ? { note } : {}));
      }
    }
  }
  out.sort((x, y) => y.time - x.time || x.n - y.n);
  return { total: out.length, offset, knocks: out.slice(offset, offset + limit) };
}

// ---------- radar ----------
const fmtBtc = (x) => (Math.round(x * 1e4) / 1e4).toString();
// the radar's posts (English: the site is English only)
const T = {
  solved: (p) => `🧩 Puzzle #${p.n} is solved: ${fmtBtc(p.solved.amount)} BTC taken from ${p.address}`,
  claiming: (p) => `🚨 Puzzle #${p.n}: a transaction spending ${fmtBtc(p.balance)} BTC is in the mempool right now`,
  exposed: (p) => `🔑 Puzzle #${p.n}: its public key is now on the chain (kangaroo applies)`,
  topup: (p, d) => `➕ Puzzle #${p.n}: +${fmtBtc(d)} BTC, prize now ${fmtBtc(p.balance)} BTC`,
  target: (from, to) => `🎯 The pool target moves from #${from} to #${to}`,
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
  const t = T;
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
    try { await refreshNotes(); } catch (e) { console.error('notes:', e.message); }
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
const addrCache = new Map(); // address -> { at, v }
// each result's name made again from what its browser told (gpuname.js), so a rule changed there renames the old rows
// too and a typed name never shows; a result whose words name no card is left out
function benchName(b) {
  if (b.kind === 'cpu') return GPUNAME.cpu(b.threads || (/^CPU, (\d+) threads$/.exec(b.gpu || '') || [])[1]);
  return GPUNAME.of(b.info, b.ua || '');
}
// A result counts only when the run proved its speed: the page asks for a challenge sized to the speed it measured
// (about five seconds of work: a range with four keys hidden in it, among decoys), searches all of it and sends the
// keys back. The speed written down is the server's own: the range over the time between the challenge and the
// answer (a quarter second off for the network). Nobody can find the keys faster than the hardware searches.
// The number of hidden keys is random (8 to 16, and the page cannot tell which targets are decoys): a run that stops
// once it has found "enough" keys has missed some
const BENCH_SECONDS = 5, BENCH_TARGETS = 24;
const benchChallenges = new Map(); // id -> { who, kind, from, size, keys, issued, rate (once checked) }
// who sent a result, as a keyed hash (no IP is kept)
function hashWho(who) { return crypto.createHash('sha256').update('bench|' + who + '|' + (process.env.POOL_SECRET || DATA_DIR)).digest('hex').slice(0, 12); }
function benchWho(req) { return String(req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.socket.remoteAddress || ''); }
function benchBody(req, res, then) {
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) { req.resume(); return send(res, 400, { error: 'a JSON body (application/json), please' }); }
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
  req.on('end', () => {
    let b;
    try { b = JSON.parse(body); } catch (_) { return send(res, 400, { error: 'JSON body' }); }
    if (!b || typeof b !== 'object' || Array.isArray(b)) return send(res, 400, { error: 'a JSON object, please' });
    try { then(b); } catch (e) { send(res, 400, { error: 'a malformed request' }); }
  });
}
function benchChallenge(req, res) {
  benchBody(req, res, (b) => {
    const now = Date.now(), who = benchWho(req);
    for (const [id, c] of benchChallenges) if (now - c.issued > 15 * 60000) benchChallenges.delete(id);
    if ([...benchChallenges.values()].filter((c) => c.who === who && now - c.issued < 60000).length >= 6) return send(res, 429, { error: 'too many challenges, please wait a minute' });
    const rate = Number(b.rate);
    if (!(rate >= 1e5 && rate < 1e12)) return send(res, 400, { error: 'rate (keys/s) is needed' });
    const size = BigInt(Math.max(1e6, Math.min(2 ** 45, Math.round(rate * BENCH_SECONDS))));
    const rnd = (bytes) => BigInt('0x' + crypto.randomBytes(bytes).toString('hex'));
    // far up in #71's range, nowhere a pool piece would ask for these exact keys
    const from = (1n << 70n) + (rnd(8) << 2n);
    const keys = [];
    const nChecks = 8 + crypto.randomInt(9);
    while (keys.length < nChecks) { const k = from + rnd(8) % size; if (!keys.includes(k)) keys.push(k); }
    // the first target is a decoy (a search ends when its first target is found); the rest in a random order
    const decoys = () => crypto.randomBytes(20).toString('hex');
    const rest = keys.map((k) => SECP.hash160OfKey(k));
    while (rest.length < BENCH_TARGETS - 1) rest.push(decoys());
    for (let i = rest.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [rest[i], rest[j]] = [rest[j], rest[i]]; }
    const id = crypto.randomBytes(16).toString('hex');
    benchChallenges.set(id, { id, who, kind: b.kind === 'cpu' ? 'cpu' : 'gpu', from, size, keys, issued: now, rate: 0 });
    if (benchChallenges.size > 20000) benchChallenges.clear();
    send(res, 200, { id, from: '0x' + from.toString(16), to: '0x' + (from + size - 1n).toString(16), targets: [decoys()].concat(rest) });
  });
}
function benchCheck(req, res) {
  benchBody(req, res, (b) => {
    const c = benchChallenges.get(String(b.id || '')), now = Date.now();
    if (!c || c.who !== benchWho(req)) return send(res, 404, { error: 'no such challenge (they last 15 minutes)' });
    if (c.rate) return send(res, 409, { error: 'this challenge is answered already' });
    let got = [];
    try { got = (Array.isArray(b.keys) ? b.keys : []).slice(0, 64).map((k) => BigInt(String(k))); } catch (_) { got = []; }
    if (!c.keys.every((k) => got.includes(k))) { benchChallenges.delete(c.id); return send(res, 422, { error: 'the hidden keys are not all there: the range was not searched in full' }); }
    const sec = (now - c.issued) / 1000;
    c.rate = Number(c.size) / Math.max(sec - 0.25, sec * 0.9);
    send(res, 200, { ok: true, rate: Math.round(c.rate), seconds: sec });
  });
}

function benchTable() {
  const by = new Map();
  for (const b of state.bench || []) {
    if (!b.proven) continue; // from before results had to prove their speed
    const n = benchName(b);
    if (!n) continue;
    const k = b.kind + ':' + n.name + ':' + n.sure;
    if (!by.has(k)) by.set(k, { gpu: n.name, sure: n.sure, kind: b.kind, rates: [] });
    by.get(k).rates.push(b.rate);
  }
  const rows = [...by.values()].map((g) => {
    const r = g.rates.sort((a, b) => a - b);
    const h = r.length >> 1, median = r.length % 2 ? r[h] : Math.round((r[h - 1] + r[h]) / 2); // an even count: the two middle ones' mean
    return { gpu: g.gpu, sure: g.sure, kind: g.kind, runs: r.length, best: r[r.length - 1], median };
  });
  // ranked by the median: one lucky (or bent) run cannot lift a card to the top
  return rows.sort((a, b) => b.median - a.median).slice(0, 200);
}
function benchPost(req, res) {
  const who = benchWho(req);
  const now = Date.now();
  if (now - (benchSeen.get(who) || 0) < 60000) return send(res, 429, { error: 'one result a minute' });
  benchBody(req, res, (b) => {
    // the speed is the challenge's, measured here: the page's own number is not taken
    const c = benchChallenges.get(String(b.id || ''));
    if (!c || c.who !== who || !c.rate) return send(res, 400, { error: 'run the benchmark first: a result needs its proven run' });
    // ten results a day from one client at most, so nobody can push the others out of the table
    if ((state.bench || []).filter((x) => x.who === hashWho(who) && x.time > now / 1000 - 86400).length >= 10) return send(res, 429, { error: 'ten results a day, please' });
    // no name is taken from the visitor: it is made from the browser's own words for the card (info, the user agent)
    // or from the CPU's thread count, so the table holds only names gpuname.js made
    const kind = c.kind;
    const info = String(b.info || '').slice(0, 300), ua = String(req.headers['user-agent'] || '').slice(0, 300);
    const n = kind === 'cpu' ? GPUNAME.cpu(b.threads) : GPUNAME.of(info, ua);
    if (!n) return send(res, 400, { error: kind === 'cpu' ? 'threads (a number) is needed' : 'the browser did not name a graphics card we know' });
    const gpu = n.name;
    benchChallenges.delete(String(b.id));
    benchSeen.set(who, now);
    if (benchSeen.size > 10000) benchSeen.clear();
    state.bench = (state.bench || []).concat([{ time: Math.floor(now / 1000), who: hashWho(who), gpu, kind, rate: Math.round(c.rate), proven: 1, cfg: String(b.cfg || '').slice(0, 30), info, ua: kind === 'gpu' && /Firefox\//.test(ua) ? 'Firefox/' : '', threads: kind === 'cpu' ? Math.floor(Number(b.threads)) : undefined }]).slice(-5000);
    save();
    send(res, 200, { ok: true, gpu, sure: n.sure, rate: Math.round(c.rate) });
  });
}

// the shared search (pool.js): its target is the radar's, so it moves on by itself when a puzzle falls
const coordinator = require('./pool.js').createPool({
  dataDir: DATA_DIR, secp: SECP, tx: TXL, kit: KIT, node,
  target: () => TEST_PUZZLE || (prev ? prev.target : null),
  targets: () => (TEST_PUZZLE ? [TEST_PUZZLE] : prev ? prev.targets || [prev.target] : []),
  address: (n) => state.addr[n - 1] && state.addr[n - 1].address,
  tip: () => live.tip,
  blockHash: async (h) => String(await node(`/block-height/${h}`)).trim(),
  notify: (text) => telegram(text),
});

// Settings a find depends on, checked before anything is served: a typo in the pool's address would break every
// claim, a receipt key that is not the published one would make every receipt worthless, and a vault key on the
// server's own disk would seal nothing. The server does not start with any of them wrong (tests and a local preview
// say POOL_ALLOW_TEST_KEYS=1, or search a test puzzle).
// the pages with their live numbers written in (pages.js): what each page gets, from what is in memory
const pages = require('./pages.js').createPages({
  R: RENDER, webUrl: WEB_URL,
  parts(name, n) {
    const d = prev || snapshot();
    let v;
    if (name === 'index') v = RENDER.home(d, state.events.slice(0, 100), knocks(0, 1000).knocks, coordinator.stats(), { knocks: 40 });
    else if (name === 'pool') v = RENDER.poolTiles(coordinator.stats());
    else if (name === 'bench') v = { text: {}, html: { 'b-table': RENDER.benchRows(benchTable()) } };
    else if (name === 'proof') v = RENDER.proof(coordinator.finds.list().finds);
    else if (name === 'puzzle') {
      if (!(n >= 1 && n <= state.addr.length)) return null;
      v = RENDER.puzzle(Object.assign(analyse(n), { history: history(n) }), d);
    } else return null;
    if (d.btc_usd) v.text['btc-price-v'] = '$' + RENDER.fmtInt(d.btc_usd);
    return v;
  },
});

(function checkSettings() {
  const pay = process.env.POOL_PAYOUT_ADDRESS || '', testing = TEST_PUZZLE || process.env.POOL_ALLOW_TEST_KEYS === '1';
  const bad = [];
  if (!pay) bad.push('POOL_PAYOUT_ADDRESS is not set (the pool\'s part of a prize goes there)');
  else if (!TXL.isAddress(pay)) bad.push('POOL_PAYOUT_ADDRESS is not a Bitcoin mainnet address');
  else if (state.addr.some((a) => a && a.address === pay)) bad.push('POOL_PAYOUT_ADDRESS is a puzzle address');
  if (coordinator.vaultKeyOnDisk) bad.push('POOL_VAULT_KEY is not set: the vault\'s key would lie on this disk next to the keys it seals');
  if (coordinator.transportPub !== coordinator.transportPublished) (testing ? console.warn : (m) => bad.push(m))('the transport key (POOL_TRANSPORT_KEY) is not the one published in seal.js: no page could send a find');
  if (coordinator.receiptPub !== KIT.RECEIPT_PUB) (testing ? console.warn : (m) => bad.push(m))('the receipt key (POOL_RECEIPT_KEY) is not the one published in claimkit.js: receipts would prove nothing');
  if (bad.length && !testing) { bad.forEach((m) => console.error('settings: ' + m)); console.error('settings: refusing to start'); process.exit(1); }
  if (bad.length) bad.forEach((m) => console.warn('settings (testing, so going on): ' + m));
})();

// a log nobody reads any more (the pipe it went to is closed: a test runner killed) is no error to report: reporting
// it in the same log would fail again, round and round, at full CPU
for (const out of [process.stdout, process.stderr]) out.on('error', () => {});
// started by a test (stack.js: an IPC channel): gone with it
if (process.send) process.on('disconnect', () => process.exit(0));
// a bad request must never take the process down: log what slips through instead of exiting
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e));
process.on('uncaughtException', (e) => console.error('uncaught exception:', e));
// docker stop: the state written down at once (it is otherwise saved a moment after each change), then out
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch (e) { console.error('save on exit:', e.message); } process.exit(0); });

http.createServer(async (req, res) => {
  let url;
  try { url = new URL('http://x' + (req.url.startsWith('/') ? req.url : '/' + req.url)); } catch (_) { return send(res, 400, { error: 'bad request path' }); }
  try { await route(req, res, url); } catch (e) {
    console.error('request', req.method, req.url, e);
    if (!res.headersSent) send(res, 500, { error: 'internal error' });
  }
}).listen(PORT, () => console.log(`puzzle-api on :${PORT}, node ${NODE_API.replace(/\/\/[^/]+/, '//…')}`));

async function route(req, res, url) {
  let m0;
  if (await coordinator.handle(req, res, url, send)) return;
  if (url.pathname === '/api/bench' && req.method === 'POST') return benchPost(req, res);
  if (url.pathname === '/api/bench/challenge' && req.method === 'POST') return benchChallenge(req, res);
  if (url.pathname === '/api/bench/check' && req.method === 'POST') return benchCheck(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'GET only' });
  if (url.pathname === '/api/bench') return send(res, 200, { rows: benchTable() }, 30);
  // links to a transaction or an address go through here to the explorer named in the .env, so the pages never
  // carry its address and it can change without touching them
  if ((m0 = url.pathname.match(/^\/api\/go\/(tx|address)\/([0-9a-fA-F]{64}|[13][1-9A-HJ-NP-Za-km-z]{24,34}|bc1[02-9ac-hj-np-z]{11,71})$/))) {
    res.writeHead(302, { location: `${EXPLORER}/${m0[1]}/${m0[2]}`, 'cache-control': 'public, max-age=3600' });
    return res.end();
  }
  if (url.pathname === '/api/health') {
    const ok = live.ready && Date.now() - live.lastPoll < POLL_MS * 5;
    return send(res, ok ? 200 : 503, { ok, last_poll: live.lastPoll ? Math.floor(live.lastPoll / 1000) : null, error: live.lastError, tip: live.tip });
  }
  if (!live.ready) return send(res, 503, { error: 'starting: reading the puzzle addresses from the node' });
  if (await pages.handle(req, res, url)) return;
  if (url.pathname === '/api/puzzles') return send(res, 200, prev || snapshot(), 20);
  if (url.pathname === '/api/knocks') {
    const offset = Math.max(0, Math.floor(Number(url.searchParams.get('offset')) || 0));
    const limit = Math.min(1000, Math.max(1, Math.floor(Number(url.searchParams.get('limit')) || 1000)));
    return send(res, 200, knocks(offset, limit), 30);
  }
  let m;
  if ((m = url.pathname.match(/^\/api\/puzzles\/(\d{1,3})$/))) {
    const n = Number(m[1]);
    if (n < 1 || n > state.addr.length) return send(res, 404, { error: 'puzzle 1..160' });
    return send(res, 200, Object.assign(analyse(n), { history: history(n) }), 20);
  }
  // the unspent outputs of a puzzle address, for a claim built in the browser (the key never comes here)
  if ((m = url.pathname.match(/^\/api\/puzzles\/(\d{1,3})\/utxos$/))) {
    const n = Number(m[1]);
    if (n < 1 || n > state.addr.length) return send(res, 404, { error: 'puzzle 1..160' });
    try {
      const u = await node(`/address/${state.addr[n - 1].address}/utxo`);
      return send(res, 200, { address: state.addr[n - 1].address, utxos: u.map((x) => ({ txid: x.txid, vout: x.vout, value: x.value, confirmed: !!(x.status && x.status.confirmed) })) });
    } catch (e) { return send(res, 502, { error: 'node: ' + e.message }); }
  }
  // has this address ever been used? (the pool page warns about a never-used payout address: a typo that
  // still passes the checksum is rare, but a wrong address loses a prize for good)
  if ((m = url.pathname.match(/^\/api\/address\/([A-Za-z0-9]{25,90})$/))) {
    const a = m[1];
    if (!TXL.isAddress(a)) return send(res, 400, { error: 'not a Bitcoin mainnet address' });
    const hit = addrCache.get(a);
    if (hit && Date.now() - hit.at < 300000) return send(res, 200, hit.v, 60);
    try {
      const st = await node(`/address/${a}`);
      const v = { address: a, tx_count: st.chain_stats.tx_count + (st.mempool_stats ? st.mempool_stats.tx_count : 0) };
      if (addrCache.size > 5000) addrCache.delete(addrCache.keys().next().value);
      addrCache.set(a, { at: Date.now(), v });
      return send(res, 200, v, 60);
    } catch (e) { return send(res, 502, { error: 'node: ' + e.message }); }
  }
  if (url.pathname === '/api/price') return send(res, 200, { usd: live.btcUsd, time: live.pricesAt ? Math.floor(live.pricesAt / 1000) : null }, 60);
  if (url.pathname === '/api/fees') {
    try { return send(res, 200, await node('/v1/fees/recommended'), 30); } catch (e) { return send(res, 502, { error: 'node: ' + e.message }); }
  }
  if (url.pathname === '/api/events') return send(res, 200, { events: state.events.slice(0, 100) }, 20);
  send(res, 404, { error: 'not found', endpoints: ['/api/puzzles', '/api/puzzles/{n}', '/api/puzzles/{n}/utxos', '/api/events', '/api/bench', '/api/pool', '/api/price', '/api/health'] });
}

poll();
setInterval(poll, POLL_MS);
