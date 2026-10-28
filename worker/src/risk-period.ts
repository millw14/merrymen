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

/**
 * A mark's Σ max(0, Uᵢ) as integer micro-USDG. NULL is a mark with no perp
 * term (every mark before perps, and every agent without them): nothing open,
 * so nothing to take off. A value that is not a canonical non-negative integer
 * is not guessed at — it refuses the start, because a baseline read from a
 * corrupted term would be the period's peak for its whole life.
 */
function openGainMicro(v: string | null | undefined): bigint {
  if (v === null || v === undefined) return 0n;
  if (typeof v !== "string" || !/^(0|[1-9]\d*)$/.test(v)) throw new Error("Unreadable perp gain on the equity mark");
  return BigInt(v);
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
    //
    // NOR ONE TAKEN WHILE PERP MARGIN WAS MOVING (docs/perps.md rule 12c). The
    // same USDG can be in its cash and in its transit term around a payout, and
    // this baseline is also the period's first PEAK — which only ratchets. A
    // mark with nothing in transit carries '0' or NULL (no perp term at all);
    // anything else is skipped, and the freshness rule below then refuses the
    // start until a settled tick writes a mark, rather than guessing.
    const mark = await tx.prepare(
      `SELECT equity_usdg, at, perp_unrealized_gain_micro FROM equity
        WHERE agent_id = ? AND epoch = ? AND mode = 'live' AND COALESCE(flows_held, 0) = 0
          AND COALESCE(perp_in_transit_micro, '0') = '0'
        ORDER BY at DESC, id DESC LIMIT 1`,
    ).get(account, agent.epoch) as { equity_usdg: number; at: number; perp_unrealized_gain_micro: string | null } | undefined;
    if (!mark || mark.at > now || now - mark.at > 300 || !(mark.equity_usdg > 0)) throw new Error("Fresh positive equity mark required");
    // THE PEAK BASIS, not the equity (rule 12; equity.ts peakBasisUsdg): the
    // baseline is the period's first peak, and a peak never includes an open
    // perp gain — started over a wick, the whole period would measure its
    // drawdown from a number the account never realised. No perp term (NULL,
    // or '0') leaves the figure exactly the column, as before perps.
    const gainMicro = openGainMicro(mark.perp_unrealized_gain_micro);
    const baseline = gainMicro > 0n ? Math.round(mark.equity_usdg * 1e6 - Number(gainMicro)) / 1e6 : mark.equity_usdg;
    if (!(baseline > 0)) throw new Error("Fresh positive equity mark required");
    const r: RiskPeriod = { id, agent_id: account, started_at: now, baseline_usdg: baseline, hwm_usdg: baseline, withdrawn_usdg: 0, reason };
    await mergeRiskPeriod(tx, r);
    await tx.prepare("INSERT INTO events (agent_id, level, message) VALUES (?, 'warn', ?)").run(account,
      `New risk period ${id}: baseline ${baseline.toFixed(6)} USDG. ${reason}. Signed limits, lifetime losses and fee high-water mark preserved.`);
    return r;
  });
}
