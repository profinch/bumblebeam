# Where the pool is listed

Every place that lists Beam pools or where a pool can be announced, what was sent and when.
Pool: https://pool.bumblebeam.org, stratum `stratum.bumblebeam.org` ports 3333/3443 PPLNS and 3334/3444 solo
(plain/TLS), plus 1130/1131 TLS PPLNS for HeroMiners' miners (since 2026-11-19), 0.5% fee on each, stats API at https://pool.bumblebeam.org/api/. The server is in Finland;
the public address is an AWS us-east-1 front, so IP geolocation says Virginia.

## Submitted

| Where | Beam pools page | How it was sent | Date | Status |
|---|---|---|---|---|
| MiningBoard | https://miningboard.com/pool-stats/beam | not recorded, probably https://miningboard.com/pools/submit | 2026-10 | **listed**, https://miningboard.com/pools/pool.bumblebeam.org. 2026-10-27: confirmed the footer mark; sent an outlined mark.svg (brand kit at /brand-kit), swapped in 607a897; replied offering /v1/network data and asking about featured placement and co-announcements |
| MiningPoolStats | https://miningpoolstats.stream/beam | "Missing pool?" form on that page (pool URL + API URL), several times without a result; then the footer's envelope form "Quick Message to MiningPoolStats" with the owner's address for a reply (125 blocks in 24 h) | 2026-10-08, 2026-10-09, 2026-10-25 | **listed by 2026-10-28** (https://miningpoolstats.stream/beam). Footer mark live 2026-10-28 (9a739c4, own drawing of their pick-and-shovel icon, `beam/pool/web/img/miningpoolstats.svg`), order MiningBoard, MiningChamp, MiningPoolStats. They have no email: the footer's Quick Message form now has a Cloudflare Turnstile captcha, so the thank-you/badge note went by hand: sent 2026-10-28 from the owner's address (thanks, footer link, ports, API fields offer) |
| WhatToMine | https://whattomine.com/coins/294-beam-beamhashiii | https://whattomine.com/pool_requests/new?coin_id=294 | 2026-10-08 | sent 10-08 and 10-11, no answer (Beam page lists only 2miners, HeroMiners, Sunpool.top). 2026-11-17: form a third time (info@, /api/stats, custom open source, 0.5, EU (Finland)) and a message in their Discord #pools (server 528138523199668234; the admin answering pool requests there is fred) with figures and our other listings. Waiting |
| minerstat | https://minerstat.com/pool/bumblebeam | https://minerstat.com/submit | 2026-10-08 | **listed** (seen 2026-11-17) with hashrate and miners only; 2026-11-17 sent "Report an issue or missing data" on the pool page: fee 0.5%, PPLNS/SOLO, min. payout 1 BEAM from /api/stats, unit Sol/s not kH/s. Footer mark live 2026-11-17 (30a48a9) |
| hashrate.no | https://hashrate.no/coins/BEAM/pools | https://hashrate.no/submit (Pool tab) | 2026-10-08 | sent |
| Stelareum | https://www.stelareum.io/en/mining/pool.html (BEAM: only Cruxpool and Flypool) | email to contact@stelareum.io; Telegram (PR contact on the page: t.me/stelareum_pr) | 2026-10-08 | emails 10-08 and 10-11, no answer. The owner wrote in their Telegram earlier with the full pool details (stratum ports, 0.5% fee, 1% finder bonus, min payout 1 BEAM / every 2 h, Finland, miners, API, source); 2026-11-17 follow-up there: no answer to the emails, already listed on NiceHash Compatible Pools, MiningPoolStats, MiningBoard, MiningChamp, minerstat, Beam explorer; a lower-fee option next to Cruxpool and Flypool. Waiting |
| PoolBay | https://poolbay.io/crypto/311/beam/ (coin page since 2026-06: price only, no network data, no pools) | email to admin@poolbay.io; the contact page also lists poolbay.io@gmail.com, Twitter and Discord | 2026-10-08 | admin@poolbay.io bounced twice (10-14, 10-28): poolbay.io has no MX records. 2026-11-17: sent from info@ to poolbay.io@gmail.com (copy in Sent), offering live data for the empty BEAM page. Waiting |
| MinerBox (phone app) | 2Miners and HeroMiners for Beam | email to minerbox@witplex.com, asks for integration through `/api/miners/{address}` | 2026-10-08 | sent |
| Blockwatch X (iOS app, last update 2021) | | email to blockwatchapp@gmail.com, same request | 2026-10-08 | sent |
| Awesome Miner | predefined pools for BeamHash III (only NiceHash so far) | https://www.awesomeminer.com/contact, topic "Feature request", replies go to the owner's address | 2026-10-08 | sent |
| BeamTerminal (source of explorer.beam.mw) | https://explorer.beam.mw/#/explorer/mining | patch https://git.maxnflaxl.dev/maxnflaxl/BeamTerminal/commit/07a22c593076efcc9a1582edea8c59554a3c5d4c, adds the pool to `backend/src/mining/pools.ts` | 2026-10-08 | sent |
| Bitcointalk | | own thread https://bitcointalk.org/index.php?topic=5596205 and a reply in the Beam ANN thread https://bitcointalk.org/index.php?topic=5052151.msg67218589#msg67218589 | 2026-10-08 | posted |
| NiceHash | https://www.nicehash.com (BEAMV3 algorithm) | pool created on the marketplace, see below | 2026-10-08 | **live** |
| NiceHash Compatible Pools | https://www.nicehash.com/compatible-pools (Beam: 2Miners, Cruxpool) | email from info@bumblebeam.org to info@nicehash.com (copy in Sent): Pool Verifier screenshot, 371 blocks/24 h (~25% of Beam, #2), 3,357 matured, explorer.beam.mw + MiningPoolStats + MiningBoard + MiningChamp, ports, 0.5%, Apache-2.0 | 2026-11-03 | 2026-11-05 NiceHash: no test orders on their side, they want Order IDs of test orders from our account, then review and list. Replied the same day from info@ (SMTP mail.ultp.org) with all 10 of our completed orders, said they were regular orders with prices and limits adjusted while running, asked if enough or a dedicated test order is needed. 2026-11-06: second email the same way, new live order 489b32a1 (started 16:33 UTC, 0.00127 BTC, run by our bot, disclosed) and the cancelled 91b4651e added to the list. 2026-11-16: no answer, follow-up in the same thread: live orders f653129d and 4fa38f46 (by hand, no bot), completed 489b32a1 and 750d487d, our orders +33% (0.00772 BTC -> 132,127 BEAM since mid-October), 449 blocks/24 h (~31% of network), 6,113 matured; promised a "NiceHash compatible" mark, a link on the site and in the setup guide, and an announcement once listed. 2026-11-17 NiceHash: orders reviewed, "everything looks good", asked for a high-res logo and Name/Tagline/Algorithms/Reward system/Website. Replied the same day (brand/logo.svg, logo-1024.png, avatar-1024.png; tagline "Open-source Beam pool - 0.5% fee, automatic payouts every 2 hours", BeamHash III (BEAMV3), PPLNS and SOLO, https://pool.bumblebeam.org). 2026-11-17 11:28 CET NiceHash: **listed** ("BumbleBeam - Open-source Beam pool, automatic payouts every 2 hours", BeamV3, PPLNS/SOLO; fees are not shown on that page). Same day: footer mark (d56d213) and a link in the /connect NiceHash tab (532e916) deployed, the owner announced it to the Beam community, thank-you reply sent from info@ |
| MiningPoolsList | https://miningpoolslist.com/beam-mining-pools/ | Google form https://goo.gl/forms/J9mfZTOuYLvqn1D93 (same form for pools, coins and bugs; site unchanged since 2019) | 2026-10-08 | sent |
| HiveOS | flight-sheet pool drop-down | https://github.com/minershive/hive-pooltemplates/pull/1859 (`pool_templates/bumblebeam.json`) | 2026-10-08 | open |
| beam.mw mining page | https://beam.mw/mining | https://github.com/BeamMW/beam-web/pull/388: links the page to the explorer's live pool list and adds MXBM; does not name any pool | 2026-10-08 | open (closed and reopened 2026-10-11); the explorer's mining page already lists the pool, but beam.mw/mining links neither it nor MXBM, which is what this PR adds |
| RainbowMiner (profit-switching miner, 700+ stars) | `Pools/*.ps1` modules; for Beam Acepool, Sunpool, LeafPool, HeroMiners | https://github.com/RainbowMiner/RainbowMiner/pull/3237: `Pools/BumbleBeam.ps1` (PPLNS), `Pools/BumbleBeamSolo.ps1`, `Balances/BumbleBeam.ps1`, config defaults, POOLS.md, README; fork branch add-bumblebeam-pool. Modules tested with stubbed helpers on pwsh 7.6 against the live API | 2026-10-14 | open; outside add-pool PRs there (Pooly #3203, Himpool #3201) have sat unmerged since April |
| Beam docs (docs-gitbook) | https://beam.mw/docs/mining/pool-mining-beam | https://github.com/BeamMW/docs-gitbook/pull/28: links the explorer's pool list next to MiningPoolStats in `mining/pool-mining-beam.md`; names no pool, discloses that we run one | 2026-10-14 | open |
| coinguides.org | https://coinguides.org/mine-beam-beamhash-mining/ (2022 guide: 2Miners, Flypool, HeroMiners, Leafpool) | comment as "profinch (BumbleBeam)": Flypool's eu1-beam.flypool.org no longer resolves, our config line in their format, asks to add the pool | 2026-10-14 | sent, comment 390892 in moderation |
| MiningChamp | https://miningchamp.com/coin/beam (only AethelBlock; network hashrate/difficulty "No data") | email to admin@miningchamp.com with API/stratum/fee, offers `nodes[0].networkhashps`/`difficulty`; reply to samurai619 in the Beam ANN thread (msg67248847). Site form "List Your Pool / Coin" has a Cloudflare captcha: submit by hand | 2026-10-27 | **listed 2026-10-27**: hashrate, workers, 0.5% PPLNS/SOLO, min payout 1, our blocks; network hashrate/difficulty now from our API. Bitcointalk reply not posted. 2026-10-27 they asked for a badge and offered featured placement and co-announcements; replied in their thread: missing stratum ports, SOLO missing in specs, offered /api/network/blocks, asked whether featured placement is paid; promised a self-hosted badge. Footer marks live 2026-10-27 (b242ced); emailed MiningChamp and MiningBoard about it |
| miningpoolstats.net (not MiningPoolStats) | https://miningpoolstats.net/coins/ (24 coins, no Beam; pool pages /pools/<pool>, 46 pools) | no email; the site's form is a lead form for miners (name, email, messenger, hashrate, no message field); the only contact is Telegram @miningtraf (a channel with 7 subscribers); WordPress in Russian, EMCD affiliate | 2026-11-17 | a Russian message and two mockups (a /coins/beam/ page made from their Alephium page: 2Miners, HeroMiners, BumbleBeam, Sunpool; a /pools/bumblebeam/ card made from their HeroMiners card with our 24 h hashrate chart) given to the owner to send by Telegram; not confirmed as sent |
| HeroMiners (delisting Beam on 2026-11-20) | https://beam.herominers.com (12 miners, 25 workers, 9.57 KSol/s on 11-19; their banner sends miners to Pearl) | Discord #beam on their server (436395579149516801), 2026-11-19, from profinch | 2026-11-19 | asked for (1) a "Staying on Beam? BumbleBeam" line in the delisting banner and (2) a fallback: their *.beam.herominers.com stratum hosts pointed at our server after the 20th. Ready on our side the same day: ports 1130 and 1131 (their ports, both TLS) open as extra TLS PPLNS ports labelled "HeroMiners" on /admin (pool.toml `extra_tls_ports`, 7092987), logins with `=diff` accepted (8b2328c). Waiting for their answer |
| Beam community Telegram (t.me/BeamPrivacy) | — | post by the owner | 2026-11-19 | sent: HeroMiners leaves Beam on the 20th; change only the host, de.beam.herominers.com:1130 -> stratum.bumblebeam.org:1130, same port and login |
| MinerCompare | https://minercompare.com/crypto-mining-pools (Beam: 2Miners, HeroMiners, AcePool, LeafPool, SunPool); pool pages /crypto-mining-pools/<pool>; coin page /coin/beam | email from info@ to info@minercompare.com (copy in Sent), no form on the site | 2026-11-17 | sent with attachments: a mockup of a BumbleBeam pool page in their layout, ready-to-paste pool data, a text for the empty "BeamHashIII - About This Algorithm" block on /coin/beam (with a mockup) and fixes for that page (Sol/s vs kSol/s, Best Hardware GPU, pool fees 0-1%). Waiting |
| BeamMW/BeamExplorer | | https://github.com/BeamMW/BeamExplorer/pull/1 | 2026-10-08 | closed by us: that repo is a fork of BeamTerminal, the patch went there instead |

### Resubmitted 2026-10-11

Checked first: still not listed on MiningPoolStats, WhatToMine, minerstat, hashrate.no, Stelareum,
MiningPoolsList, PoolBay; listed on MiningBoard. Pool figures quoted: 348 blocks found, 306 confirmed, 77 in 24 h.

- WhatToMine: form sent again ("Your request has been submitted"); software "custom", fee 0.5, Europe (Finland).
- minerstat: Mining pool tab sent again ("Submission received").
- hashrate.no: Pool tab, pool "Other" + name BumbleBeam, PPLNS, Finland, 3333/3443 ("successfully submitted").
- Awesome Miner: contact form, Feature request, follow-up ("Thank you for contacting us!").
- Stelareum, MinerBox, Blockwatch X: follow-up as a reply in the 2026-10-08 Gmail threads.
- PoolBay: new email to admin@poolbay.io (the 2026-10-08 one is not in Gmail's sent folder).
- HiveOS PR #1859 and beam-web PR #388: ping comments; #388 closed and reopened the same day.
- Not resent: MiningPoolStats and MiningPoolsList (Google Form). The browser extension has no permission
  for miningpoolstats.stream or Google Forms; to do by hand or after allowing those sites.
  Bitcointalk not reposted (would be spam).

### Resubmitted 2026-10-25, with the API update

Since commit 44d2ba9 `/api/stats` also carries the report MiningPoolStats reads from other Beam pools
(SunPool's `pool-info.php?miningpoolstats`: coin, feePercent, minPay, feeType, timestampMilliSeconds,
miners, workers, hashrate, blockHeight, blocksFound24H, lastBlocksFound) and the open-ethereum-pool
(2Miners) totals; `/api/blocks` too. MiningPoolStats' own form answer says pools are "manually verified
and added to the list if public API can be identified". Figures quoted: about 133 blocks in 24 h, 2206
confirmed in total. Still not listed on MiningPoolStats (the Beam list has had the same 7 pools since at
least 2024-04, while other coins gained pools through 2026).

- MiningPoolStats: "Missing pool?" form (pool + API URL with the report fields) and the footer's Quick
  Message (from the owner's address), both posted to contact.php / contact_email.php as the page does:
  both answered SENT.
- WhatToMine: form ("Your request has been submitted"), API URL /api/stats, software "custom, open source".
- minerstat: Mining pool tab ("Submission received").
- hashrate.no: Pool tab, Other + BumbleBeam, Beam, PPLNS, 0.5, Finland, 3333/3443 ("successfully submitted").
- MiningPoolsList: Google Form; picking "new mining pool" leads, after the pool page, to the bug page with a
  required description, so the request is repeated there ("Your response has been recorded").
- Awesome Miner: contact form, Feature request ("Thank you for contacting us!").
- Stelareum, MinerBox, Blockwatch X: replies in the 2026-10-08 Gmail threads (no answers so far).
- PoolBay: new email to admin@poolbay.io (no earlier one is in Gmail at all).
- HiveOS PR #1859 and RainbowMiner PR #3237: update comments. #3237 has had no review since 2026-10-14
  although the maintainer merged three outside PRs on 2026-10-09; its modules read only fields that stayed.
- Not resent: beam-web #388 and docs-gitbook #28 (they name no pool), coinguides (comment in moderation),
  Bitcointalk (spam), MiningBoard (listed), NiceHash (live).
- MiningBoard after the API change: it reads /api/miningboard (miningboard-pool-v1), which did not change;
  the listing showed fresh data ("updated 3 minutes ago", 130 blocks in 24 h).
- New: https://github.com/rust-in-blockchain/awesome-blockchain-rust/pull/112 (BumbleBeam under "Other";
  no star threshold there, unlike awesome-rust's 50).
- New: MXBM README patch by email to me@maxnflaxl.dev ("Verified live against HeroMiners and BumbleBeam"),
  with a reminder that patches 4/5 (Metal load limit) and 5/5 (older macOS) of the 2026-10-12 series are
  not merged yet (1-3 are: 6a31def, 341e26f, 7926200). BeamTerminal already lists the pool (merged 2026-10-08).
- Searched GitHub 2026-10-25 for more: nothing else that lists Beam pools and takes outside PRs. Pool lists
  found are firewall blocklists (hkphh/mining-pool-list, nDPI, CoinBlockerLists); andoniaf/mining-pools-list
  is archived (2018); Poolguard, 2MinersMonitor, cryptoheater-web are dormant; lolMiner, GMiner, miniZ repos
  hold releases only. Package registries for BumbleBeam Miner are open: Scoop Extras already ships xmrig.

The official docs (https://beam.mw/docs/mining/pool-mining-beam) send miners to MiningPoolStats for the
pool list, so that one matters most.

### NiceHash

The pool on the NiceHash marketplace (algorithm BEAMV3) is set to host `stratum.bumblebeam.org`, port
3443 (TLS). Their proxy does not work on the plain port 3333. Their pool check fails when the login is
a long offline address; use a regular (short) address there. The proxy starts at difficulty 2048 and never
goes below, so the pool keeps that as the minimum share difficulty for it (commit 2d3be4f, in
production).

2026-11-03: Pool Verifier passed again ("Tested pool is compatible!", 0.183 s, stratum.bumblebeam.org:3443,
user `<our address>.nicehash`, difficulty provided=2048, minimum=2048). By then NiceHash orders had found
367 blocks in 24 h and payouts were completing, so the compatible-pools request is unblocked. Open point:
`buy/info` gives BeamV3 `min_diff_working` = 8192, above the pool's NiceHash floor of 2048.

## Not yet

Beam's own channels (Telegram, Discord, mining@beam.mw, Reddit, X): announced, done by 2026-10-08.

Third-party communities, found 2026-10-08 and not yet used:

- Miner developers' chats, where Beam miners actually are: lolMiner Discord https://discord.gg/jvfRvK5wTv
  and Telegram https://t.me/lolMiner (the pool is verified with lolMiner 1.98a); GMiner Telegram
  https://telegram.me/gminer_talk, Discord https://discord.gg/J7RUG3FDYw, Bitcointalk thread
  https://bitcointalk.org/index.php?topic=5034735.0.
- Reddit beyond Beam's own: r/gpumining (~95k), r/cryptomining (~62k, weekly Q&A thread covers pools);
  r/rust and "Show HN" for the open-source Rust pool itself rather than the service.
- Forums: https://forum.bits.media board "Пулы совместного майнинга"; TechPowerUp "Cryptocurrency &
  Mining" https://www.techpowerup.com/forums/forums/cryptocurrency-mining.73/; [H]ard Forum "Mining &
  Cryptocurrency"; VoskCoin Talk "Mining & Hardware".
- Write-ups: Habr (open-source Beam pool in Rust, verified against the core), dev.to or Medium in English.
- GitHub topics on profinch/bumblebeam: beam, beamhash, mimblewimble, mining, mining-pool, rust, stratum
  (the last three added 2026-10-08).
- Awesome Miner: sent through the contact form, see the table. The form notes that free-edition users get
  support only with intent to upgrade, so a reply is not certain.

Searched again 2026-10-14 (nothing else worth a submission):

- Dead or abandoned: wheretomine.io (redirects to an unrelated site; data repo wheretomine/website-data
  untouched since 2020), CheckPool Android app (gone from Google Play), PoolWatch.io (2022 data),
  miningpools.com (2019), poolexplorer.com and pool-stats.com (404), MultiPoolMiner (2023),
  GitHub pool lists (andoniaf/mining-pools-list, hearfan/miningpoolslist and similar).
- No pool list or no way in: 2cryptocalc.com (2Miners' own site, 2Miners only), millionminer.com (no Beam),
  4miners.pro (Beam calculator only), coincalculators.io, Etherscan directory, hashrateindex and
  simplemining.io (BTC/ETH only), UG-Miner and NemosMiner (multi-algo pools only), GMiner, lolMiner and
  Rigel repos (releases only).
- Paid: blockspot.io company directory (from 29 EUR a month); its Beam coin page has no pool list.
- Chinese: minerbbs.com (now minersns.com) has a "矿池" tab on its Beam page, full of closed pools; it hung
  in the browser and there is no submit link. wabi666.com does not resolve.
- CryptoSlate mining-pool directory: 24 companies, mostly BTC, "claim your listing"; weak, not used.
- Poolguard: request only from inside the app; source (dodyac/Poolguard) untouched since 2023. Still to do.
- Not wanted: nDPI and Pi-hole/cryptojacking domain lists (blocklists), litecoinII/mining-pools (Litecoin mempool tags).

Searched again 2026-11-03 (pool lists beyond trackers):

- MiningRigRentals /pools "Suggested Pools & Services": requested by email, see the MRR note below.
- MiningBoard https://miningboard.com/mining/beam: BumbleBeam is #1 of 14 Beam pools (58.6% share, 407 blocks/24 h at the time).
- Pool Monitor (iPhone, https://github.com/shiftingeden/PoolMonitor): mostly BTC, plus Mining-Dutch and 2Miners; pool requests
  to TechBitsMix@gmail.com, no source in the repo. Low value for Beam; not requested.
- Mining Monitor 2 (Android, fahim_edu.mining_monitor): changelog adds pools on request (herominers, luckypool, kryptex);
  56 pools (2Miners, HeroMiners, NiceHash...), 1K+ downloads, updated 2026-06-16, developer Toto Sugito: "If you need more
  pool, just contact us". Requested 2026-11-03 by email from info@ to totosugito@gmail.com.
- Nothing there: 2CryptoCalc (2Miners only), coincalculators.io/minershare (pool shares hard-coded in the page, Ethermine/MineXMR,
  no Beam), miningpoolstats.net (EMCD affiliate site, no Beam), Kryptex (own pool only), SimpleMining (pool via support
  ticket, BTC partners), CheckPool (Play 404), Rigly/Hashing24/Cryptoscope (BTC or not pools).
- Mining Monitor (Android, fahim_edu.appmining, the same developer's first app): 50K+ downloads, updated 2025-01-15,
  lists Beam on 2miners, herominers, leafpool, solopool and ethermine (Flypool). Bigger than Mining Monitor 2; the
  2026-11-03 email to totosugito@gmail.com named only Mining Monitor 2.
- Proof of Work (proofofwork.app, Android app.proofofwork): HeroMiners, Kryptex, 2Miners, WoolyPooly, Vipor; "subscribers
  can priority request a new pool"; feedback form on the site only. Its Play listing returns 404 (2026-11-03): skip.
- Cudo Miner: site behind a Vercel bot checkpoint (429 even for headless Chromium); read via web.archive.org. It is a
  profit-switching miner that picks the coin and pool itself and pays out in a chosen coin; no public list of third-party
  pools and no way to submit one. "Cudo Pool" (integration for pool operators) was "Currently in Closed Beta – Contact
  us" in 2020 and is gone from the 2026 site. Beam was a supported coin in 2020. Not worth a request.
- Unverified: Mining Pool Hub (520), Minerdude (empty), Hiveon OS presets beyond the HiveOS PR.

Mining OS and smaller trackers, checked 2026-10-08:

- HiveOS: done, see the table; the drop-down comes from https://github.com/minershive/hive-pooltemplates.
  Fallback contact bee@hiveos.farm.
- poolbay.io: no Beam pools shown and no form; emailed, see the table. Discord https://discord.com/invite/zfzXKH2B if no reply.
- mmpOS: pools are added per account in the app (app.mmpos.eu); no public route to a shared list found.
- NiceHash "compatible pools" page https://www.nicehash.com/compatible-pools: a hand-picked list of 11 pools
  "known to work flawlessly"; for Beam only 2Miners and Cruxpool. No form; ask NiceHash support (a ticket from
  the account) once NiceHash orders have actually run on the pool.
- Pool-monitor phone apps add pools on request and need the per-miner stats API: MinerBox and Blockwatch X
  emailed, see the table. Poolguard: request from inside the app, still to do. Mining Pool Monitor (iOS):
  last update 2018, six pools, no contact; skipped.

Dead or out of scope:

- MXBM README: only HeroMiners in the example; a second example with this pool could go in by patch
- RaveOS: dashboard shut down 2026-02-01, devices run standalone; sales@raveos.com is the only contact
- poolwatch.io: dated 2022, returns 403 to everything
- CoinWarz: calculators only, no pool lists; Cryptunit: CryptoNote coins only
- 2CryptoCalc (checked 2026-11-17): run by 2Miners (contact support@2miners.com, repo 2miners/2cryptocalc-hashrates);
  every coin page (Beam, Kaspa, Ergo, Monero, Dynex) shows only 2Miners pools, so no third-party listing
- Cryptunit closed (farewell page), investoon.com is a hosting placeholder, Kryptex has no Beam page,
  miningpoolstats.net: see the table (it does have coin and pool pages, an EMCD affiliate site)
- awesomelistsio/awesome-crypto-mining: never merged an outside PR; the maintainer closed the last pool
  submission (NexusPool, 2026-08) for lack of "maturity, adoption, established reliability", so not worth one
- Wikis, checked 2026-10-11: Wikipedia has no Beam article (en, ru, de), and its external-links rules
  keep pool links out anyway. The BeamMW/beam GitHub wiki page BEAM-Mining has no pool list and the
  wiki is not writable for us (push 403). BeamMW/beam-docs names no pools and is untouched since
  2021-05. The lolMiner wiki has no pool lists and is not writable. No Fandom or other community wiki
  lists Beam pools.
- forum.beam.mw no longer resolves; miningclub.info is a spam archive; mining-cryptocurrency.ru stopped in 2024;
  MiningRigRentals: any stratum pool works, but it does keep a list (corrected 2026-11-03, the earlier "no pool list" was wrong):
  https://www.miningrigrentals.com/pools "Suggested Pools & Services", 21 pools (2Miners, Nanopool, mining-dutch, solofury...)
  plus MiningChamp and Minerstat as services. No form: "Have a well known pool ... compatible with MRR? Ask us to list you!";
  contact support@miningrigrentals.com, Discord https://discord.gg/wFMSbcK (tag @admin) or a ticket from the account.
  Requested 2026-11-03: email from info@bumblebeam.org to support@miningrigrentals.com (copy in Sent).
  The email only got an auto-reply (ticket 352191), not visible in the account. 2026-11-17: ticket 353611 from the MRR account
  (https://www.miningrigrentals.com/tickets/353611, category Suggestion): same pitch with 455 blocks/24 h (~31%), NiceHash review passed. Open, waiting.
  2026-11-19 answer (Randy): listing is for a reciprocal banner. Put their banner
  (https://www.miningrigrentals.com/images/mrr-logo2.png, linking to https://www.miningrigrentals.com/ or our MRR referral link)
  somewhere about as visible as their Pools page shows pools, then reply in the ticket with our banner or logo, the destination
  URL and the page with their banner. They then review: the pool must be active with "at least a handful of miners".
  2026-11-19: their banner is live in the footer marks row (223dfad, links to their home page, grey until hover like
  the others; d54d9ba sizes its logo like the others). 2026-11-19: replied in the ticket by email (banner on every page's
  footer, our logo-1024.png and logo.svg, destination https://pool.bumblebeam.org, the new MRR tab of /connect,
  477 blocks in 24 h; the miner count, 4, not mentioned). Waiting for their review

## HiveOS template

Sent as https://github.com/minershive/hive-pooltemplates/pull/1859 (`pool_templates/bumblebeam.json`). TLS ports only, since
GMiner and miniZ in the `miners_beamhash` prototype are set to TLS and lolMiner defaults to it for Beam.

```json
[
    {
        "pool": {
            "name": "BumbleBeam",
            "url": "https://pool.bumblebeam.org",
            "fee": 0.5,
            "type": "PPLNS"
        }
    },
    {
        "coin": "BEAM",
        "servers": [
            { "geo": "Europe PPLNS",   "ssl_urls": ["stratum.bumblebeam.org:3443"] },
            { "geo": "Europe SOLO",    "ssl_urls": ["stratum.bumblebeam.org:3444"] }
        ],
        "miners": { "_prototype": "miners_beamhash" }
    }
]
```
