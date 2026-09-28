/**
 * A VALUATION TAKEN WHILE FLOW INFERENCE WAS HELD IS NOT A PERFORMANCE INPUT.
 *
 * The worker writes an equity row on a held tick (store.ts `flows_held`): an
 * operation the stranded resolver may still settle was in flight, so that
 * row's cash can carry a deposit, a withdrawal or a settlement (an energy
 * buy's USDG, an owner transfer) the flows table has not booked yet. It is a
 * true valuation, and the equity curve, "equity now" and every freshness read
 * take it like any other. But a figure that measures the book AGAINST its
 * flows reads it wrong:
 *
 *  - the growth index divides out only what was booked by each reading, so an
 *    unbooked withdrawal is a dip (and an unbooked deposit a spike) at the held
 *    rows, and the drawdown measured on the index KEEPS it after the flow is
 *    booked and the index recovers: a permanent public figure out of a booking
 *    that was a few minutes late;
 *  - a return pairing the held reading with the contributions calls the same
 *    movement profit or loss until the hold ends — up to 26 hours for a
 *    dropped op (flow-inference.ts STRANDED_RESOLVE_WINDOW_SEC).
 *
 * So those figures end at the newest MEASURED mark, one not held, and pair it
 * with the flows booked by then (netFlowsUpTo): a flow booked during the hold
 * (an owner transfer that landed, a settled energy buy) is not in that mark's
 * cash either, and subtracting it anyway is the same error in the other
 * direction.
 *
 * WHICH BOOK stays the NEWEST mark's, held or not. It is the book the agent is
 * running now, and a figure over the other book's marks — a practice balance
 * divided by real deposits — is the +2643% shape rank-pnl.ts describes.
 *
 * DELIBERATELY NOT FILTERED: a raw equity series and a drawdown measured on it
 * (the scoreboard's chart and drawdown, the leaderboard's sparkline and list
 * drawdown, the owner's own curve and daily change), and a figure that only
 * states what the book is worth now (/status, the chat's "account value").
 * They never divide a flow out, so a booking that arrives late cannot move
 * them, and the held row there is exactly the value the book had. Dropping it
 * would only hide a real trough for the length of a hold.
 *
 * ONE RULE, EVERY READER. The web's readers (web/src/lib/held-marks.ts
 * re-exports this module) and the worker's — Telegram's /pnl, /report and
 * /brag (telegram/reads.ts), the chat's pnl_breakdown (telegram/chat-tools.ts
 * over period-pnl.ts), the account history the orchestrator carries across a
 * redeploy (its loadAccountFromShared) and the alert summary (mcp/notify.ts) — all take
 * it from here.
 *
 * A LEDGER WITHOUT THE COLUMN — one an older worker wrote, a shared Postgres
 * the migration has not reached, or a hand-built test schema — held nothing: a
 * held tick wrote no row at all before the column existed (store.ts, the
 * ALTER's comment). The column is probed, the way the scoreboard probes
 * `epoch`, and both SQL forms below are valid in sqlite and in Postgres. Only
 * a PRESENT column is remembered, per connection: it never goes away, while a
 * missing one arrives with the next migration and must be seen when it does.
 */
import type { DatabaseSync } from "node:sqlite";
// RELATIVE import only — the "@merrymen/core" alias exists solely in dev (see
// the note in telegram/service.ts).
import { sameBookAsLatest, type EquityMarked } from "../../packages/core/src/index";
import type { Db } from "./db";

const PROBE = "SELECT flows_held FROM equity WHERE 1 = 0";
const hasColumn = new WeakMap<object, true>();

async function heldColumnExists(db: Db): Promise<boolean> {
  if (hasColumn.has(db)) return true;
  try {
    await db.prepare(PROBE).all();
    hasColumn.set(db, true);
    return true;
  } catch {
    return false;
  }
}

function heldColumnExistsSync(db: DatabaseSync): boolean {
  if (hasColumn.has(db)) return true;
  try {
    db.prepare(PROBE).all();
    hasColumn.set(db, true);
    return true;
  } catch {
    return false;
  }
}

export interface HeldSql {
  /** A SELECT expression: nonzero for a held mark, 0 otherwise. */
  flag(alias?: string): string;
  /** A WHERE predicate: this mark may be a performance input. */
  measurable(alias?: string): string;
}

const WITH_COLUMN: HeldSql = {
  flag: (a = "") => `COALESCE(${a}flows_held, 0)`,
  measurable: (a = "") => `COALESCE(${a}flows_held, 0) = 0`,
};
const WITHOUT_COLUMN: HeldSql = { flag: () => "0", measurable: () => "1 = 1" };

/** The SQL for this ledger's `flows_held`, or for its absence. */
export async function heldSql(db: Db): Promise<HeldSql> {
  return (await heldColumnExists(db)) ? WITH_COLUMN : WITHOUT_COLUMN;
}

/** heldSql for a synchronous node:sqlite connection (the Telegram readers' own). */
export function heldSqlSync(db: DatabaseSync): HeldSql {
  return heldColumnExistsSync(db) ? WITH_COLUMN : WITHOUT_COLUMN;
}

/** A `held` value as either backend hands it back: NULL predates the column and was not held. */
export function isHeld(v: unknown): boolean {
  return v !== null && v !== undefined && Number(v) !== 0;
}

/**
 * The newest mark's book, then only the measured marks of it — the input every
 * flow-relative figure takes. `rows` oldest first, as sameBookAsLatest wants.
 */
export function measuredMarks<T extends EquityMarked & { held?: unknown }>(rows: readonly T[]): T[] {
  return sameBookAsLatest(rows).filter((r) => !isHeld(r.held));
}

/**
 * Capital in less capital out, booked at or before `at` — what a mark taken at
 * `at` has in its cash. The growth index's own attribution rule (a flow counts
 * from the first reading at or after it). Null when nothing was booked by
 * then: no deposit on record AS OF THAT READING.
 */
export function netFlowsUpTo(flows: readonly { at: number; signed: number }[], at: number): number | null {
  let n = 0;
  let any = false;
  for (const f of flows) {
    if (f.at <= at) {
      n += f.signed;
      any = true;
    }
  }
  return any ? n : null;
}

export interface MeasuredMark {
  equity: number;
  at: number;
}

const newestModeSql = (ep: string) => `SELECT mode FROM equity WHERE agent_id = ?${ep} ORDER BY at DESC, id DESC LIMIT 1`;
// sameBookAsLatest's rule in SQL: a newest mark with no mode predates the
// question and keeps every row; otherwise the series is that book's.
const measuredMarkSql = (ep: string, book: string | null, held: HeldSql) =>
  `SELECT equity_usdg, at FROM equity
    WHERE agent_id = ?${ep}${book === null ? "" : " AND mode = ?"} AND ${held.measurable()}
    ORDER BY at DESC, id DESC LIMIT 1`;

function markOf(row: { equity_usdg: unknown; at: unknown } | undefined): MeasuredMark | null {
  if (!row) return null;
  const equity = Number(row.equity_usdg);
  return Number.isFinite(equity) ? { equity, at: Number(row.at) } : null;
}

/**
 * The newest MEASURED mark of the book the newest mark belongs to, within one
 * agent (and one epoch, when the ledger has the column — null reads a pre-epoch
 * ledger whole). Null when that book has no measured mark: the whole of it so
 * far was taken during a hold.
 *
 * A read of its own rather than the tail of a windowed series: a dropped op
 * holds for 26 hours, which at a 60-second tick is more rows than any window
 * here reads, and "no measured mark in the window" is not "none on record".
 *
 * THROWS on a failed read; the caller already has a catch for its equity read.
 */
export async function readMeasuredMark(db: Db, account: string, epoch: number | null): Promise<MeasuredMark | null> {
  const ep = epoch === null ? "" : " AND epoch = ?";
  const epArg = epoch === null ? [] : [epoch];
  const newest = (await db.prepare(newestModeSql(ep)).get(account, ...epArg)) as { mode: string | null } | undefined;
  if (!newest) return null;
  const book = newest.mode ?? null;
  const row = (await db
    .prepare(measuredMarkSql(ep, book, await heldSql(db)))
    .get(account, ...epArg, ...(book === null ? [] : [book]))) as { equity_usdg: unknown; at: unknown } | undefined;
  return markOf(row);
}

/** readMeasuredMark over a synchronous node:sqlite connection. Throws likewise. */
export function readMeasuredMarkSync(db: DatabaseSync, account: string, epoch: number | null): MeasuredMark | null {
  const ep = epoch === null ? "" : " AND epoch = ?";
  const epArg = epoch === null ? [] : [epoch];
  const newest = db.prepare(newestModeSql(ep)).get(account, ...epArg) as { mode: string | null } | undefined;
  if (!newest) return null;
  const book = newest.mode ?? null;
  const row = db
    .prepare(measuredMarkSql(ep, book, heldSqlSync(db)))
    .get(account, ...epArg, ...(book === null ? [] : [book])) as { equity_usdg: unknown; at: unknown } | undefined;
  return markOf(row);
}
