import { readBookPerformance, type BookPerformance } from "./book-performance";
import { readOperationCounts } from "./distinct-trades";
/**
 * WHO IS ACTUALLY ANY GOOD.
 *
 * The existing /api/scoreboard cannot answer this in public. Hosted it scopes
 * to the caller's own agent, deliberately — its own comment calls the unscoped
 * version "a customer-list dump — every tenant's smart account, caps, equity
 * curve, P&L and fees". That judgement is correct and this module does not
 * revisit it. It publishes a DIFFERENT, much narrower row.
 *
 * WHAT IS DELIBERATELY NOT HERE: smart_account (the agent's public id is the
 * slug, which is exactly why the slug exists), caps, hwm_usdg, accrued_fee_usdg,
 * granted_at, expires_at and chain_id. Aggregate trading equity and P&L carry
 * dollars only when the owner explicitly publishes the book; a private book
 * keeps its amounts hidden. Percentages, book and valuation times stay public.
 *
 * Every agent something is still running is listed. Only live agents with
 * evidenced returns are ranked; paper and idle agents stay visible and
 * explicitly unranked. Killed, lapsed and unrun agents are folded into a
 * count instead of a row each — see retired-agent.ts for which, and why — but
 * a named agent the recovery hold silenced is not over, and stays listed as
 * "Not running".
 *
 * NULL IS NOT ZERO. An agent with no deposit on record has an UNKNOWN return,
 * not a flat one, and publishing "equity minus nothing" as performance is the
 * bankroll dressed up as a result. Those agents are returned with pnlPct null
 * and sorted last; the page renders them as "unranked", never as 0.0%.
 *
 * No session read anywhere in this file — same property as read-theses, and the
 * same reason: it is what makes the caller cacheable.
 */
import { sameBookAsLatest } from "@merrymen/core";
import { withReadDb } from "@/lib/ledger";
import { getIdentityStore } from "@merrymen/identity-store";
import type { UnrankedWhy } from "@/lib/rank-pnl";
import { readDirectorySelection } from "./agent-directory";
import { getSettingsStore } from "@merrymen/settings-store";

export interface LeaderRow {
  /** The public id. Null means no identity yet, and the row renders unlinked. */
  slug: string | null;
  /**
   * Why this agent has no rank, when it has none.
   *
   * The page must not guess: "no deposit on record" and "has never filled a
   * trade" are different facts about an agent, and only one of them is fixed by
   * depositing.
   */
  unrankedWhy: UnrankedWhy | null;
  name: string;
  handle: string | null;
  /**
   * Was that handle PROVEN, or merely typed?
   *
   * The handle alone is unverified — the owner typed it and nothing checked
   * they own it — so it renders as plain text. Only this flag, set from a
   * stored xProof, lets a surface turn it into a link to x.com.
   */
  handleVerified: boolean;
  /** Return over capital contributed, in basis points. Null = unknown. */
  pnlBps: number | null;
  paperPnlBps?: number | null;
  /** Same-book aggregate valuation/performance; dollars remain owner opt-in. */
  performance?: BookPerformance;
  /** Deepest peak-to-trough this epoch, in bps. Null = no history to measure. */
  maxDdBps: number | null;
  mode: string;
  /**
   * NOTHING IS RUNNING THIS, AND THE RECOVERY HOLD IS WHY.
   *
   * Set on a named row that has not beaten in a day and that the hold kept on
   * the board instead of folding — see retired-agent.ts. The page says "Not
   * running" and the time of the last valuation, and nothing else: this flag
   * is the whole of what the row says about it, so neither the expiry nor
   * the hold's cause reaches the public payload through it.
   *
   * Optional only so an older server, which does not send it, reads as false.
   */
  notRunning?: boolean;
  filledPaper: number;
  landed: number;
  refused: number;
  /**
   * TRADES, beside those operation counts: distinct swaps and curve trades
   * (readOperationCounts). The row's trade line prints these, so a vault
   * deposit or a simulated transfer is never called a trade.
   */
  paperFills: number;
  liveFills: number;
  /** Equity points, oldest first, for the sparkline. Normalised, never dollars. */
  curve: number[];
}

export interface LeaderboardRead {
  source: "sqlite" | "none";
  agents: LeaderRow[];
  /**
   * How many ACCOUNTS were folded into "Retired accounts (N)" rather than listed.
   *
   * Accounts, not agents: an agent re-granted before the identity store existed
   * left an older account that nothing links to its slug, so that account is
   * folded and counted while the agent itself is listed. Calling the figure
   * agents would overstate how many there have been.
   *
   * NULL WHEN NOBODY COULD TELL — an unreadable ledger, one too old to say how
   * its agents are doing, or an identity store that could not be read. Zero
   * would claim there are none. Nothing is folded when it is null.
   */
  retired: number | null;
  /**
   * THE FOLDED ACCOUNTS THEMSELVES, each with the last return its book
   * recorded — frozen, since nothing runs them. Listed under the count so a
   * reader can see what those agents did; never ranked, and dollars only for
   * a published book, as above. Empty when `retired` is null.
   */
  retiredAgents: RetiredRow[];
}

export interface RetiredRow {
  /** Null for an account the identity store never linked; it has no profile. */
  slug: string | null;
  name: string;
  /** The book its last valuation named: "live", "paper", or null when none. */
  book: "live" | "paper" | null;
  /** Its final return, basis points. Null when it never produced one. */
  pnlBps: number | null;
  /** Final P&L in USDG, only for a published book. */
  pnlUsdg: number | null;
  /** The return leaves out gas costs never recorded (BookPerformance.pnlEstimated). */
  estimated: boolean;
  /** Trades it made: live fills, or paper fills for a paper book. */
  trades: number;
  /** When its book was last valued, unix seconds. */
  lastValuedAt: number | null;
}

/** Points in the sparkline. Enough to show a shape, few enough to inline. */
const CURVE_POINTS = 40;


export async function readLeaderboard(
  readDb = withReadDb,
  identities = () => getIdentityStore().all(),
  nowSec = () => Math.floor(Date.now() / 1000),
  readSettings: (tenant: `0x${string}`) => Promise<{ publicBook?: boolean } | null> = (tenant) => getSettingsStore("spot").get(tenant),
): Promise<LeaderboardRead> {
  return readDb(async (db): Promise<LeaderboardRead> => {
    if (!db) return { source: "none", agents: [], retired: null, retiredAgents: [] };

    const selected = await readDirectorySelection(db, identities, nowSec);
    if (!selected) return { source: "none", agents: [], retired: null, retiredAgents: [] };
    const { rows, slugFor, tenantFor, retired, folded, notRunning } = selected;
    const agents = await Promise.all(
      rows.map(async (r): Promise<LeaderRow> => {
        const account = r.smart_account;
        const epoch = Number(r.epoch ?? 1);

        let curve: number[] = [];
        try {
          const pts = (await db
            .prepare(
              `SELECT equity_usdg, mode FROM (
                 SELECT equity_usdg, at, id, mode FROM equity
                  WHERE LOWER(agent_id) = ? AND epoch = ? ORDER BY at DESC, id DESC LIMIT 500
               ) ORDER BY at ASC, id ASC`,
            )
            .all(account.toLowerCase(), epoch)) as { equity_usdg: number; mode: string | null }[];
          // ONE SERIES, ONE BOOK. A curve that steps from a practice book's
          // 1,000 USDG to a funded book's real equity is published here beside
          // a return, on a page that ranks people.
          //
          // RAW, held marks included (held-marks.ts): the sparkline and the
          // list drawdown below never divide a flow out, so a booking that
          // lands late cannot move them, and a held mark is the value the
          // book had.
          const vals = sameBookAsLatest(pts)
            .map((p) => Number(p.equity_usdg))
            .filter((n) => Number.isFinite(n));
          // Thinned to a fixed count rather than sent whole: this is a shape,
          // not a dataset, and 200 agents × 500 points is a payload nobody
          // reads.
          const step = Math.max(1, Math.ceil(vals.length / CURVE_POINTS));
          // A public shape must never expose the private book's absolute value.
          // Scaling leaves the sparkline identical and gives it no dollar unit.
          const baseline = vals.find((v) => v > 0);
          curve = baseline === undefined ? [] : vals.filter((_, i) => i % step === 0).map((v) => v / baseline);
        } catch {
          /* no equity history yet */
        }

        let filledPaper = 0;
        let landed = 0;
        let refused = 0;
        let paperFills = 0;
        let liveFills = 0;
        try {
          // Operations, not rows — the same count the agent's own page shows,
          // so a redeploy's re-recorded copies cannot double a board figure.
          const t = await readOperationCounts(db, account, epoch, "landed");
          landed = t.landed;
          filledPaper = t.filledPaper;
          refused = t.refused;
          paperFills = t.paperFills;
          liveFills = t.liveFills;
        } catch {
          /* older ledger */
        }

        let publicBook = false;
        try {
          const tenant = tenantFor.get(account.toLowerCase());
          publicBook = tenant !== undefined && (await readSettings(tenant))?.publicBook === true;
        } catch {
          /* identity/settings unavailable: no private amounts published */
        }
        const figures = await readBookPerformance(db, account, epoch, publicBook);
        // A heartbeat is not the book evidence. Never rank a paper valuation
        // under a live heartbeat, or an idle agent's retained book as active.
        const { pnlBps, unrankedWhy } = r.mode === "live" ? figures.liveRank
          : { pnlBps: null, unrankedWhy: r.mode === "paper" ? "paper" as const : "inactive" as const };

        const maxDdBps = drawdownBps(curve);

        return {
          slug: slugFor.get(account.toLowerCase()) ?? null,
          unrankedWhy,
          name: String(r.name ?? "Agent"),
          handle: (r.x_handle ?? "").trim() || null,
          handleVerified: Number(r.x_verified ?? 0) !== 0,
          pnlBps,
          paperPnlBps: r.mode === "paper" ? figures.paperPnlBps : null,
          performance: figures.performance,
          maxDdBps: pnlBps == null ? null : maxDdBps,
          mode: r.mode,
          notRunning: notRunning.has(account),
          filledPaper,
          landed,
          refused,
          paperFills,
          liveFills,
          curve: pnlBps == null ? [] : curve,
        };
      }),
    );

    // Ranked by return, unknown last. Sorting null to zero would silently undo
    // the whole point of publishing it as null.
    agents.sort((a, b) => {
      if (a.pnlBps === null && b.pnlBps === null) return b.landed - a.landed;
      if (a.pnlBps === null) return 1;
      if (b.pnlBps === null) return -1;
      return b.pnlBps - a.pnlBps;
    });

    const retiredAgents = await Promise.all(folded.map(async (r): Promise<RetiredRow> => {
      const account = r.smart_account;
      const epoch = Number(r.epoch ?? 1);
      const tenant = tenantFor.get(account.toLowerCase());
      let publicBook = false;
      try {
        publicBook = tenant !== undefined && (await readSettings(tenant))?.publicBook === true;
      } catch { /* no private amounts published */ }
      let paperFills = 0;
      let liveFills = 0;
      try {
        const t = await readOperationCounts(db, account, epoch, "landed");
        paperFills = t.paperFills;
        liveFills = t.liveFills;
      } catch { /* older ledger */ }
      let p: BookPerformance | null = null;
      try { p = (await readBookPerformance(db, account, epoch, publicBook)).performance; } catch { /* unread: no return */ }
      const bps = p?.pnlBps;
      const book = p?.book ?? null;
      return {
        slug: slugFor.get(account.toLowerCase()) ?? null,
        name: String(r.name ?? "Agent"),
        book,
        pnlBps: typeof bps === "number" && Number.isFinite(bps) ? bps : null,
        pnlUsdg: p?.publicBook && typeof p.pnlUsdg === "number" && Number.isFinite(p.pnlUsdg) ? p.pnlUsdg : null,
        estimated: p?.pnlEstimated === true,
        trades: book === "paper" ? paperFills : liveFills || paperFills,
        lastValuedAt: p?.equityAt ?? null,
      };
    }));
    // Highest final return first, then the ones with none, busiest first.
    retiredAgents.sort((a, b) => {
      if (a.pnlBps === null && b.pnlBps === null) return b.trades - a.trades;
      if (a.pnlBps === null) return 1;
      if (b.pnlBps === null) return -1;
      return b.pnlBps - a.pnlBps;
    });

    return { source: "sqlite", agents, retired, retiredAgents };
  }, "spot");
}

/**
 * Deepest peak-to-trough, in bps. NULL when there is nothing to measure — an
 * epoch with no history has no drawdown, and publishing 0.00% would read as a
 * flawless run rather than an empty one.
 */
function drawdownBps(curve: number[]): number | null {
  if (curve.length < 2) return null;
  let peak = curve[0]!;
  let worst = 0;
  for (const v of curve) {
    if (v > peak) peak = v;
    if (peak > 0) worst = Math.max(worst, (peak - v) / peak);
  }
  return Math.round(worst * 10_000);
}
