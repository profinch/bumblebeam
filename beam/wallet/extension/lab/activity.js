// The Activity lab: the Activity tab's next design, worked on apart from the wallet; a made-up history, nothing is
// sent. It moves into the wallet's Activity tab once it is right.
//   - by day (Today, Yesterday, 9 Nov), each day's net in and out by its heading; what is under way above them all
//   - each row says who: an address book's name, one's own account, or the short address
//   - the amount with its unit (an asset by its name, not as BEAM) and its dollars under it
//   - a state only while it is not done (waiting for the receiver, 3 / 12 confirmations, failed: why); done says nothing
//   - the bridge's transfers and the dApps' calls by their own names and icons; an approval as one
//   - a pool's payouts in a day as one row with their count
//   - a click opens the row: its details (ids to copy, the explorer, the fee, the block) and what can be done
//   - All / In / Out / Bridge / dApps, and a search; the list kept while it refreshes, more by Older
(() => {
  const $ = (id) => document.getElementById(id);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const sep = (x) => x.replace(/,/g, '<span class="th"></span>');
  const num = (x, d = 6) => sep(x.toLocaleString('en-US', { maximumFractionDigits: d }));
  const usd = (x) => (x < 0.01 ? '< $0.01' : `$${sep(x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))}`);
  const sh = (a) => (a.startsWith('0x') ? `${a.slice(0, 8)}…${a.slice(-6)}` : `${a.slice(0, 6)}…${a.slice(-6)}`);
  const pad = (n) => String(n).padStart(2, '0');
  const hm = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day0 = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const dayName = (t) => { const k = Math.round((day0(Date.now()) - day0(t)) / 864e5); const d = new Date(t); return k === 0 ? 'Today' : k === 1 ? 'Yesterday' : `${d.getDate()} ${MON[d.getMonth()]}${d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : ''}`; };

  const wd = BB.dropdown($('walletDd'), () => {}); wd.options([{ v: 'p', label: 'Personal' }], 'p');

  const RATE = { BEAM: 0.0328, WBEAM: 0.0328, ETH: 3180, USDT: 1, bETH: 3180, NPH: 0 };
  const SVG = {
    in: '<svg viewBox="0 0 24 24"><path d="M12 4v14M6 12l6 6 6-6"/></svg>',
    out: '<svg viewBox="0 0 24 24"><path d="M12 20V6M6 12l6-6 6 6"/></svg>',
    br: '<svg viewBox="0 0 24 24"><path d="M4 9h14l-4-4M20 15H6l4 4"/></svg>',
    dapp: '<svg viewBox="0 0 24 24"><path d="M12 2.8 20 7.2v9.6L12 21.2 4 16.8V7.2z"/><path d="M4 7.2 12 11.6l8-4.4M12 11.6v9.6"/></svg>',
    ok2: '<svg viewBox="0 0 24 24"><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>',
    pool: '<svg viewBox="0 0 24 24"><path d="M12 3 3 8l9 5 9-5z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
  };

  // made up: whom the wallet knows (its address book, its own accounts), and a history on each network
  const now = Date.now(), H = 36e5, M = 6e4;
  const BOOK = { 'a1c3f09e4b7d': 'Alice', '7e20b4c8d1f3': 'BumbleBeam pool', 'c93d01e7a254': 'Exchange deposit', '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC': 'Savings', '0x90F79bf6EB2c4f870365E785982E1f101E93b906': 'Trading' };
  const BADDR = { alice: 'a1c3f09e4b7d5e8f2a6c1d3b9e0f7a24c6d8e1b3f5a7c9e0d2b4f6a8c0e1d3b5f7', pool: '7e20b4c8d1f3a5e7c9b0d2f4a6c8e0b1d3f5a7c9e1b3d5f7a9c0e2b4d6f8a1c3e5', exch: 'c93d01e7a254b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8', bob: 'f04a7c2e9b1d3f5a7c9e0b2d4f6a8c1e3b5d7f9a0c2e4b6d8f0a1c3e5b7d9f2a4c' };
  const ME = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  const name = (a) => BOOK[a] || BOOK[a.slice(0, 12)] || null;
  let n = 0;
  const id = () => (++n).toString(16).padStart(4, '0') + 'b7e1c94f0a2d6e38';
  const kern = () => Array.from({ length: 64 }, (_, i) => '0123456789abcdef'[(i * 7 + n * 13) % 16]).join('');
  const BEAMH = [
    { kind: 'out', t: now - 3 * M, v: 250, sym: 'BEAM', peer: BADDR.alice, st: 'pending', stage: 'waiting for Alice', comment: 'for the bikes', fee: 0.011, cancel: true },
    { kind: 'br-out', t: now - 22 * M, v: 5000, sym: 'BEAM', peer: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', st: 'pending', stage: 'arrives ≈ ' + hm(now + 38 * M), fee: 0.011, relayer: 22.82 },
    { kind: 'in', t: now - 2 * H, v: 1.25, sym: 'BEAM', peer: BADDR.pool, pool: true },
    { kind: 'in', t: now - 3 * H, v: 1.31, sym: 'BEAM', peer: BADDR.pool, pool: true },
    { kind: 'in', t: now - 5 * H, v: 1.18, sym: 'BEAM', peer: BADDR.pool, pool: true },
    { kind: 'in', t: now - 6 * H, v: 1.22, sym: 'BEAM', peer: BADDR.pool, pool: true },
    { kind: 'in', t: now - 4 * H - 10 * M, v: 120, sym: 'BEAM', peer: BADDR.bob, comment: 'thanks!' },
    { kind: 'dapp', t: now - 26 * H, v: 0.05, sym: 'bETH', app: 'DEX', what: 'Swap', got: [880.5, 'BEAM'], fee: 0.014 },
    { kind: 'out', t: now - 27 * H, v: 1000, sym: 'BEAM', peer: BADDR.exch, fee: 0.011 },
    { kind: 'out', t: now - 28 * H, v: 75, sym: 'BEAM', peer: BADDR.bob, st: 'cancelled', fee: 0 },
    { kind: 'br-in', t: now - 30 * H, v: 2500, sym: 'BEAM', peer: '0x90F79bf6EB2c4f870365E785982E1f101E93b906', fee: 0.011, claimed: true },
    { kind: 'in', t: now - 50 * H, v: 12, sym: 'NPH', peer: BADDR.alice, asset: 47 },
    { kind: 'in', t: now - 51 * H, v: 1.4, sym: 'BEAM', peer: BADDR.pool, pool: true },
    { kind: 'in', t: now - 52 * H, v: 1.36, sym: 'BEAM', peer: BADDR.pool, pool: true },
    { kind: 'in', t: now - 55 * H, v: 1.29, sym: 'BEAM', peer: BADDR.pool, pool: true },
    { kind: 'out', t: now - 74 * H, v: 40, sym: 'BEAM', peer: BADDR.bob, st: 'failed', why: 'the receiver did not answer in 12 h', fee: 0 },
    { kind: 'in', t: now - 76 * H, v: 310, sym: 'BEAM', peer: null, found: true },
  ];
  const ETHH = [
    { kind: 'br-out', t: now - 9 * M, v: 300, sym: 'WBEAM', peer: 'beam', st: 'pending', stage: '3 / 12 confirmations', fee: 0.00021 },
    { kind: 'approve', t: now - 10 * M, v: 300, sym: 'WBEAM', what: 'Approve the bridge', fee: 0.00009 },
    { kind: 'in', t: now - 4 * H, v: 5000, sym: 'WBEAM', peer: '0x0000000000000000000000000000000000000000', from: 'the bridge' },
    { kind: 'out', t: now - 25 * H, v: 0.15, sym: 'ETH', peer: '0x90F79bf6EB2c4f870365E785982E1f101E93b906', fee: 0.00004 },
    { kind: 'in', t: now - 26 * H, v: 250, sym: 'USDT', peer: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc' },
    { kind: 'dapp', t: now - 49 * H, v: 0, sym: 'ETH', app: 'Uniswap', what: 'Swap', got: [410.2, 'USDT'], gave: [0.13, 'ETH'], fee: 0.0011 },
    { kind: 'out', t: now - 50 * H, v: 0.5, sym: 'ETH', peer: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65', st: 'failed', why: 'out of gas: the fee is spent, the ETH stayed', fee: 0.0003 },
    { kind: 'in', t: now - 97 * H, v: 1.2, sym: 'ETH', peer: '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955' },
  ];
  for (const l of [BEAMH, ETHH]) for (const r of l) { r.id = id(); r.kern = kern(); r.block = 4119841 - Math.round((now - r.t) / 6e4); }

  // a pool's payouts in one day: one row with their count and sum
  function folded(list) {
    const out = [], at = new Map();
    for (const r of list) {
      if (!r.pool) { out.push(r); continue; }
      const k = `${r.peer}|${day0(r.t)}`;
      const g = at.get(k);
      if (g) { g.items.push(r); g.v += r.v; continue; }
      const ng = { ...r, items: [r], group: true };
      at.set(k, ng); out.push(ng);
    }
    return out.map((r) => (r.group && r.items.length < 2 ? r.items[0] : r));
  }

  let net = 'beam', kind = 'all', q = '', shown = 12;
  const open = new Set();
  const listOf = () => (net === 'beam' ? BEAMH : ETHH);
  const who = (r) => {
    if (r.kind === 'br-out') return net === 'beam' ? `to <b>${esc(name(r.peer) || sh(r.peer))}</b>` : 'to <b>Personal</b>';
    if (r.kind === 'br-in') return `from <b>${esc(name(r.peer) || sh(r.peer))}</b>`;
    if (r.kind === 'dapp') return `in <b>${esc(r.app)}</b>`;
    if (r.kind === 'approve') return '';
    if (r.found) return 'found on the chain';
    if (r.from) return `from <b>${esc(r.from)}</b>`;
    const nm = name(r.peer);
    return `${r.kind === 'in' ? 'from' : 'to'} <b>${esc(nm || sh(r.peer))}</b>`;
  };
  const title = (r) => ({ in: r.group ? 'Pool payouts' : 'Received', out: 'Sent', 'br-out': net === 'beam' ? 'Bridge → Ethereum' : 'Bridge → Beam', 'br-in': 'Bridge ← Ethereum', dapp: r.what, approve: r.what })[r.kind];
  const ic = (r) => (r.kind === 'in' ? (r.group ? ['in', SVG.pool] : ['in', SVG.in]) : r.kind === 'out' ? ['out', SVG.out] : r.kind.startsWith('br') ? ['br', SVG.br] : r.kind === 'dapp' ? ['dapp', SVG.dapp] : ['ok2', SVG.ok2]);
  const sign = (r) => (r.kind === 'in' || r.kind === 'br-in' ? '+' : r.kind === 'approve' ? '' : '−');
  const fits = (r) => {
    if (kind === 'in' && !(r.kind === 'in' || r.kind === 'br-in')) return false;
    if (kind === 'out' && r.kind !== 'out') return false;
    if (kind === 'bridge' && !r.kind.startsWith('br') && r.kind !== 'approve') return false;
    if (kind === 'dapp' && r.kind !== 'dapp') return false;
    if (!q) return true;
    const s = [title(r), r.peer, name(r.peer || ''), r.comment, r.app, String(r.v), r.sym, r.id, r.kern].filter(Boolean).join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).every((w) => s.includes(w));
  };

  function row(r) {
    const [c, svg] = ic(r), live = r.st === 'pending';
    const state = r.st === 'pending' ? `<span class="st">${esc(r.stage)}</span>` : r.st === 'failed' ? `<span class="st bad">failed: ${esc(r.why)}</span>` : r.st === 'cancelled' ? '<span class="st bad">cancelled</span>' : '';
    const sub = [live || r.group ? '' : hm(r.t), state, r.comment ? `<span class="cm">${esc(r.comment)}</span>` : '', r.group ? `${hm(r.items[r.items.length - 1].t)}–${hm(r.items[0].t)}` : ''].filter(Boolean).join('<i class="sp"></i>');
    const shownV = r.kind === 'dapp' && r.got ? r.got : [r.v, r.sym];
    const amt = r.kind === 'approve' ? `<span class="amt zero">${num(r.v)}<u>${esc(r.sym)}</u></span>`
      : `<span class="amt ${r.kind === 'in' || r.kind === 'br-in' || (r.kind === 'dapp' && r.got) ? 'pos' : ''}">${r.kind === 'dapp' ? '+' : sign(r)}${num(shownV[0])}<u>${esc(shownV[1])}</u></span>`;
    const rate = RATE[shownV[1]];
    const usdLine = r.kind === 'approve' ? '<span class="usd">allowance</span>' : rate ? `<span class="usd">${usd(shownV[0] * rate)}</span>` : '<span class="usd">no price</span>';
    const cls = ['li', 'ar', r.st === 'failed' ? 'bad' : '', r.st === 'cancelled' ? 'dim' : '', open.has(r.id) ? 'open' : ''].filter(Boolean).join(' ');
    return `<div class="${cls}" data-id="${r.id}" tabindex="0" role="button" aria-expanded="${open.has(r.id)}"><span class="ic ${c}${live ? ' spin' : ''}">${svg}</span>
      <span class="what">${esc(title(r))}${r.group ? `<span class="x">×${r.items.length}</span>` : ''} <span class="who">${who(r)}</span><span class="sub">${sub}</span></span>
      <span class="ar-r">${amt}${usdLine}</span></div>${open.has(r.id) ? more(r) : ''}`;
  }

  const cp = (v) => `<span class="cp" data-copy="${esc(v)}" title="Copy">${SVG.copy}</span>`;
  function more(r) {
    const rows = [];
    if (r.group) {
      return `<div class="ar-more">${r.items.map((x) => `<div class="sub-li"><span>${hm(x.t)}<i class="sp"></i>block ${x.block}</span><b>+${num(x.v)} ${esc(x.sym)}</b></div>`).join('')}
        <dl class="kv" style="margin-top:8px"><dt>From</dt><dd>${esc(name(r.peer) || '')}\n${esc(r.peer)}${cp(r.peer)}</dd></dl></div>`;
    }
    const full = new Date(r.t);
    rows.push(['When', `${pad(full.getDate())}.${pad(full.getMonth() + 1)}.${full.getFullYear()} ${hm(r.t)}`]);
    if (r.peer && r.peer !== 'beam') rows.push([r.kind === 'in' || r.kind === 'br-in' ? 'From' : 'To', `${esc(name(r.peer) ? `${name(r.peer)}\n` : '')}${esc(r.peer)}${cp(r.peer)}`]);
    if (r.kind === 'br-out' && net === 'eth') rows.push(['To', 'Personal on Beam\nBeam bridge key: 03a7c4…e49f12']);
    if (r.kind === 'dapp') rows.push(['Gave', `${num(r.gave ? r.gave[0] : r.v)} ${esc(r.gave ? r.gave[1] : r.sym)}`], ['Got', `${num(r.got[0])} ${esc(r.got[1])}`]);
    if (r.asset) rows.push(['Asset', `${esc(r.sym)} (id ${r.asset})`]);
    if (r.relayer) rows.push(['Relayer fee', `${num(r.relayer)} BEAM`]);
    if (r.fee) rows.push([net === 'beam' ? 'Net fee' : 'Gas', `${num(r.fee, 8)} ${net === 'beam' ? 'BEAM' : 'ETH'}${RATE[net === 'beam' ? 'BEAM' : 'ETH'] ? ` | ${usd(r.fee * RATE[net === 'beam' ? 'BEAM' : 'ETH'])}` : ''}`]);
    if (r.comment) rows.push(['Comment', esc(r.comment)]);
    if (r.st === 'failed') rows.push(['Why', esc(r.why)]);
    if (net === 'beam') {
      rows.push(['Transaction', `${esc(sh(r.id + r.kern.slice(0, 16)))}${cp(r.id + r.kern.slice(0, 16))}`]);
      if (r.st !== 'pending' && r.st !== 'cancelled' && r.st !== 'failed') rows.push(['Kernel', `<a href="#" onclick="return false">${esc(sh(r.kern))}</a>${cp(r.kern)}`], ['Block', String(r.block)]);
    } else {
      rows.push(['Hash', `<a href="#" onclick="return false">${esc(sh('0x' + r.kern))}</a>${cp('0x' + r.kern)}`]);
      if (r.st !== 'pending') rows.push(['Block', String(23781200 - Math.round((now - r.t) / 12e3))]);
    }
    const acts = [];
    if (r.cancel) acts.push('<button type="button" class="btn warn">Cancel</button>');
    if (r.kind === 'out' && r.peer && r.st !== 'pending') acts.push('<button type="button" class="btn">Send again</button>');
    if (r.kind === 'br-out' || r.kind === 'br-in') acts.push('<button type="button" class="btn">In the Bridge</button>');
    if (r.peer && !name(r.peer) && r.peer.length > 20 && r.kind !== 'br-out') acts.push('<button type="button" class="btn">Name it</button>');
    return `<div class="ar-more"><dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>${acts.length ? `<div class="ar-acts">${acts.join('')}</div>` : ''}</div>`;
  }

  function draw() {
    const all = folded(listOf()).filter(fits);
    const live = all.filter((r) => r.st === 'pending'), rest = all.filter((r) => r.st !== 'pending');
    const page = rest.slice(0, shown);
    let html = '';
    if (live.length) html += `<div class="ad-day now"><span>Under way</span><span class="sum">${live.length}</span></div>${live.map(row).join('')}`;
    const days = new Map();
    for (const r of page) { const k = day0(r.t); if (!days.has(k)) days.set(k, []); days.get(k).push(r); }
    for (const [k, rs] of days) {
      // the day's net: what came minus what went, BEAM (or the network's main coin) only
      const main = net === 'beam' ? 'BEAM' : 'ETH';
      const sum = rs.filter((r) => r.sym === main && !r.st).reduce((s, r) => s + (r.kind === 'in' || r.kind === 'br-in' ? r.v : r.kind === 'approve' || r.kind === 'dapp' ? 0 : -r.v), 0);
      html += `<div class="ad-day"><span>${dayName(k)}</span><span class="sum">${sum ? `<span class="${sum > 0 ? 'pos' : ''}">${sum > 0 ? '+' : '−'}${num(Math.abs(sum), 4)}</span> ${main}` : ''}</span></div>${rs.map(row).join('')}`;
    }
    $('actList').innerHTML = html || `<div class="empty">${q || kind !== 'all' ? 'nothing like that here' : 'no transactions yet'}</div>`;
    $('afMore').hidden = rest.length <= shown;
    // the counts on the filters, for what is in the list now
    const base = folded(listOf());
    for (const b of qa('#afKind button')) {
      const k0 = kind; kind = b.dataset.k; const c = base.filter(fits).length; kind = k0;
      b.innerHTML = `${b.dataset.k === 'dapp' ? 'dApps' : b.dataset.k[0].toUpperCase() + b.dataset.k.slice(1)}${b.dataset.k !== 'all' ? `<span class="n">${c}</span>` : ''}`;
    }
  }

  $('actNet').onclick = (e) => { const b = e.target.closest('button[data-n]'); if (!b) return; net = b.dataset.n; qa('#actNet button').forEach((x) => x.classList.toggle('on', x === b)); open.clear(); shown = 12; draw(); };
  $('afKind').onclick = (e) => { const b = e.target.closest('button[data-k]'); if (!b) return; kind = b.dataset.k; qa('#afKind button').forEach((x) => x.classList.toggle('on', x === b)); draw(); };
  $('afFind').onclick = () => { const r = $('afSearchRow'); r.hidden = !r.hidden; $('afFind').classList.toggle('on', !r.hidden); if (!r.hidden) $('afQ').focus(); else { q = ''; $('afQ').value = ''; draw(); } };
  $('afQ').oninput = () => { q = $('afQ').value.trim(); draw(); };
  $('afX').onclick = () => { $('afQ').value = ''; q = ''; draw(); $('afQ').focus(); };
  $('afMore').onclick = () => { shown += 12; draw(); };
  $('actList').onclick = (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) { navigator.clipboard.writeText(c.dataset.copy).catch(() => {}); c.title = 'Copied'; return; }
    if (e.target.closest('.ar-more')) return;
    const li = e.target.closest('.li.ar'); if (!li) return;
    if (open.has(li.dataset.id)) open.delete(li.dataset.id); else open.add(li.dataset.id);
    draw();
  };
  $('actList').onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.li.ar')) { e.preventDefault(); e.target.click(); } };
  draw();
})();
