# bumblebeam pool: HTTP API

The contract between the pool server and its web UI (`pool/web`). All responses are JSON and all
endpoints are `GET`. Amounts are in **groth** (1 BEAM = 10⁸ groth) as integers, hashrates in
**Sol/s**, and times in **unix seconds**. CORS is open (`*`).

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
              "pplnsWindow": 2.0, "blockReward": 2500000000, "maturity": 240 },
  "charts": { "hashrate": [[1791300000, 5120.0], [1791300600, 5301.2]] },
  "blocks24h": 31, "luck24h": 0.94
}
```

## `GET /api/blocks?limit=50&before=<height>`

The blocks the pool found, newest first. `status` is `pending` (fewer than 240 confirmations),
`confirmed` or `orphaned`. `effort` is the shares spent on the round divided by the network
difficulty (1.0 = average luck).

```json
{ "blocks": [{ "height": 4068700, "hash": "…", "ts": 1791320000, "reward": 2500000000,
               "fees": 1100000, "effort": 0.82, "status": "pending", "confirmations": 10,
               "finder": "rig1", "mode": "pplns" }] }
```

## `GET /api/miners?limit=50`

Top miners by current hashrate. Addresses are shortened by the server.

## `GET /api/miners/<address>`

```json
{ "address": "…", "hashrate": 52.1, "hashrate24h": 50.7, "balance": 812345678,
  "immature": 125000000, "paid": 12500000000, "lastShare": 1791321590,
  "workers": [{ "name": "rig1", "hashrate": 52.1, "hashrate24h": 50.7, "lastShare": 1791321590,
                "online": true }],
  "charts": { "hashrate": [[1791300000, 49.8]] },
  "payments": [{ "ts": 1791300000, "amount": 1000000000, "kernel": "…" }] }
```

## `GET /api/payments?limit=50`

Pool payouts, newest first: `{ "payments": [{ "ts", "amount", "miners", "kernel" }] }`. `kernel` is
the Beam kernel ID of the payout transaction and can be checked in any explorer.

## Stratum ports

| Port | Mode | TLS |
|---|---|---|
| 3333 | PPLNS | no |
| 3334 | SOLO | no |
| 3443 | PPLNS | yes |
| 3444 | SOLO | yes |

The login is `<wallet address>.<worker name>`, and every Beam miner speaks the protocol unchanged:
Beam's own stratum dialect from `pow/stratum.h` in the core.
