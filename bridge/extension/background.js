// BumbleBeam Bridge: the toolbar button opens the wallet tab, or focuses it if it is open.
// The wallet itself runs in that tab (wasm-client needs a page: workers, WebSocket, IndexedDB).
'use strict';

const WALLET = chrome.runtime.getURL('wallet.html');

chrome.action.onClicked.addListener(async () => {
  // runtime.getContexts finds our own pages without the "tabs" permission
  const [ctx] = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [WALLET] });
  if (ctx) {
    await chrome.tabs.update(ctx.tabId, { active: true });
    await chrome.windows.update(ctx.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: WALLET });
  }
});
