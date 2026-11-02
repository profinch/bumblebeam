/* /play: search one puzzle's range on the GPU (engine/gpu.js) or the CPU (engine/cpu-worker.js). */
(function () {
  'use strict';
  var P = window.BBP, S = P.S;
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function date(t) { return t ? new Date(t * 1000).toISOString().slice(0, 10) : ''; }

  var puzzles = [], target = 71, engine = P.hasGpu() ? 'gpu' : 'cpu', run = null;
  var LOTTERY = 'lottery';
  function knownRate() {
    if (engine === 'cpu') return P.threads() * 250000;
    var r = 0; try { r = Number(localStorage.getItem('bb-gpu-rate')) || 0; } catch (_) { /* no storage */ }
    return r || 1.5e8;
  }
  function sel() { return $('p-puzzle').value; }
  function puzzleN() { return sel() === LOTTERY ? target : Number(sel()); }
  function cur() { return puzzles[puzzleN() - 1]; }

  function fillSelect() {
    var opts = puzzles.filter(function (p) { return p.status === 'solved' && p.n >= 10 && p.n <= 48; }).map(function (p) {
      return '<option value="' + p.n + '">#' + p.n + ' · solved ' + date(p.solved && p.solved.time).slice(0, 4) + '</option>';
    });
    var t = puzzles[target - 1];
    opts.push('<option value="' + LOTTERY + '">#' + target + ' · open, ' + (t ? t.balance : '') + ' BTC: a lottery ticket</option>');
    $('p-puzzle').innerHTML = opts.join('');
    var want = new URLSearchParams(location.search).get('n');
    $('p-puzzle').value = want && puzzles[want - 1] && puzzles[want - 1].status === 'solved' ? want : (engine === 'gpu' ? '32' : '26');
    show();
  }

  function show() {
    var p = cur(); if (!p) return;
    var lot = sel() === LOTTERY, n = p.n, size = Math.pow(2, n - 1);
    $('p-addr').textContent = p.address;
    $('p-range').textContent = '0x' + (1n << BigInt(n - 1)).toString(16) + ' … 0x' + ((1n << BigInt(n)) - 1n).toString(16);
    $('p-keys').textContent = '2' + P.sup(n - 1) + ' = ' + P.sci(size);
    var r = knownRate();
    $('p-eta').textContent = lot ? 'half the range: ' + P.dur(size / 2 / r) : 'about ' + P.dur(size / 2 / r) + ' on average, ' + P.dur(size / r) + ' at most';
    $('p-status').textContent = p.status === 'solved' ? 'solved on ' + date(p.solved && p.solved.time) + ': its key is known' : 'open';
    $('p-lottery').hidden = !lot;
    document.querySelectorAll('#p-engine button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-e') === engine); });
    $('p-engine-note').textContent = engine === 'gpu' ? (P.hasGpu() ? 'your graphics card, through WebGPU' : 'this browser has no WebGPU') : P.threads() + ' CPU threads';
  }
  $('p-puzzle').addEventListener('change', show);
  document.querySelectorAll('#p-engine button').forEach(function (b) {
    b.addEventListener('click', function () {
      if (run) return;
      engine = b.getAttribute('data-e');
      if (engine === 'gpu' && !P.hasGpu()) { engine = 'cpu'; }
      show();
    });
  });
  if (!P.hasGpu()) document.querySelector('#p-engine [data-e="gpu"]').disabled = true;

  function log(m) { var el = $('r-log'); el.textContent += m + '\n'; el.scrollTop = el.scrollHeight; }
  function state(t, cls) { $('p-state').className = 'pill-status' + (cls ? ' ' + cls : ''); $('p-state-t').textContent = t; }

  document.addEventListener('visibilitychange', function () {
    if (!run) return;
    if (P.hidden()) state('paused: the tab is hidden', 'demo'); else state('searching');
  });

  function wif(key) {
    var b = new Uint8Array(34); b[0] = 0x80; b.set(S.fromHex(key.toString(16).padStart(64, '0')), 1); b[33] = 1;
    var c = S.sha256(S.sha256(b)), full = new Uint8Array(38); full.set(b); full.set(c.slice(0, 4), 34);
    var A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz', n = BigInt('0x' + S.toHex(full)), s = '';
    while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
    return s;
  }

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
    $('p-run').hidden = false; $('p-found').hidden = true; $('r-log').textContent = '';
    $('p-start').disabled = true; $('p-stop').disabled = false;
    $('r-checked').textContent = '0'; $('r-bar').style.width = '0%';
    state('starting');
    if (lot) log('Starting at ' + P.hex(from) + ', a random point in #' + n + '\'s range.');
    var onProgress = function (x) {
      var c = Number(x.checked);
      $('r-checked').textContent = P.sci(c);
      $('r-share').textContent = lot ? 'a share of 1 in ' + P.sci(Math.pow(2, n - 1) / Math.max(c, 1)) + ' of the range' : (Math.round(c / size * 1000) / 10) + '% of the range';
      $('r-rate').textContent = P.rate(x.rate);
      $('r-time').textContent = P.dur(x.seconds);
      $('r-left').textContent = lot ? '' : 'at most ' + P.dur((size - c) / Math.max(x.rate, 1)) + ' left';
      $('r-bar').style.width = (lot ? 100 * c / Math.pow(2, n - 1) : Math.min(100, 100 * c / size)) + '%';
      if (!P.hidden()) state('searching');
      if (engine === 'gpu' && x.seconds > 3) { try { localStorage.setItem('bb-gpu-rate', String(Math.round(x.rate))); } catch (_) { /* no storage */ } }
    };
    var t0 = performance.now(), key;
    try {
      if (engine === 'gpu') {
        var e = await P.gpu(log);
        $('r-engine').textContent = P.gpuName(e);
        log('Searching on ' + P.gpuName(e) + '.');
        run = e.search(from, to, targetHex, onProgress, { steps: 32, isPaused: P.hidden });
      } else {
        $('r-engine').textContent = P.threads() + ' CPU threads';
        log('Searching on ' + P.threads() + ' CPU threads.');
        run = P.cpuSearch(from, to, targetHex, P.threads(), onProgress);
      }
      state('searching');
      key = await run.done;
    } catch (err) {
      log('✗ ' + (err && err.message || err));
      state('failed', 'off');
      if (engine === 'gpu') log('The GPU engine is not usable here; the CPU engine still is.');
    }
    var sec = (performance.now() - t0) / 1000;
    run = null; $('p-start').disabled = false; $('p-stop').disabled = true;
    if (key) found(p, key, sec, lot);
    else if (key === null) { state('stopped', 'off'); log('Stopped after ' + P.dur(sec) + '.'); }
  }

  function found(p, key, sec, lot) {
    var ok = S.hash160ToAddress(S.hash160OfKey(key)) === p.address;
    state(ok ? 'found' : 'mismatch', ok ? '' : 'off');
    log((ok ? '✓ Found ' : '✗ Got ') + P.hex(key) + ' in ' + P.dur(sec) + '.');
    $('p-found').hidden = false;
    $('f-hex').textContent = P.hex(key);
    $('f-dec').textContent = key.toString();
    $('f-addr').textContent = S.hash160ToAddress(S.hash160OfKey(key)) + (ok ? ' ✓' : ' ✗');
    $('f-after').textContent = P.dur(sec);
    var note = $('f-note');
    if (p.status === 'solved') {
      note.className = 'note ok';
      note.innerHTML = 'This is puzzle #' + p.n + '’s key: it was found on ' + esc(date(p.solved && p.solved.time)) + ' and its prize taken. Each bit doubles the work: #' + (p.n + 1) + ' takes about twice as long, #71 about ' + P.sci(Math.pow(2, 71 - p.n)) + ' times as long.';
    } else {
      note.className = 'note bad';
      note.innerHTML = '<b>This key unlocks an open prize.</b> Tell nobody and post it nowhere. Do not send a transaction through a public node or wallet: anyone watching the mempool reads the key from it and outbids you. Write the key down offline (WIF: <span class="mono">' + esc(wif(key)) + '</span>) and claim through a private relay (MARA Slipstream) only.';
    }
  }

  $('p-start').addEventListener('click', start);
  $('p-stop').addEventListener('click', function () { if (run) run.stop(); });

  P.get('/api/puzzles').then(function (d) { puzzles = d.puzzles; target = d.target || 71; fillSelect(); }).catch(function () {
    $('p-status').textContent = 'the puzzle list is not available right now';
  });
})();
