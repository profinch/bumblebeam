# BumbleBeam Explorer API

Read-only data on the Beam (BEAM) blockchain from BumbleBeam's own archival and explorer nodes,
for bots, scripts and agents. No key, no sign-up. Base URL: `https://explorer.bumblebeam.org`.

There are three ways in:

| | what | for |
|---|---|---|
| `/v1/…` | plain JSON, documented below; OpenAPI at [`/v1/openapi.json`](https://explorer.bumblebeam.org/v1/openapi.json) | bots and scripts |
| `/mcp` | an MCP server (Streamable HTTP) with tools for the explorer and the pool | AI agents |
| `/api/…` | Beam's own explorer-node API, passed through unchanged | anything built for explorer-node |

Beam is private by design: there are no addresses, balances or transfer amounts on the chain.
What is public, and what this API serves: blocks, kernels (one per transaction, with its fee),
outputs and inputs as commitments, confidential assets, contracts with their state and calls, the
DEX, BANS names, and BEAM's supply.

## Conventions

- **Amounts** are decimal strings in whole units, scaled by the asset's own precision (`decimals`,
  from its `NTH_RATIO` metadata; 8 when there is none, as for BEAM). `"2142.53352186"`, never
  groth. A few assets have a non-decimal ratio; their `decimals` is `null` and amounts are divided
  by `nth_ratio`.
- **Times** come twice: `time` (ISO 8601, UTC) and `timestamp` (unix seconds). Times of past
  heights without their own block (registration and expiry of names) are interpolated between real
  block times; future heights assume a block a minute.
- **IDs** (hashes, kernels, contracts, keys) are lowercase hex.
- **Errors**: `400` bad parameter, `404` not found, `502` the node did not answer, as
  `{"error": "…"}`. **Limits**: GET only (and POST on `/mcp`), 20 requests a second per IP with
  bursts of 40. CORS is open.

## `/v1` endpoints

| endpoint | returns |
|---|---|
| `GET /v1` | this list, versions and links |
| `GET /v1/status` | tip `height`, `hash`, `time`, `peers`, shielded output counts |
| `GET /v1/supply` | BEAM `issued` so far by the emission schedule, `max_supply` 262,800,000 |
| `GET /v1/search?q=` | what `q` is: `block` (a height), `kernel`, `contract`, `asset` (`#7`, `asset 7`, `beam`), `assets` (name or ticker), `name` (BANS), `contracts` (kind), or `none` |
| `GET /v1/blocks?limit=20&before=` | block headers, newest first: `height`, `hash`, `time`, `difficulty`, `transactions`, `outputs`, `inputs`, `shielded_outputs`, `shielded_inputs`, `contract_calls`, `fees_beam`; page with `before=next_before` |
| `GET /v1/blocks/{height}` | one block: header, `reward_beam`, `fees_beam`, `kernels` (with decoded contract calls in `data`), `outputs` (coinbase value, maturity, `spent_height`), `inputs` (`created_height`) |
| `GET /v1/kernels/{id}` | a kernel and the block it is in |
| `GET /v1/assets?q=` | assets: `asset_id`, `name`, `ticker`, `unit`, `decimals`, `nth_ratio`, `supply`, `owner_key`, `deposit_beam`, `lock_height`, `short_description`, links; `q` filters by name, ticker, `#id` or owner key (6+ characters) |
| `GET /v1/assets/{id}` | one asset with `long_description`, `metadata`, `history`, `distribution` (which contracts hold it) and its `dex_pools`; `0` is BEAM with `issued` and `locked_in_contracts` |
| `GET /v1/dex/pools?asset=&tier=&all=` | DEX pools: `asset1`, `asset2` (IDs and names), `volatility`, `fee`, `reserve1`, `reserve2`, `lp_token`, `lp_supply`, `rate_1_2`, `rate_2_1`; empty pools only with `all=1` |
| `GET /v1/names?q=&status=&for_sale=` | BANS names: `owner_key`, `status`, `registered_height` and `_time`, `expires_height` and `_time`, `sell_price`; `status` is `active`, `on_hold` or `expired` |
| `GET /v1/names/{name}` | one name |
| `GET /v1/contracts?q=&kind=` | contracts: `kind` (when Beam's parser knows it, else `null`), `shader`, `deployed_height`, `locked_funds`, `owned_assets` |
| `GET /v1/contracts/{id}?calls=20` | one contract: decoded `state`, `locked_funds`, `owned_assets`, `versions`, recent `calls` (a call with sub-calls is `{"calls": […]}`), `calls_next_before` |
| `GET /v1/peers` | the node's peers as `ip` and `port` |

```sh
curl -s https://explorer.bumblebeam.org/v1/status
curl -s 'https://explorer.bumblebeam.org/v1/dex/pools?asset=nph'
curl -s 'https://explorer.bumblebeam.org/v1/names?status=active&for_sale=1'
```

```python
import requests
blocks = requests.get("https://explorer.bumblebeam.org/v1/blocks", params={"limit": 50}).json()["blocks"]
```

## MCP for agents

`https://explorer.bumblebeam.org/mcp` speaks MCP over Streamable HTTP (stateless, JSON
responses, protocol 2025-06-18 back to 2024-11-05). All tools are read-only:

| explorer | pool |
|---|---|
| `explorer_status`, `explorer_search`, `explorer_latest_blocks`, `explorer_block`, `explorer_kernel`, `explorer_supply`, `explorer_assets`, `explorer_asset`, `explorer_dex_pools`, `explorer_names`, `explorer_contracts`, `explorer_contract` | `pool_stats`, `pool_blocks`, `pool_miner`, `pool_miners`, `pool_payments`, `pool_network`, `pool_health` |

```sh
claude mcp add --transport http bumblebeam https://explorer.bumblebeam.org/mcp
```

Other clients take the same URL as a remote (HTTP) MCP server. Skills that teach an agent the API
without MCP are in [`skills/`](../skills).

## `/api` — explorer-node, unchanged

`/api/status`, `/api/block?height=` or `?kernel=`, `/api/blocks?height=&n=`,
`/api/hdrs?hMax=&nMax=`, `/api/assets`, `/api/asset?id=`, `/api/contracts`, `/api/contract?id=`,
`/api/peers`: Beam's own explorer-node answers, as typed documents (`{type, value}` cells, tables
with a header row, amounts in the smallest units). Its quirks: there is no lookup by block hash, a
missing or invalid argument answers with the tip block, `hdrs` takes `hMax` and `nMax` (not
`height` and `n`), and contract call histories leave the `Emission` column out of their header.
`/v1` deals with all of that.

The pool has its own API at `https://pool.bumblebeam.org/api/…`, documented in
[`pool/API.md`](../pool/API.md).
