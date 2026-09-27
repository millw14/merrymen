/**
 * trencher — buying newly launched tokens, and knowing when to leave.
 *
 * WHAT THIS IS NOT. It is not alpha. Nothing in here knows which memecoin goes
 * up, and any code claiming otherwise would be lying to whoever runs it. What it
 * is: a risk FILTER with an exit discipline, over signals that are read from the
 * chain and checkable by anyone — depth, fully diluted value, age, drawdown from
 * entry, and how much liquidity has left since. No provider's score, no
 * "trending" list, nothing a promoter can manufacture.
 *
 * THE ASYMMETRY IS THE DESIGN. Entering requires EVERY condition to hold.
 * Leaving requires only ONE to break. That is deliberate and it is not
 * balanced-looking on purpose: losing money is far easier than making it, the
 * failure modes here are abrupt (liquidity pulled, price gone in one block), and
 * a filter that hesitates on the way out is worse than one that never entered.
 *
 * THE HONEST EXPECTATION. Most tokens this sees will fail its entry filter, and
 * most that pass will still lose money. It is sized by the scout budget for
 * exactly that reason — the budget is the risk control, not the analysis.
 */

import type { PriceQuote } from "../../../packages/core/src/index";
import type { TradeIntent } from "../policy";
import { breakerIdle, type Snapshot, type Strategy, type Tick } from "./types";
import type { Why } from "./reasons";
import type { TrenchBrainOrder } from "../trencher-brain";

/**
 * WHY A CANDIDATE COULD NOT BE PRICED WELL ENOUGH TO OPEN A POSITION.
 *
 * ── A STABLE KIND, NEVER PROSE ───────────────────────────────────────────
 *
 * The obvious way to fix a vague refusal is to carry the pricer's own sentence
 * through to the owner. It is the wrong one here. Those sentences embed a live
 * pool balance and a divergence percentage (`venues/pool-price.ts`), so they
 * change every time anyone trades — and this refusal is emitted per candidate
 * per tick into `events`, which has no dedupe (`addEvent`, store.ts) and no
 * pruning. `index.ts` already settled the same question for the sibling warn:
 * "Key on the refusal KIND, never the prose."
 *
 * So the kind travels, the sentence is written here in advance, and the live
 * figures stay in the rate-limited `[price] refusing to value` warn that
 * already carries them once per change rather than once per tick.
 *
 * ── AND WHY "NOBODY ANSWERED" AND "A QUOTE OF ZERO" ARE SEPARATE MEMBERS ─
 *
 * They are different facts, and folding them together is the one mistake this
 * repo refuses everywhere it counts (see `liquidityUsdg` in
 * packages/core/src/tokens.ts: absence is a real value, never 0). An owner
 * told "its quote came back at zero" about a token no pricer ever looked at
 * would go hunting for a broken pool that does not exist.
 */
export type UnpriceableCause =
  | "no-quote"
  | "stale-price"
  | "zero-price"
  | "curve-priced"
  | "v4-priced"
  | "feed-priced"
  | "unknown-source"
  | "not-watched";

/** The quote fields this needs. Typed from `PriceQuote` so a new SOURCE breaks the build. */
type QuoteEvidence = Pick<PriceQuote, "stale" | "price8" | "source">;

/**
 * The gate and its explanation, from ONE expression.
 *
 * `priceable` was four booleans ANDed at the call site while the refusal was a
 * fixed string in another file, so the two could drift — and they had. That
 * string blamed "the pool guards" both for a token priced perfectly well off a
 * v4 pool and for a token no pricer ever found, which is precisely the
 * confusion `shouldEnter`'s own header says it exists to prevent. Deriving the
 * boolean FROM the cause makes the drift unrepresentable rather than merely
 * fixed.
 *
 * `requirePoolSource` is the CALLER'S POLICY, not a fact about the quote: a v4
 * or curve mark is good enough to VALUE a holding and deliberately not good
 * enough to authorise a new buy — `lastUnpriceable` in index.ts draws the same
 * line for the scout budget, and the two must agree.
 *
 * Returns null when the candidate is priceable.
 */
export function unpriceableCause(
  quote: QuoteEvidence | undefined,
  requirePoolSource: boolean,
): UnpriceableCause | null {
  if (!quote) return "no-quote";
  if (quote.stale) return "stale-price";
  if (quote.price8 <= 0n) return "zero-price";
  if (!requirePoolSource) return null;
  switch (quote.source) {
    case "pool":
      return null;
    case "curve":
      return "curve-priced";
    case "v4":
      return "v4-priced";
    case "chainlink":
    case "broker":
      return "feed-priced";
    default: {
      // A SWITCH RATHER THAN A CATCH-ALL, and this is the reason. An `else` here
      // would classify a future `PriceQuote.source` as a stock feed and tell an
      // owner a DEX quote came from one — the original bug's exact shape, in the
      // one branch no test sweep can reach, because a sweep's alphabet is a copy
      // of the union rather than the union.
      //
      // The `never` makes adding a source a COMPILE error, so somebody has to
      // decide. The return is what happens if one is ever added without that
      // decision reaching here: refuse, and say only what is known.
      const unhandled: never = quote.source;
      void unhandled;
      return "unknown-source";
    }
  }
}

/**
 * The two fields TOGETHER, so a call site cannot set one and forget the other.
 *
 * The pair has two illegal states — priceable with a cause, and unpriceable
 * without one — and both are silent when they happen: the first hides a reason
 * nothing will ever read, the second makes the owner's note say "nobody
 * recorded why" about a tick that knew perfectly well. Neither shows up in a
 * typecheck, so the pair is built in one place and spread at the call sites
 * rather than assembled field by field.
 */
export function priceability(
  quote: QuoteEvidence | undefined,
  requirePoolSource: boolean,
): { priceable: boolean; unpriceable?: UnpriceableCause } {
  const cause = unpriceableCause(quote, requirePoolSource);
  return cause === null ? { priceable: true } : { priceable: false, unpriceable: cause };
}

/**
 * A token the tick was never asked to price, which is not a pricing failure.
 *
 * Its own constant because it is a fact about the WATCH SET rather than about
 * a quote — `unpriceableCause` is handed a quote and must not be able to guess
 * it (see the test that pins exactly that).
 */
export const NOT_WATCHED = { priceable: false, unpriceable: "not-watched" } as const;

/**
 * What the owner actually reads. One sentence per cause, all written here.
 *
 * Short on purpose: the note these land in is prefixed with
 * `trencher: passing on <symbol> — `, and Telegram slices an event at 160
 * characters (`telegram/reads.ts`), so a long sentence loses its own ending —
 * which for a refusal means losing the half that says what happened.
 *
 * Each is a bare fact with no lead-in, because the note already supplies the
 * subject and one em-dash. "passing on CATE — can't be priced — no venue…"
 * reads as two sentences fighting; the siblings below ("only $12,000 deep")
 * set the register.
 */
const UNPRICEABLE_WHY: Record<UnpriceableCause, string> = {
  // "NO USABLE PRICE", not "no venue answered" — the two are different and the
  // absence cannot tell them apart. A token is missing from the tick's quotes
  // both when nothing could be found to price it AND when a pool answered and
  // the answer was refused (too thin, divergent, an extortionate fee). The
  // live case that prompted all this was the second kind: a pool quoted
  // $11,926 against a $25,000 floor. Which of the two it was is in the
  // `[price] refusing to value` warn, which carries the figures once per
  // change; claiming it here would be guessing.
  "no-quote": "no venue gave a usable price this tick",
  "stale-price": "its price stopped updating",
  "zero-price": "its quote came back at zero",
  "curve-priced": "priced off its bonding curve, which has no oracle — enough to value it, not to buy it",
  "v4-priced": "priced off a v4 pool, which has no oracle — enough to value it, not to buy it",
  "feed-priced": "the only price under this symbol is a stock feed, not this token's own market",
  // BOTH AXES, because the check is both. The site tests symbol AND address,
  // and the symbol is the conjunct that fails on the ordinary path: discovery
  // records a token under its on-chain `symbol()` casing, the owner is told to
  // add it, and they type it differently — so a sentence naming only the
  // address is false exactly when the owner could check it and see a token
  // sitting at that address. Vague would have been safer than precisely wrong.
  "not-watched": "no watched token matches that symbol and address",
  "unknown-source": "priced from a source this strategy doesn't know how to judge",
};

/** What the tick knows about a token it might enter. All chain-derived. */
export interface Candidate {
  custodyVault?: `0x${string}`;
  symbol: string;
  token: `0x${string}`;
  decimals: number;
  /** Had pool-grade evidence to OPEN on this tick — see `unpriceableCause`. */
  priceable: boolean;
  /** Why not, when `priceable` is false. Absent means nobody recorded it. */
  unpriceable?: UnpriceableCause;
  /** USD depth of the shallowest leg of its route. */
  liquidityUsd: number;
  /** Fully diluted value — supply × price. NOT float; see token-stats.ts. */
  fdvUsd: number;
  /** Seconds since the pool was initialized. */
  ageSec: number;
  price8: bigint;
  volume24hUsd?: number;
}

/** What we remember about something already held, so exits can be judged. */
export interface OpenPosition {
  custodyVault?: `0x${string}`;
  symbol: string;
  token: `0x${string}`;
  entryPrice8: bigint;
  /** Depth at the moment of entry — the baseline a drain is measured against. */
  entryLiquidityUsd: number;
  entrySec: number;
  costUsdg: bigint;
  /**
   * Raw quantity from the cost-basis ledger.
   *
   * Needed because an exit sometimes has to be sized WITHOUT a priced holding:
   * a position nobody can value this tick is absent from snap.holdings, and
   * that is precisely the position most urgent to leave.
   */
  qtyRaw: bigint;
}

export interface TrencherConfig {
  /** Per-entry size, USDG (6dp). Bounded again by the scout budget upstream. */
  perEntryUsdg: bigint;
  /** Refuse anything thinner than this at entry. */
  minLiquidityUsd: number;
  /** FDV band. Below the floor there's nothing there; above the ceiling a new
   *  launch's "value" is usually supply games rather than money. */
  minFdvUsd: number;
  maxFdvUsd: number;
  /** Ignore the first minutes — the window where anything can happen and does. */
  minAgeSec: number;
  /** After this it isn't a new pair; if it's still interesting, add it properly. */
  maxAgeSec: number;
  /** Exit if price falls this far below entry, in bps. */
  stopLossBps: number;
  /** Exit if price rises this far above entry, in bps. */
  takeProfitBps: number;
  /** Exit if depth falls to this fraction of what it was at entry. */
  liquidityDrainFraction: number;
  /** Exit regardless after this long — a trench position isn't an investment. */
  maxHoldSec: number;
}

export const TRENCHER_DEFAULTS: TrencherConfig = {
  perEntryUsdg: 5_000_000n, // $5
  minLiquidityUsd: 25_000,
  minFdvUsd: 50_000,
  maxFdvUsd: 5_000_000,
  minAgeSec: 10 * 60,
  maxAgeSec: 24 * 3600,
  stopLossBps: 3_500, // -35%
  takeProfitBps: 10_000, // +100%
  liquidityDrainFraction: 0.5,
  maxHoldSec: 3 * 24 * 3600,
};

export type EntryVerdict = { enter: true } | { enter: false; why: string };

/** Faster exits without relaxing entry quality or increasing position size. */
export const TRENCHER_FAST: TrencherConfig = {
  ...TRENCHER_DEFAULTS,
  stopLossBps: 1_000,
  takeProfitBps: 2_000,
  maxHoldSec: 30 * 60,
  // Active older memecoins are eligible too; volume, depth and price still gate entry.
  maxAgeSec: Number.MAX_SAFE_INTEGER,
  // Volume-led trading includes established memecoins, not only small launches.
  maxFdvUsd: Number.POSITIVE_INFINITY,
};

/**
 * Should this be entered? EVERY condition must hold.
 *
 * Each refusal names itself, because "no trade" with no reason is ind/
 * distinguishable from a broken feed, and the owner needs to be able to tell
 * "nothing qualified" from "nothing was checked".
 */
export function shouldEnter(c: Candidate, cfg: TrencherConfig, nowSec: number): EntryVerdict {
  if (![c.liquidityUsd, c.fdvUsd, c.ageSec].every(Number.isFinite)) {
    return { enter: false, why: "incomplete market data" };
  }
  // An UNSET cause reads as "nobody recorded why", never as "there is no
  // reason". The field is optional so that a caller written before it existed
  // still refuses — it must not be able to claim an explanation it never had.
  if (!c.priceable) {
    return { enter: false, why: c.unpriceable ? UNPRICEABLE_WHY[c.unpriceable] : "can't be priced — nobody recorded why" };
  }
  if (c.liquidityUsd < cfg.minLiquidityUsd) {
    return { enter: false, why: `only $${Math.round(c.liquidityUsd).toLocaleString()} deep` };
  }
  if (c.fdvUsd < cfg.minFdvUsd) {
    return { enter: false, why: `FDV $${Math.round(c.fdvUsd).toLocaleString()} — nothing there yet` };
  }
  if (c.fdvUsd > cfg.maxFdvUsd) {
    return { enter: false, why: `FDV $${Math.round(c.fdvUsd).toLocaleString()} — priced past a new launch` };
  }
  if (c.ageSec < cfg.minAgeSec) {
    return { enter: false, why: `only ${Math.round(c.ageSec / 60)}m old — too early to read` };
  }
  if (c.ageSec > cfg.maxAgeSec) {
    return { enter: false, why: `${Math.round(c.ageSec / 3600)}h old — not a new pair any more` };
  }
  return { enter: true };
}

/**
 * `cause` and `pct` ride alongside `why` so the public feed can render a
 * sentence of its own from the CODE rather than quoting this one. The string
 * stays exactly as it is — it is what the owner reads in their notes.
 */
export type ExitCause = "unpriceable" | "drain" | "stop" | "take" | "aged";
export type ExitVerdict =
  | { exit: false }
  | { exit: true; why: string; cause: ExitCause; pct?: number };

/**
 * Should this be closed? ANY condition is enough.
 *
 * Ordered by how badly it ends: an unpriceable or drained position is a position
 * that may not be exitable at all in an hour, so those are checked before the
 * ordinary stop.
 */
export function shouldExit(
  pos: OpenPosition,
  now: { price8: bigint | null; liquidityUsd: number | null; nowSec: number },
  cfg: TrencherConfig,
): ExitVerdict {
  // Can't price it any more. Whatever happened, the window to leave is closing.
  if (now.price8 === null || now.price8 <= 0n) {
    return { exit: true, why: "can't be priced any more — leaving while there's still a route", cause: "unpriceable" };
  }
  // Liquidity walking out is the shape a rug actually takes, and it precedes
  // the price move rather than following it.
  if (
    now.liquidityUsd !== null &&
    pos.entryLiquidityUsd > 0 &&
    now.liquidityUsd < pos.entryLiquidityUsd * cfg.liquidityDrainFraction
  ) {
    const pct = Math.round((1 - now.liquidityUsd / pos.entryLiquidityUsd) * 100);
    return { exit: true, why: `${pct}% of the liquidity has left since entry`, cause: "drain", pct };
  }
  const bps = priceMoveBps(pos.entryPrice8, now.price8);
  if (bps <= -cfg.stopLossBps) return { exit: true, why: `down ${Math.abs(bps / 100).toFixed(1)}% from entry`, cause: "stop", pct: bps / 100 };
  if (bps >= cfg.takeProfitBps) return { exit: true, why: `up ${(bps / 100).toFixed(1)}% from entry`, cause: "take", pct: bps / 100 };
  if (now.nowSec - pos.entrySec > cfg.maxHoldSec) {
    return { exit: true, why: `held ${Math.round((now.nowSec - pos.entrySec) / 3600)}h — past the window`, cause: "aged" };
  }
  return { exit: false };
}

/** Signed move from entry to now, in bps. Negative = down. */
export function priceMoveBps(entry8: bigint, now8: bigint): number {
  if (entry8 <= 0n) return 0;
  return Number(((now8 - entry8) * 10_000n) / entry8);
}

/** A remainder worth less than this (USDG, 6dp) is not left behind: $0.10. */
export const DUST_REMAINDER_USDG = 100_000n;
/** …nor one under this share of the position: 1%. */
export const DUST_REMAINDER_BPS = 100n;

/**
 * HOW MUCH OF A POSITION ONE EXIT SELLS — and never a leftover.
 *
 * A Brain exit names a dollar size, and the old arithmetic sold exactly that
 * share: `raw * notional / available`. The Brain sizes a sell a hair under the
 * position's value as often as not, so Shogun sold 13,300.78 of 13,306.85
 * musebook and left 6.06 behind — 0.05% of the position, worth $0.002. The
 * next exit sold that for a fraction of a cent: a whole operation, a trade ping
 * reading "0.00", and a P&L card of "-6.5% · 0.00 · 0.00 · 0.00".
 *
 * So a partial that would leave under 1% of the position, or under $0.10, is
 * a whole exit instead. A deliberate trim — half, a third — still leaves what
 * it meant to. A rule exit (`forced`) always sells everything, as before.
 *
 * Pure: `raw` is the quantity held, `available` its value and `notional` the
 * value the exit asked for, both USDG 6dp. Returns what to sell and the value
 * that stands for.
 */
export function exitSize(
  raw: bigint,
  available: bigint,
  notional: bigint,
  forced: boolean,
): { amount: bigint; notional: bigint } {
  if (forced) return { amount: raw, notional };
  if (available <= 0n || raw <= 0n) return { amount: 0n, notional };
  const asked = notional < available ? notional : available;
  const left = available - asked;
  if (left < DUST_REMAINDER_USDG || left * 10_000n < available * DUST_REMAINDER_BPS) {
    return { amount: raw, notional: available };
  }
  return { amount: (raw * asked) / available, notional: asked };
}

/**
 * Was the holding a buy lands on only dust — worth under one micro-USDG at the
 * buy's own fill price? The Trencher never adds to a real position, so a buy
 * onto dust is a fresh entry and must not inherit the old entry's clock: the
 * stale `entry_sec` would read a brand-new position as hours old and sell it on
 * the next tick as past its window. Priced from the fill itself, so no lookup
 * can disagree with it.
 */
export function buysOntoDust(prevQtyRaw: bigint, fillQtyRaw: bigint, fillCashUsdg: bigint): boolean {
  if (prevQtyRaw <= 0n || fillQtyRaw <= 0n || fillCashUsdg <= 0n) return false;
  return (prevQtyRaw * fillCashUsdg) / fillQtyRaw <= 0n;
}

export interface TrencherDeps {
  /** When required, no rule-based entry may bypass a fresh Brain approval. */
  brainRequired?: boolean;
  brainOrder?: (symbol: string, token: string, price8: bigint, held: boolean) => TrenchBrainOrder | null;
  cfg: TrencherConfig;
  swapRouter: `0x${string}`;
  usdgToken: `0x${string}`;
  /** Candidates the discovery pass surfaced and the tick could price. */
  candidates: () => readonly Candidate[] | Promise<readonly Candidate[]>;
  /** What's currently held from previous entries. */
  open: () => readonly OpenPosition[] | Promise<readonly OpenPosition[]>;
  /** Live depth for a held token, when it's still readable. */
  liquidityOf: (token: `0x${string}`) => number | null;
  /**
   * Symbols HELD but which produced no price this tick.
   *
   * Passed in rather than inferred from absence, because absence from
   * snap.holdings has two causes -- unpriceable, or the ledger drifting from
   * the chain -- and only one of them should trigger a sell.
   */
  unpriceable?: () => ReadonlySet<string>;
  onNote?: (level: "ok" | "warn", message: string) => void;
}

/**
 * EXITS ARE EVALUATED FIRST, AND UNCONDITIONALLY.
 *
 * Not a style choice. Entries consume the daily budget and the ops cap, so an
 * entry-first pass can spend the very allowance a stop-loss needed a moment
 * later — the agent buys its way out of being able to sell. Getting out is
 * always more urgent than getting in.
 */
export function makeTrencher(deps: TrencherDeps): Strategy {
  return {
    name: "trencher",
    async tick(snap: Snapshot): Promise<Tick> {
      const nowSec = Math.floor(Date.now() / 1000);
      const intents: TradeIntent[] = [];
      const why: (Why | null)[] = [];
      if (!snap.sequencerUp) return { intents, why };

      // ── exits first, always ────────────────────────────────────────────
      const openNow = await deps.open();
      const unpriceable = deps.unpriceable?.() ?? new Set<string>();
      // Positions whose whole priced value rounds to nothing (see below).
      const dust = new Set<string>();
      for (const pos of openNow) {
        const held = snap.holdings.get(pos.symbol);
        // A HELD-BUT-UNPRICEABLE position is the case this loop used to drop,
        // and it is the one shouldExit's first branch was written for. Such a
        // position is absent from snap.holdings — readPositions only reports
        // what it could value — so `if (!held) continue` made that branch
        // unreachable, and the exit designed for "the venue went dark" could
        // never fire. The ledger still knows the quantity, which is enough to
        // sell.
        const stillUnpriceable = unpriceable.has(pos.symbol);
        if (!held || held.rawBalance <= 0n) {
          if (!stillUnpriceable || pos.qtyRaw <= 0n) continue;
        }
        const raw = pos.custodyVault ? pos.qtyRaw : held?.rawBalance ?? pos.qtyRaw;
        const available = held && pos.custodyVault && held.rawBalance > 0n ? held.valueUsdg * raw / held.rawBalance : held?.valueUsdg ?? pos.costUsdg;
        // A PRICED SLIVER WORTH NOTHING IS NOT A POSITION. A sell sized at 0 USDG
        // is refused by the wall as `non-positive`, and the next tick asks again:
        // measured 2026-09-25, a 4e13-raw DELTA remainder valued at 0 USDG was
        // re-proposed every ~15s for 29 hours, and because it still counted as
        // held, the desk could not re-enter DELTA — its only candidate — for the
        // whole of it. Nothing is lost by not selling it: there is no cash in it.
        // Unpriceable positions are untouched — "no price" is not "worth zero".
        if (held && held.rawBalance > 0n && !stillUnpriceable && available <= 0n) {
          dust.add(pos.symbol);
          continue;
        }
        const quote = snap.prices.get(pos.symbol);
        const verdict = shouldExit(
          pos,
          {
            price8: stillUnpriceable ? null : (quote?.price8 ?? null),
            liquidityUsd: deps.liquidityOf(pos.token),
            nowSec,
          },
          deps.cfg,
        );
        const brain = !verdict.exit && quote && !quote.stale ? deps.brainOrder?.(pos.symbol, pos.token, quote.price8, true) : null;
        if (!verdict.exit && brain?.side !== "sell") continue;
        const brainNotional = brain ? BigInt(Math.round(brain.usdgAmount * 1e6)) : available;
        // Never a leftover: a partial that would strand a sliver sells it all (exitSize).
        const { amount, notional } = exitSize(raw, available, brainNotional < available ? brainNotional : available, verdict.exit);
        if (amount <= 0n) continue;
        deps.onNote?.("warn", `trencher: selling ${pos.symbol} — ${verdict.exit ? verdict.why : "Brain exit"}`);
        intents.push({
          ...(brain ? { decisionId: brain.decisionId } : {}),
          kind: "swap",
          target: pos.custodyVault ?? deps.swapRouter,
          ...(pos.custodyVault ? {custody:"trencher" as const} : {}),
          sellToken: pos.token,
          buyToken: deps.usdgToken,
          // The whole position, or a deliberate part of it — never a sliver
          // (exitSize). From the ledger when there is no priced holding to
          // read it from.
          sellAmountRaw: amount,
          // Cost is the honest stand-in for a position with no mark — the same
          // substitution quarantine makes when it carries an unvaluable
          // holding into equity at what was paid for it.
          notionalUsdg: notional,
        });
        why.push(verdict.exit ? {
          code: "trench-exit",
          symbol: pos.symbol,
          cause: verdict.cause,
          pct: verdict.pct,
        } : null);
      }

      // ── no entries at all while the drawdown breaker is tripped ─────────
      //
      // The wall refuses every one of them, so each was a refusal a tick — and,
      // with the Brain required, a paid review of a coin it would never be
      // allowed to buy. Seen on the live feed: thirty refused buys in fifteen
      // minutes, each in fresh model words. So the candidates are not read and
      // the Brain is not asked; exits above ran first and are untouched.
      const brake = breakerIdle(snap);
      if (brake) return intents.length === 0 ? { intents, why, idle: brake } : { intents, why };

      // ── entries, only with what's left ─────────────────────────────────
      const heldSymbols = new Set(openNow.map((p) => p.symbol).filter((s) => !dust.has(s)));
      for (const c of await deps.candidates()) {
        if (heldSymbols.has(c.symbol)) continue;
        if (snap.pausedTokens.has(c.token.toLowerCase())) continue;
        let size = deps.cfg.perEntryUsdg;
        // Respect the daily headroom as a sizing hint, exactly as other
        // strategies do — the wall still refuses anything over, this just stops
        // the same oversized intent being re-proposed every tick forever.
        if (!deps.brainRequired && (size > snap.spendHeadroomUsdg || size > snap.perTradeCapUsdg)) continue;
        const verdict = shouldEnter(c, deps.cfg, nowSec);
        if (!verdict.enter) {
          deps.onNote?.("ok", `trencher: passing on ${c.symbol} — ${verdict.why}`);
          continue;
        }
        const brain = deps.brainRequired ? deps.brainOrder?.(c.symbol, c.token, c.price8, false) : null;
        if (deps.brainRequired) {
          if (brain?.side !== "buy" || !Number.isFinite(brain.usdgAmount) || brain.usdgAmount <= 0) continue;
          const approved = BigInt(Math.floor(brain.usdgAmount * 1e6));
          if (approved < size) size = approved;
          if (size <= 0n || size > snap.spendHeadroomUsdg || size > snap.perTradeCapUsdg) continue;
        }
        deps.onNote?.(
          "ok",
          `trencher: entering ${c.symbol} — $${Math.round(c.liquidityUsd).toLocaleString()} deep, ` +
            `FDV $${Math.round(c.fdvUsd).toLocaleString()}, ${Math.round(c.ageSec / 60)}m old`,
        );
        intents.push({
          ...(brain ? { decisionId: brain.decisionId } : {}),
          kind: "swap",
          target: c.custodyVault ?? deps.swapRouter,
          ...(c.custodyVault ? {custody:"trencher" as const} : {}),
          sellToken: deps.usdgToken,
          buyToken: c.token,
          sellAmountRaw: size,
          notionalUsdg: size,
        });
        why.push({
          code: "trench-enter",
          symbol: c.symbol,
          liqUsd: c.liquidityUsd,
          fdvUsd: c.fdvUsd,
          ageSec: c.ageSec,
          usdgRaw: size,
        });
        // One entry per tick. A discovery burst shouldn't become a burst of
        // simultaneous positions in tokens that all launched from the same
        // deployer minutes apart.
        break;
      }

      return { intents, why };
    },
  };
}
