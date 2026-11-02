# BumbleBeam · Puzzle

[puzzle.bumblebeam.org](https://puzzle.bumblebeam.org): the Bitcoin puzzle (the 2015 transaction
`08389f34…cd15` to 256 addresses, the key of #N in [2^(N-1), 2^N - 1]) live from our own Bitcoin node.

| Part | What |
|---|---|
| [`api/server.js`](api/server.js) | Node 20+, no dependencies. Reads the first 160 outputs' addresses and their whole history from a node's mempool/esplora REST API, works out for each puzzle: balance, solved (the first spend that took at least half, net of change), public key exposed (a spend a day or more before the solve), claiming (a spend waiting in the mempool). Serves `/api/puzzles`, `/api/puzzles/{n}` (with history), `/api/events` (the radar), `/api/health`. Optional Telegram posts for radar events |
| [`web/`](web) | The site on [`ui/`](../../ui) with the Bitcoin accent: tiles, the next target, the odds calculator (brute force; kangaroo where the public key is known; electricity against the expected win), the radar, all 160 puzzles. English and Russian |

## API environment

| Variable | |
|---|---|
| `NODE_API` | the node's REST API base, `https://<node>/api` (required; set on the server, never in the repo) |
| `DATA_DIR` | `state.json` (default `/data`) |
| `POLL_SECONDS` | open puzzles are polled this often (60); solved ones every 30 min |
| `TG_BOT_TOKEN`, `TG_CHAT_ID`, `TG_LANG` | radar posts (solved, claiming in mempool, public key exposed, top-up, next target); off while empty. Posts start only after the first full read, so a fresh start sends nothing |

Deploy: images `bumblebeam-puzzle-web` and `bumblebeam-puzzle-api` from CI (`.github/workflows/images.yml`),
services `puzzle-web` / `puzzle-api` in `deploy/docker/compose-bumblebeam.yaml`, `PUZZLE_*` lines in the server's `.env`.

## Plan

1. **Showcase (live):** the status table, the odds calculator, the radar.
2. Learning: solve small puzzles (#20–#40) in the browser, Kangaroo and BSGS demos.
3. The WebGPU engine (secp256k1, SHA-256, RIPEMD-160, self-test) and a public GPU benchmark.
4. The coordinator: non-overlapping chunks with check keys, live stats, referral links; the finder keeps 6 of 7.1 BTC; the
   claim is signed in the browser and sent through private relays only.
5. Later: a native client, a Telegram bot, API and MCP.
