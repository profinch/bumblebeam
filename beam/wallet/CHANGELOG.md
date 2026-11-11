# BumbleBeam Wallet: changes

## 0.4.0 (2026-11-10, not yet published)

### Safety
- A backup carries each wallet's addresses added by hand (verified or not) and its favourites; an import adds the
  ones a wallet lacks. Those lists sit outside the backup's sealed part, so they come in as not verified (the wallet
  checks them again: its key, a payment to it, Beam's own list) and the offline reference is made again here, never
  taken from a file. A backup's network settings are checked as Settings checks them (https, Ethereum mainnet, the
  node format), its wallet ids must be the wallet's own kind, and a vault record asks for 100k to 2M rounds only.
- Code audit (2026-11-11):
  - A crashed Beam engine is started again (it stayed "running" dead, every Beam call failing).
  - A restore from a backup that fails partway can be tried again (its half-made databases are dropped); a wallet
    with no database and no phrase in the file keeps its Beam part and its database password (shown missing).
  - The import of a backup runs in the host's queue (a double click adds nothing twice), shows its progress, does not
    lock itself idle mid-snapshot, drops a half-made database when it fails, and knows a wallet by its id too.
  - Reset now deletes the old shared folder as well (the helper engine kept it open, so the delete was blocked and
    0.1's wallet came back); the wallets are stopped in their own queues first.
  - Restore Beam is back on a wallet's card in Settings when its database is missing or will not start, and the
    "restore" link on the wallet tab opens it at once (the Settings port had left it out).
  - A site's malformed transaction (a value that is no number, a bad address or data) is refused at once: it kept
    every other site's request from showing.
  - The helper engine is made once when asked for at once (each word of a phrase checked): each call made its own.
  - Removing an Ethereum account goes only through its password (a second, unchecked way is gone); a new account goes
    to the end of the list (the order dragged kept).
  - A new wallet's engine is taken into its slot before the settings are saved (a failed save left it running
    outside, and a second engine could open the same store).
  - Wallets without a public offline address are no longer started and stopped at every unlock to read theirs.
  - The badge counts once after a burst of changes; the Storage figure reads the files' sizes, not the files.
  - A dialog's Cancel and Esc wait while its check runs, and a check's late answer is never put into the next
    dialog; Beam Send and the bridge send nothing if another wallet was opened meanwhile.
  - An address added by hand verifies only by a payment TO it (a payment from it counted too); one Beam took as its
    own from imported data is renamed and removed in Beam.
  - Back on the start screens and the lock clear a typed phrase, key and passwords; node probes of an older round
    are not drawn over newer ones, and the public RPCs show red when none answers; a card's picked account checked.
- Receive: an offline or max privacy address shows its payments left (Payments: 3 of 5 left). Each carries one-time
  keys (Beam's vouchers), one taken per payment; when a sender has none left, its wallet asks this one for new keys,
  which come while this wallet is open and online. Max privacy carries one. New offline addresses carry 5 (the API
  alone gave 1; Beam's desktop 10 make ~3,200 symbols, too long for a QR code); one too long shows its words only.
- Add an address takes any kind: a public offline one is checked against the seed as before, another kind is
  added not verified (in yellow) until a payment to it or an imported wallet data file verifies it.
- The start screen imports a BumbleBeam backup: with no wallet yet, every wallet in it comes back (the wallet
  password is the one it was made with, Beam from its database or its phrase); from an open wallet, what it has and
  this one does not is added.
- Forgot the password? on the lock screen: it cannot be recovered (the vault is sealed with it alone), said plainly;
  typing RESET deletes every wallet from this browser (the vault, Beam's databases and their copies, the backup kept
  here, the old shared folder) and keeps the network settings, to restore the wallets from their seed phrases.
- The wallet's own channel (the one that signs and sends) and its storage answer only the extension's own pages.
  The script it puts into sites carries the extension's id too: a site that took over its own page process could
  have used it. The stored vault is out of that script's reach.
- A site's transaction that calls a token is read out in its window: approve and increaseAllowance (the spender
  and the amount, "all your WBEAM, with no limit" warned in yellow), transfer, transferFrom, setApprovalForAll. It
  showed only the data's first bytes.
- Typed data is refused when its named type is not the one its types make (the window would show one thing and
  sign another), or when it is for another chain (a permit there, where the same address may hold coins).
- A request just shown in the window keeps Approve off for 0.6 s: a quick second click meant for the request
  before cannot agree to it.
- An Ethereum node set by hand is taken only if it is Ethereum mainnet.
- A wallet's Beam contract calls run one at a time (a site's, the wallet's own bridge send and claim): Beam's
  approval does not say whose call it is, and two at once could show one site's name for another's transaction.
- A site cannot flood the request window: one connect request and 5 requests in all waiting from it, and none for
  10 s after a no or a closed window.
- One bridge transfer to Beam per account at a time (a second approval meanwhile left the first without its
  allowance); the ETH for its gas is checked again when it is sent.
- An Ethereum transaction is taken for dropped (its nonce used again) only when still unknown 3 s later.
- A stopped Beam part's database password is not kept in memory.
- In a site's window the name it gives itself reads "Calls itself", under the site Chrome names; a Beam asset
  named as a well-known coin (BEAM, BTC, ETH, USDT…) is flagged in a contract's confirmation.

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

### Beam: the card
- BEAM's price in a chip right after the card's name, on the line of the block (the design library's price
  chip, as on the pool and the explorer).

### Activity (both networks; worked out in lab/activity.html)
- By day: Today, Yesterday, 9 Nov (another year's with its year), each day's net in the network's coin. What is
  under way stands above them all, a ring turning round its icon.
- Each row says who and what: Sent to / Received from (one's own Ethereum accounts by name, else the short
  address), Bridge → Ethereum / Bridge ← Ethereum / Bridge → Beam, a dApp's call by its name, an approval as
  one. The date then the time (24 or 12 hours, as Settings has it), the comment after it.
- The amount with its unit (an asset by its name, no longer as BEAM) and its dollars under it, white whether it
  came or went.
- A failed transfer in the wallet's red with why on its line; a cancelled one faded. No status badge on what is
  done.
- Our pool's payouts in a day as one row, Pool payouts ×N BumbleBeam (the pool's name in its colour). They are known
  from the pool's public list of payments (no address is sent): a transfer by its kernel, a coin with no record of
  its own by its amount near the run's time; the pool pays from a fresh address each day and its note does not
  reach the receiver. Another pool's (three or more in a day from one address) by their count alone.
- A click opens the row's card: When, Now (where it is, while under way) or Why, the address with its copy and
  Etherscan icons, then the asset or token, the fee, the comment, the transaction (a link to our explorer or
  Etherscan) and the block. Cancel there while it can be.
- All / In / Out / Bridge / dApps (the wallet's small buttons, as All) with their counts, and a search (name, address, comment, amount) in their
  place; 30 rows, then Older. A refresh keeps the list until the new one is ready; the scroll bar's room is kept.
- A transfer's comment (written on Send, kept only in this wallet's history) shows in grey after its date.
- Activity's memory: what it worked out once is kept in this browser per wallet, so it is not lost later: a
  receipt's kernel and block when Beam gave none (from the pool's list, from the coins it made), our pool's
  payouts, blocks' times, a coin with no record of its own (its row stays once spent), and each list as last
  shown (it opens at once and refreshes behind). A removed wallet's goes by itself; Settings shows what is kept
  and clears what is older than a month, 3 months, a year, or all of it.
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
- Send: under the address, "Your wallet: Main" for another wallet's account, "Your account: Account 2" for
  another account of the open wallet (label grey, name white), or "⚠️ the account you send from" in yellow when
  it is the sending account itself (in the confirmation too); the line keeps its room.
- Two accounts of one wallet cannot share a name (case aside), as Beam addresses: renaming or importing says so
  in yellow in its window; a new account whose usual name is taken gets "Account 3 (2)".
- Send's My accounts reads as the wallet tab's account picker: the name left, 0x+6…6 right, by wallet; on the
  button name | address, the address left out when the name fills it.
- ETH's price in its row of the token list, in the amount column (right-aligned as the tokens' amounts), as
  plain figures after a ×: 0.0101 ETH … × $2 023.75 … $20.48.
- Send's confirmation: the amount in dollars after it (0.001 ETH | ≈ $2.03), rows of their own for the
  net fee (≈ 0.000006 ETH | $0.01), the max fee, the gas base (0.31 gwei) and the gas limit (26 200), all
  aligned on one column; a whole address fits on one line.
- Windows are 8 px from the popup's sides (the browser's own narrower limit taken off).
- Send shows the net fee before the review, right of Available on its line, read from the chain: the
  transfer's gas estimate at today's base fee and tip. All keeps back the most the transfer can cost, not a
  fixed 0.002 ETH.

### Bridge
- The tab is two cards, From over To, with the switch between them: the two networks' dots in their own oval,
  the cards cut round it. A click turns the way round; the cards' content tears into strips that jerk sideways
  and comes back the other way. The direction tabs and ⇄ are gone. The design was worked out in a lab page of
  its own (`lab/bridge.html`, made-up figures, nothing is sent).
- From: the amount (up to 99 999 999.99999999, BEAM's and WBEAM's 8 decimals, its figures smaller when long rather
  than running under the balance),
  "available" over the balance at the right. The balance is the All button: under the pointer it lights and its
  word reads "send all"; a click puts in the most that can go to the last decimal, the fee left for (no dust). A
  problem with the amount ("over balance + fee") shows in yellow under it, on the balance's line.
- To: what the receiving side holds now ("there now", 4 decimals as "available"), when it arrives by the clock
  ("arrives ≈ 10:38", an hour from now) and how long it takes: "usually about an hour", or "about an hour, then
  claim" towards Beam.
- Each card says its way and network in its left corner, in the wallet tab's card-title letters, the way grey:
  FROM ● BEAM, TO ● ETHEREUM; on top 16 px from the top, below 16 px from the bottom. Beam receiving: its bridge key
  at the right of that line, a copy icon before it holding the whole key in its tip (the tip on "key" says what it
  is).
- Ethereum's side is the wallet tab's account picker: this wallet's accounts, then the other wallets' under their
  names, scrolling past 4; the mouse wheel over it steps through them. Towards Ethereum, "Enter an address" takes
  any address. Another account picked, its address runs as random hex and settles on the new one.
- The fee towards Ethereum is a small gauge of three levels (cheap, normal, safe), clicked or dragged; beside it
  the level and the fee, at the right in two short lines the gas now (low, usual or high against the day) and how
  far the level covers it, for how many dollars. Towards Beam: 0.02 WBEAM to the relayer and the ETH the gas comes
  from. A fee that cannot be priced says so in a few words under the button.
- The fee can be typed in the Beam card's top right ("fee [6.38]"), beside it the level as three dots on a circle,
  as BEAM's sign: the level's dot at the top, lit; a click on a dot takes its level, elsewhere the next, the wheel
  steps through them, and the circle turns round to bring the level's dot up. A figure of your own stops it between,
  no dot lit, and the gauge's needle follows the figure. Under the relayer's minimum, or over twice safe, the field
  and the arcs turn yellow and the line under the button says so; under the minimum it is asked once more.
- One button, "Bridge 250 BEAM"; its word (sent, an error) under it, in a line kept for it from the start.
- Transfers: both ways and what arrived to claim in one list (the Arrived on Beam card is gone), what waits for a
  claim on top with its Claim button, then newest first. Each row: the way and its number, whom to or from, the
  date in full (an icon right of it opens the transaction on Etherscan), the amount over the fee it paid, its
  state; the amounts and the states stand in columns down the list. The last 5, then "10 more" at a time. The
  card reaches down to where the wallet tab's Ethereum card ends.

### dApps
- The Catalog lists buybeam.my (any token on any chain swapped to BEAM, no account) among the whitelisted, as an
  Ethereum dApp: it pays from this wallet's Ethereum account.
- Each wallet keeps its own site connections, Beam and Ethereum. A site connected in one wallet saw another
  wallet's Beam balance after a switch, and kept its Ethereum account. After a switch:
  - the sites are told;
  - Connected sites lists the open wallet's;
  - connections made before this version move to their account's wallet, and Beam ones are asked again.
- Recent requests (the sites' last calls) is gone, on the page and in the wallet's memory.
- Catalog: the groups are "Beam official" (it folds, folded at first, the choice kept, sliding open and shut)
  and "BumbleBeam whitelisted".
- Beam, Ethereum and Catalog are quiet tabs, as Activity's networks (a network's dot before its name; Catalog at
  the right end, an open book before it, no taller than the letters so the bar is as high as Activity's); they
  were two button bars.

### Settings (worked out in lab/settings.html)
- Quiet tabs in the header instead of one long page: Wallets, General, Networks, Storage, About; the wallet's
  small buttons (as All) and compact pickers throughout.
- Wallets: one row each (its networks' dots, its name, what it holds, the open one marked current; the header's
  picker switches). A click opens its card: This wallet (Seed phrase, Export / Import wallet data) and Ethereum (its own Seed phrase when
  added by one, Private key) side by side, the account picker under them as the wallet tab's (with add, import,
  rename, remove; it opens at the wallet tab's account and does not change it), Remove last; Rename is a pencil by the
  name. Use and the manual Beam restore are gone from here.
- General: Security; Display with how the time and the decimals show under their pickers; Backup: one file with
  every wallet (the vault as stored, sealed with the wallet password, the settings, and Beam's databases if asked),
  saved into Downloads; an import adds the wallets the file has and the extension does not (a Beam part from its
  database, else from its phrase through the snapshot), changing nothing here.
- Networks: Beam's nodes as one list (the first is used, the others in turn; drag to order, the list's cross,
  WebSocket only), each probed for whether it answers and how fast, a click shows what is behind it; our two
  nodes explained in a fold. Ethereum: one's own RPC above the public ones (four, asked in turn), the block from
  them. Adding a token by hand is gone from Settings (it comes to the wallet tab later).
- Backup: Make a backup (kept in this browser, its time by the title), Download a backup (into
  Downloads/BumbleBeam, counted only once the file is complete on disk; an icon by the time shows it in its
  folder), Import a backup. It is BumbleBeam's own backup; for other Beam wallets, Export wallet data.
- An Ethereum account's row is dragged to order the accounts in any picker (the wallet tab's, the bridge's, a
  wallet's card in Settings), a line showing where it goes; the order is the wallet's, the same in every picker.
- Importing wallet data checks the addresses added by hand and not verified yet again: one now among the wallet's
  own (Beam verifies own addresses against the seed when it takes them) or named by an imported payment is verified.
- A wallet's Export wallet data / Import wallet data (Beam's own words, the CLI's export_data / import_data) is Beam's exchange file (JSON: its addresses with their key numbers and names,
  contacts, transactions; no keys), as Beam's CLI (export_data / import_data) and mobile wallets save and take it;
  its import adds one to a wallet of the same seed. The Beam engine is rebuilt for it (the same 7.5.14548,
  with Beam's own export and import exposed; beam/wallet/engine-build). Open a Beam backup file (a wallet.db) is
  gone from Add a wallet.
- Storage: the recovery snapshot (moved from About) and Activity's memory, each with its size and its clearing.
- About: the version as a link to the changelog, the bridge's contracts with copy and explorer icons.

### Everywhere
- Send on both networks: Available is All, as the bridge's balance (its figures light under the pointer, a click
  takes all of it but the fee); the All button is gone. Ethereum Send says Network fee, as Beam's.
- A screen opened before its balances came (Send on either network, the bridge) fills them in as they come; it
  showed "—" until it was opened again. A value not known yet is left blank, not a dash.
- The lock clears what was typed: Send on both networks, the bridge and the token field go back to empty, their
  lists to the first choice.
- Choosing another wallet keeps you where you are (Wallet, Bridge, Activity, dApps), drawn for that wallet;
  Settings, or a Receive or Send page, goes to the Wallet tab. It always opened the Wallet tab.
- No screen shows another wallet's data after a switch. Receive clears at once; Activity and Bridge drop
  answers for a wallet no longer open; a switch made in another window closes Receive or Send.
- On a sheet (Receive, Send, on both networks) the way back is an arrow in the header beside the
  lock; the sheet starts with its title. The bar under the tabs is gone.
- Every screen that can scroll (all but the wallet tab) keeps the scroll bar's room from the start, its content
  on the wallet tab's lines: a bar that shows (a field stretched, a list grown) moves nothing.
- Activity's networks are quiet tabs (the design library's new opt-in `.subtabs`): smaller than the main tabs,
  the chosen one underlined; a network's dot before its name.
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
- Every shortened address reads one way: an Ethereum one 0x + its first 6 … its last 6 (0x709979…dc79C8), a
  Beam address, a key or a transaction id its first 6 … its last 6.
- Errors where they are made: an action's error shows in yellow right of its button (Send, Review, the bridge's
  buttons) or under the field its Save or Add sits in (Settings), and the field it is about is outlined in red
  until it is edited; a wrong address shows in yellow under its field. A dialog's error shows the same way, above
  its buttons, and a window keeps the room for it, so nothing moves. They were a red card at the bottom of the
  screen, often out of sight.
- A window that asks for something (Add an address, renaming an account or a wallet, importing into a wallet,
  creating Ethereum accounts) checks it in place: what is wrong shows in it in yellow and it stays open, instead
  of closing and opening a second window ("Not added").
- dApps has no back arrow: its cube closes it, as the gear closes Settings, back to the main tab either was opened
  from (Wallet, Bridge, Activity).
- An action that went says so in a few words right of its button, in the accent, as its errors do: "transaction
  12e55bb4… sent" (Send on both networks, the bridge both ways), and fades away after 5 s; one still in progress ("sending…")
  stays until the next word. It was a card at the bottom, out of sight.
- A comma is a decimal point everywhere, Ethereum's amounts too ("0,001" was refused as a thousands separator).
- An amount is checked as it is typed and on Send (digits and one decimal point, the decimals allowed, not more
  than available, not empty): the reason shows in yellow in place of Available, never beside the button, the
  field outlined in red.
- What fills in as it loads (balances, prices, QR codes, the receive card's rows, lists, a Beam token's name in
  place of "asset N") fades in instead of appearing at once.
- BEAM Send: one's own address is recognised for every type (tokens looked up in the wallet's list), one added
  manually and not verified marked "(unverified)"; the payments an offline address has left show as ℹ️ in
  grey. A transfer to the open wallet's own address is cautioned in yellow in the confirmation too.
- The caution sign ⚠️ marks only "your current wallet"; error messages go without it.
- Thousands are set apart by a thin space (kept on one line), not a comma, so they are not mixed up with the
  decimal point:
  132 796.34 BEAM.
- Settings, Display: Decimals shown (2, 4, 6 or 8; 6 at first) for the amounts on the wallet tab, the bridge, Send
  and Activity; confirmations always show every decimal. The wallet tab's Beam balance gets smaller when it does not
  fit its line (up to 99 999 999.99999999 BEAM with its dollars).
- An amount field takes only digits and one decimal point (a point or a comma): anything else typed or pasted
  does not get in, so there is nothing to complain about; at most 8 digits before the point. A pasted
  "1,234.5" reads 1234.5 (with both, the last one is the decimal point).
- Another Ethereum account chosen on the wallet tab, its address (on the picker and the line under it) runs as
  random hex and settles on the new one.
- The Ethereum token list keeps the scroll bar's room when it does not scroll, so the rows stand where they do
  when it does.
- A list's option too long for it ends with … instead of being cut mid-letter (the design library).
- The lists are named by their captions for screen readers, the dialog by its title, the tabs are tabs, and the
  bridge's fee gauge moves with the arrow keys.
- The bridge's turn copies its cards once per half (it copied them every frame); an account's ENS name and avatar
  are kept 10 minutes.
- Prices are asked only as needed: ETH from Chainlink alone while it answers, BEAM from the oracle checked against
  one market; one asking at a time; a service that refused for being asked too often is left alone for 10 minutes;
  the 24 h change no longer holds the prices up (it could take 45 s).
- ETH sent with All: the gas is checked at the moment's price before the confirmation (the node refused it after).
- WBEAM sent to Beam: the send after the approval tries its estimate again while the node catches up with the
  approval's block (it failed with the approval already spent).
- A known token whose balance could not be read once stays in the list.
- A bridge message whose first release attempt reverted no longer shows failed when a later one went through.
- ETH's price is read from Chainlink's ETH/USD feed on Ethereum first, then CoinGecko and Coinpaprika: the free
  price services refuse when asked too often (CoinGecko 429, Coinpaprika 402 at 60 an hour), and the bridge's fee
  could not be priced.

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
