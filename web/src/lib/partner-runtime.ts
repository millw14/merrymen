/**
 * Adapts a consent-verified tenant to the existing worker's state and voice.
 * This module never authorizes a caller: its caller must first verify a partner
 * connection and the owner's consent. Internal session cookies remain in this
 * process and are never returned to the gateway or partner.
 */
import { isHostedMode } from "../../../packages/core/src/index";
import { mintSession, SESSION_COOKIE } from "./auth";
import { generateAgentReply, type AgentReply } from "./agent-chat";
import { llmText } from "../../../worker/src/llm";
import { fitChatState } from "./chat-state";
import { ledgerChatReply } from "./chat-ledger-facts";
import { PartnerError } from "./partner-bridge";
import type { FeedResponse } from "../app/api/feed/route";
import type { AgentStatus } from "../app/api/grants/route";
import type { SettingsView } from "../app/api/settings/route";

type Tenant = `0x${string}`;
type Reader = (req: Request) => Promise<Response>;
export interface PartnerRuntime {
  exists: boolean;
  smart_account: string | null;
  name: string;
  slug: string | null;
  status: "awaiting_grant" | "starting" | "running" | "stale";
  mode: AgentStatus["mode"];
  last_observed_mode: AgentStatus["mode"];
  /** Epoch milliseconds, including when the ledger stores epoch seconds. */
  worker_alive_at: number | null;
  heartbeat_fresh: boolean;
  live_blocker: string | null;
  last_observed_live_blocker: string | null;
  strategy: string | null;
  live_trading_enabled: boolean | null;
  paper_trading_enabled: boolean | null;
  ledger_available: boolean;
}

/**
 * A PartnerError, so partnerFailure answers with this status and code. As a
 * bare Error every runtime refusal (a 400 for a bad message, 503
 * runtime_unavailable) reached the partner as a generic upstream_unavailable.
 * Messages here are written for partners and never carry provider details.
 */
export class PartnerRuntimeError extends PartnerError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = "PartnerRuntimeError";
  }
}

interface RuntimeDependencies {
  grants: Reader;
  feed: Reader;
  settings: Reader;
  reply: typeof generateAgentReply;
  /** The model call under the reply; given the deadline below as its signal. */
  complete: typeof llmText;
  replyTimeoutMs: number;
  facts: typeof ledgerChatReply;
  session: typeof mintSession;
  hosted: () => boolean;
  now: () => number;
}

/** Less than this left of a request's budget and the status reply is given without asking the model. */
const MIN_MODEL_MS = 1_000;

const defaults: RuntimeDependencies = {
  // Lazy imports keep the adapter's pure tests independent of route startup and
  // preserve the existing single definitions of tenant/account/book scoping.
  grants: async (req) => (await import("../app/api/grants/route")).GET(req),
  feed: async (req) => (await import("../app/api/feed/route")).GET(req),
  settings: async (req) => (await import("../app/api/settings/route")).GET(req),
  reply: generateAgentReply,
  complete: llmText,
  replyTimeoutMs: 18_000,
  facts: ledgerChatReply,
  session: mintSession,
  hosted: isHostedMode,
  now: Date.now,
};

function epochMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function timestamp(value: string): number {
  // The feed's legacy wire format is explicitly UTC but carries no suffix.
  const n = Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isFinite(n) ? n : 0;
}

async function readJson<T>(reader: Reader, request: Request): Promise<T> {
  const response = await reader(request);
  if (!response.ok) throw new Error("state read unavailable");
  return await response.json() as T;
}

/** Dependency seam covers authorization scoping, provider failure and stale state. */
export function createPartnerRuntime(overrides: Partial<RuntimeDependencies> = {}) {
  const deps = { ...defaults, ...overrides };

  async function snapshot(tenant: Tenant) {
    if (!deps.hosted()) {
      throw new PartnerRuntimeError(503, "runtime_unavailable", "Partner agents require a hosted worker service.");
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(tenant)) {
      throw new PartnerRuntimeError(403, "invalid_connection", "The connection has no verified owner.");
    }
    let cookie: string;
    try {
      cookie = `${SESSION_COOKIE}=${encodeURIComponent(deps.session(tenant.toLowerCase() as Tenant))}`;
    } catch {
      throw new PartnerRuntimeError(503, "runtime_unavailable", "The agent service is not configured.");
    }
    const requestFor = (resource: string) => new Request(`https://app.merrymen.dev/api/${resource}`, {
      headers: { cookie },
    });
    const [grantRead, feedRead, settingsRead] = await Promise.allSettled([
      readJson<AgentStatus>(deps.grants, requestFor("grants")),
      readJson<FeedResponse>(deps.feed, requestFor("feed")),
      readJson<SettingsView>(deps.settings, requestFor("settings")),
    ]);
    if (grantRead.status !== "fulfilled") {
      throw new PartnerRuntimeError(503, "runtime_unavailable", "The agent's current permission could not be read.");
    }
    const grantStatus = grantRead.value;
    const feed = feedRead.status === "fulfilled" ? feedRead.value : null;
    const settings = settingsRead.status === "fulfilled" ? settingsRead.value : null;
    const setting = (key: string): unknown => {
      if (!settings) return null;
      return (settings.values as Record<string, unknown>)[key]
        ?? (settings.defaults as Record<string, unknown>)[key]
        ?? null;
    };
    const bool = (key: string) => typeof setting(key) === "boolean" ? setting(key) as boolean : null;
    const exists = grantStatus.exists === true && !!grantStatus.grant;
    const beat = exists ? epochMs(grantStatus.workerAliveAt) : null;
    const grantedAt = epochMs(grantStatus.grant?.grantedAt);
    const now = deps.now();
    // A tick may take time; three configured intervals are the grace window.
    // Never call an old or pre-renewal heartbeat proof of current operation.
    const tickSeconds = numberOrNull(setting("tickSeconds")) ?? 300;
    const grace = Math.max(90_000, Math.min(3600, Math.max(15, tickSeconds)) * 3000);
    const fresh = beat !== null && now - beat >= -60_000 && now - beat <= grace
      && (grantedAt === null || beat >= grantedAt);
    const mode = ["paper", "live", "idle"].includes(grantStatus.mode ?? "") ? grantStatus.mode! : null;
    const blocker = typeof grantStatus.liveBlocker === "string" ? grantStatus.liveBlocker : null;
    const runtime: PartnerRuntime = {
      exists,
      smart_account: exists ? grantStatus.grant!.smartAccount : null,
      name: typeof feed?.agent?.name === "string" ? feed.agent.name : "Your Merryman",
      slug: typeof feed?.agent?.slug === "string" ? feed.agent.slug : null,
      status: !exists ? "awaiting_grant" : beat === null || (grantedAt !== null && beat < grantedAt) ? "starting" : fresh ? "running" : "stale",
      mode: fresh ? mode : null,
      last_observed_mode: exists ? mode : null,
      worker_alive_at: beat,
      heartbeat_fresh: fresh,
      live_blocker: fresh ? blocker : null,
      last_observed_live_blocker: exists ? blocker : null,
      strategy: typeof setting("strategy") === "string" ? setting("strategy") as string : feed?.agent?.strategy ?? null,
      live_trading_enabled: bool("liveTradingEnabled"),
      paper_trading_enabled: bool("paperTradingEnabled"),
      ledger_available: exists && feed?.source !== "none" && feed !== null,
    };

    const book = exists && feed ? feed.equity.at(-1) : undefined;
    // Select fields explicitly. Neither grant key material, provider settings,
    // RPC URLs nor owner-supplied `state` can enter the model context.
    const positions = exists ? (feed?.positions ?? []).map((p) => {
      const value = numberOrNull(p.value_usdg);
      const cost = numberOrNull(p.cost_usdg);
      return {
        symbol: p.symbol,
        valueUsd: value,
        costUsd: cost,
        unrealisedPct: cost !== null && cost > 0 && value !== null ? Math.round((value / cost - 1) * 1000) / 10 : null,
        priceStale: Boolean(p.price_stale),
        stopLossBps: numberOrNull(p.stop_floor_bps),
        stopWhy: p.stop_floor_why ?? null,
      };
    }) : [];
    const trades = exists ? [...(feed?.trades ?? [])].sort((a, b) => timestamp(b.created_at) - timestamp(a.created_at)) : [];
    const moves = trades.slice(0, 8).reverse().map((trade) => ({
      at: trade.created_at,
      action: trade.fill_side ?? trade.kind,
      tradeId: trade.id ?? null,
      symbol: trade.symbol ?? null,
      displayName: trade.display_name ?? null,
      paper: trade.status === "paper",
      reason: trade.reason?.slice(0, 400) ?? null,
      sellToken: trade.sell_token,
      buyToken: trade.buy_token,
      sizeUsdg: numberOrNull(trade.amount_usdg),
      realizedPnlUsdg: trade.realized_vouched ? numberOrNull(trade.realized_pnl_usdg) : null,
      outcome: trade.status,
      outcomeText: trade.reject_rule,
    }));
    const state = {
      name: runtime.name,
      equity: numberOrNull(book?.equity_usdg),
      equityAt: book?.at ?? null,
      strategy: runtime.strategy,
      basketSymbols: Array.isArray(setting("basketSymbols")) ? setting("basketSymbols") : feed?.agent?.basket ?? null,
      liveTradingEnabled: runtime.live_trading_enabled,
      paperTradingEnabled: runtime.paper_trading_enabled,
      workerStatus: runtime.status,
      workerAliveAt: runtime.worker_alive_at,
      mode: runtime.mode,
      lastObservedMode: runtime.last_observed_mode,
      liveBlocker: runtime.live_blocker,
      lastObservedLiveBlocker: runtime.last_observed_live_blocker,
      ledgerAvailable: runtime.ledger_available,
      positions,
      positionsShown: positions.length,
      positionsTotal: positions.length,
      cashUsd: numberOrNull(book?.cash_usdg),
      vaultUsd: numberOrNull(book?.vault_usdg),
      stopLossBps: numberOrNull(setting("strategistStopLossBps")),
      takeProfitBps: numberOrNull(setting("takeProfitBps")),
      moves,
      movesShown: moves.length,
      movesTotal: trades.length,
      perTrade: exists ? numberOrNull(grantStatus.grant?.caps.perTradeUsdg) : null,
      perDay: exists ? numberOrNull(grantStatus.grant?.caps.dailyUsdg) : null,
      stopped: !fresh || (mode !== "live" && mode !== "paper"),
    };
    // A large book must retain its identity/status rather than become an empty
    // STATE when the shared prompt budget trims only trades. Drop complete
    // holdings, reporting how many remain, never slices of serialized JSON.
    let fitted = fitChatState(JSON.stringify(state));
    while (!fitted && state.positions.length) {
      state.positions.pop();
      state.positionsShown = state.positions.length;
      fitted = fitChatState(JSON.stringify({ ...state, truncated: true }));
    }
    if (!fitted) {
      throw new PartnerRuntimeError(503, "runtime_unavailable", "The agent's state could not be prepared for chat.");
    }
    return { runtime, state: fitted };
  }

  return {
    async readPartnerRuntime(tenant: Tenant): Promise<PartnerRuntime> {
      return (await snapshot(tenant)).runtime;
    },
    async replyToPartner(tenant: Tenant, input: { message: string; history?: unknown; deadline?: number }): Promise<{
      reply: string;
      command?: AgentReply["command"];
      generation: "model" | "status";
      runtime: PartnerRuntime;
    }> {
      if (typeof input.message !== "string" || !input.message.trim() || input.message.length > 2000) {
        throw new PartnerRuntimeError(400, "invalid_message", "Send a message between 1 and 2000 characters.");
      }
      const { runtime, state } = await snapshot(tenant);
      let answer: AgentReply;
      try {
        const body = { message: input.message, history: input.history, state };
        const factualReply = await deps.facts(body, runtime.smart_account, Math.floor(deps.now() / 1000));
        // A DEADLINE ON THE MODEL. This runs under the connection's conversation
        // lock, which holds one of a few pooled connections per replica for the
        // call's whole length, and the providers' own defaults run to minutes.
        // A stalled provider then blocked every other app's chats. The call gets
        // at most replyTimeoutMs, and never more than is left of the request's
        // `deadline` (its lock wait already spent part of it); past that it is
        // aborted and the partner gets the factual status below. Shorter than the
        // 20s a resend of the same request_id waits for the lock, so a transport
        // retry normally finds the saved reply rather than conversation_busy.
        const budget = (input.deadline ?? Infinity) - deps.now();
        if (budget < MIN_MODEL_MS) throw new Error("no time left for the model");
        const signal = AbortSignal.timeout(Math.min(deps.replyTimeoutMs, budget));
        answer = await deps.reply(body, { surface: "partner", factualReply,
          complete: (creds, request) => deps.complete(creds, { ...request, signal }) });
      } catch {
        answer = { reply: null, why: "llm-error" };
      }
      if (answer.reply?.trim()) {
        return { reply: answer.reply, ...(answer.command ? { command: answer.command } : {}), generation: "model", runtime };
      }
      // An unavailable model never becomes a successful empty chat message, nor
      // an upstream error (which could contain provider URLs or credentials).
      const status = runtime.status === "awaiting_grant"
        ? "I do not have a signed trading permission yet, so I cannot trade."
        : runtime.status === "starting"
          ? "My signed permission is saved, but I have not reported a heartbeat for it yet."
          : runtime.status === "stale"
            ? "My last heartbeat is old, so I cannot confirm that I am running right now."
            : runtime.mode === "paper"
              ? "My worker is running in paper mode with simulated funds."
              : runtime.mode === "live"
                ? "My worker recently reported live mode; that does not mean a trade has been placed."
                : "My worker has a recent heartbeat, but I am not reporting active paper or live trading.";
      const blocker = runtime.live_blocker ? ` My latest trading blocker is ${runtime.live_blocker}.` : "";
      return {
        reply: `My conversational service is temporarily unavailable. ${status}${blocker} I have not executed any action from this message.`,
        generation: "status",
        runtime,
      };
    },
  };
}

const runtime = createPartnerRuntime();
export const readPartnerRuntime = runtime.readPartnerRuntime;
export const replyToPartner = runtime.replyToPartner;
