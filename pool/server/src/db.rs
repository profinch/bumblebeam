//! PostgreSQL storage: miners, shares, blocks, credits, payments, hashrate samples.
//! Timestamps are unix seconds (BIGINT), amounts are groth (BIGINT), difficulties are the
//! expected number of solutions (DOUBLE PRECISION), so sum(difficulty)/seconds is a hashrate.
//! Shares reference miners by id: an offline Beam address is 400+ characters.

use anyhow::{Context, Result};
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use serde_json::{json, Value};
use std::sync::Mutex;
use tokio_postgres::NoTls;

/// Time span of a hashrate chart, from the API's `range` parameter.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChartRange {
    Day,
    Week,
    Month,
}

impl ChartRange {
    /// Hashrate samples are kept this long: the longest range.
    pub const KEEP_SECS: i64 = 31 * 86400;

    /// `24h` (default), `7d` or `30d`.
    pub fn parse(s: Option<&str>) -> Self {
        match s {
            Some("7d") => Self::Week,
            Some("30d") => Self::Month,
            _ => Self::Day,
        }
    }

    /// (span, bucket) in seconds: one point per minute for a day, per hour for a week, per four
    /// hours for a month, so every range is a few hundred points at most.
    fn window(self) -> (i64, i64) {
        match self {
            Self::Day => (86400, 60),
            Self::Week => (7 * 86400, 3600),
            Self::Month => (30 * 86400, 4 * 3600),
        }
    }
}

/// Hashrate chart for one scope (`pool` or `m:<miner id>`), averaged per bucket. Samples are taken
/// once a minute and a miner without shares gets no row, so a bucket's sum is divided by the
/// minutes it covers (the last one only up to now), which counts the missing minutes as zero.
async fn chart(c: &tokio_postgres::Client, scope: &str, now: i64, range: ChartRange) -> Result<Vec<Value>> {
    let (span, bucket) = range.window();
    let from = (now - span) / bucket * bucket + bucket;
    let rows = c
        .query(
            "SELECT t, (s / GREATEST(1, LEAST($3, $4 - t) / 60.0))::FLOAT8 FROM
               (SELECT ts / $3 * $3 AS t, SUM(hashrate) AS s FROM hashrate_samples WHERE scope=$1 AND ts >= $2 GROUP BY 1) b
             ORDER BY t",
            &[&scope, &from, &bucket, &now],
        )
        .await?;
    Ok(rows.iter().map(|r| json!([r.get::<_, i64>(0), r.get::<_, f64>(1)])).collect())
}

pub struct Db {
    pool: Pool,
    /// Connection that holds the single-instance advisory lock for the life of the process.
    lock_conn: Mutex<Option<deadpool_postgres::Client>>,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS miners (
  id BIGSERIAL PRIMARY KEY, address TEXT UNIQUE NOT NULL, first_seen BIGINT NOT NULL, last_share BIGINT,
  balance BIGINT NOT NULL DEFAULT 0, paid BIGINT NOT NULL DEFAULT 0, address_type TEXT, type_checked BIGINT);
CREATE TABLE IF NOT EXISTS shares (
  id BIGSERIAL PRIMARY KEY, ts BIGINT NOT NULL, miner_id BIGINT NOT NULL, worker TEXT NOT NULL,
  mode TEXT NOT NULL, difficulty DOUBLE PRECISION NOT NULL, height BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS shares_ts ON shares(ts);
CREATE INDEX IF NOT EXISTS shares_miner_ts ON shares(miner_id, ts);
CREATE INDEX IF NOT EXISTS shares_pplns ON shares(mode, ts DESC, id DESC);
CREATE TABLE IF NOT EXISTS blocks (
  height BIGINT PRIMARY KEY, hash TEXT, ts BIGINT NOT NULL, miner_id BIGINT NOT NULL, worker TEXT NOT NULL,
  mode TEXT NOT NULL, reward BIGINT NOT NULL, fees BIGINT NOT NULL DEFAULT 0, effort DOUBLE PRECISION,
  net_difficulty DOUBLE PRECISION NOT NULL, status TEXT NOT NULL DEFAULT 'pending', verified_by TEXT,
  nonce TEXT, output TEXT);
CREATE TABLE IF NOT EXISTS credits (
  id BIGSERIAL PRIMARY KEY, block_height BIGINT NOT NULL REFERENCES blocks(height) ON DELETE CASCADE,
  miner_id BIGINT NOT NULL, amount BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS credits_block ON credits(block_height);
CREATE INDEX IF NOT EXISTS credits_miner ON credits(miner_id);
CREATE TABLE IF NOT EXISTS payments (
  id BIGSERIAL PRIMARY KEY, ts BIGINT NOT NULL, miner_id BIGINT NOT NULL, amount BIGINT NOT NULL,
  fee BIGINT NOT NULL DEFAULT 0, debit BIGINT NOT NULL, tx_id TEXT UNIQUE, kernel TEXT,
  status TEXT NOT NULL, attempts INT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL DEFAULT 0, accepted_at BIGINT);
CREATE INDEX IF NOT EXISTS payments_miner_ts ON payments(miner_id, ts);
CREATE INDEX IF NOT EXISTS payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS payments_ts ON payments(ts);
CREATE TABLE IF NOT EXISTS share_events (ts BIGINT NOT NULL, miner_id BIGINT NOT NULL, worker TEXT NOT NULL, stale BIGINT NOT NULL, rejected BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS se_miner_ts ON share_events(miner_id, ts);
CREATE TABLE IF NOT EXISTS hashrate_samples (ts BIGINT NOT NULL, scope TEXT NOT NULL, hashrate DOUBLE PRECISION NOT NULL);
CREATE INDEX IF NOT EXISTS hs_scope_ts ON hashrate_samples(scope, ts);
"#;

/// Coinbase payouts: the miners' pairs (status stock | mined | expired) and the chain as the finalizer
/// reports it (height -> block hash), which confirms or orphans the pool's blocks.
const SCHEMA_COINBASE: &str = r#"
CREATE TABLE IF NOT EXISTS coinbase_pairs (
  id BIGSERIAL PRIMARY KEY, miner_id BIGINT NOT NULL, value BIGINT NOT NULL, kernel TEXT UNIQUE NOT NULL,
  commitment TEXT UNIQUE NOT NULL, hex TEXT NOT NULL, size INT NOT NULL, min_height BIGINT NOT NULL, max_height BIGINT NOT NULL,
  created_at BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'stock', mined_height BIGINT, mined_hash TEXT);
CREATE INDEX IF NOT EXISTS cbp_miner_status ON coinbase_pairs(miner_id, status);
CREATE INDEX IF NOT EXISTS cbp_status_mined ON coinbase_pairs(status, mined_height);
CREATE TABLE IF NOT EXISTS chain_headers (height BIGINT PRIMARY KEY, hash TEXT NOT NULL, seen_at BIGINT NOT NULL);
"#;

/// Schema version. Older databases are migrated in `migrate`; one without a version is refused.
pub const SCHEMA_VERSION: i32 = 5;

/// Statements that bring a database from version `from` to `from + 1`.
fn migration(from: i32) -> Option<&'static str> {
    match from {
        2 => Some("ALTER TABLE payments ADD COLUMN IF NOT EXISTS created_at BIGINT NOT NULL DEFAULT 0"),
        3 => Some("ALTER TABLE payments ADD COLUMN IF NOT EXISTS accepted_at BIGINT"),
        4 => Some(SCHEMA_COINBASE),
        _ => None,
    }
}

/// A verified pair as the finalizer reports it, ready to store.
pub struct NewPair {
    pub value: i64,
    pub kernel: String,
    pub commitment: String,
    pub hex: String,
    pub size: i32,
    pub min_height: i64,
    pub max_height: i64,
}

/// A pair in stock, as the allocator needs it.
pub struct StockPair {
    pub miner_id: i64,
    pub value: i64,
    pub size: i64,
    pub hex: String,
}
const INSTANCE_LOCK: i64 = 0x62_75_6d_62_6c_65; // "bumble"

pub type DuePayout = (i64, String, i64, Option<String>);

/// A payment row as the payout tasks need it.
pub struct PaymentRow {
    pub tx_id: String,
    pub address: String,
    pub amount: i64,
    pub fee: i64,
    /// when this row was created (ts is the payout run it belongs to)
    pub created_at: i64,
}

impl Db {
    pub async fn connect(url: &str) -> Result<Db> {
        let pg: tokio_postgres::Config = url.parse().context("database url")?;
        let mgr = Manager::from_config(pg, NoTls, ManagerConfig { recycling_method: RecyclingMethod::Fast });
        let pool = Pool::builder(mgr).max_size(16).build()?;
        let db = Db { pool, lock_conn: Mutex::new(None) };
        let c = db.client().await?;
        c.batch_execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)").await?;
        let ver: Option<i32> = c.query_opt("SELECT value FROM meta WHERE key='schema'", &[]).await?.and_then(|r| r.get::<_, String>(0).parse().ok());
        match ver {
            None => {
                let has_old = c.query_opt("SELECT 1 FROM information_schema.tables WHERE table_name='shares'", &[]).await?.is_some();
                anyhow::ensure!(!has_old, "database has tables from before schema versioning: drop and recreate it (no real data existed before v3)");
                c.batch_execute(&format!("{SCHEMA}{SCHEMA_COINBASE}")).await.context("schema")?;
                c.execute("INSERT INTO meta (key, value) VALUES ('schema', $1)", &[&SCHEMA_VERSION.to_string()]).await?;
            }
            Some(v) if v == SCHEMA_VERSION => c.batch_execute(&format!("{SCHEMA}{SCHEMA_COINBASE}")).await.context("schema")?,
            Some(mut v) if v < SCHEMA_VERSION => {
                while v < SCHEMA_VERSION {
                    let Some(sql) = migration(v) else { anyhow::bail!("no migration from schema version {v}") };
                    c.batch_execute(sql).await.with_context(|| format!("migrating schema {v} -> {}", v + 1))?;
                    v += 1;
                    c.execute("UPDATE meta SET value=$1 WHERE key='schema'", &[&v.to_string()]).await?;
                    tracing::info!(version = v, "database schema migrated");
                }
                c.batch_execute(&format!("{SCHEMA}{SCHEMA_COINBASE}")).await.context("schema")?;
            }
            Some(v) => anyhow::bail!("database schema version {v} is newer than this binary ({SCHEMA_VERSION})"),
        }
        Ok(db)
    }

    /// Only one pool process may run against a database: payouts and confirmations must not race.
    pub async fn acquire_instance_lock(&self) -> Result<bool> {
        let c = self.client().await?;
        let ok: bool = c.query_one("SELECT pg_try_advisory_lock($1)", &[&INSTANCE_LOCK]).await?.get(0);
        if ok {
            *self.lock_conn.lock().unwrap() = Some(c);
        }
        Ok(ok)
    }

    /// The lock lives in one connection; if that connection died (PostgreSQL restart, network),
    /// the lock is gone and another process could start. Re-acquire or report false.
    pub async fn check_instance_lock(&self) -> bool {
        let conn = self.lock_conn.lock().unwrap().take();
        if let Some(c) = conn {
            if c.query_one("SELECT 1", &[]).await.is_ok() {
                *self.lock_conn.lock().unwrap() = Some(c);
                return true;
            }
            // dead: destroy it rather than hand it back to the pool
            let _ = deadpool_postgres::Object::take(c);
        }
        self.acquire_instance_lock().await.unwrap_or(false)
    }

    pub async fn meta_get(&self, key: &str) -> Result<Option<String>> {
        let c = self.client().await?;
        Ok(c.query_opt("SELECT value FROM meta WHERE key=$1", &[&key]).await?.map(|r| r.get(0)))
    }

    pub async fn meta_set(&self, key: &str, value: &str) -> Result<()> {
        let c = self.client().await?;
        c.execute("INSERT INTO meta (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", &[&key, &value]).await?;
        Ok(())
    }

    pub async fn client(&self) -> Result<deadpool_postgres::Client> {
        Ok(self.pool.get().await?)
    }

    /// The miner's row id, created on first sight. `kind` is the address type seen at login.
    pub async fn miner_id(&self, address: &str, kind: &str, now: i64) -> Result<i64> {
        let c = self.client().await?;
        let row = c
            .query_one(
                "INSERT INTO miners (address, first_seen, address_type) VALUES ($1,$2,$3)
                 ON CONFLICT (address) DO UPDATE SET address_type = COALESCE(miners.address_type, EXCLUDED.address_type) RETURNING id",
                &[&address, &now, &kind],
            )
            .await?;
        Ok(row.get(0))
    }

    pub async fn set_address_type(&self, miner_id: i64, kind: &str, now: i64) -> Result<()> {
        let c = self.client().await?;
        c.execute("UPDATE miners SET address_type=$2, type_checked=$3 WHERE id=$1", &[&miner_id, &kind, &now]).await?;
        Ok(())
    }

    pub async fn record_share(&self, ts: i64, miner_id: i64, worker: &str, mode: &str, difficulty: f64, height: i64) -> Result<()> {
        let c = self.client().await?;
        c.execute("INSERT INTO shares (ts, miner_id, worker, mode, difficulty, height) VALUES ($1,$2,$3,$4,$5,$6)", &[&ts, &miner_id, &worker, &mode, &difficulty, &height]).await?;
        Ok(())
    }

    /// last_share is written once a minute per connection, not per share: the miners row also
    /// holds the balance and must not be a hot row.
    pub async fn touch_miner(&self, miner_id: i64, ts: i64) -> Result<()> {
        let c = self.client().await?;
        c.execute("UPDATE miners SET last_share = GREATEST(COALESCE(last_share,0), $2) WHERE id=$1", &[&miner_id, &ts]).await?;
        Ok(())
    }

    pub async fn record_share_events(&self, ts: i64, miner_id: i64, worker: &str, stale: i64, rejected: i64) -> Result<()> {
        let c = self.client().await?;
        c.execute("INSERT INTO share_events (ts, miner_id, worker, stale, rejected) VALUES ($1,$2,$3,$4,$5)", &[&ts, &miner_id, &worker, &stale, &rejected]).await?;
        Ok(())
    }

    pub async fn pool_hashrate(&self, now: i64) -> Result<f64> {
        let c = self.client().await?;
        let sum: f64 = c.query_one("SELECT COALESCE(SUM(difficulty),0)::FLOAT8 FROM shares WHERE ts > $1", &[&(now - 600)]).await?.get(0);
        Ok(sum / 600.0)
    }

    pub async fn mode_hashrate(&self, mode: &str, now: i64) -> Result<f64> {
        let c = self.client().await?;
        let sum: f64 = c.query_one("SELECT COALESCE(SUM(difficulty),0)::FLOAT8 FROM shares WHERE mode=$1 AND ts > $2", &[&mode, &(now - 600)]).await?.get(0);
        Ok(sum / 600.0)
    }

    pub async fn pool_counts(&self, now: i64) -> Result<(i64, i64)> {
        let c = self.client().await?;
        let row = c.query_one("SELECT COUNT(DISTINCT miner_id), COUNT(DISTINCT (miner_id, worker)) FROM shares WHERE ts > $1", &[&(now - 600)]).await?;
        Ok((row.get(0), row.get(1)))
    }

    pub async fn last_block_ts(&self, mode: Option<&str>, miner_worker: Option<(i64, &str)>) -> Result<Option<i64>> {
        let c = self.client().await?;
        let row = match (mode, miner_worker) {
            (Some(m), Some((id, w))) => c.query_opt("SELECT MAX(ts) FROM blocks WHERE mode=$1 AND miner_id=$2 AND worker=$3", &[&m, &id, &w]).await?,
            (Some(m), None) => c.query_opt("SELECT MAX(ts) FROM blocks WHERE mode=$1", &[&m]).await?,
            _ => c.query_opt("SELECT MAX(ts) FROM blocks", &[]).await?,
        };
        Ok(row.and_then(|r| r.get::<_, Option<i64>>(0)))
    }

    pub async fn round_shares(&self, mode: &str, since: i64, miner_worker: Option<(i64, &str)>) -> Result<f64> {
        let c = self.client().await?;
        let row = match miner_worker {
            Some((id, w)) => {
                c.query_one("SELECT COALESCE(SUM(difficulty),0)::FLOAT8 FROM shares WHERE mode=$1 AND ts > $2 AND miner_id=$3 AND worker=$4", &[&mode, &since, &id, &w]).await?
            }
            None => c.query_one("SELECT COALESCE(SUM(difficulty),0)::FLOAT8 FROM shares WHERE mode=$1 AND ts > $2", &[&mode, &since]).await?,
        };
        Ok(row.get(0))
    }

    /// The pool's blocks, newest first; with `miner` only the blocks that miner found.
    pub async fn blocks(&self, limit: i64, before: Option<i64>, maturity: i64, tip: Option<i64>, miner: Option<i64>) -> Result<Vec<Value>> {
        let c = self.client().await?;
        let rows = c
            .query(
                "SELECT height, hash, ts, worker, mode, reward, fees, effort, status, verified_by FROM blocks
                 WHERE ($1::BIGINT IS NULL OR height < $1) AND ($2::BIGINT IS NULL OR miner_id = $2) ORDER BY height DESC LIMIT $3",
                &[&before, &miner, &limit],
            )
            .await?;
        Ok(rows
            .iter()
            .map(|r| {
                let height: i64 = r.get(0);
                let conf = tip.map(|t| (t - height + 1).clamp(0, maturity)).unwrap_or(0);
                json!({
                    "height": height, "hash": r.get::<_, Option<String>>(1), "ts": r.get::<_, i64>(2),
                    "reward": r.get::<_, i64>(5), "fees": r.get::<_, i64>(6), "effort": r.get::<_, Option<f64>>(7),
                    "status": r.get::<_, String>(8), "verifiedBy": r.get::<_, Option<String>>(9), "confirmations": conf,
                    "finder": r.get::<_, String>(3), "mode": r.get::<_, String>(4),
                })
            })
            .collect())
    }

    /// Blocks found by one miner: total and in 24 h (orphans not counted), the last one's time, and
    /// the most recent `limit` (orphans included, with their status).
    pub async fn miner_blocks(&self, address: &str, now: i64, limit: i64, maturity: i64, tip: Option<i64>) -> Result<Value> {
        let c = self.client().await?;
        let Some(m) = c.query_opt("SELECT id FROM miners WHERE address=$1", &[&address]).await? else {
            return Ok(json!({ "blocksFound": 0, "blocks24h": 0, "lastBlockAt": null, "blocks": [] }));
        };
        let id: i64 = m.get(0);
        let row = c
            .query_one(
                "SELECT COUNT(*) FILTER (WHERE status <> 'orphaned'), COUNT(*) FILTER (WHERE status <> 'orphaned' AND ts > $2), MAX(ts)
                 FROM blocks WHERE miner_id = $1",
                &[&id, &(now - 86400)],
            )
            .await?;
        drop(c);
        let list = self.blocks(limit, None, maturity, tip, Some(id)).await?;
        Ok(json!({ "blocksFound": row.get::<_, i64>(0), "blocks24h": row.get::<_, i64>(1), "lastBlockAt": row.get::<_, Option<i64>>(2), "blocks": list }))
    }

    pub async fn blocks_24h(&self, now: i64) -> Result<(i64, Option<f64>)> {
        let c = self.client().await?;
        let row = c.query_one("SELECT COUNT(*), AVG(effort) FROM blocks WHERE ts > $1 AND status <> 'orphaned'", &[&(now - 86400)]).await?;
        Ok((row.get(0), row.get(1)))
    }

    pub async fn top_miners(&self, limit: i64, now: i64) -> Result<Vec<Value>> {
        let c = self.client().await?;
        let rows = c
            .query(
                "WITH recent AS (SELECT miner_id, SUM(difficulty)/600.0 AS hr, COUNT(DISTINCT worker) AS workers, MAX(ts) AS last_share
                                 FROM shares WHERE ts > $1 GROUP BY miner_id),
                      day AS (SELECT miner_id, SUM(difficulty)/86400.0 AS hr24 FROM shares WHERE ts > $2 GROUP BY miner_id)
                 SELECT r.hr::FLOAT8, d.hr24::FLOAT8, r.workers, r.last_share FROM recent r LEFT JOIN day d USING (miner_id)
                 ORDER BY r.hr DESC LIMIT $3",
                &[&(now - 600), &(now - 86400), &limit],
            )
            .await?;
        Ok(rows
            .iter()
            .map(|r| json!({ "hashrate": r.get::<_, f64>(0), "hashrate24h": r.get::<_, Option<f64>>(1), "workers": r.get::<_, i64>(2), "lastShare": r.get::<_, i64>(3) }))
            .collect())
    }

    pub async fn miner(&self, address: &str, now: i64, range: ChartRange) -> Result<Option<Value>> {
        let c = self.client().await?;
        let Some(m) = c.query_opt("SELECT id, balance, paid, last_share, TRIM(TRAILING '?' FROM address_type) FROM miners WHERE address=$1", &[&address]).await? else { return Ok(None) };
        let id: i64 = m.get(0);
        let last_share: Option<i64> = c.query_one("SELECT GREATEST($2, (SELECT MAX(ts) FROM shares WHERE miner_id=$1))", &[&id, &m.get::<_, Option<i64>>(3)]).await?.get(0);
        let hr: f64 = c.query_one("SELECT COALESCE(SUM(difficulty),0)::FLOAT8/600.0 FROM shares WHERE miner_id=$1 AND ts > $2", &[&id, &(now - 600)]).await?.get(0);
        let hr24: f64 = c.query_one("SELECT COALESCE(SUM(difficulty),0)::FLOAT8/86400.0 FROM shares WHERE miner_id=$1 AND ts > $2", &[&id, &(now - 86400)]).await?.get(0);
        let immature: i64 = c
            .query_one("SELECT COALESCE(SUM(c.amount),0)::BIGINT FROM credits c JOIN blocks b ON b.height=c.block_height WHERE c.miner_id=$1 AND b.status IN ('pending','unverified')", &[&id])
            .await?
            .get(0);
        let workers = c
            .query(
                "WITH s AS (SELECT worker, COALESCE(SUM(difficulty) FILTER (WHERE ts > $2),0)::FLOAT8/600.0 AS hr, SUM(difficulty)::FLOAT8/86400.0 AS hr24,
                                   MAX(ts) AS last, COUNT(*) AS n FROM shares WHERE miner_id=$1 AND ts > $3 GROUP BY worker),
                      e AS (SELECT worker, SUM(stale) AS stale, SUM(rejected) AS rejected FROM share_events WHERE miner_id=$1 AND ts > $3 GROUP BY worker)
                 SELECT s.worker, s.hr, s.hr24, s.last, s.n, COALESCE(e.stale,0)::BIGINT, COALESCE(e.rejected,0)::BIGINT FROM s LEFT JOIN e USING (worker) ORDER BY s.hr DESC",
                &[&id, &(now - 600), &(now - 86400)],
            )
            .await?;
        let chart = chart(&c, &format!("m:{id}"), now, range).await?;
        let payments = c
            .query("SELECT ts, amount, fee, kernel, status FROM payments WHERE miner_id=$1 AND status <> 'failed' ORDER BY ts DESC LIMIT 50", &[&id])
            .await?;
        let coinbase = if address.starts_with("cb:") { Some(self.cb_summary(id).await?) } else { None };
        Ok(Some(json!({
            "address": address, "addressType": m.get::<_, Option<String>>(4), "coinbase": coinbase,
            "hashrate": hr, "hashrate24h": hr24,
            "balance": m.get::<_, i64>(1), "immature": immature, "paid": m.get::<_, i64>(2), "lastShare": last_share,
            "workers": workers.iter().map(|w| {
                let last: i64 = w.get(3);
                let n: i64 = w.get(4);
                let stale: i64 = w.get(5);
                let rejected: i64 = w.get(6);
                let total = (n + stale + rejected).max(1) as f64;
                json!({ "name": w.get::<_, String>(0), "hashrate": w.get::<_, f64>(1), "hashrate24h": w.get::<_, f64>(2),
                        "lastShare": last, "online": now - last < 300, "stale": stale as f64 / total, "rejected": rejected as f64 / total })
            }).collect::<Vec<_>>(),
            "charts": { "hashrate": chart },
            "payments": payments.iter().map(|p| json!({ "ts": p.get::<_, i64>(0), "amount": p.get::<_, i64>(1), "fee": p.get::<_, i64>(2),
                                                        "kernel": p.get::<_, Option<String>>(3), "status": p.get::<_, String>(4) })).collect::<Vec<_>>(),
        })))
    }

    pub async fn payments(&self, limit: i64) -> Result<Vec<Value>> {
        let c = self.client().await?;
        // one row per payout run (all payments of a run share the timestamp); Beam pays each miner
        // in its own transaction, so a run has several kernels: all of them are listed, with amounts
        // and without addresses, so every payout can be found on the chain
        let rows = c
            .query(
                "SELECT ts, SUM(amount)::BIGINT, COUNT(*), MAX(kernel), COUNT(*) FILTER (WHERE status='completed'),
                        array_agg(kernel ORDER BY id) FILTER (WHERE kernel IS NOT NULL), array_agg(amount ORDER BY id) FILTER (WHERE kernel IS NOT NULL)
                 FROM payments WHERE status <> 'failed' GROUP BY ts ORDER BY ts DESC LIMIT $1",
                &[&limit],
            )
            .await?;
        Ok(rows
            .iter()
            .map(|r| {
                let n: i64 = r.get(2);
                let done: i64 = r.get(4);
                let kernels = r.get::<_, Option<Vec<String>>>(5).unwrap_or_default();
                let amounts = r.get::<_, Option<Vec<i64>>>(6).unwrap_or_default();
                let txs: Vec<Value> = kernels.iter().zip(&amounts).map(|(k, a)| json!({ "kernel": k, "amount": a })).collect();
                json!({ "ts": r.get::<_, i64>(0), "amount": r.get::<_, i64>(1), "miners": n, "kernel": r.get::<_, Option<String>>(3),
                        "status": if done == n { "completed" } else { "pending" }, "txs": txs })
            })
            .collect())
    }

    pub async fn pool_chart(&self, now: i64, range: ChartRange) -> Result<Vec<Value>> {
        let c = self.client().await?;
        chart(&c, "pool", now, range).await
    }

    /// One sample per minute for the pool and for every miner active in the last ten minutes.
    pub async fn sample_hashrates(&self, now: i64) -> Result<()> {
        let c = self.client().await?;
        c.execute("INSERT INTO hashrate_samples (ts, scope, hashrate) SELECT $1, 'pool', COALESCE(SUM(difficulty),0)/600.0 FROM shares WHERE ts > $2", &[&now, &(now - 600)]).await?;
        c.execute("INSERT INTO hashrate_samples (ts, scope, hashrate) SELECT $1, 'm:' || miner_id, SUM(difficulty)/600.0 FROM shares WHERE ts > $2 GROUP BY miner_id", &[&now, &(now - 600)]).await?;
        c.execute("DELETE FROM hashrate_samples WHERE ts < $1", &[&(now - ChartRange::KEEP_SECS)]).await?;
        c.execute("DELETE FROM shares WHERE ts < $1", &[&(now - 7 * 86400)]).await?;
        c.execute("DELETE FROM share_events WHERE ts < $1", &[&(now - 7 * 86400)]).await?;
        Ok(())
    }

    // ---------- payouts ----------

    /// Miners at or above the payout threshold: (id, address, balance, cached address type). An
    /// `invalid` verdict older than a day is returned as unknown so it gets checked again. Coinbase
    /// accounts have no address: they are paid in blocks.
    pub async fn miners_due(&self, min_payout: i64, now: i64) -> Result<Vec<DuePayout>> {
        let c = self.client().await?;
        let rows = c
            .query(
                "SELECT id, address, balance, CASE WHEN address_type='invalid' AND COALESCE(type_checked,0) < $2 THEN NULL ELSE address_type END
                 FROM miners WHERE balance >= $1 AND address NOT LIKE 'cb:%'
                   AND NOT (COALESCE(address_type,'') = 'invalid' AND COALESCE(type_checked,0) >= $2) ORDER BY balance DESC",
                &[&min_payout, &(now - 86400)],
            )
            .await?;
        Ok(rows.iter().map(|r| (r.get(0), r.get(1), r.get(2), r.get(3))).collect())
    }

    /// Debit `debit` from the miner and record the payment as `created`, atomically. False if the
    /// balance changed meanwhile.
    pub async fn create_payment(&self, miner_id: i64, debit: i64, amount: i64, fee: i64, tx_id: &str, ts: i64) -> Result<bool> {
        let mut c = self.client().await?;
        let tx = c.transaction().await?;
        let n = tx.execute("UPDATE miners SET balance = balance - $2, paid = paid + $3 WHERE id=$1 AND balance >= $2", &[&miner_id, &debit, &amount]).await?;
        if n == 0 {
            tx.rollback().await?;
            return Ok(false);
        }
        tx.execute("INSERT INTO payments (ts, miner_id, amount, fee, debit, tx_id, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,'created',$7)", &[&ts, &miner_id, &amount, &fee, &debit, &tx_id, &crate::state::now()]).await?;
        tx.commit().await?;
        Ok(true)
    }

    pub async fn set_payment_status(&self, tx_id: &str, from: &str, to: &str) -> Result<bool> {
        self.set_payment_status_any(tx_id, &[from], to).await
    }

    /// Moves a payment between states; `pending` also stamps accepted_at, the moment the wallet
    /// took the transaction. Returns false when the row was not in `from` any more.
    pub async fn set_payment_status_any(&self, tx_id: &str, from: &[&str], to: &str) -> Result<bool> {
        let c = self.client().await?;
        let from: Vec<String> = from.iter().map(|s| s.to_string()).collect();
        let n = if to == "pending" {
            c.execute("UPDATE payments SET status='pending', accepted_at = COALESCE(accepted_at, $3) WHERE tx_id=$1 AND status = ANY($2)", &[&tx_id, &from, &crate::state::now()]).await?
        } else {
            c.execute("UPDATE payments SET status=$3 WHERE tx_id=$1 AND status = ANY($2)", &[&tx_id, &from, &to]).await?
        };
        Ok(n == 1)
    }

    /// (status, created_at, accepted_at) of a payment, for the operator commands.
    pub async fn payment_info(&self, tx_id: &str) -> Result<Option<(String, i64, Option<i64>)>> {
        let c = self.client().await?;
        Ok(c.query_opt("SELECT status, created_at, accepted_at FROM payments WHERE tx_id=$1", &[&tx_id]).await?.map(|r| (r.get(0), r.get(1), r.get(2))))
    }

    /// The wallet used a different transaction id than ours.
    pub async fn rename_payment(&self, old: &str, new: &str) -> Result<()> {
        let c = self.client().await?;
        c.execute("UPDATE payments SET tx_id=$2 WHERE tx_id=$1", &[&old, &new]).await?;
        Ok(())
    }

    /// Mark failed and give the debit back, only if the payment is still in `from` (no double refunds).
    pub async fn refund_payment(&self, tx_id: &str, from: &str) -> Result<bool> {
        self.refund_payment_any(tx_id, &[from]).await
    }

    pub async fn refund_payment_any(&self, tx_id: &str, from: &[&str]) -> Result<bool> {
        let mut c = self.client().await?;
        let tx = c.transaction().await?;
        let from: Vec<String> = from.iter().map(|s| s.to_string()).collect();
        let row = tx.query_opt("UPDATE payments SET status='failed' WHERE tx_id=$1 AND status = ANY($2) RETURNING miner_id, debit, amount", &[&tx_id, &from]).await?;
        let Some(row) = row else {
            tx.rollback().await?;
            return Ok(false);
        };
        let (miner_id, debit, amount): (i64, i64, i64) = (row.get(0), row.get(1), row.get(2));
        tx.execute("UPDATE miners SET balance = balance + $2, paid = paid - $3 WHERE id=$1", &[&miner_id, &debit, &amount]).await?;
        tx.commit().await?;
        Ok(true)
    }

    pub async fn complete_payment(&self, tx_id: &str, kernel: &str) -> Result<()> {
        let c = self.client().await?;
        c.execute("UPDATE payments SET status='completed', kernel=$2 WHERE tx_id=$1 AND status='pending'", &[&tx_id, &kernel]).await?;
        Ok(())
    }

    pub async fn bump_payment_attempts(&self, tx_id: &str) -> Result<i32> {
        let c = self.client().await?;
        Ok(c.query_one("UPDATE payments SET attempts = attempts + 1 WHERE tx_id=$1 RETURNING attempts", &[&tx_id]).await?.get(0))
    }

    pub async fn payments_in(&self, statuses: &[&str]) -> Result<Vec<PaymentRow>> {
        let c = self.client().await?;
        let st: Vec<String> = statuses.iter().map(|s| s.to_string()).collect();
        let rows = c
            .query("SELECT p.tx_id, m.address, p.amount, p.fee, p.created_at, p.accepted_at FROM payments p JOIN miners m ON m.id=p.miner_id WHERE p.status = ANY($1) AND p.tx_id IS NOT NULL ORDER BY p.ts", &[&st])
            .await?;
        Ok(rows.iter().map(|r| PaymentRow { tx_id: r.get(0), address: r.get(1), amount: r.get(2), fee: r.get(3), created_at: r.get(4) }).collect())
    }

    // ---------- coinbase payouts ----------

    /// Stores verified pairs. A kernel or commitment already known (the same pair uploaded twice, or a
    /// pair made from the same coin) is skipped and reported by index.
    pub async fn cb_add_pairs(&self, miner_id: i64, pairs: &[(usize, NewPair)], now: i64) -> Result<(u32, Vec<(usize, String)>)> {
        let c = self.client().await?;
        let mut accepted = 0u32;
        let mut rejected = Vec::new();
        for (idx, p) in pairs {
            let n = c
                .execute(
                    "INSERT INTO coinbase_pairs (miner_id, value, kernel, commitment, hex, size, min_height, max_height, created_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING",
                    &[&miner_id, &p.value, &p.kernel, &p.commitment, &p.hex, &p.size, &p.min_height, &p.max_height, &now],
                )
                .await?;
            if n == 1 {
                accepted += 1;
            } else {
                rejected.push((*idx, "already in the stock (same kernel or commitment)".to_string()));
            }
        }
        Ok((accepted, rejected))
    }

    pub async fn cb_stock_count(&self, miner_id: i64) -> Result<i64> {
        let c = self.client().await?;
        Ok(c.query_one("SELECT COUNT(*) FROM coinbase_pairs WHERE miner_id=$1 AND status='stock'", &[&miner_id]).await?.get(0))
    }

    /// Every pair that may go into the block at `height`: in stock, valid there, and not about to expire.
    pub async fn cb_stock(&self, height: i64, margin: i64) -> Result<Vec<StockPair>> {
        let c = self.client().await?;
        let rows = c
            .query(
                "SELECT miner_id, value, size, hex FROM coinbase_pairs WHERE status='stock' AND min_height <= $1 AND max_height >= $1 + $2
                 ORDER BY miner_id, value DESC, id",
                &[&height, &margin],
            )
            .await?;
        Ok(rows.iter().map(|r| StockPair { miner_id: r.get(0), value: r.get(1), size: r.get::<_, i32>(2) as i64, hex: r.get(3) }).collect())
    }

    /// Pairs whose kernels are in the block at `height`: marked mined, summed per miner.
    pub async fn cb_mark_mined(&self, kernels: &[String], height: i64, hash: &str) -> Result<Vec<(i64, i64, i64)>> {
        if kernels.is_empty() {
            return Ok(Vec::new());
        }
        let c = self.client().await?;
        let rows = c
            .query(
                "UPDATE coinbase_pairs SET status='mined', mined_height=$2, mined_hash=$3 WHERE kernel = ANY($1) AND status <> 'mined'
                 RETURNING miner_id, value",
                &[&kernels, &height, &hash],
            )
            .await?;
        let mut per: std::collections::BTreeMap<i64, (i64, i64)> = Default::default();
        for r in rows {
            let e = per.entry(r.get(0)).or_default();
            e.0 += r.get::<_, i64>(1);
            e.1 += 1;
        }
        Ok(per.into_iter().map(|(m, (sum, n))| (m, sum, n)).collect())
    }

    /// One `pending` payment per miner for the pairs mined in a block; it completes when the block
    /// confirms and fails when the block is orphaned (`cb_settle_block`). Idempotent per block and miner.
    pub async fn cb_create_payments(&self, height: i64, hash: &str, paid: &[(i64, i64, i64)], ts: i64) -> Result<()> {
        let c = self.client().await?;
        for (miner_id, amount, _) in paid {
            let tx_id = format!("cb:{height}:{miner_id}");
            let kernel = format!("coinbase@{height} {hash}");
            c.execute(
                "INSERT INTO payments (ts, miner_id, amount, fee, debit, tx_id, kernel, status, created_at, accepted_at)
                 VALUES ($1,$2,$3,0,$3,$4,$5,'pending',$1,$1) ON CONFLICT (tx_id) DO NOTHING",
                &[&ts, miner_id, amount, &tx_id, &kernel],
            )
            .await?;
        }
        Ok(())
    }

    /// The chain dropped everything from `height` on: pairs mined there are back in stock, their payments failed.
    pub async fn cb_rollback(&self, height: i64) -> Result<(u64, u64)> {
        let mut c = self.client().await?;
        let tx = c.transaction().await?;
        let pairs = tx.execute("UPDATE coinbase_pairs SET status='stock', mined_height=NULL, mined_hash=NULL WHERE status='mined' AND mined_height >= $1", &[&height]).await?;
        let pays = tx
            .execute("UPDATE payments SET status='failed' WHERE tx_id LIKE 'cb:%' AND status='pending' AND split_part(tx_id, ':', 2)::BIGINT >= $1", &[&height])
            .await?;
        tx.execute("DELETE FROM chain_headers WHERE height >= $1", &[&height]).await?;
        tx.commit().await?;
        Ok((pairs, pays))
    }

    /// Pairs that would expire within `margin` blocks are never offered again.
    pub async fn cb_expire(&self, height: i64, margin: i64) -> Result<u64> {
        let c = self.client().await?;
        Ok(c.execute("UPDATE coinbase_pairs SET status='expired' WHERE status='stock' AND max_height < $1 + $2", &[&height, &margin]).await?)
    }

    /// Coinbase accounts and their balances (what earlier blocks still owe them).
    pub async fn cb_accounts(&self) -> Result<Vec<(i64, i64)>> {
        let c = self.client().await?;
        let rows = c.query("SELECT id, balance FROM miners WHERE address LIKE 'cb:%'", &[]).await?;
        Ok(rows.iter().map(|r| (r.get(0), r.get(1))).collect())
    }

    pub async fn cb_totals(&self) -> Result<(i64, i64, i64)> {
        let c = self.client().await?;
        let r = c
            .query_one(
                "SELECT (SELECT COUNT(*) FROM miners WHERE address LIKE 'cb:%'), COUNT(*) FILTER (WHERE status='stock'), COUNT(*) FILTER (WHERE status='mined') FROM coinbase_pairs",
                &[],
            )
            .await?;
        Ok((r.get(0), r.get(1), r.get(2)))
    }

    /// The stock and the history of one account, for the API and the miner's tool.
    pub async fn cb_summary(&self, miner_id: i64) -> Result<Value> {
        let c = self.client().await?;
        let stock = c
            .query("SELECT value, COUNT(*) FROM coinbase_pairs WHERE miner_id=$1 AND status='stock' GROUP BY value ORDER BY value", &[&miner_id])
            .await?;
        let r = c
            .query_one(
                "SELECT COUNT(*) FILTER (WHERE status='stock'), COALESCE(SUM(value) FILTER (WHERE status='stock'),0)::BIGINT,
                        COUNT(*) FILTER (WHERE status='mined'), COALESCE(SUM(value) FILTER (WHERE status='mined'),0)::BIGINT,
                        COUNT(DISTINCT mined_height) FILTER (WHERE status='mined'), COUNT(*) FILTER (WHERE status='expired'),
                        MIN(max_height) FILTER (WHERE status='stock')
                 FROM coinbase_pairs WHERE miner_id=$1",
                &[&miner_id],
            )
            .await?;
        Ok(json!({
            "stock": stock.iter().map(|s| json!({ "value": s.get::<_, i64>(0), "count": s.get::<_, i64>(1) })).collect::<Vec<_>>(),
            "stockPairs": r.get::<_, i64>(0), "stockValue": r.get::<_, i64>(1),
            "minedPairs": r.get::<_, i64>(2), "minedValue": r.get::<_, i64>(3), "blocks": r.get::<_, i64>(4),
            "expiredPairs": r.get::<_, i64>(5), "expiresAt": r.get::<_, Option<i64>>(6),
        }))
    }

    /// Records the chain as the finalizer sees it. Returns the lowest height whose stored hash differed:
    /// a reorganization from there.
    pub async fn chain_headers_set(&self, headers: &[(i64, String)], now: i64) -> Result<Option<i64>> {
        let c = self.client().await?;
        let mut reorg: Option<i64> = None;
        for (h, hash) in headers {
            let old: Option<String> = c.query_opt("SELECT hash FROM chain_headers WHERE height=$1", &[h]).await?.map(|r| r.get(0));
            if let Some(o) = old {
                if &o != hash {
                    reorg = Some(reorg.map_or(*h, |r| r.min(*h)));
                }
            }
            c.execute(
                "INSERT INTO chain_headers (height, hash, seen_at) VALUES ($1,$2,$3) ON CONFLICT (height) DO UPDATE SET hash=EXCLUDED.hash, seen_at=EXCLUDED.seen_at",
                &[h, hash, &now],
            )
            .await?;
        }
        if let Some(max) = headers.iter().map(|(h, _)| *h).max() {
            c.execute("DELETE FROM chain_headers WHERE height < $1", &[&(max - 100_000)]).await?;
        }
        Ok(reorg)
    }

    pub async fn chain_header(&self, height: i64) -> Result<Option<String>> {
        let c = self.client().await?;
        Ok(c.query_opt("SELECT hash FROM chain_headers WHERE height=$1", &[&height]).await?.map(|r| r.get(0)))
    }

    pub async fn chain_tip(&self) -> Result<Option<i64>> {
        let c = self.client().await?;
        Ok(c.query_one("SELECT MAX(height) FROM chain_headers", &[]).await?.get(0))
    }
}

/// Settles the coinbase payments of a block inside the confirmation transaction: confirmed moves the
/// debits to the balances and completes the payments, anything else fails them and frees the pairs.
pub async fn cb_settle_block<C: deadpool_postgres::GenericClient>(tx: &C, height: i64, confirmed: bool) -> Result<u64> {
    let like = format!("cb:{height}:%");
    if confirmed {
        tx.execute(
            "UPDATE miners m SET balance = m.balance - p.debit, paid = m.paid + p.amount FROM payments p WHERE p.miner_id = m.id AND p.tx_id LIKE $1 AND p.status='pending'",
            &[&like],
        )
        .await?;
        Ok(tx.execute("UPDATE payments SET status='completed' WHERE tx_id LIKE $1 AND status='pending'", &[&like]).await?)
    } else {
        tx.execute("UPDATE coinbase_pairs SET status='stock', mined_height=NULL, mined_hash=NULL WHERE status='mined' AND mined_height=$1", &[&height]).await?;
        Ok(tx.execute("UPDATE payments SET status='failed' WHERE tx_id LIKE $1 AND status='pending'", &[&like]).await?)
    }
}

/// PPLNS window over any client or transaction: newest shares back to `since` whose difficulty
/// adds up to `window`, summed per miner.
pub async fn pplns_window_in<C: deadpool_postgres::GenericClient>(c: &C, ts: i64, since: i64, window: f64) -> Result<Vec<(i64, f64)>> {
    let rows = c
        .query(
            "SELECT miner_id, SUM(difficulty)::FLOAT8 FROM (
               SELECT miner_id, difficulty,
                      SUM(difficulty) OVER (ORDER BY ts DESC, id DESC ROWS UNBOUNDED PRECEDING) - difficulty AS before
               FROM shares WHERE mode='pplns' AND ts <= $1 AND ts > $2) s
             WHERE before < $3 GROUP BY miner_id",
            &[&ts, &since, &window],
        )
        .await?;
    Ok(rows.iter().map(|r| (r.get(0), r.get(1))).collect())
}
