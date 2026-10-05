/**
 * HAS THIS AGENT'S WORKER STOPPED? — one rule, decided on the server.
 *
 * `mode` is the last thing a worker said, and a stopped worker goes on saying
 * it: the mirrored `agents` row keeps whatever the final tick wrote. So an agent
 * whose process had died wore LIVE or PAPER on the desk, the profile and in what
 * the chat was told, while it placed nothing and watched nothing. The heartbeat
 * time was on the same response the whole while; nothing read it.
 *
 * ── WHY THE SERVER DECIDES ───────────────────────────────────────────────
 *
 * The heartbeat is a server timestamp. Comparing it with a browser's clock
 * makes the verdict depend on how wrong that laptop's clock is, and inventing a
 * threshold here would be a second staleness rule beside the one the MCP tools
 * already state (`freshWithin` in lib/services/agent-status.ts, which is the
 * orchestrator watchdog's). Two rules is two answers about one agent. So
 * `/api/grants` asks `workerStale` with its own clock and says `workerStale`;
 * the page only reads that answer back (`workerSilentSince`).
 *
 * ── WHY A MODULE AND NOT A LINE IN App.tsx ───────────────────────────────
 *
 * App.tsx is a page component the test runner cannot import, and a threshold
 * nobody can run is a threshold nobody has checked. Both halves live here so
 * stale-autonomy.test.ts can run them.
 *
 * PRESENTATION ONLY. Nothing here stops, starts or unblocks anything; a bug can
 * only mislabel, which is the same contract autonomy.ts keeps.
 */
import { freshWithin } from "@/lib/services/agent-status";

/**
 * Slack on top of the watchdog's window, for the hop the watchdog never makes.
 *
 * The watchdog reads the child's heartbeat FILE on its own disk. This reads the
 * MIRRORED row, which reaches the shared database on the orchestrator's pass —
 * fifteen seconds when the pass is quiet, longer when it is not — and is then
 * compared with a different container's clock. Two minutes absorbs several slow
 * passes, so a healthy agent never flickers to NOT RUNNING between mirrors, and
 * still says it within minutes of the watchdog itself giving up on the child.
 */
export const WORKER_STALE_MARGIN_SEC = 120;

/**
 * A heartbeat in whole seconds, whichever unit it was written in; null when it
 * is absent or not a time.
 *
 * Both writers use seconds today (store.ts setAgentMode, command-wake.ts
 * writeHeartbeat), but the column is a bare INTEGER and the web tier already
 * reads it in both units, with this same cut (retired-agent.ts `seconds`).
 * Read as seconds, a millisecond beat is tens of thousands of years in the
 * future: forever fresh, which is the lie this module removes.
 */
export function beatSeconds(v: number | null | undefined): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return Math.floor(v > 1e12 ? v / 1000 : v);
}

/**
 * Has the worker been quiet for longer than it ever is while running?
 *
 *   true    its last beat is older than `freshWithin(tick)` plus the margin
 *   false   it beat inside that window
 *   null    it has never beaten — which is not stale and not fresh. A new
 *           agent waiting for its first tick is not a stopped one, and the
 *           idle arm already says what is true of it.
 *
 * `tickSeconds` is the owner's own cadence, or null for the default; a longer
 * tick earns a longer window, exactly as the watchdog grants it.
 */
export function workerStale(
  beatAt: number | null | undefined,
  nowSec: number,
  tickSeconds: number | null | undefined,
): boolean | null {
  const beat = beatSeconds(beatAt);
  if (beat === null) return null;
  return nowSec - beat > freshWithin(tickSeconds) + WORKER_STALE_MARGIN_SEC;
}

/**
 * The page's half: `autonomyOf`'s `workerSilentSince`, from what /api/grants
 * said — the last beat when the SERVER called it stale, and null otherwise.
 *
 * An older server sends no `workerStale` at all, and that reads as null: the
 * agent is described as it describes itself, exactly as before.
 */
export function workerSilentSince(
  status: { workerStale?: boolean | null; workerAliveAt?: number | null } | null | undefined,
): number | null {
  if (status?.workerStale !== true) return null;
  return beatSeconds(status.workerAliveAt);
}
