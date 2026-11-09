# BumbleBeam Wallet: changes

## 0.3.0 (2026-11-09)

### dApps
- Websites connect to the wallet. On Ethereum mainnet through EIP-1193 and EIP-6963, so a site finds
  BumbleBeam Wallet in its list of wallets. On Beam through the web wallet's own protocol (`create_beam_api`,
  `window.BeamApi`), so Beam's sites (DEX, NFT Gallery, BANS, Minter, Faucet) work with it.
- Every request is approved in a window of its own, at the right of the site's browser window. It shows the
  account (name, then the whole address), and for a contract transaction what the wallet itself reads from it:
  the amounts by the assets' names, the asset ids, the fee.
- `wallet_getCapabilities` is answered as EIP-5792 wants it (Ethereum mainnet, no atomic batches).
- While the wallet is locked a site sees no account, its Beam calls are refused, and a request opens the
  window on the password first. Closing the window says no.
- A request made while the window was closing itself got no window and was refused: now it gets one. A site's
  pending requests go when its last page closes.
- The cube in the header opens dApps:
  - Connected sites, by network (Beam | Ethereum), each to disconnect from that network;
  - Recent requests, the sites' last 40 calls with their outcome and time, by network;
  - a Catalog of Beam's official sites and ours, the ones that connect marked.
- On the wallet tab, the dApp box shows the open tab's site: connected, not connected, or request waiting.
  Every open popup and window now hears when a request ends.

### Beam
- Tokens: the Beam card grows down to the Ethereum card's edge and lists the wallet's assets in the Ethereum
  list's style:
  - names from the node, from the wallet's own list first;
  - dollars from Beam DEX's pools, and they count in the total;
  - sorted by value.
  The list folds when another tab or wallet opens.
- Receive:
  - address types in the bar under the tabs (regular, offline, public offline, max privacy);
  - a card with the QR, the address's name, type, creation and expiry dates, and icons to copy, share the QR,
    rename, make a new address, remove;
  - My addresses as a table, the shown one lit;
  - "Remove unused" is gone.
- Contract confirmations show amounts and fees in coins (they were divided by 10^8 a second time).
- Only the open wallet's Beam part runs, the others stop once their transfers are done.
- A second copy of each Beam database is kept in OPFS, so a lost database comes back. "Restore Beam" rebuilds a
  wallet's Beam part from its seed phrase.
- The balance's states as chips (incoming, outgoing, maturing, max privacy).
- The card's corner shows the block, and the state in yellow or red.
- BEAM's price and 24 h change come from Beam's on-chain oracle.

### Ethereum
- Tokens are kept per address and survive a Blockscout outage.
- The account menu scrolls past 4 accounts and has icons for its actions.
- The account button reads `name | address`, with the address left out when it does not fit.
- WBEAM is priced at its Uniswap market.

### Everywhere
- QR codes come from the design library (`ui/components/qr.js`), in the puzzle invite's look:
  - our logo in the middle;
  - one size for every address;
  - checked readable on Beam's longest addresses.
- Links are the library's two kinds only (a plain link, `.text-link`).
- Explorer links fall back to explorer.beam.mw when ours does not answer.
- Addresses are shortened to their first 3 and last 6 characters.
- Dates read dd.mm.yyyy, the time in 24 or 12 hours (Settings → Display).
- The total's 24 h change is shown.
- The toolbar icon turns grey while the wallet is locked.
- Fixed: Chrome's offer to save a password, and Enter in a field, closed the popup on Windows.

## 0.2.0 and before
See the git history of `beam/wallet`.
