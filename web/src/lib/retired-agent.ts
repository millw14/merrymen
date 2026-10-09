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
   * Whether THIS account's own `fleet_recovery_health` row reads held=1 and
   * was recorded inside the incident window (see inIncidentWindow): the
   * supervisor recorded this incident's hold against it, and nothing may run
   * it until that clears. Optional, and absent is not held — a self-hosted or
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
 * 2026-10-04T00:00:00Z to 2026-10-06T00:00:00Z.
 *
 * Trading was halted fleet-wide, and every hosted worker stopped beating with
 * it. From about 03:18 UTC on 10-05 — a day after those last beats — the rule
 * above began folding idle named agents (SirSendIt among them) into the
 * retired count, as if their owners had walked away. They had not: the hold
 * stopped them, and nothing they or their owners could do would restart them.
 *
 * A last beat inside this window is the account's OWN evidence that it was
 * running when the incident began. It opens at the start of 10-04, a few
 * hours before the fleet's last beats at about 03:18Z — no earlier, so that an
 * agent whose key lapsed or whose owner stopped it on 10-03, before the halt,
 * is not credited to the hold. NOTHING IN THE CODE RECORDS THE HALT'S MINUTE:
 * FLEET_HALT carries no time, and a hold row's `since_at` is when the row was
 * written (18:36Z on 10-04 for this incident's rows), not when trading
 * stopped. These bounds are therefore an operator's reading of the incident,
 * and Milla confirms them before this ships.
 *
 * It closes at a fixed moment because nothing beats while the fleet is halted
 * — a worker the resume restarts beats after it and is judged by the ordinary
 * rules again. An account the resume never restarts keeps its "Not running"
 * row until this window is retired. RETIRE IT once the holds have cleared:
 * delete this constant and every use of it, and the board is main's again.
 * That is a tracked follow-up, not something this module does on a date.
 *
 * FIXED, NOT READ OFF THE FLEET. "The fleet's newest heartbeat" is a MAX over
 * other tenants' rows, written in two units, and one millisecond stamp among
 * them would move every agent's verdict. Each account is judged by its own
 * beat, normalised on its own row, and by nothing else.
 */
export const INCIDENT_WINDOW = {
  fromSec: 1_791_072_000,
  untilSec: 1_791_244_800,
} as const;

/** Seconds, whichever unit the row was written in — the web tier reads both. */
function seconds(t: number): number {
  return t > 1_000_000_000_000 ? Math.floor(t / 1000) : t;
}

/**
 * Whether a stamp, in either unit, falls inside the incident window. One test
 * for both kinds of evidence an account carries: its own last beat, and when
 * its own hold row was recorded.
 *
 * WHY A HOLD ROW COUNTS ONLY FROM INSIDE IT. `fleet_recovery_health` is an
 * owner-scoped report (docs/fleet-history-recovery.md), and on the public
 * board a held row is the difference between a fold and a "Not running" row
 * — so honouring every held row would publish, to anyone comparing the board
 * over time, which agents have a recovery hold on their accounting source. A
 * fleet-wide halt is no secret; one tenant's source-continuity or
 * source-barrier hold recorded later is. This incident's rows were recorded
 * inside the window (18:36Z on 10-04), so the incident case is unchanged; a
 * row recorded after it stays the owner's, and the account's own beat still
 * speaks for it.
 */
export function inIncidentWindow(t: number | null): boolean {
  if (t === null || !Number.isFinite(t)) return false;
  const s = seconds(t);
  return s >= INCIDENT_WINDOW.fromSec && s <= INCIDENT_WINDOW.untilSec;
}

function beating(a: AgentLifecycle, nowSec: number): boolean {
  return a.beatAt !== null && Number.isFinite(a.beatAt) && nowSec - seconds(a.beatAt) <= RECENT_BEAT_SEC;
}

/**
 * OVER BEFORE THE HOLD BEGAN, on the account's own evidence: the ordinary
 * rules in isRetired had already folded it by the time the window opened.
 * Its key had lapsed — by its own expiry, or by its worker's word when the
 * row carries no expiry to date that by — or it was idle and had already been
 * silent for a day. The hold did not stop an agent that was over before it,
 * so neither a beat nor a hold row recorded for it since brings it back: the
 * reporter writes rows for stopped and expired tenants alike, and a key that
 * lapsed last year is not "Not running" because of this incident.
 */
function overBeforeHold(a: AgentLifecycle): boolean {
  const from = INCIDENT_WINDOW.fromSec;
  const lapsed =
    a.expiresAt !== null && Number.isFinite(a.expiresAt) ? seconds(a.expiresAt) < from : a.status === "expired";
  return lapsed || (a.mode === "idle" && !beating(a, from));
}

/**
 * WHETHER THE RECOVERY HOLD EXPLAINS THIS ACCOUNT'S SILENCE.
 *
 * Only ever on the account's own evidence: its own hold row, or its own last
 * beat inside the incident window. Never another tenant's row, and never a
 * fleet-wide figure. And never for an account that was over before the hold
 * began — see overBeforeHold.
 *
 * A NAMED account only. An account with no public id has nothing to show but
 * the clone row this module exists to fold, held or not. And never a killed
 * one: an owner ended that agent, and no hold un-ends it.
 */
export function silencedByHold(a: AgentLifecycle): boolean {
  if (a.slug === null || a.status === "killed") return false;
  if (overBeforeHold(a)) return false;
  if (a.held === true) return true;
  return inIncidentWindow(a.beatAt);
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
  //
  // SILENT ones only — the same test that labels the row. An account still
  // beating is not one the hold has stopped, whatever its evidence says, so it
  // is judged by the ordinary rules below: a worker restarted mid-window whose
  // key then lapses is folded as expired, as it was before, rather than kept
  // as an unlabelled row for a day and labelled "Not running" after it.
  if (notRunning(a, nowSec)) return false;

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
