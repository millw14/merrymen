import { MAX_USDG_UI } from "../../packages/core/src/index";

export type StrategyName = "steady-basket" | "weekend-gap";

export interface PlaygroundRequest {
  strategy: StrategyName;
  compareStrategy?: StrategyName | null;
  symbols: string[];
  days: number;
  startingCashUsdg: number;
  seed?: number;
}

export interface PlaygroundRunOutput {
  strategy: StrategyName;
  finalEquityUsdg: number;
  pnlUsdg: number;
  maxDrawdownBps: number;
  executed: number;
  rejected: { rule: string; count: number }[];
  rejectedEvents: { tSec: number; rule: string }[];
  equitySeries: { tSec: number; equityUsdg: number }[];
}

export interface PlaygroundResponse {
  seed: number;
  limits: {
    perTradeUsdg: number;
    dailyUsdg: number;
    maxDrawdownPct: number;
    maxOpsPerDay: number;
  };
  primary: PlaygroundRunOutput;
  compare: PlaygroundRunOutput | null;
}

export type PlaygroundParseResult =
  | { ok: true; value: PlaygroundRequest }
  | { ok: false; error: string };

const isStrategy = (value: unknown): value is StrategyName =>
  value === "steady-basket" || value === "weekend-gap";

/** Validate untrusted JSON before the route performs grant or backtest work. */
export function parsePlaygroundRequest(input: unknown): PlaygroundParseResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "request body must be a JSON object" };
  }
  const body = input as Record<string, unknown>;

  if (!isStrategy(body.strategy)) {
    return { ok: false, error: "unknown strategy" };
  }
  if (body.compareStrategy != null && !isStrategy(body.compareStrategy)) {
    return { ok: false, error: "unknown comparison strategy" };
  }
  if (
    !Array.isArray(body.symbols)
    || body.symbols.length === 0
    || body.symbols.length > 32
    || !body.symbols.every((symbol) => typeof symbol === "string")
  ) {
    return { ok: false, error: "symbols must be a non-empty string array" };
  }
  if (!Number.isInteger(body.days) || (body.days as number) < 1 || (body.days as number) > 3_650) {
    return { ok: false, error: "days must be between 1 and 3650" };
  }
  if (
    typeof body.startingCashUsdg !== "number"
    || !Number.isFinite(body.startingCashUsdg)
    || body.startingCashUsdg <= 0
    || body.startingCashUsdg > MAX_USDG_UI
  ) {
    return {
      ok: false,
      error: `starting cash must be positive and no greater than ${MAX_USDG_UI}`,
    };
  }
  if (
    body.seed !== undefined
    && (!Number.isInteger(body.seed) || (body.seed as number) < 0 || (body.seed as number) > 0xffff_ffff)
  ) {
    return { ok: false, error: "seed must be a 32-bit unsigned integer" };
  }

  return {
    ok: true,
    value: {
      strategy: body.strategy,
      symbols: body.symbols,
      days: body.days as number,
      startingCashUsdg: body.startingCashUsdg,
      ...(body.compareStrategy !== undefined
        ? { compareStrategy: body.compareStrategy as StrategyName | null }
        : {}),
      ...(body.seed !== undefined ? { seed: body.seed as number } : {}),
    },
  };
}
