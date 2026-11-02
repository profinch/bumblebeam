/* Shared by the Play, Learn and Benchmark pages: number formatting, the GPU engine (created and self-tested once),
   CPU searches on Web Workers, and the rule that work runs only while the tab is visible. Exposes BBP. */
(function () {
  'use strict';
  var S = window.BBSecp;

  function sup(n) { return String(n).split('').map(function (c) { return '⁰¹²³⁴⁵⁶⁷⁸⁹⁻'['0123456789-'.indexOf(c)] || c; }).join(''); }
  function int(x) { return Math.round(x).toLocaleString('en-US'); }
  function sci(x) {
    if (!isFinite(x)) return '∞';
    if (x < 1e6) return x >= 100 ? int(x) : (Math.round(x * 100) / 100).toString();
    var e = Math.floor(Math.log10(x)), m = x / Math.pow(10, e);
    return m.toFixed(2).replace(/\.?0+$/, '') + ' × 10' + sup(e);
  }
  function rate(x, unit) {
    var u = ['', 'k', 'M', 'G', 'T'], i = 0;
    while (x >= 1000 && i < u.length - 1) { x /= 1000; i++; }
    return (x >= 100 ? Math.round(x) : Math.round(x * 10) / 10) + ' ' + u[i] + (unit || 'keys/s');
  }
  function dur(sec) {
    if (!isFinite(sec)) return '∞';
    if (sec < 1) return '< 1 s';
    if (sec < 90) return Math.round(sec) + ' s';
    if (sec < 5400) return Math.round(sec / 60) + ' min';
    if (sec < 86400 * 2) return Math.round(sec / 3600) + ' h';
    var d = sec / 86400;
    if (d < 730) return int(d) + ' days';
    var y = d / 365.25;
    return (y >= 1e6 ? sci(y) : int(y)) + ' years';
  }
  function hex(b) { return '0x' + b.toString(16); }

  // ---------- visibility: work only while the tab is visible ----------
  function hidden() { return document.visibilityState === 'hidden'; }
  var visHandlers = [];
  document.addEventListener('visibilitychange', function () { visHandlers.forEach(function (f) { f(hidden()); }); });

  // ---------- GPU ----------
  var gpuP = null;
  function gpu(log, opts) {
    if (!opts) { try { opts = JSON.parse(localStorage.getItem('bb-gpu-cfg') || 'null') || undefined; } catch (_) { /* no storage */ } }
    if (!gpuP) {
      gpuP = (async function () {
        log && log('Starting WebGPU and compiling the shaders…');
        var t = performance.now();
        var e = await window.BBGpu.create(opts);
        log && log('Compiled in ' + Math.round(performance.now() - t) + ' ms. Self-test against the reference:');
        await e.selftest(function (m) { log && log('  ✓ ' + m); });
        return e;
      })();
      gpuP.catch(function () { gpuP = null; });
    }
    return gpuP;
  }
  function gpuName(e) {
    var i = (e && e.info) || {};
    return [i.vendor, i.architecture, i.description].filter(Boolean).join(' · ') || 'GPU';
  }
  function hasGpu() { return !!(navigator.gpu); }

  // ---------- CPU: a worker per core, each with its own slice ----------
  function threads() { return Math.max(1, Math.min(16, (navigator.hardwareConcurrency || 4) - 1)); }
  function worker() { return new Worker('/engine/cpu-worker.js'); }

  // brute force [from, to] over n workers; handle { stop(), done: Promise<BigInt|null> }; onProgress({checked, total, rate, seconds})
  function cpuSearch(from, to, target, n, onProgress) {
    from = BigInt(from); to = BigInt(to);
    var total = to - from + 1n, ws = [], done = 0, checked = [], t0 = performance.now(), pausedAt = 0, finished = false;
    n = Math.max(1, Math.min(n, Number(total < 1000n ? 1n : BigInt(n))));
    var slice = total / BigInt(n), resolve;
    var handle = { done: new Promise(function (r) { resolve = r; }) };
    function finish(key) {
      if (finished) return; finished = true;
      ws.forEach(function (w) { w.terminate(); });
      resolve(key);
    }
    handle.stop = function () { finish(null); };
    for (var i = 0; i < n; i++) {
      var a = from + slice * BigInt(i), b = i === n - 1 ? to : a + slice - 1n, w = worker();
      checked.push(0);
      (function (i, w) {
        w.onmessage = function (e) {
          var m = e.data;
          if (m.type === 'progress') {
            checked[i] = m.ops;
            var c = checked.reduce(function (s, x) { return s + x; }, 0), sec = (performance.now() - t0) / 1000;
            if (onProgress) onProgress({ checked: BigInt(c), total: total, rate: c / sec, seconds: sec });
          } else if (m.type === 'done') {
            if (m.key) finish(BigInt('0x' + m.key));
            else if (++done === n) finish(null);
          }
        };
        w.onerror = function (err) { console.error(err); finish(null); };
        w.postMessage({ mode: 'brute', from: a.toString(16), to: b.toString(16), target: target });
      })(i, w);
      ws.push(w);
    }
    visHandlers.push(function (h) {
      if (finished) return;
      ws.forEach(function (w) { w.postMessage({ pause: h }); });
      if (h) pausedAt = performance.now(); else if (pausedAt) { t0 += performance.now() - pausedAt; pausedAt = 0; }
    });
    if (hidden()) ws.forEach(function (w) { w.postMessage({ pause: true }); });
    return handle;
  }

  // one worker running one job (the Learn page's races)
  function cpuJob(msg, onProgress) {
    var w = worker(), resolve, finished = false, t0 = performance.now(), pausedAt = 0;
    var handle = { done: new Promise(function (r) { resolve = r; }) };
    function finish(k) { if (finished) return; finished = true; w.terminate(); resolve(k); }
    handle.stop = function () { finish(undefined); };
    handle.seconds = function () { return (performance.now() - t0) / 1000; };
    w.onmessage = function (e) {
      if (e.data.type === 'progress') { if (onProgress) onProgress(e.data, (performance.now() - t0) / 1000); }
      else finish(e.data.key ? BigInt('0x' + e.data.key) : null);
    };
    w.onerror = function (err) { console.error(err); finish(null); };
    visHandlers.push(function (h) {
      if (finished) return;
      w.postMessage({ pause: h });
      if (h) pausedAt = performance.now(); else if (pausedAt) { t0 += performance.now() - pausedAt; pausedAt = 0; }
    });
    w.postMessage(msg);
    return handle;
  }

  function get(path) { return fetch(path, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }

  window.BBP = { S: S, sup: sup, int: int, sci: sci, rate: rate, dur: dur, hex: hex, hidden: hidden, gpu: gpu, gpuName: gpuName, hasGpu: hasGpu, threads: threads, cpuSearch: cpuSearch, cpuJob: cpuJob, get: get };
})();
