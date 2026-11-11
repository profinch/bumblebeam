// The Bridge lab: the Bridge tab's next design, worked on apart from the wallet; made-up figures, nothing is sent. It
// moves into the wallet's Bridge tab once it is right.
(() => {
  const $ = (id) => document.getElementById(id);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  // thousands set apart by a narrow gap of its own (a third of a letter), the same in any font: a space in the
  // monospaced font is a whole letter wide
  const sep = (x) => x.replace(/,/g, '<span class="th"></span>');
  const num = (x, max = 8) => sep(x.toLocaleString('en-US', { maximumFractionDigits: max }));
  const usd = (x) => `$${sep(x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))}`;
  const sh = (a) => `${a.slice(0, 8)}…${a.slice(-6)}`;

  // made up: the wallet, its Ethereum accounts, the balances, the relayer's fee levels, the prices
  const ACCTS = [['Account 1', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', 1250], ['Savings for the house and long-term holdings', '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', 80.5], ['Trading', '0x90F79bf6EB2c4f870365E785982E1f101E93b906', 3.25],
    ['Cold', '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65', 0], ['Ledger', '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc', 412], ['Mining', '0x976EA74026E726554dB657fA54763abd0C3a0aa9', 27.75],
    ['Family', '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955', 5], ['Test', '0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f', 0.5]].map(([name, address, wbeam]) => ({ name, address, wbeam }));
  const BEAM_KEY = '03a7c41f0e9b2d58c6f3a1e47b90d2c5f8e1a36b7d40c9e25f1b8a3d6c07e49f12';      // made up: the Beam part's bridge key
  const BEAM = Number(new URLSearchParams(location.search).get('beam')) || 10132888.3653;      // ?beam=… to see another
  const FEES = { cheap: { fee: 17.5, gwei: 0.17, share: 74 }, normal: { fee: 22.82, gwei: 0.22, share: 78 }, safe: { fee: 38.04, gwei: 0.43, share: 87 } };
  const RATE = { beam: 0.00611 }, FE_FEE = 0.02;
  const GAS = { now: 0.15, median: 0.16 };              // made up: Ethereum's gas now and its day's median, gwei
  let dir = 'toEth', level = 'normal';

  const wd = BB.dropdown($('walletDd'), () => {}); wd.options([{ v: 'p', label: 'Personal' }], 'p');
  // Ethereum's account: the wallet tab's own picker (name | short address; the accounts scroll past 4, the actions
  // below). Another account picked, or stepped to with the wheel over it, its address runs as random hex and
  // settles (BB.decode). Going to Ethereum, "Enter an address" takes any address typed in (sending from Ethereum,
  // only one's own accounts can). The picker lies outside the cards and over its place in the Ethereum card;
  // that place holds a still copy of it, which is what tears on a turn.
  let cur = '0', mine = '0', other = '';             // the account picked ('typed': an address typed in), the last own one
  const PEN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/></svg>';
  const acctDd = BB.dropdown($('acctDd'), (v) => {
    if (v === '__type') { acctDd.set(cur); return typeIn(); }
    pick(v);
  });
  const accAd = () => $('acctDd').querySelector('.acc-b .ad');
  const addrOf = (v) => (v === 'typed' ? other : ACCTS[+v].address);
  function fillAccts() {
    const row = (v, nm, ad) => ({ v, label: `${nm} ${sh(ad)}`, html: `<span class="nm">${nm}</span><span class="ad">${sh(ad)}</span>`,
      btn: `<span class="acc-b"><span class="nm">${nm}</span><span class="ad">${sh(ad)}</span></span>` });
    const rows = ACCTS.map((x, k) => row(String(k), x.name, x.address));
    if (dir === 'toEth' && other) rows.push(row('typed', 'Other address', other));
    const acts = dir === 'toEth' ? [{ sep: true }, { v: '__type', label: 'Enter an address', html: `<span class="mi">${PEN}</span><span>Enter an address</span>` }] : [];
    acctDd.options([...rows, ...acts], cur);
    // as on the wallet tab: the accounts in a box of their own that scrolls past 4, the actions below it
    const list = $('acctDd').querySelector('.dd-list'), box = document.createElement('li'), ul = document.createElement('ul');
    box.className = 'dd-scroll'; box.setAttribute('role', 'presentation'); ul.setAttribute('role', 'group');
    [...list.querySelectorAll(':scope > [role="option"]')].filter((li) => !li.dataset.v.startsWith('__')).forEach((li) => ul.appendChild(li));
    box.appendChild(ul); list.insertBefore(box, list.firstChild);
    still();
  }
  function pick(v, run = true) {
    const was = cur;
    cur = v; if (v !== 'typed') mine = v;
    acctDd.set(v);
    if (run && v !== was) BB.decode(accAd, sh(addrOf(v)));
    still(); calc();
  }
  // the still copy in the card, and the picker laid over it
  function still() { $('bxGearBox').innerHTML = `<div class="dd compact acct"><button type="button" class="dd-btn" tabindex="-1">${$('acctDd').querySelector('.dd-btn').innerHTML}</button></div>`; }
  function lay() {
    const b = document.querySelector('.bx').getBoundingClientRect(), r = $('bxGearBox').getBoundingClientRect();
    Object.assign($('acctDd').style, { left: `${r.left - b.left}px`, top: `${r.top - b.top}px`, width: `${r.width}px` });
    // the copy's field: the page's gradient held to the window (fixed) is drawn, inside a torn strip (moved), as if
    // the whole page were the button: light at its foot. Its own place in the window says where it is cut from
    const g = $('bxGearBox').style;
    g.setProperty('--gx', `${-r.left}px`); g.setProperty('--gy', `${-r.top}px`);
    g.setProperty('--gw', `${innerWidth}px`); g.setProperty('--gh', `${innerHeight}px`);
  }
  addEventListener('resize', lay);
  // an address typed in: a field in the picker's place; Enter (or leaving it) with a good address takes it,
  // Escape (or leaving it empty) puts the account back
  function typeIn() {
    const inp = $('bxAddrIn');
    $('acctDd').classList.add('typing'); inp.hidden = false; inp.value = ''; inp.classList.remove('bad'); inp.focus();
  }
  function typed(take) {
    const inp = $('bxAddrIn'), v = inp.value.trim();
    if (take && v && !/^0x[0-9a-fA-F]{40}$/.test(v)) { inp.classList.add('bad'); return false; }
    inp.hidden = true; $('acctDd').classList.remove('typing');
    if (take && v) { other = v; cur = 'none'; fillAccts(); pick('typed'); }
    return true;
  }
  $('bxAddrIn').onkeydown = (e) => { if (e.key === 'Enter') typed(true); if (e.key === 'Escape') typed(false); };
  $('bxAddrIn').oninput = () => $('bxAddrIn').classList.remove('bad');
  $('bxAddrIn').onblur = () => { if (!typed(true)) typed(false); };
  // the wheel over it steps through one's own accounts, without opening the list
  let wheelAt = 0;
  $('acctDd').querySelector('.dd-btn').addEventListener('wheel', (e) => {
    e.preventDefault();
    const now = performance.now();
    if (now - wheelAt < 180) return;
    wheelAt = now;
    pick(String((+mine + (e.deltaY > 0 ? 1 : -1) + ACCTS.length) % ACCTS.length));
  }, { passive: false });
  const theAcct = () => ACCTS[+mine];

  // each network's own in its card's amount line: Beam's wallet, Ethereum's account picker
  function place() {
    const beam = dir === 'toEth' ? $('bxSend') : $('bxRecv'), eth = dir === 'toEth' ? $('bxRecv') : $('bxSend');
    // Beam's account (the wallet) and its dot in its card's corner, as far from it as From is from its own: top right
    // on top, bottom right below
    const nb = $('bxNetB');
    // the name, then its dot in the corner; Beam below: the same at the lower card's bottom right, mirrored
    if (dir === 'toEth') $('bxSend').querySelector('.bx-l1').appendChild(nb); else $('bxRecv').appendChild(nb);
    nb.classList.toggle('low', dir !== 'toEth');
    // Beam below (it receives): its bridge key at the bottom left, on the account's line; the tip on the word alone
    const bk = $('bxKey');
    bk.hidden = dir === 'toEth';
    if (dir !== 'toEth') {
      $('bxRecv').appendChild(bk); bk.innerHTML = `<span class="tipped" title="The bridge key of this wallet's Beam part: the Ethereum side sends to it">key</span> ${BEAM_KEY.slice(0, 6)}…${BEAM_KEY.slice(-6)}`;
      // on the account's line, measured (their sizes differ, and so do fonts: a fixed offset held in one only)
      const base = (el) => { el.insertAdjacentHTML('beforeend', '<i style="display:inline-block;width:0;height:0"></i>'); const y = el.lastElementChild.getBoundingClientRect().top; el.lastElementChild.remove(); return y; };
      bk.style.transform = '';
      bk.style.transform = `translateY(${(base(nb) - base(bk)).toFixed(1)}px)`;
    }
    nb.innerHTML = `${$('walletDd').querySelector('.dd-btn').textContent}<i class="chain beam"></i>`;
    eth.querySelector('.bx-l2').appendChild($('bxNetE'));
    eth.appendChild($('bxGearBox'));
    lay();
  }
  const amount = () => { const t = $('bxAmt').value.trim().replace(',', '.'); return /^\d*\.?\d*$/.test(t) && t && t !== '.' ? Number(t) : null; };
  // the bridge is 1 : 1: what is sent arrives whole; the relayer's fee is paid on top of it (from the same balance)
  function calc() {
    const toEth = dir === 'toEth', s = amount(), f = toEth ? FEES[level].fee : FE_FEE, have = toEth ? BEAM : theAcct().wbeam;
    const total = (s || 0) + f + (toEth ? 0.02 : 0);                   // with the fee (and, from Beam, its own ~0.02)
    const issue = s > 0 && total > have ? 'over balance + fee' : '';      // short: said under the amount, clear of the switch's cut      // nothing but digits and one point gets in (BB.amountField)
    $('bxAmt').classList.toggle('bad', !!issue);
    // "available" over the balance: its figures white, its unit grey (a problem with the amount in its place, yellow)
    $('bxAvail').textContent = 'available';
    $('bxIssue').textContent = issue;                    // what is wrong with the amount: under it, yellow
    $('bxHave').innerHTML = `${num(have, 4)} <span class="u">${toEth ? 'BEAM' : 'WBEAM'}</span>`;
    // the lower card: what the receiving side holds now (the top card's balance mirrored: the figure, its word under
    // it); at the left, under To, how long a transfer takes
    const there = toEth ? theAcct().wbeam : BEAM;
    $('bxThereHave').innerHTML = `${num(there, 4)} <span class="u">${toEth ? 'WBEAM' : 'BEAM'}</span>`;
    $('bxThereWord').textContent = 'there now';
    $('bxWhen').textContent = toEth ? 'usually about an hour' : 'about an hour, then claim';
    $('bxGo').innerHTML = s > 0 && !issue ? `<span>Bridge ${num(s)} ${toEth ? 'BEAM' : 'WBEAM'}</span>` : 'Bridge';      // one span: the button's flex gap would widen the thousands' gaps
    // the fee: three levels this way, fixed the other
    $('bxFee').hidden = !toEth;
    // the gauge: the arcs up to the level lit, the needle on the level's arc (-60°, 0°, 60° from upright)
    const li = Object.keys(FEES).indexOf(level);
    qa('#bxFee .arc').forEach((a, k) => { a.classList.toggle('on', k <= li); a.setAttribute('aria-checked', String(k === li)); });
    $('bxNeedle').style.transform = `rotate(${(li - 1) * 60}deg)`;
    $('bxFeeLv').innerHTML = `<span class="w">${level}</span> <b>${FEES[level].fee.toFixed(2)}</b>`;      // the word in a fixed width: the figure stays put
    // what it is for, in two short lines (no dots between bits): this way, gas now and how it stands against the
    // day, then how far the level covers it and its price; the other way the fixed fee, and how gas is paid. An amount
    // typed: the second line is what leaves in all
    const unit = toEth ? 'BEAM' : 'WBEAM';
    const mood = GAS.now < GAS.median * 0.8 ? 'low' : GAS.now > GAS.median * 1.25 ? 'high' : 'usual';
    const l1 = toEth ? `gas now <b>${GAS.now.toFixed(2)}</b> gwei, ${mood}` : `<b>${FE_FEE}</b> WBEAM to the relayer`;
    const l2 = s > 0 ? `total <b>${num(s + f)}</b> ${unit}` : toEth ? `covers to <b>${FEES[level].gwei.toFixed(2)}</b> for <b>${usd(FEES[level].fee * RATE.beam)}</b>` : 'its gas paid in ETH';
    $('bxFeeInfo').innerHTML = `<span>${l1}</span><span>${l2}</span>`;
    fit();
  }
  // the amount ends where the balance (and its word) begins, and a long one gets smaller (24 px down to 14) rather
  // than running under it
  function fit() {
    // the amount ends where the right's column begins (the balance, or "available" / a problem over it, whichever is
    // wider: big figures would touch the line above); a long one gets smaller, 24 px down to 12, shown from its start
    const inp = $('bxAmt');
    inp.style.marginRight = `${Math.max($('bxHave').offsetWidth, $('bxAvail').offsetWidth) + 12}px`;
    let px = 24;
    inp.style.fontSize = `${px}px`;
    while (px > 12 && inp.scrollWidth > inp.clientWidth) inp.style.fontSize = `${--px}px`;
    if (inp.scrollWidth <= inp.clientWidth) inp.scrollLeft = 0;
    // where the amount's figures stand: a field has no baseline to read, so a copy of its line (same font, same
    // height, centred as it is) is measured in its place
    inp.style.transform = '';
    const mark = '<i style="display:inline-block;width:0;height:0"></i>';      // an empty inline-block sits on the baseline
    const probe = document.createElement('span');
    const cs = getComputedStyle(inp);
    Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', font: cs.font, lineHeight: `${inp.offsetHeight}px`, height: `${inp.offsetHeight}px`, top: `${inp.offsetTop}px`, left: '0' });
    probe.innerHTML = `0${mark}`;
    inp.offsetParent.appendChild(probe);
    $('bxHave').insertAdjacentHTML('beforeend', mark);
    const hb = $('bxHave').lastElementChild;
    // ...no: the figures' middle halfway between the foot of Ethereum's account picker (where it stands in the upper
    // card, whether it is there now or not: the same height both ways) and the cut round the switch below; a figure
    // is about 0.72 of the size tall; their feet kept 3 px over the cut in any case
    const px2 = parseFloat(inp.style.fontSize), card = $('bxSend').getBoundingClientRect();
    const cutTop = $('bxSwap').getBoundingClientRect().top - 5;
    const ddFoot = card.top + 6 + $('bxGearBox').offsetHeight;      // 6: its top in the upper card (bridge.css)
    const want = Math.min((ddFoot + cutTop) / 2 + 0.36 * px2, cutTop - 3);
    const dy = want - probe.lastElementChild.getBoundingClientRect().top;
    // a problem with the amount stands on the balance's line (its baseline)
    const iss = $('bxIssue'), haveBase = hb.getBoundingClientRect().top;
    iss.style.top = '0px';
    iss.insertAdjacentHTML('beforeend', mark);
    iss.style.top = `${Math.round(haveBase - iss.lastElementChild.getBoundingClientRect().top)}px`;
    iss.lastElementChild.remove();
    probe.remove(); hb.remove();
    inp.style.transform = `translateY(${Math.round(dy)}px)`;
  }

  // all of it: a click on the balance (or its word over it) puts in the most that can go, the fee (and from Beam its
  // own ~0.02) left for, cut to 4 decimals
  const most = () => {
    const toEth = dir === 'toEth', have = toEth ? BEAM : theAcct().wbeam, f = toEth ? FEES[level].fee + 0.02 : FE_FEE;
    return Math.min(99999999.9999, Math.max(0, Math.floor((have - f) * 1e4 + 1e-6) / 1e4));      // as typed: at most 99 999 999.9999
  };
  document.querySelector('#bxSend > .bx-right').onclick = () => {
    const m = most();
    $('bxAmt').value = m > 0 ? String(m) : '';
    calc(); $('bxAmt').focus();
  };
  BB.amountField($('bxAmt'), 4, 8);                    // digits and one point (or comma) only: up to 99 999 999.1234
  $('bxAmt').oninput = calc;
  // the gauge: a click on an arc, or anywhere on the dial (its third by the pointer's side), or dragged across
  const g = document.querySelector('#bxFee .bx-gauge');
  const byX = (e) => { const r = g.getBoundingClientRect(); return Object.keys(FEES)[Math.min(2, Math.max(0, Math.floor((e.clientX - r.left) / r.width * 3)))]; };
  let dragging = false;
  g.addEventListener('pointerdown', (e) => { dragging = true; g.setPointerCapture(e.pointerId); level = byX(e); calc(); });
  g.addEventListener('pointermove', (e) => { if (!dragging) return; const k = byX(e); if (k !== level) { level = k; calc(); } });
  g.addEventListener('pointerup', () => { dragging = false; });
  $('bxGo').onclick = () => {
    let m = document.querySelector('.bx-go .act-msg');
    if (!m) { m = document.createElement('span'); m.className = 'act-msg'; $('bxGo').parentElement.appendChild(m); }
    const s = amount();
    m.classList.toggle('ok', s > 0);
    m.textContent = s > 0 ? 'lab: nothing is sent' : 'enter an amount';
  };

  // a turn: the content (not the titles) tears into strips that jerk sideways, moves to its card at the middle, and
  // comes back torn, settling
  const bx = document.querySelector('.bx'), cards = [$('bxSend'), $('bxRecv')], TURN = 460;
  let turning = false;
  function tear(t) {
    const d = Math.sin(Math.PI * t);
    cards.forEach((c) => {
      let lay = c.querySelector('.bx-tear');
      if (!lay) { lay = document.createElement('div'); lay.className = 'bx-tear'; c.appendChild(lay); }
      lay.textContent = '';
      const h = c.clientHeight, n = 3 + Math.floor(Math.random() * 5);
      const cuts = [0, ...Array.from({ length: n - 1 }, () => Math.random() * h).sort((a, b) => a - b), h];
      for (let k = 0; k < n; k++) {
        const s = document.createElement('div');
        s.className = 'bx-strip';
        for (const ch of c.children) if (!ch.classList.contains('bx-tear')) s.appendChild(ch.cloneNode(true));
        s.querySelectorAll('[id]').forEach((e) => e.removeAttribute('id'));      // copies without ids: $() must find the real ones (the picker was laid over a jerked copy)
        s.style.clipPath = `inset(${cuts[k].toFixed(1)}px 0 ${(h - cuts[k + 1]).toFixed(1)}px 0)`;
        s.style.transform = `translateX(${Math.random() < 0.3 ? 0 : ((Math.random() - 0.5) * 80 * d).toFixed(1)}px)`;
        lay.appendChild(s);
      }
    });
    bx.style.setProperty('--fade', String(1 - d * 0.65));
  }
  $('bxSwap').onclick = () => {
    if (turning) return;
    turning = true;
    if ($('acctDd').classList.contains('typing')) typed(false);
    lay();                                            // where the copy is cut from the page's gradient, now (the page may have scrolled)
    $('bxSwap').classList.toggle('back', dir === 'toEth');
    bx.classList.add('turning');
    const t0 = performance.now();
    let swapped = false;
    const frame = (now) => {
      const t = Math.min(1, (now - t0) / TURN);
      if (!swapped && t >= 0.5) { swapped = true; dir = dir === 'toEth' ? 'fromEth' : 'toEth'; if (dir === 'fromEth' && cur === 'typed') cur = mine; fillAccts(); $('bxAmt').value = ''; place(); calc(); }
      if (t < 1) { tear(t); requestAnimationFrame(frame); }
      else { cards.forEach((c) => c.querySelector('.bx-tear')?.remove()); bx.classList.remove('turning'); bx.style.removeProperty('--fade'); turning = false; lay(); }
    };
    requestAnimationFrame(frame);
  };

  // the transfers, made up: what arrived to claim on top, then both ways, newest first. Each row: the way, its number
  // (#, the Beam side's message), whom to or from, when (the date always in full, the time in 24 or 12 hours as
  // Settings has it), the amount with the fee paid under it, and its state; the amounts and states in columns of one
  // width down the list, so the figures stand one under another
  const pad = (n) => String(n).padStart(2, '0');
  let time12 = new URLSearchParams(location.search).get('t12') === '1';
  const fdt = (t) => { const d = new Date(t), h = d.getHours(); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${time12 ? `${h % 12 || 12}:${pad(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}` : `${pad(h)}:${pad(d.getMinutes())}`}`; };
  const ETH_FROM = '0x9d25B8a1C4e07f3D2b6A95c08E1f74d3a2efbCc5';
  const H = 3600e3, T0 = Date.now();
  const TR = [
    { way: 'in', no: 312, who: ETH_FROM, t: T0 - 0.4 * H, amt: 120, fee: 0.02, state: 'claim' },
    { way: 'out', no: 679, who: ACCTS[0].address, t: T0 - 0.3 * H, amt: 250, fee: 22.82, state: 'relaying' },
    { way: 'in', no: null, who: ETH_FROM, t: T0 - 1.2 * H, amt: 1000, fee: 0.02, state: 'mining' },
    { way: 'out', no: 677, who: ACCTS[0].address, t: Date.parse('2026-11-09T21:40:00'), amt: 80, fee: 17.5, state: 'arrived' },
    { way: 'in', no: 305, who: ACCTS[1].address, t: Date.parse('2026-11-08T09:15:00'), amt: 10132888.3653, fee: 0.02, state: 'claimed' },
    { way: 'out', no: 671, who: ACCTS[2].address, t: Date.parse('2026-11-07T18:02:00'), amt: 5.5, fee: 38.04, state: 'failed' },
  ];
  // and older ones, made up, so the list has pages: a transfer every half a day or so back
  for (let k = 0; k < 26; k++) {
    const out = k % 3 !== 1;
    TR.push({ way: out ? 'out' : 'in', no: out ? 670 - k : 300 - k, who: out ? ACCTS[k % 3].address : ETH_FROM, t: Date.parse('2026-11-07T18:02:00') - (k + 1) * 13.5 * H,
      amt: [250, 80, 1200, 15.75, 3000, 42][k % 6], fee: out ? [17.5, 22.82, 38.04][k % 3] : 0.02, state: out ? (k === 9 ? 'failed' : 'arrived') : 'claimed' });
  }
  const BADGE = { relaying: 'pending', mining: 'pending', arrived: 'ok', claimed: 'ok', failed: 'bad' };
  // the last 5 shown; "10 more" under them adds ten at a time
  let shown = 5;
  function transfers() {
    $('bList').innerHTML = TR.slice(0, shown).map((r) => {
      const way = r.way === 'out' ? 'BEAM → WBEAM' : 'WBEAM → BEAM';
      const end = r.state === 'claim' ? '<button type="button" class="btn solid small">Claim</button>' : `<span class="badge ${BADGE[r.state]}">${r.state}</span>`;
      return `<div class="li bx-tr"><span class="what">${way}${r.no ? ` <span class="no">#${r.no}</span>` : ''}<span class="sub">${r.way === 'out' ? 'to' : 'from'} ${sh(r.who)}</span><span class="sub"><a href="https://etherscan.io/" target="_blank" rel="noopener">${fdt(r.t)}</a></span></span>`
        + `<span class="money"><span class="amt">${num(r.amt, 4)}</span><span class="fee">fee ${r.fee.toFixed(2)}</span></span><span class="end">${end}</span></div>`;
    }).join('');
    // one width for the amounts' column: the widest of them
    const w = Math.max(...qa('#bList .money').map((m) => m.scrollWidth));
    $('bList').style.setProperty('--amtw', `${Math.ceil(w)}px`);
    const left = TR.length - shown;
    $('bMore').hidden = left <= 0;
    $('bMore').innerHTML = `<button type="button" class="btn ghost small">${Math.min(10, left)} more</button><span>${shown} of ${TR.length}</span>`;
  }
  $('bMore').onclick = (e) => { if (!e.target.closest('button')) return; shown += 10; transfers(); };
  transfers();
  try { chrome.storage.local.get('time12').then((v) => { if (v && 'time12' in v) { time12 = !!v.time12; transfers(); } }).catch(() => {}); } catch (e) { /* opened as a file: ?t12=1 */ }

  const q = new URLSearchParams(location.search).get('amt');
  if (q) $('bxAmt').value = q;                      // ?amt=… a sum in the field from the start (to look at)
  fillAccts(); place(); calc();
})();
