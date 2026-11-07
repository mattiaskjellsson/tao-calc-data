import { gpuRows, priceCone, rentCost, sortRows, MARKET_NAMES, type Bench, type Inputs, type Latest, type Row, type SortKey, type Tables, type Alpha } from "./calc.js";

const DATA = new URLSearchParams(location.search).get("data") ?? "https://raw.githubusercontent.com/mattiaskjellsson/tao-calc-data/main/site-data/";
const STALE_HOURS = 3;
const SHOW = 25;

const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T;
const form = $<HTMLFormElement>("#controls");
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const usd = (x: number) => {
  const a = Math.abs(x), s = x < 0 ? "−" : "";
  return `${s}$${a >= 1000 ? Math.round(a).toLocaleString("en-US") : a >= 10 ? a.toFixed(0) : a >= 1 ? a.toFixed(2) : a.toPrecision(2)}`;
};
const signed = (x: number) => `<span class="${x >= 0 ? "pos" : "neg"}">${usd(x)}</span>`;
const pct = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(Math.round(x * 100))}%`;

let tables: Tables, latest: Latest, bench: Bench, alpha: Alpha | undefined;
let showAll = false;
let desc = true; // clicking the active column header again flips this
const open = new Set<string>();

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

function inputs(): Inputs {
  const f = new FormData(form), num = (k: string, d: number) => (f.get(k) === "" || f.get(k) == null ? d : Number(f.get(k)));
  const util = f.get("util");
  return {
    mode: f.get("mode") === "rent" ? "rent" : "own",
    gpu: String(f.get("gpu")),
    kwh: Math.max(0, num("kwh", tables.defaults.kwh)),
    horizon: num("horizon", 30),
    rankPct: Math.min(100, Math.max(1, num("rankPct", tables.defaults.rank_pct))),
    util: util === "" || util == null ? null : Math.min(1, Math.max(0, Number(util) / 100)),
  };
}

function flagsHtml(flags: string[]) {
  const hot = /winner-take-all|earn 0/;
  return `<div class="flags">${flags.map((f) => `<span class="flag${hot.test(f) ? " hot" : ""}">${esc(f)}</span>`).join("")}</div>`;
}

function breakEven(r: Row, mode: string) {
  const parts = [];
  if (r.breakEvenPrice) {
    const b = r.breakEvenPrice, v = b.value >= 1 ? b.value.toPrecision(4) : b.value.toPrecision(3);
    parts.push(`${b.unit.startsWith("$/h") ? `$${v}/h` : `$${v}${esc(b.unit.slice(1))}`} <span class="where">(${pct(b.pctFromNow)})</span>`);
  }
  if (mode === "own" && r.breakEvenKwh !== undefined) parts.push(`≤ $${r.breakEvenKwh.toFixed(3)}/kWh`);
  return parts.join("<br>") || "—";
}

function renderRows(inp: Inputs) {
  const f = new FormData(form), key = String(f.get("sort") ?? "p50") as SortKey, minChance = Number(f.get("minChance") ?? 0);
  const all = gpuRows(inp, latest, bench, tables, alpha).filter((r) => r.chance >= minChance);
  const nonGpu = all.filter((r) => r.usesGpu === false).length;
  const rows = sortRows(f.get("nonGpu") === "on" ? all : all.filter((r) => r.usesGpu !== false), key, desc);
  $<HTMLElement>("#nongpu-count").textContent = nonGpu ? `(${nonGpu})` : "";
  document.querySelectorAll<HTMLButtonElement>("button.sort").forEach((b) => {
    b.classList.toggle("active", b.dataset.sort === key);
    b.classList.toggle("asc", b.dataset.sort === key && !desc);
  });
  const shown = showAll ? rows : rows.slice(0, SHOW);
  const body = shown.map((r) => {
    const key = `${r.kind}:${r.label}:${r.where}`;
    const main = `<tr class="row" tabindex="0" data-key="${esc(key)}" aria-expanded="${open.has(key)}">
      <td data-label=""><div class="label">${esc(r.label)}</div><div class="where">${esc(r.where)}</div></td>
      <td class="num" data-label="Net $/day">${signed(r.netDay)}</td>
      <td class="num range" data-label="Over ${inp.horizon} d">${signed(r.p10)} · <b>${signed(r.p50)}</b> · ${signed(r.p90)}</td>
      <td class="num" data-label="Chance of earning"><span class="${r.chance < 0.5 ? "neg" : ""}">${Math.round(r.chance * 100)}%</span></td>
      <td data-label="Break-even">${breakEven(r, inp.mode)}</td>
      <td data-label="">${flagsHtml(r.flags)}</td></tr>`;
    const detail = open.has(key)
      ? `<tr class="detail"><td colspan="6">${coneHtml(r, inp.horizon)}<dl>${Object.entries(r.detail).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl></td></tr>`
      : "";
    return main + detail;
  }).join("");
  $<HTMLTableSectionElement>("#rows tbody").innerHTML = body;
  $<HTMLElement>("#rows-empty").hidden = rows.length > 0;
  const btn = $<HTMLButtonElement>("#show-all");
  btn.hidden = rows.length <= SHOW;
  btn.textContent = showAll ? "Show top 25" : `Show all ${rows.length}`;
  const gpu = tables.gpus[inp.gpu];
  const rent = inp.mode === "rent" ? rentCost(inp.gpu, latest) : null;
  $<HTMLElement>("#gpu-title").textContent = inp.mode === "own"
    ? `What a ${gpu.name} can do at $${inp.kwh}/kWh`
    : rent ? `Renting a ${gpu.name}: cheapest $${rent.usdHour.toFixed(2)}/h on ${MARKET_NAMES[rent.market]}` : `No ${gpu.name} for rent right now`;
}

const SOURCE = { implied: "implied by Binance options, the market's own forecast", realised: "from 30-day realised volatility", assumed: "assumed volatility (no market data)" };
const price = (v: number) => `$${v >= 1 ? v.toPrecision(4) : v.toPrecision(3)}`;
const CONE = { w: 600, h: 170, l: 8, r: 150, t: 10, b: 24 };

/** Where what this row is paid in could trade over the horizon (p10/p50/p90), with the break-even price. */
function coneHtml(r: Row, H: number): string {
  if (!r.price || !(r.price.spot > 0) || H < 1) return "";
  const { tag, spot, sigma, kind } = r.price, cone = priceCone(spot, sigma, H), end = cone[H];
  const be = r.breakEvenPrice && r.breakEvenPrice.unit === `$/${tag}` ? r.breakEvenPrice.value : null;
  const near = be != null && be > end.p10 * 0.5 && be < end.p90 * 1.5; // only stretch the axis for a nearby break-even
  const yMin = Math.min(end.p10, near ? (be as number) : Infinity) * 0.95, yMax = Math.max(end.p90, near ? (be as number) : 0) * 1.05;
  const x = (d: number) => CONE.l + ((CONE.w - CONE.l - CONE.r) * d) / H;
  const y = (v: number) => CONE.t + (CONE.h - CONE.t - CONE.b) * (1 - (v - yMin) / (yMax - yMin));
  const band = cone.map((c) => `${x(c.day)},${y(c.p90)}`).concat([...cone].reverse().map((c) => `${x(c.day)},${y(c.p10)}`)).join(" ");
  const label = (v: number, text: string) => `<text class="lbl" x="${x(H) + 6}" y="${y(v) + 4}">${esc(text)} ${price(v)}</text>`;
  const beLine = near
    ? `<line class="be" x1="${x(0)}" x2="${x(H)}" y1="${y(be as number)}" y2="${y(be as number)}"/>${label(be as number, "break-even")}`
    : "";
  return `<figure class="cone"><svg viewBox="0 0 ${CONE.w} ${CONE.h}" role="img" data-spot="${spot}" data-sigma="${sigma}" data-h="${H}"
      aria-label="${esc(tag)} price range over ${H} days">
    <polygon class="band" points="${band}"/><line class="mid" x1="${x(0)}" x2="${x(H)}" y1="${y(spot)}" y2="${y(spot)}"/>
    ${beLine}${label(end.p90, "good")}${label(spot, "typical")}${label(end.p10, "bad")}
    <text class="axis" x="${x(0)}" y="${CONE.h - 6}">today ${price(spot)}</text>
    <text class="axis" x="${x(H)}" y="${CONE.h - 6}" text-anchor="end">+${H} days</text>
    <line class="xh" y1="${CONE.t}" y2="${CONE.h - CONE.b}" x1="-10" x2="-10"/><text class="tip" x="${x(0)}" y="${CONE.t + 10}"></text>
  </svg><figcaption>${esc(tag)} price range, ${esc(SOURCE[kind])}, no drift assumed. On day ${H}: bad ${price(end.p10)} · typical ${price(spot)} · good ${price(end.p90)}${
    be != null && !near ? `. Break-even ${price(be)} is off this chart` : ""}.</figcaption></figure>`;
}

function coneHover(e: PointerEvent) {
  const svg = (e.target as Element).closest("figure.cone svg") as SVGSVGElement | null;
  if (!svg) return;
  const H = Number(svg.dataset.h), box = svg.getBoundingClientRect();
  const vx = ((e.clientX - box.left) / box.width) * CONE.w;
  const day = Math.round(Math.min(H, Math.max(0, ((vx - CONE.l) / (CONE.w - CONE.l - CONE.r)) * H)));
  const c = priceCone(Number(svg.dataset.spot), Number(svg.dataset.sigma), H)[day];
  const lx = CONE.l + ((CONE.w - CONE.l - CONE.r) * day) / H;
  svg.querySelector(".xh")?.setAttribute("x1", String(lx));
  svg.querySelector(".xh")?.setAttribute("x2", String(lx));
  const tip = svg.querySelector(".tip") as SVGTextElement;
  tip.textContent = `day ${day}: ${price(c.p10)} · ${price(c.p50)} · ${price(c.p90)}`;
}

function render() {
  const inp = inputs();
  document.body.className = `mode-${inp.mode}`;
  renderRows(inp);
}

function banner(msg: string | null) {
  const b = $<HTMLElement>("#banner");
  b.hidden = !msg;
  b.innerHTML = msg ? `<div>${msg}</div>` : "";
}

async function main() {
  try {
    [tables, latest, bench] = await Promise.all([
      getJson<Tables>("./dist/tables.json"), getJson<Latest>(DATA + "latest.json"), getJson<Bench>(DATA + "benchmarks.json"),
    ]);
    alpha = await getJson<Alpha>(DATA + "alpha.json").catch(() => undefined); // optional: written once a day
  } catch (e) {
    banner(`Couldn't load the data (${esc((e as Error).message)}). Try again in a minute.`);
    $<HTMLElement>("#stamp").textContent = "No data loaded.";
    return;
  }
  const ageH = (Date.now() - Date.parse(latest.ts)) / 3_600_000;
  const failed = Object.entries(latest.sources).filter(([, s]) => !s.ok).map(([k]) => k);
  const notes = [];
  if (ageH > STALE_HOURS) notes.push(`This data is ${Math.round(ageH)} hours old; the hourly update may be stuck.`);
  if (failed.length) notes.push(`Missing this hour: ${esc(failed.join(", "))}. Rows from those sources are left out.`);
  banner(notes.length ? notes.join(" ") : null);
  const t = new Date(latest.ts);
  $<HTMLElement>("#stamp").textContent = `Data from ${t.toISOString().slice(0, 16).replace("T", " ")} UTC.`;

  const select = form.elements.namedItem("gpu") as HTMLSelectElement;
  const usable = Object.entries(tables.gpus).filter(([id]) => bench.gpus[id] || latest.rentals[id]);
  select.innerHTML = usable.map(([id, g]) => `<option value="${esc(id)}">${esc(g.name)} · ${g.vram} GB</option>`).join("");
  select.value = usable.some(([id]) => id === "rtx4090") ? "rtx4090" : usable[0]?.[0] ?? "";

  form.addEventListener("input", (e) => {
    if ((e.target as HTMLElement).getAttribute("name") === "sort") desc = true;
    showAll = false;
    render();
  });
  $<HTMLElement>("#rows thead").addEventListener("click", (e) => {
    const b = (e.target as Element).closest("button.sort") as HTMLButtonElement | null;
    if (!b) return;
    const select = form.elements.namedItem("sort") as HTMLSelectElement;
    desc = select.value === b.dataset.sort ? !desc : true;
    select.value = b.dataset.sort as string;
    render();
  });
  $<HTMLButtonElement>("#show-all").addEventListener("click", () => { showAll = !showAll; render(); });
  const toggle = (e: Event) => {
    if ((e.target as Element).closest("thead")) return;
    const tr = (e.target as Element).closest("tr.row") as HTMLElement | null;
    if (!tr) return;
    const key = tr.dataset.key as string;
    open.has(key) ? open.delete(key) : open.add(key);
    render();
  };
  $<HTMLElement>("#rows").addEventListener("click", toggle);
  $<HTMLElement>("#rows").addEventListener("pointermove", coneHover);
  $<HTMLElement>("#rows").addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") toggle(e); });
  render();
}

main();
