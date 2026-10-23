//! What the app half (HTTP API, admin, payouts) needs from the stratum half (connections, the node link,
//! the coinbase finalizer link). In one process (`run all`) these are calls into memory; with the halves in two
//! processes (`run stratum` + `run app`, docs/pool-split.md) the stratum process serves them on `control.bind`
//! (internal only, the admin token as a bearer) and the app calls `control.url`.

use crate::state::Shared;
use anyhow::{anyhow, Result};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tracing::info;

/// The stratum half as the app half sees it.
pub enum Stratum {
    Local(Arc<Shared>),
    Remote { base: String, token: String, http: reqwest::Client, cache: std::sync::Mutex<Option<(Instant, Result<Value, String>)>> },
}

impl Stratum {
    pub fn remote(base: &str, token: &str, http: reqwest::Client) -> Stratum {
        Stratum::Remote { base: base.trim_end_matches('/').to_string(), token: token.to_string(), http, cache: std::sync::Mutex::new(None) }
    }

    /// `{live: [...], recent: [...], workers: n}`: the connections, cached a second when remote.
    pub async fn snapshot(&self) -> Result<Value> {
        match self {
            Stratum::Local(s) => Ok(snapshot(s)),
            Stratum::Remote { base, token, http, cache } => {
                // an answer is reused 1 s, a failure 2 s; the lock is never held across the request, so a hung
                // stratum process costs each caller one 3 s timeout at most, not a queue of them
                if let Some((at, v)) = cache.lock().unwrap().as_ref() {
                    let ttl = if v.is_ok() { 1 } else { 2 };
                    if at.elapsed() < Duration::from_secs(ttl) {
                        return v.clone().map_err(|e| anyhow!(e));
                    }
                }
                let r: Result<Value> = async {
                    Ok(http.get(format!("{base}/ctl/live")).bearer_auth(token).timeout(Duration::from_secs(3)).send().await?.error_for_status()?.json().await?)
                }
                .await;
                let r = r.map_err(|e| format!("the stratum process does not answer: {e}"));
                *cache.lock().unwrap() = Some((Instant::now(), r.clone()));
                r.map_err(|e| anyhow!(e))
            }
        }
    }

    /// Logged-in connections; None when the stratum process does not answer.
    pub async fn workers(&self) -> Option<u64> {
        self.snapshot().await.ok().and_then(|v| v["workers"].as_u64())
    }

    pub async fn live(&self, miner_id: Option<i64>) -> Result<Vec<Value>> {
        let v = self.snapshot().await?;
        Ok(v["live"].as_array().cloned().unwrap_or_default().into_iter().filter(|c| miner_id.map_or(true, |m| c["minerId"].as_i64() == Some(m))).collect())
    }

    /// Live connections per miner, one call for a whole page (admin miners list).
    pub async fn counts(&self) -> HashMap<i64, u64> {
        let mut out = HashMap::new();
        if let Ok(list) = self.live(None).await {
            for c in list {
                if let Some(m) = c["minerId"].as_i64().filter(|m| *m != 0) {
                    *out.entry(m).or_insert(0) += 1;
                }
            }
        }
        out
    }

    pub async fn kick(&self, id: u64) -> Result<bool> {
        match self {
            Stratum::Local(s) => Ok(s.conns.kick(id)),
            Stratum::Remote { base, token, http, .. } => {
                let v: Value = http.post(format!("{base}/ctl/kick/{id}")).bearer_auth(token).timeout(Duration::from_secs(5)).send().await?.error_for_status()?.json().await?;
                Ok(v["ok"].as_bool() == Some(true))
            }
        }
    }

    /// Ends every connection of a miner and waits (up to 5 s) until they are gone: (kicked, still open).
    pub async fn kick_miner_wait(&self, miner_id: i64) -> Result<(u64, u64)> {
        match self {
            Stratum::Local(s) => Ok(kick_miner_wait(s, miner_id).await),
            Stratum::Remote { base, token, http, .. } => {
                let v: Value = http.post(format!("{base}/ctl/kick-miner/{miner_id}")).bearer_auth(token).timeout(Duration::from_secs(10)).send().await?.error_for_status()?.json().await?;
                Ok((v["kicked"].as_u64().unwrap_or(0), v["left"].as_u64().unwrap_or(0)))
            }
        }
    }

    /// `GET /api/coinbase`: the coinbase half lives with the finalizer link, in the stratum process.
    pub async fn coinbase_info(&self) -> Result<Value> {
        match self {
            Stratum::Local(s) => crate::coinbase::info(s).await,
            Stratum::Remote { base, token, http, .. } => {
                Ok(http.get(format!("{base}/ctl/coinbase")).bearer_auth(token).timeout(Duration::from_secs(10)).send().await?.error_for_status()?.json().await?)
            }
        }
    }

    /// `POST /api/coinbase/pairs`: (status, body).
    pub async fn coinbase_upload(&self, body: &Value) -> (u16, Value) {
        match self {
            Stratum::Local(s) => match crate::coinbase::upload(s, body).await {
                Ok(v) => (200, v),
                Err((code, msg)) => (code, json!({ "error": msg })),
            },
            Stratum::Remote { base, token, http, .. } => {
                let r = http.post(format!("{base}/ctl/coinbase/pairs")).bearer_auth(token).json(body).timeout(Duration::from_secs(30)).send().await;
                match r {
                    Ok(r) => {
                        let code = r.status().as_u16();
                        (code, r.json().await.unwrap_or_else(|_| json!({ "error": "bad answer from the stratum process" })))
                    }
                    Err(e) => (503, json!({ "error": format!("the stratum process does not answer: {e}") })),
                }
            }
        }
    }
}

fn snapshot(s: &Shared) -> Value {
    let live = s.conns.live(None);
    let workers = live.iter().filter(|c| c["minerId"].as_i64().unwrap_or(0) != 0).count();
    json!({ "live": live, "recent": s.conns.recent(), "workers": workers })
}

async fn kick_miner_wait(s: &Shared, miner_id: i64) -> (u64, u64) {
    let kicked = s.conns.kick_miner(miner_id) as u64;
    for _ in 0..50 {
        if s.conns.count_miner(miner_id) == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    (kicked, s.conns.count_miner(miner_id) as u64)
}

// ---- the stratum process's side ----

fn authorized(s: &Shared, h: &HeaderMap) -> bool {
    let want = &s.cfg.admin.token;
    if want.len() < 24 {
        return false; // no admin token: no control interface either (the app cannot authenticate)
    }
    let got = h.get("authorization").and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).unwrap_or("");
    got.len() == want.len() && got.bytes().zip(want.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

macro_rules! guard {
    ($s:expr, $h:expr) => {
        if !authorized(&$s, &$h) {
            return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized" }))).into_response();
        }
    };
}

async fn live(State(s): State<Arc<Shared>>, h: HeaderMap) -> Response {
    guard!(s, h);
    Json(snapshot(&s)).into_response()
}

async fn kick(State(s): State<Arc<Shared>>, h: HeaderMap, Path(id): Path<u64>) -> Response {
    guard!(s, h);
    Json(json!({ "ok": s.conns.kick(id) })).into_response()
}

async fn kick_miner(State(s): State<Arc<Shared>>, h: HeaderMap, Path(id): Path<i64>) -> Response {
    guard!(s, h);
    let (kicked, left) = kick_miner_wait(&s, id).await;
    Json(json!({ "kicked": kicked, "left": left })).into_response()
}

async fn coinbase(State(s): State<Arc<Shared>>, h: HeaderMap) -> Response {
    guard!(s, h);
    match crate::coinbase::info(&s).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": format!("{e:#}") }))).into_response(),
    }
}

async fn coinbase_pairs(State(s): State<Arc<Shared>>, h: HeaderMap, Json(body): Json<Value>) -> Response {
    guard!(s, h);
    match crate::coinbase::upload(&s, &body).await {
        Ok(v) => Json(v).into_response(),
        Err((code, msg)) => (StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_REQUEST), Json(json!({ "error": msg }))).into_response(),
    }
}

/// The control interface of a `run stratum` process.
pub async fn serve(shared: Arc<Shared>) -> Result<()> {
    let bind = shared.cfg.control.bind.clone();
    let app = Router::new()
        .route("/ctl/live", get(live))
        .route("/ctl/kick/:id", post(kick))
        .route("/ctl/kick-miner/:id", post(kick_miner))
        .route("/ctl/coinbase", get(coinbase))
        .route("/ctl/coinbase/pairs", post(coinbase_pairs))
        .with_state(shared.clone());
    let listener = tokio::net::TcpListener::bind(&bind).await.map_err(|e| anyhow!("control bind {bind}: {e}"))?;
    info!(%bind, "control interface listening (for pool-app)");
    let mut stop = shared.stopping.subscribe();
    axum::serve(listener, app).with_graceful_shutdown(async move { let _ = stop.wait_for(|v| *v).await; }).await?;
    Ok(())
}
