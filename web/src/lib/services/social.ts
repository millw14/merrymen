/**
 * The owner's social acts, as a connected app may perform them: wiring another
 * agent's public thinking into their own agent's research, and turning their
 * own confirmed trades into something they can share.
 *
 * FOLLOWING IS RESEARCH, NEVER COPYING. A follow edge makes the orchestrator
 * put the target's PUBLIC theses (the ones /api/theses already publishes,
 * through publishableThesis) into the owner's agent's peers.json. The agent
 * reads them as evidence beside its own; nothing anywhere turns a peer's trade
 * into an order. Every answer here says so in words, because "follow" on a
 * trading product reads as copy-trading to most people, and the difference is
 * whose judgement spends the money.
 *
 * THE SAME RULES AS THE FOLLOW ROUTE (web/src/app/api/follow/route.ts), plus
 * one it deliberately skips. Shape before store, no self-follow (checked
 * against every agent the owner has, not just the ones this connection sees),
 * the store's own cap, and unfollow unchecked so an old edge stays removable.
 * The addition is EXISTENCE: the route trusts a UI that only shows real
 * agents, but a connected app can type any slug, and an edge to nobody spends
 * one of eight prompt slots on nothing. So a new edge must point at an agent
 * with a public identity AND a profile on the shared ledger. An existing edge
 * that later dangles is still left alone, as the route intends.
 *
 * A SHARE IS VERIFIED OR IT IS NOT SENT. Only operations the ledger records as
 * landed with a transaction hash count as trades, a realized figure counts only
 * when both its proceeds and its cost are measurements (a receipt, and
 * readEvidencedSells' replay), and paper fills are practice: counted in their
 * own section, never in a real figure. The owner's publicBook setting decides
 * whether dollars appear at all, the same bit the public pages obey.
 *
 * Read-only on the ledger and no MCP imports; the only write is the follow
 * store's own.
 */
import { chainForId } from "@merrymen/core";
import type { Db } from "../../../../worker/src/db";
import { admitOwnerLine } from "../../../../worker/src/groupchat/policy";
import {
  MAX_FOLLOWS, SLUG_SHAPE, getFollowStore, isSelfFollow, type FollowEdge, type FollowStore,
} from "../../../../worker/src/follow-store";
import { distinctTrades, OP_COPY_REACH_SEC } from "../distinct-trades";
import { usd } from "../format";
import { publicIdentities, PublicDirectoryUnavailable, PublicLedgerUnreadable, type PublicIdentities } from "./public-feed";
import { readTradeDetail, readTradePage, type LedgerScope, type TradeView } from "./portfolio";

export { MAX_FOLLOWS };

/** What a follow does, in the words every follow answer carries. */
export const FOLLOW_MEANING =
  "Following makes the target agent's public theses (what it has said on the public feed) part of your agent's research: your agent reads them as one more piece of evidence and still decides for itself. It never copies the target's trades, and nothing is bought or sold because of a follow.";

/** When a change reaches the agent: the orchestrator rewrites the peer file on its own pass. */
export const FOLLOW_TIMING =
  "Takes effect when the orchestrator next refreshes your agent's peer file (it does this on its regular pass), not instantly.";

// ── the follow store, with a seam ───────────────────────────────────────────

export type FollowStoreLike = Pick<FollowStore, "following" | "follow" | "unfollow">;

let storeOverride: FollowStoreLike | null = null;
export function followStore(): FollowStoreLike {
  return storeOverride ?? getFollowStore();
}
/** Test seam: the hosted store opens its own Postgres client, which no test may reach. */
export function setFollowStoreForTest(s: FollowStoreLike | null): void {
  storeOverride = s;
}

/** The follow graph could not be read or written: an outage, never "no follows". */
export class FollowStoreUnavailable extends Error {
  constructor() {
    super("follow store unreachable");
    this.name = "FollowStoreUnavailable";
  }
}

export interface FollowDeps {
  store: FollowStoreLike;
  identities: Pick<PublicIdentities, "bySlug">;
}

export function followDeps(): FollowDeps {
  return { store: followStore(), identities: publicIdentities() };
}

async function guardStore<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch {
    // The store's own error can carry a connection string; none of it leaves.
    throw new FollowStoreUnavailable();
  }
}

export function isFollowTarget(s: unknown): s is string {
  return typeof s === "string" && SLUG_SHAPE.test(s);
}

/** A public agent a follow may point at. */
export interface FollowTarget {
  slug: string;
  tenant: `0x${string}`;
  /** Owner-chosen, so untrusted; null when the ledger row has none. */
  name: string | null;
  mode: string | null;
}

interface LedgerAgent {
  name: string | null;
  mode: string | null;
}

async function ledgerAgentOf(db: Db, accounts: readonly string[]): Promise<LedgerAgent | null> {
  const list = [...new Set(accounts.map((a) => a.toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)))].slice(0, 16);
  if (!list.length) return null;
  const row = (await db
    .prepare(`SELECT name, mode FROM agents WHERE LOWER(smart_account) IN (${list.map(() => "?").join(", ")}) ORDER BY created_at DESC LIMIT 1`)
    .get(...list)) as { name: unknown; mode: unknown } | undefined;
  if (!row) return null;
  return {
    name: typeof row.name === "string" && row.name.trim() ? row.name : null,
    mode: typeof row.mode === "string" ? row.mode : null,
  };
}

/**
 * The agent behind a slug, when it is PUBLIC: an identity the directory knows
 * and a row on the shared ledger (what a profile page needs to exist). Null
 * otherwise. Throws PublicDirectoryUnavailable when the directory cannot be
 * read, and PublicLedgerUnreadable when the ledger cannot: both are outages and
 * must not read as "no such agent" (nor leave with the driver's own text).
 */
export async function resolvePublicTarget(db: Db, slug: string, identities: Pick<PublicIdentities, "bySlug">): Promise<FollowTarget | null> {
  if (!isFollowTarget(slug)) return null;
  let identity: Awaited<ReturnType<PublicIdentities["bySlug"]>>;
  try {
    identity = await identities.bySlug(slug);
  } catch {
    throw new PublicDirectoryUnavailable();
  }
  if (!identity || identity.slug !== slug) return null;
  let agent: LedgerAgent | null;
  try {
    agent = await ledgerAgentOf(db, identity.accounts);
  } catch {
    throw new PublicLedgerUnreadable();
  }
  if (!agent) return null;
  return { slug, tenant: identity.tenant.toLowerCase() as `0x${string}`, name: agent.name, mode: agent.mode };
}

export interface FollowState {
  /** Slugs this owner's agents read, newest first. */
  wired: string[];
  max: number;
}

async function stateOf(store: FollowStoreLike, tenant: `0x${string}`): Promise<FollowState> {
  const edges = await guardStore(() => store.following(tenant));
  return { wired: edges.map((e) => e.target), max: MAX_FOLLOWS };
}

export type FollowOutcome =
  | ({ ok: true; changed: boolean; target: FollowTarget } & FollowState)
  | ({ ok: false; why: "self" | "unknown" | "at-capacity" } & FollowState);

/**
 * Wire `target` into the owner's research.
 *
 * `ownSlugs` is every agent the owner has, from the directory: a self-follow
 * is refused for any of them, not only the one this connection was shown,
 * and also when the target's identity is the owner's own tenant — the two
 * checks fail differently, and either one alone has a gap.
 */
export async function followAgent(
  db: Db,
  tenant: `0x${string}`,
  target: string,
  ownSlugs: readonly string[],
  deps: FollowDeps,
): Promise<FollowOutcome> {
  const t = tenant.toLowerCase() as `0x${string}`;
  if (!isFollowTarget(target)) return { ok: false, why: "unknown", ...(await stateOf(deps.store, t)) };
  if (ownSlugs.some((mine) => isSelfFollow(mine, target))) return { ok: false, why: "self", ...(await stateOf(deps.store, t)) };
  const resolved = await resolvePublicTarget(db, target, deps.identities);
  if (resolved && resolved.tenant === t) return { ok: false, why: "self", ...(await stateOf(deps.store, t)) };
  if (!resolved) return { ok: false, why: "unknown", ...(await stateOf(deps.store, t)) };
  const before = await stateOf(deps.store, t);
  const already = before.wired.includes(target);
  // The store is the authority on the cap: it answers false only for a NEW
  // edge past MAX_FOLLOWS, and an existing edge is never refused.
  const ok = await guardStore(() => deps.store.follow(t, target));
  const after = await stateOf(deps.store, t);
  if (!ok) return { ok: false, why: "at-capacity", ...after };
  return { ok: true, changed: !already, target: resolved, ...after };
}

/**
 * Cut an edge. No self check and no existence check, as in the route: an edge
 * written before either rule, or to an agent since deleted, must stay
 * removable.
 *
 * The delete is issued whether or not the first read saw the edge, as the
 * route does: a follow racing in from another replica between that read and
 * this call must not survive an unfollow the caller was told succeeded. The
 * delete is idempotent, so the extra statement costs nothing but a round trip.
 */
export async function unfollowAgent(tenant: `0x${string}`, target: string, deps: Pick<FollowDeps, "store">): Promise<{ changed: boolean } & FollowState> {
  const t = tenant.toLowerCase() as `0x${string}`;
  const before = await stateOf(deps.store, t);
  await guardStore(() => deps.store.unfollow(t, target));
  const after = await stateOf(deps.store, t);
  return { changed: before.wired.includes(target) && !after.wired.includes(target), ...after };
}

export interface FollowingEntry {
  target: string;
  followedAt: number | null;
  /** Null when the directory or ledger could not say. */
  name: string | null;
  /** False when the slug no longer resolves to a public agent; null when that could not be checked. */
  public: boolean | null;
}

/** Edges past the cap are read but bounded: a racing Postgres insert can overshoot by one. */
const FOLLOWING_READ_MAX = MAX_FOLLOWS * 2;

/**
 * The owner's edges, newest first, each checked against the public directory.
 * `total` is every edge the store holds (a race can put it past MAX_FOLLOWS);
 * `entries` is at most FOLLOWING_READ_MAX of them. The orchestrator feeds only
 * the newest MAX_FOLLOWS into research, the same slice the caller must report.
 */
export async function readFollowing(db: Db, tenant: `0x${string}`, deps: FollowDeps): Promise<{ entries: FollowingEntry[]; total: number; namesRead: boolean }> {
  const all: FollowEdge[] = await guardStore(() => deps.store.following(tenant.toLowerCase() as `0x${string}`));
  const edges = all.slice(0, FOLLOWING_READ_MAX);
  let namesRead = true;
  const entries: FollowingEntry[] = [];
  for (const e of edges) {
    let name: string | null = null;
    let pub: boolean | null = null;
    try {
      const resolved = await resolvePublicTarget(db, e.target, deps.identities);
      pub = resolved !== null;
      name = resolved?.name ?? null;
    } catch {
      namesRead = false;
    }
    entries.push({ target: e.target, followedAt: Number.isFinite(e.createdAt) && e.createdAt > 0 ? e.createdAt : null, name, public: pub });
  }
  return { entries, total: all.length, namesRead };
}

// ── a verified, share-ready summary of the owner's own trades ──────────────

export type SharePeriod = "day" | "week";
export const SHARE_PERIOD_SEC: Record<SharePeriod, number> = { day: 86_400, week: 7 * 86_400 };
const PERIOD_WORDS: Record<SharePeriod, string> = { day: "the last 24 hours", week: "the last 7 days" };

/** Only swaps and launch-curve trades are trades; vault moves and transfers are not. */
const TRADE_KINDS: ReadonlySet<string> = new Set(["swap", "curve-trade"]);
const SCAN_PAGE = 100;
const SCAN_PAGES = 5;
/** Operations read per book before a summary stops and says it is incomplete. */
export const SHARE_SCAN_MAX = SCAN_PAGE * SCAN_PAGES;
/** Confirmed trades listed individually; the rest are counted. */
export const SHARE_LIST_MAX = 20;

export interface ShareTrade {
  id: string;
  at: number;
  book: "live" | "paper";
  side: "buy" | "sell" | "swap" | null;
  token: string | null;
  symbol: string | null;
  displayName: string | null;
  /** Null when the book is private. */
  sizeUsdg: number | null;
  /** Null when the book is private or the figure is not a measurement. */
  realizedPnlUsdg: number | null;
  realizedReturnPct: number | null;
  realizedMeasured: boolean;
  txHash: string | null;
  explorerUrl: string | null;
}

export interface ShareBook {
  trades: number;
  buys: number;
  sells: number;
  measuredSells: number;
  unmeasuredSells: number;
  wins: number;
  losses: number;
  /** Σ realized ÷ Σ cost over measured sells; null when none, or the read was cut short. */
  returnPct: number | null;
  /** Null for a private book, and whenever returnPct is null. */
  pnlUsdg: number | null;
  complete: boolean;
}

export interface ShareSummary {
  kind: "trade" | "period";
  requestedTradeId: string | null;
  period: SharePeriod | null;
  since: number | null;
  until: number;
  chainId: number;
  chainName: string;
  realMoney: boolean;
  publicBook: boolean;
  settingRead: boolean;
  real: ShareBook;
  practice: ShareBook;
  excluded: { submitted: number; failed: number; landedWithoutTxHash: number } | null;
  trades: ShareTrade[];
  tradesTotal: number;
  warnings: string[];
}

/** Why a single trade cannot be shared as verified. */
export class NotShareable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotShareable";
  }
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * The measured half of a sell, or null. Measured means: the sell's proceeds
 * are its own book's evidence (a receipt for live, a paper fill for paper),
 * readEvidencedSells vouched for the cost it sold against, and the cost is a
 * positive number — the same test profile-trades applies before it prints a
 * return at all.
 */
function measuredSell(t: TradeView): { pnl: number; cost: number } | null {
  if (t.side !== "sell" || t.realized_pnl_measured !== true) return null;
  const own = t.book === "paper" ? "paper" : "receipt";
  if (t.basis_source !== own) return null;
  const pnl = t.realized_pnl_usdg;
  const cash = t.fill_cash_usdg;
  if (pnl === null || cash === null || !Number.isFinite(pnl) || !Number.isFinite(cash) || cash < 0) return null;
  const cost = cash - pnl;
  return cost > 0 ? { pnl, cost } : null;
}

function emptyBook(complete: boolean): ShareBook {
  return { trades: 0, buys: 0, sells: 0, measuredSells: 0, unmeasuredSells: 0, wins: 0, losses: 0, returnPct: null, pnlUsdg: null, complete };
}

function tally(trades: readonly TradeView[], complete: boolean, publicBook: boolean): ShareBook {
  const b = emptyBook(complete);
  let pnl = 0;
  let cost = 0;
  for (const t of trades) {
    b.trades++;
    if (t.side === "buy") b.buys++;
    if (t.side !== "sell") continue;
    b.sells++;
    const m = measuredSell(t);
    if (!m) {
      b.unmeasuredSells++;
      continue;
    }
    b.measuredSells++;
    if (m.pnl > 0) b.wins++;
    else if (m.pnl < 0) b.losses++;
    pnl += m.pnl;
    cost += m.cost;
  }
  // A total over a cut-short read would be a figure about some of the trades
  // presented as all of them.
  if (complete && b.measuredSells > 0 && cost > 0) {
    b.returnPct = round2((pnl / cost) * 100);
    b.pnlUsdg = publicBook ? round2(pnl) : null;
  }
  return b;
}

function shareTradeOf(t: TradeView, publicBook: boolean): ShareTrade {
  const m = measuredSell(t);
  const book = t.book === "paper" ? "paper" : "live";
  return {
    id: t.id,
    at: t.at,
    book,
    side: t.side,
    token: t.token,
    symbol: t.symbol,
    displayName: t.display_name,
    // The executed cash, never the order's requested amount: a share states
    // what happened, and a missing fill figure stays missing.
    sizeUsdg: publicBook ? t.fill_cash_usdg : null,
    realizedPnlUsdg: publicBook && m ? round2(m.pnl) : null,
    realizedReturnPct: m ? round2((m.pnl / m.cost) * 100) : null,
    realizedMeasured: m !== null,
    // A paper fill has no transaction; a live one is listed only with its hash.
    txHash: book === "live" ? t.tx_hash : null,
    explorerUrl: book === "live" ? t.explorer_url : null,
  };
}

function isConfirmedTrade(t: TradeView): boolean {
  return TRADE_KINDS.has(t.kind) && t.status === "confirmed" && t.tx_hash !== null && t.explorer_url !== null;
}

async function scan(db: Db, scope: LedgerScope, status: "confirmed" | "paper", since: number): Promise<{ trades: TradeView[]; complete: boolean }> {
  const out: TradeView[] = [];
  let cursor: { at: number; id: number } | null = null;
  for (let page = 0; page < SCAN_PAGES; page++) {
    const r = await readTradePage(db, scope, { book: status === "paper" ? "paper" : "live", status, token: null, since }, cursor, SCAN_PAGE);
    out.push(...r.trades);
    if (!r.next) return { trades: out, complete: true };
    cursor = r.next;
  }
  return { trades: out, complete: false };
}

/**
 * Trade attempts in the window that are not confirmed, so the reader knows what was left out.
 *
 * "Landed without a hash" is the exact complement, among landed rows, of the
 * confirmed filter readTradePage applies (portfolio.ts CONFIRMED_SQL: a
 * 0x-prefixed, 66-character hash), NULL-safe. Testing only for a NULL or empty
 * hash would let a landed row with a truncated or garbled one fall between the
 * two: neither listed as confirmed nor counted as left out.
 */
async function unconfirmedCounts(db: Db, scope: LedgerScope, since: number, until: number): Promise<{ submitted: number; failed: number; landedWithoutTxHash: number }> {
  const qs = scope.accounts.map(() => "?").join(", ");
  const r = (await db
    .prepare(`SELECT
        COUNT(CASE WHEN t.status = 'submitted' THEN 1 END) AS submitted,
        COUNT(CASE WHEN t.status = 'reverted' THEN 1 END) AS failed,
        COUNT(CASE WHEN t.status = 'landed' AND (t.tx_hash IS NULL OR NOT (t.tx_hash LIKE '0x%' AND length(t.tx_hash) = 66)) THEN 1 END) AS landed_no_hash
       FROM ${distinctTrades(`lower(t.agent_id) IN (${qs}) AND t.created_at > ?`)}
      WHERE t.kind IN ('swap', 'curve-trade') AND t.created_at >= ? AND t.created_at <= ?`)
    .get(...scope.accounts, since - OP_COPY_REACH_SEC, since, until)) as Record<string, unknown> | undefined;
  const n = (k: string) => Number(r?.[k] ?? 0) || 0;
  return { submitted: n("submitted"), failed: n("failed"), landedWithoutTxHash: n("landed_no_hash") };
}

export interface ShareInput {
  scope: LedgerScope;
  now: number;
  /** The owner's publicBook bit; null when the setting could not be read (treated as private). */
  publicBook: boolean | null;
  tradeId?: number;
  period?: SharePeriod;
}

function base(input: ShareInput, kind: "trade" | "period"): Omit<ShareSummary, "real" | "practice" | "excluded" | "trades" | "tradesTotal"> {
  const chain = chainForId(input.scope.chainId);
  const warnings: string[] = [];
  if (input.publicBook === null) warnings.push("Your public-book setting could not be read, so the summary treats the book as private and leaves dollar figures out.");
  if (chain.id !== 4663) warnings.push(`These trades are on ${chain.name}: test funds, not real money.`);
  return {
    kind,
    requestedTradeId: input.tradeId !== undefined ? String(input.tradeId) : null,
    period: kind === "period" ? (input.period ?? "day") : null,
    since: kind === "period" ? input.now - SHARE_PERIOD_SEC[input.period ?? "day"] : null,
    until: input.now,
    chainId: chain.id,
    chainName: chain.name,
    realMoney: chain.id === 4663,
    publicBook: input.publicBook === true,
    settingRead: input.publicBook !== null,
    warnings,
  };
}

/**
 * One trade, when it can be shared: confirmed on chain (landed with a
 * transaction hash) or a paper fill, which is shared as practice. Anything
 * else throws NotShareable; a trade that is not this agent's is null.
 */
async function shareOne(db: Db, input: ShareInput): Promise<ShareSummary | null> {
  const detail = await readTradeDetail(db, input.scope, input.tradeId!);
  if (!detail) return null;
  const t = detail.trade;
  if (!TRADE_KINDS.has(t.kind)) throw new NotShareable(`Operation ${t.id} is a ${t.kind} operation, not a trade, so there is nothing to share as one.`);
  const s = base(input, "trade");
  const publicBook = s.publicBook;
  if (t.status === "paper_fill") {
    s.warnings.push("This is a practice (paper) trade: simulated money, no transaction, and no real funds moved.");
    return { ...s, real: emptyBook(true), practice: tally([t], true, publicBook), excluded: null, trades: [shareTradeOf(t, publicBook)], tradesTotal: 1 };
  }
  if (!isConfirmedTrade(t)) {
    const why: Record<string, string> = {
      submitted: "it was submitted but its outcome was not confirmed on chain",
      failed: "it reverted on chain, so nothing was traded",
      refused: "it was refused before anything was sent",
      landed_without_tx_hash: "it has no transaction hash on record, so it cannot be checked on chain",
    };
    throw new NotShareable(`Trade ${t.id} cannot be shared as verified: ${why[t.status] ?? "its ledger status is not one Merrymen can verify"}.`);
  }
  return { ...s, real: tally([t], true, publicBook), practice: emptyBook(true), excluded: null, trades: [shareTradeOf(t, publicBook)], tradesTotal: 1 };
}

async function sharePeriod(db: Db, input: ShareInput): Promise<ShareSummary> {
  const s = base(input, "period");
  const since = s.since!;
  const publicBook = s.publicBook;
  if (!input.scope.accounts.length) {
    s.warnings.push("This agent has no trading account on the ledger yet, so it has no trades to summarise.");
    return { ...s, real: emptyBook(true), practice: emptyBook(true), excluded: { submitted: 0, failed: 0, landedWithoutTxHash: 0 }, trades: [], tradesTotal: 0 };
  }
  const live = await scan(db, input.scope, "confirmed", since);
  const paper = await scan(db, input.scope, "paper", since);
  // The same window the excluded counts use: nothing stamped after `until`
  // (a worker clock ahead of this one) is in a summary that says "to <until>".
  const inWindow = (t: TradeView) => t.at <= input.now;
  const confirmed = live.trades.filter((t) => inWindow(t) && isConfirmedTrade(t));
  // A row the confirmed filter let through without a well-formed hash cannot be
  // checked on chain; it is counted with the other unverifiable ones.
  const malformed = live.trades.filter((t) => inWindow(t) && TRADE_KINDS.has(t.kind) && !isConfirmedTrade(t)).length;
  const fills = paper.trades.filter((t) => inWindow(t) && TRADE_KINDS.has(t.kind) && t.status === "paper_fill");
  const counts = await unconfirmedCounts(db, input.scope, since, input.now);
  if (!live.complete) s.warnings.push(`More than ${SHARE_SCAN_MAX} confirmed operations in the period: the counts are floors and no overall return is given.`);
  if (!paper.complete) s.warnings.push(`More than ${SHARE_SCAN_MAX} practice fills in the period: the practice counts are floors and no practice return is given.`);
  const real = tally(confirmed, live.complete, publicBook);
  if (real.unmeasuredSells > 0) {
    s.warnings.push(`${real.unmeasuredSells} sell(s) are not measured (a buy behind them was booked from a quote, the fills could not be replayed, or the sale's proceeds were not recorded), so they are counted but left out of the return.`);
  }
  return {
    ...s,
    real,
    practice: tally(fills, paper.complete, publicBook),
    excluded: { submitted: counts.submitted, failed: counts.failed, landedWithoutTxHash: counts.landedWithoutTxHash + malformed },
    trades: confirmed.slice(0, SHARE_LIST_MAX).map((t) => shareTradeOf(t, publicBook)),
    tradesTotal: confirmed.length,
  };
}

/** The summary, or null when `tradeId` is not one of this agent's operations. */
export async function buildTradeShare(db: Db, input: ShareInput): Promise<ShareSummary | null> {
  return input.tradeId !== undefined ? shareOne(db, input) : sharePeriod(db, input);
}

// ── plain text, ready to paste ──────────────────────────────────────────────

const PRINTABLE_SYMBOL = /^[A-Za-z0-9$._-]{1,32}$/;

/**
 * A ticker the text may print, or null. Not an address fragment, and not one
 * that reads as a dollar figure ("$100"): a private book's text says it has no
 * dollar amounts, and a creator-chosen symbol must not make that untrue.
 */
function printableSymbol(sym: string | null): string | null {
  if (!sym || !PRINTABLE_SYMBOL.test(sym) || /^0x/i.test(sym) || /\$[\d.]|\d\$/.test(sym)) return null;
  return sym;
}

/** One line of owner- or creator-chosen text: printable, no line breaks, capped. */
function oneLine(s: string | null | undefined, max: number): string | null {
  if (typeof s !== "string") return null;
  const clean = s.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function coinOf(t: ShareTrade): string {
  const sym = printableSymbol(t.symbol);
  if (sym) return sym;
  return t.token ? `${t.token.slice(0, 6)}…${t.token.slice(-4)}` : "a token";
}

function when(sec: number): string {
  return `${new Date(sec * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const signedPct = (v: number) => `${v > 0 ? "+" : v < 0 ? "-" : ""}${Math.abs(v).toFixed(2)}%`;
const signedUsd = (v: number) => `${v > 0 ? "+" : v < 0 ? "-" : ""}${usd(Math.abs(v))}`;
const sideWord = (t: ShareTrade) => (t.side === "buy" ? "Bought" : t.side === "sell" ? "Sold" : "Swapped");

function tradeLine(t: ShareTrade, links: boolean): string {
  const parts = [when(t.at), `${sideWord(t)} ${coinOf(t)}`];
  if (t.sizeUsdg !== null) parts.push(usd(t.sizeUsdg));
  if (t.realizedReturnPct !== null) parts.push(`${signedPct(t.realizedReturnPct)}${t.realizedPnlUsdg !== null ? ` (${signedUsd(t.realizedPnlUsdg)})` : ""}`);
  if (links && t.explorerUrl) parts.push(t.explorerUrl);
  return parts.join("  ");
}

/**
 * The summary as plain text an owner can paste anywhere. Every figure in it is
 * one the structured summary carries; it adds words, never numbers.
 */
export function renderShareText(s: ShareSummary, o: { name: string | null; links: boolean }): string {
  const who = oneLine(o.name, 48) ?? "My Merrymen agent";
  const where = s.realMoney ? s.chainName : `${s.chainName} (test funds)`;
  const lines: string[] = [];
  const privateLine = "Dollar amounts are not shown: this agent's book is private.";

  if (s.kind === "trade") {
    const t = s.trades[0]!;
    if (t.book === "paper") {
      lines.push(`${who}: PRACTICE trade (paper, simulated money; no real funds moved)`);
      lines.push(`${sideWord(t)} ${coinOf(t)} on ${when(t.at)}`);
      if (t.realizedReturnPct !== null) lines.push(`Practice result: ${signedPct(t.realizedReturnPct)}`);
    } else {
      lines.push(`${who}: ${sideWord(t).toLowerCase()} ${coinOf(t)} on ${when(t.at)}`);
      if (t.sizeUsdg !== null) lines.push(`Size: ${usd(t.sizeUsdg)}`);
      if (t.realizedReturnPct !== null) lines.push(`Realised: ${signedPct(t.realizedReturnPct)}${t.realizedPnlUsdg !== null ? ` (${signedUsd(t.realizedPnlUsdg)})` : ""}`);
      else if (t.side === "sell") lines.push("Realised: not measured (the cost or proceeds of this sale are not fully evidenced).");
      lines.push(o.links && t.explorerUrl ? `Confirmed on ${where}: ${t.explorerUrl}` : `Confirmed on ${where}.`);
    }
    if (!s.publicBook) lines.push(privateLine);
    return lines.join("\n");
  }

  const r = s.real;
  lines.push(`${who} on Merrymen: ${PERIOD_WORDS[s.period!]} (to ${when(s.until)})`);
  if (r.trades === 0) {
    // A cut-short read that found no trades has not shown there were none.
    lines.push(r.complete
      ? `No trades were confirmed on ${where} in this period.`
      : `No trades among the newest ${SHARE_SCAN_MAX} confirmed operations on ${where}; the period has more operations than one summary reads.`);
  } else {
    lines.push(`Trades confirmed on ${where}: ${r.complete ? "" : "at least "}${r.trades} (${r.buys} buy${r.buys === 1 ? "" : "s"}, ${r.sells} sell${r.sells === 1 ? "" : "s"})`);
    if (r.returnPct !== null) {
      lines.push(`Realised on ${r.measuredSells} measured sell${r.measuredSells === 1 ? "" : "s"}: ${signedPct(r.returnPct)}${r.pnlUsdg !== null ? ` (${signedUsd(r.pnlUsdg)})` : ""}; ${r.wins} up, ${r.losses} down`);
    }
    if (r.unmeasuredSells > 0) lines.push(`${r.unmeasuredSells} sell${r.unmeasuredSells === 1 ? " is" : "s are"} not fully measured (cost or proceeds not evidenced) and ${r.unmeasuredSells === 1 ? "is" : "are"} not in that figure.`);
  }
  if (!s.publicBook) lines.push(privateLine);
  const p = s.practice;
  if (p.trades > 0) {
    lines.push(`Practice (paper, simulated money, not real): ${p.complete ? "" : "at least "}${p.trades} fill${p.trades === 1 ? "" : "s"}${p.returnPct !== null ? `, ${signedPct(p.returnPct)} on measured practice sells` : ""}. Not included above.`);
  }
  if (s.trades.length > 0) {
    lines.push("");
    for (const t of s.trades) lines.push(tradeLine(t, o.links));
    if (s.tradesTotal > s.trades.length) lines.push(`…and ${s.tradesTotal - s.trades.length} more confirmed trade${s.tradesTotal - s.trades.length === 1 ? "" : "s"}.`);
    lines.push("");
    lines.push(o.links ? "Every trade listed landed on chain; each link opens its transaction." : "Every trade listed landed on chain.");
  }
  return lines.join("\n");
}

// ── one line for draft_post ─────────────────────────────────────────────────

/** The coin as a post may name it: a printable ticker, never an address fragment. */
function postCoin(t: ShareTrade): string {
  return printableSymbol(t.symbol) ?? "a token";
}

/**
 * One line the group chat would take: the summary's headline with no link, no
 * address and no line break, run through the same gate draft_post applies
 * (admitOwnerLine). Null when the gate refuses it, which the caller reports;
 * the owner can still write a line of their own. Like renderShareText it adds
 * words, never numbers, and it keeps dollars out of a private book.
 */
export function renderPostLine(s: ShareSummary, o: { name: string | null }): string | null {
  const who = oneLine(o.name, 48) ?? "My Merrymen agent";
  const where = s.realMoney ? s.chainName : `${s.chainName} (test funds)`;
  let line: string;
  if (s.kind === "trade") {
    const t = s.trades[0];
    if (!t) return null;
    if (t.book === "paper") {
      line = `${who}: a practice (paper) trade, ${sideWord(t).toLowerCase()} ${postCoin(t)}, simulated money${t.realizedReturnPct !== null ? `, ${signedPct(t.realizedReturnPct)}` : ""}. No real funds moved.`;
    } else {
      const result = t.realizedReturnPct !== null
        ? `, realised ${signedPct(t.realizedReturnPct)}${t.realizedPnlUsdg !== null ? ` (${signedUsd(t.realizedPnlUsdg)})` : ""}`
        : "";
      line = `${who} ${sideWord(t).toLowerCase()} ${postCoin(t)}${t.sizeUsdg !== null ? ` for ${usd(t.sizeUsdg)}` : ""} on ${where}${result}, confirmed on chain.`;
    }
  } else {
    const r = s.real;
    const span = PERIOD_WORDS[s.period ?? "day"];
    const parts: string[] = [];
    if (r.trades === 0) {
      // "No trades" from a cut-short read is not a fact, so no line is offered.
      if (!r.complete) return null;
      parts.push(`${who}: no trades confirmed on ${where} in ${span}`);
    } else {
      parts.push(`${who}: ${r.complete ? "" : "at least "}${r.trades} trade${r.trades === 1 ? "" : "s"} confirmed on ${where} in ${span}`);
      if (r.returnPct !== null) {
        parts.push(`${signedPct(r.returnPct)}${r.pnlUsdg !== null ? ` (${signedUsd(r.pnlUsdg)})` : ""} realised on ${r.measuredSells} measured sell${r.measuredSells === 1 ? "" : "s"}`);
      }
    }
    if (s.practice.trades > 0) {
      parts.push(`plus ${s.practice.complete ? "" : "at least "}${s.practice.trades} practice (paper) fill${s.practice.trades === 1 ? "" : "s"}, not counted`);
    }
    line = `${parts.join(", ")}.`;
  }
  const verdict = admitOwnerLine(line);
  return verdict.ok ? verdict.text : null;
}
