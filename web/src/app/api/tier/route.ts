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
 *
 * WHOSE TOKENS COUNT: THE OWNER'S WALLET AND THEIR AGENT'S ACCOUNT, TOGETHER.
 * The worker's Circle gate and its energy count the combined balance, so this
 * does too — through lib/merrymen-standing.ts, which /api/circle and /api/alpha
 * share, so that "send $MERRYMEN to my account" clears every screen at once.
 * The agent's account counts only on Robinhood Chain and never twice; a read of
 * EITHER half that fails is `unreadable` with every count null, because half a
 * sum is exactly the smaller number that sends somebody to buy more.
 *
 * SELF-HOSTED ANSWERS TOO, from the operator's own settings file and the grant
 * on this disk — the same two addresses their worker counts. It used to answer
 * `ok` with no balance at all, which the desk rendered as "you hold 0".
 */
import { NextResponse } from "next/server";
import { createPublicClient } from "viem";
import {
  CIRCLE_TIERS,
  isHostedMode,
  robinhoodChain,
  tierForBalance,
} from "@merrymen/core";
import { webChainRead } from "@/lib/chain-read";
import { tenantOf } from "@/lib/auth";
import { holderWalletFor, type HolderWallet } from "@/lib/holder-wallet";
import { agentAccountFor } from "@/lib/agent-account";
import {
  AGENT_BALANCE_TTL_MS,
  countedAgent,
  diskHolder,
  energyGateOn,
  readStanding,
  standingTokens,
  type BalanceCache,
  type Standing,
} from "@/lib/merrymen-standing";

export const dynamic = "force-dynamic";

/** The tier that unlocks the holder-only strategies, named once. */
const CIRCLE_TIER = CIRCLE_TIERS.find((t) => t.bonusStrategies)!;

/**
 * Same shape and the same reasoning as /api/alpha's cache: a BALANCE per
 * address, never a boolean "allowed". The tier is re-derived every request, so
 * a wallet that sold out loses its perks on its own with nothing to invalidate.
 * The agent's account keeps a minute rather than ten: it is the balance an
 * owner has just been told to top up, and is now watching.
 */
const BALANCE_TTL_MS = 10 * 60_000;
const balances: BalanceCache = new Map();
const agentBalances: BalanceCache = new Map();

export interface TierView {
  /** "ok" | "sign-in" | "unreadable" — never a bare null that reads as zero. */
  why: "ok" | "sign-in" | "unreadable";
  /**
   * Whole tokens between the owner's wallet and the agent's account, or null
   * when we could not read. NEVER 0 for unread.
   */
  tokens: number | null;
  /** The owner wallet's part. A NEW agent starts with only this. */
  holderTokens: number | null;
  /** The agent account's part; null when it does not count (none, another chain) or was not read. */
  agentTokens: number | null;
  /** The agent account that was counted, or null. */
  agentAccount: string | null;
  /**
   * Is the hosted energy gate enforcing? FOR COPY ONLY — never a permission.
   * The worker reads the same switch and is the one that throttles.
   */
  energyGate: boolean;
  tierId: string | null;
  tierName: string | null;
  /** Does this tier run the holder-only strategies? */
  bonusStrategies: boolean;
  /** How many whole tokens the holder-only tier needs. */
  needTokens: number;
  /** Which wallet was read, and whether it was the login, a linked one, or (self-hosted) the settings file's. */
  wallet: string | null;
  source: "login" | "linked" | "settings" | null;
}

export async function GET(req: Request) {
  const hosted = isHostedMode();
  const energyGate = energyGateOn(process.env.MERRYMEN_ENERGY_GATE, hosted);
  const view = (v: Partial<TierView>): TierView => ({
    why: "ok",
    tokens: null,
    holderTokens: null,
    agentTokens: null,
    agentAccount: null,
    energyGate,
    tierId: null,
    tierName: null,
    bonusStrategies: false,
    needTokens: CIRCLE_TIER.minTokens,
    wallet: null,
    source: null,
    ...v,
  });

  let wallet: `0x${string}` | null;
  let source: TierView["source"];
  let rpc: string | undefined;
  if (hosted) {
    let resolved: HolderWallet | null;
    try {
      resolved = await holderWalletFor(tenantOf(req));
    } catch {
      // WHOSE wallet counts could not be read (the proof or the holder
      // claims): an unread standing, every count at its null default.
      return NextResponse.json(view({ why: "unreadable" }));
    }
    // Signed out. Nothing about anybody's balance is said to nobody.
    if (!resolved) return NextResponse.json(view({ why: "sign-in" }));
    // A null address is a wallet another account claims (one wallet powers
    // one agent): only the agent's own account is left to count.
    wallet = resolved.address;
    source = resolved.source;
  } else {
    // The operator's own declaration about their own wallet — the address
    // their worker counts — and their own RPC.
    const own = await diskHolder();
    wallet = own.address;
    source = own.address ? "settings" : null;
    rpc = own.rpcMainnet;
  }

  let standing: Standing;
  try {
    const agent = await agentAccountFor(req, hosted);
    if (!wallet && !countedAgent(null, agent)) {
      // Self-hosted with no wallet named and no mainnet account: there is
      // nothing to read, which is not the same as holding nothing.
      return NextResponse.json(view({ why: "ok" }));
    }
    standing = await readStanding({
      client: createPublicClient({ chain: robinhoodChain, transport: webChainRead(rpc) }),
      holder: wallet,
      agent,
      holderCache: balances,
      agentCache: agentBalances,
      holderTtlMs: BALANCE_TTL_MS,
      agentTtlMs: AGENT_BALANCE_TTL_MS,
    });
  } catch {
    // A fact about our read, not about their wallet — and every count stays
    // null, the combined one and both of its parts.
    return NextResponse.json(view({ why: "unreadable", wallet, source }));
  }

  const tier = tierForBalance(standing.raw);
  return NextResponse.json(
    view({
      why: "ok",
      ...standingTokens(standing),
      agentAccount: standing.agent,
      tierId: tier.id,
      tierName: tier.name,
      bonusStrategies: tier.bonusStrategies,
      wallet,
      source,
    }),
  );
}
