/**
 * GET /api/fomo/status — the signed-in owner's own Fomo research state.
 *
 * Two things, both read on the server for the caller's own tenant and nobody
 * else's: the owner's research status through the same registered tool every
 * surface uses (fomo_get_research_status: watches, research jobs, the latest
 * assessment and decision funnel, the followed cohort), and the service's
 * health in plain words (not configured, provider unavailable, rationed,
 * receiving fresh data). Hosted, the tenant is the verified session cookie;
 * self-hosted, it is this install's fixed tenant. Nothing in the request can
 * name another owner, and nothing here writes anything but the request log.
 */
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { tenantOf } from "@/lib/auth";
import { fomoRuntime, fomoTenantFor } from "@/lib/fomo-runtime";
import { FOMO_ATTRIBUTION, renderEnvelope } from "../../../../../../worker/src/fomo/render";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

export async function GET(req: Request) {
  const hosted = isHostedMode();
  const session = hosted ? tenantOf(req) : null;
  if (hosted && !session) return NextResponse.json({ error: "not signed in" }, { status: 401, headers: NO_STORE });
  const tenant = fomoTenantFor(session, hosted);
  if (!tenant) return NextResponse.json({ error: "not signed in" }, { status: 401, headers: NO_STORE });

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
    service.health(now),
  ]);
  return NextResponse.json(
    {
      status,
      health,
      text: renderEnvelope(status, { audience: "owner", maxChars: 1_800, now }),
      attribution: FOMO_ATTRIBUTION,
    },
    { headers: NO_STORE },
  );
}
