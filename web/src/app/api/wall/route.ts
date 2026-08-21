/**
 * The wall, made inspectable.
 * GET: the grant's on-chain facts — caps, addresses, chain, explorer links.
 * POST: "prove the wall" — fire a battery of malicious intents through the SAME
 * policy code the worker runs on every tick (worker/src/policy.ts — pure, typed,
 * model-free) and return each verdict. Nothing is signed, nothing touches the
 * chain, no state is written: the point is to let the owner WATCH bad intents
 * bounce off the mirror of the caps their account contract enforces on-chain.
 */

import { NextResponse } from "next/server";
import { readStoredGrant } from "@/lib/grant";
import {
  chainForId,
  explorerFor,
  type StoredGrant,
} from "@merrymen/core";
import { runWallBattery } from "@merrymen/wall-battery";

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
  const grant = await readStoredGrant();
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

export async function POST() {
  const grant = await readStoredGrant();
  if (!grant) return NextResponse.json({ error: "no grant — create a wallet first" }, { status: 404 });
  return NextResponse.json(runWallBattery(grant));
}
