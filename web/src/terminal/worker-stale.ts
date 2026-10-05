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
 * It is that rule WIDENED, never narrowed — by a margin for the mirror and a
 * floor of one order's run, both below — because hosted it judges the mirrored
 * row, which lags the file the watchdog reads. Where the two disagree, this one
 * is the later to say "stopped", never the earlier.
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
import { ORDER_IN_FLIGHT_MS } from "@/lib/order-state";

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
 * NEVER SHORTER THAN ONE ORDER'S RUN, whatever the tick.
 *
 * Hosted, the beat judged here is the `agents` row, and the worker writes that
 * row only when a tick STARTS (heartbeat() → setAgentMode). While an order is
 * in flight the clock holds ticks back and keeps only the FILE beating
 * (command-wake.ts, every ALIVE_BEAT_EVERY_MS for as long as the work has moved
 * within ORDER_IN_FLIGHT_MS). The watchdog reads the file, so it rightly sees a
 * live child; the row can meanwhile be one order's run old. On a short tick
 * the watchdog's window is shorter than that run — 330s at a one-minute tick
 * against a ten-minute bound — so an agent waiting on a slow receipt would
 * have been called NOT RUNNING in the middle of its own trade.
 *
 * Floored at the bound rather than special-cased per source: self-hosted the
 * file does carry the held beat, and the floor costs it only a few minutes
 * before the label on a short tick. The default tick's window is already
 * longer than the floor. A label late by minutes is a smaller wrong than one
 * that says "not placing trades" over a trade.
 *
 * NOT COVERED: a regular tick that runs several trades back to back, each one
 * settling inside the bound, keeps the file beating for longer than one order's
 * run with no new row. Closing that needs the clock's held beat to write the
 * row too, which is worker code, not a rule this module can state.
 *
 * The same figure the order slot uses (lib/order-state.ts), which a test holds
 * equal to the worker's.
 */
const ORDER_HOLD_SEC = ORDER_IN_FLIGHT_MS / 1000;

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
 *   true    its last beat is older than `freshWithin(tick)` — or one order's
 *           run, whichever is longer — plus the margin
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
  return nowSec - beat > Math.max(freshWithin(tickSeconds), ORDER_HOLD_SEC) + WORKER_STALE_MARGIN_SEC;
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
