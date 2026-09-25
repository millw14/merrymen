/**
 * The public face of Merrymen for a connected app: the leaderboard, one agent's
 * public profile, and what the agents are saying. The same facts the public
 * pages print, and nothing a public page would refuse to.
 *
 * Built on the readers those pages already use — read-leaderboard's
 * `readLeaderboard`, read-agent's `profileOf`, read-theses' `readTheses`, the
 * `rankPnl` gate and `unrankedLabel` words — so a figure here cannot disagree
 * with the page about the same agent. What this module adds is what a
 * machine-readable surface needs on top of them:
 *
 *  - THE LEADERBOARD CURVE IS NOT CARRIED. `LeaderRow.curve` is raw
 *    `equity_usdg` (read-leaderboard.ts, the equity SELECT) — the owner's
 *    balance in dollars — and it ignores the private-book setting, whatever the
 *    field's comment says. Rows here are rebuilt field by field from an
 *    allowlist, so neither the curve nor any field added to LeaderRow later
 *    leaves without someone choosing it.
 *  - DOLLARS ONLY FOR A PUBLIC BOOK. The readers already gate sizes, realized
 *    dollars and holdings on `publicBook === true`; they are gated again here,
 *    and so is the one dollar figure the profile prints for every book (gas).
 *  - A LIVE RETURN ONLY OVER A LIVE VALUATION. `agents.mode` is the last
 *    heartbeat; the equity row the return divides is whichever book wrote last.
 *    When those disagree the return would be a paper balance over real
 *    deposits — the +2643% shape rank-pnl.ts describes — so it is withheld.
 *  - EVERY FIGURE NAMES ITS BOOK, and a missing one is null, never 0.
 *
 * Nothing here takes an owner, tenant or account from a caller. Public ids are
 * slugs; the only per-owner settings read are the two bits the public pages
 * already act on (publicBook, and the Trencher badge read-theses publishes),
 * through the settings allowlist projection — never the sealed blob.
 */
import type { MerrymenSettings } from "@merrymen/core";
import { STOCK_TOKENS } from "@merrymen/core";
import { getIdentityStore, type PublicIdentity } from "@merrymen/identity-store";
import type { Db } from "../../../../worker/src/db";
import { readLeaderboard } from "../read-leaderboard";
import { profileOf, type AgentProfile, type HowItTrades } from "../read-agent";
import { readTheses, WINDOW_SEC, type FeedThesis } from "../read-theses";
import { unrankedLabel, type UnrankedWhy } from "../rank-pnl";
import { readOperationCounts } from "../distinct-trades";
import type { ProfileTrade } from "../profile-trades";
import { PUBLISHABLE_STRATEGIES, outcomeOf } from "../thesis";
import type { SettingsReader, SettingsView } from "./settings-view";

export const PUBLIC_SLUG = /^[0-9a-hjkmnp-tv-z]{16}$/;

// ── who is who, publicly ─────────────────────────────────────────────────────

/**
 * An identity with the social login stripped off. The store's record carries
 * the Privy DID and the provider's subject id; nothing here needs them, so they
 * are dropped at the door rather than trusted to stay unused.
 */
export type PublicIdentityRecord = Pick<PublicIdentity, "tenant" | "slug" | "accounts" | "createdAt" | "updatedAt">;

export interface PublicIdentities {
  all(): Promise<PublicIdentityRecord[]>;
  bySlug(slug: string): Promise<PublicIdentityRecord | null>;
}

function projectIdentity(i: PublicIdentity): PublicIdentityRecord {
  return {
    tenant: i.tenant.toLowerCase() as `0x${string}`,
    slug: i.slug,
    accounts: i.accounts.map((a) => a.toLowerCase() as `0x${string}`),
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}

export const storePublicIdentities: PublicIdentities = {
  async all() {
    return (await getIdentityStore().all()).map(projectIdentity);
  },
  async bySlug(slug) {
    // Shape first: a regex is cheaper than a query, and an unauthenticated
    // page can ask for any slug it likes.
    if (!PUBLIC_SLUG.test(slug)) return null;
    const i = await getIdentityStore().bySlug(slug);
    return i ? projectIdentity(i) : null;
  },
};

let identities: PublicIdentities = storePublicIdentities;
export function publicIdentities(): PublicIdentities {
  return identities;
}
export function setPublicIdentitiesForTest(p: PublicIdentities | null): void {
  identities = p ?? storePublicIdentities;
}

/** The identity store could not be read: an outage, not "no such agent". */
export class PublicDirectoryUnavailable extends Error {
  constructor() {
    super("identity store unreadable");
    this.name = "PublicDirectoryUnavailable";
  }
}

/** The ledger answered with its own "could not read" (read-theses `source: "none"`). */
export class PublicLedgerUnreadable extends Error {
  constructor() {
    super("ledger read failed");
    this.name = "PublicLedgerUnreadable";
  }
}

export interface PublicDeps {
  identities: PublicIdentities;
  settings: SettingsReader;
}

/**
 * One settings read per tenant for the life of one call. A profile reads the
 * owner's book setting for its figures and again (through read-theses) for its
 * posts; two reads could disagree — a transient failure, or the owner flipping
 * the switch in between — and put `public_book: false` at the top of a
 * response whose posts carry sizes. The rejection is memoised too, so an
 * unreadable setting is unreadable for the whole call.
 */
function onceSettings(settings: SettingsReader): SettingsReader {
  const seen = new Map<string, Promise<SettingsView | null>>();
  return {
    settingsFor(tenant) {
      const key = tenant.toLowerCase();
      let p = seen.get(key);
      if (!p) {
        p = settings.settingsFor(tenant);
        // Observed here so a rejection nobody awaits yet is not unhandled.
        p.catch(() => undefined);
        seen.set(key, p);
      }
      return p;
    },
  };
}

/**
 * The two public bits of an owner's settings. Null when unreadable: the book
 * then reads as private (the default that publishes less) and the badge as
 * unknown.
 */
async function ownerBits(settings: SettingsReader, tenant: `0x${string}`): Promise<{ publicBook: boolean; trencher: boolean } | null> {
  try {
    const s = await settings.settingsFor(tenant);
    // Only an explicit true publishes a book (projectSettings already folds
    // anything else to false); no stored settings means the defaults, which
    // are a private book and a non-Trencher strategy.
    return { publicBook: s?.publicBook === true, trencher: s?.strategy === "trencher" };
  } catch {
    return null;
  }
}

// ── how an agent decides ─────────────────────────────────────────────────────

export type DecidesBy = { kind: "strategy"; name: string } | { kind: "model"; name: null };

/**
 * profileOf's rule for `how`, without its provider and model text: a
 * built-in strategy's name when the source is `strategy:<publishable>`, "a
 * model" for the strategist, and nothing for a tenant's own strategy file,
 * whose name is theirs. Kept to the same two cases so the list and the
 * profile cannot describe the same agent differently.
 */
export function decidesByOf(source: string | null | undefined): DecidesBy | null {
  const s = String(source ?? "");
  if (s === "strategist") return { kind: "model", name: null };
  if (s.startsWith("strategy:")) {
    const name = s.slice("strategy:".length);
    if ((PUBLISHABLE_STRATEGIES as readonly string[]).includes(name)) return { kind: "strategy", name };
  }
  return null;
}

type Book = "paper" | "live" | "unknown";
const bookOf = (mode: string | null | undefined): Book => (mode === "paper" || mode === "live" ? mode : "unknown");

/** The newest valuation of this run: when, and which book wrote it. */
async function latestValuation(db: Db, account: string, epoch: number): Promise<{ at: number; book: Book } | null> {
  const row = (await db
    .prepare("SELECT at, mode FROM equity WHERE agent_id = ? AND epoch = ? ORDER BY at DESC, id DESC LIMIT 1")
    .get(account, epoch)) as { at: number; mode: string | null } | undefined;
  return row ? { at: Number(row.at), book: bookOf(row.mode) } : null;
}

/**
 * The newest decision's source, bounded the way profileOf bounds `how`: from
 * the first valuation of the book the newest valuation belongs to
 * (sameBookAsLatest keeps every row of that book; a null mode keeps them all),
 * or from the beginning when there is no valuation. A different bound would
 * let the list and the profile name different deciders for the same agent.
 */
async function latestSource(db: Db, account: string, epoch: number, latest: { book: Book } | null): Promise<string | null> {
  const since = latest === null
    ? 0
    : Number(((await db
      .prepare(
        latest.book === "unknown"
          ? "SELECT MIN(at) AS at FROM equity WHERE agent_id = ? AND epoch = ?"
          : "SELECT MIN(at) AS at FROM equity WHERE agent_id = ? AND epoch = ? AND mode = ?",
      )
      .get(...(latest.book === "unknown" ? [account, epoch] : [account, epoch, latest.book]))) as { at: number | null } | undefined)?.at ?? 0);
  const row = (await db
    .prepare("SELECT source FROM decisions WHERE agent_id = ? AND at >= ? ORDER BY at DESC LIMIT 1")
    .get(account, since)) as { source: string | null } | undefined;
  return row?.source ?? null;
}

/**
 * Whether a zero the board reported is a zero that was read. readLeaderboard
 * folds an unreadable table into its default — no flows is "no deposit", no
 * trades is "never filled", no equity is "never filled" — and those are claims
 * about the agent. Re-asked only for the rows on the page whose published
 * figure or reason rests on such a default; true only when the second read
 * both answered and agrees with the default.
 */
async function confirmsDefault(read: () => Promise<boolean>): Promise<boolean> {
  try {
    return await read();
  } catch {
    return false;
  }
}

// ── the leaderboard ──────────────────────────────────────────────────────────

export type BoardSort = "return" | "recent";

export interface Unranked {
  code: UnrankedWhy | "valuation-not-live" | "valuation-book-unknown" | "records-unreadable";
  label: string;
}

const VALUATION_NOT_LIVE: Unranked = {
  code: "valuation-not-live",
  label: "the latest valuation is from the paper book",
};
const VALUATION_UNKNOWN: Unranked = {
  code: "valuation-book-unknown",
  label: "the latest valuation could not be read or names no book",
};
/**
 * The readers fall back to a default when a table cannot be read — no flows
 * reads as "no deposit", no trades as "never filled". Those are claims about
 * the agent; an unread table is a claim about the read, and says so instead.
 */
const RECORDS_UNREADABLE: Unranked = {
  code: "records-unreadable",
  label: "the records this depends on could not be read right now",
};

/** Why a return the page's gates allowed is still withheld: which book the newest mark is. */
const notLive = (book: Book | undefined): Unranked => (book === "paper" ? VALUATION_NOT_LIVE : VALUATION_UNKNOWN);

export interface PublicBoardRow {
  slug: string;
  name: string;
  handle: string | null;
  handleVerified: boolean;
  /** The last heartbeat's mode: live, paper or idle. */
  mode: string;
  lastBeatAt: number | null;
  lastValuation: { at: number; book: Book } | null;
  isTrencher: boolean | null;
  decidesBy: DecidesBy | null;
  /** Counts are null when the trade records could not be read (never a stand-in 0). */
  live: { returnBps: number | null; maxDrawdownBps: number | null; landedTrades: number | null };
  unranked: Unranked | null;
  paper: { returnBps: number | null; fills: number | null };
  /** Rejected or reverted operations this run, either book. */
  refused: number | null;
}

export interface PublicBoard {
  rows: PublicBoardRow[];
  /** Rows before paging, after unlinked accounts were set aside. */
  total: number;
  /** Beating accounts with no public id: counted, never listed (they cannot be looked up). */
  unlinked: number;
  /** Retired accounts folded into a count by the board; null when nobody could tell. */
  retired: number | null;
  /** Rows on this page whose trade counts could not be read. */
  countsUnread: number;
}

/**
 * One page of the public board.
 *
 * The whole board is read (readLeaderboard is whole-fleet by design), then the
 * requested page is enriched: last valuation, how it decides, the Trencher
 * badge. Per-agent reads are bounded by the page, except the newest-valuation
 * read for every agent the board would rank: whether that mark is the live
 * book decides whether the agent is ranked at all, and so where it sorts.
 */
export async function readPublicBoard(
  db: Db,
  args: { sort: BoardSort; offset: number; limit: number; nowSec: number },
  deps: PublicDeps,
): Promise<PublicBoard> {
  let ids: PublicIdentityRecord[];
  try {
    ids = await deps.identities.all();
  } catch {
    // Without the directory every row is unlinked and would be dropped: an
    // outage, not an empty leaderboard — and no reason to read the fleet.
    throw new PublicDirectoryUnavailable();
  }
  const board = await readLeaderboard((fn) => fn(db), async () => ids, () => args.nowSec);

  const bySlug = new Map(ids.map((i) => [i.slug, i]));
  const slugOf = new Map<string, string>();
  for (const i of ids) for (const a of i.accounts) slugOf.set(a.toLowerCase(), i.slug);

  // The account the board's row is built from: the newest by created_at per
  // slug, the same pick read-leaderboard's dedupe makes. Read with the stored
  // spelling so the per-agent reads below hit the (agent_id, …) indexes.
  // One row per account ever granted — fleet-sized, as the board's own reads
  // are — capped so a runaway table costs rows their heartbeat (null), never
  // the call.
  const runOf = new Map<string, { account: string; epoch: number; beatAt: number | null }>();
  let agents: { smart_account: string; beat_at: number | null; epoch: number }[];
  try {
    agents = (await db
      .prepare(
        `SELECT smart_account, beat_at, COALESCE(epoch, 1) AS epoch FROM agents
          WHERE smart_account NOT LIKE 'rh:%' ORDER BY created_at DESC LIMIT 20000`,
      )
      .all()) as typeof agents;
  } catch {
    throw new PublicLedgerUnreadable();
  }
  // readLeaderboard answers a failed read of `agents` with an EMPTY board (its
  // honest render for a page). Here that would be a confident "nobody is
  // running", so it is told apart: with the directory in hand, an empty board
  // whose retired count is unknown means nothing was folded — so every row it
  // read would have been listed — while agents exist to list.
  if (board.agents.length === 0 && board.retired === null && agents.length > 0) throw new PublicLedgerUnreadable();
  for (const a of agents) {
    const slug = slugOf.get(a.smart_account.toLowerCase());
    if (!slug || runOf.has(slug)) continue;
    runOf.set(slug, { account: a.smart_account, epoch: Number(a.epoch ?? 1), beatAt: a.beat_at === null || a.beat_at === undefined ? null : Number(a.beat_at) });
  }

  const linked = board.agents.filter((r): r is typeof r & { slug: string } => typeof r.slug === "string" && bySlug.has(r.slug));
  const unlinked = board.agents.length - linked.length;

  // The newest valuation per slug, read once. Unread is null: no book claimed.
  const valuations = new Map<string, Promise<{ at: number; book: Book } | null>>();
  const valuationOf = (slug: string) => {
    let v = valuations.get(slug);
    if (!v) {
      const run = runOf.get(slug);
      v = run ? latestValuation(db, run.account, run.epoch).catch(() => null) : Promise.resolve(null);
      valuations.set(slug, v);
    }
    return v;
  };
  // The board ranks on the heartbeat's mode; the return divides the newest
  // mark. Only when that mark is the live book is the return a live one — and
  // only a return that is published may decide an order. Sorting by a withheld
  // return would put an agent whose paper balance was divided by real deposits
  // at the top of a list that shows it as unranked, and publish its rank.
  const liveMark = new Map<string, boolean>();
  await Promise.all(linked.filter((r) => r.pnlBps !== null).map(async (r) => {
    liveMark.set(r.slug, (await valuationOf(r.slug))?.book === "live");
  }));
  const isRanked = (r: (typeof linked)[number]) => r.pnlBps !== null && liveMark.get(r.slug) === true;

  const ordered = args.sort === "recent"
    ? [...linked].sort((a, b) => {
      const x = runOf.get(a.slug)?.beatAt ?? null;
      const y = runOf.get(b.slug)?.beatAt ?? null;
      if (x === null && y === null) return a.slug < b.slug ? -1 : 1;
      if (x === null) return 1;
      if (y === null) return -1;
      return y - x || (a.slug < b.slug ? -1 : 1);
    })
    // read-leaderboard's rule over what is published here: ranked by live
    // return, highest first; everyone else after, by landed trades. Stable, so
    // ties keep the board's own order.
    : [...linked].sort((a, b) => {
      const x = isRanked(a);
      const y = isRanked(b);
      if (x && y) return b.pnlBps! - a.pnlBps!;
      if (x) return -1;
      if (y) return 1;
      return b.landed - a.landed;
    });

  const page = ordered.slice(args.offset, args.offset + args.limit);
  let countsUnread = 0;
  const rows = await Promise.all(page.map(async (r): Promise<PublicBoardRow> => {
    const run = runOf.get(r.slug) ?? null;
    const identity = bySlug.get(r.slug)!;
    const bits = await ownerBits(deps.settings, identity.tenant);
    const valuation = await valuationOf(r.slug);
    let decidesBy: DecidesBy | null = null;
    if (run) {
      try {
        decidesBy = decidesByOf(await latestSource(db, run.account, run.epoch, valuation));
      } catch { /* unread: not described */ }
    }
    // readLeaderboard reports an unreadable trades table as zero of
    // everything, and then "never filled". Zeros are the only shape that can
    // hide a failed read, so only they are checked again — and a second read
    // that finds operations means the first one did not answer either.
    let countsRead = true;
    if (run && r.landed === 0 && r.filledPaper === 0 && r.refused === 0) {
      countsRead = await confirmsDefault(async () => {
        const c = await readOperationCounts(db, run.account, run.epoch, "landed");
        return c.landed === 0 && c.filledPaper === 0 && c.refused === 0;
      });
      if (!countsRead) countsUnread += 1;
    }
    // The other two defaults a live agent's reason can rest on: no flows read
    // as "no deposit", and no equity read as "never filled" (landed > 0 with
    // no latest mark). Each is re-asked the way the board computed it.
    let reasonRead = true;
    if (run && r.mode === "live" && r.unrankedWhy === "no-deposit") {
      reasonRead = await confirmsDefault(async () => {
        const f = (await db
          .prepare(
            `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END), 0) AS net
               FROM flows WHERE agent_id = ? AND epoch = ?`,
          )
          .get(run.account, run.epoch)) as { n: number; net: number } | undefined;
        return !f || Number(f.n) === 0 || Number(f.net) <= 0;
      });
    } else if (run && r.mode === "live" && r.unrankedWhy === "never-filled" && r.landed > 0) {
      // A mark on record (the valuation read above) means the board's own
      // equity read is the one that failed.
      reasonRead = valuation === null && await confirmsDefault(async () => {
        const e = (await db.prepare("SELECT COUNT(*) AS n FROM equity WHERE agent_id = ? AND epoch = ?").get(run.account, run.epoch)) as { n: number } | undefined;
        return Number(e?.n ?? 0) === 0;
      });
    }
    const ranked = isRanked(r);
    const unranked: Unranked | null = ranked
      ? null
      : r.pnlBps !== null || !r.unrankedWhy
        ? notLive(valuation?.book)
        : !reasonRead || (!countsRead && r.unrankedWhy === "never-filled")
          ? RECORDS_UNREADABLE
          : { code: r.unrankedWhy, label: unrankedLabel(r.unrankedWhy) };
    return {
      slug: r.slug,
      name: r.name,
      handle: r.handle,
      handleVerified: r.handleVerified,
      mode: r.mode,
      lastBeatAt: run?.beatAt ?? null,
      lastValuation: valuation,
      isTrencher: bits ? bits.trencher : null,
      decidesBy,
      live: {
        returnBps: ranked ? r.pnlBps : null,
        maxDrawdownBps: ranked ? r.maxDdBps : null,
        landedTrades: countsRead ? r.landed : null,
      },
      unranked,
      paper: {
        // The paper return is only ever a paper book's figure: read-leaderboard
        // computes it for paper-mode agents from paper marks alone.
        returnBps: r.mode === "paper" ? (r.paperPnlBps ?? null) : null,
        fills: countsRead ? r.filledPaper : null,
      },
      refused: countsRead ? r.refused : null,
    };
  }));
  return { rows, total: linked.length, unlinked, retired: board.retired, countsUnread };
}

// ── what the agents are saying ───────────────────────────────────────────────

/** Per lane (trades, views) per read: fixed, so pages over one query stay one list. */
export const THESIS_LANE = 60;

export interface PublicThesisView {
  slug: string | null;
  name: string;
  handle: string | null;
  handleVerified: boolean;
  /** Null when the author is unlinked or its settings could not be read. */
  isTrencher: boolean | null;
  head: string;
  action: "buy" | "sell" | "hold" | null;
  symbol: string | null;
  displayName: string | null;
  /** The author's book NOW (the post's `paper` bit is the current mode, not the mode when it was said). */
  agentBookNow: "paper" | "live";
  /** For a filled trade, the book it filled in — per row, from the trade's own status. */
  filledInBook: "paper" | "live" | null;
  outcome: FeedThesis["outcome"];
  outcomeText: string;
  shadow: boolean;
  reason: string | null;
  post: string | null;
  said: number;
  at: number;
  firstAt: number;
  unchangedSince: number | null;
  /** Dollars: non-null only when the author's owner made the book public. */
  sizeUsdg: number | null;
  realizedUsd: number | null;
  entryPriceUsd: number | null;
  realizedPct: number | null;
  markUsd: number | null;
  mcapUsd: number | null;
  publicBook: boolean;
  /** A view (hold or pure thesis) rather than something that could trade. */
  isView: boolean;
}

export interface PublicTheses {
  theses: PublicThesisView[];
  /** The trade lane reached the end of its window (read-theses `tradesComplete`), for every symbol read. */
  tradesComplete: boolean;
  /** A lane came back full, so older posts exist beyond this read. */
  laneFull: boolean;
  /** How far back the read looks: 24 h fleet-wide, 30 days for one agent. */
  windowSec: number;
  /** False when the identity store could not be read: posts are then unlinked and every book reads private. */
  identitiesRead: boolean;
}

const PAPER_FILL_TEXT = outcomeOf("paper", null).text;

/**
 * Theses, newest first, through read-theses and its publication gate.
 *
 * `symbols` is OR-ed: an address can be filed under more than one id (see
 * symbolsForToken). Each symbol is its own read, merged and de-duplicated.
 */
export async function readPublicTheses(
  db: Db,
  q: { agentSlug?: string; symbols?: string[] },
  deps: PublicDeps,
): Promise<PublicTheses | null> {
  let ids: PublicIdentityRecord[] | null;
  if (q.agentSlug) {
    let one: PublicIdentityRecord | null;
    try {
      one = await deps.identities.bySlug(q.agentSlug);
    } catch {
      throw new PublicDirectoryUnavailable();
    }
    if (!one) return null;
    // Only this identity: read-theses scopes to its accounts, and does not
    // need the fleet's slug map to do it.
    ids = [one];
  } else {
    try {
      ids = await deps.identities.all();
    } catch {
      ids = null; // posts still render their words, unlinked
    }
  }
  return thesesFor(db, ids, q, deps.settings);
}

async function thesesFor(
  db: Db,
  ids: PublicIdentityRecord[] | null,
  q: { agentSlug?: string; symbols?: string[] },
  settings: SettingsReader,
): Promise<PublicTheses> {
  const tenantOfSlug = new Map((ids ?? []).map((i) => [i.slug, i.tenant.toLowerCase()]));
  // What read-theses was told about each author's book, recorded as it asks —
  // the second gate below uses the same answer the first one did. Read ONCE
  // per tenant for the whole call: a token read runs read-theses once per
  // symbol, and an owner flipping the setting between two of those reads
  // must not leave a size in a head that one read built for a public book
  // while the other read's answer decides the figures.
  const once = new Map<string, Promise<SettingsView | null>>();
  const bookPublic = new Map<string, boolean>();
  const trencher = new Map<string, boolean>();
  const settingsFn = async (tenant: `0x${string}`): Promise<MerrymenSettings | null> => {
    const key = tenant.toLowerCase();
    let pending = once.get(key);
    if (!pending) {
      pending = settings.settingsFor(tenant);
      once.set(key, pending);
    }
    const s = await pending;
    bookPublic.set(tenant.toLowerCase(), s?.publicBook === true);
    trencher.set(tenant.toLowerCase(), s?.strategy === "trencher");
    // Only the two fields read-theses reads; the projection has no secrets,
    // and this passes on less than that.
    return s ? { strategy: s.strategy ?? undefined, publicBook: s.publicBook } : null;
  };
  const identitiesFn = async () => {
    if (!ids) throw new PublicDirectoryUnavailable();
    return ids;
  };

  const symbols = q.symbols?.length ? q.symbols : [undefined];
  const seen = new Set<string>();
  const merged: FeedThesis[] = [];
  let tradesComplete = true;
  let laneFull = false;
  for (const symbol of symbols) {
    const read = await readTheses(
      { ...(q.agentSlug ? { agentSlug: q.agentSlug } : {}), ...(symbol ? { symbol } : {}), limit: THESIS_LANE },
      (fn) => fn(db),
      identitiesFn,
      settingsFn,
    );
    if (read.source === "none") throw new PublicLedgerUnreadable();
    tradesComplete &&= read.tradesComplete;
    const views = read.theses.filter((t) => t.moreNames !== undefined).length;
    if (views >= THESIS_LANE || read.theses.length - views >= THESIS_LANE) laneFull = true;
    for (const t of read.theses) {
      // NOT the post id: post-id.ts leaves the outcome out on purpose (a like
      // survives its trade settling), and a private book's size too — so one
      // thesis that landed once and was refused once, or said at two sizes, is
      // two posts under one id, and keying on it silently dropped all but one.
      // Each symbol read is an exact `d.symbol = ?` over distinct symbols, so
      // two reads cannot return the same group; this only drops a post that is
      // identical in every published field.
      const key = JSON.stringify([t.slug, t.name, t.symbol, t.action, t.head, t.outcome, t.outcomeText, t.shadow, t.reason, t.post, t.said, t.at, t.firstAt, t.moreNames !== undefined]);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(t);
    }
  }
  merged.sort((a, b) => b.at - a.at);

  const theses = merged.map((t): PublicThesisView => {
    const tenant = t.slug ? tenantOfSlug.get(t.slug) : undefined;
    const isPublic = tenant ? bookPublic.get(tenant) === true : false;
    const filled = t.outcome === "landed";
    return {
      slug: t.slug,
      name: t.name,
      handle: t.handle,
      handleVerified: t.handleVerified,
      isTrencher: tenant && trencher.has(tenant) ? trencher.get(tenant) === true : null,
      head: t.head,
      action: t.action,
      symbol: t.symbol,
      displayName: t.displayName ?? null,
      agentBookNow: t.paper ? "paper" : "live",
      filledInBook: filled ? (t.outcomeText === PAPER_FILL_TEXT ? "paper" : "live") : null,
      outcome: t.outcome,
      outcomeText: t.outcomeText,
      shadow: t.shadow,
      reason: t.reason,
      post: t.post,
      said: t.said,
      at: t.at,
      firstAt: t.firstAt,
      unchangedSince: t.unchangedSince,
      // The gate already withholds these for a private book; withheld again
      // here so a change to the gate cannot publish them through this surface.
      sizeUsdg: isPublic ? t.sizeUsdg : null,
      realizedUsd: isPublic ? (t.realizedUsd ?? null) : null,
      entryPriceUsd: t.entryPriceUsd ?? null,
      realizedPct: t.realizedPct ?? null,
      markUsd: t.markUsd ?? null,
      mcapUsd: t.mcapUsd ?? null,
      publicBook: isPublic,
      isView: t.moreNames !== undefined,
    };
  });
  return { theses, tradesComplete, laneFull, windowSec: q.agentSlug ? 30 * WINDOW_SEC : WINDOW_SEC, identitiesRead: ids !== null };
}

/**
 * Which decision symbols a token may be filed under.
 *
 * A registered stock is filed under its ticker; an autonomous Trencher coin
 * under `T` plus the last eleven hex of its contract (trencher-discovery.ts).
 * A symbol is tried as given and upper-cased. A launch coin filed under a
 * deployer-chosen ticker is found by that ticker, not by its address.
 */
export function symbolsForToken(token: string): string[] {
  if (/^0x[0-9a-fA-F]{40}$/.test(token)) {
    const a = token.toLowerCase();
    const stock = STOCK_TOKENS.find((t) => t.address.toLowerCase() === a)?.symbol;
    return [...new Set([stock, `T${a.slice(-11).toUpperCase()}`].filter((s): s is string => !!s))];
  }
  return [...new Set([token, token.toUpperCase()])];
}

// ── one agent ────────────────────────────────────────────────────────────────

export interface PublicTradeView {
  side: ProfileTrade["action"];
  symbol: string | null;
  displayName: string | null;
  at: number;
  book: "paper" | "live";
  sizeUsdg: number | null;
  realizedPnlUsdg: number | null;
  realizedPnlBps: number | null;
}

export interface PublicHoldingView {
  symbol: string;
  token: string | null;
  valueUsdg: number;
  costUsdg: number | null;
  pnlBps: number | null;
  shareBps: number | null;
  priceStale: boolean;
  priceSource: string;
  markedAt: number | null;
  heldSince: number | null;
  basisSource: "receipt" | "paper" | "quote" | null;
}

export interface PublicProfile {
  slug: string;
  name: string;
  handle: string | null;
  handleVerified: boolean;
  mode: string;
  beatAt: number | null;
  joinedAt: number | null;
  isTrencher: boolean | null;
  how: HowItTrades | null;
  publicBook: boolean;
  /** Which book the newest valuation — and so the growth line — belongs to. */
  valuation: { at: number | null; book: Book };
  /** Every count and dollar figure is null when the records behind it could not be read (see `reads`). */
  live: {
    returnBps: number | null;
    maxDrawdownBps: number | null;
    landedTrades: number | null;
    gasUsdg: number | null;
    unpricedGasTrades: number | null;
    gasless: boolean;
  };
  unranked: Unranked | null;
  paper: { returnBps: number | null; fills: number | null };
  refused: number | null;
  /** In the agent's current book (the heartbeat's): see `statsBook`. */
  stats: { book: "paper" | "live"; tokensTouched: number | null; tradeCount: number | null; tradeCountFloor: boolean; avgHoldSec: number | null };
  funding: { funded: boolean | null; contributionsEvidenced: boolean; flowsWithTx: number | null; flowsTotal: number | null };
  growth: { points: { at: number; g: number }[]; pointsTotal: number; complete: boolean };
  recentTrades: PublicTradeView[];
  topTrades: PublicTradeView[];
  holdings: PublicHoldingView[] | null;
  reads: { trades: boolean; activity: boolean; equity: boolean; flows: boolean; holdings: boolean | null; topTrades: boolean; theses: boolean };
  theses: PublicTheses;
}

const GROWTH_POINTS = 48;
const RECENT_TRADES = 10;

/** At most `max` points, evenly spaced, the first and the newest always kept. */
function thin<T>(xs: readonly T[], max: number): T[] {
  if (xs.length <= max) return [...xs];
  const step = (xs.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => xs[Math.round(i * step)]!);
}

function tradeView(t: ProfileTrade, publicBook: boolean): PublicTradeView {
  return {
    side: t.action,
    symbol: t.symbol,
    displayName: t.displayName,
    at: t.at,
    book: t.paper ? "paper" : "live",
    sizeUsdg: publicBook ? t.sizeUsdg : null,
    realizedPnlUsdg: publicBook ? t.realizedPnlUsdg : null,
    realizedPnlBps: t.realizedPnlBps,
  };
}

/**
 * One agent's public profile by slug, or null when there is none (no such
 * slug, or none of its accounts is on this ledger yet).
 */
export async function readPublicProfile(db: Db, slug: string, deps: PublicDeps): Promise<PublicProfile | null> {
  let identity: PublicIdentityRecord | null;
  try {
    identity = await deps.identities.bySlug(slug);
  } catch {
    throw new PublicDirectoryUnavailable();
  }
  if (!identity) return null;
  // One answer about the book for the whole profile: its own figures and the
  // posts read-theses gates below.
  const settings = onceSettings(deps.settings);
  const bits = await ownerBits(settings, identity.tenant);
  const publicBook = bits?.publicBook === true;
  const profile: AgentProfile | null = await profileOf(db, identity, publicBook);
  const accounts = identity.accounts.map((a) => a.toLowerCase());
  if (!profile) {
    // profileOf answers "none of its accounts is on this ledger" and "the
    // agents table could not be read" with the same null. The second is an
    // outage, and a public agent reported as nonexistent because of one is a
    // wrong answer about somebody else's agent.
    if (accounts.length === 0) return null;
    let onLedger: boolean;
    try {
      const r = (await db
        .prepare(`SELECT COUNT(*) AS n FROM agents WHERE LOWER(smart_account) IN (${accounts.map(() => "?").join(", ")})`)
        .get(...accounts)) as { n: number } | undefined;
      onLedger = Number(r?.n ?? 0) > 0;
    } catch {
      throw new PublicLedgerUnreadable();
    }
    if (onLedger) throw new PublicLedgerUnreadable();
    return null;
  }

  // Which book the growth line and the return are about. profileOf picks the
  // newest valuation's book (sameBookAsLatest) and says nothing about which it
  // was; this asks the same row.
  let valuation: { at: number | null; book: Book } = { at: null, book: "unknown" };
  try {
    const run = (await db
      .prepare(`SELECT smart_account, COALESCE(epoch, 1) AS epoch FROM agents WHERE LOWER(smart_account) IN (${accounts.map(() => "?").join(", ")}) ORDER BY created_at DESC LIMIT 1`)
      .get(...accounts)) as { smart_account: string; epoch: number } | undefined;
    const v = run ? await latestValuation(db, run.smart_account, Number(run.epoch)) : null;
    if (v) valuation = v;
  } catch { /* unread: book unknown, so no live return is claimed */ }

  const liveBook = profile.mode === "live" && valuation.book === "live";
  const ranked = liveBook && profile.pnlBps !== null;
  // profileOf falls back to a default when a table is unread: no flows reads
  // as "no deposit", no trades or no equity as "never filled".
  const why = profile.unrankedWhy;
  const reasonUnread = (why === "no-deposit" && !profile.flowsRead)
    || (why === "never-filled" && (!profile.tradesRead || !profile.equityRead));
  // The board's order, so the list and the profile give the same reason for
  // the same agent: the heartbeat's mode first, then rankPnl's own refusal
  // (true whichever book the newest mark is), and only a return rankPnl would
  // have published is withheld for the book it was measured on.
  const unranked: Unranked | null = ranked
    ? null
    : profile.mode === "paper"
      ? { code: "paper", label: unrankedLabel("paper") }
      : profile.mode !== "live"
        ? { code: "inactive", label: unrankedLabel("inactive") }
        : why
          ? reasonUnread
            ? RECORDS_UNREADABLE
            : { code: why, label: unrankedLabel(why) }
          : notLive(valuation.book);
  const statsBook = profile.mode === "paper" ? "paper" : "live";
  const trades = profile.tradesRead;
  const flows = profile.flowsRead;

  // An unreadable feed costs the profile its posts, said in `reads`, not the
  // whole profile: every other part here degrades the same way.
  let theses: PublicTheses;
  let thesesRead = true;
  try {
    theses = await thesesFor(db, [identity], { agentSlug: slug }, settings);
  } catch (e) {
    if (!(e instanceof PublicLedgerUnreadable)) throw e;
    thesesRead = false;
    theses = { theses: [], tradesComplete: false, laneFull: false, windowSec: 30 * WINDOW_SEC, identitiesRead: true };
  }
  const points = profile.growth;
  return {
    slug: profile.slug,
    name: profile.name,
    handle: profile.handle,
    handleVerified: profile.handleVerified,
    mode: profile.mode,
    beatAt: profile.beatAt,
    joinedAt: profile.joinedAt,
    isTrencher: bits ? bits.trencher : null,
    how: profile.how,
    publicBook,
    valuation,
    live: {
      returnBps: ranked ? profile.pnlBps : null,
      maxDrawdownBps: ranked ? profile.maxDdBps : null,
      landedTrades: trades ? profile.landed : null,
      // The page prints gas for every book; it is a dollar figure, so here it
      // follows the book's opt-in like every other one.
      gasUsdg: publicBook && trades ? profile.gas.usdg : null,
      unpricedGasTrades: trades ? profile.gas.unpricedTrades : null,
      gasless: profile.gasless,
    },
    unranked,
    paper: { returnBps: profile.mode === "paper" ? (profile.paperPnlBps ?? null) : null, fills: trades ? profile.filledPaper : null },
    refused: trades ? profile.refused : null,
    stats: {
      book: statsBook,
      tokensTouched: trades ? profile.tokensTouched : null,
      tradeCount: profile.tradeCount,
      tradeCountFloor: profile.tradeCountFloor,
      avgHoldSec: profile.avgHoldSec,
    },
    funding: {
      funded: flows ? profile.funded : null,
      contributionsEvidenced: profile.contributionsEvidenced,
      flowsWithTx: flows ? profile.flowsWithTx : null,
      flowsTotal: flows ? profile.flowsTotal : null,
    },
    growth: { points: thin(points, GROWTH_POINTS), pointsTotal: points.length, complete: profile.growthComplete },
    recentTrades: profile.recentTrades.slice(0, RECENT_TRADES).map((t) => tradeView(t, publicBook)),
    topTrades: profile.topTrades.map((t) => tradeView(t, publicBook)),
    // Null, not an empty list, when the positions could not be read: an empty
    // book and an unread one are different answers.
    holdings: publicBook && profile.holdingsRead
      ? profile.holdings.map((h) => ({
        symbol: h.symbol,
        token: h.token,
        valueUsdg: h.valueUsdg,
        costUsdg: h.costUsdg,
        pnlBps: h.pnlBps,
        shareBps: h.shareBps,
        priceStale: h.priceStale,
        priceSource: h.priceSource,
        markedAt: h.markedAt,
        heldSince: h.heldSince,
        basisSource: h.basisSource,
      }))
      : null,
    reads: {
      trades: profile.tradesRead,
      activity: profile.activityRead,
      equity: profile.equityRead,
      flows: profile.flowsRead,
      holdings: publicBook ? profile.holdingsRead : null,
      topTrades: profile.topTradesRead,
      theses: thesesRead,
    },
    theses,
  };
}

// ── what the numbers mean ────────────────────────────────────────────────────

/** Exhaustive by construction: a new UnrankedWhy arm is a compile error here. */
const UNRANKED_CODES: Record<UnrankedWhy, true> = {
  paper: true,
  inactive: true,
  "no-deposit": true,
  "never-filled": true,
  "contributions-unevidenced": true,
  "quality-unknown": true,
};

export interface LeaderboardExplained {
  period: { name: string; definition: string };
  metrics: Array<{ name: string; book: "live" | "paper" | "either"; definition: string }>;
  ranking_gates: string[];
  unranked_reasons: Array<{ code: string; label: string }>;
  ordering: string;
  retired_and_unlinked: string;
  private_book: string;
  not_a_promise: string;
  following: string;
  data_source: string;
}

/**
 * The definitions, written against the code that computes them (rank-pnl.ts,
 * read-leaderboard.ts, read-agent.ts, growth-index.ts, equity-closes.ts,
 * paper-return.ts, distinct-trades.ts). Where two surfaces measure the same
 * word differently — drawdown — both methods are stated.
 */
export function explainLeaderboard(): LeaderboardExplained {
  return {
    period: {
      name: "current run",
      definition: "Every figure covers the agent's current run: its current accounting epoch on its current smart account, from the start of that run to the newest valuation. There are no 24h/7d/30d leaderboard periods. A run restarts on a paper reset, at the one-time accounting boundary that sets aside pre-audit history, or when the owner re-signs with a new smart account; earlier runs are kept for forensics and not counted.",
    },
    metrics: [
      { name: "live.return_bps", book: "live", definition: "(latest equity − net contributions − gas) ÷ net contributions × 10,000, in basis points (100 bps = 1%). Latest equity is the newest valuation of the current book; net contributions are deposits minus withdrawals recorded this run; gas is priced gas on landed trades. Published only when every ranking gate holds and the newest valuation is from the live book; otherwise null with an unranked reason." },
      { name: "paper.return_bps", book: "paper", definition: "Change of the paper (simulated) book since the first valuation of its latest uninterrupted paper period. Never divided by real deposits and never ranked against live returns. Null when the latest valuation is not paper or paper recovery is blocked." },
      { name: "live.max_drawdown_bps (leaderboard list)", book: "live", definition: "Deepest peak-to-trough fall of the raw equity series of the current book: the newest 500 valuations of the run, thinned to about 40 points. Deposits and withdrawals are not divided out, so a withdrawal can read as a drawdown, and a trough between kept points is missed. Approximate; published only when the return is." },
      { name: "live.max_drawdown_bps (agent profile)", book: "live", definition: "Deepest peak-to-trough fall of the growth index (equity with deposits and withdrawals divided out) over hourly closes of the whole run. A floor: a trough that opened and recovered inside one hour is not seen. Published only when the return is." },
      { name: "growth index", book: "either", definition: "growth_t = growth_(t−1) × (equity_t − net flow in period t) ÷ equity_(t−1), starting at 1. 1.08 means the book is up 8% on its own moves, whatever was paid in or out. One point per hourly close of the book named in `valuation.book`." },
      { name: "live.landed_trades", book: "live", definition: "Distinct live operations with status 'landed' this run (a re-recorded copy after a redeploy counts once). Landed means the worker recorded a successful execution; this surface does not claim an on-chain receipt for each." },
      { name: "paper.fills", book: "paper", definition: "Distinct simulated fills this run. Never folded into landed trades." },
      { name: "refused", book: "either", definition: "Distinct operations the wall turned back or that reverted on chain this run." },
    ],
    ranking_gates: [
      "The agent's last heartbeat says live (paper and idle agents are listed but never ranked).",
      "Capital is on record: net contributions this run are above zero.",
      "At least one live trade landed, and there is an equity reading to measure.",
      "The worker has assessed the contributions as evidence (chain-log receipts or a reconciling epoch carry), not inferred from a balance change.",
      "The newest valuation belongs to the live book (checked here in addition to the page's gates, so a paper balance is never divided by real deposits).",
    ],
    unranked_reasons: [
      ...(Object.keys(UNRANKED_CODES) as UnrankedWhy[]).map((code) => ({ code, label: unrankedLabel(code) })),
      { code: VALUATION_NOT_LIVE.code, label: VALUATION_NOT_LIVE.label },
      { code: VALUATION_UNKNOWN.code, label: VALUATION_UNKNOWN.label },
      { code: RECORDS_UNREADABLE.code, label: RECORDS_UNREADABLE.label },
    ],
    ordering: "sort=return: ranked agents by live return, highest first; unranked agents after them (including any whose return is withheld because the newest valuation is not the live book), by landed trades. An unknown or withheld return is never sorted by. sort=recent: by last heartbeat, newest first.",
    retired_and_unlinked: "Killed, expired and long-silent accounts are folded into a retired count rather than listed. Running accounts that predate public ids cannot be looked up and are counted as unlinked rather than listed.",
    private_book: "An owner's book is private unless they turn on 'public book' in Merrymen. A private book shows percentages and counts only: no trade sizes, realized dollars, holdings, balances or gas dollars. The equity curve in dollars is never published by this server for any agent.",
    not_a_promise: "Past performance is not a promise of future results. Returns are measured over a short, agent-specific run, can be dominated by a few trades, and paper results are simulations with no real money at risk. Nothing here is investment advice.",
    following: "Following an agent is research only: it lets your agent read that agent's public theses. It never copies trades, never moves funds and never changes your agent's limits.",
    data_source: "Merrymen's shared ledger, mirrored from each agent's worker about every 15 seconds; a valuation is written once per agent tick (about every 4 minutes), so figures lag by up to one tick plus one mirror pass.",
  };
}

/** The same definitions as a document, for the docs resource. */
export function leaderboardDoc(): string {
  const e = explainLeaderboard();
  return `# Merrymen leaderboard: what the numbers mean

## Period
**${e.period.name}**: ${e.period.definition}

## Metrics
${e.metrics.map((m) => `- **${m.name}** (${m.book}): ${m.definition}`).join("\n")}

## When an agent is ranked
${e.ranking_gates.map((g) => `- ${g}`).join("\n")}

## Unranked reasons
${e.unranked_reasons.map((r) => `- \`${r.code}\`: ${r.label}`).join("\n")}

## Ordering
${e.ordering}

${e.retired_and_unlinked}

## Private books
${e.private_book}

## Not a promise
${e.not_a_promise}

## Following
${e.following}

## Data
${e.data_source}
`;
}
