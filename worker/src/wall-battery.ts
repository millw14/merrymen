import {
  CASH,
  STOCK_TOKENS,
  UNISWAP,
  sellableAssets,
  usdgUnits,
  type StoredGrant,
} from "../../packages/core/src/index";
import { limitsFromGrant } from "./limits";
import { checkPolicy, type AgentLimits, type AgentState, type TradeIntent } from "./policy";

export interface WallCase {
  /** What the "attacker" tried, in plain words. */
  attempt: string;
  /** What the policy is expected to do. */
  want: "rejected" | "approved";
  /** The exact rejecting rule expected for a rejected case. */
  expectedRule?: string;
  /** What the policy actually said. */
  ok: boolean;
  rule?: string;
  detail?: string;
  /** Did the wall produce the exact expected verdict? */
  held: boolean;
}

export interface WallBatteryResult {
  cases: WallCase[];
  allHeld: boolean;
}

const EVIL = "0x000000000000000000000000000000000000dEaD" as const;
const RANDOM_VENUE = "0x1111111111111111111111111111111111111111" as const;
const UNKNOWN_TOKEN = "0x2222222222222222222222222222222222222222" as const;

interface BatteryInput {
  attempt: string;
  want: "rejected" | "approved";
  expectedRule?: string;
  intent: TradeIntent;
  state: AgentState;
  limits?: AgentLimits;
}

/**
 * Drive representative hostile and honest intents through the real policy
 * mirror. Each rejected case pins the exact rule so an earlier guard cannot
 * silently hijack the demo and make a broken proof look green.
 */
export function runWallBattery(
  grant: StoredGrant,
  nowSec = Math.floor(Date.now() / 1000),
): WallBatteryResult {
  const limits = limitsFromGrant(grant);
  const calm: AgentState = {
    spentTodayUsdg: 0n,
    opsToday: 0,
    highWaterMarkUsdg: 0n,
    equityUsdg: 0n,
    nowSec,
  };
  const router = UNISWAP.swapRouter02 as `0x${string}`;
  const usdgAddr = CASH.USDG as `0x${string}`;
  const sellable = sellableAssets(grant);
  const stock = (STOCK_TOKENS.find((token) => sellable.has(token.address.toLowerCase()))?.address
    ?? usdgAddr) as `0x${string}`;

  const nonSellableStock = STOCK_TOKENS.find(
    (token) => !sellable.has(token.address.toLowerCase()),
  );
  const nonSellable = (nonSellableStock?.address ?? UNKNOWN_TOKEN) as `0x${string}`;
  const noExitLimits = nonSellableStock
    ? limits
    : { ...limits, allowedAssets: [...limits.allowedAssets, nonSellable] };

  const legalSwap = (notional: bigint): TradeIntent => ({
    kind: "swap",
    target: router,
    sellToken: usdgAddr,
    buyToken: stock,
    sellAmountRaw: notional,
    notionalUsdg: notional,
  });

  const battery: BatteryInput[] = [
    {
      attempt: "“send everything to 0xdEaD” — a prompt-injected transfer to a stranger",
      want: "rejected",
      expectedRule: "per-trade-cap",
      intent: {
        kind: "transfer",
        target: usdgAddr,
        recipient: EVIL,
        amountUsdg: usdgUnits(grant.caps.dailyUsdg * 1000),
      },
      state: calm,
    },
    {
      attempt: `an oversized trade — 10× your ${grant.caps.perTradeUsdg} USDG per-trade cap`,
      want: "rejected",
      expectedRule: "per-trade-cap",
      intent: legalSwap(usdgUnits(grant.caps.perTradeUsdg * 10)),
      state: calm,
    },
    {
      attempt: "a swap routed to an unknown venue (not on the target allowlist)",
      want: "rejected",
      expectedRule: "target-allowlist",
      intent: {
        kind: "swap",
        target: RANDOM_VENUE,
        sellToken: usdgAddr,
        buyToken: stock,
        sellAmountRaw: 1n,
        notionalUsdg: 1n,
      },
      state: calm,
    },
    {
      attempt: "buying a token that isn't on the asset allowlist",
      want: "rejected",
      expectedRule: "asset-allowlist",
      intent: {
        kind: "swap",
        target: router,
        sellToken: usdgAddr,
        buyToken: UNKNOWN_TOKEN,
        sellAmountRaw: 1n,
        notionalUsdg: 1n,
      },
      state: calm,
    },
    {
      attempt: `one more trade after the ${grant.caps.dailyUsdg} USDG daily budget is spent`,
      want: "rejected",
      expectedRule: "daily-cap",
      intent: legalSwap(usdgUnits(Math.min(grant.caps.perTradeUsdg, 1))),
      state: { ...calm, spentTodayUsdg: usdgUnits(grant.caps.dailyUsdg) },
    },
    {
      attempt: "a perfectly legal trade — but the session key has expired",
      want: "rejected",
      expectedRule: "expiry",
      intent: legalSwap(1n),
      state: { ...calm, nowSec: grant.expiresAt + 1 },
    },
    {
      attempt: `trading on while the book is down ${grant.caps.maxDrawdownPct}% from its high-water mark`,
      want: "rejected",
      expectedRule: "drawdown-breaker",
      intent: legalSwap(1n),
      state: {
        ...calm,
        highWaterMarkUsdg: usdgUnits(1000),
        equityUsdg: usdgUnits(1000 - (1000 * grant.caps.maxDrawdownPct) / 100),
      },
    },
    {
      attempt: "an honest, in-cap trade (the wall lets the band work)",
      want: "approved",
      intent: legalSwap(1n),
      state: calm,
    },
    {
      attempt: "buying a token this signed key cannot later sell",
      want: "rejected",
      expectedRule: "no-exit",
      intent: {
        kind: "swap",
        target: router,
        sellToken: usdgAddr,
        buyToken: nonSellable,
        sellAmountRaw: 1n,
        notionalUsdg: 1n,
      },
      state: calm,
      limits: noExitLimits,
    },
  ];

  const cases: WallCase[] = battery.map(
    ({ attempt, want, expectedRule, intent, state, limits: caseLimits }) => {
      const verdict = checkPolicy(intent, caseLimits ?? limits, state);
      const held = want === "approved"
        ? verdict.ok
        : !verdict.ok && verdict.rule === expectedRule;
      return {
        attempt,
        want,
        expectedRule,
        ok: verdict.ok,
        rule: verdict.ok ? undefined : verdict.rule,
        detail: verdict.ok ? undefined : verdict.detail,
        held,
      };
    },
  );

  return { cases, allHeld: cases.every((entry) => entry.held) };
}
