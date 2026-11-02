/* /bench: self-test, then the speed of a few engine shapes (points per thread), keep the best; results go to /api/bench. */
(function () {
  'use strict';
  var P = window.BBP;
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function log(m) { var el = $('b-log'); el.hidden = false; el.textContent += m + '\n'; el.scrollTop = el.scrollHeight; }

  var last = null, busy = false;
  // shapes: K (a step checks the 2K + 1 keys around each thread's centre point, one inversion for them all) and threads
  var SHAPES = [{ K: 16, threads: 65536 }, { K: 24, threads: 32768 }, { K: 32, threads: 16384 }];

  function result(rate, kind, cfg, name) {
    last = { rate: rate, kind: kind, cfg: cfg, info: name };
    $('b-out').hidden = false;
    $('b-rate').textContent = P.rate(rate);
    $('b-cfg').textContent = name + (cfg ? ' · ' + cfg : '');
    $('b-71').textContent = P.dur(Math.pow(2, 69) / rate);
    $('b-40').textContent = P.dur(Math.pow(2, 39) / rate);
    $('b-day').textContent = P.sci(rate * 86400);
    $('b-submit').hidden = false;
    $('b-odds').href = '/?speed=' + Math.round(rate) + '#odds';
    if (!$('b-name').value) $('b-name').value = kind === 'cpu' ? 'CPU, ' + P.threads() + ' threads' : guess(name);
  }
  function guess(info) {
    var m = /(rtx|gtx|rx|arc|radeon|geforce|apple|m\d)[^·]*/i.exec(info || '');
    return m ? m[0].trim() : '';
  }

  async function runGpu() {
    if (busy) return; busy = true;
    $('b-run').disabled = $('b-cpu').disabled = true; $('b-log').textContent = '';
    try {
      if (!P.hasGpu()) throw new Error('this browser has no WebGPU (Chrome or Edge 113+, Safari 26, Firefox 141+ on Windows)');
      var best = null;
      for (var i = 0; i < SHAPES.length; i++) {
        var sh = SHAPES[i];
        log('Engine with ' + (2 * sh.K + 1) + ' keys per thread and step, ' + sh.threads + ' threads:');
        var e = await window.BBGpu.create({ K: sh.K, threads: sh.threads });
        $('b-gpu').textContent = P.gpuName(e);
        await e.selftest(function (m) { log('  ✓ ' + m); });
        await e.bench(1.5); // warm up
        var r = await e.bench(5, function (x) { $('b-note').textContent = 'measuring: ' + P.rate(x); });
        log('  ' + P.rate(r));
        if (!best || r > best.r) best = { r: r, sh: sh, name: P.gpuName(e) };
        e.device.destroy();
      }
      try {
        localStorage.setItem('bb-gpu-rate', String(Math.round(best.r)));
        localStorage.setItem('bb-gpu-cfg', JSON.stringify(best.sh));
      } catch (_) { /* no storage */ }
      log('Best: ' + P.rate(best.r) + ' with ' + (2 * best.sh.K + 1) + ' keys per step. The search on /play uses it from now on.');
      result(best.r, 'gpu', 'K=' + best.sh.K, best.name);
      $('b-note').textContent = 'done';
    } catch (err) {
      log('✗ ' + (err && err.message || err));
      $('b-note').textContent = 'the GPU benchmark did not run';
    }
    busy = false; $('b-run').disabled = $('b-cpu').disabled = false;
  }

  async function runCpu() {
    if (busy) return; busy = true;
    $('b-run').disabled = $('b-cpu').disabled = true; $('b-log').textContent = '';
    var n = P.threads(), lo = (1n << 70n) + 777n, rate = 0;
    log('CPU: ' + n + ' threads, 8 seconds.');
    var h = P.cpuSearch(lo, lo + (1n << 40n), '0000000000000000000000000000000000000000', n, function (x) { rate = x.rate; $('b-note').textContent = 'measuring: ' + P.rate(x.rate); });
    await new Promise(function (r) { setTimeout(r, 8000); });
    h.stop();
    log('  ' + P.rate(rate));
    result(rate, 'cpu', n + ' threads', 'CPU · ' + n + ' threads');
    $('b-note').textContent = 'done';
    busy = false; $('b-run').disabled = $('b-cpu').disabled = false;
  }

  function table() {
    P.get('/api/bench').then(function (d) {
      var rows = d.rows || [];
      $('b-table').innerHTML = rows.length ? rows.map(function (r) {
        return '<tr><td>' + esc(r.gpu) + (r.kind === 'cpu' ? ' <span class="badge pending">cpu</span>' : '') + '</td><td class="num">' + P.rate(r.best) + '</td><td class="num">' + P.rate(r.median) + '</td><td class="num">' + r.runs + '</td><td class="num">' + P.dur(Math.pow(2, 69) / r.best) + '</td></tr>';
      }).join('') : '<tr><td colspan="5" class="dim">No results yet: be the first.</td></tr>';
    }).catch(function () { $('b-table').innerHTML = '<tr><td colspan="5" class="dim">The table is not available right now.</td></tr>'; });
  }

  $('b-send').addEventListener('click', function () {
    if (!last) return;
    var name = $('b-name').value.trim();
    if (!name) { $('b-name').focus(); return; }
    $('b-send').disabled = true;
    fetch('/api/bench', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gpu: name, kind: last.kind, rate: Math.round(last.rate), cfg: last.cfg, info: last.info }) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); }); })
      .then(function () { $('b-send').textContent = 'Added ✓'; table(); })
      .catch(function (e) { $('b-send').disabled = false; $('b-send').textContent = 'Add to the table'; log('✗ ' + e.message); });
  });
  $('b-run').addEventListener('click', runGpu);
  $('b-cpu').addEventListener('click', runCpu);
  if (!P.hasGpu()) $('b-note').textContent = 'this browser has no WebGPU: the CPU benchmark still runs';
  table();
})();
