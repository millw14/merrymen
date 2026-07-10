/**
 * The LLM strategist as a Strategy: cron-gated decision points, not per-tick
 * chatter. Between decision windows it proposes nothing; at each window it
 * builds sanitized signals from the snapshot, asks the driver, and runs the
 * answer through parse → validate → convert. A driver failure or garbage
 * output degrades to "no trades this window" — never to a crash, never to an
 * unvalidated intent.
 */

import type { TradeIntent } from "../policy";
import type { Snapshot, Strategy } from "../strategies/types";
import { parseProposals, proposalsToIntents, type StrategistUniverse } from "./proposals";
import type { ProposalDriver, Signals } from "./driver";

export interface LlmStrategistConfig {
  driver: ProposalDriver;
  universe: StrategistUniverse;
  /** Minimum ms between model calls — decisions are windows, ticks are not. */
  decisionIntervalMs: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Where dropped proposals and reasons get reported (worker event log). */
  onNote?: (level: "ok" | "warn", message: string) => void;
}

function buildSignals(snap: Snapshot, universe: StrategistUniverse, at: Date): Signals {
  return {
    cashUsdg: Number(snap.cashUsdg) / 1e6,
    vaultUsdg: Number(snap.vaultUsdg) / 1e6,
    equityUsdg:
      Number(snap.cashUsdg + snap.vaultUsdg) / 1e6 +
      [...snap.holdings.values()].reduce((s, h) => s + Number(h.valueUsdg) / 1e6, 0),
    holdings: [...snap.holdings.entries()].map(([symbol, h]) => ({
      symbol,
      valueUsdg: Number(h.valueUsdg) / 1e6,
      priceStale: h.priceStale,
    })),
    prices: [...snap.prices.entries()]
      .filter(([symbol]) => universe.legs.has(symbol))
      .map(([symbol, p]) => ({
        symbol,
        usd: Number(p.price8) / 1e8,
        stale: p.stale,
      })),
    tradableSymbols: [...universe.legs.keys()],
    maxPerActionUsdg: Number(universe.maxPerActionUsdg) / 1e6,
    utcHour: at.getUTCHours(),
    utcDay: at.getUTCDay(),
  };
}

export function makeLlmStrategist(cfg: LlmStrategistConfig): Strategy {
  const now = cfg.now ?? Date.now;
  const note = cfg.onNote ?? (() => {});
  let lastDecisionAt: number | null = null;

  return {
    name: `llm-strategist(${cfg.driver.name})`,
    async tick(snap: Snapshot): Promise<TradeIntent[]> {
      if (!snap.sequencerUp) return [];
      const t = now();
      if (lastDecisionAt !== null && t - lastDecisionAt < cfg.decisionIntervalMs) return [];
      lastDecisionAt = t;

      let raw: unknown;
      try {
        raw = await cfg.driver.propose(buildSignals(snap, cfg.universe, new Date(t)));
      } catch (e) {
        note("warn", `strategist driver failed: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      }

      const { actions, malformed } = parseProposals(raw);
      if (malformed > 0) note("warn", `strategist emitted ${malformed} malformed action(s) — dropped`);

      const { intents, rejected } = proposalsToIntents(actions, cfg.universe, snap);
      for (const r of rejected) note("warn", `strategist proposal dropped: ${r}`);
      for (const a of actions) {
        if (a.action !== "hold" && a.reason) {
          note("ok", `strategist: ${a.action} ${a.sizeUsdg} USDG ${a.symbol} — ${a.reason}`);
        }
      }
      return intents;
    },
  };
}
