/**
 * THE ENERGY COUNTERS ON DISK — one row per agent per UTC day.
 *
 * The same shape risk-period.ts has for the same reason: three writers touch
 * this table (the child's tick, the mirror carrying it up to shared Postgres,
 * the orchestrator seeding a rebuilt child back down), and they must merge by
 * ONE statement or they will disagree about what a copy is allowed to change.
 * Everything here takes the Db it writes to; store.ts binds the child's own.
 *
 *   reviews, entries   what a low-energy agent used today. They only ever go UP
 *                      through a copy — a copy never un-spends — and a refund is
 *                      the child's own act, on its own row.
 *   told_at            when today's owner notice went. The first stands.
 *   read_at, read_full the last balance reading that DECIDED the level, so a
 *                      restart during an RPC outage does not throttle a holder.
 *                      The newer reading wins.
 *
 * WHY NOT A FILE. A hosted child's sqlite is emptied by every redeploy; a
 * counter kept only there would hand out a fresh day's allowance per deploy.
 * The mirror and the seed below are how it survives — the same round trip the
 * cost basis already makes (basis-seed.ts).
 *
 * THE FIELD IS NEVER INTERPOLATED FROM INPUT. Each counter has its own fixed
 * statements, chosen by a literal key.
 */
import type { Db } from "./db";
import type { EnergyCounters, EnergyDayRow, LastGood } from "./energy";
import { energyDayRowOf } from "./energy";

export const ENERGY_DAYS_SCHEMA = `CREATE TABLE IF NOT EXISTS energy_days (
  agent_id TEXT NOT NULL, day TEXT NOT NULL,
  reviews INTEGER NOT NULL DEFAULT 0, entries INTEGER NOT NULL DEFAULT 0,
  told_at INTEGER, read_at INTEGER, read_full INTEGER,
  PRIMARY KEY (agent_id, day)
)`;

export type EnergyField = "reviews" | "entries";

const CLAIM: Record<EnergyField, string> = {
  reviews:
    `INSERT INTO energy_days (agent_id, day, reviews) VALUES (?, ?, 1)
     ON CONFLICT(agent_id, day) DO UPDATE SET reviews = energy_days.reviews + 1
     WHERE energy_days.reviews < ?`,
  entries:
    `INSERT INTO energy_days (agent_id, day, entries) VALUES (?, ?, 1)
     ON CONFLICT(agent_id, day) DO UPDATE SET entries = energy_days.entries + 1
     WHERE energy_days.entries < ?`,
};

const REFUND: Record<EnergyField, string> = {
  reviews: "UPDATE energy_days SET reviews = reviews - 1 WHERE agent_id = ? AND day = ? AND reviews > 0",
  entries: "UPDATE energy_days SET entries = entries - 1 WHERE agent_id = ? AND day = ? AND entries > 0",
};

/**
 * The merge, written once for both backends and every writer. CASE rather
 * than MAX/GREATEST because MAX is an aggregate in Postgres and GREATEST does
 * not exist in sqlite; every existing-row reference QUALIFIED, because inside
 * ON CONFLICT DO UPDATE Postgres has two relations in scope and a bare column
 * is ambiguous — a parse error sqlite would never show (ledger-mirror.ts, the
 * class_positions note).
 */
export const ENERGY_DAY_MERGE_SQL = `INSERT INTO energy_days (agent_id, day, reviews, entries, told_at, read_at, read_full)
   VALUES (?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT (agent_id, day) DO UPDATE SET
     reviews = CASE WHEN excluded.reviews > energy_days.reviews THEN excluded.reviews ELSE energy_days.reviews END,
     entries = CASE WHEN excluded.entries > energy_days.entries THEN excluded.entries ELSE energy_days.entries END,
     told_at = COALESCE(energy_days.told_at, excluded.told_at),
     read_full = CASE WHEN COALESCE(excluded.read_at, 0) > COALESCE(energy_days.read_at, 0)
                      THEN excluded.read_full ELSE energy_days.read_full END,
     read_at = CASE WHEN COALESCE(excluded.read_at, 0) > COALESCE(energy_days.read_at, 0)
                    THEN excluded.read_at ELSE energy_days.read_at END`;

/** Today's counters; zeros when there is no row yet. Throws on a failed read — the caller decides. */
export async function readEnergyDay(db: Db, agentId: string, day: string): Promise<EnergyCounters> {
  const r = (await db
    .prepare("SELECT reviews, entries, told_at FROM energy_days WHERE agent_id = ? AND day = ?")
    .get(agentId, day)) as { reviews: unknown; entries: unknown; told_at: unknown } | undefined;
  if (!r) return { reviews: 0, entries: 0, toldAt: null };
  return {
    reviews: Number(r.reviews ?? 0),
    entries: Number(r.entries ?? 0),
    toldAt: r.told_at === null || r.told_at === undefined ? null : Number(r.told_at),
  };
}

/**
 * CLAIM ONE, atomically, if the day is under `cap`. One statement: the insert
 * of a fresh day and the conditional increment of an existing one are the
 * same upsert, so two concurrent claims against a cap of one cannot both win.
 * A cap below one never writes.
 */
export async function claimEnergyDay(db: Db, agentId: string, day: string, field: EnergyField, cap: number): Promise<boolean> {
  if (!Number.isFinite(cap) || cap < 1) return false;
  const r = await db.prepare(CLAIM[field]).run(agentId, day, Math.floor(cap));
  return r.changes === 1;
}

/** Give one back, never below zero. Only for a claim this process made and did not use. */
export async function refundEnergyDay(db: Db, agentId: string, day: string, field: EnergyField): Promise<void> {
  await db.prepare(REFUND[field]).run(agentId, day);
}

/** Stamp today's notice, if it has not been stamped. True exactly once per agent per day. */
export async function claimEnergyNoticeDay(db: Db, agentId: string, day: string, atSec: number): Promise<boolean> {
  const r = await db
    .prepare(
      `INSERT INTO energy_days (agent_id, day, told_at) VALUES (?, ?, ?)
       ON CONFLICT(agent_id, day) DO UPDATE SET told_at = excluded.told_at
       WHERE energy_days.told_at IS NULL`,
    )
    .run(agentId, day, Math.floor(atSec));
  return r.changes === 1;
}

/** Remember a reading that decided the level. An older reading never replaces a newer one. */
export async function noteEnergyReadDay(db: Db, agentId: string, day: string, full: boolean, atSec: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO energy_days (agent_id, day, read_at, read_full) VALUES (?, ?, ?, ?)
       ON CONFLICT(agent_id, day) DO UPDATE SET read_at = excluded.read_at, read_full = excluded.read_full
       WHERE energy_days.read_at IS NULL OR excluded.read_at >= energy_days.read_at`,
    )
    .run(agentId, day, Math.floor(atSec), full ? 1 : 0);
}

/** The newest decided reading at or after `sinceSec`, or null. */
export async function lastEnergyReadDay(db: Db, agentId: string, sinceSec: number): Promise<LastGood | null> {
  const r = (await db
    .prepare(
      `SELECT read_at, read_full FROM energy_days
        WHERE agent_id = ? AND read_at IS NOT NULL AND read_at >= ?
        ORDER BY read_at DESC LIMIT 1`,
    )
    .get(agentId, Math.floor(sinceSec))) as { read_at: unknown; read_full: unknown } | undefined;
  if (!r || r.read_at === null || r.read_at === undefined) return null;
  const at = Number(r.read_at);
  if (!Number.isFinite(at)) return null;
  const f = r.read_full;
  return { full: f === 1 || f === true || f === "1" || f === 1n, at };
}

/** Merge one day into `db` by the shared rule. Used by the mirror (up) and the seed (down). */
export async function mergeEnergyDayRow(db: Db, agentId: string, row: EnergyDayRow): Promise<void> {
  await db
    .prepare(ENERGY_DAY_MERGE_SQL)
    .run(
      agentId,
      row.day,
      row.reviews,
      row.entries,
      row.toldAt,
      row.readAt,
      row.readFull === null ? null : row.readFull ? 1 : 0,
    );
}

/** Every row of one agent from `sinceDay` on, parsed; malformed rows are skipped, not zeroed. */
export async function readEnergyDaysSince(db: Db, agentId: string, sinceDay: string): Promise<EnergyDayRow[]> {
  const rows = (await db
    .prepare(
      `SELECT day, reviews, entries, told_at, read_at, read_full FROM energy_days
        WHERE lower(agent_id) = lower(?) AND day >= ? ORDER BY day`,
    )
    .all(agentId, sinceDay)) as unknown[];
  return rows.map(energyDayRowOf).filter((r): r is EnergyDayRow => r !== null);
}
