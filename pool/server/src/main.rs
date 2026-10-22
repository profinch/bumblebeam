//! BumbleBeam pool server: stratum proxy between Beam miners and our beam-node, share checks with
//! the oracle, PPLNS and solo accounting in PostgreSQL, payouts over wallet-api, HTTP API + web UI.

mod accounting;
mod admin;
mod api;
mod coinbase;
mod config;
mod conns;
mod db;
mod emission;
mod network;
mod payouts;
mod pow;
mod state;
mod stratum;
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
    anyhow::ensure!(db.acquire_instance_lock().await?, "another pool process already runs against this database");
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
        coinbase: cfg.coinbase.enabled.then(coinbase::Link::new),
        stopping: watch::channel(false).0,
        paying: tokio::sync::Mutex::new(()),
        crediting: AtomicU64::new(0),
        share_tx,
    });
    tokio::spawn(stratum::share_writer(shared.clone(), share_rx));
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
        // the single-instance lock lives in one connection: if it is lost and cannot be retaken, stop
        let s = shared.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                if !s.db.check_instance_lock().await {
                    error!("lost the single-instance database lock and could not retake it; exiting so the supervisor restarts us");
                    std::process::exit(3);
                }
            }
        });
    }
    let net = Arc::new(network::NetCache::default());
    tokio::spawn(network::run(net.clone(), shared.clone()));
    tokio::spawn(upstream::run(shared.clone(), submit_rx));
    tokio::spawn(accounting::confirm_loop(shared.clone()));
    tokio::spawn(accounting::credit_loop(shared.clone()));
    tokio::spawn(payouts::run(shared.clone(), payout_rx));
    {
        let s = shared.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                if let Err(e) = s.db.sample_hashrates(state::now()).await {
                    error!("hashrate samples: {e:#}");
                }
            }
        });
    }
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
                error!(port, "stratum: {e:#}");
            }
        });
    }

    let app = api::router(api::Api { shared: shared.clone(), net });
    let listener = tokio::net::TcpListener::bind(&cfg.http.bind).await.with_context(|| format!("bind {}", cfg.http.bind))?;
    info!(bind = %cfg.http.bind, web = %cfg.http.web_dir, "http listening");
    axum::serve(listener, app).await?;
    Ok(())
}

/// A graceful stop on SIGTERM (docker stop) or SIGINT: no new connections, every live one flushes its counters
/// and closes (the miners reconnect to the next process), a payout in progress finishes, then exit 0. Without it
/// docker waited its 10 s and killed the pool mid-write (2026-10-22). Bounded to stay inside docker's 10 s.
async fn shutdown_on_signal(shared: Arc<Shared>) {
    use std::sync::atomic::Ordering;
    use tokio::signal::unix::{signal, SignalKind};
    let (Ok(mut term), Ok(mut int)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt())) else {
        error!("cannot listen for SIGTERM / SIGINT: no graceful shutdown");
        return;
    };
    let which = tokio::select! { _ = term.recv() => "SIGTERM", _ = int.recv() => "SIGINT" };
    let workers = shared.connected_workers.load(Ordering::Relaxed);
    info!(signal = which, workers, "shutting down: closing the stratum ports and connections");
    let _ = shared.stopping.send(true);
    let t0 = Instant::now();
    while shared.connected_workers.load(Ordering::Relaxed) > 0 && t0.elapsed() < std::time::Duration::from_secs(2) {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let left = shared.connected_workers.load(Ordering::Relaxed);
    // the shares the closing connections queued reach the database
    if !shared.flush_shares(2).await {
        error!("shutdown: the share writer did not finish in 2 s; the newest shares may be lost");
    }
    // a block being credited finishes (credit_loop would redo it, but a clean finish is better)
    while shared.crediting.load(Ordering::SeqCst) > 0 && t0.elapsed() < std::time::Duration::from_secs(5) {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    match tokio::time::timeout(std::time::Duration::from_secs(6), shared.paying.lock()).await {
        Ok(_guard) => info!(left, ms = t0.elapsed().as_millis() as u64, "shutdown complete"),
        Err(_) => error!(left, "shutdown: a payout run is still talking to the wallet after 6 s; exiting anyway (recover_created picks it up)"),
    }
    std::process::exit(0);
}
