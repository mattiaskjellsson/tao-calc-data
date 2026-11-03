# GPU calculator: design

**Date:** 2026-10-31 · **Status:** draft, waiting for the owner's review

## Why

The owner wants a public website that answers one question: **what's the most profitable thing to do with this GPU right now?** The options are mining a proof-of-work coin, running a Bittensor subnet miner, or renting the card out. The card can be one the visitor owns or one they'd rent.

The tao project ([Heading/tao](../../../../Heading/tao)) only covers Bittensor, and its spec explicitly rules out other coins and networks. This calculator covers everything that project ruled out. It's also the first place that keeps a public, hourly history of data the free sources throw away, like option chains, GPU rental prices and short-lived candles. That history improves the calculator's forecasts, and the owner plans to use it later to improve the tao brain's estimates.

**The common unit is one hour of a specific GPU.** FLOPs are good for comparing cards, but they don't decide what a card earns. Each way of earning turns a GPU-hour into money differently:

| Kind | Examples | What sets the payout | The "luck" |
|---|---|---|---|
| **Proportional** | PoW coins (Kaspa, Ravencoin, Ergo and others), selling hashrate on NiceHash or MiningRigRentals | Your share of the network's work. It scales with hardware. | Block-finding variance. Close to none when mining in a pool. |
| **Competitive** | Bittensor subnets | Your rank against the other miners on the subnet. Hardware only gets you in. | Where you end up ranked. The spread is huge, and the median slot earns about 0. |
| **Rented out** | Hosting on Vast, Clore, io.net and others | Market price per hour × how often the card is actually rented | Demand (utilisation) |

## What success looks like

- A visitor picks a mode and a GPU, and on a phone, within a couple of seconds, sees a ranked list of what that card can do. Each row shows net $/day, a p10–p90 range over the chosen horizon, a break-even, and any warning flags.
- **The numbers check out:**
  - For three sample PoW rows, the site's estimate is within about 5% of WhatToMine's or NiceHash's own calculator for the same hour.
  - For Bittensor, the site's per-subnet percentiles match the tao project's earnings scan for the same hour.
- The recorder runs hourly for two weeks and captures at least 95% of hours. One failing source never stops the others.
- **Running cost is $0, and no payment card is on file anywhere.**
- The archive is documented well enough that someone else, or the tao brain later, can read it without asking.

## Goals

1. **Two modes:**
   - **Owning a card.** The visitor picks a GPU and enters an electricity price ($/kWh). The options are PoW mining, Bittensor, selling hashrate (NiceHash, MiningRigRentals) and renting the card out (Vast, Clore and others).
   - **Renting cards.** The visitor picks a GPU model, and the cost is the cheapest current rental price for it. The options are PoW mining and Bittensor. Renting a card only to rent it out again is left out.
2. **Buying hashrate directly** *(part of renting mode)*. A visitor can also buy hashrate for an algorithm on NiceHash or MiningRigRentals and point it at a coin, with no GPU involved. This is the arbitrage idea the owner started from. *(my call)*
   - These rows go in their own table below the GPU table, because there's no GPU to compare against.
   - They're ranked by **margin %**: (expected coin revenue − cost) ÷ cost. That doesn't depend on how much you buy.
   - A **budget field** ($/day, default $10) turns the margin into dollars. The cost is priced from the live order book, so a larger budget fills at worse prices, the way it would in practice.
3. **The luck spread.** Every row shows a range, not just an average. *(my call)*
   - **What the range is:** each row's p10–p90 is net $ over the horizon. It combines price uncertainty (see Forecasts) with the luck specific to that kind of earning:
     - **PoW:** block-finding variance. Pool mining is the default and adds next to nothing. Solo mining also shows the chance of finding at least one block within the horizon.
     - **Bittensor:** the headline uses the rank percentile the visitor picks. Its p10–p90 is price uncertainty at that rank. A second line shows the rank spread ("ranked between the 10th and 90th percentile of earners: $a–$b") and the share of slots earning zero. Percentiles are taken over non-zero earners, and the zero-earner share is reported separately, the same way the tao brain does it.
     - **Rent-out:** utilisation is a band, not a single number. The band is the market's signal ± 20 percentage points, clamped to 0–100%, or the visitor's own setting ± 20. Price uncertainty comes on top. Mark the band with a `ponytail:` comment, naive band, replace with the archive's measured utilisation spread once there's 30 days of history.
   - **Ranking:** the GPU table is ranked by p50 net $/day over the chosen horizon.
4. **Break-even** for every row:
   - The coin or token price where the net result hits zero, with its distance from today's price in %.
   - In owning mode, the electricity price where it hits zero.
5. **Forecasts** over a horizon the visitor picks (1, 7, 30, 90 or 365 days), as p10, p50 and p90 net $. The forecast takes into account:
   - **Price movement:** implied volatility from Binance's options (BTC, ETH, SOL, XRP, DOGE, BNB), otherwise realised volatility. Assume no drift. Deribit's IV is used only if Deribit grants written approval (see "Data terms").
   - **Difficulty and network growth:** the recent trend from the archive.
   - **Known emission changes** such as halvings, from a hand-kept table.
   - **Rental price trends,** once the archive has enough history. Until then, assume flat.
6. **An open hourly archive** of everything the recorder fetches (see Data). It's public, documented and kept for good.

## Non-goals

- **Staking** (ETH, SOL and others), because it uses money, not compute.
- **Alerts and notifications.** There's no login or backend to send them from. Add them later.
- **Accounts or logins.** The site is public with no login.
- **Renting or running anything.** This is a calculator. The tao brain does the renting and running.
- **ROI on buying hardware** ("should I buy a 4090?"). Add it later if wanted.
- **Feeding the tao brain in this project.** The archive's format is documented so that can happen later, but nothing in tao changes now.
- **Taxes.**

## Anti-goals (failure even if it works)

- **Making a losing option look safe.** Never show only the average. Bittensor rows always show the share of slots earning zero, and PoW solo rows show the chance of finding nothing.
- **Republishing data we aren't allowed to share.** See "Kept out of the public archive".
- **Costing money or needing a payment card.**
- **Leaking keys.** The repo is public. Keys live only in Railway variables and never in code, commits, files or logs.
- **Showing stale data as fresh.** The page shows when its data was collected and flags rows whose source is more than 3 hours old.
- **Pointing people at hosts that ban mining.** Rows that mine on a rented GPU show that host's mining terms (allowed / restricted / banned / unknown).

## Constraints and facts (checked 2026-10-31)

**Money:** $0. No paid tiers, and no service that asks for a payment card, even on its free tier. Cloudflare R2 asks for one, so it's out. Free API keys are fine.

**GitHub limits:**
- **Repo size:** GitHub recommends keeping a repo ideally under 1 GB, and strongly recommends staying under 5 GB. No single file over 100 MB, with a warning at 50 MB.
- **Release assets:** up to 1,000 per release, each under 2 GiB, with no limit on a release's total size or on bandwidth ([docs](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)).
- **Actions:** unlimited minutes for public repos. The shortest schedule is every 5 minutes, and scheduled runs often start a few minutes late.
- **Inactivity:** a scheduled workflow in a public repo is disabled after 60 days with no repository activity.

**Cloudflare Pages (free):** 500 builds a month. An hourly data commit that triggered a build would use 720, so data commits must not trigger builds.

**Binance and GitHub:** Binance blocks US locations and many datacenter IP ranges. GitHub's runners are in US Azure datacenters. `data-api.binance.vision`, Binance's market-data-only host, works from the owner's machine. Whether it works from a GitHub runner is not confirmed ([ccxt#15872](https://github.com/ccxt/ccxt/issues/15872), [Vercel thread](https://community.vercel.com/t/binance-api-calls-on-vercel/29895)).

**Sources probed from the owner's machine on 2026-10-31:**

| Source | Endpoint | Key | What came back |
|---|---|---|---|
| Binance prices | `data-api.binance.vision/api/v3/ticker/price` | none | 3,745 symbols, 159 KB |
| Binance options | `eapi.binance.com/eapi/v1/mark` | none | 1,516 options on BNB, BTC, DOGE, ETH, SOL, XAG, XAU, XRP |
| Deribit options | `www.deribit.com/api/v2/public/get_book_summary_by_currency` (`BTC`, `USDC`) | none | 966 BTC options, and 3,104 USDC options on AVAX, BTC, ETH, HYPE, SOL, TRX, XRP. Each has bid, ask, mark, IV and open interest. |
| WhatToMine | `whattomine.com/coins.json`, `/asic.json` | none | 43 GPU coins and 52 ASIC coins, each with algorithm, block time, block reward, difficulty, network hashrate and exchange rate |
| NiceHash | `api2.nicehash.com/main/api/v2/public/stats/global/current` and `/hashpower/orderBook?algorithm=…` | none | Price per algorithm and order books |
| NiceHash benchmarks | `api2.nicehash.com/main/api/v2/public/profcalc/devices` and `/profcalc/device?device=<id>` | none | 507 devices, each with hashrate and power per algorithm (e.g. RTX 4090: KAWPOW 65 MH/s at 325 W). **This is the GPU × algorithm benchmark table.** |
| MiningRigRentals | `www.miningrigrentals.com/api/v2/info/algos` | none | Per algorithm: suggested price, plus available and rented rigs |
| Vast | `console.vast.ai/api/v0/bundles/` | none | Offers by GPU. A keyless query returned only 64 offers, so the full list may need the right query or a free key. It answered 403 to a request with a browser user agent and URL-encoded `q`. |
| Clore.ai | `api.clore.ai/v1/marketplace` | none | 2,613 servers with prices and a `rented` flag (34% rented), 3.5 MB |
| Lium | `lium.io/api/public/v1/nodes` | none | Nodes with GPU model, $/GPU-hour and availability |
| RunPod | `api.runpod.io/graphql`, query `gpuTypes { lowestPrice }` | none | Lowest price per GPU type |
| Akash | `console-api.akash.network/v1/gpu-prices` | none | Min, max and median price per GPU model, plus availability |
| io.net | `api.io.solutions/v1/io-explorer/network/market-snapshot` | none | Price, plus total and hired counts per GPU model |
| Hyperliquid | `api.hyperliquid.xyz/info` | none | Works. Keeps only the latest 5,000 candles, about 17 days at 5 minutes. |
| Bittensor | `entrypoint-finney.opentensor.ai` and `archive.chain.opentensor.ai` | none | Both answer JSON-RPC. The archive node serves historical blocks, so past per-slot history can be rebuilt. |
| CoinGecko | `api.coingecko.com/api/v3/simple/price` | none (free demo key available) | Works |
| TensorDock | — | key | 401 without a key |
| Prime Intellect | — | key | 403 without a key |

**Data terms (checked 2026-11-02):**
- **Deribit: personal use only.** "The use of market data and/or derived data is for personal use only. You are not allowed to aggregate, resell, publish, forward or in any other way process market data and/or derived data (except for personal use) without prior written approval from us."
  - Sources: the Deribit FZE Exchange Membership Terms, clause 2.10, published 2026-01-26 ([link](https://support.deribit.com/hc/en-us/articles/25944532191645-Deribit-Exchange-Membership-Terms-Deribit-FZE-Published-26-January-2026)). The same clause is §32.3 of the DRB Panama terms ([link](https://support.deribit.com/hc/en-us/articles/25944471089437-Terms-of-Service-DRB-Panama-Inc)).
  - **What this means here:** Deribit's raw data goes only to the owner's private archive (below). Nothing derived from it, including its IV, appears on the public site or in the public archive unless Deribit approves in writing. Requests go to info@deribit.com.
- **Binance: CC BY-NC-SA 4.0, non-commercial only.** Binance's Vision Dataset Terms v1.0 (2026-08-26, [PDF](https://data.binance.vision/Binance_Vision-Terms_of_Use.pdf)) cover data from data.binance.vision "and associated endpoints".
  - **Allowed uses (§4.1):** "non-monetized open educational projects" and "non-commercial open-source data science evaluations".
  - **Redistribution (§4.5):** redistributed derivative work must credit Binance Vision and use the same licence.
  - **Not allowed (§8.2–8.3):** implying Binance endorses the project, or using its name to market it.
  - **What this means here:** Binance data may go in the public archive and on the site if the project stays **non-commercial**, meaning no ads, no paid tier and no use as a company product. The Binance files and figures derived from them carry CC BY-NC-SA 4.0 with credit to Binance Vision.
  - **Uncertain:** whether "associated endpoints" covers the live API (`data-api.binance.vision`, `eapi.binance.com`) or whether that falls under Binance's main Terms of Use is not certain. The builder notes this in the archive's README.
  - **If the project is ever monetised,** Binance data comes out.

**Mining terms on rental hosts** (from the tao spec, 2026-10-26):
- **Bans mining:** Lambda, AWS and Hetzner.
- **Needs written approval:** Azure and Google.
- **Vast:** bans mining only on credit bought by card.
- **RunPod:** its terms don't mention mining.
- **Lium:** is itself a Bittensor subnet.
- **Clore:** is built for mining.
- **Everything else:** unknown until checked.

**Data size:** one hourly fetch of the sources above, excluding Bittensor and Hyperliquid, came to 7.3 MB raw and 0.86 MB gzipped. My estimate with Bittensor's per-slot data added is 2–3 MB compressed per hour, which is about 2 GB a month or 20–25 GB a year.

## Design

### Two parts in one public repo

1. **The recorder** (Python): a Railway cron service that runs hourly, in the owner's existing Railway project (now named `binance-probe`, Amsterdam region). *(owner's decision, 2026-11-02; see "Where the recorder runs")* Python, so it can reuse the tao project's Bittensor code and match that project's language. *(my call)*
2. **The site** (TypeScript, static): hosted on Cloudflare Pages. It does all the math in the visitor's browser from files the recorder writes, and it never calls an outside API. Visitors therefore can't use up rate limits or see keys, and traffic costs nothing.

The repo lives on the owner's GitHub account. The working name is `mining-calculator`, and the owner can rename it.

### Where data goes *(my call)*

- **Raw hourly snapshots go to GitHub Releases, not into git.** There's one release per month (e.g. `data-2026-11`) holding one compressed file per hour, which is at most 744 assets against the limit of 1,000.
  - Releases don't count toward repo size and have no total limit, so a single repo works indefinitely, with no yearly rollover and no 1 GB problem.
  - Each file is everything that hour's run fetched, saved exactly as it arrived.
- **Git only holds small files:**
  - **`site-data/latest.json`:** what the site needs right now, already reduced. It includes per-subnet earning percentiles, per-coin network stats, per-GPU rental prices and volatility figures.
  - **Daily summary files:** for history charts and forecast trends.
- **Budget:** committed data stays under about 100 MB a year. An hourly `latest.json` has to be small (tens of KB) for that to hold.
- **If GitHub objects** to a 20+ GB archive of release assets, move the raw archive to a Hugging Face dataset, which is free, has no card requirement and is built for this.

**How the site gets data:** Cloudflare Pages rebuilds only when site code changes. It uses build watch paths that exclude `site-data/`. The page reads `latest.json` and the summaries from the repo's raw GitHub URL at load time. The builder confirms CORS and caching on that URL. If it doesn't work, host the site on GitHub Pages instead, deployed from the repo.

### What the recorder saves each hour

**Rule: save what disappears.** Data that some source keeps permanently isn't copied, except where the site needs it for the current hour.

**Recorded:**
- **Prices:** all Binance tickers. CoinGecko (free key) covers mineable coins Binance doesn't list.
- **Mining stats:** WhatToMine GPU and ASIC coin lists.
- **NiceHash:** price per algorithm and order books. The device benchmark table is fetched daily, not hourly.
- **MiningRigRentals:** per-algorithm prices and availability.
- **GPU rentals:** Vast, Clore, Lium, RunPod, Akash and io.net, raw as returned. These include the availability and rented signals that later turn into utilisation estimates.
- **Bittensor:** every subnet's alpha price, miner pool, registration cost, immunity, and per-slot hotkey, coldkey and incentive. Use `bittensor==11.3.0` like the tao brain, or 10.5.0's one-call `get_all_metagraphs_info()` if 11.x reads turn out slower in Actions. The builder picks.
- **Options:** the full option books from Deribit (BTC and USDC-linear) and Binance, plus Deribit's DVOL index.
- **Hyperliquid:** 5-minute candles for the markets the tao SN50 work uses (`HL_COINS` and `HL_SIGNALS` in [sn50/data.py](../../../../Heading/tao/sn50/data.py)). That takes over the job the laptop recorder ([sn50/record.py](../../../../Heading/tao/sn50/record.py)) does for Hyperliquid.
- **Synth (SN50) miner scores:** only if the Synth API doesn't keep them itself. The builder checks.

**Not recorded, because it's permanent elsewhere:**
- Binance candles (bulk downloads at data.binance.vision)
- Deribit trades with IV (history.deribit.com)
- FRED, SEC, BEA
- BTC chain history (mempool.space)
- Bittensor chain history (the archive node)

The recorder may still *read* these to compute figures for `latest.json`, such as 30-day realised volatility from Binance candles.

**Kept out of the public archive (licence limits):**
- **Deribit option books and DVOL** (personal use only, see "Data terms"). The hourly job still collects them, but into a **second, private repo**, [`mattiaskjellsson/tao-calc-data-private`](https://github.com/mattiaskjellsson/tao-calc-data-private) (created by the owner 2026-11-02), using the same monthly-release layout. That keeps the history for the owner's own research and for the tao work.
  - **Access:** the Railway service holds one fine-grained token, `GH_TOKEN`, with Contents read and write on just the public repo and this private one. It's a Railway variable, so it never touches either repo. It expires after 366 days, so the owner renews it about once a year. When it expires, uploads fail with a 401, and the recorder logs that clearly.
  - **If Deribit approves** publishing, the files move to the public archive.
- Cboe delayed option chains (personal, non-commercial use only)
- Nasdaq's unofficial endpoints
- Alpha Vantage data
- The Loughran-McDonald word list (academic use only)

The last four stay local in the tao project.

**Before publishing any source,** the builder checks its terms for redistribution limits and records the link in the source table. If a source forbids redistribution, it is still used for the site's current numbers but left out of the archive.

**Failures:** each source is fetched on its own, and a failure is logged in that hour's file without stopping the others. If Binance ever answers 451, prices fall back to CoinGecko and the file notes the fallback.

**Where the recorder runs (owner's decision, 2026-11-02): Railway, the whole recorder.** It's one cron service in Amsterdam, and the test below showed every source works from there. That leaves one place to run, one place for the token, and no 60-day inactivity rule.
- **Cost:** it starts on schedule, runs about a minute and exits, so it's billed for about 12 hours a month. My estimate is $0.20–1 a month, which fits the free plan's $1 credit. The builder checks real usage after the first week.
- **If usage goes over the credit,** move everything except Binance to a GitHub Actions workflow in the public repo (unlimited free minutes on public repos). Railway then keeps only the Binance fetch.
- **If Railway loses Binance** (a 451), use the owner's laptop recorder from the tao project, which only collects while the laptop is on. If that fails too, go without Binance: prices come from CoinGecko, and BNB, DOGE, XAU and XAG options are missing from the archive.

**Test results (2026-11-02):**
- **Railway, Amsterdam region** (`AS400940 Railway`, NL): **all 20 sources answered.** That includes all three Binance hosts (`api.binance.com`, `data-api.binance.vision`, `eapi.binance.com`), Deribit, Vast, Clore, Lium, RunPod, Akash, io.net, WhatToMine, NiceHash, MiningRigRentals, Hyperliquid, CoinGecko, mempool.space and the Bittensor RPC. So the Railway thread's warning didn't hold for this region on this date.
- **GitHub runner:** not tested, and not needed now that Railway runs the recorder.
- **User agent:** WhatToMine, Clore, Akash and io.net reject Python's default user agent with Cloudflare error 1010. **Every request the recorder makes sends a browser-style `User-Agent`.**

### The math

**Inputs per GPU model:**
- Hashrate and power per algorithm come from NiceHash's benchmark table.
- Spec facts (VRAM, FP32 and FP16 TFLOPS, TDP) come from a small hand-kept table of the cards that appear in the rental listings. The builder fills it from public spec sheets.
- GPU names differ across sources ("RTX 4090", "GeForce RTX 4090", "NVIDIA RTX 4090"), so one normalisation table maps them all to a single model id.

**Proportional (PoW), per coin and GPU:**
```
coins_per_day = hashrate / network_hashrate × (86400 / block_time) × block_reward
revenue_day   = coins_per_day × price × (1 − pool_fee)
```
- **Price:** the coin's USD price, from Binance if it's listed there, otherwise WhatToMine's BTC exchange rate × the BTC price.
- **Luck:** with λ = expected blocks found in the horizon, the chance of at least one block is 1 − e^(−λ).
- **Selling on NiceHash:** `hashrate × nicehash_price(algo) × BTC price × (1 − seller fee)`.

**Competitive (Bittensor), per subnet:**
- The recorder computes each non-owner slot's TAO/day with the formula in tao's [brain/earnings.py](../../../../Heading/tao/brain/earnings.py), copied over, with its origin noted.
- It writes percentiles (p10, p25, p50, p75, p90, top) and the share of slots earning zero to `latest.json`.
- The visitor's percentile defaults to the 25th percentile of non-zero earners, the same default the tao brain uses. *(The visitor can change it.)*
- The registration fee is spread over the horizon. There's a warning that a slot pruned after its immunity window loses the fee.
- **Hardware fit:** subnet hardware needs aren't on chain, so a hand-kept table lists minimum VRAM and whether a subnet needs a GPU at all. Subnets missing from the table show "hardware needs unknown". The builder seeds the table with the subnets that pay the most.

**Rented out (owning mode only):**
```
revenue_day = market_price_per_hour(GPU model, market) × 24 × utilisation × (1 − platform fee)
```
- **Market price:** the median listing price for that GPU model on that market.
- **Utilisation** comes from the market's own signals where they exist: Clore's `rented` share, io.net's hired ÷ total, Akash's available ÷ total, Lium's availability, MiningRigRentals' rented rigs. Where no signal exists, the visitor sets it, with a default of 50% *(my call)*.
- **Platform fees:** a hand-kept table with a source link for each fee. The builder looks them up.

**Costs:**
- **Owning mode:** power while working × 24 h × $/kWh. For rent-out rows, the cost is power × utilisation plus idle power for the rest.
- **Renting mode:** the cheapest current hourly price for that GPU model across the markets, restricted to markets whose mining terms aren't "banned". Rows whose terms are "unknown" or "restricted" carry a flag.

**Comparing cards in renting mode:** an extra column shows net $ per TFLOP-hour, so different GPU models can be compared. *(my call)*

**Forecasts:**
- **Price paths are lognormal with no drift.** Volatility is implied where options exist, otherwise 30-day realised.
- **Network hashrate** follows its recent trend from the archive. Until the archive has 30 days of history, use WhatToMine's 24-hour change, capped. Mark this as naive with a `ponytail:` comment, upgrade when history exists.
- **Halvings and emission changes** come from a hand-kept table of upcoming dates for the coins shown.
- **Rental prices** are assumed flat until the archive has a trend.
- **Output:** p10, p50 and p90 of net $ over the horizon. The method, closed-form or a small Monte Carlo in the browser, is left to the builder.

### The page

- **Controls:** a mode toggle (owning / renting), a GPU picker, an electricity price field (owning mode only) and a horizon picker.
- **Results:** a ranked table of "what this card can do", one row per option. Each row shows:
  - the path and where you'd run it
  - net $/day
  - the p10–p90 range over the horizon
  - break-even (price, and electricity in owning mode)
  - flags: terms, hardware unknown, stale data, zero-earner share
- **Expanding a row** shows its inputs and assumptions. The visitor can edit pool fee, rank percentile, utilisation and fees, and the row recomputes.
- **Footer:** a data timestamp ("data from 14:05 UTC") and a short "not financial advice" note.
- **Must work on a phone.**
- Renting mode also shows a second table of "buy hashrate" rows: NiceHash and MiningRigRentals per algorithm → the best coin for that algorithm. It's ranked by margin % and has its own budget field (see Goal 2).

## Decided by the owner

- It's a website, hosted on Cloudflare, that does the calculations.
- Hourly updates.
- Covers coins that can be mined, plus Bittensor. Staking is out.
- A "what can I do with my GPU" calculator, with **owning a card** and **renting cards** modes.
- Public site, no login.
- Data goes in an open GitHub repo on the owner's account. No cash, so $0 running cost.
- The recorder runs on Railway, in the existing test project (2026-11-02).
- A private repo, `tao-calc-data-private`, holds what can't be public (2026-11-02).
- The site stays non-commercial (2026-11-02).
- Free API keys are fine.
- Save options data and other useful time series. Historical options data is hard to find, so we build our own.
- Ideas the owner liked: rent out vs mine (1), break-even (2), the luck spread including TAO's version (3), and forecasts (4).
- Saved data should later help improve the tao project's estimates.

## My calls (owner to check)

- Python for the recorder (reuses the tao code) and TypeScript for the static site.
- Raw snapshots go to monthly GitHub Releases instead of git commits. Git keeps only `latest.json` and daily summaries. Hugging Face is the fallback if GitHub objects.
- The site reads data from the repo's raw URL, and Cloudflare Pages rebuilds only on code changes. GitHub Pages is the fallback.
- Save every hourly fetch exactly as it arrived, rather than a curated subset.
- Don't save data that's permanent elsewhere. Keep licence-restricted sources out of the public archive.
- The Hyperliquid part of the tao laptop recorder moves into this hourly job. The Cboe part stays local.
- NiceHash's device table is the source of GPU × algorithm hashrates and power.
- Default rank percentile is the 25th percentile of non-zero earners. Default utilisation, where no signal exists, is 50%.
- **What the range on each row means.** Bittensor's headline uses the chosen rank, its range is price uncertainty, and the rank spread appears on its own line. Rent-out uses a utilisation band of ± 20 percentage points. The GPU table is ranked by p50.
- "Buy hashrate" rows get their own table, ranked by margin %, with a budget field (default $10/day) priced against the live order book.
- Figures derived from a source (percentiles, volatility) may go into the public `latest.json` and summaries even when that source's raw data can't be republished, **unless the source's terms also cover derived data, as Deribit's do.**
- Deribit's data goes in the private repo. The main repo stays public.
- A $/TFLOP-hour column in renting mode.
- No alerts yet.

## Left to the builder

- Project layout, the snapshot file format (JSON lines and gzip or zstd), and the `latest.json` schema, which must stay small.
- Getting the full Vast offer list (the right keyless query, or a free key).
- Checking real Railway usage after the first week against the $1 credit.
- CORS and caching on raw GitHub URLs.
- The terms check for each source, and the platform fee and mining terms tables.
- Seeding the subnet hardware table, the GPU spec table, the name normalisation table and the halving table.
- The forecast method (closed-form or Monte Carlo).
- Which free-key sources to add (TensorDock, Prime Intellect, CoinGecko demo).

## Owner to-dos

- Create the public GitHub repo on your account, or let the builder create it with `gh`.
- Create a Cloudflare account (free, no card) and connect Pages to the repo.
- Optional: email info@deribit.com to ask for written approval to publish Deribit option data in a free, non-commercial open archive.
- ~~Create the private archive repo.~~ Done 2026-11-02: `tao-calc-data-private`.
- Create the fine-grained token `GH_TOKEN` and store it as a Railway variable. Add the public repo to the token once that repo exists.
- Add any free API keys yourself as Railway variables. Never paste them into chat or files. The Alpha Vantage key pasted into chat on 2026-10-31 should be regenerated, although this project doesn't need it.
