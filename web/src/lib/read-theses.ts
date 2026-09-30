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
 * TWO LANES, TWO BUDGETS. Actions and views arrive at rates three orders of
 * magnitude apart: a Trencher reviews a coin every 30 seconds and every quiet
 * agent files a market review every five minutes, while a real buy is a few a
 * day. One LIMIT over both, ordered by the newest row in each group, meant a
 * re-proposed hold jumped back to the top on every tick — measured on
 * production, 37 of 40 posts were holds covering the last ten minutes, and a
 * buy that landed three hours earlier was simply not in the response.
 *
 * So anything that can carry an execution outcome — a buy, a sell, a vault
 * move, a transfer — is an ACTION, read newest first and paged until enough
 * pass the gate. A hold or a pure view is a VIEW, read as the latest word per
 * (agent, name). A view that is not an agent's latest word on a name is not
 * published at all: that is a choice, and the ledger and /why still have it.
 *
 * WHY THE JOIN TO `trades` IS NOT OPTIONAL. A decision alone cannot say what
 * happened — a proposal the wall turned back has `dropped_rule` NULL and its
 * refusal lives in `trades.reject_rule`. Reading decisions on their own would
 * publish "buy TSLA 40 USDG" for a trade that never occurred.
 *
 * TWO GATES, ON PURPOSE. The SQL narrows to publishable sources, to agents that
 * have actually heartbeat, and — through `publicationNarrowing` — past the rows
 * the gate drops for their source, action or rule; `publishableThesis` then
 * decides again, per row. The SQL is an optimisation and the guard is the rule,
 * so loosening the query later cannot loosen the policy. `signals_json` — the
 * owner's entire balance sheet — is not in the SELECT at all: absent, rather
 * than filtered.
 */
import { DERIVED_ID, basisJoin, basisScope, fillFigures, markFigures, publicationNarrowing } from "@merrymen/thesis";
import { withReadDb } from "@/lib/ledger";
import { postIdOf } from "@/lib/post-id";
import { PUBLISHABLE_SOURCES, publishableThesis, type PublicThesis, type ThesisRow } from "@/lib/thesis";
import { getIdentityStore } from "@merrymen/identity-store";
import { getSettingsStore } from "@merrymen/settings-store";

/** How far back a post can be and still be news. */
export const WINDOW_SEC = 24 * 3600;
/** Action groups per page, before the guard trims to what may be shown. */
const ACTION_PAGE = 90;
/**
 * How far the action scan pages before it stops and says it stopped. Ten pages:
 * the SQL has already skipped what the gate drops by source, action and rule,
 * so what is left to page past is rows only the gate can judge by their words.
 */
const ACTION_SCAN_MAX = 900;
/**
 * (agent, name) pairs to read, before the gate. More than are shown, so a pair
 * whose every recent word the gate refuses does not cost a slot.
 */
const VIEW_PAIRS = 60;
/**
 * Groups read per pair: the newest, and enough behind it that a newer row only
 * the gate can refuse — an address in a model's reason, a provider error —
 * does not decide the name on its own. A bound, not a principle: a name whose
 * newest three DIFFERENT words are all refused publishes nothing, which claims
 * nothing, rather than letting one chatty name cost the whole read.
 */
const VIEW_DEPTH = 3;
/** Per lane — a busy view lane cannot take a slot a trade needed. */
const SHOW = 40;

/**
 * An ACTION is anything that can carry an execution outcome. A vault move was
 * a "view" once, and views keep only the latest word per name: vault moves have
 * no symbol, so every deposit, withdrawal and pure thesis of an agent shared one
 * name, and a refused re-proposal erased the deposit that had landed before it.
 */
const IS_ACTION = "(d.action IS NOT NULL AND d.action <> 'hold')";
const IS_VIEW = "(d.action IS NULL OR d.action = 'hold')";

/**
 * WHAT THE CALL WAS WORTH, folded over the group's copies — or NULL. The fold
 * lives beside the gate (thesis-policy's fillFigures/markFigures) because the
 * peer files read groups too, and "when is a figure read" must have one answer:
 * only when EVERY copy was, and never from a quoted fill. publishableThesis
 * turns what survives into the post's figures, and a surface renders nothing
 * for a null — never 0%.
 */
const FILLS = fillFigures("t");
const MARKS = markFigures("d");

/**
 * WHICH OPTIONAL COLUMNS A READ ASKS FOR, richest first.
 *
 * `named` is the coin's name and the handle's proof; `fills` is the trade's
 * evidence columns; `marks` is `decisions.mark_usd`/`mcap_usd`, which the
 * writer's migration adds while this reader deploys beside it. Each attempt
 * that fails drops what it cannot have and tries again, so the minute between
 * the two deploys costs a post its figures, never the feed its posts.
 */
type Columns = { named: boolean; fills: boolean; marks: boolean };
const ATTEMPTS: readonly Columns[] = [
  { named: true, fills: true, marks: true },
  { named: true, fills: true, marks: false },
  { named: true, fills: false, marks: false },
  { named: false, fills: false, marks: false },
];

// DERIVED, never listed again here. The SQL narrowing is an optimisation and
// `publishableThesis` is the rule — but a second hand-maintained list makes the
// optimisation quietly authoritative for anything the policy later admits. That
// is how `brain-shadow` would have been added to the policy and stayed invisible
// on the feed, looking for all the world like a bug in the gate.
const SOURCES: readonly string[] = PUBLISHABLE_SOURCES;

/**
 * A published post, plus the stable name a like can be cast against.
 *
 * `postId` IS NOT ON `PublicThesis`, AND THAT IS THE FENCE. `PublicThesis` is
 * the shape `worker/src/thesis-policy.ts` produces, and `peer-theses.ts`
 * materialises it into the file an agent's desk reads. If the id lived there,
 * every peer post would carry one and the only thing standing between a like
 * count and a prompt would be a rule somebody had to keep obeying.
 *
 * Instead it is attached HERE, after the gate, by a module the worker cannot
 * import (`imports.test.ts` forbids `@merrymen/*` under `worker/src`, and
 * `web/src` is not aliased inward at all). The peer path produces no post id at
 * all, so an object that reaches a prompt physically cannot carry a like.
 */
export type FeedThesis = PublicThesis & {
  /** Null when the agent has no public slug — an unslugged post is not likeable. */
  postId: string | null;
  /** Current agent mode, not a claim about the mode when an older post was written. */
  trencher?: boolean;
  /**
   * Whether `handle` is one its owner PROVED, by posting a nonce from it. The
   * handle alone is typed by the owner and nothing checked it, so a surface
   * that names the owner may do so only when this is true.
   */
  handleVerified: boolean;
  /**
   * Epoch SECONDS this post, as it stands, began its current unbroken
   * stretch: nothing else in its lane said about the same name after it and,
   * for a view, no trade of the name inside it. A trade inside a view's
   * stretch RESTARTS it at the next copy, and `said` then counts that stretch
   * alone. Null when the copies are not one stretch — then `said` and
   * `firstAt` still count every copy in the window, and "×N · since" would
   * hide the change.
   */
  unchangedSince: number | null;
  /**
   * VIEWS ONLY: this agent said something about more names in the window than
   * this response carries, so a count of its names taken from here is a floor
   * and not a total.
   */
  moreNames?: boolean;
};

export interface ThesesRead {
  /** "none" means the ledger could not be read — NOT that nobody said anything. */
  source: "sqlite" | "none";
  theses: FeedThesis[];
  /**
   * Every action group in the window reached the gate, and none that passed
   * was cut. Only then does an empty action lane mean no published trades; a
   * scan that stopped at its bound says nothing about what lay past it.
   */
  tradesComplete: boolean;
}

export interface ReadThesesOptions {
  /** Only this agent's posts, by public slug. */
  agentSlug?: string;
  /** Only posts naming this symbol. */
  symbol?: string;
  /** Per lane: at most this many trades AND at most this many views. */
  limit?: number;
}

/** A group as the query returns it: the row the gate reads, and where it sits. */
type Group = ThesisRow & {
  x_verified?: number | null;
  sym: string;
  /** 1 for the newest group of its (agent, name) in this lane, then 2, 3… */
  in_pair: number;
  /** The newest time of the next group of the same (agent, name), or null. */
  next_at: number | null;
  /** Views only: the newest time a trade on the same (agent, name) could have been published, or null. */
  other_at: number | null;
  /** Views only: this group's first copy AFTER `other_at` (its first copy when there is none), or null. */
  resumed_at: number | null;
  /** Views only: how many of this group's copies came after `other_at`. */
  resumed_said: number | null;
  /** Views only: how many names this account said something about. */
  agent_names?: number;
};

/**
 * EACH (ACCOUNT, COIN)'S NEWEST NAME — and at a tie, the first by name.
 *
 * Two names for one coin written in the same second (a deployer who changed
 * `symbol()`, a tape that relabelled it) left the pick to whichever row the
 * engine returned first, which SQLite and Postgres need not agree on and
 * Postgres need not repeat. The tie is broken the way the writer's own lookup
 * breaks it (store.ts `displayNameFor`: newest, then by name), so the feed
 * names a coin the same on both engines, read after read.
 */
export function newestNames(found: readonly { agent_id: string; symbol: string; display_name: string; at: number }[]): Map<string, string> {
  const newest = new Map<string, { name: string; at: number }>();
  for (const f of found) {
    const key = `${f.agent_id}|${f.symbol}`;
    const at = Number(f.at);
    const had = newest.get(key);
    if (!had || at > had.at || (at === had.at && f.display_name < had.name)) newest.set(key, { name: f.display_name, at });
  }
  return new Map([...newest].map(([key, v]) => [key, v.name]));
}

export async function readTheses(opts: ReadThesesOptions = {}, readDb = withReadDb, identities = () => getIdentityStore().all(), settings = (tenant: `0x${string}`) => getSettingsStore().get(tenant)): Promise<ThesesRead> {
  const limit = Math.min(opts.limit ?? SHOW, 200);

  return readDb(async (db): Promise<ThesesRead> => {
    if (!db) return { source: "none", theses: [], tradesComplete: false };

    // The slug map, read once. NOT a SQL join: the identity store is not the
    // ledger, and the file backend makes a join impossible — the code has to
    // work on both. The identity is keyed on the tenant and carries every smart
    // account that tenant has held, so a re-granted agent's older rows still
    // resolve to the same slug rather than splitting into two strangers.
    const slugFor = new Map<string, string>();
    const accountsFor = new Map<string, string[]>();
    const tenantFor = new Map<string, `0x${string}`>();
    try {
      for (const id of await identities()) {
        accountsFor.set(id.slug, id.accounts.map((a) => a.toLowerCase()));
        tenantFor.set(id.slug, id.tenant);
        for (const acct of id.accounts) slugFor.set(acct.toLowerCase(), id.slug);
      }
    } catch {
      /* no links this pass; every post still renders its words */
    }

    // Scoping to one agent means scoping to every account it has ever held.
    const only = opts.agentSlug ? (accountsFor.get(opts.agentSlug) ?? []) : null;
    if (only !== null && only.length === 0) return { source: "sqlite", theses: [], tradesComplete: true };

    const since = Math.floor(Date.now() / 1000) - (opts.agentSlug ? 30 * WINDOW_SEC : WINDOW_SEC);
    const narrow = publicationNarrowing("d", "t");
    const where: string[] = [
      "a.mode IN ('live', 'paper')",
      "d.agent_id NOT LIKE 'rh:%'",
      "d.at > ?",
      `d.source IN (${SOURCES.map(() => "?").join(", ")})`,
      // In the SQL as well as the gate, because a view is the LATEST row per
      // name: a private hold left in here would become that latest row, fail
      // the gate, and take the last real view of the name down with it.
      "(d.hold_kind IS NULL OR d.hold_kind NOT IN ('GATE_FORCED_HOLD', 'STALE_MARK_HOLD'))",
      "(d.dropped_rule IS NULL OR d.dropped_rule NOT LIKE 'brain-%')",
      // The rows the gate drops for their source, action or rule: a day of the
      // class route's refused re-proposals, or a basket blocked on its own
      // account, is otherwise the whole of a bounded scan.
      narrow.sql,
    ];
    const args: unknown[] = [since, ...SOURCES, ...narrow.args];
    if (only) {
      where.push(`LOWER(d.agent_id) IN (${only.map(() => "?").join(", ")})`);
      args.push(...only);
    }
    if (opts.symbol) {
      where.push("d.symbol = ?");
      args.push(opts.symbol);
    }
    // THE QUOTE-BOOKED BUYS THIS READ'S SELLS COULD HAVE CLOSED, read once in
    // front of each statement that asks for figures (thesis-policy.ts
    // `basisScope`) rather than once per sell copy, which walked an account's
    // whole history for every one. Scoped to the read's own window and, for one
    // agent's read, to its accounts.
    const basis = basisScope({ since, accounts: only });
    const scoped = (cols: Columns) => (cols.fills ? basis : { sql: "", args: [] as unknown[] });
    // ── THE NAME IS OPTIONAL TO READ, ON PURPOSE ─────────────────────────
    //
    // `decisions.display_name` and `agents.x_verified` are created by the
    // WRITER's migrations, and the reader is a different service that deploys
    // at the same moment. For the minute between the two, selecting a column
    // that does not exist yet throws — and the catch below turns that into an
    // empty list, which on a public feed is indistinguishable from a fleet
    // that has never spoken.
    //
    // So they are attempted, and dropped if they are not there yet. A feed
    // without the coin's name is a worse feed, and one without the proof
    // shows no owner handle at all; a blank one is a broken product, and the
    // blankness would be silent.
    //
    // ONE GROUPED READ, TWO LANES. The column list, the joins and the group
    // key are shared text, so the lanes cannot drift into two ideas of what a
    // post is; only the lane predicate and the budget differ.
    const grouped = (cols: Columns, lane: string, other?: string) =>
      `SELECT a.name AS name, a.x_handle AS x_handle, ${cols.named ? "COALESCE(a.x_verified, 0) AS x_verified," : ""}
              d.agent_id AS agent_id, d.action AS action, d.symbol AS symbol, COALESCE(d.symbol, '') AS sym,
              ${cols.named ? "d.display_name AS display_name," : ""}
              ${cols.fills ? FILLS : ""}
              ${cols.marks ? MARKS : ""}
              d.size_usdg AS size_usdg,
              d.source AS source, d.reason AS reason, d.dropped_rule AS dropped_rule,
              d.hold_kind AS hold_kind,
              p.body AS post,
              t.status AS status, t.reject_rule AS reject_rule, a.mode AS mode,
              COUNT(*) AS said, MAX(d.at) AS last_at, MIN(d.at) AS first_at, MAX(d.id) AS last_id,
              ${other
                ? `MAX(o.at) AS other_at, MIN(CASE WHEN o.at IS NULL OR d.at > o.at THEN d.at END) AS resumed_at,
                   SUM(CASE WHEN o.at IS NULL OR d.at > o.at THEN 1 ELSE 0 END) AS resumed_said`
                : "NULL AS other_at, NULL AS resumed_at, NULL AS resumed_said"}
         FROM decisions d
         JOIN agents a ON a.smart_account = d.agent_id
         ${other ? `LEFT JOIN (${latestIn(other)}) o ON o.agent_id = d.agent_id AND o.sym = COALESCE(d.symbol, '')` : ""}
         -- The LAST trade for this decision. A correlated MAX(id) keeps this
         -- join to one row per decision on both backends.
         LEFT JOIN trades t ON t.id = (SELECT MAX(id) FROM trades WHERE decision_id = d.id)
         ${cols.fills ? basisJoin("t") : ""}
         -- THE AGENT'S OWN WORDS, when it had any. A LEFT JOIN because
         -- almost no decision has a post: one is written only for a class
         -- trade that actually filled and whose writer cleared its gate,
         -- so absent is the overwhelmingly common case and must not drop
         -- the row. It is a separate column all the way to
         -- the renderer, because the two carry different trust: the reason
         -- column is ours and the post column is a model's.
         LEFT JOIN posts p ON p.decision_id = d.id
        -- Paper agents post too, labelled. Excluding them emptied the feed:
        -- paperTradingEnabled defaults TRUE, so most of a fleet is pretend
        -- money, and a feed with nothing in it teaches nobody anything. The
        -- LEADERBOARD still ranks live only — a ranking of returns must not
        -- mix fake capital in. 'idle' stays out: an agent that has never
        -- heartbeat has not said anything.
        WHERE ${[...where, lane].join(" AND ")}
        GROUP BY a.name, a.x_handle, ${cols.named ? "a.x_verified," : ""} a.mode, d.agent_id, d.action, d.symbol, ${cols.named ? "d.display_name," : ""} d.size_usdg,
                 d.source, d.reason, d.dropped_rule, d.hold_kind, t.status, t.reject_rule, p.body`;
    // THE NEWEST WORD ABOUT EACH NAME IN A LANE, and nothing else: no words,
    // no outcome, no post. The same WHERE as the lane itself, so "something
    // else was said" means something the feed could have published, not a
    // private row the gate keeps from it.
    const latestIn = (lane: string) =>
      `SELECT d.agent_id AS agent_id, COALESCE(d.symbol, '') AS sym, MAX(d.at) AS at
         FROM decisions d
         JOIN agents a ON a.smart_account = d.agent_id
         LEFT JOIN trades t ON t.id = (SELECT MAX(id) FROM trades WHERE decision_id = d.id)
        WHERE ${[...where, lane].join(" AND ")}
        GROUP BY d.agent_id, COALESCE(d.symbol, '')`;
    // WHERE EACH GROUP SITS AMONG THE OTHERS ABOUT THE SAME NAME. Window
    // functions over the grouped rows, as distinct-trades.ts already runs on
    // both backends: `in_pair` says whether this is the agent's latest word on
    // the name in its lane, and `next_at` says when the word before it last
    // appeared — which is what decides whether a repeat is one unbroken
    // stretch.
    //
    // A VIEW ALSO ASKS THE TRADE LANE (`other`). Each lane looked only at
    // itself, so a hold, a buy of the name, and the same hold again read as one
    // hold standing since before the buy. The trade's time comes in per row,
    // inside the grouping, so the group can say where its run RESUMED after the
    // trade (`resumed_at`) — the hold then stands since its first copy after
    // the buy, ranks just above it, and folds with the agent's other standing
    // holds again. Merely clearing the "since" left it at its newest copy, the
    // top of the feed, every tick until its pre-trade copies aged out.
    //
    // A TRADE DOES NOT ASK THE VIEW LANE. "×24 · since 2h · turned back" is
    // still exactly true when a view of the name fell between two refusals, and
    // the view is already its own row; clearing the refusal's "since" put the
    // refusal back on top of the feed every tick, the all-day beat the "since"
    // exists to stop.
    const placed = (cols: Columns, lane: string, other?: string) =>
      `SELECT g.*,
              ROW_NUMBER() OVER (PARTITION BY g.agent_id, g.sym ORDER BY g.last_at DESC, g.last_id DESC) AS in_pair,
              LEAD(g.last_at) OVER (PARTITION BY g.agent_id, g.sym ORDER BY g.last_at DESC, g.last_id DESC) AS next_at
         FROM (${grouped(cols, lane, other)}) g`;

    const actionPage = (cols: Columns, offset: number) =>
      db
        .prepare(
          `${scoped(cols).sql}SELECT r.* FROM (${placed(cols, IS_ACTION)}) r
            ORDER BY r.last_at DESC, r.last_id DESC
            LIMIT ? OFFSET ?`,
        )
        .all(...scoped(cols).args, ...args, ACTION_PAGE, offset) as Promise<Group[]>;

    // THE VIEW LANE IS DEALT OUT, NOT RACED FOR. Ranked by the clock, a pair
    // re-said every tick always had the freshest time, so any agent with forty
    // names took all forty slots. Here each agent's names are numbered
    // (`agent_turn`), and the lane is filled turn by turn: every agent's first
    // name, then every agent's second. The turns ARE the fairness — a busy
    // agent only ever gets slots nobody else's turn wanted — so there is no
    // cap per agent on top of them. There was one, of ten, and all it did was
    // leave a lane with room in it while hiding the agent's eleventh name.
    //
    // NUMBERED BY WHEN THE NAME LAST CHANGED, not when it was last said. A
    // name re-said every thirty seconds has not changed in an hour, and ranked
    // by its newest copy it came before the one view the agent had actually
    // changed, which then fell off the end. The change time is the first copy
    // of the newest word — or, when that word was also said before the one
    // behind it (A, then B, then A), the last time the other word was said,
    // since the return to A came after that. Never later than the truth: a
    // view is never ranked as fresher than it is.
    //
    // Each pair brings its newest VIEW_DEPTH groups, so the gate — not the SQL
    // — picks the word that is published. `agent_names` is the account's whole
    // count of names, read before the lane is cut, so a count cut by the lane
    // can say so.
    //
    // NO FILL FIGURES, SO NO BASIS SCOPE. A view is a hold or a pure thesis,
    // and publishableThesis gives an entry price only to a filled buy and a
    // realized figure only to a filled sell, so a view's fill columns publish
    // nothing. Asked for anyway, they put the basis scope in front of this
    // statement — a pass over every selling account's history on every read,
    // for nothing (R3F-3).
    const viewRead = (all: Columns) => {
      const cols: Columns = { ...all, fills: false };
      return db
        .prepare(
          `SELECT s.* FROM (
             SELECT q.*,
                    MAX(q.agent_turn) OVER (PARTITION BY q.agent_id) AS agent_names,
                    DENSE_RANK() OVER (ORDER BY q.agent_turn, q.changed_at DESC, q.agent_id, q.sym) AS turn
               FROM (
                 SELECT c.*, DENSE_RANK() OVER (PARTITION BY c.agent_id ORDER BY c.changed_at DESC, c.sym) AS agent_turn
                   FROM (
                     SELECT r.*,
                            MAX(CASE WHEN r.in_pair = 1 AND r.next_at > r.first_at THEN r.next_at
                                     WHEN r.in_pair = 1 THEN r.first_at END) OVER (PARTITION BY r.agent_id, r.sym) AS changed_at
                       FROM (${placed(cols, IS_VIEW, IS_ACTION)}) r
                      WHERE r.in_pair <= ?
                   ) c
               ) q
           ) s
           WHERE s.turn <= ?
           ORDER BY s.turn, s.in_pair`,
        )
        .all(...args, ...args, VIEW_DEPTH, Math.max(VIEW_PAIRS, limit + 20)) as Promise<Group[]>;
    };

    // The gate alone, for counting while paging. The post it builds here is
    // thrown away; `gated` below builds the one that is returned.
    const gate = (r: Group): boolean => publishableThesis({ ...r, slug: slugFor.get(String(r.agent_id).toLowerCase()) ?? null }) !== null;

    // THE ACTION LANE PAGES until enough posts pass the gate or the window
    // runs out, and records which: an empty lane from a scan that stopped at
    // its bound is not "no trades", and the rail must not be told it is.
    const readActions = async (cols: Columns) => {
      const out: Group[] = [];
      let exhausted = false;
      let passed = 0;
      for (let offset = 0; offset < ACTION_SCAN_MAX; offset += ACTION_PAGE) {
        const page = await actionPage(cols, offset);
        out.push(...page);
        passed += page.filter((r) => gate(r)).length;
        if (page.length < ACTION_PAGE) {
          exhausted = true;
          break;
        }
        if (passed >= limit) break;
      }
      return { rows: out, complete: exhausted && passed <= limit };
    };

    let rows: { actions: Group[]; views: Group[]; tradesComplete: boolean } | null = null;
    let named = false;
    const run = async (cols: Columns) => {
      const actions = await readActions(cols);
      return { actions: actions.rows, tradesComplete: actions.complete, views: await viewRead(cols) };
    };
    for (const cols of ATTEMPTS) {
      try {
        rows = await run(cols);
        named = cols.named;
        break;
      } catch (error) {
        // The last attempt asks for no optional column at all, so a failure
        // there is a real read failure and is reported as one.
        if (cols === ATTEMPTS[ATTEMPTS.length - 1]) {
          console.error("[read-theses] ledger read failed", error instanceof Error ? error.name : "unknown");
          return { source: "none", theses: [], tradesComplete: false };
        }
      }
    }
    if (!rows) return { source: "none", theses: [], tradesComplete: false };

    // ── A ROW WITH NO NAME BORROWS ITS AUTHOR'S NEWEST ONE FOR THE COIN ──
    //
    // Seen on the live feed 2026-09-23: "sell TA151B4A9E1B 5.01 USDG". A held
    // coin drops off the tape's qualified list and discovery then labels it
    // with its own id, so every exit and review written after that went into
    // the ledger unnamed. The writer now carries the buy's name forward; this
    // gives the rows already written theirs.
    //
    // THE SAME AUTHOR ACCOUNT, and only an address-derived id: one agent's
    // label for an id is never another's, and a stock's name is its ticker.
    // Bounded to the read's own window, so it never reads further back than
    // the query above already did. A failure costs the name, never the post.
    if (named) {
      const unnamed = [...rows.actions, ...rows.views].filter(
        (r) => !(r.display_name ?? "").trim() && typeof r.symbol === "string" && DERIVED_ID.test(r.symbol),
      );
      if (unnamed.length) {
        const accounts = [...new Set(unnamed.map((r) => String(r.agent_id)))];
        const symbols = [...new Set(unnamed.map((r) => String(r.symbol)))];
        try {
          const found = (await db
            .prepare(
              `SELECT d.agent_id AS agent_id, d.symbol AS symbol, d.display_name AS display_name, MAX(d.at) AS at
                 FROM decisions d
                WHERE d.agent_id IN (${accounts.map(() => "?").join(", ")})
                  AND d.symbol IN (${symbols.map(() => "?").join(", ")})
                  AND d.display_name IS NOT NULL AND d.display_name <> ''
                  AND d.at > ?
                GROUP BY d.agent_id, d.symbol, d.display_name
                ORDER BY MAX(d.at) DESC, d.display_name`,
            )
            .all(...accounts, ...symbols, since)) as { agent_id: string; symbol: string; display_name: string; at: number }[];
          const newest = newestNames(found);
          for (const r of unnamed) {
            const hit = newest.get(`${String(r.agent_id)}|${String(r.symbol)}`);
            if (hit) r.display_name = hit;
          }
        } catch {
          /* the rows keep their ids: a post without its coin's name is a worse post, not a missing one */
        }
      }
    }

    // THE ID IS DERIVED FROM THE PUBLISHED POST, not from the row, and only
    // after the gate has admitted it. Every input is a field of the same object
    // the id is returned in, so the id cannot disclose anything the post does
    // not already say — which is what an adversarial review found was NOT true
    // when the row's `source` was an input. See post-id.ts.
    // Resolve only authors in this response, once per tenant. Only this public
    // mode bit leaves the server; never spread settings (which contain secrets).
    const modeFor = new Map<string, boolean>();
    // WHETHER THE OWNER MADE THE BOOK PUBLIC — the one other bit read here, and
    // it gates DOLLARS only: a sell's realized percent is public for everyone,
    // its dollars only when this is true. Read the way the profile cluster
    // declares it (packages/core settings), without depending on the type, so
    // a settings blob from before the field existed reads as private. An
    // unreadable setting is private too: the default is the one that
    // publishes less.
    const bookFor = new Map<string, boolean>();
    const slugs = [...new Set([...rows.actions, ...rows.views].map(r => slugFor.get(String(r.agent_id).toLowerCase())).filter((s): s is string => !!s))];
    await Promise.all(slugs.map(async slug => {
      const tenant = tenantFor.get(slug);
      if (!tenant) return;
      try {
        const config = await settings(tenant);
        modeFor.set(slug, config?.strategy === "trencher");
        bookFor.set(slug, (config as { publicBook?: unknown } | null)?.publicBook === true);
      } catch { /* Unknown mode must not acquire a badge or hide a post. */ }
    }));
    const gated = (r: Group, unchangedSince: number | null): FeedThesis | null => {
      const slug = slugFor.get(String(r.agent_id).toLowerCase()) ?? null;
      const post = publishableThesis({ ...r, slug, public_book: slug ? bookFor.get(slug) === true : false });
      if (!post) return null;
      return {
        ...post,
        trencher: slug ? modeFor.get(slug) === true : false,
        handleVerified: post.handle !== null && Number(r.x_verified ?? 0) !== 0,
        unchangedSince,
        postId: postIdOf({
          slug: post.slug,
          action: post.action,
          symbol: post.symbol,
          // THE PUBLISHED SIZE, which is null for a private book — never the
          // row's. The id is served beside every other input to it, and a size
          // is a handful of round numbers, so hashing the one the gate withheld
          // would publish it as an encoding. The cost is paid once: a private
          // book's posts that named a size get new ids, and likes cast on the
          // old ones stay with the old ids.
          sizeUsdg: post.sizeUsdg,
          reason: post.reason,
          shadow: post.shadow,
        }),
      } satisfies FeedThesis;
    };

    // Nothing at all, or something before `first`. Numbered because Postgres
    // hands an aggregate of a BIGINT back as a string.
    const before = (at: number | null | undefined, first: number) => at === null || at === undefined || Number(at) < first;

    // AN ACTION REPEATS FROM ITS FIRST TIME only while no other TRADE happened
    // to the same name after it began: it is the newest group on the name, and
    // the group before it last appeared before this one's first copy. A view
    // in between does not break it — see `placed`.
    const actions = rows.actions
      .map((r) => {
        const first = Number(r.first_at ?? r.last_at ?? 0);
        const unbroken = Number(r.in_pair) === 1 && before(r.next_at, first);
        return gated(r, unbroken ? first : null);
      })
      .filter((t): t is FeedThesis => t !== null)
      .slice(0, limit);

    // ONE VIEW PER AGENT AND NAME, chosen AFTER the gate. Keyed on the SLUG,
    // not the account: a re-granted agent holds several accounts and is still
    // one author. An unslugged account is its own author — keyed on the name,
    // every unslugged "Robin" in the fleet would have shared one view of TSLA.
    const authorOf = (r: Group) => slugFor.get(String(r.agent_id).toLowerCase()) ?? `account:${String(r.agent_id).toLowerCase()}`;
    const byPair = new Map<string, Group[]>();
    for (const r of rows.views) {
      const key = `${authorOf(r)}|${r.sym}`;
      const list = byPair.get(key) ?? [];
      list.push(r);
      byPair.set(key, list);
    }
    const chosen: { post: FeedThesis; author: string }[] = [];
    for (const groups of byPair.values()) {
      if (chosen.length >= limit) break;
      const newest = [...groups].sort((a, b) => Number(b.last_at) - Number(a.last_at));
      for (const winner of newest) {
        // The word is the newest one the gate lets out. It stands unchanged
        // since its first copy only if no other word about the name came after
        // that. Every view that could have is among those read: a winner that
        // is not the newest already has a newer one here, and behind the newest
        // VIEW_DEPTH reads at least one more. Every trade that could have is on
        // each row as `other_at`, read whole in SQL rather than from the
        // bounded action scan.
        //
        // A trade inside the run does not end it; it RESTARTS it at the first
        // copy after the trade. Only when the word was never said again after
        // the trade is there no "since" at all: the trade is then the newer
        // thing said, and the view stands at its own last copy.
        const first = Number(winner.first_at ?? winner.last_at ?? 0);
        const others = newest.filter((g) => g !== winner).map((g) => Number(g.last_at));
        const tradedAt = Math.max(-1, ...newest.map((g) => (g.other_at === null || g.other_at === undefined ? -1 : Number(g.other_at))));
        const resumed = winner.resumed_at === null || winner.resumed_at === undefined ? null : Number(winner.resumed_at);
        const inLane = others.every((at) => at < first);
        const restarted = inLane && tradedAt >= first && resumed !== null && resumed > tradedAt;
        const since = !inLane ? null : tradedAt < first ? first : restarted ? resumed : null;
        // A restarted stretch counts its own copies: "×24 · since 1h" about a
        // hold said twelve times since the buy would be a figure nobody read.
        const post = gated(restarted ? { ...winner, said: Number(winner.resumed_said ?? 1) } : winner, since);
        if (!post) continue;
        chosen.push({ post, author: authorOf(winner) });
        break;
      }
    }
    // HOW MANY NAMES EACH AUTHOR HAS, against how many are here. Summed over
    // the author's accounts; whenever the two differ a count taken from this
    // response is a floor, and each of that author's views says so.
    const namesOf = new Map<string, number>();
    const counted = new Set<string>();
    for (const r of rows.views) {
      const account = String(r.agent_id).toLowerCase();
      if (counted.has(account)) continue;
      counted.add(account);
      namesOf.set(authorOf(r), (namesOf.get(authorOf(r)) ?? 0) + Number(r.agent_names ?? 0));
    }
    const shownOf = new Map<string, number>();
    for (const c of chosen) shownOf.set(c.author, (shownOf.get(c.author) ?? 0) + 1);
    const views = chosen.map(({ post, author }) => ({
      ...post,
      moreNames: (namesOf.get(author) ?? 0) > (shownOf.get(author) ?? 0),
    }));

    // Newest first, as it always was: callers that take "the agent's latest
    // post" off the front of this list must still get the latest of both.
    const theses = [...actions, ...views].sort((a, b) => b.at - a.at);

    return { source: "sqlite", theses, tradesComplete: rows.tradesComplete };
  });
}
