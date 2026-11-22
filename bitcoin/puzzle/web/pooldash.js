/* /pool: the pool at a glance, and the way in. The tiles, the pool's speed over time, the way in (a new searcher's
   address and Start; your page when this browser has an address; how far the search is while one runs), what
   happened lately, the top, the haystack (the range and the pieces searched in it) and the hive (every searcher).
   Start opens the searcher's own page (/pool/<address>; an address is needed), which runs the search
   (pool.js). Run again on every visit (nav.js); it ends its timers and the live stream on 'bb:leave'. */
(function () {
  'use strict';
  var P = window.BBP, T = window.BBTx;
  function $(id) { return document.getElementById(id); }
  if (!$('g-join')) return;
  var esc = window.BB.esc; // ui/components/bb.js
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) { /* no storage */ } return null; }
  var short = window.BB.short;
  function ago(t) {
    var s = Math.max(0, Date.now() / 1000 - t);
    return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + ' min ago' : s < 86400 ? Math.floor(s / 3600) + ' h ago' : Math.floor(s / 86400) + ' d ago';
  }
  // a time in the viewer's own time (kept in UTC): 20.11.2026, 17:57:45
  function two(n) { return (n < 10 ? '0' : '') + n; }
  function day(t) { var d = new Date(t * 1000); return two(d.getDate()) + '.' + two(d.getMonth() + 1) + '.' + d.getFullYear() + ', ' + two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds()); }
  function link(a) { return '<a class="mono" href="/pool/' + encodeURIComponent(a) + '" title="' + esc(a) + '">' + esc(short(a)) + '</a>'; }
  // a value: the first one fades in over the honeycomb loader (ui's .bb-wait, .bb-fade), later ones just change
  function put(id, text) {
    var el = $(id), first = !!el.querySelector('.bb-wait');
    if (el.textContent !== text || first) el.textContent = text;
    if (first) { el.classList.remove('bb-fade'); void el.offsetWidth; el.classList.add('bb-fade'); }
  }
  function fadeIn(el) { el.classList.remove('bb-fade'); void el.offsetWidth; el.classList.add('bb-fade'); }

  // an invite link (/pool?ref=<address>): remembered for this browser's first piece
  var q = new URLSearchParams(location.search);
  if (q.get('ref') && T.isAddress(q.get('ref')) && !store('bb-ref')) store('bb-ref', q.get('ref'));

  var stats = null, timers = [], es = null;

  // ---------- the tiles, the title and the haystack: the pool's numbers ----------
  function showStats(s) {
    var before = stats;
    stats = s;
    // the tiles, the title and the split: render.js's, as the server writes them into the page
    var v = window.BBRender.poolTiles(s);
    Object.keys(v.text).forEach(function (id) { if (/^t-(speed|keys|pieces|players|prize|shuffle)$/.test(id)) put(id, v.text[id]); else $(id).textContent = v.text[id]; });
    Object.keys(v.html).forEach(function (id) { if ($(id).innerHTML !== v.html[id]) $(id).innerHTML = v.html[id]; });
    Array.prototype.forEach.call(document.querySelectorAll('.g-n'), function (e) { e.textContent = s.puzzle; });
    Array.prototype.forEach.call(document.querySelectorAll('.g-finder'), function (e) { e.innerHTML = esc(s.finder_btc) + '&nbsp;BTC'; });
    $('t-shuffle-s').title = s.shuffle ? 'This order came from block ' + s.shuffle.height + '; the next comes from block ' + s.shuffle.next : '';
    $('g-feed-dot').classList.toggle('on', !!s.active);
    if (!!s.found !== (st === 'found') && st !== 'run') join(); // a find came, or its claim was confirmed
    hay();
    // something happened: the feed and the top follow, at most every 10 s (with many searchers a piece is
    // finished every second, and every page would ask for both each time)
    if (before && (before.chunks_done !== s.chunks_done || before.players !== s.players)) lists();
  }
  var listsAt = 0, listsTimer = null;
  function lists() {
    if (listsTimer) return;
    listsTimer = setTimeout(function () { listsTimer = null; listsAt = Date.now(); feed(); top(); }, Math.max(0, 10000 - (Date.now() - listsAt)));
  }
  function refresh() {
    P.get('/api/pool').then(showStats).catch(function () {
      ['t-speed', 't-keys', 't-pieces', 't-players', 't-prize', 't-shuffle'].forEach(function (k) { if ($(k).querySelector('.bb-wait')) $(k).innerHTML = '&nbsp;'; });
      $('t-speed-s').textContent = 'the pool cannot be reached right now';
    });
  }

  // ---------- the pool's speed: 24 hours, 7 or 30 days (the choice kept here) ----------
  var RANGES = { '24h': 'the last 24 hours', '7d': 'the last 7 days', '30d': 'the last 30 days' };
  var range = RANGES[store('bb-pool-range')] ? store('bb-pool-range') : '24h', hist = null, chartOn = false;
  // taller than ui's charts on wide screens, as tall as the way in beside it (puzzle.css: .dash-row .chart-box)
  function chartH() { return window.matchMedia && matchMedia('(max-width: 700px)').matches ? undefined : 380; }
  function drawChart() {
    var box = $('g-chart'), h = chartH();
    if (!window.BBCharts) return;
    if (!hist) { box.innerHTML = BBCharts.frame('', { labelChars: 7, height: h }); return; }
    var pts = hist.points.concat([hist.now]);
    if (!pts.some(function (p) { return p[1] > 0; })) { box.innerHTML = BBCharts.frame('no piece finished in ' + RANGES[range], { labelChars: 7, height: h }); return; }
    if (!chartOn) { fadeIn(box); chartOn = true; }
    box.innerHTML = BBCharts.line(pts, { label: function (v) { return P.rate(v, ' ').trim(); }, peak: true, labelChars: 7, title: 'Pool speed', height: h });
  }
  function chart() {
    Array.prototype.forEach.call($('g-range').querySelectorAll('button'), function (b) { b.classList.toggle('on', b.dataset.r === range); });
    var want = range;
    P.get('/api/pool/history?range=' + range).then(function (h) { if (want !== range) return; hist = h; drawChart(); }).catch(function () { /* keep */ });
  }

  // ---------- the way in ----------
  // st: 'run' (a search runs in this tab, or a key was found here), 'back' (an address is saved here), 'new'
  var st = 'new';
  function setSt(v) { st = v; document.documentElement.setAttribute('data-pool-st', v); }
  function join() {
    var bp = window.BBPool && window.BBPool.state ? window.BBPool.state() : null, won = store('bb-win'), mine = store('bb-addr');
    if (bp && (bp.running || bp.won) || won) {
      setSt('run');
      var w = null; try { w = JSON.parse(won || 'null'); } catch (_) { w = null; }
      var a = bp ? bp.addr : w && w.payout;
      $('g-join-title').textContent = bp && bp.running ? 'Searching' : 'Your key';
      $('g-back-k').textContent = bp && bp.running ? 'Searching now' : '★ A key was found in this browser';
      $('g-back-a').textContent = a ? short(a) : 'without an address'; $('g-back-a').title = a || '';
      $('g-back-s').textContent = bp && bp.running ? (bp.pct >= 0 ? 'piece ' + (bp.pieces + 1) + ' at ' + bp.pct + '%' : 'starting') + (bp.rate ? ', ' + bp.rate : '') : 'its claim is on your page';
      $('g-open').textContent = bp && bp.running ? 'Open my search' : 'Open my find';
      $('g-open').href = (bp && bp.path) || (a ? '/pool/' + a : '/pool');
      $('g-back-note').innerHTML = bp && bp.running ? 'It keeps going while you look around the site.' : 'This browser keeps it until the prize is spent.';
      return;
    }
    // a find waits for its claim: the pool is paused, and the way in says so
    if (stats && stats.found) {
      setSt('found');
      $('g-join-title').textContent = 'Paused';
      $('g-found-s').textContent = 'since ' + day(stats.found.since).slice(0, 17);
      return;
    }
    if (mine && T.isAddress(mine) && st !== 'edit') {
      setSt('back');
      $('g-join-title').textContent = 'Your page';
      $('g-back-k').textContent = 'Welcome back';
      $('g-back-a').textContent = short(mine); $('g-back-a').title = mine;
      $('g-open').textContent = 'Open my page'; $('g-open').href = '/pool/' + mine;
      $('g-back-note').innerHTML = 'Not you? <a href="#" id="g-other">Use another address</a>';
      $('g-other').addEventListener('click', function (e) { e.preventDefault(); st = 'edit'; setSt('new'); $('g-join-title').textContent = 'Join'; $('g-addr').value = ''; onAddr(); $('g-addr').focus(); });
      P.get('/api/pool/me?addr=' + encodeURIComponent(mine)).then(function (m) {
        if (store('bb-addr') !== mine) return;
        $('g-back-s').textContent = m.rank ? 'rank #' + m.rank + ', ' + P.sci(m.keys) + ' keys' : 'no piece finished yet';
        fadeIn($('g-back-s'));
      }).catch(function () { /* keep */ });
      return;
    }
    setSt('new');
    $('g-join-title').textContent = 'Join';
  }
  // the address typed: checked as it is typed, and an address nobody ever used gets a word of caution
  var checkTimer = null;
  function onAddr() {
    var a = $('g-addr').value.trim(), note = $('g-addr-note');
    $('g-addr-warn').hidden = true;
    if (!a) { note.textContent = 'Needed to search: your share of a prize goes to it.'; return; }
    if (!T.isAddress(a)) { note.textContent = '✗ not a Bitcoin mainnet address: check it, letter by letter'; return; }
    var kind = { p2pkh: 'legacy (1…)', p2sh: 'script (3…)', p2wpkh: 'SegWit (bc1q…)', p2wsh: 'SegWit script (bc1q…)', p2tr: 'Taproot (bc1p…)' }[T.addressScript(a).type];
    note.textContent = '✓ a valid ' + kind + ' Bitcoin address';
    clearTimeout(checkTimer);
    checkTimer = setTimeout(function () {
      P.get('/api/address/' + encodeURIComponent(a)).then(function (r) {
        if ($('g-addr').value.trim() !== a || r.tx_count > 0 || store('bb-warned-' + a)) return;
        var w = $('g-addr-warn');
        w.innerHTML = '<button class="note-x" type="button" aria-label="Close">×</button>This address has never been used on the Bitcoin blockchain. That is normal for a fresh address from your wallet, but please make sure it is yours and copied in full: a prize sent to a wrong address is gone for good.';
        w.querySelector('.note-x').addEventListener('click', function () { store('bb-warned-' + a, '1'); w.hidden = true; });
        w.hidden = false;
      }).catch(function () { /* no warning without data */ });
    }, 600);
  }
  // Start: the address is saved here and the searcher's own page opens with the search running. No address, no
  // search: it goes into the claim the moment a browser finds the key
  function start() {
    var a = $('g-addr').value.trim();
    if (!a) { $('g-addr-note').textContent = '✗ enter your Bitcoin address first: your share of a prize goes to it'; $('g-addr').focus(); return; }
    if (!T.isAddress(a)) { onAddr(); $('g-addr').focus(); return; }
    if (window.BBPuzzles && T.addressScript(a).type === 'p2pkh' && BBPuzzles.which(BBP.S.addressToHash160(a))) { $('g-addr-note').textContent = '✗ that is a puzzle address, not yours'; $('g-addr').focus(); return; }
    store('bb-addr', a);
    var path = '/pool/' + a;
    try { sessionStorage.setItem('bb-start', path); } catch (_) { /* no storage: Start there by hand */ }
    if (window.BBNav) window.BBNav.go(path); else location.href = path;
  }

  // ---------- what happened lately ----------
  var seen = null;
  function feed() {
    P.get('/api/pool/recent').then(function (r) {
      var first = !seen, now = {};
      $('g-feed').innerHTML = r.events.length ? r.events.map(function (e) {
        var key = e.t + e.kind + (e.addr || ''), fresh = !first && !seen[key];
        now[key] = 1;
        var who = e.addr && e.kind !== 'failed' ? link(e.addr) : '<span class="dim">' + (e.kind === 'failed' ? 'a searcher' : 'anonymous') + '</span>';
        var what = e.kind === 'piece' ? 'finished a piece' : e.kind === 'failed' ? 'missed check keys: the piece goes back' : 'joined the search' + (e.ref ? ', invited by ' + esc(e.ref) : '');
        return '<tr class="' + e.kind + (fresh ? ' new' : '') + '"><td class="dim" title="' + day(e.t) + '">' + ago(e.t) + '</td><td>' + who + '</td><td>' + what + '</td><td class="num">' + (e.kind === 'piece' ? P.sci(e.keys) : '') + '</td><td class="num dim">' + (e.kind === 'piece' && e.rate ? P.rate(e.rate) : '') + '</td></tr>';
      }).join('') : '<tr><td colspan="5" class="dim">Nothing yet: the first finished piece shows here.</td></tr>';
      if (first) fadeIn($('g-feed'));
      seen = now;
    }).catch(function () { /* keep */ });
  }

  // ---------- the top: sorted by a column's head (ui's th.sortable), by rank at first ----------
  var topRows = null, topSort = { key: 'rank', dir: 1 };
  function top() {
    P.get('/api/pool/top').then(function (t) {
      var first = !topRows;
      topRows = t.players.map(function (p, i) { return Object.assign({ rank: i + 1 }, p); }); // the server's order is by keys
      drawTop(); hive();
      if (first) { fadeIn($('top')); fadeIn($('g-hive')); }
    }).catch(function () { /* keep */ });
  }
  function drawTop() {
    if (!topRows) return;
    var k = topSort.key, d = topSort.dir, mine = store('bb-addr');
    var rows = topRows.slice().sort(function (a, b) { return (a[k] - b[k]) * d || a.rank - b.rank; });
    $('top').innerHTML = rows.length ? rows.map(function (p) {
      return '<tr' + (p.addr === mine ? ' class="ours"' : '') + '><td class="num name">' + p.rank + '</td><td>' + link(p.addr) + '</td><td class="num">' + P.sci(p.keys) + '</td><td class="num">' + P.int(p.chunks) + '</td><td class="num">' + p.refs + '</td><td class="dim" title="' + day(p.last) + '">' + ago(p.last) + '</td></tr>';
    }).join('') : '<tr><td colspan="6" class="dim">Nobody yet: be the first.</td></tr>';
    Array.prototype.forEach.call(document.querySelectorAll('#top-head th[data-sort]'), function (th) {
      th.dataset.dir = th.dataset.sort === k ? (d > 0 ? '▲' : '▼') : '';
      th.setAttribute('aria-sort', th.dataset.sort === k ? (d > 0 ? 'ascending' : 'descending') : 'none');
    });
  }

  // ---------- the hive: every searcher a cell, the brighter the more keys; the empty one is yours ----------
  function hive() {
    var box = $('g-hive');
    if (!topRows) return;
    var mine = store('bb-addr'), inTop = topRows.some(function (p) { return p.addr === mine; }), max = topRows.length ? topRows[0].keys : 1;
    var html = inTop ? '' : '<a class="c plus" href="#g-join" title="' + (mine ? 'You: your first finished piece puts you here' : 'You: enter your address and press Start') + '"><span>+</span></a>';
    html += topRows.map(function (p) {
      var o = (0.2 + 0.8 * Math.pow(p.keys / max, 0.4)).toFixed(2);
      return '<a class="c' + (p.addr === mine ? ' mine' : '') + '" style="--o:' + o + '" href="/pool/' + encodeURIComponent(p.addr) + '" title="#' + p.rank + ' ' + esc(short(p.addr)) + ': ' + esc(P.sci(p.keys)) + ' keys, ' + p.chunks + ' pieces, last seen ' + ago(p.last) + '"><span>#' + p.rank + '<br>' + esc(p.addr.slice(0, 6)) + '</span></a>';
    }).join('');
    box.innerHTML = html;
    layHive();
  }
  // a flat-topped honeycomb: columns overlap by a quarter, every other one half a cell lower
  function layHive() {
    var box = $('g-hive'), cells = box.children, W = 74, H = 64, G = 3;
    if (!cells.length) return;
    var cols = Math.max(2, Math.floor((box.clientWidth - W) / (W * 0.75 + G)) + 1), rows = 0;
    for (var i = 0; i < cells.length; i++) {
      var c = i % cols, r = Math.floor(i / cols);
      cells[i].style.left = c * (W * 0.75 + G) + 'px';
      cells[i].style.top = r * (H + G) + (c % 2 ? (H + G) / 2 : 0) + 'px';
      rows = r + 1;
    }
    box.style.height = rows * (H + G) + (cells.length > 1 ? H / 2 : 0) + 'px';
  }

  // ---------- the haystack: the range as one line, a speck for each piece searched ----------
  // The specks are not where the pieces are (their order is the pool's secret): they are placed by a fixed
  // sequence, so a new one never moves the others. Drawn far wider than a piece is, and the note says by how much.
  var MAX_SPECKS = 800;
  function hay() {
    var s = stats, box = $('g-hay');
    if (!s || !s.chunks_total) return;
    var n = Math.min(s.chunks_done, MAX_SPECKS), have = box.children.length, html = '';
    if (have > n) { box.innerHTML = ''; have = 0; }
    for (var i = have; i < n; i++) html += '<i style="left:' + (((i + 1) * 0.6180339887498949 + 0.11) % 1 * 100).toFixed(3) + '%"></i>';
    if (html) box.insertAdjacentHTML('beforeend', html);
    $('g-hay-lo').textContent = '2' + P.sup(s.puzzle - 1);
    $('g-hay-hi').textContent = '2' + P.sup(s.puzzle);
    $('g-hay-mid').textContent = 'puzzle #' + s.puzzle + ': ' + P.sci(Math.pow(2, s.puzzle - 1)) + ' keys';
    $('g-hay-m').textContent = s.share_done ? '1 in ' + P.sci(1 / s.share_done) + ' searched' : 'nothing searched yet';
    var w = box.clientWidth || 1000, wider = '10' + P.sup(Math.round(Math.log10(2 * s.chunks_total / w)));
    $('g-hay-note').textContent = s.chunks_done
      ? 'Each speck is a piece the pool has searched: ' + P.int(s.chunks_done) + ' of ' + P.sci(s.chunks_total) + (s.chunks_done > MAX_SPECKS ? ' (the first ' + MAX_SPECKS + ' drawn)' : '') + '. They are not drawn where they are, as the order is a secret, and each is drawn about ' + wider + ' times wider than it is: to scale, all of them together would be 1 in ' + P.sci(1 / s.share_done) + ' of this line.'
      : 'Each piece the pool searches will show here as a speck. Even drawn as a speck, a piece is billions of times wider here than it is.';
  }

  // ---------- attach ----------
  $('g-range').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-r]'); if (!b || b.dataset.r === range) return;
    range = b.dataset.r; store('bb-pool-range', range); chart();
  });
  // the heads sort by mouse and by keyboard (Enter or Space on a focused head), as on the home page
  $('top-head').addEventListener('keydown', function (e) { if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('th[data-sort]')) { e.preventDefault(); e.target.click(); } });
  $('top-head').addEventListener('click', function (e) {
    var th = e.target.closest('th[data-sort]'); if (!th) return;
    var k = th.dataset.sort;
    // the same head again turns it round; a new one starts from its best end (rank 1, the most keys, the latest)
    topSort = topSort.key === k ? { key: k, dir: -topSort.dir } : { key: k, dir: k === 'rank' ? 1 : -1 };
    drawTop();
  });
  $('g-addr').addEventListener('input', onAddr);
  $('g-addr').addEventListener('keydown', function (e) { if (e.key === 'Enter') start(); });
  $('g-start').addEventListener('click', start);
  // the hive's empty cell: to the field
  $('g-hive').addEventListener('click', function (e) {
    if (!e.target.closest('.plus')) return;
    e.preventDefault();
    if (st === 'back') { $('g-open').focus(); return; }
    $('g-join').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('g-addr').focus({ preventScroll: true });
  });
  function resize() { drawChart(); layHive(); hay(); }
  addEventListener('resize', resize);

  drawChart(); join(); refresh(); chart(); feed(); top();
  // live: the server pushes the pool's numbers the moment anything changes; the top, the feed's times and the
  // chart catch up on their own. All of it ends when another page is shown
  var polling = false;
  function poll() { if (!polling) { polling = true; timers.push(setInterval(refresh, 20000)); } }
  if (window.EventSource) {
    es = new EventSource('/api/pool/live');
    es.onmessage = function (m) { try { showStats(JSON.parse(m.data)); } catch (_) { /* a bad line */ } };
    // turned away (the server has too many live pages) or gone for good: the numbers are asked for every 20 s
    es.onerror = function () { if (es.readyState === 2) poll(); };
  } else poll();
  timers.push(setInterval(function () { feed(); top(); }, 60000));
  timers.push(setInterval(chart, 300000));
  // while a search runs in this tab, its card follows it
  timers.push(setInterval(function () { if (st === 'run') join(); }, 1000));
  window.addEventListener('bb:leave', function () {
    timers.forEach(clearInterval); if (es) es.close(); removeEventListener('resize', resize); clearTimeout(checkTimer); clearTimeout(listsTimer);
  }, { once: true });
})();
