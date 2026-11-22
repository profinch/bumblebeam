/* Moving between the site's pages without leaving this one, while the pool search runs: the graphics card's work
   lives in this page (pool.js), and a normal link would end it. So while it runs, a click on a link to one of the
   site's pages (and Back/Forward after such a move) fetches that page, puts its <main>, title and menu state in
   place, runs its page script, and changes the address as a normal visit would. When no search runs, links work
   as always. Exposes BBNav.go(url) for code that moves the page itself (the header's search).

   A page script that keeps timers or connections listens for 'bb:leave' (on window) and ends them there; the
   libraries (ui/, engine/, common.js, head.js) are loaded once and stay. */
(function () {
  'use strict';
  if (window.BBNav) return;
  var PAGE = /^\/(app|play|learn|bench|pool|pooldash|proof|puzzle)\.js$/; // page scripts: run again on every visit
  var ROUTE = /^\/(|pool|pool\/search|pool\/[A-Za-z0-9]{25,90}|play|learn|bench|rules|proof)$/;
  // the scripts this page has run: read when a move happens, not now (this script runs in the header, before the
  // page's own libraries further down exist), or a move would run every library a second time beside the search
  var loaded = {};
  function path(src) { try { return new URL(src, location.href).pathname; } catch (_) { return src; } }
  var loadedV = {}, shownAt = location.pathname + location.search;
  function ver(src) { var m = /[?&]v=([^&]*)/.exec(src); return m ? m[1] : ''; }
  function scan() { Array.prototype.forEach.call(document.querySelectorAll('script[src]'), function (s) { var p = path(s.src); loaded[p] = true; if (loadedV[p] === undefined) loadedV[p] = ver(s.getAttribute('src')); }); }
  var used = false, busy = 0;

  // a search running, or a found key on its way to the relays and the pool (found.js): this page must stay
  // (a find the server has not taken yet counts too: its page keeps trying every minute)
  function active() { return !!(window.BBPool && window.BBPool.running()) || !!(window.BBFound && (window.BBFound.busy() || window.BBFound.pending())); }
  function same(u) { return u.origin === location.origin && ROUTE.test(u.pathname); }

  function load(src) {
    // a page script runs afresh on every visit: its old tag goes first, so the tags do not pile up
    Array.prototype.forEach.call(document.querySelectorAll('script[src]'), function (o) { if (PAGE.test(path(o.src)) && path(o.src) === path(src)) o.remove(); });
    return new Promise(function (ok, no) {
      var s = document.createElement('script');
      s.src = src; s.onload = ok; s.onerror = no;
      document.body.appendChild(s);
    });
  }
  // the header's menu: the new page's marks (active), "My stats" by the address it points to
  function menu(doc) {
    var mine = document.getElementById('nav-my');
    var fresh = {};
    // the header's Start and the menu's Pool both lead to /pool: each keeps its own mark
    function key(a) { return (a.classList.contains('cta-top') ? 'cta ' : '') + a.getAttribute('href'); }
    Array.prototype.forEach.call(doc.querySelectorAll('.top .cta-top, .top .main-nav a:not(#nav-my)'), function (a) { fresh[key(a)] = a.classList.contains('active'); });
    Array.prototype.forEach.call(document.querySelectorAll('.top .cta-top, .top .main-nav a:not(#nav-my)'), function (a) { a.classList.toggle('active', !!fresh[key(a)]); });
    if (mine) {
      var me = !mine.hidden && location.pathname === mine.getAttribute('href');
      mine.classList.toggle('active', me);
      if (me) { var cta = document.querySelector('.top .cta-top'); if (cta) cta.classList.remove('active'); var pl = document.querySelector('.top .main-nav a[href="/pool"]'); if (pl) pl.classList.remove('active'); }
    }
  }

  async function show(url, push) {
    var n = ++busy;
    var r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    var html = await r.text();
    if (n !== busy) return; // a newer move started meanwhile
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var main = doc.querySelector('main');
    if (!main) throw new Error('no main');
    window.dispatchEvent(new Event('bb:leave'));
    if (push) history.pushState({ bbnav: 1 }, '', url);
    used = true;
    document.title = doc.title;
    var d = doc.querySelector('meta[name="description"]'), m = document.querySelector('meta[name="description"]');
    if (d && m) m.setAttribute('content', d.getAttribute('content'));
    // the new page's address, link preview, robots rule and structured data, as a load would have them
    var SEO = 'link[rel="canonical"], meta[property^="og:"], meta[name^="twitter:"], meta[name="robots"], script[type="application/ld+json"]';
    Array.prototype.forEach.call(document.head.querySelectorAll(SEO), function (x) { x.remove(); });
    Array.prototype.forEach.call(doc.head.querySelectorAll(SEO), function (x) { document.head.appendChild(document.adoptNode(x)); });
    if (window.BBPoolMode) window.BBPoolMode(); // the pool's pages: which parts show (head.js)
    document.querySelector('main').replaceWith(document.adoptNode(main));
    menu(doc);
    if (window.BBPoolMode) window.BBPoolMode(); // Pool or My stats, by whose page it is
    if (window.BBP && window.BBP.syncBg) window.BBP.syncBg(); // the new page's "in the background" switch
    var u = new URL(url, location.href);
    if (u.hash && document.getElementById(u.hash.slice(1))) document.getElementById(u.hash.slice(1)).scrollIntoView();
    else window.scrollTo(0, 0);
    // keyboard and screen reader users land on the new page's heading, as on a page load
    var h1 = document.querySelector('main h1');
    if (h1 && !u.hash) { h1.setAttribute('tabindex', '-1'); h1.focus({ preventScroll: true }); }
    shownAt = location.pathname + location.search;
    // the libraries it needs that are not here yet, in order, then its page script, run afresh; a newer move
    // meanwhile stops it (this page's script must not run on the next page's elements)
    scan();
    var srcs = Array.prototype.map.call(doc.querySelectorAll('body script[src]'), function (s) { return s.getAttribute('src'); });
    for (var i = 0; i < srcs.length; i++) {
      if (n !== busy) return;
      var p = path(srcs[i]);
      // another release of the site (a library with another ?v= than the one running): a full load, never a mix
      if (!PAGE.test(p) && loaded[p] && loadedV[p] !== undefined && loadedV[p] !== ver(srcs[i])) { location.href = url; return; }
      if (PAGE.test(p)) await load(srcs[i]);
      else if (!loaded[p]) { loaded[p] = true; loadedV[p] = ver(srcs[i]); await load(srcs[i]); }
    }
  }
  // force: move this way even with no search running (pool.js, to show the claim after a find)
  function go(url, push, force) {
    if (push === undefined) push = true;
    var u = new URL(url, location.href);
    if ((!active() && !force) || !same(u)) { location.href = u.href; return; }
    show(u.pathname + u.search + u.hash, push).catch(function () { location.href = u.href; });
  }

  document.addEventListener('click', function (ev) {
    if (!active() || ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    var a = ev.target.closest && ev.target.closest('a[href]');
    if (!a) return;
    // (by its attributes: an SVG link, as /learn's comb cells, has objects for href and target)
    var tgt = a.getAttribute('target');
    if (!a || (tgt && tgt !== '_self') || a.hasAttribute('download')) return;
    var u = new URL(a.getAttribute('href'), location.href);
    if (!same(u)) return;
    if (u.pathname === location.pathname && u.search === location.search && u.hash) return; // an anchor on this page
    ev.preventDefault();
    go(u.href);
  });
  // Back and Forward after a move made here: show that page the same way (a full load once nothing runs)
  window.addEventListener('popstate', function () {
    if (!used) return;
    if (location.pathname + location.search === shownAt) return; // only the #anchor changed: the browser scrolls
    if (active() && same(new URL(location.href))) show(location.pathname + location.search + location.hash, false).catch(function () { location.reload(); });
    else location.reload();
  });

  window.BBNav = { go: go };
})();
