//! Stratum client in Beam's dialect (newline JSON: login, job, solution, result), as the Beam node
//! and every Beam pool speak it. TLS is on by default because pools default to it; the pool's
//! certificate is not verified, like other Beam miners do.

use crate::{pow, Solver};
use anyhow::{anyhow, Context, Result};
use rand::RngCore;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
struct Job { id: String, input: Vec<u8>, difficulty: u32, height: u64 }

#[derive(Default)]
struct State { job: Option<Job>, prefix: Vec<u8>, accepted: u64, rejected: u64, stale: u64, last_result: String }

#[derive(Debug)]
struct NoVerify(rustls::crypto::CryptoProvider);
impl rustls::client::danger::ServerCertVerifier for NoVerify {
    fn verify_server_cert(&self, _: &rustls_pki_types::CertificateDer<'_>, _: &[rustls_pki_types::CertificateDer<'_>], _: &rustls_pki_types::ServerName<'_>, _: &[u8], _: rustls_pki_types::UnixTime) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(&self, m: &[u8], c: &rustls_pki_types::CertificateDer<'_>, d: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(m, c, d, &self.0.signature_verification_algorithms)
    }
    fn verify_tls13_signature(&self, m: &[u8], c: &rustls_pki_types::CertificateDer<'_>, d: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(m, c, d, &self.0.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> { self.0.signature_verification_algorithms.supported_schemes() }
}

enum Stream { Plain(TcpStream), Tls(rustls::StreamOwned<rustls::ClientConnection, TcpStream>) }
impl Read for Stream {
    fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> { match self { Stream::Plain(s) => s.read(b), Stream::Tls(s) => s.read(b) } }
}
impl Write for Stream {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> { match self { Stream::Plain(s) => s.write(b), Stream::Tls(s) => s.write(b) } }
    fn flush(&mut self) -> std::io::Result<()> { match self { Stream::Plain(s) => s.flush(), Stream::Tls(s) => s.flush() } }
}

fn connect(addr: &str, tls: bool) -> Result<Stream> {
    let tcp = TcpStream::connect(addr).with_context(|| format!("connect {addr}"))?;
    tcp.set_nodelay(true)?;
    tcp.set_read_timeout(Some(Duration::from_millis(100)))?;
    if !tls { return Ok(Stream::Plain(tcp)); }
    let provider = rustls::crypto::ring::default_provider();
    let cfg = rustls::ClientConfig::builder_with_provider(Arc::new(provider.clone())).with_safe_default_protocol_versions()?
        .dangerous().with_custom_certificate_verifier(Arc::new(NoVerify(provider))).with_no_client_auth();
    let host = addr.rsplit_once(':').map(|(h, _)| h).unwrap_or(addr).to_string();
    let name = rustls_pki_types::ServerName::try_from(host).unwrap_or_else(|_| rustls_pki_types::ServerName::try_from("pool").unwrap());
    let conn = rustls::ClientConnection::new(Arc::new(cfg), name)?;
    Ok(Stream::Tls(rustls::StreamOwned::new(conn, tcp)))
}

/// Mine against a pool until killed: login, solve the current job with fresh nonces, submit every
/// solution that reaches the share difficulty, print a line of stats every 30 s.
pub fn mine(pool: &str, user: &str, tls: bool) -> Result<()> {
    let state = Arc::new(Mutex::new(State::default()));
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    {
        let state = state.clone();
        let (pool, user) = (pool.to_string(), user.to_string());
        std::thread::spawn(move || loop {
            match connect(&pool, tls) {
                Ok(stream) => {
                    eprintln!("connected to {pool} (tls {tls})");
                    if let Err(e) = session(stream, &state, &user, &rx) { eprintln!("connection lost: {e:#}"); }
                }
                Err(e) => eprintln!("{e:#}"),
            }
            state.lock().unwrap().job = None;
            std::thread::sleep(Duration::from_secs(5));
        });
    }
    let mut solver = Solver::default();
    let mut rng = rand::thread_rng();
    let (mut runs, mut sols) = (0u64, 0u64);
    let t0 = Instant::now();
    let mut last_report = Instant::now();
    loop {
        let (job, prefix) = { let st = state.lock().unwrap(); (st.job.clone(), st.prefix.clone()) };
        let Some(job) = job else { std::thread::sleep(Duration::from_millis(200)); continue };
        let mut nonce = [0u8; 8];
        rng.fill_bytes(&mut nonce);
        let n = prefix.len().min(8);
        nonce[..n].copy_from_slice(&prefix[..n]);
        let extra = rng.next_u32().to_le_bytes();
        let t = Instant::now();
        let (found, _) = solver.solve(&job.input, &nonce, &extra);
        runs += 1;
        sols += found.len() as u64;
        for s in &found {
            if pow::difficulty_reached(&pow::solution_hash(s), job.difficulty) {
                let msg = json!({ "jsonrpc": "2.0", "id": job.id, "method": "solution", "nonce": hex::encode(nonce), "output": hex::encode(s) });
                let _ = tx.send(msg.to_string());
            }
        }
        if last_report.elapsed() >= Duration::from_secs(30) {
            let st = state.lock().unwrap();
            let el = t0.elapsed().as_secs_f64();
            eprintln!("{:>6.0} s | {:.3} sol/s | {} runs, last {:.2} s | shares A/R/S {}/{}/{} | job {} h{} diff {:.0} | {}",
                el, sols as f64 / el, runs, t.elapsed().as_secs_f64(), st.accepted, st.rejected, st.stale, job.id, job.height, pow::difficulty_to_double(job.difficulty), st.last_result);
            last_report = Instant::now();
        }
    }
}

fn session(stream: Stream, state: &Arc<Mutex<State>>, user: &str, rx: &std::sync::mpsc::Receiver<String>) -> Result<()> {
    let mut reader = BufReader::new(stream);
    let login = json!({ "jsonrpc": "2.0", "id": "login", "method": "login", "api_key": user });
    reader.get_mut().write_all(format!("{login}\n").as_bytes())?;
    let mut line = String::new();
    let mut idle = Instant::now();
    loop {
        while let Ok(msg) = rx.try_recv() {
            reader.get_mut().write_all(format!("{msg}\n").as_bytes())?;
        }
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => return Err(anyhow!("server closed the connection")),
            Ok(_) => {
                idle = Instant::now();
                let v: Value = match serde_json::from_str(&line) { Ok(v) => v, Err(_) => continue };
                let mut st = state.lock().unwrap();
                match v["method"].as_str().unwrap_or("") {
                    "result" if v["id"] == "login" => {
                        if v["code"].as_i64() != Some(0) { return Err(anyhow!("login refused: {} {}", v["code"], v["description"])); }
                        st.prefix = hex::decode(v["nonceprefix"].as_str().unwrap_or("")).unwrap_or_default();
                        eprintln!("logged in, nonce prefix {:?}: {}", v["nonceprefix"].as_str().unwrap_or(""), v["description"].as_str().unwrap_or(""));
                    }
                    "job" => {
                        let input = hex::decode(v["input"].as_str().unwrap_or("")).unwrap_or_default();
                        if input.len() == 32 {
                            st.job = Some(Job { id: v["id"].as_str().unwrap_or("").to_string(), input, difficulty: v["difficulty"].as_u64().unwrap_or(0) as u32, height: v["height"].as_u64().unwrap_or(0) });
                        }
                    }
                    "result" => {
                        let code = v["code"].as_i64().unwrap_or(-1);
                        let desc = v["description"].as_str().unwrap_or("").to_string();
                        match code { 1 => st.accepted += 1, 3 => st.stale += 1, _ => st.rejected += 1 }
                        st.last_result = format!("{code} {desc}");
                        eprintln!("share {}: {desc}", if code == 1 { "accepted" } else { "rejected" });
                    }
                    "cancel" => st.job = None,
                    _ => {}
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {
                if idle.elapsed() > Duration::from_secs(900) { return Err(anyhow!("no message from the pool for 15 minutes")); }
            }
            Err(e) => return Err(e.into()),
        }
    }
}
