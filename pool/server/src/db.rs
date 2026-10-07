//! PostgreSQL storage: miners, shares, blocks, credits, payments, hashrate samples.
//! Timestamps are unix seconds (BIGINT), amounts are groth (BIGINT), difficulties are the
//! expected number of solutions (DOUBLE PRECISION), so sum(difficulty)/seconds is a hashrate.
//! Shares reference miners by id: an offline Beam address is 400+ characters.

use anyhow::{Context, Result};
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use serde_json::{json, Value};
use std::sync::Mutex;
use tokio_postgres::NoTls;

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

/// Schema version. Older databases are migrated in `migrate`; one without a version is refused.
pub const SCHEMA_VERSION: i32 = 4;

/// Statements that bring a database from version `from` to `from + 1`.
fn migration(from: i32) -> Option<&'static str> {
    match from {
        2 => Some("ALTER TABLE payments ADD COLUMN IF NOT EXISTS created_at BIGINT NOT NULL DEFAULT 0"),
        3 => Some("ALTER TABLE payments ADD COLUMN IF NOT EXISTS accepted_at BIGINT"),
        _ => None,
    }
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
                c.batch_execute(SCHEMA).await.context("schema")?;
                c.execute("INSERT INTO meta (key, value) VALUES ('schema', $1)", &[&SCHEMA_VERSION.to_string()]).await?;
            }
            Some(v) if v == SCHEMA_VERSION => c.batch_execute(SCHEMA).await.context("schema")?,
            Some(mut v) if v < SCHEMA_VERSION => {
                while v < SCHEMA_VERSION {
                    let Some(sql) = migration(v) else { anyhow::bail!("no migration from schema version {v}") };
                    c.batch_execute(sql).await.with_context(|| format!("migrating schema {v} -> {}", v + 1))?;
                    v += 1;
                    c.execute("UPDATE meta SET value=$1 WHERE key='schema'", &[&v.to_string()]).await?;
                    tracing::info!(version = v, "database schema migrated");
                }
                c.batch_execute(SCHEMA).await.context("schema")?;
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

    pub async fn blocks(&self, limit: i64, before: Option<i64>, maturity: i64, tip: Option<i64>) -> Result<Vec<Value>> {
        let c = self.client().await?;
        let sql = "SELECT height, hash, ts, worker, mode, reward, fees, effort, status, verified_by FROM blocks";
        let rows = match before {
            Some(b) => c.query(&format!("{sql} WHERE height < $1 ORDER BY height DESC LIMIT $2"), &[&b, &limit]).await?,
            None => c.query(&format!("{sql} ORDER BY height DESC LIMIT $1"), &[&limit]).await?,
        };
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

    pub async fn miner(&self, address: &str, now: i64) -> Result<Option<Value>> {
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
        let chart = c.query("SELECT ts, hashrate FROM hashrate_samples WHERE scope=$1 AND ts > $2 ORDER BY ts", &[&format!("m:{id}"), &(now - 86400)]).await?;
        let payments = c
            .query("SELECT ts, amount, fee, kernel, status FROM payments WHERE miner_id=$1 AND status <> 'failed' ORDER BY ts DESC LIMIT 50", &[&id])
            .await?;
        Ok(Some(json!({
            "address": address, "addressType": m.get::<_, Option<String>>(4),
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
            "charts": { "hashrate": chart.iter().map(|r| json!([r.get::<_, i64>(0), r.get::<_, f64>(1)])).collect::<Vec<_>>() },
            "payments": payments.iter().map(|p| json!({ "ts": p.get::<_, i64>(0), "amount": p.get::<_, i64>(1), "fee": p.get::<_, i64>(2),
                                                        "kernel": p.get::<_, Option<String>>(3), "status": p.get::<_, String>(4) })).collect::<Vec<_>>(),
        })))
    }

    pub async fn payments(&self, limit: i64) -> Result<Vec<Value>> {
        let c = self.client().await?;
        // one row per payout run (all payments of a run share the timestamp); Beam pays each miner
        // in its own transaction, so a run has several kernels: the latest is shown
        let rows = c
            .query(
                "SELECT ts, SUM(amount)::BIGINT, COUNT(*), MAX(kernel), COUNT(*) FILTER (WHERE status='completed') FROM payments
                 WHERE status <> 'failed' GROUP BY ts ORDER BY ts DESC LIMIT $1",
                &[&limit],
            )
            .await?;
        Ok(rows
            .iter()
            .map(|r| {
                let n: i64 = r.get(2);
                let done: i64 = r.get(4);
                json!({ "ts": r.get::<_, i64>(0), "amount": r.get::<_, i64>(1), "miners": n, "kernel": r.get::<_, Option<String>>(3),
                        "status": if done == n { "completed" } else { "pending" } })
            })
            .collect())
    }

    pub async fn pool_chart(&self, now: i64) -> Result<Vec<Value>> {
        let c = self.client().await?;
        let rows = c.query("SELECT ts, hashrate FROM hashrate_samples WHERE scope='pool' AND ts > $1 ORDER BY ts", &[&(now - 86400)]).await?;
        Ok(rows.iter().map(|r| json!([r.get::<_, i64>(0), r.get::<_, f64>(1)])).collect())
    }

    /// One sample per minute for the pool and for every miner active in the last ten minutes.
    pub async fn sample_hashrates(&self, now: i64) -> Result<()> {
        let c = self.client().await?;
        c.execute("INSERT INTO hashrate_samples (ts, scope, hashrate) SELECT $1, 'pool', COALESCE(SUM(difficulty),0)/600.0 FROM shares WHERE ts > $2", &[&now, &(now - 600)]).await?;
        c.execute("INSERT INTO hashrate_samples (ts, scope, hashrate) SELECT $1, 'm:' || miner_id, SUM(difficulty)/600.0 FROM shares WHERE ts > $2 GROUP BY miner_id", &[&now, &(now - 600)]).await?;
        c.execute("DELETE FROM hashrate_samples WHERE ts < $1", &[&(now - 2 * 86400)]).await?;
        c.execute("DELETE FROM shares WHERE ts < $1", &[&(now - 7 * 86400)]).await?;
        c.execute("DELETE FROM share_events WHERE ts < $1", &[&(now - 7 * 86400)]).await?;
        Ok(())
    }

    // ---------- payouts ----------

    /// Miners at or above the payout threshold: (id, address, balance, cached address type). An
    /// `invalid` verdict older than a day is returned as unknown so it gets checked again.
    pub async fn miners_due(&self, min_payout: i64, now: i64) -> Result<Vec<DuePayout>> {
        let c = self.client().await?;
        let rows = c
            .query(
                "SELECT id, address, balance, CASE WHEN address_type='invalid' AND COALESCE(type_checked,0) < $2 THEN NULL ELSE address_type END
                 FROM miners WHERE balance >= $1 AND NOT (COALESCE(address_type,'') = 'invalid' AND COALESCE(type_checked,0) >= $2) ORDER BY balance DESC",
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
