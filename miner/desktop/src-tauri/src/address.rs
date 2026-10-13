//! Beam address types, by the Beam wallet's own rules (wallet/core/common.cpp,
//! GetAddressTypeImpl), the same check as the Mac app. Only public offline addresses are taken.
//!
//! An address in base58 is a TxToken: a flags byte (0x80), a presence byte and an optional 16-byte
//! TxID, then a count and (parameter id, byte buffer) pairs. Counts, ids and lengths are yas
//! "compacted" integers: a byte with the top bit set is the value in its low 7 bits, otherwise it
//! says how many little-endian bytes follow.

use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AddressType {
    Empty,
    PublicOffline,
    Offline,
    MaxPrivacy,
    Regular,
    Invalid,
}

pub fn check(a: &str) -> AddressType {
    let s = a.trim();
    if s.is_empty() {
        return AddressType::Empty;
    }
    if (64..=70).contains(&s.len()) && s.chars().all(|c| c.is_ascii_hexdigit()) {
        return AddressType::Regular;
    }
    let Some(b) = base58(s) else { return AddressType::Invalid };
    let Some(p) = token_parameters(&b) else { return AddressType::Invalid };
    // TransactionType (0) holds a compacted TxType: 0 simple, 1 atomic swap, 7 push
    if let Some(t) = p.get(&0) {
        match compacted(t, 0).map(|x| x.0) {
            Some(0) => return AddressType::Regular,
            Some(7) => {}
            _ => return AddressType::Invalid,
        }
    }
    let peer_addr = p.contains_key(&7);
    let endpoint = p.contains_key(&21);
    if p.contains_key(&125) && endpoint {
        return AddressType::MaxPrivacy; // Voucher
    }
    if p.get(&124).map_or(false, |v| v.len() > 1) && endpoint && peer_addr {
        return AddressType::Offline; // ShieldedVoucherList
    }
    if p.contains_key(&123) {
        return AddressType::PublicOffline; // PublicAddreessGen
    }
    if peer_addr {
        return AddressType::Regular;
    }
    AddressType::Invalid
}

fn base58(s: &str) -> Option<Vec<u8>> {
    const A: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut out: Vec<u8> = Vec::new(); // big-endian
    for c in s.bytes() {
        let mut carry = A.iter().position(|&x| x == c)? as u32;
        for b in out.iter_mut().rev() {
            carry += (*b as u32) * 58;
            *b = (carry & 0xff) as u8;
            carry >>= 8;
        }
        while carry > 0 {
            out.insert(0, (carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    let zeros = s.bytes().take_while(|&c| c == b'1').count();
    let mut v = vec![0u8; zeros];
    v.extend(out);
    Some(v)
}

fn compacted(b: &[u8], i: usize) -> Option<(u64, usize)> {
    let x = *b.get(i)?;
    if x & 0x80 != 0 {
        return Some(((x & 0x7f) as u64, i + 1));
    }
    let n = x as usize;
    if n > 8 || i + 1 + n > b.len() {
        return None;
    }
    let mut v = 0u64;
    for k in 0..n {
        v |= (b[i + 1 + k] as u64) << (8 * k);
    }
    Some((v, i + 1 + n))
}

fn token_parameters(b: &[u8]) -> Option<HashMap<u64, Vec<u8>>> {
    if b.len() <= 3 || b[0] & 0x80 == 0 {
        return None;
    }
    let mut i = 1;
    if b[i] != 0 {
        i += 16; // a TxID is present
    }
    i += 1;
    let (count, next) = compacted(b, i)?;
    if count >= 256 {
        return None;
    }
    i = next;
    let mut out = HashMap::new();
    for _ in 0..count {
        let (id, after_id) = compacted(b, i)?;
        let (len, start) = compacted(b, after_id)?;
        let end = start + len as usize;
        if end > b.len() {
            return None;
        }
        out.insert(id, b[start..end].to_vec());
        i = end;
    }
    (i == b.len()).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_addresses() {
        let public_offline = "MRdDS7xUNYAFBLubv5UrAUfCd1qdQZsTc9eVttmspWygYq5Cn2Mki3Sx2uG34usNX9Fy1VzmkfU2kxLBHcv8nwPpvSA4vz9xhY6zeJLWN6QNa6m5D3JQJZikhmhEtyKHUo2BeXBtLzoi4H3Ui9jtzipWqwj8pH9XKGxt2zvTEa4ibsYeEH8WTHHjDTCXXf8cFXMvVdjE4N1xV1iTGmPm152dJoFBE9pVx56emKVcHyRRLA9pToo1HYmsKwJJ8yyfhKo4cYtFgBoz8SMTi9mLGoVydrFo36Ad7jnrDNYn3D2eqYQULw98qM2pv4oiHFezhxURz5iWktGcv6qNC45GyvYTNmdhHACjT2SK8ZP1XerrMefCNsowo1Z93v9CF1bFQ8yHMiQsABcBYEcGRJN8kZAg11D3WWDeaGKrZgAaWfmbLBBbV";
        let regular = "28NVd2b7qBJRLiL3A1H9MYTL2jKK2tG2Szaszaf3yZ94zZQPFaT8JJRrTxjRgm2LH7bT7jNKbaTj3hiPjXaj8hbAXALBs6Kc11LAk7p6KRPmpsGtjLfmpWN8pnjRcfaiF4ifKkCX";
        assert_eq!(check(public_offline), AddressType::PublicOffline);
        assert_eq!(check(regular), AddressType::Regular);
        assert_eq!(check(&"1a2b".repeat(16)), AddressType::Regular);
        assert_eq!(check("hello"), AddressType::Invalid);
        assert_eq!(check(&public_offline[..20]), AddressType::Invalid);
        assert_eq!(check("  "), AddressType::Empty);
    }
}
