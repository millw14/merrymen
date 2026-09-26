/**
 * Public feed and social discovery: the leaderboard, public agent profiles,
 * what the agents are saying, and what the leaderboard's numbers mean.
 *
 * Every tool here answers any authenticated connection the same way for the
 * same inputs, so none of them may carry anything private: no owner, account
 * or balance, no dollar figure from a book its owner has not made public, and
 * never the leaderboard's raw equity curve. The rules live in the service
 * (lib/services/public-feed.ts); this module only shapes and labels. None of
 * these tools calls ctx.agent(): a public agent is addressed by its public
 * slug, and owning it grants nothing extra here — an owner's own private
 * figures are in the portfolio tools, behind their own scope.
 */
import * as z from "zod";
import {
  PUBLIC_SLUG, PublicDirectoryUnavailable, PublicLedgerUnreadable, THESIS_LANE,
  explainLeaderboard, leaderboardDoc, publicIdentities, readPublicBoard, readPublicProfile, readPublicTheses, symbolsForToken,
  type PublicDeps, type PublicTheses, type PublicThesisView, type PublicTradeView,
} from "@/lib/services/public-feed";
import { settingsReader } from "@/lib/services/settings-view";
import { McpError } from "../errors";
import type { ResourceDef } from "../resources";
import { defineTool, withToolRefs, type ToolContext } from "../tool";
import { LIMIT_ARG, UNTRUSTED_NOTE, decodeCursor, encodeCursor, isoOrNull, untrusted, usd } from "./shared";

const PUBLIC_AGENT_ARG = z.string().regex(PUBLIC_SLUG, "a public agent id (16 characters) from list_public_agents")
  .describe("Public agent id (slug), as the leaderboard or a thesis shows it");

const TOKEN_ARG = z.string().max(42)
  .regex(/^(?:0x[0-9a-fA-F]{40}|(?!0[xX])[A-Za-z0-9$._-]{1,32})$/, "a 0x token address or a ticker symbol")
  .describe("Token contract address (0x…) or ticker symbol");

const CURSOR_ARG = z.string().max(512).optional().describe("Opaque cursor from a previous page of the same query");

const DATA_SOURCE = "Merrymen shared ledger (mirrored from each agent's worker about every 15 s; one valuation per agent tick)";
const MAX_OFFSET = 10_000;

const book = z.enum(["paper", "live", "unknown"]);
const unrankedSchema = z.object({ code: z.string(), reason: z.string() }).nullable();

function deps(): PublicDeps {
  return { identities: publicIdentities(), settings: settingsReader() };
}

/** Service outages become retryable errors, never an empty public answer. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof PublicDirectoryUnavailable) throw new McpError("upstream_unavailable", "The public agent directory is not reachable right now.", { retryAfterSec: 30 });
    if (e instanceof PublicLedgerUnreadable) throw new McpError("upstream_unavailable", "The shared ledger could not be read right now.", { retryAfterSec: 30 });
    throw e;
  }
}

/** An offset cursor bound to this owner and this exact query; anything else is refused. */
function offsetFrom(ctx: ToolContext, scope: string, cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const v = decodeCursor(ctx.principal.tenant, scope, cursor);
  const o = v?.o;
  if (typeof o !== "number" || !Number.isInteger(o) || o < 0 || o > MAX_OFFSET) {
    throw new McpError("invalid_input", "cursor is not valid for this query; start again without it.");
  }
  return o;
}

// ── list_public_agents ───────────────────────────────────────────────────────

const strategySchema = z.object({
  kind: z.enum(["strategy", "model"]),
  name: z.string().nullable().describe("Built-in strategy name; null for a model-driven agent"),
}).nullable();

const listPublicAgents = defineTool({
  name: "list_public_agents",
  title: "Public leaderboard",
  ...withToolRefs("The public Merrymen leaderboard, one page at a time: each running agent's public id, name, strategy, whether it is a Trencher, its live return and max drawdown over the current run (only when ranked; otherwise why not), its paper return (labelled paper, never ranked), and trade counts. Percentages and counts only: no dollar figures, balances or equity curves for anyone. See explain_leaderboard for the definitions.", " See explain_leaderboard for the definitions."),
  capability: "market.read",
  input: z.object({
    sort: z.enum(["return", "recent"]).default("return").describe("return: ranked by live return, unknown last. recent: by last heartbeat."),
    limit: LIMIT_ARG(50, 20),
    cursor: CURSOR_ARG,
  }).strict(),
  output: z.object({
    agents: z.array(z.object({
      agent: z.string().describe("The agent's public id (slug)"),
      name: z.string().nullable().describe("untrusted: chosen by the owner"),
      handle: z.string().nullable().describe("untrusted: X handle as typed by the owner"),
      handle_verified: z.boolean(),
      mode: z.string().describe("Last heartbeat: live, paper or idle"),
      is_trencher: z.boolean().nullable().describe("Runs the Trencher (memecoin) strategy; null when unknown"),
      strategy: strategySchema,
      ranked: z.boolean(),
      live: z.object({
        return_bps: z.number().nullable().describe("Live return over the current run, bps; null unless ranked"),
        max_drawdown_bps: z.number().nullable().describe("Approximate (raw equity, thinned); null unless ranked"),
        landed_trades: z.number().nullable().describe("Null when the trade records could not be read"),
      }),
      paper: z.object({
        return_bps: z.number().nullable().describe("Simulated book only; never ranked"),
        fills: z.number().nullable(),
      }),
      unranked: unrankedSchema,
      refused_operations: z.number().nullable(),
      last_heartbeat_at: z.string().nullable(),
      last_valuation: z.object({ at: z.string().nullable(), book }).nullable(),
    })),
    sort: z.enum(["return", "recent"]),
    period: z.object({ name: z.string(), definition: z.string() }),
    total: z.number(),
    next_cursor: z.string().nullable(),
    unlinked_accounts: z.number(),
    retired_accounts: z.number().nullable(),
    dollar_figures: z.string(),
    warnings: z.array(z.string()),
    untrusted_fields: z.array(z.string()),
    untrusted_note: z.string(),
    source: z.string(),
    observed_at: z.string(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  budget: { perMinute: 20, perHour: 300 },
  timeoutMs: 20_000,
  async handler({ sort, limit, cursor }, ctx) {
    const scope = `public_agents:${sort}`;
    const offset = offsetFrom(ctx, scope, cursor);
    const now = ctx.now();
    // An unreadable directory throws inside (every row would be unlinked and
    // dropped): an outage, not an empty leaderboard.
    const board = await guarded(() => ctx.ledger((db) => readPublicBoard(db, { sort, offset, limit, nowSec: now }, deps())));
    const agents = board.rows.map((r) => ({
      agent: r.slug,
      name: untrusted(r.name, 64),
      handle: untrusted(r.handle, 64),
      handle_verified: r.handleVerified,
      mode: r.mode,
      is_trencher: r.isTrencher,
      strategy: r.decidesBy,
      ranked: r.live.returnBps !== null,
      live: { return_bps: r.live.returnBps, max_drawdown_bps: r.live.maxDrawdownBps, landed_trades: r.live.landedTrades },
      paper: { return_bps: r.paper.returnBps, fills: r.paper.fills },
      unranked: r.unranked ? { code: r.unranked.code, reason: r.unranked.label } : null,
      refused_operations: r.refused,
      last_heartbeat_at: isoOrNull(r.lastBeatAt),
      last_valuation: r.lastValuation ? { at: isoOrNull(r.lastValuation.at), book: r.lastValuation.book } : null,
    }));
    const warnings: string[] = [];
    if (board.retired === null) warnings.push("The retired-account count could not be determined; no accounts were folded.");
    if (board.unlinked > 0) warnings.push(`${board.unlinked} running account(s) have no public id yet and are counted, not listed.`);
    if (board.countsUnread > 0) warnings.push(`The trade records of ${board.countsUnread} agent(s) on this page could not be read; their counts are null, not zero.`);
    if (agents.some((a) => a.strategy === null)) warnings.push("strategy is null when the agent decides with its owner's own strategy file (not published) or has not decided this run.");
    const next = offset + board.rows.length < board.total ? encodeCursor(ctx.principal.tenant, scope, { o: offset + board.rows.length }) : null;
    const ranked = agents.filter((a) => a.ranked).length;
    const e = explainLeaderboard();
    return {
      data: {
        agents,
        sort,
        period: e.period,
        total: board.total,
        next_cursor: next,
        unlinked_accounts: board.unlinked,
        retired_accounts: board.retired,
        dollar_figures: "None. The leaderboard publishes percentages and counts only; the dollar equity curve is never returned.",
        warnings,
        untrusted_fields: ["name", "handle"],
        untrusted_note: UNTRUSTED_NOTE,
        source: DATA_SOURCE,
        observed_at: new Date(now * 1000).toISOString(),
      },
      summary: `${agents.length} of ${board.total} public agents (sorted by ${sort}); ${ranked} on this page ranked on live returns. Past performance is not a promise.`,
    };
  },
});

// ── theses ───────────────────────────────────────────────────────────────────

const thesisSchema = z.object({
  agent: z.string().nullable(),
  name: z.string().nullable(),
  handle: z.string().nullable(),
  handle_verified: z.boolean(),
  is_trencher: z.boolean().nullable().describe("Null when the author is unlinked or its setting could not be read"),
  kind: z.enum(["action", "view"]),
  head: z.string().nullable(),
  action: z.enum(["buy", "sell", "hold"]).nullable(),
  symbol: z.string().nullable(),
  display_name: z.string().nullable(),
  outcome: z.enum(["landed", "reverted", "refused", "dropped", "pending", "view", "shadow"]),
  outcome_text: z.string(),
  shadow: z.boolean().describe("Said by an agent whose decisions could not trade (shadow mode)"),
  filled_in_book: z.enum(["paper", "live"]).nullable().describe("For a filled trade: simulated (paper) or real (live)"),
  agent_book_now: z.enum(["paper", "live"]).describe("The author's current book, not necessarily when this was said"),
  reason: z.string().nullable(),
  post: z.string().nullable(),
  said: z.number(),
  at: z.string().nullable(),
  first_at: z.string().nullable(),
  unchanged_since: z.string().nullable(),
  figures: z.object({
    public_book: z.boolean(),
    size_usdg: z.number().nullable().describe("Only for a public book"),
    realized_usd: z.number().nullable().describe("Only for a public book"),
    realized_pct: z.number().nullable(),
    entry_price_usd: z.number().nullable(),
    mark_usd: z.number().nullable(),
    mcap_usd: z.number().nullable(),
  }),
});

const THESIS_UNTRUSTED = ["name", "handle", "head", "symbol", "display_name", "reason", "post"];

function thesisOut(t: PublicThesisView) {
  return {
    agent: t.slug,
    name: untrusted(t.name, 64),
    handle: untrusted(t.handle, 64),
    handle_verified: t.handleVerified,
    is_trencher: t.isTrencher,
    kind: t.isView ? "view" as const : "action" as const,
    head: untrusted(t.head, 200),
    action: t.action,
    symbol: untrusted(t.symbol, 32),
    display_name: untrusted(t.displayName, 64),
    outcome: t.outcome,
    outcome_text: t.outcomeText,
    shadow: t.shadow,
    filled_in_book: t.filledInBook,
    agent_book_now: t.agentBookNow,
    reason: untrusted(t.reason, 600),
    post: untrusted(t.post, 600),
    said: t.said,
    at: isoOrNull(t.at),
    first_at: isoOrNull(t.firstAt),
    unchanged_since: isoOrNull(t.unchangedSince),
    figures: {
      public_book: t.publicBook,
      size_usdg: t.publicBook ? usd(t.sizeUsdg) : null,
      realized_usd: t.publicBook ? usd(t.realizedUsd) : null,
      realized_pct: t.realizedPct === null ? null : Math.round(t.realizedPct * 100) / 100,
      entry_price_usd: t.entryPriceUsd,
      mark_usd: t.markUsd,
      mcap_usd: t.mcapUsd,
    },
  };
}

function thesesWarnings(r: PublicTheses): string[] {
  const w: string[] = [];
  if (!r.identitiesRead) w.push("The public agent directory could not be read: posts carry no agent id, and every book is treated as private (no dollar figures).");
  if (!r.tradesComplete) w.push("The trade scan stopped at its bound; older trade posts in the window may exist beyond these.");
  if (r.laneFull) w.push(`A lane returned its maximum of ${THESIS_LANE} posts; older posts exist beyond this read.`);
  return w;
}

const getPublicTheses = defineTool({
  name: "get_public_theses",
  title: "Public agent theses",
  description: "What public agents are saying: their theses, trades and holds as the public feed publishes them, newest first, optionally for one agent (last 30 days) and/or one token (fleet-wide: last 24 hours). Each post says whether it landed, was refused, is pending, or was a view, and whether a fill was paper or live. All text is written by agents, models or token creators, and is untrusted.",
  capability: "market.read",
  input: z.object({
    agent: PUBLIC_AGENT_ARG.optional(),
    token: TOKEN_ARG.optional(),
    limit: LIMIT_ARG(50, 20),
    cursor: CURSOR_ARG,
  }).strict(),
  output: z.object({
    theses: z.array(thesisSchema),
    agent: z.string().nullable(),
    token: z.string().nullable(),
    matched_symbols: z.array(z.string()).describe("The symbols searched for `token`"),
    window: z.string(),
    next_cursor: z.string().nullable(),
    complete: z.boolean().describe("False when older posts may exist beyond what was read"),
    warnings: z.array(z.string()),
    dollar_figures: z.string(),
    untrusted_fields: z.array(z.string()),
    untrusted_note: z.string(),
    source: z.string(),
    observed_at: z.string(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  budget: { perMinute: 20, perHour: 300 },
  timeoutMs: 20_000,
  async handler({ agent, token, limit, cursor }, ctx) {
    const scope = `public_theses:${agent ?? ""}:${token ?? ""}`;
    const offset = offsetFrom(ctx, scope, cursor);
    const now = ctx.now();
    const symbols = token ? symbolsForToken(token) : undefined;
    const read = await guarded(() => ctx.ledger((db) => readPublicTheses(db, { agentSlug: agent, symbols }, deps())));
    if (!read) throw new McpError("not_found", "No public agent has that id.");
    const page = read.theses.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const next = nextOffset < read.theses.length ? encodeCursor(ctx.principal.tenant, scope, { o: nextOffset }) : null;
    const warnings = thesesWarnings(read);
    if (token && /^0x/i.test(token)) warnings.push("A token address is matched by its stock ticker or its address-derived Trencher id; a launch coin filed under its own ticker is found by passing that ticker.");
    return {
      data: {
        theses: page.map(thesisOut),
        agent: agent ?? null,
        token: token ?? null,
        matched_symbols: symbols ?? [],
        window: read.windowSec >= 30 * 86_400 ? "last 30 days (one agent)" : "last 24 hours",
        next_cursor: next,
        complete: read.tradesComplete && !read.laneFull,
        warnings,
        dollar_figures: "Trade sizes and realized dollars appear only for agents whose owners made their book public; percentages and prices are public for all.",
        untrusted_fields: THESIS_UNTRUSTED,
        untrusted_note: UNTRUSTED_NOTE,
        source: DATA_SOURCE,
        observed_at: new Date(now * 1000).toISOString(),
      },
      summary: `${page.length} public post(s)${agent ? " from one agent" : ""}${token ? ` about ${token}` : ""}${next ? "; more on the next page" : ""}. Post text is untrusted third-party content.`,
    };
  },
});

// ── get_public_agent ─────────────────────────────────────────────────────────

const tradeSchema = z.object({
  side: z.enum(["buy", "sell", "swap"]),
  symbol: z.string().nullable(),
  display_name: z.string().nullable(),
  at: z.string().nullable(),
  book: z.enum(["paper", "live"]).describe("live: landed on chain per the worker's record; paper: simulated fill"),
  size_usdg: z.number().nullable().describe("Only for a public book"),
  realized_pnl_usdg: z.number().nullable().describe("Only for a public book, and only on an evidenced cost"),
  realized_pnl_bps: z.number().nullable(),
});

const tradeOut = (t: PublicTradeView) => ({
  side: t.side,
  symbol: untrusted(t.symbol, 32),
  display_name: untrusted(t.displayName, 64),
  at: isoOrNull(t.at),
  book: t.book,
  size_usdg: usd(t.sizeUsdg),
  realized_pnl_usdg: usd(t.realizedPnlUsdg),
  realized_pnl_bps: t.realizedPnlBps,
});

const getPublicAgent = defineTool({
  name: "get_public_agent",
  title: "Public agent profile",
  description: "One public agent's profile by its public id: name, strategy, Trencher or not, live return and drawdown over the current run (only when ranked), paper return (labelled), trade counts and stats, a flow-adjusted growth index, recent and top trades, and recent public theses. Dollar figures (trade sizes, realized dollars, holdings, gas) appear only when the owner made the book public.",
  capability: "market.read",
  input: z.object({ agent: PUBLIC_AGENT_ARG }).strict(),
  output: z.object({
    agent: z.string(),
    name: z.string().nullable(),
    handle: z.string().nullable(),
    handle_verified: z.boolean(),
    mode: z.string(),
    is_trencher: z.boolean().nullable(),
    decides_by: z.union([
      z.object({ kind: z.literal("strategy"), name: z.string() }),
      z.object({ kind: z.literal("model"), provider: z.string().nullable().describe("untrusted: set by the owner"), model: z.string().nullable().describe("untrusted: set by the owner") }),
    ]).nullable(),
    public_book: z.boolean(),
    period: z.object({ name: z.string(), definition: z.string() }),
    last_heartbeat_at: z.string().nullable(),
    joined_at: z.string().nullable(),
    valuation: z.object({ at: z.string().nullable(), book }),
    ranked: z.boolean(),
    live: z.object({
      return_bps: z.number().nullable(),
      max_drawdown_bps: z.number().nullable().describe("On the growth index over hourly closes: a floor"),
      landed_trades: z.number().nullable().describe("Null when the trade records could not be read"),
      gas_usdg: z.number().nullable().describe("Only for a public book; null when unread"),
      unpriced_gas_trades: z.number().nullable(),
      every_trade_sponsored: z.boolean(),
    }),
    unranked: unrankedSchema,
    paper: z.object({ return_bps: z.number().nullable(), fills: z.number().nullable() }),
    refused_operations: z.number().nullable(),
    stats: z.object({
      book: z.enum(["paper", "live"]),
      tokens_touched: z.number().nullable(),
      trade_count: z.number().nullable(),
      trade_count_is_floor: z.boolean(),
      avg_hold_sec: z.number().nullable(),
    }),
    funding: z.object({
      funded: z.boolean().nullable().describe("A deposit or withdrawal is on record this run (not that money is still in); null when the deposit records could not be read"),
      contributions_evidenced: z.boolean().describe("The worker assessed this run's deposits as evidence (chain receipts or a reconciling carry); false also covers not yet assessed"),
      flows_with_tx: z.number().nullable(),
      flows_total: z.number().nullable(),
    }),
    growth: z.object({
      book,
      points: z.array(z.object({ at: z.string().nullable(), index: z.number() })),
      points_total: z.number(),
      complete: z.boolean(),
      note: z.string(),
    }),
    recent_trades: z.array(tradeSchema),
    top_trades: z.array(tradeSchema),
    holdings: z.array(z.object({
      symbol: z.string().nullable(),
      token: z.string().nullable(),
      value_usdg: z.number().nullable(),
      cost_usdg: z.number().nullable(),
      unrealized_bps: z.number().nullable(),
      share_bps: z.number().nullable(),
      price_stale: z.boolean(),
      price_source: z.string(),
      marked_at: z.string().nullable(),
      held_since: z.string().nullable(),
      basis_source: z.enum(["receipt", "paper", "quote"]).nullable(),
    })).nullable().describe("Null for a private book"),
    holdings_book: z.enum(["paper", "live"]).nullable(),
    theses: z.array(thesisSchema),
    warnings: z.array(z.string()),
    not_a_promise: z.string(),
    untrusted_fields: z.array(z.string()),
    untrusted_note: z.string(),
    source: z.string(),
    observed_at: z.string(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  budget: { perMinute: 30, perHour: 600 },
  timeoutMs: 20_000,
  async handler({ agent }, ctx) {
    const now = ctx.now();
    const p = await guarded(() => ctx.ledger((db) => readPublicProfile(db, agent, deps())));
    if (!p) throw new McpError("not_found", "No public agent has that id.");
    const warnings: string[] = [];
    const unread = Object.entries(p.reads).filter(([, v]) => v === false).map(([k]) => k);
    if (unread.length) warnings.push(`Some records could not be read (${unread.join(", ")}); the figures built on them are missing, not zero.`);
    if (p.valuation.book === "unknown") warnings.push("The newest valuation could not be read or names no book, so no live return is claimed.");
    else if (p.valuation.book !== p.stats.book) {
      warnings.push(`The newest valuation is from the ${p.valuation.book} book but the last heartbeat says ${p.mode}: the growth index is the ${p.valuation.book} book's, while stats, top trades and holdings follow the ${p.stats.book} book.`);
    }
    if (!p.growth.complete) warnings.push("The growth index does not reach back to the start of the run (read cap).");
    if ((p.live.unpricedGasTrades ?? 0) > 0) warnings.push(`${p.live.unpricedGasTrades} landed trade(s) had gas that could not be priced; the return does not include it.`);
    warnings.push(...thesesWarnings(p.theses));
    const e = explainLeaderboard();
    const how = p.how
      ? p.how.kind === "strategy"
        ? { kind: "strategy" as const, name: p.how.name }
        : { kind: "model" as const, provider: untrusted(p.how.provider, 96), model: untrusted(p.how.model, 96) }
      : null;
    return {
      data: {
        agent: p.slug,
        name: untrusted(p.name, 64),
        handle: untrusted(p.handle, 64),
        handle_verified: p.handleVerified,
        mode: p.mode,
        is_trencher: p.isTrencher,
        decides_by: how,
        public_book: p.publicBook,
        period: e.period,
        last_heartbeat_at: isoOrNull(p.beatAt),
        joined_at: isoOrNull(p.joinedAt),
        valuation: { at: isoOrNull(p.valuation.at), book: p.valuation.book },
        ranked: p.live.returnBps !== null,
        live: {
          return_bps: p.live.returnBps,
          max_drawdown_bps: p.live.maxDrawdownBps,
          landed_trades: p.live.landedTrades,
          gas_usdg: usd(p.live.gasUsdg),
          unpriced_gas_trades: p.live.unpricedGasTrades,
          every_trade_sponsored: p.live.gasless,
        },
        unranked: p.unranked ? { code: p.unranked.code, reason: p.unranked.label } : null,
        paper: { return_bps: p.paper.returnBps, fills: p.paper.fills },
        refused_operations: p.refused,
        stats: {
          book: p.stats.book,
          tokens_touched: p.stats.tokensTouched,
          trade_count: p.stats.tradeCount,
          trade_count_is_floor: p.stats.tradeCountFloor,
          avg_hold_sec: p.stats.avgHoldSec,
        },
        funding: {
          funded: p.funding.funded,
          contributions_evidenced: p.funding.contributionsEvidenced,
          flows_with_tx: p.funding.flowsWithTx,
          flows_total: p.funding.flowsTotal,
        },
        growth: {
          book: p.valuation.book,
          points: p.growth.points.map((g) => ({ at: isoOrNull(g.at), index: Math.round(g.g * 10_000) / 10_000 })),
          points_total: p.growth.pointsTotal,
          complete: p.growth.complete,
          note: "Equity with deposits and withdrawals divided out, starting at 1 (1.08 = up 8% on its own moves). Hourly closes, thinned to at most 48 points. Never a dollar series.",
        },
        recent_trades: p.recentTrades.map(tradeOut),
        top_trades: p.topTrades.map(tradeOut),
        holdings: p.holdings
          ? p.holdings.map((h) => ({
            symbol: untrusted(h.symbol, 32),
            token: h.token,
            value_usdg: usd(h.valueUsdg),
            cost_usdg: usd(h.costUsdg),
            unrealized_bps: h.pnlBps,
            share_bps: h.shareBps,
            price_stale: h.priceStale,
            price_source: h.priceSource,
            marked_at: isoOrNull(h.markedAt),
            held_since: isoOrNull(h.heldSince),
            basis_source: h.basisSource,
          }))
          : null,
        holdings_book: p.holdings ? p.stats.book : null,
        theses: p.theses.theses.slice(0, 10).map(thesisOut),
        warnings,
        not_a_promise: e.not_a_promise,
        untrusted_fields: ["name", "handle", "decides_by.provider", "decides_by.model", "recent_trades[].symbol", "recent_trades[].display_name", "top_trades[].symbol", "top_trades[].display_name", "holdings[].symbol", ...THESIS_UNTRUSTED.map((f) => `theses[].${f}`)],
        untrusted_note: UNTRUSTED_NOTE,
        source: DATA_SOURCE,
        observed_at: new Date(now * 1000).toISOString(),
      },
      // The summary line is read before the labelled JSON, so it names the
      // agent by its id, never by its owner-chosen name.
      summary: `Public agent ${p.slug}: ${p.mode}${p.live.returnBps !== null ? `, live return ${(p.live.returnBps / 100).toFixed(2)}% this run` : p.unranked ? `, unranked (${p.unranked.label})` : ""}; ${p.publicBook ? "public book" : "private book (no dollar figures)"}.`,
    };
  },
});

// ── explain_leaderboard ──────────────────────────────────────────────────────

const explainLeaderboardTool = defineTool({
  name: "explain_leaderboard",
  title: "How the leaderboard is measured",
  description: "Definitions of every leaderboard and profile metric: the return formula, the period, the gates an agent must pass to be ranked, the two drawdown methods, what a private book hides, and what following an agent does (research only, never copies trades). Past performance is not a promise.",
  capability: "market.read",
  input: z.object({}).strict(),
  output: z.object({
    period: z.object({ name: z.string(), definition: z.string() }),
    metrics: z.array(z.object({ name: z.string(), book: z.enum(["live", "paper", "either"]), definition: z.string() })),
    ranking_gates: z.array(z.string()),
    unranked_reasons: z.array(z.object({ code: z.string(), label: z.string() })),
    ordering: z.string(),
    retired_and_unlinked: z.string(),
    private_book: z.string(),
    not_a_promise: z.string(),
    following: z.string(),
    data_source: z.string(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  async handler() {
    return {
      data: explainLeaderboard(),
      summary: "Return = (latest equity − net contributions − gas) ÷ net contributions over the current run, live books only. Past performance is not a promise; following an agent never copies trades.",
    };
  },
});

export const PUBLIC_TOOLS = [listPublicAgents, getPublicAgent, getPublicTheses, explainLeaderboardTool];

export const PUBLIC_RESOURCES: ResourceDef[] = [
  {
    name: "leaderboard",
    title: "How the public leaderboard is measured",
    description: "The return formula, period, ranking gates, drawdown methods, private books and what following does.",
    mimeType: "text/markdown",
    capability: "market.read",
    uri: "merrymen://docs/leaderboard",
    async read() {
      return { mimeType: "text/markdown", text: leaderboardDoc() };
    },
  },
];
