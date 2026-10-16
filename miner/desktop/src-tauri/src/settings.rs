//! What the miner is told to do, kept as JSON in the app's config directory.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Device {
    Gpu,
    Cpu,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Pplns,
    Solo,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub address: String,
    pub worker: String,
    pub device: Device,
    pub mode: Mode,
    /// 10..=100, step 10
    pub power: u32,
    /// keep the computer awake while mining on mains power (remembered)
    pub keep_awake: bool,
    pub show_rate: bool,
    pub start_at_login: bool,
    /// send average speeds to the pool (POST /api/benchmarks); off unless turned on
    pub share_speed: bool,
    /// Windows: "Best performance" power mode on mains while mining (laptops cap below it)
    pub best_performance: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            address: String::new(),
            worker: "bumblebeam".into(),
            device: Device::Gpu,
            mode: Mode::Pplns,
            power: 80,
            keep_awake: true,
            show_rate: true,
            start_at_login: false,
            share_speed: false,
            best_performance: true,
        }
    }
}

impl Settings {
    pub fn load(path: &PathBuf) -> Settings {
        std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn save(&self, path: &PathBuf) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(b) = serde_json::to_vec_pretty(self) {
            let tmp = path.with_extension("tmp");
            if std::fs::write(&tmp, b).is_ok() {
                let _ = std::fs::rename(&tmp, path);
            }
        }
    }

    pub fn configured(&self) -> bool {
        !self.address.trim().is_empty()
    }

    /// The worker name as the pool will see it: ASCII letters, digits, '-' and '_'.
    pub fn clean_worker(&self) -> String {
        let w: String = self.worker.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(32).collect();
        if w.is_empty() { "bumblebeam".into() } else { w }
    }
}
