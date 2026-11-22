/* /play: search one puzzle's range on the GPU (engine/gpu.js) or the CPU (engine/cpu-worker.js). */
(function () {
  'use strict';
  // the pool's search runs in this tab (nav.js keeps it across pages): the graphics card is its, not this page's
  function poolBusy() { return !!(window.BBPool && window.BBPool.running()); }
  var P = window.BBP, S = P.S;
  function $(id) { return document.getElementById(id); }
  var esc = window.BB.esc; // ui/components/bb.js
  function date(t) { return t ? new Date(t * 1000).toISOString().slice(0, 10) : ''; }

  var puzzles = [], target = 71, engine = P.hasGpu() && !poolBusy() ? 'gpu' : 'cpu', run = null;
  var LOTTERY = 'lottery';
  function knownRate() {
    if (engine === 'cpu') return P.threads() * 250000;
    var r = 0; try { r = Number(localStorage.getItem('bb-gpu-rate')) || 0; } catch (_) { /* no storage */ }
    return r || 1.5e8;
  }
  var pick = null; // the puzzle card list (ui/components/dd.js)
  function sel() { return pick ? pick.value() : ''; }
  function puzzleN() { return sel() === LOTTERY ? target : Number(sel()); }
  function cur() { return puzzles[puzzleN() - 1]; }

  function fillSelect() {
    var opts = puzzles.filter(function (p) { return p.status === 'solved' && p.n >= 10 && p.n <= 48; }).map(function (p) {
      return { v: p.n, label: '#' + p.n + ', solved ' + date(p.solved && p.solved.time).slice(0, 4) };
    });
    var t = puzzles[target - 1];
    opts.push({ v: LOTTERY, label: '#' + target + ', open' }); // its prize and the lottery are told in the note it brings up
    // ?n= picks a puzzle when the list has it
    var want = new URLSearchParams(location.search).get('n');
    var ok = opts.some(function (o) { return String(o.v) === want; });
    if (!pick) pick = window.BB.dropdown($('p-puzzle'), show);
    pick.options(opts, ok ? want : (engine === 'gpu' ? '32' : '26'));
    show();
  }

  var ks = null, ksN = 0, ksD = [];
  // the key square shows a key: its last digits, one value each
  // rate (keys a second, during a search): the last digits run through all their values many times between two
  // updates (and the progress comes in whole batches, so they would sit still at one value); they show a random value
  // each time instead, which is what the eye would see
  function ksShow(key, rate) {
    var h = key.toString(16).padStart(64, '0'), n = ksD.length, blur = 0;
    if (rate) while (blur < n && Math.pow(16, blur + 1) < rate * 0.12) blur++;
    ks.show(ksD.map(function (d, i) { return i >= n - blur ? d.vals[Math.floor(Math.random() * d.vals.length)] : parseInt(h[64 - n + i], 16); }), false);
  }
  function show() {
    var p = cur(); if (!p) return;
    var lot = sel() === LOTTERY, n = p.n, size = Math.pow(2, n - 1);
    $('p-addr').textContent = p.address;
    // the search card, always there: at rest it shows the chosen puzzle's address and nothing checked yet
    if (!run && $('slot-t')) {
      slotInit(p.address);
      $('r-checked').textContent = '0'; $('r-share').innerHTML = '&nbsp;'; $('r-rate').innerHTML = '&nbsp;'; $('r-engine').innerHTML = '&nbsp;';
      $('r-time').textContent = '0 s'; $('r-left').innerHTML = '&nbsp;'; $('r-bar').style.width = '0%';
    }
    // the key square: this puzzle's open digits
    if (!ks) ks = BBKeySquare($('p-ksq'), $('p-kcount').parentNode);
    if (ksN !== n) { ksN = n; ksD = ks.setN(n); $('p-kcount').innerHTML = (64 - ksD.length) + ' known | <b>' + ksD.length + ' to find</b>'; }
    $('p-range').textContent = '0x' + (1n << BigInt(n - 1)).toString(16) + ' … 0x' + ((1n << BigInt(n)) - 1n).toString(16);
    $('p-keys').textContent = '2' + P.sup(n - 1) + ' = ' + P.sci(size);
    var r = knownRate();
    $('p-eta').textContent = lot ? 'half the range: ' + P.dur(size / 2 / r) : 'about ' + P.dur(size / 2 / r) + ' on average, ' + P.dur(size / r) + ' at most';
    $('p-status').textContent = p.status === 'solved' ? 'its key is known' : 'open';
    $('p-lottery').hidden = !lot;
    document.querySelectorAll('#p-engine button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-e') === engine); });
    $('p-engine-note').textContent = engine === 'gpu' ? (P.hasGpu() ? 'your graphics card (WebGPU)' : 'no WebGPU here') : P.threads() + ' CPU threads' + (poolBusy() ? '. The graphics card is busy with your pool search.' : P.hasGpu() ? '' : '. No WebGPU here: ' + P.noGpuWhy());
  }
  document.querySelectorAll('#p-engine button').forEach(function (b) {
    b.addEventListener('click', function () {
      if (run) return;
      engine = b.getAttribute('data-e');
      if (engine === 'gpu' && (!P.hasGpu() || poolBusy())) { engine = 'cpu'; }
      show();
    });
  });
  // while the pool searches (in this tab, nav.js), nothing here may start: Start and the engines are off, their tip says why
  var POOL_TIP = 'Your pool search is running: stop it on the pool page to play';
  function poolGate() {
    var busy = poolBusy();
    [$('p-start')].concat(Array.prototype.slice.call(document.querySelectorAll('#p-engine button'))).forEach(function (b) {
      var off = busy || (b.dataset.e === 'gpu' && !P.hasGpu());
      if (!run) b.disabled = off;
      if (busy) b.title = POOL_TIP; else if (b.title === POOL_TIP) b.removeAttribute('title');
    });
  }
  poolGate();
  var poolTimer = setInterval(poolGate, 1500);
  // another page shown in place of this one (nav.js): a search here ends
  window.addEventListener('bb:leave', function () { clearInterval(poolTimer); if (run) run.stop(); if (ks) ks.destroy(); }, { once: true });

  var log = P.logTo($('r-log'));
  function state(t, cls) { $('p-state').className = 'pill-status' + (cls ? ' ' + cls : ''); $('p-state-t').textContent = t; }

  function onVis() {
    if (!run) return;
    if (P.hidden()) state('paused: the tab is hidden', 'demo'); else state('searching');
  }
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('bb:leave', function () { document.removeEventListener('visibilitychange', onVis); }, { once: true });


  async function start() {
    var p = cur(); if (!p || run) return;
    var lot = sel() === LOTTERY, n = p.n;
    var lo = 1n << BigInt(n - 1), hi = (1n << BigInt(n)) - 1n, from = lo, to = hi;
    if (lot) {
      // a random place in the range, then onwards
      var r = new Uint32Array(3); crypto.getRandomValues(r);
      var off = ((BigInt(r[0]) << 64n) | (BigInt(r[1]) << 32n) | BigInt(r[2])) % (hi - lo + 1n);
      from = lo + off; to = engine === 'cpu' ? from + (1n << 40n) : hi;
    }
    var targetHex = S.addressToHash160(p.address), size = Number(to - from + 1n);
    $('p-run').hidden = false; $('p-found').hidden = true; log.clear();
    var oldFw = document.querySelector('.kf-key .fw'); if (oldFw) oldFw.remove();
    $('p-start').disabled = true; $('p-stop').disabled = false;
    $('r-checked').textContent = '0'; $('r-bar').style.width = '0%';
    state('starting');
    if (lot) log('Starting at ' + P.hex(from) + ', a random point in the range of #' + n + ': a lottery ticket, not a search of all of it.');
    var mile = 0, busy = null;
    slotInit(p.address); var slotAt = 0; ks.setFound(false);
    var onProgress = function (x) {
      var c = Number(x.checked);
      if (busy) busy.set(lot ? 'Searching from a random point: ' + P.words(c) + ' keys so far' : 'Searching #' + n + ': ' + Math.floor(Math.min(1, c / size) * 100) + '%'); lastChecked = c;
      // a line at each quarter of a small range: how far, how long at most
      if (!lot && c / size >= (mile + 1) / 4 && c < size) { while (c / size >= (mile + 1) / 4) mile++; log(mile * 25 + '% of the range checked, at most ' + P.dur((size - c) / Math.max(x.rate, 1)) + ' left at ' + P.rate(x.rate) + '.'); }
      $('r-checked').textContent = c < 1e6 ? P.int(c) : P.words(c);
      $('r-share').textContent = lot ? '1 in ' + P.sci(Math.pow(2, n - 1) / Math.max(c, 1)) + ' of the range' : pct(c / size) + ' of the range';
      $('r-rate').textContent = P.rate(x.rate);
      $('r-time').textContent = P.dur(x.seconds);
      $('r-left').textContent = lot ? '' : 'up to ' + P.dur((size - c) / Math.max(x.rate, 1)) + ' left';
      // the slot's lower row: the address of the key reached now, worked out here a few times a second
      if (performance.now() - slotAt > 120) { slotAt = performance.now(); var kNow = from + BigInt(Math.max(0, Math.floor(c))); slotShow(S.hash160ToAddress(S.hash160OfKey(kNow))); ksShow(kNow, x.rate); }
      $('r-bar').style.width = (lot ? 100 * c / Math.pow(2, n - 1) : Math.min(100, 100 * c / size)) + '%';
      if (!P.hidden()) state('searching');
      if (engine === 'gpu' && x.seconds > 3) { try { localStorage.setItem('bb-gpu-rate', String(Math.round(x.rate))); } catch (_) { /* no storage */ } }
    };
    var t0 = performance.now(), key, lastChecked = 0;
    try {
      if (engine === 'gpu') {
        var e = await P.gpuQuiet(log);
        $('r-engine').textContent = P.gpuName(e).replace(/\s*\(.*\)$/, ''); // the model only; the vendor and generation stay in the log
        log('Searching ' + P.words(size) + ' keys of #' + n + (lot ? ' from a random point' : '') + '.');
        run = e.search(from, to, targetHex, onProgress, { isPaused: P.hidden });
      } else {
        $('r-engine').textContent = P.threads() + ' CPU threads';
        log('Searching ' + P.words(size) + ' keys of #' + n + ' on ' + P.threads() + ' CPU threads.');
        run = P.cpuSearch(from, to, targetHex, P.threads(), onProgress);
      }
      state('searching');
      busy = log.busy('Searching #' + n);
      key = await run.done;
      busy.done(); busy = null;
    } catch (err) {
      if (busy) { busy.done(); busy = null; }
      log('✗ ' + (err && err.message || err));
      state('failed', 'off');
      if (engine === 'gpu') log('The GPU engine is not usable here, but the CPU engine still is.');
    }
    var sec = (performance.now() - t0) / 1000;
    run = null; $('p-start').disabled = false; $('p-stop').disabled = true;
    // the keys it took: from the start of the range up to the key; from a random place, what the engine reported
    if (key) found(p, key, sec, lot);
    else if (key === null) { state('stopped', 'off'); log('Stopped after ' + P.dur(sec) + ': ' + P.words(lastChecked) + ' keys checked.'); }
  }

  // the slot machine
  var slotT = '';
  function slotInit(addr) {
    slotT = addr;
    $('slot-t').innerHTML = addr.split('').map(function (ch) { return '<i>' + ch + '</i>'; }).join('');
    $('slot-c').innerHTML = addr.split('').map(function () { return '<i></i>'; }).join('');
    $('r-slot').classList.remove('won');
    $('r-slot').style.setProperty('--n', addr.length); // as many cells as the address has characters
  }
  function slotShow(a, won) {
    var cells = $('slot-c').children;
    for (var i = 0; i < cells.length; i++) { var ch = a[i] || ''; if (cells[i].textContent !== ch) cells[i].textContent = ch; cells[i].classList.toggle('m', ch === slotT[i]); }
    if (won) $('r-slot').classList.add('won');
  }

  // "puzzle #N" linked to its page here, as on the home page
  function plink(n) {
    var q = puzzles.filter(function (x) { return x.n === n; })[0];
    return '<a href="/puzzle/' + n + '"' + (q ? ' title="' + esc(q.address) + '"' : '') + '>puzzle #' + n + '</a>';
  }
  // a share of the range always as five characters before the % (' 7.3', '42.0', '100.0'), padded with no-break
  // spaces in the tile's monospace font, so the words after it stay put while the number grows
  function pct(f) { return (Math.min(1, f) * 100).toFixed(1).padStart(5, '\u00a0') + '%'; }
  // the found key's box: the key, or (an open prize's, until the prize is safe) the words saying when it shows
  function keyBox(key) {
    if (key == null) $('f-hex').innerHTML = 'hidden until<br>the prize is safe'; else $('f-hex').textContent = P.hex(key);
    $('f-hex').classList.toggle('hid', key == null);
    $('f-dec').textContent = key == null ? '' : key.toString();
    $('f-dec').parentNode.hidden = key == null;
  }
  function found(p, key, sec, lot) {
    var ok = S.hash160ToAddress(S.hash160OfKey(key)) === p.address;
    // the lottery's puzzle is open whatever the server says (a server that called it solved must not get the key put
    // on a picture to share); the others are long solved, their keys known
    var solved = p.status === 'solved' && !lot;
    // an open prize's key is not shown, not even in the key square, until its prize is spent and DEPTH blocks deep
    // (prize.js): before that anyone who sees it (over a shoulder, in a screenshot or a stream, pasted into a
    // wallet in a panic) can take the prize
    var hide = ok && !solved;
    if (ok) {
      // the jackpot: every cell lights up, and the home page's confetti flies from the found key's box
      slotShow(p.address, true); ksShow(key, hide ? Infinity : 0); ks.setFound(true);
      setTimeout(function () { var kt = document.querySelector('.kf-key > .k'); if (kt && window.BB && BB.confetti && !kt.parentNode.querySelector('.fw')) BB.confetti(kt); }, 60);
    }
    state(ok ? 'found' : 'mismatch', ok ? '' : 'off');
    log((ok ? '✓ Found ' : '✗ Got ') + (hide ? 'the key of #' + p.n : P.hex(key)) + ' in ' + P.dur(sec) + '.');
    $('p-found').hidden = false;
    keyBox(hide ? null : key);
    $('f-addr').textContent = S.hash160ToAddress(S.hash160OfKey(key));
    $('f-puzzle').textContent = 'Puzzle #' + p.n;
    $('f-after').textContent = P.dur(sec);
    var note = $('f-note');
    note.hidden = !solved;
    $('f-share').hidden = true;
    if (ok && solved) shareFind(p, key, sec);
    if (solved) {
      note.className = 'tile key-info'; // the info box of /learn's cards, with its "i" cell
      note.innerHTML = '<span class="key-info-badge" aria-hidden="true">i</span>This is the key to ' + plink(p.n) + ': it was found on <code class="mark">' + esc(date(p.solved && p.solved.time)) + '</code>, and someone took the prize. Each bit doubles the work: ' + plink(p.n + 1) + ' takes about twice as long, and ' + plink(71) + ' takes about <code class="mark">' + P.sci(Math.pow(2, 71 - p.n)) + '</code> times as long.';
    } else if (ok) {
      // an open prize: the claim, built and signed here (claim.js), in the card below, which says it all (the key box
      // says only that the key is hidden)
      var payout = null; try { payout = localStorage.getItem('bb-addr'); } catch (_) { /* no storage */ }
      // a find here was not the pool's work: all of it is the finder's, sent to the saved payout address by itself,
      // or kept on our server (prize.js)
      Promise.resolve().then(function () { prize.found({ key: P.hex(key), puzzle: p.n, address: p.address, payout: payout, secs: sec }); });
    }
  }

  // ---------- an open prize found here: sent by itself, the key shown once it is safe (prize.js) ----------
  var DEPTH = 6;
  var prize = window.BBPrize({ box: $('p-claim'), keep: 'bb-play-win', source: 'play', onReveal: function (key) { if (!$('p-found').hidden) keyBox(key); } });

  // the picture to share: the key square of the find, the puzzle and the time, in three sizes, all drawn when the key is
  // found (so Share has its file at the tap); the size picked shows big, Save and Share act on it
  var share = { fmt: 'link', data: null, blobs: {}, urls: {} };
  function shareFind(p, key, sec) {
    var d = new Date(), two = function (v) { return (v < 10 ? '0' : '') + v; };
    share.data = { n: p.n, secs: sec, key: P.hex(key), address: p.address, date: two(d.getDate()) + '.' + two(d.getMonth() + 1) + '.' + d.getFullYear() };
    var opts = $('f-fmt');
    if (!opts.children.length) {
      opts.innerHTML = BBShare.FORMATS.map(function (f) {
        return '<button type="button" class="share-opt" role="radio" data-f="' + f.id + '"><b>' + f.label + '</b><span>' + f.w + ' × ' + f.h + '</span><p>' + f.hint + '</p></button>';
      }).join('');
      opts.addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) sharePick(b.dataset.f); });
    }
    Object.keys(share.urls).forEach(function (k) { URL.revokeObjectURL(share.urls[k]); });
    share.blobs = {}; share.urls = {}; $('f-img').removeAttribute('src');
    $('f-share').hidden = false;
    sharePick(share.fmt);
    var data = share.data;
    BBShare.FORMATS.reduce(function (chain, f) {
      return chain.then(function () {
        if (share.data !== data) return;
        return BBShare.render(f.id, data).then(function (cv) { return new Promise(function (ok) { cv.toBlob(ok, 'image/png'); }); }).then(function (b) {
          if (share.data !== data) return;
          share.blobs[f.id] = b; share.urls[f.id] = URL.createObjectURL(b);
          if (f.id === share.fmt) $('f-img').src = share.urls[f.id];
        });
      });
    }, Promise.resolve());
  }
  function sharePick(fmt) {
    share.fmt = fmt;
    Array.prototype.forEach.call($('f-fmt').children, function (b) { var on = b.dataset.f === fmt; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
    var f = BBShare.FORMATS.filter(function (x) { return x.id === fmt; })[0];
    $('f-img').className = 'share-pic' + (f.h > f.w ? ' tall' : '');
    if (share.urls[fmt]) $('f-img').src = share.urls[fmt]; else $('f-img').removeAttribute('src');
  }
  function shareFile(fmt) { return new File([share.blobs[fmt]], 'bitcoin-puzzle-' + share.data.n + '-' + fmt + '.png', { type: 'image/png' }); }
  $('f-save').addEventListener('click', function () {
    var url = share.urls[share.fmt]; if (!url) return;
    var a = document.createElement('a'); a.href = url; a.download = shareFile(share.fmt).name; document.body.appendChild(a); a.click(); a.remove();
  });
  // Share: the picture with the words where the browser shares files, the words and link alone where it shares only
  // those, else the words copied (navigator.share needs https, so a phone on the plain-http preview gets the copy)
  $('f-send').addEventListener('click', function () {
    var btn = this, title = 'Bitcoin Puzzle #' + share.data.n, url = 'https://puzzle.bumblebeam.org/play';
    var text = 'I found the key to Bitcoin Puzzle #' + share.data.n + ' in ' + BBShare.said(share.data.secs) + ', right in my browser';
    var file = share.blobs[share.fmt] && shareFile(share.fmt);
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: title, text: text + ': ' + url }).catch(function () { /* closed */ }); return; }
    if (navigator.share) { navigator.share({ title: title, text: text, url: url }).catch(function () { /* closed */ }); return; }
    copyText(text + ': ' + url).then(function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Share'; }, 1600); });
  });
  function copyText(t) {
    function old() {
      var ta = document.createElement('textarea'); ta.value = t; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (_) { /* nothing to copy with */ } ta.remove();
    }
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(t).catch(old);
    old(); return Promise.resolve();
  }

  // a key found here earlier for a prize not safe yet: on its way again (prize.js)
  if (window.BBClaim) prize.resume();

  $('p-start').addEventListener('click', start);
  $('p-stop').addEventListener('click', function () { if (run) run.stop(); });

  P.get('/api/puzzles').then(function (d) { puzzles = d.puzzles; target = d.target || 71; fillSelect(); }).catch(function () {
    $('p-status').textContent = 'the puzzle list is not available right now';
  });
})();
