// BumbleBeam tooltips: every element with a title, on the pool site and the explorer, gets the
// sites' own tooltip instead of the browser's. The title moves to data-tip on first use, so the
// native one never appears; elements rendered later work the same way. Mouse, keyboard focus and
// touch (tap to show, tap elsewhere to hide). A tip goes with its element: a click, the element gone or
// hidden, the pointer or the window gone. Part of the shared ui/ library (styles: .bb-tip, .tipped in ui/components.css).
(() => {
  if (window.__bbTips) return;
  window.__bbTips = true;

  const tip = document.createElement('div');
  tip.className = 'bb-tip';
  tip.id = 'bb-tip';
  tip.setAttribute('role', 'tooltip');
  let current = null;
  let timer = 0;

  // the element that carries a tip at or above node (SVG <title> children are left alone)
  const owner = (node) => {
    for (let n = node; n && n.nodeType === 1; n = n.parentNode) {
      if ((n.hasAttribute('title') && n.getAttribute('title')) || n.hasAttribute('data-tip')) return n;
    }
    return null;
  };
  const textOf = (el) => {
    const t = el.getAttribute('title');
    if (t) {
      el.setAttribute('data-tip', t);
      el.removeAttribute('title');
    }
    return el.getAttribute('data-tip') || '';
  };

  function place(el) {
    const r = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    tip.style.left = '0px';      // measured at the left edge: near the right one a fixed box shrinks to the room left
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const gap = 8;
    const above = r.top - h - gap >= 8 || r.bottom + h + gap > window.innerHeight;
    const cx = r.left + r.width / 2;
    const left = Math.min(Math.max(8, cx - w / 2), vw - w - 8);
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(above ? r.top - h - gap : r.bottom + gap)}px`;
    tip.classList.toggle('above', above);
    tip.classList.toggle('below', !above);
  }

  // an element that is still on the page and seen (not removed, not in a hidden screen)
  const seen = (el) => el && el.isConnected && el.getClientRects().length > 0;
  // what keeps a tip up: the pointer still on its element, or the keyboard's focus on it
  let byTouch = false;      // a tapped tip stays while its element does (until a tap elsewhere)
  const held = (el) => seen(el) && (byTouch || el.matches(':hover') || (el === document.activeElement && el.matches(':focus-visible')));

  function show(el) {
    if (!seen(el)) return;
    const text = textOf(el);
    if (!text) return;
    if (!tip.isConnected) document.body.appendChild(tip);
    current = el;
    tip.textContent = text;
    tip.classList.toggle('wide', el.hasAttribute('data-tip-wide'));      // opt-in: a wider tip, its line breaks kept
    tip.classList.remove('on');
    place(el);
    el.setAttribute('aria-describedby', tip.id);
    requestAnimationFrame(() => tip.classList.add('on'));
    watch();
  }

  // no event says that an element went away under a still pointer (a click that changes the screen, a list
  // redrawn, a window that closed): while a tip is up it is checked every 200 ms and goes with its element
  let watcher = 0;
  function watch() {
    clearInterval(watcher);
    watcher = setInterval(() => { if (!current || !held(current)) hide(); }, 200);
  }

  function hide() {
    byTouch = false;
    clearTimeout(timer);
    clearInterval(watcher);
    if (current) current.removeAttribute('aria-describedby');
    current = null;
    tip.classList.remove('on');
  }

  document.addEventListener('mouseover', (e) => {
    const el = owner(e.target);
    if (el === current) return;
    clearTimeout(timer);
    if (!el) return hide();
    textOf(el); // drop the native title right away, before the browser shows it
    timer = setTimeout(() => show(el), current ? 0 : 140);
  });
  document.addEventListener('mouseout', (e) => {
    const el = owner(e.target);
    if (el && !(e.relatedTarget && el.contains(e.relatedTarget))) hide();
  });
  // focus shows a tip only from the keyboard: not the focus a closed window gives back to its button
  document.addEventListener('focusin', (e) => {
    const el = owner(e.target);
    if (el && e.target.matches(':focus-visible')) show(el);
  });
  // a click acts: its tip has said its piece (and what it opens may cover or replace the element)
  document.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'touch') hide(); }, true);
  document.addEventListener('focusout', hide);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  });
  // touch: a tap shows the tip of what was tapped (links and buttons still work), elsewhere hides it
  document.addEventListener('touchstart', (e) => {
    const el = owner(e.target);
    if (el && el !== current) { show(el); byTouch = true; }
    else if (!el) hide();
  }, { passive: true });
  window.addEventListener('scroll', hide, { passive: true, capture: true });
  window.addEventListener('resize', hide);
  window.addEventListener('blur', hide);
  document.addEventListener('visibilitychange', hide);
  document.documentElement.addEventListener('mouseleave', hide);
})();
