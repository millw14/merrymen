/**
 * /api/tier — what Circle tier THIS account actually has, right now.
 *
 * "The app should warn more eye-catching when someone has chosen a holder-only
 * strategy and don't have access to it. For me it's being tricky to figure that
 * out, I had to go to /api/circle to check that and that's not good for
 * normies...."
 *
 * He had to read a JSON endpoint to find out why his funded agent did nothing.
 * The product knew the answer the whole time and had nowhere to put it: the
 * create-agent picker states the RULE ("runs only while you hold $MERRYMEN")
 * and never the reader's STANDING against it, which is the only half that tells
 * somebody whether to press the button.
 *
 * WHY A ROUTE AND NOT A FIELD ON /api/settings. Settings is what the owner has
 * typed; this is what the chain says about them. Mixing the two is how
 * `holderAddress` became a claim anybody could make — the mistake this whole
 * area has been walking back.
 *
 * IT FAILS CLOSED AND SAYS WHICH WAY, copying /api/alpha exactly. "You are not
 * signed in", "you hold this much" and "we could not read your balance" are
 * three different facts with three different remedies, and only one of them is
 * about the reader. An RPC outage must never render as "you don't hold enough",
 * because somebody will go and buy more.
 */
import { NextResponse } from "next/server";
import { erc20Abi } from "viem";
import { createPublicClient } from "viem";
import {
  CIRCLE_TIERS,
  MERRYMEN_TOKEN,
  isHostedMode,
  robinhoodChain,
  tierForBalance,
} from "@merrymen/core";
import { webChainRead } from "@/lib/chain-read";
import { tenantOf } from "@/lib/auth";
import { holderWalletFor } from "@/lib/holder-wallet";

export const dynamic = "force-dynamic";

/** The tier that unlocks the holder-only strategies, named once. */
const CIRCLE_TIER = CIRCLE_TIERS.find((t) => t.bonusStrategies)!;

/**
 * Same shape and the same reasoning as /api/alpha's cache: a BALANCE per
 * address, never a boolean "allowed". The tier is re-derived every request, so
 * a wallet that sold out loses its perks on its own with nothing to invalidate.
 */
const BALANCE_TTL_MS = 10 * 60_000;
const balances = new Map<string, { at: number; raw: bigint }>();

async function balanceOf(address: `0x${string}`): Promise<bigint> {
  const key = address.toLowerCase();
  const hit = balances.get(key);
  if (hit && Date.now() - hit.at < BALANCE_TTL_MS) return hit.raw;
  const client = createPublicClient({ chain: robinhoodChain, transport: webChainRead() });
  const raw = (await client.readContract({
    address: MERRYMEN_TOKEN.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  })) as bigint;
  balances.set(key, { at: Date.now(), raw });
  return raw;
}

export interface TierView {
  /** "ok" | "sign-in" | "unreadable" — never a bare null that reads as zero. */
  why: "ok" | "sign-in" | "unreadable";
  /** Whole tokens held, or null when we could not read. NEVER 0 for unread. */
  tokens: number | null;
  tierId: string | null;
  tierName: string | null;
  /** Does this tier run the holder-only strategies? */
  bonusStrategies: boolean;
  /** How many whole tokens the holder-only tier needs. */
  needTokens: number;
  /** Which wallet was read, and whether it was the login or a linked one. */
  wallet: string | null;
  source: "login" | "linked" | null;
}

export async function GET(req: Request) {
  const view = (v: Partial<TierView>): TierView => ({
    why: "ok",
    tokens: null,
    tierId: null,
    tierName: null,
    bonusStrategies: false,
    needTokens: CIRCLE_TIER.minTokens,
    wallet: null,
    source: null,
    ...v,
  });

  const tenant = isHostedMode() ? tenantOf(req) : null;
  const resolved = await holderWalletFor(tenant);
  if (!resolved) {
    // Hosted and signed out. Self-hosted has no session and its own settings
    // decide, so the screen simply does not ask this question there.
    return NextResponse.json(view({ why: isHostedMode() ? "sign-in" : "ok" }));
  }

  let raw: bigint;
  try {
    raw = await balanceOf(resolved.address);
  } catch {
    // A fact about our read, not about their wallet.
    return NextResponse.json(
      view({ why: "unreadable", wallet: resolved.address, source: resolved.source }),
    );
  }

  const tier = tierForBalance(raw);
  return NextResponse.json(
    view({
      why: "ok",
      tokens: Number(raw / 10n ** BigInt(MERRYMEN_TOKEN.decimals)),
      tierId: tier.id,
      tierName: tier.name,
      bonusStrategies: tier.bonusStrategies,
      wallet: resolved.address,
      source: resolved.source,
    }),
  );
}
