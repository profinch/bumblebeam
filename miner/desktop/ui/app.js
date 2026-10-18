// The tray window. The app sends its whole view every second ("view" event); this only updates
// the elements, so the slider and the text fields are never reset under the user's hand.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);

let v = null;            // the last view
let editing = false;     // the settings screen is open
let dragging = false;    // the power slider is held
let mode = 'pplns';

const fmt = (x, d = 2) => (x == null ? '—' : x.toFixed(d));
const shortAddr = (a) => (a.length > 12 ? `${a.slice(0, 5)}…${a.slice(-5)}` : a);

// --- the power scale: tick labels under the slider's stops (the thumb's centre runs from half a
// thumb in at each end, so the stops are spaced over the track minus one thumb) ---
let ticksWidth = -1;
function layoutTicks() {
  const box = $('ticks');
  const input = $('power');
  const thumb = 16;
  const w = input.clientWidth;
  if (w === ticksWidth || w === 0) return;   // a hidden window has no width yet
  ticksWidth = w;
  box.innerHTML = '';
  // measured, not assumed: where the input starts inside the ticks' box
  const x0 = input.getBoundingClientRect().left - box.getBoundingClientRect().left;
  for (let i = 0; i < 10; i++) {
    const s = document.createElement('span');
    s.textContent = String((i + 1) * 10);
    s.style.left = `${x0 + thumb / 2 + ((w - thumb) * i) / 9}px`;
    box.appendChild(s);
  }
}

function setSliderFill(p) {
  $('power').style.setProperty('--fill', `${((p - 10) / 90) * 100}%`);
  $('power-pct').textContent = `${p}%`;
}

// --- the sparkline ---
function spark(values) {
  const has = values.length > 1;
  $('spark-empty').style.display = has ? 'none' : '';
  if (!has) { $('spark-line').setAttribute('d', ''); $('spark-area').setAttribute('d', ''); return; }
  const max = Math.max(...values, 0.1) * 1.15;
  const pts = values.map((y, i) => [(300 * i) / (values.length - 1), 34 - (34 * y) / max]);
  const line = 'M' + pts.map((p) => p.map((n) => n.toFixed(1)).join(' ')).join(' L');
  $('spark-line').setAttribute('d', line);
  $('spark-area').setAttribute('d', `${line} L300 34 L0 34 Z`);
}

// --- rendering ---
function render() {
  if (!v) return;
  const s = v.settings, m = v.miner, p = v.pool;
  const configured = s.address.trim() !== '';
  $('main').hidden = !configured || editing;
  $('setup').hidden = configured && !editing;
  if (!configured && !editing && $('setup').dataset.first !== '1') openSetup(true);
  if (!$('main').hidden) { renderMain(s, m, p); layoutTicks(); }
}

function renderMain(s, m, p) {
  const running = m.state.kind !== 'stopped';
  const st = m.state.kind;
  // status pill
  const pill = $('pill');
  pill.className = 'pill' + (st === 'noConnection' ? ' warn' : running ? ' on' : '');
  $('pill-text').textContent = { stopped: 'STOPPED', starting: 'STARTING', mining: 'MINING', noConnection: 'NO CONNECTION' }[st];
  // rate card
  $('rate').textContent = (running ? m.rate : 0).toFixed(1);
  $('rate').classList.toggle('off', !running);
  $('pool-rate').textContent = p.workerRate == null ? '—' : p.workerRate.toFixed(1);
  const note = $('card-note');
  if (st === 'noConnection') { note.textContent = m.state.why; note.title = m.state.why; note.className = 'note warn'; }
  else if (p.unreachable) { note.textContent = 'pool site unreachable, figures may be old'; note.title = ''; note.className = 'note warn'; }
  else { note.textContent = s.device === 'gpu' ? (v.gpu ? v.gpu.name : 'GPU') : v.cpuName; note.title = note.textContent; note.className = 'note'; }
  spark(m.history);
  // devices
  $('dev-gpu').classList.toggle('on', s.device === 'gpu');
  $('dev-cpu').classList.toggle('on', s.device === 'cpu');
  $('gpu-detail').textContent = v.gpu ? (v.gpu.solver === 'cuda' ? 'CUDA' : 'OpenCL') : 'CUDA or OpenCL';
  $('cpu-detail').textContent = `${v.cpuThreads} threads`;
  // power
  if (!dragging) {
    $('power').value = s.power;
    setSliderFill(s.power);
  }
  const pn = $('power-note');
  pn.className = 'note mono';
  pn.title = '';
  const shown = dragging ? Number($('power').value) : s.power;
  if (s.device === 'cpu') {
    pn.textContent = `${Math.max(1, Math.round((v.cpuThreads * shown) / 100))} of ${v.cpuThreads} threads`;
  } else if (v.limitMode === 'watts' || (v.limitMode === 'none' && v.limitWatts != null)) {
    const now = v.gpuWatts == null ? '' : ` · ${Math.round(v.gpuWatts)} W now`;
    pn.textContent = v.limitWatts == null ? '' : `${Math.round(v.limitWatts)} W limit${now}`;
  } else if (v.limitMode === 'asking') {
    pn.textContent = 'waiting for permission…';
  } else if (v.limitMode === 'blocks') {
    pn.textContent = 'speed only: power barely drops';
    pn.title = 'Without administrator rights for the GPU power limit the slider runs fewer blocks at once: the speed falls, the draw hardly does';
    pn.className = 'note mono warn';
  } else {
    pn.textContent = v.gpuWatts == null ? '' : `${Math.round(v.gpuWatts)} W now`;
  }
  // tiles
  $('unpaid').textContent = fmt(p.balance);
  $('immature').textContent = fmt(p.immature);
  $('ok').textContent = m.accepted;
  $('bad').textContent = m.rejected;
  $('per-day').textContent = v.perDay == null ? '—' : `≈ ${v.perDay.toFixed(1)}`;
  $('blocks-session').textContent = p.blocksSession;
  $('blocks-session').classList.toggle('lit', p.blocksSession > 0);
  $('hexmark').classList.toggle('lit', p.blocksSession > 0);
  $('blocks-total').textContent = p.blocksTotal == null ? '—' : p.blocksTotal;
  // keep awake: the remembered choice on mains, the session's own on battery
  const aw = $('awake');
  if (document.activeElement !== aw) aw.checked = v.onAc ? s.keepAwake : v.keepAwakeOn;
  // start / stop
  const go = $('go');
  go.textContent = running ? 'Stop mining' : 'Start mining';
  go.classList.toggle('stop', running);
  $('who').textContent = `${shortAddr(s.address)}.${cleanWorker(s.worker)}`;
}

const cleanWorker = (w) => (w.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'bumblebeam');

// --- settings ---
function openSetup(firstRun) {
  if (editing && !firstRun) return;
  const s = v.settings;
  editing = !firstRun;
  $('setup-title').textContent = firstRun ? 'Mine Beam on this computer' : 'Settings';
  $('version').textContent = `v${v.version}`;
  $('address').value = s.address;
  $('worker').value = s.worker;
  mode = s.mode;
  segMode();
  $('show-rate').checked = s.showRate;
  $('at-login').checked = s.startAtLogin;
  $('share-speed').checked = s.shareSpeed;
  $('best-perf').checked = s.bestPerformance;
  $('best-perf-row').hidden = !v.powerModeAvailable;
  $('more').hidden = firstRun;
  $('cancel').hidden = firstRun;
  $('save').textContent = firstRun ? 'Start mining' : 'Save';
  $('main').hidden = true;
  $('setup').hidden = false;
  $('setup').dataset.first = firstRun ? '1' : '';
  checkAddress();
}

function segMode() {
  for (const b of document.querySelectorAll('#mode button')) b.classList.toggle('on', b.dataset.v === mode);
}

const NOTES = {
  empty: ['Use a public offline address from your Beam wallet', ''],
  publicOffline: ['✓ Public offline address', 'ok'],
  offline: ['This is an offline address: use a public offline one', 'warn'],
  maxPrivacy: ['This is a max privacy address: use a public offline one', 'warn'],
  regular: ['This is a regular address: use a public offline one', 'warn'],
  invalid: ['This does not look like a Beam address', 'bad'],
};

async function checkAddress() {
  const t = await invoke('check_address', { address: $('address').value });
  const [text, cls] = NOTES[t];
  $('addr-note').textContent = text;
  $('addr-note').className = 'addr-note ' + cls;
  $('address').classList.toggle('ok', t === 'publicOffline');
  $('save').disabled = t !== 'publicOffline';
}

async function save() {
  const firstRun = v.settings.address.trim() === '';
  const s = { ...v.settings, address: $('address').value.trim(), worker: $('worker').value.trim(), mode,
              showRate: $('show-rate').checked, startAtLogin: $('at-login').checked, shareSpeed: $('share-speed').checked,
              bestPerformance: $('best-perf').checked };
  await invoke('save_settings', { new: s, firstRun });
  editing = false;
  $('setup').dataset.first = '';
  v.settings = s;
  render();
}

// --- wiring ---
function poolPage() {
  return `https://pool.bumblebeam.org/miners/${encodeURIComponent(v.settings.address.trim())}`;
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-url]');
  if (!a) return;
  e.preventDefault();
  invoke('open_url', { url: a.dataset.url === 'pool-page' ? poolPage() : a.dataset.url });
});
$('go').addEventListener('click', () => invoke(v.miner.state.kind === 'stopped' ? 'start' : 'stop'));
for (const b of document.querySelectorAll('.device')) b.addEventListener('click', () => invoke('set_device', { device: b.dataset.device }));
$('power').addEventListener('input', (e) => { dragging = true; setSliderFill(Number(e.target.value)); if (v) renderMain(v.settings, v.miner, v.pool); });
$('power').addEventListener('change', async (e) => { dragging = false; v.settings.power = Number(e.target.value); await invoke('set_power', { power: Number(e.target.value) }); });
$('awake').addEventListener('change', (e) => invoke('set_keep_awake', { on: e.target.checked }));
$('open-settings').addEventListener('click', () => openSetup(false));
$('quit').addEventListener('click', () => invoke('quit'));
$('cancel').addEventListener('click', () => { editing = false; render(); });
$('save').addEventListener('click', save);
$('address').addEventListener('input', checkAddress);
for (const b of document.querySelectorAll('#mode button')) b.addEventListener('click', () => { mode = b.dataset.v; segMode(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (editing) { editing = false; render(); } else invoke('hide'); }
  if (e.key === 'Enter' && !$('setup').hidden && !$('save').disabled) save();
});
document.addEventListener('contextmenu', (e) => { if (!e.target.closest('input')) e.preventDefault(); });

listen('view', (e) => { v = e.payload; render(); });
listen('refresh', async () => { v = await invoke('view'); render(); });
// The logo's parts copied into each <svg class="logo">: through <use> they sit in a shadow tree
// the page's CSS does not reach in WebView2, and the bee never moved
for (const svg of document.querySelectorAll('svg.logo')) {
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.innerHTML = document.getElementById('logo').innerHTML;
}

new ResizeObserver(layoutTicks).observe($('power'));
(async () => {
  v = await invoke('view');
  render();
  layoutTicks();
})();
