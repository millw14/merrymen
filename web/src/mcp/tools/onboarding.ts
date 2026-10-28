/** A read-only path from a connected assistant to an owner-authorized worker. */
import * as z from "zod";
import { readAgentEnergy } from "@/lib/agent-energy";
import { blockerAdvice } from "@/lib/live-blocker";
import { readAgentStatus } from "@/lib/services/agent-status";
import { settingsReader } from "@/lib/services/settings-view";
import { beatSeconds, workerStale } from "@/terminal/worker-stale";
import { readFleetRecoveryView } from "../../../../worker/src/fleet-recovery";
import { mcpConfig } from "../config";
import { McpError } from "../errors";
import { hasCapability } from "../policy";
import { defineTool } from "../tool";
import { agentControls } from "./agents";
import { AGENT_ARG, isoOrNull, untrusted } from "./shared";

const PHASE = z.enum([
  "no_shared_agent", "select_agent", "permission_required", "permission_expired",
  "awaiting_worker", "worker_stale", "recovery_hold", "blocked", "energy_limited", "paper", "live", "idle",
]);
const STEP = z.object({
  action: z.string(), label: z.string(), detail: z.string(), url: z.string().nullable(),
  tool: z.string().nullable(), owner_action_required: z.boolean(),
});
type Step = z.infer<typeof STEP>;
const AGENT_VIEW = z.object({
  id: z.string(), name: z.string().nullable(), account: z.string().nullable(), chain_id: z.number().nullable(),
  status: z.string(), mode: z.string(), strategy: z.string().nullable(),
  permission_expires_at: z.string().nullable(), heartbeat_at: z.string().nullable(), worker_fresh: z.boolean().nullable(),
  live_blocker: z.string().nullable(),
  energy: z.object({
    level: z.string(), gated: z.boolean(), fresh: z.boolean(), entry_allowance_exhausted: z.boolean().nullable(),
    entries_used: z.number().nullable(), entries_allowed: z.number().nullable(), resets_at: z.string().nullable(),
    reported_at: z.string().nullable(),
  }).nullable(),
}).nullable();

const getMerrymanSetup = defineTool({
  name: "get_merryman_setup",
  title: "Merryman setup and next steps",
  description: "Read the current connection's setup, authorized agent readiness and next steps: owner signing, permission renewal, funding, worker freshness, recovery and energy. Distinguishes an unshared agent from a missing trading permission. Includes links to existing owner controls; does not create a wallet, activate trading or change settings.",
  capability: "market.read",
  anyOf: ["market.read", "agents.read", "drafts.write"],
  directoryAnyOf: ["market.read", "agents.read"],
  input: z.object({ agent: AGENT_ARG }).strict(),
  output: z.object({
    phase: PHASE,
    summary: z.string(),
    connection: z.object({
      id: z.string().describe("Opaque connection identifier for isolating view state; never a credential"),
      profile: z.string(), can_read_agents: z.boolean(), can_create_draft: z.boolean(),
      can_propose_settings: z.boolean(), shared_agent_count: z.number(), available_tools: z.array(z.string()),
    }),
    agent: AGENT_VIEW,
    next_steps: z.array(STEP),
    links: z.object({ create: z.string(), wallet: z.string(), settings: z.string(), funding: z.string(), connected_apps: z.string() }),
    runtime: z.object({ hosted: z.literal(true), keep_chat_open: z.literal(false), explanation: z.string() }),
    controls: z.array(z.object({ control: z.string(), where: z.string(), effect: z.string(), available_here: z.boolean() })),
    observed_at: z.string(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler({ agent: ref }, ctx) {
    const issuer = mcpConfig().issuer;
    if (!issuer) throw new McpError("upstream_unavailable", "The Merrymen app address is not configured.");
    // Fixed paths on the configured issuer; no client URL, tenant or key enters a link.
    const link = (path: string) => new URL(path, issuer).href;
    const links = { create: link("/create"), wallet: link("/grant"), settings: link("/settings"), funding: link("/deposit"), connected_apps: link("/connect/apps") };
    const canRead = hasCapability(ctx.principal, "agents.read");
    const canDraft = hasCapability(ctx.principal, "drafts.write");
    // A public research or drafting connection cannot inspect the owner's hidden directory.
    if (ref !== undefined && !canRead) throw new McpError("not_found", "No such agent is shared with this connection.");
    const agents = canRead ? await ctx.agents() : [];
    const selected = ref !== undefined ? await ctx.agent(ref) : agents.length === 1 ? agents[0]! : null;
    const next: Step[] = [];
    const step = (action: string, label: string, detail: string, url: string | null, owner = true, tool: string | null = null) => {
      next.push({ action, label, detail, url, tool, owner_action_required: owner });
    };
    let phase: z.infer<typeof PHASE> = "no_shared_agent";
    let summary = "No agent is visible to this connection. That does not mean the owner has no agent.";
    let view: z.infer<typeof AGENT_VIEW> = null;

    if (!selected) {
      if (agents.length > 1) {
        phase = "select_agent";
        summary = "Several agents are shared with this connection; select one before inspecting its setup.";
        step("select_agent", "Choose a shared agent", "Use the id returned by the shared-agent list.", null, false, "list_agents");
      } else {
        step("share_agent", "Check connected-app access", "For an existing agent, reconnect this app and allow agent status access and the agent you want to share. Creating a wallet does not expand an existing connection's permissions.", links.connected_apps);
        if (canDraft) step("draft_setup", "Prepare an agent setup", "A setup proposal is reviewed by the owner in Merrymen; the owner still signs the wallet's trading permission.", null, false, "create_merryman");
        step("create_agent", "Create an agent if needed", "The owner signs in with a protected signing wallet, reviews practice or live mode and limits, then signs in Merrymen. Existing wallets should be managed instead of replaced.", links.create);
      }
    } else {
      // ctx.agents/ctx.agent already checked current ownership AND this connection's sharing.
      const now = ctx.now();
      const settings = await settingsReader().settingsFor(ctx.principal.tenant);
      const status = selected.account ? await ctx.ledger(db => readAgentStatus(db, selected.account!, settings, now)) : null;
      const beat = beatSeconds(status?.freshness.heartbeat_at);
      const stale = workerStale(beat, now, settings?.tickSeconds);
      const futureBeat = beat !== null && beat > now + 30;
      const fresh = beat === null || futureBeat ? null : stale === false;
      // An old worker can keep heartbeating after a new grant is stored. Only
      // a matching permission in that same reported row confirms adoption.
      const currentGrantSeen = beat !== null && selected.grantedAt !== null && beat >= selected.grantedAt
        && status?.granted_at === selected.grantedAt && status?.expires_at === selected.expiresAt
        && selected.chainId !== null && status?.chain_id === selected.chainId;
      const energy = selected.account ? await readAgentEnergy(selected.account, fn => ctx.ledger(db => fn(db))) : null;
      const energyFresh = energy !== null && energy.at > 0 && energy.at <= now + 30 && !workerStale(energy.at, now, settings?.tickSeconds)
        && energy.day === new Date(now * 1000).toISOString().slice(0, 10) && energy.resetsAt > now;
      // Recovery failures propagate: a failed hold read cannot report a healthy worker.
      const recovery = selected.account && selected.chainId !== null
        ? await ctx.ledger(db => readFleetRecoveryView(db, { tenant: ctx.principal.tenant, smartAccount: selected.account!, chainId: selected.chainId! }, beat)) : null;
      const expired = selected.expiresAt !== null && now >= selected.expiresAt;
      const rule = status?.live_blocker?.rule ?? null;
      const advice = blockerAdvice(rule);
      view = {
        id: selected.slug, name: untrusted(status?.name ?? settings?.agentName, 64), account: selected.account,
        chain_id: selected.chainId, status: status?.status ?? "unknown", mode: status?.mode ?? "unknown",
        strategy: untrusted(settings?.strategy, 64), permission_expires_at: isoOrNull(selected.expiresAt), heartbeat_at: isoOrNull(beat),
        worker_fresh: fresh, live_blocker: rule,
        energy: energy ? {
          level: energy.level, gated: energy.gated, fresh: energyFresh,
          entry_allowance_exhausted: energyFresh ? energy.gated && energy.spent : null,
          entries_used: energy.entries?.used ?? null, entries_allowed: energy.entries?.allowed ?? null,
          resets_at: isoOrNull(energy.resetsAt), reported_at: isoOrNull(energy.at),
        } : null,
      };
      if (!selected.account) {
        phase = "permission_required";
        summary = "Your account is connected. Choose a name and strategy here, then confirm your wallet and trading limits in a secure step. If you already created a wallet, resume it instead.";
        if (canDraft) step("draft_setup", "Prepare a first agent setup", "Prepare a setup if you have not created a wallet; resume the saved wallet otherwise. The owner reviews the setup and signs the trading permission in Merrymen.", null, false, "create_merryman");
        step("sign_permission", "Review wallet and permission", "The owner reviews the saved wallet and signs its trading permission in Merrymen. Retry a saved activation instead of creating a second wallet.", links.wallet);
      } else if (recovery?.tradingPaused) {
        phase = "recovery_hold";
        summary = "Trading remains paused while Merrymen reconciles the saved account history. A new signature or deposit does not clear this service hold.";
        step("review_recovery", "View recovery status", "Keep the existing wallet and permission; the service must verify the original history before trading can resume.", links.wallet, false);
      } else if (expired || selected.expiresAt === null) {
        phase = expired ? "permission_expired" : "permission_required";
        summary = expired ? "The signed trading permission has expired; the worker cannot continue under it." : "The permission's expiry could not be established; trading readiness is unknown.";
        step("renew_permission", "Review trading permission", "Only the owner can renew or replace signed limits. Review the existing wallet; permission revocation may require network fees.", links.wallet);
      } else if (stale) {
        phase = "worker_stale";
        summary = "The worker's last report is too old to confirm it is running. Its last mode is historical, not current readiness.";
        step("check_worker", "Check worker status in Merrymen", "Recheck the hosted agent. Re-signing or funding is not a remedy for a stale worker report.", link("/agent"), false);
      } else if (!fresh || !currentGrantSeen) {
        phase = "awaiting_worker";
        summary = "The permission is stored, but there is no fresh worker report for this permission yet. Activation is not confirmed.";
        step("check_activation", "Check activation", "Wait for a fresh worker report. If the browser reports a failed activation, retry the saved permission from Wallet & permissions.", links.wallet, false);
      } else if (status?.status !== "active" && status?.status !== "armed") {
        phase = "blocked";
        summary = "The worker's reported status does not establish a running agent. Inspect the existing wallet and status before changing anything.";
        step("inspect_status", "Inspect agent status", "A fresh heartbeat alone is not evidence that trading is active.", link("/agent"), false);
      } else if (rule !== null && rule !== "live-not-enabled") {
        phase = "blocked";
        summary = status?.live_blocker?.text ?? "The worker reports a live-trading blocker.";
        if (advice?.resign) step("review_permission", "Review trading permission", advice.say, links.wallet);
        else if (advice?.funding) step("review_funding", rule === "no-gas" ? "Review ETH for network fees" : "Review USDG funding", advice.say, links.funding);
        else step("check_blocker", "Check the worker's blocker", advice?.say ?? "This blocker needs inspection; no signature or deposit is recommended from this report.", link("/agent"), false);
      } else if (energyFresh && energy?.gated && energy.spent) {
        phase = "energy_limited";
        summary = "The worker reports that today's energy allowance for new autonomous entries is used up. This does not establish that protective exits are blocked.";
        step("review_energy", "Review energy allowance", "Wait for the reported reset or review energy in Merrymen. This tool does not buy tokens or change the allowance.", link("/agent"), false);
      } else {
        phase = status?.mode === "live" ? "live" : status?.mode === "paper" ? "paper" : "idle";
        summary = phase === "live" ? "The worker has a fresh live-mode report for this permission. Individual trades still pass its risk, budget and market checks."
          : phase === "paper" ? "The worker has a fresh paper-mode report. Its practice balances and trades are simulated."
            : "The worker has a fresh report but is not currently reporting a trading mode.";
        if (phase !== "live" && !settings?.liveTradingEnabled) step("review_live_mode", "Review practice or live mode", "Practice can continue without real funds. Only the owner can enable live trading in Settings, after reviewing the permission and funding.", links.settings);
        if (selected.expiresAt - now <= 3 * 86_400) step("renew_soon", "Plan permission renewal", "The permission is still valid but expires within three days; renewal remains an owner signature.", links.wallet);
      }
      if (canDraft) step("propose_settings", "Prepare a settings change", "Changes take effect only after the owner reviews and approves them in Merrymen. Signed limits and live activation are not changed by this tool.", null, false, "propose_settings_change");
    }
    // This is a UI affordance, never authorization. Each named tool repeats its
    // own scope and object checks when called; no catalogue import/cycle is needed.
    const availableTools = ["get_merryman_setup"];
    if (canRead) availableTools.push("list_agents");
    if (canDraft && !agents.some(a => a.account !== null)) availableTools.push("create_merryman");
    if (canDraft) availableTools.push("get_proposal", "list_proposals", "cancel_proposal");
    if (selected) {
      availableTools.push("get_agent_status", "get_agent_controls", "get_agent_settings");
      if (hasCapability(ctx.principal, "portfolio.read")) availableTools.push("get_portfolio", "get_trades");
      if (hasCapability(ctx.principal, "decisions.read")) availableTools.push("list_decisions", "get_refusals");
      if (hasCapability(ctx.principal, "notifications.manage")) availableTools.push("list_notification_channels", "list_subscriptions", "subscribe", "unsubscribe");
      if (canDraft) availableTools.push("create_agent_draft", "propose_settings_change");
    }
    const data = {
      phase, summary,
      connection: { id: ctx.principal.connectionId, profile: ctx.principal.profile ?? "full", can_read_agents: canRead, can_create_draft: canDraft, can_propose_settings: canDraft && selected !== null, shared_agent_count: agents.length, available_tools: availableTools },
      agent: view, next_steps: next, links,
      runtime: { hosted: true as const, keep_chat_open: false as const, explanation: "Merrymen's hosted worker runs the agent after owner signing and activation. The assistant chat, browser and local terminal do not need to stay open. This assistant connection does not itself create trading authority or keep the worker alive." },
      controls: selected ? agentControls(ctx.principal) : [],
      observed_at: new Date(ctx.now() * 1000).toISOString(),
    };
    return { data, summary };
  },
});

export const ONBOARDING_TOOLS = [getMerrymanSetup];
