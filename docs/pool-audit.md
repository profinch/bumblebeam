# Pool audit (2026-10-23) and the work order with the split

Re-audit after the split (`100f324`, deployed 2026-10-23 01:45 BST): a logged-in miner was cut 30 s after its
login by the P2 deadline (NiceHash, seen live at 01:09), now fixed; the share writer, accept errors, TLS reload,
`node_job` beat, credit on stop, payout backoff, micro-cache and control cache fixes; DB tests per schema,
`tools/e2e_split.sh` (16 checks) and the web walletKey test. Docs and MCP updated in `009fa36` (and this commit).

Third pass (2026-10-23 morning, two reviews, stratum side and money/API/DB side), fixed in the commit after
`35d0141`:
- a merge could lose PPLNS credits for good: a rig that logged in while the merge ran kept the deleted id; now a
  second kick after the commit and a sweep of late shares and credits, and the confirm step logs credits to missing
  miners as an error;
- a block the node accepted but whose answer was lost (stop, link drop) was never credited: `unanswered` solutions
  are settled from the wallet's coinbase;
- a database outage over the 30 s lock check dropped every miner: only another process holding the lock stops one;
- the per-minute stats flush and the post-login session write no longer stall a connection's loop;
- garbage solutions no longer grow the duplicate set, 200 rejects in a row end a connection;
- the startup DDL gives up a busy table after 2 s and retries, instead of queueing every query behind it;
- the micro-cache keys on parsed parameter values, is bounded by bytes, and always admits the plain routes;
- a merge moves per-mode charts and IP sessions too.
Not changed: 200-with-`error` answers for a bad address (the web and the explorer read them), pre-login time
counted from accept (L1), share/net difficulty order on low-difficulty chains (L3), nonce prefix change on a
node reconnect (L4: the node gives none).

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

## Status (2026-10-23 01:10)

Done and in production:
- **P0** 1-5, 7 and the refund half of 6 (`8d5e7eb`, 00:40).
- **P1** 8-11, 13 with the split (`d61dbce`, `b1ae63f`, 00:50): `bumblebeam-pool-stratum` + `bumblebeam-pool-app`; a
  pool-app restart: 0.47 s, 0 disconnects. 12 (moving shared helpers into their own files) not done - not needed
  for the split to work, the release rule in docs/deploy.md lists the files per half.
- **P2** 14 (micro-cache + Cache-Control, nginx no longer overrides it), 15 (one GROUPING SETS pass, hourly prune,
  BRIN), 16 partly (blocks indexes; `pg_stat_statements` needs a postgres restart - not done), 17 (front polling),
  18 (POOL_REF / POOL_WEB_REF, image tags, Cargo.lock + --locked, stop_grace_period, a healthcheck on pool-app),
  19 (connection guard, flush on every disconnect, login and idle deadlines - the old idle timeout never fired,
  write timeouts, jobs of the current height), 20 (TLS reload + /etc/cron.daily/bumblebeam-pool-tls) - `861272d`,
  `496ecd0`, `c2d00c5`.
- **P3** 21 (no web serving in the pool), 22 (demo mode removed), 23 (CSP on the public pages; the token stays in
  localStorage behind it), 25 (miner_sessions, benchmarks pruned), the fallback fee.

Open:
- P0 6, the second half: `cb_pay_block`'s two-step debit (coinbase payouts are off).
- P3 24: write-only columns (`shares.height`), `WorkerStats.accepted`, the dead `generation` in coinbase.rs,
  `META_TXID_ACCEPTED`, the schema ladder, duplicated helpers between app.js and admin.js, API.md from GitHub.
- Not in the audit, noticed on the way: a logged-in miner silent for 15 min is now disconnected (the limit never
  fired before) - expected to be rare (vardiff lowers the difficulty after 6 targets without a share).

## Work order

1. **P0 fixes 1-4 and 7** (blocks, hold, stop during payouts, retry backoff, share writer + DB timeouts), with
   e2e extended for each; one deploy (graceful now). 5-6 next.
2. **Split step 1** (roles in one binary, `run all`) together with P1 8-13 and P3 21 (no web serving).
3. **Split steps 2-4** (control socket, per-role locks, two containers) with P2 18 (per-service refs, tags,
   Cargo.lock, grace period, healthchecks).
4. **P2 14-17, 19-20** in `pool-app` / `pool-web` releases - none of them drops a miner once the split is live.
5. **P3** as the files are touched.

## Fourth pass (2026-10-23, read-only, nothing fixed yet)

Three independent reviews of `756134d` (stratum; money/API/DB; web/MCP/deploy) plus a read-only look at the live
host. The ledger reconciles to zero (confirmed credits - completed payouts - in-flight debits - balances = 0), no
credits or shares point at a missing miner, no block is in review. Everything the first three passes list as fixed
was re-checked and holds.

### HIGH

1. **No backup exists.** No `pg_dump`, no copy of `wallet.db` / `wallet.pass`, no cron or timer; one `/data` disk
   on one host. `docs/deploy.md` only says to do it. Postgres holds who is owed what, the wallet dir the funds.
   Fix: nightly `pg_dump | gzip` + an encrypted copy of the wallet dir shipped off-host (restic/rclone), retention,
   a restore drill, and a note on where the seed phrase lives.

### MEDIUM

2. **Wallet down at the scheduled minute = a whole interval skipped** (`payouts.rs:115-120`): `next_payout` and
   `payouts_next_at` move forward *before* `pay_once`; a failed `wallet.status()` only warns. Fix: retry in 10 min
   on error, show "last run failed" in attention.
3. **A pool-side `tx_send` refusal counts as the miner's failure and carries no reason** (`payouts.rs:272-276`):
   refunded as `failed` with `failed_at` (fee too low, ACL, stale `available`) → 2 h … 24 h backoff;
   `set_failure_reason` is only called in `poll_pending`, so `payoutFailures.reason` is null. Fix: write the reason
   here too; count only wallet-confirmed failures (status 2/4) toward the backoff.
4. **"Pay all due now" is cut by nginx at 30 s** (`api.rs:649` waits 150 s, `bumblebeam.conf:71`
   `proxy_read_timeout 30s`): with ~6+ miners due the operator gets a 504, the run goes on blind and its per-miner
   report (the only record) is lost. Fix: a longer timeout for `/api/admin/` or an async run with a status poll.
5. **A database outage refuses every login for its duration** (`stratum.rs:466-469`): the login awaits
   `db.miner_id()` and bails on error. Open connections survive (the share writer buffers), anyone reconnecting in
   the window - NiceHash included - is turned away. Fix: an in-memory `address -> miner_id` cache, refuse only
   unknown addresses while the DB is down.
6. **MCP batch bypasses rate limiting** (`api/server.js:613-614`): an unbounded JSON-RPC array in one ≤1 MB POST
   fans out thousands of upstream calls concurrently; nginx counts one request. Fix: cap the batch (10-20) and the
   concurrency.
7. **MCP maps every upstream non-2xx to 502 and builds URLs with `NaN`** (`server.js:26,30,514,516,270-272`):
   a pool 404/400 reaches the agent as "upstream answered 404"; `Number(a.height)` is not validated. Fix: validate
   integers, pass 4xx bodies through as `bodyOn` does for health.
8. **Miner addresses land in access logs twice**: the host nginx logs full `/miners/<addr>` and
   `/api/miners/<addr>` URIs for 60 days; pool-web logs the same to stdout; most services have no `logging:` cap in
   compose (the host's `daemon.json` caps json-file at 100 MB x 5). Fix: `access_log off` in pool-web, redact
   `/miners/…` in the host nginx.
9. **Nobody watches health**: the pool-app healthcheck has no consumer (Docker does not restart or alert), the other
   services have none, no external check of `/api/health`. A stuck node (503) or a hung wallet-api (payouts silently
   fail) is found by hand. Fix: an external uptime check expecting 200 + certificate-expiry monitor.
10. **The host's Docker build cache holds 90.8 GB** of the 185 GB used on `/data`. `docker builder prune`.

### LOW

Money/books: a second accepted block at a height already `pending` is dropped silently (`accounting.rs:134-149`;
needs the node to rewind below H, so unrealistic - still worth an `error!` and a submissions note); the syncing guard
trusts the public explorer's height (`network.rs:165-169` → `upstream.rs:128-136`) and health stays ok while jobs are
withheld; `block_submissions` states and credits to deleted miners never reach the operator's attention list;
example configs ship `tx_fee_groth = 1000` against a default of 100 000 (a copied example makes every regular payout
fail → the backoff of #3); a changed `payout_interval_secs` applies only after the stored `payouts_next_at` passes;
a half-dead lock connection (client gone, backend holding the advisory lock) exits the process and the next one
cannot take the lock until keepalive (2 h) - `tcp_keepalives_idle=60` in the DB url fixes it; admin actions answer
409 for "no such miner/payment" (404).

Stratum: every valid-JSON pre-login message is logged (`stratum.rs:428`), not only the first; no grace window for
shares of the previous height (200 ms of latency = a stale share; fairness, not money); shares on superseded
templates of the current height are accepted for the whole block time (the node only takes the current template:
griefing with no gain); in `run app` `credit_found` waits 5 s on a share writer that does not exist (misleading
warning from `settle_unanswered`); a second `login` on a logged-in connection re-points it and its stats; node
rotation sticks to the standby (none configured); any 100-600-char alphanumeric login creates a `miners` row -
one IP can create thousands a minute.

Web/deploy/host: `app.js:1046` routes like `/constructor` or `/__proto__` hit `Object.prototype` ("[object Object]"
instead of Not found, no XSS); `app.js:491` `stats.blocksPending` is always undefined (`normStats` drops it);
`/api/blocks/<height>` and `payoutFailures.reason` are not length-capped (escaped, so no XSS); no
`client_max_body_size 2m` on `/api/` (coinbase pair uploads over 1 MB die with an HTML 413); the wallet password is
visible in `/proc/<pid>/cmdline` (`--pass="$(cat …)"`); pool-web / explorer-* default to `main` when
`BUMBLEBEAM_REF` is unset (set on the host); postgres 5432, wallet-api 10001 (whitelisted) and control 8081 are
reachable from every container on the `bumblebeam` network, web containers included; the Cloudflare IP lists in
nginx and nftables are static (2026-10-07); `/data/docker/.env` is 644 and holds the Telegram bot token; `web_dir`
is still in the live `pool.toml` (ignored); unattended-upgrades is not installed; pool-web serves
`/test/walletkey.test.mjs` and `/.gitignore`. Docs: `pool/server/README.md:141` "Not yet: publishing PPLNS rounds"
is stale (they are published); `API.md:34` example `minPayout` 0.1 BEAM vs the 1 BEAM default; `API.md:390`
promises 413 above 2 MB while nginx cuts at 1 MB.

### Checked and fine

Payout state machine (atomic debit, refunds only from the stated status, resend with the same tx_id, completed /
pending never rolled back even with `--force`); groth arithmetic all integer, PPLNS floors in the pool's favour;
payout / confirm / merge / credit serialized on lock 7211001, double credit excluded by height uniqueness; the
deadlines (30 s / 15 min), share dedup, nonce prefixes, the block path from solution to credit, SIGTERM at every
moment, the share writer, hostile input without panics; XSS (every sink escaped or numeric, CSP matches what the
pages load, admin token only in a header with constant-time compare and `no-store`); secrets on the host (0600,
right owners), wallet-api unpublished, firewall 80/443 from Cloudflare only, control 8081 not exposed; certificates
certbot → cron.daily → reload, valid to 2027-01-05; API privacy (balance only by exact address); retention and
indexes (204 k shares, 59 MB).

### Test gaps

Stratum has unit tests only for job retention, the worker suffix, PROXY v1, pack and sha; everything else is e2e.
Missing: `connection()` under a duplex harness (nonce prefix, lenient difficulty across job ids, duplicate across
job ids, the 200-reject cut, vardiff math, a second login, the per-IP cap), `upstream` (FIFO pending, unknown id,
the sync guard), `block_found` twice, `settle_unanswered` from UTXOs; on the money side `block_found` end to end
with the PPLNS window and bonus, `confirm_once` (aggregate to balances, verdicts, no double credit after a forced
confirm), the payment lifecycle (`complete_payment`, refunds with `paid`), `merge` refusals, `cb_pay_block`.

### Suggested order

1 backups → 2-3 payouts silently skipped or backed off for a pool-side cause → 5 logins during a DB outage →
10 the build cache → 9 health monitoring and 4 the admin payout timeout.
