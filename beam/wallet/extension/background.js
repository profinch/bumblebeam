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
// the badge, pixel by pixel on a 16-px icon (doubled for 32): a light disc 9 px across in the lower right
// corner, a dark padlock on it. L light, h light at half, S the shackle, D the body, G its lower edge
const BADGE = [
  '..hLLLh..',
  '.hLSSSLh.',
  'hLLSLSLLh',
  'LLLSLSLLL',
  'LLDDDDDLL',
  'LLDDDDDLL',
  'hLDDDDDLh',
  '.hGGGGGh.',
  '..hLLLh..',
];
const INK = { L: [243, 244, 245, 255], h: [243, 244, 245, 140], S: [74, 84, 104, 255], D: [62, 73, 94, 255], G: [110, 119, 134, 255] };
// on the bee itself (icon-128 scaled down)
async function lockedIcon() {
  if (lockedImages) return lockedImages;
  const bee = await createImageBitmap(await (await fetch(chrome.runtime.getURL('icons/icon-128.png'))).blob());
  const out = {};
  for (const n of [16, 32]) {
    const c = new OffscreenCanvas(n, n), g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(bee, 0, 0, n, n);
    const u = n / 16;
    BADGE.forEach((row, y) => [...row].forEach((k, x) => {
      const ink = INK[k]; if (!ink) return;
      g.fillStyle = `rgba(${ink[0]}, ${ink[1]}, ${ink[2]}, ${ink[3] / 255})`;
      g.fillRect((7 + x) * u, (7 + y) * u, u, u);
    }));
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
