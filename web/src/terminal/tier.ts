import type { TierView } from "@/app/api/tier/route";

/**
 * THIS ACCOUNT'S STANDING AGAINST THE CIRCLE RULE — fetched the same way by
 * every screen that asks, because they were each getting it slightly wrong.
 *
 * All three call sites were `r.ok ? r.json() : null` with `.catch(() => {})`,
 * so a 500, a dropped connection or an offline tab left `tier === null` — and
 * every consumer reads null as "not known yet, say nothing". The banner that
 * exists to explain why a holder-only strategy is idle therefore disappears in
 * exactly the situation where somebody is most likely to be staring at an idle
 * agent wondering why. That is the original complaint rebuilt as a failure
 * mode: "I had to go to /api/circle to check that, and that's not good for
 * normies."
 *
 * A FAILED FETCH IS `unreadable`, WHICH THE SCREENS ALREADY HANDLE. The route
 * returns that arm when the CHAIN will not answer; this returns it when the
 * ROUTE will not answer. Both are the same fact for a reader — we could not
 * check — and both have the same remedy, which is to wait rather than to go
 * and buy tokens. What must never happen is the third thing: rendering "you
 * hold 0" or nothing at all because our own request failed.
 *
 * `tokens` stays null in that arm, never 0. A zero here is the number that
 * sends somebody to buy $MERRYMEN they may already hold. The same for both of
 * its parts — the owner's wallet and the agent's account — and `energyGate` is
 * false, because a flag we did not read must not add a sentence about energy.
 */
export const UNREADABLE_TIER: TierView = {
  why: "unreadable",
  tokens: null,
  holderTokens: null,
  agentTokens: null,
  agentAccount: null,
  energyGate: false,
  tierId: null,
  tierName: null,
  bonusStrategies: false,
  // The bar itself is a constant of the product, not something we just failed
  // to read, so it is safe — and useful — to keep stating it.
  needTokens: 100_000,
  wallet: null,
  source: null,
};

/** Never rejects, and never resolves to null. */
export async function loadTier(): Promise<TierView> {
  try {
    const r = await fetch("/api/tier", { cache: "no-store" });
    if (!r.ok) return UNREADABLE_TIER;
    const t = (await r.json()) as TierView;
    // A body that is not a TierView is an unread balance, not a zero one.
    return t && typeof t.why === "string" ? t : UNREADABLE_TIER;
  } catch {
    return UNREADABLE_TIER;
  }
}

/**
 * WOULD A NEW AGENT RUN THE CIRCLE STRATEGIES ON THE OWNER'S WALLET ALONE?
 *
 * `bonusStrategies` is the COMBINED standing — the owner's wallet plus their
 * current agent's account. A new agent is a new account, and it starts empty:
 * whatever the current one holds stays with it. So the create flow judges the
 * wallet alone, and an unread wallet is never a qualifying one.
 */
export function newAgentQualifies(tier: TierView): boolean {
  return tier.holderTokens !== null && tier.holderTokens >= tier.needTokens;
}
