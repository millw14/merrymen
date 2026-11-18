import { fullDateTime, shortDateTime, subCentUsd, usd } from "@/lib/format";
import type { OwnFigures } from "@/lib/read-agent";
import type { LiveAgent } from "./live";

/** A current valuation and a separately measured return, from the ledger. */
export interface AgentPerformance {
  book: "paper" | "live" | null;
  equityUsdg: number | null;
  equityAt: number | null;
  pnlUsdg: number | null;
  pnlBps: number | null;
  pnlAt: number | null;
  publicBook: boolean;
  gasComplete: boolean | null;
  held: boolean;
  /**
   * What a missing or flat return means — see BookPerformance. Null is
   * unread, never zero. Optional because an older server does not send them,
   * and absent reads exactly as unread.
   */
  fills?: number | null;
  fillsAtMark?: number | null;
  lastFillAt?: number | null;
  funded?: boolean | null;
  valuation?: "current" | "awaiting" | null;
  gasOps?: { sponsored: number; priced: number; unpriced: number; unrecorded: number } | null;
  /** An operator is checking this return; it is withheld (return-review.ts). Absent is not under review. */
  underReview?: boolean;
  /** The return leaves out gas costs not yet on record — approximate (book-performance.ts). */
  pnlEstimated?: boolean;
}

const number = (n: unknown) => typeof n === "number" && Number.isFinite(n) ? n : null;
const timestamp = (raw: unknown) => {
  const n = number(raw);
  return n !== null && n >= 0 && Number.isFinite(new Date(n * 1000).getTime()) ? n : null;
};
const count = (raw: unknown) => {
  const n = number(raw);
  return n !== null && n >= 0 && Number.isInteger(n) ? n : null;
};
function gasOpsOf(raw: unknown): AgentPerformance["gasOps"] {
  const g = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  if (!g) return null;
  const [sponsored, priced, unpriced, unrecorded] = [g.sponsored, g.priced, g.unpriced, g.unrecorded].map(count);
  return sponsored === null || priced === null || unpriced === null || unrecorded === null
    ? null : { sponsored, priced, unpriced, unrecorded };
}

/** Missing fields stay unread; even a malformed private response reveals no dollars. */
export function performanceFromWire(raw: unknown): AgentPerformance {
  const p = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const published = p.publicBook === true;
  // A return under review is withheld by the server; a response that says so
  // and still carries one is not believed.
  const underReview = p.underReview === true;
  // Counts that contradict each other are not two facts, they are a bad read.
  const fills = count(p.fills);
  const fillsAtMark = count(p.fillsAtMark);
  const counted = fills !== null && fillsAtMark !== null && fillsAtMark <= fills;
  return {
    book: p.book === "paper" || p.book === "live" ? p.book : null,
    equityUsdg: published ? number(p.equityUsdg) : null,
    equityAt: timestamp(p.equityAt),
    pnlUsdg: published && !underReview ? number(p.pnlUsdg) : null,
    pnlBps: underReview ? null : number(p.pnlBps),
    pnlAt: timestamp(p.pnlAt),
    publicBook: published,
    gasComplete: typeof p.gasComplete === "boolean" ? p.gasComplete : null,
    held: p.held === true,
    fills: counted ? fills : null,
    fillsAtMark: counted ? fillsAtMark : null,
    lastFillAt: timestamp(p.lastFillAt),
    funded: typeof p.funded === "boolean" ? p.funded : null,
    valuation: p.valuation === "current" || p.valuation === "awaiting" ? p.valuation : null,
    gasOps: gasOpsOf(p.gasOps),
    underReview,
    pnlEstimated: p.pnlEstimated === true && !underReview,
  };
}

/**
 * The owner's own figures (read-agent.ts OwnFigures) as the wire sent them, or
 * null. A book it does not name is money it cannot place, so the whole answer
 * is refused. A dollar figure without the time it was measured is unread, and
 * a return under review carries no dollar P&L — the rules performanceFromWire
 * applies to a published book's.
 */
export function ownFiguresFromWire(raw: unknown): OwnFigures | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  if (f.book !== "paper" && f.book !== "live" && f.book !== null) return null;
  const underReview = f.underReview === true;
  const equityAt = timestamp(f.equityAt);
  const pnlAt = timestamp(f.pnlAt);
  return {
    book: f.book,
    equityUsdg: equityAt === null ? null : number(f.equityUsdg),
    equityAt,
    held: f.held === true,
    pnlUsdg: underReview || pnlAt === null ? null : number(f.pnlUsdg),
    pnlAt,
    underReview,
    pnlEstimated: f.pnlEstimated === true && !underReview,
  };
}

/**
 * How old a valuation may be before a page says when it was taken, in plain
 * text beside the figure. A worker values its book about every four minutes,
 * so twenty minutes is five missed ticks: not a slow mirror, a stopped book.
 */
export const STALE_VALUATION_SEC = 20 * 60;

/**
 * WHAT TO SAY INSTEAD OF A PERCENTAGE, AND WHEN NOT TO.
 *
 * One rule for the board, the sidebar, search and the profile, because the
 * four used to print `pctBps` of whatever arrived — and a paper book that had
 * never traded measured 0.0% against itself, which read exactly like a book
 * that traded and broke even.
 *
 * NEVER OVER A REAL NUMBER. A ranked return, or any exact return that is not
 * zero, is printed as it is; at most a note says a newer trade is not in it
 * yet. Only a missing or exactly-zero return on an unranked book is replaced,
 * and only by what the counts prove: no trade at all, or trades no measured
 * valuation includes. An unread count is null and replaces nothing.
 */
function stateOf(agent: LiveAgent, p: AgentPerformance | undefined, bps: number | null): { state: string | null; note: string | null } {
  if (!p) return { state: null, note: null };
  if (p.underReview === true) return { state: "Return under review", note: null };
  const awaiting = p.valuation === "awaiting" ? "awaiting valuation" : null;
  if (number(agent.pnlBps) !== null || (bps !== null && bps !== 0)) return { state: null, note: awaiting };
  // With no valuation naming a book yet, the heartbeat says which it will be.
  const live = p.book === "live" || (p.book === null && agent.mode === "live");
  const fills = p.fills ?? null;
  if (fills === 0) {
    // Funding is a live book's capital; a paper book's is simulated.
    if (live && p.funded === true) return { state: "Funded · no trades yet", note: null };
    if (live && p.funded === false) return { state: "No deposit yet", note: null };
    return { state: "No trades yet", note: null };
  }
  if (fills !== null && fills > 0 && p.fillsAtMark === 0) return { state: "Awaiting first valuation", note: null };
  return { state: null, note: bps === 0 ? awaiting : null };
}

/**
 * The newest valuation among these agents, unix seconds, when it is stale —
 * the board's one line about time. STALENESS ONLY: it says when the newest
 * figure was taken, never why nothing newer exists. Null while the newest is
 * fresh, or when none was read.
 */
export function staleSince(agents: LiveAgent[], nowSec: number): number | null {
  let newest: number | null = null;
  for (const a of agents) {
    const at = timestamp(a.performance?.equityAt);
    if (at !== null && (newest === null || at > newest)) newest = at;
  }
  return newest !== null && nowSec - newest > STALE_VALUATION_SEC ? newest : null;
}

function dollars(n: number): string {
  return n !== 0 && Math.abs(n) < 0.01 ? subCentUsd(n) : usd(n);
}

/**
 * The same evidence and privacy rule on the board, sidebar and profile.
 *
 * `own` is the owner's own money from their session-checked read, and only the
 * profile's owner view passes it. Without it — a stranger, the board, a read
 * still pending or refused — a private book is "Private", as it always was.
 */
export function performanceOf(agent: LiveAgent, nowSec?: number, own?: OwnFigures | null) {
  const p = agent.performance;
  const book = p ? p.book : agent.mode === "paper" ? "paper" : agent.mode === "live" ? "live" : null;
  const bps = p ? number(p.pnlBps) : number(agent.mode === "paper" ? agent.paperPnlBps : agent.pnlBps);
  const bookLabel = book === "paper" ? "Paper" : book === "live" ? "Live" : "Book unavailable";
  const published = p?.publicBook === true;
  // THE OWNER'S DOLLARS IN PLACE OF "Private", on their own private book: what
  // a published book would print. Only under the book the label names, and
  // only the money and what places it — the return and its state stay the
  // public read's, so the state rule below is still one rule for every viewer.
  // The owner's read follows the public one by a moment and may trail or lead
  // it by one valuation; matching on the book alone keeps that from flashing
  // "Private", and the rules below keep each figure beside its own read's time.
  const owner = own && p && !published && own.book === p.book ? own : null;
  // THE VALUE IS ONE READ'S. On the owner's view the value, whether it is held
  // and when it was taken all come from the owner's read, as all three come from
  // one read on a published book. A mark that lands between the two reads must
  // not put a newer value under an older one's time or "Pending reconciliation".
  const equity = owner ? number(owner.equityUsdg) : published ? number(p.equityUsdg) : null;
  const equityAt = owner ? owner.equityAt : timestamp(p?.equityAt);
  const held = owner ? owner.held : p?.held === true;
  const pnlAt = timestamp(p?.pnlAt);
  // THE OWNER'S DOLLAR P&L ONLY BESIDE THE RETURN IT WAS MEASURED WITH: their
  // read must have measured the same valuation as the public percentage beside
  // it, and neither may be under review. Otherwise the line is left out for
  // that moment, never a dollar figure from another valuation.
  const ownPnl = owner && pnlAt !== null && owner.pnlAt === pnlAt && !owner.underReview && p?.underReview !== true ? owner : null;
  const pnl = owner ? (ownPnl ? number(ownPnl.pnlUsdg) : null) : published ? number(p.pnlUsdg) : null;
  // ONE APPROXIMATE FLAG for the percentage, the dollars and the gas note, as on
  // a published book. A private read raises it only beside a figure it carries
  // (book-performance.ts), so with the dollar P&L the only figure it is the
  // owner's read that says so.
  const estimated = p?.pnlEstimated === true || ownPnl?.pnlEstimated === true;
  const title = [
    `${bookLabel} portfolio`,
    equityAt !== null ? `Valued ${fullDateTime(equityAt * 1000)}` : "Valuation time unavailable",
    pnlAt !== null ? `P&L measured ${fullDateTime(pnlAt * 1000)}` : "Measured P&L unavailable",
    held ? "Latest value is pending reconciliation; P&L uses the last measured valuation." : "",
    p?.gasComplete === false ? (estimated ? "Approximate: some gas costs are not on record yet, so the exact return may be slightly lower." : "Some gas costs are not on record yet.") : "",
    p?.valuation === "awaiting" ? "A newer trade is not in this return yet; it waits for the next valuation." : "",
  ].filter(Boolean).join(". ");
  const { state, note } = stateOf(agent, p, bps);
  const approx = estimated ? "≈ " : "";
  const pnlText = pnl === null || state !== null ? null : `${approx}${pnl > 0 ? "+" : pnl < 0 ? "−" : ""}${dollars(Math.abs(pnl))}`;
  return {
    book, bookLabel, bps, title,
    value: p && !published && !owner ? "Private" : equity === null ? "—" : dollars(equity),
    pnl: pnlText,
    /** A dollar figure here is the owner's own, which nobody else is shown. */
    ownerOnly: owner !== null && (equity !== null || pnlText !== null),
    held,
    gasIncomplete: p?.gasComplete === false,
    /** The figure is approximate (gas not all on record): print it with "≈". */
    estimated,
    /**
     * Printed IN PLACE OF the percentage when not null — see stateOf. The
     * same words on every surface; a page that prints `bps` without checking
     * this first is printing "0.0%" for a book that never traded.
     */
    state,
    /** A qualifier beside a percentage that stands: "awaiting valuation". */
    note,
    /**
     * WHEN, AS VISIBLE TEXT, once the valuation is stale — a tooltip is
     * something nobody reads on a phone. Null without a clock (`nowSec`) to
     * judge by.
     */
    asOf: nowSec !== undefined && equityAt !== null && nowSec - equityAt > STALE_VALUATION_SEC
      ? `as of ${shortDateTime(equityAt * 1000)}` : null,
    /** This book's trades (BookPerformance.fills); null when unread or from an older server. */
    fills: p?.fills ?? null,
  };
}
