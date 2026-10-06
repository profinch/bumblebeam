// bumblebeam pool web UI: views. No framework, no build step.
'use strict';

(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const view = $('#view');

  // ---------- formatting ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const int = (n) => (n == null || !isFinite(n) ? '—' : Math.round(n).toLocaleString('en-US'));
  function hr(v) {
    if (v == null || !isFinite(v)) return '—';
    if (v >= 1e6) return `${(v / 1e6).toFixed(2)} MSol/s`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(2)} KSol/s`;
    return `${v.toFixed(v < 10 ? 2 : 1)} Sol/s`;
  }
  const beam = (groth, d = 4) => (groth == null ? '—' : `${(groth / BB.GROTH).toLocaleString('en-US', { minimumFractionDigits: d === 4 ? 2 : d, maximumFractionDigits: d })} BEAM`);
  function ago(ts) {
    if (!ts) return '—';
    const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }
  const short = (s, a = 8, b = 6) => (s && s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s || '—');
  const pct = (x, d = 1) => (x == null || !isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`);
  const explorerBlock = (h) => `https://explorer.beam.mw/#/explorer/block/${h}`;

  // ---------- charts ----------
  function sparkline(series, color = '#f25f5b') {
    if (!series || series.length < 2) return '';
    const vs = series.map((p) => p[1]);
    const min = Math.min(...vs), max = Math.max(...vs), span = max - min || 1;
    const pts = vs.map((v, i) => `${((i / (vs.length - 1)) * 90).toFixed(1)},${(20 - ((v - min) / span) * 18).toFixed(1)}`).join(' ');
    return `<svg class="spark" viewBox="0 0 90 22" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.2" vector-effect="non-scaling-stroke"/></svg>`;
  }

  const axis = (v) => (v >= 1e3 ? `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}K` : v.toFixed(v < 10 ? 1 : 0));
  function areaChart(series, { color = '#00f6d2', label = axis } = {}) {
    if (!series || series.length < 2) return '<div class="empty">No data yet</div>';
    const W = 1000, H = 240, L = 78, R = 26, T = 12, B = 26;
    const t0 = series[0][0], t1 = series[series.length - 1][0];
    const max = Math.max(...series.map((p) => p[1])) * 1.12 || 1;
    const x = (t) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R);
    const y = (v) => T + (1 - v / max) * (H - T - B);
    const line = series.map((p) => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' L');
    let grid = '';
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i, yy = y(v).toFixed(1);
      grid += `<line class="grid" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/><text x="${L - 8}" y="${+yy + 3}" text-anchor="end">${label(v)}</text>`;
    }
    for (let i = 0; i <= 6; i++) {
      const t = t0 + ((t1 - t0) / 6) * i;
      const d = new Date(t * 1000);
      grid += `<text x="${x(t).toFixed(1)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === 6 ? 'end' : 'middle'}">${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}</text>`;
    }
    const id = `g${Math.random().toString(36).slice(2, 8)}`;
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Hashrate, last 24 hours">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity="0.35"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
      ${grid}
      <path d="M${line} L${x(t1).toFixed(1)},${y(0)} L${x(t0).toFixed(1)},${y(0)} Z" fill="url(#${id})"/>
      <path d="M${line}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>
    </svg>`;
  }

  // ---------- shared pieces ----------
  const tile = (k, v, s = '', cls = '') => `<div class="tile"><div class="k">${k}</div><div class="v ${cls}">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
  const statusBadge = (b) => b.status === 'confirmed' ? '<span class="badge ok">confirmed</span>'
    : b.status === 'orphaned' ? '<span class="badge bad">orphaned</span>'
    : `<span class="badge pending">${Math.min(b.confirmations, BB.MATURITY)}/${BB.MATURITY}</span>`;
  const modeBadge = (m) => (m === 'solo' ? '<span class="badge solo">solo</span>' : '<span class="badge ok">pplns</span>');

  function blocksTable(blocks) {
    if (!blocks.length) return '<div class="empty">No blocks found yet</div>';
    return `<div class="table-wrap"><table><thead><tr><th>Height</th><th>Found</th><th>Mode</th><th class="num">Reward</th><th class="num">Effort</th><th>Finder</th><th class="num">Status</th></tr></thead><tbody>
      ${blocks.map((b) => `<tr>
        <td><a href="${explorerBlock(b.height)}" target="_blank" rel="noopener">${int(b.height)}</a></td>
        <td class="dim">${ago(b.ts)}</td><td>${modeBadge(b.mode)}</td>
        <td class="num">${beam(b.reward + (b.fees || 0), 3)}</td>
        <td class="num" style="color:${b.effort > 1.5 ? 'var(--color-red)' : b.effort < 0.7 ? 'var(--accent)' : 'inherit'}">${pct(b.effort, 0)}</td>
        <td class="dim">${esc(b.finder || '—')}</td><td class="num">${statusBadge(b)}</td></tr>`).join('')}
    </tbody></table></div>`;
  }

  function netMeta(net) {
    if (!net || !net.ok) return '<span class="err">network data unavailable</span>';
    return `<span>Network hashrate: <b>${hr(net.hashrate)}</b></span><span>Block: <b>${int(net.height)}</b></span>
      <span>Diff: <b>${net.difficulty ? (net.difficulty / 1e6).toFixed(2) + 'M' : '—'}</b></span>
      <span>Avg block: <b>${net.avgBlock ? net.avgBlock.toFixed(1) + 's' : '—'}</b></span>`;
  }

  function setBanner() { $('#demo-banner').hidden = BB.mode !== 'demo'; }

  // ---------- views ----------
  const views = {};

  views.dashboard = async () => {
    const [stats, blocks, net] = await Promise.all([BB.pool('stats'), BB.pool('blocks?limit=8'), BB.network().catch(() => null)]);
    const share = net && net.hashrate ? stats.hashrate / net.hashrate : null;
    const expectedPerDay = share != null ? share * 1440 : null;
    return `
      <div class="page-head"><h1 class="page-title">Pool</h1>
        <div class="actions"><a class="btn" href="#/connect">Start mining</a></div></div>
      <div class="tiles">
        ${tile('Pool hashrate', hr(stats.hashrate), share != null ? `${pct(share, 2)} of the network` : '', 'accent')}
        ${tile('Miners / workers', `${int(stats.minersTotal)} / ${int(stats.workersTotal)}`)}
        ${tile('Blocks 24h', int(stats.blocks24h), expectedPerDay ? `expected ${expectedPerDay.toFixed(1)} · luck ${pct(stats.luck24h, 0)}` : '')}
        ${tile('Last block', ago(stats.stats && stats.stats.lastBlockFound))}
        ${tile('Fee', `${stats.config.fee}%`, `${stats.config.payoutScheme} · solo ${stats.config.soloFee}%`)}
        ${tile('Min payout', beam(stats.config.minPayout, 2), `after ${stats.config.maturity} confirmations`)}
      </div>
      <div class="grid2">
        <section class="panel">
          <div class="panel-head"><h2 class="panel-title">Pool hashrate · 24h</h2><div class="panel-meta">${netMeta(net)}</div></div>
          ${areaChart(stats.charts && stats.charts.hashrate)}
        </section>
        <section class="panel">
          <div class="panel-head"><h2 class="panel-title">Why this pool</h2></div>
          <div class="stack" style="gap:10px;font-size:13px;color:var(--text-dim);line-height:1.5">
            <div><b style="color:var(--accent)">Open source.</b> Server, share checks and payouts are public code.</div>
            <div><b style="color:var(--accent)">${stats.config.fee}% fee</b>, PPLNS or solo on the same server.</div>
            <div><b style="color:var(--accent)">Checkable.</b> Every block and payout links to the chain.</div>
            <div><b style="color:var(--accent)">Decentralises Beam.</b> One pool holds ${net && net.pools[0] && net.hashrate ? pct(net.pools[0].hashrate / net.hashrate, 0) : 'most'} of the network today.</div>
          </div>
        </section>
      </div>
      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">Recent blocks</h2><div class="panel-meta"><a href="#/blocks">all blocks →</a></div></div>
        ${blocksTable(blocks.blocks)}
      </section>
      ${await networkPanel(stats, net)}`;
  };

  async function networkPanel(stats, net) {
    if (!net || !net.ok) return '<section class="panel"><div class="empty err">Network data unavailable</div></section>';
    const rows = net.pools.map((p) => ({ ...p, ours: false }));
    rows.push({ id: 'bumblebeam', name: 'bumblebeam', scheme: 'PPLNS', fee: stats.config.fee, hashrate: stats.hashrate, miners: stats.minersTotal,
      workers: stats.workersTotal, blocks24h: stats.blocks24h, lastTs: stats.stats && stats.stats.lastBlockFound, series: (stats.charts.hashrate || []).filter((_, i) => i % 6 === 0), ours: true });
    rows.sort((a, b) => b.hashrate - a.hashrate);
    const total = net.hashrate || rows.reduce((s, r) => s + r.hashrate, 0);
    return `<section class="panel" id="network">
      <div class="panel-head"><h2 class="panel-title">Beam mining pools</h2><div class="panel-meta">${netMeta(net)}<span>Blocks 24h: <b>${int(net.blocks24h)}</b></span></div></div>
      <div class="table-wrap"><table><thead><tr><th>#</th><th>Pool</th><th>Hashrate</th><th class="num">Share</th><th class="num">Miners</th><th class="num">Workers</th><th class="num">Blocks 24h</th><th class="num">Last found</th><th></th></tr></thead><tbody>
      ${rows.map((p, i) => `<tr class="${p.ours ? 'ours' : ''}">
        <td class="dim">${i + 1}</td>
        <td><span class="name">${esc(p.name)}</span><span class="sub">${p.fee != null ? p.fee + '%' : ''} ${esc(p.scheme || '')}${p.ours && BB.mode === 'demo' ? ' · demo' : ''}</span></td>
        <td><div class="hashcell"><span>${hr(p.hashrate)}</span>${sparkline(p.series, p.ours ? '#00f6d2' : '#f25f5b')}</div>
            <div class="bar ${p.ours ? 'accent' : ''}"><i style="width:${Math.min(100, (p.hashrate / total) * 100).toFixed(1)}%"></i></div></td>
        <td class="num">${pct(p.hashrate / total, 1)}</td>
        <td class="num">${int(p.miners)}</td><td class="num">${int(p.workers)}</td><td class="num">${p.blocks24h == null ? '—' : int(p.blocks24h)}</td>
        <td class="num dim">${ago(p.lastTs)}</td><td><span class="dot ${p.hashrate ? '' : 'off'}"></span></td></tr>`).join('')}
      </tbody></table></div></section>`;
  }

  views.network = async () => {
    const [stats, net] = await Promise.all([BB.pool('stats'), BB.network().catch(() => null)]);
    let recent = '';
    try {
      const bl = await BB.networkBlocks(30);
      recent = `<section class="panel"><div class="panel-head"><h2 class="panel-title">Latest network blocks</h2></div>
        <div class="table-wrap"><table><thead><tr><th>Height</th><th>Time</th><th>Mined by</th></tr></thead><tbody>
        ${bl.map((b) => `<tr><td><a href="${explorerBlock(b.height)}" target="_blank" rel="noopener">${int(b.height)}</a></td><td class="dim">${ago(b.ts)}</td><td>${b.by ? esc(b.by) : '<span class="dim">unknown</span>'}</td></tr>`).join('')}
        </tbody></table></div></section>`;
    } catch (e) { recent = ''; }
    return `<div class="page-head"><h1 class="page-title">Network</h1></div>${await networkPanel(stats, net)}${recent}`;
  };

  views.blocks = async () => {
    const [{ blocks }, stats] = await Promise.all([BB.pool('blocks?limit=200'), BB.pool('stats')]);
    const day = blocks.filter((b) => b.ts > Date.now() / 1000 - 86400);
    const avgEffort = day.length ? day.reduce((s, b) => s + b.effort, 0) / day.length : null;
    return `<div class="page-head"><h1 class="page-title">Blocks</h1></div>
      <div class="tiles">
        ${tile('Blocks 24h', int(day.length))}
        ${tile('Average effort 24h', pct(avgEffort, 0), 'below 100% is good luck')}
        ${tile('Pending', int(blocks.filter((b) => b.status === 'pending').length), `${BB.MATURITY} confirmations to mature`)}
        ${tile('Orphaned', int(blocks.filter((b) => b.status === 'orphaned').length), 'last 3 days')}
      </div>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Found blocks</h2><div class="panel-meta"><span>Reward: <b>${beam(stats.config.blockReward, 0)}</b> + fees</span></div></div>
      ${blocksTable(blocks)}</section>`;
  };

  views.miners = async (arg) => {
    if (arg) return minerView(arg);
    const [{ miners }, stats] = await Promise.all([BB.pool('miners?limit=50'), BB.pool('stats')]);
    return `<div class="page-head"><h1 class="page-title">Miners</h1></div>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Top miners</h2><div class="panel-meta"><span>Total: <b>${int(stats.minersTotal)}</b></span></div></div>
      <div class="table-wrap"><table><thead><tr><th>#</th><th>Address</th><th>Hashrate</th><th class="num">24h avg</th><th class="num">Share</th><th class="num">Workers</th><th class="num">Last share</th></tr></thead><tbody>
      ${miners.map((m, i) => `<tr><td class="dim">${i + 1}</td>
        <td><a href="#/miners/${encodeURIComponent(m.address)}">${esc(short(m.address, 10, 8))}</a></td>
        <td>${hr(m.hashrate)}<div class="bar accent"><i style="width:${Math.min(100, (m.hashrate / miners[0].hashrate) * 100).toFixed(1)}%"></i></div></td>
        <td class="num">${hr(m.hashrate24h)}</td><td class="num">${pct(m.hashrate / stats.hashrate, 2)}</td>
        <td class="num">${int(m.workers)}</td><td class="num dim">${ago(m.lastShare)}</td></tr>`).join('')}
      </tbody></table></div></section>`;
  };

  async function minerView(address) {
    const m = await BB.pool(`miners/${encodeURIComponent(address)}`);
    return `<div class="page-head"><h1 class="page-title">Miner</h1><div class="actions"><a class="btn ghost" href="#/miners">← all miners</a></div></div>
      <div class="panel" style="font:12px var(--font-mono);word-break:break-all;color:var(--text-dim)">${esc(m.address)}</div>
      <div class="tiles">
        ${tile('Hashrate', hr(m.hashrate), `24h avg ${hr(m.hashrate24h)}`, 'accent')}
        ${tile('Balance', beam(m.balance), 'paid out at the next run')}
        ${tile('Immature', beam(m.immature), 'blocks still confirming')}
        ${tile('Paid', beam(m.paid, 2))}
        ${tile('Last share', ago(m.lastShare))}
      </div>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Hashrate · 24h</h2></div>${areaChart(m.charts && m.charts.hashrate)}</section>
      <div class="grid2">
        <section class="panel"><div class="panel-head"><h2 class="panel-title">Workers</h2></div>
          ${m.workers.length ? `<div class="table-wrap"><table><thead><tr><th></th><th>Worker</th><th class="num">Hashrate</th><th class="num">24h avg</th><th class="num">Last share</th></tr></thead><tbody>
          ${m.workers.map((w) => `<tr><td><span class="dot ${w.online ? '' : 'off'}"></span></td><td>${esc(w.name)}</td><td class="num">${hr(w.hashrate)}</td><td class="num">${hr(w.hashrate24h)}</td><td class="num dim">${ago(w.lastShare)}</td></tr>`).join('')}
          </tbody></table></div>` : '<div class="empty">No workers</div>'}
        </section>
        <section class="panel"><div class="panel-head"><h2 class="panel-title">Payments</h2></div>
          ${m.payments.length ? `<div class="table-wrap"><table><thead><tr><th>Time</th><th class="num">Amount</th><th>Kernel</th></tr></thead><tbody>
          ${m.payments.map((p) => `<tr><td class="dim">${ago(p.ts)}</td><td class="num">${beam(p.amount)}</td><td class="dim">${esc(short(p.kernel))}</td></tr>`).join('')}
          </tbody></table></div>` : '<div class="empty">No payments yet</div>'}
        </section>
      </div>`;
  }

  views.payments = async () => {
    const { payments } = await BB.pool('payments?limit=50');
    const day = payments.filter((p) => p.ts > Date.now() / 1000 - 86400);
    return `<div class="page-head"><h1 class="page-title">Payments</h1></div>
      <div class="tiles">${tile('Paid 24h', beam(day.reduce((s, p) => s + p.amount, 0), 2))}${tile('Payout runs 24h', int(day.length), 'every 2 hours')}${tile('Min payout', beam(0.1 * BB.GROTH, 2))}</div>
      <section class="panel"><div class="panel-head"><h2 class="panel-title">Payout transactions</h2></div>
      <div class="table-wrap"><table><thead><tr><th>Time</th><th class="num">Amount</th><th class="num">Miners</th><th>Kernel</th></tr></thead><tbody>
      ${payments.map((p) => `<tr><td class="dim">${ago(p.ts)}</td><td class="num">${beam(p.amount, 2)}</td><td class="num">${int(p.miners)}</td><td class="dim mono">${esc(short(p.kernel, 12, 12))}</td></tr>`).join('')}
      </tbody></table></div></section>`;
  };

  views.connect = async () => {
    const [stats, net] = await Promise.all([BB.pool('stats'), BB.network().catch(() => null)]);
    const host = BB.stratumHost();
    return `<div class="page-head"><h1 class="page-title">Start mining</h1></div>
      <div class="grid2">
        <section class="panel" id="guide"><div class="panel-head"><h2 class="panel-title">Connect in three steps</h2></div>
          <div class="steps">
            <div class="step"><h3>Get a Beam wallet address</h3><p>Any Beam wallet works: desktop, mobile or CLI. Payouts go to this address.</p>
              <div class="row"><label class="field" style="flex:1;min-width:240px">Wallet address<input id="addr" placeholder="paste your address" spellcheck="false"></label>
              <label class="field">Worker<input id="worker" value="rig1" style="width:110px"></label></div></div>
            <div class="step"><h3>Pick a mode</h3><p>PPLNS shares every block found by the pool. Solo pays you the whole block, only when you find it.</p>
              <div class="seg" id="mode"><button class="on" data-v="pplns">PPLNS</button><button data-v="solo">Solo</button></div>
              <div class="seg" id="tls" style="margin-left:8px"><button class="on" data-v="0">TCP</button><button data-v="1">TLS</button></div></div>
            <div class="step"><h3>Run your miner</h3><p>Any BeamHash III miner. NVIDIA or AMD with 3 GB or more.</p>
              <div class="stack" id="cmds" style="gap:8px"></div></div>
          </div>
        </section>
        <section class="panel" id="calc"><div class="panel-head"><h2 class="panel-title">Calculator</h2><div class="panel-meta"><span>live network</span></div></div>
          <div class="row">
            <label class="field" style="flex:1">Your hashrate, Sol/s<input id="sols" type="number" min="0" step="1" value="52"></label>
            <label class="field">Card<select id="card"><option value="52">RTX 3090 · 52</option><option value="46.5">RTX 3080 · 46.5</option><option value="34">RTX 3070 · 34</option><option value="">custom</option></select></label>
          </div>
          <div class="calc-out" id="calc-out"></div>
          <p class="dim" style="font-size:11px;margin:14px 0 0;line-height:1.5">Card figures are lolMiner rates published by WhatToMine; measure your own. Uses network hashrate ${hr(net && net.hashrate)}, ${BB.BLOCK_REWARD / BB.GROTH} BEAM per block plus fees, ${stats.config.fee}% pool fee.</p>
        </section>
      </div>
      <section class="panel" id="ports"><div class="panel-head"><h2 class="panel-title">Stratum ports</h2></div>
        <div class="table-wrap"><table><thead><tr><th>Port</th><th>Mode</th><th>TLS</th><th>Login</th></tr></thead><tbody>
          <tr><td>3333</td><td>${modeBadge('pplns')}</td><td class="dim">no</td><td class="dim">&lt;address&gt;.&lt;worker&gt;</td></tr>
          <tr><td>3334</td><td>${modeBadge('solo')}</td><td class="dim">no</td><td class="dim">&lt;address&gt;.&lt;worker&gt;</td></tr>
          <tr><td>3443</td><td>${modeBadge('pplns')}</td><td>yes</td><td class="dim">&lt;address&gt;.&lt;worker&gt;</td></tr>
          <tr><td>3444</td><td>${modeBadge('solo')}</td><td>yes</td><td class="dim">&lt;address&gt;.&lt;worker&gt;</td></tr>
        </tbody></table></div></section>
      <section class="panel" id="api"><div class="panel-head"><h2 class="panel-title">API</h2><div class="panel-meta"><a href="https://github.com/profinch/bumblebeam/blob/main/pool/API.md">pool/API.md →</a></div></div>
        <div class="table-wrap"><table><tbody>
          <tr><td>/api/stats</td><td class="dim">pool totals; open-ethereum-pool compatible, so explorers read it as is</td></tr>
          <tr><td>/api/blocks</td><td class="dim">found blocks with effort and confirmations</td></tr>
          <tr><td>/api/miners/&lt;address&gt;</td><td class="dim">hashrate, workers, balance, payments</td></tr>
          <tr><td>/api/payments</td><td class="dim">payout transactions with their kernel IDs</td></tr>
        </tbody></table></div></section>
      <template id="ctx" data-host="${esc(host)}" data-net="${net && net.hashrate ? net.hashrate : ''}" data-fee="${stats.config.fee}"></template>`;
  };

  function bindConnect() {
    const ctx = $('#ctx');
    if (!ctx) return;
    const host = ctx.dataset.host, netHash = Number(ctx.dataset.net), fee = Number(ctx.dataset.fee) / 100;
    const state = { mode: 'pplns', tls: '0' };
    const seg = (id, key) => $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      state[key] = b.dataset.v;
      [...$(id).children].forEach((x) => x.classList.toggle('on', x === b));
      render();
    });
    function render() {
      const port = state.mode === 'solo' ? (state.tls === '1' ? 3444 : 3334) : (state.tls === '1' ? 3443 : 3333);
      const user = `${$('#addr').value.trim() || '<address>'}.${$('#worker').value.trim() || 'rig1'}`;
      const tlsFlag = state.tls === '1';
      const cmds = [
        ['lolMiner', `lolMiner --algo BEAM-III --pool ${host}:${port} --user ${user}${tlsFlag ? ' --tls on' : ''}`],
        ['GMiner', `miner --algo beamhashIII --server ${host}:${port} --user ${user}${tlsFlag ? ' --ssl 1' : ''}`],
      ];
      $('#cmds').innerHTML = cmds.map(([n, c]) => `<div><div class="dim mono" style="font-size:10px;margin-bottom:4px">${n}</div><div class="code"><pre>${esc(c)}</pre><button class="btn small" data-copy="${esc(c)}">copy</button></div></div>`).join('');
    }
    function calc() {
      const sols = Number($('#sols').value) || 0;
      const out = $('#calc-out');
      if (!netHash) { out.innerHTML = '<div class="empty err">Network hashrate unavailable</div>'; return; }
      const share = sols / (netHash + sols);
      const perDay = share * 1440 * (BB.BLOCK_REWARD / BB.GROTH) * (1 - fee);
      const soloHours = sols ? 1 / (share * 60) : Infinity;
      out.innerHTML = tile('Per day', `${perDay.toFixed(2)} BEAM`, 'PPLNS, average', 'accent') + tile('Per month', `${(perDay * 30).toFixed(0)} BEAM`)
        + tile('Network share', pct(share, 3)) + tile('Solo: one block every', isFinite(soloHours) ? (soloHours < 48 ? `${soloHours.toFixed(1)} h` : `${(soloHours / 24).toFixed(1)} d`) : '—', 'on average; luck varies a lot');
    }
    seg('#mode', 'mode');
    seg('#tls', 'tls');
    $('#addr').addEventListener('input', render);
    $('#worker').addEventListener('input', render);
    $('#sols').addEventListener('input', () => { $('#card').value = ''; calc(); });
    $('#card').addEventListener('change', () => { if ($('#card').value) $('#sols').value = $('#card').value; calc(); });
    view.addEventListener('click', (e) => {
      const b = e.target.closest('[data-copy]');
      if (!b) return;
      navigator.clipboard.writeText(b.dataset.copy).then(() => { b.textContent = 'copied'; setTimeout(() => (b.textContent = 'copy'), 1200); }, () => {});
    });
    render();
    calc();
  }

  // ---------- routing ----------
  const SUB = {
    dashboard: [['Overview', '#/'], ['Network', '#/network']],
    network: [['Overview', '#/'], ['Network', '#/network']],
    connect: [['Guide', '#/connect'], ['Calculator', '#/connect#calc'], ['Ports', '#/connect#ports'], ['API', '#/connect#api']],
  };
  const MAIN = { dashboard: 'dashboard', network: 'dashboard', blocks: 'blocks', miners: 'miners', payments: 'payments', connect: 'connect' };

  function parse() {
    const h = location.hash.replace(/^#\/?/, '');
    const [pathPart, anchor] = h.split('#');
    const [route, ...rest] = pathPart.split('/');
    return { route: views[route] ? route : 'dashboard', arg: rest.length ? decodeURIComponent(rest.join('/')) : null, anchor };
  }

  let seq = 0;
  async function render(scrollTop = true) {
    const { route, arg, anchor } = parse();
    const my = ++seq;
    document.querySelectorAll('#main-nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === MAIN[route]));
    const sub = SUB[route] || [];
    const cur = location.hash || '#/';
    $('#sub-nav').innerHTML = sub.map(([n, href]) => `<a href="${href}" class="${href === cur || (href === '#/' && cur === '#') ? 'active' : ''}">${n}</a>`).join('');
    if (scrollTop && !view.innerHTML) view.innerHTML = '<div class="empty">Loading…</div>';
    try {
      const html = await views[route](arg);
      if (my !== seq) return;
      view.innerHTML = html;
      setBanner();
      if (route === 'connect') bindConnect();
      if (anchor) { const el = document.getElementById(anchor); if (el) el.scrollIntoView({ behavior: 'smooth' }); }
      else if (scrollTop) window.scrollTo(0, 0);
    } catch (e) {
      if (my === seq) view.innerHTML = `<div class="panel empty err">Could not load: ${esc(e.message)}</div>`;
    }
  }

  window.addEventListener('hashchange', () => render(true));
  $('#search').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#search-input').value.trim();
    if (v) location.hash = `#/miners/${encodeURIComponent(v)}`;
  });
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#search-input').focus(); }
  });
  // Live refresh, except on the connect page where the user is typing.
  setInterval(() => { if (parse().route !== 'connect' && !document.hidden) render(false); }, 30000);
  render(true);
})();
