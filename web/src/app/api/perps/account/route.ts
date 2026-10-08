import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { homePaths } from "@merrymen/home";
import { getGrantStore, hasStoredGrant } from "@merrymen/grant-store";
import { getIdentityStore } from "@merrymen/identity-store";
import { tenantOf } from "@/lib/auth";
import { withReadDb } from "@/lib/ledger";
import { NO_STORE_HEADERS } from "@/lib/perp-custody";
import { emptyPerpsAccount, perpsAccountIdentity, readPerpsAccountData } from "@/lib/perps-account-data";
export const dynamic = "force-dynamic";
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { ...NO_STORE_HEADERS, Vary: "Cookie" } });
export async function GET(req: Request) {
  const hosted = isHostedMode(), owner = hosted ? tenantOf(req) : null;
  if (hosted && !owner) return reply({ error: "not signed in" }, 401);
  if (new URL(req.url).search) return reply({ error: "account selectors are not accepted" }, 400);
  const answer = emptyPerpsAccount(owner, Date.now());
  try {
    let grant: unknown;
    if (owner) grant = await getGrantStore().get(owner);
    else {
      try { grant = JSON.parse(await readFile(homePaths.grant(), "utf8")); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; grant = null; }
    }
    if (grant === null) return reply({ ...answer, state: owner && await hasStoredGrant(owner) ? "unread" : "not-configured" });
    answer.account = perpsAccountIdentity(grant);
    if (!answer.account) return reply(answer);
    if (owner) try {
      const identity = await getIdentityStore().get(owner);
      if (identity?.tenant.toLowerCase() === owner && identity.accounts[0]?.toLowerCase() === answer.account.agentId)
        answer.account.profile = { slug: identity.slug };
    } catch { /* A missing optional profile is not an invented identity. */ }
    await withReadDb(db => readPerpsAccountData(db, answer));
  } catch { /* Preserve unread states, never substitute another account. */ }
  return reply(answer);
}
