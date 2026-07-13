/**
 * The wall, made inspectable.
 * GET: the grant's on-chain facts — caps, addresses, chain, explorer links.
 * POST: "prove the wall" — fire a battery of malicious intents through the SAME
 * policy code the worker runs on every tick (worker/src/policy.ts — pure, typed,
 * model-free) and return each verdict. Nothing is signed, nothing touches the
 * chain, no state is written: the point is to let the owner WATCH bad intents
 * bounce off the mirror of the caps their account contract enforces on-chain.
 */

import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { homePaths } from "@/lib/home";
import {
  CASH,
  MORPHO,
  RIALTO,
  STOCK_TOKENS,
  UNISWAP,
  chainForId,
  explorerFor,
  type StoredGrant,
} from "@merrymen/core";
import { checkPolicy, type AgentLimits, type AgentState, type TradeIntent } from "@merrymen/policy";

const GRANT_FILE = homePaths.grant();

/** USDG uses 6 decimals; caps in the grant are plain numbers in UI units. */
const usdg = (n: number) => BigInt(Math.round(n * 1_000_000));

/** Mirror of the worker's limitsFromGrant (worker/src/index.ts) — same targets, same math. */
function limitsFromGrant(grant: StoredGrant): AgentLimits {
  return {
    perTradeUsdg: usdg(grant.caps.perTradeUsdg),
    dailyUsdg: usdg(grant.caps.dailyUsdg),
    allowedTargets: [
      RIALTO.routerSnapshot as `0x${string}`,
      UNISWAP.swapRouter02 as `0x${string}`,
      MORPHO.steakhouseUsdgVault as `0x${string}`,
      CASH.USDG as `0x${string}`,
    ],
    allowedAssets: [CASH.USDG as `0x${string}`, ...STOCK_TOKENS.map((t) => t.address)],
    maxDrawdownBps: grant.caps.maxDrawdownPct * 100,
    expiresAt: grant.expiresAt,
    maxOpsPerDay: grant.caps.maxOpsPerDay,
  };
}

async function readGrant(): Promise<StoredGrant | null> {
  try {
    return JSON.parse(await readFile(GRANT_FILE, "utf8")) as StoredGrant;
  } catch {
    return null;
  }
}

export interface WallInfo {
  armed: boolean;
  chainId?: number;
  chainName?: string;
  explorer?: string;
  caps?: StoredGrant["caps"];
  expiresAt?: number;
  addresses?: { smartAccount: string; sessionKey: string; owner: string };
}

export async function GET() {
  const grant = await readGrant();
  if (!grant) return NextResponse.json({ armed: false } satisfies WallInfo);
  const info: WallInfo = {
    armed: true,
    chainId: grant.chainId,
    chainName: chainForId(grant.chainId).name,
    explorer: explorerFor(grant.chainId),
    caps: grant.caps,
    expiresAt: grant.expiresAt,
    addresses: {
      smartAccount: grant.smartAccount,
      sessionKey: grant.sessionKeyAddress,
      owner: grant.owner,
    },
  };
  return NextResponse.json(info);
}

export interface WallCase {
  /** What the "attacker" tried, in plain words. */
  attempt: string;
  /** "rejected" | "approved" — what the wall should do. */
  want: "rejected" | "approved";
  /** What the policy actually said. */
  ok: boolean;
  rule?: string;
  detail?: string;
  /** Did the wall behave as promised? */
  held: boolean;
}

const EVIL = "0x000000000000000000000000000000000000dEaD" as `0x${string}`;
const RANDOM_VENUE = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const UNKNOWN_TOKEN = "0x2222222222222222222222222222222222222222" as `0x${string}`;

export async function POST() {
  const grant = await readGrant();
  if (!grant) return NextResponse.json({ error: "no grant — create a wallet first" }, { status: 404 });

  const limits = limitsFromGrant(grant);
  const now = Math.floor(Date.now() / 1000);
  const calm: AgentState = {
    spentTodayUsdg: 0n,
    opsToday: 0,
    highWaterMarkUsdg: 0n,
    equityUsdg: 0n,
    nowSec: now,
  };
  const router = UNISWAP.swapRouter02 as `0x${string}`;
  const usdgAddr = CASH.USDG as `0x${string}`;
  const stock = (STOCK_TOKENS[0]?.address ?? usdgAddr) as `0x${string}`;

  const legalSwap = (notional: bigint): TradeIntent => ({
    kind: "swap",
    target: router,
    sellToken: usdgAddr,
    buyToken: stock,
    sellAmountRaw: notional,
    notionalUsdg: notional,
  });

  const battery: { attempt: string; want: "rejected" | "approved"; intent: TradeIntent; state: AgentState }[] = [
    {
      attempt: "“send everything to 0xdEaD” — a prompt-injected transfer to a stranger",
      want: "rejected",
      // Drained-wallet attempt: the USDG contract isn't reachable as a transfer
      // target here because the amount blasts past the per-trade cap first —
      // and a fake "USDG" target fails the allowlist. Model the classic drain:
      // huge transfer through the real token contract.
      intent: { kind: "transfer", target: usdgAddr, recipient: EVIL, amountUsdg: usdg(grant.caps.dailyUsdg * 1000) },
      state: calm,
    },
    {
      attempt: `an oversized trade — 10× your ${grant.caps.perTradeUsdg} USDG per-trade cap`,
      want: "rejected",
      intent: legalSwap(usdg(grant.caps.perTradeUsdg * 10)),
      state: calm,
    },
    {
      attempt: "a swap routed to an unknown venue (not on the target allowlist)",
      want: "rejected",
      intent: { kind: "swap", target: RANDOM_VENUE, sellToken: usdgAddr, buyToken: stock, sellAmountRaw: 1n, notionalUsdg: 1n },
      state: calm,
    },
    {
      attempt: "buying a token that isn't on the asset allowlist",
      want: "rejected",
      intent: { kind: "swap", target: router, sellToken: usdgAddr, buyToken: UNKNOWN_TOKEN, sellAmountRaw: 1n, notionalUsdg: 1n },
      state: calm,
    },
    {
      attempt: `one more trade after the ${grant.caps.dailyUsdg} USDG daily budget is spent`,
      want: "rejected",
      intent: legalSwap(usdg(Math.min(grant.caps.perTradeUsdg, 1))),
      state: { ...calm, spentTodayUsdg: usdg(grant.caps.dailyUsdg) },
    },
    {
      attempt: "a perfectly legal trade — but the session key has expired",
      want: "rejected",
      intent: legalSwap(1n),
      state: { ...calm, nowSec: grant.expiresAt + 1 },
    },
    {
      attempt: `trading on while the book is down ${grant.caps.maxDrawdownPct}% from its high-water mark`,
      want: "rejected",
      intent: legalSwap(1n),
      state: {
        ...calm,
        highWaterMarkUsdg: usdg(1000),
        equityUsdg: usdg(1000 - (1000 * grant.caps.maxDrawdownPct) / 100),
      },
    },
    {
      attempt: "an honest, in-cap trade (the wall lets the band work)",
      want: "approved",
      intent: legalSwap(1n),
      state: calm,
    },
  ];

  const cases: WallCase[] = battery.map(({ attempt, want, intent, state }) => {
    const v = checkPolicy(intent, limits, state);
    return {
      attempt,
      want,
      ok: v.ok,
      rule: v.ok ? undefined : v.rule,
      detail: v.ok ? undefined : v.detail,
      held: want === "rejected" ? !v.ok : v.ok,
    };
  });

  return NextResponse.json({ cases, allHeld: cases.every((c) => c.held) });
}
