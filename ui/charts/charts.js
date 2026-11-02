/* BumbleBeam charts: SVG time-series, sparklines and donuts for every site, no dependencies.
   A classic script (works from file://, in the ESP32 firmware page, the MV3 extension and Chromium 83):
   it sets window.BBCharts. Each chart function returns an SVG/HTML string, so a page can put it in
   with innerHTML the way the pool, thermo and 3BMiner already build their views.

   Colours are CSS tokens (ui/tokens.css: --chart-1..6, --chart-main = the chain's accent), set as
   style="stroke:var(...)", so switching <html data-chain> recolours charts without a redraw.
   A series may also bring its own colour (any CSS colour, or a var(...)).

   Kinds (README.md has the map of which site uses which):
     BBCharts.spark(values, {color})                    inline trend, 90x22, no axes
     BBCharts.line(series, opts)                        time series: one or many lines, area fill,
                                                        right axis, now-pill, peak, band, crosshair
     BBCharts.donut(items, {total, sub})                shares with a legend (blocks per pool)
   Candles (OHLC + volume + indicators) are the DEX terminal's BeeChart (canvas); BBCharts.theme()
   gives it the same colours. */
(function () {
  'use strict';

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var SERIES_VARS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)'];
  var CHAR_W = 6.2; // px per character of the 9.5px mono labels, for pill widths

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function f1(n) { return (Math.round(n * 10) / 10).toString(); }

  /** Short numbers for axes: 1.23k, 4.5M. */
  function compact(v) {
    var a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'G';
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 1 : 2) + 'k';
    if (a === 0) return '0';
    return v.toFixed(a < 10 ? 1 : 0);
  }

  /** A tick step of 1, 2 or 5 times a power of ten, about `count` ticks over `span`. */
  function niceStep(span, count) {
    var raw = span / Math.max(1, count), p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
  }

  /** Time label for a tick, by how long the chart spans (seconds). */
  function timeLabel(t, span, perTick) {
    var d = new Date(t * 1000), hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (span <= 36 * 3600) return hm;
    return MONTHS[d.getMonth()] + ' ' + d.getDate() + (perTick < 2 * 86400 ? ' ' + pad2(d.getHours()) + ':00' : '');
  }
  function fullTime(t) {
    var d = new Date(t * 1000);
    return MONTHS[d.getMonth()] + ' ' + d.getDate() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /** The chart colours resolved from the tokens, for canvas charts (BeeChart's ChartTheme). */
  function theme(el) {
    var cs = getComputedStyle(el || document.documentElement), v = function (n) { return cs.getPropertyValue(n).trim(); };
    return {
      text: v('--chart-text'), textDim: v('--muted2'), grid: v('--chart-grid'), border: v('--border'),
      up: v('--chart-up'), down: v('--chart-down'), crosshair: v('--chart-cross'),
      labelBg: v('--chart-label-bg'), labelText: v('--chart-label-text'), accent: v('--accent'),
      series: [1, 2, 3, 4, 5, 6].map(function (i) { return v('--chart-' + i); }),
      font: '11px ' + v('--font-mono'),
    };
  }

  // ---------------------------------------------------------------- spark
  function spark(values, opts) {
    opts = opts || {};
    var vs = (values || []).map(function (p) { return Array.isArray(p) ? p[1] : p; }).filter(function (v) { return isFinite(v); });
    if (vs.length < 2) return '';
    var min = Math.min.apply(null, vs), max = Math.max.apply(null, vs), span = max - min || 1;
    var pts = vs.map(function (v, i) { return f1((i / (vs.length - 1)) * 90) + ',' + f1(20 - ((v - min) / span) * 18); }).join(' ');
    return '<svg class="spark" viewBox="0 0 90 22" preserveAspectRatio="none" aria-hidden="true"><polyline points="' + pts +
      '" fill="none" style="stroke:' + (opts.color || 'var(--chart-main)') + '" stroke-width="1.2" vector-effect="non-scaling-stroke"/></svg>';
  }

  // ---------------------------------------------------------------- line
  var CHARTS = {};
  var seq = 0;

  /**
   * series: [[t, v], ...] for one line, or [{name, points: [[t, v]...], color, area, band: [[t, lo, hi]...]}, ...]
   * opts:   label(v) -> axis/pill text (default compact), title (aria), now (default true: the first
   *         series' last value as a dotted guide + pill), peak (mark the highest point), zero (y from 0;
   *         default when every value >= 0), narrow (phone layout; default from the viewport),
   *         height (px of the viewBox), empty (text when there is nothing to draw)
   */
  function line(series, opts) {
    opts = opts || {};
    if (Array.isArray(series) && series.length && Array.isArray(series[0])) series = [{ points: series }];
    series = (series || []).map(function (s, i) {
      return { name: s.name || '', color: s.color || (i === 0 && series.length === 1 ? 'var(--chart-main)' : SERIES_VARS[i % SERIES_VARS.length]),
        area: s.area != null ? s.area : series.length === 1, band: s.band || null,
        points: (s.points || []).filter(function (p) { return isFinite(p[0]) && isFinite(p[1]); }) };
    }).filter(function (s) { return s.points.length >= 2; });
    if (!series.length) return '<div class="empty">' + esc(opts.empty || 'No data yet') + '</div>';

    var label = opts.label || compact;
    var narrow = opts.narrow != null ? opts.narrow : (window.matchMedia && matchMedia('(max-width: 700px)').matches);
    var W = narrow ? 380 : 1000, H = opts.height || (narrow ? 210 : 260), L = narrow ? 8 : 14, T = 16, B = 30;
    var t0 = Infinity, t1 = -Infinity, lo = Infinity, hi = -Infinity;
    series.forEach(function (s) {
      s.points.forEach(function (p) { t0 = Math.min(t0, p[0]); t1 = Math.max(t1, p[0]); lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); });
      (s.band || []).forEach(function (b) { lo = Math.min(lo, b[1]); hi = Math.max(hi, b[2]); });
    });
    var zero = opts.zero != null ? opts.zero : lo >= 0;
    var yMin, yMax;
    if (zero) { yMin = Math.min(0, lo); yMax = (hi > 0 ? hi : 1) * 1.12; }
    else { var padY = (hi - lo || Math.abs(hi) || 1) * 0.08; yMin = lo - padY; yMax = hi + padY; }

    var main = series[0], last = main.points[main.points.length - 1][1];
    var showNow = opts.now !== false;
    var pillText = label(last), pw = pillText.length * CHAR_W + 8;
    var widest = [yMin, yMax, last].map(function (v) { return label(v).length; }).reduce(function (a, b) { return Math.max(a, b); }, 5);
    var R = Math.ceil(4 + Math.max(pw, widest * CHAR_W + 8) + 6);
    var x = function (t) { return L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R); };
    var y = function (v) { return T + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - T - B); };

    var g = '';
    var step = niceStep(yMax - yMin, narrow ? 4 : 5);
    for (var v = Math.ceil(yMin / step) * step; v <= yMax + 1e-9; v += step) {
      var yy = f1(y(v));
      g += '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + yy + '" y2="' + yy + '"/><text x="' + (W - R + 10) + '" y="' + f1(+yy + 4) + '">' + esc(label(v)) + '</text>';
    }
    var xTicks = narrow ? 3 : 6, span = t1 - t0;
    for (var i = 0; i <= xTicks; i++) {
      var t = t0 + (span / xTicks) * i, xx = f1(x(t));
      if (i > 0 && i < xTicks) g += '<line class="grid" x1="' + xx + '" x2="' + xx + '" y1="' + T + '" y2="' + (H - B) + '"/>';
      g += '<text x="' + xx + '" y="' + (H - 8) + '" text-anchor="' + (i === 0 ? 'start' : i === xTicks ? 'end' : 'middle') + '">' + esc(timeLabel(t, span, span / xTicks)) + '</text>';
    }
    g += '<line class="grid" x1="' + L + '" x2="' + L + '" y1="' + T + '" y2="' + (H - B) + '"/><line class="grid" x1="' + (W - R) + '" x2="' + (W - R) + '" y1="' + T + '" y2="' + (H - B) + '"/>';

    var id = 'bbc' + (++seq), defs = '', body = '';
    series.forEach(function (s, si) {
      var d = s.points.map(function (p) { return f1(x(p[0])) + ',' + f1(y(p[1])); }).join(' L');
      if (s.band && s.band.length > 1) {
        var up = s.band.map(function (b) { return f1(x(b[0])) + ',' + f1(y(b[2])); }).join(' L');
        var dn = s.band.slice().reverse().map(function (b) { return f1(x(b[0])) + ',' + f1(y(b[1])); }).join(' L');
        body += '<path class="band" d="M' + up + ' L' + dn + ' Z" style="fill:' + s.color + '"/>';
      }
      if (s.area) {
        defs += '<linearGradient id="' + id + 'a' + si + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:' + s.color + '" stop-opacity="0.55"/><stop offset="1" style="stop-color:' + s.color + '" stop-opacity="0"/></linearGradient>';
        var base = f1(y(Math.max(yMin, 0)));
        body += '<path d="M' + d + ' L' + f1(x(s.points[s.points.length - 1][0])) + ',' + base + ' L' + f1(x(s.points[0][0])) + ',' + base + ' Z" fill="url(#' + id + 'a' + si + ')"/>';
      }
      body += '<path d="M' + d + '" fill="none" style="stroke:' + s.color + '" stroke-width="1.5" vector-effect="non-scaling-stroke"/>';
    });
    if (opts.peak) {
      var top = -Infinity; main.points.forEach(function (p) { top = Math.max(top, p[1]); });
      var py = y(top), ty = py - 6 < T + 8 ? py + 13 : py - 6;
      body += '<line class="now" x1="' + L + '" x2="' + (W - R) + '" y1="' + f1(py) + '" y2="' + f1(py) + '" vector-effect="non-scaling-stroke"/>' +
        '<text class="peak-text" x="' + (W - R - 4) + '" y="' + f1(ty) + '" text-anchor="end">max ' + esc(label(top)) + '</text>';
    }
    if (showNow) {
      var ly = Math.max(T + 9, Math.min(H - B - 9, y(last)));
      body += '<line class="now" x1="' + L + '" x2="' + (W - R) + '" y1="' + f1(y(last)) + '" y2="' + f1(y(last)) + '" style="stroke:' + main.color + '" vector-effect="non-scaling-stroke"/>' +
        '<rect x="' + (W - R + 4) + '" y="' + f1(ly - 9) + '" width="' + Math.round(pw) + '" height="18" rx="3" style="fill:' + main.color + '"/>' +
        '<text class="pill-text" x="' + f1(W - R + 4 + pw / 2) + '" y="' + f1(ly + 4) + '" text-anchor="middle">' + esc(pillText) + '</text>';
    }
    var dots = series.map(function (s) { return '<circle class="dot" r="3.5" style="fill:' + s.color + '"/>'; }).join('');
    body += '<g class="hover" visibility="hidden"><line class="cross vx" y1="' + T + '" y2="' + (H - B) + '"/><line class="cross hy" x1="' + L + '" x2="' + (W - R) + '"/>' + dots +
      '<rect class="hv-pill hv-pv" height="18" rx="3"/><text class="hv-text hv-v" text-anchor="middle"></text>' +
      '<rect class="hv-pill hv-pt" height="18" rx="3"/><text class="hv-text hv-t" text-anchor="middle"></text></g>';

    // drop the records of charts no longer in the page, then keep this one's points for the crosshair
    Object.keys(CHARTS).forEach(function (k) { if (!document.querySelector('svg[data-bbc="' + k + '"]')) delete CHARTS[k]; });
    CHARTS[id] = { W: W, H: H, L: L, R: R, T: T, B: B, label: label, series: series.map(function (s) {
      return { name: s.name, pts: s.points.map(function (p) { return [x(p[0]), y(p[1]), p[0], p[1]]; }) };
    }) };
    var aria = (opts.title || 'Chart') + (showNow ? ': now ' + pillText : '');
    return '<svg class="chart" data-bbc="' + id + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(aria) + '"><defs>' + defs + '</defs>' + g + body + '</svg>';
  }

  function nearest(pts, px) {
    var lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (pts[mid][0] < px) lo = mid; else hi = mid; }
    return px - pts[lo][0] < pts[hi][0] - px ? pts[lo] : pts[hi];
  }
  function set(el, a) { for (var k in a) el.setAttribute(k, typeof a[k] === 'number' ? a[k].toFixed(1) : a[k]); }

  /** The crosshair: every series' point at the pointer's time, the value of the line nearest the
      pointer on the axis, the time under the chart. One listener for every chart on the page. */
  function hover(e) {
    var svg = e.target.closest && e.target.closest('svg.chart[data-bbc]');
    var c = svg && CHARTS[svg.getAttribute('data-bbc')];
    if (!c || (e.type === 'pointerleave' && e.target !== svg)) return;
    var g = svg.querySelector('.hover'), m = svg.getScreenCTM();
    if (!g || !m) return;
    var px = (e.clientX - m.e) / m.a, py = (e.clientY - m.f) / m.d;
    if (e.type === 'pointerleave' || px < c.L || px > c.W - c.R) { g.setAttribute('visibility', 'hidden'); return; }
    var hits = c.series.map(function (s) { return nearest(s.pts, px); });
    var best = 0;
    hits.forEach(function (h, i) { if (Math.abs(h[1] - py) < Math.abs(hits[best][1] - py)) best = i; });
    var h = hits[best], dots = g.querySelectorAll('.dot');
    hits.forEach(function (p, i) { set(dots[i], { cx: p[0], cy: p[1] }); });
    set(g.querySelector('.vx'), { x1: h[0], x2: h[0] });
    set(g.querySelector('.hy'), { y1: h[1], y2: h[1] });
    var name = c.series[best].name, vt = (c.series.length > 1 && name ? name + ' ' : '') + c.label(h[3]), tt = fullTime(h[2]);
    var vw = vt.length * CHAR_W + 8, tw = tt.length * CHAR_W + 10, vy = Math.max(c.T + 9, Math.min(c.H - c.B - 9, h[1]));
    var vx = Math.min(c.W - c.R + 4, c.W - vw - 2);
    set(g.querySelector('.hv-pv'), { x: vx, y: vy - 9, width: vw });
    set(g.querySelector('.hv-v'), { x: vx + vw / 2, y: vy + 4 });
    g.querySelector('.hv-v').textContent = vt;
    var tx = Math.max(c.L + tw / 2, Math.min(c.W - c.R - tw / 2, h[0]));
    set(g.querySelector('.hv-pt'), { x: tx - tw / 2, y: c.H - 20.5, width: tw });
    set(g.querySelector('.hv-t'), { x: tx, y: c.H - 8 });
    g.querySelector('.hv-t').textContent = tt;
    g.setAttribute('visibility', 'visible');
  }
  ['pointermove', 'pointerdown'].forEach(function (ev) { document.addEventListener(ev, hover); });
  document.addEventListener('pointerleave', hover, true);

  // ---------------------------------------------------------------- donut
  /** items: [{name, value, color}], colour by default from the series tokens. Returns the donut
      and its legend rows (.donut-wrap); hovering a row or a slice lights it. */
  function donut(items, opts) {
    opts = opts || {};
    items = (items || []).filter(function (it) { return it.value > 0; });
    var sum = items.reduce(function (a, it) { return a + it.value; }, 0);
    if (!sum) return '<div class="empty">' + esc(opts.empty || 'No data yet') + '</div>';
    var R = 80, r = 56, cx = 90, cy = 90, a = -Math.PI / 2, paths = '', rows = '';
    items.forEach(function (it, i) {
      var color = it.color || SERIES_VARS[i % SERIES_VARS.length], share = it.value / sum;
      var a2 = a + share * Math.PI * 2 - (items.length > 1 ? 0.012 : 0.0001), big = a2 - a > Math.PI ? 1 : 0;
      var p = function (rad, ang) { return f1(cx + rad * Math.cos(ang)) + ',' + f1(cy + rad * Math.sin(ang)); };
      paths += '<path data-i="' + i + '" d="M' + p(R, a) + ' A' + R + ',' + R + ' 0 ' + big + ' 1 ' + p(R, a2) + ' L' + p(r, a2) + ' A' + r + ',' + r + ' 0 ' + big + ' 0 ' + p(r, a) + ' Z" style="fill:' + color + '"><title>' + esc(it.name) + '</title></path>';
      rows += '<div class="legend-row" data-i="' + i + '"><i style="background:' + color + '"></i><b>' + esc(it.name) + '</b><span class="n">' + esc(opts.label ? opts.label(it.value) : it.value) + '</span><span class="p">' + (share * 100).toFixed(1) + '%</span></div>';
      a += share * Math.PI * 2;
    });
    var total = opts.total != null ? opts.total : (opts.label ? opts.label(sum) : sum);
    return '<div class="donut-wrap"><svg class="donut" viewBox="0 0 180 180" role="img" aria-label="' + esc(opts.title || 'Shares') + '">' + paths +
      '<text class="total" x="90" y="94" text-anchor="middle">' + esc(total) + '</text>' +
      (opts.sub ? '<text class="sub" x="90" y="114" text-anchor="middle">' + esc(String(opts.sub).toUpperCase()) + '</text>' : '') +
      '</svg><div class="legend-rows">' + rows + '</div></div>';
  }
  function donutHover(e) {
    var wrap = e.target.closest && e.target.closest('.donut-wrap');
    if (!wrap) return;
    var hit = e.type === 'pointerover' && e.target.closest('[data-i]'), i = hit ? hit.getAttribute('data-i') : null;
    wrap.classList.toggle('hovering', i != null);
    wrap.querySelectorAll('.donut path').forEach(function (p) { p.classList.toggle('on', p.getAttribute('data-i') === i); });
  }
  document.addEventListener('pointerover', donutHover);
  document.addEventListener('pointerout', donutHover);

  window.BBCharts = { spark: spark, line: line, donut: donut, theme: theme, compact: compact, niceStep: niceStep };
})();
