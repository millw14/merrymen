/**
 * NET CONTRIBUTIONS, DURABLE FIRST — the one figure every consumer in the
 * child reads: the energy buy's pre-trade gate, the landing/resolver booking
 * gate, and the Brain's snapshot.
 *
 * WHY NOT THE LOCAL SUM. A hosted child's sqlite is wiped by every redeploy,
 * and nothing seeds flows back into it, so getNetContributionsUsdg answers
 * null for an account whose contributions are on record in the shared
 * database. The energy gates refused every buy after each deploy with copy
 * saying the agent "has no record of the capital put into it" (untrue, and it
 * pushed the owner to deposit more), and the landing-time booking refused a
 * purchase that had already moved money.
 *
 * WHY NOT THE ANCHOR ALONE. The orchestrator's anchor (bootstrap-state.ts) is
 * the durable figure at SPAWN; nothing updates it. The Brain snapshot read it
 * alone, so every energy purchase — and every deposit or withdrawal booked
 * after arm — looked like a gain or a loss of exactly its size until the child
 * respawned.
 *
 * SO: the anchor's figure plus what this child has booked SINCE the anchor
 * was written (its flows with `at` at or after the anchor's generatedAt, in the
 * anchor's epoch). A flow already in the anchor was booked by an earlier
 * process, before the parent wrote the file, so it is never counted twice.
 * And none is in NEITHER half: a flow that earlier process booked after the
 * mirror's last pass would be dated before the anchor and missing from the
 * shared sum, so the parent mirrors a dead child's ledger one last time before
 * deriving the anchor (orchestrator.ts finalMirrorBeforeAnchor).
 * With no anchor figure — self-hosted, where the local ledger IS the durable
 * record, or a hosted anchor that established nothing — or once this child has
 * moved to another epoch than the anchor's, the local epoch sum answers, as
 * before. Null only when neither knows anything: unknown, never zero.
 *
 * PURE. The caller reads the anchor (index.ts applyAccountingAnchor) and the
 * ledger (store.ts getNetContributionsSince) and passes both.
 */

/** A floating USDG figure → raw 6dp, rounded the one way every gate rounds. */
const usdg6 = (v: number) => BigInt(Math.round(v * 1e6));

export function durableNetContributionsUsdg6(a: {
  /** The anchor's net contributions, raw 6dp; null when the anchor established none. */
  anchorNetUsdg6: bigint | null;
  /** The epoch the anchor's figure is for. */
  anchorEpoch: number | null;
  /** The child's current accounting epoch. */
  epoch: number;
  /** Σ this epoch's local flows, USDG; null when none is on record. */
  localNetUsdg: number | null;
  /** Σ this epoch's local flows booked at or after the anchor was written, USDG. */
  localSinceAnchorUsdg: number;
}): bigint | null {
  if (a.anchorNetUsdg6 !== null && (a.anchorEpoch === null || a.anchorEpoch === a.epoch)) {
    return a.anchorNetUsdg6 + usdg6(a.localSinceAnchorUsdg);
  }
  return a.localNetUsdg === null ? null : usdg6(a.localNetUsdg);
}
