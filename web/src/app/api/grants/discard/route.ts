/**
 * THE WEB'S START OVER: the signed key discarded (the kill switch) and the
 * practice book asked to start over, in one request the browser sends at once
 * and a closed tab cannot cut in half. lib/start-over.ts says why the two
 * halves are ordered here rather than in the page, and in which order.
 *
 * The grant is removed exactly as DELETE /api/grants removes it: hosted, the
 * authenticated tenant's stored grant; self-hosted, grant.json, archived first
 * so the owner key survives. The reset is queued exactly as /api/paper-reset
 * queues it, for the account the grant named, and the worker (or, while its
 * book is held, the orchestrator) refuses it on the live rail, so nothing real
 * can be cleared from here.
 */
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { getGrantStore } from "@merrymen/grant-store";
import { tenantOf } from "@/lib/auth";
import { diskAgent, hostedAgentFor } from "@/lib/agent-for";
import { GrantArchiveError, removeSelfHostedGrant } from "@/lib/grant-archive";
import { queuePaperReset, startOver } from "@/lib/start-over";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (isHostedMode()) {
    const tenant = tenantOf(req);
    if (!tenant) return NextResponse.json({ error: "not signed in" }, { status: 401 });
    const paperReset = await startOver({
      account: () => hostedAgentFor(req),
      remove: () => getGrantStore().remove(tenant),
      queueReset: async (account) => (await queuePaperReset(true, account)).ok,
    });
    return NextResponse.json({ ok: true, paperReset });
  }
  try {
    const paperReset = await startOver({
      account: () => diskAgent(),
      remove: removeSelfHostedGrant,
      queueReset: async (account) => (await queuePaperReset(false, account)).ok,
    });
    return NextResponse.json({ ok: true, paperReset });
  } catch (e) {
    if (e instanceof GrantArchiveError) return NextResponse.json({ error: e.message, paused: e.paused }, { status: 409 });
    throw e;
  }
}
