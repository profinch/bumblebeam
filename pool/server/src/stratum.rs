//! Stratum server for miners, in Beam's dialect: newline-delimited JSON, `login` with
//! `api_key = "<address>.<worker>"`, `job`, `solution`, `result`. Every share is checked with the
//! oracle; a rejected share carries the oracle's reason so the miner can tell a broken kernel from
//! a stale job.

use crate::pow;
use crate::state::{Job, Mode, Shared, Submit};
use anyhow::Result;
use serde_json::{json, Value};
use std::collections::{HashSet, VecDeque};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
use futures_util::StreamExt;
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, WriteHalf};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use tokio_util::codec::{FramedRead, LinesCodec};

/// Longest line a miner may send; a login or solution is well under 1 KB.
pub const MAX_LINE: usize = 8192;
/// Connections allowed per source address.
const MAX_CONNS_PER_IP: usize = 64;

static PER_IP: Mutex<Option<HashMap<IpAddr, usize>>> = Mutex::new(None);
fn ip_acquire(ip: IpAddr) -> bool {
    let mut g = PER_IP.lock().unwrap();
    let m = g.get_or_insert_with(HashMap::new);
    let n = m.entry(ip).or_insert(0);
    if *n >= MAX_CONNS_PER_IP {
        return false;
    }
    *n += 1;
    true
}
fn ip_release(ip: IpAddr) {
    let mut g = PER_IP.lock().unwrap();
    if let Some(m) = g.as_mut() {
        if let Some(n) = m.get_mut(&ip) {
            *n -= 1;
            if *n == 0 {
                m.remove(&ip);
            }
        }
    }
}
use tracing::{debug, info, warn};

// Beam hard-fork heights the miners use to pick the algorithm (BeamHash II, then III).
const FORK_HEIGHT: u64 = 321_321;
const FORK_HEIGHT2: u64 = 777_777;

pub async fn serve(shared: Arc<Shared>, port: u16, mode: Mode, tls: Option<TlsAcceptor>) -> Result<()> {
    let listener = TcpListener::bind((shared.cfg.stratum.bind.as_str(), port)).await?;
    info!(port, mode = mode.as_str(), tls = tls.is_some(), "stratum listening");
    loop {
        let (sock, peer) = listener.accept().await?;
        let _ = sock.set_nodelay(true);
        if !ip_acquire(peer.ip()) {
            debug!(%peer, "too many connections from this address");
            continue;
        }
        let shared = shared.clone();
        let tls = tls.clone();
        tokio::spawn(async move {
            shared.connected_workers.fetch_add(1, Ordering::Relaxed);
            let mut s = Session { peer, tls: tls.is_some(), started: Instant::now(), miner: String::new(), worker: String::new(), accepted: 0, stale: 0, rejected: 0 };
            let r = match tls {
                Some(acceptor) => match tokio::time::timeout(Duration::from_secs(15), acceptor.accept(sock)).await {
                    Ok(Ok(stream)) => connection(shared.clone(), stream, mode, &mut s).await,
                    Ok(Err(e)) => Err(anyhow::anyhow!("tls: {e}")),
                    Err(_) => Err(anyhow::anyhow!("tls handshake timeout")),
                },
                None => connection(shared.clone(), sock, mode, &mut s).await,
            };
            let reason = match &r { Ok(()) => "closed by the miner".to_string(), Err(e) => format!("{e:#}") };
            if s.miner.is_empty() {
                // scanners and failed handshakes: only with RUST_LOG=debug
                debug!(%peer, tls = s.tls, %reason, "connection ended before login");
            } else {
                info!(%peer, miner = %crate::state::Short(&s.miner), worker = %s.worker, mode = mode.as_str(), tls = s.tls,
                      minutes = s.started.elapsed().as_secs() / 60, accepted = s.accepted, stale = s.stale, rejected = s.rejected, %reason, "disconnect");
            }
            shared.connected_workers.fetch_sub(1, Ordering::Relaxed);
            ip_release(peer.ip());
        });
    }
}

/// Loads the PEM certificate and key for the miner-facing TLS ports.
pub fn tls_acceptor(cert_path: &str, key_path: &str) -> Result<TlsAcceptor> {
    let certs = rustls_pemfile::certs(&mut std::io::BufReader::new(std::fs::File::open(cert_path)?)).collect::<Result<Vec<_>, _>>()?;
    let key = rustls_pemfile::private_key(&mut std::io::BufReader::new(std::fs::File::open(key_path)?))?
        .ok_or_else(|| anyhow::anyhow!("no private key in {key_path}"))?;
    let config = rustls::ServerConfig::builder().with_no_client_auth().with_single_cert(certs, key)?;
    Ok(TlsAcceptor::from(Arc::new(config)))
}

struct MinerJob {
    id: String,
    job: Arc<Job>,
    packed: u32,
    seen: HashSet<([u8; 8], [u8; 32])>,
}

struct Vardiff {
    diff: f64,
    shares: u32,
    since: Instant,
}

/// One miner connection, for the line logged when it ends: who it was, how long it lasted, what
/// it sent and why it closed. The connection fills it in; serve() logs it.
struct Session {
    peer: std::net::SocketAddr,
    tls: bool,
    started: Instant,
    miner: String,
    worker: String,
    accepted: u64,
    stale: u64,
    rejected: u64,
}

#[derive(Default)]
struct WorkerStats {
    accepted: u64,
    stale: i64,
    rejected: i64,
    last_share: i64,
}

/// Beam addresses: regular SBBS ones are 64–70 hex chars and expire; offline, max-privacy and
/// public-offline ones are long alphanumerics. The server accepts both, the UI warns on regular.
fn address_type(a: &str) -> Option<&'static str> {
    let hex_like = a.len() >= 64 && a.len() <= 70 && a.chars().all(|c| c.is_ascii_hexdigit());
    if hex_like {
        return Some("regular");
    }
    if a.len() >= 100 && a.len() <= 600 && a.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Some("offline");
    }
    None
}

async fn connection<S: AsyncRead + AsyncWrite + Unpin + Send>(shared: Arc<Shared>, stream: S, mode: Mode, sess: &mut Session) -> Result<()> {
    let (rd, mut wr) = tokio::io::split(stream);
    let mut lines = FramedRead::new(rd, LinesCodec::new_with_max_length(MAX_LINE));
    let mut job_rx = shared.job_tx.subscribe();

    let conn = shared.next_conn();
    let node_prefix = shared.node_prefix.read().await.clone();
    let own_bytes = shared.cfg.stratum.nonce_prefix_bytes.min(6usize.saturating_sub(node_prefix.len() / 2));
    let own = hex::encode(&conn.to_be_bytes()[8 - own_bytes..]);
    let prefix = format!("{node_prefix}{own}");
    let prefix_bytes = hex::decode(&prefix).unwrap_or_default();

    let mut address = String::new();
    let mut worker = String::new();
    let mut miner_id: i64 = 0;
    let mut jobs: VecDeque<MinerJob> = VecDeque::new();
    let mut seq = 0u64;
    let vd_cfg = &shared.cfg.vardiff;
    let mut vd = Vardiff { diff: vd_cfg.start, shares: 0, since: Instant::now() };
    let idle = Duration::from_secs(900);
    let mut stats = WorkerStats::default();
    let mut flush = tokio::time::interval(Duration::from_secs(60));
    flush.tick().await;

    async fn send<W: AsyncWrite + Unpin>(wr: &mut W, v: Value) -> Result<()> {
        wr.write_all(format!("{v}\n").as_bytes()).await?;
        Ok(())
    }
    fn result(id: &str, code: i64, desc: &str) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "method": "result", "code": code, "description": desc })
    }

    loop {
        tokio::select! {
            line = tokio::time::timeout(idle, lines.next()) => {
                let Some(line) = line.map_err(|_| anyhow::anyhow!("idle"))? else { return Ok(()) };
                let line = line.map_err(|e| anyhow::anyhow!("line: {e}"))?; // over MAX_LINE closes the connection
                if line.trim().is_empty() { continue; }
                let msg: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => { send(&mut wr, result("", -32000, "message corrupted")).await?; continue; }
                };
                let id = msg["id"].as_str().unwrap_or("").to_string();
                match msg["method"].as_str().unwrap_or("") {
                    "login" => {
                        let key = msg["api_key"].as_str().unwrap_or("").trim();
                        let (addr, wk) = match key.split_once('.') { Some((a, w)) => (a, w), None => (key, "default") };
                        let Some(kind) = address_type(addr) else {
                            send(&mut wr, result(&id, -32003, "Login failed: use <beam address>.<worker>; an offline address is recommended")).await?;
                            return Ok(());
                        };
                        address = addr.to_string();
                        worker = wk.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(32).collect();
                        if worker.is_empty() { worker = "default".into(); }
                        miner_id = match shared.db.miner_id(&address, &format!("{kind}?"), crate::state::now()).await {
                            Ok(id) => id,
                            Err(e) => { warn!("miner lookup: {e:#}"); send(&mut wr, result(&id, -32003, "Login failed: pool database unavailable, retry")).await?; return Ok(()); }
                        };
                        let desc = if kind == "regular" {
                            "Login successful. Warning: regular addresses expire and need the wallet online; use an offline address for payouts"
                        } else { "Login successful" };
                        let mut res = result(&id, 0, desc);
                        res["nonceprefix"] = json!(prefix);
                        res["forkheight"] = json!(FORK_HEIGHT);
                        res["forkheight2"] = json!(FORK_HEIGHT2);
                        send(&mut wr, res).await?;
                        sess.miner = address.clone();
                        sess.worker = worker.clone();
                        info!(peer = %sess.peer, miner = %crate::state::Short(&address), worker = %worker, mode = mode.as_str(), tls = sess.tls, %kind, "login");
                        if let Some(job) = shared.current_job() {
                            seq += 1;
                            push_job(&mut wr, &mut jobs, &job, &mut seq, vd.diff).await?;
                        }
                    }
                    "solution" => {
                        if address.is_empty() { send(&mut wr, result(&id, -32003, "login first")).await?; continue; }
                        let Some(pos) = jobs.iter().position(|j| j.id == id) else {
                            send(&mut wr, result(&id, 3, "stale: job expired")).await?;
                            continue;
                        };
                        if let Some(cur) = shared.current_job() {
                            if jobs[pos].job.height < cur.height {
                                send(&mut wr, result(&id, 3, "stale: block already found")).await?;
                                stats.stale += 1;
                                sess.stale += 1;
                                continue;
                            }
                        }
                        // Around a vardiff change the miner may tag a share with the previous job id
                        // for the same template; judge it by the lowest difficulty of those jobs.
                        let input = jobs[pos].job.input;
                        let lenient = jobs.iter().filter(|j| j.job.input == input).map(|j| j.packed).min().unwrap_or(jobs[pos].packed);
                        let nonce = hex::decode(msg["nonce"].as_str().unwrap_or("")).unwrap_or_default();
                        let output = hex::decode(msg["output"].as_str().unwrap_or("")).unwrap_or_default();
                        if nonce.len() != pow::NONCE_BYTES || output.len() != pow::SOLUTION_BYTES {
                            send(&mut wr, result(&id, 2, "rejected: nonce must be 8 bytes and output 104 bytes")).await?;
                            continue;
                        }
                        if !prefix_bytes.is_empty() && !nonce.starts_with(&prefix_bytes) {
                            send(&mut wr, result(&id, 2, "rejected: nonce does not start with the assigned prefix")).await?;
                            continue;
                        }
                        let mut n = [0u8; 8]; n.copy_from_slice(&nonce);
                        let mut out = [0u8; 104]; out.copy_from_slice(&output);
                        let hash = pow::solution_hash(&out);
                        // the same template can be out under several ids (vardiff): one set of seen shares for all of them
                        if jobs.iter().any(|j| j.job.input == input && j.seen.contains(&(n, hash))) {
                            send(&mut wr, result(&id, 2, "rejected: duplicate share")).await?;
                            stats.rejected += 1;
                            sess.rejected += 1;
                            continue;
                        }
                        let mj = &mut jobs[pos];
                        mj.seen.insert((n, hash));
                        let mut packed = mj.packed;
                        let mut r = pow::check_share(&mj.job.input, &n, &out, packed);
                        if r == pow::BB_ERR_DIFFICULTY && lenient != packed && pow::difficulty_reached(&hash, lenient) {
                            packed = lenient;
                            r = pow::BB_OK;
                        }
                        if r != pow::BB_OK {
                            send(&mut wr, result(&id, 2, &format!("rejected: {}", pow::result_str(r)))).await?;
                            warn!(miner = %crate::state::Short(&address), worker = %worker, reason = pow::result_str(r), "share rejected");
                            stats.rejected += 1;
                            sess.rejected += 1;
                            continue;
                        }
                        stats.accepted += 1;
                        sess.accepted += 1;
                        stats.last_share = crate::state::now();
                        let share_diff = pow::difficulty_to_double(packed);
                        let job = mj.job.clone();
                        send(&mut wr, result(&id, 1, "accepted")).await?;
                        if let Err(e) = shared.db.record_share(crate::state::now(), miner_id, &worker, mode.as_str(), share_diff, job.height as i64).await {
                            warn!("record share: {e:#}");
                        }
                        if pow::difficulty_reached(&hash, job.net_packed) {
                            info!(miner = %crate::state::Short(&address), worker = %worker, height = job.height, "share reaches network difficulty, submitting block");
                            let _ = shared.submit_tx.send(Submit { job: job.clone(), nonce: n, output: out, miner_id, address: address.clone(), worker: worker.clone(), mode }).await;
                        }
                        // vardiff: aim at one share per target_secs, adjust at most 4x per step
                        vd.shares += 1;
                        let el = vd.since.elapsed().as_secs_f64();
                        if vd.shares >= 8 || el > 90.0 {
                            // the worker finds shares at hashrate/diff per second; scale diff so that
                            // becomes one per target_secs
                            let want = vd.diff * (vd.shares as f64 * vd_cfg.target_secs / el.max(0.5));
                            let new = want.clamp(vd.diff / 4.0, vd.diff * 4.0).clamp(vd_cfg.min, vd_cfg.max);
                            vd.shares = 0; vd.since = Instant::now();
                            if (new / vd.diff - 1.0).abs() > 0.25 {
                                vd.diff = new;
                                debug!(miner = %crate::state::Short(&address), worker = %worker, diff = new, "vardiff");
                                if let Some(job) = shared.current_job() { push_job(&mut wr, &mut jobs, &job, &mut seq, vd.diff).await?; }
                            }
                        }
                    }
                    "" => send(&mut wr, result(&id, -32001, "unknown method")).await?,
                    other => { debug!(%other, "ignored method"); }
                }
            }
            _ = flush.tick() => {
                if !address.is_empty() && (stats.stale > 0 || stats.rejected > 0) {
                    let _ = shared.db.record_share_events(crate::state::now(), miner_id, &worker, stats.stale, stats.rejected).await;
                }
                if !address.is_empty() && stats.last_share > 0 {
                    let _ = shared.db.touch_miner(miner_id, stats.last_share).await;
                }
                stats = WorkerStats { accepted: stats.accepted, ..Default::default() };
                // a worker that has not found a share in a long time has too high a difficulty
                if !address.is_empty() && vd.shares == 0 && vd.since.elapsed().as_secs_f64() > 6.0 * vd_cfg.target_secs && vd.diff > vd_cfg.min {
                    vd.diff = (vd.diff / 4.0).max(vd_cfg.min);
                    vd.since = Instant::now();
                    debug!(miner = %crate::state::Short(&address), worker = %worker, diff = vd.diff, "vardiff down: no shares");
                    if let Some(job) = shared.current_job() { push_job(&mut wr, &mut jobs, &job, &mut seq, vd.diff).await?; }
                }
            }
            changed = job_rx.changed() => {
                if changed.is_err() { return Ok(()); }
                let job = job_rx.borrow_and_update().clone();
                if address.is_empty() { continue; }
                match job {
                    Some(job) => push_job(&mut wr, &mut jobs, &job, &mut seq, vd.diff).await?,
                    None => debug!("no job from node"),
                }
            }
        }
    }
}

async fn push_job<S: AsyncWrite + Unpin>(wr: &mut WriteHalf<S>, jobs: &mut VecDeque<MinerJob>, job: &Arc<Job>, seq: &mut u64, diff: f64) -> Result<()> {
    *seq += 1;
    let id = seq.to_string();
    let packed = pow::pack_difficulty(diff);
    let msg = json!({ "jsonrpc": "2.0", "id": id, "method": "job", "input": hex::encode(job.input), "difficulty": packed, "height": job.height });
    wr.write_all(format!("{msg}\n").as_bytes()).await?;
    jobs.push_front(MinerJob { id, job: job.clone(), packed, seen: HashSet::new() });
    while jobs.len() > 4 { jobs.pop_back(); }
    Ok(())
}
