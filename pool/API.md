# bumblebeam pool: HTTP API

The contract between the pool server and its web UI (`pool/web`). All responses are JSON and all
endpoints are `GET`. Nothing public links an address to a hashrate or a balance (see `/api/miners`). Amounts are in **groth** (1 BEAM = 10⁸ groth) as integers, hashrates in
**Sol/s**, times in **unix seconds**, and `effort` is a ratio (1.0 = average luck). CORS is open
(`*`). The UI treats every field as untrusted: numbers are coerced, strings are length-capped and
escaped before they reach the page, so a field with HTML in it is shown as text, never rendered.

## `GET /api/stats?range=24h`

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
  "blocks24h": 31, "effort24h": 0.94
}
```

- `name` is the pool's display name. `config.stratumHost` and `config.ports` (`pplns`, `solo`,
  `pplnsTls`, `soloTls`) tell the UI where miners connect; `connectedWorkers` counts open stratum connections; `nodes[0].connected` says
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
  recorded per block (`fees`) for transparency and are close to zero on Beam today.
- `blockReward` is the miner reward at the current height from the core's emission rule (80 BEAM
  in year one, then 40, **25 today**, 12.5 from height 4,730,400, halving every 2,102,400 blocks).
  When the field is missing the UI derives it from `nodes[0].height` with the same rule.
- `effort24h` is the average effort of the blocks found in the last 24 hours (shares spent /
  expected). It replaces the inverse "luck" figure: one direction, below 1.0 is good luck.
- `payoutInterval` is the seconds between payout runs.
- `charts.hashrate` is `[unix seconds, Sol/s]` pairs. `?range=24h` (default), `7d` or `30d` picks
  the span: one point per minute, per hour or per four hours, each the average over its interval.
  Samples are kept for 31 days.

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

## `GET /api/miners?limit=50`

Miners by current hashrate, **without addresses**. Beam is a private chain and the pool keeps it
that way: nothing in the public API links a hashrate to a wallet. A miner's own page is reachable
only through `/api/miners/<address>`, and offline addresses are long enough that they cannot be
guessed.

```json
{ "miners": [{ "hashrate": 52.1, "hashrate24h": 50.7, "workers": 2, "lastShare": 1791321590 }] }
```

## `GET /api/miners/<address>?range=24h`

```json
{ "address": "…", "hashrate": 52.1, "hashrate24h": 50.7, "balance": 812345678,
  "immature": 125000000, "paid": 12500000000, "lastShare": 1791321590,
  "workers": [{ "name": "rig1", "hashrate": 52.1, "hashrate24h": 50.7, "lastShare": 1791321590,
                "online": true, "stale": 0.012, "rejected": 0.001 }],
  "charts": { "hashrate": [[1791300000, 49.8]] },
  "payments": [{ "ts": 1791300000, "amount": 1000000000, "kernel": "…" }] }
```

`charts.hashrate` takes `?range=` as in `/api/stats`; minutes without shares count as zero.
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
