/**
 * TELLING AN OWNER, ONCE, THAT THEIR TRADING IS HELD.
 *
 * The rules of the one unsolicited message a hold sends (orchestrator.ts
 * noteHold decides when to try; this decides whether it goes and records that
 * it went), with the database, the recipient and the sender passed in, so the
 * rules can be driven over sqlite and a fake bot. The orchestrator passes
 * Postgres, hostedRecipient and telegramSend.
 *
 * - To the chat that proved the /link code (tenant_telegram.owner_id), through
 *   the owner's own bot, as the kill confirmation goes. Unlike that one, it
 *   obeys the alert switches (Telegram on, alerts not off), because nobody
 *   asked for it.
 * - And only while that chat is still on the owner's allowlist. owner_id is the
 *   first chat that ever linked and nothing clears it, so an owner who took
 *   that chat off the allowlist on the dashboard would otherwise still have a
 *   chat they revoked told that their agent stopped, and why.
 * - Once per class per hold, across redeploys: `told` is read from the durable
 *   record (tenant_telegram.hold_notified), never from memory alone.
 * - AT LEAST ONCE, NOT AT MOST: the class is recorded after the send. A repeat
 *   after a crash between the two is a nuisance; a notice lost to a failed send
 *   is the silence this exists to end.
 */
import type { Db } from "./db";
import { holdNoticeText } from "./restore-block";
import { holdNotifiedClasses, recordHoldNotified } from "./telegram-store";

/**
 * What became of one attempt: `sent` now, `told` already (this class,
 * durably), or neither this time: `no-owner` (no linked chat, no bot, Telegram
 * or alerts switched off, or the linked chat no longer allowed) and `failed`.
 * Only the first two stop the attempts.
 */
export type HoldNoticeOutcome = "sent" | "told" | "no-owner" | "failed";

export interface HoldNoticeDeps {
  /** Where hold_notified lives. The column must exist (TELEGRAM_HOLD_NOTIFIED_DDL). */
  db: Db;
  /** The owner's chat and bot, and whether the switches allow a message (hostedRecipient). */
  recipient: (tenant: `0x${string}`) => Promise<{ botToken: string; chatId: number; enabled: boolean } | null>;
  /** The chats the owner allows now: the stored settings' telegramAllowlist. */
  allowlist: (tenant: `0x${string}`) => Promise<readonly number[]>;
  send: (botToken: string, chatId: number, text: string) => Promise<{ ok: boolean; reason?: string }>;
  log: (line: string) => void;
}

/**
 * `resettable`: whether the notice offers the practice reset (holdNoticeText).
 * It is not part of what counts as told: once per class, whichever it said.
 */
export async function notifyHoldOnce(
  deps: HoldNoticeDeps,
  tenant: `0x${string}`,
  cls: string,
  resettable: boolean,
): Promise<HoldNoticeOutcome> {
  try {
    const to = await deps.recipient(tenant);
    if (!to || !to.enabled) return "no-owner";
    const allowed = await deps.allowlist(tenant);
    if (!allowed.some((id) => Number(id) === Number(to.chatId))) return "no-owner";
    if ((await holdNotifiedClasses(deps.db, tenant)).includes(cls)) return "told";
    const sent = await deps.send(to.botToken, to.chatId, holdNoticeText(cls, resettable));
    if (!sent.ok) {
      deps.log(`${tenant}: trading held, but the owner notice did not send — ${sent.reason ?? "unknown"}`);
      return "failed";
    }
    await recordHoldNotified(deps.db, tenant, cls);
    deps.log(`${tenant}: owner told that trading is held (${cls})`);
    return "sent";
  } catch (e) {
    deps.log(`${tenant}: trading held, but the owner notice failed — ${e instanceof Error ? e.message : String(e)}`);
    return "failed";
  }
}
