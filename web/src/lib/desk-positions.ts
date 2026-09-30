/**
 * THE OWNER'S HOLDINGS, as /api/feed serves them to their own desk and chat —
 * each with what it cost, the stop it was graded, and whether that cost can be
 * vouched for.
 *
 * Kept out of the route so it can be driven against a real ledger in a test:
 * the route is where the positions read used to live, and nothing ran it.
 */
import type { Db } from "../../../worker/src/db";
import { basisUsdg } from "./basis-usdg";
import { distinctTrades } from "./distinct-trades";

export interface DeskPositionRow {
  symbol: string;
  raw_balance: string;
  ui_multiplier: string;
  price_usd: number;
  price_stale: number;
  price_source: string;
  value_usdg: number;
  /** Whole USDG, or null when the ledger has no basis. See the route's PositionRow. */
  cost_usdg?: number | null;
  /**
   * WHETHER A FILL BOOKED FROM THE PRE-TRADE QUOTE MAY STILL BE IN THAT COST.
   *
   * False only when the fills behind the holding were replayed and none of the
   * ones still in its cost was a quote. Null when that could not be told — the
   * fills could not be read, or were too many to replay — which a reader must
   * treat as "not vouched for", never as "from a receipt".
   */
  cost_from_quote?: boolean | null;
  stop_floor_bps?: number | null;
  stop_floor_why?: string | null;
}

/** One booked fill of one token, oldest first, as the ledger holds it. */
export interface BasisFill {
  /** Null when the row moved the token but carries no fill side — see below. */
  side: "buy" | "sell" | null;
  /** 18dp raw units, as a decimal string. Null when the row did not record it. */
  qtyRaw: string | null;
  /** `trades.basis_source`: 'receipt', 'paper', 'quote' or null. */
  source: string | null;
}

function qtyOf(raw: string | null): bigint | null {
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  return BigInt(raw.trim());
}

/**
 * DOES THIS HOLDING'S COST STILL CARRY A FILL THAT WAS BOOKED FROM A QUOTE?
 *
 * The worker books a live fill from the pre-trade quote when it cannot read the
 * receipt, and marks the TRADE row `basis_source = 'quote'`. The cost it adds to
 * `cost_basis` carries no such mark: that table is one running total per coin.
 * So the question is answered the only way the ledger can answer it — by
 * replaying the fills the way the worker's applyFill booked them (a buy adds its
 * quantity, a sell removes up to what is held, and a position that reaches zero
 * leaves no cost behind) and asking whether a quote-booked fill is among those
 * still in the total.
 *
 * WHEN THE REPLAY CANNOT BE EXACT, NOTHING IS FORGIVEN. A row that moved the
 * token without a recorded side or quantity — the reconciler books a cost for an
 * op it recovers but writes no fill columns on the row — means the replay no
 * longer knows when the position was flat, so from there on a quote fill is not
 * cleared by a sell that only LOOKS like it closed the position. The same holds
 * when the read was truncated (`complete` false): the replay cannot know what
 * came before its first row.
 *
 * AND A TRUNCATED READ THAT FOUND NO QUOTE ANSWERS NULL, NOT FALSE. It used to
 * answer false, which read as "a quote it never read is not invented" — but the
 * quote-booked fill can sit in exactly the rows the read cut off, under a
 * holding that never went flat since, and false is the one answer the desk and
 * the chat print a % on. Absence from a partial read is not absence.
 */
export function costFromQuote(fills: readonly BasisFill[], complete: boolean): boolean | null {
  let exact = complete;
  let held = 0n;
  let quote = false;
  for (const f of fills) {
    if (f.source === "quote") quote = true;
    const qty = qtyOf(f.qtyRaw);
    if (f.side === null || qty === null) {
      exact = false;
      continue;
    }
    if (!exact) continue;
    if (f.side === "buy") {
      held += qty;
    } else {
      held -= qty < held ? qty : held;
      // Flat: the worker deleted this coin's basis, so nothing booked before
      // this point is in the cost of whatever is held now.
      if (held <= 0n) {
        held = 0n;
        quote = false;
      }
    }
  }
  if (quote) return true;
  return complete ? false : null;
}

/**
 * Rows read to replay one account's book. Past this the read is truncated, and a
 * truncated replay vouches for nothing (see costFromQuote).
 */
export const PROVENANCE_ROWS = 5000;

/**
 * `cost_from_quote` for each held token (lowercased), or THROWS when the fills
 * cannot be read — the caller then reports every holding as not vouched for.
 *
 * One row per operation (distinct-trades.ts): a redeploy's re-recorded copy of a
 * fill carries no fill columns, and replayed beside its original it would read
 * as a movement the replay cannot account for.
 */
export async function readCostFromQuote(
  db: Db,
  account: string,
  book: "paper" | "live",
  tokens: readonly string[],
): Promise<Map<string, boolean | null>> {
  const out = new Map<string, boolean | null>();
  const want = [...new Set(tokens.map((t) => t.toLowerCase()))];
  if (want.length === 0) return out;
  const marks = want.map(() => "?").join(", ");
  const rows = (await db
    .prepare(
      // Scoped inside the collapse to rows that could have booked a cost: every
      // hashed row (so a copy still finds its original), and any row carrying
      // fill or basis columns. A refusal carries none of those and cannot
      // collide with anything, and this runs on every feed poll.
      `SELECT t.fill_side, t.fill_qty_raw, t.basis_source, LOWER(t.buy_token) AS buy_token, LOWER(t.sell_token) AS sell_token
         FROM ${distinctTrades("t.agent_id = ? AND (t.user_op_hash IS NOT NULL OR t.fill_side IS NOT NULL OR t.basis_source IS NOT NULL)")}
        WHERE t.status = ?
          AND (t.fill_side IN ('buy','sell') OR t.basis_source IS NOT NULL)
          AND (LOWER(t.buy_token) IN (${marks}) OR LOWER(t.sell_token) IN (${marks}))
        ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
    )
    // The book's own status: a paper fill never prices a funded holding, the
    // same partition cost_basis keeps by mode.
    .all(account, book === "paper" ? "paper" : "landed", ...want, ...want, PROVENANCE_ROWS)) as {
    fill_side: string | null;
    fill_qty_raw: string | null;
    basis_source: string | null;
    buy_token: string | null;
    sell_token: string | null;
  }[];
  const complete = rows.length < PROVENANCE_ROWS;
  const byToken = new Map<string, BasisFill[]>(want.map((t) => [t, []]));
  for (const r of [...rows].reverse()) {
    const source = r.basis_source;
    const qtyRaw = r.fill_qty_raw === null || r.fill_qty_raw === undefined ? null : String(r.fill_qty_raw);
    if (r.fill_side === "buy" || r.fill_side === "sell") {
      const token = r.fill_side === "buy" ? r.buy_token : r.sell_token;
      if (token) byToken.get(token)?.push({ side: r.fill_side, qtyRaw, source });
      continue;
    }
    // No side: the token moved and the row cannot say which way or how much.
    for (const token of [r.buy_token, r.sell_token]) {
      if (token) byToken.get(token)?.push({ side: null, qtyRaw: null, source });
    }
  }
  for (const [token, fills] of byToken) out.set(token, costFromQuote(fills, complete));
  return out;
}

/**
 * WHAT EACH HOLDING COST, AND WHERE THAT COST CAME FROM.
 *
 * The cost is joined here because the owner's own agent could not answer for
 * it. Asked "what did NVDA cost you and when will you sell", it replied that it
 * held nothing but cash — while the panel beside the chat listed NVDA and QQQ.
 * The chat sends this payload, and a position with no basis on it cannot answer
 * either half of that question.
 *
 * LEFT JOIN and NULL-tolerant: a holding with no basis on record is a fact ("I
 * do not know what this cost"), and 0 would say it was free. `cost_basis` is
 * keyed by BOOK — a paper cost must never price a funded position — so the
 * caller passes the book of the newest equity mark, which is the book the
 * worker actually ran.
 *
 * THROWS only when the positions table itself cannot be read.
 */
export async function readDeskPositions(db: Db, account: string, book: "paper" | "live"): Promise<DeskPositionRow[]> {
  let rows: (DeskPositionRow & { token?: string | null })[];
  try {
    rows = (await db
      .prepare(
        `SELECT p.symbol AS symbol, p.token AS token, p.raw_balance AS raw_balance, p.ui_multiplier AS ui_multiplier,
                p.price_usd AS price_usd, p.price_stale AS price_stale,
                p.price_source AS price_source, p.value_usdg AS value_usdg,
                b.cost_usdg AS cost_usdg,
                f.stop_bps AS stop_floor_bps, f.why AS stop_floor_why
           FROM positions p
           LEFT JOIN cost_basis b
             ON b.agent_id = p.agent_id AND b.symbol = p.symbol AND b.mode = ?
           LEFT JOIN position_floors f
             ON f.agent_id = p.agent_id AND f.symbol = p.symbol AND f.mode = ?
          WHERE p.agent_id = ? ORDER BY p.value_usdg DESC`,
      )
      .all(book, book, account)) as unknown as (DeskPositionRow & { token?: string | null })[];
  } catch {
    // price_source arrives with a worker migration. The dashboard can be
    // running against a database the upgraded worker hasn't opened yet, and
    // losing the whole positions panel over a label would be a worse bug than
    // the missing label — so fall back to the shape that always existed. No
    // cost is read on this path, so there is no provenance to report either.
    const legacy = (await db
      .prepare(
        `SELECT symbol, raw_balance, ui_multiplier, price_usd, price_stale, value_usdg
         FROM positions WHERE agent_id = ? ORDER BY value_usdg DESC`,
      )
      .all(account)) as unknown as Omit<DeskPositionRow, "price_source">[];
    return legacy.map((p) => ({ ...p, price_source: "chainlink" }));
  }
  // WHERE EACH COST CAME FROM. A failed read reports every holding as not
  // vouched for (null) rather than dropping the panel or claiming receipts.
  let provenance: Map<string, boolean | null> | null = null;
  try {
    provenance = await readCostFromQuote(
      db,
      account,
      book,
      rows.map((r) => r.token).filter((t): t is string => typeof t === "string" && t !== ""),
    );
  } catch {
    provenance = null;
  }
  return rows.map(({ token, ...p }) => {
    // MICRO-USDG → USDG at the boundary, so no browser has to know the column
    // keeps a different unit from every other money field on this response.
    const cost = basisUsdg((p as { cost_usdg?: unknown }).cost_usdg);
    const known = provenance && token ? provenance.get(token.toLowerCase()) : undefined;
    return {
      ...p,
      cost_usdg: cost,
      cost_from_quote: cost === null ? null : known === undefined ? null : known,
    };
  });
}
