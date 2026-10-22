//! State shared between the upstream client, the stratum servers, accounting and the API.

use crate::config::Config;
use crate::db::Db;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{mpsc, watch, RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Pplns,
    Solo,
}
impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Pplns => "pplns",
            Mode::Solo => "solo",
        }
    }
}

/// A block template from the node: the PoW input, the network difficulty and the height.
#[derive(Debug)]
pub struct Job {
    pub upstream_id: String,
    pub input: [u8; 32],
    pub net_packed: u32,
    pub height: u64,
    pub received: Instant,
}

/// A share that reaches the network difficulty, on its way to the node.
#[derive(Debug)]
pub struct Submit {
    pub job: Arc<Job>,
    pub nonce: [u8; 8],
    pub output: [u8; 104],
    pub miner_id: i64,
    pub address: String,
    pub worker: String,
    pub mode: Mode,
}

/// An accepted share on its way to the database (crate::stratum::share_writer).
pub struct ShareRow {
    pub ts: i64,
    pub miner_id: i64,
    pub worker: String,
    pub mode: &'static str,
    pub difficulty: f64,
    pub height: i64,
}

pub enum ShareMsg {
    Share(ShareRow),
    /// write what is queued now and answer (before a block is credited, at shutdown)
    Flush(tokio::sync::oneshot::Sender<()>),
}

/// Which half of the pool this process runs (docs/pool-split.md): both, the stratum half, or the app half.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    All,
    Stratum,
    App,
}
impl Role {
    pub fn stratum(self) -> bool { self != Role::App }
    pub fn app(self) -> bool { self != Role::Stratum }
    pub fn as_str(self) -> &'static str {
        match self { Role::All => "all", Role::Stratum => "stratum", Role::App => "app" }
    }
}

/// The node's current template as the app half needs it (height, difficulty, how old): from the job in
/// this process, or from the `node_job` meta row the stratum process writes (crate::upstream).
#[derive(Debug, Clone, Copy)]
pub struct NodeView {
    pub height: u64,
    pub net_packed: u32,
    /// unix seconds when the stratum process got it
    pub at: i64,
}

pub struct Shared {
    pub cfg: Arc<Config>,
    pub db: Db,
    pub job_tx: watch::Sender<Option<Arc<Job>>>,
    pub submit_tx: mpsc::Sender<Submit>,
    /// The operator's "pay now", answered by the payout loop (crate::payouts).
    pub payout_tx: mpsc::Sender<crate::payouts::PayNow>,
    /// Nonce prefix the node assigned to the pool's own stratum login (hex, may be empty).
    pub node_prefix: RwLock<String>,
    pub conn_seq: AtomicU64,
    pub connected_workers: AtomicU64,
    /// Live stratum connections and recent failed ones, for the operator.
    pub conns: crate::conns::Conns,
    /// Network height from the explorer cache (0 = unknown); jobs far below it mean the node is syncing.
    pub net_height: AtomicU64,
    /// When the next scheduled payout run is due (unix seconds; 0 while payouts are off).
    pub next_payout: std::sync::atomic::AtomicI64,
    /// Seconds left on the payout countdown while the operator has frozen it; -1 when it runs.
    pub payouts_frozen_left: std::sync::atomic::AtomicI64,
    pub started: Instant,
    pub http: reqwest::Client,
    /// The link to bb-finalizer when coinbase payouts are enabled.
    pub coinbase: Option<Arc<crate::coinbase::Link>>,
    /// Set on SIGTERM / SIGINT (main.rs): the stratum listeners stop accepting, every connection flushes its
    /// counters and closes, and the process exits once no payout is in progress.
    pub stopping: watch::Sender<bool>,
    /// Held by the payout loop while it talks to the wallet, so a shutdown never cuts a payout in half.
    pub paying: tokio::sync::Mutex<()>,
    /// Accepted shares go to the database through one writer task in batches, so a slow database never
    /// stalls a miner's connection (crate::stratum::share_writer).
    pub share_tx: mpsc::Sender<ShareMsg>,
    pub role: Role,
    /// the node view read from the database by an app-only process (crate::main::node_view_loop)
    pub node_cache: std::sync::RwLock<Option<NodeView>>,
    /// Found blocks being credited right now (accounting::credit_found); a shutdown waits for them.
    pub crediting: AtomicU64,
}

impl Shared {
    /// Waits (at most `secs`) until every share queued so far is in the database.
    pub async fn flush_shares(&self, secs: u64) -> bool {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if self.share_tx.send(ShareMsg::Flush(tx)).await.is_err() {
            return false;
        }
        matches!(tokio::time::timeout(std::time::Duration::from_secs(secs), rx).await, Ok(Ok(())))
    }

    pub fn current_job(&self) -> Option<Arc<Job>> {
        self.job_tx.borrow().clone()
    }
    pub fn next_conn(&self) -> u64 {
        self.conn_seq.fetch_add(1, Ordering::Relaxed) + 1
    }
    /// The node's template: this process's job, else (app-only) the stratum process's last one, if under 2 min old.
    pub fn node_view(&self) -> Option<NodeView> {
        if let Some(j) = self.current_job() {
            return Some(NodeView { height: j.height, net_packed: j.net_packed, at: now() - j.received.elapsed().as_secs() as i64 });
        }
        if self.role == Role::App {
            return self.node_cache.read().unwrap().filter(|v| now() - v.at < 120);
        }
        None
    }
    /// Chain tip as the node sees it: jobs are for the next block.
    pub fn tip_height(&self) -> Option<u64> {
        self.node_view().map(|v| v.height.saturating_sub(1))
    }
}

/// A Beam address shortened for logs: offline addresses are hundreds of characters long, and the
/// full one is in the database. `Short(&address)` prints the first 10 and the last 6.
pub struct Short<'a>(pub &'a str);
impl std::fmt::Display for Short<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let a = self.0;
        if a.len() > 20 && a.is_ascii() { write!(f, "{}…{}", &a[..10], &a[a.len() - 6..]) } else { f.write_str(a) }
    }
}

pub fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}
