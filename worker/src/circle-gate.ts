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
 * from circleNote below (once per change of reason), and every surface says the same
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
import { ENERGY } from "../../packages/core/src/index";
import type { EnergyLevel } from "../../packages/core/src/index";
import { count } from "./energy-copy";
import type { Tick } from "./strategies/types";

// ── is the owner at the tier? ──────────────────────────────────────────────

/**
 * THE GATE'S ANSWER, WHICH IS NOT THE FEE'S.
 *
 * THE FEE STAYS EXACT. `holderTier` (index.ts) moves only on a read where
 * every part answered and prices the performance-fee discount: a discount is
 * money, so it is granted on nothing less, and an outage keeps the last one
 * read. `tierUnlocks` is that tier's own answer, and it still unlocks.
 *
 * THE GATE MAY NOT FALL SHORT BECAUSE A READ FAILED. holderTier starts at the
 * outsider in every new process and is set only when a read answers — so after
 * a restart (every hosted redeploy) whose first $MERRYMEN read failed, routine
 * on a fleet whose mainnet reads are refused, a Merry Man's Circle strategy
 * stopped rebalancing, told them "we could not read", and waited for the
 * chain. So the gate also takes energy's standing (energy.ts energyLevel over
 * the same read): full when what WAS read already clears the line (the parts
 * that answered are a lower bound), or, when a part failed, the last reading
 * that decided it within ENERGY.lastGoodMaxAgeSec — energy_days.read_at /
 * read_full, which the mirror and the seed carry across a redeploy. It is the
 * same line (ENERGY.fullTokens is the Merry Man tier's minTokens) read the
 * same way, so energy and the Circle cannot disagree about whether this owner
 * holds enough; and it grants nothing that was not read, at least in part, in
 * the last day.
 *
 * `known` says whether a shortfall rests on a reading — this tick's or the
 * carried one — which picks the honest Circle note: "you are short" or "we
 * could not read" (circleNoteStep's `readOk`).
 */
export function circleStanding(i: { tierUnlocks: boolean; level: EnergyLevel }): { unlocked: boolean; known: boolean } {
  if (i.tierUnlocks || i.level === "full") return { unlocked: true, known: true };
  return { unlocked: false, known: i.level !== "unread" };
}

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

// ── the Circle note ────────────────────────────────────────────────────────

/**
 * Which Circle note the owner was last given: none, "our read failed", or
 * "you are short". Kept by main() across ticks.
 */
export type CircleNoted = "unread" | "short" | null;

/**
 * ONCE PER CHANGE OF REASON, NOT ONCE PER SHORTFALL.
 *
 * The latch used to be a boolean keyed on `circleShort` alone. A child whose
 * FIRST $MERRYMEN read failed (holderTier starts at the outsider until a read
 * answers) sent "that is our read failing — it should clear on its own", set
 * the latch, and when the next read answered and showed the owner really was
 * short, said nothing: on iOS and Android that first sentence was the owner's
 * only word, and it never cleared. So the latch remembers WHICH sentence went
 * out, and unread → short is said again.
 *
 * Not the other way round: an owner already told they are short is not then
 * told a read failed. The tier kept is the last one read (the index.ts rule),
 * so "short" still stands, and a flapping RPC must not turn into a stream of
 * notes. Reaching the tier clears the latch, so a later shortfall is news.
 */
export function circleNoteStep(
  noted: CircleNoted,
  now: { short: boolean; readOk: boolean },
): { noted: CircleNoted; say: Exclude<CircleNoted, null> | null } {
  if (!now.short) return { noted: null, say: null };
  if (now.readOk) return noted === "short" ? { noted, say: null } : { noted: "short", say: "short" };
  return noted === null ? { noted: "unread", say: "unread" } : { noted, say: null };
}

/**
 * THE SENTENCE — what a short Circle agent does, said the way every surface
 * says it (web Agent.tsx banner, Settings, CreateAgent, iOS GrantScreen,
 * Android SettingsEditor): it opens nothing new and leaves its basket as it
 * is; positions in a class vault are still closed by their own exit rules.
 * Never "exits always run" — the strategy's own trims do not.
 *
 * WHERE THE TOKENS COUNT. The agent's account counts toward the tier only on
 * Robinhood Chain (index.ts energyAccount); on a grant anywhere else, "between
 * your wallet and my account" names an account whose $MERRYMEN would not
 * count, so that owner is told the one place that does — energy-copy.ts says
 * it the same way.
 */
export function circleNote(
  say: Exclude<CircleNoted, null>,
  f: { strategyName: string; accountCounts: boolean },
): string {
  const idle = "it opens nothing new and leaves its basket as it is; positions in a class vault are still closed by their own exit rules";
  if (say === "unread") {
    return (
      `${f.strategyName} is a Merry Circle strategy and we could not read your $MERRYMEN balance this tick, so until ` +
      `we can, ${idle}. That is our read failing, not your wallet — it should clear on its own.`
    );
  }
  const where = f.accountCounts ? "between your wallet and my account" : "in your own wallet on Robinhood Chain";
  return (
    `${f.strategyName} is a Merry Circle strategy — hold ${count(ENERGY.fullTokens)} $MERRYMEN ${where} ` +
    `(Merry Man tier) to run it; idle until then: ${idle}.`
  );
}
