/* BumbleBeam UI: a speedometer (.gauge), an arc of 240 degrees with a needle and the reading under its hub,
   in the chain accent (styles: .gauge in components.css). For one live rate, such as a pool's speed.

   Markup:
     <div class="gauge" id="g"></div>
   Script:
     var g = BB.gauge(document.getElementById('g'), {
       min: 1e6, max: 1e12, log: true,                         // a log scale: one step per power of ten
       ticks: [[1e6, '1M'], [1e9, '1G'], [1e12, '1T']],        // [value, label] inside the arc
       marks: [[5e9, 'one RTX 4090']]                          // [value, label] outside, in the accent: a yardstick
     });
     g.set(1.2e8, '120 M', 'keys/s');                          // the needle, the reading, its unit
     g.set(0, '–', 'nobody yet');                              // below min: the needle rests at the start
   A classic script; works in Chromium 83 like the rest of ui/. */
(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg', CX = 110, CY = 108, R = 88, A0 = -120, A1 = 120;
  function pt(a, r) { var t = a * Math.PI / 180; return [CX + r * Math.sin(t), CY - r * Math.cos(t)]; }
  function arc(a, b, r) {
    var p = pt(a, r), q = pt(b, r);
    return 'M' + p[0].toFixed(2) + ' ' + p[1].toFixed(2) + ' A' + r + ' ' + r + ' 0 ' + (b - a > 180 ? 1 : 0) + ' 1 ' + q[0].toFixed(2) + ' ' + q[1].toFixed(2);
  }
  function el(name, attrs, parent) {
    var e = document.createElementNS(NS, name);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function gauge(root, o) {
    o = o || {};
    var min = o.min || 0, max = o.max || 1, log = !!o.log;
    function frac(v) {
      if (!(v > min)) return 0;
      var f = log ? (Math.log(v) - Math.log(min)) / (Math.log(max) - Math.log(min)) : (v - min) / (max - min);
      return Math.max(0, Math.min(1, f));
    }
    var svg = el('svg', { viewBox: '0 -16 220 194', role: 'img' });
    el('path', { d: arc(A0, A1, R), class: 'gauge-track' }, svg);
    var fill = el('path', { d: arc(A0, A1, R), class: 'gauge-fill', pathLength: '100', 'stroke-dasharray': '0 100' }, svg);
    (o.ticks || []).forEach(function (t) {
      var a = A0 + (A1 - A0) * frac(t[0]), p = pt(a, R - 12), q = pt(a, R - 6), l = pt(a, R - 24);
      el('line', { x1: p[0], y1: p[1], x2: q[0], y2: q[1], class: 'gauge-tick' }, svg);
      el('text', { x: l[0], y: l[1] + 3, class: 'gauge-label' }, svg).textContent = t[1];
    });
    (o.marks || []).forEach(function (m) {
      var a = A0 + (A1 - A0) * frac(m[0]), p = pt(a, R + 7), q = pt(a, R - 7), l = pt(a, R + 15);
      el('line', { x1: p[0], y1: p[1], x2: q[0], y2: q[1], class: 'gauge-mark' }, svg);
      var tx = el('text', { x: l[0], y: l[1] + 3, class: 'gauge-mark-label' }, svg);
      tx.textContent = m[1];
      tx.setAttribute('text-anchor', a < -20 ? 'end' : a > 20 ? 'start' : 'middle');
    });
    var needle = el('g', { class: 'gauge-needle' }, svg);
    el('path', { d: 'M' + (CX - 3) + ' ' + CY + ' L' + CX + ' ' + (CY - R + 14) + ' L' + (CX + 3) + ' ' + CY + ' Z' }, needle);
    el('circle', { cx: CX, cy: CY, r: 6, class: 'gauge-hub' }, svg);
    var val = el('text', { x: CX, y: CY + 38, class: 'gauge-value' }, svg);
    var unit = el('text', { x: CX, y: CY + 54, class: 'gauge-unit' }, svg);
    root.appendChild(svg);
    function set(v, text, u) {
      var f = frac(v);
      needle.style.transform = 'rotate(' + (A0 + (A1 - A0) * f) + 'deg)';
      fill.setAttribute('stroke-dasharray', (f * 100).toFixed(2) + ' 100');
      val.textContent = text == null ? '' : text;
      unit.textContent = u == null ? '' : u;
      root.classList.toggle('idle', f === 0);
    }
    set(min, o.text, o.unit);
    return { set: set };
  }
  window.BB = window.BB || {};
  window.BB.gauge = gauge;
})();
