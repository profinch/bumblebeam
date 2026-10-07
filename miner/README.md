# bumblebeam-miner

BeamHash III on the CPU: a miner whose solver finds every solution the Beam core's reference finds, about
a hundred times faster than that reference, and a miner that speaks Beam's stratum to any pool.
Every solution is checked by the oracle (`oracle/`) before it leaves the solver.

This is not a way to earn: a 16-core machine does 0.5–1 Sol/s where an RTX 3090 does 55 at
similar power. It exists as the open reference implementation of the algorithm, a generator of
test solutions for the pool and the oracle, a way to mine from any laptop, server or ARM board
without a GPU, and a load generator for the pool. GPU mining belongs to
[MXBM](https://git.maxnflaxl.dev/maxnflaxl/MXBM).

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

Measured on an Apple M5 Pro (15 threads): 2.5–3.5 s a run, 0.3 runs/s, 0.5–0.75 sol/s, about 11 GB
peak. Memory is allocated per round and freed as soon as the next round exists; keeping it
resident between runs made macOS compress pages and tripled the run time.
