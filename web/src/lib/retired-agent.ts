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
  /**
   * Whether THIS account's own `fleet_recovery_health` row reads held=1: the
   * supervisor recorded the recovery hold against it, and nothing may run it
   * until that clears. Optional, and absent is not held — a self-hosted or
   * older ledger has no such table, and a failed read proves nothing.
   */
  held?: boolean;
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

/**
 * THE INCIDENT WINDOW, unix seconds, both ends inclusive:
 * 2026-10-03T00:00:00Z to 2026-10-06T00:00:00Z.
 *
 * Trading was halted fleet-wide, and every hosted worker stopped beating with
 * it. From about 03:18 UTC on 10-05 — a day after those last beats — the rule
 * above began folding idle named agents (SirSendIt among them) into the
 * retired count, as if their owners had walked away. They had not: the hold
 * stopped them, and nothing they or their owners could do would restart them.
 *
 * A last beat inside this window is the account's OWN evidence that it was
 * running when the incident began. It opens a day before those last beats, so
 * an agent that stopped while the incident developed on 10-03 is not judged
 * by a guess at the exact minute: opened too early, a row that would have
 * folded says "Not running", which is true; opened too late, a held agent
 * leaves the board without a word. It closes at a fixed moment because
 * nothing beats while the fleet is halted — a worker the resume restarts
 * beats after it and is judged by the ordinary rules again. An account the
 * resume never restarts keeps its "Not running" row until this window is
 * retired, which is a deliberate one-line change once the holds have cleared.
 *
 * FIXED, NOT READ OFF THE FLEET. "The fleet's newest heartbeat" is a MAX over
 * other tenants' rows, written in two units, and one millisecond stamp among
 * them would move every agent's verdict. Each account is judged by its own
 * beat, normalised on its own row, and by nothing else.
 */
export const INCIDENT_WINDOW = {
  fromSec: 1_790_985_600,
  untilSec: 1_791_244_800,
} as const;

/** Seconds, whichever unit the row was written in — the web tier reads both. */
function seconds(t: number): number {
  return t > 1_000_000_000_000 ? Math.floor(t / 1000) : t;
}

function beating(a: AgentLifecycle, nowSec: number): boolean {
  return a.beatAt !== null && Number.isFinite(a.beatAt) && nowSec - seconds(a.beatAt) <= RECENT_BEAT_SEC;
}

/**
 * WHETHER THE RECOVERY HOLD EXPLAINS THIS ACCOUNT'S SILENCE.
 *
 * Only ever on the account's own evidence: its own hold row, or its own last
 * beat inside the incident window. Never another tenant's row, and never a
 * fleet-wide figure.
 *
 * A NAMED account only. An account with no public id has nothing to show but
 * the clone row this module exists to fold, held or not. And never a killed
 * one: an owner ended that agent, and no hold un-ends it.
 */
export function silencedByHold(a: AgentLifecycle): boolean {
  if (a.slug === null || a.status === "killed") return false;
  if (a.held === true) return true;
  if (a.beatAt === null || !Number.isFinite(a.beatAt)) return false;
  const beat = seconds(a.beatAt);
  return beat >= INCIDENT_WINDOW.fromSec && beat <= INCIDENT_WINDOW.untilSec;
}

/**
 * A row the board keeps, labels "Not running" — and says nothing more about.
 *
 * Silent for a day AND the hold is why. Deliberately not "expired" and not
 * "re-sign needed": the expiry stays withheld from the public row (see
 * read-leaderboard.ts), and a renewal asked for mid-hold is one the hold will
 * not act on — re-signing does not restart a held agent.
 */
export function notRunning(a: AgentLifecycle, nowSec: number): boolean {
  return silencedByHold(a) && !beating(a, nowSec);
}

export function isRetired(a: AgentLifecycle, nowSec: number): boolean {
  // KILLED IS OVER, whatever the heartbeat or the hold says.
  if (a.status === "killed") return true;

  // THE HOLD IS NOT AN ENDING. Checked before both folds below, because both
  // read silence as one: a key that lapsed while the fleet was halted lapsed
  // on an agent the hold had already stopped, and an idle agent that stopped
  // beating stopped because the hold stopped it. Either way the row stays and
  // reads "Not running" — the count of retired accounts is for agents that
  // are over, and these are not.
  if (silencedByHold(a)) return false;

  // OVER IS OVER, whatever the heartbeat says. `expiresAt` is checked as well
  // as the status because the worker only ever retires the grant it loaded: a
  // re-grant leaves the OLD account's row reading 'armed' for ever.
  if (a.status === "expired") return true;
  if (a.expiresAt !== null && Number.isFinite(a.expiresAt) && seconds(a.expiresAt) <= nowSec) return true;

  if (beating(a, nowSec)) return false;

  // Not beating. An account with no public id has nothing to show but the
  // clone row, so it goes. An idle agent that has also stopped beating was
  // refusing to trade and is now not even doing that.
  //
  // A NAMED agent with a good key stays through a quiet worker — and one that
  // has never beaten is a newborn, which "retired" would describe falsely.
  if (a.slug === null) return true;
  return a.mode === "idle";
}
