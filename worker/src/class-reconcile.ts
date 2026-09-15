/**
 * RECONCILING A CLASS BOOK AGAINST THE CHAIN.
 *
 * Three sources, and only one of them is authoritative:
 *
 *   THE BALANCE   `balanceOf(vault)` per token. What is there NOW. Authoritative.
 *   THE TAPE      `ClassBuy`/`ClassSell`/`Swept`, folded. How it got there and
 *                 what it actually cost. Authoritative for basis, bounded by
 *                 how far back the scan reached.
 *   THE CACHE     `class_positions` in the child's sqlite. A list of tokens to
 *                 ask about, nothing more. Rebuilt on every redeploy.
 *
 * The rule that matters: A MISSING CACHE ROW IS NOT A FLAT BOOK. The child's
 * database is wiped on redeploy, so "no rows" is the ordinary state of a
 * freshly deployed worker holding a real position. Reading it as flat is how
 * money disappears from a dashboard while sitting untouched in a vault.
 *
 * Pure on purpose: all three inputs are passed in, so the interesting cases —
 * a wiped cache, a refused scan, a balance with no matching entry — can be
 * tested without a chain or a database.
 */
import type { ClassLedgerEntry } from "./venues/class-log";

/**
 * How a class position stands, and WHY it stands that way.
 *
 *   open       held, and the tape explains where it came from
 *   recovered  held, and the tape does NOT explain it — unknown basis
 *   closed     gone, because it was SOLD. Proceeds are a real figure.
 *   swept      gone, because the OWNER took it out through recovery. Nothing
 *              was sold, so there are no proceeds and there is no result.
 *
 * The last two were one value until a sweep was booked as a sale for zero.
 * `closed` with `proceeds 0` is a claim that a position was liquidated and
 * returned nothing, which is a total loss; a sweep is the owner moving their own
 * asset to their own address, which is a WITHDRAWAL and has no result at all.
 * Every downstream difference between a loss and a withdrawal — the drawdown
 * breaker, the performance fee, any published P&L — turns on telling them apart.
 */
export type ClassState = "open" | "closed" | "recovered" | "swept";

export interface ReconciledClassPosition {
  token: string;
  curve: string | null;
  /** Null when the entry is outside the scanned range. UNKNOWN, never zero. */
  costRaw: bigint | null;
  qtyRaw: bigint | null;
  proceedsRaw: bigint | null;
  openedAtBlock: bigint | null;
  entryTx: string | null;
  exitTx: string | null;
  state: ClassState;
  /** On-chain balance at reconcile time. The figure that decided `state`. */
  balanceRaw: bigint;
  /**
   * Tokens the owner swept out, in base units. Null when the tape could not say.
   *
   * Folded by `foldClassEvents` and, until this existed, dropped on the floor —
   * so the one fact that distinguishes "the owner took it home" from "it sold
   * for nothing" was read off the chain and then discarded.
   */
  sweptRaw: bigint | null;
  /**
   * The COST of what was swept out, in USDG base units — the size of the
   * withdrawal the sweep represents. Null when it cannot be computed.
   *
   * AT COST, never at a mark. The asset left as tokens, and the only figure
   * this book can honestly say left with it is what it paid for them. A curve
   * mark would be worse than useless here: it has no oracle behind it, one
   * small trade moves it a long way, and it would be writing a made-up number
   * into the figure the performance fee is measured against.
   *
   * Null when the basis is unknown or nothing was bought — an unpriceable
   * withdrawal must be reported, not estimated.
   */
  sweptCostRaw: bigint | null;
  /** The last sweep's transaction, so the withdrawal books exactly once. */
  sweptTx: string | null;
  sweptLogIndex: number | null;
}

export interface ClassReconciliation {
  positions: ReconciledClassPosition[];
  /**
   * Positions the chain holds that the tape could not explain.
   *
   * Reported separately because they need an operator's attention and an
   * owner's: their basis is unknown, so every P&L that includes them is a
   * guess, and the honest surface says so rather than printing a number.
   */
  recovered: string[];
  /** True when the reconciliation must NOT be treated as complete. */
  incomplete: boolean;
  why: string | null;
}

/**
 * Decide the state of every token either source knows about.
 *
 * REFUSES WHOLESALE ON AN INCOMPLETE SCAN. If the log scan failed, a token with
 * a zero balance might be closed, or might be one whose buy is in the window
 * the node refused — and writing `closed` on that guess would erase a live
 * position's basis. So an incomplete scan yields `incomplete: true` and the
 * caller writes nothing but the `open` rows the balance itself proves.
 */
export function reconcileClassBook(args: {
  /** Folded tape, keyed by lowercased token. Empty is legitimate. */
  folded: ReadonlyMap<string, ClassLedgerEntry>;
  /** On-chain balances, keyed by lowercased token. */
  balances: ReadonlyMap<string, bigint>;
  /** Tokens the cache knew about, so a wiped scan still asks about them. */
  cached: readonly string[];
  /** Did every log window answer? */
  logComplete: boolean;
  /** Did every balance read answer? */
  balancesComplete: boolean;
}): ClassReconciliation {
  const tokens = new Set<string>([
    ...args.folded.keys(),
    ...args.balances.keys(),
    ...args.cached.map((t) => t.toLowerCase()),
  ]);

  const positions: ReconciledClassPosition[] = [];
  const recovered: string[] = [];

  for (const token of tokens) {
    const entry = args.folded.get(token) ?? null;
    const balance = args.balances.get(token) ?? 0n;

    // THE BALANCE DECIDES WHETHER IT IS OPEN. Not the tape, and certainly not
    // the cache: a token can be swept out by the owner with no sell, or land in
    // the vault by a transfer the tape never saw.
    let state: ClassState;
    if (balance > 0n) {
      // Held. Whether we can explain it is a different question from whether
      // it is ours, and conflating them is how a rediscovered position gets
      // valued at a cost of zero — which reports the entire exit as profit.
      state = entry && entry.boughtRaw > 0n ? "open" : "recovered";
      if (state === "recovered") recovered.push(token);
    } else {
      // Nothing there. Only call it closed if the tape can say so; otherwise
      // this is a cache row for a token we have no evidence about either way,
      // and inventing `closed` would delete a basis that may still be needed.
      if (!args.logComplete) continue;
      if (!entry) continue;
      // SOLD, OR TAKEN HOME? Both leave a zero balance and they are not the
      // same event. A sweep is the owner moving their own asset to their own
      // address: no counterparty, no price, no result. Calling it `closed` put
      // it beside genuine liquidations, and with `proceeds 0` beside it the row
      // reads as a position that sold for nothing — a total loss of its cost.
      //
      // The chain already said which it was; `foldClassEvents` has counted the
      // Swept amounts all along and nothing carried them out of the fold.
      state = entry.sweptRaw > 0n ? "swept" : "closed";
    }

    positions.push({
      token,
      curve: entry?.curve ?? null,
      costRaw: entry && entry.boughtRaw > 0n ? entry.costRaw : null,
      qtyRaw: entry && entry.boughtRaw > 0n ? entry.boughtRaw : null,
      // NULL WHEN NOTHING WAS SOLD, because zero proceeds is a claim about a
      // sale and there was no sale. `0` and "not applicable" render identically
      // and mean opposite things — the same distinction this whole file keeps
      // for an unknown cost basis.
      proceedsRaw: entry ? (entry.soldRaw > 0n ? entry.proceedsRaw : null) : null,
      sweptRaw: entry ? entry.sweptRaw : null,
      // PRO-RATA ON QUANTITY, floor division.
      //
      // A partial sweep takes a partial basis with it, and the share has to be
      // measured in the only unit both sides share: tokens. Flooring means the
      // book keeps any rounding dust rather than withdrawing capital it cannot
      // account for — the direction that can only ever understate what left.
      sweptCostRaw:
        entry && entry.sweptRaw > 0n && entry.boughtRaw > 0n
          ? (entry.costRaw * entry.sweptRaw) / entry.boughtRaw
          : null,
      sweptTx: entry?.lastSweptTx ?? null,
      sweptLogIndex: entry?.lastSweptLogIndex ?? null,
      openedAtBlock: entry && entry.boughtRaw > 0n ? entry.openedAtBlock : null,
      entryTx: entry && entry.boughtRaw > 0n ? entry.entryTx : null,
      exitTx: entry?.exitTx ?? null,
      state,
      balanceRaw: balance,
    });
  }

  const incomplete = !args.logComplete || !args.balancesComplete;
  return {
    positions,
    recovered,
    incomplete,
    why: incomplete
      ? !args.logComplete && !args.balancesComplete
        ? "neither the vault's history nor its balances could be read in full"
        : !args.logComplete
          ? "the vault's history could not be read in full, so a position may be missing its cost"
          : "the vault's balances could not be read in full, so a holding may be missing entirely"
      : null,
  };
}

/**
 * What a reconciled position cost, for the scout budget.
 *
 * SEPARATE FROM THE ROW so the budget's definition lives in one place and
 * matches the one `quarantine.ts` already uses: the budget bounds what was
 * SPENT on things nobody can independently value, not what they are now worth.
 *
 * A `recovered` position contributes NOTHING, and that is deliberate rather
 * than convenient. Its cost is unknown; counting it as zero would quietly free
 * budget for another entry, and inventing a figure would be worse. It is
 * reported to the owner instead — the one thing that is actually true about it
 * is that we cannot say.
 */
export function scoutCostOf(positions: readonly ReconciledClassPosition[]): {
  spentRaw: bigint;
  unknown: string[];
} {
  let spentRaw = 0n;
  const unknown: string[] = [];
  for (const p of positions) {
    // CLOSED POSITIONS ARE DONE. They hold nothing and bound nothing.
    //
    // `swept` for the same reason and not the same reason: the position is
    // equally gone, but it left through the owner's own hand rather than
    // through a sale. Both are excluded from the budget; only one of them has a
    // result, and neither has one here.
    if (p.state === "closed" || p.state === "swept") continue;
    // A RECOVERED POSITION IS STILL HELD, so it must be REPORTED even though it
    // cannot be counted. Skipping it on state alone — which this did at first —
    // meant the one position whose cost nobody knows was also the one nobody
    // was told about, which is the quietest possible version of the bug.
    if (p.costRaw === null) {
      unknown.push(p.token);
      continue;
    }
    spentRaw += p.costRaw;
  }
  return { spentRaw, unknown };
}
