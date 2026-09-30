/**
 * THE ENERGY COUNTERS ON DISK — one row per agent per UTC day.
 *
 * The same shape risk-period.ts has for the same reason: three writers touch
 * this table (the child's tick, the mirror carrying it up to shared Postgres,
 * the orchestrator seeding a rebuilt child back down), and they must merge by
 * ONE statement or they will disagree about what a copy is allowed to change.
 * Everything here takes the Db it writes to; store.ts binds the child's own.
 *
 *   reviews, entries   what a low-energy agent claimed today. They only ever go
 *                      UP — through a claim, and through a copy, which never
 *                      un-spends.
 *   entries_refunded   entry claims handed back unused (a trade refused or never
 *                      sent). ALSO only ever up. Used = entries − entries_refunded.
 *   told_at            when today's owner notice went. The first stands.
 *   read_at, read_full the last balance reading that DECIDED the level, so a
 *                      restart during an RPC outage does not throttle a holder.
 *                      The newer reading wins.
 *
 * WHY A REFUND IS ITS OWN COUNTER, NOT A DECREMENT. Every copy merges by
 * taking the larger value, so a count that goes DOWN cannot travel: the
 * orchestrator can mirror a claim while its trade is still awaiting execution,
 * the trade is then refused and the child gives the claim back — and shared
 * kept the higher count for good, and seeded it into the next rebuilt child as
 * a trade the agent never made. With both columns monotonic, "the larger of
 * each" is right on both, in either direction, whatever order the copies ran
 * in; the difference is the day's use. A refund never takes it below zero.
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
  entries_refunded INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, day)
)`;

/**
 * The columns a table made by an earlier CREATE lacks. A child's sqlite that
 * survived a crash-restart and the shared table both predate the refund
 * counter, and CREATE TABLE IF NOT EXISTS adds no column to a table that is
 * there. Run by store.ts with the ledger's other ALTERs (Postgres spells it
 * ADD COLUMN IF NOT EXISTS, db.ts translateSchema) and by ensureEnergyDays.
 * NOT NULL DEFAULT 0: an old row's `entries` was already net of its refunds.
 */
export const ENERGY_DAYS_ALTERS: readonly string[] = [
  "ALTER TABLE energy_days ADD COLUMN entries_refunded INTEGER NOT NULL DEFAULT 0",
];

/**
 * The table and every column it needs, on a Db that is not the store's own
 * (the seed's two sides). A column that is already there is the one error
 * swallowed — sqlite's "duplicate column", Postgres's 42701 — and anything
 * else is thrown: a table this code cannot write is a failed seed, never one
 * that quietly drops the refunds.
 */
export async function ensureEnergyDays(db: Db): Promise<void> {
  await db.exec(ENERGY_DAYS_SCHEMA);
  for (const ddl of ENERGY_DAYS_ALTERS) {
    try {
      await db.exec(ddl);
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      if (code !== "42701" && !/duplicate column/i.test(e instanceof Error ? e.message : String(e))) throw e;
    }
  }
}

export type EnergyField = "reviews" | "entries";

/**
 * Entries are claimed against the day's NET use: a claim handed back is room
 * for another. Reviews are never refunded (a review that ran was paid for).
 */
const CLAIM: Record<EnergyField, string> = {
  reviews:
    `INSERT INTO energy_days (agent_id, day, reviews) VALUES (?, ?, 1)
     ON CONFLICT(agent_id, day) DO UPDATE SET reviews = energy_days.reviews + 1
     WHERE energy_days.reviews < ?`,
  entries:
    `INSERT INTO energy_days (agent_id, day, entries) VALUES (?, ?, 1)
     ON CONFLICT(agent_id, day) DO UPDATE SET entries = energy_days.entries + 1
     WHERE energy_days.entries - energy_days.entries_refunded < ?`,
};

/** One more handed back — only while the day's net use is above zero, so it can never go below. */
const REFUND_ENTRY =
  "UPDATE energy_days SET entries_refunded = entries_refunded + 1 WHERE agent_id = ? AND day = ? AND entries - entries_refunded > 0";

/**
 * The merge, written once for both backends and every writer. CASE rather
 * than MAX/GREATEST because MAX is an aggregate in Postgres and GREATEST does
 * not exist in sqlite; every existing-row reference QUALIFIED, because inside
 * ON CONFLICT DO UPDATE Postgres has two relations in scope and a bare column
 * is ambiguous — a parse error sqlite would never show (ledger-mirror.ts, the
 * class_positions note).
 */
export const ENERGY_DAY_MERGE_SQL = `INSERT INTO energy_days (agent_id, day, reviews, entries, entries_refunded, told_at, read_at, read_full)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT (agent_id, day) DO UPDATE SET
     reviews = CASE WHEN excluded.reviews > energy_days.reviews THEN excluded.reviews ELSE energy_days.reviews END,
     entries = CASE WHEN excluded.entries > energy_days.entries THEN excluded.entries ELSE energy_days.entries END,
     entries_refunded = CASE WHEN excluded.entries_refunded > energy_days.entries_refunded
                             THEN excluded.entries_refunded ELSE energy_days.entries_refunded END,
     told_at = COALESCE(energy_days.told_at, excluded.told_at),
     read_full = CASE WHEN COALESCE(excluded.read_at, 0) > COALESCE(energy_days.read_at, 0)
                      THEN excluded.read_full ELSE energy_days.read_full END,
     read_at = CASE WHEN COALESCE(excluded.read_at, 0) > COALESCE(energy_days.read_at, 0)
                    THEN excluded.read_at ELSE energy_days.read_at END`;

/**
 * Today's counters; zeros when there is no row yet. Throws on a failed read —
 * the caller decides. `entries` is the day's USE: claims less refunds.
 */
export async function readEnergyDay(db: Db, agentId: string, day: string): Promise<EnergyCounters> {
  const r = (await db
    .prepare("SELECT reviews, entries, entries_refunded, told_at FROM energy_days WHERE agent_id = ? AND day = ?")
    .get(agentId, day)) as { reviews: unknown; entries: unknown; entries_refunded: unknown; told_at: unknown } | undefined;
  if (!r) return { reviews: 0, entries: 0, toldAt: null };
  return {
    reviews: Number(r.reviews ?? 0),
    entries: Math.max(0, Number(r.entries ?? 0) - Number(r.entries_refunded ?? 0)),
    toldAt: r.told_at === null || r.told_at === undefined ? null : Number(r.told_at),
  };
}

/**
 * CLAIM ONE, atomically, if the day's use is under `cap`. One statement: the
 * insert of a fresh day and the conditional increment of an existing one are
 * the same upsert, so two concurrent claims against a cap of one cannot both
 * win. A cap below one never writes.
 */
export async function claimEnergyDay(db: Db, agentId: string, day: string, field: EnergyField, cap: number): Promise<boolean> {
  if (!Number.isFinite(cap) || cap < 1) return false;
  const r = await db.prepare(CLAIM[field]).run(agentId, day, Math.floor(cap));
  return r.changes === 1;
}

/**
 * Give one entry back, never below zero. Only for a claim this process made
 * and did not use. An INCREMENT of entries_refunded, never a decrement of
 * entries, so the mirror and the seed carry it (see the header).
 */
export async function refundEnergyDay(db: Db, agentId: string, day: string): Promise<void> {
  await db.prepare(REFUND_ENTRY).run(agentId, day);
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
      row.entriesRefunded,
      row.toldAt,
      row.readAt,
      row.readFull === null ? null : row.readFull ? 1 : 0,
    );
}

/** Every row of one agent from `sinceDay` on, parsed; malformed rows are skipped, not zeroed. */
export async function readEnergyDaysSince(db: Db, agentId: string, sinceDay: string): Promise<EnergyDayRow[]> {
  const rows = (await db
    .prepare(
      `SELECT day, reviews, entries, entries_refunded, told_at, read_at, read_full FROM energy_days
        WHERE lower(agent_id) = lower(?) AND day >= ? ORDER BY day`,
    )
    .all(agentId, sinceDay)) as unknown[];
  return rows.map(energyDayRowOf).filter((r): r is EnergyDayRow => r !== null);
}
