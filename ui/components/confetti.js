/* BumbleBeam UI: the win's confetti, the wallet's bee in it. BB.confetti(el) puts a canvas (.fw) right after el,
   placed by the page's own CSS; a popper at its left (its right on a narrow one) throws striped ribbons (the bee's
   yellow and dark, a turquoise rim) and a few bees, again and again; every piece fades out before the canvas's
   edge, so nothing is ever cut off. It stops when the canvas leaves the page. A page can set --fw-left: 1 on the
   canvas for a wide canvas that throws to the left, the farthest pieces reaching about 3/4 of its width. */
(function () {
  'use strict';
  function confetti(tt) {
    var c = document.createElement('canvas'); c.className = 'fw'; c.setAttribute('aria-hidden', 'true');
    tt.insertAdjacentElement('afterend', c);
    var dpr = window.devicePixelRatio || 1, x = c.getContext('2d'), P = [], t = 0, W = 0, H = 0, OX = 24, OY = 0, LEFT = false, FAR = false;
    var Y = '#f4ce4a', D = '#042548', T = '#39fff2', WH = 'rgba(255,255,255,.9)';
    function size() { W = c.clientWidth; H = c.clientHeight; FAR = getComputedStyle(c).getPropertyValue('--fw-left').trim() === '1'; LEFT = FAR || W < 200; OY = H * (LEFT ? 0.72 : 0.62); OX = LEFT ? W - 24 : 24; c.width = W * dpr; c.height = H * dpr; x.setTransform(dpr, 0, 0, dpr, 0, 0); }
    // a bee flying left is mirrored, not turned over (it would fly upside down)
    function bee(px, py, rot, flap, left) {
      x.save(); x.translate(px, py); if (left) x.scale(-1, 1); x.rotate(rot); x.scale(0.9, 0.9);
      var f = 0.6 + 0.4 * Math.abs(Math.sin(flap));
      x.strokeStyle = WH; x.lineWidth = 1.2; x.fillStyle = 'rgba(255,255,255,.25)';
      x.beginPath(); x.ellipse(-3, -6, 4, 2.6 * f, -0.4, 0, 6.283); x.fill(); x.stroke();
      x.beginPath(); x.ellipse(3, -6, 4, 2.6 * f, 0.4, 0, 6.283); x.fill(); x.stroke();
      x.fillStyle = D; x.strokeStyle = T; x.lineWidth = 1.4;
      x.beginPath(); if (x.roundRect) x.roundRect(-8, -4, 16, 9, 4.5); else x.rect(-8, -4, 16, 9); x.fill(); x.stroke();
      x.fillStyle = Y; x.fillRect(-4, -3.3, 2.6, 7.6); x.fillRect(1, -3.3, 2.6, 7.6);
      x.fillStyle = T; x.beginPath(); x.arc(5.6, 0.5, 1, 0, 6.283); x.fill();
      x.restore();
    }
    size();
    (function frame() {
      if (!c.isConnected) return;
      if (c.clientWidth !== W || c.clientHeight !== H) size();
      x.clearRect(0, 0, W, H);
      if (t % 110 === 0) for (var k = 0; k < 32; k++) P.push({ bee: k < 3, x: OX, y: OY, vx: LEFT ? -(0.6 + Math.random() * (FAR ? W * 0.75 / 50 - 0.6 : 1.6)) : 0.6 + Math.random() * 2.6, vy: -1.6 - Math.random() * 2, life: 1.3, d: 0.009, c: k % 2 ? Y : D, r: Math.random() * 6 });
      t++;
      P = P.filter(function (p) { return p.life > 0; });
      P.forEach(function (p) {
        p.vx *= 0.985; p.vy = p.vy * 0.985 + 0.05; p.x += p.vx; p.y += p.vy; p.life -= p.d; p.r += 0.2;
        var edge = Math.min(p.x, W - p.x, p.y, H - p.y);
        x.globalAlpha = Math.max(0, Math.min(1, p.life, edge / 24));
        if (p.bee) bee(p.x, p.y, p.vx < 0 ? Math.atan2(p.vy, -p.vx) : Math.atan2(p.vy, p.vx), t / 2, p.vx < 0);
        else { x.save(); x.translate(p.x, p.y); x.rotate(p.r); x.fillStyle = p.c; x.strokeStyle = T; x.lineWidth = 0.6; x.fillRect(-3, -1.5, 6, 3); x.strokeRect(-3, -1.5, 6, 3); x.restore(); }
      });
      x.globalAlpha = 1;
      requestAnimationFrame(frame);
    })();
  }
  window.BB = window.BB || {}; window.BB.confetti = confetti;
})();
