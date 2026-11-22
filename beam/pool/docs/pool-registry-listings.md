# Where the pool is listed

Places that list Beam pools or where the pool can be announced: what was sent, when, and where it stands.
Pool: https://pool.bumblebeam.org, stratum `stratum.bumblebeam.org`: 3333/3443 PPLNS and 3334/3444 SOLO
(plain/TLS), 1130/1131 TLS PPLNS for HeroMiners' miners (since 2026-11-19); 0.5% fee; stats API
https://pool.bumblebeam.org/api/stats. The server is in Finland.

## Listed

| Where | Page | Since | Notes |
|---|---|---|---|
| MiningBoard | https://miningboard.com/pools/pool.bumblebeam.org | 2026-10 | reads /api/miningboard (miningboard-pool-v1); footer mark |
| MiningChamp | https://miningchamp.com/coin/beam | 2026-10-27 | network hashrate/difficulty also from our API; they offered featured placement and co-announcements; footer mark |
| MiningPoolStats | https://miningpoolstats.stream/beam | 2026-10-28 | after several "Missing pool?" forms and a Quick Message; reads the report fields of /api/stats; footer mark (own drawing of their icon) |
| minerstat | https://minerstat.com/pool/bumblebeam | 2026-11-17 | hashrate and miners only; fee, PPLNS/SOLO, min. payout and Sol/s reported as missing data 2026-11-17; footer mark |
| WhatToMine | https://whattomine.com/coins/294-beam-beamhashiii | 2026-11-19 | after three pool request forms and a Discord #pools message; Finland, 0.50%, hashrate and miners from our API; footer mark (f1df3ce); thanks posted in their Discord #pools |
| NiceHash marketplace | https://www.nicehash.com (BEAMV3) | 2026-10-08 | see "NiceHash" below |
| NiceHash Compatible Pools | https://www.nicehash.com/compatible-pools | 2026-11-17 | after their review of our orders; footer mark, link in the /connect NiceHash tab, announced to the Beam community |
| MiningRigRentals | https://www.miningrigrentals.com/pools | 2026-11-20 | first under "Suggested Pools", for a reciprocal banner: theirs is in our footer (223dfad) and the /connect MRR tab explains renting; they asked for a banner with the pool name instead of the square logo: `brand/banner-pool-700x300.png`, served as /img/bumblebeam-banner-700x300.png, sent in ticket 353611 2026-11-20 |
| Beam explorer (BeamTerminal) | https://explorer.beam.mw/#/explorer/mining | 2026-10-08 | patch to `backend/src/mining/pools.ts`, merged |

## Waiting

| Where | Page | How | Last sent | Status |
|---|---|---|---|---|
| HeroMiners (left Beam 2026-11-20) | https://beam.herominers.com | Discord #beam on their server | 2026-11-19 | asked for a "Staying on Beam?" line in their banner and for their stratum hosts to point at us; our side is ready (ports 1130/1131, `=diff` logins, /connect HeroMiners tab). Beam community Telegram post by the owner the same day |
| hashrate.no | https://hashrate.no/coins/BEAM/pools | submit form, Pool tab | 2026-10-25 | no answer; their list still has the dead Leafpool. Next: info@hashrate.no or their Discord |
| MinerCompare | https://minercompare.com/crypto-mining-pools | email from info@ | 2026-11-17 | with mockups of a pool page and of their /coin/beam algorithm block, ready-to-paste data and fixes for that page |
| PoolBay | https://poolbay.io/crypto/311/beam/ | email from info@ to the address on their contact page | 2026-11-17 | their domain has no mail (admin@ bounced); the Beam page shows price only |
| Stelareum | https://www.stelareum.io/en/mining/pool.html | email, then Telegram (their PR contact) | 2026-11-17 | two emails without answer; follow-up by the owner in Telegram |
| miningpoolstats.net (not MiningPoolStats) | https://miningpoolstats.net/coins/ | Telegram only (their channel) | 2026-11-17 | no Beam page yet; a message and two mockups (coin page, pool card) prepared for the owner to send |
| MiningPoolsList | https://miningpoolslist.com/beam-mining-pools/ | Google form | 2026-10-25 | site unchanged since 2019 |
| Awesome Miner | predefined BeamHash III pools (NiceHash only) | contact form, feature request | 2026-10-25 | no answer; free-edition requests may be ignored |
| MinerBox (phone app) | Beam: 2Miners, HeroMiners | email | 2026-10-25 | asks for integration through `/api/miners/{address}`; no answer |
| Blockwatch X (iOS app, last update 2021) | | email | 2026-10-25 | no answer |
| Mining Monitor 2 (Android) | 56 pools | email to the developer | 2026-11-03 | adds pools on request; the older Mining Monitor (50K+ installs, Beam on 2Miners, HeroMiners...) was not named, ask for both |
| coinguides.org | https://coinguides.org/mine-beam-beamhash-mining/ | comment on the 2022 guide | 2026-10-14 | in moderation |
| Bitcointalk | | own thread (topic 5596205) and a reply in the Beam ANN thread | 2026-10-08 | posted |

### Open pull requests

| Repository | PR | Since | Notes |
|---|---|---|---|
| minershive/hive-pooltemplates (HiveOS pool drop-down) | https://github.com/minershive/hive-pooltemplates/pull/1859 | 2026-10-08 | `pool_templates/bumblebeam.json`, TLS ports 3443/3444 |
| BeamMW/beam-web (beam.mw/mining) | https://github.com/BeamMW/beam-web/pull/388 | 2026-10-08 | links the explorer's pool list and MXBM; names no pool |
| RainbowMiner | https://github.com/RainbowMiner/RainbowMiner/pull/3237 | 2026-10-14 | PPLNS and SOLO pool modules and a balance module; outside add-pool PRs there sit unmerged for months |
| BeamMW/docs-gitbook | https://github.com/BeamMW/docs-gitbook/pull/28 | 2026-10-14 | links the explorer's pool list next to MiningPoolStats; the official docs send miners to MiningPoolStats for pools |
| rust-in-blockchain/awesome-blockchain-rust | https://github.com/rust-in-blockchain/awesome-blockchain-rust/pull/112 | 2026-10-25 | under "Other" |
| MXBM README | by email to the author | 2026-10-25 | a second example with this pool; patches 4/5 of the 2026-10-12 series also pending |

## NiceHash

The pool entry on the marketplace (BEAMV3) uses `stratum.bumblebeam.org:3443`: NiceHash's proxy does not work
on the plain port. Its pool check fails on long offline addresses, so the login is a regular (short) address.
The proxy starts at difficulty 2048 and never goes below, so the pool keeps 2048 as the floor for it (agent
"NiceHash"); `buy/info` gives BeamV3 `min_diff_working` = 8192.

## Not used yet

- Miner developers' chats: lolMiner Discord and Telegram, GMiner Telegram, Discord and Bitcointalk thread.
- Reddit: r/gpumining, r/cryptomining (weekly Q&A thread); r/rust and "Show HN" for the open-source pool.
- Forums: forum.bits.media ("Пулы совместного майнинга"), TechPowerUp and [H]ard Forum mining boards, VoskCoin Talk.
- Write-ups: Habr, dev.to or Medium.
- Poolguard (phone app): request only from inside the app.

## Checked and dropped

- No third-party pool list or no way in: 2CryptoCalc (2Miners' own site), coincalculators.io, CoinWarz, millionminer,
  4miners.pro, hashrateindex, simplemining (BTC), Kryptex (own pool), mmpOS (pools per account), UG-Miner and
  NemosMiner (multi-algo pools only), lolMiner, GMiner and Rigel repos (releases only), Cudo Miner (picks pools itself).
- Dead: wheretomine.io, PoolWatch.io, miningpools.com, poolexplorer.com, pool-stats.com, MultiPoolMiner, CheckPool,
  Cryptunit, investoon.com, forum.beam.mw, RaveOS (shut down 2026-02-01), Mining Pool Monitor (iOS, 2018),
  Proof of Work (app gone from Play), Chinese minerbbs.com and wabi666.com.
- Not worth it: awesomelistsio/awesome-crypto-mining (closes pool submissions), CryptoSlate directory (BTC
  companies), blockspot.io (paid), Pool Monitor (iPhone, BTC), GitHub pool lists (blocklists or archived), Wikipedia
  and Beam wikis (no pool lists, not writable).
