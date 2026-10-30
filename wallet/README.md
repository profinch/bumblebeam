# BumbleBeam Wallet

A Beam wallet as a Chrome extension, in a window of its own: receive and send BEAM, and a bridge to
Ethereum (BEAM → WBEAM and WBEAM → BEAM). The bridge is the **official** one: its contracts, relayer
and WBEAM token are BeamMW's (`beam-bridge-reverse-app`, `-ethapp`, `-ethrelay`). The wallet's UI and its
node door (wss.bumblebeam.org) are ours.

Why the extension exists (2026-10-30):
- The official Beam Web Wallet is a Manifest V2 extension, and Chrome no longer runs those.
- Its node `web-wallet.beam.mw:8200` is still on the pre-HF6 chain: the wallet logs "Peer
  incompatible with HF 6" and its tip stays at 3928666.
- The official bridge DApp needs a wallet that can call contracts, and the mobile wallet cannot.

The relayer itself is alive: message 675 was released on 2026-10-30.

| Part | What it is |
|---|---|
| [`extension/`](extension) | MV3 extension. The popup under the toolbar icon (`popup.html`, a view only), the wallet host (`offscreen.html`: Beam's wasm wallet from `vendor/` and the bridge calls in `bridge.js`), the service worker that starts the host (`background.js`) |
| [`bridge-dash/`](bridge-dash) | Bridge status page, one static file: the relayer's queue and health (last release, gas balance, usual delay), locked BEAM against WBEAM supply, every message both ways with its Beam block and Ethereum release |
| [`web/`](web) | The Ethereum side of WBEAM → BEAM: a page Rabby injects into, with hand-encoded `approve` + `sendFunds` |
| [`../deploy/docker/containers/nginx/conf/wss.conf`](../deploy/docker/containers/nginx/conf/wss.conf) | `wss://wss.bumblebeam.org`: a WebSocket door to the pool's beam-node (`websocket_port=8200`) |

## The two directions
**BEAM → WBEAM.**
1. The wallet runs the official app shader (`shaders/pipe_app.wasm`, sha256 `6310f8af…415e`, byte for byte
   the one in `beam-bridge-reverse-app`) with `role=user,action=send,amount,receiver,relayerFee` on pipe
   `e63bd26c…e835`. The contract takes amount + relayerFee.
2. The relayer checks that relayerFee covers 120000 gas × (2·baseFee + tip) × ETH/BEAM. Then it calls
   `processRemoteMessage` (`0x6efe7df5`) on `0x6063…a670`, and WBEAM (`0xE5Ac…F499`, 8 decimals) arrives.
   A message with a lower fee waits for cheaper gas; it is not lost.
3. Status comes from the pipe's `local_msg`, joined with the relayer's calls decoded from Blockscout.

**WBEAM → BEAM.**
1. The wallet's bridge key is `get_pk` on the pipe (`pubkey`, 33 bytes).
2. On `web/`, Rabby signs `approve(pipe, amount + fee)` and `sendFunds(amount, fee, key)` (`0x4d5dd2bc`).
   The selector is checked against real calls on the pipe.
3. The relayer pushes the message to Beam. It shows up in `view_incoming`, and **Receive** (`action=receive`)
   takes it. This direction has no minimum fee in the relayer; recent transfers paid 0.02 WBEAM.

## The wallet
- **wasm-client:** `beam-wasm-7.5.14548` from BeamMW's CI (master, 2026-10-30), past HF6 (block 3928666,
  the Bulletproofs transcript fix). npm `beam-wasm-client` stops at 7.5.14349 (2025-12), before the fork.
  master after the 7.5.14493 release changes no consensus code: explorer, hw_crypto, Slatepack, wallet
  hardening. The files and their sha256 are in `extension/SHA256SUMS`.
- **New wallet and seed restore** both start from Beam's recovery snapshot
  (`mobile-restore.beam.mw/mainnet/mainnet_recovery.bin`, ~320 MB, refreshed daily). It is what the mobile
  wallet's "automatic restore" and the web wallet use. So no node with the wallet's owner key is needed,
  and a new wallet does not sync ~4 M headers (about an hour in a browser).
- **The snapshot is Beam's, not ours, for now.** A node can write one (`recovery_auto_path`,
  `recovery_auto_period` in `beam-node`), but it does so synchronously in its main loop. On the pool's
  beam-node, stratum would stall for the minutes it takes; explorer-node has no such option. Our own
  snapshot would need a small fast_sync node of its own, syncing from beam-node.
- **Backup:** Settings → Backup saves `wallet.db`, encrypted by Beam with the wallet password. Opening it
  is instant and keeps the history.
- The seed and keys never leave the extension. Pages need cross-origin isolation for the wasm threads
  (manifest COEP/COOP).

## Run
1. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → `wallet/extension`.
2. Click the toolbar icon: the wallet drops down under it, like Rabby. The wallet itself runs in an offscreen document for as long as the browser runs. Chrome closes the popup on the first click outside, so the wallet keeps syncing, receiving and importing a snapshot with the popup closed, and a new seed waits in it until the wallet is created. ⤢ opens the same view in a tab, for choosing a backup file (a file dialog can close the popup).
3. For WBEAM → BEAM, serve the Ethereum page: `python3 -m http.server 8771 --bind 127.0.0.1 -d wallet/web`.
   Rabby does not inject into extension pages.

## Tested
- Headless Chrome 156: the extension loads, the page is cross-origin isolated, the wasm wallet starts,
  creates a wallet and connects. Against `web-wallet.beam.mw:8200` it reports the node as pre-HF6.
- `bridge.js` against the live network: the relayer fee and the decoding of the relayer's calls.
- Not yet: contract calls through our node, a real transfer either way.
