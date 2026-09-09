/**
 * Even Keel — a Merry Circle (holder-only) strategy.
 *
 * Keeps the basket at equal weight: trims whatever has run ahead and tops up
 * whatever has lagged, so the book quietly harvests mean reversion instead of
 * only ever buying (steady-basket). Stateless — it reads the current snapshot
 * and nudges toward balance by a bounded amount each tick, so no single tick
 * makes a violent move. Every intent still passes the policy wall.
 */

import type { TradeIntent } from "../policy";
import type { Snapshot, Tick } from "./types";
import type { Why } from "./reasons";

export interface EvenKeelLeg {
  symbol: string;
  token: `0x${string}`;
}

export interface EvenKeelConfig {
  legs: EvenKeelLeg[];
  swapRouter: `0x${string}`;
  usdg: `0x${string}`;
  /** Max USDG moved per leg per tick — keeps rebalancing gentle. */
  maxTradeUsdg: bigint;
  /** Tolerance band (bps of target) before a leg is trimmed/topped. */
  bandBps: number;
  /** When the book is empty, deploy this much cash as an equal-weight entry. */
  seedBudgetUsdg: bigint;
}

const clamp = (v: bigint, hi: bigint) => (v > hi ? hi : v);

/**
 * THE CEILING THIS STRATEGY NEVER LOOKED AT.
 *
 * `snap.perTradeCapUsdg` is the cap sealed into the owner's SIGNATURE, and the
 * wall enforces it on every intent. steady-basket has honoured it since it was
 * added (`cfg.buyPerTickUsdg < snap.perTradeCapUsdg ? … : …`) and trencher
 * skips any candidate above it; even-keel and dip-hunter ignored both it and
 * `spendHeadroomUsdg` entirely.
 *
 * WHAT THAT COSTS, and it is not a rounding error. A default basket of three
 * legs seeded at the "bold" size is 16.67 USDG a leg against a default signed
 * cap of 10, so EVERY intent this strategy produced was refused by the wall —
 * on the first tick, and on every tick after it, for the life of the grant.
 * Nothing in the product reads as "your own key refuses this": the tape fills
 * with rejected rows and the agent looks fussy rather than mis-sized.
 *
 * Clamping cannot widen anything. The wall is still the authority and still
 * refuses whatever it would have refused; this only stops proposing what is
 * already known to be impossible. The owner's remedy — a bigger cap — needs a
 * new signature, which is theirs to give and not ours to assume.
 */
const withinCap = (v: bigint, snap: Snapshot): bigint => {
  const capped = clamp(v, snap.perTradeCapUsdg);
  return clamp(capped, snap.spendHeadroomUsdg);
};

/**
 * THREE WAYS THIS DID NOTHING AND SAID NOTHING.
 *
 * Reported by a tester, about a funded agent: "when the strategy is 'even
 * keel', I've realised that the agent hasn't bought automatically a single
 * stock token during all day.... I don't know if it makes sense and first buys
 * must be done by user."
 *
 * Every early return below used to be a bare `{ intents: [], why: [] }`, which
 * is byte-identical to a healthy quiet tick. steady-basket.ts already learned
 * this — its own comment records 34 agents spending a weekend "doing nothing
 * and saying nothing", reported by their owners as "no trading is being done" —
 * and the vocabulary it added (`all-legs-stale`, `under-one-buy`) plus the
 * `idle` channel on `Tick` were built for exactly this. even-keel never used
 * either.
 *
 * WHICH ONE FIRES MATTERS, because the remedies have nothing in common: a stale
 * feed clears itself when the market opens, and an empty balance does not.
 */
export function evenKeelTick(cfg: EvenKeelConfig, snap: Snapshot): Tick {
  // Not an idle reason: the sequencer being down is a fact about the CHAIN that
  // every strategy sees at once, and the tick line already reports it. An event
  // per agent per tick would be 34 copies of one sentence.
  if (!snap.sequencerUp) return { intents: [], why: [] };

  const paused = cfg.legs.filter((l) => snap.pausedTokens.has(l.token.toLowerCase())).length;
  const tradable = cfg.legs.filter(
    (l) => !snap.pausedTokens.has(l.token.toLowerCase()) && !snap.staleFeeds.has(l.symbol),
  );
  if (tradable.length === 0) {
    // THE OVERNIGHT AND WEEKEND CASE, and the one the tester almost certainly
    // hit. Every Chainlink equity feed is stale outside US market hours, so a
    // stock basket has nothing to weigh itself against — and said so nowhere.
    // Reported only when there were legs to skip; a basket with none is a
    // different fact the basket screen already shows.
    return cfg.legs.length > 0
      ? { intents: [], why: [], idle: { code: "all-legs-stale", legs: cfg.legs.length, paused } }
      : { intents: [], why: [] };
  }

  const valueOf = (symbol: string) => snap.holdings.get(symbol)?.valueUsdg ?? 0n;
  const invested = tradable.reduce((sum, l) => sum + valueOf(l.symbol), 0n);

  // Cold start: nothing invested yet → lay down an equal-weight entry from cash.
  if (invested === 0n) {
    const budget = clamp(cfg.seedBudgetUsdg, snap.cashUsdg);
    const per = budget / BigInt(tradable.length);
    const each = withinCap(clamp(per, cfg.maxTradeUsdg), snap);
    if (budget <= 0n || per <= 0n) {
      /**
       * THE FIRST BUY NEVER HAPPENED, AND THIS IS THE ANSWER TO "must the first
       * buy be done by the user".
       *
       * No: this strategy opens the book itself. It divides the seed budget
       * across the tradable legs, and it produces nothing when that division
       * comes out at zero — which happens when there is no cash, or when the
       * budget is smaller than the number of legs. A five-name basket seeded
       * with 4 USDG buys nothing at all, and every previous version of this
       * function returned silently in both cases.
       *
       * `needRaw` IS THE WHOLE SEED, not one leg's share, because this strategy
       * opens the book in one move: it buys every tradable leg at once, so the
       * amount the owner has to clear is the round, not a twentieth of it.
       *
       * A ZERO SEED RENDERS IMPERFECTLY and that is a deliberate trade. When
       * the size per trade is set to zero the sentence reads "…one buy costs
       * 0.00", which is odd — but it names the right dial ("lower the size per
       * trade", inverted) and, far more importantly, it is NOT SILENCE. A
       * misconfigured size deserves its own reason code; it does not have one,
       * and adding a vocabulary entry is a wider change than this fix.
       */
      return {
        intents: [],
        why: [],
        idle: {
          code: "under-one-buy",
          cashRaw: snap.cashUsdg,
          needRaw: cfg.seedBudgetUsdg,
          vaultRaw: snap.vaultUsdg,
        },
      };
    }
    return {
      intents: tradable.map((l) => ({
        kind: "swap",
        target: cfg.swapRouter,
        sellToken: cfg.usdg,
        buyToken: l.token,
        sellAmountRaw: each,
        notionalUsdg: each,
      })),
      why: tradable.map(() => ({
        code: "keel-seed" as const,
        usdgRaw: each,
        legs: tradable.length,
      })),
    };
  }

  const target = invested / BigInt(tradable.length);
  const band = (target * BigInt(cfg.bandBps)) / 10_000n;
  const intents: TradeIntent[] = [];
  const why: (Why | null)[] = [];
  let cashLeft = snap.cashUsdg;

  for (const l of tradable) {
    const diff = valueOf(l.symbol) - target; // >0 overweight, <0 underweight
    if (diff > band) {
      /**
       * Trim the winner back toward target — sell stock for USDG.
       *
       * NOT CLAMPED, AND THAT IS THE CAREFUL PART. `withinCap` belongs on the
       * two BUY paths and must not touch this one: policy.ts exempts a sell leg
       * from the per-trade cap outright (`isUnsizedExit`), because the chain's
       * own permission for it "carries no amount condition" — wall.ts emits it
       * with an explicit null amount. A strategy that clamped its own exits
       * would be stricter than the wall, which that file calls a real bug in as
       * many words, and it would rebuild the failure it records: an agent
       * "structurally able to exit its losers and structurally unable to exit
       * its winners", because a winner grows past the cap and a loser does not.
       *
       * Nor by `spendHeadroomUsdg`: that is the day's BUYING budget. Throttling
       * an exit with it would mean a book that has spent its day cannot reduce
       * risk, which is the wrong way round.
       */
      const sellUsdg = clamp(diff, cfg.maxTradeUsdg);
      const held = snap.holdings.get(l.symbol);
      if (!held || held.valueUsdg === 0n) continue;
      // Convert the USDG amount to a raw stock amount pro-rata to the holding.
      const sellRaw = (held.rawBalance * sellUsdg) / held.valueUsdg;
      if (sellRaw <= 0n) continue;
      intents.push({
        kind: "swap",
        target: cfg.swapRouter,
        sellToken: l.token,
        buyToken: cfg.usdg,
        sellAmountRaw: sellRaw,
        notionalUsdg: sellUsdg,
      });
      why.push({ code: "keel-trim", symbol: l.symbol, overRaw: sellUsdg });
    } else if (-diff > band && cashLeft > 0n) {
      // Top up the laggard from cash.
      const buyUsdg = withinCap(clamp(clamp(-diff, cfg.maxTradeUsdg), cashLeft), snap);
      if (buyUsdg <= 0n) continue;
      cashLeft -= buyUsdg;
      intents.push({
        kind: "swap",
        target: cfg.swapRouter,
        sellToken: cfg.usdg,
        buyToken: l.token,
        sellAmountRaw: buyUsdg,
        notionalUsdg: buyUsdg,
      });
      why.push({ code: "keel-top", symbol: l.symbol, underRaw: buyUsdg });
    }
  }

  return { intents, why };
}
