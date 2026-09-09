/**
 * ALPHA — the scout's working, for holders.
 *
 * WHAT IS BEHIND THE LOCK, AND WHAT IS NOT. `/api/discoveries` is public and
 * stays public: the verdict on a listed coin is what makes the coins page worth
 * loading, and gating it "would empty the panel for every viewer". So this
 * route is deliberately NOT that payload behind a lock — a lock over data
 * anyone can curl is decoration, and this codebase does not ship decoration
 * that looks like a control.
 *
 * It serves the two things the public payload drops: the coins the model was
 * shown and DECLINED, and the per-coin research read before it looked. Both
 * were already paid for by the same pass; neither is reachable over HTTP.
 *
 * WHAT THE GATE IS. `tenantOf(req)` returns a wallet address the server
 * VERIFIED — recovered from a signature, carried in an HMAC-signed httpOnly
 * session. That is exactly what the gateway's claim flow spends ninety lines
 * obtaining, and it is already here. So: which wallet is this, what does it
 * hold, does that clear a tier.
 *
 * WHAT THE GATE IS NOT.
 *
 *   NOT the site password. `lib/site-gate.ts` calls itself "A DOORKNOB, NOT A
 *   LOCK — one password for everyone, no session", and warns that somebody will
 *   eventually be tempted to put something real behind it.
 *
 *   NOT `settings.holderAddress`, which `/api/circle` reads. That is
 *   self-declared and shape-validated only — fine for a fee discount an owner
 *   claims for themselves, never an authorisation input.
 *
 *   NOT the gateway's `mmk_` token. It is signed with a secret this service
 *   does not have, the gateway exposes no verify route, and a bearer token is
 *   transferable — one holder could hand it to a thousand people.
 *
 * IT FAILS CLOSED, AND IT SAYS WHICH WAY. "You are not signed in", "your wallet
 * does not hold enough" and "we could not read your balance" are three
 * different facts with three different remedies, and only one of them is about
 * the reader. An RPC outage must never render as "you don't hold enough".
 */
import { webChainRead } from "@/lib/chain-read";
import { NextResponse } from "next/server";
import {
  CIRCLE_TIERS,
  MERRYMEN_TOKEN,
  isHostedMode,
  robinhoodChain,
  tierForBalance,
} from "@merrymen/core";
import { createPublicClient, erc20Abi } from "viem";

import { tenantOf } from "@/lib/auth";
import { sharedAlpha, type AlphaExtras, type DiscoveryRow, type Payload } from "@/lib/read-discoveries";

export const runtime = "nodejs";
/** Per-caller. Never cacheable — the answer depends on who is asking. */
export const dynamic = "force-dynamic";

/** Alpha requires the 100,000-token Merryman tier. */
const ENTRY_TIER = CIRCLE_TIERS.find((t) => t.id === "merryman")!;

/**
 * A balance moves when somebody trades the token; a tier moves when it crosses
 * a decade. Ten minutes is the difference between one read per holder per ten
 * minutes and one per poll.
 *
 * Cached as a BALANCE per address, never as a boolean "allowed": the tier is
 * re-derived on every request, so a wallet that sold out loses access on its
 * own without anything having to be invalidated.
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

/**
 * A holder's own copy, and the ONLY place research is attached to a coin.
 *
 * The row itself is the public shape, unchanged — a passed-over coin gets the
 * same figures and the same caveats as a picked one, including `onCurve`, which
 * is what stops its bonding-curve reserve reading as money.
 */
function withResearch(row: DiscoveryRow, research: AlphaExtras["research"]) {
  return { ...row, research: research?.[row.token.toLowerCase()] ?? null };
}

/**
 * What a locked reader gets.
 *
 * COUNTS AND NO BODIES. A CSS blur leaves the text in the DOM, so the body is
 * omitted from the PAYLOAD — there is nothing to un-blur, nothing in view
 * source, nothing in the network tab. The counts are the honest advertisement:
 * they say how much is there without saying what it is.
 *
 * Perks render from `CIRCLE_TIERS` rather than being typed here, so the copy
 * cannot drift from what the token actually does — `token.ts:1-17` forbids any
 * of it promising price, returns, buybacks or burns.
 */
function locked(
  why: "sign-in" | "balance" | "unreachable",
  counts: { picks: number; passed: number },
) {
  return NextResponse.json(
    {
      locked: true,
      why,
      picks: counts.picks,
      passed: counts.passed,
      need: {
        tokens: ENTRY_TIER.minTokens,
        name: ENTRY_TIER.name,
        emoji: ENTRY_TIER.emoji,
        perks: ENTRY_TIER.perks,
      },
      token: { symbol: MERRYMEN_TOKEN.symbol, address: MERRYMEN_TOKEN.address },
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

/** Everything a holder sees, and the disclosures that must travel with it. */
function open(payload: Payload, alpha: AlphaExtras, tier: (typeof CIRCLE_TIERS)[number] | null) {
  const picks = payload.rows.filter((r) => r.verdict);
  return NextResponse.json(
    {
      locked: false,
      tier: tier && { id: tier.id, name: tier.name, emoji: tier.emoji },
      fetchedAt: payload.fetchedAt,
      picks: picks.map((r) => withResearch(r, alpha.research)),
      passed: alpha.passed.map((r) => withResearch(r, alpha.research)),
      // "The scout looked and picked nothing" and "the scout could not look"
      // are different answers, and the screen must not render the second as the
      // first. Null here is the considered pass.
      verdictsWhy: payload.verdictsWhy,
      // Whether the site research ran at all, said once for the page rather
      // than as a null on every card — it is configured per service, so it is
      // never a fact about one coin.
      researched: alpha.research !== null,
      // The same two caveats the coins page carries: a prefix of the market is
      // not the market, and a degraded render is not a quiet one.
      truncated: payload.truncated,
      degraded: payload.degraded,
      indexUnreachable: payload.indexUnreachable,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function GET(req: Request) {
  // One read, shared with every viewer of the coins page through the same
  // single-flight memo. A locked reader costs exactly as much as an open one,
  // which is why the counts below are free to be honest.
  const { payload, alpha } = await sharedAlpha();
  const counts = { picks: payload.rows.filter((r) => r.verdict).length, passed: alpha.passed.length };

  if (!isHostedMode()) {
    // Self-hosted runs one operator against one settings file: there is no
    // session to attribute a holding to, and no house to gate on behalf of.
    return open(payload, alpha, null);
  }

  const tenant = tenantOf(req);
  if (!tenant) return locked("sign-in", counts);

  let raw: bigint;
  try {
    raw = await balanceOf(tenant);
  } catch {
    // The chain would not answer. That is a fact about our read, not about the
    // reader's wallet — telling them they hold too little would be a lie they
    // cannot act on, and they would go and buy more.
    return locked("unreachable", counts);
  }

  const tier = tierForBalance(raw);
  if (tier.minTokens < ENTRY_TIER.minTokens) return locked("balance", counts);
  return open(payload, alpha, tier);
}
