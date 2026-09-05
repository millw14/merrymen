import type { LiveMine, Thesis } from "./live";

export interface ChatTurn {
  question: string;
  answer: string;
  trade?: Thesis;
}

export function dailyChange(mine: LiveMine): number | null {
  if (mine.equity == null || mine.chg24 == null) return null;
  const previous = mine.equity - mine.chg24;
  return previous > 0 ? (mine.chg24 / previous) * 100 : null;
}

export function spentToday(mine: LiveMine, now: number): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return mine.moves.reduce((total, move) => {
    if (move.action !== "buy" && move.action !== "sell") return total;
    if (move.outcome && move.outcome !== "landed") return total;
    if (move.at == null || move.at < start.getTime() || move.at > now)
      return total;
    return total + Math.max(0, move.sizeUsdg ?? 0);
  }, 0);
}

export function positionsOf(mine: LiveMine) {
  const g = mine.glance;
  return (
    g.legs?.map((l) => ({
      symbol: l.symbol,
      detail: `${l.weight}% allocation`,
      pnl: null as number | null,
    })) ??
    g.open?.map((l) => ({
      symbol: l.symbol,
      detail: "Open position",
      pnl: l.pnlPct,
    })) ??
    g.parked?.map((symbol) => ({
      symbol,
      detail: "Held",
      pnl: null as number | null,
    })) ??
    []
  );
}
