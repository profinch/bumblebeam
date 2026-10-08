# coinbase: miners paid in the block's coinbase (prototype)

Today the pool's node mines with the pool's miner key, so every block reward lands in the pool's wallet,
and the pool pays the miners later. This prototype pays them in the block itself, with outputs that
only the miners can spend. It is the step towards a P2Pool for Beam: the coinbase is the hard part,
and it works. Status: **prototype, tested on an in-process FakePoW chain, not on mainnet.**

## Why Beam needs a different approach

In Bitcoin or Monero, a P2Pool block pays each miner to an address in the coinbase. Beam is Mimblewimble:
whoever creates an output knows its blinding factor and can spend it. So the block builder can't create
outputs for the miners. The miners have to create them.

The Beam core already allows this:

- **Consensus** takes any number of coinbase outputs and kernels. The only rule is that the coinbase
  outputs add up to the block reward plus the fees (`core/block_validation.cpp:270`, since HF6). Each
  coinbase output must have a public value (`core/block_crypt.cpp:462`).
- **Online mining.** A node with an owner key and a connected owner wallet builds the block without a
  coinbase (`Mode::Assemble`), sends the wallet `GetBlockFinalization{height, fees}`, and puts the
  coinbase transaction it gets back into the block (`Mode::Finalize`). `node/node.cpp`,
  `Node::Miner::Restart` and `Node::Peer::OnMsg(proto::BlockFinalization)`.

## How it works

1. **The miner makes pairs.** A pair is a coinbase output for a fixed amount plus a kernel whose excess is
   minus the output's blinding factor. The pair balances by itself: it needs no offset and no co-signer.
   The output is made with the miner key from `beam-wallet export_miner_key --subkey=N` and tagged with
   the wallet's owner key, like the coinbase of a node that mines for that wallet. So the miner's wallet
   finds it through its ordinary UTXO events, and spends it with a key derived from its seed. The kernel
   has no fee, no locks, and the height range `[0, ∞)`, so a pair doesn't expire.
2. **Amounts come from a ladder.** The amounts are powers of two from 2^20 groth (~0.0105 BEAM). On mainnet
   12 steps reach 21.47 BEAM. Any share of a block is a few pairs: 24.875 BEAM (a solo block minus 0.5%)
   is 4 pairs. The miner keeps a stock of every step and tops it up after blocks.
3. **The pool picks the pairs for each block.** When the node asks for the coinbase, the finalizer
   (`Allocator`, `BuildCoinbaseTx`) takes each miner's owed amount from the PPLNS window and covers it
   with that miner's pairs, largest first. The pool's fee, the transaction fees and the rounding go
   to one output of the pool's own. What rounding leaves unpaid stays on the miner's balance.
4. **The finalizer follows the chain.** It reads the kernels of every new block (`GetBodyPack`), marks
   the pairs found there as spent, and doesn't answer for height h+1 until it has read block h.

The pool can't spend the miners' outputs: it never has their keys. The pool can still leave a miner's
pairs out, but every miner can check the chain for its own commitments, block by block.

## The node patch

The stock node accepts only coinbase outputs that its own owner key recognizes
(`node/node.cpp`, "verify that all the outputs correspond to our viewer's Kdf"), and it reserves block
space for a single coinbase output. [`beam-node-foreign-coinbase.patch`](beam-node-foreign-coinbase.patch),
34 lines against BeamMW/beam master `daf7191`, branch `feat/foreign-coinbase` in profinch/beam (not pushed),
adds two options. Both are off by default, so nothing changes unless you set them:

| Option | Effect |
|---|---|
| `--mine_online_foreign=1` | Accept coinbase outputs from the finalizer that the owner key doesn't recognize. If finalization fails in this mode (for example, a kernel is already in the chain, or the block is too large), the node drops the finalizer and keeps mining without it, on its own miner key. |
| `--mine_online_reserve=<bytes>` | Block space kept free for the coinbase when the node assembles a block for finalization. |

Consensus is untouched: a node without the patch accepts these blocks, as the test checks.

## What the test checks

`coinbase_test` runs two nodes in one process on a FakePoW chain with every fork active, so fees go
into the coinbase as on mainnet. The pool's node mines with the patch's options, and a finalizer pays
three miners (weights 0.5, 0.3 and 0.2). The second node is the first miner's own node with stock
settings, and that miner's wallet is connected to it.

- **Pairs:** sign and verify, hex round trip, the wallet's key derivation, and refusal of a changed value,
  a foreign kernel, a kernel fee and a non-coinbase output.
- **Every block is accepted by the stock node:** both nodes end on the same tip hash.
- **Every coinbase output in the chain belongs to exactly one key.** The pool's key recognizes none of
  the miners' outputs, and each miner's on-chain total equals what the finalizer paid it.
- **The miner's wallet finds every coinbase coin** through ordinary `GetEvents` and spends one in a plain
  transaction. The transaction is mined, and its fee goes into the next coinbase.
- **A pair whose kernel is already in the chain:** the node drops the finalizer once, the finalizer
  reconnects, and no block is lost.
- **Without `--mine_online_foreign`** the node refuses every coinbase with miners' outputs and mines on
  its own key.

A typical run, 3 s:

```
Pairs...
  one pair: 249 bytes (output 151, kernel 98)
  24.875 BEAM is 4 pairs, 277728 groth short
Chain...
  pool node at 15, miner's node at 15, finalizations 16, finalizer dropped 4 times
  blocks with miners' pairs: 12, with the pool's coinbase only: 3 (of 15)
  most pairs in one coinbase: 22
  m1's wallet: 95 coinbase coins, 477.57393920 BEAM, one spent
all checks passed
```

## Size

A pair is 249 bytes. On mainnet (25 BEAM a block), a solo block is about 4 pairs (1 KB). A PPLNS
miner gets about 6 pairs per block on average (1.5 KB), so 100 paid miners take about 150 KB of the
1 MB block. The allocator stops at `m_MaxSize`. Miners left out of a block keep their balance.

## Build and run

```sh
git -C ~/git/beam worktree add -b feat/foreign-coinbase ~/git/beam-cb daf719156
git -C ~/git/beam-cb apply ~/git/bumblebeam/tools/coinbase/beam-node-foreign-coinbase.patch
# configure and build ~/git/beam-cb-build as in ALL_ABOUT_BEAM.md §5.1, then: ninja node beam-node
BEAM_SRC=~/git/beam-cb BEAM_BUILD=~/git/beam-cb-build tools/coinbase/build.sh
cd /some/scratch/dir && ~/git/bumblebeam/tools/coinbase/coinbase_test   # writes two node databases here
```

`CB_DEBUG=1` prints each finalization.

## From prototype to the pool

1. **Upstream the node options** as a PR to BeamMW/beam. Until it is merged, the pool runs the patched node.
2. **`bb-coinbase`, the miner's tool:** imports the exported miner and owner keys, makes the ladder stock,
   uploads it, and checks the chain for its own outputs. The miner key stays on the miner's machine.
3. **Pair intake in the pool:** `VerifyPair`, a check that the kernel is not in the chain
   (`GetProofKernel2`), and an identity for each stock. The stratum login names a public key, and
   uploads are signed with it, so nobody can put their own pairs into someone else's stock.
4. **The finalizer as a daemon** next to the node: this code plus the pool wallet's seed, which the
   node requires for owner login. The pool server gives it the owed amounts. If it is down, the node
   mines on its own miner key, as today.
5. **Accounting:** a block pays the PPLNS window as it was when the coinbase was built (the P2Pool rule).
   Rounding and the miners left out stay on balances, which the existing payouts pay.
6. **Later, a sharechain** in place of the pool server's window: the same pairs, with no operator in the middle.
