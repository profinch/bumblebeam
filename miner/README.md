# bumblebeam-miner

BeamHash III on the CPU: a miner whose solver finds every solution the Beam core's reference finds, about
a hundred times faster than that reference, and a miner that speaks Beam's stratum to any pool.
Every solution is checked by the oracle (`oracle/`) before it leaves the solver.

This is not a way to earn: a 16-core machine does 0.5–1 Sol/s where an RTX 3090 does 55 at
similar power. It exists as the open reference implementation of the algorithm, a generator of
test solutions for the pool and the oracle, a way to mine from any laptop, server or ARM board
without a GPU, and a load generator for the pool. GPU mining belongs to
[MXBM](https://git.maxnflaxl.dev/maxnflaxl/MXBM).

## Download and run

Archives for Linux x86-64, macOS (Apple Silicon) and Windows x86-64 are on the
[releases page](https://github.com/profinch/bumblebeam/releases). Unpack, then:

```sh
./bumblebeam-miner mine --pool <pool host>:3443 --user <your Beam address>.<worker name>
```

- The machine needs about 7 GB of free memory; the miner refuses to start with less
  (`BB_ALLOW_LOW_MEMORY=1` to try anyway) rather than die mid-run.
- TLS is on by default, as Beam pools expect; `--tls 0` for a plain port.
- macOS: a binary downloaded with a browser is quarantined; allow it once with
  `xattr -d com.apple.quarantine bumblebeam-miner`. The binary is ad-hoc signed, not notarised.
- Windows: the build is produced and unit-tested by CI but has not been run on a real machine yet;
  reports welcome.
- Pools differ in what address they take: bumblebeam asks for an offline address, 2Miners accepts
  only a regular one, SunPool wants its own key. Shares at a fixed difficulty of 512 (2Miners) come
  from a CPU every few minutes; bumblebeam lowers the difficulty for slow workers.
- A run on the old block is cut short when the pool announces a new one, so there are no stale
  shares from a 2-4 s run.

## Build from source

```sh
cargo build --release
./target/release/bumblebeam-miner bench 60          # runs/s and sol/s on this machine
./target/release/bumblebeam-miner check ../vectors   # re-solve mainnet headers: their solutions must appear
./target/release/bumblebeam-miner solve <input-hex> <nonce-hex> [extra-nonce-hex]
./target/release/bumblebeam-miner mine --pool pool.example.com:3443 --user <address>.<worker> [--tls 0|1] [--threads N]
```

How it works (docs/beamhash3.md has the algorithm): 2^25 elements of 448 bits from SipHash-2-4,
then five rounds that mix the first leaves of each element's tree into its bits, bucket the
elements by 24 bits (4096 buckets on the top 12 bits, a sort inside each), and merge every
colliding pair into the next round's element with its parents and the leaves the next mix will
need. The fifth round's pairs whose remaining 24 bits also cancel are solutions; their 32 leaves
are read back through the parents, packed, and verified.

Measured: Apple M5 Pro (15 threads) about 2 s a run, 0.5 runs/s, ~1 sol/s; Ryzen 9 5900X with
DDR4-2400 (24 threads) 4 s a run, 0.25 runs/s, ~0.5 sol/s, the same at 12 threads, so there the
memory bus is the limit. Two solutions a run on average, about 7 GB peak (arrays freed round by
round; BB_REUSE=1 keeps them between runs, which did not help on the M5 Pro and swamped a 15 GB
server). The first version took 3 s a run on the M5 Pro; the gains came from writing each round
straight into the next round's buckets with the mix precomputed, a counting sort inside each
bucket, and keeping the hot loop free of allocator calls (one stash and one scratch buffer per
thread, found with a sampling profiler to be where half the time went). The stash chunk size is
8 on Apple Silicon and 2 on x86 (BB_CHUNK overrides); BB_TRACE=1 prints the time per phase.
Next: packing work bits and leaves to their exact widths to cut bytes per element, which is what
the memory-bound x86 case needs.
