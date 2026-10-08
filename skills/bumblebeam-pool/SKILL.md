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
| pool at a glance: hashrate (Sol/s), miners, workers, blocks 24h, effort, fee, min payout, payout interval, ports | `/api/stats` (`?range=24h|7d|30d` for the chart) |
| is it up, does it have work | `/api/health` |
| blocks the pool found, status and confirmations | `/api/blocks?limit=50&before=<height>` |
| top miners by hashrate (no addresses) | `/api/miners?limit=50` |
| one miner by payout address | `/api/miners/{address}` (hashrate, `balance` unpaid, `immature`, `paid`, workers, payments, `blocksFound`) |
| payout runs | `/api/payments?limit=50` |
| Beam network and every Beam pool | `/api/network` |

```sh
curl -s https://pool.bumblebeam.org/api/stats | jq '{hashrate, minersTotal, workersTotal, blocks24h}'
curl -s "https://pool.bumblebeam.org/api/miners/$ADDRESS" | jq '{hashrate, balance, immature, paid, blocksFound}'
```

## Reading the answers

- **Pool amounts are in groth** (1 BEAM = 100,000,000 groth): divide `balance`, `paid`,
  `minPayout`, `reward` by 1e8. Hashrates are Sol/s. Times are unix seconds.
- `immature` is the miner's share of blocks still confirming: Beam coinbase matures after 240
  blocks (about 4 hours); then it moves to `balance` (unpaid) and is paid at the next run once
  above `minPayout`. An orphaned block's share disappears.
- A miner's address is private on Beam; the pool shows a miner only to whoever has the address.
- Block `status`: `pending` (confirming), `confirmed`, `orphaned`, `unverified` (waits for the
  operator).

## Connecting a miner

Stratum host `stratum.bumblebeam.org`: PPLNS `3333` (TCP) / `3443` (TLS), SOLO `3334` / `3444`.
User `<offline Beam address>.<worker>`; an offline (permanent) address is needed so payouts
arrive while the wallet is closed. Miners: MXBM (open source, GPU), lolMiner, GMiner,
bumblebeam-miner (CPU). Example: `lolMiner --algo BEAM-III --pool stratum.bumblebeam.org:3443 --user <address>.rig1 --tls on`.

Full reference: https://github.com/profinch/bumblebeam/blob/main/pool/API.md
