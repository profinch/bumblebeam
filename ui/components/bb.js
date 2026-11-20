/* BumbleBeam UI web components, plain JS (a classic script: works from file://, inside the ESP32
   firmware page and the MV3 extension, and in Chromium 83, the Beam desktop wallet's browser).

   <bb-logo size="42"></bb-logo>
     The animated bee on the chain's hexagon (tokens: --logo-from, --logo-to). Styles: components.css .logo.

   <bb-eco here="pool"></bb-eco>
     The ecosystem bar: one line above the header linking every BumbleBeam site, the current one
     underlined. A site not in the list (or here="") underlines nothing. The list is SITES below:
     add a site there once and every page gets it on its next build.

   <bb-socials></bb-socials>
     The project's social accounts as a row of icons (components.css .socials): grey, the network's own colour on
     hover, a tip on each. The list is SOCIALS below (paths from Simple Icons, CC0; Bitcointalk wears the Bitcoin
     mark); add an account there once and every footer gets it on its next build.

   BB.decode(el, text, ms)
     Opt-in: el's text runs as random hex and settles, left to right, on text (an address changing to another);
     "0x" and "…" stay put. A new call on the same element takes over from the one running. el may be a function
     giving the element, looked up each frame (for one drawn again meanwhile, as a dropdown's button is).

   BB.amountField(input, decimals, whole)
     Opt-in: an amount field takes only digits and one decimal point (a point or a comma, as typed); anything else
     typed or pasted is dropped where it lands, so the field never holds a wrong amount to complain about (with
     both a point and a comma, as in a pasted "1,234.5", the last one is the decimal point). With
     decimals, at most that many digits after the point; with whole, at most that many before it (8: up to
     99 999 999). The caret stays where it was. */
(function () {
  'use strict';

  var SITES = [
    { id: 'pool', name: 'Pool', href: 'https://pool.bumblebeam.org', chain: 'beam' },
    { id: 'explorer', name: 'Explorer', href: 'https://explorer.bumblebeam.org', chain: 'beam' },
    { id: 'wallet', name: 'Wallet', href: 'https://github.com/profinch/bumblebeam/tree/main/beam/wallet', chain: 'beam' },
    { id: 'puzzle', name: 'Puzzle', href: 'https://puzzle.bumblebeam.org', chain: 'bitcoin' },
    { id: '3bminer', name: '3BMiner', href: 'https://github.com/profinch/bumblebeam/tree/main/bitcoin/3bminer', chain: 'bitcoin' },
    { id: 'thermo', name: 'Thermo', href: 'https://github.com/profinch/bumblebeam/tree/main/rig/thermo', chain: 'rig' },
  ];


  var SOCIALS = [
    { id: 'telegram', name: 'Telegram', href: 'https://t.me/BumbleBeamOrg', colour: '#26a5e4', tip: "BumbleBeam on Telegram: the channel with news (t.me/BumbleBeamOrg)",
      d: 'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z' },
    { id: 'x', name: 'X', href: 'https://x.com/BumbleBeamOrg', colour: 'var(--text)', tip: "BumbleBeam on X (@BumbleBeamOrg)",
      d: 'M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z' },
    { id: 'reddit', name: 'Reddit', href: 'https://www.reddit.com/r/BumbleBeam', colour: '#ff4500', tip: "r/BumbleBeam on Reddit",
      d: 'M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z' },
    { id: 'youtube', name: 'YouTube', href: 'https://www.youtube.com/@BumbleBeamOrg', colour: '#ff0000', tip: "BumbleBeam on YouTube (@BumbleBeamOrg)",
      d: 'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z' },
    { id: 'substack', name: 'Substack', href: 'https://substack.com/@bumblebeam', colour: '#ff6719', tip: "BumbleBeam on Substack: write-ups",
      d: 'M22.539 8.242H1.46V5.406h21.08v2.836zM1.46 10.812V24L12 18.11 22.54 24V10.812H1.46zM22.54 0H1.46v2.836h21.08V0z' },
    { id: 'bitcointalk', name: 'Bitcointalk', href: 'https://bitcointalk.org/index.php?topic=5596205.0', colour: '#f7931a', tip: "The pool's thread on Bitcointalk",
      d: 'M23.638 14.904c-1.602 6.43-8.113 10.34-14.542 8.736C2.67 22.05-1.244 15.525.362 9.105 1.962 2.67 8.475-1.243 14.9.358c6.43 1.605 10.342 8.115 8.738 14.548v-.002zm-6.35-4.613c.24-1.59-.974-2.45-2.64-3.03l.54-2.153-1.315-.33-.525 2.107c-.345-.087-.705-.167-1.064-.25l.526-2.127-1.32-.33-.54 2.165c-.285-.067-.565-.132-.84-.2l-1.815-.45-.35 1.407s.975.225.955.236c.535.136.63.486.615.766l-1.477 5.92c-.075.166-.24.406-.614.314.015.02-.96-.24-.96-.24l-.66 1.51 1.71.426.93.242-.54 2.19 1.32.327.54-2.17c.36.1.705.19 1.05.273l-.51 2.154 1.32.33.545-2.19c2.24.427 3.93.257 4.64-1.774.57-1.637-.03-2.58-1.217-3.196.854-.193 1.5-.76 1.68-1.93h.01zm-3.01 4.22c-.404 1.64-3.157.75-4.05.53l.72-2.9c.896.23 3.757.67 3.33 2.37zm.41-4.24c-.37 1.49-2.662.735-3.405.55l.654-2.64c.744.18 3.137.524 2.75 2.084v.006z' },
    { id: 'github', name: 'GitHub', href: 'https://github.com/profinch/bumblebeam', colour: 'var(--text)', tip: "The source on GitHub (profinch/bumblebeam)",
      d: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12' },
  ];

  var uid = 0;
  // the logo's SVG; with colours ({ from, to }) they are written in, not taken from the page (for a picture
  // made of it: a QR code's centre, a download)
  function logoSvg(size, colours) {
    var n = ++uid, g = 'bbl-g' + n, c = 'bbl-c' + n;
    var from = colours ? colours.from : 'var(--logo-from)', to = colours ? colours.to : 'var(--logo-to)';
    return '<svg class="logo" viewBox="0 0 32 32" width="' + size + '" height="' + size + '" aria-hidden="true">' +
      '<defs><linearGradient id="' + g + '" x1="0" y1="1" x2="1" y2="0">' +
      '<stop offset="0" style="stop-color:' + from + '"/><stop offset="1" style="stop-color:' + to + '"/></linearGradient>' +
      '<clipPath id="' + c + '"><rect x="9.5" y="13.5" width="15" height="9" rx="4.5"/></clipPath></defs>' +
      '<path class="hex" d="M16 2 28 9v14L16 30 4 23V9z" fill="url(#' + g + ')"/>' +
      '<g class="bee"><g class="trail" stroke="#fff" stroke-width="1.3" stroke-linecap="round">' +
      '<path class="t1" d="M4.5 20h3.5"/><path class="t2" d="M3.5 23.5h2.5"/></g>' +
      '<ellipse class="wing wl" cx="14.5" cy="10.8" rx="3.6" ry="2.1" transform="rotate(-24 14.5 10.8)" fill="#fff" fill-opacity=".9" stroke="#042548" stroke-width=".6"/>' +
      '<ellipse class="wing wr" cx="20" cy="10.8" rx="3.6" ry="2.1" transform="rotate(24 20 10.8)" fill="#fff" fill-opacity=".9" stroke="#042548" stroke-width=".6"/>' +
      '<rect x="9.5" y="13.5" width="15" height="9" rx="4.5" fill="#042548"/>' +
      '<g clip-path="url(#' + c + ')" fill="#f4ce4a"><rect x="13.3" y="13" width="3" height="10"/><rect x="18.6" y="13" width="3" height="10"/></g>' +
      '<circle class="eye" cx="22.6" cy="17" r=".95" style="fill:' + to + '"/></g></svg>';
  }

  function define(name, render) {
    if (!window.customElements || customElements.get(name)) return;
    customElements.define(name, class extends HTMLElement {
      // While the page is still being read (bb.js loads in <head>), the element is created before its own
      // contents are parsed: a prerendered snapshot carries the drawn logo inside it, and drawing now would
      // add a second one. So draw once the page is read, replacing whatever is inside.
      connectedCallback() {
        var el = this;
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { render(el); }, { once: true });
        else render(el);
      }
      static get observedAttributes() { return ['here', 'size']; }
      attributeChangedCallback() { if (this.isConnected && document.readyState !== 'loading') render(this); }
    });
  }

  define('bb-logo', function (el) {
    el.style.display = 'inline-flex';
    el.innerHTML = logoSvg(Number(el.getAttribute('size')) || 42);
  });

  define('bb-eco', function (el) {
    var here = el.getAttribute('here') || '';
    var links = SITES.filter(function (s) { return !s.planned || s.id === here; }).map(function (s) {
      return '<a href="' + s.href + '"' + (s.id === here ? ' class="here" aria-current="page"' : '') + '><i class="' + s.chain + '"></i>' + s.name + '</a>';
    }).join('');
    el.innerHTML = '<nav class="eco" aria-label="BumbleBeam ecosystem"><div class="eco-row"><a class="eco-home" href="https://bumblebeam.org">BumbleBeam ecosystem</a>' + links + '</div></nav>';
    el.style.display = 'block';
  });

  define('bb-socials', function (el) {
    el.innerHTML = '<nav class="socials" aria-label="BumbleBeam elsewhere">' + SOCIALS.map(function (s) {
      return '<a href="' + s.href + '" target="_blank" rel="noopener" style="--c:' + s.colour + '" title="' + s.tip + '" aria-label="' + s.name + '">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + s.d + '"/></svg></a>';
    }).join('') + '</nav>';
  });

  var HEX = '0123456789abcdef';
  function decode(el, text, ms) {
    var T = ms || 520, t0 = performance.now(), run = (el._bbDecode = (el._bbDecode || 0) + 1), key = el;
    var get = typeof el === 'function' ? el : function () { return key; };
    var keep = /^0x/i.test(text) ? 2 : 0;
    function frame(now) {
      if (key._bbDecode !== run) return;
      var to = get();
      if (!to) return;
      var p = Math.min(1, (now - t0) / T), fixed = keep + Math.floor(p * (text.length - keep));
      to.textContent = text.split('').map(function (c, k) { return k < fixed || c === '…' || c === '.' ? c : HEX[Math.floor(Math.random() * 16)]; }).join('');
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function amountField(input, decimals, whole) {
    function clean(e) {
      var v = input.value, at = input.selectionStart == null ? v.length : input.selectionStart;
      var out = '', caret = 0, point = -1;
      // pasted with both a point and a comma ("1,234.5"): the last of them is the decimal point, the others group
      // thousands; typed, a second separator is simply dropped
      var pasted = !e || /^insertFrom(Paste|Drop)$/.test(e.inputType || '');
      var dec = pasted && v.indexOf('.') >= 0 && v.indexOf(',') >= 0 ? Math.max(v.lastIndexOf('.'), v.lastIndexOf(',')) : -1;
      for (var k = 0; k < v.length; k++) {
        var c = v[k], keep = false;
        if (c >= '0' && c <= '9') keep = point < 0 ? whole == null || out.length < whole : decimals == null || out.length - point - 1 < decimals;
        else if ((c === '.' || c === ',') && point < 0 && (dec < 0 || k === dec)) { keep = true; point = out.length; }
        if (keep) { out += c; if (k < at) caret++; }
      }
      if (out !== v) { input.value = out; try { input.setSelectionRange(caret, caret); } catch (e) { /* not a text field */ } }
    }
    input.addEventListener('input', clean, true);
    clean();
  }

  window.BB = window.BB || {};
  window.BB.decode = decode;
  window.BB.amountField = amountField;
  window.BB.sites = SITES;
  window.BB.socials = SOCIALS;
  window.BB.logoSvg = logoSvg;
})();
