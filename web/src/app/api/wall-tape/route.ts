/**
 * The day's intents and what the wall did with them, as JSON.
 *
 * Exists so the bottom tape can open with the fleet's own headline number
 * instead of somebody else's coin price. Same reader the band uses, same
 * absence of any session read — which is what keeps it cacheable.
 */
import { NextResponse } from "next/server";
import { readWallTape } from "@/lib/read-wall-tape";

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
  const t = await readWallTape();
  // The cells are for a canvas and are large; a tape only needs the totals.
  return NextResponse.json(
    { source: t.source, counts: t.counts, capped: t.capped, from: t.from, to: t.to },
    { headers: { "Cache-Control": "public, max-age=15, s-maxage=30, stale-while-revalidate=60" } },
  );
}
