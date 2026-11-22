/* BumbleBeam UI: number steppers. Every <input type="number" class="stepper"> gets the site's own up / down arrows
   (the accent chevrons of the card list) in place of the browser's spin buttons; they step by the input's step
   within its min and max, and fire input and change as typing does. Holding one repeats. */
(function () {
  'use strict';
  function arm(inp) {
    if (inp.dataset.stepper) return;
    inp.dataset.stepper = '1';
    var box = document.createElement('span'); box.className = 'stepper-box';
    inp.parentNode.insertBefore(box, inp); box.appendChild(inp);
    [['up', 'Increase', 1], ['down', 'Decrease', -1]].forEach(function (d) {
      var b = document.createElement('button'); b.type = 'button'; b.tabIndex = -1; b.className = 'stepper-' + d[0]; b.setAttribute('aria-label', d[1]);
      var hold = null, rep = null;
      function step() {
        if (inp.disabled) return;
        try { if (d[2] > 0) inp.stepUp(); else inp.stepDown(); } catch (e) { return; }
        inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true }));
      }
      function stop() { clearTimeout(hold); clearInterval(rep); }
      b.addEventListener('pointerdown', function (e) { e.preventDefault(); inp.focus(); step(); hold = setTimeout(function () { rep = setInterval(step, 70); }, 400); });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (ev) { b.addEventListener(ev, stop); });
      box.appendChild(b);
    });
  }
  function all(root) { (root || document).querySelectorAll('input[type="number"].stepper').forEach(arm); }
  window.BB = window.BB || {}; window.BB.steppers = all;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { all(); }); else all();
})();
