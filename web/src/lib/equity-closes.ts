/**
 * THE WHOLE PERIOD'S EQUITY, AS HOURLY CLOSES — what the profile chart draws.
 *
 * The chart used to read the newest 500 equity rows. At a 60-240s tick that is
 * two to eight hours, while the headline above it is the whole period's return,
 * so a profile could print "+21.5%" over a line reading "0.00%": two true
 * numbers about two different spans, on one screen, with nothing saying so.
 *
 * One close per hour reaches back over the whole period for a bounded read —
 * a month is 720 rows, where the raw series is tens of thousands — and the
 * client slices it into 24H / 7D / 30D / ALL, with ALL the default, so the
 * default chart covers exactly the period its headline does.
 *
 * WHAT A CLOSE IS: the LAST reading in each clock hour, per book. Per book
 * because a paper book and a funded one both write here under one agent (see
 * sameBookAsLatest), and a close taken across both in the hour an owner
 * switched would hand one series the other's number. Each book's FIRST reading
 * is kept too: the growth index starts at 1 on the first point, and without the
 * open the whole first hour's move would be missing from ALL.
 *
 * WHAT IT COSTS: a trough inside one hour is not seen. A drawdown measured over
 * these closes is therefore a floor, and read-agent.ts says so where it
 * publishes one.
 *
 * NO HELD MARK IS A CLOSE (held-marks.ts). A mark taken while flow inference
 * was held can carry a deposit, withdrawal or settlement not booked yet, and
 * the growth index drawn from these closes divides out only what was booked:
 * a held close is a dip the drawdown would keep after the booking lands. So
 * closes and opens are taken among measured marks, and an hour that was held
 * throughout has none. The NEWEST mark comes back whatever it is, flagged
 * `held`, because it is what names the book (sameBookAsLatest) — a book whose
 * only fresh marks are held is still the book the agent runs now.
 *
 * SQL both backends run: a window function (as distinct-trades.ts uses), and an
 * integer hour from `at / 3600`, cast so a REAL `at` in sqlite buckets the same.
 */
import type { Db } from "../../../worker/src/db";
import { heldSql, isHeld } from "./held-marks";

/** One close per this many seconds. */
export const CLOSE_BUCKET_SEC = 3_600;

/**
 * The most closes one read takes: about thirteen months. Past it the OLDEST
 * are dropped and `complete` is false, so the page offers no "ALL" it cannot
 * back.
 */
export const CLOSE_READ_LIMIT = 24 * 400;

export interface EquityMark {
  equity_usdg: number;
  /** Unix seconds. */
  at: number;
  /** "paper", "live", or null for a row written before the column. */
  mode: string | null;
  /**
   * Taken while flow inference was held. Only ever the newest mark: it names
   * the book and is no performance input (measuredMarks drops it).
   */
  held: boolean;
}

/**
 * Hourly closes plus each book's opening mark, oldest first.
 *
 * THROWS on a failed read, like readOperationCounts: the caller decides what
 * an unread history means on its own page, and an empty array must never be
 * the stand-in for one.
 */
export async function readEquityCloses(
  db: Db,
  account: string,
  epoch: number,
  limit = CLOSE_READ_LIMIT,
): Promise<{ marks: EquityMark[]; complete: boolean }> {
  const held = await heldSql(db);
  // Held marks partition apart, so a close or an open is only ever ranked
  // among measured marks, and only `newest_rank` lets a held one through.
  const rows = (await db
    .prepare(
      `SELECT equity_usdg, at, id, mode, held FROM (
         SELECT equity_usdg, at, id, mode, held,
                ROW_NUMBER() OVER (
                  PARTITION BY COALESCE(mode, ''), held, CAST(at / ${CLOSE_BUCKET_SEC} AS INTEGER)
                  ORDER BY at DESC, id DESC
                ) AS close_rank,
                ROW_NUMBER() OVER (PARTITION BY COALESCE(mode, ''), held ORDER BY at ASC, id ASC) AS open_rank,
                ROW_NUMBER() OVER (ORDER BY at DESC, id DESC) AS newest_rank
           FROM (SELECT equity_usdg, at, id, mode, ${held.flag()} AS held
                   FROM equity WHERE agent_id = ? AND epoch = ?) e
       ) marks
       WHERE (held = 0 AND (close_rank = 1 OR open_rank = 1)) OR newest_rank = 1
       ORDER BY at DESC, id DESC LIMIT ?`,
    )
    .all(account, epoch, limit + 2)) as { equity_usdg: number; at: number; mode: string | null; held: unknown }[];
  // Newest first under the cap, so truncation can only ever cost the OLDEST
  // hours — never the reading the headline divides. A held newest mark is not
  // a close and does not count against the cap.
  const newestHeld = rows.length > 0 && isHeld(rows[0]!.held);
  const closes = newestHeld ? rows.slice(1) : rows;
  const complete = closes.length <= limit;
  const marks = [...(newestHeld ? [rows[0]!] : []), ...closes.slice(0, limit)]
    .reverse()
    .map((r) => ({ equity_usdg: Number(r.equity_usdg), at: Number(r.at), mode: r.mode ?? null, held: isHeld(r.held) }));
  return { marks, complete };
}
