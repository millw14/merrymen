/**
 * An owner's portfolio, trades and performance, as the shared ledger recorded
 * them — one BOOK at a time.
 *
 * TWO BOOKS, NEVER ONE. An agent keeps a paper book (simulated money) and a
 * live book (real funds) under the same account, and each table separates them
 * its own way: `equity.mode`, `cost_basis.mode`, `trades.status` ('paper' vs
 * 'landed'), and `positions`, which has no mode at all and holds whichever book
 * the worker valued last. So every figure here carries its book, and nothing
 * is summed across the two: a paper gain added to a live loss is a number
 * about no money that exists.
 *
 * UNKNOWN IS NULL. A holding with no usable price, a cost nobody recorded, a
 * sell whose cost the ledger cannot vouch for: each comes back null with a
 * warning. Zero would say "free", "flat" or "worthless", and every one of those
 * is a claim the ledger cannot support.
 *
 * SCOPED BY THE AGENT'S OWN ACCOUNTS. Every read takes the agent's smart
 * accounts (current and historical, from the identity store, never from a
 * caller) and compares lower(agent_id) against them, because the ledger does
 * not normalise the spelling of an address.
 *
 * Reuses the rules the web already publishes by rather than restating them:
 * basisUsdg (cost is micro-USDG text), readCostFromQuote and readEvidencedSells
 * (whether a cost or a realized figure is a measurement), distinctTrades (one
 * row per operation), growthIndex/drawdownBps (flows divided out before a
 * drawdown), the worker's attributeBook (change no record explains),
 * rejectRuleLabel/Remedy, activeClassPositions and explorerFor.
 *
 * Read-only, no network, no MCP imports: the app can serve the same views.
 */
import { explorerFor, isEvidencedFlow } from "@merrymen/core";
import type { Db } from "../../../../worker/src/db";
import { activeClassPositions } from "../../../../worker/src/class-active";
import { attributeBook, breakGap, type BookFlow, type BookMark } from "../../../../worker/src/period-pnl";
import { rejectRuleLabel, rejectRuleRemedy } from "../../../../worker/src/thesis-policy";
import { basisUsdg } from "../basis-usdg";
import { readCostFromQuote } from "../desk-positions";
import { distinctTrades, OP_COPY_REACH_SEC } from "../distinct-trades";
import { drawdownBps, growthIndex } from "../growth-index";
import { OP_KEY, readEvidencedSells } from "../profile-trades";
import { readAgentRow } from "./agent-status";

export type Book = "paper" | "live";
export const BOOKS: readonly Book[] = ["paper", "live"];

const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SLUG = /^[a-z][a-z0-9-]{0,39}$/;

/** A cash or equity difference smaller than this is rounding, not money. */
export const MONEY_TOLERANCE_USDG = 0.01;

/** Where a held token sits. The ledger cannot say more than this (see the positions note). */
export const ACCOUNT_CUSTODY = "smart account (Trencher-vault holdings are merged in and not distinguished)";

export const REMAINDER_EXPLAINED =
  "equity − (cash + savings + positions): USDG held inside the agent's class or Trencher vaults, plus holdings the worker carries at cost because they have no price feed (class-vault tokens always are). The valuation row records the total but not these parts.";

/** The agent's accounts, as the only agent_ids any read here may touch. */
export interface LedgerScope {
  /** Every smart account the agent has held, lowercased, current first. */
  accounts: string[];
  /** The account the agent runs on now (its agents row and run epoch), or null before any. */
  current: string | null;
  chainId: number;
}

export function ledgerScope(accounts: readonly string[], current: string | null, chainId: number | null): LedgerScope {
  const cur = current && ADDRESS.test(current.toLowerCase()) ? current.toLowerCase() : null;
  const list = [...new Set([...(cur ? [cur] : []), ...accounts.map((a) => a.toLowerCase()).filter((a) => ADDRESS.test(a))])].slice(0, 16);
  return { accounts: list, current: cur ?? list[0] ?? null, chainId: chainId === 46630 ? 46630 : 4663 };
}

const qs = (n: number) => Array.from({ length: n }, () => "?").join(", ");

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** USDG to the micro, the ledger's own precision; never invents digits. */
function money(v: number | null): number | null {
  return v === null || !Number.isFinite(v) ? null : Math.round(v * 1e6) / 1e6;
}

function pct(v: number | null): number | null {
  return v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function addr(v: unknown): string | null {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  return ADDRESS.test(s) ? s : null;
}

function hash(v: unknown): string | null {
  return typeof v === "string" && HASH.test(v) ? v.toLowerCase() : null;
}

/**
 * A token column as an address, or a bounded plain label when the row holds
 * something else. Never raw text of any length or alphabet: it is echoed in
 * warnings as well as in the field.
 */
function tokenOf(v: unknown): string {
  const a = addr(v);
  if (a) return a;
  const s = typeof v === "string" ? v.trim() : "";
  return /^[A-Za-z0-9._:-]{1,42}$/.test(s) ? s : "unknown";
}

/** The heartbeat's mode as one of the words the worker writes; anything else is "unknown", never echoed. */
function modeWord(v: unknown): "paper" | "live" | "idle" | "unknown" | null {
  if (v === null || v === undefined) return null;
  return v === "paper" || v === "live" || v === "idle" ? v : "unknown";
}

/**
 * SQL for "landed with a transaction hash": the same test statusOf applies in
 * code (a 0x-prefixed 32-byte hash), so a filter or a count of confirmed
 * operations can never include a row the list shows as landed_without_tx_hash.
 */
const CONFIRMED_SQL = "t.status = 'landed' AND t.tx_hash LIKE '0x%' AND length(t.tx_hash) = 66";
/** Its complement among landed rows, NULL-safe (a NOT over a NULL hash would count nothing). */
const LANDED_NO_HASH_SQL = "t.status = 'landed' AND (t.tx_hash IS NULL OR NOT (t.tx_hash LIKE '0x%' AND length(t.tx_hash) = 66))";

/**
 * A redeploy's re-recorded copy of an operation (worker token-label.ts
 * isRestartCopy; chat-tools NOT_A_COPY): a bare 'swap' aimed at the account
 * itself, with no decision and no fill side, stamped at the restart. It is not
 * a trade in the step it is stamped in, so it must not excuse that step's cash.
 */
const NOT_A_RESTART_COPY = "NOT (kind = 'swap' AND target IS NOT NULL AND lower(target) = lower(agent_id) AND decision_id IS NULL AND fill_side IS NULL)";

export function txUrl(chainId: number, tx: string | null): string | null {
  return tx ? `${explorerFor(chainId)}/tx/${tx}` : null;
}

const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

/**
 * The ledger's spellings of one account in `trades`.
 *
 * The evidence replays (readCostFromQuote, readEvidencedSells) match
 * `agent_id = ?` exactly, so they must be handed the spelling the rows carry.
 * An account written under two spellings would replay as two partial tapes,
 * and a partial replay can vouch for what it never saw, so that case vouches
 * for nothing (null).
 */
export async function readTradeSpelling(db: Db, account: string): Promise<string | null | "none"> {
  // Only the rows a replay reads count (fills: landed or paper). A refusal or
  // an in-flight row under another spelling adds nothing to the tape; when an
  // in-flight row lands it keeps its spelling and is counted from then on.
  const rows = (await db.prepare("SELECT DISTINCT agent_id FROM trades WHERE lower(agent_id) = ? AND status IN ('landed', 'paper') LIMIT 3").all(account)) as { agent_id: string }[];
  if (rows.length === 0) return "none";
  return rows.length === 1 ? String(rows[0]!.agent_id) : null;
}

/** One lookup per account per call: the answer cannot change within a read. */
type Spellings = Map<string, Promise<string | null | "none">>;

function tradeSpelling(db: Db, account: string, cache: Spellings): Promise<string | null | "none"> {
  let hit = cache.get(account);
  if (!hit) {
    hit = readTradeSpelling(db, account);
    cache.set(account, hit);
  }
  return hit;
}

// ── portfolio ───────────────────────────────────────────────────────────────

export interface MarkView {
  account: string;
  at: number;
  epoch: number | null;
  mode: Book | null;
  cash_usdg: number | null;
  savings_usdg: number | null;
  positions_usdg: number | null;
  equity_usdg: number | null;
  /** equity − (cash + savings + positions); see REMAINDER_EXPLAINED. */
  other_usdg: number | null;
  eth_wei: string | null;
  eth: number | null;
}

export interface PositionView {
  token: string;
  /** Written by the token's creator or derived by the worker: untrusted text. */
  symbol: string | null;
  raw_balance: string;
  price_usd: number | null;
  price_stale: boolean;
  price_source: string;
  value_usdg: number | null;
  updated_at: number | null;
  cost_usdg: number | null;
  /** True when a fill booked from a pre-trade quote is still in the cost; null when that could not be checked. */
  cost_includes_quote_estimate: boolean | null;
  unrealized_pnl_usdg: number | null;
  unrealized_pnl_pct: number | null;
  pnl_missing_why: string | null;
  custody: string;
}

export interface ClassHoldingView {
  token: string;
  symbol: string | null;
  state: "open" | "recovered";
  qty_raw: string | null;
  decimals: number | null;
  cost_usdg: number | null;
  vault: string | null;
  entry_tx: string | null;
  entry_tx_url: string | null;
  opened_at: number | null;
}

export interface BookTotals {
  positions_value_usdg: number | null;
  cost_usdg: number | null;
  unrealized_pnl_usdg: number | null;
  holdings_without_pnl: number;
}

export interface BookPortfolio {
  book: Book;
  mark: MarkView | null;
  /** True when the positions table currently holds this book's holdings. */
  positions_held_here: boolean;
  positions: PositionView[] | null;
  class_vault_positions: ClassHoldingView[];
  totals: BookTotals;
}

export interface PortfolioView {
  /** The worker's last heartbeat mode: paper, live or idle ("unknown" for any other value). */
  agent_mode: "paper" | "live" | "idle" | "unknown" | null;
  /** The book of the newest valuation of any book. */
  latest_valuation_book: Book | null;
  current_book: Book | null;
  current_book_why: string;
  books_agree: boolean | null;
  paper: BookPortfolio;
  live: BookPortfolio;
  warnings: string[];
}

const MARK_COLS = "agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, epoch, mode, at";

function markOf(r: Record<string, unknown> | undefined): MarkView | null {
  if (!r) return null;
  const cash = num(r.cash_usdg);
  const savings = num(r.vault_usdg);
  const positions = num(r.positions_usdg);
  const equity = num(r.equity_usdg);
  let wei: bigint | null = null;
  try {
    wei = typeof r.eth_wei === "string" && /^\d{1,40}$/.test(r.eth_wei) ? BigInt(r.eth_wei) : null;
  } catch {
    wei = null;
  }
  return {
    account: String(r.agent_id).toLowerCase(),
    at: Number(r.at),
    epoch: num(r.epoch),
    mode: r.mode === "paper" || r.mode === "live" ? r.mode : null,
    cash_usdg: money(cash),
    savings_usdg: money(savings),
    positions_usdg: money(positions),
    equity_usdg: money(equity),
    other_usdg: cash === null || savings === null || positions === null || equity === null ? null : money(equity - cash - savings - positions),
    eth_wei: wei === null ? null : wei.toString(),
    eth: wei === null ? null : Math.round(Number(wei) / 1e12) / 1e6,
  };
}

/** The newest valuation of one book (or of any book, with null). */
export async function readLatestMark(db: Db, scope: LedgerScope, book: Book | null): Promise<MarkView | null> {
  if (!scope.accounts.length) return null;
  const row = (await db
    .prepare(`SELECT ${MARK_COLS} FROM equity WHERE lower(agent_id) IN (${qs(scope.accounts.length)})${book ? " AND mode = ?" : ""}
      ORDER BY at DESC, id DESC LIMIT 1`)
    .get(...scope.accounts, ...(book ? [book] : []))) as Record<string, unknown> | undefined;
  return markOf(row);
}

/** The most holdings one book shows; a real book is a handful. */
const POSITIONS_LIMIT = 200;

async function readBookPositions(db: Db, scope: LedgerScope, holder: string, book: Book, warnings: string[], spellings: Spellings): Promise<PositionView[]> {
  // `holder` is the account that wrote the newest valuation, itself read under
  // this scope, so it is one of the agent's own accounts.
  const rows = (await db
    .prepare(`SELECT p.agent_id AS agent_id, p.symbol AS symbol, p.token AS token, p.raw_balance AS raw_balance,
              p.price_usd AS price_usd, p.price_stale AS price_stale, p.price_source AS price_source,
              p.value_usdg AS value_usdg, p.updated_at AS updated_at, b.cost_usdg AS cost_usdg
         FROM positions p
         LEFT JOIN cost_basis b ON b.agent_id = p.agent_id AND b.symbol = p.symbol AND b.mode = ?
        WHERE lower(p.agent_id) = ?
        ORDER BY p.value_usdg DESC LIMIT ${POSITIONS_LIMIT + 1}`)
    .all(book, holder)) as Record<string, unknown>[];
  if (rows.length > POSITIONS_LIMIT) warnings.push(`Only the ${POSITIONS_LIMIT} largest holdings are listed.`);
  const mine = rows.slice(0, POSITIONS_LIMIT);
  const others = scope.accounts.filter((a) => a !== holder);
  if (others.length) {
    const left = (await db
      .prepare(`SELECT COUNT(*) AS n FROM positions WHERE lower(agent_id) IN (${qs(others.length)})`)
      .get(...others)) as { n: number } | undefined;
    const n = Number(left?.n ?? 0);
    if (n > 0) warnings.push(`${n} position row(s) recorded under another smart account of this agent are not shown: that account did not write the latest valuation, so they are not holdings as of it.`);
  }
  // Whether each cost still carries a quote-booked fill, replayed the way the
  // desk replays it. Unreadable or ambiguous vouches for nothing (null).
  let quote: Map<string, boolean | null> | null = null;
  try {
    const spelling = await tradeSpelling(db, holder, spellings);
    const tokens = mine.map((r) => addr(r.token)).filter((t): t is string => !!t);
    if (spelling === "none") quote = new Map(tokens.map((t) => [t, false]));
    else if (spelling !== null) quote = await readCostFromQuote(db, spelling, book, tokens);
  } catch {
    quote = null;
  }
  return mine.map((r) => {
    const token = tokenOf(r.token);
    const stale = Number(r.price_stale ?? 0) === 1;
    const rawPrice = num(r.price_usd);
    const price = rawPrice !== null && rawPrice > 0 ? rawPrice : null;
    // A zero price with a zero value is a missing price, not a worthless coin.
    const value = price === null ? null : num(r.value_usdg);
    const cost = basisUsdg(r.cost_usdg);
    const q = cost === null ? null : quote?.get(token) ?? null;
    let why: string | null = null;
    if (price === null) why = "no usable price was recorded for this holding";
    else if (stale) why = "the price is stale (its feed had not updated recently), so an unrealized figure would describe an old market";
    else if (cost === null) why = "no cost basis is on record for this holding in this book";
    const pnl = why === null && value !== null && cost !== null ? value - cost : null;
    return {
      token,
      symbol: str(r.symbol),
      raw_balance: String(r.raw_balance ?? ""),
      price_usd: price,
      price_stale: stale,
      price_source: typeof r.price_source === "string" && SLUG.test(r.price_source) ? r.price_source : "unknown",
      value_usdg: money(value),
      updated_at: num(r.updated_at),
      cost_usdg: money(cost),
      cost_includes_quote_estimate: q,
      unrealized_pnl_usdg: money(pnl),
      unrealized_pnl_pct: pnl !== null && cost !== null && cost > 0 ? pct((pnl / cost) * 100) : null,
      pnl_missing_why: why,
      custody: ACCOUNT_CUSTODY,
    };
  });
}

/**
 * Class-vault holdings the agent is still in (open, or recovered with an
 * unknown basis). Launch tokens in the class vault never reach `positions`:
 * the worker carries them at cost, so this is the only place they show.
 */
/** The most class-vault holdings one read lists; a real book is a handful. */
const CLASS_HOLDINGS_LIMIT = 200;

async function readClassHoldings(db: Db, scope: LedgerScope, warnings: string[]): Promise<ClassHoldingView[]> {
  if (!scope.accounts.length) return [];
  // The standing states are filtered IN SQL, before the limit: class_positions
  // keeps every token the vault ever held, so a limit over all states would let
  // a long tail of closed round trips push a position still held off the list.
  const rows = (await db
    .prepare(`SELECT agent_id, token, symbol, decimals, quote_token, vault, entry_tx, cost_usdg, qty_raw, state, first_seen
         FROM class_positions WHERE lower(agent_id) IN (${qs(scope.accounts.length)}) AND state IN ('open', 'recovered')
        ORDER BY first_seen DESC LIMIT ${CLASS_HOLDINGS_LIMIT + 1}`)
    .all(...scope.accounts)) as Record<string, unknown>[];
  if (rows.length > CLASS_HOLDINGS_LIMIT) warnings.push(`Only the ${CLASS_HOLDINGS_LIMIT} newest class-vault holdings are listed.`);
  const shaped = rows.slice(0, CLASS_HOLDINGS_LIMIT).map((r) => ({ row: r, token: String(r.token ?? ""), quoteToken: str(r.quote_token), state: str(r.state) }));
  return activeClassPositions(shaped).map(({ row, state }) => {
    const entry = hash(row.entry_tx);
    const recovered = state === "recovered";
    return {
      token: tokenOf(row.token),
      symbol: str(row.symbol),
      state: recovered ? "recovered" : "open",
      qty_raw: typeof row.qty_raw === "string" && /^\d{1,80}$/.test(row.qty_raw) ? row.qty_raw : null,
      decimals: num(row.decimals),
      // A recovered balance has an UNKNOWN basis (class_positions schema note);
      // publishing whatever cost field it carries would book its exit as profit.
      cost_usdg: recovered ? null : money(basisUsdg(row.cost_usdg)),
      vault: addr(row.vault),
      entry_tx: entry,
      entry_tx_url: txUrl(scope.chainId, entry),
      opened_at: num(row.first_seen),
    };
  });
}

function totalsOf(positions: PositionView[] | null): BookTotals {
  if (!positions) return { positions_value_usdg: null, cost_usdg: null, unrealized_pnl_usdg: null, holdings_without_pnl: 0 };
  const values = positions.map((p) => p.value_usdg);
  const costs = positions.map((p) => p.cost_usdg);
  const pnls = positions.map((p) => p.unrealized_pnl_usdg).filter((v): v is number => v !== null);
  return {
    positions_value_usdg: values.some((v) => v === null) ? null : money(values.reduce<number>((s, v) => s + (v ?? 0), 0)),
    cost_usdg: costs.some((v) => v === null) ? null : money(costs.reduce<number>((s, v) => s + (v ?? 0), 0)),
    unrealized_pnl_usdg: pnls.length ? money(pnls.reduce((s, v) => s + v, 0)) : null,
    holdings_without_pnl: positions.length - pnls.length,
  };
}

function iso(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

/**
 * The agent's holdings and latest valuation, per book.
 *
 * WHICH BOOK THE POSITIONS BELONG TO. `positions` has no mode: the worker
 * rewrites it on every valued tick from the book it just valued. So it is
 * attached to the book of the newest valuation, under the account that wrote
 * that valuation, and the other book says it has no position list here —
 * rather than borrowing one that is not its own.
 */
export async function readPortfolio(db: Db, scope: LedgerScope, o: { now: number; freshWithinSec: number }): Promise<PortfolioView> {
  const warnings: string[] = [];
  const emptyBook = (book: Book): BookPortfolio => ({
    book, mark: null, positions_held_here: false, positions: null, class_vault_positions: [], totals: totalsOf(null),
  });
  if (!scope.accounts.length) {
    return {
      agent_mode: null, latest_valuation_book: null, current_book: null,
      current_book_why: "No trading permission has been signed yet, so there is no account and nothing has been valued.",
      books_agree: null, paper: emptyBook("paper"), live: emptyBook("live"),
      warnings: ["No smart account exists for this agent yet."],
    };
  }
  const row = scope.current ? await readAgentRow(db, scope.current) : null;
  const agentMode = modeWord(row?.mode);
  const newest = await readLatestMark(db, scope, null);
  const marks: Record<Book, MarkView | null> = { paper: await readLatestMark(db, scope, "paper"), live: await readLatestMark(db, scope, "live") };
  const latestBook = newest?.mode ?? null;

  const books: Record<Book, BookPortfolio> = { paper: emptyBook("paper"), live: emptyBook("live") };
  for (const b of BOOKS) books[b].mark = marks[b];

  if (!newest) {
    warnings.push("This agent has no valuation on record yet, so there are no balances or holdings to report.");
  } else if (!latestBook) {
    warnings.push("The newest valuation was written before valuations carried a book label, so its holdings are not attributed to either book.");
  } else {
    books[latestBook].positions_held_here = true;
    books[latestBook].positions = await readBookPositions(db, scope, newest.account, latestBook, warnings, new Map());
  }
  books.live.class_vault_positions = await readClassHoldings(db, scope, warnings);

  const heartbeatBook: Book | null = agentMode === "paper" || agentMode === "live" ? agentMode : null;
  const current = latestBook ?? heartbeatBook;
  for (const b of BOOKS) {
    const m = marks[b];
    const label = b === "paper" ? "Paper" : "Live";
    books[b].totals = totalsOf(books[b].positions);
    if (!m) continue;
    const age = o.now - m.at;
    // Only the running book is expected to be fresh; the other one's age is
    // simply when it was last used, and its valuation_time says so.
    if (b === current && age > o.freshWithinSec) warnings.push(`${label} book: the latest valuation is ${Math.round(age / 60)} min old, older than the worker's freshness window (${Math.round(o.freshWithinSec / 60)} min).`);
    if (m.other_usdg !== null && m.other_usdg > MONEY_TOLERANCE_USDG) {
      warnings.push(`${label} book: equity is ${m.other_usdg.toFixed(2)} USDG above cash + savings + positions. That is vault-held USDG and holdings carried at cost; the valuation row does not break it down.`);
    } else if (m.other_usdg !== null && m.other_usdg < -MONEY_TOLERANCE_USDG) {
      warnings.push(`${label} book: cash + savings + positions exceed the recorded equity by ${(-m.other_usdg).toFixed(2)} USDG; the valuation row is internally inconsistent.`);
    }
    if (m.eth === null) warnings.push(`${label} book: the gas (ETH) balance on the valuation could not be read.`);
    const held = books[b].positions;
    if (held) {
      for (const p of held) {
        if (p.price_usd === null) warnings.push(`${label} book: a holding (${p.token}) has no usable price; its value is unknown, not zero.`);
        else if (p.price_stale) warnings.push(`${label} book: the price of a holding (${p.token}) is stale; its value uses the last price the worker read.`);
        if (p.cost_usdg === null) warnings.push(`${label} book: a holding (${p.token}) has no recorded cost, so its unrealized P&L is unknown.`);
      }
      const listed = books[b].totals.positions_value_usdg;
      if (listed !== null && m.positions_usdg !== null && Math.abs(listed - m.positions_usdg) > MONEY_TOLERANCE_USDG) {
        warnings.push(`${label} book: the holdings listed (${listed.toFixed(2)} USDG) differ from the positions figure on the valuation (${m.positions_usdg.toFixed(2)} USDG); they were written on different ticks.`);
      }
    }
  }
  for (const c of books.live.class_vault_positions) {
    if (c.cost_usdg === null) warnings.push(`Live book: a class-vault holding (${c.token}) has an unknown cost basis, so its value is unknown.`);
  }

  const agree = heartbeatBook && latestBook ? heartbeatBook === latestBook : null;
  let why: string;
  if (latestBook) {
    why = `The newest valuation is of the ${latestBook} book (${iso(newest!.at)}), so that is the book the worker is running.`;
    if (agree === false) {
      why += ` The worker's last heartbeat says ${agentMode}: it has switched books since, and the ${heartbeatBook} book has not been valued yet.`;
      warnings.push(`The worker's heartbeat says ${agentMode} but the newest valuation is of the ${latestBook} book; figures follow the valuation.`);
    }
    if (agentMode === "idle") why += " Its last heartbeat says idle: running, but not placing trades.";
  } else if (heartbeatBook) {
    why = `No labelled valuation yet; the worker's last heartbeat says ${heartbeatBook}.`;
  } else {
    why = "Neither a labelled valuation nor a paper/live heartbeat is on record, so the current book is unknown.";
  }
  return {
    agent_mode: agentMode,
    latest_valuation_book: latestBook,
    current_book: current,
    current_book_why: why,
    books_agree: agree,
    paper: books.paper,
    live: books.live,
    warnings: [...new Set(warnings)],
  };
}

// ── trades ──────────────────────────────────────────────────────────────────

export type TradeStatus = "confirmed" | "landed_without_tx_hash" | "submitted" | "failed" | "refused" | "paper_fill" | "unknown";
export type TradeBookLabel = Book | "none";

export interface RuleView {
  code: string;
  label: string | null;
  remedy: string | null;
}

export interface TradeView {
  id: string;
  account: string;
  at: number;
  book: TradeBookLabel;
  kind: string;
  side: "buy" | "sell" | "swap" | null;
  token: string | null;
  /** Untrusted: the fill's own symbol, else the decision's. */
  symbol: string | null;
  /** Untrusted: the coin's self-chosen name, from the decision. */
  display_name: string | null;
  amount_usdg: number | null;
  fill_qty_raw: string | null;
  fill_price_usd: number | null;
  fill_cash_usdg: number | null;
  realized_pnl_usdg: number | null;
  realized_pnl_measured: boolean | null;
  basis_source: "receipt" | "paper" | "quote" | null;
  gas_usdg: number | null;
  gas_unpriced: boolean;
  gas_sponsored: boolean;
  status: TradeStatus;
  ledger_status: string;
  rule: RuleView | null;
  tx_hash: string | null;
  explorer_url: string | null;
  user_op_hash: string | null;
  decision_id: string | null;
}

/**
 * The rule behind a refusal or a classified revert, without the free text.
 *
 * Most rules are slugs. Some rows carry prose after a prefix — `couldn't
 * submit: <raw error>`, `preflight: <why>`, `paper: …`, `review: …` — and that
 * prose can be a provider's raw error, URL included. Only the category leaves.
 */
export function ruleOf(raw: unknown): RuleView | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.trim();
  let code: string;
  if (SLUG.test(s)) code = s;
  else if (/^couldn'?t submit/i.test(s)) code = "submit-failed";
  else if (/^preflight:/i.test(s)) code = "preflight";
  else if (/^paper:/i.test(s)) code = "paper-refused";
  else if (/^review:/i.test(s)) code = "review-refused";
  else if (/^fence-[a-z-]{1,30}/.test(s)) code = s.match(/^fence-[a-z-]{1,30}/)![0];
  else code = "other";
  const fallback: Record<string, string> = {
    "submit-failed": "the operation could not be submitted to the chain",
    preflight: "the decision was not actionable when checked before signing",
    "paper-refused": "the simulated (paper) fill was refused",
    "review-refused": "the order review refused it",
  };
  return { code, label: rejectRuleLabel(code) ?? fallback[code] ?? null, remedy: rejectRuleRemedy(code) };
}

export function statusOf(ledger: string, tx: string | null): TradeStatus {
  switch (ledger) {
    case "landed": return tx ? "confirmed" : "landed_without_tx_hash";
    case "submitted": return "submitted";
    case "reverted": return "failed";
    case "rejected": return "refused";
    case "paper": return "paper_fill";
    default: return "unknown";
  }
}

function bookOfRow(ledger: string, rule: unknown): TradeBookLabel {
  if (ledger === "paper") return "paper";
  if (ledger === "landed" || ledger === "submitted" || ledger === "reverted") return "live";
  // A refusal filled nothing in either book; only a refused PAPER fill says which.
  // The same prefix test the SQL filters and counts use (LIKE 'paper:%'), so a
  // row is never listed under one book and counted under another.
  if (ledger === "rejected" && typeof rule === "string" && rule.startsWith("paper:")) return "paper";
  return "none";
}

const TRADE_COLS = `t.id, t.agent_id, t.kind, t.sell_token, t.buy_token, t.amount_usdg, t.user_op_hash, t.tx_hash, t.status,
  t.reject_rule, t.decision_id, t.fill_side, COALESCE(t.fill_symbol, d.symbol) AS symbol, d.display_name AS display_name,
  d.action AS action, t.fill_qty_raw, t.fill_price_usd, t.fill_cash_usdg, t.realized_pnl_usdg, t.basis_source, t.gas_wei,
  t.sponsored_gas_wei, t.gas_usdg, t.created_at, ${OP_KEY} AS op_key`;
/** Never signals_json: that column is the owner's whole balance sheet at decision time. */
const DECISION_JOIN = "LEFT JOIN decisions d ON d.id = t.decision_id AND LOWER(d.agent_id) = LOWER(t.agent_id)";

function tradeOf(r: Record<string, unknown>, chainId: number): TradeView & { op_key: string } {
  const ledger = String(r.status ?? "");
  const tx = hash(r.tx_hash);
  const buy = addr(r.buy_token);
  const sell = addr(r.sell_token);
  const recorded = r.fill_side === "buy" || r.fill_side === "sell" ? r.fill_side : r.action === "buy" || r.action === "sell" ? r.action : null;
  const kind = typeof r.kind === "string" && SLUG.test(r.kind) ? r.kind : "other";
  const tradeKind = kind === "swap" || kind === "curve-trade";
  // Old rows predate fill_side: the USDG leg says which way cash moved.
  const side: TradeView["side"] = recorded ?? (tradeKind && sell === USDG ? "buy" : tradeKind && buy === USDG ? "sell" : tradeKind && (buy || sell) ? "swap" : null);
  const token = side === "buy" ? buy : side === "sell" ? sell : buy && buy !== USDG ? buy : sell && sell !== USDG ? sell : buy ?? sell;
  const source = r.basis_source === "receipt" || r.basis_source === "paper" || r.basis_source === "quote" ? r.basis_source : null;
  const own = ledger === "paper" ? "paper" : ledger === "landed" ? "receipt" : null;
  // Realized only on a sell whose proceeds the book itself evidenced; a
  // quote-booked sell's figure is an estimate and is not published as one.
  const realized = side === "sell" && own !== null && source === own ? num(r.realized_pnl_usdg) : null;
  const gasWei = typeof r.gas_wei === "string" && r.gas_wei !== "" ? r.gas_wei : null;
  const sponsored = typeof r.sponsored_gas_wei === "string" && /^[1-9]\d*$/.test(r.sponsored_gas_wei);
  return {
    id: String(r.id),
    account: String(r.agent_id).toLowerCase(),
    at: Number(r.created_at),
    book: bookOfRow(ledger, r.reject_rule),
    kind,
    side,
    token,
    symbol: str(r.symbol),
    display_name: str(r.display_name),
    amount_usdg: money(num(r.amount_usdg)),
    fill_qty_raw: typeof r.fill_qty_raw === "string" && /^\d{1,80}$/.test(r.fill_qty_raw) ? r.fill_qty_raw : null,
    // A zero or negative fill price is a price nobody recorded, not a free coin.
    fill_price_usd: (() => { const p = num(r.fill_price_usd); return p !== null && p > 0 ? p : null; })(),
    fill_cash_usdg: money(num(r.fill_cash_usdg)),
    realized_pnl_usdg: money(realized),
    realized_pnl_measured: null,
    basis_source: source,
    gas_usdg: money(num(r.gas_usdg)),
    gas_unpriced: gasWei !== null && num(r.gas_usdg) === null,
    gas_sponsored: sponsored,
    status: statusOf(ledger, tx),
    ledger_status: SLUG.test(ledger) ? ledger : "unknown",
    rule: ledger === "rejected" || ledger === "reverted" ? ruleOf(r.reject_rule) : null,
    tx_hash: tx,
    explorer_url: txUrl(chainId, tx),
    user_op_hash: hash(r.user_op_hash),
    decision_id: typeof r.decision_id === "string" && SAFE_ID.test(r.decision_id) ? r.decision_id : null,
    op_key: String(r.op_key ?? ""),
  };
}

/**
 * Which realized figures are MEASUREMENTS: the sell's proceeds and the cost it
 * sold against both evidenced (profile-trades readEvidencedSells, the rule the
 * profile and the desk use). Unreplayable is null, never true.
 */
async function markMeasured(db: Db, trades: Array<TradeView & { op_key: string }>, spellings: Spellings = new Map()): Promise<void> {
  const groups = new Map<string, Array<TradeView & { op_key: string }>>();
  for (const t of trades) {
    if (t.realized_pnl_usdg === null || !t.token || t.book === "none") continue;
    const key = `${t.account}|${t.book}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  for (const [key, rows] of groups) {
    const [account, book] = key.split("|") as [string, Book];
    try {
      const spelling = await tradeSpelling(db, account, spellings);
      if (spelling === null || spelling === "none") continue;
      const vouched = await readEvidencedSells(db, spelling, book === "paper" ? "paper" : "landed", rows.map((t) => ({ op: t.op_key, token: t.token! })));
      for (const t of rows) t.realized_pnl_measured = vouched.has(t.op_key);
    } catch {
      /* unreplayable: stays null, which a reader must not print as measured */
    }
  }
}

export interface TradeFilter {
  book: Book | "all";
  status: "confirmed" | "submitted" | "failed" | "refused" | "paper" | "all";
  token: string | null;
  since: number | null;
}

export interface TradeCursor {
  at: number;
  id: number;
}

const STATUS_SQL: Record<Exclude<TradeFilter["status"], "all">, string> = {
  confirmed: CONFIRMED_SQL,
  submitted: "t.status = 'submitted'",
  failed: "t.status = 'reverted'",
  refused: "t.status = 'rejected'",
  paper: "t.status = 'paper'",
};
const BOOK_SQL: Record<Book, string> = {
  paper: "(t.status = 'paper' OR (t.status = 'rejected' AND t.reject_rule LIKE 'paper:%'))",
  live: "t.status IN ('landed','submitted','reverted')",
};

/**
 * One page of operations, newest first, keyed by (created_at, id).
 *
 * One row per OPERATION (distinctTrades): a redeploy's re-recorded copy of a
 * fill must not list as a second fill. The collapse is scoped by account (and
 * reaches OP_COPY_REACH_SEC before `since`), and every other filter applies
 * after it, as distinct-trades.ts requires.
 */
export async function readTradePage(
  db: Db,
  scope: LedgerScope,
  f: TradeFilter,
  cursor: TradeCursor | null,
  limit: number,
): Promise<{ trades: TradeView[]; next: TradeCursor | null }> {
  if (!scope.accounts.length) return { trades: [], next: null };
  const inner = [`lower(t.agent_id) IN (${qs(scope.accounts.length)})`];
  const innerArgs: unknown[] = [...scope.accounts];
  if (f.since !== null) {
    inner.push("t.created_at > ?");
    innerArgs.push(f.since - OP_COPY_REACH_SEC);
  }
  const outer: string[] = ["1 = 1"];
  const outerArgs: unknown[] = [];
  if (f.book !== "all") outer.push(BOOK_SQL[f.book]);
  if (f.status !== "all") outer.push(STATUS_SQL[f.status]);
  if (f.token) {
    outer.push("(lower(t.buy_token) = ? OR lower(t.sell_token) = ?)");
    outerArgs.push(f.token, f.token);
  }
  if (f.since !== null) {
    outer.push("t.created_at >= ?");
    outerArgs.push(f.since);
  }
  if (cursor) {
    outer.push("(t.created_at < ? OR (t.created_at = ? AND t.id < ?))");
    outerArgs.push(cursor.at, cursor.at, cursor.id);
  }
  const rows = (await db
    .prepare(`SELECT ${TRADE_COLS}
         FROM ${distinctTrades(inner.join(" AND "))}
         ${DECISION_JOIN}
        WHERE ${outer.join(" AND ")}
        ORDER BY t.created_at DESC, t.id DESC LIMIT ?`)
    .all(...innerArgs, ...outerArgs, limit + 1)) as Record<string, unknown>[];
  const page = rows.slice(0, limit).map((r) => tradeOf(r, scope.chainId));
  await markMeasured(db, page);
  const last = page[page.length - 1];
  return {
    trades: page.map(({ op_key: _op, ...t }) => t),
    next: rows.length > limit && last ? { at: last.at, id: Number(last.id) } : null,
  };
}

export interface DecisionSummary {
  id: string;
  at: number | null;
  source: string | null;
  action: string | null;
  /** Untrusted. */
  symbol: string | null;
  size_usdg: number | null;
  /** Untrusted: model prose or the strategy's own words. */
  reason: string | null;
  /** Untrusted: a rule template that can embed a model-supplied symbol. */
  dropped_rule: string | null;
}

export interface TradeDetail {
  trade: TradeView;
  decision: DecisionSummary | null;
  /** Ledger rows recording this one operation (a redeploy re-records some). */
  ledger_rows: number;
  requested_id: string;
  receipt: string;
}

export function receiptExplanation(t: TradeView): string {
  switch (t.status) {
    case "confirmed":
      // Landed says the operation succeeded on chain; how its FILL was booked is
      // basis_source's to say. A quote-booked fill is the worker's estimate from
      // before the trade, taken because the receipt could not be read.
      return t.basis_source === "receipt"
        ? "Confirmed: the operation landed on chain with a successful receipt, and the fill was read from it. The transaction hash links to the block explorer."
        : t.basis_source === "quote"
          ? "Confirmed on chain (the transaction hash links to the block explorer), but the receipt could not be read, so the fill amounts were booked from the pre-trade quote: an estimate, not a measurement."
          : "Confirmed on chain (the transaction hash links to the block explorer). The ledger does not record the fill as read from the receipt, so treat its fill amounts as unverified.";
    case "landed_without_tx_hash":
      return "The worker recorded this operation as landed, but no transaction hash is on record, so it cannot be checked on chain here. Treat it as unconfirmed.";
    case "submitted":
      return "Submitted, not confirmed: the operation was sent to the chain and its outcome had not been read back when the ledger was last updated. It may still land or fail.";
    case "failed":
      return "Failed: the operation reached the chain and reverted, so nothing was bought or sold; gas may still have been paid.";
    case "refused":
      return t.book === "paper"
        ? "Refused: the simulated (paper) fill was refused, so nothing changed in the paper book."
        : "Refused: a check stopped it before anything was signed or sent, so nothing moved.";
    case "paper_fill":
      return "Paper fill: simulated at the recorded price in the paper book. No real funds moved and there is no transaction.";
    default:
      return "The ledger status of this operation is not one Merrymen recognises.";
  }
}

/** One operation by id, with the decision that produced it. Null when it is not this agent's. */
export async function readTradeDetail(db: Db, scope: LedgerScope, id: number): Promise<TradeDetail | null> {
  if (!scope.accounts.length) return null;
  const hit = (await db
    .prepare(`SELECT id, agent_id, user_op_hash FROM trades WHERE id = ? AND lower(agent_id) IN (${qs(scope.accounts.length)})`)
    .get(id, ...scope.accounts)) as { id: number; agent_id: string; user_op_hash: string | null } | undefined;
  if (!hit) return null;
  const op = typeof hit.user_op_hash === "string" && hit.user_op_hash !== "" ? hit.user_op_hash.toLowerCase() : null;
  // The copy that speaks for the operation, by distinctTrades' own ranking.
  const rows = (op
    ? await db
      .prepare(`SELECT ${TRADE_COLS} FROM trades t ${DECISION_JOIN}
          WHERE lower(t.agent_id) = ? AND lower(t.user_op_hash) = ?
          ORDER BY (t.status = 'submitted'), (t.fill_side IS NULL), (t.decision_id IS NULL), t.created_at, t.id LIMIT 20`)
      .all(String(hit.agent_id).toLowerCase(), op)
    : await db.prepare(`SELECT ${TRADE_COLS} FROM trades t ${DECISION_JOIN} WHERE t.id = ?`).all(id)) as Record<string, unknown>[];
  const first = rows[0];
  if (!first) return null;
  const trade = tradeOf(first, scope.chainId);
  await markMeasured(db, [trade]);
  let decision: DecisionSummary | null = null;
  if (trade.decision_id) {
    const d = (await db
      .prepare("SELECT id, at, source, action, symbol, size_usdg, reason, dropped_rule FROM decisions WHERE id = ? AND lower(agent_id) = ?")
      .get(trade.decision_id, trade.account)) as Record<string, unknown> | undefined;
    if (d) {
      decision = {
        id: String(d.id),
        at: num(d.at),
        source: typeof d.source === "string" && /^[a-z][a-z0-9:_-]{0,48}$/.test(d.source) ? d.source : null,
        action: typeof d.action === "string" && SLUG.test(d.action) ? d.action : null,
        symbol: str(d.symbol),
        size_usdg: money(num(d.size_usdg)),
        reason: str(d.reason),
        dropped_rule: str(d.dropped_rule),
      };
    }
  }
  const { op_key: _op, ...view } = trade;
  return { trade: view, decision, ledger_rows: rows.length, requested_id: String(id), receipt: receiptExplanation(view) };
}

/** The most trade rows one decision's evidence read replays; any beyond it are left unjudged (null). */
export const DECISION_TRADES_MAX = 200;

/** Whether one of a decision's trade rows carries a MEASURED realized figure, with the row's identity to pair it by. */
export interface DecisionRealizedEvidence {
  created_at: number;
  status: string;
  /** Lowercased; null when the row has none. */
  user_op_hash: string | null;
  /**
   * True: the row's realized figure is a measurement (proceeds and the cost
   * sold against both evidenced). False: it is an estimate (either half is).
   * Null: the row carries no realized figure, or the cost could not be replayed.
   */
  measured: boolean | null;
}

/**
 * THE SAME RULE get_trade APPLIES, for every trade one decision produced:
 * tradeOf publishes a realized figure only on a sell whose proceeds the book
 * itself evidenced, and markMeasured replays the cost it sold against
 * (readEvidencedSells). A row whose raw figure tradeOf would not publish is an
 * estimate (false), never a measurement.
 *
 * `account` is the decision's own agent_id (the caller has already settled that
 * it is one of the owner's accounts). Rows come oldest first, in the order
 * readDecisionLifecycle lists them, so the caller can pair them row by row.
 */
export async function readDecisionRealizedEvidence(db: Db, account: string, decisionId: string): Promise<DecisionRealizedEvidence[]> {
  const rows = (await db
    .prepare(`SELECT ${TRADE_COLS} FROM trades t ${DECISION_JOIN}
        WHERE t.decision_id = ? AND lower(t.agent_id) = ? ORDER BY t.created_at ASC, t.id ASC LIMIT ${DECISION_TRADES_MAX}`)
    .all(decisionId, account.toLowerCase())) as Record<string, unknown>[];
  const views = rows.map((r) => tradeOf(r, 4663));
  await markMeasured(db, views);
  return rows.map((r, i) => {
    const raw = num(r.realized_pnl_usdg);
    const view = views[i]!;
    const op = typeof r.user_op_hash === "string" && r.user_op_hash !== "" ? r.user_op_hash.toLowerCase() : null;
    return {
      created_at: Number(r.created_at),
      status: String(r.status ?? ""),
      user_op_hash: op,
      measured: raw === null ? null : view.realized_pnl_usdg === null ? false : view.realized_pnl_measured,
    };
  });
}

// ── performance ─────────────────────────────────────────────────────────────

export type Period = "day" | "week" | "month" | "run";
const PERIOD_SEC: Record<Exclude<Period, "run">, number> = { day: 86_400, week: 7 * 86_400, month: 30 * 86_400 };

/** The most points a series carries. */
export const SERIES_MAX_POINTS = 200;
/** Raw valuations the attribution replays before it declines (≈33 days at a 240 s tick). */
export const ATTRIBUTION_MAX_MARKS = 12_000;
const TRADE_TIMES_LIMIT = 20_000;
const FLOW_READ_LIMIT = 5_000;
const SELL_READ_LIMIT = 2_000;

export interface Window {
  period: Period;
  since: number;
  until: number;
  run_epoch: number | null;
}

/**
 * The period as seconds. `run` is the current accounting run: from the first
 * valuation of the agent's current epoch (a paper reset or an accounting fix
 * opens a new one), on its current account.
 */
export async function periodWindow(db: Db, scope: LedgerScope, period: Period, now: number): Promise<Window> {
  if (period !== "run") return { period, since: now - PERIOD_SEC[period], until: now, run_epoch: null };
  if (!scope.accounts.length) return { period, since: now, until: now, run_epoch: null };
  const row = scope.current ? await readAgentRow(db, scope.current) : null;
  const epoch = row?.epoch ?? null;
  let first: number | null = null;
  if (scope.current && epoch !== null) {
    // A run that has not been valued yet (a reset a moment ago) starts now:
    // falling back to the first valuation ever would measure a closed run
    // under the new run's name.
    const r = (await db.prepare("SELECT MIN(at) AS at FROM equity WHERE lower(agent_id) = ? AND epoch = ?").get(scope.current, epoch)) as { at: number | null } | undefined;
    first = num(r?.at);
    return { period, since: first ?? now, until: now, run_epoch: epoch };
  }
  // No agents row to name the run: everything on record is the only run known.
  const r = (await db.prepare(`SELECT MIN(at) AS at FROM equity WHERE lower(agent_id) IN (${qs(scope.accounts.length)})`).get(...scope.accounts)) as { at: number | null } | undefined;
  first = num(r?.at);
  return { period, since: first ?? now, until: now, run_epoch: epoch };
}

export interface SeriesPoint {
  at: number;
  equity_usdg: number;
}

export interface Attribution {
  available: boolean;
  why_unavailable: string | null;
  flows_usdg: number | null;
  trading_usdg: number | null;
  unattributed_usdg: number | null;
  valuation_gaps: number | null;
}

export interface OpCounts {
  confirmed: number;
  landed_without_tx_hash: number;
  submitted: number;
  failed: number;
  paper_fills: number;
  paper_refused: number;
}

export interface BookPerformance {
  book: Book;
  has_valuation: boolean;
  valued_in_window: boolean;
  /** The one run (account and accounting epoch) the series, change and flows are measured in; see RunKey. */
  measured_run: { account: string; epoch: number | null } | null;
  start: { at: number; equity_usdg: number } | null;
  end: { at: number; equity_usdg: number } | null;
  change_usdg: number | null;
  net_flows_usdg: number | null;
  flows_count: number | null;
  flows_evidenced: number | null;
  change_excluding_flows_usdg: number | null;
  return_pct: number | null;
  max_drawdown_pct: number | null;
  attribution: Attribution;
  realized_pnl_usdg: number | null;
  realized_sells_counted: number | null;
  realized_sells_excluded: number | null;
  fees_accrued_usdg: number | null;
  fee_accruals: number | null;
  /**
   * Gas landed operations paid, in USDG (reports.ts's rule): the priced part;
   * null when no landed operation has priced gas and some have unpriced or unrecorded gas;
   * 0 only when nothing landed or every landed operation was sponsored.
   */
  gas_usdg: number | null;
  gas_unpriced_ops: number | null;
  /** Landed operations with no gas record at all (neither paid nor sponsored). */
  gas_unrecorded_ops: number | null;
  /** False when gas_usdg leaves out unpriced or unrecorded operations (a floor, or null). */
  gas_complete: boolean | null;
  gas_sponsored_ops: number | null;
  ops: OpCounts;
  series: SeriesPoint[];
  series_bucket_s: number | null;
  caveats: string[];
}

export interface PerformanceView {
  window: Window;
  paper: BookPerformance;
  live: BookPerformance;
  /** Refusals in the window that filled nothing in either book. */
  refused_ops: number;
}

type Row = Record<string, unknown>;

interface MarkPoint {
  at: number;
  equity: number;
  account: string;
  epoch: number | null;
}

/**
 * ONE RUN OF ONE BOOK: one smart account, one accounting epoch.
 *
 * A performance series never crosses a run boundary, because the ledger does
 * not carry value across one the way a series would read it: a paper reset
 * restarts the simulated balance by fiat (a jump no trade made), an accounting
 * change books the closing equity forward as an 'epoch-carry' flow (a deposit
 * nobody made), and a re-signed permission is another account with its own
 * epochs. Joined, each reads as a gain, a loss or a deposit. The worker's own
 * performance readers carry the same account-and-epoch predicate
 * (history-files.ts, chat-tools.ts; core explain.ts "Epoch").
 */
interface RunKey {
  account: string;
  epoch: number | null;
}

function runWhere(run: RunKey): { sql: string; args: unknown[] } {
  return run.epoch === null
    ? { sql: "lower(agent_id) = ? AND epoch IS NULL", args: [run.account] }
    : { sql: "lower(agent_id) = ? AND epoch = ?", args: [run.account, run.epoch] };
}

function markPoint(r: Row | undefined): MarkPoint | null {
  const eq = num(r?.equity_usdg);
  return r && eq !== null ? { at: Number(r.at), equity: eq, account: String(r.agent_id).toLowerCase(), epoch: num(r.epoch) } : null;
}

/** A mark of this book on any of the agent's accounts, in any run. */
async function markAt(db: Db, scope: LedgerScope, book: Book, cond: string, order: "ASC" | "DESC", ...args: unknown[]): Promise<MarkPoint | null> {
  const r = (await db
    .prepare(`SELECT at, equity_usdg, agent_id, epoch FROM equity WHERE lower(agent_id) IN (${qs(scope.accounts.length)}) AND mode = ? AND ${cond}
      ORDER BY at ${order}, id ${order} LIMIT 1`)
    .get(...scope.accounts, book, ...args)) as Row | undefined;
  return markPoint(r);
}

/** A mark of this book inside one run (its account is one the scope already vouched for). */
async function runMarkAt(db: Db, run: RunKey, book: Book, cond: string, order: "ASC" | "DESC", ...args: unknown[]): Promise<MarkPoint | null> {
  const rw = runWhere(run);
  const r = (await db
    .prepare(`SELECT at, equity_usdg, agent_id, epoch FROM equity WHERE ${rw.sql} AND mode = ? AND ${cond}
      ORDER BY at ${order}, id ${order} LIMIT 1`)
    .get(...rw.args, book, ...args)) as Row | undefined;
  return markPoint(r);
}

/**
 * Operation counts and gas, one row per operation. Gas is what LANDED
 * operations paid (the worker's getGasPaidUsdg and reports.ts's rule), and
 * every landed operation is one of: priced (gas_usdg), unpriced (gas_wei with
 * no USDG price), sponsored (someone else paid), or unrecorded (no gas record
 * at all — a row the in-flight reconciler wrote, say). Only the first is in the
 * total, so the other two decide whether the total is a floor or unknown.
 */
async function opCounts(db: Db, scope: LedgerScope, w: Window): Promise<{ ops: OpCounts; refused: number; gas: number; priced: number; unpriced: number; unrecorded: number; sponsored: number }> {
  const r = (await db
    .prepare(`SELECT
        COUNT(CASE WHEN ${CONFIRMED_SQL} THEN 1 END) AS confirmed,
        COUNT(CASE WHEN ${LANDED_NO_HASH_SQL} THEN 1 END) AS landed_no_hash,
        COUNT(CASE WHEN t.status = 'submitted' THEN 1 END) AS submitted,
        COUNT(CASE WHEN t.status = 'reverted' THEN 1 END) AS failed,
        COUNT(CASE WHEN t.status = 'paper' THEN 1 END) AS paper_fills,
        COUNT(CASE WHEN t.status = 'rejected' AND t.reject_rule LIKE 'paper:%' THEN 1 END) AS paper_refused,
        COUNT(CASE WHEN t.status = 'rejected' AND (t.reject_rule IS NULL OR t.reject_rule NOT LIKE 'paper:%') THEN 1 END) AS refused,
        COALESCE(SUM(CASE WHEN t.status = 'landed' THEN t.gas_usdg END), 0) AS gas,
        COUNT(CASE WHEN t.status = 'landed' AND t.gas_usdg IS NOT NULL THEN 1 END) AS priced,
        COUNT(CASE WHEN t.status = 'landed' AND t.gas_wei IS NOT NULL AND t.gas_wei <> '' AND t.gas_usdg IS NULL THEN 1 END) AS unpriced,
        COUNT(CASE WHEN t.status = 'landed' AND t.gas_usdg IS NULL AND (t.gas_wei IS NULL OR t.gas_wei = '')
          AND (t.sponsored_gas_wei IS NULL OR t.sponsored_gas_wei = '') THEN 1 END) AS unrecorded,
        COUNT(CASE WHEN t.status = 'landed' AND t.sponsored_gas_wei IS NOT NULL AND t.sponsored_gas_wei NOT IN ('', '0') THEN 1 END) AS sponsored
       FROM ${distinctTrades(`lower(t.agent_id) IN (${qs(scope.accounts.length)}) AND t.created_at > ?`)}
      WHERE t.created_at > ? AND t.created_at <= ?`)
    .get(...scope.accounts, w.since - OP_COPY_REACH_SEC, w.since, w.until)) as Row | undefined;
  const n = (k: string) => Number(r?.[k] ?? 0) || 0;
  return {
    ops: {
      confirmed: n("confirmed"), landed_without_tx_hash: n("landed_no_hash"), submitted: n("submitted"), failed: n("failed"),
      paper_fills: n("paper_fills"), paper_refused: n("paper_refused"),
    },
    refused: n("refused"),
    gas: num(r?.gas) ?? 0,
    priced: n("priced"),
    unpriced: n("unpriced"),
    unrecorded: n("unrecorded"),
    sponsored: n("sponsored"),
  };
}

/** Evidenced realized P&L in the window: sells whose proceeds AND cost the ledger vouches for. */
async function realizedOf(db: Db, scope: LedgerScope, book: Book, w: Window, spellings: Spellings): Promise<{ sum: number | null; counted: number | null; excluded: number | null; why: string | null }> {
  const status = book === "paper" ? "paper" : "landed";
  const source = book === "paper" ? "paper" : "receipt";
  const rows = (await db
    .prepare(`SELECT t.agent_id AS agent_id, ${OP_KEY} AS op_key, LOWER(t.sell_token) AS token, t.realized_pnl_usdg AS pnl
         FROM ${distinctTrades(`lower(t.agent_id) IN (${qs(scope.accounts.length)}) AND t.created_at > ?`)}
        WHERE t.status = ? AND t.fill_side = 'sell' AND t.basis_source = ? AND t.realized_pnl_usdg IS NOT NULL
          AND t.created_at > ? AND t.created_at <= ?
        ORDER BY t.created_at DESC, t.id DESC LIMIT ${SELL_READ_LIMIT + 1}`)
    .all(...scope.accounts, w.since - OP_COPY_REACH_SEC, status, source, w.since, w.until)) as Row[];
  if (rows.length > SELL_READ_LIMIT) return { sum: null, counted: null, excluded: null, why: `more than ${SELL_READ_LIMIT} sells in the window; realized P&L was not summed` };
  // A sell of an unrecorded token or with no figure is not a measurement.
  const byAccount = new Map<string, Array<{ op: string; token: string; pnl: number }>>();
  let excluded = 0;
  for (const r of rows) {
    const token = addr(r.token);
    const pnl = num(r.pnl);
    if (!token || pnl === null) {
      excluded++;
      continue;
    }
    const acct = String(r.agent_id).toLowerCase();
    byAccount.set(acct, [...(byAccount.get(acct) ?? []), { op: String(r.op_key), token, pnl }]);
  }
  let sum = 0;
  let counted = 0;
  for (const [account, sells] of byAccount) {
    const spelling = await tradeSpelling(db, account, spellings).catch(() => null);
    if (spelling === null || spelling === "none") return { sum: null, counted: null, excluded: null, why: "the fills behind the sells could not be replayed, so no realized figure can be vouched for" };
    let vouched: Set<string>;
    try {
      vouched = await readEvidencedSells(db, spelling, status, sells.map((s) => ({ op: s.op, token: s.token })));
    } catch {
      return { sum: null, counted: null, excluded: null, why: "the fills behind the sells could not be replayed, so no realized figure can be vouched for" };
    }
    for (const s of sells) {
      if (vouched.has(s.op)) {
        sum += s.pnl;
        counted++;
      } else {
        excluded++;
      }
    }
  }
  return { sum: money(sum), counted, excluded, why: null };
}

async function bookPerformance(db: Db, scope: LedgerScope, book: Book, w: Window, counts: Awaited<ReturnType<typeof opCounts>>, spellings: Spellings): Promise<BookPerformance> {
  const live = book === "live";
  const caveats: string[] = [];
  const noAttr = (why: string): Attribution => ({ available: false, why_unavailable: why, flows_usdg: null, trading_usdg: null, unattributed_usdg: null, valuation_gaps: null });
  const ops: OpCounts = live
    ? { ...counts.ops, paper_fills: 0, paper_refused: 0 }
    : { confirmed: 0, landed_without_tx_hash: 0, submitted: 0, failed: 0, paper_fills: counts.ops.paper_fills, paper_refused: counts.ops.paper_refused };
  const out: BookPerformance = {
    book, has_valuation: false, valued_in_window: false, measured_run: null, start: null, end: null,
    change_usdg: null, net_flows_usdg: null, flows_count: null, flows_evidenced: null, change_excluding_flows_usdg: null,
    return_pct: null, max_drawdown_pct: null, attribution: noAttr("this book has no valuation in the window"),
    realized_pnl_usdg: null, realized_sells_counted: null, realized_sells_excluded: null,
    fees_accrued_usdg: live ? null : 0, fee_accruals: live ? null : 0,
    // reports.ts's rule: zero only when it was measured (nothing landed, or
    // everything that landed was sponsored); unknown when landed operations
    // paid gas and none of it was priced; otherwise the priced part, flagged
    // as a floor whenever any landed operation's gas is unpriced or unrecorded.
    gas_usdg: live ? (counts.priced > 0 ? money(counts.gas) : counts.unpriced > 0 || counts.unrecorded > 0 ? null : 0) : 0,
    gas_unpriced_ops: live ? counts.unpriced : 0,
    gas_unrecorded_ops: live ? counts.unrecorded : 0,
    gas_complete: live ? counts.unpriced === 0 && counts.unrecorded === 0 : true,
    gas_sponsored_ops: live ? counts.sponsored : 0,
    ops, series: [], series_bucket_s: null, caveats,
  };
  if (!live) caveats.push("Paper book: simulated money. Real deposits and withdrawals never enter it, and it accrues no fees and pays no gas.");
  if (live && counts.unpriced > 0) caveats.push(`${counts.unpriced} landed operation(s) paid gas that could not be priced in USDG, so gas_usdg leaves them out.`);
  if (live && counts.unrecorded > 0) caveats.push(`${counts.unrecorded} landed operation(s) carry no gas record at all (neither paid nor sponsored), so gas_usdg leaves them out.`);
  if (live && out.gas_usdg === null) caveats.push("Gas is unknown, not zero: no landed operation in the window has priced gas, and some have gas that was unpriced or never recorded.");
  else if (live && out.gas_complete === false) caveats.push("gas_usdg is a floor: it covers only the landed operations whose gas was priced (gas_complete is false).");

  if (live) {
    const f = (await db
      .prepare(`SELECT COALESCE(SUM(fee_usdg), 0) AS fee, COUNT(*) AS n FROM fee_accruals
          WHERE lower(agent_id) IN (${qs(scope.accounts.length)}) AND at > ? AND at <= ?`)
      .get(...scope.accounts, w.since, w.until)) as Row | undefined;
    out.fees_accrued_usdg = money(num(f?.fee) ?? 0);
    out.fee_accruals = Number(f?.n ?? 0) || 0;
    if (out.fee_accruals > 0) caveats.push("Performance fees are accrued in the ledger and not collected.");
  }

  const realized = await realizedOf(db, scope, book, w, spellings);
  out.realized_pnl_usdg = realized.sum;
  out.realized_sells_counted = realized.counted;
  out.realized_sells_excluded = realized.excluded;
  if (realized.why) caveats.push(`Realized P&L unknown: ${realized.why}.`);
  else if ((realized.excluded ?? 0) > 0) caveats.push(`${realized.excluded} sell(s) are left out of realized P&L because their cost or proceeds were estimated rather than read from a receipt.`);

  // ── the valuation series ──
  // The book's CURRENT RUN (RunKey): the account and epoch of its newest
  // valuation in the window. A calendar window opens at the run's last
  // valuation before it (else its first inside it), as the worker's
  // periodChange does; a RUN period opens inside itself. Neither opens from a
  // mark of an earlier run.
  const close = await markAt(db, scope, book, "at <= ?", "DESC", w.until);
  if (!close) return out;
  out.has_valuation = true;
  if (close.at < w.since || (close.at === w.since && w.period !== "run")) {
    out.attribution = noAttr("this book has no valuation in the window");
    caveats.push(`This book was not valued during the window; its last valuation was at ${iso(close.at)}.`);
    return out;
  }
  const run: RunKey = { account: close.account, epoch: close.epoch };
  const rw = runWhere(run);
  out.measured_run = { account: run.account, epoch: run.epoch };
  const before = w.period === "run" ? null : await runMarkAt(db, run, book, "at <= ?", "DESC", w.since);
  const open = before ?? (await runMarkAt(db, run, book, w.period === "run" ? "at >= ? AND at <= ?" : "at > ? AND at <= ?", "ASC", w.since, w.until));
  if (!open) return out;
  out.valued_in_window = true;
  out.start = { at: open.at, equity_usdg: money(open.equity)! };
  out.end = { at: close.at, equity_usdg: money(close.equity)! };
  if (!before && w.period !== "run") {
    // The run began after the window opened. Any earlier mark of this book —
    // inside the window or before it — is another run's.
    const earlier = await markAt(db, scope, book, "at < ?", "DESC", open.at);
    if (earlier) caveats.push(`Measured from the first valuation of this book's current run (${iso(open.at)}): the valuations before it belong to an earlier run (a paper reset, an accounting change or another smart account) and are not joined to this one.`);
  }
  if (open.at === close.at) {
    // One valuation measures a level, not a change: unchanged is not known.
    out.attribution = noAttr("only one valuation of this book in the window");
    out.series = [{ at: open.at, equity_usdg: money(open.equity)! }];
    caveats.push("Only one valuation of this book in the window, so no change can be measured.");
    return out;
  }
  out.change_usdg = money(close.equity - open.equity);
  if (open.at < w.since) caveats.push(`Measured from the last valuation before the window opened (${iso(open.at)}).`);

  const shape = (await db
    .prepare(`SELECT COUNT(*) AS n FROM equity WHERE ${rw.sql} AND mode = ? AND at >= ? AND at <= ?`)
    .get(...rw.args, book, open.at, close.at)) as Row | undefined;
  const rawCount = Number(shape?.n ?? 0) || 0;

  // Flows: real money in or out of the run's account. Live only.
  //   - An 'epoch-carry' is an accounting bridge (a closed run's equity written
  //     forward as the next one's opening balance), not money anyone moved.
  //   - One chain log is one flow, whichever spelling of the account it was
  //     recorded under (the unique index keys on the exact spelling).
  const flows: Array<{ at: number; signed: number; evidenced: boolean }> = [];
  if (live) {
    const fr = (await db
      .prepare(`SELECT direction, amount_usdg, source, tx_hash, log_index, at FROM flows
          WHERE lower(agent_id) = ? AND at > ? AND at <= ? ORDER BY at ASC, id ASC LIMIT ${FLOW_READ_LIMIT + 1}`)
      .all(run.account, open.at, close.at)) as Row[];
    if (fr.length > FLOW_READ_LIMIT) {
      caveats.push(`More than ${FLOW_READ_LIMIT} flows in the window; net flows were not summed.`);
    } else {
      const seen = new Set<string>();
      let carries = 0;
      let duplicates = 0;
      for (const r of fr) {
        const source = String(r.source ?? "");
        if (source === "epoch-carry") {
          carries++;
          continue;
        }
        const tx = typeof r.tx_hash === "string" && r.tx_hash !== "" ? r.tx_hash.toLowerCase() : null;
        const li = num(r.log_index);
        if (tx && li !== null) {
          const k = `${tx}:${li}`;
          if (seen.has(k)) {
            duplicates++;
            continue;
          }
          seen.add(k);
        }
        const signed = (r.direction === "in" ? 1 : r.direction === "out" ? -1 : NaN) * (num(r.amount_usdg) ?? NaN);
        if (Number.isFinite(signed)) flows.push({ at: Number(r.at), signed, evidenced: isEvidencedFlow(source) });
      }
      const net = flows.reduce((s, x) => s + x.signed, 0);
      out.net_flows_usdg = money(net);
      out.flows_count = flows.length;
      out.flows_evidenced = flows.filter((x) => x.evidenced).length;
      out.change_excluding_flows_usdg = money(close.equity - open.equity - net);
      if (carries > 0) caveats.push(`${carries} run carry-over(s) (a closed run's balance bridged into the next) are not counted as deposits.`);
      if (duplicates > 0) caveats.push(`${duplicates} flow row(s) repeat a chain log already counted (the same transfer recorded under another spelling of the account) and are counted once.`);
      if (flows.length > out.flows_evidenced) caveats.push(`${flows.length - out.flows_evidenced} flow(s) in the window are not backed by a chain log (an own transfer or an inferred cash change), so the split between deposits and results is less certain.`);
    }
  } else {
    out.net_flows_usdg = 0;
    out.flows_count = 0;
    out.flows_evidenced = 0;
    out.change_excluding_flows_usdg = out.change_usdg;
  }

  // Downsampled closes: the last valuation in each bucket, plus the opening mark.
  const span = Math.max(1, close.at - open.at);
  const bucket = Math.max(60, Math.ceil(span / (SERIES_MAX_POINTS - 2)));
  const closes = (await db
    .prepare(`SELECT at, equity_usdg FROM (
        SELECT at, id, equity_usdg, ROW_NUMBER() OVER (PARTITION BY CAST(at / ${bucket} AS INTEGER) ORDER BY at DESC, id DESC) AS r
          FROM equity WHERE ${rw.sql} AND mode = ? AND at > ? AND at <= ?
      ) b WHERE r = 1 ORDER BY at ASC LIMIT ${SERIES_MAX_POINTS + 5}`)
    .all(...rw.args, book, open.at, close.at)) as Row[];
  let series: SeriesPoint[] = [{ at: open.at, equity_usdg: money(open.equity)! }];
  for (const c of closes) {
    const v = num(c.equity_usdg);
    if (v !== null) series.push({ at: Number(c.at), equity_usdg: money(v)! });
  }
  if (series.length > SERIES_MAX_POINTS) series = [series[0]!, ...series.slice(series.length - (SERIES_MAX_POINTS - 1))];
  out.series = series;
  out.series_bucket_s = bucket;

  const flowsKnown = live ? out.net_flows_usdg !== null : true;
  if (series.length >= 2 && flowsKnown) {
    const index = growthIndex(series.map((p) => ({ at: p.at, v: p.equity_usdg })), flows.map((x) => ({ at: x.at, signed: x.signed })));
    const last = index[index.length - 1]!;
    out.return_pct = pct((last - 1) * 100);
    const dd = drawdownBps(index);
    out.max_drawdown_pct = dd === null ? null : pct(dd / 100);
    caveats.push("Return and max drawdown are time-weighted over the downsampled series with flows divided out; a trough inside one bucket is not seen, so the drawdown is a floor.");
  }

  // Attribution over the raw valuations: flows, trading, and what nothing explains.
  if (!flowsKnown) {
    out.attribution = noAttr("the flows in the window could not all be read");
  } else if (rawCount > ATTRIBUTION_MAX_MARKS) {
    out.attribution = noAttr(`the window holds more than ${ATTRIBUTION_MAX_MARKS} valuations; choose a shorter period`);
  } else {
    const raw = (await db
      .prepare(`SELECT at, equity_usdg, cash_usdg FROM equity WHERE ${rw.sql} AND mode = ? AND at >= ? AND at <= ?
          ORDER BY at ASC, id ASC LIMIT ${ATTRIBUTION_MAX_MARKS + 1}`)
      .all(...rw.args, book, open.at, close.at)) as Row[];
    const marks: BookMark[] = raw
      .map((r) => ({ at: Number(r.at), equity: num(r.equity_usdg) ?? NaN, cash: num(r.cash_usdg) ?? NaN }))
      .filter((m) => Number.isFinite(m.equity) && Number.isFinite(m.cash));
    // A trade in a step explains its cash. A redeploy's re-recorded copy is
    // stamped at the restart, inside exactly the step a break judges, so it is
    // left out: it would pass a move no trade made off as trading.
    const times = (await db
      .prepare(`SELECT created_at FROM trades WHERE lower(agent_id) = ? AND status IN (${live ? "'landed','submitted'" : "'paper'"})
          AND created_at >= ? AND created_at <= ? AND ${NOT_A_RESTART_COPY} ORDER BY created_at ASC LIMIT ${TRADE_TIMES_LIMIT + 1}`)
      .all(run.account, open.at, close.at)) as Row[];
    if (times.length > TRADE_TIMES_LIMIT) {
      out.attribution = noAttr("too many trades in the window to attribute; choose a shorter period");
    } else if (marks.length < 2) {
      out.attribution = noAttr("fewer than two valuations in the window");
    } else {
      const bookFlows: BookFlow[] = flows.map((x) => ({ at: x.at, signed: x.signed, evidenced: x.evidenced }));
      const cum = attributeBook(marks, bookFlows, times.map((t) => Number(t.created_at)));
      const end = cum[cum.length - 1]!;
      const change = marks[marks.length - 1]!.equity - marks[0]!.equity;
      const gap = breakGap(marks);
      let gaps = 0;
      for (let i = 1; i < marks.length; i++) if (marks[i]!.at - marks[i - 1]!.at > gap) gaps++;
      out.attribution = {
        available: true,
        why_unavailable: null,
        flows_usdg: money(end.flows),
        trading_usdg: money(change - end.flows - end.unattributed),
        unattributed_usdg: money(end.unattributed),
        valuation_gaps: gaps,
      };
      if (gaps > 0) caveats.push(`${gaps} gap(s) in the valuation record (a redeploy, restart or outage). Changes across them are judged from cash: what cash and flows cannot explain is reported as unattributed, never as trading.`);
      if (Math.abs(end.unattributed) >= MONEY_TOLERANCE_USDG) caveats.push("Part of the change is unattributed: the records do not explain it, so it is not counted as trading.");
    }
  }
  return out;
}

/** Both books over one period, each from its own records only. */
export async function readPerformance(db: Db, scope: LedgerScope, period: Period, now: number): Promise<PerformanceView> {
  const w = await periodWindow(db, scope, period, now);
  if (!scope.accounts.length) {
    const empty = (book: Book): BookPerformance => ({
      book, has_valuation: false, valued_in_window: false, measured_run: null, start: null, end: null, change_usdg: null, net_flows_usdg: null,
      flows_count: null, flows_evidenced: null, change_excluding_flows_usdg: null, return_pct: null, max_drawdown_pct: null,
      attribution: { available: false, why_unavailable: "no smart account yet", flows_usdg: null, trading_usdg: null, unattributed_usdg: null, valuation_gaps: null },
      realized_pnl_usdg: null, realized_sells_counted: null, realized_sells_excluded: null, fees_accrued_usdg: null, fee_accruals: null,
      gas_usdg: null, gas_unpriced_ops: null, gas_unrecorded_ops: null, gas_complete: null, gas_sponsored_ops: null,
      ops: { confirmed: 0, landed_without_tx_hash: 0, submitted: 0, failed: 0, paper_fills: 0, paper_refused: 0 },
      series: [], series_bucket_s: null, caveats: ["No smart account exists for this agent yet."],
    });
    return { window: w, paper: empty("paper"), live: empty("live"), refused_ops: 0 };
  }
  const counts = await opCounts(db, scope, w);
  const spellings: Spellings = new Map();
  return {
    window: w,
    paper: await bookPerformance(db, scope, "paper", w, counts, spellings),
    live: await bookPerformance(db, scope, "live", w, counts, spellings),
    refused_ops: counts.refused,
  };
}

// ── exposure ────────────────────────────────────────────────────────────────

export interface ExposureItem {
  token: string;
  symbol: string | null;
  value_usdg: number | null;
  value_incomplete: boolean;
  valued_at: "mark" | "cost" | "mixed";
  share_of_equity_pct: number | null;
  price_stale: boolean;
  agents: string[];
}

export interface BookExposure {
  book: Book;
  agents_valued: string[];
  /** Agents whose holdings in this book are listed; a valued agent missing here counts in the equity but not in the exposures. */
  agents_holdings_listed: string[];
  total_equity_usdg: number | null;
  exposures: ExposureItem[];
}

/**
 * Holdings across several agents, grouped by token within each book.
 *
 * Only what each agent's own portfolio attributes to a book is counted there:
 * the positions of the book it valued last, plus class-vault holdings (live,
 * at cost). The share divides by the same book's latest equity summed over the
 * agents valued in it, so a paper position is never a share of real money.
 */
export function groupExposure(items: ReadonlyArray<{ agent: string; view: PortfolioView }>): Record<Book, BookExposure> {
  const out = {} as Record<Book, BookExposure>;
  for (const book of BOOKS) {
    const byToken = new Map<string, { symbol: string | null; values: Array<number | null>; kinds: Set<"mark" | "cost">; stale: boolean; agents: Set<string> }>();
    const valued: string[] = [];
    const listed: string[] = [];
    let equity = 0;
    let equityKnown = false;
    for (const { agent, view } of items) {
      const b = view[book];
      if (b.mark?.equity_usdg !== null && b.mark?.equity_usdg !== undefined) {
        equity += b.mark.equity_usdg;
        equityKnown = true;
        valued.push(agent);
      }
      if (b.positions_held_here) {
        listed.push(agent);
      }
      const add = (token: string, symbol: string | null, value: number | null, kind: "mark" | "cost", stale: boolean) => {
        const e = byToken.get(token) ?? { symbol, values: [], kinds: new Set(), stale: false, agents: new Set() };
        e.values.push(value);
        e.kinds.add(kind);
        e.stale ||= stale;
        e.agents.add(agent);
        e.symbol ??= symbol;
        byToken.set(token, e);
      };
      for (const p of b.positions ?? []) add(p.token, p.symbol, p.value_usdg, "mark", p.price_stale);
      for (const c of b.class_vault_positions) add(c.token, c.symbol, c.cost_usdg, "cost", false);
    }
    const total = equityKnown ? money(equity) : null;
    const exposures: ExposureItem[] = [...byToken.entries()].map(([token, e]) => {
      const known = e.values.filter((v): v is number => v !== null);
      const incomplete = known.length < e.values.length;
      const value = known.length ? money(known.reduce((s, v) => s + v, 0)) : null;
      return {
        token,
        symbol: e.symbol,
        value_usdg: value,
        value_incomplete: incomplete,
        valued_at: e.kinds.size > 1 ? "mixed" : e.kinds.has("cost") ? "cost" : "mark",
        share_of_equity_pct: value !== null && total !== null && total > 0 ? pct((value / total) * 100) : null,
        price_stale: e.stale,
        agents: [...e.agents],
      };
    });
    exposures.sort((a, b) => (b.value_usdg ?? -1) - (a.value_usdg ?? -1));
    out[book] = { book, agents_valued: valued, agents_holdings_listed: listed, total_equity_usdg: total, exposures };
  }
  return out;
}
