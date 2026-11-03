import { NextResponse } from "next/server";
import { sharedRead } from "@/lib/read-discoveries";
import { walletNotSupported } from "@/lib/route-guard";

/**
 * What is trading on this chain, over HTTP.
 *
 * The read itself lives in lib/read-discoveries so a server component can call
 * it directly and share the single-flight memo, rather than fetching this
 * route and paying a second trip upstream. Everything of substance — what is
 * fetched, what is refused, what "degraded" means — is documented there.
 */
// Dynamic, with an in-process single-flight memo below instead of ISR: this
// route must be able to REFUSE to cache a degraded render, which a fixed
// revalidate cannot do.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const walletRefused = walletNotSupported(req);
  if (walletRefused) return walletRefused;
  const payload = await sharedRead();
  return NextResponse.json(payload, {
    headers: {
      // Mirrors the memo above for any cache in front of us.
      "Cache-Control": payload.degraded
        ? "public, s-maxage=10, stale-while-revalidate=0"
        : "public, s-maxage=120, stale-while-revalidate=240",
    },
  });
}
