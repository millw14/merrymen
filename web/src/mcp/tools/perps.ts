/**
 * Perpetual futures (Lighter on Robinhood Chain): what the agent holds at the
 * venue, as its worker last REPORTED it. docs/perps.md is the contract
 * ("Surfaces": MCP is a read-only `get_perp_positions` under portfolio.read;
 * no perp tool opens, closes or moves funds).
 *
 * READ, NEVER COMPUTED. The worker is the only process that reads Lighter and
 * the only one that knows whether its read worked. It writes that verdict to
 * `agents.perps` (core PerpsReport, as JSON), and this module parses it with
 * the one whitelist parser (core parsePerpsReport). A second answer computed
 * here — from the web container's clock, with no venue key and no view of the
 * child's ledger — would eventually disagree with the first, and the owner
 * would be shown the wrong one of two.
 *
 * UNKNOWN IS NEVER ZERO (rule 11). Four states are kept apart all the way to
 * the output, because the one that matters most is the one a careless reader
 * collapses: "no row / no column / NULL" (the worker has not said), "a value
 * that does not parse" (it said something this build cannot read), "Lighter
 * could not be read" (collateralMicro null — the positions listed are the
 * ledger's, with every venue figure null), and a real read. None of the first
 * three may render as "no positions": that is exactly the sentence a phone
 * showed over open leverage before the banner existed.
 *
 * PAPER IS ALWAYS LABELLED PAPER. `book` and `money` come from the report's
 * own mode, and a report that does not say which book it describes (perps off
 * or refused while something is still held) gets `book: null` and a sentence
 * saying so — never a guess from the account's spot mode, which is written by
 * a different statement at a different moment.
 *
 * NOTHING HERE IS PUBLISHED (rule 17): portfolio.read is an owner-granted,
 * agent-scoped capability, and the ownership check runs before any read.
 */
import * as z from "zod";
import {
  GRANT_PERP_LIGHTER,
  parsePerpsReport,
  perpsBlockerText,
  type PerpsReport,
  type PerpsReportPosition,
} from "@merrymen/core";
import { freshWithin } from "@/lib/services/agent-status";
import { settingsReader } from "@/lib/services/settings-view";
import type { Db } from "../../../../worker/src/db";
import type { OwnedAgent } from "../agents";
import { McpError } from "../errors";
import { defineTool, type ToolContext } from "../tool";
import { AGENT_ARG, isoOrNull } from "./shared";

const iso = (sec: number) => new Date(sec * 1000).toISOString();

/** The report's timestamps are unix MILLISECONDS (lane.ts protectAtMs, view.ts facts.readAtMs). */
const isoMs = (ms: number | null): string | null => (ms === null ? null : isoOrNull(Math.floor(ms / 1000)));

/**
 * micro-USDG (a decimal integer string, as the report carries money) to a
 * USDG number. Exact to the micro below 2^53 micro (about 9 billion USDG);
 * IEEE division is correctly rounded, so 12_340_000 reads back as 12.34.
 */
function usdgOf(micro: string | null): number | null {
  if (micro === null) return null;
  return Number(BigInt(micro)) / 1e6;
}

/** How many of an owner's accounts are read for a report: the grant's history is short, and this bounds the query. */
const ACCOUNTS_READ_MAX = 8;

// ── reading the column ──────────────────────────────────────────────────────

export type ReportRead =
  /** A report that parsed. */
  | { state: "reported"; report: PerpsReport; beatAt: number | null }
  /**
   * No agents row, a NULL column, or no column at all (a ledger from before
   * perps, whose worker has never said anything about them): not said yet.
   */
  | { state: "not_reported"; beatAt: number | null }
  /** Unknown: a value this build cannot parse (`parse`), or a read that failed (`query`). */
  | { state: "unreadable"; beatAt: number | null; cause: "parse" | "query" };

/**
 * A ledger written before the column existed answers "no such column"
 * (SQLite) or "column … does not exist" (Postgres) — the same test
 * web/src/lib/agent-perps.ts applies, so the desk and this tool agree.
 */
const MISSING_COLUMN_RE = /no such column|column .* does not exist/i;

/**
 * `agents.perps` for each account, keyed by the lowercased account. An
 * account with no row is absent from the map (not_reported). A read that
 * fails for any reason but a missing column marks every account unreadable,
 * never not_reported: "we could not look" is a different answer from
 * "nothing was said".
 */
export async function readPerpsReports(db: Db, accounts: readonly string[]): Promise<Map<string, ReportRead>> {
  const wanted = [...new Set(accounts.map((a) => a.toLowerCase()))].slice(0, ACCOUNTS_READ_MAX);
  const out = new Map<string, ReportRead>();
  if (wanted.length === 0) return out;
  let rows: Array<{ smart_account: string; perps: unknown; beat_at: unknown }>;
  try {
    rows = (await db
      .prepare(`SELECT smart_account, perps, beat_at FROM agents WHERE lower(smart_account) IN (${wanted.map(() => "?").join(", ")})`)
      .all(...wanted)) as typeof rows;
  } catch (e) {
    // The call's own timeout is not an answer about perps: let it end the call.
    if (e instanceof McpError) throw e;
    const neverSaid = MISSING_COLUMN_RE.test(e instanceof Error ? e.message : String(e));
    for (const a of wanted) out.set(a, neverSaid ? { state: "not_reported", beatAt: null } : { state: "unreadable", beatAt: null, cause: "query" });
    return out;
  }
  for (const r of rows) {
    const key = String(r.smart_account).toLowerCase();
    const beat = typeof r.beat_at === "number" ? r.beat_at : typeof r.beat_at === "string" && /^\d+$/.test(r.beat_at) ? Number(r.beat_at) : null;
    out.set(key, parseRow(r.perps, beat));
  }
  return out;
}

function parseRow(raw: unknown, beatAt: number | null): ReportRead {
  // Absent and NULL are the same answer: the worker has not said.
  if (raw === null || raw === undefined) return { state: "not_reported", beatAt };
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { state: "unreadable", beatAt, cause: "parse" };
    }
  }
  const report = parsePerpsReport(value);
  return report ? { state: "reported", report, beatAt } : { state: "unreadable", beatAt, cause: "parse" };
}

// ── what a report says ──────────────────────────────────────────────────────

export type PerpExposureState = "none" | "held" | "unknown";

/**
 * Positions the report COUNTS but could not LIST. `stopsMissing` counts every
 * held position without a stop seen resting, including ones the worker could
 * not render (a market this build does not list, a venue position with no
 * decimals read — view.ts counts them "always as unprotected" and skips the
 * row). More unprotected positions than unprotected rows means rows are
 * missing, and a list with rows missing is not a complete list.
 */
function unlistedPositions(r: PerpsReport): number {
  const listedWithoutStop = r.positions.filter((p) => p.stopTrigger === null).length;
  return Math.max(0, r.stopsMissing - listedWithoutStop);
}

/**
 * Is anything at the venue, as far as the report can say?
 *
 * `none` only when every figure the report carries was READ and is zero, no
 * position is listed or counted, and no incident is flagged. An incident
 * (activity our key did not sign) is never `none`: the report covers our own
 * Lighter account, and the incident may be precisely money somewhere else
 * under the same address.
 */
export function exposureOf(read: ReportRead | undefined): PerpExposureState {
  if (!read || read.state !== "reported") return "unknown";
  const r = read.report;
  if (r.positions.length > 0 || unlistedPositions(r) > 0) return "held";
  const money = [r.collateralMicro, r.inTransitMicro, r.openNotionalMicro];
  if (money.some((m) => m !== null && BigInt(m) !== 0n)) return "held";
  if (money.some((m) => m === null)) return "unknown";
  if (r.incident) return "unknown";
  return "none";
}

type Book = "paper" | "live";

/** What the report reads: Lighter for a real account, the practice book on paper. */
function placeOf(book: Book | null): string {
  return book === "paper" ? "the paper book" : "Lighter";
}

/**
 * Which book the report describes. From the report's own mode; "off" and
 * "refuse" do not say, so a real Lighter account index (which a paper book
 * never has) is the only other evidence taken. Anything else is null.
 */
export function bookOf(r: PerpsReport): { book: Book | null; why: string } {
  if (r.mode === "paper") return { book: "paper", why: "The worker trades perpetuals for this agent on paper: simulated at Lighter's live prices, with no money at Lighter." };
  if (r.mode === "live") return { book: "live", why: "The worker trades perpetuals for this agent with real funds at Lighter." };
  if (r.accountIndex !== null) {
    return { book: "live", why: `Perpetuals are ${r.mode === "off" ? "switched off" : "not opening positions"} for this agent, and the report names its real Lighter account (index ${r.accountIndex}), so what it lists is real funds.` };
  }
  return {
    book: null,
    why: `Perpetuals are ${r.mode === "off" ? "switched off" : "not opening positions"} for this agent, and the report does not say whether anything it lists is paper or real.`,
  };
}

function modeExplained(r: PerpsReport): string {
  switch (r.mode) {
    case "off":
      return "Perpetuals are off for this agent: it opens no new positions. Anything still held keeps its stops, and closes still run.";
    case "paper":
      return "Paper perpetuals: practice positions with simulated money, at Lighter's live prices and rules. No money is at Lighter.";
    case "live":
      return "Real-money perpetuals at Lighter, within the limits the owner set.";
    case "refuse":
      return "Perpetuals are switched on but the agent is not opening positions (see blocker). Anything still held keeps its stops, and closes still run.";
  }
}

/** A position, in the tool's shape. Every venue figure the report did not carry stays null. */
function positionOut(p: PerpsReportPosition) {
  return {
    market: p.market,
    side: p.side,
    size: p.baseAmount,
    entry_price: p.entryPrice,
    mark_price: p.markPrice,
    leverage: p.leverage,
    margin_usdg: usdgOf(p.marginMicro)!,
    liquidation_price: p.liqPrice,
    unrealized_pnl_usdg: usdgOf(p.unrealizedMicro),
    stop_trigger: p.stopTrigger,
    stop_seen_resting: p.stopTrigger !== null,
    funding_usdg: usdgOf(p.fundingMicro),
  };
}

const money = (x: number) => `${x.toFixed(2)} USDG`;

/**
 * The one line get_portfolio and get_exposure add to their warnings, or null
 * when there is nothing to say: no report at all, or a report reading none.
 * An agent that never touched perps must not grow a line on every portfolio;
 * one whose report could not be read must, because unknown is not zero.
 */
export function perpsPortfolioLine(read: ReportRead | undefined): string | null {
  if (!read || read.state === "not_reported") return null;
  if (read.state === "unreadable") {
    return "Perpetuals: the agent's perpetuals report could not be read, so whether anything is held at Lighter is unknown (not zero).";
  }
  const exposure = exposureOf(read);
  if (exposure === "none") return null;
  const r = read.report;
  const { book } = bookOf(r);
  const label = book === "paper" ? "paper, simulated money" : book === "live" ? "live, real funds" : "book not stated";
  if (r.collateralMicro === null) {
    return `Perpetuals (${label}): ${placeOf(book)} could not be read at the last check, so leveraged positions may be open; they are not listed under positions.`;
  }
  const n = r.positions.length;
  const collateral = usdgOf(r.collateralMicro)!;
  const where = book === "paper" ? "in the paper book" : "at Lighter";
  return `Perpetuals (${label}): ${n} leveraged position${n === 1 ? "" : "s"} and ${money(collateral)} of collateral ${where}, not listed under positions.`;
}

/**
 * Where the money is, in one sentence. Never "your funds stay in your smart
 * account": that sentence belongs to custodySentence's `none`, on the kill
 * path, and this is not it. An account that reads empty at the venue is said
 * to read empty, and that is all.
 */
function custodyOf(read: ReportRead | undefined, book: Book | null): string {
  if (!read || read.state === "not_reported") {
    return "Merrymen has no perpetuals report for this agent, so whether anything is held at Lighter is unknown.";
  }
  if (read.state === "unreadable") return "The agent's perpetuals report could not be read, so whether anything is held at Lighter is unknown.";
  const r = read.report;
  if (r.collateralMicro === null) {
    if (book === "paper") {
      return "The paper book could not be read at the last check, so which practice positions are open is unknown. Nothing is at Lighter.";
    }
    return "Lighter could not be read at the last check, so what is held there is unknown: positions, their resting stops and collateral may be there. The positions listed are the agent's own records, with the figures only Lighter knows left empty.";
  }
  if (exposureOf(read) === "none") {
    return book === "paper" ? "The paper book holds no perpetual positions." : "Lighter reads empty for this agent: no positions, collateral or money in transit.";
  }
  if (book === "paper") return "Simulated: these positions and their collateral are practice money in the paper book. Nothing is at Lighter.";
  return "Positions and collateral at Lighter are not in the smart account. Closing them is a reduce-only order at Lighter, which needs Lighter to be reachable; money comes back only to the agent's own smart account, after Lighter's withdrawal delay and a claim.";
}

// ── get_perp_positions ──────────────────────────────────────────────────────

const PERP_POSITION = z.object({
  market: z.string().describe("Market key, such as BTC-PERP"),
  side: z.enum(["long", "short"]),
  size: z.string().describe("Position size in the market's base asset, as a decimal string in the venue's own precision"),
  entry_price: z.string(),
  mark_price: z.string().nullable().describe("Null when no fresh mark was read: unknown, not zero"),
  leverage: z.number().nullable(),
  margin_usdg: z.number().describe("USDG allocated to this isolated position"),
  liquidation_price: z.string().nullable().describe("Where the venue would liquidate this position; null when it was not read"),
  unrealized_pnl_usdg: z.number().nullable(),
  stop_trigger: z.string().nullable().describe("Trigger price of the stop seen resting at the venue; null when none was seen"),
  stop_seen_resting: z.boolean().describe("False when no stop was seen resting at the venue for this position, including when its state was not read"),
  funding_usdg: z.number().nullable().describe("Funding booked on this position so far, as the worker reports it; null when it is not known"),
});

const PERPS_OUTPUT = z.object({
  agent: z.string(),
  account: z.string().nullable().describe("The smart account the report is of"),
  account_is_current: z.boolean().describe("False when the agent has no current signed permission and the report is of its most recent earlier account"),
  venue: z.string(),
  report: z.enum(["reported", "not_reported", "unreadable"]).describe("reported: the worker's report parsed; not_reported: the worker has not written one; unreadable: one exists but could not be read"),
  report_explained: z.string(),
  perps_mode: z.enum(["off", "paper", "live", "refuse"]).nullable(),
  perps_mode_explained: z.string(),
  book: z.enum(["paper", "live"]).nullable().describe("paper: simulated money; live: real funds at Lighter; null when the report does not say"),
  money: z.enum(["simulated", "real"]).nullable(),
  book_why: z.string(),
  permission_includes_perps: z.boolean().describe("The signed permission carries the perpetuals marker, which live perpetuals need"),
  blocker: z.object({ code: z.string(), what: z.string(), remedy: z.string().nullable() }).nullable().describe("Why no new positions open, when something stops them"),
  exposure: z.enum(["none", "held", "unknown"]).describe("none: every figure was read and is zero; held: something is there; unknown: it could not be established"),
  venue_state: z.enum(["read", "unread", "unknown"]).describe("read: the last check read the book; unread: Lighter (or the paper book) could not be read; unknown: no readable report"),
  venue_read_at: z.string().nullable(),
  protect_checked_at: z.string().nullable().describe("The worker's last protective pass (stops, liquidation distance)"),
  worker_heartbeat_at: z.string().nullable(),
  worker_fresh: z.boolean().nullable().describe("The worker reported within its freshness window; a stale worker means a stale report"),
  account_index: z.number().nullable().describe("The Lighter account index; null for paper or when not known"),
  positions: z.array(PERP_POSITION),
  positions_complete: z.boolean().describe("False when the list may leave out positions or figures (Lighter unread, or no readable report)"),
  totals: z.object({
    open_notional_usdg: z.number().nullable(),
    collateral_usdg: z.number().nullable().describe("USDG posted at the venue (cross collateral and isolated margin), before unrealized P&L"),
    in_transit_usdg: z.number().nullable().describe("USDG on its way to or from the venue"),
  }),
  min_liquidation_distance_pct: z.number().nullable().describe("How far the nearest position's mark is from its liquidation price"),
  stops_missing: z.number().nullable().describe("Positions with no stop seen resting at the venue"),
  incident: z.boolean().nullable().describe("The venue shows activity the agent did not sign; new positions are refused until the owner clears it"),
  custody: z.string(),
  controls: z.string(),
  notes: z.array(z.string()),
  warnings: z.array(z.string()),
  observed_at: z.string(),
});
type PerpsOut = z.infer<typeof PERPS_OUTPUT>;

const VENUE = "Lighter (its Robinhood Chain instance)";

/**
 * Owner exits are reviewed on the dashboard or confirmed in Telegram. This
 * MCP surface remains read-only and cannot carry a close or consent itself.
 */
const CONTROLS =
  "Read-only here. Perpetuals are switched on and off, and their limits set, only on the Merrymen dashboard, in Settings under Perpetuals. " +
  "The desk's Close and Close all controls open a review naming paper or real-money positions. Telegram supports /close MKT-PERP and /flatten; close-all always requires confirmation and halts new entries until resumed in dashboard Settings. " +
  "An exit request can be refused or partly filled; check the worker's result. Kill requests a stand-down only when that server's shutdown runner is available. " +
  "With the owner key, `merrymen recover` can revoke the agent's Lighter key and withdraw free collateral, but it cannot close positions. " +
  "This connection cannot open, close or move anything.";

const NOTES = [
  "Paper perpetuals are simulated at Lighter's live prices and rules; their figures are practice money and are never added to live ones.",
  "Live figures come from Lighter's own records (attested by the venue), not from Robinhood Chain receipts.",
  "A null figure was not read: unknown, not zero.",
  "A stop resting at Lighter is an order with a worst price: a fast move through that price can leave the position open, and a stop expires after at most 28 days, so the worker re-places it while it runs.",
  "Merrymen publishes no perpetual position anywhere, but Lighter shows every account's positions publicly, by account index or address.",
];

function reportExplained(read: ReportRead | undefined): string {
  if (!read || read.state === "not_reported") {
    return "The agent's worker has not reported on perpetuals (it may predate them, or has not run since). That is unknown, not \"no positions\".";
  }
  if (read.state === "unreadable") {
    return read.cause === "parse"
      ? "A perpetuals report exists but this server cannot read it, so what it says is unknown."
      : "The perpetuals report could not be read from the ledger just now, so what it says is unknown.";
  }
  return "The worker's latest perpetuals report.";
}

function perpsOut(a: OwnedAgent, account: string | null, read: ReportRead | undefined, warnings: string[], now: number, freshSec: number): PerpsOut {
  const report = read?.state === "reported" ? read.report : null;
  const beatAt = read?.beatAt ?? null;
  const bk = report ? bookOf(report) : { book: null, why: "No readable report, so which book is unknown." };
  const blocker = report?.blocker ? { code: report.blocker, ...perpsBlockerText(report.blocker) } : null;
  const venueState: PerpsOut["venue_state"] = !report ? "unknown" : report.collateralMicro === null ? "unread" : "read";
  return {
    agent: a.slug,
    account,
    account_is_current: account !== null && account === a.account,
    venue: VENUE,
    report: read?.state ?? "not_reported",
    report_explained: reportExplained(read),
    perps_mode: report?.mode ?? null,
    perps_mode_explained: report ? modeExplained(report) : "Not reported.",
    book: bk.book,
    money: bk.book === "paper" ? "simulated" : bk.book === "live" ? "real" : null,
    book_why: bk.why,
    permission_includes_perps: a.features.includes(GRANT_PERP_LIGHTER),
    blocker,
    exposure: exposureOf(read),
    venue_state: venueState,
    venue_read_at: report ? isoMs(report.venueReadAt) : null,
    protect_checked_at: report ? isoMs(report.protectAt) : null,
    worker_heartbeat_at: isoOrNull(beatAt),
    worker_fresh: beatAt === null ? null : now - beatAt <= freshSec,
    account_index: report?.accountIndex ?? null,
    positions: report ? report.positions.map(positionOut) : [],
    positions_complete: venueState === "read" && report !== null && unlistedPositions(report) === 0,
    totals: {
      open_notional_usdg: usdgOf(report?.openNotionalMicro ?? null),
      collateral_usdg: usdgOf(report?.collateralMicro ?? null),
      in_transit_usdg: usdgOf(report?.inTransitMicro ?? null),
    },
    min_liquidation_distance_pct: report?.minLiqDistanceBps === null || report?.minLiqDistanceBps === undefined ? null : report.minLiqDistanceBps / 100,
    stops_missing: report ? report.stopsMissing : null,
    incident: report ? report.incident : null,
    custody: custodyOf(read, bk.book),
    controls: CONTROLS,
    notes: NOTES,
    warnings,
    observed_at: iso(now),
  };
}

function summaryOf(o: PerpsOut): string {
  if (o.report !== "reported") return `${o.agent}: no readable perpetuals report; whether anything is held at Lighter is unknown.`;
  if (o.venue_state === "unread") return `${o.agent}: ${placeOf(o.book)} could not be read at the last check; leveraged positions may be open.`;
  const label = o.book === "paper" ? "paper perpetuals (simulated)" : o.book === "live" ? "live perpetuals (real funds)" : "perpetuals (book not stated)";
  if (o.exposure === "none") {
    const state = o.perps_mode === "off" ? "perpetuals are off" : o.book === null ? "perpetuals are not opening positions" : label;
    return `${o.agent}: ${state}; nothing held.`;
  }
  const n = o.positions.length;
  const c = o.totals.collateral_usdg;
  return `${o.agent}: ${label}: ${n} position${n === 1 ? "" : "s"}${c === null ? "" : `, ${money(c)} collateral`}${o.stops_missing ? `, ${o.stops_missing} without a stop seen resting` : ""}${o.incident ? "; unknown activity flagged" : ""}.`;
}

/** The account whose report this is: the current one, else (after a kill or before a re-sign) the most recent earlier one. */
function reportAccount(a: OwnedAgent): string | null {
  return a.account ?? a.accounts[0] ?? null;
}

async function freshSecOf(ctx: ToolContext): Promise<number> {
  const s = await settingsReader().settingsFor(ctx.principal.tenant).catch(() => null);
  return freshWithin(s?.tickSeconds);
}

const getPerpPositions = defineTool({
  name: "get_perp_positions",
  title: "Perpetual positions",
  description:
    "The agent's perpetual futures on Lighter (Robinhood Chain), as its worker last reported them: whether perpetuals are off, on paper (simulated money) or live (real funds), and what stops new positions; each position with side, size, entry and mark price, leverage, margin, liquidation price, unrealized P&L, funding and the stop resting at the venue; collateral and money in transit; and when Lighter was last read. Unknown figures are null, not zero, and when Lighter could not be read or the worker has not reported, the result says so instead of listing no positions. Read-only: it cannot open, close or move anything.",
  capability: "portfolio.read",
  input: z.object({ agent: AGENT_ARG }).strict(),
  output: PERPS_OUTPUT,
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler({ agent }, ctx) {
    const a = await ctx.agent(agent);
    const now = ctx.now();
    const fresh = await freshSecOf(ctx);
    const account = reportAccount(a);
    const reads = await ctx.ledger((db) => readPerpsReports(db, a.accounts.length ? a.accounts : account ? [account] : []));
    const read = account ? reads.get(account.toLowerCase()) : undefined;
    const warnings: string[] = [];
    if (read?.state === "reported") {
      const unlisted = unlistedPositions(read.report);
      if (unlisted > 0) warnings.push(`${unlisted} more position${unlisted === 1 ? " is" : "s are"} held than listed: the worker could not describe ${unlisted === 1 ? "it" : "them"}, and no stop was seen resting for ${unlisted === 1 ? "it" : "them"}.`);
    }
    if (account !== null && account !== a.account) {
      warnings.push("The agent has no current signed permission; this is the report of its most recent account, which may still hold positions at Lighter.");
    }
    // Rule 5 refuses to re-sign away from a non-flat venue account, but a
    // kill or an old app build can still leave one behind: say so, by account.
    for (const other of a.accounts) {
      if (other === account) continue;
      const r = reads.get(other.toLowerCase());
      const e = exposureOf(r);
      if (r && r.state !== "not_reported" && e !== "none") {
        warnings.push(`An earlier account of this agent (${other}) reports perpetuals ${e === "held" ? "still held" : "it could not read"} at Lighter.`);
      }
    }
    const data = perpsOut(a, account, read, warnings, now, fresh);
    return { data, summary: summaryOf(data) };
  },
});

export const PERPS_TOOLS = [getPerpPositions];
