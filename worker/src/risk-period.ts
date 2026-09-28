import type { Db } from "./db";

/** An explicit owner-authorized loss budget. Never changes the fee/accounting epoch. */
export interface RiskPeriod {
  id: string;
  agent_id: string;
  started_at: number;
  baseline_usdg: number;
  hwm_usdg: number;
  withdrawn_usdg: number;
  reason: string;
}

export const RISK_PERIOD_SCHEMA = `CREATE TABLE IF NOT EXISTS risk_periods (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, started_at INTEGER NOT NULL,
  baseline_usdg REAL NOT NULL, hwm_usdg REAL NOT NULL,
  withdrawn_usdg REAL NOT NULL DEFAULT 0, reason TEXT NOT NULL,
  UNIQUE(agent_id, started_at)
)`;

export function validRiskPeriod(value: unknown, account: string): value is RiskPeriod {
  if (!value || typeof value !== "object") return false;
  const r = value as RiskPeriod;
  return typeof r.id === "string" && r.id.length > 0 &&
    typeof r.agent_id === "string" && r.agent_id.toLowerCase() === account.toLowerCase() &&
    Number.isSafeInteger(r.started_at) && r.started_at > 0 &&
    [r.baseline_usdg, r.hwm_usdg, r.withdrawn_usdg].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0) &&
    r.baseline_usdg > 0 && r.hwm_usdg >= r.baseline_usdg && r.withdrawn_usdg <= r.hwm_usdg &&
    typeof r.reason === "string" && r.reason.length > 0;
}

export async function readRiskPeriod(db: Db, account: string): Promise<RiskPeriod | null> {
  const row = await db.prepare("SELECT * FROM risk_periods WHERE agent_id = ? ORDER BY started_at DESC LIMIT 1").get(account);
  if (!row) return null;
  if (!validRiskPeriod(row, account)) throw new Error("Invalid durable risk period");
  return row;
}

/** Restore/mirror only upward counters. An older child cannot replace a newer period. */
export async function mergeRiskPeriod(db: Db, r: RiskPeriod): Promise<void> {
  if (!validRiskPeriod(r, r.agent_id)) throw new Error("Invalid risk period");
  const existing = await db.prepare("SELECT * FROM risk_periods WHERE id = ?").get(r.id) as RiskPeriod | undefined;
  if (existing && ["agent_id", "started_at", "baseline_usdg", "reason"].some(k => existing[k as keyof RiskPeriod] !== r[k as keyof RiskPeriod])) {
    throw new Error("Risk period identity does not match durable history");
  }
  await db.prepare(`INSERT INTO risk_periods (id, agent_id, started_at, baseline_usdg, hwm_usdg, withdrawn_usdg, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET
    hwm_usdg = CASE WHEN excluded.hwm_usdg > risk_periods.hwm_usdg THEN excluded.hwm_usdg ELSE risk_periods.hwm_usdg END,
    withdrawn_usdg = CASE WHEN excluded.withdrawn_usdg > risk_periods.withdrawn_usdg THEN excluded.withdrawn_usdg ELSE risk_periods.withdrawn_usdg END`)
    .run(r.id, r.agent_id, r.started_at, r.baseline_usdg, r.hwm_usdg, r.withdrawn_usdg, r.reason);
}

export async function markRiskPeriod(db: Db, account: string, equity: number | null): Promise<number | null> {
  const r = await readRiskPeriod(db, account);
  if (!r) return null;
  if (equity !== null) {
    if (!Number.isFinite(equity) || equity < 0) throw new Error("Invalid risk equity");
    await db.prepare(`UPDATE risk_periods SET hwm_usdg =
      CASE WHEN ? + withdrawn_usdg > hwm_usdg THEN ? + withdrawn_usdg ELSE hwm_usdg END WHERE id = ?`)
      .run(equity, equity, r.id);
  }
  const updated = await readRiskPeriod(db, account);
  return Math.max(0, updated!.hwm_usdg - updated!.withdrawn_usdg);
}

/** Called in the same transaction as the lifetime peak's capital adjustment. */
export async function adjustRiskCapital(db: Db, account: string, delta: number): Promise<void> {
  const r = await readRiskPeriod(db, account);
  if (!r) return;
  if (!Number.isFinite(delta)) throw new Error("Invalid capital adjustment");
  if (delta >= 0) await db.prepare("UPDATE risk_periods SET hwm_usdg = hwm_usdg + ? WHERE id = ?").run(delta, r.id);
  else await db.prepare(`UPDATE risk_periods SET withdrawn_usdg =
    CASE WHEN withdrawn_usdg + ? > hwm_usdg THEN hwm_usdg ELSE withdrawn_usdg + ? END WHERE id = ?`).run(-delta, -delta, r.id);
}

/** Operational activation requires an explicit ID/reason and a fresh observed balance. */
export async function startRiskPeriod(db: Db, account: string, id: string, reason: string, now: number): Promise<RiskPeriod> {
  return db.tx(async tx => {
    const prior = await tx.prepare("SELECT * FROM risk_periods WHERE id = ?").get(id);
    if (prior) {
      if (!validRiskPeriod(prior, account) || prior.reason !== reason) throw new Error("Risk period id already used");
      return prior;
    }
    const agent = await tx.prepare("SELECT epoch, mode, contributions_known FROM agents WHERE smart_account = ?").get(account) as { epoch: number; mode: string; contributions_known: number } | undefined;
    if (!agent || agent.mode !== "live" || agent.contributions_known !== 1) throw new Error("Live, evidenced accounting required");
    // Never a mark taken while flow inference was held (store.ts `flows_held`):
    // its equity may hold a deposit not yet booked, which would sit in the
    // baseline once and then be added to the peak again when it is.
    const mark = await tx.prepare("SELECT equity_usdg, at FROM equity WHERE agent_id = ? AND epoch = ? AND mode = 'live' AND COALESCE(flows_held, 0) = 0 ORDER BY at DESC, id DESC LIMIT 1").get(account, agent.epoch) as { equity_usdg: number; at: number } | undefined;
    if (!mark || mark.at > now || now - mark.at > 300 || !(mark.equity_usdg > 0)) throw new Error("Fresh positive equity mark required");
    const r: RiskPeriod = { id, agent_id: account, started_at: now, baseline_usdg: mark.equity_usdg, hwm_usdg: mark.equity_usdg, withdrawn_usdg: 0, reason };
    await mergeRiskPeriod(tx, r);
    await tx.prepare("INSERT INTO events (agent_id, level, message) VALUES (?, 'warn', ?)").run(account,
      `New risk period ${id}: baseline ${mark.equity_usdg.toFixed(6)} USDG. ${reason}. Signed limits, lifetime losses and fee high-water mark preserved.`);
    return r;
  });
}
