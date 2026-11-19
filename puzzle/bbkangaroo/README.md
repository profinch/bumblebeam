# bbkangaroo

Fork of [RCKangaroo](https://github.com/RetiredC/RCKangaroo) v3.1 (GPLv3, RetiredCoder): SOTA kangaroo solver for
the secp256k1 interval ECDLP on NVIDIA GPUs. v3.1 is the base because its "old GPU" kernel is the fastest one for
pre-Ada cards (sm_86: 3.8 GKeys/s on an RTX 3090 against 2.9 for the v4.0 CUDA path); v4.0's turbo assembler kernels
only exist for sm_89/sm_120.

## What is changed against v3.1

- Build: Linux `Makefile` (host compiler g++-12 for nvcc 12.0, native SASS for `ARCH`, default 86).
- Fixes: KernelB loop-table indexing (ported from v4.0); herd type of boundary kangaroos (see -verify); operations are counted every iteration, not only when DPs
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
  wild = ±PntA + d·G) and reports bad records; with a running search it also checks every incoming DP and names the
  kangaroo. This is the proof-of-work check a pool needs. It found an RCKangaroo bug: the GPU labelled the herd type
  of a DP as `3*kang_ind/KangCnt` while the host assigns herds by integer thirds, so the two kangaroos at the herd
  boundaries produced records of the wrong type (about 1 record in 10^4, visible as "Collision Error"). Fixed; a
  full database now verifies with 0 bad records.
- Loop exit: after KernelB detects a cycle, the distance keeps being integrated and KernelC escapes from the
  kangaroo's current point, so point and distance can never drift apart (RC froze the distance and rewound the
  point from a saved slot).
- `-blocks N`: use only N SM blocks (fewer kangaroos): K benchmarks at small ranges, shared GPUs.
- `-layout 0|1`: herd start layout. 0 = RCKangaroo (tame in [0,N/16), wild |d| uniform in [0,N/2)).
  1 (default) = tame in [0,N/20), wild |d| 90% uniform in [0,N/2) plus 10% in [0.4N,0.5N): −3% operations in a
  generic-group simulator. On the GPU (RTX 3090, `-dp 10 -range 60 -blocks 4`, ~4600 random keys per layout in three
  alternating rounds, K with DP and GPU overheads): layout 1 K=1.403±0.009, layout 0 K=1.426±0.009, a 1.6% gain at
  about 1.8σ; the medians are equal, the gain sits in the long-walk tail. Treat it as 1–2%, not proven at 3σ.
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

## Pool (pool/)

`pool/pool_server.py` (aiohttp + coincurve) and `pool/pool_client.py` (standard library only) turn the journal into a
pool: every worker runs `bbkangaroo ... -db work.db`, the client ships the new records of `work.db.journal` to the
server, the server recomputes every record with one scalar multiplication (a record that does not verify is
rejected; a faked record would cost more than walking), keeps one table keyed by x, checks each duplicate x for a
collision with the candidate-key formulas, writes `FOUND.txt` when the target key is found, and counts shares per
worker (one share = one verified DP = about 2^DP jumps). Tested: two half-work workers on a 52-bit key, the key
came out of the cross-worker collision at the pool, no GPU work at the pool.

```
pool_server.py --job job.json --port 8800            # job.json: range, start, pubkey, dp, jumps_hash (DB header bytes 16..23)
pool_client.py --db work.db --server http://pool:8800 --worker rig1
GET /stats, GET /job
```

Not yet: payout rules, blinded starts (the server knowing a share of every distance), TLS and worker authentication.

## Escape jumps and very long walks (`-smallesc 1`)

RCKangaroo escapes a detected 2-cycle with a jump of about N/1024 (table 2) and longer loops with about N/4096
(table 3), with the sign given by the point's parity. Every kangaroo therefore performs a random walk of ±N/1024
steps once per ~1024 jumps, so after W jumps it has drifted about √(W/1024)·N/1024 from its start. In RC's
benchmarks W is small and this is invisible; on a target like #140 with 2^30 kangaroos each walking 2^37 jumps the
drift is about 10 N, the herds leave the interval and K must rise (both code audits raised this; it is not measured
yet because no simulation can reach such walk lengths). `-smallesc 1` makes the escape tables the size of table 1;
the generic-group simulator shows the same K with small escape jumps (1.228 against 1.245 at 128 kangaroos). The
jump tables are part of the pool job: all workers must use the same setting, and `-smallesc 1` databases are not
compatible with RCKangaroo's.
