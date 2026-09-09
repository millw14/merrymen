/**
 * WHAT YOUR AGENT WOULD LIKE TO BE ABLE TO TRADE.
 *
 * THE CIRCULARITY THIS BREAKS. A discovered coin is unpriceable because it is
 * not watched, and it cannot be watched until somebody adds it by hand — three
 * steps across two screens plus a re-sign. So the scout finds coins every ten
 * minutes and every one of them dies at the wall as `asset-allowlist`, and the
 * owner never learns that the fix was theirs to make.
 *
 * This route is the agent's half of it: the coins it has actually vetted, with
 * its own reason, that THIS owner's signature does not yet cover. The owner's
 * half is one action — see the approve flow in the terminal.
 *
 * ── WHAT IS TRUE HERE, AND WHAT IS SOMEBODY ELSE'S CLAIM ───────────────────
 *
 * SYMBOL AND DECIMALS ARE READ FROM THE CONTRACT, never from the index.
 * `DiscoveryRow.name` is the index's label and read-discoveries says so
 * verbatim: "attacker-chosen and could impersonate a real ticker". A symbol is
 * about to be shown to a person AND written into a signed policy allowlist, so
 * it comes from the token's own `symbol()`, sanitised to the charset
 * `isValidCustomToken` will accept. `discovery.ts` states the same rule for the
 * same reason; this is that rule, applied at the point a human decides.
 *
 * PER-CALLER, because "does your grant already cover this" is a question about
 * one tenant. So: `force-dynamic`, no cache, `tenantOf` first. The expensive
 * half — the discovery sweep and the scout's verdicts — is the house-wide
 * memoised read every viewer already shares, so a caller costs a grant read and
 * at most a few `symbol`/`decimals` calls.
 *
 * IT PROPOSES; IT DOES NOT DECIDE. Nothing here writes settings, touches a
 * grant, or widens anything. It returns a list and the reasoning behind it.
 */
import { webChainRead } from "@/lib/chain-read";
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { getGrantStore } from "@merrymen/grant-store";
import { getSettingsStore } from "@merrymen/settings-store";
import { createPublicClient, erc20Abi } from "viem";
import { robinhoodChain } from "@merrymen/core";

import { tenantOf } from "@/lib/auth";
import { sharedRead } from "@/lib/read-discoveries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * How many coins may be proposed at once.
 *
 * A PRODUCT LIMIT, NOT A TECHNICAL ONE. Every one of these asks the owner to
 * re-sign their trading permission, and a list of thirty turns a considered
 * decision into a chore somebody clicks through. The scout ranks by conviction,
 * so the cap keeps the ones it argued hardest for.
 */
const MAX_PROPOSALS = 5;

/**
 * A token's own name for itself, read once and kept.
 *
 * `symbol()` and `decimals()` are immutable for every ERC-20 worth trading, so
 * this is a permanent fact about an address rather than a market reading. Keyed
 * house-wide because it is not per-tenant, and unbounded is fine: an entry is
 * two short strings and the key space is the coins the scout has ever vetted.
 */
const identity = new Map<string, { symbol: string; decimals: number } | null>();

/** Sanitised to what `isValidCustomToken` accepts — see tokens.ts:127. */
function sanitizeSymbol(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 16);
  return cleaned.length > 0 ? cleaned : "";
}

async function identityOf(token: `0x${string}`): Promise<{ symbol: string; decimals: number } | null> {
  const key = token.toLowerCase();
  if (identity.has(key)) return identity.get(key) ?? null;
  const client = createPublicClient({ chain: robinhoodChain, transport: webChainRead() });
  try {
    const [s, d] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }) as Promise<string>,
      client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }) as Promise<number>,
    ]);
    const symbol = typeof s === "string" ? sanitizeSymbol(s) : "";
    const decimals = Number(d);
    // NO FALLBACK SYMBOL. `discovery.ts` can afford to name an unreadable token
    // after its address because it is only reporting. This value is about to be
    // sealed into a permission allowlist, and a made-up one would be a claim
    // the chain never made. An unreadable ERC-20 is simply not proposable.
    if (!symbol || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      identity.set(key, null);
      return null;
    }
    const answer = { symbol, decimals };
    identity.set(key, answer);
    return answer;
  } catch {
    // NOT CACHED as a negative: an RPC that would not answer is not a token
    // that has no symbol, and caching the outage would hide the coin for the
    // life of the process.
    return null;
  }
}

export interface Proposal {
  token: `0x${string}`;
  /** From the CONTRACT, sanitised. Never the index's label. */
  symbol: string;
  decimals: number;
  /** The index's label, for context. Attacker-chosen — never used as identity. */
  indexLabel: string;
  /** The scout's own line. Conviction is an ordering, never a size or a permission. */
  conviction: number;
  reason: string;
  /** Still on its launch curve: no pool, so a swap cannot route to it. */
  onCurve: boolean;
  priceUsd: number | null;
  fdvUsd: number | null;
  volume24hUsd: number | null;
  buyers24h: number | null;
  /** Already in settings (watched and priced) but not covered by the signature. */
  watched: boolean;
}

export interface ProposalsResponse {
  proposals: Proposal[];
  /**
   * Why there are none, when there are none. "The scout picked nothing" and
   * "you have no agent to widen" are different facts with different remedies,
   * and an empty list renders identically for both.
   */
  why: "ok" | "signed-out" | "no-grant" | "nothing-vetted" | "all-covered" | "unreadable";
  /**
   * How many tokens the current signature already covers.
   *
   * Shown because approving ANY coin re-seals the permission around the whole
   * list — `grantTokens` is minted from all of `customTokens`, with no
   * per-token opt-in at signing (session.ts:403). The owner is entitled to know
   * what a re-sign actually re-authorises.
   */
  covered: number;
}

function answer(why: ProposalsResponse["why"], proposals: Proposal[] = [], covered = 0) {
  return NextResponse.json({ proposals, why, covered } satisfies ProposalsResponse, {
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function GET(req: Request) {
  // Self-hosted has one operator whose settings file IS the answer; there is no
  // tenant to look a grant up by, and the /settings screen is one click away.
  if (!isHostedMode()) return answer("signed-out");

  const tenant = tenantOf(req);
  if (!tenant) return answer("signed-out");

  let grant;
  try {
    grant = await getGrantStore().get(tenant);
  } catch {
    // An unreadable store is not an owner with no agent.
    return answer("unreadable");
  }
  if (!grant) return answer("no-grant");

  const covered = new Set((grant.grantTokens ?? []).map((t) => t.toLowerCase()));

  // WHAT THE OWNER ALREADY WATCHES. A token in settings but not in the grant
  // needs only a re-sign; one in neither needs the settings write too. The
  // approve action has to know which, and so does the sentence next to it.
  const watched = new Set<string>();
  try {
    const settings = (await getSettingsStore().get(tenant)) ?? {};
    for (const t of settings.customTokens ?? []) {
      if (typeof t?.address === "string") watched.add(t.address.toLowerCase());
    }
  } catch {
    // Unreadable settings do not stop a proposal; they only mean this flag is
    // conservative, and the approve path re-reads settings at click time anyway.
  }

  const payload = await sharedRead().catch(() => null);
  if (!payload) return answer("unreadable", [], covered.size);

  // VETTED ONLY. A row with no verdict was passed over or never judged, and
  // asking an owner to re-sign their trading permission for a coin nothing has
  // an opinion about is worse than saying nothing.
  const vetted = payload.rows.filter((r) => r.verdict);
  if (!vetted.length) return answer("nothing-vetted", [], covered.size);

  const fresh = vetted.filter((r) => !covered.has(r.token.toLowerCase()));
  if (!fresh.length) return answer("all-covered", [], covered.size);

  const proposals: Proposal[] = [];
  for (const row of fresh) {
    if (proposals.length >= MAX_PROPOSALS) break;
    const id = await identityOf(row.token as `0x${string}`);
    if (!id) continue; // unreadable ERC-20 — not proposable, see identityOf
    proposals.push({
      token: row.token as `0x${string}`,
      symbol: id.symbol,
      decimals: id.decimals,
      indexLabel: row.name,
      conviction: row.verdict!.conviction,
      reason: row.verdict!.reason,
      onCurve: row.onCurve,
      priceUsd: row.priceUsd,
      fdvUsd: row.fdvUsd,
      volume24hUsd: row.volume24hUsd,
      buyers24h: row.buyers24h,
      watched: watched.has(row.token.toLowerCase()),
    });
  }

  // Highest conviction first — the scout's own ordering, and the reason the cap
  // above keeps the right ones.
  proposals.sort((a, b) => b.conviction - a.conviction);
  return answer(proposals.length ? "ok" : "nothing-vetted", proposals, covered.size);
}
