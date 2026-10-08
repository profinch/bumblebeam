//! Pool configuration (TOML). See pool/server/pool.example.toml.

use anyhow::{Context, Result};
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    pub node: Node,
    #[serde(default)]
    pub wallet_api: WalletApi,
    pub stratum: Stratum,
    pub pool: PoolCfg,
    #[serde(default)]
    pub vardiff: Vardiff,
    pub http: Http,
    pub database: Database,
    #[serde(default)]
    pub coinbase: Coinbase,
}

/// Coinbase payouts (tools/coinbase): miners upload pairs made with their own keys, the pool puts them
/// into the blocks it finds, bb-finalizer next to the node builds the coinbase and follows the chain.
#[derive(Debug, Clone, Deserialize)]
pub struct Coinbase {
    #[serde(default)]
    pub enabled: bool,
    /// Where bb-finalizer connects (loopback: the link is not authenticated).
    #[serde(default = "link_bind")]
    pub link_bind: String,
    /// Pair values are 2^ladder_shift groth times powers of two, ladder_steps of them.
    #[serde(default = "ladder_shift")]
    pub ladder_shift: u32,
    #[serde(default = "ladder_steps")]
    pub ladder_steps: u32,
    /// Block space the pairs may take; the node is started with --mine_online_reserve of at least this.
    #[serde(default = "coinbase_bytes")]
    pub max_coinbase_bytes: usize,
    #[serde(default = "stock_max")]
    pub stock_max_per_account: u32,
    #[serde(default = "upload_max")]
    pub max_pairs_per_upload: u32,
    /// Kernel lifespan (Beam: 1440*30 blocks after HF2) and how long before expiry a pair stops being offered.
    #[serde(default = "validity")]
    pub kernel_validity_blocks: u64,
    #[serde(default = "expiry_margin")]
    pub expiry_margin_blocks: u64,
}
impl Default for Coinbase {
    fn default() -> Self {
        Self {
            enabled: false,
            link_bind: link_bind(),
            ladder_shift: ladder_shift(),
            ladder_steps: ladder_steps(),
            max_coinbase_bytes: coinbase_bytes(),
            stock_max_per_account: stock_max(),
            max_pairs_per_upload: upload_max(),
            kernel_validity_blocks: validity(),
            expiry_margin_blocks: expiry_margin(),
        }
    }
}
fn link_bind() -> String { "127.0.0.1:3480".into() }
fn ladder_shift() -> u32 { 20 }
fn ladder_steps() -> u32 { 12 }
fn coinbase_bytes() -> usize { 64 * 1024 }
fn stock_max() -> u32 { 512 }
fn upload_max() -> u32 { 256 }
fn validity() -> u64 { 1440 * 30 }
fn expiry_margin() -> u64 { 100 }

#[derive(Debug, Clone, Deserialize)]
pub struct Node {
    /// host:port of the beam-node stratum server
    pub stratum_addr: String,
    pub api_key: String,
    #[serde(default = "t")]
    pub tls: bool,
    /// Standby nodes, tried in turn when the first is down.
    #[serde(default)]
    pub standby: Vec<String>,
    /// A job this many blocks below the network height means the node is still syncing and is not
    /// given to miners. 0 disables the check (tests with historical templates).
    #[serde(default = "lag")]
    pub sync_lag_blocks: u64,
}
fn lag() -> u64 { 5 }

#[derive(Debug, Clone, Deserialize, Default)]
pub struct WalletApi {
    /// e.g. http://127.0.0.1:10001/api/wallet ; empty disables payouts and block verification
    #[serde(default)]
    pub url: String,
    /// wallet-api --use_acl key, sent as "key" with every call; empty when ACL is off
    #[serde(default)]
    pub acl_key: String,
    /// Fallback network fee for payouts to regular addresses, groth (the wallet is asked first)
    #[serde(default = "default_fee")]
    pub tx_fee_groth: u64,
    /// Fallback fee for shielded payouts (offline, max-privacy, public-offline addresses), groth
    #[serde(default = "default_shielded_fee")]
    pub shielded_fee_groth: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Stratum {
    #[serde(default = "any")]
    pub bind: String,
    pub pplns_port: u16,
    pub solo_port: u16,
    /// TLS ports for miners (lolMiner and GMiner default to TLS for Beam). 0 disables.
    #[serde(default)]
    pub pplns_tls_port: u16,
    #[serde(default)]
    pub solo_tls_port: u16,
    /// PEM certificate chain and private key for the TLS ports.
    #[serde(default)]
    pub tls_cert: String,
    #[serde(default)]
    pub tls_key: String,
    /// Bytes of nonce the pool reserves per connection (after the node's own prefix).
    #[serde(default = "three")]
    pub nonce_prefix_bytes: usize,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PoolCfg {
    #[serde(default = "name")]
    pub name: String,
    pub fee_percent: f64,
    pub solo_fee_percent: f64,
    pub min_payout_groth: u64,
    pub payout_interval_secs: u64,
    /// PPLNS window as a multiple of the network difficulty at the block
    pub pplns_window: f64,
    #[serde(default = "maturity")]
    pub maturity: u64,
    /// Check each block's coinbase in the wallet before paying for it (needs wallet_api)
    #[serde(default = "t")]
    pub verify_blocks_with_wallet: bool,
    /// Explorer-node endpoints returning {found, hash} for a height, tried in this order until one
    /// answers; your own explorer-node first, a public one as a fallback. Empty disables the check.
    #[serde(default)]
    pub block_check_urls: Vec<String>,
    /// Deduct the network fee from each payout (the usual pool rule); false makes the pool pay it
    #[serde(default = "t")]
    pub miner_pays_tx_fee: bool,
    /// Public stratum host shown in the UI
    #[serde(default)]
    pub public_host: String,
    /// Share of a PPLNS block's reward, after the fee, that goes to the miner whose share found it,
    /// on top of that miner's PPLNS part. 0 disables.
    #[serde(default)]
    pub finder_bonus_percent: f64,
    /// Test chains only (FakePoW with a short Maturity.Coinbase): lets `maturity` go below Beam's 240.
    #[serde(default)]
    pub unsafe_test_maturity: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Vardiff {
    pub start: f64,
    pub min: f64,
    pub max: f64,
    pub target_secs: f64,
}
impl Default for Vardiff {
    fn default() -> Self {
        Self { start: 64.0, min: 8.0, max: 4.0e6, target_secs: 10.0 }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Http {
    pub bind: String,
    pub web_dir: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Database {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub url_file: String,
}

fn t() -> bool { true }
fn any() -> String { "0.0.0.0".into() }
fn three() -> usize { 3 }
fn name() -> String { "BumbleBeam".into() }
fn maturity() -> u64 { 240 }
fn default_fee() -> u64 { 1_000 }
fn default_shielded_fee() -> u64 { 1_000_100 }

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        let mut cfg: Config = toml::from_str(&text).context("parsing config")?;
        if cfg.database.url.is_empty() {
            anyhow::ensure!(!cfg.database.url_file.is_empty(), "database.url or database.url_file is required");
            cfg.database.url = std::fs::read_to_string(&cfg.database.url_file)
                .with_context(|| format!("reading {}", cfg.database.url_file))?
                .trim()
                .to_string();
        }
        anyhow::ensure!(cfg.stratum.nonce_prefix_bytes <= 6, "nonce_prefix_bytes must be 0..6");
        anyhow::ensure!((0.0..100.0).contains(&cfg.pool.fee_percent) && (0.0..100.0).contains(&cfg.pool.solo_fee_percent), "fee_percent must be in 0..100");
        anyhow::ensure!(cfg.pool.pplns_window > 0.0, "pplns_window must be positive");
        anyhow::ensure!((0.0..=10.0).contains(&cfg.pool.finder_bonus_percent), "finder_bonus_percent must be in 0..10");
        anyhow::ensure!(
            cfg.pool.maturity >= 240 || cfg.pool.unsafe_test_maturity,
            "maturity must be at least 240: Beam's coinbase matures after 240 blocks, paying earlier would spend other funds of the wallet (unsafe_test_maturity = true only on a test chain)"
        );
        anyhow::ensure!(cfg.pool.maturity >= 1, "maturity must be at least 1");
        anyhow::ensure!(
            cfg.pool.min_payout_groth > cfg.wallet_api.shielded_fee_groth.max(cfg.wallet_api.tx_fee_groth),
            "min_payout_groth must exceed the network fee, or payouts would be zero"
        );
        anyhow::ensure!(cfg.vardiff.min >= 1.0 && cfg.vardiff.max >= cfg.vardiff.start && cfg.vardiff.start >= cfg.vardiff.min, "vardiff: need 1 <= min <= start <= max");
        if cfg.coinbase.enabled {
            let cb = &cfg.coinbase;
            anyhow::ensure!((10..=40).contains(&cb.ladder_shift) && (1..=32).contains(&cb.ladder_steps), "coinbase: ladder_shift 10..40, ladder_steps 1..32");
            anyhow::ensure!(cb.max_coinbase_bytes >= 1024 && cb.max_coinbase_bytes <= 900 * 1024, "coinbase: max_coinbase_bytes 1 KB .. 900 KB");
            anyhow::ensure!(cb.max_pairs_per_upload >= 1 && cb.stock_max_per_account >= cb.max_pairs_per_upload, "coinbase: stock_max_per_account must be at least max_pairs_per_upload");
            anyhow::ensure!(cb.kernel_validity_blocks > cb.expiry_margin_blocks + 1440, "coinbase: kernel_validity_blocks must exceed expiry_margin_blocks by a day");
        }
        Ok(cfg)
    }
    pub fn wallet_enabled(&self) -> bool {
        !self.wallet_api.url.is_empty()
    }
}
