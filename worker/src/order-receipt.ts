/**
 * THE RECEIPT AN OWNER'S ORDER COMES BACK WITH — built from ledger facts, never
 * from a sentence.
 *
 * A command result used to be `{ ok, line }` and nothing else, so every surface
 * that wanted to show "[Buy] $5.00 CASHCAT · Filled" had two choices: parse the
 * prose, or ask a model to. Parsing prose is how `ok` came to be derived from
 * the first emoji of a line (order-command.test.ts carries that incident), and a
 * model writing a receipt is a claim about somebody's money that nobody checked.
 * So the facts travel beside the sentence, as data, and the renderer templates
 * them.
 *
 * EVERY FIELD IS A FACT OR IT IS NULL. The status is the verdict the worker
 * reached; the tx hash, the token and the USDG that moved are read off the trade
 * row `recordTrade` wrote; side and symbol are the order's own validated
 * arguments. Nothing is estimated: a sell's proceeds are known only when the
 * receipt was read off the chain, so a quote-booked sell reports `usdgActual:
 * null` rather than the figure the quote hoped for — the same rule profile
 * trades and the feed follow, where an unread input renders nothing.
 *
 * TWO LEDGER STATES HAVE NO RECEIPT, on purpose. The shared contract (C3) names
 * four statuses and "sent, not yet settled" is none of them; "simulated instead
 * of trading for real" is none of them either. Squeezing `submitted` into
 * `filled` would announce a fill the ledger has not seen, and squeezing `paper`
 * into `filled` would put a practice trade on a surface that reads as money.
 * Those two return no receipt and the owner reads the line, which already says
 * exactly which of them it was.
 */

/** C3's statuses. Closed: a renderer switches on these and nothing else. */
export type ReceiptStatus = "filled" | "refused" | "failed" | "expired";

/** The C3 receipt, as it sits in a command result beside `{ ok, line }`. */
export interface OrderReceipt {
  status: ReceiptStatus;
  side: "buy" | "sell" | null;
  symbol: string | null;
  /** The token leg the order was about, from the trade row. Null when no row exists. */
  token: string | null;
  /** USDG that actually moved — paid on a buy, received on a sell. Null unless the ledger knows it exactly. */
  usdgActual: number | null;
  txHash: string | null;
  /** The wall's rule name from the trade row, when there is one. Never invented for a worker-side no. */
  rejectRule: string | null;
}

/**
 * What one trade row said, as the order that wrote it gets it back.
 *
 * The same row `addTrade` persisted, narrowed to what a receipt reads. Carried
 * out of the intent queue beside the status that was already carried, so the
 * receipt and the sentence are two readings of ONE row rather than two reads
 * that could disagree.
 */
export interface LedgerFacts {
  status: "landed" | "reverted" | "rejected" | "paper" | "submitted" | "dropped";
  rejectRule?: string;
  txHash?: string;
  sellToken?: string;
  buyToken?: string;
  /** The row's notional, 6dp-derived USDG. */
  amountUsdg?: number;
  /** The cash leg of the fill, when one was booked. */
  fillCashUsdg?: number;
  /** How the fill figures were obtained — only 'receipt' is read off the chain. */
  basisSource?: "receipt" | "paper" | "quote";
}

/** A trade row, as far as `ledgerFactsOf` reads one. Structural, so the store's TradeRow fits. */
export interface TradeRowLike {
  status: LedgerFacts["status"];
  reject_rule?: string;
  tx_hash?: string;
  sell_token?: string;
  buy_token?: string;
  amount_usdg?: number;
  fill_cash_usdg?: number;
  basis_source?: "receipt" | "paper" | "quote";
}

/** The facts a receipt may be built from, lifted off the row that was written. */
export function ledgerFactsOf(row: TradeRowLike): LedgerFacts {
  return {
    status: row.status,
    ...(row.reject_rule !== undefined ? { rejectRule: row.reject_rule } : {}),
    ...(row.tx_hash !== undefined ? { txHash: row.tx_hash } : {}),
    ...(row.sell_token !== undefined ? { sellToken: row.sell_token } : {}),
    ...(row.buy_token !== undefined ? { buyToken: row.buy_token } : {}),
    ...(row.amount_usdg !== undefined ? { amountUsdg: row.amount_usdg } : {}),
    ...(row.fill_cash_usdg !== undefined ? { fillCashUsdg: row.fill_cash_usdg } : {}),
    ...(row.basis_source !== undefined ? { basisSource: row.basis_source } : {}),
  };
}

/**
 * Where an order ended up, as the submitter knows it. Absent means a gate in
 * the worker said no before anything was built — nothing was sent.
 *
 *   late   — the intent queue reached it after its own deadline; not run
 *   no-row — it was handed to the pipeline and no trade row came back
 *   ledger — a row was written, and here is what it said
 */
export type OrderVerdict = { kind: "late" } | { kind: "no-row" } | { kind: "ledger"; facts: LedgerFacts };

/**
 * An order's side and symbol, when its arguments carry valid ones.
 *
 * LABELS, NOT A GATE. The gate is runOrderCommand's, in the process that holds
 * the key, and it refuses anything this returns null for. This only decides what
 * a receipt may print — and prints nothing it would not have accepted, so a
 * refusal of `side: "yolo"` cannot come back as a receipt reading "[yolo]".
 */
export function orderSubject(args: Record<string, unknown> | undefined): {
  side: "buy" | "sell" | null;
  symbol: string | null;
} {
  const side = args?.side === "buy" || args?.side === "sell" ? args.side : null;
  const raw = typeof args?.symbol === "string" ? args.symbol.trim().toUpperCase() : "";
  return { side, symbol: /^[A-Z0-9]{1,12}$/.test(raw) ? raw : null };
}

/** A reject rule as a receipt carries it: bounded, because a revert reason is chain text. */
function rule(r: string | undefined): string | null {
  if (typeof r !== "string") return null;
  const t = r.trim();
  return t ? t.slice(0, 120) : null;
}

const finite = (n: number | undefined): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * The USDG a landed order actually moved, or null when that is not known exactly.
 *
 * A fill read off the settled transaction is the fact, either way round. Short
 * of that, a BUY still knows: what it spent is its own exact input — the swap
 * and the curve both send precisely the notional the row records. A SELL does
 * not: what came back is only known from the receipt, and the quote's figure is
 * an estimate, which is exactly what this field must never carry.
 */
function usdgMoved(side: "buy" | "sell" | null, f: LedgerFacts): number | null {
  if (f.basisSource === "receipt" && finite(f.fillCashUsdg) && f.fillCashUsdg >= 0) return f.fillCashUsdg;
  if (side === "buy" && finite(f.amountUsdg) && f.amountUsdg > 0) return f.amountUsdg;
  return null;
}

/**
 * THE RECEIPT, or undefined where the contract has no honest status for it.
 *
 * `verdict` undefined is a worker-side no that returned before an intent was
 * built — paused, over the chat ceiling, an unreadable market or book, a symbol
 * it does not watch. Nothing was sent, so it is `refused`, and it carries no
 * rule: those are the worker's own sentences, not the wall's rule names, and a
 * renderer that looked one up would find nothing and should read the line.
 */
export function orderReceipt(
  subject: { side: "buy" | "sell" | null; symbol: string | null },
  verdict: OrderVerdict | undefined,
): OrderReceipt | undefined {
  const base = { side: subject.side, symbol: subject.symbol };
  const nothing = { token: null, usdgActual: null, txHash: null, rejectRule: null };
  if (!verdict) return { status: "refused", ...base, ...nothing };
  if (verdict.kind === "late") return { status: "expired", ...base, ...nothing };
  if (verdict.kind === "no-row") return { status: "failed", ...base, ...nothing };
  const f = verdict.facts;
  // The leg the order was ABOUT: what a buy bought, what a sell sold.
  const leg = subject.side === "buy" ? f.buyToken : subject.side === "sell" ? f.sellToken : undefined;
  const token = typeof leg === "string" && leg ? leg : null;
  switch (f.status) {
    case "landed":
      return {
        status: "filled",
        ...base,
        token,
        usdgActual: usdgMoved(subject.side, f),
        txHash: f.txHash || null,
        rejectRule: null,
      };
    case "rejected":
      return { status: "refused", ...base, token, usdgActual: null, txHash: null, rejectRule: rule(f.rejectRule) };
    case "reverted":
      // It reached the chain and turned back: nothing moved but the gas, so no
      // USDG figure — and the hash, because the owner can look the revert up.
      return { status: "failed", ...base, token, usdgActual: null, txHash: f.txHash || null, rejectRule: rule(f.rejectRule) };
    case "dropped":
      // Sent, and provably never executed (a later op used its nonce): it did
      // not fill and nothing moved — not even gas — so no figure and no hash.
      // Only the stranded-op resolver writes this, never the order's own
      // row write, so an order meets it only if that ever changes.
      return { status: "failed", ...base, token, usdgActual: null, txHash: null, rejectRule: rule(f.rejectRule) };
    case "submitted":
    case "paper":
      return undefined;
    default: {
      // A status this file has never heard of is not guessed at.
      const unknown: never = f.status;
      void unknown;
      return undefined;
    }
  }
}

/**
 * The receipt for an order that is not run because its window closed before it
 * was reached. Nothing was built or sent, so every ledger field is null.
 */
export function expiredOrderReceipt(args: Record<string, unknown> | undefined): OrderReceipt {
  return orderReceipt(orderSubject(args), { kind: "late" }) as OrderReceipt;
}
