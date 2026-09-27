/**
 * /api/circle — the Merry Circle, as it stands FOR THE CALLER.
 *
 * WHOSE WALLET THIS ANSWERED ABOUT WAS THE BUG. It read
 * `homePaths.settings()` — one process-level file — and reported
 * `settings.holderAddress` from it as "your" holder wallet, with "your"
 * balance and "your" tier. On the hosted service that file belongs to the
 * operator, so every signed-in tenant who opened this URL was shown somebody
 * else's standing as their own, and a tenant who had linked a wallet was shown
 * a wallet they had never named. It took no session and checked no identity.
 *
 * That mattered because this URL is not theoretical. A tester diagnosing why
 * his funded agent sat still said, in as many words, that he "had to go to
 * /api/circle to check that and that's not good for normies" — so the one
 * endpoint people were actually reading to answer "am I in the Circle?" was
 * answering a different question with a confident number.
 *
 * It now resolves the caller the same way every other holder surface does:
 * `tenantOf(req)` → `holderWalletFor()` — a signature-proven linked wallet
 * first, the session wallet otherwise (each only while no other account holds
 * its claim: one wallet powers one agent), and NEVER `settings.holderAddress`,
 * which is typed in and so is a claim about anyone's balance as easily as your
 * own. Self-hosted has no session, and there the settings file genuinely is the
 * operator's own declaration about their own wallet, so that path survives —
 * scoped to the only deployment where it is true.
 *
 * AND IT SAYS WHICH OF THE THREE THINGS HAPPENED. "You are not signed in",
 * "you hold this much" and "we could not read your balance" have three
 * different remedies and only one is about the reader; an RPC blip that renders
 * as "you hold nothing" sends somebody to go and buy more. So `why` is on every
 * response and an unread balance is `null`, never 0.
 *
 * The tier TABLE is public and unconditional — it is the same list on the
 * marketing page, it discloses nothing about anybody, and it is what makes the
 * signed-out answer useful instead of empty.
 *
 * AND THE BALANCE IS THE COMBINED ONE. The worker counts the owner's wallet and
 * the agent's own account together (lib/merrymen-standing.ts), so `balance` is
 * that sum and the tier and fee are derived from it; `holderBalance` and
 * `agentBalance` say where it sits. The agent's account counts only on
 * Robinhood Chain and never twice. Either half failing to read is `unreadable`
 * with every figure null, because half a sum is the smaller number that sends
 * somebody to buy tokens they already own.
 */

import { webChainRead } from "@/lib/chain-read";
import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { homePaths } from "@merrymen/home";
import {
  CIRCLE_TIERS,
  MERRYMEN_TOKEN,
  SETTINGS_DEFAULTS,
  effectivePerfFeeBps,
  isHostedMode,
  nextTier,
  robinhoodChain,
  tierForBalance,
  type CircleTier,
  type MerrymenSettings,
} from "@merrymen/core";
import { tenantOf } from "@/lib/auth";
import { holderWalletFor, type HolderWallet } from "@/lib/holder-wallet";
import { agentAccountFor } from "@/lib/agent-account";
import { countedAgent, readStanding, standingTokens } from "@/lib/merrymen-standing";
import { createPublicClient } from "viem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Self-hosted only: the operator's own settings file, their own declaration. */
async function selfHostedHolder(): Promise<{
  address: `0x${string}` | null;
  rpcMainnet: string | undefined;
}> {
  try {
    const settings = JSON.parse(
      (await readFile(homePaths.settings(), "utf8")).replace(/^﻿/, ""),
    ) as MerrymenSettings;
    const a = settings.holderAddress;
    return {
      address: typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as `0x${string}`) : null,
      rpcMainnet: settings.rpcMainnet,
    };
  } catch {
    return { address: null, rpcMainnet: undefined };
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

export async function GET(req: Request) {
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
  /** Everything true regardless of who is asking. Never omitted. */
  const table = { baseFeeBps, token, tiers };

  const hosted = isHostedMode();
  let holderAddress: `0x${string}` | null = null;
  let source: "login" | "linked" | "settings" | null = null;
  let rpcMainnet: string | undefined;

  if (hosted) {
    let resolved: HolderWallet | null;
    try {
      resolved = await holderWalletFor(tenantOf(req));
    } catch {
      // WHOSE wallet counts could not be read (the proof or the holder
      // claims). A fact about our read, with every balance null.
      return NextResponse.json({
        why: "unreadable",
        holderAddress: null,
        source: null,
        balance: null,
        holderBalance: null,
        agentBalance: null,
        tier: null,
        ...table,
      });
    }
    if (!resolved) {
      // Signed out. Not "configured: false" — there is nothing misconfigured,
      // we simply do not know who is asking.
      return NextResponse.json({ why: "sign-in", holderAddress: null, balance: null, ...table });
    }
    holderAddress = resolved.address;
    source = resolved.source;
  } else {
    const own = await selfHostedHolder();
    holderAddress = own.address;
    rpcMainnet = own.rpcMainnet;
    source = own.address ? "settings" : null;
  }

  try {
    // The caller's own agent account — hosted from their grant, self-hosted
    // from the grant on this disk. Inside the try: a grant store that cannot
    // be read is an unread standing, not an agent with nothing in it.
    const agent = await agentAccountFor(req, hosted);
    if (!holderAddress && !countedAgent(null, agent)) {
      return NextResponse.json({ why: "no-wallet", holderAddress: null, balance: null, ...table });
    }
    const standing = await readStanding({
      client: createPublicClient({
        chain: robinhoodChain,
        transport: webChainRead(rpcMainnet),
      }),
      holder: holderAddress,
      agent,
    });
    const { tokens, holderTokens, agentTokens } = standingTokens(standing);
    const tier = tierForBalance(standing.raw);
    const up = nextTier(tier);
    return NextResponse.json({
      why: "ok",
      holderAddress,
      source,
      balance: tokens,
      holderBalance: holderTokens,
      agentBalance: agentTokens,
      agentAccount: standing.agent,
      effectiveFeeBps: effectivePerfFeeBps(baseFeeBps, tier),
      tier: tierView(tier),
      next: up ? { ...tierView(up), tokensToGo: Math.max(0, up.minTokens - tokens) } : null,
      ...table,
    });
  } catch (e) {
    // A fact about our read. No tier, and every balance stays null — a zero
    // here is the sentence that sends somebody to go and buy tokens they
    // already own, and half a sum is a smaller zero.
    return NextResponse.json({
      why: "unreadable",
      holderAddress,
      source,
      balance: null,
      holderBalance: null,
      agentBalance: null,
      tier: null,
      error: e instanceof Error ? e.message : String(e),
      ...table,
    });
  }
}
