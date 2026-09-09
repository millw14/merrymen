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
import { merrymenHome } from "@merrymen/home";
import { isHostedMode } from "@merrymen/core";
import { writeCommand } from "@merrymen/command-files";
import { withReadDb } from "@/lib/ledger";
import { hostedAgentFor, diskAgent } from "@/lib/agent-for";

export const dynamic = "force-dynamic";

const agentFor = (req: Request) => (isHostedMode() ? hostedAgentFor(req) : diskAgent());

export async function POST(req: Request) {
  const agent = await agentFor(req);
  if (!agent) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  // Minted here, never accepted from the caller: an id a client chooses is an
  // id a client can collide with somebody else's.
  const id = crypto.randomUUID();

  // Self-hosted shares one MERRYMEN_HOME with the worker, so the file goes
  // straight into the directory the worker drains — no table, no ferry.
  if (!isHostedMode()) {
    try {
      writeCommand(merrymenHome(), { id, kind: "paper-reset", at: Date.now() });
      return NextResponse.json({ id, queued: true });
    } catch (e) {
      return NextResponse.json(
        { error: `couldn't queue it: ${e instanceof Error ? e.message : String(e)}` },
        { status: 503 },
      );
    }
  }

  const ok = await withReadDb(async (db) => {
    if (!db) return false;
    try {
      await db
        .prepare("INSERT INTO agent_commands (id, agent_id, kind, created_at) VALUES (?, ?, ?, ?)")
        .run(id, agent, "paper-reset", Date.now());
      return true;
    } catch {
      return false;
    }
  });

  if (!ok) {
    return NextResponse.json(
      {
        error:
          "couldn't queue it — the ledger is unreachable, which usually means this agent's worker has never run",
      },
      { status: 503 },
    );
  }
  return NextResponse.json({ id, queued: true });
}
