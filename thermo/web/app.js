'use strict';
// Thermo dashboard: /api/now every sample, charts from /api/series, tables from /api/stats.

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const RANGES = [['15м', 900], ['1ч', 3600], ['6ч', 21600], ['24ч', 86400], ['7д', 604800], ['30д', 2592000], ['1г', 31536000]];
// series hues validated for this surface (dataviz validate_palette, dark, #063355): yellow and red stay for thresholds
const PALETTE = ['#00ad95', '#5280ff', '#cc7a24', '#b061dc', '#6f9e2c', '#d9608f'];
const KINDS = [['temp', 'Температуры'], ['fan', 'Вентиляторы'], ['power', 'Мощность'], ['util', 'Загрузка'], ['io', 'Диск'], ['freq', 'Частота']];
const UNIT = { '°C': '°C', RPM: 'об/мин', W: 'Вт', 'MB/s': 'МБ/с', MHz: 'МГц', V: 'В', '%': '%', '': '' };
const LEVEL = { ok: 'норма', info: 'инфо', warn: 'внимание', crit: 'критично' };

const SMOOTH = [['сырые', 0], ['30 с', 30], ['2 мин', 120]];
let range = store.get('range', 3600);
let smooth = store.get('smooth', 30);
let hidden = new Set(store.get('hidden', []));
let now = null, stats24 = {}, statsR = {}, series = {}, evLimit = 50;
let built = '';

const fmt = (v, p = 1) => (v === null || v === undefined || Number.isNaN(v)) ? '—' : Number(v).toFixed(p);
const unit = u => UNIT[u] ?? u;
const tfmt = (ts, withDate) => new Date(ts * 1000).toLocaleString('ru-RU', withDate
  ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }
  : { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const levelOf = s => ['ok', 'warn', 'crit'][s?.st || 0];

async function api(path) {
  const r = await fetch(path, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

function visibleSensors() {
  return Object.entries(now.sensors).filter(([, s]) => !s.hidden).sort((a, b) => a[1].ord - b[1].ord);
}

// ---------------------------------------------------------------- header, alerts, tiles

function renderHead() {
  const gpu = Object.values(now.gpu || {}).map(g => g.name.replace('NVIDIA GeForce ', '')).join(', ');
  const nv = Object.values(now.nvme || {}).map(n => n.name + (n.present ? '' : ' (нет на шине)')).join(' + ');
  $('#host').textContent = now.host;
  document.title = `Thermo · ${now.host}`;
  $('#hw').innerHTML = `<b>${esc(now.board)}</b> · ${esc(now.cpu)}${gpu ? ' · ' + esc(gpu) : ''}${nv ? ' · NVMe ' + esc(nv) : ''}`;
  $('#src').textContent = `Super I/O: ${now.superio} · замер каждые ${now.interval} с · uptime ${Math.floor(now.uptime / 3600)} ч`;
}

function renderLive() {
  const el = $('#live');
  if (!now) return;
  // age by the local clock since the sample stamp last moved: the browser's and the host's clocks may differ
  const age = Math.max(0, (Date.now() - seenAt) / 1000);
  const stale = age > now.interval * 3 + 3;
  el.className = 'live ' + (stale ? 'stale' : 'ok');
  el.innerHTML = `<span class="dot ${stale ? 'off' : ''}"></span><span>${stale ? `нет данных ${Math.round(age)} с` : 'live · ' + tfmt(now.ts)}</span>`;
}

function renderAlerts() {
  const a = Object.entries(now.alerts || {}).sort((x, y) => (y[1].level === 'crit') - (x[1].level === 'crit'));
  $('#alerts').innerHTML = a.map(([k, al]) => {
    const s = now.sensors[k];
    const v = s ? `${fmt(s.v, s.prec)} ${unit(s.unit)}` : '';
    return `<div class="alert ${al.level}"><span class="badge ${al.level}">${al.level === 'crit' ? '▲' : '●'} ${LEVEL[al.level]}</span>
      <b>${esc(al.label)}</b> ${esc(v)}<span class="dim">с ${tfmt(al.since, true)}</span></div>`;
  }).join('');
}

function tileSensors() {
  return visibleSensors().filter(([, s]) => s.kind === 'temp' || s.kind === 'power' || (s.kind === 'fan' && (s.v > 0 || s.lim.some(x => x !== null))));
}

function renderTiles() {
  const el = $('#tiles');
  el.innerHTML = tileSensors().map(([k, s]) => {
    const lv = levelOf(s);
    const [, , wh, ch] = s.lim;
    const top = ch ?? wh;
    const st = stats24[k];
    let bar = '';
    if (s.kind === 'temp') {
      const scale = top ? top : 100;
      bar = `<div class="bar"><i style="width:${Math.min(100, Math.max(0, s.v / scale * 100))}%"></i>${wh && ch ? `<u style="left:${wh / ch * 100}%"></u>` : ''}</div>`;
    }
    const sub = [st ? `24ч макс ${fmt(st[2], Math.min(1, s.prec))}` : '', top ? `предел ${fmt(top, 0)}` : '', s.kind === 'fan' && s.lim[1] ? `мин ${s.lim[1]}` : '']
      .filter(Boolean).join(' · ');
    const grp = (now.groups.find(g => g[0] === s.grp) || [, s.grp])[1];
    return `<div class="tile ${lv === 'ok' ? '' : lv}" title="${esc(s.note || '')}">
      <div class="k"><span>${esc(s.label)}</span><span>${esc(grp)}</span></div>
      <div class="v">${fmt(s.v, s.kind === 'temp' ? 1 : s.prec)}<small>${unit(s.unit)}</small></div>
      <div class="s">${esc(sub) || '&nbsp;'}</div>${bar}</div>`;
  }).join('');
}

// ---------------------------------------------------------------- groups

function groupTitle(g, name) {
  if (g === 'cpu') return `${name} · ${now.cpu}`;
  if (g === 'gpu') return `${name} · ${Object.values(now.gpu || {}).map(x => x.name).join(', ')}`;
  if (g === 'board') return `${name} · ${now.board}`;
  if (g === 'storage') return `${name} · ${Object.values(now.nvme || {}).map(n => `${n.name} (${n.model})`).join(', ')}`;
  return name;
}

function groupMeta(g) {
  const S = now.sensors;
  const v = (k, p, u) => S[k] ? `<b>${fmt(S[k].v, p)}</b> ${u}` : '';
  if (g === 'cpu') return [v('cpu.pkg_w', 0, 'Вт'), v('cpu.util', 0, '%'), v('cpu.mhz_max', 0, 'МГц макс'), v('cpu.load1', 2, 'load')].filter(Boolean).join(' · ');
  if (g === 'gpu') return Object.entries(now.gpu || {}).map(([, x]) =>
    `${x.pstate || ''} <span class="badges">${(x.reason_names || []).map(r => `<span class="badge ${/thermal|slowdown|brake/i.test(r) ? 'crit' : r === 'power cap' ? 'warn' : 'info'}">${esc(r)}</span>`).join('')}</span>`).join(' ');
  if (g === 'board') return `Super I/O ${esc(now.superio)}`;
  return '';
}

function buildGroups() {
  const groups = now.groups.filter(([g]) => visibleSensors().some(([, s]) => s.grp === g));
  const sig = groups.map(([g]) => g + ':' + visibleSensors().filter(([, s]) => s.grp === g).map(([k]) => k).join(',')).join('|');
  if (sig === built) return false;
  built = sig;
  $('#groups').innerHTML = groups.map(([g, name]) => {
    const kinds = KINDS.filter(([kd]) => visibleSensors().some(([, s]) => s.grp === g && s.kind === kd));
    return `<section class="panel" id="g-${g}">
      <div class="panel-head"><h2 class="panel-title">${esc(groupTitle(g, name))}</h2><div class="panel-meta" data-meta="${g}"></div></div>
      ${g === 'gpu' ? '<div class="fanctl" data-fanctl></div>' : ''}
      <div class="charts">${kinds.map(([kd, t]) => `<div class="chart-box" data-g="${g}" data-k="${kd}">
        <h3 class="chart-title">${t}</h3><svg class="chart"></svg><div class="legend"></div></div>`).join('')}</div>
      <details class="more-table" ${store.get('open-' + g, false) ? 'open' : ''} data-g="${g}"><summary>Все датчики группы</summary>
        <div class="table-wrap"><table data-table="${g}"></table></div></details>
    </section>`;
  }).join('');
  for (const d of document.querySelectorAll('details.more-table')) d.addEventListener('toggle', () => store.set('open-' + d.dataset.g, d.open));
  fanSig = '';
  return true;
}

function renderGroupMeta() {
  for (const el of document.querySelectorAll('[data-meta]')) el.innerHTML = groupMeta(el.dataset.meta);
}

function rangeLabel() { return (RANGES.find(r => r[1] === range) || ['?'])[0]; }

function renderTables() {
  for (const t of document.querySelectorAll('[data-table]')) {
    const g = t.dataset.table;
    const rows = Object.entries(now.sensors).filter(([, s]) => s.grp === g).sort((a, b) => a[1].ord - b[1].ord);
    t.innerHTML = `<thead><tr><th>Датчик</th><th class="num">Сейчас</th><th class="num">Мин ${rangeLabel()}</th><th class="num">Средн</th>
      <th class="num">Макс</th><th class="num">Шаг</th><th>Пороги</th><th>Ключ</th><th>Заметка</th></tr></thead><tbody>${rows.map(([k, s]) => {
      const st = statsR[k] || [];
      const lv = levelOf(s);
      const [wl, cl, wh, ch] = s.lim;
      const th = [wl !== null && `↓${fmt(wl, 2)}`, cl !== null && `↓↓${fmt(cl, 2)}`, wh !== null && `↑${fmt(wh, 1)}`, ch !== null && `↑↑${fmt(ch, 1)}`].filter(Boolean).join(' ');
      return `<tr><td>${esc(s.label)}${s.hidden ? ' <span class="dim">(скрыт)</span>' : ''}</td>
        <td class="num ${lv === 'ok' ? '' : lv}">${fmt(s.v, s.prec)} ${unit(s.unit)}</td>
        <td class="num">${fmt(st[0], s.prec)}</td><td class="num">${fmt(st[1], s.prec)}</td><td class="num">${fmt(st[2], s.prec)}</td>
        <td class="num dim">${s.res ? s.res : '—'}</td><td class="dim">${th || '—'}</td><td class="dim">${esc(k)}</td><td class="dim">${esc(s.note || '')}</td></tr>`;
    }).join('')}</tbody>`;
  }
}

// ---------------------------------------------------------------- charts

function niceTicks(lo, hi, n = 4) {
  const span = hi - lo || 1;
  const raw = span / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= n + 1) || mag * 10;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

const TSTEPS = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800, 1209600, 2592000];

function chartKeys(g, kind) {
  return Object.entries(now.sensors).filter(([, s]) => s.grp === g && s.kind === kind && !s.hidden)
    .sort((a, b) => a[1].ord - b[1].ord).map(([k]) => k).slice(0, PALETTE.length);
}

// centred moving average over `w` seconds: a stepped sensor flickering between two values reads as
// the level between them; the band under the line keeps the raw min..max
function smoothed(a, step, w) {
  const h = Math.floor(w / step / 2);
  if (h < 1) return a;
  const out = new Array(a.length).fill(null);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === null) continue;
    let sum = 0, c = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(a.length - 1, i + h); j++) if (a[j] !== null) { sum += a[j]; c++; }
    out[i] = sum / c;
  }
  return out;
}

function drawChart(box) {
  const g = box.dataset.g, kind = box.dataset.k, data = series[g];
  const svg = $('svg', box), legend = $('.legend', box);
  const keys = chartKeys(g, kind);
  const color = Object.fromEntries(keys.map((k, i) => [k, PALETTE[i]]));
  const on = keys.filter(k => !hidden.has(k) && data?.s[k]);
  const W = svg.clientWidth || 600, H = svg.clientHeight || 200;
  const L = 44, R = 30, T = 10, B = 22, pw = W - L - R, ph = H - T - B;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const S = now.sensors;
  const thr = [];
  legend.innerHTML = keys.map(k => `<button type="button" data-key="${esc(k)}" class="${hidden.has(k) ? 'off' : ''}" aria-pressed="${!hidden.has(k)}">
    <i style="background:${color[k]}"></i>${esc(S[k].label)} <b>${fmt(S[k].v, S[k].prec)}</b></button>`).join('');

  if (!data || !on.length) {
    svg.innerHTML = `<text class="empty" x="${W / 2}" y="${H / 2}" text-anchor="middle">${data ? 'все серии скрыты' : 'загрузка…'}</text>`;
    return;
  }
  const t = data.t, n = t.length;
  const A = Object.fromEntries(on.map(k => [k, kind === 'temp' && smooth ? smoothed(data.s[k].a, data.step, smooth) : data.s[k].a]));
  const isSm = kind === 'temp' && smooth && Math.floor(smooth / data.step / 2) >= 1;
  let lo = Infinity, hi = -Infinity;
  for (const k of on) for (let i = 0; i < n; i++) {
    const a = data.s[k].n[i], b = data.s[k].x[i];
    if (a !== null) { lo = Math.min(lo, a); hi = Math.max(hi, b); }
  }
  if (lo === Infinity) { lo = 0; hi = 1; }
  if (['fan', 'power', 'util', 'io', 'freq'].includes(kind)) lo = Math.min(0, lo);
  if (kind === 'util') hi = Math.max(hi, 100);
  // the limits of the series closest to its own, drawn once the data comes within reach of them,
  // so a cool chart is not flattened and a chart of five sensors does not carry ten lines
  let near = null, room = Infinity;
  for (const k of on) {
    const [, , wh, ch] = S[k].lim, top = wh ?? ch;
    if (top === null) continue;
    const peak = Math.max(...data.s[k].x.filter(v => v !== null), S[k].v);
    if (top - peak < room) { room = top - peak; near = k; }
  }
  if (near) {
    const [, , wh, ch] = S[near].lim;
    for (const [v, c] of [[wh, 'warn'], [ch, 'crit']]) {
      if (v !== null && hi >= v - Math.max(8, (hi - lo) * 0.6)) thr.push({ v, c, k: near });
    }
  }
  for (const x of thr) hi = Math.max(hi, x.v);
  if (kind === 'temp' && hi - lo < 4) { const mid = (hi + lo) / 2; lo = mid - 2; hi = mid + 2; }   // one sensor step is not a cliff
  const pad = (hi - lo) * 0.06 || 1;
  if (kind === 'temp') lo = Math.floor(lo - pad);
  hi += pad;
  const ticks = niceTicks(lo, hi, ph < 170 ? 3 : 4);
  lo = Math.min(lo, ticks[0]);
  const X = i => L + (n > 1 ? i / (n - 1) : 0.5) * pw;
  const Y = v => T + ph - (v - lo) / (hi - lo) * ph;

  let h = '';
  for (const v of ticks) h += `<line class="grid" x1="${L}" x2="${L + pw}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 6}" y="${Y(v) + 3}" text-anchor="end">${v >= 10000 ? (v / 1000) + 'k' : v}</text>`;
  const span = t[n - 1] - t[0];
  const ts = TSTEPS.find(s => span / s <= Math.max(3, Math.floor(pw / 90))) || 2592000;
  const tz = new Date().getTimezoneOffset() * 60;
  for (let x = Math.ceil((t[0] - tz) / ts) * ts + tz; x <= t[n - 1]; x += ts) {
    const px = L + (x - t[0]) / span * pw;
    const d = new Date(x * 1000);
    const lab = ts >= 86400 ? d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })
      : d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    h += `<line class="grid" x1="${px}" x2="${px}" y1="${T}" y2="${T + ph}"/><text x="${px}" y="${H - 6}" text-anchor="middle">${lab}</text>`;
  }
  for (const x of thr) h += `<line class="th-${x.c}" x1="${L}" x2="${L + pw}" y1="${Y(x.v)}" y2="${Y(x.v)}"/><text x="${L + pw + 4}" y="${Y(x.v) + 3}">${fmt(x.v, 0)}</text>`;
  // min-max band under each average line, so a short spike stays visible at every zoom
  for (const k of on) {
    const s = data.s[k];
    let seg = [];
    const flush = () => {
      if (seg.length > 1) {
        const top = seg.map(i => `${X(i).toFixed(1)},${Y(s.x[i]).toFixed(1)}`), bot = seg.slice().reverse().map(i => `${X(i).toFixed(1)},${Y(s.n[i]).toFixed(1)}`);
        h += `<polygon points="${top.join(' ')} ${bot.join(' ')}" fill="${color[k]}" fill-opacity=".16"/>`;
      }
      seg = [];
    };
    for (let i = 0; i < n; i++) s.a[i] === null ? flush() : seg.push(i);
    flush();
  }
  for (const k of on) {
    const a = A[k];
    let d = '', pen = false;
    for (let i = 0; i < n; i++) {
      if (a[i] === null) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)},${Y(a[i]).toFixed(1)}`;
      pen = true;
    }
    h += `<path d="${d}" fill="none" stroke="${color[k]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  h += `<line class="cross" x1="0" x2="0" y1="${T}" y2="${T + ph}" visibility="hidden"/><g class="dots"></g>
    <rect x="${L}" y="${T}" width="${pw}" height="${ph}" fill="transparent"/>`;
  svg.innerHTML = h;
  if (thr.length) legend.insertAdjacentHTML('beforeend', thr.map(x => `<span class="th"><i class="${x.c[0]}"></i>${x.c === 'crit' ? 'предел' : 'внимание'} ${fmt(x.v, 0)}${on.length > 1 ? ' · ' + esc(S[x.k].label) : ''}</span>`).join(''));

  const cross = $('.cross', svg), dots = $('.dots', svg), tip = $('#tip');
  svg.onpointermove = e => {
    const r = svg.getBoundingClientRect();
    const x = (e.clientX - r.left) * W / r.width;
    const i = Math.max(0, Math.min(n - 1, Math.round((x - L) / pw * (n - 1))));
    cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('visibility', 'visible');
    dots.innerHTML = on.filter(k => A[k][i] !== null).map(k => `<circle cx="${X(i)}" cy="${Y(A[k][i])}" r="4" fill="${color[k]}" stroke="#042548" stroke-width="2"/>`).join('');
    const rows = on.map(k => {
      const s = data.s[k], m = S[k];
      if (A[k][i] === null) return '';
      const mm = s.n[i] !== s.x[i] ? `<span class="mm">${fmt(s.n[i], m.prec)}…${fmt(s.x[i], m.prec)}</span>` : '<span></span>';
      return `<div class="r"><i style="background:${color[k]}"></i><span>${esc(m.label)} ${mm}</span><b>${fmt(A[k][i], m.prec)} ${unit(m.unit)}</b></div>`;
    }).join('');
    const how = [data.step > now.interval && `шаг ${data.step >= 60 ? data.step / 60 + ' мин' : data.step + ' с'}`,
      isSm && `сглаж. ${smooth >= 60 ? smooth / 60 + ' мин' : smooth + ' с'}`].filter(Boolean).join(', ');
    tip.innerHTML = `<div class="t">${tfmt(t[i], span > 86400)}${how ? ` · ${how}; мелко: мин…макс` : ''}</div>${rows}`;
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = Math.min(window.innerWidth - tw - 8, e.clientX + 14) + 'px';
    tip.style.top = Math.max(8, Math.min(window.innerHeight - th - 8, e.clientY - th - 12)) + 'px';
  };
  svg.onpointerleave = () => { cross.setAttribute('visibility', 'hidden'); dots.innerHTML = ''; tip.hidden = true; };
}

function drawCharts() {
  for (const box of document.querySelectorAll('.chart-box')) drawChart(box);
}

document.addEventListener('click', e => {
  const b = e.target.closest('.legend button');
  if (!b) return;
  const k = b.dataset.key;
  hidden.has(k) ? hidden.delete(k) : hidden.add(k);
  store.set('hidden', [...hidden]);
  drawChart(b.closest('.chart-box'));
});

// ---------------------------------------------------------------- GPU fan control

// The collector applies the modes; the web only writes them (POST /api/fan, token from /etc/thermo.conf).
const FMODES = [['auto', 'Авто'], ['curve', 'Кривая'], ['manual', 'Вручную']];
let fanSig = '', fanMsg = '', fanMsgT = 0;
const fanToken = () => store.get('fan-token', '');
const fanIdx = (c, f) => f === 'all' ? c.fans.map((_, i) => i) : [+f];

function renderFanCtl() {
  const el = $('[data-fanctl]');
  if (!el) return;
  const gs = Object.entries(now.gpu || {}).filter(([, x]) => x.fan_ctl);
  const can = now.control && fanToken();
  const sig = gs.map(([p, x]) => p + x.fan_ctl.fans.length).join() + now.control + !!fanToken();
  if (sig !== fanSig) {
    fanSig = sig;
    el.innerHTML = gs.map(([p, x]) => `<div class="fc" data-gpu="${p}">
      <div class="fc-head"><h3 class="chart-title">Вентиляторы: управление</h3><span class="fc-why"></span></div>
      ${[['all', 'Оба'], ...x.fan_ctl.fans.map((_, f) => [f, `Вентилятор ${f + 1}`])].map(([f, lab]) => `<div class="fc-row" data-fan="${f}">
        <span class="fc-lab">${lab}</span><span class="fc-now"></span>
        <div class="seg" role="group" aria-label="${lab}: режим">${FMODES.map(([m, l]) => `<button type="button" data-m="${m}" ${can ? '' : 'disabled'}>${l}</button>`).join('')}</div>
        <span class="fc-man"><input type="range" min="${x.fan_ctl.min}" max="${x.fan_ctl.max}" step="5" aria-label="${lab}: обороты" ${can ? '' : 'disabled'}><output></output></span>
      </div>`).join('')}
      <div class="fc-auth">${!now.control ? '<span class="dim">Только просмотр: для управления задайте <code>control_token</code> в /etc/thermo.conf</span>'
        : fanToken() ? '<button type="button" class="btn ghost small" data-act="logout">Забыть токен</button>'
        : '<form data-act="login"><input type="password" placeholder="токен управления" autocomplete="current-password" required><button class="btn small">Войти</button></form>'}
        <span class="fc-msg"></span></div>
    </div>`).join('');
  }
  for (const [p, x] of gs) {
    const box = $(`.fc[data-gpu="${p}"]`, el), c = x.fan_ctl, S = now.sensors;
    $('.fc-why', box).innerHTML = c.hot ? `<span class="badge crit">▲ у предела: 100 %</span> <span class="dim">${esc(c.why)}</span>`
      : `<span class="dim">кривая сейчас</span> <b>${c.curve} %</b> <span class="dim">· ${esc(c.why)}</span>`;
    for (const row of box.querySelectorAll('.fc-row')) {
      const idx = fanIdx(c, row.dataset.fan);
      const modes = [...new Set(idx.map(i => c.fans[i].mode))];
      const m = modes.length > 1 ? null : modes[0];
      const kind = m === null ? null : typeof m === 'number' ? 'manual' : m;
      for (const b of row.querySelectorAll('button')) b.classList.toggle('on', b.dataset.m === kind);
      const r = $('input', row);
      if (typeof m === 'number' && document.activeElement !== r) r.value = m;
      $('.fc-man', row).hidden = kind !== 'manual';
      $('output', row).textContent = r.value + ' %';
      $('.fc-now', row).innerHTML = row.dataset.fan === 'all' ? (m === null ? '<span class="dim">разные режимы</span>' : '')
        : `<b>${fmt(S[`${p}.rpm${idx[0]}`]?.v, 0)}</b> об/мин · ${fmt(S[`${p}.fan${idx[0]}`]?.v, 0)} %`
          + (c.fans[idx[0]].set !== null ? ` <span class="dim">· задано ${c.fans[idx[0]].set} %</span>` : '');
    }
    const msg = $('.fc-msg', box);
    msg.textContent = Date.now() < fanMsgT ? fanMsg.replace(/^!/, '') : '';
    msg.className = 'fc-msg ' + (fanMsg.startsWith('!') ? 'crit' : 'dim');
  }
}

async function fanSet(gpu, fan, mode) {
  try {
    const r = await fetch('/api/fan', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Thermo-Token': fanToken() },
      body: JSON.stringify({ gpu, fan, mode }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 403) store.set('fan-token', '');
      throw new Error(j.error || r.status);
    }
    fanMsg = 'принято, применится на следующем замере';
  } catch (err) { fanMsg = '!' + err.message; }
  fanMsgT = Date.now() + 6000;
  renderFanCtl();
}

document.addEventListener('click', e => {
  const b = e.target.closest('.fc-row button');
  if (b) {
    const row = b.closest('.fc-row'), gpu = b.closest('.fc').dataset.gpu, fan = row.dataset.fan === 'all' ? 'all' : +row.dataset.fan;
    let mode = b.dataset.m;
    if (mode === 'manual') {
      const c = now.gpu[gpu].fan_ctl, cur = c.fans[fanIdx(c, row.dataset.fan)[0]];
      const r = $('input', row);
      if (typeof cur.mode !== 'number') r.value = Math.round((cur.set ?? c.curve) / 5) * 5;
      mode = +r.value;
    }
    fanSet(gpu, fan, mode);
  }
  if (e.target.closest('[data-act="logout"]')) { store.set('fan-token', ''); renderFanCtl(); }
});
document.addEventListener('input', e => {
  const r = e.target.closest('.fc-row input[type=range]');
  if (r) $('output', r.parentNode).textContent = r.value + ' %';
});
document.addEventListener('change', e => {
  const r = e.target.closest('.fc-row input[type=range]');
  if (!r) return;
  const row = r.closest('.fc-row');
  fanSet(r.closest('.fc').dataset.gpu, row.dataset.fan === 'all' ? 'all' : +row.dataset.fan, +r.value);
  r.blur();
});
document.addEventListener('submit', e => {
  const f = e.target.closest('[data-act="login"]');
  if (!f) return;
  e.preventDefault();
  store.set('fan-token', $('input', f).value.trim());
  renderFanCtl();
});

// ---------------------------------------------------------------- NVMe, events

function renderNvme() {
  const d = Object.entries(now.nvme || {}).sort((a, b) => a[1].n - b[1].n);
  if (!d.length) { $('#nvme-panel').hidden = true; return; }
  const K = x => x ? `${fmt(x - 273.15, 0)} °C` : '—';
  const rows = [
    ['Модель / прошивка', n => `${esc(n.model)} / ${esc(n.fw || '—')}`],
    ['На шине', n => n.present ? `<span class="badge ok">да · ${esc(n.ctrl)} · ${esc(n.pci)}</span>` : '<span class="badge crit">нет — пропал</span>'],
    ['PCIe линк (макс)', n => `${esc(n.link || '—')} <span class="dim">(${esc(n.link_max || '—')})</span>`],
    ['Температура SMART', n => n.smart?.temp ? `${fmt(n.smart.temp - 273.15, 0)} °C` : '—'],
    ['Пороги TMT1 / TMT2', n => `${K(n.tmt1)} / ${K(n.tmt2)}`],
    ['WCTEMP / CCTEMP', n => `${fmt(n.wctemp_c, 0)} / ${fmt(n.cctemp_c, 0)} °C`],
    ['Троттлинг TMT1: раз / сек', n => cnt(n.smart?.tmt1_n, 'warn') + ' / ' + fmt(n.smart?.tmt1_s, 0)],
    ['Троттлинг TMT2: раз / сек', n => cnt(n.smart?.tmt2_n, 'crit') + ' / ' + fmt(n.smart?.tmt2_s, 0)],
    ['Минут выше WCTEMP / CCTEMP', n => cnt(n.smart?.wctemp_min, 'warn') + ' / ' + cnt(n.smart?.cctemp_min, 'crit')],
    ['Ошибки PCIe AER: corr / nonfatal / fatal', n => [cnt(n.aer_cor, 'warn'), cnt(n.aer_nonfatal, 'crit'), cnt(n.aer_fatal, 'crit')].join(' / ')],
    ['Critical warning', n => n.smart?.cw ? `<span class="badge crit">0x${n.smart.cw.toString(16)}</span>` : (n.smart ? '<span class="badge ok">нет</span>' : '—')],
    ['Ошибки носителя', n => cnt(n.smart?.media_err, 'crit')],
    ['Износ / резерв', n => n.smart ? `${n.smart.used}% / ${n.smart.spare}%` : '—'],
    ['Записано / прочитано', n => n.smart ? `${fmt(n.smart.written_tb, 2)} / ${fmt(n.smart.read_tb, 2)} TB` : '—'],
    ['Часов / аварийных выкл.', n => n.smart ? `${n.smart.hours} / ${n.smart.unsafe}` : '—'],
  ];
  $('#nvme').innerHTML = `<thead><tr><th></th>${d.map(([s, n]) => `<th>${esc(n.name)} <span class="dim">${esc(s)}</span></th>`).join('')}</tr></thead>
    <tbody>${rows.map(([lab, f]) => `<tr><td class="dim">${lab}</td>${d.map(([, n]) => `<td>${f(n)}</td>`).join('')}</tr>`).join('')}</tbody>`;
}
const cnt = (v, lv) => v === undefined || v === null ? '—' : v > 0 ? `<span class="badge ${lv}">${v}</span>` : '0';

async function loadEvents() {
  const ev = await api(`/api/events?limit=${evLimit}`);
  $('#ev-count').textContent = `последние ${ev.length}`;
  $('#ev-more').hidden = ev.length < evLimit;
  $('#events').innerHTML = `<thead><tr><th>Время</th><th>Уровень</th><th>Событие</th><th>Ключ</th></tr></thead><tbody>${ev.map(e =>
    `<tr><td>${tfmt(e.ts, true)}</td><td><span class="badge ${e.level}">${LEVEL[e.level] || e.level}</span></td><td class="msg">${esc(e.msg)}</td><td class="dim">${esc(e.key)}</td></tr>`).join('') || '<tr><td colspan="4" class="dim">пока пусто</td></tr>'}</tbody>`;
}
$('#ev-more').onclick = () => { evLimit += 200; loadEvents(); };

// ---------------------------------------------------------------- loops

function renderRange() {
  $('#range').innerHTML = RANGES.map(([l, s]) => `<button type="button" data-r="${s}" class="${s === range ? 'on' : ''}">${l}</button>`).join('');
  $('#smooth').innerHTML = SMOOTH.map(([l, s]) => `<button type="button" data-s="${s}" class="${s === smooth ? 'on' : ''}">${l}</button>`).join('');
}
$('#smooth').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  smooth = +b.dataset.s;
  store.set('smooth', smooth);
  renderRange();
  drawCharts();
});
$('#range').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  range = +b.dataset.r;
  store.set('range', range);
  renderRange();
  series = {};
  drawCharts();
  loadSeries();
});

let firstNow = true, seenTs = 0, seenAt = Date.now();
async function loadNow() {
  try {
    now = await api('/api/now');
  } catch { renderLive(); return; }
  if (now.ts !== seenTs) { seenTs = now.ts; seenAt = Date.now(); }
  if (firstNow) { firstNow = false; renderHead(); }
  const rebuilt = buildGroups();
  renderLive(); renderAlerts(); renderTiles(); renderGroupMeta(); renderFanCtl(); renderNvme(); renderTables();
  if (rebuilt) { drawCharts(); loadSeries(); }
  else for (const box of document.querySelectorAll('.chart-box')) {   // keep legend values live between series loads
    for (const b of box.querySelectorAll('.legend button')) {
      const s = now.sensors[b.dataset.key];
      if (s) $('b', b).textContent = fmt(s.v, s.prec);
    }
  }
}

let seriesBusy = false;
async function loadSeries() {
  if (!now || seriesBusy) return;
  seriesBusy = true;
  try {
    const gs = [...new Set([...document.querySelectorAll('.chart-box')].map(b => b.dataset.g))];
    const [res, st] = await Promise.all([Promise.all(gs.map(g => api(`/api/series?group=${g}&range=${range}`))), api(`/api/stats?range=${range}`)]);
    res.forEach(r => { series[r.group] = r; });
    statsR = st.stats;
    drawCharts(); renderTables();
  } catch (e) { console.warn(e); }
  seriesBusy = false;
}

async function loadStats24() {
  try { stats24 = (await api('/api/stats?range=86400')).stats; } catch { /* next round */ }
}

function every(ms, fn) { fn(); return setInterval(fn, ms); }

renderRange();
loadStats24().then(() => {
  every(2000, loadNow);
  every(60000, loadStats24);
  every(10000, () => loadEvents().catch(() => {}));
  setInterval(() => { if (range <= 3600 || Date.now() % (range <= 86400 ? 60000 : 300000) < 10000) loadSeries(); }, 10000);
  setInterval(renderLive, 1000);
});
let rz;
window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(drawCharts, 150); });
