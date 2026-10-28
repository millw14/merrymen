/**
 * Ask the worker to run its pipeline probe, and report what came back.
 *
 * WHY THIS EXISTS. `merrymen selftest` is a CLI flag, and hosted spawns the
 * worker without it (orchestrator.ts) — so the one command designed to answer
 * "can this agent actually transact" was unreachable for every hosted tenant.
 * That is how a fleet-wide arming failure stayed invisible for hours: the only
 * way to find out was to read container logs by hand.
 *
 * THE WEB PROCESS CANNOT RUN IT. The worker is a separate process — a separate
 * container, hosted — with no HTTP server and no IPC. So this enqueues and the
 * worker's tick drains. Everything the dashboard has ever told the worker has
 * gone through a store the other side polls; this is that pattern, not a new
 * transport.
 *
 * The only `kind` written here is the fixed pipeline probe, with no order
 * arguments accepted from the caller. That probe can transact, so hosted
 * admission observes the same source recovery hold as financial commands.
 */
import { NextResponse } from "next/server";
import { merrymenHome } from "@merrymen/home";
import { isHostedMode } from "@merrymen/core";
import { writeCommand } from "@merrymen/command-files";
import { withReadDb } from "@/lib/ledger";
import { hostedAgentFor, diskAgent } from "@/lib/agent-for";
import { queueRecoveryCheckedCommand } from "@/lib/recovery-commands";

export const dynamic = "force-dynamic";

// Which agent this request may act for. Hosted, that is the signed-in tenant's
// account resolved through the GRANT STORE — see web/src/lib/agent-for.ts for
// why the `agents.owner_address` lookup cannot work here. Self-hosted has no
// auth; the localhost middleware is the perimeter and the grant on disk is the
// agent. The branch lives here because this file is server-side.
const agentFor = (req: Request) => (isHostedMode() ? hostedAgentFor(req) : diskAgent());
export async function POST(req: Request) {
  const agent = await agentFor(req);
  if (!agent) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  // The id is generated HERE rather than accepted from the caller: an id a
  // client chooses is an id a client can collide with somebody else's.
  const id = crypto.randomUUID();

  // SELF-HOSTED SKIPS THE DATABASE ENTIRELY. The web process and the worker
  // share one MERRYMEN_HOME, so the command can be dropped straight into the
  // directory the worker drains — no table, no ferry, no shared handle.
  if (!isHostedMode()) {
    try {
      writeCommand(merrymenHome(), { id, kind: "selftest", at: Date.now() });
      return NextResponse.json({ id, queued: true });
    } catch (e) {
      return NextResponse.json(
        { error: `couldn't queue it: ${e instanceof Error ? e.message : String(e)}` },
        { status: 503 },
      );
    }
  }

  // Hosted: the orchestrator is the only process that can reach both the
  // shared database and a child's home, so it ferries. See command-files.ts.
  const admitted = await withReadDb(db => queueRecoveryCheckedCommand(db,
    { id, agent, kind: "selftest", at: Date.now() })).catch(() => ({ ok: false, why: "unreachable" } as const));

  if (!admitted.ok) {
    if (admitted.why === "recovery") return NextResponse.json({
      error: "transaction probe is paused while the original financial book is checked. No probe was queued.",
    }, { status: 409 });
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

/** What happened to the most recent probe. Polled by the button that queued it. */
export async function GET(req: Request) {
  const agent = await agentFor(req);
  if (!agent) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const row = await withReadDb(async (db) => {
    if (!db) return null;
    try {
      return ((await db
        .prepare(
          `SELECT id, kind, created_at, claimed_at, done_at, result FROM agent_commands
            WHERE agent_id = ? AND kind = 'selftest' ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get(agent)) ?? null) as Record<string, unknown> | null;
    } catch {
      return null;
    }
  });

  if (!row) return NextResponse.json({ state: "none" });
  const done = row.done_at !== null && row.done_at !== undefined;
  const claimed = row.claimed_at !== null && row.claimed_at !== undefined;
  return NextResponse.json({
    id: String(row.id),
    // Three states, not two. "queued" and "running" look identical to someone
    // watching a spinner, but they mean different things when it stops changing:
    // queued-forever is a worker that is not draining at all, running-forever is
    // a probe that hung.
    state: done ? "done" : claimed ? "running" : "queued",
    result: row.result === null || row.result === undefined ? null : String(row.result),
    at: Number(row.created_at),
  });
}
