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
  // a Beam backup file from the popup: saved here, so it completes even if the popup closes (Chrome's
  // download bubble takes the focus from the popup)
  // Saved into Downloads/BumbleBeam/ without asking; the answer comes once the file is complete on disk (an
  // interrupted one is an error), with its download id (to show it in its folder later)
  download: (m) => {
    if (!/^[\w.-]{1,120}$/.test(String(m.name)) || typeof m.b64 !== 'string') return Promise.reject(new Error('bad file'));
    return new Promise((res, rej) => {
      let id = null;
      const done = (d) => {
        if (d.id !== id || !d.state) return;
        if (d.state.current === 'complete') { chrome.downloads.onChanged.removeListener(done); res({ id }); }
        else if (d.state.current === 'interrupted') { chrome.downloads.onChanged.removeListener(done); rej(new Error(`not saved: ${(d.error && d.error.current) || 'interrupted'}`)); }
      };
      chrome.downloads.onChanged.addListener(done);
      chrome.downloads.download({ url: `data:application/octet-stream;base64,${m.b64}`, filename: `BumbleBeam/${m.name}`, saveAs: false, conflictAction: 'uniquify' })
        .then((d) => { id = d; chrome.downloads.search({ id: d }).then(([x]) => { if (x && x.state === 'complete') { chrome.downloads.onChanged.removeListener(done); res({ id: d }); } else if (x && x.state === 'interrupted') { chrome.downloads.onChanged.removeListener(done); rej(new Error(`not saved: ${x.error || 'interrupted'}`)); } }); }, (e) => { chrome.downloads.onChanged.removeListener(done); rej(e); });
    });
  },
  // the window where a site's request is answered (one; a second request shows in it too)
  // (its id kept in session storage: this worker sleeps and forgets)
  dappWindow: async (m) => {
    const { dappWin } = await chrome.storage.session.get('dappWin');
    if (dappWin != null) { try { await chrome.windows.update(dappWin, { focused: true }); return dappWin; } catch {} }
    // at the right of the browser window the user is in, under its toolbar (where the extension's icon is)
    const W = 400, H = 640;
    let at = {};
    try {
      // the window of the site's own tab (as Chrome gave it), else the last one in use
      const cur = (m && m.near != null ? await chrome.windows.get(m.near).catch(() => null) : null) || await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      // no clamping at 0: a screen left of (or above) the main one has negative coordinates
      if (cur && cur.left != null) at = { left: cur.left + cur.width - W - 12, top: cur.top + 80 };
    } catch {}
    // a place Chrome refuses (off the visible screen: a minimised window, an odd layout) must not cost the
    // window itself: then it opens where Chrome puts it
    const make = (pos) => chrome.windows.create({ url: chrome.runtime.getURL('popup.html?win=1'), type: 'popup', width: W, height: H, focused: true, ...pos });
    let w;
    try { w = await make(at); } catch { at = {}; w = await make({}); }
    // Chrome may place a new window on another screen (screens with different scaling): put it where it belongs
    if (at.left != null) chrome.windows.update(w.id, at).catch(() => {});
    await chrome.storage.session.set({ dappWin: w.id });
    return w.id;
  },
  // the toolbar icon: the bee, or the bee in grey while locked
  icon: (m) => { wantLocked = !!m.locked; return applyIcon(); },
};

// a closed window: the host knows whether it was its request window
chrome.windows.onRemoved.addListener((id) => { chrome.runtime.sendMessage({ op: 'dappClosed', windowId: id }).catch(() => {}); });
const ICONS = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' };
// set as soon as the host says (the open popup stays open through the change)
let wantLocked = null;
const applyIcon = () => (wantLocked ? lockedIcon().then((imageData) => chrome.action.setIcon({ imageData })) : chrome.action.setIcon({ path: ICONS }));
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
// Who may ask: the extension's own pages (popup, the dApp window, the host) for every op; a content script, which
// runs inside a site's page and carries the extension's id too, only for ensureHost. A site that took over its own
// renderer could otherwise read or overwrite the vault through get/set.
const ownPage = (sender) => sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !Object.hasOwn(OPS, m?.op)) return;
  if (m.op !== 'ensureHost' && !ownPage(sender)) return;
  OPS[m.op](m).then((result) => reply({ result }), (e) => reply({ error: String(e && e.message || e) }));
  return true;
});

// the stored vault out of content scripts' reach (local storage is open to them by default)
chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});

// keep the wallet running across a service-worker restart and from browser start (locked: the host sets the icon)
chrome.runtime.onStartup.addListener(ensureHost);
chrome.runtime.onInstalled.addListener(ensureHost);
