# Pool audit (2026-10-23) and the work order with the split

Four read-only reviews (stratum side; money side; API and DB; web and deploy), then the findings marked HIGH
were re-checked against the code and against production (`pool.toml`, `meta`, `pg_stat_user_tables`).
Production facts used: coinbase payouts are off (no `[coinbase]`), the node gives an empty nonce prefix and
`nonce_prefix_bytes = 3`, `txid_honored = true`, schema 9, Postgres `max_connections = 100`, DB 81 MB, the pool
uses ~26 MB RAM and ~0 % CPU. File:line references are as of `19f4ee3`.

Priorities: **P0** can lose money or a block, fix first; **P1** needed for the split; **P2** speed and operations;
**P3** dead code and cleanup.

## P0 - money and blocks

1. **A found block can vanish from the books.** `upstream.rs:154` runs `accounting::block_found` in a detached
   task that only logs an error; `upstream.rs:172` `if pending.len() > 64 { pending.clear(); }` can drop a
   solution in flight; a node-link drop between `solution` and `result` loses `pending`; the graceful stop does
   not wait for these tasks. Fix: write the candidate (height, nonce, output, miner, mode) to `blocks` before
   sending it to the node, settle it from the node's result or from the chain later, retry the crediting step
   idempotently, and make the stop wait for it.
2. **A hold does not stop a run already started.** `db.rs` `create_payment`: `UPDATE miners ... WHERE id=$1 AND
   balance >= $2` has no `payouts_held_at IS NULL`. Fix: add it.
3. **A stop during a payout run leaves rows for the operator.** `pay_once` never checks `stopping`; the stop waits
   6 s, then exits; a row created but not sent goes to `review` after recovery. After the split `pool-app` is
   restarted on most releases, so this would happen often. Fix: check `stopping` before each miner, hold `paying`
   only around create -> send -> mark pending, stamp `send_started_at` before `tx_send` and refund automatically a
   row the wallet never received.
4. **Endless payouts to wallets that are never online.** `miners_due` knows nothing of failures: miner 90 has 26
   failed payouts and none completed, every one locking wallet coins for its lifetime. Fix: count consecutive
   failures since the last completed one, back off 2 h -> 4 -> 8 -> 24 h, store `payments.failure_reason` and show
   it to the operator and on the miner page ("your wallet must be online for a regular address; use an offline
   address").
5. **A merge racing a block confirmation can lose a credit** (`accounting.rs:287-291` vs `admin.rs:247-262`).
   Fix: the merge locks pending blocks (`FOR UPDATE`) or an advisory lock shared with the confirm step.
6. **Coinbase refund on a rollback returns one debit per miner** (`db.rs` `cb_refund_pending`: `UPDATE ... FROM
   payments` applies one joined row per miner) and **a block paid in two steps is debited once**
   (`cb_pay_block`). Off in production today; fix before coinbase payouts are turned on: aggregate per miner.
7. **A slow database stalls every miner.** `record_share` is awaited inside each connection's loop
   (`stratum.rs:421`), the pool has no wait/statement timeouts (`db.rs` `max_size(16)` only) and the API shares
   those 16 connections. Fix: a share writer task fed by a bounded channel that batches inserts; pool timeouts and
   `statement_timeout`.

## P1 - what the split needs (adds to docs/pool-split.md)

8. `pool-app` needs the **node tip, net difficulty and job age**: `tip_height()` / `current_job()` feed
   `confirm_loop` (no tip = no maturity, no payouts), coinbase expiry/upload, `/api/stats`, `/api/blocks`,
   `/api/miners/:a`, `/api/miningboard`, `/api/health`. Fix: the stratum process writes `{tip, net_packed,
   job_at}` to `meta` on each job, and `/live` returns it too; the app reads the cached value.
9. `pool-stratum` needs the **network height** for the syncing-node guard (`upstream.rs:126` reads `net_height`
   that only `network::run` writes): in a stratum-only process the guard is silently off. Fix: the stratum process
   polls the explorer height itself (cheap) or reads a `meta` row the app writes.
10. **Coinbase upload/verify** goes over the finalizer link held by the stratum process (`coinbase.rs:420-453`):
    the control interface gets `POST /coinbase/verify` and `GET /coinbase/link`, the mode comes from
    `cfg.coinbase.enabled`, not from `shared.coinbase.is_some()`. Split `coinbase.rs` into link and app parts.
11. **The admin kick/merge across processes**: kick through the control socket before the merge transaction, refuse
    if it fails, and refuse logins of an address being merged; batch `count_miner` (one map per page, not one call
    per row).
12. **Shared helpers in role files**: `stratum::address_type` (used by the API), `accounting.rs` (both roles),
    the PPLNS window copied in `coinbase::owed`. Move to `address.rs`, `pplns.rs`; split `accounting.rs` into
    `found.rs` (stratum) and `confirm.rs` (app), so "an app-only release" is decidable from the file list.
13. **Per-role main loops**: only `run app` serves HTTP; the stratum role exits through the graceful path also
    when the instance lock is lost (today `process::exit(3)` drops every miner); a stratum port that fails to bind
    exits non-zero instead of logging.

## P2 - speed and operations

14. `/api/stats` runs ~15 queries per request (one pool connection each), `/api/miningboard` and `network::ours()`
    repeat the same; `/api/miners` sums 24 h of shares per request; `/api/blocks/heights` returns every block,
    public and every 30 s from `network.rs`. Fix: one summary task in `pool-app` every 10 s into memory, serving
    them all; `Cache-Control: public, max-age=10` on read-only public routes; a 5-10 s micro-cache in nginx or
    Cloudflare.
15. The minute's `DELETE ... WHERE ts < $1` on `hashrate_samples` (31 days, never index-served: the index is
    `(scope, ts)`) and `share_events`. Fix: BRIN indexes on `ts`, prune hourly; one `GROUPING SETS` insert instead
    of four scans in `sample_hashrates`.
16. `blocks` has only its primary key (681 k seq scans so far, fine at 1.9 k rows): add `(miner_id)` and `(status)`
    when they show in the slow log; enable `pg_stat_statements` to see the slow log at all.
17. Front: the Blocks page refetches 500 blocks every 30 s, the miner page 500 of its blocks, every view fetches
    `stats` separately, whole views are re-rendered. Fix: fetch new blocks only, memoise `stats` 10 s, skip the DOM
    write when the data did not change.
18. Deploy: one `BUMBLEBEAM_REF` for every image -> per-service refs (`POOL_REF`, `POOL_WEB_REF`, ...), images
    tagged with the commit (fast rollback), `pool/server/Cargo.lock` committed and `cargo build --locked`
    (builds are not reproducible today), `stop_grace_period: 30s` for the pool, healthchecks (`/api/health` that
    reports the job age, not always `ok`), log rotation for every container.
19. Stratum hot path: no write timeout to the miner (a peer that stops reading holds its slot forever), a
    connection that never logs in holds a slot 15 min, counters leak on panic, stats are lost on every disconnect
    but the stop (flush only on the minute and on stop), `connected_workers` counts scanners, only 4 jobs are
    kept (valid shares of an older template at the current height are "stale"). Fix: one RAII connection guard,
    one `flush()` on tick/stop/disconnect, a 30 s login deadline, write timeouts, keep all jobs of the current
    height.
20. TLS certificate loaded once: a renewal needs a stratum restart. Fix: reload on SIGHUP or on file change.

## P3 - dead code and cleanup

21. The pool still serves `pool/web` (`api.rs:41-63` `ServeDir`/`ServeFile`, the pool image copies the web dir):
    dead in production and it answers unknown `/api/...` with 200 + index.html. Remove, JSON 404 instead; drop
    `http.web_dir`, the `fs` feature of tower-http, the unused `rustls-pki-types`.
22. Demo mode in the web (`data.js:271-428` and its banner): it shows made-up pool numbers when the first API call
    is slow. Remove; show an error and retry.
23. The admin token is kept in `localStorage` of the public origin and the public pages have no CSP: move to
    `sessionStorage` and add a CSP to the public site (or move admin to its own origin).
24. Write-only columns (`shares.height`, `payments.accepted_at` in a SELECT), `WorkerStats.accepted`, the dead
    `generation` in `coinbase.rs`, `META_TXID_ACCEPTED` never read, the schema ladder 2 -> 9 repeated three times,
    the fallback `tx_fee_groth = 1000` (the real regular fee is 100 000 groth), duplicated helpers between
    `app.js` and `admin.js`, `API.md` fetched from GitHub `main` instead of the deployed copy.
25. Never pruned: `miner_sessions` (keep 90 days), `benchmarks`, expired coinbase pair `hex`.

## Status

- 2026-10-23 00:40, `5e98561`: **P0 1-7 deployed** (6 only the refund half: coinbase is off; the two-step debit in
  `cb_pay_block` stays open). The first graceful restart: the old process closed its 5 connections and exited in
  51 ms, the new one listened 0.7 s later, our miners were back in 0.4-1.2 s.

## Work order

1. **P0 fixes 1-4 and 7** (blocks, hold, stop during payouts, retry backoff, share writer + DB timeouts), with
   e2e extended for each; one deploy (graceful now). 5-6 next.
2. **Split step 1** (roles in one binary, `run all`) together with P1 8-13 and P3 21 (no web serving).
3. **Split steps 2-4** (control socket, per-role locks, two containers) with P2 18 (per-service refs, tags,
   Cargo.lock, grace period, healthchecks).
4. **P2 14-17, 19-20** in `pool-app` / `pool-web` releases - none of them drops a miner once the split is live.
5. **P3** as the files are touched.
