/**
 * BOOK THE RESULT OF A CLASS ROUND TRIP THAT COMPLETED WITHOUT ONE.
 *
 * Every class trade this repo made before the executor's class arm learned to
 * book a fill recorded `fill_side` NULL and a NULL `realized_pnl_usdg`. The
 * money moved and the book recorded nothing about it. That is now fixed going
 * forward; this is for the trips that already landed.
 *
 * THE EVIDENCE IS THE CHAIN AND NOTHING ELSE. `ClassBuy.quoteIn` and
 * `ClassSell.quoteOut` are what the curve actually paid and took, measured by
 * the vault contract rather than reported by the curve, in transactions that
 * cannot be rewritten. Shogun's trip: 5.000000 in on 0x3d926ce734…, 3.226758
 * back on 0xa8ed38d8aa…, so −1.773242.
 *
 * NOT FROM A BALANCE. The vault also receives unrelated USDG — reward payments
 * to holders, 9.268223 of it so far — so its balance says nothing about what a
 * position returned. Only the trade's own events do.
 *
 * IDEMPOTENT ON CHAIN IDENTITY. The key is (exit transaction, token leg): a
 * repair writes only where that transaction's row has no realised figure yet, so
 * running it twice is a no-op and running it after the live path has booked the
 * same trip is refused rather than doubled. The guard is the absence of a
 * recorded result, which is a property of the row the chain identifies — not a
 * marker in a database a redeploy rebuilds.
 *
 * EXACTLY ONE ROW PER TRIP. A class trade leaves two trade rows: the
 * `curve-trade` intent row and a `swap` row written by the orphan-receipt
 * reconciler as execution evidence. Only the intent row is the accounting owner,
 * and this refuses to write if it cannot tell them apart.
 *
 * PURE. Given facts, returns a plan.
 */

/** One completed round trip, as the chain and the ledger each describe it. */
export interface ClassRoundTripFacts {
  tenant: string;
  smartAccount: string;
  token: string;
  /** The key the basis and the class row share — address-derived. */
  symbol: string;
  entryTx: string | null;
  exitTx: string | null;
  /** Σ `ClassBuy.quoteIn`, from the vault's own events. Null when unread. */
  costRaw: bigint | null;
  /** Σ `ClassSell.quoteOut`, from the vault's own events. Null when unread. */
  proceedsRaw: bigint | null;
  /** Σ `ClassSell.tokensIn`. */
  qtySoldRaw: bigint | null;
  /** Tokens the OWNER swept out. A sweep has no proceeds and no result. */
  sweptRaw: bigint | null;
  /** `class_positions.state` as the ledger holds it. */
  state: string;
  /** Does the exit transaction have exactly one `curve-trade` row? */
  exitIntentRows: number;
  /**
   * The realised figure already on that row, or null when none.
   *
   * NULL is the thing being repaired. A number here means the trip is already
   * booked and this must not touch it.
   */
  recordedRealizedUsdg: number | null;
  /**
   * Cost basis still sitting against this symbol IN THE SHARED LEDGER.
   *
   * Not necessarily what the child holds. `setBasis` DELETES a row when the
   * quantity reaches zero rather than zeroing it, and the mirror skips its own
   * `DELETE FROM cost_basis` whenever the child is flagged `rebuilt` — which a
   * hosted child is on nearly every pass. A deletion therefore has nothing to
   * upsert over the shared row, and a basis for a position that closed hours
   * ago sits there indefinitely.
   *
   * The mirror calls such a row inert, and for the dashboard it is: the feed
   * joins basis to POSITIONS, so a basis for a symbol nobody holds never
   * renders. It is not inert for a repair that reads this ledger to say what a
   * position has left against it, which is why the apply clears it.
   */
  basisRemainingRaw: bigint | null;
  /** False when the vault's log could not be read end to end. */
  scanComplete: boolean;
}

export interface ClassPnlRepairPlan {
  facts: ClassRoundTripFacts;
  /** proceeds − cost, in USDG base units. Null when it refuses. */
  realizedRaw: bigint | null;
  /** True when no write is proposed, whatever the reason. */
  ambiguous: boolean;
  reason: string;
}

const f6 = (v: bigint): string => {
  const neg = v < 0n;
  const a = neg ? -v : v;
  return `${neg ? "-" : ""}${a / 1_000_000n}.${(a % 1_000_000n).toString().padStart(6, "0")}`;
};

/** Derive one trip's repair. PURE. */
export function planClassPnlRepair(facts: ClassRoundTripFacts): ClassPnlRepairPlan {
  const no = (reason: string): ClassPnlRepairPlan => ({ facts, realizedRaw: null, ambiguous: true, reason });

  if (!facts.scanComplete) {
    return no("the vault's log could not be read end to end, so the trip's own events are not all in hand");
  }
  if (facts.state !== "closed") {
    // `open` is the live path's job and `swept` has no result at all — the owner
    // took the asset, nothing was sold, and a withdrawal is not a trade.
    return no(
      facts.state === "swept"
        ? "the owner swept this position out — a withdrawal has no proceeds and no result to record"
        : `the position is ${facts.state}, not closed — only a completed round trip has a result`,
    );
  }
  if ((facts.sweptRaw ?? 0n) > 0n) {
    return no(
      "part of this position was swept out by the owner, so its proceeds and its withdrawal cannot be " +
        "told apart from the events alone",
    );
  }
  if (facts.exitTx === null) return no("no exit transaction on record");
  if (facts.costRaw === null || facts.proceedsRaw === null) {
    return no("the chain did not yield both a cost and a proceeds figure for this trip");
  }
  if (facts.costRaw <= 0n) return no("no cost on record — the proceeds would read as pure profit");
  if (facts.recordedRealizedUsdg !== null) {
    return {
      facts,
      realizedRaw: null,
      ambiguous: true,
      reason: `already recorded as ${facts.recordedRealizedUsdg.toFixed(6)} — nothing to repair`,
    };
  }
  if (facts.exitIntentRows !== 1) {
    // EXACTLY ONE ACCOUNTING OWNER. Zero means the intent row is missing and a
    // repair would have nowhere honest to write; more than one means the rows
    // cannot be told apart, and writing to both is the double count this whole
    // change exists to avoid.
    return no(
      `the exit transaction has ${facts.exitIntentRows} curve-trade rows, not 1 — a result must land on ` +
        `exactly one of them and this cannot say which`,
    );
  }

  const realized = facts.proceedsRaw - facts.costRaw;
  return {
    facts,
    realizedRaw: realized,
    ambiguous: false,
    reason:
      `${f6(facts.proceedsRaw)} proceeds − ${f6(facts.costRaw)} cost = ${f6(realized)} USDG, from the ` +
      `vault's own ClassBuy/ClassSell on ${facts.entryTx?.slice(0, 12) ?? "?"}… and ` +
      `${facts.exitTx.slice(0, 12)}…`,
  };
}

/** The report, as lines an operator decides on. */
export function classPnlRepairLines(plans: readonly ClassPnlRepairPlan[]): string[] {
  const L: string[] = [];
  const doable = plans.filter((p) => !p.ambiguous);
  L.push(
    `CLASS P&L REPAIR — ${plans.length} round trip(s) examined · ${doable.length} would be booked · ` +
      `${plans.length - doable.length} left alone`,
  );
  L.push("");
  for (const p of plans) {
    const x = p.facts;
    L.push(`── ${x.symbol}  ${x.token}`);
    L.push(`   tenant ${x.tenant}   state=${x.state}`);
    L.push(`   entry ${x.entryTx ?? "(none)"}`);
    L.push(`   exit  ${x.exitTx ?? "(none)"}`);
    L.push(
      `   chain: cost ${x.costRaw === null ? "UNKNOWN" : f6(x.costRaw)} · ` +
        `proceeds ${x.proceedsRaw === null ? "UNKNOWN" : f6(x.proceedsRaw)} · ` +
        `qty sold ${x.qtySoldRaw ?? "UNKNOWN"} · swept ${x.sweptRaw ?? "UNKNOWN"}`,
    );
    L.push(
      `   ledger: realised ${x.recordedRealizedUsdg === null ? "NOT RECORDED" : x.recordedRealizedUsdg.toFixed(6)} · ` +
        `basis remaining (shared) ${x.basisRemainingRaw === null ? "UNKNOWN" : f6(x.basisRemainingRaw)} · ` +
        `curve-trade rows on the exit tx ${x.exitIntentRows}`,
    );
    L.push(
      p.ambiguous
        ? `   NO CHANGE — ${p.reason}`
        : `   WOULD BOOK realised ${f6(p.realizedRaw!)} USDG onto the exit row`,
    );
    if (!p.ambiguous) L.push(`   why: ${p.reason}`);
    L.push("");
  }
  return L;
}
