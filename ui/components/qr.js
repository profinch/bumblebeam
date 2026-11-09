// BumbleBeam QR codes, the puzzle invite's look (bitcoin/puzzle/web/pool.js qrOpts) for every site:
// qr-code-styling (ui/vendor, MIT), rounded dots in a gradient from the accent to the logo's light end,
// extra-rounded eyes in the accent with round centres in that light end, no ground of their own (the page's
// navy under them), our logo in the middle, the sites' own at their 42 px in every code, on a navy hexagon
// ring. Every code fills its box exactly, whatever its length. The chain's
// theme gives the colours (Beam: teal, Bitcoin: orange); a block with data-chain="bitcoin" gets Bitcoin's.
// Three sizes: BB.qrSizes = { s: 180, m: 220, l: 260 }.
// Checked 2026-11-09 with jsQR on Beam's four address types and five Bitcoin ones: all read at each size with
// level Q up to 300 characters and L past it. Light on dark: a scanner must try the inverted image (phone
// cameras and jsQR's default do; a strict dark-on-light one reads none).
//
//   BB.qr(el, text, size)            draws into el (size x size px; el gets that size)
//   BB.qrSave(text, name, ext, at)   downloads it as png or svg, 1024 px (in the colours at element at)
//
// Needs ui/vendor/qr-code-styling.js, and ui/components/bb.js for the logo.
(() => {
  const css = (at, k, d) => (getComputedStyle(at || document.documentElement).getPropertyValue(k) || '').trim() || d;
  const SIZES = { s: 180, m: 220, l: 260 };
  // the logo in the middle: the sites' own (ui .logo, 42 px, the header's), the same size in every code; the
  // code is cleared under it with a 4 px gap
  const LOGO = 42, GAP = 4;
  const CLEAR = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
  // our logo in the middle, in the chain's colours (bb.js), as a picture the QR library can place
  const logo = (at) => {
    if (!window.BB || !window.BB.logoSvg) return undefined;
    // as a file of its own it needs its namespace (inline in a page it does not)
    const svg = window.BB.logoSvg(64, { from: css(at, '--logo-from', '#0b76ff'), to: css(at, '--logo-to', '#39fff2') }).replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
    return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
  };
  // the code itself, every one the same size: drawn on a canvas at a whole number of device pixels per module
  // (the library rounds a module down, which left codes of different sizes in the same box), then the picture is
  // scaled to the box. Not an SVG scaled by its viewBox: each module is a shape of its own, and at a fractional
  // scale their shared edges were smoothed into thin seams, a grid over the whole code.
  const make = (text, size, at, o = {}, type = 'canvas') => {
    // level Q for addresses (room for a bigger logo: the library keeps the logo inside what the level can
    // lose), L past 300 characters (Beam's offline, public and max privacy: only L read at every size)
    const ec = o.ec || (text.length > 300 ? 'L' : 'Q');
    const probe = new window.QRCodeStyling({ data: text, qrOptions: { errorCorrectionLevel: ec } });
    const n = probe._qr ? probe._qr.getModuleCount() : 33, cell = Math.max(4, Math.ceil(size * (window.devicePixelRatio || 1) / n)), px = n * cell;
    const acc = css(at, '--accent', '#00f6d2'), light = css(at, '--logo-to', '#39fff2');
    return { px, inst: new window.QRCodeStyling({
      width: px, height: px, type, data: text, margin: 0,
      qrOptions: { errorCorrectionLevel: ec },
      // on screen an empty picture only clears the middle (the logo goes over the code, BB.qr); in a download
      // the logo itself, at the same share of the code
      image: o.logo === false ? undefined : o.clearOnly ? CLEAR : logo(at),
      imageOptions: { hideBackgroundDots: true, imageSize: (LOGO + 2 * GAP) / (o.boxSize || size), margin: 0 },
      dotsOptions: { type: 'rounded', gradient: { type: 'linear', rotation: Math.PI / 4, colorStops: [{ offset: 0, color: acc }, { offset: 1, color: light }] } },
      cornersSquareOptions: { type: 'extra-rounded', color: acc },
      cornersDotOptions: { type: 'dot', color: light },
      backgroundOptions: { color: 'transparent' },
    }) };
  };
  const qr = (el, text, size = SIZES.m, o) => {
    el.innerHTML = '';
    el.style.width = el.style.height = `${size}px`;
    if (!window.QRCodeStyling) { el.textContent = 'QR code unavailable'; return; }
    make(text, size, el, { ...o, clearOnly: true }).inst.append(el);
    const c = el.querySelector('canvas');
    if (c) { c.style.width = c.style.height = `${size}px`; c.style.display = 'block'; }
    if (o && o.logo === false) return;
    el.style.position = 'relative';
    const m = document.createElement('span');
    m.className = 'qr-logo';
    m.style.cssText = `position:absolute;left:50%;top:50%;width:${LOGO}px;height:${LOGO}px;margin:-${LOGO / 2}px 0 0 -${LOGO / 2}px;line-height:0;pointer-events:none`;
    // under it the logo's hexagon a little bigger in the page's navy: the same clear ring round it in every code
    // (the library clears less of a long code: what level L can lose)
    const halo = `<svg viewBox="0 0 32 32" width="${LOGO}" height="${LOGO}" style="position:absolute;left:0;top:0;overflow:visible" aria-hidden="true"><path d="M16 2 28 9v14L16 30 4 23V9z" fill="var(--bg)" stroke="var(--bg)" stroke-width="${(GAP * 2 * 32) / LOGO}" stroke-linejoin="round"/></svg>`;
    m.innerHTML = halo + (window.BB && window.BB.logoSvg ? window.BB.logoSvg(LOGO).replace('<svg ', '<svg style="position:relative" ') : '');
    el.appendChild(m);
  };
  const qrSave = (text, name = 'qr', ext = 'png', at) => {
    if (window.QRCodeStyling) make(text, 1024, at, { boxSize: SIZES.m }, ext === 'svg' ? 'svg' : 'canvas').inst.download({ name, extension: ext });
  };
  window.BB = window.BB || {};
  window.BB.qr = qr;
  window.BB.qrSave = qrSave;
  window.BB.qrSizes = SIZES;
})();
