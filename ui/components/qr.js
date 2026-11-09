// BumbleBeam QR codes: the puzzle invite's look (bitcoin/puzzle/web/pool.js qrOpts, puzzle.css .invite .qr),
// for every site: qr-code-styling (ui/vendor, MIT), rounded dots in a gradient from the accent to the logo's
// light end, extra-rounded eyes in the accent with round centres in that light end, on the page's navy, an
// 8 px margin, the code's corners rounded 8 px by its box. The chain's theme gives the colours (Beam: teal,
// Bitcoin: orange); a block with data-chain="bitcoin" gets Bitcoin's on a Beam page.
// One difference from the puzzle, for long texts only: past 300 characters (Beam's offline, public and max
// privacy addresses, 385-451) level L instead of M, else at 180 px the modules are too small to be read at all
// (checked 2026-11-09 with jsQR).
//
//   BB.qr(el, text, size)            draws into el (an SVG, size x size)
//   BB.qrSave(text, name, ext, at)   downloads it as png or svg, 1024 px (in the colours at element at)
//
// Needs ui/vendor/qr-code-styling.js loaded before it.
(() => {
  const css = (at, k, d) => (getComputedStyle(at || document.documentElement).getPropertyValue(k) || '').trim() || d;
  const opts = (text, size, at) => {
    const acc = css(at, '--accent', '#00f6d2'), light = css(at, '--logo-to', '#39fff2');
    return {
      width: size, height: size, type: 'svg', data: text, margin: 8,
      qrOptions: { errorCorrectionLevel: text.length > 300 ? 'L' : 'M' },
      dotsOptions: { type: 'rounded', gradient: { type: 'linear', rotation: Math.PI / 4, colorStops: [{ offset: 0, color: acc }, { offset: 1, color: light }] } },
      cornersSquareOptions: { type: 'extra-rounded', color: acc },
      cornersDotOptions: { type: 'dot', color: light },
      backgroundOptions: { color: css(at, '--bg', '#042548') },
    };
  };
  const qr = (el, text, size = 180) => {
    el.innerHTML = '';
    if (!window.QRCodeStyling) { el.textContent = 'QR code unavailable'; return; }
    new window.QRCodeStyling(opts(text, size, el)).append(el);
  };
  const qrSave = (text, name = 'qr', ext = 'png', at) => {
    if (window.QRCodeStyling) new window.QRCodeStyling(opts(text, 1024, at)).download({ name, extension: ext });
  };
  window.BB = window.BB || {};
  window.BB.qr = qr;
  window.BB.qrSave = qrSave;
})();
