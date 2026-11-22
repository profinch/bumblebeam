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
  // big numbers in words: 8.6 billion, 1.18 sextillion
  function words(x) {
    var n = ['', 'thousand', 'million', 'billion', 'trillion', 'quadrillion', 'quintillion', 'sextillion', 'septillion'], i = 0;
    x = Number(x);
    if (!(x > 0)) return '0';
    while (x >= 1000 && i < n.length - 1) { x /= 1000; i++; }
    return (x >= 100 ? Math.round(x) : Math.round(x * 10) / 10) + (n[i] ? ' ' + n[i] : '');
  }
  // a log <pre>: one line per thing worth reading, the time in front, the oldest lines go after 300.
  // log.busy(text) adds a live last line: a spinning snake (⣾⣽⣻…), the text and the seconds so far, so a wait is
  // never a silent one; it returns { set(text), done(final) }: set changes the text, done removes the line (and
  // logs `final` if given). log.clear() empties it all.
  var SNAKE = '⣾⣽⣻⢿⡿⣟⣯⣷';
  function logTo(el) {
    var lines = [], live = null, timer = null, span = null;
    function esc(t) { return String(t).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
    function stamp() { var d = new Date(); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
    function liveText() {
      var sec = Math.floor((Date.now() - live.t0) / 1000);
      return live.stamp + '  ' + SNAKE[live.i % SNAKE.length] + ' ' + live.text + (sec >= 2 ? ' (' + sec + ' s)' : '');
    }
    // the whole log written anew: when a line is added or the live line comes or goes
    function render() {
      var stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
      // a star (a find) in the accent colour
      var html = lines.map(function (l) { return esc(l).replace(/★/g, '<span class="star">★</span>'); }).join('\n');
      if (live) html += (html ? '\n' : '') + '<span class="busy">' + esc(liveText()) + '</span>';
      el.innerHTML = html;
      span = live ? el.lastChild : null;
      if (stick) el.scrollTop = el.scrollHeight;
    }
    // the spinner's frames (8 a second) and a new text for the live line change that line alone: the log above it
    // (up to 300 lines) is not parsed and laid out again each time
    function renderLive() {
      if (!live || !span || span.parentNode !== el) { render(); return; }
      var stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
      span.textContent = liveText();
      if (stick) el.scrollTop = el.scrollHeight;
    }
    function log(m) {
      lines.push(stamp() + '  ' + m);
      if (lines.length > 300) lines = lines.slice(lines.length - 300);
      render();
    }
    log.busy = function (text) {
      var me = { text: text, t0: Date.now(), i: 0, stamp: stamp() };
      live = me;
      if (!timer) timer = setInterval(function () { if (live) { live.i++; renderLive(); } }, 120);
      render();
      return {
        set: function (t) { me.text = t; },
        done: function (final) {
          if (live === me) { live = null; clearInterval(timer); timer = null; }
          if (final) log(final); else render();
        },
      };
    };
    // the log moves to another element (the /pool page shown again): everything so far is drawn there
    log.attach = function (el2) { el = el2; render(); };
    log.idle = function () { live = null; clearInterval(timer); timer = null; render(); };
    log.clear = function () { lines = []; live = null; clearInterval(timer); timer = null; render(); };
    return log;
  }
  // the GPU engine started quietly: its steps (compile, every self-test) show only when it fails; a live line
  // meanwhile, and a limit (gpu() gives up after GPU_WAIT)
  async function gpuQuiet(log) {
    var steps = [], ts = performance.now(), e;
    var b = log.busy ? log.busy('Starting the graphics card') : null;
    if (!b) log('Starting the graphics card…');
    try { e = await gpu(function (m) { steps.push(m); }); }
    catch (err) { if (b) b.done(); steps.forEach(function (m) { log('  ' + m); }); throw err; }
    var sec = (performance.now() - ts) / 1000;
    var ok = '✓ ' + gpuName(e) + ' is ready: the self-test found every planted key' + (sec > 1 ? ' (' + sec.toFixed(1) + ' s)' : '') + '.';
    if (b) b.done(ok); else log(ok);
    return e;
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
  // "Keep searching in the background" (off by default, remembered in this browser): when on, a hidden tab
  // does not pause the work
  function background(on) {
    if (on === undefined) { try { return localStorage.getItem('bb-bg') === '1'; } catch (_) { return false; } }
    try { localStorage.setItem('bb-bg', on ? '1' : '0'); } catch (_) { /* no storage */ }
    tell();
    syncBg();
    return on;
  }
  function hidden() { return document.visibilityState === 'hidden' && !background(); }
  // the jobs that pause and resume with the tab; a finished job's handler answers false and is dropped
  var visHandlers = [];
  function tell() { var h = hidden(); visHandlers = visHandlers.filter(function (f) { return f(h) !== false; }); }
  document.addEventListener('visibilitychange', tell);
  // a checkbox wired to it: <label class="bg-switch"><input type="checkbox" data-bg> ...</label>. One listener on the
  // document, so a checkbox on a page shown later (nav.js) works too; syncBg sets every one to the stored state
  function syncBg() { document.querySelectorAll('input[data-bg]').forEach(function (cb) { cb.checked = background(); }); }
  document.addEventListener('change', function (e) { if (e.target && e.target.matches && e.target.matches('input[data-bg]')) background(e.target.checked); });
  syncBg();

  // ---------- GPU ----------
  var gpuP = null;
  var GPU_WAIT = 90000;
  // The engine's shape (keys a step, threads) that suits this card, kept in this browser with the card it was
  // found for: tune() finds it on the first start (a few seconds, once), /bench measures it again
  function cardId(e) { var i = (e && e.info) || {}; return [i.vendor, i.architecture, i.device, i.description].join('|'); }
  function keptShape(e) {
    try { var k = JSON.parse(localStorage.getItem('bb-gpu-cfg') || 'null'); return k && k.v === 2 && k.gpu === cardId(e) && e.fits(k.K, k.threads) ? k : null; } catch (_) { return null; }
  }
  function keepShape(e, s) { try { localStorage.setItem('bb-gpu-cfg', JSON.stringify({ v: 2, K: s.K, threads: s.threads, gpu: cardId(e) })); } catch (_) { /* no storage */ } }
  function gpu(log, opts) {
    if (!gpuP) {
      // a start that never ends (a stuck driver, a GPU busy elsewhere) is given up after GPU_WAIT: the next
      // Start then asks the browser for the graphics card afresh instead of waiting on the stuck one
      var gaveUp = false;
      var limit = new Promise(function (_, no) { setTimeout(function () { gaveUp = true; no(new Error('The graphics card did not start in ' + GPU_WAIT / 1000 + ' s. Close other tabs or programs that use it (games, video, another search), or reload the page, then press Start again.')); }, GPU_WAIT); });
      gpuP = Promise.race([limit, (async function () {
        log && log('Starting WebGPU and compiling the engine (the first time takes a few seconds, then the browser keeps it)…');
        var e = await window.BBGpu.create(Object.assign({}, opts, { log: log }));
        // given up already (GPU_WAIT passed): this late engine goes back, its memory with it, instead of lingering
        if (gaveUp) { try { e.device.destroy(); } catch (_) { /* gone */ } throw new Error('started too late'); }
        // a GPU lost later (a driver reset, the card taken by another program) is forgotten here, so the next Start
        // asks the browser for the card afresh instead of getting the dead engine until the page is reloaded
        e.device.lost.then(function () { if (gpuP === mine) gpuP = null; });
        log && log('Compiled in ' + (e.compileMs / 1000).toFixed(1) + ' s.');
        if (!opts) {
          var k = keptShape(e);
          // nothing kept for this card (or no memory for it now): measured now. Not in a hidden tab, whose slow
          // timers would measure a slow card: it runs on the engine's small default shape until a visible start
          if (k && (await e.tryShape(k.K, k.threads))) { /* the kept shape */ }
          else if (document.visibilityState !== 'hidden') {
            log && log('Fitting the engine to this graphics card (once)…');
            k = await e.tune({ seconds: 0.3, warm: 0.6 });
            keepShape(e, k);
          }
        }
        log && log((2 * e.K + 1) + ' keys a step, ' + e.threads + ' threads. Self-test against the reference:');
        await e.selftest(function (m) { log && log('  ✓ ' + m); });
        return e;
      })()]);
      var mine = gpuP;
      gpuP.catch(function () { if (gpuP === mine) gpuP = null; });
    }
    return gpuP;
  }
  // WebGPU tells only the vendor and the generation ("nvidia — ampere"); WebGL in Chrome and Edge still tells the
  // model ("ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x...) Direct3D11 ...)"). Shown here, kept nowhere.
  var glName;
  function webglModel() {
    if (glName !== undefined) return glName;
    glName = null;
    try {
      var gl = document.createElement('canvas').getContext('webgl');
      var ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      var r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
      var m = /ANGLE \([^,]*,\s*([^(,]+?)\s*(\(0x[0-9a-f]+\))?\s*(Direct3D|OpenGL|Vulkan|Metal|,|\))/i.exec(r || '');
      glName = (m ? m[1] : r || '').trim() || null;
      var lose = gl && gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
    } catch (_) { /* no WebGL */ }
    return glName;
  }
  function gpuName(e) {
    var i = (e && e.info) || {};
    var gen = [i.vendor, i.architecture].filter(Boolean).join(', ');
    var model = i.description || webglModel();
    return model ? model + (gen ? ' (' + gen + ')' : '') : gen || 'GPU';
  }
  function hasGpu() { return !!(navigator.gpu); }
  // why there is no WebGPU here, in words a visitor can act on: browsers give WebGPU only to secure pages
  // (https, or localhost), Safari from version 26, Firefox from 141 on Windows only
  function noGpuWhy() {
    if (navigator.gpu) return '';
    if (!window.isSecureContext) return 'Browsers allow WebGPU only on a secure page (https), and this one was opened over plain http. Open it at its https address.';
    var ua = navigator.userAgent;
    if (/Firefox\//.test(ua)) return 'Firefox has WebGPU only on Windows (from version 141). Chrome or Edge has it everywhere.';
    if (/Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua)) return 'Safari has WebGPU from version 26 (macOS 26, iOS 26). Update it, or use Chrome or Edge.';
    if (/Chrome\//.test(ua)) return 'WebGPU is off in this browser: update it (Chrome or Edge 113 or newer), and check chrome://gpu that the graphics card is not blocked.';
    return 'This browser has no WebGPU. Chrome or Edge 113 or newer, or Safari 26, has it.';
  }

  // ---------- CPU: a worker per core, each with its own slice ----------
  function threads() { return Math.max(1, Math.min(16, (navigator.hardwareConcurrency || 4) - 1)); }
  function worker() { return new Worker('/engine/cpu-worker.js'); }

  // brute force [from, to] over n workers; handle { stop(), done: Promise<BigInt|null> }; onProgress({checked, total, rate, seconds})
  // target: a hash160 hex or an array (first = main); onHit(key, index) for the others
  function cpuSearch(from, to, target, n, onProgress, onHit) {
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
          } else if (m.type === 'hit') {
            if (onHit) onHit(BigInt('0x' + m.key), m.index);
          } else if (m.type === 'done') {
            if (m.key) finish(BigInt('0x' + m.key));
            else if (++done === n) finish(null);
          }
        };
        w.onerror = function (err) { console.error(err); finish(null); };
        w.postMessage({ mode: 'brute', from: a.toString(16), to: b.toString(16), targets: target });
      })(i, w);
      ws.push(w);
    }
    visHandlers.push(function (h) {
      if (finished) return false;
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
      if (finished) return false;
      w.postMessage({ pause: h });
      if (h) pausedAt = performance.now(); else if (pausedAt) { t0 += performance.now() - pausedAt; pausedAt = 0; }
    });
    w.postMessage(msg);
    return handle;
  }

  function get(path) { return fetch(path, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }

  window.BBP = { S: S, sup: sup, int: int, sci: sci, rate: rate, words: words, dur: dur, hex: hex, hidden: hidden, background: background, gpu: gpu, gpuQuiet: gpuQuiet, keepShape: keepShape, syncBg: syncBg, logTo: logTo, gpuName: gpuName, hasGpu: hasGpu, noGpuWhy: noGpuWhy, threads: threads, cpuSearch: cpuSearch, cpuJob: cpuJob, get: get };
})();
