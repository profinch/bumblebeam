# BumbleBeam · Puzzle

[puzzle.bumblebeam.org](https://puzzle.bumblebeam.org): the Bitcoin puzzle (the 2015 transaction
`08389f34…cd15` to 256 addresses, the key of #N in [2^(N-1), 2^N - 1]) live from our own Bitcoin node.

| Part | What |
|---|---|
| [`api/server.js`](api/server.js) | Node 20+, no dependencies. Reads the first 160 outputs' addresses and their whole history from a node's mempool/esplora REST API, works out for each puzzle: balance, solved (the first spend that took at least half, net of change), public key exposed (a spend a day or more before the solve), claiming (a spend waiting in the mempool). Serves `/api/puzzles`, `/api/puzzles/{n}` (with history), `/api/events` (the radar), `/api/bench` (GET the table; POST `{gpu, kind, rate}`, one a minute per client), `/api/health`. Optional Telegram posts for radar events |
| [`web/`](web) | The site on [`ui/`](../../ui) with the Bitcoin accent. English for now (the strings sit in one table in app.js). Pages: `/` (tiles, next target, odds calculator, radar, all 160 puzzles), `/play` (search a puzzle's range on the GPU or CPU; #71 as a lottery ticket), `/learn` (key → address step by step; brute force vs BSGS vs kangaroo raced live), `/bench` (GPU/CPU benchmark, results table) |
| [`web/engine/secp.js`](web/engine/secp.js) | The reference in plain JS (BigInt): secp256k1, SHA-256, RIPEMD-160, base58check, a batched brute-force searcher. Slow, simple, and what the GPU checks itself against |
| [`web/engine/gpu.js`](web/engine/gpu.js) | The WebGPU engine, own WGSL, generated: field arithmetic on 8×32-bit limbs (products from 16-bit halves); each thread checks the 2K+1 keys around a centre point (C ± i·G share the denominator, one inversion per step); SHA-256 and RIPEMD-160 on the GPU. Unrolled parts run faster but compile far slower (D3D on Windows), so the default is unrolled multiply and hashes with the inversion as a loop and one hash call site (6–9 s cold compile); dispatches are paced to ~60 ms so a laptop GPU that draws the screen stays responsive. Self-test before every use: planted keys at the centre, both sides and block edges must be found exactly, nothing without a target |
| [`web/engine/cpu-worker.js`](web/engine/cpu-worker.js) | Web Worker: brute force, baby-step giant-step, Pollard's kangaroo (parallel herds, distinguished points) on the reference |

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
2. **Learning (done):** small puzzles solved in the browser, the key → address chain, brute force / BSGS / kangaroo race.
3. **The WebGPU engine (done):** secp256k1, SHA-256, RIPEMD-160, self-test, the public benchmark page.
4. The coordinator: non-overlapping chunks with check keys, live stats, referral links; the finder keeps 6 of 7.1 BTC; the
   claim is signed in the browser and sent through private relays only.
5. Later: a native client, a Telegram bot, API and MCP.
