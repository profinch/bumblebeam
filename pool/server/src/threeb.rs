//! Endpoints for 3BMiner (3bminer/): small helpers its web UI on a miner cannot get from a browser
//! itself (the public MAC-vendor services send no CORS headers). Public, under the API's permissive CORS.
//!
//! GET /api/3bminer/oui/:mac           -> {"mac":"D0EA11B21D6A","prefix":"D0:EA:11","vendor":"Routerboard.com"}
//! GET /api/3bminer/oui?mac=a,b,...    -> {"vendors":{"<mac as given>":"<vendor or null>", ...}} (up to 64)
//!
//! The vendor list is Wireshark's manuf file (IEEE MA-L/MA-M/MA-S assignments, also /28 and /36
//! blocks), fetched on first use and again once a day; the most specific matching block wins.

use axum::extract::{Path, Query};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tracing::{info, warn};

const MANUF_URL: &str = "https://www.wireshark.org/download/automated/data/manuf";
const REFRESH: Duration = Duration::from_secs(24 * 3600);
const RETRY: Duration = Duration::from_secs(600);

/// prefix bits (24, 28 or 36) -> (the prefix's leading hex digits -> vendor)
#[derive(Default)]
pub struct Manuf {
    blocks: Vec<(usize, HashMap<String, String>)>,
}

impl Manuf {
    /// Wireshark's manuf: "AA:BB:CC<tab>Short<tab>Long name" or "AA:BB:CC:D0:00:00/28<tab>Short<tab>Long"
    pub fn parse(text: &str) -> Manuf {
        let mut by_bits: HashMap<usize, HashMap<String, String>> = HashMap::new();
        for line in text.lines() {
            if line.starts_with('#') || line.trim().is_empty() {
                continue;
            }
            let mut f = line.split('\t').map(str::trim);
            let (Some(pre), Some(short)) = (f.next(), f.next()) else { continue };
            let long = f.next().filter(|s| !s.is_empty()).unwrap_or(short);
            let (hexpart, bits) = match pre.split_once('/') {
                Some((h, b)) => (h, b.parse::<usize>().unwrap_or(24)),
                None => (pre, 24),
            };
            let hex: String = hexpart.chars().filter(|c| c.is_ascii_hexdigit()).collect::<String>().to_ascii_uppercase();
            let digits = bits / 4;
            if hex.len() < digits || !matches!(bits, 24 | 28 | 36) {
                continue;
            }
            by_bits.entry(bits).or_default().insert(hex[..digits].to_string(), long.to_string());
        }
        let mut blocks: Vec<_> = by_bits.into_iter().collect();
        blocks.sort_by(|a, b| b.0.cmp(&a.0)); // the most specific first
        Manuf { blocks }
    }

    /// (the matched prefix, formatted AA:BB:CC..., and the vendor) for a MAC in any common notation
    pub fn lookup(&self, mac: &str) -> Option<(String, String)> {
        let hex: String = mac.chars().filter(|c| c.is_ascii_hexdigit()).collect::<String>().to_ascii_uppercase();
        if hex.len() < 6 {
            return None;
        }
        for (bits, map) in &self.blocks {
            let d = bits / 4;
            if hex.len() >= d {
                if let Some(v) = map.get(&hex[..d]) {
                    let pre = hex[..d].as_bytes().chunks(2).map(|c| String::from_utf8_lossy(c).into_owned()).collect::<Vec<_>>().join(":");
                    return Some((pre, v.clone()));
                }
            }
        }
        None
    }

    pub fn len(&self) -> usize {
        self.blocks.iter().map(|(_, m)| m.len()).sum()
    }
}

struct Cache {
    manuf: Option<std::sync::Arc<Manuf>>,
    at: Option<Instant>,
}

fn cache() -> &'static Mutex<Cache> {
    static C: OnceLock<Mutex<Cache>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(Cache { manuf: None, at: None }))
}

/// the list, fetching it when there is none yet or the last fetch is older than a day (a failed fetch
/// is retried after 10 minutes; an old list keeps answering meanwhile)
async fn manuf() -> Option<std::sync::Arc<Manuf>> {
    let (have, due) = {
        let c = cache().lock().unwrap();
        let due = match (c.at, &c.manuf) {
            (None, _) => true,
            (Some(t), Some(_)) => t.elapsed() > REFRESH,
            (Some(t), None) => t.elapsed() > RETRY,
        };
        (c.manuf.clone(), due)
    };
    if !due {
        return have;
    }
    cache().lock().unwrap().at = Some(Instant::now()); // one fetch at a time
    let got = async {
        let text = reqwest::Client::builder().timeout(Duration::from_secs(30)).build()?.get(MANUF_URL).send().await?.error_for_status()?.text().await?;
        anyhow::Ok(Manuf::parse(&text))
    }
    .await;
    match got {
        Ok(m) if m.len() > 1000 => {
            info!("3bminer: MAC vendor list loaded, {} prefixes", m.len());
            let m = std::sync::Arc::new(m);
            cache().lock().unwrap().manuf = Some(m.clone());
            Some(m)
        }
        Ok(m) => {
            warn!("3bminer: MAC vendor list too short ({} prefixes), kept the old one", m.len());
            have
        }
        Err(e) => {
            warn!("3bminer: MAC vendor list fetch failed: {e:#}");
            have
        }
    }
}

fn unavailable() -> Response {
    (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": "MAC vendor list not loaded yet" }))).into_response()
}

pub async fn oui_one(Path(mac): Path<String>) -> Response {
    let Some(m) = manuf().await else { return unavailable() };
    let norm: String = mac.chars().filter(|c| c.is_ascii_hexdigit()).collect::<String>().to_ascii_uppercase();
    if norm.len() < 6 || norm.len() > 12 {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "a MAC address or its first 3 bytes, e.g. d0:ea:11:b2:1d:6a" }))).into_response();
    }
    let (prefix, vendor) = match m.lookup(&norm) {
        Some((p, v)) => (Some(p), Some(v)),
        None => (None, None),
    };
    Json(json!({ "mac": norm, "prefix": prefix, "vendor": vendor })).into_response()
}

pub async fn oui_many(Query(q): Query<HashMap<String, String>>) -> Response {
    let Some(m) = manuf().await else { return unavailable() };
    let list = q.get("mac").map(String::as_str).unwrap_or("");
    let mut out = serde_json::Map::new();
    for mac in list.split(',').map(str::trim).filter(|s| !s.is_empty()).take(64) {
        out.insert(mac.to_string(), m.lookup(mac).map(|(_, v)| json!(v)).unwrap_or(serde_json::Value::Null));
    }
    Json(json!({ "vendors": out })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "# comment\n\
74:12:13\tLinksysUSA\tLinksys USA, Inc\n\
D0:EA:11\tRouterboardc\tRouterboard.com\n\
00:1B:C5\tIeeeRegi\tIEEE Registration Authority\n\
00:1B:C5:00:10/36\tOpenRBcomDir\tOpenRB.com, Direct SIA\n\
70:B3:D5:00:00/28\tShort\n";

    #[test]
    fn parses_and_finds_the_most_specific_block() {
        let m = Manuf::parse(SAMPLE);
        assert_eq!(m.lookup("d0:ea:11:b2:1d:6a"), Some(("D0:EA:11".into(), "Routerboard.com".into())));
        assert_eq!(m.lookup("74-12-13-07-85-a6").map(|x| x.1), Some("Linksys USA, Inc".into()));
        assert_eq!(m.lookup("741213").map(|x| x.1), Some("Linksys USA, Inc".into()));
        // a /36 block inside a /24 one: the /36 wins, the rest of the /24 stays with the /24
        assert_eq!(m.lookup("00:1b:c5:00:10:55").map(|x| x.1), Some("OpenRB.com, Direct SIA".into()));
        assert_eq!(m.lookup("00:1b:c5:99:00:00").map(|x| x.1), Some("IEEE Registration Authority".into()));
        // a line without a long name uses the short one
        assert_eq!(m.lookup("70:b3:d5:00:12:34").map(|x| x.1), Some("Short".into()));
        assert_eq!(m.lookup("12:34:56:00:00:00"), None);
        assert_eq!(m.lookup("12:34"), None);
    }

    /// the real file: MANUF=<path to Wireshark's manuf> cargo test threeb -- --ignored
    #[test]
    #[ignore]
    fn real_manuf_file() {
        let Ok(p) = std::env::var("MANUF") else { return };
        let m = Manuf::parse(&std::fs::read_to_string(p).unwrap());
        assert!(m.len() > 30000, "{} prefixes", m.len());
        assert_eq!(m.lookup("d0:ea:11:b2:1d:6a").map(|x| x.1), Some("Routerboard.com".into()));
        assert_eq!(m.lookup("74:12:13:07:85:a6").map(|x| x.1), Some("Linksys USA, Inc".into()));
        assert_eq!(m.lookup("e4:65:b8:da:0e:98").map(|x| x.1.contains("Espressif")), Some(true));
    }
}
