//! BumbleBeam pool server: stratum proxy between Beam miners and our beam-node, share checks with
//! the oracle, PPLNS and solo accounting in PostgreSQL, payouts over wallet-api, the HTTP API.
//!
//!   bumblebeam-pool <pool.toml>                  both halves in one process (as before)
//!   bumblebeam-pool <pool.toml> run stratum      the miner-facing half: stratum ports, the node link, found blocks,
//!                                                the share writer, the coinbase finalizer link, the control interface
//!   bumblebeam-pool <pool.toml> run app          the rest: HTTP API, admin, payouts, block maturity, the explorer cache
//!   bumblebeam-pool <pool.toml> admin ...        operator commands
//!
//! Split so that a release of the app half never drops a miner (docs/pool-split.md).

mod accounting;
mod admin;
mod api;
mod coinbase;
mod config;
mod conns;
mod ctl;
mod db;
#[cfg(test)]
mod db_tests;
mod emission;
mod network;
mod payouts;
mod pow;
mod state;
mod stratum;
mod threeb;
mod upstream;
mod wallet;

use anyhow::{Context, Result};
use state::{Mode, Shared};
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{mpsc, watch, RwLock};
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"))).init();
    rustls::crypto::ring::default_provider().install_default().ok();

    let path = std::env::args().nth(1).unwrap_or_else(|| "pool.toml".into());
    let cfg = Arc::new(config::Config::load(std::path::Path::new(&path)).context("config")?);
    info!(config = %path, pplns = cfg.stratum.pplns_port, solo = cfg.stratum.solo_port, http = %cfg.http.bind, "bumblebeam pool starting");

    let db = db::Db::connect(&cfg.database.url).await.context("database")?;
    let args: Vec<String> = std::env::args().skip(2).collect();
    if args.first().map(|s| s.as_str()) == Some("admin") {
        let http = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build()?;
        return admin::run(&db, &cfg, http, &args[1..]).await;
    }
    let role = match (args.first().map(String::as_str), args.get(1).map(String::as_str)) {
        (None, _) | (Some("run"), Some("all")) => state::Role::All,
        (Some("run"), Some("stratum")) => state::Role::Stratum,
        (Some("run"), Some("app")) => state::Role::App,
        _ => anyhow::bail!("usage: bumblebeam-pool <pool.toml> [run all|stratum|app | admin ...]"),
    };
    info!(role = role.as_str(), "role");
    if role.stratum() {
        anyhow::ensure!(db.acquire_instance_lock(db::STRATUM_LOCK).await?, "another stratum half (or an older pool) already runs against this database");
    }
    if role.app() {
        anyhow::ensure!(db.acquire_instance_lock(db::APP_LOCK).await?, "another app half already runs against this database");
    }
    if role != state::Role::All {
        anyhow::ensure!(cfg.admin.token.len() >= 24, "run stratum / run app need [admin] token (24+ chars): it authenticates the control interface between them");
    }
    let (job_tx, _) = watch::channel(None);
    let (submit_tx, submit_rx) = mpsc::channel(256);
    let (payout_tx, payout_rx) = mpsc::channel(4);
    let (share_tx, share_rx) = mpsc::channel(50_000);
    let http = reqwest::Client::builder()
        .user_agent("bumblebeam-pool/0.1")
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    let shared = Arc::new(Shared {
        cfg: cfg.clone(),
        db,
        job_tx,
        submit_tx,
        payout_tx,
        node_prefix: RwLock::new(String::new()),
        conn_seq: AtomicU64::new(0),
        connected_workers: AtomicU64::new(0),
        conns: conns::Conns::default(),
        net_height: AtomicU64::new(0),
        next_payout: std::sync::atomic::AtomicI64::new(0),
        payouts_frozen_left: std::sync::atomic::AtomicI64::new(-1),
        started: Instant::now(),
        http: http.clone(),
        // the finalizer link belongs to the stratum half
        coinbase: (cfg.coinbase.enabled && role.stratum()).then(coinbase::Link::new),
        stopping: watch::channel(false).0,
        paying: tokio::sync::Mutex::new(()),
        crediting: AtomicU64::new(0),
        share_tx,
        role,
        node_cache: std::sync::RwLock::new(None),
    });
    if role.stratum() {
        tokio::spawn(stratum::share_writer(shared.clone(), share_rx));
    }
    tokio::spawn(shutdown_on_signal(shared.clone()));
    if let Some(link) = shared.coinbase.clone() {
        let s = shared.clone();
        tokio::spawn(async move {
            if let Err(e) = coinbase::serve(s, link).await {
                error!("coinbase link: {e:#}");
            }
        });
        tokio::spawn(coinbase::expiry_loop(shared.clone()));
        info!(link = %cfg.coinbase.link_bind, "coinbase payouts enabled");
        if cfg.stratum.solo_port > 0 || cfg.stratum.solo_tls_port > 0 {
            tracing::warn!("solo ports are configured but solo logins are refused while coinbase payouts are on: every template pays the PPLNS accounts");
        }
    }

    {
        // the role locks live in their connections: if one is lost and cannot be retaken, stop (gracefully)
        let s = shared.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                if !s.db.check_instance_lock().await {
                    error!("lost a database instance lock and could not retake it; stopping so the supervisor restarts us");
                    shutdown(s.clone(), "lost the instance lock", 3).await;
                }
            }
        });
    }

    // ---- the stratum half
    if role.stratum() {
        tokio::spawn(upstream::run(shared.clone(), submit_rx));
        tokio::spawn(accounting::credit_loop(shared.clone()));
        let acceptor = if cfg.stratum.pplns_tls_port > 0 || cfg.stratum.solo_tls_port > 0 {
            Some(stratum::tls_acceptor(&cfg.stratum.tls_cert, &cfg.stratum.tls_key).context("stratum tls_cert/tls_key")?)
        } else {
            None
        };
        let ports = [
            (cfg.stratum.pplns_port, Mode::Pplns, None),
            (cfg.stratum.solo_port, Mode::Solo, None),
            (cfg.stratum.pplns_tls_port, Mode::Pplns, acceptor.clone()),
            (cfg.stratum.solo_tls_port, Mode::Solo, acceptor.clone()),
        ];
        for (port, mode, tls) in ports {
            if port == 0 {
                continue;
            }
            let s = shared.clone();
            tokio::spawn(async move {
                if let Err(e) = stratum::serve(s, port, mode, tls).await {
                    // a port that cannot be bound is a broken pool, not a log line
                    error!(port, "stratum: {e:#}; exiting");
                    std::process::exit(2);
                }
            });
        }
    }
    if role == state::Role::Stratum {
        // its syncing-node guard needs the network height, which the app half's explorer cache writes
        tokio::spawn(net_height_loop(shared.clone()));
        // the app half's view of the node: a heartbeat every 10 s with the current template (crate::state::NodeView)
        tokio::spawn(node_job_beat(shared.clone()));
    }

    // ---- the app half
    if role == state::Role::App {
        tokio::spawn(node_view_loop(shared.clone()));
    }
    if role.app() {
        let net = Arc::new(network::NetCache::default());
        tokio::spawn(network::run(net.clone(), shared.clone()));
        tokio::spawn(accounting::confirm_loop(shared.clone()));
        tokio::spawn(payouts::run(shared.clone(), payout_rx));
        {
            let s = shared.clone();
            tokio::spawn(async move {
                let mut pruned_hour = 0;
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    let t = state::now();
                    if let Err(e) = s.db.sample_hashrates(t).await {
                        error!("hashrate samples: {e:#}");
                    }
                    // once per clock hour (a `t % 3600 < 60` test could miss an hour as the loop drifts)
                    if t / 3600 != pruned_hour {
                        pruned_hour = t / 3600;
                        if let Err(e) = s.db.prune(t).await {
                            error!("prune: {e:#}");
                        }
                    }
                }
            });
        }
        let stratum = if role == state::Role::All { ctl::Stratum::Local(shared.clone()) } else { ctl::Stratum::remote(&cfg.control.url, &cfg.admin.token, http.clone()) };
        let app = api::router(api::Api { shared: shared.clone(), net, stratum: Arc::new(stratum) });
        let listener = tokio::net::TcpListener::bind(&cfg.http.bind).await.with_context(|| format!("bind {}", cfg.http.bind))?;
        info!(bind = %cfg.http.bind, "http listening");
        axum::serve(listener, app).await?;
    } else {
        // stratum only: the control interface for the app process; if it fails the miners are kept (the app loses
        // its live view and says so), this process lives on until a signal
        if let Err(e) = ctl::serve(shared.clone()).await {
            error!("control interface: {e:#}; pool-app has no live view of the stratum process until it is restarted");
        }
        std::future::pending::<()>().await;
    }
    Ok(())
}

/// Stratum-only: every 10 s the current template (height, difficulty, when it came) and the time now, for the app.
async fn node_job_beat(shared: Arc<Shared>) {
    loop {
        if let Some(j) = shared.current_job() {
            let t = state::now();
            let v = serde_json::json!({ "height": j.height, "net_packed": j.net_packed, "at": t, "job_at": t - j.received.elapsed().as_secs() as i64 }).to_string();
            if let Err(e) = shared.db.meta_set("node_job", &v).await {
                tracing::warn!("meta node_job: {e:#}");
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
    }
}

/// App-only: the node's template as the stratum process last wrote it (meta `node_job`), every 2 s.
async fn node_view_loop(shared: Arc<Shared>) {
    loop {
        if let Ok(Some(v)) = shared.db.meta_get("node_job").await {
            if let Ok(j) = serde_json::from_str::<serde_json::Value>(&v) {
                if let (Some(height), Some(net_packed), Some(at)) = (j["height"].as_u64(), j["net_packed"].as_u64(), j["at"].as_i64()) {
                    let job_at = j["job_at"].as_i64().unwrap_or(at);
                    *shared.node_cache.write().unwrap() = Some(state::NodeView { height, net_packed: net_packed as u32, at, job_at });
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

/// Stratum-only: the network height the app half's explorer cache writes (meta `net_height`), every 30 s.
async fn net_height_loop(shared: Arc<Shared>) {
    loop {
        if let Ok(Some(v)) = shared.db.meta_get("net_height").await {
            if let Ok(h) = v.parse::<u64>() {
                shared.net_height.store(h, std::sync::atomic::Ordering::Relaxed);
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    }
}

/// A graceful stop on SIGTERM (docker stop) or SIGINT: no new connections, every live one flushes its counters
/// and closes (the miners reconnect to the next process), the queued shares and a block being credited reach the
/// database, a payout in progress finishes, then exit 0. Each half waits only for its own work.
async fn shutdown_on_signal(shared: Arc<Shared>) {
    use tokio::signal::unix::{signal, SignalKind};
    let (Ok(mut term), Ok(mut int)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt())) else {
        error!("cannot listen for SIGTERM / SIGINT: no graceful shutdown");
        return;
    };
    let which = tokio::select! { _ = term.recv() => "SIGTERM", _ = int.recv() => "SIGINT" };
    shutdown(shared, which, 0).await;
}

async fn shutdown(shared: Arc<Shared>, why: &str, code: i32) {
    use std::sync::atomic::Ordering;
    let workers = shared.connected_workers.load(Ordering::Relaxed);
    info!(reason = why, role = shared.role.as_str(), workers, "shutting down");
    // send_replace: send() stores nothing when nobody subscribes, as in `run app` (the payout loop then never saw the stop)
    shared.stopping.send_replace(true);
    let t0 = Instant::now();
    let mut left = 0;
    if shared.role.stratum() {
        while shared.connected_workers.load(Ordering::Relaxed) > 0 && t0.elapsed() < std::time::Duration::from_secs(2) {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        left = shared.connected_workers.load(Ordering::Relaxed);
        // the shares the closing connections queued reach the database
        if !shared.flush_shares(2).await {
            error!("shutdown: the share writer did not finish in 2 s; the newest shares may be lost");
        }
        // a block being credited finishes (credit_loop would redo it, but a clean finish is better)
        while shared.crediting.load(Ordering::SeqCst) > 0 && t0.elapsed() < std::time::Duration::from_secs(5) {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }
    if shared.role.app() {
        if tokio::time::timeout(std::time::Duration::from_secs(6), shared.paying.lock()).await.is_err() {
            error!("shutdown: a payout run is still talking to the wallet after 6 s; exiting anyway (recover_created picks it up)");
        }
    }
    info!(left, ms = t0.elapsed().as_millis() as u64, "shutdown complete");
    std::process::exit(code);
}
