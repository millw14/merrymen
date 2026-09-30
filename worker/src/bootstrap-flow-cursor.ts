/** The exact local flow prefix already included in a hosted accounting anchor. */
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "./db";

export interface BootstrapFlowCursor {
  ledgerId: string;
  account: string;
  epoch: number;
  lastId: number;
  lastHash: string | null;
}

export function validBootstrapFlowCursor(value: unknown, account: string): value is BootstrapFlowCursor {
  if (!value || typeof value !== "object") return false;
  const c = value as BootstrapFlowCursor;
  return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(c.ledgerId) &&
    c.account === account.toLowerCase() && Number.isSafeInteger(c.epoch) && c.epoch >= 1 &&
    Number.isSafeInteger(c.lastId) && c.lastId >= 0 &&
    (c.lastId === 0 ? c.lastHash === null : typeof c.lastHash === "string" && /^[0-9a-f]{64}$/.test(c.lastHash));
}

/** Local only: never mirrored or restored from a financial capsule. */
export async function ensureBootstrapFlowIdentity(db: Db): Promise<void> {
  await db.exec("CREATE TABLE IF NOT EXISTS bootstrap_flow_identity (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), ledger_id TEXT NOT NULL)");
  await db.prepare("INSERT INTO bootstrap_flow_identity (singleton, ledger_id) VALUES (1, ?) ON CONFLICT DO NOTHING").run(randomUUID());
}

/** A destructive restore starts a new local lineage, even if it reuses this file. */
export async function resetBootstrapFlowIdentity(db: Db): Promise<void> {
  await ensureBootstrapFlowIdentity(db);
  await db.prepare("UPDATE bootstrap_flow_identity SET ledger_id = ? WHERE singleton = 1").run(randomUUID());
}

function rowHash(row: Record<string, unknown>): string {
  // Versioned financial identity, independent of optional schema/metadata.
  // Startup migrations normalize transaction case and backfill chain_id.
  return createHash("sha256").update(JSON.stringify([
    "bootstrap-flow-v1", Number(row.id), String(row.agent_id).toLowerCase(), Number(row.epoch ?? 1),
    row.direction, Number(row.amount_usdg), row.source, Number(row.at),
    row.tx_hash == null ? null : String(row.tx_hash).toLowerCase(), row.block_number ?? null,
  ])).digest("hex");
}

/** Called on the same pinned snapshot that the final mirror completely copied. */
export async function captureBootstrapFlowCursor(db: Db, account: string): Promise<BootstrapFlowCursor> {
  const identity = await db.prepare("SELECT ledger_id FROM bootstrap_flow_identity WHERE singleton = 1").get() as { ledger_id: string } | undefined;
  if (!identity) throw new Error("accounting anchor has no local ledger identity");
  const row = await db.prepare("SELECT * FROM flows WHERE lower(agent_id) = ? ORDER BY id DESC LIMIT 1").get(account.toLowerCase()) as Record<string, unknown> | undefined;
  const agent = await db.prepare("SELECT epoch FROM agents WHERE lower(smart_account) = ?").get(account.toLowerCase()) as { epoch: number } | undefined;
  return { ledgerId: identity.ledger_id, account: account.toLowerCase(), epoch: Number(agent?.epoch ?? 1), lastId: Number(row?.id ?? 0), lastHash: row ? rowHash(row) : null };
}

/** A rebuilt database or a replaced/deleted endpoint cannot silently hide new flows. */
export async function bootstrapFlowCursorMatches(db: Db, cursor: BootstrapFlowCursor, account: string, epoch: number): Promise<boolean> {
  if (!validBootstrapFlowCursor(cursor, account) || cursor.epoch !== epoch) return false;
  const present = await db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bootstrap_flow_identity'").get();
  if (!present) return false;
  const identity = await db.prepare("SELECT ledger_id FROM bootstrap_flow_identity WHERE singleton = 1").get() as { ledger_id: string } | undefined;
  if (identity?.ledger_id !== cursor.ledgerId) return false;
  if (cursor.lastId === 0) return true;
  const row = await db.prepare("SELECT * FROM flows WHERE id = ? AND lower(agent_id) = ?").get(cursor.lastId, account.toLowerCase()) as Record<string, unknown> | undefined;
  return !!row && rowHash(row) === cursor.lastHash;
}

/** Validate and read under one snapshot, so recovery cannot replace the prefix in between. */
export async function readBootstrapFlowTotals(db: Db, account: string, epoch: number, cursor: BootstrapFlowCursor | null): Promise<{ netUsdg: number | null; sinceUsdg: number | null }> {
  return db.tx(async snapshot => {
    const matches = cursor !== null && await bootstrapFlowCursorMatches(snapshot, cursor, account, epoch);
    const row = await snapshot.prepare(`SELECT COUNT(*) AS n,
      COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END), 0) AS net,
      COALESCE(SUM(CASE WHEN id > ? THEN (CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END) ELSE 0 END), 0) AS since
      FROM flows WHERE lower(agent_id) = ? AND epoch = ?`).get(cursor?.lastId ?? 0, account.toLowerCase(), epoch) as { n: number; net: number; since: number };
    return { netUsdg: Number(row.n) === 0 ? null : Number(row.net), sinceUsdg: matches ? Number(row.since) : null };
  });
}
