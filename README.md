# BumbleBeam

Open-source contributions to the [Beam](https://github.com/BeamMW/beam) ($BEAM) privacy blockchain, as a
member of its community: mining tools, a pool and more. Everything here is public, Apache-2.0, and
checked against the Beam core itself.

The first goal is mining. Today one pool holds about 75–90% of Beam's hashrate, the fastest
BeamHash III miners are closed source with a dev fee, and the only open pool code dates from
2020–2021. bumblebeam builds the open alternative piece by piece, starting with the ground truth.

| Part | What it is | Status |
|---|---|---|
| [`oracle/`](oracle) | BeamHash III verification and difficulty checks, tested against the Beam core and real mainnet blocks | **done** (step 1) |
| [`vectors/`](vectors) | Test vectors: real mainnet headers, the core's difficulty decisions, full solution sets from the reference solver | **done** (step 1) |
| [`tools/hdrdump`](tools/hdrdump) | Dev tool that pulls headers from a Beam node and has the core validate them | **done** (step 1) |
| [`pool/web`](pool/web) | Pool web UI in the Beam Explorer style: pool, network (pools, blocks by pool, block times), blocks, miners, payments, start-mining guide with calculator. Live network data; the pool's own numbers are demo data until the server exists | **UI ready** |
| [`pool/API.md`](pool/API.md) | Pool HTTP API, readable as-is by the Beam Explorer's pool adapter | spec |
| `pool/` server | Stratum server, share accounting, payouts (Rust) | next |
| `miner/` | BeamHash III GPU solver: CUDA first, then Metal and AMD | next |

## Numbers that set the bar

Measured on 2026-10-06, at height ≈ 4,068,700:

- **Network:** ~45–52 kSol/s at a difficulty of ~2.7 M, down from 25.7 M in January 2024. Pools:
  2Miners ~35 kSol/s, HeroMiners ~4.5 kSol/s, and the rest below 1 kSol/s (Beam Explorer mining page,
  pool APIs).
- **Best published miner:** ~52 Sol/s on an RTX 3090 at ~290 W (lolMiner, per
  [WhatToMine](https://whattomine.com/coins/294-beam-beamhashiii/gpus)).
- **The core's reference CPU solver** on an Apple M5 Pro: 302–316 s per run, ~10 GB of RAM, 1–3
  solutions. It is the correctness oracle, not a starting point.

What a fast solver has to do is set out in [docs/beamhash3.md](docs/beamhash3.md).

## Step 1: the oracle

`oracle/` has two implementations side by side:

- **`third_party/beam/`** is the Beam core's BeamHash III code, copied unchanged. It is what every
  node runs.
- **`src/pow.cpp`** is bumblebeam's own check, behind a C API (`include/bumblebeam/pow.h`) that the
  pool and the miner both use. It needs no allocation and no `std::bitset`. Single-threaded on an
  M5 Pro it does **~750,000 solution checks/s, ~80× faster than the reference**
  (`bb-pow bench vectors/mainnet_headers.json`).

`test_oracle` holds the second one to the first and to the chain. One run makes 42,348 checks and
all pass, also under ASan/UBSan:

- **Real blocks:** 121 BeamHash III mainnet headers from HF2 (777,777) through HF6 (3,928,666) to the
  tip. The core accepted each one in `hdrdump`, and their block hashes match explorer.beam.mw.
- **Reference parity:** 36,133 mutated solutions (bit flips in solution, nonce, input and extra
  nonce; swapped subtrees; duplicated indices). Accept/reject equals the reference on every one, and
  each subtree swap is reported as the right error.
- **Difficulty:** 4,000 decisions taken from `Difficulty::IsTargetReached` in the core, including the
  exact target boundary (target − 1, target, target + 1).
- **Completeness:** every solution the reference solver finds for a given input, which a GPU solver
  will have to find too.

```sh
cmake -S . -B build -G Ninja && cmake --build build
./build/oracle/test_oracle vectors
./build/oracle/bb-pow check <input> <nonce> <solution> [packed-difficulty]
./build/oracle/bb-pow solve <input> <nonce>        # reference solver: slow, ~10 GB
```

## Pool web UI

Open `pool/web/index.html` through any static server (`python3 -m http.server -d pool/web`). It needs
no build step and no framework. It follows the Beam Explorer's design (palette, type, header and
footer, chart style), and its network numbers come live from the Explorer's public API, including
every other Beam pool. It reads the pool's own data from `/api/*` as described in
[`pool/API.md`](pool/API.md); until the server exists, it shows clearly labelled demo data. From
localhost, `?api=<url>` points it at another server; on a public host the parameter is ignored.

Every value from an API is typed and escaped before it reaches the page. The pool fee is **0.5%**
on PPLNS and solo alike, with no payout fee. The block reward is derived from the height with the
core's emission rule (25 BEAM today, 12.5 from height 4,730,400), so it stays right without a
redeploy. Payouts need an **offline** Beam address: a regular one expires and needs the wallet
online, so the guide asks for the offline kind and the login warns otherwise.

## License

[Apache-2.0](LICENSE), the same license as the Beam core, whose code `oracle/third_party/beam`
reuses unchanged.
