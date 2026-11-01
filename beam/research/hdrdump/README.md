# hdrdump

Dev-only. Produces `beam/vectors/mainnet_headers.json` and `beam/vectors/difficulty.json`, the ground truth
`oracle/` is tested against. It links a Beam core build, so every header it writes has been validated
by the core (`core_valid`) and every difficulty case is decided by the core.

```sh
BEAM_SRC=~/git/beam BEAM_BUILD=~/git/beam-build beam/research/hdrdump/build.sh
beam/research/hdrdump/hdrdump headers eu-nodes.mainnet.beam.mw:8100 777770:24 1500000:8 2628000:8 \
  3000000:8 3928658:16 4068500:64 > beam/vectors/mainnet_headers.json
beam/research/hdrdump/hdrdump difficulty 1000 > beam/vectors/difficulty.json
```

`h0:count` asks for `count` headers starting at height `h0`. The node answers
`EnumHdrs{Min, Max}` with the headers that **end** at `Min` (`Node::Peer::OnMsg(proto::EnumHdrs)`
walks backwards from `Min`), and hdrdump compensates for that.
