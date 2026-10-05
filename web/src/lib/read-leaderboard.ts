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
import { isRetired, notRunning as heldNotRunning, type AgentLifecycle } from "@/lib/retired-agent";
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
  readSettings: (tenant: `0x${string}`) => Promise<{ publicBook?: boolean } | null> = (tenant) => getSettingsStore().get(tenant),
): Promise<LeaderboardRead> {
  return readDb(async (db): Promise<LeaderboardRead> => {
    if (!db) return { source: "none", agents: [], retired: null };

    const slugFor = new Map<string, string>();
    const tenantFor = new Map<string, `0x${string}`>();
    // Whether the slugs were READ. Without them every row looks unlinked, and
    // the fold below retires an unlinked row that has not beaten in a day — so
    // a named agent with a good key would leave the board through a quiet
    // worker, and the count of it would be built from data nobody read.
    let slugsRead = false;
    try {
      for (const id of await identities()) {
        for (const a of id.accounts) {
          slugFor.set(a.toLowerCase(), id.slug);
          tenantFor.set(a.toLowerCase(), id.tenant);
        }
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
      // Aliases of one address describe one account, whose epoch and heartbeat
      // identify the current run. Only after choosing that run may registration
      // time choose among an identity's different accounts after a re-grant.
      let beat = "COALESCE(NULL, 0)";
      try {
        await db.prepare("SELECT beat_at FROM agents WHERE 1 = 0").all();
        beat = "COALESCE(beat_at, 0)";
      } catch { /* older ledgers have no heartbeat column */ }
      rows = (await db
        .prepare(
          `WITH registrations AS (
             SELECT smart_account, name, x_handle, COALESCE(x_verified, 0) AS x_verified,
                    COALESCE(epoch, 1) AS epoch, COALESCE(mode, 'idle') AS mode, created_at,
                    ROW_NUMBER() OVER (
                      PARTITION BY LOWER(smart_account)
                      ORDER BY COALESCE(epoch, 1) DESC, ${beat} DESC, created_at DESC, smart_account ASC
                    ) AS alias_rank
               FROM agents WHERE smart_account NOT LIKE 'rh:%'
           )
           SELECT smart_account, name, x_handle, x_verified, epoch, mode
             FROM registrations WHERE alias_rank = 1
            ORDER BY created_at DESC, LOWER(smart_account) ASC`,
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
    // Rows the recovery hold kept on the board that nothing is running.
    const notRunning = new Set<string>();
    if (slugsRead) try {
      type Lifecycle = { mode: string | null; status: string | null; beat_at: number | null; expires_at: number | null };
      const life = new Map<string, Lifecycle>();
      // beat_at IN SECONDS, normalised on its own row: the ledger holds both
      // units, and the incident window is judged against each account's own
      // beat. Never against a MAX over the fleet — one millisecond stamp in it
      // would move every other agent's verdict.
      for (const l of (await db
        .prepare(
          `SELECT smart_account, mode, status,
                  CASE WHEN beat_at > 1e12 THEN beat_at / 1000 ELSE beat_at END AS beat_at,
                  expires_at
             FROM agents WHERE smart_account NOT LIKE 'rh:%'`,
        )
        .all()) as (Lifecycle & { smart_account: string })[]) {
        life.set(l.smart_account, l);
      }
      // THE ACCOUNT'S OWN HOLD ROW, keyed by the tenant that owns it as well
      // as the account, so one tenant's row never speaks for another's agent.
      // Read on its own and defensively: a self-hosted or older ledger has no
      // such table, and a read that fails for any reason is no hold rather
      // than no board — the beat window below still speaks for each account.
      const held = new Set<string>();
      try {
        for (const h of (await db
          .prepare(`SELECT tenant, smart_account FROM fleet_recovery_health WHERE held = 1`)
          .all()) as { tenant: unknown; smart_account: unknown }[]) {
          held.add(`${String(h.tenant).toLowerCase()} ${String(h.smart_account).toLowerCase()}`);
        }
      } catch {
        /* no recovery table: nothing is held */
      }
      const now = nowSec();
      const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
      const before = rows.length;
      rows = rows.filter((r) => {
        const l = life.get(r.smart_account);
        const account = r.smart_account.toLowerCase();
        const tenant = tenantFor.get(account);
        const lifecycle: AgentLifecycle = {
          slug: slugFor.get(account) ?? null,
          // RAW, not the COALESCEd `r.mode` above: that reads a newborn that
          // has never beaten as idle, and would retire it before its first tick.
          mode: l?.mode ?? null,
          status: l?.status ?? null,
          beatAt: num(l?.beat_at),
          expiresAt: num(l?.expires_at),
          held: tenant !== undefined && held.has(`${tenant.toLowerCase()} ${account}`),
        };
        if (isRetired(lifecycle, now)) return false;
        if (heldNotRunning(lifecycle, now)) notRunning.add(r.smart_account);
        return true;
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
        try {
          // Operations, not rows — the same count the agent's own page shows,
          // so a redeploy's re-recorded copies cannot double a board figure.
          const t = await readOperationCounts(db, account, epoch, "landed");
          landed = t.landed;
          filledPaper = t.filledPaper;
          refused = t.refused;
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
