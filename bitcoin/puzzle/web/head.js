/* The BTC price under the logo and the status pill in the footer, on every page, as on the pool: the
   chip says "loading…" and the pill "connecting…" until the first answer, then they fill in (the price
   "—" when there is none). Loaded right after the header, so the requests start at once.
   /api/health: when the server last read the 160 puzzle addresses from a Bitcoin node (every minute) and
   the chain's height; /api/price: the BTC/USD price the node's price feed reports. */
(function () {
  'use strict';
  var st = {};
  function $(id) { return document.getElementById(id); }
  function ago(s) { return s < 90 ? s + ' s ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago'; }

  function showPrice() {
    var v = $('btc-price-v');
    if (v && st.priced) v.textContent = st.usd ? '$' + Math.round(st.usd).toLocaleString('en-US') : 'not known';
  }
  function showStatus() {
    var el = $('foot-status'), t = $('foot-status-text');
    if (!el || !t) return;
    if (st.down || !st.poll) {
      el.className = 'pill-status off';
      t.textContent = st.down ? 'offline' : 'connecting…';
      el.setAttribute('data-tip', 'Our server cannot be reached right now.');
      return;
    }
    var age = Math.max(0, Math.floor(Date.now() / 1000 - st.poll)), stale = age > 300;
    el.className = 'pill-status' + (stale ? ' demo' : '');
    t.textContent = (stale ? 'stale' : 'live') + (st.tip ? ' → ' + Number(st.tip).toLocaleString('en-US') : '');
    // data-tip, not title: our tooltip (tips.js) reads it, the browser's own never shows
    el.setAttribute('data-tip', 'How fresh the numbers are. Once a minute our server reads every puzzle address from a Bitcoin node. The last read was ' + ago(age) + '. Green means up to date, yellow means more than five minutes old, grey means the server cannot be reached. The number is the Bitcoin block height.');
  }
  function load() {
    fetch('/api/health', { cache: 'no-cache' }).then(function (r) { return r.json(); }).then(function (h) {
      st.down = !h.last_poll; if (h.last_poll) st.poll = h.last_poll; if (h.tip) st.tip = h.tip; showStatus();
    }).catch(function () { st.down = true; showStatus(); });
    fetch('/api/price', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (p) {
      if (p && p.usd) st.usd = p.usd;
      st.priced = true; showPrice();
    }).catch(function () { st.priced = true; showPrice(); });
  }
  // the header's search: a payout address opens its page (/pool/<address>), as on the pool
  var form = $('search'), input = $('search-input');
  var ADDR = /^(bc1[02-9ac-hj-np-z]{11,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/i;
  if (form && input) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = input.value.trim();
      if (!v) return;
      if (!ADDR.test(v)) { form.classList.add('bad'); input.setAttribute('aria-invalid', 'true'); return; }
      // nav.js keeps a running search alive on the way there
      if (window.BBNav) window.BBNav.go('/pool/' + encodeURIComponent(v)); else location.href = '/pool/' + encodeURIComponent(v);
    });
    input.addEventListener('input', function () { form.classList.remove('bad'); input.removeAttribute('aria-invalid'); });
    // "/" and Esc: ui/components/keys.js
  }
  // the pool's pages, set before they are drawn so no part shows and then goes: html[data-pool] is "all" on /pool,
  // and on /pool/<address> "own" when it is the address
  // this browser searches under (saved, or the running search's) or "other" for someone else's. nav.js and pool.js
  // call it again after a move or a change
  function poolMode() {
    var p = location.pathname, m = p.match(/^\/pool\/([A-Za-z0-9]{25,90})$/), saved = null, run = null;
    try { saved = localStorage.getItem('bb-addr'); } catch (_) { /* no storage */ }
    if (window.BBPool && window.BBPool.running()) run = window.BBPool.runAddr();
    var mode = p === '/pool' ? 'all' : m ? (m[1] === saved || m[1] === run ? 'own' : 'other') : null;
    if (mode) document.documentElement.setAttribute('data-pool', mode); else document.documentElement.removeAttribute('data-pool');
    // the menu: Pool on the pool's pages, but on your own page My stats instead (never both)
    var pl = document.querySelector('.top .main-nav a[href="/pool"]'), my = document.getElementById('nav-my');
    if (mode) {
      var own = mode === 'own' && my && !my.hidden && my.getAttribute('href') === p;
      if (pl) pl.classList.toggle('active', !own);
      if (my) my.classList.toggle('active', !!own);
    }
    // /pool's way in (pooldash.js): searching now (or a key found here), back with a saved address, or new
    var won = null;
    try { won = localStorage.getItem('bb-win'); } catch (_) { /* no storage */ }
    if (mode === 'all') document.documentElement.setAttribute('data-pool-st', run || won || (window.BBPool && window.BBPool.running()) ? 'run' : saved && ADDR.test(saved) ? 'back' : 'new');
    return mode;
  }
  window.BBPoolMode = poolMode;
  poolMode();
  // the home table's room before its rows come: as many open puzzles as this browser saw last (puzzle.css)
  try { var rows = Number(localStorage.getItem('bb-open-rows')); if (rows > 0 && rows <= 160) document.documentElement.style.setProperty('--open-rows', String(rows)); } catch (_) { /* no storage */ }

  // the API did not answer: every honeycomb loader still turning in `root` (the page's main by default) becomes a
  // dash with a note on hover, so nothing waits for ever; the next answer writes over it
  window.BBNoData = function (root, why) {
    Array.prototype.forEach.call((root || document.querySelector('main') || document).querySelectorAll('.bb-wait'), function (w) {
      var el = w.parentNode;
      el.textContent = '\u2014';
      el.title = why || 'Not available right now: the server of the site is not answering';
    });
  };

  // "My stats": the address this browser searches under (saved on the pool page), as on the pool
  var my = $('nav-my'), mine = null;
  try { mine = localStorage.getItem('bb-addr'); } catch (_) { /* no storage */ }
  if (my && mine && ADDR.test(mine)) {
    my.hidden = false;
    my.href = '/pool/' + encodeURIComponent(mine);
    if (location.pathname === '/pool/' + mine) {
      my.classList.add('active');
      var cta = document.querySelector('.cta-top'); if (cta) cta.classList.remove('active');
      var pl = document.querySelector('.main-nav a[href="/pool"]'); if (pl) pl.classList.remove('active'); // your own page is My stats
    }
  }

  poolMode(); // now that My stats has its link: which of Pool and My stats is marked

  // a puzzle key found in this browser (pool.js keeps it until its finder forgets it): the header leads to its claim
  var won = null;
  try { won = localStorage.getItem('bb-win'); } catch (_) { /* no storage */ }
  if (won) { var top = document.querySelector('.top .cta-top'); if (top) top.textContent = '★ Your key'; }

  load();
  setInterval(load, 60000);
  setInterval(showStatus, 15000);
})();
