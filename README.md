# BumbleBeam

Open-source contributions to the [Beam](https://github.com/BeamMW/beam) ($BEAM) privacy blockchain, as a
member of its community: mining tools, a pool and more. Everything here is public, Apache-2.0, and
checked against the Beam core itself.

The first goal is mining. Today one pool holds about 65–75% of Beam's hashrate, and the only open
pool code dates from 2020–2021. On the miner side the open-source
[MXBM](https://git.maxnflaxl.dev/maxnflaxl/MXBM) (CUDA, OpenCL, Metal, Apache-2.0) already
competes with the closed miners, so bumblebeam does not write a GPU miner: it builds the open
pool, tested against the Beam core, a CPU miner as the readable reference, and lends MXBM its
oracle and test vectors.

| Part | What it is | Status |
|---|---|---|
| [`oracle/`](oracle) | BeamHash III verification and difficulty checks, tested against the Beam core and real mainnet blocks | **done** (step 1) |
| [`vectors/`](vectors) | Test vectors: real mainnet headers, the core's difficulty decisions, full solution sets from the reference solver | **done** (step 1) |
| [`tools/hdrdump`](tools/hdrdump) | Dev tool that pulls headers from a Beam node and has the core validate them | **done** (step 1) |
| [`api`](api) | BumbleBeam API: plain JSON for bots at explorer.bumblebeam.org/v1 ([docs](explorer/API.md), OpenAPI) and MCP servers for agents at explorer.bumblebeam.org/mcp (chain) and pool.bumblebeam.org/mcp (mining) | **done** |
| [`skills`](skills) | Agent skills for the explorer and the pool | **done** |
| [`explorer/web`](explorer/web) | Block explorer on our own explorer-node: blocks, kernels, confidential assets, contracts with decoded state and calls, peers. explorer.bumblebeam.org | **done** |
| [`pool/web`](pool/web) | Pool web UI in the Beam Explorer style: pool, network (pools, blocks by pool, block times), blocks, miners, payments, start-mining guide with calculator. Served by the pool server; shows labelled demo data when opened without one | **done** |
| [`pool/API.md`](pool/API.md) | Pool HTTP API, readable as-is by the Beam Explorer's pool adapter | spec |
| [`docs/deploy.md`](docs/deploy.md) | How to put the node, wallet-api, PostgreSQL and the pool on a server: systemd units in [`pool/deploy`](pool/deploy), or the Docker stack in [`deploy/docker`](deploy/docker) | guide |
| [`pool/server`](pool/server) | The pool: stratum proxy to our node, oracle share checks, PPLNS and solo accounting, payouts, HTTP API (Rust) | **v0 running on a test server, mainnet** |
| [`miner/`](miner) | CPU miner (Rust): the open reference solver, 100x the core's, every solution oracle-checked, Beam stratum over TLS. 0.5–0.75 Sol/s on an M5 Pro, so a dev tool and a way to mine without a GPU, not an earner. For GPUs use [MXBM](https://git.maxnflaxl.dev/maxnflaxl/MXBM), verified against this pool (RTX 3090: 52 Sol/s, 0 rejects) | **v0** |

## Numbers that set the bar

Measured on 2026-10-06, at height ≈ 4,068,700:

- **Network:** ~45–52 kSol/s at a difficulty of ~2.7 M, down from 25.7 M in January 2024. Pools:
  2Miners ~35 kSol/s, HeroMiners ~4.5 kSol/s, and the rest below 1 kSol/s (Beam Explorer mining page,
  pool APIs).
- **Miners on an RTX 3090**, measured here: lolMiner 1.98a 55–57 Sol/s at ~345 W, MXBM (CUDA)
  51–52 Sol/s. MXBM reports 74 Sol/s on an RTX 4070 Ti SUPER and 78 on an RTX 5080.
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

## CPU miner: download and run

Binaries for Linux x86-64, macOS (Apple Silicon) and Windows x86-64 are on the
[releases page](https://github.com/profinch/bumblebeam/releases) (tags `miner-v*`). Unpack and:

```sh
bumblebeam-miner mine --pool <pool host>:3443 --user <your offline Beam address>.<worker name>
bumblebeam-miner bench 60      # what this machine does: runs/s and sol/s
```

It needs about 7 GB of free memory and all cores; expect 0.5–1 Sol/s on a modern desktop, which
is a dev tool and a way to take part without a GPU, not an income. Every solution is verified by
the oracle before it is sent. Details and tuning in [`miner/README.md`](miner/README.md).

## Pool web UI

Open `pool/web/index.html` through any static server (`python3 -m http.server -d pool/web`). It needs
no build step and no framework. Pages have clean paths (`/network`, `/miners/<address>`); the pool
server answers them with `index.html`, a plain static server only serves `/`. It follows the Beam Explorer's design (palette, type, header and
footer, chart style), and its network numbers come live from the Explorer's public API, including
every other Beam pool. It reads the pool's own data from `/api/*` as described in
[`pool/API.md`](pool/API.md), served by [`pool/server`](pool/server); opened as plain files it
shows clearly labelled demo data. From localhost, `?api=<url>` points it at another server; on a
public host the parameter is ignored.

Every value from an API is typed and escaped before it reaches the page. The pool fee is **0.5%**
on PPLNS and solo alike, with no payout fee. The block reward is derived from the height with the
core's emission rule (25 BEAM today, 12.5 from height 4,730,400), so it stays right without a
redeploy. Payouts need an **offline** Beam address: a regular one expires and needs the wallet
online, so the guide asks for the offline kind and the login warns otherwise.

The operator's dashboard is `/admin` (`pool/web/admin.html`): what waits for a decision (unverified
blocks, stuck payments), live stratum connections and the ones that ended before a login, and the
miners, with a move of everything mined under a wrong address to the right one. It is off until
`[admin] token` is set in pool.toml. Support: [support@bumblebeam.org](mailto:support@bumblebeam.org).

## License

[Apache-2.0](LICENSE), the same license as the Beam core, whose code `oracle/third_party/beam`
reuses unchanged.
