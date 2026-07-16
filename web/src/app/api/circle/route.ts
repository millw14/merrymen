/**
 * The Merry Circle — the dashboard's holder-tier lookup.
 *
 * Reads the $MERRYMEN balance at the user's configured holder wallet (read-only,
 * on mainnet where the token lives) and returns their tier + perks + the live
 * fee they'd pay. Utility only: no price, no returns. Setting the holder wallet
 * goes through the normal settings PUT; this route just reads + resolves.
 */

import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { homePaths } from "@/lib/home";
import {
  CIRCLE_TIERS,
  MERRYMEN_TOKEN,
  SETTINGS_DEFAULTS,
  effectivePerfFeeBps,
  nextTier,
  robinhoodChain,
  tierForBalance,
  wholeTokens,
  type CircleTier,
  type MerrymenSettings,
} from "@merrymen/core";
import { createPublicClient, erc20Abi, http } from "viem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function readSettings(): Promise<MerrymenSettings> {
  try {
    return JSON.parse((await readFile(homePaths.settings(), "utf8")).replace(/^﻿/, "")) as MerrymenSettings;
  } catch {
    return {};
  }
}

function tierView(t: CircleTier) {
  return {
    id: t.id,
    name: t.name,
    emoji: t.emoji,
    minTokens: t.minTokens,
    feeDiscountBps: t.feeDiscountBps,
    voteWeight: t.voteWeight,
    bonusStrategies: t.bonusStrategies,
    perks: t.perks,
  };
}

export async function GET() {
  const settings = await readSettings();
  const baseFeeBps = SETTINGS_DEFAULTS.perfFeeBps;
  const token = {
    symbol: MERRYMEN_TOKEN.symbol,
    address: MERRYMEN_TOKEN.address,
    chainId: MERRYMEN_TOKEN.chainId,
    explorer: `${robinhoodChain.blockExplorers!.default.url}/token/${MERRYMEN_TOKEN.address}`,
  };
  const tiers = CIRCLE_TIERS.map((t) => ({
    ...tierView(t),
    effectiveFeeBps: effectivePerfFeeBps(baseFeeBps, t),
  }));

  const holderAddress =
    typeof settings.holderAddress === "string" && /^0x[0-9a-fA-F]{40}$/.test(settings.holderAddress)
      ? (settings.holderAddress as `0x${string}`)
      : null;

  if (!holderAddress) {
    return NextResponse.json({ configured: false, baseFeeBps, token, tiers });
  }

  try {
    const client = createPublicClient({ chain: robinhoodChain, transport: http(settings.rpcMainnet) });
    const raw = (await client.readContract({
      address: MERRYMEN_TOKEN.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [holderAddress],
    })) as bigint;
    const tier = tierForBalance(raw);
    const up = nextTier(tier);
    return NextResponse.json({
      configured: true,
      holderAddress,
      balance: wholeTokens(raw),
      baseFeeBps,
      effectiveFeeBps: effectivePerfFeeBps(baseFeeBps, tier),
      tier: tierView(tier),
      next: up ? { ...tierView(up), tokensToGo: Math.max(0, up.minTokens - wholeTokens(raw)) } : null,
      token,
      tiers,
    });
  } catch (e) {
    return NextResponse.json({
      configured: true,
      holderAddress,
      error: e instanceof Error ? e.message : String(e),
      baseFeeBps,
      token,
      tiers,
    });
  }
}
