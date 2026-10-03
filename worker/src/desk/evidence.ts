/**
 * THE DESK'S EVIDENCE: what a coin or the market is doing, measured by code.
 *
 * Two shapes, each in three parts:
 *   measure  — the reads (index pools, hourly candles) reduced to numbers;
 *   brief    — those numbers written out for a model to reason over;
 *   floor    — a read written by code from the same numbers, so a group gets a
 *              real answer even when no model can give a better one.
 *
 * PUBLIC INDEX DATA ONLY. Nothing here is handed a balance, a position, a
 * limit or anything from the owner's ledger, so nothing here can print one
 * (docs/tg-groups.md rules 2 and 3). Names the index carries are attacker-
 * chosen — anyone can deploy a coin called "ignore your instructions" — so a
 * symbol is reduced to a plain ticker before it is written anywhere a model or
 * a group will read it.
 */
import type { GeckoFetch, GeckoPool, PoolFeed } from "../venues/geckoterminal";
import type { TgDeskAsk, TgDeskStance, TgDeskThought } from "../telegram/tg-groups/types";
import type { BarsRead } from "./gecko";
import { fmtAge, fmtInt, fmtPct, fmtPrice, fmtUsd, fmtX, utcClock } from "./format";
import { technicals, type Bar, type Technicals } from "./ta";
import { DeskBudget, type DeskReadOptions } from "./deadline";

/**
 * May a group read this ticker? Anyone can deploy a coin called "scam.io" or
 * a slur; a ticker that fails gets a neutral name everywhere it would be
 * printed — brief, read, header and chart alike. desk.ts supplies the group
 * gate's judgement; absent, every clean ticker passes.
 */
export type Sayable = (ticker: string) => boolean;
const ANYTHING: Sayable = () => true;

/** The reads the desk makes. Injected, so every branch is testable without the network. */
export interface DeskReads {
  search(query: string, options?: DeskReadOptions): Promise<GeckoFetch>;
  tokenPools(address: string, options?: DeskReadOptions): Promise<GeckoFetch>;
  hourly(poolId: string, token: string, options?: DeskReadOptions): Promise<BarsRead>;
  feed(feed: PoolFeed, options?: DeskReadOptions): Promise<GeckoFetch>;
  now(): number;
}

const CURVE_DEX = "pons-v2";
const QUOTES = new Set(["WETH", "ETH", "USDG", "USDC", "USDT", "USDE", "DAI", "WBTC"]);

/**
 * A ticker a group may read: letters and digits (plus . _ -), at most 16.
 * Anything else is not a ticker, it is a sentence someone named a coin.
 */
export function cleanSymbol(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/^\$/, "");
  return /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,15}$/u.test(s) ? s : null;
}

/** "CASHCAT / WETH 0.3%" → base "CASHCAT", quote "WETH". */
export function poolSides(name: string): { base: string | null; quote: string | null } {
  const [b, q] = typeof name === "string" ? name.split(" / ") : [];
  return { base: cleanSymbol(b), quote: cleanSymbol((q ?? "").trim().split(/\s+/)[0]) };
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const n = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

// ── the coin ────────────────────────────────────────────────────────────────

export interface CoinMeasure {
  symbol: string;
  token: string;
  pool: GeckoPool;
  quote: string | null;
  pools: GeckoPool[];
  bars: Bar[];
  tech: Technicals | null;
  observedAtMs: number;
  nowMs: number;
}

export type CoinMeasured = { ok: true; coin: CoinMeasure } | { ok: false; why: "not-found" | "ambiguous" | "unavailable" };

/**
 * CREDIBLE 24h VOLUME: a pool's volume counts only when it has at least $1k of
 * liquidity behind it, and never past a hundred turns of that liquidity. A
 * drained pool holding $16 that "traded" $7m is a wash or an exploit; it must
 * not out-vote the coin everyone is actually trading, nor inflate a total.
 */
export function credibleVolume(p: GeckoPool): number {
  const liq = p.reserveUsd ?? 0;
  return liq >= 1000 ? Math.min(p.volume24hUsd ?? 0, liq * 100) : 0;
}

/**
 * Which token a name means. Only an EXACT ticker match counts ("cash" is not
 * CASHCAT). When several tokens share the ticker — and on a chain where
 * anyone can deploy "SI" in a minute, they do — one wins only by DOMINATING:
 * four times the next one's 24h volume while holding real liquidity, or four
 * times its liquidity. The copycat of a coin people are talking about is
 * nearly always a sliver of it on both. Otherwise the answer is "ambiguous",
 * and the group is asked for the CA rather than handed a guess.
 */
export function resolveByName(query: string, pools: readonly GeckoPool[]): { token: string; pools: GeckoPool[] } | "not-found" | "ambiguous" {
  const want = norm(query);
  if (!want) return "not-found";
  const byToken = new Map<string, GeckoPool[]>();
  for (const p of pools) {
    const { base } = poolSides(p.name);
    if (!base || norm(base) !== want) continue;
    byToken.set(p.tokenAddress, [...(byToken.get(p.tokenAddress) ?? []), p]);
  }
  if (!byToken.size) return "not-found";
  const ranked = [...byToken.entries()].map(([token, ps]) => ({
    token,
    pools: ps,
    depth: ps.reduce((s, p) => s + (p.reserveUsd ?? 0), 0),
    volume: ps.reduce((s, p) => s + credibleVolume(p), 0),
  }));
  if (ranked.length === 1) return { token: ranked[0]!.token, pools: ranked[0]!.pools };
  const deepest = Math.max(...ranked.map((r) => r.depth));
  const byVolume = [...ranked].sort((a, b) => b.volume - a.volume);
  const [loud, loudNext] = byVolume;
  if (loud!.volume > 0 && loud!.volume >= loudNext!.volume * 4 && loud!.depth >= deepest * 0.5) return { token: loud!.token, pools: loud!.pools };
  const byDepth = [...ranked].sort((a, b) => b.depth - a.depth);
  const [deep, deepNext] = byDepth;
  if (deep!.depth > 0 && deep!.depth >= deepNext!.depth * 4) return { token: deep!.token, pools: deep!.pools };
  return "ambiguous";
}

/**
 * The pool a chart is read from: the BUSIEST of the deep real pools — at
 * least a quarter of the deepest one's liquidity — and a bonding curve only
 * when there is nothing else. The deepest pool alone is often a quiet 1% tier
 * whose hourly candles are mostly arbitrage; the price action is where the
 * volume is.
 */
export function mainPool(pools: readonly GeckoPool[]): GeckoPool | null {
  const real = pools.filter((p) => p.dex !== CURVE_DEX);
  const from = real.length ? real : [...pools];
  const deepest = Math.max(0, ...from.map((p) => p.reserveUsd ?? 0));
  const deep = from.filter((p) => (p.reserveUsd ?? 0) >= deepest * 0.25);
  return (deep.length ? deep : from).sort((a, b) => (b.volume24hUsd ?? -1) - (a.volume24hUsd ?? -1) || (b.reserveUsd ?? -1) - (a.reserveUsd ?? -1))[0] ?? null;
}

interface Flow {
  buys: number | null;
  sells: number | null;
  buyers: number | null;
  sellers: number | null;
  volumeUsd: number | null;
}

/**
 * One window's tape summed over every pool the coin trades in. A count is
 * reported only when every pool reported it: a partial sum would read as a
 * measured total. Distinct traders are summed too, so one address active in
 * two pools counts twice — the brief says so.
 */
export function flowOf(pools: readonly GeckoPool[], w: "h1" | "h6" | "h24"): Flow {
  const sum = (k: keyof Flow): number | null =>
    pools.length && pools.every((p) => n(p.buckets[w][k])) ? pools.reduce((s, p) => s + (p.buckets[w][k] as number), 0) : null;
  return { buys: sum("buys"), sells: sum("sells"), buyers: sum("buyers"), sellers: sum("sellers"), volumeUsd: sum("volumeUsd") };
}

export async function measureCoin(ask: Extract<TgDeskAsk, { kind: "coin" }>, reads: DeskReads, sayable: Sayable = ANYTHING, budget = new DeskBudget(), onPartial?: (coin: CoinMeasure) => void): Promise<CoinMeasured> {
  let token: string;
  let pools: GeckoPool[];
  let observedAt: number | undefined;
  if ("address" in ask) {
    const a = typeof ask.address === "string" ? ask.address.toLowerCase() : "";
    if (!/^0x[0-9a-f]{40}$/.test(a)) return { ok: false, why: "not-found" };
    const r = await budget.run((options) => reads.tokenPools(a, options), { pools: [], failed: true, failure: "timeout" } as GeckoFetch);
    if (r.failed) return { ok: false, why: "unavailable" };
    token = a;
    pools = r.pools.filter((p) => p.tokenAddress === a);
    observedAt = r.observedAt;
  } else {
    const r = await budget.run((options) => reads.search(ask.query, options), { pools: [], failed: true, failure: "timeout" } as GeckoFetch);
    if (r.failed) return { ok: false, why: r.failure === "invalid-query" ? "not-found" : "unavailable" };
    const hit = resolveByName(ask.query, r.pools);
    if (hit === "not-found" || hit === "ambiguous") return { ok: false, why: hit };
    token = hit.token;
    pools = hit.pools;
    observedAt = r.observedAt;
  }
  const pool = mainPool(pools);
  if (!pool) return { ok: false, why: "not-found" };
  const sides = poolSides(pool.name);
  const fromChart = (chart: BarsRead): CoinMeasure => {
    const bars = chart.failed ? [] : chart.bars;
    const ticker = cleanSymbol(chart.symbol) ?? sides.base;
    const symbol = ticker && sayable(ticker) ? ticker : "this coin";
    const quote = cleanSymbol(chart.quoteSymbol) ?? sides.quote;
    const now = reads.now();
    return {
      symbol,
      token,
      pool,
      quote: quote && sayable(quote) ? quote : null,
      pools,
      bars,
      tech: technicals(bars),
      observedAtMs: Math.min(observedAt ?? now, chart.observedAt ?? now),
      nowMs: now,
    };
  };
  // Pool measurements already support a real read. A slow chart must not
  // hide them, including from a caller joining a shared lookup late.
  const unavailable: BarsRead = { failed: true, failure: "timeout", bars: [] };
  onPartial?.(fromChart(unavailable));
  const chart = await budget.run((options) => reads.hourly(pool.poolId, token, options), unavailable, Math.min(3000, budget.remaining() * 0.75));
  const coin = fromChart(chart);
  onPartial?.(coin);
  return { ok: true, coin };
}

/** Price now: the forming candle's close when the chart was read, else the index's pool price. */
function priceOf(c: CoinMeasure): number | null {
  return c.tech?.last ?? (n(c.pool.priceUsd) && c.pool.priceUsd > 0 ? c.pool.priceUsd : null);
}

function ageSec(c: CoinMeasure): number | null {
  const created = c.pools.map((p) => p.createdAt).filter(n);
  return created.length ? c.nowMs / 1000 - Math.min(...created) : null;
}

const dexLabel = (dex: string): string =>
  dex === CURVE_DEX ? "a Pons bonding curve" : dex.includes("v4") ? "a v4 pool" : dex.includes("v3") ? "a v3 pool" : "a pool";

export function coinHeader(c: CoinMeasure): string[] {
  const price = priceOf(c);
  const ch24 = c.pool.buckets.h24.changePct;
  const top = [`${c.symbol}${c.quote ? ` / ${c.quote}` : ""} · 1h`];
  if (price !== null) top.push(`$${fmtPrice(price)}${n(ch24) ? ` (${fmtPct(ch24)} 24h)` : ""}`);
  const liq = c.pools.reduce((s, p) => s + (p.reserveUsd ?? 0), 0);
  const vol = c.pools.reduce((s, p) => s + credibleVolume(p), 0);
  const age = ageSec(c);
  const second = [
    liq > 0 ? `liq ${fmtUsd(liq)}` : null,
    vol > 0 ? `vol 24h ${fmtUsd(vol)}` : null,
    n(c.pool.fdvUsd) && c.pool.fdvUsd > 0 ? `fdv ${fmtUsd(c.pool.fdvUsd)}` : null,
    age !== null ? `age ${fmtAge(age)}` : null,
  ].filter((x): x is string => x !== null);
  return [top.join(" · "), ...(second.length ? [second.join(" · ")] : [])];
}

export function coinBrief(c: CoinMeasure): string {
  const L: string[] = [];
  const p = c.pool;
  const price = priceOf(c);
  const t = c.tech;
  const liq = c.pools.reduce((s, x) => s + (x.reserveUsd ?? 0), 0);
  const vol = c.pools.reduce((s, x) => s + credibleVolume(x), 0);
  const age = ageSec(c);
  // The ticker only, never the coin's full name: that is free text its deployer
  // wrote, and a brief is read by a model.
  L.push(`COIN: ${c.symbol} on Robinhood Chain; main pool ${c.symbol}${c.quote ? ` / ${c.quote}` : ""} on ${dexLabel(p.dex)}; ${c.pools.length} pool${c.pools.length === 1 ? "" : "s"} indexed; observed ${utcClock(c.observedAtMs)} UTC`);
  if (price !== null) {
    const ch = (["m5", "h1", "h6", "h24"] as const)
      .map((w) => (n(p.buckets[w].changePct) ? `${w === "m5" ? "5m" : w.slice(1) + "h"} ${fmtPct(p.buckets[w].changePct!)}` : null))
      .filter(Boolean);
    L.push(`PRICE: $${fmtPrice(price)}${ch.length ? ` | change ${ch.join(", ")}` : ""}`);
  }
  const liqLine = [
    n(p.reserveUsd) ? `main pool liquidity ${fmtUsd(p.reserveUsd)}` : null,
    c.pools.length > 1 && liq > 0 ? `all pools ${fmtUsd(liq)}` : null,
    n(p.fdvUsd) && p.fdvUsd > 0 ? `FDV ${fmtUsd(p.fdvUsd)}` : null,
    n(p.fdvUsd) && p.fdvUsd > 0 && liq > 0 ? `liquidity/FDV ${fmtPct((liq / p.fdvUsd) * 100, false)}` : null,
    vol > 0 ? `24h volume ${fmtUsd(vol)}` : null,
    vol > 0 && liq > 0 ? `turnover ${fmtX(vol / liq)} liquidity per day` : null,
  ].filter(Boolean);
  if (liqLine.length) L.push(`LIQUIDITY: ${liqLine.join(" | ")}`);
  if (p.dex === CURVE_DEX) L.push("NOTE: the main pool is a bonding curve; its listed liquidity includes a virtual seed and is not tradeable depth");
  const flow = (["h1", "h6", "h24"] as const)
    .map((w) => {
      const b = flowOf(c.pools, w);
      if (!n(b.buys) || !n(b.sells)) return null;
      const who = n(b.buyers) && n(b.sellers) ? `, ${fmtInt(b.buyers)} buyers / ${fmtInt(b.sellers)} sellers` : "";
      const v = n(b.volumeUsd) ? `, volume ${fmtUsd(b.volumeUsd)}` : "";
      return `${w.slice(1)}h: ${fmtInt(b.buys)} buys / ${fmtInt(b.sells)} sells${who}${v}`;
    })
    .filter(Boolean);
  if (flow.length) L.push(`FLOW (${c.pools.length > 1 ? `all ${c.pools.length} pools; a trader active in two pools counts twice` : "the pool"}): ${flow.join(" | ")}`);
  if (age !== null) L.push(`AGE: oldest pool ${fmtAge(age)} old`);
  if (!t) {
    L.push("HOURLY CHART: not available (too few candles or the chart read failed) — no indicators");
    return L.join("\n");
  }
  L.push(`HOURLY CHART: ${t.bars} candles covering ${t.hours}h`);
  const emaPart = [t.ema20 !== null ? `EMA20 ${fmtPrice(t.ema20)}` : null, t.ema50 !== null ? `EMA50 ${fmtPrice(t.ema50)}` : null].filter(Boolean).join(", ");
  L.push(`- trend: ${t.trend}${emaPart ? ` (price ${fmtPrice(t.last)} vs ${emaPart}${t.ema20Slope6hPct !== null ? `; EMA20 ${fmtPct(t.ema20Slope6hPct)} over 6h` : ""})` : ""}`);
  L.push(`- structure: ${t.structure}`);
  if (t.rsi14 !== null) L.push(`- RSI14: ${Number(t.rsi14.toFixed(1))}`);
  if (t.atrPct !== null) L.push(`- ATR14: ${fmtPct(t.atrPct, false)} of price per hour${t.hourlyVolPct !== null ? `; hourly volatility ${fmtPct(t.hourlyVolPct, false)}` : ""}`);
  if (t.high24h !== null && t.low24h !== null) L.push(`- 24h range ${fmtPrice(t.low24h)} to ${fmtPrice(t.high24h)}`);
  L.push(`- ${t.hours}h range ${fmtPrice(t.rangeLow)} to ${fmtPrice(t.rangeHigh)}${t.rangePositionPct !== null ? `; price at ${fmtPct(t.rangePositionPct, false)} of it` : ""}; ${fmtPct(t.belowHighPct, false)} below the high, ${fmtPct(t.aboveLowPct, false)} above the low`);
  if (t.windowChangePct !== null) L.push(`- change across the ${t.hours}h window: ${fmtPct(t.windowChangePct)}`);
  if (t.vwap24h !== null && t.vsVwapPct !== null) L.push(`- 24h VWAP ${fmtPrice(t.vwap24h)} (price ${fmtPct(t.vsVwapPct)} vs VWAP)`);
  const volParts = [
    t.volume6hVsPrior !== null ? `last 6h ${fmtX(t.volume6hVsPrior)} the prior 18h pace` : null,
    t.volume24hVsPrior !== null ? `last 24h ${fmtX(t.volume24hVsPrior)} the 24h before` : null,
  ].filter(Boolean);
  if (volParts.length) L.push(`- volume: ${volParts.join("; ")}`);
  const lv = (l: { price: number; label: string }) => `${fmtPrice(l.price)} (${l.label})`;
  L.push(`- supports below: ${t.supports.length ? t.supports.map(lv).join(", ") : "none in the window"}`);
  L.push(`- resistances above: ${t.resistances.length ? t.resistances.map(lv).join(", ") : "none in the window (price is at the window high)"}`);
  if (t.lastBarsPct.length) L.push(`- last ${t.lastBarsPct.length} hourly candles: ${t.lastBarsPct.map((x) => fmtPct(x)).join(", ")} (the last is still forming)`);
  return L.join("\n");
}

/**
 * THE CODE'S OWN READ. Plain rules over the measurements, written the way the
 * agent talks. It is the answer when there is no model, when the model's read
 * fails the group gate, and the yardstick a model's read is an improvement on.
 */
export function coinFloor(c: CoinMeasure): TgDeskThought {
  const t = c.tech;
  const s = c.symbol.toLowerCase();
  const p = c.pool;
  const liq = c.pools.reduce((acc, x) => acc + (x.reserveUsd ?? 0), 0);
  const age = ageSec(c);
  const h24 = { ...flowOf(c.pools, "h24"), changePct: p.buckets.h24.changePct };
  if (!t) {
    const parts = [`not enough chart history on ${s} to read a trend yet`];
    if (n(h24.changePct)) parts.push(`it's ${fmtPct(h24.changePct)} on the day`);
    if (liq > 0) parts.push(`with ${fmtUsd(liq)} of liquidity`);
    if (n(h24.volumeUsd)) parts.push(`${fmtUsd(h24.volumeUsd)} traded over 24h`);
    if (n(h24.buyers) && n(h24.sellers)) parts.push(`${fmtInt(h24.buyers)} buyers vs ${fmtInt(h24.sellers)} sellers`);
    else if (n(h24.buys) && n(h24.sells)) parts.push(`${fmtInt(h24.buys)} buys vs ${fmtInt(h24.sells)} sells`);
    return {
      read: `${parts.join(", ")}. i can judge this snapshot's flow and liquidity, but entry levels need the candles.`,
      stance: "cautious",
      watch: "whether fresh buyers outnumber sellers with liquidity holding up",
      invalidation: "liquidity getting pulled or volume dying off",
    };
  }
  const out: string[] = [];
  const e20 = t.ema20 !== null ? fmtPrice(t.ema20) : null;
  const e50 = t.ema50 !== null ? fmtPrice(t.ema50) : null;
  const emas = e20 && e50 ? `the ema20 (${e20}) and ema50 (${e50})` : e20 ? `the ema20 (${e20})` : "its moving averages";
  const structure = t.structure === "higher highs and higher lows" ? ", printing higher highs and higher lows"
    : t.structure === "lower highs and lower lows" ? ", still printing lower highs and lower lows" : "";
  if (t.trend === "uptrend") out.push(`${s} is trending up on the 1h — price is above ${emas}${structure}.`);
  else if (t.trend === "downtrend") out.push(`${s} is in a downtrend on the 1h — price is below ${emas}${structure}.`);
  else out.push(`${s} is chopping sideways on the 1h around ${emas}${structure}.`);

  if (t.rsi14 !== null) {
    const r = Number(t.rsi14.toFixed(1));
    const tone = r >= 75 ? "stretched — chasing up here is late" : r >= 60 ? "strong without being overheated" : r >= 45 ? "neutral" : r >= 30 ? "weak" : "washed out, which can bounce but isn't a trend change";
    const high = t.belowHighPct >= 3 ? `, ${fmtPct(t.belowHighPct, false)} under the ${t.hours >= 120 ? "7d" : `${t.hours}h`} high` : ", pressing the top of its range";
    out.push(`rsi ${r} is ${tone}${high}.`);
  }

  const v6 = t.volume6hVsPrior;
  const buyersLead = n(h24.buyers) && n(h24.sellers) ? h24.buyers - h24.sellers : null;
  const flow = n(h24.buyers) && n(h24.sellers) ? `${fmtInt(h24.buyers)} buyers vs ${fmtInt(h24.sellers)} sellers over 24h` : null;
  if (v6 !== null && v6 >= 1.5) out.push(`volume is picking up (last 6h at ${fmtX(v6)} the prior pace)${flow ? `, ${flow}` : ""}.`);
  else if (v6 !== null && v6 <= 0.6) {
    const diverge = t.trend === "uptrend" ? " — the move isn't being backed by fresh volume" : "";
    out.push(`volume is drying up (last 6h at ${fmtX(v6)} the prior pace)${diverge}${flow ? `; ${flow}` : ""}.`);
  } else if (flow) out.push(`participation is steady, ${flow}.`);

  const fdv = n(p.fdvUsd) && p.fdvUsd > 0 ? p.fdvUsd : null;
  const thin = liq > 0 && liq < 25_000;
  if (thin) out.push(`liquidity is thin at ${fmtUsd(liq)}, so size moves it a lot.`);
  else if (fdv && liq > 0 && liq / fdv < 0.03) out.push(`liquidity is light for its size (${fmtUsd(liq)} against a ${fmtUsd(fdv)} fdv).`);
  if (age !== null && age < 48 * 3600) out.push(`it's only ${fmtAge(age)} old, so the chart has little history to lean on.`);

  const s1 = t.supports[0];
  const s2 = t.supports[1];
  const r1 = t.resistances[0];
  const r2 = t.resistances[1];
  const lvl = [
    s1 ? `support sits around ${fmtPrice(s1.price)}${s2 ? `, then ${fmtPrice(s2.price)}` : ""}` : null,
    r1 ? `resistance at ${fmtPrice(r1.price)}${r2 ? `, then ${fmtPrice(r2.price)}` : ""}` : null,
  ].filter(Boolean);
  if (lvl.length) out.push(`${lvl.join("; ")}.`);

  // Stance: a few plain points, said out loud so it can be audited.
  let score = 0;
  score += t.trend === "uptrend" ? 1 : t.trend === "downtrend" ? -1 : 0;
  score += t.structure === "higher highs and higher lows" ? 1 : t.structure === "lower highs and lower lows" ? -1 : 0;
  if (t.rsi14 !== null) score += t.rsi14 >= 78 ? -1 : t.rsi14 <= 25 ? 0.5 : 0;
  if (v6 !== null) score += v6 >= 1.5 && t.trend !== "downtrend" ? 0.5 : v6 <= 0.6 && t.trend === "uptrend" ? -0.5 : 0;
  if (buyersLead !== null) score += buyersLead > 0 ? 0.5 : buyersLead < 0 ? -0.5 : 0;
  if (thin) score -= 2;
  else if (fdv && liq > 0 && liq / fdv < 0.03) score -= 1;
  if (age !== null && age < 24 * 3600) score -= 1;
  const stance: TgDeskStance = score >= 2.5 ? "constructive" : score >= 0.5 ? "neutral" : score >= -1.5 ? "cautious" : "avoid";

  const ema20 = t.ema20 !== null ? fmtPrice(t.ema20) : null;
  const watch = t.trend === "uptrend"
    ? s1 ? `a pullback that holds ${fmtPrice(s1.price)}${ema20 ? ` or the ema20 at ${ema20}` : ""} is the better spot than chasing` : `whether it can hold above ${ema20 ?? "its averages"} on pullbacks`
    : t.trend === "downtrend"
      ? r1 ? `an hourly close back above ${fmtPrice(r1.price)} would be the first sign the selling is done` : "a higher low after the next flush"
      : r1 && s1 ? `which way it leaves the ${fmtPrice(s1.price)}–${fmtPrice(r1.price)} range` : "a break out of the range with volume behind it";
  const invalidation = t.trend === "uptrend"
    ? s1 ? `an hourly close below ${fmtPrice(s1.price)}${t.ema50 !== null ? ` and the ema50 at ${fmtPrice(t.ema50)}` : ""} breaks the trend` : "losing the ema20 with sellers taking over the flow"
    : t.trend === "downtrend"
      ? t.ema50 !== null ? `reclaiming the ema50 at ${fmtPrice(t.ema50)} with volume would flip this` : "a reclaim of the averages with volume would flip this"
      : s1 ? `losing ${fmtPrice(s1.price)} turns the range into a downtrend` : "a breakdown on rising volume";
  return { read: out.join(" "), stance, watch, invalidation };
}

// ── the market ──────────────────────────────────────────────────────────────

export interface MarketCoin {
  symbol: string;
  change24h: number | null;
  change1h: number | null;
  volume24h: number;
  liquidity: number;
  buys24h: number | null;
  sells24h: number | null;
  createdAt: number | null;
}

export interface MarketMeasure {
  coins: MarketCoin[];
  eth: { change24h: number | null; change1h: number | null; price: number | null } | null;
  launches24h: number | null;
  observedAtMs: number;
  nowMs: number;
  /** Feeds that did not settle successfully; they say nothing about activity. */
  missingFeeds?: PoolFeed[];
}

const MIN_LIQ = 20_000;
const MIN_VOL = 10_000;

type MarketMeasured = { ok: true; market: MarketMeasure } | { ok: false; why: "unavailable" };

export async function measureMarket(reads: DeskReads, sayable: Sayable = ANYTHING, budget = new DeskBudget(), onPartial?: (market: MarketMeasure) => void): Promise<MarketMeasured> {
  const unavailable: GeckoFetch = { pools: [], failed: true, failure: "timeout" };
  let trending = unavailable;
  let top = unavailable;
  let fresh = unavailable;
  const settled = () => {
    const m = marketFromFeeds(trending, top, fresh, reads, sayable);
    if (m.ok) onPartial?.(m.market);
  };
  // Each feed has the same absolute deadline. Promise.all alone would let
  // one hung feed hide a complete board already returned by another.
  await Promise.all([
    budget.run((options) => reads.feed("trending_pools", options), unavailable).then((r) => { trending = r; settled(); }),
    budget.run((options) => reads.feed("pools", options), unavailable).then((r) => { top = r; settled(); }),
    budget.run((options) => reads.feed("new_pools", options), unavailable).then((r) => { fresh = r; settled(); }),
  ]);
  return marketFromFeeds(trending, top, fresh, reads, sayable);
}

function marketFromFeeds(trending: GeckoFetch, top: GeckoFetch, fresh: GeckoFetch, reads: DeskReads, sayable: Sayable): MarketMeasured {
  if (trending.failed && top.failed) return { ok: false, why: "unavailable" };
  const all = [...(trending.failed ? [] : trending.pools), ...(top.failed ? [] : top.pools)];
  const byToken = new Map<string, GeckoPool[]>();
  for (const p of all) {
    const list = byToken.get(p.tokenAddress) ?? [];
    if (!list.some((x) => x.poolId === p.poolId)) list.push(p);
    byToken.set(p.tokenAddress, list);
  }
  let eth: MarketMeasure["eth"] = null;
  const coins: MarketCoin[] = [];
  for (const pools of byToken.values()) {
    const best = mainPool(pools)!;
    const { base, quote } = poolSides(best.name);
    if (!base) continue;
    if (QUOTES.has(base.toUpperCase())) {
      if ((base.toUpperCase() === "WETH" || base.toUpperCase() === "ETH") && quote && /^USD/i.test(quote) && !eth) {
        eth = { change24h: best.change24hPct, change1h: best.change1hPct, price: best.priceUsd };
      }
      continue;
    }
    const liquidity = pools.reduce((s, p) => s + (p.reserveUsd ?? 0), 0);
    const volume24h = pools.reduce((s, p) => s + credibleVolume(p), 0);
    if (liquidity < MIN_LIQ || volume24h < MIN_VOL) continue;
    coins.push({
      // Still counted in breadth and volume; just never named.
      symbol: sayable(base) ? base : "unnamed",
      change24h: best.change24hPct,
      change1h: best.change1hPct,
      volume24h,
      liquidity,
      buys24h: pools.every((p) => n(p.buys24h)) ? pools.reduce((s, p) => s + p.buys24h!, 0) : null,
      sells24h: pools.every((p) => n(p.sells24h)) ? pools.reduce((s, p) => s + p.sells24h!, 0) : null,
      createdAt: Math.min(...pools.map((p) => p.createdAt ?? Infinity)),
    });
  }
  if (coins.length < 3) return { ok: false, why: "unavailable" };
  const now = reads.now();
  const launches24h = fresh.failed ? null : fresh.pools.filter((p) => n(p.createdAt) && now / 1000 - p.createdAt <= 86_400 && (p.reserveUsd ?? 0) >= 10_000).length;
  const observed = [trending, top].filter((r) => !r.failed && n(r.observedAt)).map((r) => r.observedAt!);
  const missingFeeds: PoolFeed[] = [];
  if (trending.failed) missingFeeds.push("trending_pools");
  if (top.failed) missingFeeds.push("pools");
  if (fresh.failed) missingFeeds.push("new_pools");
  return { ok: true, market: { coins, eth, launches24h, observedAtMs: observed.length ? Math.min(...observed) : now, nowMs: now, ...(missingFeeds.length ? { missingFeeds } : {}) } };
}

interface MarketStats {
  count: number;
  up24: number;
  median24: number | null;
  up1h: number;
  count1h: number;
  median1h: number | null;
  volume: number;
  top3Share: number | null;
  byVolume: MarketCoin[];
  leaders: MarketCoin[];
  laggards: MarketCoin[];
  buys: number | null;
  sells: number | null;
}

export function marketStats(m: MarketMeasure): MarketStats {
  const with24 = m.coins.filter((c) => n(c.change24h));
  const with1h = m.coins.filter((c) => n(c.change1h));
  const volume = m.coins.reduce((s, c) => s + c.volume24h, 0);
  const byVolume = [...m.coins].sort((a, b) => b.volume24h - a.volume24h);
  const liquid = with24.filter((c) => c.volume24h >= 100_000);
  const movers = (liquid.length >= 6 ? liquid : with24).slice().sort((a, b) => b.change24h! - a.change24h!);
  // FLOW ONLY WHEN EVERY COIN REPORTED IT: a sum over the coins that happened
  // to have counts reads as the board's flow and can flip the stance.
  const complete = m.coins.length > 0 && m.coins.every((c) => n(c.buys24h) && n(c.sells24h));
  return {
    count: m.coins.length,
    up24: with24.filter((c) => c.change24h! > 0).length,
    median24: median(with24.map((c) => c.change24h!)),
    up1h: with1h.filter((c) => c.change1h! > 0).length,
    count1h: with1h.length,
    median1h: median(with1h.map((c) => c.change1h!)),
    volume,
    top3Share: volume > 0 ? (byVolume.slice(0, 3).reduce((s, c) => s + c.volume24h, 0) / volume) * 100 : null,
    byVolume,
    leaders: movers.slice(0, 3),
    laggards: movers.slice(-3).reverse(),
    buys: complete ? m.coins.reduce((s, c) => s + c.buys24h!, 0) : null,
    sells: complete ? m.coins.reduce((s, c) => s + c.sells24h!, 0) : null,
  };
}

export function marketHeader(m: MarketMeasure): string[] {
  const s = marketStats(m);
  const head = [`Robinhood Chain memecoins · ${m.missingFeeds?.length ? "partial 24h snapshot" : "24h"}`];
  const second = [
    `${s.up24}/${s.count} green`,
    s.median24 !== null ? `median ${fmtPct(s.median24)}` : null,
    `vol ${fmtUsd(s.volume)}`,
    m.eth && n(m.eth.change24h) ? `ETH ${fmtPct(m.eth.change24h)}` : null,
  ].filter((x): x is string => x !== null);
  return [head.join(""), second.join(" · ")];
}

export function marketBrief(m: MarketMeasure): string {
  const s = marketStats(m);
  const L: string[] = [];
  const mv = (c: MarketCoin) => `${c.symbol} ${n(c.change24h) ? fmtPct(c.change24h) : "?"} (vol ${fmtUsd(c.volume24h)}, liq ${fmtUsd(c.liquidity)})`;
  L.push(`MARKET: Robinhood Chain memecoins — the ${s.count} ${m.missingFeeds?.length ? "available indexed" : "most active"} coins with at least ${fmtUsd(MIN_LIQ)} liquidity and ${fmtUsd(MIN_VOL)} 24h volume; observed ${utcClock(m.observedAtMs)} UTC`);
  if (m.missingFeeds?.length) L.push(`COVERAGE: partial snapshot; ${m.missingFeeds.map((f) => f === "trending_pools" ? "trending" : f === "pools" ? "top-volume" : "new-pool").join(", ")} feed unavailable. Activity outside the available list is unknown.`);
  L.push(`BREADTH 24h: ${s.up24} of ${s.count} up (${fmtPct((s.up24 / s.count) * 100, false)})${s.median24 !== null ? `; median 24h change ${fmtPct(s.median24)}` : ""}`);
  if (s.count1h) L.push(`BREADTH 1h: ${s.up1h} of ${s.count1h} up (${fmtPct((s.up1h / s.count1h) * 100, false)})${s.median1h !== null ? `; median 1h change ${fmtPct(s.median1h)}` : ""}`);
  L.push(`VOLUME 24h: ${fmtUsd(s.volume)} across these coins${s.top3Share !== null ? `; the top 3 take ${fmtPct(s.top3Share, false)}` : ""}: ${s.byVolume.slice(0, 3).map((c) => `${c.symbol} ${fmtUsd(c.volume24h)}`).join(", ")}`);
  if (s.buys !== null && s.sells !== null && s.sells > 0) L.push(`FLOW 24h (summed over these coins): ${fmtInt(s.buys)} buys vs ${fmtInt(s.sells)} sells (${fmtX(s.buys / s.sells)} buys per sell)`);
  if (m.eth) L.push(`ETH backdrop: WETH${n(m.eth.price) ? ` $${fmtPrice(m.eth.price)}` : ""}${n(m.eth.change24h) ? `, 24h ${fmtPct(m.eth.change24h)}` : ""}${n(m.eth.change1h) ? `, 1h ${fmtPct(m.eth.change1h)}` : ""}`);
  L.push(`LEADERS 24h: ${s.leaders.map(mv).join("; ")}`);
  L.push(`LAGGARDS 24h: ${s.laggards.map(mv).join("; ")}`);
  const deepest = [...m.coins].sort((a, b) => b.liquidity - a.liquidity).slice(0, 3);
  L.push(`DEEPEST LIQUIDITY: ${deepest.map(mv).join("; ")}`);
  if (m.launches24h !== null) L.push(`NEW LAUNCHES: ${m.launches24h} pools created in the last 24h with at least $10k liquidity (from the newest-pools list)`);
  return L.join("\n");
}

export function marketFloor(m: MarketMeasure): TgDeskThought {
  const s = marketStats(m);
  const share = s.up24 / s.count;
  const share1h = s.count1h ? s.up1h / s.count1h : null;
  const ratio = s.buys !== null && s.sells !== null && s.sells > 0 ? s.buys / s.sells : null;
  const out: string[] = [];
  if (m.missingFeeds?.length) out.push("this is a partial market snapshot; some feeds didn't return usable data.");
  const regime = share >= 0.6 && (s.median24 ?? 0) > 0 ? "risk-on" : share <= 0.35 && (s.median24 ?? 0) < 0 ? "risk-off" : "mixed";
  out.push(regime === "risk-on" ? `the market's risk-on: ${s.up24} of the ${s.count} most active coins are green on the day${s.median24 !== null ? `, median ${fmtPct(s.median24)}` : ""}.`
    : regime === "risk-off" ? `it's a red tape: only ${s.up24} of the ${s.count} most active coins are up on the day${s.median24 !== null ? `, median ${fmtPct(s.median24)}` : ""}.`
      : `the market's mixed: ${s.up24} of the ${s.count} most active coins are up on the day${s.median24 !== null ? `, median ${fmtPct(s.median24)}` : ""}.`);
  if (share1h !== null && s.median1h !== null) {
    if (share1h - share >= 0.2) out.push(`the last hour is better than the day — ${s.up1h} of ${s.count1h} green, so buyers are stepping back in.`);
    else if (share - share1h >= 0.2) out.push(`the last hour is worse than the day — only ${s.up1h} of ${s.count1h} green, so momentum is fading.`);
  }
  const leader = s.leaders[0];
  if (s.top3Share !== null && s.top3Share >= 50) out.push(`volume is concentrated: the top 3 take ${fmtPct(s.top3Share, false)} of ${fmtUsd(s.volume)}, led by ${s.byVolume[0]!.symbol}, so it's a few-names market rather than a broad one.`);
  else out.push(`${fmtUsd(s.volume)} traded across them, spread fairly wide${s.byVolume[0] ? ` with ${s.byVolume[0].symbol} leading volume` : ""}.`);
  if (leader && n(leader.change24h)) out.push(`${leader.symbol} leads at ${fmtPct(leader.change24h)}${s.laggards[0] && n(s.laggards[0].change24h) ? ` while ${s.laggards[0].symbol} bleeds ${fmtPct(s.laggards[0].change24h)}` : ""}.`);
  if (ratio !== null) out.push(ratio >= 1.05 ? `buys outnumber sells ${fmtX(ratio)} to one across the board.` : ratio <= 0.95 ? `sells outnumber buys — ${fmtX(ratio)} buys per sell.` : "buys and sells are roughly even.");
  if (m.eth && n(m.eth.change24h) && Math.abs(m.eth.change24h) >= 3) out.push(`eth is ${fmtPct(m.eth.change24h)} on the day, which is dragging the whole chain${m.eth.change24h > 0 ? " up" : " down"}.`);
  const stance: TgDeskStance = regime === "risk-on" ? (ratio !== null && ratio < 0.95 ? "neutral" : "constructive") : regime === "risk-off" ? "cautious" : "neutral";
  return {
    read: out.join(" "),
    stance,
    watch: regime === "risk-off" ? "breadth turning green on the hourly before the day does" : leader ? `whether volume rotates out of ${leader.symbol} into the rest or stays in a few names` : "whether breadth widens past half the board",
    invalidation: regime === "risk-on" ? "breadth rolling over while eth weakens" : regime === "risk-off" ? "a broad green hour with buys leading sells would end the bleed" : "a decisive move in breadth either way",
  };
}
