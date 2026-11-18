# bbkangaroo

Fork of [RCKangaroo](https://github.com/RetiredC/RCKangaroo) v3.1 (GPLv3, RetiredCoder): SOTA kangaroo solver for
the secp256k1 interval ECDLP on NVIDIA GPUs. v3.1 is the base because its "old GPU" kernel is the fastest one for
pre-Ada cards (sm_86: 3.8 GKeys/s on an RTX 3090 against 2.9 for the v4.0 CUDA path); v4.0's turbo assembler kernels
only exist for sm_89/sm_120.

## What is changed against v3.1

- Build: Linux `Makefile` (host compiler g++-12 for nvcc 12.0, native SASS for `ARCH`, default 86).
- Fixes: KernelB loop-table indexing (ported from v4.0); operations are counted every iteration, not only when DPs
  arrived (v3.1 undercounted at high DP); the main loop stops when all GPU threads died instead of spinning.
- `-db <file>`: the whole DP database (tame and wild) is saved on exit (ops limit, Ctrl-C, solved) and every
  `-save <minutes>` (default 10). On start the file is loaded again: a run survives restarts. The file header holds
  range, DP, layout, a hash of the jump tables, the target key and start; wild records are loaded only for the same
  target, tame records for any target of the same range and jump tables. RCKangaroo tames files are accepted.
- Exact resume: with `-db` the kangaroo state (point and distance of every kangaroo, 96 bytes each) is written to
  `<db>.kangs` at every save; on restart it is restored and no in-flight work is lost (without it a restart forfeits
  up to 2^DP steps per kangaroo).
- `-merge <file>` (repeatable): streams another database through the collision check; the key can be found while
  merging, without any GPU work. Databases of all runs with the same range are compatible because the jump tables
  come from a fixed seed (as in RCKangaroo).
- `-verify N`: recomputes every N-th record of a merged file with a scalar multiplication (tame = d·G,
  wild = ±PntA + d·G) and reports bad records. This is the proof-of-work check a pool needs. Measured on RC's own
  kernels: about 1 record in 10^4 does not verify (a kangaroo whose distance lost sync with its point after a loop
  exit); such records only cause harmless "Collision Error" lines, a pool server drops them.
- `-blocks N`: use only N SM blocks (fewer kangaroos): K benchmarks at small ranges, shared GPUs.
- `-layout 0|1`: herd start layout. 0 = RCKangaroo (tame in [0,N/16), wild |d| uniform in [0,N/2)).
  1 (default) = tame in [0,N/20), wild |d| 90% uniform in [0,N/2) plus 10% in [0.4N,0.5N): measured −3% operations
  in a generic-group simulator; GPU measurement in progress.
- `-dp` accepts values from 8 (for small-range benchmarks).

## Build and run

```
make                       # ARCH=86 by default; make ARCH="86 89" for several
./bbkangaroo -dp 16 -range 84 -start 1000000000000000000000 -pubkey 03... -db puzzle84.db
./bbkangaroo -dp 16 -range 84 -start ... -pubkey ... -db mine.db -merge other1.db -merge other2.db -verify 100
./bbkangaroo -dp 10 -range 60 -blocks 4 -layout 1          # benchmark mode (random keys), K statistics
```

`bench.sh run <dp> <range> <blocks> <layouts...>` runs benchmark mode for each layout in turn; `bench.sh status`.

## Not changed

The GPU kernels (except the loop-table fix) and the DP record format: DP files stay compatible with RCKangaroo.
