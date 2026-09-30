/**
 * Can this agent actually begin trading?
 *
 * ONE DEFINITION, because there were already two and a third was about to be
 * written. `Console.tsx` and `settings/SetupChecklist.tsx` each carried a
 * private `hasGas` and each asked the same question of it, so the console could
 * admit an owner that the checklist went on reporting as unfinished forever.
 *
 * THE RULE CHANGED WHEN SPONSORSHIP ARRIVED. Holding ETH is no longer the only
 * way to be able to trade: a sponsored agent pays no gas from its own balance,
 * so an owner with USDG and zero ETH is not stuck — the old predicate simply had
 * no way to say that, and would have trapped them on the fund step permanently.
 *
 * THREE THINGS THIS DELIBERATELY DOES NOT DO:
 *
 *   1. It does not treat an UNREADABLE balance as a funded one. The status route
 *      collapses a failed chain read to "0" and has no channel to say "unread",
 *      so anything unparseable is false here. Being told to fund an account that
 *      is already funded wastes a minute; being told an unfunded account is
 *      ready wastes a day of wondering why nothing trades.
 *
 *   2. It does not decide anything about WITHDRAWAL. Sponsorship covers trading
 *      only — the recovery path pays its own way out of the balance it is
 *      sweeping — so "can start" is not "needs no ETH ever", and no caller may
 *      read it that way.
 *
 *   3. It does not guess at sponsorship. `gasSponsored` is reported by the
 *      worker, which is the only process that resolves it.
 */

/**
 * The balance shape the status route returns — wei/6dp as decimal strings, and
 * null for a read that failed. Null is falsy below, so an unread balance is
 * never gas and never capital: "can start" stays closed until the chain says so.
 */
export interface StartBalances {
  ethWei?: string | null;
  cashUsdg?: string | null;
  vaultUsdg?: string | null;
}

/**
 * Any gas at all. Kept byte-identical to the predicate both components already
 * used, including its lenient fallback, so the unsponsored path cannot shift.
 */
export function hasGas(wei?: string | null): boolean {
  if (!wei) return false;
  try {
    return BigInt(wei) > 0n;
  } catch {
    return Number(wei) > 0;
  }
}

/**
 * Anything to trade with — cash OR the vault.
 *
 * The vault counts because idle cash is SWEPT there on the first tick, so an
 * owner who funded and waited a minute has capital with a zero cash balance.
 * Leaving it out would push exactly the people who did everything right back
 * onto the fund step.
 *
 * Stricter than `hasGas` on purpose: an unparseable amount is false rather than
 * coerced with Number(), because this arm is the one that can wave somebody past
 * a funding step they still need.
 */
export function hasCapital(b?: StartBalances): boolean {
  const read = (v?: string | null): bigint => {
    if (!v) return 0n;
    try {
      return BigInt(v);
    } catch {
      return 0n;
    }
  };
  return read(b?.cashUsdg) + read(b?.vaultUsdg) > 0n;
}

/**
 * True when the account can trade: it holds gas, or its gas is sponsored and it
 * holds capital.
 *
 * With `gasSponsored` absent or false this is exactly `hasGas(ethWei)` — the
 * expression both call sites used before — so nothing moves for the deployments
 * that are not sponsored, which is all of them by default and every self-hosted
 * install that has not opted in.
 */
export function canStart(status?: {
  balances?: StartBalances;
  gasSponsored?: boolean | null;
}): boolean {
  if (hasGas(status?.balances?.ethWei)) return true;
  return !!status?.gasSponsored && hasCapital(status?.balances);
}

/**
 * WHICH SETUP STEP AN ACCOUNT IS ON, for the Settings checklist.
 *
 * canStart reads an unread balance as "cannot start", which is right for a
 * readiness signal and wrong as an instruction: the checklist drew "Add
 * trading funds" and an Add funds button from that same false, so a funded
 * owner whose chain read failed was told to fund an account that was already
 * funded. So the checklist asks this instead, and "unread" is its own answer:
 * whenever a balance canStart depends on was not read — the ETH always, and
 * the cash and vault too when gas is sponsored — nobody can say the step is
 * undone. A balance read as zero still asks for funds.
 */
export type SetupStep = "done" | "create" | "fund" | "unread";

export function setupStep(
  status: { exists?: boolean; balances?: StartBalances; gasSponsored?: boolean | null },
  paper: boolean,
): SetupStep {
  if (!status.exists) return "create";
  if (paper || canStart(status)) return "done";
  const unread = (v?: string | null) => v === null || v === undefined;
  const b = status.balances;
  if (unread(b?.ethWei)) return "unread";
  if (status.gasSponsored && (unread(b?.cashUsdg) || unread(b?.vaultUsdg))) return "unread";
  return "fund";
}
