//! Payouts through wallet-api.
//!
//! Each payment has a transaction id chosen by the pool before anything is sent. In one database
//! transaction the miner is debited and the payment stored as `created`; then `tx_send` is called
//! with that id; then the row becomes `pending`.
//!
//! Recovery after a crash or a timeout rests on one fact: the wallet keeps one transaction per
//! id, so a resend with the same id either sends (exactly once) or is refused as a duplicate.
//! That fact is not assumed: `meta.txid_honored` is "true" only after `admin probe-txid` has sent
//! twice with one id and seen the second refused (it also records the refusal text), and becomes
//! "false" forever if the wallet ever answers a send with another id. Until it is proven,
//! leftover `created` rows go to `review` for an operator instead of being resent. A resend first
//! claims the row (`sending`) so an operator cannot refund it meanwhile.
//! The network fee is deducted from the payout when `miner_pays_tx_fee` is set.

use crate::state::{now, Shared};
use crate::wallet::{Wallet, WalletError};
use anyhow::Result;
use rand::RngCore;
use std::sync::Arc;
use std::time::Duration;
use tracing::{info, warn};

pub const COMMENT: &str = "BumbleBeam pool payout";
pub const META_TXID_HONORED: &str = "txid_honored";
pub const META_TXID_ACCEPTED: &str = "txid_accepted";
pub const META_DUPLICATE_TEXT: &str = "duplicate_error_text";
pub const META_UNKNOWN_TEXT: &str = "unknown_tx_error_text";
const PUSH_TYPES: [&str; 3] = ["offline", "max_privacy", "public_offline"];

pub async fn run(shared: Arc<Shared>) {
    if !shared.cfg.wallet_enabled() {
        warn!("wallet_api.url is empty: payouts disabled, balances accrue");
        return;
    }
    let wallet = Wallet::new(&shared.cfg.wallet_api.url, &shared.cfg.wallet_api.acl_key, shared.http.clone());
    let interval = Duration::from_secs(shared.cfg.pool.payout_interval_secs.max(60));
    let mut next = tokio::time::Instant::now() + interval;
    loop {
        if let Err(e) = recover_created(&shared, &wallet).await {
            warn!("payout recovery: {e:#}");
        }
        if let Err(e) = poll_pending(&shared, &wallet).await {
            warn!("payout status: {e:#}");
        }
        if tokio::time::Instant::now() >= next {
            next += interval;
            if let Err(e) = pay_once(&shared, &wallet).await {
                warn!("payout run: {e:#}");
            }
        }
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}

fn new_tx_id() -> String {
    let mut b = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut b);
    hex::encode(b)
}

/// Whether this wallet has been seen to honour our transaction ids: Some(true), Some(false), or
/// None while unproven.
pub async fn txid_honored(shared: &Arc<Shared>) -> Option<bool> {
    match shared.db.meta_get(META_TXID_HONORED).await.ok().flatten().as_deref() {
        Some("true") => Some(true),
        Some("false") => Some(false),
        _ => None,
    }
}

/// Record what the wallet did with our id. Acceptance alone proves nothing about duplicates, so it
/// only sets `txid_accepted`; "false" (the wallet used another id) is permanent and disables resends.
async fn note_txid(shared: &Arc<Shared>, ours: &str, got: &str) -> Result<()> {
    if got == ours {
        shared.db.meta_set(META_TXID_ACCEPTED, "true").await?;
    } else {
        shared.db.meta_set(META_TXID_HONORED, "false").await?;
        warn!(%ours, %got, "wallet ignored our txId: automatic resend disabled for good, interrupted payments go to review");
    }
    Ok(())
}

async fn dup_text(shared: &Arc<Shared>) -> Option<String> {
    shared.db.meta_get(META_DUPLICATE_TEXT).await.ok().flatten()
}

async fn unknown_text(shared: &Arc<Shared>) -> Option<String> {
    shared.db.meta_get(META_UNKNOWN_TEXT).await.ok().flatten()
}

/// A status change that did not happen means an operator touched the row meanwhile: say so.
fn check_moved(moved: bool, tx_id: &str, to: &str) {
    if !moved {
        tracing::error!(%tx_id, to, "payment status change did not apply: the row was changed by someone else (operator?) while the wallet acted on it; check it");
    }
}

/// Address type from the miners table, or from the wallet once, cached.
async fn address_type(shared: &Arc<Shared>, wallet: &Wallet, miner_id: i64, address: &str, cached: Option<String>) -> Result<Option<String>> {
    // types ending in '?' were guessed from the login string; only the wallet's verdict is cached
    if let Some(t) = cached.filter(|t| !t.ends_with('?')) {
        return Ok(if t == "invalid" { None } else { Some(t) });
    }
    let v = match wallet.validate_address(address).await {
        Ok(v) => v,
        Err(e) => {
            warn!(%address, "validate_address: {e}");
            return Ok(None);
        }
    };
    let t = if v["is_valid"].as_bool() == Some(true) { v["type"].as_str().unwrap_or("regular").to_string() } else { "invalid".to_string() };
    shared.db.set_address_type(miner_id, &t, now()).await?;
    Ok(if t == "invalid" { None } else { Some(t) })
}

async fn pay_once(shared: &Arc<Shared>, wallet: &Wallet) -> Result<()> {
    let cfg = &shared.cfg;
    let due = shared.db.miners_due(cfg.pool.min_payout_groth as i64, now()).await?;
    if due.is_empty() {
        return Ok(());
    }
    let st = wallet.status().await?;
    let mut available = st["available"].as_u64().unwrap_or(0);
    let ts = now();
    for (miner_id, address, balance, cached_type) in due {
        let Some(kind) = address_type(shared, wallet, miner_id, &address, cached_type).await? else {
            warn!(%address, "no valid address type, payout skipped");
            continue;
        };
        let push = PUSH_TYPES.contains(&kind.as_str());
        let fallback = if push { cfg.wallet_api.shielded_fee_groth } else { cfg.wallet_api.tx_fee_groth };
        let fee = match wallet.required_fee(balance as u64, push).await {
            Ok(f) if f > 0 => f,
            Ok(_) => fallback,
            Err(e) => {
                warn!(%address, "calc_change failed, using configured fee: {e}");
                fallback
            }
        };
        let (value, debit) = if cfg.pool.miner_pays_tx_fee { (balance - fee as i64, balance) } else { (balance, balance) };
        if value <= 0 {
            warn!(%address, balance, fee, "balance does not cover the network fee, payout skipped");
            continue;
        }
        let need = value as u64 + fee;
        if available < need {
            // a miner too big for the wallet right now does not block the smaller ones
            warn!(%address, value, fee, available, "wallet balance too low for this payout, postponed");
            continue;
        }
        let tx_id = new_tx_id();
        if !shared.db.create_payment(miner_id, debit, value, fee as i64, &tx_id, ts).await? {
            continue; // balance changed under us
        }
        match wallet.send(&address, value as u64, fee, COMMENT, &tx_id).await {
            Ok(got) => {
                if got != tx_id {
                    shared.db.rename_payment(&tx_id, &got).await?;
                }
                note_txid(shared, &tx_id, &got).await?;
                check_moved(shared.db.set_payment_status(&got, "created", "pending").await?, &got, "pending");
                available -= need;
                info!(%address, value, fee, tx_id = %got, "payout sent");
            }
            Err(WalletError::Api { message, .. }) => {
                // the wallet refused; before refunding make sure it did not record the transaction anyway
                let unk = unknown_text(shared).await;
                match wallet.tx_status(&tx_id).await {
                    Ok(_) => {
                        check_moved(shared.db.set_payment_status(&tx_id, "created", "pending").await?, &tx_id, "pending");
                        warn!(%address, value, %tx_id, "tx_send answered with an error but the transaction exists, now pending: {message}");
                    }
                    Err(e) if e.is_unknown_tx_with(unk.as_deref()) => {
                        check_moved(shared.db.refund_payment(&tx_id, "created").await?, &tx_id, "failed");
                        warn!(%address, value, fee, "tx_send refused, refunded: {message}");
                    }
                    Err(e) => warn!(%address, %tx_id, "tx_send refused and tx_status unclear, left for recovery: {message} / {e}"),
                }
            }
            Err(e @ WalletError::Transport { .. }) => {
                // unknown whether it was sent: stays `created`, recovery decides later
                warn!(%address, value, %tx_id, "tx_send transport failure, left for recovery: {e}");
                break;
            }
        }
    }
    Ok(())
}

/// Payments debited but not confirmed as sent (`created`, or `sending` from a crash mid-resend).
async fn recover_created(shared: &Arc<Shared>, wallet: &Wallet) -> Result<()> {
    let t = now();
    let honored = txid_honored(shared).await;
    let dup = dup_text(shared).await;
    let unk = unknown_text(shared).await;
    for p in shared.db.payments_in(&["created", "sending"]).await? {
        if t - p.created_at < 120 {
            continue; // the wallet may still be working on the first attempt
        }
        // ask first: a known id means the first attempt went through
        match wallet.tx_status(&p.tx_id).await {
            Ok(_) => {
                check_moved(shared.db.set_payment_status_any(&p.tx_id, &["created", "sending"], "pending").await?, &p.tx_id, "pending");
                info!(address = %p.address, amount = p.amount, tx_id = %p.tx_id, "payment exists in the wallet, now pending");
                continue;
            }
            Err(e) if e.is_unknown_tx_with(unk.as_deref()) => {}
            Err(e) => {
                // neither "known" nor "unknown": count, and hand over after ten
                let attempts = shared.db.bump_payment_attempts(&p.tx_id).await?;
                if attempts >= 10 {
                    shared.db.set_payment_status_any(&p.tx_id, &["created", "sending"], "review").await?;
                    warn!(tx_id = %p.tx_id, "tx_status unclear ten times during recovery, set to review: {e}");
                } else {
                    warn!(tx_id = %p.tx_id, attempts, "tx_status during recovery: {e}");
                }
                continue;
            }
        }
        if honored != Some(true) {
            // a resend is only safe once the wallet is known to keep one transaction per id
            shared.db.set_payment_status_any(&p.tx_id, &["created", "sending"], "review").await?;
            warn!(address = %p.address, amount = p.amount, tx_id = %p.tx_id, "interrupted payment and txId idempotency unproven: set to review (admin payment <txid> sent|refund)");
            continue;
        }
        // claim the row so nobody refunds it while the resend is in flight
        if !shared.db.set_payment_status_any(&p.tx_id, &["created", "sending"], "sending").await? {
            continue;
        }
        match wallet.send(&p.address, p.amount as u64, p.fee as u64, COMMENT, &p.tx_id).await {
            Ok(got) => {
                if got != p.tx_id {
                    shared.db.rename_payment(&p.tx_id, &got).await?;
                }
                note_txid(shared, &p.tx_id, &got).await?;
                check_moved(shared.db.set_payment_status(&got, "sending", "pending").await?, &got, "pending");
                info!(address = %p.address, amount = p.amount, tx_id = %got, "payment resent after a failure, now pending");
            }
            Err(e) if e.is_duplicate_tx(dup.as_deref()) => {
                check_moved(shared.db.set_payment_status(&p.tx_id, "sending", "pending").await?, &p.tx_id, "pending");
                info!(address = %p.address, amount = p.amount, tx_id = %p.tx_id, "payment was already in the wallet, now pending");
            }
            Err(WalletError::Api { message, .. }) => {
                let attempts = shared.db.bump_payment_attempts(&p.tx_id).await?;
                if attempts >= 3 {
                    shared.db.set_payment_status(&p.tx_id, "sending", "review").await?;
                    warn!(address = %p.address, amount = p.amount, tx_id = %p.tx_id, "resend refused three times, set to review: {message}");
                } else {
                    shared.db.set_payment_status(&p.tx_id, "sending", "created").await?;
                    warn!(tx_id = %p.tx_id, attempts, "resend refused, will try again: {message}");
                }
            }
            Err(e @ WalletError::Transport { .. }) => {
                let attempts = shared.db.bump_payment_attempts(&p.tx_id).await?;
                if attempts >= 10 {
                    shared.db.set_payment_status(&p.tx_id, "sending", "review").await?;
                    warn!(tx_id = %p.tx_id, "wallet unreachable ten times for this payment, set to review: {e}");
                } else {
                    warn!(tx_id = %p.tx_id, attempts, "wallet unreachable during resend, row stays `sending`: {e}");
                }
            }
        }
    }
    Ok(())
}

/// `admin probe-txid`: proves, on tiny payments, that the wallet keeps one transaction per id, and
/// records the exact texts of its "duplicate" and "unknown transaction" errors. Three sends: one
/// with a fresh id (must go through), one with the same id (must be refused), one with another
/// fresh id as a control (must go through, or the refusal could have been about funds, not the id).
/// Without `to`, a fresh regular address of the wallet itself is used.
pub async fn probe_txid(db: &crate::db::Db, wallet: &Wallet, amount: u64, to: Option<&str>) -> Result<()> {
    let address = match to {
        Some(a) => a.to_string(),
        None => wallet.create_address("regular", "bumblebeam txid probe").await?,
    };
    let push = matches!(wallet.validate_address(&address).await?["type"].as_str(), Some("offline" | "max_privacy" | "public_offline"));
    let fee = wallet.required_fee(amount, push).await.unwrap_or(1000).max(100);
    let st = wallet.status().await?;
    let available = st["available"].as_u64().unwrap_or(0);
    anyhow::ensure!(available >= 3 * (amount + fee), "the probe needs {} groth available (three sends of {amount} + fee {fee}), the wallet has {available}", 3 * (amount + fee));
    let id = new_tx_id();
    println!("probe: unknown-id check…");
    match wallet.tx_status(&id).await {
        Ok(_) => anyhow::bail!("wallet claims to know a fresh random id {id}; refusing to conclude anything"),
        Err(e) if e.is_unknown_tx() => {
            db.meta_set(META_UNKNOWN_TEXT, &crate::wallet::normalize(e.message())).await?;
            println!("  unknown-transaction text recorded: {:?}", e.message());
        }
        Err(e) => anyhow::bail!("tx_status for a fresh id answered with an unexpected error: {e}"),
    }
    println!("probe: first send of {amount} groth (fee {fee}) to our own address with txId {id}…");
    let got = wallet.send(&address, amount, fee, "bumblebeam txid probe", &id).await?;
    if got != id {
        db.meta_set(META_TXID_HONORED, "false").await?;
        anyhow::bail!("wallet answered with its own id {got}: txId is NOT honoured; automatic resend stays disabled");
    }
    db.meta_set(META_TXID_ACCEPTED, "true").await?;
    println!("  accepted with our id");
    let probes_before = wallet.count_with_comment("bumblebeam txid probe", 200).await?;
    println!("probe: second send with the same txId…");
    match wallet.send(&address, amount, fee, "bumblebeam txid probe", &id).await {
        Ok(got2) if got2 == id => {
            // success with the same id is either idempotent (one transaction) or a second one
            let probes_after = wallet.count_with_comment("bumblebeam txid probe", 200).await?;
            if probes_after > probes_before {
                db.meta_set(META_TXID_HONORED, "false").await?;
                anyhow::bail!("the wallet created a second transaction under the same id: no deduplication; automatic resend disabled for good, and you have paid twice ({amount} groth each)");
            }
            db.meta_set(META_TXID_HONORED, "true").await?;
            println!("  accepted again with the same id and no new transaction: idempotent. Proof recorded: txid_honored=true (no duplicate error text: the wallet answers success).");
            return Ok(());
        }
        Ok(got2) => {
            db.meta_set(META_TXID_HONORED, "false").await?;
            anyhow::bail!("the wallet sent AGAIN under another id ({got2}): no deduplication; automatic resend disabled for good, and you have paid twice ({amount} groth each)");
        }
        Err(WalletError::Api { message, .. }) => {
            println!("  refused: {message:?}");
            // control: the same payment under a fresh id must go through, or the refusal was about
            // funds or fees and proves nothing about the id
            println!("probe: control send with a fresh txId…");
            let id3 = new_tx_id();
            match wallet.send(&address, amount, fee, "bumblebeam txid probe", &id3).await {
                Ok(_) => {
                    db.meta_set(META_DUPLICATE_TEXT, &crate::wallet::normalize(&message)).await?;
                    db.meta_set(META_TXID_HONORED, "true").await?;
                    println!("  control accepted, so the refusal was the duplicate id");
                    println!("proof recorded: txid_honored=true, duplicate text saved. Automatic resend of interrupted payments is now enabled.");
                }
                Err(e) => anyhow::bail!("control send failed too ({e}); the earlier refusal may have been about funds, nothing proven. Add balance and run again"),
            }
        }
        Err(e) => anyhow::bail!("second send failed on transport, nothing proven: {e}"),
    }
    Ok(())
}

async fn poll_pending(shared: &Arc<Shared>, wallet: &Wallet) -> Result<()> {
    for p in shared.db.payments_in(&["pending"]).await? {
        let (tx_id, address, value) = (p.tx_id, p.address, p.amount);
        let st = match wallet.tx_status(&tx_id).await {
            Ok(v) => v,
            Err(e) => {
                let attempts = shared.db.bump_payment_attempts(&tx_id).await?;
                if attempts >= 10 {
                    shared.db.set_payment_status(&tx_id, "pending", "review").await?;
                    warn!(%address, value, %tx_id, "tx_status keeps failing, payment set to review: {e}");
                } else {
                    warn!(%tx_id, attempts, "tx_status: {e}");
                }
                continue;
            }
        };
        // Beam tx statuses: 0 pending, 1 in progress, 2 cancelled, 3 completed, 4 failed, 5 registering
        let status = st["status"].as_u64().unwrap_or(0);
        let kernel = st["kernel"].as_str().unwrap_or("");
        match status {
            3 => {
                shared.db.complete_payment(&tx_id, kernel).await?;
                info!(%address, value, %kernel, "payout completed");
            }
            2 | 4 => {
                if shared.db.refund_payment(&tx_id, "pending").await? {
                    warn!(%address, value, %tx_id, status, reason = %st["failure_reason"], "payout failed, refunded");
                }
            }
            _ => {}
        }
    }
    Ok(())
}
