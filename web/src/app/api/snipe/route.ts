/**
 * "SNIPE PEPE WITH $20" — RESOLVE FIRST, THEN PLACE.
 *
 * `/api/orders` takes a symbol its caller has already resolved. A snipe is the
 * case where nobody has: an owner names a coin the way they would to a friend,
 * and this route works out whether that means one token, several, or none.
 *
 * IT IS NOT A SECOND EXECUTION PATH. When the query resolves to exactly one
 * covered coin, this hands off to the same order channel the confirm button
 * already uses — same tenant check, same ceiling, same idempotency, same wall
 * behind it. `worker/src/index.ts` states the invariant it is protecting:
 * "there is no second execution path and no bypass flag anywhere". This adds a
 * resolver in front of the existing one, not a way around it.
 *
 * THE THREE ANSWERS ARE NOT ERRORS. One coin places an order; several coins is
 * a question with the addresses that tell them apart; none found says so. And a
 * fourth, which is the one this chain makes common: found it, and your signed
 * permission does not cover it yet — which is the wall working, and the only
 * reply that tells an owner what to do next.
 */
import { NextResponse } from "next/server";
import {
  STOCK_TOKENS,
  resolveSnipeTarget,
  shortAddress,
  type SnipeCandidate,
} from "@merrymen/core";
import { isHostedMode } from "@merrymen/core";
import { tenantOf } from "@/lib/auth";
import { getSettingsStore } from "@merrymen/settings-store";
import { sharedRead } from "@/lib/read-discoveries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What a settings-stored custom token looks like once it has been validated. */
interface CustomToken {
  symbol: string;
  address: string;
  decimals: number;
}

const isCustomToken = (v: unknown): v is CustomToken =>
  !!v &&
  typeof v === "object" &&
  typeof (v as CustomToken).symbol === "string" &&
  typeof (v as CustomToken).address === "string";

/**
 * Everything this tenant could plausibly mean, with coverage attached.
 *
 * THREE SOURCES, IN DESCENDING ORDER OF HOW WELL WE KNOW THEM: the curated
 * registry, the tokens this owner has already added, and what the scout has
 * discovered. A coin can appear in more than one; the address de-dupes them,
 * and the FIRST spelling wins because the curated registry's symbol is the one
 * that is not attacker-chosen.
 */
async function candidatesFor(tenant: `0x${string}` | null): Promise<SnipeCandidate[]> {
  const out: SnipeCandidate[] = [];
  const seen = new Set<string>();
  const add = (c: SnipeCandidate) => {
    const key = c.address.toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ ...c, address: key });
  };

  // The owner's own list first: `covered` is only meaningful for these, because
  // a grant seals the custom-token list and nothing else.
  let custom: CustomToken[] = [];
  if (tenant) {
    try {
      const s = await getSettingsStore().get(tenant);
      custom = ((s?.customTokens ?? []) as unknown[]).filter(isCustomToken);
    } catch {
      /* no settings yet — the registry and the scout can still answer */
    }
  }
  for (const t of custom) add({ address: t.address, symbol: t.symbol, name: t.symbol, covered: true });
  for (const t of STOCK_TOKENS) add({ address: t.address, symbol: t.symbol, name: t.name, covered: true });

  // And what the scout has seen. NOT covered — a discovered coin is watchable
  // and not tradable until a signature says so, which is the whole point of the
  // reply this route gives for it.
  try {
    const d = await sharedRead();
    for (const r of d.rows ?? []) {
      add({ address: r.token, symbol: r.name, name: r.name, covered: false });
    }
  } catch {
    /* the index is optional; the registry and the owner's list still answer */
  }
  return out;
}

export async function POST(req: Request) {
  const tenant = isHostedMode() ? tenantOf(req) : null;
  if (isHostedMode() && !tenant) {
    return NextResponse.json({ error: "sign in first" }, { status: 401 });
  }

  let body: { query?: unknown; usdgAmount?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad body" }, { status: 400 });
  }

  const query = typeof body.query === "string" ? body.query.slice(0, 64).trim() : "";
  const usdgAmount = Number(body.usdgAmount);
  if (!query) return NextResponse.json({ error: "name a coin to go after" }, { status: 400 });
  // The size is checked HERE as well as at the order route, because a snipe
  // that resolves and then fails on an amount has already spent the owner's
  // attention on a question they cannot act on.
  if (!Number.isFinite(usdgAmount) || usdgAmount <= 0) {
    return NextResponse.json({ error: "say how much to put in" }, { status: 400 });
  }

  const resolved = resolveSnipeTarget(query, await candidatesFor(tenant));

  if (resolved.kind === "none") {
    return NextResponse.json({
      outcome: "not-found",
      query,
      // Said as a fact about our search rather than about the coin: it may well
      // exist and simply not be anywhere this agent can see yet.
      say:
        `I could not find anything called “${query}” in my registry, your watchlist, or what my ` +
        `scout has turned up. If you have its contract address, give me that instead — an address ` +
        `is the only name a token cannot lie about.`,
    });
  }

  if (resolved.kind === "many") {
    const shown = resolved.candidates.slice(0, 6);
    return NextResponse.json({
      outcome: "ambiguous",
      query,
      candidates: shown.map((c) => ({
        symbol: c.symbol,
        address: c.address,
        short: shortAddress(c.address),
        covered: !!c.covered,
      })),
      total: resolved.candidates.length,
      say:
        `${resolved.candidates.length} different coins answer to “${query}” — anyone can launch a ` +
        `token calling itself anything, so the ticker is not the identity here. Tell me which ` +
        `address you mean and I will go after that one: ` +
        shown.map((c) => shortAddress(c.address)).join(", "),
    });
  }

  const t = resolved.target;
  if (!t.covered) {
    return NextResponse.json({
      outcome: "needs-signature",
      target: { symbol: t.symbol, address: t.address, short: shortAddress(t.address) },
      say:
        `Found it — ${t.symbol} at ${shortAddress(t.address)}. I cannot buy it yet: the permission ` +
        `you signed names the tokens I may touch, and this one is not on it. Add it to your ` +
        `watchlist and re-sign — one signature, free, nothing moves on-chain — and I can go after ` +
        `it on the next tick.`,
    });
  }

  // ONE COIN, COVERED. Hand off to the order channel the confirm button already
  // uses, rather than reaching for the worker directly.
  const placed = await fetch(new URL("/api/orders", req.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // The caller's session travels with it: /api/orders authorises the tenant
      // itself, and it must, because this route is not the thing holding the
      // authority.
      cookie: req.headers.get("cookie") ?? "",
    },
    body: JSON.stringify({ side: "buy", symbol: t.symbol, usdgAmount }),
  });
  const order = (await placed.json().catch(() => null)) as { error?: string; duplicate?: boolean } | null;
  if (!placed.ok) {
    return NextResponse.json(
      { outcome: "refused", target: { symbol: t.symbol }, error: order?.error ?? `refused (${placed.status})` },
      { status: placed.status },
    );
  }
  return NextResponse.json({
    outcome: "placed",
    target: { symbol: t.symbol, address: t.address, short: shortAddress(t.address) },
    duplicate: !!order?.duplicate,
    // PLACED, NOT BOUGHT — the same discipline the order card already keeps. A
    // 200 here means a row exists on the command channel; the fill, the refusal
    // or the paper practice arrives on the tape a minute later.
    say: order?.duplicate
      ? `Already had that one queued — ${t.symbol} for $${usdgAmount}. I have not placed it twice.`
      : `On it — ${t.symbol} at ${shortAddress(t.address)}, $${usdgAmount}. Placed, not filled: my ` +
        `key's limits still decide, and however it ends it lands on your trades.`,
  });
}
