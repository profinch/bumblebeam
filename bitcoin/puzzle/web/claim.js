/* The network helpers a find uses (found.js, prize.js): the coins, the fee rates, the OpenTimestamps calendars,
   sending through MARA Slipstream.
   One transaction, through MARA Slipstream (POST https://slipstream.mara.com/api/transactions {tx_hex}, a normal
   miner fee): a private relay that keeps it out of the public mempool, where the public key it shows would let bots
   compute the private key and outbid it. The split and the checks are engine/claimkit.js's.

   Nothing from a server is taken on trust where money is at stake:
   - the coins come from two explorers (mempool.space, blockstream.info), never our own server; an amount not given
     alike by both is read from the transaction that made the coin (legacy signatures do not commit to input
     amounts: a lowered amount would hand the difference to the miner); only the prize's own confirmed coins are
     spent (claimkit's MIN_COIN: the dust anyone can send to the address stays where it is);
   - fee rates are capped; every output is checked (whole satoshis, above dust, adding up, the finder's share in
     full).
   Needs BBSecp, BBTx, BBKit, BBSeal. Exposes BBClaim. */
(function () {
  'use strict';
  var S = window.BBSecp, T = window.BBTx, K = window.BBKit;
  var SLIP = 'https://slipstream.mara.com', MEMPOOL = 'https://mempool.space/api', BLOCKSTREAM = 'https://blockstream.info/api';
  // the coins are read from two explorers nobody here runs: our own server is not asked during a claim (a request
  // for the puzzle's coins from the one browser that found its key would tell the server where the key is, before
  // the relays have the claim)
  var SOURCES = [['mempool.space', MEMPOOL], ['blockstream.info', BLOCKSTREAM]];

  // a JSON answer within ms (10 s), or an error with the server's own words
  function getJson(url, opts, ms) {
    var ctl = window.AbortController ? new AbortController() : null, t = ctl && setTimeout(function () { ctl.abort(); }, ms || 10000);
    return fetch(url, Object.assign({ cache: 'no-store' }, opts, ctl ? { signal: ctl.signal } : {})).then(function (r) {
      return r.text().then(function (t) {
        var j; try { j = JSON.parse(t); } catch (_) { j = { text: t }; }
        if (!r.ok) { var e = new Error(String((j && (j.error && (j.error.message || j.error)) || j.message || t || r.status)).slice(0, 200)); e.status = r.status; throw e; }
        return j;
      });
    }, function (e) { throw new Error(e && e.name === 'AbortError' ? 'no answer in ' + Math.round((ms || 10000) / 1000) + ' s' : 'cannot be reached'); })
      .finally(function () { if (t) clearTimeout(t); });
  }
  // a request that carries a key (or a claim signed with one) to our server: sealed for it alone (engine/seal.js),
  // its answer opened here; a refusal throws as getJson's do
  async function postSealed(path, obj, ms) {
    var s = await window.BBSeal.seal(path, obj);
    var r = await getJson(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(s.body) }, ms);
    return s.open(r);
  }
  function getText(url, ms) {
    var ctl = window.AbortController ? new AbortController() : null, t = ctl && setTimeout(function () { ctl.abort(); }, ms || 10000);
    return fetch(url, Object.assign({ cache: 'no-store' }, ctl ? { signal: ctl.signal } : {})).then(function (r) {
      if (!r.ok) throw new Error(url + ': ' + r.status);
      return r.text();
    }).finally(function () { if (t) clearTimeout(t); });
  }
  function wif(key) {
    var b = new Uint8Array(34); b[0] = 0x80; b.set(S.fromHex(key.toString(16).padStart(64, '0')), 1); b[33] = 1;
    var c = S.sha256(S.sha256(b)), full = new Uint8Array(38); full.set(b); full.set(c.slice(0, 4), 34);
    var A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz', n = BigInt('0x' + S.toHex(full)), s = '';
    while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
    return s;
  }

  // ---------- the network: coins, rates, sending ----------
  // The address's confirmed coins, from both explorers: every coin either one sees (one may be a block behind).
  // An amount both give alike is taken; any other (one explorer alone, the two disagree, a coin only one sees) is
  // read from the transaction that made the coin, which must hash to the coin's txid (K.outValue): no explorer
  // can make a coin look smaller than it is. o: { puzzle, address }
  async function coins(o) {
    var res = await Promise.all(SOURCES.map(function (src) {
      return getJson(src[1] + '/address/' + o.address + '/utxo', null, 8000).then(function (r) { return r.map(function (u) { return { txid: u.txid, vout: u.vout, value: u.value, confirmed: !!(u.status && u.status.confirmed) }; }); }, function (e) { return { error: e.message }; });
    }));
    var up = SOURCES.filter(function (_, i) { return !res[i].error; });
    // both down for the same reason said once: "mempool.space and blockstream.info cannot be reached"
    if (!up.length) {
      var both = SOURCES.map(function (src) { return src[0]; }).join(' and '), e0 = res[0].error;
      throw new Error(res.every(function (r) { return r.error === e0; }) ? both + (/^cannot /.test(e0) ? ' ' + e0 : ' did not answer (' + e0 + ')') :
        SOURCES.map(function (src, i) { return src[0] + ' (' + res[i].error + ')'; }).join(' and ') + ' did not answer');
    }
    var all = {}, list = [];
    res.forEach(function (r) {
      if (r.error) return;
      r.forEach(function (u) {
        if (!u.confirmed) return;
        var k = u.txid + ':' + u.vout, c = all[k];
        if (!c) { c = all[k] = { txid: u.txid, vout: u.vout, value: u.value, max: u.value, confirmed: true, seen: 0, odd: false }; list.push(c); }
        else if (c.value !== u.value) c.odd = true;
        c.max = Math.max(c.max, u.value);
        c.seen++;
      });
    });
    var check = list.filter(function (c) { return c.odd || c.seen < SOURCES.length; });
    // a few at a time, from whichever explorer answers
    for (var i = 0; i < check.length; i += 6) {
      await Promise.all(check.slice(i, i + 6).map(async function (c) {
        for (var j = 0; j < SOURCES.length; j++) {
          try { c.value = K.outOn((await getText(SOURCES[j][1] + '/tx/' + c.txid + '/hex', 8000)).trim(), c.txid, c.vout, o.address); c.proven = true; return; } catch (e) { if (/not on the puzzle/.test(e.message)) { c.drop = true; return; } /* else the other explorer */ }
        }
        // dust by every account is not spent anyway; a coin anyone gave as one of the prize's must be checked
        if (c.max < K.MIN_COIN) { c.drop = true; return; }
        throw new Error('the amount of coin ' + c.txid.slice(0, 12) + '…:' + c.vout + ' could not be checked against its transaction. Nothing was built.');
      }));
    }
    var down = SOURCES.filter(function (_, i) { return res[i].error; });
    return {
      utxos: list.filter(function (c) { return !c.drop; }).map(function (c) { return { txid: c.txid, vout: c.vout, value: c.value, confirmed: true }; }),
      note: down.length ? down.map(function (s) { return s[0]; }).join(', ') + ' could not be reached: the coins come from ' + up.map(function (s) { return s[0]; }).join(', ') + ' alone, each amount checked against the transaction that made it' : '',
      checked: !down.length,
    };
  }
  // the market's next-block rate (mempool.space, else blockstream.info) and MARA's minimum; either may be missing
  async function rates() {
    var r = await Promise.all([
      // the market's rate from both explorers, the lower of the two (one explorer alone cannot push the fee up)
      Promise.all([
        getJson(MEMPOOL + '/v1/fees/recommended', null, 5000).then(function (f) { return Number(f.fastestFee) || 0; }, function () { return 0; }),
        getJson(BLOCKSTREAM + '/fee-estimates', null, 5000).then(function (f) { return Math.ceil(Number(f['1'] || f['2']) || 0); }, function () { return 0; }),
      ]).then(function (r) { var got = r.filter(Boolean); return got.length ? Math.min.apply(null, got) : 0; }),
      getJson(SLIP + '/api/rates', null, 5000).then(function (s) { return Number(s.submit_fee_rate) || 0; }, function () { return 0; }),
    ]);
    return { market: r[0], slipMin: r[1] };
  }
  // the transaction through MARA Slipstream, the one private relay used (Rebar Shield's was off for months and is
  // not used any more): { ok, said, t }
  function sendTx(hex) {
    var p = getJson(SLIP + '/api/transactions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tx_hex: hex }) }, 15000)
      .then(function (r) { return String(r.message || r.txid || JSON.stringify(r)); });
    return p.then(function (s) { return { ok: true, said: s.slice(0, 200), t: Date.now() }; }, function (e) { return { ok: false, said: e.message, t: Date.now() }; });
  }
  // everything needed to build, read at once: the coins and the rates. Returns { utxos, rate, notes, checked }
  async function prepare(o, rate) {
    var r = await Promise.all([coins(o), rates()]);
    var c = r[0], fr = r[1], notes = [];
    if (c.note) notes.push(c.note);
    // a rate typed by hand is raised to MARA's minimum, up to three times itself; no rate: chosen here
    var chosen = rate ? Math.max(rate, Math.ceil(fr.slipMin)) : K.chooseRate(fr.market, fr.slipMin);
    if (rate && chosen > Math.max(3 * rate, rate + 50)) throw new Error('MARA asks for at least ' + chosen + ' sat/vB, more than three times your rate: raise your rate if you mean it');
    if (rate && chosen > rate) notes.push('MARA asks for at least ' + chosen + ' sat/vB: that rate is used');
    var u = K.spendable(c.utxos);
    if (!u.length) throw new Error('no confirmed coins worth spending on the address: the prize may be taken already');
    if (c.utxos.length > u.length) notes.push(coinsSaid(c.utxos.length - u.length).replace(/^(\d+) /, '$1 small ') + ' on the address left as they are (only the coins of the prize are spent)');
    return { utxos: u, rate: chosen, notes: notes, checked: c.checked };
  }

  function coinsSaid(n) { return n + ' coin' + (n === 1 ? '' : 's'); }

  // ---------- the commitment's timestamp: the public OpenTimestamps calendars ----------
  // calendars that let a page read their answer (CORS: Access-Control-Allow-Origin *, checked 2026-11-19;
  // catallaxy's sends none, so a page cannot use it); one that fails does not stop the rest. Only the commitment's
  // hash goes out, which gives the key away to nobody. Returns { cal: [{ url, ok, said|stamp }], ots: base64 | null }
  var CALENDARS = ['https://a.pool.opentimestamps.org', 'https://b.pool.opentimestamps.org', 'https://a.pool.eternitywall.com', 'https://finney.calendar.eternitywall.com'];
  async function stamp(commit) {
    var d = S.fromHex(commit);
    // the body is the 32 raw bytes and no headers: a simple request, as the calendars answer no preflight
    var cal = await Promise.all(CALENDARS.map(function (url) {
      var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 6000);
      return fetch(url + '/digest', { method: 'POST', body: d, signal: ctl.signal, cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('answered ' + r.status); return r.arrayBuffer(); })
        // an answer is kept only if a .ots made of it reads back to this commitment, and it is small (the server
        // takes files up to 16 KB): one calendar's odd answer is left out, never the find's other stamps
        .then(function (b) { var s = new Uint8Array(b); if (s.length > 4096) throw new Error('an answer of ' + s.length + ' bytes'); if (K.otsRead(K.otsFile(commit, [s])).digest !== commit) throw new Error('an answer that does not stamp the commitment'); return { url: url, ok: true, stamp: K.b64(s) }; })
        .catch(function (e) { return { url: url, ok: false, said: e.name === 'AbortError' ? 'no answer in 6 s' : e.message === 'Failed to fetch' ? 'cannot be reached' : e.message }; })
        .finally(function () { clearTimeout(t); });
    }));
    var got = cal.filter(function (c) { return c.ok; });
    return { cal: cal, ots: got.length ? K.b64(K.otsFile(commit, got.map(function (c) { return K.unb64(c.stamp); }))) : null };
  }
  function salt() { var b = new Uint8Array(32); crypto.getRandomValues(b); return S.toHex(b); }

  window.BBClaim = { coins: coins, rates: rates, sendTx: sendTx, prepare: prepare, getJson: getJson, getText: getText, postSealed: postSealed, wif: wif, stamp: stamp, salt: salt, MEMPOOL: MEMPOOL, SLIP: SLIP };
})();
