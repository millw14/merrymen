import type { Db } from "../../../worker/src/db";
import { heldSql, isHeld } from "./held-marks";

export interface PaperPerformance {
  /** Newest recorded paper equity, including a held valuation. */
  equityUsdg: number;
  equityAt: number;
  /** Whether the newest raw equity is held out of performance calculations. */
  held: boolean;
  /** Change from this epoch's first measured paper valuation. */
  pnlUsdg: number;
  /** Unrounded basis points; callers choose their display precision. */
  pnlBps: number;
  /** Time of the measured valuation used for P&L. */
  pnlAt: number;
}

/** Missing legacy health is compatible; an unread verdict cannot permit a book. */
export async function paperRecoveryBlocked(db: Db, account: string): Promise<boolean> {
  try {
    const health = await db.prepare("SELECT blocked FROM paper_recovery_health WHERE LOWER(agent_id) = ?")
      .get(account.toLowerCase()) as { blocked: number } | undefined;
    return Number(health?.blocked) === 1;
  } catch (error) {
    const e = error as { code?: unknown; message?: unknown };
    // Only an absent legacy table permits the older recorded-mark behavior.
    // Permission failures, timeouts and unread columns are unknown health.
    return !(e.code === "42P01" || (typeof e.message === "string"
      && /^no such table: (?:\w+\.)?paper_recovery_health$/i.test(e.message)));
  }
}

/**
 * Change in the recorded paper book, never divided by real deposits.
 *
 * A rail change leaves the paper book intact. Keep its opening measured mark
 * across observation gaps; only an explicit reset's new epoch starts it over.
 * Address casing and mirror insertion order cannot change that baseline.
 * Held marks still state current equity, but cannot establish or end a return.
 */
export async function readPaperPerformance(db: Db, account: string, epoch: number): Promise<PaperPerformance | null> {
  try {
    if (await paperRecoveryBlocked(db, account)) return null;
    const held = await heldSql(db);
    // All three marks come from one statement, so a concurrently arriving tick
    // cannot give current equity and performance different database snapshots.
    const row = await db.prepare(`WITH marks AS (
        SELECT id, equity_usdg, mode, at, ${held.flag()} AS held FROM equity
        WHERE LOWER(agent_id) = ? AND epoch = ?
      ), latest AS (
        SELECT equity_usdg, mode, at, held FROM marks ORDER BY at DESC, id DESC LIMIT 1
      ), first AS (
        SELECT equity_usdg FROM marks WHERE mode = 'paper' AND held = 0 ORDER BY at ASC, id ASC LIMIT 1
      ), measured AS (
        SELECT equity_usdg, at FROM marks WHERE mode = 'paper' AND held = 0 ORDER BY at DESC, id DESC LIMIT 1
      )
      SELECT latest.equity_usdg AS equity, latest.at AS equity_at, latest.held,
             first.equity_usdg AS start, measured.equity_usdg AS finish, measured.at AS pnl_at
      FROM latest CROSS JOIN first CROSS JOIN measured WHERE latest.mode = 'paper'`)
      .get(account.toLowerCase(), epoch) as { equity: number; equity_at: number; held: unknown; start: number; finish: number; pnl_at: number } | undefined;
    if (!row || Object.values(row).some((value) => value === null || value === undefined)) return null;
    const equityUsdg = Number(row.equity);
    const equityAt = Number(row.equity_at);
    const start = Number(row.start);
    const finish = Number(row.finish);
    const pnlAt = Number(row.pnl_at);
    const pnlUsdg = finish - start;
    const pnlBps = (pnlUsdg / start) * 10_000;
    if (start <= 0 || finish < 0 || equityUsdg < 0 ||
        ![start, finish, equityUsdg, equityAt, pnlAt, pnlUsdg, pnlBps].every(Number.isFinite)) return null;
    return { equityUsdg, equityAt, held: isHeld(row.held), pnlUsdg, pnlBps, pnlAt };
  } catch { return null; }
}

/** Legacy callers display whole basis points. */
export async function readPaperReturn(db: Db, account: string, epoch: number): Promise<number | null> {
  const performance = await readPaperPerformance(db, account, epoch);
  return performance === null ? null : Math.round(performance.pnlBps);
}
