import type { Tick } from "./strategies/types";

/**
 * Proposal generation is independent of the class/perps routes. A failed spot
 * producer supplies no orders this tick and is tried again next tick. This
 * boundary must never wrap execution or accounting: failures there still
 * interrupt the tick and retain the normal durable recovery rules.
 *
 * A strategist may hand off perp proposals before its spot proposal finishes.
 * Clear that ephemeral handoff at the start and after failure so neither an
 * earlier window nor a partly completed window can trade later.
 */
export async function produceStrategyTick(
  produce: () => Promise<Tick>,
  clearPerpHandoff: () => void,
): Promise<{ tick: Tick; failed: boolean }> {
  clearPerpHandoff();
  try {
    return { tick: await produce(), failed: false };
  } catch {
    clearPerpHandoff();
    return { tick: { intents: [], why: [] }, failed: true };
  }
}
