/**
 * THE OWNER'S TAPE, as /api/feed serves it to their own desk and chat.
 *
 * It selected the bare trade row and nothing the ledger knows about what the
 * trade WAS: no fill side, no symbol, no decision. The terminal could then only
 * resolve a side by matching the executed pair against STOCK_TOKENS, so every
 * curve and class trade arrived with no side at all, the desk kept only buys
 * and sells, and an agent that had bought and sold CASHCAT and CHUMP showed its
 * owner "Trades · 0" — while the chat model was handed action null and symbol
 * null and could not say what it had just bought.
 *
 * The join is the one profile-trades.ts already uses, and the rows are
 * collapsed to one per operation for the same reason as there: a redeploy's
 * re-recorded copies must not head the owner's tape either.
 *
 * Kept out of the route so it can be driven against a real ledger in a test.
 */
import type { Db } from "../../../worker/src/db";
import { distinctTrades, OP_COPY_REACH_SEC, tradeOpKey } from "./distinct-trades";
import { OP_KEY, readEvidencedSells } from "./profile-trades";

export interface DeskTradeRow {
  kind: string;
  sell_token: string | null;
  buy_token: string | null;
  amount_usdg: number;
  tx_hash: string | null;
  status: string;
  reject_rule: string | null;
  sim_quote_out: string | null;
  sim_min_out: string | null;
  sim_fee_tier: number | null;
  sim_gas: string | null;
  created_at: number;
  /** What the fill did, as the executor recorded it. Absent on a ledger too old to say. */
  fill_side?: string | null;
  /** The fill's own symbol, else the decision's. Unsanitised: the terminal decides what it will print. */
  symbol?: string | null;
  /** The coin's own name, from the decision. Display only. */
  display_name?: string | null;
  /** The side the decision asked for — how a refusal, which filled nothing, still has one. */
  action?: string | null;
  /** Why the agent did it, in its decision's words. The owner's own desk only. */
  reason?: string | null;
  realized_pnl_usdg?: number | null;
  /**
   * Whether `realized_pnl_usdg` is a MEASUREMENT: true only on a filled sell
   * whose proceeds and whose cost were both read — its own fill evidenced (a
   * receipt, or a paper fill) and no estimate in the basis it sold against
   * (profile-trades.ts readEvidencedSells, the rule the profile ranks by).
   *
   * The worker books realized P&L on a sell whose proceeds came from the quote
   * and on one whose cost a quoted buy built, so the figure alone is not a
   * result, and the desk prints it only beside this (terminal/swaps.ts). False
   * when the replay could not vouch, absent on a ledger too old for the read.
   */
  realized_vouched?: boolean;
}

/**
 * How many operations the owner's tape holds at most.
 *
 * Exported because the desk reads it: a tape that came back this full may have
 * been cut at its old end, so a count reaching back to that end is a FLOOR and
 * the desk says "12+" (terminal/swaps.ts). The desk used to keep its own copy of
 * this number, one edit away from disagreeing with the read it describes.
 */
export const DESK_TAPE_LIMIT = 30;

/**
 * The newest `limit` operations since `sinceSec`, for one account and, when the
 * ledger has the column, one run.
 *
 * THE RICHER READ FALLS BACK, IT DOES NOT FAIL. The decision join and the fill
 * columns arrive with worker migrations, and this app can be reading a ledger
 * an older worker wrote. A missing column must cost the tape its labels, not
 * the tape — an empty one is a claim that nothing happened.
 *
 * Each filled sell says whether its realized figure is a measurement
 * (`realized_vouched`), from a replay of its coin's fills in its own book.
 */
export async function readDeskTrades(
  db: Db,
  account: string,
  epoch: number | null,
  sinceSec: number,
  limit = DESK_TAPE_LIMIT,
): Promise<DeskTradeRow[]> {
  const run = epoch === null ? "" : " AND t.epoch = ?";
  const runArg = epoch === null ? [] : [epoch];
  let rows: (DeskTradeRow & { op_key?: string })[];
  try {
    rows = (await db
      .prepare(
        `SELECT t.kind, t.sell_token, t.buy_token, t.amount_usdg, t.tx_hash, t.status, t.reject_rule,
                t.sim_quote_out, t.sim_min_out, t.sim_fee_tier, t.sim_gas, t.created_at,
                t.fill_side, COALESCE(t.fill_symbol, d.symbol) AS symbol, d.display_name, d.action, d.reason,
                t.realized_pnl_usdg, ${OP_KEY} AS op_key
           FROM ${distinctTrades(`t.agent_id = ?${run} AND t.created_at > ?`)}
           LEFT JOIN decisions d ON d.id = t.decision_id AND LOWER(d.agent_id) = LOWER(t.agent_id)
          WHERE t.created_at > ?
          ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
      )
      // The collapse reaches further back than the tape: a copy is stamped at
      // the restart, long after the op it repeats (see OP_COPY_REACH_SEC), and
      // must still find that op to collapse into when the op itself is outside
      // the window.
      .all(account, ...runArg, sinceSec - OP_COPY_REACH_SEC, sinceSec, limit)) as unknown as (DeskTradeRow & { op_key?: string })[];
  } catch {
    return (await db
      .prepare(
        `SELECT kind, sell_token, buy_token, amount_usdg, tx_hash, status, reject_rule,
                sim_quote_out, sim_min_out, sim_fee_tier, sim_gas, created_at
           FROM trades WHERE agent_id = ?${run.replace("t.", "")} AND created_at > ?
          ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(account, ...runArg, sinceSec, limit)) as unknown as DeskTradeRow[];
  }
  // WHICH REALIZED FIGURES ARE MEASUREMENTS, per book, against that book's own
  // fills. A replay that cannot run vouches for nothing: the figure is still
  // carried, and the desk prints no dollars beside it.
  const vouched = new Set<string>();
  for (const book of ["landed", "paper"] as const) {
    const sells = rows
      .filter((r) => r.status === book && r.fill_side === "sell" && r.realized_pnl_usdg !== null && r.realized_pnl_usdg !== undefined)
      .filter((r) => typeof r.op_key === "string" && typeof r.sell_token === "string" && r.sell_token !== "")
      .map((r) => ({ op: r.op_key!, token: r.sell_token! }));
    try {
      for (const op of await readEvidencedSells(db, account, book, sells)) vouched.add(op);
    } catch {
      /* fill quantities and provenance arrive with worker migrations */
    }
  }
  // The key the replay matched on stays here: it is not part of the tape.
  return rows.map(({ op_key, ...r }) => ({ ...r, realized_vouched: typeof op_key === "string" && vouched.has(op_key) }));
}

/**
 * Operations that landed in this run. The count the P&L gate reads, and it
 * counted rows: a redeploy's re-recorded copies doubled it.
 */
export async function countLandedOps(db: Db, account: string, epoch: number | null): Promise<number> {
  const row = (await db
    .prepare(
      `SELECT COUNT(DISTINCT CASE WHEN t.status = 'landed' THEN ${tradeOpKey("t")} END) AS landed
         FROM trades t WHERE t.agent_id = ?${epoch === null ? "" : " AND t.epoch = ?"}`,
    )
    .get(account, ...(epoch === null ? [] : [epoch]))) as { landed: number | null } | undefined;
  return Number(row?.landed ?? 0);
}

/**
 * HOW FAR BACK THE OWNER'S TAPE REACHES.
 *
 * The trades select was `LIMIT 30` with no window at all, so for an agent that
 * has done nothing lately the newest thirty rows are simply its last thirty
 * refusals — however old. The chat sends this tape to a model, the system
 * prompt tells the model to ground itself in it, and the rows carry no
 * timestamp the model can reason about. A tester's agent therefore narrated
 * months-old `no-gas` and `per-trade-cap` refusals in the present tense, and
 * was believed, because it was reading its own ledger faithfully.
 *
 * The window bounds RECENCY and the limit bounds SIZE. Neither substitutes for
 * the other, so both stay.
 */
export const TAPE_WINDOW_SEC = 7 * 24 * 3600;

/**
 * The account's current RUN, or null when this ledger predates runs.
 *
 * Null, not 1: an older worker's database has no `epoch` column, and naming a
 * missing column throws at query time — so every read scoped by it would blank
 * its panel. With null the caller leaves the rows unfiltered, which on such a
 * ledger is the same thing, since every row in it is epoch 1 by definition. An
 * account with no agents row yet is on its first run.
 */
export async function readRunEpoch(db: Db, account: string): Promise<number | null> {
  try {
    const row = (await db.prepare("SELECT epoch FROM agents WHERE smart_account = ?").get(account)) as
      | { epoch: number }
      | undefined;
    return row?.epoch ?? 1;
  } catch {
    return null;
  }
}

/**
 * The owner's tape and the count of what landed, for one account and run, as
 * /api/feed serves them. `nowSec` is passed in so the window is a fact a test
 * can move rather than whatever the clock said.
 *
 * Each half fails on its own and says so with null: an unreadable tape is not
 * a reason to lose the landed count, nor the other way round.
 */
export async function readOwnerTape(
  db: Db,
  account: string,
  epoch: number | null,
  nowSec: number,
): Promise<{ trades: DeskTradeRow[] | null; landed: number | null }> {
  let trades: DeskTradeRow[] | null = null;
  let landed: number | null = null;
  try {
    trades = await readDeskTrades(db, account, epoch, nowSec - TAPE_WINDOW_SEC);
  } catch {
    trades = null;
  }
  try {
    // Operations, not rows: a redeploy's re-recorded copies doubled this.
    landed = await countLandedOps(db, account, epoch);
  } catch {
    landed = null;
  }
  return { trades, landed };
}
