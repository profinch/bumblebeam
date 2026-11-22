/* The key square, shared by the home page and /play: a private key's 64 hex digits as 8 x 8 cells, each digit's 16
   values as 4 x 4 dots. Puzzle n: the key has n bits, so the last ceil(n/4) digits are open; the first of them holds
   the top bit (always 1) and takes only the values from 2^(g-1) to 2^g - 1, g = n mod 4 (or 4); every earlier digit
   is zero (its zero lit white). Open digits are dim in the accent; a shown key lights one value in each, with a short
   fade from the last; a found key turns turquoise. Drawn on a canvas in whole device pixels (at any
   devicePixelRatio), so every dot and every gap is the same size: CSS boxes of fractional size round unevenly at 125%
   or 150% scaling.
     var ks = BBKeySquare(box, head)   head (optional): kept as wide as the square
     ks.setN(n) -> the open digits [{ live: [16 booleans], vals: [values], cur, prev }]
     ks.show(vals, fade)   one value per open digit (or -1); fade: from the values shown before
     ks.setFound(bool), ks.destroy() */
(function () {
  'use strict';
  function rrect(x, X, Y, W, H, r) { if (!r) { x.beginPath(); x.rect(X, Y, W, H); return; } x.beginPath(); x.moveTo(X + r, Y); x.arcTo(X + W, Y, X + W, Y + H, r); x.arcTo(X + W, Y + H, X, Y + H, r); x.arcTo(X, Y + H, X, Y, r); x.arcTo(X, Y, X + W, Y, r); x.closePath(); }
  function KeySquare(box, head) {
    var keyCanvas = document.createElement('canvas'), keyGeo = null, keyDigits = [], keyFound = false, keyFx = null, keyRO = null;
    box.innerHTML = ''; box.appendChild(keyCanvas);
    function keyColors() {
      var cs = getComputedStyle(document.documentElement), rgb = keyFound ? '0, 246, 210' : (cs.getPropertyValue('--accent-rgb') || '247, 147, 26').trim();
      return { cell: 'rgba(255,255,255,0.05)', off: 'rgba(255,255,255,0.07)', zero: 'rgba(255,255,255,0.5)', live: 'rgba(' + rgb + ',0.28)', on: 'rgb(' + rgb + ')', glow: 'rgba(' + rgb + ',0.8)', rgb: rgb };
    }
    function keyLayout() {
      var dpr = window.devicePixelRatio || 1, w = Math.floor(Math.min(box.clientWidth || 300, 420) * dpr);
      var g = Math.max(1, Math.round(2 * dpr)), p = Math.max(1, Math.round(3 * dpr)), G = Math.max(2, Math.round(5 * dpr));
      var d = Math.max(2, Math.floor((w - 7 * G - 8 * (3 * g + 2 * p)) / 32)), cell = 4 * d + 3 * g + 2 * p, total = 8 * cell + 7 * G;
      keyGeo = { dpr: dpr, d: d, g: g, p: p, G: G, cell: cell, r: Math.max(1, Math.round(3 * dpr)), dr: Math.round(0.75 * dpr) };
      // and a CSS size the layout can hold exactly (it counts in 1/64 px), else the canvas is scaled by a hair
      var T = total;
      while (T < total + 64 && Math.abs(T * 64 / dpr - Math.round(T * 64 / dpr)) > 1e-6) T++;
      keyCanvas.width = T; keyCanvas.height = T;
      keyCanvas.style.width = (T / dpr) + 'px'; keyCanvas.style.height = (T / dpr) + 'px';
      // the title over the square is as wide as the square
      if (head) head.style.maxWidth = (T / dpr) + 'px';
      keyDraw();
      keySnap();
    }
    // the canvas must start on a whole device pixel too, or the browser resamples it and the dots go uneven again
    function keySnap() {
      if (!keyCanvas || !keyGeo) return;
      var dpr = keyGeo.dpr;
      keyCanvas.style.transform = '';
      var r = keyCanvas.getBoundingClientRect(), x = (r.left + window.scrollX) * dpr, y = (r.top + window.scrollY) * dpr;
      var fx = x - Math.round(x), fy = y - Math.round(y);
      if (fx || fy) keyCanvas.style.transform = 'translate(' + (-fx / dpr) + 'px,' + (-fy / dpr) + 'px)';
    }
    // t: 0..1 of the fade between the last value shown and this one
    function keyDraw(t) {
      if (!keyCanvas || !keyGeo) return;
      var x = keyCanvas.getContext('2d'), k = keyGeo, c = keyColors(), known = 64 - keyDigits.length;
      if (t == null) t = 1;
      x.clearRect(0, 0, keyCanvas.width, keyCanvas.height);
      for (var i = 0; i < 64; i++) {
        var cx = (i % 8) * (k.cell + k.G), cy = Math.floor(i / 8) * (k.cell + k.G), dg = i >= known ? keyDigits[i - known] : null;
        x.fillStyle = c.cell; rrect(x, cx, cy, k.cell, k.cell, k.r); x.fill();
        for (var m = 0; m < 16; m++) {
          var dx = cx + k.p + (m % 4) * (k.d + k.g), dy = cy + k.p + Math.floor(m / 4) * (k.d + k.g), a = 0;
          if (dg && dg.live[m]) { a = m === dg.cur ? t : m === dg.prev ? 1 - t : 0; }
          x.shadowBlur = 0;
          // a known digit lights its value, the zero, in white
          x.fillStyle = dg ? (dg.live[m] ? c.live : c.off) : m === 0 ? c.zero : c.off; rrect(x, dx, dy, k.d, k.d, k.dr); x.fill();
          if (a > 0) {
            x.shadowColor = 'rgba(' + c.rgb + ',' + (0.8 * a).toFixed(3) + ')'; x.shadowBlur = 6 * k.dpr;
            x.fillStyle = 'rgba(' + c.rgb + ',' + a.toFixed(3) + ')'; rrect(x, dx, dy, k.d, k.d, k.dr); x.fill();
          }
        }
      }
      x.shadowBlur = 0;
    }
    if (window.ResizeObserver) { keyRO = new ResizeObserver(function () { keyLayout(); }); keyRO.observe(box); keyRO.observe(document.body); }
    else window.addEventListener('resize', keyLayout);
    return {
      setN: function (n) {
        var open = Math.ceil(n / 4), known = 64 - open, g = n % 4 || 4, lo = 1 << (g - 1), hi = (1 << g) - 1;
        keyFound = false; keyDigits = [];
        for (var i = known; i < 64; i++) {
          var live = [], vals = [];
          for (var m = 0; m < 16; m++) { live[m] = i > known || (m >= lo && m <= hi); if (live[m]) vals.push(m); }
          keyDigits.push({ live: live, vals: vals, cur: -1, prev: -1 });
        }
        keyLayout();
        return keyDigits;
      },
      show: function (vals, fade) {
        keyDigits.forEach(function (d, i) { d.prev = d.cur; d.cur = vals ? vals[i] : -1; });
        if (keyFx) cancelAnimationFrame(keyFx);
        if (!fade) return keyDraw(1);
        var t0 = performance.now();
        (function f() { var t = Math.min(1, (performance.now() - t0) / 450); keyDraw(t); if (t < 1) keyFx = requestAnimationFrame(f); })();
      },
      setFound: function (f) { keyFound = f; keyDraw(1); },
      destroy: function () { if (keyRO) keyRO.disconnect(); window.removeEventListener('resize', keyLayout); if (keyFx) cancelAnimationFrame(keyFx); }
    };
  }
  window.BBKeySquare = KeySquare;
})();
