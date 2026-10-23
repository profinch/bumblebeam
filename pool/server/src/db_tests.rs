//! Database tests: each one runs in a schema of its own in the test database (`database.test.url`, or the
//! `BB_TEST_DB` url), created and dropped around it, so they run in parallel and never touch real data. Without a
//! test database they pass without running (say so on stderr).

use crate::db::Db;
use crate::state::{Job, Mode, ShareRow, Submit};
use std::sync::Arc;

struct TestDb {
    db: Db,
    admin: tokio_postgres::Client,
    schema: String,
}

impl TestDb {
    async fn new(name: &str) -> Option<TestDb> {
        let url = std::env::var("BB_TEST_DB").ok().or_else(|| std::fs::read_to_string("database.test.url").ok())?;
        let url = url.trim().to_string();
        let (admin, conn) = tokio_postgres::connect(&url, tokio_postgres::NoTls).await.ok()?;
        tokio::spawn(conn);
        let schema = format!("t_{name}_{}", std::process::id());
        admin.batch_execute(&format!("DROP SCHEMA IF EXISTS {schema} CASCADE; CREATE SCHEMA {schema}")).await.ok()?;
        let sep = if url.contains('?') { '&' } else { '?' };
        let db = Db::connect(&format!("{url}{sep}options=-c%20search_path%3D{schema}")).await.expect("connect with the test schema");
        Some(TestDb { db, admin, schema })
    }
    async fn q(&self, sql: &str) {
        self.admin.batch_execute(&format!("SET search_path={}; {sql}", self.schema)).await.expect(sql);
    }
    async fn i64(&self, sql: &str) -> i64 {
        self.admin.batch_execute(&format!("SET search_path={}", self.schema)).await.unwrap();
        self.admin.query_one(sql, &[]).await.expect(sql).get::<_, i64>(0)
    }
    async fn done(self) {
        let _ = self.admin.batch_execute(&format!("DROP SCHEMA IF EXISTS {} CASCADE", self.schema)).await;
    }
}

macro_rules! test_db {
    ($name:expr) => {
        match TestDb::new($name).await {
            Some(t) => t,
            None => {
                eprintln!("no test database (database.test.url / BB_TEST_DB): {} skipped", $name);
                return;
            }
        }
    };
}

const NOW: i64 = 2_000_000_000;

async fn miner(t: &TestDb, address: &str, balance: i64) -> i64 {
    let id = t.db.miner_id(address, "regular", NOW - 86400).await.unwrap();
    t.q(&format!("UPDATE miners SET balance={balance}, address_type='regular' WHERE id={id}")).await;
    id
}

async fn payment(t: &TestDb, miner_id: i64, ts: i64, status: &str, failed_at: Option<i64>) {
    let fa = failed_at.map(|v| v.to_string()).unwrap_or("NULL".into());
    t.q(&format!(
        "INSERT INTO payments (ts, miner_id, amount, fee, debit, tx_id, status, failed_at) VALUES ({ts}, {miner_id}, 1, 1, 2, md5(random()::text), '{status}', {fa})"
    ))
    .await;
}

async fn due_ids(t: &TestDb) -> Vec<i64> {
    t.db.miners_due(100, NOW, None).await.unwrap().into_iter().map(|d| d.0).collect()
}

#[tokio::test]
async fn payout_backoff() {
    let t = test_db!("backoff");
    let fresh = miner(&t, "aa01", 500).await; // never failed: due
    let one = miner(&t, "aa02", 500).await; // 1 failure an hour ago: waits 2 h
    let three = miner(&t, "aa03", 500).await; // 3 failures, the last 7 h ago: waits 8 h
    let old = miner(&t, "aa04", 500).await; // 3 failures, the last 9 h ago: due again
    let paid = miner(&t, "aa05", 500).await; // failures before a completed payout do not count
    let many = miner(&t, "aa06", 500).await; // 1100 failures: no overflow, waits a day at most
    let late = miner(&t, "aa07", 500).await; // created 10 h ago, failed 1 h ago: counted from the failure
    payment(&t, one, NOW - 3600, "failed", None).await;
    for k in 0..3 {
        payment(&t, three, NOW - 30_000 + k * 1000, "failed", None).await;
        payment(&t, old, NOW - 40_000 + k * 1000, "failed", None).await;
        payment(&t, paid, NOW - 90_000 + k * 1000, "failed", None).await;
    }
    payment(&t, paid, NOW - 50_000, "completed", None).await;
    t.q(&format!("INSERT INTO payments (ts, miner_id, amount, fee, debit, tx_id, status) SELECT {} - k, {many}, 1, 1, 2, 'm' || k, 'failed' FROM generate_series(1, 1100) k", NOW - 90_000)).await;
    payment(&t, late, NOW - 36_000, "failed", Some(NOW - 3600)).await;
    let due = due_ids(&t).await;
    assert!(due.contains(&fresh), "a miner that never failed is due");
    assert!(!due.contains(&one), "one failure an hour ago waits 2 h");
    assert!(!due.contains(&three), "three failures, the last 7 h ago, wait 8 h");
    assert!(due.contains(&old), "three failures, the last 9 h ago, are due again");
    assert!(due.contains(&paid), "failures before the last completed payout do not count");
    assert!(due.contains(&many), "1100 failures 25 h ago: due (a day at most), and no POWER overflow");
    assert!(!due.contains(&late), "counted from failed_at, not from the creation");
    // the operator's one-miner payout ignores the backoff
    assert_eq!(t.db.miners_due(100, NOW, Some(one)).await.unwrap().len(), 1);
    // coinbase payments are not payout failures
    t.q(&format!("UPDATE payments SET cb_height = 1 WHERE miner_id = {one}")).await;
    assert!(due_ids(&t).await.contains(&one), "a failed coinbase payment does not back a miner off");
    t.done().await;
}

#[tokio::test]
async fn payout_failures_for_the_miner_page() {
    let t = test_db!("failures");
    let m = miner(&t, "bb01", 0).await;
    assert_eq!(t.db.payout_failures(m).await.unwrap().0, 0);
    payment(&t, m, NOW - 7200, "completed", None).await;
    payment(&t, m, NOW - 3600, "failed", Some(NOW - 1800)).await;
    payment(&t, m, NOW - 1000, "failed", Some(NOW - 500)).await;
    t.q(&format!("UPDATE payments SET failure_reason = 'Transaction timed out' WHERE miner_id = {m} AND ts = {}", NOW - 1000)).await;
    let (n, last, reason) = t.db.payout_failures(m).await.unwrap();
    assert_eq!(n, 2);
    assert_eq!(last, Some(NOW - 500));
    assert_eq!(reason.as_deref(), Some("Transaction timed out"));
    t.done().await;
}

#[tokio::test]
async fn a_hold_stops_the_debit() {
    let t = test_db!("hold");
    let m = miner(&t, "cc01", 1000).await;
    crate::admin::hold(&t.db, m, true, "test").await.unwrap();
    assert!(!t.db.create_payment(m, 1000, 999, 1, "tx-held", NOW).await.unwrap(), "a held miner is not debited");
    assert_eq!(t.i64("SELECT balance FROM miners WHERE address='cc01'").await, 1000);
    crate::admin::hold(&t.db, m, false, "").await.unwrap();
    assert!(t.db.create_payment(m, 1000, 999, 1, "tx-free", NOW).await.unwrap());
    assert_eq!(t.i64("SELECT balance FROM miners WHERE address='cc01'").await, 0);
    // a refund returns the debit and stamps failed_at
    assert!(t.db.refund_payment("tx-free", "created").await.unwrap());
    assert_eq!(t.i64("SELECT balance FROM miners WHERE address='cc01'").await, 1000);
    assert!(t.i64("SELECT COUNT(*) FROM payments WHERE tx_id='tx-free' AND failed_at IS NOT NULL").await == 1);
    t.done().await;
}

#[tokio::test]
async fn coinbase_rollback_refunds_every_pending_payment() {
    let t = test_db!("cbrefund");
    let m = miner(&t, "cb:dd01", 0).await;
    t.q(&format!(
        "INSERT INTO payments (ts, miner_id, amount, fee, debit, tx_id, status, cb_height) VALUES
           ({NOW}, {m}, 10, 0, 10, 'cb1', 'pending', 100), ({NOW}, {m}, 20, 0, 20, 'cb2', 'pending', 101);
         UPDATE miners SET paid = 30 WHERE id = {m}"
    ))
    .await;
    let (_, pays) = t.db.cb_rollback(100).await.unwrap();
    assert_eq!(pays, 2);
    assert_eq!(t.i64("SELECT balance FROM miners WHERE address='cb:dd01'").await, 30, "both debits back, not one");
    assert_eq!(t.i64("SELECT paid FROM miners WHERE address='cb:dd01'").await, 0);
    t.done().await;
}

#[tokio::test]
async fn hashrate_samples_in_one_pass_and_the_prune() {
    let t = test_db!("samples");
    t.db.sample_hashrates(NOW).await.unwrap();
    assert_eq!(t.i64("SELECT COUNT(*) FROM hashrate_samples WHERE scope='pool' AND hashrate=0").await, 1, "no shares: a pool row of 0");
    t.q(&format!(
        "INSERT INTO shares (ts, miner_id, worker, mode, difficulty, height) VALUES
           ({n}, 1, 'w', 'pplns', 600, 1), ({n}, 1, 'w', 'solo', 1200, 1), ({n}, 2, 'w', 'pplns', 1800, 1), ({old}, 2, 'w', 'pplns', 99999, 1)",
        n = NOW + 50, old = NOW - 8 * 86400
    ))
    .await;
    t.db.sample_hashrates(NOW + 60).await.unwrap();
    for (scope, want) in [("pool", 3600), ("pplns", 2400), ("solo", 1200), ("m:1", 1800), ("m:1:solo", 1200), ("m:2:pplns", 1800)] {
        let got = t.i64(&format!("SELECT (hashrate * 600)::BIGINT FROM hashrate_samples WHERE ts={} AND scope='{scope}'", NOW + 60)).await;
        assert_eq!(got, want, "{scope}");
    }
    assert_eq!(t.i64(&format!("SELECT COUNT(*) FROM hashrate_samples WHERE ts={}", NOW + 60)).await, 8);
    t.q(&format!("INSERT INTO miner_sessions VALUES (1, '1.2.3.4', 'w', 0, {}), (1, '1.2.3.5', 'w', 0, {NOW})", NOW - 91 * 86400)).await;
    t.db.prune(NOW + 60).await.unwrap();
    assert_eq!(t.i64("SELECT COUNT(*) FROM shares").await, 3, "shares over a week old go");
    assert_eq!(t.i64("SELECT COUNT(*) FROM miner_sessions").await, 1, "sessions over 90 days old go");
    t.done().await;
}

#[tokio::test]
async fn batched_shares_and_the_payout_schedule() {
    let t = test_db!("shares");
    let rows: Vec<ShareRow> = (0..2500).map(|k| ShareRow { ts: NOW + k, miner_id: 1 + k % 3, worker: format!("w{}", k % 5), mode: "pplns", difficulty: 1.5, height: 7 }).collect();
    t.db.record_shares(&rows).await.unwrap();
    t.db.record_shares(&[]).await.unwrap();
    assert_eq!(t.i64("SELECT COUNT(*) FROM shares").await, 2500);
    assert_eq!(t.i64("SELECT COUNT(DISTINCT worker) FROM shares").await, 5);
    assert_eq!(t.db.last_payout_ts().await.unwrap(), None);
    let m = miner(&t, "ee01", 0).await;
    payment(&t, m, NOW - 100, "completed", None).await;
    t.q(&format!("INSERT INTO payments (ts, miner_id, amount, fee, debit, tx_id, status, cb_height) VALUES ({NOW}, {m}, 1, 0, 1, 'cbx', 'pending', 5)")).await;
    assert_eq!(t.db.last_payout_ts().await.unwrap(), Some(NOW - 100), "coinbase payments are not payout runs");
    t.done().await;
}

fn submit(height: u64) -> Submit {
    Submit {
        job: Arc::new(Job { upstream_id: "j1".into(), input: [7; 32], net_packed: 12345, height, received: std::time::Instant::now() }),
        nonce: [1; 8],
        output: [2; 104],
        miner_id: 1,
        address: "aa".into(),
        worker: "w".into(),
        mode: Mode::Pplns,
    }
}

#[tokio::test]
async fn block_submissions_lifecycle() {
    let t = test_db!("subs");
    let a = t.db.submission_sent(&submit(100), NOW - 1000).await.unwrap();
    let b = t.db.submission_sent(&submit(101), NOW - 1000).await.unwrap();
    let c = t.db.submission_sent(&submit(102), NOW - 1000).await.unwrap();
    // a accepted and credited; b accepted, not credited; c never answered
    t.db.submission_answered(a, "accepted", Some("h100"), None, NOW - 900).await.unwrap();
    t.db.submission_credited(a, NOW - 899).await.unwrap();
    t.db.submission_answered(b, "accepted", Some("h101"), None, NOW - 900).await.unwrap();
    let todo = t.db.submissions_to_credit(NOW).await.unwrap();
    assert_eq!(todo.len(), 1, "only the accepted, uncredited one");
    let (row, sub, hash, ts) = &todo[0];
    assert_eq!((*row, sub.job.height, hash.as_str(), *ts), (b, 101, "h101", NOW - 1000));
    assert_eq!((sub.nonce, sub.output[0], sub.job.input[0], sub.job.net_packed), ([1; 8], 2, 7, 12345), "the solution round-trips");
    // a credited row is never marked unanswered, even if it stayed 'sent'
    let d = t.db.submission_sent(&submit(103), NOW - 1000).await.unwrap();
    t.db.submission_credited(d, NOW - 800).await.unwrap();
    let unanswered = t.db.submissions_unanswered(NOW - 300).await.unwrap();
    assert_eq!(unanswered.iter().map(|u| u.0).collect::<Vec<_>>(), vec![c]);
    t.done().await;
}
