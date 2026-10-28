/**
 * The operator's fleet-wide service notice, as JSON — `{ notice }`, where a
 * missing, blank or refused env var is `{ notice: null }`.
 *
 * No session is read and no tenant data is written into it: every visitor gets
 * the same bytes, which is what makes it shared-cacheable. lib/service-notice
 * owns the shape and says why it is this narrow.
 *
 * A REFUSED NOTICE IS LOGGED, NOT SERVED. The reason goes to the server log
 * once per distinct value, so the operator who set it can see why the banner
 * did not appear; a visitor sees no banner rather than a broken one.
 */
import { NextResponse } from "next/server";
import { parseServiceNotice } from "@/lib/service-notice";

/**
 * NOT PRERENDERED AT BUILD, and that is a correctness rule rather than a
 * performance one.
 *
 * A static GET is run once inside `docker build` and its body shipped. The
 * notice is set by a Railway variable on the RUNNING service — a baked body
 * would carry whatever the build saw, and unsetting the variable would not
 * take the banner down until the next build. So this is read per request.
 */
export const dynamic = "force-dynamic";

/**
 * Short, because the notice is incident text. A minute at the edge plus a
 * minute of revalidation is the longest anyone sees a notice the operator has
 * already changed or removed; the banner itself asks with `no-store`.
 */
const CACHE = "public, max-age=60, s-maxage=60, stale-while-revalidate=60";

/** The last refused value we logged, so a polled route does not log per request. */
let logged: string | undefined;

export async function GET() {
  const raw = process.env.MERRYMEN_SERVICE_NOTICE;
  const read = parseServiceNotice(raw);
  if (!read.ok && logged !== raw) {
    logged = raw;
    console.warn(`[merrymen] MERRYMEN_SERVICE_NOTICE ignored: ${read.why}`);
  }
  return NextResponse.json(
    { notice: read.ok ? read.notice : null },
    { headers: { "Cache-Control": CACHE } },
  );
}
