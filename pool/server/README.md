# bumblebeam-pool

The pool server: a stratum proxy between Beam miners and our own `beam-node`, with every share
checked by the oracle (`oracle/src/pow.cpp`, compiled in), PPLNS and solo accounting in PostgreSQL,
payouts over `wallet-api`, and the HTTP API from [`../API.md`](../API.md) serving [`../web`](../web).

```
miners ──stratum 3333/3334──▶ bumblebeam-pool ──stratum TLS 8101──▶ beam-node ──▶ Beam network
                                   │  shares, blocks, credits, payments
                                   ▼
                               PostgreSQL        wallet-api ◀── payouts, coinbase checks
```

How it works, in the order a share travels:

1. The node builds block templates; the pool logs in to its stratum and gets a `job` (PoW input,
   network difficulty, height).
2. A miner logs in with `<address>.<worker>`; the pool assigns a nonce prefix so no two miners
   search the same nonces, and sends the job with the worker's own difficulty (vardiff, about one
   share every ten seconds).
3. Each `solution` is checked structurally and against the share difficulty by the oracle. A
   rejected share carries the reason (`collision`, `duplicate index`, `index order`,
   `nonzero result`, `difficulty not reached`, `stale`, `duplicate share`).
4. A share that also reaches the network difficulty is sent to the node. When the node accepts it,
   the block is recorded with its effort, and credits are written: PPLNS over the last
   `pplns_window` × difficulty of shares, or the whole block to the solo finder, minus the fee.
5. After `maturity` blocks each block is checked twice: the coinbase UTXO in the wallet (type
   `mine`, maturity = height + 240, Beam's rule) and the block hash at that height on the chain
   (explorer). On the chain and in the wallet: `confirmed`, credits move to balances. Replaced
   on the chain: `orphaned`, credits dropped. On the chain but not in the wallet: `unverified`,
   nothing moves until an operator checks the miner key. Without wallet verification every
   mature block is `unverified`.
6. Every `payout_interval_secs`, balances above `min_payout_groth` are paid, one transaction per
   miner with a pool-chosen `txId`, the network fee deducted from the payout (shielded payouts to
   offline addresses cost about 0.01 BEAM). A crash at any point is resolved by `tx_status(txId)`.
   Only one pool process may run against a database (PostgreSQL advisory lock).

## Run

A full server setup, from packages to firewall, is in [`docs/deploy.md`](../../docs/deploy.md).

```sh
cargo build --release
cp pool.example.toml pool.toml   # edit
./target/release/bumblebeam-pool pool.toml
```

Node side: `beam-node --stratum_port=8101 --stratum_secrets_path=<dir with stratum.crt,
stratum.key, stratum.api.keys> --miner_key=<from beam-wallet export_miner_key> --pass=<key pass>`.
Wallet side: `wallet-api --node_addr=127.0.0.1:10000 --wallet_path=wallet.db --pass=<pass>
--port=10001 --use_http=1 --ip_whitelist=127.0.0.1`. Anyone who can reach that port can call
`tx_send`, so bind it to loopback or a private interface, keep the firewall closed, and consider
`--use_acl` with the key in `wallet_api.acl_key`.

Before the first payout run `bumblebeam-pool pool.toml admin probe-txid [groth] [address]` once,
with a little balance in the wallet: it pays 0.001 BEAM three times (to the wallet's own fresh
address unless you give one): a fresh id, the same id again, which must be refused, and a control
with another fresh id, which must go through so the refusal cannot have been about funds. It
records the proof and the wallet's exact error texts in `meta`. Only with that proof does the pool resend interrupted payments automatically;
without it they go to `review`.

Operator decisions. Blocks the checks could not settle are `unverified`; payments the pool could
not resolve are `review`. `bumblebeam-pool pool.toml admin list` shows both and whether the proof
above exists. `admin block <height> confirm|orphan` pays or drops a
block's credits (a still-pending block needs `--force`). `admin payment <txid> sent|refund` marks
a payment as sent (it is then polled for its kernel) or returns the debit; a refund first asks the
wallet and is refused while the wallet knows the transaction, when the payment was ever accepted
by the wallet, or when it is less than an hour old; `--force` overrides. Decide with the
wallet's transaction list and the chain in front of you.

`admin merge <from address> <to address>` moves what a rig mined under a wrong address (shares,
block credits, found blocks, unpaid balance) to the right one; a miner never paid is deleted, one
already paid keeps its payout history. It is refused while a payment of the old address is in
flight and for coinbase accounts.

The same actions are in the operator's dashboard at `/admin`, on when `[admin] token` (24+
characters, `openssl rand -hex 24`) is set: the decisions above, live stratum connections with
their agent, port, difficulty and shares (and a button to end one), the connections that ended
before a login with what they sent first and why they ended (a rental service's checker, TLS on a
plain port), and the miners with the move above. The API is in [`../API.md`](../API.md).

`block_check_urls` lists explorer-node APIs (`/block?height=`) tried in order. None of them can
confirm a block by itself: only the wallet's coinbase confirms; an explorer orphans a block whose
height shows another hash when the wallet has no coinbase either, and otherwise only corroborates.
Put your own `explorer-node` first (it ships with Beam; it is a full node of its own with an HTTP
API, so it needs its own sync and disk, and doubles as an archival node) and a public one, such
as `https://explorer.0xmx.net/api/block?height=`, as the fallback.

Operations: payouts lock a whole UTXO each (coinbases are 25 BEAM), so a wallet with few large
coins runs out of `available` during a run and the rest is postponed to the next one. Splitting
coins now and then (`tx_split` in wallet-api) keeps payouts flowing. Shares are kept for seven
days, hashrate samples for 31 (the month chart).

## Not yet

Hot standby switch under 100 ms (today a dead node is replaced within seconds), publishing PPLNS
rounds for audit, automatic coin splitting, and rate limits beyond the per-address connection cap.