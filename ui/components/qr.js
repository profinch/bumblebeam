// BumbleBeam QR codes, the puzzle invite's look (bitcoin/puzzle/web/pool.js qrOpts) for every site: rounded
// dots in a gradient from the accent to the logo's light end, extra-rounded eyes in the accent with round centres
// in that light end, no ground of their own (the page under them), our logo in the middle.
//
// Drawn here on a canvas; ui/vendor/qr-code-styling.js gives only the code's modules. So:
//   - every code fills its box exactly, whatever its length (a whole number of device pixels per module, the
//     picture scaled to the box: no seams between the modules);
//   - the logo is the sites' own, still (no animation), the same size in every code and size, and the modules
//     under it and round it are left out whole, the dots next to the gap rounded towards it as at any other edge
//     (the library clears less of a long code, and only a square);
//   - level Q up to 300 characters, L past it (Beam's offline, public and max privacy addresses).
// The chain's theme gives the colours (Beam: teal, Bitcoin: orange); a block with data-chain="bitcoin" gets
// Bitcoin's on a Beam page. Light on dark: a scanner must try the inverted image (phone cameras and jsQR's
// default do; a strict dark-on-light one reads none). Checked 2026-11-09 with jsQR on Beam's four address types
// and five Bitcoin ones at each size.
//
//   BB.qr(el, text, size)            draws into el (size x size px; el gets that size)
//   BB.qrSave(text, name, at)        downloads it as a png, 1024 px (in the colours at element at)
//   BB.qrSizes                       { s: 180, m: 220, l: 260 }
//
// Needs ui/vendor/qr-code-styling.js, and ui/components/bb.js for the logo.
(() => {
  const css = (at, k, d) => (getComputedStyle(at || document.documentElement).getPropertyValue(k) || '').trim() || d;
  const SIZES = { s: 180, m: 220, l: 260 };
  // the free circle in the middle: 26 px in radius in every code (the most it can be: wider, Beam's long
  // addresses at 180 px are not read); the logo as big as fits in it, its hexagon's corners 4 px from its edge
  // (the hexagon's corners are 14 of the logo's 32 units from its centre)
  const HOLE = 26, LOGO = Math.round(((HOLE - 4) * 32) / 14);

  // the code's modules: dark or not, n x n
  const matrix = (text) => {
    const ec = text.length > 300 ? 'L' : 'Q';
    const q = new window.QRCodeStyling({ data: text, qrOptions: { errorCorrectionLevel: ec } })._qr;
    const n = q.getModuleCount();
    return { n, dark: (r, c) => r >= 0 && c >= 0 && r < n && c < n && q.isDark(r, c) };
  };
  // the three eyes (7 x 7 at three corners) are drawn on their own
  const inEye = (r, c, n) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);

  // a rectangle with each corner rounded or not
  function rrect(g, x, y, w, h, rad, [tl, tr, br, bl]) {
    g.moveTo(x + (tl ? rad : 0), y);
    g.lineTo(x + w - (tr ? rad : 0), y); if (tr) g.arcTo(x + w, y, x + w, y + rad, rad);
    g.lineTo(x + w, y + h - (br ? rad : 0)); if (br) g.arcTo(x + w, y + h, x + w - rad, y + h, rad);
    g.lineTo(x + (bl ? rad : 0), y + h); if (bl) g.arcTo(x, y + h, x, y + h - rad, rad);
    g.lineTo(x, y + (tl ? rad : 0)); if (tl) g.arcTo(x, y, x + rad, y, rad);
    g.closePath();
  }

  // draws the code (without the logo) on a canvas of n * cell device pixels; the modules within holeR (in
  // modules, from the centre) are left out
  function paint(text, cell, at, holeR) {
    const { n, dark } = matrix(text);
    const c = document.createElement('canvas'); c.width = c.height = n * cell;
    const g = c.getContext('2d');
    const mid = (n - 1) / 2;
    const out = (r, k) => holeR > 0 && Math.hypot(r - mid, k - mid) <= holeR;
    const on = (r, k) => dark(r, k) && !inEye(r, k, n) && !out(r, k);
    const acc = css(at, '--accent', '#00f6d2'), light = css(at, '--logo-to', '#39fff2');
    // the dots: a corner is round unless a neighbour on either of its sides is a dot too, so dots that touch
    // join into one shape and every free end is round
    const grad = g.createLinearGradient(0, 0, n * cell, n * cell);
    grad.addColorStop(0, acc); grad.addColorStop(1, light);
    g.fillStyle = grad;
    g.beginPath();
    const rad = cell / 2;
    for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) {
      if (!on(r, k)) continue;
      const t = on(r - 1, k), b = on(r + 1, k), l = on(r, k - 1), ri = on(r, k + 1);
      rrect(g, k * cell, r * cell, cell, cell, rad, [!t && !l, !t && !ri, !b && !ri, !b && !l]);
    }
    g.fill();
    // the eyes: an extra-rounded ring in the accent, a round centre in the light end
    for (const [r0, k0] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
      const x = k0 * cell, y = r0 * cell, s7 = 7 * cell;
      g.beginPath();
      rrect(g, x, y, s7, s7, 2.6 * cell, [1, 1, 1, 1]);
      rrect(g, x + cell, y + cell, 5 * cell, 5 * cell, 1.6 * cell, [1, 1, 1, 1]);
      g.fillStyle = acc; g.fill('evenodd');
      g.beginPath(); g.arc(x + 3.5 * cell, y + 3.5 * cell, 1.5 * cell, 0, Math.PI * 2);
      g.fillStyle = light; g.fill();
    }
    return { c, n };
  }

  // the logo with its colours written in, still: not the header's animated one (its classes are what animates)
  const logoSvg = (at, size) => (window.BB && window.BB.logoSvg
    ? window.BB.logoSvg(size, { from: css(at, '--logo-from', '#0b76ff'), to: css(at, '--logo-to', '#39fff2') })
      .replace('class="logo"', 'class="qr-logo-img"').replace(/ class="(hex|bee|trail|t1|t2|wing wl|wing wr|eye)"/g, '')
    : '');

  const qr = (el, text, size = SIZES.m) => {
    el.innerHTML = '';
    el.style.width = el.style.height = `${size}px`;
    el.style.position = 'relative';
    if (!window.QRCodeStyling) { el.textContent = 'QR code unavailable'; return; }
    const { n } = matrix(text);
    const cell = Math.max(2, Math.ceil(size * (window.devicePixelRatio || 1) / n));
    const holeR = HOLE / (size / n);                    // the free circle round the logo, in modules
    const { c } = paint(text, cell, el, holeR);
    c.style.cssText = `display:block;width:${size}px;height:${size}px`;
    el.appendChild(c);
    const m = document.createElement('span');
    m.style.cssText = `position:absolute;left:50%;top:50%;width:${LOGO}px;height:${LOGO}px;margin:-${LOGO / 2}px 0 0 -${LOGO / 2}px;line-height:0;pointer-events:none`;
    m.innerHTML = logoSvg(el, LOGO);
    el.appendChild(m);
  };

  // a png of 1024 px: the code as on screen at size M, its logo drawn in
  const qrSave = (text, name = 'qr', at, at2) => {
    if (typeof at === 'string') at = at2;              // the older (text, name, 'png', at): always a png now
    if (!window.QRCodeStyling) return;
    const { n } = matrix(text), size = SIZES.m, cell = Math.ceil(1024 / n), holeR = HOLE / (size / n);
    const { c } = paint(text, cell, at, holeR);
    const img = new Image();
    img.onload = () => {
      const g = c.getContext('2d'), w = c.width * (LOGO / size);
      g.drawImage(img, (c.width - w) / 2, (c.width - w) / 2, w, w);
      const a = document.createElement('a'); a.download = `${name}.png`; a.href = c.toDataURL('image/png'); a.click();
    };
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(logoSvg(at, 256).replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '))));
  };

  window.BB = window.BB || {};
  window.BB.qr = qr;
  window.BB.qrSave = qrSave;
  window.BB.qrSizes = SIZES;
})();
