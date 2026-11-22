/* /puzzle/<n>: one puzzle, from /api/puzzles/<n> (with its history) and /api/puzzles (the target, the price), drawn
   by render.js as puzzle-api writes it into the page before it is sent (api/pages.js); again every minute.
   Run again on every visit (nav.js). Needs BBRender. */
(function () {
  'use strict';
  var R = window.BBRender;
  function $(id) { return document.getElementById(id); }
  if (!$('pz-intro')) return;
  var m = location.pathname.match(/^\/puzzle\/(\d{1,3})$/), n = m ? Number(m[1]) : 0;
  if (!(n >= 1 && n <= 160)) return;
  function get(p) { return fetch(p, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }
  // set only what changed: the server's page already has the same numbers
  function put(id, v, html) {
    var el = $(id); if (!el) return;
    if (html) { if (el.innerHTML !== v) el.innerHTML = v; } else if (el.textContent !== v) el.textContent = v;
  }
  function load() {
    Promise.all([get('/api/puzzles/' + n), get('/api/puzzles').catch(function () { return null; })]).then(function (r) {
      var v = R.puzzle(r[0], r[1]);
      Object.keys(v.text).forEach(function (id) { put(id, v.text[id]); });
      Object.keys(v.html).forEach(function (id) { put(id, v.html[id], true); });
      document.title = v.head.title;
    }).catch(function () { if (window.BBNoData) window.BBNoData(); });
  }
  load();
  var timer = setInterval(load, 60000);
  window.addEventListener('bb:leave', function () { clearInterval(timer); }, { once: true });
})();
