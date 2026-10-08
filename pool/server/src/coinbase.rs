//! Coinbase payouts: miners are paid in the blocks the pool finds, with outputs they made themselves
//! (tools/coinbase). This module is the pool server's half:
//!
//! - the stock: pairs a miner uploads (`POST /api/coinbase/pairs`), verified by bb-finalizer and kept in
//!   `coinbase_pairs` until a block spends them or they expire;
//! - the allocation: when the node asks for a coinbase, the finalizer asks us, and we pick pairs for
//!   what each account is owed (balance from earlier blocks plus its share of this one), largest first,
//!   within the block space;
//! - the chain follow: the finalizer reports every block's hash and kernels; pairs whose kernels appear
//!   become `mined` and a `pending` payment per account is written, completed when the block confirms.
//!   The reported hashes also confirm or orphan the pool's own blocks (accounting).
//!
//! The link is line-delimited JSON over a loopback TCP connection the finalizer opens to `link_bind`.
//! Requests carry an `id`; notifications do not.

use crate::db::NewPair;
use crate::emission::miner_reward_groth;
use crate::pow;
use crate::state::{now, Shared};
use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot, RwLock};
use tokio_util::codec::{FramedRead, LinesCodec};
use tracing::{info, warn};

const MAX_LINE: usize = 4 << 20;
pub const META_SCANNED: &str = "cb_scanned_height";

/// The connection to bb-finalizer: one at a time, the newest wins.
pub struct Link {
    to_fin: RwLock<Option<mpsc::Sender<String>>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    next_id: AtomicU64,
    pub connected: AtomicBool,
    pub tip: AtomicU64,
    pub scanned: AtomicU64,
    pub last_finalization: AtomicI64,
    pub last_mined: AtomicI64,
    pub finalizations: AtomicU64,
}

impl Link {
    pub fn new() -> Arc<Link> {
        Arc::new(Link {
            to_fin: RwLock::new(None),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            connected: AtomicBool::new(false),
            tip: AtomicU64::new(0),
            scanned: AtomicU64::new(0),
            last_finalization: AtomicI64::new(0),
            last_mined: AtomicI64::new(0),
            finalizations: AtomicU64::new(0),
        })
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }

    async fn send_line(&self, line: String) -> Result<()> {
        let tx = self.to_fin.read().await.clone().ok_or_else(|| anyhow!("finalizer not connected"))?;
        tx.send(line).await.map_err(|_| anyhow!("finalizer connection closed"))
    }

    /// A request to the finalizer, answered within `timeout`.
    pub async fn request(&self, mut msg: Value, timeout: Duration) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        msg["id"] = json!(id);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        if let Err(e) = self.send_line(format!("{msg}\n")).await {
            self.pending.lock().unwrap().remove(&id);
            return Err(e);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(_)) => Err(anyhow!("finalizer disconnected")),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(anyhow!("finalizer did not answer in time"))
            }
        }
    }

    pub fn status(&self) -> Value {
        json!({
            "connected": self.is_connected(), "tip": self.tip.load(Ordering::Relaxed), "scanned": self.scanned.load(Ordering::Relaxed),
            "lastFinalization": nz(self.last_finalization.load(Ordering::Relaxed)), "lastMined": nz(self.last_mined.load(Ordering::Relaxed)),
            "finalizations": self.finalizations.load(Ordering::Relaxed),
        })
    }
}

fn nz(v: i64) -> Option<i64> {
    (v > 0).then_some(v)
}

/// The public key of an account as the miner's tool prints it: 32 bytes of X and a Y flag byte, hex.
pub fn is_account_key(pk: &str) -> bool {
    pk.len() == 66 && pk.chars().all(|c| c.is_ascii_hexdigit()) && (pk.ends_with("00") || pk.ends_with("01"))
}

pub async fn serve(shared: Arc<Shared>, link: Arc<Link>) -> Result<()> {
    let bind = &shared.cfg.coinbase.link_bind;
    let listener = TcpListener::bind(bind).await.with_context(|| format!("bind {bind}"))?;
    info!(%bind, "coinbase link listening for bb-finalizer");
    loop {
        let (stream, peer) = listener.accept().await?;
        let (shared, link) = (shared.clone(), link.clone());
        tokio::spawn(async move {
            info!(%peer, "finalizer connected");
            if let Err(e) = connection(shared, link.clone(), stream).await {
                warn!(%peer, "finalizer link: {e:#}");
            }
            info!(%peer, "finalizer disconnected");
        });
    }
}

async fn connection(shared: Arc<Shared>, link: Arc<Link>, stream: tokio::net::TcpStream) -> Result<()> {
    let (rd, mut wr) = stream.into_split();
    let (tx, mut rx) = mpsc::channel::<String>(256);
    let generation = {
        let mut slot = link.to_fin.write().await;
        *slot = Some(tx.clone());
        link.connected.store(true, Ordering::Relaxed);
        Arc::new(())
    };
    let writer = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if wr.write_all(line.as_bytes()).await.is_err() {
                break;
            }
        }
    });

    let mut lines = FramedRead::new(rd, LinesCodec::new_with_max_length(MAX_LINE));
    let res: Result<()> = async {
        while let Some(line) = lines.next().await {
            let line = line.map_err(|e| anyhow!("line: {e}"))?;
            if line.trim().is_empty() {
                continue;
            }
            let msg: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => {
                    warn!("finalizer sent a line that is not JSON");
                    continue;
                }
            };
            if let Some(method) = msg["method"].as_str() {
                let reply = handle(&shared, &link, method, &msg).await;
                if let Some(id) = msg.get("id").filter(|v| !v.is_null()) {
                    let mut out = match reply {
                        Ok(v) => v,
                        Err(e) => {
                            warn!(method, "finalizer request failed: {e:#}");
                            json!({ "ok": false, "error": format!("{e}") })
                        }
                    };
                    out["id"] = id.clone();
                    tx.send(format!("{out}\n")).await.map_err(|_| anyhow!("writer gone"))?;
                } else if let Err(e) = reply {
                    warn!(method, "finalizer notification failed: {e:#}");
                }
            } else if let Some(id) = msg["id"].as_u64() {
                if let Some(waiter) = link.pending.lock().unwrap().remove(&id) {
                    let _ = waiter.send(msg);
                }
            }
        }
        Ok(())
    }
    .await;

    // only the connection that owns the slot clears it
    {
        let mut slot = link.to_fin.write().await;
        if slot.as_ref().map(|s| s.same_channel(&tx)).unwrap_or(false) {
            *slot = None;
            link.connected.store(false, Ordering::Relaxed);
        }
    }
    drop(generation);
    writer.abort();
    res
}

async fn handle(shared: &Arc<Shared>, link: &Arc<Link>, method: &str, msg: &Value) -> Result<Value> {
    let cfg = &shared.cfg.coinbase;
    match method {
        "hello" => {
            let scanned: u64 = shared.db.meta_get(META_SCANNED).await?.and_then(|s| s.parse().ok()).unwrap_or(0);
            link.scanned.store(scanned, Ordering::Relaxed);
            if let Some(t) = msg["tip"].as_u64() {
                link.tip.store(t, Ordering::Relaxed);
            }
            info!(version = %msg["version"], tip = %msg["tip"], scanned, "finalizer hello");
            Ok(json!({ "ok": true, "scanned": scanned, "ladder": { "shift": cfg.ladder_shift, "steps": cfg.ladder_steps }, "maxCoinbaseBytes": cfg.max_coinbase_bytes }))
        }
        "coinbase" => {
            let height = msg["height"].as_u64().ok_or_else(|| anyhow!("no height"))?;
            let total = msg["total"].as_u64().ok_or_else(|| anyhow!("no total"))?;
            link.last_finalization.store(now(), Ordering::Relaxed);
            link.finalizations.fetch_add(1, Ordering::Relaxed);
            let a = allocate(shared, height, total).await?;
            info!(height, total, pairs = a.pairs.len(), paid = a.paid, pool = total - a.paid, accounts = a.offers.len(), "coinbase allocated");
            Ok(json!({ "ok": true, "pairs": a.pairs, "paid": a.paid, "poolValue": total - a.paid,
                       "offers": a.offers.iter().map(|(m, v)| json!({ "miner": m, "amount": v })).collect::<Vec<_>>() }))
        }
        "mined" => {
            let height = msg["height"].as_i64().ok_or_else(|| anyhow!("no height"))?;
            let hash = msg["hash"].as_str().unwrap_or("").to_lowercase();
            let kernels: Vec<String> = msg["kernels"].as_array().map(|a| a.iter().filter_map(|k| k.as_str().map(|s| s.to_lowercase())).collect()).unwrap_or_default();
            let (paid, spent) = shared.db.cb_block_mined(height, &hash, &kernels, now()).await?;
            if !paid.is_empty() {
                let sum: i64 = paid.iter().map(|p| p.1).sum();
                info!(height, %hash, accounts = paid.len(), pairs = paid.iter().map(|p| p.2).sum::<i64>(), groth = sum, "block paid miners in its coinbase");
            }
            if spent > 0 {
                warn!(height, %hash, pairs = spent, "pairs of ours spent in a block that is not ours (another pool, or the miner itself)");
            }
            link.scanned.store(height as u64, Ordering::Relaxed);
            link.last_mined.store(now(), Ordering::Relaxed);
            Ok(json!({ "ok": true }))
        }
        "headers" => {
            if let Some(t) = msg["tip"].as_u64() {
                link.tip.store(t, Ordering::Relaxed);
            }
            let list: Vec<(i64, String)> = msg["headers"]
                .as_array()
                .map(|a| a.iter().filter_map(|h| Some((h["height"].as_i64()?, h["hash"].as_str()?.to_lowercase()))).collect())
                .unwrap_or_default();
            if let Some(from) = shared.db.chain_headers_set(&list, now()).await? {
                let (pairs, pays) = shared.db.cb_rollback(from).await?;
                warn!(from, pairs, payments = pays, "chain reorganized under us: pairs back in stock, pending coinbase payments failed");
                // headers were written before the rollback deleted them: write the new ones again
                shared.db.chain_headers_set(&list.iter().filter(|(h, _)| *h >= from).cloned().collect::<Vec<_>>(), now()).await?;
            }
            Ok(json!({ "ok": true }))
        }
        "rollback" => {
            let height = msg["height"].as_i64().ok_or_else(|| anyhow!("no height"))?;
            let (pairs, pays) = shared.db.cb_rollback(height).await?;
            if pairs > 0 || pays > 0 {
                warn!(height, pairs, payments = pays, "finalizer reported a rollback: pairs back in stock, pending coinbase payments failed");
            }
            if let Some(scanned) = shared.db.meta_get(META_SCANNED).await?.and_then(|s| s.parse::<i64>().ok()) {
                if scanned >= height {
                    shared.db.meta_set(META_SCANNED, &(height - 1).max(0).to_string()).await?;
                }
            }
            Ok(json!({ "ok": true }))
        }
        "spent" => {
            // the finalizer found these kernels in the chain while building: the pairs are gone
            let height = msg["height"].as_i64().unwrap_or(0);
            let kernels: Vec<String> = msg["kernels"].as_array().map(|a| a.iter().filter_map(|k| k.as_str().map(|s| s.to_lowercase())).collect()).unwrap_or_default();
            let n = shared.db.cb_spent_elsewhere(&kernels, height).await?;
            warn!(height, kernels = kernels.len(), removed = n, "pairs already spent in the chain, taken out of the stock");
            Ok(json!({ "ok": true }))
        }
        "built" => {
            info!(height = %msg["height"], pairs = %msg["pairs"], paid = %msg["paid"], pool = %msg["poolValue"], dropped = msg["dropped"].as_array().map(|a| a.len()).unwrap_or(0),
                  note = %msg["note"], "finalizer built a coinbase");
            Ok(json!({ "ok": true }))
        }
        _ => Err(anyhow!("unknown method {method}")),
    }
}

pub struct Allocation {
    pub pairs: Vec<String>,
    pub paid: u64,
    pub offers: Vec<(i64, i64)>,
}

/// What each coinbase account is owed at `height`: its balance, the credits of its blocks still
/// confirming, and its share of this block's reward by the current PPLNS window (the P2Pool rule: a
/// block pays the window as it stands, not 240 blocks later). The balance already carries the debits of
/// the blocks that paid it, so nothing is paid twice; it can be negative when a block that paid turns
/// out orphaned, and such an advance is worked off by the blocks that follow.
async fn owed(shared: &Arc<Shared>, height: u64) -> Result<BTreeMap<i64, i64>> {
    let accounts = shared.db.cb_accounts().await?;
    let mut owed: BTreeMap<i64, i64> = accounts.iter().map(|(id, balance)| (*id, *balance)).collect();
    if let Some(job) = shared.current_job() {
        let ts = now();
        let net_diff = pow::difficulty_to_double(job.net_packed);
        let window = shared.cfg.pool.pplns_window * net_diff;
        let hashrate = shared.db.mode_hashrate("pplns", ts).await?.max(1.0);
        let max_lookback = 3 * 86400;
        let lookback = ((window / hashrate) * 6.0).clamp(3600.0, max_lookback as f64) as i64;
        let c = shared.db.client().await?;
        let mut shares = crate::db::pplns_window_in(&c, ts, ts - lookback, window).await?;
        let mut total: f64 = shares.iter().map(|(_, d)| d).sum();
        if total < window && lookback < max_lookback {
            shares = crate::db::pplns_window_in(&c, ts, ts - max_lookback, window).await?;
            total = shares.iter().map(|(_, d)| d).sum();
        }
        if total > 0.0 {
            // the same split as block_found, finder bonus set aside (the finder is unknown until the block is found)
            let (amounts, _) = crate::accounting::pplns_split(miner_reward_groth(height) as i64, shared.cfg.pool.fee_percent, shared.cfg.pool.finder_bonus_percent, &shares, total);
            for (id, amount) in amounts {
                if let Some(o) = owed.get_mut(&id) {
                    *o += amount;
                }
            }
        }
    }
    owed.retain(|_, v| *v > 0);
    Ok(owed)
}

/// Pairs for the block at `height`: per account largest first, never over what it is owed, never over
/// the total, within the block space kept for the coinbase.
pub async fn allocate(shared: &Arc<Shared>, height: u64, total: u64) -> Result<Allocation> {
    let cfg = &shared.cfg.coinbase;
    let owed = owed(shared, height).await?;
    let mut out = Allocation { pairs: Vec::new(), paid: 0, offers: Vec::new() };
    if owed.is_empty() {
        return Ok(out);
    }
    let stock = shared.db.cb_stock(height as i64, cfg.expiry_margin_blocks as i64).await?;
    let mut by_miner: HashMap<i64, Vec<&crate::db::StockPair>> = HashMap::new();
    for p in &stock {
        by_miner.entry(p.miner_id).or_default().push(p);
    }

    let mut order: Vec<(i64, i64)> = owed.into_iter().collect();
    order.sort_by(|a, b| b.1.cmp(&a.1));

    let mut left = total as i64;
    let mut size: usize = 400; // the pool's own output and kernel
    for (miner_id, owed) in order {
        let Some(pairs) = by_miner.get(&miner_id) else { continue };
        let mut paid = 0i64;
        for p in pairs {
            // stock is sorted by value DESC per miner
            if paid + p.value > owed || p.value > left || size + p.size as usize > cfg.max_coinbase_bytes {
                continue;
            }
            paid += p.value;
            left -= p.value;
            size += p.size as usize;
            out.pairs.push(p.hex.clone());
        }
        if paid > 0 {
            out.offers.push((miner_id, paid));
            out.paid += paid as u64;
        }
    }
    Ok(out)
}

/// `POST /api/coinbase/pairs`: checks the shape, has the finalizer verify the signature and every pair,
/// and stores the good ones.
pub async fn upload(shared: &Arc<Shared>, body: &Value) -> Result<Value, (u16, String)> {
    let cfg = &shared.cfg.coinbase;
    let link = shared.coinbase.as_ref().ok_or((404, "this pool does not pay in the coinbase".to_string()))?;
    let account = body["account"].as_str().unwrap_or("").trim().to_ascii_lowercase();
    let pk = account.strip_prefix("cb:").unwrap_or("");
    if !is_account_key(pk) {
        return Err((400, "account must be cb:<public key, 66 hex>".into()));
    }
    let ts = body["ts"].as_u64().ok_or((400, "ts missing".to_string()))?;
    if (ts as i64 - now()).abs() > 86400 {
        return Err((400, "ts is more than a day off".into()));
    }
    let sig = body["signature"].as_str().unwrap_or("").to_string();
    let pairs: Vec<String> = body["pairs"].as_array().ok_or((400, "pairs missing".to_string()))?.iter().filter_map(|p| p.as_str().map(|s| s.to_string())).collect();
    if pairs.is_empty() || pairs.len() > cfg.max_pairs_per_upload as usize {
        return Err((400, format!("1..{} pairs per upload", cfg.max_pairs_per_upload)));
    }
    if pairs.iter().any(|p| p.len() > 4000 || p.len() % 2 != 0 || !p.chars().all(|c| c.is_ascii_hexdigit())) {
        return Err((400, "each pair is hex of at most 2000 bytes".into()));
    }
    if !link.is_connected() {
        return Err((503, "the pool's finalizer is offline, try again later".into()));
    }

    let tip = shared.tip_height().unwrap_or(0);
    let res = link
        .request(json!({ "method": "verify", "account": account, "ts": ts, "pairs": pairs, "signature": sig, "height": tip, "domain": domain(shared) }), Duration::from_secs(20))
        .await
        .map_err(|e| (503, format!("finalizer: {e}")))?;
    if res["ok"].as_bool() != Some(true) {
        return Err((400, res["error"].as_str().unwrap_or("verification failed").to_string()));
    }
    let results = res["results"].as_array().cloned().unwrap_or_default();
    if results.len() != pairs.len() {
        return Err((500, "finalizer answered for a different number of pairs".into()));
    }

    let unit = 1i64 << cfg.ladder_shift;
    let max_step = unit << (cfg.ladder_steps - 1);
    let mut good: Vec<(usize, NewPair)> = Vec::new();
    let mut rejected: Vec<Value> = Vec::new();
    for (i, r) in results.iter().enumerate() {
        if r["ok"].as_bool() != Some(true) {
            rejected.push(json!({ "index": i, "error": r["error"].as_str().unwrap_or("rejected") }));
            continue;
        }
        let value = r["value"].as_i64().unwrap_or(0);
        let min_h = r["minHeight"].as_i64().unwrap_or(0);
        let max_h = r["maxHeight"].as_i64().unwrap_or(i64::MAX);
        if value < unit || value > max_step || value & (value - 1) != 0 {
            rejected.push(json!({ "index": i, "error": format!("value must be a ladder step: {unit} groth times a power of two up to {max_step}") }));
            continue;
        }
        if min_h as u64 > tip + 10 {
            rejected.push(json!({ "index": i, "error": "kernel minimum height is in the future" }));
            continue;
        }
        if (max_h as u64) < tip + cfg.expiry_margin_blocks + 1440 {
            rejected.push(json!({ "index": i, "error": "kernel expires too soon: make the pair at the current height" }));
            continue;
        }
        good.push((
            i,
            NewPair {
                value,
                kernel: r["kernel"].as_str().unwrap_or("").to_lowercase(),
                commitment: r["commitment"].as_str().unwrap_or("").to_lowercase(),
                hex: pairs[i].to_lowercase(),
                size: r["size"].as_i64().unwrap_or(0) as i32,
                min_height: min_h,
                max_height: max_h,
            },
        ));
    }
    // only a signed upload creates the account
    let miner_id = shared.db.miner_id(&account, "coinbase", now()).await.map_err(|e| (500, format!("{e}")))?;
    let (accepted, dup) = shared.db.cb_add_pairs(miner_id, &good, now(), cfg.stock_max_per_account as i64).await.map_err(|e| (500, format!("{e}")))?;
    for (i, e) in dup {
        rejected.push(json!({ "index": i, "error": e }));
    }
    let stock = shared.db.cb_stock_count(miner_id).await.map_err(|e| (500, format!("{e}")))?;
    info!(%account, accepted, rejected = rejected.len(), stock, "coinbase pairs uploaded");
    Ok(json!({ "account": account, "accepted": accepted, "rejected": rejected, "stockPairs": stock,
               "validUntil": good.iter().map(|(_, p)| p.max_height).min().unwrap_or(0) }))
}

/// What uploads are signed for, so a signature cannot be replayed to another pool: the public host,
/// or the pool's name when none is set.
pub fn domain(shared: &Arc<Shared>) -> String {
    let h = shared.cfg.pool.public_host.trim();
    if h.is_empty() { shared.cfg.pool.name.clone() } else { h.to_string() }
}

/// Every five minutes: pairs about to expire leave the stock.
pub async fn expiry_loop(shared: Arc<Shared>) {
    loop {
        tokio::time::sleep(Duration::from_secs(300)).await;
        let Some(tip) = shared.tip_height() else { continue };
        match shared.db.cb_expire(tip as i64, shared.cfg.coinbase.expiry_margin_blocks as i64).await {
            Ok(n) if n > 0 => info!(n, tip, "coinbase pairs expired"),
            Ok(_) => {}
            Err(e) => warn!("coinbase expiry: {e:#}"),
        }
    }
}

/// `GET /api/coinbase`
pub async fn info(shared: &Arc<Shared>) -> Result<Value> {
    let cfg = &shared.cfg.coinbase;
    let Some(link) = shared.coinbase.as_ref() else {
        return Ok(json!({ "enabled": false }));
    };
    let (accounts, stock, mined) = shared.db.cb_totals().await?;
    Ok(json!({
        "enabled": true, "height": shared.tip_height().unwrap_or(0), "domain": domain(shared),
        "ladder": { "shift": cfg.ladder_shift, "steps": cfg.ladder_steps, "unit": 1u64 << cfg.ladder_shift },
        "maxPairsPerUpload": cfg.max_pairs_per_upload, "stockMaxPerAccount": cfg.stock_max_per_account,
        "kernelValidityBlocks": cfg.kernel_validity_blocks, "expiryMarginBlocks": cfg.expiry_margin_blocks,
        "maxCoinbaseBytes": cfg.max_coinbase_bytes,
        "accounts": accounts, "stockPairs": stock, "minedPairs": mined,
        "finalizer": link.status(),
    }))
}
