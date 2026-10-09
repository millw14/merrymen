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
import type { AgentStatus } from "@/app/api/grants/route";

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
 * before the label on a short tick. From a tick of 255s up the watchdog's
 * window is the longer and the floor changes nothing; at the default 240s it
 * adds thirty seconds. A label late by minutes is a smaller wrong than one
 * that says "not placing trades" over a trade.
 *
 * NOT COVERED: a regular tick that runs several trades back to back, each one
 * settling inside the bound, keeps the file beating for longer than one order's
 * run with no new row. Closing that needs the clock's held beat to write the
 * row too, which is worker code, not a rule this module can state.
 *
 * STATED HERE, NOT IMPORTED. It is ORDER_IN_FLIGHT_MS in lib/order-state.ts,
 * but that is order code, and /api/grants — which imports this module — sits on
 * the chat model's lazily loaded path, which mcp/tools/chat.test.ts audits for
 * reaching no order code at all. stale-autonomy.test.ts holds the two equal.
 */
export const ORDER_HOLD_SEC = 10 * 60;

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
 *
 * TYPED FROM THE ROUTE'S OWN DECLARATION, not restated here. The page's account
 * type (HostedControls.tsx) does not name the field, so this read is
 * structural; a shape spelled out here would let the route rename the field
 * with tsc green and NOT RUNNING silently never shown. Picked from
 * `AgentStatus`, a rename fails to compile.
 */
export function workerSilentSince(
  status: Pick<AgentStatus, "workerStale" | "workerAliveAt"> | null | undefined,
): number | null {
  if (status?.workerStale !== true) return null;
  return beatSeconds(status.workerAliveAt);
}

/**
 * WHEN IT WENT QUIET, as the desk and the desktop say it under the pill — the
 * verdict's own sentence, made one; null for any other state.
 *
 * The pill alone said NOT RUNNING and nothing else, so an owner could not tell
 * a two-minute blip from a six-hour outage, though the verdict had the time all
 * along (autonomy.ts `notRunning`). The words stay the verdict's, so the screen
 * and anything else that quotes `reason` give the same instant.
 *
 * Read from the DISPLAYED verdict: a recovery hold replaces the state, so a
 * held tenant is told about the hold and never about a silence the hold
 * explains.
 */
export function notRunningNote(a: { state: string; reason: string | null } | null | undefined): string | null {
  if (a?.state !== "not-running" || !a.reason) return null;
  return `${a.reason.charAt(0).toUpperCase()}${a.reason.slice(1)}.`;
}
