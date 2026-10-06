# bumblebeam pool: HTTP API

The contract between the pool server and its web UI (`pool/web`). All responses are JSON and all
endpoints are `GET`. Nothing public links an address to a hashrate or a balance (see `/api/miners`). Amounts are in **groth** (1 BEAM = 10⁸ groth) as integers, hashrates in
**Sol/s**, times in **unix seconds**, and `effort` is a ratio (1.0 = average luck). CORS is open
(`*`). The UI treats every field as untrusted: numbers are coerced, strings are length-capped and
escaped before they reach the page, so a field with HTML in it is shown as text, never rendered.

## `GET /api/stats`

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
  "config": { "fee": 0.5, "soloFee": 0.5, "minPayout": 10000000, "payoutScheme": "PPLNS",
              "pplnsWindow": 2.0, "blockReward": 2500000000, "maturity": 240, "payoutInterval": 7200 },
  "charts": { "hashrate": [[1791300000, 5120.0], [1791300600, 5301.2]] },
  "blocks24h": 31, "effort24h": 0.94
}
```

- `fee` and `soloFee` are percentages. The pool's fee is **0.5%** on both PPLNS and solo rewards.
- `blockReward` is the miner reward at the current height from the core's emission rule (80 BEAM
  in year one, then 40, **25 today**, 12.5 from height 4,730,400, halving every 2,102,400 blocks).
  When the field is missing the UI derives it from `nodes[0].height` with the same rule.
- `effort24h` is the average effort of the blocks found in the last 24 hours (shares spent /
  expected). It replaces the inverse "luck" figure: one direction, below 1.0 is good luck.
- `payoutInterval` is the seconds between payout runs.

## `GET /api/blocks?limit=50&before=<height>`

The blocks the pool found, newest first; `before` pages further back. `status` is `pending`
(fewer than `maturity` confirmations), `confirmed` or `orphaned`.

```json
{ "blocks": [{ "height": 4068700, "hash": "…", "ts": 1791320000, "reward": 2500000000,
               "fees": 1100000, "effort": 0.82, "status": "pending", "confirmations": 10,
               "finder": "rig1", "mode": "pplns" }] }
```

## `GET /api/miners?limit=50`

Miners by current hashrate, **without addresses**. Beam is a private chain and the pool keeps it
that way: nothing in the public API links a hashrate to a wallet. A miner's own page is reachable
only through `/api/miners/<address>`, and offline addresses are long enough that they cannot be
guessed.

```json
{ "miners": [{ "hashrate": 52.1, "hashrate24h": 50.7, "workers": 2, "lastShare": 1791321590 }] }
```

## `GET /api/miners/<address>`

```json
{ "address": "…", "hashrate": 52.1, "hashrate24h": 50.7, "balance": 812345678,
  "immature": 125000000, "paid": 12500000000, "lastShare": 1791321590,
  "workers": [{ "name": "rig1", "hashrate": 52.1, "hashrate24h": 50.7, "lastShare": 1791321590,
                "online": true, "stale": 0.012, "rejected": 0.001 }],
  "charts": { "hashrate": [[1791300000, 49.8]] },
  "payments": [{ "ts": 1791300000, "amount": 1000000000, "kernel": "…" }] }
```

`stale` and `rejected` are the worker's share of stale and rejected shares over 24 hours. The
stratum server tells the miner *why* a share was rejected, using the oracle's own error names
(`collision`, `duplicate index`, `index order`, `nonzero result`, `difficulty not reached`), so a
miner can tell a broken kernel from a slow connection.

## `GET /api/payments?limit=50`

Pool payouts, newest first: `{ "payments": [{ "ts", "amount", "miners", "kernel" }] }`. `kernel` is
the Beam kernel ID of the payout transaction and can be checked in any explorer.

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

## Payout addresses

Beam transactions are interactive. A **regular** wallet address expires (24 hours by default) and
needs the receiving wallet online while the payout is built, so payouts to it fail whenever the
miner's wallet is closed. The pool therefore asks for an **offline address** (also called a
permanent or public offline address), which any Beam wallet can generate under "Receive". The
stratum login is validated at connect time: a regular address is accepted for mining but the
miner gets a warning in the login response and on the miner page, and the balance accrues until an
offline address is set by logging in with it from the same workers.

## Stratum ports

| Port | Mode | TLS |
|---|---|---|
| 3333 | PPLNS | no |
| 3334 | SOLO | no |
| 3443 | PPLNS | yes |
| 3444 | SOLO | yes |

The login is `<wallet address>.<worker name>`, and every Beam miner speaks the protocol unchanged:
Beam's own stratum dialect from `pow/stratum.h` in the core. Share difficulty is per worker
(vardiff), aimed at about one share every ten seconds.
