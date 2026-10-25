---
name: bumblebeam-pool
description: Check the BumbleBeam mining pool for Beam (BEAM) - pool hashrate, miners and workers, blocks found, payouts, fees, a miner's balance and workers by payout address, how to connect a miner, and the hashrate of every Beam pool. Use when asked about mining BEAM, the BumbleBeam pool, a miner's stats or payouts, or Beam network hashrate.
---

# BumbleBeam Pool

Open-source PPLNS and SOLO pool for Beam's BeamHash III, 0.5% fee. Site
`https://pool.bumblebeam.org`, JSON API under `https://pool.bumblebeam.org/api/`, no key. The MCP
server at `https://pool.bumblebeam.org/mcp` has `pool_*` tools that do the same.

## Endpoints

| need | call |
|---|---|
| pool at a glance: hashrate (Sol/s), miners, workers, blocks 24h (`blocksFound24H`), blocks still confirming (`immatureTotal`), effort, fee, min payout (`minPay`, BEAM), payout interval, ports, `connectedWorkers` (null when the stratum half does not answer) | `/api/stats` (`?range=24h|7d|30d` for the chart) |
| is it up, does it have work | `/api/health` (`ok`, `role`, `node`, `jobAgeSecs`, `uptime`, `workers`, `stratum`; HTTP 503 when not ok) |
| blocks the pool found, status and confirmations | `/api/blocks?limit=50&before=<height>` (a block's time is `timestamp`) |
| every height the pool found, compact: is this block ours? how many confirmed? | `/api/blocks/heights` (`[height, mode, status]`, orphans left out) |
| how a block was split, to recompute a credit | `/api/blocks/{height}?address=` (fee, bonus, `window`, `total`, credits with `difficulty` and `amount`; share credit = floor(`shared` × `difficulty` / `total`)) |
| top miners by hashrate (no addresses) | `/api/miners?limit=50` |
| one miner by payout address | `/api/miners/{address}` (hashrate, `balance` unpaid, `immature`, `paid`, workers, payments with `fee` and `status`, `blocksFound`, `payoutFailures` when payouts keep failing; `?worker=<name>&since=<unix s>` adds `blocksSince`, that worker's blocks since then) |
| payout runs | `/api/payments?limit=50` |
| Beam network, BEAM price, every Beam pool | `/api/network` (`height`, `difficulty`, `avgBlock`, `hashrate`, `blocks24h` from the chain; `priceUsd`; `pools`) |
| the latest network blocks and which pool found each | `/api/network/blocks?limit=50&before=<height>&pool=<id>` (`pool`, `poolName`; `null` = no listed pool) |

```sh
curl -s https://pool.bumblebeam.org/api/stats | jq '{hashrate, minersTotal, workersTotal, blocksFound24H}'
curl -s "https://pool.bumblebeam.org/api/miners/$ADDRESS" | jq '{hashrate, balance, immature, paid, blocksFound}'
```

## Reading the answers

- `/api/health` answers HTTP **503** (same JSON body, `ok: false`) when the pool has no template,
  the template is 10 minutes old or more, or the stratum half is down (`stratum: "down"`,
  `workers: null`). Read the body; do not treat the 503 as "no answer".
- `payoutFailures` `{count, lastAt, reason, nextTryAt}` appears only while payouts to the
  address fail (a regular address whose wallet is offline): `count` failures since the last
  completed payout, the wallet's `reason`, and `nextTryAt`, the next try (the pause doubles from
  2 h up to a day). An offline address avoids it.
- Caching: `/api/stats`, `/api/blocks` and `/api/miningboard` may be up to 10 s old, `/api/miners`,
  `/api/payments` and `/api/blocks/heights` up to 30 s (`Cache-Control: public, max-age=…`). A
  miner's own page and health are never cached. Polling faster gains nothing.

- **Pool amounts are in groth** (1 BEAM = 100,000,000 groth): divide `balance`, `paid`,
  `reward` by 1e8 (`/api/stats` `minPay` alone is already in BEAM). Hashrates are Sol/s. Times are unix seconds.
- `immature` is the miner's share of blocks still confirming: Beam coinbase matures after 240
  blocks (about 4 hours); then it moves to `balance` (unpaid) and is paid at the next run once
  above `minPay`. An orphaned block's share disappears.
- A miner's address is private on Beam; the pool shows a miner only to whoever has the address.
- Network `hashrate` is now: the pools' own current figures scaled up by the part of the day's
  blocks no listed pool found (`othersHashrate`, `othersBlocks24h`: solo nodes, private pools).
  `chainHashrate` is the chain's 24 h estimate. A pool's share is its `hashrate` / `hashrate`; a
  pool's reward a day ≈ `blocks24h` × 25 BEAM, in USD × `priceUsd`.
- Block `status`: `pending` (confirming), `confirmed`, `orphaned`, `unverified` (waits for the
  operator).
- Everything network-wide comes from BumbleBeam's own Beam node (chain numbers, the oracle price,
  block hashes) and each pool's own API checked against it; a third-party aggregator (the Beam
  Terminal) only fills what no pool reports. MCP: `pool_network`, `pool_network_blocks`.

## Connecting a miner

Stratum host `stratum.bumblebeam.org`: PPLNS `3333` (TCP) / `3443` (TLS), SOLO `3334` / `3444`.
User `<offline Beam address>.<worker>`; an offline (permanent) address is needed so payouts
arrive while the wallet is closed. Miners: MXBM (open source, GPU), lolMiner, GMiner,
bumblebeam-miner (CPU). Example: `lolMiner --algo BEAM-III --pool stratum.bumblebeam.org:3443 --user <address>.rig1 --tls on`.

Full reference: https://github.com/profinch/bumblebeam/blob/main/pool/API.md
