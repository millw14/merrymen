/**
 * THE TRADES A HOSTED AGENT MADE BEFORE ITS LAST REDEPLOY, IN ITS OWN HOME.
 *
 * A hosted child's ledger is a sqlite file in a home with no volume, so every
 * redeploy starts it from nothing. At the next arm the in-flight reconciler
 * writes back only the last few hours of operations, and writes each one as a
 * bare copy — no coin, no decision, stamped at the restart. So an owner asking
 * the Telegram merryman "what did you buy yesterday" got "no trades" or eight
 * nameless rows at one second, while the real tape sat untouched in the shared
 * Postgres the dashboard reads.
 *
 * The child cannot read that database: `DATABASE_URL` is stripped from its
 * environment on purpose (the process boundary is what keeps one tenant out of
 * another's rows). So the orchestrator reads THIS tenant's rows and writes them
 * into the child's home before spawn — the same wire research-files.ts and the
 * cost-basis seed already use — and the chat reads the file.
 *
 * WHAT IT IS FOR, AND WHAT IT MUST NEVER BE. It is for ANSWERS: /trades and the
 * chat's lookups (telegram/history-overlay.ts). Nothing that sizes, caps,
 * books or accounts reads it — the daily cap, the cost basis and the P&L the
 * breaker trips on keep coming from the child's own ledger, exactly as before.
 * A file in a tenant-writable home is good enough to tell an owner what
 * happened; it is not good enough to decide what may happen next.
 *
 * Trades and decisions — and the account's value over time, but never its raw
 * marks and deposits: after a wipe the child could book its opening balance
 * again as a flow at the restart, and a pre-redeploy mark set against a
 * post-redeploy flow reads as a phantom trading loss of the whole balance. What
 * is carried is each mark's value with the running attribution period-pnl.ts
 * computed over the shared ledger at full resolution (money in or out,
 * unattributed), sampled hourly — so the chat can join the two sides of the
 * restart without ever re-deriving the pre-restart flows itself.
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAddress } from "viem";

import { isEvidencedFlow } from "../../packages/core/src/index";
import type { Db } from "./db";
import { attributeBook, bookOf, type BookFlow, type BookKey, type CarriedTail } from "./period-pnl";
import { isRestartCopy } from "./token-label";

export const HISTORY_FILE = "trade-history.json";
const SCHEMA = 1;

/** How far back the file reaches. */
export const HISTORY_DAYS = 30;
/** Newest operations that went out (fills, paper fills, failures). */
export const HISTORY_OPS_MAX = 400;
/** Newest refusals — kept apart so a day of refusals cannot push every fill out. */
export const HISTORY_REFUSALS_MAX = 100;
/** Newest decisions, beside every decision one of the carried trades links to. */
export const HISTORY_DECISIONS_MAX = 300;
/** A decision's reason is the model's own words; bounded so the file stays small. */
const REASON_MAX = 600;
/**
 * How much younger than its operation a re-recorded copy can be — the window
 * web/src/lib/distinct-trades.ts collapses copies over (OP_COPY_REACH_SEC). The
 * scope reaches back this much further than the file does, so a copy inside
 * the window never stands alone for want of its original just outside it.
 */
const OP_COPY_REACH_SEC = 7 * 86_400;

export interface HistoryTrade {
  kind: string;
  target: string | null;
  sell_token: string | null;
  buy_token: string | null;
  amount_usdg: number;
  user_op_hash: string | null;
  tx_hash: string | null;
  status: string;
  reject_rule: string | null;
  decision_id: string | null;
  fill_side: string | null;
  /** The coin's name, stored with the fill (store.ts fillSymbolOfRow) or read off its receipt by the repair; untrusted unless curated. */
  fill_symbol: string | null;
  fill_qty_raw: string | null;
  fill_price_usd: number | null;
  realized_pnl_usdg: number | null;
  fill_cash_usdg: number | null;
  gas_usdg: number | null;
  gas_wei: string | null;
  epoch: number | null;
  created_at: number;
}

export interface HistoryDecision {
  id: string;
  source: string;
  strategy: string | null;
  symbol: string | null;
  action: string | null;
  size_usdg: number | null;
  reason: string | null;
  dropped_rule: string | null;
  provenance: string | null;
  display_name: string | null;
  at: number;
}

export interface TradeHistory {
  schema: typeof SCHEMA;
  /** The smart account every row is on. The reader refuses a file for anyone else. */
  agentId: string;
  /** Unix seconds the orchestrator wrote this. */
  writtenAt: number;
  /** Unix seconds the file reaches back to. */
  since: number;
  /**
   * How far back the carried "recent" decisions reach: the oldest of them when
   * the cap cut the list, else `since`. Older carried decisions are only the
   * ones a carried trade links to, so "my decisions start here" is this.
   */
  decisionsFrom: number;
  /** The account's value before the restart, attributed (loadAccountFromShared). Null when unreadable. */
  account?: HistoryAccount | null;
  trades: HistoryTrade[];
  decisions: HistoryDecision[];
}

/** One carried account-value point, with the running attribution up to it. */
export interface HistoryAccountPoint {
  at: number;
  book: BookKey;
  equity: number;
  cash: number;
  /** Running money in (+) / out (−) of this book, from its first carried mark. */
  flows: number;
  /** Running change no record explains, from its first carried mark. */
  unattributed: number;
}

export interface HistoryAccount {
  /** The accounting epoch the marks are from. The chat ignores a file from another. */
  epoch: number;
  /**
   * Every mark carried is older than this, and the child's ledger must start at
   * or after it for the two to join: a spawn draws it before the child exists.
   */
  until: number;
  points: HistoryAccountPoint[];
  /** Flows after each book's last carried mark: they belong to the step across the restart. */
  tail: CarriedTail[];
  /** False when the mark cap cut the window short. */
  complete: boolean;
}

export function historyFilePath(home: string): string {
  return path.join(home, HISTORY_FILE);
}

/**
 * Write a child's history. Orchestrator only. Temp-then-rename, mode 0600, as
 * research-files.ts.
 *
 * NEVER CREATES THE HOME. The read behind this can be slow, and a tenant
 * removed meanwhile has had its home deleted; writing would bring the
 * directory back holding its trades. Returns false when the home is gone.
 */
export function writeHistoryFile(home: string, file: TradeHistory): boolean {
  if (!existsSync(home)) return false;
  const tmp = path.join(home, "." + HISTORY_FILE + ".tmp");
  writeFileSync(tmp, JSON.stringify(file), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, historyFilePath(home));
  return true;
}

/** Past this the file is not ours: the loader's caps keep a real one well under 1 MB. */
const FILE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Read a child's history for `agentId`. NEVER THROWS: absent, unreadable,
 * malformed or somebody else's all mean "no history", which is what a
 * self-hosted agent (whose ledger is never wiped) always sees.
 *
 * Every row is re-validated, and the file is held to the loader's own bounds —
 * size, row counts, no row from after it was written — because it sits in a
 * tenant-writable home and is read on every chat lookup, in the process that
 * trades.
 */
export function readHistory(home: string, agentId: string): TradeHistory | null {
  try {
    const file = historyFilePath(home);
    if (statSync(file).size > FILE_MAX_BYTES) return null;
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<TradeHistory> | null;
    if (!raw || typeof raw !== "object" || raw.schema !== SCHEMA) return null;
    if (typeof raw.agentId !== "string" || raw.agentId.toLowerCase() !== agentId.toLowerCase()) return null;
    const writtenAt = num(raw.writtenAt) ?? 0;
    const since = num(raw.since) ?? 0;
    // A row stamped after the file was written would sort as the newest trade for ever.
    const latest = writtenAt + 3600;
    const list = (v: unknown, max: number) => (Array.isArray(v) ? v.slice(0, max) : []);
    return {
      schema: SCHEMA,
      agentId: raw.agentId,
      writtenAt,
      since,
      // Absent, claim nothing: the file's own time, never its 30-day reach —
      // a cut list would otherwise say "decisions start a month ago".
      decisionsFrom: num(raw.decisionsFrom) ?? writtenAt,
      account: asAccount((raw as { account?: unknown }).account, writtenAt),
      trades: list(raw.trades, HISTORY_OPS_MAX + HISTORY_REFUSALS_MAX)
        .map(asTrade)
        .filter((t): t is HistoryTrade => t !== null && t.created_at > 0 && t.created_at <= latest),
      decisions: list(raw.decisions, HISTORY_OPS_MAX + HISTORY_REFUSALS_MAX + HISTORY_DECISIONS_MAX)
        .map(asDecision)
        .filter((d): d is HistoryDecision => d !== null && d.at > 0 && d.at <= latest),
    };
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────── reading Postgres ──

const TRADE_COLS = [
  "kind",
  "target",
  "sell_token",
  "buy_token",
  "amount_usdg",
  "user_op_hash",
  "tx_hash",
  "status",
  "reject_rule",
  "decision_id",
  "fill_side",
  "fill_symbol",
  "fill_qty_raw",
  "fill_price_usd",
  "realized_pnl_usdg",
  "fill_cash_usdg",
  "gas_usdg",
  "gas_wei",
  "epoch",
  "created_at",
] as const;

const DECISION_COLS = "id, source, strategy, symbol, action, size_usdg, reason, dropped_rule, provenance, display_name, at";

/**
 * Every spelling the ledger writes this account under: as given, lowercase and
 * checksummed — each an index seek, the way ledger-mirror.ts asks. `lower()`
 * on the column would scan the whole fleet's tape.
 */
function spellings(agentId: string): [string, string, string] {
  const lower = agentId.toLowerCase();
  let sum = lower;
  try {
    sum = getAddress(lower);
  } catch {
    /* not an address: the other two spellings still apply */
  }
  return [agentId, lower, sum];
}

/**
 * This account's recent trades and decisions from the shared ledger, ONE ROW
 * PER OPERATION. The shared tape can hold an operation more than once — the
 * executor's row and the reconciler's bare copies from earlier redeploys — so
 * the copies are collapsed with the ranking distinct-trades.ts uses: the row
 * that knows the outcome, then the one with fill evidence, then the one linked
 * to its decision, then the earliest. SQL both backends run.
 */
export async function loadHistoryFromShared(
  shared: Db,
  agentId: string,
  nowSec: number,
  /**
   * Where the child's own ledger begins (default: now). Nothing at or after it
   * is carried — trades, decisions or the account — because the child holds it
   * already: a restart that kept the ledger, or a re-read after the startup
   * repair, would otherwise fill the caps with the child's own rows.
   */
  o: { until?: number } = {},
): Promise<TradeHistory> {
  const since = nowSec - HISTORY_DAYS * 86_400;
  const until = Math.min(o.until ?? nowSec, nowSec);
  const who = spellings(agentId);
  const cols = TRADE_COLS.join(", ");
  const ops = (await shared
    .prepare(
      `WITH scoped AS (SELECT id, ${cols} FROM trades WHERE agent_id IN (?, ?, ?) AND created_at >= ?)
       SELECT * FROM (
         SELECT s.*, ROW_NUMBER() OVER (
           PARTITION BY lower(s.user_op_hash)
           ORDER BY (s.status = 'submitted'), (s.fill_side IS NULL), (s.decision_id IS NULL), s.created_at, s.id
         ) AS op_rank
         FROM scoped s WHERE s.user_op_hash IS NOT NULL AND s.user_op_hash <> ''
       ) ranked WHERE ranked.op_rank = 1 AND ranked.status <> 'rejected' AND ranked.created_at >= ? AND ranked.created_at < ?
       UNION ALL
       SELECT s.*, 1 AS op_rank FROM scoped s
        WHERE (s.user_op_hash IS NULL OR s.user_op_hash = '') AND s.status <> 'rejected' AND s.created_at >= ? AND s.created_at < ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(...who, since - OP_COPY_REACH_SEC, since, until, since, until, HISTORY_OPS_MAX)) as unknown as Record<string, unknown>[];
  const refusals = (await shared
    .prepare(
      `SELECT id, ${cols} FROM trades WHERE agent_id IN (?, ?, ?) AND created_at >= ? AND created_at < ? AND status = 'rejected'
        ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(...who, since, until, HISTORY_REFUSALS_MAX)) as unknown as Record<string, unknown>[];
  const trades = [...ops, ...refusals].map(asTrade).filter((t): t is HistoryTrade => t !== null);
  trades.sort((a, b) => b.created_at - a.created_at);

  // Every decision a carried trade links to (its reason is the answer to "why
  // did you buy X"), then the newest others, one row per id. A hold the gate
  // forced is not carried among the others: while a book cannot size, every
  // tick writes one, and 300 of them would be the whole list.
  const decisions = new Map<string, HistoryDecision>();
  const linked = [...new Set(trades.map((t) => t.decision_id).filter((d): d is string => !!d))];
  for (let i = 0; i < linked.length; i += 100) {
    const chunk = linked.slice(i, i + 100);
    const rows = (await shared
      .prepare(`SELECT ${DECISION_COLS} FROM decisions WHERE agent_id IN (?, ?, ?) AND id IN (${chunk.map(() => "?").join(", ")})`)
      .all(...who, ...chunk)) as unknown as Record<string, unknown>[];
    for (const r of rows) {
      const d = asDecision(r);
      if (d) decisions.set(d.id, d);
    }
  }
  const recent = (await shared
    .prepare(
      `SELECT ${DECISION_COLS} FROM decisions
        WHERE agent_id IN (?, ?, ?) AND at >= ? AND at < ? AND source <> 'market-review-private'
          AND (hold_kind IS NULL OR hold_kind <> 'GATE_FORCED_HOLD')
        ORDER BY at DESC LIMIT ?`,
    )
    .all(...who, since, until, HISTORY_DECISIONS_MAX)) as unknown as Record<string, unknown>[];
  for (const r of recent) {
    const d = asDecision(r);
    if (d && !decisions.has(d.id)) decisions.set(d.id, d);
  }
  // Cut by the cap, the recent list reaches back only as far as its oldest row.
  const decisionsFrom = recent.length >= HISTORY_DECISIONS_MAX ? Math.min(...recent.map((r) => num(r.at) ?? nowSec)) : since;
  // The account is the part most likely to be large, and the least essential:
  // an unreadable one costs the P&L's reach across the restart, never the trades.
  const account = await loadAccountFromShared(shared, agentId, since, until).catch(() => null);
  return {
    schema: SCHEMA,
    agentId,
    decisionsFrom,
    writtenAt: nowSec,
    since,
    trades,
    decisions: [...decisions.values()].sort((a, b) => b.at - a.at),
    account,
  };
}

/** Marks read per tenant, newest kept: 30 days at a one-minute tick is 43k. */
const ACCOUNT_MARKS_MAX = 60_000;
/** Points carried: hourly closes and each book's ends — 30 days is about 720 a book. */
export const ACCOUNT_POINTS_MAX = 5_000;

/**
 * The account's value before `until`, attributed step by step at full
 * resolution (period-pnl.ts attributeBook) and sampled at each book's first
 * and last marks and each hour's close. Every running total is exact at the
 * points kept; only the points between them are dropped.
 *
 * Flows are read de-duplicated by their chain identity (an account's two
 * spellings can each hold the same log) and practice books take none. Trade
 * times exclude the reconciler's restart copies: a copy is stamped at the
 * restart, and would claim a trade happened across the downtime.
 */
export async function loadAccountFromShared(shared: Db, agentId: string, since: number, until: number): Promise<HistoryAccount | null> {
  const who = spellings(agentId);
  const e = (await shared.prepare("SELECT MAX(epoch) AS e FROM agents WHERE smart_account IN (?, ?, ?)").get(...who)) as { e: unknown } | undefined;
  const epoch = num(e?.e);
  if (epoch === null) return null;
  const rows = (await shared
    .prepare(
      `SELECT at, mode, equity_usdg, cash_usdg FROM equity
        WHERE agent_id IN (?, ?, ?) AND epoch = ? AND at >= ? AND at < ?
        ORDER BY at DESC, id DESC LIMIT ?`,
    )
    .all(...who, epoch, since, until, ACCOUNT_MARKS_MAX)) as unknown as Record<string, unknown>[];
  const complete = rows.length < ACCOUNT_MARKS_MAX;
  const marks: { at: number; book: BookKey; equity: number; cash: number }[] = [];
  for (const r of rows.reverse()) {
    const at = num(r.at);
    const equity = num(r.equity_usdg);
    const cash = num(r.cash_usdg);
    if (at !== null && equity !== null && cash !== null) marks.push({ at, book: bookOf(text(r.mode)), equity, cash });
  }
  if (!marks.length) return { epoch, until, points: [], tail: [], complete };
  const from = marks[0]!.at;

  const flowRows = (await shared
    .prepare(
      `SELECT at, direction, amount_usdg, source, tx_hash, log_index FROM flows
        WHERE agent_id IN (?, ?, ?) AND epoch = ? AND at > ? AND at < ?`,
    )
    .all(...who, epoch, from, until)) as unknown as Record<string, unknown>[];
  const seenLog = new Set<string>();
  const flows: BookFlow[] = [];
  for (const r of flowRows) {
    const at = num(r.at);
    const amount = num(r.amount_usdg);
    if (at === null || amount === null) continue;
    const tx = text(r.tx_hash, 80)?.toLowerCase() ?? null;
    const li = num(r.log_index);
    if (tx && li !== null) {
      const k = `${tx}:${li}`;
      if (seenLog.has(k)) continue;
      seenLog.add(k);
    }
    flows.push({ at, signed: text(r.direction, 8) === "out" ? -amount : amount, evidenced: isEvidencedFlow(text(r.source, 40) ?? "") });
  }

  const tradeRows = (await shared
    .prepare(
      `SELECT created_at, status, kind, target, agent_id, decision_id, fill_side FROM trades
        WHERE agent_id IN (?, ?, ?) AND created_at >= ? AND created_at < ? AND status IN ('landed','submitted','paper')`,
    )
    .all(...who, from, until)) as unknown as Record<string, unknown>[];
  const times = { paper: [] as number[], live: [] as number[] };
  for (const r of tradeRows) {
    const at = num(r.created_at);
    if (at === null) continue;
    const copy = isRestartCopy({
      kind: text(r.kind, 40) ?? "",
      target: text(r.target, 80),
      agent_id: text(r.agent_id, 80) ?? "",
      decision_id: text(r.decision_id, 120),
      fill_side: text(r.fill_side, 8),
    });
    if (!copy) (text(r.status, 16) === "paper" ? times.paper : times.live).push(at);
  }

  const points: HistoryAccountPoint[] = [];
  const tail: CarriedTail[] = [];
  // Practice and real money only. A mark with no mode is from before the mirror
  // carried the column; it joins neither book, and carried it could only ever
  // read as "I switched between practice and real money".
  for (const book of ["paper", "live"] as const) {
    const m = marks.filter((x) => x.book === book);
    if (!m.length) continue;
    const bookFlows = book === "paper" ? [] : flows;
    const cum = attributeBook(m, bookFlows, book === "paper" ? times.paper : times.live);
    m.forEach((x, i) => {
      const next = m[i + 1];
      if (i === 0 || !next || Math.floor(next.at / 3600) !== Math.floor(x.at / 3600)) {
        points.push({ at: x.at, book, equity: x.equity, cash: x.cash, flows: cum[i]!.flows, unattributed: cum[i]!.unattributed });
      }
    });
    if (book !== "paper") {
      const last = m[m.length - 1]!.at;
      let evidenced = 0;
      let unevidenced = 0;
      for (const f of bookFlows) {
        if (f.at <= last) continue;
        if (f.evidenced) evidenced += f.signed;
        else unevidenced += f.signed;
      }
      if (evidenced || unevidenced) tail.push({ book, evidenced, unevidenced });
    }
  }
  points.sort((a, b) => a.at - b.at);
  return { epoch, until, points: points.slice(-ACCOUNT_POINTS_MAX), tail, complete: complete && points.length <= ACCOUNT_POINTS_MAX };
}

// ─────────────────────────────────────────────────────────── validation ──

/** A number from Postgres (BIGINT can arrive as a string) or JSON, else null. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function text(v: unknown, max = 200): string | null {
  if (typeof v === "string") return v === "" ? null : v.slice(0, max);
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  return null;
}

function asTrade(v: unknown): HistoryTrade | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const kind = text(r.kind, 40);
  const status = text(r.status, 40);
  const created = num(r.created_at);
  if (!kind || !status || created === null) return null;
  return {
    kind,
    target: text(r.target, 80),
    sell_token: text(r.sell_token, 80),
    buy_token: text(r.buy_token, 80),
    amount_usdg: num(r.amount_usdg) ?? 0,
    user_op_hash: text(r.user_op_hash, 80),
    tx_hash: text(r.tx_hash, 80),
    status,
    reject_rule: text(r.reject_rule, 120),
    decision_id: text(r.decision_id, 120),
    fill_side: text(r.fill_side, 8),
    fill_symbol: text(r.fill_symbol, 40),
    fill_qty_raw: text(r.fill_qty_raw, 80),
    fill_price_usd: num(r.fill_price_usd),
    realized_pnl_usdg: num(r.realized_pnl_usdg),
    fill_cash_usdg: num(r.fill_cash_usdg),
    gas_usdg: num(r.gas_usdg),
    gas_wei: text(r.gas_wei, 80),
    epoch: num(r.epoch),
    created_at: created,
  };
}

function asDecision(v: unknown): HistoryDecision | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const id = text(r.id, 120);
  const source = text(r.source, 80);
  const at = num(r.at);
  if (!id || !source || at === null) return null;
  return {
    id,
    source,
    strategy: text(r.strategy, 80),
    symbol: text(r.symbol, 40),
    action: text(r.action, 40),
    size_usdg: num(r.size_usdg),
    reason: text(r.reason, REASON_MAX),
    dropped_rule: text(r.dropped_rule, 120),
    provenance: text(r.provenance, 80),
    display_name: text(r.display_name, 80),
    at,
  };
}

/** The books a carried account holds (loadAccountFromShared carries no mode-less marks). */
const BOOKS: readonly BookKey[] = ["paper", "live"];

/**
 * A carried account, or null — and a bad one costs only the account, never the
 * trades beside it. Every point must be finite, in a known book and from before
 * both the account's bound and the file itself; the file is tenant-writable.
 */
function asAccount(v: unknown, writtenAt: number): HistoryAccount | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Partial<HistoryAccount>;
  const epoch = num(r.epoch);
  const until = num(r.until);
  if (epoch === null || !Number.isInteger(epoch) || until === null || until > writtenAt + 3600) return null;
  if (!Array.isArray(r.points) || r.points.length > ACCOUNT_POINTS_MAX || !Array.isArray(r.tail) || r.tail.length > BOOKS.length) return null;
  const points: HistoryAccountPoint[] = [];
  for (const p of r.points as unknown[]) {
    if (!p || typeof p !== "object") return null;
    const q = p as Record<string, unknown>;
    const at = num(q.at);
    const equity = num(q.equity);
    const cash = num(q.cash);
    const flows = num(q.flows);
    const unattributed = num(q.unattributed);
    const book = BOOKS.find((b) => b === q.book);
    if (at === null || at >= until || equity === null || cash === null || flows === null || unattributed === null || !book) return null;
    points.push({ at, book, equity, cash, flows, unattributed });
  }
  const tail: CarriedTail[] = [];
  for (const t of r.tail as unknown[]) {
    if (!t || typeof t !== "object") return null;
    const q = t as Record<string, unknown>;
    const book = BOOKS.find((b) => b === q.book);
    const evidenced = num(q.evidenced);
    const unevidenced = num(q.unevidenced);
    if (!book || book === "paper" || evidenced === null || unevidenced === null) return null;
    tail.push({ book, evidenced, unevidenced });
  }
  return { epoch, until, points: points.sort((a, b) => a.at - b.at), tail, complete: r.complete === true };
}
