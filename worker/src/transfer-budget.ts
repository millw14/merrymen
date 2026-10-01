import { usdgUnits } from "../../packages/core/src/index";

/** Judge transfers in micro-USDG; an unreadable allowance never authorizes a send. */
export function transferBudgetRefusal(amountUsdg: bigint, spentUsdg: number, dailyUsdg: number): string | null {
  if (!Number.isFinite(spentUsdg) || spentUsdg < 0 || !Number.isFinite(dailyUsdg) || dailyUsdg < 0) {
    return "The daily transfer allowance could not be verified. No transfer was sent.";
  }
  if (amountUsdg + usdgUnits(spentUsdg) > usdgUnits(dailyUsdg)) {
    return `That would exceed the daily transfer limit (${dailyUsdg} USDG; ${spentUsdg.toFixed(2)} USDG already sent or pending).`;
  }
  return null;
}
