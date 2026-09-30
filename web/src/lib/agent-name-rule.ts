/**
 * WHAT THE WEB TIER WILL STORE AS AN AGENT'S NAME — one door for every write.
 *
 * The rule itself lives in packages/core (agent-name.ts), and the soul imports
 * the same constant, so the web tier and the worker cannot disagree about a
 * name: when they did, the worker won and silently kept the old name. Inside
 * the web tier there were two writers — the settings route, and partner
 * enrollment, which accepted any 1-24 characters — so a partner could enroll
 * "007", get a 200, and have its agent run as Robin. Both write through this.
 *
 * Re-exported rather than imported from core at each writer, so the words an
 * owner is refused with (AGENT_NAME_RULE) and the rule they describe are found
 * in one place by anyone who opens this file.
 */
import { AGENT_NAME_RE, STORED_AGENT_NAME_RE, normalizeAgentName } from "@merrymen/core";

export { AGENT_NAME_RE, STORED_AGENT_NAME_RE, normalizeAgentName };

/**
 * The refusal, in words an owner can comply with. The letter requirement is
 * named because "007" starts with a number, so a message that stopped there
 * would be obeyed and refused again.
 */
export const AGENT_NAME_RULE = "1-24 characters, starting with a letter or number and containing at least one letter";

/**
 * WHETHER A SETTINGS SAVE MAY STORE `norm` AS THE AGENT'S NAME.
 *
 * The letter rule is for a name somebody is choosing NOW. An agent that was
 * already called "007" when the rule arrived keeps that name — the owner was
 * promised no existing agent is renamed, and the worker already honours that
 * (soul.ts carryStoredName). Without this, the web tier would break the promise
 * from the other side: the Settings screen sends the whole form back on every
 * save, so an owner whose agent is "007" could not change ANY setting without
 * first renaming it — the save would come back refused on a field they never
 * touched.
 *
 * So a name equal to the one already stored is held to the rule it was stored
 * under, and only a different name has to meet the new one.
 */
export function agentNameAccepted(norm: string, stored: unknown): boolean {
  if (AGENT_NAME_RE.test(norm)) return true;
  return typeof stored === "string" && normalizeAgentName(stored) === norm && STORED_AGENT_NAME_RE.test(norm);
}
