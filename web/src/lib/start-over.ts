/**
 * START OVER, ON THE SERVER: the grant discarded and the practice reset
 * queued, in one request, in the order that keeps the kill switch a kill switch.
 *
 * The web's Start over is two things at once. It forgets the signed key, which
 * is the kill switch (DELETE /api/grants): a "discarded" grant the server still
 * holds is one the worker goes on trading on. And it asks for the practice book
 * to be started over (/api/paper-reset), which finds the agent to queue the
 * reset for THROUGH that grant (agent-for.ts). So the reset needs the grant and
 * the kill must not wait for anything.
 *
 * The browser used to do both, and neither order worked there:
 * - Side by side, the DELETE could land first and the reset answered 401 with
 *   nobody left to queue for. Production, 2026-09-21T16:24:24Z: an owner whose
 *   practice book would not restore pressed Start over to get out of it, and
 *   nothing was queued.
 * - Chained (the DELETE sent once the reset answered), the kill waited on the
 *   reset's round trip, and a tab closed inside it never sent the DELETE at
 *   all, while the page had already forgotten the grant it would need to try
 *   again. A live owner could press Start over, close the tab, and leave a key
 *   they believed discarded trading real funds.
 *
 * So the browser sends ONE request (POST /api/grants/discard, keepalive) and
 * this does the ordering where a closed tab cannot interrupt it:
 * 1. the account is read from the grant, while there still is one;
 * 2. the grant is removed, before anything else can go wrong or be slow;
 * 3. the reset is queued for the account read in 1, which no longer needs the
 *    grant to exist.
 * A reset that cannot be read, queued or reached never stops the kill, and is
 * reported rather than thrown: the kill is the half that must happen.
 *
 * ITS OWN ROUTE, not a flag on DELETE /api/grants. The grants route module is
 * reached from the partner runtime for its GET, on the model's path, and the
 * reset's command writer is code that path must never reach
 * (mcp/tools/chat.test.ts audits the graph, dynamic imports included). The
 * grant is removed there as that route removes it (lib/grant-archive.ts).
 *
 * NO MODE SWITCH HERE (client-env.test.ts, agent-for.ts): the route decides
 * hosted or self-hosted and passes it in.
 */
// Relative, as ledger.ts reaches the worker: `tsx --test` resolves aliases
// against the root tsconfig, which does not carry @merrymen/command-files.
import { writeCommand } from "../../../worker/src/command-files";
import { merrymenHome } from "../../../worker/src/home";
import { withReadDb } from "@/lib/ledger";

/** What became of the reset half of a Start over. */
export type StartOverReset = "queued" | "no-agent" | "failed";

export interface StartOverDeps {
  /** The agent's smart account, from the grant still stored, or null when there is none. */
  account: () => Promise<string | null>;
  /** The kill switch itself. A throw here is the request's failure, as it always was. */
  remove: () => Promise<void>;
  /** Queue the practice reset for that account. False, or a throw, is a reset not queued. */
  queueReset: (account: string) => Promise<boolean>;
}

/**
 * Discard the grant and queue the practice reset, in the order this file's
 * header gives. Resolves once both halves have been tried; only the removal
 * can reject, and then nothing is queued: a reset for a grant still armed
 * would be half a Start over.
 */
export async function startOver(deps: StartOverDeps): Promise<StartOverReset> {
  let account: string | null;
  try {
    account = await deps.account();
  } catch {
    // Unreadable: no reset, and still the kill.
    account = null;
  }
  await deps.remove();
  if (!account) return "no-agent";
  try {
    return (await deps.queueReset(account)) ? "queued" : "failed";
  } catch {
    return "failed";
  }
}

/** A queued reset, or why it could not be queued, in the words /api/paper-reset answers with. */
export type QueuedReset = { ok: true; id: string } | { ok: false; error: string };

/**
 * QUEUE A PRACTICE RESET for `agent`, the one command the worker (or, while its
 * book is held, the orchestrator) can act on. Moved here from /api/paper-reset
 * so that route and Start over queue it the same way. Never throws.
 *
 * Self-hosted shares one MERRYMEN_HOME with the worker, so the file goes
 * straight into the directory the worker drains: no table, no ferry. Hosted, it
 * is an agent_commands row bound to the smart account, which is what the ferry
 * and the orchestrator's held reset both select on.
 */
export async function queuePaperReset(hosted: boolean, agent: string): Promise<QueuedReset> {
  // Minted here, never accepted from the caller: an id a client chooses is an
  // id a client can collide with somebody else's.
  const id = crypto.randomUUID();
  if (!hosted) {
    try {
      writeCommand(merrymenHome(), { id, kind: "paper-reset", at: Date.now() });
      return { ok: true, id };
    } catch (e) {
      return { ok: false, error: `couldn't queue it: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  let ok = false;
  try {
    ok = await withReadDb(async (db) => {
      if (!db) return false;
      await db
        .prepare("INSERT INTO agent_commands (id, agent_id, kind, created_at) VALUES (?, ?, ?, ?)")
        .run(id, agent, "paper-reset", Date.now());
      return true;
    });
  } catch {
    ok = false;
  }
  if (!ok) {
    return {
      ok: false,
      error: "couldn't queue it — the ledger is unreachable, which usually means this agent's worker has never run",
    };
  }
  return { ok: true, id };
}
