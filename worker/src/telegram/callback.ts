/**
 * Inline-button (Confirm/Cancel) resolution — extracted from the Telegram poll
 * service so the whole decision surface is testable without a live bot.
 *
 * The pending slot is keyed chat:from, so only the SAME user who parked an
 * action can confirm or cancel it. The button's nonce is matched against the
 * live pending, so a stale button left over from a superseded ask is refused.
 * Resolution runs through the exact same executor confirm/cancel branch as
 * typing /confirm (same re-vetting, same gates). The parked message is edited
 * in place to the outcome (buttons removed) and the tap is acknowledged with a
 * toast. Only the tapper who OWNS a pending slot may have a message edited.
 */

import { esc, type TgCallback } from "./api";
import type { Command } from "./interpreter";
import type { PendingAction } from "./executor";

/** Read a pending entry, sweeping expired ones on read so a slot that lapsed
 * stops blocking new parks and stops steering the model's hint. */
export function livePendingEntry(
  pending: Map<string, PendingAction>,
  key: string,
  now: number,
): PendingAction | null {
  const p = pending.get(key);
  if (!p) return null;
  if (now > p.expiresAt) {
    pending.delete(key);
    return null;
  }
  return p;
}

/** Everything `resolveCallback` needs, injected so tests can drive it without
 * a poll loop, a config file, or the network. */
export interface ResolveCallbackCtx {
  token: string;
  allowlist: number[];
  pending: Map<string, PendingAction>;
  now: () => number;
  /** Bound to executeCommand + the peer's cmdDeps — the confirm/cancel branch. */
  execute: (action: Command) => Promise<string>;
  note: (level: "ok" | "warn", message: string) => void;
  answer: (queryId: string, extra?: { text?: string }) => Promise<unknown>;
  edit: (chatId: number, messageId: number, text: string) => Promise<{ ok: boolean }>;
  send: (chatId: number, text: string) => Promise<unknown>;
}

export async function resolveCallback(cb: TgCallback, ctx: ResolveCallbackCtx): Promise<void> {
  const { chatId, fromId } = cb;
  const key = `${chatId}:${fromId}`;

  // Same gates as the message path (service handle): the chat must be
  // allowlisted, and in a group only individually-allowlisted senders may
  // resolve state-changing actions. This is what makes revocation kill the
  // buttons instantly and blocks a group member tapping another's confirm.
  const allowed = ctx.allowlist.includes(cb.chatId) || ctx.allowlist.includes(cb.fromId);
  if (!allowed) {
    await ctx.answer(cb.queryId, { text: "not authorized." });
    return;
  }
  if (cb.chatId !== cb.fromId && !ctx.allowlist.includes(cb.fromId)) {
    await ctx.answer(cb.queryId, { text: "in a group, only individually-allowlisted users can confirm." });
    return;
  }

  // Parse `confirm:<nonce>` / `cancel:<nonce>` from the closed set. Anything
  // else is an unknown/foreign button: toast, never edit.
  const [verb, nonce] = cb.data.split(":", 2);
  if ((verb !== "confirm" && verb !== "cancel") || !nonce) {
    await ctx.answer(cb.queryId, { text: "unknown button." });
    return;
  }

  const action: Command | null = verb === "confirm" ? { kind: "confirm" } : { kind: "cancel" };
  const live = livePendingEntry(ctx.pending, key, ctx.now());

  // No live pending for THIS tapper (expired/swept, never parked, or another
  // user's button in a shared chat): acknowledge the tap so the button stops
  // spinning, but never touch the message — it isn't theirs to edit.
  if (!live) {
    await ctx.answer(cb.queryId, {});
    return;
  }

  // The tapper owns a pending slot, but this button was attached to a
  // DIFFERENT ask (stale, superseded): refuse, and edit only their own stale
  // message to say so.
  if (live.nonce !== nonce) {
    await ctx.answer(cb.queryId, { text: "this ask was superseded." });
    await ctx.edit(chatId, cb.messageId, "this ask was superseded — a newer action is waiting.");
    return;
  }

  let reply: string;
  try {
    reply = await ctx.execute(action);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    ctx.note("warn", `Telegram: ${cb.data} callback failed — ${m}`);
    reply = `🚫 that ${cb.data} failed: ${esc(m.slice(0, 200))}`;
  }
  await ctx.answer(cb.queryId, {
    text: verb === "confirm" ? "Confirmed ✓" : "Cancelled",
  });
  const edited = await ctx.edit(chatId, cb.messageId, reply);
  if (!edited.ok) await ctx.send(chatId, reply);
}