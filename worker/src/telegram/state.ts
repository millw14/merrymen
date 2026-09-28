/**
 * Telegram runtime state, persisted at ~/.merrymen/telegram.json:
 *   - the getUpdates offset (so a restart doesn't replay old messages), and the
 *     bot it belongs to
 *   - the link code (shown in the dashboard; consumed by /link) and its round —
 *     the round increments on every successful link so the code ROTATES and a
 *     used code can't link a second chat
 *   - the owner chat id (first successful /link) — also the notifier's recipient
 *   - notifier bookkeeping: last trade row pinged, per-condition alert dedupe,
 *     the last day a digest went out
 *   - user-set price alerts
 *
 * The allowlist itself lives in settings.json (dashboard-editable); this file
 * is worker-managed runtime bookkeeping.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { ensureHome, homePaths } from "../home";

export interface PriceAlert {
  id: number;
  symbol: string;
  op: ">" | "<";
  price: number;
  /** Last price seen for this symbol — crossing-edge detection. */
  lastPrice?: number;
}

export interface Reminder {
  id: number;
  fireAt: number; // unix seconds
  text: string;
}

export interface Watcher {
  id: number;
  kind: "cpu" | "file" | "proc";
  /** For cpu: threshold percent (in `threshold`); for file: a path; for proc: a name. */
  arg: string;
  threshold?: number;
  /** Last observed boolean condition (cpu-above / proc-running) — edge-triggered. */
  lastState?: boolean;
  /** Last observed numeric value (file mtime ms) — change-triggered. */
  lastValue?: number;
}

export interface TelegramState {
  offset: number;
  /**
   * WHICH BOT `offset` AND `linkCode` BELONG TO: the numeric id before the ':'
   * in its token, never the token itself. Null in a file written before this
   * existed, or restored by the orchestrator, which writes only the link.
   *
   * An update id counts up per bot, so an offset carried over to a different
   * bot is meaningless: it is far past anything the new bot has sent, and
   * getUpdates returned nothing, for good. The code is the other half. It
   * belongs to the bot it was shown for, and a code minted for the old bot
   * must not link a chat on the new one.
   */
  botId: string | null;
  linkCode: string;
  /** Increments on each successful /link so the code rotates. */
  linkRound: number;
  ownerId: number | null;
  /** Unix seconds of the FIRST successful /link — the relationship’s day zero. */
  linkedAt: number | null;
  /**
   * EVERY CHAT A SUCCESSFUL /link HAS AUTHORIZED, recorded here as well as in
   * settings, because hosted the settings copy does not survive.
   *
   * The link writes the chat id into the child’s own settings.json via
   * patchSettingsFile, and hosted the orchestrator rewrites that file wholesale
   * from the tenant store every 15 seconds — so a tester linked successfully and
   * was de-authorized before they could send a second command, with the code
   * already consumed by the rotation. This file is child-owned and never
   * overwritten from above, so it is the durable record; the orchestrator reads
   * it and unions these ids back into the tenant’s stored allowlist.
   *
   * NOT AN AUTHORIZATION INPUT ON ITS OWN. service.ts still authorizes from
   * `cfg.telegramAllowlist` and nothing else; this is the list the parent
   * promotes INTO that setting, which keeps the dashboard the one place a chat
   * can be removed.
   */
  linkedChats: number[];
  /**
   * SETTINGS THE OWNER CHANGED FROM CHAT, and when — recorded here because
   * the settings copy does not survive.
   *
   * Exactly the problem `linkedChats` above solves, for the other two things
   * chat can change. `/strategy` and `/cap` called `patchSettingsFile` and
   * nothing else, so hosted they wrote a file the orchestrator replaces
   * wholesale from the tenant store fifteen seconds later: the bot replied
   * "strategy → dip-hunter", the owner watched it revert, and nothing
   * anywhere said why. Self-hosted there is no orchestrator and both always
   * worked, which is why it survived.
   *
   * The parent reads this and promotes it into the tenant's stored settings,
   * guarded on `at` so one change is applied once.
   */
  chatSettings: { at: number; patch: Record<string, unknown>; keyAt?: Record<string, number> } | null;
  /** Owner messages handled — feeds the relationship stage. */
  messageCount: number;
  /** Highest trades.id already pushed to the owner chat. -1 = not initialized. */
  lastNotifiedTradeId: number;
  /** Unix seconds of the last batched trade summary (quiet mode). */
  lastTradeDigestAt: number;
  /**
   * The reject rule whose REMEDY was last pushed to the owner.
   *
   * A refusal repeats every tick the strategist re-proposes the same leg, so
   * the instruction for fixing it must not. The refusal line still goes out
   * each time — it is a measurement, and a suppressed one is a lie about how
   * often this is happening — but "re-sign at /grant" is said once per rule and
   * then held until the rule changes. Adding a remedy without this turns one
   * confusing push per tick into one paragraph per tick.
   */
  lastRemedyRule: string | null;
  /** Condition-episode dedupe: key → unix seconds last fired. */
  firedAlerts: Record<string, number>;
  /**
   * The "sign now" state last seen, and since when — so a blocker is spoken
   * only once it has held for the settle window (sign-prompt.ts). Null when
   * nothing needs signing.
   */
  signWatch: { key: string; since: number } | null;
  /** YYYY-MM-DD of the last daily digest sent. */
  lastDigestDate: string;
  /** YYYY-MM-DD of the last journal entry. Tracked separately from the digest:
   * the journal is written even with no grant (it's about the day with its
   * owner, not about trading), so the two must not starve each other. */
  lastJournalDate: string;
  priceAlerts: PriceAlert[];
  reminders: Reminder[];
  watchers: Watcher[];
  /** Monotonic id source for reminders/watchers. */
  nextId: number;
}

const DEFAULT: TelegramState = {
  offset: 0,
  botId: null,
  chatSettings: null,
  linkCode: "",
  linkRound: 0,
  ownerId: null,
  linkedAt: null,
  linkedChats: [],
  messageCount: 0,
  lastNotifiedTradeId: -1,
  lastTradeDigestAt: 0,
  lastRemedyRule: null,
  firedAlerts: {},
  signWatch: null,
  lastDigestDate: "",
  lastJournalDate: "",
  priceAlerts: [],
  reminders: [],
  watchers: [],
  nextId: 1,
};

export function loadTelegramState(): TelegramState {
  try {
    const raw = readFileSync(homePaths.telegram(), "utf8").replace(/^﻿/, "");
    const s = JSON.parse(raw) as Partial<TelegramState>;
    return {
      offset: typeof s.offset === "number" ? s.offset : 0,
      // Only a numeric id is accepted, so a hand-edited or corrupt file can
      // never carry a token back in under this name.
      botId: typeof s.botId === "string" && /^\d+$/.test(s.botId) ? s.botId : null,
      // A malformed record is dropped rather than carried: a half-read patch
      // would be promoted to the tenant store as if the owner had asked for it.
      chatSettings:
        s.chatSettings && typeof s.chatSettings === "object" &&
        typeof s.chatSettings.at === "number" &&
        s.chatSettings.patch && typeof s.chatSettings.patch === "object"
          ? {
              at: s.chatSettings.at,
              patch: s.chatSettings.patch as Record<string, unknown>,
              // Dropping this on load would make every key look as old as the
              // record, and the next promotion would re-apply them all.
              ...(s.chatSettings.keyAt && typeof s.chatSettings.keyAt === "object"
                ? { keyAt: s.chatSettings.keyAt as Record<string, number> }
                : {}),
            }
          : null,
      linkCode: typeof s.linkCode === "string" ? s.linkCode : "",
      linkRound: typeof s.linkRound === "number" ? s.linkRound : 0,
      ownerId: typeof s.ownerId === "number" ? s.ownerId : null,
      linkedAt: typeof s.linkedAt === "number" ? s.linkedAt : null,
      linkedChats: Array.isArray(s.linkedChats)
        ? (s.linkedChats as unknown[]).filter((c): c is number => typeof c === "number")
        : [],
      messageCount: typeof s.messageCount === "number" ? s.messageCount : 0,
      lastNotifiedTradeId: typeof s.lastNotifiedTradeId === "number" ? s.lastNotifiedTradeId : -1,
      lastTradeDigestAt: typeof s.lastTradeDigestAt === "number" ? s.lastTradeDigestAt : 0,
      lastRemedyRule: typeof s.lastRemedyRule === "string" ? s.lastRemedyRule : null,
      firedAlerts: s.firedAlerts && typeof s.firedAlerts === "object" ? (s.firedAlerts as Record<string, number>) : {},
      signWatch:
        s.signWatch && typeof s.signWatch === "object" &&
        typeof s.signWatch.key === "string" && typeof s.signWatch.since === "number"
          ? { key: s.signWatch.key, since: s.signWatch.since }
          : null,
      lastDigestDate: typeof s.lastDigestDate === "string" ? s.lastDigestDate : "",
      lastJournalDate: typeof s.lastJournalDate === "string" ? s.lastJournalDate : "",
      priceAlerts: Array.isArray(s.priceAlerts)
        ? (s.priceAlerts as PriceAlert[]).filter(
            (a) =>
              a &&
              typeof a.id === "number" &&
              typeof a.symbol === "string" &&
              (a.op === ">" || a.op === "<") &&
              typeof a.price === "number",
          )
        : [],
      reminders: Array.isArray(s.reminders)
        ? (s.reminders as Reminder[]).filter((r) => r && typeof r.id === "number" && typeof r.fireAt === "number" && typeof r.text === "string")
        : [],
      watchers: Array.isArray(s.watchers)
        ? (s.watchers as Watcher[]).filter(
            (w) => w && typeof w.id === "number" && (w.kind === "cpu" || w.kind === "file" || w.kind === "proc") && typeof w.arg === "string",
          )
        : [],
      nextId: typeof s.nextId === "number" && s.nextId > 0 ? s.nextId : 1,
    };
  } catch {
    return { ...DEFAULT };
  }
}

export function saveTelegramState(state: TelegramState): void {
  try {
    ensureHome();
    writeFileSync(homePaths.telegram(), JSON.stringify(state, null, 2), "utf8");
  } catch {
    // best-effort; worst case we replay a few messages after a restart
  }
}

/**
 * The bot a token belongs to: the numeric id Telegram puts before the ':'.
 *
 * Null for anything that is not `<digits>:<secret>`. What this returns is
 * written to disk and compared in the clear, so a malformed token must give
 * nothing rather than fall back to the whole string, which is the secret.
 */
export function botIdOf(token: string): string | null {
  const m = /^(\d+):./.exec(token);
  return m ? m[1]! : null;
}

/**
 * Ensure a link code exists (6-char, unambiguous alphabet). Deterministic input
 * is required — pass a seed so this stays pure/testable and avoids Math.random
 * (which is unavailable in some sandboxes and non-reproducible). The linkRound
 * is folded into the hash so consuming a code (round++) yields a fresh one.
 */
export function ensureLinkCode(state: TelegramState, seed: string): TelegramState {
  if (state.linkCode) return state;
  const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
  const input = `${seed}:${state.linkRound}`;
  let h = 2166136261 >>> 0;
  for (const ch of input) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += ALPHABET[h % ALPHABET.length];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return { ...state, linkCode: code };
}

/** Consume the current link code: bump the round and clear it so the next
 * ensureLinkCode() mints a fresh one. Call after every successful /link. */
export function rotateLinkCode(state: TelegramState, seed: string): TelegramState {
  return ensureLinkCode({ ...state, linkCode: "", linkRound: state.linkRound + 1 }, seed);
}

/**
 * Shared mutable handle over the persisted state. The poll service and the
 * notifier both read AND write telegram.json; giving each its own in-memory
 * copy would lose writes (last save wins). One ref, every set() persists.
 */
export interface StateRef {
  get(): TelegramState;
  set(next: TelegramState): void;
}

export function createStateRef(): StateRef {
  let state = loadTelegramState();
  return {
    get: () => state,
    set: (next) => {
      state = next;
      saveTelegramState(next);
    },
  };
}

/**
 * Record a settings change the owner made FROM CHAT, for the parent to promote.
 *
 * MERGED, NOT REPLACED, and stamped with the latest time. An owner who sends
 * /strategy and then /cap has made two changes and expects both; keeping only
 * the last would apply one and drop the other with nothing to show for it.
 *
 * The stamp is what the parent's guard reads, so it must move forward on every
 * write — including a write that only repeats a value, because "already stored"
 * and "changed back to the same thing" are the same state and neither needs a
 * second promotion.
 */
export function rememberChatSetting(
  ref: { get(): TelegramState; set(next: TelegramState): void },
  patch: Record<string, unknown>,
  at: number,
): void {
  const st = ref.get();
  const prev = st.chatSettings;
  // STRICTLY LATER THAN THE LAST STAMP. `at` is whole seconds and the parent's
  // guard is `<=` its stored marker, so a second change inside the same second
  // as a promoted first one would compare equal and never be applied.
  const stamp = Math.max(at, (prev?.at ?? 0) + 1);
  // Every key written now carries this stamp; keys from earlier changes keep
  // theirs, so the parent re-applies only what is newer than its last
  // promotion (chat-settings.ts `keyAt`). A key recorded by an older build has
  // no entry and is given the old record's `at`, which is exactly when it was
  // last written.
  const keyAt: Record<string, number> = {};
  for (const k of Object.keys(prev?.patch ?? {})) keyAt[k] = prev?.keyAt?.[k] ?? prev!.at;
  for (const k of Object.keys(patch)) keyAt[k] = stamp;
  ref.set({
    ...st,
    chatSettings: { at: stamp, patch: { ...(prev?.patch ?? {}), ...patch }, keyAt },
  });
}
