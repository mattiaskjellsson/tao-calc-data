import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  avgPriceQuantile, buyRows, fillBook, gpuRows, priceCone, soloChance, sortRows, unitsOverHorizon,
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
      zero_share: 0.5, p: { p10: 1, p25: 2, p50: 4, p75: 8, p90: 16, top: 50 }, top3_share: 0.95, sell_pressure: 0.047, tao_in: 2455 },
    { netuid: 11, name: "Healthy", price_tao: 0.02, pool_tao_day: 9, burn_tao: 0.5, immunity_blocks: 5000, n: 200, earners: 150,
      zero_share: 0.25, p: { p10: 1, p25: 2, p50: 4, p75: 8, p90: 16, top: 50 }, top3_share: 0.6, sell_pressure: 0.002, tao_in: 4500,
      slots: 201, max_slots: 256, new_n: 20, new_earners: 2, new_median: 1.5 },
    { netuid: 50, name: "CpuOnly", price_tao: 0.02, pool_tao_day: 9, burn_tao: 0.5, immunity_blocks: 5000, n: 100, earners: 50,
      zero_share: 0.5, p: { p10: 1, p25: 2, p50: 4, p75: 8, p90: 16, top: 50 } },
    { netuid: 36, name: "GpuRental", price_tao: 0.02, pool_tao_day: 9, burn_tao: 0.5, immunity_blocks: 5000, n: 100, earners: 50,
      zero_share: 0.5, p: { p10: 1, p25: 2, p50: 4, p75: 8, p90: 16, top: 50 } },
    { netuid: 82, name: "Staking", price_tao: 0.04, pool_tao_day: 114, burn_tao: 8, immunity_blocks: 65535, n: 66, earners: 64,
      zero_share: 0.03, p: { p10: 1, p25: 1.9, p50: 1.9, p75: 1.9, p90: 2, top: 2 } },
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

test("the Bittensor headline is weighted by the share of slots that earn", () => {
  const big = gpuRows(own, latest(), bench, tables, NOW).find((r) => r.label.includes("Big")) as Row;
  const taoDay = 0.5 * 2; // half the slots earn; p25 of earners is 2 TAO/day
  const cost = (450 / 1000) * 24 * 0.1;
  assert.ok(Math.abs(big.netDay - (taoDay * 230 - cost - (0.5 * 230) / 30)) < 1e-9);
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
  assert.ok(huge && huge.flags.some((f) => f.startsWith("book exhausted: only $") && f.endsWith("of $1,000,000,000/day fillable")));
  assert.ok(finite(rows));
});

test("rent-out range stays ordered when power costs more than renting earns", () => {
  const rows = gpuRows({ ...own, kwh: 3 }, latest(), bench, tables, NOW).filter((r) => r.kind === "rent");
  assert.ok(rows.length > 0);
  for (const r of rows) assert.ok(r.p10 <= r.p50 && r.p50 <= r.p90, `${r.label}: ${r.p10} ${r.p50} ${r.p90}`);
});

test("each row says how likely it is to earn anything", () => {
  const rows = gpuRows(own, latest(), bench, tables, NOW);
  const by = (f: (r: Row) => boolean) => rows.find(f) as Row;
  assert.equal(by((r) => r.kind === "pow").chance, 1);
  assert.equal(by((r) => r.label.includes("Big")).chance, 0.5);
  assert.ok(Math.abs(by((r) => r.label.includes("Solo")).chance - 0.004) < 1e-12);
  assert.equal(by((r) => r.where === "io.net").chance, 0.9);
  assert.equal(by((r) => r.kind === "mrr").chance, 0.05);
});

test("sortRows orders by the chosen column, ties broken by p50", () => {
  const rows = gpuRows(own, latest(), bench, tables, NOW);
  const byChance = sortRows(rows, "chance");
  for (let i = 1; i < byChance.length; i++) {
    const [a, b] = [byChance[i - 1], byChance[i]];
    assert.ok(a.chance > b.chance || (a.chance === b.chance && a.p50 >= b.p50));
  }
  const asc = sortRows(rows, "netDay", false);
  for (let i = 1; i < asc.length; i++) assert.ok(asc[i - 1].netDay <= asc[i].netDay);
});

test("subnets marked skip in the hardware table (not compute) are left out", () => {
  const rows = gpuRows(own, latest(), bench, tables, NOW);
  assert.ok(!rows.some((r) => r.label.startsWith("SN82 ")));
});

test("Bittensor rows warn about wallet concentration and sell pressure", () => {
  const rows = gpuRows(own, latest(), bench, tables, NOW);
  const big = rows.find((r) => r.label.includes("Big")) as Row;
  assert.ok(big.flags.includes("95% of rewards go to 3 wallets"));
  assert.ok(big.flags.includes("miners sell 4.7% of the pool's TAO a day: alpha price likely to fall"));
  const ok = rows.find((r) => r.label.includes("Healthy")) as Row;
  assert.ok(!ok.flags.some((f) => f.includes("wallets") || f.includes("miners sell")));
});

test("Bittensor chance of earning comes from newcomers when there are enough of them", () => {
  const rows = gpuRows(own, latest(), bench, tables, NOW);
  const healthy = rows.find((r) => r.label.includes("Healthy")) as Row;
  assert.equal(healthy.chance, 0.1); // 2 of 20 slots registered in the last 14 days earn
  const cost = (450 / 1000) * 24 * 0.1;
  assert.ok(Math.abs(healthy.netDay - (2 * 0.1 * 230 - cost - (0.5 * 230) / 30)) < 1e-9);
  assert.ok(healthy.where.includes("150/200 seats earn") && healthy.where.includes("55 open"));
  assert.ok(String(healthy.detail.newcomers).startsWith("2 of 20 slots registered in the last 14 days earn"));
});

test("rows say whether they use the GPU; subnets limited to listed cards skip others", () => {
  const rows = gpuRows(own, latest(), bench, tables, NOW);
  assert.equal((rows.find((r) => r.label.includes("CpuOnly")) as Row).usesGpu, false);
  assert.equal((rows.find((r) => r.label.includes("Big")) as Row).usesGpu, null);
  assert.equal((rows.find((r) => r.kind === "pow") as Row).usesGpu, true);
  assert.ok(rows.some((r) => r.label.includes("GpuRental")));
  const small = gpuRows({ ...own, gpu: "rtx3060" }, latest(), bench, tables, NOW);
  assert.ok(!small.some((r) => r.label.includes("GpuRental")));
});

test("priceCone fans out from today's price with no drift", () => {
  const cone = priceCone(100, 0.8, 30);
  assert.equal(cone.length, 31);
  assert.deepEqual(cone[0], { day: 0, p10: 100, p50: 100, p90: 100 });
  const end = cone[30];
  assert.equal(end.p50, 100);
  assert.ok(Math.abs(end.p90 - 100 * Math.exp(1.2815515655 * 0.8 * Math.sqrt(30 / 365))) < 1e-9);
  assert.ok(cone.every((c, i) => i === 0 || (c.p10 < cone[i - 1].p10 && c.p90 > cone[i - 1].p90)));
});

test("rows that are paid in a coin carry its price and volatility for the chart", () => {
  const rows = gpuRows(own, latest(), bench, tables, NOW);
  assert.deepEqual((rows.find((r) => r.kind === "pow") as Row).price, { tag: "RVN", spot: 0.015, sigma: 0.8, kind: "realised" });
  assert.equal((rows.find((r) => r.kind === "tao") as Row).price?.tag, "TAO");
  assert.equal((rows.find((r) => r.kind === "rent") as Row).price, undefined);
});

test("buy rows never price hashrate below what NiceHash pays sellers, and flag huge margins", () => {
  const L = latest();
  L.nicehash.kawpow = { pay: 5.6e-14, book: [[1e-16, 4.8e3], [5.8e-14, 1e9], [6e-14, 3e9]] }; // a stray order far below market
  const nh = buyRows({ ...own, mode: "rent", budget: 10 }, L, tables).find((r) => r.venue === "nicehash") as ReturnType<typeof buyRows>[number];
  const fill = fillBook([[5.6e-14, 4.8e3], [5.8e-14, 1e9], [6e-14, 3e9]], 10 / 78000, 0.03);
  assert.ok(Math.abs(nh.spend - fill.hs * fill.priceBtc * 1.03 * 78000) < 1e-9);
  assert.ok(Math.abs(nh.spend - 10) < 1e-6); // the whole budget fills at a real price
  const cheap = latest();
  cheap.nicehash.kawpow = { pay: 1e-16, book: [[1e-16, 1e12]] };
  const wild = buyRows({ ...own, mode: "rent", budget: 10 }, cheap, tables).find((r) => r.venue === "nicehash");
  assert.ok(wild && wild.marginPct > 1 && wild.flags.some((f) => f.startsWith("margin over +100%")));
});
