/**
 * THE TAPE'S ROWS, FROM THE MARKET THE SHELL ALREADY READ — no request of its own.
 *
 * components/shell/Ticker.tsx fetched /api/market (and /api/wall-tape) on a
 * minute of its own and was mounted by nothing. The terminal reads the market
 * every thirty seconds with the Robinhood quotes laid over it, so the tape is
 * drawn from those tokens and moves when they move.
 *
 * The fleet's wall counts that tape opened with are not here: they come from
 * /api/wall-tape, which the terminal does not read, and a count derived from
 * the public feed instead would undercount by design — account-wide refusals
 * are kept off the public feed.
 *
 * Every flag is said only when it was read. A halt is asserted only when the
 * chain said true; "stale" only when the price carries its own clock and that
 * clock is over an hour old.
 */
import type { LiveToken } from "./live";

export const TICKS = 14;
export const STALE_SEC = 3600;

export interface Tick {
  id: string;
  symbol: string;
  priceUsd: number;
  volume24hUsd: number | null;
  halted: boolean;
  stale: boolean;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

export function ticksOf(tokens: readonly LiveToken[], nowSec: number, max = TICKS): Tick[] {
  const out: Tick[] = [];
  for (const t of tokens) {
    if (out.length >= max) break;
    if (!finite(t.priceUsd) || t.priceUsd <= 0) continue;
    // The price on screen is the quote when there is one, so it is the quote's
    // clock that dates it; otherwise the market read's own feed time.
    const at = t.priceSource === "robinhood" ? t.priceUpdatedAt : t.feedUpdatedAt;
    out.push({
      id: t.id,
      symbol: t.symbol,
      priceUsd: t.priceUsd,
      volume24hUsd: finite(t.volume24hUsd) ? t.volume24hUsd : null,
      halted: t.halted === true,
      stale: finite(at) && at > 0 && nowSec - at > STALE_SEC,
    });
  }
  return out;
}
