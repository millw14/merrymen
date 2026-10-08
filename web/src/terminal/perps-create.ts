import { isPerpsStyle, PERP_TREND_UNIVERSE, type PerpsStyleId } from "@merrymen/core";
export const PERPS_CREATE_PERMISSION_DAYS = 14;
export const PERPS_CREATE_TRADE_USDG = 25;

/** The setup button starts only simulated perps, with the limits the owner saw. */
export function perpsCreationSettings(input: { name: string; style: PerpsStyleId; markets: string[]; perTradeUsdg: number; owner: string | null }) {
  if (!isPerpsStyle(input.style)) throw new Error("Choose a perpetuals profile.");
  if (!input.markets.length || new Set(input.markets).size !== input.markets.length ||
      input.markets.some(m => !(PERP_TREND_UNIVERSE as readonly string[]).includes(m))) throw new Error("Choose supported perpetual markets.");
  if (!Number.isFinite(input.perTradeUsdg) || input.perTradeUsdg < 10 || input.perTradeUsdg > 100_000 ||
      Math.abs(input.perTradeUsdg * 100 - Math.round(input.perTradeUsdg * 100)) > 1e-6) throw new Error("Perpetuals need a per-trade cap of at least 10 USDG, in cents.");
  return {
    owner: input.owner, agentName: input.name.trim(), strategy: "perps-only",
    paperTradingEnabled: true, liveTradingEnabled: false,
    scoutEnabled: false, classSnipeEnabled: false,
    perpsEnabled: true, perpsLiveEnabled: false, perpsDriver: "perp-trend",
    perpsStyle: input.style, perpsMarkets: [...input.markets], perpsPerTradeUsdg: input.perTradeUsdg,
    perpsMaxOpenNotionalUsdg: Math.max(50, input.perTradeUsdg),
    perpsMaxLeverage: 2, perpsMaxCollateralUsdg: 30, perpsMaxOpensPerDay: 4,
    perpsStopLossPct: 5, perpsStopSlipBps: 200, perpsTakeProfitPct: 0,
    perpsLiqBufferPct: 2, perpsMaxSlippageBps: 50,
  };
}
