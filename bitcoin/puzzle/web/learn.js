/* /learn: how the puzzle works, for anyone. The key -> address machine,
   the haystack slider, a live race of brute force, meet in the middle (BSGS) and the kangaroo on a hidden key, the
   creator's clue with all 160 puzzles replayed over the years, and the odds calculator (moved here from the home
   page: what one person's own hardware can expect, searching alone). */
(function () {
  'use strict';
  // window listeners of this page, taken off when another page is shown in its place (nav.js), so moving back and
  // forth does not pile them up
  var offs = [];
  function onResize(f) { window.addEventListener('resize', f); offs.push(function () { window.removeEventListener('resize', f); }); }
  var P = window.BBP, S = P.S;
  function $(id) { return document.getElementById(id); }
  var esc = window.BB.esc; // ui/components/bb.js
  function fmtBtc(x) { return x >= 100 ? x.toFixed(0) : x >= 1 ? (Math.round(x * 100) / 100).toString() : (Math.round(x * 1e4) / 1e4).toString(); }
  function fmtInt(x) { return Math.round(x).toLocaleString('en-US'); }
  function date(t) { return t ? new Date(t * 1000).toISOString().slice(0, 10) : ''; }
  // a time in plain words: minutes, days, years, and big years as words (620 thousand years)
  function when(sec) {
    if (!isFinite(sec)) return 'forever';
    var y = sec / 31557600;
    if (y >= 1e4) return 'about ' + P.words(y) + ' years';
    if (y >= 2) return 'about ' + fmtInt(y) + ' years';
    return P.dur(sec);
  }
  // keys a second in words: 263 thousand keys a second
  function speed(x) { return P.words(x) + ' keys a second'; }
  var TAB = 3e7, RTX4090 = 5e9; // a browser tab and one RTX 4090, brute force, as the calculator rates them
  var data = null;

  // ---------- 1. a key is just a number ----------
  var addrs = {}, prevAddr = '';
  // the field takes digits only, up to the last key (n-1, 78 digits: a bigger number becomes it), so it always
  // holds a valid key, and an empty field or a zero becomes 1
  var MAXLEN = 78, TOP = S.N - 1n; // every key: 1 to n-1 (n, the curve's order, has 78 digits)
  function clean() {
    var el = $('k-in'), raw = el.value, v = raw.replace(/[^0-9]/g, '').replace(/^0+/, '').slice(0, MAXLEN);
    if (!v) v = '1';
    // a 78-digit number past the last key becomes the last key
    if (v.length === MAXLEN && BigInt(v) > TOP) v = TOP.toString();
    if (raw !== v) {
      // keep the caret where it was: count the digits kept before it
      var at = el.selectionStart == null ? raw.length : el.selectionStart;
      var before = raw.slice(0, at).replace(/[^0-9]/g, '').length - (raw.replace(/[^0-9]/g, '').length - raw.replace(/[^0-9]/g, '').replace(/^0+/, '').length);
      el.value = v;
      if (document.activeElement === el) { var c = Math.max(0, Math.min(v.length, before)); try { el.setSelectionRange(c, c); } catch (_) { /* not a text field */ } }
    }
    return v;
  }
  function key() { return BigInt(clean()); }
  // the new address with the characters that changed since the last one marked: there is no getting warmer
  function diff(a, b) {
    if (!b) return esc(a);
    var o = '';
    for (var i = 0; i < a.length; i++) o += a[i] === b[i] ? esc(a[i]) : '<span class="chg">' + esc(a[i]) + '</span>';
    return o;
  }
  function chain() {
    var k = key();
    var p = S.mulG(k), pub = S.compressedHex(p), sha = S.toHex(S.sha256(S.fromHex(pub))), h = S.wordsToHex(S.hash160Words(p[0], p[1])), a = S.hash160ToAddress(h);
    // the puzzles' own addresses are built into the page (engine/puzzles.js): known at once, no wait for the API
    var bits = k.toString(2).length, n = addrs[a] || (window.BBPuzzles ? window.BBPuzzles.which(h) : 0);
    var rows = [
      ['Your number (the private key)', esc(k.toString()), { html: bits + (bits === 1 ? ' binary digit' : ' binary digits') + ', <span class="hexv">0x' + k.toString(16) + '</span> in hex' }],
      ['Public key', esc(pub), 'Your number times a fixed starting point on the Bitcoin curve. Easy to compute, impossible to undo.'],
      ['Scrambled once (SHA-256)', esc(sha), 'A fingerprint of the public key.'],
      ['Scrambled again (RIPEMD-160)', esc(h), 'These 20 bytes are what the address really stores.'],
      ['Address', diff(a, prevAddr !== a ? prevAddr : ''), n ? { html: 'This is the real address of <a href="/puzzle/' + n + '">puzzle #' + n + '</a> ✓' } : 'The same bytes written with a checksum that catches typos.' + (prevAddr && prevAddr !== a ? ' The highlighted characters changed.' : '')],
    ];
    $('k-out').innerHTML = rows.map(function (r, i) { return '<li' + (i === 4 && n ? ' class="hit"' : '') + '><div class="k">' + esc(r[0]) + '</div><div class="mono val">' + r[1] + '</div><div class="dim sub">' + (r[2] && r[2].html ? r[2].html : esc(r[2])) + '</div></li>'; }).join('');
    prevAddr = a;
  }
  function step(d) {
    var k = key() + BigInt(d);
    if (k < 1n) k = 1n;
    var v = k.toString();
    if (k > TOP) return;
    $('k-in').value = v;
    chain();
  }
  $('k-in').addEventListener('input', chain);
  $('k-inc').addEventListener('click', function () { step(1); });
  $('k-dec').addEventListener('click', function () { step(-1); });
  document.querySelectorAll('[data-k]').forEach(function (a) {
    a.addEventListener('click', function (e) { e.preventDefault(); $('k-in').value = a.getAttribute('data-k'); chain(); });
  });
  chain();

  // ---------- 2. how big is the haystack ----------
  // the haystack as a race on a log time scale: how long a browser tab and an RTX 4090 need for an even chance,
  // two bars against everyday and cosmic events. Times as log10 of seconds, on one scale for all 160 puzzles (under
  // a nanosecond to past the protons) seen through a fisheye centred on the tab's end
  var YR = 31557600, L = Math.log10;
  // big numbers in words, past where P.words stops (it ends at septillion; the last puzzles reach nonillions)
  function bigWords(x) {
    var n = ['', 'thousand', 'million', 'billion', 'trillion', 'quadrillion', 'quintillion', 'sextillion', 'septillion', 'octillion', 'nonillion', 'decillion'], i = 0;
    if (x < 1000) return (x >= 100 ? Math.round(x) : Math.round(x * 10) / 10).toString();
    if (x >= 1e36) { var e = Math.floor(L(x)); return (Math.round(x / Math.pow(10, e) * 10) / 10) + ' × 10' + String(e).replace(/\d/g, function (c) { return '⁰¹²³⁴⁵⁶⁷⁸⁹'[c]; }); }
    while (x >= 1000 && i < n.length - 1) { x /= 1000; i++; }
    return (x >= 100 ? Math.round(x) : Math.round(x * 10) / 10) + ' ' + n[i];
  }
  function span(s) {
    if (s < 1e-9) return 'under 1 ns';
    if (s < 1e-6) return Math.round(s * 1e9) + ' ns';
    if (s < 1e-3) return Math.round(s * 1e6) + ' µs';
    if (s < 1) return Math.round(s * 1e3) + ' ms';
    if (s < 730 * 86400) return P.dur(s);
    return bigWords(s / YR) + ' years';
  }
  // [seconds, emoji, name on the scale, how the caption says it]; each about a tenfold or more from the next, so they
  // never sit on top of each other however the lens squeezes them
  var EV = [
    [1e-9, '💡', 'light crosses 30 cm', 'it takes light to cross 30 cm'], [3e-5, '⚡', 'a lightning strike', 'a lightning strike lasts'], [1e-3, '📸', 'a camera flash', 'a camera flash lasts'],
    [0.02, '🐦', 'a hummingbird wing beat', 'a hummingbird wing beat takes'], [0.3, '😉', 'a blink', 'a blink takes'], [60, '⏲️', 'a minute', 'a minute'], [3600, '🕐', 'an hour', 'an hour'], [86400, '📅', 'a day', 'a day'], [YR, '🎂', 'a year', 'a year'], [80 * YR, '👵', 'a lifetime', 'a human life'],
    [4500 * YR, '🐪', 'since the pyramids', 'the pyramids have stood'],
    [3e5 * YR, '🧍', 'since the first humans', 'humans have existed'], [66e6 * YR, '🦖', 'since the dinosaurs', 'the time since the dinosaurs died out'],
    [13.8e9 * YR, '🌌', 'the age of the universe', 'the universe has existed'],
    [1e14 * YR, '🌑', 'the last star goes out', 'the stars will keep shining'], [13.8e15 * YR, '🌌', 'a million ages of the universe', 'a million ages of the universe'],
    [1e20 * YR, '🌀', 'galaxies fall apart', 'galaxies will hold together'], [13.8e21 * YR, '🌌', 'a trillion ages of the universe', 'a trillion ages of the universe'],
    [13.8e24 * YR, '🌌', 'a quadrillion ages of the universe', 'a quadrillion ages of the universe'], [13.8e27 * YR, '🌌', 'a quintillion ages of the universe', 'a quintillion ages of the universe'],
    [1e30 * YR, '🕳️', 'the last stars fall into black holes', 'it takes the last stars to fall into black holes'], [1e34 * YR, '🔬', 'protons may last this long', 'protons may last']
  ];
  // one plain comparison with the nearest event, and that event's emoji: "about as long as …", "4.2 times as long
  // as …", "16 hours", "38 million ages of the universe"
  function compare(v) {
    var prev = null, next = null;
    EV.forEach(function (m) { if (m[0] <= v) prev = m; else if (!next) next = m; });
    if (next && (!prev || next[0] / v < 1.15)) return [next[1], v / next[0] > 0.87 ? 'about as long as ' + next[3] : 'less than ' + next[3]];
    var r = v / prev[0], e = prev[1];
    if (r < 1.15) return [e, 'about as long as ' + prev[3]];
    var U = { 'a minute': 'minutes', 'an hour': 'hours', 'a day': 'days', 'a year': 'years' };
    if (U[prev[2]]) return [e, Math.round(r) + ' ' + U[prev[2]]];
    if (prev[0] >= 13.8e9 * YR && /ages of the universe$|^the age of the universe$/.test(prev[2])) return [e, bigWords(v / (13.8e9 * YR)) + ' ages of the universe'];
    if (r >= 1.9 && r < 2.15) return [e, 'twice as long as ' + prev[3]];
    return [e, (r < 10 ? +r.toFixed(1) : r < 1000 ? Math.round(r) : bigWords(r)) + ' times as long as ' + prev[3]];
  }
  var tl = $('h-tl');
  // both bars in one svg; each name is cut out of its bar's fill through a mask, so the page shows through
  function barDefs(k, y, c, o0) {
    return '<linearGradient id="h-gr' + k + '"><stop offset="0" stop-color="' + c + '" stop-opacity="' + o0 + '"/><stop offset="1" stop-color="' + c + '"/></linearGradient>' +
      '<mask id="h-mk' + k + '" maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="60"><rect x="0" y="0" width="100%" height="60" fill="#fff"/>' +
      '<text id="h-tn' + k + '" y="' + (y + 13) + '" dominant-baseline="central" text-anchor="end" fill="#000"></text>' +
      '<text class="s" id="h-ts' + k + '" y="' + (y + 13) + '" dominant-baseline="central" text-anchor="end" fill="#000"></text></mask>';
  }
  tl.innerHTML = '<svg><defs>' + barDefs('t', 0, '#f7931a', 0.35) + barDefs('g', 34, '#00f6d2', 0.25) + '</defs>' +
    '<rect y="0" width="100%" height="26" rx="13" fill="rgba(255,255,255,.07)"/><rect y="34" width="100%" height="26" rx="13" fill="rgba(255,255,255,.07)"/>' +
    '<rect id="h-bt" y="0" height="26" rx="13" fill="url(#h-grt)" mask="url(#h-mkt)"/><rect id="h-bg" y="34" height="26" rx="13" fill="url(#h-grg)" mask="url(#h-mkg)"/></svg>' +
    '<span class="tl-time t" id="h-lt"></span><span class="tl-time g" id="h-lg"></span>';
  var BAR = { t: { name: 'browser tab', short: 'tab', color: '#ffc46b', time: '' }, g: { name: 'RTX 4090', short: 'GPU', color: '#00f6d2', time: '' } };
  var cv = document.createElement('canvas').getContext('2d');
  function textW(s, small) { cv.font = (small ? '400 10.5px ' : '700 12px ') + getComputedStyle($('h-lt')).fontFamily; return cv.measureText(s).width; }
  var EVS = EV.map(function (m) {
    var nm = document.createElement('div'); nm.className = 'tl-ev'; nm.innerHTML = '<span class="em">' + m[1] + '</span><span>' + m[2] + '</span>'; tl.appendChild(nm);
    var ln = document.createElement('div'); ln.className = 'tl-line'; tl.appendChild(ln);
    return { nm: nm, em: nm.firstChild, name: nm.lastChild, ln: ln, l: L(m[0]), w: 0, no: 0, io: 0, want: false, iw: false, minor: / ages of the universe$|coffee|hummingbird/.test(m[2]) ? 1 : 0 };
  });
  // the whole scale at once, nothing scrolls: a fisheye centred on the tab bar's end spreads the events near it apart
  // (named) and squeezes the far ones (icons, then nothing). The lens follows the slider, which runs smoothly between
  // whole puzzles while dragged; a name or an icon shows as far as the room around it allows, so they fade rather
  // than pop
  var G = L(RTX4090 / TAB), LO = -11, HI = 42, K = 2, KL = 2, PADX = 10, GAP = 34; // the bars' gap; the scale's ends (log10 s); the lens; an icon's room
  var tgt = null, view = null, laidOut = 0, raf = 0, settled = false;
  function frame() {
    raf = 0;
    var W = tl.clientWidth; if (!W || !tgt) return;
    var moving = Math.abs(tgt.lt - view.lt) > 1e-4;
    view.lt = moving ? view.lt + (tgt.lt - view.lt) * 0.3 : tgt.lt;
    var c = (view.lt - LO) / (HI - LO);
    // the lens: 0..1 to 0..1, flat around c, each side squeezed toward its end
    function lens(u) {
      if (u >= c) { var s = (u - c) / (1 - c || 1); return c + (1 - c) * (1 + K) * s / (1 + K * s); }
      var s2 = (c - u) / (c || 1); return c - c * (1 + KL) * s2 / (1 + KL * s2); // the past side squeezed less
    }
    function x(l) { return PADX + lens((l - LO) / (HI - LO)) * (W - 2 * PADX); }
    if (laidOut !== W) {
      laidOut = W; EVS.forEach(function (o) { var s = o.nm.style, d = s.display; s.display = ''; o.w = o.name.offsetWidth; s.display = d; });
      // the events this width can hold: on a phone the scale has a few pixels per tenfold, so only those far enough
      // apart take part (fixed for the width, so none swaps in or out as the slider moves); on a wide screen nearly all
      // the plain events first, then the fillers (multiples of the universe's age) where they still fit, so a phone
      // keeps the black holes rather than a quintillion ages of the universe
      var apart = GAP / ((W - 2 * PADX) / (HI - LO)), on = [];
      [0, 1].forEach(function (minor) {
        EVS.forEach(function (o) {
          if (o.minor !== minor) return;
          o.off = on.some(function (q) { return Math.abs(q.l - o.l) < apart; });
          if (!o.off) on.push(o);
        });
      });
    }
    var end = view.lt, xs = EVS.map(function (o) { return x(o.l); });
    // which icons show: on each side, the events in turn out from the lens, each while it clears the one before it by
    // GAP and stays inside the card; the first that does not ends that side. The lens squeezes harder toward the
    // edges, so that is where it gets tight first: the icons go from the edge in, one after another (several at once
    // take turns, below), and come back the same way. A little more room to come back than to stay, so nothing at
    // the edge of fitting flickers
    [EVS.map(function (o, k) { return k; }).filter(function (k) { return EVS[k].l <= end; }).reverse(),
     EVS.map(function (o, k) { return k; }).filter(function (k) { return EVS[k].l > end; })].forEach(function (side) {
      var last = null, open = true;
      side.forEach(function (k) {
        var o = EVS[k], xx = xs[k];
        if (o.off) { o.iw = false; return; }
        o.iw = open && xx >= 12 && xx <= W - 12 && (last === null || Math.abs(xx - xs[last]) >= (o.iw ? GAP : GAP + 8));
        if (o.iw) last = k; else open = false;
      });
    });
    // the names over the icons shown, nearest the lens first: each clears the name room of every shown icon nearer
    // the lens (which of two on one side is nearer never changes until the lens passes them, so names do not swap)
    EVS.forEach(function (o, k) {
      var xx = xs[k], a = xx - o.w / 2, near = Math.abs(o.l - end), pad = o.want ? 8 : 20;
      o.want = o.iw && a >= 0 && a + o.w <= W && EVS.every(function (q, j) {
        if (j === k || !q.iw || Math.abs(q.l - end) > near) return true;
        return Math.abs(xs[j] - xx) >= (o.w + q.w) / 2 + pad;
      });
    });
    [EVS.map(function (o, k) { return k; }).filter(function (k) { return EVS[k].l <= end; }).reverse(),
     EVS.map(function (o, k) { return k; }).filter(function (k) { return EVS[k].l > end; })].forEach(function (side) {
      // several that change at once take turns, 90 ms apart: going, the farthest first; coming, the nearest first
      var now = performance.now();
      side.forEach(function (k) { var o = EVS[k]; if (o.iw === !!o.shown) { o.dir = undefined; o.at = undefined; } });
      var going = side.filter(function (k) { return !EVS[k].iw && EVS[k].shown; }).reverse(), coming = side.filter(function (k) { return EVS[k].iw && !EVS[k].shown; });
      going.forEach(function (k, i) { var o = EVS[k]; if (o.at === undefined || o.dir !== 0) { o.at = now + i * 90; o.dir = 0; } });
      coming.forEach(function (k, i) { var o = EVS[k]; if (o.at === undefined || o.dir !== 1) { o.at = now + i * 90; o.dir = 1; } });
      side.forEach(function (k) { var o = EVS[k]; if (o.dir !== undefined && (o.dir === 1) === o.iw && now >= o.at) { o.shown = o.iw; o.dir = undefined; o.at = undefined; } if (o.dir !== undefined) moving = true; });
    });
    // the first frame shows everything in place at once: taking turns and fading are for changes, not for arriving
    if (!settled) { settled = true; EVS.forEach(function (o) { o.shown = o.iw; o.dir = o.at = undefined; o.io = o.iw ? 1 : 0; o.no = o.want && o.iw ? 1 : 0; }); }
    EVS.forEach(function (o, k) {
      var nx = xs[k];
      // in and out over a few frames: an icon shrinks away rather than blinking out
      var want = o.want && o.shown ? 1 : 0, iwant = o.shown ? 1 : 0;
      o.no = Math.abs(want - o.no) < 0.03 ? want : o.no + (want - o.no) * 0.3;
      o.io = Math.abs(iwant - o.io) < 0.03 ? iwant : o.io + (iwant - o.io) * 0.3;
      if (o.no !== want || o.io !== iwant) moving = true;
      var em = o.io, nm = Math.min(o.no, em), past = o.l <= end, ln = em * (past ? 0.9 : 0.45);
      o.nm.style.display = o.ln.style.display = em > 0 ? '' : 'none';
      if (!em) return;
      o.em.style.transform = 'scale(' + (0.4 + 0.6 * em).toFixed(3) + ')';
      o.em.style.opacity = (em * (past ? 1 : 0.6)).toFixed(3); o.name.style.opacity = nm.toFixed(3); o.ln.style.opacity = ln.toFixed(3);
      o.nm.style.transform = 'translate3d(' + (nx - o.w / 2).toFixed(2) + 'px,0,0)';
      o.ln.style.transform = 'translate3d(' + nx.toFixed(2) + 'px,0,0)';
      o.nm.classList.toggle('past', past);
    });
    // each name inside by the round end, its time after the bar, or inside too when the bar runs near the edge
    // (then on a phone the short name, or the time alone, so nothing runs off the left)
    [['t', view.lt], ['g', view.lt - G]].forEach(function (a) {
      var k = a[0], b = BAR[k], w = Math.min(W, Math.max(6, x(a[1]))), nw = textW(b.name), sw = textW(b.time, true);
      var lab = $('h-l' + k), tn = $('h-tn' + k), ts = $('h-ts' + k);
      $('h-b' + k).setAttribute('width', w.toFixed(1));
      if (w < nw + 26) {
        tn.textContent = ts.textContent = '';
        lab.innerHTML = b.name + ' <small>' + b.time + '</small>'; lab.style.color = b.color;
        lab.style.transform = 'translateX(' + (w + 8).toFixed(1) + 'px)'; return;
      }
      tn.textContent = b.name; tn.setAttribute('x', (w - 13).toFixed(1));
      if (w + 8 + sw <= W - 6) {
        ts.textContent = ''; lab.innerHTML = '<small>' + b.time + '</small>'; lab.style.color = b.color;
        lab.style.transform = 'translateX(' + (w + 8).toFixed(1) + 'px)'; return;
      }
      var nm = b.name;
      if (w - 13 - nw - 8 - sw < 10) { nm = b.short; nw = textW(nm); }
      if (w - 13 - nw - 8 - sw < 10) { nm = ''; nw = -8; }
      tn.textContent = nm; lab.innerHTML = ''; ts.textContent = b.time; ts.setAttribute('x', (w - 13 - nw - 8).toFixed(1));
    });
    if (moving) raf = requestAnimationFrame(frame);
  }
  function kick() { if (!raf) raf = requestAnimationFrame(frame); }
  onResize(kick);
  var shown = 0;
  function hay() {
    var hin = $('h-in'), v = Number(hin.value), n = Math.round(v);
    // the track filled up to the thumb's centre (16 px thumb)
    var f = (v - 1) / 159;
    hin.style.setProperty('--p', 'calc(' + (f * 100) + '% + ' + (8 - 16 * f) + 'px)');
    // the scale follows the slider itself, between whole puzzles too
    tgt = { lt: L(Math.pow(2, v - 1) / 2 / TAB) };
    if (!view) view = { lt: tgt.lt };
    kick();
    if (n === shown && data) return;
    shown = n;
    var keys = Math.pow(2, n - 1), tt = keys / 2 / TAB, tg = keys / 2 / RTX4090;
    $('h-n').textContent = '#' + n;
    BAR.t.time = span(tt); BAR.g.time = span(tg);
    // the numbers: the puzzle and its keys, both racers' time for an even chance, how much sooner the card is
    function item(k, v, cls, s) { return '<div><div class="k">' + k + '</div><div class="v ' + cls + '">' + v + '</div>' + (s ? '<div class="s">' + s + '</div>' : '') + '</div>'; }
    $('h-sum').innerHTML = item('Even chance at', '#' + n, 'a', (keys < 1e6 ? fmtInt(keys) : bigWords(keys)) + (keys === 1 ? ' key' : ' keys')) +
      item('Browser tab', span(tt), 't', fmtInt(TAB / 1e6) + ' million keys a second') +
      item('RTX 4090', span(tg), 'g', fmtInt(RTX4090 / 1e9) + ' billion keys a second') +
      item('Difference', Math.round(RTX4090 / TAB) + '× faster', '', tt - tg >= 1 ? span(tt - tg) + ' sooner' : 'both in a blink');
    // and the fact: how long that is, against the events on the scale
    var ct = compare(tt), cg = compare(tg);
    $('h-fact').innerHTML = '<span class="em">' + ct[0] + '</span>A browser tab would need ' + ct[1] + '.<br><span class="em">' + cg[0] + '</span>' +
      (tg >= 1 ? 'Even an RTX 4090 would need ' : 'An RTX 4090 needs ') + cg[1] + '.';
  }
  var hin = $('h-in'), touched = false;
  // the pool's target, from the server: the texts that name it, and where the slider starts (unless moved already)
  function target(n) {
    if (n) {
      var keys = Math.pow(2, n - 1), sand = keys / 7.5e18, prize = n / 10; // grains of sand on Earth's beaches, a common estimate
      document.querySelectorAll('[data-tn]').forEach(function (el) { el.textContent = '#' + n; });
      // and where it is a link, to its page here
      var p = data && data.puzzles[n - 1];
      document.querySelectorAll('[data-tn-link]').forEach(function (el) { el.textContent = 'puzzle #' + n; el.href = '/puzzle/' + n; el.removeAttribute('target'); if (p) el.title = p.address; });
      document.querySelectorAll('[data-tn-addr]').forEach(function (el) { el.textContent = 'Puzzle #' + n; el.href = '/puzzle/' + n; el.removeAttribute('target'); if (p) el.title = p.address; });
      $('t-keys').textContent = bigWords(keys);
      $('t-sand').textContent = sand >= 1.5 ? 'about ' + (sand >= 100 ? Math.round(sand / 10) * 10 : Math.round(sand)) + ' times all the grains of sand on all the beaches of Earth' : sand >= 0.8 ? 'about as many as the grains of sand on all the beaches of Earth' : 'about ' + Math.max(1, Math.round(sand * 100)) + '% of the grains of sand on all the beaches of Earth';
      $('t-share').innerHTML = '<b>' + Math.max(0, Math.floor(prize) - 1) + '</b> of the <b>' + fmtBtc(prize) + ' BTC</b>'; // bold as on the home page
      if (!touched) hin.value = n;
    }
    hay();
  }
  hin.addEventListener('pointerdown', function () { touched = true; });
  hin.addEventListener('keydown', function () { touched = true; });
  hin.addEventListener('input', hay);
  // let go: settle on the nearest whole puzzle (the scale glides there)
  hin.addEventListener('change', function () { hin.value = Math.round(Number(hin.value)); hay(); });
  // the keys step whole puzzles, not the drag's hundredths
  hin.addEventListener('keydown', function (e) {
    var s = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -10, PageUp: 10 }[e.key];
    if (!s) return;
    e.preventDefault();
    hin.value = Math.max(1, Math.min(160, Math.round(Number(hin.value)) + s)); hay();
  });
  hay();

  // ---------- 4. the creator's clue: all 160 over the years ----------
  var hist = { cells: [], timer: null };
  function histState(p, t) {
    if (p.solved && p.solved.time <= t) return p.exposed && p.exposed.time < p.solved.time - 86400 ? 'g' : 'b';
    if (p.exposed && p.exposed.time <= t) return 'x';
    return 'o';
  }
  function histAt(t) {
    data.puzzles.forEach(function (p, i) { var c = hist.cells[i]; if (c) c.setAttribute('class', histState(p, t)); });
    $('hist-yr').textContent = new Date(t * 1000).getUTCFullYear();
  }
  // the 160 as honeycomb, 20 to a row, every other row shifted half a cell; each cell its puzzle's number, and a link
  // to its page (out of the tab order: the comb is a picture to the reader, the puzzles are linked in the text)
  function histInit(d) {
    var box = $('hist'), r = 10, w = r * Math.sqrt(3), cols = 20, rows = Math.ceil(d.puzzles.length / cols);
    var W = w * (cols + 0.5), H = r * (1.5 * (rows - 1) + 2), h = '<svg viewBox="0 0 ' + W.toFixed(1) + ' ' + H.toFixed(1) + '" role="img" aria-label="All 160 puzzles">';
    d.puzzles.forEach(function (p, i) {
      var col = i % cols, row = Math.floor(i / cols), cx = w / 2 + col * w + (row % 2 ? w / 2 : 0), cy = r + row * r * 1.5, pts = [];
      for (var q = 0; q < 6; q++) { var a = Math.PI / 3 * q + Math.PI / 6; pts.push((cx + (r - 0.6) * Math.cos(a)).toFixed(2) + ',' + (cy + (r - 0.6) * Math.sin(a)).toFixed(2)); }
      var tip = '#' + p.n + ': ' + (p.status === 'solved' && p.solved ? 'solved ' + date(p.solved.time) + ', ' + fmtBtc(p.solved.amount) + ' BTC' : 'open, ' + fmtBtc(p.balance) + ' BTC');
      h += '<a href="/puzzle/' + p.n + '" tabindex="-1"><g><title>' + esc(tip) + '</title><polygon points="' + pts.join(' ') + '"/><text x="' + cx.toFixed(1) + '" y="' + cy.toFixed(1) + '" dominant-baseline="central">' + p.n + '</text></g></a>';
    });
    box.innerHTML = h + '</svg>';
    hist.cells = Array.prototype.slice.call(box.querySelectorAll('g'));
    histMarks(d); histTo(HT1);
  }
  // the timeline: a track from 2015 to today with every solve marked, a thumb to drag, and play
  var HT0 = Date.UTC(2015, 0, 1) / 1000, HT1 = Date.now() / 1000;
  function histTo(t, fromUser) {
    if (fromUser) clearInterval(hist.timer);
    histAt(t);
    var sl = $('hist-sl'), f = (t - HT0) / (HT1 - HT0);
    sl.value = Math.round(f * 1000); sl.style.setProperty('--p', 'calc(' + (f * 100) + '% + ' + (8 - 16 * f) + 'px)');
    $('hist-play').textContent = hist.timer && hist.playing ? '❚❚' : '▶';
  }
  function histMarks(d) {
    var cv = $('hist-marks'), dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = 14;
    if (!w) return;
    cv.width = Math.round(w * dpr); cv.height = h * dpr;
    var c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
    d.puzzles.forEach(function (p) {
      if (!p.solved) return;
      var f = (p.solved.time - HT0) / (HT1 - HT0), x = 8 + f * (w - 16), k = histState(p, HT1) === 'g';
      c.fillStyle = k ? 'rgba(218, 104, 245, 0.85)' : 'rgba(0, 246, 210, 0.7)'; c.fillRect(Math.round(x), 2, 1.5, h - 4);
    });
    // every year where there is room for it; on a narrow track the first, then every other one back from this year
    var ys = '', y1 = new Date(HT1 * 1000).getUTCFullYear(), every = w / (y1 - 2014) >= 46;
    for (var y = 2015; y <= y1; y++) { var fy = (Date.UTC(y, 0, 1) / 1000 - HT0) / (HT1 - HT0); ys += '<span style="left:calc(8px + ' + (fy * 100) + '% - ' + (16 * fy) + 'px)">' + (every || y === 2015 || ((y1 - y) % 2 === 0 && y > 2016) ? y : '') + '</span>'; }
    $('hist-years').innerHTML = ys;
  }
  $('hist-sl').addEventListener('input', function () { if (data) { clearInterval(hist.timer); hist.playing = false; histTo(HT0 + (HT1 - HT0) * this.value / 1000); } });
  $('hist-play').addEventListener('click', function () {
    if (!data) return;
    if (hist.playing) { clearInterval(hist.timer); hist.playing = false; histTo(hist.t); return; }
    clearInterval(hist.timer); hist.playing = true;
    var t = Number($('hist-sl').value) >= 999 ? HT0 : HT0 + (HT1 - HT0) * $('hist-sl').value / 1000;
    hist.timer = setInterval(function () { t += (HT1 - HT0) / 300; if (t >= HT1) { t = HT1; clearInterval(hist.timer); hist.playing = false; } hist.t = t; histTo(t); }, 40);
    histTo(t);
  });
  onResize(function () { if (data) histMarks(data); });

  // every "#N" in the paragraphs marked data-plinks links to that puzzle's address (through /api/go), as elsewhere
  function puzzleLinks(d) {
    document.querySelectorAll('[data-plinks]').forEach(function (el) {
      var walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), nodes = [], n;
      while ((n = walk.nextNode())) if (!n.parentNode.closest('a')) nodes.push(n);
      nodes.forEach(function (tn) {
        var s = tn.nodeValue, re = /#(\d{1,3})\b/g, m, last = 0, frag = document.createDocumentFragment();
        while ((m = re.exec(s))) {
          var p = d.puzzles[Number(m[1]) - 1]; if (!p) continue;
          frag.appendChild(document.createTextNode(s.slice(last, m.index)));
          var a = document.createElement('a'); a.href = '/puzzle/' + p.n; a.title = p.address; a.textContent = m[0];
          frag.appendChild(a); last = re.lastIndex;
        }
        if (last) { frag.appendChild(document.createTextNode(s.slice(last))); tn.parentNode.replaceChild(frag, tn); }
      });
    });
  }

  // ---------- the data ----------
  P.get('/api/puzzles').then(function (d) {
    data = d;
    d.puzzles.forEach(function (p) { addrs[p.address] = p.n; });
    chain(); target(d.target); histInit(d); odds(d); puzzleLinks(d);
    // a cold server may not have the price yet: ask for it on its own
    if (!d.btc_usd) P.get('/api/price').then(function (x) { if (x && x.usd) { d.btc_usd = x.usd; if (odds.calc) odds.calc(); } }).catch(function () {});
  }).catch(function () { /* the numbers stay as they are */ });

  // ---------- 3. three ways to search: the race ----------
  var lanes = {}, jobs = {}, race = null;
  document.querySelectorAll('.lane').forEach(function (el) { lanes[el.getAttribute('data-m')] = { el: el, cv: el.querySelector('canvas'), pos: 0, marks: [], done: null }; });
  var css = getComputedStyle(document.documentElement);
  function col(name, fb) { return (css.getPropertyValue(name) || fb).trim(); }

  // a dial per method: a ring of 48 comb cells, the whole haystack from the top clockwise (pale: covered, bright: where
  // it looks now), and inside an arc of the work done on a log scale, 1 to the haystack's size, with ticks at 2√N
  // (where the clever ones finish) and N/2 (where one by one does, on average); the hidden number a white line
  var DIAL = { brute: ['#f7931a', '#f4ce4a', 'keys'], bsgs: ['#00f6d2', '#00f6d2', 'steps'], kangaroo: ['#c39bff', '#c39bff', 'hops'] }, CELLS = 48;
  function draw(m) {
    var L = lanes[m], cv = L.cv, dpr = window.devicePixelRatio || 1, w = cv.clientWidth;
    if (!w) return;
    // the bitmap is resized only when the dial's size changes: resetting it on every frame cleared it to nothing
    // between frames, which showed as a blink on some screens; otherwise it is just wiped and redrawn
    var px = Math.round(w * dpr);
    if (cv.width !== px || cv.height !== px) { cv.width = px; cv.height = px; }
    var c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, w); c.globalAlpha = 1;
    var cx = w / 2, cy = w / 2, R = w / 2 - 8, RR = R * .86, D = DIAL[m];
    // which cells: covered (1) and the one being looked at (2)
    var cells = new Array(CELLS).fill(0), cur = -1, f;
    if (m === 'brute' && (L.ops || L.done)) { f = Math.min(1, L.pos); cur = Math.min(CELLS - 1, Math.floor(f * CELLS)); for (var i = 0; i < cur; i++) cells[i] = 1; }
    if (m === 'bsgs' && L.done && race) { f = Number((L.done.key - race.from) * 10000n / race.size) / 10000; cur = Math.min(CELLS - 1, Math.floor(f * CELLS)); for (i = 0; i < cur; i++) cells[i] = 1; } // its strides reached the number
    else if (m === 'bsgs' && (L.ops || L.done)) {
      if (L.pos < 0.5) cur = 0;
      else { f = Math.min(1, (L.pos - 0.5) * 2 * L.cover); cur = Math.min(CELLS - 1, Math.floor(f * CELLS)); for (i = 0; i < cur; i++) cells[i] = 1; }
    }
    if (m === 'kangaroo') L.marks.forEach(function (x, k) { if (x >= 0 && x <= 1) { var j = Math.min(CELLS - 1, Math.floor(x * CELLS)); cells[j] = 1; if (k === L.marks.length - 1) cur = j; } });
    if (cur >= 0) cells[cur] = 2;
    // the ring: each cell turned to face the centre, a flat side against its neighbour's
    var chord = 2 * RR * Math.sin(Math.PI / CELLS), r = (chord - 0.6) / Math.sqrt(3);
    for (i = 0; i < CELLS; i++) {
      var an = i / CELLS * Math.PI * 2 - Math.PI / 2, px = cx + RR * Math.cos(an), py = cy + RR * Math.sin(an), v = cells[i];
      c.beginPath(); for (var q = 0; q < 6; q++) { var va = an + Math.PI / 3 * q; c.lineTo(px + r * Math.cos(va), py + r * Math.sin(va)); } c.closePath();
      c.globalAlpha = v === 2 ? 1 : v === 1 ? .55 : .07; c.fillStyle = v === 2 ? D[0] : v === 1 ? D[1] : '#fff'; c.fill();
    }
    c.globalAlpha = 1;
    // the work arc, 270° from the bottom left
    var bits = race ? Math.log2(Number(race.size)) : 32, lg = function (v) { return Math.max(0, Math.min(1, Math.log2(Math.max(1, v)) / bits)); };
    var AR = R * .66, a0 = Math.PI * .75, span = Math.PI * 1.5;
    c.lineCap = 'round'; c.lineWidth = 6; c.strokeStyle = 'rgba(255,255,255,.1)'; c.beginPath(); c.arc(cx, cy, AR, a0, a0 + span); c.stroke();
    if (L.ops) { c.strokeStyle = D[0]; c.beginPath(); c.arc(cx, cy, AR, a0, a0 + span * lg(L.ops) + .001); c.stroke(); }
    c.lineCap = 'butt';
    [bits / 2 + 1, bits - 1].forEach(function (b) { var an = a0 + span * b / bits; c.strokeStyle = 'rgba(255,255,255,.6)'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(cx + (AR - 6) * Math.cos(an), cy + (AR - 6) * Math.sin(an)); c.lineTo(cx + (AR + 6) * Math.cos(an), cy + (AR + 6) * Math.sin(an)); c.stroke(); });
    var fs = Math.max(11, Math.round(w / 12));
    c.textAlign = 'center'; c.fillStyle = '#fff'; c.font = '600 ' + fs + 'px ' + (css.getPropertyValue('--font-mono') || 'monospace');
    var big = L.ops ? short(L.ops) : '0', mono = (css.getPropertyValue('--font-mono') || 'monospace'); // always short (885K, 15.4B): a word that came and went made the dial blink
    // fits inside the arc: smaller, then short (981K) on a narrow dial
    while (fs > 9 && c.measureText(big).width > AR * 1.5) { fs--; c.font = '600 ' + fs + 'px ' + mono; }
    c.fillText(big, cx, cy + fs * .3);
    c.fillStyle = 'rgba(255,255,255,.5)'; c.font = Math.round(fs * .62) + 'px ' + (css.getPropertyValue('--font-mono') || 'monospace'); c.fillText(L.ff ? '⏩ ' + D[2] : D[2], cx, cy + fs * 1.3);
    // the hidden number, once shown
    if (race && race.reveal) {
      var sf = Number((race.secret - race.from) * 10000n / race.size) / 10000, sa = sf * Math.PI * 2 - Math.PI / 2;
      c.strokeStyle = '#fff'; c.lineWidth = 2; c.beginPath(); c.moveTo(cx + (RR - 9) * Math.cos(sa), cy + (RR - 9) * Math.sin(sa)); c.lineTo(cx + (RR + 9) * Math.cos(sa), cy + (RR + 9) * Math.sin(sa)); c.stroke();
    }
  }
  // the three heads over the dials as tall as the tallest one (a name or a note may wrap on a narrow screen), so the
  // dials stay level without room kept for lines that are not there
  function levelHeads() {
    var hs = [].slice.call(document.querySelectorAll('.lane-h'));
    hs.forEach(function (h) { h.style.minHeight = ''; });
    var mx = Math.max.apply(null, hs.map(function (h) { return h.offsetHeight; }));
    hs.forEach(function (h) { h.style.minHeight = mx + 'px'; });
  }
  levelHeads(); onResize(levelHeads);
  function drawAll() { Object.keys(lanes).forEach(draw); }
  onResize(drawAll);

  // under each dial: a status line, then a few short label / value rows (the count itself is on the dial)
  function short(x) { return P.words(x).replace(/ thousand/, 'K').replace(/ million/, 'M').replace(/ billion/, 'B').replace(/ trillion/, 'T'); }
  function laneText(m, status, rows) {
    // built once, then only the texts that changed are touched: a new status (or a row that was not there) fades
    // in as in the wallet; a value that changes is just rewritten, nothing else moves or blinks
    var el = $('v-' + m);
    if (!el.firstChild) el.innerHTML = '<div class="lv-st"></div>';
    var st = el.firstChild;
    if (st.textContent !== status) { st.textContent = status; fadeIn(st); }
    rows = rows || [];
    for (var i = 0; i < rows.length; i++) {
      var r = el.children[i + 1];
      if (!r) { r = document.createElement('div'); r.className = 'lv-r'; r.innerHTML = '<span></span><b></b>'; el.appendChild(r); fadeIn(r); }
      if (r.firstChild.textContent !== rows[i][0]) { r.firstChild.textContent = rows[i][0]; r.classList.toggle('lv-speed', rows[i][0] === 'speed' || rows[i][0] === 'expected'); }
      if (r.lastChild.textContent !== rows[i][1]) r.lastChild.textContent = rows[i][1];
    }
    while (el.children.length > rows.length + 1) el.lastChild.remove();
  }
  function fadeIn(e) { e.classList.remove('lv-in'); void e.offsetWidth; e.classList.add('lv-in'); }

  function go() {
    stopAll();
    var on = document.querySelector('#r-size button.on'), bits = on ? Number(on.getAttribute('data-b')) : 36;
    $('r-after').classList.add('pending');
    var from = 1n << BigInt(bits - 1), to = (1n << BigInt(bits)) - 1n, size = to - from + 1n;
    var r = new Uint32Array(2); crypto.getRandomValues(r);
    var secret = from + ((BigInt(r[0]) << 32n) | BigInt(r[1])) % size;
    var pt = S.mulG(secret), pub = [pt[0].toString(16), pt[1].toString(16)];
    race = { from: from, to: to, size: size, secret: secret, reveal: false, finished: 0, t0: performance.now() };
    var m2 = 1n; while (m2 * m2 < size) m2 <<= 1n;
    Object.keys(lanes).forEach(function (m) { lanes[m].pos = 0; lanes[m].ops = 0; lanes[m].realOps = lanes[m].realSec = 0; lanes[m].marks = []; lanes[m].done = null; lanes[m].cover = Number(m2 * m2 * 1000n / size) / 1000; $('v-' + m).innerHTML = ''; });
    $('r-secret').textContent = 'A number is hidden among ' + P.words(Number(size)) + ' keys.';
    $('r-go').disabled = true; $('r-stop').disabled = false;
    var base = { from: from.toString(16), to: to.toString(16) };
    var expect = 2 * Math.sqrt(Number(size));
    jobs.brute = P.cpuJob(Object.assign({ mode: 'brute', target: S.wordsToHex(S.hash160Words(pt[0], pt[1])) }, base), function (x, sec) {
      lanes.brute.pos = x.pos; lanes.brute.ops = x.ops;
      laneText('brute', 'searching', [['time', P.dur(sec)], ['speed', short(x.ops / sec) + '/s']]);
    });
    jobs.bsgs = P.cpuJob(Object.assign({ mode: 'bsgs', pub: pub }, base), function (x, sec) {
      lanes.bsgs.pos = x.pos; lanes.bsgs.ops = x.ops;
      laneText('bsgs', x.phase === 'baby' ? 'writing marks' : 'striding', [['time', P.dur(sec)], ['marks kept', short(x.mem)]]);
    });
    jobs.kangaroo = P.cpuJob(Object.assign({ mode: 'kangaroo', pub: pub, seed: r[0] }, base), function (x, sec) {
      lanes.kangaroo.ops = x.ops;
      x.marks.forEach(function (mk) { if (mk.tame && mk.at != null) lanes.kangaroo.marks.push(mk.at); });
      laneText('kangaroo', 'hopping', [['time', P.dur(sec)], ['footprints', String(x.dps)]]);
    });
    Object.keys(jobs).forEach(function (m) {
      var j = jobs[m];
      j.done.then(function (key) {
        if (key === undefined) return; // stopped
        var sec = j.seconds();
        lanes[m].done = { key: key, sec: sec };
        var ok = key === secret;
        var ops = lanes[m].ops, unit = m === 'brute' ? ' keys' : m === 'bsgs' ? ' steps' : ' hops';
        laneText(m, ok ? '✅ found' : '❌ not found', [['time', P.dur(sec)]].concat(m !== 'brute' ? [['expected', '~' + short(expect) + unit]] : []));
        race.finished++;
        if (lanes.bsgs.done && lanes.kangaroo.done) reveal();
      });
    });
    tickDraw();
  }
  function reveal() {
    if (race.reveal) return;
    race.reveal = true;
    $('r-secret').textContent = 'The number was 0x' + race.secret.toString(16) + ' (the white line).';
    // brute force gets three more seconds, then an estimate
    setTimeout(function () {
      if (lanes.brute.done || !jobs.brute) return finishRace();
      var sec = jobs.brute.seconds(), ops = lanes.brute.ops || 1, keysTo = Number(race.secret - race.from + 1n);
      jobs.brute.stop();
      lanes.brute.realSec = sec; lanes.brute.realOps = ops;
      var est = when(keysTo / (ops / sec)), L = lanes.brute, p0 = L.pos, o0 = ops, p1 = Number((race.secret - race.from) * 10000n / race.size) / 10000, t0 = performance.now(), run = race;
      // its time is how long reaching the number would really take at the speed it ran (the rest is fast-forwarded)
      var rowsB = [['time', est], ['speed', short(ops / sec) + '/s']];
      laneText('brute', '⏩ fast-forward', rowsB);
      // then a fast-forward to the number, clearly marked, so its dial too ends at the white line
      L.ff = true;
      (function ff() {
        if (race !== run) return;
        var k = Math.min(1, (performance.now() - t0) / 2500), e = 1 - Math.pow(1 - k, 3);
        L.pos = p0 + (p1 - p0) * e; L.ops = o0 + (keysTo - o0) * e; draw('brute');
        if (k < 1) requestAnimationFrame(ff); else { L.ff = false; laneText('brute', '⏩ fast-forwarded', rowsB); }
      })();
      finishRace();
    }, 3000);
  }
  // the race's lesson, scaled up: one by one through the target puzzle at this device's own measured speed
  function finishRace() {
    $('r-go').disabled = false; $('r-stop').disabled = true; drawAll();
    // the speed one by one really ran at: measured when it was stopped (before the fast-forward moves its count) or
    // when it found the number itself; not the clock afterwards, nor the fast-forward's count
    var B = lanes.brute, sec = B.realSec || (B.done ? B.done.sec : jobs.brute ? jobs.brute.seconds() : 0), ops = B.realOps || B.ops || 0, n = (data && data.target) || 71;
    if (sec > 0.5 && ops > 0) {
      // an info card, as the key machine's: the puzzle links to its page, the pool to the pool
      var p = data && data.puzzles[n - 1], pz = '<a href="/puzzle/' + n + '"' + (p ? ' title="' + esc(p.address) + '"' : '') + '>Puzzle #' + n + '</a>';
      $('r-after').innerHTML = '<span class="key-info-badge" aria-hidden="true">i</span>On this device, checking one by one through ' + pz + ' would take <b>' + esc(when(Math.pow(2, n - 1) / 2 / (ops / sec))) + '</b> for an even chance. That is why <a href="/pool">a pool</a> splits the range across many browsers.';
      $('r-after').classList.remove('pending');
    }
  }
  function stopAll() { Object.keys(jobs).forEach(function (m) { jobs[m].stop(); }); jobs = {}; }
  function tickDraw() {
    if (!$('r-go')) return; // another page shown meanwhile (nav.js)
    drawAll();
    if (!$('r-go').disabled) return;
    requestAnimationFrame(function () { setTimeout(tickDraw, 80); });
  }
  $('r-go').addEventListener('click', go);
  // another page shown in place of this one (nav.js): the race ends
  window.addEventListener('bb:leave', function () { stopAll(); clearInterval(hist.timer); offs.forEach(function (f) { f(); }); }, { once: true });
  $('r-stop').addEventListener('click', function () { var b = jobs.brute; if (race) race.reveal = true; $('r-secret').textContent = race ? 'The number was 0x' + race.secret.toString(16) + ' (the white line).' : ''; finishRace(); stopAll(); void b; });
  document.querySelectorAll('#r-size button').forEach(function (b) {
    b.addEventListener('click', function () { document.querySelectorAll('#r-size button').forEach(function (x) { x.classList.toggle('on', x === b); }); });
  });
  drawAll();

  // ---------- 5. your odds ----------
  // brute force: the key is uniform in a range of 2^(n-1) keys, so p = keys checked / range.
  // kangaroo with a known public key: expected 2.08·√range jumps; P(found by x expected runs) ≈ 1 - exp(-π/4·x²).
  // The RTX 4090's brute-force rate is the home page's yardstick too (its speedometer mark, the target text).
  function odds(data) {
    if (!$('odds') || !window.BB || !BB.dropdown) return;
    var DEVICES = [
      { id: 'browser', label: 'Browser tab', bf: 3e7, kg: 6e7, w: 150 },
      { id: 'r3090', label: 'RTX 3090', bf: 2.5e9, kg: 3e9, w: 350 },
      { id: 'r4090', label: 'RTX 4090', bf: 5e9, kg: 6e9, w: 450 },
      { id: 'custom', label: 'My own number', bf: null, kg: null, w: 300 },
    ];
    function fmtBtc(x) { return x >= 100 ? x.toFixed(0) : x >= 1 ? (Math.round(x * 100) / 100).toString() : (Math.round(x * 1e4) / 1e4).toString(); }
    function fmtInt(x) { return Math.round(x).toLocaleString('en-US'); }
    function sup(n) { return String(n).split('').map(function (c) { return '⁰¹²³⁴⁵⁶⁷⁸⁹'['0123456789'.indexOf(c)] || c; }).join(''); }
    function sci(x) {
      if (!isFinite(x)) return '∞';
      if (x < 1e4) return x >= 100 ? fmtInt(x) : (Math.round(x * 100) / 100).toString();
      var e = Math.floor(Math.log10(x)), m = x / Math.pow(10, e);
      return m.toFixed(2).replace(/\.?0+$/, '') + ' × 10' + sup(e);
    }
    function chance(p) { return p >= 0.995 ? '≈100%' : p >= 1e-3 ? (Math.round(p * 1000) / 10) + '%' : p <= 0 ? '0' : '1 in ' + P.words(1 / p); }
    function calcOdds(n, kangaroo, keysPerSec, seconds) {
      var range = Math.pow(2, n - 1);
      if (!kangaroo) return { p: Math.min(1, keysPerSec * seconds / range), half: range * 0.5 / keysPerSec };
      var e = 2.08 * Math.sqrt(range), x = keysPerSec * seconds / e;
      return { p: 1 - Math.exp(-Math.PI / 4 * x * x), half: e * Math.sqrt(Math.log(2) * 4 / Math.PI) / keysPerSec };
    }
    var dds = {};
    function dd(id) {
      if (!dds[id]) dds[id] = BB.dropdown($(id), function (v) { if (id === 'c-device' && v === 'custom') { calc(); $('c-speed').focus(); } else onDevice(); });
      return dds[id];
    }
    function ddv(id) { return dd(id).value(); }
    function cur() { return data.puzzles[Number(ddv('c-puzzle')) - 1]; }
    function num(id) { var v = Number(String($(id).value).replace(',', '.').replace(/\s/g, '')); return isFinite(v) && v >= 0 ? v : 0; }
    function device() { return DEVICES.filter(function (x) { return x.id === ddv('c-device'); })[0]; }
    function onDevice() {
      var d = device(), p = cur(), s = d && d.bf ? (p && p.exposed ? d.kg : d.bf) : null;
      if (s) $('c-speed').value = s.toExponential().replace('+', '');
      $('c-watts').value = d.w;
      calc();
    }
    function calc() {
      var p = cur();
      if (!p) return;
      var kg = !!p.exposed, count = Math.max(1, Math.floor(num('c-count')));
      var speed = num('c-speed') * count, hours = Math.min(24, num('c-hours')), days = Math.max(1, num('c-days'));
      var o = calcOdds(p.n, kg, speed, days * hours * 3600);
      var evBtc = o.p * p.balance, evUsd = evBtc * (data.btc_usd || 0);
      var kwh = num('c-watts') * count * hours * days / 1000, cost = kwh * num('c-kwh');
      var tiles = [
        ['Chance to find it', chance(o.p), 'in ' + fmtInt(days) + ' days, ' + (kg ? 'kangaroo' : 'brute force'), true],
        ['Time to an even chance', speed > 0 ? when(o.half * 24 / Math.max(hours, 0.01)) : 'forever', 'at ' + P.words(speed) + ' keys a second'],
        ['Expected win', evBtc >= 0.001 ? fmtBtc(evBtc) + ' BTC' : evBtc * 1e8 >= 1 ? fmtInt(evBtc * 1e8) + ' sat' : '≈ 0', data.btc_usd ? '≈ $' + (evUsd >= 1 ? fmtInt(evUsd) : (Math.round(evUsd * 100) / 100).toString()) + ' (chance × prize)' : 'chance × prize'],
        ['Electricity', '$' + fmtInt(cost), fmtInt(kwh) + ' kWh'],
      ];
      var TIP = { 'Expected win': 'Your chance times the prize. Over many tries, this is what the search is worth on average, if nobody beats you to it.' };
      $('c-out').innerHTML = tiles.map(function (t) { return '<div class="tile"><div class="k">' + (TIP[t[0]] ? '<span class="tipped" title="' + esc(TIP[t[0]]) + '">' + esc(t[0]) + '</span>' : esc(t[0])) + '</div><div class="v' + (t[3] ? ' accent' : '') + '">' + esc(t[1]) + '</div><div class="s">' + esc(t[2]) + '</div></div>'; }).join('');
      var v = $('c-verdict');
      if (cost > 0 && evUsd > 0) {
        var bad = cost >= evUsd, r = bad ? cost / evUsd : evUsd / cost, rs = r >= 1e4 ? sci(r) : fmtInt(r);
        v.className = 'calc-verdict ' + (bad ? 'warn' : 'ok');
        v.innerHTML = bad ? 'The electricity costs about <b>' + rs + ' times</b> what this search is expected to win. Treat it like a lottery ticket. Play for the fun of it, never as an investment.'
          : 'The expected win is about <b>' + rs + '×</b> the electricity. Mind the race: whoever broadcasts the transaction of a found key to the public mempool can be outbid by bots that read the key from it.';
        v.hidden = false;
      } else v.hidden = true;
    }
    odds.calc = calc;
    var open = data.puzzles.filter(function (p) { return p.status === 'open'; });
    dd('c-device').options(DEVICES.map(function (d) { return { v: d.id, label: d.label }; }), 'browser');
    dd('c-puzzle').options(open.map(function (p) { return { v: p.n, label: '#' + p.n + ', ' + fmtBtc(p.balance) + ' BTC' + (p.exposed ? ', kangaroo' : '') }; }), String(data.target || (open[0] && open[0].n)));
    ['c-speed', 'c-count', 'c-hours', 'c-days', 'c-watts', 'c-kwh'].forEach(function (id) { $(id).addEventListener('input', calc); });
    // from the benchmark: /learn?speed=<keys a second>#odds
    var qs = Number(new URLSearchParams(location.search).get('speed'));
    if (qs > 0) { dd('c-device').set('custom'); $('c-speed').value = qs.toExponential(2).replace('+', ''); $('c-watts').value = 200; calc(); }
    else onDevice();
    if (location.hash === '#odds') $('odds').scrollIntoView();
  }
})();
