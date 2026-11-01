//! Live stratum connections and the recent ones that ended before a login, for the operator's
//! dashboard: who is mining right now (address, worker, agent, port, difficulty, shares) and why
//! a client that never logged in went away (a rental service's checker, a TLS mismatch, a bad
//! address). The operator can also end a connection.

use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

/// Connections that ended before a login, newest first, kept in memory only.
const RECENT_MAX: usize = 300;

pub struct Conn {
    pub peer: SocketAddr,
    pub port: u16,
    pub mode: &'static str,
    pub tls: bool,
    pub started: i64,
    pub miner_id: i64,
    pub miner: String,
    pub worker: String,
    pub agent: String,
    pub diff: f64,
    pub accepted: u64,
    pub stale: u64,
    pub rejected: u64,
    pub last_share: i64,
    pub kick: Arc<Notify>,
}

#[derive(Default)]
pub struct Conns {
    live: Mutex<HashMap<u64, Conn>>,
    recent: Mutex<VecDeque<Value>>,
}

impl Conns {
    pub fn open(&self, id: u64, peer: SocketAddr, port: u16, mode: &'static str, tls: bool) -> Arc<Notify> {
        let kick = Arc::new(Notify::new());
        let c = Conn {
            peer, port, mode, tls, started: crate::state::now(), miner_id: 0, miner: String::new(), worker: String::new(), agent: String::new(),
            diff: 0.0, accepted: 0, stale: 0, rejected: 0, last_share: 0, kick: kick.clone(),
        };
        self.live.lock().unwrap().insert(id, c);
        kick
    }

    pub fn update(&self, id: u64, f: impl FnOnce(&mut Conn)) {
        if let Some(c) = self.live.lock().unwrap().get_mut(&id) {
            f(c);
        }
    }

    /// The connection is gone; one that never logged in goes to the recent list with `first` (what
    /// it sent first, if anything) and `reason`.
    pub fn close(&self, id: u64, first: &str, reason: &str) {
        let Some(c) = self.live.lock().unwrap().remove(&id) else { return };
        if c.miner.is_empty() {
            let mut r = self.recent.lock().unwrap();
            r.push_front(json!({
                "ts": crate::state::now(), "started": c.started, "peer": c.peer.to_string(), "port": c.port, "mode": c.mode, "tls": c.tls,
                "first": if first.is_empty() { "nothing" } else { first }, "reason": reason,
            }));
            r.truncate(RECENT_MAX);
        }
    }

    /// Ends the connection `id`; false if there is none.
    pub fn kick(&self, id: u64) -> bool {
        match self.live.lock().unwrap().get(&id) {
            Some(c) => {
                c.kick.notify_one();
                true
            }
            None => false,
        }
    }

    /// Ends every connection of a miner; returns how many.
    pub fn kick_miner(&self, miner_id: i64) -> usize {
        let g = self.live.lock().unwrap();
        let mut n = 0;
        for c in g.values().filter(|c| c.miner_id == miner_id) {
            c.kick.notify_one();
            n += 1;
        }
        n
    }

    pub fn count_miner(&self, miner_id: i64) -> usize {
        self.live.lock().unwrap().values().filter(|c| c.miner_id == miner_id).count()
    }

    /// Live connections, logged-in ones first, then by start time; `miner_id` narrows to one miner.
    pub fn live(&self, miner_id: Option<i64>) -> Vec<Value> {
        let g = self.live.lock().unwrap();
        let mut v: Vec<(&u64, &Conn)> = g.iter().filter(|(_, c)| miner_id.map_or(true, |m| c.miner_id == m)).collect();
        v.sort_by_key(|(id, c)| (c.miner.is_empty(), c.started, **id));
        v.into_iter()
            .map(|(id, c)| {
                json!({
                    "id": id, "peer": c.peer.to_string(), "port": c.port, "mode": c.mode, "tls": c.tls, "started": c.started,
                    "minerId": c.miner_id, "miner": c.miner, "worker": c.worker, "agent": c.agent, "diff": c.diff,
                    "accepted": c.accepted, "stale": c.stale, "rejected": c.rejected, "lastShare": c.last_share,
                })
            })
            .collect()
    }

    pub fn recent(&self) -> Vec<Value> {
        self.recent.lock().unwrap().iter().cloned().collect()
    }
}
