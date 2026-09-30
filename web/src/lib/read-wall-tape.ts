/**
 * EVERY INTENT THIS LEDGER RECORDED IN THE LAST DAY, AND WHAT THE WALL DID
 * WITH IT.
 *
 * This feeds a picture, not a table, so it reads the fewest columns that can
 * possibly make one: when it happened, what became of it, and — when the wall
 * turned it back — which rule did the turning. `amount_usdg`, `agent_id`,
 * `tx_hash` and `user_op_hash` are ABSENT rather than filtered, the same
 * discipline read-theses.ts applies to `signals_json`. A graphic cannot leak a
 * column it never selected.
 *
 * WHY THIS IS THE PICTURE. merrymen is a boundary. Its most distinctive fact is
 * that agents are refused constantly and visibly — one live agent is sitting on
 * 1,225 refusals and zero fills — and the product already shipped that fact as
 * a button ("prove the wall") rendered as a list of grey rows. This draws it.
 *
 * NO SESSION READ. No `tenantOf`, no `isHostedMode`, no per-caller anything —
 * which is what keeps every caller cacheable, exactly as read-theses.ts
 * documents. If a session read ever appears here, the caches above it become
 * leaks.
 */
import { withReadDb } from "@/lib/ledger";
import { WINDOW_SEC } from "@/lib/read-theses";
import { REJECT_RULES, outcomeOf } from "@/lib/thesis";
import { getIdentityStore } from "@merrymen/identity-store";
import { distinctTrades, OP_COPY_REACH_SEC } from "@/lib/distinct-trades";

/**
 * Rows examined. PINNED — never widen this to make the picture denser.
 *
 * The band draws what the day actually held; a quiet night is meant to look
 * like a quiet night, and topping it up would make the graphic a decoration
 * that lies about volume.
 */
const CAP = 400;

/** Named lanes, plus one catch-all. More than this and a lane is 2px tall. */
const MAX_NAMED_LANES = 7;

/** What the wall did with it. */
export type Fate = "turned" | "through" | "flight";

export interface WallCell {
  /** Unix seconds. */
  t: number;
  /** Index into `lanes`. */
  lane: number;
  fate: Fate;
}

export interface WallTape {
  /** "none" means the ledger could not be read — NOT that nothing happened. */
  source: "sqlite" | "none";
  /** Oldest first. */
  cells: WallCell[];
  /** Index-aligned labels. The last is always the catch-all. */
  lanes: string[];
  /**
   * How many turned-back intents fell in each lane, index-aligned with `lanes`.
   *
   * OVER THE DRAWN SAMPLE, NOT THE WINDOW — the same rows the band draws, which
   * is at most the most recent `CAP`. `counts` above is the whole window, so
   * these two do NOT sum to `counts.turned` when `capped` is true, and a
   * consumer must publish these as SHARES rather than as totals that would
   * visibly disagree with the headline.
   *
   * The tally already existed — it is what orders the lanes — and was thrown
   * away one line after it was built, so the most informative thing this module
   * knows (which rule actually stops this agent) reached the page as unlabelled
   * amber and nothing else.
   */
  laneCounts: number[];
  /**
   * The WHOLE window, counted — not the drawn sample.
   *
   * These are what the page prints, and `cells` is only what the canvas can
   * hold. Deriving them from the capped rows published "400 turned back in the
   * last day" on a day that had more than four hundred, which is a truncation
   * wearing the clothes of a measurement.
   */
  counts: { intents: number; turned: number; through: number; flight: number };
  /** True when the day held more than the band can draw. */
  capped: boolean;
  from: number;
  to: number;
  /** Stable identity for the render, so an effect does not restart on every poll. */
  key: string;
}

const EMPTY: WallTape = {
  source: "none",
  cells: [],
  lanes: [],
  laneCounts: [],
  counts: { intents: 0, turned: 0, through: 0, flight: 0 },
  capped: false,
  from: 0,
  to: 0,
  key: "0:0",
};

/** The catch-all lane's label — a word the badge vocabulary already ships. */
const CATCH_ALL = "turned back";

export async function readWallTape(opts: { agentSlug?: string } = {}, readDb = withReadDb): Promise<WallTape> {
  // Scoping to an agent means scoping to every account it has ever held; a
  // re-grant must not split its history into two strangers.
  let only: string[] | null = null;
  if (opts.agentSlug) {
    try {
      const id = await getIdentityStore().bySlug(opts.agentSlug);
      only = (id?.accounts ?? []).map((a) => a.toLowerCase());
    } catch {
      only = [];
    }
    if (only.length === 0) return { ...EMPTY, source: "sqlite" };
  }

  return readDb(async (db): Promise<WallTape> => {
    if (!db) return EMPTY;

    const to = Math.floor(Date.now() / 1000);
    const from = to - WINDOW_SEC;

    // ONE OPERATION, ONE CELL. A redeploy re-records every op of the last 26
    // hours, stamped at the restart, and the mirror carried those copies up
    // beside the originals — so the band drew a day's fills again as one burst
    // at the moment of the deploy. The collapse reaches OP_COPY_REACH_SEC past
    // the window so that a copy whose original is just outside the day still
    // has it to collapse into, rather than standing alone inside the day.
    //
    // Only a row WITH a hash can be a copy or have one, so only those reach
    // back; a refusal from before the day is read for nothing.
    const inner = ["t.created_at > ?", "(t.user_op_hash IS NOT NULL OR t.created_at > ?)", "t.agent_id NOT LIKE 'rh:%'"];
    const args: unknown[] = [from - OP_COPY_REACH_SEC, from];
    if (only) {
      inner.push(`LOWER(t.agent_id) IN (${only.map(() => "?").join(", ")})`);
      args.push(...only);
    }
    args.push(from);
    // THE AGENT IS MATCHED THE WAY THE COLLAPSE MATCHES IT, case-blind. The
    // collapse keys on lower(agent_id) and this was an exact join, so when the
    // evidenced original was filed under '0xAbC…' and its copy under the
    // spelling the agents row holds, the collapse kept the original, the join
    // dropped it, and the operation vanished from the band. EXISTS rather than
    // a join, so an account spelt two ways in `agents` cannot count a row twice.
    const source = `${distinctTrades(inner.join(" AND "))}
          WHERE t.created_at > ?
            AND EXISTS (SELECT 1 FROM agents a
                         WHERE LOWER(a.smart_account) = LOWER(t.agent_id) AND a.mode IN ('live','paper'))`;

    // THE COUNT IS OF THE WINDOW, THE SAMPLE IS FOR THE CANVAS. One extra
    // aggregate over the same predicate, served by trades_time.
    let total = { turned: 0, through: 0, flight: 0 };
    try {
      const c = (await db
        .prepare(
          `SELECT
             SUM(CASE WHEN t.status IN ('rejected','reverted') THEN 1 ELSE 0 END) AS turned,
             SUM(CASE WHEN t.status IN ('landed','paper') THEN 1 ELSE 0 END) AS through,
             SUM(CASE WHEN t.status = 'submitted' THEN 1 ELSE 0 END) AS flight
           FROM ${source}`,
        )
        .get(...args)) as
        | { turned: number | null; through: number | null; flight: number | null }
        | undefined;
      total = {
        turned: Number(c?.turned ?? 0),
        through: Number(c?.through ?? 0),
        flight: Number(c?.flight ?? 0),
      };
    } catch {
      /* older ledger — the drawn sample stands in below */
    }

    let rows: { at: number; status: string | null; rule: string | null }[] = [];
    try {
      rows = (await db
        .prepare(
          `SELECT t.created_at AS at, t.status AS status, t.reject_rule AS rule
             FROM ${source}
            ORDER BY t.created_at DESC
            LIMIT ?`,
        )
        .all(...args, CAP)) as typeof rows;
    } catch {
      // An older ledger has no `mode`. An empty band is the honest render of
      // that; it is never a 500 and never a claim that nothing happened.
      return { ...EMPTY, source: "sqlite", from, to };
    }
    const capped = rows.length >= CAP;

    // ── lanes ──────────────────────────────────────────────────────────────
    // The vocabulary comes from the publication policy, not from a second
    // hand-rolled copy of it. `reject_rule` demonstrably carries free-form text
    // — truncated bundler exceptions, `review: <reason>` — so anything outside
    // the known set is the catch-all rather than a new lane. The graphic never
    // invents a category and never echoes a raw string.
    const known = new Set(REJECT_RULES);
    const tally = new Map<string, number>();
    for (const r of rows) {
      const rule = r.rule && known.has(r.rule) ? r.rule : null;
      if (rule) tally.set(rule, (tally.get(rule) ?? 0) + 1);
    }
    const named = [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_NAMED_LANES)
      .map(([k]) => k);
    const lanes = [...named, CATCH_ALL];
    const laneOf = new Map(named.map((n, i) => [n, i]));
    const catchAll = lanes.length - 1;

    const cells: WallCell[] = [];
    const laneCounts = lanes.map(() => 0);
    const counts = { intents: 0, turned: 0, through: 0, flight: 0 };

    // Oldest first, so the replay runs forward through the day.
    for (const r of [...rows].reverse()) {
      const { outcome } = outcomeOf(r.status, r.rule);
      const fate: Fate =
        outcome === "refused" || outcome === "reverted"
          ? "turned"
          : outcome === "landed"
            ? "through"
            : "flight";
      // A decision that never reached the wall is not an intent flying at it.
      if (outcome === "dropped" || outcome === "view") continue;
      const lane =
        fate === "turned" ? (r.rule && laneOf.has(r.rule) ? laneOf.get(r.rule)! : catchAll) : catchAll;
      cells.push({ t: Number(r.at), lane, fate });
      // Only the turned ones: a lane is a REASON THE WALL SAID NO, and counting
      // what got through under the catch-all would put passes in a breakdown of
      // refusals.
      if (fate === "turned") laneCounts[lane] += 1;
      counts.intents += 1;
      counts[fate] += 1;
    }

    // The counted window wins wherever it is available; the sampled tally is
    // the fallback for a ledger too old to answer the aggregate.
    const summed = total.turned + total.through + total.flight;
    const published =
      summed > 0
        ? { intents: summed, turned: total.turned, through: total.through, flight: total.flight }
        : counts;

    return {
      source: "sqlite",
      cells,
      lanes,
      laneCounts,
      counts: published,
      capped,
      from,
      to,
      key: `${cells.length}:${to}`,
    };
  });
}
