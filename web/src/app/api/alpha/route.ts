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
 *   NOT a site password. There used to be one — a shared "not yet" doorknob in
 *   front of the whole deployment — and it was removed. It never authenticated
 *   anything, which is exactly why this gate could never have been built on it.
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
 *
 * THE SAME TOKENS THE WORKER COUNTS. The Circle gate and energy count the
 * owner's wallet and their agent's own account together, and so does this —
 * through lib/merrymen-standing.ts, shared with /api/tier and /api/circle, so
 * "send $MERRYMEN to my account" opens this desk the same moment it lifts the
 * gate. Either half failing to read is `unreachable`, never a smaller number.
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
import { createPublicClient } from "viem";

import { tenantOf } from "@/lib/auth";
import { holderWalletFor } from "@/lib/holder-wallet";
import { agentAccountFor } from "@/lib/agent-account";
import { AGENT_BALANCE_TTL_MS, readStanding } from "@/lib/merrymen-standing";
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
/** The agent's own account: the balance an owner has just been told to top up. */
const agentBalances = new Map<string, { at: number; raw: bigint }>();

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

  /**
   * THE SAME WALLET THE WORKER READS — see lib/holder-wallet.ts.
   *
   * This read the session wallet directly, which was right until a wallet
   * could be PROVEN by signature. After that, linking a second wallet started
   * the Circle strategies running while this page went on saying the holder
   * did not qualify: two surfaces, two answers, both confident, about the same
   * person. One resolver now, so they cannot drift again.
   *
   * Nothing is loosened. A proof is only ever written by /api/holder after
   * recovering a signature naming both the wallet and this account, and the
   * self-declared `settings.holderAddress` this file has always refused is
   * still refused — the resolver will not read it.
   *
   * AND ONE WALLET OPENS ONE DESK. The resolver counts a wallet only while no
   * other account holds its claim, so there is no fallback to the session
   * wallet here: when it answers "no wallet" (another account holds this
   * login's claim), only the caller's own agent account is left to count.
   * Resolved INSIDE the try — a claims store that will not answer is an
   * unread standing, never a reason to guess.
   */
  let raw: bigint;
  try {
    const wallet = (await holderWalletFor(tenant))?.address ?? null;
    // The wallet above AND this caller's own agent account, in one read. The
    // account is resolved inside the try: a grant store that will not answer
    // is an unread standing, not an agent holding nothing.
    const standing = await readStanding({
      client: createPublicClient({ chain: robinhoodChain, transport: webChainRead() }),
      holder: wallet,
      agent: await agentAccountFor(req, true),
      holderCache: balances,
      agentCache: agentBalances,
      holderTtlMs: BALANCE_TTL_MS,
      agentTtlMs: AGENT_BALANCE_TTL_MS,
    });
    raw = standing.raw;
  } catch {
    // The chain (or the store saying whose wallet counts) would not answer.
    // That is a fact about our read, not about the reader's wallet — telling
    // them they hold too little would be a lie they cannot act on, and they
    // would go and buy more.
    return locked("unreachable", counts);
  }

  const tier = tierForBalance(raw);
  if (tier.minTokens < ENTRY_TIER.minTokens) return locked("balance", counts);
  return open(payload, alpha, tier);
}
