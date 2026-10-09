//! Blocks and rewards. When the node accepts a block, credits are written: PPLNS over the last
//! `pplns_window` x difficulty of shares, or the whole block to the solo finder, minus the fee.
//!
//! After `maturity` blocks a block is judged by two sources. The wallet is the one that can
//! confirm: the coinbase UTXO (type "mine", maturity = height + 240) is in it or not. The explorer
//! only cross-checks the block hash at that height: a different hash means the chain replaced the
//! block, `found: false` or no answer means nothing. Without the wallet's word nothing is paid:
//! such blocks become `unverified` and an operator decides (`bumblebeam-pool <cfg> admin`).
//! Every verdict is logged with both sources.

use crate::emission::miner_reward_groth;
use crate::pow;
use crate::state::{now, Mode, Shared, Submit};
use crate::wallet::{coinbase_in, Wallet};
use anyhow::Result;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tracing::{info, warn};

pub async fn block_found(shared: &Arc<Shared>, sub: Submit, blockhash: String) -> Result<()> {
    let ts = now();
    let height = sub.job.height as i64;
    let net_diff = pow::difficulty_to_double(sub.job.net_packed);
    let reward = miner_reward_groth(sub.job.height) as i64;
    let mode = sub.mode.as_str();
    let blockhash = blockhash.to_lowercase();

    // effort: shares spent on this round over the expected number
    let (since, scope) = match sub.mode {
        Mode::Pplns => (shared.db.last_block_ts(Some("pplns"), None).await?.unwrap_or(0), None),
        Mode::Solo => (shared.db.last_block_ts(Some("solo"), Some((sub.miner_id, &sub.worker))).await?.unwrap_or(0), Some((sub.miner_id, sub.worker.as_str()))),
    };
    let round = shared.db.round_shares(mode, since, scope).await?;
    let effort = if net_diff > 0.0 { round / net_diff } else { 0.0 };

    let mut c = shared.db.client().await?;
    let tx = c.transaction().await?;
    // A height already recorded: a reorg can replace an orphaned block with a new one of ours, then
    // the old credits go and the new ones are written; anything else at that height is a duplicate.
    let inserted = tx
        .execute(
            "INSERT INTO blocks (height, hash, ts, miner_id, worker, mode, reward, fees, effort, net_difficulty, status, nonce, output)
             VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9,'pending',$10,$11)
             ON CONFLICT (height) DO UPDATE SET hash=EXCLUDED.hash, ts=EXCLUDED.ts, miner_id=EXCLUDED.miner_id, worker=EXCLUDED.worker,
               mode=EXCLUDED.mode, reward=EXCLUDED.reward, effort=EXCLUDED.effort, net_difficulty=EXCLUDED.net_difficulty,
               status='pending', verified_by=NULL, nonce=EXCLUDED.nonce, output=EXCLUDED.output
             WHERE blocks.status='orphaned' AND blocks.hash <> EXCLUDED.hash",
            &[&height, &blockhash, &ts, &sub.miner_id, &sub.worker, &mode, &reward, &effort, &net_diff, &hex::encode(sub.nonce), &hex::encode(sub.output)],
        )
        .await?;
    if inserted == 0 {
        warn!(height, %blockhash, "block at this height already recorded, not crediting twice");
        tx.rollback().await?;
        return Ok(());
    }
    tx.execute("DELETE FROM credits WHERE block_height=$1", &[&height]).await?;
    if shared.coinbase.is_some() {
        let adopted = crate::db::Db::cb_adopt_block(&tx, height, &blockhash, ts).await?;
        if !adopted.is_empty() {
            info!(height, accounts = adopted.len(), groth = adopted.iter().map(|p| p.1).sum::<i64>(), "pairs the finalizer read before the block was recorded are now paid");
        }
    }

    match sub.mode {
        Mode::Solo => {
            let amount = (reward as f64 * (1.0 - shared.cfg.pool.solo_fee_percent / 100.0)).floor() as i64;
            tx.execute("INSERT INTO credits (block_height, miner_id, amount) VALUES ($1,$2,$3)", &[&height, &sub.miner_id, &amount]).await?;
            info!(height, miner = %crate::state::Short(&sub.address), amount, "solo block credited");
        }
        Mode::Pplns => {
            // the window in seconds is window / pool hashrate; look back six times that, at least an hour
            let window = shared.cfg.pool.pplns_window * net_diff;
            let hashrate = shared.db.mode_hashrate("pplns", ts).await?.max(1.0);
            let max_lookback = 3 * 86400;
            let lookback = ((window / hashrate) * 6.0).clamp(3600.0, max_lookback as f64) as i64;
            let mut pplns = crate::db::pplns_window_in(&tx, ts, ts - lookback, window).await?;
            let mut total: f64 = pplns.iter().map(|(_, d)| d).sum();
            if total < window && lookback < max_lookback {
                // the hashrate estimate was too optimistic (a big miner just arrived): take the full history
                pplns = crate::db::pplns_window_in(&tx, ts, ts - max_lookback, window).await?;
                total = pplns.iter().map(|(_, d)| d).sum();
            }
            let (per, total) = if total > 0.0 { (pplns, total) } else { (vec![(sub.miner_id, 1.0)], 1.0) };
            let (amounts, bonus) = pplns_split(reward, shared.cfg.pool.fee_percent, shared.cfg.pool.finder_bonus_percent, &per, total);
            for (miner_id, amount) in amounts.iter().chain(std::iter::once(&(sub.miner_id, bonus))) {
                if *amount > 0 {
                    tx.execute("INSERT INTO credits (block_height, miner_id, amount) VALUES ($1,$2,$3)", &[&height, miner_id, amount]).await?;
                }
            }
            info!(height, miners = per.len(), window, total, lookback, finder = %crate::state::Short(&sub.address), finder_bonus = bonus, "pplns block credited");
        }
    }
    tx.commit().await?;
    Ok(())
}

/// A PPLNS block's credits: the reward minus the fee is the miners' pot; the finder's bonus comes
/// out of it, and the rest is shared in proportion to each miner's difficulty in the window.
/// Returns the per-miner amounts and the bonus, all rounded down (the dust stays with the pool).
pub(crate) fn pplns_split(reward: i64, fee_percent: f64, bonus_percent: f64, per: &[(i64, f64)], total: f64) -> (Vec<(i64, i64)>, i64) {
    let pot = reward as f64 * (1.0 - fee_percent / 100.0);
    let bonus = (pot * bonus_percent / 100.0).floor() as i64;
    let pot = pot - bonus as f64;
    (per.iter().map(|(m, d)| (*m, (pot * d / total).floor() as i64)).collect(), bonus)
}

/// Every minute: mature pending blocks, verify them, move credits to balances.
pub async fn confirm_loop(shared: Arc<Shared>) {
    let wallet = if shared.cfg.wallet_enabled() && shared.cfg.pool.verify_blocks_with_wallet {
        Some(Wallet::new(&shared.cfg.wallet_api.url, &shared.cfg.wallet_api.acl_key, shared.http.clone()))
    } else {
        None
    };
    if wallet.is_none() {
        warn!("no wallet verification: mature blocks become 'unverified' and wait for an operator");
    }
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
        if let Err(e) = confirm_once(&shared, wallet.as_ref()).await {
            warn!("confirm: {e:#}");
        }
    }
}

/// The chain's view of `height` according to the first explorer-node that answers: Some(true) our
/// hash, Some(false) a different block, None when nobody knows (disabled, down, behind, or
/// `found: false`). Returns which source answered.
async fn chain_has(shared: &Arc<Shared>, height: i64, hash: &str) -> (Option<bool>, &'static str) {
    if hash.is_empty() {
        return (None, "none");
    }
    for (i, url) in shared.cfg.pool.block_check_urls.iter().enumerate() {
        let Ok(resp) = shared.http.get(format!("{url}{height}")).send().await else { continue };
        if !resp.status().is_success() {
            continue;
        }
        let Ok(v) = resp.json::<Value>().await else { continue };
        if v["found"].as_bool() == Some(false) {
            continue;
        }
        let Some(h) = v["hash"].as_str().map(|s| s.trim().to_lowercase()) else { continue };
        if h.len() != 64 {
            continue;
        }
        return (Some(h == hash), if i == 0 { "explorer#1" } else { "explorer#2+" });
    }
    (None, "none")
}

/// The verdict from the wallet and the explorer alone (no coinbase mode). None = decide later.
fn verdict_without_node(wallet_says: Option<bool>, chain_says: Option<bool>, long_overdue: bool, height: i64) -> (Option<&'static str>, &'static str) {
    match (wallet_says, chain_says) {
        (Some(true), Some(true)) => (Some("confirmed"), "wallet+explorer"),
        (Some(true), None) => (Some("confirmed"), "wallet"),
        (Some(true), Some(false)) => (Some("unverified"), "wallet says ours, explorer says another block"),
        (Some(false), Some(false)) => (Some("orphaned"), "explorer: another block at this height, no coinbase in the wallet"),
        (Some(false), Some(true)) => (Some("unverified"), "explorer says ours, no coinbase in the wallet (miner key?)"),
        (Some(false), None) if long_overdue => (Some("unverified"), "no coinbase in the wallet 60 blocks past maturity"),
        (Some(false), None) => {
            info!(height, "coinbase not in the wallet yet, retrying");
            (None, "")
        }
        (None, _) => (Some("unverified"), "no wallet verification configured"),
    }
}

async fn confirm_once(shared: &Arc<Shared>, wallet: Option<&Wallet>) -> Result<()> {
    let Some(tip) = shared.tip_height() else { return Ok(()) };
    let maturity = shared.cfg.pool.maturity as i64;
    let rows = {
        let c = shared.db.client().await?;
        c.query("SELECT height, hash, reward FROM blocks WHERE status='pending' AND $1 - height + 1 >= $2 ORDER BY height", &[&(tip as i64), &maturity]).await?
    };
    if rows.is_empty() {
        return Ok(());
    }
    let lowest: i64 = rows[0].get(0);

    // With coinbase payouts the pool's wallet only gets the remainder of a block, so the UTXO check
    // does not apply; our node's chain, as the finalizer reports it, is the judge instead.
    let coinbase_mode = shared.coinbase.is_some();
    let chain_tip = if coinbase_mode { shared.db.chain_tip().await?.unwrap_or(0) } else { 0 };

    // The wallet's UTXO list is conclusive only once the wallet has itself reached the maturity
    // height of a block; it is loaded once per cycle and only when it can decide something.
    let (wallet_height, utxos) = match wallet.filter(|_| !coinbase_mode) {
        Some(w) => {
            let st = match w.status().await {
                Ok(st) => st,
                Err(e) => {
                    warn!("wallet_status failed, confirmations wait: {e}");
                    return Ok(());
                }
            };
            let wh = st["current_height"].as_i64().unwrap_or(0);
            if wh < lowest + maturity {
                warn!(wallet_height = wh, lowest, "wallet behind the chain, confirmations wait");
                return Ok(());
            }
            match w.utxos().await {
                Ok(u) => (wh, Some(u)),
                Err(e) => {
                    warn!("get_utxo failed, confirmations wait: {e}");
                    return Ok(());
                }
            }
        }
        None => (0, None),
    };

    for r in rows {
        let height: i64 = r.get(0);
        let hash: String = r.get::<_, Option<String>>(1).unwrap_or_default();
        let reward: i64 = r.get(2);

        let coinbase = utxos.as_ref().and_then(|u| coinbase_in(u, height as u64, reward as u64));
        let wallet_says = match &utxos {
            Some(_) if wallet_height >= height + maturity => Some(coinbase.is_some()),
            Some(_) => {
                warn!(height, wallet_height, "wallet not yet at this block's maturity, waits");
                continue;
            }
            None => None,
        };
        let (chain_says, source) = chain_has(shared, height, &hash).await;
        // a coinbase still missing long after maturity is not going to appear by itself
        let long_overdue = wallet_height >= height + maturity + 60;

        // our own node's chain, through the finalizer: conclusive once it is past the block's maturity
        let node_says = if coinbase_mode && chain_tip >= height + maturity && !hash.is_empty() {
            shared.db.chain_header(height).await?.map(|h| h == hash)
        } else {
            None
        };

        let (status, by): (Option<&str>, &str) = match (node_says, wallet_says, chain_says) {
            (Some(true), _, Some(false)) => (Some("unverified"), "our node says ours, explorer says another block"),
            (Some(true), _, _) => (Some("confirmed"), "node"),
            (Some(false), _, Some(true)) => (Some("unverified"), "our node says another block, explorer says ours"),
            (Some(false), _, _) => (Some("orphaned"), "our node: another block at this height"),
            (None, _, _) if coinbase_mode && chain_tip >= height + maturity + 60 => {
                (Some("unverified"), "no chain header from the finalizer 60 blocks past maturity (was it down? admin block <h> confirm|orphan)")
            }
            (None, _, _) if coinbase_mode => {
                if chain_tip > 0 && chain_tip < height + maturity {
                    info!(height, chain_tip, "node chain not yet past this block's maturity, waits");
                } else {
                    info!(height, "no chain header from the finalizer for this height yet, waits");
                }
                continue;
            }
            (None, w, c) => verdict_without_node(w, c, long_overdue, height),
        };
        let Some(status) = status else { continue };
        info!(height, %hash, ?node_says, ?wallet_says, ?chain_says, source, status, by, "block verdict");

        let mut c = shared.db.client().await?;
        let tx = c.transaction().await?;
        let n = tx.execute("UPDATE blocks SET status=$2, verified_by=$3 WHERE height=$1 AND status='pending'", &[&height, &status, &by]).await?;
        if n != 1 {
            tx.rollback().await?;
            continue;
        }
        if status == "confirmed" {
            // the coinbase holds the reward plus the block's fees; the fees stay with the pool
            if let Some(amount) = coinbase {
                let fees = (amount as i64 - reward).max(0);
                tx.execute("UPDATE blocks SET fees=$2 WHERE height=$1", &[&height, &fees]).await?;
            }
            tx.execute(
                "UPDATE miners m SET balance = m.balance + s.sum FROM (SELECT miner_id, SUM(amount)::BIGINT AS sum FROM credits WHERE block_height=$1 GROUP BY miner_id) s WHERE m.id = s.miner_id",
                &[&height],
            )
            .await?;
        }
        if coinbase_mode {
            let settled = crate::db::cb_settle_block(&tx, height, status).await?;
            if settled > 0 {
                info!(height, settled, status, "coinbase payments of the block settled");
            }
        }
        tx.commit().await?;
        match status {
            "confirmed" => info!(height, by, "block confirmed, credits paid into balances"),
            "orphaned" => warn!(height, by, "block orphaned"),
            _ => warn!(height, by, "block set to unverified: resolve with `admin block {height} confirm|orphan`"),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::pplns_split;

    #[test]
    fn pplns_split_with_finder_bonus() {
        // 25 BEAM, 0.5% fee, 1% bonus: pot 24.875, bonus 0.24875, 24.62625 shared 3:1
        let (amounts, bonus) = pplns_split(2_500_000_000, 0.5, 1.0, &[(1, 3.0), (2, 1.0)], 4.0);
        assert_eq!(bonus, 24_875_000);
        assert_eq!(amounts, vec![(1, 1_846_968_750), (2, 615_656_250)]);
        assert!(amounts.iter().map(|a| a.1).sum::<i64>() + bonus <= 2_487_500_000);
    }

    #[test]
    fn pplns_split_without_bonus_is_the_old_rule() {
        let (amounts, bonus) = pplns_split(2_500_000_000, 0.5, 0.0, &[(7, 1.0)], 1.0);
        assert_eq!((amounts, bonus), (vec![(7, 2_487_500_000)], 0));
    }
}
