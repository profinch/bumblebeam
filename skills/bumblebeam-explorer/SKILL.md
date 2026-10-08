---
name: bumblebeam-explorer
description: Look up the Beam (BEAM) blockchain through BumbleBeam's explorer API - blocks, kernels (transactions), BEAM supply, confidential assets, DEX pools, BANS names and smart contracts. Use when asked about Beam blocks or transactions, a BEAM or asset amount, a Beam contract or DApp, DEX liquidity or prices, or a BANS name.
---

# BumbleBeam Explorer

Plain JSON over HTTPS from BumbleBeam's own Beam nodes. Base URL `https://explorer.bumblebeam.org`,
no key. If the `bumblebeam` MCP server is connected, its `explorer_*` tools do the same.

## What Beam does and does not show

Beam is private (Mimblewimble + Lelantus). **There are no addresses, balances or transfer amounts
on the chain**, so never promise them. Public: blocks, kernels (one per transaction: fee, heights,
decoded contract calls), outputs and inputs as commitments, coinbase rewards, confidential assets
(supply, issuer key, metadata), contracts (state, locked funds, calls), DEX pools, BANS names, BEAM
supply.

## Start with search

`GET /v1/search?q=<anything>` says what a string is and where to read it: a height -> `block`,
64 hex -> `kernel` or `contract`, `#7` / `asset 7` / `beam` -> `asset`, a name or ticker ->
`assets`, a BANS name -> `name`, a contract kind (`dex`, `nephrite`) -> `contracts`.

## Endpoints

| need | call |
|---|---|
| chain tip, peers | `/v1/status` |
| BEAM issued, max supply | `/v1/supply` |
| latest blocks / paging | `/v1/blocks?limit=20` then `&before=<next_before>` |
| one block | `/v1/blocks/{height}` |
| a transaction | `/v1/kernels/{kernel_id}` |
| assets (name, ticker, decimals, supply, issuer, description) | `/v1/assets?q=…`, `/v1/assets/{id}` (0 = BEAM) |
| DEX pools, reserves, rates | `/v1/dex/pools?asset=nph&tier=High` (`all=1` adds empty pools) |
| BANS names | `/v1/names?q=…&status=active&for_sale=1`, `/v1/names/{name}` |
| contracts | `/v1/contracts?kind=dex`, `/v1/contracts/{id}?calls=20` |

```sh
curl -s https://explorer.bumblebeam.org/v1/status
curl -s 'https://explorer.bumblebeam.org/v1/search?q=beamx'
curl -s 'https://explorer.bumblebeam.org/v1/dex/pools?asset=0' | jq '.pools[:5]'
```

## Reading the answers

- Amounts are **decimal strings in whole units** of their asset (each asset has its own `decimals`
  from `NTH_RATIO`; BEAM has 8). Compare them as numbers, not strings.
- Times: `time` (ISO, UTC) and `timestamp` (unix). Name registration and expiry times are
  interpolated from block times; future expiry assumes a block a minute.
- `kind: null` on a contract means Beam's parser does not know it; its `state` is then empty.
- A DEX `rate_1_2` is as the contract reports it; derive prices from `reserve1` / `reserve2` when
  in doubt.
- There is **no lookup by block hash** on Beam; search by height instead.
- Limits: 20 requests a second per IP (bursts of 40). Page with `before`, do not loop fast.

Full reference: https://github.com/profinch/bumblebeam/blob/main/explorer/API.md
