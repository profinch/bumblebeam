//! The network as the pool page shows it, refreshed every 30 s for all visitors, in the shape
//! pool/API.md gives for /api/network. The chain's own numbers (height, difficulty, block time,
//! hashrate, blocks in 24 h) and BEAM's USD price (the median of Beam's on-chain Oracle2, every
//! 5 min) come from an explorer-node, ours first (`pool.explorer_urls`). The other pools, which the
//! chain does not know: the Beam Terminal's list, which keeps their blocks of the day, with each
//! pool's own API laid over it where it has one, for hashrate, miners, workers and the last block
//! as the pool reports them now. A pool whose API does not answer keeps the terminal's numbers.
//!
//! Who found each block: every listed pool's own API names its latest blocks with their hashes,
//! checked against our node's headers (a hash that differs is an orphan and is dropped), and the
//! pool's own database names ours; the terminal's block list only fills a height no pool claims.
//! Kept across rounds, so once a pool has been followed for a whole day without a gap its blocks of
//! the day are counted here instead of taken from the terminal. `/api/network/blocks` serves them.
//!
//! The network's hashrate is the pools' current figures, which they measure from thousands of
//! shares, over the part of the network they cover: what the rest (solo nodes, pools with no API)
//! mines can only be seen in its blocks, so its part is its share of the day's blocks. The chain's
//! own estimate, from 24 h of blocks, is `chainHashrate`; an hour of blocks is ±13% on luck alone.

use crate::config::ORACLE2;
use crate::state::Shared;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tracing::debug;

const TERMINAL: &str = "https://beamterminal.0xmx.net/api/mining/pools";
const TERMINAL_BLOCKS: &str = "https://beamterminal.0xmx.net/api/mining/blocks?limit=200";
/// The latest blocks `/api/network/blocks` lists.
pub const RECENT_BLOCKS: usize = 500;
/// Headers read for a day's block count: more than a day of blocks even at 30 s a block.
const DAY_HEADERS: usize = 3000;
/// Headers the block time and the hashrate average over: an hour at the 60 s target.
const AVG_HEADERS: usize = 60;

#[derive(Default)]
pub struct NetCache {
    pub data: RwLock<Value>,
    /// the latest blocks, newest first, each with the pool that found it when one is known
    pub blocks: RwLock<Vec<Value>>,
}

/// A header from our node: height, hash, time, difficulty.
#[derive(Clone)]
struct Hdr {
    height: u64,
    hash: String,
    ts: f64,
    difficulty: f64,
}

/// Who found which block, kept across rounds. `from` is, for each pool, the lowest height from
/// which its blocks are all known: its list overlapped the previous one every round since then.
#[derive(Default)]
struct Finds {
    by_height: BTreeMap<u64, (String, String)>,
    from: HashMap<String, u64>,
    newest: HashMap<String, u64>,
}

impl Finds {
    /// One pool's latest blocks as its API listed them now: (height, hash when it gave one).
    fn add(&mut self, id: &str, name: &str, list: &[(u64, Option<String>)], hashes: &HashMap<u64, &str>) {
        let (Some(lo), Some(hi)) = (list.iter().map(|b| b.0).min(), list.iter().map(|b| b.0).max()) else { return };
        // a list that starts above the newest block seen before leaves a gap: known from here only
        let overlaps = self.newest.get(id).is_some_and(|n| lo <= *n);
        if !overlaps {
            self.from.insert(id.to_string(), lo);
        }
        self.newest.insert(id.to_string(), hi);
        for (h, hash) in list {
            if let (Some(ours), Some(theirs)) = (hashes.get(h), hash) {
                if !ours.eq_ignore_ascii_case(theirs) {
                    continue; // orphaned: the chain kept another block at this height
                }
            }
            self.by_height.insert(*h, (id.to_string(), name.to_string()));
        }
    }

    /// The pool's blocks from `start` up when they are all known, else None.
    fn count_from(&self, id: &str, start: u64) -> Option<usize> {
        (*self.from.get(id)? <= start).then(|| self.by_height.range(start..).filter(|(_, (p, _))| p == id).count())
    }

    /// Before a whole day is known: the pool's blocks since it is followed, the height that began.
    fn partial(&self, id: &str) -> Option<(u64, usize)> {
        let from = *self.from.get(id)?;
        Some((from, self.by_height.range(from..).filter(|(_, (p, _))| p == id).count()))
    }

    fn prune(&mut self, below: u64) {
        self.by_height = self.by_height.split_off(&below);
    }
}

pub async fn run(cache: Arc<NetCache>, shared: Arc<Shared>) {
    // the last of each that came, kept through a failed fetch: stale beats none
    let (mut price, mut chain, mut pools): (Option<f64>, Option<Value>, Option<Value>) = (None, None, None);
    let (mut hdrs, mut finds): (Vec<Hdr>, Finds) = (Vec::new(), Finds::default());
    let urls = &shared.cfg.pool.explorer_urls;
    for round in 0u64.. {
        if round % 10 == 0 {
            match first(urls, |u| fetch_price(&shared.http, u)).await {
                Ok(p) => price = Some(p),
                Err(e) => debug!("price: {e:#}"),
            }
        }
        match first(urls, |u| fetch_chain(&shared.http, u)).await {
            Ok((c, h)) => {
                chain = Some(c);
                hdrs = h;
            }
            Err(e) => debug!("chain: {e:#}"),
        }
        find_blocks(&shared, &hdrs, &mut finds).await;
        match fetch_pools(&shared.http).await {
            Ok(p) => pools = Some(p),
            Err(e) => debug!("pools: {e:#}"),
        }
        let mut direct = fetch_direct(&shared.http).await;
        if let Some(ours) = ours(&shared).await {
            direct.push(ours);
        }
        if chain.is_some() || pools.is_some() || !direct.is_empty() {
            let mut t = pools.clone().unwrap_or(json!({}));
            overlay(&mut t, direct);
            let c = chain.clone().unwrap_or(json!({}));
            // the chain's numbers from the node; the terminal's only while the node has none
            let pick = |k: &str| if c[k].is_null() { t[k].clone() } else { c[k].clone() };
            let mut list = t["pools"].as_array().cloned().unwrap_or_default();
            // a pool's blocks of the day from its own lists once a whole day of them is known; before
            // that, with no other figure (the terminal down), the rate over the part known, scaled to a
            // day, its hours in `blocks24hHours`
            let newest = hdrs.first().map(|n| n.ts);
            if let Some(start) = newest.and_then(|n| hdrs.iter().filter(|h| h.ts > n - 86400.0).map(|h| h.height).min()) {
                let ts_of: HashMap<u64, f64> = hdrs.iter().map(|h| (h.height, h.ts)).collect();
                for p in list.iter_mut().filter(|p| p["id"] != "bumblebeam") {
                    let Some(id) = p["id"].as_str().map(str::to_string) else { continue };
                    if let Some(n) = finds.count_from(&id, start) {
                        p["blocks24h"] = json!(n);
                    } else if p["blocks24h"].is_null() {
                        let est = finds.partial(&id).and_then(|(from, n)| {
                            let span = newest? - ts_of.get(&from)?;
                            (span >= 3600.0).then(|| (n as f64 * 86400.0 / span, span / 3600.0))
                        });
                        if let Some((b, hours)) = est {
                            p["blocks24h"] = json!(b.round());
                            p["blocks24hHours"] = json!((hours * 10.0).round() / 10.0);
                        }
                    }
                }
            }
            let (blocks24h, chain_hr) = (pick("blocks24h"), pick("hashrate24h"));
            let (hashrate, others) = network(&list, blocks24h.as_f64(), chain_hr.as_f64().or(pick("hashrate").as_f64()));
            let v = json!({
                "hashrate": hashrate, "chainHashrate": chain_hr, "height": pick("height"), "blocks24h": blocks24h,
                "difficulty": c["difficulty"], "avgBlock": c["avgBlock"], "priceUsd": price,
                "othersHashrate": others.map(|o| o.0), "othersBlocks24h": others.map(|o| o.1),
                "pools": list,
            });
            if let Some(h) = v["height"].as_u64() {
                if shared.net_height.swap(h, Ordering::Relaxed) != h {
                    // the stratum process reads it for its syncing-node guard (crate::main::net_height_loop)
                    let _ = shared.db.meta_set("net_height", &h.to_string()).await;
                }
            }
            *cache.data.write().await = v;
        }
        if !hdrs.is_empty() {
            *cache.blocks.write().await = hdrs.iter().take(RECENT_BLOCKS).map(|h| {
                let by = finds.by_height.get(&h.height);
                json!({ "height": h.height, "hash": h.hash, "ts": h.ts as i64, "difficulty": h.difficulty,
                        "pool": by.map(|b| b.0.clone()), "poolName": by.map(|b| b.1.clone()) })
            }).collect();
        }
        tokio::time::sleep(Duration::from_secs(30)).await;
    }
}

/// The network's current hashrate and the part no listed pool claims, (hashrate, blocks of the day):
/// the pools' sum over 1 - the others' share of the day's blocks. Without every active pool's blocks
/// the chain's estimate stands and the others are what the pools leave of it.
fn network(pools: &[Value], blocks24h: Option<f64>, chain: Option<f64>) -> (Option<f64>, Option<(f64, f64)>) {
    let sum: f64 = pools.iter().filter_map(|p| num(&p["hashrate"])).sum();
    let known = pools.iter().all(|p| num(&p["hashrate"]).unwrap_or(0.0) == 0.0 || num(&p["blocks24h"]).is_some());
    let claimed: f64 = pools.iter().filter_map(|p| num(&p["blocks24h"])).sum();
    match blocks24h.filter(|b| *b > 0.0 && known && sum > 0.0) {
        Some(b) => {
            let rest = (b - claimed).max(0.0);
            let f = rest / b;
            if f < 0.9 {
                let total = sum / (1.0 - f);
                return (Some(total), Some((total * f, rest)));
            }
            (chain, chain.map(|c| ((c - sum).max(0.0), rest)))
        }
        None => (chain, chain.map(|c| ((c - sum).max(0.0), blocks24h.map_or(0.0, |b| (b - claimed).max(0.0))))),
    }
}

/// BumbleBeam's own row from its own shares and blocks, the last 10 min as on /api/stats.
async fn ours(shared: &Shared) -> Option<Value> {
    let t = chrono::Utc::now().timestamp();
    let db = &shared.db;
    let r = async {
        let (hashrate, miners, workers) = db.pool_now(t).await?;
        anyhow::Ok(json!({
            "id": "bumblebeam", "name": "BumbleBeam", "website": "https://pool.bumblebeam.org", "scheme": "PPLNS / SOLO",
            "fee": shared.cfg.pool.fee_percent, "hashrate": hashrate, "miners": miners, "workers": workers,
            "blocks24h": db.blocks_24h(t).await?.0, "lastTs": db.last_block_ts(None, None).await?,
        }))
    }.await;
    r.map_err(|e| debug!("ours: {e:#}")).ok()
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
async fn fetch_chain(http: &reqwest::Client, base: String) -> anyhow::Result<(Value, Vec<Hdr>)> {
    let v = get(http, &format!("{base}/hdrs?nMax={DAY_HEADERS}&cols=HTd")).await?;
    // rows after the header row, newest first: [height, {hash}, {time}, "difficulty"]
    let hdrs: Vec<Hdr> = v["value"].as_array().map(|a| a.iter().skip(1).filter_map(|r| {
        Some(Hdr { height: num(&r[0]["value"])? as u64, hash: r[1]["value"].as_str()?.to_lowercase(), ts: num(&r[2]["value"])?, difficulty: num(&r[3])? })
    }).collect()).unwrap_or_default();
    let rows: Vec<(f64, f64, f64)> = hdrs.iter().map(|h| (h.height as f64, h.ts, h.difficulty)).collect();
    anyhow::ensure!(rows.len() > AVG_HEADERS, "{} headers from {base}", rows.len());
    let (height, newest, difficulty) = rows[0];
    let avg_block = (newest - rows[AVG_HEADERS].1) / AVG_HEADERS as f64;
    let avg_diff = rows[..AVG_HEADERS].iter().map(|r| r.2).sum::<f64>() / AVG_HEADERS as f64;
    let day: Vec<_> = rows.iter().filter(|r| r.1 > newest - 86400.0).collect();
    let blocks24h = day.len();
    // the day's work over the day's time: the oldest block's own time is that of the one before it
    let span = day.last().map(|r| newest - r.1).unwrap_or(0.0);
    let hashrate24h = (span > 0.0).then(|| day[..day.len() - 1].iter().map(|r| r.2).sum::<f64>() / span);
    Ok((json!({
        "hashrate24h": hashrate24h,
        "height": height as u64, "difficulty": difficulty, "avgBlock": avg_block,
        "hashrate": if avg_block > 0.0 { Some(avg_diff / avg_block) } else { None }, "blocks24h": blocks24h,
    }), hdrs))
}

/// This round's lists of who found what: every pool in `DIRECT` from its own API, ours from our
/// database, then the terminal's list for the heights still unclaimed.
async fn find_blocks(shared: &Shared, hdrs: &[Hdr], finds: &mut Finds) {
    let http = &shared.http;
    let hashes: HashMap<u64, &str> = hdrs.iter().map(|h| (h.height, h.hash.as_str())).collect();
    let lists = futures_util::future::join_all(DIRECT.iter().map(|&(id, name, site, ..)| async move {
        let r = match id {
            "herominers" => herominers_blocks(http, site).await,
            "sunpool" => sunpool_blocks(http, site).await,
            _ => two_miners_blocks(http, site).await,
        };
        (id, name, r)
    }))
    .await;
    for (id, name, r) in lists {
        match r {
            Ok(list) => finds.add(id, name, &list, &hashes),
            Err(e) => debug!("{id} blocks: {e:#}"),
        }
    }
    match shared.db.block_heights().await {
        // all of ours that the chain kept, so the day is always known
        Ok(list) => {
            let floor = hdrs.last().map_or(0, |h| h.height);
            let list: Vec<(u64, Option<String>)> = list.iter().filter_map(|(h, ..)| u64::try_from(*h).ok()).filter(|h| *h >= floor).map(|h| (h, None)).collect();
            finds.add("bumblebeam", "BumbleBeam", &list, &hashes);
        }
        Err(e) => debug!("our blocks: {e:#}"),
    }
    match get(http, TERMINAL_BLOCKS).await {
        Ok(v) => {
            for b in v["blocks"].as_array().into_iter().flatten() {
                let (Some(h), Some(name)) = (b["height"].as_u64(), b["mined_by"].as_str()) else { continue };
                if !finds.by_height.contains_key(&h) && !name.is_empty() {
                    let id = DIRECT.iter().find(|d| d.1 == name).map_or_else(|| name.to_lowercase().replace(' ', "-"), |d| d.0.to_string());
                    finds.by_height.insert(h, (id, name.to_string()));
                }
            }
        }
        Err(e) => debug!("terminal blocks: {e:#}"),
    }
    if let Some(newest) = hdrs.first() {
        finds.prune(newest.height.saturating_sub(DAY_HEADERS as u64 * 2));
    }
}

/// 2Miners' open-ethereum-pool block lists: new, confirming and the latest matured.
async fn two_miners_blocks(http: &reqwest::Client, site: &str) -> anyhow::Result<Vec<(u64, Option<String>)>> {
    let v = get(http, &format!("{site}/api/blocks")).await?;
    Ok(["candidates", "immature", "matured"].iter().flat_map(|k| v[*k].as_array().cloned().unwrap_or_default())
        .filter(|b| b["orphan"] != true)
        .filter_map(|b| Some((b["height"].as_u64()?, b["hash"].as_str().map(str::to_string))))
        .collect())
}

/// HeroMiners' latest blocks: pairs of "hash:time:...:status:..." and the height.
async fn herominers_blocks(http: &reqwest::Client, site: &str) -> anyhow::Result<Vec<(u64, Option<String>)>> {
    let v = get(http, &format!("{site}/api/stats")).await?;
    let a = v["pool"]["blocks"].as_array().cloned().unwrap_or_default();
    Ok(a.chunks(2).filter_map(|p| {
        let f: Vec<&str> = p.first()?.as_str()?.split(':').collect();
        let h = num(p.get(1)?)? as u64;
        (f.get(5) != Some(&"orphaned")).then(|| (h, f.first().map(|s| s.to_string())))
    }).collect())
}

/// SunPool's last blocks from its miningpoolstats report (heights only).
async fn sunpool_blocks(http: &reqwest::Client, site: &str) -> anyhow::Result<Vec<(u64, Option<String>)>> {
    let v = get(http, &format!("{site}/pool-info.php?miningpoolstats")).await?;
    Ok(v["lastBlocksFound"].as_array().into_iter().flatten().filter_map(|b| Some((num(&b["blockNumber"])? as u64, None))).collect())
}

/// Pools whose own API the terminal's numbers are checked against: (id, name, website, scheme, fee).
const DIRECT: &[(&str, &str, &str, &str, f64)] = &[
    ("2miners", "2Miners", "https://beam.2miners.com", "PPLNS", 1.0),
    ("2miners-solo", "2Miners (Solo)", "https://solo-beam.2miners.com", "SOLO", 1.5),
    ("herominers", "HeroMiners", "https://beam.herominers.com", "PROP / SOLO", 0.9),
    ("sunpool", "SunPool", "https://beam.sunpool.top", "PPLNS", 0.0),
];

/// Every pool in `DIRECT` that answered, in the /api/network row shape, only the fields it gave.
async fn fetch_direct(http: &reqwest::Client) -> Vec<Value> {
    let all = futures_util::future::join_all(DIRECT.iter().map(|&(id, name, site, scheme, fee)| async move {
        let r = match id {
            "herominers" => herominers(http, site).await,
            "sunpool" => sunpool(http, site).await,
            _ => two_miners(http, site).await,
        };
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

/// SunPool's report for miningpoolstats.com, the one JSON its PHP site has; with its blocks of the day.
async fn sunpool(http: &reqwest::Client, site: &str) -> anyhow::Result<Value> {
    let v = get(http, &format!("{site}/pool-info.php?miningpoolstats")).await?;
    let hashrate = num(&v["hashrate"]).ok_or_else(|| anyhow::anyhow!("no hashrate"))?;
    Ok(json!({
        "hashrate": hashrate, "miners": v["miners"], "workers": v["workers"], "blocks24h": v["blocksFound24H"],
        "lastTs": num(&v["lastBlocksFound"][0]["timestampMilliSeconds"]).map(|ms| (ms / 1000.0) as i64), "fee": v["feePercent"],
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_drop_orphans_and_count_only_a_whole_day() {
        let hashes: HashMap<u64, &str> = [(10, "aa"), (11, "bb"), (12, "cc")].into_iter().collect();
        let mut f = Finds::default();
        // 11's hash is not the chain's: an orphan, not counted
        f.add("p", "P", &[(10, Some("AA".into())), (11, Some("xx".into())), (12, None)], &hashes);
        assert_eq!(f.by_height.get(&10).map(|b| b.0.as_str()), Some("p"));
        assert!(!f.by_height.contains_key(&11));
        assert_eq!(f.count_from("p", 10), Some(2));
        // known from 10 only: a day starting at 9 is not whole
        assert_eq!(f.count_from("p", 9), None);
        // the next list overlaps: still known from 10
        f.add("p", "P", &[(12, None), (20, None)], &hashes);
        assert_eq!(f.count_from("p", 10), Some(3));
        // a gap (the list starts above the newest seen): known from its start only
        f.add("p", "P", &[(30, None)], &hashes);
        assert_eq!(f.count_from("p", 10), None);
        assert_eq!(f.count_from("p", 30), Some(1));
        f.prune(20);
        assert_eq!(f.by_height.keys().copied().collect::<Vec<_>>(), vec![20, 30]);
    }
}
