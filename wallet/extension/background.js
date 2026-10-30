// BumbleBeam Wallet: the toolbar button opens the wallet in a window of its own (no tabs, no address
// bar), or focuses it if it is open. Not the action popup: Chrome closes that on the first click
// outside, and the wallet (wasm-client: workers, WebSocket, IndexedDB) would stop with it.
// The window keeps the size and place it was last given.
'use strict';

const WALLET = chrome.runtime.getURL('wallet.html');
const DEFAULT_BOUNDS = { width: 520, height: 820 };

chrome.action.onClicked.addListener(async () => {
  // runtime.getContexts finds our own pages without the "tabs" permission
  const [ctx] = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [WALLET] });
  if (ctx) {
    await chrome.windows.update(ctx.windowId, { focused: true, drawAttention: true });
    return;
  }
  const { bounds } = await chrome.storage.local.get('bounds');
  const w = await chrome.windows.create({ url: WALLET, type: 'popup', focused: true, ...(bounds || DEFAULT_BOUNDS) });
  await chrome.storage.session.set({ walletWindow: w.id });
});

chrome.windows.onBoundsChanged.addListener(async (w) => {
  const { walletWindow } = await chrome.storage.session.get('walletWindow');
  if (w.id !== walletWindow || w.state !== 'normal') return;
  await chrome.storage.local.set({ bounds: { left: w.left, top: w.top, width: w.width, height: w.height } });
});
