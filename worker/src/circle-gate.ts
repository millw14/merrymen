/**
 * THE MERRY CIRCLE GATE IS A BRAKE ON NEW WORK, NEVER A LOCK ON THE DOORS.
 *
 * even-keel and dip-hunter run in full only for a Merry Man holder
 * (registry.ts CIRCLE_STRATEGIES, 100,000 $MERRYMEN between the owner's wallet
 * and the agent's account — the same line energy calls "full"). Below it the
 * tick used to RETURN at the gate, before the strategy ticked and before the
 * class route's exits. So an agent already on one of them when its owner fell
 * short — tokens sold, a holder wallet now counted for another account, or a
 * restart whose first $MERRYMEN read had not answered yet — ran NO exits
 * at all: even-keel's trims never fired, and a class position on a curve with
 * a graduation deadline was never closed. Every energy surface meanwhile tells
 * that same owner exits are never limited.
 *
 * So below the tier the strategy still ticks, and what the breaker's own exit
 * test calls an exit (policy.ts isExitIntent — passed in, never copied) goes
 * on to the same path it always had. Everything else is dropped HERE, before
 * any decision row exists: no post, no refusal on the tape, the shape energy's
 * hard filter already has. The owner hears it once, from the Circle note.
 *
 * `idle` is dropped too. A locked strategy's idle reason ("the feeds are
 * stale", "under one buy") would tell the owner the wrong reason for a quiet
 * book: the Circle is why nothing new is bought, and the note says so.
 *
 * Pure, and in its own file: main() cannot be booted by a test, and a flag
 * inline in it can be reverted with every test still green.
 */
import type { TradeIntent } from "./policy";
import type { Tick } from "./strategies/types";

/**
 * The exits of a tick, each still paired with its own reason — `why` is
 * positional, so the two arrays are filtered together or not at all.
 */
export function circleExitsOnly(tick: Tick, isExit: (intent: TradeIntent) => boolean): Tick {
  const intents: TradeIntent[] = [];
  const why: Tick["why"] = [];
  for (const [at, intent] of tick.intents.entries()) {
    if (!isExit(intent)) continue;
    intents.push(intent);
    why.push(tick.why[at] ?? null);
  }
  return { intents, why };
}

/**
 * The class route's ENTRY gate while the Circle is short: closed, and silent.
 * The same shape idleAndClassGate returns, so the class-entry line in main()
 * reads the same either way. The class EXITS never pass through any gate.
 */
export const CIRCLE_SHORT_CLASS_GATE: { entries(propose: () => Promise<Tick>): Promise<Tick> } = Object.freeze({
  entries: async (): Promise<Tick> => ({ intents: [], why: [] }),
});
