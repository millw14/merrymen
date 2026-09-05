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
  /**
   * The paymaster's own two limits, when one is paying.
   *
   * Present so `totalGas` can count what the EntryPoint's prefund actually
   * counts. NEVER multiplied by any headroom: they are the sponsor's numbers,
   * bounded by paymaster.ts and asserted unchanged by `assertBoundsHeld`, and
   * inflating somebody else's limits is not ours to do.
   */
  paymasterVerificationGasLimit?: bigint;
  paymasterPostOpGasLimit?: bigint;
}

export interface GasBounds {
  /**
   * Multiplier applied to the bundler's estimate for EACH FIELD, in basis points.
   *
   * The per-field values and the measurement behind them are on GAS_BOUNDS
   * below. What follows is the original reasoning, which is sound for
   * callGasLimit and is where the (mistaken) blanket 2x came from.
   *
   * 2x, matching Vex. Not tuning: it is the smallest headroom that survives the
   * spread they measured on an unchanged input, and the cost of being generous
   * is LOW — though not nothing: the account must HOLD the prefund even though
   * it only PAYS for gas used, and the unspent remainder is credited to its
   * EntryPoint deposit rather than returned to its balance. A UserOp is charged
   * for gas USED, not gas requested — the limit
   * only has to be large enough, and the EntryPoint refunds the difference.
   * The asymmetry is total: too high costs a slightly larger prefund, too low
   * costs the entire operation.
   */
  callHeadroomBps: number;
  verificationHeadroomBps: number;
  preVerificationHeadroomBps: number;
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
  // ── ONE HEADROOM PER FIELD, BECAUSE THE ASYMMETRY IS PER FIELD ──────────
  //
  // This was a single 2x applied to all three, and the reasoning above — "too
  // high costs a slightly larger prefund, too low costs the entire operation" —
  // is derived from callGasLimit and is FALSE for the other two:
  //
  //   callGasLimit too low        the EntryPoint runs the call, it OOGs,
  //                               success=false, and THE ACCOUNT PAYS IN FULL.
  //                               Silent and expensive. Headroom earns its keep.
  //   verificationGasLimit low    validation reverts, FailedOp, the op never
  //                               enters a bundle. THE ACCOUNT PAYS NOTHING.
  //   preVerificationGas low      the bundler rejects it before inclusion.
  //                               THE ACCOUNT PAYS NOTHING.
  //
  // Two of the three fail free and loud — which is the outcome boundGas already
  // chooses deliberately everywhere else. Only one fails silently and charges.
  //
  // And the cost of getting it wrong was measured. A merrymen first operation
  // estimates at verif 7,418,031 · preVerif 243,443 · call 50,180 (Pimlico,
  // chain 4663, 2026-09-03). Under a blanket 2x that signs 15,423,308 and is
  // refused as gas-absurd — while the RAW total, 7,711,654, clears the ceiling
  // it was refused by. The doubling was the whole refusal.
  callHeadroomBps: 20_000, // 2x — genuinely variable: pool state at inclusion
  // 1.25x. Deterministic given fixed calldata against a fixed account: signature
  // verification, a CREATE2 of fixed bytecode, and zero-to-nonzero SSTOREs. The
  // only drift is warm storage, which makes it CHEAPER. The margin covers
  // estimator revisions, not variance we can name.
  verificationHeadroomBps: 12_500,
  // 1.25x. A pure function of the bytes, which are fixed before the estimate is
  // asked for, plus a bundler overhead constant. gasUsedForL1 is 0 on 4663, so
  // there is no L1 data surcharge to move under it.
  preVerificationHeadroomBps: 12_500,
  disagreementBps: 40_000, // 4x
  absoluteMax: 3_000_000n,
};

/**
 * THE ONE-TIME CEILING, FOR THE ONE OPERATION THAT EARNS IT.
 *
 * A merrymen session key installs its permission validator LAZILY: the enable
 * data rides in the signature of the first operation that key signs, so that one
 * operation carries the whole wall — every policy, both ONE_OF lists, and the
 * owner's EIP-712 enable signature — and Kernel installs all of it inside
 * validation. Measured, that is +7,059,814 verification gas over the same deploy
 * without the wall.
 *
 * ONE-TIME PER SESSION KEY, NOT PER ACCOUNT. The operation that earns this is
 * every key's first, not every account's first: a renewal on an account that has
 * been live for months pays it again, because Kernel keys the install on
 * (account, permissionId) and a renewed key is a new permissionId. See
 * readEnableState in executor.ts, which is what decides that this applies.
 *
 * THE ARITHMETIC, from measurement rather than from a round number:
 *
 *   measured, Pimlico on 4663, 2026-09-03, the full 18-permission wall:
 *     verificationGasLimit   7,418,031  × 1.25 =  9,272,538
 *     preVerificationGas       243,443  × 1.25 =    304,303
 *     callGasLimit              50,180  × 2.00 =    100,360
 *                                       bounded =  9,677,201
 *
 *   SAFETY MARGIN, documented separately rather than folded in:
 *     A tenant's own custom tokens widen both ONE_OF lists, and each one costs a
 *     measured ~370,299 raw / ~462,874 bounded. The margin buys FIVE of them:
 *       9,677,201 + (5 × 462,874) = 11,991,571
 *     Rounded up to a flat number a person can hold in their head.
 *
 *   => 12,000,000
 *
 * AND IT COVERS THE RENEWAL A FORTIORI. A renewal is the same enable minus the
 * initCode and the CREATE2, so it is strictly CHEAPER. Measured on 4663 the same
 * day, on two real deployed accounts and a synthesised third:
 *     0x032Da6A0…  raw 7,530,220 -> bounded 9,450,410
 *     0xa48cE91e…  raw 7,401,680 -> bounded 9,289,735
 *     synthetic    raw 7,569,825 -> bounded 9,499,915
 * All three sit under the 9,677,201 this constant was derived from, so the
 * undeployed first arm remains the binding case and the margin below is intact.
 *
 * That is 1.24x the base operation, and it is deliberately NOT generous: each
 * custom token adds ~512 bytes of enable blob and ~358,884 raw gas, so the
 * estimate crosses 12,000,000 at SIX of them — matching the five-token margin
 * above rather than contradicting it. (An earlier draft of this comment said
 * "~16", which was wrong by roughly 3x and would have told a tenant a 16-token
 * wall works. Measured: it is refused at six.) Beyond ~40 the grant provably
 * cannot validate at all (AA23, measured), so refusing early is the kinder
 * failure. Capping the token count at signing time is a separate change (#57);
 * this ceiling only declines to sign what it cannot justify.
 *
 * NOT REACHABLE BY BEING UNDEPLOYED, AND NOT BY SHAPE ALONE. readEnableState in
 * executor.ts requires the operation to name a permission id out of its own
 * nonce, at sequence 0, that the CHAIN confirms is not installed — and refuses
 * outright if it cannot ask. An undeployed account running any other shape gets
 * GAS_BOUNDS.
 */
export const FIRST_ENABLE_GAS_BOUNDS: GasBounds = {
  ...GAS_BOUNDS,
  absoluteMax: 12_000_000n,
};


export type GasVerdict =
  | { ok: true; gas: UserOpGas; total: bigint }
  /**
   * Mirrors ImpactVerdict (impact.ts) rather than inventing a shape: a literal
   * `rule` a caller can branch on, and a `detail` written for the owner.
   */
  | {
      ok: false;
      rule: "gas-absurd" | "gas-unstable" | "gas-unreadable" | "gas-paymaster-unexpected";
      detail: string;
    };

const bps = (v: bigint, n: number) => (v * BigInt(n)) / 10_000n;

/**
 * Everything the EntryPoint's prefund is computed from.
 *
 * THE PAYMASTER FIELDS ARE IN HERE NOW, and their absence was a hole. The
 * EntryPoint requires the payer to hold
 * `(callGasLimit + verificationGasLimit + preVerificationGas +
 *   paymasterVerificationGasLimit + paymasterPostOpGasLimit) × maxFeePerGas`,
 * and paymaster.ts allows up to 500,000 in EACH of the last two — so up to a
 * million gas of prefund sat outside every bound this file applies. A ceiling
 * that cannot see a fifth of what it is bounding is not a ceiling.
 */
export function totalGas(g: UserOpGas): bigint {
  return (
    g.callGasLimit +
    g.verificationGasLimit +
    g.preVerificationGas +
    (g.paymasterVerificationGasLimit ?? 0n) +
    (g.paymasterPostOpGasLimit ?? 0n)
  );
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
  /**
   * Is a paymaster paying? Defaults to NO, so a caller that forgets to say gets
   * the strict reading and a surprise paymaster is refused rather than admitted.
   */
  sponsored = false,
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
  /**
   * THE THREE LIMITS THAT MUST BE POSITIVE — and only those three.
   *
   * This iterated every field of UserOpGas, which was right when UserOpGas had
   * exactly three. Stage E added the two paymaster fields so the ceiling could
   * see what the EntryPoint's prefund sees, and this guard then rejected them:
   * an UNSPONSORED operation has no paymaster, so the bundler returns
   * `paymasterVerificationGasLimit: 0`, and zero there is THE TRUE ANSWER rather
   * than a missing estimate.
   *
   * Measured live on 4663, 2026-09-03: the canary's first enable estimated
   * cleanly at call 203,258 + verif 7,447,694 + preVerif 247,647 and was refused
   * `gas-unreadable` — "the bundler returned 0 for paymasterVerificationGasLimit"
   * — on an operation whose numbers were perfectly readable.
   *
   * The guard keeps its full strength where it earns it. A zero callGasLimit
   * still guarantees the OOG this file exists to prevent, and a zero in either
   * of the other two is still an estimator that did not answer. The paymaster
   * fields have their own rule already: `gas-paymaster-unexpected` refuses a
   * NONZERO paymaster on a self-paying operation, which is the direction that
   * can actually hide a million gas of prefund.
   */
  const REQUIRED_LIMITS = ["callGasLimit", "verificationGasLimit", "preVerificationGas"] as const;
  const badField = (g: UserOpGas): [string, bigint] | null => {
    for (const name of REQUIRED_LIMITS) {
      const v = g[name];
      if (typeof v !== "bigint" || v <= 0n) return [name, typeof v === "bigint" ? v : 0n];
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

  // A PAYMASTER WE DID NOT ASK FOR IS NOT A ROUNDING ERROR. Unsponsored, both
  // of these must be absent or zero; anything else means the operation being
  // estimated is not the operation we think we are sending, and it would add up
  // to a million gas of prefund that no bound here can see.
  const pmVer = first.paymasterVerificationGasLimit ?? 0n;
  const pmPost = first.paymasterPostOpGasLimit ?? 0n;
  if (!sponsored && (pmVer > 0n || pmPost > 0n)) {
    return {
      ok: false,
      rule: "gas-paymaster-unexpected",
      detail:
        `this operation is self-paying, but the estimate came back with paymaster gas ` +
        `(verification ${pmVer}, postOp ${pmPost}). Nobody asked a sponsor to pay, so the ` +
        "operation being priced is not the one about to be signed. Refused before signing.",
    };
  }

  const gas: UserOpGas = {
    // ONE HEADROOM PER FIELD. See GAS_BOUNDS for why a single multiplier was
    // wrong: two of these three fail free and loud when they are too low.
    callGasLimit: bps(first.callGasLimit, bounds.callHeadroomBps),
    verificationGasLimit: bps(first.verificationGasLimit, bounds.verificationHeadroomBps),
    preVerificationGas: bps(first.preVerificationGas, bounds.preVerificationHeadroomBps),
    // Carried, never multiplied — the sponsor's numbers, not ours.
    ...(pmVer > 0n ? { paymasterVerificationGasLimit: pmVer } : {}),
    ...(pmPost > 0n ? { paymasterPostOpGasLimit: pmPost } : {}),
  };
  // Counts the paymaster fields too, because the prefund does.
  const total = totalGas(gas);
  if (total > bounds.absoluteMax) {
    return {
      ok: false,
      rule: "gas-absurd",
      detail:
        `this operation wants ${total} gas, past the ${bounds.absoluteMax} ceiling. Refused before ` +
        "signing — nothing was spent. A ceiling is crossed either because the operation is not the " +
        "one it is meant to be, or because it genuinely needs more than we are willing to sign for; " +
        "both are reasons to stop rather than to sign.",
    };
  }
  return { ok: true, gas, total };
}

/**
 * CAN THIS ACCOUNT ACTUALLY PAY FOR THE OPERATION IT IS ABOUT TO SIGN?
 *
 * Separate from every ceiling above. A ceiling asks "is this operation the one
 * we think it is"; this asks "will the EntryPoint let it in". They fail for
 * opposite reasons and must not share a message.
 *
 * WHAT THE ENTRYPOINT ACTUALLY REQUIRES, v0.7, unsponsored:
 *
 *   requiredPrefund = (verificationGasLimit + callGasLimit + preVerificationGas
 *                      + paymasterVerificationGasLimit + paymasterPostOpGasLimit)
 *                     × maxFeePerGas
 *
 * which is exactly totalGas() × the fee — and the account must COVER it from its
 * EntryPoint deposit plus, for the shortfall, its own balance. The deposit half
 * matters: an account that has pre-deposited is not short, and a check that
 * ignored its deposit would refuse an operation the chain would have accepted.
 *
 * The account is CHARGED only for gas used, and the remainder is credited back
 * to its deposit — so this is a liquidity requirement, not a price. Saying that
 * in the refusal is the difference between an owner topping up ~0.009 ETH and an
 * owner concluding that a trade costs it.
 *
 * TWO FEES, AND THEY ARE NOT THE SAME NUMBER. Sizing the estimation-time balance
 * override wants a generous fee, because being generous there costs nothing — it
 * is a parameter of a simulation that never reaches a signature. Deciding whether
 * a real account is short wants the fee THE OPERATION WILL ACTUALLY CARRY,
 * because being generous there refuses people who could have paid. They were
 * briefly one variable, and the fallback that made the override safe — 5 gwei,
 * about eleven times the live rate on 4663 — would have demanded roughly ten
 * times the ETH an operation really needs.
 *
 * So this takes its fee from the PREPARED operation and from nowhere else, and
 * when it cannot have one it says so rather than guessing in either direction.
 * A "prefund-unverified" is not a "prefund-short": the first is a fact about us,
 * the second is a fact about an account.
 */
export type PrefundVerdict =
  | { ok: true; required: bigint; covered: bigint }
  | { ok: false; rule: "prefund-short"; required: bigint; covered: bigint; detail: string }
  | { ok: false; rule: "prefund-unverified"; detail: string };

export function checkPrefund(args: {
  /** The gas fields of the operation as PREPARED — what the EntryPoint will price. */
  gas: UserOpGas | null;
  /** maxFeePerGas off the prepared operation. Never a fee estimated separately. */
  maxFeePerGas: bigint | null;
  /** eth_getBalance(sender). null means the read FAILED, not that it is zero. */
  balance: bigint | null;
  /** EntryPoint.balanceOf(sender) — the deposit already staked. null means unread. */
  deposit: bigint | null;
}): PrefundVerdict {
  // Every input is nullable because every input is a read that can fail, and the
  // whole point of this function is that a failed read is not a small number.
  if (args.gas === null) {
    return {
      ok: false,
      rule: "prefund-unverified",
      detail: "the operation carries no gas limits, so there is nothing to price.",
    };
  }
  if (args.maxFeePerGas === null || args.maxFeePerGas <= 0n) {
    return {
      ok: false,
      rule: "prefund-unverified",
      detail:
        "the prepared operation carries no usable maxFeePerGas, so what the EntryPoint would " +
        "require cannot be computed. Refusing rather than pricing it from a fallback: a fee we " +
        "invented could demand many times the ETH the operation actually needs, and would report " +
        "a funded account as short. Nothing was signed.",
    };
  }
  if (args.balance === null || args.deposit === null) {
    const which =
      args.balance === null ? (args.deposit === null ? "balance and deposit" : "balance") : "deposit";
    return {
      ok: false,
      rule: "prefund-unverified",
      detail:
        `the account's ${which} could not be read, so whether it can cover this operation is ` +
        "unknown. Refusing while it is unknown — the next tick will ask again, and nothing was signed.",
    };
  }

  const required = totalGas(args.gas) * args.maxFeePerGas;
  const covered = args.deposit + args.balance;
  if (covered >= required) return { ok: true, required, covered };
  return {
    ok: false,
    rule: "prefund-short",
    required,
    covered,
    detail:
      `the EntryPoint requires ${required} wei to be covered before it will run this operation ` +
      `(${totalGas(args.gas)} gas at ${args.maxFeePerGas} wei/gas). The account holds ` +
      `${args.balance} wei and has ${args.deposit} wei on deposit — ${covered} together, short by ` +
      `${required - covered}. This is a liquidity requirement rather than a price: the account is ` +
      "charged only for the gas it USES and the remainder returns to its deposit, but the whole " +
      "amount has to be there first. Nothing was signed.",
  };
}
