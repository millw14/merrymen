/**
 * WHAT THE DESK SAYS ABOUT AN AGENT'S ENERGY — decided here, drawn elsewhere.
 *
 * The input is the worker's own report (AgentStatus.energy, see
 * packages/core/src/energy.ts), never a figure this browser worked out: the
 * process that throttles is the only one that knows its counters. This module
 * only decides which of three things to say, so EnergyNote.tsx, the funding
 * panel and a test can all agree without reading JSX.
 *
 * SAY NOTHING unless it is true and it matters now:
 *   - no report, or a report from an ungated deployment (energy limits
 *     nothing there, so a sentence about it would be a false alarm);
 *   - full energy — the ordinary state for a holder, nothing to say;
 *   - a report whose day has ended. `resetsAt` is the next 00:00 UTC of the
 *     day it counted; after that "today's energy is spent" is yesterday's
 *     news, and a desk left open overnight must not show it as today's.
 *
 * UNREAD IS NEVER ZERO. `level: "unread"` means the worker could not read the
 * $MERRYMEN balances, so this view carries no number at all for it — and every
 * count below is number | null, rendered through count(), where null is a dash.
 * A zero here is the number that sends somebody to buy tokens they may already
 * hold.
 */
import { MERRYMEN_TOKEN, type EnergyBuy, type EnergyMeter, type EnergyStatus } from "@merrymen/core";

export type EnergyView =
  | { kind: "none" }
  | { kind: "unread"; spent: boolean }
  | {
      kind: "low";
      spent: boolean;
      /** Whole $MERRYMEN between the owner's wallet and the agent's account; null unless every counted part was read. */
      total: number | null;
      /** How far short of full energy; null whenever `total` is. */
      short: number | null;
      /** The worker counted no owner wallet at all, so `total` is the agent's account alone. */
      noWallet: boolean;
      /**
       * A part that COUNTS was not read. Only then may a surface say "couldn't
       * read": no wallet that counts is a knowable nothing, not an outage.
       */
      readFailed: boolean;
      /** Paid AI reviews today; null when this agent has no paid reviewer. */
      reviews: EnergyMeter | null;
      /** New trades started on its own today. */
      entries: EnergyMeter | null;
    };

export function energyView(e: EnergyStatus | null | undefined, nowSec: number): EnergyView {
  if (!e || !e.gated || e.level === "full" || nowSec >= e.resetsAt) return { kind: "none" };
  if (e.level === "unread") return { kind: "unread", spent: e.spent };
  // Both parts, or no total at all. On another network the agent's account is
  // not counted by design, so there the owner's wallet IS the whole of it; and
  // with no owner wallet counted (none linked, or it already powers another
  // account) the agent's account is — energy-copy.ts holdingsLine says the
  // same. A report from before `holderCounted` existed is read as before.
  const noWallet = e.holderCounted === false;
  const agentCounts = e.buy !== "not-mainnet";
  const total = !agentCounts
    ? e.holderTokens
    : noWallet
      ? e.agentTokens
      : e.holderTokens !== null && e.agentTokens !== null
        ? e.holderTokens + e.agentTokens
        : null;
  const readFailed = (!noWallet && e.holderTokens === null) || (agentCounts && e.agentTokens === null);
  return {
    kind: "low",
    spent: e.spent,
    total,
    short: total === null ? null : Math.max(0, e.needTokens - total),
    noWallet,
    readFailed,
    reviews: e.reviews,
    entries: e.entries,
  };
}

/**
 * The worker itself says this agent is at full energy.
 *
 * Used to stand the Circle banner down: /api/tier caches a balance for ten
 * minutes, and the worker reads the same combined balance every tick, so when
 * the two disagree right after a top-up it is the worker that is current.
 */
export function workerSaysFull(e: EnergyStatus | null | undefined): boolean {
  return e?.level === "full";
}

export interface EnergyRemedies {
  /**
   * Can the owner send $MERRYMEN straight to the agent's account and have it
   * count? Only when the account is on Robinhood Chain: on any other network
   * its mainnet address is one this app cannot recover from, and tokens sent
   * there would sit uncounted — so the address is not offered at all.
   */
  sendToAgent: boolean;
  /** Can the agent buy it with USDG, as the worker decided; null = not said. */
  usdg: EnergyBuy | null;
}

export function energyRemedies(
  e: EnergyStatus | null | undefined,
  chainId: number | null | undefined,
): EnergyRemedies {
  return {
    sendToAgent: chainId === MERRYMEN_TOKEN.chainId && e?.buy !== "not-mainnet",
    usdg: e?.buy ?? null,
  };
}

/**
 * A progress bar's two ends, or null when either was not read. NO BAR AGAINST
 * AN ALLOWANCE WE HAVE NOT READ — the You screen's rule for the daily cap.
 */
export function meterBar(m: EnergyMeter | null | undefined): { used: number; allowed: number } | null {
  if (!m || m.used === null || m.allowed === null || m.allowed <= 0) return null;
  return { used: Math.min(m.used, m.allowed), allowed: m.allowed };
}
