# TODO

Ecosystem-wide work not tied to one component.

- [ ] **Status page for the whole ecosystem** (requested 2026-10-29). One public page with the live state and
  uptime history of every BumbleBeam service: pool stratum (3333/3443 PPLNS, 3334/3444 SOLO), pool API and web
  (`/api/health` already reports stratum and template age), explorer web and API (`/v1`, MCP), the Beam node,
  DEX, prerender, bumblebeam.org. Links to it from the footers (the pool's status pill) and from the hub.
- [ ] **Monitoring and alerts** (2026-11-02). Healthchecks for `pool-stratum`, `beam-node` and `explorer-node` (today
  only `pool-app` and postgres have one); alerts to Telegram (the bot exists, `TELEGRAM_*` in `.env` are empty) on a
  stale template, a node behind the network, a stopped container, a full disk, a failed payout run; the status page
  above reads the same checks.
- [ ] **Staging on the same server** (2026-11-02). A second compose project with its own postgres (a copy of the
  production database, refreshed from `pg_dump`), payouts off (`[payouts] enabled = false`) and no access to
  wallet-api, the same beam-node for jobs, stratum on other ports (4333/4443) for test rigs, pool-app and the web
  images on `next.pool.bumblebeam.org` / `next.explorer.bumblebeam.org` behind a password. Any `:sha-...` image from
  CI goes there first; the role locks keep a second stratum or app off the production database.
- [ ] **Backups** of the pool database and the pool wallet, daily, encrypted, off the server, with a restore test.

