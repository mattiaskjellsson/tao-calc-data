# What can my GPU do?

A free, non-commercial calculator that answers one question: **what's the most profitable thing to do with this GPU right now?**

The options are:

- mining a proof-of-work coin
- running a Bittensor subnet miner
- selling the hashrate (NiceHash, MiningRigRentals)
- renting the card out (Vast, Clore, Lium, RunPod, Akash, io.net)

Every row shows:

- net $/day
- a p10–p90 range over the horizon you pick
- a break-even price
- warning flags

It also keeps an **open hourly archive** of market data that the free sources don't keep themselves, such as option books, GPU rental prices and per-slot Bittensor incentives.

Not financial advice. Earnings can be zero or negative.

## How it works

| Part | What | Where |
|---|---|---|
| `recorder/` | Python, run hourly by a Railway cron. It fetches every source, archives the raw responses and writes `site-data/`. | Railway |
| `site/` | Static TypeScript page. All the math runs in the browser (`site/src/calc.ts`), from `site-data/latest.json` read off this repo's raw URL. | GitHub Pages / Cloudflare Pages |
| `tables.json` | Hand-kept tables: GPU specs and name aliases, algorithm names, platform fees (with sources), hosts' mining terms, halvings, subnet hardware needs, defaults. | both |

The design is in [`docs/superpowers/specs/2026-10-31-gpu-calculator-design.md`](docs/superpowers/specs/2026-10-31-gpu-calculator-design.md).

## The data

### Files in git (`site-data/`)

| File | Updated | Contents |
|---|---|---|
| `latest.json` | hourly | What the site needs now. Prices (`usd`), annualised volatility (`vol`: implied from Binance options, else 30-day realised, else assumed), mineable coins (`coins`), NiceHash prices and compressed order books (`nicehash`), MiningRigRentals prices (`mrr`), GPU rental prices and utilisation per market (`rentals`, $/GPU-hour), per-subnet Bittensor earning percentiles in TAO/day (`subnets`), and per-source status (`sources`). |
| `daily/YYYY-MM-DD.json` | once a day | The first `latest.json` of each UTC day, for history. |
| `benchmarks.json` | when it changes | Hashrate (H/s) and power (W) per GPU and algorithm, from NiceHash's device table. |

### Raw hourly snapshots (GitHub Releases)

- There's one release per month, tagged `data-YYYY-MM`, with one asset per hour, `YYYY-MM-DDTHHZ.json.gz`.
- Each asset is gzipped JSON, `{"ts": ..., "sources": {name: response, ...}}`. Responses are saved exactly as they arrived, and a source that failed holds `{"error": "..."}`.
- To read one:
  ```bash
  gh release download data-2026-11 -R mattiaskjellsson/tao-calc-data -p '2026-11-03T10Z.json.gz'
  python3 -c "import gzip,json; d=json.load(gzip.open('2026-11-03T10Z.json.gz')); print(list(d['sources']))"
  ```
- **What's in the public archive:** raw data only from sources whose terms allow republishing (`publish_raw` in `tables.json`, see the table below). Bittensor metagraphs are trimmed to:
  - netuid, name, `tao_in`, `alpha_in`, `alpha_out_emission`, burn, immunity and owner coldkey
  - per slot: hotkey, coldkey, incentive and registration block
- **Everything else** goes to a private archive. Figures derived from those sources still appear in `latest.json`.

### Sources and their terms (checked 2026-11-04)

| Source | Raw data public? | Terms, and why |
|---|---|---|
| Binance (tickers, options marks, daily closes) | yes | [Vision Dataset Terms](https://data.binance.vision/Binance_Vision-Terms_of_Use.pdf): CC BY-NC-SA 4.0, non-commercial. |
| Bittensor (Finney chain) | yes | Public blockchain data. |
| NiceHash (prices, order books, device benchmarks) | yes | [Terms](https://www.nicehash.com/terms): no clause restricts public market data. The redistribution clause covers their software. |
| Hyperliquid (5-minute candles) | yes | On-chain market data. Their docs say "You can use the API to record additional historical data sets yourself" ([historical data](https://hyperliquid.gitbook.io/hyperliquid-docs/historical-data)). |
| WhatToMine (coin network stats) | no | [Terms](https://whattomine.com/policy-terms): the API may not be used "for any application that replicates or attempts to replace the essential user experience of whattomine.com". **Open question, see below.** |
| MiningRigRentals | no | Their [API help](https://www.miningrigrentals.com/helpcenter/API) allows "legitimate integrations, tools, analysis", but the [ToS](https://www.miningrigrentals.com/tos) needs written permission to "reproduce, distribute". |
| CoinGecko (BTC/TAO fallback) | no | [API terms](https://www.coingecko.com/en/api_terms): no redistribution without a paid licence. |
| Clore, Lium | no | [Clore terms](https://clore.ai/terms-and-conditions) and [Lium terms](https://lium.io/terms) grant only a limited licence and say nothing about data reuse. Listings include host identifiers. |
| Akash, io.net | no | Terms pages not found. Private until checked. |
| Vast | **not collected** | [Terms of Use](https://vast.ai/terms) (2026-09-01) forbid automated retrieval, and any "index, benchmark, pricing-comparison service" without a written agreement. Listed in `skip_sources`. |
| RunPod | **not collected** | [Terms of Service](https://www.runpod.io/legal/terms-of-service) (2026-03-24) forbid access "through automated or non-human means" and compiling databases. Listed in `skip_sources`. |
| Deribit | private only | Personal use only, including derived data, so nothing from Deribit reaches this repo or the site. |

To start collecting Vast or RunPod again, get their written permission and remove them from `skip_sources`.

### Licence and credit

- Binance data, and figures derived from it, come from [Binance Vision](https://data.binance.vision) and are shared under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). That's why the whole data archive in this repo is CC BY-NC-SA 4.0: credit the source, non-commercial use only, share alike. Binance doesn't endorse this project.
- Binance's terms explicitly cover `data.binance.vision`. Whether they also cover the live API hosts used here (`data-api.binance.vision`, `eapi.binance.com`) isn't certain.
- Bittensor data is read from the public Finney chain.
- If this project is ever monetised, the Binance data comes out.

## The math, briefly

- **PoW:** `coins/day = hashrate / network hashrate × 86400 / block time × block reward × (1 − pool fee)`.
- **Bittensor:** each non-owner slot's TAO/day is `incentive / Σ incentive × alpha emission × 7200 × 0.41 × alpha price`. This is the same formula as the tao project's `brain/earnings.py`.
  - The headline is your rank among earners (default p25) × the chance of earning. That chance is what newcomers actually got: the share of slots registered in the last 14 days that earn. With fewer than 5 newcomers, it's the share of all slots earning.
  - Subnets with fewer than 10 earners count as winner-take-all, worth 0 for a new slot.
  - Rows are flagged when 3 wallets take over 75% of rewards, or when miners' daily payout is over 1% of the pool's TAO reserve.
  - `subnet_hw` in `tables.json` records what each audited subnet's miner actually runs. Subnets that don't use a GPU are hidden by default, and subnets marked `skip` (staking-like) never appear.
- **Buying hashrate:** the NiceHash order book is walked to fill your budget, never below NiceHash's own paying price. Margins over +100% are flagged as suspect.
- **Rent-out:** `median price × 24 × utilisation × (1 − platform fee)`, minus power. The range is utilisation ± 20 percentage points.
- **Range:** lognormal prices with no drift, using the average-price quantile `S·exp(z·σ·√(T/3))`. Network growth comes from the 24 h difficulty trend, capped at ±0.2%/day, and halvings from `tables.json`.

## Running it

```bash
# recorder, without touching GitHub: writes recorder/out/
cd recorder && DRY_RUN=1 uv run --python 3.12 --with-requirements requirements.txt python main.py
uv run --python 3.12 --with pytest pytest -q            # tests

# site
cd site && npm ci && npm test                             # tests (node:test)
npm run build && mkdir -p site-data && cp ../recorder/out/site-data/*.json site-data/
python3 -m http.server 8080                               # open http://localhost:8080/?data=./site-data/
```

### Deploying

- **Recorder:** run `railway up --service recorder` from the repo root. The service settings are Dockerfile path `recorder/Dockerfile`, cron `5 * * * *` and restart policy never. They were set once through Railway's API (`serviceInstanceUpdate`) because Railway no longer reads `railway.json`.
  - The service needs `GITHUB_REPO_DATA_KEY`: a fine-grained token with Contents read and write on this repo and the private archive repo.
  - `PUBLIC_REPO` and `PRIVATE_REPO` are optional overrides.
- **Site on Cloudflare Pages** (https://tao-calc.pages.dev): run `cd site && npm run deploy:cloudflare`. It uses your local `wrangler` login and uploads `_site/` to the Pages project `tao-calc`. Only code changes need a deploy, because the page reads the hourly data straight from this repo.
- **Site on GitHub Pages** (https://mattiaskjellsson.github.io/tao-calc-data/): `.github/workflows/site.yml` deploys on pushes that change anything outside `site-data/`.
- **Pushing:** the recorder commits `site-data/latest.json` to `main` every hour, so run `git pull --rebase` before you push.
