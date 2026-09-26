/**
 * Agent inspection: which agents this connection may see, their status, and
 * the controls and limits that govern them.
 */
import * as z from "zod";
import { readAgentRow, readAgentStatus, blockerView, freshWithin } from "@/lib/services/agent-status";
import { settingsReader } from "@/lib/services/settings-view";
import { hasCapability } from "../policy";
import type { Principal } from "../oauth/server";
import { defineTool } from "../tool";
import { AGENT_ARG, isoOrNull } from "./shared";

const blocker = z.object({ rule: z.string(), text: z.string(), owner_can_fix: z.boolean(), is_fault: z.boolean() }).nullable();

const listAgents = defineTool({
  name: "list_agents",
  title: "List my agents",
  description: "List the Merrymen agents the owner shared with this connection: id, name, account, mode (paper/live) and status. Use the id as `agent` in other tools.",
  capability: "agents.read",
  input: z.object({}).strict(),
  output: z.object({
    agents: z.array(z.object({
      agent: z.string().describe("Agent id (public slug)"),
      name: z.string().nullable(),
      account: z.string().nullable().describe("Current smart account address; null before the first signed permission"),
      chain_id: z.number().nullable(),
      status: z.string(),
      mode: z.string(),
      live_blocker: blocker,
      permission_expires_at: z.string().nullable(),
    })),
    observed_at: z.string(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler(_args, ctx) {
    const agents = await ctx.agents();
    const now = ctx.now();
    const rows = await ctx.ledger(async (db) => Promise.all(agents.map(async (a) => {
      const settings = await settingsReader().settingsFor(ctx.principal.tenant);
      const row = a.account ? await readAgentRow(db, a.account) : null;
      return {
        agent: a.slug,
        name: row?.name ?? settings?.agentName ?? null,
        account: a.account,
        chain_id: a.chainId,
        status: row?.status ?? (a.account ? "unknown" : "no-permission-signed"),
        mode: row?.mode ?? "unknown",
        live_blocker: blockerView(row?.live_blocker ?? null),
        permission_expires_at: isoOrNull(a.expiresAt),
      };
    })));
    return {
      data: { agents: rows, observed_at: new Date(now * 1000).toISOString() },
      summary: rows.length ? `${rows.length} agent(s) shared with this connection.` : "No agent is shared with this connection.",
    };
  },
});

const getAgentStatus = defineTool({
  name: "get_agent_status",
  title: "Agent status",
  description: "An agent's current status: running or not, paper or live, what blocks live trading, strategy, and how fresh its records are (last heartbeat, last valuation, last decision and trade).",
  capability: "agents.read",
  input: z.object({ agent: AGENT_ARG }).strict(),
  output: z.object({
    agent: z.string(),
    name: z.string().nullable(),
    account: z.string().nullable(),
    chain_id: z.number().nullable(),
    status: z.string(),
    mode: z.string(),
    mode_explained: z.string(),
    live_blocker: blocker,
    strategy: z.string().nullable(),
    asset_mode: z.string().nullable(),
    live_trading_enabled: z.boolean(),
    paper_trading_enabled: z.boolean(),
    launch_buying_enabled: z.boolean(),
    permission: z.object({ granted_at: z.string().nullable(), expires_at: z.string().nullable(), expired: z.boolean().nullable(), days_left: z.number().nullable() }),
    freshness: z.object({
      heartbeat_at: z.string().nullable(),
      heartbeat_age_s: z.number().nullable(),
      worker_fresh: z.boolean().nullable(),
      fresh_within_s: z.number(),
      last_valuation_at: z.string().nullable(),
      last_valuation_book: z.string().nullable(),
      last_decision_at: z.string().nullable(),
      last_trade_at: z.string().nullable(),
    }),
    observed_at: z.string(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler({ agent }, ctx) {
    const a = await ctx.agent(agent);
    const now = ctx.now();
    const settings = await settingsReader().settingsFor(ctx.principal.tenant);
    const status = a.account ? await ctx.ledger((db) => readAgentStatus(db, a.account!, settings, now)) : null;
    const mode = status?.mode ?? "unknown";
    const modeExplained = !a.account
      ? "No trading permission has been signed yet, so the agent cannot run."
      : mode === "live" ? "Trading real funds on chain within the signed limits."
        : mode === "paper" ? "Practising with simulated money. Paper results are not real funds."
          : mode === "idle" ? "Running but not trading (see live_blocker)."
            : "The worker has not reported a mode yet.";
    const expired = a.expiresAt === null ? null : now >= a.expiresAt;
    const f = status?.freshness;
    return {
      data: {
        agent: a.slug,
        name: status?.name ?? settings?.agentName ?? null,
        account: a.account,
        chain_id: a.chainId,
        status: status?.status ?? (a.account ? "unknown" : "no-permission-signed"),
        mode,
        mode_explained: modeExplained,
        live_blocker: status?.live_blocker ?? null,
        strategy: settings?.strategy ?? null,
        asset_mode: settings?.assetMode ?? null,
        live_trading_enabled: settings?.liveTradingEnabled ?? false,
        paper_trading_enabled: settings?.paperTradingEnabled ?? true,
        launch_buying_enabled: settings?.launchBuying.enabled ?? false,
        permission: {
          granted_at: isoOrNull(a.grantedAt),
          expires_at: isoOrNull(a.expiresAt),
          expired,
          days_left: a.expiresAt === null ? null : Math.max(0, Math.floor((a.expiresAt - now) / 86_400)),
        },
        freshness: {
          heartbeat_at: isoOrNull(f?.heartbeat_at ?? null),
          heartbeat_age_s: f?.heartbeat_age_s ?? null,
          worker_fresh: f?.worker_fresh ?? null,
          fresh_within_s: f?.fresh_within_s ?? freshWithin(settings?.tickSeconds),
          last_valuation_at: isoOrNull(f?.last_valuation_at ?? null),
          last_valuation_book: f?.last_valuation_book ?? null,
          last_decision_at: isoOrNull(f?.last_decision_at ?? null),
          last_trade_at: isoOrNull(f?.last_trade_at ?? null),
        },
        observed_at: new Date(now * 1000).toISOString(),
      },
      summary: `${status?.name ?? a.slug}: ${mode}, ${status?.status ?? "unknown"}${status?.live_blocker ? ` — ${status.live_blocker.text}` : ""}.`,
    };
  },
});

const getAgentControls = defineTool({
  name: "get_agent_controls",
  title: "Limits, budget and controls",
  description: "The agent's signed limits (per trade, per day, drawdown, operations, expiry), how much of today's budget is used, the effective risk settings, and what each control (pause, kill switch, live switch) does and where it lives. Read-only.",
  capability: "agents.read",
  input: z.object({ agent: AGENT_ARG }).strict(),
  output: z.object({
    agent: z.string(),
    signed_limits: z.object({
      per_trade_usdg: z.number().nullable(),
      per_day_usdg: z.number().nullable(),
      max_drawdown_pct: z.number().nullable(),
      max_ops_per_day: z.number().nullable(),
      granted_at: z.string().nullable(),
      expires_at: z.string().nullable(),
      enforced_where: z.string(),
    }),
    budget_24h: z.object({
      book: z.string(),
      spent_usdg: z.number().nullable(),
      remaining_usdg: z.number().nullable(),
      ops: z.number().nullable(),
      ops_remaining: z.number().nullable(),
      note: z.string(),
    }),
    risk_settings: z.object({
      slippage_bps: z.number().nullable(),
      max_impact_bps: z.number().nullable(),
      stop_loss_bps: z.number().nullable(),
      take_profit_bps: z.number().nullable(),
      chat_action_ceiling_usdg: z.number().nullable(),
      tick_seconds: z.number().nullable(),
      launch_buying: z.object({ enabled: z.boolean(), per_entry_usdg: z.number().nullable(), max_positions: z.number().nullable() }),
    }),
    controls: z.array(z.object({ control: z.string(), where: z.string(), effect: z.string(), available_here: z.boolean() })),
    observed_at: z.string(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler({ agent }, ctx) {
    const a = await ctx.agent(agent);
    const now = ctx.now();
    const settings = await settingsReader().settingsFor(ctx.principal.tenant);
    const row = a.account ? await ctx.ledger((db) => readAgentRow(db, a.account!)) : null;
    const book = row?.mode === "paper" ? "paper" : "live";
    const statuses = book === "paper" ? "'paper'" : "'landed','submitted'";
    const usage = a.account ? await ctx.ledger(async (db) => {
      const spent = await db.prepare(`SELECT COALESCE(SUM(amount_usdg), 0) AS s, COUNT(*) AS n FROM trades
        WHERE lower(agent_id) = ? AND status IN (${statuses}) AND kind != 'vault-withdraw' AND created_at > ?`).get(a.account!.toLowerCase(), now - 86_400) as { s: number; n: number };
      return { spent: Number(spent.s), ops: Number(spent.n) };
    }) : null;
    const perDay = a.caps?.dailyUsdg ?? null;
    const maxOps = a.caps?.maxOpsPerDay ?? null;
    return {
      data: {
        agent: a.slug,
        signed_limits: {
          per_trade_usdg: a.caps?.perTradeUsdg ?? null,
          per_day_usdg: perDay,
          max_drawdown_pct: a.caps?.maxDrawdownPct ?? null,
          max_ops_per_day: maxOps,
          granted_at: isoOrNull(a.grantedAt),
          expires_at: isoOrNull(a.expiresAt),
          enforced_where: "Per-trade size and expiry are enforced by the smart account on chain; the daily budget, operation count and drawdown breaker are enforced by the agent's worker before it signs.",
        },
        budget_24h: {
          book,
          spent_usdg: usage ? Math.round(usage.spent * 100) / 100 : null,
          remaining_usdg: usage && perDay !== null ? Math.max(0, Math.round((perDay - usage.spent) * 100) / 100) : null,
          ops: usage?.ops ?? null,
          ops_remaining: usage && maxOps !== null ? Math.max(0, maxOps - usage.ops) : null,
          note: "Computed from the shared ledger over the trailing 24 hours. The worker also counts orders in flight that have not reached the ledger yet, so its own figure can be slightly higher.",
        },
        risk_settings: {
          slippage_bps: settings?.slippageBps ?? null,
          max_impact_bps: settings?.maxImpactBps ?? null,
          stop_loss_bps: settings?.stopLossBps ?? null,
          take_profit_bps: settings?.takeProfitBps ?? null,
          chat_action_ceiling_usdg: settings?.telegram.maxActionUsdg ?? null,
          tick_seconds: settings?.tickSeconds ?? null,
          launch_buying: {
            enabled: settings?.launchBuying.enabled ?? false,
            per_entry_usdg: settings?.launchBuying.perEntryUsdg ?? null,
            max_positions: settings?.launchBuying.maxPositions ?? null,
          },
        },
        controls: agentControls(ctx.principal),
        observed_at: new Date(now * 1000).toISOString(),
      },
    };
  },
});

/**
 * Where each control lives. Every `where` names a control that exists: the
 * web app's You → Wallet & permissions (/grant) screen, whose red "discard &
 * start over" button deletes the stored grant (DELETE /api/grants), the Trading
 * limits panel's "Edit signed limits" link, Settings, and the Telegram
 * commands in the bot's /help, which answer only while Settings → Advanced
 * settings → Telegram controls → "allow control commands" is on.
 * agents.test.ts checks each quoted label against the web app's source and
 * the bot's command list.
 *
 * None of these names a tool: a tool can be absent from the connection asking
 * (the directory profile has no proposal tools at all), so an entry that
 * depends on one is chosen per connection in agentControls.
 */
const FIXED_CONTROLS = [
  { control: "pause / resume", where: "Telegram /pause and /resume (only while Settings → Advanced settings → Telegram controls → 'allow control commands' is on)", effect: "Pausing stops the whole trading cycle: new entries AND exits, including stop-loss and take-profit. Owner orders are refused while paused. It is kept on the agent's own machine, so it is not offered here: a remote pause that silently disabled protective exits would be unsafe.", available_here: false },
  // Telegram /kill is named again. On hosted Merrymen (the only place MCP runs)
  // it used to delete only the agent machine's copy of the key, and the
  // orchestrator restored it from the grant store. It now leaves a kill
  // request that the orchestrator carries out against the store, as the web
  // page's DELETE does (worker/src/kill-request.ts).
  { control: "kill switch", where: "Merrymen → You → Wallet & permissions (/grant) → 'discard & start over', or Telegram /kill, then /confirm (only while Settings → Advanced settings → Telegram controls → 'allow control commands' is on)", effect: "Removes the stored trading key so the agent can no longer sign anything. The Telegram command stops the agent on its next tick; the server deletes the stored key within seconds and confirms it in the owner's Telegram chat. Funds stay in the owner's smart account. Starting over on the web page also restarts a paper book; live positions and trades are never deleted.", available_here: false },
  { control: "live trading on/off", where: "Merrymen → You → Settings (/settings) → 'live trading'", effect: "Off means no real orders; the agent practises on paper if paper trading is on. Only the owner can turn it on.", available_here: false },
  { control: "limits (per trade, per day, drawdown, expiry)", where: "Merrymen → You → Trading limits → 'Edit signed limits' (re-sign on Wallet & permissions, /grant)", effect: "Changing a signed limit requires a new owner signature.", available_here: false },
];

/** Setting changes, for a connection holding drafts.write: propose_settings_change is registered on it. */
export const SETTINGS_CONTROL_HERE = { control: "setting changes", where: "propose_settings_change (owner approves in Merrymen)", effect: "Strategy, basket and risk settings can be proposed here and take effect only after the owner approves them.", available_here: true };
/** Setting changes, for any other connection (always on the directory profile): no tool is named, because none exists there. */
export const SETTINGS_CONTROL_IN_APP = { control: "setting changes", where: "Merrymen → You → Settings (/settings)", effect: "Strategy, basket and risk settings are changed by the owner in Merrymen's Settings. This connection cannot propose them.", available_here: false };

/** Every entry any connection can be shown, for the label checks in agents.test.ts. */
export const AGENT_CONTROLS = [...FIXED_CONTROLS, SETTINGS_CONTROL_HERE, SETTINGS_CONTROL_IN_APP];

/**
 * The controls as this connection sees them: available_here follows the
 * capability the control needs (hasCapability, which is false for anything
 * outside the directory profile), and an unavailable control points at
 * Merrymen itself instead of at a tool this connection does not have.
 */
export function agentControls(p: Principal): Array<(typeof AGENT_CONTROLS)[number]> {
  return [...FIXED_CONTROLS, hasCapability(p, "drafts.write") ? SETTINGS_CONTROL_HERE : SETTINGS_CONTROL_IN_APP];
}

export const AGENT_TOOLS = [listAgents, getAgentStatus, getAgentControls];
