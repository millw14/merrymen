/**
 * The durable evidence resumeStranded (services/proposals.ts) reads to finish a
 * proposal whose approval was interrupted between acting and recording its
 * outcome: the owner-order queue, the owner's settings, and the group chat's
 * owner lines. Every probe is scoped by ids taken from the owner's own
 * proposal row, never from a caller, and answers null when it cannot tell.
 */
import type { Db } from "../../../../worker/src/db";
import { currentValues, type StrandedProbe } from "./proposals";

/**
 * The group-chat route's idempotency key for an owner line (retryKey in
 * web/src/app/api/groupchat/route.ts). A post approval sends the proposal's
 * id as its clientId, so this names exactly that post's line.
 */
export function ownerPostKey(tenant: string, clientId: string): string {
  return `owner:${tenant.toLowerCase()}:${clientId}`;
}

export function strandedProbe(ledger: <T>(fn: (db: Db | null) => Promise<T>) => Promise<T>): StrandedProbe {
  return {
    orderQueued: (orderId, agentId) => ledger(async (db) => {
      if (!db) return null;
      return !!(await db.prepare("SELECT 1 AS one FROM agent_commands WHERE id = ? AND agent_id = ?").get(orderId, agentId));
    }),
    settingsNow: (tenant, keys) => currentValues(tenant, keys).catch(() => null),
    postStored: async (tenant, clientId) => {
      const { withRoom, ownerLineByKey } = await import("@/app/api/groupchat/room");
      return withRoom(async (room) => (room ? !!(await ownerLineByKey(room.db, ownerPostKey(tenant, clientId))) : null));
    },
  };
}
