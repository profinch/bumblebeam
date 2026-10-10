//! Operator commands: `bumblebeam-pool <config> admin list | block <height> confirm|orphan
//! [--force] | payment <txid> sent|refund [--force] | merge <from address> <to address> |
//! probe-txid [groth]`. The same actions back the operator's dashboard (api.rs, /admin).
//!
//! They act on what the automatic checks left for a human: `unverified` blocks and payments in
//! `review` (or stuck in `created`/`sending` for over an hour). A refund asks the wallet first and
//! is refused while the wallet knows the transaction, unless forced. Confirming a block that is
//! still `pending` (not yet mature) also needs `--force`. A merge moves what a miner mined under a
//! wrong address (shares, credits, unpaid balance, found blocks) to the right one.

use crate::config::Config;
use crate::db::Db;
use crate::wallet::Wallet;
use anyhow::{bail, Result};
use serde_json::{json, Value};

pub async fn run(db: &Db, cfg: &Config, http: reqwest::Client, args: &[String]) -> Result<()> {
    let force = args.iter().any(|a| a == "--force");
    let args: Vec<&str> = args.iter().map(|s| s.as_str()).filter(|a| *a != "--force").collect();
    let wallet = if cfg.wallet_enabled() { Some(Wallet::new(&cfg.wallet_api.url, &cfg.wallet_api.acl_key, http)) } else { None };
    match args.as_slice() {
        ["list"] => list(db).await,
        ["block", height, action] => Ok(println!("{}", block(db, height.parse()?, action, force).await?)),
        ["payment", tx_id, action] => Ok(println!("{}", payment(db, wallet.as_ref(), tx_id, action, force).await?)),
        ["merge", from, to] => {
            let c = db.client().await?;
            let Some(r) = c.query_opt("SELECT id FROM miners WHERE address=$1", &[from]).await? else { bail!("no miner {from}") };
            Ok(println!("{}", merge(db, r.get(0), to).await?))
        }
        ["probe-txid", ..] => {
            let Some(w) = wallet.as_ref() else { bail!("probe-txid needs wallet_api.url in the config") };
            let amount: u64 = args.get(1).map(|a| a.parse()).transpose()?.unwrap_or(100_000);
            crate::payouts::probe_txid(db, w, amount, args.get(2).copied()).await
        }
        _ => bail!("usage: admin list | admin block <height> confirm|orphan [--force] | admin payment <txid> sent|refund [--force] | admin merge <from address> <to address> | admin probe-txid [groth] [address]"),
    }
}

/// What waits for an operator: unverified blocks, payments in review or stuck, and whether the
/// wallet's txId deduplication is proven. Blocks orphaned in the last 7 days come along for review;
/// they need no action.
pub async fn attention(db: &Db) -> Result<Value> {
    let c = db.client().await?;
    let now = crate::state::now();
    let blocks: Vec<Value> = c
        .query("SELECT height, hash, verified_by, reward, ts, mode, status FROM blocks WHERE status='unverified' ORDER BY height", &[])
        .await?
        .iter()
        .map(|r| {
            json!({ "height": r.get::<_, i64>(0), "hash": r.get::<_, Option<String>>(1), "verifiedBy": r.get::<_, Option<String>>(2),
                    "reward": r.get::<_, i64>(3), "ts": r.get::<_, i64>(4), "mode": r.get::<_, String>(5), "status": r.get::<_, String>(6) })
        })
        .collect();
    let orphaned: Vec<Value> = c
        .query("SELECT height, hash, verified_by, reward, ts, mode FROM blocks WHERE status='orphaned' AND ts > $1 ORDER BY height DESC", &[&(now - 7 * 86400)])
        .await?
        .iter()
        .map(|r| {
            json!({ "height": r.get::<_, i64>(0), "hash": r.get::<_, Option<String>>(1), "verifiedBy": r.get::<_, Option<String>>(2),
                    "reward": r.get::<_, i64>(3), "ts": r.get::<_, i64>(4), "mode": r.get::<_, String>(5) })
        })
        .collect();
    let payments: Vec<Value> = c
        .query(
            "SELECT p.tx_id, p.status, p.amount, p.fee, p.attempts, m.address, p.created_at, m.id FROM payments p JOIN miners m ON m.id=p.miner_id
             WHERE p.status='review' OR (p.status IN ('created','sending') AND p.created_at < $1) ORDER BY p.ts",
            &[&(now - 3600)],
        )
        .await?
        .iter()
        .map(|r| {
            json!({ "txId": r.get::<_, Option<String>>(0), "status": r.get::<_, String>(1), "amount": r.get::<_, i64>(2), "fee": r.get::<_, i64>(3),
                    "attempts": r.get::<_, i32>(4), "address": r.get::<_, String>(5), "created": r.get::<_, i64>(6), "minerId": r.get::<_, i64>(7) })
        })
        .collect();
    let txid = c.query_opt("SELECT value FROM meta WHERE key=$1", &[&crate::payouts::META_TXID_HONORED]).await?.map(|r| r.get::<_, String>(0));
    Ok(json!({ "blocks": blocks, "orphaned": orphaned, "payments": payments, "txidHonored": txid }))
}

async fn list(db: &Db) -> Result<()> {
    let a = attention(db).await?;
    println!("blocks waiting for an operator (unverified):");
    for b in a["blocks"].as_array().into_iter().flatten() {
        println!("  height {} hash {} reward {} ({})", b["height"], b["hash"].as_str().unwrap_or(""), b["reward"], b["verifiedBy"].as_str().unwrap_or(""));
    }
    println!("payments waiting for an operator (review, or created/sending for over an hour):");
    for p in a["payments"].as_array().into_iter().flatten() {
        let addr = p["address"].as_str().unwrap_or("");
        println!("  txid {} status {} amount {} fee {} attempts {} to {}…", p["txId"].as_str().unwrap_or(""), p["status"].as_str().unwrap_or(""), p["amount"], p["fee"], p["attempts"], &addr[..addr.len().min(12)]);
    }
    match a["txidHonored"].as_str() {
        Some(v) => println!("txId deduplication proven (resend of interrupted payments enabled): {v}"),
        None => println!("txId deduplication: not proven; run `admin probe-txid` once with a little balance in the wallet"),
    }
    Ok(())
}

pub async fn block(db: &Db, height: i64, action: &str, force: bool) -> Result<String> {
    let mut c = db.client().await?;
    let tx = c.transaction().await?;
    let status = match action {
        "confirm" => "confirmed",
        "orphan" => "orphaned",
        _ => bail!("action must be confirm or orphan"),
    };
    let from: Vec<String> = if force { vec!["unverified".into(), "pending".into()] } else { vec!["unverified".into()] };
    let n = tx.execute("UPDATE blocks SET status=$2, verified_by='operator' WHERE height=$1 AND status = ANY($3)", &[&height, &status, &from]).await?;
    if n != 1 {
        bail!("block {height} is not unverified (a pending block needs --force; coinbase is not mature before 240 blocks)");
    }
    if status == "confirmed" {
        tx.execute(
            "UPDATE miners m SET balance = m.balance + s.sum FROM (SELECT miner_id, SUM(amount)::BIGINT AS sum FROM credits WHERE block_height=$1 GROUP BY miner_id) s WHERE m.id = s.miner_id",
            &[&height],
        )
        .await?;
    }
    // coinbase payments of the block follow the verdict: completed, or refunded with the pairs freed
    let settled = crate::db::cb_settle_block(&tx, height, status).await?;
    tx.commit().await?;
    Ok(format!("block {height}: {status} by operator{}", if settled > 0 { format!(", {settled} coinbase payment(s) settled") } else { String::new() }))
}

pub async fn payment(db: &Db, wallet: Option<&Wallet>, tx_id: &str, action: &str, force: bool) -> Result<String> {
    // `sending` is a resend in flight by the running pool: hands off unless forced
    let from: Vec<&str> = if force { vec!["review", "created", "sending"] } else { vec!["review", "created"] };
    match action {
        "sent" => {
            if !db.set_payment_status_any(tx_id, &from, "pending").await? {
                bail!("payment {tx_id} is not in review/created (sending needs --force)");
            }
            Ok(format!("payment {tx_id}: pending (will be polled for its kernel)"))
        }
        "refund" => {
            if !force {
                let Some((status, created_at, accepted_at)) = db.payment_info(tx_id).await? else { bail!("no payment {tx_id}") };
                if crate::state::now() - created_at < 3600 {
                    bail!("payment {tx_id} is less than an hour old and the pool may still be resolving it; wait or use --force");
                }
                let Some(w) = wallet else { bail!("no wallet configured to check the transaction; use --force only if you have checked it yourself") };
                match w.tx_status(tx_id).await {
                    Ok(st) => {
                        let s = st["status"].as_u64().unwrap_or(0);
                        if s != 2 && s != 4 {
                            bail!("the wallet knows transaction {tx_id} with status {s} (not cancelled/failed): refunding would pay twice; use --force only if you are sure");
                        }
                        // cancelled or failed by the wallet's own account: safe to refund
                    }
                    Err(e) if e.is_unknown_tx() => {
                        if accepted_at.is_some() {
                            bail!("payment {tx_id} ({status}) was accepted by the wallet once and the wallet does not know it now: it lost its history, the transaction may be on the chain. Check the chain, then --force");
                        }
                    }
                    Err(e) => bail!("cannot ask the wallet about {tx_id}: {e}; retry or use --force"),
                }
            }
            if !db.refund_payment_any(tx_id, &from).await? {
                bail!("payment {tx_id} is not in review/created (sending needs --force)");
            }
            Ok(format!("payment {tx_id}: failed, debit returned to the miner"))
        }
        _ => bail!("action must be sent or refund"),
    }
}

/// Moves what miner `from_id` mined to the account of address `to`, a miner of this pool: shares, share
/// events, hashrate samples, block credits (pending ones are paid to `to` when they mature), found
/// blocks and the unpaid balance. Payout history stays where it was paid: a miner that was already
/// paid keeps its row with a zero balance, one never paid is deleted. Refused while a payment of
/// `from` is in flight, and for coinbase accounts (their pairs are made with the miner's own keys).
/// The caller ends `from`'s connections first, or their next shares would recreate it. Never to a
/// new account: a typo in a long address can pass even the wallet's check (the tail of a new-style
/// regular address is not covered) and would open an account nobody is paid to. An address becomes
/// a miner with one stratum login, so a fresh one is logged in once before the move.
pub async fn merge(db: &Db, from_id: i64, to: &str) -> Result<String> {
    let to: String = to.chars().filter(|c| !c.is_whitespace()).collect();
    let mut c = db.client().await?;
    let tx = c.transaction().await?;
    let Some(src) = tx.query_opt("SELECT address, balance FROM miners WHERE id=$1 FOR UPDATE", &[&from_id]).await? else { bail!("no miner {from_id}") };
    let (src_addr, balance): (String, i64) = (src.get(0), src.get(1));
    if src_addr.starts_with("cb:") {
        bail!("coinbase accounts cannot be merged: their pairs pay the miner's own keys");
    }
    if to.starts_with("cb:") {
        bail!("cannot merge into a coinbase account");
    }
    let Some(dst) = tx.query_opt("SELECT id FROM miners WHERE address=$1 FOR UPDATE", &[&to]).await? else {
        bail!("not a miner of this pool: log in once with this address (any miner, or the rental profile), then move to it");
    };
    let to_id: i64 = dst.get(0);
    if to_id == from_id {
        bail!("both addresses are the same miner");
    }
    let inflight: i64 = tx
        .query_one("SELECT COUNT(*) FROM payments WHERE miner_id=$1 AND status NOT IN ('completed','failed')", &[&from_id])
        .await?
        .get(0);
    if inflight > 0 {
        bail!("{inflight} payment(s) of this miner are in flight; resolve them first");
    }
    let shares = tx.execute("UPDATE shares SET miner_id=$2 WHERE miner_id=$1", &[&from_id, &to_id]).await?;
    tx.execute("UPDATE share_events SET miner_id=$2 WHERE miner_id=$1", &[&from_id, &to_id]).await?;
    let credits = tx.execute("UPDATE credits SET miner_id=$2 WHERE miner_id=$1", &[&from_id, &to_id]).await?;
    let blocks = tx.execute("UPDATE blocks SET miner_id=$2 WHERE miner_id=$1", &[&from_id, &to_id]).await?;
    tx.execute("UPDATE hashrate_samples SET scope=$2 WHERE scope=$1", &[&format!("m:{from_id}"), &format!("m:{to_id}")]).await?;
    tx.execute(
        "UPDATE miners SET balance = balance + $2, last_share = GREATEST(last_share, (SELECT last_share FROM miners WHERE id=$3)) WHERE id=$1",
        &[&to_id, &balance, &from_id],
    )
    .await?;
    let paid: i64 = tx.query_one("SELECT COUNT(*) FROM payments WHERE miner_id=$1", &[&from_id]).await?.get(0);
    if paid == 0 {
        tx.execute("DELETE FROM miners WHERE id=$1", &[&from_id]).await?;
    } else {
        tx.execute("UPDATE miners SET balance = 0 WHERE id=$1", &[&from_id]).await?;
    }
    tx.commit().await?;
    // a share or a block credit written by a transaction that overlapped ours
    let late = c.execute("UPDATE shares SET miner_id=$2 WHERE miner_id=$1", &[&from_id, &to_id]).await?
        + c.execute("UPDATE credits SET miner_id=$2 WHERE miner_id=$1", &[&from_id, &to_id]).await?;
    tracing::info!(from = %crate::state::Short(&src_addr), to = %crate::state::Short(&to), shares, credits, blocks, balance, late, "merged by operator");
    Ok(format!(
        "moved {shares} shares, {credits} block credits, {blocks} found blocks and a balance of {balance} groth to {}; {}",
        crate::state::Short(&to),
        if paid == 0 { "the old account is deleted" } else { "the old account keeps its payout history" }
    ))
}

/// Miners for the operator, the most recently active first; `q` filters by a piece of the address.
pub async fn miners(db: &Db, q: &str, limit: i64) -> Result<Vec<Value>> {
    let c = db.client().await?;
    let now = crate::state::now();
    let rows = c
        .query(
            "WITH s AS (SELECT miner_id, COUNT(*) AS n, SUM(difficulty)::FLOAT8 AS d, array_agg(DISTINCT worker) AS workers
                        FROM shares WHERE ts > $1 GROUP BY miner_id),
                  im AS (SELECT c.miner_id, SUM(c.amount)::BIGINT AS sum FROM credits c JOIN blocks b ON b.height=c.block_height
                         WHERE b.status IN ('pending','unverified') GROUP BY c.miner_id)
             SELECT m.id, m.address, m.address_type, m.first_seen, m.last_share, m.balance, m.paid, COALESCE(im.sum,0)::BIGINT,
                    COALESCE(s.n,0)::BIGINT, COALESCE(s.d,0)::FLOAT8, COALESCE(s.workers, ARRAY[]::TEXT[])
             FROM miners m LEFT JOIN s ON s.miner_id=m.id LEFT JOIN im ON im.miner_id=m.id
             WHERE $2 = '' OR strpos(lower(m.address), lower($2)) > 0
             ORDER BY COALESCE(m.last_share, m.first_seen) DESC, m.id DESC LIMIT $3",
            &[&(now - 86400), &q, &limit],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|r| {
            json!({ "id": r.get::<_, i64>(0), "address": r.get::<_, String>(1), "type": r.get::<_, Option<String>>(2),
                    "firstSeen": r.get::<_, i64>(3), "lastShare": r.get::<_, Option<i64>>(4), "balance": r.get::<_, i64>(5),
                    "paid": r.get::<_, i64>(6), "immature": r.get::<_, i64>(7), "shares24h": r.get::<_, i64>(8),
                    "hashrate24h": r.get::<_, f64>(9) / 86400.0, "workers24h": r.get::<_, Vec<String>>(10) })
        })
        .collect())
}

/// One miner for the operator: its row, workers over 7 days, block credits and payments.
pub async fn miner(db: &Db, id: i64) -> Result<Option<Value>> {
    let c = db.client().await?;
    let now = crate::state::now();
    let Some(m) = c.query_opt("SELECT id, address, address_type, first_seen, last_share, balance, paid FROM miners WHERE id=$1", &[&id]).await? else {
        return Ok(None);
    };
    let workers: Vec<Value> = c
        .query(
            "SELECT worker, COUNT(*)::BIGINT, SUM(difficulty)::FLOAT8, MIN(ts), MAX(ts), array_agg(DISTINCT mode) FROM shares
             WHERE miner_id=$1 AND ts > $2 GROUP BY worker ORDER BY MAX(ts) DESC",
            &[&id, &(now - 7 * 86400)],
        )
        .await?
        .iter()
        .map(|r| {
            json!({ "worker": r.get::<_, String>(0), "shares": r.get::<_, i64>(1), "difficulty": r.get::<_, f64>(2),
                    "first": r.get::<_, i64>(3), "last": r.get::<_, i64>(4), "modes": r.get::<_, Vec<String>>(5) })
        })
        .collect();
    let credits: Vec<Value> = c
        .query(
            "SELECT c.block_height, SUM(c.amount)::BIGINT, b.status, b.ts FROM credits c JOIN blocks b ON b.height=c.block_height
             WHERE c.miner_id=$1 GROUP BY c.block_height, b.status, b.ts ORDER BY c.block_height DESC LIMIT 500",
            &[&id],
        )
        .await?
        .iter()
        .map(|r| json!({ "height": r.get::<_, i64>(0), "amount": r.get::<_, i64>(1), "status": r.get::<_, String>(2), "ts": r.get::<_, i64>(3) }))
        .collect();
    let payments: Vec<Value> = c
        .query("SELECT ts, amount, fee, status, tx_id, kernel FROM payments WHERE miner_id=$1 ORDER BY ts DESC LIMIT 500", &[&id])
        .await?
        .iter()
        .map(|r| {
            json!({ "ts": r.get::<_, i64>(0), "amount": r.get::<_, i64>(1), "fee": r.get::<_, i64>(2), "status": r.get::<_, String>(3),
                    "txId": r.get::<_, Option<String>>(4), "kernel": r.get::<_, Option<String>>(5) })
        })
        .collect();
    let found: i64 = c.query_one("SELECT COUNT(*) FROM blocks WHERE miner_id=$1", &[&id]).await?.get(0);
    Ok(Some(json!({
        "id": m.get::<_, i64>(0), "address": m.get::<_, String>(1), "type": m.get::<_, Option<String>>(2), "firstSeen": m.get::<_, i64>(3),
        "lastShare": m.get::<_, Option<i64>>(4), "balance": m.get::<_, i64>(5), "paid": m.get::<_, i64>(6), "blocksFound": found,
        "workers": workers, "credits": credits, "payments": payments,
    })))
}
