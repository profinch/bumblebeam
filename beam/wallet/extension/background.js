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
  // the toolbar icon: the bee, or the bee in grey while locked
  icon: (m) => { wantLocked = !!m.locked; return applyIcon(); },
};

const ICONS = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' };
// Chrome closes the action popup when the icon under it changes: while the popup is open the change waits,
// and is made once it is closed (checked each second)
let wantLocked = null, shownLocked = null, waiting = 0;
const popupOpen = async () => (await chrome.runtime.getContexts({ contextTypes: ['POPUP'] })).length > 0;
async function applyIcon() {
  if (wantLocked === null || wantLocked === shownLocked) return;
  if (await popupOpen()) { waiting ||= setInterval(() => applyIcon().catch(() => {}), 1000); return; }
  clearInterval(waiting); waiting = 0;
  const locked = wantLocked;
  await (locked ? lockedIcon().then((imageData) => chrome.action.setIcon({ imageData })) : chrome.action.setIcon({ path: ICONS }));
  shownLocked = locked;
}
let lockedImages = null;
// locked: the same bee, grey and dimmed (asleep); nothing drawn over it
async function lockedIcon() {
  if (lockedImages) return lockedImages;
  const bee = await createImageBitmap(await (await fetch(chrome.runtime.getURL('icons/icon-128.png'))).blob());
  const out = {};
  for (const n of [16, 32]) {
    const g = new OffscreenCanvas(n, n).getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(bee, 0, 0, n, n);
    const img = g.getImageData(0, 0, n, n), d = img.data;
    for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = Math.round((0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) * 0.55);
    out[n] = img;
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
