/**
 * The owner's approval of a proposal an AI assistant prepared.
 *
 * GET shows it (with a fresh quote for a trade). POST approves or declines it,
 * and only with the owner's own Merrymen session, a same-origin request (the
 * /api middleware refuses cross-site; this route also checks Origin), and the
 * hash of the exact binding the page displayed. Showing it and approving it
 * both re-check that the app which prepared it is still connected with this
 * scope and agent (a proposal whose app lost that is cancelled, never
 * approved). Approving re-validates the
 * binding against the current state and then acts through the existing,
 * validated paths — the owner-order queue for trades, the settings route for
 * settings, the group-chat route for posts — invoked in-process with the
 * approver's own cookie, so every check those paths make still applies.
 */
import { tenantOf } from "@/lib/auth";
import { mcpConfig } from "@/mcp/config";
import { mcpDb } from "@/mcp/db";
import { agentDirectory } from "@/mcp/agents";
import { jsonResponse } from "@/mcp/oauth/metadata";
import { readBoundedText } from "@/mcp/oauth/deps";
import { strandedProbe } from "@/lib/services/proposal-probes";
import { writeAudit } from "@/mcp/observe";
import { readLedger as withReadDb } from "@/mcp/tool";
import { settingsReader } from "@/lib/services/settings-view";
import { quoteTrade } from "@/lib/services/trade-quote";
import {
  ProposalError, TERMINAL, approveProposal, cancelIfUnbacked, resumeStranded, changeRow, changedSince, currentValues, expireIfDue, followTrade, ownerOrderCeiling, proposalRow,
  queueApprovedTrade, rejectProposal, resultView, settingsOutcome,
  type Binding, type DraftBinding, type ProposalRow, type Revalidation, type SettingsBinding, type TradeBinding,
} from "@/lib/services/proposals";
import { KNOWN_STRATEGIES, orderSymbol } from "@/mcp/tools/proposals";
import { readAgentRow } from "@/lib/services/agent-status";
import { AGENT_NAME_RE, STOCK_TOKENS, normalizeAgentName, sellableAssets } from "@merrymen/core";
import { specFor, validStoredSetting } from "../../../../../../../worker/src/telegram/setting-spec";
import { PUT as settingsPut } from "../../../settings/route";
import { POST as groupchatPost } from "../../../groupchat/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ID = /^prp_[0-9a-f]{32}$/;
/** A decision and a 64-hex hash: a few dozen bytes. */
const BODY_MAX = 4096;

async function holding(account: string, token: string) {
  return withReadDb(async (db) => {
    if (!db) return null;
    const row = await db.prepare("SELECT raw_balance, value_usdg FROM positions WHERE lower(agent_id) = ? AND lower(token) = ? LIMIT 1").get(account.toLowerCase(), token.toLowerCase()) as { raw_balance: string | null; value_usdg: number | null } | undefined;
    if (!row?.raw_balance || !/^\d+$/.test(row.raw_balance)) return null;
    return { rawBalance: BigInt(row.raw_balance), valueUsdg: typeof row.value_usdg === "number" ? row.value_usdg : null };
  });
}

async function freshQuote(tenant: `0x${string}`, b: TradeBinding, features: string[]) {
  const settings = await settingsReader().settingsFor(tenant);
  return quoteTrade({
    side: b.side, token: b.token as `0x${string}`, amountUsdg: b.amount_usdg,
    slippageBps: b.slippage_bps, maxImpactBps: settings?.maxImpactBps ?? null, grantFeatures: features,
    holding: b.side === "sell" ? await holding(b.account, b.token) : null,
  });
}

/**
 * The agent's book as it last reported it (its heartbeat row): the value an
 * approval compares with the proposal's, and the one the page shows before a
 * decision. 'unknown' when it has not reported one.
 */
async function currentBook(account: string): Promise<"live" | "paper" | "unknown"> {
  const mode = await withReadDb(async (db) => (db ? (await readAgentRow(db, account))?.mode ?? null : null));
  return mode === "live" ? "live" : mode === "paper" ? "paper" : "unknown";
}

async function revalidateTrade(tenant: `0x${string}`, b: TradeBinding, now: number): Promise<Revalidation> {
  const agent = (await agentDirectory().agentsFor(tenant)).find((a) => a.slug === b.agent_slug);
  if (!agent) return { ok: false, why: "This agent is no longer yours." };
  if (agent.account !== b.account || agent.orderAgentId !== b.order_agent_id) return { ok: false, why: "The agent's account changed since this was proposed (a new permission was signed). Ask for a fresh proposal." };
  if (agent.expiresAt !== null && now >= agent.expiresAt) return { ok: false, why: "The agent's trading permission has expired. Re-sign it first." };
  const perTrade = agent.caps?.perTradeUsdg ?? null;
  if (perTrade !== null && b.amount_usdg > perTrade) return { ok: false, why: `It is over the signed per-trade limit of ${perTrade} USDG.` };
  const settings = await settingsReader().settingsFor(tenant);
  // The orders route's resolution: with nothing stored, the house's ceiling applies, not none.
  const ceiling = await ownerOrderCeiling(tenant, settings);
  if (ceiling > 0 && b.amount_usdg > ceiling) return { ok: false, why: `It is over your ${ceiling} USDG limit for an owner order.` };
  // Resolved through the worker's watch set, as propose_trade resolved it: an
  // order for a token the worker does not watch is one it always refuses.
  const addressable = await orderSymbol(tenant, b.token, settings, b.chain_id);
  if ("why" in addressable) return { ok: false, why: `${addressable.why} Nothing was sent.` };
  if (addressable.symbol !== b.symbol) return { ok: false, why: "The token's symbol changed in your settings since this was proposed. Ask for a fresh proposal." };
  if (!sellableAssets({ grantFeatures: agent.features, grantTokens: agent.grantTokens }).has(b.token)) {
    return { ok: false, why: "Your signed permission no longer covers this token." };
  }
  // The page told the owner "practice" or "real money" from the book the
  // agent was in when this was proposed. If that changed since, the approval
  // would be for something other than what they read: refuse it.
  const book = await currentBook(b.account);
  if (book !== b.book) {
    return { ok: false, why: `Your agent is now in ${book === "live" ? "live (real money)" : book === "paper" ? "practice (paper)" : "an unknown"} mode, not the mode this proposal was made in. Nothing was sent; ask for a fresh proposal.` };
  }
  const notes: string[] = [];
  if (b.side === "buy") {
    const q = await freshQuote(tenant, b, agent.features);
    if (!q.quoted || !q.expected_out) return { ok: false, why: `There is no executable quote right now (${q.why_not ?? "no route"}). Nothing was sent.` };
    if (b.quote && BigInt(q.expected_out.raw) < BigInt(b.quote.min_out_raw)) {
      return { ok: false, why: "The price has moved past the slippage this proposal was made with. Nothing was sent; ask for a fresh proposal." };
    }
    if (!q.impact_verdict.ok) return { ok: false, why: `The agent would refuse this buy now: ${q.impact_verdict.detail ?? "price impact is over its cap"}.` };
    notes.push(`re-quoted at approval: expect ${q.expected_out.human ?? q.expected_out.raw}`);
  }
  return { ok: true, notes };
}

/**
 * A settings change or an agent draft, checked again as the owner approves it.
 *
 * THE SAME ALLOWLIST AS THE PROPOSAL. Only chat-settable keys (SETTING_SPECS),
 * plus a draft's name; a safety floor such as maxImpactBps is not approvable
 * from here whatever a stored binding carries. A basket is checked against the
 * stock tokens and the owner's own added tokens, spelled exactly as the
 * settings route will check them — a draft from a connection with no agent
 * shared could not be checked when it was made.
 *
 * AND AGAINST WHAT IS THERE NOW. The page showed "before → after"; if any
 * "before" is no longer the owner's value, approving would apply a different
 * change than the one they read (a "tightening" that loosens), so it is
 * refused and a fresh proposal asked for.
 */
async function revalidateSettings(tenant: `0x${string}`, b: SettingsBinding | DraftBinding): Promise<Revalidation> {
  const changes = b.kind === "settings" ? b.changes : b.settings;
  const view = await settingsReader().settingsFor(tenant);
  for (const [k, v] of Object.entries(changes)) {
    if (k === "agentName") {
      if (b.kind !== "agent_draft" || typeof v !== "string" || normalizeAgentName(v) !== v || !AGENT_NAME_RE.test(v)) return { ok: false, why: "The agent name in this proposal is not allowed." };
      continue;
    }
    const spec = specFor(k);
    if (!spec || !validStoredSetting(k, v)) return { ok: false, why: `The change to ${spec?.label ?? k} is not allowed from here. Nothing was changed.` };
    if (spec.kind === "strategy" && !(KNOWN_STRATEGIES as readonly string[]).includes(v as string)) return { ok: false, why: `${String(v)} is not a strategy Merrymen knows.` };
    if (spec.kind === "symbols") {
      const selectable = new Set([...STOCK_TOKENS.map((t) => t.symbol), ...(view?.customTokens ?? []).map((c) => c.symbol)]);
      const bad = (v as string[]).filter((s) => !selectable.has(s));
      if (bad.length) return { ok: false, why: `The basket names ${bad.slice(0, 5).join(", ")}, which ${bad.length === 1 ? "is" : "are"} not a stock token or a token you added in Settings. Nothing was changed.` };
    }
  }
  if (!b.before || typeof b.before !== "object") return { ok: false, why: "This proposal was made before Merrymen recorded your settings with it. Ask your assistant for a fresh one." };
  const changed = changedSince(b.before, await currentValues(tenant, Object.keys(b.before), view));
  if (changed.length) {
    return { ok: false, why: `Your settings changed since this was proposed (${changed.map((k) => changeRow(k, null, null).label).join(", ")}). Nothing was changed; ask your assistant for a fresh proposal.` };
  }
  return { ok: true, notes: [] };
}

/** Does the owner run an agent that holds a signed permission? Then settings apply to it immediately. */
async function runsAnAgent(tenant: `0x${string}`): Promise<boolean> {
  return (await agentDirectory().agentsFor(tenant)).some((a) => a.account !== null);
}

/**
 * The before / now / proposed rows the approval page shows for a settings
 * change or a draft, read live, with the keys whose value moved since.
 */
async function settingsCheck(tenant: `0x${string}`, b: SettingsBinding | DraftBinding) {
  const changes = b.kind === "settings" ? b.changes : b.settings;
  const before = b.before ?? {};
  const now = await currentValues(tenant, Object.keys(changes));
  const changed = new Set(changedSince(before, now));
  return {
    rows: Object.keys(changes).map((k) => {
      const live = changeRow(k, now[k], changes[k]);
      return { key: k, label: live.label, when_proposed: changeRow(k, before[k] ?? null, null).current, current: live.current, proposed: live.proposed, help: live.help, changed: changed.has(k) };
    }),
    changed_since: [...changed],
    applies_to_running_agent: b.kind === "settings" ? true : await runsAnAgent(tenant),
    left_out: b.kind === "agent_draft" ? b.left_out ?? [] : [],
  };
}

/** Apply settings through the settings route itself, as the approving owner. */
async function applySettings(req: Request, tenant: string, changes: Record<string, unknown>) {
  const res = await settingsPut(new Request(`${mcpConfig().issuer}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: req.headers.get("cookie") ?? "" },
    body: JSON.stringify({ ...changes, owner: tenant }),
  }));
  const body = await res.json().catch(() => ({})) as { errors?: unknown; ignored?: unknown };
  // Refused outright (nothing saved), every key ignored (nothing saved: failed,
  // never "applied"), or some ignored (applied, partial, and named).
  return settingsOutcome(changes, { ok: res.ok, body: body && typeof body === "object" ? body : {} });
}

async function view(row: ProposalRow, tenant: `0x${string}`, now: number) {
  const d = await mcpDb();
  let r = await expireIfDue(d.db, row, now);
  // An app that was disconnected, or no longer holds this scope or agent, no
  // longer stands behind what it asked for: cancelled here, with the reason,
  // rather than offered for approval.
  r = await cancelIfUnbacked(d.db, r, now);
  // An approval interrupted between acting and recording its outcome is
  // finished from what it left behind (the queue, the settings, the room).
  r = await resumeStranded(d.db, r, now, strandedProbe(withReadDb));
  if (r.kind === "trade") r = await withReadDb(async (ledger) => (ledger ? followTrade(d.db, ledger, r, now) : r));
  const binding = JSON.parse(r.binding_json) as Binding;
  let quote = null;
  let check = null;
  // The book the agent is in NOW, while it has not finished: before a decision
  // it is what approving is checked against; after one, the mode it will
  // execute in. A finished trade's page reads its book from the outcome instead.
  let book: "live" | "paper" | "unknown" | null = null;
  if (binding.kind === "trade" && !TERMINAL.has(r.status)) book = await currentBook(binding.account).catch(() => "unknown" as const);
  if (r.status === "awaiting_approval" && binding.kind === "trade") {
    const agent = (await agentDirectory().agentsFor(tenant)).find((a) => a.slug === binding.agent_slug);
    quote = agent ? await freshQuote(tenant, binding, agent.features).catch(() => null) : null;
  }
  if (r.status === "awaiting_approval" && (binding.kind === "settings" || binding.kind === "agent_draft")) {
    check = await settingsCheck(tenant, binding).catch(() => null);
  }
  // The salt only defeats guessing from the hash; the page has no use for it.
  const shown = binding.kind === "agent_draft" ? (({ salt: _s, ...rest }) => rest)(binding) : binding;
  return {
    id: r.id, kind: r.kind, status: r.status, binding: shown, binding_hash: r.binding_hash,
    summary: JSON.parse(r.summary_json), requested_by: r.client_name,
    created_at: r.created_at, expires_at: r.expires_at, decided_at: r.decided_at,
    result: resultView(r.result_json), fresh_quote: quote, settings_check: check, current_book: book,
  };
}

export async function GET(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!mcpConfig().enabled) return jsonResponse({ error: "not_found" }, 404);
  const tenant = tenantOf(req);
  if (!tenant) return jsonResponse({ error: "login_required" }, 401);
  const { id } = await context.params;
  if (!ID.test(id)) return jsonResponse({ error: "not_found" }, 404);
  const d = await mcpDb();
  const row = await proposalRow(d.db, tenant, id);
  if (!row) return jsonResponse({ error: "not_found" }, 404);
  return jsonResponse(await view(row, tenant, Math.floor(Date.now() / 1000)));
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const cfg = mcpConfig();
  if (!cfg.enabled) return jsonResponse({ error: "not_found" }, 404);
  if (req.headers.get("origin") !== cfg.issuer) return jsonResponse({ error: "forbidden", error_description: "cross-site request" }, 403);
  const tenant = tenantOf(req);
  if (!tenant) return jsonResponse({ error: "login_required" }, 401);
  const { id } = await context.params;
  if (!ID.test(id)) return jsonResponse({ error: "not_found" }, 404);
  // Bounded as it is read: `req.text()` buffers a chunked body of any size
  // before a length check can run (and counts characters, not bytes).
  const text = await readBoundedText(req, BODY_MAX);
  if (text === null) return jsonResponse({ error: "invalid_request" }, 400);
  let body: { decision?: unknown; hash?: unknown };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    return jsonResponse({ error: "invalid_request" }, 400);
  }
  // `null`, a number or an array parse fine and are not a decision.
  if (!body || typeof body !== "object" || Array.isArray(body)) return jsonResponse({ error: "invalid_request" }, 400);
  if (typeof body.hash !== "string" || !/^[0-9a-f]{64}$/.test(body.hash)) return jsonResponse({ error: "invalid_request" }, 400);
  const d = await mcpDb();
  const now = Math.floor(Date.now() / 1000);
  try {
    if (body.decision === "reject") {
      const row = await rejectProposal(d.db, tenant, id, body.hash, now);
      await writeAudit(d, { action: "owner.proposal_rejected", outcome: "ok", tenant, detail: { proposal_id: id, kind: row.kind } });
      return jsonResponse(await view(row, tenant, now));
    }
    if (body.decision !== "approve") return jsonResponse({ error: "invalid_request" }, 400);
    const row = await approveProposal(d.db, tenant, id, body.hash, now, {
      revalidate: async (binding) => {
        if (binding.kind === "trade") return revalidateTrade(tenant, binding, now);
        if (binding.kind === "settings" || binding.kind === "agent_draft") return revalidateSettings(tenant, binding);
        return { ok: true, notes: [] };
      },
      act: async (binding, proposal) => {
        if (binding.kind === "trade") {
          const settings = await settingsReader().settingsFor(tenant);
          return withReadDb((ledger) => queueApprovedTrade(ledger, binding, proposal.id, settings?.tickSeconds ?? 240, Date.now()));
        }
        if (binding.kind === "settings") return applySettings(req, tenant, binding.changes);
        if (binding.kind === "agent_draft") return applySettings(req, tenant, binding.settings);
        // A post: the group-chat route's own gate, rate limit and idempotency (clientId = the proposal id).
        const res = await groupchatPost(new Request(`${cfg.issuer}/api/groupchat`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: req.headers.get("cookie") ?? "" },
          body: JSON.stringify({ body: binding.text, clientId: proposal.id.slice(4, 36) }),
        }));
        const out = await res.json().catch(() => ({})) as { message?: { id?: string }; error?: string };
        if (res.status === 429 || res.status === 503) return { retry: out.error ?? "The group chat is busy. Try again in a moment." };
        if (!res.ok) return { status: "failed", result: { why: out.error ?? `the group chat refused it (${res.status})` } };
        return { status: "applied", result: { message_id: out.message?.id ?? null } };
      },
    });
    await writeAudit(d, { action: "owner.proposal_approved", outcome: row.status, tenant, detail: { proposal_id: id, kind: row.kind } });
    return jsonResponse(await view(row, tenant, now));
  } catch (error) {
    if (error instanceof ProposalError) {
      const status = error.code === "not_found" ? 404 : error.code === "expired" ? 410 : error.code === "upstream_unavailable" ? 503 : error.code === "quota_exceeded" ? 429 : 409;
      await writeAudit(d, { action: "owner.proposal_decision", outcome: error.code, tenant, detail: { proposal_id: id } });
      return jsonResponse({ error: error.code, error_description: error.message }, status);
    }
    return jsonResponse({ error: "server_error", error_description: "Something went wrong. Nothing was changed." }, 500);
  }
}
