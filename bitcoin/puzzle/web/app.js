/* puzzle.bumblebeam.org: the 160 puzzles, the target with its key and the pool's speedometer, and the radar, from /api (bitcoin/puzzle/api).
   English only. */
(function () {
  'use strict';

  // the strings and the markup of the live numbers: render.js, shared with the server (api/pages.js)
  var R = window.BBRender;

  // ---------- formatting ----------
  function $(id) { return document.getElementById(id); }
  // a value that was waiting on the honeycomb loader (ui's .bb-wait) fades in the first time (ui's .bb-fade)
  function put(id, text) {
    var el = $(id); if (!el) return;
    var first = !!el.querySelector('.bb-wait');
    if (el.textContent !== String(text) || first) el.textContent = text;
    if (first) { el.classList.remove('bb-fade'); void el.offsetWidth; el.classList.add('bb-fade'); }
  }
  var esc = window.BB.esc; // ui/components/bb.js
  var fmtBtc = R.fmtBtc, fmtInt = R.fmtInt, sup = R.sup, date = R.date, words = R.words, RTX4090 = R.RTX4090;

  // ---------- render ----------
  var data = null, events = [], knockList = [], pool = null, filter = 'open', seenKnocks = null;
  document.querySelectorAll('#filter button').forEach(function (b) {
    b.addEventListener('click', function () {
      filter = b.getAttribute('data-f');
      document.querySelectorAll('#filter button').forEach(function (x) { x.classList.toggle('on', x === b); });
      // every row is in the table: its data-f hides the others (puzzle.css)
      $('rows').parentNode.setAttribute('data-f', filter);
    });
  });

  // the numbers that wait on a loader fade in the first time (put); the rest are set as they are
  var PUT = { 't-open': 1, 't-count': 1, 't-target': 1, 't-last': 1, 'pl-active': 1, 'pl-keys': 1 };
  function apply(v) {
    Object.keys(v.text).forEach(function (id) { if (PUT[id]) put(id, v.text[id]); else if ($(id)) $(id).textContent = v.text[id]; });
    Object.keys(v.html).forEach(function (id) {
      var el = $(id);
      if (el && el.innerHTML !== v.html[id]) el.innerHTML = v.html[id];
    });
  }
  function render() {
    var d = data, ps = d.puzzles;
    var open = ps.filter(function (p) { return p.status === 'open'; });
    try { localStorage.setItem('bb-open-rows', String(open.length)); } catch (_) { /* no storage */ }
    var v = R.home(d, events, knockList, null, { sort: tsort, seen: seenKnocks });
    apply(v);
    seenKnocks = R.radarIds(knockList, events);
    var t = d.target && ps[d.target - 1];
    if (t) keyView(t.n);
    poolLine(pool);
    radarArgs = true;
    fadeEnd($('knock-scroll')); fadeEnd($('solves-scroll'));
    sizeRadar();
  }


  // ---------- the key square (keysq.js) and the lucky visitor's key ----------
  var ks = null, keyN = 0, keyDigits = [], keyTimer = null, keyStep = null, luckyHit = false;
  // a lucky key found here before and kept by prize.js: { n, key } (the key in 64 hex digits once the prize is safe,
  // null before). On a reload the tile comes back found at once: the winner's title, the lit square, the key hidden
  // until the prize is safe and then shown, no draws
  var won = null;
  try {
    var lw = JSON.parse(localStorage.getItem('bb-lucky-win') || 'null');
    if (lw && /^0x[0-9a-f]{1,64}$/.test(lw.key) && lw.puzzle && !(lw.revealed && Date.now() - lw.revealed > 7 * 864e5))
      won = { n: lw.puzzle, key: lw.revealed ? BigInt(lw.key).toString(16).padStart(64, '0') : null };
  } catch (_) { won = null; }
  // the claim's scripts, loaded the first time a draw hits (or a hit kept from before is found): the home page
  // carries none of them otherwise
  var CLAIM_JS = ['/engine/tx.js', '/engine/puzzles.js', '/engine/claimkit.js', '/findview.js', '/claim.js', '/prize.js', '/sharecard.js'], luckyP = null;
  function lucky() {
    if (luckyP) return luckyP;
    var v = (document.querySelector('script[src*="/app.js"]').getAttribute('src').match(/\?v=[^&]*/) || [''])[0];
    luckyP = CLAIM_JS.reduce(function (chain, src) {
      return chain.then(function () {
        if (document.querySelector('script[src^="' + src + '"]')) return;
        return new Promise(function (ok, no) { var s = document.createElement('script'); s.src = src + v; s.onload = ok; s.onerror = no; document.body.appendChild(s); });
      });
    }, Promise.resolve()).then(function () {
      // the prize is safe: the tile shows the key it hid
      return window.BBPrize({ box: $('lucky-claim'), keep: 'bb-lucky-win', source: 'lucky', onReveal: function (k) {
        if (!won) return;
        won.key = k.toString(16).padStart(64, '0');
        if (won.n === keyN && keyStep) keyStep();
      } });
    });
    return luckyP;
  }
  // the local preview's demo hit (/?demo=found): what a hit looks like, with nothing sent
  function luckyDemo(n) {
    var box = $('lucky-claim'); if (!box) return;
    box.hidden = false;
    box.innerHTML = '<div class="panel-head"><h2 class="panel-title"><span class="star">★</span> You found the key to <span class="o">puzzle #' + n + '</span></h2></div>' +
      '<div class="tile key-info found-hidden"><span class="key-info-badge" aria-hidden="true">i</span>A preview of a hit on a local copy: the key drawn is not the key of the puzzle, so nothing is sent. A real hit sends the prize to your saved payout address through MARA Slipstream, or keeps the key on our server and asks you to write to support. The key shows once the prize is safe.</div>';
  }
  // the lucky key's tip: what it is and what a hit would do, for the current target
  function luckyTip(n) {
    return 'Every 1.6 seconds your browser draws a random key from the range of puzzle #' + n + ', the same one the square shows, and checks right here whether it opens the address of the puzzle. The odds are about 1 in ' + words(Math.pow(2, n - 1)) + ', so it is just for fun. If a key ever fits, the draw stops on it, the prize appears next to it, and the page sends it to the payout address saved in your browser through a private relay (without one, the key is kept on our server and you write to support). The key itself shows only once the prize is safe: whoever sees it before could take the coins.';
  }
  // the tile of a hit: the winner's title (no tip any more, the puzzle's number links to its page), the lit square,
  // the copy button only once the key is shown
  function foundTile(tk, tp) {
    tk.classList.add('found'); ks.setFound(true);
    var cpb = tk.querySelector('.cp'); if (cpb) cpb.hidden = !(won && won.key);
    var tt = $('target-try-title');
    if (tt && tt.classList.contains('tipped')) {
      tt.classList.remove('tipped'); tt.removeAttribute('title'); tt.removeAttribute('data-tip');
      tt.innerHTML = 'You really are the lucky one! This key opens <a href="/puzzle/' + keyN + '" title="' + esc(tp.address) + '">#' + keyN + '</a>';
    }
  }
  function keyView(n) {
    if (n === keyN) return;
    keyN = n; luckyHit = !!(won && won.n === n);
    // a new target (the last one solved): a find shown for the old one is over, the lucky key starts afresh
    var tk0 = $('target-try'), tt0 = $('target-try-title');
    if (tk0) { tk0.classList.remove('found'); tk0.removeAttribute('data-n'); }
    if (tt0) {
      tt0.textContent = 'Your lucky key'; tt0.classList.add('tipped');
      tt0.removeAttribute('title'); tt0.setAttribute('data-tip', luckyTip(n));
      var fw0 = tt0.parentNode.querySelector('.fw'); if (fw0) fw0.remove();
    }
    if (!ks) ks = BBKeySquare($('key-sq'), $('key-count').parentNode);
    keyDigits = ks.setN(n);
    var known = 64 - keyDigits.length, open = keyDigits.length;
    $('key-count').innerHTML = known + ' known | <b>' + open + ' to find</b>';
    var still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    // each try draws every open digit from the browser's real random source, and writes the key under the text
    var rnd = new Uint32Array(keyDigits.length), HEX = '0123456789abcdef', demoTries = 0;
    var CP_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
    var OK_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    function step() {
      (window.crypto || window.msCrypto).getRandomValues(rnd);
      var vals = keyDigits.map(function (d, i) { return d.vals[rnd[i] % d.vals.length]; });
      keyDigits.forEach(function (d, i) { d.prev = d.cur; d.cur = vals[i]; });
      // the whole key under the text: 0x and 64 cells in groups of eight, the known zeros dim, the open digits lit.
      // A new try runs each open digit as random hex that settles left to right (BB.decode from ui/, the wallet's
      // address change), one cell after the other
      var tk = $('target-try');
      if (tk) {
        if (tk.getAttribute('data-n') !== String(keyN)) {
          var h = '<span class="kx">0x</span>';
          for (var c = 0; c < 64; c++) h += (c % 8 === 0 ? (c ? '</span>' : '') + '<span class="kg">' : '') + '<i' + (c < 64 - keyDigits.length ? ' class="z">0' : ' class="o">') + '</i>';
          // the copy button of ui/ (.cp): two sheets, a tick for 2 s once copied
          tk.innerHTML = h + '</span><button type="button" class="cp" title="Copy the key" aria-label="Copy the key">' + CP_ICON + '</button><span class="bal tipped" title="What the address of this key holds. Every key in the range opens its own address, and all of them are empty except one: the address of the puzzle, with its prize. The check is done in your browser against the address of the puzzle."></span>';
          tk.querySelector('.cp').onclick = function () {
            var b = this, key = '0x' + Array.prototype.map.call(tk.querySelectorAll('i.z, i.o'), function (i) { return i.textContent; }).join('');
            if (!navigator.clipboard) return;
            navigator.clipboard.writeText(key).then(function () {
              b.innerHTML = OK_ICON; b.classList.add('done');
              clearTimeout(b._t); b._t = setTimeout(function () { b.innerHTML = CP_ICON; b.classList.remove('done'); }, 2000);
            }).catch(function () {});
          };
          tk.setAttribute('data-n', String(keyN));
        }
        // the balance: an address of this range holds coins only if it is the puzzle's own, so the key's address is
        // worked out here and compared with it (no lookups: a try every 1.6 s would be a lot of requests)
        var bal = tk.querySelector('.bal'), tp = data && data.puzzles[keyN - 1];
        if (bal && tp && (luckyHit || window.BBSecp)) {
          var kh = keyDigits.map(function (d) { return HEX[d.cur]; }).join(''), fresh = false;
          var hit = luckyHit || window.BBSecp.hash160ToAddress(window.BBSecp.hash160OfKey(BigInt('0x' + kh))) === tp.address;
          // a preview of a find, on a local copy only: /?demo=found makes the third try a hit
          if (!luckyHit && /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && /[?&]demo=found\b/.test(location.search) && ++demoTries >= 3) hit = true;
          bal.textContent = hit ? fmtBtc(tp.balance) + ' BTC' : '0 BTC';
          bal.classList.toggle('hit', hit);
          if (hit && !luckyHit) { fresh = true; luckyHit = true; won = demoTries ? null : { n: keyN, key: null }; }
          // the one key: the draw stops, and the key is hidden at once (its digits, the square, the copy button):
          // an open prize's key is shown only once the prize is safe (prize.js), as on /play. A hit kept from
          // before (a reload) comes back the same, with the key once it is safe
          if (hit) {
            if (keyTimer) { clearInterval(keyTimer); keyTimer = null; }
            foundTile(tk, tp);
          }
          if (fresh) {
            var tt = $('target-try-title');
            // confetti with bees from the end of the winner's title
            if (tt && !still && !tt.parentNode.querySelector('.fw')) BB.confetti(tt);
            // the prize: all of it the visitor's, sent to the payout address saved in this browser through
            // Slipstream, or kept on our server ("write to support"); the claim panel under the card (prize.js).
            // The local preview's demo hit is no key of the puzzle: nothing is sent, the panel says so
            var payout = null; try { payout = localStorage.getItem('bb-addr'); } catch (_) { /* no storage */ }
            if (demoTries) luckyDemo(keyN);
            else lucky().then(function (p) { p.found({ key: '0x' + BigInt('0x' + kh).toString(16), puzzle: keyN, address: tp.address, payout: payout }); });
          }
        }
        var cells = tk.querySelectorAll('i.o'), n = keyDigits.length, shown = luckyHit && won && won.key ? won.key.slice(64 - n) : null;
        keyDigits.forEach(function (d, i) {
          var el = cells[i], ch = luckyHit ? (shown ? shown[i] : '•') : HEX[d.cur];
          if (window.BB && BB.decode && !still && !luckyHit) BB.decode(el, ch, 140 + Math.round(i * 420 / n));
          else el.textContent = ch;
        });
      }
      keyDigits.forEach(function (d, i) { d.cur = d.prev; }); // ks.show moves cur to prev itself
      // the square shows a hit as a lit square with no key in it (random digits), and the key once it is safe
      var safe = luckyHit && won && won.key ? won.key.slice(64 - keyDigits.length) : null;
      if (safe) vals = keyDigits.map(function (d, i) { return parseInt(safe[i], 16); });
      else if (luckyHit) { (window.crypto || window.msCrypto).getRandomValues(rnd); vals = keyDigits.map(function (d, i) { return d.vals[rnd[i] % d.vals.length]; }); }
      ks.show(vals, !still);
    }
    keyStep = step;
    step();
    if (keyTimer) clearInterval(keyTimer);
    if (!still && !luckyHit) keyTimer = setInterval(function () { if (!document.hidden) step(); }, 1600);
  }

  // both tables sort by When or #: newest first to start with; a click on the same head flips it, on the other
  // starts it at its own first order (newest first, or #1 first)
  var tsort = { knocks: { k: 'when', dir: -1 }, solves: { k: 'when', dir: -1 } }, radarArgs = null;
  function sortHeads() {
    document.querySelectorAll('th.sortable[data-t]').forEach(function (th) {
      var st = tsort[th.dataset.t], on = st.k === th.dataset.sort;
      th.dataset.dir = on ? (st.dir > 0 ? '▲' : '▼') : '';
      th.setAttribute('aria-sort', on ? (st.dir > 0 ? 'ascending' : 'descending') : 'none');
    });
  }
  function sortBy(th) {
    var st = tsort[th.dataset.t], k = th.dataset.sort;
    if (st.k === k) st.dir = -st.dir; else { st.k = k; st.dir = k === 'when' ? -1 : 1; }
    sortHeads();
    if (radarArgs && data) render();
  }
  document.querySelectorAll('th.sortable[data-t]').forEach(function (th) {
    th.addEventListener('click', function () { sortBy(th); });
    th.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sortBy(th); } });
  });
  sortHeads();
  // ---------- data ----------
  function get(path) {
    return fetch(path, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
  }
  // the pool in the card: a speedometer of its speed, who searches now, how far it got
  var gauge = null;
  function poolLine(p) {
    if (!p || !$('pl-gauge') || !window.BB || !BB.gauge) return;
    if (!gauge) gauge = BB.gauge($('pl-gauge'), {
      // up to 100T: room for ten thousand browsers with fast cards; the mark is one RTX 4090
      min: 1e6, max: 1e14, log: true,
      ticks: [[1e6, '1M'], [1e7, '10M'], [1e8, '100M'], [1e9, '1G'], [1e10, '10G'], [1e11, '100G'], [1e12, '1T'], [1e13, '10T'], [1e14, '100T']],
      marks: [[RTX4090, 'one RTX 4090']]
    });
    var on = p.speed && p.active;
    var r = on ? R.rate(p.speed).split(' ') : null;
    gauge.set(on ? p.speed : 0, on ? r[0] + ' ' + r[1].replace('keys/s', '') : '0', 'keys per second');
    apply({ text: R.poolFacts(p), html: {} });
  }
  // ---------- the knocks: all of them with every load (a few hundred at most) ----------
  // with the target card in three columns, the radar card is as tall as it: its two boxes take what is left
  function sizeRadar() {
    var t = $('target'), r = $('radar'), boxes = [$('knock-scroll'), $('solves-scroll')];
    boxes.forEach(function (b) { b.style.height = ''; });
    if (!t || !r || window.innerWidth <= 1180) return;
    var h = t.offsetHeight - (r.offsetHeight - boxes[0].offsetHeight);
    if (h >= 160) boxes.forEach(function (b) { b.style.height = h + 'px'; fadeEnd(b); });
  }
  window.addEventListener('resize', sizeRadar);
  // the last rows fade out until the box is scrolled to its end
  function fadeEnd(box) { if (box) box.classList.toggle('fade', box.scrollTop + box.clientHeight < box.scrollHeight - 2); }
  $('knock-scroll').addEventListener('scroll', function () { fadeEnd(this); });
  $('solves-scroll').addEventListener('scroll', function () { fadeEnd(this); });

  var demoDone = false;
  function demoNext() {
    if (demoDone) { solveDemo(); return; }
    demoDone = true;
    setTimeout(function () { demoDone = 'solved'; solveDemo(); render(); }, 8000);
  }
  // the target as if solved now by brute force, the next open puzzle the new target
  function solveDemo() {
    if (demoDone !== 'solved' || !data) return;
    var t = data.puzzles[data.target - 1];
    if (!t || t.status === 'solved') return;
    var now = Math.floor(Date.now() / 1000);
    t.solved = { time: now, amount: t.balance, txid: 'demo000000000000000000000000000000000000000000000000000000000000'.slice(0, 64), height: data.tip };
    t.status = 'solved'; t.peak = t.balance; t.balance = 0;
    var next = data.puzzles.filter(function (p) { return p.status === 'open' && !p.exposed; })[0];
    data.target = next ? next.n : data.target;
    data.open--; data.solved++; data.open_btc = Math.round((data.open_btc - t.peak) * 1e8) / 1e8;
  }
  function load() {
    Promise.all([get('/api/puzzles'), get('/api/events').catch(function () { return { events: [] }; }), get('/api/pool').catch(function () { return null; }), get('/api/knocks').catch(function () { return { knocks: [] }; })]).then(function (r) {
      data = r[0]; events = r[1].events || []; pool = r[2]; knockList = r[3].knocks || [];
      // a preview on a local copy only: /?demo=next plays the target being solved 8 s after the first load
      if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && /[?&]demo=next\b/.test(location.search)) demoNext();
      document.body.classList.remove('loading-failed');
      render();
    }).catch(function () {
      document.body.classList.add('loading-failed');
      if (window.BBNoData) window.BBNoData();
    });
  }

  // the radar's boxes take their height (the target card's, on a wide screen) before the first paint: the card's
  // size is reserved before its numbers come, so nothing under the radar moves when they do
  sizeRadar();
  // a lucky key found here before, its prize not safe yet: on its way again (prize.js)
  // (a find prize.js does not take back: the tile draws again)
  try {
    if (localStorage.getItem('bb-lucky-win')) lucky().then(function (p) {
      if (p.resume() || !won) return;
      won = null;
      if (keyN) { var n = keyN; keyN = 0; keyView(n); }
    }).catch(function () { /* next visit */ });
  } catch (_) { /* no storage */ }
  load();
  var loadTimer = setInterval(load, 60000);
  // the speedometer live: the server pushes the pool's numbers the moment any browser starts, stops or reports
  // its speed (EventSource reconnects by itself); without it, the page's minute load still updates them
  if (window.EventSource) {
    var es = new EventSource('/api/pool/live');
    es.onmessage = function (m) { try { pool = JSON.parse(m.data); poolLine(pool); } catch (_) { /* a bad line */ } };
  }
  // another page shown in place of this one (nav.js): end the timer and the stream
  window.addEventListener('bb:leave', function () { clearInterval(loadTimer); if (keyTimer) clearInterval(keyTimer); if (ks) ks.destroy(); window.removeEventListener('resize', sizeRadar); if (es) es.close(); }, { once: true });
})();
