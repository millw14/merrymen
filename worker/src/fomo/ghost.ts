/**
 * GHOST PAPER — fake-money follows of her tail calls. Pure: sizing and PnL
 * live here; reading, writing and sending live elsewhere (store.ts
 * fomo_ghost_prefs/fomo_ghost_positions, the tail-notifier entry hook, the
 * settle pass, /ghost commands).
 *
 * One GHOST POSITION per told tail buy that ghosting covers: the mark's
 * entry price plus a ghost size in USD. Money is integer MICRO-USD (like
 * usdg elsewhere): $100 = 100_000_000. A position settles PnL per horizon
 * off the mark's re-quotes — size * move. No mark, no ghost: a buy that
 * cannot be measured is never papered, and ghost PnL always says its
 * sample size.
 */

export const GHOST_FLAT_USD_MICRO = 100_000_000;
export const GHOST_SCOUT_CUT_PCT = 10;
export const GHOST_CUSTOM_MAX_USD_MICRO = 10_000_000_000;
export const GHOST_CUSTOM_MIN_USD_MICRO = 1_000_000;

export type GhostSizeMode = "scout-cut" | "flat" | "custom";

export interface GhostPrefs {
  traderUserId: string;
  enabled: boolean;
  mode: GhostSizeMode;
  /** Micro-USD, only meaningful when mode is custom. */
  customUsdMicro: number;
  /** Micro-USD cap on total open ghost exposure for the tenant, 0 = uncapped. */
  capUsdMicro: number;
}

/** Resolve a ghost size in micro-USD, or null when it cannot be sized (never zero, never negative). */
export function resolveGhostSize(
  prefs: Pick<GhostPrefs, "mode" | "customUsdMicro">,
  scoutBudgetUsdMicro: number | null,
): number | null {
  if (prefs.mode === "flat") return GHOST_FLAT_USD_MICRO;
  if (prefs.mode === "custom") {
    if (!Number.isSafeInteger(prefs.customUsdMicro)) return null;
    const capped = Math.min(prefs.customUsdMicro, GHOST_CUSTOM_MAX_USD_MICRO);
    if (capped < GHOST_CUSTOM_MIN_USD_MICRO) return null;
    if (typeof scoutBudgetUsdMicro === "number" && scoutBudgetUsdMicro > 0) {
      return Math.min(capped, Math.trunc(scoutBudgetUsdMicro));
    }
    return capped;
  }
  // scout-cut: ten percent of the scout budget, floored to the micro.
  if (typeof scoutBudgetUsdMicro !== "number" || !Number.isSafeInteger(scoutBudgetUsdMicro) || scoutBudgetUsdMicro <= 0) return null;
  const size = Math.trunc((scoutBudgetUsdMicro * GHOST_SCOUT_CUT_PCT) / 100);
  return size >= GHOST_CUSTOM_MIN_USD_MICRO ? size : null;
}

/** PnL in micro-USD for a size held from entry to horizon, or null when either price is missing. */
export function ghostPnlMicro(sizeUsdMicro: number, entryPriceUsd: number, horizonPriceUsd: number | null | undefined): number | null {
  if (!Number.isSafeInteger(sizeUsdMicro) || sizeUsdMicro <= 0) return null;
  if (typeof entryPriceUsd !== "number" || !Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0) return null;
  if (typeof horizonPriceUsd !== "number" || !Number.isFinite(horizonPriceUsd) || horizonPriceUsd < 0) return null;
  return Math.trunc((sizeUsdMicro * (horizonPriceUsd - entryPriceUsd)) / entryPriceUsd);
}

export interface GhostPosition {
  eventKey: string;
  traderUserId: string;
  handle: string | null;
  sizeUsdMicro: number;
  entryPriceUsd: number;
  h1PnlMicro: number | null;
  h24PnlMicro: number | null;
}

export interface GhostSummary {
  positions: number;
  settledH1: number;
  settledH24: number;
  /** Settled h1 PnL summed, micro-USD. Null when nothing settled. */
  pnlH1Micro: number | null;
  pnlH24Micro: number | null;
}

/** Fold positions into one summary (hers-only: the caller scopes the input). */
export function summarizeGhost(positions: readonly GhostPosition[]): GhostSummary {
  let settledH1 = 0;
  let settledH24 = 0;
  let pnlH1 = 0;
  let pnlH24 = 0;
  for (const p of positions) {
    if (p.h1PnlMicro !== null) {
      settledH1 += 1;
      pnlH1 += p.h1PnlMicro;
    }
    if (p.h24PnlMicro !== null) {
      settledH24 += 1;
      pnlH24 += p.h24PnlMicro;
    }
  }
  return {
    positions: positions.length,
    settledH1,
    settledH24,
    pnlH1Micro: settledH1 === 0 ? null : pnlH1,
    pnlH24Micro: settledH24 === 0 ? null : pnlH24,
  };
}

const fmtUsd = (micro: number | null): string => {
  if (micro === null) return "n/a";
  const usd = micro / 1_000_000;
  const sign = usd < 0 ? "−" : usd > 0 ? "+" : "";
  return `${sign}$${Math.abs(usd).toFixed(2)}`;
};

/** One ghost summary block for /ghost pnl and end summaries. Sample size is always said. */
export function ghostSummaryLines(summary: GhostSummary, openUsdMicro: number): string[] {
  if (summary.positions === 0) return ["No ghost positions yet. /ghost on <trader> starts papering their tail calls."];
  const lines = [
    `Ghost paper: ${summary.positions} ${summary.positions === 1 ? "position" : "positions"}, ${fmtUsd(openUsdMicro)} open.`,
    `+1h PnL ${fmtUsd(summary.pnlH1Micro)} over ${summary.settledH1} settled.`,
  ];
  if (summary.settledH24 > 0) lines.push(`+24h PnL ${fmtUsd(summary.pnlH24Micro)} over ${summary.settledH24} settled.`);
  return lines;
}

/** Parse a /ghost size argument ("100", "$100", "100usd"): micro-USD or null. */
export function parseGhostSizeUsd(raw: unknown): number | null {
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  const s = String(raw).trim().replace(/^\$/, "").replace(/usd$/i, "").trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  const micro = Math.round(Number(s) * 1_000_000);
  if (!Number.isSafeInteger(micro) || micro < GHOST_CUSTOM_MIN_USD_MICRO || micro > GHOST_CUSTOM_MAX_USD_MICRO) return null;
  return micro;
}
