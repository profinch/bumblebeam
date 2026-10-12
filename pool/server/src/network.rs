//! The network as the pool page shows it, refreshed every 30 s for all visitors, in the shape
//! pool/API.md gives for /api/network. The chain's own numbers (height, difficulty, block time,
//! hashrate, blocks in 24 h) and BEAM's USD price (the median of Beam's on-chain Oracle2, every
//! 5 min) come from an explorer-node, ours first (`pool.explorer_urls`); the other pools, which the
//! chain does not know, from the Beam Terminal's list, which polls each pool's own API.

use crate::config::ORACLE2;
use crate::state::Shared;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tracing::debug;

const TERMINAL: &str = "https://beamterminal.0xmx.net/api/mining/pools";
/// Headers read for a day's block count: more than a day of blocks even at 30 s a block.
const DAY_HEADERS: usize = 3000;
/// Headers the block time and the hashrate average over: an hour at the 60 s target.
const AVG_HEADERS: usize = 60;

#[derive(Default)]
pub struct NetCache {
    pub data: RwLock<Value>,
}

pub async fn run(cache: Arc<NetCache>, shared: Arc<Shared>) {
    // the last of each that came, kept through a failed fetch: stale beats none
    let (mut price, mut chain, mut pools): (Option<f64>, Option<Value>, Option<Value>) = (None, None, None);
    let urls = &shared.cfg.pool.explorer_urls;
    for round in 0u64.. {
        if round % 10 == 0 {
            match first(urls, |u| fetch_price(&shared.http, u)).await {
                Ok(p) => price = Some(p),
                Err(e) => debug!("price: {e:#}"),
            }
        }
        match first(urls, |u| fetch_chain(&shared.http, u)).await {
            Ok(c) => chain = Some(c),
            Err(e) => debug!("chain: {e:#}"),
        }
        match fetch_pools(&shared.http).await {
            Ok(p) => pools = Some(p),
            Err(e) => debug!("pools: {e:#}"),
        }
        if chain.is_some() || pools.is_some() {
            let t = pools.clone().unwrap_or(json!({}));
            let c = chain.clone().unwrap_or(json!({}));
            // the chain's numbers from the node; the terminal's only while the node has none
            let pick = |k: &str| if c[k].is_null() { t[k].clone() } else { c[k].clone() };
            let v = json!({
                "hashrate": pick("hashrate"), "height": pick("height"), "blocks24h": pick("blocks24h"),
                "difficulty": c["difficulty"], "avgBlock": c["avgBlock"], "priceUsd": price,
                "pools": t["pools"].as_array().cloned().unwrap_or_default(),
            });
            if let Some(h) = v["height"].as_u64() {
                shared.net_height.store(h, Ordering::Relaxed);
            }
            *cache.data.write().await = v;
        }
        tokio::time::sleep(Duration::from_secs(30)).await;
    }
}

/// The first of `urls` that answers, or the last error.
async fn first<T, F, Fut>(urls: &[String], f: F) -> anyhow::Result<T>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<T>>,
{
    let mut last = anyhow::anyhow!("no pool.explorer_urls");
    for u in urls {
        match f(u.trim_end_matches('/').to_string()).await {
            Ok(v) => return Ok(v),
            Err(e) => last = e,
        }
    }
    Err(last)
}

fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.replace(',', "").parse().ok(),
        _ => None,
    }
}

async fn get(http: &reqwest::Client, url: &str) -> anyhow::Result<Value> {
    Ok(http.get(url).timeout(Duration::from_secs(10)).send().await?.error_for_status()?.json().await?)
}

async fn fetch_price(http: &reqwest::Client, base: String) -> anyhow::Result<f64> {
    let v = get(http, &format!("{base}/contract?id={ORACLE2}&nMaxTxs=0")).await?;
    // the explorer-node prints the oracle's median as a decimal string
    num(&v["State"]["Median"]).filter(|p| *p > 0.0).ok_or_else(|| anyhow::anyhow!("no State.Median from {base}"))
}

/// Height, difficulty, block time and hashrate over the last hour of headers, and the blocks of the
/// last 24 h. Hashrate is difficulty over block time, Beam's Sol/s.
async fn fetch_chain(http: &reqwest::Client, base: String) -> anyhow::Result<Value> {
    let v = get(http, &format!("{base}/hdrs?nMax={DAY_HEADERS}&cols=Td")).await?;
    // rows after the header row, newest first: [height, {time}, "difficulty"]
    let rows: Vec<(f64, f64, f64)> = v["value"].as_array().map(|a| a.iter().skip(1).filter_map(|r| {
        Some((num(&r[0]["value"])?, num(&r[1]["value"])?, num(&r[2])?))
    }).collect()).unwrap_or_default();
    anyhow::ensure!(rows.len() > AVG_HEADERS, "{} headers from {base}", rows.len());
    let (height, newest, difficulty) = rows[0];
    let avg_block = (newest - rows[AVG_HEADERS].1) / AVG_HEADERS as f64;
    let avg_diff = rows[..AVG_HEADERS].iter().map(|r| r.2).sum::<f64>() / AVG_HEADERS as f64;
    let blocks24h = rows.iter().filter(|r| r.1 > newest - 86400.0).count();
    Ok(json!({
        "height": height as u64, "difficulty": difficulty, "avgBlock": avg_block,
        "hashrate": if avg_block > 0.0 { Some(avg_diff / avg_block) } else { None }, "blocks24h": blocks24h,
    }))
}

async fn fetch_pools(http: &reqwest::Client) -> anyhow::Result<Value> {
    let pools = get(http, TERMINAL).await?;
    Ok(json!({
        "hashrate": pools["network_hashrate"], "height": pools["block_height"], "blocks24h": pools["blocks_24h_total"],
        "pools": pools["pools"].as_array().cloned().unwrap_or_default().iter().map(|p| json!({
            "id": p["id"], "name": p["name"], "website": p["website"], "scheme": p["payout_scheme"], "fee": p["fee"],
            "hashrate": p["hashrate"], "miners": p["miners"], "workers": p["workers"],
            "blocks24h": p.get("blocks_past_24h").cloned().unwrap_or(p["blocks_24h"].clone()),
            "lastTs": p["last_block_ts"].as_str().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()).map(|d| d.timestamp()),
            "series": p["hashrate_series"].as_array().cloned().unwrap_or_default().iter().map(|s| json!([s["ts"], s["value"]])).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    }))
}
