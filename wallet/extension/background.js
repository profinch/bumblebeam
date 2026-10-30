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

// ensureHost from the popup; get/set from the host, whose offscreen document has chrome.runtime only
const OPS = {
  ensureHost: () => ensureHost(),
  get: (m) => chrome.storage.local.get(m.key).then((v) => v[m.key]),
  set: (m) => chrome.storage.local.set({ [m.key]: m.value }),
};
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !Object.hasOwn(OPS, m?.op)) return;
  OPS[m.op](m).then((result) => reply({ result }), (e) => reply({ error: String(e && e.message || e) }));
  return true;
});

// keep the wallet running across a service-worker restart and from browser start
chrome.runtime.onStartup.addListener(ensureHost);
chrome.runtime.onInstalled.addListener(ensureHost);
