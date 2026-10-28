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
 *
 * IT REACHES THE PERPS WALLET TOO. Owners are told this is the kill switch (the
 * MCP control list, the hosted Telegram kill's fallback), so it revokes the
 * Perps grant as every kill does (perps-kill.ts), whatever happens to the Spot
 * grant, and says the Start over is incomplete while that half fails. A retry
 * is safe. The practice reset stays the Spot book's. It does not stop the
 * Solana strategy, which it never did.
 */
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { getGrantStore } from "@merrymen/grant-store";
import { tenantOf } from "@/lib/auth";
import { expectedTenantMatches } from "@/lib/expected-tenant";
import { diskAgent, hostedAgentFor } from "@/lib/agent-for";
import { GrantArchiveError, removeSelfHostedGrant } from "@/lib/grant-archive";
import { queuePaperReset, startOver, type StartOverReset } from "@/lib/start-over";
import { perpsHalf, stopLocalPerpsForKill, stopPerpsForKill, type PerpsHalf } from "../../../../../../worker/src/perps-kill";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (isHostedMode()) {
    const tenant = tenantOf(req);
    if (!tenant) return NextResponse.json({ error: "not signed in" }, { status: 401 });
    if (!(await expectedTenantMatches(req, tenant))) {
      return NextResponse.json({ error: "Your sign-in changed. Reload your agent and try again." }, { status: 409 });
    }
    let started: StartOverReset | null = null;
    let removal: unknown = null;
    try {
      started = await startOver({
        account: () => hostedAgentFor(req),
        remove: () => getGrantStore("spot").remove(tenant),
        queueReset: async (account) => (await queuePaperReset(true, account)).ok,
      });
    } catch (e) {
      removal = e ?? new Error("grant removal failed");
    }
    const perps = await perpsHalf(() => stopPerpsForKill(tenant));
    if (removal !== null || started === null) throw removal;
    return startedOver(started, perps);
  }
  // Self-hosted, the local Perps wallet first, whatever happens to grant.json: an
  // archive this cannot write keeps grant.json, and must not leave a Perps grant
  // signing behind that answer.
  const perps = await perpsHalf(() => stopLocalPerpsForKill());
  try {
    const paperReset = await startOver({
      account: () => diskAgent(),
      remove: removeSelfHostedGrant,
      queueReset: async (account) => (await queuePaperReset(false, account)).ok,
    });
    return startedOver(paperReset, perps);
  } catch (e) {
    if (e instanceof GrantArchiveError) {
      return NextResponse.json({ error: e.message, paused: e.paused, ...(perps.state === "none" ? {} : { perps: perps.state }) }, { status: 409 });
    }
    throw e;
  }
}

/**
 * Done only when the Perps half is: an owner with no Perps wallet gets exactly
 * the answer Start over always gave, and one whose Perps grant could not be
 * revoked is told the Start over is incomplete, never that it is done.
 */
function startedOver(paperReset: StartOverReset, perps: PerpsHalf): NextResponse {
  if (perps.state === "not-stopped") {
    return NextResponse.json({
      error: `Start over incomplete: your agent's grant is discarded, but your Perps wallet's ${perps.left === "paper" ? "practice perpetuals could not be switched off" : "grant could not be revoked"} yet.${perps.why ? ` ${perps.why}` : ""} Try again.`,
      ownerFacing: true, paperReset, perps: "not-stopped",
    }, { status: 503 });
  }
  return NextResponse.json(perps.state === "stopped" ? { ok: true, paperReset, perps: "stopped" } : { ok: true, paperReset });
}
