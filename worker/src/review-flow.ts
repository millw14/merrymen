/**
 * ON-CHAIN FLOW FOR A TRENCHER ENTRY REVIEW — the child's side of the
 * orchestrator's flow lane (flow-broker.ts; docs/bitquery-lane.md).
 *
 * WHO GETS IT. Research accounts' entry reviews only: index.ts asks exactly
 * where the momentum plan goes (`costContext`), and only with a fresh tape row,
 * because a review without one is never paid for. The orchestrator re-checks
 * the research allowlist on every request, by the account it spawned us for.
 *
 * WHAT IT MAY COST THE REVIEW. Nothing past its existing evidence budget. The
 * question starts when the review does, beside the candle and trade legs and
 * the cost quotes, and is given up at EVIDENCE_BUDGET_MS, the clock those run
 * on. A reading that lands later is not waited for; the lane still caches it
 * for the next review of the coin.
 *
 * WHEN NOTHING CHANGES. Without the orchestrator's flag (the lane is off here,
 * or there is no channel) there is no client and no question. A Brain that
 * does not list the key in /health `lens_keys` is not asked either. Either
 * way the request is today's, byte for byte, and no question is sent.
 *
 * WHAT THE BRAIN IS GIVEN. renderFlowLens's block — figures allowed, it is the
 * Brain's and never X's — under `onchain-flow`, which Brain's manager reads
 * beside the measured market input (services/brain graph.py ONCHAIN_FLOW). A
 * failed read, an hour with no indexed trades or anything address-shaped
 * sends nothing: a missing reading is never "no flow".
 */
import type { ShadowOutcome } from "./brain-shadow";
import { createFlowClient, FLOW_BROKER_ENV, processFlowPort, type FlowClient, type FlowPort } from "./flow-broker";
import { ONCHAIN_FLOW_LENS, renderFlowLens } from "./flow-facts";

export { ONCHAIN_FLOW_LENS };

/** This child's flow client, or null when the orchestrator did not say a broker answers here. */
export function reviewFlowClient(
  env: NodeJS.ProcessEnv = process.env,
  port: () => FlowPort | null = () => processFlowPort(),
): FlowClient | null {
  if (env[FLOW_BROKER_ENV] !== "1") return null;
  const p = port();
  return p ? createFlowClient(p) : null;
}

export interface FlowEvidence {
  /** The block for the Brain, or null when there is nothing honest to send. */
  lens: string | null;
  /** For the review's log line: "lens", "no-block" (read, nothing to render) or the failure word. */
  status: string;
}

/** Ask once, bounded by `budgetMs`. Never throws, never waits past it. */
export async function readFlowEvidence(
  client: Pick<FlowClient, "facts">,
  token: string,
  budgetMs: number,
  now: () => number = Date.now,
): Promise<FlowEvidence> {
  try {
    const r = await client.facts(token, { timeoutMs: budgetMs });
    if (!r.ok) return { lens: null, status: r.failure };
    const lens = renderFlowLens(r, now());
    return { lens, status: lens ? "lens" : "no-block" };
  } catch {
    return { lens: null, status: "unavailable" };
  }
}

/**
 * A decide that CARRIED the key came back unreachable — how an older Brain's
 * 422 for an unknown signals key arrives. The caller turns the key off until a
 * /health read made after this says yes again (BrainCapabilityProbe
 * invalidate), as fomo-child.ts does for `trader-flow`.
 */
export function flowLensRefused(sent: boolean, outcome: ShadowOutcome): boolean {
  return sent && outcome.ran && !outcome.result.ok && outcome.result.kind === "unreachable";
}
