# bpscan: scanning the chain for traces of the pre-HF6 bulletproof forgery

## The bug

Before Hard Fork 6 (height **3928666**, July 2026), Beam's inner-product argument
(`core/ecc_bulletproof.cpp`, `InnerProduct` v0) drew round i's challenge **before**
adding L_i, R_i to the transcript, so the prover chose every pair with its own
challenge already known. The cheapest forgery uses the **last** round's pair,
where nothing has to stay consistent afterwards: pick L freely and solve R from
the final verification equation. (An earlier pair can be tuned the same way, with
the remaining rounds finished honestly; this is our reading of the v0 code, Beam's
write-up describes the last pair.) That proves a range
for any committed value, "negative" ones included: an output of −X balances an
output of +X, and X coins appear. The fix is commit `37ca7d8ca` ("BP scheme
upgraded", `iVersion` 1 from HF6 on).

This affected every bulletproof created before HF6: MW outputs (table `Txo`) and
shielded/Lelantus outputs (`TxKernelShieldedOutput` in the kernels), for every asset.

## What can and cannot be known

- **The supply check does not catch it.** Commitments still sum to the emission,
  because the −X output sits in the UTXO set and cancels the +X.
- **A careful forgery cannot be detected.** The free L and the solved R look like
  any honest pair of random points, and Pedersen commitments hide the values
  perfectly.
- **A careless forgery can be caught.** Examples: the identity point or a
  generator used as L, L == ±R, a zero scalar, or one point reused across
  outputs. bpscan looks for these.
- **After HF6, a −X output cannot move as a negative output.** That would need a
  new forged proof, which no longer verifies. It can only be spent together with
  at least X of real coins, which burns them and cancels the inflation. So an
  uncancelled −X is still in the pre-HF6 UTXO set or in the pre-HF6 shielded
  pool. `unspent_pre_hf6.csv` lists the MW candidates (`txo_id,height,commitment`,
  commitment as X then Y, the way the Beam explorer prints it).
- **The only definitive answer is lustration** (hard fork 7, branch
  `2026-lustration`). Each confidential pre-HF7 TXO must disclose its amount when first spent,
  and a −X output can never disclose. Spends are capped by the per-asset supply
  snapshot (`Total`/`Consumed`). If inflation happened, the last legacy coins to
  move hit the cap. If it did not, there is never a full proof, because lost coins
  stay undisclosed forever.

## Checks

For each confidential bulletproof (A, S, T1, T2, L0..R5, TauX, Mu, tDot, condensed a, b):

| flag | meaning |
|---|---|
| `badpt` | a point that does not import (bad encoding / not on the curve) |
| `zeropt` | point encoded as zero / infinity |
| `small` | point equals k·G, k·H, k·J (k ≤ 65536) or k·(IPA generator) (k ≤ 256) |
| `lr_eq` | two LR points of the same proof share X (e.g. L5 = ±R5) |
| `scalar` | a scalar < 2^64 (incl. 0), or a == b |
| `dup` | A/S/T1/T2/L5/R5/TauX/Mu equal to that of a proof of a **different** commitment (`--all-rounds`: L0..R4 too) |
| `replay` | equal only within proofs of the same commitment (informational, the same output re-created); `replay.csv` lists them per commitment with the fields they share |

An honest wallet derives A and S from the coin alone and takes fresh randomness
for the rest, so a re-created coin shares exactly `A|S` with its earlier proof.
A forged template stamped onto one commitment would share more.

Post-HF6 proofs use the sound scheme and act as the **control group**. The
pre-HF6 flag rate should match the post-HF6 rate.

`bpscan --selftest <dir>` is the positive control: it builds proofs that trip each
detector (zero point, a point off the curve, 7·G, −7·G, 65536·H, R = −L, a small
scalar, a = b, a point shared across commitments, a coin proven twice) and checks
that honest v0 and v1 proofs trip none and do not verify as each other.

## Build

The tool builds inside a Beam source tree. Nothing in that tree is modified: the
target is injected through `CMAKE_PROJECT_INCLUDE`.

```sh
cmake -S <beam-src> -B build -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DBEAM_LINK_TYPE=Static -DBUILD_SHARED_LIBS=OFF -DBEAM_NO_QT_UI_WALLET=On -DBEAM_IPFS_SUPPORT=OFF \
  -DBPSCAN_DIR=$PWD -DCMAKE_PROJECT_INCLUDE=$PWD/inject.cmake
ninja -C build bpscan
```

## Run

Run it on a **copy** of a node database. Never use the file of a running node.
Any node works, as long as it has no TxoLo/TxoHi horizon (no fast sync):
old block bodies are erased, but every TXO is kept in full.

```sh
bpscan --selftest out/             # every detector fires on a crafted proof
bpscan node.db out/ --check        # PRAGMA quick_check on the copy
bpscan node.db out/ [--to=H] [--all-rounds]
```

Output in `out/`: `summary.json` (counts per period, flags, unreadable ranges),
`flagged.csv`, `replay.csv`, and `unspent_pre_hf6.csv`. On a 4-vCPU VM, ~40M TXOs take tens of
minutes. Temporary key buckets take ~1 GB per 5M proofs.

A copy of a live file can contain torn pages. `resync.py <live> <copy>` re-copies the
1 MB chunks that changed. It also prints the SQLite change counter before and after
the pass: if the counter did not move, no commit happened during the pass, and the
copy is a consistent snapshot. `--check` verifies the copy. bpscan reads TXOs in
chunks of 100k, so a damaged range shows up in `txo_bad_chunks` and is never
silently skipped.
