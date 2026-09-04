/**
 * HOW A CAPITAL FLOW CAME TO BE KNOWN — one rule, shared by both tiers.
 *
 * This lives in `core` rather than in the worker because the worker and the web
 * were each carrying their own answer, and the two disagreed in both directions.
 * The worker's accounting anchor counted `('chain-log','epoch-carry')`; the
 * public agent page counted `('chain-log','transfer-intent')`. So an agent that
 * had crossed an accounting-epoch boundary was publicly told its bridged capital
 * was guesswork while the anchor, reading the same row from the same database at
 * the same moment, counted it as evidence.
 *
 * A rule that decides whether a number may be published has to have exactly one
 * definition, or the tiers will keep drifting apart in ways nobody notices until
 * they contradict each other in front of an owner.
 */

/**
 * The four ways a flow gets on the books, ranked by what each can support.
 *
 *   chain-log        read off a USDG Transfer log naming this account. A receipt:
 *                    anyone with an RPC can refetch it. The only evidence that
 *                    survives distrust of the operator.
 *   epoch-carry      the closing equity of the epoch just closed, written as the
 *                    new one's opening balance. NOT a receipt — it has no
 *                    transaction and never can — but not guesswork either: it is
 *                    a deterministic function of a figure already in the journal,
 *                    and it is CHECKABLE against that epoch's final equity mark.
 *   transfer-intent  a transfer this agent itself initiated. Known by
 *                    construction, but the settlement is never re-read, so it is
 *                    an intention rather than an observation.
 *   inferred         deduced from a balance change nobody can point at. An
 *                    opinion — and the specific shape that a redeploy's phantom
 *                    opening balance and the mirror's cursor rewind both produce.
 */
export type FlowEvidence = "chain-log" | "epoch-carry" | "transfer-intent" | "inferred";

/**
 * The sources that can support a published contribution total.
 *
 * `transfer-intent` is deliberately absent. It is exact about what was ASKED for
 * and silent about what settled, and a contribution total is a claim about money
 * that actually arrived.
 */
export const EVIDENCED_FLOW_SOURCES: readonly FlowEvidence[] = ["chain-log", "epoch-carry"];

/** Takes a bare string, because it is fed straight from a database column. */
export function isEvidencedFlow(source: string): boolean {
  return (EVIDENCED_FLOW_SOURCES as readonly string[]).includes(source);
}
