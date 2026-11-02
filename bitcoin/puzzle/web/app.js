/* puzzle.bumblebeam.org: the 160 puzzles, the odds calculator and the radar, from /api (bitcoin/puzzle/api).
   English and Russian; the language comes from ?lang=, then the visitor's last choice, then the browser. */
(function () {
  'use strict';

  // ---------- language ----------
  var STR = {
    en: {
      priceTip: 'The BTC/USD price from our own node (mempool price feed)',
      navPuzzles: 'Puzzles', navOdds: 'Odds', navRadar: 'Radar', navAbout: 'About',
      title: 'The Bitcoin puzzle, live',
      lead: 'In January 2015 someone sent bitcoin to 256 addresses whose private keys are numbers in growing ranges: the key of puzzle #N lies between 2<sup>N−1</sup> and 2<sup>N</sup>−1. Whoever finds a key takes its prize. Everything below is read from our own Bitcoin node.',
      tOpen: 'Unclaimed prizes', tCount: 'Puzzles', tTarget: 'Next in line', tLast: 'Last solved',
      openSolved: function (o, s) { return o + ' open · ' + s + ' solved'; },
      exposedN: function (n) { return n + ' with a known public key'; },
      targetSub: function (b) { return b + ' BTC, brute force only'; },
      targetTitle: function (n) { return 'Puzzle #' + n + ' · next in line'; },
      targetMeta: function (n) { return 'the smallest open puzzle whose public key is hidden'; },
      address: 'Address', range: 'Key range', keys: 'Keys to check', prize: 'Prize',
      soon: 'A coordinated search is coming: every browser and GPU gets its own piece of the range, nobody checks the same keys twice, and the finder keeps <b>6 of 7.1 BTC</b>. Until then: the odds below, honestly.',
      oddsTitle: 'Odds calculator', oddsMeta: 'your hardware against the range',
      oddsHint: 'A hidden public key leaves only brute force: every key in the range is a lottery ticket. Where the public key is on the chain (#140, #145, … #160), Pollard\'s kangaroo needs about 2·√range steps instead. Speeds are estimates until our own WebGPU benchmark.',
      cPuzzle: 'Puzzle', cDevice: 'Device', cSpeed: 'Keys per second, each', cCount: 'How many', cHours: 'Hours a day', cDays: 'Days', cWatts: 'Watts, each', cKwh: 'Electricity, $ per kWh',
      devices: { browser: 'A browser tab (WebGPU), estimate', r3090: 'RTX 3090, estimate', r4090: 'RTX 4090, estimate', custom: 'My own number' },
      method: { bf: 'brute force', kg: 'kangaroo' },
      oChance: 'Chance to find it', oHalf: 'Time to a 50% chance', oEv: 'Expected win', oPower: 'Electricity',
      chanceSub: function (d, m) { return 'in ' + d + ' days, ' + m; },
      halfSub: function (s) { return 'at ' + s + ' total'; },
      evSub: function (usd) { return '≈ $' + usd + ' (chance × prize)'; },
      powerSub: function (kwh) { return kwh + ' kWh'; },
      verdictBad: function (r) { return 'The electricity costs about <b>' + r + '×</b> what this search is expected to win. As a lottery ticket: fine for the fun of it, not as an investment.'; },
      verdictOk: function (r) { return 'The expected win is about <b>' + r + '×</b> the electricity. Mind the race: whoever broadcasts a found key\'s transaction to the public mempool can be outbid by bots that read the key from it.'; },
      oneIn: function (x) { return '1 in ' + x; },
      years: function (y) { return y + ' years'; }, days: function (d) { return d + ' days'; }, hours: function (h) { return h + ' hours'; },
      radarTitle: 'Radar', radarMeta: 'every open address, every minute',
      radarHint: 'Our node watches all open puzzle addresses. A spend waiting in the mempool means someone is taking a prize right now; a confirmed one means the puzzle is solved.',
      quiet: function (t) { return 'Quiet: nothing has moved since we started watching (' + t + ').'; },
      ev: {
        solved: function (e) { return 'Puzzle #' + e.n + ' solved: ' + fmtBtc(e.amount) + ' BTC taken'; },
        claiming: function (e) { return 'Puzzle #' + e.n + ': a spend of ' + fmtBtc(e.amount) + ' BTC is in the mempool'; },
        exposed: function (e) { return 'Puzzle #' + e.n + ': its public key is now on the chain'; },
        topup: function (e) { return 'Puzzle #' + e.n + ': +' + fmtBtc(e.delta) + ' BTC'; },
        target: function (e) { return 'Next in line moves from #' + e.from + ' to #' + e.to; },
      },
      claimingNow: function (p) { return 'Puzzle #' + p.n + ' is being claimed right now: a transaction spending ' + fmtBtc(p.balance) + ' BTC waits in the mempool.'; },
      recentSolves: 'Recent solves', when: 'When', how: 'How', tx: 'Transaction',
      allTitle: 'All 160 puzzles', fAll: 'All', fOpen: 'Open', fExposed: 'Public key known', fSolved: 'Solved',
      rangeFrom: 'Range from', status: 'Status', pubkey: 'Public key', solvedOn: 'Solved',
      sOpen: 'open', sSolved: 'solved', sClaiming: 'in mempool',
      pkHidden: 'hidden', pkKnown: 'on chain', pkKnownTip: function (d) { return 'Spent from on ' + d + ': the public key is on the chain'; },
      aboutTitle: 'About',
      aboutBody: '<p>The puzzle was made in 2015 with one transaction to 256 addresses; in 2017 the creator moved out #161–#256 and raised the rest tenfold, and in 2023 tenfold again. #N now holds about N/10 BTC. In 2019 the creator also spent a little from every fifth address from #65 on, which put their public keys on the chain.</p><p>This site reads all of it from a Bitcoin node of our own, not from someone else\'s API. The open-source code is in the <a href="https://github.com/profinch/bumblebeam/tree/main/bitcoin/puzzle" target="_blank" rel="noopener">BumbleBeam repository</a>.</p><p>A word of honesty: the lower open puzzles are a race with farms of GPUs. The calculator shows what a home card can expect, electricity included. Play for the fun of it, not for the money.</p>',
      footPool: 'Mine BEAM',
      live: 'live', stale: 'stale', down: 'no data',
      updated: function (t, h) { return 'block ' + h + ' · updated ' + t; },
      ago: function (s) { return s < 90 ? s + ' s ago' : Math.round(s / 60) + ' min ago'; },
      loadErr: 'The puzzle data is not available right now. Retrying…',
    },
    ru: {
      priceTip: 'Курс BTC/USD с нашей собственной ноды (ценовой поток mempool)',
      navPuzzles: 'Пазлы', navOdds: 'Шансы', navRadar: 'Радар', navAbout: 'О пазле',
      title: 'Биткоин-пазл вживую',
      lead: 'В январе 2015 года кто-то отправил биткоины на 256 адресов, приватные ключи которых — числа из растущих диапазонов: ключ пазла #N лежит между 2<sup>N−1</sup> и 2<sup>N</sup>−1. Кто найдёт ключ, забирает приз. Всё ниже читается с нашей собственной ноды Bitcoin.',
      tOpen: 'Призы ждут', tCount: 'Пазлы', tTarget: 'Следующий', tLast: 'Последний решённый',
      openSolved: function (o, s) { return o + ' открыто · ' + s + ' решено'; },
      exposedN: function (n) { return 'у ' + n + ' известен публичный ключ'; },
      targetSub: function (b) { return b + ' BTC, только перебор'; },
      targetTitle: function (n) { return 'Пазл #' + n + ' · следующий'; },
      targetMeta: function () { return 'наименьший открытый пазл со скрытым публичным ключом'; },
      address: 'Адрес', range: 'Диапазон ключа', keys: 'Ключей перебрать', prize: 'Приз',
      soon: 'Скоро — совместный поиск: каждый браузер и видеокарта получают свой кусок диапазона, никто не проверяет одни и те же ключи дважды, а нашедший получает <b>6 из 7.1 BTC</b>. А пока — честные шансы ниже.',
      oddsTitle: 'Калькулятор шансов', oddsMeta: 'твоё железо против диапазона',
      oddsHint: 'Если публичный ключ скрыт, остаётся только перебор: каждый ключ диапазона — лотерейный билет. Если публичный ключ в блокчейне (#140, #145, … #160), кенгуру Полларда нужно лишь около 2·√диапазона шагов. Скорости — оценки, пока нет нашего бенчмарка WebGPU.',
      cPuzzle: 'Пазл', cDevice: 'Устройство', cSpeed: 'Ключей в секунду, каждое', cCount: 'Сколько штук', cHours: 'Часов в сутки', cDays: 'Дней', cWatts: 'Ватт, каждое', cKwh: 'Свет, $ за кВт·ч',
      devices: { browser: 'Вкладка браузера (WebGPU), оценка', r3090: 'RTX 3090, оценка', r4090: 'RTX 4090, оценка', custom: 'Своё число' },
      method: { bf: 'перебор', kg: 'кенгуру' },
      oChance: 'Шанс найти', oHalf: 'Время до шанса 50%', oEv: 'Ожидаемый выигрыш', oPower: 'Электричество',
      chanceSub: function (d, m) { return 'за ' + d + ' дн., ' + m; },
      halfSub: function (s) { return 'при ' + s + ' суммарно'; },
      evSub: function (usd) { return '≈ $' + usd + ' (шанс × приз)'; },
      powerSub: function (kwh) { return kwh + ' кВт·ч'; },
      verdictBad: function (r) { return 'Электричество стоит примерно в <b>' + r + '×</b> больше ожидаемого выигрыша. Как лотерейный билет — ради интереса можно, как вложение — нет.'; },
      verdictOk: function (r) { return 'Ожидаемый выигрыш примерно в <b>' + r + '×</b> больше стоимости света. Помни о гонке: транзакцию с найденным ключом, отправленную в публичный мемпул, перебивают боты, которые вычитывают из неё ключ.'; },
      oneIn: function (x) { return '1 из ' + x; },
      years: function (y) { return y + ' лет'; }, days: function (d) { return d + ' дн.'; }, hours: function (h) { return h + ' ч'; },
      radarTitle: 'Радар', radarMeta: 'каждый открытый адрес, каждую минуту',
      radarHint: 'Наша нода следит за всеми открытыми адресами пазлов. Трата в мемпуле значит, что приз забирают прямо сейчас; подтверждённая — что пазл решён.',
      quiet: function (t) { return 'Тихо: с начала наблюдения (' + t + ') ничего не двигалось.'; },
      ev: {
        solved: function (e) { return 'Пазл #' + e.n + ' решён: забрали ' + fmtBtc(e.amount) + ' BTC'; },
        claiming: function (e) { return 'Пазл #' + e.n + ': в мемпуле трата ' + fmtBtc(e.amount) + ' BTC'; },
        exposed: function (e) { return 'Пазл #' + e.n + ': его публичный ключ появился в блокчейне'; },
        topup: function (e) { return 'Пазл #' + e.n + ': +' + fmtBtc(e.delta) + ' BTC'; },
        target: function (e) { return 'Следующий меняется с #' + e.from + ' на #' + e.to; },
      },
      claimingNow: function (p) { return 'Пазл #' + p.n + ' забирают прямо сейчас: в мемпуле транзакция, которая тратит ' + fmtBtc(p.balance) + ' BTC.'; },
      recentSolves: 'Последние решения', when: 'Когда', how: 'Как', tx: 'Транзакция',
      allTitle: 'Все 160 пазлов', fAll: 'Все', fOpen: 'Открытые', fExposed: 'Ключ известен', fSolved: 'Решённые',
      rangeFrom: 'Диапазон от', status: 'Статус', pubkey: 'Публичный ключ', solvedOn: 'Решён',
      sOpen: 'открыт', sSolved: 'решён', sClaiming: 'в мемпуле',
      pkHidden: 'скрыт', pkKnown: 'в блокчейне', pkKnownTip: function (d) { return 'С адреса тратили ' + d + ': публичный ключ в блокчейне'; },
      aboutTitle: 'О пазле',
      aboutBody: '<p>Пазл создан в 2015 году одной транзакцией на 256 адресов; в 2017-м создатель забрал #161–#256 и увеличил остальные призы в десять раз, в 2023-м — ещё в десять. Сейчас на #N лежит около N/10 BTC. В 2019-м создатель потратил немного с каждого пятого адреса начиная с #65, и их публичные ключи попали в блокчейн.</p><p>Сайт берёт всё это с собственной ноды Bitcoin, а не из чужого API. Открытый код — в <a href="https://github.com/profinch/bumblebeam/tree/main/bitcoin/puzzle" target="_blank" rel="noopener">репозитории BumbleBeam</a>.</p><p>Честно: нижние открытые пазлы — гонка с фермами видеокарт. Калькулятор показывает, на что может рассчитывать домашняя карта с учётом света. Играй ради интереса, а не ради денег.</p>',
      footPool: 'Майни BEAM',
      live: 'онлайн', stale: 'устарело', down: 'нет данных',
      updated: function (t, h) { return 'блок ' + h + ' · обновлено ' + t; },
      ago: function (s) { return s < 90 ? s + ' с назад' : Math.round(s / 60) + ' мин назад'; },
      loadErr: 'Данные пазлов сейчас недоступны. Пробуем ещё…',
    },
  };

  function pickLang() {
    var q = new URLSearchParams(location.search).get('lang');
    if (q === 'en' || q === 'ru') return q;
    try { var s = localStorage.getItem('bb-lang'); if (s === 'en' || s === 'ru') return s; } catch (_) { /* no storage */ }
    return /^ru\b/i.test(navigator.language || '') ? 'ru' : 'en';
  }
  var lang = pickLang();
  function L() { return STR[lang]; }

  function applyLang() {
    document.documentElement.lang = lang;
    var s = L();
    document.querySelectorAll('[data-i18n]').forEach(function (el) { var v = s[el.getAttribute('data-i18n')]; if (typeof v === 'string') el.textContent = v; });
    document.querySelectorAll('[data-i18n-html]').forEach(function (el) { var v = s[el.getAttribute('data-i18n-html')]; if (typeof v === 'string') el.innerHTML = v; });
    document.querySelectorAll('[data-i18n-title]').forEach(function (el) { el.title = s[el.getAttribute('data-i18n-title')]; });
    document.querySelectorAll('[data-lang]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-lang') === lang); });
    fillDevices();
    if (data) render();
  }
  document.querySelectorAll('[data-lang]').forEach(function (b) {
    b.addEventListener('click', function () {
      lang = b.getAttribute('data-lang');
      try { localStorage.setItem('bb-lang', lang); } catch (_) { /* no storage */ }
      applyLang();
    });
  });

  // ---------- formatting ----------
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmtBtc(x) { return x >= 100 ? x.toFixed(0) : x >= 1 ? (Math.round(x * 100) / 100).toString() : (Math.round(x * 1e4) / 1e4).toString(); }
  function fmtInt(x) { return Math.round(x).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US'); }
  function sci(x) {
    if (!isFinite(x)) return '∞';
    if (x < 1e4) return x >= 100 ? fmtInt(x) : (Math.round(x * 100) / 100).toString();
    var e = Math.floor(Math.log10(x)), m = x / Math.pow(10, e);
    return m.toFixed(2).replace(/\.?0+$/, '') + ' × 10' + sup(e);
  }
  function sup(n) { return String(n).split('').map(function (c) { return '⁰¹²³⁴⁵⁶⁷⁸⁹'['0123456789'.indexOf(c)] || c; }).join(''); }
  function date(t) { return t ? new Date(t * 1000).toISOString().slice(0, 10) : ''; }
  function rate(x) {
    var u = ['', 'k', 'M', 'G', 'T', 'P'], i = 0;
    while (x >= 1000 && i < u.length - 1) { x /= 1000; i++; }
    return (Math.round(x * 10) / 10) + ' ' + u[i] + 'keys/s';
  }
  function dur(sec) {
    var s = L(), d = sec / 86400;
    if (d >= 365.25) { var y = d / 365.25; return s.years(y >= 1e4 ? sci(y) : fmtInt(y)); }
    if (d >= 1) return s.days(fmtInt(d));
    return s.hours(Math.max(1, Math.round(sec / 3600)));
  }
  function chance(p) {
    if (p >= 0.995) return '≈100%';
    if (p >= 1e-3) return (Math.round(p * 1000) / 10) + '%';
    if (p <= 0) return '0';
    return L().oneIn(sci(1 / p));
  }
  function hexStart(n) { return '0x' + (BigInt(1) << BigInt(n - 1)).toString(16); }
  function txLink(txid) { return '<a class="mono" href="https://mempool.space/tx/' + esc(txid) + '" target="_blank" rel="noopener">' + esc(txid.slice(0, 10)) + '…</a>'; }
  function addrLink(a) { return '<a class="mono" href="https://mempool.space/address/' + esc(a) + '" target="_blank" rel="noopener">' + esc(a) + '</a>'; }

  // ---------- odds (ported from the planning notes' prob.py) ----------
  // brute force: the key is uniform in a range of 2^(n-1) keys, so p = keys checked / range.
  // kangaroo with a known public key: expected 2.08·√range jumps; P(found by x expected runs) ≈ 1 - exp(-π/4·x²).
  var DEVICES = [
    { id: 'browser', bf: 3e7, kg: 6e7, w: 150 },
    { id: 'r3090', bf: 2.5e9, kg: 3e9, w: 350 },
    { id: 'r4090', bf: 5e9, kg: 6e9, w: 450 },
    { id: 'custom', bf: null, kg: null, w: 300 },
  ];
  function odds(n, kangaroo, keysPerSec, seconds) {
    var range = Math.pow(2, n - 1);
    if (!kangaroo) return { p: Math.min(1, keysPerSec * seconds / range), half: range * 0.5 / keysPerSec };
    var e = 2.08 * Math.sqrt(range), x = keysPerSec * seconds / e;
    return { p: 1 - Math.exp(-Math.PI / 4 * x * x), half: e * Math.sqrt(Math.log(2) * 4 / Math.PI) / keysPerSec };
  }

  function fillDevices() {
    var sel = $('c-device'), cur = sel.value || 'browser';
    sel.innerHTML = DEVICES.map(function (d) { return '<option value="' + d.id + '">' + esc(L().devices[d.id]) + '</option>'; }).join('');
    sel.value = cur;
  }
  function fillPuzzles() {
    var sel = $('c-puzzle'), cur = sel.value;
    var open = data.puzzles.filter(function (p) { return p.status === 'open'; });
    sel.innerHTML = open.map(function (p) {
      return '<option value="' + p.n + '">#' + p.n + ' · ' + fmtBtc(p.balance) + ' BTC' + (p.exposed ? ' · ' + L().method.kg : '') + '</option>';
    }).join('');
    sel.value = cur && open.some(function (p) { return String(p.n) === cur; }) ? cur : String(data.target || (open[0] && open[0].n));
  }
  function deviceSpeed(kangaroo) {
    var d = DEVICES.filter(function (x) { return x.id === $('c-device').value; })[0];
    return d && d.bf ? (kangaroo ? d.kg : d.bf) : null;
  }
  function onDevice() {
    var d = DEVICES.filter(function (x) { return x.id === $('c-device').value; })[0];
    var p = cur();
    var s = deviceSpeed(p && p.exposed);
    if (s) $('c-speed').value = s.toExponential().replace('+', '');
    $('c-watts').value = d.w;
    calc();
  }
  function cur() { return data && data.puzzles[Number($('c-puzzle').value) - 1]; }
  function num(id) { var v = Number(String($(id).value).replace(',', '.').replace(/\s/g, '')); return isFinite(v) && v >= 0 ? v : 0; }
  function calc() {
    var p = cur();
    if (!p) return;
    var s = L(), kg = !!p.exposed;
    var speed = num('c-speed') * Math.max(1, Math.floor(num('c-count')));
    var hours = Math.min(24, num('c-hours')), days = Math.max(1, num('c-days'));
    var seconds = days * hours * 3600;
    var o = odds(p.n, kg, speed, seconds);
    var btcUsd = data.btc_usd || 0;
    var evBtc = o.p * p.balance, evUsd = evBtc * btcUsd;
    var kwh = num('c-watts') * Math.max(1, Math.floor(num('c-count'))) * hours * days / 1000, cost = kwh * num('c-kwh');
    var tiles = [
      [s.oChance, chance(o.p), s.chanceSub(fmtInt(days), s.method[kg ? 'kg' : 'bf']), true],
      [s.oHalf, speed > 0 ? dur(o.half * 24 / Math.max(hours, 0.01)) : '∞', s.halfSub(rate(speed))],
      [s.oEv, evBtc >= 0.001 ? fmtBtc(evBtc) + ' BTC' : evBtc * 1e8 >= 1 ? fmtInt(evBtc * 1e8) + ' sat' : '≈ 0', s.evSub(evUsd >= 1 ? fmtInt(evUsd) : (Math.round(evUsd * 100) / 100).toString())],
      [s.oPower, '$' + fmtInt(cost), s.powerSub(fmtInt(kwh))],
    ];
    $('c-out').innerHTML = tiles.map(function (t) { return '<div class="tile"><div class="k">' + esc(t[0]) + '</div><div class="v' + (t[3] ? ' accent' : '') + '">' + esc(t[1]) + '</div><div class="s">' + esc(t[2]) + '</div></div>'; }).join('');
    var v = $('c-verdict');
    if (cost > 0 && evUsd > 0) {
      var bad = cost >= evUsd;
      var r = bad ? cost / evUsd : evUsd / cost;
      v.className = 'note ' + (bad ? 'warn' : 'ok');
      v.innerHTML = (bad ? s.verdictBad : s.verdictOk)(r >= 1e4 ? sci(r) : fmtInt(r));
      v.hidden = false;
    } else v.hidden = true;
  }
  ['c-speed', 'c-count', 'c-hours', 'c-days', 'c-watts', 'c-kwh'].forEach(function (id) { $(id).addEventListener('input', calc); });
  $('c-puzzle').addEventListener('change', onDevice);
  $('c-device').addEventListener('change', function () { if ($('c-device').value === 'custom') { calc(); $('c-speed').focus(); } else onDevice(); });

  // ---------- render ----------
  var data = null, events = [], filter = 'open';
  document.querySelectorAll('#filter button').forEach(function (b) {
    b.addEventListener('click', function () {
      filter = b.getAttribute('data-f');
      document.querySelectorAll('#filter button').forEach(function (x) { x.classList.toggle('on', x === b); });
      renderRows();
    });
  });

  function render() {
    var s = L(), d = data, ps = d.puzzles;
    var open = ps.filter(function (p) { return p.status === 'open'; });
    var solved = ps.filter(function (p) { return p.status === 'solved' && p.solved; }).sort(function (a, b) { return b.solved.time - a.solved.time; });
    if (d.btc_usd) $('btc-price-v').textContent = '$' + fmtInt(d.btc_usd);
    $('t-open').textContent = fmtBtc(d.open_btc) + ' BTC';
    $('t-open-s').textContent = d.btc_usd ? '≈ $' + sci(d.open_btc * d.btc_usd) : ' ';
    $('t-count').textContent = d.open + ' / ' + ps.length;
    $('t-count-s').textContent = s.openSolved(d.open, d.solved);
    var t = d.target && ps[d.target - 1];
    if (t) {
      $('t-target').textContent = '#' + t.n;
      $('t-target-s').textContent = s.targetSub(fmtBtc(t.balance));
      $('target-title').textContent = s.targetTitle(t.n);
      $('target-meta').textContent = s.targetMeta(t.n);
      $('target-addr').innerHTML = addrLink(t.address);
      $('target-range').textContent = hexStart(t.n) + ' … ' + '0x' + ((BigInt(1) << BigInt(t.n)) - BigInt(1)).toString(16);
      $('target-keys').textContent = '2' + sup(t.n - 1) + ' ≈ ' + sci(Math.pow(2, t.n - 1));
      $('target-prize').textContent = fmtBtc(t.balance) + ' BTC' + (d.btc_usd ? ' ≈ $' + fmtInt(t.balance * d.btc_usd) : '');
    }
    var last = solved[0];
    if (last) {
      $('t-last').textContent = '#' + last.n;
      $('t-last-s').textContent = date(last.solved.time) + ' · ' + fmtBtc(last.solved.amount) + ' BTC';
    }
    $('foot-node').textContent = d.tip ? s.updated(new Date(d.updated * 1000).toISOString().slice(11, 16) + ' UTC', d.tip) : ' ';
    renderLive();
    renderRadar(ps, solved);
    renderRows();
    fillPuzzles();
    if (!$('c-speed').value) onDevice(); else calc();
  }

  function renderLive() {
    var s = L(), el = $('live');
    if (!data) { el.className = 'pill-status off'; $('live-t').textContent = s.down; return; }
    var age = Math.max(0, Math.floor(Date.now() / 1000 - data.updated));
    el.className = 'pill-status' + (age > 300 ? ' demo' : '');
    $('live-t').textContent = (age > 300 ? s.stale : s.live) + ' · ' + s.ago(age);
  }

  function renderRadar(ps, solved) {
    var s = L(), html = '';
    ps.forEach(function (p) { if (p.claiming) html += '<div class="note bad radar-now">🚨 ' + esc(s.claimingNow(p)) + ' ' + txLink(p.claiming.txid) + '</div>'; });
    if (events.length) {
      html += '<ul class="events">' + events.slice(0, 12).map(function (e) {
        var f = s.ev[e.kind];
        return '<li><span class="dim">' + esc(new Date(e.time * 1000).toISOString().slice(0, 16).replace('T', ' ')) + '</span> ' + esc(f ? f(e) : e.kind) + (e.txid ? ' ' + txLink(e.txid) : '') + '</li>';
      }).join('') + '</ul>';
    } else if (data.updated) html += '<div class="empty">' + esc(s.quiet(date(data.updated))) + '</div>';
    $('radar-list').innerHTML = html;
    $('solves').innerHTML = solved.slice(0, 8).map(function (p) {
      return '<tr><td class="name">#' + p.n + '</td><td>' + date(p.solved.time) + '</td><td class="num">' + fmtBtc(p.solved.amount) + ' BTC</td><td>' + (p.exposed ? '<span class="badge solo">' + esc(s.method.kg) + '</span>' : '<span class="badge pending">' + esc(s.method.bf) + '</span>') + '</td><td>' + txLink(p.solved.txid) + '</td></tr>';
    }).join('');
  }

  function renderRows() {
    if (!data) return;
    var s = L();
    var rows = data.puzzles.filter(function (p) {
      return filter === 'all' || (filter === 'open' && p.status === 'open') || (filter === 'solved' && p.status === 'solved') || (filter === 'exposed' && p.exposed);
    });
    $('rows').innerHTML = rows.map(function (p) {
      var st = p.claiming ? '<span class="badge bad">' + esc(s.sClaiming) + '</span>' : p.status === 'open' ? '<span class="badge ok">' + esc(s.sOpen) + '</span>' : '<span class="badge dimmed">' + esc(s.sSolved) + '</span>';
      var pk = p.exposed ? '<span class="badge solo" title="' + esc(s.pkKnownTip(date(p.exposed.time))) + '">' + esc(s.pkKnown) + '</span>' : (p.status === 'open' ? '<span class="dim">' + esc(s.pkHidden) + '</span>' : '');
      var prize = p.status === 'open' ? fmtBtc(p.balance) : (p.solved ? '<span class="dim">' + fmtBtc(p.solved.amount) + '</span>' : '');
      return '<tr class="' + (p.status === 'open' ? 'is-open' : 'is-solved') + (p.n === data.target ? ' is-target' : '') + '"><td class="num name">' + p.n + '</td><td>' + addrLink(p.address) + '</td><td class="mono dim">' + (p.n > 1 ? hexStart(p.n) : '0x1') + '</td><td class="num">' + prize + '</td><td>' + st + '</td><td>' + pk + '</td><td class="dim">' + (p.solved ? date(p.solved.time) : '') + '</td></tr>';
    }).join('');
  }

  // ---------- data ----------
  function get(path) {
    return fetch(path, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
  }
  function load() {
    Promise.all([get('/api/puzzles'), get('/api/events').catch(function () { return { events: [] }; })]).then(function (r) {
      data = r[0]; events = r[1].events || [];
      document.body.classList.remove('loading-failed');
      render();
    }).catch(function () {
      document.body.classList.add('loading-failed');
      if (!data) { $('live').className = 'pill-status off'; $('live-t').textContent = L().loadErr; }
    });
  }

  applyLang();
  load();
  setInterval(load, 60000);
  setInterval(function () { if (data) renderLive(); }, 15000);
})();
