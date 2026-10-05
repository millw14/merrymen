/**
 * THE FLEET HEARTBEAT, FOR AN OPERATOR'S CHECK — AND FOR NOBODY ELSE.
 *
 * The orchestrator publishes one `fleet_heartbeat` row per role every minute
 * (worker/src/fleet-heartbeat.ts). This serves those rows to a scheduled
 * check that runs outside the platform, so a fleet that has died, wedged,
 * been left halted or deployed from the wrong commit is noticed by something
 * other than a person who already suspected it.
 *
 * INERT UNLESS MERRYMEN_OPS_TOKEN IS SET. Without it — every self-hosted
 * install, and the hosted web until an operator opts in — the route answers
 * exactly as a route that does not exist would: 404, no body. A token shorter
 * than 32 characters counts as unset, because a guessable token on a public
 * origin is worse than none.
 *
 * WITH IT, A BEARER TOKEN OR NOTHING. Compared as SHA-256 digests in constant
 * time, so neither its content nor its length leaks through timing. No
 * session, no cookie: the caller is a script, not a signed-in owner, and
 * nothing here is any tenant's.
 *
 * AGGREGATES ONLY. Every field served is rebuilt from the row by
 * publicHeartbeat — counts, enums, a commit hash, times — never an account,
 * an amount, a name or a rule's text, whatever the stored JSON holds.
 *
 * NEVER CACHED. `no-store` on every answer, the refusals included: a beat a
 * shared cache replays is a dead fleet reported alive.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { withReadDb } from "@/lib/ledger";
import { readFleetHeartbeats, type PublicHeartbeat } from "../../../../../../worker/src/fleet-heartbeat";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;
/** Below this the token is treated as unset: the route stays a 404. */
const MIN_TOKEN_LENGTH = 32;

export interface OpsHeartbeatResponse {
  /** Unix seconds, by this server's clock: what every beatAgeSec is measured against. */
  now: number;
  heartbeats: PublicHeartbeat[];
}

function opsToken(): string | null {
  const token = (process.env.MERRYMEN_OPS_TOKEN ?? "").trim();
  return token.length >= MIN_TOKEN_LENGTH ? token : null;
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

function authorized(req: Request, token: string): boolean {
  const m = /^Bearer\s+(\S+)\s*$/.exec(req.headers.get("authorization") ?? "");
  return !!m && timingSafeEqual(digest(m[1]!), digest(token));
}

export async function GET(req: Request) {
  const token = opsToken();
  if (!token) return new NextResponse(null, { status: 404, headers: NO_STORE });
  if (!authorized(req, token)) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: { ...NO_STORE, "www-authenticate": "Bearer" } },
    );
  }
  try {
    return await withReadDb(async (db) => {
      const now = Math.floor(Date.now() / 1000);
      // No ledger to read is no heartbeat yet — an empty list, which the
      // check reads as "nothing is beating", never as healthy.
      const heartbeats = db ? await readFleetHeartbeats(db, now) : [];
      return NextResponse.json({ now, heartbeats } satisfies OpsHeartbeatResponse, { headers: NO_STORE });
    });
  } catch {
    // A read that failed is not an empty fleet: said apart, so the check can
    // tell "cannot see" from "nothing there".
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });
  }
}
