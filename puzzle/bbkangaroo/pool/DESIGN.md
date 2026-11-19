# Pool design notes

## Why a pool helps at all
The time to the first collision of a kangaroo search has a Rayleigh distribution (hazard grows linearly with the
work already done), so two parties that do not share distinguished points (DPs) win with probability proportional to
the square of their rates, and M equal parties that merge their DPs finish √M times sooner than each alone. DPs of
every run with the same range and jump tables are compatible (the jump tables come from a fixed seed), so merging
costs nothing but transport.

## What the MVP does (pool_server.py / pool_client.py)
- Worker: `bbkangaroo -db work.db`; the client ships the journal of new records.
- Server: verifies each record with one scalar multiplication, stores it by x (8 bytes), solves on duplicate x,
  counts shares. Records are 8 + ceil((range + 8) / 8) bytes (27 at range 140); the client reads the length from
  the DB header.
- A record is a proof of about 2^DP jumps: producing one without walking costs 2^DP scalar multiplications, about
  500 times more than walking.

## What is missing, in order

### 1. Shares that mean payout
One share = one verified DP. A worker's expected contribution to the solve is proportional to its shares (every DP
represents the same expected number of jumps), so a PPLNS-style split of the prize by shares is fair. The server
publishes the share table at /stats; the payout itself is a human agreement until 3 below exists.

### 2. Blinded starts (the server must not be needed to steal, and no worker can steal alone)
Today a wild record's distance d plus the public target tells anyone with the colliding tame the key. With the
server choosing a secret offset per worker, s_w, and giving the worker only the point s_w·G, the worker starts its
wild kangaroos at −Q' + (d_p + s_w)·G, knows d_p, and reports d_p. A collision gives the key only as a sum of a
worker-known part and a server-known part. Implementation: `-wildofs <hex point>` in bbkangaroo (added to the wild
base point), the server keeps s_w per worker, verification uses the blinded base. Cost: none on the GPU.

### 3. Payout without a trusted operator
k is linear in the colliding distances, so the two owners of a tame-wild (or wild-wild) collision hold additive
shares of the key. A two-party ECDSA signing protocol (Lindell 2017, DKLs 2018/2019 class, open implementations
exist) lets them sign a pre-agreed payout transaction (the prize split by shares) without either learning k. The
puzzle outputs are P2PKH, so plain ECDSA is required, not Schnorr/MuSig. This is the largest piece and should be
done only when a real target is being worked on.

### 4. Server robustness
- Store: the server appends every accepted record to `pool_records.bin` and reloads it on start. For a real target
  the table grows to 2^30+ records (27 bytes each at range 140, 2^38 records = 7 TB at DP 32); the Python dict must
  then give way to an on-disk sorted store (LMDB, or the
  bbkangaroo DB file plus periodic `-merge` on a machine with the GPU client code).
- TLS and worker tokens (a stolen token can only submit work, not read anything useful).
- DP > 32: bbkangaroo's GPU DP test uses 32 bits of x; a pool that needs fewer records can filter on the host.

### 5. Things not to do
- Do not restart workers from scratch: the DB and the kangaroo state are the work; a restart without them loses the
  square of what was done.
- Do not publish DP files or journals: anyone with a compatible database can take the collision.
