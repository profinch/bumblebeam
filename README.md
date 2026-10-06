# bumblebeam

An open, community-run mining stack for [Beam](https://github.com/BeamMW/beam): a **BeamHash III GPU
miner** and a **mining pool**, both written from scratch for speed, with no closed parts and no
developer fee.

> Status: **design stage.** Nothing here mines yet. The numbers below are measured; the targets are
> targets.

## Why

Measured on 2026-10-06 at height ≈ 4,068,700:

- **One pool holds about 90% of the network.** 2Miners has ~37.9 kSol/s of a ~41–52 kSol/s network,
  HeroMiners ~4.6 kSol/s, and everyone else is below 1 kSol/s
  ([miningboard](https://miningboard.com/pool-stats/beam); pool APIs; explorer `/hdrs`).
- **The fastest BeamHash III miners are closed source.** lolMiner and GMiner both charge a dev fee. The
  open miners in BeamMW (`opencl-miner`, `cuda-miner`) stop at BeamHash II (2020) and BeamHash I (2019).
- **The only open pool is from 2020–2021.** It is `BeamMW/beam-mine` and `beam-stratum-pool`, which
  are s-nomp forks for Node.js 10 with native modules that no longer build.
- **Difficulty has fallen from 25.7 M (January 2024) to 2.7 M.** Fewer than ~150 miners keep the chain
  running, so one good open tool makes a difference.

## Components

### `miner/`: BeamHash III solver

| Backend | Target hardware | Priority |
|---|---|---|
| CUDA | NVIDIA Ampere/Ada/Blackwell (reference card: RTX 3090) | 1 |
| Metal | Apple Silicon (unified memory, no CPU↔GPU copies) | 2 |
| HIP / OpenCL | AMD | 3 |
| CPU (NEON/AVX2) | verification and testing only | — |

**Goal:** beat the best published BeamHash III hashrate on the same card, at the same power, with a
**0% fee**. The bar on an RTX 3090 is ~52 Sol/s at ~290 W (lolMiner, per
[WhatToMine](https://whattomine.com/coins/294-beam-beamhashiii/gpus)).

**Baseline:** the reference solver in the Beam core (`3rdparty/crypto/beamHashIII_impl.cpp`) measured
on an Apple M5 Pro: **302 s per run, 3 solutions (≈0.01 Sol/s per thread), 9.8 GB RAM**. That is
5,000× below a GPU. It is the correctness oracle, not a starting point.

What the solver must do well is set out in [docs/beamhash3.md](docs/beamhash3.md).

### `pool/`: pool server

- **Stratum:** a native server that speaks Beam's own stratum dialect (`login` / `job` / `solution`,
  `pow/stratum.h` in the core), so every existing Beam miner connects unchanged. It also supports
  NiceHash-style extranonce.
- **Share verification:** native code ported from the core verifier. This replaces the Node.js
  `beamhashverify` addon.
- **Upstream:** the pool takes work from our own `beam-node` (7.5.14493+, HF6) over the node's stratum.
  It keeps a hot standby node and switches to the new block template in under 100 ms.
- **Rewards:** PPLNS, plus solo mode on the same port. Fee 0–0.5%.
- **Payouts:** sent through `wallet-api`, batched, with the optional MaxPrivacy (Lelantus) payout every
  Beam wallet supports.
- **Transparency:** every found block, share window and payout can be checked from a public API.
- **Stack:** Rust (tokio). One binary plus Postgres. No PHP, Redis or MySQL.

At Beam's scale (a few hundred workers) throughput is not the hard part. **Uptime, low stale rates,
correct payouts and trust are.** The pool is built for those.

## Roadmap

1. **Oracle and test vectors.** Wrap the core verifier and the reference solver, and generate test
   vectors (header, nonce → solutions).
2. **CUDA miner v0.** A correct solver at any speed that passes the oracle on 10⁴ nonces.
3. **CUDA miner v1.** A bandwidth-bound design; reach parity with lolMiner on an RTX 3090.
4. **Stratum client and a public alpha** of the miner.
5. **Pool v0.** Stratum, verification, PPLNS accounting and payouts on masternet or testnet.
6. **Pool v1 on mainnet.**
7. **Metal backend**, then AMD.

## License

[Apache-2.0](LICENSE), the same license as the Beam core, whose verifier code this project reuses.
