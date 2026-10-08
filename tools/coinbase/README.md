# coinbase: miners paid in the block's coinbase

Today a pool's node mines with the pool's miner key, every block reward lands in the pool's wallet,
and the pool pays the miners later from there. This pays them **in the block itself**, with outputs
only the miners can spend. The pool is no longer custodial: it can leave a miner out of a block, but
it cannot take or hold the miner's money. It is the step towards a P2Pool for Beam, where the coinbase
is the hard part.

Status: **complete and tested end to end on a private chain** (a patched node, the real pool server,
the finalizer, the miner's tool, the CPU miner and the real `beam-wallet`), not yet run on mainnet.

```
miner's wallet ── export_miner_key / export_owner_key ──> bb-coinbase ── pairs, signed ──> pool server
miner's rig    ── stratum login cb:<key>.rig ──────────────────────────────────────────> pool server
                                                                                              │ coinbase link
pool's node (patched) ── GetBlockFinalization ──> bb-finalizer <── pairs for this block ──────┘
                     <── BlockFinalization ──── (mining wallet's output for the rest)
pool's node ── block bodies ──> bb-finalizer ── kernels, headers ──> pool server (pairs mined, blocks confirmed)
miner's node (stock, with the miner's owner key) ── UTXO events ──> miner's wallet
```

## Why Beam needs a different approach

In Bitcoin or Monero a P2Pool block pays each miner to an address in the coinbase. Beam is
Mimblewimble: whoever creates an output knows its blinding factor and can spend it, so the block
builder cannot create outputs for the miners. The miners have to create them, in advance.

The Beam core already allows this:

- **Consensus** takes any number of coinbase outputs and kernels; the only rule is that they add up to
  the block reward plus the fees (`core/block_validation.cpp`, since HF6), and each coinbase output has
  a public value.
- **Online mining.** A node with an owner key and a connected owner wallet builds the block without a
  coinbase (`Mode::Assemble`), asks the wallet `GetBlockFinalization{height, fees}` and puts the
  coinbase transaction it gets back into the block (`node/node.cpp`, `Node::Miner::Restart` and
  `Node::Peer::OnMsg(proto::BlockFinalization)`).

## How it works

1. **The miner makes pairs** (`bb-coinbase top-up`). A pair is a coinbase output for a fixed amount
   plus a kernel whose excess is minus the output's blinding factor. The pair balances by itself: no
   offset, no co-signer. The output is made with the miner key from `beam-wallet export_miner_key
   --subkey=N` and tagged with the wallet's owner key, exactly like the coinbase of a node that mines
   for that wallet, so the wallet finds it through its ordinary UTXO events and spends it with a key
   derived from its seed. Amounts are a **ladder** of powers of two from 2^20 groth (0.0105 BEAM), 12
   steps to 21.47 BEAM; three pairs of each step is the default stock, 36 pairs, 9 KB.
2. **The account.** The miner's identity at the pool is a key derived from the miner key:
   `cb:<public key>` is the stratum login (plus `.worker`), and every upload is signed with it, so
   nobody can put pairs into someone else's stock. No wallet address is involved at all.
3. **The pool keeps the stock** (`POST /api/coinbase/pairs`). The finalizer checks the signature and
   each pair: a coinbase output with a public value, a standard kernel without fee or locks, the two
   balancing to value·H, and the kernel valid at the next block. The pool refuses values off the
   ladder, duplicate kernels or commitments, and pairs that would expire soon.
4. **The pool picks the pairs for each block.** When the node asks for a coinbase, the finalizer asks
   the pool server, which takes what every account is owed (its balance from earlier blocks plus its
   share of this block by the PPLNS window) and covers it with that account's pairs, largest first,
   within the block space. The finalizer verifies the pairs once more, adds one output of the mining
   wallet for the rest (fee, transaction fees, rounding) and answers the node. If the pool server is
   down or slow, the finalizer answers with a pool-only coinbase: mining never waits for payouts.
5. **The finalizer follows the chain.** It reads every block's header and kernels (`GetHdrPack`,
   `GetBodyPack`), reports them to the pool, and does not answer for height h+1 before it has read
   block h, so a pair is never offered twice. The pool marks the pairs mined and writes one `pending`
   payment per account and block. Those same headers confirm or orphan the pool's blocks: a confirmed
   block completes its payments and settles the balances, an orphaned one fails them and frees the
   pairs; a reorganization does the same for every block it dropped.
6. **Kernel lifespan.** After HF2 a kernel is valid for 43 200 blocks (30 days) from its minimum
   height, so pairs expire; the pool stops offering them 100 blocks earlier and `bb-coinbase top-up`
   (run daily from cron) replaces what was spent or expired.

The miner's wallet sees its coinbase coins the way any Beam miner's does: through a node that holds
its owner key (`beam-node --owner_key`), or the desktop wallet's own node. A pool block pays several
miners at once, each in its own outputs.

## Parts

| Part | Where | What |
|---|---|---|
| `coinbase.h/.cpp` | here | pairs, ladder, allocator, identity and upload signatures, key import, seed → master key |
| `bb-finalizer` | `finalizer.cpp` | daemon next to the pool's node: owner login, block finalization, chain follow, pair verification for the pool server |
| `bb-coinbase` | `bb-coinbase.cpp` | the miner's tool: `init`, `identity`, `top-up`, `status`, `make`, `keyinfo` (uploads with curl) |
| pool server | `pool/server/src/coinbase.rs`, `db.rs`, `accounting.rs` | the stock, the allocation, the link, payments and confirmations; `[coinbase]` in `pool.toml`, `GET /api/coinbase`, `POST /api/coinbase/pairs` |
| node patch | `beam-node-foreign-coinbase.patch` | 41 lines against BeamMW/beam `daf7191` (branch `feat/foreign-coinbase` in profinch/beam) |
| tests | `coinbase_test.cpp`, `pool/server/tools/e2e_coinbase.py`, `lab.sh` | see below |

## The node patch

The stock node accepts only coinbase outputs that its own owner key recognizes (`node/node.cpp`,
"verify that all the outputs correspond to our viewer's Kdf") and reserves block space for a single
coinbase output. The patch adds, all off by default:

| Option | Effect |
|---|---|
| `--mine_online_foreign=1` | Accept coinbase outputs from the finalizer that the owner key doesn't recognize. If finalization fails in this mode (a kernel already in the chain, a block too large), the node drops the finalizer and keeps mining without it, on its own miner key. |
| `--mine_online_reserve=<bytes>` | Block space kept free for the coinbase when the node assembles a block for finalization. |
| `--pow_solve_time` on a FakePoW chain | Lets a FakePoW test chain mine from the command line (its stratum server, or threads with the fake solver); before, mining was off whatever the options said. For test chains only. |

Consensus is untouched: a node without the patch accepts these blocks, as both tests check.

## Running it

**Operator** ([deploy.md §7b](../../docs/deploy.md)): a mining wallet of its own (its owner and miner
keys in the node's config with `mine_online=1 mine_online_foreign=1 mine_online_reserve=65536`, its
seed for the finalizer), `bb-finalizer` as a service, `[coinbase] enabled = true` in `pool.toml`.

**Miner:**

```sh
beam-wallet export_miner_key --subkey=1     # -> "Secret Subkey 1: <string>"
beam-wallet export_owner_key                 # -> "Owner Viewer key: <string>"
bb-coinbase init --miner_key <string> --owner_key <string> --subkey 1     # asks the wallet password
bb-coinbase identity                          # cb:…  -> mine with  cb:….rig1  as the login
bb-coinbase top-up --pool https://pool.bumblebeam.org                     # 36 pairs; repeat daily (cron)
bb-coinbase status --pool https://pool.bumblebeam.org
```

The keys stay encrypted as the wallet exported them (`~/.bb-coinbase.json`, mode 600); the password
comes from `--pass`, `BB_PASS` or a prompt. The pool's page for the account shows the stock, the
blocks that paid it and the payments, and the wallet shows the coins once its node has the owner key.

**Build** (needs a Beam core build tree with the patch; macOS/Homebrew or Linux):

```sh
git -C ~/git/beam worktree add -b feat/foreign-coinbase ~/git/beam-cb daf719156
git -C ~/git/beam-cb apply ~/git/bumblebeam/tools/coinbase/beam-node-foreign-coinbase.patch
# configure and build ~/git/beam-cb-build (cmake -G Ninja, then: ninja beam-node beam-wallet)
BEAM_SRC=~/git/beam-cb BEAM_BUILD=~/git/beam-cb-build tools/coinbase/build.sh all   # or test|finalizer|miner
```

## What is tested

**`coinbase_test`** (in-process, 3 s): two nodes on a FakePoW chain, the pool's with the patch's options
and a finalizer paying three miners, the other a miner's stock node with that miner's wallet attached.
Pairs sign, verify, round-trip and are refused when changed; every block is accepted by the stock
node (same tip hash); every coinbase output belongs to exactly one key; the miner's wallet finds every
coin and spends one; a pair whose kernel is already in the chain makes the node drop the finalizer
once and lose no block; without `--mine_online_foreign` the node refuses the miners' outputs.

**`pool/server/tools/e2e_coinbase.sh`** (the pool server alone, a fake node, miner and finalizer):
login with an account, uploads (accepted, rejected with reasons, duplicates, bad signature, shape
errors), the allocation against a balance, kernels reported → pending payment, the chain passing
maturity → block `confirmed` by `node`, payment `completed`, balance and paid settled.

**`lab.sh`** (everything real on one machine, a private chain with 3-second blocks): the patched
`beam-node` with its stratum server, `bb-finalizer`, the pool server with `[coinbase]`, `bb-coinbase`
making and uploading the stock, `bumblebeam-miner` logging in with the account, a second stock node
holding the miner wallet's owner key, and `beam-wallet` itself. A run on 2026-10-08:

| | |
|---|---|
| blocks mined by the pool | 50 in 25 min, 43 confirmed by the node's chain, 0 orphaned |
| pairs paid | 216 in 12 blocks, 772.9 BEAM, all 12 payments `completed` |
| the miner's `beam-wallet info` | Available coinbase 772.9 BEAM, every coin `Confirmed` with its pair's index |
| a spend from those coins | 100 BEAM to the wallet's own address: `Transaction completed`, its fee in the next coinbase |
| stock | 36 pairs re-made by `top-up` after the first ones were spent |

`lab.sh up` runs it (`LAB`, `BEAM_BUILD`, `REPO`, `DBURL_FILE` to taste), `lab.sh wallet` prints the
wallets' view, `lab.sh status` the pool's, `lab.sh down` / `reset` stop it or start a new chain.

## Size and limits

A pair is 249 bytes. On mainnet (25 BEAM a block) a solo block is about 4 pairs (1 KB); a PPLNS miner
gets about 6 pairs per block on average (1.5 KB), so 100 paid miners take 150 KB of the 1 MB block;
`max_coinbase_bytes` (64 KB by default) caps it and `--mine_online_reserve` must be at least that.
Amounts below the ladder's unit (0.0105 BEAM) wait on the balance. The link between pool server and
finalizer is loopback and unauthenticated by design: keep it there.

## Next

- A PR of the node patch to BeamMW/beam (the pool runs the patched node until then).
- Release binaries of `bb-coinbase` (Linux, macOS, Windows) next to the CPU miner's.
- A sharechain in place of the pool server's PPLNS window: the same pairs, no operator in the middle.
