# bumblebeam pool: HTTP API

The contract between the pool server and its web UI (`pool/web`). All responses are JSON. The public
routes are `GET` except `POST /api/benchmarks` and `POST /api/coinbase/pairs`; the operator's actions
are `POST` too. The pages come from `pool-web` (nginx); on pool.bumblebeam.org the host's nginx sends
`/api/*` to the pool's app process and everything else to `pool-web`. An unknown `/api` route is a
404 with `{ "error": "no such endpoint" }`, never a page. Nothing public links an address to a hashrate or a balance (see `/api/miners`). Amounts are in **groth** (1 BEAM = 10⁸ groth) as integers, hashrates in
**Sol/s**, times in **unix seconds**, and `effort` is a ratio (1.0 = average luck). CORS is open
(`*`). The UI treats every field as untrusted: numbers are coerced, strings are length-capped and
escaped before they reach the page, so a field with HTML in it is shown as text, never rendered.

Caching: the polled public routes keep their `200` answers in memory per URL (the path and the
parameters the route reads) and send `Cache-Control: public, max-age=<ttl>`: 10 s for `/api/stats`,
`/api/blocks` and `/api/miningboard`, 30 s for `/api/blocks/heights`, `/api/miners`, `/api/payments`
and `GET /api/benchmarks`. Only `GET` is cached. `/api/health`, `/api/miners/<address>`,
`/api/blocks/<height>`, `/api/network*`, `/api/coinbase*` and the operator's API are not
(`/api/network` has its own 30 s cache of the upstream data, see below).

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
  "nodes": [{ "name": "beam-node", "height": "4068710", "difficulty": "2719891.5",
              "networkhashps": "45570", "lastBeat": "1791321596", "connected": true }],
  "name": "BumbleBeam",
  "config": { "fee": 0.5, "soloFee": 0.5, "finderBonus": 1.0,
              "pplnsWindow": 2.0, "blockReward": 2500000000, "maturity": 240, "payoutInterval": 7200 },
  "charts": { "hashrate": [[1791300000, 5120.0], [1791300600, 5301.2]], "peak": [1791300420, 6890.4] },
  "modes": {
    "pplns": { "hashrate": 5180.2, "miners": 39, "workers": 94, "blocks24h": 30, "lastBlockFound": 1791321278,
               "series": [[1791234000, 5011.7]] },
    "solo":  { "hashrate": 50.2, "miners": 2, "workers": 3, "blocks24h": 1, "lastBlockFound": 1791290000,
               "series": [[1791234000, 48.1]] }
  },
  "effort24h": 0.94, "connectedWorkers": 95,
  "now": 1791321600000, "candidatesTotal": 0, "immatureTotal": 12, "maturedTotal": 306,
  "coin": "BEAM", "feePercent": 0.5, "minPay": 0.1, "feeType": "PPLNS", "timestampMilliSeconds": 1791321600000,
  "miners": 41, "workers": 97, "blockHeight": 4068710, "blocksFound24H": 31,
  "lastBlocksFound": [{ "blockNumber": 4068700, "timestampMilliSeconds": 1791320000000, "status": "[Maturing]" }]
}
```

- `now`, `candidatesTotal`, `immatureTotal` and `maturedTotal` complete the open-ethereum-pool shape
  (2Miners' `/api/stats`): `now` in milliseconds, the totals over all blocks, not one page of
  `/api/blocks`. `immatureTotal` counts every block still waiting for maturity or an operator's
  verdict (`pending` and `unverified`); `candidates` is always empty here, as in `/api/blocks`.
- `coin` … `lastBlocksFound` are the pool in the report other Beam pools publish for
  MiningPoolStats (SunPool's `pool-info.php?miningpoolstats`); `hashrate` is that report's field too,
  its `name` (the coin's) is left out because ours is the pool's. They are the only place for the
  minimum payout (`minPay`, in BEAM), the scheme (`feeType`) and the blocks found in 24 hours
  (`blocksFound24H`, orphans left out). `lastBlocksFound` is the last 20 blocks the chain kept,
  `[Available]` once confirmed and `[Maturing]` before.
- Removed 2026-10-25, each a copy of a field above: `blocksPending` (= `immatureTotal`),
  `blocks24h` (= `blocksFound24H`), `config.minPayout` (= `minPay` × 1e8), `config.payoutScheme`
  (= `feeType`). `config.fee` stays.

- `name` is the pool's display name. `config.stratumHost` and `config.ports` (`pplns`, `solo`,
  `pplnsTls`, `soloTls`) tell the UI where miners connect, `config.nodeAddr` (`host:port`, empty if
  not offered) where wallets can reach the pool's node; `nodes[0].connected` says whether the pool
  currently has a block template from its node, `nodes[0].lastBeat` when that template arrived.
- `connectedWorkers` counts the logged-in stratum connections now. It is `null` when the stratum
  process does not answer (see [two processes](#two-processes)); there is no fallback to an older
  value. `workersTotal` counts the workers with shares in the last 10 minutes, from the database.
- `fee` and `soloFee` are percentages. The pool's fee is **0.5%** on both PPLNS and solo rewards.
- `finderBonus` is the percentage of a PPLNS block, after the fee, credited to the miner whose share
  found it, on top of that miner's PPLNS part; the rest of the pot is shared as usual. It is written
  as a separate credit for the block. 0 means no bonus; solo already pays the finder the whole block.
- `minerPaysTxFee` and `txFee`: Beam's network fee comes out of each payout. A payout to an
  offline, max-privacy or public-offline address is a shielded transaction and costs about
  0.01 BEAM; to a regular address about 0.00001 BEAM. The wallet is asked for the exact fee
  (`calc_change`) at payout time; `txFee` holds the fallbacks. This is why `minPay` defaults to
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
- `charts.peak` is the range's highest one-minute hashrate, `[unix seconds, Sol/s]` (null without
  data). The `7d` and `30d` points are hourly and four-hourly averages, which flatten a short peak;
  this one is not, so the week's peak is never below the day's.
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
{ "blocks": [{ "height": 4068700, "hash": "…", "timestamp": 1791320000, "reward": 2500000000,
               "fees": 1100000, "effort": 0.82, "status": "pending", "confirmations": 10,
               "finder": "rig1", "mode": "pplns",
               "difficulty": 2719891.5, "shares": 2230272.0, "orphan": false }],
  "matured": [], "immature": [{ "height": 4068700, "…": "…" }], "candidates": [],
  "maturedTotal": 306, "immatureTotal": 12, "candidatesTotal": 0 }
```

`matured` (confirmed), `immature` (pending and unverified) and an always-empty `candidates`
repeat the same page of blocks in the open-ethereum-pool shape, so the Beam Explorer's `open-eth`
adapter credits our blocks to the pool. Orphaned blocks appear only in `blocks`. The `*Total`
fields count all blocks, not the page (with `?miner=` that miner's). A block's time
is `timestamp` (unix seconds, open-ethereum-pool's name; it was `ts` until 2026-10-25), and it also
carries that shape's `difficulty` (the network's at the block), `shares` (the round's total share
difficulty, null for blocks recorded before it was kept) and `orphan`. `finder` stays the worker's
name: addresses are never listed. The miner page's `blocks` (`/api/miners/<address>`) are the same
rows.

`?miner=<address>` keeps only the blocks that miner's shares found (an empty list for an address
the pool never saw). A block solution is written to the database (`block_submissions`) before the
node sees it. One the node accepted but that was not credited (a database error, a restart) is
credited within a minute or two. One the node never answered within 5 minutes (the link dropped, or
the stratum process stopped with the answer in flight) is marked `unanswered` and settled from the
chain: a coinbase of that height in the pool's wallet means the node took it, and it is credited
like any other block (the hash from the explorer-node); no coinbase once the wallet is 20 blocks
past it marks it `lost`.

## `GET /api/blocks/heights`

Every block the pool found that the chain kept (orphans left out), newest first, as
`[height, mode, status]` and nothing else, so a client can mark all of the pool's blocks with one
small request. The Beam Explorer and explorer.bumblebeam.org use it to badge our blocks.

```json
{ "count": 2, "blocks": [[4072327, "pplns", "pending"], [4071981, "pplns", "confirmed"]] }
```

## `GET /api/blocks/<height>?address=`

One block the pool found and how its reward was split, so anyone can recompute every credit. The
site shows it at `/blocks/<height>` and checks the arithmetic in the browser. Credits carry no
address; `address=<a>` marks that miner's rows with `"you": true`. 404 for a height the pool did
not find, 400 for one that is not a number.

```json
{
  "height": 4068500, "hash": "…", "ts": 1791675000, "mode": "pplns", "status": "confirmed",
  "reward": 2500000000, "fees": 0, "effort": 0.91, "netDifficulty": 2977786.1, "recorded": true,
  "feePercent": 0.5, "finderBonusPercent": 1.0, "window": 5955572.2, "total": 5955601.0,
  "pot": 2487500000.0, "finderBonus": 24875000, "shared": 2462625000.0,
  "credits": [
    { "kind": "share", "difficulty": 3972064.0, "amount": 1642437783, "you": true },
    { "kind": "share", "difficulty": 1983537.0, "amount": 820187216 },
    { "kind": "bonus", "difficulty": null, "amount": 24875000 }
  ]
}
```

- `window` is `pplnsWindow` × the block's network difficulty: the shares counted, newest first,
  back from the block. `total` is the difficulty actually taken: a little over `window` because the
  share that crosses the line counts whole, or under it while the pool has not yet mined a full window.
- `pot` = `reward` × (1 − `feePercent`/100); `finderBonus` = floor(`pot` × `finderBonusPercent`/100), credited
  to the rig whose share found the block; `shared` = `pot` − `finderBonus`.
- Each `share` row: `amount` = floor(`shared` × `difficulty` / `total`). Rows add up to at most `pot`;
  the rounding dust stays with the pool, as do the block's transaction `fees`.
- A solo block has one `solo` row, floor(`reward` × (1 − `feePercent`/100)), and no window.
- `recorded: false`: credited before rounds were kept (schema 7, 2026-10-11). The amounts are listed,
  `difficulty`, `window`, `total` and the percentages are null.
- `status` is the block's: credits reach balances only once it is `confirmed`; an orphaned block's
  credits are never paid.

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
  "immature": 125000000, "paid": 12500000000, "sending": 0, "lastShare": 1791321590,
  "workers": [{ "name": "rig1", "hashrate": 52.1, "hashrate24h": 50.7, "lastShare": 1791321590,
                "online": true, "stale": 0.012, "rejected": 0.001, "modes": ["pplns"] }],
  "charts": { "hashrate": [[1791300000, 49.8]], "peak": [1791300060, 61.2] },
  "payments": [{ "ts": 1791300000, "amount": 1000000000, "fee": 1000100, "kernel": "…", "status": "completed" }],
  "addressType": "offline", "coinbase": null,
  "payoutFailures": { "count": 3, "lastAt": 1791290000, "reason": "…", "nextTryAt": 1791304400 } }
```

`payments` are the latest 50, newest first, failed ones left out: `amount` is what the miner
receives, `fee` the network fee taken from it, `kernel` null until the transaction is confirmed,
`status` one of the [payment states](#payment-states) other than `failed`.

`payoutFailures` is present only while payouts to this address keep failing (a regular address
whose wallet is offline): `count` failed pool payouts since the last completed one, `lastAt` when
the last one failed, `reason` the wallet's failure reason of the latest one (may be null), and
`nextTryAt` when the payout run tries again (see [payout addresses](#payout-addresses)).

`paid` is what reached the miner's wallet; `sending` is sent and not confirmed yet (a payout the
wallet gives up on goes back to `balance`).

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

`?worker=<name>&since=<unix seconds>` adds `blocksSince`: the blocks that worker of this miner found
since then, orphans not counted. The Mac miner app uses it for its per-session count, which the 10
latest `blocks` cannot always give.

## `GET /api/benchmarks` and `POST /api/benchmarks`

Speed reports from the BumbleBeam Miner Mac app, sent only when its user turns on "Share average
speed" (off by default). A report carries the machine and the speed, never an address; the IP
is used only to allow one report per 10 minutes and is not stored.

```json
{ "app": "0.2.0", "os": "macOS 26.7.1", "arch": "arm64", "model": "Mac17,1", "chip": "Apple M5 Pro",
  "gpuCores": 16, "cpuThreads": 15, "device": "gpu", "power": 80, "solPerSec": 8.6,
  "gpuWatts": 17.5, "minutes": 30 }
```

`device` is `gpu` or `cpu`, `power` the app's slider (1-100), `solPerSec` the average over
`minutes` of mining, `gpuWatts` the miner's share of the GPU's draw when known. Text fields are
printable ASCII up to 64 characters. Answers: 200 `{ "ok": true }`, 400 with the reason, 429 for a
second report within 10 minutes. `GET` returns the last 90 days grouped by chip, device and power:
`{ "benchmarks": [{ "chip", "device", "power", "reports", "avg", "best", "gpuWatts" }] }`.

## `GET /api/payments?limit=50`

Pool payouts, newest first, one row per payout run: `{ "payments": [{ "ts", "amount", "miners",
"kernel", "status", "txs": [{ "kernel", "amount" }] }] }`. Beam pays each miner in its own
transaction, so a run has one per miner: `txs` lists all of them, with the amount and without the
address; a confirmed one has its kernel, to look it up on the chain, and one still confirming has
`"kernel": null`. `kernel` is the latest,
kept for older clients. A miner's own page lists the kernel of each payment to them. Failed payments
are refunded to the balance and not listed.

## `GET /api/health`

```json
{ "ok": true, "role": "app", "node": true, "jobAgeSecs": 12, "uptime": 86400, "workers": 41, "stratum": "up" }
```

- `role`: `all` (one process) or `app` (the API half of [two processes](#two-processes)).
- `node`: the pool has a block template from its node (false while the node syncs). In `run app`
  it comes from the stratum process's heartbeat in the database; a beat over a minute old counts
  as no template.
- `jobAgeSecs`: seconds since that template arrived, null without one. A slow block keeps a
  template for minutes.
- `uptime`: seconds since this process started.
- `workers`: logged-in stratum connections; null when the stratum process does not answer.
- `stratum`: `up` or `down`, whether the stratum half answers.

`ok` is false, and the answer is HTTP **503** with the same body, when there is no template, the
template is 600 s old or more, or the stratum half does not answer. Otherwise 200. Not cached.

## `GET /api/network`

The network as the pool page shows it, cached by the pool server for 30 seconds for all visitors.
`height`, `difficulty`, `avgBlock` (seconds, over the last 60 blocks) and `blocks24h` come from an
explorer-node, the pool's own first (`pool.explorer_urls`); `priceUsd` is BEAM's price in USD, the
median of Beam's on-chain price oracle (Oracle2) from the same node, refreshed every 5 minutes.

`pools`, which the chain does not know: each pool's own API where it has a public one (2Miners,
2Miners Solo, HeroMiners, SunPool) for `hashrate`, `miners`, `workers` and `lastTs`, BumbleBeam
from its own shares and blocks, the Beam Terminal's list for the rest and for `series`. A pool's
`blocks24h` is counted from its own block lists (see `/api/network/blocks`) once the pool server has
followed that pool for a whole day without a gap; until then it is the terminal's (SunPool reports
its own), and without that either, the pool's rate over the hours already followed scaled to a
day, with those hours in `blocks24hHours` (absent on a counted figure). HeroMiners' row counts its solo miners too, as
ours does. Each part keeps its last good value while its source is down; a pool whose API does not
answer shows the terminal's numbers.

`hashrate` is the network now, in Sol/s: the pools' current figures, which they measure from
thousands of shares, over the part of the network they cover. The rest, `othersHashrate` and
`othersBlocks24h` (solo nodes, pools with no API), can only be seen in its blocks, so its part is
its share of the 24 h of blocks: `hashrate` = sum of `pools` / (1 - `othersBlocks24h` / `blocks24h`).
`chainHashrate` is the chain's own estimate, the difficulty of the last 24 h of blocks over their
time; `hashrate` falls back to it while an active pool's blocks are unknown. An hour of blocks is
±13% on luck alone, too few for a current figure. The UI falls back to the explorer directly when
this endpoint is absent.

```json
{ "hashrate": 61920.4, "chainHashrate": 53480.1, "othersHashrate": 10860.2, "othersBlocks24h": 243,
  "height": 4077447, "difficulty": 3210000.0, "avgBlock": 74.8, "blocks24h": 1382, "priceUsd": 0.0098,
  "pools": [{ "id": "2miners", "name": "2Miners", "website": "https://beam.2miners.com", "scheme": "PPLNS",
              "fee": 1, "hashrate": 31460.0, "miners": 88, "workers": 282, "blocks24h": 838,
              "lastTs": 1791845143, "series": [[1791840000, 31500.5]] }] }
```

## `GET /api/network/blocks`

The latest blocks of the chain (up to 500, newest first) from the pool's explorer-node, each with
the pool that found it, refreshed every 30 seconds. Who found a block: each listed pool's own API
names its latest blocks with their hashes (2Miners and 2Miners Solo: `/api/blocks`; HeroMiners:
`/api/stats`; SunPool: its miningpoolstats report, heights only), checked against the node's hash
at that height, so an orphan is never credited; BumbleBeam's from its own database. The Beam
Terminal's block list only fills a height no pool claims. `pool` and `poolName` are `null` for a
block no listed pool claims (solo miners, private pools).

Parameters: `limit` (1-500, default 50), `before=<height>` (only blocks below it), `pool=<id>`
(only that pool's, e.g. `2miners`, `herominers`, `bumblebeam`).

```json
{ "count": 2, "blocks": [
  { "height": 4082320, "hash": "aade819a…", "ts": 1792137956, "difficulty": 3123207.0, "pool": "2miners", "poolName": "2Miners" },
  { "height": 4082319, "hash": "5c01e2b4…", "ts": 1792137901, "difficulty": 3130014.0, "pool": null, "poolName": null } ] }
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

## `GET /api/3bminer/oui/:mac`, `GET /api/3bminer/oui?mac=a,b,...`

For [3BMiner](../3bminer)'s web UI, which runs on a miner and cannot ask the public MAC-vendor services
from a browser (they send no CORS headers). The maker of a network device by the first bytes of its MAC
(the OUI): one address in the path, or up to 64 comma-separated in `mac`. Any notation (`d0:ea:11`,
`D0-EA-11-B2-1D-6A`, `d0ea11b21d6a`); the most specific assigned block wins (/36, /28, then /24).

```json
GET /api/3bminer/oui/d0:ea:11:b2:1d:6a
{ "mac": "D0EA11B21D6A", "prefix": "D0:EA:11", "vendor": "Routerboard.com" }

GET /api/3bminer/oui?mac=d0:ea:11:b2:1d:6a,74:12:13:07:85:a6
{ "vendors": { "d0:ea:11:b2:1d:6a": "Routerboard.com", "74:12:13:07:85:a6": "Linksys USA, Inc" } }
```

`vendor` is `null` for an unassigned prefix. The list is Wireshark's `manuf` (the IEEE assignments),
fetched on first use and refreshed daily; until the first fetch succeeds the answer is `503`.

## Payout addresses

Beam transactions are interactive. A **regular** wallet address expires (24 hours by default) and
needs the receiving wallet online while the payout is built, so payouts to it fail whenever the
miner's wallet is closed. The pool therefore asks for an **offline address** (also called a
permanent or public offline address), which any Beam wallet can generate under "Receive". A
regular address is accepted at login with a warning in the login response. Balances belong to the
address that mined them: a failed payout is refunded to that balance and tried again later, and
the miner's page shows the address type and `payoutFailures`. The scheduled runs back off: after
n failed payouts since the last completed one, the next try waits 2 h × 2^(n-1) from the last
failure, at most a day (2 h, 4 h, 8 h, 16 h, then daily). An operator's payout to that one miner
does not wait.
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
429 (uploads are verified one at a time, a second apart: try again), 503 (finalizer offline, no
block template yet, or the stratum process, which holds the finalizer link, does not answer), 404
when the pool does not pay in the coinbase, 413 over 2 MB. The miner page of a `cb:` account carries a `coinbase` object:

```json
"coinbase": { "stock": [{ "value": 1048576, "count": 3 }], "stockPairs": 36, "stockValue": 12881756160,
              "minedPairs": 108, "minedValue": 38645268480, "blocks": 4, "expiredPairs": 0, "expiresAt": 4113649,
              "spentElsewhere": 0 }
```

and its payments have `kernel` of the form `coinbase@<height> <block hash>`: one payment per block
and account. Its debit leaves the balance the moment the pool's node has the block, so the next
blocks do not pay the same amount again; the payment is `pending` until the block confirms, then
`completed`; if the block is orphaned it is `failed` (and leaves the miner's `payments`), the debit is refunded and the pairs are back in
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
Beam, so the TLS ports are the ones most miners land on. Miners do not verify the certificate, so a
self-signed one works; pool.bumblebeam.org serves its Let's Encrypt wildcard. The pool re-reads the
certificate files when they change (checked every 10 minutes) and serves the new pair without a
restart; a pair that does not load, or a key that does not match its certificate, is refused and
the old one stays. Share difficulty is per worker (vardiff), aimed at about one share every ten
seconds, starting at 64. A rig that will not work below its own minimum (rented ones on
MiningRigRentals) asks for it after the worker name, `<wallet address>.<worker name>+8192`: the
difficulty starts there and vardiff does not go below it; the worker keeps its name without the
suffix. The pool assigns each connection a nonce prefix so no two rigs search the
same nonces. A connection that has not logged in after 30 s is closed, and a logged-in one after
15 minutes without a line from the miner. The server is `pool/server` (Rust).

## Operator's API

`/api/admin/*` backs the operator's dashboard at `/admin` (a page of `pool-web`). Without
`[admin] token` in pool.toml (24+ characters) every route is a 404. It takes
`Authorization: Bearer <token>` (a wrong one is 401 and logged with the client's address), answers
with `Cache-Control: no-store` and has no CORS headers. Every action is logged. An action answers
200 `{ "ok": true, "message": "…" }` or 409 `{ "ok": false, "error": "…" }` with why it was refused.
Live connections come from the stratum process: in `run app` through the
[control interface](#two-processes).

| | |
|---|---|
| `GET attention` | unverified blocks, blocks orphaned in the last 7 days (no action needed), payments in review or stuck, miners whose payouts are held, txId deduplication proof |
| `GET wallet` | the wallet's available, maturing, sending and receiving (or why it did not answer), what the miners are owed (unpaid balances, immature credits, payouts on the way) and what the pool earned in 24 h, 7 days and in all (confirmed blocks less the miners' credits, less network fees the pool paid) |
| `GET connections` | live stratum connections (peer, port, TLS, address, worker, agent, difficulty, shares) and the last 300 that ended before a login, with what they sent first and why they ended |
| `POST connections/<id>/kick` | ends a connection (409 if there is none) |
| `GET miners?q=&limit=` | miners, most recently active first, filtered by a piece of the address (`limit` default 100, at most 1000): balances, 24 h shares, hashrate and workers, `held`, `connections` (live connections now; 0 when the stratum process does not answer) and `sessions` (the last 8 IP + worker pairs it connected from, `{ip, worker, first, last}`, kept 90 days) |
| `GET miners/<id>` | one miner: workers over 7 days, block credits, payments (with `txId` and `status`, failed ones too), `connections` (its live connections; empty when the stratum process does not answer), `held` (`{at, note}` or null) |
| `GET address?a=<address>` | before a move: the address's shape, whether it is a miner here (`minerId`, `balance`) and what the wallet says of it (`wallet`: `{valid, type}`, null for a coinbase account, an address of no known shape, or without a wallet) |
| `POST miners/<id>/hold` `{"hold": true, "note": "…"}` or `{"hold": false}` | holds one miner's payouts or releases them: held, no run pays it, scheduled or the operator's, while it still mines and is credited; a payout already sent goes on; a move (`merge`) takes the hold along; not for coinbase accounts (paid in blocks) |
| `POST miners/<id>/merge` `{"to": "<address>"}` | moves shares, credits, found blocks and unpaid balance to another miner of this pool, never to a new address. It ends the miner's connections first and waits up to 5 s for them to close; it is refused (409, nothing moved) when a connection is still open or the stratum process does not answer |
| `POST blocks/<height>` `{"action": "confirm"\|"orphan", "force": false}` | as `admin block` |
| `POST payments/<txid>` `{"action": "sent"\|"refund", "force": false}` | as `admin payment` |
| `POST payouts` `{}` or `{"miner": <id>}` | a payout run now, done by the payout loop and answered with a line per miner: everyone at the threshold, or one miner's whole balance even below it (refused for a held miner) |
| `POST payouts/freeze` `{"freeze": true}` or `{"freeze": false}` | stops the scheduled payout countdown where it is, or resumes it; kept across restarts |

## Two processes

The pool binary runs as `bumblebeam-pool <pool.toml> run all|stratum|app` (no subcommand is
`run all`). pool.bumblebeam.org runs two containers from one image: `bumblebeam-pool-stratum`
(`run stratum`: the stratum ports, the node link, share checks, found blocks and their credits, the
coinbase finalizer link) and `bumblebeam-pool-app` (`run app`: this HTTP API, the operator's API,
payouts, block maturity, the explorer cache). Why and how: [`docs/pool-split.md`](../docs/pool-split.md).
`run stratum` and `run app` refuse to start without `[admin] token`.

The app reaches the stratum process over its control interface, `[control] bind` in the stratum
process (`0.0.0.0:8081` in the Docker stack, on the internal network only) and `[control] url` in
the app. Every call carries `Authorization: Bearer <admin token>`; a missing or wrong token is 401.

| route | what it answers |
|---|---|
| `GET /ctl/live` | `{live, recent, workers}`: the live connections, the recent ones that ended before a login, the logged-in count |
| `POST /ctl/kick/<id>` | `{ok}`: ends one connection |
| `POST /ctl/kick-miner/<miner id>` | `{kicked, left}`: ends a miner's connections and waits up to 5 s for them to close |
| `GET /ctl/coinbase` | the body of `GET /api/coinbase` |
| `POST /ctl/coinbase/pairs` | the answer of `POST /api/coinbase/pairs` |

The app keeps a `/ctl/live` answer 1 s and a failure 2 s. When the stratum process does not
answer: `/api/health` is 503 with `"stratum": "down"`, `connectedWorkers` and `workers` are null,
the operator's connection lists are empty or an error, a merge is refused, and `/api/coinbase*`
fails (`POST /api/coinbase/pairs` with 503). The node's height and difficulty reach the app through
the `meta` row `node_job`, which the stratum process writes on every new height and every 10 s.

## MCP for agents

`https://pool.bumblebeam.org/mcp` is the pool's MCP server (Streamable HTTP, stateless, read-only):

| tool | what it answers |
|---|---|
| `pool_stats` | pool hashrate, miners, workers, `connectedWorkers` (null when the stratum half does not answer), blocks in 24h, blocks still confirming, effort, fee, PPLNS and solo split, chart and its peak; `mode` for one mode's chart |
| `pool_blocks` | blocks the pool found, with status and finder |
| `pool_block_heights` | every block the pool found that the chain kept, as `[height, mode, status]` |
| `pool_block_round` | how one block was split: fee, finder bonus, PPLNS window, every credit; `address` marks a miner's rows |
| `pool_miner` | one miner by payout address: hashrate and its peak, balances, workers and their modes, payments, blocks, `payoutFailures` |
| `pool_miners` | top miners by hashrate with their modes; `mode` for PPLNS or solo only |
| `pool_payments` | payout runs |
| `pool_network` | Beam network (from the chain), BEAM/USD, every Beam pool |
| `pool_network_blocks` | the latest network blocks with the pool that found each, `pool` to filter |
| `pool_health` | the `/api/health` body (also when it is a 503): ok, role, node, jobAgeSecs, uptime, workers, stratum |

```sh
claude mcp add --transport http bumblebeam-pool https://pool.bumblebeam.org/mcp
```

The blockchain itself (blocks, kernels, assets, contracts) is in the explorer's MCP server,
`https://explorer.bumblebeam.org/mcp`, described in [`explorer/API.md`](../explorer/API.md).
