/**
 * Durable alerts: which private channel an owner has, the subscriptions that
 * decide what their agent tells them there, and whether each message went out.
 *
 * The only private channel is the owner's own Telegram bot, sending to the chat
 * that proved the /link code. A subscription is a wish, never an override: the
 * background pass (worker/src/mcp/notify.ts, run by the orchestrator) records a
 * message as skipped when the owner is unlinked or has Telegram or its alerts
 * switched off, and only the owner can change those switches, in Merrymen.
 *
 * Nothing here reads or returns a bot token, a chat id or the link code. The
 * link is reported as yes/no and the switches as booleans.
 *
 * A subscription belongs to the owner (tenant) and, for agent kinds, to one of
 * their agents; a connection sees one only if the agent is shared with it.
 * Another owner's id, or one about an agent this connection was not given, is
 * not found. The pass resolves the agent again from the identity tables on
 * every evaluation, so a stored slug never grants anything by itself.
 */
import { createHash, randomBytes } from "node:crypto";
import * as z from "zod";
import { settingsReader, type SettingsView } from "@/lib/services/settings-view";
import { readTenantTelegram, type TenantTelegram } from "../../../../worker/src/telegram-store";
import {
  AGENT_KINDS, DELIVERY_ERROR_TEXT, MAX_ACTIVE_SUBSCRIPTIONS, NOTIFY_KINDS, canonicalParams, describeSubscription,
  isNotifyKind, normalizeNotifyParams, type NotifyKind, type NotifyParams,
} from "../../../../worker/src/mcp/notify";
import { McpError } from "../errors";
import { defineTool, type ToolContext } from "../tool";
import type { OwnedAgent } from "../agents";
import { ADDRESS_ARG, AGENT_ARG, LIMIT_ARG, UNTRUSTED_NOTE, decodeCursor, encodeCursor, isCursorInt, isoOrNull, untrusted } from "./shared";

const SUBSCRIPTION_ID = z.string().regex(/^nsub_[0-9a-f]{32}$/, "a subscription id from list_subscriptions");
const iso = (sec: number) => new Date(sec * 1000).toISOString();
const newSubscriptionId = () => `nsub_${randomBytes(16).toString("hex")}`;

/** Serialises one owner's subscribes on Postgres, so the cap and the idempotency check cannot race. */
function tenantLockKey(tenant: string): number {
  return createHash("sha256").update(`notify-subscribe:${tenant}`).digest().readInt32BE(0);
}

// ── channel state ───────────────────────────────────────────────────────────

interface ChannelState {
  link: TenantTelegram | null;
  settings: SettingsView | null;
  settingsRead: boolean;
}

async function channelState(ctx: ToolContext): Promise<ChannelState> {
  const tenant = ctx.principal.tenant;
  const link = await ctx.ledger(async (db) => {
    try {
      return await readTenantTelegram(db, tenant);
    } catch {
      // The link table is part of the shared store; failing to read it is an
      // outage, and "not linked" would send the owner off to re-link for nothing.
      throw new McpError("upstream_unavailable", "Your Telegram link could not be read right now.", { retryAfterSec: 30 });
    }
  });
  try {
    return { link, settings: await settingsReader().settingsFor(tenant), settingsRead: true };
  } catch {
    return { link, settings: null, settingsRead: false };
  }
}

const isLinked = (s: ChannelState) => !!s.link && s.link.ownerId !== null;

function telegramView(s: ChannelState) {
  const linked = isLinked(s);
  const enabled = s.settings ? s.settings.telegram.enabled : null;
  const alerts = s.settings ? s.settings.telegram.notifyEnabled : null;
  const ready = !linked ? false : enabled === null || alerts === null ? null : enabled && alerts;
  let fix: string | null = null;
  if (!linked) {
    fix = s.link
      ? "Telegram was linked once and then unlinked. Open Merrymen Settings → Telegram and send the /link code shown there to your bot."
      : "No Telegram chat is linked. In Merrymen Settings → Telegram, add your bot and send it the /link code shown there.";
  } else if (enabled === false) {
    fix = "Telegram is switched off in Merrymen Settings. Only you can switch it on there; alerts are recorded as skipped until then.";
  } else if (alerts === false) {
    fix = "Telegram alerts (notifications) are switched off in Merrymen Settings. Only you can switch them on there; alerts are recorded as skipped until then.";
  }
  return {
    channel: "telegram" as const,
    linked,
    linked_at: linked ? isoOrNull(s.link?.linkedAt ?? null) : null,
    telegram_enabled: enabled,
    alerts_enabled: alerts,
    ready,
    how_to_fix: fix,
  };
}

function settingsWarnings(s: ChannelState): string[] {
  if (!s.settingsRead) return ["Your settings could not be read, so whether Telegram and its alerts are switched on is unknown (null)."];
  if (!s.settings) return ["No saved settings were found, so whether Telegram and its alerts are switched on is unknown (null)."];
  return [];
}

// ── shapes ──────────────────────────────────────────────────────────────────

const PARAM_VALUE = z.union([z.string(), z.number()]);

const SUB_OUT = z.object({
  subscription_id: z.string(),
  agent: z.string().nullable().describe("Agent id; null for a price alert, which is about a token, not an agent"),
  kind: z.enum(NOTIFY_KINDS),
  params: z.record(z.string(), PARAM_VALUE),
  description: z.string().describe("What this subscription sends, in one sentence"),
  status: z.string(),
  channel: z.literal("telegram"),
  created_at: z.string(),
  last_evaluated_at: z.string().nullable(),
});

const LAST_DELIVERY = z.object({
  status: z.string(),
  created_at: z.string(),
  sent_at: z.string().nullable(),
  last_error_code: z.string().nullable(),
}).nullable();

const TELEGRAM_VIEW = z.object({
  channel: z.literal("telegram"),
  linked: z.boolean().describe("A chat proved the /link code. The chat id itself is never shown."),
  linked_at: z.string().nullable(),
  telegram_enabled: z.boolean().nullable().describe("The owner's Telegram switch in Settings; null when it could not be read"),
  alerts_enabled: z.boolean().nullable().describe("The owner's Telegram alerts (notifications) switch in Settings; null when it could not be read"),
  ready: z.boolean().nullable().describe("Linked and both switches on. Null when a switch could not be read. Whether the bot token is still saved cannot be seen here; if it was removed, messages are recorded as skipped (no_linked_telegram) — check list_deliveries."),
  how_to_fix: z.string().nullable(),
});

interface SubRow {
  id: string;
  agent_slug: string | null;
  kind: string;
  params_json: string;
  status: string;
  created_at: number;
  last_evaluated_at: number | null;
}

function paramsOf(row: SubRow): NotifyParams {
  const v = normalizeNotifyParams(row.kind, safeJson(row.params_json));
  return v.ok ? v.params : {};
}

function safeJson(raw: string | null): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

function subOut(row: SubRow) {
  const kind = row.kind as NotifyKind;
  const params = paramsOf(row);
  return {
    subscription_id: row.id,
    agent: row.agent_slug,
    kind,
    params,
    description: describeSubscription(kind, params),
    status: row.status,
    channel: "telegram" as const,
    created_at: iso(Number(row.created_at)),
    last_evaluated_at: isoOrNull(row.last_evaluated_at === null ? null : Number(row.last_evaluated_at)),
  };
}

const SUB_COLS = "id, agent_slug, kind, params_json, status, created_at, last_evaluated_at";

/** A subscription about an agent this connection was not given is not this connection's to see. */
function visible(row: { agent_slug: string | null }, reachable: ReadonlySet<string>): boolean {
  return row.agent_slug === null || reachable.has(row.agent_slug);
}

async function reachableSlugs(ctx: ToolContext): Promise<Set<string>> {
  return new Set((await ctx.agents()).map((a) => a.slug));
}

// ── tools ───────────────────────────────────────────────────────────────────

const listChannels = defineTool({
  name: "list_notification_channels",
  title: "My alert channels",
  description: "Where your agent can send you alerts: whether your Telegram is linked and whether Telegram and its alerts are switched on in Merrymen Settings (never the chat id, bot token or link code). Telegram through your own bot is the only channel; email, webhooks and push are not available.",
  capability: "notifications.manage",
  input: z.object({}).strict(),
  output: z.object({
    channels: z.array(TELEGRAM_VIEW),
    unavailable_channels: z.array(z.object({ channel: z.string(), supported: z.literal(false), why: z.string() })),
    note: z.string(),
    warnings: z.array(z.string()),
    observed_at: z.string(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler(_args, ctx) {
    const state = await channelState(ctx);
    const tg = telegramView(state);
    return {
      data: {
        channels: [tg],
        unavailable_channels: [
          { channel: "email", supported: false as const, why: "Merrymen does not send email." },
          { channel: "webhook", supported: false as const, why: "Merrymen does not call webhooks." },
          { channel: "push", supported: false as const, why: "Merrymen has no mobile push notifications." },
        ],
        note: "Alerts go through the bot token you saved in Settings to the chat that sent /link. If the bot token is removed, deliveries are recorded as skipped (no_linked_telegram).",
        warnings: settingsWarnings(state),
        observed_at: iso(ctx.now()),
      },
      summary: tg.ready === true
        ? "Telegram is linked and alerts are on."
        : `Telegram alerts are not ready${tg.how_to_fix ? `: ${tg.how_to_fix}` : "."}`,
    };
  },
});

const PARAMS_IN = z.object({
  hours: z.number().int().min(6).max(168).optional().describe("inactivity: hours without a live or paper fill (6-168)"),
  token: ADDRESS_ARG.optional().describe("watchlist_price: a stock token address with a Chainlink price feed"),
  above: z.number().positive().max(1e9).optional().describe("watchlist_price: alert at or above this USD price"),
  below: z.number().positive().max(1e9).optional().describe("watchlist_price: alert at or below this USD price"),
  period: z.enum(["day", "week"]).optional().describe("summary: day or week"),
  hour_utc: z.number().int().min(0).max(23).optional().describe("summary: the UTC hour the period ends (weekly: Mondays)"),
}).strict();

const subscribe = defineTool({
  name: "subscribe",
  title: "Subscribe to an alert",
  description: [
    "Ask your agent to send you an alert on your linked Telegram. Kinds:",
    "trade_confirmed (each live trade confirmed on chain; transfers and savings-vault moves are not announced),",
    "risk_halt (kill switch, or the drawdown breaker tripping; a breaker at most once per 6 h),",
    "provider_failure (market data, decision service or AI model failing; at most once per 6 h),",
    "stale_data (a running agent stops reporting a heartbeat; at most once per 6 h),",
    "inactivity (params.hours 6-168 without a live or paper fill),",
    "watchlist_price (params.token plus above and/or below, USD; only stock tokens with a Chainlink feed),",
    "summary (params.period day|week and params.hour_utc; live and paper reported separately).",
    "Needs a linked Telegram. Subscribing the same thing twice returns the existing subscription. At most 20 active.",
    "Your Telegram switches in Merrymen Settings still decide whether anything is sent.",
    "Alerts pause while you have no connected app allowed to manage them, and resume when you connect one.",
  ].join(" "),
  capability: "notifications.manage",
  input: z.object({
    agent: AGENT_ARG,
    kind: z.enum(NOTIFY_KINDS),
    params: PARAMS_IN.default({}),
  }).strict(),
  output: z.object({
    subscription: SUB_OUT,
    created: z.boolean().describe("False when an identical active subscription already existed"),
    channel: TELEGRAM_VIEW,
    active_subscriptions: z.number(),
    max_active_subscriptions: z.number(),
    warnings: z.array(z.string()),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  budget: { bucket: "notify_write", perMinute: 10, perHour: 60 },
  async handler(args, ctx) {
    const tenant = ctx.principal.tenant.toLowerCase();
    const kind = args.kind as NotifyKind;
    const raw = Object.fromEntries(Object.entries(args.params).filter(([, v]) => v !== undefined));
    const verdict = normalizeNotifyParams(kind, raw);
    if (!verdict.ok) throw new McpError(verdict.code, verdict.message);

    // Agent kinds are about one of the owner's agents, resolved through the
    // policy (shared with this connection AND still the owner's). A price alert
    // is about a token: an agent passed with one is still checked (so it cannot
    // probe other agents), but it is not stored — the pass never reads it, and a
    // price alert is shown to every connection of the owner, as documented.
    const isAgentKind = AGENT_KINDS.has(kind);
    let agent: OwnedAgent | null = null;
    if (isAgentKind || args.agent !== undefined) {
      const checked = await ctx.agent(args.agent);
      if (isAgentKind) agent = checked;
    }

    const state = await channelState(ctx);
    if (!isLinked(state)) {
      throw new McpError("conflict", "Link Telegram first: in Merrymen Settings → Telegram, add your bot and send it the /link code shown there. Alerts can only go to a linked chat.", {
        details: { required: "linked_telegram" },
      });
    }

    const warnings = settingsWarnings(state);
    const tg = telegramView(state);
    if (tg.ready === false && tg.how_to_fix) warnings.push(tg.how_to_fix);
    if (agent && !agent.account) warnings.push("This agent has no signed trading permission yet, so there is nothing to report until one is signed.");
    if (kind === "trade_confirmed") warnings.push("trade_confirmed reports live trades only; paper (practice) fills are not sent one by one.");

    const params = verdict.params;
    const paramsJson = canonicalParams(params);
    const slug = agent?.slug ?? null;
    const now = ctx.now();
    const d = await ctx.mcp();
    const result = await d.db.tx(async (tx) => {
      if (d.dialect === "postgres") await tx.prepare("SELECT pg_advisory_xact_lock(?)").get(tenantLockKey(tenant));
      const same = slug === null
        ? await tx.prepare(`SELECT ${SUB_COLS} FROM notify_subscriptions WHERE tenant = ? AND status = 'active' AND channel = 'telegram' AND kind = ? AND params_json = ? AND agent_slug IS NULL LIMIT 1`)
          .get(tenant, kind, paramsJson)
        : await tx.prepare(`SELECT ${SUB_COLS} FROM notify_subscriptions WHERE tenant = ? AND status = 'active' AND channel = 'telegram' AND kind = ? AND params_json = ? AND agent_slug = ? LIMIT 1`)
          .get(tenant, kind, paramsJson, slug);
      const count = async () => Number(((await tx.prepare("SELECT COUNT(*) AS n FROM notify_subscriptions WHERE tenant = ? AND status = 'active'").get(tenant)) as { n: number | string }).n);
      if (same) return { row: same as SubRow, created: false, active: await count() };
      const active = await count();
      if (active >= MAX_ACTIVE_SUBSCRIPTIONS) {
        throw new McpError("conflict", `You already have ${MAX_ACTIVE_SUBSCRIPTIONS} active alerts, the most allowed. Remove one with unsubscribe first.`, {
          details: { max_active_subscriptions: MAX_ACTIVE_SUBSCRIPTIONS },
        });
      }
      const id = newSubscriptionId();
      await tx.prepare(`INSERT INTO notify_subscriptions (id, tenant, agent_slug, channel, kind, params_json, status, connection_id, cursor_json, created_at, updated_at, last_evaluated_at)
        VALUES (?, ?, ?, 'telegram', ?, ?, 'active', ?, NULL, ?, ?, NULL)`)
        .run(id, tenant, slug, kind, paramsJson, ctx.principal.connectionId, now, now);
      const row = (await tx.prepare(`SELECT ${SUB_COLS} FROM notify_subscriptions WHERE id = ?`).get(id)) as SubRow;
      return { row, created: true, active: active + 1 };
    });
    const sub = subOut(result.row);
    return {
      data: {
        subscription: sub,
        created: result.created,
        channel: tg,
        active_subscriptions: result.active,
        max_active_subscriptions: MAX_ACTIVE_SUBSCRIPTIONS,
        warnings,
      },
      summary: `${result.created ? "Subscribed" : "Already subscribed"}: ${sub.description}${warnings.length ? ` (${warnings.length} warning(s))` : ""}`,
    };
  },
});

const listSubscriptions = defineTool({
  name: "list_subscriptions",
  title: "My alert subscriptions",
  description: "Your active alert subscriptions for the agents shared with this connection (plus price alerts): kind, parameters, what each sends, when it was last checked, and the outcome of its latest message.",
  capability: "notifications.manage",
  input: z.object({}).strict(),
  output: z.object({
    subscriptions: z.array(SUB_OUT.extend({ last_delivery: LAST_DELIVERY })),
    active_subscriptions: z.number().describe("All of your active subscriptions, including ones about agents not shared with this connection"),
    not_shown: z.number().describe("Active subscriptions about agents not shared with this connection"),
    max_active_subscriptions: z.number(),
    observed_at: z.string(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler(_args, ctx) {
    const tenant = ctx.principal.tenant.toLowerCase();
    const reachable = await reachableSlugs(ctx);
    const d = await ctx.mcp();
    const rows = (await d.db.prepare(`SELECT ${SUB_COLS} FROM notify_subscriptions WHERE tenant = ? AND status = 'active'
      ORDER BY created_at DESC, id DESC LIMIT ?`).all(tenant, MAX_ACTIVE_SUBSCRIPTIONS * 3)) as SubRow[];
    // A kind this build does not know (a row written by a newer one) is left
    // out rather than failing the whole list on the output schema.
    const shown = rows.filter((r) => visible(r, reachable) && isNotifyKind(r.kind));
    const out = [];
    for (const r of shown) {
      const last = (await d.db.prepare(`SELECT status, created_at, sent_at, last_error_code FROM notify_deliveries
        WHERE tenant = ? AND subscription_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`).get(tenant, r.id)) as
        | { status: string; created_at: number; sent_at: number | null; last_error_code: string | null }
        | undefined;
      out.push({
        ...subOut(r),
        last_delivery: last ? {
          status: last.status,
          created_at: iso(Number(last.created_at)),
          sent_at: isoOrNull(last.sent_at === null ? null : Number(last.sent_at)),
          last_error_code: last.last_error_code ?? null,
        } : null,
      });
    }
    return {
      data: {
        subscriptions: out,
        active_subscriptions: rows.length,
        not_shown: rows.length - shown.length,
        max_active_subscriptions: MAX_ACTIVE_SUBSCRIPTIONS,
        observed_at: iso(ctx.now()),
      },
      summary: out.length ? `${out.length} active alert subscription(s).` : "No active alert subscriptions.",
    };
  },
});

const unsubscribe = defineTool({
  name: "unsubscribe",
  title: "Remove an alert subscription",
  description: "Remove one of your alert subscriptions. Messages it queued that were not sent yet are dropped (recorded as skipped). Removing one already removed is a no-op.",
  capability: "notifications.manage",
  input: z.object({ subscription_id: SUBSCRIPTION_ID }).strict(),
  output: z.object({
    subscription_id: z.string(),
    status: z.literal("deleted"),
    already_deleted: z.boolean(),
    pending_dropped: z.number().describe("Queued messages that will not be sent"),
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  budget: { bucket: "notify_write", perMinute: 10, perHour: 60 },
  async handler({ subscription_id }, ctx) {
    const tenant = ctx.principal.tenant.toLowerCase();
    const reachable = await reachableSlugs(ctx);
    const d = await ctx.mcp();
    const now = ctx.now();
    const out = await d.db.tx(async (tx) => {
      const row = (await tx.prepare("SELECT id, tenant, agent_slug, status FROM notify_subscriptions WHERE id = ? AND tenant = ?").get(subscription_id, tenant)) as
        | { id: string; tenant: string; agent_slug: string | null; status: string }
        | undefined;
      if (!row || !visible(row, reachable)) throw new McpError("not_found", "No such subscription.");
      const changed = (await tx.prepare("UPDATE notify_subscriptions SET status = 'deleted', updated_at = ? WHERE id = ? AND tenant = ? AND status = 'active'")
        .run(now, subscription_id, tenant)).changes;
      const dropped = (await tx.prepare(`UPDATE notify_deliveries SET status = 'skipped', last_error_code = 'unsubscribed'
        WHERE subscription_id = ? AND tenant = ? AND status IN ('pending', 'retry')`).run(subscription_id, tenant)).changes;
      return { already: changed === 0, dropped };
    });
    return {
      data: { subscription_id, status: "deleted" as const, already_deleted: out.already, pending_dropped: out.dropped },
      summary: out.already ? "That subscription was already removed." : `Subscription removed${out.dropped ? `; ${out.dropped} queued message(s) dropped` : ""}.`,
    };
  },
});

const DELIVERY_OUT = z.object({
  delivery_id: z.string(),
  subscription_id: z.string(),
  agent: z.string().nullable(),
  kind: z.string(),
  status: z.string().describe("pending, retry (waiting to try again), sending, sent, skipped (not sent on purpose) or dead (gave up)"),
  attempts: z.number(),
  created_at: z.string(),
  next_attempt_at: z.string().nullable().describe("When it is tried next; only for pending and retry"),
  sent_at: z.string().nullable(),
  last_error_code: z.string().nullable(),
  last_error: z.string().nullable().describe("What last_error_code means"),
  book: z.string().nullable().describe("live, paper, separate (a summary of both), none (a market price) or unknown"),
  message: z.string().nullable().describe("untrusted: the message text; it can contain coin symbols written by third parties"),
});

const listDeliveries = defineTool({
  name: "list_deliveries",
  title: "Alert delivery log",
  description: "Your alert messages, newest first: kind, status (pending, retry, sent, skipped, dead), attempts, when it was queued and sent, why it failed or was skipped, and the text. Only alerts about agents shared with this connection (and price alerts).",
  capability: "notifications.manage",
  input: z.object({
    limit: LIMIT_ARG(100, 20),
    subscription_id: SUBSCRIPTION_ID.optional().describe("Only this subscription's messages"),
    cursor: z.string().max(512).optional().describe("next_cursor from a previous page"),
  }).strict(),
  output: z.object({
    deliveries: z.array(DELIVERY_OUT),
    next_cursor: z.string().nullable(),
    note: z.string(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler({ limit, subscription_id, cursor }, ctx) {
    const tenant = ctx.principal.tenant.toLowerCase();
    const scope = `deliveries:${subscription_id ?? "*"}`;
    let after: { c: number; i: string } | null = null;
    if (cursor !== undefined) {
      const v = decodeCursor(tenant, scope, cursor);
      if (!v || !isCursorInt(v.c) || typeof v.i !== "string" || v.i.length > 128) throw new McpError("invalid_input", "cursor is not a cursor from this list");
      after = { c: v.c, i: v.i };
    }
    const reachable = [...(await reachableSlugs(ctx))];
    const where = ["d.tenant = ?", "s.tenant = d.tenant"];
    const params: unknown[] = [tenant];
    where.push(reachable.length ? `(s.agent_slug IS NULL OR s.agent_slug IN (${reachable.map(() => "?").join(", ")}))` : "s.agent_slug IS NULL");
    params.push(...reachable);
    if (subscription_id) {
      where.push("d.subscription_id = ?");
      params.push(subscription_id);
    }
    if (after) {
      where.push("(d.created_at < ? OR (d.created_at = ? AND d.id < ?))");
      params.push(after.c, after.c, after.i);
    }
    const d = await ctx.mcp();
    const rows = (await d.db.prepare(`SELECT d.id, d.subscription_id, s.agent_slug, d.kind, d.status, d.attempts, d.next_attempt_at,
        d.last_error_code, d.payload_json, d.created_at, d.sent_at
      FROM notify_deliveries d JOIN notify_subscriptions s ON s.id = d.subscription_id
      WHERE ${where.join(" AND ")}
      ORDER BY d.created_at DESC, d.id DESC LIMIT ?`).all(...params, limit + 1)) as Array<{
        id: string; subscription_id: string; agent_slug: string | null; kind: string; status: string; attempts: number;
        next_attempt_at: number; last_error_code: string | null; payload_json: string; created_at: number; sent_at: number | null;
      }>;
    const page = rows.slice(0, limit);
    const deliveries = page.map((r) => {
      const payload = safeJson(r.payload_json) as { text?: unknown; book?: unknown };
      const waiting = r.status === "pending" || r.status === "retry";
      const code = r.last_error_code ?? null;
      return {
        delivery_id: r.id,
        subscription_id: r.subscription_id,
        agent: r.agent_slug,
        kind: r.kind,
        status: r.status,
        attempts: Number(r.attempts),
        created_at: iso(Number(r.created_at)),
        next_attempt_at: waiting ? isoOrNull(Number(r.next_attempt_at)) : null,
        sent_at: isoOrNull(r.sent_at === null ? null : Number(r.sent_at)),
        last_error_code: code,
        last_error: code ? DELIVERY_ERROR_TEXT[code] ?? null : null,
        book: typeof payload.book === "string" ? payload.book.slice(0, 16) : null,
        message: untrusted(typeof payload.text === "string" ? payload.text : null, 1200),
      };
    });
    const last = page[page.length - 1];
    const next = rows.length > limit && last ? encodeCursor(tenant, scope, { c: Number(last.created_at), i: last.id }) : null;
    return {
      data: { deliveries, next_cursor: next, note: UNTRUSTED_NOTE },
      summary: deliveries.length ? `${deliveries.length} alert message(s)${next ? "; more with next_cursor" : ""}.` : "No alert messages yet.",
    };
  },
});

export const NOTIFICATIONS_TOOLS = [listChannels, subscribe, listSubscriptions, unsubscribe, listDeliveries];
