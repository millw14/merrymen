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
 * LIVE AGENTS ONLY. The feed includes paper agents, on purpose — a reasoning is
 * true or false regardless of whose money is behind it, and excluding them once
 * emptied the feed entirely because paperTradingEnabled defaults true. A
 * RANKING is the opposite case: mixing pretend capital into a table of returns
 * is a lie, and the lie favours whoever is pretending.
 *
 * NULL IS NOT ZERO. An agent with no deposit on record has an UNKNOWN return,
 * not a flat one, and publishing "equity minus nothing" as performance is the
 * bankroll dressed up as a result. Those agents are returned with pnlPct null
 * and sorted last; the page renders them as "unranked", never as 0.0%.
 *
 * No session read anywhere in this file — same property as read-theses, and the
 * same reason: it is what makes the caller cacheable.
 */
import { withReadDb } from "@/lib/ledger";
import { getIdentityStore } from "@merrymen/identity-store";
import { rankPnl, type UnrankedWhy } from "@/lib/rank-pnl";

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
  /** Return over capital contributed, in basis points. Null = unknown. */
  pnlBps: number | null;
  /** Deepest peak-to-trough this epoch, in bps. Null = no history to measure. */
  maxDdBps: number | null;
  landed: number;
  refused: number;
  /** Equity points, oldest first, for the sparkline. Normalised, never dollars. */
  curve: number[];
}

export interface LeaderboardRead {
  source: "sqlite" | "none";
  agents: LeaderRow[];
}

/** Points in the sparkline. Enough to show a shape, few enough to inline. */
const CURVE_POINTS = 40;


export async function readLeaderboard(): Promise<LeaderboardRead> {
  return withReadDb(async (db): Promise<LeaderboardRead> => {
    if (!db) return { source: "none", agents: [] };

    const slugFor = new Map<string, string>();
    try {
      for (const id of await getIdentityStore().all()) {
        for (const a of id.accounts) slugFor.set(a.toLowerCase(), id.slug);
      }
    } catch {
      /* rows render unlinked */
    }

    let rows: {
      smart_account: string;
      name: string;
      x_handle: string | null;
      epoch: number;
    }[] = [];
    try {
      rows = (await db
        .prepare(
          `SELECT smart_account, name, x_handle, COALESCE(epoch, 1) AS epoch
             FROM agents
            WHERE mode = 'live' AND smart_account NOT LIKE 'rh:%'
            ORDER BY created_at DESC
            LIMIT 200`,
        )
        .all()) as typeof rows;
    } catch {
      // A ledger written by an older worker has no `mode`. An empty board is
      // the honest render of that, never a 500.
      return { source: "sqlite", agents: [] };
    }

    const agents = await Promise.all(
      rows.map(async (r): Promise<LeaderRow> => {
        const account = r.smart_account;
        const epoch = Number(r.epoch ?? 1);

        let curve: number[] = [];
        let latest: number | null = null;
        try {
          const pts = (await db
            .prepare(
              `SELECT equity_usdg FROM (
                 SELECT equity_usdg, at, id FROM equity
                  WHERE agent_id = ? AND epoch = ? ORDER BY at DESC, id DESC LIMIT 500
               ) ORDER BY at ASC, id ASC`,
            )
            .all(account, epoch)) as { equity_usdg: number }[];
          const vals = pts.map((p) => Number(p.equity_usdg)).filter((n) => Number.isFinite(n));
          latest = vals.length ? vals[vals.length - 1]! : null;
          // Thinned to a fixed count rather than sent whole: this is a shape,
          // not a dataset, and 200 agents × 500 points is a payload nobody
          // reads.
          const step = Math.max(1, Math.ceil(vals.length / CURVE_POINTS));
          curve = vals.filter((_, i) => i % step === 0);
        } catch {
          /* no equity history yet */
        }

        // Capital in, less capital out. The ARITHMETIC is never windowed, only
        // the chart is — last-minus-first over a sliding window has a "first"
        // that drifts forward, so the published number silently changes meaning.
        let contributed: number | null = null;
        try {
          const f = (await db
            .prepare(
              `SELECT COUNT(*) AS n,
                      COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END), 0) AS net
                 FROM flows WHERE agent_id = ? AND epoch = ?`,
            )
            .get(account, epoch)) as { n: number; net: number } | undefined;
          contributed = !f || Number(f.n) === 0 ? null : Number(f.net);
        } catch {
          /* flows arrives with a worker migration */
        }

        let gasUsdg = 0;
        let landed = 0;
        let refused = 0;
        try {
          const t = (await db
            .prepare(
              `SELECT COALESCE(SUM(CASE WHEN status = 'landed' THEN gas_usdg ELSE 0 END), 0) AS gas,
                      SUM(CASE WHEN status = 'landed' THEN 1 ELSE 0 END) AS landed,
                      SUM(CASE WHEN status IN ('rejected','reverted') THEN 1 ELSE 0 END) AS refused
                 FROM trades WHERE agent_id = ? AND epoch = ?`,
            )
            .get(account, epoch)) as { gas: number; landed: number | null; refused: number | null } | undefined;
          gasUsdg = Number(t?.gas ?? 0);
          landed = Number(t?.landed ?? 0);
          refused = Number(t?.refused ?? 0);
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
        const { pnlBps, unrankedWhy } = rankPnl({ contributed, latest, gasUsdg, landed, contributionsKnown });

        const maxDdBps = drawdownBps(curve);

        return {
          slug: slugFor.get(account.toLowerCase()) ?? null,
          unrankedWhy,
          name: String(r.name ?? "Agent"),
          handle: (r.x_handle ?? "").trim() || null,
          pnlBps,
          maxDdBps,
          landed,
          refused,
          curve,
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

    return { source: "sqlite", agents };
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
