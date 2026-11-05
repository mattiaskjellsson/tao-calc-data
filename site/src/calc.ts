// All the calculator's math. Pure: data in, rows out. See docs/superpowers/specs/2026-10-31-gpu-calculator-design.md, "The math".

export type Gpu = { name: string; vram: number; fp32: number; tdp: number; nicehash: string | null; vast: string | null; aliases: string[] };
export type Tables = {
  gpus: Record<string, Gpu>;
  algos: Record<string, { wtm: string[]; nh_dev: string | null; nh_mkt: string | null; mrr: string | null }>;
  fees: Record<string, { fee: number; confirmed: boolean; src: string | null; note: string }>;
  terms: Record<string, "allowed" | "restricted" | "banned" | "unknown">;
  terms_note: Record<string, string>;
  halvings: Record<string, [string, number][] | { decay_per_year: number } | boolean>;
  subnet_hw: Record<string, { gpu: boolean; vram?: number; gpus?: string[]; note?: string; skip?: boolean } | boolean>;
  defaults: { pool_fee: number; util: number; util_band: number; rank_pct: number; buy_fee_nicehash: number; budget: number;
    vol_fallback: number; growth_cap_day: number; idle_frac: number; kwh: number };
};
export type Coin = { name: string; tag: string; algo: string; block_time: number; block_reward: number; nethash: number; growth_day: number; list: string };
export type Subnet = { netuid: number; name: string; price_tao: number; pool_tao_day: number; burn_tao: number; immunity_blocks: number;
  n: number; earners: number; zero_share: number; p: { p10: number; p25: number; p50: number; p75: number; p90: number; top: number };
  top3_share?: number; sell_pressure?: number; tao_in?: number;
  slots?: number; max_slots?: number; new_n?: number; new_earners?: number; new_median?: number };
export type Market = { min: number; med: number; n: number; util: number | null };
export type Latest = {
  ts: string;
  sources: Record<string, { ok: boolean; error?: string }>;
  usd: Record<string, number>;
  vol: Record<string, { sigma: number; kind: "implied" | "realised" | "assumed" }>;
  coins: Coin[];
  nicehash: Record<string, { pay: number; book: [number, number][] }>;
  mrr: Record<string, { price: number; rented: number }>;
  rentals: Record<string, Record<string, Market>>;
  subnets: Subnet[];
  unmatched: Record<string, string[]>;
};
export type Bench = { ts: string; gpus: Record<string, Record<string, [number, number]>> };
export type Inputs = { mode: "own" | "rent"; gpu: string; kwh: number; horizon: number; rankPct: number; util: number | null; poolFee: number; budget: number };
export type Row = {
  kind: "pow" | "nicehash" | "mrr" | "tao" | "rent"; label: string; where: string;
  netDay: number; p10: number; p50: number; p90: number;
  chance: number; // how likely the option earns anything: pool mining 1, Bittensor newcomers earning, rent-out utilisation
  usesGpu: boolean | null; // null: a subnet whose hardware needs are unknown
  price?: { tag: string; spot: number; sigma: number; kind: "implied" | "realised" | "assumed" }; // what the earnings are paid in
  breakEvenPrice?: { value: number; pctFromNow: number; unit: string }; breakEvenKwh?: number;
  flags: string[]; detail: Record<string, string | number>;
};
export type BuyRow = { algo: string; venue: "nicehash" | "mrr"; coin: string; marginPct: number; spend: number; revenue: number; flags: string[]; detail: Record<string, string | number> };

export const Z90 = 1.2815515655;
export const MARKET_NAMES: Record<string, string> = { vast: "Vast", clore: "Clore", lium: "Lium", runpod: "RunPod", akash: "Akash", ionet: "io.net" };

// ponytail: geometric-average approximation for the average price over the horizon; Monte Carlo if it's ever off.
export const avgPriceQuantile = (S: number, sigmaYr: number, days: number, z: number) => S * Math.exp(z * sigmaYr * Math.sqrt(days / 365 / 3));

export function unitsOverHorizon(perDay: number, growthDay: number, days: number, emission: (t: number) => number = () => 1): number {
  let sum = 0;
  for (let t = 0; t < days; t++) sum += perDay * Math.exp(-growthDay * t) * emission(t);
  return sum;
}

export const soloChance = (lambda: number) => 1 - Math.exp(-lambda);

/** Where the price could be on each day of the horizon: lognormal, no drift, p10/p50/p90. */
export function priceCone(S: number, sigmaYr: number, days: number) {
  return Array.from({ length: days + 1 }, (_, day) => {
    const w = Z90 * sigmaYr * Math.sqrt(day / 365);
    return { day, p10: S * Math.exp(-w), p50: S, p90: S * Math.exp(w) };
  });
}

/** Largest H/s a buyer gets for budgetBtcDay: to take hs you must outbid every order below cum_hs ≥ hs. */
export function fillBook(book: [number, number][], budgetBtcDay: number, fee: number) {
  let best = { hs: 0, priceBtc: 0, exhausted: false };
  let prev = 0;
  for (const [price, cum] of book) {
    const affordable = budgetBtcDay / (price * (1 + fee));
    const hs = Math.min(cum, affordable);
    if (hs > prev && hs > best.hs) best = { hs, priceBtc: price, exhausted: affordable > cum && cum === book[book.length - 1][1] };
    prev = cum;
  }
  return best;
}

function emissionFor(tag: string, tables: Tables, now: Date): (t: number) => number {
  const h = tables.halvings[tag];
  if (!h || typeof h === "boolean") return () => 1;
  if (!Array.isArray(h)) return (t) => Math.pow(h.decay_per_year, t / 365);
  const steps = h.map(([date, f]) => [(Date.parse(date) - now.getTime()) / 86_400_000, f] as const);
  return (t) => steps.reduce((acc, [day, f]) => (t >= day ? acc * f : acc), 1);
}

function interpRank(p: Subnet["p"], pct: number): number {
  const pts: [number, number][] = [[10, p.p10], [25, p.p25], [50, p.p50], [75, p.p75], [90, p.p90], [100, p.top]];
  if (pct <= 10) return p.p10;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    if (pct <= x1) return y0 + ((y1 - y0) * (pct - x0)) / (x1 - x0);
  }
  return p.top;
}

export function rentCost(gpu: string, latest: Latest, tables: Tables): { usdHour: number; market: string; terms: string } | null {
  let best: { usdHour: number; market: string; terms: string } | null = null;
  for (const [m, q] of Object.entries(latest.rentals[gpu] ?? {})) {
    const terms = tables.terms[m] ?? "unknown";
    if (terms !== "banned" && q.min > 0 && (!best || q.min < best.usdHour)) best = { usdHour: q.min, market: m, terms };
  }
  return best;
}

const money = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 1 ? x.toFixed(2) : x.toPrecision(2));
const pct = (x: number) => `${Math.round(x * 100)}%`;

type Earning = { units: number; tag: string; costDay: number; fixedCost: number; perDayUnits: number };

/** Turn units earned (coins, BTC or TAO) into net $ quantiles over the horizon. */
function settle(inp: Inputs, latest: Latest, tables: Tables, e: Earning) {
  const S = latest.usd[e.tag];
  const vol = latest.vol[e.tag] ?? { sigma: tables.defaults.vol_fallback, kind: "assumed" as const };
  const cost = e.costDay * inp.horizon + e.fixedCost;
  const q = (z: number) => e.units * avgPriceQuantile(S, vol.sigma, inp.horizon, z) - cost;
  const be = e.units > 0 ? cost / e.units : Infinity;
  return {
    netDay: e.perDayUnits * S - e.costDay,
    p10: q(-Z90), p50: q(0), p90: q(Z90),
    breakEvenPrice: Number.isFinite(be) ? { value: be, pctFromNow: be / S - 1, unit: `$/${e.tag}` } : undefined,
    vol,
    price: { tag: e.tag, spot: S, sigma: vol.sigma, kind: vol.kind },
  };
}

export function gpuRows(inp: Inputs, latest: Latest, bench: Bench, tables: Tables, now: Date): Row[] {
  const gpu = tables.gpus[inp.gpu];
  if (!gpu) return [];
  const d = tables.defaults, H = inp.horizon, rows: Row[] = [];
  const rent = inp.mode === "rent" ? rentCost(inp.gpu, latest, tables) : null;
  if (inp.mode === "rent" && !rent) return [];
  const powerCost = (watts: number) => (inp.mode === "own" ? (watts / 1000) * 24 * inp.kwh : (rent as { usdHour: number }).usdHour * 24);
  const where = (own: string) => (rent ? `rented on ${MARKET_NAMES[rent.market]} at $${money(rent.usdHour)}/h` : own);
  const rentFlags = () => (rent && rent.terms !== "allowed" ? [`${MARKET_NAMES[rent.market]}: mining ${rent.terms}${tables.terms_note[rent.market] ? ` (${tables.terms_note[rent.market]})` : ""}`] : []);
  const kwhBreakEven = (revenueH: number, fixed: number, watts: number) =>
    inp.mode === "own" && watts > 0 ? Math.max(0, (revenueH - fixed) / ((watts / 1000) * 24 * H)) : undefined;
  const volFlag = (v: { kind: string }) => (v.kind === "assumed" ? ["price volatility assumed (no market data)"] : []);

  // Proportional: PoW coins.
  for (const [algo, [hs, watts]] of Object.entries(bench.gpus[inp.gpu] ?? {})) {
    for (const c of latest.coins) {
      const S = latest.usd[c.tag];
      if (c.algo !== algo || !(c.nethash > 0 && c.block_time > 0 && c.block_reward > 0 && S > 0)) continue;
      const blocksDay = 86400 / c.block_time, share = hs / c.nethash;
      const perDay = share * blocksDay * c.block_reward * (1 - inp.poolFee);
      const units = unitsOverHorizon(perDay, c.growth_day, H, emissionFor(c.tag, tables, now));
      const s = settle(inp, latest, tables, { units, tag: c.tag, costDay: powerCost(watts), fixedCost: 0, perDayUnits: perDay });
      rows.push({
        kind: "pow", label: c.name, where: where(`mine ${algo} in a pool`), netDay: s.netDay, p10: s.p10, p50: s.p50, p90: s.p90, chance: 1, usesGpu: true, price: s.price,
        breakEvenPrice: s.breakEvenPrice, breakEvenKwh: kwhBreakEven(units * S, 0, watts),
        flags: [...volFlag(s.vol), ...rentFlags()],
        detail: {
          hashrate: `${(hs / 1e6).toPrecision(4)} MH/s at ${watts} W`, "coins/day": perDay.toPrecision(4), price: `$${S.toPrecision(4)}`,
          volatility: `${pct(s.vol.sigma)}/yr (${s.vol.kind})`, "network growth": `${(c.growth_day * 100).toFixed(2)}%/day (24 h trend)`,
          "pool fee": pct(inp.poolFee), "solo instead": `${pct(soloChance(share * blocksDay * H))} chance of ≥1 block in ${H} days`,
          ...(rent ? { "net $/TFLOP-hour": (s.netDay / (gpu.fp32 * 24)).toPrecision(3) } : {}),
        },
      });
    }
    if (inp.mode !== "own") continue;
    // Selling the hashrate instead: NiceHash pays per H/s, MiningRigRentals rents whole rigs.
    const sell: [Row["kind"], string, number, string, number][] = [];
    const nh = latest.nicehash[algo];
    if (nh?.pay > 0) sell.push(["nicehash", "Sell on NiceHash", hs * nh.pay * (1 - tables.fees.nicehash.fee), "fee " + pct(tables.fees.nicehash.fee), 1]);
    const mrr = latest.mrr[algo];
    if (mrr?.price > 0 && mrr.rented > 0)
      sell.push(["mrr", "Rent out on MiningRigRentals", hs * mrr.price * mrr.rented * (1 - tables.fees.mrr.fee), `${pct(mrr.rented)} of rigs rented`, mrr.rented]);
    for (const [kind, label, btcDay, note, chance] of sell) {
      const s = settle(inp, latest, tables, { units: btcDay * H, tag: "BTC", costDay: powerCost(watts), fixedCost: 0, perDayUnits: btcDay });
      if (!(latest.usd.BTC > 0)) continue;
      rows.push({
        kind, label: `${label} (${algo})`, where: "paid in BTC", netDay: s.netDay, p10: s.p10, p50: s.p50, p90: s.p90, chance, usesGpu: true, price: s.price,
        breakEvenPrice: s.breakEvenPrice, breakEvenKwh: kwhBreakEven(btcDay * H * latest.usd.BTC, 0, watts), flags: [],
        detail: { hashrate: `${(hs / 1e6).toPrecision(4)} MH/s at ${watts} W`, "BTC/day": btcDay.toPrecision(4), note },
      });
    }
  }

  // Competitive: Bittensor subnets, at the visitor's rank among earners.
  const TAO = latest.usd.TAO;
  for (const sn of TAO > 0 ? latest.subnets : []) {
    const hw = tables.subnet_hw[String(sn.netuid)];
    const known = hw && typeof hw !== "boolean" ? hw : null;
    if (known && (known.skip || (known.gpu && known.vram && gpu.vram < known.vram) || (known.gpus && !known.gpus.includes(inp.gpu)))) continue;
    // Like tao's scan (its "tenth" earner): with fewer than 10 earners a new slot is assumed to earn nothing.
    const winnerTakeAll = sn.earners < 10;
    const atRank = winnerTakeAll ? 0 : interpRank(sn.p, inp.rankPct);
    // Chance of earning: what newcomers (registered in the last 14 days) actually get, when there are enough of them;
    // otherwise the share of all slots earning. Weighting the rank by it keeps a 95%-zero subnet from looking safe.
    const newcomers = (sn.new_n ?? 0) >= 5;
    const chance = newcomers ? (sn.new_earners as number) / (sn.new_n as number) : 1 - sn.zero_share;
    const taoDay = atRank * chance;
    const burnUsd = sn.burn_tao * TAO, watts = gpu.tdp;
    const s = settle(inp, latest, tables, { units: taoDay * H, tag: "TAO", costDay: powerCost(watts), fixedCost: burnUsd, perDayUnits: taoDay });
    const flags = [`${pct(sn.zero_share)} of slots earn 0`];
    // ponytail: fixed thresholds (3 wallets >75% of rewards on a subnet with 10+ earners; payout >1% of the pool's TAO a day);
    // tune with archive history. Below 10 earners the winner-take-all flag already says it.
    if (sn.earners >= 10 && (sn.top3_share ?? 0) > 0.75) flags.push(`${pct(sn.top3_share as number)} of rewards go to 3 wallets`);
    if ((sn.sell_pressure ?? 0) > 0.01)
      flags.push(`miners sell ${((sn.sell_pressure as number) * 100).toFixed(1)}% of the pool's TAO a day: alpha price likely to fall`);
    if (winnerTakeAll) flags.unshift(`winner-take-all: ${sn.earners} of ${sn.n} slots earn`);
    if (!known) flags.push("hardware needs unknown");
    else if (!known.gpu) flags.push("doesn't use a GPU (CPU or paid AI API)");
    flags.push(`registration (${sn.burn_tao.toPrecision(3)} TAO) lost if pruned after immunity`);
    rows.push({
      kind: "tao", label: `SN${sn.netuid} ${sn.name}`.trim(), chance, usesGpu: known ? known.gpu : null, price: s.price,
      where: [where("run a miner on this card"), `${sn.earners}/${sn.n} seats earn`,
        ...(sn.max_slots && sn.slots != null ? [`${Math.max(0, sn.max_slots - sn.slots)} open`] : [])].join(" · "),
      netDay: s.netDay - burnUsd / H, p10: s.p10, p50: s.p50, p90: s.p90,
      breakEvenPrice: s.breakEvenPrice, breakEvenKwh: kwhBreakEven(taoDay * H * TAO, burnUsd, watts), flags,
      detail: {
        "at your rank": `p${inp.rankPct} of earners: ${atRank.toPrecision(3)} TAO/day ($${money(atRank * TAO)}/day) if you earn`,
        "chance of earning": `${pct(chance)} (${newcomers ? "newcomers earning" : "share of slots earning now"}); headline = rank × chance`,
        ...(sn.new_n != null ? { newcomers: `${sn.new_earners} of ${sn.new_n} slots registered in the last 14 days earn` +
          ((sn.new_earners ?? 0) > 0 ? `; median earner ${(sn.new_median ?? 0).toPrecision(3)} TAO/day ($${money((sn.new_median ?? 0) * TAO)})` : "") } : {}),
        ...(sn.max_slots != null ? { seats: `${sn.slots} of ${sn.max_slots} filled; a full subnet prunes the weakest slot to admit you` } : {}),
        "rank spread": `ranked 10th–90th percentile among earners: $${money(sn.p.p10 * TAO)}–$${money(sn.p.p90 * TAO)}/day (top $${money(sn.p.top * TAO)})`,
        earners: `${sn.earners} of ${sn.n} slots`, registration: `${sn.burn_tao.toPrecision(3)} TAO ($${money(burnUsd)})`,
        immunity: `${sn.immunity_blocks} blocks (~${(sn.immunity_blocks / 7200).toFixed(1)} days)`,
        "TAO volatility": `${pct(s.vol.sigma)}/yr (${s.vol.kind}); alpha price risk not modelled`,
        ...(sn.sell_pressure != null ? { "pool": `${money(sn.tao_in ?? 0)} TAO reserve; miners are paid ${((sn.sell_pressure) * 100).toFixed(1)}% of it a day` } : {}),
        ...(sn.top3_share != null ? { wallets: `top 3 wallets take ${pct(sn.top3_share)} of rewards` } : {}),
        ...(known?.note ? { hardware: known.note } : {}),
        ...(rent ? { "net $/TFLOP-hour": (s.netDay / (gpu.fp32 * 24)).toPrecision(3) } : {}),
      },
    });
  }

  // Rented out (owning mode only): market price × 24 × utilisation × (1 − fee).
  if (inp.mode === "own") {
    const idle = gpu.tdp * d.idle_frac;
    for (const [m, q] of Object.entries(latest.rentals[inp.gpu] ?? {})) {
      const fee = tables.fees[m]?.fee ?? 0.2;
      const u0 = inp.util ?? q.util ?? d.util;
      const net = (u: number) => q.med * 24 * u * (1 - fee) - ((gpu.tdp * u + idle * (1 - u)) / 1000) * 24 * inp.kwh;
      const clamp = (u: number) => Math.min(1, Math.max(0, u));
      // ponytail: naive band, replace with the archive's measured utilisation spread once there's 30 days of history.
      const lo = clamp(u0 - d.util_band), hi = clamp(u0 + d.util_band);
      const costDay = ((gpu.tdp * u0 + idle * (1 - u0)) / 1000) * 24 * inp.kwh;
      const be = u0 > 0 ? costDay / (24 * u0 * (1 - fee)) : Infinity;
      const flags = [];
      if (!tables.fees[m]?.confirmed) flags.push(`fee ${pct(fee)} unconfirmed`);
      if (inp.util == null && q.util == null) flags.push(`utilisation assumed ${pct(u0)}`);
      rows.push({
        kind: "rent", label: `Rent out on ${MARKET_NAMES[m] ?? m}`, where: MARKET_NAMES[m] ?? m, chance: u0, usesGpu: true,
        // When power costs more than renting earns, more utilisation is worse, so order the band's ends.
        netDay: net(u0), p10: Math.min(net(lo), net(hi)) * H, p50: net(u0) * H, p90: Math.max(net(lo), net(hi)) * H,
        breakEvenPrice: Number.isFinite(be) ? { value: be, pctFromNow: be / q.med - 1, unit: "$/h" } : undefined,
        breakEvenKwh: Math.max(0, (q.med * 24 * u0 * (1 - fee)) / (((gpu.tdp * u0 + idle * (1 - u0)) / 1000) * 24)),
        flags,
        detail: {
          "market price": `median $${money(q.med)}/h, lowest $${money(q.min)}/h, ${q.n} listed`,
          utilisation: `${pct(u0)} (${inp.util != null ? "your setting" : q.util != null ? "market signal" : "default"}), band ${pct(lo)}–${pct(hi)}`,
          fee: `${pct(fee)}: ${tables.fees[m]?.note ?? ""}`,
        },
      });
    }
  }
  return rows.filter((r) => [r.netDay, r.p10, r.p50, r.p90].every(Number.isFinite)).sort((a, b) => b.p50 - a.p50);
}

export type SortKey = "p50" | "netDay" | "chance" | "breakEven";
const sortValue: Record<SortKey, (r: Row) => number> = {
  p50: (r) => r.p50, netDay: (r) => r.netDay, chance: (r) => r.chance,
  // the further the break-even price sits below today's, the safer: sort on its distance
  breakEven: (r) => (r.breakEvenPrice ? -r.breakEvenPrice.pctFromNow : -Infinity),
};

export function sortRows(rows: Row[], key: SortKey, desc = true): Row[] {
  const v = sortValue[key];
  return [...rows].sort((a, b) => (desc ? v(b) - v(a) : v(a) - v(b)) || b.p50 - a.p50);
}

export function buyRows(inp: Inputs, latest: Latest, tables: Tables): BuyRow[] {
  const BTC = latest.usd.BTC, out: BuyRow[] = [];
  if (!(BTC > 0) || !(inp.budget > 0)) return out;
  for (const algo of Object.keys(tables.algos)) {
    // Best coin for this algorithm, in $ per H/s per day.
    let best: { coin: Coin; usdPerHs: number } | null = null;
    for (const c of latest.coins) {
      const S = latest.usd[c.tag];
      if (c.algo !== algo || !(c.nethash > 0 && c.block_time > 0 && S > 0)) continue;
      const usdPerHs = (1 / c.nethash) * (86400 / c.block_time) * c.block_reward * S * (1 - inp.poolFee);
      if (!best || usdPerHs > best.usdPerHs) best = { coin: c, usdPerHs };
    }
    if (!best) continue;
    const nh = latest.nicehash[algo];
    if (nh?.book.length) {
      const fee = tables.defaults.buy_fee_nicehash;
      // Nobody buys below what NiceHash pays sellers: stray cheap orders in the book aren't really for sale.
      const book = nh.book.map(([p, c]) => [Math.max(p, nh.pay), c] as [number, number]);
      const fill = fillBook(book, inp.budget / BTC, fee);
      const spend = fill.hs * fill.priceBtc * (1 + fee) * BTC, revenue = fill.hs * best.usdPerHs;
      const u = si(fill.hs);
      if (spend > 0) out.push({
        algo, venue: "nicehash", coin: best.coin.name, marginPct: (revenue - spend) / spend, spend, revenue,
        flags: fill.exhausted ? [`book exhausted: only $${money(spend)} of $${inp.budget.toLocaleString("en-US")}/day fillable`] : [],
        detail: { bought: `${u.text} at ${(fill.priceBtc * u.factor).toPrecision(3)} BTC per ${u.prefix}H/s per day`, fee: pct(fee) },
      });
    }
    const mrr = latest.mrr[algo];
    if (mrr?.price > 0) {
      const fee = tables.fees.mrr.fee, hs = inp.budget / (mrr.price * (1 + fee) * BTC), revenue = hs * best.usdPerHs;
      out.push({
        algo, venue: "mrr", coin: best.coin.name, marginPct: (revenue - inp.budget) / inp.budget, spend: inp.budget, revenue,
        // ponytail: MRR priced at its suggested price, not walked through live rig listings.
        flags: ["priced at MRR's suggested price"],
        detail: { bought: si(hs).text, fee: pct(fee) },
      });
    }
  }
  for (const r of out)
    if (r.marginPct > 1) r.flags.push("margin over +100%: usually an illiquid coin or a stale price, check before trusting");
  // Rows that can't fill half the budget (a nearly empty market) rank below ones that can, whatever their margin.
  const thin = (r: BuyRow) => (r.spend < inp.budget / 2 ? 1 : 0);
  return out.filter((r) => Number.isFinite(r.marginPct)).sort((a, b) => thin(a) - thin(b) || b.marginPct - a.marginPct);
}

/** 4810 H/s → "4.81 kH/s" (for Sol algorithms read Sol/s). */
function si(hs: number) {
  const steps: [string, number][] = [["E", 1e18], ["P", 1e15], ["T", 1e12], ["G", 1e9], ["M", 1e6], ["k", 1e3], ["", 1]];
  const [prefix, factor] = steps.find(([, f]) => hs >= f) ?? ["", 1];
  return { prefix, factor, text: `${(hs / factor).toPrecision(3)} ${prefix}H/s` };
}
