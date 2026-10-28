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
import { purposeHome } from "../../../worker/src/home";
import { isGrantPurpose, type GrantPurpose } from "../../../packages/core/src/grant";
import { withReadDb } from "@/lib/ledger";
import { paperRecoveryState } from "./paper-return";
import { queueRecoveryCheckedCommand, type CommandAdmission } from "./recovery-commands";
import { PERPS_RESET_NOT_REPORTED, perpsBookReported } from "./perps-book-reported";

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
export type QueuedReset = { ok: true; id: string; expiresAt?: number } | { ok: false; error: string; status?: 409 | 503 };

/**
 * QUEUE A PRACTICE RESET for `agent`, the one command the worker (or, while its
 * book is held, the orchestrator) can act on. Moved here from /api/paper-reset
 * so that route and Start over queue it the same way. Never throws, but for a
 * wallet that names none (below).
 *
 * Self-hosted shares one MERRYMEN_HOME with the worker, so the file goes
 * straight into the directory the worker drains: no table, no ferry. Hosted, it
 * is an agent_commands row bound to the smart account, which is what the ferry
 * and the orchestrator's held reset both select on.
 *
 * `wallet` names whose book, with no default. Self-hosted it picks the home the
 * command lands in (`purposeHome`: Spot's is MERRYMEN_HOME, as it always was;
 * Perps's is accounts/perps, which only that wallet's worker drains). Hosted
 * the row is bound to `agent`, which the caller must resolve in the SAME wallet
 * (agent-for.ts, given the same name), or a Perps reset would land on the Spot
 * book. An unnamed wallet throws before anything is written.
 *
 * A PERPS RESET CARRIES A DEADLINE (`expiresAt`, required: one without throws
 * before anything is written). A Perps worker is stood down whenever the
 * operator's MERRYMEN_PERPS is not paper, and its queue waits, unclaimed, for
 * the next worker under paper (D19). A reset with no deadline waited out
 * every stand-down and wiped the practice book whenever perps came back —
 * days after the owner asked, positions opened since and all. With one, the
 * worker that reaches it late answers it expired and touches nothing: the
 * self-hosted file carries it, and hosted it rides the row's args, which the
 * ferry lifts onto the child's file as it lifts an order's. The Spot reset is
 * queued as it always was.
 *
 * AND SELF-HOSTED, THE ACCOUNT (FileCommand.account): the Perps home outlives
 * the account in it, so the reset names the one it was asked for, and a
 * worker armed on another answers it without running it. Hosted, the row is
 * bound to `agent` and the ferry hands it only to that account's worker.
 *
 * HOSTED, NO PERPS RESET WHILE THE PERPS BOOK IS HELD (409, nothing queued).
 * A practice book that will not restore starts no worker
 * (orchestrator.ts spawnChild), and for a Spot book the reset is the owner's
 * way out: the orchestrator honours it while the book is held
 * (held-reset.ts). Not for a Perps book in this build: the orchestrator holds
 * it with no hold process and honours no reset (held-reset.ts judges consent
 * by a seven-day window and never reads a Perps reset's deadline, nor clears
 * a perp book), so a reset queued then was answered "queued" and waited,
 * unclaimed, for a worker that could not start. So the book's record is read
 * first (paper-return.ts paperRecoveryState, which the orchestrator writes for
 * the Perps account at every spawn): held is refused, unreadable is a 503,
 * and only a clear or absent record (an older deployment) is queued. The look
 * is not atomic with the orchestrator's next restore; a book held just after
 * it leaves the row waiting with its deadline, answered by the next worker to
 * start — run inside its window, expired with the book untouched after it. A
 * stale "held" costs a practice reset, never a book. Spot is not read here.
 *
 * HOSTED, NO PERPS RESET FOR A BOOK THAT HAS NOT REPORTED (409, nothing
 * queued): the Perps account's `agents` row must be in the shared database
 * (perps-book-reported.ts). An agent_commands row is ledger history, and the
 * orchestrator never starts a Perps worker for the first time on an account
 * that has any (ledger-import.ts registerLedgerSource), so a reset queued
 * before that first start stopped the worker starting at all, and the book
 * it was meant to reset never existed.
 */
export async function queuePaperReset(
  hosted: boolean,
  agent: string,
  wallet: GrantPurpose,
  opts: { expiresAt?: number } = {},
): Promise<QueuedReset> {
  if (!isGrantPurpose(wallet)) throw new Error("Unrecognised wallet purpose");
  const expiresAt = opts.expiresAt;
  if (wallet === "perps" && !(typeof expiresAt === "number" && Number.isSafeInteger(expiresAt))) {
    throw new Error("A Perps practice reset carries a deadline");
  }
  // Minted here, never accepted from the caller: an id a client chooses is an
  // id a client can collide with somebody else's.
  const id = crypto.randomUUID();
  const at = Date.now();
  const deadline = wallet === "perps" ? { expiresAt } : {};
  if (!hosted) {
    try {
      writeCommand(purposeHome(wallet), { id, kind: "paper-reset", at, ...deadline, ...(wallet === "perps" ? { account: agent } : {}) });
      return { ok: true, id, ...deadline };
    } catch (e) {
      return { ok: false, error: `couldn't queue it: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  let admitted: CommandAdmission | { ok: false; why: "perps-book-held" | "perps-book-unread" | "perps-not-reported" } = { ok: false, why: "unreachable" };
  try {
    admitted = await withReadDb(async (db) => {
      if (wallet === "perps" && db) {
        const book = await paperRecoveryState(db, agent);
        if (book === "blocked") return { ok: false as const, why: "perps-book-held" as const };
        if (book === "unknown") return { ok: false as const, why: "perps-book-unread" as const };
        // A read that fails throws, and is the 503 below.
        if (!(await perpsBookReported(db, agent))) return { ok: false as const, why: "perps-not-reported" as const };
      }
      return queueRecoveryCheckedCommand(db, { id, agent, kind: "paper-reset", at, ...deadline });
    }, wallet);
  } catch { /* unreadable is a refusal */ }
  if (!admitted.ok) {
    if (admitted.why === "recovery") return { ok: false, status: 409,
      error: "practice reset is paused while the original financial book is checked. No reset was queued." };
    if (admitted.why === "perps-book-held") return { ok: false, status: 409,
      error: "Your Perps wallet's practice book could not be restored, so it is being held and no Perps worker is running to reset it. No practice reset was queued; ask again once it is back." };
    if (admitted.why === "perps-not-reported") return { ok: false, status: 409, error: PERPS_RESET_NOT_REPORTED };
    if (admitted.why === "perps-book-unread") return { ok: false, status: 503,
      error: "couldn't queue it — whether your Perps wallet's practice book is being held could not be read. No practice reset was queued; try again in a moment." };
    return {
      ok: false,
      status: 503,
      error: "couldn't queue it — the ledger is unreachable, which usually means this agent's worker has never run",
    };
  }
  return { ok: true, id, ...deadline };
}
