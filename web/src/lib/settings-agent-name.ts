/**
 * WHAT A SETTINGS SAVE DOES WITH THE `agentName` IT WAS SENT.
 *
 * Out of the route so it runs in a test with the one argument that matters:
 * the name ALREADY STORED. The route did this inline, and nothing executed it,
 * so handing the rule the wrong stored value — or none — would have stayed
 * green while every owner whose agent is "007" had every save refused.
 */
import { AGENT_NAME_RULE, agentNameAccepted, normalizeAgentName } from "./agent-name-rule";

export type AgentNameSave =
  /** Nothing sent, or blank: back to the default. */
  | { kind: "clear" }
  /** Store this, already in the soul's shape. */
  | { kind: "set"; name: string }
  /** Refused, with the words the owner is shown. */
  | { kind: "error"; message: string };

/**
 * THE SAME RULE THE SOUL ENFORCES — the web tier and the worker share one
 * constant (packages/core agent-name.ts). If the two ever disagreed the worker
 * won and silently kept the old name while this save said it succeeded.
 *
 * THAT INCLUDES THE NORMALISATION, not just the regex. The soul stores NFC
 * with whitespace collapsed; this stored a bare `.trim()`, and the rule admits
 * internal double spaces — so "Little  John" was kept verbatim here and
 * collapsed by the soul, `cfg.agentName !== getName()` was true forever, and
 * the reconcile rewrote the identity file every tick. Normalise once, at the
 * door.
 *
 * `stored` is what the settings hold NOW: a name equal to it is held to the
 * rule it was stored under (agentNameAccepted), so re-saving the form never
 * renames or blocks a "007".
 */
export function agentNameSave(value: unknown, stored: { readonly agentName?: unknown }): AgentNameSave {
  const norm = typeof value === "string" ? normalizeAgentName(value) : value;
  if (norm === "" || norm === null || norm === undefined) return { kind: "clear" };
  if (typeof norm !== "string" || !agentNameAccepted(norm, stored.agentName)) {
    // The old rule was ASCII-only and the old message said "letters and
    // numbers", which sent anyone called José or Робин round a loop they
    // could not escape by complying. The letter requirement is named for the
    // same reason: "007" starts with a number, so a message that stopped there
    // would be obeyed and refused again.
    return { kind: "error", message: `name: ${AGENT_NAME_RULE}` };
  }
  return { kind: "set", name: norm };
}
