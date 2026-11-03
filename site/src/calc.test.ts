import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  avgPriceQuantile, buyRows, fillBook, gpuRows, soloChance, unitsOverHorizon,
  type Bench, type Inputs, type Latest, type Row, type Tables,
} from "./calc.js";

const tables: Tables = JSON.parse(readFileSync(new URL("./tables.json", import.meta.url), "utf8"));
const NOW = new Date("2026-11-03T10:00:00Z");

const latest = (): Latest => ({
  ts: "2026-11-03T10:00:00Z",
  sources: {},
  usd: { BTC: 78000, RVN: 0.015, TAO: 230 },
  vol: { BTC: { sigma: 0.36, kind: "implied" }, RVN: { sigma: 0.8, kind: "realised" }, TAO: { sigma: 0.65, kind: "realised" } },
  coins: [
    { name: "Ravencoin", tag: "RVN", algo: "kawpow", block_time: 60, block_reward: 2500, nethash: 5e12, growth_day: 0, list: "gpu" },
    { name: "Dead", tag: "RVN", algo: "kawpow", block_time: 60, block_reward: 2500, nethash: 0, growth_day: 0, list: "gpu" },
    { name: "NoPrice", tag: "NOP", algo: "kawpow", block_time: 60, block_reward: 2500, nethash: 5e12, growth_day: 0, list: "gpu" },
  ],
  nicehash: { kawpow: { pay: 5.6e-14, book: [[5e-14, 1e9], [6e-14, 3e9]] } },
  mrr: { kawpow: { price: 1.7e-13, rented: 0.05 } },
  rentals: {
    rtx4090: { ionet: { min: 0.25, med: 0.25, n: 600, util: 0.9 }, vast: { min: 0.14, med: 0.3, n: 64, util: null } },
    h100sxm: { ionet: { min: 1.19, med: 1.19, n: 898, util: 1 } },
  },
  subnets: [
    { netuid: 9, name: "Big", price_tao: 0.02, pool_tao_day: 900, burn_tao: 0.5, immunity_blocks: 5000, n: 200, earners: 100,
      zero_share: 0.5, p: { p10: 1, p25: 2, p50: 4, p75: 8, p90: 16, top: 50 } },
    { netuid: 7, name: "Solo", price_tao: 0.01, pool_tao_day: 70, burn_tao: 0.1, immunity_blocks: 5000, n: 254, earners: 1,
      zero_share: 0.996, p: { p10: 70, p25: 70, p50: 70, p75: 70, p90: 70, top: 70 } },
  ],
  unmatched: {},
});
const bench: Bench = { ts: "", gpus: { rtx4090: { kawpow: [65e6, 325] } } };
const own: Inputs = { mode: "own", gpu: "rtx4090", kwh: 0.1, horizon: 30, rankPct: 25, util: null, poolFee: 0.01, budget: 10 };

const finite = (rows: object[]) => rows.every((r) => Object.values(r).every((v) => typeof v !== "number" || Number.isFinite(v)));

test("avgPriceQuantile is centred on spot with no drift", () => {
  assert.equal(avgPriceQuantile(100, 0.8, 30, 0), 100);
  assert.ok(avgPriceQuantile(100, 0.8, 30, 1.28) > 100 && avgPriceQuantile(100, 0.8, 30, -1.28) < 100);
});

test("unitsOverHorizon sums days and applies emission changes", () => {
  assert.equal(unitsOverHorizon(10, 0, 30, () => 1), 300);
  assert.equal(unitsOverHorizon(10, 0, 30, (t) => (t >= 10 ? 0.5 : 1)), 200);
});

test("soloChance", () => assert.ok(Math.abs(soloChance(1) - 0.6321) < 1e-4));

test("fillBook walks the book and caps at its depth", () => {
  const book: [number, number][] = [[1e-14, 1e6], [2e-14, 3e6]];
  assert.deepEqual(fillBook(book, 1e-9, 0), { hs: 1e5, priceBtc: 1e-14, exhausted: false });
  assert.deepEqual(fillBook(book, 4e-8, 0), { hs: 2e6, priceBtc: 2e-14, exhausted: false });
  assert.deepEqual(fillBook(book, 1, 0), { hs: 3e6, priceBtc: 2e-14, exhausted: true });
});

test("PoW row matches the spec formula and skips bad coins", () => {
  const rows = gpuRows(own, latest(), bench, tables, NOW);
  const pow = rows.filter((r) => r.kind === "pow");
  assert.deepEqual(pow.map((r) => r.label), ["Ravencoin"]);
  const perDay = (65e6 / 5e12) * (86400 / 60) * 2500 * 0.99;
  const net = perDay * 0.015 - (325 / 1000) * 24 * 0.1;
  assert.ok(Math.abs(pow[0].netDay - net) < 1e-9);
  assert.ok(Math.abs(pow[0].p50 - net * 30) < 1e-9);
  assert.ok(pow[0].p10 < pow[0].p50 && pow[0].p50 < pow[0].p90);
  assert.ok(finite(rows));
});

test("rows are ranked by p50", () => {
  const rows = gpuRows(own, latest(), bench, tables, NOW);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].p50 >= rows[i].p50);
});

test("a GPU with no benchmark still gets Bittensor and rent-out rows", () => {
  const rows = gpuRows({ ...own, gpu: "h100sxm" }, latest(), bench, tables, NOW);
  assert.equal(rows.filter((r) => r.kind === "pow" || r.kind === "nicehash").length, 0);
  assert.ok(rows.some((r) => r.kind === "tao") && rows.some((r) => r.kind === "rent"));
  assert.ok(finite(rows));
});

test("rent-out band clamps utilisation at 100%", () => {
  const r = gpuRows(own, latest(), bench, tables, NOW).find((r) => r.kind === "rent" && r.where === "io.net") as Row;
  const fee = tables.fees.ionet.fee, idle = 450 * tables.defaults.idle_frac;
  const at = (u: number) => (0.25 * 24 * u * (1 - fee) - ((450 * u + idle * (1 - u)) / 1000) * 24 * 0.1) * 30;
  assert.ok(Math.abs(r.p50 - at(0.9)) < 1e-9 && Math.abs(r.p90 - at(1)) < 1e-9 && Math.abs(r.p10 - at(0.7)) < 1e-9);
});

test("winner-take-all subnets earn 0 for a new slot and say so", () => {
  const rows = gpuRows(own, latest(), bench, tables, NOW).filter((r) => r.kind === "tao");
  const solo = rows.find((r) => r.label.includes("Solo")) as Row;
  assert.ok(solo.netDay < 0 && solo.flags.some((f) => f.includes("winner-take-all")));
  const big = rows.find((r) => r.label.includes("Big")) as Row;
  assert.ok(big.flags.some((f) => f.includes("50% of slots earn 0")));
});

test("renting mode uses the cheapest market and adds $/TFLOP-hour", () => {
  const rows = gpuRows({ ...own, mode: "rent" }, latest(), bench, tables, NOW);
  const pow = rows.find((r) => r.kind === "pow") as Row;
  assert.equal(pow.where, "rented on Vast at $0.14/h");
  assert.ok(pow.flags.some((f) => f.includes("restricted")));
  assert.ok("net $/TFLOP-hour" in pow.detail);
  assert.ok(!rows.some((r) => r.kind === "rent" || r.kind === "nicehash"));
});

test("buy rows: margin from the book, capped when exhausted", () => {
  const rows = buyRows({ ...own, mode: "rent", budget: 10 }, latest(), tables);
  const nh = rows.find((r) => r.venue === "nicehash") as ReturnType<typeof buyRows>[number];
  assert.equal(nh.coin, "Ravencoin");
  const huge = buyRows({ ...own, mode: "rent", budget: 1e9 }, latest(), tables).find((r) => r.venue === "nicehash");
  assert.ok(huge && huge.flags.includes("book exhausted"));
  assert.ok(finite(rows));
});
