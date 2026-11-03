/** Hosted financial button admission. It reports a hold; it cannot release one. */
import type { Db } from "../../../worker/src/db";
import { readFleetCommandRefusal, withFleetRecoveryLock } from "../../../worker/src/fleet-recovery";

export interface RecoveryCheckedCommand {
  id: string;
  agent: string;
  kind: "selftest" | "paper-reset";
  at: number;
  /**
   * When it must no longer run (ms), carried in `args` as an order's is: the
   * ferry lifts it onto the child's file (orchestrator.ts deliverCommand) and
   * the child answers it expired at its claim. Absent, the row is written as it
   * always was, with no args. A Perps practice reset carries one (start-over.ts
   * queuePaperReset).
   */
  expiresAt?: number;
}
export type CommandAdmission = { ok: true } | { ok: false; why: "recovery" | "unreachable" };

/** Authenticated routes supply their resolved account and server-minted id/time.
 * Acquire exactly one shared account lock, then check before inserting. This
 * does not attest to wallet authority, source continuity or pending execution.
 */
export async function queueRecoveryCheckedCommand(db: Db | null, cmd: RecoveryCheckedCommand): Promise<CommandAdmission> {
  if (!db || !/^[a-zA-Z0-9-]{1,128}$/.test(cmd.id)
      || (cmd.kind !== "selftest" && cmd.kind !== "paper-reset")
      || !Number.isSafeInteger(cmd.at) || cmd.at <= 0
      || (cmd.expiresAt !== undefined && !(Number.isSafeInteger(cmd.expiresAt) && cmd.expiresAt > cmd.at))) return { ok: false, why: "unreachable" };
  try {
    return await withFleetRecoveryLock(db, cmd.agent, async locked => {
      // Optional-table compatibility must be checked outside BEGIN on PG.
      if (await readFleetCommandRefusal(locked, cmd.agent, cmd.at)) return { ok: false, why: "recovery" };
      return locked.tx(async tx => {
        // The row exactly as it always was, unless it carries a deadline.
        if (cmd.expiresAt === undefined) {
          await tx.prepare("INSERT INTO agent_commands (id, agent_id, kind, created_at) VALUES (?, ?, ?, ?)")
            .run(cmd.id, cmd.agent, cmd.kind, cmd.at);
        } else {
          await tx.prepare("INSERT INTO agent_commands (id, agent_id, kind, args, created_at) VALUES (?, ?, ?, ?, ?)")
            .run(cmd.id, cmd.agent, cmd.kind, JSON.stringify({ expiresAt: cmd.expiresAt }), cmd.at);
        }
        return { ok: true };
      });
    });
  } catch { return { ok: false, why: "unreachable" }; }
}
