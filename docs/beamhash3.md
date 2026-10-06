# BeamHash III: what a fast solver has to do

Source: Beam core `3rdparty/crypto/beamHashIII.h` and `beamHashIII_impl.cpp`. Line references are
to `BeamMW/beam` master as of 2026-10.

## Parameters

| | |
|---|---|
| Work bits per element | 448 (7 × 64), from SipHash-2-4 keyed by `prePow = Blake2b-256(header ‖ nonce ‖ extraNonce)` |
| Initial list | 2²⁵ = 33,554,432 elements |
| Rounds | 5. Each round collides on 24 bits |
| Solution | 32 leaf indices × 25 bits = 100 bytes, plus a 4-byte extra nonce = **104 bytes** |
| Solutions per run | ~2 on average (3 in the measured run) |

## One run

1. **Seed:** element `i` gets 7 SipHash outputs (`(i << 3) + 0..6`).
2. **Rounds 1–4:**
   - **Mix:** replace the low 64 work bits with a rotate-and-add of the work bits padded with the
     element's first `padNum` leaf indices (25 bits apart).
   - **Sort:** order the elements by their low 24 bits.
   - **Collide:** for every pair of equal low bits, XOR the pair, shift it right by 24, and concatenate
     their index trees, smaller first index first.
3. **Round 5:** mix, sort and collide again. An all-zero XOR of the remaining bits is a solution.

`padNum = min(((512 − remLen) + 24) / 25, |indexTree|)`, which gives **1, 2, 4, 6, 9** leaf indices
in the five mixes.

## What makes it expensive (and where the speed is)

- **The mix reads leaf indices, not just work bits.** This is the ASIC-resistance trick: by round 5,
  each element needs 9 of its 16 leaves. A GPU solver keeps only parent pointers per round, so these
  reads are random walks back down the tree. **Laying out the leaves the mix needs is the main design
  decision.** One option is to carry the first 9 leaves inline once the tree is that deep.
- **The work bits shrink by 24 per round** (448 → 424 → 400 → 376 → 288 after the last 64 are
  replaced). Packed storage saves bandwidth every round.
- **Sorting is wasted work.** Equal-bits bucketing (a radix pass on the top bits, then pairing inside
  each bucket in shared memory) is what fast Equihash solvers do.
- **Rough bandwidth bound.** Each round moves ~2²⁵ elements × ~50–60 B in each direction, roughly
  4 GB of traffic. Five rounds plus the tree walks come to ~20–30 GB per run. At 936 GB/s on an
  RTX 3090 that is ~30–45 runs/s, or ~60–90 Sol/s at about 2 solutions per run. The published best is
  ~52 Sol/s. **This is an estimate to be checked against a real kernel, not a promise.**
- **Duplicate index trees** (the same leaf twice) give invalid solutions. Pruning them early saves
  work in later rounds.

## Correctness oracle

`BeamHash_III::IsValidSolution` in the core decides what counts as a solution. Every solution the
miner produces is checked against it in CI. The reference `OptimisedSolve` (built with
`ENABLE_MINING`) generates the test vectors.
