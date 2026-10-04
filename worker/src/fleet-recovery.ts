/** Recovery health is a report of a source hold, never permission to trade. */
import { createHash } from "node:crypto";
import { withAdvisoryLock, type Db } from "./db";

/** One common account lock for hold publication, admission and delivery across services. */
export function withFleetRecoveryLock<T>(db: Db, account: string, fn: (locked: Db) => Promise<T>): Promise<T> {
  if (!/^0x[0-9a-f]{40}$/i.test(account)) throw new Error("Invalid recovery lock scope.");
  const key = createHash("sha256").update(account.toLowerCase()).digest().readInt32BE(0);
  // Hash collisions only serialize unrelated accounts; they cannot grant authority.
  return withAdvisoryLock(db, 0x4d525643, key, fn, 5_000);
}

export interface FleetRecoveryView {
  state: "checking" | "history-only" | "reconciling";
  tradingPaused: true;
  history: "available" | "unknown";
  memory: "preserved" | "recovered" | "unknown";
  checkedAt: number;
  lastVerifiedHeartbeatAt: number | null;
}

export interface RecoveryScope { tenant: string; smartAccount: string; chainId: number }
export type RecoveryCause = "persistent-source" | "source-continuity" | "source-barrier";
export const FLEET_RECOVERY_SCHEMA = `CREATE TABLE IF NOT EXISTS fleet_recovery_health (
  tenant TEXT NOT NULL, smart_account TEXT NOT NULL, chain_id INTEGER NOT NULL,
  held INTEGER NOT NULL, cause TEXT NOT NULL, since_at BIGINT NOT NULL, checked_at BIGINT NOT NULL,
  PRIMARY KEY(tenant, smart_account, chain_id)
);`;

function scopeOf(scope: RecoveryScope): RecoveryScope {
  if (!/^0x[0-9a-f]{40}$/i.test(scope.tenant) || !/^0x[0-9a-f]{40}$/i.test(scope.smartAccount)
      || !Number.isSafeInteger(scope.chainId) || scope.chainId <= 0) throw new Error("Invalid recovery scope.");
  return { tenant: scope.tenant.toLowerCase(), smartAccount: scope.smartAccount.toLowerCase(), chainId: scope.chainId };
}
function timeOf(now: number): number {
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("Invalid recovery time.");
  return now;
}
const CAUSES = new Set<RecoveryCause>(["persistent-source", "source-continuity", "source-barrier"]);
const missingTable = (error: unknown): boolean => {
  const e = error as { code?: string; message?: string };
  return e?.code === "42P01" || /no such table: (?:main\.)?fleet_recovery_health\b/.test(e?.message ?? "");
};

/** Only the supervisor calls this, under its unchanged grant and healthy lease. */
export async function recordFleetRecoveryHold(db: Db, scope: RecoveryScope, cause: RecoveryCause, now: number,
  mayWrite: () => boolean): Promise<void> {
  const s = scopeOf(scope); timeOf(now);
  if (!CAUSES.has(cause) || !mayWrite()) throw new Error("Recovery report lost its writer.");
  await withAdvisoryLock(db, 0x4d525644, 1, locked => locked.exec(FLEET_RECOVERY_SCHEMA), 5_000);
  await withFleetRecoveryLock(db, s.smartAccount, locked => locked.tx(async tx => {
    if (!mayWrite()) throw new Error("Recovery report lost its writer.");
    await tx.prepare(`INSERT INTO fleet_recovery_health(tenant,smart_account,chain_id,held,cause,since_at,checked_at)
      VALUES(?,?,?,1,?,?,?) ON CONFLICT(tenant,smart_account,chain_id) DO UPDATE SET
      held=1,cause=excluded.cause,since_at=CASE WHEN fleet_recovery_health.held=1 THEN fleet_recovery_health.since_at
      ELSE excluded.since_at END,checked_at=excluded.checked_at
      WHERE fleet_recovery_health.checked_at<=excluded.checked_at`).run(s.tenant, s.smartAccount, s.chainId, cause, now, now);
    if (!mayWrite()) throw new Error("Recovery report lost its writer.");
  }));
}

/** Called only after the ordinary original-source gates passed. Removes no source fence. */
export async function recordFleetSourceVerified(db: Db, scope: RecoveryScope, now: number,
  mayWrite: () => boolean): Promise<boolean> {
  const s = scopeOf(scope); timeOf(now);
  if (!mayWrite()) throw new Error("Recovery report lost its writer.");
  // No report on older/self-hosted installs is compatible, not authority.
  try {
    return await withFleetRecoveryLock(db, s.smartAccount, locked => locked.tx(async tx => {
      if (!mayWrite()) throw new Error("Recovery report lost its writer.");
      await tx.prepare(`UPDATE fleet_recovery_health SET held=0,checked_at=?
        WHERE tenant=? AND smart_account=? AND chain_id=? AND held=1 AND checked_at<=?`)
        .run(now, s.tenant, s.smartAccount, s.chainId, now);
      if (!mayWrite()) throw new Error("Recovery report lost its writer.");
      return await readFleetRecoveryHold(tx, s) === null;
    }));
  } catch (error) { if (!missingTable(error)) throw error; return true; }
}

/** Financial queue checks are conservative across every recorded chain for this account.
 * A command queued before a source hold was resolved cannot silently cross the recovery boundary.
 * The record remains available; this function never claims, deletes or replays it.
 */
/** Inclusive cutoff for bounded delivery selection. Null means legacy absence, never source proof. */
export async function readFleetCommandBoundary(db: Pick<Db, "prepare">, account: string): Promise<number | "held" | null> {
  if (!/^0x[0-9a-f]{40}$/i.test(account)) throw new Error("Invalid recovery command scope.");
  let rows: Array<{ held: unknown; checked_at: unknown; cause: unknown }>;
  try {
    rows = await db.prepare(`SELECT held,checked_at,cause FROM fleet_recovery_health
      WHERE smart_account=? LIMIT 129`).all(account.toLowerCase()) as typeof rows;
  } catch (error) { if (missingTable(error)) return null; throw error; }
  if (rows.length > 128) throw new Error("Recovery command scope is too large.");
  let held = false, cutoff: number | null = null;
  for (const row of rows) {
    const flag = Number(row.held), at = Number(row.checked_at), boundary = (at + 1) * 1000;
    if ((flag !== 0 && flag !== 1) || !Number.isSafeInteger(at) || at <= 0
        || !Number.isSafeInteger(boundary) || !CAUSES.has(row.cause as RecoveryCause))
      throw new Error("Recovery command report is unreadable.");
    held ||= flag === 1;
    cutoff = Math.max(cutoff ?? 0, boundary);
  }
  return held ? "held" : cutoff;
}
export async function readFleetCommandRefusal(db: Pick<Db, "prepare">, account: string, createdAtMs: number): Promise<boolean> {
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs <= 0) throw new Error("Invalid recovery command scope.");
  const boundary = await readFleetCommandBoundary(db, account);
  return boundary === "held" || (boundary !== null && createdAtMs <= boundary);
}

/** No schema creation on web/read paths. Errors other than an old missing table propagate. */
export async function readFleetRecoveryHold(db: Pick<Db, "prepare">, scope: RecoveryScope): Promise<{ checkedAt: number } | null> {
  const s = scopeOf(scope);
  let row: Record<string, unknown> | undefined;
  try {
    row = await db.prepare(`SELECT held,checked_at,cause FROM fleet_recovery_health
      WHERE tenant=? AND smart_account=? AND chain_id=?`).get(s.tenant, s.smartAccount, s.chainId) as typeof row;
  } catch (error) { if (missingTable(error)) return null; throw error; }
  if (!row) return null;
  const held = Number(row.held), checkedAt = Number(row.checked_at);
  if ((held !== 0 && held !== 1) || !Number.isSafeInteger(checkedAt) || checkedAt <= 0
      || !CAUSES.has(row.cause as RecoveryCause)) throw new Error("Recovery report is unreadable.");
  return held === 1 ? { checkedAt } : null;
}

/** A stored row proves available evidence, not a complete book or a distinct execution. */
export async function readFleetRecoveryView(db: Pick<Db, "prepare">, scope: RecoveryScope,
  lastHeartbeat: number | null): Promise<FleetRecoveryView | null> {
  const held = await readFleetRecoveryHold(db, scope);
  if (!held) return null;
  let history: FleetRecoveryView["history"] = "unknown";
  try {
    const row = await db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM trades WHERE lower(agent_id)=?)
      OR EXISTS(SELECT 1 FROM posts WHERE lower(agent_id)=?) OR EXISTS(SELECT 1 FROM flows WHERE lower(agent_id)=?)
      THEN 1 ELSE 0 END AS present`).get(scope.smartAccount.toLowerCase(), scope.smartAccount.toLowerCase(),
      scope.smartAccount.toLowerCase()) as { present: unknown };
    if (Number(row.present) === 1) history = "available";
  } catch { /* an unavailable history read is unknown, never an empty original book */ }
  const heartbeat = typeof lastHeartbeat === "number" && Number.isSafeInteger(lastHeartbeat)
    && lastHeartbeat > 0 && lastHeartbeat <= held.checkedAt ? lastHeartbeat : null;
  return { state: history === "available" ? "history-only" : "checking", tradingPaused: true, history,
    memory: "unknown", checkedAt: held.checkedAt, lastVerifiedHeartbeatAt: heartbeat };
}
