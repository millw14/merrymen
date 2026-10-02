import type { Db } from "./db";
import { distinctTrades } from "./distinct-trades";

export type TradeBook = "landed" | "paper";

/** One basis-moving fill, as the replay below reads it. */
export interface BasisReplayFill {
  /** The operation it belongs to — the same key distinct-trades collapses on. */
  op: string;
  /** Null when the row moved the coin and did not record which way. */
  side: "buy" | "sell" | null;
  /** The coin's address, lowercased. */
  token: string;
  /** Raw units, as the ledger's decimal string. Null when not recorded. */
  qty: string | null;
  /** `trades.basis_source`. */
  source: string | null;
}

const EVIDENCED_SOURCES: ReadonlySet<string> = new Set(["receipt", "paper"]);

/**
 * WHICH SELLS REALIZED AGAINST A COST NOTHING ESTIMATED.
 *
 * A sell's realized_pnl_usdg is its proceeds minus the running cost basis, and
 * that basis is one total per coin that every buy since the position was last
 * flat added to — including a buy whose receipt could not be read, which the
 * worker books from the pre-trade quote (basis_source 'quote', an estimate). The
 * sell's own basis_source says nothing about those buys. So the fills are
 * replayed the way the worker's applyFill booked them (desk-positions.ts
 * costFromQuote does the same for a holding): a buy adds its quantity, a sell
 * removes up to what is held, a position that reaches zero leaves nothing
 * behind. A sell is vouched for when no buy still in the basis it sold against
 * was anything but a receipt or a paper fill.
 *
 * NOTHING IS FORGIVEN THAT CANNOT BE COUNTED. A row that moved the coin without
 * a recorded side or quantity means flat can no longer be told, so an estimate
 * already in stays in; and a read that was cut short (`complete` false) cannot
 * know what came before its first row, so it vouches for nothing. A cost of
 * unknown provenance (no basis_source) is not evidence either.
 *
 * `fills` oldest first. Returns the ops of the vouched sells.
 */
export function vouchedSells(fills: readonly BasisReplayFill[], complete: boolean): Set<string> {
  const vouched = new Set<string>();
  if (!complete) return vouched;
  const state = new Map<string, { held: bigint; estimated: boolean; exact: boolean }>();
  for (const f of fills) {
    const s = state.get(f.token) ?? { held: 0n, estimated: false, exact: true };
    state.set(f.token, s);
    const qty = f.qty !== null && /^\d+$/.test(f.qty.trim()) ? BigInt(f.qty.trim()) : null;
    // A sell is judged by the basis it sold against: everything before it.
    if (f.side === "sell" && !s.estimated) vouched.add(f.op);
    if (f.side === null || qty === null) {
      // It moved the coin by an amount nobody recorded; one that was not a sell
      // may have booked a cost of its own.
      s.exact = false;
      if (f.side !== "sell" && !EVIDENCED_SOURCES.has(f.source ?? "")) s.estimated = true;
      continue;
    }
    if (f.side === "buy") {
      s.held += qty;
      if (!EVIDENCED_SOURCES.has(f.source ?? "")) s.estimated = true;
      continue;
    }
    s.held -= qty < s.held ? qty : s.held;
    // Flat, and known to be: the worker deleted this coin's basis, so nothing
    // booked before here is in the cost of what comes next.
    if (s.exact && s.held === 0n) s.estimated = false;
  }
  return vouched;
}

/** Rows one COIN's replay reads before it stops and vouches for nothing it could not see. */
export const BASIS_REPLAY_ROWS = 5_000;

/**
 * The same operation key distinct-trades.ts collapses copies on, as a column
 * of a `distinctTrades(…, "t")` read. Exported so the owner's tape can name its
 * sells the way the replay below does (desk-trades.ts).
 */
export const OP_KEY = "COALESCE(LOWER(NULLIF(t.user_op_hash, '')), 'row:' || CAST(t.id AS TEXT))";

/** What one book's replay of some coins found. */
export interface BasisReplay {
  /** The ops of the sells whose basis nothing estimated (vouchedSells). */
  vouched: Set<string>;
  /**
   * Coins with more basis-moving fills than one replay reads. Nothing is known
   * about any of their sells' costs — which is not the same as knowing they
   * were estimated, and a reader must not print it as either.
   */
  cut: Set<string>;
  /** Each replayed sell's OWN basis_source, by op — how its proceeds were read. */
  sellSource: Map<string, string | null>;
}

/**
 * vouchedSells over one book's fills of `tokens`, across EVERY period —
 * cost_basis is not scoped to one, so a position bought last period is sold
 * against the basis that period booked. One row per operation; scoped to rows
 * that could have booked a cost, as readCostFromQuote is.
 *
 * EACH COIN IS ITS OWN REPLAY, capped at BASIS_REPLAY_ROWS of its own fills.
 * One query still reads every coin asked about, but the cap is counted per coin
 * (ROW_NUMBER over the coin), because a shared cap made the page's coins
 * compete for it: a basket whose coins together passed it had every replay cut,
 * vouched for nothing, and TOP TRADES came back an empty list read as true. A
 * coin whose OWN fills pass the cap is still cut, and says so in `cut`.
 *
 * A row is counted against the coin it moved: a buy against what it bought, a
 * sell against what it sold, and a row with no side against both its legs.
 *
 * THROWS when the fills cannot be read; each caller says what that means.
 */
export async function replayBasis(db: Db, account: string, book: TradeBook, tokens: readonly string[]): Promise<BasisReplay> {
  const want = [...new Set(tokens.map(t=>t.toLowerCase()).filter(t=>t!==""))];
  if(!want.length)return basisReplayFromRows([]);
  const rows=await db.prepare(basisReplaySql(want)).all(account,book,...want,BASIS_REPLAY_ROWS+1) as Record<string,unknown>[];
  return basisReplayFromRows(rows);
}
function basisReplaySql(want:readonly string[]):string {
  const marks=want.map(()=>"?").join(", ");
  return `SELECT r.op, r.fill_side, r.fill_qty_raw, r.basis_source, r.coin
         FROM (
           SELECT l.*, ROW_NUMBER() OVER (PARTITION BY l.coin ORDER BY l.created_at DESC, l.id DESC) AS coin_rank
             FROM (
               SELECT ${OP_KEY} AS op, t.fill_side, t.fill_qty_raw, t.basis_source, t.created_at, t.id,
                      CASE WHEN leg.side = 'buy' THEN LOWER(t.buy_token) ELSE LOWER(t.sell_token) END AS coin
                 FROM ${distinctTrades("LOWER(t.agent_id) = LOWER(?) AND (t.user_op_hash IS NOT NULL OR t.fill_side IS NOT NULL OR t.basis_source IS NOT NULL)")}
                CROSS JOIN (SELECT 'buy' AS side UNION ALL SELECT 'sell' AS side) leg
                WHERE t.status = ?
                  AND (t.fill_side IN ('buy','sell') OR t.basis_source IS NOT NULL)
                  AND (t.fill_side IS NULL OR t.fill_side NOT IN ('buy','sell') OR t.fill_side = leg.side)
             ) l
            WHERE l.coin IN (${marks})
         ) r
        WHERE r.coin_rank <= ?
        ORDER BY r.created_at ASC, r.id ASC`;
}
function basisReplayFromRows(rows:Record<string,unknown>[]):BasisReplay {
  const out:BasisReplay={vouched:new Set(),cut:new Set(),sellSource:new Map()};
  const byCoin = new Map<string, BasisReplayFill[]>();
  for (const r of rows) {
    const coin = typeof r.coin === "string" ? r.coin : "";
    if (!coin) continue;
    const op = String(r.op);
    const side = r.fill_side === "buy" || r.fill_side === "sell" ? r.fill_side : null;
    const source = typeof r.basis_source === "string" ? r.basis_source : null;
    // No side: the coin moved and the row cannot say which way or how much.
    const qty = side === null || r.fill_qty_raw === null || r.fill_qty_raw === undefined ? null : String(r.fill_qty_raw);
    if (side === "sell") out.sellSource.set(op, source);
    const fills = byCoin.get(coin) ?? [];
    byCoin.set(coin, fills);
    fills.push({ op, side, token: coin, qty, source });
  }
  for (const [coin, fills] of byCoin) {
    const complete = fills.length <= BASIS_REPLAY_ROWS;
    if (!complete) out.cut.add(coin);
    for (const op of vouchedSells(fills, complete)) out.vouched.add(op);
  }
  return out;
}

/**
 * THE SELLS WHOSE REALIZED P&L IS A MEASUREMENT, of those asked about.
 *
 * Both halves of a realized figure have to have been read: the proceeds (the
 * sell's own basis_source is the book's evidence — a receipt, or a paper fill)
 * and the cost it was measured against (vouchedSells: no estimate in the basis
 * it sold against, replayed whole). The owner's desk prints realized dollars on
 * every filled sell, so it asks this first (desk-trades.ts) — the same rule the
 * profile ranks and lists by, applied where the owner reads the same sell.
 *
 * THROWS when the fills cannot be replayed; the caller then vouches for none.
 */
export async function readEvidencedSells(
  db: Db,
  account: string,
  book: TradeBook,
  sells: readonly { op: string; token: string }[],
): Promise<Set<string>> {
  if (sells.length === 0) return new Set();
  const replay = await replayBasis(db, account, book, sells.map((s) => s.token));
  const own = book === "paper" ? "paper" : "receipt";
  return new Set(sells.filter((s) => replay.vouched.has(s.op) && replay.sellSource.get(s.op) === own).map((s) => s.op));
}


/** The same proof for synchronous Telegram reports, with no second policy implementation. */
export function readEvidencedSellsSync(db:{prepare(sql:string):{all(...args:never[]):unknown[]}},account:string,book:TradeBook,sells:readonly {op:string;token:string}[]):Set<string> {
  const want=[...new Set(sells.map(s=>s.token.toLowerCase()).filter(t=>t!==""))];
  if(!want.length)return new Set();
  const rows=db.prepare(basisReplaySql(want)).all(...[account,book,...want,BASIS_REPLAY_ROWS+1] as never[]) as Record<string,unknown>[];
  const replay=basisReplayFromRows(rows),own=book==="paper"?"paper":"receipt";
  return new Set(sells.filter(s=>replay.vouched.has(s.op)&&replay.sellSource.get(s.op)===own).map(s=>s.op));
}
