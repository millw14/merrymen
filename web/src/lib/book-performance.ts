/** One current run's public headline, from the same book and accounting time. */
import type { Db } from "../../../worker/src/db";
import { CapitalFlowsWithheld, netFlows, readDistinctFlows } from "./distinct-flows";
import { distinctTrades, fillKindSql } from "./distinct-trades";
import { heldSql, isHeld } from "./held-marks";
import { paperRecoveryBlocked, readPaperPerformance } from "./paper-return";
import { rankPnl, type Rank } from "./rank-pnl";
import { underReturnReview } from "./return-review";

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
  /**
   * WHAT A MISSING OR FLAT RETURN MEANS, as counts and times — never dollars.
   *
   * A paper book that has never traded measured 0.0% against itself and was
   * published as "0.0%", beside agents whose 0.0% was a real result; a paper
   * book whose only valuation predates its buys published a flat return its
   * trades had not been valued into; a funded live book with no fill said
   * "Unavailable". Each was a true number answering the wrong question. These
   * fields say which question a page is looking at, so it can print "No trades
   * yet" or "Awaiting first valuation" instead — and they change no figure.
   *
   * TRADES, not operations (fillKindSql): a vault deposit is an operation and
   * not a trade. This book's own only: paper fills for a paper book, landed
   * ones for a live book; either, when no valuation names a book yet. Live
   * fills count from when they settled, the time gasAt charges them by. Null
   * when unread, and on a book whose records cannot be vouched for (a blocked
   * paper recovery) — unread is never zero.
   */
  fills: number | null;
  /** Of those, how many were made at or before the measured valuation (`pnlAt`); 0 when there is none. */
  fillsAtMark: number | null;
  /** When the newest of them was made, unix seconds. Null when there is none, or unread. */
  lastFillAt: number | null;
  /**
   * Whether net contributions this run are above zero — a fact, never an
   * amount, so it is the same on a private book. As of the measured valuation
   * when there is one, like the return it explains. Null for a paper book
   * (real deposits are not its capital) and when unread.
   */
  funded: boolean | null;
  /**
   * Whether the measured valuation has caught up with this book's trades:
   * "awaiting" when a fill is newer than `pnlAt`, so the return does not
   * include it yet. Null when there is no measured valuation, or the fills
   * were unread.
   */
  valuation: "current" | "awaiting" | null;
  /**
   * How this run's operations' owner gas stands up to the measured valuation,
   * in OPERATIONS — the same rows and cutoff gasAt charges, key installs and
   * reverts included. Counts only: no amount, so a private book shows these as
   * a public one does. `unpriced` has a cost in wei and no dollar price;
   * `unrecorded` has no cost on record at all, or no evidenced time to charge
   * it by. Those two are exactly what makes `gasComplete` false. Live books
   * with a measured valuation only; null otherwise.
   */
  gasOps: GasOps | null;
  /**
   * An operator has put this account's return under review
   * (MERRYMEN_RETURN_REVIEW, return-review.ts), or its contributions are (one
   * transfer booked two ways — as our intent and again from its log, say —
   * distinct-flows.ts), so pnlBps and pnlUsdg are withheld whatever they would have been, and the
   * page says why. On the figures rather than only in the rank, because a
   * paper or idle book's return is shown without being ranked.
   */
  underReview: boolean;
}

export interface GasOps { sponsored: number; priced: number; unpriced: number; unrecorded: number }

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
/**
 * Each capital flow once (distinct-flows.ts): receipt spelling, an unstamped
 * chain and late mirror copies cannot count one deposit twice, and rows that
 * contradict each other THROW rather than have one of them picked. Copies are
 * collapsed over the whole run before the valuation cutoff, so a late copy can
 * neither stand alone inside it nor drop out in place of its original.
 */
async function flowCapital(db: Db, account: string, epoch: number, at?: number): Promise<number | null> {
  const { n, net } = netFlows(await readDistinctFlows(db, account, epoch), at);
  if (n === 0) return null;
  if (!Number.isFinite(net)) throw new Error("Unread capital accounting");
  return net;
}

/** One transfer booked two ways (our intent, and again from its log): never summed, and said so. */
const contributionsUnderReview = (error: unknown) => error instanceof CapitalFlowsWithheld && error.verdict === "review";

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
async function gasAt(db: Db, account: string, epoch: number, at: number): Promise<{ gas: number; complete: boolean; landed: number; ops: GasOps | null }> {
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
  // `missing`, split by WHY, beside the operations that are not missing at
  // all. Counts only; `missing` itself is unchanged and still decides
  // completeness, and the two halves below add up to it exactly: an ambiguous
  // time or no cost on record is unrecorded, a cost in wei without a price is
  // unpriced. Whatever is neither was priced (a proved zero included) or
  // sponsored, and is left to the total.
  const sponsorProved = "COALESCE(t.sponsored_gas_wei, '') NOT IN ('', '0')";
  const row = await db.prepare(`SELECT
      COALESCE(SUM(t.gas_usdg), 0) AS gas,
      COUNT(CASE WHEN t.status = 'landed' AND COALESCE(t.kind, '') <> 'key-install' THEN 1 END) AS landed,
      COUNT(CASE WHEN (${ambiguous}) OR (t.gas_usdg IS NULL
        AND COALESCE(t.gas_wei, '') <> '0'
        AND NOT ((t.gas_wei IS NULL OR t.gas_wei IN ('', '0'))
          AND t.sponsored_gas_wei IS NOT NULL AND t.sponsored_gas_wei NOT IN ('', '0'))
        ) THEN 1 END) AS missing,
      COUNT(*) AS ops,
      COUNT(CASE WHEN (${ambiguous}) OR (t.gas_usdg IS NULL AND COALESCE(t.gas_wei, '') = ''
        AND NOT ${sponsorProved}) THEN 1 END) AS unrecorded,
      COUNT(CASE WHEN NOT (${ambiguous}) AND t.gas_usdg IS NULL
        AND COALESCE(t.gas_wei, '') NOT IN ('', '0') THEN 1 END) AS unpriced,
      COUNT(CASE WHEN NOT (${ambiguous}) AND ${sponsorProved} AND COALESCE(t.gas_wei, '') IN ('', '0')
        AND COALESCE(t.gas_usdg, 0) = 0 THEN 1 END) AS sponsored
    FROM ${distinctTrades("LOWER(t.agent_id) = ? AND t.epoch = ?")}
    WHERE t.status IN ('landed', 'reverted') AND ${settledAt} <= ?`)
    .get(account.toLowerCase(), epoch, at) as Record<string, unknown> | undefined;
  const gas = finite(row?.gas);
  const landed = finite(row?.landed);
  const missing = finite(row?.missing);
  if (gas === null || gas < 0 || landed === null || missing === null) throw new Error("Unread gas accounting");
  const [ops, unrecorded, unpriced, sponsored] = [row?.ops, row?.unrecorded, row?.unpriced, row?.sponsored].map(finite);
  // A split that does not add up is not a split: the counts are withheld, and
  // completeness — read above, on its own — is not touched.
  const split = ops !== null && unrecorded !== null && unpriced !== null && sponsored !== null
    && unrecorded + unpriced === missing && ops >= missing + sponsored
    ? { sponsored, priced: ops - missing - sponsored, unpriced, unrecorded } : null;
  return { gas, complete: missing === 0, landed, ops: split };
}

/**
 * This book's TRADES, and how many of them its measured valuation includes.
 *
 * Collapsed to operations first and filtered by status and kind outside, as
 * distinctTrades asks: a deposit re-recorded as a bare 'swap' collapses into
 * its deposit instead of standing alone as a trade. A live fill is placed in
 * time by its settlement, the time gasAt charges it by; a paper fill settles
 * when it is written. With no book (no valuation names one yet) both kinds
 * count, because "no trades yet" and "awaiting a first valuation" are true of
 * the account whichever book it turns out to be. THROWS when unread.
 */
async function fillsOf(db: Db, account: string, epoch: number, book: "paper" | "live" | null, at: number | null):
  Promise<{ fills: number; atMark: number; lastAt: number | null }> {
  const settled = book === "live" && await tradeColumn(db, "budget_settled_at");
  const time = settled ? "COALESCE(t.budget_settled_at, t.created_at)" : "t.created_at";
  const status = book === "paper" ? "t.status = 'paper'" : book === "live" ? "t.status = 'landed'" : "t.status IN ('paper', 'landed')";
  const row = await db.prepare(`SELECT COUNT(*) AS n,
      ${at === null ? "0" : `COUNT(CASE WHEN ${time} <= ? THEN 1 END)`} AS at_mark, MAX(${time}) AS last
    FROM ${distinctTrades("LOWER(t.agent_id) = ? AND t.epoch = ?")}
    WHERE ${status} AND ${fillKindSql("t")}`)
    .get(...(at === null ? [] : [at]), account.toLowerCase(), epoch) as Record<string, unknown> | undefined;
  const fills = finite(row?.n);
  const atMark = finite(row?.at_mark);
  if (fills === null || atMark === null) throw new Error("Unread fills");
  return { fills, atMark, lastAt: fills === 0 ? null : finite(row?.last) };
}

/** Fill the trade fields in place. A failed read leaves them null: unknown, never zero. */
async function describeFills(db: Db, account: string, epoch: number, performance: BookPerformance): Promise<void> {
  try {
    const f = await fillsOf(db, account, epoch, performance.book, performance.pnlAt);
    performance.fills = f.fills;
    performance.fillsAtMark = f.atMark;
    performance.lastFillAt = f.lastAt;
    performance.valuation = performance.pnlAt === null ? null
      : f.lastAt !== null && f.lastAt > performance.pnlAt ? "awaiting" : "current";
  } catch { /* unread: the fields stay null */ }
}

/**
 * Current valuation is the newest raw mark, including a held one. Performance
 * uses a measured mark of that same recorded book and only flows/gas by then.
 * The visibility decision is an explicit owner setting supplied by the caller;
 * it never grants access to any other private financial field.
 *
 * A return under review (return-review.ts) is withheld HERE, the one reader
 * every public surface shares — the board, the profile, the public feed and
 * MCP — so no surface can publish it by computing it again. Only the return:
 * the valuation, its time and the counts that say what it means stay.
 *
 * So are CONTRIBUTIONS under review (distinct-flows.ts): one transfer booked
 * two ways — as our intent and again from its log, or by a row with no log
 * index beside the log it was — is two rows that cannot both be summed, and
 * nothing here can say which is right. The return is withheld the
 * same way, in the same words, until somebody does.
 */
export async function readBookPerformance(db: Db, account: string, epoch: number, publicBook: boolean): Promise<BookPerformanceRead> {
  const review = { flows: false };
  const read = await readBookFigures(db, account, epoch, publicBook, review);
  if (!review.flows && !underReturnReview(account)) return read;
  return {
    performance: { ...read.performance, pnlUsdg: null, pnlBps: null, underReview: true },
    liveRank: { pnlBps: null, unrankedWhy: "review-pending" },
    paperPnlBps: null,
  };
}

async function readBookFigures(db: Db, account: string, epoch: number, publicBook: boolean,
  review: { flows: boolean }): Promise<BookPerformanceRead> {
  const performance: BookPerformance = {
    book: null, equityUsdg: null, equityAt: null, pnlUsdg: null, pnlBps: null, pnlAt: null,
    publicBook: publicBook === true, gasComplete: null, held: false,
    fills: null, fillsAtMark: null, lastFillAt: null, funded: null, valuation: null, gasOps: null, underReview: false,
  };
  let current: Mark | null;
  // An unread mark is not an absent one: only a read that found none may go on
  // to say this account has no trades yet.
  let markRead = true;
  try { current = await latestMark(db, account, epoch); } catch { current = null; markRead = false; }
  if (!current) {
    // A successful empty funding read has a specific, useful refusal even
    // before the first valuation. An unread or funded book stays unknown.
    let liveRank = unavailable();
    try {
      const contributed = await flowCapital(db, account, epoch);
      performance.funded = contributed !== null && contributed > 0;
      if (!performance.funded) liveRank = { pnlBps: null, unrankedWhy: "no-deposit" };
    } catch (error) {
      // Unread funding is not an unfunded book; funding under review is neither.
      if (contributionsUnderReview(error)) review.flows = true;
    }
    if (markRead) await describeFills(db, account, epoch, performance);
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
      // Only beside a paper read that answered: it reports a failed read and
      // a book with no measured mark alike, and "awaiting first valuation"
      // would be a claim about the second made of the first.
      await describeFills(db, account, epoch, performance);
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
  } catch { markRead = false; /* unread marks do not turn into zero equity */ }
  if (!measured) {
    // Every mark is held, so nothing is measured yet; a trade made is one no
    // measured valuation includes. An unread measured mark stays unknown.
    if (markRead) await describeFills(db, account, epoch, performance);
    return { performance, liveRank: unavailable(), paperPnlBps: null };
  }
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
  if (inputs[0].status === "rejected" && contributionsUnderReview(inputs[0].reason)) review.flows = true;
  if (inputs[0].status === "rejected" || !gas) liveRank = unavailable();
  // A READ gas tape that is missing a cost is its own reason, and only where
  // rankPnl would have published: every other refusal is the truer thing to
  // say first. An unread tape stays "quality-unknown" above — that is about
  // the read, and this is about the record.
  else if (!gas.complete && liveRank.pnlBps !== null) liveRank = { pnlBps: null, unrankedWhy: "gas-pending" };
  performance.gasComplete = gas?.complete ?? null;
  performance.gasOps = gas?.ops ?? null;
  // A read that found no flows is unfunded; an unread one is unknown.
  if (inputs[0].status === "fulfilled") performance.funded = contributed !== null && contributed > 0;
  await describeFills(db, account, epoch, performance);
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
