/* /pool: the shared search. Lease a piece from /api/pool, search it on the GPU with the puzzle's target and the
   piece's check keys, report the check keys, repeat. A hit on the puzzle's own target stops everything and hands
   the key to found.js, which commits to it, sends the split through MARA Slipstream and only then tells the
   pool. A payout address is required: it is in the commitment and the transactions from the first second.

   Two parts. The search lives in this page for as long as the tab does: while it runs, nav.js moves between the
   site's pages without leaving this one, so the work goes on. A searcher's page (/pool/<address>, searcher.html)
   is attached each time it is shown: run again, this script only re-attaches. On your own page (the address this
   browser searches under) it shows your numbers, the search and your invite; on someone else's, their numbers
   only. The pool's own page (/pool) is pooldash.js. */
(function () {
  'use strict';
  if (window.BBPool) { window.BBPool.attach(); return; }
  var P = window.BBP, S = P.S, T = window.BBTx;
  // an element of the /pool page, or a stand-in while another page is shown (writes go nowhere)
  var NONE = document.createElement('div');
  function $(id) { return document.getElementById(id) || NONE; }
  function onPool() { return !!document.getElementById('j-start'); }
  var esc = window.BB.esc; // ui/components/bb.js
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) { /* no storage */ } return null; }
  var short = window.BB.short;
  var log = P.logTo($('r-log'));
  // a refusal by the server carries .refused (asking again changes nothing); a network failure or a 5xx does not
  function post(path, body) {
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (r.ok) return j;
          var err = new Error(j.error || r.status); err.refused = r.status < 500; throw err;
        });
      });
  }

  // ---------- whose page ----------
  var stats = null;
  // pageAddr: the address in the path; mode: own or other, as head.js set it on <html data-pool>
  var pageAddr = null, mode = null;
  // the address searched under: on your own page its address, on someone else's none (and so no search)
  function addr() { return mode === 'own' ? pageAddr : null; }

  // ---------- invite: link + QR ----------
  var invBlob = null; // the QR code as a png file, for Share
  function inviteLink(a) { return location.origin + '/pool?ref=' + encodeURIComponent(a); }
  function invite() {
    var a = addr();
    if (!a) { $('inv-qr').innerHTML = ''; $('inv-link').textContent = ''; return; }
    var link = inviteLink(a);
    $('inv-link').textContent = link;
    invBlob = null;
    if (!window.BB || !BB.qr || !onPool()) return;
    qrLib().then(function () {
      if (inviteLink(addr() || '') !== link || !onPool()) return; // another page meanwhile
      // ui's QR code (ui/components/qr.js, the wallet's Receive card): the chain's colours, our logo in the middle
      BB.qr($('inv-qr'), link, BB.qrSizes.s);
      // the png made now, so Share has its file at the tap (a phone allows sharing only straight from the tap)
      BB.qrBlob(link, $('inv-qr')).then(function (b) { if (inviteLink(addr() || '') === link) invBlob = new File([b], 'bumblebeam-puzzle-invite.png', { type: 'image/png' }); }).catch(function () { /* Share sends the words */ });
    }, function () { $('inv-qr').textContent = 'QR code unavailable'; });
  }
  // the QR library (48 KB) is loaded only where an invite is shown, your own page, with the page's own version
  var qrP = null;
  function qrLib() {
    if (window.QRCodeStyling) return Promise.resolve();
    if (!qrP) qrP = new Promise(function (ok, no) {
      var mine = document.querySelector('script[src*="/ui/components/qr.js"]'), v = mine ? mine.getAttribute('src').replace(/^[^?]*/, '') : '';
      var s = document.createElement('script');
      s.src = '/ui/vendor/qr-code-styling.js' + v; s.onload = ok; s.onerror = function () { qrP = null; no(new Error('no QR library')); };
      document.head.appendChild(s);
    });
    return qrP;
  }

  // ---------- the searcher's numbers: the tiles at the top and the badges ----------
  var BADGES = [
    ['keys', 1e9, 'a billion keys'], ['keys', 1e10, '10 billion'], ['keys', 1e11, '100 billion'], ['keys', 1e12, 'a trillion keys'],
    ['chunks', 1, 'first piece'], ['chunks', 10, '10 pieces'], ['chunks', 100, '100 pieces'], ['chunks', 1000, '1,000 pieces'],
    ['refs', 1, 'first invite'], ['refs', 10, '10 invited'], ['refs', 100, '100 invited'],
  ];
  // a tile's value: the first one fades in over the honeycomb loader (ui's .bb-wait, .bb-fade), later ones just change
  function put(id, text) {
    var el = $(id), first = !!el.querySelector('.bb-wait');
    if (el.textContent !== text || first) el.textContent = text;
    if (first) { el.classList.remove('bb-fade'); void el.offsetWidth; el.classList.add('bb-fade'); }
  }
  // a date in the viewer's own time (kept in UTC): 20.11.2026
  function day(t) { var d = new Date(t * 1000), two = function (n) { return (n < 10 ? '0' : '') + n; }; return two(d.getDate()) + '.' + two(d.getMonth() + 1) + '.' + d.getFullYear(); }
  function ago(t) {
    var x = Math.max(0, Date.now() / 1000 - t);
    return x < 60 ? 'just now' : x < 3600 ? Math.floor(x / 60) + ' min ago' : x < 86400 ? Math.floor(x / 3600) + ' h ago' : Math.floor(x / 86400) + ' d ago';
  }
  function me() {
    if (!onPool() || !pageAddr) return;
    var a = pageAddr;
    P.get('/api/pool/me?addr=' + encodeURIComponent(a)).then(function (m) {
      if (a !== pageAddr) return; // another page meanwhile
      put('m-rank', m.rank ? '#' + m.rank : 'not yet'); $('m-rank-s').textContent = m.rank ? 'by keys checked' : 'after the first piece';
      put('m-keys', P.sci(m.keys)); $('m-keys-s').textContent = m.first ? 'since ' + day(m.first) : 'no piece finished yet';
      put('m-pieces', P.int(m.chunks)); $('m-pieces-s').textContent = m.last && m.chunks ? 'last on ' + day(m.last) : '\u00a0';
      put('m-refs', P.int(m.refs)); $('m-refs-s').textContent = m.refs ? P.sci(m.ref_keys) + ' keys by them' : 'nobody yet';
      // the referrals: who came through this address's link, with their numbers
      var R = m.referrals || [];
      $('ref-meta').textContent = R.length ? R.length + ' invited | ' + P.sci(m.ref_keys) + ' keys by them' : 'your link carries your address';
      $('ref-rows').innerHTML = R.length ? R.map(function (r) {
        return '<tr><td><a class="mono" href="/pool/' + encodeURIComponent(r.addr) + '" title="' + esc(r.addr) + '">' + esc(short(r.addr)) + '</a></td><td class="num">' + (r.chunks ? P.sci(r.keys) : '<span class="dim">no piece yet</span>') + '</td><td class="num">' + P.int(r.chunks) + '</td><td class="dim">' + day(r.first) + '</td><td class="dim">' + ago(r.last) + '</td></tr>';
      }).join('') : '<tr><td colspan="5" class="dim">Nobody yet: share your link or the QR code.</td></tr>';
      // only on your own page does the search panel say who invited you, as the server has it
      $('j-ref').textContent = mode === 'own' && m.ref ? 'invited by ' + m.ref : '';
      $('me-badges').innerHTML = BADGES.map(function (b) { var ok = (m[b[0]] || 0) >= b[1]; return '<span class="badge ' + (ok ? 'ok' : 'dimmed') + '">' + esc(b[2]) + '</span>'; }).join('');
    }).catch(function () { if (a === pageAddr && window.BBNoData) window.BBNoData($('me-tiles')); }); // the API is down: dashes, not loaders
  }
  // the pool's numbers the search needs: the prize's split for the log, the pool's address for a claim
  function refresh() { P.get('/api/pool').then(function (s) { stats = s; }).catch(function () { /* later */ }); }

  // ---------- the run's view: kept here, painted onto /pool whenever it is shown ----------
  var view = { gpu: '', piece: '', range: 'press Start', rate: '', done: '0 pieces', keys: '\u00a0', bar: 0 };
  var WAIT = '<span class="bb-wait"><i></i><i></i><i></i></span>';
  // a run value: text, or while the search starts (running, nothing yet) the honeycomb loader, else a blank
  function val(id, text) {
    var el = $(id), want = text ? 'text' : running ? 'wait' : 'blank', had = el.dataset.v || '';
    if (text) {
      if (el.textContent !== text) el.textContent = text;
      if (had !== 'text') { el.classList.remove('bb-fade'); void el.offsetWidth; el.classList.add('bb-fade'); } // the first value fades in
    } else if (had !== want) el.innerHTML = want === 'wait' ? WAIT : '&nbsp;';
    el.dataset.v = want;
  }
  function paint() {
    // only on the searcher's page: another page (/play) has elements of the same names, its own
    if (!onPool()) { cta(); return; }
    var busy = running || !!winData;
    // no WebGPU: Start is off and its tip says why (the pool searches on the graphics card only); not your own
    // page: off too (its panel is not shown)
    $('j-start').disabled = busy || !P.hasGpu() || !addr(); $('j-start').title = !addr() ? 'Searching needs your payout address: add it on the Pool page.' : P.hasGpu() ? '' : P.noGpuWhy();
    $('j-stop').disabled = !running;
    $('r-gpu').textContent = view.gpu || '\u00a0';
    val('r-piece', view.piece); $('r-range').textContent = view.range;
    val('r-rate', view.rate);
    $('r-done').textContent = view.done; $('r-keys').textContent = view.keys;
    barKick();
    $('j-dot').classList.toggle('on', running);
    cta();
  }
  function set(k, v) { view[k] = v; paint(); }
  // the piece's bar, drawn frame by frame: it glides to each new value instead of stepping from one report of the
  // engine to the next; a kept piece fills up to where it stopped in a second, easing in and out; a new piece starts from 0 at once
  var bar = { shown: 0, from: 0, t0: 0, dur: 0, raf: 0 };
  function barFill(ms) { bar.from = bar.shown; bar.t0 = performance.now(); bar.dur = ms; barKick(); }
  function barKick() { if (!bar.raf) bar.raf = requestAnimationFrame(barTick); }
  function barTick() {
    bar.raf = 0;
    if (!onPool()) return;
    var target = view.bar, now = performance.now();
    if (target < bar.shown - 0.5) { bar.shown = target; bar.dur = 0; }
    else if (bar.dur && now - bar.t0 < bar.dur) { var t = (now - bar.t0) / bar.dur; bar.shown = bar.from + (target - bar.from) * (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(2 - 2 * t, 3) / 2); }
    else { bar.dur = 0; bar.shown += (target - bar.shown) * 0.15; if (Math.abs(target - bar.shown) < 0.02) bar.shown = target; }
    $('r-bar').style.width = bar.shown + '%';
    if (bar.shown !== target || bar.dur) barKick();
  }
  // the header's Start button says a search runs, on every page (no percent: the piece's bar shows that)
  var ctaPct = -1;
  function cta() {
    var b = document.querySelector('.top .cta-top');
    if (!b) return;
    var t = running ? 'Searching' : winData ? '★ Your key' : 'Start puzzle';
    if (b.textContent !== t) b.textContent = t;
  }

  // ---------- the live line of your speed (as on /bench): the speed over the last half second, a point a second,
  // the last ten minutes on one axis of the session's time, a dotted line where each new piece begins ----------
  var live = { pts: [], marks: [], t0: 0 };
  function liveStart() { live = { pts: [], marks: [], t0: performance.now() }; drawLive(); }
  function liveFeed(mark) {
    var hist = [];
    return function (keys, sec) {
      hist.push([sec, keys]);
      while (hist.length > 2 && sec - hist[1][0] >= 0.5) hist.shift();
      var now = (performance.now() - live.t0) / 1000, last = live.pts.length ? live.pts[live.pts.length - 1][0] : -1;
      if (hist.length < 2 || sec - hist[0][0] < 0.3 || now - last < 1) return;
      var r = (keys - hist[0][1]) / (sec - hist[0][0]);
      if (!isFinite(r) || r <= 0) return;
      live.pts.push([now, r]);
      if (mark) { live.marks.push([now, mark]); mark = null; }
      while (live.pts.length && live.pts[0][0] < now - 600) live.pts.shift();
      live.marks = live.marks.filter(function (m) { return m[0] >= live.pts[0][0]; });
      drawLive();
    };
  }
  function clock(t) { t = Math.round(t); return t < 60 ? t + ' s' : Math.floor(t / 60) + ':' + ('0' + t % 60).slice(-2); }
  function drawLive() {
    if (!onPool() || !window.BBCharts) return;
    var box = $('j-chart');
    if (live.pts.length < 2) { box.innerHTML = BBCharts.frame(running ? 'starting…' : 'press Start to see your speed here', { labelChars: 8 }); box.dataset.on = ''; return; }
    if (!box.dataset.on) { box.classList.remove('bb-fade'); void box.offsetWidth; box.classList.add('bb-fade'); box.dataset.on = '1'; } // the line comes in softly, once
    box.innerHTML = BBCharts.line(live.pts, { label: function (v) { return P.rate(v, ' ').trim(); }, xLabel: clock, peak: true, marks: live.marks, labelChars: 8, title: 'Your speed' });
  }
  // the card found: its standard name (engine/gpuname.js) on its own line under the form, the browser's words on hover
  var gpuSeen = '';
  function seen(name) { if (name) gpuSeen = name; device(); }
  function device() {
    var el = $('j-dev');
    if (!P.hasGpu()) { el.textContent = 'No WebGPU in this browser: the pool searches on the graphics card'; return; }
    var n = gpuSeen && window.BBGpuName && BBGpuName.of(gpuSeen, navigator.userAgent);
    el.innerHTML = 'Graphics card: <b>' + esc(n ? n.name : gpuSeen || 'looking…') + '</b>' + (n && !n.sure ? ' (not sure)' : '');
    el.title = gpuSeen ? 'The browser says: ' + gpuSeen : '';
  }
  if (P.hasGpu()) navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).then(function (a) { if (!gpuSeen) seen(a ? P.gpuName({ info: a.info || {} }) : 'none found'); }).catch(function () { if (!gpuSeen) seen('none found'); });

  // ---------- the loop ----------
  // runId: each Start gets its own number, so a loop left over from an earlier Start (still awaiting the GPU or
  // the server) sees it is stale and ends, giving back any piece it holds, instead of running beside the new one
  var runId = 0;
  var running = false, current = null, lease = null, frac = 0, session = { pieces: 0, keys: 0, t0: 0, started: 0 }, winData = null, engine = null;
  // the next piece, asked for once the current one is half done, so the GPU goes straight on when it ends (no idle
  // gap for the report, the lease and the setup, which also lets a laptop GPU drop its clock): { p, L, err }
  var next = null;
  function askNext() {
    var n = { L: null, err: null };
    n.p = post('/api/pool/lease', { addr: runAddr, ref: store('bb-ref') }).then(function (L) { n.L = L; return n; }, function (e) { n.err = e; return n; });
    return n;
  }
  // a next piece not started goes back to the pool (Stop, a find, leaving)
  function dropNext() {
    var n = next; next = null;
    if (n) n.p.then(function () { if (n.L) post('/api/pool/release', { lease: n.L.lease }).catch(function () {}); });
  }
  // a finished piece is reported while the next one is searched; a network failure is tried again (three times)
  function report(L, checks, rate, pieceNo, resumed, took) {
    var tries = 0;
    (function again() {
      post('/api/pool/report', { lease: L.lease, keys: checks, rate: rate }).then(function () {
        session.pieces++; session.keys += L.keys;
        view.done = session.pieces + (session.pieces === 1 ? ' piece' : ' pieces'); view.keys = P.sci(session.keys) + ' keys'; paint();
        log('✓ Piece ' + pieceNo + ' done' + (resumed ? '' : ' in ' + P.dur(took)) + ' at ' + P.rate(rate) + ', credited. ' + odds() + '.');
        me(); refresh();
      }, function (err) {
        if (!err.refused && ++tries < 3) { setTimeout(again, 5000 * tries); return; }
        log('✗ Report of piece ' + pieceNo + ': ' + err.message);
      });
    })();
  }
  // the honest odds of this session: keys checked against the whole range
  function odds() {
    var range = Math.pow(2, ((stats && stats.puzzle) || 71) - 1);
    return 'Odds this session: 1 in ' + P.words(range / Math.max(1, session.keys));
  }
  // ---------- a stopped piece is kept: Stop (or closing the tab) keeps the lease and where the search stands, in
  // this browser, and the next Start continues it, as long as the lease lasts and the address is the same ----------
  var piece = null; // the piece being searched: { L, pos, pct, checks }
  // Several tabs of this browser may each keep a piece: a list by lease ('bb-pieces'; 'bb-piece' was one), and a
  // Start takes one out, so two tabs never continue the same piece
  function keptList() {
    var list = [];
    try { list = JSON.parse(store('bb-pieces') || '[]'); } catch (_) { list = []; }
    var one = null;
    try { one = JSON.parse(store('bb-piece') || 'null'); } catch (_) { one = null; }
    if (one) { store('bb-piece', null); list.push(one); }
    return list.filter(function (k) { return k && k.L && k.pos && Array.isArray(k.checks); });
  }
  function keptSave(list) { store('bb-pieces', list.length ? JSON.stringify(list) : null); }
  function keepOne(k) { keptSave(keptList().filter(function (x) { return x.L.lease !== k.L.lease; }).concat([k])); }
  function dropKept(lease) { keptSave(keptList().filter(function (x) { return x.L.lease !== lease; })); }
  function keep() {
    if (!piece || !piece.pos) return false;
    keepOne({ L: piece.L, pos: piece.pos, pct: piece.pct || 0, checks: piece.checks, addr: runAddr || '' });
    return true;
  }
  // a kept piece of this address, taken out of the list; ones run out go back to the pool
  function kept() {
    var list = keptList(), mine = null, now = Date.now() / 1000;
    list = list.filter(function (k) {
      if (k.L.expires < now + 120) { post('/api/pool/release', { lease: k.L.lease }).catch(function () {}); return false; }
      if (!mine && k.addr === (runAddr || '')) { mine = k; return false; }
      return true;
    });
    keptSave(list);
    return mine;
  }
  // the finder's part of the current prize, from the pool's stats: '6 of 7.1 BTC'
  function split() { return stats && stats.prize_btc ? stats.finder_btc + ' of ' + stats.prize_btc + ' BTC' : '6 of 7.1 BTC'; }
  function hhmm(t) { var d = new Date(t * 1000); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }

  var runAddr = null; // the address of the running search, fixed at Start
  async function start() {
    if (running) return;
    var my = ++runId;
    function stale() { return !running || my !== runId; }
    if (mode === 'other') { running = false; return; } // someone else's page has no search
    runAddr = addr();
    // the payout address goes into the commitment and the transactions the moment the key is found: no search
    // without one
    if (!runAddr) { running = false; log('✗ Searching needs your payout address: enter it on the Pool page and press Start there.'); return; }
    if (!P.hasGpu()) { log('✗ No WebGPU here, and the pool searches on the graphics card (on a CPU one piece would take hours). ' + P.noGpuWhy()); return; }
    running = true; ctaPct = -1;
    // the bar stays where it was until the piece is known: a new one starts it from 0, a kept one fills up to
    // where it stopped, softly
    view.piece = ''; view.rate = ''; view.range = 'starting'; liveStart(); paint();
    var e;
    try { e = await P.gpuQuiet(log); } catch (err) { log('✗ ' + (err.message || err)); if (!stale()) stop(); return; }
    if (stale()) return;
    engine = e;
    seen(P.gpuName(e)); set('gpu', (2 * e.K + 1) + ' keys a step'); // the card on its own line, the engine's shape here
    log('Searching for ' + short(runAddr) + '. If your piece holds the key, ' + split() + ' go to this address, sent by this page itself.');
    session = { pieces: 0, keys: 0, t0: performance.now(), started: 0 };
    view.done = '0 pieces'; view.keys = ' '; paint();
    while (!stale()) {
      var got, resume = kept(), ask = null, nx = next;
      next = null;
      // a piece asked for ahead that waited too long (a long pause): back to the pool, a fresh one instead
      if (nx && nx.L && nx.L.expires < Date.now() / 1000 + 600) { next = nx; dropNext(); nx = null; }
      if (resume) { got = resume.L; if (nx) { next = nx; dropNext(); } }
      else try {
        // the piece asked for ahead, or now; the line shows only while it is awaited
        if (!nx || (!nx.L && !nx.err)) ask = log.busy('Asking the pool for a piece');
        got = nx ? await nx.p.then(function (n) { if (n.err) throw n.err; return n.L; }) : await post('/api/pool/lease', { addr: runAddr, ref: store('bb-ref') });
        if (ask) ask.done();
      } catch (err) {
        if (!ask) ask = log.busy('');
        // the key was found (by anyone in the pool): the search is paused, nothing to try again
        if (/key was found/.test(err.message)) { ask.done('★ ' + err.message + '.'); stop(); return; }
        ask.done('✗ No piece: ' + err.message + '.');
        var wait = log.busy('Trying again in 30 s');
        await new Promise(function (r) { setTimeout(r, 30000); });
        wait.done();
        continue;
      }
      if (stale()) { if (!resume) post('/api/pool/release', { lease: got.lease }).catch(function () {}); else keepOne(resume); return; }
      lease = got;
      var L = lease, from = BigInt(L.from), to = BigInt(L.to), checks = resume ? resume.checks.slice() : [], won = null, t0 = performance.now(), lastRate = 0;
      // the server is not trusted with the target: it must be the puzzle's own address, built into the page
      var PZ = window.BBPuzzles;
      if (!PZ || L.address !== PZ.address(L.puzzle) || String(L.targets[0]).toLowerCase() !== PZ.hash160(L.puzzle)) {
        log('✗ The server sent a piece for an address that is not puzzle #' + L.puzzle + '’s. Stopped: please tell support@bumblebeam.org.');
        stop(); return;
      }
      if (resume) barFill(1000);
      else view.bar = 0;
      view.piece = P.sci(L.keys) + ' keys'; view.range = L.from.slice(0, 10) + '… of #' + L.puzzle; paint();
      var pieceNo = ++session.started, feed = liveFeed(pieceNo > 1 ? 'piece ' + pieceNo : '');
      piece = { L: L, pos: resume ? resume.pos : null, checks: checks };
      if (resume && resume.pos.done && e.shape && resume.pos.shape !== e.shape(from, to)) log('Piece ' + pieceNo + ': the piece you stopped, searched again from its start (the shape of the engine changed since, and its steps would leave keys out).');
      else if (resume) log('Piece ' + pieceNo + ': continuing the piece you stopped' + (resume.pct ? ' at ' + resume.pct + '%' : '') + '.');
      else log('Piece ' + pieceNo + ': ' + P.words(L.keys) + ' keys from ' + L.from.slice(0, 12) + '…, nobody else gets it.');
      // the heartbeat: every 5 s the server hears this browser is still searching, with its speed over those 5 s
      var lastPing = performance.now(), lastChecked = resume ? -1 : 0, gone = false, h = null;
      // a continued piece: tell the server at once that it is searched again
      if (resume) post('/api/pool/ping', { lease: L.lease, rate: 0 }).catch(function () {});
      var busy = log.busy('Searching piece ' + pieceNo);
      h = current = e.search(from, to, L.targets, function (x) {
        frac = Number(x.checked) / Number(x.total);
        if (frac >= 0.5 && !next && lease === L && !stale()) next = askNext();
        if (lease === L) { piece.pos = x.pos; piece.pct = Math.floor(frac * 100); }
        if (x.rate > 0) lastRate = x.rate;
        busy.set('Searching piece ' + pieceNo + ': ' + Math.floor(frac * 100) + '%' + (x.rate > 0 && frac > 0.01 ? ', about ' + P.dur(Number(x.total - x.checked) / x.rate) + ' left' : ''));
        var tn = performance.now();
        if (tn - lastPing >= 5000 && lease === L) {
          var c = Number(x.checked), r = lastChecked < 0 ? x.rate : (c - lastChecked) / ((tn - lastPing) / 1000);
          lastPing = tn; lastChecked = c;
          // a lease near its end is extended while it is searched: the kept copy learns the new end
          // the server no longer knows the lease (it ran out, or went to someone else while this browser was
          // silent): this piece is stopped and the next one taken, instead of searching it for nothing
          post('/api/pool/ping', { lease: L.lease, rate: r }).then(function (a) { if (a && a.expires) L.expires = a.expires; }).catch(function (err) { if (err.refused && lease === L && h) { gone = true; h.stop(); } });
        }
        ctaPct = Math.floor(frac * 100);
        feed(Number(x.checked), x.seconds);
        view.rate = P.rate(x.rate); view.bar = 100 * frac; paint();
      }, {
        isPaused: P.hidden,
        resume: resume ? resume.pos : null,
        // a key whose address is any puzzle's is a win and stays here, whatever the server called it
        onHit: function (key, i) {
          if (i === 0 || PZ.which(S.hash160OfKey(key))) { won = key; return; }
          checks.push('0x' + key.toString(16));
        },
      });
      var key = await h.done;
      // a Stop and a new Start meanwhile: `current` is the new run's search now, and stays
      if (current === h) current = null;
      busy.done();
      if (gone && key == null && won == null) {
        log('✗ Piece ' + pieceNo + ' is no longer yours (the pool did not hear from this browser for a while): the next one.');
        if (piece && piece.L === L) piece = null;
        if (lease === L) lease = null;
        continue;
      }
      if (key != null || won != null) { piece = null; dropKept(L.lease); var wk = won != null ? won : key; win(wk, Object.assign({}, L, { puzzle: PZ.which(S.hash160OfKey(wk)) || L.puzzle, address: PZ.address(PZ.which(S.hash160OfKey(wk)) || L.puzzle) })); return; }
      if (stale()) return;
      // done: the piece is no longer held (nothing to keep or release) and is reported while the next one runs
      if (piece && piece.L === L) piece = null;
      if (lease === L) lease = null;
      report(L, checks, lastRate, pieceNo, !!resume, (performance.now() - t0) / 1000);
    }
  }
  function stop() {
    running = false; if (!view.piece) view.range = 'press Start';
    log.idle();
    if (current) current.stop();
    dropNext();
    // the piece stays yours: kept here with where the search stands; a piece not started yet goes back
    var held = lease && piece && piece.L === lease && keep();
    if (lease && !held) post('/api/pool/release', { lease: lease.lease }).catch(function () {});
    // kept: the server hears at once that nobody searches it right now (the speedometer drops)
    if (held) post('/api/pool/ping', { lease: lease.lease, idle: true }).catch(function () {});
    var heldL = held ? lease : null;
    lease = null; piece = null;
    paint(); drawLive();
    if (session.t0) log('Stopped. This session: ' + session.pieces + (session.pieces === 1 ? ' piece, ' : ' pieces, ') + P.words(session.keys) + ' keys in ' + P.dur((performance.now() - session.t0) / 1000) + '.');
    if (heldL) log('Your piece is kept until ' + hhmm(heldL.expires) + ': Start continues it where it stopped. After that it goes back to the pool.');
  }
  // closing the tab keeps the piece the same way (Start on the next visit continues it)
  window.addEventListener('pagehide', function () {
    // left while searching (a full page load, not a move inside the site): back on /pool, it continues by itself
    if (running) { try { sessionStorage.setItem('bb-autorun', '1'); } catch (_) { /* no storage */ } }
    if (lease && piece && piece.L === lease && keep()) {
      if (navigator.sendBeacon) navigator.sendBeacon('/api/pool/ping', new Blob([JSON.stringify({ lease: lease.lease, idle: true })], { type: 'application/json' }));
      return;
    }
    if (lease && navigator.sendBeacon) navigator.sendBeacon('/api/pool/release', new Blob([JSON.stringify({ lease: lease.lease })], { type: 'application/json' }));
    if (next && next.L && navigator.sendBeacon) navigator.sendBeacon('/api/pool/release', new Blob([JSON.stringify({ lease: next.L.lease })], { type: 'application/json' }));
  });
  // the key: found.js takes it at once (commitment, Slipstream, then the pool) and shows it on the searcher's page;
  // found while another page is shown, the site goes back to that page first
  function win(key, L) {
    // a search started again meanwhile (Stop, Start) would find the same key once more: it ends here
    if (current) current.stop();
    running = false;
    dropNext();
    // the piece that holds the key is never given back: no release, no "kept" piece, not even on closing the tab
    if (L && L.lease) dropKept(L.lease);
    lease = null; piece = null;
    winData = { key: key, L: L, payout: runAddr };
    window.BBFound.found({ key: key, puzzle: L.puzzle, address: L.address, payout: runAddr, lease: L.lease, from: L.from, to: L.to, poolPayout: L.pool_payout || (stats && stats.payout_address) || null });
    log('★ The key of the puzzle is in this piece. This page now stamps a commitment, sends your claim through MARA Slipstream, then tells the pool. The key stays hidden until the prize is spent.');
    paint();
    if (onPool() && mode !== 'other') showFind(true);
    else if (window.BBNav) window.BBNav.go(ownPath(), true, true);
  }
  // the page of the running search (or the one that found the key)
  function ownPath() { var a = (winData && winData.payout) || runAddr; return a ? '/pool/' + a : '/pool'; }
  function showFind(scroll) {
    if (!winData || !onPool() || mode === 'other') return;
    window.BBFound.show($('claim'));
    if (scroll) $('claim').scrollIntoView({ behavior: 'smooth' });
  }
  // a key found earlier in this browser: back on its page until the prize is spent or the key is forgotten
  (function () {
    var w = window.BBFound.kept();
    if (w) winData = { key: BigInt(w.key), L: { puzzle: w.puzzle, address: w.address }, payout: w.payout };
    window.BBFound.onForget(function () { winData = null; paint(); });
  })();

  // whatever goes wrong inside the loop ends up in the log, never in silence
  function go() { start().catch(function (err) { log('✗ ' + (err && err.message || err)); if (running) stop(); lost(); }); }
  // the GPU lost under the search (a driver reset, the card taken by another program): the piece is kept (stop),
  // and the search starts once more by itself on a fresh device (common.js forgets the lost one). A second loss
  // within ten minutes is left to the visitor, so a card that keeps failing is not restarted over and over.
  var lostAt = 0;
  function lost() {
    var why = engine && engine.lostReason && engine.lostReason();
    if (!why) return;
    engine = null;
    if (Date.now() - lostAt < 600000) { log('The graphics card was lost again (' + why + '). Press Start to try once more, or reload the page.'); return; }
    lostAt = Date.now();
    log('The graphics card was lost (' + why + '): starting it again in 5 s, your piece continues.');
    setTimeout(function () { if (!running && !winData && onPool() && mode === 'own') go(); }, 5000);
  }

  // the tab hidden and back: one line on return, not one per switch. Searching in the background, it sums up
  // what happened while away (from a minute on); paused, it says so and how long the pause was.
  var away = null;
  document.addEventListener('visibilitychange', function () {
    if (!running) { away = null; return; }
    if (document.visibilityState === 'hidden') {
      away = { t: performance.now(), pieces: session.pieces, frac: frac, bg: P.background() };
      if (!away.bg) log('Paused: the tab is hidden (the piece is at ' + Math.round(frac * 100) + '%).');
      // paused: the server hears the piece is kept, not abandoned (a browser silent for 5 minutes loses its piece)
      if (!away.bg && lease) post('/api/pool/ping', { lease: lease.lease, idle: true }).catch(function () {});
      return;
    }
    if (!away) return;
    if (!away.bg && lease) post('/api/pool/ping', { lease: lease.lease, rate: 0 }).catch(function () {});
    var sec = (performance.now() - away.t) / 1000, n = session.pieces - away.pieces;
    if (!away.bg) log('Resumed after ' + P.dur(sec) + '.');
    else if (sec >= 60) log('While you were away (' + P.dur(sec) + '): ' + (n ? n + (n === 1 ? ' piece' : ' pieces') + ' done' : 'the piece went from ' + Math.round(away.frac * 100) + '% to ' + Math.round(frac * 100) + '%') + '.');
    away = null;
  });

  // ---------- a searcher's page, attached each time it is shown ----------
  // whose page it is, and the title and address that say so
  function whose() {
    pageAddr = (location.pathname.match(/^\/pool\/([A-Za-z0-9]{25,90})$/) || [])[1] || null;
    if (pageAddr && !T.isAddress(pageAddr)) pageAddr = null;
    mode = (window.BBPoolMode && window.BBPoolMode()) || 'other';
    // a path that is no address (a typo, a cut link): said so, with dashes for the numbers
    var bad = !pageAddr;
    if (bad) mode = 'other';
    var title = mode === 'own' ? 'Your search' : bad ? 'Not a Bitcoin address' : 'Searcher ' + short(pageAddr);
    if (bad && window.BBNoData) window.BBNoData($('me-tiles'), 'Not a Bitcoin address: check the link');
    $('s-title').textContent = title;
    document.title = (mode === 'own' ? 'Your search, ' + short(pageAddr) : title) + ' | BumbleBeam Puzzle';
    $('s-addr').textContent = pageAddr || '\u00a0';
    $('s-copy').title = pageAddr || ''; // the copy button's tip: what it copies
    $('s-bal').href = pageAddr ? '/api/go/address/' + encodeURIComponent(pageAddr) : '/pool';
  }
  function attach() {
    if (!onPool()) { cta(); return; }
    var q = new URLSearchParams(location.search);
    whose();
    // someone else's page, and the address is yours after all (a new browser): search under it here
    $('s-mine').addEventListener('click', function (e) {
      e.preventDefault();
      if (running) return;
      store('bb-addr', pageAddr);
      var nav = document.getElementById('nav-my'); if (nav) { nav.hidden = false; nav.href = '/pool/' + pageAddr; }
      whose(); invite(); me(); paint();
    });
    // the address's copy button (ui's .cp): a tick for 2 s once copied
    $('s-copy').addEventListener('click', function () {
      var b = this, ICON = b.innerHTML;
      if (!pageAddr || !navigator.clipboard) return;
      navigator.clipboard.writeText(pageAddr).then(function () {
        b.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'; b.classList.add('done');
        setTimeout(function () { b.innerHTML = ICON; b.classList.remove('done'); }, 2000);
      }).catch(function () { /* not allowed here */ });
    });
    // Copy, then Copied for 2 s: one width for both words (ui's .btn.swap)
    $('inv-copy').addEventListener('click', function () {
      var b = this;
      navigator.clipboard.writeText($('inv-link').textContent).then(function () {
        b.classList.add('done'); clearTimeout(b._t); b._t = setTimeout(function () { b.classList.remove('done'); }, 2000);
      }).catch(function () { /* not allowed here */ });
    });
    // Save image and Share, as on /play: the QR code as a png; Share sends it with the link where the browser shares
    // files, the words and link where it shares only those, else copies them (navigator.share needs https)
    $('inv-png').addEventListener('click', function () { var a = addr(); if (a && window.BB && BB.qrSave) BB.qrSave(inviteLink(a), 'bumblebeam-puzzle-invite', $('inv-qr')); });
    $('inv-share').addEventListener('click', function () {
      var b = this, a = addr(); if (!a) return;
      var link = inviteLink(a), title = 'Search Bitcoin Puzzle #' + ((stats && stats.puzzle) || 71) + ' together', text = 'Join me in the search for the next key of the Bitcoin puzzle, right in your browser';
      function copied() {
        var t = text + ': ' + link, done = function () { b.classList.add('done'); clearTimeout(b._t); b._t = setTimeout(function () { b.classList.remove('done'); }, 2000); };
        if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(t).then(done).catch(function () {}); else done();
      }
      if (!navigator.share) { copied(); return; }
      var words = function () { navigator.share({ title: title, text: text, url: link }).catch(function () { /* closed */ }); };
      if (invBlob && navigator.canShare && navigator.canShare({ files: [invBlob] })) navigator.share({ files: [invBlob], title: title, text: text + ': ' + link }).catch(function () { /* closed */ });
      else words();
    });
    $('j-start').addEventListener('click', go);
    $('j-stop').addEventListener('click', stop);
    log.attach($('r-log'));
    paint(); device(); drawLive();
    invite(); me(); refresh();
    // your numbers stay fresh while the page is open (a piece credited updates them at once, too)
    var timer = setInterval(me, 30000);
    window.addEventListener('bb:leave', function () { clearInterval(timer); }, { once: true });
    if (winData) showFind(false);
    // sent here by Start on /pool: start at once
    var want = null;
    try { want = sessionStorage.getItem('bb-start'); sessionStorage.removeItem('bb-start'); } catch (_) { /* no storage */ }
    if (want === location.pathname && mode !== 'other' && !running && !winData && P.hasGpu()) go();
  }

  // what /pool (pooldash.js) and head.js read: whether a search runs, under which address, how far
  window.BBPool = {
    running: function () { return running; }, attach: attach,
    runAddr: function () { return runAddr; },
    state: function () { return { running: running, addr: runAddr, pct: ctaPct, rate: view.rate, pieces: session.pieces, won: !!winData, path: running || winData ? ownPath() : null }; },
  };
  attach();
  // back on /pool after a full page load that left it mid-search: continue the kept piece without a click
  (function () {
    var again = null;
    try { again = sessionStorage.getItem('bb-autorun'); sessionStorage.removeItem('bb-autorun'); } catch (_) { /* no storage */ }
    if (again && keptList().length && P.hasGpu()) { log('You left mid-search: continuing.'); go(); }
  })();
})();
