/**
 * Portfolio and trades: what an agent holds and what it did, per BOOK.
 *
 * Every tool reads the agent's own smart accounts only (ctx.agent resolves the
 * owned agent; its account history comes from the identity store, never from
 * an argument), and every figure is labelled paper (simulated) or live (real
 * funds). The two are never added together: comparing them is allowed, netting
 * them is not.
 *
 * The accounting lives in lib/services/portfolio.ts so the app can serve the
 * same views; this module validates input, wraps third-party text in
 * untrusted(), turns timestamps into ISO strings and declares the exact shapes.
 */
import * as z from "zod";
import { freshWithin } from "@/lib/services/agent-status";
import { settingsReader } from "@/lib/services/settings-view";
import {
  ACCOUNT_CUSTODY, REMAINDER_EXPLAINED, groupExposure, ledgerScope, readPerformance, readPortfolio, readTradeDetail, readTradePage,
  type Book, type BookPerformance, type BookPortfolio, type DecisionSummary, type LedgerScope, type PortfolioView, type TradeView,
} from "@/lib/services/portfolio";
import type { OwnedAgent } from "../agents";
import { McpError } from "../errors";
import type { ResourceDef } from "../resources";
import { defineTool, type ToolContext } from "../tool";
import { ADDRESS_ARG, AGENT_ARG, LIMIT_ARG, UNTRUSTED_NOTE, decodeCursor, encodeCursor, isoOrNull, untrusted } from "./shared";

const BOOK = z.enum(["paper", "live"]);
const MONEY_OF = z.enum(["simulated", "real"]);
const iso = (sec: number) => new Date(sec * 1000).toISOString();
const moneyOf = (b: Book) => (b === "paper" ? "simulated" : "real") as "simulated" | "real";

const BOOKS_NOTE = "Paper and live are separate books: paper is simulated money, live is real funds on chain. Their figures are never added together.";

function scopeOf(a: OwnedAgent): LedgerScope {
  return ledgerScope(a.accounts, a.account, a.chainId);
}

/** The worker's freshness window for this owner's tick; a failed settings read falls back to the default tick. */
async function freshSec(ctx: ToolContext): Promise<number> {
  const s = await settingsReader().settingsFor(ctx.principal.tenant).catch(() => null);
  return freshWithin(s?.tickSeconds);
}

// ── get_portfolio ───────────────────────────────────────────────────────────

const VALUATION = z.object({
  valuation_time: z.string(),
  valuation_age_s: z.number(),
  fresh: z.boolean().describe("Younger than the worker's freshness window"),
  account: z.string().describe("The smart account this valuation is of"),
  epoch: z.number().nullable(),
  cash_usdg: z.number().nullable().describe("USDG in the smart account"),
  savings_usdg: z.number().nullable().describe("Morpho savings vault, converted to USDG by the worker (not a Trencher or class vault)"),
  positions_usdg: z.number().nullable().describe("Priced holdings in the smart account"),
  equity_usdg: z.number().nullable(),
  other_usdg: z.number().nullable().describe("equity − (cash + savings + positions)"),
  other_explained: z.string(),
  gas_balance: z.object({ eth_wei: z.string().nullable(), eth: z.number().nullable(), note: z.string() }),
});

const POSITION = z.object({
  token: z.string(),
  symbol: z.string().nullable().describe("untrusted: chosen by the token's creator"),
  raw_balance: z.string().describe("Raw token units"),
  price_usd: z.number().nullable(),
  price_stale: z.boolean(),
  price_source: z.string(),
  value_usdg: z.number().nullable(),
  updated_at: z.string().nullable(),
  cost_usdg: z.number().nullable().describe("Weighted-average cost of the quantity held, in this book"),
  cost_includes_quote_estimate: z.boolean().nullable().describe("True when a fill booked from a pre-trade quote is still in the cost; null when that could not be checked"),
  unrealized_pnl_usdg: z.number().nullable(),
  unrealized_pnl_pct: z.number().nullable(),
  pnl_missing_why: z.string().nullable(),
  custody: z.string(),
});

const CLASS_POSITION = z.object({
  token: z.string(),
  symbol: z.string().nullable().describe("untrusted: chosen by the token's creator"),
  state: z.enum(["open", "recovered"]),
  qty_raw: z.string().nullable(),
  decimals: z.number().nullable(),
  cost_usdg: z.number().nullable(),
  value_usdg: z.number().nullable().describe("Carried at cost: launch tokens in the class vault have no market mark"),
  valued_at: z.literal("cost"),
  custody: z.string(),
  entry_tx: z.string().nullable(),
  entry_tx_url: z.string().nullable(),
  opened_at: z.string().nullable(),
});

const BOOK_PORTFOLIO = z.object({
  book: BOOK,
  money: MONEY_OF,
  valuation: VALUATION.nullable(),
  positions_held_here: z.boolean(),
  positions: z.array(POSITION).nullable(),
  positions_note: z.string(),
  class_vault_positions: z.array(CLASS_POSITION),
  totals: z.object({
    positions_value_usdg: z.number().nullable(),
    cost_usdg: z.number().nullable(),
    unrealized_pnl_usdg: z.number().nullable().describe("Sum over holdings with both a fresh price and a known cost"),
    holdings_without_pnl: z.number(),
  }),
});

const PORTFOLIO_OUTPUT = z.object({
  agent: z.string(),
  account: z.string().nullable(),
  currency: z.literal("USDG"),
  accounting_method: z.literal("weighted-average cost"),
  current_book: BOOK.nullable(),
  current_book_why: z.string(),
  agent_mode: z.string().nullable().describe("The worker's last heartbeat: paper, live or idle"),
  latest_valuation_book: BOOK.nullable(),
  books_agree: z.boolean().nullable(),
  books: z.object({ paper: BOOK_PORTFOLIO, live: BOOK_PORTFOLIO }),
  books_note: z.string(),
  custody_note: z.string(),
  warnings: z.array(z.string()),
  observed_at: z.string(),
  untrusted_note: z.string(),
});
type PortfolioOut = z.infer<typeof PORTFOLIO_OUTPUT>;

function bookOut(b: BookPortfolio, now: number, fresh: number, current: Book | null): PortfolioOut["books"]["paper"] {
  const m = b.mark;
  let note: string;
  if (b.positions_held_here) note = "Holdings as of the latest valuation of this book.";
  else if (m) note = `The positions table holds only the book valued most recently${current ? ` (${current})` : ""}, so this book's holdings are not listed here.`;
  else note = "This book has never been valued.";
  return {
    book: b.book,
    money: moneyOf(b.book),
    valuation: m ? {
      valuation_time: iso(m.at),
      valuation_age_s: Math.max(0, now - m.at),
      fresh: now - m.at <= fresh,
      account: m.account,
      epoch: m.epoch,
      cash_usdg: m.cash_usdg,
      savings_usdg: m.savings_usdg,
      positions_usdg: m.positions_usdg,
      equity_usdg: m.equity_usdg,
      other_usdg: m.other_usdg,
      other_explained: REMAINDER_EXPLAINED,
      gas_balance: {
        eth_wei: m.eth_wei,
        eth: m.eth,
        note: b.book === "paper"
          ? "ETH as recorded on the paper valuation; gas is never part of equity."
          : "ETH the smart account holds to pay gas; not part of equity.",
      },
    } : null,
    positions_held_here: b.positions_held_here,
    positions: b.positions ? b.positions.map((p) => ({ ...p, symbol: untrusted(p.symbol, 32), updated_at: isoOrNull(p.updated_at) })) : null,
    positions_note: note,
    class_vault_positions: b.class_vault_positions.map((c) => ({
      token: c.token,
      symbol: untrusted(c.symbol, 32),
      state: c.state,
      qty_raw: c.qty_raw,
      decimals: c.decimals,
      cost_usdg: c.cost_usdg,
      value_usdg: c.cost_usdg,
      valued_at: "cost" as const,
      custody: c.vault ? `class vault ${c.vault}` : "class vault (address not recorded)",
      entry_tx: c.entry_tx,
      entry_tx_url: c.entry_tx_url,
      opened_at: isoOrNull(c.opened_at),
    })),
    totals: b.totals,
  };
}

function portfolioOut(a: OwnedAgent, v: PortfolioView, now: number, fresh: number): PortfolioOut {
  return {
    agent: a.slug,
    account: a.account,
    currency: "USDG",
    accounting_method: "weighted-average cost",
    current_book: v.current_book,
    current_book_why: v.current_book_why,
    agent_mode: v.agent_mode,
    latest_valuation_book: v.latest_valuation_book,
    books_agree: v.books_agree,
    books: { paper: bookOut(v.paper, now, fresh, v.latest_valuation_book), live: bookOut(v.live, now, fresh, v.latest_valuation_book) },
    books_note: BOOKS_NOTE,
    custody_note: `Positions sit in the ${ACCOUNT_CUSTODY}. Class-vault launch tokens are listed separately under the live book, at cost. savings_usdg is the Morpho savings vault; a zero there says nothing about whether any other vault is funded.`,
    warnings: v.warnings,
    observed_at: iso(now),
    untrusted_note: UNTRUSTED_NOTE,
  };
}

async function portfolioData(ctx: ToolContext, ref: string | undefined): Promise<PortfolioOut> {
  const a = await ctx.agent(ref);
  const now = ctx.now();
  const fresh = await freshSec(ctx);
  const view = await ctx.ledger((db) => readPortfolio(db, scopeOf(a), { now, freshWithinSec: fresh }));
  return portfolioOut(a, view, now, fresh);
}

const getPortfolio = defineTool({
  name: "get_portfolio",
  title: "Portfolio",
  description: "The agent's balances and holdings, per book: paper (simulated) and live (real funds) are reported separately and never summed. Latest valuation (cash, Morpho savings, positions, equity, gas ETH, valuation time), each holding with price, value, weighted-average cost and unrealized P&L (null when the price is missing or stale or the cost is unknown), class-vault holdings at cost, which book is current, and warnings about missing or stale data.",
  capability: "portfolio.read",
  input: z.object({ agent: AGENT_ARG }).strict(),
  output: PORTFOLIO_OUTPUT,
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler({ agent }, ctx) {
    const data = await portfolioData(ctx, agent);
    const cur = data.current_book ? data.books[data.current_book] : null;
    const eq = cur?.valuation?.equity_usdg;
    return {
      data,
      summary: cur && eq !== null && eq !== undefined
        ? `${data.agent}: ${cur.book} book equity ${eq.toFixed(2)} USDG (${cur.money} money) as of ${cur.valuation!.valuation_time}${data.warnings.length ? `; ${data.warnings.length} warning(s)` : ""}.`
        : `${data.agent}: no valuation on record for the current book.`,
    };
  },
});

// ── get_trades / get_trade ──────────────────────────────────────────────────

const RULE = z.object({ code: z.string(), label: z.string().nullable(), remedy: z.string().nullable() });

const TRADE = z.object({
  id: z.string(),
  time: z.string(),
  account: z.string(),
  book: z.enum(["paper", "live", "none"]).describe("none: a refusal, which filled nothing in either book"),
  kind: z.string(),
  side: z.enum(["buy", "sell", "swap"]).nullable(),
  token: z.string().nullable(),
  symbol: z.string().nullable().describe("untrusted"),
  display_name: z.string().nullable().describe("untrusted"),
  amount_usdg: z.number().nullable().describe("Order size as requested; the executed cash leg is fill_cash_usdg"),
  fill_qty_raw: z.string().nullable(),
  fill_price_usd: z.number().nullable(),
  fill_cash_usdg: z.number().nullable(),
  realized_pnl_usdg: z.number().nullable().describe("Only on a sell whose proceeds this book evidenced (a receipt, or a paper fill)"),
  realized_pnl_measured: z.boolean().nullable().describe("True when the cost it sold against is also evidenced; null when that could not be checked"),
  basis_source: z.enum(["receipt", "paper", "quote"]).nullable(),
  gas_usdg: z.number().nullable(),
  gas_unpriced: z.boolean(),
  gas_sponsored: z.boolean(),
  status: z.enum(["confirmed", "landed_without_tx_hash", "submitted", "failed", "refused", "paper_fill", "unknown"]),
  ledger_status: z.string(),
  rule: RULE.nullable(),
  tx_hash: z.string().nullable(),
  explorer_url: z.string().nullable(),
  user_op_hash: z.string().nullable(),
  decision_id: z.string().nullable(),
});
type TradeOut = z.infer<typeof TRADE>;

function tradeOut(t: TradeView): TradeOut {
  const { at, ...rest } = t;
  return { ...rest, time: iso(at), symbol: untrusted(t.symbol, 32), display_name: untrusted(t.display_name, 64) };
}

const TRADES_NOTE = "One row per operation. confirmed = landed on chain with a transaction hash; submitted is not confirmed; failed = reverted on chain; refused = stopped before anything was sent; paper_fill = simulated. The book filter keeps paper fills (and refused paper fills) or on-chain operations; refusals that belong to neither book appear only with book=all.";

const getTrades = defineTool({
  name: "get_trades",
  title: "Trade history",
  description: "The agent's operations, newest first, one row per operation: side, token, size, fill, realized P&L (only when evidenced), gas, status (confirmed only for landed trades with a transaction hash; submitted, failed, refused and paper fills are distinguished), the rule that refused or failed it, a block-explorer link and the decision id. Filter by book, status, token and time; page with `cursor`.",
  capability: "portfolio.read",
  input: z.object({
    agent: AGENT_ARG,
    book: z.enum(["paper", "live", "all"]).default("all").describe("paper: simulated fills; live: on-chain operations; all: everything, including refusals"),
    status: z.enum(["confirmed", "submitted", "failed", "refused", "paper", "all"]).default("all"),
    token: ADDRESS_ARG.optional().describe("Only operations that bought or sold this token"),
    since: z.iso.datetime({ offset: true }).optional().describe("ISO 8601 time; only operations at or after it"),
    limit: LIMIT_ARG(100, 25),
    cursor: z.string().max(512).optional().describe("next_cursor from the previous page of the same query"),
  }).strict(),
  output: z.object({
    agent: z.string(),
    trades: z.array(TRADE),
    next_cursor: z.string().nullable(),
    note: z.string(),
    observed_at: z.string(),
    untrusted_note: z.string(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler(args, ctx) {
    const a = await ctx.agent(args.agent);
    const token = args.token ? args.token.toLowerCase() : null;
    const since = args.since ? Math.floor(Date.parse(args.since) / 1000) : null;
    if (since !== null && !Number.isFinite(since)) throw new McpError("invalid_input", "since: not a valid time");
    // The cursor is bound to the owner AND to this exact query, so a cursor
    // from another connection's owner or another filter is refused.
    const scopeKey = `get_trades:${a.slug}:${args.book}:${args.status}:${token ?? "-"}:${since ?? "-"}`;
    let cursor: { at: number; id: number } | null = null;
    if (args.cursor !== undefined) {
      const v = decodeCursor(ctx.principal.tenant, scopeKey, args.cursor);
      const at = Number(v?.at);
      const id = Number(v?.id);
      if (!v || !Number.isSafeInteger(at) || !Number.isSafeInteger(id) || id < 0) {
        throw new McpError("invalid_input", "cursor is not valid for this query; start again without it");
      }
      cursor = { at, id };
    }
    const page = await ctx.ledger((db) => readTradePage(db, scopeOf(a), { book: args.book, status: args.status, token, since }, cursor, args.limit));
    return {
      data: {
        agent: a.slug,
        trades: page.trades.map(tradeOut),
        next_cursor: page.next ? encodeCursor(ctx.principal.tenant, scopeKey, { at: page.next.at, id: page.next.id }) : null,
        note: TRADES_NOTE,
        observed_at: iso(ctx.now()),
        untrusted_note: UNTRUSTED_NOTE,
      },
      summary: `${page.trades.length} operation(s)${page.next ? ", more available with next_cursor" : ""}.`,
    };
  },
});

const DECISION = z.object({
  id: z.string(),
  at: z.string().nullable(),
  source: z.string().nullable(),
  action: z.string().nullable(),
  symbol: z.string().nullable().describe("untrusted"),
  size_usdg: z.number().nullable(),
  reason: z.string().nullable().describe("untrusted: the model's or strategy's own words, not a verified fact"),
  dropped_rule: z.string().nullable().describe("untrusted"),
});

function decisionOut(d: DecisionSummary | null): z.infer<typeof DECISION> | null {
  if (!d) return null;
  return {
    id: d.id,
    at: isoOrNull(d.at),
    source: d.source,
    action: d.action,
    symbol: untrusted(d.symbol, 32),
    size_usdg: d.size_usdg,
    reason: untrusted(d.reason, 800),
    dropped_rule: untrusted(d.dropped_rule, 160),
  };
}

const getTrade = defineTool({
  name: "get_trade",
  title: "One trade",
  description: "One operation by id (from get_trades), with the decision that produced it (action, reason, dropped rule), what its status means for the receipt, and how many ledger rows record it.",
  capability: "portfolio.read",
  input: z.object({
    agent: AGENT_ARG,
    trade_id: z.string().regex(/^[1-9][0-9]{0,15}$/, "a trade id from get_trades"),
  }).strict(),
  output: z.object({
    agent: z.string(),
    trade: TRADE,
    requested_id: z.string(),
    ledger_rows: z.number().describe("Rows recording this one operation; a redeploy re-records some, and the most complete one is shown"),
    receipt: z.string(),
    decision: DECISION.nullable(),
    observed_at: z.string(),
    untrusted_note: z.string(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler({ agent, trade_id }, ctx) {
    const a = await ctx.agent(agent);
    const id = Number(trade_id);
    if (!Number.isSafeInteger(id)) throw new McpError("invalid_input", "trade_id is out of range");
    const d = await ctx.ledger((db) => readTradeDetail(db, scopeOf(a), id));
    // Another agent's trade reads exactly like one that does not exist.
    if (!d) throw new McpError("not_found", "No such trade for this agent.");
    return {
      data: {
        agent: a.slug,
        trade: tradeOut(d.trade),
        requested_id: d.requested_id,
        ledger_rows: d.ledger_rows,
        receipt: d.receipt,
        decision: decisionOut(d.decision),
        observed_at: iso(ctx.now()),
        untrusted_note: UNTRUSTED_NOTE,
      },
      summary: `Trade ${d.trade.id}: ${d.trade.status}${d.trade.side ? `, ${d.trade.side}` : ""} (${d.trade.book} book).`,
    };
  },
});

// ── get_performance / compare_paper_live ────────────────────────────────────

const PERIOD = z.enum(["day", "week", "month", "run"]).default("day").describe("day, week (7 days), month (30 days) or run (since the current accounting run began)");

const ATTRIBUTION = z.object({
  available: z.boolean(),
  why_unavailable: z.string().nullable(),
  flows_usdg: z.number().nullable(),
  trading_usdg: z.number().nullable(),
  unattributed_usdg: z.number().nullable().describe("Change no record explains; never counted as trading"),
  valuation_gaps: z.number().nullable(),
});

const OPS = z.object({
  confirmed: z.number(),
  landed_without_tx_hash: z.number(),
  submitted: z.number(),
  failed: z.number(),
  paper_fills: z.number(),
  paper_refused: z.number(),
});

const BOOK_PERF = z.object({
  book: BOOK,
  money: MONEY_OF,
  has_valuation: z.boolean(),
  valued_in_window: z.boolean(),
  start: z.object({ at: z.string(), equity_usdg: z.number() }).nullable(),
  end: z.object({ at: z.string(), equity_usdg: z.number() }).nullable(),
  change_usdg: z.number().nullable(),
  net_flows_usdg: z.number().nullable().describe("Deposits minus withdrawals in the window (live only; the paper book has none)"),
  flows_count: z.number().nullable(),
  flows_evidenced: z.number().nullable(),
  change_excluding_flows_usdg: z.number().nullable(),
  return_pct: z.number().nullable(),
  max_drawdown_pct: z.number().nullable(),
  attribution: ATTRIBUTION,
  realized_pnl_usdg: z.number().nullable().describe("Sum over sells whose proceeds and cost were both evidenced"),
  realized_sells_counted: z.number().nullable(),
  realized_sells_excluded: z.number().nullable(),
  fees_accrued_usdg: z.number().nullable(),
  fee_accruals: z.number().nullable(),
  gas_usdg: z.number().nullable(),
  gas_unpriced_ops: z.number().nullable(),
  gas_sponsored_ops: z.number().nullable(),
  ops: OPS,
  series: z.array(z.object({ at: z.string(), equity_usdg: z.number() })).max(200),
  series_bucket_s: z.number().nullable(),
  caveats: z.array(z.string()),
});

function perfOut(p: BookPerformance): z.infer<typeof BOOK_PERF> {
  return {
    ...p,
    money: moneyOf(p.book),
    start: p.start ? { at: iso(p.start.at), equity_usdg: p.start.equity_usdg } : null,
    end: p.end ? { at: iso(p.end.at), equity_usdg: p.end.equity_usdg } : null,
    series: p.series.map((s) => ({ at: iso(s.at), equity_usdg: s.equity_usdg })),
  };
}

const PERF_BUDGET = { bucket: "portfolio_performance", perMinute: 20 };

async function performanceData(ctx: ToolContext, ref: string | undefined, period: "day" | "week" | "month" | "run") {
  const a = await ctx.agent(ref);
  const now = ctx.now();
  const v = await ctx.ledger((db) => readPerformance(db, scopeOf(a), period, now));
  return { a, now, v };
}

const getPerformance = defineTool({
  name: "get_performance",
  title: "Performance",
  description: "How each book did over a period, paper and live separately: start and end equity, change, net deposits/withdrawals, change excluding them, time-weighted return, max drawdown, what trading vs flows vs unexplained changes account for, evidenced realized P&L, fees accrued, gas, operation counts, a downsampled equity series (≤200 points) and caveats.",
  capability: "portfolio.read",
  input: z.object({ agent: AGENT_ARG, period: PERIOD }).strict(),
  output: z.object({
    agent: z.string(),
    period: z.enum(["day", "week", "month", "run"]),
    window_start: z.string(),
    window_end: z.string(),
    run_epoch: z.number().nullable(),
    books: z.object({ paper: BOOK_PERF, live: BOOK_PERF }),
    refused_ops: z.number().describe("Refusals in the window; they filled nothing in either book"),
    books_note: z.string(),
    observed_at: z.string(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  budget: PERF_BUDGET,
  async handler({ agent, period }, ctx) {
    const { a, now, v } = await performanceData(ctx, agent, period);
    const live = perfOut(v.live);
    const paper = perfOut(v.paper);
    const line = (p: typeof live) => (p.change_usdg === null ? `${p.book}: no valuation in the window` : `${p.book}: ${p.change_usdg >= 0 ? "+" : ""}${p.change_usdg.toFixed(2)} USDG`);
    return {
      data: {
        agent: a.slug,
        period,
        window_start: iso(v.window.since),
        window_end: iso(v.window.until),
        run_epoch: v.window.run_epoch,
        books: { paper, live },
        refused_ops: v.refused_ops,
        books_note: BOOKS_NOTE,
        observed_at: iso(now),
      },
      summary: `${a.slug}, ${period}: ${line(live)}; ${line(paper)} (separate books).`,
    };
  },
});

const COMPARE_ROW = z.object({
  book: BOOK,
  money: MONEY_OF,
  valued_in_window: z.boolean(),
  start_equity_usdg: z.number().nullable(),
  end_equity_usdg: z.number().nullable(),
  change_usdg: z.number().nullable(),
  change_excluding_flows_usdg: z.number().nullable(),
  return_pct: z.number().nullable(),
  max_drawdown_pct: z.number().nullable(),
  realized_pnl_usdg: z.number().nullable(),
  fees_accrued_usdg: z.number().nullable(),
  gas_usdg: z.number().nullable(),
  fills: z.number().describe("confirmed on-chain operations (live) or paper fills (paper)"),
  failed_or_refused: z.number(),
  caveats: z.array(z.string()),
});

function compareRow(p: BookPerformance): z.infer<typeof COMPARE_ROW> {
  return {
    book: p.book,
    money: moneyOf(p.book),
    valued_in_window: p.valued_in_window,
    start_equity_usdg: p.start?.equity_usdg ?? null,
    end_equity_usdg: p.end?.equity_usdg ?? null,
    change_usdg: p.change_usdg,
    change_excluding_flows_usdg: p.change_excluding_flows_usdg,
    return_pct: p.return_pct,
    max_drawdown_pct: p.max_drawdown_pct,
    realized_pnl_usdg: p.realized_pnl_usdg,
    fees_accrued_usdg: p.fees_accrued_usdg,
    gas_usdg: p.gas_usdg,
    fills: p.book === "live" ? p.ops.confirmed : p.ops.paper_fills,
    failed_or_refused: p.book === "live" ? p.ops.failed : p.ops.paper_refused,
    caveats: p.caveats,
  };
}

const COMPARE_STATEMENT = "Paper and live are different books: paper is simulated money filled at recorded prices with no gas, fees or real slippage; live is real funds on chain. Their dollar figures are not comparable as money and must never be added or netted. Percentages describe each book on its own; a paper result is not a forecast of live results.";

const comparePaperLive = defineTool({
  name: "compare_paper_live",
  title: "Paper vs live",
  description: "Side-by-side statistics for the paper (simulated) and live (real funds) books over the same period, from the same computations as get_performance, with an explicit statement that they are different books and not comparable as money.",
  capability: "portfolio.read",
  input: z.object({ agent: AGENT_ARG, period: PERIOD }).strict(),
  output: z.object({
    agent: z.string(),
    period: z.enum(["day", "week", "month", "run"]),
    window_start: z.string(),
    window_end: z.string(),
    statement: z.string(),
    paper: COMPARE_ROW,
    live: COMPARE_ROW,
    observed_at: z.string(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  budget: PERF_BUDGET,
  async handler({ agent, period }, ctx) {
    const { a, now, v } = await performanceData(ctx, agent, period);
    const pct = (x: number | null) => (x === null ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`);
    return {
      data: {
        agent: a.slug,
        period,
        window_start: iso(v.window.since),
        window_end: iso(v.window.until),
        statement: COMPARE_STATEMENT,
        paper: compareRow(v.paper),
        live: compareRow(v.live),
        observed_at: iso(now),
      },
      summary: `${a.slug}, ${period}: live ${pct(v.live.return_pct)}, paper ${pct(v.paper.return_pct)} (different books, not comparable as money).`,
    };
  },
});

// ── get_exposure ────────────────────────────────────────────────────────────

const EXPOSURE_AGENTS_MAX = 20;

const BOOK_EXPOSURE = z.object({
  book: BOOK,
  money: MONEY_OF,
  agents_valued: z.array(z.string()),
  agents_holdings_listed: z.array(z.string()),
  total_equity_usdg: z.number().nullable(),
  exposures: z.array(z.object({
    token: z.string(),
    symbol: z.string().nullable().describe("untrusted"),
    value_usdg: z.number().nullable(),
    value_incomplete: z.boolean().describe("Some holders' values are unknown and are not in value_usdg"),
    valued_at: z.enum(["mark", "cost", "mixed"]),
    share_of_equity_pct: z.number().nullable(),
    price_stale: z.boolean(),
    agents: z.array(z.string()),
  })),
});

const getExposure = defineTool({
  name: "get_exposure",
  title: "Exposure across agents",
  description: "Combined exposure across every agent this connection can see, grouped by token within each book (paper and live never mixed), with each token's share of that book's equity.",
  capability: "portfolio.read",
  input: z.object({}).strict(),
  output: z.object({
    agents: z.array(z.object({ agent: z.string(), current_book: BOOK.nullable(), latest_valuation_time: z.string().nullable() })),
    books: z.object({ paper: BOOK_EXPOSURE, live: BOOK_EXPOSURE }),
    notes: z.array(z.string()),
    warnings: z.array(z.string()),
    observed_at: z.string(),
    untrusted_note: z.string(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  budget: { perMinute: 20 },
  async handler(_args, ctx) {
    const all = await ctx.agents();
    const agents = all.slice(0, EXPOSURE_AGENTS_MAX);
    const now = ctx.now();
    const fresh = await freshSec(ctx);
    const views = await ctx.ledger(async (db) => {
      const out: Array<{ agent: string; view: PortfolioView }> = [];
      for (const a of agents) out.push({ agent: a.slug, view: await readPortfolio(db, scopeOf(a), { now, freshWithinSec: fresh }) });
      return out;
    });
    const grouped = groupExposure(views);
    const warnings = views.flatMap(({ agent, view }) => view.warnings.map((w) => `${agent}: ${w}`));
    if (all.length > agents.length) warnings.unshift(`Only the first ${EXPOSURE_AGENTS_MAX} of ${all.length} agents are included.`);
    for (const b of ["paper", "live"] as const) {
      const unlisted = grouped[b].agents_valued.filter((s) => !grouped[b].agents_holdings_listed.includes(s));
      if (unlisted.length) warnings.push(`${b} book: the holdings of ${unlisted.join(", ")} are not listed (their newest valuation is of the other book), so ${b} shares understate their exposure.`);
    }
    const bookOf = (b: Book) => ({
      ...grouped[b],
      money: moneyOf(b),
      exposures: grouped[b].exposures.map((e) => ({ ...e, symbol: untrusted(e.symbol, 32) })),
    });
    const newestAt = (v: PortfolioView) => {
      const at = Math.max(v.paper.mark?.at ?? 0, v.live.mark?.at ?? 0);
      return at > 0 ? iso(at) : null;
    };
    return {
      data: {
        agents: views.map(({ agent, view }) => ({ agent, current_book: view.current_book, latest_valuation_time: newestAt(view) })),
        books: { paper: bookOf("paper"), live: bookOf("live") },
        notes: [
          BOOKS_NOTE,
          "Each agent's holdings count in the book it valued most recently (the positions table holds one book at a time); class-vault launch tokens count in the live book at cost.",
          "Shares divide by the same book's latest equity summed over the agents valued in it.",
        ],
        warnings,
        observed_at: iso(now),
        untrusted_note: UNTRUSTED_NOTE,
      },
      summary: views.length ? `Exposure across ${views.length} agent(s): ${grouped.live.exposures.length} live and ${grouped.paper.exposures.length} paper token(s).` : "No agent is shared with this connection.",
    };
  },
});

export const PORTFOLIO_TOOLS = [getPortfolio, getTrades, getTrade, getPerformance, comparePaperLive, getExposure];

// ── resource ────────────────────────────────────────────────────────────────

export const PORTFOLIO_RESOURCES: ResourceDef[] = [
  {
    name: "agent_portfolio",
    title: "Agent portfolio",
    description: "The agent's balances and holdings per book (paper and live separately), as get_portfolio returns them.",
    mimeType: "application/json",
    capability: "portfolio.read",
    uri: "merrymen://agents/{agent}/portfolio",
    async list(ctx) {
      const agents = await ctx.agents();
      return agents.map((a) => ({
        uri: `merrymen://agents/${a.slug}/portfolio`,
        name: `portfolio-${a.slug}`,
        title: `Portfolio of agent ${a.slug}`,
        mimeType: "application/json",
      }));
    },
    async read(_uri, vars, ctx) {
      const data = await portfolioData(ctx, vars.agent ?? "");
      // Same contract as the tool: an undeclared shape is a server bug, not an answer.
      const checked = PORTFOLIO_OUTPUT.safeParse(data);
      if (!checked.success) throw new McpError("internal");
      return { mimeType: "application/json", text: JSON.stringify(checked.data) };
    },
  },
];
