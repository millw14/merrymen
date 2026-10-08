/**
 * WHAT THE OWNER'S SCREENS MAKE OF THE WORKER'S PERPS REPORT — pure, and safe
 * in the browser (docs/perps.md rules 11, 13 and 17, and "Surfaces").
 *
 * `agents.perps` is the worker's own statement (core perps.ts PerpsReport),
 * read by lib/agent-perps.ts on the server and never computed here. This file
 * turns that one statement into the three things the web says with it:
 *
 *   perpsFeedOf           the desk's rows and account line (/api/feed `perps`
 *                         and `perpsAccount`), money in whole USDG like every
 *                         other `_usdg` field the feed serves
 *   perpExposureOfReport  the PerpExposure every kill and discard sentence is
 *                         built from, through core's custodySentence — never a
 *                         constant
 *   killWarning           what a kill does to perps, said BEFORE it is confirmed
 *                         — and on hosted, that it does NOT close them yet
 *
 * PRACTICE IS NEVER SHOWN AS REAL. Which money a report lists is perpsBookOf's
 * answer — the report's own mode is the perps rail, which reads "off" while a
 * practice position is still held — and a book it cannot place is said as not
 * known, never drawn as real money at Lighter.
 *
 * UNKNOWN IS NEVER NONE (rule 11). A report that is absent, malformed, stale,
 * or that says Lighter could not be read is shown as exactly that: the desk
 * says it cannot see, the custody sentence says what may still be there, and
 * nothing anywhere renders "no positions" or "your funds stay in your smart
 * account" on the strength of a read that did not happen.
 *
 * No I/O and no worker imports: KillSwitch and the terminal bundle this.
 */
import {
  custodySentence,
  GRANT_PERP_LIGHTER,
  perpsBlockerText,
  type PerpBlocker,
  type PerpExposure,
  type PerpsReport,
  type PerpsReportPosition,
} from "@merrymen/core";

/**
 * HOW OLD A VENUE READ MAY BE AND STILL DESCRIBE NOW.
 *
 * The lane rewrites `agents.perps` on every read that changes it (each tick,
 * and the protective loop's ≤15 s passes), and hosted the ledger mirror carries
 * it up on its own clock — the desk already allows ~5.5 minutes for a grant to
 * travel that path. Three times that, rounded, is a read the worker has
 * stopped refreshing: its rows are still shown, dated, but no longer called
 * current, and a kill sentence built on it says Lighter is unread rather than
 * repeating an old count as fact.
 */
export const PERPS_REPORT_STALE_MS = 15 * 60_000;

/**
 * The report as read, three-valued like every other worker report here.
 *
 *   not-said    no row, a NULL column, or a ledger from before the column —
 *               the worker has not spoken (a fresh arm, an older worker)
 *   unreadable  the column holds something that is not a v1 report, or the
 *               ledger read failed: the worker spoke and we cannot tell what
 *               it said — which is "unknown", never "empty"
 *   ok          parsed by core's whitelist parser
 */
export type PerpsReportRead =
  | { state: "not-said" }
  | { state: "unreadable" }
  | {
      state: "ok";
      report: PerpsReport;
      /**
       * The account's own book, from the same agents row: `agents.mode`, the
       * worker's heartbeat ("paper" | "live" | "idle"), or null/absent when it
       * was not read. Needed because the report's `mode` is the perps RAIL,
       * not the book — see perpsBookOf.
       */
      accountMode?: string | null;
    };

// ── which book: practice or real ────────────────────────────────────────────

/**
 * IS WHAT THIS REPORT LISTS PRACTICE MONEY OR REAL MONEY AT LIGHTER? Null when
 * the report does not say — and null is never read as real.
 *
 * The report's `mode` is the perps RAIL (worker exec-mode.ts perpsModeOf), not
 * the book. A paper account that switches practice perps off — or whose rail
 * is refused (the operator's ceiling) — while a practice position is still
 * open gets `mode: "off"`/`"refuse"` WITH that paper position and the paper
 * collateral (worker perps/lane.ts readPaperLocked: `active = rail.mode ===
 * "paper" || held`). Reading "not paper" as "real" showed practice money as
 * real money at Lighter: an unlabelled desk, "At Lighter", a kill warning
 * about closing a Lighter position at market, `merrymen recover`.
 *
 *   mode paper                  practice
 *   mode live                   real
 *   an account index            real — the paper book never has one (worker
 *                               perps/view.ts); the MCP tool's bookOf rule
 *   otherwise, the account's    what the account itself runs: the rule the
 *   own book (accountMode)      iOS and Android banners use
 *   otherwise                   null: not said
 */
export type PerpsBook = "paper" | "live";

export function perpsBookOf(report: PerpsReport, accountMode: string | null | undefined): PerpsBook | null {
  if (report.mode === "paper") return "paper";
  if (report.mode === "live") return "live";
  if (report.accountIndex !== null) return "live";
  if (accountMode === "paper") return "paper";
  if (accountMode === "live") return "live";
  return null;
}

/**
 * DOES THIS GRANT HAVE ANYTHING TO DO WITH PERPS? Inclusive on purpose: the
 * marker OR a perp block, whether or not core's strict `grantPerp` would
 * accept it. The answer only ever makes a surface MORE careful — a kill asks
 * the worker to stand down, a missing report reads as unread rather than as
 * none — so a half-formed block must count, not be waved through.
 */
export function grantMentionsPerps(grant: unknown): boolean {
  if (typeof grant !== "object" || grant === null) return false;
  const g = grant as { grantFeatures?: unknown; perp?: unknown };
  if (Array.isArray(g.grantFeatures) && g.grantFeatures.includes(GRANT_PERP_LIGHTER)) return true;
  return typeof g.perp === "object" && g.perp !== null;
}

// ── numbers ─────────────────────────────────────────────────────────────────

const INT_RE = /^-?\d{1,40}$/;

/** micro-USDG (decimal integer string) → bigint, or null for null or anything else. */
function micro(s: string | null): bigint | null {
  return s !== null && INT_RE.test(s) ? BigInt(s) : null;
}

/** micro-USDG → whole USDG for a screen. Display only: every sum is done in bigint first. */
function usd(m: bigint | null): number | null {
  return m === null ? null : Number(m) / 1_000_000;
}

/**
 * How far the mark is from liquidation, in percent of the mark — positive while
 * the position is safe, rounded to a tenth. Null when either price is missing:
 * a distance computed from a mark nobody read is a number about nothing.
 */
export function liqDistancePct(p: Pick<PerpsReportPosition, "side" | "markPrice" | "liqPrice">): number | null {
  if (p.markPrice === null || p.liqPrice === null) return null;
  const mark = Number(p.markPrice);
  const liq = Number(p.liqPrice);
  if (!Number.isFinite(mark) || !Number.isFinite(liq) || mark <= 0 || liq <= 0) return null;
  const d = p.side === "long" ? (mark - liq) / mark : (liq - mark) / mark;
  return Math.round(d * 1000) / 10;
}

/** Is this report's venue read too old to describe now? A report with no venue read has nothing to age. */
export function perpsReportIsStale(report: Pick<PerpsReport, "venueReadAt">, nowMs: number): boolean {
  return report.venueReadAt !== null && nowMs - report.venueReadAt > PERPS_REPORT_STALE_MS;
}

// ── the desk (/api/feed) ────────────────────────────────────────────────────

/**
 * ONE PERP POSITION AS /api/feed SERVES IT — beside the spot `positions`,
 * never inside them (rule 11: perp markets live in their own map, keyed
 * `BTC-PERP`, never among the holdings). Prices are the venue's own decimal
 * strings, kept exact; money is whole USDG. Every nullable field is "the
 * report did not say", never zero.
 */
export interface FeedPerpRow {
  market: string;
  side: "long" | "short";
  /**
   * The practice book (perpsBookOf: "paper"). Every surface labels it. False
   * is NOT "real" on its own: the account line's `book` says real, practice
   * or not said.
   */
  paper: boolean;
  /** Base amount in the market's own decimals, e.g. "0.00020". */
  size: string;
  entry_price: string;
  mark_price: string | null;
  /** 2 means 2x. */
  leverage: number | null;
  margin_usdg: number;
  liq_price: string | null;
  /** Percent of the mark between it and liquidation; null without both prices. */
  liq_distance_pct: number | null;
  unrealized_usdg: number | null;
  stop_trigger: string | null;
  funding_usdg: number | null;
  /** Immutable entry profile restored from the position ledger. */
  entry_style?: PerpsReportPosition["entryStyle"];
  style_opened_at_sec?: number;
  hold_deadline_sec?: number;
}

/**
 * THE ACCOUNT LINE BESIDE THE ROWS. `unreadable` is its own state so that a
 * report the web cannot parse is shown as a confession ("Lighter's positions
 * could not be read"), not as a flat book.
 */
export type FeedPerpsAccount =
  | { state: "unreadable" }
  | {
      state: "ok";
      mode: PerpsReport["mode"];
      /** perpsBookOf: which money this is — null when the report does not say, which no surface may draw as real. */
      book: PerpsBook | null;
      paper: boolean;
      /**
       * Anything worth a panel: false only for the known zero of an agent not
       * using perps (off or refused, nothing held, nothing unknown). Unknown
       * money is always active.
       */
      active: boolean;
      /** The report carries a venue (or paper book) read — collateral and in-transit are not null. */
      venue_read: boolean;
      /** Epoch ms of that read; null when the report was not built from one. */
      venue_read_at: number | null;
      stale: boolean;
      /** C + ΣM: USDG posted at the venue, before unrealized P&L. */
      collateral_usdg: number | null;
      /** Deposits landed but not credited, and withdrawals executed but not paid. */
      in_transit_usdg: number | null;
      unrealized_usdg: number | null;
      /**
       * WHAT IS AT LIGHTER, rule 12's perpAccountUsdg: C + ΣM + ΣU + in transit.
       * Null when any term is unread — a partial sum would be a number about
       * part of the account wearing the name of all of it.
       */
      at_lighter_usdg: number | null;
      open_notional_usdg: number | null;
      min_liq_distance_pct: number | null;
      stops_missing: number;
      incident: boolean;
      blocker: PerpBlocker | null;
      blocker_text: string | null;
      blocker_remedy: string | null;
    };

/** Money is held, moving or unknown — the state in which a panel must show. */
function holdsOrUnknown(r: PerpsReport): boolean {
  return (
    r.positions.length > 0 ||
    r.collateralMicro !== "0" ||
    r.inTransitMicro !== "0" ||
    r.incident ||
    r.stopsMissing > 0
  );
}

function feedRow(p: PerpsReportPosition, paper: boolean): FeedPerpRow {
  return {
    market: p.market,
    side: p.side,
    paper,
    size: p.baseAmount,
    entry_price: p.entryPrice,
    mark_price: p.markPrice,
    leverage: p.leverage,
    margin_usdg: usd(micro(p.marginMicro)) ?? 0,
    liq_price: p.liqPrice,
    liq_distance_pct: liqDistancePct(p),
    unrealized_usdg: usd(micro(p.unrealizedMicro)),
    stop_trigger: p.stopTrigger,
    funding_usdg: usd(micro(p.fundingMicro)),
    ...(p.entryStyle !== undefined && p.styleOpenedAtSec !== undefined && p.holdDeadlineSec !== undefined
      ? { entry_style: p.entryStyle, style_opened_at_sec: p.styleOpenedAtSec, hold_deadline_sec: p.holdDeadlineSec }
      : {}),
  };
}

/**
 * The report, as the desk's two feed fields. `perps` is null whenever the
 * report is not readable — not-said and unreadable alike — so a client that
 * only knows the array can never mistake a missing report for an empty book;
 * `perpsAccount` tells the two apart.
 */
export function perpsFeedOf(
  read: PerpsReportRead,
  nowMs: number,
): { perps: FeedPerpRow[] | null; perpsAccount: FeedPerpsAccount | null } {
  if (read.state === "not-said") return { perps: null, perpsAccount: null };
  if (read.state === "unreadable") return { perps: null, perpsAccount: { state: "unreadable" } };
  const r = read.report;
  // THE BOOK, NOT THE RAIL (perpsBookOf): a practice position held while
  // practice perps are off is still practice, and is labelled so.
  const book = perpsBookOf(r, read.accountMode);
  const paper = book === "paper";
  const rows = r.positions.map((p) => feedRow(p, paper));
  const collateral = micro(r.collateralMicro);
  const inTransit = micro(r.inTransitMicro);
  // ΣU over every position; one unread U makes the sum unread.
  let unrealized: bigint | null = 0n;
  for (const p of r.positions) {
    const u = micro(p.unrealizedMicro);
    unrealized = unrealized === null || u === null ? null : unrealized + u;
  }
  const atLighter = collateral === null || inTransit === null || unrealized === null ? null : collateral + inTransit + unrealized;
  const text = r.blocker === null ? null : perpsBlockerText(r.blocker);
  return {
    perps: rows,
    perpsAccount: {
      state: "ok",
      mode: r.mode,
      book,
      paper,
      active: paper || r.mode === "live" || holdsOrUnknown(r),
      venue_read: collateral !== null && inTransit !== null,
      venue_read_at: r.venueReadAt,
      stale: perpsReportIsStale(r, nowMs),
      collateral_usdg: usd(collateral),
      in_transit_usdg: usd(inTransit),
      unrealized_usdg: usd(unrealized),
      at_lighter_usdg: usd(atLighter),
      open_notional_usdg: usd(micro(r.openNotionalMicro)),
      min_liq_distance_pct: r.minLiqDistanceBps === null ? null : Math.round(r.minLiqDistanceBps) / 100,
      stops_missing: r.stopsMissing,
      incident: r.incident,
      blocker: r.blocker,
      blocker_text: text?.what ?? null,
      blocker_remedy: text?.remedy ?? null,
    },
  };
}

// ── custody (kill, discard) ─────────────────────────────────────────────────

/**
 * THE REAL MONEY AT LIGHTER, AS FAR AS THIS REPORT CAN SAY — the PerpExposure
 * every kill and discard sentence is built from (rule 13, via custodySentence).
 *
 *   none     only where the report says no perps: the known zero of an agent
 *            with no venue account (rule 11) — or, with no readable report, a
 *            grant that never carried the perps marker, whose wall cannot
 *            deposit a cent to Lighter (rule 3)
 *   unread   no readable report for a grant that mentions perps; a practice
 *            report for one (the paper book says nothing about a real venue
 *            account); a report that could not read Lighter; one whose read is
 *            stale; or one holding something while not saying whether it is
 *            practice or real (perpsBookOf null — never defaulted to real)
 *   known    everything else, from the report's own figures
 *
 * THE BOOK DECIDES, NOT THE RAIL. A practice position held while practice
 * perps are off comes in a report with `mode: "off"`; `accountMode` (the
 * account's own heartbeat, agents.mode) is what says it is practice.
 *
 * WHAT A REPORT DOES NOT CARRY IS SAID AS UNKNOWN, NOT FILLED WITH ZERO. The
 * report has no count of resting orders, no pool shares, no spot balances at
 * the venue and no sub-accounts, so `otherAccounts` is null — custodySentence
 * then says they could not be read and names the recover path, and never
 * claims Lighter reads empty on figures it was not given.
 *
 * MONEY IN TRANSIT IS COUNTED AS STILL ON LIGHTER. The report carries deposits
 * landed-not-credited and withdrawals executed-not-paid as one figure, with no
 * direction. Both sit in Lighter's settlement contract, so "still on Lighter"
 * is true of either; calling the sum "on its way back" would be false of a
 * deposit, and custody text may overstate what is away, never understate it.
 */
export function perpExposureOfReport(
  report: PerpsReport | null,
  opts: { grantMentionsPerps: boolean; nowMs: number; accountMode?: string | null },
): PerpExposure {
  if (report === null) return opts.grantMentionsPerps ? { kind: "unread" } : { kind: "none" };
  const book = perpsBookOf(report, opts.accountMode);
  if (book === "paper") return opts.grantMentionsPerps ? { kind: "unread" } : { kind: "none" };
  const collateral = micro(report.collateralMicro);
  const inTransit = micro(report.inTransitMicro);
  if (collateral === null || inTransit === null) return { kind: "unread" };
  if (perpsReportIsStale(report, opts.nowMs)) return { kind: "unread" };
  const held =
    report.positions.length > 0 || collateral !== 0n || inTransit !== 0n || report.incident || report.stopsMissing > 0;
  if (!held && report.accountIndex === null) return { kind: "none" };
  // Something is held and the report does not say whose money it is: unknown,
  // never real by default (and never home).
  if (book === null) return { kind: "unread" };
  return {
    kind: "known",
    collateralMicro: collateral + inTransit,
    openPositions: report.positions.length,
    openOrders: 0,
    pendingWithdrawalsMicro: 0n,
    depositsInTransitMicro: 0n,
    poolShareCount: 0,
    spotBalanceCount: 0,
    otherAccounts: null,
    withdrawalDelaySec: null,
  };
}

/**
 * THE HOSTED OWNER'S WAY TO SEE AND UNWIND WHAT IS AT LIGHTER, for core's
 * custodySentence `recover` slot (rule 13: "the recover path for the owner's
 * platform"). The hosted dashboard's Withdraw panel (components/RecoverPanel)
 * shows the venue read-only; the unwind itself is `merrymen recover` with the
 * owner key. Self-hosted keeps core's default, the CLI command. No backticks:
 * the hosted sentence is drawn as plain text on the web and on both phones.
 */
export const HOSTED_RECOVER_PATH = "open Withdraw on the dashboard, which shows what is at Lighter, then run merrymen recover";

/** Where the money is, in the owner's words — core's sentence, never a local constant. `hosted` names the hosted recover path. */
export function custodyText(exposure: PerpExposure, opts?: { hosted?: boolean }): string {
  return opts?.hosted ? custodySentence(exposure, { recover: HOSTED_RECOVER_PATH }) : custodySentence(exposure);
}

/**
 * WHERE THE MONEY IS, FOR A STATUS LINE ABOUT AN AGENT ALREADY KILLED — whose
 * grant is gone, so the perps marker can no longer be consulted.
 *
 * Built from the agent's last report alone: a readable one says what it says
 * (a practice book or the known zero is none — no real venue leg behind it; a
 * held book it cannot place is unread); an unreadable one is unread. A report
 * the worker never wrote makes NO claim at all (null): every worker able to
 * trade perps writes one for each agent it arms, but "never said" is still not
 * proof, so the line says nothing about Lighter rather than sending the money
 * home on an absence.
 */
export function killedCustodyText(read: PerpsReportRead, nowMs: number, opts?: { hosted?: boolean }): string | null {
  if (read.state === "not-said") return null;
  if (read.state === "unreadable") return custodyText({ kind: "unread" }, opts);
  return custodyText(perpExposureOfReport(read.report, { grantMentionsPerps: false, nowMs, accountMode: read.accountMode }), opts);
}

/**
 * WHAT A KILL DOES TO PERPS, said before the owner confirms it (rule 13).
 * Null when there is nothing at Lighter — a spot-only kill needs no warning.
 *
 * WHICH SENTENCE DEPENDS ON WHETHER THIS SERVER STANDS PERPS DOWN AT ALL, and
 * that is the server's to say (GET /api/grants `perpsStanddownOnKill`):
 *
 *   true   the server can request a reduce-only stand-down; success is only
 *          reported after the worker returns its custody result
 *   false  this server cannot request the stand-down
 *   null   the page could not learn which; it cannot promise a close
 */
export function killWarning(exposure: PerpExposure, standsDown: boolean | null): string | null {
  if (exposure.kind === "none") return null;
  const n = exposure.kind === "known" ? exposure.openPositions : null;
  if (standsDown === true) {
    const what =
      n !== null && n > 0
        ? n === 1
          ? "its open perpetual position on Lighter"
          : `its ${n} open perpetual positions on Lighter`
        : exposure.kind === "unread"
          ? "any perpetual positions there (Lighter could not be read)"
          : "any perpetual positions on Lighter";
    return (
      `Stopping the agent requests a stand-down: the worker attempts to close ${what} at market with reduce-only orders, which can realize a loss, ` +
      "and requests withdrawal of free collateral to your smart account after Lighter's delay. A request can fail or leave a partial fill; check the shutdown result for what remains."
    );
  }
  const held =
    n !== null && n > 0
      ? n === 1
        ? "Its open perpetual position on Lighter stays open"
        : `Its ${n} open perpetual positions on Lighter stay open`
      : exposure.kind === "unread"
        ? "Lighter could not be read, so any perpetual positions there stay open"
        : "Any perpetual positions on Lighter stay open";
  const lead =
    standsDown === false
      ? "Stopping the agent here does NOT close its perpetuals: this server cannot stand them down yet."
      : "This page could not confirm that stopping the agent closes its perpetuals, so do not count on it.";
  return (
    `${lead} ${held}, protected only by the stops resting at Lighter — they expire after at most 28 days and nothing ` +
    "re-places them once the agent is stopped — and collateral stays at Lighter. Before stopping, use Close or Close all on the desk to review an exit request; " +
    "a close is only complete when the worker reports the remaining book."
  );
}
