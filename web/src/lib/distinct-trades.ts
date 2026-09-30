/**
 * ONE ROW PER OPERATION, however many copies of it the shared ledger holds.
 *
 * A child home has no volume, so a redeploy rebuilds its ledger from nothing.
 * At the next arm the in-flight reconciler reads that empty ledger's op hashes,
 * finds every successful op in its lookback missing, and writes each one
 * again as a bare 'swap' — no decision, no fill side, stamped at the restart.
 * The mirror rewound onto the rebuilt ledger and carried those rows up beside
 * the evidenced originals, because `trades` has no unique key on user_op_hash
 * (deliberately — see store.ts). So an agent's newest fills were the copies,
 * "Swapped token · Token label unavailable" all at one timestamp, and every
 * count of what it had done read each of them twice.
 *
 * The mirror no longer inserts a hash the shared ledger already holds, but the
 * copies it made before that are still there, and no reader may wait on a
 * repair to stop publishing them. So every reader that turns rows into
 * operations collapses them here, in SQL both backends run.
 *
 * WHICH COPY SPEAKS FOR THE OPERATION: one that knows the outcome over one
 * still 'submitted', then the one carrying fill evidence, then the one linked
 * to the decision that made it, then the earliest. The executor's own row
 * carries all of that and the reconciler's carries none of it.
 *
 * A row with no hash — a refusal, a paper fill — is its own operation. `row:<id>`
 * can never equal a lowercased hex hash, so two refusals are never one. An
 * empty hash is no hash: the mirror already treats it that way, and read as a
 * key it would make every such row of an account one operation.
 */
import type { Db } from "../../../worker/src/db";

/**
 * What makes two rows the same operation. Lowercased on both parts: the
 * reconciler lowercases the hash and the executor writes it as the bundler
 * returned it, and an account has been written under more than one spelling.
 */
export function tradeOpKey(alias: string): string {
  return `lower(${alias}.agent_id) || '|' || COALESCE(lower(NULLIF(${alias}.user_op_hash, '')), 'row:' || CAST(${alias}.id AS TEXT))`;
}

/**
 * `trades`, one row per operation, as a derived table named `alias`.
 *
 * `where` filters BEFORE the collapse, and it should scope by account and run
 * only. A status or kind filter belongs outside, in the caller's own WHERE: a
 * vault deposit written again as a 'swap' collapses into its deposit and
 * disappears from a list of swaps, where filtering first would have left the
 * copy standing alone and published it as a trade.
 *
 * A time window may go inside only if it reaches back past the window the
 * caller publishes by OP_COPY_REACH_SEC, for the same reason.
 *
 * ONLY ROWS WITH A HASH ARE RANKED. A row without one cannot collide with
 * anything, so it goes straight through, and the window sort covers the
 * fills rather than every refusal an account has ever had — which on the
 * wall band is the whole fleet's day. `where` is written once, in the CTE, so
 * a caller binds its arguments once whichever half a row lands in.
 */
export function distinctTrades(where: string, alias = "t"): string {
  const a = alias;
  return `(WITH scoped AS (SELECT * FROM trades ${a} WHERE ${where})
    SELECT * FROM (
      SELECT s.*, ROW_NUMBER() OVER (
        PARTITION BY lower(s.agent_id), lower(s.user_op_hash)
        ORDER BY (s.status = 'submitted'), (s.fill_side IS NULL), (s.decision_id IS NULL), s.created_at, s.id
      ) AS op_rank
      FROM scoped s WHERE s.user_op_hash IS NOT NULL AND s.user_op_hash <> ''
    ) ranked WHERE ranked.op_rank = 1
    UNION ALL
    SELECT s.*, 1 AS op_rank FROM scoped s WHERE s.user_op_hash IS NULL OR s.user_op_hash = '') ${a}`;
}

/**
 * How much younger than the operation a re-recorded copy can be.
 *
 * NOT 26 HOURS, though the reconciler says it looks back that far. Its reach
 * is a BLOCK count: 26h divided by the pace of the last 2,000 blocks, clamped
 * at 200,000 blocks (index.ts, `MAX_LOOKBACK`). At this chain's measured 0.101
 * s/block the clamp binds, and 200,000 blocks is under six hours. But the
 * wall-clock span of 200,000 blocks is whatever they took, so a chain that
 * paused inside them stretches the reach by the pause, and nothing bounds it.
 *
 * Seven days is 200,000 blocks at an average of three seconds each — thirty
 * times the measured pace, or a halt of about six and a half days inside the
 * span.
 * Past that a copy would stand alone and read as a fresh fill, so this is a
 * bound on a display, not a guarantee. It is also a closing one: the mirror no
 * longer writes a hash the shared ledger holds (ledger-mirror.ts), so the
 * copies it reaches for are only the ones already written, and they age out.
 *
 * Only hashed rows are ranked (distinctTrades), so the reach costs a window
 * sort over fills, not over refusals.
 */
export const OP_COPY_REACH_SEC = 7 * 86_400;

export interface OperationCounts {
  gasUsdg: number;
  unpricedTrades: number;
  landed: number;
  filledPaper: number;
  refused: number;
  tokensTouched: number;
}

/**
 * What one run of one account did, counted in operations.
 *
 * THROWS on a failed read, so each caller keeps saying what an unread tape
 * means on its own page — never a zero standing in for it.
 *
 * Gas is still summed per row. The reconciler's copies carry no gas, so the
 * copies this exists for add nothing to it; a byte-for-byte duplicate would,
 * and that is the repair's job rather than a reader's.
 */
export async function readOperationCounts(
  db: Db,
  account: string,
  epoch: number,
  tokensFrom: "landed" | "paper",
): Promise<OperationCounts> {
  const op = tradeOpKey("t");
  const t = (await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN t.status = 'landed' THEN t.gas_usdg ELSE 0 END), 0) AS gas,
              COUNT(DISTINCT CASE WHEN t.status = 'landed' AND t.gas_wei IS NOT NULL AND t.gas_usdg IS NULL
                                  THEN ${op} END) AS unpriced,
              COUNT(DISTINCT CASE WHEN t.status = 'landed' THEN ${op} END) AS landed,
              COUNT(DISTINCT CASE WHEN t.status = 'paper' THEN ${op} END) AS paper_filled,
              COUNT(DISTINCT CASE WHEN t.status IN ('rejected','reverted') THEN ${op} END) AS refused,
              COUNT(DISTINCT CASE WHEN t.fill_side = 'buy' AND t.status = ?
                                  THEN LOWER(t.buy_token) END) AS tokens
         FROM trades t WHERE t.agent_id = ? AND t.epoch = ?`,
    )
    .get(tokensFrom, account, epoch)) as Record<string, number | null> | undefined;
  return {
    gasUsdg: Number(t?.gas ?? 0),
    unpricedTrades: Number(t?.unpriced ?? 0),
    landed: Number(t?.landed ?? 0),
    filledPaper: Number(t?.paper_filled ?? 0),
    refused: Number(t?.refused ?? 0),
    tokensTouched: Number(t?.tokens ?? 0),
  };
}
