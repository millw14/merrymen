/**
 * THE SOCIAL-TRADING RESEARCH, AS A TELEGRAM GROUP MAY HEAR IT
 * (docs/fomo.md "Telegram groups"; docs/tg-groups.md rules 2 and 3).
 *
 * The group handler (telegram/tg-groups/) may not import anything under
 * fomo/ (tg-groups/boundary.test.ts), so it reaches the research through
 * `TgFomoPort`, and this root-level adapter implements it over the research
 * broker, as tg-trade-facts.ts implements the public trade projection.
 *
 * WHAT IT DECIDES FROM TRUSTED CONTEXT ONLY. The tenant is the broker's (the
 * orchestrator stamps it from which child asked; self-hosted, the install's
 * own). The audience is fixed: "group". The group id is the chat id Telegram
 * delivered the line in, which the handler passes from the update, never from
 * the text. The conversation key is built from that same chat id and topic.
 * The asker's words reach only the deterministic planner, as data.
 *
 * WHAT A GROUP NEVER HEARS. The planner deflects a question about one trader
 * or the owner's own research state before anything is spent; the renderer
 * gives a group coin-level aggregates (no wallets, addresses, links, cashtags
 * or quoted third-party text, money in short form) and scrubs the result. The
 * one place a group hears traders named is Fomo's public leaderboard: its
 * handles and their P&L, never as @mentions, never who Merrymen follows
 * (Milla's call, 2026-10-07). This file rewrites the renderer's fixed wording
 * into words the group gate admits (no money figure for the feed's size floor,
 * no "P&L", no vendor-plumbing words in the source line). The handler still
 * gates every line before it is sent, as a `research` line, and drops what the
 * gate refuses rather than bending the gate.
 *
 * NO MODEL. A group answer is deterministic: no compose, so no model can be
 * talked into wording a trader's wallet into a room.
 */

import type { FomoBroker } from "./fomo/contract";
import { answerFomoQuestion } from "./fomo/chat";
import { classifyFomoQuestion } from "./fomo/intent";
import { FOMO_ATTRIBUTION, GROUP_DM_DEFLECTION, groupScrub, NOT_PERMISSION_LINE } from "./fomo/render";
import type { TgFomoAnswer, TgFomoPort } from "./telegram/tg-groups/types";

/** The most a group answer may run to, before the handler's own line gate. */
export const TG_FOMO_MAX_CHARS = 600;

/**
 * The attribution as a group line. FOMO_ATTRIBUTION names the provider's
 * plumbing ("API") and the app's domain, both of which the group gate refuses
 * (ops vocabulary, a link). Same facts: the data is Fomo's, it came through an
 * independent service, and that service is not affiliated with Fomo Family.
 */
export const TG_FOMO_SOURCE = "Source: Fomo via fomoapi (independent; not affiliated with Fomo Family)";

/** NOT_PERMISSION_LINE in group words: the original names a dashboard setting, which the group gate refuses. */
export const TG_FOMO_NOT_PERMISSION = "This is research, not a signal to buy or sell.";

/**
 * A question a group never hears answered: a trader, or the owner's own
 * research state. GROUP_DM_DEFLECTION says "I'll answer that in a direct
 * message", and nothing here sends that message, so the room is told where
 * the question belongs instead of being promised an answer.
 */
export const TG_FOMO_DEFLECTION = "That one is for a direct message, not the group.";

/** Said for a research question when no research is reachable from this agent. */
export const TG_FOMO_UNAVAILABLE = "Fomo research isn't available here right now.";

export interface TgFomoPortOptions {
  /** Milliseconds. */
  now?: () => number;
  maxChars?: number;
  /** Counts and kinds only, never text, ids or names. */
  log?: (line: string) => void;
}

/** "tg-group:<chatId>:<threadId|0>": per room and forum topic, from the trusted update. */
export function tgGroupConversationKey(chatId: number, threadId?: number): string {
  const topic = typeof threadId === "number" && Number.isSafeInteger(threadId) && threadId > 0 ? threadId : 0;
  return `tg-group:${chatId}:${topic}`;
}

/**
 * The renderer's fixed wording, put into words the group gate admits. Only
 * phrases this code base writes itself are rewritten; third-party text never
 * reaches a group render at all.
 */
export function groupWords(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.trim() === FOMO_ATTRIBUTION) return TG_FOMO_SOURCE;
      if (line.trim() === NOT_PERMISSION_LINE) return TG_FOMO_NOT_PERMISSION;
      return line
        // The leaderboard's own caveat, without "P&L", which the gate keeps for the agent's own book.
        .replace(/\bP&L (?:is the|figures are) provider-reported realised P&L(?: for the window)?, not a measure of skill(?:; follower counts are not used)?\./g, "Figures are money made on closed trades, as the source reports it, and not a measure of skill.")
        .replace(/\(positions above (?:about |roughly |around )?\$[\d,]+(?:\.\d+)?; a floor, not a census\)/g, "(large positions only; a floor, not a census)")
        .replace(/positions above (?:about |roughly |around )?\$[\d,]+(?:\.\d+)?/g, "large positions")
        .replace(/\bprovider-reported\b/g, "source-reported")
        .replace(/\bProvider stats\b/g, "Source stats")
        // "2m ago" reads as two million to the gate's money clause.
        .replace(/\b(\d{1,3})m( ago|\b)/g, "$1 min$2");
    })
    .join("\n");
}

const isUsableChatId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v !== 0;

/** The handler's selfNamesOf list, bounded: strings only, at most 16 of 64 characters. */
function selfNamesOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((n): n is string => typeof n === "string" && n.trim() !== "" && n.length <= 64).slice(0, 16);
}

/** One lookup's longest share of a group answer. */
const CALL_MS = 15_000;

/**
 * The broker held to the room's reply deadline: each lookup gets the smaller
 * of its share and what is left, plus an abort at the deadline, so nothing is
 * still being spent after the room has been told the answer is late. Memory
 * reads and writes give up at the deadline too.
 */
function boundedBroker(b: FomoBroker, ms: number): { broker: FomoBroker; done: () => void } {
  const until = Date.now() + ms;
  const left = (): number => until - Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(0, ms));
  (timer as { unref?: () => void }).unref?.();
  const within = <T>(p: Promise<T>, fallback: T): Promise<T> => {
    const t = left();
    if (t <= 0) return Promise.resolve(fallback);
    let h: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([p, new Promise<T>((r) => (h = setTimeout(() => r(fallback), t)))]).finally(() => h && clearTimeout(h));
  };
  return {
    broker: {
      call: (tool, args, opts) => b.call(tool, args, { ...opts, timeoutMs: Math.max(1, Math.min(opts.timeoutMs ?? CALL_MS, CALL_MS, left())), signal: ac.signal }),
      memory: {
        get: (k) => within(Promise.resolve().then(() => b.memory.get(k)), null),
        set: (k, j) => within(Promise.resolve().then(() => b.memory.set(k, j)), undefined),
        clear: (k) => within(Promise.resolve().then(() => b.memory.clear(k)), undefined),
      },
      report: (r) => b.report(r),
      configured: () => b.configured(),
    },
    done: () => {
      clearTimeout(timer);
      ac.abort();
    },
  };
}

/**
 * The group port over a broker getter (index.ts passes the child's broker).
 * Every method resolves; nothing throws into the group handler.
 */
export function createTgFomoPort(broker: () => FomoBroker | null, opts: TgFomoPortOptions = {}): TgFomoPort {
  const now = opts.now ?? Date.now;
  const maxChars = Math.max(200, Math.min(TG_FOMO_MAX_CHARS, Math.trunc(opts.maxChars ?? TG_FOMO_MAX_CHARS)));
  const log = opts.log ?? (() => {});
  /** The conversation keys used per chat, so the owner's chat-wide forget reaches every topic. Bounded. */
  const keysByChat = new Map<number, Set<string>>();
  const remember = (chatId: number, key: string): void => {
    let keys = keysByChat.get(chatId);
    if (!keys) {
      if (keysByChat.size >= 512) keysByChat.delete(keysByChat.keys().next().value!);
      keys = new Set();
      keysByChat.set(chatId, keys);
    }
    if (keys.size < 64) keys.add(key);
  };

  const brokerNow = (): FomoBroker | null => {
    try {
      return broker() ?? null;
    } catch {
      return null;
    }
  };

  return {
    async ask(q): Promise<TgFomoAnswer | null> {
      try {
        if (!q || typeof q.text !== "string" || !q.text.trim() || !isUsableChatId(q.chatId)) return null;
        const b = brokerNow();
        const t = now();
        // The bot's own @username and names (trusted: from getMe and the
        // soul, via the handler), so "@thisbot theses on $PONS?" is a coin
        // question and not a question about a trader called thisbot.
        const selfNames = selfNamesOf(q.selfNames);
        if (!b) {
          // Honest about it, but only for a question the research would have taken.
          return classifyFomoQuestion(q.text, { memory: null, now: t, selfNames }) ? { text: TG_FOMO_UNAVAILABLE, deflect: false } : null;
        }
        const conversationKey = tgGroupConversationKey(q.chatId, q.threadId);
        const timeoutMs = typeof q.timeoutMs === "number" && Number.isFinite(q.timeoutMs) ? Math.max(1, Math.min(q.timeoutMs, 30_000)) : 25_000;
        const bounded = boundedBroker(b, timeoutMs);
        const r = await answerFomoQuestion({
          text: q.text,
          broker: bounded.broker,
          now: t,
          surface: "telegram-group",
          audience: "group",
          conversationKey,
          // The trusted chat id: per-group budgets are keyed on it, and a
          // group charge without it is refused (fail closed).
          groupId: String(q.chatId),
          maxChars,
          selfNames,
        }).finally(() => bounded.done());
        if (!r.handled) return null;
        remember(q.chatId, conversationKey);
        if (r.text.trim() === GROUP_DM_DEFLECTION) {
          log("[tg-fomo] group ask deflected");
          return { text: TG_FOMO_DEFLECTION, deflect: true };
        }
        log(`[tg-fomo] group ask answered (${r.toolsCalled.length} lookup(s))`);
        return { text: groupScrub(groupWords(groupScrub(r.text))), deflect: false };
      } catch {
        log("[tg-fomo] group ask failed");
        return null;
      }
    },
    async forget(chatId: number): Promise<void> {
      const keys = keysByChat.get(chatId);
      keysByChat.delete(chatId);
      const b = brokerNow();
      if (!b) return;
      // Topic 0 always: a forget after a restart must still reach the room's main thread.
      const all = new Set([...(keys ?? []), tgGroupConversationKey(chatId)]);
      for (const k of all) {
        try {
          await b.memory.clear(k);
        } catch {
          /* subject memory expires on its own (30 minutes) */
        }
      }
    },
  };
}
