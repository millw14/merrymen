/**
 * WHAT A WIRED AGENT HAS SAID IN PUBLIC, read on the orchestrator's side.
 *
 * The query half of the wire. `peer-files.ts` is the transport; this is the only
 * thing allowed to fill it.
 *
 * WHY THE SELECT IS NARROWER THAN THE FEED'S. `read-theses.ts` runs the browser's
 * version of this and is deliberately not shared with it: that module lives in
 * `web/src`, which the worker cannot import, and moving the whole reader would
 * drag pagination, symbol filters and grouping the orchestrator has no use for.
 *
 * The thing that must NOT be duplicated is the publication policy, and it is not:
 * every row here leaves through `publishableThesis` from `thesis-policy.ts`, the
 * same function `/api/theses` uses. That is the boundary the move of that module
 * was made to create, and it is what makes "the peer file can only contain what
 * an anonymous browser already gets" a compile-time fact rather than a promise.
 *
 * `signals_json` IS THE COLUMN TO KEEP OUT. It holds the owner's entire balance
 * sheet, it IS mirrored into shared Postgres (ledger-mirror.ts copies it), and it
 * sits on the very table this query reads. Any new reader of `decisions` re-opens
 * that hole by default, which is why the column list below is explicit and why a
 * test scans this file's source for the name.
 */
import type { Db } from "./db";
import { getIdentityStore, type IdentityStore } from "./identity-store";
import { getSettingsStore } from "./settings-store";
import {
  LANDED_STATUSES,
  PUBLISHABLE_SOURCES,
  basisJoin,
  basisScope,
  fillFigures,
  publicationNarrowing,
  publishableThesis,
  type PublicThesis,
  type ThesisRow,
} from "./thesis-policy";

/** How far back a peer's thinking is worth carrying. Matches the public feed. */
export const PEER_WINDOW_SEC = 24 * 3600;

/**
 * Sources whose text merrymen wrote, DERIVED rather than copied.
 *
 * A hand-kept second list would drift the moment a strategy is added, and the
 * drift would be silent and in the wrong direction: the SQL would stop selecting
 * a source that publishableThesis is perfectly happy to publish, so a peer would
 * quietly go quiet. Built from the same constant thesis-policy gates on.
 */
// The same list the public feed uses, from the same module. "A peer file can
// only contain what the public feed publishes" is a property only while these
// two readers are incapable of disagreeing about what that is.
const SOURCES: readonly string[] = PUBLISHABLE_SOURCES;

/** At most this many theses reach one child, newest first. A prompt has a budget. */
export const PEER_THESIS_LIMIT = 24;
/**
 * Of those, up to this many are LANDED trades, kept whatever was said since.
 *
 * The newest twenty-four posts of a Trencher are twelve minutes of its own
 * reviews, so a buy that landed an hour ago was never in the file — and this
 * file is the agent's own memory as well as its peers' view of it. A trade is
 * the thing most worth remembering and the rarest thing written, so a few are
 * held back from being pushed out by the chatter.
 */
export const PEER_LANDED = 6;
const SCAN_BATCH = 96;
/** Bound mirror work even if every row in a busy ledger fails publication. */
const MAX_SCAN = 960;

/**
 * Resolve slugs to the accounts behind them.
 *
 * One agent may have held several smart accounts — a re-grant mints a new one —
 * so a slug maps to a LIST, and every one of them has to be in the query or the
 * agent's own history disappears at its last re-grant.
 */
async function resolvePeers(slugs: readonly string[], identity: Pick<IdentityStore, "bySlug">) {
  const accounts = new Set<`0x${string}`>();
  const slugFor = new Map<string, string>();
  const tenantFor = new Map<string, `0x${string}`>();
  for (const slug of slugs) {
    try {
      const id = await identity.bySlug(slug);
      if (id) for (const account of id.accounts) {
        accounts.add(account.toLowerCase() as `0x${string}`);
        slugFor.set(account.toLowerCase(), id.slug);
        tenantFor.set(account.toLowerCase(), id.tenant);
      }
    } catch {
      // A dangling follow is not an error — see follow-store.ts. It contributes
      // nothing and must not stop the other peers from being read.
    }
  }
  return { accounts: [...accounts], slugFor, tenantFor };
}

export async function accountsForSlugs(slugs: readonly string[]): Promise<`0x${string}`[]> {
  return (await resolvePeers(slugs, getIdentityStore())).accounts;
}

/**
 * The published theses of these accounts, newest first.
 *
 * Returns `[]` on any read failure, deliberately: a ledger written by an older
 * worker has no `decisions` table, and an empty peer file is the honest render of
 * "we could not learn anything" — never a 500 on the orchestrator's mirror pass.
 *
 * `bookIsPublic` says, per account (lowercased), whether its owner made the book
 * public — the one bit read-theses decorates for the feed. Absent, every book is
 * private, which is the default that publishes less.
 */
export async function readPeerTheses(
  shared: Db,
  accounts: readonly `0x${string}`[],
  slugFor: ReadonlyMap<string, string> = new Map(),
  bookIsPublic: (account: string) => boolean = () => false,
): Promise<PublicThesis[]> {
  if (accounts.length === 0) return [];
  const since = Math.floor(Date.now() / 1000) - PEER_WINDOW_SEC;
  const holes = accounts.map(() => "?").join(", ");
  const sources = SOURCES.map(() => "?").join(", ");
  // What the gate drops for its source, action or rule is dropped here too, so
  // the bounded scan below is not spent on a day of refused class entries. The
  // policy module builds it from its own constants, and the gate still decides.
  const narrow = publicationNarrowing("d", "t");
  // THE LANDED LANE's extra predicate. Only a buy or a sell whose trade filled
  // — on chain or on the paper book — is a trade worth remembering.
  const landed = `AND d.action IN ('buy', 'sell') AND COALESCE(t.status, '') IN (${LANDED_STATUSES.map(() => "?").join(", ")})`;
  // The quote-booked buys these accounts' sells could have closed, read once
  // per statement in front of it (thesis-policy.ts `basisScope`), not per sell.
  const basis = basisScope({ since, accounts });
  // `fills` asks for the trade's own figures, so a closed trade is remembered
  // with its result. The columns are the mirror's and long-standing, but a
  // ledger without them still yields every post, only without figures.
  const query = (fills: boolean, landedOnly: boolean) =>
    shared
      .prepare(
        `${fills ? basis.sql : ""}SELECT a.name AS name, a.x_handle AS x_handle, d.agent_id AS agent_id,
                d.action AS action, d.symbol AS symbol, d.size_usdg AS size_usdg,
                d.source AS source, d.reason AS reason, d.dropped_rule AS dropped_rule,
                d.hold_kind AS hold_kind,
                  p.body AS post,
                ${fills ? fillFigures("t") : ""}
                t.status AS status, t.reject_rule AS reject_rule, a.mode AS mode,
                COUNT(*) AS said, MAX(d.at) AS last_at, MIN(d.at) AS first_at
           FROM decisions d
           JOIN agents a ON a.smart_account = d.agent_id
           LEFT JOIN trades t ON t.id = (SELECT MAX(id) FROM trades WHERE decision_id = d.id)
           ${fills ? basisJoin("t") : ""}
             -- THE AGENT'S OWN WORDS, when it had any. A LEFT JOIN because
             -- almost no decision has a post: one is written only for a class
             -- trade that actually filled and whose writer cleared its gate,
             -- so absent is the overwhelmingly common case and must not drop
             -- the row. It is a separate column all the way to
             -- the renderer, because the two carry different trust: the reason
             -- column is ours and the post column is a model's.
             LEFT JOIN posts p ON p.decision_id = d.id
          WHERE a.mode IN ('live', 'paper')
            AND d.agent_id NOT LIKE 'rh:%'
            AND LOWER(d.agent_id) IN (${holes})
            AND d.at > ?
            AND d.source IN (${sources})
            AND (d.hold_kind IS NULL OR d.hold_kind <> 'GATE_FORCED_HOLD')
            AND (d.dropped_rule IS NULL OR d.dropped_rule NOT LIKE 'brain-%')
            AND ${narrow.sql}
            ${landedOnly ? landed : ""}
          GROUP BY a.name, a.x_handle, a.mode, d.agent_id, d.action, d.symbol, d.size_usdg,
                   d.source, d.reason, d.dropped_rule, d.hold_kind, t.status, t.reject_rule, p.body
          ORDER BY MAX(d.at) DESC, MAX(d.id) DESC
          LIMIT ? OFFSET ?`,
      );
  const binds = (fills: boolean, landedOnly: boolean) => [
    ...(fills ? basis.args : []),
    ...accounts.map((a) => a.toLowerCase()),
    since,
    ...SOURCES,
    ...narrow.args,
    ...(landedOnly ? LANDED_STATUSES : []),
  ];
  // THE ONLY WAY OUT OF THIS MODULE. Everything above is a row shape; this is
  // the gate, and it is the same one the public feed publishes through.
  //
  // THE BOOK'S PUBLICITY IS THE FEED'S, so "a peer file can only contain what
  // the public feed publishes" holds for figures too: a PUBLIC book's post
  // carries its size, its sized head and its realized dollars here exactly as
  // it does on the feed (D1), and a private book's carries its percentages and
  // nothing a size or a dollar can be read from. It was decorated nowhere, so
  // every peer lost the sizes the public feed shows; peerThesesForSlugs reads
  // the bit from settings the way read-theses does. A caller that passes no
  // lookup — the orchestrator's read of an agent's OWN memory — gets the
  // private default.
  const gate = (rows: ThesisRow[]) =>
    rows
      .map((r) => {
        const account = (r.agent_id ?? "").toLowerCase();
        return { ...r, slug: slugFor.get(account) ?? null, public_book: bookIsPublic(account) === true };
      })
      .map(publishableThesis)
      .filter((t): t is PublicThesis => t !== null);

  const read = async (fills: boolean): Promise<PublicThesis[]> => {
    const published: PublicThesis[] = [];
    const newest = query(fills, false);
    // Filter before applying the prompt limit. Otherwise 24 newer operational
    // rows hide every real thesis behind them and a followed desk looks silent.
    for (let offset = 0; offset < MAX_SCAN; offset += SCAN_BATCH) {
      const rows = (await newest.all(...binds(fills, false), SCAN_BATCH, offset)) as ThesisRow[];
      published.push(...gate(rows));
      if (published.length >= PEER_THESIS_LIMIT || rows.length < SCAN_BATCH) break;
    }
    // THE LANDED LANE: the newest trades that filled, whatever was said since.
    // A group the newest scan also returned is the same post, and is kept once.
    const kept = gate((await query(fills, true).all(...binds(fills, true), PEER_LANDED, 0)) as ThesisRow[]);
    const same = (t: PublicThesis) => JSON.stringify([t.name, t.slug, t.head, t.reason, t.post, t.outcome, t.at, t.firstAt]);
    const held = new Set(kept.map(same));
    const rest = published.filter((t) => !held.has(same(t)));
    return [...kept, ...rest.slice(0, Math.max(0, PEER_THESIS_LIMIT - kept.length))].sort((a, b) => b.at - a.at);
  };
  try {
    return await read(true);
  } catch {
    try {
      return await read(false);
    } catch {
      return [];
    }
  }
}

/** Slugs → published theses, in one call. What the orchestrator actually wants. */
export async function peerThesesForSlugs(
  shared: Db,
  slugs: readonly string[],
  identity: Pick<IdentityStore, "bySlug"> = getIdentityStore(),
  settings: (tenant: `0x${string}`) => Promise<unknown> = (tenant) => getSettingsStore().get(tenant),
): Promise<PublicThesis[]> {
  const peers = await resolvePeers(slugs, identity);
  // WHOSE BOOK IS PUBLIC, read per owner the way read-theses reads it: only an
  // explicit `true` opens one, and an unreadable setting is private — the
  // default that publishes less. Never spread: settings hold secrets, and this
  // bit is the only one that leaves.
  const open = new Set<string>();
  await Promise.all(
    [...new Set(peers.tenantFor.values())].map(async (tenant) => {
      try {
        const config = (await settings(tenant)) as { publicBook?: unknown } | null;
        if (config?.publicBook !== true) return;
        for (const [account, owner] of peers.tenantFor) if (owner === tenant) open.add(account);
      } catch {
        /* private */
      }
    }),
  );
  return readPeerTheses(shared, peers.accounts, peers.slugFor, (account) => open.has(account));
}
