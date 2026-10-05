/**
 * ENTRY GATES — propose only the buys the wall accepts.
 *
 * THE REFUSAL THAT DOMINATED THE TAPE. A basket leg, a trencher candidate or a
 * model's pick can name a token the signed key cannot sell back. checkPolicy
 * refuses that buy with `no-exit` (or, on the curve venue, `asset-allowlist`)
 * and it is right to: the position could be opened and never closed. But the
 * strategy that proposed it read nothing that said so, so it proposed the same
 * buy on the next tick, and the next — a rejected row a tick, per leg, for the
 * life of the grant, and with the Brain required a paid review in front of each.
 *
 * WHAT THIS IS. The two rules a strategy can know in advance — the asset
 * allowlist and `no-exit` — read from the SAME limits checkPolicy judges, and
 * handed to the strategies as a snapshot hint (`Snapshot.entryGates`), the way
 * `spendHeadroomUsdg`, `opsHeadroom` and `drawdown` already are. A strategy
 * that reads it simply does not propose what the wall is certain to refuse.
 *
 * WHAT THIS IS NOT, and each line is load-bearing:
 *
 *   NOT A RULE. policy.ts and the wall are unchanged and remain the only
 *   authority. A gate here only ever SHRINKS what is proposed; anything that
 *   ignores it is refused by checkPolicy exactly as before, and spending stays
 *   bounded by the same caps.
 *
 *   NEVER ON AN EXIT. The direction of travel is judged by what is BOUGHT, as
 *   policy.ts judges it, and `intentEntryGate` asks isExitIntent first. An exit
 *   must always be attemptable.
 *
 *   ONE DIRECTION ONLY. A gate implies checkPolicy refuses with the same rule
 *   (entry-gates.test.ts drives every gated case through checkPolicy). The
 *   converse is not claimed: the scout budget and the caps still refuse things
 *   no gate here names. A gate the wall would NOT refuse would be this mirror
 *   going stricter than the chain — the bug policy.ts is written against.
 *
 * Pure: no store, no clock, no model. index.ts builds the hint from
 * `active.limits` and keeps the per-arm latch below.
 */

import { isExitIntent, type AgentLimits, type TradeIntent } from "./policy";

/** The two rules a gate can name — spelled exactly as checkPolicy spells them. */
export type EntryGateRule = "asset-allowlist" | "no-exit";

/**
 * Which branch of checkPolicy the buy goes through. They read different lists,
 * so the same token can be gated on one venue and not on the other.
 */
export type EntryVenue = "swap" | "curve";

/**
 * The snapshot hint: the two lists checkPolicy reads, lowercased once.
 *
 * `sellable` NULL MEANS THE RULE CANNOT RUN — a fixture or backtest with no
 * grant to reason about, which is also what `AgentLimits.sellableAssets`
 * undefined means to checkPolicy. Never an empty set standing in for "unknown":
 * an empty set gates every buy, which is what checkPolicy does with an empty
 * list too.
 */
export interface EntryGates {
  /** `AgentLimits.allowedAssets` — USDG plus the watch set (settings-derived). */
  allowed: ReadonlySet<string>;
  /** `AgentLimits.sellableAssets` — what the signed key can approve for a sell. */
  sellable: ReadonlySet<string> | null;
}

const lc = (a: string) => a.toLowerCase();

/** Built from the limits checkPolicy judges against, so the two cannot drift. */
export function entryGatesOf(limits: Pick<AgentLimits, "allowedAssets" | "sellableAssets">): EntryGates {
  return {
    allowed: new Set(limits.allowedAssets.map(lc)),
    sellable: limits.sellableAssets ? new Set(limits.sellableAssets.map(lc)) : null,
  };
}

/**
 * Would the wall refuse a BUY of `token` on this venue — and with which rule?
 * Null means no gate here says so (the wall may still refuse for another reason).
 *
 * Absent or null `gates` means NOT READ, and gates nothing — the same rule every
 * other snapshot hint follows: a strategy that went quiet on an unread hint
 * would be inventing a refusal nobody made.
 *
 *   swap  — checkPolicy's swap branch: `asset-allowlist` when the token is not
 *           in allowedAssets, then `no-exit` when the key cannot sell it. In
 *           that order, because that is the order the wall asks.
 *   curve — the curve-trade branch for a NON-CLASS trade: both legs must be in
 *           sellableAssets, and a miss is `asset-allowlist`. allowedAssets is
 *           not consulted there, so it is not consulted here — gating on it
 *           would be stricter than the wall.
 */
export function entryGateFor(
  gates: EntryGates | null | undefined,
  token: string,
  venue: EntryVenue = "swap",
): EntryGateRule | null {
  if (!gates) return null;
  const t = lc(token);
  if (venue === "curve") return gates.sellable !== null && !gates.sellable.has(t) ? "asset-allowlist" : null;
  if (!gates.allowed.has(t)) return "asset-allowlist";
  if (gates.sellable !== null && !gates.sellable.has(t)) return "no-exit";
  return null;
}

/**
 * How many of a strategy's legs the swap gate refuses — the figure a
 * `legs-locked` reason carries.
 *
 * OVER THE WHOLE BASKET, not over whichever legs reached the gate this tick.
 * A locked leg that is also stale is skipped as stale, so a per-tick count
 * would say "1 of the 3 legs" about a basket with two locked, and would change
 * with the feeds — which, to the once-per-change idle channel, is a new
 * sentence every time a market opens or shuts.
 */
export function lockedLegs(gates: EntryGates | null | undefined, legs: readonly { token: string }[]): number {
  return legs.filter((l) => entryGateFor(gates, l.token) !== null).length;
}

/**
 * The gate for a whole intent: which token it is ENTERING, and the rule the
 * wall would refuse it with. Null for everything a gate must not touch:
 *
 *   an exit         — isExitIntent, the breaker's own test. Never gated.
 *   trencher custody — the autonomous rail is judged against the vault's
 *                     chain-verified assets, not these lists (policy.ts).
 *   a class trade   — the class vault may leave the class token itself
 *                     un-enumerated by design; the anchor leg is USDG.
 *   anything else   — vault movements, transfers, equity orders, the energy
 *                     buy: none of them is judged by these two rules.
 */
export function intentEntryGate(
  intent: TradeIntent,
  limits: AgentLimits,
): { token: string; rule: EntryGateRule } | null {
  if (isExitIntent(intent, limits)) return null;
  if (intent.kind === "swap") {
    if (intent.custody === "trencher") return null;
    const rule = entryGateFor(entryGatesOf(limits), intent.buyToken, "swap");
    return rule ? { token: lc(intent.buyToken), rule } : null;
  }
  if (intent.kind === "curve-trade") {
    if (limits.ponsClassVault !== undefined && lc(intent.target) === lc(limits.ponsClassVault)) return null;
    const rule = entryGateFor(entryGatesOf(limits), intent.assetOut, "curve");
    return rule ? { token: lc(intent.assetOut), rule } : null;
  }
  return null;
}

/**
 * THE BACKSTOP, for whatever still proposes a gated buy.
 *
 * The builtins read the hint and stop proposing; a tenant's own strategy file,
 * or any producer written later, may not. Those reach index.ts's proposal loop
 * with a buy the wall is certain to refuse, and without this they are refused
 * once a tick for the life of the arm.
 *
 * ONE REJECTED ROW PER (TOKEN, RULE) PER ARM, THEN WITHHELD. The first is let
 * through on purpose, so the wall writes its own refusal — the row, the rule
 * and the owner's notice — and the tape says why that coin is never bought.
 * Every repeat is withheld BEFORE ensureDecision: no decision row, no public
 * post, no refusal on the tape, nothing reserved. Withholding a repeat cannot
 * make anything replayable, because nothing was ever sent.
 *
 * Cleared at every arm, with `suppressedIntents`: a re-sign is exactly what
 * lifts a gate, and the new arm must get its own first row.
 */
export interface EntryGateLatch {
  /** True when this intent is a gated entry whose one row this arm was already let through. */
  withhold(intent: TradeIntent, limits: AgentLimits): boolean;
  clear(): void;
}

export function entryGateLatch(): EntryGateLatch {
  const passed = new Set<string>();
  return {
    withhold(intent, limits) {
      const gate = intentEntryGate(intent, limits);
      if (!gate) return false;
      const key = `${gate.token}|${gate.rule}`;
      if (passed.has(key)) return true;
      passed.add(key);
      return false;
    },
    clear() {
      passed.clear();
    },
  };
}

/**
 * What the owner reads when a strategy skips a candidate for a gate. Third
 * clause of `trencher: skipping <symbol> — …`, matching the sentence index.ts
 * already writes for the fast Trencher's no-exit skip.
 */
export const ENTRY_GATE_WHY: Record<EntryGateRule, string> = {
  "no-exit":
    "this key can't approve it for a sell, so a buy would be refused (no-exit). Re-sign the grant at /grant to cover it.",
  "asset-allowlist": "it is not among the assets this agent may trade, so a buy would be refused (asset-allowlist).",
};
