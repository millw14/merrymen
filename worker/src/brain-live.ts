/**
 * THE ONE PLACE BRAIN IS ALLOWED TO REACH A TRADE — and it still cannot.
 *
 * ── WHAT THIS MODULE IS, AND WHAT IT DELIBERATELY IS NOT ─────────────────
 *
 * `brain-shadow.ts` states the guarantee it was built on: "EXECUTION IS
 * DISCONNECTED BY ABSENCE, not by a flag. This module does not import
 * proposalsToIntents, checkPolicy, simulate or the executor... A future version
 * that connects execution has to ADD an import, which is a reviewable act; a
 * flag would be one edit by someone who did not read this comment."
 *
 * The owner has asked for that connection. This is it, and it keeps the
 * property rather than trading it away: THIS FILE IMPORTS NOTHING EXECUTABLE
 * EITHER. It turns a decision into a plain `{side, symbol, usdgAmount}` request
 * — three scalars — and hands it back. The caller (the tick, in index.ts, which
 * already imports everything) puts that request through `submitChatTrade`, the
 * SAME wall-checked path an owner's own typed order takes.
 *
 * So there is still no second execution path, no bypass, and no flag inside the
 * shadow modules. What changed is that one named, gated call site now exists,
 * in the file where every other execution decision already lives.
 *
 * ── WHAT STILL REFUSES A BRAIN TRADE ─────────────────────────────────────
 *
 * Everything that ever did, unchanged and in the same place. The signed policy
 * wall does not know or care which reasoner proposed an intent: the per-trade
 * cap, the daily cap, the asset allowlist, no-exit, the drawdown breaker, the
 * scout budget and the gas pre-flight all apply exactly as they do to a
 * strategist proposal. A brain BUY of a token the grant does not name is
 * refused by `asset-allowlist`, the same as anything else.
 *
 * On top of that, and BEFORE any of it, this module refuses:
 *   • an agent the owner has not explicitly named in MERRYMEN_BRAIN_LIVE
 *   • a hold, or a decision whose word and number disagree
 *   • a size that is not a finite positive number
 *   • a size above the ceiling that already bounds the OTHER model-driven
 *     trader on this agent
 *
 * ── WHY A SEPARATE ALLOWLIST FROM THE SHADOW ONE ─────────────────────────
 *
 * MERRYMEN_BRAIN_SHADOW is "this agent may THINK". Reusing it would mean every
 * agent already enrolled for observation silently began trading the moment this
 * shipped — turning an opt-in to watch into an opt-in to spend, retroactively,
 * for people who agreed to the first thing. Shadow stays shadow.
 */

import type { BrainDecision } from "./brain-client";

/**
 * The smallest trade worth making, in USDG.
 *
 * MEASURED, NOT GUESSED. One swap UserOperation on chain 4663 costs 0.38–0.78
 * USDG at observed gas prices, and a round trip is two of them. At the shipped
 * 8.33 USDG leg that is 9–19% of notional, and the four ops this deployment has
 * ever landed cost 6.97 USDG of gas to move 6.67 USDG of notional — more in
 * fees than the trade was worth.
 *
 * Five USDG is a floor, not a target: it puts gas under ~15% of a round trip
 * rather than over it. It refuses only, so it cannot loosen anything, and it is
 * deliberately well below the sizes an owner would choose — the point is to
 * catch a model asking for dust, not to second-guess a real position.
 */
export const BRAIN_MIN_TRADE_USDG = 5;

/**
 * Is this agent allowed to TRADE on what Brain decides?
 *
 * Defaults to nobody. Same prefix-match shape as `shadowEnabledFor` so an
 * operator can name an account by its first bytes, and `all` is honoured for
 * the same reason it is there — but note that `all` here means every agent in
 * the fleet starts spending on model output, which is a different sentence.
 */
export function brainLiveEnabledFor(agentId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.MERRYMEN_BRAIN_LIVE ?? "").trim();
  if (!raw) return false;
  const want = agentId.trim().toLowerCase();
  if (!want) return false;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((p) => p === "all" || want.startsWith(p));
}

/** A request the caller may put to the wall. Three scalars, nothing executable. */
export interface BrainOrder {
  side: "buy" | "sell";
  symbol: string;
  usdgAmount: number;
}

export type BrainOrderVerdict = { ok: true; order: BrainOrder } | { ok: false; why: string };

/**
 * The order a decision is asking for, or the reason it is not one.
 *
 * `suggested_delta_usdg` is INTEGER MICRO-USDG, positive to buy and negative to
 * sell — graph.py says so in the prompt it sends the model, and schemas.py
 * validates the sign against the action on the way out. Read as USDG here it
 * would be a million-fold overstatement, which is exactly the class of mistake
 * that only shows up once real money is behind it.
 *
 * THE WORD AND THE NUMBER MUST AGREE. Brain's own schema enforces it, and this
 * checks again — not from distrust of that validator but because the two
 * failures are different: the schema stops Brain EMITTING a contradiction, and
 * this stops the worker ACTING on one from a service that might one day be a
 * different build than we think. It is the same reasoning brain-client.ts gives
 * for re-checking addresses on this side of the network boundary.
 */
export function orderFromDecision(
  d: BrainDecision,
  limits: { maxUsdg: number; minUsdg?: number },
): BrainOrderVerdict {
  if (d.action === "hold") return { ok: false, why: "held" };
  if (d.action !== "buy" && d.action !== "sell") return { ok: false, why: `unknown action ${String(d.action)}` };

  const micro = d.suggested_delta_usdg;
  if (!Number.isFinite(micro)) return { ok: false, why: "size is not a number" };
  if (d.action === "buy" && micro <= 0) return { ok: false, why: "says buy and sizes a sell" };
  if (d.action === "sell" && micro >= 0) return { ok: false, why: "says sell and sizes a buy" };

  const usdgAmount = Math.abs(micro) / 1e6;
  // A FLOOR, because a trade below it cannot pay for its own gas. Measured on
  // this chain at 0.38-0.78 USDG a swap, so anything under a couple of dollars
  // is the owner paying the chain for the privilege of a rounding error.
  const floor = limits.minUsdg ?? 0;
  if (usdgAmount <= 0) return { ok: false, why: "size rounds to nothing" };
  if (usdgAmount < floor) {
    return { ok: false, why: `${usdgAmount.toFixed(2)} USDG is under the ${floor} USDG floor for a trade worth making` };
  }

  // CLAMPED, NEVER REFUSED, at the top end — the same shape the strategist's
  // own ceiling uses (`min()` can only tighten). A model that asks for more
  // than it may have should get what it may have, not nothing: refusing would
  // turn one over-ask into a permanent hold, and the wall's own cap is the
  // number that actually binds either way.
  const usdgClamped = Math.min(usdgAmount, limits.maxUsdg);
  if (!(usdgClamped > 0)) return { ok: false, why: "the ceiling for this agent is zero" };

  const symbol = String(d.symbol ?? "").trim().toUpperCase();
  // A ticker, not a sentence and not an address. `instrument_id` is
  // `merrymen:<symbol>` by construction and Brain refuses address-shaped output
  // at two layers already; this is the third, and it is the one standing next
  // to a token lookup.
  if (!/^[A-Z0-9]{1,12}$/.test(symbol)) return { ok: false, why: `'${String(d.symbol)}' is not a symbol I can look up` };

  return { ok: true, order: { side: d.action, symbol, usdgAmount: Math.round(usdgClamped * 100) / 100 } };
}
