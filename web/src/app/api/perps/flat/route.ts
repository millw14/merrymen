import { readRequestPurpose } from "@/lib/account-purpose";
/**
 * GET /api/perps/flat?smartAccount=0x… — is this agent's Lighter venue
 * PROVABLY flat? (docs/perps.md rule 5; worker/src/perps/flatness.ts)
 *
 * The dashboard asks before it offers anything that lets go of the venue key —
 * signing without perps, starting over under a new account — so the owner is
 * told what is still there before the server's 409 has to say it. The answer
 * is `{ smartAccount, flat: true | false | null, detail }`; `null` is "could
 * not be read" and every caller treats it like `false`.
 *
 * AUTHENTICATED AS GET /api/grants IS, AND ONLY FOR THE CALLER'S OWN AGENT.
 * Hosted, the tenant session (401 without one) and the account must be the one
 * this tenant's stored grant names; self-hosted, the loopback perimeter and
 * the account in grant.json. Anything else is a 404: the venue publishes
 * positions anyway (rule 17's "the venue publishes the account"), but this
 * route spends the server's own venue and RPC budget and answers only for the
 * agent it serves.
 *
 * `force-dynamic` and `private, no-store`: the answer is about money, and a
 * cached "flat" is exactly the stale answer that must never be served.
 * Rate-limited per caller — each call is several chain and venue reads.
 */
import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { grantPurpose, isHostedMode, type StoredGrant } from "@merrymen/core";
import { homePaths } from "@merrymen/home";
import { getGrantStore } from "@merrymen/grant-store";
import { tenantOf } from "@/lib/auth";
import { NO_STORE_HEADERS, perRouteLimiter, readVenueFlatness } from "@/lib/perp-custody";

export const dynamic = "force-dynamic";

/** Ten reads a minute per caller: a screen asks once before a drop, and again after a close. */
const limit = perRouteLimiter(10);

function reply(body: Record<string, unknown>, status = 200, extra: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...NO_STORE_HEADERS, ...extra } });
}

export async function GET(req: Request) {
  const hosted = isHostedMode();
  const tenant = hosted ? tenantOf(req) : null;
  if (hosted && !tenant) return reply({ error: "not signed in" }, 401);
  const purpose = readRequestPurpose(req);
  if (!purpose) return reply({ error: "Invalid account purpose" }, 400);

  const asked = new URL(req.url).searchParams.get("smartAccount");
  if (typeof asked !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(asked)) {
    return reply({ error: "expected ?smartAccount=<0x address>", code: "bad-request" }, 400);
  }
  const smartAccount = asked.toLowerCase() as `0x${string}`;

  let stored: StoredGrant | null = null;
  if (hosted) {
    try {
      stored = await getGrantStore(purpose).get(tenant as `0x${string}`);
    } catch {
      return reply({ error: "couldn't read your agent right now — please try again", ownerFacing: true }, 503);
    }
  } else {
    try {
      stored = JSON.parse(await readFile(homePaths.grant(purpose), "utf8")) as StoredGrant;
    } catch {
      stored = null;
    }
  }
  if (!stored || grantPurpose(stored) !== purpose || typeof stored.smartAccount !== "string" || stored.smartAccount.toLowerCase() !== smartAccount) {
    return reply({ error: "no agent of yours has that account", code: "not-found" }, 404);
  }

  const allowed = limit(tenant ?? "self-hosted");
  if (!allowed.ok) {
    return reply({ error: "asked too often — wait a minute and try again", code: "rate-limited", ownerFacing: true }, 429, {
      "Retry-After": String(allowed.retryAfterSec),
    });
  }

  const f = await readVenueFlatness(smartAccount);
  return reply({ smartAccount, flat: f.flat, detail: f.detail ?? null });
}
