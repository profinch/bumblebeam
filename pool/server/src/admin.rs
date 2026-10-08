//! Operator commands: `bumblebeam-pool <config> admin list | block <height> confirm|orphan
//! [--force] | payment <txid> sent|refund [--force] | probe-txid [groth]`.
//!
//! They act on what the automatic checks left for a human: `unverified` blocks and payments in
//! `review` (or stuck in `created`/`sending` for over an hour). A refund asks the wallet first and
//! is refused while the wallet knows the transaction, unless forced. Confirming a block that is
//! still `pending` (not yet mature) also needs `--force`.

use crate::config::Config;
use crate::db::Db;
use crate::wallet::Wallet;
use anyhow::{bail, Result};

pub async fn run(db: &Db, cfg: &Config, http: reqwest::Client, args: &[String]) -> Result<()> {
    let force = args.iter().any(|a| a == "--force");
    let args: Vec<&str> = args.iter().map(|s| s.as_str()).filter(|a| *a != "--force").collect();
    let wallet = if cfg.wallet_enabled() { Some(Wallet::new(&cfg.wallet_api.url, &cfg.wallet_api.acl_key, http)) } else { None };
    match args.as_slice() {
        ["list"] => list(db).await,
        ["block", height, action] => block(db, height.parse()?, action, force).await,
        ["payment", tx_id, action] => payment(db, wallet.as_ref(), tx_id, action, force).await,
        ["probe-txid", ..] => {
            let Some(w) = wallet.as_ref() else { bail!("probe-txid needs wallet_api.url in the config") };
            let amount: u64 = args.get(1).map(|a| a.parse()).transpose()?.unwrap_or(100_000);
            crate::payouts::probe_txid(db, w, amount, args.get(2).copied()).await
        }
        _ => bail!("usage: admin list | admin block <height> confirm|orphan [--force] | admin payment <txid> sent|refund [--force] | admin probe-txid [groth] [address]"),
    }
}

async fn list(db: &Db) -> Result<()> {
    let c = db.client().await?;
    let now = crate::state::now();
    println!("blocks waiting for an operator (unverified):");
    for r in c.query("SELECT height, hash, verified_by, reward FROM blocks WHERE status='unverified' ORDER BY height", &[]).await? {
        println!("  height {} hash {} reward {} ({})", r.get::<_, i64>(0), r.get::<_, Option<String>>(1).unwrap_or_default(), r.get::<_, i64>(3), r.get::<_, Option<String>>(2).unwrap_or_default());
    }
    println!("payments waiting for an operator (review, or created/sending for over an hour):");
    for r in c
        .query(
            "SELECT p.tx_id, p.status, p.amount, p.fee, p.attempts, m.address FROM payments p JOIN miners m ON m.id=p.miner_id
             WHERE p.status='review' OR (p.status IN ('created','sending') AND p.created_at < $1) ORDER BY p.ts",
            &[&(now - 3600)],
        )
        .await?
    {
        println!("  txid {} status {} amount {} fee {} attempts {} to {}…", r.get::<_, Option<String>>(0).unwrap_or_default(), r.get::<_, String>(1), r.get::<_, i64>(2), r.get::<_, i64>(3), r.get::<_, i32>(4), &r.get::<_, String>(5)[..12]);
    }
    match c.query_opt("SELECT value FROM meta WHERE key=$1", &[&crate::payouts::META_TXID_HONORED]).await? {
        Some(r) => println!("txId deduplication proven (resend of interrupted payments enabled): {}", r.get::<_, String>(0)),
        None => println!("txId deduplication: not proven; run `admin probe-txid` once with a little balance in the wallet"),
    }
    Ok(())
}

async fn block(db: &Db, height: i64, action: &str, force: bool) -> Result<()> {
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
    println!("block {height}: {status} by operator{}", if settled > 0 { format!(", {settled} coinbase payment(s) settled") } else { String::new() });
    Ok(())
}

async fn payment(db: &Db, wallet: Option<&Wallet>, tx_id: &str, action: &str, force: bool) -> Result<()> {
    // `sending` is a resend in flight by the running pool: hands off unless forced
    let from: Vec<&str> = if force { vec!["review", "created", "sending"] } else { vec!["review", "created"] };
    match action {
        "sent" => {
            if !db.set_payment_status_any(tx_id, &from, "pending").await? {
                bail!("payment {tx_id} is not in review/created (sending needs --force)");
            }
            println!("payment {tx_id}: pending (will be polled for its kernel)");
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
            println!("payment {tx_id}: failed, debit returned to the miner");
        }
        _ => bail!("action must be sent or refund"),
    }
    Ok(())
}
