/**
 * Deterministic policy layer — the half of the permission wall that lives off-chain.
 * It MIRRORS (never replaces) the on-chain Kernel session-key policies: the
 * on-chain caps are the hard wall; this layer exists to reject bad intents cheaply
 * and log WHY, before gas is spent. If this code and the on-chain policy ever
 * disagree, the on-chain policy wins and that divergence is a bug to alert on.
 *
 * Nothing in this file may call an LLM, read agent memory, or take a string that
 * originated from a model. Intents come in typed; verdicts go out typed.
 */

export interface AgentLimits {
  /** USDG (6dp) ceiling for a single trade. */
  perTradeUsdg: bigint;
  /** USDG (6dp) ceiling summed over a rolling 24h window. */
  dailyUsdg: bigint;
  /** Allowed target contracts (Rialto router via registry, Morpho vault, tokens for approvals). */
  allowedTargets: readonly `0x${string}`[];
  /** Allowed token addresses the agent may hold or trade. */
  allowedAssets: readonly `0x${string}`[];
  /** Drawdown (bps from high-water mark) at which the breaker pauses the agent. */
  maxDrawdownBps: number;
  /** Unix seconds after which the session key is dead regardless of anything. */
  expiresAt: number;
  /** Ops ceiling per rolling 24h — mirrors the on-chain rate-limit policy. */
  maxOpsPerDay: number;
}

export type TradeIntent = {
  kind: "swap";
  target: `0x${string}`;
  sellToken: `0x${string}`;
  buyToken: `0x${string}`;
  sellAmountUsdg: bigint;
} | {
  kind: "vault-deposit" | "vault-withdraw";
  target: `0x${string}`;
  amountUsdg: bigint;
};

export type Verdict =
  | { ok: true }
  | { ok: false; rule: string; detail: string };

export interface AgentState {
  spentTodayUsdg: bigint;
  /** Executed operations in the trailing 24h — mirrors the on-chain rate limit. */
  opsToday: number;
  highWaterMarkUsdg: bigint;
  equityUsdg: bigint;
  nowSec: number;
}

export function checkPolicy(intent: TradeIntent, limits: AgentLimits, state: AgentState): Verdict {
  if (state.nowSec >= limits.expiresAt) {
    return { ok: false, rule: "expiry", detail: "session key expired" };
  }

  const lc = (a: string) => a.toLowerCase();
  if (!limits.allowedTargets.map(lc).includes(lc(intent.target))) {
    return { ok: false, rule: "target-allowlist", detail: `target ${intent.target} not allowed` };
  }

  if (intent.kind === "swap") {
    for (const token of [intent.sellToken, intent.buyToken]) {
      if (!limits.allowedAssets.map(lc).includes(lc(token))) {
        return { ok: false, rule: "asset-allowlist", detail: `asset ${token} not allowed` };
      }
    }
  }

  if (state.opsToday >= limits.maxOpsPerDay) {
    return { ok: false, rule: "ops-cap", detail: `${state.opsToday} ops in 24h >= ${limits.maxOpsPerDay}` };
  }

  const notional = intent.kind === "swap" ? intent.sellAmountUsdg : intent.amountUsdg;
  if (notional > limits.perTradeUsdg) {
    return { ok: false, rule: "per-trade-cap", detail: `${notional} > ${limits.perTradeUsdg}` };
  }
  if (state.spentTodayUsdg + notional > limits.dailyUsdg) {
    return { ok: false, rule: "daily-cap", detail: `would exceed daily cap ${limits.dailyUsdg}` };
  }

  if (state.highWaterMarkUsdg > 0n) {
    const drawdownBps = Number(
      ((state.highWaterMarkUsdg - state.equityUsdg) * 10_000n) / state.highWaterMarkUsdg,
    );
    if (drawdownBps >= limits.maxDrawdownBps) {
      return { ok: false, rule: "drawdown-breaker", detail: `${drawdownBps}bps >= ${limits.maxDrawdownBps}bps` };
    }
  }

  return { ok: true };
}
