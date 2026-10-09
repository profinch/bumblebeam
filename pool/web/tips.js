// BumbleBeam tooltips: every element with a title, on the pool site and the explorer, gets the
// sites' own tooltip instead of the browser's. The title moves to data-tip on first use, so the
// native one never appears; elements rendered later work the same way. Mouse, keyboard focus and
// touch (tap to show, tap elsewhere to hide). Shared with the explorer, like styles.css.
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

  function show(el) {
    const text = textOf(el);
    if (!text) return;
    if (!tip.isConnected) document.body.appendChild(tip);
    current = el;
    tip.textContent = text;
    tip.classList.remove('on');
    place(el);
    el.setAttribute('aria-describedby', tip.id);
    requestAnimationFrame(() => tip.classList.add('on'));
  }

  function hide() {
    clearTimeout(timer);
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
  document.addEventListener('focusin', (e) => {
    const el = owner(e.target);
    if (el) show(el);
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  });
  // touch: a tap shows the tip of what was tapped (links and buttons still work), elsewhere hides it
  document.addEventListener('touchstart', (e) => {
    const el = owner(e.target);
    if (el && el !== current) show(el);
    else if (!el) hide();
  }, { passive: true });
  window.addEventListener('scroll', hide, { passive: true, capture: true });
  window.addEventListener('resize', hide);
})();
