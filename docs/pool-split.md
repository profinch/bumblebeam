# Splitting the pool server: miners are only touched by stratum releases

Status (2026-10-23): step 0 (graceful SIGTERM) `315550c`; the P0 fixes of docs/pool-audit.md `8d5e7eb`; **steps 1-3
done in code** (`run all|stratum|app`, `ctl.rs`, per-role locks, `node_job` / `net_height` in `meta`, tested by
`tools/e2e.sh` and `tools/e2e_split.sh`); **step 4 deployed 2026-10-23 00:50** (`b1ae63f`: `bumblebeam-pool-stratum` + `bumblebeam-pool-app`); a
restart of pool-app took 0.47 s with the same 5 miner connections before and after, 0 disconnects. The re-audit of
the split (`100f324`: the login deadline, the share writer that never blocks, the TLS reload, the `node_job` beat
with `job_at`, payout backoff since the last success, the bounded micro-cache) was deployed 2026-10-23 01:45 (times here are the server's, BST).

What the app needs from the stratum process turned out to be more than the live view (audit P1): the node tip /
difficulty / job age (`meta` row `node_job`, written by the stratum process on a new height or every 10 s, read by
the app every 2 s), and the coinbase finalizer link - so the coinbase routes stay with the stratum process and the
app forwards `/api/coinbase*` to `/ctl/coinbase*`. The stratum process reads `net_height` (written by the app's
explorer cache) for its syncing-node guard.

## Why

One process, `bumblebeam-pool`, runs everything: the stratum ports and every miner connection, the node link,
share checks, block accounting, maturity checks, payouts, the explorer cache, the public API, the operator's API.
Any release restarts all of it, and every restart drops every miner:

- 2026-10-22 23:48 (measured from `shares` and the journal): our own miners and `rig1` were back 1-2 s after the
  new process listened; **NiceHash came back after 39-40 s** and sent its first share after 49 s. NiceHash is most
  of the pool's hashrate.
- Beam's stratum has no reconnect / redirect message (`pow/stratum.h`: login, job, solution, result, cancel), so a
  pool cannot move its miners politely; it can only close the connection.
- Since 2026-10-01, 54 commits touched `pool/server/src`: **37 touched no stratum code**, 5 only stratum code
  (`stratum.rs`, `upstream.rs`, `pow.rs`, `conns.rs`), 12 both. Most releases dropped the miners for nothing.

## Target: two processes from one binary

The same image and binary, the role chosen by a subcommand, so the build, the config and the database stay one:

    bumblebeam-pool pool.toml run stratum
    bumblebeam-pool pool.toml run app

| | `pool-stratum` (changes rarely) | `pool-app` (most releases) |
|---|---|---|
| modules | `stratum`, `conns`, `pow`, `upstream`, `accounting::block_found` + `credit_loop`, the share writer, `coinbase::serve` (the finalizer link, builds templates) with the coinbase data (`/api/coinbase` info, pair uploads) and `coinbase::expiry_loop`, `ctl` (serves `/ctl/*`) | `api`, `admin`, `payouts`, `accounting::confirm_loop`, `network`, hashrate samples and the hourly prune, `ctl` (the client: forwards `/api/coinbase*` to `/ctl/coinbase*`); no web dir, the pages are `pool-web`'s |
| in memory | live connections, vardiff, jobs, `node_prefix`, `connected_workers`, `job_tx` / `submit_tx` | the payout countdown (`next_payout`, `payouts_frozen_left`), `payout_tx` (the operator's "pay now"), the explorer cache |
| ports | 3333 / 3334 / 3443 / 3444 (miners), the control interface on HTTP 8081 (`[control] bind`, internal network only, the admin token as a Bearer) | 8080 (the API, behind the host nginx; the pages come from pool-web) |
| restart | drops the miners (graceful, ~1 s for most, ~40 s for NiceHash) | nobody notices |

Everything durable already goes through PostgreSQL (shares, blocks, credits, miners, payments, meta,
miner_sessions), so the two processes share state there, as today.

### What the app needs from the stratum process

Besides the node view and the coinbase link above, the operator's live view reads stratum memory. The stratum
process serves a small control interface (`ctl.rs`) over HTTP on `[control] bind` (`0.0.0.0:8081` in the Docker
stack, reachable on the internal network only); the app calls `[control] url`. Every call carries the
`[admin] token` as `Authorization: Bearer`; without the token (24+ characters) neither half starts:

- `GET /ctl/live` -> the live and recent connections (`Conns::live`, `Conns::recent`) and the logged-in count
- `POST /ctl/kick/<conn>` and `POST /ctl/kick-miner/<miner_id>` -> `Conns::kick*` (the second waits up to 5 s)
- `GET /ctl/coinbase` and `POST /ctl/coinbase/pairs` -> `coinbase::info` / `coinbase::upload`

The app keeps a `/ctl/live` answer 1 s and a failure 2 s. When the stratum process is down the API says so
instead of failing: `/api/health` answers 503 with `stratum: down`, and `connectedWorkers` in `/api/stats` (and
`workers` in health) is `null`, with no fallback to an older count.

### Locks

`acquire_instance_lock` takes one advisory lock per role (`STRATUM_LOCK`, `APP_LOCK`; `run all` takes both), so two
app processes or two stratum processes can never run against one database, while one of each can. The stratum
lock is the old single-process lock, so an old binary and a new stratum process never run together.

### Who writes what (no double writers)

- shares, `miners.last_share`, `share_events`, `miner_sessions`, blocks at find time, their PPLNS credits: stratum
- block maturity / orphan checks, payments, miner balances on payout, hashrate samples, the hourly prune: app
- coinbase pairs (uploads, mined, rolled back, expired): stratum, where the finalizer link is
- `meta`: `node_job` (`{height, net_packed, at, job_at}`, on a new height and every 10 s) is the stratum
  process's, `net_height` and `payouts_next_at` (the next scheduled payout run, kept across restarts) the app's
- miners rows: created by the stratum process at login (`miner_id`), updated by the app (holds, merges, payouts).
  The merge from the dashboard moves a balance and deletes a miner row, so it first ends that miner's live
  connections through `/ctl/kick-miner` and is refused when one is still open after 5 s or the stratum process
  does not answer.

## Steps

1. **Roles in one binary, still one process** (no behaviour change, one deploy). `main.rs` gets `run stratum`,
   `run app` and `run all`; `run all` (the default) starts both halves in one process as before. Both halves keep
   one `Shared`, with a `role` that decides which tasks start. The app reaches the stratum half through one type,
   `ctl::Stratum`: `Local` (calls into memory) for `run all`, `Remote` (HTTP to `/ctl/*`) for `run app`. Tests:
   `tools/e2e.sh` with `run all`.
2. **The control interface over HTTP** (`[control] bind` / `url`, the admin token as a Bearer). The stratum half
   serves it; the app half's client calls it. With `run all` it works in-process. e2e: `tools/e2e_split.sh`, two
   processes (`run stratum` + `run app`) on the test database, 16 checks.
3. **Per-role locks** in the database (step 1's `run all` takes both).
4. **Deploy as two containers.** `compose-bumblebeam.yaml`: `pool-stratum` (the stratum ports, `run stratum`) and
   `pool-app` (8080, `run app`), the same image and config. The switch itself is one stratum restart (the last
   one for app-only releases). The host nginx points `/api/` at `pool-app`, the pages at `pool-web`.
5. **Release rule** in `docs/deploy.md`: a commit that touches only app modules rebuilds and restarts `pool-app`
   alone; a stratum change restarts `pool-stratum` (graceful, at a quiet moment); `ctl.rs` is in both halves, so a
   change to it restarts both; a change to both is split into two commits where it can be.

## Later, if even stratum releases must not drop miners

A thin stratum proxy that holds the miners' TCP/TLS connections and almost never changes (ckpool's proxy /
passthrough modes do this), with the stratum core behind it. On a core restart the proxy logs in again, takes the
new job and keeps its miners. The proxy must keep per-miner state (login, nonce prefix, difficulty, the current
job) and re-map it, so it is a second implementation of part of the protocol; worth it only if stratum releases
become frequent.

## Not chosen

- **Listening-socket handover** (ckpool `-H`, HAProxy `expose-fd listeners`, systemd socket activation): the port
  never closes, but the open miner connections still belong to the old process and drop; NiceHash would still lose
  its ~40 s.
- **Two stratum instances behind a balancer with rolling restarts**: every miner still reconnects once per release
  (NiceHash ~40 s each time), and the nonce prefixes must carry an instance id; no gain over step 4 for our size.
