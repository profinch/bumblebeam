/* BumbleBeam Puzzle: the share card of a find on /play, drawn on a canvas.
   The key square of the find in a panel of its own, the site's logo, "I found the key of puzzle #N in 13 seconds", the key,
   the puzzle's address over a ruler of its range with the key marked where it lay, the site, a round date stamp.
   BBShare.FORMATS lists the sizes; BBShare.render(id, data) gives a canvas (a promise), data:
   { n, secs, how, key: '0xdc2a04', address, date: '18.11.2026' } (secs null: a find of the pool's, "with the pool"
   for the time, or with how 'lucky' the home page's lucky key, "by pure luck", and 'play' a find on /play whose time is not known,
   "in my browser"). Only ever for a key already safe to show: a solved puzzle, or a find whose prize is spent and deep. */
(function () {
'use strict';
var W = 1200, H = 630, S3 = Math.sqrt(3), PI = Math.PI;
var SANS = '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif', MONO = 'Consolas, "SF Mono", Menlo, "DejaVu Sans Mono", monospace';
var GOLD = '#ffc46b', TQ = '#00f6d2', PANEL = '#0b2a45', RIM = '#8a5a22';
var D = null;
function rad(a) { return a * PI / 180; }

var BEE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="256" height="256"><defs><linearGradient id="g" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#f7931a"/><stop offset="1" stop-color="#ffc46b"/></linearGradient><clipPath id="c"><rect x="9.5" y="13.5" width="15" height="9" rx="4.5"/></clipPath></defs>' +
  '<path d="M16 2 28 9v14L16 30 4 23V9z" fill="url(#g)"/><g stroke="#fff" stroke-width="1.3" stroke-linecap="round"><path d="M4.5 20h3.5"/><path d="M3.5 23.5h2.5" stroke-opacity=".6"/></g>' +
  '<ellipse cx="14.5" cy="10.8" rx="3.6" ry="2.1" transform="rotate(-24 14.5 10.8)" fill="#eaf8ff" stroke="#042548" stroke-width=".7"/><ellipse cx="20" cy="10.8" rx="3.6" ry="2.1" transform="rotate(24 20 10.8)" fill="#eaf8ff" stroke="#042548" stroke-width=".7"/>' +
  '<rect x="9.5" y="13.5" width="15" height="9" rx="4.5" fill="#042548"/><g clip-path="url(#c)" fill="#f4ce4a"><rect x="13.3" y="13" width="3" height="10"/><rect x="18.6" y="13" width="3" height="10"/></g><circle cx="22.6" cy="17" r="1" fill="#00f6d2"/></svg>';
var BEE = new Image();

// ---------- 2D helpers ----------
function hexPath(c, cx, cy, r) { c.beginPath(); for (var i = 0; i < 6; i++) { var a = rad(30 + 60 * i); c.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a)); } c.closePath(); }
function rr(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
function width(c, t, font) { c.save(); c.font = font; var w = c.measureText(t).width; c.restore(); return w; }
// several coloured runs on one line: [[text, color], ...]
function runs(c, list, x, y, font) { c.save(); c.font = font; var cx = x; list.forEach(function (r) { c.fillStyle = r[1]; c.fillText(r[0], cx, y); cx += c.measureText(r[0]).width; }); c.restore(); return cx - x; }
function mono(c, t, x, y, fs, color, weight, align) { c.save(); c.font = (weight || 400) + ' ' + fs + 'px ' + MONO; c.fillStyle = color; c.textAlign = align || 'left'; c.fillText(t, x, y); c.restore(); }
// the dark box of the key square, the key and the range: solid, with a thin muted gold rim
function box(c, x, y, w, h, r, shadow) {
  if (shadow) { c.save(); c.shadowColor = 'rgba(0,0,0,.45)'; c.shadowBlur = 30; c.shadowOffsetY = 10; rr(c, x, y, w, h, r); c.fillStyle = PANEL; c.fill(); c.restore(); }
  c.save(); rr(c, x + 0.5, y + 0.5, w - 1, h - 1, r); c.fillStyle = PANEL; c.fill(); c.strokeStyle = RIM; c.lineWidth = 1.5; c.stroke(); c.restore();
}

// ---------- the pieces ----------
// a dark radial and the outlines of a comb, fading out toward the edges
function background(c) {
  var g = c.createRadialGradient(W * 0.55, H * 0.45, 40, W * 0.55, H * 0.5, Math.max(W, H) * 0.78);
  g.addColorStop(0, '#0a3656'); g.addColorStop(1, '#010b16'); c.fillStyle = g; c.fillRect(0, 0, W, H);
  var R = 22 * Math.max(1, Math.min(W, H) / 600), w = R * S3, rh = R * 1.5, far = Math.hypot(W, H) * 0.5;
  c.save(); c.lineWidth = 1;
  for (var r = -1; r * rh < H + R; r++) for (var q = -1; q * w < W + w; q++) {
    var x = q * w + (r % 2 ? w / 2 : 0), y = r * rh, al = 0.05 * Math.max(0, 1 - Math.hypot(x - W * 0.55, y - H * 0.5) / far);
    if (al <= 0.002) continue;
    hexPath(c, x, y, R); c.strokeStyle = 'rgba(255,255,255,' + al.toFixed(3) + ')'; c.stroke();
  }
  c.restore();
}
// the site's header: the bee with its glow, Bumble in white, Beam in the accent gradient, Puzzle muted
function brand(c, x, y, s) {
  c.save(); c.shadowColor = 'rgba(247,147,26,.55)'; c.shadowBlur = s * 0.45; c.drawImage(BEE, x, y - s * 0.72, s, s); c.restore();
  var fx = x + s + s * 0.25, fs = s * 0.56;
  c.save(); c.font = '700 ' + fs + 'px ' + SANS; c.fillStyle = '#fff'; c.fillText('Bumble', fx, y); var w1 = c.measureText('Bumble').width, w2 = c.measureText('Beam').width;
  var g = c.createLinearGradient(fx + w1, y - fs, fx + w1 + w2, y); g.addColorStop(0, '#f7931a'); g.addColorStop(1, GOLD); c.fillStyle = g; c.fillText('Beam', fx + w1, y);
  c.font = '400 ' + (fs * 0.8) + 'px ' + SANS; c.fillStyle = 'rgba(255,255,255,.5)'; c.fillText('Puzzle', fx + w1 + w2 + fs * 0.3, y); c.restore();
}
// the key square as on the site (keysq.js), in a panel of size s: 64 hex digits in 8 x 8 cells, each digit's 16 values as
// 4 x 4 dots; the known zeros light their zero quietly in white; a found digit's cell is tinted and rimmed in turquoise, its
// value lit, the values it could have had dimly turquoise (the top digit only from its lowest possible value up)
function keySquare(c, x, y, s) {
  var k = s / 437, cell = 44 * k, G = 7 * k, x0 = x + 18 * k, y0 = y + 18 * k;
  box(c, x, y, s, s, 18 * k, true);
  var open = Math.ceil(D.n / 4), known = 64 - open, digits = keyDigits();
  for (var i = 0; i < 64; i++) digitCell(c, x0 + (i % 8) * (cell + G), y0 + Math.floor(i / 8) * (cell + G), cell, i - known, digits[i - known]);
}
// the key's open hex digits as numbers, the top one first
function keyDigits() { var open = Math.ceil(D.n / 4); return D.key.replace(/^0x/, '').padStart(open, '0').split('').map(function (h) { return parseInt(h, 16); }); }
// one cell of the key square: j < 0 a known zero, else the j-th open digit with its value v
function digitCell(c, cx, cy, cell, j, v) {
  var gtop = D.n % 4 || 4, p = Math.round(cell * 0.09), g = Math.max(2, Math.round(cell * 0.045)), d = (cell - 2 * p - 3 * g) / 4;
  c.save(); rr(c, cx, cy, cell, cell, cell * 0.12);
  if (j >= 0) { c.fillStyle = 'rgba(0,246,210,0.1)'; c.fill(); c.strokeStyle = 'rgba(0,246,210,0.45)'; c.lineWidth = Math.max(1, cell / 44); c.stroke(); }
  else { c.fillStyle = 'rgba(255,255,255,0.035)'; c.fill(); }
  c.restore();
  for (var m = 0; m < 16; m++) {
    var dx = cx + p + (m % 4) * (d + g), dy = cy + p + Math.floor(m / 4) * (d + g), live = j >= 0 && (j > 0 || (m >= (1 << (gtop - 1)) && m < (1 << gtop)));
    c.save();
    if (j >= 0 && v === m) { c.fillStyle = TQ; c.shadowColor = 'rgba(0,246,210,.85)'; c.shadowBlur = d * 1.4; }
    else c.fillStyle = j < 0 ? (m === 0 ? 'rgba(255,255,255,0.38)' : 'rgba(255,255,255,0.07)') : live ? 'rgba(0,246,210,0.26)' : 'rgba(255,255,255,0.07)';
    rr(c, dx, dy, d, d, d * 0.18); c.fill(); c.restore();
  }
}
// only the open digits of the key square, in a panel of width w: up to 12 a row, cells no bigger than max
function keyStrip(c, x, y, w, max) {
  var digits = keyDigits(), n = digits.length, cols = Math.min(n, 12), rows = Math.ceil(n / cols), pad = 20, gap = 12;
  var cell = Math.min(max, (w - 2 * pad - (cols - 1) * gap) / cols), bw = cols * cell + (cols - 1) * gap + 2 * pad, bh = rows * cell + (rows - 1) * gap + 2 * pad;
  box(c, x, y, bw, bh, 16, true);
  digits.forEach(function (v, j) { digitCell(c, x + pad + (j % cols) * (cell + gap), y + pad + Math.floor(j / cols) * (cell + gap), cell, j, v); });
  return bh;
}
// "I found the key / of puzzle #N / in 13 seconds", shrunk if a line would run past w
function heading(c, x, y, fs, lh, w) {
  var lines = [[['I found the key', '#fff']], [['of puzzle ', '#fff'], ['#' + D.n, GOLD]], D.how === 'lucky' ? [['by pure ', '#fff'], ['luck', TQ]] : D.secs == null && D.how === 'play' ? [['in my ', '#fff'], ['browser', TQ]] : D.secs == null ? [['with the ', '#fff'], ['pool', TQ]] : [['in ', '#fff'], [said(D.secs), TQ]]];
  var widest = Math.max.apply(null, lines.map(function (l) { return width(c, l.map(function (r) { return r[0]; }).join(''), '800 ' + fs + 'px ' + SANS); }));
  if (widest > w) { lh *= w / widest; fs *= w / widest; }
  lines.forEach(function (l, i) { runs(c, l, x, y + i * lh, '800 ' + fs + 'px ' + SANS); });
}
// the key in a pill of the panel's colours, shrunk if it would run past maxW
function keyPill(c, x, y, fs, maxW) {
  var full = width(c, 'key ' + D.key, '700 ' + fs + 'px ' + MONO) + fs * 1.24; if (maxW && full > maxW) fs *= maxW / full;
  var lw = width(c, 'key ', '400 ' + fs + 'px ' + MONO), kw = width(c, D.key, '700 ' + fs + 'px ' + MONO), pad = fs * 0.62, h = fs * 1.77;
  box(c, x, y, lw + kw + 2 * pad, h, fs * 0.38);
  c.save(); c.textBaseline = 'middle'; c.fillStyle = 'rgba(255,255,255,.6)'; c.font = '400 ' + fs + 'px ' + MONO; c.fillText('key ', x + pad, y + h / 2 + 1);
  c.fillStyle = GOLD; c.font = '700 ' + fs + 'px ' + MONO; c.fillText(D.key, x + pad + lw, y + h / 2 + 1); c.restore();
}
// the puzzle's address in the key's gold, and under it the puzzle's range as a ruler, the key marked where it lay; s scales it
function range(c, x, y, w, s) {
  var fs = 22 * s, aw = width(c, D.address, '700 ' + fs + 'px ' + MONO); if (aw > w) fs *= w / aw;
  mono(c, D.address, x, y + 26 * s, fs, GOLD, 700);
  var lo = 1n << BigInt(D.n - 1), hi = lo * 2n - 1n, f = hi > lo ? Number((BigInt(D.key) - lo) * 1000000n / (hi - lo)) / 1e6 : 0;
  var by = y + 68 * s, bh = 12 * s, mx = x + w * f;
  box(c, x, by, w, bh, bh / 2);
  if (f > 0) { c.save(); rr(c, x + 2 * s, by + 2 * s, Math.max(bh - 4 * s, (w - 4 * s) * f), bh - 4 * s, (bh - 4 * s) / 2); c.fillStyle = 'rgba(0,246,210,.18)'; c.fill(); c.restore(); }
  c.save(); c.shadowColor = 'rgba(0,246,210,.9)'; c.shadowBlur = 12 * s; c.fillStyle = TQ; c.fillRect(mx - 1.5 * s, by - 10 * s, 3 * s, 32 * s); c.restore();
  mono(c, Math.round(f * 100) + '%', Math.min(Math.max(mx, x + 18 * s), x + w - 18 * s), by - 16 * s, 15 * s, TQ, 700, 'center');
  var lab = 14 * s, ll = '0x' + lo.toString(16), lr = '0x' + hi.toString(16), lw2 = width(c, ll, lab + 'px ' + MONO);
  if (lw2 * 2 + 20 * s > w) lab *= w / (lw2 * 2 + 20 * s); // a long range: the two ends shrink to fit side by side
  mono(c, ll, x, by + 36 * s, lab, 'rgba(255,255,255,.55)');
  mono(c, lr, x + w, by + 36 * s, lab, 'rgba(255,255,255,.55)', 400, 'right');
}
function site(c, x, y, fs, align) {
  var parts = [['puzzle.', '#fff'], ['bumblebeam', GOLD], ['.org', '#fff']], font = '700 ' + fs + 'px ' + MONO;
  runs(c, parts, align === 'right' ? x - width(c, 'puzzle.bumblebeam.org', font) : x, y, font);
}
// a round stamp: KEY FOUND and BITCOIN PUZZLE #N around the rim, bitcoin signs between them, the date across the middle,
// tilted so the date runs down from left to right
function stamp(c, x, y, r) {
  var k = r / 90;
  c.save(); c.translate(x, y); c.rotate(rad(12));
  c.strokeStyle = GOLD; c.fillStyle = GOLD; c.globalAlpha = 0.92;
  c.lineWidth = 3 * Math.max(0.7, k); c.beginPath(); c.arc(0, 0, r, 0, 2 * PI); c.stroke();
  c.lineWidth = 1.2 * Math.max(0.8, k); c.beginPath(); c.arc(0, 0, r - 7 * k, 0, 2 * PI); c.stroke();
  c.beginPath(); c.arc(0, 0, r - 32 * k, 0, 2 * PI); c.stroke();
  function arcText(t, rad0, top, fs) {
    c.font = '700 ' + fs + 'px ' + MONO; c.textAlign = 'center'; c.textBaseline = 'middle';
    var ls = fs * 0.28, ws = t.split('').map(function (ch) { return c.measureText(ch).width + ls; }), tot = ws.reduce(function (a, b) { return a + b; }, 0), ang = -tot / rad0 / 2;
    t.split('').forEach(function (ch, i) {
      var a = ang + (ws[i] / 2) / rad0; ang += ws[i] / rad0;
      c.save(); if (top) { c.rotate(a); c.fillText(ch, 0, -rad0); } else { c.rotate(-a); c.fillText(ch, 0, rad0); } c.restore();
    });
  }
  arcText('KEY FOUND', r - 19 * k, true, 15 * k);
  arcText('BITCOIN PUZZLE #' + D.n, r - 19 * k, false, 12 * k);
  c.font = '700 ' + (14 * k) + 'px ' + SANS; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText('₿', -(r - 19 * k), 1); c.fillText('₿', r - 19 * k, 1);
  c.font = '800 ' + (19 * k) + 'px ' + SANS; c.fillText(D.date, 0, 1);
  c.restore();
}
// the time in words: 13 seconds, 4 minutes, 2 hours
function said(sec) {
  function n(v, u) { v = Math.round(v); return v.toLocaleString('en-US') + ' ' + u + (v === 1 ? '' : 's'); }
  if (!(sec >= 1)) return 'under a second';
  if (sec < 90) return n(sec, 'second');
  if (sec < 5400) return n(sec / 60, 'minute');
  if (sec < 86400 * 2) return n(sec / 3600, 'hour');
  if (sec < 86400 * 730) return n(sec / 86400, 'day');
  return n(sec / 86400 / 365.25, 'year');
}

// ---------- the three layouts ----------
// wide, for a link preview: the square on the left, the words on the right, the range over them
function linkCard(c) {
  var X = 64, Y = 140, P = 450, T = X + P + 64, TW = W - T - 56;
  background(c);
  brand(c, X + 2, 84, 58);
  keySquare(c, X, Y, P);
  range(c, T, 40, TW, 1);
  heading(c, T, Y + 98, 58, 68, TW);
  keyPill(c, T, Y + 262, 26, TW);
  site(c, T + 2, Y + P - 12, 26);
  stamp(c, W - 56 - 66, Y + P - 84, 66);
}
// square: the logo and the stamp on top, the words big, the key, only its open digits from the square, the range, the site
function squareCard(c) {
  var X = 64, CW = W - 2 * X;
  background(c);
  brand(c, X + 2, 112, 66);
  stamp(c, W - X - 112, 182, 112);
  heading(c, X, 344, 84, 98, CW - 250);
  keyPill(c, X, 576, 34, CW);
  var sh = keyStrip(c, X, 670, CW, 84);
  range(c, X, 670 + sh + 30, CW, 1.25);
  site(c, X + 2, H - 52, 28);
}
// story: everything stacked, the square big in the middle
function storyCard(c) {
  var X = 80, CW = W - 2 * X;
  background(c);
  brand(c, X + 2, 150, 84);
  range(c, X, 205, CW, 1.5);
  heading(c, X, 470, 92, 108, CW);
  keyPill(c, X, 730, 44, CW);
  stamp(c, W - X - 100, 560, 100);
  keySquare(c, X, 850, CW);
  site(c, X + 2, 1850, 36);
}

var FORMATS = [
  { id: 'link', label: 'Link', w: 1200, h: 630, hint: 'A preview card for chats, X and Telegram.', draw: linkCard },
  { id: 'square', label: 'Square', w: 1080, h: 1080, hint: 'A post for feeds and Discord.', draw: squareCard },
  { id: 'story', label: 'Story', w: 1080, h: 1920, hint: 'Full screen, for stories and status.', draw: storyCard }
];

var beeReady = new Promise(function (ok) { BEE.onload = ok; BEE.onerror = ok; BEE.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(BEE_SVG); });
function render(id, data) {
  var f = FORMATS.filter(function (x) { return x.id === id; })[0] || FORMATS[0];
  return beeReady.then(function () {
    W = f.w; H = f.h; D = data;
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    f.draw(cv.getContext('2d'));
    return cv;
  });
}
window.BBShare = { FORMATS: FORMATS, render: render, said: said };
})();
