/**
 * Telegram connection status for the dashboard.
 *   GET  → { enabled, connected, botUsername, ownerId, allowlist, linkCode, control,
 *            canReadAllGroupMessages, canJoinGroups }
 *   POST → { action: "test" } validates the current/provided token live (getMe)
 *          and returns the bot @username, without saving anything.
 *
 * The bot token itself is never returned to the browser (secret). The link code
 * IS returned — but only to the account it belongs to; see below.
 *
 * THIS ROUTE ANSWERED ABOUT THE WRONG MACHINE, AND ABOUT NOBODY.
 *
 * `GET()` took no Request, so it could not resolve a tenant even in principle,
 * and it read `merrymenHome()` — the WEB container's home. Hosted, the web app
 * and the orchestrator are separate Railway services with separate filesystems:
 * the child mints its link code into `<childHome>/telegram.json` on the
 * orchestrator's disk, and nothing has ever written a `telegram.json` on the web
 * container. So six of seven fields were constants for every hosted tenant —
 * `linkCode` and `ownerId` permanently null, `enabled`/`hasToken`/`allowlist`
 * empty because /api/settings writes the per-tenant store and not that file —
 * and `control` was a constant `true` that could contradict a tenant who had
 * turned control OFF.
 *
 * Two testers stopped exactly there. Their bot connected, "the bot is listening"
 * ticked, and the panel showed a placeholder where a six-character code belongs:
 * "I'm stuck at this point, no code from /link". Everything worked except the
 * one field that came from here, because the two working signals come from
 * /api/settings and from a live getMe against the token the browser just typed.
 *
 * This is the third route in this repo with this bug — /api/feed's identity read
 * and /api/grants both had it, and /api/grants says it in as many words:
 * "different directories, different containers".
 *
 * THE LINK CODE IS A BEARER CREDENTIAL, which is why the tenant check is not
 * optional and why there is no file fallback hosted. `/link <code>` is accepted
 * from ANY chat, first-come, and on success it sets the owner and allowlists
 * that chat — so whoever holds the string can send control commands to that
 * agent. Handing one tenant another's code is not a small disclosure, and a
 * hosted request with no session must therefore get nulls, never a file read.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { merrymenHome } from "@merrymen/home";
import { isHostedMode, type MerrymenSettings } from "@merrymen/core";
import { getSettingsStore } from "@merrymen/settings-store";
import { tenantOf } from "@/lib/auth";
import { withReadDb } from "@/lib/ledger";

export const dynamic = "force-dynamic";

/** Self-hosted only: one operator, one home, and the file IS the store. */
const SETTINGS_FILE = path.join(merrymenHome(), "settings.json");
const TELEGRAM_FILE = path.join(merrymenHome(), "telegram.json");

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse((await readFile(file, "utf8")).replace(/^﻿/, "")) as T;
  } catch {
    return null;
  }
}

/**
 * This caller's settings, from wherever they actually live.
 *
 * The same shape /api/settings and /api/feed use. Hosted that is the per-tenant
 * sealed store; self-hosted it is the one file on disk.
 */
async function settingsFor(tenant: `0x${string}` | null): Promise<MerrymenSettings> {
  if (isHostedMode()) return tenant ? ((await getSettingsStore().get(tenant)) ?? {}) : {};
  return (await readJson<MerrymenSettings>(SETTINGS_FILE)) ?? {};
}

/**
 * The runtime half — minted by the child, ferried up by the orchestrator.
 *
 * Self-hosted there is no orchestrator and no ferry: the worker and the web
 * process share one MERRYMEN_HOME, so the file the child wrote IS readable here
 * and is the right answer.
 */
async function runtimeFor(
  tenant: `0x${string}` | null,
): Promise<{ linkCode: string | null; ownerId: number | null }> {
  if (!isHostedMode()) {
    const tg = (await readJson<{ linkCode?: string; ownerId?: number | null }>(TELEGRAM_FILE)) ?? {};
    return {
      linkCode: typeof tg.linkCode === "string" && tg.linkCode ? tg.linkCode : null,
      ownerId: typeof tg.ownerId === "number" ? tg.ownerId : null,
    };
  }
  // NO TENANT, NO READ. Not a file fallback and not an unscoped query — either
  // would hand a bearer credential to whoever asked.
  if (!tenant) return { linkCode: null, ownerId: null };
  return withReadDb(async (db) => {
    if (!db) return { linkCode: null, ownerId: null };
    try {
      const row = (await db
        .prepare("SELECT link_code, owner_id FROM tenant_telegram WHERE tenant = ?")
        .get(tenant.toLowerCase())) as { link_code?: string | null; owner_id?: number | null } | undefined;
      return {
        linkCode: typeof row?.link_code === "string" && row.link_code ? row.link_code : null,
        ownerId: typeof row?.owner_id === "number" ? row.owner_id : null,
      };
    } catch {
      // The table is created by the orchestrator on its own clock, so a brand
      // new deployment can be asked before it exists. Unknown, not empty.
      return { linkCode: null, ownerId: null };
    }
  });
}

/**
 * What getMe says about the bot: its @username, and the two getMe-only flags
 * Telegram groups need (docs/tg-groups.md "What it can hear: privacy mode").
 */
interface BotInfo {
  username: string;
  /** `can_read_all_group_messages`: true when BotFather privacy mode is OFF. Null when getMe did not say. */
  canReadAllGroupMessages: boolean | null;
  /** `can_join_groups`: false when BotFather /setjoingroups is disabled. Null when getMe did not say. */
  canJoinGroups: boolean | null;
}

/**
 * The getMe answer, read strictly: no username means no bot, and a flag that is
 * not a real boolean is UNKNOWN (null), never false. "Privacy mode is on" is a
 * claim with instructions attached, and an answer that simply lacked the field
 * must not be the thing that makes it.
 */
function readBotInfo(body: unknown): BotInfo | null {
  const b = body as { ok?: unknown; result?: { username?: unknown; can_read_all_group_messages?: unknown; can_join_groups?: unknown } } | null;
  if (!b || b.ok !== true || !b.result || typeof b.result.username !== "string" || b.result.username === "") return null;
  const flag = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
  return {
    username: b.result.username,
    canReadAllGroupMessages: flag(b.result.can_read_all_group_messages),
    canJoinGroups: flag(b.result.can_join_groups),
  };
}

/** getMe against the Bot API — returns what it says about the bot, or null. */
async function botInfo(token: string): Promise<BotInfo | null> {
  try {
    // A TIMEOUT, because this is now reachable. While `hasToken` was
    // permanently false hosted, this call never fired; with the token resolving
    // correctly it runs on every Settings mount, save and test, once per tenant.
    // Bounded work on a third party belongs behind a clock.
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(8_000),
    });
    return readBotInfo(await res.json());
  } catch {
    return null;
  }
}

/** getMe against the Bot API — returns the @username or null. */
async function botUsername(token: string): Promise<string | null> {
  return (await botInfo(token))?.username ?? null;
}

export interface TelegramStatus {
  enabled: boolean;
  hasToken: boolean;
  connected: boolean;
  botUsername: string | null;
  ownerId: number | null;
  allowlist: number[];
  linkCode: string | null;
  /**
   * Whether the chat may CHANGE anything, or only answer questions.
   *
   * worker/src/telegram/executor.ts gates every CONTROL_KIND on this and
   * otherwise replies "control commands are turned off". Without the flag here,
   * a client can only guess — and the phone's Settings screen was about to tell
   * people "/pause stops it" with no way to know whether that is true for them.
   * A stop instruction that might be a locked door is worse than no instruction.
   */
  control: boolean;
  /**
   * BotFather privacy mode, read live from the same getMe that sets
   * `connected`: true when privacy mode is OFF and the bot can follow the
   * whole of a group's conversation, false when it is on and the bot hears
   * only commands and replies to itself. Null when unknown — no token, getMe
   * failed, or it did not say — which is not the same as "on", and the
   * screens show the steps without a verdict then. Optional so an older
   * server's answer still reads as unknown.
   *
   * It reports the BotFather setting only: a bot already in a group before
   * privacy was turned off keeps hearing the old way until it is removed and
   * added back, and Telegram offers no way to ask which groups that is.
   */
  canReadAllGroupMessages?: boolean | null;
  /** BotFather /setjoingroups: false means the bot cannot be added to groups at all. Null when unknown. */
  canJoinGroups?: boolean | null;
}

export async function GET(req: Request) {
  const tenant = isHostedMode() ? tenantOf(req) : null;
  const settings = await settingsFor(tenant);
  const runtime = await runtimeFor(tenant);
  const token = settings.telegramBotToken;

  const status: TelegramStatus = {
    enabled: settings.telegramEnabled === true,
    hasToken: typeof token === "string" && token.length > 8,
    connected: false,
    botUsername: null,
    ownerId: runtime.ownerId,
    allowlist: Array.isArray(settings.telegramAllowlist) ? settings.telegramAllowlist : [],
    linkCode: runtime.linkCode,
    // `!== false`, not `=== true`: the field defaults to true (core settings
    // DEFAULTS, mirrored by worker/src/settings.ts's bool() resolution), so an
    // absent key means enabled. `=== true` would report control off for every
    // install that never touched the toggle.
    control: settings.telegramControlEnabled !== false,
    canReadAllGroupMessages: null,
    canJoinGroups: null,
  };
  if (status.hasToken) {
    // ONE getMe for all of it — the username, and the two flags Telegram
    // groups need. A second call per Settings mount would double the work on
    // a third party for a fact the first answer already carries.
    const bot = await botInfo(token!);
    status.connected = bot !== null;
    status.botUsername = bot?.username ?? null;
    status.canReadAllGroupMessages = bot?.canReadAllGroupMessages ?? null;
    status.canJoinGroups = bot?.canJoinGroups ?? null;
  }
  return NextResponse.json(status);
}

export async function POST(req: Request) {
  let body: { action?: string; token?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad body" }, { status: 400 });
  }
  if (body.action !== "test") return NextResponse.json({ error: "unknown action" }, { status: 400 });

  // Use the provided token (typed but not yet saved) or the stored one — the
  // stored one now being THIS caller's, not the container's.
  let token = typeof body.token === "string" && body.token.trim().length > 8 ? body.token.trim() : undefined;
  if (!token) {
    const tenant = isHostedMode() ? tenantOf(req) : null;
    token = (await settingsFor(tenant)).telegramBotToken;
  }
  if (!token) return NextResponse.json({ ok: false, reason: "no token set" });

  const username = await botUsername(token);
  return username
    ? NextResponse.json({ ok: true, username })
    : NextResponse.json({ ok: false, reason: "token rejected by Telegram (getMe failed)" });
}
