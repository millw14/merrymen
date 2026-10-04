/** One current run's public headline, from the same book and accounting time. */
import type { Db } from "../../../worker/src/db";
import { distinctTrades } from "./distinct-trades";
import { heldSql, isHeld } from "./held-marks";
import { paperRecoveryBlocked, readPaperPerformance } from "./paper-return";
import { rankPnl, type Rank } from "./rank-pnl";

export interface BookPerformance {
  book: "paper" | "live" | null;
  /** Recorded total trading equity; never cash, holdings or a wallet balance. */
  equityUsdg: number | null;
  equityAt: number | null;
  pnlUsdg: number | null;
  /** Unrounded basis points. Formatting must not erase a small real return. */
  pnlBps: number | null;
  pnlAt: number | null;
  publicBook: boolean;
  /** Exact net P&L is unavailable when an owner's settled gas cost is unknown. */
  gasComplete: boolean | null;
  /** The latest valuation may be current while flow-relative performance waits. */
  held: boolean;
}

export interface BookPerformanceRead {
  performance: BookPerformance;
  /** Legacy ranking retains whole bps and its existing contribution/fill gates. */
  liveRank: Rank;
  paperPnlBps: number | null;
}

const finite = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const unavailable = (): Rank => ({ pnlBps: null, unrankedWhy: "quality-unknown" });

interface Mark { id: number; equity: number; at: number; book: "paper" | "live" | null; held: boolean }

const knownColumns = new WeakMap<object, Set<string>>();
async function tradeColumn(db: Db, column: "budget_settled_at" | "user_op_nonce"): Promise<boolean> {
  if (knownColumns.get(db)?.has(column)) return true;
  try {
    await db.prepare(`SELECT ${column} FROM trades WHERE 1 = 0`).all();
    const columns = knownColumns.get(db) ?? new Set<string>();
    columns.add(column);
    knownColumns.set(db, columns);
    return true;
  } catch (error) {
    if (!missingColumns(error)) throw error;
    return false; // a missing column may arrive with the next migration
  }
}

function missingColumns(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown };
  return e.code === "42703" || (typeof e.message === "string" && /^no such column: /i.test(e.message));
}
const flowIdentityColumns = new WeakSet<object>();
/** Current account/epoch flows, with receipt copies collapsed before any time cutoff. */
export async function capitalFlowsSql(db: Db): Promise<string> {
  let hasIdentity = flowIdentityColumns.has(db);
  if (!hasIdentity) {
    try {
      await db.prepare("SELECT id, chain_id, tx_hash, log_index FROM flows WHERE 1 = 0").all();
      flowIdentityColumns.add(db);
      hasIdentity = true;
    } catch (error) { if (!missingColumns(error)) throw error; }
  }
  const scope = "LOWER(agent_id) = ? AND epoch = ?";
  return hasIdentity ? `(WITH candidates AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY CASE
        WHEN chain_id IS NOT NULL AND COALESCE(tx_hash, '') <> '' AND log_index IS NOT NULL AND source <> 'epoch-carry'
          THEN 'log:' || CAST(chain_id AS TEXT) || ':' || LOWER(tx_hash) || ':' || CAST(log_index AS TEXT)
        ELSE 'row:' || CAST(id AS TEXT) END ORDER BY at ASC, id ASC) AS receipt_copy
      FROM flows WHERE ${scope}
    ) SELECT * FROM candidates WHERE receipt_copy = 1) f`
    : `(SELECT * FROM flows WHERE ${scope}) f`;
}

/** Receipt spelling and late mirror copies cannot count one deposit twice. */
async function flowCapital(db: Db, account: string, epoch: number, at?: number): Promise<number | null> {
  const rows = await capitalFlowsSql(db);
  const row = await db.prepare(`SELECT COUNT(*) AS n,
      SUM(CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END) AS net
    FROM ${rows}${at === undefined ? "" : " WHERE at <= ?"}`)
    .get(account.toLowerCase(), epoch, ...(at === undefined ? [] : [at])) as Record<string, unknown> | undefined;
  const n = finite(row?.n);
  if (n === null) throw new Error("Unread capital accounting");
  if (n === 0) return null;
  const net = finite(row?.net);
  if (net === null) throw new Error("Unread capital accounting");
  return net;
}

async function contributionQuality(db: Db, account: string, epoch: number): Promise<Record<string, unknown> | undefined> {
  let beat = true;
  try { await db.prepare("SELECT beat_at FROM agents WHERE 1 = 0").all(); }
  catch (error) { if (!missingColumns(error)) throw error; beat = false; }
  return db.prepare(`SELECT contributions_known FROM agents WHERE LOWER(smart_account) = ? AND COALESCE(epoch, 1) = ?
      ORDER BY ${beat ? "COALESCE(beat_at, 0) DESC, " : ""}created_at DESC, smart_account ASC LIMIT 1`)
    .get(account.toLowerCase(), epoch) as Promise<Record<string, unknown> | undefined>;
}

/** No time window or row-id boundary may turn an older book into the latest. */
async function latestMark(db: Db, account: string, epoch: number): Promise<Mark | null> {
  const held = await heldSql(db);
  const row = await db.prepare(`SELECT id, equity_usdg, at, mode, ${held.flag()} AS held FROM equity
    WHERE LOWER(agent_id) = ? AND epoch = ? ORDER BY at DESC, id DESC LIMIT 1`)
    .get(account.toLowerCase(), epoch) as Record<string, unknown> | undefined;
  const equity = finite(row?.equity_usdg);
  const at = finite(row?.at);
  const id = finite(row?.id);
  if (!row || equity === null || equity < 0 || at === null || id === null) return null;
  return { id, equity, at, book: row.mode === "paper" || row.mode === "live" ? row.mode : null, held: isHeld(row.held) };
}

/**
 * Collapse operations before applying the valuation cutoff. A late bare copy
 * cannot become a fresh trade or a second gas charge. Key installation costs
 * count as expenses, but an installation alone is not a filled trade.
 */
async function gasAt(db: Db, account: string, epoch: number, at: number): Promise<{ gas: number; complete: boolean; landed: number }> {
  const [hasSettlement, hasNonce] = await Promise.all([tradeColumn(db, "budget_settled_at"), tradeColumn(db, "user_op_nonce")]);
  const settledAt = hasSettlement ? "COALESCE(t.budget_settled_at, t.created_at)" : "t.created_at";
  const free = `(COALESCE(t.gas_usdg, -1) = 0 OR (t.gas_usdg IS NULL AND
    (COALESCE(t.gas_wei, '') = '0' OR (COALESCE(t.gas_wei, '') = ''
      AND COALESCE(t.sponsored_gas_wei, '') NOT IN ('', '0')))))`;
  // Older updates observed settlement but retained its submission time. A nonce
  // identifies potentially delayed executions; their nonzero cost has no
  // evidenced historical time. Proved free outcomes cannot change the result.
  const ambiguous = hasNonce ? `(t.status IN ('landed', 'reverted') AND ${hasSettlement ? "t.budget_settled_at IS NULL" : "1 = 1"}
    AND COALESCE(t.user_op_nonce, '') <> '' AND NOT ${free})` : "1 = 0";
  const row = await db.prepare(`SELECT
      COALESCE(SUM(t.gas_usdg), 0) AS gas,
      COUNT(CASE WHEN t.status = 'landed' AND COALESCE(t.kind, '') <> 'key-install' THEN 1 END) AS landed,
      COUNT(CASE WHEN (${ambiguous}) OR (t.gas_usdg IS NULL
        AND COALESCE(t.gas_wei, '') <> '0'
        AND NOT ((t.gas_wei IS NULL OR t.gas_wei IN ('', '0'))
          AND t.sponsored_gas_wei IS NOT NULL AND t.sponsored_gas_wei NOT IN ('', '0'))
        ) THEN 1 END) AS missing
    FROM ${distinctTrades("LOWER(t.agent_id) = ? AND t.epoch = ?")}
    WHERE t.status IN ('landed', 'reverted') AND ${settledAt} <= ?`)
    .get(account.toLowerCase(), epoch, at) as Record<string, unknown> | undefined;
  const gas = finite(row?.gas);
  const landed = finite(row?.landed);
  const missing = finite(row?.missing);
  if (gas === null || gas < 0 || landed === null || missing === null) throw new Error("Unread gas accounting");
  return { gas, complete: missing === 0, landed };
}

/**
 * Current valuation is the newest raw mark, including a held one. Performance
 * uses a measured mark of that same recorded book and only flows/gas by then.
 * The visibility decision is an explicit owner setting supplied by the caller;
 * it never grants access to any other private financial field.
 */
export async function readBookPerformance(db: Db, account: string, epoch: number, publicBook: boolean): Promise<BookPerformanceRead> {
  const performance: BookPerformance = {
    book: null, equityUsdg: null, equityAt: null, pnlUsdg: null, pnlBps: null, pnlAt: null,
    publicBook: publicBook === true, gasComplete: null, held: false,
  };
  let current: Mark | null;
  try { current = await latestMark(db, account, epoch); } catch { current = null; }
  if (!current) {
    // A successful empty funding read has a specific, useful refusal even
    // before the first valuation. An unread or funded book stays unknown.
    let liveRank = unavailable();
    try {
      const contributed = await flowCapital(db, account, epoch);
      if (contributed === null || contributed <= 0) liveRank = { pnlBps: null, unrankedWhy: "no-deposit" };
    } catch { /* unread funding is not an unfunded book */ }
    return { performance, liveRank, paperPnlBps: null };
  }
  performance.book = current.book;
  performance.held = current.held;

  if (current.book === "paper" && await paperRecoveryBlocked(db, account)) {
    return { performance, liveRank: { pnlBps: null, unrankedWhy: "paper" }, paperPnlBps: null };
  }
  performance.equityUsdg = performance.publicBook ? current.equity : null;
  performance.equityAt = current.at;
  if (current.book === "paper") {
    const paper = await readPaperPerformance(db, account, epoch);
    performance.gasComplete = true; // simulated fills do not spend the live book's ETH
    if (paper) {
      // Paper's raw and measured inputs come from one statement; adopt that
      // snapshot if another tick arrived after the initial book read.
      performance.equityUsdg = performance.publicBook ? paper.equityUsdg : null;
      performance.equityAt = paper.equityAt;
      performance.held = paper.held;
      performance.pnlUsdg = performance.publicBook ? paper.pnlUsdg : null;
      performance.pnlBps = paper.pnlBps;
      performance.pnlAt = paper.pnlAt;
    }
    return { performance, liveRank: { pnlBps: null, unrankedWhy: "paper" }, paperPnlBps: paper ? Math.round(paper.pnlBps) : null };
  }
  if (current.book !== "live") return { performance, liveRank: unavailable(), paperPnlBps: null };

  let measured: { equity: number; at: number } | null = null;
  try {
    const held = await heldSql(db);
    const row = await db.prepare(`SELECT equity_usdg, at FROM equity
      WHERE LOWER(agent_id) = ? AND epoch = ? AND mode = 'live' AND ${held.measurable()}
        AND (at < ? OR (at = ? AND id <= ?)) ORDER BY at DESC, id DESC LIMIT 1`)
      .get(account.toLowerCase(), epoch, current.at, current.at, current.id) as Record<string, unknown> | undefined;
    const equity = finite(row?.equity_usdg);
    const at = finite(row?.at);
    if (equity !== null && equity >= 0 && at !== null) measured = { equity, at };
  } catch { /* unread marks do not turn into zero equity */ }
  if (!measured) return { performance, liveRank: unavailable(), paperPnlBps: null };
  performance.pnlAt = measured.at;

  const inputs = await Promise.allSettled([
    flowCapital(db, account, epoch, measured.at),
    contributionQuality(db, account, epoch),
    gasAt(db, account, epoch, measured.at),
  ]);
  const quality = inputs[1].status === "fulfilled" ? inputs[1].value as Record<string, unknown> | undefined : undefined;
  const gas = inputs[2].status === "fulfilled" ? inputs[2].value : null;
  const contributed = inputs[0].status === "fulfilled" ? inputs[0].value : null;
  const contributionsKnown = quality?.contributions_known === null || quality?.contributions_known === undefined
    ? null : Number(quality.contributions_known) === 1;
  let liveRank = rankPnl({ contributed, latest: measured.equity, gasUsdg: gas?.gas ?? 0, landed: gas?.landed ?? 0, contributionsKnown });
  if (inputs[0].status === "rejected" || !gas || (!gas.complete && liveRank.pnlBps !== null)) liveRank = unavailable();
  performance.gasComplete = gas?.complete ?? null;
  // Net contributions may be zero or negative after a withdrawal. A dollar
  // gain still has meaning with a proved funding history and executed trade;
  // the percentage/rank keeps refusing a nonpositive denominator.
  if (contributed !== null && contributionsKnown === true && gas?.complete && gas.landed > 0) {
    const pnl = measured.equity - contributed! - gas.gas;
    if (Number.isFinite(pnl)) performance.pnlUsdg = performance.publicBook ? pnl : null;
    const bps = contributed > 0 ? pnl / contributed * 10_000 : null;
    if (liveRank.pnlBps !== null && bps !== null && Number.isFinite(bps)) performance.pnlBps = bps;
  }
  return { performance, liveRank, paperPnlBps: null };
}
