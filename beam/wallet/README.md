# BumbleBeam Wallet

A wallet for **Beam and Ethereum** as a Chrome extension: BEAM, ETH, WBEAM and other ERC-20 tokens,
several wallets side by side, and the **official** Beam ⇄ Ethereum bridge between the two, both ways,
from this wallet's own accounts at both ends (no other wallet needed). The bridge's contracts, relayer and
WBEAM token are BeamMW's (`beam-bridge-reverse-app`, `-ethapp`, `-ethrelay`); the wallet, its UI and its
node door (wss.bumblebeam.org) are ours.

Why it exists (2026-10-30):
- The official Beam Web Wallet is a Manifest V2 extension, and Chrome no longer runs those.
- Its node `web-wallet.beam.mw:8200` is still on the pre-HF6 chain ("Peer incompatible with HF 6", tip 3928666).
- The official bridge DApp needs a wallet that can call contracts, and the mobile wallet cannot.

| Part | What it is |
|---|---|
| [`extension/`](extension) | MV3 extension: the popup under the toolbar icon (`popup.html`, a view only), the wallet host (`offscreen.html`: the vault, Beam's wasm wallet, the Ethereum accounts, the bridge), the service worker that starts the host (`background.js`) |
| `extension/icons/` | the bee alone, from `brand/src/icons.py` (default mode) |
| [`CHANGELOG.md`](CHANGELOG.md) | what each version changed (the version is `extension/manifest.json`'s) |
| [`sync-ui.sh`](sync-ui.sh) | copies the shared look (`ui/` in the repo root) into `extension/ui/`; run it after a `ui/` change |
| [`bridge-dash/`](bridge-dash) | bridge status page, one static file: the relayer's queue and health, locked BEAM against WBEAM supply, every message both ways |
| [`../../deploy/docker/containers/nginx/conf/wss.conf`](../../deploy/docker/containers/nginx/conf/wss.conf) | `wss://wss.bumblebeam.org`: a WebSocket door to the pool's beam-node (`websocket_port=8200`) |

## Wallets

A wallet has a name and up to two parts, and the extension holds any number of them (the card list in the
header switches between them; Settings → Wallets lists them).

| Started from | Beam part | Ethereum part |
|---|---|---|
| **Create** (new 12 words) | from the words, via Beam's snapshot | accounts `m/44'/60'/0'/0/i` of the same words |
| **Restore**, 12 Beam words | the same (the coins are found in the snapshot) | the same words |
| **Restore**, 12/24 words of MetaMask, Rabby… | — | those words |
| **Beam backup file** (wallet.db + its password) | that file, with its history | — (add one later: new words, a phrase or a key) |
| **Ethereum private key** | — | that one account |

Beam's phrases are BIP-39 (English list, checksum), so the same 12 words restore the Beam part in any Beam
wallet and the Ethereum accounts in MetaMask or Rabby (checked: the derivation matches ethers' and the
standard test vector). A phrase wallet adds Ethereum accounts one by one (+ Add an account); any wallet
takes accounts from elsewhere too (+ Import an account: a private key, or another phrase's first account),
and every account can be renamed (✎ by its address).

**Sending to yourself.** Send on Ethereum lists every account of every wallet ("To one of my accounts").
Send BEAM lists the other Beam wallets: each keeps a public offline address of its own for this (any number
of payments, no expiry, as pools and exchanges are paid), made while it runs, so it takes the coins while it
is not the one running. A wallet appears there once it has run once in 0.2.

**The vault.** One password opens the extension. It encrypts one record with every secret in it (the seed
phrases, the Ethereum keys, each Beam database's password): PBKDF2-SHA256, 600 000 rounds → AES-256-GCM,
WebCrypto only (`vault.js`). Unlocked, the record lives only in the host's memory; locking (the button, the
idle timer, closing the browser) drops it. Every change to it is made on a copy, sealed and
written one at a time, and becomes live only once it is on disk. Each Beam database is encrypted by Beam with
a random password of its own, kept in the vault (a 0.1 wallet keeps its old one): wallet.db sits in the
browser profile and in backups, so a password guessed against it must not open the vault, nor the other way.

**Every Beam wallet runs while unlocked.** Each Beam wallet has an engine of its own: a hidden frame
(`engine.html`) with its own copy of Beam's wasm client and its own IndexedDB store (`/bw_<wallet id>`).
While the extension is unlocked all of them run, so every regular address of every wallet is online, and
switching wallets in the header only changes what the popup shows. Locking (the button, the idle timer,
closing the browser) takes Beam offline; a wallet still making a transfer keeps running until it is done
(a regular transfer needs both wallets online). Offline and public addresses take payments either way.
Why an engine per frame (`beam.js`, 2026-11-05): Beam's client cannot be restarted in a page (a second
`WasmWalletClient` throws while the first lives, and freeing the first blocks on its threads, which a
browser's main thread may not do: the whole engine aborted after a transfer between two wallets), and Beam
persists by syncing a whole mounted folder (overwriting files whose time differs, deleting files it does
not have), so engines sharing one folder would overwrite each other's databases. Restarting an engine =
dropping its frame (after the wallet wrote its database) and making a new one; a crashed one is replaced.

**The node connection.** Each engine reaches the node through `wss.bumblebeam.org:443` (nginx, then
beam-node's `websocket_port`) and keeps it: a keepalive asks the node for the tip block after 15 s of quiet.
An engine without its node for a minute is replaced, on the next node of the list (Settings → Networks: the
node, then backup nodes; by default `wsb.bumblebeam.org`, a Cloudflare Worker that passes the WebSocket to
checked public nodes over TCP, `deploy/cloudflare/wsb`, so it works while our server is down). An engine
whose node answers but lags (its last block more than 10 minutes old) moves on too: on 2026-11-05 one of
BeamMW's public nodes was stuck before HF6 and several were behind. On a backup,
the engine tries the main node every 2 min and moves back after two answers in a row (not during a
transfer). beam-node's plain WebSocket sessions closed 30 s after opening (a timer never turned off on the
non-TLS path): reported and fixed in BeamMW/beam#2170 / #2171; our node runs the patched build.

**Upgrading from 0.1** (one `wallet.db`, its own password): the first unlock asks for that password, and it
becomes the extension's password; the wallet keeps its database, history and addresses. Databases of the old
shared folder (`/beam_wallet`, 0.1 and early 0.2) are copied into their wallets' own stores at the first
unlock, checked with their passwords; the old files stay where they were, untouched. Its seed phrase is
not known to the extension (Beam does not keep it), so it has no Ethereum part until one is added: new
words, a phrase or a key.

## Beam

- **wasm-client:** `beam-wasm-7.5.14548` from BeamMW's CI (master, 2026-10-30), past HF6 (block 3928666, the
  Bulletproofs transcript fix). npm `beam-wasm-client` stops at 7.5.14349 (2025-12), before the fork.
  The files and their sha256 are in `extension/SHA256SUMS`.
- **New wallet and seed restore** both start from Beam's recovery snapshot
  (`mobile-restore.beam.mw/mainnet/mainnet_recovery.bin`, ~310 MB, refreshed daily): what the mobile
  wallet's "automatic restore" and the web wallet use. No node with the wallet's owner key is needed, and a
  new wallet does not sync ~4 M headers. The snapshot downloads into the extension's private file system
  (OPFS) and is kept 3 days, so the next wallet only imports it. Headless Chrome, 2026-11-05: download
  40 s, import 5½ min.
- **Receive**: regular (24 h, the wallet must run until the transfer completes), offline (the sender
  completes it alone, up to 10 payments: one-time vouchers in the address), max-privacy and public offline
  (any number of payments: a pool's payouts, an exchange; less private) addresses. Receive shows the newest
  address of a type and makes one only on "New address"; "My addresses" lists every address the wallet made,
  with its name ("Name it"), expiry and the payments that came in. Beam's chain has no addresses, so a restored
  wallet lists only addresses made in it, not those of the wallet it was restored from (their coins are found), with a QR code. **Send**: the address type is checked
  (`validate_address`) and sets the fee (0.001 BEAM, 0.011 to offline and max-privacy addresses).
- **Activity**: the wallet's transactions with their kernels in explorer.bumblebeam.org; a pending
  outgoing transfer can be cancelled.
- **Backup** (Settings → Wallets): the `wallet.db` file, encrypted by Beam; opening it later is instant and
  keeps the history. The dialog then shows the file's own password: keep it with the file.
- The snapshot is Beam's, not ours, for now. A node can write one (`recovery_auto_path`), but beam-node does
  it synchronously in its main loop, which would stall the pool's stratum; our own needs a small fast_sync
  node of its own.

## Ethereum

- Keys and signing: ethers 6.16.0 (`vendor/ethers.umd.min.js`, sha256 in `SHA256SUMS`; its crypto is
  Paul Miller's audited noble libraries). Transactions are EIP-1559: tip = the median of the last blocks
  (0.05–3 gwei), max fee = 2 × base fee + tip, gas = the estimate + 20 %. Signed in the host, sent through
  public RPCs (publicnode, llamarpc, drpc, 1rpc; Settings takes your own first).
- Balances: ETH and WBEAM from the chain; tokens added by contract address; other ERC-20s that Blockscout
  prices show by themselves (unpriced ones are mostly airdropped spam).
- Prices: BEAM from Beam's on-chain price oracle (as pool.bumblebeam.org shows it), then CoinGecko, then
  Coinpaprika; ETH from CoinGecko, then Coinpaprika; a source more than 3× away from another is left out.
  Not `explorer-api.beam.mw/bridges/rates`: on 2026-11-05 it said BEAM $0.0325 against $0.0071 on the oracle,
  which priced the relayer's minimum 4.5× too low.
- Send: an EIP-55 checksum check, the fee now and at most before you confirm, and a refusal to send tokens
  to the WBEAM token or the bridge contract (where they would be lost).
- History: Blockscout (transactions and token transfers), with links to Etherscan.

## The bridge (tab **Bridge**)

**BEAM → WBEAM.**
1. The wallet runs the official app shader (`shaders/pipe_app.wasm`, sha256 `6310f8af…415e`, byte for byte
   the one in `beam-bridge-reverse-app`) with `role=user,action=send,amount,receiver,relayerFee` on pipe
   `e63bd26c…e835`. The receiver is one of this wallet's Ethereum accounts (or another address, said so in
   the confirmation). The contract takes amount + relayerFee.
2. The relayer checks that relayerFee covers 120000 gas × (2·baseFee + tip) × ETH/BEAM. Then it calls
   `processRemoteMessage` (`0x6efe7df5`) on `0x6063…a670`, and WBEAM (`0xE5Ac…F499`, 8 decimals) arrives.
   A message with a lower fee waits for cheaper gas; it is not lost. The fee choices show the gas they cover
   and how much of the last 24 h they would have been enough.
3. Status: the pipe's `local_msg` (read once each, kept) joined with the relayer's calls from Blockscout.

**WBEAM → BEAM.**
1. The Beam side's key is `get_pk` on the pipe (33 bytes) of the running Beam part.
2. The wallet's Ethereum account signs `approve(pipe, amount + fee)` (exactly that, not unlimited) when the
   allowance is short, waits for it, then `sendFunds(amount, fee, key)` (`0x4d5dd2bc`, ~55 000 gas). Both
   are priced before the one confirmation; the ETH for gas is checked first.
3. The relayer pushes the message to Beam. It shows up under **Arrived on Beam** (`view_incoming`), and
   **Claim** (`action=receive`) takes it. This direction has no minimum fee in the relayer; recent transfers
   paid 0.02 WBEAM.

Every contract transaction is approved in a box that shows what Beam's wallet itself computed (what it
spends, the fee) under what the bridge tab says it is; a contract call the wallet did not start is marked
so. The app API refuses plain transfers outright.

First real transfer, BEAM → WBEAM: 2026-10-30, message 677, 50 BEAM fee, Beam 16:35 → Ethereum 17:26 UTC.

## Run
1. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → `beam/wallet/extension`.
2. Click the toolbar icon: the wallet drops down under it. It runs in an offscreen document for as long as
   the browser runs, so syncing, receiving, importing a snapshot and an Ethereum transaction going through
   all continue with the popup closed. ⤢ opens the same view in a tab (for choosing a backup file: a file
   dialog can close the popup).

## Tested (headless Chromium 1223, 2026-11-05)
- New wallet through the UI: snapshot download and import, both parts from one phrase, the Ethereum
  address equal to ethers' derivation; receive (QR, address types), bridge tab with live relayer pricing,
  lock / wrong password / unlock, a second wallet from a private key, the wallet switch, a tab view.
- Upgrade from 0.1: a wallet made by 0.1, then 0.2 in the same folder: the password moves it into the vault,
  the same Beam bridge key, an Ethereum part added.
- `eth.js` against mainnet: balances, history, pricing of approve and transfer, a signed EIP-1559
  transaction decoded back (type 2, chain 1, sender, data), a key refused for another account, `sendFunds`
  encoding.
- Not yet with real coins in 0.2: an Ethereum transfer and WBEAM → BEAM end to end.
