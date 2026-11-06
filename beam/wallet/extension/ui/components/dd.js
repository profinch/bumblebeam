/* BumbleBeam UI: the card list (.dd), a small listbox in place of a native <select>, whose open list the
   browser draws itself (system colours, square corners). Opened, it continues the button seamlessly (styles:
   .dd, .dd-btn, .dd-list in components.css). Keyboard: arrows, Home/End, Enter or Space to pick, Esc or Tab to
   close. The pool and its dashboard use it too.

   Markup:
     <div class="dd" id="x" data-value="b">
       <button type="button" class="dd-btn" aria-haspopup="listbox" aria-expanded="false"></button>
       <ul class="dd-list" role="listbox" tabindex="-1" hidden>
         <li role="option" data-v="a">First</li><li class="dd-group" role="presentation">Group</li><li role="option" data-v="b">Second</li>
       </ul>
     </div>
   Script:
     var d = BB.dropdown(document.getElementById('x'), function (v) { ... });  // onPick(value)
     d.set('a');  d.value();  d.options([{ v: 'a', label: 'First' }, { group: 'Group' }, ...], 'a');
   A classic script; works in Chromium 83 and the MV3 extension like the rest of ui/. */
(function () {
  'use strict';
  function dropdown(root, onPick) {
    var btn = root.querySelector('.dd-btn'), list = root.querySelector('.dd-list');
    var active = -1;
    function items() { return Array.prototype.slice.call(list.querySelectorAll('[role="option"]')); }
    function isOpen() { return !list.hidden; }
    function mark(i) {
      var its = items();
      active = i;
      its.forEach(function (li, j) { li.classList.toggle('active', j === i); });
      if (its[i]) its[i].scrollIntoView({ block: 'nearest' });
    }
    function set(v) {
      var its = items();
      var li = its.filter(function (x) { return x.getAttribute('data-v') === String(v); })[0] || its.filter(function (x) { return x.getAttribute('data-v') === ''; })[0] || its[0];
      its.forEach(function (x) { x.setAttribute('aria-selected', String(x === li)); });
      root.setAttribute('data-value', li ? li.getAttribute('data-v') : '');
      btn.textContent = li ? li.textContent : '';
    }
    function open() {
      list.hidden = false;
      root.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      var its = items();
      mark(Math.max(0, its.findIndex(function (x) { return x.getAttribute('aria-selected') === 'true'; })));
    }
    function close(focus) {
      list.hidden = true;
      root.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      if (focus !== false) btn.focus();
    }
    function pick(i) {
      var li = items()[i];
      if (!li) return;
      set(li.getAttribute('data-v'));
      close();
      if (onPick) onPick(li.getAttribute('data-v'));
    }
    btn.addEventListener('click', function () { if (isOpen()) close(); else open(); });
    list.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep focus on the button
    list.addEventListener('click', function (e) { var li = e.target.closest('[role="option"]'); if (li) pick(items().indexOf(li)); });
    list.addEventListener('mousemove', function (e) { var li = e.target.closest('[role="option"]'); var i = li ? items().indexOf(li) : -1; if (li && i !== active) mark(i); });
    btn.addEventListener('keydown', function (e) {
      var k = e.key, n = items().length;
      if (!isOpen()) {
        if (['ArrowDown', 'ArrowUp', 'Enter', ' '].indexOf(k) >= 0) { e.preventDefault(); open(); }
        return;
      }
      if (k === 'ArrowDown') { e.preventDefault(); mark(Math.min(n - 1, active + 1)); }
      else if (k === 'ArrowUp') { e.preventDefault(); mark(Math.max(0, active - 1)); }
      else if (k === 'Home') { e.preventDefault(); mark(0); }
      else if (k === 'End') { e.preventDefault(); mark(n - 1); }
      else if (k === 'Enter' || k === ' ') { e.preventDefault(); pick(active); }
      else if (k === 'Escape') { e.preventDefault(); close(); }
      else if (k === 'Tab') close(false);
    });
    document.addEventListener('click', function (e) { if (isOpen() && !root.contains(e.target)) close(false); });
    // rebuild the options: [{ v, label }] or { group: 'Name' } for a heading
    function options(opts, value) {
      list.innerHTML = '';
      opts.forEach(function (o) {
        var li = document.createElement('li');
        if (o.group) { li.className = 'dd-group'; li.setAttribute('role', 'presentation'); li.textContent = o.group; }
        else { li.setAttribute('role', 'option'); li.setAttribute('data-v', String(o.v)); li.textContent = o.label; }
        list.appendChild(li);
      });
      set(value !== undefined ? value : root.getAttribute('data-value') || '');
    }
    set(root.getAttribute('data-value') || '');
    return { set: set, options: options, value: function () { return root.getAttribute('data-value') || ''; } };
  }
  window.BB = window.BB || {};
  window.BB.dropdown = dropdown;
})();
