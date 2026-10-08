//! HTTP API (pool/API.md) and the static web UI.

use crate::emission::miner_reward_groth;
use crate::network::NetCache;
use crate::pow;
use crate::state::{now, Shared};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tracing::error;

#[derive(Clone)]
pub struct Api {
    pub shared: Arc<Shared>,
    pub net: Arc<NetCache>,
}

struct ApiError(anyhow::Error);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        error!("api: {:#}", self.0);
        (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "internal error" }))).into_response()
    }
}
impl<E: Into<anyhow::Error>> From<E> for ApiError {
    fn from(e: E) -> Self {
        ApiError(e.into())
    }
}
type R = Result<Json<Value>, ApiError>;

pub fn router(api: Api) -> Router {
    let web = api.shared.cfg.http.web_dir.clone();
    let index = format!("{web}/index.html");
    Router::new()
        .route("/api/stats", get(stats))
        .route("/api/blocks", get(blocks))
        .route("/api/miners", get(miners))
        .route("/api/miners/:address", get(miner))
        .route("/api/payments", get(payments))
        .route("/api/network", get(network))
        .route("/api/health", get(health))
        .route("/api/miningboard", get(miningboard))
        .fallback_service(ServeDir::new(web).fallback(ServeFile::new(index)))
        .layer(CorsLayer::permissive())
        .with_state(api)
}

fn range(q: &HashMap<String, String>) -> crate::db::ChartRange {
    crate::db::ChartRange::parse(q.get("range").map(String::as_str))
}

fn limit(q: &HashMap<String, String>, default: i64, max: i64) -> i64 {
    q.get("limit").and_then(|v| v.parse().ok()).unwrap_or(default).clamp(1, max)
}

async fn stats(State(api): State<Api>, Query(q): Query<HashMap<String, String>>) -> R {
    let s = &api.shared;
    let t = now();
    let hashrate = s.db.pool_hashrate(t).await?;
    let (miners, workers) = s.db.pool_counts(t).await?;
    let last_block = s.db.last_block_ts(None, None).await?;
    let round = s.db.round_shares("pplns", s.db.last_block_ts(Some("pplns"), None).await?.unwrap_or(0), None).await?;
    let (blocks24h, effort24h) = s.db.blocks_24h(t).await?;
    let job = s.current_job();
    let height = job.as_ref().map(|j| j.height.saturating_sub(1));
    let difficulty = job.as_ref().map(|j| pow::difficulty_to_double(j.net_packed));
    let net = api.net.data.read().await.clone();
    let cfg = &s.cfg.pool;
    Ok(Json(json!({
        "hashrate": hashrate, "minersTotal": miners, "workersTotal": workers,
        "stats": { "lastBlockFound": last_block, "roundShares": round },
        "nodes": [{ "name": "beam-node", "height": height.map(|h| h.to_string()), "difficulty": difficulty.map(|d| format!("{d:.1}")),
                    "networkhashps": net["hashrate"].as_f64().map(|v| format!("{v:.0}")), "lastBeat": job.as_ref().map(|_| t.to_string()),
                    "connected": job.is_some() }],
        "name": cfg.name,
        "config": { "fee": cfg.fee_percent, "soloFee": cfg.solo_fee_percent, "minPayout": cfg.min_payout_groth, "payoutScheme": "PPLNS",
                    "pplnsWindow": cfg.pplns_window, "blockReward": height.map(|h| miner_reward_groth(h + 1)), "maturity": cfg.maturity,
                    "payoutInterval": cfg.payout_interval_secs, "stratumHost": cfg.public_host,
                    "minerPaysTxFee": cfg.miner_pays_tx_fee, "txFee": { "regular": s.cfg.wallet_api.tx_fee_groth, "shielded": s.cfg.wallet_api.shielded_fee_groth },
                    "blockFeesTo": "pool",
                    "ports": { "pplns": s.cfg.stratum.pplns_port, "solo": s.cfg.stratum.solo_port,
                               "pplnsTls": s.cfg.stratum.pplns_tls_port, "soloTls": s.cfg.stratum.solo_tls_port } },
        "charts": { "hashrate": s.db.pool_chart(t, range(&q)).await? },
        "blocks24h": blocks24h, "effort24h": effort24h,
        "connectedWorkers": s.connected_workers.load(std::sync::atomic::Ordering::Relaxed),
    })))
}

async fn blocks(State(api): State<Api>, Query(q): Query<HashMap<String, String>>) -> R {
    let s = &api.shared;
    let before = q.get("before").and_then(|v| v.parse().ok());
    let tip = s.tip_height().map(|h| h as i64);
    let list = s.db.blocks(limit(&q, 50, 500), before, s.cfg.pool.maturity as i64, tip).await?;
    // The same blocks split the open-ethereum-pool way, which the Beam Explorer's `open-eth`
    // adapter reads to attribute blocks to pools. Orphans are in neither.
    let by_status = |want: &[&str]| -> Vec<Value> {
        list.iter().filter(|b| want.contains(&b["status"].as_str().unwrap_or(""))).cloned().collect()
    };
    let matured = by_status(&["confirmed"]);
    let immature = by_status(&["pending", "unverified"]);
    Ok(Json(json!({ "blocks": list, "matured": matured, "immature": immature, "candidates": [] })))
}

async fn miners(State(api): State<Api>, Query(q): Query<HashMap<String, String>>) -> R {
    Ok(Json(json!({ "miners": api.shared.db.top_miners(limit(&q, 50, 500), now()).await? })))
}

async fn miner(State(api): State<Api>, Path(address): Path<String>, Query(q): Query<HashMap<String, String>>) -> R {
    let address: String = address.chars().filter(|c| !c.is_whitespace()).collect();
    if address.len() > 600 || !address.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Ok(Json(json!({ "error": "not a Beam address" })));
    }
    match api.shared.db.miner(&address, now(), range(&q)).await? {
        Some(v) => Ok(Json(v)),
        None => Ok(Json(json!({ "address": address, "hashrate": 0, "hashrate24h": 0, "balance": 0, "immature": 0, "paid": 0,
                                "lastShare": null, "workers": [], "charts": { "hashrate": [] }, "payments": [] }))),
    }
}

async fn payments(State(api): State<Api>, Query(q): Query<HashMap<String, String>>) -> R {
    Ok(Json(json!({ "payments": api.shared.db.payments(limit(&q, 50, 500)).await? })))
}

async fn network(State(api): State<Api>) -> R {
    Ok(Json(api.net.data.read().await.clone()))
}

/// The pool in MiningBoard's `miningboard-pool-v1` shape (miningboard.com/pools/submit.md).
/// Beam's hashrate is in Sol/s, which is what MiningBoard compares against for Beam.
async fn miningboard(State(api): State<Api>) -> R {
    let s = &api.shared;
    let t = now();
    let iso = |ts: i64| chrono::DateTime::from_timestamp(ts, 0).map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
    let (miners, workers) = s.db.pool_counts(t).await?;
    let (blocks24h, _) = s.db.blocks_24h(t).await?;
    let job = s.current_job();
    let height = job.as_ref().map(|j| j.height.saturating_sub(1));
    let net = api.net.data.read().await.clone();
    let (cfg, st) = (&s.cfg.pool, &s.cfg.stratum);
    let beam = |groth: u64| groth as f64 / 1e8;
    let stratum: Vec<Value> = [(st.pplns_port, false, "PPLNS"), (st.pplns_tls_port, true, "PPLNS"), (st.solo_port, false, "SOLO"), (st.solo_tls_port, true, "SOLO")]
        .into_iter()
        .filter(|(port, ..)| *port != 0)
        .map(|(port, tls, mode)| json!({ "url": format!("stratum+{}://{}:{port}", if tls { "ssl" } else { "tcp" }, cfg.public_host), "tls": tls, "mode": mode }))
        .collect();
    Ok(Json(json!({
        "spec": "miningboard-pool-v1", "coin": "BEAM", "algorithm": "BeamHash III", "updated_at": iso(t),
        "pool": { "hashrate": s.db.pool_hashrate(t).await?, "miners": miners, "workers": workers, "blocks_24h": blocks24h,
                  "last_block_at": s.db.last_block_ts(None, None).await?.and_then(iso), "fee_percent": cfg.fee_percent,
                  "payout_scheme": "PPLNS", "min_payout": beam(cfg.min_payout_groth) },
        "network": height.map(|h| json!({ "hashrate": net["hashrate"].as_f64(), "height": h,
                                          "difficulty": job.as_ref().map(|j| pow::difficulty_to_double(j.net_packed)),
                                          "block_reward": beam(miner_reward_groth(h + 1)), "block_time": 60 })),
        "stratum": stratum,
    })))
}

async fn health(State(api): State<Api>) -> R {
    let s = &api.shared;
    let job = s.current_job();
    Ok(Json(json!({ "ok": true, "node": job.is_some(), "jobAgeSecs": job.as_ref().map(|j| j.received.elapsed().as_secs()), "uptime": s.started.elapsed().as_secs(),
                    "workers": s.connected_workers.load(std::sync::atomic::Ordering::Relaxed) })))
}
