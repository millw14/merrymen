/**
 * Telegram connection status for the dashboard.
 *   GET  → { enabled, connected, botUsername, ownerId, allowlist, linkCode,
 *            linkPending, listening, control }
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
import { isBotToken } from "@/lib/telegram-claims";
import { telegramListening, type Listening, type TelegramRuntime } from "@/lib/telegram-listening";

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
 *
 * With it, whether anything is hearing the bot and whether the tenant trades
 * (lib/telegram-listening.ts, which decides what the screen may say from
 * these). Null when there is nothing to read.
 */
async function runtimeFor(tenant: `0x${string}` | null): Promise<TelegramRuntime | null> {
  if (!isHostedMode()) {
    const tg = (await readJson<{ linkCode?: string; ownerId?: number | null; botId?: unknown; poll?: unknown }>(TELEGRAM_FILE)) ?? {};
    // The worker's own record, as it wrote it. Self-hosted runs no holds.
    const botId = typeof tg.botId === "string" && /^\d+$/.test(tg.botId) ? tg.botId : null;
    const poll = (tg.poll && typeof tg.poll === "object" ? tg.poll : {}) as { okAt?: unknown; err?: unknown; errAt?: unknown; botId?: unknown };
    const ours = botId !== null && poll.botId === botId;
    return {
      linkCode: typeof tg.linkCode === "string" && tg.linkCode ? tg.linkCode : null,
      ownerId: typeof tg.ownerId === "number" ? tg.ownerId : null,
      botId,
      pollOkAt: ours && typeof poll.okAt === "number" ? poll.okAt : null,
      pollErr: ours && typeof poll.err === "string" ? poll.err : null,
      pollErrAt: ours && typeof poll.errAt === "number" ? poll.errAt : null,
      childState: null,
    };
  }
  // NO TENANT, NO READ. Not a file fallback and not an unscoped query — either
  // would hand a bearer credential to whoever asked.
  if (!tenant) return { linkCode: null, ownerId: null };
  return withReadDb(async (db) => {
    if (!db) return { linkCode: null, ownerId: null };
    type Row = {
      link_code?: string | null;
      owner_id?: number | null;
      bot_id?: string | null;
      poll_ok_at?: number | string | null;
      poll_err?: string | null;
      poll_err_at?: number | string | null;
      child_state?: string | null;
    };
    const base = (row: Row | undefined) => ({
      linkCode: typeof row?.link_code === "string" && row.link_code ? row.link_code : null,
      ownerId: typeof row?.owner_id === "number" ? row.owner_id : null,
    });
    try {
      const row = (await db
        .prepare(
          "SELECT link_code, owner_id, bot_id, poll_ok_at, poll_err, poll_err_at, child_state FROM tenant_telegram WHERE tenant = ?",
        )
        .get(tenant.toLowerCase())) as Row | undefined;
      if (!row) return null;
      return {
        ...base(row),
        botId: typeof row.bot_id === "string" && row.bot_id ? row.bot_id : null,
        pollOkAt: row.poll_ok_at === null || row.poll_ok_at === undefined ? null : Number(row.poll_ok_at),
        pollErr: typeof row.poll_err === "string" ? row.poll_err : null,
        pollErrAt: row.poll_err_at === null || row.poll_err_at === undefined ? null : Number(row.poll_err_at),
        childState: typeof row.child_state === "string" ? row.child_state : null,
      };
    } catch {
      // The liveness columns are added by the orchestrator on its own clock
      // (telegram-store.ts), and the web can be deployed first. Read what was
      // always there; the rest stays undefined, which the decision reads as
      // "not published here yet" rather than as "nothing heard".
    }
    try {
      const row = (await db
        .prepare("SELECT link_code, owner_id FROM tenant_telegram WHERE tenant = ?")
        .get(tenant.toLowerCase())) as Row | undefined;
      return base(row);
    } catch {
      // The table is created by the orchestrator on its own clock, so a brand
      // new deployment can be asked before it exists. Unknown, not empty.
      return { linkCode: null, ownerId: null };
    }
  });
}

/** getMe against the Bot API — returns the @username or null. */
async function botUsername(token: string): Promise<string | null> {
  // Only a token of Telegram's shape is sent: it goes into the URL's path, and
  // one carrying '/', '..' or '?' would ask somewhere else (lib/telegram-claims.ts).
  if (!isBotToken(token)) return null;
  try {
    // A TIMEOUT, because this is now reachable. While `hasToken` was
    // permanently false hosted, this call never fired; with the token resolving
    // correctly it runs on every Settings mount, save and test, once per tenant.
    // Bounded work on a third party belongs behind a clock.
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(8_000),
    });
    const body = (await res.json()) as { ok?: boolean; result?: { username?: string } };
    return body.ok && body.result?.username ? body.result.username : null;
  } catch {
    return null;
  }
}

export interface TelegramStatus {
  enabled: boolean;
  hasToken: boolean;
  connected: boolean;
  botUsername: string | null;
  ownerId: number | null;
  allowlist: number[];
  /**
   * The code to send with /link, or null. Only a code minted for the bot of
   * the token saved now (lib/telegram-listening.ts): a code for another bot
   * would not link this one.
   */
  linkCode: string | null;
  /**
   * A token is saved whose bot the agent has not picked up yet, so there is
   * no code for it: "waiting for your agent to pick up the new bot".
   */
  linkPending: boolean;
  /**
   * WHETHER ANYTHING IS HEARING THE BOT, as the process polling it recorded,
   * and whether trading is held. `connected` is only getMe against the token:
   * it said "connected" throughout days in which nothing polled the bot.
   */
  listening: Listening;
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
}

export async function GET(req: Request) {
  const tenant = isHostedMode() ? tenantOf(req) : null;
  const settings = await settingsFor(tenant);
  const runtime = await runtimeFor(tenant);
  const token = settings.telegramBotToken;
  const seen = telegramListening(runtime, token, Math.floor(Date.now() / 1000));

  const status: TelegramStatus = {
    enabled: settings.telegramEnabled === true,
    hasToken: typeof token === "string" && token.length > 8,
    connected: false,
    botUsername: null,
    ownerId: runtime?.ownerId ?? null,
    allowlist: Array.isArray(settings.telegramAllowlist) ? settings.telegramAllowlist : [],
    linkCode: seen.linkCode,
    linkPending: seen.linkPending,
    listening: seen.listening,
    // `!== false`, not `=== true`: the field defaults to true (core settings
    // DEFAULTS, mirrored by worker/src/settings.ts's bool() resolution), so an
    // absent key means enabled. `=== true` would report control off for every
    // install that never touched the toggle.
    control: settings.telegramControlEnabled !== false,
  };
  if (status.hasToken) {
    const username = await botUsername(token!);
    status.connected = username !== null;
    status.botUsername = username;
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
