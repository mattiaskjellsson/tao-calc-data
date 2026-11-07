"""Turn one hour of raw source data into the small latest.json the site reads. Pure functions, no I/O."""
import json
import math
import re
import statistics
from datetime import datetime, timezone

RAO = 1_000_000_000
BLOCKS_PER_DAY = 7200
MINER_SHARE = 0.41
NEWCOMER_DAYS = 14
UNIT = {"h": 1, "kh": 1e3, "mh": 1e6, "gh": 1e9, "th": 1e12, "ph": 1e15, "eh": 1e18}


def norm(s: str) -> str:
    s = re.sub(r"[^a-z0-9]", "", s.lower())
    for word in ("nvidia", "geforce", "tesla"):
        s = s.replace(word, "")
    return s


def alias_map(tables: dict) -> dict[str, str]:
    return {a: gid for gid, g in tables["gpus"].items() for a in g["aliases"]}


def gpu_id(name: str, aliases: dict[str, str]) -> str | None:
    return aliases.get(norm(name))


def sig(x: float, digits: int = 6) -> float:
    return float(f"{x:.{digits}g}")


def failed(v) -> bool:
    return isinstance(v, dict) and "error" in v


def subnet_stats(mg: dict) -> dict:
    # Same formula as tao brain/earnings.py (subnet_stats + estimate_new_slot), copied so the recorder stands alone.
    price = mg["tao_in"] / mg["alpha_in"] if mg["alpha_in"] else 0.0
    pool = mg["alpha_out_emission"] / RAO * BLOCKS_PER_DAY * MINER_SHARE * price
    # UIDs held by the subnet owner's coldkey are where burned incentive goes, so they don't count.
    regs = mg.get("block_at_registration") or [None] * len(mg["coldkeys"])
    slots = [(ck, i, r) for ck, i, r in zip(mg["coldkeys"], mg["incentives"], regs) if ck != mg["owner_coldkey"]]
    pairs = [(ck, i) for ck, i, _ in slots]
    miners = [i for _, i in pairs]
    total = sum(miners)
    by_wallet: dict[str, float] = {}
    for ck, i in pairs:
        by_wallet[ck] = by_wallet.get(ck, 0.0) + i
    tao_in = mg["tao_in"] / RAO
    values = [i / total * pool if total else 0.0 for i in miners]
    earners = sorted(v for v in values if v > 0)
    # What newcomers get: slots registered in the last 14 days, a measured stand-in for "a new miner here".
    # ponytail: fixed 14-day window; tune per subnet (immunity, tempo) once the archive has history.
    block = mg.get("block")
    newcomer = [v for (_, _, r), v in zip(slots, values) if block and r is not None and block - r < NEWCOMER_DAYS * BLOCKS_PER_DAY]
    new_earning = sorted(v for v in newcomer if v > 0)

    def pick(pct):
        return earners[math.floor(pct / 100 * (len(earners) - 1))] if earners else 0.0

    return {
        "netuid": mg["netuid"], "name": mg.get("name") or "", "price_tao": price, "pool_tao_day": pool,
        "burn_tao": mg["burn"] / RAO, "immunity_blocks": mg["immunity_period"], "n": len(values), "earners": len(earners),
        "zero_share": (len(values) - len(earners)) / len(values) if values else 1.0,
        # Warning signs: a few wallets farming most slots, and miners' daily payout large against the pool's TAO.
        "top3_share": sum(sorted(by_wallet.values(), reverse=True)[:3]) / total if total else 0.0,
        "tao_in": tao_in, "sell_pressure": pool / tao_in if tao_in else 1.0,
        "slots": mg.get("num_uids", len(mg["coldkeys"])), "max_slots": mg.get("max_uids", len(mg["coldkeys"])),
        "new_n": len(newcomer), "new_earners": len(new_earning),
        "new_median": statistics.median(new_earning) if new_earning else 0.0,
        "p": {**{f"p{q}": pick(q) for q in (10, 25, 50, 75, 90)}, "top": earners[-1] if earners else 0.0},
    }


def atm_iv(marks: list, spot: dict[str, float], now_ms: int) -> dict[str, float]:
    by_und: dict[str, list] = {}
    for m in marks:
        und, exp, strike, cp = m["symbol"].split("-")
        expiry = datetime.strptime(exp, "%y%m%d").replace(hour=8, tzinfo=timezone.utc).timestamp() * 1000
        by_und.setdefault(und, []).append(((expiry - now_ms) / 86_400_000, float(strike), cp, float(m["markIV"])))
    out = {}
    for und, rows in by_und.items():
        if und not in spot or not spot[und]:
            continue
        days = min({r[0] for r in rows if r[0] > 0}, key=lambda d: abs(d - 30), default=None)
        if days is None:
            continue
        at_exp = [r for r in rows if r[0] == days]
        strike = min({r[1] for r in at_exp}, key=lambda k: abs(k - spot[und]))
        ivs = [r[3] for r in at_exp if r[1] == strike and r[3] > 0]
        if ivs:
            out[und] = sum(ivs) / len(ivs)
    return out


def realised_vol(closes: list[float]) -> float:
    rets = [math.log(b / a) for a, b in zip(closes, closes[1:]) if a > 0 and b > 0]
    return statistics.pstdev(rets) * math.sqrt(365) if len(rets) > 1 else 0.0


def _prices(raw: dict) -> dict[str, float]:
    """BTC and TAO in USD: what every row is paid in. Binance first, CoinGecko as the fallback."""
    usd = {}
    if not failed(raw.get("binance_24h")):
        for t in raw.get("binance_24h") or []:
            if t["symbol"] in ("BTCUSDT", "TAOUSDT") and float(t.get("lastPrice") or 0) > 0:
                usd[t["symbol"][:-4]] = float(t["lastPrice"])
    cg = raw.get("coingecko")
    if cg and not failed(cg):
        usd.setdefault("BTC", cg.get("bitcoin", {}).get("usd"))
        usd.setdefault("TAO", cg.get("bittensor", {}).get("usd"))
    return {k: v for k, v in usd.items() if v}


class _Acc:
    def __init__(self):
        self.data: dict[str, dict[str, dict]] = {}
        self.unmatched: dict[str, list] = {}

    def add(self, aliases, market, name, price, rented=None, total=None, low=None, n=1):
        gid = gpu_id(name, aliases)
        if gid is None:
            lst = self.unmatched.setdefault(market, [])
            if name not in lst and len(lst) < 20:
                lst.append(name)
            return
        if not price or price <= 0:
            return
        e = self.data.setdefault(gid, {}).setdefault(market, {"prices": [], "low": math.inf, "rented": 0.0, "total": 0.0, "n": 0})
        e["prices"].append(price)
        e["low"] = min(e["low"], low if low else price)
        e["n"] += n
        if rented is not None and total:
            e["rented"] += rented
            e["total"] += total

    def out(self) -> dict:
        return {gid: {m: {"min": sig(e["low"], 4), "med": sig(statistics.median(e["prices"]), 4), "n": e["n"],
                          "util": sig(e["rented"] / e["total"], 3) if e["total"] else None}
                      for m, e in markets.items()} for gid, markets in self.data.items()}


# Each parser yields (name, $/GPU-hour, extra) per listing; a parser that raises fails only its own market.
def _vast(src, tables, aliases):
    for gid, res in src.items():
        if failed(res):
            continue
        # ponytail: keyless Vast returns the 64 cheapest offers per model, so "med" is the median of those, biased low.
        for o in res.get("offers", []):
            yield tables["gpus"][gid]["vast"], o["dph_total"] / max(1, o.get("num_gpus") or 1), {}


def _clore(src, tables, aliases):
    for s in src.get("servers", []):
        m = re.match(r"(\d+)x (.*)", (s.get("specs") or {}).get("gpu", ""))
        price = ((s.get("price") or {}).get("usd") or {}).get("on_demand_usd")
        if m and price and int(m.group(1)) > 0:  # Clore prices are per server per day
            yield m.group(2), price / 24 / int(m.group(1)), {"rented": float(bool(s.get("rented"))), "total": 1.0}


def _lium(src, tables, aliases):
    for n in src.get("nodes", []):
        # Lium's public list shows only free nodes, so it carries no utilisation signal.
        yield n["gpu_model"], n.get("price_per_gpu_hour"), {}


def _runpod(src, tables, aliases):
    for g in (src.get("data") or {}).get("gpuTypes", []):
        yield g["id"], (g.get("lowestPrice") or {}).get("uninterruptablePrice"), {}


def _akash(src, tables, aliases):
    for m in src.get("models", []):
        ram = re.sub(r"\D", "", m.get("ram", ""))
        name = next((k for k in (m["model"] + ram + m.get("interface", ""), m["model"] + ram, m["model"])
                     if norm(k) in aliases), m["model"] + " " + m.get("ram", ""))
        av, price = m.get("availability") or {}, m.get("price") or {}
        yield name, price.get("med"), {"rented": av.get("total", 0) - av.get("available", 0), "total": av.get("total", 0),
                                       "low": price.get("min"), "n": av.get("total", 1)}


def _ionet(src, tables, aliases):
    for d in src.get("data", []):
        yield d["hardware_name"], d.get("price"), {"rented": d.get("hired", 0), "total": d.get("total", 0),
                                                   "n": d.get("total", 1)}


PARSERS = {"vast": _vast, "clore": _clore, "lium": _lium, "runpod": _runpod, "akash": _akash, "ionet": _ionet}


def _rentals(raw: dict, tables: dict) -> tuple[dict, dict, dict]:
    aliases, acc, bad = alias_map(tables), _Acc(), {}
    for market, parse in PARSERS.items():
        src = raw.get(market)
        if src is None or failed(src):
            continue
        try:
            items = list(parse(src, tables, aliases))
        except Exception as e:
            bad[market] = f"unparseable: {e!r}"[:200]
            continue
        for name, price, extra in items:
            acc.add(aliases, market, name, price, **extra)
    return acc.out(), acc.unmatched, bad


def _nicehash(raw: dict, tables: dict) -> dict:
    stats, algos = raw.get("nicehash_stats"), raw.get("nicehash_algos")
    if not stats or failed(stats) or not algos or failed(algos):
        return {}
    meta = {a["algorithm"]: a for a in algos["miningAlgorithms"]}
    pay = {}
    for s in stats["algos"]:
        name = next((k for k, a in meta.items() if a["order"] == s["a"]), None)
        if name:
            pay[name] = s["p"] * 1e-8  # stats price is in units of 1e-8 BTC per H/s per day
    out = {}
    for aid, a in tables["algos"].items():
        mkt = a.get("nh_mkt")
        if mkt in pay:
            out[aid] = {"pay": sig(pay[mkt])}
    return out


def _mrr(raw: dict, tables: dict) -> dict:
    src = raw.get("mrr_algos")
    if not src or failed(src):
        return {}
    by_name = {a["name"]: a for a in src.get("data", [])}
    out = {}
    for aid, a in tables["algos"].items():
        m = by_name.get(a.get("mrr"))
        if not m:
            continue
        sp = m["suggested_price"]
        factor = UNIT.get(sp["unit"].split("*")[0])
        st = m.get("stats", {})
        avail, rented = int(st.get("available", {}).get("rigs") or 0), int(st.get("rented", {}).get("rigs") or 0)
        if factor and float(sp["amount"]) > 0:
            out[aid] = {"price": sig(float(sp["amount"]) / factor),
                        "rented": sig(rented / (avail + rented), 3) if avail + rented else 0.0}
    return out


def _vol(raw: dict, usd: dict, now: datetime, fallback: float) -> dict:
    iv = {}
    if raw.get("binance_options") and not failed(raw["binance_options"]):
        iv = atm_iv(raw["binance_options"], usd, int(now.timestamp() * 1000))
    klines = raw.get("binance_klines") or {}
    out = {}
    for tag in usd:
        closes = klines.get(tag) if not failed(klines) else None
        if tag in iv:
            out[tag] = {"sigma": sig(iv[tag], 3), "kind": "implied"}
        elif isinstance(closes, list) and len(closes) >= 10 and realised_vol(closes) > 0:
            out[tag] = {"sigma": sig(realised_vol(closes), 3), "kind": "realised"}
        else:
            out[tag] = {"sigma": fallback, "kind": "assumed"}
    return out


def reduce(raw: dict, tables: dict, now: datetime) -> dict:
    usd = _prices(raw)
    rentals, unmatched, bad = _rentals(raw, tables)
    sources = {k: ({"ok": False, "error": str(v["error"])[:200]} if failed(v) else {"ok": True}) for k, v in raw.items()}
    sources |= {k: {"ok": False, "error": e} for k, e in bad.items()}
    bt = raw.get("bittensor")
    subnets = []
    if bt and not failed(bt):
        for mg in bt:
            if "error" not in mg and mg.get("alpha_in"):
                s = subnet_stats(mg)
                if s["p"]["top"] > 0:
                    s["p"] = {k: sig(v) for k, v in s["p"].items()}
                    s.update(top3_share=sig(s["top3_share"], 3), tao_in=sig(s["tao_in"]), sell_pressure=sig(s["sell_pressure"], 3),
                             new_median=sig(s["new_median"]))
                    s.update(price_tao=sig(s["price_tao"]), pool_tao_day=sig(s["pool_tao_day"]),
                             burn_tao=sig(s["burn_tao"]), zero_share=sig(s["zero_share"], 3))
                    subnets.append(s)
    return {
        "ts": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sources": sources,
        "usd": {k: sig(v) for k, v in usd.items()},
        "vol": _vol(raw, usd, now, tables["defaults"]["vol_fallback"]),
        "nicehash": _nicehash(raw, tables),
        "mrr": _mrr(raw, tables),
        "rentals": rentals,
        "subnets": subnets,
        "unmatched": unmatched,
    }


def benchmarks(devices: list, tables: dict, now: datetime) -> dict:
    by_name: dict[str, dict] = {}
    for d in devices:
        if d.get("category") != "GPU":
            continue
        key, lhr = norm(d["name"]), json.loads(d.get("meta") or "{}").get("lhr", False)
        if key not in by_name or (json.loads(by_name[key].get("meta") or "{}").get("lhr", False) and not lhr):
            by_name[key] = d
    gpus = {}
    for gid, g in tables["gpus"].items():
        d = by_name.get(norm(g["nicehash"] or "-"))
        if not d:
            continue
        speeds, powers = json.loads(d.get("speeds") or "{}"), json.loads(d.get("powers") or "{}")
        algos = {}
        for aid, a in tables["algos"].items():
            hs = speeds.get(a.get("nh_dev") or "")
            if hs not in (None, "") and float(hs) > 0:
                algos[aid] = [float(hs), float(powers.get(a["nh_dev"]) or d.get("power") or g["tdp"])]
        if algos:
            gpus[gid] = algos
    return {"ts": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "gpus": gpus}


def alpha_stats(hist: dict, now: datetime) -> dict:
    """Each subnet's alpha price (TAO per alpha) over the last 30 daily blocks: realised volatility and the change."""
    out = {}
    for netuid, taos in hist["tao_in"].items():
        alphas = hist["alpha_in"].get(netuid, [])
        prices = [t / a for t, a in zip(taos, alphas) if t > 0 and a > 0]
        if len(prices) < 3:
            continue
        out[netuid] = {"vol": sig(realised_vol(prices), 3), "change30": sig(prices[-1] / prices[0] - 1, 3)}
    return {"ts": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "subnets": out}
