/* /proof: every find of the pool, from GET /api/pool/finds. A find still waiting for its prize to be spent shows
   only its commitment and the .ots file (the piece or the key would let anyone take the prize); a spent one shows
   everything, and Verify checks it again here, trusting our server for nothing:
   - the key opens the puzzle's address (BBPuzzles: the addresses are built into the page);
   - the key lies in the piece the server says it was found in;
   - sha256(key ‖ payout address ‖ salt) is the commitment (BBKit.commitment);
   - the .ots file stamps that commitment (and which calendars it waits on, or the block it is in);
   - the claim transaction has the published txid, spends the puzzle's coins with the key's signatures and pays the
     payout address the finder's share of the coins' total; the coins and the confirmation are checked with
     mempool.space when it answers.
   When the stamp was made, compared with the claim's block, is opentimestamps.org's to say: the page offers both
   files it needs (the .ots and the committed bytes, whose SHA-256 is the commitment).
   Run again on every visit (nav.js). Needs BBSecp, BBTx, BBPuzzles, BBKit, BBRender. */
(function () {
  'use strict';
  var S = window.BBSecp, T = window.BBTx, PZ = window.BBPuzzles, K = window.BBKit;
  var MEMPOOL = 'https://mempool.space/api';
  function $(id) { return document.getElementById(id); }
  if (!$('finds')) return;
  var esc = window.BB.esc; // ui/components/bb.js
  function getJson(url) {
    var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 8000);
    return fetch(url, { cache: 'no-store', signal: ctl.signal }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).finally(function () { clearTimeout(t); });
  }
  function save(name, bytes) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // a find's card: render.js's, as the server writes it into the page
  var card = window.BBRender.proofCard;

  // ---------- Verify ----------
  function line(cls, name, text) { return '<li class="' + cls + '"><b>' + esc(name) + '</b><span>' + text + '</span></li>'; }
  // the checks, named as the find's receipt names its rows (Key, Piece, Commitment, Timestamp, Pool receipt,
  // Transaction, Prize spent)
  function h88(x) { x = String(x || ''); return x.length > 20 ? x.slice(0, 8) + '…' + x.slice(-8) : x; }
  // a time in the viewer's own time (it is kept in UTC)
  function when(t) { var d = new Date(t * 1000), two = function (n) { return (n < 10 ? '0' : '') + n; }; return two(d.getDate()) + '.' + two(d.getMonth() + 1) + '.' + d.getFullYear() + ', ' + two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds()); }
  // a hash as 8…8, the whole on hover
  function hh(x) { return '<span class="mono" title="' + esc(x) + '">' + esc(h88(x)) + '</span>'; }
  async function verify(f, box) {
    var out = [], key = null;
    box.hidden = false; box.innerHTML = line('wait', 'Checking', 'in this browser…');
    try { key = BigInt(f.key); } catch (_) { key = null; }
    // 1. the key opens the puzzle's address, as the page knows it
    var addr = PZ.address(f.puzzle), got = key ? S.hash160ToAddress(S.hash160OfKey(key)) : null;
    out.push(line(got && got === addr ? 'ok' : 'bad', 'Key', got === addr ? esc(f.key) + ' opens ' + esc(addr) + ', the address of puzzle #' + esc(f.puzzle) : 'the key gives ' + esc(got || 'nothing') + ', not ' + esc(addr)));
    // 2. in its piece
    var inPiece = false;
    try { inPiece = key != null && key >= BigInt(f.piece.from) && key <= BigInt(f.piece.to); } catch (_) { /* malformed */ }
    out.push(line(inPiece ? 'ok' : 'bad', 'Piece', inPiece ? 'the key lies between ' + esc(f.piece.from) + ' and ' + esc(f.piece.to) : 'the key is not between ' + esc(f.piece && f.piece.from) + ' and ' + esc(f.piece && f.piece.to)));
    // 3. the commitment
    var c = null;
    try { c = K.commitment(key, f.payout, f.salt); } catch (e) { c = null; }
    out.push(line(c === f.commitment ? 'ok' : 'bad', 'Commitment', c === f.commitment ? 'sha256(key ‖ payout address ‖ salt) is ' + esc(h88(f.commitment)) + ', as published' : 'sha256(key ‖ payout address ‖ salt) is ' + esc(h88(c || 'not computable')) + ', not the published ' + esc(h88(f.commitment))));
    // 4. the .ots file stamps it
    if (f.ots) {
      try {
        var o = K.otsRead(K.unb64(f.ots));
        out.push(line(o.digest === f.commitment ? 'ok' : 'bad', 'Timestamp', o.digest === f.commitment ? 'the timestamp proof is for this commitment, ' + (o.bitcoin.length ? 'written to Bitcoin in block ' + o.bitcoin.join(', ') : o.pending.length + ' calendars will write it to Bitcoin (' + o.pending.map(function (u) { return '<span class="mono">' + esc(u.replace(/^https:\/\//, '')) + '</span>'; }).join(', ') + ')') + '. Its time: drop the timestamp proof and the committed data on <a href="https://opentimestamps.org" target="_blank" rel="noopener">opentimestamps.org</a>' : 'the timestamp proof is for ' + esc(h88(o.digest)) + ', not for this commitment'));
      } catch (e) { out.push(line('bad', 'Timestamp', 'the timestamp proof cannot be read: ' + esc(e.message))); }
    } else out.push(line('warn', 'Timestamp', 'no calendar stamped this find'));
    // 5. the pool receipt: its own signed word that it took this find, for this address and share
    var rc = f.receipt, b = rc && rc.body;
    if (!rc) out.push(line('warn', 'Pool receipt', 'none published for this find'));
    else {
      var fits = b.commitment === f.commitment && b.payout === f.payout && b.puzzle === f.puzzle;
      var good = fits && K.receiptVerify(rc), pubOk = rc.pub === K.RECEIPT_PUB;
      var at = ''; try { at = when(b.received); } catch (_) { at = 'an unreadable date'; }
      out.push(line(good && pubOk ? 'ok' : 'bad', 'Pool receipt', !fits ? 'it is about another find' : !good ? 'its signature does not hold' : !pubOk ? 'signed, but not with the published key of the pool' :
        'signed with the published key at ' + esc(at) + ', ' + esc(K.btc(b.finder_sats)) + ' BTC to ' + esc(f.payout) +
        (f.spend && f.spend.txid && b.txids.indexOf(f.spend.txid) < 0 ? ' (the transaction mined is a later fee bump of the same split)' : '')));
    }
    // 6. the claim transaction (and what it paid, against the receipt's promise)
    out.push(await claim(f, key, b));
    // 7. nothing of the prize left behind on the address
    out.push(await left(f));
    box.innerHTML = out.join('');
    box.dataset.result = out.every(function (l) { return !/class="bad"/.test(l); }) ? 'ok' : 'bad';
  }
  async function left(f) {
    try {
      var big = (await getJson(MEMPOOL + '/address/' + PZ.address(f.puzzle) + '/utxo')).filter(function (u) { return u.value >= K.MIN_COIN; });
      return line(big.length ? 'bad' : 'ok', 'Prize spent', big.length ? big.length + ' coins of the prize are still on the address' : 'no coin of the prize is left on the address (mempool.space)');
    } catch (e) { return line('warn', 'Prize spent', 'mempool.space did not answer'); }
  }
  async function claim(f, key, rb) {
    if (f.status === 'taken') return line('bad', 'Transaction', 'the coins were spent by ' + esc(h88(f.spend.txid)) + ', not by the claim of the pool');
    if (!f.claim_hex) return line('warn', 'Transaction', 'not published');
    try {
      var tx = T.parse(f.claim_hex);
      if (tx.txid !== f.spend.txid) throw new Error('the published transaction is ' + h88(tx.txid) + ', not ' + h88(f.spend.txid));
      T.verifySweep(tx, S.mulG(key));
      // the coins it spends, and their values: the server's list, checked with mempool.space when it answers
      var values = {}; (f.coins || []).forEach(function (u) { values[u.txid + ':' + u.vout] = u.value; });
      var note = 'the coins as our server lists them (mempool.space did not answer)';
      try {
        var m = await getJson(MEMPOOL + '/tx/' + tx.txid);
        if (!m.status || !m.status.confirmed) throw new Error('not confirmed');
        values = {}; m.vin.forEach(function (v) { values[v.txid + ':' + v.vout] = v.prevout.value; });
        note = 'in block ' + m.status.block_height + ', checked with mempool.space';
      } catch (e) { if (/confirmed/.test(e.message)) note = 'mempool.space does not show it confirmed'; }
      var total = 0;
      tx.ins.forEach(function (x) { var v = values[x.txid + ':' + x.vout]; if (v == null) throw new Error('it spends ' + h88(x.txid) + ':' + x.vout + ', not a coin of the puzzle'); total += v; });
      var spk = S.toHex(T.addressScript(f.payout).script), paid = 0;
      tx.outs.forEach(function (o) { if (S.toHex(o.script) === spk) paid += o.value; });
      var share = K.finderShare(total);
      if (paid < share) throw new Error('it pays ' + f.payout + ' ' + K.btc(paid) + ' BTC, less than the share of ' + K.btc(share) + ' BTC');
      if (rb && Number(rb.finder_sats) > paid) throw new Error('it pays ' + f.payout + ' ' + K.btc(paid) + ' BTC, less than the ' + K.btc(rb.finder_sats) + ' BTC the receipt promised');
      return line('ok', 'Transaction', 'signed with the key, spends ' + K.btc(total) + ' BTC and pays ' + K.btc(paid) + ' BTC to ' + esc(f.payout) + ' (the share is ' + K.btc(share) + ' BTC), ' + esc(note));
    } catch (e) { return line('bad', 'Transaction', esc(e.message)); }
  }

  // ---------- load ----------
  var list = [];
  function draw(finds) {
    list = finds;
    var h = window.BBRender.proof(finds).html.finds;
    if ($('finds').innerHTML === h) return;
    var first = !!$('finds').querySelector('.bb-wait');
    $('finds').innerHTML = h;
    if (first && finds.length) $('finds').classList.add('bb-fade');
  }
  $('finds').addEventListener('click', function (e) {
    if (e.target.closest('button.cp[data-copy]')) return; // ui's copy buttons (bb.js)
    var sec = e.target.closest('.proof-find'); if (!sec) return;
    var f = list.filter(function (x) { return x.commitment === sec.dataset.id; })[0]; if (!f) return;
    if (e.target.closest('[data-verify]')) verify(f, sec.querySelector('.proof-checks'));
    if (e.target.closest('[data-bytes]')) save('puzzle-find-' + f.commitment.slice(0, 12) + '.bin', K.preimage(BigInt(f.key), f.payout, f.salt));
  });
  // ---------- a receipt file, checked here ----------
  // the file the find's card saves ({ …, signed_receipt: { body, sig, pub } }), or a bare signed receipt
  async function checkReceipt(file) {
    var out = $('rc-out'), rows = [];
    out.hidden = false; out.innerHTML = line('wait', 'Checking', 'in this browser…');
    $('rc-name').textContent = file.name;
    var j = null;
    try { j = JSON.parse(await file.text()); } catch (e) { out.innerHTML = line('bad', 'File', 'not a receipt: it does not read as JSON'); return; }
    var rc = j && j.signed_receipt ? j.signed_receipt : j && j.body && j.sig ? j : null, b = rc && rc.body;
    if (!b) { out.innerHTML = line('bad', 'File', 'not a receipt: it holds no signed receipt'); return; }
    var sigOk = K.receiptVerify(rc), pubOk = rc.pub === K.RECEIPT_PUB;
    rows.push(line(sigOk ? 'ok' : 'bad', 'Signature', sigOk ? 'it holds: signed by the holder of its key, and not changed since' : 'it does not hold: changed after signing, or not signed at all'));
    rows.push(line(pubOk ? 'ok' : 'bad', 'Pool key', pubOk ? 'the published key of the pool (<a href="/rules">rules</a>)' : 'NOT the key the pool publishes: the receipt proves nothing'));
    var at = ''; try { at = when(b.received); } catch (_) { at = '?'; }
    rows.push(line('info', 'Puzzle', '#' + esc(b.puzzle) + ', signed at ' + esc(at)));
    rows.push(line('info', 'To the finder', '<span class="accent-text">' + esc(K.btc(Number(b.finder_sats))) + ' BTC</span> to ' + esc(b.payout)));
    rows.push(line('info', 'Commitment', hh(b.commitment)));
    rows.push(line('info', 'Transaction', (b.txids || []).map(hh).join(', ') || 'none'));
    // the file's own rows (what the card showed) against the signed part: only the signed part counts
    var differ = [];
    if (j.signed_receipt) {
      if (j.commitment && j.commitment !== b.commitment) differ.push('the commitment');
      if (j.payout && j.payout !== b.payout) differ.push('the payout address');
      if (j.puzzle && Number(j.puzzle) !== Number(b.puzzle)) differ.push('the puzzle');
      if (j.to_you && j.to_you !== K.btc(Number(b.finder_sats)) + ' BTC') differ.push('the share');
      rows.push(line(differ.length ? 'bad' : 'ok', 'Other rows', differ.length ? esc(differ.join(', ')) + ' in the file differ from the signed part: only the signed part counts' : 'they match the signed part'));
    }
    // the find itself, on this page
    var f = list.filter(function (x) { return x.commitment === b.commitment; })[0];
    rows.push(line(f ? 'ok' : 'warn', 'On this page', f ? 'the find of puzzle #' + esc(f.puzzle) + ', ' + esc(f.status === 'pending' ? 'waiting for the prize to be spent' : f.status === 'claimed' ? 'claimed by the pool transaction' : 'spent by a transaction not from the pool') : 'no find with this commitment here'));
    out.innerHTML = rows.join('');
    out.dataset.result = sigOk && pubOk && !differ.length ? 'ok' : 'bad';
  }
  $('rc-file').addEventListener('change', function () { if (this.files[0]) checkReceipt(this.files[0]); this.value = ''; });
  var rcBox = $('rc-box');
  rcBox.addEventListener('dragover', function (e) { e.preventDefault(); rcBox.classList.add('drop'); });
  rcBox.addEventListener('dragleave', function () { rcBox.classList.remove('drop'); });
  rcBox.addEventListener('drop', function (e) { e.preventDefault(); rcBox.classList.remove('drop'); var f = e.dataTransfer && e.dataTransfer.files[0]; if (f) checkReceipt(f); });

  getJson('/api/pool/finds').then(function (r) { draw(r.finds || []); }).catch(function () { $('finds-none').textContent = 'Our server cannot be reached right now: the finds could not be read. Try again in a minute.'; });
})();
