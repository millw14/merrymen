/**
 * WHICH AGENTS STILL BELONG ON THE BOARD.
 *
 * The leaderboard listed every `agents` row it could find, deduped by slug. So
 * every account from before the identity store — no slug, nothing linking to
 * it, nobody running it — rendered as another "Robin · 24 trades · –", and a
 * killed agent sat beside a live one as if the two were the same kind of
 * thing. The board read as a wall of clones.
 *
 * Retired agents are not deleted from anything. They are COUNTED — the board
 * says "Retired accounts (N)" — because hiding them without a word would be its
 * own small lie about how many agents there have been. Accounts, because that
 * is what is counted: a key from before the identity store is linked to no
 * slug, so an agent re-granted back then can leave one behind it.
 *
 * Its own module with NO IMPORTS, like rank-pnl.ts, so the rule is tested by
 * calling it rather than by standing up a ledger.
 */

/** What a row says about whether anything is still running it. */
export interface AgentLifecycle {
  /** The public id, or null for an account the identity store never linked. */
  slug: string | null;
  /** The last heartbeat's mode: 'live' | 'paper' | 'idle', or null for never. */
  mode: string | null;
  /** The worker's status: 'armed' | 'expired' | 'killed' | 'error'. */
  status: string | null;
  /** The last heartbeat, unix time. Null when it has never beaten. */
  beatAt: number | null;
  /** When the signed key stops working, unix seconds. */
  expiresAt: number | null;
}

/**
 * How recent a heartbeat has to be for "something is running this".
 *
 * A day, not a tick. The worker beats every tick, but a deploy, a crash-loop
 * cool-off or an overnight outage silences it without ending anything, and an
 * agent that blinks off the board for that is a board that cannot be trusted
 * either. A day is long enough to ride those out and short enough that an
 * account nobody has run in a week stops occupying a row.
 */
export const RECENT_BEAT_SEC = 24 * 3600;

/** Seconds, whichever unit the row was written in — the web tier reads both. */
function seconds(t: number): number {
  return t > 1_000_000_000_000 ? Math.floor(t / 1000) : t;
}

export function isRetired(a: AgentLifecycle, nowSec: number): boolean {
  // OVER IS OVER, whatever the heartbeat says. `expiresAt` is checked as well
  // as the status because the worker only ever retires the grant it loaded: a
  // re-grant leaves the OLD account's row reading 'armed' for ever.
  if (a.status === "killed" || a.status === "expired") return true;
  if (a.expiresAt !== null && Number.isFinite(a.expiresAt) && seconds(a.expiresAt) <= nowSec) return true;

  const beating = a.beatAt !== null && Number.isFinite(a.beatAt) && nowSec - seconds(a.beatAt) <= RECENT_BEAT_SEC;
  if (beating) return false;

  // Not beating. An account with no public id has nothing to show but the
  // clone row, so it goes. An idle agent that has also stopped beating was
  // refusing to trade and is now not even doing that.
  //
  // A NAMED agent with a good key stays through a quiet worker — and one that
  // has never beaten is a newborn, which "retired" would describe falsely.
  if (a.slug === null) return true;
  return a.mode === "idle";
}
