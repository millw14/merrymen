import { readPaperReturn } from "./paper-return";
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
 * granted_at, expires_at, chain_id, and any absolute dollar figure. A ranking
 * needs percentages; a balance sheet is nobody else's business. The same split
 * the daily public report already makes.
 *
 * Every agent something is still running is listed. Only live agents with
 * evidenced returns are ranked; paper and idle agents stay visible and
 * explicitly unranked. Killed, lapsed and unrun agents are folded into a
 * count instead of a row each — see retired-agent.ts for which, and why.
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
import { rankPnl, type UnrankedWhy } from "@/lib/rank-pnl";
import { isRetired } from "@/lib/retired-agent";
import { readMeasuredMark } from "@/lib/held-marks";

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
  /** Deepest peak-to-trough this epoch, in bps. Null = no history to measure. */
  maxDdBps: number | null;
  mode: string;
  filledPaper: number;
  landed: number;
  refused: number;
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
}

/** Points in the sparkline. Enough to show a shape, few enough to inline. */
const CURVE_POINTS = 40;


export async function readLeaderboard(
  readDb = withReadDb,
  identities = () => getIdentityStore().all(),
  nowSec = () => Math.floor(Date.now() / 1000),
): Promise<LeaderboardRead> {
  return readDb(async (db): Promise<LeaderboardRead> => {
    if (!db) return { source: "none", agents: [], retired: null };

    const slugFor = new Map<string, string>();
    // Whether the slugs were READ. Without them every row looks unlinked, and
    // the fold below retires an unlinked row that has not beaten in a day — so
    // a named agent with a good key would leave the board through a quiet
    // worker, and the count of it would be built from data nobody read.
    let slugsRead = false;
    try {
      for (const id of await identities()) {
        for (const a of id.accounts) slugFor.set(a.toLowerCase(), id.slug);
      }
      slugsRead = true;
    } catch {
      /* rows render unlinked, and nothing is folded — see below */
    }

    let rows: {
      smart_account: string;
      name: string;
      x_handle: string | null;
      x_verified: number | null;
      epoch: number;
      mode: string;
    }[] = [];
    try {
      rows = (await db
        .prepare(
          `SELECT smart_account, name, x_handle, COALESCE(x_verified, 0) AS x_verified,
                  COALESCE(epoch, 1) AS epoch, COALESCE(mode, 'idle') AS mode
             FROM agents
            WHERE smart_account NOT LIKE 'rh:%'
            ORDER BY created_at DESC`,
        )
        .all()) as typeof rows;
    } catch {
      // A ledger written by an older worker has no `mode`. An empty board is
      // the honest render of that, never a 500.
      return { source: "sqlite", agents: [], retired: null };
    }

    // One row per public identity after a re-grant; the newest account wins.
    const seen = new Set<string>();
    rows = rows.filter(r => { const key = slugFor.get(r.smart_account.toLowerCase()) ?? r.smart_account.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });

    // RETIRED ACCOUNTS BECOME A COUNT, NOT A ROW EACH. Applied AFTER the slug
    // dedupe, so an identity's older key is one agent re-granted, not a second
    // retired one — for the keys the identity store holds. A key from before
    // the store existed is linked to no slug, so it is folded and counted
    // beside the agent it belonged to, which is why the figure is accounts.
    //
    // Read separately and defensively, for the reason `contributions_known`
    // below is: folding these columns into the SELECT above would turn a ledger
    // that lacks one into an EMPTY BOARD. Here a failed read lists everyone, as
    // before, and reports the count as unknown rather than as zero.
    //
    // AND ONLY WITH THE SLUGS IN HAND. An unread identity store lists everyone
    // the same way. Killed and expired rows could be folded without a slug but
    // not counted: the dedupe above could not collapse an identity's keys
    // either, so its old ones would be counted as agents of their own. And a
    // fold with no count is rows leaving the board without a word.
    let retired: number | null = null;
    if (slugsRead) try {
      type Lifecycle = { mode: string | null; status: string | null; beat_at: number | null; expires_at: number | null };
      const life = new Map<string, Lifecycle>();
      for (const l of (await db
        .prepare(
          `SELECT smart_account, mode, status, beat_at, expires_at FROM agents WHERE smart_account NOT LIKE 'rh:%'`,
        )
        .all()) as (Lifecycle & { smart_account: string })[]) {
        life.set(l.smart_account, l);
      }
      const now = nowSec();
      const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
      const before = rows.length;
      rows = rows.filter((r) => {
        const l = life.get(r.smart_account);
        return !isRetired(
          {
            slug: slugFor.get(r.smart_account.toLowerCase()) ?? null,
            // RAW, not the COALESCEd `r.mode` above: that reads a newborn that
            // has never beaten as idle, and would retire it before its first tick.
            mode: l?.mode ?? null,
            status: l?.status ?? null,
            beatAt: num(l?.beat_at),
            expiresAt: num(l?.expires_at),
          },
          now,
        );
      });
      retired = before - rows.length;
    } catch {
      /* lifecycle columns arrive with worker migrations; unknown until they do */
    }
    const agents = await Promise.all(
      rows.map(async (r): Promise<LeaderRow> => {
        const account = r.smart_account;
        const epoch = Number(r.epoch ?? 1);

        let curve: number[] = [];
        let latest: number | null = null;
        let latestAt: number | null = null;
        try {
          const pts = (await db
            .prepare(
              `SELECT equity_usdg, mode FROM (
                 SELECT equity_usdg, at, id, mode FROM equity
                  WHERE agent_id = ? AND epoch = ? ORDER BY at DESC, id DESC LIMIT 500
               ) ORDER BY at ASC, id ASC`,
            )
            .all(account, epoch)) as { equity_usdg: number; mode: string | null }[];
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
          curve = vals.filter((_, i) => i % step === 0);
          // THE RETURN'S NUMERATOR IS THE NEWEST MEASURED MARK, not the newest
          // mark: one taken while flow inference was held can carry a top-up
          // or a withdrawal not booked yet, and ranks it as profit or loss for
          // as long as the hold lasts — up to 26 hours. Its own read, because
          // a hold that long outruns the 500 rows above.
          const measured = await readMeasuredMark(db, account, epoch);
          latest = measured?.equity ?? null;
          latestAt = measured?.at ?? null;
        } catch {
          /* no equity history yet */
        }

        // Capital in, less capital out. The ARITHMETIC is never windowed, only
        // the chart is — last-minus-first over a sliding window has a "first"
        // that drifts forward, so the published number silently changes meaning.
        //
        // AS OF THE NUMERATOR. During a hold the measured mark is older than
        // the flows booked since (an owner transfer that landed, a settled
        // energy buy), and those are not in its cash: subtracting them ranks
        // the transfer as profit. With no measured mark there is no return,
        // and the reason is decided on every flow, as before.
        let contributed: number | null = null;
        try {
          const f = (await db
            .prepare(
              `SELECT COUNT(*) AS n,
                      COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END), 0) AS net
                 FROM flows WHERE agent_id = ? AND epoch = ?${latestAt === null ? "" : " AND at <= ?"}`,
            )
            .get(account, epoch, ...(latestAt === null ? [] : [latestAt]))) as { n: number; net: number } | undefined;
          contributed = !f || Number(f.n) === 0 ? null : Number(f.net);
        } catch {
          /* flows arrives with a worker migration */
        }

        let gasUsdg = 0;
        let filledPaper = 0;
        let landed = 0;
        let refused = 0;
        try {
          // Operations, not rows — the same count the agent's own page shows,
          // so a redeploy's re-recorded copies cannot double a board figure.
          const t = await readOperationCounts(db, account, epoch, "landed");
          gasUsdg = t.gasUsdg;
          landed = t.landed;
          filledPaper = t.filledPaper;
          refused = t.refused;
        } catch {
          /* older ledger */
        }

        // THE DENOMINATOR'S EVIDENCE, straight from the worker.
        //
        // Read separately and defensively, like `flows` above: the column
        // arrives with a worker migration, and folding it into the agents SELECT
        // would make a pre-migration ledger throw into the catch that returns an
        // EMPTY BOARD. A missing column must cost a quality signal, not the page.
        //
        // Either way the value is null on failure, and null is "not assessed" —
        // which rankPnl treats as unknown rather than as permission.
        let contributionsKnown: boolean | null = null;
        try {
          const q = (await db
            .prepare("SELECT contributions_known FROM agents WHERE smart_account = ?")
            .get(account)) as { contributions_known: number | null } | undefined;
          contributionsKnown =
            q?.contributions_known === null || q?.contributions_known === undefined
              ? null
              : Number(q.contributions_known) === 1;
        } catch {
          /* the column arrives with a worker migration; unknown until it does */
        }
        const { pnlBps, unrankedWhy } = r.mode === "live" ? rankPnl({ contributed, latest, gasUsdg, landed, contributionsKnown }) : { pnlBps: null, unrankedWhy: r.mode === "paper" ? "paper" as const : "inactive" as const };

        const maxDdBps = drawdownBps(curve);

        return {
          slug: slugFor.get(account.toLowerCase()) ?? null,
          unrankedWhy,
          name: String(r.name ?? "Agent"),
          handle: (r.x_handle ?? "").trim() || null,
          handleVerified: Number(r.x_verified ?? 0) !== 0,
          pnlBps,
          paperPnlBps: r.mode === "paper" ? await readPaperReturn(db, account, epoch) : null,
          maxDdBps: pnlBps == null ? null : maxDdBps,
          mode: r.mode,
          filledPaper,
          landed,
          refused,
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

    return { source: "sqlite", agents, retired };
  });
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
