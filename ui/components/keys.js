/* BumbleBeam UI: the search boxes' keys, the same on every site. "/" puts the cursor in the header's search
   (.top-row .search input) unless you are typing somewhere; Esc in a search box (that one, or any input with
   data-esc) clears it, with an input event so the results follow, and leaves it once it is empty.
   A classic script, like the rest of ui/. */
(function () {
  'use strict';
  window.addEventListener('keydown', function (e) {
    var t = e.target, typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
      var s = document.querySelector('.top-row .search input');
      if (s) { e.preventDefault(); s.focus(); }
    } else if (e.key === 'Escape' && t && t.tagName === 'INPUT' && (t.closest('.search') || t.hasAttribute('data-esc'))) {
      if (t.value) { t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); } else t.blur();
    }
  });
})();
