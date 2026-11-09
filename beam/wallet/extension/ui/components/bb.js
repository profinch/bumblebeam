/* BumbleBeam UI web components, plain JS (a classic script: works from file://, inside the ESP32
   firmware page and the MV3 extension, and in Chromium 83, the Beam desktop wallet's browser).

   <bb-logo size="42"></bb-logo>
     The animated bee on the chain's hexagon (tokens: --logo-from, --logo-to). Styles: components.css .logo.

   <bb-eco here="pool"></bb-eco>
     The ecosystem bar: one line above the header linking every BumbleBeam site, the current one
     underlined. A site not in the list (or here="") underlines nothing. The list is SITES below:
     add a site there once and every page gets it on its next build. */
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

  window.BB = window.BB || {};
  window.BB.sites = SITES;
  window.BB.logoSvg = logoSvg;
})();
