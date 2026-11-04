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
- **What's in the public archive:** raw data only from sources whose terms allow republishing (`publish_raw` in `tables.json`). Right now that's:
  - Binance tickers, options marks and daily closes
  - Bittensor metagraphs, trimmed to: netuid, name, `tao_in`, `alpha_in`, `alpha_out_emission`, burn, immunity, owner coldkey, and per-slot hotkey, coldkey, incentive and registration block
- **The other sources** (WhatToMine, NiceHash, MiningRigRentals, the GPU rental markets, Hyperliquid and CoinGecko) are archived privately until their terms are checked. Figures derived from them do appear in `latest.json`.
- **Deribit** option books and DVOL are archived privately only. Deribit's terms allow personal use only, including derived data, so nothing from Deribit reaches this repo or the site.

### Licence and credit

- Binance data, and figures derived from it, come from [Binance Vision](https://data.binance.vision) and are shared under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). That's why the whole data archive in this repo is CC BY-NC-SA 4.0: credit the source, non-commercial use only, share alike. Binance doesn't endorse this project.
- Binance's terms explicitly cover `data.binance.vision`. Whether they also cover the live API hosts used here (`data-api.binance.vision`, `eapi.binance.com`) isn't certain.
- Bittensor data is read from the public Finney chain.
- If this project is ever monetised, the Binance data comes out.

## The math, briefly

- **PoW:** `coins/day = hashrate / network hashrate × 86400 / block time × block reward × (1 − pool fee)`.
- **Bittensor:** each non-owner slot's TAO/day is `incentive / Σ incentive × alpha emission × 7200 × 0.41 × alpha price`. This is the same formula as the tao project's `brain/earnings.py`.
  - The headline is your rank among earners (default p25) × the share of slots earning now.
  - Subnets with fewer than 10 earners count as winner-take-all, worth 0 for a new slot.
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
- **Site on GitHub Pages:** `.github/workflows/site.yml` deploys on pushes that change anything outside `site-data/`.
- **Site on Cloudflare Pages:**
  - build command `cd site && npm ci && npm run build`
  - output directory `site`
  - build watch paths excluding `site-data/*`, so the hourly data commits don't use up the 500 builds a month
