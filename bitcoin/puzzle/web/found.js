/* The find: what this browser does by itself the moment the pool's search finds the puzzle's key, in this order
   and with no button (a second or two when everything answers):
   1. the commitment: h = sha256(key ‖ payout address ‖ a fresh 32-byte salt) goes to the public OpenTimestamps
      calendars (only h, which gives the key away to nobody), and their answers become a standard .ots file: proof
      that this payout address knew the key at this moment;
   2. the transaction: the split (the prize's whole bitcoins but one to the payout address given before the search,
      the rest to the pool, the fees out of the pool's part), built, signed and checked here, goes out through MARA
      Slipstream: a private relay, never the public mempool, never our own node;
   3. then the pool: the key, the salt, the commitment, Slipstream's answer and the signed transaction go to
      POST /api/pool/found, which checks them, closes the piece and sees the claim through (fee bumps included).
   The server hears of the find only after Slipstream was tried: knowing which piece holds the key, it could search
   that piece itself in minutes. When Slipstream did not take the claim (or none could be built), the key still goes
   to the server, which writes it down (its vault) and sends the claim itself, and the page tells the finder to write
   to support, with the pool's receipt. The key is not shown on the page until the claim is spent and deep in the chain (nothing left to
   steal then): the finder sees what was sent, to whom and what Slipstream answered.
   Everything is kept in this browser (localStorage 'bb-win') after each step, so a reload or a closed tab carries on
   where it stopped. When the server cannot be reached either, the key stays in this browser, tried again every
   minute, and the finder can save the find sealed for our server alone (findview.js) and send it to support.
   Needs BBSecp, BBTx, BBPuzzles, BBKit, BBClaim. Exposes BBFound. */
(function () {
  'use strict';
  if (window.BBFound) return;
  var S = window.BBSecp, T = window.BBTx, PZ = window.BBPuzzles, K = window.BBKit, C = window.BBClaim;
  // the claim is believed spent (and the key shown) once it is this many blocks deep, as the server publishes it
  var DEPTH = 6;
  var KEEP = 'bb-win', RETRY_MS = 60000, SUPPORT = 'support@bumblebeam.org';

  var esc = window.BB.esc; // ui/components/bb.js
  var h88 = window.BBView.h88;
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function load() { try { return JSON.parse(localStorage.getItem(KEEP) || 'null'); } catch (_) { return null; } }
  function save() { if (leaving) return; try { if (rec) localStorage.setItem(KEEP, JSON.stringify(rec)); } catch (_) { /* no storage: this tab only */ } }
  // a page being left (a reload, a closed tab) writes and sends nothing more: its requests are cut off, and a cut
  // request is no answer (Slipstream did not refuse anything); the next page carries on from what was kept
  var leaving = false;
  window.addEventListener('pagehide', function () { leaving = true; });
  // back from the browser's page cache: the page goes on (its cut requests are tried again)
  window.addEventListener('pageshow', function (e) { if (e.persisted && leaving) { leaving = false; if (rec) { var w = load(); if (valid(w) && w.key === rec.key) rec = w; run(); } } });

  var rec = null, el = null, busy = false, timer = null, forgotten = [], cheer = false, shownWaiting = false, animating = false, later = false;

  // a kept find is used only when it is what it says: the key opens the address, and the address is the puzzle's
  function valid(w) {
    if (!w || !/^0x[0-9a-f]{1,64}$/.test(w.key) || !PZ.address(w.puzzle)) return false;
    try { return S.hash160ToAddress(S.hash160OfKey(BigInt(w.key))) === w.address && w.address === PZ.address(w.puzzle); } catch (_) { return false; }
  }
  function relayOk() { return !!(rec.relays && rec.relays.slipstream && rec.relays.slipstream.ok); }
  function serverOk() { return !!(rec.server && rec.server.ok); }
  // stuck in this browser: neither Slipstream nor our server took anything (or a find from before the page sent
  // anything by itself)
  function alone() {
    if (!rec.lease || !rec.payout) return true;
    return !!(rec.relayed && rec.serverTried && !relayOk() && !serverOk());
  }
  function txids() { return [rec.tx && rec.tx.slipstream && rec.tx.slipstream.txid].filter(Boolean); }

  // ---------- 1. the commitment, stamped (claim.js asks the calendars) ----------
  async function stamp() { var r = await C.stamp(rec.commit); rec.cal = r.cal; rec.ots = r.ots; }

  // ---------- 2. the transaction, built and checked here, then sent through Slipstream ----------
  async function build() {
    var key = BigInt(rec.key);
    var p = await C.prepare({ puzzle: rec.puzzle, address: rec.address });
    var b = K.build({ key: key, utxos: p.utxos, payout: rec.payout, poolPayout: rec.poolPayout, rate: p.rate });
    // checked again as the server will: only the puzzle's coins, every signature, nobody else paid
    var coins = {}; p.utxos.forEach(function (u) { coins[u.txid + ':' + u.vout] = u.value; });
    var c = K.checkTx(b.slip.hex, { key: key, coins: coins, payout: rec.payout, poolPayout: rec.poolPayout });
    rec.tx = { slipstream: { hex: b.slip.hex, txid: b.slip.txid, rate: b.slip.rate, total: c.total, finder: c.finder, pool: c.pool, fee: c.fee } };
    rec.notes = p.notes; rec.checked = p.checked;
  }
  async function relay() {
    rec.relays = rec.relays || {};
    if (rec.tx) rec.relays.slipstream = await C.sendTx(rec.tx.slipstream.hex);
    rec.relayed = true; // tried (or nothing could be built to try)
  }

  // ---------- 3. the pool: only now does the key leave this browser ----------
  // what POST /api/pool/found is sent: the same in the sealed find a finder sends to support
  function foundBody() {
    return {
      lease: rec.lease, key: rec.key, salt: rec.salt, payout: rec.payout, commitment: rec.commit, ots: rec.ots,
      txs: rec.tx ? [{ relay: 'slipstream', hex: rec.tx.slipstream.hex }] : [],
      receipts: rec.relays || {},
    };
  }
  async function tell() {
    var body = foundBody();
    for (var i = 0; i < 3; i++) {
      try {
        var r = await C.postSealed('/api/pool/found', body, 20000);
        rec.server = { ok: true, said: r.already ? 'had it already' : 'checked and kept it', t: Date.now() };
        takePoolTxs(r.find && r.find.pool_txs);
        takeReceipt(r.find && r.find.receipt);
        rec.told = true;
        break;
      } catch (e) {
        // refused: the server looked and said no (a 4xx); anything else (down, 5xx, too many requests) is tried again
        if (e.status >= 400 && e.status < 500 && e.status !== 429) { rec.server = { ok: false, refused: true, said: e.message, t: Date.now() }; rec.told = true; break; }
        rec.server = { ok: false, said: e.message, t: Date.now() };
        if (i < 2) await sleep(i ? 4000 : 1500);
      }
    }
    rec.serverTried = true;
  }

  // the pool's signed receipt: kept only when it is about exactly this find (the commitment, this payout address,
  // our transactions, at least our share) and its signature holds; whether the key is the pool's published one is
  // kept beside it, for the page to say. Anything else is noted as a refusal of a proper receipt.
  // the pool signed the split itself (what this page sent could not be used): its transactions are counted as
  // ours only when each, read from its bytes, pays this payout address at least the share this page computed
  // (with no transaction built here, the share is the rules' on what the pool's transaction pays out: its outputs
  // plus a fee far under a bitcoin give the same whole bitcoins)
  function takePoolTxs(list) {
    if (!Array.isArray(list) || !list.length || rec.poolTxs) return;
    var spk = S.toHex(T.addressScript(rec.payout).script);
    rec.poolTxs = list.map(function (t) {
      try {
        var p = T.parse(t.hex), paid = 0, out = 0;
        p.outs.forEach(function (o) { out += o.value; if (S.toHex(o.script) === spk) paid += o.value; });
        var share = rec.tx ? rec.tx.slipstream.finder : K.finderShare(out);
        return { relay: t.relay, txid: p.txid, ok: paid >= share, paid: paid };
      } catch (e) { return { relay: t.relay, txid: t.txid, ok: false, why: e.message }; }
    });
  }
  // checked again when it was not good before (the pool's transactions may come later than the receipt)
  function takeReceipt(rc) {
    if (!rc || (rec.receipt && rec.receiptOk)) return;
    var b = rc.body || {}, ours = txids().concat((rec.poolTxs || []).filter(function (t) { return t.ok; }).map(function (t) { return t.txid; }));
    var fits = b.commitment === rec.commit && b.payout === rec.payout && b.puzzle === rec.puzzle && b.lease === rec.lease &&
      Array.isArray(b.txids) && b.txids.length && b.txids.every(function (t) { return ours.indexOf(t) >= 0; }) &&
      // the share it names: at least what our own transaction pays, or (none built here) what the pool's pays
      (rec.tx ? Number(b.finder_sats) >= rec.tx.slipstream.finder : Number(b.finder_sats) > 0 && (rec.poolTxs || []).some(function (t) { return t.ok && t.paid >= Number(b.finder_sats); }));
    rec.receipt = rc;
    rec.receiptOk = !!(fits && K.receiptVerify(rc));
    rec.receiptPublished = rc.pub === K.RECEIPT_PUB;
  }

  // ---------- spent yet? then the key can be shown ----------
  async function spentCheck() {
    var ids = txids();
    // mempool.space first: one of our transactions in a block, DEPTH blocks deep (a block can be undone by a
    // reorganisation, and with the key on screen the coins could then be taken back out of the claim)
    var tip = 0;
    try { tip = Number(await C.getJson(C.MEMPOOL + '/blocks/tip/height', null, 6000)) || 0; } catch (_) { /* the server's word below */ }
    for (var i = 0; tip && i < ids.length; i++) {
      try {
        var st = await C.getJson(C.MEMPOOL + '/tx/' + ids[i] + '/status', null, 6000);
        if (st.confirmed && st.block_height) rec.depth = Math.max(rec.depth || 0, tip - st.block_height + 1);
        if (st.confirmed && st.block_height && tip - st.block_height + 1 >= DEPTH) { rec.spent = { txid: ids[i], ours: true, t: Date.now() }; return; }
      } catch (_) { /* not known there (a private transaction until it is mined), or mempool.space is down */ }
    }
    var s = null;
    try { s = await C.postSealed('/api/pool/found/status', { lease: rec.lease }, 8000); } catch (_) { return; }
    if (!s || !s.recorded) return;
    rec.seen = { status: s.status, relays: s.relays, txids: s.txids, held: s.held, t: Date.now() };
    takePoolTxs(s.pool_txs);
    takeReceipt(s.receipt);
    // a server that restarted forgot the key, or one that saw the spend but not the key yet: the same find again
    if ((s.status === 'pending' && !s.held) || (s.status !== 'pending' && !s.published)) { rec.told = false; await tell(); }
    if (s.spend) {
      // the server says spent: believed when mempool.space (if it answers) shows no confirmed coin left there
      var left = 0;
      // (the prize's coins only: dust sent to the address later does not count)
      try { left = (await C.getJson(C.MEMPOOL + '/address/' + rec.address + '/utxo', null, 6000)).filter(function (u) { return u.status && u.status.confirmed && u.value >= K.MIN_COIN; }).length; } catch (_) { left = 0; }
      if (!left) rec.spent = { txid: s.spend.txid, ours: s.status === 'claimed', t: Date.now() };
    }
  }

  // ---------- the run: each step once, kept after each, the rest again in a minute ----------
  async function run() {
    if (busy || !rec || rec.spent) return;
    busy = true; render();
    try {
      if (!rec.payout || !rec.lease) return;
      // until the server has the find, the piece's lease is kept alive: a lease silent for 5 minutes goes back to
      // the pool, and the next searcher would find this very key in it
      if (!rec.told) C.getJson('/api/pool/ping', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lease: rec.lease, rate: 0 }) }, 8000).catch(function () { /* the next run */ });
      if (!rec.commit) { rec.salt = C.salt(); rec.commit = K.commitment(BigInt(rec.key), rec.payout, rec.salt); save(); }
      if (!rec.stamped) { await stamp(); rec.stamped = true; save(); render(); }
      if (!rec.tx && !rec.relayed) { try { await build(); rec.buildError = null; } catch (e) { rec.buildError = e.message; } save(); render(); }
      // Slipstream: once, and again on a later run while neither it nor the server has taken anything
      if (!rec.relayed || (rec.tx && !relayOk() && !serverOk())) { await relay(); if (leaving) return; save(); render(); }
      // then the server, whatever Slipstream said: without Slipstream it keeps the key and sends the claim itself
      if (rec.relayed && !rec.told && !leaving) { await tell(); save(); render(); }
      if (rec.relayed || rec.told) { await spentCheck(); save(); }
    } catch (e) {
      rec.error = e.message; save();
    } finally {
      busy = false; render();
      clearTimeout(timer);
      if (rec && !rec.spent && rec.lease && rec.payout) timer = setTimeout(run, RETRY_MS);
    }
  }

  // ---------- the view: one sentence, a bar with a cell for each step, the steps in a fold ----------
  // the card as every find draws it (findview.js)
  var V = window.BBView, step = V.step, txLink = V.txLink, o = V.o;
  function receiptGood() { return !!(rec.receipt && rec.receiptOk && rec.receiptPublished); }
  // the finder's share in satoshis: what the transaction built here pays, else what the pool's signed receipt names,
  // else what the pool's own transaction pays this payout address (null: not known here)
  function shareSats() {
    var sat = rec.tx && rec.tx.slipstream;
    if (sat) return sat.finder;
    if (receiptGood()) return Number(rec.receipt.body.finder_sats);
    var paid = (rec.poolTxs || []).filter(function (t) { return t.ok; }).map(function (t) { return t.paid; });
    return paid.length ? Math.max.apply(null, paid) : null;
  }
  function relayStep() {
    var t = rec.tx && rec.tx.slipstream, a = rec.relays && rec.relays.slipstream, name = 'MARA Slipstream', say = 'Sending through MARA Slipstream';
    if (!t) return step(rec.buildError ? 'bad' : 'wait', name, rec.buildError ? 'nothing to send from here: our server builds the claim' : 'waiting for the transaction', say);
    if (!a) return step('wait', name, 'sending ' + txLink(t.txid), say);
    return step(a.ok ? 'ok' : 'bad', name, (a.ok ? 'submitted, transaction ' : (a.said === 'cannot be reached' ? 'could not be reached' : /^no answer in/.test(a.said || '') ? 'could not be reached (' + esc(a.said) + ')' : 'refused it (' + esc(a.said) + ')') + ', transaction ') + txLink(t.txid));
  }
  function serverStep() {
    var name = 'Our server', spent = !!rec.spent;
    if (serverOk()) return step('ok', name, relayOk() ? 'verified the find and ' + (spent ? 'held the key in a secure place until the spend' : 'holds the key in a secure place') :
      'verified the find, ' + (spent ? 'held the key in a secure place and sent the claim through MARA Slipstream itself' : 'holds the key in a secure place and sends the claim through MARA Slipstream itself'));
    if (rec.server && rec.server.refused) return step('bad', name, 'said no: ' + esc(rec.server.said));
    if (rec.server) return step('warn', name, esc(rec.server.said) + ': tried again every minute', 'Our server not reached: trying every minute');
    if (!rec.relayed) return step('', name, 'told once MARA Slipstream answers');
    return step('wait', name, 'telling it', 'Telling our server');
  }
  function receiptStep() {
    var name = 'Pool receipt';
    if (rec.server && rec.server.refused) return step('bad', name, 'none: our server refused the find');
    if (!serverOk()) return step('', name, 'not yet: our server signs it when it takes the find');
    if (!rec.receipt) return step('warn', name, 'none given yet: asked again with the next check', 'Asking our server for the receipt');
    if (!rec.receiptOk) return step('bad', name, 'it does not match this find or its signature does not hold: kept as it is, as evidence');
    return step(rec.receiptPublished ? 'ok' : 'bad', name, rec.receiptPublished ? 'signed with the published key' : 'signed, but NOT with the key the pool publishes: it proves nothing');
  }
  function prizeStep() {
    var name = 'The prize', d = rec.depth || 0;
    if (rec.spent) return rec.spent.ours ? step('ok', name, 'spent by your claim') : step('bad', name, 'spent by someone else');
    if (!relayOk() && !serverOk()) return step('', name, 'not sent yet');
    return d > 0 ? step('wait', name, 'mined: ' + o(String(d)) + ' of ' + o(String(DEPTH)) + ' blocks', 'Mined: ' + d + ' of ' + DEPTH + ' blocks') :
      step('wait', name, 'waiting for a block: ' + o('0') + ' of ' + o(String(DEPTH)), 'Waiting for a MARA block');
  }
  function steps(cal, calOk) {
    var sat = rec.tx && rec.tx.slipstream;
    return [
      step(!rec.stamped ? 'wait' : calOk ? 'ok' : 'bad', 'Commitment', !rec.commit ? 'making it' : !rec.stamped ? 'on its way to the timestamp calendars' : calOk ? calOk + ' of ' + cal.length + ' calendars stamped <span class="mono" title="' + esc(rec.commit) + '">' + esc(h88(rec.commit)) + '</span>' + (calOk < cal.length ? ' (' + cal.filter(function (c) { return !c.ok; }).map(function (c) { return esc(c.url.replace('https://', '')) + ': ' + esc(c.said); }).join(', ') + ')' : '') : 'no calendar answered: the claim goes on without the timestamp', 'Timestamping your find'),
      step(rec.tx ? 'ok' : rec.buildError ? 'bad' : 'wait', 'Transaction', rec.tx ? o(K.btc(sat.finder) + ' BTC') + ' to you, ' + o(K.btc(sat.pool) + ' BTC') + ' to the pool, ' + o(K.btc(sat.fee) + ' BTC') + ' in fees' + (rec.checked === false ? ' (coins from one explorer, amounts checked against their transactions)' : '') : rec.buildError ? 'not built here: ' + esc(rec.buildError) : 'building it', 'Building your claim'),
      relayStep(), serverStep(), receiptStep(), prizeStep(),
    ];
  }
  // the words under the bar when no step is going on
  function endSay() {
    if (rec.spent) return rec.spent.ours ? 'Spent and ' + DEPTH + ' blocks deep: the key is yours to see' : 'Spent by a transaction that is not ours';
    return rec.server && rec.server.refused ? 'Our server refused your find' : 'Nothing could be sent from here';
  }
  function render() {
    if (!el || !rec) return;
    // the card is not drawn anew while the key and the receipt grow in (it would start them over): once they are
    // in, what came meanwhile is drawn
    if (animating) { later = true; return; }
    var cal = rec.cal || [], calOk = cal.filter(function (c) { return c.ok; }).length;
    var sats = shareSats(), amount = sats != null ? o(K.btc(sats) + ' BTC') : null;
    var mail = '<a href="mailto:' + SUPPORT + '?subject=' + encodeURIComponent('Puzzle #' + rec.puzzle + ' key found') + '">' + SUPPORT + '</a>';
    var proof = V.proof({ commit: rec.commit, stamped: !!(rec.stamped && calOk), receipt: receiptGood(), payout: rec.payout });
    var refused = !!(rec.server && rec.server.refused), badReceipt = !!(rec.receipt && !receiptGood());
    var lead, warn = '';
    if (rec.spent) lead = rec.spent.ours ? 'The prize is spent' + (amount ? ': ' + amount + ' went to your address' : ' and your share went to your address') + '. The key is safe to show now.' : 'The coins of the puzzle were spent by a transaction that is not ours: ' + txLink(rec.spent.txid) + '.';
    else if (relayOk()) {
      lead = (amount || 'Your share') + ' is on its way to your address.' + (refused || badReceipt ? '' : ' Nothing else for you to do.');
      if (refused) warn = V.attn('<b>Write to ' + mail + ' now.</b> Our server refused your find (' + esc(rec.server.said) + '), but your claim went out through MARA Slipstream, so your share is on its way. ' + proof);
      else if (badReceipt) warn = V.attn('<b>Write to ' + mail + ' now.</b> The receipt our server gave for your find does not hold, but your claim went out through MARA Slipstream, so your share is on its way. ' + proof);
    }
    else if (serverOk()) {
      lead = (rec.tx ? 'MARA Slipstream did not take your claim from this browser' : 'No claim could be built in this browser') + ', so the key is now kept on our server, which ' + (rec.tx ? 'sends' : 'builds and sends') + ' the claim itself.';
      // our server sends the claim on its own: a word to support only helps (an "i"), unless the receipt it gave does
      // not hold, which needs a person (a "!")
      if (badReceipt) warn = V.attn('<b>Write to ' + mail + ' now.</b> The receipt our server gave for your find does not hold. ' + proof);
      else warn = V.info('Our server needs nothing more from you. To be safe, <b>write to ' + mail + '</b>' + (receiptGood() ? ', with the receipt attached,' : '') + ' so we can see your share through. ' + proof +
        (receiptGood() ? '<div class="actions-row"><button class="btn solid" type="button" data-receipt>Save the receipt</button></div>' : ''));
    } else if (alone()) {
      lead = 'The key is kept in this browser only: neither MARA Slipstream nor our server can be reached from here.';
      warn = V.attn('<b>Write to ' + mail + ' now</b>, with the sealed find attached. Only our server can open it, so it is safe to send from any device, and it keeps your find even if this browser loses it. The page tries again every minute while it is open, and on your next visit. ' + proof +
        '<div class="actions-row"><button class="btn solid" type="button" data-sealed>Save the sealed find</button></div>');
    } else lead = 'Sending your claim. Nothing for you to do but wait a moment.';
    var list = steps(cal, calOk);
    var html = V.head(rec.puzzle, rec.t) + '<p class="found-lead">' + lead + '</p>' + warn + V.bar(list, endSay());
    // the steps: open unless this finder folded them (kept with the find)
    html += V.fold(list, rec.foldClosed);
    // under the steps, the card's tail: the note on the hidden key while the prize is not safe; then the key and its
    // WIF, then the receipt. The moment the prize turns safe while the page is open, the note fades and the tail
    // grows to the key, then on to the receipt, each fading in (grow())
    var growing = false;
    if (rec.spent && rec.spent.ours) {
      growing = shownWaiting && !animating;
      var rv = revealed(sats, cal);
      html += V.tail(growing, DEPTH, rv.key, rv.paper);
      shownWaiting = false;
    } else {
      shownWaiting = true;
      html += '<div class="found-tail">' + V.hidden(DEPTH) + '</div>';
    }

    // the confetti still flying is moved into the card drawn anew (it stops when its canvas leaves the page)
    var fw = el.querySelector('.panel-title .fw');
    el.hidden = false;
    el.innerHTML = html;
    el.querySelector('.found-fold').addEventListener('toggle', function () { var c = !this.open; if (c !== !!rec.foldClosed) { rec.foldClosed = c; save(); } });
    if (growing) grow();
    if (fw && el.querySelector('.panel-title .star')) el.querySelector('.panel-title .star').insertAdjacentElement('afterend', fw);
    // the find just made: confetti with bees from the title's star, as on /play (once, not on later visits)
    if (cheer) { cheer = false; V.cheer(el); }
    var sb = el.querySelector('[data-sealed]');
    if (sb) sb.addEventListener('click', function () { V.saveSealed('/api/pool/found', foundBody(), rec); });
    Array.prototype.forEach.call(el.querySelectorAll('[data-receipt]'), function (b) { b.addEventListener('click', saveReceipt); });
    pics.wire(el);
  }
  // the prize turned safe while the page is open: the tail grows to the key, then to the receipt (findview.js); the
  // card is not drawn anew meanwhile (render() waits)
  function grow() {
    animating = true;
    V.grow(el.querySelector('.found-tail'), function () { animating = false; if (later) { later = false; render(); } });
  }
  // the prize spent and deep: the key, as the home page's lucky key draws one, its WIF, the claim as a receipt
  function revealed(sats, cal) {
    var k = BigInt(rec.key), sat = rec.tx && rec.tx.slipstream;
    return { key: V.key(k, C.wif(k)), paper:
      V.paper({ puzzle: rec.puzzle, t: rec.t, payout: rec.payout, signed: receiptGood(), toYou: sats != null ? o(K.btc(sats) + ' BTC') : null,
        rows: (sat ? V.row('To the pool', o(K.btc(sat.pool) + ' BTC')) + V.row('Miner fee', o(K.btc(sat.fee) + ' BTC')) : '') +
          V.calsRow(cal) + V.hashRow('Commitment', rec.commit || '') + V.hashRow('Salt', rec.salt || '') + V.hashRow('Transaction', rec.spent.txid) }) +
      // /proof lists the find only when the pool took it; a receipt that does not hold is saved as the details
      '<div class="actions-row found-acts">' + (serverOk() ? '<a class="btn solid" href="/proof">Proof</a>' : '') +
      (rec.receipt ? '<button class="btn" type="button" data-receipt>' + (receiptGood() ? 'Save the receipt' : 'Save the details') + '</button>' : '') + pics.button + '</div>' + pics.panel() };
  }
  // ---------- the picture of a find whose prize is safe, to share (findview.js, as /play's) ----------
  var pics = V.pics(function () {
    return { n: rec.puzzle, secs: null, key: '0x' + BigInt(rec.key).toString(16), address: rec.address, date: V.day(rec.t),
      text: 'I found the key to Bitcoin Puzzle #' + rec.puzzle + ' with the BumbleBeam puzzle pool', url: 'https://puzzle.bumblebeam.org/proof' };
  });
  // the receipt as a file: what the card's receipt shows, and the pool's signed receipt itself (its body, signature
  // and public key, as signed: anyone can check it, on /proof or with their own code); one that does not hold is the
  // find's details, with it kept as evidence
  function receiptFile() {
    var sat = rec.tx && rec.tx.slipstream, cal = rec.cal || [], sats = shareSats();
    var f = {
      puzzle: rec.puzzle, address: rec.address, found: new Date(rec.t).toISOString(),
      to_you: sats != null ? K.btc(sats) + ' BTC' : null, payout: rec.payout,
      to_the_pool: sat ? K.btc(sat.pool) + ' BTC' : null, miner_fee: sat ? K.btc(sat.fee) + ' BTC' : null,
      timestamp: { calendars: cal.filter(function (c) { return c.ok; }).length + ' of ' + cal.length, ots: rec.ots || null },
      commitment: rec.commit || null, salt: rec.salt || null, commitment_is: 'sha256(key ‖ payout address ‖ salt)',
      transaction: rec.spent ? rec.spent.txid : sat ? sat.txid : null, spent: rec.spent ? { txid: rec.spent.txid, ours: rec.spent.ours } : null,
      signed_receipt: rec.receipt || null,
    };
    return new File([JSON.stringify(f, null, 2)], 'bumblebeam-puzzle-' + rec.puzzle + (receiptGood() ? '-receipt' : '-details') + '.json', { type: 'application/json' });
  }
  function saveReceipt() { if (rec.receipt) V.saveFile(receiptFile()); }
  // ---------- what pool.js calls ----------
  window.BBFound = {
    // the search found it: kept before anything else happens, then the run starts
    found: function (o) {
      // the same key found again (a search started again before the first find was handled): the find goes on as it is
      if (rec && rec.key === '0x' + BigInt(o.key).toString(16)) return rec;
      cheer = true; // the moment of the find: /play's confetti from the title
      rec = { v: 2, key: '0x' + BigInt(o.key).toString(16), puzzle: o.puzzle, address: o.address, payout: o.payout || '', poolPayout: o.poolPayout || null, lease: o.lease, from: o.from, to: o.to, t: Date.now() };
      save();
      run();
      return rec;
    },
    // a find kept in this browser, if there is a valid one
    // (a find spent a week ago is forgotten: its key is public on /proof)
    kept: function () {
      if (!rec) {
        var w = load();
        if (valid(w) && w.spent && Date.now() - w.spent.t > 7 * 864e5) { try { localStorage.removeItem(KEEP); } catch (_) { /* no storage */ } forgotten.forEach(function (f) { f(); }); w = null; }
        if (valid(w)) rec = w;
      }
      return rec;
    },
    // draw it into this element (the searcher's #claim panel) at once, and carry on with what is not done
    show: function (box) { if (!rec && !window.BBFound.kept()) return false; el = box; render(); run(); return true; },
    busy: function () { return busy; },
    // a find this browser has that the server has not taken yet
    pending: function () { return !!(rec && !rec.spent && !rec.told); },
    onForget: function (f) { forgotten.push(f); },
  };
})();
