# GPU calculator v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An hourly recorder on Railway that archives the sources and writes `site-data/latest.json`, plus a static page that ranks what a GPU can do with it.

**Architecture:**
- **The recorder** is a Python cron job on Railway. Each hour it fetches every source, gzips the raw results and uploads them to a monthly GitHub Release. Deribit goes to the private repo. It then reduces the raw results to a small `latest.json` and commits it through the GitHub Contents API.
- **The site** is plain TypeScript, compiled with `tsc`. It loads `latest.json` from the raw GitHub URL and the hand-kept `tables.json` from its own origin, and does all the math in the browser.

**Tech Stack:**
- Python 3.12, stdlib `urllib`, `bittensor==11.3.0`, pytest.
- TypeScript 5 with `tsc` only, `node --test`.
- Railway cron, GitHub Releases and the Contents API, GitHub Pages for v1. Cloudflare Pages takes over once the owner connects it.

**Spec:** `docs/superpowers/specs/2026-10-31-gpu-calculator-design.md`

## Global Constraints

- $0 running cost. No paid tier, and no payment card anywhere.
- Every outbound request sends a browser-style `User-Agent`. WhatToMine, Clore, Akash and io.net answer 1010 without one.
- Each source is fetched on its own. A failure is logged in that hour's file and never stops the others.
- Keys exist only as environment variables (`GITHUB_REPO_DATA_KEY`). They never appear in code, commits, files or logs. `.env` is git-ignored.
- Deribit data (books and DVOL) goes only to `mattiaskjellsson/tao-calc-data-private`. Nothing from Deribit goes into `latest.json` or the public archive.
- Binance data is used under CC BY-NC-SA 4.0, with credit to Binance Vision, in the README and the page footer. The project is non-commercial.
- Raw snapshots go to release `data-YYYY-MM` as asset `YYYY-MM-DDTHHZ.json.gz`, in the public repo and the private one alike.
- Git holds only `site-data/latest.json` (hourly), `site-data/daily/YYYY-MM-DD.json` (once a day) and `site-data/benchmarks.json` (only when it changes). The budget is under 100 MB a year, so `latest.json` stays under about 60 KB raw.
- The page shows the data timestamp and flags any source more than 3 hours old. The footer reads "not financial advice". The page must work on a phone.
- Defaults:
  - rank percentile p25
  - utilisation 50% where no signal exists
  - pool fee 1%
  - NiceHash buyer fee 3%
  - buy budget $10/day
  - fallback volatility 120%/yr
  - network growth cap ±0.2%/day
  - idle power 10% of TDP
  - utilisation band ± 20 percentage points

## Review Focus

- **A source that fails or comes back empty** (Clore 1010, Vast `[]`): that market's rows disappear, every other row still renders, and the page flags the source.
- **A GPU with no NiceHash benchmark** (A100, H100…): no PoW rows, but the Bittensor and rent-out rows still show. No `NaN` anywhere. *(test in Task 5)*
- **A coin with no USD price, or zero nethash or block time:** the row is skipped. Never show `Infinity` or `NaN`. *(tests in Tasks 2 and 5)*
- **A budget larger than the whole NiceHash book:** the buy is capped at the book's depth and the row is labelled "book exhausted". *(test in Task 5)*
- **`latest.json` failing to load, or older than 3 h:** a visible banner appears, not a blank table. *(Task 6, manual check)*

---

### Task 1: Repo skeleton and the hand-kept tables

**Files:**
- Create: `.gitignore`
- Create: `tables.json`
- Create: `README.md` (stub, completed in Task 7)

**Interfaces:**
- Produces: `tables.json`, read by the recorder (`recorder/reduce.py`) and the site (`site/dist/tables.json`). Shape:
  ```
  gpus:        {id: {name, vram, fp32, tdp, nicehash: <NH device name>|null, aliases: [normalised names]}}
  algos:       {id: {wtm: [WhatToMine algorithm names], nicehash: <NH key>|null, mrr: <MRR name>|null}}
  fees:        {market: {fee, src, confirmed}}       // market ∈ vast clore lium runpod akash ionet nicehash mrr
  terms:       {market: "allowed"|"restricted"|"banned"|"unknown"}
  halvings:    {TAG: [[ISO date, factor]]} | {TAG: {decay_per_year}}
  subnet_hw:   {netuid: {gpu: bool, vram?: GB, note?}}
  defaults:    {pool_fee, util, rank_pct, buy_fee_nicehash, budget, vol_fallback, growth_cap_day, idle_frac, util_band}
  ```
- `norm(name)` = lowercase, drop every non-alphanumeric character, then drop `nvidia`, `geforce` and `tesla`. Aliases are stored already normalised.

- [ ] **Step 1:** Create `.gitignore` with `.env`, `node_modules/`, `site/dist/`, `__pycache__/`, `.venv/` and `out/`.
- [ ] **Step 2:** Write `tables.json`:
  - **GPUs:** about 30 cards seen across the markets, with aliases taken from the market names sampled on 2026-11-03.
  - **Algorithms:** every WhatToMine algorithm that also has a NiceHash device-speed key, including the special cases ethash→`DAGGERHASHIMOTO`, BeamHashIII→`BEAMV3`, FishHash→`IRONFISH` (device key) and Karlsenhashv2→`KARLSENHASH`.
  - **Fees:** Vast 15% (unconfirmed), Clore 10%, io.net 2.25%, Akash 2%, Lium and RunPod 20% (unknown, conservative), NiceHash seller 2%, MRR 3%. Each fee gets a source link.
  - **Mining terms:** Vast restricted, Clore allowed, the rest unknown.
  - **Halvings:** LTC (2027-07, 0.5), BTC (2028-04, 0.5), KAS (`decay_per_year` 0.5).
  - **Subnet hardware:** seed a few well-known subnets and mark each "verify".
- [ ] **Step 3:** Run `python3 -c "import json;json.load(open('tables.json'))"`. Expected: no output.
- [ ] **Step 4:** Run `git init` and commit. Run `git status` first and confirm `.env` is absent from it.

### Task 2: Recorder reduce (pure functions, tested)

**Files:**
- Create: `recorder/reduce.py`
- Test: `recorder/test_reduce.py`

**Interfaces:**
- Consumes: the raw dict from Task 3, `{source_name: payload | {"error": str}}`, and `tables.json`.
- Produces:
  - `norm(s: str) -> str`
  - `gpu_id(name: str, aliases: dict[str,str]) -> str | None`
  - `subnet_stats(mg: dict) -> dict`, copied from tao `brain/earnings.py` with its origin noted. It returns `{netuid, name, price_tao, burn_tao, immunity_blocks, n, zero_share, p: {p10,p25,p50,p75,p90,top}}` in TAO/day, with percentiles over non-zero non-owner earners.
  - `atm_iv(marks: list, spot: dict[str,float], now_ms: int) -> dict[str,float]`: for each underlying, the mean `markIV` of the call and the put nearest the money at the expiry nearest 30 days.
  - `realised_vol(closes: list[float]) -> float`: the annualised standard deviation of daily log returns (×√365).
  - `nicehash_book(orders: list, price_factor: float, market_factor: float, levels=20) -> list[[btc_per_hs_day, cum_hs]]`: orders with `acceptedSpeed > 0` sorted by price ascending and bucketed to at most `levels` rows.
  - `reduce(raw: dict, tables: dict, now: datetime) -> dict`: the `latest.json` below.
  - `benchmarks(devices: list, tables: dict) -> dict`, which becomes `site-data/benchmarks.json`: `{ts, gpus: {id: {algo_id: [hs, watts]}}}`.
- `latest.json` schema, the contract with the site:
  ```
  ts, sources: {name: {ok, error?}}
  usd: {TAG: price}            // BTC, TAO and every coin used
  vol: {TAG: {sigma, kind: "implied"|"realised"|"assumed"}}   // annualised
  coins: [{tag, name, algo, block_time, block_reward, nethash, growth_day, list: "gpu"|"asic"}]
  nicehash: {algo_id: {pay: btc_per_hs_day, book: [[btc_per_hs_day, cum_hs]]}}
  mrr: {algo_id: {price: btc_per_hs_day, rented: share 0..1}}
  rentals: {gpu_id: {market: {min, med, n, util|null}}}   // $/GPU-hour
  subnets: [subnet_stats…]     // only subnets with ≥1 earner
  unmatched: {market: [up to 20 raw names]}
  ```
- **Unit facts:**
  - NiceHash `stats.p` × 1e-8 = BTC per H/s per day. Checked against a 4090's "paying" field.
  - NiceHash book price ÷ `priceFactor` = BTC per H/s per day, and `acceptedSpeed` × `marketFactor` = H/s.
  - MRR `suggested_price.amount` is per `unit` ("mh*day", etc.), where k=1e3, m=1e6, g=1e9, t=1e12 and p=1e15.
  - WhatToMine `nethash` is in H/s, and its `exchange_rate` is in BTC.
  - `growth_day` = ln(`difficulty` / `difficulty24`), clamped to ±`growth_cap_day`. Mark this with a `# ponytail:` comment: the 24 h trend is naive, so switch to the archive's 30-day trend.
  - Skip WhatToMine coins named `Nicehash-*`.
  - A coin's price comes from the Binance `TAGUSDT` `lastPrice`, otherwise `exchange_rate` × BTC.

- [ ] **Step 1: Write the failing tests**
  - `test_norm_and_alias`: `gpu_id("NVIDIA GeForce RTX 4090")`, `"RTX 4090"`, `"GeForce RTX 4090"` and Akash `"rtx4090"` all give `"rtx4090"`, and `gpu_id("Mixed GPUs")` is `None`.
  - `test_subnet_stats_excludes_owner_and_zero`: an owner UID with all the incentive is excluded, `zero_share` is 0.5 when 2 of 4 non-owner slots have 0, and the percentiles come from the 2 earners only.
  - `test_atm_iv_picks_30d_atm`: three expiries (7, 28 and 90 days) and strikes 90/100/110 with spot 100 give the mean of the 28-day, strike-100 call and put `markIV`.
  - `test_realised_vol`: alternating closes of 100 and 110 come to ≈ `0.0953 × √365` within 1e-6.
  - `test_nicehash_book_drops_dead_orders`: an order with `acceptedSpeed` "0" is absent, and cumulative speed is monotonic.
  - `test_reduce_skips_bad_coins`: a WhatToMine coin with `nethash` 0, or with no price at all, is absent from `coins`.
  - `test_reduce_marks_failed_source`: `raw["clore"] = {"error": "1010"}` gives `sources.clore.ok == False`, and `rentals` simply has no `clore` keys.
- [ ] **Step 2:** Run `cd recorder && uv run --with pytest pytest -q`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement the functions above in `recorder/reduce.py` with stdlib only.
  - **Rentals:**
    - Vast queries one model at a time, so `min` and `med` come from the 64 cheapest. Mark this `# ponytail:` "median is of the 64 cheapest offers".
    - Clore uses `price.usd.on_demand_usd` ÷ GPU count, for the GPU parsed from `specs.gpu` "Nx NAME", with `util` = rented share.
    - Lium uses `price_per_gpu_hour`, with `util` = 1 − available/total GPUs.
    - RunPod uses `lowestPrice.uninterruptablePrice`, with `n=1` and `util` null.
    - Akash uses `price.med` and `min`, with `util` = 1 − available/total, matched on `model`+`ram`+`interface`, falling back to `model`.
    - io.net uses `price`, with `util` = hired/total.
- [ ] **Step 4:** Run `cd recorder && uv run --with pytest pytest -q`. Expected: all pass.
- [ ] **Step 5:** Commit.

### Task 3: Recorder fetch

**Files:**
- Create: `recorder/fetch.py`
- Create: `recorder/requirements.txt` (`bittensor==11.3.0`)

**Interfaces:**
- Produces:
  - `fetch_all(tables: dict, now: datetime, daily: bool) -> tuple[dict, dict]`, returning `(public_raw, private_raw)`. Each is `{source: payload | {"error": str}}`.
  - Public sources:
    - `binance_24h`
    - `binance_options`
    - `binance_klines`: `{TAG: closes}` for 31 daily closes of each coin used that Binance lists, plus TAO
    - `wtm_gpu`, `wtm_asic`
    - `nicehash_stats`, `nicehash_algos`, `nicehash_books` (`{NH_ALGO: book}`)
    - `nicehash_devices`: only when `daily`, the first run after 00 UTC
    - `mrr_algos`
    - `vast` (`{gpu_id: offers}`), `clore`, `lium`, `runpod`, `akash`, `ionet`
    - `bittensor`: a list of trimmed metagraph dicts
    - `hyperliquid`: `{coin: candles}`, the last 2 h of 5-minute candles for `xyz:GOLD xyz:NVDA xyz:TSLA xyz:AAPL xyz:GOOGL xyz:SP500 xyz:SPCX xyz:CL xyz:VIX`, from tao `sn50/data.py`
    - `coingecko`: BTC and TAO, as the fallback
  - Private sources: `deribit_btc`, `deribit_usdc` (book summaries), and `deribit_dvol` (the last 2 h at resolution 3600 for BTC and ETH).
  - The trimmed Bittensor metagraph keeps `netuid name symbol tao_in alpha_in alpha_out_emission burn immunity_period owner_coldkey num_uids max_uids hotkeys coldkeys incentives block_at_registration block`, with any other key dropped.

- [ ] **Step 1:** Implement `get(url, body=None, timeout=40)` with the browser UA, plus one wrapper that catches every exception into `{"error": repr(e)[:300]}`. The Bittensor read uses `bt.Subtensor("finney")`, then `.read("subnets")` and `.read("metagraph", netuid=…)` per subnet. Each subnet is isolated, so one failure gives that subnet `{"netuid", "error"}`.
- [ ] **Step 2:** Run a smoke check: `cd recorder && uv run --python 3.12 --with-requirements requirements.txt python -c "…fetch_all…; print({k: 'error' in v if isinstance(v, dict) else len(v) for k, v in pub.items()})"`. Expected: every source except the optional ones is present without an error, and the run takes under 3 minutes.
- [ ] **Step 3:** Commit.

### Task 4: Recorder main (publish) and container

**Files:**
- Create: `recorder/main.py`
- Create: `recorder/Dockerfile`
- Create: `recorder/railway.json` (cron `5 * * * *`, restart policy never)
- Test: `recorder/test_reduce.py` (add `test_asset_names`)

**Interfaces:**
- Consumes: `fetch_all` and `reduce`/`benchmarks`.
- Produces:
  - `asset_name(now) -> ("data-2026-11", "2026-11-03T10Z.json.gz")`
  - `gh(method, path, token, body=None, data=None, ctype=None) -> dict`, the GitHub REST client: `api.github.com` with `uploads.github.com` for assets.
  - `ensure_release(repo, tag, token) -> upload_url`
  - `upload(repo, tag, name, gz, token)`, which skips quietly when the asset already exists (re-runs within the hour).
  - `put_file(repo, path, bytes, msg, token)`, the Contents API with the current `sha`.
  - `main()`, which uses `PUBLIC_REPO` (default `mattiaskjellsson/tao-calc-data`), `PRIVATE_REPO` (default `mattiaskjellsson/tao-calc-data-private`), `GITHUB_REPO_DATA_KEY`, and `DRY_RUN=1`. In dry-run mode it writes into `out/` instead of calling GitHub.
  - Order of work:
    1. Fetch.
    2. Upload the public snapshot.
    3. Upload the private one.
    4. Write `latest.json`.
    5. Write `daily/<date>.json` if it's absent.
    6. Write `benchmarks.json` if it has changed.
  - Each step catches its own exception and logs it, so a private-repo 401 never blocks the public data. Exit status 1 if any step failed, so Railway shows the failure.

- [ ] **Step 1:** Write `test_asset_names` (`datetime(2026,11,3,10,7)` gives the tuple above) and watch it fail.
- [ ] **Step 2:** Implement `main.py` and make the test pass.
- [ ] **Step 3:** Run `cd recorder && DRY_RUN=1 uv run --python 3.12 --with-requirements requirements.txt python main.py`. Expected: `out/public/…json.gz`, `out/private/…json.gz` and `out/site-data/latest.json` (under 60 KB) are written, with exit 0.
- [ ] **Step 4:** Write the Dockerfile: `python:3.12-slim`, pip install requirements, copy `recorder/` and `tables.json`, `CMD python main.py`. Build context is the repo root.
- [ ] **Step 5:** Commit.

### Task 5: Site math (pure, tested)

**Files:**
- Create: `site/package.json` (`typescript` dev dep; scripts `build: tsc && cp ../tables.json dist/`, `test: npm run build && node --test dist/`)
- Create: `site/tsconfig.json` (strict, ES2022 modules, `outDir: dist`, `rootDir: src`)
- Create: `site/src/calc.ts`
- Test: `site/src/calc.test.ts`

**Interfaces:**
- Consumes: the shapes of `latest.json`, `benchmarks.json` and `tables.json` (Tasks 1–2), declared as TS types in `calc.ts`.
- Produces:
  - `type Inputs = {mode: "own"|"rent", gpu: string, kwh: number, horizon: 1|7|30|90|365, rankPct: number, util: number|null, poolFee: number, budget: number}`
  - `type Row = {kind: "pow"|"nicehash"|"mrr"|"tao"|"rent", label, where, netDay, p10, p50, p90, breakEvenPrice?: {value, pctFromNow, unit}, breakEvenKwh?, flags: string[], detail: Record<string,string|number>}`. `p10`/`p50`/`p90` are net $ over the horizon. `detail` holds the expanded-row inputs and assumptions.
  - `gpuRows(inp, latest, bench, tables, now: Date) -> Row[]`, sorted by `p50` descending. It returns no rows containing `NaN` or `Infinity`.
  - `buyRows(inp, latest, tables) -> BuyRow[]`, where `BuyRow = {algo, venue: "nicehash"|"mrr", coin, marginPct, spend, revenue, flags}`, sorted by `marginPct` descending.
  - `rentCost(gpu, latest, tables) -> {usdHour, market, terms} | null`: the cheapest `min` across markets whose terms aren't "banned".
  - Helpers, exported for tests:
    - `Z90 = 1.2815515655`
    - `avgPriceQuantile(S, sigmaYr, days, z) = S·exp(z·σ_yr·√(days/365/3))`. Mark it `// ponytail:` "geometric-average approximation; Monte Carlo if it's ever off".
    - `unitsOverHorizon(perDay, growthDay, days, emission: (dayIndex) => factor) = Σ_{t<days} perDay·e^(−growthDay·t)·emission(t)`
    - `soloChance(lambda) = 1 − e^(−λ)`
    - `fillBook(book, budgetBtcDay, fee) -> {hs, priceBtc, exhausted}`: the largest H/s with `hs × p(hs) × (1+fee) ≤ budget`, where `p(hs)` is the price of the first level whose `cum_hs ≥ hs`. When the book is exhausted, `hs` is the last `cum_hs`.
- **Row formulas (from the spec's "The math"):**
  - **PoW:** `perDay = hs/nethash × 86400/block_time × reward × (1−poolFee)` coins, and the cost is `watts/1000 × 24 × kwh` in own mode or `rent $/h × 24` in rent mode. The `detail` shows the solo chance over the horizon.
  - **NiceHash sell:** `hs × pay × (1 − fees.nicehash)` in BTC/day. Own mode only.
  - **MRR sell:** `hs × price × rented × (1 − fees.mrr)` in BTC/day. Own mode only.
  - **Bittensor:** TAO/day at `rankPct`, interpolated between the stored percentiles. The registration burn × TAO price is added to the horizon cost. Flags:
    - "N% of slots earn 0"
    - "hardware needs unknown", "CPU-only, your GPU isn't used", or "needs ≥X GB VRAM", the last of which skips the row when the card has less VRAM
    - "registration lost if pruned after immunity"
    - `detail` gives the rank spread from p10 to p90.
  - **Rent-out** (own mode only, one row per market with a price): `med × 24 × u × (1−fee) − (tdp×u + idle×(1−u))/1000 × 24 × kwh`, where `u` is the market's `util`, otherwise `inp.util`, otherwise the default. p10 and p90 use `u ∓ 0.2`, clamped to 0–1. Mark this `// ponytail:` "naive band, replace with the archive's measured utilisation spread once there's 30 days of history".
  - **Break-even price:** `S* = horizonCost / unitsOverHorizon`. **Break-even kWh:** the kWh price where p50 = 0.
  - **Renting mode:** adds `netPerTflopHour = netDay / (fp32 × 24)` to `detail`. Rows with "restricted" or "unknown" terms carry a flag.

- [ ] **Step 1: Write the failing tests** in `calc.test.ts` with `node:test` and `assert`:
  - `avgPriceQuantile` with z=0 equals S, and p90 > S > p10.
  - `unitsOverHorizon(10, 0, 30, () => 1) === 300`, and a halving at day 10 with factor 0.5 gives 10·10 + 20·5 = 200.
  - `soloChance(1)` ≈ 0.632.
  - `fillBook([[1e-14, 1e6], [2e-14, 3e6]], …)`: a small budget fills at the first level, a mid budget at the second, and a huge budget gives `exhausted: true` with `hs === 3e6`.
  - `gpuRows` for an RTX 4090 fixture (KAWPOW 65 MH/s at 325 W, RVN coin, BTC 78,000, kwh 0.10, horizon 30) gives a PoW row whose `netDay` equals the formula's value computed in the test, and `p10 < p50 < p90`.
  - `gpuRows` for an `h100` fixture with no benchmark gives no PoW rows, but does give a tao row and a rent row, and no field anywhere is `NaN`.
  - A coin with `nethash: 0` or a missing price produces no row.
  - Rent-out with util 0.9 clamps p90 at u = 1.
- [ ] **Step 2:** Run `cd site && npm install && npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement `calc.ts`.
- [ ] **Step 4:** Run `npm test`. Expected: all pass.
- [ ] **Step 5:** Commit.

### Task 6: Site UI

**Files:**
- Create: `site/index.html`, `site/style.css`, `site/src/app.ts`

**Interfaces:**
- Consumes: `gpuRows`, `buyRows` and `rentCost` from Task 5. `DATA_URL` defaults to `https://raw.githubusercontent.com/mattiaskjellsson/tao-calc-data/main/site-data/`, and `?data=./site-data/` overrides it for local runs.

- [ ] **Step 1:** Build the page:
  - **Controls:** a mode toggle (owning / renting), a GPU `<select>` listing GPUs that have a benchmark or a rental price, `$/kWh` (own mode only, default 0.15), a horizon `<select>`, rank percentile, utilisation, and a budget field (rent mode only).
  - **GPU table:** label and where, net $/day, p10–p90 over the horizon, break-even and flags. Clicking a row expands its `detail`. The top 25 rows show, with a "show all" button.
  - **Buy-hashrate table:** rent mode only.
  - **Banner:** shown if the fetch fails or `ts` is older than 3 h. Each row whose source is stale gets a flag.
  - **Footer:** the data time in UTC, "Not financial advice", the CC BY-NC-SA 4.0 credit to Binance Vision, and a link to the repo.
  - **Layout:** CSS only, with a single column below 700 px.
- [ ] **Step 2:** Run it locally with `cd site && npm run build && mkdir -p site-data && cp ../recorder/out/site-data/*.json site-data/ && python3 -m http.server 8080`, then open `http://localhost:8080/?data=./site-data/`. Expected: both modes render real rows, and a phone-width (390 px) view has no horizontal scroll. Check this in a browser and with a screenshot.
- [ ] **Step 3:** Commit.

### Task 7: Deploy and document

**Files:**
- Modify: `README.md`, which covers:
  - what this is
  - the archive layout and how to read a snapshot
  - the licences: Binance CC BY-NC-SA 4.0 with credit, Deribit kept private, the other sources and their terms
  - how to run locally
- Create: `.github/workflows/pages.yml`: build `site/` and deploy it to GitHub Pages on push, with `paths-ignore: site-data/**`.

- [ ] **Step 1:** Create the public repo `mattiaskjellsson/tao-calc-data` and push. Seed `site-data/` from the dry run so the page has data at once.
- [ ] **Step 2:** Enable Pages with source "GitHub Actions". Check that the Pages URL loads with live data from the raw URL. This checks CORS.
- [ ] **Step 3:** Set up Railway in project `binance-probe`:
  - Run the service from `recorder/Dockerfile` on cron `5 * * * *`.
  - Set the variable with `grep '^GITHUB_REPO_DATA_KEY=' .env | cut -d= -f2- | railway variable set GITHUB_REPO_DATA_KEY --stdin --skip-deploys`. The value is never echoed.
  - Deploy with `railway up`.
- [ ] **Step 4:** Trigger one run, then check the logs:
  - The private upload succeeds.
  - The public upload succeeds only after the owner adds `tao-calc-data` to the token. Until then, the run is expected to log a 403 or 404 for the public repo.
- [ ] **Step 5:** Commit and push.
