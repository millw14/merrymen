/**
 * GET /api/fomo/status — the signed-in owner's own Fomo research state.
 *
 * Two things, both read on the server for the caller's own tenant and nobody
 * else's: the owner's research status through the same registered tool every
 * surface uses (fomo_get_research_status: watches, research jobs, the latest
 * assessment and decision funnel, the watched-trader cohort), and the service's
 * health in plain words (not configured, provider unavailable, rationed,
 * receiving fresh data). Hosted, the tenant is the verified session cookie;
 * self-hosted, it is this install's fixed tenant. Nothing in the request can
 * name another owner, and nothing here writes anything but the request log.
 *
 * HOSTED, ONLY AN OWNER WITH AN AGENT: a signed-in wallet without a grant is
 * told so (403) and nothing is read — the research credits are the fleet's
 * owners'. An unreadable grant store is a 503, never "no agent".
 *
 * `monitoring` says whether trader-cohort monitoring and following can run on
 * this install at all. They are produced only by the hosted orchestrator's
 * fleet pass; a self-hosted install has lookups and nothing more, whatever its
 * fomoMonitoringEnabled / fomoFollowEnabled settings say.
 */
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { tenantOf } from "@/lib/auth";
import { FOMO_NEEDS_AGENT, fomoRuntime, fomoTenantFor, hostedFomoOwner } from "@/lib/fomo-runtime";
import { FOMO_ATTRIBUTION, renderEnvelope } from "../../../../../../worker/src/fomo/render";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

/** What this install can do beyond on-demand lookups, in plain words. */
const MONITORING_HOSTED = { available: true, note: null } as const;
const MONITORING_SELF_HOSTED = {
  available: false,
  note: "Trader-cohort monitoring and following run only on the hosted service. This install looks traders and coins up when you ask, and nothing more.",
} as const;

export async function GET(req: Request) {
  const hosted = isHostedMode();
  const session = hosted ? tenantOf(req) : null;
  if (hosted && !session) return NextResponse.json({ error: "not signed in" }, { status: 401, headers: NO_STORE });
  const tenant = fomoTenantFor(session, hosted);
  if (!tenant) return NextResponse.json({ error: "not signed in" }, { status: 401, headers: NO_STORE });
  if (hosted) {
    let owner: boolean;
    try {
      owner = await hostedFomoOwner(tenant);
    } catch {
      return NextResponse.json({ error: "Fomo research is not reachable right now." }, { status: 503, headers: NO_STORE });
    }
    if (!owner) return NextResponse.json({ error: FOMO_NEEDS_AGENT }, { status: 403, headers: NO_STORE });
  }

  let service;
  try {
    service = (await fomoRuntime(hosted)).service;
  } catch {
    return NextResponse.json({ error: "Fomo research is not reachable right now." }, { status: 503, headers: NO_STORE });
  }
  const now = Date.now();
  const [status, health] = await Promise.all([
    service.invoke(
      {
        tenant,
        surface: "app-chat",
        audience: "owner",
        conversationKey: null,
        requestId: `status-${now}-${Math.random().toString(36).slice(2, 10)}`,
        now,
        priority: "interactive",
        signal: req.signal,
      },
      "fomo_get_research_status",
      {},
    ),
    // THIS OWNER'S health (their access, their budget, the shared feed's
    // freshness) — not the process-wide view, where another owner's spent
    // allowance would read as this owner's "budget-limited".
    service.ownerHealth(tenant, now),
  ]);
  return NextResponse.json(
    {
      status,
      health,
      monitoring: hosted ? MONITORING_HOSTED : MONITORING_SELF_HOSTED,
      text: renderEnvelope(status, { audience: "owner", maxChars: 1_800, now }),
      attribution: FOMO_ATTRIBUTION,
    },
    { headers: NO_STORE },
  );
}
