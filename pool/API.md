# bumblebeam pool: HTTP API

The contract between the pool server and its web UI (`pool/web`). All responses are JSON and all
endpoints are `GET`. Nothing public links an address to a hashrate or a balance (see `/api/miners`). Amounts are in **groth** (1 BEAM = 10⁸ groth) as integers, hashrates in
**Sol/s**, times in **unix seconds**, and `effort` is a ratio (1.0 = average luck). CORS is open
(`*`). The UI treats every field as untrusted: numbers are coerced, strings are length-capped and
escaped before they reach the page, so a field with HTML in it is shown as text, never rendered.

## `GET /api/stats?range=24h&mode=`

The pool at a glance. The top-level fields follow the **open-ethereum-pool** shape, so the Beam
Explorer's existing `open-eth` adapter (`BeamMW/BeamExplorer`, `backend/src/mining/adapters.ts`)
reads the pool with no code change: `hashrate`, `minersTotal`, `workersTotal`,
`stats.lastBlockFound` and `nodes[0].height`. The `config` block adds the fee and payout data that
2Miners' API does not expose.

```json
{
  "hashrate": 5230.4, "minersTotal": 41, "workersTotal": 97,
  "stats": { "lastBlockFound": 1791321278, "roundShares": 10342912 },
  "nodes": [{ "name": "beam-node-1", "height": "4068710", "difficulty": "2719891.5",
              "networkhashps": "45570", "lastBeat": "1791321596" }],
  "config": { "fee": 0.5, "soloFee": 0.5, "finderBonus": 1.0, "minPayout": 10000000, "payoutScheme": "PPLNS",
              "pplnsWindow": 2.0, "blockReward": 2500000000, "maturity": 240, "payoutInterval": 7200 },
  "charts": { "hashrate": [[1791300000, 5120.0], [1791300600, 5301.2]] },
  "modes": {
    "pplns": { "hashrate": 5180.2, "miners": 39, "workers": 94, "blocks24h": 30, "lastBlockFound": 1791321278,
               "series": [[1791234000, 5011.7]] },
    "solo":  { "hashrate": 50.2, "miners": 2, "workers": 3, "blocks24h": 1, "lastBlockFound": 1791290000,
               "series": [[1791234000, 48.1]] }
  },
  "blocks24h": 31, "effort24h": 0.94, "blocksPending": 12
}
```

- `blocksPending` counts every block still waiting for maturity or an operator's verdict
  (`pending` and `unverified`), not just those on one page of `/api/blocks`.

- `name` is the pool's display name. `config.stratumHost` and `config.ports` (`pplns`, `solo`,
  `pplnsTls`, `soloTls`) tell the UI where miners connect, `config.nodeAddr` (`host:port`, empty if
  not offered) where wallets can reach the pool's node; `connectedWorkers` counts open stratum connections; `nodes[0].connected` says
  whether the pool currently has a block template from its node.
- `fee` and `soloFee` are percentages. The pool's fee is **0.5%** on both PPLNS and solo rewards.
- `finderBonus` is the percentage of a PPLNS block, after the fee, credited to the miner whose share
  found it, on top of that miner's PPLNS part; the rest of the pot is shared as usual. It is written
  as a separate credit for the block. 0 means no bonus; solo already pays the finder the whole block.
- `minerPaysTxFee` and `txFee`: Beam's network fee comes out of each payout. A payout to an
  offline, max-privacy or public-offline address is a shielded transaction and costs about
  0.01 BEAM; to a regular address about 0.00001 BEAM. The wallet is asked for the exact fee
  (`calc_change`) at payout time; `txFee` holds the fallbacks. This is why `minPayout` defaults to
  1 BEAM.
- `blockFeesTo`: the transaction fees inside a found block go to the pool, not into PPLNS; they are
  recorded per block (`fees`) for transparency. The coinbase holds the reward plus the fees, so
  `fees` is known once the wallet confirms the block and is 0 until then.
- `blockReward` is the miner reward at the current height from the core's emission rule (80 BEAM
  in year one, then 40, **25 today**, 12.5 from height 4,730,400, halving every 2,102,400 blocks).
  When the field is missing the UI derives it from `nodes[0].height` with the same rule.
- `effort24h` is the average effort of the blocks found in the last 24 hours (shares spent /
  expected). It replaces the inverse "luck" figure: one direction, below 1.0 is good luck.
- `payoutInterval` is the seconds between payout runs.
- `charts.hashrate` is `[unix seconds, Sol/s]` pairs. `?range=24h` (default), `7d` or `30d` picks
  the span: one point per minute, per hour or per four hours, each the average over its interval.
  Samples are kept for 31 days. `?mode=pplns` or `?mode=solo` draws one mode's hashrate; without it
  the chart is both together.
- `modes` splits the pool into its PPLNS side and its solo side, as two pools: hashrate, miners and
  workers over the last 10 minutes, blocks in 24 hours, the last block, and `series`, hourly averages
  over 24 hours for a sparkline.

## `GET /api/blocks?limit=50&before=<height>`

The blocks the pool found, newest first; `before` pages further back. `status` is `pending`
(fewer than `maturity` confirmations), `confirmed`, `orphaned`, or `unverified`. A block is
confirmed when its coinbase is in the pool wallet, or, if the wallet is not consulted, when the
explorer shows our hash at that height (`verifiedBy`: `wallet`, `explorer`, `wallet+explorer`).
A block the chain replaced is `orphaned`. A block that is on the chain but whose coinbase the
wallet cannot see, or about which the wallet and the chain disagree, is `unverified`: it is
neither paid nor dropped until an operator decides (`admin block <height> confirm|orphan`). Only
the wallet's coinbase can confirm a block; the explorer alone never does.

```json
{ "blocks": [{ "height": 4068700, "hash": "…", "ts": 1791320000, "reward": 2500000000,
               "fees": 1100000, "effort": 0.82, "status": "pending", "confirmations": 10,
               "finder": "rig1", "mode": "pplns" }],
  "matured": [], "immature": [{ "height": 4068700, "…": "…" }], "candidates": [] }
```

`matured` (confirmed), `immature` (pending and unverified) and an always-empty `candidates`
repeat the same page of blocks in the open-ethereum-pool shape, so the Beam Explorer's `open-eth`
adapter credits our blocks to the pool. Orphaned blocks appear only in `blocks`.

## `GET /api/blocks/heights`

Every block the pool found that the chain kept (orphans left out), newest first, as
`[height, mode, status]` and nothing else, so a client can mark all of the pool's blocks with one
small request. The Beam Explorer and explorer.bumblebeam.org use it to badge our blocks.

```json
{ "count": 2, "blocks": [[4072327, "pplns", "pending"], [4071981, "pplns", "confirmed"]] }
```

## `GET /api/miners?limit=50&mode=`

Miners by current hashrate, **without addresses**. Beam is a private chain and the pool keeps it
that way: nothing in the public API links a hashrate to a wallet. A miner's own page is reachable
only through `/api/miners/<address>`, and offline addresses are long enough that they cannot be
guessed.

```json
{ "miners": [{ "hashrate": 52.1, "hashrate24h": 50.7, "workers": 2, "lastShare": 1791321590, "modes": ["pplns"] }] }
```

`modes` lists the modes the miner sent shares in over the last 10 minutes (`pplns`, `solo`, or both).
`?mode=pplns` or `?mode=solo` keeps only that mode's miners, with that mode's hashrate.

## `GET /api/miners/<address>?range=24h&mode=`

```json
{ "address": "…", "hashrate": 52.1, "hashrate24h": 50.7, "balance": 812345678,
  "immature": 125000000, "paid": 12500000000, "lastShare": 1791321590,
  "workers": [{ "name": "rig1", "hashrate": 52.1, "hashrate24h": 50.7, "lastShare": 1791321590,
                "online": true, "stale": 0.012, "rejected": 0.001, "modes": ["pplns"] }],
  "charts": { "hashrate": [[1791300000, 49.8]] },
  "payments": [{ "ts": 1791300000, "amount": 1000000000, "kernel": "…" }],
  "addressType": "offline", "coinbase": null }
```

`addressType` is `regular`, `offline`, `max_privacy`, `public_offline` or `coinbase`; `coinbase` is
set only for `cb:` accounts (see [coinbase payouts](#coinbase-payouts)).

`charts.hashrate` takes `?range=` as in `/api/stats`; minutes without shares count as zero.
`?mode=pplns` or `?mode=solo` narrows `hashrate`, `hashrate24h`, `workers` and the chart to that
mode's shares; balances and payments are the miner's whole account either way. `modes` lists the
modes the miner mined in over 24 hours.
`blocksFound` and `blocks24h` count the blocks this miner's shares found (orphans not counted),
`lastBlockAt` is the latest one's time, and `blocks` lists the 10 most recent in the `/api/blocks`
shape, orphans included.
`stale` and `rejected` are the worker's share of stale and rejected shares over 24 hours, counted
by the stratum server per connection and flushed once a minute. A stale share is one for a block
that was already found when it arrived; it is not credited. The
stratum server tells the miner *why* a share was rejected, using the oracle's own error names
(`collision`, `duplicate index`, `index order`, `nonzero result`, `difficulty not reached`), so a
miner can tell a broken kernel from a slow connection.

## `GET /api/payments?limit=50`

Pool payouts, newest first, one row per payout run: `{ "payments": [{ "ts", "amount", "miners",
"kernel", "status", "txs": [{ "kernel", "amount" }] }] }`. Beam pays each miner in its own
transaction, so a run has one kernel per miner: `txs` lists every one that has a kernel, with its
amount and without the address, so each payout can be looked up on the chain. `kernel` is the latest,
kept for older clients. A miner's own page lists the kernel of each payment to them. Failed payments
are refunded to the balance and not listed.

## `GET /api/health`

`{ "ok": true, "node": true, "jobAgeSecs": 12, "uptime": 86400, "workers": 41 }`. `node` is false
while the pool has no block template, for example while the node syncs.

## `GET /api/network`

The pool server's cache of the Beam Explorer's mining data, refreshed every 30 seconds for all
visitors, so a busy pool page does not hit the community explorer once per visitor. The UI falls
back to the explorer directly when this endpoint is absent.

```json
{ "hashrate": 49160.2, "height": 4068807, "difficulty": 2800123.0, "avgBlock": 57.0, "blocks24h": 1405,
  "pools": [{ "id": "2miners", "name": "2Miners", "website": "https://beam.2miners.com", "scheme": "PPLNS",
              "fee": 1, "hashrate": 35540.0, "miners": 95, "workers": 306, "blocks24h": 1048,
              "lastTs": 1791327800, "series": [[1791300000, 45031.5]] }] }
```

## `GET /api/miningboard`

The pool in MiningBoard's `miningboard-pool-v1` format ([spec](https://miningboard.com/pools/submit.md)),
which the directory polls every 5 minutes. Hashrates are in Sol/s, Beam's unit, and amounts are in
BEAM, not groth. `network` is null while the pool has no block template.

```json
{ "spec": "miningboard-pool-v1", "coin": "BEAM", "algorithm": "BeamHash III", "updated_at": "2026-10-08T03:10:00Z",
  "pool": { "hashrate": 46.6, "miners": 1, "workers": 2, "blocks_24h": 0, "last_block_at": null,
            "fee_percent": 0.5, "payout_scheme": "PPLNS", "min_payout": 1.0 },
  "network": { "hashrate": 52786.0, "height": 4070449, "difficulty": 2926199.5, "block_reward": 25.0, "block_time": 60 },
  "stratum": [{ "url": "stratum+tcp://stratum.bumblebeam.org:3333", "tls": false, "mode": "PPLNS" }] }
```

## Payout addresses

Beam transactions are interactive. A **regular** wallet address expires (24 hours by default) and
needs the receiving wallet online while the payout is built, so payouts to it fail whenever the
miner's wallet is closed. The pool therefore asks for an **offline address** (also called a
permanent or public offline address), which any Beam wallet can generate under "Receive". A
regular address is accepted at login with a warning in the login response. Balances belong to the
address that mined them: a payout to a regular address is attempted each run, a failed one is
refunded to that balance and tried again next run, and the miner's page shows the address type.
To move to an offline address, mine with it; the old balance is paid once its wallet is online.

## Coinbase payouts

With `[coinbase] enabled = true` (see `tools/coinbase/`), a miner can be paid in the blocks the pool
finds instead of by transactions. The miner's **account** is `cb:` plus a public key the `bb-coinbase`
tool derives from the wallet's miner key (66 hex characters, ending in `00` or `01`); it is the
stratum login in place of an address. The miner uploads **pairs**, coinbase outputs with their
kernels made and signed with its own keys; the pool verifies them through bb-finalizer and keeps them
in stock; when the node asks for a block's coinbase, the pool picks pairs for what each account is
owed (its balance, the credits of its blocks still confirming, and its share of this block), and the
block pays them. The pool never holds the
miner's keys, so it cannot spend these outputs. Blocks are then confirmed by the pool's own node, as
the finalizer reports the chain (`verifiedBy: "node"`).

`GET /api/coinbase`

```json
{ "enabled": true, "height": 4070449, "domain": "pool.bumblebeam.org",
  "ladder": { "shift": 20, "steps": 12, "unit": 1048576 },
  "maxPairsPerUpload": 256, "stockMaxPerAccount": 512, "kernelValidityBlocks": 43200, "expiryMarginBlocks": 100,
  "maxCoinbaseBytes": 65536, "accounts": 3, "stockPairs": 96, "minedPairs": 240,
  "finalizer": { "connected": true, "tip": 4070449, "scanned": 4070449, "lastFinalization": 1791428210, "lastMined": 1791428210, "finalizations": 1312,
                 "failStreak": 0, "poolOnlyUntil": null } }
```

Pair values are `unit × 2^k` groth for `k < steps` (0.0105 … 21.47 BEAM); the stock is topped up with
`bb-coinbase top-up`. A pair's kernel is valid for `kernelValidityBlocks` after its minimum height, and
the pool stops offering it `expiryMarginBlocks` before that.

`POST /api/coinbase/pairs`, body `{ "account": "cb:…", "ts": <unix seconds>, "pairs": ["<hex>", …], "signature": "<hex>" }`
(`bb-coinbase` sends it). The signature is over `domain` (from `GET /api/coinbase`, so it cannot be
replayed to another pool), the account, `ts` and the pairs, by the account key.
Answer:

```json
{ "account": "cb:…", "accepted": 34, "rejected": [{ "index": 2, "error": "invalid kernel signature" }],
  "stockPairs": 70, "validUntil": 4113649 }
```

Errors come as `{ "error": "…" }` with 400 (shape, signature, ladder, expiry), 409 (stock full),
429 (uploads are verified one at a time, a second apart: try again), 503 (finalizer offline, or no
block template yet). The miner page of a `cb:` account carries a `coinbase` object:

```json
"coinbase": { "stock": [{ "value": 1048576, "count": 3 }], "stockPairs": 36, "stockValue": 12881756160,
              "minedPairs": 108, "minedValue": 38645268480, "blocks": 4, "expiredPairs": 0, "expiresAt": 4113649,
              "spentElsewhere": 0 }
```

and its payments have `kernel` of the form `coinbase@<height> <block hash>`: one payment per block
and account. Its debit leaves the balance the moment the pool's node has the block, so the next
blocks do not pay the same amount again; the payment is `pending` until the block confirms, then
`completed`; if the block is orphaned it is `failed`, the debit is refunded and the pairs are back in
stock. A balance can therefore be negative for a while (a block that had paid was orphaned): the next
blocks work the advance off first, and a miner who leaves right after an orphan keeps at most that
one block's share. A block the pool's node has already replaced (its header differs) no longer
counts among the credits owed, so a reorg is felt at once, not 240 blocks later.

`finalizer.failStreak` counts coinbases with pairs the node refused in a row (it drops the finalizer
on each); from two, the finalizer answers pool-only coinbases until `poolOnlyUntil` and logs an
error: check `--mine_online_reserve` against `max_coinbase_bytes`. `spentElsewhere` counts pairs whose kernel turned
up in a block that is not the pool's (another pool on the same chain, or the miner spending its own
pair): they are simply gone from the stock, no payment is made. Such an account has no address, so
the regular payout run skips it, and `GET /api/payments` lists transactions only, not these block
payments. Solo logins are refused while coinbase payouts are on: every template already pays the
PPLNS accounts.

## Payment states

Each payment gets a transaction id chosen by the pool before anything is sent. `created`: the
miner is debited and the id recorded; `pending`: the wallet accepted `tx_send` with that id;
`completed`: the kernel id is known; `failed`: the wallet refused or the transaction failed, the
debit is back on the balance; `review`: the wallet keeps failing to answer about the id, an
operator decides; `sending`: a resend is in flight. A `created` payment left by a crash or a
timeout is first looked up with `tx_status`; if the wallet does not know it, it is sent again with
the same id, but only once `admin probe-txid` has proven that the wallet refuses a second send
with the same id (stored in `meta.txid_honored`); until then such payments go to `review`. Money is
refunded only when the wallet refuses and does not know the id.

## Stratum ports

| Port | Mode | TLS |
|---|---|---|
| 3333 | PPLNS | no |
| 3334 | SOLO | no |
| 3443 | PPLNS | yes |
| 3444 | SOLO | yes |

The login is `<wallet address>.<worker name>`, and every Beam miner speaks the protocol unchanged:
Beam's own stratum dialect from `pow/stratum.h` in the core. lolMiner and GMiner default to TLS for
Beam, so the TLS ports are the ones most miners land on; the certificate is self-signed and miners
do not verify it. Share difficulty is per worker (vardiff), aimed at about one share every ten
seconds, starting at 64. The pool assigns each connection a nonce prefix so no two rigs search the
same nonces. The server is `pool/server` (Rust).

## MCP for agents

`https://pool.bumblebeam.org/mcp` is the pool's MCP server (Streamable HTTP, stateless, read-only):

| tool | what it answers |
|---|---|
| `pool_stats` | pool hashrate, miners, workers, blocks in 24h, effort, fee, PPLNS and solo split, chart and its peak; `mode` for one mode's chart |
| `pool_blocks` | blocks the pool found, with status and finder |
| `pool_miner` | one miner by payout address: hashrate and its peak, balances, workers and their modes, payments, blocks |
| `pool_miners` | top miners by hashrate with their modes; `mode` for PPLNS or solo only |
| `pool_payments` | payout runs |
| `pool_network` | Beam network and every Beam pool |
| `pool_health` | whether the pool is up and has work |

```sh
claude mcp add --transport http bumblebeam-pool https://pool.bumblebeam.org/mcp
```

The blockchain itself (blocks, kernels, assets, contracts) is in the explorer's MCP server,
`https://explorer.bumblebeam.org/mcp`, described in [`explorer/API.md`](../explorer/API.md).
