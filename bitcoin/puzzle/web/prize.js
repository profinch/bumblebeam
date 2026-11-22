/* An open prize's key found in this browser outside the pool's pieces (/play's search, the home page's lucky key):
   all of it is the finder's. With a payout address saved in this browser the page builds the claim here and sends
   the whole prize there by itself through MARA Slipstream (the signed claim kept first, so a reload sends the same
   one again); without one, or when Slipstream does not take it, the key goes to our server's vault
   (POST /api/pool/solo, sealed, after a commitment to it is timestamped) and the finder is told to write to support.
   The key is never shown before the prize is spent and DEPTH blocks deep (read from mempool.space, never our server
   alone): before that, anyone who saw it (over a shoulder, in a screenshot or a stream, pasted into a wallet in a
   panic) could take the prize. Kept in this browser until then, and a week after.
   The card is the pool find's (findview.js): the title, one sentence, a bar with a cell for each step in the fold
   (the transaction, Slipstream; on the way to our server the commitment first, our server and its receipt; the
   prize), the note on the hidden key, then the key, the receipt and the picture to share.
   BBPrize({ box, keep, source, onReveal }): box, the element the card is drawn in; keep, the storage key; source,
   'play' or 'lucky' (what the vault is told); onReveal(key), called when the key may be shown. Returns
   { found(w), resume() }: found with { key: '0x…', puzzle, address, payout, secs }; resume, a find kept from before.
   Needs BBSecp, BBTx, BBKit, BBClaim, BBView, BB.esc. */
(function () {
  'use strict';
  var DEPTH = 6, SUPPORT = 'support@bumblebeam.org', RETRY_MS = 60000;

  window.BBPrize = function (opt) {
    var esc = window.BB.esc, S = window.BBSecp, C = window.BBClaim, K = window.BBKit, V = window.BBView, o = V.o;
    var box = opt.box, KEEP = opt.keep, vaultTimer = null, watchTimer = null, w = null, shownWaiting = false, animating = false, later = false;
    function keep() { try { localStorage.setItem(KEEP, JSON.stringify(w)); } catch (_) { /* no storage: this tab only */ } }
    function getJson(p) { return fetch(p, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }
    function payable() { return !!(w.payout && window.BBTx && BBTx.isAddress(w.payout)); }
    function sent() { return !!(w.slip && w.slip.ok); }
    function kept() { return !!(w.server && w.server.ok); }
    function vaultPath() { return !!w.why; }

    // ---------- the view ----------
    function steps(cal, calOk) {
      var S = V.step, list = [], refused = !!(w.server && w.server.refused);
      if (vaultPath()) list.push(S(!w.stamped ? 'wait' : calOk ? 'ok' : 'bad', 'Commitment', !w.commit ? 'making it' : !w.stamped ? 'on its way to the timestamp calendars' : calOk ? calOk + ' of ' + cal.length + ' calendars stamped <span class="mono" title="' + esc(w.commit) + '">' + esc(V.h88(w.commit)) + '</span>' : 'no calendar answered: the key goes to our server without the timestamp', 'Timestamping your find'));
      if (w.txid || w.buildError) list.push(S(w.txid ? 'ok' : 'bad', 'Transaction', w.txid ? o(K.btc(w.sats) + ' BTC') + ' to you, ' + o(K.btc(w.fee) + ' BTC') + ' in fees' + (w.checked === false ? ' (coins from one explorer, amounts checked against their transactions)' : '') : 'not built here: ' + esc(w.buildError)));
      else if (payable() && !vaultPath()) list.push(S('wait', 'Transaction', 'building it', 'Building your claim'));
      if (w.txid) list.push(S(!w.slip ? 'wait' : w.slip.ok ? 'ok' : 'bad', 'MARA Slipstream', (!w.slip ? 'sending ' : w.slip.ok ? 'submitted, transaction ' : (w.slip.said === 'cannot be reached' ? 'could not be reached' : /^no answer in/.test(w.slip.said || '') ? 'could not be reached (' + esc(w.slip.said) + ')' : 'refused it (' + esc(w.slip.said) + ')') + ', transaction ') + V.txLink(w.txid), 'Sending through MARA Slipstream'));
      if (vaultPath()) {
        list.push(kept() ? S('ok', 'Our server', 'verified the find and ' + (w.revealed ? 'held the key in a secure place until the spend' : 'holds the key in a secure place')) :
          refused ? S('bad', 'Our server', 'said no: ' + esc(w.server.said)) :
          w.server ? S('warn', 'Our server', esc(w.server.said) + ': tried again every minute', 'Our server not reached: trying every minute') :
          S('wait', 'Our server', 'telling it', 'Keeping the key on our server'));
        list.push(refused ? S('bad', 'Pool receipt', 'none: our server refused the key') :
          !w.receipt ? S('', 'Pool receipt', kept() ? 'none given by our server' : 'not yet: our server signs it when it takes the find') :
          S(w.receiptOk ? 'ok' : 'bad', 'Pool receipt', w.receiptOk ? 'signed with the published key' : 'it does not match this find, or is NOT signed with the key the pool publishes: it proves nothing'));
      }
      var d = w.depth || 0;
      list.push(w.revealed ? S('ok', 'The prize', sent() ? 'spent by your claim' : 'spent by the claim sent with support') :
        d > 0 ? S('wait', 'The prize', 'mined: ' + o(String(d)) + ' of ' + o(String(DEPTH)) + ' blocks', 'Mined: ' + d + ' of ' + DEPTH + ' blocks') :
        sent() ? S('wait', 'The prize', 'waiting for a block: ' + o('0') + ' of ' + o(String(DEPTH)), 'Waiting for a MARA block') :
        kept() ? S('wait', 'The prize', 'to be sent with support, from the key on our server', 'Waiting for support') :
        S('', 'The prize', 'not sent yet'));
      return list;
    }
    function render() {
      if (!w) return;
      if (animating) { later = true; return; }
      var mail = '<a href="mailto:' + SUPPORT + '?subject=' + encodeURIComponent('Puzzle #' + w.puzzle + ' key found') + '">' + SUPPORT + '</a>';
      var amount = w.sats ? o(K.btc(w.sats) + ' BTC') : null;
      var cal = w.cal || [], calOk = cal.filter(function (c) { return c.ok; }).length;
      var proof = w.commit ? ' ' + V.proof({ commit: w.commit, stamped: calOk > 0, receipt: !!w.receiptOk, payout: w.payout }) : '';
      var lead, warn = '';
      if (w.revealed) lead = 'The prize is spent' + (sent() && amount ? ': ' + amount + ' went to your address' : '') + '. The key is safe to show now.';
      else if (sent()) lead = (amount || 'The prize') + ' is on its way to your address. Nothing else for you to do.';
      else if (vaultPath()) {
        var why = !payable() ? 'This browser has no payout address to send the prize to' : !w.txid ? 'No claim could be built in this browser' : 'MARA Slipstream did not take your claim from this browser';
        if (w.server && w.server.refused) {
          lead = why + ', and our server refused the key (' + esc(w.server.said) + ').';
          warn = V.attn('<b>Write to ' + mail + ' now.</b> Tell us what our server said, and we will look at your find with you.' + proof);
        } else if (kept()) {
          lead = why + ', so the key is now kept on our server.';
          var with_ = payable() ? (w.receiptOk ? ', with the receipt attached,' : '') : ', with the address the prize should go to' + (w.receiptOk ? ' and the receipt attached' : '') + ',';
          warn = V.attn('<b>Write to ' + mail + ' now</b>' + with_ + ' so we can see the prize through with you.' + proof +
            (w.receiptOk ? '<div class="actions-row"><button class="btn solid" type="button" data-receipt>Save the receipt</button></div>' : ''));
        } else {
          lead = why + ', and our server cannot be reached from here either: the key is kept in this browser only.';
          warn = V.attn('<b>Write to ' + mail + ' now</b>, with the sealed find attached. Only our server can open it, so it is safe to send from any device, and it keeps your find even if this browser loses it. The page tries again every minute while it is open, and on your next visit.' + proof +
            (w.commit ? '<div class="actions-row"><button class="btn solid" type="button" data-sealed>Save the sealed find</button></div>' : ''));
        }
      } else lead = 'Sending the prize to your address through MARA Slipstream. Nothing for you to do but wait a moment.';

      // the words under the bar when no step is going on
      var end = w.revealed ? 'Spent and ' + DEPTH + ' blocks deep: the key is yours to see' : w.server && w.server.refused ? 'Our server refused the key' : 'Nothing could be sent from here';
      var list = steps(cal, calOk);
      var html = V.head(w.puzzle, w.t) + '<p class="found-lead">' + lead + '</p>' + warn + V.bar(list, end) + V.fold(list, w.foldClosed);
      var growing = false;
      if (w.revealed) {
        growing = shownWaiting && !animating;
        var k = BigInt(w.key), spend = w.spend || w.txid;
        var rows = (w.fee && sent() ? V.row('Miner fee', o(K.btc(w.fee) + ' BTC')) : '') +
          (vaultPath() ? V.calsRow(cal) + (w.commit ? V.hashRow('Commitment', w.commit) + V.hashRow('Salt', w.salt) : '') : '') +
          (spend ? V.hashRow('Transaction', spend) : '');
        var paper = V.paper({ puzzle: w.puzzle, t: w.t, rows: rows, toYou: w.sats && sent() ? o(K.btc(w.sats) + ' BTC') : null, payout: w.payout, signed: w.receiptOk }) +
          // a file with no receipt of our server in it is the find's details, not a receipt (/proof checks receipts)
          '<div class="actions-row found-acts"><button class="btn" type="button" data-receipt>' + (w.receiptOk ? 'Save the receipt' : 'Save the details') + '</button>' + pics.button + '</div>' + pics.panel();
        html += V.tail(growing, DEPTH, V.key(k, C.wif(k)), paper);
        shownWaiting = false;
      } else {
        shownWaiting = true;
        html += V.hidden(DEPTH);
      }
      var fw = box.querySelector('.panel-title .fw');
      box.hidden = false;
      box.innerHTML = html;
      if (fw && box.querySelector('.panel-title .star')) box.querySelector('.panel-title .star').insertAdjacentElement('afterend', fw);
      box.querySelector('.found-fold').addEventListener('toggle', function () { var c = !this.open; if (c !== !!w.foldClosed) { w.foldClosed = c; keep(); } });
      var sb = box.querySelector('[data-sealed]');
      if (sb) sb.addEventListener('click', function () { V.saveSealed('/api/pool/solo', soloBody(), w); });
      Array.prototype.forEach.call(box.querySelectorAll('[data-receipt]'), function (b) { b.addEventListener('click', function () { V.saveFile(receiptFile()); }); });
      pics.wire(box);
      if (growing) { animating = true; V.grow(box.querySelector('.found-tail'), function () { animating = false; if (later) { later = false; render(); } }); }
    }
    // the picture of the find to share, once its prize is safe (findview.js): /play's says how long the search took,
    // the lucky key's says it was luck
    var pics = V.pics(function () {
      var lucky = opt.source === 'lucky', secs = w.secs == null ? null : w.secs;
      return { n: w.puzzle, secs: secs, how: lucky ? 'lucky' : 'play', key: '0x' + BigInt(w.key).toString(16), address: w.address, date: V.day(w.t),
        text: 'I found the key to Bitcoin Puzzle #' + w.puzzle + (lucky ? ' by pure luck, on the BumbleBeam puzzle page' : (secs != null && window.BBShare ? ' in ' + BBShare.said(secs) : '') + ', right in my browser'),
        url: lucky ? 'https://puzzle.bumblebeam.org/' : 'https://puzzle.bumblebeam.org/play' };
    });
    // the find as a file: what the card shows, and the pool's signed receipt where there is one (the key kept on our
    // server): a receipt then, the find's details otherwise
    function receiptFile() {
      var cal = w.cal || [];
      var f = {
        puzzle: w.puzzle, address: w.address, found: new Date(w.t).toISOString(), source: opt.source,
        to_you: w.sats && sent() ? K.btc(w.sats) + ' BTC' : null, payout: w.payout || null, miner_fee: w.fee && sent() ? K.btc(w.fee) + ' BTC' : null,
        timestamp: w.commit ? { calendars: cal.filter(function (c) { return c.ok; }).length + ' of ' + cal.length, ots: w.ots || null } : null,
        commitment: w.commit || null, salt: w.salt || null, commitment_is: w.commit ? 'sha256(key ‖ payout address ‖ salt)' : undefined,
        transaction: w.spend || w.txid || null, signed_receipt: w.receipt || null,
      };
      return new File([JSON.stringify(f, null, 2)], 'bumblebeam-puzzle-' + w.puzzle + (w.receiptOk ? '-receipt' : '-details') + '.json', { type: 'application/json' });
    }

    // ---------- the prize to the saved payout address through Slipstream, built and signed here ----------
    async function claim() {
      render();
      if (!w.hex) {
        try {
          var p = await C.prepare({ puzzle: w.puzzle, address: w.address }, 0);
          var b = K.build({ key: BigInt(w.key), utxos: p.utxos, payout: w.payout, poolPayout: null, rate: p.rate });
          w.hex = b.slip.hex; w.txid = b.slip.txid; w.fee = b.slip.fee; w.sats = b.slip.total - b.slip.fee; w.checked = p.checked; w.buildError = null;
          keep(); render();
        } catch (e) { w.buildError = e.message; keep(); return vault('the claim could not be built here (' + e.message + ')'); }
      }
      var r = await C.sendTx(w.hex);
      // a claim Slipstream took once stays taken (a later "already known" changes nothing)
      if (!sent()) { w.slip = { ok: r.ok, said: r.said }; if (r.ok) w.sent = Date.now(); keep(); }
      if (!sent()) return vault('MARA Slipstream did not take the claim (' + r.said + ')');
      render();
      watch();
    }

    // ---------- the key to our server, which keeps it until the prize is spent ----------
    // first a commitment to it timestamped by the public calendars (proof that this browser had it, and when), then
    // the key, sealed; tried again every minute until the server has it. The finder is told to write to support at once
    async function vault(why) {
      if (w.revealed) return;
      w.why = w.why || why; keep(); render();
      if (!w.commit) { w.salt = C.salt(); w.commit = K.commitment(BigInt(w.key), w.payout || '', w.salt); keep(); }
      if (!w.stamped) { try { var st = await C.stamp(w.commit); w.cal = st.cal; w.ots = st.ots; } catch (_) { w.cal = []; w.ots = null; } w.stamped = true; keep(); render(); }
      clearTimeout(vaultTimer);
      if (kept()) return;
      // a signed claim Slipstream did not take is offered again while our server cannot be reached (as the pool's
      // find does): taken now, it is on its way, and the key still goes to our server for the receipt
      if (w.hex && w.slip && !sent() && w.server && !w.server.ok && !w.server.refused) {
        var again = await C.sendTx(w.hex);
        if (!sent()) { w.slip = { ok: again.ok, said: again.said }; if (again.ok) w.sent = Date.now(); keep(); render(); }
      }
      try {
        var r = await C.postSealed('/api/pool/solo', soloBody(), 20000);
        w.server = { ok: true, t: Date.now() }; w.vaulted = Date.now();
        takeReceipt(r && r.receipt);
      } catch (e) {
        // refused (spent already, or not this puzzle's key): said, not sent again; anything else, again in a minute
        if (e.status >= 400 && e.status < 500 && e.status !== 429) w.server = { ok: false, refused: true, said: e.message, t: Date.now() };
        else { w.server = { ok: false, said: e.message, t: Date.now() }; vaultTimer = setTimeout(function () { vault(why); }, RETRY_MS); }
      }
      keep(); render();
    }
    // what POST /api/pool/solo is sent: the same in the sealed find a finder sends to support
    function soloBody() { return { key: w.key, puzzle: w.puzzle, source: opt.source, payout: w.payout || null, salt: w.salt, commitment: w.commit, ots: w.ots }; }
    // the pool's receipt for a key kept on its server: good when it names this commitment and payout address and its
    // signature holds with the key the pool publishes
    function takeReceipt(rc) {
      if (!rc) return;
      var b = rc.body || {};
      w.receipt = rc;
      w.receiptOk = !!(b.commitment === w.commit && (b.payout || '') === (w.payout || '') && Number(b.puzzle) === Number(w.puzzle) && K.receiptVerify(rc) && rc.pub === K.RECEIPT_PUB);
    }

    // ---------- how deep the prize's spend is ----------
    // the claim sent from here, or the spend our server saw (a key kept on the server, claimed with support); shown
    // once it is DEPTH deep and no coin of the prize is left. Looked at every minute
    async function watch() {
      clearTimeout(watchTimer);
      if (w.revealed) return;
      try {
        var p = await getJson('/api/puzzles/' + w.puzzle).catch(function () { return null; });
        var ids = [w.txid, p && p.solved && p.solved.txid].filter(Boolean), depth = 0, spend = null;
        for (var i = 0; i < ids.length && depth <= 0; i++) {
          var st = await C.getJson(C.MEMPOOL + '/tx/' + ids[i] + '/status', null, 8000).catch(function () { return null; });
          if (st && st.confirmed) { depth = Number(await C.getText(C.MEMPOOL + '/blocks/tip/height', 8000)) - st.block_height + 1; spend = ids[i]; }
        }
        if (depth > 0 && depth !== w.depth) { w.depth = depth; keep(); render(); }
        if (depth >= DEPTH) {
          var u = await C.getJson(C.MEMPOOL + '/address/' + w.address + '/utxo', null, 8000);
          if (!u.some(function (c) { return c.value >= K.MIN_COIN; })) { reveal(spend); return; }
        }
      } catch (_) { /* the next look */ }
      watchTimer = setTimeout(watch, RETRY_MS);
    }
    // the prize is spent and deep: nothing is left for the key to take, it is shown (and kept here a week)
    function reveal(spend) {
      clearTimeout(vaultTimer);
      if (!w.revealed) { w.revealed = Date.now(); w.spend = spend || w.spend || null; keep(); }
      render();
      if (opt.onReveal) opt.onReveal(BigInt(w.key));
    }
    window.addEventListener('bb:leave', function () { clearTimeout(vaultTimer); clearTimeout(watchTimer); }, { once: true });

    return {
      // a key just found: kept in this browser, then sent or kept on the server
      found: function (f) {
        w = { key: f.key, puzzle: f.puzzle, address: f.address, payout: f.payout || null, secs: f.secs == null ? null : f.secs, t: Date.now() };
        keep();
        if (payable()) claim(); else vault('this browser has no payout address to send it to');
        box.scrollIntoView({ behavior: 'smooth' });
        watch();
      },
      // a key found here before for a prize not safe yet: on its way again, never shown before it is safe
      resume: function () {
        var x = null;
        try { x = JSON.parse(localStorage.getItem(KEEP) || 'null'); } catch (_) { x = null; }
        var forget = function () { try { localStorage.removeItem(KEEP); } catch (_) { /* no storage */ } };
        if (!x || !/^0x[0-9a-f]{1,64}$/.test(x.key)) return false;
        if (S.hash160ToAddress(S.hash160OfKey(BigInt(x.key))) !== x.address) { forget(); return false; }
        w = x;
        // shown once it was safe: shown again for a week, then forgotten
        if (w.revealed) { if (Date.now() - w.revealed > 7 * 864e5) { forget(); w = null; return false; } render(); if (opt.onReveal) opt.onReveal(BigInt(w.key)); return true; }
        // the same signed claim to Slipstream again (it changes nothing if Slipstream has it); a key on its way to
        // our server goes on there
        if (w.why) vault(w.why); else if (payable()) claim(); else vault('this browser has no payout address to send it to');
        watch();
        return true;
      },
    };
  };
})();
