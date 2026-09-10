/**
 * Steady Basket — Phase 1's deterministic strategy. No LLM anywhere.
 * DCA a fixed USDG amount into a weighted stock-token basket on a schedule,
 * park idle USDG in the Morpho Steakhouse vault between buys.
 *
 * A Strategy NEVER executes anything. It reads a snapshot and returns intents;
 * the runner pushes each intent through checkPolicy → simulate → execute.
 */

import type { TradeIntent } from "../policy";
import type { CurveLeg } from "../strategist/proposals";
import {
  curveBuyImpactBps,
  curveBuyOut,
  curveGraduated,
  curveMinOut,
} from "../venues/pons-price";
import type { Snapshot, Tick } from "./types";
import type { Why } from "./reasons";

export type { Snapshot };

export interface BasketLeg {
  symbol: string;
  token: `0x${string}`;
  weightBps: number; // sums to 10_000 across legs
}

export interface SteadyBasketConfig {
  legs: BasketLeg[];
  buyPerTickUsdg: bigint;
  /** Idle USDG above this floor gets deposited to the vault. */
  idleFloorUsdg: bigint;
  /** Venue-agnostic: Rialto meta-router or Uniswap SwapRouter02, runner's pick. */
  swapRouter: `0x${string}`;
  vault: `0x${string}`;
  usdg: `0x${string}`;
  /**
   * THE ALWAYS-ON SIDE OF THE CHAIN, for when the always-off side is shut.
   *
   * All 24 Chainlink equity feeds go stale at a weekend, so every leg is
   * skipped and this strategy returns nothing for two days in three. That is
   * most of what "no trading is being done" meant, and `all-legs-stale` below
   * was only ever the honest sentence about it.
   *
   * SUPPLIED PER TICK, NOT CONFIGURED, because a curve leg carries THIS TICK'S
   * reserves — the input a slippage floor is derived from, and curve-prices.ts
   * measures p99 movement at 1,546 bps over 240 seconds. A cached leg is a
   * floor for a market that has already moved.
   *
   * WHAT IS ALREADY TRUE OF ANYTHING IN HERE, before this file sees it: the
   * owner put its symbol in their basket, their signature covers its address,
   * the curve is one the worker knows, and the rail is live (paper cannot
   * simulate a curve trade). `curveLegsNow` enforces all four. This strategy
   * does not widen that set and cannot — it only decides whether to use it.
   */
  curve?: {
    legs: ReadonlyMap<string, CurveLeg>;
    tokens: ReadonlyMap<string, `0x${string}`>;
    slippageBps: number;
    maxImpactBps: number;
  } | null;
  /**
   * TAKE A PROFIT WHEN A LEG HAS RUN THIS FAR AHEAD OF WHAT IT COST, in bps.
   * Zero means never, and zero is the default.
   *
   * WHY THIS STRATEGY HAD NO SELL AT ALL. Every intent it could emit was a
   * buy, a vault deposit or a vault withdrawal — `sellToken` was always cash.
   * An agent on the shipped default could accumulate forever and never realise
   * anything, which is not a strategy anybody chose; it is a strategy nobody
   * noticed was one-way. In production one funded agent bought nine times with
   * real money and still holds all six positions, because there was no code
   * path that could ever sell them.
   *
   * TAKE-PROFIT ONLY, AND NO STOP-LOSS. A stop-loss on a DCA sleeve is
   * incoherent: the whole thesis of averaging in is to keep buying through a
   * drawdown, so a rule that sells the dip would fight the rule that buys it,
   * and the two would trade against each other with the owner paying the
   * spread both ways. Taking a profit does not contradict accumulating — it is
   * the other half of it, and it is the half an owner means by "if it is happy
   * with its profit it sells".
   *
   * OFF BY DEFAULT, DELIBERATELY. Turning this on changes what a live agent
   * does with somebody's money, and the threshold that is right for one book is
   * wrong for another. registry.ts already states the rule this follows: a
   * setting is "know about this", never "do this to me" — the owner turns it on.
   */
  takeProfitBps?: number;
}

export function steadyBasketTick(cfg: SteadyBasketConfig, snap: Snapshot): Tick {
  if (!snap.sequencerUp) return { intents: [], why: [] };

  // Cash can't cover a buy but the vault can: pull enough back to fund the next
  // tick's buy plus the liquidity floor. Withdraw-only tick — buys resume next
  // tick once the cash has actually landed.
  if (snap.cashUsdg < cfg.buyPerTickUsdg && snap.vaultUsdg > 0n) {
    const need = cfg.buyPerTickUsdg + cfg.idleFloorUsdg - snap.cashUsdg;
    const amountUsdg = need > snap.vaultUsdg ? snap.vaultUsdg : need;
    return {
      intents: [{ kind: "vault-withdraw", target: cfg.vault, amountUsdg }],
      why: [{ code: "unpark", usdgRaw: amountUsdg, needRaw: need }],
    };
  }

  const intents: TradeIntent[] = [];
  // Positionally paired with `intents` — see Tick. Pushed together, always.
  const why: (Why | null)[] = [];

  // ── LEAVING, BEFORE ENTERING ────────────────────────────────────────────
  //
  // Exits first, the same order trencher uses and for the same reason: a tick
  // that both takes a profit and opens a new leg should realise the one it can
  // measure before it spends on one it cannot. There is at most one exit per
  // tick, so a basket that has run does not liquidate itself in a single pass.
  //
  // A STALE PRICE IS NOT A GAIN. `priceStale` means the market for that leg is
  // closed, so its value is last session's number — selling against it would be
  // taking a profit measured at a price nobody is currently making. And a leg
  // with no cost on record is skipped rather than assumed free: `costUsdg` is
  // null when the ledger has no basis for it, and treating null as zero would
  // read the entire holding as profit, which is the accounting bug this
  // codebase exists downstream of.
  if (cfg.takeProfitBps && cfg.takeProfitBps > 0) {
    for (const [symbol, h] of snap.holdings) {
      if (h.priceStale) continue;
      const cost = h.costUsdg ?? null;
      if (cost === null || cost <= 0n) continue;
      if (snap.pausedTokens.has(h.token.toLowerCase())) continue;
      const gainBps = Number(((h.valueUsdg - cost) * 10_000n) / cost);
      if (gainBps < cfg.takeProfitBps) continue;
      intents.push({
        kind: "swap",
        target: cfg.swapRouter,
        sellToken: h.token,
        buyToken: cfg.usdg,
        sellAmountRaw: h.rawBalance,
        notionalUsdg: h.valueUsdg,
      });
      why.push({ code: "take-profit", symbol, gainBps, usdgRaw: h.valueUsdg, costRaw: cost });
      break;
    }
  }

  // Counted so the tick can say WHY it bought nothing. An empty intent list
  // reads identically whether the schedule declined, the feeds were stale, or
  // the cash was short — and only this function can tell them apart.
  let skippedStale = 0;
  let skippedPaused = 0;

  // ── THE DAY'S BUDGET BINDS THE BUYS, NOT JUST THE SWEEP ──────────────────
  //
  // This loop consulted `snap.cashUsdg` and nothing else, so once the daily cap
  // was spent it proposed the same legs every tick and checkPolicy refused every
  // one. On the shipped defaults that is not an edge case, it is Tuesday:
  // `buyPerTickUsdg` 25 against a `dailyUsdg` of 50 at `tickSeconds` 60 spends
  // the entire day's budget in TWO MINUTES and then refuses for the remaining
  // 1,438 — three refusals a tick, ~4,300 a day.
  //
  // The cap is right and stays. The bug is the pairing: two files that never
  // meet ship a per-tick rate 720× the daily allowance. Making the strategy read
  // the headroom is what turns "refused again" into "the budget is spent", which
  // is a thing an owner can act on.
  //
  // It also unblocks the `Why` mechanism. `bought` goes true whenever this loop
  // pushes anything, and `bought` true means `idle` is never set — so the one
  // machine built to say why nothing happened could not fire in the commonest
  // way for nothing to happen. Proposing nothing is what lets it speak.
  //
  // The clamp only ever SHRINKS the proposal, exactly like the sweep's below.
  // Reported as `idle` at the bottom, not pushed to `why` here — `why` is what
  // the tick DID, and this is the reason it did nothing. Same treatment as
  // `all-legs-stale` and `under-one-buy`.
  const budgetToday = snap.spendHeadroomUsdg;
  const budgetSpent = budgetToday <= 0n;

  if (!budgetSpent && snap.cashUsdg >= cfg.buyPerTickUsdg) {
    for (const leg of cfg.legs) {
      if (snap.pausedTokens.has(leg.token.toLowerCase())) {
        skippedPaused += 1;
        continue;
      }
      if (snap.staleFeeds.has(leg.symbol)) {
        skippedStale += 1;
        continue; // no reference price → no trade
      }
      const wanted = (cfg.buyPerTickUsdg * BigInt(leg.weightBps)) / 10_000n;
      // CLAMP TO WHAT IS LEFT, per leg, as the legs consume it. Gating the loop
      // on `budgetToday > 0` alone would still propose a full 25 against a
      // headroom of 3 and be refused — the same dead loop, one tick later.
      const alreadyProposed = intents.reduce(
        (sum, i) => sum + (i.kind === "swap" ? i.notionalUsdg : 0n),
        0n,
      );
      const room = budgetToday - alreadyProposed;
      const legAmount = wanted < room ? wanted : room;
      // A leg that rounds to nothing is not a trade. This also ends the loop
      // cleanly once the budget is exhausted mid-basket, rather than pushing
      // zero-sized intents that `non-positive` would refuse.
      if (legAmount <= 0n) continue;
      intents.push({
        kind: "swap",
        target: cfg.swapRouter,
        sellToken: cfg.usdg,
        buyToken: leg.token,
        sellAmountRaw: legAmount,
        notionalUsdg: legAmount,
      });
      why.push({
        code: "dca-leg",
        symbol: leg.symbol,
        usdgRaw: legAmount,
        weightBps: leg.weightBps,
        legs: cfg.legs.length,
      });
    }
  }

  const idleAfterBuys = snap.cashUsdg - (intents.length ? cfg.buyPerTickUsdg : 0n);
  if (idleAfterBuys > cfg.idleFloorUsdg) {
    const excess = idleAfterBuys - cfg.idleFloorUsdg;
    // Size the sweep to what the wall will actually take. A deposit is capped at
    // the DAILY limit (policy.ts), and this tick's buys have already eaten into
    // today's budget — so proposing the whole excess on a small grant meant the
    // deposit was rejected every single tick, forever, while the cash never moved.
    // Sweep what fits now; the rest goes next tick. Nothing here loosens a cap:
    // the proposal only ever shrinks.
    const spentOnBuys = intents.reduce(
      (sum, i) => sum + (i.kind === "swap" ? i.notionalUsdg : 0n),
      0n,
    );
    // ── BUYS KEEP FIRST CLAIM ON THE DAY'S BUDGET ─────────────────────────
    //
    // A vault deposit counts toward the daily spend (only withdrawals are
    // excluded), and this sweep took everything that was left — so on nine
    // agents the parked cash exactly consumed the cap, and every buy after it
    // was refused with `daily-cap` until the day rolled. The fit was exact:
    // vault 483.335 + positions 16.498 against a 500 cap. And because the sweep
    // repeats daily, those agents were capped permanently.
    //
    // Reserving one tick's buy is enough to keep the sleeve alive, and it
    // LOOSENS NOTHING — the sweep already shrinks itself to what the wall will
    // take, and this shrinks it slightly further. The cap itself is untouched.
    const roomToday = snap.spendHeadroomUsdg - spentOnBuys;
    // THE BUY THE WALL WOULD ACTUALLY TAKE, not the one configured. A tick size
    // above the per-trade cap is refused whatever the budget says, so reserving
    // the configured number would hold back cash for a trade that cannot happen.
    const oneBuy = cfg.buyPerTickUsdg < snap.perTradeCapUsdg ? cfg.buyPerTickUsdg : snap.perTradeCapUsdg;
    // And if even that does not fit in what is left today, the buy is impossible
    // today too — reserving for it would strand the cash without enabling
    // anything, which is the opposite of the point.
    const reserve = oneBuy <= roomToday ? oneBuy : 0n;
    const headroom = roomToday > reserve ? roomToday - reserve : 0n;
    const amountUsdg = excess < headroom ? excess : headroom;
    if (amountUsdg > 0n) {
      intents.push({ kind: "vault-deposit", target: cfg.vault, amountUsdg });
      // `clamped` when the daily budget cut the sweep short. Saying 'parked the
      // idle cash' while parking part of it would leave the sentence and the
      // balance disagreeing in front of the owner.
      why.push({
        code: "park",
        usdgRaw: amountUsdg,
        floorRaw: cfg.idleFloorUsdg,
        clamped: amountUsdg < excess,
      });
    }
  }

  // NOTHING BOUGHT, AND THE FEEDS ARE WHY.
  //
  // Only reported when the schedule genuinely wanted to buy — cash was
  // sufficient and there were legs — and every one of them was skipped. A tick
  // that bought nothing because it had no cash is a different silence with a
  // different remedy, and saying "the feeds are stale" about it would be
  // wrong. A sweep to the vault is not a buy, so this still fires beside one:
  // over a weekend that sweep is the only thing an agent does, and its owner is
  // still owed the sentence about why.
  const bought = intents.some((i) => i.kind === "swap");
  const shut =
    !bought && snap.cashUsdg >= cfg.buyPerTickUsdg && skippedStale + skippedPaused === cfg.legs.length && cfg.legs.length > 0;

  // ── THE 24/7 FALLBACK ────────────────────────────────────────────────
  //
  // ONLY WHEN NOTHING ELSE COULD HAVE TRADED. `shut` is the same condition
  // `all-legs-stale` reports: the schedule genuinely wanted to buy, there was
  // cash for it, and every single leg was skipped. So this can never displace
  // an equity buy, never fire on a short-cash tick, and never fire on a Monday.
  //
  // Stocks stay the default. This is the owner's own decision — "keep the
  // basket, add a 24/7 fallback" — and its whole safety argument is that
  // everything it can reach was already chosen twice: the symbol is in their
  // basket ("trade it") and the address is in their signature ("you may").
  // registry.ts calls that pairing deliberately not automatic, and it stays
  // that way: a coin the owner merely WATCHES is not reachable from here.
  if (shut && cfg.curve) {
    const pick = pickCurveBuy(cfg, snap);
    if (pick) {
      intents.push(pick.intent);
      why.push(pick.why);
    }
  }

  const boughtCurve = intents.some((i) => i.kind === "curve-trade");
  // THE OTHER SILENCE, WHICH HAD NO SENTENCE AT ALL.
  //
  // The comment above `shut` names this case exactly — "a tick that bought
  // nothing because it had no cash is a different silence with a different
  // remedy" — and then nothing ever wrote the different sentence. When cash is
  // below one tick's buy the loop above never runs, so `skippedStale` and
  // `skippedPaused` stay 0, so `shut` is false, so `all-legs-stale` cannot
  // fire; and the agent is not `no-cash` either, because only an exact zero
  // blocks the live rail. The owner sees "trading for real — every leg
  // available" beside an empty tape, forever, on stock defaults (25 USDG a
  // tick, a 50 USDG idle floor).
  //
  // Reported only when there was something it WANTED to buy — no legs
  // configured is a different fact, and the basket screen already says it.
  const short = !bought && cfg.legs.length > 0 && snap.cashUsdg < cfg.buyPerTickUsdg;
  // AND THE THIRD SILENCE, which on shipped defaults is by far the commonest.
  //
  // Ordered AHEAD of `short`, because when the budget is spent the cash test
  // says nothing useful: an agent can be flush and still forbidden to buy, and
  // "you have 900 USDG and one buy costs 25" is a baffling thing to read at that
  // moment. Behind `shut`, because a closed market is the more fundamental fact
  // — there would be nothing to buy either way.
  const spent = !bought && cfg.legs.length > 0 && budgetSpent;
  const idle: Why | undefined =
    shut && !boughtCurve
      ? { code: "all-legs-stale", legs: cfg.legs.length, paused: skippedPaused }
      : spent
        ? { code: "budget-spent", capRaw: cfg.buyPerTickUsdg }
        : short
        ? {
            code: "under-one-buy",
            cashRaw: snap.cashUsdg,
            needRaw: cfg.buyPerTickUsdg,
            // Named because it changes the remedy: with cash in the vault this
            // clears itself on the unpark, and without it the owner has to act.
            vaultRaw: snap.vaultUsdg,
          }
        : undefined;

  return idle ? { intents, why, idle } : { intents, why };
}

/**
 * ONE curve buy, or nothing.
 *
 * ONE, deliberately. A tick's budget is `buyPerTickUsdg` and the equity path
 * splits it across weighted legs; splitting it across memecoins would be an
 * allocation policy nobody chose. The highest-conviction thing available is the
 * owner's own basket order, so this takes the first leg that clears every
 * check rather than inventing a ranking.
 *
 * EVERY REFUSAL IS SILENT HERE, and that is right: the tick still reports
 * `all-legs-stale`, which is true and is the sentence the owner needs. A second
 * sentence explaining that a fallback the owner never asked about also declined
 * would be noise on a screen that already says nothing happened.
 */
function pickCurveBuy(
  cfg: SteadyBasketConfig,
  snap: Snapshot,
): { intent: TradeIntent; why: Why } | null {
  const curve = cfg.curve;
  if (!curve) return null;

  for (const [symbol, leg] of curve.legs) {
    const token = curve.tokens.get(symbol);
    if (!token) continue;
    if (snap.pausedTokens.has(token.toLowerCase())) continue;
    // NATIVE-QUOTED CURVES ARE UNREACHABLE: the adapter is non-payable and
    // every wall permission carries valueLimit 0. Same refusal proposals.ts
    // makes, for the same reason.
    if (/^0x0{40}$/i.test(leg.quoteToken)) continue;
    // Only a USDG-quoted curve is one hop from the agent's cash.
    if (leg.quoteToken.toLowerCase() !== cfg.usdg.toLowerCase()) continue;
    // A graduated curve has a pool now; buying it belongs on the swap path.
    if (curveGraduated(leg.reserves)) continue;

    const amountInRaw = cfg.buyPerTickUsdg;
    // THE IMPACT CEILING, on the producer, because this is where the reserves
    // are. The executor holds only an intent, and reading them again would be a
    // second read of a market that has already moved.
    const impact = curveBuyImpactBps(leg.reserves, amountInRaw);
    if (impact !== null && impact > curve.maxImpactBps) continue;

    const quoted = curveBuyOut(leg.reserves, amountInRaw);
    if (quoted === null) continue;
    const minAmountOutRaw = curveMinOut(quoted, curve.slippageBps);
    // NO FLOOR, NO TRADE. Sizing it blind is how a fill lands at any price.
    if (minAmountOutRaw === null || minAmountOutRaw <= 0n) continue;

    return {
      intent: {
        kind: "curve-trade",
        target: leg.adapter,
        curve: leg.curve,
        assetIn: cfg.usdg,
        assetOut: token,
        amountInRaw,
        minAmountOutRaw,
        notionalUsdg: amountInRaw,
      },
      why: { code: "stale-fallback", symbol, usdgRaw: amountInRaw, legs: cfg.legs.length },
    };
  }
  return null;
}
