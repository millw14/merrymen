/** Browser-safe shape check, repeated at the worker before any exit is built. */
import type { PerpKey } from "../../../packages/core/src/perps";

export function ownerPerpMarket(raw: unknown): PerpKey | null {
  const key = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return /^[A-Z0-9]{1,24}-PERP$/.test(key) ? key as PerpKey : null;
}

export type PerpExitOrder = {
  side: "sell";
  symbol: string;
  usdgAmount: 0;
  book: "paper" | "live";
  purpose: "close-perp" | "flatten-perps";
};

/** null means an ordinary order, never an inferred exit from a ticker alone. */
export function readPerpExitOrder(args: Record<string, unknown>): { order: PerpExitOrder } | { error: string } | null {
  const purpose = args.purpose;
  if (purpose !== "close-perp" && purpose !== "flatten-perps") return null;
  if (args.book !== "paper" && args.book !== "live") return { error: "Choose paper or real-money perpetual positions before confirming." };
  if (args.side !== "sell" || args.usdgAmount !== 0) {
    return { error: "A perpetual exit closes the held position; it cannot choose a buy or an amount." };
  }
  const symbol = purpose === "flatten-perps"
    ? (args.symbol === "ALL-PERPS" ? "ALL-PERPS" : null)
    : ownerPerpMarket(args.symbol);
  if (!symbol) return { error: purpose === "close-perp" ? "Name one perpetual market, for example BTC-PERP." : "Close-all must name ALL-PERPS." };
  return { order: { side: "sell", symbol, usdgAmount: 0, book: args.book, purpose } };
}
