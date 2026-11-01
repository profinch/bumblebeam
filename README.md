# BumbleBeam

An open-source ecosystem around [Beam](https://github.com/BeamMW/beam) ($BEAM) and Bitcoin (BTC):
pools, explorers, wallets, DEX, miners, games and tools. Everything here is public and Apache-2.0.

| Direction | What is in it | Sites |
|---|---|---|
| [`beam/`](beam) | The pool (stratum + app, PPLNS and solo), the BeamHash III oracle and its test vectors, the explorer with its JSON API and MCP server, BumbleBeam Wallet (Chrome extension with the BEAM ⇄ WBEAM bridge), the CPU miner and the desktop apps, research (coinbase payouts, header dumps). Next: a DEX terminal | [pool](https://pool.bumblebeam.org) · [explorer](https://explorer.bumblebeam.org) |
| [`bitcoin/`](bitcoin) | [3BMiner](bitcoin/3bminer): open ESP32 firmware that mines Bitcoin solo on the chip's SHA-256 engine. Next: a puzzle search | puzzle (planned) |
| [`rig/`](rig) | [thermo](rig/thermo): every temperature, fan and voltage of a mining box, GPU fan curves, alerts | |
| [`hive/`](hive) | Planned, shared by all directions: accounts, a ledger of what each miner put in, payouts, a lottery and a game | |

## Layout

```
beam/       the Beam direction: oracle, vectors, pool, explorer (+ api), wallet, miner, research
bitcoin/    the Bitcoin direction: 3bminer
rig/        tools for the mining box, any coin: thermo
hive/       shared services across directions (planned)
deploy/     the production stack: Docker compose, nginx, certbot, host firewall
skills/     agent skills for the explorer and the pool APIs
brand/      the logo, banners and their generators
docs/       ecosystem-wide docs: deployment, support, todo
```

Each product keeps its own README, CHANGELOG and release tags (`miner-v*`, `3bminer-v*`), and CI
builds only the folder that changed. The root `CMakeLists.txt` builds the oracle
(`cmake -S . -B build -G Ninja && cmake --build build && ctest --test-dir build`).

Production runs from [`deploy/docker`](deploy/docker) as described in [`docs/deploy.md`](docs/deploy.md).
Support: [support@bumblebeam.org](mailto:support@bumblebeam.org).

## License

[Apache-2.0](LICENSE), the same license as the Beam core, whose code `beam/oracle/third_party/beam`
reuses unchanged.
