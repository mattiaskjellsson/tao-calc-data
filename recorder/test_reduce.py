import json
import math
import os
from datetime import datetime, timezone

from reduce import alias_map, atm_iv, benchmarks, gpu_id, nicehash_book, realised_vol, reduce, subnet_stats

TABLES = json.load(open(os.path.join(os.path.dirname(__file__), "..", "tables.json")))
NOW = datetime(2026, 11, 3, 10, 7, tzinfo=timezone.utc)


def test_norm_and_alias():
    aliases = alias_map(TABLES)
    for name in ["NVIDIA GeForce RTX 4090", "RTX 4090", "GeForce RTX 4090", "rtx4090"]:
        assert gpu_id(name, aliases) == "rtx4090"
    assert gpu_id("Mixed GPUs", aliases) is None


def mg(coldkeys, incentives):
    return {"netuid": 7, "name": "x", "tao_in": 2e9, "alpha_in": 4e9, "alpha_out_emission": 1e9, "burn": 5e8,
            "immunity_period": 5000, "owner_coldkey": "OWN", "coldkeys": coldkeys, "incentives": incentives,
            "hotkeys": [f"h{i}" for i in range(len(coldkeys))]}


def test_subnet_stats_excludes_owner_and_zero():
    s = subnet_stats(mg(["OWN", "a", "b", "c", "d"], [100.0, 1.0, 3.0, 0.0, 0.0]))
    pool = 1.0 * 7200 * 0.41 * 0.5
    assert s["n"] == 4 and s["earners"] == 2
    assert s["zero_share"] == 0.5
    assert math.isclose(s["p"]["top"], pool * 0.75)
    assert math.isclose(s["p"]["p10"], pool * 0.25)  # percentiles over the two earners only
    assert math.isclose(s["burn_tao"], 0.5) and math.isclose(s["price_tao"], 0.5)


def test_atm_iv_picks_30d_atm():
    now_ms = int(datetime(2026, 11, 3, tzinfo=timezone.utc).timestamp() * 1000)
    marks = []
    for exp, iv in [("261110", 0.9), ("261201", 0.5), ("270201", 0.7)]:  # 7, 28 and 90 days out
        for k in (90, 100, 110):
            for cp, bump in (("C", 0.0), ("P", 0.02)):
                marks.append({"symbol": f"BTC-{exp}-{k}-{cp}", "markIV": str(iv + bump + (0 if k == 100 else 0.3))})
    assert math.isclose(atm_iv(marks, {"BTC": 100.0}, now_ms)["BTC"], 0.51)


def test_realised_vol():
    closes = [100.0, 110.0] * 15 + [100.0]
    assert math.isclose(realised_vol(closes), math.log(1.1) * math.sqrt(365), rel_tol=1e-6)


def test_nicehash_book_drops_dead_orders():
    orders = [{"price": "0.06", "acceptedSpeed": "0.02", "alive": True},
              {"price": "0.05", "acceptedSpeed": "0", "alive": True},
              {"price": "0.055", "acceptedSpeed": "0.01", "alive": True}]
    book = nicehash_book(orders, 1e12, 1e12)
    assert [round(p * 1e12, 4) for p, _ in book] == [0.055, 0.06]
    assert [round(c / 1e12, 4) for _, c in book] == [0.01, 0.03]


def wtm(name, **kw):
    coin = {"tag": "RVN", "algorithm": "KawPow", "block_time": "60.0", "block_reward": 2500.0, "nethash": 5e12,
            "difficulty": 100.0, "difficulty24": 100.0, "exchange_rate": 2e-7}
    coin.update(kw)
    return name, coin


def raw_min(**over):
    raw = {"binance_24h": [{"symbol": "BTCUSDT", "lastPrice": "78000"}, {"symbol": "TAOUSDT", "lastPrice": "230"}],
           "wtm_gpu": {"coins": dict([wtm("Ravencoin"), wtm("Dead", tag="DEAD", nethash=0),
                                      wtm("NoPrice", tag="NOP", exchange_rate=0)])},
           "wtm_asic": {"coins": {}}}
    raw.update(over)
    return raw


def test_reduce_skips_bad_coins():
    out = reduce(raw_min(), TABLES, NOW)
    assert [c["name"] for c in out["coins"]] == ["Ravencoin"]
    assert math.isclose(out["usd"]["RVN"], 2e-7 * 78000)


def test_reduce_marks_failed_source():
    out = reduce(raw_min(clore={"error": "HTTP Error 403: 1010"}), TABLES, NOW)
    assert out["sources"]["clore"]["ok"] is False
    assert all("clore" not in markets for markets in out["rentals"].values())
    assert out["sources"]["wtm_gpu"]["ok"] is True


def test_reduce_rentals_and_util():
    clore = {"servers": [  # Clore prices are per server per day
        {"specs": {"gpu": "2x NVIDIA GeForce RTX 4090"}, "price": {"usd": {"on_demand_usd": 24.0}}, "rented": True},
        {"specs": {"gpu": "1x NVIDIA GeForce RTX 4090"}, "price": {"usd": {"on_demand_usd": 9.6}}, "rented": False},
        {"specs": {"gpu": "1x Mixed GPUs"}, "price": {"usd": {"on_demand_usd": 9.0}}, "rented": False}]}
    ionet = {"data": [{"hardware_name": "GeForce RTX 4090", "price": 0.25, "total": 10, "hired": 4}]}
    lium = {"nodes": [{"gpu_model": "RTX 4090", "gpu_count": 2, "available_gpu_count": 2, "price_per_gpu_hour": 0.4}]}
    out = reduce(raw_min(clore=clore, ionet=ionet, lium=lium), TABLES, NOW)
    c = out["rentals"]["rtx4090"]["clore"]
    assert c["min"] == 0.4 and c["med"] == 0.45 and c["n"] == 2 and c["util"] == 0.5
    assert out["rentals"]["rtx4090"]["ionet"]["util"] == 0.4
    assert out["rentals"]["rtx4090"]["lium"]["util"] is None  # Lium lists only free nodes, so no utilisation signal
    assert "Mixed GPUs" in out["unmatched"]["clore"]


def test_reduce_tolerates_null_fields():
    akash = {"models": [{"model": "rtx4090", "ram": "24Gi", "interface": "PCIe", "price": None, "availability": None},
                        {"model": "rtx4090", "ram": "24Gi", "interface": "PCIe", "price": {"min": 0.3, "med": 0.4},
                         "availability": {"total": 10, "available": 5}}]}
    runpod = {"data": {"gpuTypes": [{"id": "NVIDIA GeForce RTX 4090", "lowestPrice": None}]}}
    out = reduce(raw_min(akash=akash, runpod=runpod), TABLES, NOW)
    assert out["rentals"]["rtx4090"]["akash"] == {"min": 0.3, "med": 0.4, "n": 10, "util": 0.5}
    assert "runpod" not in out["rentals"]["rtx4090"]


def test_benchmarks_prefers_non_lhr():
    devices = [
        {"name": "NVIDIA RTX 3060", "category": "GPU", "power": 170, "meta": json.dumps({"lhr": True}),
         "speeds": json.dumps({"KAWPOW": 10e6}), "powers": "{}"},
        {"name": "NVIDIA RTX 3060", "category": "GPU", "power": 170, "meta": json.dumps({"lhr": False}),
         "speeds": json.dumps({"KAWPOW": 24e6, "ETCHASH": ""}), "powers": json.dumps({"KAWPOW": 120})}]
    b = benchmarks(devices, TABLES, NOW)
    assert b["gpus"]["rtx3060"] == {"kawpow": [24e6, 120]}


def test_asset_names():
    from main import asset_name

    assert asset_name(datetime(2026, 11, 3, 10, 7, tzinfo=timezone.utc)) == ("data-2026-11", "2026-11-03T10Z.json.gz")


def test_junk_records_fail_only_their_market():
    clore = {"servers": [{"specs": {"gpu": "0x NVIDIA GeForce RTX 4090"}, "price": {"usd": {"on_demand_usd": 9.6}}},
                         {"specs": {"gpu": "1x NVIDIA GeForce RTX 4090"}, "price": {"usd": {"on_demand_usd": 9.6}}}]}
    lium = {"nodes": [{"price_per_gpu_hour": 0.4}]}  # no gpu_model
    ionet = {"data": [{"hardware_name": "GeForce RTX 4090", "price": 0.25, "total": 10, "hired": 4}]}
    out = reduce(raw_min(clore=clore, lium=lium, ionet=ionet), TABLES, NOW)
    assert out["rentals"]["rtx4090"]["clore"]["n"] == 1
    assert out["sources"]["lium"]["ok"] is False
    assert out["rentals"]["rtx4090"]["ionet"]["min"] == 0.25


def test_nicehash_book_zero_factor():
    assert nicehash_book([{"price": "0.06", "acceptedSpeed": "0.02"}], 0, 1e12) == []


def test_binance_price_used_only_when_it_agrees_with_whattomine():
    raw = raw_min(binance_24h=[{"symbol": "BTCUSDT", "lastPrice": "78000"}, {"symbol": "RVNUSDT", "lastPrice": "0.0157"},
                               {"symbol": "XMRUSDT", "lastPrice": "118"}],
                  binance_klines={"RVN": [1.0, 1.1] * 10, "XMR": [1.0, 1.1] * 10})
    raw["wtm_gpu"]["coins"]["Monero"] = {**wtm("Monero")[1], "tag": "XMR", "algorithm": "RandomX", "exchange_rate": 0.0078}
    raw["wtm_gpu"]["coins"]["Bitcoin"] = {**wtm("Bitcoin")[1], "tag": "BTC", "algorithm": "SHA-256", "exchange_rate": 78100,
                                          "exchange_rate_curr": "BTC"}  # WhatToMine labels it BTC; the value is USD
    out = reduce(raw, TABLES, NOW)
    assert out["usd"]["RVN"] == 0.0157  # within 10% of WhatToMine's 0.0156: Binance's fresher price
    assert math.isclose(out["usd"]["XMR"], 0.0078 * 78000)  # a frozen delisted ticker is ignored
    assert out["vol"]["RVN"]["kind"] == "realised" and out["vol"]["XMR"]["kind"] == "assumed"
    assert out["usd"]["BTC"] == 78000
