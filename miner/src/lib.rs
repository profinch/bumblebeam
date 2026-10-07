//! BeamHash III on the CPU. Same rules as the Beam core's `BeamHash_III::IsValidSolution`
//! (see docs/beamhash3.md): 2^25 elements of 448 work bits from SipHash-2-4, five rounds that
//! mix in leaf indices, collide on 24 bits and merge pairs; a pair whose remaining bits cancel in
//! the fifth round is a solution of 32 leaves. Every solution is verified with the oracle before
//! it is returned.
//!
//! Layout: each round's elements live in 4096 buckets chosen by bits 12..23 of their next mixed
//! limb, which is computed and stored when the element is created. A round therefore reads one
//! bucket sequentially, sorts it by the remaining 12 key bits, pairs equal 24-bit keys, and
//! scatters the merged elements into the next round's buckets. Elements carry the first leaves of
//! their subtree that the next mix needs and two packed (bucket, offset) parent references.

pub mod pow;


use std::sync::atomic::{AtomicUsize, Ordering};

pub const N: usize = 1 << 25;
const COLL: u32 = 24;
const IDX_BITS: u32 = 25;
const BUCKET_BITS: u32 = 12;
const BUCKETS: usize = 1 << BUCKET_BITS;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Elem<const L: usize, const NL: usize> {
    /// work limbs; limb 0 already holds the next round's mix (the mix replaces it, as in the
    /// reference), and its bits 12..23 chose the bucket
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

/// (a ^ b) >> 24, masked to `out_len` bits, into LO limbs (limb 0 of each side is its mix).
#[inline(always)]
fn merge_bits<const L: usize, const LO: usize>(a: &[u64; L], b: &[u64; L], out_len: u32) -> [u64; LO] {
    let mut x = [0u64; 8];
    for i in 0..L { x[i] = a[i] ^ b[i]; }
    let mut o = [0u64; LO];
    for i in 0..LO {
        o[i] = (x[i] >> COLL) | if i + 1 < 8 { x[i + 1] << (64 - COLL) } else { 0 };
        let lo = i as u32 * 64;
        if lo >= out_len { o[i] = 0; } else if out_len - lo < 64 { o[i] &= (1u64 << (out_len - lo)) - 1; }
    }
    o
}

// ---------- rounds ----------
//
// Elements live in buckets keyed by bits 12..23 of their *next* mixed limb, so a round reads one
// bucket sequentially, pairs equal 24-bit keys inside it, and scatters each merged element into
// the next round's bucket with its mix already computed. No array is read twice and no element is
// fetched at random.

/// Bucket capacity: N / 4096 is 8192 on average with a spread of about 90, so 9472 is far beyond
/// any overflow; an overflowing element is dropped and counted.
const CAP: usize = 9216;
/// Elements a thread collects for one destination bucket before writing them in one go: one
/// atomic increment and one sequential copy per chunk instead of per element.
const CHUNK: usize = 16;

/// One counter per cache line, or 16 buckets' counters would bounce between cores.
#[repr(align(64))]
struct Counter(std::sync::atomic::AtomicU32);

pub struct Buckets<const L: usize, const NL: usize> {
    data: Vec<std::mem::MaybeUninit<Elem<L, NL>>>,
    counts: Vec<Counter>,
    overflow: AtomicUsize,
}
unsafe impl<const L: usize, const NL: usize> Sync for Buckets<L, NL> {}

impl<const L: usize, const NL: usize> Buckets<L, NL> {
    fn new() -> Self {
        let n = BUCKETS * CAP;
        let mut data = Vec::with_capacity(n);
        unsafe { data.set_len(n) }; // MaybeUninit: uninitialised is a valid state
        Buckets { data, counts: (0..BUCKETS).map(|_| Counter(std::sync::atomic::AtomicU32::new(0))).collect(), overflow: AtomicUsize::new(0) }
    }
    /// Take a kept instance and empty it, or allocate.
    fn take(slot: &mut Option<Self>) -> Self {
        match slot.take() {
            Some(b) => { for c in &b.counts { c.0.store(0, Ordering::Relaxed); } b.overflow.store(0, Ordering::Relaxed); b }
            None => Self::new(),
        }
    }
    /// Keep for the next run, or free.
    fn give(self, slot: &mut Option<Self>) {
        if reuse_buffers() { *slot = Some(self); }
    }
    /// Append a chunk to bucket `b`.
    #[inline(always)]
    fn push_many(&self, b: usize, es: &[Elem<L, NL>]) {
        let i = self.counts[b].0.fetch_add(es.len() as u32, Ordering::Relaxed) as usize;
        let fit = es.len().min(CAP.saturating_sub(i));
        if fit > 0 {
            unsafe { std::ptr::copy_nonoverlapping(es.as_ptr(), (self.data.as_ptr() as *mut Elem<L, NL>).add(b * CAP + i), fit) };
        }
        if fit < es.len() {
            self.overflow.fetch_add(es.len() - fit, Ordering::Relaxed);
        }
    }
    #[inline(always)]
    fn bucket(&self, b: usize) -> &[Elem<L, NL>] {
        let n = (self.counts[b].0.load(Ordering::Relaxed) as usize).min(CAP);
        unsafe { std::slice::from_raw_parts(self.data.as_ptr().add(b * CAP) as *const Elem<L, NL>, n) }
    }
    #[inline(always)]
    fn get(&self, packed: u32) -> &Elem<L, NL> {
        let (b, i) = ((packed >> 20) as usize, (packed & 0xFFFFF) as usize);
        unsafe { &*(self.data.as_ptr().add(b * CAP + i) as *const Elem<L, NL>) }
    }
    fn len(&self) -> usize {
        self.counts.iter().map(|c| (c.0.load(Ordering::Relaxed) as usize).min(CAP)).sum()
    }
}

/// Per-thread staging: CHUNK slots per destination bucket in one array, flushed when a bucket's
/// slots are full. Allocated once per thread per round; the hot loop never touches the allocator.
struct Stash<const L: usize, const NL: usize> {
    slots: Vec<Elem<L, NL>>,
    fill: Vec<u8>,
}
impl<const L: usize, const NL: usize> Stash<L, NL> {
    fn new() -> Self { Stash { slots: vec![Elem::<L, NL>::ZERO; BUCKETS * CHUNK], fill: vec![0; BUCKETS] } }
    #[inline(always)]
    fn slot(&mut self, b: usize) -> &mut Elem<L, NL> {
        let f = self.fill[b] as usize;
        &mut self.slots[b * CHUNK + f]
    }
    /// Call after writing `slot(b)`: counts it and flushes the bucket's chunk when full.
    #[inline(always)]
    fn commit(&mut self, out: &Buckets<L, NL>, b: usize) {
        self.fill[b] += 1;
        if self.fill[b] as usize == CHUNK {
            out.push_many(b, &self.slots[b * CHUNK..(b + 1) * CHUNK]);
            self.fill[b] = 0;
        }
    }
    fn flush(&mut self, out: &Buckets<L, NL>) {
        for b in 0..BUCKETS {
            let f = self.fill[b] as usize;
            if f > 0 { out.push_many(b, &self.slots[b * CHUNK..b * CHUNK + f]); self.fill[b] = 0; }
        }
    }
}

/// Exactly one task per thread pulling bucket indices from a shared counter: T stashes and T
/// scratch buffers for the whole round instead of one per rayon split.
fn per_thread<F: Fn(usize, &mut Scratch) + Sync>(n: usize, f: F) {
    let next = AtomicUsize::new(0);
    rayon::scope(|sc| {
        for _ in 0..rayon::current_num_threads() {
            sc.spawn(|_| {
                let mut scratch = Scratch::default();
                loop {
                    let b = next.fetch_add(1, Ordering::Relaxed);
                    if b >= n { break; }
                    f(b, &mut scratch);
                }
            });
        }
    });
}

/// Per-thread scratch for `for_pairs`.
#[derive(Default)]
pub struct Scratch {
    order: Vec<(u64, u16)>,
}

#[inline(always)]
fn bucket_of(m: u64) -> usize {
    ((m >> BUCKET_BITS) as usize) & (BUCKETS - 1)
}

/// Bucket arrays are reused across runs unless BB_NO_REUSE is set.
fn reuse_buffers() -> bool { std::env::var_os("BB_NO_REUSE").is_none() }

#[inline(always)]
fn leaves_overlap(a: &[u32], b: &[u32]) -> bool {
    a.iter().any(|x| b.contains(x))
}

/// Pairs inside one bucket with equal 24-bit keys, in canonical order (smaller first leaf first),
/// with distinct inline leaves. Calls `f(a_idx, b_idx)`.
#[inline(always)]
fn for_pairs<const L: usize, const NL: usize>(items: &[Elem<L, NL>], mask: u64, scratch: &mut Scratch, mut f: impl FnMut(usize, usize)) {
    // counting sort on the 12 key bits below the bucket bits; round 5 asks for 48 bits and gets a
    // small sort inside each run of equal 12-bit keys
    let n = items.len();
    let mut counts = [0u16; BUCKETS + 1];
    for e in items { counts[((e.w[0] & 0xFFF) as usize) + 1] += 1; }
    for i in 0..BUCKETS { counts[i + 1] += counts[i]; }
    let order = &mut scratch.order;
    order.clear();
    order.resize(n, (0, 0));
    let mut pos = counts;
    for (i, e) in items.iter().enumerate() {
        let c = (e.w[0] & 0xFFF) as usize;
        order[pos[c] as usize] = (e.w[0] & mask, i as u16);
        pos[c] += 1;
    }
    if mask != 0xFF_FFFF {
        for c in 0..BUCKETS {
            let (lo, hi) = (counts[c] as usize, counts[c + 1] as usize);
            if hi - lo > 1 { order[lo..hi].sort_unstable(); }
        }
    }
    let mut i = 0;
    while i < order.len() {
        let mut j = i + 1;
        while j < order.len() && order[j].0 == order[i].0 { j += 1; }
        for p in i..j {
            for q in p + 1..j {
                let (mut ia, mut ib) = (order[p].1 as usize, order[q].1 as usize);
                let (ea, eb) = (&items[ia], &items[ib]);
                if ea.leaves[0] == eb.leaves[0] { continue; }
                if ea.leaves[0] > eb.leaves[0] { std::mem::swap(&mut ia, &mut ib); }
                if leaves_overlap(&items[ia].leaves, &items[ib].leaves) { continue; }
                f(ia, ib);
            }
        }
        i = j;
    }
}

/// One collision round: for every bucket of `input`, merge colliding pairs into `out`, each with
/// the next round's mix precomputed and bucketed by it.
fn round<const L: usize, const NL: usize, const LO: usize, const NLO: usize>(input: &Buckets<L, NL>, out_len: u32, next_mix_len: u32, next_pad: usize, slot: &mut Option<Buckets<LO, NLO>>) -> Buckets<LO, NLO> {
    let out = Buckets::<LO, NLO>::take(slot);
    let next = AtomicUsize::new(0);
    rayon::scope(|sc| {
        for _ in 0..rayon::current_num_threads() {
            sc.spawn(|_| {
                let mut stash = Stash::<LO, NLO>::new();
                let mut scratch = Scratch::default();
                loop {
                    let b = next.fetch_add(1, Ordering::Relaxed);
                    if b >= BUCKETS { break; }
                    let items = input.bucket(b);
                    for_pairs(items, 0xFF_FFFF, &mut scratch, |ia, ib| {
                        let (ea, eb) = (&items[ia], &items[ib]);
                        let mut e = Elem::<LO, NLO>::ZERO;
                        e.w = merge_bits::<L, LO>(&ea.w, &eb.w, out_len);
                        let a_count = NL.min(NLO);
                        for k in 0..NLO { e.leaves[k] = if k < a_count { ea.leaves[k] } else { eb.leaves[k - a_count] }; }
                        e.pa = ((b as u32) << 20) | ia as u32;
                        e.pb = ((b as u32) << 20) | ib as u32;
                        e.w[0] = mix(&e, next_mix_len, next_pad);
                        let dest = bucket_of(e.w[0]);
                        *stash.slot(dest) = e;
                        stash.commit(&out, dest);
                    });
                }
                stash.flush(&out);
            });
        }
    });
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

/// A solver instance. The five bucket arrays (about 16 GB) are kept between runs so that a run
/// does not page-fault them in again; BB_NO_REUSE=1 frees them after every round instead.
#[derive(Default)]
pub struct Solver {
    b0: Option<Buckets<7, 1>>,
    b1: Option<Buckets<7, 2>>,
    b2: Option<Buckets<7, 4>>,
    b3: Option<Buckets<6, 8>>,
    b4: Option<Buckets<5, 9>>,
}

/// All solutions for (input, nonce, extra nonce), each verified by the oracle.
pub fn solve(input: &[u8], nonce: &[u8; 8], extra: &[u8; 4]) -> (Vec<[u8; 104]>, SolveStats) {
    Solver::default().solve(input, nonce, extra)
}

/// Phase timings on stderr when BB_TRACE is set.
fn trace(label: &str, t: &mut std::time::Instant) {
    if std::env::var_os("BB_TRACE").is_some() {
        eprintln!("  {label:<8} {:.3} s", t.elapsed().as_secs_f64());
        *t = std::time::Instant::now();
    }
}

impl Solver {
pub fn solve(&mut self, input: &[u8], nonce: &[u8; 8], extra: &[u8; 4]) -> (Vec<[u8; 104]>, SolveStats) {
    let mut tt = std::time::Instant::now();
    let k = pre_pow(input, nonce, extra);
    // seed straight into round-1 buckets: 7 limbs, leaf = own index, mix at 448 with one leaf
    let r0 = Buckets::<7, 1>::take(&mut self.b0);
    {
        let next = AtomicUsize::new(0);
        let r0 = &r0;
        rayon::scope(|sc| {
            for _ in 0..rayon::current_num_threads() {
                sc.spawn(|_| {
                    let mut stash = Stash::<7, 1>::new();
                    loop {
                        let chunk = next.fetch_add(1, Ordering::Relaxed);
                        if chunk >= N / 8192 { break; }
                        for i in chunk * 8192..(chunk + 1) * 8192 {
                            let mut e = Elem::<7, 1>::ZERO;
                            let base = (i as u32) << 3;
                            for j in 0..7 { e.w[j] = siphash24(&k, (base + j as u32) as u64); }
                            e.leaves[0] = i as u32;
                            e.w[0] = mix(&e, 448, 1);
                            let dest = bucket_of(e.w[0]);
                            *stash.slot(dest) = e;
                            stash.commit(r0, dest);
                        }
                    }
                    stash.flush(r0);
                });
            }
        });
    }
    let mut elements = [r0.len(), 0, 0, 0, 0, 0];
    let mut overflow = r0.overflow.load(Ordering::Relaxed);
    trace("seed", &mut tt);

    let r1 = round::<7, 1, 7, 2>(&r0, 424, 424, 2, &mut self.b1);
    trace("round1", &mut tt);
    r0.give(&mut self.b0);
    elements[1] = r1.len(); overflow += r1.overflow.load(Ordering::Relaxed);
    let r2 = round::<7, 2, 7, 4>(&r1, 400, 400, 4, &mut self.b2);
    trace("round2", &mut tt);
    r1.give(&mut self.b1);
    elements[2] = r2.len(); overflow += r2.overflow.load(Ordering::Relaxed);
    let r3 = round::<7, 4, 6, 8>(&r2, 376, 376, 6, &mut self.b3);
    trace("round3", &mut tt);
    r2.give(&mut self.b2);
    elements[3] = r3.len(); overflow += r3.overflow.load(Ordering::Relaxed);
    let r4 = round::<6, 8, 5, 9>(&r3, 288, 288, 9, &mut self.b4);
    trace("round4", &mut tt);
    elements[4] = r4.len(); overflow += r4.overflow.load(Ordering::Relaxed);
    if overflow > 0 { eprintln!("warning: {overflow} elements dropped on bucket overflow"); }

    // round 5: a pair is a solution when the 24 bits after the collision bits cancel too, i.e. the
    // low 48 bits of the mixed limbs (already stored as m) are equal
    let candidates = AtomicUsize::new(0);
    let found_all: std::sync::Mutex<Vec<[u8; 104]>> = std::sync::Mutex::new(Vec::new());
    per_thread(BUCKETS, |b, scratch| {
        let items = r4.bucket(b);
        let mut sols = Vec::new();
        for_pairs(items, 0xFFFF_FFFF_FFFF, scratch, |ia, ib| {
            candidates.fetch_add(1, Ordering::Relaxed);
            let (a, bb) = (&items[ia], &items[ib]);
            let mut leaves = [0u32; 32];
            let half = |e: &Elem<5, 9>, out: &mut [u32]| {
                out[..8].copy_from_slice(&r3.get(e.pa).leaves);
                out[8..16].copy_from_slice(&r3.get(e.pb).leaves);
            };
            half(a, &mut leaves[..16]);
            half(bb, &mut leaves[16..]);
            let mut sorted = leaves;
            sorted.sort_unstable();
            if sorted.windows(2).any(|w| w[0] == w[1]) { return; }
            sols.push(pack_solution(&leaves, extra));
        });
        if !sols.is_empty() { found_all.lock().unwrap().extend(sols); }
    });
    let found = found_all.into_inner().unwrap();
    let mut ok = Vec::new();
    let mut rejected = 0;
    for s in found {
        match pow::check(input, nonce, &s) {
            Ok(()) => ok.push(s),
            Err(_) => rejected += 1,
        }
    }
    elements[5] = ok.len();
    trace("final", &mut tt);
    r3.give(&mut self.b3);
    r4.give(&mut self.b4);
    (ok, SolveStats { elements, candidates: candidates.load(Ordering::Relaxed), rejected })
}
}

pub mod stratum;
