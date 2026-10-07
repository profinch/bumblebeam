//! Client to the beam-node stratum server: logs in, receives block templates (jobs), forwards
//! block-level solutions, and reports the node's verdict to accounting.

use crate::state::{Job, Shared, Submit};
use anyhow::{anyhow, Context, Result};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};
use futures_util::StreamExt;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio_util::codec::{FramedRead, LinesCodec};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_rustls::TlsConnector;
use tracing::{error, info, warn};

/// The node sent nothing for a long time; a watchdog event, not a failure.
#[derive(Debug)]
struct Idle;
impl std::fmt::Display for Idle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "node sent nothing for 10 minutes (normal while it syncs), reconnecting")
    }
}
impl std::error::Error for Idle {}

/// The node is ours and its certificate is self-signed: accept it, still verify signatures.
#[derive(Debug)]
struct TrustOwnNode(rustls::crypto::CryptoProvider);
impl ServerCertVerifier for TrustOwnNode {
    fn verify_server_cert(&self, _: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: &ServerName<'_>, _: &[u8], _: UnixTime) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(m, c, d, &self.0.signature_verification_algorithms)
    }
    fn verify_tls13_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(m, c, d, &self.0.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

pub async fn run(shared: Arc<Shared>, mut submit_rx: mpsc::Receiver<Submit>) {
    let mut addrs: Vec<String> = std::iter::once(shared.cfg.node.stratum_addr.clone()).chain(shared.cfg.node.standby.iter().cloned()).collect();
    let mut backoff = 1u64;
    loop {
        let addr = addrs[0].clone();
        info!(%addr, "connecting to node stratum");
        let started = Instant::now();
        match session(&shared, &addr, &mut submit_rx).await {
            Ok(()) => warn!(%addr, "node stratum connection closed"),
            Err(e) if e.downcast_ref::<Idle>().is_some() => warn!(%addr, "node stratum: {e}"),
            Err(e) => error!(%addr, "node stratum: {e:#}"),
        }
        shared.job_tx.send_replace(None);
        if started.elapsed() > Duration::from_secs(60) {
            backoff = 1;
        }
        // rotate to the next node after a failure, back off up to 30 s
        addrs.rotate_left(1);
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(30);
    }
}

async fn session(shared: &Arc<Shared>, addr: &str, submit_rx: &mut mpsc::Receiver<Submit>) -> Result<()> {
    let tcp = tokio::time::timeout(Duration::from_secs(10), TcpStream::connect(addr)).await.context("connect timeout")??;
    tcp.set_nodelay(true)?;
    if shared.cfg.node.tls {
        let provider = rustls::crypto::ring::default_provider();
        let config = rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(TrustOwnNode(provider)))
            .with_no_client_auth();
        let connector = TlsConnector::from(Arc::new(config));
        let name = ServerName::try_from("beam-node").map_err(|_| anyhow!("server name"))?.to_owned();
        let tls = connector.connect(name, tcp).await.context("tls handshake")?;
        drive(shared, tls, submit_rx).await
    } else {
        drive(shared, tcp, submit_rx).await
    }
}

async fn drive<S: AsyncRead + AsyncWrite + Unpin>(shared: &Arc<Shared>, stream: S, submit_rx: &mut mpsc::Receiver<Submit>) -> Result<()> {
    let (rd, mut wr) = tokio::io::split(stream);
    let mut lines = FramedRead::new(rd, LinesCodec::new_with_max_length(65536));

    let login = json!({ "jsonrpc": "2.0", "id": "login", "method": "login", "api_key": shared.cfg.node.api_key });
    wr.write_all(format!("{login}\n").as_bytes()).await?;

    // Solutions in flight, by the job id we sent them under (the node answers with that id).
    let mut pending: HashMap<String, VecDeque<Submit>> = HashMap::new();
    let mut logged_in = false;
    let mut last_sync_warn = Instant::now() - Duration::from_secs(3600);
    let idle = Duration::from_secs(600);

    loop {
        tokio::select! {
            line = tokio::time::timeout(idle, lines.next()) => {
                let line = line.map_err(|_| anyhow::Error::new(Idle))?.ok_or_else(|| anyhow!("eof"))?.context("line from node")?;
                if line.trim().is_empty() { continue; }
                let msg: Value = match serde_json::from_str(&line) { Ok(v) => v, Err(e) => { warn!("bad json from node: {e}: {}", &line[..line.len().min(200)]); continue; } };
                let method = msg["method"].as_str().unwrap_or("");
                let id = msg["id"].as_str().unwrap_or("").to_string();
                match method {
                    "result" if id == "login" => {
                        let code = msg["code"].as_i64().unwrap_or(-1);
                        if code != 0 { return Err(anyhow!("node login failed: {} {}", code, msg["description"])); }
                        let prefix = msg["nonceprefix"].as_str().unwrap_or("").to_string();
                        *shared.node_prefix.write().await = prefix.clone();
                        logged_in = true;
                        info!(nonceprefix = %prefix, "logged in to node stratum");
                    }
                    "job" => {
                        if !logged_in { warn!("job before login result"); }
                        match parse_job(&msg) {
                            Ok(job) => {
                                // While the node syncs it emits a template for every historical block
                                // it passes; those must never reach miners.
                                let net_h = shared.net_height.load(std::sync::atomic::Ordering::Relaxed);
                                let lag = shared.cfg.node.sync_lag_blocks;
                                if lag > 0 && net_h > 0 && job.height + lag < net_h {
                                    if last_sync_warn.elapsed() > Duration::from_secs(60) {
                                        warn!(job_height = job.height, network_height = net_h, "node still syncing: no work for miners yet");
                                        last_sync_warn = Instant::now();
                                    }
                                    shared.job_tx.send_replace(None);
                                    continue;
                                }
                                info!(id = %job.upstream_id, height = job.height, difficulty = crate::pow::difficulty_to_double(job.net_packed), "new job");
                                shared.job_tx.send_replace(Some(Arc::new(job)));
                            }
                            Err(e) => warn!("bad job: {e}"),
                        }
                    }
                    "cancel" => {
                        // the node withdrew a template; the next job replaces it
                    }
                    "result" => {
                        let code = msg["code"].as_i64().unwrap_or(-1);
                        let desc = msg["description"].as_str().unwrap_or("").to_string();
                        let blockhash = msg["blockhash"].as_str().unwrap_or("").to_string();
                        let sub = pending.get_mut(&id).and_then(|q| q.pop_front());
                        match (sub, code) {
                            (Some(sub), 1) => {
                                info!(height = sub.job.height, %blockhash, miner = %sub.address, worker = %sub.worker, "BLOCK FOUND, accepted by node");
                                let shared = shared.clone();
                                tokio::spawn(async move {
                                    if let Err(e) = crate::accounting::block_found(&shared, sub, blockhash).await { error!("accounting: {e:#}"); }
                                });
                            }
                            (Some(sub), _) => warn!(height = sub.job.height, code, %desc, miner = %sub.address, "block solution rejected by node"),
                            (None, _) => warn!(%id, code, %desc, "result for unknown submission"),
                        }
                    }
                    other => warn!(%other, "unknown message from node"),
                }
            }
            sub = submit_rx.recv() => {
                let Some(sub) = sub else { return Err(anyhow!("submit channel closed")) };
                let id = sub.job.upstream_id.clone();
                let sol = json!({ "jsonrpc": "2.0", "id": id, "method": "solution", "nonce": hex::encode(sub.nonce), "output": hex::encode(sub.output) });
                wr.write_all(format!("{sol}\n").as_bytes()).await?;
                info!(height = sub.job.height, miner = %sub.address, "block solution sent to node");
                pending.entry(id).or_default().push_back(sub);
                if pending.len() > 64 { pending.clear(); }
            }
        }
    }
}

fn parse_job(msg: &Value) -> Result<Job> {
    let id = msg["id"].as_str().ok_or_else(|| anyhow!("no id"))?.to_string();
    let input = hex::decode(msg["input"].as_str().ok_or_else(|| anyhow!("no input"))?)?;
    anyhow::ensure!(input.len() == 32, "input is {} bytes", input.len());
    let difficulty = msg["difficulty"].as_u64().ok_or_else(|| anyhow!("no difficulty"))?;
    anyhow::ensure!(difficulty <= u32::MAX as u64, "difficulty out of range");
    let height = msg["height"].as_u64().ok_or_else(|| anyhow!("no height"))?;
    let mut inp = [0u8; 32];
    inp.copy_from_slice(&input);
    Ok(Job { upstream_id: id, input: inp, net_packed: difficulty as u32, height, received: Instant::now() })
}
