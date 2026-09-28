/**
 * BELOW THE MERRY CIRCLE TIER A CIRCLE STRATEGY DOES NOTHING OF ITS OWN, AND
 * THE CLASS EXITS STILL RUN.
 *
 * even-keel and dip-hunter run only for a Merry Man holder (registry.ts
 * CIRCLE_STRATEGIES, 100,000 $MERRYMEN between the owner's wallet and the
 * agent's account — the same line energy calls "full"). Below it the tick used
 * to RETURN at the gate, before the strategy ticked AND before the class
 * route's exits — so a class position on a curve with a graduation deadline was
 * never closed while the owner was short. The class exits are not the
 * strategy's: they run for every agent with a class vault, and they now run
 * below the tier exactly as above it (the wiring in main() is pinned in
 * circle-gate.test.ts).
 *
 * THE STRATEGY ITSELF DOES NOT TICK — NOT EVEN FOR ITS "EXITS". The first cut
 * of that fix let the strategy tick and passed on only what the breaker calls
 * an exit. For even-keel that is a rebalancer run one-sided: its target is
 * invested/N with cash excluded, so a trim with no top-up lowers the target,
 * which makes the other legs overweight, which trims them — every tick, into
 * USDG, the WHOLE book once any basket leg is empty (a real-code simulation
 * sold 200 USDG to cash in 114 ticks). Each of those sells is a public post, a
 * trade fee and one of the day's ops, which then refuses the owner's own buys.
 * A trim is not a risk exit; it is half of a rebalance, and half a rebalance is
 * a liquidation. dip-hunter only ever buys, so it had nothing to pass anyway.
 *
 * So below the tier the Circle strategy is not asked at all — no rebalancing
 * in either direction, its basket left exactly as it is, which is what the gate
 * always did to the strategy — and the class route proposes no entries. The owner hears it once,
 * from the Circle note in main(), and every surface says the same
 * sentence: it opens nothing new and leaves its basket as it is; positions in
 * the class vault are still closed by their own exit rules.
 *
 * `idle` goes with it. A locked strategy's idle reason ("the feeds are stale",
 * "under one buy") would tell the owner the wrong reason for a quiet book: the
 * Circle is why nothing moves, and the note says so.
 *
 * Pure, and in its own file: main() cannot be booted by a test, and a flag
 * inline in it can be reverted with every test still green.
 */
import type { Tick } from "./strategies/types";

/**
 * The Circle strategy's tick for this window: its own when the owner is at the
 * tier, and NOTHING — the strategy not even asked — when they are short.
 * `run` is the strategy's tick, called at most once.
 */
export async function circleStrategyTick(circleShort: boolean, run: () => Promise<Tick>): Promise<Tick> {
  if (circleShort) return { intents: [], why: [] };
  return await run();
}

/**
 * The class route's ENTRY gate while the Circle is short: closed, and silent.
 * The same shape idleAndClassGate returns, so the class-entry line in main()
 * reads the same either way. The class EXITS never pass through any gate.
 */
export const CIRCLE_SHORT_CLASS_GATE: { entries(propose: () => Promise<Tick>): Promise<Tick> } = Object.freeze({
  entries: async (): Promise<Tick> => ({ intents: [], why: [] }),
});
