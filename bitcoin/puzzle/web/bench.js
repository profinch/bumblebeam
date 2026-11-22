/* /bench: the visitor picks the graphics card or the processor and presses Run; it is measured with the very code play
   and the pool run: on the GPU, the engine first fits its shape to the card (tune: larger shapes while they are
   faster and the screen stays smooth), which play and the pool then use, and Engine.search is measured in that shape
   (the pool's ten targets, paused with the tab); on the CPU, cpuSearch on play's threads. Each run warms up, then
   counts the keys of the next seconds. Every part of the page is there from the start and only
   filled in. Results go to /api/bench. */
(function () {
  'use strict';
  var P = window.BBP, S = P.S;
  function $(id) { return document.getElementById(id); }
  var esc = window.BB.esc; // ui/components/bb.js
  var log = P.logTo($('b-log')); // the site's log: a time on every line

  var WARM = 1.5, MEASURE = 5; // seconds: the first ones are not counted (caches, clocks going up)
  var engine = P.hasGpu() ? 'gpu' : 'cpu', busy = false, best = null;
  var stopped = false, cur = null; // Stop: the search measuring now, and a flag the steps between check
  function Stopped() { var e = new Error('stopped'); e.stopped = true; return e; }
  function check() { if (stopped) throw Stopped(); }

  // ---------- the estimate, on the Run button: before a run its whole length, during it the seconds left as the
  // button fills up. Each step's length is guessed, then learned: a compile takes as long as the last one did ----------
  var EST = { compile: 5, tune: 4, selftest: 1, measure: WARM + MEASURE + 0.3, prove: 5.5 }, plan = null, ticker = null;
  function steps(kind) { return kind === 'gpu' ? ['compile', 'tune', 'selftest', 'measure', 'prove'] : ['measure', 'prove']; }
  function secs(t) { return t < 60 ? Math.max(1, Math.ceil(t)) + ' s' : Math.round(t / 60) + ' min'; }
  function estimate(kind) { return steps(kind).reduce(function (s, k) { return s + EST[k]; }, 0); }
  function step(k) {
    var now = performance.now();
    if (plan.i >= 0 && plan.list[plan.i] !== 'measure') EST[plan.list[plan.i]] = (now - plan.at) / 1000; // learned
    plan.i++; plan.at = now; plan.msec = 0;
  }
  function left() {
    var k = plan.list[plan.i], inStep = (performance.now() - plan.at) / 1000;
    var cur = k === 'measure' ? Math.max(0, EST.measure - plan.msec) : Math.max(0.5, EST[k] - inStep);
    for (var i = plan.i + 1, rest = 0; i < plan.list.length; i++) rest += EST[plan.list[i]];
    return cur + rest;
  }
  // the run's steps, across from the buttons: compile, fit, check, measure on a graphics card, the one now lit,
  // the ones done ticked, and the seconds left beside them while it runs
  var CHIP = { compile: 'Compile', tune: 'Fit', selftest: 'Check', measure: 'Measure', prove: 'Prove' }, failed = '';
  function strip() {
    var kind = plan ? plan.kind : engine, per = steps(kind);
    var finished = !plan && best && best.kind === kind;
    var at = plan ? plan.i : finished ? per.length : -1;
    var h = per.map(function (k, n) {
      // one width in every state: the words never change, the tick sits on the corner, outside the chip
      var cls = finished || n < at ? 'ok' : n === at ? 'on' : '';
      return '<span class="b-step ' + cls + '"><b>✓</b>' + CHIP[k] + '</span>';
    }).join('<i>›</i>');
    h += '<span class="b-eta' + (failed && !plan ? ' bad' : '') + '">' + (plan && plan.i >= 0 ? secs(left()) : failed && !plan ? esc(failed) : '') + '</span>';
    $('b-steps').innerHTML = h;
  }
  function planStart(kind) { $('b-dot').classList.add('on'); plan = { kind: kind, list: steps(kind), i: -1, at: 0, msec: 0, t0: performance.now() }; strip(); ticker = setInterval(strip, 250); }
  function planEnd() { $('b-dot').classList.remove('on'); clearInterval(ticker); plan = null; strip(); }

  function shape(o) { return (2 * o.K + 1) + ' keys a step, ' + P.int(o.threads) + ' threads'; }

  // ---------- the chart: an empty frame of the chart's own size first, then the live line ----------
  function frame(text) { $('b-chart').innerHTML = BBCharts.frame(text, { labelChars: 8 }); } // the empty chart, the live one's box
  var live = { pts: [], off: 0, end: 0, marks: [] };
  function liveReset() { live.pts = []; live.marks = []; live.off = live.end = 0; frame('starting…'); }
  function liveFeed(label) {
    var hist = [], lastT = -1;
    live.off = live.end;
    var mark = label; // a part's name on a dotted line where its own line begins
    return function (keys, sec) {
      hist.push([sec, keys]);
      while (hist.length > 2 && sec - hist[1][0] >= 0.5) hist.shift();
      if (hist.length < 2 || sec - lastT < 0.1 || sec - hist[0][0] < 0.3) return; // a first point over too short a time spikes
      var r = (keys - hist[0][1]) / (sec - hist[0][0]);
      if (!isFinite(r) || r <= 0) return;
      lastT = sec; live.end = live.off + sec; live.pts.push([live.end, r]);
      if (mark) { live.marks.push([live.end, mark]); mark = null; }
      if (live.pts.length < 2) return;
      var box = $('b-chart');
      if (live.pts.length === 2) { box.classList.remove('bb-fade'); void box.offsetWidth; box.classList.add('bb-fade'); } // the line comes in softly, once
      box.innerHTML = BBCharts.line(live.pts, { label: function (v) { return P.rate(v, ' ').trim(); }, xLabel: function (t) { return t.toFixed(1) + ' s'; }, peak: true, title: 'Speed while measuring', marks: live.marks, labelChars: 8 });
    };
  }

  // run a search for WARM + MEASURE seconds of its own clock (paused time left out); the keys a second of the
  // measured part. start(onProgress) starts it; its onProgress gives {checked, seconds}
  function measure(start, what) {
    var feed = liveFeed(''), at = null, rate = 0, h, finish, fail;
    var done = new Promise(function (r, no) { finish = r; fail = no; });
    h = start(function (x) {
      var c = Number(x.checked), s = x.seconds;
      feed(c, s); if (plan) plan.msec = s;
      if (s < WARM) return;
      if (!at) { at = [c, s]; return; }
      if (s > at[1]) rate = (c - at[0]) / (s - at[1]);
      if (s >= WARM + MEASURE) finish();
    });
    h.done.then(function () { finish(); }, fail); // ended early or broke: no waiting forever
    cur = { stop: function () { finish(); } };
    return done.then(function () { cur = null; h.stop(); return h.done.catch(function () {}); }).then(function () { check(); return rate; });
  }

  // The table takes a result only with its proof: the server hides four keys in a range of about five seconds of
  // this speed, the search must find them all, and the server times it itself (its speed goes in the table).
  // search(from, to, targets, onHit) starts the search; returns { id, rate } (the server's rate)
  function post(path, body) {
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; }); });
  }
  async function prove(kind, rate, search) {
    step('prove');
    var c = await post('/api/bench/challenge', { kind: kind, rate: Math.round(rate) }), got = [];
    check();
    var h = search(BigInt(c.from), BigInt(c.to), c.targets, function (k, i) { if (i > 0) got.push('0x' + k.toString(16)); });
    cur = { stop: function () { h.stop(); } };
    await h.done; cur = null;
    check();
    var r = await post('/api/bench/check', { id: c.id, keys: got });
    log('  proven: ' + P.rate(r.rate) + ' (timed by the server: ' + got.length + ' hidden keys found)');
    return { id: c.id, rate: r.rate };
  }

  async function runGpu() {
    if (!P.hasGpu()) throw new Error('no WebGPU here. ' + P.noGpuWhy());
    // the pool's search runs in this tab (nav.js keeps it across pages): measuring now would measure half a card
    if (window.BBPool && window.BBPool.running()) throw new Error('your pool search is using the graphics card: stop it on /pool first');
    // the pool's search: ten targets (keys 1 to 10, nowhere near this range), far up in #71's range
    var targets = []; for (var k = 1; k <= 10; k++) targets.push(S.hash160OfKey(BigInt(k)));
    var from = (1n << 70n) + 1234567n, to = from + (1n << 60n), top = null, name = '';
    step('compile');
    var e = await window.BBGpu.create({ log: function (m) { log('  ' + m); } });
    try {
      log('  compiled in ' + (e.compileMs / 1000).toFixed(1) + ' s');
      name = P.gpuName(e); device(name);
      check();
      // the shape: up the engine's ladder while the card gets faster and one step stays short
      step('tune');
      log('Fitting the engine to the card:');
      var sh = await e.tune({ seconds: 0.7, onShape: function (s, r) { log('  ' + shape(s) + ': ' + P.rate(r)); } });
      log('  kept: ' + shape(sh));
      check();
      step('selftest');
      await e.selftest(function (m) { log('  ✓ ' + m); });
      check();
      step('measure');
      var r = await measure(function (cb) { return e.search(from, to, targets, cb, { isPaused: P.hidden }); }, 'GPU');
      log('  ' + P.rate(r));
      top = { kind: 'gpu', rate: r, K: sh.K, threads: sh.threads };
      top.proof = await prove('gpu', r, function (a, b, t, onHit) { return e.search(a, b, t, null, { onHit: onHit, isPaused: P.hidden }); });
      // the shape play and the pool use on this card from now on, with its speed for their estimates
      P.keepShape(e, sh);
      try { localStorage.setItem('bb-gpu-rate', String(Math.round(top.rate))); } catch (_) { /* no storage */ }
    } finally { e.device.destroy(); }
    top.name = name; top.cfg = 'K=' + top.K + ', ' + top.threads + ' threads'; var gn = BBGpuName.of(name, navigator.userAgent); top.sub = (gn ? gn.name : 'GPU') + ', ' + (2 * top.K + 1) + ' keys a step';
    return top;
  }
  async function runCpu() {
    // named by the processor's own thread count (what the browser tells), measured on the threads play uses
    var n = P.threads(), hw = navigator.hardwareConcurrency || n, from = (1n << 70n) + 777n, to = from + (1n << 50n);
    log('CPU, ' + n + ' of ' + hw + ' threads:'); step('measure');
    var r = await measure(function (cb) { return P.cpuSearch(from, to, '0000000000000000000000000000000000000000', n, cb); }, 'CPU');
    log('  ' + P.rate(r));
    var proof = await prove('cpu', r, function (a, b, t, onHit) { return P.cpuSearch(a, b, t, n, null, onHit); });
    return { kind: 'cpu', rate: r, proof: proof, n: hw, name: 'CPU, ' + hw + ' threads', cfg: n + ' of ' + hw + ' threads', sub: 'CPU, ' + hw + ' threads (' + n + ' used)' };
  }
  async function run() {
    if (busy) return;
    busy = true; stopped = false; failed = ''; best = null; planStart(engine); paintEngine();
    log.clear(); if (engine === 'gpu') log('Graphics card:');
    liveReset(); blank();
    try {
      result(await (engine === 'gpu' ? runGpu() : runCpu()));
    } catch (err) {
      ['b-rate', 'b-71', 'b-40', 'b-day'].forEach(function (k) { if ($(k).querySelector('.bb-wait')) $(k).innerHTML = '&nbsp;'; });
      $('b-cfg').textContent = 'press Run';
      if (err && err.stopped) { log('■ Stopped.'); failed = 'stopped'; if (live.pts.length < 2) frame('stopped'); }
      else { log('✗ ' + (err && err.message || err)); failed = 'did not run'; if (live.pts.length < 2) frame('did not run'); }
    }
    busy = false; planEnd(); paintEngine();
  }

  // while it measures, the tiles show three honeycomb cells lighting up in turn
  var WAIT = '<span class="bb-wait" aria-label="measuring"><i></i><i></i><i></i></span>';
  // the result tiles empty again (no dashes: a blank of the same height), the form waiting
  function blank() {
    ['b-rate', 'b-71', 'b-40', 'b-day'].forEach(function (k) { $(k).innerHTML = WAIT; });
    $('b-cfg').textContent = 'measuring…'; $('b-send').disabled = true; $('b-name').innerHTML = '&nbsp;'; best = null;
  }
  // a value put in fades in (ui's .bb-fade), as everywhere on the site
  function put(id, text) { var el = $(id); el.textContent = text; el.classList.remove('bb-fade'); void el.offsetWidth; el.classList.add('bb-fade'); }
  function result(o) {
    best = o;
    put('b-rate', P.rate(o.rate)); put('b-cfg', o.sub);
    put('b-71', P.dur(Math.pow(2, 69) / o.rate)); put('b-40', P.dur(Math.pow(2, 39) / o.rate)); put('b-day', P.sci(o.rate * 86400));
    $('b-odds').href = '/learn?speed=' + Math.round(o.rate) + '#odds';
    // the table's name, made the way the server will make it again (engine/gpuname.js): nothing typed
    var n = o.kind === 'cpu' ? BBGpuName.cpu(o.n) : BBGpuName.of(o.name, navigator.userAgent);
    $('b-name').innerHTML = n ? esc(n.name) + (n.sure ? '' : ' ' + UNSURE) : '<span class="dim">not recognised</span>';
    var bn = $('b-name'); bn.classList.remove('bb-fade'); void bn.offsetWidth; bn.classList.add('bb-fade');
    $('b-send').disabled = !n; $('b-send').textContent = 'Add to the table';
  }
  var UNSURE = '<span class="badge pending" title="The browser does not tell the exact model">not sure</span>';


  // ---------- the engine switch, as on play ----------
  // while the pool searches (in this tab, nav.js), nothing here may start: Run and the engines are off, their tip says why
  var POOL_TIP = 'Your pool search is running: stop it on the pool page to run the benchmark';
  function pooling() { return !!(window.BBPool && window.BBPool.running()); }
  function paintEngine() {
    var pool = pooling();
    Array.prototype.forEach.call($('b-engine').children, function (b) {
      b.classList.toggle('on', b.dataset.e === engine);
      b.disabled = busy || pool || (b.dataset.e === 'gpu' && !P.hasGpu());
    });
    $('b-run').disabled = busy || pool; $('b-stop').disabled = !busy;
    [$('b-run')].concat(Array.prototype.slice.call($('b-engine').children)).forEach(function (b) { if (pool) b.title = POOL_TIP; else if (b.title === POOL_TIP) b.removeAttribute('title'); });
    device();
  }
  // what was found to run on, on its own line: the graphics card as the browser names it, or the processor's threads
  var gpuSeen = '';
  function device(name) {
    if (name) gpuSeen = name;
    var n = gpuSeen && BBGpuName.of(gpuSeen, navigator.userAgent);
    var t = engine === 'gpu' ? (P.hasGpu() ? 'Graphics card: <b>' + esc(n ? n.name : gpuSeen || 'looking…') + '</b>' + (n && !n.sure ? ' (not sure)' : '') : 'No WebGPU in this browser')
      : 'Processor: <b>' + (navigator.hardwareConcurrency || '?') + ' threads</b> (' + P.threads() + ' used)';
    $('b-dev').innerHTML = t; $('b-dev').title = engine === 'gpu' && gpuSeen ? 'The browser says: ' + gpuSeen : ''; // its own words only on hover
  }
  // the card's name before any run: the adapter's info (vendor, generation) and WebGL's model, as play's log shows it
  if (P.hasGpu()) navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).then(function (a) { device(a ? P.gpuName({ info: a.info || {} }) : 'none found'); }).catch(function () { device('none found'); });
  $('b-engine').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b || b.disabled) return;
    engine = b.dataset.e; failed = ''; paintEngine(); strip(); if (!live.pts.length) frame('press Run to see your speed here');
  });

  function table() {
    P.get('/api/bench').then(function (d) {
      var list = d.rows || [];
      // render.js's rows, as the server writes them into the page
      var h = window.BBRender.benchRows(list);
      if ($('b-table').innerHTML !== h) $('b-table').innerHTML = h;
    }).catch(function () { $('b-table').innerHTML = '<tr><td colspan="5" class="dim">The table is not available right now.</td></tr>'; });
  }

  $('b-send').addEventListener('click', function () {
    if (!best) return;
    $('b-send').disabled = true;
    post('/api/bench', { id: best.proof && best.proof.id, cfg: best.cfg, info: best.kind === 'gpu' ? best.name || '' : '', threads: best.n })
      .then(function () { $('b-send').textContent = 'Added ✓'; table(); })
      .catch(function (e) { $('b-send').disabled = false; $('b-send').textContent = 'Add to the table'; log('✗ ' + e.message); });
  });
  $('b-run').addEventListener('click', run);
  $('b-stop').addEventListener('click', function () { if (!busy) return; stopped = true; if (cur) cur.stop(); });
  
  frame('press Run to see your speed here');
  strip();
  paintEngine();
  var poolTimer = setInterval(function () { if (!busy) paintEngine(); }, 1500);
  window.addEventListener('bb:leave', function () { clearInterval(poolTimer); if (cur) cur.stop(); stopped = true; }, { once: true });
  table();
})();
