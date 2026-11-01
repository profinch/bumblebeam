//! Bindings to the oracle: verification, solution hash, difficulty.
use std::ffi::CStr;
use std::os::raw::c_char;

extern "C" {
    fn bb_bh3_check(input: *const u8, input_len: usize, nonce: *const u8, solution: *const u8) -> i32;
    fn bb_solution_hash(solution: *const u8, out: *mut u8);
    fn bb_difficulty_reached(hash: *const u8, packed: u32) -> i32;
    fn bb_difficulty_to_double(packed: u32) -> f64;
    fn bb_result_str(r: i32) -> *const c_char;
}

pub fn check(input: &[u8], nonce: &[u8; 8], solution: &[u8; 104]) -> Result<(), &'static str> {
    let r = unsafe { bb_bh3_check(input.as_ptr(), input.len(), nonce.as_ptr(), solution.as_ptr()) };
    if r == 0 { Ok(()) } else { Err(unsafe { CStr::from_ptr(bb_result_str(r)) }.to_str().unwrap_or("unknown")) }
}

pub fn solution_hash(solution: &[u8; 104]) -> [u8; 32] {
    let mut h = [0u8; 32];
    unsafe { bb_solution_hash(solution.as_ptr(), h.as_mut_ptr()) };
    h
}

pub fn difficulty_reached(hash: &[u8; 32], packed: u32) -> bool {
    unsafe { bb_difficulty_reached(hash.as_ptr(), packed) != 0 }
}

pub fn difficulty_to_double(packed: u32) -> f64 {
    unsafe { bb_difficulty_to_double(packed) }
}
