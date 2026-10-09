/** Server configuration belongs at the API boundary, never in a browser helper. */
import { isHostedMode } from "@merrymen/core";
import { storeDek } from "../../../../../../worker/src/store-crypto";
import { botIdOf } from "../../../../../../worker/src/telegram/state";
import type { TelegramManagerConfig } from "@/lib/telegram-manager";

export function telegramManagerConfig(): TelegramManagerConfig | null {
  const token = process.env.MERRYMEN_TELEGRAM_MANAGER_TOKEN ?? "";
  const username = process.env.MERRYMEN_TELEGRAM_MANAGER_USERNAME ?? "";
  const webhookSecret = process.env.MERRYMEN_TELEGRAM_MANAGER_WEBHOOK_SECRET ?? "";
  if (!isHostedMode() || process.env.MERRYMEN_TELEGRAM_CREATE_ENABLED !== "true" ||
      !process.env.DATABASE_URL || !storeDek() || !botIdOf(token) ||
      !/^[A-Za-z0-9_]{5,32}$/.test(username) || !/bot$/i.test(username) ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(webhookSecret)) return null;
  return { token, username, webhookSecret };
}
