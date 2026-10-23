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
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, WriteHalf};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use tokio_util::codec::{FramedRead, LinesCodec, LinesCodecError};

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
    let mut stop = shared.stopping.subscribe();
    loop {
        let (mut sock, mut peer) = tokio::select! {
            r = listener.accept() => match r {
                Ok(c) => c,
                // a passing error (EMFILE in a connection burst) must not take the stratum process down
                Err(e) => { warn!(port, "accept: {e}"); tokio::time::sleep(Duration::from_millis(100)).await; continue; }
            },
            _ = async { let _ = stop.wait_for(|v| *v).await; } => { info!(port, "stratum port closed (shutting down)"); return Ok(()); }
        };
        let _ = sock.set_nodelay(true);
        let shared = shared.clone();
        let tls = tls.clone();
        tokio::spawn(async move {
            if shared.cfg.stratum.proxy_protocol_from.contains(&peer.ip()) {
                match tokio::time::timeout(Duration::from_secs(10), proxy_header(&mut sock)).await {
                    Ok(Ok(Some(real))) => peer = real,
                    Ok(Ok(None)) => {}
                    Ok(Err(e)) => return debug!(%peer, "proxy header: {e:#}"),
                    Err(_) => return debug!(%peer, "proxy header timeout"),
                }
            }
            if !ip_acquire(peer.ip()) {
                debug!(%peer, "too many connections from this address");
                return;
            }
            shared.connected_workers.fetch_add(1, Ordering::Relaxed);
            // releases the counters whatever happens to this task, a panic included
            let mut guard = ConnGuard { shared: shared.clone(), ip: peer.ip(), id: None };
            let id = shared.next_conn();
            let kick = shared.conns.open(id, peer, port, mode.as_str(), tls.is_some());
            guard.id = Some(id);
            let mut s = Session { id, peer, tls: tls.is_some(), started: Instant::now(), first: String::new(), miner: String::new(), worker: String::new(), accepted: 0, stale: 0, rejected: 0, last_share: 0, miner_id: 0, stats: WorkerStats::default() };
            let r = match tls {
                Some(acceptor) => match tokio::time::timeout(Duration::from_secs(15), acceptor.accept(sock)).await {
                    Ok(Ok(stream)) => connection(shared.clone(), stream, mode, &mut s, kick).await,
                    // a first byte that is not a TLS record: plain stratum (or a scanner) on a TLS port
                    Ok(Err(e)) if e.to_string().contains("InvalidContentType") => Err(anyhow::anyhow!("not TLS: plain text on a TLS port, or a scanner")),
                    Ok(Err(e)) => Err(anyhow::anyhow!("tls: {e}")),
                    Err(_) => Err(anyhow::anyhow!("tls handshake timeout")),
                },
                None => connection(shared.clone(), sock, mode, &mut s, kick).await,
            };
            let reason = match &r {
                Ok(()) if s.miner.is_empty() => "closed by the other side".to_string(),
                Ok(()) => "closed by the miner".to_string(),
                Err(e) => format!("{e:#}"),
            };
            if !s.miner.is_empty() {
                flush_stats(&shared, &mut s, mode).await; // every disconnect, not only the minute's tick
            }
            shared.conns.close(s.id, &s.first, &reason);
            guard.id = None;
            if s.miner.is_empty() {
                // scanners and failed handshakes: only with RUST_LOG=debug
                debug!(%peer, tls = s.tls, %reason, "connection ended before login");
            } else {
                info!(%peer, miner = %crate::state::Short(&s.miner), worker = %s.worker, mode = mode.as_str(), tls = s.tls,
                      minutes = s.started.elapsed().as_secs() / 60, accepted = s.accepted, stale = s.stale, rejected = s.rejected, %reason, "disconnect");
            }
            drop(guard);
        });
    }
}

/// Reads a PROXY protocol v1 header (`PROXY TCP4 <src> <dst> <sport> <dport>\r\n`) sent by a
/// trusted relay ahead of the miner's bytes. Byte by byte, so nothing after it is consumed.
/// `PROXY UNKNOWN` (the relay's own health checks) keeps the relay's address.
async fn proxy_header<R: AsyncRead + Unpin>(rd: &mut R) -> Result<Option<std::net::SocketAddr>> {
    let mut line = Vec::with_capacity(108);
    while !line.ends_with(b"\r\n") {
        if line.len() >= 107 {
            anyhow::bail!("no PROXY v1 header in the first 107 bytes");
        }
        line.push(rd.read_u8().await?);
    }
    let line = std::str::from_utf8(&line[..line.len() - 2])?;
    let f: Vec<&str> = line.split(' ').collect();
    match f.as_slice() {
        ["PROXY", "UNKNOWN", ..] => Ok(None),
        ["PROXY", "TCP4" | "TCP6", src, _dst, sport, _dport] => Ok(Some(std::net::SocketAddr::new(src.parse()?, sport.parse()?))),
        _ => anyhow::bail!("bad PROXY header {line:?}"),
    }
}

/// Loads the PEM certificate and key for the miner-facing TLS ports.
fn load_certified_key(cert_path: &str, key_path: &str) -> Result<Arc<rustls::sign::CertifiedKey>> {
    let certs = rustls_pemfile::certs(&mut std::io::BufReader::new(std::fs::File::open(cert_path)?)).collect::<Result<Vec<_>, _>>()?;
    let key = rustls_pemfile::private_key(&mut std::io::BufReader::new(std::fs::File::open(key_path)?))?
        .ok_or_else(|| anyhow::anyhow!("no private key in {key_path}"))?;
    anyhow::ensure!(!certs.is_empty(), "no certificate in {cert_path}");
    let signing = rustls::crypto::ring::sign::any_supported_type(&key).map_err(|e| anyhow::anyhow!("{key_path}: {e}"))?;
    let ck = rustls::sign::CertifiedKey::new(certs, signing);
    // a key copied without its certificate (or the reverse) must not replace a working pair; a certificate that
    // rustls cannot check this way (a self-signed CA one, an unknown key type) is taken as before
    match ck.keys_match() {
        Ok(()) => {}
        Err(rustls::Error::InconsistentKeys(rustls::InconsistentKeys::KeyMismatch)) => anyhow::bail!("{cert_path} and {key_path} do not match"),
        Err(e) => warn!(cert = %cert_path, "cannot check that the key matches the certificate ({e}); using them"),
    }
    Ok(Arc::new(ck))
}

/// The stratum TLS certificate, re-read when its files change (a Let's Encrypt renewal copied into place by the
/// host's daily pool-tls-sync), so a renewal never needs a stratum restart that drops every miner.
#[derive(Debug)]
struct ReloadingCert {
    cert_path: String,
    key_path: String,
    current: std::sync::RwLock<(Arc<rustls::sign::CertifiedKey>, Option<std::time::SystemTime>)>,
}

impl rustls::server::ResolvesServerCert for ReloadingCert {
    fn resolve(&self, _hello: rustls::server::ClientHello<'_>) -> Option<Arc<rustls::sign::CertifiedKey>> {
        Some(self.current.read().unwrap().0.clone())
    }
}

impl ReloadingCert {
    fn modified(&self) -> Option<std::time::SystemTime> {
        let a = std::fs::metadata(&self.cert_path).and_then(|m| m.modified()).ok();
        let b = std::fs::metadata(&self.key_path).and_then(|m| m.modified()).ok();
        a.max(b)
    }
    fn reload_if_changed(&self) {
        let m = self.modified();
        if m.is_none() || m == self.current.read().unwrap().1 {
            return;
        }
        match load_certified_key(&self.cert_path, &self.key_path) {
            Ok(k) => {
                *self.current.write().unwrap() = (k, m);
                info!(cert = %self.cert_path, "stratum TLS certificate reloaded");
            }
            // a half-copied pair: keep serving the old one, try again next time
            Err(e) => warn!(cert = %self.cert_path, "stratum TLS certificate changed but does not load (keeping the old one): {e:#}"),
        }
    }
}

pub fn tls_acceptor(cert_path: &str, key_path: &str) -> Result<TlsAcceptor> {
    let resolver = Arc::new(ReloadingCert { cert_path: cert_path.into(), key_path: key_path.into(), current: std::sync::RwLock::new((load_certified_key(cert_path, key_path)?, None)) });
    let m = resolver.modified();
    resolver.current.write().unwrap().1 = m;
    let r2 = resolver.clone();
    // every 10 minutes (BB_TLS_RELOAD_SECS shortens it for tools/e2e_split.sh)
    let every = std::env::var("BB_TLS_RELOAD_SECS").ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(600).max(1);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(every)).await;
            r2.reload_if_changed();
        }
    });
    let config = rustls::ServerConfig::builder().with_no_client_auth().with_cert_resolver(resolver);
    Ok(TlsAcceptor::from(Arc::new(config)))
}

/// Undoes what accepting a connection took (the worker count, the per-IP slot, the operator's list entry), also
/// when the task panics.
struct ConnGuard {
    shared: Arc<Shared>,
    ip: IpAddr,
    /// set while the connection is in the operator's list and not yet closed there
    id: Option<u64>,
}
impl Drop for ConnGuard {
    fn drop(&mut self) {
        if let Some(id) = self.id.take() {
            self.shared.conns.close(id, "", "the connection task ended abnormally");
        }
        self.shared.connected_workers.fetch_sub(1, Ordering::Relaxed);
        ip_release(self.ip);
    }
}

/// Writes what a connection owes the database since its last flush: stale/rejected counts, the last share, where it
/// connects from. On the minute's tick, at the pool's stop and when the connection ends.
async fn flush_stats(shared: &Shared, sess: &mut Session, mode: Mode) {
    if let Some(f) = take_stats(sess, mode) {
        write_stats(shared, f).await;
    }
}

/// The minute's flush off the connection's loop: a slow database (a merge holding the miner's row, an outage) must
/// not stop the connection from reading shares and forwarding jobs.
fn flush_stats_bg(shared: &Arc<Shared>, sess: &mut Session, mode: Mode) {
    if let Some(f) = take_stats(sess, mode) {
        let shared = shared.clone();
        tokio::spawn(async move { write_stats(&shared, f).await });
    }
}

struct StatsFlush { miner_id: i64, worker: String, ip: String, mode: Mode, st: WorkerStats }

fn take_stats(sess: &mut Session, mode: Mode) -> Option<StatsFlush> {
    if sess.miner.is_empty() || sess.miner_id == 0 {
        return None;
    }
    Some(StatsFlush { miner_id: sess.miner_id, worker: sess.worker.clone(), ip: sess.peer.ip().to_string(), mode, st: std::mem::take(&mut sess.stats) })
}

async fn write_stats(shared: &Shared, f: StatsFlush) {
    let now = crate::state::now();
    if f.st.stale > 0 || f.st.rejected > 0 {
        let _ = shared.db.record_share_events(now, f.miner_id, &f.worker, f.mode.as_str(), f.st.stale, f.st.rejected).await;
    }
    if f.st.last_share > 0 {
        let _ = shared.db.touch_miner(f.miner_id, f.st.last_share).await;
    }
    let _ = shared.db.miner_seen(f.miner_id, &f.ip, &f.worker, now).await;
}

struct MinerJob {
    id: String,
    job: Arc<Job>,
    packed: u32,
    seen: HashSet<([u8; 8], [u8; 32])>,
}

struct Vardiff {
    diff: f64,
    /// lowest difficulty for this connection: vardiff.min, or nicehash_min for NiceHash's proxy
    floor: f64,
    shares: u32,
    since: Instant,
}

/// One miner connection, for the line logged when it ends: who it was, how long it lasted, what
/// it sent and why it closed. The connection fills it in; serve() logs it.
struct Session {
    /// also the connection's number in the nonce prefix and in the operator's list (crate::conns)
    id: u64,
    peer: std::net::SocketAddr,
    tls: bool,
    started: Instant,
    /// what the client sent first, without the values, for a connection that never logs in
    first: String,
    miner: String,
    worker: String,
    accepted: u64,
    stale: u64,
    rejected: u64,
    last_share: i64,
    miner_id: i64,
    /// what the next flush writes (stale/rejected since the last flush, the last share)
    stats: WorkerStats,
}

/// Copies a session's counters and difficulty to the operator's list of live connections.
fn sync(shared: &Shared, sess: &Session, diff: f64) {
    shared.conns.update(sess.id, |c| {
        c.accepted = sess.accepted;
        c.stale = sess.stale;
        c.rejected = sess.rejected;
        c.last_share = sess.last_share;
        c.diff = diff;
    });
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
pub fn address_type(a: &str) -> Option<&'static str> {
    // coinbase accounts (tools/coinbase): "cb:" + a public key (Beam's serialization: X then a Y byte of 00/01),
    // paid in the blocks themselves
    if let Some(pk) = a.strip_prefix("cb:") {
        return crate::coinbase::is_account_key(pk).then_some("coinbase");
    }
    let hex_like = a.len() >= 64 && a.len() <= 70 && a.chars().all(|c| c.is_ascii_hexdigit());
    if hex_like {
        return Some("regular");
    }
    if a.len() >= 100 && a.len() <= 600 && a.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Some("offline");
    }
    None
}

async fn connection<S: AsyncRead + AsyncWrite + Unpin + Send>(shared: Arc<Shared>, stream: S, mode: Mode, sess: &mut Session, kick: Arc<tokio::sync::Notify>) -> Result<()> {
    let (rd, mut wr) = tokio::io::split(stream);
    let mut lines = FramedRead::new(rd, LinesCodec::new_with_max_length(MAX_LINE));
    let mut job_rx = shared.job_tx.subscribe();
    let mut stop = shared.stopping.subscribe();

    let conn = sess.id;
    let node_prefix = shared.node_prefix.read().await.clone();
    let own_bytes = shared.cfg.stratum.nonce_prefix_bytes.min(6usize.saturating_sub(node_prefix.len() / 2));
    let own = hex::encode(&conn.to_be_bytes()[8 - own_bytes..]);
    let prefix = format!("{node_prefix}{own}");
    let prefix_bytes = hex::decode(&prefix).unwrap_or_default();

    let mut address = String::new();
    let mut worker = String::new();
    let mut miner_id: i64 = 0;
    let mut jobs: VecDeque<MinerJob> = VecDeque::new();
    let mut bad_in_row = 0u32;
    let mut seq = 0u64;
    let vd_cfg = &shared.cfg.vardiff;
    let mut vd = Vardiff { diff: vd_cfg.start, floor: vd_cfg.min, shares: 0, since: Instant::now() };
    let idle = Duration::from_secs(900);
    let mut flush = tokio::time::interval(Duration::from_secs(60));
    flush.tick().await;

    async fn send<W: AsyncWrite + Unpin>(wr: &mut W, v: Value) -> Result<()> {
        // a miner that stops reading must not hold this connection (and its slot) forever
        tokio::time::timeout(Duration::from_secs(10), wr.write_all(format!("{v}\n").as_bytes())).await.map_err(|_| anyhow::anyhow!("write timeout"))??;
        Ok(())
    }
    fn result(id: &Value, code: i64, desc: &str) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "method": "result", "code": code, "description": desc })
    }

    let mut deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        tokio::select! {
            // a deadline, not a timeout per select round: every job (several a minute) restarts the round, so a
            // per-round timeout never fired. 30 s to log in, then `idle` of silence (audit 2026-10-23)
            _ = tokio::time::sleep_until(deadline) => {
                if address.is_empty() { anyhow::bail!("no login in 30 s") } else { anyhow::bail!("silent for {} min", idle.as_secs() / 60) }
            }
            line = lines.next() => {
                // before the login nothing moves the 30 s (a blank line every 29 s must not hold a slot); once logged
                // in, every line restarts the idle limit (the login itself sets it below)
                if !address.is_empty() {
                    deadline = tokio::time::Instant::now() + idle;
                }
                let Some(line) = line else { return Ok(()) };
                let line = match line {
                    Ok(l) => l,
                    // binary where text lines are due: most often a TLS handshake on a plain port
                    Err(LinesCodecError::Io(e)) if e.kind() == std::io::ErrorKind::InvalidData => {
                        if sess.first.is_empty() {
                            sess.first = "binary data, not text".into();
                        }
                        anyhow::bail!("not text: TLS on a plain port, or a scanner")
                    }
                    Err(LinesCodecError::Io(e)) if e.kind() == std::io::ErrorKind::ConnectionReset => anyhow::bail!("reset by the other side"),
                    Err(LinesCodecError::Io(e)) => anyhow::bail!("read: {e}"),
                    Err(LinesCodecError::MaxLineLengthExceeded) => anyhow::bail!("a line over {} KB", MAX_LINE / 1024),
                };
                if line.trim().is_empty() { continue; }
                let msg: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => {
                        if address.is_empty() {
                            // only the first line: an HTTP request's later lines are headers, and one may
                            // carry a credential meant for somewhere else
                            if sess.first.is_empty() {
                                // control bytes shown as \xNN, so a binary probe reads as one and not as blank space
                                let shown: String = line.chars().take(60).map(|c| if c.is_control() { format!("\\x{:02x}", c as u32) } else { c.to_string() }).collect();
                                info!(peer = %sess.peer, line = %shown, "not JSON before login");
                                sess.first = format!("not JSON: {shown}");
                            }
                        }
                        send(&mut wr, result(&json!(""), -32000, "message corrupted")).await?;
                        continue;
                    }
                };
                if address.is_empty() {
                    // what a client sends before it is logged in, without the values: tells why an unknown
                    // client (a rental service's checker) fails to log in
                    let fields: Vec<&str> = msg.as_object().map(|o| o.keys().map(|k| k.as_str()).collect()).unwrap_or_default();
                    info!(peer = %sess.peer, method = %msg["method"], ?fields, id = %msg["id"], "message before login");
                    if sess.first.is_empty() {
                        let key = msg["api_key"].as_str().unwrap_or("");
                        sess.first = format!("{} {:?}; api_key {} ({} chars), agent {:?}", msg["method"], fields, crate::state::Short(key), key.len(), msg["agent"].as_str().unwrap_or(""));
                    }
                }
                // answered with the id exactly as sent: Beam miners use strings, other clients (NiceHash) may send numbers
                let id = msg.get("id").filter(|v| v.is_string() || v.is_number()).cloned().unwrap_or_else(|| json!(""));
                let id_str = match &id { Value::String(s) => s.clone(), v => v.to_string() };
                match msg["method"].as_str().unwrap_or("") {
                    "login" => {
                        let key = msg["api_key"].as_str().unwrap_or("").trim();
                        let (addr, wk) = match key.split_once('.') { Some((a, w)) => (a, w), None => (key, "default") };
                        let Some(kind) = address_type(addr) else {
                            send(&mut wr, result(&id, -32003, "Login failed: use <beam address>.<worker>; an offline address is recommended")).await?;
                            anyhow::bail!("login refused: {}", "Login failed: use <beam address>.<worker>; an offline address is recommended");
                        };
                        address = if kind == "coinbase" { addr.to_ascii_lowercase() } else { addr.to_string() };
                        if kind == "coinbase" && shared.coinbase.is_none() {
                            send(&mut wr, result(&id, -32003, "Login failed: this pool does not pay in the coinbase, use a Beam address")).await?;
                            anyhow::bail!("login refused: {}", "Login failed: this pool does not pay in the coinbase, use a Beam address");
                        }
                        // with coinbase payouts every template already pays the PPLNS accounts in its coinbase,
                        // so a block cannot go whole to a solo finder
                        if mode == Mode::Solo && shared.coinbase.is_some() {
                            send(&mut wr, result(&id, -32003, "Login failed: solo mining is not available while this pool pays in the coinbase, use the PPLNS port")).await?;
                            anyhow::bail!("login refused: {}", "Login failed: solo mining is not available while this pool pays in the coinbase, use the PPLNS port");
                        }
                        // `<worker>+<N>` asks for a starting and lowest difficulty N: a rented rig
                        // (MiningRigRentals) that will not work below its own minimum
                        let (wk, fixed) = worker_diff(wk);
                        if let Some(n) = fixed {
                            vd.floor = n.clamp(vd_cfg.min, vd_cfg.max);
                            vd.diff = vd.floor;
                        }
                        worker = wk.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(32).collect();
                        if worker.is_empty() { worker = "default".into(); }
                        let kind_label = if kind == "coinbase" { kind.to_string() } else { format!("{kind}?") };
                        miner_id = match shared.db.miner_id(&address, &kind_label, crate::state::now()).await {
                            Ok(id) => id,
                            Err(e) => { warn!("miner lookup: {e:#}"); send(&mut wr, result(&id, -32003, "Login failed: pool database unavailable, retry")).await?; anyhow::bail!("login refused: pool database unavailable"); }
                        };
                        let desc = match kind {
                            "regular" => "Login successful. Warning: regular addresses expire and need the wallet online; use an offline address for payouts",
                            "coinbase" => "Login successful: paid in the coinbase of the blocks (keep your pair stock topped up with bb-coinbase)",
                            _ => "Login successful",
                        };
                        let mut res = result(&id, 0, desc);
                        res["nonceprefix"] = json!(prefix);
                        res["forkheight"] = json!(FORK_HEIGHT);
                        res["forkheight2"] = json!(FORK_HEIGHT2);
                        send(&mut wr, res).await?;
                        sess.miner = address.clone();
                        sess.miner_id = miner_id;
                        // logged in: from now on the idle limit, not the 30 s login deadline (2026-10-23: miners whose
                        // first share took over 30 s were closed as "silent for 15 min")
                        deadline = tokio::time::Instant::now() + idle;
                        sess.worker = worker.clone();
                        let agent: String = msg["agent"].as_str().unwrap_or("").chars().take(64).collect();
                        if agent.to_ascii_lowercase().contains("nicehash") {
                            vd.floor = vd.floor.max(vd_cfg.nicehash_min);
                            vd.diff = vd.diff.max(vd.floor);
                        }
                        info!(peer = %sess.peer, miner = %crate::state::Short(&address), worker = %worker, mode = mode.as_str(), tls = sess.tls, %kind, %agent, diff = vd.diff, "login");
                        {
                            let (s, ip, w) = (shared.clone(), sess.peer.ip().to_string(), worker.clone());
                            tokio::spawn(async move { let _ = s.db.miner_seen(miner_id, &ip, &w, crate::state::now()).await; });
                        }
                        shared.conns.update(sess.id, |c| {
                            c.miner_id = miner_id;
                            c.miner = address.clone();
                            c.worker = worker.clone();
                            c.agent = agent.clone();
                            c.diff = vd.diff;
                        });
                        if let Some(job) = shared.current_job() {
                            seq += 1;
                            push_job(&mut wr, &mut jobs, &job, &mut seq, vd.diff).await?;
                        }
                    }
                    "solution" => {
                        if address.is_empty() { send(&mut wr, result(&id, -32003, "login first")).await?; continue; }
                        let Some(pos) = jobs.iter().position(|j| j.id == id_str) else {
                            send(&mut wr, result(&id, 3, "stale: job expired")).await?;
                            continue;
                        };
                        if let Some(cur) = shared.current_job() {
                            if jobs[pos].job.height < cur.height {
                                send(&mut wr, result(&id, 3, "stale: block already found")).await?;
                                sess.stats.stale += 1;
                                sess.stale += 1;
                                sync(&shared, sess, vd.diff);
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
                            sess.stats.rejected += 1;
                            sess.rejected += 1;
                            sync(&shared, sess, vd.diff);
                            continue;
                        }
                        let mj = &mut jobs[pos];
                        let mut packed = mj.packed;
                        let mut r = pow::check_share(&mj.job.input, &n, &out, packed);
                        // only a solution that verifies is remembered: garbage with fresh nonces would grow the set for the
                        // whole block time
                        if r == pow::BB_OK || r == pow::BB_ERR_DIFFICULTY {
                            mj.seen.insert((n, hash));
                        }
                        if r == pow::BB_ERR_DIFFICULTY && lenient != packed && pow::difficulty_reached(&hash, lenient) {
                            packed = lenient;
                            r = pow::BB_OK;
                        }
                        if r != pow::BB_OK {
                            bad_in_row += 1;
                            if bad_in_row >= 200 {
                                anyhow::bail!("200 rejected shares in a row");
                            }
                            send(&mut wr, result(&id, 2, &format!("rejected: {}", pow::result_str(r)))).await?;
                            warn!(miner = %crate::state::Short(&address), worker = %worker, reason = pow::result_str(r), "share rejected");
                            sess.stats.rejected += 1;
                            sess.rejected += 1;
                            sync(&shared, sess, vd.diff);
                            continue;
                        }
                        bad_in_row = 0;
                        sess.stats.accepted += 1;
                        sess.accepted += 1;
                        sess.stats.last_share = crate::state::now();
                        sess.last_share = sess.stats.last_share;
                        let share_diff = pow::difficulty_to_double(packed);
                        let job = mj.job.clone();
                        send(&mut wr, result(&id, 1, "accepted")).await?;
                        // queued for the share writer: a slow database no longer stalls this connection
                        let row = crate::state::ShareRow { ts: crate::state::now(), miner_id, worker: worker.clone(), mode: mode.as_str(), difficulty: share_diff, height: job.height as i64 };
                        // never wait here: a full queue (the database down for minutes) costs this share, not the
                        // connection (it would stop reading the miner and seeing jobs, kicks and the stop)
                        match shared.share_tx.try_send(crate::state::ShareMsg::Share(row)) {
                            Ok(()) => {}
                            Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                                let n = SHARES_DROPPED.fetch_add(1, Ordering::Relaxed) + 1;
                                if n == 1 || n % 1000 == 0 { tracing::error!(dropped = n, "share queue full: shares are being lost (database down?)"); }
                            }
                            Err(_) => warn!("share writer gone: share not recorded"),
                        }
                        if pow::difficulty_reached(&hash, job.net_packed) {
                            info!(miner = %crate::state::Short(&address), worker = %worker, height = job.height, "share reaches network difficulty, submitting block");
                            let _ = shared.submit_tx.send(Submit { job: job.clone(), nonce: n, output: out, miner_id, address: address.clone(), worker: worker.clone(), mode }).await;
                        }
                        sync(&shared, sess, vd.diff);
                        // vardiff: aim at one share per target_secs, adjust at most 4x per step
                        vd.shares += 1;
                        let el = vd.since.elapsed().as_secs_f64();
                        if vd.shares >= 8 || el > 90.0 {
                            // the worker finds shares at hashrate/diff per second; scale diff so that
                            // becomes one per target_secs
                            let want = vd.diff * (vd.shares as f64 * vd_cfg.target_secs / el.max(0.5));
                            let new = want.clamp(vd.diff / 4.0, vd.diff * 4.0).clamp(vd.floor, vd_cfg.max.max(vd.floor));
                            vd.shares = 0; vd.since = Instant::now();
                            if (new / vd.diff - 1.0).abs() > 0.25 {
                                vd.diff = new;
                                debug!(miner = %crate::state::Short(&address), worker = %worker, diff = new, "vardiff");
                                sync(&shared, sess, vd.diff);
                                if let Some(job) = shared.current_job() { push_job(&mut wr, &mut jobs, &job, &mut seq, vd.diff).await?; }
                            }
                        }
                    }
                    "" => send(&mut wr, result(&id, -32001, "unknown method")).await?,
                    other => { debug!(%other, "ignored method"); }
                }
            }
            _ = flush.tick() => {
                flush_stats_bg(&shared, sess, mode);
                // a worker that has not found a share in a long time has too high a difficulty
                if !address.is_empty() && vd.shares == 0 && vd.since.elapsed().as_secs_f64() > 6.0 * vd_cfg.target_secs && vd.diff > vd.floor {
                    vd.diff = (vd.diff / 4.0).max(vd.floor);
                    vd.since = Instant::now();
                    debug!(miner = %crate::state::Short(&address), worker = %worker, diff = vd.diff, "vardiff down: no shares");
                    sync(&shared, sess, vd.diff);
                    if let Some(job) = shared.current_job() { push_job(&mut wr, &mut jobs, &job, &mut seq, vd.diff).await?; }
                }
            }
            _ = kick.notified() => anyhow::bail!("ended by the operator"),
            // wait_for: also a connection accepted while the stop was already on ends at once
            _ = async { let _ = stop.wait_for(|v| *v).await; } => anyhow::bail!("pool restarting"),
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

/// Splits `rig1+8192` into the worker name and the difficulty it asks for; no `+`, or what follows
/// it not a positive number, leaves the name as it was and asks for nothing.
fn worker_diff(wk: &str) -> (&str, Option<f64>) {
    match wk.rsplit_once('+') {
        Some((name, n)) => match n.trim().parse::<f64>() {
            Ok(d) if d.is_finite() && d > 0.0 => (name, Some(d)),
            _ => (wk, None),
        },
        None => (wk, None),
    }
}

async fn push_job<S: AsyncWrite + Unpin>(wr: &mut WriteHalf<S>, jobs: &mut VecDeque<MinerJob>, job: &Arc<Job>, seq: &mut u64, diff: f64) -> Result<()> {
    *seq += 1;
    let id = seq.to_string();
    let packed = pow::pack_difficulty(diff);
    let msg = json!({ "jsonrpc": "2.0", "id": id, "method": "job", "input": hex::encode(job.input), "difficulty": packed, "height": job.height });
    tokio::time::timeout(Duration::from_secs(10), wr.write_all(format!("{msg}\n").as_bytes())).await.map_err(|_| anyhow::anyhow!("write timeout"))??;
    jobs.push_front(MinerJob { id, job: job.clone(), packed, seen: HashSet::new() });
    // templates come with every mempool change: keep every job of the current height (a valid share for an older
    // template at this height is still a share), at most 16; jobs of older heights are stale anyway
    while jobs.len() > 16 || jobs.back().is_some_and(|j| j.job.height < job.height) { jobs.pop_back(); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(height: u64) -> Arc<Job> {
        Arc::new(Job { upstream_id: format!("u{height}"), input: [0; 32], net_packed: 1, height, received: Instant::now() })
    }

    #[tokio::test]
    async fn jobs_of_the_current_height_are_kept() {
        let (a, _b) = tokio::io::duplex(1 << 20);
        let (_r, mut w) = tokio::io::split(a);
        let mut jobs = VecDeque::new();
        let mut seq = 0;
        for _ in 0..5 { push_job(&mut w, &mut jobs, &job(10), &mut seq, 64.0).await.unwrap(); }
        assert_eq!(jobs.len(), 5, "every template of height 10 (the old limit was 4)");
        for _ in 0..20 { push_job(&mut w, &mut jobs, &job(10), &mut seq, 64.0).await.unwrap(); }
        assert_eq!(jobs.len(), 16, "at most 16");
        push_job(&mut w, &mut jobs, &job(11), &mut seq, 64.0).await.unwrap();
        assert_eq!(jobs.len(), 1, "a new height drops the older ones");
        assert_eq!(jobs[0].job.height, 11);
    }

    use super::{proxy_header, worker_diff};

    #[test]
    fn worker_difficulty_suffix() {
        assert_eq!(worker_diff("mrr+8192"), ("mrr", Some(8192.0)));
        assert_eq!(worker_diff("+4096"), ("", Some(4096.0)));
        assert_eq!(worker_diff("rig1"), ("rig1", None));
        assert_eq!(worker_diff("rig+x"), ("rig+x", None));
        assert_eq!(worker_diff("rig+0"), ("rig+0", None));
        assert_eq!(worker_diff("rig+inf"), ("rig+inf", None));
    }

    #[tokio::test]
    async fn proxy_v1_header() {
        let mut rd: &[u8] = b"PROXY TCP4 95.24.1.2 65.109.125.69 51234 3443\r\n\x16\x03\x01";
        let peer = proxy_header(&mut rd).await.unwrap().unwrap();
        assert_eq!(peer.to_string(), "95.24.1.2:51234");
        assert_eq!(rd, b"\x16\x03\x01"); // the TLS hello stays unread
        let mut rd: &[u8] = b"PROXY TCP6 2a00::1 2a01::2 40000 3333\r\n";
        assert_eq!(proxy_header(&mut rd).await.unwrap().unwrap().to_string(), "[2a00::1]:40000");
        let mut rd: &[u8] = b"PROXY UNKNOWN\r\n";
        assert!(proxy_header(&mut rd).await.unwrap().is_none());
        let mut rd: &[u8] = b"{\"method\":\"login\"}\r\n";
        assert!(proxy_header(&mut rd).await.is_err());
        let mut rd: &[u8] = &[b'x'; 200];
        assert!(proxy_header(&mut rd).await.is_err());
    }
}

/// The one writer of accepted shares: batches what the connections queue (up to 2000 rows or 200 ms) into a
/// single INSERT; on a database error it keeps the batch and retries with a growing pause, so shares are delayed,
/// not lost (above 200 000 waiting rows the oldest go, with an error). Flush answers once all queued rows are in.
/// Shares lost because the queue was full (logged every 1000).
static SHARES_DROPPED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub async fn share_writer(shared: Arc<Shared>, mut rx: tokio::sync::mpsc::Receiver<crate::state::ShareMsg>) {
    use crate::state::ShareMsg;
    let mut buf: Vec<crate::state::ShareRow> = Vec::new();
    let mut waiters: Vec<tokio::sync::oneshot::Sender<()>> = Vec::new();
    let mut pause = Duration::from_millis(200);
    loop {
        if buf.is_empty() && waiters.is_empty() {
            match rx.recv().await {
                Some(ShareMsg::Share(r)) => buf.push(r),
                Some(ShareMsg::Flush(w)) => waiters.push(w),
                None => return,
            }
        }
        // gather for up to 200 ms (or until a flush is asked for)
        let until = tokio::time::Instant::now() + Duration::from_millis(200);
        while buf.len() < 2000 && waiters.is_empty() {
            match tokio::time::timeout_at(until, rx.recv()).await {
                Ok(Some(ShareMsg::Share(r))) => buf.push(r),
                Ok(Some(ShareMsg::Flush(w))) => waiters.push(w),
                Ok(None) | Err(_) => break,
            }
        }
        while let Ok(m) = rx.try_recv() {
            match m {
                ShareMsg::Share(r) => buf.push(r),
                ShareMsg::Flush(w) => waiters.push(w),
            }
        }
        let n = buf.len().min(20_000); // the batch is capped, the buffer is not (it is bounded below)
        match shared.db.record_shares(&buf[..n]).await {
            Ok(()) => {
                buf.drain(..n);
                pause = Duration::from_millis(200);
                if buf.is_empty() {
                    for w in waiters.drain(..) { let _ = w.send(()); }
                }
            }
            Err(e) => {
                warn!(queued = buf.len(), "recording shares failed, retrying: {e:#}");
                if buf.len() > 200_000 {
                    let drop = buf.len() - 200_000;
                    buf.drain(..drop);
                    tracing::error!(dropped = drop, "share queue over 200 000 rows: the oldest shares are lost");
                }
                tokio::time::sleep(pause).await;
                pause = (pause * 2).min(Duration::from_secs(10));
            }
        }
    }
}
