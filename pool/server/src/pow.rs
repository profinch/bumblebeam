//! Bindings to bumblebeam's BeamHash III oracle (oracle/include/bumblebeam/pow.h), plus the
//! difficulty arithmetic the pool needs around it.

use std::ffi::CStr;
use std::os::raw::c_char;

pub const SOLUTION_BYTES: usize = 104;
pub const NONCE_BYTES: usize = 8;

pub const BB_OK: i32 = 0;
pub const BB_ERR_DIFFICULTY: i32 = 5;

extern "C" {
    fn bb_bh3_check_share(input: *const u8, input_len: usize, nonce: *const u8, solution: *const u8, packed: u32) -> i32;
    fn bb_solution_hash(solution: *const u8, out: *mut u8);
    fn bb_difficulty_reached(hash: *const u8, packed: u32) -> i32;
    fn bb_difficulty_to_double(packed: u32) -> f64;
    fn bb_result_str(r: i32) -> *const c_char;
}

/// Structure first, then the share difficulty. `BB_OK`, a structural error, or `BB_ERR_DIFFICULTY`.
pub fn check_share(input: &[u8], nonce: &[u8; NONCE_BYTES], solution: &[u8; SOLUTION_BYTES], packed: u32) -> i32 {
    unsafe { bb_bh3_check_share(input.as_ptr(), input.len(), nonce.as_ptr(), solution.as_ptr(), packed) }
}

pub fn solution_hash(solution: &[u8; SOLUTION_BYTES]) -> [u8; 32] {
    let mut h = [0u8; 32];
    unsafe { bb_solution_hash(solution.as_ptr(), h.as_mut_ptr()) };
    h
}

pub fn difficulty_reached(hash: &[u8; 32], packed: u32) -> bool {
    unsafe { bb_difficulty_reached(hash.as_ptr(), packed) != 0 }
}

/// Packed difficulty as a number: the expected solutions per block (or share) found.
pub fn difficulty_to_double(packed: u32) -> f64 {
    unsafe { bb_difficulty_to_double(packed) }
}

pub fn result_str(r: i32) -> &'static str {
    unsafe { CStr::from_ptr(bb_result_str(r)) }.to_str().unwrap_or("unknown")
}

/// Inverse of `difficulty_to_double`: Beam's packed form (8-bit order, 24-bit mantissa with an
/// implicit leading one). Values below 1 pack as 1.
pub fn pack_difficulty(d: f64) -> u32 {
    let d = if d.is_finite() && d >= 1.0 { d } else { 1.0 };
    let mut order = d.log2().floor() as i32;
    let mut mantissa = ((d / 2f64.powi(order) - 1.0) * (1u32 << 24) as f64).round() as i64;
    if mantissa >= 1 << 24 {
        order += 1;
        mantissa = 0;
    }
    let order = order.clamp(0, 231) as u32;
    (order << 24) | (mantissa.clamp(0, (1 << 24) - 1) as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_roundtrip() {
        for d in [1.0, 1.5, 7.0, 100.0, 1234.5, 2.7e6, 1e9] {
            let p = pack_difficulty(d);
            let back = difficulty_to_double(p);
            assert!((back - d).abs() / d < 1e-6, "{d} -> {p:#x} -> {back}");
        }
        assert_eq!(pack_difficulty(16777216.0), 24 << 24);
        assert_eq!(pack_difficulty(0.3), 0);
    }

    #[test]
    fn sha_vector() {
        let mut sol = [0u8; SOLUTION_BYTES];
        for (i, b) in sol.iter_mut().enumerate() {
            *b = i as u8;
        }
        assert_eq!(hex::encode(solution_hash(&sol)), "ae8e3d799b1353a39815f90eceebefa265cc448fe39faf2008cb20784cb2df9f");
    }
}
