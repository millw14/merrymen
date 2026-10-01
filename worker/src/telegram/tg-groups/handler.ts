/**
 * Telegram groups — the handler: what the poll service hands a group update
 * to, and the one place a group line is sent from. The contract is
 * docs/tg-groups.md, all of it; this file is where its pieces meet.
 *
 * WHAT LIVES WHERE. Whether to speak is pacing.ts (pure); what a line says is
 * voice.ts (templates, one gated model call, the line gate); coins go through
 * coins.ts, which reaches trading only through `TgCoinsPort`; memory is the
 * store plus memory.ts. This file decides nothing those modules decide. It
 * reads the update, keeps the books (who added it, what was said, who got an
 * answer), and sends — typing, a person's pace, Telegram's flood limits.
 * Addressed factual questions read narrowly typed public evidence through
 * read-only ports; facts.ts formats it without a model or owner money.
 *
 * NEVER ON THE POLL LOOP'S TIME. Every `on*` method returns at once: the work
 * goes onto a per-chat serial queue, so a slow model, a slow coin look or a
 * Telegram 429 in one group never delays the owner's DMs, their buttons or
 * /kill (rule 7). Only bookkeeping that must be in order with the next update
 * (room status, the line itself) happens before returning.
 *
 * AND NO READ ON THE CHAT'S QUEUE. A coin look reads the chain and
 * GeckoTerminal; the queue runs one line at a time, so a look awaited there
 * held every later line of that chat, and an owner asking "didnt you see?"
 * went unanswered until the answer was stale. The coin flow owns a CA line as
 * soon as it has decided so (coins.ts `begin`) and does the reads on its own
 * per-chat lane; addressed follow-up reads are detached too. The queue moves
 * on to the next line at once.
 *
 * AN ADDRESSED LINE THAT GETS NOTHING SAYS WHY, to the operator: one log line,
 * "[tg-groups] addressed line got nothing (<code>)", with a stable code
 * (`Quiet`) and never the text, a name, an id or an address.
 *
 * NEVER THROWS, AND NEVER SAYS WHY. Every method catches everything. A failure
 * of any kind is at most one log line naming the stage and the error's class —
 * never message text, a name, a title or an address — and in the group it is
 * silence (rule 5).
 *
 * WHAT IS NOT HERE ON PURPOSE. No trading module is imported (types.ts): a
 * coin crosses as a nomination through the port and nothing else. No group
 * text is written anywhere but the tg-groups store: not chat_turns, not the
 * event feed (`note` carries counts and kinds only), not the soul, not peers or
 * research files. The persona is built from voice.ts's fixed, group-safe
 * context and never from the DM prompt builders (rule 3).
 *
 * NAMING: never write the web room's name (group + chat, joined or separated)
 * in code here. See types.ts.
 */
import { isHostedMode } from "../../../../packages/core/src/index";
import type { ResolvedConfig } from "../../settings";
import {
  answerCallbackQuery,
  editMessageText,
  esc,
  leaveChat,
  sendChatAction,
  sendMessage,
  setMessageReaction,
  type InlineKeyboard,
  type TelegramOpts,
  type TgCallback,
  type TgMemberUpdate,
  type TgMessage,
  type TgServiceMessage,
} from "../api";
import type { StateRef } from "../state";
import { CoinFlow, type CoinIntent, type CoinPostEnd, type CoinQuiet, type CoinSpeakOpts } from "./coins";
import {
  addressedHow,
  addressedSmallTalk,
  asksAboutCoin,
  extractCaHits,
  extractCas,
  extractCashtags,
  greetingOf,
  hasForeignMint,
  hasOtherChainLink,
  insultLevel,
  isBotQuestion,
  isDistress,
  isInjection,
  isPrivateAsk,
  isQuestionToRoom,
  isShush,
  isTradeTalk,
  selfNamesOf,
  type BotSelf,
  type SmallTalk,
} from "./detect";
import { admitTgLine } from "./gate";
import { publicCoinReason, publicFactRequest, type PublicFactRequest } from "./facts";
import { applyMemoryPass, memoryPass, needsMemoryPass } from "./memory";
import {
  describeTgGroupsModel,
  resolveTgGroupsModel,
  TgModelGate,
  tgGroupsDedicatedKeyProblem,
  tgGroupsPerDay,
  type TgModel,
} from "./model";
import {
  CHATTINESS,
  FLOOD_WINDOW_MS,
  REACTION_FOR,
  ROAST_WINDOW_MS,
  SendPacer,
  decide,
  isFlooded,
  typingDelayMs,
  type PaceDecision,
  type PaceInput,
} from "./pacing";
import { TG_LIMITS, utcDay, type TgGroupsStore } from "./store";
import type { Chattiness, CoinLook, TgCoinMemo, TgCoinsPort, TgGroupFactsPort, TgLine, TgPerson, TgPublicFact, TgRoom } from "./types";
import { mentionFor, say, type SpeakCtx, type TgIntent } from "./voice";

// ─── The numbers ───────────────────────────────────────────────────────────

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A line that waited longer than this to go out is dropped (coin outcomes excepted). */
const STALE_MS = 90 * SEC;
/** One person's addressed lines closer together than this are one burst: only their last is answered. */
const BURST_MS = 15 * SEC;
/** A question to the room waits this long, so pacing can see whether anyone answered it. */
const QUESTION_WAIT_MS = MIN;
/** An ambient line is dropped when this many newer human lines arrived while it was being written. */
const NEWER_LINES_DROP = 3;
/** Welcomes: the odds per join, and the most per chat per UTC day. */
const WELCOME_ODDS = 0.25;
const WELCOMES_PER_DAY = 3;
/** Shush: how long it stays quiet, and how often the answer is a 🙈 rather than words. */
const SHUSH_MS = 30 * MIN;
const OWNER_SHUSH_MS = 2 * HOUR;
const SHUSH_REACT_ODDS = 0.25;
/** "still not sold on that one tbh": the odds per line that names a faded coin, and how often per coin. */
const FADED_ODDS = 0.15;
const FADED_EVERY_MS = 6 * HOUR;
/** Casual refusals ("that's between me and {owner}", "only my owner can do that"): once per person per hour. */
const REFUSE_EVERY_MS = HOUR;
/**
 * /forgetme's "done 🫡": at most once per person per chat this often. The
 * wipe itself is never limited; only the words are, so one member typing
 * /forgetme over and over cannot fill the chat, or its queue, with them.
 */
const FORGOT_ME_EVERY_MS = 10 * MIN;
/** A stranger's group the owner never answered about is left after this. */
const PENDING_LEAVE_MS = DAY;
/** A failed Stay/Leave DM is tried again at most this often. */
const ASK_RETRY_MS = HOUR;
/** The background pass: pending rooms, the quiet-hours memory pass. */
const SWEEP_MS = 5 * MIN;
/**
 * The age limits (14-day lines and coins, 30-day left rooms, 2-day claims)
 * are applied by a sweep at most this often. The store applies them when it
 * opens, but a child can run for weeks; the privacy policy's limits hold for
 * a process that never restarts too.
 */
const PRUNE_EVERY_MS = HOUR;
/** How long a resolved model is trusted before settings are read again. */
const MODEL_RECHECK_MS = MIN;
// The flood and roast windows, and the flood rule itself (FLOOD_ANSWERS per
// person per window, never the owner), are pacing.ts's: imported, not
// mirrored. Pacing reads the windows; this file opens and extends them after
// a line lands, and holds the coin flow's lines to the same rule (pacing
// never sees those: the coin flow owns a CA line).
/**
 * What a tag shows when the sender's display name is not something the
 * agent would say. The tag's id still pings the right person; only the words
 * on it change (see tagLabel).
 */
const NEUTRAL_TAG = "fren";
/** At most this many lines waiting per chat. Past it, new chatter is remembered but not answered. */
const MAX_QUEUED = 40;
/**
 * A GROUP JOB THAT NEVER FINISHES MUST NOT SILENCE THE GROUP. Every job and
 * every send is bounded where it is written, but a single missed bound — a
 * provider that holds a connection open, an await on something that never
 * settles — used to hold the chat's serial queue (or its send lock) for good:
 * live, a group went silent for hours with not one log line, because every
 * later line waited behind it. Past this long the queue moves on without it
 * and the log names the step it was stuck at.
 */
const JOB_STALL_MS = 60 * SEC;
/** How often the handler says what it has seen (content-free counts). */
const HEARTBEAT_MS = 5 * MIN;
/** In-memory books (reply targets, topics, stamps) are bounded like the store is. */
const LRU_MAX = 2_000;

/** Callback data this file owns. Short on purpose: Telegram caps it at 64 bytes. */
const CB_PREFIX = "tgg:";
/** The hold process reads presses by the same pattern (held-groups.ts GROUP_PRESS_RE). */
const CB_RE = /^tgg:(stay|leave|forget):(-?\d{1,20})$/;

/** Intents that report on a coin already decided: never stale, never blocked by "one reply per message". */
const FOLLOW_UPS: ReadonlySet<TgIntent["kind"]> = new Set<TgIntent["kind"]>(["coin-bought", "coin-passed", "coin-skipped", "coin-exited"]);

/**
 * "Only my owner can do that 🙃" — a slash command from someone who may not
 * run it. Code-written like voice.ts's fixed pools and gated the same way.
 */
const OWNER_ONLY_LINES: readonly string[] = [
  "only my owner can do that 🙃",
  "that one's for my owner 🙃",
  "owner only, sorry 🙃",
  "nah, only my owner gets to run that 🙃",
  "sorry, that's my owner's button 🙃",
];

/**
 * /link typed in a group. Link codes are for DMs only: in a group there is
 * nothing to link (the owner approves a group by adding the bot or pressing
 * Stay), and a code typed here has just been shown to everyone in the room.
 * The service never consumes it; this is what the room hears instead.
 */
const LINK_HERE_LINES: readonly string[] = [
  "no code needed in here 🤝",
  "you don't need a code in here, i'm already around",
  "codes are a DM thing, in here i'm just hanging out",
  "all good, no code needed here 👋",
  "nah no codes in here, i'm already in",
  "no code needed, i'm already hanging out in here",
];

/**
 * A command whose answer could not reach the asker's DM: Telegram lets a bot
 * write only to someone who opened a DM with it. The room hears this instead
 * of "sent it to your DMs", which would be false. Every line names /start,
 * the one thing that opens that DM.
 */
const DM_FIRST_LINES: readonly string[] = [
  "dm me /start first and i'll answer you there 🤝",
  "send me /start in DMs first, then i can answer there",
  "hit /start in my DMs first so i can answer there",
  "open a DM with me and hit /start first 🤝",
  "tap /start in my DMs first, then i'll send it there",
];

/**
 * A command that changes something RAN, but its answer (the receipt) did not
 * reach the asker's DM, although that DM was proved reachable just before
 * (a blip, or the bot blocked in between). Never "dm me first": those words
 * say it did not run, and someone who believes them sends the order again.
 * Every line says it went through; none carries anything of the receipt.
 */
const DONE_NO_DM_LINES: readonly string[] = [
  "done 🤝 couldn't get the details to your DMs tho",
  "went through, but my DM with the details bounced",
  "got it, done. couldn't DM you the details",
  "handled 🫡 the details didn't make it to your DMs",
  "done, just couldn't reach your DMs with the details",
];

/**
 * A room welcoming it ("and welcome to the group", "welcome aboard"): what
 * comes before the place. The place is added per room (smallTalkOf), because
 * the one people name most is the chat's own title.
 */
const WELCOME_HEAD = String.raw`(?:and\s+)?(?:a\s+)?(?:(?:big|warm|huge)\s+)?welcome(?:\s+(?:back|aboard|in))?`;
const WELCOME_PLACE = String.raw`(?:the|our|this|my)\s+(?:group|chat|gc|fam|family|crew|club|squad|server|channel|community|party)`;

// ─── The handler's surface ─────────────────────────────────────────────────

export interface TgGroupsDeps {
  /** The bot's token, read fresh (the dashboard can change it); null while there is none. */
  opts: () => TelegramOpts | null;
  store: TgGroupsStore;
  getCfg: () => ResolvedConfig;
  stateRef: StateRef;
  port: () => TgCoinsPort | null;
  /** A read-only projection of this agent's fills. No raw owner ledger rows. */
  facts?: () => TgGroupFactsPort | null;
  /** getMe's id and username, plus the soul name; null until getMe answered. */
  self: () => BotSelf | null;
  /** getMe's can_read_all_group_messages: false means privacy mode is on; null unknown. */
  privacyOff: () => boolean | null;
  /** The event feed. Counts and kinds only: it reaches the owner's DM prompt and the fleet's tables. */
  note: (level: "ok" | "warn", msg: string) => void;
  dashboardBase: () => string;
  /** What the agent's typing style is seeded from (styleFor). */
  agentKey: () => string;
  /** Milliseconds. Should be the store's clock. */
  now?: () => number;
  rand?: () => number;
  env?: Record<string, string | undefined>;
  hosted?: boolean;
  /** Waits (typing, a person's pace, a flood pause). Injectable so tests need not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** How long a group job or send may hold its chat (JOB_STALL_MS). Injectable so tests need not wait a minute. */
  stallMs?: number;
  /**
   * What bounds a read (the coin look, coins.ts COIN_FLOW.lookMs): resolves
   * once `ms` have passed. Real time when absent — never `sleep`, which a test
   * fakes by jumping its clock. Injectable so a test can end a look that never
   * answers.
   */
  timer?: (ms: number) => Promise<void>;
  /** Operator log (console by default). The same rule as `note`: no content. */
  log?: (s: string) => void;
}

/**
 * What a group notice after a slash command is for (the service's group
 * rules). "dm-first": the answer could not be delivered to the asker's DM,
 * and nothing that changes anything ran. "done-no-dm": a command that changes
 * something ran, but its receipt did not reach their DM.
 */
export type TgCommandNotice = "dm-sent" | "dm-first" | "done-no-dm" | "private-refused" | "owner-only" | "link-here";

/**
 * WHY AN ADDRESSED LINE GOT NOTHING — no line, no reaction. The one log line
 * that says so carries this code and nothing else ("[tg-groups] addressed
 * line got nothing (flood)"), so an operator can tell a flood from a failed
 * read from a refused send without the text, a name, an id or an address.
 *
 * - `off`: the feature is off (the operator's switch, the owner's setting, a
 *   handler that stopped). `room-not-approved`: the room is not one it talks
 *   in. `no-token`: no bot token to send with.
 * - `flood`, `shushed`, `roast-cap`, `kind-recent`, `bot`: pacing said so.
 * - `burst`: a newer line of the same person's burst is the one answered.
 * - `stale`: it waited past STALE_MS to go out.
 * - `forgotten`: they ran /forgetme (or the owner /forget) meanwhile.
 * - `already-answered`: the message already had its one reply.
 * - `not-wanted`: the reason to send went away while it was typing.
 * - `model-null-and-no-template`: no line could be written that the gate
 *   admits (no model or its line refused, and no template passed either).
 * - `send-failed`: Telegram refused it, or did not answer.
 * - the coin flow's codes (coins.ts CoinQuiet), `coin-unknown` among them: a
 *   CA whose look could not be made, and "can't pull that one up rn" was not
 *   due; `coin-silent` when the flow gave no reason.
 */
type Quiet =
  | CoinQuiet
  | "off"
  | "room-not-approved"
  | "no-token"
  | "flood"
  | "shushed"
  | "roast-cap"
  | "kind-recent"
  | "bot"
  | "burst"
  | "stale"
  | "forgotten"
  | "already-answered"
  | "not-wanted"
  | "model-null-and-no-template"
  | "send-failed"
  | "coin-silent"
  | "skipped";

/** Pacing's skip reasons for an addressed line, as Quiet codes. */
function quietOfSkip(why: string): Quiet {
  switch (why) {
    case "flood":
    case "shushed":
    case "roast-cap":
    case "kind-recent":
    case "bot":
      return why;
    case "not-approved":
      return "room-not-approved";
    default:
      return "skipped";
  }
}

export interface TgGroups {
  /** A group line anyone typed (never a slash command: those are the service's). */
  onMessage(msg: TgMessage): void;
  /**
   * The bot's own membership changed (my_chat_member). `late`: the update
   * waited out a silence, or reached the bot before this agent did (the
   * service's backlog rule). Its membership is recorded all the same, but
   * nothing is said in the group: no hello lands hours after the add.
   */
  onMember(u: TgMemberUpdate, o?: { late?: boolean }): void;
  /** A join, a leave or a supergroup migration. */
  onService(s: TgServiceMessage): void;
  /**
   * True when the press was one of this file's (`tgg:`), answered or refused.
   * `late`: pressed while trading was held and kept for this process
   * (telegram/held-groups.ts). It does what it did then, but its query is long
   * gone, so it is not answered; the question is still edited to the outcome.
   */
  onCallback(cb: TgCallback, o?: { late?: boolean }): Promise<boolean>;
  /** The owner's /groups, in their DM `chatId`. */
  groupsCommand(chatId: number): Promise<void>;
  /**
   * The owner's /forget in a group: that chat's memory and nothing else.
   * `late` (the service's backlog rule): wiped all the same, and nothing is
   * said in the room.
   */
  forgetChat(chatId: number, messageId?: number, o?: { late?: boolean }): void;
  /** Anyone's /forgetme: their lines and note in that chat. `late` as for forgetChat. */
  forgetMe(chatId: number, userId: number, messageId?: number, o?: { late?: boolean }): Promise<void>;
  /** The casual group line after a slash command (see TgCommandNotice). Rate-limited here. */
  commandNotice(chatId: number, messageId: number | undefined, fromId: number, what: TgCommandNotice, threadId?: number): Promise<void>;
  /**
   * The owner's live link code was typed in this group. The service has
   * already replaced it; this tells the owner, in their DM, why the code on
   * their Settings page changed.
   */
  codeLeaked(chatId: number): Promise<void>;
  isApproved(chatId: number): boolean;
  /** One background pass now (it also runs every few minutes). */
  sweep(): Promise<void>;
  /** Resolves once every queued and detached piece of work has settled. For tests and shutdown. */
  drain(): Promise<void>;
  stop(): void;
}

// ─── Small pieces ──────────────────────────────────────────────────────────

/** A Map that forgets its oldest entry past `max`: the in-memory books never grow without bound. */
class Lru<K, V> {
  private readonly m = new Map<K, V>();
  constructor(private readonly max: number) {}
  get(k: K): V | undefined {
    return this.m.get(k);
  }
  has(k: K): boolean {
    return this.m.has(k);
  }
  set(k: K, v: V): void {
    this.m.delete(k);
    this.m.set(k, v);
    if (this.m.size > this.max) {
      const first = this.m.keys().next();
      if (!first.done) this.m.delete(first.value);
    }
  }
  delete(k: K): void {
    this.m.delete(k);
  }
  deleteWhere(pred: (k: K) => boolean): void {
    for (const k of [...this.m.keys()]) if (pred(k)) this.m.delete(k);
  }
}

const errName = (e: unknown): string => (e instanceof Error ? e.name : typeof e);
const isUserId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const isMsgId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const msgKey = (chatId: number, messageId: number): string => `${chatId}:${messageId}`;

/** A display name as the mention shows it: one line, no controls, ≤ 40 chars. Escaped when used. */
function mentionName(v: unknown): string {
  if (typeof v !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return [...v.replace(/[\u0000-\u001f\u007f\u2028\u2029\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim()].slice(0, 40).join("").trim();
}

/** The chat types this file handles. A message with no type is a group when its id is negative (the repo's old test). */
function isTgGroup(chatType: string | undefined, chatId: number): boolean {
  if (chatType === "group" || chatType === "supergroup") return true;
  return chatType === undefined && chatId < 0;
}

/** In the chat, as Telegram counts it: a restricted member is in unless is_member says otherwise. */
function isIn(status: string, isMember: boolean | undefined): boolean {
  if (status === "member" || status === "administrator" || status === "creator") return true;
  return status === "restricted" && isMember !== false;
}

/** A sender who is a person speaking through a chat (an anonymous admin, a linked channel), not a bot. */
const viaChat = (m: TgMessage): boolean => m.senderChatId !== undefined;
/**
 * The loop guard. is_bot alone is not it: an anonymous admin posts as
 * GroupAnonymousBot (is_bot true) with a sender_chat, and the contract makes
 * that an ordinary line (pacing.ts PaceInput.fromIsBot).
 */
const fromBot = (m: TgMessage): boolean => m.fromIsBot === true && m.senderChatId === undefined;

/** First name, else username (without the @: a handle the model saw is one it may echo). */
function displayName(m: { fromFirstName?: string; fromUsername?: string }): string {
  const first = typeof m.fromFirstName === "string" ? m.fromFirstName.trim() : "";
  if (first) return first;
  const user = typeof m.fromUsername === "string" ? m.fromUsername.replace(/^@+/, "").trim() : "";
  return user || "someone";
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A window counter extended by one: the same window while it is open, a fresh one after. */
function bump(w: { count: number; sinceMs: number } | undefined, now: number, windowMs: number): { count: number; sinceMs: number } {
  return w && Number.isFinite(w.count) && now - w.sinceMs < windowMs ? { count: w.count + 1, sinceMs: w.sinceMs } : { count: 1, sinceMs: now };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    // A wait must never be what keeps the process alive: the poll loop is.
    t.unref?.();
  });
}

/** What a remembered line and its answer carry through the queue. */
interface LineJob {
  msg: TgMessage;
  line: TgLine;
  addressed: "mention" | "reply" | "name" | null;
  isOwner: boolean;
  via: boolean;
  /** When the line reached this process (or, deferred, when it came back up). Staleness counts from here. */
  bornAtMs: number;
  /**
   * When the line first reached this process, kept through a deferral. A
   * /forgetme at or after this cancels everything still to happen for the
   * line (see forgottenSince).
   */
  seenAtMs: number;
  threadId?: number;
  /** The question-to-the-room second look (see QUESTION_WAIT_MS). */
  deferred?: boolean;
}

/** One outgoing group line, composed and waiting to be sent. */
interface Outgoing {
  chatId: number;
  intent: TgIntent;
  /** Plain text from voice.say. Escaped here; the mention is built by code. */
  text: string;
  replyTo?: number;
  threadId?: number;
  mention?: { id: number; name: string };
  bornAtMs: number;
  /** A coin outcome: never dropped as stale. */
  followUp: boolean;
  /** The owner called it: it may answer while the chat is shushed. */
  ownerAddressed: boolean;
  /** Re-checked right before the send: a newer burst line, a chat that moved on. */
  stillWanted?: () => boolean;
  /** Told why, when the line is not sent (see Quiet). */
  miss?: (why: Quiet) => void;
}

interface SpeakOpts {
  replyTo?: number;
  threadId?: number;
  mention?: { id: number; name: string };
  trigger?: TgLine;
  senderName?: string;
  coinName?: string;
  bornAtMs?: number;
  ownerAddressed?: boolean;
  stillWanted?: () => boolean;
  /** An ambient line waits like someone who has been reading (pacing.ts typingDelayMs). */
  ambient?: boolean;
  /** Told why, when nothing is sent (see Quiet). */
  miss?: (why: Quiet) => void;
}

// ─── The handler ───────────────────────────────────────────────────────────

/**
 * THE TELEGRAM GROUPS HANDLER for one agent. Created once by the poll service
 * when it has a store; every method is safe to call at any time.
 */
export function createTgGroups(d: TgGroupsDeps): TgGroups {
  const store = d.store;
  const clock = typeof d.now === "function" ? d.now : Date.now;
  const rand = typeof d.rand === "function" ? d.rand : Math.random;
  const sleep = typeof d.sleep === "function" ? d.sleep : defaultSleep;
  const stallMs = typeof d.stallMs === "number" && Number.isFinite(d.stallMs) && d.stallMs > 0 ? d.stallMs : JOB_STALL_MS;
  const env = (): Record<string, string | undefined> => d.env ?? process.env;
  const hosted = typeof d.hosted === "boolean" ? d.hosted : safeHosted();
  const pacer = new SendPacer(clock);
  let stopped = false;

  const log = (s: string): void => {
    try {
      (d.log ?? ((x: string) => console.log(x)))(s);
    } catch {
      /* a logger that throws has nothing more to say */
    }
  };
  const fail = (stage: string, e: unknown): void => log(`[tg-groups] ${stage} failed (${errName(e)})`);
  /** An addressed line ended with nothing said or set on it: the code, never the content (see Quiet). */
  const quietLine = (why: Quiet): void => log(`[tg-groups] addressed line got nothing (${why})`);
  const note = (level: "ok" | "warn", msg: string): void => {
    try {
      d.note(level, msg);
    } catch {
      /* the feed is best-effort */
    }
  };

  const gate = new TgModelGate(store, { perDay: tgGroupsPerDay(env(), hosted), now: clock, log });

  // In-memory books. None of them decides whether money moves (the store's
  // claims do); losing them to a restart costs at most one extra casual line.
  /** Messages that already got their one immediate reply ("never two replies to one message"). */
  const repliedTo = new Lru<string, true>(LRU_MAX);
  /** When each recent message reached this process, for the staleness of a coin line about it. */
  const received = new Lru<string, number>(LRU_MAX);
  /** The forum topic of each recent message, so an outcome minutes later lands in the same topic. */
  const threads = new Lru<string, number>(LRU_MAX);
  /**
   * The newest addressed line per person per chat (`${chatId}:${fromId}`): a
   * burst answers only its last line. Per person: someone else calling it a
   * few seconds later is a second conversation, not a newer line of the first,
   * and must not drop an answer already being written for the first.
   */
  const lastAddressed = new Lru<string, { messageId: number; atMs: number }>(LRU_MAX);
  /**
   * The bot's own status per chat as the last my_chat_member said: true when
   * it is an admin there. An admin hears every line whatever privacy mode
   * says, so the privacy-mode steps would be false (privacyHint). Unknown
   * (never told this process) is not an admin.
   */
  const adminIn = new Lru<number, boolean>(LRU_MAX);
  /** Casual refusals, per person per chat. */
  const refusedAt = new Lru<string, number>(LRU_MAX);
  /** "still not sold on that one", per chat and coin. */
  const fadedAt = new Lru<string, number>(LRU_MAX);
  /** A Stay/Leave DM that failed to go out, per chat. */
  const askFailedAt = new Map<number, number>();
  /** Blocked rooms already left again this process (a message proved it was back). */
  const releft = new Set<number>();
  /** /groups listings, so a press on one re-renders it instead of printing an outcome. */
  const listings = new Lru<number, true>(64);
  /** Memory passes in flight, per chat. */
  const passing = new Set<number>();
  /**
   * When each person ran /forgetme, per chat (`${chatId}:${userId}`), and when
   * the owner wiped a whole chat (`${chatId}:*`). Their earlier lines may
   * still be queued or halfway through typing; see forgottenSince.
   */
  const forgottenAt = new Lru<string, number>(LRU_MAX);
  /** The one 👀 per person per flood window that stands in for coin lines past the flood. */
  const floodEyedAt = new Lru<string, number>(LRU_MAX);
  /**
   * Messages something landed on (`${chatId}:${messageId}`): a line replying
   * to it, or a reaction on it. Read only by the diagnostic line: an addressed
   * post the coin flow answered with a 👀 did get something.
   */
  const landedOn = new Lru<string, true>(LRU_MAX);
  /** Why a coin line for a message did not go out, as this file saw it (the flow only knows "not sent"). */
  const coinMissed = new Lru<string, Quiet>(LRU_MAX);
  /**
   * Messages said TO it (`${chatId}:${messageId}`): a coin line for one that
   * cannot be written gets a 👀 on the post instead of nothing (coinSpeak).
   */
  const askedIn = new Lru<string, true>(LRU_MAX);
  /** When the age limits were last applied (PRUNE_EVERY_MS). */
  let prunedAt = -Infinity;

  // ─── Work tracking ───────────────────────────────────────────────────────

  const inflight = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>): Promise<T> => {
    inflight.add(p);
    void p.then(
      () => inflight.delete(p),
      () => inflight.delete(p),
    );
    return p;
  };

  const queues = new Map<number, { tail: Promise<void>; size: number }>();
  /** Where each chat's running job is (a stage name, never content), and since when. */
  const running = new Map<number, { stage: string; since: number }>();
  const stageOf = (chatId: number, stage: string): void => {
    const r = running.get(chatId);
    if (r) r.stage = stage;
  };
  /**
   * Counts since the last heartbeat. Content-free: what arrived and why a
   * line went nowhere, so the log can tell "no messages reach the bot" from
   * "they arrive and are dropped here" from "a job is stuck".
   */
  const stats = {
    lines: 0,
    addressed: 0,
    noSelf: 0,
    noRoom: 0,
    blocked: 0,
    notApproved: 0,
    off: 0,
    dropped: 0,
    stalled: 0,
    lockStalled: 0,
    /** Lines the coin flow owned (a CA, another chain's coin, a ticker it answered), and how many got a line or a reaction. */
    coinPosts: 0,
    coinAnswered: 0,
  };
  /** Resolves after ms, or never holds the process open. */
  const after = (ms: number): Promise<"late"> =>
    new Promise((r) => {
      const t = setTimeout(() => r("late"), ms);
      t.unref?.();
    });
  /**
   * Run `job` after every earlier job of this chat. Serial per chat, so the
   * room is read and written in order; parallel across chats. Returns the
   * job's settling (it never rejects), or null when the chat's queue is full.
   */
  const enqueue = (chatId: number, job: () => Promise<void>, opts: { force?: boolean } = {}): Promise<void> | null => {
    const q = queues.get(chatId) ?? { tail: Promise.resolve(), size: 0 };
    if (!opts.force && q.size >= MAX_QUEUED) {
      stats.dropped += 1;
      return null;
    }
    q.size += 1;
    const next = q.tail
      .then(async () => {
        if (stopped) return;
        running.set(chatId, { stage: "start", since: clock() });
        // The job keeps running if it outlives the bound (it cannot be
        // cancelled), but the chat's next line no longer waits for it; its
        // own rejection, whenever it comes, is still caught and logged.
        const work = Promise.resolve()
          .then(job)
          .catch((e) => fail("line", e));
        track(work);
        const done = await Promise.race([work.then(() => "done" as const), after(stallMs)]);
        if (done === "late") {
          stats.stalled += 1;
          // No longer waited for by anyone, drain() included: a job that
          // never settles must not hold a shutdown either.
          inflight.delete(work);
          log(`[tg-groups] a group job ran past ${Math.round(stallMs / SEC)}s at "${running.get(chatId)?.stage ?? "?"}"; the chat moves on without it`);
        }
        running.delete(chatId);
      })
      .catch((e) => fail("line", e))
      .finally(() => {
        q.size -= 1;
        if (q.size <= 0 && queues.get(chatId) === q) queues.delete(chatId);
      });
    q.tail = next;
    queues.set(chatId, q);
    track(next);
    return next;
  };

  const locks = new Map<number, Promise<void>>();
  /** One send at a time per chat: typing, the wait, the send. */
  const withLock = async <T>(chatId: number, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(chatId) ?? Promise.resolve();
    let release: () => void = () => {};
    const mine = new Promise<void>((r) => {
      release = r;
    });
    const chained = prev.then(() => mine);
    locks.set(chatId, chained);
    // The same bound as a job: a send that never ended must not hold every
    // later one. Past it this send goes ahead (the pacer still spaces sends).
    // Half a job's bound: a job may spend part of its own waiting here, and a
    // stuck send must free the lock before the job waiting on it is itself
    // given up on. Stepping past a lock whose holder is only waiting out the
    // flood pacer (a 429's retry_after, a full minute's window) is safe: the
    // pacer hands out one slot at a time (waitTurn), so pacing holds.
    if ((await Promise.race([prev.then(() => "done" as const), after(stallMs / 2)])) === "late") {
      stats.lockStalled += 1;
      log(`[tg-groups] a group send held the chat's lock past ${Math.round(stallMs / 2 / SEC)}s; the next one goes ahead`);
    }
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(chatId) === chained) locks.delete(chatId);
    }
  };

  // ─── Reading the world ───────────────────────────────────────────────────

  const cfgNow = (): ResolvedConfig | null => {
    try {
      return d.getCfg();
    } catch (e) {
      fail("settings", e);
      return null;
    }
  };
  /** MERRYMEN_TG_GROUPS=0: the operator's off switch, read on every update. */
  const switchOn = (): boolean => {
    try {
      return env().MERRYMEN_TG_GROUPS?.trim() !== "0";
    } catch {
      return false;
    }
  };
  const featureOn = (cfg: ResolvedConfig | null): boolean => !stopped && switchOn() && cfg?.telegramGroupsEnabled === true;
  const ownerId = (): number | null => {
    try {
      const id = d.stateRef.get().ownerId;
      return isUserId(id) ? id : null;
    } catch {
      return null;
    }
  };
  const selfNow = (): BotSelf | null => {
    try {
      const s = d.self();
      return s && typeof s.id === "number" ? s : null;
    } catch {
      return null;
    }
  };
  const optsNow = (): TelegramOpts | null => {
    try {
      const o = d.opts();
      return o && typeof o.token === "string" && o.token ? o : null;
    } catch {
      return null;
    }
  };
  const portNow = (): TgCoinsPort | null => {
    try {
      return d.port() ?? null;
    } catch {
      return null;
    }
  };
  /** May it say anything in this chat right now? Approved, switched on, and not stopped. */
  const canTalk = (chatId: number, cfg: ResolvedConfig | null = cfgNow()): boolean =>
    featureOn(cfg) && store.room(chatId)?.status === "approved";
  /** Why it may not talk in this chat right now, or null when it may (canTalk, with its reason). */
  const talkWhy = (chatId: number, cfg: ResolvedConfig | null = cfgNow()): Quiet | null =>
    !featureOn(cfg) ? "off" : store.room(chatId)?.status !== "approved" ? "room-not-approved" : null;
  const shushedNow = (room: TgRoom | undefined, now: number): boolean => typeof room?.shushedUntilMs === "number" && room.shushedUntilMs > now;
  const chattiness = (cfg: ResolvedConfig | null): Chattiness => {
    const c = cfg?.telegramGroupsChattiness;
    return c === "quiet" || c === "normal" || c === "chatty" ? c : "normal";
  };
  const roll = (): number => {
    try {
      const r = rand();
      return Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 1;
    } catch {
      return 1;
    }
  };

  /**
   * ASKED TO BE FORGOTTEN SINCE `sinceMs`: this person ran /forgetme, or the
   * owner wiped the chat, at or after the moment a line reached us. The wipe
   * is synchronous, but an earlier line of theirs may still be on the chat
   * queue or typing; answering it would bring their entry (name, id, flood
   * and roast counters, a greeting day) and a coin memo naming them straight
   * back, right before "done 🫡". Whatever is still to happen for such a line
   * is dropped, the reply included. Keyed by time, never by "is the line still
   * in the room": the 60-line cap trims lines in a busy chat all the time.
   */
  const forgottenSince = (chatId: number, userId: number, sinceMs: number): boolean => {
    const one = forgottenAt.get(`${chatId}:${userId}`);
    const all = forgottenAt.get(`${chatId}:*`);
    return (one !== undefined && one >= sinceMs) || (all !== undefined && all >= sinceMs);
  };
  const forgotten = (j: LineJob): boolean => forgottenSince(j.msg.chatId, j.line.fromId, j.seenAtMs);

  let modelCache: { at: number; m: TgModel | null; line: string } | null = null;
  /**
   * WHO WRITES GROUP LINES, re-read at most once a minute so a key the owner
   * saves applies without a restart. The boot line names source, provider and
   * model only, and is logged again only when that changes.
   */
  const modelNow = (): TgModel | null => {
    const t = clock();
    if (modelCache && t - modelCache.at >= 0 && t - modelCache.at < MODEL_RECHECK_MS) return modelCache.m;
    let m: TgModel | null = null;
    const cfg = cfgNow();
    try {
      m = cfg ? resolveTgGroupsModel(cfg, env(), hosted) : null;
    } catch (e) {
      fail("model", e);
      m = null;
    }
    const line = describeTgGroupsModel(m);
    if (!modelCache || modelCache.line !== line) {
      log(`[tg-groups] ${line}`);
      try {
        const problem = tgGroupsDedicatedKeyProblem(env());
        if (problem) log(`[tg-groups] telegram groups: ${problem}`);
      } catch {
        /* names variables only; nothing to lose */
      }
    }
    modelCache = { at: t, m, line };
    return m;
  };

  // ─── Sending ─────────────────────────────────────────────────────────────

  const pauseFor = (sec: number): void => {
    const until = clock() + Math.max(1, Math.ceil(sec)) * SEC;
    const before = pacer.pausedUntil();
    pacer.pauseAll(until);
    if (until > before && before <= clock()) note("warn", `Telegram groups: Telegram asked to slow down; group lines paused for ${Math.ceil(sec)}s`);
  };

  /** Until the pacer allows a send to this chat. Bounded: a pause longer than the staleness window drops the line anyway. */
  const waitTurn = async (chatId: number): Promise<void> => {
    for (let i = 0; i < 8; i++) {
      const w = pacer.waitMs(chatId);
      if (w <= 0) break;
      await sleep(w);
    }
    // THE SLOT IS TAKEN HERE, not after the send lands. Checking the pacer
    // and taking its slot happen with no await between them, so two sends
    // that both wake at a window's edge cannot both pass it — which matters
    // now that the chat's lock can be stepped past (withLock): a successor
    // that goes ahead of a send still waiting out a 429 or a full minute
    // waits for its own slot here, it does not share the other's. A slot
    // taken by a send that then fails or is dropped just spaces the next one
    // out a little more.
    pacer.noteSent(chatId);
  };

  /** Still worth sending? Null when it is, else why not. Re-read at every step, because every step can take seconds. */
  const whyNot = (o: Outgoing, chatId: number): Quiet | null => {
    if (stopped) return "off";
    const cannot = talkWhy(chatId);
    if (cannot) return cannot;
    const now = clock();
    if (!o.followUp && now - o.bornAtMs > STALE_MS) return "stale";
    // Quiet means quiet: only the answer to being told so, the owner calling
    // it, and the kind line go out. Someone in distress is answered whoever
    // told it to shush (pacing: "always, shushed or not").
    if (o.intent.kind !== "shushed" && o.intent.kind !== "kind" && !o.ownerAddressed && shushedNow(store.room(chatId), now)) return "shushed";
    try {
      if (o.stillWanted && !o.stillWanted()) return "not-wanted";
    } catch {
      return "not-wanted";
    }
    return null;
  };
  /** Tell the line's caller why it was not sent. */
  const missed = (o: { miss?: (why: Quiet) => void }, why: Quiet): void => {
    try {
      o.miss?.(why);
    } catch {
      /* a diagnostic hook that throws has nothing to add */
    }
  };

  const htmlOf = (o: Outgoing): string => {
    const body = esc(o.text);
    const m = o.mention;
    if (!m || !isUserId(m.id)) return body;
    const name = mentionName(m.name);
    return name ? `<a href="tg://user?id=${m.id}">${esc(name)}</a> ${body}` : body;
  };

  /**
   * SEND ONE LINE. Typing first, a person's delay, the flood pacer, then the
   * send. A 429 pauses every group send for Telegram's retry_after and the
   * line is tried again if it is still fresh; a group that became a
   * supergroup moves its state and gets the line once, at the new id, without
   * the reply (message ids do not carry over).
   */
  const deliver = async (o: Outgoing): Promise<{ chatId: number; messageId?: number } | null> =>
    withLock(o.chatId, async () => {
      let chatId = o.chatId;
      let replyTo = o.replyTo;
      let threadId = o.threadId;
      let migrated = false;
      const opts = optsNow();
      if (!opts) {
        missed(o, "no-token");
        return null;
      }
      const early = whyNot(o, chatId);
      if (early) {
        missed(o, early);
        return null;
      }
      try {
        stageOf(o.chatId, "send: typing");
        await sendChatAction(opts, chatId, "typing", threadId);
      } catch (e) {
        fail("typing", e);
      }
      stageOf(o.chatId, "send: typing delay");
      await sleep(typingDelayMs(o.text, false, rand));
      for (let attempt = 0; attempt < 4; attempt++) {
        stageOf(o.chatId, "send: flood pacer");
        await waitTurn(chatId);
        const late = whyNot(o, chatId);
        if (late) {
          missed(o, late);
          return null;
        }
        stageOf(o.chatId, "send: message");
        const r = await sendMessage(opts, chatId, htmlOf(o), {
          ...(isMsgId(replyTo) ? { replyToMessageId: replyTo } : {}),
          ...(isMsgId(threadId) ? { messageThreadId: threadId } : {}),
          disablePreview: true,
        });
        if (r.ok) {
          if (isMsgId(o.replyTo)) landedOn.set(msgKey(o.chatId, o.replyTo), true);
          return r.messageId !== undefined ? { chatId, messageId: r.messageId } : { chatId };
        }
        if (typeof r.retryAfterSec === "number") {
          pauseFor(r.retryAfterSec);
          continue;
        }
        if (typeof r.migrateToChatId === "number" && !migrated) {
          migrated = true;
          store.migrate(chatId, r.migrateToChatId);
          chatId = r.migrateToChatId;
          replyTo = undefined;
          threadId = undefined;
          continue;
        }
        // A topic Telegram no longer knows (deleted since, or a thread id that
        // was never a topic): once more without it. The reply, when there is
        // one, still puts the line next to the message it answers.
        if (isMsgId(threadId) && typeof r.reason === "string" && /thread not found/i.test(r.reason)) {
          threadId = undefined;
          continue;
        }
        // "request failed: …" is the transport (a dead network, a call past
        // api.ts TG_CALL_TIMEOUT_MS), not Telegram saying no.
        log(`[tg-groups] send failed (${r.reason && !/^request failed/.test(r.reason) ? "refused" : "no answer"})`);
        missed(o, "send-failed");
        return null;
      }
      missed(o, "send-failed");
      return null;
    });

  /** One emoji on a message, through the same pacer and pause as a line. */
  const reactTo = async (
    chatId: number,
    messageId: number,
    emoji: string,
    o: { ownerAddressed?: boolean; stillWanted?: () => boolean; miss?: (why: Quiet) => void } = {},
  ): Promise<boolean> => {
    if (!isMsgId(messageId)) return false;
    const wanted = (): boolean => {
      try {
        return !o.stillWanted || o.stillWanted();
      } catch {
        return false;
      }
    };
    /** Null when it may react now, else why not. */
    const why = (): Quiet | null => (stopped ? "off" : (talkWhy(chatId) ?? (wanted() ? null : "not-wanted")));
    return withLock(chatId, async () => {
      const opts = optsNow();
      if (!opts) {
        missed(o, "no-token");
        return false;
      }
      const early = why();
      if (early) {
        missed(o, early);
        return false;
      }
      if (emoji !== REACTION_FOR.shush[0] && !o.ownerAddressed && shushedNow(store.room(chatId), clock())) {
        missed(o, "shushed");
        return false;
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        await waitTurn(chatId);
        const late = why();
        if (late) {
          missed(o, late);
          return false;
        }
        const r = await setMessageReaction(opts, chatId, messageId, emoji);
        if (r.ok) {
          landedOn.set(msgKey(chatId, messageId), true);
          return true;
        }
        if (typeof r.retryAfterSec === "number") {
          pauseFor(r.retryAfterSec);
          continue;
        }
        missed(o, "send-failed");
        return false;
      }
      missed(o, "send-failed");
      return false;
    });
  };

  /**
   * The room as a prompt may see it: no line or coin memo past its 14-day
   * window. The sweep ages them out hourly; between two sweeps, one that has
   * just crossed the line must not be quoted to a model provider. The room
   * itself is handed over untouched in the ordinary case.
   */
  const freshView = (room: TgRoom, now: number): TgRoom => {
    const lineOk = (l: TgLine): boolean => !(now - l.atMs > TG_LIMITS.lineMaxAgeMs);
    const coinOk = (c: TgCoinMemo): boolean => !(now - c.atMs > TG_LIMITS.coinMaxAgeMs);
    if (room.lines.every(lineOk) && room.coins.every(coinOk)) return room;
    return { ...room, lines: room.lines.filter(lineOk), coins: room.coins.filter(coinOk) };
  };

  /** The fixed, group-safe context voice.ts writes from. Never anything private (rule 3). */
  const speakCtx = (chatId: number, o: SpeakOpts): SpeakCtx | null => {
    const stored = store.room(chatId);
    if (!stored) return null;
    const room = freshView(stored, clock());
    const port = portNow();
    let mode: "paper" | "live" = "paper";
    let heldNames: string[] = [];
    try {
      if (port && port.mode() === "live") mode = "live";
    } catch (e) {
      fail("mode", e);
    }
    try {
      const h = port?.heldNames();
      if (Array.isArray(h)) heldNames = h.filter((n): n is string => typeof n === "string");
    } catch (e) {
      fail("held names", e);
    }
    let agentKey = "";
    try {
      agentKey = String(d.agentKey() ?? "");
    } catch {
      agentKey = "";
    }
    return {
      agentName: selfNow()?.name ?? "",
      agentKey,
      ownerName: room.ownerName ?? null,
      mode,
      heldNames,
      room,
      ...(o.trigger ? { trigger: o.trigger } : {}),
      ...(o.senderName ? { senderName: o.senderName } : {}),
      ...(o.coinName ? { coinName: o.coinName } : {}),
      nowMs: clock(),
      rand,
    };
  };

  /** Its own line, remembered so the next prompt sees it and the repeat clause can refuse an echo. */
  const recordOwn = (chatId: number, messageId: number | undefined, text: string, replyTo: number | undefined): void => {
    const now = clock();
    const me = selfNow();
    if (isMsgId(messageId)) {
      store.addLine(chatId, {
        messageId,
        fromId: me?.id ?? 0,
        name: me?.name ?? "",
        text,
        atMs: now,
        ...(isMsgId(replyTo) ? { replyTo } : {}),
        own: true,
      });
    }
    store.update(chatId, (r) => {
      r.lastOwnAtMs = now;
    });
  };

  /**
   * THE WORDS ON A TAG. A tag shows the person's display name as they set it,
   * and it goes out in the agent's own message: a member named "BUY $SCAM NOW
   * 🚀 t.me/scamx", or a slur, would have the agent post a shill call, a
   * cashtag or the slur for them. So the label is judged like a line of the
   * agent's own (gate.ts, as a fixed line) and a refused one reads "fren".
   * The tag's id is untouched: the right person is still pinged.
   */
  const tagLabel = (raw: string): string => {
    const name = mentionName(raw);
    if (!name) return "";
    try {
      const v = admitTgLine(name, { agentName: "", kind: "fixed", recentOwn: [], names: [] });
      // The admitted text, not the raw one: tidy may have taken something out.
      return v.ok && v.text && !v.text.includes("\n") ? mentionName(v.text) || NEUTRAL_TAG : NEUTRAL_TAG;
    } catch {
      return NEUTRAL_TAG;
    }
  };

  /**
   * COMPOSE AND SEND ONE LINE for an intent. The words come from voice.say
   * (null is silence); the tag is added by code when voice.mentionFor says
   * so, its label checked by tagLabel. Returns where it landed, or null.
   */
  const speak = async (chatId: number, intent: TgIntent, o: SpeakOpts = {}): Promise<{ chatId: number; messageId?: number } | null> => {
    const cannot = talkWhy(chatId);
    if (cannot) {
      missed(o, cannot);
      return null;
    }
    const born = typeof o.bornAtMs === "number" ? o.bornAtMs : clock();
    const followUp = FOLLOW_UPS.has(intent.kind);
    const ctx = speakCtx(chatId, o);
    if (!ctx) {
      missed(o, "room-not-approved");
      return null;
    }
    const m = modelNow();
    const text = await say(intent, ctx, m, m ? gate : null);
    if (!text) {
      missed(o, "model-null-and-no-template");
      return null;
    }
    if (o.ambient) {
      // Someone joining in has been reading for a while (5–40 s on top of typing).
      const reading = typingDelayMs(text, true, rand) - typingDelayMs(text, false, rand);
      await sleep(reading);
    }
    const who = mentionFor(intent);
    const label = who !== null && o.mention && isUserId(o.mention.id) ? tagLabel(o.mention.name) : "";
    const mention = label && o.mention ? { id: o.mention.id, name: label } : undefined;
    const sent = await deliver({
      chatId,
      intent,
      text,
      ...(o.replyTo !== undefined ? { replyTo: o.replyTo } : {}),
      ...(o.threadId !== undefined ? { threadId: o.threadId } : {}),
      ...(mention ? { mention } : {}),
      bornAtMs: born,
      followUp,
      ownerAddressed: o.ownerAddressed === true,
      ...(o.stillWanted ? { stillWanted: o.stillWanted } : {}),
      ...(o.miss ? { miss: o.miss } : {}),
    });
    if (!sent) return null;
    // A migrated chat has no message the old reply id means.
    recordOwn(sent.chatId, sent.messageId, text, sent.chatId === chatId ? o.replyTo : undefined);
    log(`[tg-groups] said ${intent.kind}`);
    return sent;
  };

  /** "Never two replies to one message": reserve the message's one immediate reply, or refuse. */
  const reserveReply = (chatId: number, messageId: number | undefined): boolean => {
    if (!isMsgId(messageId)) return true;
    const k = msgKey(chatId, messageId);
    if (repliedTo.has(k)) return false;
    repliedTo.set(k, true);
    return true;
  };
  const releaseReply = (chatId: number, messageId: number | undefined): void => {
    if (isMsgId(messageId)) repliedTo.delete(msgKey(chatId, messageId));
  };

  const dmOwner = async (html: string, keyboard?: InlineKeyboard): Promise<boolean> => {
    const owner = ownerId();
    const opts = optsNow();
    if (owner === null || !opts || stopped) return false;
    try {
      const r = await sendMessage(opts, owner, html, keyboard && keyboard.length > 0 ? { keyboard } : {});
      return r.ok;
    } catch (e) {
      fail("owner dm", e);
      return false;
    }
  };

  // ─── The coin flow ───────────────────────────────────────────────────────

  /**
   * Pacing's flood rule for one person (pacing.ts isFlooded): FLOOD_ANSWERS
   * answers inside the window, and never the owner. The owner is known here by
   * id alone: an anonymous admin or a channel post never carries the owner's.
   */
  const flooded = (chatId: number, userId: number): boolean => isFlooded(store.person(chatId, userId), userId === ownerId(), clock());

  /** Past the flood: one 👀 on their post per window, then nothing. */
  const floodEyes = async (chatId: number, userId: number, messageId: number | undefined): Promise<void> => {
    if (!isMsgId(messageId)) return;
    const k = `${chatId}:${userId}`;
    const now = clock();
    const last = floodEyedAt.get(k);
    if (last !== undefined && now - last < FLOOD_WINDOW_MS) return;
    floodEyedAt.set(k, now);
    if (!(await reactTo(chatId, messageId, "👀"))) floodEyedAt.delete(k);
  };

  const coinSpeak = async (chatId: number, intent: CoinIntent, o: CoinSpeakOpts): Promise<boolean> => {
    const t: TgIntent = intent;
    const followUp = FOLLOW_UPS.has(t.kind);
    const replyTo = o.replyTo;
    // Why this post's line did not go out, for the diagnostic line: the flow
    // only hears "not sent".
    const miss = (why: Quiet): void => {
      if (!followUp && isMsgId(replyTo)) coinMissed.set(msgKey(chatId, replyTo), why);
    };
    // THE PERSON THIS LINE ANSWERS: whoever posted the line it is about. An
    // outcome is the coin's report, minutes later, not a new answer to them.
    const poster = !followUp && o.trigger && !o.trigger.own && isUserId(o.trigger.fromId) ? o.trigger : undefined;
    const seenAt = poster ? ((isMsgId(poster.messageId) ? received.get(msgKey(chatId, poster.messageId)) : undefined) ?? poster.atMs) : 0;
    if (poster) {
      if (forgottenSince(chatId, poster.fromId, seenAt)) {
        miss("forgotten");
        return false;
      }
      // A coin line is an answer like any other: past the flood for one
      // person (six in two minutes, never the owner), the CA gets a 👀 at
      // most, as pacing's flood gives chatter silence. One shill posting CAs
      // is not owed a reply to each.
      if (flooded(chatId, poster.fromId)) {
        await floodEyes(chatId, poster.fromId, replyTo);
        miss("flood");
        return false;
      }
    }
    // An outcome replies to the post again by design (the ack came first); an
    // immediate line takes the message's one reply, and a second is dropped.
    if (!followUp && !reserveReply(chatId, replyTo)) {
      miss("already-answered");
      return false;
    }
    const born = followUp ? clock() : (isMsgId(replyTo) ? received.get(msgKey(chatId, replyTo)) : undefined) ?? clock();
    const threadId = isMsgId(replyTo) ? threads.get(msgKey(chatId, replyTo)) : undefined;
    // A delayed failed look may tag someone who asked under another person's
    // post. Both people's forget requests must cancel it through the send wait.
    const stillWanted = () => (!poster || !forgottenSince(chatId, poster.fromId, seenAt)) && (!o.stillWanted || o.stillWanted());
    let unwritten = false;
    const sent = await speak(chatId, t, {
      ...(replyTo !== undefined ? { replyTo } : {}),
      ...(threadId !== undefined ? { threadId } : {}),
      ...(o.mention ? { mention: o.mention } : {}),
      ...(o.trigger ? { trigger: o.trigger } : {}),
      ...(o.mention?.name || o.trigger?.name ? { senderName: o.mention?.name || o.trigger?.name } : {}),
      ...(o.coinName ? { coinName: o.coinName } : {}),
      bornAtMs: born,
      stillWanted,
      miss: (why) => {
        if (why === "model-null-and-no-template") unwritten = true;
        miss(why === "not-wanted" && poster && forgottenSince(chatId, poster.fromId, seenAt) ? "forgotten" : why);
      },
    });
    if (!sent && !followUp) releaseReply(chatId, replyTo);
    // NO LINE FOR A POST THAT ASKED IT: a 👀 on the post, never silence. Only
    // when no line could be written (every template too like its recent own
    // lines, a model's line refused): a flood, a shush, a stale post or a
    // refused send keep their own answer, which is nothing. It stands for the
    // line, so the flow hears that something went out.
    if (!sent && unwritten && !followUp && isMsgId(replyTo) && askedIn.has(msgKey(chatId, replyTo))) {
      if (clock() - born > STALE_MS) {
        miss("stale");
        return false;
      }
      return reactTo(chatId, replyTo, "👀", { stillWanted, miss });
    }
    if (sent && poster && !forgottenSince(chatId, poster.fromId, seenAt)) {
      const now = clock();
      store.upsertPerson(sent.chatId, {
        id: poster.fromId,
        name: poster.name,
        answers: bump(store.person(sent.chatId, poster.fromId)?.answers, now, FLOOD_WINDOW_MS),
      });
    }
    return sent !== null;
  };

  const coinFactsOn = (): boolean => {
    const cfg = cfgNow();
    return featureOn(cfg) && cfg?.telegramGroupCoinsEnabled === true;
  };
  const flow = new CoinFlow({
    store,
    port: portNow,
    coinsEnabled: coinFactsOn,
    ownerId,
    speak: (chatId, intent, o) => track(coinSpeak(chatId, intent, o)),
    react: (chatId, messageId, emoji) => track(reactTo(chatId, messageId, emoji)),
    dmOwner: (text, button) => dmOwner(esc(text), button ? [[{ text: button.text, url: button.url }]] : undefined),
    dashboardUrl: () => d.dashboardBase(),
    now: clock,
    log,
    ...(typeof d.timer === "function" ? { timer: d.timer } : {}),
  });
  flow.start();

  // ─── Rooms and membership ────────────────────────────────────────────────

  /**
   * A pending room whose adder is on file and is not the owner. Only such a
   * group is left unanswered after a day, and only its question says
   * "someone added me". A room first seen through a line (the bot was in it
   * before this feature, or added while this process missed the update) has
   * no adder on file: nobody knows it was a stranger, and the likeliest
   * adder is the owner.
   */
  const strangerAdded = (room: TgRoom): boolean => room.addedById !== undefined && room.addedById !== ownerId();

  /**
   * A room the bot is in, first seen or seen again through a line from
   * `from`: created, and approved when the owner linked it, or when the owner
   * is the one talking in a room nobody is known to have added it to.
   */
  const knownRoom = (
    chatId: number,
    init: { title?: string; kind?: string; isForum?: boolean },
    cfg: ResolvedConfig | null,
    from?: { fromId: number; via: boolean },
  ): TgRoom | undefined => {
    const kind = init.kind === "group" || init.kind === "supergroup" ? init.kind : "";
    const owner = ownerId();
    // Telegram vouches for the sender id; an anonymous admin could be anyone.
    const ownerLine = !!from && !from.via && owner !== null && from.fromId === owner;
    const linked = cfg?.telegramAllowlist?.includes(chatId) === true;
    const room = store.ensureRoom(
      chatId,
      {
        title: typeof init.title === "string" ? init.title : "",
        kind,
        ...(typeof init.isForum === "boolean" ? { isForum: init.isForum } : {}),
      },
      { owner: ownerLine || linked },
    );
    // Thirty chats, every one the owner's decision: a new one is not kept.
    if (!room) return undefined;
    if (room.status === "pending" || room.status === "left") {
      // A negative id on the allowlist is a group the owner ran /link in
      // before this feature: approved on first sight.
      if (linked) {
        store.setStatus(chatId, "approved");
        note("ok", "Telegram groups: a group the owner linked earlier is approved");
      } else if (room.status === "left") {
        // A line from a room it had left means it is back, added while this
        // process missed the update: not approved until the owner says so.
        // Who added it back is not known, so the adder on file (from the add
        // before) is not kept as if it were.
        store.setStatus(chatId, "pending");
        askFailedAt.delete(chatId);
        store.update(chatId, (r) => {
          delete r.addedById;
          delete r.addedAtMs;
        });
      }
    }
    // THE OWNER TALKING IN A GROUP IT WAS ALREADY IN. Nobody is known to have
    // added it (the add happened before this feature, or while this process
    // missed it), and the owner is here, speaking. Their own words, from an
    // id Telegram vouches for, are as strong as the owner adding the bot:
    // leaving the owner's own group silent, asking them "someone added me"
    // and leaving it a day later would be the agent deciding against them.
    const cur = store.room(chatId);
    if (cur && cur.status === "pending" && cur.addedById === undefined && ownerLine && owner !== null) {
      approve(chatId, owner, "the owner is talking in a group I was already in");
    }
    return store.room(chatId);
  };

  const sayHello = async (chatId: number): Promise<void> => {
    const room = store.room(chatId);
    if (!room || room.helloSaid || !canTalk(chatId)) return;
    const sent = await speak(chatId, { kind: "hello" }, { bornAtMs: clock() });
    if (sent) {
      store.update(sent.chatId, (r) => {
        r.helloSaid = true;
      });
    }
  };

  const privacyText = (title: string): string =>
    [
      `Heads up about ${title}: Telegram's privacy mode is on for me, so there I only hear commands and replies to my own messages. I can't follow the chat or see coins people post.`,
      "To fix it: open @BotFather → /setprivacy → pick your bot → Disable. Then remove me from the group and add me back (or make me an admin there).",
    ].join("\n");

  const titleOf = (room: TgRoom | undefined): string => (room?.title ? `«${esc(room.title)}»` : "your group");

  /**
   * The privacy-mode steps, once per group, when getMe says privacy mode is
   * on and the bot is not an admin there (an admin hears every line anyway).
   * Skipped for an admin without being marked sent, so a later demotion to a
   * plain member sends them then (onMember).
   */
  const privacyHint = async (chatId: number): Promise<void> => {
    let off: boolean | null = null;
    try {
      off = d.privacyOff();
    } catch {
      off = null;
    }
    if (off !== false || adminIn.get(chatId) === true) return;
    const room = store.room(chatId);
    if (!room || room.privacyHintSent || !featureOn(cfgNow()) || ownerId() === null) return;
    // Reserved before the send, so two adds in one batch cannot both DM.
    store.update(chatId, (r) => {
      r.privacyHintSent = true;
    });
    const ok = await dmOwner(privacyText(titleOf(room)));
    if (!ok) {
      store.update(chatId, (r) => {
        delete r.privacyHintSent;
      });
    }
  };

  const approve = (chatId: number, byId: number | undefined, why: string, quiet = false): void => {
    const was = store.room(chatId)?.status;
    store.setStatus(chatId, "approved", byId);
    if (was !== "approved") note("ok", `Telegram groups: ${why} — talking there`);
    enqueue(
      chatId,
      async () => {
        // Quiet: an add that reached the bot late (onMember). The privacy
        // steps go to the owner's DM, so they are still due.
        if (!quiet) await sayHello(chatId);
        await privacyHint(chatId);
      },
      { force: true },
    );
  };

  /**
   * The one DM asking the owner about a pending group, with Stay / Leave. A
   * stranger's group: "someone added me", and the 24 h clock that leaves it.
   * A group nobody is known to have added it to (strangerAdded): "i'm in",
   * asked once, and it waits for the owner however long that takes.
   */
  const askOwner = async (chatId: number): Promise<void> => {
    const room = store.room(chatId);
    if (!room || room.status !== "pending" || !featureOn(cfgNow()) || ownerId() === null) return;
    const now = clock();
    const stranger = strangerAdded(room);
    if (room.askedOwnerAtMs !== undefined && (!stranger || now - room.askedOwnerAtMs < PENDING_LEAVE_MS)) return;
    const failed = askFailedAt.get(chatId);
    if (failed !== undefined && now - failed < ASK_RETRY_MS) return;
    const prev = room.askedOwnerAtMs;
    store.update(
      chatId,
      (r) => {
        r.askedOwnerAtMs = now;
      },
      { flush: true },
    );
    const question = stranger
      ? `someone added me to ${titleOf(room)}. want me to hang out there?`
      : `i'm in ${titleOf(room)} — want me to hang out there?`;
    const ok = await dmOwner(question, [
      [
        { text: "Stay", callbackData: `${CB_PREFIX}stay:${chatId}` },
        { text: "Leave", callbackData: `${CB_PREFIX}leave:${chatId}` },
      ],
    ]);
    if (ok) {
      askFailedAt.delete(chatId);
      note("ok", stranger ? "Telegram groups: someone else added me to a group — asked the owner" : "Telegram groups: in a group nobody is known to have added me to — asked the owner");
      return;
    }
    // Not asked means the 24 h clock has not started: leaving a group over a
    // question nobody received would be the agent deciding for the owner.
    askFailedAt.set(chatId, now);
    store.update(chatId, (r) => {
      if (r.askedOwnerAtMs !== now) return;
      // Put back only an ask from this pending spell: one from an earlier
      // spell is not a question about this one, and its clock would leave
      // the group a day after a question the owner already answered.
      if (prev !== undefined && prev >= r.statusAtMs) r.askedOwnerAtMs = prev;
      else delete r.askedOwnerAtMs;
    });
  };

  const leaveRoom = async (chatId: number, why: string): Promise<void> => {
    const opts = optsNow();
    if (opts) {
      try {
        await leaveChat(opts, chatId);
      } catch (e) {
        fail("leave", e);
      }
    }
    // Blocked whatever Telegram said: the owner's no stands, and a stranger's
    // re-add is undone again (onMember).
    store.setStatus(chatId, "blocked");
    note("ok", `Telegram groups: left a group (${why})`);
  };

  /**
   * The in-memory books about one chat's conversation. The refusal stamps
   * stay: they are a rate limit, not memory, and forgetting would reset them.
   */
  const forgetInMemory = (chatId: number): void => {
    const prefix = `${chatId}:`;
    repliedTo.deleteWhere((k) => k.startsWith(prefix));
    fadedAt.deleteWhere((k) => k.startsWith(prefix));
    lastAddressed.deleteWhere((k) => k.startsWith(prefix));
    landedOn.deleteWhere((k) => k.startsWith(prefix));
    coinMissed.deleteWhere((k) => k.startsWith(prefix));
    askedIn.deleteWhere((k) => k.startsWith(prefix));
  };

  // ─── The memory pass ─────────────────────────────────────────────────────

  /** Rewrite a chat's summary and notes, off the hot path, when memory.ts says one is due. */
  const maybeMemoryPass = (chatId: number): void => {
    try {
      if (passing.has(chatId) || !canTalk(chatId)) return;
      const room = store.room(chatId);
      if (!room || !needsMemoryPass(room, clock())) return;
      const m = modelNow();
      if (!m) return;
      passing.add(chatId);
      const agentName = selfNow()?.name ?? "";
      // What the pass reads is only good while nothing is forgotten: a /forget
      // or /forgetme during the model call makes its answer a summary of what
      // was just wiped (applyMemoryPass drops it).
      const gen = store.forgetGen(chatId);
      track(
        (async () => {
          try {
            const r = await memoryPass(room, agentName, m, gate, clock());
            if (r && store.room(chatId)) applyMemoryPass(store, chatId, r, clock(), gen);
          } catch (e) {
            fail("memory pass", e);
          } finally {
            passing.delete(chatId);
          }
        })(),
      );
    } catch (e) {
      fail("memory pass", e);
    }
  };

  // ─── What a line means ───────────────────────────────────────────────────

  /** A coin it holds or has a memo for, said as a whole word: pacing's "a coin it has a take on". */
  const knownCoinIn = (text: string, room: TgRoom): boolean => {
    const names = new Set<string>();
    try {
      for (const n of portNow()?.heldNames() ?? []) if (typeof n === "string") names.add(n);
    } catch {
      /* no held names is no boost */
    }
    for (const c of room.coins) if (c.name) names.add(c.name);
    const hay = text.normalize("NFKC");
    for (const raw of names) {
      const n = raw.normalize("NFKC").trim();
      if ([...n].length < 3 || !/\p{L}/u.test(n)) continue;
      if (new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(n)}(?![\\p{L}\\p{N}_])`, "iu").test(hay)) return true;
    }
    return false;
  };

  /**
   * SMALL TALK SAID TO IT, a room's welcome included. detect.ts reads a line
   * that is small talk and nothing more ("hey there merryman", "thanks
   * pine!"). A welcome is small talk too, but it carries words that reader
   * rightly does not know: in "Hey there Merryman, and welcome to lust rage
   * mode (the redemption)! How are you?" the long part is the chat's own
   * title. Read whole, that line is a question, and without a model its
   * answer was "hmm good question". So when the whole line is not small
   * talk, the welcome ("(and) welcome (back|aboard) (to <title> | the group)")
   * is taken out and each sentence left is read on its own: small talk when
   * every one is. Only after "welcome to" is the title taken out, so a line
   * that merely names the chat is still read as what it says.
   */
  const smallTalkOf = (text: string, names: readonly string[], title: string): SmallTalk | null => {
    const whole = addressedSmallTalk(text, [...names]);
    if (whole) return whole;
    if (!/\bwelcome\b/i.test(text)) return null;
    const t = title.trim();
    const place = [WELCOME_PLACE, ...([...t].length >= 3 ? [escapeRe(t)] : [])].join("|");
    const welcome = new RegExp(`${WELCOME_HEAD}(?:\\s+(?:to|in|into)\\s+(?:${place}))?(?:\\s+(?:here|in here))?`, "giu");
    let found: SmallTalk | null = null;
    for (const piece of text.replace(welcome, " ").split(/[.!?…]+/u)) {
      if (!/[\p{L}\p{N}]/u.test(piece)) continue;
      const said = addressedSmallTalk(piece, [...names]);
      if (!said) return null;
      // A thanks, a gm or a gn outranks a plain hail said with it.
      if (!found || found === "hail") found = said;
    }
    // Nothing but the welcome: it was greeted, so it greets back.
    return found ?? "hail";
  };

  const signalsOf = (text: string, room: TgRoom, addressed: LineJob["addressed"]): PaceInput["signals"] => {
    // Every name the room calls it by: "pine is trash" is "merryman is trash".
    const names = selfNamesOf(selfNow());
    return {
      shush: isShush(text),
      greeting: greetingOf(text),
      insult: insultLevel(text, names),
      distress: isDistress(text),
      botQuestion: isBotQuestion(text),
      privateAsk: isPrivateAsk(text),
      injection: isInjection(text),
      tradeTalk: isTradeTalk(text),
      questionToRoom: isQuestionToRoom(text),
      knownCoin: knownCoinIn(text, room),
      // Only a line said TO it is small talk to answer.
      smallTalk: addressed !== null ? smallTalkOf(text, names, room.title) : null,
    };
  };

  /** A newer addressed line from the same person arrived within the burst: this one is not the one to answer. */
  const burstPassed = (chatId: number, j: LineJob): boolean => {
    const last = lastAddressed.get(`${chatId}:${j.line.fromId}`);
    return !!last && last.messageId !== j.line.messageId && last.atMs >= j.bornAtMs && last.atMs - j.bornAtMs <= BURST_MS;
  };

  /** Human lines after this one: an ambient line written for a chat that moved on is dropped. */
  const newerHumanLines = (chatId: number, messageId: number): number =>
    (store.room(chatId)?.lines ?? []).filter((l) => !l.own && l.messageId > messageId).length;

  const countAmbient = (chatId: number, n: number, stamp: boolean): void => {
    const now = clock();
    const day = utcDay(now);
    store.update(chatId, (r) => {
      const cur = r.ambient && r.ambient.day === day && Number.isFinite(r.ambient.n) ? r.ambient.n : 0;
      r.ambient = { day, n: cur + n };
      if (stamp) r.lastAmbientAtMs = now;
    });
  };

  const personOf = (chatId: number, id: number): TgPerson | undefined => store.person(chatId, id);

  /** After an answer to someone who called it: the flood window (and, for a roast, the roast window). */
  const noteAnswered = (chatId: number, j: LineJob, roast: boolean): void => {
    // Forgotten while the answer was out: no entry comes back for them.
    if (forgotten(j)) return;
    const now = clock();
    const p = personOf(chatId, j.line.fromId);
    store.upsertPerson(chatId, {
      id: j.line.fromId,
      name: j.line.name,
      ...(j.addressed !== null ? { answers: bump(p?.answers, now, FLOOD_WINDOW_MS) } : {}),
      ...(roast ? { roasts: bump(p?.roasts, now, ROAST_WINDOW_MS) } : {}),
    });
  };

  /**
   * "Still not sold on that one tbh": a line naming a coin it faded in this
   * chat, at low odds, once per coin per few hours, and within the day's
   * ambient budget. Only when pacing chose no words of its own.
   */
  const maybeFadedAgain = async (j: LineJob, cfg: ResolvedConfig | null): Promise<boolean> => {
    const chatId = j.msg.chatId;
    const memo = flow.fadedCoinIn(chatId, j.line.text);
    if (!memo) return false;
    const now = clock();
    const room = store.room(chatId);
    if (!room || shushedNow(room, now)) return false;
    const k = `${chatId}:${memo.address}`;
    const last = fadedAt.get(k);
    if (last !== undefined && now - last < FADED_EVERY_MS) return false;
    const cap = CHATTINESS[chattiness(cfg)].perDay;
    const used = room.ambient && room.ambient.day === utcDay(now) ? room.ambient.n : 0;
    if (used + 1 > cap) return false;
    if (roll() >= FADED_ODDS) return false;
    if (!reserveReply(chatId, j.line.messageId)) return false;
    fadedAt.set(k, now);
    const sent = await speak(chatId, { kind: "faded-again" }, {
      replyTo: j.line.messageId,
      ...(j.threadId !== undefined ? { threadId: j.threadId } : {}),
      trigger: j.line,
      senderName: j.line.name,
      ...(memo.name ? { coinName: memo.name } : {}),
      bornAtMs: j.bornAtMs,
      stillWanted: () => !forgotten(j),
    });
    if (!sent) {
      releaseReply(chatId, j.line.messageId);
      fadedAt.delete(k);
      return false;
    }
    countAmbient(sent.chatId, 1, true);
    return true;
  };

  /**
   * Act on pacing's decision. Books are kept only after a line or reaction
   * actually landed. Null when something landed; else why nothing did (Quiet).
   */
  const act = async (dec: PaceDecision, j: LineJob): Promise<Quiet | null> => {
    const chatId = j.msg.chatId;
    const messageId = j.line.messageId;
    // Why the line, or the reaction, did not go out: the send path says.
    let lost: Quiet = "send-failed";
    const miss = (why: Quiet): void => {
      lost = why;
    };
    /** `lost`, with "not-wanted" read as the reason it stopped being wanted. */
    const whyLost = (): Quiet => (lost !== "not-wanted" ? lost : forgotten(j) ? "forgotten" : j.addressed !== null && burstPassed(chatId, j) ? "burst" : "not-wanted");
    // Re-read right before the send: a newer line of the burst, or the sender
    // asking to be forgotten while this was typing, and it is not sent.
    const wanted = (): boolean => !forgotten(j) && (j.addressed === null || !burstPassed(chatId, j));
    const reply: SpeakOpts = {
      replyTo: messageId,
      ...(j.threadId !== undefined ? { threadId: j.threadId } : {}),
      trigger: j.line,
      senderName: j.line.name,
      bornAtMs: j.bornAtMs,
      ownerAddressed: j.isOwner && j.addressed !== null,
      stillWanted: wanted,
      miss,
    };
    switch (dec.act) {
      case "skip":
        return quietOfSkip(dec.why);
      case "react": {
        if (!reserveReply(chatId, messageId)) return "already-answered";
        const ok = await reactTo(chatId, messageId, dec.emoji, { ownerAddressed: reply.ownerAddressed === true, stillWanted: () => !forgotten(j), miss });
        if (!ok) {
          releaseReply(chatId, messageId);
          return whyLost();
        }
        // An unprompted reaction is half an ambient line; a 🤡 or 🥱 in answer is not ambient.
        if (j.addressed === null) countAmbient(chatId, 0.5, false);
        return null;
      }
      case "shush": {
        const now = clock();
        // Quiet from now, whether or not the "ok ok" lands: going quiet is the
        // safe direction, and a failed send must not leave it chatty.
        store.update(chatId, (r) => {
          const until = now + (j.isOwner ? OWNER_SHUSH_MS : SHUSH_MS);
          r.shushedUntilMs = Math.max(r.shushedUntilMs ?? 0, until);
        });
        if (!reserveReply(chatId, messageId)) return "already-answered";
        // The "ok ok" answers even a line a newer one followed; not one from
        // someone forgotten since (the quiet above still holds).
        const stillAsked = (): boolean => !forgotten(j);
        if (roll() < SHUSH_REACT_ODDS) {
          if (await reactTo(chatId, messageId, REACTION_FOR.shush[0], { stillWanted: stillAsked, miss })) return null;
          releaseReply(chatId, messageId);
          return whyLost();
        }
        const sent = await speak(chatId, { kind: "shushed" }, { ...reply, stillWanted: stillAsked });
        if (sent || (await reactTo(chatId, messageId, REACTION_FOR.shush[0], { stillWanted: stillAsked, miss }))) return null;
        releaseReply(chatId, messageId);
        return whyLost();
      }
      default:
        break;
    }

    let intent: TgIntent;
    let ambient = false;
    let replyOpts: SpeakOpts = reply;
    switch (dec.act) {
      case "answer":
        intent = { kind: "answer", mood: dec.mood };
        break;
      case "roast":
        intent = { kind: "roast", owner: dec.owner };
        break;
      case "kind":
        intent = { kind: "kind" };
        break;
      case "greet":
        intent = { kind: "greet", word: dec.word };
        break;
      case "smalltalk":
        // "hey 👋" to a hail, "np 🤝" to thanks: a template, as a reply.
        intent = { kind: "smalltalk", what: dec.what };
        break;
      case "ambient": {
        intent = { kind: "ambient", topic: dec.topic };
        ambient = true;
        // Joining in is not a reply, except to answer a question left hanging
        // (a deferred line is always one, whatever topic pacing named).
        const base: SpeakOpts = {
          ...(j.threadId !== undefined ? { threadId: j.threadId } : {}),
          trigger: j.line,
          senderName: j.line.name,
          bornAtMs: j.bornAtMs,
          ambient: true,
          stillWanted: () => !forgotten(j) && newerHumanLines(chatId, messageId) < NEWER_LINES_DROP,
          miss,
        };
        replyOpts = dec.topic === "question" || j.deferred === true ? { ...base, replyTo: messageId } : base;
        break;
      }
      default:
        return "skipped";
    }

    if (!reserveReply(chatId, messageId)) return "already-answered";
    if (dec.act === "answer" && dec.mood !== "injection" && dec.mood !== "bot-question") {
      const request = publicFactRequest(j.line.text, selfNamesOf(selfNow())) ?? repliedTradeRequest(j);
      const context = coinContext(j);
      const coinQuestion = asksAboutCoin(j.line.text, selfNamesOf(selfNow())) || /\b(?:why|how come)\b/iu.test(j.line.text);
      const wantedFact = request || (context && coinQuestion);
      // Slow reads use a detached lane: another line, the owner's commands
      // and this chat's subsequent questions continue while evidence loads.
      if (wantedFact && !isInjection(j.line.text)) {
        const coinOnly = !request;
        if (coinOnly && !coinFactsOn()) { releaseReply(chatId, messageId); return "coin-off"; }
        const factualOpts = coinOnly ? { ...replyOpts, stillWanted: () => wanted() && coinFactsOn() } : replyOpts;
        track((async () => {
          const fact = request ? await requestedFact(request, chatId) : await coinFact(context!);
          const sent = await speak(chatId, { kind: "public-fact", fact }, factualOpts);
          if (sent) noteAnswered(sent.chatId, j, false);
          else { releaseReply(chatId, messageId); if (j.addressed !== null) quietLine(whyLost()); }
        })());
        return null;
      }
    }
    const sent = await speak(chatId, intent, replyOpts);
    if (!sent) {
      releaseReply(chatId, messageId);
      return whyLost();
    }
    const at = sent.chatId;
    switch (dec.act) {
      case "answer":
      case "kind":
        noteAnswered(at, j, false);
        return null;
      case "roast":
        noteAnswered(at, j, true);
        return null;
      case "smalltalk":
        noteAnswered(at, j, false);
        // A gm said to it by name is its greeting to them for the day: the
        // unasked gm answer (once per person per day) is not a second one.
        if ((dec.what === "gm" || dec.what === "gn") && !forgotten(j)) {
          store.upsertPerson(at, { id: j.line.fromId, name: j.line.name, greetedDay: utcDay(clock()) });
        }
        return null;
      case "greet": {
        // Forgotten while the greeting was out: no entry comes back for them.
        if (forgotten(j)) return null;
        store.upsertPerson(at, {
          id: j.line.fromId,
          name: j.line.name,
          greetedDay: utcDay(clock()),
          ...(j.addressed !== null ? { answers: bump(personOf(at, j.line.fromId)?.answers, clock(), FLOOD_WINDOW_MS) } : {}),
        });
        // A greeting in words unasked is an ambient line (pacing.ts), so a gm thread cannot blow the day's cap.
        if (j.addressed === null) countAmbient(at, 1, true);
        return null;
      }
      case "ambient":
        if (ambient) countAmbient(at, 1, true);
        return null;
      default:
        return null;
    }
  };

  /**
   * Bind a reply to the coin it actually answered, including our own ack or
   * outcome. All message ids and memos come from this chat only. Never choose
   * the last coin globally: two groups, or two concurrent coins, must not mix.
   */
  const coinContext = (j: LineJob): { address: string; memo?: TgCoinMemo } | null => {
    if (j.addressed === null) return null;
    const stored = store.room(j.msg.chatId);
    if (!stored) return null;
    const room = freshView(stored, clock());
    const tags = extractCashtags(j.line.text);
    const requestedName = /\b(?:about|take on|thoughts on|wdyt(?: about)?)\s+\$?([a-z][a-z0-9]{1,15})\b/iu.exec(j.line.text)?.[1];
    const explicit = requestedName && !/^(?:this|that|it|one|coin|token|you|u|the|a|i|is)$/iu.test(requestedName) ? requestedName.toUpperCase() : null;
    const matchesAsk = (memo: TgCoinMemo): boolean => (!tags.length || tags.every((tag) => tag === memo.name?.toUpperCase())) && (!explicit || explicit === memo.name?.toUpperCase());
    const named = room.coins.filter((c) => c.name && matchesAsk(c) && new RegExp(`(?<![\\p{L}\\p{N}])${c.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu").test(j.line.text));
    if (named.length === 1) return { address: named[0]!.address, memo: named[0] };
    if (named.length > 1) return null;
    let id = j.line.replyTo;
    const seen = new Set<number>();
    for (let depth = 0; isMsgId(id) && depth < 8; depth++) {
      if (seen.has(id)) break;
      seen.add(id);
      const memo = room.coins.find((c) => c.messageId === id);
      if (memo) return matchesAsk(memo) ? { address: memo.address, memo } : null;
      const line = room.lines.find((l) => l.messageId === id);
      const quote = depth === 0 && j.msg.replyTo?.messageId === id ? j.msg.replyTo : undefined;
      const text = line?.text ?? quote?.text ?? "";
      if (isDistress(text)) return null;
      if (!line?.own && quote?.fromId !== selfNow()?.id) {
        const hits = extractCaHits(text).filter((h) => h.chain !== "other");
        if (hits.length === 1 && !tags.length && !explicit && !hasOtherChainLink(text) && !hasForeignMint(text)) return { address: hits[0]!.address };
      }
      if (!line) break;
      id = line.replyTo;
    }
    // A name-only question must name one unambiguous coin remembered HERE.
    return null;
  };

  /** A bare "why?" below the public trade summary reloads the same records. */
  const repliedTradeRequest = (j: LineJob): PublicFactRequest | null => {
    if (j.addressed === null || !/\b(?:why|how come)\b/iu.test(j.line.text)) return null;
    const stored = store.room(j.msg.chatId);
    if (!stored) return null;
    const room = freshView(stored, clock());
    let id = j.line.replyTo;
    const seen = new Set<number>();
    for (let depth = 0; isMsgId(id) && depth < 8; depth++) {
      if (seen.has(id)) break;
      seen.add(id);
      const line = room.lines.find((l) => l.messageId === id);
      if (!line) return null;
      if (!line.own) {
        const request = publicFactRequest(line.text, selfNamesOf(selfNow()));
        return request?.kind === "trades" ? { ...request, why: true } : null;
      }
      id = line.replyTo;
    }
    return null;
  };

  /** Time-box a read without holding the per-chat queue. Late evidence is ignored. */
  const readFact = async <T>(read: () => Promise<T>): Promise<T | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const expired = d.timer ? d.timer(10 * SEC).then(() => null) : new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 10 * SEC);
        timer.unref?.();
      });
      return await Promise.race([Promise.resolve().then(read), expired]);
    } catch (e) {
      fail("public facts", e);
      return null;
    } finally { if (timer) clearTimeout(timer); }
  };

  const requestedFact = async (request: PublicFactRequest, chatId: number): Promise<TgPublicFact> => {
    if (request.kind === "calculation") return request.fact;
    if (request.kind === "site") return request;
    const data = await readFact(async () => d.facts?.()?.tradesToday() ?? null);
    if (!data) return { kind: "unavailable", topic: "trades" };
    const stored = store.room(chatId);
    const memos = stored ? freshView(stored, clock()).coins : [];
    // A name can be reused, and the same coin can be bought for a different
    // reason later. Only the exact recorded decision may supply its public
    // outcome rationale. No raw owner decision text enters this projection.
    const trades = request.why ? data.trades.map((trade) => {
      if (trade.side !== "buy" || !trade.decisionId) return trade;
      const memo = memos.find((c) => c.verdict === "bought" && c.decisionId === trade.decisionId && (c.paper === true) === trade.paper);
      const reason = memo && publicCoinReason(memo.notes);
      return reason ? { ...trade, why: reason } : trade;
    }) : data.trades;
    return { kind: "trades", data: { ...data, trades }, why: request.why, ...(request.symbol ? { symbol: request.symbol } : {}), ...(request.side ? { side: request.side } : {}) };
  };

  const coinFact = async (context: { address: string; memo?: TgCoinMemo }): Promise<TgPublicFact> => {
    const look = await readFact<CoinLook>(async () => coinFactsOn() ? portNow()?.look(context.address) ?? { kind: "unknown" } : { kind: "unknown" });
    if (!look) return { kind: "unavailable", topic: "coin" };
    const memo = context.memo;
    const reviewed = memo?.decisionId && (memo.verdict === "bought" || memo.verdict === "passed" || memo.verdict === "skipped") ? {
      verdict: memo.verdict,
      ...(memo.paper ? { paper: true } : {}),
      ...(memo.notes ? { notes: memo.notes } : {}),
    } : undefined;
    return { kind: "coin", look: { ...look, ...(look.name ? {} : memo?.name ? { name: memo.name } : {}) }, nowMs: clock(), ...(reviewed ? { reviewed } : {}) };
  };

  /** ONE LINE, off the poll loop: the coin flow first, then pacing, then the words. */
  const processLine = async (j: LineJob): Promise<void> => {
    const why = await lineOutcome(j);
    // Only a line said TO it is owed an explanation in the log.
    if (why !== null && j.addressed !== null) quietLine(why);
  };

  /**
   * A REPLY TO A COIN POST, SAID TO IT, THAT ASKS ABOUT THAT COIN: "wdyt
   * about this shogun" under someone's CA names no coin in its own words, so
   * the coin is read off the post it answers — the text Telegram quoted with
   * the reply (the whole post), else this chat's remembered line (its first
   * 400 characters). This is the fallback for a coin not yet remembered here:
   * it goes through the coin flow, claimed under the reply's own message id,
   * with the usual look, readiness, nomination and replay checks. An explicit
   * follow-up about a remembered coin uses coinContext and the detached
   * factual lane instead, with dated public evidence and no new nomination.
   *
   * Only a line said to it that ASKS (detect.ts asksAboutCoin): "gm gm", a
   * question about something else, or "don't touch this one pls" under a coin
   * post is chatter, and a reply that did not call it is chatter between
   * people. Replies to its own acknowledgement or outcome are resolved by
   * coinContext, which follows this chat's reply chain. Never a distress
   * post's coin: "lost everything on 0x… i want to die" is a person, not a
   * coin to look at, whoever replies to it.
   *
   * WHILE THAT POST IS STILL ON THE COIN LANE its own answer is on its way,
   * and this helper records who asked (CoinFlow.askedWhileWorking) without
   * starting another nomination. The detached factual lane can join the
   * existing bounded read; other conversation continues while evidence loads.
   * A timeout gives an honest unavailable answer, and the original coin flow
   * can also report its failed look to the asker, subject to forget checks.
   */
  const repliedCoin = (j: LineJob): { cas: string[]; otherChain: string[]; foreignMint: boolean } | null => {
    if (j.addressed === null) return null;
    const chatId = j.msg.chatId;
    const to = j.line.replyTo;
    if (!isMsgId(to)) return null;
    const me = selfNow();
    if (!asksAboutCoin(j.line.text, selfNamesOf(me))) return null;
    const quote = j.msg.replyTo?.messageId === to ? j.msg.replyTo : undefined;
    if (me && quote?.fromId === me.id) return null;
    const remembered = store.room(chatId)?.lines.find((l) => l.messageId === to);
    if (remembered?.own) return null;
    const text = (typeof quote?.text === "string" && quote.text) || remembered?.text || "";
    // An explicit ticker can name another coin. Bind it to the quote only
    // when that same ticker occurs there; otherwise ask for its own CA.
    const askedTags = extractCashtags(j.line.text);
    const quotedTags = extractCashtags(text);
    if (askedTags.some((tag) => !quotedTags.includes(tag))) return null;
    if (flow.working(chatId, to)) {
      flow.askedWhileWorking(chatId, to, { senderId: j.line.fromId, senderName: j.via ? "" : j.line.name, forgotten: () => forgotten(j) });
      return null;
    }
    if (!text || isDistress(text)) return null;
    const hits = extractCaHits(text);
    const foreignMint = hasForeignMint(text) || hasOtherChainLink(text);
    if (hits.length === 0 && !foreignMint) return null;
    return { cas: hits.map((h) => h.address), otherChain: hits.filter((h) => h.chain === "other").map((h) => h.address), foreignMint };
  };

  /**
   * ONE LOG LINE PER COIN POST: whether it was said to it, what came of it,
   * and what each look found and which read answered — so a coin that got
   * silence always says why. Kinds, source names and codes only: never the
   * text, the address, the title or a name.
   */
  const coinPostLine = (how: "to me" | "reply to a coin post" | "not to me", end: CoinPostEnd, missed: Quiet | undefined): void => {
    stats.coinPosts += 1;
    if (end.acted) stats.coinAnswered += 1;
    const what = end.acted ? "answered" : `nothing (${missed ?? end.quiet ?? "coin-silent"})`;
    const looks = Array.isArray(end.looks) && end.looks.length > 0 ? `; look: ${end.looks.join(", ")}` : "";
    log(`[tg-groups] coin post (${how}): ${what}${looks}`);
  };

  /** processLine's work. Null when something landed or is still on its way (the coin lane); else why nothing will. */
  const lineOutcome = async (j: LineJob): Promise<Quiet | null> => {
    const chatId = j.msg.chatId;
    let cfg = cfgNow();
    const cannot = talkWhy(chatId, cfg);
    if (cannot) return cannot;
    // Queued before the sender (or the whole chat) was forgotten: nothing
    // more happens for this line, not a claim, not a word, not a counter.
    if (forgotten(j)) return "forgotten";
    const text = j.line.text;

    // DISTRESS BEFORE COINS. "lost everything on 0x… i want to die" is a
    // person in trouble, not a coin to look at: it is never nominated, and it
    // gets the kind line (pacing), not "hmm is this good?".
    if (!j.deferred && !isDistress(text)) {
      // Every CA with the chain its link names: the flow sets aside those in
      // another chain's link before it counts the first two.
      const hits = extractCaHits(text);
      let cas = hits.map((h) => h.address);
      let otherChain = hits.filter((h) => h.chain === "other").map((h) => h.address);
      // Another chain's coin with no 0x + 40-hex address in it: a mint, a TON
      // address, or a chart link DexScreener hands out for a Solana, TON, Sui
      // or v4 pair. The flow owns the line and says nothing.
      let foreignMint = hasForeignMint(text) || hasOtherChainLink(text);
      let cashtags = extractCashtags(text);
      const rememberedAsk = cas.length === 0 && !foreignMint && j.addressed !== null && asksAboutCoin(text, selfNamesOf(selfNow())) && !!coinContext(j)?.memo;
      // No coin in its own words, said to it, under a coin post: it asks about
      // that post's coin (repliedCoin). A ticker can refer to it only when
      // the quoted post names the same ticker.
      const asked = !rememberedAsk && cas.length === 0 && !foreignMint ? repliedCoin(j) : null;
      if (asked) {
        ({ cas, otherChain, foreignMint } = asked);
        cashtags = [];
      }
      if (!rememberedAsk && (cas.length > 0 || foreignMint || cashtags.length > 0)) {
        stageOf(chatId, "coin flow");
        const post = await flow.begin(chatId, j.line, {
          senderId: j.line.fromId,
          // Nobody to tag behind an anonymous admin or a channel: the tag would name the chat's placeholder.
          senderName: j.via ? "" : j.line.name,
          ...(typeof j.msg.dateSec === "number" ? { dateSec: j.msg.dateSec } : {}),
          cas,
          ...(otherChain.length > 0 ? { otherChain } : {}),
          foreignMint,
          cashtags,
          addressed: j.addressed !== null,
          // Its lines go out within STALE_MS of the line arriving or not at
          // all (whyNot): a post still waiting on the coin lane past that is
          // not looked at, and a look is cut to fit.
          replyByMs: j.bornAtMs + STALE_MS,
          forgotten: () => forgotten(j),
        });
        // The coin flow owns the message: nothing else is said about it. Its
        // looks and lines run on the chat's coin lane (coins.ts), OFF this
        // queue: the next line here is read now, not after the reads.
        if (post.owned === "handled") {
          const key = msgKey(chatId, j.line.messageId);
          const how = asked ? "reply to a coin post" : j.addressed !== null ? "to me" : "not to me";
          track(
            post.done.then((end) => {
              const acted = end.acted || landedOn.has(key);
              coinPostLine(how, { ...end, acted }, coinMissed.get(key));
              if (j.addressed === null || acted) return;
              quietLine(coinMissed.get(key) ?? end.quiet ?? "coin-silent");
            }),
          );
          return null;
        }
      }
    }

    const now = clock();
    if (now - j.bornAtMs > STALE_MS) return "stale";
    if (forgotten(j)) return "forgotten";
    cfg = cfgNow();
    const room = store.room(chatId);
    const lost = talkWhy(chatId, cfg);
    if (!room || lost) return lost ?? "room-not-approved";
    const signals = signalsOf(text, room, j.addressed);

    // A QUESTION TO THE ROOM is looked at again in a minute: pacing can only
    // see "nobody answered it" once a minute has passed, and answering it at
    // once would be the lurker who beats everyone to it. Never a line that
    // reads as distress ("anyone else want to die after this?"): the kind
    // line does not wait. Nor a shush or an insult, which pacing settles now.
    const plainQuestion = !signals.distress && !signals.shush && signals.insult === "none";
    if (!j.deferred && j.addressed === null && plainQuestion && signals.questionToRoom && j.line.replyTo === undefined && extractCas(text).length === 0) {
      track(
        (async () => {
          await sleep(QUESTION_WAIT_MS);
          if (stopped || forgotten(j)) return;
          // A fresh staleness clock, but the same seenAtMs: a /forgetme during
          // the wait still cancels it.
          enqueue(chatId, () => processLine({ ...j, deferred: true, bornAtMs: clock() }));
        })(),
      );
      return null;
    }

    if (j.addressed !== null && burstPassed(chatId, j)) return "burst";

    const m = modelNow();
    stageOf(chatId, "decide");
    const dec = decide({
      room,
      line: j.line,
      addressed: j.addressed,
      isOwner: j.isOwner,
      fromIsBot: fromBot(j.msg),
      chattiness: chattiness(cfg),
      nowMs: now,
      rand,
      hasModel: m !== null && gate.available(chatId),
      signals,
    });
    if ((dec.act === "skip" || dec.act === "react") && j.addressed === null && (await maybeFadedAgain(j, cfg))) return null;
    stageOf(chatId, `act: ${dec.act}`);
    return act(dec, j);
  };

  // ─── The owner's /groups and its buttons ─────────────────────────────────

  const STATUS_WORDS: Record<TgRoom["status"], string> = {
    approved: "talking there",
    pending: "waiting for your ok",
    left: "not in it any more",
    blocked: "you told me to leave",
  };
  const STATUS_ORDER: Record<TgRoom["status"], number> = { pending: 0, approved: 1, left: 2, blocked: 3 };

  const listing = (): { html: string; keyboard: InlineKeyboard } => {
    const rooms = store
      .rooms()
      .slice()
      .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.statusAtMs - a.statusAtMs || a.chatId - b.chatId);
    const cfg = cfgNow();
    const lines: string[] = [];
    if (rooms.length === 0) {
      lines.push("I'm not in any Telegram groups yet. Add me to one and I'll say hi.");
    } else {
      lines.push("<b>Your Telegram groups</b>");
      rooms.forEach((r, i) => lines.push(`${i + 1}. ${r.title ? `«${esc(r.title)}»` : "a group"} — ${STATUS_WORDS[r.status]}`));
    }
    if (!switchOn()) lines.push("", "Telegram groups are switched off on this server, so I stay quiet in all of them.");
    else if (cfg?.telegramGroupsEnabled !== true) lines.push("", "Telegram groups are switched off in Settings → Telegram, so I stay quiet in all of them.");
    let off: boolean | null = null;
    try {
      off = d.privacyOff();
    } catch {
      off = null;
    }
    if (off === false) {
      lines.push(
        "",
        "Privacy mode is on for me, so in groups I only hear commands and replies to me. To let me follow along: @BotFather → /setprivacy → your bot → Disable, then remove me from each group and add me back.",
      );
    }
    const keyboard: InlineKeyboard = [];
    rooms.forEach((r, i) => {
      const n = i + 1;
      const row: InlineKeyboard[number] = [];
      if (r.status === "pending") row.push({ text: `${n} · Stay`, callbackData: `${CB_PREFIX}stay:${r.chatId}` });
      if (r.status === "pending" || r.status === "approved") row.push({ text: `${n} · Leave`, callbackData: `${CB_PREFIX}leave:${r.chatId}` });
      row.push({ text: `${n} · Forget`, callbackData: `${CB_PREFIX}forget:${r.chatId}` });
      keyboard.push(row);
    });
    return { html: lines.join("\n"), keyboard };
  };

  /** A /forget or /forgetme just happened: see forgottenSince. `userId` absent is the whole chat. */
  const markForgotten = (chatId: number, userId?: number): void => {
    forgottenAt.set(`${chatId}:${userId === undefined ? "*" : userId}`, clock());
  };

  /**
   * THE REQUEST ITSELF, ON DISK, BEFORE ANYTHING ELSE (store.recordForget).
   * This store is not always the memory: a hosted child whose memory could not
   * be restored runs with its groups held off, on an empty store, and a wipe
   * of that store erases nothing the sealed copy holds. The record is what
   * reaches that copy. So it is written whatever the switches say and whether
   * or not this store knows the chat. A failed write is logged by the store;
   * the wipe below happens all the same.
   */
  const recordForget = (chatId: number, userId: number | "*"): void => {
    if (!Number.isSafeInteger(chatId)) return;
    try {
      store.recordForget({ chatId, userId, atMs: clock() });
    } catch (e) {
      fail("forget record", e);
    }
  };

  const forgetChat = (chatId: number, messageId?: number, o?: { late?: boolean }): void => {
    try {
      recordForget(chatId, "*");
      if (!store.room(chatId)) return;
      markForgotten(chatId);
      store.forgetChat(chatId);
      forgetInMemory(chatId);
      note("ok", "Telegram groups: the owner wiped one group's memory");
      // A late request is done, not answered: the room has moved on.
      if (o?.late === true) return;
      enqueue(
        chatId,
        async () => {
          if (!canTalk(chatId)) return;
          await speak(chatId, { kind: "forgot" }, { ...(isMsgId(messageId) ? { replyTo: messageId } : {}), ownerAddressed: true });
        },
        { force: true },
      );
    } catch (e) {
      fail("forget", e);
    }
  };

  // ─── The surface ─────────────────────────────────────────────────────────

  const sweep = async (): Promise<void> => {
    try {
      if (stopped) return;
      const now = clock();
      // RETENTION, whatever the switches say: the age limits are a promise
      // about what is kept, not a feature to switch off. Cheap, and it writes
      // only when something aged out.
      if (!(now - prunedAt < PRUNE_EVERY_MS)) {
        prunedAt = now;
        try {
          store.prune();
        } catch (e) {
          fail("prune", e);
        }
      }
      if (!switchOn()) return;
      for (const room of store.rooms()) {
        try {
          if (room.status === "pending") {
            // Only a group a known stranger added is left unanswered. One the
            // bot was already in when first seen may well be the owner's own.
            if (strangerAdded(room) && room.askedOwnerAtMs !== undefined && now - room.askedOwnerAtMs >= PENDING_LEAVE_MS) {
              await leaveRoom(room.chatId, "the owner didn't answer within a day");
              continue;
            }
            await askOwner(room.chatId);
          } else if (room.status === "approved") {
            // The "three quiet hours" pass: nothing else is happening in that chat to trigger it.
            maybeMemoryPass(room.chatId);
          }
        } catch (e) {
          fail("sweep", e);
        }
      }
    } catch (e) {
      fail("sweep", e);
    }
  };

  const sweepTimer = setInterval(() => void track(sweep()), SWEEP_MS);
  sweepTimer.unref?.();
  /**
   * THE HEARTBEAT: what the handler has seen in the last few minutes, when it
   * has seen anything or is holding something. Counts and stage names only.
   */
  const heartbeat = (): void => {
    try {
      const t = clock();
      let oldest: { stage: string; since: number } | null = null;
      for (const r of running.values()) if (!oldest || r.since < oldest.since) oldest = r;
      const queued = [...queues.values()].reduce((n, q) => n + q.size, 0);
      const busy = oldest ? `, oldest job ${Math.round((t - oldest.since) / SEC)}s at "${oldest.stage}"` : "";
      const any = Object.values(stats).some((n) => n > 0) || queued > 0;
      if (any) {
        log(
          `[tg-groups] last ${Math.round(HEARTBEAT_MS / MIN)} min: ${stats.lines} group lines (${stats.addressed} to me), ` +
            `skipped: ${stats.notApproved} room not approved, ${stats.off} switched off, ${stats.noRoom} no room, ${stats.blocked} blocked, ${stats.noSelf} before I knew who I am; ` +
            `${stats.dropped} dropped (queue full), ${stats.stalled} jobs past ${Math.round(stallMs / SEC)}s and ${stats.lockStalled} sends past ${Math.round(stallMs / 2 / SEC)}s; ` +
            `${stats.coinPosts} coin posts (${stats.coinAnswered} answered); ` +
            `${queued} queued${busy}`,
        );
      }
      for (const k of Object.keys(stats) as (keyof typeof stats)[]) stats[k] = 0;
    } catch (e) {
      fail("heartbeat", e);
    }
  };
  const heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
  heartbeatTimer.unref?.();
  // The boot line: which model writes group lines (names only).
  try {
    modelNow();
  } catch {
    /* logged inside */
  }

  return {
    onMessage(msg: TgMessage): void {
      try {
        if (stopped || !msg || typeof msg !== "object") return;
        const chatId = msg.chatId;
        if (typeof chatId !== "number" || !isTgGroup(msg.chatType, chatId)) return;
        stats.lines += 1;
        const cfg = cfgNow();
        const from = typeof msg.fromId === "number" && !fromBot(msg) ? { fromId: msg.fromId, via: viaChat(msg) } : undefined;
        const room = knownRoom(chatId, { title: msg.chatTitle, kind: msg.chatType, isForum: msg.isForum }, cfg, from);
        if (!room) {
          stats.noRoom += 1;
          return;
        }
        if (room.status === "blocked") {
          stats.blocked += 1;
          // The owner said leave; a line proves it is back. Leave again, once per process.
          if (!releft.has(chatId) && featureOn(cfg)) {
            releft.add(chatId);
            track(leaveRoom(chatId, "the owner said leave"));
          }
          return;
        }
        // Everything below is a group line or a memory write: the operator's
        // switch, the owner's setting and the room's status each stop it.
        if (!featureOn(cfg) || room.status !== "approved") {
          if (featureOn(cfg)) stats.notApproved += 1;
          else stats.off += 1;
          // Said to it where it may not talk: the operator hears why, never what.
          const me = selfNow();
          const said = typeof msg.text === "string" ? msg.text.trim() : "";
          if (me && said && !said.startsWith("/") && !fromBot(msg) && msg.fromId !== me.id && addressedHow(msg, me) !== null) {
            quietLine(featureOn(cfg) ? "room-not-approved" : "off");
          }
          return;
        }
        const messageId = msg.messageId;
        if (!isMsgId(messageId)) return;
        const text = typeof msg.text === "string" ? msg.text : "";
        // Voice notes are ignored in groups; stickers and bare media never get here.
        if (!text.trim()) return;
        if (fromBot(msg)) return;
        const me = selfNow();
        if (me && msg.fromId === me.id) return;
        if (text.trim().startsWith("/")) return;

        const now = clock();
        const via = viaChat(msg);
        const owner = ownerId();
        const isOwner = !via && owner !== null && msg.fromId === owner;
        const name = displayName(msg);
        const atMs = typeof msg.dateSec === "number" && Number.isFinite(msg.dateSec) ? Math.min(now, msg.dateSec * 1000) : now;
        const line: TgLine = {
          messageId,
          fromId: msg.fromId,
          name,
          text,
          atMs,
          ...(msg.replyTo && isMsgId(msg.replyTo.messageId) ? { replyTo: msg.replyTo.messageId } : {}),
        };
        // A redelivered update (a replayed batch) is already remembered, and was already answered.
        if (!store.addLine(chatId, line)) return;
        store.upsertPerson(chatId, { id: msg.fromId, name, lastSeenMs: now });
        if (isOwner && typeof msg.fromFirstName === "string" && msg.fromFirstName.trim() && room.ownerName !== mentionName(msg.fromFirstName)) {
          const first = msg.fromFirstName;
          store.update(chatId, (r) => {
            r.ownerName = first;
          });
        }
        const key = msgKey(chatId, messageId);
        received.set(key, now);
        // THE TOPIC ONLY WHEN TELEGRAM SAYS IT IS ONE. A reply in a forum's
        // General topic carries message_thread_id too — the reply thread's,
        // with no is_topic_message — and a send naming it is refused ("message
        // thread not found"), so the answer was lost. The reply itself lands
        // next to the message it answers.
        const threadId = msg.isTopicMessage === true && isMsgId(msg.messageThreadId) ? msg.messageThreadId : undefined;
        if (threadId !== undefined) threads.set(key, threadId);
        const addressed = me ? addressedHow(msg, me) : null;
        // Without getMe's answer nothing can be addressed to it: counted, so
        // "every mention is ignored" shows up as what it is.
        if (!me) stats.noSelf += 1;
        if (addressed !== null) {
          stats.addressed += 1;
          lastAddressed.set(`${chatId}:${msg.fromId}`, { messageId, atMs: now });
          askedIn.set(key, true);
        }
        maybeMemoryPass(chatId);

        const job: LineJob = { msg, line, addressed, isOwner, via, bornAtMs: now, seenAtMs: now, ...(threadId !== undefined ? { threadId } : {}) };
        // A line with a coin in it is always queued: its claim and nomination
        // must not be lost to a busy chat. Chatter past the cap is remembered only.
        const coin = extractCas(text).length > 0;
        enqueue(chatId, () => processLine(job), { force: coin || addressed !== null });
      } catch (e) {
        fail("message", e);
      }
    },

    onMember(u: TgMemberUpdate, o?: { late?: boolean }): void {
      try {
        if (stopped || !u || typeof u !== "object" || typeof u.chatId !== "number") return;
        if (u.chatType !== "group" && u.chatType !== "supergroup") return;
        const chatId = u.chatId;
        const nowIn = isIn(u.newStatus, u.newIsMember);
        const admin = u.newStatus === "administrator" || u.newStatus === "creator";
        const wasAdmin = u.oldStatus === "administrator" || u.oldStatus === "creator";
        if (nowIn) adminIn.set(chatId, admin);
        else adminIn.delete(chatId);
        const cfg = cfgNow();
        const existing = store.room(chatId);
        if (!nowIn) {
          if (!existing) return;
          // Removed or kicked. A blocked room stays blocked: that is our own
          // leave arriving back, and the owner's no still stands.
          if (existing.status !== "blocked" && existing.status !== "left") {
            store.setStatus(chatId, "left");
            note("ok", "Telegram groups: removed from a group (memory kept for 30 days)");
          }
          store.update(chatId, (r) => {
            delete r.helloSaid;
          });
          forgetInMemory(chatId);
          return;
        }
        const wasOut = !isIn(u.oldStatus, undefined);
        const owner = ownerId();
        const byOwner = owner !== null && u.fromId === owner;
        const linked = cfg?.telegramAllowlist?.includes(chatId) === true;
        const room = store.ensureRoom(
          chatId,
          {
            title: typeof u.chatTitle === "string" ? u.chatTitle : "",
            kind: u.chatType,
            ...(typeof u.isForum === "boolean" ? { isForum: u.isForum } : {}),
          },
          { owner: byOwner || linked },
        );
        if (!room) {
          // Thirty groups already, every one the owner's decision (a Stay or a
          // Leave): a stranger's new group does not push one of them out. It
          // cannot be kept track of, so it is left rather than sat in silently.
          if (switchOn()) track(leaveRoom(chatId, "no room to keep track of another group"));
          return;
        }
        const added = wasOut || !existing || existing.status === "left";
        if (added && Number.isSafeInteger(u.fromId)) {
          // Who added it, whatever the status becomes: setStatus records this
          // only on a change, and a room created just now is already pending.
          const at = clock();
          store.update(chatId, (r) => {
            r.addedById = u.fromId;
            r.addedAtMs = at;
          });
        }
        // No longer an admin in a group it talks in: from now on privacy mode
        // decides what it hears, so the steps it skipped as an admin are due.
        if (!added && wasAdmin && !admin && room.status === "approved") {
          enqueue(chatId, () => privacyHint(chatId), { force: true });
        }
        if (byOwner) {
          if (room.status !== "approved" || added) approve(chatId, u.fromId, "added to a group by the owner", o?.late === true);
          return;
        }
        if (!added) return; // a promotion or a restriction by someone else changes nothing
        if (room.status === "blocked") {
          // The owner said leave; a stranger adding it back is undone quietly,
          // without asking the owner the same question again.
          if (switchOn()) track(leaveRoom(chatId, "the owner said leave"));
          return;
        }
        if (linked) {
          approve(chatId, u.fromId, "added to a group the owner linked", o?.late === true);
          return;
        }
        // A new pending spell asks afresh (setStatus clears the old ask), and
        // a failed ask from an earlier spell does not hold this one back.
        store.setStatus(chatId, "pending", u.fromId);
        askFailedAt.delete(chatId);
        track(askOwner(chatId));
      } catch (e) {
        fail("member", e);
      }
    },

    onService(s: TgServiceMessage): void {
      try {
        if (stopped || !s || typeof s !== "object" || typeof s.chatId !== "number") return;
        if (s.chatType !== "group" && s.chatType !== "supergroup") return;
        const chatId = s.chatId;
        // A group that became a supergroup: its state moves to the new id.
        // Both notices arrive (one in each chat); the second finds nothing to move.
        if (typeof s.migrateToChatId === "number") {
          store.migrate(chatId, s.migrateToChatId);
          forgetInMemory(chatId);
          return;
        }
        if (typeof s.migrateFromChatId === "number") {
          if (store.room(s.migrateFromChatId)) store.migrate(s.migrateFromChatId, chatId);
          forgetInMemory(s.migrateFromChatId);
          return;
        }
        const me = selfNow();
        if (s.leftChatMember && me && s.leftChatMember.id === me.id) {
          const room = store.room(chatId);
          if (room && room.status !== "blocked" && room.status !== "left") {
            store.setStatus(chatId, "left");
            note("ok", "Telegram groups: removed from a group (memory kept for 30 days)");
          }
          return;
        }
        const joined = (s.newChatMembers ?? []).filter((m) => m && !m.isBot && (!me || m.id !== me.id));
        if (joined.length === 0) return;
        const cfg = cfgNow();
        if (!canTalk(chatId, cfg)) return;
        const room = store.room(chatId);
        const now = clock();
        if (!room || shushedNow(room, now)) return;
        const day = utcDay(now);
        const n = room.welcomes && room.welcomes.day === day ? room.welcomes.n : 0;
        if (n >= WELCOMES_PER_DAY) return;
        if (roll() >= WELCOME_ODDS) return;
        const first = joined[0];
        const name = first ? displayName({ fromFirstName: first.firstName, ...(first.username ? { fromUsername: first.username } : {}) }) : "";
        enqueue(chatId, async () => {
          const sent = await speak(chatId, { kind: "welcome", name }, { ...(isMsgId(s.messageId) ? { replyTo: s.messageId } : {}), senderName: name, bornAtMs: now });
          if (!sent) return;
          const today = utcDay(clock());
          store.update(sent.chatId, (r) => {
            const cur = r.welcomes && r.welcomes.day === today ? r.welcomes.n : 0;
            r.welcomes = { day: today, n: cur + 1 };
          });
        });
      } catch (e) {
        fail("service", e);
      }
    },

    async onCallback(cb: TgCallback, o?: { late?: boolean }): Promise<boolean> {
      try {
        if (!cb || typeof cb.data !== "string" || !cb.data.startsWith(CB_PREFIX)) return false;
        const opts = optsNow();
        if (!opts) return true;
        const answer = async (text: string): Promise<void> => {
          if (o?.late === true) return;
          try {
            await answerCallbackQuery(opts, cb.id, text);
          } catch (e) {
            fail("callback answer", e);
          }
        };
        const m = CB_RE.exec(cb.data);
        if (!m) {
          await answer("That button has expired.");
          return true;
        }
        // THE OWNER, IN THEIR OWN DM. A press from anyone else — or from the
        // owner on a copy forwarded into some other chat — decides nothing.
        const owner = ownerId();
        if (owner === null || cb.fromId !== owner || cb.chatId !== owner) {
          await answer("Only my owner can do that.");
          return true;
        }
        const what = m[1];
        const chatId = Number(m[2]);
        // Forget is recorded before the room is looked up: a store holding no
        // memory (held off, see recordForget) may not know a group the owner
        // pressed Forget for on an older listing.
        if (what === "forget") recordForget(chatId, "*");
        const room = Number.isSafeInteger(chatId) ? store.room(chatId) : undefined;
        if (!room) {
          await answer("I don't know that group any more.");
          if (listings.has(cb.messageId)) {
            const l = listing();
            await editMessageText(opts, cb.chatId, cb.messageId, l.html, l.keyboard);
          }
          return true;
        }
        const title = titleOf(room);
        let outcome = "";
        if (what === "stay") {
          if (room.status === "pending") {
            approve(chatId, undefined, "the owner said stay");
            outcome = `✅ Staying in ${title}.`;
            await answer("Staying");
          } else if (room.status === "approved") {
            outcome = `✅ Already hanging out in ${title}.`;
            await answer("Already there");
          } else {
            outcome = `I'm not in ${title} any more — add me back and I'll be there.`;
            await answer("Not in that group");
          }
        } else if (what === "leave") {
          if (room.status === "approved" || room.status === "pending") {
            await leaveRoom(chatId, "the owner said leave");
            forgetInMemory(chatId);
            outcome = `👋 Left ${title}.`;
          } else {
            // Not in it; blocked all the same, so a stranger's re-add is undone.
            store.setStatus(chatId, "blocked");
            outcome = `👋 I'll stay out of ${title}.`;
          }
          await answer("Done");
        } else {
          markForgotten(chatId);
          store.forgetChat(chatId);
          forgetInMemory(chatId);
          note("ok", "Telegram groups: the owner wiped one group's memory");
          outcome = `🧹 Forgot everything from ${title}.`;
          await answer("Forgotten");
        }
        try {
          if (listings.has(cb.messageId)) {
            const l = listing();
            await editMessageText(opts, cb.chatId, cb.messageId, l.html, l.keyboard);
          } else {
            await editMessageText(opts, cb.chatId, cb.messageId, outcome);
          }
        } catch (e) {
          fail("callback edit", e);
        }
        return true;
      } catch (e) {
        fail("callback", e);
        return true;
      }
    },

    async groupsCommand(chatId: number): Promise<void> {
      try {
        const opts = optsNow();
        if (!opts) return;
        const l = listing();
        const r = await sendMessage(opts, chatId, l.html, l.keyboard.length > 0 ? { keyboard: l.keyboard } : {});
        if (r.ok && isMsgId(r.messageId)) listings.set(r.messageId, true);
      } catch (e) {
        fail("groups", e);
      }
    },

    forgetChat,

    async forgetMe(chatId: number, userId: number, messageId?: number, o?: { late?: boolean }): Promise<void> {
      try {
        if (!Number.isSafeInteger(userId)) return;
        // The "done 🫡" is as old as the request: a backlog of them goes stale
        // like any other line instead of holding the chat's queue.
        const born = clock();
        // Honoured whatever the switches say: a request to be forgotten is not
        // a line. On disk first (recordForget), whether or not this store
        // knows the chat.
        recordForget(chatId, userId);
        const room = store.room(chatId);
        if (!room) return;
        // Marked before the wipe, so their lines still queued or typing are dropped too.
        markForgotten(chatId, userId);
        // Their lines and entry go; their coin posts keep the coin and its
        // verdict (an outcome may still be on its way to that memo) but no
        // longer say who posted it, name or user id, so an outcome for such a
        // memo is said without a tag (coins.ts); a summary that names them is
        // dropped whole (store.ts forgetPerson, the code the forget record
        // is applied with too).
        store.forgetPerson(chatId, userId);
        if (userId === ownerId()) {
          store.update(
            chatId,
            (r) => {
              delete r.ownerName;
            },
            { flush: true },
          );
        }
        // A late request (the service's backlog rule) is wiped all the same,
        // and nothing is said: the room has moved on.
        if (o?.late === true || !canTalk(chatId)) return;
        // The words at most once per person per chat per FORGOT_ME_EVERY_MS;
        // a second /forgetme inside it is wiped all the same, silently.
        const k = `forgetme:${chatId}:${userId}`;
        const last = refusedAt.get(k);
        if (last !== undefined && born - last < FORGOT_ME_EVERY_MS) return;
        refusedAt.set(k, born);
        await enqueue(
          chatId,
          async () => {
            const sent = await speak(chatId, { kind: "forgot-me" }, { ...(isMsgId(messageId) ? { replyTo: messageId } : {}), bornAtMs: born });
            // Not said (stale, shushed, a refused send): the next one may say it.
            if (!sent && refusedAt.get(k) === born) refusedAt.delete(k);
          },
          { force: true },
        );
      } catch (e) {
        fail("forget me", e);
      }
    },

    async commandNotice(chatId: number, messageId: number | undefined, fromId: number, what: TgCommandNotice, threadId?: number): Promise<void> {
      try {
        if (!canTalk(chatId)) return;
        const now = clock();
        // "sent it to your DMs" and "done, couldn't DM you" each answer one
        // command that ran for someone entitled to run it: every one is said.
        // Refusals and "dm me first" at most once per person per hour.
        if (what !== "dm-sent" && what !== "done-no-dm") {
          const k = `${what}:${chatId}:${fromId}`;
          const last = refusedAt.get(k);
          if (last !== undefined && now - last < REFUSE_EVERY_MS) return;
          refusedAt.set(k, now);
        }
        // These answer a command the sender was entitled to run, so they go
        // out in a shushed chat like the owner calling it.
        const entitled = what === "dm-sent" || what === "dm-first" || what === "done-no-dm";
        const reply: SpeakOpts = {
          ...(isMsgId(messageId) ? { replyTo: messageId } : {}),
          ...(isMsgId(threadId) ? { threadId } : {}),
          bornAtMs: now,
          ownerAddressed: entitled,
        };
        const fixedPool: readonly string[] | null =
          what === "owner-only"
            ? OWNER_ONLY_LINES
            : what === "link-here"
              ? LINK_HERE_LINES
              : what === "dm-first"
                ? DM_FIRST_LINES
                : what === "done-no-dm"
                  ? DONE_NO_DM_LINES
                  : null;
        await enqueue(
          chatId,
          async () => {
            if (fixedPool) {
              // Its own small fixed pool, gated like every template.
              const pool = fixedPool;
              const room = store.room(chatId);
              const recentOwn = (room?.lines ?? []).filter((l) => l.own).slice(-8).map((l) => l.text);
              const start = Math.floor(roll() * pool.length);
              let text: string | null = null;
              for (let i = 0; i < pool.length && text === null; i++) {
                const cand = pool[(start + i) % pool.length] ?? "";
                const v = admitTgLine(cand, { agentName: selfNow()?.name ?? "", kind: "fixed", recentOwn, names: [] });
                if (v.ok) text = v.text;
              }
              if (!text) return;
              const sent = await deliver({
                chatId,
                intent: { kind: "private-read-refuse" },
                text,
                ...(reply.replyTo !== undefined ? { replyTo: reply.replyTo } : {}),
                ...(reply.threadId !== undefined ? { threadId: reply.threadId } : {}),
                bornAtMs: now,
                followUp: false,
                ownerAddressed: entitled,
              });
              if (sent) recordOwn(sent.chatId, sent.messageId, text, sent.chatId === chatId ? reply.replyTo : undefined);
              return;
            }
            await speak(chatId, { kind: what === "dm-sent" ? "private-read-dm" : "private-read-refuse" }, reply);
          },
          { force: true },
        );
      } catch (e) {
        fail("notice", e);
      }
    },

    async codeLeaked(chatId: number): Promise<void> {
      try {
        const room = store.room(chatId);
        const settings = `${d.dashboardBase()}/settings#telegram`;
        const button = /^https?:\/\//i.test(settings) ? [[{ text: "⚙️ Open Settings", url: settings }]] : undefined;
        await dmOwner(
          `your link code got posted in ${titleOf(room)}, so i swapped it for a new one. link codes only work here in DMs, and there's no need for one in a group.`,
          button,
        );
      } catch (e) {
        fail("code leaked", e);
      }
    },

    isApproved(chatId: number): boolean {
      try {
        return store.room(chatId)?.status === "approved";
      } catch {
        return false;
      }
    },

    sweep,

    async drain(): Promise<void> {
      // The coin flow's lanes and the outcomes it is saying are its own
      // books; their lines are tracked here once they reach speak.
      for (let i = 0; i < 1_000 && (inflight.size > 0 || !flow.idle()); i++) {
        await Promise.allSettled([...inflight]);
        await flow.drain();
      }
    },

    stop(): void {
      try {
        stopped = true;
        clearInterval(sweepTimer);
        clearInterval(heartbeatTimer);
        flow.stop();
      } catch (e) {
        fail("stop", e);
      }
    },
  };
}

function safeHosted(): boolean {
  try {
    return isHostedMode();
  } catch {
    // Unknown reads as hosted: the side where the house key is never spent.
    return true;
  }
}
