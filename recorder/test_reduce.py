import json
import math
import os
from datetime import datetime, timezone

from reduce import alias_map, atm_iv, benchmarks, gpu_id, realised_vol, reduce, subnet_stats

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


def raw_min(**over):
    raw = {"binance_24h": [{"symbol": "BTCUSDT", "lastPrice": "78000"}, {"symbol": "TAOUSDT", "lastPrice": "230"}]}
    raw.update(over)
    return raw


def test_reduce_marks_failed_source():
    out = reduce(raw_min(clore={"error": "HTTP Error 403: 1010"}), TABLES, NOW)
    assert out["sources"]["clore"]["ok"] is False
    assert all("clore" not in markets for markets in out["rentals"].values())
    assert out["sources"]["binance_24h"]["ok"] is True


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


def test_only_cleared_sources_go_to_the_public_archive():
    from main import split_snapshot

    public, held = split_snapshot({"binance_24h": [1], "bittensor": [2], "clore": {"x": 1}}, ["binance_24h", "bittensor"])
    assert public == {"binance_24h": [1], "bittensor": [2]}
    assert held == {"clore": {"x": 1}}
    assert "clore" not in TABLES["publish_raw"]  # terms don't allow it
    assert {"binance_24h", "bittensor", "nicehash_stats", "hyperliquid"} <= set(TABLES["publish_raw"])


def test_subnet_stats_flags_wallet_concentration_and_sell_pressure():
    m = mg(["OWN", "a", "a", "b", "c", "d", "e"], [9.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.0])
    s = subnet_stats(m)
    assert math.isclose(s["top3_share"], 0.8)  # a holds 2 of 5 earning units, b and c one each
    assert math.isclose(s["tao_in"], 2.0)
    assert math.isclose(s["sell_pressure"], s["pool_tao_day"] / 2.0)  # miners' daily payout vs the pool's TAO reserve


def test_subnet_stats_newcomers_and_seats():
    m = mg(["OWN", "a", "b", "c", "d", "e", "f"], [9.0, 1.0, 1.0, 1.0, 0.0, 0.0, 2.0])
    m.update(block=200_000, num_uids=7, max_uids=10,
             block_at_registration=[0, 0, 0, 200_000 - 7200, 200_000 - 7200, 200_000 - 3600, 200_000 - 10 * 7200])
    s = subnet_stats(m)
    assert (s["slots"], s["max_slots"]) == (7, 10)
    # newcomers = non-owner slots registered within 14 days: c, d, e, f; c and f earn
    assert (s["new_n"], s["new_earners"]) == (4, 2)
    pool = s["pool_tao_day"]
    assert math.isclose(s["new_median"], (1 / 5 * pool + 2 / 5 * pool) / 2)


def test_reduce_publishes_no_coin_data():
    raw = {"binance_24h": [{"symbol": "BTCUSDT", "lastPrice": "78000"}, {"symbol": "TAOUSDT", "lastPrice": "230"},
                           {"symbol": "RVNUSDT", "lastPrice": "0.0157"}]}
    out = reduce(raw, TABLES, NOW)
    assert "coins" not in out
    assert out["usd"] == {"BTC": 78000, "TAO": 230}  # only what the rows are paid in


def test_nicehash_keeps_only_the_paying_price():
    raw = {"nicehash_stats": {"algos": [{"a": 1, "p": 5.6}]}, "nicehash_algos": {"miningAlgorithms": [{"algorithm": "KAWPOW", "order": 1}]}}
    assert reduce(raw, TABLES, NOW)["nicehash"] == {"kawpow": {"pay": 5.6e-8}}


def test_alpha_stats_from_daily_pool_history():
    from reduce import alpha_stats

    hist = {"blocks": [1, 2, 3, 4, 5], "tao_in": {"5": [100, 110, 100, 110, 110], "9": [0, 0, 0, 1, 1]},
            "alpha_in": {"5": [1000, 1000, 1000, 1000, 1000], "9": [10, 10, 10, 10, 10]}}
    out = alpha_stats(hist, NOW)
    s5 = out["subnets"]["5"]
    rets = [math.log(1.1), -math.log(1.1), math.log(1.1), 0.0]
    mean = sum(rets) / 4
    assert math.isclose(s5["vol"], math.sqrt(sum((r - mean) ** 2 for r in rets) / 4 * 365), rel_tol=1e-3)  # 3 digits
    assert math.isclose(s5["change30"], 0.1)
    assert "9" not in out["subnets"]  # too few non-zero days to say anything
