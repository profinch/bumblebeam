//! Client for Beam's wallet-api (JSON-RPC 2.0 over HTTP, `--use_http=1`, optionally with an ACL key).
//!
//! Errors are split in two: the API answering with an error (the call did not happen) and a
//! transport failure (unknown whether it happened). Payouts treat them differently.

use serde_json::{json, Value};

#[derive(Debug, thiserror::Error)]
pub enum WalletError {
    #[error("wallet-api {method}: {message}")]
    Api { method: String, message: String },
    #[error("wallet-api {method}: transport: {message}")]
    Transport { method: String, message: String },
}

/// Error texts with hex runs of 32+ characters (transaction ids, hashes) replaced, so a message
/// recorded once matches the same message about another transaction.
pub fn normalize(msg: &str) -> String {
    let mut out = String::with_capacity(msg.len());
    let mut run = String::new();
    let flush = |run: &mut String, out: &mut String| {
        if run.len() >= 32 { out.push_str("<hex>"); } else { out.push_str(run); }
        run.clear();
    };
    for c in msg.chars() {
        if c.is_ascii_hexdigit() { run.push(c); } else { flush(&mut run, &mut out); out.push(c); }
    }
    flush(&mut run, &mut out);
    out
}

impl WalletError {
    /// The wallet does not know this transaction id. `known_text` is the normalised message this
    /// wallet-api version gave once (`admin probe-txid` records it); without it, wording is matched.
    pub fn is_unknown_tx_with(&self, known_text: Option<&str>) -> bool {
        match self {
            WalletError::Api { message, .. } => match known_text.filter(|k| !k.is_empty()) {
                Some(k) => normalize(message) == k || message.contains("Unknown transaction"),
                None => message.contains("Unknown transaction"),
            },
            _ => false,
        }
    }
    pub fn is_unknown_tx(&self) -> bool {
        self.is_unknown_tx_with(None)
    }
    /// The wallet already has a transaction with this id (a retry of a send that went through).
    pub fn is_duplicate_tx(&self, known_text: Option<&str>) -> bool {
        match self {
            WalletError::Api { message, .. } => match known_text.filter(|k| !k.is_empty()) {
                Some(k) => normalize(message) == k,
                None => {
                    let m = message.to_lowercase();
                    m.contains("already") || m.contains("duplicate")
                }
            },
            _ => false,
        }
    }
    pub fn message(&self) -> &str {
        match self {
            WalletError::Api { message, .. } | WalletError::Transport { message, .. } => message,
        }
    }
}

/// Beam's coinbase maturity: a block's reward can be spent 240 blocks later. A protocol rule, not
/// the pool's confirmation policy.
pub const COINBASE_MATURITY: u64 = 240;

pub struct Wallet {
    url: String,
    acl_key: String,
    http: reqwest::Client,
}

impl Wallet {
    pub fn new(url: &str, acl_key: &str, http: reqwest::Client) -> Wallet {
        Wallet { url: url.to_string(), acl_key: acl_key.to_string(), http }
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value, WalletError> {
        let mut body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        if !self.acl_key.is_empty() {
            body["key"] = json!(self.acl_key);
        }
        let transport = |e: String| WalletError::Transport { method: method.to_string(), message: e };
        let resp = self.http.post(&self.url).json(&body).send().await.map_err(|e| transport(e.to_string()))?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| transport(e.to_string()))?;
        let v: Value = serde_json::from_str(&text).map_err(|e| transport(format!("http {status}: {e}: {}", &text[..text.len().min(200)])))?;
        if let Some(err) = v.get("error").filter(|e| !e.is_null()) {
            let message = format!("{} {}", err["message"].as_str().unwrap_or(""), err["data"].as_str().unwrap_or(&err.to_string()));
            return Err(WalletError::Api { method: method.to_string(), message: message.trim().to_string() });
        }
        if !status.is_success() {
            return Err(transport(format!("http {status}")));
        }
        Ok(v["result"].clone())
    }

    pub async fn status(&self) -> Result<Value, WalletError> {
        self.call("wallet_status", json!({})).await
    }

    /// A fresh address of this wallet (for `admin probe-txid`): type regular, offline, public_offline...
    pub async fn create_address(&self, kind: &str, comment: &str) -> Result<String, WalletError> {
        let r = self.call("create_address", json!({ "type": kind, "expiration": "24h", "comment": comment })).await?;
        r.as_str().map(|s| s.to_string()).ok_or_else(|| WalletError::Api { method: "create_address".into(), message: format!("unexpected result {r}") })
    }

    /// `{ is_valid, is_mine, type }`; type is regular, offline, max_privacy or public_offline.
    pub async fn validate_address(&self, address: &str) -> Result<Value, WalletError> {
        self.call("validate_address", json!({ "address": address })).await
    }

    /// The fee the wallet requires for `amount`; shielded (push) transactions go to offline,
    /// max-privacy and public-offline addresses and cost far more than regular ones.
    pub async fn required_fee(&self, amount: u64, push: bool) -> Result<u64, WalletError> {
        let r = self.call("calc_change", json!({ "amount": amount, "is_push_transaction": push })).await?;
        r["explicit_fee"].as_u64().ok_or_else(|| WalletError::Api { method: "calc_change".into(), message: format!("no explicit_fee in {r}") })
    }

    /// Sends with a caller-chosen transaction id, so a retry after a crash can look the payment up.
    /// Returns the id the wallet actually used; a wallet that ignored ours is a bug to notice.
    pub async fn send(&self, address: &str, value: u64, fee: u64, comment: &str, tx_id: &str) -> Result<String, WalletError> {
        let r = self.call("tx_send", json!({ "value": value, "fee": fee, "address": address, "comment": comment, "txId": tx_id })).await?;
        let got = r["txId"].as_str().unwrap_or("").to_lowercase();
        if got.is_empty() {
            return Err(WalletError::Api { method: "tx_send".into(), message: format!("no txId in the response: {r}") });
        }
        Ok(got)
    }

    /// Recent transactions, newest first.
    pub async fn tx_list(&self, count: u32) -> Result<Vec<Value>, WalletError> {
        let r = self.call("tx_list", json!({ "count": count, "skip": 0 })).await?;
        Ok(r.as_array().cloned().unwrap_or_default())
    }

    /// Number of transactions carrying `comment` among the newest `count`.
    pub async fn count_with_comment(&self, comment: &str, count: u32) -> Result<usize, WalletError> {
        Ok(self.tx_list(count).await?.iter().filter(|t| t["comment"].as_str() == Some(comment)).count())
    }

    pub async fn tx_status(&self, tx_id: &str) -> Result<Value, WalletError> {
        self.call("tx_status", json!({ "txId": tx_id })).await
    }

    /// Every UTXO the wallet knows, in pages of 500.
    pub async fn utxos(&self) -> Result<Vec<Value>, WalletError> {
        let mut all = Vec::new();
        let mut skip = 0u64;
        loop {
            let r = self.call("get_utxo", json!({ "count": 500, "skip": skip })).await?;
            let page = r.as_array().cloned().unwrap_or_default();
            let n = page.len();
            all.extend(page);
            if n < 500 {
                return Ok(all);
            }
            if all.len() >= 200_000 {
                tracing::warn!(count = all.len(), "get_utxo: stopping at 200000 UTXOs, consolidate the wallet");
                return Ok(all);
            }
            skip += 500;
        }
    }
}

/// The amount of the coinbase of the block at `height` if it is in the wallet. Coinbase UTXOs have
/// type "mine" and mature COINBASE_MATURITY blocks after their height. Since fork 6 (mainnet height
/// 3928666) the node puts the block's transaction fees into the coinbase too, so the amount is the
/// reward plus the fees.
pub fn coinbase_in(utxos: &[Value], height: u64, min_amount: u64) -> Option<u64> {
    let maturity = height + COINBASE_MATURITY;
    utxos
        .iter()
        .filter(|u| u["type"].as_str() == Some("mine") && u["maturity"].as_u64() == Some(maturity))
        .filter_map(|u| u["amount"].as_u64())
        .find(|&a| a >= min_amount)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn coinbase_amount_includes_fees() {
        let utxos = vec![
            serde_json::json!({ "type": "regular", "maturity": 4072221, "amount": 9_000_000_000u64 }),
            serde_json::json!({ "type": "mine", "maturity": 4072221, "amount": 2_501_000_000u64 }),
        ];
        assert_eq!(coinbase_in(&utxos, 4071981, 2_500_000_000), Some(2_501_000_000));
        assert_eq!(coinbase_in(&utxos, 4071982, 2_500_000_000), None);
        assert_eq!(coinbase_in(&utxos, 4071981, 2_600_000_000), None);
    }

    #[test]
    fn normalizes_ids() {
        assert_eq!(normalize("Unknown transaction ID 0123456789abcdef0123456789abcdef."), "Unknown transaction ID <hex>.");
        assert_eq!(normalize("Invalid parameters. The minimum fee is 1000100 GROTH."), "Invalid parameters. The minimum fee is 1000100 GROTH.");
        assert_eq!(normalize("deadbeef"), "deadbeef");
    }
}
