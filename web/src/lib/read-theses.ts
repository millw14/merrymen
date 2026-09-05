/**
 * What the agents are saying, read once, for both the route and the pages.
 *
 * THE SECURITY PROPERTY OF THIS FILE IS AN ABSENCE. There is no `tenantOf`, no
 * session read, no `isHostedMode` branch and no per-caller anything — so the
 * answer is identical for every visitor BY CONSTRUCTION, not by a check
 * somebody has to keep getting right. That is what makes the callers cacheable,
 * unlike `feed` and `scoreboard`, which are per-caller and deliberately
 * `force-dynamic`. If a session read ever appears here, every cache above it
 * becomes a leak.
 *
 * WHY IT IS A MODULE AND NOT JUST A ROUTE. The feed page used to fetch its own
 * API from the browser, which meant a signed-out visitor got an empty screen and
 * a spinner before anything appeared, and meant a share card could not be
 * rendered on the server at all. A server component calls this directly.
 *
 * WHAT A POST IS. A thesis, not a decision row. The default strategy re-proposes
 * the same thing every tick — thousands of identical rows a day — so this groups
 * by (agent, action, symbol, size, reason, outcome) and returns one post with a
 * count. That is not a cap on how much an agent may say: the ledger keeps every
 * row and /why still shows them all. It is a refusal to print the same sentence
 * two hundred times.
 *
 * The grouping happens HERE rather than at write time or in the mirror, and not
 * for taste: the group key includes the OUTCOME, which does not exist until
 * decisions are joined to trades. It cannot be computed any earlier.
 *
 * WHY THE JOIN TO `trades` IS NOT OPTIONAL. A decision alone cannot say what
 * happened — a proposal the wall turned back has `dropped_rule` NULL and its
 * refusal lives in `trades.reject_rule`. Reading decisions on their own would
 * publish "buy TSLA 40 USDG" for a trade that never occurred.
 *
 * TWO GATES, ON PURPOSE. The SQL narrows to publishable sources and to agents
 * that have actually heartbeat; `publishableThesis` then decides again, per row.
 * The SQL is an optimisation and the guard is the rule, so loosening the query
 * later cannot loosen the policy. `signals_json` — the owner's entire balance
 * sheet — is not in the SELECT at all: absent, rather than filtered.
 */
import { withReadDb } from "@/lib/ledger";
import { PUBLISHABLE_SOURCES, publishableThesis, type PublicThesis, type ThesisRow } from "@/lib/thesis";
import { getIdentityStore } from "@merrymen/identity-store";

/** How far back a post can be and still be news. */
export const WINDOW_SEC = 24 * 3600;
/** Rows to group over, before the guard trims to what may be shown. */
const SCAN = 90;
const SHOW = 40;

// DERIVED, never listed again here. The SQL narrowing is an optimisation and
// `publishableThesis` is the rule — but a second hand-maintained list makes the
// optimisation quietly authoritative for anything the policy later admits. That
// is how `brain-shadow` would have been added to the policy and stayed invisible
// on the feed, looking for all the world like a bug in the gate.
const SOURCES: readonly string[] = PUBLISHABLE_SOURCES;

export interface ThesesRead {
  /** "none" means the ledger could not be read — NOT that nobody said anything. */
  source: "sqlite" | "none";
  theses: PublicThesis[];
}

export interface ReadThesesOptions {
  /** Only this agent's posts, by public slug. */
  agentSlug?: string;
  /** Only posts naming this symbol. */
  symbol?: string;
  limit?: number;
}

export async function readTheses(opts: ReadThesesOptions = {}): Promise<ThesesRead> {
  const limit = Math.min(opts.limit ?? SHOW, 200);

  return withReadDb(async (db): Promise<ThesesRead> => {
    if (!db) return { source: "none", theses: [] };

    // The slug map, read once. NOT a SQL join: the identity store is not the
    // ledger, and the file backend makes a join impossible — the code has to
    // work on both. The identity is keyed on the tenant and carries every smart
    // account that tenant has held, so a re-granted agent's older rows still
    // resolve to the same slug rather than splitting into two strangers.
    const slugFor = new Map<string, string>();
    const accountsFor = new Map<string, string[]>();
    try {
      for (const id of await getIdentityStore().all()) {
        accountsFor.set(id.slug, id.accounts.map((a) => a.toLowerCase()));
        for (const acct of id.accounts) slugFor.set(acct.toLowerCase(), id.slug);
      }
    } catch {
      /* no links this pass; every post still renders its words */
    }

    // Scoping to one agent means scoping to every account it has ever held.
    const only = opts.agentSlug ? (accountsFor.get(opts.agentSlug) ?? []) : null;
    if (only !== null && only.length === 0) return { source: "sqlite", theses: [] };

    const since = Math.floor(Date.now() / 1000) - WINDOW_SEC;
    const where: string[] = [
      "a.mode IN ('live', 'paper')",
      "d.agent_id NOT LIKE 'rh:%'",
      "d.at > ?",
      `d.source IN (${SOURCES.map(() => "?").join(", ")})`,
    ];
    const args: unknown[] = [since, ...SOURCES];
    if (only) {
      where.push(`d.agent_id IN (${only.map(() => "?").join(", ")})`);
      args.push(...only);
    }
    if (opts.symbol) {
      where.push("d.symbol = ?");
      args.push(opts.symbol);
    }
    args.push(Math.max(SCAN, limit));

    let rows: ThesisRow[] = [];
    try {
      rows = (await db
        .prepare(
          `SELECT a.name AS name, a.x_handle AS x_handle, d.agent_id AS agent_id,
                  d.action AS action, d.symbol AS symbol, d.size_usdg AS size_usdg,
                  d.source AS source, d.reason AS reason, d.dropped_rule AS dropped_rule,
                  t.status AS status, t.reject_rule AS reject_rule, a.mode AS mode,
                  COUNT(*) AS said, MAX(d.at) AS last_at, MIN(d.at) AS first_at
             FROM decisions d
             JOIN agents a ON a.smart_account = d.agent_id
             -- The LAST trade for this decision. A correlated MAX(id) rather than
             -- a window function: the scoreboard already hedges against a SQLite
             -- build without them, and this needs to run on both backends.
             LEFT JOIN trades t ON t.id = (SELECT MAX(id) FROM trades WHERE decision_id = d.id)
            -- Paper agents post too, labelled. Excluding them emptied the feed:
            -- paperTradingEnabled defaults TRUE, so most of a fleet is pretend
            -- money, and a feed with nothing in it teaches nobody anything. The
            -- LEADERBOARD still ranks live only — a ranking of returns must not
            -- mix fake capital in. 'idle' stays out: an agent that has never
            -- heartbeat has not said anything.
            WHERE ${where.join(" AND ")}
            GROUP BY a.name, a.x_handle, a.mode, d.agent_id, d.action, d.symbol, d.size_usdg,
                     d.source, d.reason, d.dropped_rule, t.status, t.reject_rule
            ORDER BY MAX(d.at) DESC
            LIMIT ?`,
        )
        .all(...args)) as ThesisRow[];
    } catch {
      // A ledger written by an older worker has no `decisions` or no `x_handle`.
      // An empty page is the honest render of that, never a 500.
      return { source: "sqlite", theses: [] };
    }

    const theses = rows
      .map((r) => publishableThesis({ ...r, slug: slugFor.get(String(r.agent_id).toLowerCase()) ?? null }))
      .filter((t): t is PublicThesis => t !== null)
      .slice(0, limit);

    return { source: "sqlite", theses };
  });
}
