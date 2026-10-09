//! HTTP API (pool/API.md) and the static web UI.

use crate::emission::miner_reward_groth;
use crate::network::NetCache;
use crate::pow;
use crate::state::{now, Shared};
use axum::extract::{Path, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tracing::{error, info, warn};

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
    let admin_page = format!("{web}/admin.html");
    Router::new()
        .route_service("/admin", ServeFile::new(admin_page))
        .route("/api/stats", get(stats))
        .route("/api/blocks", get(blocks))
        .route("/api/blocks/heights", get(block_heights))
        .route("/api/miners", get(miners))
        .route("/api/miners/:address", get(miner))
        .route("/api/payments", get(payments))
        .route("/api/network", get(network))
        .route("/api/health", get(health))
        .route("/api/coinbase", get(coinbase_info))
        .route("/api/coinbase/pairs", axum::routing::post(coinbase_upload))
        .route("/api/miningboard", get(miningboard))
        .layer(CorsLayer::permissive())
        // the operator's API is added after the CORS layer: no other site may call it from a browser
        .merge(admin_router(api.clone()))
        .fallback_service(ServeDir::new(web).fallback(ServeFile::new(index)))
        .with_state(api)
}

fn range(q: &HashMap<String, String>) -> crate::db::ChartRange {
    crate::db::ChartRange::parse(q.get("range").map(String::as_str))
}

/// `mode=pplns|solo` narrows charts and lists to one mode; anything else means both.
fn mode(q: &HashMap<String, String>) -> Option<&'static str> {
    match q.get("mode").map(String::as_str) {
        Some("pplns") => Some("pplns"),
        Some("solo") => Some("solo"),
        _ => None,
    }
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
        "config": { "fee": cfg.fee_percent, "soloFee": cfg.solo_fee_percent, "minPayout": cfg.min_payout_groth, "payoutScheme": "PPLNS", "finderBonus": cfg.finder_bonus_percent,
                    "pplnsWindow": cfg.pplns_window, "blockReward": height.map(|h| miner_reward_groth(h + 1)), "maturity": cfg.maturity,
                    "payoutInterval": cfg.payout_interval_secs, "stratumHost": cfg.public_host, "nodeAddr": cfg.public_node,
                    "minerPaysTxFee": cfg.miner_pays_tx_fee, "txFee": { "regular": s.cfg.wallet_api.tx_fee_groth, "shielded": s.cfg.wallet_api.shielded_fee_groth },
                    "blockFeesTo": "pool", "coinbase": s.coinbase.is_some(),
                    "ports": { "pplns": s.cfg.stratum.pplns_port, "solo": s.cfg.stratum.solo_port,
                               "pplnsTls": s.cfg.stratum.pplns_tls_port, "soloTls": s.cfg.stratum.solo_tls_port } },
        "charts": { "hashrate": s.db.pool_chart(t, range(&q), mode(&q).unwrap_or("pool")).await? },
        "modes": s.db.mode_stats(t).await?,
        "blocks24h": blocks24h, "effort24h": effort24h, "blocksPending": s.db.blocks_pending().await?,
        "connectedWorkers": s.connected_workers.load(std::sync::atomic::Ordering::Relaxed),
    })))
}

async fn blocks(State(api): State<Api>, Query(q): Query<HashMap<String, String>>) -> R {
    let s = &api.shared;
    let before = q.get("before").and_then(|v| v.parse().ok());
    let tip = s.tip_height().map(|h| h as i64);
    // `miner=<address>`: only the blocks that miner found (none for an address never seen)
    let miner = match q.get("miner") {
        Some(a) => match clean_address(a) {
            Some(a) => match s.db.miner_lookup(&a).await? {
                Some(id) => Some(id),
                None => return Ok(Json(json!({ "blocks": [], "matured": [], "immature": [], "candidates": [] }))),
            },
            None => return Ok(Json(json!({ "error": "not a Beam address" }))),
        },
        None => None,
    };
    let list = s.db.blocks(limit(&q, 50, 500), before, s.cfg.pool.maturity as i64, tip, miner).await?;
    // The same blocks split the open-ethereum-pool way, which the Beam Explorer's `open-eth`
    // adapter reads to attribute blocks to pools. Orphans are in neither.
    let by_status = |want: &[&str]| -> Vec<Value> {
        list.iter().filter(|b| want.contains(&b["status"].as_str().unwrap_or(""))).cloned().collect()
    };
    let matured = by_status(&["confirmed"]);
    let immature = by_status(&["pending", "unverified"]);
    Ok(Json(json!({ "blocks": list, "matured": matured, "immature": immature, "candidates": [] })))
}

/// Every block the pool found and the chain kept, newest first: `[height, mode, status]`, with
/// no other fields, so a client can mark all of our blocks in one small request.
async fn block_heights(State(api): State<Api>) -> R {
    let list = api.shared.db.block_heights().await?;
    let rows: Vec<Value> = list.iter().map(|(h, m, st)| json!([h, m, st])).collect();
    Ok(Json(json!({ "count": rows.len(), "blocks": rows })))
}

async fn miners(State(api): State<Api>, Query(q): Query<HashMap<String, String>>) -> R {
    Ok(Json(json!({ "miners": api.shared.db.top_miners(limit(&q, 50, 500), now(), mode(&q)).await? })))
}

/// A miner address as typed: whitespace dropped, a coinbase account ("cb:" + hex) lowercased;
/// None if it cannot be an address.
fn clean_address(address: &str) -> Option<String> {
    let address: String = address.chars().filter(|c| !c.is_whitespace()).collect();
    let address = if address.to_ascii_lowercase().starts_with("cb:") { address.to_ascii_lowercase() } else { address };
    (address.len() <= 600 && address.chars().all(|c| c.is_ascii_alphanumeric() || c == ':')).then_some(address)
}

async fn miner(State(api): State<Api>, Path(address): Path<String>, Query(q): Query<HashMap<String, String>>) -> R {
    let Some(address) = clean_address(&address) else {
        return Ok(Json(json!({ "error": "not a Beam address" })));
    };
    let s = &api.shared;
    let found = s.db.miner_blocks(&address, now(), 10, s.cfg.pool.maturity as i64, s.tip_height().map(|h| h as i64)).await?;
    let mut v = match s.db.miner(&address, now(), range(&q), mode(&q)).await? {
        Some(v) => v,
        None => json!({ "address": address, "hashrate": 0, "hashrate24h": 0, "balance": 0, "immature": 0, "paid": 0,
                        "lastShare": null, "workers": [], "charts": { "hashrate": [] }, "payments": [] }),
    };
    for k in ["blocksFound", "blocks24h", "lastBlockAt", "blocks"] {
        v[k] = found[k].clone();
    }
    Ok(Json(v))
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

async fn coinbase_info(State(api): State<Api>) -> R {
    Ok(Json(crate::coinbase::info(&api.shared).await?))
}

async fn coinbase_upload(State(api): State<Api>, body: axum::body::Bytes) -> Response {
    if body.len() > 2 << 20 {
        return (StatusCode::PAYLOAD_TOO_LARGE, Json(json!({ "error": "upload over 2 MB" }))).into_response();
    }
    let v: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(json!({ "error": "body is not JSON" }))).into_response(),
    };
    match crate::coinbase::upload(&api.shared, &v).await {
        Ok(res) => Json(res).into_response(),
        Err((code, msg)) => {
            if code >= 500 {
                error!("coinbase upload: {msg}");
            }
            (StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), Json(json!({ "error": msg }))).into_response()
        }
    }
}

async fn health(State(api): State<Api>) -> R {
    let s = &api.shared;
    let job = s.current_job();
    Ok(Json(json!({ "ok": true, "node": job.is_some(), "jobAgeSecs": job.as_ref().map(|j| j.received.elapsed().as_secs()), "uptime": s.started.elapsed().as_secs(),
                    "workers": s.connected_workers.load(std::sync::atomic::Ordering::Relaxed) })))
}

// ---- the operator's dashboard (pool/web/admin.html) ----

fn admin_router(api: Api) -> Router<Api> {
    Router::new()
        .route("/api/admin/attention", get(admin_attention))
        .route("/api/admin/connections", get(admin_connections))
        .route("/api/admin/connections/:id/kick", post(admin_kick))
        .route("/api/admin/miners", get(admin_miners))
        .route("/api/admin/miners/:id", get(admin_miner))
        .route("/api/admin/miners/:id/merge", post(admin_merge))
        .route("/api/admin/blocks/:height", post(admin_block))
        .route("/api/admin/payments/:tx_id", post(admin_payment))
        .route("/api/admin/payouts", post(admin_pay_now))
        .layer(middleware::from_fn_with_state(api, admin_auth))
}

fn client_ip(h: &HeaderMap) -> String {
    h.get("x-real-ip").and_then(|v| v.to_str().ok()).unwrap_or("-").to_string()
}

/// `Authorization: Bearer <admin.token>`, compared in constant time. Without a token configured the
/// routes do not exist; a wrong token is logged with the client's address.
async fn admin_auth(State(api): State<Api>, req: Request, next: Next) -> Response {
    let cfg = &api.shared.cfg;
    if !cfg.admin_enabled() {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "the operator's dashboard is off (admin.token)" }))).into_response();
    }
    let given = req.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).unwrap_or("");
    let want = cfg.admin.token.as_bytes();
    let ok = given.len() == want.len() && given.bytes().zip(want).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0;
    if !ok {
        warn!(ip = %client_ip(req.headers()), path = %req.uri().path(), "admin: wrong token");
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "wrong token" }))).into_response();
    }
    let mut res = next.run(req).await;
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

/// An operator action's outcome: 200 with a message, or 409 with why it was refused.
fn outcome(r: anyhow::Result<String>) -> Response {
    match r {
        Ok(msg) => Json(json!({ "ok": true, "message": msg })).into_response(),
        Err(e) => (StatusCode::CONFLICT, Json(json!({ "ok": false, "error": format!("{e:#}") }))).into_response(),
    }
}

#[derive(serde::Deserialize, Default)]
struct ActionBody {
    #[serde(default)]
    action: String,
    #[serde(default)]
    force: bool,
    #[serde(default)]
    to: String,
    #[serde(default)]
    miner: Option<i64>,
}

async fn admin_attention(State(api): State<Api>) -> R {
    let s = &api.shared;
    let mut a = crate::admin::attention(&s.db).await?;
    // the loop looks every minute, so a run starts up to a minute after this
    let next = s.next_payout.load(std::sync::atomic::Ordering::Relaxed);
    a["nextPayout"] = if next > 0 { json!(next) } else { Value::Null };
    a["payoutInterval"] = json!(s.cfg.pool.payout_interval_secs);
    a["now"] = json!(now());
    Ok(Json(a))
}

async fn admin_connections(State(api): State<Api>) -> R {
    let c = &api.shared.conns;
    Ok(Json(json!({ "now": now(), "live": c.live(None), "recent": c.recent() })))
}

async fn admin_kick(State(api): State<Api>, h: HeaderMap, Path(id): Path<u64>) -> Response {
    let ok = api.shared.conns.kick(id);
    info!(ip = %client_ip(&h), id, ok, "admin: kick");
    outcome(if ok { Ok(format!("connection {id} ended")) } else { Err(anyhow::anyhow!("no connection {id}")) })
}

async fn admin_miners(State(api): State<Api>, Query(q): Query<HashMap<String, String>>) -> R {
    let search: String = q.get("q").map(|s| s.trim().to_string()).unwrap_or_default();
    let mut list = crate::admin::miners(&api.shared.db, &search, limit(&q, 100, 1000)).await?;
    for m in list.iter_mut() {
        m["connections"] = json!(api.shared.conns.count_miner(m["id"].as_i64().unwrap_or(0)));
    }
    Ok(Json(json!({ "miners": list })))
}

async fn admin_miner(State(api): State<Api>, Path(id): Path<i64>) -> Response {
    match crate::admin::miner(&api.shared.db, id).await {
        Ok(Some(mut m)) => {
            m["connections"] = json!(api.shared.conns.live(Some(id)));
            Json(m).into_response()
        }
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({ "error": "no such miner" }))).into_response(),
        Err(e) => ApiError(e).into_response(),
    }
}

async fn admin_merge(State(api): State<Api>, h: HeaderMap, Path(id): Path<i64>, Json(b): Json<ActionBody>) -> Response {
    let s = &api.shared;
    // end the miner's connections first: their next shares would recreate the old account
    let kicked = s.conns.kick_miner(id);
    for _ in 0..50 {
        if s.conns.count_miner(id) == 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let r = crate::admin::merge(&s.db, id, &b.to).await;
    info!(ip = %client_ip(&h), from = id, to = %crate::state::Short(&b.to), kicked, ok = r.is_ok(), "admin: merge");
    outcome(r.map(|m| if kicked > 0 { format!("{m}; {kicked} connection(s) ended (they will log in again with whatever address they use)") } else { m }))
}

async fn admin_block(State(api): State<Api>, h: HeaderMap, Path(height): Path<i64>, Json(b): Json<ActionBody>) -> Response {
    let r = crate::admin::block(&api.shared.db, height, &b.action, b.force).await;
    info!(ip = %client_ip(&h), height, action = %b.action, force = b.force, ok = r.is_ok(), "admin: block");
    outcome(r)
}

async fn admin_payment(State(api): State<Api>, h: HeaderMap, Path(tx_id): Path<String>, Json(b): Json<ActionBody>) -> Response {
    let s = &api.shared;
    let wallet = s.cfg.wallet_enabled().then(|| crate::wallet::Wallet::new(&s.cfg.wallet_api.url, &s.cfg.wallet_api.acl_key, s.http.clone()));
    let r = crate::admin::payment(&s.db, wallet.as_ref(), &tx_id, &b.action, b.force).await;
    info!(ip = %client_ip(&h), %tx_id, action = %b.action, force = b.force, ok = r.is_ok(), "admin: payment");
    outcome(r)
}

/// A payout run now, by the payout loop itself (so it never overlaps a scheduled one): every miner
/// at the threshold, or `miner` alone whatever its balance against the threshold.
async fn admin_pay_now(State(api): State<Api>, h: HeaderMap, Json(b): Json<ActionBody>) -> Response {
    let (reply, rx) = tokio::sync::oneshot::channel();
    let r = if api.shared.payout_tx.try_send(crate::payouts::PayNow { only: b.miner, reply }).is_err() {
        Err(anyhow::anyhow!("payouts are off (no wallet_api) or a run is already queued"))
    } else {
        match tokio::time::timeout(std::time::Duration::from_secs(150), rx).await {
            Ok(Ok(Ok(notes))) => Ok(notes),
            Ok(Ok(Err(e))) => Err(anyhow::anyhow!(e)),
            Ok(Err(_)) => Err(anyhow::anyhow!("the payout loop is not running")),
            Err(_) => Err(anyhow::anyhow!("still running after 150 s: see the pool's log and the Payments list")),
        }
    };
    info!(ip = %client_ip(&h), miner = ?b.miner, ok = r.is_ok(), "admin: pay now");
    outcome(r)
}
