/* The pages' live numbers as HTML, one copy for the browser and the server: the page scripts (app.js, pooldash.js,
   bench.js, proof.js, puzzle.js) draw them from /api, and puzzle-api (api/pages.js) writes the same markup into the
   page before it is sent, so a crawler without JavaScript (and every visitor's first paint) gets the numbers, and
   the page script's later drawing changes nothing that was there. Pure: no DOM, no network.
   Each page's part returns { text: { id: string }, html: { id: string } }: the element with that id gets the text
   (textContent) or the markup (innerHTML); on the server, the place marked <!--ssr:id-->…<!--/ssr--> in the page.
   A classic script. Exposes BBRender. */
(function (root) {
  'use strict';

  // ---------- strings ----------
  // the home page's strings (English only), in one table
  var STR = {
    lead: '<b>Over 900 bitcoin lie on the blockchain, waiting for whoever finds the right numbers.</b> In <code class="mark">2015</code>, in what became known as the Bitcoin puzzle (or the 1000 BTC puzzle), an unknown creator sent bitcoin to <code class="mark">256</code> addresses (<code class="mark">160</code> of which still count) and deliberately made the keys easy: the key for <code class="mark">puzzle #N</code> is simply a number with <code class="mark">N</code> binary digits. The small ones fell within weeks. The creator then kept raising the prizes, and today <code class="mark">#N</code> holds about <code class="mark">N/10</code> BTC. From <a href="/puzzle/65">puzzle #65</a> onwards, every fifth puzzle has its public key in the open, making it far easier to crack. The rest can only be guessed, number by number: <a href="/puzzle/71">puzzle #71</a>, the next one, has <code class="mark">2⁷⁰</code> keys to try. Everything here is read live from a Bitcoin node, and <a href="/learn#odds">the odds</a> are honest. Play for the thrill, not for a paycheck.',
    openSolved: function (o, s) { return s + ' solved'; },
    targetSub: function (b) { return b + ' BTC (brute force only)'; },
    targetTitle: function (n) { return 'Puzzle #' + n + ' → next in line'; },
    soonFor: function (finder, prize, years) { return 'The easiest unsolved puzzle. Its public key has never been revealed, so the only known way in is to try the keys in its range one by one. Alone, that is a lottery ticket: one RTX 4090 would need about ' + years + ' years to try them all. The BumbleBeam pool searches it together: each browser is given its own piece of the range, no two browsers get the same piece, and whoever finds the key gets <b>' + finder + '</b> of <b>' + prize + ' BTC</b>.'; },
    method: { bf: 'brute force', kg: 'kangaroo' },
    knock: function (x, sats) { return (x > 1 ? x + '×' : '') + '<b>' + sats + ' sats</b>'; },
    noKnocks: 'No knocks yet.',
    quiet: function (t) { return 'Quiet: nothing has moved since we started watching (' + t + ').'; },
    ev: {
      solved: function (e) { return 'Puzzle #' + e.n + ' solved: ' + fmtBtc(e.amount) + ' BTC taken'; },
      claiming: function (e) { return 'Puzzle #' + e.n + ': a spend of ' + fmtBtc(e.amount) + ' BTC is in the mempool'; },
      exposed: function (e) { return 'Puzzle #' + e.n + ': its public key is now on the chain'; },
      topup: function (e) { return 'Puzzle #' + e.n + ': +' + fmtBtc(e.delta) + ' BTC'; },
      target: function (e) { return 'Next in line moves from #' + e.from + ' to #' + e.to; },
    },
    claimingNow: function (p) { return 'Puzzle #' + p.n + ' is being claimed right now: a transaction spending ' + fmtBtc(p.balance) + ' BTC waits in the mempool.'; },
    sOpen: 'open', sSolved: 'solved', sClaiming: 'in mempool',
    pkHidden: 'hidden', pkKnown: 'on chain', pkKnownTip: function (d) { return 'This address sent bitcoin out on ' + d + ', so its public key is visible on the blockchain. That makes the puzzle much easier to crack.'; },
  };

  // ---------- formatting ----------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmtBtc(x) { return x >= 100 ? x.toFixed(0) : x >= 1 ? (Math.round(x * 100) / 100).toString() : (Math.round(x * 1e4) / 1e4).toString(); }
  function fmtInt(x) { return Math.round(x).toLocaleString('en-US'); }
  function sup(n) { return String(n).split('').map(function (c) { return '⁰¹²³⁴⁵⁶⁷⁸⁹⁻'['0123456789-'.indexOf(c)] || c; }).join(''); }
  // the home page's: 10⁴ and up as m × 10ⁿ
  function sci(x) {
    if (!isFinite(x)) return '∞';
    if (x < 1e4) return x >= 100 ? fmtInt(x) : (Math.round(x * 100) / 100).toString();
    var e = Math.floor(Math.log10(x)), m = x / Math.pow(10, e);
    return m.toFixed(2).replace(/\.?0+$/, '') + ' × 10' + sup(e);
  }
  // an amount to the satoshi (a knock of 555 sats is 0.00000555, not 0)
  function exact(x) { return Number(x).toFixed(8).replace(/0+$/, '').replace(/\.$/, ''); }
  function date(t) { return t ? new Date(t * 1000).toISOString().slice(0, 10) : ''; }
  function rate(x) {
    var u = ['', 'k', 'M', 'G', 'T', 'P'], i = 0;
    while (x >= 1000 && i < u.length - 1) { x /= 1000; i++; }
    return (Math.round(x * 10) / 10) + ' ' + u[i] + 'keys/s';
  }
  function hexStart(n) { return '0x' + (BigInt(1) << BigInt(n - 1)).toString(16); }
  function hexEnd(n) { return '0x' + ((BigInt(1) << BigInt(n)) - BigInt(1)).toString(16); }
  // big numbers in words: 8.6 billion, 1.18 sextillion
  function words(x) {
    var n = ['', 'thousand', 'million', 'billion', 'trillion', 'quadrillion', 'quintillion', 'sextillion', 'septillion'], i = 0;
    x = Number(x);
    if (!(x > 0)) return '0';
    while (x >= 1000 && i < n.length - 1) { x /= 1000; i++; }
    return (x >= 100 ? Math.round(x) : Math.round(x * 10) / 10) + (n[i] ? ' ' + n[i] : '');
  }
  // one RTX 4090 brute-forcing, in keys a second: the speedometer's mark and the target text's yardstick (the
  // calculator on /learn rates the card the same)
  var RTX4090 = 5e9;
  // years for one such card to try every key of puzzle n, in two significant digits: 7,500 for #71
  function cardYears(n) {
    var y = Math.pow(2, n - 1) / RTX4090 / 31557600, e = Math.pow(10, Math.max(0, Math.floor(Math.log10(y)) - 1));
    return fmtInt(Math.round(y / e) * e);
  }
  // the same as a time: '7,500 years', or for a small puzzle '3 min'
  function cardTime(n) { var sec = Math.pow(2, n - 1) / RTX4090, y = sec / 31557600; return y >= 1e6 ? sci(y) + ' years' : sec > 86400 * 730 ? cardYears(n) + ' years' : C.dur(sec); }
  // the pool's and the benchmark's numbers (common.js formats them alike for /play and /learn)
  var C = {
    int: fmtInt,
    sci: function (x) {
      if (!isFinite(x)) return '∞';
      if (x < 1e6) return x >= 100 ? fmtInt(x) : (Math.round(x * 100) / 100).toString();
      var e = Math.floor(Math.log10(x)), m = x / Math.pow(10, e);
      return m.toFixed(2).replace(/\.?0+$/, '') + ' × 10' + sup(e);
    },
    rate: function (x, unit) {
      var u = ['', 'k', 'M', 'G', 'T'], i = 0;
      while (x >= 1000 && i < u.length - 1) { x /= 1000; i++; }
      return (x >= 100 ? Math.round(x) : Math.round(x * 10) / 10) + ' ' + u[i] + (unit || 'keys/s');
    },
    dur: function (sec) {
      if (!isFinite(sec)) return '∞';
      if (sec < 1) return '< 1 s';
      if (sec < 90) return Math.round(sec) + ' s';
      if (sec < 5400) return Math.round(sec / 60) + ' min';
      if (sec < 86400 * 2) return Math.round(sec / 3600) + ' h';
      var d = sec / 86400;
      if (d < 730) return fmtInt(d) + ' days';
      var y = d / 365.25;
      return (y >= 1e6 ? C.sci(y) : fmtInt(y)) + ' years';
    },
  };
  // a transaction as its first and last six characters, linked to our explorer (through /api/go)
  function txLink(txid) { return '<a class="mono" href="/api/go/tx/' + esc(txid) + '" target="_blank" rel="noopener" title="' + esc(txid) + '">' + esc(txid.slice(0, 6) + '…' + txid.slice(-6)) + '</a>'; }
  function addrLink(a) { return '<a class="mono" href="/api/go/address/' + esc(a) + '" target="_blank" rel="noopener">' + esc(a) + '</a>'; }
  // a puzzle's address, linked to the puzzle's page here (its balance on the explorer is linked from there)
  function pzAddrLink(n, a) { return '<a class="mono" href="/puzzle/' + n + '">' + esc(a) + '</a>'; }
  // a puzzle's number linked to its own page here
  function puzzleLink(n, p) { return n >= 1 && n <= 160 ? '<a href="/puzzle/' + n + '"' + (p ? ' title="' + esc(p.address) + '"' : '') + '>#' + n + '</a>' : '#' + n; }

  // ---------- the home page ----------
  // d: /api/puzzles; events: /api/events' list; knocks: /api/knocks' list; pool: /api/pool (or null)
  // o: { sort: { knocks: {k, dir}, solves: {k, dir} }, seen: { id: 1 } (rows already shown: the others drop in),
  //      knocks: how many knock rows at most (the server's first paint: the box scrolls, the page fills the rest) }
  function bySort(st, when, n) {
    return function (a, b) { var x = st.k === 'n' ? (n(a) - n(b)) * st.dir : 0; return x || (when(a) - when(b)) * (st.k === 'when' ? st.dir : -1); };
  }
  var SORT0 = { knocks: { k: 'when', dir: -1 }, solves: { k: 'when', dir: -1 } };
  function home(d, events, knocks, pool, o) {
    o = o || {};
    var s = STR, ps = d.puzzles, text = {}, html = {};
    var solved = ps.filter(function (p) { return p.status === 'solved' && p.solved; }).sort(function (a, b) { return b.solved.time - a.solved.time; });
    if (d.btc_usd) text['btc-price-v'] = '$' + fmtInt(d.btc_usd);
    text['t-open'] = fmtBtc(d.open_btc) + ' BTC';
    text['t-open-s'] = d.btc_usd ? '≈ $' + fmtInt(d.open_btc * d.btc_usd) : '\u00a0';
    text['t-count'] = d.open + '/' + ps.length;
    text['t-count-s'] = s.openSolved(d.open, d.solved);
    var t = d.target && ps[d.target - 1];
    if (t) {
      text['t-target'] = '#' + t.n;
      // the intro names the target too
      html.lead = s.lead.replace(/<a href="\/puzzle\/71">puzzle #71<\/a>, the next one, has <code class="mark">2⁷⁰/, '<a href="/puzzle/' + t.n + '">puzzle #' + t.n + '</a>, the next one, has <code class="mark">2' + sup(t.n - 1));
      // the split: the prize's whole bitcoins but one to the finder, 1 BTC and the fraction (less the fees) to the pool
      var prize = t.n / 10;
      html.soon = s.soonFor(Math.max(0, Math.floor(prize) - 1), prize, cardYears(t.n));
      text['t-target-s'] = s.targetSub(fmtBtc(t.balance));
      text['target-title'] = s.targetTitle(t.n);
      html['target-addr'] = pzAddrLink(t.n, t.address);
      text['target-range'] = hexStart(t.n) + ' … ' + hexEnd(t.n);
      text['target-keys'] = '2' + sup(t.n - 1) + ' ≈ ' + sci(Math.pow(2, t.n - 1));
      text['target-prize'] = fmtBtc(t.balance) + ' BTC' + (d.btc_usd ? ' ≈ $' + fmtInt(t.balance * d.btc_usd) : '');
    }
    var last = solved[0];
    if (last) {
      text['t-last'] = '#' + last.n;
      text['t-last-s'] = fmtBtc(last.solved.amount) + ' BTC (' + date(last.solved.time) + ')';
    }
    if (pool) Object.assign(text, poolFacts(pool));
    var sort = o.sort || SORT0;
    html['radar-now'] = radarNow(ps);
    html['radar-list'] = radarList(d, events, knocks, sort.knocks, o.seen, o.knocks);
    html.solves = solved.slice().sort(bySort(sort.solves, function (p) { return p.solved.time; }, function (p) { return p.n; })).map(function (p) {
      return '<tr><td class="dim">' + date(p.solved.time) + '</td><td class="name">' + puzzleLink(p.n, p) + '</td><td class="num">' + fmtBtc(p.solved.amount) + ' BTC</td><td>' + (p.exposed ? '<span class="badge solo">' + esc(s.method.kg) + '</span>' : '<span class="badge pending">' + esc(s.method.bf) + '</span>') + '</td><td>' + txLink(p.solved.txid) + '</td></tr>';
    }).join('');
    html.rows = rows(d);
    return { text: text, html: html, solved: solved };
  }
  // the pool in the target card: who searches now, how far it got (the speedometer is the page's own)
  function poolFacts(p) {
    var on = p.speed && p.active;
    return {
      'pl-active': on ? String(p.active) : 'nobody',
      'pl-active-s': on ? (p.active === 1 ? 'browser' : 'browsers') : 'yet: be the first',
      'pl-keys': words(p.keys_done || 0),
      'pl-of': 'of ' + words(Math.pow(2, (p.puzzle || 71) - 1)),
    };
  }
  function radarNow(ps) {
    var s = STR;
    return ps.filter(function (p) { return p.claiming; }).map(function (p) { return '<div class="note bad radar-now">🚨 ' + esc(s.claimingNow(p)) + ' ' + txLink(p.claiming.txid) + '</div>'; }).join('');
  }
  // the knocks, one line per puzzle, day and amount ('6 × 555 sats'), with the radar's own events among them
  function radarList(d, events, knocks, st, seen, max) {
    var s = STR, list = [];
    (knocks || []).forEach(function (k) {
      var l = list[list.length - 1];
      if (l && l.k && !l.note && !k.note && l.n === k.n && l.sats === k.sats && date(l.time) === date(k.time)) l.x++;
      else list.push({ k: true, n: k.n, time: k.time, sats: k.sats, txid: k.txid, x: 1, note: k.note || '' });
    });
    (events || []).forEach(function (e) { if (e.kind !== 'claiming') list.push({ k: false, e: e, time: e.time, n: e.n }); });
    // the radar's own events without a puzzle go after the numbered rows when sorting by #
    list.sort(bySort(st || SORT0.knocks, function (r) { return r.time; }, function (r) { return r.n || 1e9; }));
    if (max) list = list.slice(0, max);
    // a row first seen on a later load drops in from the top
    var out = list.map(function (r) {
      var isNew = seen && !seen[rowId(r)];
      if (r.k) {
        return '<tr class="' + (isNew ? 'new' : '') + '"><td class="dim">' + date(r.time) + '</td><td class="name">' + puzzleLink(r.n, d.puzzles[r.n - 1]) + '</td><td class="num">' + s.knock(r.x, fmtInt(r.sats)) + '</td><td class="knote"' + (r.note ? ' title="' + esc(r.note) + '"><span>' + esc(r.note) + '</span>' : '>') + '</td><td>' + txLink(r.txid) + '</td></tr>';
      }
      // the radar's own events (a prize raised, a key out, a solve, the target moving) span the knock and its tx
      var f = s.ev[r.e.kind];
      return '<tr class="ev' + (isNew ? ' new' : '') + '"><td class="dim">' + date(r.time) + '</td><td class="name">' + (r.n ? puzzleLink(r.n, d.puzzles[r.n - 1]) : '') + '</td><td colspan="2" title="' + esc(f ? f(r.e) : r.e.kind) + '">' + esc(f ? f(r.e) : r.e.kind) + '</td></tr>';
    }).join('');
    return out || '<tr><td colspan="5" class="dim">' + esc(d.updated ? s.quiet(date(d.updated)) : s.noKnocks) + '</td></tr>';
  }
  function rowId(r) { return r.k ? r.txid + r.n : 'e' + r.time + r.e.kind + r.n; }
  function radarIds(knocks, events) {
    var ids = {};
    (knocks || []).forEach(function (k) { ids[k.txid + k.n] = 1; });
    (events || []).forEach(function (e) { if (e.kind !== 'claiming') ids['e' + e.time + e.kind + e.n] = 1; });
    return ids;
  }
  // all 160 rows, always: the table's data-f (the filter buttons) hides what is not asked for (puzzle.css), so the
  // page has every puzzle in it, whatever is shown
  function rows(d) {
    var s = STR;
    return d.puzzles.map(function (p) {
      var st = p.claiming ? '<span class="badge bad">' + esc(s.sClaiming) + '</span>' : p.status === 'open' ? '<span class="badge ok">' + esc(s.sOpen) + '</span>' : '<span class="badge dimmed">' + esc(s.sSolved) + '</span>';
      var pk = p.exposed ? '<span class="badge solo tipped" title="' + esc(s.pkKnownTip(date(p.exposed.time))) + '">' + esc(s.pkKnown) + '</span>' : (p.status === 'open' ? '<span class="dim">' + esc(s.pkHidden) + '</span>' : '');
      var prize = p.status === 'open' ? fmtBtc(p.balance) : (p.solved ? '<span class="dim">' + fmtBtc(p.solved.amount) + '</span>' : '');
      return '<tr class="' + (p.status === 'open' ? 'is-open' : 'is-solved') + (p.exposed ? ' is-exposed' : '') + (p.n === d.target ? ' is-target' : '') + '"><td class="name">' + puzzleLink(p.n, p) + '</td><td>' + pzAddrLink(p.n, p.address) + '</td><td class="mono dim">' + (p.n > 1 ? hexStart(p.n) : '0x1') + '</td><td class="num">' + prize + '</td><td>' + st + '</td><td>' + pk + '</td><td class="dim">' + (p.solved ? date(p.solved.time) : '') + '</td></tr>';
    }).join('');
  }

  // ---------- /pool: the tiles ----------
  function poolTiles(s) {
    return { text: {
      'pl-title': 'Search #' + s.puzzle + ' together',
      't-speed': C.rate(s.speed || 0),
      't-speed-s': s.active ? s.active + (s.active === 1 ? ' browser' : ' browsers') : 'nobody searching',
      't-keys': C.sci(s.keys_done),
      't-share': s.share_done ? '1 in ' + C.sci(1 / s.share_done) + ' done' : 'of 2' + sup(s.puzzle - 1) + ' keys',
      't-pieces': C.int(s.chunks_done),
      't-pieces-s': 'of ' + C.sci(s.chunks_total),
      't-players': C.int(s.players),
      't-players-s': (s.players_week || 0) + ' this week',
      't-prize': s.finder_btc + ' BTC',
      't-prize-s': 'of ' + s.prize_btc + ' BTC',
      't-shuffle': s.shuffle ? s.shuffle.number + ' / ' + s.shuffle.of : 'not yet',
      't-shuffle-s': s.shuffle ? 'next at block ' + s.shuffle.next : 'starts with the first piece',
    }, html: s.prize_btc ? { 'pl-split': '<b>' + esc(s.finder_btc) + '</b> of <b>' + esc(s.prize_btc) + '&nbsp;BTC</b>' } : {} };
  }

  // ---------- /bench: the table ----------
  var UNSURE = '<span class="badge pending" title="The browser does not tell the exact model">not sure</span>';
  function benchRows(list) {
    return list.length ? list.map(function (r) {
      return '<tr><td>' + esc(r.gpu) + (r.kind === 'cpu' ? ' <span class="badge info" title="Processors are grouped by their thread count: browsers do not tell the model">cpu</span>' : '') + (r.sure === false ? ' ' + UNSURE : '') + '</td><td class="num">' + (r.runs >= 3 ? C.rate(r.best) : '<span class="dim">none</span>') + '</td><td class="num">' + C.rate(r.median) + '</td><td class="num">' + r.runs + '</td><td class="num">' + C.dur(Math.pow(2, 69) / r.median) + '</td></tr>';
    }).join('') : '<tr><td colspan="5" class="dim">No results yet: be the first.</td></tr>';
  }

  // ---------- /proof: a find ----------
  // a time as the find's card writes it: kept in UTC, shown in the viewer's own time where the page is drawn in a
  // browser (the server's first paint says UTC), the UTC time on hover: 20.11.2026, 17:57:45
  function day(t) {
    if (!t) return '';
    var d = new Date(t * 1000), two = function (n) { return (n < 10 ? '0' : '') + n; };
    var utc = two(d.getUTCDate()) + '.' + two(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear() + ', ' + two(d.getUTCHours()) + ':' + two(d.getUTCMinutes()) + ':' + two(d.getUTCSeconds()) + ' UTC';
    if (typeof window === 'undefined') return '<time datetime="' + d.toISOString() + '">' + utc + '</time>';
    return '<time datetime="' + d.toISOString() + '" title="' + utc + '">' + two(d.getDate()) + '.' + two(d.getMonth() + 1) + '.' + d.getFullYear() + ', ' + two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds()) + '</time>';
  }
  function kv(k, v) { return '<div><div class="k">' + k + '</div><div class="mono">' + v + '</div></div>'; }
  var STATUS = { pending: 'waiting for the prize to be spent', claimed: 'claimed by the pool transaction', taken: 'spent by a transaction not from the pool' };
  // a value with ui's copy button (proof.js wires them), and where it leads (the icon of a link), no link on the text
  function cpv(v) { return '<button type="button" class="cp" data-copy="' + esc(v) + '" title="' + esc(v) + '" aria-label="Copy ' + esc(v) + '"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></button>'; }
  function gov(href, title, out) { return '<a class="cp" href="' + esc(href) + '"' + (out ? ' target="_blank" rel="noopener"' : '') + ' title="' + esc(title) + '" aria-label="' + esc(title) + '"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2h5v5M14 2 7.5 8.5M12 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></a>'; }
  function val(v, extra) { return '<span class="proof-v"><span>' + esc(v) + '</span>' + cpv(v) + (extra || '') + '</span>'; }
  function btcOf(sats) { return (Number(sats) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, ''); }
  var NO_FINDS = 'No key has been found by the pool yet. When one is, its commitment shows here at once, and everything else once its prize is spent.';
  function proofCard(f) {
    var spent = f.status !== 'pending', c12 = f.commitment.slice(0, 12);
    var html = '<section class="panel proof-find" data-id="' + esc(f.commitment) + '"><div class="panel-head"><h2 class="panel-title"><a href="/puzzle/' + esc(f.puzzle) + '">Puzzle #' + esc(f.puzzle) + '</a></h2><div class="panel-meta">' + esc(STATUS[f.status] || f.status) + '</div></div>';
    // the rows the find's own receipt has, in its order and with its names
    html += '<div class="target-grid proof-grid">' +
      kv('Found', day(f.created)) +
      kv('Puzzle address', val(f.address, gov('/puzzle/' + f.puzzle, 'The page of puzzle #' + f.puzzle))) +
      (spent && f.finder_sats ? kv('To the finder', '<span class="accent-text">' + esc(btcOf(f.finder_sats)) + ' BTC</span>') : '') +
      kv('Payout address', '<span class="proof-v"><a href="/pool/' + encodeURIComponent(f.payout) + '">' + esc(f.payout) + '</a>' + cpv(f.payout) + '</span>') +
      kv('Commitment', val(f.commitment));
    if (spent) {
      html += kv('Key', f.key ? '<span class="proof-v"><span class="accent-text">' + esc(f.key) + '</span>' + cpv(f.key) + '</span>' : 'not received yet: the browser of the finder sends it on its next visit') +
        kv('Salt', f.salt ? val(f.salt) : 'none') +
        kv('Piece', esc(f.piece.from) + ' … ' + esc(f.piece.to)) +
        kv('Transaction', val(f.spend.txid, gov('/api/go/tx/' + f.spend.txid, 'The transaction on the block explorer', true)));
    }
    html += '</div><div class="actions-row proof-actions">' +
      '<button class="btn solid" type="button" data-verify' + (spent && f.key ? '' : ' disabled title="Once the prize is spent and the key published"') + '>Verify</button>' +
      (f.ots ? '<a class="btn ghost" href="/api/pool/finds/' + esc(f.commitment) + '.ots" download="puzzle-find-' + esc(c12) + '.ots" title="The OpenTimestamps proof that this commitment existed when its calendars wrote it to Bitcoin">Timestamp proof (.ots)</a>' : '<span class="dim">no calendar stamped it</span>') +
      (spent && f.key ? '<button class="btn ghost" type="button" data-bytes title="The bytes key ‖ payout address ‖ salt: their SHA-256 is the commitment">Committed data<svg class="btn-fp" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 18v-6a8 8 0 0 1 13.9-5.4"/><path d="M20 10.5V18"/><path d="M8 21v-9a4 4 0 0 1 8 0v6"/><path d="M12 12v9"/></svg></button>' : '') +
      '</div><ul class="checks proof-checks" hidden></ul>' +
      '<p class="dim proof-how">' + (spent && f.key
        ? 'The time of the commitment: open <a href="https://opentimestamps.org" target="_blank" rel="noopener">opentimestamps.org</a> and drop the timestamp proof there, then the committed data (key, payout address and salt, whose SHA-256 is the commitment). Once the calendars have written it to Bitcoin (a few hours after the find), it shows when the commitment existed: compare it with the block of the transaction.'
        : 'The timestamp proof shows when this commitment existed. The key, the salt and the transaction come once the prize is spent, and with them the committed data to check it on opentimestamps.org.') + '</p></section>';
    return html;
  }
  // the whole list, or the words for none
  function proof(finds) {
    return { text: {}, html: { finds: finds.length ? finds.map(proofCard).join('') : '<section class="panel proof-empty"><div class="panel-head"><h2 class="panel-title">Finds</h2></div><p class="dim proof-none" id="finds-none">' + esc(NO_FINDS) + '</p></section>' } };
  }

  // ---------- /puzzle/<n>: one puzzle ----------
  var SITE = 'https://puzzle.bumblebeam.org';
  // p: /api/puzzles/<n> (with its history); d: /api/puzzles (the target, the price), or null
  function puzzle(p, d) {
    var n = p.n, open = p.status === 'open', usd = d && d.btc_usd, isTarget = !!(d && d.target === n);
    // numbers, powers, dates and ranges in the text as the home page's intro has them (code marks)
    function mk(x) { return '<code class="mark">' + esc(x) + '</code>'; }
    var keys = Math.pow(2, n - 1), pow = '2' + sup(n - 1), range = mk(n > 1 ? hexStart(n) : '0x1') + ' and ' + mk(hexEnd(n));
    var pkSince = p.exposed ? date(p.exposed.time) : '';
    var text = {}, html = {}, intro;
    // the puzzle's name in its text: its address's balance on the explorer (the one place the site links there)
    var self = '<a href="/api/go/address/' + esc(p.address) + '" target="_blank" rel="noopener" title="' + esc(p.address) + ' on the block explorer">Puzzle #' + n + '</a>';
    if (open) {
      intro = self + ' is open: its address holds <b>' + fmtBtc(p.balance) + ' BTC</b>' + (usd ? ' (about $' + fmtInt(p.balance * usd) + ')' : '') + ', and its key has not been published by anyone. ' +
        'The key is a number between ' + range + ': ' + mk(pow + ' ≈ ' + sci(keys)) + ' keys. ';
      intro += p.exposed
        ? 'Its public key has been on the blockchain since ' + mk(pkSince) + ', which makes it far easier: the Pollard kangaroo needs about ' + mk('√(' + pow + ') ≈ ' + sci(Math.sqrt(keys))) + ' steps instead of trying every key (<a href="/learn">how</a>).'
        : 'Its public key has never been on the blockchain, so the only known way in is to try the keys one by one: one RTX 4090 would need about ' + mk(cardTime(n)) + ' for all of them.';
      if (isTarget) intro += ' It is the easiest open puzzle, the one <a href="/pool">the pool</a> searches now.';
      if (p.claiming) intro += ' <b>Right now a transaction spending it waits in the mempool:</b> someone is taking the prize.';
    } else if (!p.solved) {
      // solved, but how is not read yet
      intro = self + ' is solved: its prize has been taken. The key was a number between ' + range + ' (' + mk(pow) + ' keys).';
    } else {
      var sv = p.solved;
      intro = self + ' was solved on ' + mk(date(sv.time)) + ': whoever found its key took <b>' + fmtBtc(sv.amount || p.peak || 0) + ' BTC</b>' + (sv.txid ? ' in transaction ' + txLink(sv.txid) : '') + '. ' +
        'The key was a number between ' + range + ' (' + mk(pow) + ' keys). ' +
        (p.exposed ? 'Its public key had been on the blockchain since ' + mk(pkSince) + ', so the Pollard kangaroo could find it in about ' + mk('√(' + pow + ')') + ' steps.'
          : 'Its public key was not on the blockchain before, so the key was found by brute force: trying the keys one by one.');
      if (n >= 10 && n <= 48) intro += ' <a href="/play?n=' + n + '">Find it again in your browser</a>.';
    }
    html['pz-intro'] = intro;
    text['pz-title'] = 'Bitcoin Puzzle #' + n;
    text['pz-prize'] = (open ? fmtBtc(p.balance) : fmtBtc((p.solved && p.solved.amount) || p.peak || 0)) + ' BTC';
    text['pz-prize-s'] = open ? (usd ? '≈ $' + fmtInt(p.balance * usd) : '\u00a0') : p.solved ? 'taken ' + date(p.solved.time) : 'taken';
    // what the address holds now (for a solved puzzle, the dust sent to it since): the one link to the explorer's
    // balance on the site; every other link to a puzzle leads to its page here
    html['pz-bal'] = '<a href="/api/go/address/' + esc(p.address) + '" target="_blank" rel="noopener" title="' + esc(p.address) + ' on the block explorer">' + exact(p.balance || 0) + ' BTC</a>';
    text['pz-bal-s'] = 'on the block explorer';
    text['pz-status'] = open ? (p.claiming ? 'being claimed' : 'open') : 'solved';
    text['pz-status-s'] = open ? (isTarget ? 'next in line' : p.exposed ? 'public key known' : 'public key hidden') : (p.exposed ? 'by kangaroo' : 'by brute force');
    text['pz-keys'] = '2' + sup(n - 1);
    text['pz-keys-s'] = '≈ ' + sci(keys) + ' keys';
    text['pz-card'] = cardTime(n);
    text['pz-card-s'] = 'all keys on one RTX 4090';
    // the address as text, with ui's copy button (puzzle.js) and its balance on the explorer (the link icon)
    html['pz-addr'] = '<span class="pz-a">' + esc(p.address) + '</span><button type="button" class="cp" data-copy="' + esc(p.address) + '" title="' + esc(p.address) + '" aria-label="Copy the address"><svg viewBox=\"0 0 16 16\" aria-hidden=\"true\"><rect x=\"5\" y=\"5\" width=\"9\" height=\"9\" rx=\"1.5\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"/><path d=\"M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"/></svg></button><a class="cp" href="/api/go/address/' + esc(p.address) + '" target="_blank" rel="noopener" title="Its balance and transactions on the block explorer" aria-label="Its balance on the block explorer"><svg viewBox=\"0 0 16 16\" aria-hidden=\"true\"><path d=\"M9 2h5v5M14 2 7.5 8.5M12 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg></a>';
    text['pz-range'] = (n > 1 ? hexStart(n) : '0x1') + ' … ' + hexEnd(n);
    html['pz-pubkey'] = p.exposed ? 'on the blockchain since ' + esc(pkSince) + ' ' + txLink(p.exposed.txid) : esc(open ? 'never revealed' : 'not revealed before the solve');
    html['pz-solved'] = p.solved ? esc(date(p.solved.time)) + ' ' + txLink(p.solved.txid) : 'not yet';
    html['pz-actions'] = (open && isTarget ? '<a class="btn solid" href="/pool">Join the search</a><a class="btn ghost" href="/play?n=lottery">A lottery ticket</a>' : '') +
      (!open && n >= 10 && n <= 48 ? '<a class="btn solid" href="/play?n=' + n + '">Find it in your browser</a>' : '') +
      '<a class="btn ghost" href="/learn">How the puzzle works</a>';
    var hist = (p.history || []).slice(0, 200);
    html['pz-txs'] = hist.length ? hist.map(function (x) {
      // the note some senders write into their transaction (OP_RETURN), shown once approved, as on the radar
      return '<tr><td class="dim">' + date(x.time) + '</td><td>' + txLink(x.txid) + '</td><td class="num">' + (x.in ? '+' + exact(x.in) : '') + '</td><td class="num">' + (x.out ? '−' + exact(x.out) : '') + '</td><td class="knote"' + (x.note ? ' title="' + esc(x.note) + '"><span>' + esc(x.note) + '</span>' : '>') + '</td></tr>';
    }).join('') : '<tr><td colspan="5" class="dim">No transactions read yet.</td></tr>';
    text['pz-txs-n'] = (p.history || []).length + ' transaction' + ((p.history || []).length === 1 ? '' : 's') + (hist.length < (p.history || []).length ? ', the latest ' + hist.length + ' here' : '');
    html['pz-nav'] = (n > 1 ? '<a class="btn ghost" href="/puzzle/' + (n - 1) + '">← #' + (n - 1) + '</a>' : '') + '<a class="btn ghost" href="/">All 160 puzzles</a>' + (n < 160 ? '<a class="btn ghost" href="/puzzle/' + (n + 1) + '">#' + (n + 1) + ' →</a>' : '');
    var title = open ? 'Bitcoin Puzzle #' + n + ': Address, ' + fmtBtc(p.balance) + ' BTC Prize, Key Range' : p.solved ? 'Bitcoin Puzzle #' + n + ': Solved ' + date(p.solved.time) + ', ' + fmtBtc(p.solved.amount || p.peak || 0) + ' BTC' : 'Bitcoin Puzzle #' + n + ': Solved';
    var desc = !open && !p.solved ? 'Bitcoin puzzle #' + n + ' (' + p.address + ') is solved. Its key range and every transaction of the address.' : open
      ? 'Bitcoin puzzle #' + n + ' (' + p.address + '): ' + fmtBtc(p.balance) + ' BTC, unsolved. The key lies in ' + (n > 1 ? hexStart(n) : '0x1') + '…' + hexEnd(n) + ' (2^' + (n - 1) + ' keys); public key ' + (p.exposed ? 'on the blockchain since ' + pkSince : 'never revealed') + '. Live from a Bitcoin node, with every transaction.'
      : 'Bitcoin puzzle #' + n + ' (' + p.address + ') was solved on ' + date(p.solved && p.solved.time) + ': ' + fmtBtc((p.solved && p.solved.amount) || p.peak || 0) + ' BTC taken, ' + (p.exposed ? 'by the Pollard kangaroo (its public key was known)' : 'by brute force') + '. The key range, the solve transaction and every transaction of the address.';
    var url = SITE + '/puzzle/' + n;
    var ld = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'The Bitcoin puzzle', item: SITE + '/' },
      { '@type': 'ListItem', position: 2, name: 'Puzzle #' + n, item: url }] };
    // the page's own address and structured data, for its head (the server's page only: puzzle.js has no use for them)
    html.head = '<link rel="canonical" href="' + url + '">\n<meta property="og:url" content="' + url + '">\n<script type="application/ld+json">' + JSON.stringify(ld) + '</script>';
    return { text: text, html: html, head: { title: title + ' | BumbleBeam', description: desc, url: url, ogTitle: title } };
  }

  root.BBRender = {
    STR: STR, esc: esc, fmtBtc: fmtBtc, fmtInt: fmtInt, sup: sup, sci: sci, date: date, rate: rate, words: words, hexStart: hexStart, hexEnd: hexEnd,
    cardYears: cardYears, RTX4090: RTX4090, C: C, txLink: txLink, addrLink: addrLink, pzAddrLink: pzAddrLink, puzzleLink: puzzleLink,
    home: home, poolFacts: poolFacts, radarList: radarList, radarIds: radarIds, rows: rows, bySort: bySort,
    poolTiles: poolTiles, benchRows: benchRows, proof: proof, proofCard: proofCard, NO_FINDS: NO_FINDS, puzzle: puzzle,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.BBRender;
})(typeof self !== 'undefined' ? self : globalThis);
