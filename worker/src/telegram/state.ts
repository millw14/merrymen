/**
 * Telegram runtime state, persisted at ~/.merrymen/telegram.json:
 *   - the getUpdates offset (so a restart doesn't replay old messages), the bot
 *     it belongs to, and where any other bot this agent polled got to
 *   - the link code (shown in the dashboard; consumed by /link) and its round —
 *     a random code, replaced by a different one on every successful link, so a
 *     used code can't link a second chat
 *   - the owner chat id (first successful /link) — also the notifier's recipient
 *   - notifier bookkeeping: last trade row pinged, per-condition alert dedupe,
 *     the last day a digest went out
 *   - user-set price alerts
 *   - how the last polls of the bot went, for the dashboard and the
 *     orchestrator's liveness alert
 *
 * The allowlist itself lives in settings.json (dashboard-editable); this file
 * is worker-managed runtime bookkeeping.
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFileAtomicSync } from "../atomic-write";
import { ensureHome, homePaths } from "../home";
import { cleanPollErr } from "./poll-rules";

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
  /**
   * WHERE EVERY OTHER BOT THIS AGENT POLLED GOT TO, newest first, at most
   * PRIOR_BOTS_KEPT of them. Only bots with a non-zero offset are kept, since
   * 0 is what a bot never seen starts at anyway.
   *
   * Telegram forgets an update only when the NEXT getUpdates for that bot asks
   * past it. So the last batch handled on a bot is still waiting on Telegram's
   * side when the token changes, and it stays there for up to a day. Resetting
   * to 0 on a return to that bot hands the batch over again, and a /buy in it
   * runs twice. A bot this agent has polled before resumes at its own offset;
   * only a bot never seen starts at its first update.
   */
  priorBots: { botId: string; offset: number }[];
  /**
   * A one-way fingerprint of the token the link code was minted under
   * (tokenTagOf), never the token. Null in a file written before this existed,
   * or restored by the orchestrator.
   *
   * A new secret for the same bot re-mints the code. The code used to be
   * derived from the token, so whoever held the replaced token could derive
   * it; it is random now, but a secret is replaced because the old one got
   * out, and a code issued while it was out is not worth keeping. Held in
   * memory only, a change made while the process was down was missed: the
   * restarted child adopted the stored code.
   */
  tokenTag: string | null;
  /**
   * When the loop was last switched onto `botId` from a different bot, unix
   * seconds; null when it never was (a first run, or a file from before this
   * existed).
   *
   * Anything that bot was sent before then was sent while this agent was not
   * listening to it: perhaps while it served another agent. service.ts answers
   * those messages but acts on none of them (holdEarly).
   */
  boundAt: number | null;
  linkCode: string;
  /**
   * How many times the code has been rotated. A count and nothing more: the
   * code used to be a hash of the token and this round, and is random now.
   */
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
   *
   * It only ever grows, so the parent promotes each LINK once, by its time in
   * `linkedChatAt` below (link.ts linksToPromote). Promoting the whole list
   * on every pass put a chat the owner had removed on the dashboard back into
   * the allowlist fifteen seconds later, with full command authority, until
   * a redeploy wiped this file.
   */
  linkedChats: number[];
  /**
   * WHEN EACH CHAT IN `linkedChats` LAST LINKED, unix seconds, keyed by chat
   * id. A chat that links again, with a fresh code, gets a new time, and that
   * new link is promoted again; the old one never is. A chat with none (a
   * file from before this was kept) reads as linked at 0.
   */
  linkedChatAt: Record<string, number>;
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
  /**
   * WHETHER ANYTHING IS HEARING THE BOT (recordPoll). Null until the first
   * getUpdates, and in a file from before this existed.
   */
  poll: PollHealth | null;
}

/**
 * HOW THE LAST POLLS OF THE BOT WENT, written by whichever process polls it
 * (the child, or the hold process while trading is held) and read by the
 * orchestrator: published to the dashboard, and watched for a bot nobody has
 * heard in a while (orchestrator.ts telegramLiveness).
 *
 * Nothing recorded this, so nothing could say it. In the incident this came
 * from the bot went unpolled for days while the dashboard showed "connected"
 * and a link code nobody could use: "connected" was a getMe the web ran
 * against the token, which says the token is good and nothing about whether
 * anything is listening.
 *
 * The last failure is KEPT after a success, with its time, rather than
 * cleared. Two programs polling one bot take turns failing with 409, so a
 * process that cleared it would look healthy half the time; what says whether
 * it is failing NOW is which of `okAt` and `errAt` is later.
 */
export interface PollHealth {
  /** When a getUpdates last worked, unix seconds. Null until one has. */
  okAt: number | null;
  /** The last failure, as poll-rules.ts pollErrText writes it: `<kind>: <detail>`. */
  err: string | null;
  /** When `err` was last seen, unix seconds. */
  errAt: number | null;
  /** The bot these are about (botIdOf). What was heard on another bot says nothing about this one. */
  botId: string | null;
}

/**
 * A poll whose outcome matches the last one recorded is written at most this
 * often. Every poll would be a write of telegram.json twice a minute for
 * nothing; the readers need minutes, not seconds (the dashboard calls a bot
 * live for three, the orchestrator alerts after ten).
 */
export const POLL_RECORD_EVERY_SEC = 30;

/**
 * How far past the reader's clock a recorded poll time may be and still be
 * believed. recordPoll stamps a success one second past a failure in the
 * same second, so a record can run a little ahead; a time far ahead would
 * read as "heard" until that moment came.
 */
const POLL_CLOCK_SKEW_SEC = 300;

/**
 * The poll record as a file gave it, or null when it is missing or malformed.
 *
 * READ AS UNTRUSTED, by the orchestrator as much as by the child. The file is
 * in the tenant's home, which an agent with shell or file tools can write,
 * and what is read here goes into the orchestrator's own log lines and the
 * shared database. So the error text gets the writer's rules again
 * (poll-rules.ts cleanPollErr: no line breaks, nothing shaped like a token,
 * clipped), and a time is believed only as whole seconds between the epoch
 * and a little past `now`: a fraction or a far-future stamp is a value no
 * poller wrote, and the database's integer columns would refuse the first.
 */
export function parsePollHealth(raw: unknown, now = Math.floor(Date.now() / 1000)): PollHealth | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const sec = (v: unknown): number | null =>
    typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= now + POLL_CLOCK_SKEW_SEC ? v : null;
  const err = typeof p.err === "string" ? cleanPollErr(p.err) : "";
  return {
    okAt: sec(p.okAt),
    err: err !== "" ? err : null,
    errAt: sec(p.errAt),
    // The same rule as `botId` above: a number, never anything a token could hide in.
    botId: typeof p.botId === "string" && /^\d+$/.test(p.botId) ? p.botId : null,
  };
}

/**
 * Did the last recorded poll work? Only when its success is strictly later
 * than its failure; recordPoll never writes the two in the same second, and a
 * tie in a file from elsewhere is read as failing (telegram-liveness.ts
 * pollFailingNow, the same rule).
 */
function lastPollWorked(p: PollHealth): boolean {
  return p.okAt !== null && (p.errAt === null || p.okAt > p.errAt);
}

/**
 * `at`, or one second past `other` when it is not already later. Seconds are
 * coarse: a 409 and the good poll ten seconds later are far apart, but a
 * failure and a success can land in the same second, and the record must
 * still say which came last.
 */
const after = (at: number, other: number | null): number => (other !== null && at <= other ? other + 1 : at);

/**
 * RECORD ONE POLL of bot `botId` at `at`: `err` null when it worked, or the
 * failure as pollErrText wrote it. The same state object comes back when
 * there is nothing worth writing, so the caller can skip the save.
 *
 * Written at once when the answer changes: the first poll of a bot, a success
 * after a failure or the other way round, or a different failure. Otherwise at
 * most every POLL_RECORD_EVERY_SEC.
 */
export function recordPoll(state: TelegramState, botId: string | null, at: number, err: string | null): TelegramState {
  // A record about a different bot is dropped, not carried: its successes were
  // not this bot's.
  const prev = state.poll && state.poll.botId === botId ? state.poll : null;
  const next: PollHealth =
    err === null
      ? { okAt: after(at, prev?.errAt ?? null), err: prev?.err ?? null, errAt: prev?.errAt ?? null, botId }
      : { okAt: prev?.okAt ?? null, err, errAt: after(at, prev?.okAt ?? null), botId };
  const changed = prev === null || (err === null) !== lastPollWorked(prev) || (err !== null && err !== prev.err);
  if (!changed) {
    const last = err === null ? prev.okAt : prev.errAt;
    if (last !== null && at - last < POLL_RECORD_EVERY_SEC) return state;
  }
  return { ...state, poll: next };
}

/**
 * How many other bots' offsets are remembered. A returning bot only matters
 * inside the day Telegram keeps its updates, and eight different bots in a
 * day is not something an owner does, even fumbling a paste.
 */
export const PRIOR_BOTS_KEPT = 8;

const DEFAULT: TelegramState = {
  offset: 0,
  botId: null,
  priorBots: [],
  tokenTag: null,
  boundAt: null,
  chatSettings: null,
  linkCode: "",
  linkRound: 0,
  ownerId: null,
  linkedAt: null,
  linkedChats: [],
  linkedChatAt: {},
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
  poll: null,
};

/**
 * `linkedChatAt` as read back from a file: chat ids and positive, finite
 * times, and nothing else. The orchestrator reads the same record, and what
 * it promotes lands in the tenant's stored allowlist.
 */
export function parseLinkedChatAt(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [chat, at] of Object.entries(v as Record<string, unknown>)) {
    if (/^-?\d+$/.test(chat) && typeof at === "number" && Number.isFinite(at) && at > 0) out[chat] = at;
  }
  return out;
}

export function loadTelegramState(): TelegramState {
  try {
    const raw = readFileSync(homePaths.telegram(), "utf8").replace(/^﻿/, "");
    const s = JSON.parse(raw) as Partial<TelegramState>;
    return {
      offset: typeof s.offset === "number" ? s.offset : 0,
      // Only a numeric id is accepted, so a hand-edited or corrupt file can
      // never carry a token back in under this name.
      botId: typeof s.botId === "string" && /^\d+$/.test(s.botId) ? s.botId : null,
      // The same rule for the ids kept here. A malformed entry is dropped rather
      // than trusted: the worst it costs is one bot starting from its first
      // update, which is what it did before this list existed.
      priorBots: Array.isArray(s.priorBots)
        ? (s.priorBots as unknown[])
            .filter(
              (b): b is { botId: string; offset: number } =>
                !!b && typeof b === "object" &&
                typeof (b as { botId?: unknown }).botId === "string" &&
                /^\d+$/.test((b as { botId: string }).botId) &&
                typeof (b as { offset?: unknown }).offset === "number" &&
                (b as { offset: number }).offset > 0,
            )
            .map((b) => ({ botId: b.botId, offset: b.offset }))
            .slice(0, PRIOR_BOTS_KEPT)
        : [],
      tokenTag: typeof s.tokenTag === "string" && /^[0-9a-f]{16}$/.test(s.tokenTag) ? s.tokenTag : null,
      boundAt: typeof s.boundAt === "number" ? s.boundAt : null,
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
      linkedChatAt: parseLinkedChatAt(s.linkedChatAt),
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
      poll: parsePollHealth(s.poll),
    };
  } catch {
    return { ...DEFAULT };
  }
}

/**
 * REPLACED WHOLE, never truncated and refilled. This file is the only record
 * of who the owner is, and loadTelegramState reads one that does not parse as
 * a fresh default: a process that died inside a truncating write came back
 * unlinked, with nothing to say why, and saved that default over the file. The
 * orchestrator restores a lost link only when the file is MISSING, so a
 * half-written one was never repaired. And it reads this file every pass
 * (readChildTelegram) while the child writes it, so a torn read skipped that
 * pass's publish and promotion.
 */
export function saveTelegramState(state: TelegramState): void {
  try {
    ensureHome();
    writeFileAtomicSync(homePaths.telegram(), JSON.stringify(state, null, 2), 0o600);
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
 *
 * THE SECRET MUST BE ONE TELEGRAM COULD HAVE ISSUED: letters, digits, '_' and
 * '-' (base64url), and nothing else. A token is pasted into the path of
 * `https://api.telegram.org/bot<token>/getMe`, and getMe's answer is what
 * vouches for a bot claim (telegram-claims.ts). This used to accept anything
 * after `<digits>:`, so `111:x/../../bot<own token>/getChat?chat_id=111&z=`
 * read as bot 111, the URL parser resolved its dot segments into a call on
 * the sender's own bot, and that call's answer, carrying id 111, "confirmed"
 * a stranger as bot 111's owner. No '/', '.', '?', '#', '%' or space can
 * reach a URL from here, and nothing a real owner pastes is refused.
 *
 * The id is the number, not the digits typed: `0111:…` is bot 111, the id
 * getMe answers and the claims are keyed on, so a zero in front cannot give
 * one bot a second claim.
 */
export function botIdOf(token: string): string | null {
  const m = /^0*([1-9]\d*):[A-Za-z0-9_-]+$/.exec(token);
  return m ? m[1]! : null;
}

/**
 * A fingerprint of the token: the first 16 hex characters of its SHA-256.
 *
 * Enough to tell that the secret changed, and nothing an attacker can use: the
 * secret behind it is far too long to guess, and the token itself sits in
 * plain text in settings.json in the same home anyway.
 */
export function tokenTagOf(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/**
 * Move the state onto a DIFFERENT bot. Where the bot being left got to is
 * remembered, and the new one resumes where this agent last left it, or at
 * its first update if it never polled it (priorBots says why that matters).
 * The link code is cleared for the caller to re-mint, and `boundAt` marks
 * everything the new bot was sent before `at` as not meant for this agent.
 */
export function switchBot(state: TelegramState, botId: string, tokenTag: string, at: number): TelegramState {
  const leaving = state.botId !== null && state.offset > 0 ? [{ botId: state.botId, offset: state.offset }] : [];
  const others = state.priorBots.filter((b) => b.botId !== botId && b.botId !== state.botId);
  return {
    ...state,
    botId,
    tokenTag,
    offset: state.priorBots.find((b) => b.botId === botId)?.offset ?? 0,
    priorBots: [...leaving, ...others].slice(0, PRIOR_BOTS_KEPT),
    boundAt: at,
    linkCode: "",
  };
}

/**
 * THE STATE BOUND TO THE BOT `token` BELONGS TO, and what binding it changed.
 * The pure half of service.ts bindBot, which says why each case is what it is;
 * shared with the hold process (hold.ts), so that whichever of the two polls
 * the bot, telegram.json ends up the same.
 *
 * - `invalid`: not a token Telegram would accept; nothing changes.
 * - `adopted`: no bot on file (a file from before botId, or one the
 *   orchestrator restored). This bot is recorded and nothing is reset.
 * - `switched`: a different bot. It resumes where this agent last left it
 *   (switchBot), with a fresh code.
 * - `renewed`: the same bot with a different secret, or none recorded beside
 *   it. The offset stands; the code is rotated. `told` is false when there was
 *   no fingerprint to compare, which is a migration rather than a renewal.
 * - `same`: nothing changes.
 */
export function bindToken(
  state: TelegramState,
  token: string,
  at: number,
  rng: LinkRng = randomBytes,
):
  | { change: "invalid"; state: TelegramState }
  | { change: "same"; state: TelegramState }
  | { change: "adopted"; state: TelegramState }
  | { change: "switched"; state: TelegramState }
  | { change: "renewed"; state: TelegramState; told: boolean } {
  const botId = botIdOf(token);
  if (!botId) return { change: "invalid", state };
  const tag = tokenTagOf(token);
  if (state.botId === null) return { change: "adopted", state: { ...state, botId, tokenTag: tag } };
  if (state.botId !== botId) return { change: "switched", state: ensureLinkCode(switchBot(state, botId, tag, at), rng) };
  if (state.tokenTag === tag) return { change: "same", state };
  return { change: "renewed", state: rotateLinkCode({ ...state, tokenTag: tag }, rng), told: state.tokenTag !== null };
}

/** Where a link code's randomness comes from: `n` random bytes. Injectable so a test can pin a code. */
export type LinkRng = (n: number) => Uint8Array;

/** Six characters from 31 that cannot be misread for each other: no 0/O/1/I/L. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
/** The largest multiple of the alphabet's size that fits in a byte (8 × 31). */
const CODE_BYTE_LIMIT = 248;

/**
 * A fresh code from `rng`. Bytes of 248 and over are thrown away rather than
 * folded in with `%`, which would make the first eight letters likelier than
 * the rest. Bounded, so an rng that only ever returns unusable bytes throws
 * rather than spinning the poll loop for ever.
 */
function mintCode(rng: LinkRng): string {
  let code = "";
  for (let round = 0; round < 64 && code.length < CODE_LENGTH; round++) {
    for (const b of rng(CODE_LENGTH * 2)) {
      if (b >= CODE_BYTE_LIMIT) continue;
      code += CODE_ALPHABET[b % CODE_ALPHABET.length];
      if (code.length === CODE_LENGTH) break;
    }
  }
  if (code.length < CODE_LENGTH) throw new Error("link code: the random source gave no usable bytes");
  return code;
}

/**
 * Ensure a link code exists: six random characters from an unambiguous
 * alphabet. A code already there is kept, so the one on the dashboard stays
 * valid until it is used.
 *
 * RANDOM, NOT DERIVED. It used to be a hash of the token and `linkRound`, which
 * did not rotate the way it claimed. A hosted redeploy loads telegram.json with
 * the round back at 0, so the first link after one minted hash(token:1), a code
 * that had already been issued and perhaps already used. And when the restored
 * code was itself that round-1 code, "rotating" after a link re-minted the very
 * code just spent. Anyone holding the token could also compute every code.
 */
export function ensureLinkCode(state: TelegramState, rng: LinkRng = randomBytes): TelegramState {
  if (state.linkCode) return state;
  return { ...state, linkCode: mintCode(rng) };
}

/**
 * Consume the current link code: a new one that is never the one just used,
 * and one more round. Call after every successful /link.
 *
 * A repeat of six random characters is one in 887 million, but "a used code
 * cannot link again" is the whole point of rotating, so it is ruled out
 * rather than left to chance. Bounded like mintCode, for the same reason.
 */
export function rotateLinkCode(state: TelegramState, rng: LinkRng = randomBytes): TelegramState {
  for (let i = 0; i < 16; i++) {
    const code = mintCode(rng);
    if (code !== state.linkCode) return { ...state, linkCode: code, linkRound: state.linkRound + 1 };
  }
  throw new Error("link code: the random source keeps repeating the code just used");
}

/**
 * How far past the stored round a code from the old derivation is looked for.
 * The old restore put the round back to 0 on every redeploy while the code it
 * restored could be from any round, so the stored round says little. Each
 * round costs one short hash, once per token per process.
 */
const LEGACY_ROUNDS_PAST = 64;

/**
 * The code the old scheme gave `token` at `round`: FNV-1a over
 * `${token}:${round}`, exactly as ensureLinkCode computed it before codes were
 * random. Kept for one thing only, recognising such a code so it can be
 * retired. Nothing may mint with it.
 */
function legacyCode(token: string, round: number): string {
  let h = 2166136261 >>> 0;
  for (const ch of `${token}:${round}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[h % CODE_ALPHABET.length];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return code;
}

/**
 * RETIRE A CODE THE OLD SCHEME DERIVED FROM THIS TOKEN: rotated, like any
 * rotation, so the caller should forgive lockouts. Anything else is returned
 * as it is, the same object.
 *
 * Random codes alone did not end the exposure they were meant to end. Every
 * code minted before them is a hash of the token, which anyone holding the
 * token can compute, and hosted each one was also printed into the fleet's
 * shared logs as it was minted ("link code ready — send /link XXXXXX"). Such a
 * code survives the upgrade: it sits in telegram.json, or the orchestrator
 * restores it from the mirror, and ensureLinkCode keeps a code that is there.
 * For a tenant who had not linked yet, whoever read that log line could still
 * send it and become the owner. So a stored code that the old scheme gives
 * this token, at any round up to the stored one plus LEGACY_ROUNDS_PAST, is
 * replaced once; the random code that replaces it is then published and
 * restored like any other, and is never matched again.
 *
 * What this cannot see is a code the old scheme derived from a token the bot
 * no longer has. The token is never stored, so there is nothing to derive it
 * from.
 */
export function retireLegacyCode(state: TelegramState, token: string, rng: LinkRng = randomBytes): TelegramState {
  if (!state.linkCode) return state;
  // A corrupt round must not shrink the search to nothing, or stretch it without end.
  const stored = Number.isSafeInteger(state.linkRound) && state.linkRound > 0 ? Math.min(state.linkRound, 10_000) : 0;
  const code = state.linkCode.toUpperCase();
  for (let round = 0; round <= stored + LEGACY_ROUNDS_PAST; round++) {
    if (legacyCode(token, round) === code) return rotateLinkCode(state, rng);
  }
  return state;
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
