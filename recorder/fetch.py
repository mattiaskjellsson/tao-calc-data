"""Fetch every source once. Each source is isolated: a failure becomes {"error": ...} and never stops the others."""
import ipaddress
import json
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

# WhatToMine, Clore, Akash and io.net answer Cloudflare error 1010 to Python's default user agent.
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"
BINANCE = "https://data-api.binance.vision/api/v3"
NICEHASH = "https://api2.nicehash.com/main/api/v2"
DERIBIT = "https://www.deribit.com/api/v2/public"
HL_COINS = ["xyz:GOLD", "xyz:NVDA", "xyz:TSLA", "xyz:AAPL", "xyz:GOOGL", "xyz:SP500", "xyz:SPCX", "xyz:CL", "xyz:VIX"]  # tao sn50/data.py
METAGRAPH_KEYS = ("netuid", "name", "symbol", "tao_in", "alpha_in", "alpha_out_emission", "burn", "immunity_period",
                  "owner_coldkey", "num_uids", "max_uids", "hotkeys", "coldkeys", "incentives", "block_at_registration", "block")


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    """Follow redirects only to https on a named public host: responses land in the public archive."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        u = urllib.parse.urlsplit(newurl)
        host = u.hostname or ""
        try:  # check every address the name resolves to, so a public-looking name can't point inside
            internal = not all(ipaddress.ip_address(a[4][0]).is_global for a in socket.getaddrinfo(host, 443))
        except (OSError, ValueError):
            internal = True
        if u.scheme != "https" or internal:
            raise urllib.error.HTTPError(newurl, code, f"refused redirect to {u.scheme}://{host}", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


OPENER = urllib.request.build_opener(SafeRedirect)


def get(url: str, body=None, timeout: int = 40):
    headers = {"User-Agent": UA, "Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, headers=headers)
    with OPENER.open(req, timeout=timeout) as r:
        return json.load(r)


def safe(fn, *args):
    try:
        return fn(*args)
    except Exception as e:
        return {"error": repr(e)[:300]}


def bittensor_metagraphs() -> list:
    import bittensor as bt  # heavy import, only the recorder run needs it

    sub = bt.Subtensor("finney")
    out = []
    for s in sub.read("subnets"):
        if s.netuid == 0:
            continue
        try:
            mg = sub.read("metagraph", netuid=s.netuid)
            out.append({k: mg.get(k) for k in METAGRAPH_KEYS})
        except Exception as e:
            out.append({"netuid": s.netuid, "error": repr(e)[:300]})
    return out


def vast(name: str):
    q = {"gpu_name": {"eq": name}, "num_gpus": {"eq": 1}, "rentable": {"eq": True}, "order": [["dph_total", "asc"]],
         "type": "on-demand"}
    return get("https://console.vast.ai/api/v0/bundles/?q=" + urllib.parse.quote(json.dumps(q)))


def klines_closes(tag: str) -> list[float]:
    return [float(k[4]) for k in get(f"{BINANCE}/klines?symbol={tag}USDT&interval=1d&limit=31")]


def hl_candles(coin: str, now_ms: int):
    return get("https://api.hyperliquid.xyz/info", {"type": "candleSnapshot", "req": {
        "coin": coin, "interval": "5m", "startTime": now_ms - 2 * 3_600_000, "endTime": now_ms}})


def deribit_dvol(currency: str, now_ms: int):
    return get(f"{DERIBIT}/get_volatility_index_data?currency={currency}&resolution=3600"
               f"&start_timestamp={now_ms - 2 * 3_600_000}&end_timestamp={now_ms}")


def fetch_all(tables: dict, now: datetime, daily: bool) -> tuple[dict, dict]:
    now_ms = int(now.timestamp() * 1000)
    simple = {
        "binance_24h": f"{BINANCE}/ticker/24hr",
        "binance_options": "https://eapi.binance.com/eapi/v1/mark",
        "wtm_gpu": "https://whattomine.com/coins.json",
        "wtm_asic": "https://whattomine.com/asic.json",
        "nicehash_stats": f"{NICEHASH}/public/stats/global/current",
        "nicehash_algos": f"{NICEHASH}/mining/algorithms",
        "mrr_algos": "https://www.miningrigrentals.com/api/v2/info/algos",
        "clore": "https://api.clore.ai/v1/marketplace",
        "lium": "https://lium.io/api/public/v1/nodes",
        "akash": "https://console-api.akash.network/v1/gpu-prices",
        "ionet": "https://api.io.solutions/v1/io-explorer/network/market-snapshot",
        "coingecko": "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,bittensor&vs_currencies=usd",
    }
    if daily:
        simple["nicehash_devices"] = f"{NICEHASH}/public/profcalc/devices"
    private_urls = {
        "deribit_btc": f"{DERIBIT}/get_book_summary_by_currency?currency=BTC&kind=option",
        "deribit_usdc": f"{DERIBIT}/get_book_summary_by_currency?currency=USDC&kind=option",
    }
    runpod_q = {"query": "{ gpuTypes { id displayName memoryInGb lowestPrice(input:{gpuCount:1})"
                         "{ minimumBidPrice uninterruptablePrice } } }"}
    books = sorted({a["nh_mkt"] for a in tables["algos"].values() if a.get("nh_mkt")})
    skip = set(tables.get("skip_sources", {}))  # sources whose terms forbid automated collection
    vast_models = {} if "vast" in skip else {gid: g["vast"] for gid, g in tables["gpus"].items() if g.get("vast")}

    with ThreadPoolExecutor(max_workers=16) as pool:
        chain = pool.submit(safe, bittensor_metagraphs)
        jobs = {k: pool.submit(safe, get, u) for k, u in {**simple, **private_urls}.items()}
        if "runpod" not in skip:
            jobs["runpod"] = pool.submit(safe, get, "https://api.runpod.io/graphql", runpod_q)
        book_jobs = {a: pool.submit(safe, get, f"{NICEHASH}/hashpower/orderBook?algorithm={a}&size=500") for a in books}
        vast_jobs = {gid: pool.submit(safe, vast, name) for gid, name in vast_models.items()}
        hl_jobs = {c: pool.submit(safe, hl_candles, c, now_ms) for c in HL_COINS}
        dvol_jobs = {c: pool.submit(safe, deribit_dvol, c, now_ms) for c in ("BTC", "ETH")}
        res = {k: f.result() for k, f in jobs.items()}

        # Daily closes for realised volatility: every Binance-listed coin the site prices, plus TAO.
        listed = {t["symbol"][:-4] for t in res["binance_24h"] if t["symbol"].endswith("USDT")} \
            if isinstance(res["binance_24h"], list) else set()
        algo_names = {w for a in tables["algos"].values() for w in a["wtm"]}
        tags = {"TAO", "BTC"} | {c["tag"] for k in ("wtm_gpu", "wtm_asic") if "coins" in res[k]
                                 for c in res[k]["coins"].values() if c["algorithm"] in algo_names}
        kl_jobs = {t: pool.submit(safe, klines_closes, t) for t in sorted(tags & listed)}

        public = {k: v for k, v in res.items() if k not in private_urls}
        public["nicehash_books"] = {a: f.result() for a, f in book_jobs.items()}
        if vast_jobs:
            public["vast"] = {gid: f.result() for gid, f in vast_jobs.items()}
        public["hyperliquid"] = {c: f.result() for c, f in hl_jobs.items()}
        public["binance_klines"] = {t: f.result() for t, f in kl_jobs.items()}
        public["bittensor"] = chain.result()
        private = {k: res[k] for k in private_urls} | {"deribit_dvol": {c: f.result() for c, f in dvol_jobs.items()}}
    return public, private


if __name__ == "__main__":
    import os
    from datetime import timezone

    tables = json.load(open(os.path.join(os.path.dirname(__file__), "..", "tables.json")))
    t = time.time()
    pub, priv = fetch_all(tables, datetime.now(timezone.utc), daily=True)
    summary = lambda v: "ERROR " + v["error"][:80] if isinstance(v, dict) and "error" in v else len(json.dumps(v, default=str))
    for k, v in {**pub, **priv}.items():
        print(f"{k:18} {summary(v)}")
    print("vast models with offers:", sum(1 for v in pub["vast"].values() if v.get("offers")), "of", len(pub["vast"]))
    print("seconds", round(time.time() - t))
