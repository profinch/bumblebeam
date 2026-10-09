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
}

impl Shared {
    pub fn current_job(&self) -> Option<Arc<Job>> {
        self.job_tx.borrow().clone()
    }
    pub fn next_conn(&self) -> u64 {
        self.conn_seq.fetch_add(1, Ordering::Relaxed) + 1
    }
    /// Chain tip as the node sees it: jobs are for the next block.
    pub fn tip_height(&self) -> Option<u64> {
        self.current_job().map(|j| j.height.saturating_sub(1))
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
