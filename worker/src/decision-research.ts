import { CASH } from "../../packages/core/src/index";
import { tradeFeeUsdg } from "./fees";
import type { TrencherConfig } from "./strategies/trencher";
import { breakEvenRate, realisedStopBps } from "./strategy-terms";
import type { PoolFacts } from "./trencher-discovery";
import { FEE_TIERS, pickBestQuote, quotePath, quoteTier, type Quote } from "./venues/uniswap";
import type { Address, PublicClient } from "viem";

/** Operator opt-in for extra evidence, never an execution permission. */
export function decisionResearchEnabledFor(account: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const address = /^0x[0-9a-f]{40}$/i;
  if (!address.test(account) || /^0x0{40}$/i.test(account)) return false;
  return (env.MERRYMEN_DECISION_RESEARCH_ACCOUNTS ?? "").split(/[\s,]+/)
    .some(value => address.test(value) && value.toLowerCase() === account.toLowerCase());
}

/**
 * The allowlist, said once at boot. Smart-account addresses are public; an
 * entry that is not one is counted by position, never echoed.
 */
export function decisionResearchBootLine(env: NodeJS.ProcessEnv = process.env): string {
  const address = /^0x[0-9a-f]{40}$/i;
  const values = (env.MERRYMEN_DECISION_RESEARCH_ACCOUNTS ?? "").split(/[\s,]+/).filter(Boolean);
  const accounts = values.filter(v => address.test(v) && !/^0x0{40}$/i.test(v));
  const ignored = values.length - accounts.length;
  if (!accounts.length) return `decision research: nobody${ignored ? ` (${ignored} entr${ignored === 1 ? "y is" : "ies are"} not an address)` : ""}`;
  return `decision research: ${accounts.length} account(s) — ${accounts.join(", ")}` +
    (ignored ? `; ${ignored} entr${ignored === 1 ? "y is" : "ies are"} not an address` : "");
}

/** Quote the existing strategy ceiling, including any smaller signed or early-entry bound. */
export function researchEntrySize(bounds: readonly bigint[]): bigint {
  const size = bounds.length ? bounds.reduce((a, b) => a < b ? a : b) : 0n;
  return size > 0n ? size : 0n;
}

export const DECISION_RESEARCH_GUIDANCE = "Before buying, explain the supplied evidence for demand, the strongest contrary evidence, what would invalidate the thesis, and why the expected move could cover a full entry and exit at the quoted size. An unavailable quote or cost is unknown, never zero. Historical outcomes are a small descriptive sample, not a calibrated probability or proof of future returns. Do not increase size, loosen limits or delay protective exits to recover a loss.";

type Route = { tokens: readonly Address[]; fees: readonly number[] };
type QuoteReader = (route: Route, amountIn: bigint) => Promise<Quote | null>;
const unavailable = "Entry and exit quote evidence unavailable; trading costs and exit liquidity have not been established by this read.";

type CostArgs = {
  client: PublicClient;
  token: Address;
  facts: PoolFacts | undefined;
  sizeUsdg: bigint;
  gasPerOperationUsdg: bigint | null;
  tradeFeeBps: number;
};
type CostDeps = { quote?: QuoteReader; now?: () => number; budgetMs?: number };

/**
 * The same research as `entryCostEvidence`, with the figures it printed: what
 * went in, what the reverse quote gave back and the total drag, micro-USDG.
 * `back` and `drag` are null whenever the text says unavailable or unknown —
 * the numbers can never say more than the sentence does.
 */
export type EntryCostResearch = { text: string; sizeUsdg: bigint; backUsdg: bigint | null; dragUsdg: bigint | null };

/**
 * Read-only quotes of a factory-verified v3 route and its reverse. Two independent
 * state reads are research, not a simulated round trip, approval, or guaranteed fill.
 * A slow lookup cannot block the tick or change a review after its deadline.
 */
export async function entryCostEvidence(args: CostArgs, deps: CostDeps = {}): Promise<string> {
  return (await entryCostResearch(args, deps)).text;
}

export async function entryCostResearch(args: CostArgs, deps: CostDeps = {}): Promise<EntryCostResearch> {
  const none = { text: unavailable, sizeUsdg: args.sizeUsdg, backUsdg: null, dragUsdg: null };
  const now = deps.now ?? Date.now;
  const start = now();
  const deadline = start + (deps.budgetMs ?? 5000);
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const { facts, token, sizeUsdg: size } = args;
  if (!facts || size <= 0n || size > BigInt(Number.MAX_SAFE_INTEGER) ||
      !Number.isInteger(facts.fee) || facts.fee < 0 || facts.fee >= 1_000_000 ||
      !Number.isInteger(args.tradeFeeBps) || args.tradeFeeBps < 0 || args.tradeFeeBps >= 10_000) return none;
  if (same(facts.token0, token) === same(facts.token1, token)) return none;
  const other = same(facts.token0, token) ? facts.token1 : facts.token0;
  const routes: Route[] = same(other, CASH.USDG)
    ? [{ tokens: [CASH.USDG, token], fees: [facts.fee] }]
    : same(other, CASH.WETH)
      ? FEE_TIERS.map(fee => ({ tokens: [CASH.USDG, CASH.WETH, token], fees: [fee, facts.fee] }))
      : [];
  if (!routes.length) return none;
  const read: QuoteReader = deps.quote ?? (async (route, amountIn) => route.tokens.length === 2
    ? quoteTier(args.client, { tokenIn: route.tokens[0]!, tokenOut: route.tokens[1]!, fee: route.fees[0]!, amountIn })
    : quotePath(args.client, { ...route, amountIn }));
  const safeRead: QuoteReader = async (route, amountIn) => {
    if (now() >= deadline) return null;
    try { return await read(route, amountIn); } catch { return null; }
  };
  const job = async (): Promise<EntryCostResearch> => {
    const quotes = await Promise.all(routes.map(route => safeRead(route, size)));
    const buy = pickBestQuote(quotes);
    if (!buy || now() >= deadline) return none;
    const route = routes[quotes.indexOf(buy)]!;
    const sell = await safeRead({ tokens: [...route.tokens].reverse(), fees: [...route.fees].reverse() }, buy.amountOut);
    if (!sell || sell.amountOut <= 0n || sell.amountOut > BigInt(Number.MAX_SAFE_INTEGER) || now() >= deadline) return none;
    const fee = tradeFeeUsdg(size, args.tradeFeeBps) + tradeFeeUsdg(sell.amountOut, args.tradeFeeBps);
    const gas = args.gasPerOperationUsdg !== null && args.gasPerOperationUsdg >= 0n
      ? args.gasPerOperationUsdg * 2n : null;
    const cash = (n: bigint) => (Number(n) / 1e6).toFixed(6);
    const drag = gas === null ? null : size - sell.amountOut + fee + gas;
    const text = `Entry/exit research at ${new Date(start).toISOString()}: ${cash(size)} USDG in; ` +
      `selling the quoted token output on the reverse v3 route quotes ${cash(sell.amountOut)} USDG back. ` +
      `Venue fees and price impact are already in those quotes. Estimated turnover fees for both legs: ${cash(fee)} USDG; ` +
      `gas for two operations: ${gas === null ? "unknown" : `${cash(gas)} USDG (estimate)`}. ` +
      (drag === null ? "Total round-trip drag is unknown. " : `Illustrative round-trip drag: ${cash(drag)} USDG (${(Number(drag) / Number(size) * 100).toFixed(2)}% of entry). `) +
      "Quotes use independent current-state reads, not a sequential transaction simulation. Excludes future price movement, additional slippage, first-deployment costs and account-level performance fees. This is cost evidence, not expected profit, a guaranteed exit, or permission to trade.";
    return { text, sizeUsdg: size, backUsdg: sell.amountOut, dragUsdg: drag };
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([job(), new Promise<EntryCostResearch>(resolve => {
      timer = setTimeout(() => resolve(none), Math.max(1, deadline - now()));
    })]);
  } catch { return none; }
  finally { if (timer) clearTimeout(timer); }
}

/**
 * WHAT A ROUND TRIP COSTS, AND WHAT EACH BRACKET OUTCOME STILL PAYS.
 *
 * The Trencher's brackets are measured from the AVERAGE FILL PRICE (cost over
 * tokens received, index.ts trenchOpen), which already carries the entry
 * leg's venue fee and price impact. What an exit pays beyond the move is the
 * rest: the exit leg's venue fee and impact, both turnover fees (accrued on
 * notional, outside the cost basis: fees.ts) and gas for both operations.
 *
 * `roundTripPct` is the whole round trip over the entry; `bracketCostPct` is
 * that remainder, which is also the rise above the fill that breaks even.
 *
 * QUOTED only when the quotes are sane: no more USDG back than went in, and a
 * drag at least the gas-and-fee floor. Otherwise (an anomalous quote, or no
 * gas in it) the FLOOR when gas is known: gas and turnover fees only, venue
 * friction not quoted. Otherwise unknown. Two quotes cannot tell the legs'
 * venue friction apart, so the exit leg is taken as half of it — an
 * assumption the brief states. Never negative.
 */
export type BreakEven =
  | { basis: "quoted"; roundTripPct: number; bracketCostPct: number }
  | { basis: "gas-and-fees"; roundTripPct: number; bracketCostPct: number }
  | { basis: "unknown" };

export function trenchBreakEven(
  cost: Pick<EntryCostResearch, "sizeUsdg" | "backUsdg" | "dragUsdg"> | null,
  fallback: { sizeUsdg: bigint; gasPerOperationUsdg: bigint | null; tradeFeeBps: number },
): BreakEven {
  const pct = (n: bigint, d: bigint) => Math.max(0, Number(n) / Number(d) * 100);
  const { gasPerOperationUsdg: gas, tradeFeeBps: bps } = fallback;
  if (gas === null || gas < 0n || !Number.isInteger(bps) || bps < 0 || bps >= 10_000) return { basis: "unknown" };
  const floorOf = (size: bigint) => gas * 2n + tradeFeeUsdg(size, bps) * 2n;
  if (cost && cost.sizeUsdg > 0n && cost.backUsdg !== null && cost.backUsdg > 0n && cost.dragUsdg !== null &&
      cost.backUsdg <= cost.sizeUsdg && cost.dragUsdg >= floorOf(cost.sizeUsdg)) {
    const entryLeg = (cost.sizeUsdg - cost.backUsdg) / 2n;
    return { basis: "quoted", roundTripPct: pct(cost.dragUsdg, cost.sizeUsdg), bracketCostPct: pct(cost.dragUsdg - entryLeg, cost.sizeUsdg) };
  }
  if (fallback.sizeUsdg > 0n) {
    const floor = pct(floorOf(fallback.sizeUsdg), fallback.sizeUsdg);
    return { basis: "gas-and-fees", roundTripPct: floor, bracketCostPct: floor };
  }
  return { basis: "unknown" };
}

/**
 * THE TRENCHER'S OWN TERMS, PUT TO THE BRAIN — for research-enabled accounts,
 * entry reviews only (index.ts appends it to the strategy brief, which every
 * analyst and the manager read).
 *
 * WHY. The Brain was asked to judge a minutes-long momentum entry with no
 * horizon, no exit plan and no cost line, told not to invent an expected
 * return, and then made to state one (`expected_edge_usdg`). HOLD was the
 * only answer that did not require a number from nowhere. This gives it the
 * number's ingredients instead: the mechanical exits (read from the strategy
 * config, never restated by hand), what each exit pays beyond the move
 * (trenchBreakEven), the bracket arithmetic that turns odds into edge, and
 * what continuation and distribution look like over minutes. It claims
 * nothing about where a time-stopped exit usually lands: that is unmeasured.
 *
 * WHAT IT DOES NOT DO. It changes no cap, floor, guard, gate or exit; the
 * persona's disqualifiers and every check after the review are untouched,
 * and it says so. It does not tell the model to buy: the odds are its call.
 */
export function trenchMomentumBrief(
  cfg: Pick<TrencherConfig, "stopLossBps" | "takeProfitBps" | "maxHoldSec" | "liquidityDrainFraction">,
  be: BreakEven,
  entryUsdg: bigint,
): string {
  const stop = cfg.stopLossBps / 100, take = cfg.takeProfitBps / 100;
  // THE DESK POLICY'S OWN `s` (strategy-terms.ts): the trigger, and a realised
  // stop half again past it. A stop is a trigger, not a fill, so the trigger's
  // bar is a floor and the loss side is never priced at it.
  const realised = realisedStopBps(cfg.stopLossBps) / 100;
  const minutes = Math.round(cfg.maxHoldSec / 60);
  const drain = Math.round((1 - cfg.liquidityDrainFraction) * 100);
  // Fixed decimals with trailing zeros dropped: 10, 3.29, 44 — never "1" for 10.
  const n = (v: number, dp: number) => {
    const s = v.toFixed(dp);
    return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
  };
  const entry = (Number(entryUsdg) / 1e6).toFixed(2);
  // c: what each exit pays beyond the fill, which is also the rise above the
  // fill that breaks even (trenchBreakEven) — the desk policy's c.
  const cost = be.basis === "quoted"
    ? `A round trip at ${entry} USDG costs about ${n(be.roundTripPct, 2)}% (quoted). c, each exit's cost beyond the fill, ` +
      `is about ${n(be.bracketCostPct, 2)}% (exit leg's half of the venue friction, both fees, gas both ways).`
    : be.basis === "gas-and-fees"
      ? `A round trip at ${entry} USDG costs at least ${n(be.roundTripPct, 2)}% in gas and turnover fees (venue fee and impact not quoted). ` +
        "c, each exit's cost beyond the fill, is at least that."
      : "The cost c could not be priced; treat a marginal setup as insufficient.";
  const c = be.basis === "unknown" ? null : be.bracketCostPct;
  // The odds at which the bracket breaks even (breakEvenRate, the desk
  // policy's formula), at the trigger and at the realised stop. At or past 1
  // the take-profit cannot pay the cost whatever s is, and no threshold is
  // printed as if it could.
  const bar = (s: number) => n(Math.min(99, 100 * breakEvenRate(s, c ?? 0, take)), 0);
  const at = `${bar(stop)}% at s = ${n(stop, 2)}, ${bar(realised)}% at s = ${n(realised, 2)}`;
  const p = c === null ? null : breakEvenRate(stop, c, take);
  const odds = p === null
    ? `positive only when P is clearly above ${at}, plus the unknown cost`
    : p >= 1
      ? "and no odds make it positive: the take-profit cannot cover c at this size"
      : `positive only when P is above ${be.basis === "gas-and-fees" ? "at least " : ""}about ${at}`;
  return `MOMENTUM ENTRY PLAN. Horizon: minutes, not days. Exits are triggers checked per tick, sold at market: ` +
    `stop -${n(stop, 2)}%, take +${n(take, 2)}%, close at ${minutes} minutes, or early if ${drain}% of entry liquidity drains. ` +
    "Brackets run from your average fill, which includes the entry leg's venue cost. " +
    `${cost} Judge against these brackets, not an invented target: with P your odds of +${n(take, 2)}% before the stop ` +
    `and s your average realised stop-out loss (${n(stop, 2)} at best, never priced at the trigger), ` +
    `the edge is about P x (${n(take, 2)} - c)% - (1 - P) x (s + c)%, ${odds}; ` +
    `a time-stopped exit takes the ${minutes}-minute mark, less c. ` +
    "Reason P from flow; give that estimate at entry size as expected_edge_usdg. " +
    "Continuation: buyers and buy share rising from 1h to 5m, higher 5-minute lows, volume expanding with price, liquidity holding. " +
    "Distribution: sellers dominating recent windows, one sender doing most of a material sell flow (may be a router or bundler), lower highs, draining liquidity, overextension after a vertical spike. " +
    "Missing news, fundamentals or social-media data is not by itself a reason to hold here; decide on flow, liquidity, cost and these exits. " +
    "All checks above still apply.";
}
