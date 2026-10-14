//! Runs one miner process at a time and reads its output, as the Mac app does.
//! GPU: bundled MXBM (CUDA on NVIDIA, OpenCL elsewhere). CPU: the console miner bumblebeam-miner.
//! The miner writes to a pseudo-terminal (ConPTY on Windows): into a pipe its C library buffers
//! whole blocks, so shares and speed would reach the window minutes late. The terminal is also
//! the miner's controlling terminal, so on Linux the miner gets SIGHUP if the app dies; on
//! Windows a job object kills it with the app. ConPTY asks for the cursor position (ESC[6n) as
//! it starts and holds all output until it gets an answer, so the app answers it.

use crate::settings::{Device, Mode, Settings};
use portable_pty::{native_pty_system, Child, CommandBuilder, PtySize};
use regex::Regex;
use serde::Serialize;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const STRATUM_HOST: &str = "stratum.bumblebeam.org";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", content = "why", rename_all = "camelCase")]
pub enum State {
    Stopped,
    Starting,
    Mining,
    NoConnection(String),
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub state: State,
    pub rate: f64,
    pub accepted: u64,
    pub rejected: u64,
    pub history: Vec<f64>,
    pub started_at: Option<u64>,
    pub pid: Option<u32>,
}

struct Inner {
    state: State,
    rate: f64,
    accepted: u64,
    rejected: u64,
    history: Vec<f64>,
    started_at: Option<u64>,
    last_line: String,
    user_stopped: bool,
    child: Option<Box<dyn Child + Send + Sync>>,
    pid: Option<u32>,
    /// what earlier runs of this session counted (bumblebeam-miner counts from zero per run)
    counted_before: (u64, u64),
    /// the extra environment for the next launch (GPU load limit)
    env: Vec<(String, String)>,
}

pub struct Miner {
    inner: Mutex<Inner>,
    /// bumped at every launch and stop: output and exits of a replaced process are dropped
    generation: AtomicU64,
    bin_dir: PathBuf,
    work_dir: PathBuf,
    log_path: PathBuf,
}

pub fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn cpu_threads() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4)
}

pub fn threads_for_power(p: u32) -> usize {
    ((cpu_threads() as f64 * p as f64 / 100.0).round() as usize).max(1)
}

impl Miner {
    pub fn new(bin_dir: PathBuf, work_dir: PathBuf, log_dir: PathBuf) -> Arc<Miner> {
        let _ = std::fs::create_dir_all(&work_dir);
        let _ = std::fs::create_dir_all(&log_dir);
        Arc::new(Miner {
            inner: Mutex::new(Inner {
                state: State::Stopped,
                rate: 0.0,
                accepted: 0,
                rejected: 0,
                history: Vec::new(),
                started_at: None,
                last_line: String::new(),
                user_stopped: true,
                child: None,
                pid: None,
                counted_before: (0, 0),
                env: Vec::new(),
            }),
            generation: AtomicU64::new(0),
            bin_dir,
            work_dir,
            log_path: log_dir.join("miner.log"),
        })
    }

    pub fn bin(&self, name: &str) -> PathBuf {
        self.bin_dir.join(if cfg!(windows) { format!("{name}.exe") } else { name.to_string() })
    }

    pub fn snapshot(&self) -> Snapshot {
        let i = self.inner.lock().unwrap();
        Snapshot {
            state: i.state.clone(),
            rate: if i.state == State::Stopped { 0.0 } else { i.rate },
            accepted: i.accepted,
            rejected: i.rejected,
            history: i.history.clone(),
            started_at: i.started_at,
            pid: i.pid,
        }
    }

    pub fn running(&self) -> bool {
        self.inner.lock().unwrap().state != State::Stopped
    }

    /// Extra environment for the next launch (the GPU load limit when no power limit is possible).
    pub fn set_env(&self, env: Vec<(String, String)>) {
        self.inner.lock().unwrap().env = env;
    }

    pub fn start(self: &Arc<Self>, s: &Settings) {
        if !s.configured() {
            return;
        }
        self.kill_child();
        {
            let mut i = self.inner.lock().unwrap();
            i.user_stopped = false;
            i.accepted = 0;
            i.rejected = 0;
            i.rate = 0.0;
            i.history.clear();
            i.counted_before = (0, 0);
            i.started_at = Some(now_unix());
        }
        self.launch(s);
    }

    pub fn stop(&self) {
        {
            let mut i = self.inner.lock().unwrap();
            i.user_stopped = true;
            i.state = State::Stopped;
            i.rate = 0.0;
            i.started_at = None;
        }
        self.kill_child();
    }

    /// Settings that change the command line restart it.
    pub fn restart_if_running(self: &Arc<Self>, s: &Settings) {
        if !self.running() {
            return;
        }
        self.kill_child();
        {
            let mut i = self.inner.lock().unwrap();
            i.rate = 0.0;
            i.history.clear();
            i.state = State::Starting;
        }
        // the old miner lets go of its memory (7 GB for the CPU one) before the new one starts
        let me = self.clone();
        let s = s.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1500));
            if !me.inner.lock().unwrap().user_stopped {
                me.launch(&s);
            }
        });
    }

    fn kill_child(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        let child = {
            let mut i = self.inner.lock().unwrap();
            i.pid = None;
            i.child.take()
        };
        if let Some(mut c) = child {
            let _ = c.kill();
            let _ = c.wait();
        }
    }

    fn launch(self: &Arc<Self>, s: &Settings) {
        let gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let port = if s.mode == Mode::Solo { 3444 } else { 3443 };
        let user = format!("{}.{}", s.address.trim(), s.clean_worker());
        let pool = format!("{STRATUM_HOST}:{port}");
        let mut cmd;
        match s.device {
            Device::Gpu => {
                cmd = CommandBuilder::new(self.bin("mxbm"));
                cmd.args(["--algo", "BEAM-III", "--pool", &pool, "--tls", "1", "--user", &user]);
            }
            Device::Cpu => {
                cmd = CommandBuilder::new(self.bin("bumblebeam-miner"));
                let threads = threads_for_power(s.power).to_string();
                cmd.args(["mine", "--pool", &pool, "--tls", "1", "--user", &user, "--threads", &threads]);
            }
        }
        cmd.cwd(&self.work_dir);
        cmd.env("NO_COLOR", "1");
        let env = {
            let mut i = self.inner.lock().unwrap();
            i.counted_before = (i.accepted, i.rejected);
            i.last_line.clear();
            i.env.clone()
        };
        if s.device == Device::Gpu {
            for (k, v) in &env {
                cmd.env(k, v);
            }
        }

        let mut log = open_log(&self.log_path);
        let _ = writeln!(log, "\n=== {} {:?} power {}% ===", now_unix(), s.device, s.power);

        let pty = native_pty_system();
        let pair = match pty.openpty(PtySize { rows: 50, cols: 220, pixel_width: 0, pixel_height: 0 }) {
            Ok(p) => p,
            Err(e) => return self.retry(gen, format!("Could not start the miner: {e}"), s.clone()),
        };
        let child = match pair.slave.spawn_command(cmd) {
            Ok(c) => c,
            Err(e) => return self.retry(gen, format!("Could not start the miner: {e}"), s.clone()),
        };
        drop(pair.slave);
        let pid = child.process_id();
        #[cfg(windows)]
        if let Some(p) = pid {
            crate::power::kill_with_app(p);
        }
        let reader = match pair.master.try_clone_reader() {
            Ok(r) => r,
            Err(e) => return self.retry(gen, format!("Could not read the miner: {e}"), s.clone()),
        };
        let writer = pair.master.take_writer().ok();
        {
            let mut i = self.inner.lock().unwrap();
            i.child = Some(child);
            i.pid = pid;
            i.state = State::Starting;
        }

        // output
        let me = self.clone();
        let master = pair.master; // kept alive with the reader: dropping it hangs up the miner
        std::thread::spawn(move || {
            let _master = master;
            me.read_output(gen, reader, writer, log);
        });
        // exit
        let me = self.clone();
        let s2 = s.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(500));
            if me.generation.load(Ordering::SeqCst) != gen {
                return;
            }
            let status = {
                let mut i = me.inner.lock().unwrap();
                match i.child.as_mut().map(|c| c.try_wait()) {
                    Some(Ok(Some(st))) => Some(format!("code {}", st.exit_code())),
                    Some(Err(e)) => Some(e.to_string()),
                    _ => None,
                }
            };
            if let Some(code) = status {
                let why = {
                    let mut i = me.inner.lock().unwrap();
                    i.child = None;
                    i.pid = None;
                    i.rate = 0.0;
                    if i.user_stopped {
                        i.state = State::Stopped;
                        return;
                    }
                    if i.last_line.is_empty() { format!("The miner stopped ({code})") } else { i.last_line.clone() }
                };
                me.retry(gen, why, s2);
                return;
            }
        });
    }

    /// Something went wrong before or after the miner ran: say so and try again in 10 s.
    fn retry(self: &Arc<Self>, gen: u64, why: String, s: Settings) {
        self.inner.lock().unwrap().state = State::NoConnection(format!("{why}. Retrying in 10 s"));
        let me = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(10));
            let go = {
                let i = me.inner.lock().unwrap();
                !i.user_stopped && i.child.is_none() && me.generation.load(Ordering::SeqCst) == gen
            };
            if go {
                me.launch(&s);
            }
        });
    }

    fn read_output(&self, gen: u64, mut reader: Box<dyn Read + Send>, mut writer: Option<Box<dyn Write + Send>>, mut log: Log) {
        let mut buf = [0u8; 4096];
        let mut line: Vec<u8> = Vec::new();
        let mut tail: Vec<u8> = Vec::new(); // the last bytes read, for a query split across reads
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => return,
                Ok(n) => n,
            };
            // the terminal's cursor position query: answered, or ConPTY shows nothing more
            tail.extend_from_slice(&buf[..n]);
            if tail.windows(4).any(|w| w == b"\x1b[6n") {
                if let Some(w) = writer.as_mut() {
                    let _ = w.write_all(b"\x1b[1;1R");
                    let _ = w.flush();
                }
                tail.clear();
            } else if tail.len() > 3 {
                tail.drain(..tail.len() - 3);
            }
            log.write_all_rotating(&buf[..n], &self.log_path);
            if self.generation.load(Ordering::SeqCst) != gen {
                continue; // a replaced process: kept in the log, not in the window
            }
            for &b in &buf[..n] {
                if b == b'\n' || b == b'\r' {
                    if !line.is_empty() {
                        let s = strip_ansi(&String::from_utf8_lossy(&line));
                        let s = s.trim();
                        if !s.is_empty() {
                            self.parse(s);
                        }
                        line.clear();
                    }
                } else if line.len() < 4096 {
                    line.push(b);
                }
            }
        }
    }

    fn parse(&self, line: &str) {
        static SOL: OnceLock<Regex> = OnceLock::new();
        static ARS: OnceLock<Regex> = OnceLock::new();
        let sol = SOL.get_or_init(|| Regex::new(r"([0-9]+(?:\.[0-9]+)?)\s*sol/s").unwrap());
        let ars = ARS.get_or_init(|| Regex::new(r"A/R/S (\d+)/(\d+)/(\d+)").unwrap());
        let l = line.to_lowercase();
        let mut i = self.inner.lock().unwrap();
        if let Some(rest) = line.find("Average speed").map(|p| &line[p..]) {
            // MXBM: "Average speed (15s): 10.40 sol/s"
            if let Some(c) = sol.captures(rest) {
                push_rate(&mut i, c[1].parse().unwrap_or(0.0));
            }
        } else if l.starts_with("share accepted") {
            i.accepted += 1;
            i.state = State::Mining;
        } else if l.starts_with("share rejected") {
            i.rejected += 1;
        } else if l.contains("authorized worker") || l.contains("logged in") {
            i.state = State::Mining;
        } else if ["connection lost", "reconnect", "could not connect", "connection refused", "unauthorized"]
            .iter()
            .any(|k| l.contains(k))
        {
            i.state = State::NoConnection(line.to_string());
        }
        // bumblebeam-miner: "31 s | 0.388 sol/s | 8 runs ... | shares A/R/S 0/0/0 | ..."
        if line.contains("sol/s |") {
            if let Some(c) = line.split('|').nth(1).and_then(|p| sol.captures(p)) {
                push_rate(&mut i, c[1].parse().unwrap_or(0.0));
            }
            if let Some(c) = ars.captures(line) {
                let a: u64 = c[1].parse().unwrap_or(0);
                let r: u64 = c[2].parse::<u64>().unwrap_or(0) + c[3].parse::<u64>().unwrap_or(0);
                i.accepted = i.counted_before.0 + a;
                i.rejected = i.counted_before.1 + r;
            }
            if !matches!(i.state, State::NoConnection(_)) {
                i.state = State::Mining;
            }
        }
        if !line.starts_with("Share") && !line.contains("sol/s") && !line.contains("Found a share") {
            i.last_line = line.chars().take(200).collect();
        }
    }
}

fn push_rate(i: &mut Inner, r: f64) {
    i.rate = r;
    i.history.push(r);
    let n = i.history.len();
    if n > 60 {
        i.history.drain(0..n - 60);
    }
}

pub fn strip_ansi(s: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07").unwrap())
        .replace_all(s, "")
        .into_owned()
}

/// The miner log: kept under 5 MB while mining, the one before moved to miner.1.log.
pub struct Log {
    file: Option<std::fs::File>,
    bytes: u64,
    since_check: Instant,
}

fn open_log(path: &PathBuf) -> Log {
    let file = std::fs::OpenOptions::new().create(true).append(true).open(path).ok();
    let bytes = file.as_ref().and_then(|f| f.metadata().ok()).map(|m| m.len()).unwrap_or(0);
    Log { file, bytes, since_check: Instant::now() }
}

impl Write for Log {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        if let Some(f) = self.file.as_mut() {
            let n = f.write(b)?;
            self.bytes += n as u64;
            return Ok(n);
        }
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.file.as_mut().map_or(Ok(()), |f| f.flush())
    }
}

impl Log {
    fn write_all_rotating(&mut self, b: &[u8], path: &PathBuf) {
        let _ = self.write_all(b);
        if self.bytes > 5_000_000 && self.since_check.elapsed() > Duration::from_secs(1) {
            self.since_check = Instant::now();
            self.file = None;
            let old = path.with_file_name("miner.1.log");
            let _ = std::fs::remove_file(&old);
            let _ = std::fs::rename(path, &old);
            *self = open_log(path);
        }
    }
}
