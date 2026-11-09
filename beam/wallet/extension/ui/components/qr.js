// BumbleBeam QR codes: qr-code-styling (ui/vendor, MIT) with the puzzle invite's shapes (rounded dots in a
// gradient, rounded eyes with round centres) in the site's own tones, dark on light: the page's navy to the
// accent half mixed into that navy, on a ground tinted with the accent (Beam: navy to deep teal on pale teal,
// Bitcoin: navy to deep amber on pale amber). Not the puzzle's light on
// dark: checked 2026-11-09 with a scanner that does not invert (jsQR), light-on-dark codes were not read at all,
// and Beam's long addresses (offline, public, max privacy: 385-451 characters) needed 180 px and level L to be
// read; this look at 180 px, level L, read all four address types at 1x and 2x.
//
//   BB.qr(el, text, size)            draws into el (an SVG, size x size; 180 or more for long texts)
//   BB.qrSave(text, name, ext, at)   downloads it as png or svg, 1024 px (in the colours at element at)
//
// Needs ui/vendor/qr-code-styling.js loaded before it.
(() => {
  // the colours where the code goes: a block with data-chain="bitcoin" gets Bitcoin's on a Beam page
  const css = (at, k, d) => (getComputedStyle(at || document.documentElement).getPropertyValue(k) || '').trim() || d;
  // the ground: white with 8% of the accent
  const tint = (at) => { const c = css(at, '--accent-rgb', '0, 246, 210').split(',').map(Number); return `rgb(${c.map((v) => Math.round(255 - (255 - v) * 0.08)).join(', ')})`; };
  // the deep end of the dots: the accent half mixed into the page's navy (Beam: a deep teal, Bitcoin: a deep
  // amber), dark enough on the light ground on every chain (the accent itself is too light on it)
  const rgb = (h) => (h.match(/[0-9a-f]{2}/gi) || []).map((x) => parseInt(x, 16));
  const deepOf = (at, dark) => { const a = css(at, '--accent-rgb', '0, 246, 210').split(',').map(Number), d = rgb(dark); return `rgb(${a.map((v, i) => Math.round(v * 0.5 + (d[i] || 0) * 0.5)).join(', ')})`; };
  const opts = (text, size, at) => {
    const dark = css(at, '--bg', '#042548'), deep = deepOf(at, dark);
    return {
      width: size, height: size, type: 'svg', data: text, margin: Math.max(6, Math.round(size / 22)),
      qrOptions: { errorCorrectionLevel: 'L' },
      dotsOptions: { type: 'rounded', gradient: { type: 'linear', rotation: Math.PI / 4, colorStops: [{ offset: 0, color: dark }, { offset: 1, color: deep }] } },
      cornersSquareOptions: { type: 'extra-rounded', color: dark },
      cornersDotOptions: { type: 'dot', color: deep },
      backgroundOptions: { color: tint(at) },
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
