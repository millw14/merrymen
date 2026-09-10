/**
 * WHERE AN ASSET LIVES, as distinct from whether it is owned.
 *
 * Every accounting surface in this repo was written when those two questions
 * had one answer: the smart account holds everything it owns, so `balanceOf(me)`
 * is the whole book. `PonsClassVault` breaks that — it holds tokens on behalf of
 * one account, deliberately, because holding them anywhere else makes them
 * unsellable (see the contract's header).
 *
 * This module is the seam. It exists so that "who are we?" has ONE answer that
 * four different readers share — the balance read, the receipt decode, the flow
 * classifier and the delivery probe — rather than four that can drift. The
 * transfer-marker saga and the suppression-key saga are both what happens when a
 * derivation lives in two places, and this one would live in four.
 *
 * WHAT IS DELIBERATELY NOT HERE: any notion that vault-held units are a
 * different ASSET. They are the same ERC-20 with the same cost basis; only their
 * location differs. `basis.ts` is per raw unit and split-invariant for exactly
 * that reason, and partitioning it by custody would mean a `sweep` — which moves
 * a position with no economic event at all — silently split one basis into two.
 */
import { grantPonsClassVault, type StoredGrant } from "../../packages/core/src/index";

/**
 * Where a holding sits. An open union with an exhaustive switch below, so
 * adding a third custody fails to COMPILE rather than falling through to a
 * default that quietly treats it like an account balance.
 */
export type Custody = "account" | "class-vault";

/**
 * Contracts that hold assets for this account, beyond the account itself.
 *
 * Empty for every grant without the class marker, which is every grant that
 * exists today. `grantPonsClassVault` demands the marker AND a well-formed
 * address, so nothing a setting can write reaches this list — the same rule
 * `limits.ts` applies to every other mirrored address, and sharper here because
 * this one is per-account: a settings-sourced value would point one owner's
 * reader at another owner's vault.
 */
export function custodyAddressesOf(
  grant: Pick<StoredGrant, "grantFeatures" | "ponsClassVaultAddress"> | null | undefined,
): `0x${string}`[] {
  const vault = grantPonsClassVault(grant);
  return vault ? [vault] : [];
}

/**
 * Every address whose balance is this account's money — "we", for a reader that
 * needs to net a receipt or read a book.
 *
 * The account is always first. Order is not load-bearing but it is stable, so a
 * key built from this list is reproducible.
 */
export function bookAddresses(
  grant: Pick<StoredGrant, "grantFeatures" | "ponsClassVaultAddress"> | null | undefined,
  smartAccount: string,
): string[] {
  return [smartAccount.toLowerCase(), ...custodyAddressesOf(grant)];
}

/**
 * How a position of this custody is exited, named rather than assumed.
 *
 * The question custody actually changes is not "what is it worth" — that is the
 * same arithmetic either way — but "how do I get out of it", and that is the
 * question an owner asks at the worst possible moment. An exhaustive switch on
 * a union means a third custody cannot be added without answering it.
 */
export function exitTargetFor(custody: Custody): string {
  switch (custody) {
    case "account":
      return "sell it from the account, through the venue it trades on";
    case "class-vault":
      return "sell it through the vault, which needs no approve — or sweep it back with the owner key";
  }
}

/**
 * WHICH COST-BASIS ROWS DESCRIBE A POSITION THAT IS GENUINELY GONE.
 *
 * Extracted from the tick because it is a DESTRUCTIVE, IRREVERSIBLE write —
 * `setBasis(…, {qtyRaw: 0n, costUsdg: 0n})` deletes the `cost_basis` row and the
 * `position_floors` row with it — and it was reachable from no test at all. The
 * same move `equity.ts` documents making for the same reason.
 *
 * The rule is "the chain is the truth: a symbol we no longer hold has no basis".
 * That is right, and it is only right if the question "do we hold it" is asked
 * of everywhere we could be holding it. The caller's `positions` list is
 * account-scoped; a class-custodied position is in none of the three sets the
 * tick already unions, so without `classHeld` this would close the basis of a
 * live position on the first tick after it was opened.
 *
 * `classReadOk: false` RETURNS NOTHING, and that is the more important half.
 * Everywhere else in this repo an unreadable input means "this rule cannot run";
 * here the rule's output is a deletion, so a failed read must never be able to
 * spend it. A basis closed on the strength of a read that did not happen cannot
 * be recovered from anywhere — the fills that built it are already netted away.
 */
/**
 * THE PROVENANCE SET, so a position cannot be evicted out of its own exit.
 *
 * `knownCurves()` reads `discovered_pools`, which `pruneDiscovered` trims to the
 * 5,000 newest rows. The launchpad adds roughly ten an hour — about 21 days to
 * full turnover, against a 14-day grant. For an ordinary curve trade losing a
 * row is survivable, because both legs are enumerated in the signature and the
 * asset wall still names them. For a CLASS position it is fatal: the output leg
 * is un-enumerated by design, so `curve-provenance` is the only rule vouching
 * for it, and an evicted curve means the mirror refuses the sell that would
 * close the position while the wall would have allowed it.
 *
 * That is the no-exit trap `PonsClassVault` exists to remove, rebuilt off-chain
 * — and it was introduced by making that rule fail closed. An agent's own open
 * positions are the fix: nothing prunes them, so their curves are always vouched
 * for by the fact that the agent is holding them.
 *
 * NULL FROM EITHER SOURCE MEANS NULL. Merging a partial list would be worse than
 * having none: for a class trade a short list is a refusal, so a partial one is a
 * SILENT refusal of exactly the positions that were dropped — and the caller
 * would have no way to tell that from a curve that was never seen. Undefined
 * says "this rule cannot run", which policy.ts already knows how to handle.
 */
export function provenanceCurves(
  discovered: readonly string[] | null,
  ownPositions: readonly string[] | null,
): string[] | undefined {
  if (discovered === null || ownPositions === null) return undefined;
  return [...new Set([...discovered, ...ownPositions].map((c) => c.toLowerCase()))];
}

export function strandedBasisSymbols(args: {
  /** Every symbol with a live cost-basis row. */
  basisSymbols: readonly string[];
  /** Priced positions the account holds. */
  positions: readonly string[];
  /** Held but deliberately unpriceable — absent from `positions`, still owned. */
  unpricedByDesign: readonly string[];
  /** Held but unpriced this tick — likewise absent, likewise still owned. */
  missingPrice: readonly string[];
  /** Held in a custody contract. Empty is meaningful ONLY with classReadOk. */
  classHeld: readonly string[];
  /**
   * Did the custody read answer? Absent is treated as true so every existing
   * caller keeps today's behaviour; only a caller that KNOWS the read failed
   * passes false. Same shape, and the same reasoning, as `equityKnown`.
   */
  classReadOk?: boolean;
}): string[] {
  if (args.classReadOk === false) return [];
  const heldNow = new Set([
    ...args.positions,
    ...args.unpricedByDesign,
    ...args.missingPrice,
    ...args.classHeld,
  ]);
  return args.basisSymbols.filter((symbol) => !heldNow.has(symbol));
}
