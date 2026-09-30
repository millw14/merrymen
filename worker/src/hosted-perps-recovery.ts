import type { Db } from "./db";

export interface HostedPerpsRecoveryNotice {
  state: "paused" | "unknown";
  message: string;
}

export const PERPS_RECOVERY_PAUSED = "Live perpetuals are paused because this account’s recovery history could not be verified. Spot and paper trading remain available.";
export const PERPS_RECOVERY_UNKNOWN = "The live perpetual recovery status could not be checked. Spot and paper trading remain available.";

export function unknownHostedPerpsRecovery(): HostedPerpsRecoveryNotice {
  return { state: "unknown", message: PERPS_RECOVERY_UNKNOWN };
}

function address(value: string): string {
  if (!/^0x[0-9a-f]{40}$/i.test(value)) throw new RangeError("recovery status requires an account address");
  return value.toLowerCase();
}

/** Owner/account status only: never keys, journal content or raw failure text. */
export async function ensureHostedPerpsRecoverySchema(db: Db): Promise<void> {
  await db.exec(`CREATE TABLE IF NOT EXISTS hosted_perps_recovery_status (
    tenant TEXT NOT NULL,
    smart_account TEXT NOT NULL,
    ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
    updated_at_ms BIGINT NOT NULL,
    PRIMARY KEY (tenant, smart_account)
  )`);
}

export async function writeHostedPerpsRecovery(db: Db, value: { tenant: string; account: string; ok: boolean; nowMs?: number }): Promise<void> {
  const tenant = address(value.tenant);
  const account = address(value.account);
  const now = value.nowMs ?? Date.now();
  if (typeof value.ok !== "boolean" || !Number.isSafeInteger(now) || now < 0) throw new RangeError("invalid recovery status");
  await ensureHostedPerpsRecoverySchema(db);
  await db.prepare(`INSERT INTO hosted_perps_recovery_status (tenant, smart_account, ok, updated_at_ms)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (tenant, smart_account) DO UPDATE SET ok = excluded.ok, updated_at_ms = excluded.updated_at_ms
    WHERE excluded.updated_at_ms >= hosted_perps_recovery_status.updated_at_ms`).run(tenant, account, value.ok ? 1 : 0, now);
}

/** No active grant: retain any failed account's notice for this owner. */
export async function readHostedPerpsRecovery(db: Db, tenant: string, account?: string): Promise<HostedPerpsRecoveryNotice | null> {
  const owner = address(tenant);
  const smart = account === undefined ? undefined : address(account);
  try {
    const row = await db.prepare(smart === undefined
      ? `SELECT ok FROM hosted_perps_recovery_status WHERE tenant = ? AND ok = 0 ORDER BY updated_at_ms DESC LIMIT 1`
      : `SELECT ok FROM hosted_perps_recovery_status WHERE tenant = ? AND smart_account = ?`)
      .get(owner, ...(smart === undefined ? [] : [smart])) as { ok: unknown } | undefined;
    if (!row || row.ok === 1) return null;
    if (row.ok !== 0) return unknownHostedPerpsRecovery();
    return { state: "paused", message: PERPS_RECOVERY_PAUSED };
  } catch {
    return unknownHostedPerpsRecovery();
  }
}
