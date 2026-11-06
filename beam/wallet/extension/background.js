// BumbleBeam Wallet: the service worker only starts the wallet host. The wallet runs in an offscreen
// document (offscreen.html): wasm-client needs workers and IndexedDB, which a service worker lacks,
// and the action popup cannot hold it either: Chrome closes the popup on the first click outside.
'use strict';

const HOST = 'offscreen.html';
let creating = null;

async function ensureHost() {
  if (await chrome.offscreen.hasDocument()) return;
  creating ??= chrome.offscreen.createDocument({
    url: HOST,
    reasons: ['WORKERS'],
    justification: "Runs the Beam wallet (Beam's wasm-client and its worker threads) while the popup is closed.",
  }).finally(() => { creating = null; });
  await creating;
}

// ensureHost from the popup; get/set/badge from the host, whose offscreen document has chrome.runtime only
const OPS = {
  ensureHost: () => ensureHost(),
  get: (m) => chrome.storage.local.get(m.key).then((v) => v[m.key]),
  set: (m) => chrome.storage.local.set({ [m.key]: m.value }),
  // the toolbar icon's badge: bridge messages waiting to be claimed
  badge: (m) => Promise.all([chrome.action.setBadgeText({ text: m.text || '' }), chrome.action.setBadgeBackgroundColor({ color: '#00f6d2' })]),
  // the toolbar icon: the bee, or the bee with a lock in a round badge at its lower right while locked
  icon: (m) => (m.locked ? lockedIcon().then((imageData) => chrome.action.setIcon({ imageData })) : chrome.action.setIcon({ path: ICONS })),
};

const ICONS = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' };
let lockedImages = null;
// drawn here, on the bee itself (icon-128 scaled down): a light ring, a dark disc, a padlock with a light shackle
async function lockedIcon() {
  if (lockedImages) return lockedImages;
  const bee = await createImageBitmap(await (await fetch(chrome.runtime.getURL('icons/icon-128.png'))).blob());
  const out = {};
  for (const n of [16, 32]) {
    const c = new OffscreenCanvas(n, n), g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(bee, 0, 0, n, n);
    const u = n / 16, cx = 11.6 * u, cy = 11.6 * u, r = 4.4 * u;
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fillStyle = '#e8ebf0'; g.fill();
    g.beginPath(); g.arc(cx, cy, r - 0.9 * u, 0, Math.PI * 2); g.fillStyle = '#2c3342'; g.fill();
    // the padlock: a shackle arc over a body
    g.strokeStyle = '#e8ebf0'; g.lineWidth = 0.9 * u; g.lineCap = 'round';
    g.beginPath(); g.arc(cx, cy - 0.7 * u, 1.25 * u, Math.PI, 0); g.lineTo(cx + 1.25 * u, cy); g.moveTo(cx - 1.25 * u, cy - 0.7 * u); g.lineTo(cx - 1.25 * u, cy); g.stroke();
    g.fillStyle = '#5a6378'; g.lineWidth = 0.7 * u;
    g.beginPath(); g.roundRect(cx - 2.0 * u, cy - 0.1 * u, 4.0 * u, 2.8 * u, 0.6 * u); g.fill(); g.stroke();
    out[n] = g.getImageData(0, 0, n, n);
  }
  return (lockedImages = out);
}
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !Object.hasOwn(OPS, m?.op)) return;
  OPS[m.op](m).then((result) => reply({ result }), (e) => reply({ error: String(e && e.message || e) }));
  return true;
});

// keep the wallet running across a service-worker restart and from browser start (locked: the host sets the icon)
chrome.runtime.onStartup.addListener(ensureHost);
chrome.runtime.onInstalled.addListener(ensureHost);
