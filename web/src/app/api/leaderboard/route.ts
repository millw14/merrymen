/**
 * The public ranking.
 *
 * Distinct from /api/scoreboard, which is per-caller and deliberately scoped —
 * its own header calls the unscoped version "a customer-list dump". This one
 * publishes a much narrower row: no smart account, no caps, no fees, no
 * high-water mark, and no absolute dollar figure at all. See lib/read-leaderboard.
 *
 * Cacheable for the same reason /api/theses is: there is no `tenantOf` and no
 * per-caller anything in this file or in the module it calls.
 */
import { NextResponse } from "next/server";
import { readLeaderboard } from "@/lib/read-leaderboard";

/**
 * NOT PRERENDERED AT BUILD, and that is a correctness rule rather than a
 * performance one.
 *
 * `export const revalidate = <n>` on an App-Router route or page is an OPT-IN
 * TO BUILD-TIME PRERENDERING — Next runs the handler once inside `docker build`
 * and ships the body. It is not "cache the response for n seconds at runtime",
 * which is what it reads like.
 *
 * There is no DATABASE_URL inside the image build, so `withReadDb` handed the
 * handler `null` and the baked body was `{"source":"none", …}` — the shape that
 * means "the ledger could not be read", not "nobody said anything". Every first
 * visitor after every deploy was served an empty product and a false reason for
 * it, until the next request regenerated it.
 *
 * So this is dynamic. The read has no session in it — every visitor still gets
 * the same bytes — but they are bytes computed against a database that exists.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const r = await readLeaderboard();
  return NextResponse.json(r, {
    headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" },
  });
}
