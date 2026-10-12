//! The network as the pool page shows it, refreshed every 30 s for all visitors, in the shape
//! pool/API.md gives for /api/network. The chain's own numbers (height, difficulty, block time,
//! hashrate, blocks in 24 h) and BEAM's USD price (the median of Beam's on-chain Oracle2, every
//! 5 min) come from an explorer-node, ours first (`pool.explorer_urls`). The other pools, which the
//! chain does not know: the Beam Terminal's list, which keeps their blocks of the day, with each
//! pool's own API laid over it where it has one, for hashrate, miners, workers and the last block
//! as the pool reports them now. A pool whose API does not answer keeps the terminal's numbers.

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
        let direct = fetch_direct(&shared.http).await;
        if chain.is_some() || pools.is_some() || !direct.is_empty() {
            let mut t = pools.clone().unwrap_or(json!({}));
            overlay(&mut t, direct);
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

/// Pools whose own API the terminal's numbers are checked against: (id, name, website, scheme, fee).
const DIRECT: &[(&str, &str, &str, &str, f64)] = &[
    ("2miners", "2Miners", "https://beam.2miners.com", "PPLNS", 1.0),
    ("2miners-solo", "2Miners (Solo)", "https://solo-beam.2miners.com", "SOLO", 1.5),
    ("herominers", "HeroMiners", "https://beam.herominers.com", "PROP / SOLO", 0.9),
];

/// Every pool in `DIRECT` that answered, in the /api/network row shape, only the fields it gave.
async fn fetch_direct(http: &reqwest::Client) -> Vec<Value> {
    let all = futures_util::future::join_all(DIRECT.iter().map(|&(id, name, site, scheme, fee)| async move {
        let r = if id == "herominers" { herominers(http, site).await } else { two_miners(http, site).await };
        match r {
            Ok(mut v) => {
                for (k, x) in [("id", json!(id)), ("name", json!(name)), ("website", json!(site)), ("scheme", json!(scheme))] {
                    v[k] = x;
                }
                if v["fee"].is_null() {
                    v["fee"] = json!(fee);
                }
                Some(v)
            }
            Err(e) => {
                debug!("{id}: {e:#}");
                None
            }
        }
    }))
    .await;
    all.into_iter().flatten().collect()
}

/// 2Miners' open-ethereum-pool API, one site for each scheme.
async fn two_miners(http: &reqwest::Client, site: &str) -> anyhow::Result<Value> {
    let v = get(http, &format!("{site}/api/stats")).await?;
    let hashrate = num(&v["hashrate"]).ok_or_else(|| anyhow::anyhow!("no hashrate"))?;
    Ok(json!({
        "hashrate": hashrate, "miners": v["minersTotal"], "workers": v["workersTotal"],
        "lastTs": v["stats"]["lastBlockFound"].as_i64(),
    }))
}

/// HeroMiners' cryptonote-pool API: one site, its solo miners counted with the rest, as ours are.
async fn herominers(http: &reqwest::Client, site: &str) -> anyhow::Result<Value> {
    let v = get(http, &format!("{site}/api/stats")).await?;
    let p = &v["pool"];
    let hashrate = num(&p["hashrate"]).ok_or_else(|| anyhow::anyhow!("no hashrate"))?;
    let add = |a: &str, b: &str| num(&p[a]).map(|x| x + num(&p[b]).unwrap_or(0.0));
    // last blocks in ms, as strings
    let last = [&p["stats"]["lastBlockFound"], &p["stats"]["lastSoloBlockFound"]].iter()
        .filter_map(|x| num(x)).fold(None, |m: Option<f64>, x| Some(m.map_or(x, |m| m.max(x))));
    Ok(json!({
        "hashrate": hashrate + num(&p["soloHashrate"]).unwrap_or(0.0),
        "miners": add("miners", "soloMiners").map(|x| x as u64), "workers": add("workers", "soloWorkers").map(|x| x as u64),
        "lastTs": last.map(|ms| (ms / 1000.0) as i64), "fee": v["config"]["fee"],
    }))
}

/// Lays each pool's own numbers over the terminal's row for it, or adds the pool when the terminal
/// has no row (the terminal down since start); its blocks of the day then stay unknown.
fn overlay(t: &mut Value, direct: Vec<Value>) {
    if !t["pools"].is_array() {
        t["pools"] = json!([]);
    }
    let rows = t["pools"].as_array_mut().unwrap();
    for d in direct {
        match rows.iter_mut().find(|r| r["id"] == d["id"]) {
            Some(r) => {
                for (k, x) in d.as_object().unwrap() {
                    if !x.is_null() {
                        r[k] = x.clone();
                    }
                }
            }
            None => rows.push(d),
        }
    }
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
