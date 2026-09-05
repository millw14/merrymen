import { NextResponse } from "next/server";
import { fetchMarket } from "@/lib/market";

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
  const data = await fetchMarket();
  return NextResponse.json(data, {
    headers: { "Cache-Control": "public, max-age=15, s-maxage=30, stale-while-revalidate=60" },
  });
}
