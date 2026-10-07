/**
 * THE TAIL NOTIFIER — the I/O around tail-notices.ts, in the owner's child.
 *
 * Each Telegram notifier pass asks `next()` for the tail notices due now. It:
 *
 *   1. reads the durable sent log (fomo-child.ts FOMO_STATE_KEYS.tailNotified)
 *      through the strict broker memory read. A read that is not a proven
 *      answer is UNKNOWN, and an unknown log sends NOTHING: it fails closed,
 *      because guessing "nothing sent yet" after a redeploy would tell the
 *      owner everything twice;
 *   2. claims the thesis reads it will make (at most 2 a pass, 1 per tail and
 *      coin, 2 per tail) in that log, durably, BEFORE reading, then reads each
 *      with one `fomo_get_token_theses {token, chain, trader, limit: 3}` call
 *      as the owner from the DM surface, 8 s each. A claimed read whose answer
 *      a crash lost is never made again;
 *   3. returns the notices, each with `claim()`: the log with that notice
 *      recorded, written and read back. The caller sends a notice only after
 *      its claim returned true, so a crash between the two loses a notice and
 *      never repeats one (at most once).
 *
 * Nothing here decides who receives a notice (the Telegram notifier's own
 * gates do: Telegram on, notifications on, a linked owner) and nothing here
 * can trade: the reads are read tools, the notices are text.
 */

import { FOMO_STATE_KEYS, type DurableStatePort, type FollowReadiness } from "../fomo-child";
import type { ChildTail, FomoBroker } from "./contract";
import {
  emptyTailLog,
  parseTailLog,
  serializeTailLog,
  tailNotices,
  tailThesisReads,
  type TailNotice,
  type TailNoticeInput,
  type TailSentLog,
} from "./tail-notices";
import type { TokenThesesData } from "./tools";
import type { FollowAssessment } from "./types";

/** One thesis read's wall-clock bound (the Telegram notifier loop is serial). */
export const TAIL_THESIS_READ_TIMEOUT_MS = 8_000;
/** Read answers kept in this process, so a notice waiting on its read finds it. */
const READ_CACHE_MAX = 100;

export interface TailNotifierDeps {
  /** The tenant's durable store (fomo-child.ts brokerDurableState). */
  durable: DurableStatePort;
  broker(): FomoBroker | null;
  /** fomo-child.ts FomoChild.tails(). */
  tails(): readonly ChildTail[];
  /** fomo-child.ts FomoChild.followReadiness(); null when unknown. */
  readiness(): FollowReadiness | null;
  assessmentOf(tokenKey: string): FollowAssessment | null;
  holds?(tokenKey: string): boolean;
  /** The operator's switch: false (MERRYMEN_FOMO_TAILS=0) sends nothing and reads nothing. Absent: on. */
  enabled?(): boolean;
  now?(): number;
  log?(line: string): void;
  /** The durable key (default FOMO_STATE_KEYS.tailNotified). */
  key?: string;
}

/** A Telegram inline keyboard, structurally (telegram/api.ts InlineKeyboard). */
export type TailKeyboard = { text: string; callbackData: string }[][];

export interface TailNoticeToSend {
  /** Code-written Telegram HTML; send with link previews off. */
  html: string;
  /** Stop and +1h (`ftl:stop:<userId>`, `ftl:ext:<userId>`); empty for an end summary. */
  keyboard: TailKeyboard;
  kind: TailNotice["kind"];
  /** Record this notice durably (written and read back). Call BEFORE sending; send only on true. Never throws. */
  claim(): Promise<boolean>;
}

export interface TailNotifier {
  next(): Promise<TailNoticeToSend[]>;
}

export function createTailNotifier(deps: TailNotifierDeps): TailNotifier {
  const key = deps.key ?? FOMO_STATE_KEYS.tailNotified;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const reads = new Map<string, string | null | "failed">();
  const said = new Set<string>();
  const once = (k: string, line: string): void => {
    if (said.has(k)) return;
    said.add(k);
    log(line);
  };

  const remember = (k: string, v: string | null | "failed"): void => {
    reads.delete(k);
    reads.set(k, v);
    while (reads.size > READ_CACHE_MAX) reads.delete(reads.keys().next().value as string);
  };

  const write = async (l: TailSentLog): Promise<boolean> => {
    try {
      return await deps.durable.write(key, serializeTailLog(l));
    } catch {
      return false;
    }
  };

  /** The newest excerpt of theirs on the coin, null for none, "failed" when the read did not answer. */
  const readThesis = async (b: FomoBroker, userId: string, token: { address: string; chain: { slug: string | null } }): Promise<string | null | "failed"> => {
    try {
      const env = await b.call(
        "fomo_get_token_theses",
        { token: token.address, ...(token.chain.slug ? { chain: token.chain.slug } : {}), trader: userId, limit: 3 },
        { surface: "telegram-dm", audience: "owner", priority: "interactive", conversationKey: null, timeoutMs: TAIL_THESIS_READ_TIMEOUT_MS },
      );
      if (!["ok", "empty", "capped", "partial", "stale"].includes(env.status) || !env.data) return "failed";
      const theses = (env.data as TokenThesesData).theses ?? [];
      // Only THEIR words: a row by anyone else is never shown as theirs.
      const mine = theses.filter((t) => t && typeof t.author?.userId === "string" && t.author.userId.toLowerCase() === userId.toLowerCase() && typeof t.excerpt === "string" && t.excerpt.trim());
      if (mine.length === 0) return null;
      const newest = [...mine].sort((x, y) => (y.postedAt ?? 0) - (x.postedAt ?? 0))[0]!;
      return newest.excerpt;
    } catch {
      return "failed";
    }
  };

  return {
    async next(): Promise<TailNoticeToSend[]> {
      try {
        if (deps.enabled && deps.enabled() !== true) return [];
        const tails = deps.tails();
        if (tails.length === 0) return [];
        const at = now();
        // 1. The sent log, proven or nothing.
        const r = await deps.durable.read(key);
        if (r.kind === "unknown") {
          once("unknown", "[fomo] tail notices wait: the sent log could not be read");
          return [];
        }
        let sent: TailSentLog;
        if (r.kind === "absent") sent = emptyTailLog(0);
        else {
          const parsed = parseTailLog(r.text);
          if (!parsed) {
            // A log nobody can read starts over AT NOW: nothing before it is told (at most once, never twice).
            once("corrupt", "[fomo] tail sent log unreadable; starting over from now");
            await write(emptyTailLog(at));
            return [];
          }
          sent = parsed;
        }
        const input = (l: TailSentLog): TailNoticeInput => ({
          tails,
          log: l,
          now: at,
          readiness: safe(() => deps.readiness(), null),
          assessmentOf: (k) => safe(() => deps.assessmentOf(k), null),
          holds: (k) => safe(() => deps.holds?.(k) === true, false),
          thesisRead: (userId, tokenKey) => reads.get(`${userId}|${tokenKey}`),
          canRead: deps.broker() !== null,
        });
        // 2. Thesis reads: claimed durably first, then made.
        const planned = tailThesisReads(input(sent));
        if (planned.reads.length > 0) {
          if (!(await write(planned.log))) return [];
          sent = planned.log;
          const b = deps.broker();
          for (const want of planned.reads) {
            remember(`${want.userId}|${want.tokenKey}`, b ? await readThesis(b, want.userId, want.token) : "failed");
          }
        }
        // 3. The notices, each with its own claim.
        const { notices } = tailNotices(input(sent));
        return notices.map((n) => ({
          html: n.html,
          kind: n.kind,
          keyboard: n.buttons.length > 0 ? [n.buttons.map((x) => ({ text: x.text, callbackData: x.data }))] : [],
          claim: () => write(n.logAfter),
        }));
      } catch (e) {
        once(`threw:${e instanceof Error ? e.name : "error"}`, `[fomo] tail notices skipped (${e instanceof Error ? e.name : "error"})`);
        return [];
      }
    },
  };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
