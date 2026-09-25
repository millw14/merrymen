/**
 * Social acts for the owner: follow and unfollow public agents for research,
 * see who is followed, and build a verified, share-ready summary of the
 * owner's own trades.
 *
 * A follow belongs to the OWNER (the tenant), not to a connection or an agent
 * id a client names, which is why none of these take one: the edge is written
 * under ctx.principal.tenant and nothing else. The connection must still reach
 * one of the owner's agents, because a follow changes what that agent reads.
 *
 * Nothing here posts, and nothing here trades. share_trade_summary writes
 * nothing at all; posting goes through draft_post, which waits for the
 * owner's approval. The rules live in lib/services/social.ts.
 */
import * as z from "zod";
import { readAgentRow } from "@/lib/services/agent-status";
import { PublicDirectoryUnavailable, PublicLedgerUnreadable } from "@/lib/services/public-feed";
import { ledgerScope } from "@/lib/services/portfolio";
import { settingsReader } from "@/lib/services/settings-view";
import {
  FOLLOW_MEANING, FOLLOW_TIMING, FollowStoreUnavailable, MAX_FOLLOWS, NotShareable, SHARE_LIST_MAX,
  buildTradeShare, followAgent, followDeps, readFollowing, renderPostLine, renderShareText, unfollowAgent,
  type ShareBook, type ShareSummary, type ShareTrade,
} from "@/lib/services/social";
import type { OwnedAgent } from "../agents";
import { McpError } from "../errors";
import { defineTool, type ToolContext } from "../tool";
import { AGENT_ARG, UNTRUSTED_NOTE, isoOrNull, untrusted } from "./shared";

const TARGET_ARG = z.string().regex(/^[0-9a-hjkmnp-tv-z]{16}$/, "a public agent id (16 characters) from list_public_agents")
  .describe("Public agent id (slug) from list_public_agents or a thesis");

const iso = (sec: number) => new Date(sec * 1000).toISOString();

/** Outages become retryable errors, never an empty list or a silent no-op. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof FollowStoreUnavailable) throw new McpError("upstream_unavailable", "Your follow list could not be reached right now.", { retryAfterSec: 30 });
    if (e instanceof PublicDirectoryUnavailable) throw new McpError("upstream_unavailable", "The public agent directory is not reachable right now.", { retryAfterSec: 30 });
    if (e instanceof PublicLedgerUnreadable) throw new McpError("upstream_unavailable", "The shared ledger is not reachable right now.", { retryAfterSec: 30 });
    throw e;
  }
}

/**
 * The agents this connection may act for. A follow rewires an agent's
 * research, so a connection the owner shared no agent with may not make one —
 * the same answer resolveOwnedAgent gives.
 */
async function reachable(ctx: ToolContext): Promise<OwnedAgent[]> {
  const agents = await ctx.agents();
  if (!agents.length) {
    throw new McpError("forbidden", "No agent is shared with this connection. The owner can reconnect the app and choose which agent it may see.");
  }
  return agents;
}

/** Every agent the owner has, shared with this connection or not: none of them may be followed. */
async function ownSlugs(ctx: ToolContext): Promise<string[]> {
  return (await ctx.directory.agentsFor(ctx.principal.tenant)).map((a) => a.slug);
}

const FOLLOW_STATE = {
  following_count: z.number(),
  max: z.number().describe("The most agents an owner can follow: a prompt has a context window"),
  slots_left: z.number(),
  wired: z.array(z.string()).describe("Every agent id you follow, newest first"),
  affects_agents: z.array(z.string()).describe("Your agents (shared with this connection) whose research this changes; follows belong to you and feed every agent you run"),
  what_following_does: z.string(),
  copies_trades: z.literal(false),
  takes_effect: z.string(),
};

function stateOut(wired: string[], agents: OwnedAgent[]) {
  return {
    following_count: wired.length,
    max: MAX_FOLLOWS,
    slots_left: Math.max(0, MAX_FOLLOWS - wired.length),
    wired,
    affects_agents: agents.map((a) => a.slug),
    what_following_does: FOLLOW_MEANING,
    copies_trades: false as const,
    takes_effect: FOLLOW_TIMING,
  };
}

// ── follow_agent / unfollow_agent ───────────────────────────────────────────

const followTool = defineTool({
  name: "follow_agent",
  title: "Follow a public agent (for research)",
  description: `Follow a public Merrymen agent so its public theses become part of your agent's research. Your agent reads them as evidence and still decides for itself: following NEVER copies the target's trades and never buys or sells anything. You can follow up to ${MAX_FOLLOWS} agents, not your own. Following one you already follow changes nothing.`,
  capability: "social.write",
  input: z.object({ target: TARGET_ARG }).strict(),
  output: z.object({
    target: z.string(),
    target_name: z.string().nullable().describe("untrusted: chosen by that agent's owner"),
    following: z.literal(true),
    changed: z.boolean().describe("False when you already followed it"),
    ...FOLLOW_STATE,
    untrusted_fields: z.array(z.string()),
    untrusted_note: z.string(),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  budget: { bucket: "follow", perMinute: 10, perHour: 60 },
  async handler({ target }, ctx) {
    const agents = await reachable(ctx);
    const own = await ownSlugs(ctx);
    const out = await guarded(() => ctx.ledger((db) => followAgent(db, ctx.principal.tenant, target, own, followDeps())));
    if (!out.ok) {
      if (out.why === "self") throw new McpError("invalid_input", "That is your own agent. It already reads its own theses, so it cannot follow itself.");
      if (out.why === "unknown") throw new McpError("not_found", "No public agent has that id. Find one with list_public_agents.");
      throw new McpError("conflict", `You already follow ${out.wired.length} agents, the most an agent can read (${MAX_FOLLOWS}). Unfollow one first; list_following shows them.`, {
        details: { following_count: out.wired.length, max: MAX_FOLLOWS },
      });
    }
    const name = untrusted(out.target.name, 64);
    return {
      data: {
        target,
        target_name: name,
        following: true as const,
        changed: out.changed,
        ...stateOut(out.wired, agents),
        untrusted_fields: ["target_name"],
        untrusted_note: UNTRUSTED_NOTE,
      },
      summary: `${out.changed ? "Now following" : "Already following"} ${target} for research (${out.wired.length}/${MAX_FOLLOWS}). This never copies its trades.`,
    };
  },
});

const unfollowTool = defineTool({
  name: "unfollow_agent",
  title: "Unfollow an agent",
  description: "Stop following an agent: its public theses leave your agent's research on the next refresh. Unfollowing one you do not follow changes nothing. Following never copied trades, so unfollowing sells nothing.",
  capability: "social.write",
  input: z.object({ target: TARGET_ARG }).strict(),
  output: z.object({
    target: z.string(),
    following: z.literal(false),
    changed: z.boolean().describe("False when you were not following it"),
    ...FOLLOW_STATE,
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  budget: { bucket: "follow", perMinute: 10, perHour: 60 },
  async handler({ target }, ctx) {
    const agents = await reachable(ctx);
    const out = await guarded(() => unfollowAgent(ctx.principal.tenant, target, followDeps()));
    return {
      data: { target, following: false as const, changed: out.changed, ...stateOut(out.wired, agents) },
      summary: out.changed ? `Unfollowed ${target} (now following ${out.wired.length}/${MAX_FOLLOWS}).` : `You were not following ${target}; nothing changed.`,
    };
  },
});

// ── list_following ──────────────────────────────────────────────────────────

const listFollowing = defineTool({
  name: "list_following",
  title: "Agents you follow",
  description: `The public agents you follow (at most ${MAX_FOLLOWS}), newest first: id, name and whether each still has a public profile. Their public theses are part of your agent's research; their trades are never copied.`,
  capability: "agents.read",
  input: z.object({}).strict(),
  output: z.object({
    following: z.array(z.object({
      agent: z.string().describe("Public agent id"),
      name: z.string().nullable().describe("untrusted: chosen by that agent's owner"),
      followed_at: z.string().nullable(),
      public: z.boolean().nullable().describe("False when the id no longer resolves to a public agent (the edge stays until you unfollow); null when it could not be checked"),
    })),
    count: z.number().describe("Every edge you hold, which can exceed `following` when two follows raced past the cap"),
    max: z.number(),
    slots_left: z.number(),
    affects_agents: z.array(z.string()),
    what_following_does: z.string(),
    copies_trades: z.literal(false),
    warnings: z.array(z.string()),
    untrusted_fields: z.array(z.string()),
    untrusted_note: z.string(),
    observed_at: z.string(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  // Each call resolves every edge against the directory and the ledger.
  budget: { bucket: "follow_read", perMinute: 20, perHour: 300 },
  async handler(_args, ctx) {
    const agents = await reachable(ctx);
    const read = await guarded(() => ctx.ledger((db) => readFollowing(db, ctx.principal.tenant, followDeps())));
    const warnings: string[] = [];
    if (!read.namesRead) warnings.push("Some names could not be read right now; they are null, and so is whether those agents are still public.");
    if (read.entries.some((e) => e.public === false)) warnings.push("Some followed ids no longer resolve to a public agent. They feed nothing into research; unfollow them to free the slot.");
    if (read.total > MAX_FOLLOWS) {
      // Two follows raced past the cap (the store allows it). The orchestrator
      // feeds only the newest MAX_FOLLOWS into research; the rest are held but unread.
      warnings.push(`You hold ${read.total} follows, more than the ${MAX_FOLLOWS} your agent reads. Only the newest ${MAX_FOLLOWS} feed its research; unfollow ${read.total - MAX_FOLLOWS} to make the list match.`);
    }
    if (read.total > read.entries.length) warnings.push(`Only the newest ${read.entries.length} of ${read.total} follows are listed.`);
    const following = read.entries.map((e) => ({
      agent: e.target,
      name: untrusted(e.name, 64),
      followed_at: isoOrNull(e.followedAt),
      public: e.public,
    }));
    return {
      data: {
        following,
        count: read.total,
        max: MAX_FOLLOWS,
        slots_left: Math.max(0, MAX_FOLLOWS - read.total),
        affects_agents: agents.map((a) => a.slug),
        what_following_does: FOLLOW_MEANING,
        copies_trades: false as const,
        warnings,
        untrusted_fields: ["following[].name"],
        untrusted_note: UNTRUSTED_NOTE,
        observed_at: iso(ctx.now()),
      },
      summary: read.total ? `Following ${read.total} of ${MAX_FOLLOWS} agents for research.` : "Not following any agents.",
    };
  },
});

// ── share_trade_summary ─────────────────────────────────────────────────────

const BOOK_OUT = {
  trades: z.number(),
  buys: z.number(),
  sells: z.number(),
  measured_sells: z.number().describe("Sells whose proceeds AND cost are measurements (receipt- or paper-evidenced, cost replayed)"),
  unmeasured_sells: z.number().describe("Sells counted but left out of the return because their cost or proceeds are not fully evidenced"),
  wins: z.number().describe("Measured sells with a gain"),
  losses: z.number().describe("Measured sells with a loss"),
  realized_return_pct: z.number().nullable().describe("Realized P&L over cost, measured sells only; null when there are none or the read was incomplete"),
  realized_pnl_usdg: z.number().nullable().describe("Null when the book is private, and whenever realized_return_pct is null"),
  complete: z.boolean().describe("False when there were more operations than one summary reads; counts are then floors"),
};

const SHARE_TRADE = z.object({
  trade_id: z.string(),
  time: z.string(),
  book: z.enum(["live", "paper"]),
  money: z.enum(["real", "simulated", "testnet"]),
  side: z.enum(["buy", "sell", "swap"]).nullable(),
  token: z.string().nullable(),
  symbol: z.string().nullable().describe("untrusted: chosen by the token's creator"),
  display_name: z.string().nullable().describe("untrusted: chosen by the token's creator"),
  size_usdg: z.number().nullable().describe("Executed cash; null when the book is private or it was not recorded"),
  realized_pnl_usdg: z.number().nullable().describe("Null when the book is private or the figure is not a measurement"),
  realized_return_pct: z.number().nullable(),
  realized_measured: z.boolean(),
  verified_on_chain: z.boolean().describe("Landed on chain with a transaction hash; always false for a paper fill"),
  tx_hash: z.string().nullable(),
  explorer_url: z.string().nullable(),
});

function bookOut(b: ShareBook) {
  return {
    trades: b.trades,
    buys: b.buys,
    sells: b.sells,
    measured_sells: b.measuredSells,
    unmeasured_sells: b.unmeasuredSells,
    wins: b.wins,
    losses: b.losses,
    realized_return_pct: b.returnPct,
    realized_pnl_usdg: b.pnlUsdg,
    complete: b.complete,
  };
}

function tradeOut(t: ShareTrade, realMoney: boolean): z.infer<typeof SHARE_TRADE> {
  return {
    trade_id: t.id,
    time: iso(t.at),
    book: t.book,
    money: t.book === "paper" ? "simulated" : realMoney ? "real" : "testnet",
    side: t.side,
    token: t.token,
    symbol: untrusted(t.symbol, 32),
    display_name: untrusted(t.displayName, 64),
    size_usdg: t.sizeUsdg,
    realized_pnl_usdg: t.realizedPnlUsdg,
    realized_return_pct: t.realizedReturnPct,
    realized_measured: t.realizedMeasured,
    verified_on_chain: t.book === "live" && t.txHash !== null,
    tx_hash: t.txHash,
    explorer_url: t.explorerUrl,
  };
}

function privacyNote(s: ShareSummary): string {
  if (!s.settingRead) return "Your public-book setting could not be read, so the book is treated as private: no sizes, dollar results or prices, only percentages and counts.";
  if (s.publicBook) return "Your book is public (Merrymen Settings), so dollar sizes and realized dollars are included.";
  return "Your book is private, so dollar figures are left out: no sizes, dollar results or prices, only percentages and counts. To include them, make your book public in Merrymen Settings.";
}

const POSTING = "This tool posts nothing. To post in the Merrymen group chat, pass post_line (or a line of the owner's own) to draft_post: it is posted only after the owner approves it in Merrymen, and the group chat refuses links and addresses, so `text` with links will not pass there. Anywhere else, the owner pastes `text` themselves.";

const shareSummary = defineTool({
  name: "share_trade_summary",
  title: "Verified trade summary to share",
  description: `A share-ready summary of your agent's own CONFIRMED trades — one trade (trade_id) or a period (day or week) — with block-explorer links and a plain-text version to paste. Only trades that landed on chain with a transaction hash count; submitted and reverted ones are counted as left out; realized results appear only when both the proceeds and the cost are measured; paper fills are shown as practice and never in a real figure. If your book is private, dollar figures are left out (percentages and counts only). It posts nothing: post_line is a one-line version for draft_post, which publishes only after the owner approves.`,
  capability: "portfolio.read",
  input: z.object({
    agent: AGENT_ARG,
    trade_id: z.string().regex(/^[1-9][0-9]{0,15}$/, "a trade id from get_trades").optional().describe("One trade to summarise. Give this or period, not both."),
    period: z.enum(["day", "week"]).optional().describe("day: the last 24 hours; week: the last 7 days. The default when no trade_id is given is day."),
    include_links: z.boolean().optional().describe("Put explorer links in the text. Default: on for a public book, off for a private one, because a link shows the transaction's exact amounts to anyone who opens it. The structured trades carry their links either way."),
  }).strict(),
  output: z.object({
    agent: z.string(),
    name: z.string().nullable().describe("untrusted: the agent's name as its owner set it"),
    scope: z.object({
      kind: z.enum(["trade", "period"]),
      trade_id: z.string().nullable(),
      period: z.enum(["day", "week"]).nullable(),
      since: z.string().nullable(),
      until: z.string(),
    }),
    network: z.object({ chain_id: z.number(), name: z.string(), real_money: z.boolean() }),
    privacy: z.object({
      public_book: z.boolean(),
      setting_read: z.boolean(),
      dollar_figures: z.enum(["included", "omitted"]),
      links_in_text: z.boolean().describe("Whether the text carries explorer links (each one shows its transaction's amounts)"),
      note: z.string(),
    }),
    real: z.object({ money: z.enum(["real", "testnet"]), on_chain: z.literal(true), ...BOOK_OUT }),
    practice: z.object({
      label: z.string(),
      money: z.literal("simulated"),
      counted_in_real: z.literal(false),
      ...BOOK_OUT,
    }),
    excluded: z.object({
      submitted: z.number(),
      failed: z.number(),
      landed_without_tx_hash: z.number(),
      note: z.string(),
    }).nullable().describe("Trade attempts in the period that are not confirmed and are left out; null for a single trade"),
    trades: z.array(SHARE_TRADE).describe(`Confirmed trades, newest first (at most ${SHARE_LIST_MAX}); for trade_id, that one trade`),
    trades_total: z.number(),
    text: z.string().describe("Plain text ready to paste; contains token symbols and the agent name (untrusted)"),
    post_line: z.string().nullable().describe("One line with no links or addresses that passes the group chat's gate, for draft_post; null when no such line could be made"),
    posting: z.string(),
    warnings: z.array(z.string()),
    untrusted_fields: z.array(z.string()),
    untrusted_note: z.string(),
    source: z.string(),
    observed_at: z.string(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  budget: { bucket: "share_summary", perMinute: 10, perHour: 120 },
  timeoutMs: 20_000,
  async handler(args, ctx) {
    if (args.trade_id !== undefined && args.period !== undefined) {
      throw new McpError("invalid_input", "Give trade_id or period, not both.");
    }
    const a = await ctx.agent(args.agent);
    const now = ctx.now();
    const tradeId = args.trade_id !== undefined ? Number(args.trade_id) : undefined;
    if (tradeId !== undefined && !Number.isSafeInteger(tradeId)) throw new McpError("invalid_input", "trade_id is out of range");
    // Fail closed: a setting that cannot be read is a private book.
    let publicBook: boolean | null;
    let agentName: string | null = null;
    try {
      const s = await settingsReader().settingsFor(ctx.principal.tenant);
      publicBook = s?.publicBook === true;
      agentName = s?.agentName ?? null;
    } catch {
      publicBook = null;
    }
    const scope = ledgerScope(a.accounts, a.account, a.chainId);
    const { summary, name } = await ctx.ledger(async (db) => {
      let built: ShareSummary | null;
      try {
        built = await buildTradeShare(db, { scope, now, publicBook, tradeId, period: args.period });
      } catch (e) {
        if (e instanceof NotShareable) throw new McpError("conflict", e.message);
        throw e;
      }
      const row = a.account ? await readAgentRow(db, a.account) : null;
      return { summary: built, name: row?.name ?? agentName };
    });
    // Another agent's trade reads exactly like one that does not exist.
    if (!summary) throw new McpError("not_found", "No such trade for this agent.");

    const shownName = untrusted(name, 64);
    const warnings = [...summary.warnings];
    const anyLink = summary.trades.some((t) => t.explorerUrl !== null);
    // A private book keeps links out of the text unless the caller asks: a
    // link is the transaction, amounts and account included.
    const links = args.include_links ?? summary.publicBook;
    if (links && anyLink && !summary.publicBook) {
      warnings.push("The book is private but links were asked for: each explorer link opens the on-chain transaction, which shows its exact amounts and the agent's account address to anyone who opens it. Leave include_links unset (or false) to keep them out of the text.");
    }
    const text = renderShareText(summary, { name: shownName, links });
    const postLine = renderPostLine(summary, { name: shownName });
    if (postLine === null) {
      warnings.push("No accurate one-line version passes the group chat's rules (usually the agent's name reads as a link or an address, or the period had more operations than one summary reads), so post_line is null; the owner can write a line of their own for draft_post.");
    }
    const s = summary;
    return {
      data: {
        agent: a.slug,
        name: shownName,
        scope: {
          kind: s.kind,
          trade_id: s.requestedTradeId,
          period: s.period,
          since: isoOrNull(s.since),
          until: iso(s.until),
        },
        network: { chain_id: s.chainId, name: s.chainName, real_money: s.realMoney },
        privacy: {
          public_book: s.publicBook,
          setting_read: s.settingRead,
          dollar_figures: s.publicBook ? "included" as const : "omitted" as const,
          links_in_text: links && anyLink,
          note: privacyNote(s),
        },
        real: { money: s.realMoney ? "real" as const : "testnet" as const, on_chain: true as const, ...bookOut(s.real) },
        practice: {
          label: "Practice (paper): simulated money, no real funds moved. Never counted in a real figure.",
          money: "simulated" as const,
          counted_in_real: false as const,
          ...bookOut(s.practice),
        },
        excluded: s.excluded
          ? {
            submitted: s.excluded.submitted,
            failed: s.excluded.failed,
            landed_without_tx_hash: s.excluded.landedWithoutTxHash,
            note: "Left out because they are not confirmed: submitted (outcome not read back), failed (reverted on chain) or recorded as landed with no transaction hash to check.",
          }
          : null,
        trades: s.trades.map((t) => tradeOut(t, s.realMoney)),
        trades_total: s.tradesTotal,
        text,
        post_line: postLine,
        posting: POSTING,
        warnings,
        untrusted_fields: ["name", "trades[].symbol", "trades[].display_name", "text", "post_line"],
        untrusted_note: UNTRUSTED_NOTE,
        source: "Merrymen shared ledger (mirrored from your agent's worker); links go to the chain's block explorer",
        observed_at: iso(now),
      },
      summary: s.kind === "trade"
        ? `Trade ${s.trades[0]?.id ?? s.requestedTradeId}: ${s.trades[0]?.book === "paper" ? "practice (paper) fill" : "confirmed on chain"}; ready to share.`
        : `${s.real.trades} confirmed trade(s) and ${s.practice.trades} practice fill(s) in ${s.period === "week" ? "the last 7 days" : "the last 24 hours"}; ready to share.`,
    };
  },
});

export const SOCIAL_TOOLS = [followTool, unfollowTool, listFollowing, shareSummary];
