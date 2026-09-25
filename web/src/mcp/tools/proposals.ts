/**
 * Preparing actions for the owner to approve: trade quotes and proposals,
 * setting changes, new-agent drafts and posts.
 *
 * Nothing here executes anything. Each proposal tool validates the request
 * against the agent's current permission and settings, stores an exact,
 * hashed binding, and returns an approval_url: a Merrymen page where the owner,
 * signed in with their own session, sees exactly what will happen and
 * approves or declines. The state machine and the approval rules live in
 * web/src/lib/services/proposals.ts.
 */
import * as z from "zod";
import { STOCK_TOKENS, RISK_PROFILES, sellableAssets, normalizeAgentName, AGENT_NAME_RE } from "@merrymen/core";
import { settingsReader, type SettingsView } from "@/lib/services/settings-view";
import { quoteTrade, type TradeQuote } from "@/lib/services/trade-quote";
import {
  PROPOSAL_TTL_SEC, TERMINAL, cancelProposal, createProposal, expireIfDue, followTrade, listProposalRows, proposalRow,
  ProposalError, type Binding, type ProposalKind, type ProposalRow, type TradeBinding,
} from "@/lib/services/proposals";
import { SETTING_SPECS, specFor, validStoredSetting, formatSettingValue, stockSymbols } from "../../../../worker/src/telegram/setting-spec";
import { admitOwnerLine } from "../../../../worker/src/groupchat/policy";
import { readAgentRow } from "@/lib/services/agent-status";
import { mcpConfig } from "../config";
import { McpError } from "../errors";
import { hasCapability } from "../policy";
import type { Capability } from "../scopes";
import { defineTool, type ToolContext } from "../tool";
import type { OwnedAgent } from "../agents";
import { ADDRESS_ARG, AGENT_ARG, LIMIT_ARG, isoOrNull, untrusted } from "./shared";

/** Mirrors worker/src/strategies/registry.ts BUILTIN_STRATEGIES (a test holds them equal). */
export const KNOWN_STRATEGIES = ["steady-basket", "weekend-gap", "llm-strategist", "trencher", "even-keel", "dip-hunter"] as const;

const KIND_CAPABILITY: Record<ProposalKind, Capability> = {
  trade: "trade.propose",
  settings: "drafts.write",
  agent_draft: "drafts.write",
  post: "social.write",
};

const IDEMPOTENCY = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, "8-128 letters, digits, _ or -")
  .describe("A key you choose for this request. Resending the same key returns the same proposal instead of creating another.");

function approvalUrl(id: string): string {
  return `${mcpConfig().issuer}/connect/approve/${id}`;
}

function translate(e: unknown): never {
  if (e instanceof ProposalError) {
    const code = e.code === "refused" ? "conflict" : e.code;
    throw new McpError(code, e.message);
  }
  throw e;
}

// ── tokens the owner-order path can address ─────────────────────────────────

/**
 * The owner-order path names a token by SYMBOL (the worker resolves it
 * against the stock list and the owner's own added tokens, exactly and
 * case-sensitively, first match wins). So a proposal is only accepted for a
 * token whose symbol maps to exactly one address among those — otherwise the
 * order could fill a different token than the one the owner approved.
 */
export function addressableSymbol(token: string, settings: SettingsView | null): { symbol: string } | { why: string } {
  const t = token.toLowerCase();
  const configured = [
    ...STOCK_TOKENS.map((s) => ({ symbol: s.symbol, address: s.address.toLowerCase() })),
    ...(settings?.customTokens ?? []).map((c) => ({ symbol: c.symbol, address: c.address.toLowerCase() })),
  ];
  const mine = configured.filter((c) => c.address === t);
  if (!mine.length) {
    return { why: "This token is not one of the agent's tokens (the stock tokens plus tokens the owner added in Settings). The owner can add it by address in Merrymen Settings first; the agent may still trade launchpad coins on its own." };
  }
  const symbol = mine[0]!.symbol;
  if (!/^[A-Z0-9]{1,12}$/.test(symbol)) {
    return { why: `Its symbol "${symbol.slice(0, 16)}" cannot be addressed by an owner order (orders take upper-case tickers). The agent can still trade it on its own.` };
  }
  const clash = configured.filter((c) => c.symbol === symbol && c.address !== t);
  if (clash.length) {
    return { why: `Another of the agent's tokens also uses the symbol ${symbol}, so an order could not tell them apart. Remove the duplicate in Settings first.` };
  }
  return { symbol };
}

async function holdingOf(ctx: ToolContext, agent: OwnedAgent, token: string): Promise<{ rawBalance: bigint; valueUsdg: number | null } | null> {
  if (!agent.account) return null;
  const row = await ctx.ledger((db) => db.prepare(`SELECT raw_balance, value_usdg, price_stale FROM positions WHERE lower(agent_id) = ? AND lower(token) = ? LIMIT 1`)
    .get(agent.account!.toLowerCase(), token.toLowerCase())) as { raw_balance: string | null; value_usdg: number | null; price_stale: number | null } | undefined;
  if (!row?.raw_balance || !/^\d+$/.test(row.raw_balance)) return null;
  return { rawBalance: BigInt(row.raw_balance), valueUsdg: typeof row.value_usdg === "number" && Number.isFinite(row.value_usdg) ? row.value_usdg : null };
}

const QUOTE_OUT = z.object({
  quoted: z.boolean(),
  why_not: z.string().nullable(),
  side: z.string(),
  token: z.string(),
  token_decimals: z.number().nullable(),
  amount_in: z.object({ token: z.string(), raw: z.string(), human: z.number().nullable() }),
  expected_out: z.object({ token: z.string(), raw: z.string(), human: z.number().nullable() }).nullable(),
  min_out: z.object({ raw: z.string(), human: z.number().nullable(), slippage_bps: z.number() }).nullable(),
  implied_price_usd: z.number().nullable(),
  price_impact_bps: z.number().nullable(),
  impact_verdict: z.object({ ok: z.boolean(), rule: z.string().nullable(), detail: z.string().nullable(), cap_bps: z.number() }),
  route: z.object({ venue: z.string(), fee_tier_bps: z.number().nullable(), hops: z.array(z.string()) }).nullable(),
  routes_considered: z.object({ direct_v3: z.boolean(), via_weth: z.boolean(), v4: z.boolean(), hooked_v4_pools: z.boolean(), launchpad_curve: z.boolean() }),
  gas: z.object({ units_estimate: z.string().nullable(), swap_leg_units: z.string().nullable(), expected_usdg: z.number().nullable(), note: z.string() }),
  merrymen_trade_fee: z.object({ bps: z.number(), usdg: z.number(), note: z.string() }),
  block_number: z.string().nullable(),
  quoted_at: z.string(),
  source: z.string(),
  caveats: z.array(z.string()),
});

const TRADE_IN = z.object({
  agent: AGENT_ARG,
  side: z.enum(["buy", "sell"]),
  token: ADDRESS_ARG.describe("Token address (not a symbol: symbols can be duplicated)"),
  amount_usdg: z.number().positive().max(1_000_000).describe("Buy: USDG to spend. Sell: USDG value of the holding to sell."),
});

async function quoteFor(ctx: ToolContext, agent: OwnedAgent, settings: SettingsView | null, args: { side: "buy" | "sell"; token: string; amount_usdg: number }): Promise<TradeQuote> {
  const holding = args.side === "sell" ? await holdingOf(ctx, agent, args.token) : null;
  return quoteTrade({
    side: args.side,
    token: args.token.toLowerCase() as `0x${string}`,
    amountUsdg: args.amount_usdg,
    slippageBps: settings?.slippageBps ?? null,
    maxImpactBps: settings?.maxImpactBps ?? null,
    grantFeatures: agent.features,
    holding,
  });
}

const quoteTradeTool = defineTool({
  name: "quote_trade",
  title: "Quote a trade",
  description: "Get a current quote for buying or selling a token for one of your agents: expected amount, minimum received at the agent's slippage setting, price impact vs the agent's impact cap, route, gas and fees. Uses the same routes the agent's permission can reach. A quote is indicative and places nothing.",
  capability: "trade.propose",
  input: TRADE_IN.strict(),
  output: QUOTE_OUT,
  annotations: { readOnlyHint: true, openWorldHint: true },
  budget: { bucket: "quote", perMinute: 10, perHour: 120 },
  timeoutMs: 20_000,
  async handler(args, ctx) {
    const agent = await ctx.agent(args.agent);
    const settings = await settingsReader().settingsFor(ctx.principal.tenant);
    const q = await quoteFor(ctx, agent, settings, args);
    return {
      data: q,
      summary: q.quoted
        ? `${args.side} ${args.amount_usdg} USDG of ${args.token}: expect ${q.expected_out?.human ?? "?"}, at least ${q.min_out?.human ?? "?"}; impact ${q.price_impact_bps ?? "unknown"} bps.`
        : `No quote: ${q.why_not}`,
    };
  },
});

const PROPOSAL_OUT = z.object({
  proposal_id: z.string(),
  kind: z.string(),
  status: z.string(),
  approval_url: z.string(),
  expires_at: z.string(),
  binding_hash: z.string(),
  summary: z.record(z.string(), z.unknown()),
  next_steps: z.string(),
  created: z.boolean(),
});

function proposalOut(row: ProposalRow, created: boolean, next: string) {
  return {
    proposal_id: row.id,
    kind: row.kind,
    status: row.status,
    approval_url: approvalUrl(row.id),
    expires_at: new Date(row.expires_at * 1000).toISOString(),
    binding_hash: row.binding_hash,
    summary: JSON.parse(row.summary_json) as Record<string, unknown>,
    next_steps: next,
    created,
  };
}

const proposeTrade = defineTool({
  name: "propose_trade",
  title: "Propose a trade for approval",
  description: "Prepare an exact buy or sell for the owner to approve in Merrymen. Nothing is traded until the owner opens approval_url, signs in and approves; the agent's own limits, policy and on-chain permission still apply after that. Proposals expire after 15 minutes.",
  capability: "trade.propose",
  input: TRADE_IN.extend({
    idempotency_key: IDEMPOTENCY,
    note: z.string().max(280).optional().describe("Why you are proposing it; shown to the owner as your note"),
  }).strict(),
  output: PROPOSAL_OUT.extend({ quote: QUOTE_OUT.nullable() }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  budget: { bucket: "propose", perMinute: 5, perHour: 40 },
  timeoutMs: 25_000,
  async handler(args, ctx) {
    const agent = await ctx.agent(args.agent);
    const now = ctx.now();
    if (!agent.account || !agent.orderAgentId) throw new McpError("conflict", "This agent has no signed trading permission yet, so it cannot trade.");
    if (agent.expiresAt !== null && now >= agent.expiresAt) throw new McpError("conflict", "The agent's trading permission has expired. The owner must re-sign it in Merrymen before any trade.");
    const settings = await settingsReader().settingsFor(ctx.principal.tenant);
    const addressable = addressableSymbol(args.token, settings);
    if ("why" in addressable) throw new McpError("unsupported", addressable.why);
    const sellable = sellableAssets({ grantFeatures: agent.features, grantTokens: agent.grantTokens });
    if (!sellable.has(args.token.toLowerCase())) {
      throw new McpError("conflict", "The agent's signed permission does not cover this token, so it could buy but never sell it. The owner can re-sign the permission to include it.");
    }
    const perTrade = agent.caps?.perTradeUsdg ?? null;
    if (perTrade !== null && args.amount_usdg > perTrade) throw new McpError("invalid_input", `That is over the signed per-trade limit of ${perTrade} USDG.`);
    const ceiling = settings?.telegram.maxActionUsdg ?? null;
    if (ceiling !== null && ceiling > 0 && args.amount_usdg > ceiling) {
      throw new McpError("invalid_input", `That is over the owner's ${ceiling} USDG limit for an owner order (Settings → max per chat trade).`);
    }
    const row = await ctx.ledger((db) => readAgentRow(db, agent.account!));
    const book = row?.mode === "live" ? "live" : row?.mode === "paper" ? "paper" : "unknown";
    const quote = await quoteFor(ctx, agent, settings, args);
    if (args.side === "buy" && (!quote.quoted || !quote.impact_verdict.ok)) {
      throw new McpError("conflict", quote.quoted ? `The agent would refuse this buy: ${quote.impact_verdict.detail ?? "price impact is over its cap"}` : `No executable quote: ${quote.why_not}`);
    }
    const binding: TradeBinding = {
      v: 1,
      kind: "trade",
      tenant: ctx.principal.tenant,
      agent_slug: agent.slug,
      account: agent.account,
      order_agent_id: agent.orderAgentId,
      chain_id: agent.chainId ?? 4663,
      side: args.side,
      token: args.token.toLowerCase(),
      symbol: addressable.symbol,
      amount_usdg: Math.round(args.amount_usdg * 100) / 100,
      slippage_bps: quote.min_out?.slippage_bps ?? settings?.slippageBps ?? 100,
      book,
      quote: quote.quoted && quote.expected_out && quote.min_out
        ? { expected_out_raw: quote.expected_out.raw, min_out_raw: quote.min_out.raw, price_impact_bps: quote.price_impact_bps, block: quote.block_number }
        : null,
      limits: { per_trade_usdg: perTrade, chat_ceiling_usdg: ceiling, daily_usdg: agent.caps?.dailyUsdg ?? null, permission_expires_at: agent.expiresAt },
      expires_at: now + PROPOSAL_TTL_SEC.trade,
    };
    const summary = {
      action: `${args.side === "buy" ? "Buy" : "Sell"} ${binding.amount_usdg} USDG of ${addressable.symbol}`,
      token: binding.token,
      book,
      book_note: book === "paper" ? "The agent is in practice mode: approving books a simulated trade, no money moves." : book === "live" ? "The agent trades real funds: approving queues a real order." : "The agent's current book is unknown.",
      expected_out: quote.expected_out?.human ?? null,
      min_out: quote.min_out?.human ?? null,
      price_impact_bps: quote.price_impact_bps,
      assistant_note: untrusted(args.note, 280),
      requested_by: ctx.principal.clientName ?? "an AI assistant",
    };
    const d = await ctx.mcp();
    const { row: created, created: isNew } = await createProposal(d.db, {
      tenant: ctx.principal.tenant, connectionId: ctx.principal.connectionId, clientName: ctx.principal.clientName,
      binding, summary, idempotencyKey: args.idempotency_key, agentSlug: agent.slug, agentAccount: agent.orderAgentId, now,
    }).catch(translate);
    return {
      data: { ...proposalOut(created, isNew, "Send the owner approval_url. Poll get_proposal for the status; a trade is only 'confirmed' after the on-chain receipt and the ledger agree."), quote },
      summary: `Proposal ${created.id} is waiting for the owner's approval at ${approvalUrl(created.id)} (expires ${new Date(created.expires_at * 1000).toISOString()}).`,
    };
  },
});

const proposeSettings = defineTool({
  name: "propose_settings_change",
  title: "Propose setting changes for approval",
  description: `Prepare changes to the agent's trading settings for the owner to approve in Merrymen, with a before/after comparison. Allowed keys: ${SETTING_SPECS.map((s) => s.key).join(", ")}. Switches that start spending real money, safety floors, custom tokens, Telegram controls and the limits sealed in the signed permission cannot be proposed here.`,
  capability: "drafts.write",
  input: z.object({
    agent: AGENT_ARG,
    changes: z.record(z.string().max(40), z.union([z.number(), z.boolean(), z.string().max(64), z.array(z.string().max(16)).max(10)]))
      .refine((c) => Object.keys(c).length >= 1 && Object.keys(c).length <= 10, "1-10 changes"),
    idempotency_key: IDEMPOTENCY,
    note: z.string().max(280).optional(),
  }).strict(),
  output: PROPOSAL_OUT.extend({
    diff: z.array(z.object({ key: z.string(), label: z.string(), current: z.string(), proposed: z.string(), help: z.string() })),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  budget: { bucket: "propose", perMinute: 5, perHour: 40 },
  async handler(args, ctx) {
    const agent = await ctx.agent(args.agent);
    const now = ctx.now();
    const reader = settingsReader();
    const settings = await reader.settingsFor(ctx.principal.tenant);
    const current = (await reader.specValuesFor?.(ctx.principal.tenant)) ?? {};
    const basketAllowed = new Set([...stockSymbols(), ...(settings?.customTokens ?? []).map((c) => c.symbol.toUpperCase())]);
    const changes: Record<string, unknown> = {};
    const diff: Array<{ key: string; label: string; current: string; proposed: string; help: string }> = [];
    for (const [key, value] of Object.entries(args.changes)) {
      const spec = specFor(key);
      if (!spec) throw new McpError("invalid_input", `"${key.slice(0, 40)}" cannot be changed from here. Allowed: ${SETTING_SPECS.map((s) => s.key).join(", ")}.`);
      if (!validStoredSetting(key, value)) {
        const bounds = spec.min !== undefined || spec.max !== undefined ? ` (${spec.min ?? "…"}–${spec.max ?? "…"} in stored units${spec.kind === "pct" ? ", basis points" : spec.kind === "hoursAsSec" ? ", seconds" : ""})` : spec.values ? ` (one of ${spec.values.join(", ")})` : "";
        throw new McpError("invalid_input", `${key}: not a valid value for ${spec.label}${bounds}.`);
      }
      if (spec.kind === "symbols" && (value as string[]).some((s) => !basketAllowed.has(s.toUpperCase()))) {
        throw new McpError("invalid_input", "basketSymbols may only contain stock tokens or tokens the owner added in Settings.");
      }
      if (spec.kind === "strategy" && !(KNOWN_STRATEGIES as readonly string[]).includes(value as string)) {
        throw new McpError("invalid_input", `strategy must be one of ${KNOWN_STRATEGIES.join(", ")}.`);
      }
      changes[key] = value;
      diff.push({ key, label: spec.label, current: formatSettingValue(spec, current[key]), proposed: formatSettingValue(spec, value), help: spec.help });
    }
    const before: Record<string, unknown> = {};
    for (const k of Object.keys(changes)) before[k] = current[k] ?? null;
    const binding: Binding = { v: 1, kind: "settings", tenant: ctx.principal.tenant, agent_slug: agent.slug, changes, before, expires_at: now + PROPOSAL_TTL_SEC.settings };
    const summary = { action: `Change ${diff.length} setting${diff.length === 1 ? "" : "s"}`, diff, assistant_note: untrusted(args.note, 280), requested_by: ctx.principal.clientName ?? "an AI assistant" };
    const d = await ctx.mcp();
    const { row, created } = await createProposal(d.db, {
      tenant: ctx.principal.tenant, connectionId: ctx.principal.connectionId, clientName: ctx.principal.clientName,
      binding, summary, idempotencyKey: args.idempotency_key, agentSlug: agent.slug, agentAccount: agent.account, now,
    }).catch(translate);
    return {
      data: { ...proposalOut(row, created, "Send the owner approval_url. The settings change only when they approve it."), diff },
      summary: diff.map((x) => `${x.label}: ${x.current} → ${x.proposed}`).join("; "),
    };
  },
});

const createDraft = defineTool({
  name: "create_agent_draft",
  title: "Draft a new agent setup",
  description: "Draft a name, strategy, basket and risk level for a new (or re-configured) agent. The owner reviews it in Merrymen; approving applies the name, strategy and basket, then they choose limits and sign the trading permission themselves. A draft never creates trading authority.",
  capability: "drafts.write",
  input: z.object({
    name: z.string().max(24).optional(),
    strategy: z.enum(KNOWN_STRATEGIES).optional(),
    basket: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._$-]{0,15}$/)).min(1).max(10).optional(),
    asset_mode: z.enum(["all", "stocks", "crypto"]).optional(),
    risk_level: z.enum(["careful", "balanced", "bold"]).optional(),
    idempotency_key: IDEMPOTENCY,
  }).strict(),
  output: PROPOSAL_OUT.extend({ risk_profile: z.object({ level: z.string(), name: z.string(), blurb: z.string(), settings: z.record(z.string(), z.number()) }).nullable() }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  budget: { bucket: "propose", perMinute: 5, perHour: 40 },
  async handler(args, ctx) {
    const now = ctx.now();
    const settings: Record<string, unknown> = {};
    if (args.name !== undefined) {
      const name = normalizeAgentName(args.name);
      if (!AGENT_NAME_RE.test(name)) throw new McpError("invalid_input", "name: 1-24 characters, starting with a letter or number and containing at least one letter.");
      settings.agentName = name;
    }
    if (args.strategy) settings.strategy = args.strategy;
    if (args.asset_mode) settings.assetMode = args.asset_mode;
    if (args.basket) {
      const owner = await settingsReader().settingsFor(ctx.principal.tenant);
      const allowed = new Set([...stockSymbols(), ...(owner?.customTokens ?? []).map((c) => c.symbol.toUpperCase())]);
      if (args.basket.some((s) => !allowed.has(s.toUpperCase()))) throw new McpError("invalid_input", "basket may only contain stock tokens or tokens added in Settings.");
      settings.basketSymbols = [...new Set(args.basket.map((s) => s.toUpperCase()))];
    }
    const profile = args.risk_level ? RISK_PROFILES[args.risk_level] : null;
    if (profile) Object.assign(settings, profile.settings);
    if (!Object.keys(settings).length) throw new McpError("invalid_input", "Say at least one thing to set up: name, strategy, basket, asset_mode or risk_level.");
    const binding: Binding = { v: 1, kind: "agent_draft", tenant: ctx.principal.tenant, settings, risk_level: args.risk_level ?? null, expires_at: now + PROPOSAL_TTL_SEC.agent_draft };
    const summary = {
      action: "Set up an agent",
      settings,
      risk_level: args.risk_level ?? null,
      after_approval: "Approving saves these settings. Then choose the agent's limits and sign its trading permission in Merrymen; until then it cannot trade.",
      requested_by: ctx.principal.clientName ?? "an AI assistant",
    };
    const d = await ctx.mcp();
    const { row, created } = await createProposal(d.db, {
      tenant: ctx.principal.tenant, connectionId: ctx.principal.connectionId, clientName: ctx.principal.clientName,
      binding, summary, idempotencyKey: args.idempotency_key, agentSlug: null, agentAccount: null, now,
    }).catch(translate);
    return {
      data: {
        ...proposalOut(row, created, "Send the owner approval_url. Approving applies these settings; signing the trading permission stays with the owner."),
        risk_profile: profile ? { level: profile.level, name: profile.name, blurb: profile.blurb, settings: { ...profile.settings } as Record<string, number> } : null,
      },
    };
  },
});

const draftPost = defineTool({
  name: "draft_post",
  title: "Draft a post for approval",
  description: "Draft a line for the Merrymen group chat, posted under the owner's agent only after the owner approves it in Merrymen. Lines with addresses, links or secrets are refused.",
  capability: "social.write",
  input: z.object({ agent: AGENT_ARG, text: z.string().min(1).max(500), idempotency_key: IDEMPOTENCY }).strict(),
  output: PROPOSAL_OUT,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  budget: { bucket: "propose", perMinute: 5, perHour: 40 },
  async handler(args, ctx) {
    const agent = await ctx.agent(args.agent);
    const verdict = admitOwnerLine(args.text);
    if (!verdict.ok) throw new McpError("invalid_input", `The group chat would refuse this line (${verdict.reason}).`);
    const now = ctx.now();
    const binding: Binding = { v: 1, kind: "post", tenant: ctx.principal.tenant, agent_slug: agent.slug, text: verdict.text, expires_at: now + PROPOSAL_TTL_SEC.post };
    const d = await ctx.mcp();
    const { row, created } = await createProposal(d.db, {
      tenant: ctx.principal.tenant, connectionId: ctx.principal.connectionId, clientName: ctx.principal.clientName,
      binding, summary: { action: "Post in the group chat", text: verdict.text, requested_by: ctx.principal.clientName ?? "an AI assistant" },
      idempotencyKey: args.idempotency_key, agentSlug: agent.slug, agentAccount: agent.account, now,
    }).catch(translate);
    return { data: proposalOut(row, created, "Send the owner approval_url; it is posted only if they approve.") };
  },
});

// ── following up ────────────────────────────────────────────────────────────

const VIEW = z.object({
  proposal_id: z.string(),
  kind: z.string(),
  status: z.string(),
  status_explained: z.string(),
  terminal: z.boolean(),
  approval_url: z.string().nullable(),
  created_at: z.string(),
  expires_at: z.string(),
  decided_at: z.string().nullable(),
  requested_by: z.string().nullable(),
  summary: z.record(z.string(), z.unknown()),
  order_id: z.string().nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
});

const EXPLAIN: Record<string, string> = {
  awaiting_approval: "Waiting for the owner to approve it in Merrymen.",
  approved: "Approved; being handed to the agent.",
  submitted: "Queued for the agent; it has not picked it up yet.",
  executing: "The agent picked it up and is executing (or waiting for the chain's receipt).",
  filled_awaiting_ledger: "The agent reported a fill; waiting for the ledger to record it before calling it confirmed.",
  confirmed: "Confirmed on chain: the receipt and the recorded fill agree.",
  paper_filled: "Filled in the practice (paper) book. No real money moved.",
  refused: "The agent's limits, policy or the on-chain permission refused it. Nothing was traded.",
  failed: "It did not complete (for example the transaction reverted). See result.",
  expired: "It expired without running. Nothing was sent.",
  cancelled: "Cancelled. Nothing was sent.",
  rejected: "The owner declined it.",
  applied: "Approved and applied.",
};

async function viewOf(ctx: ToolContext, row: ProposalRow) {
  const d = await ctx.mcp();
  let r = await expireIfDue(d.db, row, ctx.now());
  if (r.kind === "trade") r = await ctx.ledger((ledger) => followTrade(d.db, ledger, r, ctx.now()));
  const summary = JSON.parse(r.summary_json) as Record<string, unknown>;
  return {
    proposal_id: r.id,
    kind: r.kind,
    status: r.status,
    status_explained: EXPLAIN[r.status] ?? r.status,
    terminal: TERMINAL.has(r.status),
    approval_url: r.status === "awaiting_approval" ? approvalUrl(r.id) : null,
    created_at: new Date(r.created_at * 1000).toISOString(),
    expires_at: new Date(r.expires_at * 1000).toISOString(),
    decided_at: isoOrNull(r.decided_at),
    requested_by: r.client_name,
    summary,
    order_id: r.order_id,
    result: r.result_json ? JSON.parse(r.result_json) as Record<string, unknown> : null,
  };
}

async function ownedProposal(ctx: ToolContext, id: string): Promise<ProposalRow> {
  const d = await ctx.mcp();
  const row = await proposalRow(d.db, ctx.principal.tenant, id);
  // Another owner's, or a kind this connection may not handle: not found.
  if (!row || !hasCapability(ctx.principal, KIND_CAPABILITY[row.kind])) throw new McpError("not_found", "No such proposal.");
  return row;
}

const PROPOSAL_ID = z.string().regex(/^prp_[0-9a-f]{32}$/, "a proposal id from a propose_* tool");
const ANY_PROPOSAL: readonly Capability[] = ["trade.propose", "drafts.write", "social.write"];

const getProposal = defineTool({
  name: "get_proposal",
  title: "Proposal status",
  description: "The status of a proposal: waiting for approval, submitted, executing, confirmed (on-chain receipt and ledger agree), paper-filled, refused, failed, expired, cancelled, rejected or applied — with the result.",
  capability: "trade.propose",
  anyOf: ANY_PROPOSAL,
  input: z.object({ proposal_id: PROPOSAL_ID }).strict(),
  output: VIEW,
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler(args, ctx) {
    const view = await viewOf(ctx, await ownedProposal(ctx, args.proposal_id));
    return { data: view, summary: `${view.proposal_id}: ${view.status_explained}` };
  },
});

const listProposals = defineTool({
  name: "list_proposals",
  title: "List proposals",
  description: "Proposals prepared through this and other connections for this owner, newest first.",
  capability: "trade.propose",
  anyOf: ANY_PROPOSAL,
  input: z.object({ status: z.enum(["open", "all", "awaiting_approval", "confirmed", "paper_filled", "refused", "failed", "expired", "cancelled", "rejected", "applied"]).default("open"), limit: LIMIT_ARG(50, 20) }).strict(),
  output: z.object({ proposals: z.array(VIEW) }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler(args, ctx) {
    const d = await ctx.mcp();
    const rows = await listProposalRows(d.db, ctx.principal.tenant, { status: args.status === "all" ? undefined : args.status, limit: args.limit });
    const visible = rows.filter((r) => hasCapability(ctx.principal, KIND_CAPABILITY[r.kind]));
    const proposals = [];
    for (const r of visible) proposals.push(await viewOf(ctx, r));
    return { data: { proposals } };
  },
});

const cancel = defineTool({
  name: "cancel_proposal",
  title: "Cancel a proposal",
  description: "Cancel a proposal that has not been approved, or withdraw an approved trade the agent has not picked up yet. Once the agent has picked an order up it can no longer be cancelled here.",
  capability: "trade.propose",
  anyOf: ANY_PROPOSAL,
  input: z.object({ proposal_id: PROPOSAL_ID }).strict(),
  output: VIEW,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async handler(args, ctx) {
    const row = await ownedProposal(ctx, args.proposal_id);
    const d = await ctx.mcp();
    const cancelled = await ctx.ledger((ledger) => cancelProposal(d.db, ledger, ctx.principal.tenant, row.id, ctx.now())).catch(translate);
    return { data: await viewOf(ctx, cancelled) };
  },
});

export const PROPOSAL_TOOLS = [quoteTradeTool, proposeTrade, proposeSettings, createDraft, draftPost, getProposal, listProposals, cancel];
