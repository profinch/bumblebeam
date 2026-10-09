// BumbleBeam pool web UI: views. No framework, no build step.
//
// Rule for every view: data from BB is typed (numbers or null, capped strings) and every string
// still goes through esc() before it is put into HTML. Numbers go through a formatter.
'use strict';

(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const view = $('#view');

  // ---------- formatting ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const int = (n) => (n == null || !isFinite(n) ? '—' : Math.round(n).toLocaleString('en-US'));
  const fix = (n, d = 1) => (n == null || !isFinite(n) ? '—' : Number(n).toFixed(d));
  function hr(v) {
    if (v == null || !isFinite(v)) return '—';
    if (v >= 1e6) return `${(v / 1e6).toFixed(2)} MSol/s`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(2)} kSol/s`;
    return `${v.toFixed(v < 10 ? 2 : 1)} Sol/s`;
  }
  const beam = (groth, d = 4) => (groth == null || !isFinite(groth) ? '—'
    : `${(groth / BB.GROTH).toLocaleString('en-US', { minimumFractionDigits: Math.min(2, d), maximumFractionDigits: d })} BEAM`);
  const pctFee = (x) => (x == null || !isFinite(x) ? '—' : `${Number(x)}%`);
  function ago(ts) {
    if (!ts) return '—';
    const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }
  function dur(sec) {
    if (sec == null || !isFinite(sec)) return '—';
    if (sec < 3600) return `${Math.round(sec / 60)} min`;
    if (sec % 3600 === 0) return `${sec / 3600} h`;
    return `${(sec / 3600).toFixed(1)} h`;
  }
  // every hash, key and ID is shortened the same way, on both sites: first 8 … last 8
  const short = (s) => (s && s.length > 17 ? `${s.slice(0, 8)}…${s.slice(-8)}` : s || '—');
  const pct = (x, d = 1) => (x == null || !isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`);
  const effortColor = (e) => (e == null ? 'inherit' : e > 1.5 ? 'var(--color-red)' : e < 0.7 ? 'var(--accent)' : 'inherit');
  const explorerBlock = (h) => `https://explorer.bumblebeam.org/block/${Math.round(Number(h) || 0)}`;
  const explorerKernel = (k) => `https://explorer.bumblebeam.org/kernel/${encodeURIComponent(k)}`;
  const cleanAddress = (a) => String(a ?? '').replace(/\s+/g, '');
  const minerHref = (a) => `/miners/${encodeURIComponent(cleanAddress(a))}`;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const RANGES = { '24h': { label: '24h', text: 'last 24 hours' }, '7d': { label: '7d', text: 'last 7 days' }, '30d': { label: '30d', text: 'last 30 days' } };

  // ---------- charts ----------
  function sparkline(series, color = '#f25f5b') {
    if (!series || series.length < 2) return '';
    const vs = series.map((p) => p[1]);
    const min = Math.min(...vs), max = Math.max(...vs), span = max - min || 1;
    const pts = vs.map((v, i) => `${((i / (vs.length - 1)) * 90).toFixed(1)},${(20 - ((v - min) / span) * 18).toFixed(1)}`).join(' ');
    return `<svg class="spark" viewBox="0 0 90 22" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.2" vector-effect="non-scaling-stroke"/></svg>`;
  }

  const NARROW = window.matchMedia('(max-width: 700px)');
  const axis = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(v >= 1e4 ? 1 : 2)}k` : v.toFixed(v < 10 ? 1 : 0));
  // Explorer-style area chart: axis on the right, grid in both directions, the current value marked
  // by a dotted guide and a pill on the axis. `label` formats axis values and the pill; `peak`
  // also marks the highest point of the period.
  // `peakAt`: the range's true peak, [ts, value] of one-minute samples. The week's and the month's
  // points are hourly averages that flatten a short peak, so it goes into the line at its moment.
  function areaChart(series, { color = '#00f6d2', label = axis, title = 'Hashrate', range = '24h', peak = false, peakAt = null } = {}) {
    const span = RANGES[range] || RANGES['24h'];
    if (peak && peakAt && series && series.length >= 2 && peakAt[1] > Math.max(...series.map((p) => p[1]))) {
      // inside the line: a peak in the last, still open interval sits just before its point, which
      // stays the current value
      const t0 = series[0][0], t1 = series[series.length - 1][0];
      const at = Math.min(Math.max(peakAt[0], t0 + 1), t1 - 1);
      series = [...series.filter((p) => p[0] !== at), [at, peakAt[1]]].sort((a, b) => a[0] - b[0]);
    }
    if (!series || series.length < 2) return '<div class="empty">No data yet</div>';
    if (!series.some((p) => p[1] > 0)) return `<div class="empty">No hashrate in the ${span.text}</div>`;
    // phones get a narrower canvas, so the labels are not scaled down to nothing
    // the right margin holds the axis, the current value's pill and, right of it, the peak
    const last = series[series.length - 1][1], pillText = label(last), pw = pillText.length * 7.2 + 12;
    const top = Math.max(...series.map((p) => p[1])), pText = `max ${top >= 1e3 ? label(top) : top.toFixed(1)}`, ptw = pText.length * 5.7;
    const narrow = NARROW.matches, W = narrow ? 380 : 1000, H = narrow ? 210 : 260, L = narrow ? 8 : 14, T = 16, B = 30;
    // the current value's pill gets a fixed slot (as wide as "1.23k"), the peak label starts after it
    const slot = Math.max(pw, 5 * 7.2 + 12);
    const R = Math.max(narrow ? 84 : 96, peak ? Math.ceil(4 + slot + 8 + ptw + 4) : 0);
    const yTicks = narrow ? 4 : 5, xTicks = narrow ? (range === '7d' ? 2 : 3) : 6;
    const t0 = series[0][0], t1 = series[series.length - 1][0];
    const max = Math.max(...series.map((p) => p[1])) * 1.12 || 1;
    const x = (t) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R);
    const y = (v) => T + (1 - v / max) * (H - T - B);
    const line = series.map((p) => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' L');
    let grid = '';
    for (let i = 1; i <= yTicks; i++) {
      const v = (max / yTicks) * i, yy = y(v).toFixed(1);
      grid += `<line class="grid" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/><text x="${W - R + 10}" y="${+yy + 4}">${label(v)}</text>`;
    }
    for (let i = 0; i <= xTicks; i++) {
      const t = t0 + ((t1 - t0) / xTicks) * i, xx = x(t).toFixed(1);
      const d = new Date(t * 1000);
      if (i > 0 && i < xTicks) grid += `<line class="grid" x1="${xx}" x2="${xx}" y1="${T}" y2="${H - B}"/>`;
      const when = range === '24h' ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
        : `${MONTHS[d.getMonth()]} ${d.getDate()}${range === '7d' ? ` ${String(d.getHours()).padStart(2, '0')}:00` : ''}`;
      grid += `<text x="${xx}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === xTicks ? 'end' : 'middle'}">${when}</text>`;
    }
    const ly = Math.max(T + 9, Math.min(H - B - 9, y(last)));
    const id = `g${Math.random().toString(36).slice(2, 8)}`;
    // the peak: the same guide as the current value, its value in plain text a fixed distance
    // right of the current value's pill slot, so it does not move with the current value
    let peakMark = '';
    if (peak) {
      const py = y(top), ty = Math.max(T + 9, Math.min(H - B - 9, py));
      // the guide runs on to the text, under the current value's pill (drawn after it)
      peakMark = `<line class="now" x1="${L}" x2="${(W - R + 4 + slot + 5).toFixed(1)}" y1="${py.toFixed(1)}" y2="${py.toFixed(1)}" vector-effect="non-scaling-stroke"/>
      <text class="peak-text" x="${(W - R + 4 + slot + 8).toFixed(1)}" y="${ty.toFixed(1)}" dominant-baseline="central">${esc(pText)}</text>`;
    }
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}, ${span.text}: now ${esc(pillText)}">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity="0.55"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
      ${grid}
      <line class="grid" x1="${W - R}" x2="${W - R}" y1="${T}" y2="${H - B}"/>
      <path d="M${line} L${x(t1).toFixed(1)},${y(0)} L${x(t0).toFixed(1)},${y(0)} Z" fill="url(#${id})"/>
      <path d="M${line}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
      <line class="now" x1="${L}" x2="${W - R}" y1="${y(last).toFixed(1)}" y2="${y(last).toFixed(1)}" vector-effect="non-scaling-stroke"/>
      ${peakMark}
      <rect x="${W - R + 4}" y="${(ly - 9).toFixed(1)}" width="${pw.toFixed(0)}" height="18" rx="3" fill="${color}"/>
      <text class="pill-text" x="${W - R + 4 + pw / 2}" y="${(ly + 4).toFixed(1)}" text-anchor="middle">${esc(pillText)}</text>
    </svg>`;
  }

  // Blocks per pool over 24 h, as the explorer's mining donut.
  const PALETTE = ['#00f6d2', '#24c1ff', '#ffbd2e', '#ff51ff', '#a4e000', '#d885ff', '#ff7a21'];
  // Pools that found blocks in 24 h, most first, each with its colour: the donut's legend, and the
  // recent-blocks table for our own rows, use the same mapping.
  // BumbleBeam keeps one colour whatever its rank; the other pools share the rest of the palette.
  const OUR_COLOUR = '#a4e000';
  const isOurs = (name) => /^bumblebeam\b/i.test(String(name || ''));
  function poolColours(net) {
    if (!net || !net.ok || !Array.isArray(net.pools)) return [];
    // the others: no yellow (next to our yellow-green it is hard to tell apart), and pink and
    // purple kept apart by orange, so neighbours in the legend always differ
    const others = ['#00f6d2', '#24c1ff', '#ff51ff', '#ff7a21', '#d885ff'];
    let k = 0;
    return net.pools.filter((p) => p.blocks24h).sort((a, b) => b.blocks24h - a.blocks24h)
      .map((p) => ({ name: p.name, n: p.blocks24h, color: isOurs(p.name) ? OUR_COLOUR : others[k++ % others.length] }));
  }
  function blocksDonut(net) {
    if (!net || !net.ok || !net.blocks24h) return '';
    const rows = poolColours(net);
    const sum = rows.reduce((s, p) => s + p.n, 0);
    if (net.blocks24h > sum) rows.push({ name: 'Unknown', n: net.blocks24h - sum, color: 'rgba(255,255,255,0.35)' });
    const total = rows.reduce((s, r) => s + r.n, 0) || 1;
    const r = 70, c = 2 * Math.PI * r;
    let off = 0, arcs = '';
    for (const row of rows) {
      const len = (row.n / total) * c;
      // a 2-unit gap between segments; a sliver shorter than the gap would give a negative dash,
      // which browsers ignore and draw as a full ring, so it gets a thin visible mark instead
      const dash = Math.max(len - 2, 1);
      arcs += `<circle cx="90" cy="90" r="${r}" fill="none" stroke="${row.color}" stroke-width="20" stroke-dasharray="${dash.toFixed(2)} ${(c - dash).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 90 90)"/>`;
      off += len;
    }
    return `<div class="donut-wrap">
      <svg class="donut" viewBox="0 0 180 180" role="img" aria-label="Blocks in the last 24 hours by pool">${arcs}
        <text class="total" x="90" y="90" text-anchor="middle">${int(total)}</text><text class="sub" x="90" y="108" text-anchor="middle">past 24h</text></svg>
      <div class="legend-rows">${rows.map((row) => `<div class="legend-row"><i style="background:${row.color}"></i><b>${esc(row.name)}</b><span class="n">${int(row.n)}</span><span class="p">${pct(row.n / total, 1)}</span></div>`).join('')}</div>
    </div>`;
  }

  // Intervals between the network's blocks over the past hour, coloured against the 60 s target.
  function blockTimes(blocks) {
    const bs = blocks.filter((b) => b.ts).sort((a, b) => a.ts - b.ts);
    const now = Date.now() / 1000, gaps = [];
    for (let i = 1; i < bs.length; i++) if (bs[i].ts > now - 3600) gaps.push(bs[i].ts - bs[i - 1].ts);
    if (gaps.length < 3) return '';
    const avg = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const W = 1000, H = 104, B = 0, max = Math.max(120, ...gaps) * 1.05;
    const bw = (W - 20) / gaps.length, ty = ((1 - 60 / max) * (H - B)).toFixed(1);
    const bars = gaps.map((g, i) => {
      const h = Math.max(2, (g / max) * (H - B)), col = g <= 60 ? '#00f6d2' : g <= 90 ? '#f4ce4a' : '#f25f5b';
      return `<rect x="${(10 + i * bw + 1).toFixed(1)}" y="${(H - B - h).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${col}" fill-opacity="0.75"/>`;
    }).join('');
    const key = [['#00f6d2', '≤ 60s'], ['#f4ce4a', '60–90s'], ['#f25f5b', '> 90s']]
      .map(([c, t]) => `<span><i style="background:${c}"></i>${t}</span>`).join('') + '<span><i class="line"></i>60s target</span>';
    return `<div class="bars-head"><span>Block times (past hour)</span><span class="bars-key">${key}</span><span>avg ${fix(avg, 1)}s</span></div>
      <svg class="bars" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Seconds between blocks over the past hour">${bars}
        <line class="target" x1="10" x2="${W - 10}" y1="${ty}" y2="${ty}" vector-effect="non-scaling-stroke"/></svg>
      <div class="bars-foot"><span>1h ago</span><span>now</span></div>`;
  }

  // ---------- shared pieces ----------
  // tile(): callers pass already formatted and escaped strings.
  const tile = (k, v, s = '', cls = '') => `<div class="tile"><div class="k">${k}</div><div class="v ${cls}">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
  const statusBadge = (b, maturity) => b.status === 'confirmed' ? '<span class="badge ok">confirmed</span>'
    : b.status === 'orphaned' ? '<span class="badge bad">orphaned</span>'
    : `<span class="badge pending">${int(Math.min(b.confirmations, maturity))}/${int(maturity)}</span>`;
  const modeBadge = (m) => (m === 'solo' ? '<span class="badge solo">solo</span>' : '<span class="badge ok">pplns</span>');

  // `rewardLast`: Reward right before Status (a miner's own blocks), not after Mode
  function blocksRows(blocks, maturity, rewardLast = false) {
    return blocks.map((b) => {
      const reward = `<td class="num">${beam(b.reward + b.fees, 3)}</td>`;
      return `<tr>
        <td><a href="${explorerBlock(b.height)}" target="_blank" rel="noopener">${int(b.height)}</a></td>
        <td class="dim">${ago(b.ts)}</td><td>${modeBadge(b.mode)}</td>${rewardLast ? '' : reward}
        <td class="num" style="color:${effortColor(b.effort)}">${pct(b.effort, 0)}</td>
        <td class="dim">${esc(b.finder || '—')}</td>${rewardLast ? reward : ''}<td class="num">${statusBadge(b, maturity)}</td></tr>`;
    }).join('');
  }
  function blocksTable(blocks, maturity, more = '') {
    if (!blocks.length) return '<div class="empty">No blocks found yet</div>';
    return `<div class="table-wrap"><table class="blocks-table"><colgroup><col class="w-h"><col class="w-t"><col class="w-m"><col class="w-r"><col class="w-e"><col><col class="w-s"></colgroup>
      <thead><tr><th>Height</th><th>Found</th><th>Mode</th><th class="num">Reward</th><th class="num">Effort</th><th>Finder</th><th class="num">Status</th></tr></thead>
      <tbody id="blocks-body">${blocksRows(blocks, maturity)}</tbody></table></div>${more}`;
  }

  function netMeta(net, extra = '') {
    if (!net || !net.ok) return '<span class="err">network data unavailable</span>';
    return `<span>Network: <b>${hr(net.hashrate)}</b></span><span>Block: <b>${int(net.height)}</b></span>
      <span>Diff: <b>${net.difficulty ? fix(net.difficulty / 1e6, 2) + 'M' : '—'}</b></span>
      <span>Avg block: <b>${net.avgBlock ? fix(net.avgBlock, 1) + 's' : '—'}</b></span>${extra}`;
  }

  function setBanner() { $('#demo-banner').hidden = BB.mode !== 'demo'; }
  async function setFooter() {
    const el = $('#foot-status'), txt = $('#foot-status-text');
    if (!el) return;
    let net = null;
    try { net = await BB.network(); } catch (e) { net = null; }
    // pages that never ask the pool (API docs, not found) learn whether it is up here
    if (!BB.mode) await BB.pool('stats').catch(() => null);
    const live = BB.mode === 'live';
    el.className = `pill-status ${live ? '' : BB.mode === 'demo' ? 'demo' : 'off'}`;
    txt.textContent = `${live ? 'pool live' : BB.mode === 'demo' ? 'demo' : 'offline'}${net && net.ok && net.height ? ` · ${int(net.height)}` : ''}`;
  }

  function poolsTable(stats, net, { meta = true } = {}) {
    if (!net || !net.ok) return '<section class="panel"><div class="empty err">Network data unavailable</div></section>';
    // other sites list BumbleBeam too (from /api/miningboard): ours come from the pool itself,
    // PPLNS and solo as two pools, the way 2Miners shows its solo side
    const rows = net.pools.filter((p) => p.id !== 'bumblebeam' && p.name !== 'BumbleBeam').map((p) => ({ ...p, ours: false }));
    if (stats.modes) {
      const own = (m, name, scheme, fee) => ({ id: `bumblebeam-${m}`, name, scheme, fee, hashrate: stats.modes[m].hashrate, miners: stats.modes[m].miners,
        workers: stats.modes[m].workers, blocks24h: stats.modes[m].blocks24h, lastTs: stats.modes[m].lastBlockFound, series: stats.modes[m].series, ours: true });
      rows.push(own('pplns', 'BumbleBeam', stats.scheme, stats.fee), own('solo', 'BumbleBeam (Solo)', 'SOLO', stats.soloFee));
    } else {
      rows.push({ id: 'bumblebeam', name: 'BumbleBeam', scheme: stats.scheme, fee: stats.fee, hashrate: stats.hashrate, miners: stats.minersTotal,
        workers: stats.workersTotal, blocks24h: stats.blocks24h, lastTs: stats.lastBlockFound, series: stats.chart.filter((_, i) => i % 6 === 0), ours: true });
    }
    rows.sort((a, b) => b.hashrate - a.hashrate);
    const total = net.hashrate || rows.reduce((s, r) => s + r.hashrate, 0);
    const head = meta ? netMeta(net, `<span>Blocks 24h: <b>${int(net.blocks24h)}</b></span>`) : `<span>${rows.length} pools · network blocks 24h: <b>${int(net.blocks24h)}</b></span>`;
    return `<section class="panel" id="pools">
      <div class="panel-head"><h2 class="panel-title">Beam mining pools</h2><div class="panel-meta">${head}</div></div>
      <div class="table-wrap"><table><thead><tr><th>#</th><th>Pool</th><th>Hashrate</th><th class="num">Share</th><th class="num">Miners</th><th class="num">Workers</th><th class="num">Blocks 24h</th><th class="num"><span class="tipped" title="When each pool found its latest block, as the pool itself records it: for BumbleBeam, the moment the block went out to the network. It can read up to a minute later than Age in Recent network blocks, which is the block's timestamp on the chain.">Last found</span></th><th></th></tr></thead><tbody>
      ${rows.map((p, i) => `<tr class="${p.ours ? 'ours' : ''}">
        <td class="dim">${i + 1}</td>
        <td><span class="name">${esc(p.name)}</span><span class="sub">${p.fee != null ? pctFee(p.fee) : ''} ${esc(p.scheme)}${p.ours && BB.mode === 'demo' ? ' · demo' : ''}</span></td>
        <td><div class="hashcell"><span>${hr(p.hashrate)}</span>${sparkline(p.series, p.ours ? '#00f6d2' : '#f25f5b')}</div>
            <div class="bar ${p.ours ? 'accent' : ''}"><i style="width:${Math.min(100, (p.hashrate / total) * 100).toFixed(1)}%"></i></div></td>
        <td class="num">${pct(p.hashrate / total, 1)}</td>
        <td class="num">${int(p.miners)}</td><td class="num">${int(p.workers)}</td><td class="num">${int(p.blocks24h)}</td>
        <td class="num dim">${ago(p.lastTs)}</td><td><span class="dot ${p.hashrate ? '' : 'off'}"></span></td></tr>`).join('')}
      </tbody></table></div></section>`;
  }

  // ---------- viewer settings ----------
  // Kept in cookies on this site for a year (chart range and mode, filters, your address, the
  // start page form). Settings from older versions are moved over from localStorage once.
  const prefs = {
    get(k) {
      const m = document.cookie.match(new RegExp(`(?:^|; )${k.replace(/\./g, '\\.')}=([^;]*)`));
      if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return ''; } }
      try {
        const v = localStorage.getItem(k);
        if (v != null) { prefs.set(k, v); localStorage.removeItem(k); return v; }
      } catch (e) { /* storage may be blocked */ }
      return '';
    },
    set(k, v) {
      document.cookie = `${k}=${encodeURIComponent(v)}; path=/; max-age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
    },
    del(k) {
      document.cookie = `${k}=; path=/; max-age=0; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
      try { localStorage.removeItem(k); } catch (e) { /* storage may be blocked */ }
    },
  };

  // ---------- chart range (24h / 7d / 30d) and pool mode (PPLNS / Solo) ----------
  const RANGE_KEY = 'bb.chartRange';
  function chartRange() {
    const r = prefs.get(RANGE_KEY);
    return RANGES[r] ? r : '24h';
  }
  const MODES = { pplns: 'Pool', solo: 'Solo' };
  const MODE_KEY = 'bb.chartMode';
  const chartMode = () => (prefs.get(MODE_KEY) === 'solo' ? 'solo' : 'pplns');
  const modeSwitch = (cur, attr = 'data-chart-mode', label = 'Chart mode', modes = MODES) => `<div class="seg range" role="group" aria-label="${label}">${Object.keys(modes).map((k) =>
    `<button type="button" ${attr}="${k}" class="${k === cur ? 'on' : ''}" aria-pressed="${k === cur}">${modes[k]}</button>`).join('')}</div>`;
  const rangeSwitch = (cur) => `<div class="seg range" role="group" aria-label="Chart range">${Object.keys(RANGES).map((k) =>
    `<button type="button" data-range="${k}" class="${k === cur ? 'on' : ''}" aria-pressed="${k === cur}">${RANGES[k].label}</button>`).join('')}</div>`;

  // ---------- views ----------
  const views = {};

  views.dashboard = async () => {
    const range = chartRange(), cmode = chartMode();
    const [stats, { blocks }, net] = await Promise.all([BB.pool(`stats?range=${range}&mode=${cmode}`), BB.pool('blocks?limit=8'), BB.network().catch(() => null)]);
    const share = net && net.hashrate ? stats.hashrate / net.hashrate : null;
    const expectedPerDay = share != null ? share * 1440 : null;
    return `
      <div class="page-head"><h1 class="page-title">Pool</h1></div>
      <div class="tiles">
        ${tile('Pool hashrate', hr(stats.hashrate), share != null ? `${pct(share, 2)} of the network` : '', 'accent')}
        ${tile('Miners / workers', `${int(stats.minersTotal)} / ${int(stats.workersTotal)}`)}
        ${tile('Blocks 24h', int(stats.blocks24h), [expectedPerDay != null ? `expected ${fix(expectedPerDay, 1)}` : '', stats.effort24h != null ? `effort ${pct(stats.effort24h, 0)}` : ''].filter(Boolean).join(' · '))}
        ${tile('Last block', ago(stats.lastBlockFound))}
        ${tile('Fee', pctFee(stats.fee), `${esc(stats.scheme)} · solo ${pctFee(stats.soloFee)}${stats.finderBonus ? ` · finder bonus ${pctFee(stats.finderBonus)}` : ''}`)}
        ${tile('Min payout', beam(stats.minPayout, 2), `every ${dur(stats.payoutInterval)}, after ${int(stats.maturity)} confirmations`)}
      </div>
      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">${cmode === 'solo' ? 'Solo hashrate' : 'Pool hashrate'}</h2><div class="panel-meta">${netMeta(net)}${modeSwitch(cmode)}${rangeSwitch(range)}</div></div>
        ${areaChart(stats.chart, { title: cmode === 'solo' ? 'Solo hashrate' : 'Pool hashrate', range, peak: true, peakAt: stats.chartPeak })}
      </section>
      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">Recent blocks</h2><div class="panel-meta"><a href="/blocks">all blocks →</a></div></div>
        ${blocksTable(blocks, stats.maturity)}
      </section>
      ${poolsTable(stats, net, { meta: false })}`;
  };

  views.network = async () => {
    const [stats, net] = await Promise.all([BB.pool('stats'), BB.network().catch(() => null)]);
    let bl = [];
    try { bl = await BB.networkBlocks(80); } catch (e) { bl = []; }
    const recent = bl.length ? `<section class="panel"><div class="panel-head"><h2 class="panel-title">Recent network blocks</h2></div>
        <div class="table-wrap"><table><thead><tr><th>Block</th><th>Mined by</th><th class="num"><span class="tipped" title="From the block's timestamp on the chain. The node sets it when it builds the block template, so it reads earlier than the moment a miner found the block, which is what Last found shows.">Age</span></th></tr></thead><tbody>
        ${bl.slice(0, 30).map((b) => {
          // our blocks: the row marked as the explorer marks them (tr.ours), the name in our legend colour
          const ours = isOurs(b.by);
          const colour = ours ? OUR_COLOUR : null;
          const rowAttr = ours ? ' class="ours"' : '';
          const name = b.by ? `<span class="name"${colour ? ` style="color:${colour}"` : ''}>${esc(b.by)}</span>` : '<span class="dim">—</span>';
          // the height as the explorer shows our blocks: a badge
          const height = ours
            ? `<a class="badge ok ours-h" href="${explorerBlock(b.height)}" target="_blank" rel="noopener" title="Found by the BumbleBeam pool">${int(b.height)}</a>`
            : `<a href="${explorerBlock(b.height)}" target="_blank" rel="noopener">${int(b.height)}</a>`;
          return `<tr${rowAttr}><td>${height}</td><td>${name}</td><td class="num dim">${ago(b.ts)}</td></tr>`;
        }).join('')}
        </tbody></table></div></section>` : '';
    const donut = blocksDonut(net), times = blockTimes(bl);
    const next = BB.nextRewardChange(net && net.height);
    return `<div class="page-head"><h1 class="page-title">Network</h1></div>
      <div class="tiles">
        ${tile('Network hashrate', hr(net && net.hashrate), '', 'accent')}
        ${tile('Difficulty', net && net.difficulty ? `${fix(net.difficulty / 1e6, 2)}M` : '—', 'solutions per block, expected')}
        ${tile('Block reward', beam(BB.blockReward(net && net.height), 1), `${beam(next.reward, 1)} from height ${int(next.height)}`)}
        ${tile('Blocks 24h', int(net && net.blocks24h), net && net.avgBlock ? `avg block ${fix(net.avgBlock, 1)}s` : '')}
      </div>
      ${poolsTable(stats, net)}
      ${donut || times ? `<section class="panel"><div class="panel-head"><h2 class="panel-title">Blocks by pool</h2><div class="panel-meta"><span class="pill on">24h</span></div></div>${donut}${times}</section>` : ''}
      ${recent}`;
  };

  views.blocks = async () => {
    const [{ blocks }, stats] = await Promise.all([BB.pool('blocks?limit=50'), BB.pool('stats')]);
    const day = blocks.filter((b) => b.ts > Date.now() / 1000 - 86400);
    const effort24h = stats.effort24h ?? (day.length ? day.reduce((s, b) => s + (b.effort || 0), 0) / day.length : null);
    const next = BB.nextRewardChange(stats.height);
    const more = moreBlocks(blocks, 50);
    return `<div class="page-head"><h1 class="page-title">Blocks</h1></div>
      <div class="tiles">
        ${tile('Blocks 24h', int(stats.blocks24h ?? day.length))}
        ${tile('Average effort 24h', pct(effort24h, 0), 'shares spent / expected; below 100% is good luck')}
        ${tile('Pending', int(stats.blocksPending ?? blocks.filter((b) => b.status === 'pending' || b.status === 'unverified').length), `${int(stats.maturity)} confirmations to mature`)}
        ${tile('Block reward', beam(stats.blockReward, 1), `+ fees · ${beam(next.reward, 1)} from height ${int(next.height)}`)}
      </div>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Found blocks</h2><div class="panel-meta"><span>Orphaned in list: <b>${int(blocks.filter((b) => b.status === 'orphaned').length)}</b></span></div></div>
      ${blocksTable(blocks, stats.maturity, more)}</section>
      <template id="ctx" data-maturity="${int(stats.maturity).replace(/,/g, '')}"></template>`;
  };

  // "Load older blocks" under a blocks table that came back full; with `miner`, that miner's blocks only.
  const moreBlocks = (blocks, page, miner) => (blocks.length >= page
    ? `<div class="more"><button class="btn ghost" id="more-blocks" data-before="${blocks[blocks.length - 1].height}"${miner ? ` data-miner="${esc(miner)}"` : ''}>Load older blocks</button></div>` : '');

  function bindBlocks() {
    const btn = $('#more-blocks');
    if (!btn) return;
    const maturity = Number($('#ctx').dataset.maturity) || BB.MATURITY;
    const miner = btn.dataset.miner ? `&miner=${encodeURIComponent(btn.dataset.miner)}` : '';
    btn.addEventListener('click', async () => {
      // the live refresh would drop the loaded rows, so it skips this page from now on
      $('#blocks-body').dataset.more = '1';
      btn.disabled = true;
      btn.textContent = 'Loading…';
      try {
        const { blocks } = await BB.pool(`blocks?limit=50&before=${Number(btn.dataset.before) || 0}${miner}`);
        $('#blocks-body').insertAdjacentHTML('beforeend', blocksRows(blocks, maturity));
        if (blocks.length < 50) btn.remove();
        else { btn.dataset.before = String(blocks[blocks.length - 1].height); btn.disabled = false; btn.textContent = 'Load older blocks'; }
      } catch (e) {
        btn.textContent = 'Could not load';
      }
    });
  }

  // ---------- a miner's own blocks: sort by mode, effort or finder, filter by mode and finder ----------
  // Kept across the page's live refresh, for the same address.
  const MINE_PAGE = 10;
  const mine = { addr: '', blocks: [], maturity: 0, mode: '', finder: '', sort: '', dir: 1, shown: MINE_PAGE };
  const MINE_SORTS = {
    mode: (a, b) => a.mode.localeCompare(b.mode),
    finder: (a, b) => String(a.finder || '').localeCompare(String(b.finder || ''), 'en', { numeric: true }),
    effort: (a, b) => (a.effort ?? Infinity) - (b.effort ?? Infinity),
  };
  function mineList() {
    const list = mine.blocks.filter((b) => (!mine.mode || b.mode === mine.mode) && (!mine.finder || b.finder === mine.finder));
    const by = MINE_SORTS[mine.sort];
    // a block without an effort goes last either way; ties, and no sort at all: newest first
    const last = (a, b) => (mine.sort === 'effort' ? (a.effort == null) - (b.effort == null) : 0);
    return list.sort((a, b) => last(a, b) || (by ? by(a, b) * mine.dir : 0) || b.height - a.height);
  }
  const ddHtml = (id, label, value, opts) => `<div class="dd compact" id="${id}" data-value="${esc(value)}"><button type="button" class="dd-btn" aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(label)}"></button>
    <ul class="dd-list" role="listbox" tabindex="-1" hidden>${opts.map(([v, t]) => `<li role="option" data-v="${esc(v)}">${esc(t)}</li>`).join('')}</ul></div>`;
  function minerBlocksPanel() {
    const modes = [...new Set(mine.blocks.map((b) => b.mode))].sort();
    const finders = [...new Set(mine.blocks.map((b) => b.finder).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    const th = (key, text, cls = '') => `<th class="sortable${cls}" data-sort="${key}" tabindex="0" aria-label="Sort by ${text.toLowerCase()}">${text}</th>`;
    return `<section class="panel" id="mine-blocks"><div class="panel-head"><h2 class="panel-title">Blocks you found</h2>
        <div class="panel-meta"><span id="mine-count"></span>
          ${ddHtml('mine-mode', 'Filter by mode', mine.mode, [['', 'All modes'], ...modes.map((v) => [v, v === 'solo' ? 'Solo' : 'PPLNS'])])}
          ${ddHtml('mine-finder', 'Filter by finder', mine.finder, [['', 'All finders'], ...finders.map((v) => [v, v])])}</div></div>
      <div class="table-wrap"><table class="blocks-table"><colgroup><col class="w-h"><col class="w-t"><col class="w-m"><col class="w-e"><col><col class="w-r"><col class="w-s"></colgroup>
        <thead><tr><th>Height</th><th>Found</th>${th('mode', 'Mode')}${th('effort', 'Effort', ' num')}${th('finder', 'Finder')}<th class="num">Reward</th><th class="num">Status</th></tr></thead>
        <tbody id="mine-body"></tbody></table></div>
      <div class="more" id="mine-more" hidden><button class="btn ghost">Show more</button></div></section>`;
  }
  function drawMine() {
    const list = mineList();
    $('#mine-body').innerHTML = list.length ? blocksRows(list.slice(0, mine.shown), mine.maturity, true) : '<tr><td colspan="7" class="dim">No blocks match</td></tr>';
    $('#mine-more').hidden = list.length <= mine.shown;
    const all = mine.blocks.length;
    $('#mine-count').textContent = list.length === all ? `${int(all)} blocks` : `${int(list.length)} of ${int(all)}`;
    document.querySelectorAll('#mine-blocks th[data-sort]').forEach((t) => {
      const on = t.dataset.sort === mine.sort;
      t.dataset.dir = on ? (mine.dir > 0 ? '▲' : '▼') : '';
      t.setAttribute('aria-sort', on ? (mine.dir > 0 ? 'ascending' : 'descending') : 'none');
    });
  }
  function bindMinerBlocks() {
    if (!$('#mine-blocks')) return;
    dropdown($('#mine-mode'), (v) => { mine.mode = v; mine.shown = MINE_PAGE; drawMine(); });
    dropdown($('#mine-finder'), (v) => { mine.finder = v; mine.shown = MINE_PAGE; drawMine(); });
    const sortBy = (key) => {
      // first click ascending, again descending, a third time back to newest first
      if (mine.sort !== key) { mine.sort = key; mine.dir = 1; } else if (mine.dir > 0) mine.dir = -1; else { mine.sort = ''; mine.dir = 1; }
      drawMine();
    };
    document.querySelectorAll('#mine-blocks th[data-sort]').forEach((t) => {
      t.addEventListener('click', () => sortBy(t.dataset.sort));
      t.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sortBy(t.dataset.sort); } });
    });
    $('#mine-more button').addEventListener('click', () => { mine.shown += MINE_PAGE; drawMine(); });
    drawMine();
  }

  views.miners = async (arg) => {
    if (arg) return minerView(arg);
    const mm = MINERS_MODES[prefs.get(MINERS_MODE_KEY)] ? prefs.get(MINERS_MODE_KEY) : 'all';
    const [{ miners }, stats] = await Promise.all([BB.pool(`miners?limit=50${mm === 'all' ? '' : `&mode=${mm}`}`), BB.pool('stats')]);
    const top = miners.length ? miners[0].hashrate || 1 : 1;
    const ms = stats.modes, total = mm !== 'all' && ms ? ms[mm].hashrate : stats.hashrate;
    const counts = ms ? `<span>Pool: <b>${int(ms.pplns.miners)}</b> · ${hr(ms.pplns.hashrate)}</span><span>Solo: <b>${int(ms.solo.miners)}</b> · ${hr(ms.solo.hashrate)}</span>`
      : `<span>Total: <b>${int(stats.minersTotal)}</b></span><span>Pool: <b>${hr(stats.hashrate)}</b></span>`;
    return `<div class="page-head"><h1 class="page-title">Miners</h1></div>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Miners by hashrate</h2><div class="panel-meta">${counts}${modeSwitch(mm, 'data-miners-mode', 'Miners mode', MINERS_MODES)}</div></div>
      <p class="hint">Beam is a private chain, so the pool does not list wallet addresses. Your own pool stats open only with your payout address: hashrate, what the pool still owes you, and past payouts. Wallet balances are never visible, not to the pool either.</p>
      ${miners.length ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Hashrate</th><th>Mode</th><th class="num">24h avg</th><th class="num">Share</th><th class="num">Workers</th><th class="num">Last share</th></tr></thead><tbody>
      ${miners.map((m, i) => `<tr><td class="dim">${i + 1}</td>
        <td>${hr(m.hashrate)}<div class="bar accent"><i style="width:${Math.min(100, (m.hashrate / top) * 100).toFixed(1)}%"></i></div></td>
        <td>${modesBadges(m.modes)}</td>
        <td class="num">${hr(m.hashrate24h)}</td><td class="num">${pct(total ? m.hashrate / total : null, 2)}</td>
        <td class="num">${int(m.workers)}</td><td class="num dim">${ago(m.lastShare)}</td></tr>`).join('')}
      </tbody></table></div>` : `<div class="empty">${mm === 'solo' ? 'No solo miners right now' : mm === 'pplns' ? 'No PPLNS miners right now' : 'No miners yet'}</div>`}</section>`;
  };
  const MINERS_MODES = { all: 'All', pplns: 'Pool', solo: 'Solo' };
  const MINERS_MODE_KEY = 'bb.minersMode', MINER_MODE_KEY = 'bb.minerMode';
  const modesBadges = (modes) => (modes && modes.length ? modes.map(modeBadge).join(' ') : '<span class="dim">—</span>');

  const MY_KEY = 'bb.myAddress';
  function rememberAddress(a) { prefs.set(MY_KEY, a); setMyLink(); }
  function forgetAddress() { prefs.del(MY_KEY); setMyLink(); }
  function myAddress() { return prefs.get(MY_KEY); }
  function setMyLink() {
    const a = $('#nav-my'), addr = myAddress();
    a.hidden = !addr;
    if (addr) a.href = minerHref(addr);
  }

  async function minerView(address) {
    address = cleanAddress(address);
    const range = chartRange(), mm = MINERS_MODES[prefs.get(MINER_MODE_KEY)] ? prefs.get(MINER_MODE_KEY) : 'all';
    const [m, stats] = await Promise.all([BB.pool(`miners/${encodeURIComponent(address)}?range=${range}${mm === 'all' ? '' : `&mode=${mm}`}`), BB.pool('stats')]);
    const modeNote = mm === 'all' ? '' : ` · ${mm === 'solo' ? 'solo' : 'PPLNS'}`;
    // "My stats" is for an address that has mined here (sent a share), not for any lookup.
    const addr = m.address || address;
    // every block of this miner (up to 500), so sorting and the filters see them all
    if (m.blocksFound > m.blocks.length) {
      try { m.blocks = (await BB.pool(`blocks?limit=500&miner=${encodeURIComponent(addr)}`)).blocks; } catch (e) { /* the latest ten stay */ }
    }
    mine.blocks = m.blocks;
    mine.maturity = stats.maturity;
    if (mine.addr !== addr) Object.assign(mine, { addr, mode: '', finder: '', sort: '', dir: 1, shown: MINE_PAGE });
    if (m.lastShare != null) rememberAddress(addr);
    else if (addr === myAddress()) forgetAddress();
    const toPayout = stats.minPayout ? Math.min(1, m.balance / stats.minPayout) : null;
    return `<div class="page-head"><h1 class="page-title">Miner</h1><div class="actions"><a class="btn ghost" href="/miners">← all miners</a></div></div>
      <div class="panel addr"><span>${esc(m.address || address)}</span><button class="btn small" data-copy="${esc(m.address || address)}">copy</button></div>
      <div class="tiles">
        ${tile(`Hashrate${modeNote}`, hr(m.hashrate), `24h avg ${hr(m.hashrate24h)}`, 'accent')}
        ${m.coinbase ? (m.balance < 0 ? tile('Advance', beam(-m.balance), 'a block that paid you was orphaned; the next blocks work it off') : tile('Unpaid', beam(m.balance), 'goes into the next blocks the pool finds')) : tile('Unpaid', beam(m.balance), toPayout != null ? `owed by the pool · ${pct(toPayout, 0)} of the ${beam(stats.minPayout, 2)} threshold` : 'owed by the pool')}
        ${tile('Immature', beam(m.immature), 'blocks still confirming')}
        ${tile('Paid', beam(m.paid, 2), m.coinbase ? 'in the blocks themselves, to your own outputs' : undefined)}
        ${tile('Blocks found', int(m.blocksFound), m.blocksFound ? `${int(m.blocks24h)} in 24h · last ${ago(m.lastBlockAt)}` : 'by your shares')}
        ${tile('Last share', ago(m.lastShare))}
      </div>
      ${m.coinbase ? `<section class="panel"><div class="panel-head"><h2 class="panel-title">Coinbase account</h2><div class="panel-meta"><span>Paid in the blocks, with outputs made by your own bb-coinbase: the pool never holds your coins</span></div></div>
      <div class="tiles">
        ${tile('Pair stock', int(m.coinbase.stockPairs), `${beam(m.coinbase.stockValue, 2)} ready for the next blocks${m.coinbase.stockPairs < 12 ? ' · run bb-coinbase top-up' : ''}`, m.coinbase.stockPairs < 12 ? 'warn' : '')}
        ${tile('Paid in blocks', int(m.coinbase.blocks), `${int(m.coinbase.minedPairs)} outputs, ${beam(m.coinbase.minedValue, 2)}`)}
        ${tile('Stock expires', m.coinbase.expiresAt ? `#${int(m.coinbase.expiresAt)}` : '—', m.coinbase.expiredPairs ? `${int(m.coinbase.expiredPairs)} pairs expired unspent` : 'pairs live 30 days; top-up renews them')}
      </div></section>` : ''}
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Hashrate${modeNote}</h2><div class="panel-meta">${modeSwitch(mm, 'data-miner-mode', 'Miner mode', MINERS_MODES)}${rangeSwitch(range)}</div></div>${areaChart(m.chart, { title: 'Miner hashrate', range, peak: true, peakAt: m.chartPeak })}</section>
      <div class="grid2">
        <section class="panel"><div class="panel-head"><h2 class="panel-title">Workers${modeNote}</h2></div>
          ${m.workers.length ? `<div class="table-wrap"><table><thead><tr><th></th><th>Worker</th><th>Mode</th><th class="num">Hashrate</th><th class="num">24h avg</th><th class="num">Stale</th><th class="num">Rejected</th><th class="num">Last share</th></tr></thead><tbody>
          ${m.workers.map((w) => `<tr><td><span class="dot ${w.online ? '' : 'off'}"></span></td><td>${esc(w.name)}</td><td>${modesBadges(w.modes)}</td><td class="num">${hr(w.hashrate)}</td><td class="num">${hr(w.hashrate24h)}</td>
            <td class="num dim">${pct(w.stale, 1)}</td><td class="num" style="color:${w.rejected > 0.01 ? 'var(--color-red)' : 'var(--muted)'}">${pct(w.rejected, 1)}</td><td class="num dim">${ago(w.lastShare)}</td></tr>`).join('')}
          </tbody></table></div>` : '<div class="empty">No workers</div>'}
        </section>
        <section class="panel"><div class="panel-head"><h2 class="panel-title">Payments</h2></div>
          ${m.payments.length ? `<div class="table-wrap"><table><thead><tr><th>Time</th><th class="num">Amount</th><th>Kernel</th></tr></thead><tbody>
          ${m.payments.map((p) => `<tr><td class="dim">${ago(p.ts)}</td><td class="num">${beam(p.amount)}</td><td class="dim">${paymentRef(p)}</td></tr>`).join('')}
          </tbody></table></div>` : '<div class="empty">No payments yet</div>'}
        </section>
      </div>
      ${m.blocks.length ? minerBlocksPanel() : ''}`;
  }

  views.payments = async () => {
    const [{ payments }, stats] = await Promise.all([BB.pool('payments?limit=50'), BB.pool('stats')]);
    const day = payments.filter((p) => p.ts > Date.now() / 1000 - 86400);
    return `<div class="page-head"><h1 class="page-title">Payments</h1></div>
      <div class="tiles">
        ${tile('Paid 24h', beam(day.reduce((s, p) => s + p.amount, 0), 2))}
        ${tile('Payout runs 24h', int(day.length), `every ${dur(stats.payoutInterval)}`)}
        ${tile('Min payout', beam(stats.minPayout, 2), stats.minerPaysTxFee ? `network fee deducted, about ${beam(stats.shieldedFee, 3)} per payout to an offline address` : 'network fee paid by the pool')}
      </div>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Payout transactions</h2><div class="panel-meta"><span>Every payout is its own Beam transaction: open its kernel in the explorer to see it on the chain</span></div></div>
      ${payments.length ? `<div class="table-wrap"><table><thead><tr><th>Time</th><th class="num">Amount</th><th class="num">Miners</th><th>Kernels</th></tr></thead><tbody>
      ${payments.map((p) => `<tr><td class="dim">${ago(p.ts)}</td><td class="num">${beam(p.amount, 2)}</td><td class="num">${int(p.miners)}</td>
        <td class="dim">${kernelCell(p)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No payments yet</div>'}</section>`;
  };

  // One kernel link, or for a run with several transactions a list of all of them with amounts.
  // A payout by transaction links its kernel; a payout in a block (coinbase accounts) links the block.
  function paymentRef(p) {
    const cb = p.kernel && /^coinbase@(\d+)/.exec(p.kernel);
    if (cb) return `<a href="${explorerBlock(cb[1])}" target="_blank" rel="noopener">block ${int(cb[1])}</a>${p.status === 'pending' ? ' <span class="dim">· confirming</span>' : ''}`;
    return p.kernel ? `<a href="${explorerKernel(p.kernel)}" target="_blank" rel="noopener">${esc(short(p.kernel))}</a>` : '—';
  }
  const kernelLink = (k) => `<a href="${explorerKernel(k)}" target="_blank" rel="noopener" class="mono">${esc(short(k))}</a>`;
  const kernelCell = (p) => {
    if (p.txs.length > 1) {
      return `<details class="kernels"><summary>${int(p.txs.length)} transactions</summary>
        ${p.txs.map((t) => `<div>${kernelLink(t.kernel)} <span class="num">${beam(t.amount, 3)}</span></div>`).join('')}</details>`;
    }
    const k = p.txs.length ? p.txs[0].kernel : p.kernel;
    return k ? kernelLink(k) : '—';
  };

  // Official download pages of the miners on the connect page; nothing is mirrored here.
  const MINERS = [
    { name: 'MXBM', url: 'https://git.maxnflaxl.dev/maxnflaxl/MXBM', what: 'open source (Apache-2.0), NVIDIA, AMD, Apple; built from source' },
    { name: 'lolMiner', url: 'https://github.com/Lolliedieb/lolMiner-releases/releases', what: 'NVIDIA, AMD; Windows, Linux' },
    { name: 'GMiner', url: 'https://github.com/develsoftware/GMinerRelease/releases', what: 'NVIDIA, AMD; Windows, Linux' },
    { name: 'bumblebeam-miner', url: 'https://github.com/profinch/bumblebeam/releases', what: 'open source CPU miner, a reference tool rather than an earner' },
  ];

  views.connect = async () => {
    const [stats, net] = await Promise.all([BB.pool('stats'), BB.network().catch(() => null)]);
    const host = BB.stratumHost(stats);
    const ports = stats.ports || { pplns: 3333, solo: 3334, pplnsTls: 3443, soloTls: 3444 };
    const top = net && net.ok && net.pools.length ? net.pools.reduce((a, b) => (b.hashrate > a.hashrate ? b : a)) : null;
    return `<div class="page-head"><h1 class="page-title">Start mining</h1></div>
      <div class="grid2">
        <section class="panel" id="guide"><div class="panel-head"><h2 class="panel-title">Connect in three steps</h2></div>
          <div class="steps">
            <div class="step"><h3>Get an offline Beam address</h3>
              <p>In any Beam wallet open <b>Receive</b> and choose an <b>offline</b> (permanent) address. A regular address expires and
                needs your wallet online to receive, so payouts to it fail while the wallet is closed.${stats.coinbase ? ` Or skip the address: with <a href="https://github.com/profinch/bumblebeam/tree/main/tools/coinbase" target="_blank" rel="noopener">bb-coinbase</a> you are <b>paid in the blocks themselves</b>, to outputs you made, and log in with your <code>cb:…</code> account.` : ''}${stats.nodeAddr ? ` Your wallet can use our node: <code>${esc(stats.nodeAddr)}</code>.` : ''}</p>
              <div class="row"><label class="field" style="flex:1;min-width:240px">Wallet address<input id="addr" placeholder="paste your offline address" spellcheck="false" autocomplete="off"></label>
              <label class="field">Worker<input id="worker" value="rig1" maxlength="32" style="width:110px"></label></div>
              <div class="note" id="addr-note" hidden></div></div>
            <div class="step"><h3>Pick a mode</h3><p>PPLNS shares every block the pool finds, in proportion to your shares. Solo pays you the whole block, only when your rig finds it. Both ${pctFee(stats.fee)} fee.${stats.finderBonus ? ` In PPLNS the rig whose share finds a block also gets a <b>${pctFee(stats.finderBonus)} finder bonus</b> on top of its share.` : ''}</p>
              <div class="row" style="align-items:center">
                <div class="seg" id="mode"><button class="on" data-v="pplns">PPLNS</button><button data-v="solo">Solo</button></div>
                <div class="seg" id="tls"><button data-v="0">TCP</button><button class="on" data-v="1">TLS</button></div>
                <span class="dim mono" id="portline"></span>
              </div></div>
            <div class="step"><h3>Run your miner</h3><p>Any BeamHash III miner, NVIDIA or AMD with 3 GB or more. <a href="https://git.maxnflaxl.dev/maxnflaxl/MXBM" target="_blank" rel="noopener">MXBM</a> is the open-source GPU miner (CUDA, OpenCL, Metal), <a href="https://github.com/profinch/bumblebeam/releases" target="_blank" rel="noopener">bumblebeam-miner</a> mines on any CPU with 8 GB of memory; lolMiner and GMiner work too. Rejected shares come back with the reason, so you can tell a bad kernel from a bad connection.</p>
              <div class="stack" id="cmds" style="gap:8px"></div></div>
          </div>
        </section>
        <div class="stack">
          <section class="panel" id="calc"><div class="panel-head"><h2 class="panel-title">Calculator</h2><div class="panel-meta"><span>live network</span></div></div>
            <div class="row">
              <label class="field" style="flex:1">Your hashrate, Sol/s<input id="sols" type="number" min="0" step="1" value="52"></label>
              <div class="field">Card<div class="dd" id="card" data-value="52"><button type="button" class="dd-btn" aria-haspopup="listbox" aria-expanded="false" aria-label="Card">RTX 3090 · 52</button><ul class="dd-list" role="listbox" tabindex="-1" hidden><li class="dd-group" role="presentation">NVIDIA</li><li role="option" data-v="85">RTX 4090 · 85</li><li role="option" data-v="78">RTX 5080 (MXBM) · 78</li><li role="option" data-v="57">RTX 4070 Ti Super · 57</li><li role="option" data-v="54">RTX 3080 Ti · 54</li><li role="option" data-v="52" aria-selected="true">RTX 3090 · 52</li><li role="option" data-v="47">RTX 4070 Super · 47</li><li role="option" data-v="47">RTX 4070 · 47</li><li role="option" data-v="46.5">RTX 3080 · 46.5</li><li role="option" data-v="35">RTX 3070 Ti · 35</li><li role="option" data-v="34">RTX 3070 · 34</li><li role="option" data-v="32.5">RTX 3060 Ti · 32.5</li><li role="option" data-v="26">RTX 5060 Ti · 26</li><li role="option" data-v="22">RTX 3060 · 22</li><li class="dd-group" role="presentation">AMD</li><li role="option" data-v="36">RX 6800 XT · 36</li><li role="option" data-v="33">RX 6900 XT · 33</li><li role="option" data-v="">custom</li></ul></div></div>
            </div>
            <div class="calc-out" id="calc-out"></div>
            <p class="dim" style="font-size:11px;margin:14px 0 0;line-height:1.5">Card figures are lolMiner rates published by WhatToMine (the RTX 5080: MXBM's own measurement), in Sol/s; measure your own. Uses network hashrate ${hr(net && net.hashrate)},
              ${beam(stats.blockReward, 1)} per block plus fees, ${pctFee(stats.fee)} pool fee.</p>
          </section>
          <section class="panel" id="downloads"><div class="panel-head"><h2 class="panel-title">Get a miner from its official source</h2></div>
            <div class="stack why">
              ${MINERS.map((m) => `<div><a href="${m.url}" target="_blank" rel="noopener"><b>${m.name}</b></a> <span class="dim">· ${m.what}</span></div>`).join('')}
              <div class="dim" style="font-size:12px">Only download miners from these pages. Copies on other sites and in chats are a common way to spread malware.</div>
            </div>
          </section>
          <section class="panel"><div class="panel-head"><h2 class="panel-title">Why BumbleBeam</h2></div>
            <div class="stack why">
              <div><b>Open source.</b> Server, share checks and payouts are public code, tested against the Beam core on real mainnet blocks.</div>
              <div><b>Checkable.</b> Every block and every payout transaction links to the chain, and PPLNS rounds are published so you can recompute your share.</div>
              ${stats.finderBonus ? `<div><b>Finder bonus.</b> Find a block in PPLNS and ${pctFee(stats.finderBonus)} of it is yours on top of your share.</div>` : ''}
              <div><b>${pctFee(stats.fee)} fee</b>, PPLNS or solo on the same server, no registration. Payouts carry only Beam's own network fee.</div>
              ${stats.coinbase ? '<div><b>Non-custodial.</b> Be paid in the blocks, with coinbase outputs only your wallet can spend: the pool never holds your coins.</div>' : ''}
              <div><b>Decentralises Beam.</b> ${top && net.hashrate ? `${esc(top.name)} holds ${pct(top.hashrate / net.hashrate, 0)}` : 'One pool holds most'} of the network today.</div>
            </div>
          </section>
          <section class="panel"><div class="panel-head"><h2 class="panel-title">Help</h2></div>
            <div class="why">A rig mined to a wrong address, a payout is late, or a miner will not connect?
              Write to <a href="mailto:support@bumblebeam.org">support@bumblebeam.org</a> with your address and what you see.</div>
          </section>
        </div>
      </div>
      <template id="ctx" data-host="${esc(host)}" data-net="${Number(net && net.hashrate) || 0}" data-fee="${Number(stats.fee) || 0}" data-reward="${Number(stats.blockReward) || 0}"
        data-ports="${[ports.pplns, ports.solo, ports.pplnsTls, ports.soloTls].map((p) => Number(p) || 0).join(',')}"></template>`;
  };

  // Beam address shapes, for a hint only; the server validates. Regular SBBS addresses are
  // 64–66 hex chars; offline, max-privacy and public-offline addresses are much longer.
  function addressHint(a) {
    if (!a) return null;
    if (/^cb:[0-9a-f]{64}0[01]$/i.test(a)) return { cls: 'ok', text: 'Coinbase account: you are paid in the blocks themselves, to your own outputs. Keep the pair stock topped up.' };
    if (/^[0-9a-f]{64,70}$/i.test(a)) return { cls: 'warn', text: 'This looks like a regular address. It expires and needs your wallet online; use an offline address from Receive.' };
    if (a.length >= 100 && /^[0-9a-z]+$/i.test(a)) return { cls: 'ok', text: 'Offline address: payouts arrive while your wallet is closed.' };
    return { cls: 'warn', text: 'This does not look like a Beam address.' };
  }

  // A small listbox in place of a native <select>, whose open list the browser draws itself (system
  // colours, square corners). Opened, it continues the button seamlessly: same fill and border,
  // the button's bottom corners square, the list's bottom corners round. Keyboard: arrows,
  // Home/End, Enter or Space to pick, Esc or Tab to close.
  function dropdown(root, onPick) {
    const btn = root.querySelector('.dd-btn'), list = root.querySelector('.dd-list');
    const items = [...list.querySelectorAll('[role="option"]')];
    let active = -1;
    const isOpen = () => !list.hidden;
    function mark(i) {
      active = i;
      items.forEach((li, j) => li.classList.toggle('active', j === i));
      if (items[i]) items[i].scrollIntoView({ block: 'nearest' });
    }
    function set(v) {
      const li = items.find((x) => x.dataset.v === v) || items.find((x) => x.dataset.v === '');
      items.forEach((x) => x.setAttribute('aria-selected', String(x === li)));
      root.dataset.value = li ? li.dataset.v : '';
      btn.textContent = li ? li.textContent : '';
    }
    function open() {
      list.hidden = false;
      root.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      mark(Math.max(0, items.findIndex((x) => x.getAttribute('aria-selected') === 'true')));
    }
    function close(focus = true) {
      list.hidden = true;
      root.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      if (focus) btn.focus();
    }
    function pick(i) {
      const li = items[i];
      if (!li) return;
      set(li.dataset.v);
      close();
      onPick(li.dataset.v);
    }
    btn.addEventListener('click', () => (isOpen() ? close() : open()));
    list.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus on the button
    list.addEventListener('click', (e) => { const li = e.target.closest('[role="option"]'); if (li) pick(items.indexOf(li)); });
    list.addEventListener('mousemove', (e) => { const li = e.target.closest('[role="option"]'); if (li && items.indexOf(li) !== active) mark(items.indexOf(li)); });
    btn.addEventListener('keydown', (e) => {
      const k = e.key;
      if (!isOpen()) {
        if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(k)) { e.preventDefault(); open(); }
        return;
      }
      if (k === 'ArrowDown') { e.preventDefault(); mark(Math.min(items.length - 1, active + 1)); }
      else if (k === 'ArrowUp') { e.preventDefault(); mark(Math.max(0, active - 1)); }
      else if (k === 'Home') { e.preventDefault(); mark(0); }
      else if (k === 'End') { e.preventDefault(); mark(items.length - 1); }
      else if (k === 'Enter' || k === ' ') { e.preventDefault(); pick(active); }
      else if (k === 'Escape') { e.preventDefault(); close(); }
      else if (k === 'Tab') close(false);
    });
    document.addEventListener('click', (e) => { if (isOpen() && !root.contains(e.target)) close(false); });
    set(root.dataset.value || '');
    return { set };
  }

  function bindConnect() {
    const ctx = $('#ctx');
    if (!ctx) return;
    const host = ctx.dataset.host, netHash = Number(ctx.dataset.net), fee = Number(ctx.dataset.fee) / 100, reward = Number(ctx.dataset.reward) / BB.GROTH;
    const [pPplns, pSolo, pPplnsTls, pSoloTls] = (ctx.dataset.ports || '3333,3334,3443,3444').split(',').map(Number);
    // the form is remembered: mode, TLS, address, worker, card and hashrate
    const state = { mode: prefs.get('bb.mode') === 'solo' ? 'solo' : 'pplns', tls: prefs.get('bb.tls') === '0' ? '0' : '1' };
    const seg = (id, key) => {
      const mark = () => [...$(id).children].forEach((x) => x.classList.toggle('on', x.dataset.v === state[key]));
      mark();
      $(id).addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        state[key] = b.dataset.v;
        prefs.set(`bb.${key}`, state[key]);
        mark();
        render();
      });
    };
    if (prefs.get('bb.addr')) $('#addr').value = prefs.get('bb.addr');
    if (prefs.get('bb.worker')) $('#worker').value = prefs.get('bb.worker');
    if (prefs.get('bb.sols')) $('#sols').value = prefs.get('bb.sols');
    function render() {
      const port = state.mode === 'solo' ? (state.tls === '1' ? pSoloTls : pSolo) : (state.tls === '1' ? pPplnsTls : pPplns);
      const addr = cleanAddress($('#addr').value), worker = $('#worker').value.trim().replace(/[^\w-]/g, '') || 'rig1';
      const user = `${addr || '<address>'}.${worker}`;
      const tlsFlag = state.tls === '1';
      $('#portline').textContent = `${host}:${port} · ${state.mode === 'solo' ? 'solo' : 'PPLNS'}${tlsFlag ? ' · TLS' : ''}`;
      const cmds = [
        ['bumblebeam-miner (CPU, open source)', `bumblebeam-miner mine --pool ${host}:${port} --user ${user} --tls ${tlsFlag ? 1 : 0}`],
        ['MXBM (GPU, open source, Apache-2.0)', `mxbm --algo BEAM-III --pool ${host}:${port} --user ${user} --tls ${tlsFlag ? 1 : 0}`],
        ['lolMiner', `lolMiner --algo BEAM-III --pool ${host}:${port} --user ${user}${tlsFlag ? ' --tls on' : ''}`],
        ['GMiner', `miner --algo beamhashIII --server ${host}:${port} --user ${user}${tlsFlag ? ' --ssl 1' : ''}`],
      ];
      $('#cmds').innerHTML = cmds.map(([n, c]) => `<div><div class="dim mono" style="font-size:10px;margin-bottom:4px">${n}</div><div class="code"><pre>${c.split(/ (?=--)/).map((a) => `<span class="arg">${esc(a)}</span>`).join(' ')}</pre><button class="btn small" data-copy="${esc(c)}">copy</button></div></div>`).join('');
      const hint = addressHint(addr), note = $('#addr-note');
      note.hidden = !hint;
      if (hint) { note.textContent = hint.text; note.className = `note ${hint.cls}`; }
    }
    function calc() {
      const sols = Number($('#sols').value) || 0;
      const out = $('#calc-out');
      if (!netHash) { out.innerHTML = '<div class="empty err">Network hashrate unavailable</div>'; return; }
      const share = sols / (netHash + sols);
      const perDay = share * 1440 * reward * (1 - fee);
      const soloHours = sols ? 1 / (share * 60) : Infinity;
      out.innerHTML = tile('Per day', `${perDay.toFixed(2)} BEAM`, 'PPLNS, average, after fee', 'accent') + tile('Per month', `${(perDay * 30).toFixed(0)} BEAM`)
        + tile('Network share', pct(share, 3)) + tile('Solo: one block every', isFinite(soloHours) ? (soloHours < 48 ? `${soloHours.toFixed(1)} h` : `${(soloHours / 24).toFixed(1)} d`) : '—', 'on average; luck varies a lot');
    }
    seg('#mode', 'mode');
    seg('#tls', 'tls');
    $('#addr').addEventListener('input', () => { prefs.set('bb.addr', cleanAddress($('#addr').value)); render(); });
    $('#worker').addEventListener('input', () => { prefs.set('bb.worker', $('#worker').value.trim()); render(); });
    const keepCalc = () => { prefs.set('bb.card', $('#card').dataset.value || ''); prefs.set('bb.sols', $('#sols').value); };
    const card = dropdown($('#card'), (v) => { if (v) $('#sols').value = v; keepCalc(); calc(); });
    if (prefs.get('bb.card') || prefs.get('bb.sols')) card.set(prefs.get('bb.card'));
    $('#sols').addEventListener('input', () => { card.set(''); keepCalc(); calc(); });
    render();
    calc();
  }

  // ---------- API page: pool/API.md from GitHub, so it never needs a separate update ----------
  const API_DOC_RAW = 'https://raw.githubusercontent.com/profinch/bumblebeam/main/pool/API.md';
  const API_DOC_PAGE = 'https://github.com/profinch/bumblebeam/blob/main/pool/API.md';
  let apiDoc = null; // { text, at }

  // Inline Markdown: code spans first, everything else escaped, then **bold** and [links](url).
  // Relative links resolve against the file on GitHub; only https links are kept.
  function mdInline(raw, { inTable = false } = {}) {
    // in tables, code may break after / ? & = (not after its first character), split before escaping
    const code = (t) => `<code>${inTable ? t.split(/(?<=.[/?&=])/).map(esc).join('<wbr>') : esc(t)}</code>`;
    const span = (txt) => txt.split(/(`[^`]+`)/).map((t) => (/^`[^`]+`$/.test(t) ? code(t.slice(1, -1))
      : esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>'))).join('');
    // links first, so their text may hold code: [`/v1/openapi.json`](https://…)
    return raw.split(/(\[[^\]]+\]\([^)\s]+\))/).map((t) => {
      const m = t.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      if (!m) return span(t);
      let url;
      try { url = new URL(m[2], API_DOC_PAGE); } catch (e) { return span(m[1]); }
      return url.protocol === 'https:' ? `<a href="${esc(url.href)}" target="_blank" rel="noopener">${span(m[1])}</a>` : span(m[1]);
    }).join('');
  }


  // The Markdown that API.md uses: headings, fenced code, tables, lists, paragraphs.
  function mdRender(src) {
    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let para = [];
    const flush = () => { if (para.length) out.push(`<p>${mdInline(para.join(' '))}</p>`); para = []; };
    const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => mdInline(c.trim(), { inTable: true }));
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^```/.test(l)) {
        flush();
        const code = [];
        while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
        out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      } else if (/^#{1,4}\s/.test(l)) {
        flush();
        const n = l.match(/^#+/)[0].length;
        out.push(`<h${n + 1}>${mdInline(l.replace(/^#+\s+/, ''))}</h${n + 1}>`);
      } else if (/^\|/.test(l)) {
        flush();
        const rows = [];
        for (; i < lines.length && /^\|/.test(lines[i]); i++) rows.push(lines[i]);
        i--;
        const body = rows.slice(/^\|?[\s:|-]+$/.test(rows[1] || '') ? 2 : 1);
        out.push(`<div class="table-wrap"><table><thead><tr>${cells(rows[0]).map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${
          body.map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      } else if (/^\s*([-*]|\d+\.)\s/.test(l)) {
        flush();
        const ordered = /^\s*\d+\./.test(l), items = [];
        for (; i < lines.length; i++) {
          const m = lines[i].match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
          if (m) items.push(m[1]);
          else if (/^\s+\S/.test(lines[i]) && items.length) items[items.length - 1] += ` ${lines[i].trim()}`;
          else break;
        }
        i--;
        const tag = ordered ? 'ol' : 'ul';
        out.push(`<${tag}>${items.map((x) => `<li>${mdInline(x)}</li>`).join('')}</${tag}>`);
      } else if (!l.trim()) {
        flush();
      } else {
        para.push(l.trim());
      }
    }
    flush();
    return out.join('\n');
  }

  views.api = async () => {
    if (!apiDoc || Date.now() - apiDoc.at > 600000) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      try {
        const r = await fetch(API_DOC_RAW, { signal: ctl.signal, cache: 'no-cache' });
        if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
        apiDoc = { text: (await r.text()).slice(0, 200000), at: Date.now() };
      } catch (e) {
        if (!apiDoc) {
          return `<div class="page-head"><h1 class="page-title">API</h1></div>
            <div class="panel empty err">Could not load the API description from GitHub. Read it at <a href="${API_DOC_PAGE}" target="_blank" rel="noopener">github.com</a>.</div>`;
        }
      } finally {
        clearTimeout(t);
      }
    }
    return `<div class="page-head"><h1 class="page-title">API</h1>
        <div class="actions"><a class="btn ghost" href="${API_DOC_PAGE}" target="_blank" rel="noopener">View on GitHub</a></div></div>
      <section class="panel md">${mdRender(apiDoc.text)}</section>`;
  };

  // Chart range switch: remembered, then the page re-renders with the new range.
  view.addEventListener('click', (e) => {
    const b = e.target.closest('[data-range]');
    if (!b || !RANGES[b.dataset.range]) return;
    prefs.set(RANGE_KEY, b.dataset.range);
    render(false);
  });
  view.addEventListener('click', (e) => {
    const c = e.target.closest('[data-chart-mode]'), m = e.target.closest('[data-miners-mode]'), one = e.target.closest('[data-miner-mode]');
    if (one && MINERS_MODES[one.dataset.minerMode]) { prefs.set(MINER_MODE_KEY, one.dataset.minerMode); render(false); }
    if (c && MODES[c.dataset.chartMode]) { prefs.set(MODE_KEY, c.dataset.chartMode); render(false); }
    if (m && MINERS_MODES[m.dataset.minersMode]) { prefs.set(MINERS_MODE_KEY, m.dataset.minersMode); render(false); }
  });

  // Copy buttons, on every page. The Clipboard API exists only on https and some in-app
  // browsers refuse it, so fall back to selecting a hidden textarea and execCommand('copy').
  function copyFallback(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }
  view.addEventListener('click', (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    const text = b.dataset.copy;
    const done = (ok) => { b.textContent = ok ? 'copied' : 'failed'; setTimeout(() => (b.textContent = 'copy'), 1500); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(() => done(true), () => done(copyFallback(text)));
    else done(copyFallback(text));
  });

  views.notfound = async () => `<div class="page-head"><h1 class="page-title">Not found</h1></div>
    <div class="panel empty">There is no such page. <a href="/">Back to the pool</a></div>`;

  // ---------- routing: clean paths (/network, /miners/<address>) over the History API ----------
  // The pool server answers every path that is not a file or /api/* with index.html.
  function parse() {
    let p = location.pathname.replace(/^\/+|\/+$/g, '');
    const [route, ...rest] = p ? p.split('/') : ['dashboard'];
    let arg = null;
    try { arg = rest.length ? decodeURIComponent(rest.join('/')) : null; } catch (e) { return { route: 'notfound', arg: null }; }
    if (route === 'dashboard' && p) return { route: 'notfound', arg: null };
    return { route: views[route] && route !== 'notfound' ? route : 'notfound', arg };
  }
  // Same-tab navigation; the query string (?api= on localhost) is kept.
  function go(path) {
    if (path + location.search !== location.pathname + location.search) history.pushState(null, '', path + location.search);
    render(true);
  }

  function markNav(route, arg) {
    const navKey = route === 'miners' && arg ? (cleanAddress(arg) === myAddress() ? 'my' : 'miners') : route;
    document.querySelectorAll('#main-nav a, .cta-top').forEach((a) => a.classList.toggle('active', a.dataset.route === navKey));
  }

  let seq = 0;
  async function render(scrollTop = true) {
    const { route, arg } = parse();
    const my = ++seq;
    markNav(route, arg);
    if (scrollTop && !view.innerHTML) view.innerHTML = '<div class="empty">Loading…</div>';
    try {
      const html = await views[route](arg);
      if (my !== seq) return;
      view.innerHTML = html;
      // a miner page can make its address "my stats" while loading, so mark the tab again
      markNav(route, arg);
      setBanner();
      setFooter();
      if (route === 'connect') bindConnect();
      if (route === 'blocks') bindBlocks();
      if (route === 'miners') bindMinerBlocks();
      if (scrollTop) window.scrollTo(0, 0);
    } catch (e) {
      if (my === seq) view.innerHTML = `<div class="panel empty err">Could not load: ${esc(e.message)}</div>`;
    }
  }

  window.addEventListener('popstate', () => render(true));
  // charts are drawn for the screen width: redraw when a phone turns or a window crosses 700px
  NARROW.addEventListener('change', () => { if (view.querySelector('.chart')) render(false); });
  // Links inside the app change the path without a reload; new tabs, modified clicks and
  // external links behave as usual.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
    e.preventDefault();
    go(url.pathname);
  });
  $('#search').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#search-input'), v = cleanAddress(input.value);
    if (!v) return;
    input.value = '';
    input.blur();
    go(minerHref(v));
  });
  setMyLink();
  // "/" focuses the search, as on GitHub, unless the user is typing somewhere; Esc leaves it.
  window.addEventListener('keydown', (e) => {
    const t = e.target, typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); $('#search-input').focus(); }
    // Esc in a search box: clear it (the results follow), and leave it once it is empty
    else if (e.key === 'Escape' && t && t.tagName === 'INPUT' && (t.id === 'search-input' || t.classList.contains('names-q'))) {
      if (t.value) { t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); } else t.blur();
    }
  });
  // Live refresh every 30 s, except where the user is typing or has loaded more rows.
  setInterval(() => {
    const r = parse().route;
    if (r === 'connect' || r === 'api' || document.hidden || ($('#blocks-body') && $('#blocks-body').dataset.more)) return;
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    if (document.querySelector('.dd.open')) return;
    render(false);
  }, 30000);
  render(true);
})();
