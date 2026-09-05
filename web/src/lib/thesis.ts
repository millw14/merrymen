/**
 * The publication gate, re-exported.
 *
 * The policy itself moved to `worker/src/thesis-policy.ts` ahead of a second
 * reader: the orchestrator is to materialise each child's followed theses into
 * a file the agent's desk reads, and what it writes has to be exactly what this
 * feed publishes. The worker cannot import from `web/src`, so the module moved
 * rather than being copied: two copies of a publication policy drift, and the
 * drift is invisible until something private lands on a page.
 *
 * The worker-side copy now has its second reader — peer-theses.ts — so the two
 * halves of the wire publish through one function. This comment claimed that
 * before it was true, for three weeks.
 *
 * This file exists so every `@/lib/thesis` import in the web tree keeps
 * working. Nothing here may add behaviour — a check that lives on this side
 * only would apply to the browser's copy and not to the agent's, which is the
 * exact asymmetry the move was made to prevent.
 */
export {
  PUBLISHABLE_SOURCES,
  PUBLISHABLE_STRATEGIES,
  SHADOW_SOURCES,
  REJECT_RULES,
  classifyDrop,
  outcomeOf,
  publishableThesis,
  rejectRuleLabel,
  type PublicThesis,
  type ThesisRow,
} from "@merrymen/thesis";
