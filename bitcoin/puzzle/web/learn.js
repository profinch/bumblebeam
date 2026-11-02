/* /learn: the key -> address chain, and a live race of brute force, BSGS and the kangaroo on a hidden key. */
(function () {
  'use strict';
  var P = window.BBP, S = P.S;
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // ---------- 1. key -> address ----------
  var addrs = {};
  P.get('/api/puzzles').then(function (d) { d.puzzles.forEach(function (p) { addrs[p.address] = p.n; }); chain(); }).catch(function () { /* no names then */ });
  function parseKey(s) {
    s = s.trim().replace(/[\s_,]/g, '');
    if (!s) return null;
    var k = /^0x/i.test(s) ? BigInt(s) : /^[0-9]+$/.test(s) ? BigInt(s) : /^[0-9a-f]+$/i.test(s) ? BigInt('0x' + s) : null;
    return k !== null && k > 0n && k < S.N ? k : null;
  }
  function chain() {
    var k;
    try { k = parseKey($('k-in').value); } catch (_) { k = null; }
    if (k === null) { $('k-out').innerHTML = '<li class="err">A number from 1 to n−1, please.</li>'; return; }
    var p = S.mulG(k), pub = S.compressedHex(p), sha = S.toHex(S.sha256(S.fromHex(pub))), h = S.wordsToHex(S.hash160Words(p[0], p[1])), a = S.hash160ToAddress(h);
    var bits = k.toString(2).length, n = addrs[a];
    var rows = [
      ['Private key', '0x' + k.toString(16), bits + (bits === 1 ? ' bit' : ' bits')],
      ['Public key = key · G', pub, 'a point on secp256k1, compressed: 02/03 for the parity of y, then x'],
      ['SHA-256 of it', sha, ''],
      ['RIPEMD-160 of that', h, 'the hash160, what the address holds'],
      ['Address', a, n ? '= puzzle #' + n + ' ✓' : 'Base58Check with version 0x00'],
    ];
    $('k-out').innerHTML = rows.map(function (r) { return '<li><div class="k">' + esc(r[0]) + '</div><div class="mono val">' + esc(r[1]) + '</div>' + (r[2] ? '<div class="dim sub">' + esc(r[2]) + '</div>' : '') + '</li>'; }).join('');
  }
  $('k-in').addEventListener('input', chain);
  document.querySelectorAll('[data-k]').forEach(function (a) {
    a.addEventListener('click', function (e) { e.preventDefault(); $('k-in').value = a.getAttribute('data-k'); chain(); });
  });
  chain();

  // ---------- 2. the race ----------
  var lanes = {}, jobs = {}, race = null;
  document.querySelectorAll('.lane').forEach(function (el) { lanes[el.getAttribute('data-m')] = { el: el, cv: el.querySelector('canvas'), pos: 0, marks: [], done: null }; });
  var css = getComputedStyle(document.documentElement);
  function col(name, fb) { return (css.getPropertyValue(name) || fb).trim(); }

  function draw(m) {
    var L = lanes[m], cv = L.cv, dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = 34;
    cv.width = w * dpr; cv.height = h * dpr;
    var c = cv.getContext('2d'); c.scale(dpr, dpr);
    c.fillStyle = 'rgba(255,255,255,0.05)'; c.fillRect(0, 8, w, 18);
    var acc = col('--accent', '#f7931a');
    if (m === 'brute') { c.fillStyle = acc; c.globalAlpha = 0.5; c.fillRect(0, 8, w * Math.min(1, L.pos), 18); }
    if (m === 'bsgs') {
      c.fillStyle = acc;
      if (L.pos < 0.5) { c.globalAlpha = 0.35 + 0.3 * Math.sin(Date.now() / 150); c.fillRect(0, 8, Math.max(2, w * 0.01), 18); }
      else {
        c.globalAlpha = 0.25; c.fillRect(0, 8, Math.max(2, w * 0.01), 18);
        var gfrac = Math.min(1, (L.pos - 0.5) * 2 * L.cover);
        c.globalAlpha = 0.55; for (var x = 0; x < w * gfrac; x += 6) c.fillRect(x, 8, 3, 18);
      }
    }
    if (m === 'kangaroo') {
      c.fillStyle = acc; c.globalAlpha = 0.8;
      L.marks.forEach(function (f) { if (f >= 0 && f <= 1) c.fillRect(f * w, 10, 1.5, 14); });
    }
    c.globalAlpha = 1;
    if (race && race.reveal) {
      var sx = Number((race.secret - race.from) * 10000n / race.size) / 10000 * w;
      c.fillStyle = '#fff'; c.fillRect(sx - 1, 2, 2, 30);
    }
  }
  function drawAll() { Object.keys(lanes).forEach(draw); }
  window.addEventListener('resize', drawAll);

  function laneText(m, t) { $('v-' + m).textContent = t; }

  function go() {
    stopAll();
    var bits = Math.max(16, Math.min(44, Number($('r-bits').value) || 34));
    $('r-bits').value = bits;
    var from = 1n << BigInt(bits - 1), to = (1n << BigInt(bits)) - 1n, size = to - from + 1n;
    var r = new Uint32Array(2); crypto.getRandomValues(r);
    var secret = from + ((BigInt(r[0]) << 32n) | BigInt(r[1])) % size;
    var pt = S.mulG(secret), pub = [pt[0].toString(16), pt[1].toString(16)];
    race = { from: from, to: to, size: size, secret: secret, reveal: false, finished: 0, t0: performance.now() };
    var m2 = 1n; while (m2 * m2 < size) m2 <<= 1n;
    Object.keys(lanes).forEach(function (m) { lanes[m].pos = 0; lanes[m].marks = []; lanes[m].done = null; lanes[m].cover = Number(m2 * m2 * 1000n / size) / 1000; laneText(m, 'starting…'); });
    $('r-secret').textContent = 'a key hidden somewhere in 2' + P.sup(bits - 1) + ' = ' + P.sci(Number(size)) + ' keys';
    $('r-go').disabled = true; $('r-stop').disabled = false;
    var base = { from: from.toString(16), to: to.toString(16) };
    var expect = 2 * Math.sqrt(Number(size));
    jobs.brute = P.cpuJob(Object.assign({ mode: 'brute', target: S.wordsToHex(S.hash160Words(pt[0], pt[1])) }, base), function (x, sec) {
      lanes.brute.pos = x.pos; lanes.brute.ops = x.ops;
      laneText('brute', P.sci(x.ops) + ' keys · ' + P.dur(sec) + ' · ' + P.rate(x.ops / sec) + ' · ' + (Math.round(x.pos * 1000) / 10) + '% of the range');
    });
    jobs.bsgs = P.cpuJob(Object.assign({ mode: 'bsgs', pub: pub }, base), function (x, sec) {
      lanes.bsgs.pos = x.pos;
      laneText('bsgs', (x.phase === 'baby' ? 'baby steps: ' : 'giant steps: ') + P.sci(x.ops) + ' ops · table ' + P.sci(x.mem) + ' points · ' + P.dur(sec));
    });
    jobs.kangaroo = P.cpuJob(Object.assign({ mode: 'kangaroo', pub: pub, seed: r[0] }, base), function (x, sec) {
      x.marks.forEach(function (mk) { if (mk.tame && mk.at != null) lanes.kangaroo.marks.push(mk.at); });
      laneText('kangaroo', P.sci(x.ops) + ' jumps · ' + x.dps + ' distinguished points · ' + P.dur(sec));
    });
    Object.keys(jobs).forEach(function (m) {
      var j = jobs[m];
      j.done.then(function (key) {
        if (key === undefined) return; // stopped
        var sec = j.seconds();
        lanes[m].done = { key: key, sec: sec };
        var ok = key === secret;
        var prev = $('v-' + m).textContent.split(' · ')[0];
        laneText(m, (ok ? '✓ found in ' : '✗ ended after ') + P.dur(sec) + ' · ' + prev + (m !== 'brute' ? ' (≈2·√range = ' + P.sci(expect) + ')' : ''));
        race.finished++;
        if (lanes.bsgs.done && lanes.kangaroo.done) reveal();
      });
    });
    tickDraw();
  }
  function reveal() {
    if (race.reveal) return;
    race.reveal = true;
    $('r-secret').textContent = 'the hidden key: 0x' + race.secret.toString(16);
    // brute force gets three more seconds, then an estimate
    setTimeout(function () {
      if (lanes.brute.done || !jobs.brute) return finishRace();
      var sec = jobs.brute.seconds(), ops = lanes.brute.ops || 1, keysTo = Number(race.secret - race.from + 1n);
      jobs.brute.stop();
      laneText('brute', 'stopped after ' + P.sci(ops) + ' keys in ' + P.dur(sec) + ' · at ' + P.rate(ops / sec) + ' it would reach the key in about ' + P.dur(keysTo / (ops / sec)));
      finishRace();
    }, 3000);
  }
  function finishRace() { $('r-go').disabled = false; $('r-stop').disabled = true; drawAll(); }
  function stopAll() { Object.keys(jobs).forEach(function (m) { jobs[m].stop(); }); jobs = {}; }
  function tickDraw() {
    drawAll();
    if (!$('r-go').disabled) return;
    requestAnimationFrame(function () { setTimeout(tickDraw, 80); });
  }
  $('r-go').addEventListener('click', go);
  $('r-stop').addEventListener('click', function () { stopAll(); if (race) race.reveal = true; $('r-secret').textContent = race ? 'the hidden key: 0x' + race.secret.toString(16) : ''; finishRace(); });
  drawAll();
})();
