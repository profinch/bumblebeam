/* The find's card, as every find draws it (found.js for a pool find, prize.js for a key found on /play or by the
   home page's lucky key): the same title, sentence, bar of steps, steps in a fold, note on the hidden key, key with
   its WIF and paper receipt, and the same grow when the key turns safe to show while the page is open.
   Needs BB.esc (and BBSeal for a sealed find). Exposes BBView. */
(function () {
  'use strict';
  if (window.BBView) return;
  var esc = window.BB.esc;

  // a hash as its first and last eight characters (the whole on hover, where it is drawn)
  function h88(x) { x = String(x || ''); return x.length > 20 ? x.slice(0, 8) + '…' + x.slice(-8) : x; }
  // an amount in the accent colour, its unit with it
  function o(x) { return '<span class="o">' + esc(x) + '</span>'; }
  function two(n) { return (n < 10 ? '0' : '') + n; }
  function when(t) { var d = new Date(t); return two(d.getDate()) + '.' + two(d.getMonth() + 1) + '.' + d.getFullYear() + ', ' + two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds()); }
  function line(cls, name, text) { return '<li class="' + cls + '"><b>' + esc(name) + '</b><span>' + text + '</span></li>'; }
  function txLink(id) { return '<a class="mono h88" href="/api/go/tx/' + esc(id) + '" target="_blank" rel="noopener" title="' + esc(id) + '">' + esc(h88(id)) + '</a>'; }
  // ui's copy button for a value (bb.js copies it, a tick for 2 s)
  function cpBtn(v, label) { return '<button type="button" class="cp" data-copy="' + esc(v) + '" title="' + esc(v) + '" aria-label="' + esc(label || 'Copy ' + v) + '"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></button>'; }
  // the title: the star (the confetti flies from it) and the puzzle, the time of the find on the right
  function head(puzzle, t) { return '<div class="panel-head"><h2 class="panel-title"><span class="star">★</span> You found the key to <span class="o">puzzle #' + esc(puzzle) + '</span></h2>' + (t ? '<div class="panel-meta">' + esc(when(t)) + '</div>' : '') + '</div>'; }
  // a step of the find: its class (ok ✓, bad ✗, wait … for the one going on, warn ! for one tried again, '' for one
  // not reached), its name, its words (html) and, for the step going on, the words under the bar
  function step(cls, name, text, say) { return { cls: cls, name: name, text: text, say: say || '' }; }
  // the bar: one cell for each step in the fold, in its order and its colour (✓ green, ✗ red, the step going on
  // orange: the first one waiting or tried again; a step not reached stays grey), and under it the words of that
  // step, or end when no step is going on
  function bar(steps, end) {
    var now = steps.findIndex(function (s) { return s.cls === 'wait' || s.cls === 'warn'; });
    return '<div class="found-bar" aria-hidden="true">' + steps.map(function (s, i) { return '<i class="' + (s.cls === 'ok' ? 'd' : s.cls === 'bad' ? 'bad' : i === now ? 'n' : '') + '"></i>'; }).join('') + '</div>' +
      '<div class="found-say">' + esc(now >= 0 ? steps[now].say || end : end) + '</div>';
  }
  // the steps in their fold, open unless the finder folded them
  function fold(steps, closed) { return '<details class="fold found-fold"' + (closed ? '' : ' open') + '><summary>What happened, step by step</summary><ul class="checks found-steps">' + steps.map(function (s) { return line(s.cls, s.name, s.text); }).join('') + '</ul></details>'; }
  // the sentence on what proves the find: the commitment (8…8, the whole on hover), stamped or not, and the pool's
  // receipt; who: "your address" (a payout address given) or "this browser"
  function proof(p) {
    var c = p.commit ? ' <code class="mark" title="' + esc(p.commit) + '">' + esc(h88(p.commit)) + '</code>' : '', who = p.payout ? 'your address' : 'this browser';
    if (p.stamped) return 'Your commitment' + c + ' is timestamped' + (p.receipt ? ' and our server signed a receipt for your find' : '') + ': proof that ' + who + ' found this key, and when.';
    if (p.receipt) return 'No timestamp calendar answered, but our server signed a receipt for your find' + (c ? ' and its commitment' + c : '') + ': proof that ' + who + ' found this key.';
    return 'Your commitment' + c + ' is made, but no timestamp calendar answered, so it has no time yet.';
  }
  // the info block (an "i" in a honeycomb cell) and the attention block (a "!", red): for what to do now
  function info(html, cls) { return '<div class="tile key-info' + (cls ? ' ' + cls : '') + '"><span class="key-info-badge" aria-hidden="true">i</span>' + html + '</div>'; }
  function attn(html) { return '<div class="tile key-info attn"><span class="key-info-badge" aria-hidden="true">!</span>' + html + '</div>'; }
  function hidden(depth) { return info('The key stays hidden until the prize is ' + depth + ' blocks deep, and this browser keeps it until then (a reload carries on where it stopped).', 'found-hidden'); }
  // the key as the home page's lucky key draws one (its leading zeros dim), a copy button, then its WIF
  function key(k, wif) {
    var hex = k.toString(16).padStart(64, '0'), known = 64 - k.toString(16).length, cells = '<span class="kx">0x</span>';
    for (var c = 0; c < 64; c++) cells += (c % 8 === 0 ? (c ? '</span>' : '') + '<span class="kg">' : '') + '<i class="' + (c < known ? 'z' : 'o') + '">' + hex[c] + '</i>';
    return '<div class="found-key"><div class="k">Private key (hex)</div><div class="keyline">' + cells + '</span>' + cpBtn('0x' + hex, 'Copy the key') + '</div>' +
      '<div class="k">WIF (compressed)</div><div class="mono wif">' + esc(wif) + cpBtn(wif) + '</div></div>';
  }
  // the paper receipt: rows of [name, html], a hash row is [name, hash] with hash: true (copy, 8…8, the whole on hover)
  function row(a, b) { return '<div class="ln"><span>' + esc(a) + '</span><span></span><span>' + b + '</span></div>'; }
  function hashRow(a, h) { return row(a, cpBtn(h) + '<span title="' + esc(h) + '">' + esc(h88(h)) + '</span>'); }
  // the calendars asked, each with what it said, under the Timestamp row
  function cals(cal) { return cal.length ? '<div class="cals">' + cal.map(function (c) { return '<div class="' + (c.ok ? 'ok' : 'bad') + '"' + (c.ok ? '' : ' title="' + esc(c.said || '') + '"') + '>' + esc(c.url.replace('https://', '')) + '<i>' + (c.ok ? '✓' : '✗') + '</i></div>'; }).join('') + '</div>' : ''; }
  function calsRow(cal) { var ok = cal.filter(function (c) { return c.ok; }).length; return row('Timestamp', cal.length ? ok + ' of ' + cal.length + ' calendars' : 'none') + cals(cal); }
  // p: { puzzle, t, rows (html), toYou (html or null), payout, signed }
  function paper(p) {
    return '<div class="paper"><h3>Puzzle #' + esc(p.puzzle) + ' claim</h3><div class="c">' + esc(when(p.t)) + '</div>' + p.rows +
      '<div class="cut"></div>' +
      (p.toYou ? '<div class="ln tot"><span>To you</span><span></span><span>' + p.toYou + '</span></div>' : '') +
      (p.payout ? '<div class="c">' + esc(p.payout) + '</div>' : '') +
      (p.signed ? '<div class="sealw"><span class="seal">✓ signed by the<br>BumbleBeam puzzle pool</span></div>' : '') + '</div>';
  }
  // the card's tail: the note on the hidden key, or (the key safe) the key and the receipt; growing, when the note
  // was on screen a moment ago (grow())
  function tail(growing, depth, keyHtml, paperHtml) {
    return '<div class="found-tail' + (growing ? ' grow' : '') + '">' + (growing ? hidden(depth).replace('found-hidden', 'found-hidden leaving') : '') +
      '<div class="rv-key">' + keyHtml + '</div><div class="rv-paper">' + paperHtml + '</div></div>';
  }
  // the prize turned safe while the page is open, in one movement: the note on the hidden key fades out; the tail
  // grows from the note's height to the key's and its WIF's, which fade in; it grows on to the receipt's, which
  // fades in last. One height animation with its stages as keyframes: never a step. A browser asking for less
  // motion gets them at once. done() when it ends (at once, when there is nothing to grow)
  function grow(t, done) {
    var note = t && t.querySelector('.leaving'), k = t && t.querySelector('.rv-key'), pp = t && t.querySelector('.rv-paper');
    var still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches, anims = [];
    function end() { anims.forEach(function (a) { a.cancel(); }); if (note) note.remove(); if (t) t.classList.remove('grow'); if (done) done(); }
    if (!t || !t.animate || still || !note) return end();
    var top = t.getBoundingClientRect().top;
    // the last height is the tail's own (the note is out of the flow, the tail holds its children's margins: the
    // same box with .grow and without, so nothing moves when it ends)
    var hNote = note.getBoundingClientRect().bottom - top, hKey = k.getBoundingClientRect().bottom - top, hAll = t.offsetHeight;
    var D = 2600, opts = { duration: D, fill: 'both' };
    anims.push(note.animate([{ opacity: 1 }, { opacity: 0, offset: 0.16 }, { opacity: 0 }], opts));
    anims.push(t.animate([
      { height: hNote + 'px', offset: 0 }, { height: hNote + 'px', offset: 0.16 },
      { height: hKey + 'px', offset: 0.42, easing: 'ease-in-out' }, { height: hKey + 'px', offset: 0.5 },
      { height: hAll + 'px', offset: 0.82, easing: 'ease-in-out' }, { height: hAll + 'px', offset: 1 }], { duration: D, fill: 'both', easing: 'linear' }));
    anims.push(k.animate([{ opacity: 0 }, { opacity: 0, offset: 0.3 }, { opacity: 1, offset: 0.5 }, { opacity: 1 }], opts));
    anims.push(pp.animate([{ opacity: 0 }, { opacity: 0, offset: 0.68 }, { opacity: 1, offset: 0.9 }, { opacity: 1 }], opts));
    anims[1].onfinish = end;
    return true;
  }
  // the confetti with bees from the title's star, as on /play (the find just made; not for a browser asking for less
  // motion)
  function cheer(box) {
    var star = box.querySelector('.panel-title .star');
    if (star && window.BB && BB.confetti && !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) setTimeout(function () { BB.confetti(star); }, 60);
  }
  // a file saved from the page
  function saveFile(file) {
    var a = document.createElement('a'), url = URL.createObjectURL(file);
    a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  // the picture of a find whose prize is safe, to share (sharecard.js, as /play's for a solved puzzle): three sizes,
  // the one picked big, Save image and Share. data(): the picture's { n, secs, how, key, address, date } and the words
  // shared with it { text, url }. Returns { button, panel, wire(root) }: the button and the panel go into the card's html, wire()
  // after each drawing of it
  function pics(data) {
    var st = { open: false, fmt: 'link', blobs: {}, urls: {}, key: null }, root = null;
    function show() {
      var box = root && root.querySelector('.found-share'); if (!box || !window.BBShare) return;
      box.hidden = !st.open;
      var opts = box.querySelector('.fs-fmt');
      opts.innerHTML = BBShare.FORMATS.map(function (f) { return '<button type="button" class="share-opt' + (f.id === st.fmt ? ' on' : '') + '" role="radio" aria-checked="' + (f.id === st.fmt) + '" data-f="' + f.id + '"><b>' + f.label + '</b><span>' + f.w + ' × ' + f.h + '</span><p>' + f.hint + '</p></button>'; }).join('');
      var f = BBShare.FORMATS.filter(function (x) { return x.id === st.fmt; })[0], img = box.querySelector('.share-pic');
      img.className = 'share-pic' + (f.h > f.w ? ' tall' : '');
      if (st.urls[st.fmt]) img.src = st.urls[st.fmt]; else img.removeAttribute('src');
      if (!st.open) return;
      // all three drawn once, for this key (Share has its file at the tap)
      var d = data();
      if (st.key !== d.key) {
        st.key = d.key; st.blobs = {}; st.urls = {};
        BBShare.FORMATS.reduce(function (chain, fm) {
          return chain.then(function () {
            return BBShare.render(fm.id, d).then(function (cv) { return new Promise(function (ok) { cv.toBlob(ok, 'image/png'); }); }).then(function (b) {
              if (st.key !== d.key) return;
              st.blobs[fm.id] = b; st.urls[fm.id] = URL.createObjectURL(b);
              if (fm.id === st.fmt) show();
            });
          });
        }, Promise.resolve());
      }
    }
    function file() { return new File([st.blobs[st.fmt]], 'bitcoin-puzzle-' + data().n + '-' + st.fmt + '.png', { type: 'image/png' }); }
    function share() {
      var btn = this, d = data(), title = 'Bitcoin Puzzle #' + d.n, text = d.text, url = d.url;
      var f = st.blobs[st.fmt] && file();
      if (f && navigator.canShare && navigator.canShare({ files: [f] })) { navigator.share({ files: [f], title: title, text: text + ': ' + url }).catch(function () { /* closed */ }); return; }
      if (navigator.share) { navigator.share({ title: title, text: text, url: url }).catch(function () { /* closed */ }); return; }
      if (navigator.clipboard) navigator.clipboard.writeText(text + ': ' + url).then(function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Share'; }, 1600); }).catch(function () {});
    }
    return {
      button: '<button class="btn ghost" type="button" data-pic>Share preview</button>',
      panel: function () {
        return '<div class="share found-share"' + (st.open ? '' : ' hidden') + '><div class="k">Share your find</div><div class="share-g"><div class="share-stage"><img class="share-pic" alt="A picture of this find to share"></div>' +
          '<div class="share-side"><div class="fs-fmt" role="radiogroup" aria-label="Picture size"></div><div class="actions-row"><button class="btn solid" type="button" data-img-save>Save image</button><button class="btn ghost" type="button" data-img-share>Share</button></div></div></div></div>';
      },
      wire: function (r) {
        root = r;
        var pb = r.querySelector('[data-pic]'); if (!pb) return;
        pb.addEventListener('click', function () { st.open = !st.open; show(); if (st.open) r.querySelector('.found-share').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
        r.querySelector('.fs-fmt').addEventListener('click', function (e) { var b = e.target.closest('button[data-f]'); if (b) { st.fmt = b.getAttribute('data-f'); show(); } });
        r.querySelector('[data-img-save]').addEventListener('click', function () { var u = st.urls[st.fmt]; if (!u) return; var a = document.createElement('a'); a.href = u; a.download = file().name; document.body.appendChild(a); a.click(); a.remove(); });
        r.querySelector('[data-img-share]').addEventListener('click', share);
        show();
      },
    };
  }
  // the date of a find as the picture writes it
  function day(t) { var d = new Date(t); return two(d.getDate()) + '.' + two(d.getMonth() + 1) + '.' + d.getFullYear(); }

  // the find sealed for our server alone (engine/seal.js, the request it would have sent to path): a file the finder
  // sends to support when neither Slipstream nor our server can be reached; only the pool can open it, so it is safe
  // to send from any device, and support gives its sealed part to path as it is. w: { puzzle, address, payout, commit }
  function saveSealed(path, body, w) {
    return window.BBSeal.seal(path, body).then(function (s) {
      var f = {
        what: 'A find sealed for the BumbleBeam puzzle pool: only its server can open it. Send this file to support@bumblebeam.org.',
        puzzle: w.puzzle, address: w.address, payout: w.payout || null, commitment: w.commit || null, made: new Date().toISOString(),
        path: path, sealed: s.body,
      };
      saveFile(new File([JSON.stringify(f, null, 2)], 'bumblebeam-puzzle-' + w.puzzle + '-sealed-find.json', { type: 'application/json' }));
    });
  }

  window.BBView = { h88: h88, o: o, two: two, when: when, line: line, step: step, txLink: txLink, cpBtn: cpBtn, head: head, bar: bar, fold: fold, proof: proof, info: info, attn: attn, hidden: hidden,
    key: key, row: row, hashRow: hashRow, cals: cals, calsRow: calsRow, paper: paper, tail: tail, grow: grow, cheer: cheer, saveFile: saveFile, saveSealed: saveSealed, pics: pics, day: day };
})();
