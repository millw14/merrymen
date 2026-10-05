import { fullDateTime, shortDateTime, subCentUsd, usd } from "@/lib/format";
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
}

const number = (n: unknown) => typeof n === "number" && Number.isFinite(n) ? n : null;
const timestamp = (raw: unknown) => {
  const n = number(raw);
  return n !== null && n >= 0 && Number.isFinite(new Date(n * 1000).getTime()) ? n : null;
};

/** Missing fields stay unread; even a malformed private response reveals no dollars. */
export function performanceFromWire(raw: unknown): AgentPerformance {
  const p = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const published = p.publicBook === true;
  return {
    book: p.book === "paper" || p.book === "live" ? p.book : null,
    equityUsdg: published ? number(p.equityUsdg) : null,
    equityAt: timestamp(p.equityAt),
    pnlUsdg: published ? number(p.pnlUsdg) : null,
    pnlBps: number(p.pnlBps),
    pnlAt: timestamp(p.pnlAt),
    publicBook: published,
    gasComplete: typeof p.gasComplete === "boolean" ? p.gasComplete : null,
    held: p.held === true,
  };
}

function dollars(n: number): string {
  return n !== 0 && Math.abs(n) < 0.01 ? subCentUsd(n) : usd(n);
}

/** The same evidence and privacy rule on the board, sidebar and profile. */
export function performanceOf(agent: LiveAgent) {
  const p = agent.performance;
  const book = p ? p.book : agent.mode === "paper" ? "paper" : agent.mode === "live" ? "live" : null;
  const bps = p ? number(p.pnlBps) : number(agent.mode === "paper" ? agent.paperPnlBps : agent.pnlBps);
  const bookLabel = book === "paper" ? "Paper" : book === "live" ? "Live" : "Book unavailable";
  const published = p?.publicBook === true;
  const equity = published ? number(p.equityUsdg) : null;
  const pnl = published ? number(p.pnlUsdg) : null;
  const equityAt = timestamp(p?.equityAt);
  const pnlAt = timestamp(p?.pnlAt);
  // NOT RUNNING, AND NOTHING MORE. The board kept this row through the
  // recovery hold (read-leaderboard.ts); it says so neutrally, beside the
  // newest fact the row has — when its book was last valued — and never why
  // or what an owner should do about it.
  const notRunning = agent.notRunning === true;
  const title = [
    notRunning ? "Not running" : "",
    `${bookLabel} portfolio`,
    equityAt !== null ? `Valued ${fullDateTime(equityAt * 1000)}` : "Valuation time unavailable",
    pnlAt !== null ? `P&L measured ${fullDateTime(pnlAt * 1000)}` : "Measured P&L unavailable",
    p?.held ? "Latest value is pending reconciliation; P&L uses the last measured valuation." : "",
    p?.gasComplete === false ? "Gas accounting unavailable; exact P&L is unavailable." : "",
  ].filter(Boolean).join(". ");
  return {
    book, bookLabel, bps, title,
    value: p && !published ? "Private" : equity === null ? "—" : dollars(equity),
    pnl: pnl === null ? null : `${pnl > 0 ? "+" : pnl < 0 ? "−" : ""}${dollars(Math.abs(pnl))}`,
    held: p?.held === true,
    gasIncomplete: p?.gasComplete === false,
    notRunning,
    /** Visible as-of text for a row nothing is running; null when unvalued. */
    lastValued: notRunning && equityAt !== null ? `Last valued ${shortDateTime(equityAt * 1000)}` : null,
  };
}
