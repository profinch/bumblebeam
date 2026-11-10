# BumbleBeam Wallet: changes

## 0.4.0 (2026-11-10, not yet published)

### Beam: Receive
- The screen is BEAM Receive: My addresses on top, the shown address's card under it. What the list holds is
  told on its title's tip.
- No address is made by itself any more. New, beside Add, makes one. Its window:
  - the type is chosen in it (regular, offline, public offline, max privacy);
  - the title names the type and a hint says what it is for;
  - the window keeps one height whatever the type;
  - the name is optional.
- The screen opens on an address in this order:
  - the one shown last since the unlock;
  - else the first favourite;
  - else the first in the list.

  An address added manually and not yet verified is never opened by itself.
- My addresses:
  - a star marks favourites; they come first, the last one marked on top, and they can be dragged into any
    order; the others follow in the order they were made;
  - each row shows the name (Unnamed in grey when there is none, the address in the list), then the type;
  - no address count, no dates;
  - an expired address's row is tinted red, with a red edge on its left (the design library's new opt-in
    `.li.bad` / `tr.bad`).
- The card shows:
  - the name;
  - the type, its meaning on hover;
  - the created and expiry dates;
  - Symbols (the address's length);
  - for an address added manually, its status.

  Its icons, 15 px apart: copy, share the QR, rename, remove.
- Adding an address manually (Add): only a public offline address of this wallet's seed phrase is taken.
  - It is checked to carry this wallet's offline key: Beam makes every public offline address of a wallet from
    one key of its seed.
  - Another seed's address is refused, and so is any other kind, since whose it is cannot be told.
  - Once verified, the mark is kept and the address is not checked again.
  - An unverified one shows its name in yellow.
- Two addresses cannot share a name (case aside; Unnamed may repeat): New and renaming say so in yellow in their
  window, the name field outlined in red.
- Receive opened while Beam is starting says so and fills itself in once Beam runs (it was a red error).

### Beam: Send
- The screen is BEAM Send. It sends any asset the wallet holds, not only BEAM; the fee is paid in BEAM.
- Under the address: its type, as "Address type: public offline" (label grey, value white), and the payments
  left when that applies. The line keeps its room, so nothing below moves when an address is typed.
- An address of the open wallet itself (Beam lists it, or it was added manually and verified) is flagged in
  yellow beside its type: "⚠️ your current wallet".
- Under the amount, on one line: Available on the left, the network fee for the address's type on the right
  (0.001 BEAM, or 0.011 to an offline, public offline or max privacy address; the tip says so). The screen fits
  the popup without scrolling.
- My wallets offers another wallet by a public offline address it already has, known without opening that
  wallet first: after the unlock, a wallet whose address is not known yet is started for a moment in the
  background, its address read, and stopped again. Making or removing a public offline address updates it at
  once. A wallet with none is listed greyed, not selectable.
- The comment is marked optional.
- My wallets follows the address field: an address edited away from the wallet's shows "My wallets…" again, and
  another wallet's address pasted in shows that wallet's name (My accounts on Ethereum Send alike).

### Beam: Activity
- It also lists coins this wallet holds that no transaction of its own made: another wallet of the same phrase,
  such as the mobile one, took the transfer. They are marked found on the chain.
- A receipt sent by a wallet of the same seed (a pool's payouts, the wallet CLI) is shown, marked "from a
  wallet of this seed". It was hidden: a 144.9 BEAM payout was missed.
- The newest coins are asked first. Beam lists them oldest first, so on a wallet that mined, a recent receipt
  fell past the first 1000.

### Ethereum
- The receive card shows:
  - the type (Ethereum, details on hover);
  - the account's EIP-7702 delegation (the contract it runs, or none);
  - the nonce (transactions sent);
  - the ENS name, when the account has one: the reverse record, also through a parent name's resolver
    (ENSIP-10), shown only when the name resolves back to the address;
  - the ENS name's avatar, only with the name and only when it has one.

  Nothing shows while these rows load, and the values do not move when they arrive. The card has rename and
  remove icons, no Expiry and no Symbols.
- Send: under the address, "Your wallet: Main" for another wallet's account (label grey, name white), or
  "⚠️ your current wallet" in yellow for the open wallet's; the line keeps its room.
- Send shows the network fee before the review, right of Available on its line, read from the chain: the transfer's gas estimate at today's base
  fee and tip, in ETH and dollars. All keeps back the most the transfer can cost, not a fixed 0.002 ETH.

### dApps
- Each wallet keeps its own site connections, Beam and Ethereum. A site connected in one wallet saw another
  wallet's Beam balance after a switch, and kept its Ethereum account. After a switch:
  - the sites are told;
  - Connected sites lists the open wallet's;
  - connections made before this version move to their account's wallet, and Beam ones are asked again.
- Catalog: the groups are "Beam official" (it folds, folded at first, the choice kept, sliding open and shut)
  and "BumbleBeam whitelisted".

### Everywhere
- The lock clears what was typed: Send on both networks, the bridge and the token field go back to empty, their
  lists to the first choice.
- No screen shows another wallet's data after a switch. Receive clears at once; Activity and Bridge drop
  answers for a wallet no longer open; a switch made in another window closes Receive or Send.
- On a sheet (Receive, Send, on both networks) the way back is an arrow in the header beside the
  lock; the sheet starts with its title. The bar under the tabs is gone.
- Every screen that can scroll (all but the wallet tab) keeps the scroll bar's room from the start, its content
  on the wallet tab's lines: a bar that shows (a field stretched, a list grown) moves nothing.
- Fields are as high as the lists (28 px); All looks like the small buttons (Add, New).
- The asset lists (Send, both networks) show 10 rows, then scroll.
- Fixed: a list inside a field's label (Send's Asset, Settings' Lock after idle and Time format) opened again
  as soon as an option was picked: the label passed the click on to the list's button.
- The design library's lists can show an option greyed and not selectable.
- A field in a dialog sits 12 px under its text.
- Tooltips:
  - a tip goes away with a click, when its element is gone or hidden, or when the pointer or the window
    leaves (tips stayed up when the screen changed under them);
  - a window that closes no longer brings one up;
  - this is fixed in the design library, so every BumbleBeam site gets it.
- "Take off" reads Remove.
- Errors where they are made: an action's error shows in yellow right of its button (Send, Review, the bridge's
  buttons) or under the field its Save or Add sits in (Settings), and the field it is about is outlined in red
  until it is edited; a wrong address shows in yellow under its field. A dialog's error shows the same way, above
  its buttons, and a window keeps the room for it, so nothing moves. They were a red card at the bottom of the
  screen, often out of sight.
- A window that asks for something (Add an address, renaming an account or a wallet, importing into a wallet,
  creating Ethereum accounts) checks it in place: what is wrong shows in it in yellow and it stays open, instead
  of closing and opening a second window ("Not added").
- dApps has no back arrow: its cube closes it to the wallet's main screen, from wherever it was opened, as the gear
  closes Settings.
- An amount is checked as it is typed and on Send (digits and one decimal point, the decimals allowed, not more
  than available, not empty): the reason shows in yellow in place of Available, never beside the button, the
  field outlined in red.
- What fills in as it loads (balances, prices, QR codes, the receive card's rows, lists, a Beam token's name in
  place of "asset N") fades in instead of appearing at once.
- BEAM Send: one's own address is recognised for every type (tokens looked up in the wallet's list), one added
  manually and not verified marked "(unverified)"; the payments an offline address has left show as ℹ️ in
  grey. A transfer to the open wallet's own address (or account, on Ethereum) is cautioned in yellow in the
  confirmation too.
- The caution sign ⚠️ marks only "your current wallet"; error messages go without it.

## 0.3.0 (2026-11-09)

Published on GitHub on 2026-11-09 with the manifest still reading 0.2.0. The version number came in the next
commit.

### dApps
- Websites connect to the wallet:
  - on Ethereum mainnet through EIP-1193 and EIP-6963, so a site finds BumbleBeam Wallet in its list of
    wallets;
  - on Beam through the web wallet's own protocol (`create_beam_api`, `window.BeamApi`), so Beam's sites (DEX,
    NFT Gallery, BANS, Minter, Faucet) work with it.
- Every request is approved in a window of its own, at the right of the site's browser window. It shows:
  - the account (name, then the whole address);
  - for a contract transaction, what the wallet reads from it itself: the amounts by the assets' names, the
    asset ids, the fee. Amounts and fees are in coins (they were divided by 10^8 a second time).
- `wallet_getCapabilities` is answered as EIP-5792 wants it (Ethereum mainnet, no atomic batches).
- While the wallet is locked, a site sees no account and its Beam calls are refused. A request opens the window
  on the password first. Closing the window says no.
- A request made while the window was closing itself got no window and was refused; now it gets one. A site's
  pending requests go when its last page closes.
- The cube in the header opens dApps:
  - Connected sites, by network (Beam | Ethereum), each to disconnect from that network;
  - Recent requests: the sites' last 40 calls with their outcome and time, by network;
  - a Catalog of Beam's official sites and ours, the ones that connect marked.
- On the wallet tab, the dApp box shows the open tab's site: connected, not connected, or request waiting.

### Beam
- Tokens: the Beam card grows down to the Ethereum card's edge and lists the wallet's assets in the Ethereum
  list's style:
  - names from the wallet's own list first, then the node's;
  - dollars from Beam DEX's pools, counted in the total;
  - sorted by value;
  - the list folds when another tab or wallet opens.
- Receive:
  - address types in the bar under the tabs;
  - a card right of the QR with the name, type, expiry, and icons to copy, share the QR, rename, make a new
    address, remove;
  - My addresses as a table, the shown one lit;
  - "Remove unused" is gone.
- Only the open wallet's Beam part runs: an engine is 100 MB and a thread per core. The others stop once their
  transfers are done.
- A second copy of each Beam database is kept in OPFS, so a lost database comes back. "Restore Beam" rebuilds a
  wallet's Beam part from its seed phrase.
- The balance counts coins received through the shielded pool. Its states (incoming, outgoing, maturing, max
  privacy) show as chips.
- The card's corner shows the block, and the state in yellow or red.
- BEAM's price and 24 h change come from Beam's on-chain oracle.

### Ethereum
- Tokens are kept per address and survive a Blockscout outage. After a switch, each wallet's card shows only
  its own balances.
- The account menu scrolls past 4 accounts and has icons for its actions. An account can be removed from it,
  and importing an account works again.
- The account button reads `name | address`, with the address left out when it does not fit.
- WBEAM is priced at its Uniswap market.

### Everywhere
- QR codes come from the design library (`ui/components/qr.js`), in the puzzle invite's look:
  - our logo in the middle;
  - one size for every address;
  - checked readable on Beam's longest addresses.
- The look:
  - the header has the wallet picker, the lock, the dApps cube and Settings as a gear;
  - the tabs are Wallet, Bridge, Activity;
  - a footer with the copyright and the source;
  - the lock and welcome screens are redone.
- Links are the library's two kinds only (a plain link, `.text-link`).
- Explorer links fall back to explorer.beam.mw when ours does not answer.
- Addresses are shortened to their first 3 and last 6 characters.
- Dates read dd.mm.yyyy, the time in 24 or 12 hours (Settings → Display).
- The total's 24 h change is shown.
- The toolbar icon turns grey while the wallet is locked.
- Fixed: Chrome's offer to save a password, and Enter in a field, closed the popup on Windows.

## 0.2.0 (2026-11-06)

- Beam and Ethereum from one 12-word phrase:
  - Beam's phrases are BIP-39, and the Ethereum accounts are m/44'/60'/0'/0/i, as in MetaMask and Rabby;
  - ETH, WBEAM and ERC-20 tokens: send, receive, history;
  - accounts added from the phrase or imported (a key or another phrase), and renamed.
- Several wallets: new, restored (a Beam or an Ethereum phrase), from a Beam backup file, or from an Ethereum
  key.
  - One password opens a vault (PBKDF2 600k → AES-GCM) holding every phrase, key and Beam database password.
  - Auto-lock.
- The official bridge both ways without another wallet:
  - BEAM → WBEAM to the wallet's own Ethereum account;
  - WBEAM → BEAM signed here (approve exactly, then sendFunds);
  - Claim on the Beam side.
- One Beam engine per wallet: its own wasm client and its own database.
- The node connection:
  - keepalive;
  - a backup node after a minute without the main one, back to the main one when it answers again;
  - away from a node whose last block is 10 minutes old.
- Receive: the newest address of a type, and a list of the wallet's addresses. Send to one's own wallets and
  accounts.
- Prices come from Beam's on-chain oracle first, with the sources cross-checked.
- The look comes from the design library (`ui/`). The icon is the bee alone.

## 0.1.0 (2026-10-30)

- BumbleBeam Bridge: a Chrome extension (MV3) that is a Beam wallet (Beam's wasm client 7.5.14548, past HF6),
  with a UI for the official Beam ↔ Ethereum bridge:
  - BEAM → WBEAM through the pipe's app shader, with the relayer's own fee formula and status from Blockscout;
  - WBEAM → BEAM through a Rabby page and Receive in the wallet.
- A new wallet, or a seed restored from Beam's recovery snapshot; wallet.db backup.
- The same day it became BumbleBeam Wallet, with the bridge one of its features. It opens in a window of its own
  that keeps its size and place, one copy at a time.
