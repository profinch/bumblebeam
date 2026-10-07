//! BeamHash III on the CPU. Same rules as the Beam core's `BeamHash_III::IsValidSolution`
//! (see docs/beamhash3.md): 2^25 elements of 448 work bits from SipHash-2-4, five rounds that
//! mix in leaf indices, collide on 24 bits and merge pairs; a pair whose remaining bits cancel in
//! the fifth round is a solution of 32 leaves. Every solution is verified with the oracle before
//! it is returned.
//!
//! Layout: each round's elements are stored in one array (work limbs, the first leaves of the
//! element's subtree that the next mix needs, and two parent indices into the previous round).
//! Collisions are found by bucketing on the top 12 bits of the 24-bit key, then sorting inside
//! each bucket; buckets are processed in parallel.

pub mod pow;

use rayon::prelude::*;
use std::sync::atomic::{AtomicUsize, Ordering};

pub const N: usize = 1 << 25;
const COLL: u32 = 24;
const IDX_BITS: u32 = 25;
const BUCKET_BITS: u32 = 12;
const BUCKETS: usize = 1 << BUCKET_BITS;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Elem<const L: usize, const NL: usize> {
    pub w: [u64; L],
    pub leaves: [u32; NL],
    pub pa: u32,
    pub pb: u32,
}

impl<const L: usize, const NL: usize> Elem<L, NL> {
    const ZERO: Self = Elem { w: [0; L], leaves: [0; NL], pa: 0, pb: 0 };
}

// ---------- primitives, bit-for-bit as the reference ----------

#[inline(always)]
fn siphash24(k: &[u64; 4], nonce: u64) -> u64 {
    let (mut v0, mut v1, mut v2, mut v3) = (k[0], k[1], k[2], k[3] ^ nonce);
    macro_rules! round {
        () => {
            v0 = v0.wrapping_add(v1); v2 = v2.wrapping_add(v3);
            v1 = v1.rotate_left(13); v3 = v3.rotate_left(16);
            v1 ^= v0; v3 ^= v2; v0 = v0.rotate_left(32);
            v2 = v2.wrapping_add(v1); v0 = v0.wrapping_add(v3);
            v1 = v1.rotate_left(17); v3 = v3.rotate_left(21);
            v1 ^= v2; v3 ^= v0; v2 = v2.rotate_left(32);
        };
    }
    round!(); round!();
    v0 ^= nonce;
    v2 ^= 0xff;
    round!(); round!(); round!(); round!();
    v0 ^ v1 ^ v2 ^ v3
}

/// Blake2b-256 personalised "Beam-PoW" || 448 || 5 over input || nonce || extra nonce.
pub fn pre_pow(input: &[u8], nonce: &[u8; 8], extra: &[u8; 4]) -> [u64; 4] {
    let mut p = blake2b_simd_params();
    p.update(input);
    p.update(nonce);
    p.update(extra);
    let h = p.finalize();
    let mut out = [0u64; 4];
    for i in 0..4 {
        out[i] = u64::from_le_bytes(h[8 * i..8 * i + 8].try_into().unwrap());
    }
    out
}

// Minimal Blake2b (RFC 7693) with the Beam personalisation; 32-byte digest.
struct Blake2b { h: [u64; 8], t: u128, buf: Vec<u8> }
const BLAKE2B_IV: [u64; 8] = [0x6a09e667f3bcc908, 0xbb67ae8584caa73b, 0x3c6ef372fe94f82b, 0xa54ff53a5f1d36f1, 0x510e527fade682d1, 0x9b05688c2b3e6c1f, 0x1f83d9abfb41bd6b, 0x5be0cd19137e2179];
const SIGMA: [[usize; 16]; 12] = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4], [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13], [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11], [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5], [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
];
fn blake2b_simd_params() -> Blake2b {
    // parameter block: digest 32, key 0, fanout 1, depth 1, personal "Beam-PoW" || 448u32 || 5u32
    let mut param = [0u8; 64];
    param[0] = 32; param[2] = 1; param[3] = 1;
    param[48..56].copy_from_slice(b"Beam-PoW");
    param[56..60].copy_from_slice(&448u32.to_le_bytes());
    param[60..64].copy_from_slice(&5u32.to_le_bytes());
    let mut h = BLAKE2B_IV;
    for i in 0..8 { h[i] ^= u64::from_le_bytes(param[8 * i..8 * i + 8].try_into().unwrap()); }
    Blake2b { h, t: 0, buf: Vec::with_capacity(256) }
}
impl Blake2b {
    fn compress(&mut self, block: &[u8], last: bool) {
        let mut m = [0u64; 16];
        for i in 0..16 { m[i] = u64::from_le_bytes(block[8 * i..8 * i + 8].try_into().unwrap()); }
        let mut v = [0u64; 16];
        v[..8].copy_from_slice(&self.h); v[8..].copy_from_slice(&BLAKE2B_IV);
        v[12] ^= self.t as u64; v[13] ^= (self.t >> 64) as u64;
        if last { v[14] = !v[14]; }
        #[inline(always)]
        fn g(v: &mut [u64; 16], a: usize, b: usize, c: usize, d: usize, x: u64, y: u64) {
            v[a] = v[a].wrapping_add(v[b]).wrapping_add(x); v[d] = (v[d] ^ v[a]).rotate_right(32);
            v[c] = v[c].wrapping_add(v[d]); v[b] = (v[b] ^ v[c]).rotate_right(24);
            v[a] = v[a].wrapping_add(v[b]).wrapping_add(y); v[d] = (v[d] ^ v[a]).rotate_right(16);
            v[c] = v[c].wrapping_add(v[d]); v[b] = (v[b] ^ v[c]).rotate_right(63);
        }
        for s in &SIGMA {
            g(&mut v, 0, 4, 8, 12, m[s[0]], m[s[1]]); g(&mut v, 1, 5, 9, 13, m[s[2]], m[s[3]]);
            g(&mut v, 2, 6, 10, 14, m[s[4]], m[s[5]]); g(&mut v, 3, 7, 11, 15, m[s[6]], m[s[7]]);
            g(&mut v, 0, 5, 10, 15, m[s[8]], m[s[9]]); g(&mut v, 1, 6, 11, 12, m[s[10]], m[s[11]]);
            g(&mut v, 2, 7, 8, 13, m[s[12]], m[s[13]]); g(&mut v, 3, 4, 9, 14, m[s[14]], m[s[15]]);
        }
        for i in 0..8 { self.h[i] ^= v[i] ^ v[i + 8]; }
    }
    fn update(&mut self, data: &[u8]) {
        self.buf.extend_from_slice(data);
        while self.buf.len() > 128 {
            let block: Vec<u8> = self.buf.drain(..128).collect();
            self.t += 128;
            self.compress(&block, false);
        }
    }
    fn finalize(mut self) -> [u8; 32] {
        self.t += self.buf.len() as u128;
        let mut block = [0u8; 128];
        block[..self.buf.len()].copy_from_slice(&self.buf);
        self.compress(&block, true);
        let mut out = [0u8; 32];
        for i in 0..4 { out[8 * i..8 * i + 8].copy_from_slice(&self.h[i].to_le_bytes()); }
        out
    }
}

/// stepElem::applyMix: the new low limb after mixing in the first `pad` leaves at `mix_len`.
#[inline(always)]
fn mix<const L: usize, const NL: usize>(e: &Elem<L, NL>, mix_len: u32, pad: usize) -> u64 {
    let mut t = [0u64; 8];
    t[..L].copy_from_slice(&e.w);
    for i in 0..pad {
        let pos = mix_len + i as u32 * IDX_BITS;
        if pos >= 512 { break; }
        let v = e.leaves[i] as u64;
        let (limb, off) = ((pos / 64) as usize, pos % 64);
        t[limb] |= v << off;
        if off + IDX_BITS > 64 && limb + 1 < 8 { t[limb + 1] |= v >> (64 - off); }
    }
    let mut r = 0u64;
    for i in 0..8 { r = r.wrapping_add(t[i].rotate_left((29 * (i as u32 + 1)) & 63)); }
    r.rotate_left(24)
}

/// (a ^ b) >> 24, masked to `out_len` bits, into LO limbs; limb 0 of each side is its mixed value.
#[inline(always)]
fn merge_bits<const L: usize, const LO: usize>(a: &[u64; L], b: &[u64; L], ma: u64, mb: u64, out_len: u32) -> [u64; LO] {
    let mut x = [0u64; 8];
    x[0] = ma ^ mb;
    for i in 1..L { x[i] = a[i] ^ b[i]; }
    let mut o = [0u64; LO];
    for i in 0..LO {
        o[i] = (x[i] >> COLL) | if i + 1 < 8 { x[i + 1] << (64 - COLL) } else { 0 };
        let lo = i as u32 * 64;
        if lo >= out_len { o[i] = 0; } else if out_len - lo < 64 { o[i] &= (1u64 << (out_len - lo)) - 1; }
    }
    o
}

// ---------- rounds ----------

/// Bucket every element by the top 12 bits of its 24-bit key; keeps (index, mixed limb 0).
fn bucketize<const L: usize, const NL: usize>(input: &[Elem<L, NL>], mix_len: u32, pad: usize) -> (Vec<(u32, u64)>, Vec<usize>) {
    let n = input.len();
    let threads = rayon::current_num_threads().max(1);
    let chunk = (n + threads - 1) / threads;
    // pass 1: per-chunk histograms
    let hists: Vec<Vec<u32>> = input.par_chunks(chunk).map(|c| {
        let mut h = vec![0u32; BUCKETS];
        for e in c { h[(mix(e, mix_len, pad) >> BUCKET_BITS) as usize & (BUCKETS - 1)] += 1; }
        h
    }).collect();
    // bucket starts, and per-chunk write cursors
    let mut starts = vec![0usize; BUCKETS + 1];
    for b in 0..BUCKETS { starts[b + 1] = starts[b] + hists.iter().map(|h| h[b] as usize).sum::<usize>(); }
    let mut cursors: Vec<Vec<usize>> = Vec::with_capacity(hists.len());
    let mut run = starts[..BUCKETS].to_vec();
    for h in &hists {
        cursors.push(run.clone());
        for b in 0..BUCKETS { run[b] += h[b] as usize; }
    }
    // pass 2: scatter
    let mut out: Vec<(u32, u64)> = Vec::with_capacity(n);
    let ptr = out.as_mut_ptr() as usize;
    input.par_chunks(chunk).zip(cursors.into_par_iter()).enumerate().for_each(|(ci, (c, mut cur))| {
        let base = ci * chunk;
        for (j, e) in c.iter().enumerate() {
            let m = mix(e, mix_len, pad);
            let b = (m >> BUCKET_BITS) as usize & (BUCKETS - 1);
            unsafe { *(ptr as *mut (u32, u64)).add(cur[b]) = ((base + j) as u32, m) };
            cur[b] += 1;
        }
    });
    unsafe { out.set_len(n) };
    (out, starts)
}

fn leaves_overlap(a: &[u32], b: &[u32]) -> bool {
    a.iter().any(|x| b.contains(x))
}

/// One collision round: mix, collide on 24 bits, merge pairs into the next round's elements.
fn round<const L: usize, const NL: usize, const LO: usize, const NLO: usize>(input: &[Elem<L, NL>], mix_len: u32, pad: usize, out_len: u32) -> Vec<Elem<LO, NLO>> {
    let (keys, starts) = bucketize(input, mix_len, pad);
    let cap = input.len() + input.len() / 4;
    let mut out: Vec<Elem<LO, NLO>> = Vec::with_capacity(cap);
    let out_ptr = out.as_mut_ptr() as usize;
    let cursor = AtomicUsize::new(0);
    (0..BUCKETS).into_par_iter().for_each(|b| {
        let mut slice: Vec<(u32, u64)> = keys[starts[b]..starts[b + 1]].to_vec();
        slice.sort_unstable_by_key(|k| k.1 & 0xFFFFFF);
        let mut local: Vec<Elem<LO, NLO>> = Vec::with_capacity(slice.len() + slice.len() / 8);
        let mut i = 0;
        while i < slice.len() {
            let mut j = i + 1;
            while j < slice.len() && (slice[j].1 ^ slice[i].1) & 0xFFFFFF == 0 { j += 1; }
            for p in i..j {
                for q in p + 1..j {
                    let (mut ia, mut ma, mut ib, mut mb) = (slice[p].0, slice[p].1, slice[q].0, slice[q].1);
                    let (ea, eb) = (&input[ia as usize], &input[ib as usize]);
                    if ea.leaves[0] == eb.leaves[0] { continue; }
                    if ea.leaves[0] > eb.leaves[0] { std::mem::swap(&mut ia, &mut ib); std::mem::swap(&mut ma, &mut mb); }
                    let (ea, eb) = (&input[ia as usize], &input[ib as usize]);
                    if leaves_overlap(&ea.leaves, &eb.leaves) { continue; }
                    let mut e = Elem::<LO, NLO>::ZERO;
                    e.w = merge_bits::<L, LO>(&ea.w, &eb.w, ma, mb, out_len);
                    // canonical leaves: a's subtree then b's; a has 2^(r-1) leaves, all stored
                    let a_count = NL.min(NLO);
                    for k in 0..NLO { e.leaves[k] = if k < a_count { ea.leaves[k] } else { eb.leaves[k - a_count] }; }
                    e.pa = ia; e.pb = ib;
                    local.push(e);
                }
            }
            i = j;
        }
        if !local.is_empty() {
            let at = cursor.fetch_add(local.len(), Ordering::Relaxed);
            assert!(at + local.len() <= cap, "round output exceeds capacity");
            unsafe { std::ptr::copy_nonoverlapping(local.as_ptr(), (out_ptr as *mut Elem<LO, NLO>).add(at), local.len()) };
        }
    });
    unsafe { out.set_len(cursor.load(Ordering::Relaxed)) };
    out
}

/// Pack 32 leaf indices (25 bits each, little-endian bit stream) plus the extra nonce.
pub fn pack_solution(leaves: &[u32; 32], extra: &[u8; 4]) -> [u8; 104] {
    let mut s = [0u8; 104];
    for (i, &v) in leaves.iter().enumerate() {
        let mut bit = i as u32 * IDX_BITS;
        for k in 0..IDX_BITS {
            s[(bit / 8) as usize] |= (((v >> k) & 1) as u8) << (bit % 8);
            bit += 1;
        }
    }
    s[100..104].copy_from_slice(extra);
    s
}

pub struct SolveStats { pub elements: [usize; 6], pub candidates: usize, pub rejected: usize }

/// All solutions for (input, nonce, extra nonce), each verified by the oracle.
pub fn solve(input: &[u8], nonce: &[u8; 8], extra: &[u8; 4]) -> (Vec<[u8; 104]>, SolveStats) {
    let k = pre_pow(input, nonce, extra);
    // seed: 7 limbs per element, leaf = own index
    let mut seed: Vec<Elem<7, 1>> = Vec::with_capacity(N);
    let sp = seed.as_mut_ptr() as usize;
    (0..N).into_par_iter().with_min_len(4096).for_each(|i| {
        let mut e = Elem::<7, 1>::ZERO;
        let base = (i as u32) << 3;
        for j in 0..7 { e.w[j] = siphash24(&k, (base + j as u32) as u64); }
        e.leaves[0] = i as u32;
        unsafe { *(sp as *mut Elem<7, 1>).add(i) = e };
    });
    unsafe { seed.set_len(N) };

    let mut elements = [N, 0, 0, 0, 0, 0];
    let r1: Vec<Elem<7, 2>> = round::<7, 1, 7, 2>(&seed, 448, 1, 424);
    drop(seed);
    elements[1] = r1.len();
    let r2: Vec<Elem<7, 4>> = round::<7, 2, 7, 4>(&r1, 424, 2, 400);
    drop(r1);
    elements[2] = r2.len();
    let r3: Vec<Elem<6, 8>> = round::<7, 4, 6, 8>(&r2, 400, 4, 376);
    drop(r2);
    elements[3] = r3.len();
    let r4: Vec<Elem<5, 9>> = round::<6, 8, 5, 9>(&r3, 376, 6, 288);
    elements[4] = r4.len();

    // round 5: mix at 288 with 9 leaves; a pair is a solution when the 24 bits after the collision
    // bits cancel too, i.e. the low 48 bits of the mixed limbs are equal
    let (keys, starts) = bucketize(&r4, 288, 9);
    let candidates = AtomicUsize::new(0);
    let found: Vec<[u8; 104]> = (0..BUCKETS).into_par_iter().flat_map_iter(|b| {
        let mut slice: Vec<(u32, u64)> = keys[starts[b]..starts[b + 1]].to_vec();
        slice.sort_unstable_by_key(|k| k.1 & 0xFFFF_FFFF_FFFF);
        let mut sols = Vec::new();
        let mut i = 0;
        while i < slice.len() {
            let mut j = i + 1;
            while j < slice.len() && (slice[j].1 ^ slice[i].1) & 0xFFFF_FFFF_FFFF == 0 { j += 1; }
            for p in i..j {
                for q in p + 1..j {
                    candidates.fetch_add(1, Ordering::Relaxed);
                    let (mut a, mut bb) = (&r4[slice[p].0 as usize], &r4[slice[q].0 as usize]);
                    if a.leaves[0] == bb.leaves[0] { continue; }
                    if a.leaves[0] > bb.leaves[0] { std::mem::swap(&mut a, &mut bb); }
                    let mut leaves = [0u32; 32];
                    let half = |e: &Elem<5, 9>, out: &mut [u32]| {
                        out[..8].copy_from_slice(&r3[e.pa as usize].leaves);
                        out[8..16].copy_from_slice(&r3[e.pb as usize].leaves);
                    };
                    half(a, &mut leaves[..16]);
                    half(bb, &mut leaves[16..]);
                    let mut sorted = leaves;
                    sorted.sort_unstable();
                    if sorted.windows(2).any(|w| w[0] == w[1]) { continue; }
                    sols.push(pack_solution(&leaves, extra));
                }
            }
            i = j;
        }
        sols
    }).collect();
    let mut ok = Vec::new();
    let mut rejected = 0;
    for s in found {
        match pow::check(input, nonce, &s) {
            Ok(()) => ok.push(s),
            Err(_) => rejected += 1,
        }
    }
    elements[5] = ok.len();
    (ok, SolveStats { elements, candidates: candidates.load(Ordering::Relaxed), rejected })
}
