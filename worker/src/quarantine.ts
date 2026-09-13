/**
 * Quarantine — holding something you cannot price, without lying about it.
 *
 * THE PROBLEM. merrymen refuses to value a token whose pool is too new or too
 * thin, because that price can be pushed by anyone with moderate capital and it
 * feeds equity, P&L and the drawdown breaker. That refusal is correct. But it
 * left a hole: the moment ONE such token was held, the tick stopped publishing
 * equity at all — no high-water mark, no fee accrual, no breaker — for the whole
 * book, including the deep, Chainlink-priced majority of it. One unpriceable
 * dust position blinded every safety mechanism the owner was relying on.
 *
 * THE FIX. Carry an unpriceable position at what it COST.
 *
 * Cost is a historical fact. Nobody can push it, no pool can move it, and it
 * needs no oracle. It is emphatically NOT a market price and is never presented
 * as one — but it keeps the equity arithmetic sound so the breaker can keep
 * judging the rest of the book, which is the part it can actually protect.
 *
 * THE LIMIT, STATED PLAINLY. A position carried at cost does not move. If it
 * goes to zero, equity will not show it and the drawdown breaker will not fire.
 * That is not an oversight — it is the unavoidable consequence of refusing to
 * trust the only price available. The scout BUDGET is therefore the real risk
 * control for this money, not the breaker. Every surface that shows a
 * quarantined value has to say "at cost" so nobody reads it as a valuation.
 */

/** A held position that cannot currently be priced, carried at its cost basis. */
export interface QuarantinedHolding {
  symbol: string;
  /** USDG (6dp) actually spent acquiring what is still held. */
  costUsdg: bigint;
  /** Why it can't be priced — the pool guard's own words, for the owner. */
  reason: string;
}

export interface QuarantineView {
  holdings: QuarantinedHolding[];
  /** Total cost sitting in unpriceable positions. Bounded by scoutBudgetUsdg. */
  totalCostUsdg: bigint;
}

export function quarantineOf(
  symbols: readonly string[],
  costOf: (symbol: string) => bigint,
  reasonOf: (symbol: string) => string | undefined,
): QuarantineView {
  const holdings: QuarantinedHolding[] = [];
  let totalCostUsdg = 0n;
  for (const symbol of symbols) {
    const costUsdg = costOf(symbol);
    // A zero-cost quarantined holding is real (airdrop, or basis we never saw).
    // It contributes nothing to equity, which is the honest treatment: we know
    // neither what it's worth nor what it cost.
    if (costUsdg < 0n) continue;
    totalCostUsdg += costUsdg;
    holdings.push({
      symbol,
      costUsdg,
      reason: reasonOf(symbol) ?? "no Chainlink feed and no pool deep enough to trust",
    });
  }
  return { holdings, totalCostUsdg };
}

export interface ScoutLimits {
  enabled: boolean;
  /** Total cost that may sit in unpriceable positions at once (6dp). */
  budgetUsdg: bigint;
  /** Ceiling for a single unpriceable token (6dp). */
  perTokenUsdg: bigint;
}

export type ScoutVerdict = { ok: true } | { ok: false; reason: string };

/**
 * May the agent put `spendUsdg` into a token it cannot price?
 *
 * Deliberately strict and deliberately boring. This is the ONLY thing standing
 * between an owner and an unbounded position in something nobody can value, so
 * it fails closed on every ambiguity: off by default, zero budget by default,
 * and both the per-token and the total ceiling must hold.
 */
export function scoutAllows(
  args: {
    spendUsdg: bigint;
    /** What this token already cost, if it's already held. */
    existingCostUsdg: bigint;
    /** Total cost already sitting in quarantine, this token included. */
    quarantinedUsdg: bigint;
  },
  limits: ScoutLimits,
): ScoutVerdict {
  if (!limits.enabled) {
    return {
      ok: false,
      reason: "scout mode is off — this token can't be priced, and buying what can't be priced is opt-in",
    };
  }
  if (limits.budgetUsdg <= 0n) {
    return { ok: false, reason: "scout budget is 0 — set one in /settings before buying unpriceable tokens" };
  }
  if (args.spendUsdg <= 0n) return { ok: false, reason: "nothing to spend" };

  const perToken = args.existingCostUsdg + args.spendUsdg;
  if (perToken > limits.perTokenUsdg) {
    return {
      ok: false,
      reason: `would put ${fmt(perToken)} into one unpriceable token, over the ${fmt(limits.perTokenUsdg)} per-token scout cap`,
    };
  }
  const total = args.quarantinedUsdg + args.spendUsdg;
  if (total > limits.budgetUsdg) {
    return {
      ok: false,
      reason: `would take unpriceable holdings to ${fmt(total)}, over the ${fmt(limits.budgetUsdg)} scout budget`,
    };
  }
  return { ok: true };
}

/**
 * Is a scout-gated refusal DETERMINISTIC from the limits alone — i.e. would
 * scoutAllows refuse no matter the spend? Takes the same shape scoutAllows
 * judges (the ScoutContext minus the spend-dependent reads), so a proposer
 * can ask this BEFORE building an intent instead of proposing, recording, and
 * announcing a swap the wall was always going to turn back. Only the
 * unconditional branches (off / zero budget) count: per-token and total caps
 * depend on the moving book and can clear, so only the wall may judge those.
 *
 * The incident this exists for: a strategy proposing the same scout buy every
 * tick with the budget at 0, each refusal writing a ledger row and each row
 * pinging Telegram — the same sentence, three times a tick, forever.
 */
export function scoutGateShut(scout: { limits: ScoutLimits; buyUnpriceable: boolean }): boolean {
  if (!scout.buyUnpriceable) return false;
  return !scout.limits.enabled || scout.limits.budgetUsdg <= 0n;
}

const fmt = (v: bigint) => `${(Number(v) / 1e6).toFixed(2)} USDG`;
