/**
 * GAS LIMITS — the ones this repo never set.
 *
 * `grep -r 'callGasLimit|verificationGasLimit|preVerificationGas'` across
 * worker/, packages/ and web/ returned nothing before this file. `gas.ts`
 * supplies `estimateFeesPerGas` — a PRICE — and every limit was whatever the
 * bundler returned, unexamined, with no floor and no ceiling.
 *
 * WHY A FLOOR. In ERC-4337 an under-estimated `callGasLimit` does not bounce the
 * operation. The EntryPoint runs it, the inner call runs out of gas,
 * `success=false`, and the account is charged the full `actualGasCost` anyway.
 * merrymen then books that as `reverted` with the reason "reverted on-chain" —
 * indistinguishable from a slippage revert, so nothing ever learns and the same
 * trade is retried at tick cadence. You pay, repeatedly, for an estimate that
 * was slightly wrong about a route that was fine.
 *
 * WHY A CEILING, AND WHY IT REFUSES RATHER THAN CLAMPS. An estimate far above
 * what the calldata should cost means the estimator and reality disagree, and
 * the safe response to disagreement is not to pick a number — it is to decline.
 * Clamping would submit an operation we have positively decided is
 * under-provisioned, which is the OOG case above, on purpose.
 *
 * The evidence is Vex's (github.com/Vex-Foundation/Vex, used with its author's
 * permission): four KyberSwap swaps mined-reverted on Base having burned ~97.3%
 * of their limit with zero logs, and re-estimating that exact calldata across
 * twelve consecutive blocks returned 804,028–1,660,619 — a 2.07x spread on an
 * unchanged input. merrymen's swaps are `exactInputSingle`, the same calldata
 * shape they measured.
 *
 * WHERE IT PLUGS IN. viem's `prepareUserOperation` fills each gas field only
 * when it is undefined (`request.callGasLimit ?? gas.callGasLimit`), and skips
 * the bundler estimate entirely once all of them are set. So bounding requires
 * estimating FIRST and then passing explicit limits — one extra bundler round
 * trip per operation, which is what Vex pays too.
 *
 * Pure and injectable, like delivery.ts: the arithmetic is decided here and
 * tested without a chain, because a gas policy that can only be exercised by
 * spending gas is a gas policy nobody exercises.
 */

/** The three fields an EntryPoint 0.7 operation is bounded by. */
export interface UserOpGas {
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
}

export interface GasBounds {
  /**
   * Multiplier applied to the bundler's estimate, in basis points.
   *
   * 2x, matching Vex. Not tuning: it is the smallest headroom that survives the
   * spread they measured on an unchanged input, and the cost of being generous
   * is nothing. A UserOp is charged for gas USED, not gas requested — the limit
   * only has to be large enough, and the EntryPoint refunds the difference.
   * The asymmetry is total: too high costs a slightly larger prefund, too low
   * costs the entire operation.
   */
  headroomBps: number;
  /**
   * Refuse when the estimate exceeds this multiple of the FIRST estimate, bps.
   *
   * Vex's 4x. This catches the estimator disagreeing with itself, which is the
   * only signal available without knowing what the calldata "should" cost.
   */
  disagreementBps: number;
  /**
   * Refuse outright above this total, whatever any estimate says.
   *
   * Vex's 3M. An approve plus an `exactInputSingle` does not approach it, so
   * crossing it means the operation is not the operation we think it is.
   */
  absoluteMax: bigint;
}

export const GAS_BOUNDS: GasBounds = {
  headroomBps: 20_000, // 2x
  disagreementBps: 40_000, // 4x
  absoluteMax: 3_000_000n,
};

export type GasVerdict =
  | { ok: true; gas: UserOpGas; total: bigint }
  /**
   * Mirrors ImpactVerdict (impact.ts) rather than inventing a shape: a literal
   * `rule` a caller can branch on, and a `detail` written for the owner.
   */
  | { ok: false; rule: "gas-absurd" | "gas-unstable" | "gas-unreadable"; detail: string };

const bps = (v: bigint, n: number) => (v * BigInt(n)) / 10_000n;

/** callGasLimit + verificationGasLimit + preVerificationGas. */
export function totalGas(g: UserOpGas): bigint {
  return g.callGasLimit + g.verificationGasLimit + g.preVerificationGas;
}

/**
 * Turn one or two estimates into the limits to sign, or a refusal.
 *
 * `second` is optional and is the disagreement probe: the SAME calldata,
 * estimated again. Passing it is what makes `gas-unstable` reachable; without
 * it the check is skipped rather than assumed to pass, because a check that
 * did not run must never read as one that did.
 */
export function boundGas(
  first: UserOpGas | null,
  second: UserOpGas | null,
  bounds: GasBounds = GAS_BOUNDS,
): GasVerdict {
  if (!first) {
    return {
      ok: false,
      rule: "gas-unreadable",
      detail:
        "the bundler would not estimate gas for this operation. That is a refusal to quote, not a quote of zero — " +
        "submitting with limits we invented would risk paying for an operation that runs out of gas inside the EntryPoint.",
    };
  }
  // A zero or negative field is not an estimate. Signing one guarantees the OOG
  // this file exists to prevent, and it is the shape a malformed RPC reply takes:
  // viem's formatter turns a bundler's "0x0" into 0n, so the field is PRESENT
  // and zero rather than absent, and the executor's typeof-bigint guard passes it.
  //
  // BOTH estimates, not just the first. This checked `first` only, and then the
  // comparison below reassigns `first = second` whenever the second total is
  // higher — so a zero callGasLimit riding in on an otherwise-inflated second
  // estimate was signed unchecked. That op passes validation and prefund, runs
  // out of gas in the inner call, and the account is charged in full: precisely
  // the indistinguishable OOG this file was written to prevent, produced by the
  // guard against it.
  //
  // Checked BEFORE the disagreement test on purpose — a zero field also skews
  // the total that test compares, so validating first makes that math
  // trustworthy as well.
  const badField = (g: UserOpGas): [string, bigint] | null => {
    for (const [name, v] of Object.entries(g) as [keyof UserOpGas, bigint][]) {
      if (v <= 0n) return [name, v];
    }
    return null;
  };
  for (const candidate of second ? [first, second] : [first]) {
    const bad = badField(candidate);
    if (bad) {
      return {
        ok: false,
        rule: "gas-unreadable",
        detail: `the bundler returned ${String(bad[1])} for ${bad[0]}, which is not an estimate. Refusing rather than guessing.`,
      };
    }
  }

  if (second) {
    // Compared on the TOTAL, not per field. The fields trade off against each
    // other between estimator versions — verification moving into
    // preVerification is a re-attribution, not instability — and it is the
    // total the account pays a prefund against.
    const a = totalGas(first);
    const b = totalGas(second);
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    if (hi > bps(lo, bounds.disagreementBps)) {
      return {
        ok: false,
        rule: "gas-unstable",
        detail:
          `two estimates for the same calldata came back ${lo} and ${hi} — more than ` +
          `${bounds.disagreementBps / 10_000}x apart. The estimator disagrees with itself, so neither figure is one to sign against.`,
      };
    }
    // Bound against the HIGHER of the two. The cheap one may be the wrong one,
    // and headroom is the direction where being wrong is free.
    first = a >= b ? first : second;
  }

  const gas: UserOpGas = {
    callGasLimit: bps(first.callGasLimit, bounds.headroomBps),
    verificationGasLimit: bps(first.verificationGasLimit, bounds.headroomBps),
    preVerificationGas: bps(first.preVerificationGas, bounds.headroomBps),
  };
  const total = totalGas(gas);
  if (total > bounds.absoluteMax) {
    return {
      ok: false,
      rule: "gas-absurd",
      detail:
        `this operation wants ${total} gas, past the ${bounds.absoluteMax} ceiling. An approve plus a swap does not ` +
        "approach that, so the operation is not the one it is meant to be. Refused before signing — nothing was spent.",
    };
  }
  return { ok: true, gas, total };
}
