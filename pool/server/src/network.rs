//! Cache of the Beam Explorer's mining data, refreshed every 30 s for all visitors, in the shape
//! pool/API.md gives for /api/network.

use crate::state::Shared;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tracing::debug;

const TERMINAL: &str = "https://beamterminal.0xmx.net/api/mining/pools";
const HDRS: &str = "https://explorer.0xmx.net/api/hdrs?nMax=61&cols=Td";

#[derive(Default)]
pub struct NetCache {
    pub data: RwLock<Value>,
}

pub async fn run(cache: Arc<NetCache>, shared: Arc<Shared>) {
    loop {
        match fetch(&shared.http).await {
            Ok(v) => {
                if let Some(h) = v["height"].as_u64() {
                    shared.net_height.store(h, Ordering::Relaxed);
                }
                *cache.data.write().await = v;
            }
            Err(e) => debug!("network cache: {e:#}"),
        }
        tokio::time::sleep(Duration::from_secs(30)).await;
    }
}

fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.replace(',', "").parse().ok(),
        _ => None,
    }
}

async fn fetch(http: &reqwest::Client) -> anyhow::Result<Value> {
    let pools: Value = http.get(TERMINAL).timeout(Duration::from_secs(10)).send().await?.json().await?;
    let mut out = json!({
        "hashrate": pools["network_hashrate"], "height": pools["block_height"], "blocks24h": pools["blocks_24h_total"],
        "difficulty": Value::Null, "avgBlock": Value::Null,
        "pools": pools["pools"].as_array().cloned().unwrap_or_default().iter().map(|p| json!({
            "id": p["id"], "name": p["name"], "website": p["website"], "scheme": p["payout_scheme"], "fee": p["fee"],
            "hashrate": p["hashrate"], "miners": p["miners"], "workers": p["workers"],
            "blocks24h": p.get("blocks_past_24h").cloned().unwrap_or(p["blocks_24h"].clone()),
            "lastTs": p["last_block_ts"].as_str().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()).map(|d| d.timestamp()),
            "series": p["hashrate_series"].as_array().cloned().unwrap_or_default().iter().map(|s| json!([s["ts"], s["value"]])).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    });
    if let Ok(h) = http.get(HDRS).timeout(Duration::from_secs(10)).send().await {
        if let Ok(h) = h.json::<Value>().await {
            let rows = h["value"].as_array().cloned().unwrap_or_default();
            if rows.len() > 2 {
                let first = &rows[1];
                let last = &rows[rows.len() - 1];
                out["difficulty"] = json!(num(&first[2]));
                if let (Some(t0), Some(t1)) = (num(&first[1]["value"]), num(&last[1]["value"])) {
                    out["avgBlock"] = json!((t0 - t1) / (rows.len() - 2) as f64);
                }
                if out["height"].is_null() {
                    out["height"] = first[0]["value"].clone();
                }
            }
        }
    }
    Ok(out)
}
