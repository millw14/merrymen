/**
 * Start the practice book over — queue it for the worker, which is the only
 * process that can actually do it.
 *
 * "Should positions and trades also become empty when 'starting over' in paper
 * mode? They still appear." They did. Discarding a grant forgets a signed KEY;
 * the book is worker-side state, and the ledger mirror runs strictly child →
 * shared, so anything this service deleted would be rewritten within a minute.
 * The screen could only warn about it. This is the thing that warning stood in
 * for, and it goes through the existing command channel rather than a new one —
 * the same shape as /api/selftest, for the reasons command-files.ts sets out.
 *
 * THE RAIL CHECK THAT MATTERS IS THE WORKER'S, not this one. This route knows
 * what the dashboard believes; the worker knows what rail it is actually on,
 * and it refuses a live agent outright. Between here and there the instruction
 * crosses a shared table, an orchestrator that can see every tenant's home, and
 * a JSON file — so the check that stands between a click and a DELETE has to be
 * the one at the far end. Same argument runOrderCommand makes about orders.
 *
 * WHAT IT IS NOT. Not a delete of anything that could have been real. The
 * worker closes the old rows into a new accounting epoch and clears only the
 * simulated book and the caches derived from it. There is no request shape that
 * reaches a live agent's history.
 */
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { hostedAgentFor, diskAgent } from "@/lib/agent-for";
import { queuePaperReset } from "@/lib/start-over";

export const dynamic = "force-dynamic";

const agentFor = (req: Request) => (isHostedMode() ? hostedAgentFor(req) : diskAgent());

/**
 * The practice reset on its own, as the iOS and Android apps ask for it. The
 * web's Start over does not come here: it discards the grant as well, and the
 * reset has to be queued from the grant before it goes, so it asks
 * /api/grants/discard to do both (lib/start-over.ts).
 */
export async function POST(req: Request) {
  const agent = await agentFor(req);
  if (!agent) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  const queued = await queuePaperReset(isHostedMode(), agent);
  if (!queued.ok) return NextResponse.json({ error: queued.error }, { status: 503 });
  return NextResponse.json({ id: queued.id, queued: true });
}
