/**
 * TURN THE CLASS ROUTE ON FOR ONE NAMED TENANT, AND NOTHING ELSE.
 *
 * The settings store lives in a Postgres reachable only from inside Railway, so
 * there is no way to set these from an operator's machine. This is the same
 * shape the consent migration used: gated on a variable naming ONE tenant, run
 * once per process, and reported in full before and after.
 *
 * IT MERGES, IT DOES NOT REPLACE. `put` writes the whole blob, so a naive write
 * would silently erase every setting the owner has — including the ones they
 * chose deliberately. Dave's `maxImpactBps: 500` and `slippageBps: 200` are the
 * live example: they are his, they are looser than the defaults, and nothing
 * here may touch them.
 *
 * IT TOUCHES ONLY THE CANARY FIELDS. Not `liveTradingEnabled`, not
 * `paperTradingEnabled`, not the strategy, not the basket — and not the signed
 * caps, which live in the grant where no setting can reach them at all.
 */

/** Exactly the fields this writer sets. Anything absent is left as the owner had it. */
export interface CanarySettings {
  classSnipeEnabled: boolean;
  classPerEntryUsdg: number;
  classMaxPositions: number;
  scoutEnabled: boolean;
  scoutBudgetUsdg: number;
  classMinDepthUsdg: number;
  classMaxHoldSec: number;
  classExitAtGraduationPct: number;
  /** "all" — "stocks" excludes the entire class route. See DAVE_CLASS. */
  assetMode: string;
}

/**
 * The canary configuration.
 *
 * `classMaxHoldSec` and `classExitAtGraduationPct` are written at their NORMAL
 * values rather than omitted, so the record says plainly that they were not
 * shortened — a canary whose hold timer was trimmed to finish sooner proves
 * nothing about the exit that matters.
 *
 * `scoutBudgetUsdg` is 15 because `classMaxPositions` is 3 at
 * `classPerEntryUsdg` 5: a smaller budget silently caps the position count below
 * what the other settings claim, and `scoutAllows` refuses at 0 outright, so
 * leaving it unset would make the whole route inert while looking configured.
 */
export const CANARY: CanarySettings = Object.freeze({
  classSnipeEnabled: true,
  classPerEntryUsdg: 5,
  classMaxPositions: 3,
  scoutEnabled: true,
  scoutBudgetUsdg: 15,
  classMinDepthUsdg: 250,
  classMaxHoldSec: 6 * 3600,
  classExitAtGraduationPct: 85,
  assetMode: "all",
});

/**
 * What to write: the owner's settings with exactly the canary fields replaced.
 *
 * Pure, so the merge is testable without a store — and the merge is the whole
 * risk here. A write that dropped a field would be invisible until the setting
 * it dropped was the one that mattered.
 */
export function mergeCanary(
  current: Record<string, unknown> | null,
  values: CanarySettings = CANARY,
): Record<string, unknown> {
  return { ...(current ?? {}), ...values };
}

/** What changed, for the operator line. Unchanged fields are not reported. */
export function describeCanaryChange(
  current: Record<string, unknown> | null,
  values: CanarySettings = CANARY,
): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    const before = current?.[k];
    out.push(
      before === undefined
        ? `  ${k.padEnd(26)} (unset) -> ${JSON.stringify(v)}`
        : before === v
          ? `  ${k.padEnd(26)} ${JSON.stringify(v)} (unchanged)`
          : `  ${k.padEnd(26)} ${JSON.stringify(before)} -> ${JSON.stringify(v)}`,
    );
  }
  return out;
}

/**
 * Fields this writer must never touch, named so a test can prove it.
 *
 * Not a runtime filter — `mergeCanary` only ever spreads CANARY's own keys, so
 * the guarantee is structural. This list exists so the TEST can assert the
 * structure holds for the fields that would hurt most if it did not.
 */
export const MUST_PRESERVE = [
  "maxImpactBps",
  "slippageBps",
  "liveTradingEnabled",
  "paperTradingEnabled",
  "strategy",
  "basketSymbols",
  "customTokens",
  "telegramBotToken",
] as const;

/**
 * STOP NEW ENTRIES. LEAVE EVERY EXIT ALONE.
 *
 * `classSnipeEnabled` gates `proposeClassEntries` and nothing else — the exit
 * path reads `classMaxHoldSec` and `classExitAtGraduationPct` and never consults
 * it, which is why an agent holding a position keeps managing it after entries
 * are switched off. That asymmetry is the whole reason this is safe to do to a
 * tenant with money in the market, and the reason it is one field rather than a
 * "pause the route" flag that would take the exit with it.
 *
 * ONE FIELD. Not `liveTradingEnabled` (which would stop the sell), not
 * `classMaxPositions` (0 would read as a configuration the owner chose), not
 * `scoutEnabled` (the budget is also what an exit reports against). Anything
 * broader here silently strands a live position in a book that can no longer
 * close it, which is the trap `merrymen`'s class route was built to avoid.
 */
export const HALT_ENTRIES = Object.freeze({ classSnipeEnabled: false });

/** The owner's settings with entries switched off and nothing else changed. */
export function mergeHaltEntries(
  current: Record<string, unknown> | null,
): Record<string, unknown> {
  return { ...(current ?? {}), ...HALT_ENTRIES };
}

/**
 * Fields that MUST survive an entries-halt, named so a test can prove it.
 *
 * The first two are the exit triggers and the third is the rail the sell rides
 * on. If any of them moved, the halt would not be a halt — it would be a
 * position nobody can get out of.
 */
export const HALT_MUST_PRESERVE = [
  "classMaxHoldSec",
  "classExitAtGraduationPct",
  "liveTradingEnabled",
  "classPerEntryUsdg",
  "classMaxPositions",
  "scoutEnabled",
  "scoutBudgetUsdg",
  "maxImpactBps",
  "slippageBps",
  "assetMode",
] as const;

/**
 * TURN NEW ENTRIES BACK ON. THE EXACT INVERSE OF `HALT_ENTRIES`, AND NOTHING MORE.
 *
 * Deliberately not `CANARY`. That writes eight fields, and re-running it to flip
 * one would restate the owner's hold window and graduation cliff as a side
 * effect — values somebody may have tuned since. Resuming is one field because
 * halting was one field, and the pair has to be symmetric or the round trip
 * through them is not a round trip.
 */
export const RESUME_ENTRIES = Object.freeze({ classSnipeEnabled: true });

/** The owner's settings with entries switched back on and nothing else changed. */
export function mergeResumeEntries(
  current: Record<string, unknown> | null,
): Record<string, unknown> {
  return { ...(current ?? {}), ...RESUME_ENTRIES };
}
/**
 * ── WHY `assetMode` IS SET HERE AND NOT PRESERVED ─────────────────────────
 *
 * It was in `MUST_PRESERVE`, and that was wrong in a way that would have
 * enabled the route and left it inert.
 *
 * `assetModeAllows` filters trade legs by instrument class, and `"stocks"`
 * excludes the entire class route — `proposeClassEntries` returns nothing,
 * whatever the other seven fields say. So an owner who chose stocks-only could
 * be "enabled" with every class field written and verified, and never take a
 * single launch: eight green fields and an agent that cannot act on any of them.
 *
 * Shogun never showed it because his `assetMode` is UNSET and defaults to
 * `"all"`. Dave's is explicitly `"stocks"`, which is the whole reason this was
 * found before the write rather than after it.
 *
 * `maxImpactBps` and `slippageBps` stay in `MUST_PRESERVE` and stay his: they
 * are tuning an owner chose, they are looser than the defaults, and nothing
 * about turning a venue on justifies moving them.
 */

/** Dave's class-route configuration — the owner's agreed numbers, and only these. */
export const DAVE_CLASS: CanarySettings = Object.freeze({
  classSnipeEnabled: true,
  classPerEntryUsdg: 5,
  classMaxPositions: 3,
  scoutEnabled: true,
  /**
   * 10, not the canary's 15.
   *
   * It has to clear `classPerEntryUsdg` or the budget silently caps the position
   * count below what `classMaxPositions` claims — and it must not be 0, because
   * `scoutAllows` refuses at 0 outright, which is the shape that leaves a route
   * looking configured and doing nothing. Dave's is unset today, so it defaults
   * to exactly that 0.
   */
  scoutBudgetUsdg: 10,
  classMinDepthUsdg: 250,
  /** Written at their NORMAL values so the record says plainly they were not shortened. */
  classMaxHoldSec: 6 * 3600,
  classExitAtGraduationPct: 85,
  assetMode: "all",
});

/** What must be true of the GRANT before the route may be switched on. */
export interface ClassGrantFacts {
  /** `grantPonsClassVault(grant)` — the vault the SIGNATURE sealed. Null when none. */
  sealedVault: string | null;
  /** `vaultFor(smartAccount)` — deterministic, whether or not it was sealed. */
  derivedVault: string | null;
}

/**
 * Refuse to enable a route the signature cannot execute.
 *
 * ENABLING WITHOUT A SEALED VAULT IS NOT MERELY INERT — it is an agent that
 * scouts, scores, qualifies candidates and builds entry intents that its own key
 * can never sign, every tick, forever. The owner sees an agent working and no
 * trades, which is the single most expensive failure shape this product has.
 *
 * And a MISMATCH is worse than an absence: a grant sealed against some other
 * address means the wall pins a vault the executor will not use, so the whole
 * class route is pinned to somewhere the agent cannot reach.
 *
 * Returns the reasons, so the operator log says which one rather than "failed".
 */
export function classEnableBlockers(facts: ClassGrantFacts): string[] {
  const out: string[] = [];
  if (facts.sealedVault === null) {
    out.push("the grant carries no class vault — the owner must re-sign before the route can be enabled");
    return out;
  }
  if (facts.derivedVault === null) {
    out.push("could not derive this account's vault address, so the sealed one cannot be checked");
    return out;
  }
  if (facts.sealedVault.toLowerCase() !== facts.derivedVault.toLowerCase()) {
    out.push(
      `the grant seals ${facts.sealedVault} but this account's vault is ${facts.derivedVault} — ` +
        `the wall would pin a vault the executor never uses`,
    );
  }
  return out;
}
