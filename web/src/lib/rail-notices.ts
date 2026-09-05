/**
 * THE WARNINGS NOBODY HAS EVER SEEN.
 *
 * The worker has written `warn`-level events since it was built, and `/api/feed`
 * has always returned forty of them. No surface in the product has ever rendered
 * one: the single consumer of `events` picked `level === "err"` for the status
 * line and dropped everything else on the floor.
 *
 * What went over the side matters. `index.ts` raises "no bundler key — this
 * agent CANNOT trade live, and nothing it does will reach the chain" at exactly
 * the moment that becomes true, under a comment reading SAY IT WHERE THE OWNER
 * WILL LOOK. It was written, raised, stored, and filtered out of the only page
 * that reads events — so an audit of 1,311 intents and zero fills read as a
 * broken execution path, when the truth was that execution had never been
 * configured at all.
 *
 * Pure, and separated from the component, so the two rules below are pinned by a
 * test rather than by whoever next edits the JSX.
 */

export interface WorkerEvent {
  level: string;
  message: string;
  created_at: string;
}

export interface RailNotice {
  message: string;
  created_at: string;
}

/** How many to show. Three fits the block without turning it into a log. */
export const RAIL_LIMIT = 3;

/**
 * The distinct warnings worth putting in front of the owner, newest first.
 *
 * DEDUPED BY MESSAGE, because these are written once per ARM rather than once
 * per condition. An agent that restarts hourly raises the same sentence twenty
 * times, and an undeduped list would show one warning twenty times over instead
 * of the three different things that are actually wrong — which is the same
 * failure as showing none, arrived at from the other direction.
 *
 * Takes the FIRST sighting of each message and relies on the caller's newest-
 * first order (`/api/feed` sorts `created_at DESC, id DESC`), so the timestamp
 * shown is the most recent time the worker said it, not the first.
 */
export function railNotices(
  events: readonly WorkerEvent[] | null | undefined,
  limit: number = RAIL_LIMIT,
): RailNotice[] {
  if (!events || limit <= 0) return [];
  const seen = new Set<string>();
  const out: RailNotice[] = [];
  for (const e of events) {
    if (e.level !== "warn" || seen.has(e.message)) continue;
    seen.add(e.message);
    out.push({ message: e.message, created_at: e.created_at });
    if (out.length === limit) break;
  }
  return out;
}
