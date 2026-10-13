//! What the pool says: balances, this worker's rate, blocks, the network for the daily estimate.
//! The same API calls as the Mac app (pool/API.md).

use crate::settings::Settings;
use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const BASE: &str = "https://pool.bumblebeam.org";

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolView {
    /// BEAM
    pub balance: Option<f64>,
    pub immature: Option<f64>,
    /// sol/s the pool sees for this worker (its 10-minute average)
    pub worker_rate: Option<f64>,
    pub blocks_total: Option<u64>,
    /// found by this computer's worker since Start
    pub blocks_session: u64,
    pub network_rate: Option<f64>,
    pub block_reward: f64,
    pub fee: f64,
    /// the pool site did not answer; the figures are the last ones read
    pub unreachable: bool,
}

pub struct Pool {
    view: Mutex<PoolView>,
    session_start: Mutex<Option<u64>>,
    last_stats: Mutex<Option<Instant>>,
    agent: ureq::Agent,
}

impl Pool {
    pub fn new() -> Pool {
        Pool {
            view: Mutex::new(PoolView { block_reward: 25.0, fee: 0.5, ..Default::default() }),
            session_start: Mutex::new(None),
            last_stats: Mutex::new(None),
            agent: ureq::AgentBuilder::new().timeout(Duration::from_secs(15)).build(),
        }
    }

    pub fn view(&self) -> PoolView {
        self.view.lock().unwrap().clone()
    }

    pub fn start_session(&self, at: u64) {
        *self.session_start.lock().unwrap() = Some(at);
        self.view.lock().unwrap().blocks_session = 0;
    }

    /// BEAM a day at `rate` sol/s, after the pool fee.
    pub fn per_day(&self, rate: f64) -> Option<f64> {
        let v = self.view.lock().unwrap();
        let net = v.network_rate.filter(|n| *n > 0.0)?;
        (rate > 0.0).then(|| rate / net * 1440.0 * v.block_reward * (1.0 - v.fee / 100.0))
    }

    fn get(&self, url: &str) -> Result<Option<serde_json::Value>, ()> {
        match self.agent.get(url).call() {
            Ok(r) => Ok(r.into_json().ok()),
            Err(ureq::Error::Status(404, _)) => Ok(None),
            Err(_) => Err(()),
        }
    }

    /// One refresh: the network figures every 5 minutes, the miner every call.
    pub fn refresh(&self, s: &Settings) {
        let stale = self.last_stats.lock().unwrap().map_or(true, |t| t.elapsed() > Duration::from_secs(300));
        if stale {
            match self.get(&format!("{BASE}/api/stats")) {
                Ok(Some(o)) => {
                    *self.last_stats.lock().unwrap() = Some(Instant::now());
                    let mut v = self.view.lock().unwrap();
                    v.unreachable = false;
                    if let Some(n) = o["nodes"].get(0).and_then(|n| n["networkhashps"].as_str().and_then(|x| x.parse().ok()).or(n["networkhashps"].as_f64())) {
                        v.network_rate = Some(n);
                    }
                    if let Some(r) = o["config"]["blockReward"].as_f64() {
                        v.block_reward = r / 1e8;
                    }
                    if let Some(f) = o["config"]["fee"].as_f64() {
                        v.fee = f;
                    }
                }
                Ok(None) => {}
                Err(()) => self.view.lock().unwrap().unreachable = true,
            }
        }
        if crate::address::check(&s.address) != crate::address::AddressType::PublicOffline {
            return;
        }
        let mut url = format!("{BASE}/api/miners/{}", s.address.trim());
        let session = *self.session_start.lock().unwrap();
        if let Some(since) = session {
            // the pool counts this worker's blocks since Start (?worker=&since=)
            url.push_str(&format!("?worker={}&since={since}", s.clean_worker()));
        }
        match self.get(&url) {
            Ok(Some(o)) => {
                let mut v = self.view.lock().unwrap();
                v.unreachable = false;
                v.balance = o["balance"].as_f64().map(|x| x / 1e8);
                v.immature = o["immature"].as_f64().map(|x| x / 1e8);
                let w = s.clean_worker();
                v.worker_rate = o["workers"].as_array().and_then(|ws| ws.iter().find(|x| x["name"].as_str() == Some(&w))).and_then(|x| x["hashrate"].as_f64());
                v.blocks_total = o["blocksFound"].as_u64();
                if session.is_some() {
                    if let Some(n) = o["blocksSince"].as_u64() {
                        v.blocks_session = n;
                    }
                }
            }
            Ok(None) => {
                let mut v = self.view.lock().unwrap();
                v.unreachable = false;
                v.balance = Some(0.0);
                v.immature = Some(0.0);
                v.worker_rate = None;
                v.blocks_total = Some(0);
            }
            Err(()) => self.view.lock().unwrap().unreachable = true,
        }
    }

    /// One average-speed report (POST /api/benchmarks); only with "Share average speed" on.
    pub fn report(&self, body: &serde_json::Value) -> bool {
        self.agent.post(&format!("{BASE}/api/benchmarks")).send_json(body.clone()).map_or(false, |r| r.status() == 200)
    }
}
