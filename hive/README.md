# BumbleBeam · Hive

Planned: what every direction of [BumbleBeam](../README.md) shares. Nothing is built yet.

| Part | What it will be |
|---|---|
| `accounts/` | Sign-in by a signature of the miner's own address (the scheme the coinbase pair upload already uses), from BumbleBeam Wallet |
| `ledger/` | An append-only journal of what each miner put in (pool shares, rented hashrate pointed at the pool, puzzle work, devices, deposits), valued at the time it came in; balances are derived from it |
| `payout/` | The one process that talks to the wallet and pays out, with the pool's payout state machine (txId idempotency, review, backoff) moved here from `beam/pool/server` |
| `luck/` | A lottery: tickets from the ledger or in BEAM; randomness from an operator commit-reveal, a future block hash and drand together, since the pool finds blocks itself |
| `game/` | A game whose currency is what miners put into the hive |
