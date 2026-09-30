/** Cost-aware round trips. Partial reductions belong to the same trade until flat. */
import type { PerpSide } from "../../../packages/core/src/perps";
import type { PaperStep } from "./paper";

export interface ReplayTrade {
  marketId: number;
  side: PerpSide;
  openedAtMs: number;
  closedAtMs: number | null;
  realizedMicro: bigint;
  feesMicro: bigint;
  fundingMicro: bigint;
  netMicro: bigint;
  fills: number;
  exitKind: string | null;
}

export function createReplayTradeTracker() {
  const open = new Map<number, ReplayTrade>();
  const completed: ReplayTrade[] = [];
  return {
    record(step: PaperStep, atMs: number, kind: string): void {
      if (!step.before && step.after) {
        if (open.has(step.marketId)) throw new Error("replay trade already open");
        open.set(step.marketId, { marketId: step.marketId, side: step.after.side, openedAtMs: atMs,
          closedAtMs: null, realizedMicro: 0n, feesMicro: 0n, fundingMicro: 0n, netMicro: 0n, fills: 0, exitKind: null });
      }
      const trade = open.get(step.marketId);
      if (!trade) {
        if (step.fills.length || step.funding) throw new Error("replay settlement without an open trade");
        return;
      }
      for (const fill of step.fills) {
        trade.realizedMicro += fill.realizedMicro;
        trade.feesMicro += fill.feeMicro;
        trade.fills++;
      }
      trade.fundingMicro += step.funding?.paymentMicro ?? 0n;
      trade.netMicro = trade.realizedMicro + trade.fundingMicro - trade.feesMicro;
      if (step.before && !step.after) {
        trade.closedAtMs = atMs;
        trade.exitKind = kind;
        completed.push({ ...trade });
        open.delete(step.marketId);
      }
    },
    completed: () => completed.map(t => ({ ...t })),
    open: () => [...open.values()].map(t => ({ ...t })),
  };
}

export function replayTradeMetrics(args: {
  completed: readonly ReplayTrade[];
  open: readonly ReplayTrade[];
  initialCashMicro: bigint;
  curve: readonly { equityMicro: bigint }[];
  complete: boolean;
}) {
  let grossWinsMicro = 0n, grossLossesMicro = 0n, netMicro = 0n;
  let wins = 0, losses = 0, flat = 0, lossStreak = 0, maxLossStreak = 0;
  let worstTradeMicro: bigint | null = null;
  for (const trade of args.completed) {
    netMicro += trade.netMicro;
    if (worstTradeMicro === null || trade.netMicro < worstTradeMicro) worstTradeMicro = trade.netMicro;
    if (trade.netMicro > 0n) { wins++; grossWinsMicro += trade.netMicro; lossStreak = 0; }
    else if (trade.netMicro < 0n) { losses++; grossLossesMicro -= trade.netMicro; maxLossStreak = Math.max(maxLossStreak, ++lossStreak); }
    else { flat++; lossStreak = 0; }
  }
  let peak = args.initialCashMicro, maxDrawdownBps = 0;
  for (const point of args.curve) {
    peak = peak > point.equityMicro ? peak : point.equityMicro;
    if (peak > 0n) maxDrawdownBps = Math.max(maxDrawdownBps, Number((peak - point.equityMicro) * 10_000n / peak));
  }
  const all = [...args.completed, ...args.open];
  const count = args.completed.length;
  return {
    status: args.complete ? (count ? "measured" : "insufficient-data") : "incomplete",
    completedTrades: count, openTrades: args.open.length, wins, losses, flat,
    winRate: count ? wins / count : null,
    netCompletedMicro: netMicro,
    /** Truncated to whole micro-USDG; never counted as a probability. */
    expectancyMicro: count ? netMicro / BigInt(count) : null,
    profitFactor: grossLossesMicro > 0n ? Number(grossWinsMicro) / Number(grossLossesMicro) : null,
    profitFactorUnavailable: grossLossesMicro > 0n ? null : "no losing completed trades",
    grossWinsMicro, grossLossesMicro, worstTradeMicro, maxLossStreak, maxDrawdownBps,
    feesMicro: all.reduce((n, t) => n + t.feesMicro, 0n),
    fundingMicro: all.reduce((n, t) => n + t.fundingMicro, 0n),
    liquidations: args.completed.filter(t => t.exitKind === "liq").length,
    /** Entry fees and booked funding on open positions are costs, not completed wins/losses. */
    openBookedNetMicro: args.open.reduce((n, t) => n + t.netMicro, 0n),
  };
}
