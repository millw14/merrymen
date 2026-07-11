/**
 * Telegram connection status for the dashboard.
 *   GET  → { enabled, connected, botUsername, owner, allowlist, linkCode }
 *   POST → { action: "test" } validates the current/provided token live (getMe)
 *          and returns the bot @username, without saving anything.
 *
 * The bot token itself is never returned to the browser (secret). The link code
 * IS returned — it's a low-value one-time code the user needs to send from
 * Telegram to claim ownership.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { merrymenHome } from "@/lib/home";
import type { MerrymenSettings } from "@merrymen/core";

export const dynamic = "force-dynamic";

const SETTINGS_FILE = path.join(merrymenHome(), "settings.json");
const TELEGRAM_FILE = path.join(merrymenHome(), "telegram.json");

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse((await readFile(file, "utf8")).replace(/^﻿/, "")) as T;
  } catch {
    return null;
  }
}

/** getMe against the Bot API — returns the @username or null. */
async function botUsername(token: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
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
  linkCode: string | null;
}

export async function GET() {
  const settings = (await readJson<MerrymenSettings>(SETTINGS_FILE)) ?? {};
  const tg = (await readJson<{ linkCode?: string; ownerId?: number | null }>(TELEGRAM_FILE)) ?? {};
  const token = settings.telegramBotToken;

  const status: TelegramStatus = {
    enabled: settings.telegramEnabled === true,
    hasToken: typeof token === "string" && token.length > 8,
    connected: false,
    botUsername: null,
    ownerId: typeof tg.ownerId === "number" ? tg.ownerId : null,
    allowlist: Array.isArray(settings.telegramAllowlist) ? settings.telegramAllowlist : [],
    linkCode: typeof tg.linkCode === "string" && tg.linkCode ? tg.linkCode : null,
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

  // Use the provided token (typed but not yet saved) or the stored one.
  let token = typeof body.token === "string" && body.token.trim().length > 8 ? body.token.trim() : undefined;
  if (!token) {
    const settings = (await readJson<MerrymenSettings>(SETTINGS_FILE)) ?? {};
    token = settings.telegramBotToken;
  }
  if (!token) return NextResponse.json({ ok: false, reason: "no token set" });

  const username = await botUsername(token);
  return username
    ? NextResponse.json({ ok: true, username })
    : NextResponse.json({ ok: false, reason: "token rejected by Telegram (getMe failed)" });
}
