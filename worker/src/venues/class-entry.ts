/**
 * A CLASS ENTRY, SIZED AND FLOORED — the deterministic arithmetic between a
 * chosen leg and the intent the wall judges, as a pure function.
 *
 * This restates the refuse chain `proposeClassEntries` runs in index.ts
 * (quote → impact → floor → graduation ceiling → round trip → intent) so that a
 * SECOND producer — the trending Brain's shadow harness, and later its live
 * seam — applies exactly the same checks to exactly the same numbers. The five
 * refusals here were once five bare `return []`s; each has an owner sentence
 * now, and the sentence is the whole output when a leg is turned back.
 *
 * WHY A COPY AND NOT AN IMPORT. The chain lives inside a closure in index.ts
 * with the tick's own state in scope, and that file is the one every in-flight
 * change touches. Extracting it here is the same move class-side.ts made for
 * the scout flags: a closure has nothing to assert on, and the shadow test must
 * prove that what it would have sent is what the tick would send. When index.ts
 * is next reconciled, its inline chain should become a call to this — the
 * constants are exported so the two cannot drift silently in the meantime.
 *
 * THE BRAIN IS NOWHERE IN THIS FILE. It receives a leg the deterministic layer
 * chose or the Brain proposed — it cannot tell which, and must not: the checks
 * are the same because the veto is the same.
 */
import type { TradeIntent } from "../policy";
import {
  curveBuyImpactBps,
  curveBuyOut,
  curveDepthFraction,
  curveMinOut,
  curveSellOut,
  type CurveReserves,
} from "./pons-price";

/**
 * Worst round trip this route accepts, bps. Curve fees are 99 bps a side so a
 * round trip cannot beat ~200; a curve much worse than that is one nobody
 * should be entering. Mirrors index.ts CLASS_MAX_ROUND_TRIP_BPS.
 */
export const CLASS_MAX_ROUND_TRIP_BPS = 600;
/**
 * Room left between the entry ceiling and the graduation exit, bps. Entering at
 * 84% against an 85% exit is a position with one percent of a curve to live
 * in. Mirrors index.ts CLASS_ENTRY_GRADUATION_MARGIN_BPS.
 */
export const CLASS_ENTRY_GRADUATION_MARGIN_BPS = 1_000;

export interface ClassEntryLeg {
  token: `0x${string}`;
  symbol: string;
  curve: `0x${string}`;
  quoteToken: `0x${string}`;
  reserves: CurveReserves;
}

export interface ClassEntryRules {
  /** Owner's impact ceiling, bps (`maxImpactBps`). */
  maxImpactBps: number;
  /** Owner's slippage tolerance, bps (`slippageBps`). */
  slippageBps: number;
  /** Owner's graduation exit, percent (`classExitAtGraduationPct`). */
  exitAtGraduationPct: number;
}

export type ClassEntryResult =
  | {
      ok: true;
      intent: TradeIntent;
      /** What the curve quoted for `spend`, token raw units. */
      quotedOutRaw: bigint;
      impactBps: number;
      /** What selling the quoted amount straight back would return, raw quote. */
      roundTripOutRaw: bigint;
      progressBps: number;
    }
  | { ok: false; why: string };

/**
 * Size, check and floor one class entry, or say in the owner's words why not.
 *
 * Every refusal is a `why` sentence. The order is the order index.ts applies
 * and it matters: an impact refusal on a curve that is also past its ceiling
 * should name the impact, because that is the first thing the tick would have
 * said and the shadow record must match the tick.
 */
export function buildClassEntry(args: {
  leg: ClassEntryLeg;
  vault: `0x${string}`;
  /** Raw quote units (USDG, 6dp) the entry spends. */
  spend: bigint;
  rules: ClassEntryRules;
}): ClassEntryResult {
  const { leg, vault, spend, rules } = args;
  const refuse = (why: string): ClassEntryResult => ({ ok: false, why });

  if (spend <= 0n) return refuse("nothing to spend — the entry size resolves to zero");

  const quoted = curveBuyOut(leg.reserves, spend);
  if (quoted === null || quoted <= 0n) return refuse("its curve would not quote a buy at this size");
  const impact = curveBuyImpactBps(leg.reserves, spend);
  if (impact === null) return refuse("its price impact could not be computed");
  if (impact > rules.maxImpactBps) {
    return refuse(
      `a ${Number(spend) / 1e6} USDG buy would move it ${impact}bps, over the ${rules.maxImpactBps}bps ceiling`,
    );
  }
  const floor = curveMinOut(quoted, rules.slippageBps);
  if (floor === null || floor <= 0n) return refuse("no minimum-output floor could be set, so the buy would be unprotected");

  const exitAtBps = rules.exitAtGraduationPct * 100;
  const entryCeilingBps = exitAtBps - CLASS_ENTRY_GRADUATION_MARGIN_BPS;
  const progress = curveDepthFraction(leg.reserves);
  if (progress === null) {
    return refuse(
      "how close it is to graduating could not be read, and a position that graduates cannot be sold from the vault",
    );
  }
  const progressBps = Math.round(progress * 10_000);
  if (entryCeilingBps <= 0) {
    return refuse(`the graduation exit is set to ${rules.exitAtGraduationPct}%, which leaves no room to enter below it`);
  }
  if (progressBps > entryCeilingBps) {
    return refuse(
      `it is ${(progressBps / 100).toFixed(1)}% of the way to graduating, past the ` +
        `${(entryCeilingBps / 100).toFixed(1)}% this route will enter at — the vault cannot sell a graduated curve, ` +
        `and the exit fires at ${rules.exitAtGraduationPct}%`,
    );
  }

  const roundTrip = curveSellOut(leg.reserves, quoted);
  if (roundTrip === null) return refuse("its curve would not quote the sell back, so the round trip is unknown");
  if (roundTrip * 10_000n < spend * BigInt(10_000 - CLASS_MAX_ROUND_TRIP_BPS)) {
    return refuse(
      `buying and immediately selling would return ${(Number(roundTrip) / 1e6).toFixed(2)} of ` +
        `${Number(spend) / 1e6} USDG — worse than the ${CLASS_MAX_ROUND_TRIP_BPS}bps round trip this route accepts`,
    );
  }

  return {
    ok: true,
    intent: {
      kind: "curve-trade",
      target: vault,
      curve: leg.curve,
      assetIn: leg.quoteToken,
      assetOut: leg.token,
      amountInRaw: spend,
      minAmountOutRaw: floor,
      notionalUsdg: spend,
    },
    quotedOutRaw: quoted,
    impactBps: impact,
    roundTripOutRaw: roundTrip,
    progressBps,
  };
}

/**
 * The entry size the tick would use: the owner's per-entry figure, capped by
 * the per-trade cap the wall signed, or a probe when the owner set none.
 * Mirrors the `spend` selection in proposeClassEntries.
 */
export function classSpendFor(args: { classPerEntryUsdg: number; perTradeUsdg: bigint; probeUsdg?: bigint }): bigint {
  const probe = args.probeUsdg ?? 5_000_000n;
  const configured = BigInt(Math.round(Math.max(0, args.classPerEntryUsdg) * 1e6));
  if (configured <= 0n) return probe;
  return configured < args.perTradeUsdg ? configured : args.perTradeUsdg;
}
