/**
 * Find an agent or a token by typing.
 *
 * A trading surface is navigated by symbol, not by browsing, and a search box
 * that does not work is worse than none — so this is a real query over the two
 * things this product has pages for.
 *
 * NO SESSION READ, like every other public reader here, which is what keeps it
 * cacheable. It is deliberately NOT `force-dynamic`: the answer depends only on
 * the query string, so two people typing the same letters get the same bytes.
 *
 * WHAT IT WILL NOT RETURN: a smart account. An agent is addressed by its slug,
 * which is exactly why the slug exists, and the account is an address the
 * publication gate would refuse to print anyway.
 */
import { NextResponse } from "next/server";
import { withReadDb } from "@/lib/ledger";
import { getIdentityStore } from "@merrymen/identity-store";
import { fetchMarket } from "@/lib/market";

/**
 * A DEAD DIRECTIVE IS WORSE THAN NO DIRECTIVE, so it is gone.
 *
 * This carried `revalidate = 30`, which never took effect: the handler reads
 * `req.url` for the query string, Next's request proxy throws a
 * DynamicServerError the moment it does, and the route silently demotes to
 * dynamic. So the line described a caching behaviour the route did not have,
 * on a route that reads the ledger — the same shape of claim that left the
 * home feed baked empty into the image.
 *
 * It is stated rather than deleted, because "search is dynamic" is a fact worth
 * being explicit about on a route whose results depend on the caller's query.
 */
export const dynamic = "force-dynamic";

export interface SearchHit {
  kind: "agent" | "token";
  /** `/a/<slug>` or `/t/<address>`. */
  href: string;
  title: string;
  sub: string | null;
}

/** Enough to fill a dropdown; more is a list nobody reads. */
const LIMIT = 8;

export async function GET(req: Request) {
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().toLowerCase();
  // Two characters, because one matches most of the universe and the work is
  // wasted on a query nobody has finished typing.
  if (q.length < 2) return NextResponse.json({ hits: [] satisfies SearchHit[] });

  const hits: SearchHit[] = [];

  // ── tokens ───────────────────────────────────────────────────────────────
  // From the market read the whole product already shares, so a search costs
  // nothing beyond what /tokens was going to fetch anyway.
  try {
    const market = await fetchMarket();
    for (const t of market.tokens) {
      if (hits.length >= LIMIT) break;
      const sym = t.symbol.toLowerCase();
      const name = (t.name ?? "").toLowerCase();
      if (!sym.includes(q) && !name.includes(q)) continue;
      hits.push({
        kind: "token",
        href: `/t/${t.address}`,
        title: t.symbol,
        sub: t.name || null,
      });
    }
  } catch {
    /* the market read is optional to a search */
  }

  // ── agents ───────────────────────────────────────────────────────────────
  // Name and handle come from the ledger; the slug — the only address a link
  // may use — comes from the identity store, so an agent without one is simply
  // not findable rather than being linked somewhere that 404s.
  try {
    const slugFor = new Map<string, string>();
    for (const id of await getIdentityStore().all()) {
      for (const a of id.accounts) slugFor.set(a.toLowerCase(), id.slug);
    }

    await withReadDb(async (db) => {
      if (!db) return;
      const rows = (await db
        .prepare(
          `SELECT smart_account, name, x_handle, COALESCE(mode, 'idle') AS mode
             FROM agents
            WHERE mode IN ('live','paper') AND smart_account NOT LIKE 'rh:%'
            ORDER BY created_at DESC LIMIT 200`,
        )
        .all()) as { smart_account: string; name: string; x_handle: string | null; mode: string }[];

      for (const r of rows) {
        if (hits.length >= LIMIT) break;
        const name = String(r.name ?? "").toLowerCase();
        const handle = String(r.x_handle ?? "").toLowerCase();
        if (!name.includes(q) && !handle.includes(q)) continue;
        const slug = slugFor.get(String(r.smart_account).toLowerCase());
        if (!slug) continue;
        if (hits.some((h) => h.href === `/a/${slug}`)) continue;
        hits.push({
          kind: "agent",
          href: `/a/${slug}`,
          title: String(r.name ?? "Agent"),
          sub: r.x_handle ? `@${r.x_handle}` : r.mode,
        });
      }
    });
  } catch {
    /* an unreadable ledger means no agent hits, never a 500 */
  }

  return NextResponse.json(
    { hits },
    { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" } },
  );
}
