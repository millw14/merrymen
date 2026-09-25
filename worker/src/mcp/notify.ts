/**
 * Durable alerts for MCP subscriptions: the rules a subscription must satisfy
 * (shared with the web tools) and the background pass the orchestrator runs to
 * turn subscriptions into Telegram messages.
 *
 * WHY THIS IS NOT THE CHILD'S NOTIFIER. The notifier keeps its cursor and its
 * dedupe stamps in the child's telegram.json, which a hosted redeploy wipes,
 * and it advances both whether or not the send worked. Here every step is a
 * row in shared Postgres: a subscription carries its own cursor, a delivery is
 * keyed by a UNIQUE dedupe_key (INSERT … ON CONFLICT DO NOTHING), so a
 * restart, a second replica or a lost cursor can re-evaluate the same ledger
 * rows and still queue one message. Delivery is a separate step with a retry
 * budget and a visible outcome the owner can read back through MCP.
 *
 * THE ONLY RECIPIENT IS THE OWNER'S OWN LINKED CHAT, through the owner's own
 * bot, and only while the owner has Telegram and its alerts switched on. A
 * subscription never overrides that: a delivery for an owner who is unlinked or
 * switched off is recorded as skipped, not sent.
 *
 * AUTHORITY IS RESOLVED HERE, NOT READ FROM THE ROW. The subscription stores an
 * agent slug; each pass maps it back through agent_identity and grants and
 * requires the identity's tenant to be the subscription's tenant. Stored params
 * are re-validated before use.
 *
 * AND ONLY WHILE AN APP CAN STILL MANAGE IT. Subscriptions are listed and
 * removed only through a connected app; Merrymen has no page for them. So a
 * subscription is evaluated only while its owner has an active connection that
 * holds notifications:manage. Disconnecting every such app stops new alerts
 * (anything already queued still goes out); reconnecting one resumes them.
 *
 * Tokens and chat ids exist only inside deps.send: they are never logged,
 * never stored, never put in a message or an error code.
 */
import { randomBytes } from "node:crypto";
import { getAddress, isAddress } from "viem";
import type { Db } from "../db";
import { STOCK_TOKENS } from "../../../packages/core/src/tokens";
import { esc, sendMessage, type FetchLike } from "../telegram/api";
import { readTenantTelegram } from "../telegram-store";
import { getSettingsStore } from "../settings-store";

// ── kinds and their parameters ─────────────────────────────────────────────

export const NOTIFY_KINDS = [
  "trade_confirmed",
  "risk_halt",
  "provider_failure",
  "stale_data",
  "inactivity",
  "watchlist_price",
  "summary",
] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/** Kinds that are about one agent's books, and so need an agent to resolve. */
export const AGENT_KINDS: ReadonlySet<NotifyKind> = new Set([
  "trade_confirmed", "risk_halt", "provider_failure", "stale_data", "inactivity", "summary",
]);

export const MAX_ACTIVE_SUBSCRIPTIONS = 20;
/** Waits after the 1st…4th failed attempt; the 5th failure is final. */
export const RETRY_BACKOFF_SEC = [60, 300, 1800, 7200] as const;
export const MAX_ATTEMPTS = 5;
/** The window the "at most one per …" kinds are counted in. */
export const ALERT_WINDOW_SEC = 6 * 3600;

const SUBS_PER_PASS = 50;
const DELIVERIES_PER_PASS = 50;
/** A subscription is looked at no more often than this; the reconcile loop runs every 15 s. */
const MIN_EVAL_GAP_SEC = 60;
/** How long a claimed ('sending') delivery may stay claimed before it is written off. */
const SENDING_LEASE_SEC = 600;
/** A trade still unresolved after this long is no longer waited for. */
const PENDING_TRADE_MAX_AGE_SEC = 86_400;
/**
 * A landed trade older than this when first seen is history, not news. Well
 * inside the 90-day retention of delivery rows (maintenance.ts), so a cursor
 * lost after the dedupe row was pruned cannot re-announce an old trade.
 */
const TRADE_MAX_AGE_SEC = 7 * 86_400;
const MAX_PENDING_TRADES = 20;
const TRADES_PER_EVAL = 20;
const EVENTS_PER_SCAN = 200;
/** An event this old when first seen (mirror lag, an outage) is history, not an alert. */
const EVENT_MAX_AGE_SEC = 86_400;
/** A price older than this is a dead feed; stock feeds legitimately pause for a weekend. */
const PRICE_MAX_AGE_SEC = 7 * 86_400;
/** Leaving a price zone needs this much room, so a price sitting on the line does not flap. */
const PRICE_HYSTERESIS = 0.005;
const PRICE_ALERT_COOLDOWN_SEC = 3600;
/** One Chainlink read may not hold the pass longer than this (viem's own retries can run far longer). */
const PRICE_READ_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_MS = 8_000;
/** How long an owner's queue waits after their chat or settings could not be read. */
const RECIPIENT_RETRY_SEC = 120;
/**
 * A message still unsent this long after it was queued is dropped as expired:
 * a trade or kill alert arriving days late (after an outage) reads as news it
 * is not. The retry schedule itself spans under three hours.
 */
export const QUEUE_MAX_AGE_SEC = 86_400;
/**
 * The consent scope (web/src/mcp/scopes.ts) that lets a connected app manage
 * alerts. A subscription is only evaluated while its owner still has an active
 * connection holding it: alerts can only be seen and removed through a
 * connected app, so once the owner has disconnected every such app nothing new
 * is queued. Reconnecting one resumes them.
 */
export const NOTIFY_SCOPE = "notifications:manage";

export type NotifyParams = Record<string, string | number>;
export type ParamsVerdict =
  | { ok: true; params: NotifyParams }
  | { ok: false; code: "invalid_input" | "unsupported"; message: string };

const ALLOWED_PARAMS: Record<NotifyKind, readonly string[]> = {
  trade_confirmed: [],
  risk_halt: [],
  provider_failure: [],
  stale_data: [],
  inactivity: ["hours"],
  watchlist_price: ["token", "above", "below"],
  summary: ["period", "hour_utc"],
};

export function isNotifyKind(kind: unknown): kind is NotifyKind {
  return typeof kind === "string" && (NOTIFY_KINDS as readonly string[]).includes(kind);
}

/**
 * The tokens a price alert can watch: registry tokens that publish a Chainlink
 * USD feed. Anything else would have to be priced off a pool, which is exactly
 * the price a thin launchpad pool can be pushed to — an alert on it would
 * report whatever the last trader wanted it to.
 */
export function feedToken(token: string): { symbol: string; address: `0x${string}`; feed: `0x${string}` } | null {
  const t = token.toLowerCase();
  const hit = STOCK_TOKENS.find((s) => s.address.toLowerCase() === t);
  return hit?.chainlinkFeed ? { symbol: hit.symbol, address: hit.address, feed: hit.chainlinkFeed } : null;
}

const finitePositive = (v: unknown, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= max;

/**
 * Validate and canonicalise a subscription's params. Used by the subscribe tool
 * and again by the pass on every stored row, so a row edited or written by an
 * older version is never trusted as it stands. Keys come back in a fixed order,
 * which is what makes "identical params" comparable as JSON.
 */
export function normalizeNotifyParams(kind: unknown, raw: unknown): ParamsVerdict {
  if (!isNotifyKind(kind)) return { ok: false, code: "invalid_input", message: `kind must be one of ${NOTIFY_KINDS.join(", ")}` };
  const src = raw === undefined || raw === null ? {} : raw;
  if (typeof src !== "object" || Array.isArray(src)) return { ok: false, code: "invalid_input", message: "params must be an object" };
  const p = src as Record<string, unknown>;
  const extra = Object.keys(p).filter((k) => p[k] !== undefined && !ALLOWED_PARAMS[kind].includes(k));
  if (extra.length) {
    const takes = ALLOWED_PARAMS[kind].length ? `only ${ALLOWED_PARAMS[kind].join(", ")}` : "no params";
    return { ok: false, code: "invalid_input", message: `${kind} takes ${takes}; "${extra[0]!.slice(0, 32)}" is not one of them` };
  }
  switch (kind) {
    case "inactivity": {
      const h = p.hours;
      if (typeof h !== "number" || !Number.isInteger(h) || h < 6 || h > 168) {
        return { ok: false, code: "invalid_input", message: "inactivity needs params.hours, a whole number from 6 to 168" };
      }
      return { ok: true, params: { hours: h } };
    }
    case "watchlist_price": {
      const token = typeof p.token === "string" ? p.token : "";
      if (!/^0x[0-9a-fA-F]{40}$/.test(token)) return { ok: false, code: "invalid_input", message: "watchlist_price needs params.token, a 0x token address" };
      const feed = feedToken(token);
      if (!feed) {
        return {
          ok: false, code: "unsupported",
          message: "Price alerts are only available for stock tokens with a Chainlink price feed. This token has none, and a pool price is too easy to move to alert on.",
        };
      }
      const above = p.above;
      const below = p.below;
      if (above !== undefined && !finitePositive(above, 1e9)) return { ok: false, code: "invalid_input", message: "params.above must be a positive USD price" };
      if (below !== undefined && !finitePositive(below, 1e9)) return { ok: false, code: "invalid_input", message: "params.below must be a positive USD price" };
      if (above === undefined && below === undefined) return { ok: false, code: "invalid_input", message: "watchlist_price needs params.above, params.below or both" };
      if (typeof above === "number" && typeof below === "number" && below >= above) {
        return { ok: false, code: "invalid_input", message: "params.below must be lower than params.above" };
      }
      const out: NotifyParams = { token: feed.address.toLowerCase() };
      if (typeof above === "number") out.above = above;
      if (typeof below === "number") out.below = below;
      return { ok: true, params: out };
    }
    case "summary": {
      const period = p.period;
      const hour = p.hour_utc;
      if (period !== "day" && period !== "week") return { ok: false, code: "invalid_input", message: "summary needs params.period: day or week" };
      if (typeof hour !== "number" || !Number.isInteger(hour) || hour < 0 || hour > 23) {
        return { ok: false, code: "invalid_input", message: "summary needs params.hour_utc, a whole hour from 0 to 23" };
      }
      return { ok: true, params: { period, hour_utc: hour } };
    }
    default:
      return { ok: true, params: {} };
  }
}

/** Canonical JSON (sorted keys) — the form params are stored and compared in. */
export function canonicalParams(params: NotifyParams): string {
  const sorted: NotifyParams = {};
  for (const k of Object.keys(params).sort()) sorted[k] = params[k]!;
  return JSON.stringify(sorted);
}

/** One plain sentence saying what a subscription will send. */
export function describeSubscription(kind: NotifyKind, params: NotifyParams): string {
  switch (kind) {
    case "trade_confirmed": return "A message for each live trade confirmed on chain (with its transaction).";
    case "risk_halt": return "A message when the kill switch is used or the drawdown breaker trips (a tripped breaker at most once every 6 hours).";
    case "provider_failure": return "A message when market data, the decision service or the AI model provider fails (at most once every 6 hours).";
    case "stale_data": return "A message when a running agent stops reporting a heartbeat (at most once every 6 hours).";
    case "inactivity": return `A message when there has been no live or paper fill for ${params.hours} hours (once per ${params.hours}-hour stretch).`;
    case "watchlist_price": {
      const f = feedToken(String(params.token ?? ""));
      const parts = [params.above !== undefined ? `rises to ${params.above} USD or above` : null, params.below !== undefined ? `falls to ${params.below} USD or below` : null].filter(Boolean);
      return `A message when ${f?.symbol ?? "the token"} (Chainlink price) ${parts.join(" or ")}.`;
    }
    case "summary":
      return params.period === "week"
        ? `A weekly summary every Monday at ${String(params.hour_utc).padStart(2, "0")}:00 UTC, live and paper books reported separately.`
        : `A daily summary at ${String(params.hour_utc).padStart(2, "0")}:00 UTC, live and paper books reported separately.`;
  }
}

/** What a delivery's last_error_code means, for the owner. */
export const DELIVERY_ERROR_TEXT: Record<string, string> = {
  no_linked_telegram: "No Telegram chat is linked (or no bot is set up), so there was nowhere to send it.",
  owner_disabled: "Telegram, or its alerts, are switched off in Settings, so it was not sent.",
  unsubscribed: "The subscription was removed before it was sent.",
  rate_limited: "Telegram asked us to slow down; it is retried after the delay Telegram gave.",
  bot_blocked: "The bot is blocked in the chat (or was removed from it).",
  chat_not_found: "Telegram does not know the linked chat any more. Link it again with /link.",
  bot_token_rejected: "Telegram rejected the bot token. Check the bot in Settings.",
  network: "Telegram could not be reached.",
  send_failed: "Telegram refused the message.",
  interrupted: "The sender stopped while this was being sent. It is not retried, so it cannot arrive twice; it may or may not have arrived.",
  bad_payload: "The stored message could not be read.",
  expired: "It could not be sent within a day of being queued, so it was dropped rather than arrive as stale news.",
};

/** Map a sender's failure to a stable code. The raw reason is never stored: it can carry provider text. */
export function sendErrorCode(r: { reason?: string; retryAfterSec?: number }): string {
  const reason = r.reason ?? "";
  if (typeof r.retryAfterSec === "number" || /too many requests|retry after|\b429\b/i.test(reason)) return "rate_limited";
  if (/blocked by the user|user is deactivated|bot was kicked|not a member/i.test(reason)) return "bot_blocked";
  if (/chat not found/i.test(reason)) return "chat_not_found";
  if (/unauthorized|\b401\b|^not found$|\b404\b/i.test(reason)) return "bot_token_rejected";
  if (/request failed|timeout|timed out|abort|HTTP 5\d\d|ECONN|network|fetch failed/i.test(reason)) return "network";
  return "send_failed";
}

// ── the pass ───────────────────────────────────────────────────────────────

export interface NotifyRecipient {
  botToken: string;
  chatId: number;
  /** False when the owner switched Telegram, or its alerts, off. Never overridden. */
  enabled: boolean;
}

export interface SendResult {
  ok: boolean;
  reason?: string;
  /** Telegram's 429 retry_after, when it gave one. */
  retryAfterSec?: number;
}

export interface PriceReading {
  priceUsd: number;
  /** Unix seconds of the feed's last update. */
  updatedAt: number;
}

export type PriceReader = (token: `0x${string}`) => Promise<PriceReading | null>;

export interface NotifyDeps {
  /** Unix seconds. */
  now(): number;
  send(token: string, chatId: number, text: string): Promise<SendResult>;
  /** Null when the owner has no linked chat or no bot to send through. */
  recipient(tenant: string): Promise<NotifyRecipient | null>;
  /** Chainlink reads for watchlist_price. Absent: those subscriptions are not evaluated this pass. */
  price?: PriceReader;
  /** Per-read cut-off for `price`, ms (default 5 s); a read that has not answered by then is no price. */
  priceTimeoutMs?: number;
  /** The tenant's tick, for the heartbeat threshold. Absent or null: stale_data is not evaluated. */
  tickSeconds?(tenant: string): Promise<number | null>;
  /** Wall-clock budget for one pass, ms. */
  maxMs?: number;
  /** Receives counts and codes only. */
  log?(line: string): void;
}

export interface NotifyPassSummary {
  evaluated: number;
  queued: number;
  unresolved: number;
  invalid: number;
  sent: number;
  retried: number;
  dead: number;
  skipped: number;
  interrupted: number;
  /** Queued messages dropped because they could not be sent within QUEUE_MAX_AGE_SEC. */
  expired: number;
  deferred: number;
  failed: number;
  warnings: string[];
  error: string | null;
  ms: number;
}

interface SubRow {
  id: string;
  tenant: string;
  agent_slug: string | null;
  kind: string;
  params_json: string;
  cursor_json: string | null;
  created_at: number;
  last_evaluated_at: number | null;
}

interface Candidate {
  key: string;
  text: string;
  book: "live" | "paper" | "separate" | "unknown" | "none";
}

interface Evaluation {
  candidates: Candidate[];
  /** The new cursor, or null when unchanged. */
  cursor: Record<string, unknown> | null;
}

interface AgentScope {
  slug: string;
  /** Every spelling of every account this identity has held (lowercase, EIP-55, as stored): index-friendly IN lists. */
  ids: string[];
  /** Spellings of the current account only. */
  currentIds: string[];
  hasCurrent: boolean;
  name: string;
  status: string | null;
  mode: string | null;
  beatAt: number | null;
  expiresAt: number | null;
}

interface PassState {
  deps: NotifyDeps;
  out: NotifyPassSummary;
  scopes: Map<string, Promise<AgentScope | null>>;
  ticks: Map<string, Promise<number | null>>;
  /** One Chainlink read per token per pass, however many subscriptions watch it. */
  prices: Map<string, Promise<PriceReading | null>>;
  warned: Set<string>;
}

/** Resolves null (never rejects) when `p` has not settled within `ms`. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const newId = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;
const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

function warnOnce(s: PassState, code: string): void {
  if (s.warned.has(code)) return;
  s.warned.add(code);
  s.out.warnings.push(code);
}

function parseJson(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * One line of text a stranger may have written (a coin's symbol, an agent's
 * name), made safe to print: whitespace of any kind (tabs, newlines, the line
 * and paragraph separators U+2028/U+2029, no-break spaces) becomes one space,
 * and every other control or format character is dropped by Unicode category:
 * Cc (C0, DEL and the C1 range, so a terminal-style CSI U+009B or NEL U+0085
 * cannot pass), Cf (bidi marks, embeddings and isolates including U+061C, the
 * zero-width characters, BOM, soft hyphen) and Cs (a lone surrogate, which is
 * not text). Written with property classes: a literal invisible character in
 * this source would be invisible in review too. The length cap counts code
 * points, so an emoji at the cut is not split into half a surrogate pair.
 */
export function plain(text: string | null | undefined, max: number): string | null {
  if (typeof text !== "string") return null;
  const clean = text
    .replace(/[\p{Cf}\p{Cs}]/gu, "") // format characters first: a BOM counts as whitespace to \s, but it is not a space
    .replace(/\s+/gu, " ")
    .replace(/\p{Cc}/gu, "") // what is left of C0, DEL and C1 is not whitespace
    .replace(/ {2,}/g, " ")
    .trim();
  if (!clean) return null;
  const points = Array.from(clean);
  return points.length > max ? `${points.slice(0, max).join("")}…` : clean;
}

const usd = (n: number) => n.toFixed(2);
const signed = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}`;
const utc = (sec: number) => `${new Date(sec * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;

function bookTag(mode: string | null): string {
  if (mode === "live") return "LIVE";
  if (mode === "paper") return "PAPER (practice, no real money)";
  return "book unknown";
}
const bookOf = (mode: string | null): Candidate["book"] => (mode === "live" ? "live" : mode === "paper" ? "paper" : "unknown");

function spellings(account: string): string[] {
  const lower = account.toLowerCase();
  const out = new Set([account, lower]);
  if (isAddress(lower, { strict: false })) out.add(getAddress(lower));
  return [...out];
}

/**
 * The agent a subscription is about, resolved from the shared tables — never
 * from the subscription's own params. Null when the slug is unknown or no
 * longer the subscription owner's.
 */
async function resolveAgent(shared: Db, tenant: string, slug: string): Promise<AgentScope | null> {
  const identity = (await shared.prepare("SELECT tenant, accounts FROM agent_identity WHERE slug = ?").get(slug)) as
    | { tenant: string; accounts: unknown }
    | undefined;
  if (!identity || String(identity.tenant).toLowerCase() !== tenant) return null;
  const grant = (await shared
    .prepare("SELECT grant_json->>'smartAccount' AS smart_account FROM grants WHERE tenant = ?")
    .get(tenant)) as { smart_account: string | null } | undefined;
  let history: unknown = identity.accounts;
  if (typeof history === "string") {
    try {
      history = JSON.parse(history);
    } catch {
      history = [];
    }
  }
  const addr = (v: unknown) => (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : null);
  const current = addr(grant?.smart_account);
  const accounts = [current, ...(Array.isArray(history) ? history.map(addr) : [])].filter((a): a is string => !!a).slice(0, 16);
  const ids = [...new Set(accounts.flatMap(spellings))];
  const currentIds = current ? spellings(current) : [];
  let row: { name: string | null; status: string | null; mode: string | null; beat_at: unknown; expires_at: unknown } | undefined;
  if (currentIds.length) {
    row = (await shared
      .prepare(`SELECT name, status, mode, beat_at, expires_at FROM agents WHERE smart_account IN (${placeholders(currentIds.length)}) LIMIT 1`)
      .get(...currentIds)) as typeof row;
  }
  return {
    slug,
    ids,
    currentIds,
    hasCurrent: !!current,
    name: plain(row?.name, 24) ?? "Your agent",
    status: row?.status ?? null,
    mode: row?.mode ?? null,
    beatAt: num(row?.beat_at),
    expiresAt: num(row?.expires_at),
  };
}

function scopeFor(shared: Db, s: PassState, tenant: string, slug: string): Promise<AgentScope | null> {
  const key = `${tenant}|${slug}`;
  let p = s.scopes.get(key);
  if (!p) {
    p = resolveAgent(shared, tenant, slug);
    s.scopes.set(key, p);
  }
  return p;
}

// ── evaluators ─────────────────────────────────────────────────────────────

interface TradeRow {
  id: number;
  agent_id: string;
  status: string;
  kind: string | null;
  tx_hash: string | null;
  user_op_hash: string | null;
  sell_token: string | null;
  fill_side: string | null;
  fill_symbol: string | null;
  fill_cash_usdg: number | null;
  amount_usdg: number | null;
  realized_pnl_usdg: number | null;
  basis_source: string | null;
  created_at: number;
}

const TX = /^0x[0-9a-fA-F]{64}$/;

// ── one row per operation, and which sells are measured ───────────────────
//
// The worker may not import web code, so the few ledger-reading rules the web
// already states are restated here, each naming the web function it mirrors.
// notify.test.ts pins the same behaviour; a change to one side needs the other.

/** A fill of a market position (web/src/lib/services/decisions.ts FILL_KINDS): a transfer or a vault move is not one. */
export const FILL_KINDS = ["swap", "curve-trade"] as const;
const FILL_KINDS_SQL = FILL_KINDS.map((k) => `'${k}'`).join(", ");

/** How much younger than its operation a re-recorded copy can be (web/src/lib/distinct-trades.ts OP_COPY_REACH_SEC). */
export const OP_COPY_REACH_SEC = 7 * 86_400;

/**
 * `trades`, one row per operation, as a derived table named `t` — the same SQL
 * as web/src/lib/distinct-trades.ts distinctTrades. A redeploy re-records old
 * operations as bare 'swap' rows (no decision, no fill side) stamped at the
 * restart; without this a copy reads as a fresh fill, and a vault deposit's
 * copy reads as a trade. The copy that speaks for the operation: one that knows
 * the outcome, then one with fill evidence, then one linked to its decision,
 * then the earliest. `where` scopes BEFORE the collapse and should hold only an
 * account and time scope; status and kind filters go outside it, and a time
 * scope must reach OP_COPY_REACH_SEC past the window the caller reports on.
 */
function distinctTrades(where: string): string {
  return `(WITH scoped AS (SELECT * FROM trades t WHERE ${where})
    SELECT * FROM (
      SELECT s.*, ROW_NUMBER() OVER (
        PARTITION BY lower(s.agent_id), lower(s.user_op_hash)
        ORDER BY (s.status = 'submitted'), (s.fill_side IS NULL), (s.decision_id IS NULL), s.created_at, s.id
      ) AS op_rank
      FROM scoped s WHERE s.user_op_hash IS NOT NULL AND s.user_op_hash <> ''
    ) ranked WHERE ranked.op_rank = 1
    UNION ALL
    SELECT s.*, 1 AS op_rank FROM scoped s WHERE s.user_op_hash IS NULL OR s.user_op_hash = '') t`;
}

/** An operation's key (web/src/lib/profile-trades.ts OP_KEY), as SQL over `t` and for one row in hand. */
const OP_KEY_SQL = "COALESCE(LOWER(NULLIF(t.user_op_hash, '')), 'row:' || CAST(t.id AS TEXT))";
const opKeyOf = (t: { id: number; user_op_hash: string | null }) =>
  typeof t.user_op_hash === "string" && t.user_op_hash !== "" ? t.user_op_hash.toLowerCase() : `row:${Number(t.id)}`;

/** One basis-moving fill as the replay reads it (web/src/lib/profile-trades.ts BasisReplayFill). */
export interface BasisReplayFill {
  op: string;
  side: "buy" | "sell" | null;
  token: string;
  qty: string | null;
  source: string | null;
}

const EVIDENCED_SOURCES: ReadonlySet<string> = new Set(["receipt", "paper"]);

/**
 * WHICH SELLS REALIZED AGAINST A COST NOTHING ESTIMATED — the same replay as
 * web/src/lib/profile-trades.ts vouchedSells. A sell's realized_pnl_usdg is its
 * proceeds minus the running cost of every buy since the coin was last flat,
 * and a buy whose receipt could not be read booked that cost from the quote
 * (basis_source 'quote'). So the sell's own basis_source says nothing about the
 * cost side. A sell is vouched for when no buy still in the basis it sold
 * against was anything but a receipt or a paper fill; a row that moved the coin
 * without a side or quantity means flat can no longer be told, and a read cut
 * short (`complete` false) vouches for nothing. `fills` oldest first.
 */
export function vouchedSells(fills: readonly BasisReplayFill[], complete: boolean): Set<string> {
  const vouched = new Set<string>();
  if (!complete) return vouched;
  const state = new Map<string, { held: bigint; estimated: boolean; exact: boolean }>();
  for (const f of fills) {
    const s = state.get(f.token) ?? { held: 0n, estimated: false, exact: true };
    state.set(f.token, s);
    const qty = f.qty !== null && /^\d+$/.test(f.qty.trim()) ? BigInt(f.qty.trim()) : null;
    if (f.side === "sell" && !s.estimated) vouched.add(f.op);
    if (f.side === null || qty === null) {
      s.exact = false;
      if (f.side !== "sell" && !EVIDENCED_SOURCES.has(f.source ?? "")) s.estimated = true;
      continue;
    }
    if (f.side === "buy") {
      s.held += qty;
      if (!EVIDENCED_SOURCES.has(f.source ?? "")) s.estimated = true;
      continue;
    }
    s.held -= qty < s.held ? qty : s.held;
    if (s.exact && s.held === 0n) s.estimated = false;
  }
  return vouched;
}

/** Rows one coin's replay reads before it vouches for nothing (web/src/lib/profile-trades.ts BASIS_REPLAY_ROWS). */
const BASIS_REPLAY_ROWS = 5_000;

/**
 * The LIVE sells, of those asked about, whose realised P&L is a measurement:
 * proceeds read from the sell's own receipt AND a cost vouchedSells can replay
 * with no estimate in it — web/src/lib/profile-trades.ts readEvidencedSells, run
 * per account the way web/src/lib/services/portfolio.ts markMeasured runs it.
 * The replay matches `agent_id = ?` exactly, so it needs the one spelling the
 * account's rows carry; an account written under two spellings would replay as
 * two partial tapes, and vouches for nothing (portfolio.ts readTradeSpelling —
 * here over the three spellings this pass reads every account under, which the
 * trades index can serve). Returns op keys (opKeyOf). NEVER THROWS: a replay
 * that cannot be read vouches for nothing, and nothing is printed as measured.
 */
async function evidencedLiveSells(shared: Db, sells: readonly TradeRow[]): Promise<Set<string>> {
  const out = new Set<string>();
  const byAccount = new Map<string, TradeRow[]>();
  for (const t of sells) {
    const token = typeof t.sell_token === "string" ? t.sell_token.toLowerCase() : "";
    if (!token || typeof t.agent_id !== "string") continue;
    const key = t.agent_id.toLowerCase();
    byAccount.set(key, [...(byAccount.get(key) ?? []), t]);
  }
  for (const [account, rows] of byAccount) {
    try {
      const names = spellings(account);
      const held = (await shared.prepare(`SELECT DISTINCT agent_id FROM trades WHERE agent_id IN (${placeholders(names.length)}) LIMIT 3`)
        .all(...names)) as Array<{ agent_id: string }>;
      if (held.length !== 1) continue;
      const tokens = [...new Set(rows.map((t) => String(t.sell_token).toLowerCase()))];
      const replayed = (await shared
        .prepare(`SELECT r.op, r.fill_side, r.fill_qty_raw, r.basis_source, r.coin
           FROM (
             SELECT l.*, ROW_NUMBER() OVER (PARTITION BY l.coin ORDER BY l.created_at DESC, l.id DESC) AS coin_rank
               FROM (
                 SELECT ${OP_KEY_SQL} AS op, t.fill_side, t.fill_qty_raw, t.basis_source, t.created_at, t.id,
                        CASE WHEN leg.side = 'buy' THEN LOWER(t.buy_token) ELSE LOWER(t.sell_token) END AS coin
                   FROM ${distinctTrades("t.agent_id = ? AND (t.user_op_hash IS NOT NULL OR t.fill_side IS NOT NULL OR t.basis_source IS NOT NULL)")}
                  CROSS JOIN (SELECT 'buy' AS side UNION ALL SELECT 'sell' AS side) leg
                  WHERE t.status = 'landed'
                    AND (t.fill_side IN ('buy','sell') OR t.basis_source IS NOT NULL)
                    AND (t.fill_side IS NULL OR t.fill_side NOT IN ('buy','sell') OR t.fill_side = leg.side)
               ) l
              WHERE l.coin IN (${placeholders(tokens.length)})
           ) r
          WHERE r.coin_rank <= ?
          ORDER BY r.created_at ASC, r.id ASC`)
        .all(String(held[0]!.agent_id), ...tokens, BASIS_REPLAY_ROWS + 1)) as Array<Record<string, unknown>>;
      const byCoin = new Map<string, BasisReplayFill[]>();
      const sellSource = new Map<string, string | null>();
      for (const r of replayed) {
        const coin = typeof r.coin === "string" ? r.coin : "";
        if (!coin) continue;
        const op = String(r.op);
        const side = r.fill_side === "buy" || r.fill_side === "sell" ? r.fill_side : null;
        const source = typeof r.basis_source === "string" ? r.basis_source : null;
        const qty = side === null || r.fill_qty_raw === null || r.fill_qty_raw === undefined ? null : String(r.fill_qty_raw);
        if (side === "sell") sellSource.set(op, source);
        byCoin.set(coin, [...(byCoin.get(coin) ?? []), { op, side, token: coin, qty, source }]);
      }
      const vouched = new Set<string>();
      for (const fills of byCoin.values()) {
        for (const op of vouchedSells(fills, fills.length <= BASIS_REPLAY_ROWS)) vouched.add(op);
      }
      for (const t of rows) {
        const op = opKeyOf(t);
        if (vouched.has(op) && sellSource.get(op) === "receipt") out.add(op);
      }
    } catch {
      /* unreplayable: nothing from this account is printed as measured */
    }
  }
  return out;
}

/**
 * What a confirmed trade's message may say about money, and no more than the
 * ledger evidences. The cash leg is stated as a fact only when it was read from
 * the receipt; a leg booked from the pre-trade quote is an estimate and says
 * so, and a row with no filled amount at all states its ORDER size as that.
 * A realised P&L is stated only for a sell `measured` vouches for; otherwise it
 * is left out and the message says why.
 */
function tradeText(scope: AgentScope, t: TradeRow, measured: boolean): string {
  const symbol = plain(t.fill_symbol, 16) ?? "a token";
  const fill = num(t.fill_cash_usdg);
  const order = num(t.amount_usdg);
  const fromReceipt = fill !== null && t.basis_source === "receipt";
  const side = t.fill_side === "buy" ? "Bought" : t.fill_side === "sell" ? "Sold" : null;
  let money = "";
  if (side) {
    if (fromReceipt) money = ` for ${usd(Math.abs(fill))} USDG`;
    else if (fill !== null) money = ` for about ${usd(Math.abs(fill))} USDG (estimated from the quote: the receipt could not be read)`;
    else if (order !== null) money = ` (order size ${usd(Math.abs(order))} USDG; the filled amount is not recorded)`;
  } else {
    if (fromReceipt) money = ` (${usd(Math.abs(fill))} USDG)`;
    else if (fill !== null) money = ` (about ${usd(Math.abs(fill))} USDG, estimated)`;
    else if (order !== null) money = ` (${usd(Math.abs(order))} USDG requested)`;
  }
  const what = side ? `${side} ${symbol}${money}.` : `A ${plain(t.kind, 24) ?? "trade"} landed${money}.`;
  const pnl = num(t.realized_pnl_usdg);
  let realized = "";
  if (t.fill_side === "sell" && pnl !== null) {
    realized = measured
      ? ` Realised P&L ${signed(pnl)} USDG.`
      : " Realised P&L is not stated: part of the cost it sold against, or its proceeds, was estimated rather than read from a receipt.";
  }
  return `${scope.name} · LIVE\n${what}${realized}\nConfirmed on chain: ${t.tx_hash}`;
}

/**
 * Live trades that landed with a transaction. Trades are resolved IN PLACE
 * (a 'submitted' row later becomes 'landed' and gains its tx hash), so a plain
 * id cursor would skip every trade that was still in flight when it passed.
 * The cursor keeps a scan watermark plus the few ids still pending, and
 * re-checks those; the dedupe key is the transaction, so a re-recorded copy
 * of the same operation cannot notify twice.
 */
async function evalTrades(shared: Db, sub: SubRow, scope: AgentScope, cursor: Record<string, unknown>, now: number): Promise<Evaluation> {
  if (!scope.ids.length) return { candidates: [], cursor: null };
  const after = num(cursor.t) ?? 0;
  const pendingIn = Array.isArray(cursor.p) ? cursor.p.map(num).filter((n): n is number => n !== null).slice(-MAX_PENDING_TRADES) : [];
  const cols = "id, agent_id, status, kind, tx_hash, user_op_hash, sell_token, fill_side, fill_symbol, fill_cash_usdg, amount_usdg, realized_pnl_usdg, basis_source, created_at";
  const idsIn = placeholders(scope.ids.length);
  const recheck = pendingIn.length
    ? ((await shared.prepare(`SELECT ${cols} FROM trades WHERE id IN (${placeholders(pendingIn.length)}) AND agent_id IN (${idsIn})`)
      .all(...pendingIn, ...scope.ids)) as TradeRow[])
    : [];
  const scan = (await shared
    .prepare(`SELECT ${cols} FROM trades WHERE agent_id IN (${idsIn}) AND id > ? AND created_at >= ? ORDER BY id ASC LIMIT ?`)
    .all(...scope.ids, after, sub.created_at, 100)) as TradeRow[];

  const emitted: Array<{ key: string; row: TradeRow }> = [];
  const pending = new Set<number>();
  const seen = new Set<string>();
  const consider = (t: TradeRow): "emit" | "pending" | "done" => {
    const tx = typeof t.tx_hash === "string" && TX.test(t.tx_hash) ? t.tx_hash.toLowerCase() : null;
    if (t.status === "landed" && tx) return now - Number(t.created_at) <= TRADE_MAX_AGE_SEC ? "emit" : "done";
    const inFlight = t.status === "submitted" || t.status === "landed";
    return inFlight && now - Number(t.created_at) < PENDING_TRADE_MAX_AGE_SEC ? "pending" : "done";
  };
  const emit = (t: TradeRow) => {
    const tx = t.tx_hash!.toLowerCase();
    if (seen.has(tx)) return;
    seen.add(tx);
    emitted.push({ key: `trade_confirmed:${sub.id}:${tx}`, row: t });
  };
  for (const t of recheck) {
    const v = consider(t);
    if (v === "emit") emit(t);
    else if (v === "pending") pending.add(Number(t.id));
  }
  let watermark = after;
  for (const t of scan) {
    if (emitted.length >= TRADES_PER_EVAL) break; // the rest next pass: the watermark stops here
    const v = consider(t);
    if (v === "emit") emit(t);
    else if (v === "pending") pending.add(Number(t.id));
    watermark = Math.max(watermark, Number(t.id));
  }
  // Only the sells whose realised P&L the message would state need the replay.
  const measured = await evidencedLiveSells(shared, emitted
    .map((e) => e.row)
    .filter((t) => t.fill_side === "sell" && num(t.realized_pnl_usdg) !== null && t.basis_source === "receipt"));
  const candidates: Candidate[] = emitted.map((e) => ({ key: e.key, text: tradeText(scope, e.row, measured.has(opKeyOf(e.row))), book: "live" }));
  const p = [...pending].sort((a, b) => a - b).slice(-MAX_PENDING_TRADES);
  const changed = watermark !== after || p.join(",") !== pendingIn.join(",");
  return { candidates, cursor: changed ? { ...cursor, t: watermark, p } : null };
}

const EARLIER = ". Also from earlier: ";
/** The line an event leads with — a restated warn can carry an older one after it, which is not news. */
const headOf = (message: string) => {
  const i = message.indexOf(EARLIER);
  return i >= 0 ? message.slice(0, i) : message;
};
const KILL = /^KILL SWITCH\b/;
const BREAKER = /on-chain drawdown breaker TRIPPED|the breaker refuses buys until it recovers/;
const PROVIDER: ReadonlyArray<[RegExp, "market" | "brain" | "model"]> = [
  // The worker writes these three at different levels (market and model at
  // warn, the decision service at err); each is a provider failing, not the
  // agent deciding, so the level is not what selects them.
  [/^the market could not be read this tick/, "market"],
  [/^brain (unreachable|malformed):/, "brain"],
  [/^strategist driver failed:/, "model"],
];
const PROVIDER_TEXT = {
  market: "Market data could not be read, so nothing was traded. This is about our data sources, not about prices; it is retried every tick.",
  brain: "The decision service could not be reached (or answered with something unusable), so no decision was made.",
  model: "The AI model provider behind the strategy failed, so no trade was proposed.",
} as const;

/**
 * Kill switch, breaker trips and provider failures, read from the agent's
 * events. Events are append-only, so an id watermark is exact here. The event
 * text itself is never forwarded: it can hold RPC error text, addresses and
 * chat ids. Each alert says a fixed sentence instead.
 *
 * A tripped breaker is written EVERY TICK while it stays tripped (the on-chain
 * check) and restated by the idle channel, so "per event" would be a message
 * every four minutes. Breaker and provider alerts are therefore rate-limited:
 * the cursor holds when the last one fired (`g`, the event's time) and another
 * needs ALERT_WINDOW_SEC after it. A fixed clock window alone is not "at most
 * once every 6 hours": a failure running across a window boundary would alert
 * on both sides of it, minutes apart. The dedupe key is still the window, so a
 * lost cursor or a second replica cannot repeat an alert inside one.
 * A kill happens once and is keyed by its event.
 */
async function evalEvents(shared: Db, sub: SubRow, kind: "risk_halt" | "provider_failure", scope: AgentScope, cursor: Record<string, unknown>, now: number): Promise<Evaluation> {
  if (!scope.ids.length) return { candidates: [], cursor: null };
  const after = num(cursor.e) ?? 0;
  const lastGapped = num(cursor.g);
  let gapped = lastGapped;
  const gapOpen = (at: number) => gapped === null || at - gapped >= ALERT_WINDOW_SEC;
  const rows = (await shared
    .prepare(`SELECT id, level, message, created_at FROM events WHERE agent_id IN (${placeholders(scope.ids.length)}) AND id > ? AND created_at >= ? AND level IN ('warn', 'err') ORDER BY id ASC LIMIT ?`)
    .all(...scope.ids, after, sub.created_at, EVENTS_PER_SCAN)) as Array<{ id: number; level: string; message: string; created_at: number }>;
  const candidates: Candidate[] = [];
  const keys = new Set<string>();
  let watermark = after;
  const tag = `${scope.name} · ${bookTag(scope.mode)}`;
  for (const ev of rows) {
    watermark = Math.max(watermark, Number(ev.id));
    const at = Number(ev.created_at);
    if (now - at > EVENT_MAX_AGE_SEC) continue;
    const head = headOf(String(ev.message ?? ""));
    let c: Candidate | null = null;
    if (kind === "risk_halt") {
      if (KILL.test(head)) {
        c = { key: `risk_halt:${sub.id}:kill:${ev.id}`, book: bookOf(scope.mode), text: `${tag}\nKill switch: the trading permission was discarded and trading is halted. Nothing trades again until a new permission is signed in Merrymen.` };
      } else if (BREAKER.test(head) && gapOpen(at)) {
        gapped = at;
        c = { key: `risk_halt:${sub.id}:breaker:${Math.floor(at / ALERT_WINDOW_SEC)}`, book: bookOf(scope.mode), text: `${tag}\nDrawdown breaker tripped: the book is below the drawdown limit in the signed permission, so buys are refused until it recovers. Selling is never blocked.\n(At most one breaker alert every 6 hours.)` };
      }
    } else {
      const hit = PROVIDER.find(([re]) => re.test(head));
      if (hit && gapOpen(at)) {
        gapped = at;
        c = { key: `provider_failure:${sub.id}:${Math.floor(at / ALERT_WINDOW_SEC)}`, book: bookOf(scope.mode), text: `${tag}\n${PROVIDER_TEXT[hit[1]]}\n(At most one of these every 6 hours.)` };
      }
    }
    if (c && !keys.has(c.key)) {
      keys.add(c.key);
      candidates.push(c);
    }
  }
  const changed = watermark !== after || gapped !== lastGapped;
  return { candidates, cursor: changed ? { ...cursor, e: watermark, ...(gapped !== null ? { g: gapped } : {}) } : null };
}

/** The heartbeat the orchestrator's watchdog also judges by: two ticks plus grace, never under 180 s. */
export function staleAfterSec(tickSeconds: number): number {
  return Math.max(180, Math.ceil(tickSeconds) * 2 + 90);
}

/**
 * The statuses of an agent that is meant to be running. The worker writes
 * 'armed' when a grant arms and never moves it to 'active' (store.ts still
 * allows the word), so a test for 'active' alone would never fire.
 */
const RUNNING = new Set(["armed", "active"]);

async function evalStale(sub: SubRow, scope: AgentScope, s: PassState, cursor: Record<string, unknown>, now: number): Promise<Evaluation> {
  const none = { candidates: [], cursor: null };
  // At most one every ALERT_WINDOW_SEC, measured from the last one sent (see evalEvents).
  const last = num(cursor.g);
  if (last !== null && now - last < ALERT_WINDOW_SEC) return none;
  // Only a running agent owes a heartbeat. A killed or expired one stops
  // beating by design, and one with no signed permission never started.
  if (!scope.hasCurrent || scope.status === null || !RUNNING.has(scope.status)) return none;
  if (scope.expiresAt !== null && scope.expiresAt <= now) return none;
  // Unknown is not stale: no beat on record says nothing either way.
  if (scope.beatAt === null) return none;
  if (!s.deps.tickSeconds) {
    warnOnce(s, "stale_data_not_evaluated:no_tick_reader");
    return none;
  }
  let tickP = s.ticks.get(sub.tenant);
  if (!tickP) {
    tickP = s.deps.tickSeconds(sub.tenant).catch(() => null);
    s.ticks.set(sub.tenant, tickP);
  }
  const tick = await tickP;
  if (tick === null || !Number.isFinite(tick) || tick <= 0) return none;
  const limit = staleAfterSec(tick);
  const age = now - scope.beatAt;
  if (age <= limit) return none;
  const mins = Math.round(age / 60);
  return {
    candidates: [{
      key: `stale_data:${sub.id}:${Math.floor(now / ALERT_WINDOW_SEC)}`,
      book: bookOf(scope.mode),
      text: `${scope.name} · ${bookTag(scope.mode)}\nNo heartbeat for ${mins} minute${mins === 1 ? "" : "s"} (one is expected every ${Math.round(tick)} s). The agent may be stopped or stuck, and nothing trades while it is down.\n(At most one of these every 6 hours.)`,
    }],
    cursor: { ...cursor, g: now },
  };
}

/**
 * When the agent last FILLED, live or paper: the newest swap or curve trade,
 * one row per operation. A landed transfer or vault move is not a fill (the
 * rule web/src/lib/services/inactivity.ts applies), and a redeploy's re-recorded
 * copy of an older operation is that operation, not a new fill (distinctTrades).
 *
 * Collapsing an account's whole history on every evaluation would sort every
 * row it ever wrote, so the collapse is scoped the way the web scopes a report:
 * the newest fill-kind row bounds the answer from above, and a survivor within
 * OP_COPY_REACH_SEC of it is exact once the scope reaches OP_COPY_REACH_SEC
 * further back (its original, if it has one, is inside). Only when every fill
 * in that week was a copy is the whole history collapsed.
 */
async function lastFillAt(shared: Db, ids: readonly string[]): Promise<number | null> {
  const idsIn = placeholders(ids.length);
  const newest = num(((await shared
    .prepare(`SELECT MAX(created_at) AS at FROM trades WHERE agent_id IN (${idsIn}) AND status IN ('landed', 'paper') AND kind IN (${FILL_KINDS_SQL})`)
    .get(...ids)) as { at: unknown } | undefined)?.at);
  if (newest === null) return null;
  const collapsed = async (from: number | null): Promise<number | null> => {
    const scoped = from === null ? `t.agent_id IN (${idsIn})` : `t.agent_id IN (${idsIn}) AND t.created_at >= ?`;
    const row = (await shared
      .prepare(`SELECT MAX(t.created_at) AS at FROM ${distinctTrades(scoped)}
        WHERE t.status IN ('landed', 'paper') AND t.kind IN (${FILL_KINDS_SQL}) AND t.created_at >= ?`)
      .all(...ids, ...(from === null ? [] : [from - OP_COPY_REACH_SEC]), from ?? 0)) as Array<{ at: unknown }>;
    return num(row[0]?.at);
  };
  return (await collapsed(newest - OP_COPY_REACH_SEC)) ?? (await collapsed(null));
}

async function evalInactivity(shared: Db, sub: SubRow, params: NotifyParams, scope: AgentScope, now: number): Promise<Evaluation> {
  const none = { candidates: [], cursor: null };
  // A killed or expired agent is idle on purpose; saying so every few hours is noise.
  if (!scope.hasCurrent || scope.status === "killed" || scope.status === "expired" || !scope.ids.length) return none;
  // The row can still read 'armed' for a while after the permission ran out.
  if (scope.expiresAt !== null && scope.expiresAt <= now) return none;
  const hours = Number(params.hours);
  const window = hours * 3600;
  const last = await lastFillAt(shared, scope.ids);
  // Never filled: counted from the subscription, since "never" has no length.
  const ref = last !== null && last > 0 ? Math.max(last, 0) : sub.created_at;
  const n = Math.floor((now - ref) / window);
  if (n < 1) return none;
  const since = last !== null && last > 0 ? `The last fill was at ${utc(last)}.` : "There has been no fill since this alert was set up.";
  return {
    candidates: [{
      key: `inactivity:${sub.id}:${ref}:${n}`,
      book: bookOf(scope.mode),
      text: `${scope.name} · ${bookTag(scope.mode)}\nNo live or paper fill for ${Math.floor((now - ref) / 3600)} hours (you asked to hear after ${hours}). ${since}`,
    }],
    cursor: null,
  };
}

type Zone = "in" | "out";

async function evalPrice(sub: SubRow, params: NotifyParams, s: PassState, cursor: Record<string, unknown>, now: number): Promise<Evaluation> {
  const none = { candidates: [], cursor: null };
  const feed = feedToken(String(params.token));
  if (!feed) return none;
  if (!s.deps.price) {
    warnOnce(s, "watchlist_price_not_evaluated:no_price_reader");
    return none;
  }
  const reader = s.deps.price;
  const tokenKey = feed.address.toLowerCase();
  let pending = s.prices.get(tokenKey);
  if (!pending) {
    pending = withTimeout(Promise.resolve().then(() => reader(feed.address)), s.deps.priceTimeoutMs ?? PRICE_READ_TIMEOUT_MS).catch(() => null);
    s.prices.set(tokenKey, pending);
  }
  const reading = await pending;
  // No price is no alert: a failed read must never look like a crossing.
  if (!reading || !Number.isFinite(reading.priceUsd) || reading.priceUsd <= 0) return none;
  if (!Number.isFinite(reading.updatedAt) || now - reading.updatedAt > PRICE_MAX_AGE_SEC) return none;
  const price = reading.priceUsd;
  const next: Record<string, unknown> = { ...cursor };
  const candidates: Candidate[] = [];
  const asOf = `Chainlink price as of ${utc(reading.updatedAt)}; stock feeds pause outside market hours.`;
  const check = (dir: "above" | "below", line: number) => {
    const zoneKey = dir === "above" ? "za" : "zb";
    const countKey = dir === "above" ? "na" : "nb";
    const firedKey = dir === "above" ? "ta" : "tb";
    const prev = next[zoneKey] === "in" ? "in" : next[zoneKey] === "out" ? "out" : null;
    // Entering needs the line; leaving needs clear room past it.
    const inside = dir === "above" ? price >= line : price <= line;
    const stillIn = dir === "above" ? price >= line * (1 - PRICE_HYSTERESIS) : price <= line * (1 + PRICE_HYSTERESIS);
    const zone: Zone = prev === "in" ? (stillIn ? "in" : "out") : inside ? "in" : "out";
    next[zoneKey] = zone;
    if (zone === "in" && prev !== "in") {
      const lastFired = num(next[firedKey]);
      if (lastFired !== null && now - lastFired < PRICE_ALERT_COOLDOWN_SEC) return;
      const n = (num(next[countKey]) ?? 0) + 1;
      next[countKey] = n;
      next[firedKey] = now;
      candidates.push({
        key: `watchlist_price:${sub.id}:${dir}:${n}`,
        book: "none",
        text: `${feed.symbol} is ${dir === "above" ? "at or above" : "at or below"} ${line} USD: now ${price.toFixed(price >= 100 ? 2 : 4)} USD.\n${asOf}`,
      });
    }
  };
  if (typeof params.above === "number") check("above", params.above);
  if (typeof params.below === "number") check("below", params.below);
  const changed = JSON.stringify(next) !== JSON.stringify(cursor);
  return { candidates, cursor: changed ? next : null };
}

/** The most recent period boundary at or before `now`, and the period's start. */
export function summaryPeriod(period: "day" | "week", hourUtc: number, now: number): { end: number; start: number } {
  const midnight = Math.floor(now / 86_400) * 86_400;
  if (period === "day") {
    let end = midnight + hourUtc * 3600;
    if (end > now) end -= 86_400;
    return { end, start: end - 86_400 };
  }
  const dow = (new Date(now * 1000).getUTCDay() + 6) % 7; // Monday = 0
  let end = midnight - dow * 86_400 + hourUtc * 3600;
  if (end > now) end -= 7 * 86_400;
  return { end, start: end - 7 * 86_400 };
}

/**
 * A book's last valuation taken more than this before the period's end is not
 * its close. A running agent values its book every tick (a minute by default),
 * so an hour without one means valuing stopped, not that the book sat still.
 */
export const SUMMARY_VALUATION_STALE_SEC = 3600;

/** Only ever called with more than SUMMARY_VALUATION_STALE_SEC, so always an hour or more. */
const hoursBefore = (sec: number) => {
  const h = Math.max(1, Math.round(sec / 3600));
  return `${h} hour${h === 1 ? "" : "s"}`;
};

async function bookLine(shared: Db, scope: AgentScope, book: "live" | "paper", start: number, end: number): Promise<string | null> {
  const ids = scope.ids;
  const idsIn = placeholders(ids.length);
  const last = (await shared
    .prepare(`SELECT agent_id, equity_usdg, at, epoch FROM equity WHERE agent_id IN (${idsIn}) AND mode = ? AND at <= ? ORDER BY at DESC LIMIT 1`)
    .get(...ids, book, end)) as { agent_id: string; equity_usdg: unknown; at: unknown; epoch: unknown } | undefined;
  const status = book === "live" ? "landed" : "paper";
  // Fills only (a transfer or a vault move is not a trade), one per operation:
  // a redeploy's copy of an operation is not a second trade. The collapse
  // reaches back past the period, as web/src/lib/services/reports.ts does, so a
  // copy stamped in the period of an operation from before it collapses into it.
  const counted = (await shared
    .prepare(`SELECT COUNT(*) AS n FROM ${distinctTrades(`t.agent_id IN (${idsIn}) AND t.created_at >= ?`)}
      WHERE t.status = ? AND t.kind IN (${FILL_KINDS_SQL}) AND t.created_at >= ? AND t.created_at < ?`)
    .get(...ids, start - OP_COPY_REACH_SEC, status, start, end)) as { n: unknown } | undefined;
  const fills = num(counted?.n) ?? 0;
  const label = book === "live" ? "LIVE" : "PAPER (practice, no real money)";
  const fillsText = book === "live" ? `${fills} trade${fills === 1 ? "" : "s"} landed.` : `${fills} paper fill${fills === 1 ? "" : "s"}.`;
  const lastAt = num(last?.at);
  const lastEq = num(last?.equity_usdg);
  if (!last || lastAt === null || lastAt < start || lastEq === null) {
    // A book with neither a valuation nor a fill in the period is not part of this summary.
    return fills > 0 ? `${label}: no valuation was recorded in the period. ${fillsText}` : null;
  }
  // The opening figure must be of the same account and the same run: a reset
  // opens a new epoch at a new balance, and that step is not performance.
  const opening = ((await shared
    .prepare("SELECT equity_usdg, at FROM equity WHERE agent_id = ? AND mode = ? AND epoch = ? AND at <= ? ORDER BY at DESC LIMIT 1")
    .get(last.agent_id, book, last.epoch, start)) ??
    (await shared
      .prepare("SELECT equity_usdg, at FROM equity WHERE agent_id = ? AND mode = ? AND epoch = ? AND at >= ? ORDER BY at ASC LIMIT 1")
      .get(last.agent_id, book, last.epoch, start))) as { equity_usdg: unknown; at: unknown } | undefined;
  const open = num(opening?.equity_usdg);
  const openAt = num(opening?.at);
  // The figure is the last valuation, stated with its time. One taken well
  // before the period ended is not the period's close, and says so rather than
  // passing for it: the worker may have stopped valuing hours ago.
  const stale = end - lastAt > SUMMARY_VALUATION_STALE_SEC;
  const valued = stale
    ? `last valued at ${utc(lastAt)}, ${hoursBefore(end - lastAt)} before the period ended, and not since: equity then ${usd(lastEq)} USDG`
    : `equity ${usd(lastEq)} USDG as of ${utc(lastAt)}`;
  let change = "";
  if (open !== null && openAt !== null && openAt !== lastAt) {
    change = ` (${usd(open)} ${openAt <= start ? "at the start" : "at the first reading in the period"}, ${signed(lastEq - open)}${stale ? " by then" : ""})`;
  }
  let flowsText = "";
  if (book === "live" && change && openAt !== null && lastAt !== null) {
    // Only money that crossed the account BETWEEN the two readings the change
    // is measured from, on the same account and run, is "inside that change".
    // An epoch-carry is the opening balance of a new run, not a deposit, and a
    // flow before the opening reading is already in the opening figure.
    const acct = spellings(String(last.agent_id));
    const flows = (await shared
      .prepare(`SELECT direction, SUM(amount_usdg) AS total FROM flows
        WHERE agent_id IN (${placeholders(acct.length)}) AND epoch = ? AND source <> 'epoch-carry' AND at > ? AND at <= ?
        GROUP BY direction`)
      .all(...acct, last.epoch, openAt, lastAt)) as Array<{ direction: string; total: unknown }>;
    const inflow = num(flows.find((f) => f.direction === "in")?.total) ?? 0;
    const outflow = num(flows.find((f) => f.direction === "out")?.total) ?? 0;
    if (inflow > 0 || outflow > 0) flowsText = ` Deposits ${usd(inflow)} USDG and withdrawals ${usd(outflow)} USDG are inside that change.`;
  }
  return `${label}: ${valued}${change}.${flowsText} ${fillsText}`;
}

async function evalSummary(shared: Db, sub: SubRow, params: NotifyParams, scope: AgentScope, now: number): Promise<Evaluation> {
  const none = { candidates: [], cursor: null };
  const period = params.period === "week" ? "week" : "day";
  const { start, end } = summaryPeriod(period, Number(params.hour_utc), now);
  // The first summary is for the first whole period that ends after subscribing.
  if (end <= sub.created_at || !scope.ids.length) return none;
  const key = `summary:${sub.id}:${period}:${end}`;
  // Already queued (by this or another replica): skip the ledger reads entirely.
  if (await shared.prepare("SELECT 1 AS x FROM notify_deliveries WHERE dedupe_key = ?").get(key)) return none;
  // Two books, two lines, never added together: a practice balance and real
  // funds are different quantities.
  const live = await bookLine(shared, scope, "live", start, end);
  const paper = await bookLine(shared, scope, "paper", start, end);
  const heading = `${scope.name} · ${period === "week" ? "weekly" : "daily"} summary for the ${period === "week" ? "7 days" : "24 hours"} to ${utc(end)}`;
  const body = [live, paper].filter((l): l is string => !!l);
  const text = `${heading}\n${body.length ? body.join("\n") : "Nothing was valued or filled in this period."}`;
  return { candidates: [{ key, text, book: "separate" }], cursor: null };
}

async function evaluateOne(shared: Db, sub: SubRow, s: PassState, now: number): Promise<Evaluation | null> {
  const verdict = normalizeNotifyParams(sub.kind, parseJson(sub.params_json));
  if (!verdict.ok) {
    s.out.invalid += 1;
    return null;
  }
  const kind = sub.kind as NotifyKind;
  const params = verdict.params;
  const cursor = parseJson(sub.cursor_json);
  if (kind === "watchlist_price") return evalPrice(sub, params, s, cursor, now);
  if (!sub.agent_slug) {
    s.out.invalid += 1;
    return null;
  }
  const scope = await scopeFor(shared, s, sub.tenant, sub.agent_slug);
  if (!scope) {
    s.out.unresolved += 1;
    return null;
  }
  switch (kind) {
    case "trade_confirmed": return evalTrades(shared, sub, scope, cursor, now);
    case "risk_halt": return evalEvents(shared, sub, "risk_halt", scope, cursor, now);
    case "provider_failure": return evalEvents(shared, sub, "provider_failure", scope, cursor, now);
    case "stale_data": return evalStale(sub, scope, s, cursor, now);
    case "inactivity": return evalInactivity(shared, sub, params, scope, now);
    case "summary": return evalSummary(shared, sub, params, scope, now);
  }
}

/** Thrown inside the write transaction when another pass (or an unsubscribe) took the row since this one claimed it. */
class Superseded extends Error {
  constructor() {
    super("superseded");
    this.name = "Superseded";
  }
}

async function evaluatePhase(shared: Db, s: PassState, overBudget: () => boolean): Promise<void> {
  const now = s.deps.now();
  // Only owners who still have a connected app that may manage alerts (see
  // NOTIFY_SCOPE). Scopes are stored space-separated, so the padded LIKE
  // matches the whole scope and never a longer one that contains it.
  const subs = (await shared
    .prepare(`SELECT s.id, s.tenant, s.agent_slug, s.kind, s.params_json, s.cursor_json, s.created_at, s.last_evaluated_at
      FROM notify_subscriptions s
      WHERE s.status = 'active' AND s.channel = 'telegram' AND (s.last_evaluated_at IS NULL OR s.last_evaluated_at <= ?)
        AND EXISTS (SELECT 1 FROM mcp_connections c WHERE c.tenant = s.tenant AND c.status = 'active' AND (' ' || c.scopes || ' ') LIKE ?)
      ORDER BY COALESCE(s.last_evaluated_at, 0) ASC, s.created_at ASC LIMIT ?`)
    .all(now - MIN_EVAL_GAP_SEC, `% ${NOTIFY_SCOPE} %`, SUBS_PER_PASS)) as SubRow[];
  for (const raw of subs) {
    if (overBudget()) {
      warnOnce(s, "time_budget_reached:evaluate");
      break;
    }
    const listed: SubRow = { ...raw, tenant: String(raw.tenant).toLowerCase(), created_at: Number(raw.created_at), last_evaluated_at: num(raw.last_evaluated_at) };
    // Claim: only the replica whose compare-and-set lands evaluates this row
    // now. The cursor is taken from the claim itself, not from the listing
    // above: a pass that finished between the two has already moved it.
    const claimed = (await shared
      .prepare("UPDATE notify_subscriptions SET last_evaluated_at = ? WHERE id = ? AND status = 'active' AND COALESCE(last_evaluated_at, -1) = ? RETURNING cursor_json")
      .get(now, listed.id, listed.last_evaluated_at ?? -1)) as { cursor_json: string | null } | undefined;
    if (!claimed) continue;
    const sub: SubRow = { ...listed, cursor_json: claimed.cursor_json ?? null };
    s.out.evaluated += 1;
    try {
      const ev = await evaluateOne(shared, sub, s, now);
      if (!ev || (!ev.candidates.length && !ev.cursor)) continue;
      const queued = await shared.tx(async (tx) => {
        // FENCE. The claim is this pass's lease on the row. If another pass
        // re-claimed it (this one ran past MIN_EVAL_GAP_SEC) or the owner
        // unsubscribed meanwhile, nothing this evaluation found is written:
        // not a regressed cursor, and not a message for a removed alert.
        const fence = await tx
          .prepare("UPDATE notify_subscriptions SET cursor_json = COALESCE(?, cursor_json) WHERE id = ? AND status = 'active' AND last_evaluated_at = ?")
          .run(ev.cursor ? JSON.stringify(ev.cursor) : null, sub.id, now);
        if (fence.changes !== 1) throw new Superseded();
        let n = 0;
        for (const c of ev.candidates) {
          const r = await tx
            .prepare(`INSERT INTO notify_deliveries (id, subscription_id, tenant, dedupe_key, kind, channel, status, attempts, next_attempt_at, last_error_code, payload_json, created_at, sent_at)
              VALUES (?, ?, ?, ?, ?, 'telegram', 'pending', 0, ?, NULL, ?, ?, NULL)
              ON CONFLICT (dedupe_key) DO NOTHING`)
            .run(newId("ndl"), sub.id, sub.tenant, c.key, sub.kind, now, JSON.stringify({ v: 1, text: c.text, book: c.book, agent: sub.agent_slug }), now);
          n += r.changes;
        }
        return n;
      });
      s.out.queued += queued;
    } catch (e) {
      if (e instanceof Superseded) {
        warnOnce(s, "evaluation_superseded");
        continue;
      }
      s.out.failed += 1;
      warnOnce(s, `evaluate_failed:${sub.kind}:${e instanceof Error ? e.name : "unknown"}`);
    }
  }
}

// ── delivery ───────────────────────────────────────────────────────────────

interface DueRow {
  id: string;
  tenant: string;
  attempts: number;
  payload_json: string;
  sub_status: string | null;
  sub_tenant: string | null;
}

async function finish(shared: Db, id: string, status: "skipped" | "dead", code: string, from: "queued" | "sending"): Promise<number> {
  const where = from === "queued" ? "status IN ('pending', 'retry')" : "status = 'sending'";
  const r = await shared.prepare(`UPDATE notify_deliveries SET status = ?, last_error_code = ? WHERE id = ? AND ${where}`).run(status, code, id);
  return r.changes;
}

/**
 * CLAIM BEFORE SEND. A delivery is marked 'sending' (and its attempt counted)
 * in one conditional update before the sender is called, so two replicas can
 * never both send it. The price is at-most-once on a crash: a process that dies
 * between the claim and the result leaves the row 'sending', and it is written
 * off as 'interrupted' rather than retried — the message may or may not have
 * arrived, and a lost alert is the cheaper failure than the same alert twice
 * (for a trade, a duplicate reads as a second trade).
 */
async function deliverPhase(shared: Db, s: PassState, overBudget: () => boolean): Promise<void> {
  const nowAtStart = s.deps.now();
  // next_attempt_at doubles as the claim's lease expiry while a row is 'sending'.
  s.out.interrupted += (await shared
    .prepare("UPDATE notify_deliveries SET status = 'dead', last_error_code = 'interrupted' WHERE status = 'sending' AND next_attempt_at <= ?")
    .run(nowAtStart)).changes;
  s.out.expired += (await shared
    .prepare("UPDATE notify_deliveries SET status = 'dead', last_error_code = 'expired' WHERE status IN ('pending', 'retry') AND created_at <= ?")
    .run(nowAtStart - QUEUE_MAX_AGE_SEC)).changes;
  const due = (await shared
    .prepare(`SELECT d.id, d.tenant, d.attempts, d.payload_json, s.status AS sub_status, s.tenant AS sub_tenant
      FROM notify_deliveries d LEFT JOIN notify_subscriptions s ON s.id = d.subscription_id
      WHERE d.status IN ('pending', 'retry') AND d.next_attempt_at <= ?
      ORDER BY d.next_attempt_at ASC, d.created_at ASC LIMIT ?`)
    .all(nowAtStart, DELIVERIES_PER_PASS)) as DueRow[];
  const recipients = new Map<string, Promise<NotifyRecipient | null | "unavailable">>();
  /** Owners whose queue waits out the rest of this pass (throttled, or their chat could not be read). */
  const held = new Set<string>();
  const holdQueue = async (tenant: string, until: number) => {
    await shared
      .prepare("UPDATE notify_deliveries SET next_attempt_at = ? WHERE tenant = ? AND status IN ('pending', 'retry') AND next_attempt_at < ?")
      .run(until, tenant, until);
  };
  for (const d of due) {
    if (overBudget()) {
      warnOnce(s, "time_budget_reached:deliver");
      break;
    }
    const tenant = String(d.tenant).toLowerCase();
    if (held.has(tenant)) {
      s.out.deferred += 1;
      continue;
    }
    if (d.sub_status !== "active" || String(d.sub_tenant ?? "").toLowerCase() !== tenant) {
      s.out.skipped += await finish(shared, d.id, "skipped", "unsubscribed", "queued");
      continue;
    }
    let rp = recipients.get(tenant);
    if (!rp) {
      rp = s.deps.recipient(tenant).catch(() => "unavailable" as const);
      recipients.set(tenant, rp);
    }
    const rcpt = await rp;
    if (rcpt === "unavailable") {
      // The settings store or the link table could not be read: that is not the
      // owner saying no, so the delivery waits for a pass that can read them.
      // The owner's whole queue is pushed back, not left due: the due list is
      // oldest-first, and one owner whose settings cannot be unsealed would
      // otherwise fill it on every pass and starve everybody else's alerts.
      held.add(tenant);
      s.out.deferred += 1;
      warnOnce(s, "recipient_unavailable");
      await holdQueue(tenant, nowAtStart + RECIPIENT_RETRY_SEC);
      continue;
    }
    const usable = rcpt && typeof rcpt.botToken === "string" && rcpt.botToken.length > 0 && Number.isSafeInteger(rcpt.chatId) && rcpt.chatId !== 0;
    if (!rcpt || !usable) {
      s.out.skipped += await finish(shared, d.id, "skipped", "no_linked_telegram", "queued");
      continue;
    }
    if (rcpt.enabled !== true) {
      s.out.skipped += await finish(shared, d.id, "skipped", "owner_disabled", "queued");
      continue;
    }
    const payload = parseJson(d.payload_json);
    const text = typeof payload.text === "string" && payload.text.trim() ? payload.text : null;
    if (!text) {
      s.out.dead += await finish(shared, d.id, "dead", "bad_payload", "queued");
      continue;
    }
    const now = s.deps.now();
    const claimed = await shared
      .prepare("UPDATE notify_deliveries SET status = 'sending', attempts = attempts + 1, next_attempt_at = ? WHERE id = ? AND status IN ('pending', 'retry') AND next_attempt_at <= ?")
      .run(now + SENDING_LEASE_SEC, d.id, now);
    if (claimed.changes !== 1) continue;
    const attempt = Number(d.attempts) + 1;
    let res: SendResult;
    try {
      res = await s.deps.send(rcpt.botToken, rcpt.chatId, text);
    } catch {
      res = { ok: false, reason: "sender threw" };
    }
    const after = s.deps.now();
    if (res && res.ok === true) {
      await shared.prepare("UPDATE notify_deliveries SET status = 'sent', sent_at = ?, last_error_code = NULL WHERE id = ? AND status = 'sending'").run(after, d.id);
      s.out.sent += 1;
      continue;
    }
    const code = sendErrorCode(res ?? {});
    // A request that timed out may still have reached Telegram, which offers no
    // idempotency key, so a retry after a 'network' failure can repeat a
    // message. That is kept: the owner reads the tx hash or the window in the
    // text, and a transport failure that dropped every retry would be silent.
    const retryAfter = typeof res?.retryAfterSec === "number" && Number.isFinite(res.retryAfterSec) ? Math.min(Math.max(0, Math.ceil(res.retryAfterSec)), 86_400) : 0;
    if (code === "rate_limited") {
      held.add(tenant);
      // retry_after is Telegram throttling the BOT, not this one message: every
      // queued message of this owner waits it out, or the next pass (15 s
      // later) would walk straight back into the limit.
      if (retryAfter > 0) await holdQueue(tenant, after + retryAfter);
    }
    if (attempt >= MAX_ATTEMPTS) {
      s.out.dead += await finish(shared, d.id, "dead", code, "sending");
      continue;
    }
    const wait = Math.max(RETRY_BACKOFF_SEC[attempt - 1] ?? RETRY_BACKOFF_SEC[RETRY_BACKOFF_SEC.length - 1]!, retryAfter);
    await shared
      .prepare("UPDATE notify_deliveries SET status = 'retry', next_attempt_at = ?, last_error_code = ? WHERE id = ? AND status = 'sending'")
      .run(after + wait, code, d.id);
    s.out.retried += 1;
  }
}

/**
 * One notification pass: evaluate due subscriptions into deliveries, then send
 * what is due. Never throws; bounded in rows and wall-clock time.
 */
export async function runNotifyPass(shared: Db, deps: NotifyDeps): Promise<NotifyPassSummary> {
  const started = Date.now();
  const budget = deps.maxMs ?? DEFAULT_MAX_MS;
  const overBudget = () => Date.now() - started > budget;
  const out: NotifyPassSummary = {
    evaluated: 0, queued: 0, unresolved: 0, invalid: 0, sent: 0, retried: 0, dead: 0, skipped: 0,
    interrupted: 0, expired: 0, deferred: 0, failed: 0, warnings: [], error: null, ms: 0,
  };
  const s: PassState = { deps, out, scopes: new Map(), ticks: new Map(), prices: new Map(), warned: new Set() };
  try {
    await evaluatePhase(shared, s, overBudget);
  } catch (e) {
    out.error = `evaluate:${e instanceof Error ? e.name : "unknown"}`;
  }
  try {
    await deliverPhase(shared, s, overBudget);
  } catch (e) {
    out.error = out.error ?? `deliver:${e instanceof Error ? e.name : "unknown"}`;
  }
  out.ms = Date.now() - started;
  if (deps.log && (out.queued || out.sent || out.retried || out.dead || out.interrupted || out.expired || out.error)) {
    deps.log(`[notify] evaluated ${out.evaluated}, queued ${out.queued}, sent ${out.sent}, retry ${out.retried}, dead ${out.dead}, skipped ${out.skipped}, interrupted ${out.interrupted}, expired ${out.expired}${out.error ? `, error ${out.error}` : ""}`);
  }
  return out;
}

// ── hosted adapters ────────────────────────────────────────────────────────

/**
 * Send through the owner's own bot. The text is plain, so it is escaped for
 * the HTML parse mode sendMessage uses; a request that hangs is cut off rather
 * than holding the reconcile loop.
 */
export function telegramSend(o: { fetchFn?: FetchLike; timeoutMs?: number } = {}): NotifyDeps["send"] {
  const timeoutMs = o.timeoutMs ?? 10_000;
  const fetchFn: FetchLike = o.fetchFn ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }));
  return async (token, chatId, text) => {
    const r = await sendMessage({ token, fetchFn }, chatId, esc(text));
    if (r.ok) return { ok: true };
    const m = /retry after (\d+)/i.exec(r.reason ?? "");
    return m ? { ok: false, reason: r.reason, retryAfterSec: Number(m[1]) } : { ok: false, reason: r.reason };
  };
}

/** The slice of the settings store the hosted recipient reads. */
export interface SettingsGetter {
  get(tenant: `0x${string}`): Promise<unknown>;
}

async function settingsOf(store: SettingsGetter, tenant: string): Promise<Record<string, unknown> | null> {
  const s = await store.get(tenant.toLowerCase() as `0x${string}`);
  return s && typeof s === "object" ? (s as Record<string, unknown>) : null;
}

/**
 * The owner's own chat and bot, obeying the same switches as the child's
 * notifier: Telegram on (it defaults off) and alerts not switched off. The
 * recipient is tenant_telegram.owner_id — the chat that proved the /link code —
 * and nothing a client supplied.
 */
export function hostedRecipient(shared: Db, store: SettingsGetter = getSettingsStore()): NotifyDeps["recipient"] {
  return async (tenant) => {
    const link = await readTenantTelegram(shared, tenant);
    if (!link || link.ownerId === null) return null;
    const s = await settingsOf(store, tenant);
    const token = typeof s?.telegramBotToken === "string" ? s.telegramBotToken.trim() : "";
    if (!token) return null;
    return { botToken: token, chatId: link.ownerId, enabled: s?.telegramEnabled === true && s?.telegramNotifyEnabled !== false };
  };
}

/** The tick the orchestrator runs the tenant's child at: its own setting, else the fleet's. */
export function hostedTickSeconds(store: SettingsGetter = getSettingsStore()): NonNullable<NotifyDeps["tickSeconds"]> {
  return async (tenant) => {
    const s = await settingsOf(store, tenant);
    if (typeof s?.tickSeconds === "number" && s.tickSeconds > 0) return s.tickSeconds;
    const env = Number(process.env.MERRYMEN_TICK_SECONDS);
    return Number.isFinite(env) && env > 0 ? env : 60;
  };
}

const FEED_ABI = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  {
    type: "function", name: "latestRoundData", stateMutability: "view", inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" }, { name: "answer", type: "int256" }, { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" }, { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

export interface FeedClient {
  readContract(args: { address: `0x${string}`; abi: typeof FEED_ABI; functionName: "decimals" | "latestRoundData" }): Promise<unknown>;
}

/**
 * Chainlink USD price for a stock token with a feed. The feed prices the
 * underlying share (no ERC-8056 multiplier), which is what a price alert on a
 * stock means. Any failed or non-positive read is null — never a price.
 */
export function chainlinkPriceReader(client: FeedClient): PriceReader {
  return async (token) => {
    const f = feedToken(token);
    if (!f) return null;
    try {
      const [round, decimals] = await Promise.all([
        client.readContract({ address: f.feed, abi: FEED_ABI, functionName: "latestRoundData" }),
        client.readContract({ address: f.feed, abi: FEED_ABI, functionName: "decimals" }),
      ]);
      const r = round as readonly [bigint, bigint, bigint, bigint, bigint];
      const dec = Number(decimals);
      if (!Array.isArray(r) || typeof r[1] !== "bigint" || r[1] <= 0n || !Number.isInteger(dec) || dec < 0 || dec > 36) return null;
      return { priceUsd: Number(r[1]) / 10 ** dec, updatedAt: Number(r[3]) };
    } catch {
      return null;
    }
  };
}

/** Everything the orchestrator needs for runNotifyPass on the hosted fleet. */
export function hostedNotifyDeps(shared: Db, o: { store?: SettingsGetter; price?: PriceReader; fetchFn?: FetchLike; log?: (line: string) => void; maxMs?: number } = {}): NotifyDeps {
  const store = o.store ?? getSettingsStore();
  return {
    now: () => Math.floor(Date.now() / 1000),
    send: telegramSend({ fetchFn: o.fetchFn }),
    recipient: hostedRecipient(shared, store),
    tickSeconds: hostedTickSeconds(store),
    ...(o.price ? { price: o.price } : {}),
    ...(o.log ? { log: o.log } : {}),
    ...(o.maxMs ? { maxMs: o.maxMs } : {}),
  };
}
