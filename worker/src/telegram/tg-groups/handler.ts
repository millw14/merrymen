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
 * is detached from polling. Chatter uses a per-chat serial queue; public desk
 * research runs beside it. A slow model, coin look or Telegram 429 never
 * delays the owner's DMs, buttons or /kill (rule 7). Only bookkeeping that must be in order with the next update
 * (room status, the line itself) happens before returning.
 *
 * AND NO READ ON THE CHAT'S QUEUE. A coin look reads the chain and
 * GeckoTerminal; the queue runs one line at a time, so a look awaited there
 * held every later line of that chat, and an owner asking "didnt you see?"
 * went unanswered until the answer was stale. The coin flow owns a CA line as
 * soon as it has decided so (coins.ts `begin`) and does the reads on its own
 * research task with the desk configured, or its legacy per-chat coin lane.
 * Addressed follow-up reads are detached too. The queue moves on at once.
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
import { parseTailRequest, tailAsksToTake, type TailRequest } from "../../../../packages/core/src/tail-request";
import type { ResolvedConfig } from "../../settings";
import {
  answerCallbackQuery,
  editMessageText,
  esc,
  leaveChat,
  sendChatAction,
  sendMessage,
  sendPhotoBytes,
  setMessageReaction,
  type InlineKeyboard,
  type TelegramOpts,
  type TgCallback,
  type TgMemberUpdate,
  type TgMessage,
  type TgServiceMessage,
} from "../api";
import type { StateRef } from "../state";
import { CoinFlow, type CoinIntent, type CoinPostEnd, type CoinQuiet, type CoinReadOpts, type CoinSpeakOpts } from "./coins";
import {
  addressedHow,
  addressedSmallTalk,
  asksAboutCoin,
  consents,
  deskAskOf,
  deskNameOk,
  extractCaHits,
  extractCas,
  extractCashtags,
  fomoAskOf,
  fomoFollowUpOf,
  greetingOf,
  hasForeignMint,
  hasOtherChainLink,
  insultLevel,
  isBotQuestion,
  isDistress,
  isInjection,
  isPrivateAsk,
  isReadOnlyTradeQuestion,
  isQuestionToRoom,
  isShush,
  isTradeTalk,
  metaLineOf,
  offerShaped,
  reactionOnly,
  routeWorthy,
  selfNamesOf,
  type BotSelf,
  type DeskIntent,
  type SmallTalk,
} from "./detect";
import { admitThought, deskCaption, deskMissLine, deskQuestionEvidence, deskQuestionIntent, thinkWithModel } from "./desk";
import { admitTgLine } from "./gate";
import { publicCoinReason, publicCoinStatus, publicFactRequest, type PublicFactRequest } from "./facts";
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
import type {
  Chattiness,
  CoinLook,
  TgCoinMemo,
  TgCoinsPort,
  TgDeskAsk,
  TgDeskPort,
  TgDeskThought,
  TgFomoPort,
  TgFomoRequest,
  TgGroupFactsPort,
  TgLine,
  TgOwnerPort,
  TgPerson,
  TgPublicFact,
  TgRoom,
  TgTailAsk,
} from "./types";
import { chainIn, readRoute, RouteBreaker, ROUTE_TIMEOUT_MS, type TgRoute } from "./route";
import { THESES_BOX_MS, ThesesWordings, wordTheses } from "./theses";
import { readSubject, type SubjectReading } from "./understand";
import { mentionFor, say, styleFor, styleWords, type SpeakCtx, type TgIntent } from "./voice";

// ─── The numbers ───────────────────────────────────────────────────────────

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A line that waited longer than this to go out is dropped (coin outcomes excepted). */
const STALE_MS = 90 * SEC;
/** An explicit research answer has one budget from receipt through its send. */
const RESEARCH_REPLY_MS = 30 * SEC;
const RESEARCH_SEND_MS = 5 * SEC;
/** What a routing call must leave the research it picks, of the reply deadline. */
const ROUTE_LEAVES_MS = 8 * SEC;
/** How long a reply to its own Fomo line is read in that line's light. */
const FOMO_THREAD_MS = 2 * 60 * MIN;
/** The persona asking back which Fomo board or coin was meant. */
const FOMO_ASK_BACK = /\b(?:fomo|theses|thesis|trending|top traders?|leaderboard|graduated|most held|robinhood)\b/iu;
/** A routing call with less time than this is not worth making. */
const ROUTE_MIN_BOX_MS = 1_500;
/** How long someone's ask stays open for "i asked a question" to re-run it (decision D12). */
const REASK_OPEN_MS = 10 * MIN;
/** "Typing…" lasts about five seconds in Telegram: while a read runs it is sent again this often. */
const TYPING_EVERY_MS = 4 * SEC;
/** Said to "i asked a question" from someone with no question open (decision D12). Code-written, gated as fixed. */
const WHICH_QUESTION = "which question? i might've missed it, ask me again";
/** The allowance routing never touches: the day's (at least 20, or a tenth) and this chat's hour. */
const ROUTE_RESERVE_DAY = 20;
const ROUTE_RESERVE_HOUR = 4;
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
const CB_RE = /^tgg:(stay|leave|forget|unblock):(-?\d{1,20})$/;

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
  /**
   * The market desk (worker/src/desk/): public evidence, a chart and, when the
   * operator allows it, Brain's read. Absent or null: no desk answers, and a
   * coin question gets the public snapshot as before.
   */
  desk?: () => TgDeskPort | null;
  /**
   * Social-trading research (docs/fomo.md): coin-level public aggregates for
   * an addressed research question, implemented outside this directory
   * (worker/src/tg-fomo-port.ts). Absent or null: no research lane, and the
   * line goes on to the desk and the persona as before.
   */
  fomo?: () => TgFomoPort | null;
  /** The owner's asks that go to her DM (a tail). Absent: no DM to send one to. */
  owner?: () => TgOwnerPort | null;
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
  /**
   * The pause between two "typing…" actions while a read runs
   * (TYPING_EVERY_MS): resolves once `ms` have passed. Real time when absent,
   * never `sleep`. Injectable so a test can count the actions.
   */
  tick?: (ms: number) => Promise<void>;
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
  | "reply-deadline"
  | "send-rate"
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
   * The owner's /groups unblock, in their DM `chatId`: every group they told
   * the bot to leave goes back to undecided, so a Leave pressed by mistake is
   * not forever. Memory is untouched (Forget is for that).
   */
  unblockAll(chatId: number): Promise<void>;
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
  /** Monotonic receipt order; keeps concurrent research subjects in human order. */
  ingressOrder: number;
  threadId?: number;
  /** The question-to-the-room second look (see QUESTION_WAIT_MS). */
  deferred?: boolean;
  /**
   * An addressed social-trading research ask (fomoAskOf, or a follow-up to
   * this chat's last research answer), decided when the line arrived. Such a
   * line runs off the chat queue, so act() may wait on the research inline.
   */
  fomo?: boolean;
  /**
   * A bare "what's trending" (no platform or venue named) where research is
   * wired: Fomo's trending board, asked for as that request, with the desk's
   * market read as the fallback when Fomo cannot answer (act()).
   */
  trending?: boolean;
  /**
   * A line about its own silence (detect.ts metaLineOf): "i asked a
   * question", "?", its name alone. Never what decides the burst.
   */
  meta?: "complaint" | "poke" | "name-only";
  /** A complaint from someone with no question open in the last 10 minutes: they get WHICH_QUESTION. */
  noOpenAsk?: boolean;
  /**
   * A complaint replying to its answer to their open question: the router
   * reads that question again, in the light of the complaint (route.ts reaskOf).
   */
  reaskOf?: string;
  /** Their earlier question that nothing answered: the router may re-run it (route.ts reask). */
  reaskable?: OpenAsk;
  /** A re-run of an earlier ask that nothing answered: never claimed or nominated again (rule 1). */
  reasked?: boolean;
}

/** Someone's last ask in a chat and topic, while it may still be re-asked. */
interface OpenAsk {
  job: LineJob;
  /** It ran off the chat queue (research, a desk ask, a coin), so its re-run does too. */
  research: boolean;
  /** Re-run once already: never twice. */
  reasked: boolean;
  /** A poke on it already got its 👀: later ones while it runs get nothing more. */
  eyed?: boolean;
  /**
   * Never re-run: the coin flow owns the line (it acts on it, or stays quiet
   * by rule, e.g. another chain's coin), and a re-run skips the flow
   * (lineOutcome: reasked), so the persona would answer a coin nobody looked
   * at. Past its 👀 while the look runs, it counts as nothing open.
   */
  noReask?: boolean;
  /**
   * The earlier ask this line had re-run through the router's reask
   * (reaskAgain), when this line stayed their open ask: it is running only
   * while that re-run is, never for its whole deadline with nothing in flight.
   */
  rerun?: OpenAsk;
}

/** An open ask run again: the same line, a fresh deadline, none of its own re-ask marks. */
function againOf(job: LineJob, bornAtMs: number, ingressOrder: number): LineJob {
  const { reaskable: _r, reaskOf: _o, noOpenAsk: _n, meta: _m, ...rest } = job;
  return { ...rest, bornAtMs, ingressOrder, reasked: true };
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
  /** Absolute handler-clock deadline; never refreshed by a retry. */
  replyByMs?: number;
  /** A coin outcome: never dropped as stale. */
  followUp: boolean;
  /** The owner called it: it may answer while the chat is shushed. */
  ownerAddressed: boolean;
  /** Re-checked right before the send: a newer burst line, a chat that moved on. */
  stillWanted?: () => boolean;
  /** Told why, when the line is not sent (see Quiet). */
  miss?: (why: Quiet) => void;
  /** Synchronous person allowance check/count under the send lock, before the first transport attempt. */
  accountAnswer?: (chatId: number) => Quiet | AnswerSlot;
  /**
   * A market desk answer: the chart, when one was drawn, and its caption as
   * HTML already built and escaped by desk.ts. It goes out without a typing
   * pause — the reads and the read already took a person's time.
   */
  desk?: { html: string; photo: Uint8Array | null };
}

interface SpeakOpts {
  replyTo?: number;
  threadId?: number;
  mention?: { id: number; name: string };
  trigger?: TgLine;
  senderName?: string;
  coinName?: string;
  bornAtMs?: number;
  replyByMs?: number;
  ownerAddressed?: boolean;
  stillWanted?: () => boolean;
  /** An ambient line waits like someone who has been reading (pacing.ts typingDelayMs). */
  ambient?: boolean;
  /**
   * The line it answers is in a Fomo research thread (a research ask, or a
   * reply to one of its Fomo lines): the persona's answer joins that thread,
   * so a reply to it is read in its light (repliesToOwnFomo), by message.
   */
  researchThread?: boolean;
  /** Told why, when nothing is sent (see Quiet). */
  miss?: (why: Quiet) => void;
  accountAnswer?: (chatId: number) => Quiet | AnswerSlot;
}

/** One person's provisional answer slot, refundable only on definitive non-delivery. */
interface AnswerSlot {
  rollback: (chatId: number) => void;
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
  /**
   * Addressed lines that ended with nothing said or set on them
   * (`${chatId}:${messageId}`): an open ask among them may be re-asked.
   */
  const lostAsks = new Lru<string, true>(LRU_MAX);
  /** An addressed line ended with nothing said or set on it: the code, never the content (see Quiet). */
  const quietLine = (why: Quiet, j?: LineJob): void => {
    if (j && isMsgId(j.line.messageId)) lostAsks.set(msgKey(j.msg.chatId, j.line.messageId), true);
    log(`[tg-groups] addressed line got nothing (${why})`);
  };
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
  /** Its own Fomo lines (research answers, and the persona asking which one they meant), by message: when said. */
  const fomoLines = new Lru<string, number>(LRU_MAX);
  /** Of those, the persona's own (an ask-back, an offer, a line in a research thread): "ok" and "bet" under one are a yes. */
  const personaFomoLines = new Lru<string, true>(LRU_MAX);
  const markFomoLine = (chatId: number, messageId: number | undefined, persona = false): void => {
    if (!isMsgId(messageId)) return;
    fomoLines.set(msgKey(chatId, messageId), clock());
    if (persona) personaFomoLines.set(msgKey(chatId, messageId), true);
  };
  /** When each recent message reached this process, for the staleness of a coin line about it. */
  const received = new Lru<string, number>(LRU_MAX);
  const messageIngressOrder = new Lru<string, number>(LRU_MAX);
  let ingressOrder = 0;
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
   * NEVER LOSE HER REQUEST. Each person's last substantive line said to it,
   * per chat and topic (`${chatId}:${fromId}:${threadId|0}`), for REASK_OPEN_MS.
   * A poke while it is still being worked on gets a 👀 and leaves it the line
   * to answer; "i asked a question" after nothing answered it runs it again,
   * once (onMessage). Live 2026-10-07: "what's trending", then "shogun" ten
   * seconds in, and the slow market read was dropped as a burst.
   */
  const openAsks = new Lru<string, OpenAsk>(LRU_MAX);
  const askKey = (chatId: number, fromId: number, threadId?: number): string => `${chatId}:${fromId}:${threadId ?? 0}`;
  /** Their open ask in this chat and topic, while it may still be re-asked. */
  const openAskOf = (chatId: number, fromId: number, threadId?: number): OpenAsk | null => {
    const a = openAsks.get(askKey(chatId, fromId, threadId));
    return a && clock() - a.job.seenAtMs <= REASK_OPEN_MS ? a : null;
  };
  /**
   * Where an open ask stands: something landed on it (a reply or a
   * reaction), it ended with nothing (lostAsks, or past its deadline with
   * nothing landed), or it is still being worked on.
   */
  const askStateOf = (a: OpenAsk): "running" | "answered" | "lost" => {
    const k = msgKey(a.job.msg.chatId, a.job.line.messageId);
    if (landedOn.has(k)) return "answered";
    if (lostAsks.has(k)) return "lost";
    // A nudge that had their earlier ask re-run is waiting on nothing of its own.
    if (a.rerun) return askStateOf(a.rerun) === "running" ? "running" : "lost";
    return clock() - a.job.bornAtMs <= (a.research ? RESEARCH_REPLY_MS : STALE_MS) ? "running" : "lost";
  };
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
  const withLock = async <T>(chatId: number, fn: () => Promise<T>, replyByMs?: number): Promise<T> => {
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
    const lockMs = replyByMs === undefined ? stallMs / 2 : Math.max(0, Math.min(stallMs / 2, replyByMs - clock()));
    if ((await Promise.race([prev.then(() => "done" as const), after(lockMs)])) === "late") {
      stats.lockStalled += 1;
      log(`[tg-groups] a group send held the chat's lock past ${Math.round(lockMs / SEC)}s; the next one goes ahead`);
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
  /** The research port, unless the operator switched the lane off (MERRYMEN_TG_GROUPS_FOMO=0). */
  const fomoNow = (): TgFomoPort | null => {
    try {
      if ((env().MERRYMEN_TG_GROUPS_FOMO ?? "").trim() === "0") return null;
      return d.fomo?.() ?? null;
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
  const waitTurn = async (chatId: number, replyByMs?: number): Promise<boolean> => {
    for (let i = 0; i < 8; i++) {
      const w = pacer.waitMs(chatId);
      if (replyByMs !== undefined && (clock() >= replyByMs || w >= replyByMs - clock())) return false;
      if (w <= 0) break;
      await sleep(w);
    }
    if (replyByMs !== undefined && clock() >= replyByMs) return false;
    // THE SLOT IS TAKEN HERE, not after the send lands. Checking the pacer
    // and taking its slot happen with no await between them, so two sends
    // that both wake at a window's edge cannot both pass it — which matters
    // now that the chat's lock can be stepped past (withLock): a successor
    // that goes ahead of a send still waiting out a 429 or a full minute
    // waits for its own slot here, it does not share the other's. A slot
    // taken by a send that then fails or is dropped just spaces the next one
    // out a little more.
    pacer.noteSent(chatId);
    return true;
  };

  /** Still worth sending? Null when it is, else why not. Re-read at every step, because every step can take seconds. */
  const whyNot = (o: Outgoing, chatId: number): Quiet | null => {
    if (stopped) return "off";
    const cannot = talkWhy(chatId);
    if (cannot) return cannot;
    const now = clock();
    if (o.replyByMs !== undefined && now >= o.replyByMs) return "reply-deadline";
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
      let accounted = false;
      let answerSlot: AnswerSlot | null = null;
      let deliveryPossible = false;
      try {
        const baseOpts = optsNow();
        if (!baseOpts) {
          missed(o, "no-token");
          return null;
        }
        const early = whyNot(o, chatId);
        if (early) {
          missed(o, early);
          return null;
        }
        // One transport deadline across safe formatting/topic/migration retries.
        const opts = o.replyByMs === undefined ? baseOpts : {
          ...baseOpts,
          deadlineAtMs: Date.now() + Math.max(0, o.replyByMs - clock()),
        };
        if (o.replyByMs === undefined) {
          try {
            stageOf(o.chatId, "send: typing");
            await sendChatAction(opts, chatId, o.desk?.photo ? "upload_photo" : "typing", threadId);
          } catch (e) {
            fail("typing", e);
          }
        }
        if (!o.desk && o.replyByMs === undefined) {
          stageOf(o.chatId, "send: typing delay");
          await sleep(typingDelayMs(o.text, false, rand));
        }
        for (let attempt = 0; attempt < 4; attempt++) {
          stageOf(o.chatId, "send: flood pacer");
          if (!(await waitTurn(chatId, o.replyByMs))) {
            const why = clock() >= (o.replyByMs ?? Infinity) ? "reply-deadline" : "send-rate";
            log(`[tg-groups] research send blocked (${why})`);
            missed(o, why);
            return null;
          }
          const late = whyNot(o, chatId);
          if (late) {
            missed(o, late);
            return null;
          }
          if (!accounted && o.accountAnswer) {
            const admission = o.accountAnswer(chatId);
            if (typeof admission === "string") { missed(o, admission); return null; }
            answerSlot = admission;
            accounted = true;
          }
          stageOf(o.chatId, "send: message");
          const where = {
            ...(isMsgId(replyTo) ? { replyToMessageId: replyTo } : {}),
            ...(isMsgId(threadId) ? { messageThreadId: threadId } : {}),
            disablePreview: true,
          };
          let r;
          try {
            r = o.desk?.photo
              ? await sendPhotoBytes(opts, chatId, o.desk.photo, o.desk.html, where)
              : await sendMessage(opts, chatId, o.desk ? o.desk.html : htmlOf(o), where);
          } catch (e) {
            deliveryPossible = true;
            throw e;
          }
          if (r.ok || r.noDelivery !== true) deliveryPossible = true;
          if (r.ok) {
            if (isMsgId(o.replyTo)) landedOn.set(msgKey(o.chatId, o.replyTo), true);
            return r.messageId !== undefined ? { chatId, messageId: r.messageId } : { chatId };
          }
          if (r.noDelivery === true && typeof r.retryAfterSec === "number") {
            pauseFor(r.retryAfterSec);
            continue;
          }
          if (r.noDelivery === true && !deliveryPossible && typeof r.migrateToChatId === "number" && !migrated) {
            // This refusal proves the source attempt did not answer anyone.
            // Refund before merging people: a newer destination record may
            // discard the source slot entirely. The destination must pass
            // its own allowance check on the next attempt.
            if (answerSlot) answerSlot.rollback(chatId);
            answerSlot = null;
            accounted = false;
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
          if (r.noDelivery === true && isMsgId(threadId) && typeof r.reason === "string" && /thread not found/i.test(r.reason)) {
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
      } finally {
        // Every known refusal (including a pre-fetch expiry) proves this
        // attempt did not answer the person. Never refund an uncertain send.
        if (answerSlot && !deliveryPossible) answerSlot.rollback(chatId);
      }
    }, o.replyByMs);

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
      // Fomo research is wired here: the persona knows the feature exists, so a question that missed the research lane is pointed at it, never denied.
      ...(fomoNow() !== null ? { fomo: true } : {}),
      nowMs: clock(),
      rand,
    };
  };

  /** Its own line, remembered so the next prompt sees it and the repeat clause can refuse an echo. */
  const recordOwn = (chatId: number, messageId: number | undefined, text: string, replyTo: number | undefined, deskAsk?: TgDeskAsk, threadId?: number): void => {
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
        ...(deskAsk ? { deskAsk } : {}),
        ...(threadId !== undefined ? { threadId } : {}),
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
    const composeMs = o.replyByMs === undefined ? null : Math.max(0, o.replyByMs - RESEARCH_SEND_MS - clock());
    const text = composeMs === null ? await say(intent, ctx, m, m ? gate : null)
      : (composeMs > 0 ? await readDesk(() => say(intent, ctx, m, m ? gate : null), composeMs) : null)
        ?? await say(intent, ctx, null, null);
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
      ...(o.replyByMs !== undefined ? { replyByMs: o.replyByMs } : {}),
      followUp,
      ownerAddressed: o.ownerAddressed === true,
      ...(o.stillWanted ? { stillWanted: o.stillWanted } : {}),
      ...(o.miss ? { miss: o.miss } : {}),
      ...(o.accountAnswer ? { accountAnswer: o.accountAnswer } : {}),
    });
    if (!sent) return null;
    // A migrated chat has no message the old reply id means.
    recordOwn(sent.chatId, sent.messageId, text, sent.chatId === chatId ? o.replyTo : undefined);
    // The persona asking which Fomo board or coin was meant: the answer to it
    // is read in its light (repliesToOwnFomo). So is its offer ("i can pull
    // the fomo board for robinhood chain coins if you want"), and anything it
    // says inside a research thread: a yes under it goes to the router with
    // the line it answers (live 2026-10-07: "do it" under such an offer got
    // "give me a sec", and nothing came).
    if (intent.kind === "answer" && fomoNow() !== null && (o.researchThread === true || (FOMO_ASK_BACK.test(text) && (/[?？]/u.test(text) || offerShaped(text))))) {
      markFomoLine(sent.chatId, sent.messageId, true);
    }
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

  /**
   * Concurrent research rechecks this under deliver's serialized send lock.
   * Count before transport so the next reply sees the slot, and keep the count
   * if Telegram times out: that request may already have reached the room.
   * Known non-delivery refunds only this slot, preserving later counts.
   */
  const accountResearchAnswer = (poster: TgLine, seenAt: number): ((chatId: number) => Quiet | AnswerSlot) => (chatId) => {
    if (forgottenSince(chatId, poster.fromId, seenAt)) return "forgotten";
    if (flooded(chatId, poster.fromId)) return "flood";
    const now = clock();
    const window = bump(store.person(chatId, poster.fromId)?.answers, now, FLOOD_WINDOW_MS);
    store.upsertPerson(chatId, { id: poster.fromId, name: poster.name,
      answers: window });
    return { rollback: (currentChatId) => {
      if (forgottenSince(chatId, poster.fromId, seenAt) || forgottenSince(currentChatId, poster.fromId, seenAt)) return;
      const current = store.person(currentChatId, poster.fromId);
      if (!current?.answers || current.answers.sinceMs !== window.sinceMs || current.answers.count <= 0) return;
      store.upsertPerson(currentChatId, { id: poster.fromId, name: current.name,
        answers: { ...current.answers, count: current.answers.count - 1 }, lastSeenMs: current.lastSeenMs });
    } };
  };

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
    const budgeted = !followUp && (o.replyByMs !== undefined || !!d.desk);
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
      ...(budgeted ? { replyByMs: o.replyByMs ?? born + RESEARCH_REPLY_MS } : {}),
      ...(budgeted && poster ? { accountAnswer: accountResearchAnswer(poster, seenAt) } : {}),
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
    if (sent && !budgeted && poster && !forgottenSince(chatId, poster.fromId, seenAt)) {
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
    ...(d.desk ? { read: (chatId: number, address: string, o: CoinReadOpts) => track(deskReadCoin(chatId, address, o)) } : {}),
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
      // before this feature: approved on first sight — unless the owner has
      // since told it to leave and only unblocked it (unblock).
      if (linked && room.unblockedAtMs === undefined) {
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
    // Open and lost asks too: with landedOn gone an answered ask would read as lost, and a
    // later "shogun" would re-run a forgotten line instead of getting its hail.
    openAsks.deleteWhere((k) => k.startsWith(prefix));
    lostAsks.deleteWhere((k) => k.startsWith(prefix));
    personaFomoLines.deleteWhere((k) => k.startsWith(prefix));
    coinMissed.deleteWhere((k) => k.startsWith(prefix));
    askedIn.deleteWhere((k) => k.startsWith(prefix));
    for (const key of lastDesk.keys()) if (key.startsWith(prefix)) lastDesk.delete(key);
    for (const key of lastFomo.keys()) if (key.startsWith(prefix)) lastFomo.delete(key);
    // The research side's subject memory for this room too ("it" no longer
    // points at the coin the room was discussing). Detached; never throws.
    const fomo = fomoNow();
    if (fomo?.forget) void Promise.resolve().then(() => fomo.forget?.(chatId)).catch((e) => fail("fomo forget", e));
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

  /** How many of the room's latest lines say which coins are being talked about. */
  const KNOWN_COIN_LINES = 30;

  /**
   * THE COINS THIS CHAT KNOWS BY NAME, for reading an opinion ask: the ones
   * it holds, the ones posted here, the $tags said here lately and the coins
   * the desk already read here. "what do you think about pepe" after a room
   * full of $PEPE is about the coin; in a room that never said it, it may be
   * anything (detect.ts deskAskOf, understand.ts).
   */
  const knownCoinNames = (chatId: number): string[] => {
    const names = new Set<string>();
    try {
      for (const n of portNow()?.heldNames() ?? []) if (typeof n === "string") names.add(n);
    } catch {
      /* no held names is no context */
    }
    const stored = store.room(chatId);
    if (!stored) return [...names];
    const room = freshView(stored, clock());
    for (const c of room.coins) if (c.name) names.add(c.name);
    for (const l of room.lines.slice(-KNOWN_COIN_LINES)) {
      for (const tag of extractCashtags(l.text)) names.add(tag);
      if (l.own && l.deskAsk?.kind === "coin" && "query" in l.deskAsk) names.add(l.deskAsk.query);
    }
    return [...names];
  };

  /** A line's desk ask, read with what this chat already knows. */
  const deskIntentOf = (text: string, chatId: number): DeskIntent | null =>
    deskAskOf(text, selfNamesOf(selfNow()), { knownCoins: knownCoinNames(chatId) });

  /** The same, with a loose opinion ask (nothing yet says it is a coin) left out: for decisions that cannot wait for the conversation to settle it. */
  const firmDeskIntentOf = (text: string, chatId: number): DeskIntent | null => {
    const intent = deskIntentOf(text, chatId);
    return intent?.kind === "coin" && intent.loose ? null : intent;
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
      // Who it follows or watches is private only where research is wired.
      privateAsk: isPrivateAsk(text, { research: fomoNow() !== null }),
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
   * The casual group line after a slash command, or after an ask that was
   * answered in the asker's DM (TgCommandNotice). Rate-limited here.
   */
  const commandNotice = async (
    chatId: number,
    messageId: number | undefined,
    fromId: number,
    what: TgCommandNotice,
    threadId?: number,
    // For a routed ask: re-checked inside the queued send, like every lane's.
    extra: { stillWanted?: () => boolean; replyByMs?: number } = {},
  ): Promise<boolean> => {
    let said = false;
    try {
      if (!canTalk(chatId)) return false;
      const now = clock();
      // "sent it to your DMs" and "done, couldn't DM you" each answer one
      // command that ran for someone entitled to run it: every one is said.
      // Refusals and "dm me first" at most once per person per hour.
      // Checked again in queue order, and counted only once one was said: a
      // notice dropped on its way (a deadline, a newer line) leaves the hour.
      const k = what !== "dm-sent" && what !== "done-no-dm" ? `${what}:${chatId}:${fromId}` : null;
      const limited = (): boolean => {
        if (k === null) return false;
        const last = refusedAt.get(k);
        return last !== undefined && clock() - last < REFUSE_EVERY_MS;
      };
      const counted = (): void => {
        if (k !== null) refusedAt.set(k, clock());
      };
      if (limited()) return false;
      // These answer a command the sender was entitled to run, so they go
      // out in a shushed chat like the owner calling it.
      const entitled = what === "dm-sent" || what === "dm-first" || what === "done-no-dm";
      const reply: SpeakOpts = {
        ...(isMsgId(messageId) ? { replyTo: messageId } : {}),
        ...(isMsgId(threadId) ? { threadId } : {}),
        bornAtMs: now,
        ownerAddressed: entitled,
        ...(extra.stillWanted ? { stillWanted: extra.stillWanted } : {}),
        ...(typeof extra.replyByMs === "number" ? { replyByMs: extra.replyByMs } : {}),
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
          if (limited()) return;
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
              ...(reply.replyByMs !== undefined ? { replyByMs: reply.replyByMs } : {}),
              ...(reply.stillWanted ? { stillWanted: reply.stillWanted } : {}),
              followUp: false,
              ownerAddressed: entitled,
            });
            if (sent) recordOwn(sent.chatId, sent.messageId, text, sent.chatId === chatId ? reply.replyTo : undefined);
            said = !!sent;
            if (said) counted();
            return;
          }
          said = !!(await speak(chatId, { kind: what === "dm-sent" ? "private-read-dm" : "private-read-refuse" }, reply));
          if (said) counted();
        },
        { force: true },
      );
    } catch (e) {
      fail("notice", e);
    }
    return said;
  };

  /**
   * Act on pacing's decision. Books are kept only after a line or reaction
   * actually landed. Null when something landed; else why nothing did (Quiet).
   */
  const act = async (dec: PaceDecision, j: LineJob, fallback?: TgIntent): Promise<Quiet | null> => {
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
    // What the persona says when nothing below takes the line (the desk's
    // intent shadows the name in the block): a hail's template when the
    // line was only lifted to an answer for the router (lineOutcome).
    const persona: TgIntent = fallback ?? intent;
    if (dec.act === "answer" && dec.mood !== "injection" && dec.mood !== "bot-question") {
      const request = publicFactRequest(j.line.text, selfNamesOf(selfNow())) ?? repliedTradeRequest(j) ?? repliedDmPolicy(j);
      const context = coinContext(j);
      const coinQuestion = asksAboutCoin(j.line.text, selfNamesOf(selfNow())) || /\b(?:why|how come)\b/iu.test(j.line.text);
      // SOCIAL-TRADING RESEARCH FIRST for an addressed research question
      // (docs/fomo.md): coin-level public aggregates, every line gated. It
      // waits inline because the line's whole job already runs off the chat
      // queue (onMessage: `fomo` lines are research), and a question the
      // research does not take must still reach the desk below.
      //
      // A FOMO TAIL ASKED FOR OUT LOUD ("pine can you tail unipcs for 3
      // hours"), read by code (packages/core tail-request.ts), never by a
      // model, and only where the research lane is wired. It is not research,
      // so the research lane does not take it (it could read "keep tabs on
      // trader X on fomo?" as a profile question); it is handled right after
      // that lane, before the desk and the router: her line goes to her DM as
      // the confirm card, anyone else's gets the owner-only line (tailLine).
      //
      // Where a tail cannot work (TgOwnerPort.tailsState: switched off, or no
      // live feed on this install), a start is no tail and goes on to the
      // research lane as before; with the switch off a stop still is one.
      const tailsHere = tailsStateNow();
      const tailParsed =
        fomoNow() !== null && tailsHere !== "no-live-feed" && dec.mood !== "private-ask" && j.addressed !== null && !isInjection(j.line.text)
          ? parseTailRequest(j.line.text, selfNamesOf(selfNow()))
          : null;
      const tailAsk = tailParsed && (tailsHere === "on" || tailParsed.kind !== "start") ? tailParsed : null;
      // A BARE "WHAT'S TRENDING" (j.trending) is Fomo's trending board, asked
      // as that request; when Fomo cannot answer it (busy, late, a budget
      // refusal, unavailable, failed) it goes on to the desk's market read
      // below, inside the same deadline (decision D1, 2026-10-07).
      let trendingFellBack = false;
      if (j.fomo === true && !tailAsk && !request && dec.mood !== "private-ask" && !isInjection(j.line.text) && j.addressed !== null) {
        // Every chain, unless the line names one ("what's trending on solana"):
        // then that chain's slice of the board (Milla, 2026-10-07).
        const onChain = j.trending === true ? chainIn(j.line.text) : undefined;
        // The desk reads Robinhood Chain only: it stands in for a bare trending ask, or one naming
        // that chain, never for Solana's or Base's board. Those get Fomo's own plain line instead
        // (its refusal with the reset time, FOMO_BUSY, FOMO_LATE, FOMO_UNREACHED): rule 5.
        const deskStandsIn = onChain === undefined || onChain === "robinhood";
        const r = j.trending === true
          ? await fomoAnswer(chatId, j, replyOpts, { kind: "board", board: "trending", ...(onChain ? { chain: onChain } : {}) }, deskStandsIn ? { fallback: true } : { unreached: true })
          : await fomoAnswer(chatId, j, replyOpts);
        if (r === "sent") return null;
        if (r !== "not-research") {
          releaseReply(chatId, messageId);
          return r;
        }
        trendingFellBack = j.trending === true;
      }
      if (tailAsk) {
        // Off the chat queue, like the desk below: the room's line after it
        // (commandNotice) is queued on this chat, and the handoff to her DM
        // must not hold up the room.
        track((async () => {
          const r = await tailLine(chatId, j, replyOpts, tailAsk);
          if (r === null) return;
          releaseReply(chatId, messageId);
          if (j.addressed !== null) quietLine(r, j);
        })());
        return null;
      }
      // AN OPINION ASK THAT NOTHING YET MARKS AS A COIN ("what do you think
      // about sex"): the conversation settles it, once, through the group's
      // model (understand.ts). A topic is the persona's to answer below; a
      // coin, or no answer at all, keeps the desk's read.
      const researchable = !request && dec.mood !== "private-ask" && !isInjection(j.line.text);
      let intent = deskIntentOf(j.line.text, chatId);
      let reading: SubjectReading | null = null;
      if (researchable && intent?.kind === "coin" && intent.loose && d.desk && coinFactsOn()) {
        stageOf(chatId, "read: coin or topic");
        reading = await readSubject({ model: modelNow(), gate, chatId, room: store.room(chatId), trigger: j.line, name: intent.name });
        if (reading === "topic") {
          log("[tg-groups] an opinion ask read as a topic, not a coin");
          intent = null;
        }
      }
      // A REPLY TO ITS OWN FOMO LINE ("which coin?" → "pons", "top traders
      // or trending?" → "trending"): what it means is in the line it answers,
      // so the router reads it before the desk takes "$pons" for a chart or
      // "trending" for the market, however short it is.
      const routable = researchable && dec.mood === "normal" && j.addressed !== null && reading !== "topic";
      // A trending ask Fomo could not answer is the desk's now, never routed back to Fomo.
      const fomoThread = routable && !trendingFellBack && repliesToOwnFomo(j);
      // Whatever the persona says to a line in a research thread stays in it.
      if (j.fomo === true || fomoThread) replyOpts = { ...replyOpts, researchThread: true };
      // "YOU DIDN'T ANSWER" UNDER ITS ANSWER TO THEIR QUESTION: the question
      // is read again, in the light of that complaint, before the desk takes
      // the complaint for a market read (live 22:59: "I said what's trending
      // on fomo"). A chat pick leaves it to the lanes below, as before.
      // One routing call per line at most.
      let routedOnce = false;
      if (routable && typeof j.reaskOf === "string") {
        routedOnce = true;
        if ((await routeLine(chatId, j, replyOpts, persona, { reaskOf: j.reaskOf })) === "taken") return null;
      }
      if (fomoThread && !routedOnce) {
        routedOnce = true;
        if ((await routeLine(chatId, j, replyOpts, persona)) === "taken") return null;
      }
      // THE DESK FIRST for a market or coin read: evidence, a chart and a
      // reasoned answer, off the chat queue like the public facts below.
      const deskAsk = researchable ? deskAskFor(j, context, coinQuestion, intent) : null;
      if (deskAsk) {
        const allowed = deskRoom(chatId);
        const note = deskAsk.kind === "coin" && "address" in deskAsk && context?.address === deskAsk.address ? deskNoteFor(context.memo) : undefined;
        // A coin read is wanted only while the coins switch stays on, like the public-fact lane's.
        const timedOpts = { ...replyOpts, replyByMs: j.bornAtMs + RESEARCH_REPLY_MS,
          accountAnswer: accountResearchAnswer(j.line, j.seenAtMs) };
        const deskOpts = deskAsk.kind !== "market" ? { ...timedOpts, stillWanted: () => wanted() && coinFactsOn() } : timedOpts;
        track((async () => {
          const sent = await deskAnswer(chatId, j, deskAsk, deskOpts, note, allowed);
          if (!sent) { releaseReply(chatId, messageId); if (j.addressed !== null) quietLine(whyLost(), j); }
        })());
        return null;
      }
      if (researchable && (intent?.kind === "discussion" || (intent?.kind === "analysis" && deskQuestionIntent(j.line.text) !== "overview"))) {
        const sent = await deskClarify(chatId, replyOpts, j);
        if (!sent) { releaseReply(chatId, messageId); return whyLost(); }
        return null;
      }
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
          else { releaseReply(chatId, messageId); if (j.addressed !== null) quietLine(whyLost(), j); }
        })());
        return null;
      }
      // "I ASKED A QUESTION" FROM SOMEONE WITH NOTHING OPEN: which one? A
      // fixed line, never a guessed market read (decision D12).
      if (j.meta === "complaint" && j.noOpenAsk === true) {
        const sent = await whichQuestion(chatId, j, replyOpts);
        if (!sent) { releaseReply(chatId, messageId); return whyLost(); }
        noteAnswered(sent.chatId, j, false);
        return null;
      }
      // NO RULE KNEW THIS LINE. Before the persona answers it, the group's
      // model picks once from what it can do (route.ts), and code checks the
      // pick. Not for a line read as an ordinary topic or one with nothing
      // the router serves, and only from the first half of the allowance.
      // A line from someone whose earlier ask went unanswered is always worth
      // it: the router may re-run that ask (reask).
      const unanswered = j.reaskable && askStateOf(j.reaskable) === "lost" && !j.reaskable.reasked ? j.reaskable : null;
      // A Fomo follow-up the planner could not read that names a chain ("shogun on base?"): the router
      // reads it, and grounds the chain from the line itself (route.ts groundedChain).
      const fomoChain = j.fomo === true && chainIn(j.line.text) !== undefined;
      if (routable && !fomoThread && !routedOnce && (unanswered || fomoChain || routeWorthy(j.line.text, selfNamesOf(selfNow()), knownCoinNames(chatId)))) {
        const routed = await routeLine(chatId, j, replyOpts, persona, unanswered ? { reask: true, reaskOf: unanswered.job.line.text } : {});
        if (routed === "taken") return null;
      }
    }
    const sent = await speak(chatId, persona, replyOpts);
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

  /**
   * "WHY?" UNDER ITS OWN "THAT ONE IS FOR A DIRECT MESSAGE": what stays in
   * DMs and what a room may hear (facts.ts dm-policy), never a guessed
   * market read or the persona's guess at its own rules.
   */
  const repliedDmPolicy = (j: LineJob): PublicFactRequest | null => {
    if (j.addressed === null || !/\b(?:why|how come)\b/iu.test(j.line.text) || !isMsgId(j.line.replyTo)) return null;
    const stored = store.room(j.msg.chatId);
    const replied = stored ? freshView(stored, clock()).lines.find((l) => l.messageId === j.line.replyTo) : undefined;
    return replied?.own && /\b(?:for|in) a direct message\b/iu.test(replied.text) ? { kind: "site", topic: "dm-policy" } : null;
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

  // ── the market desk (docs/tg-groups.md "Market analysis") ──────────────

  const deskNow = (): TgDeskPort | null => {
    if ((env().MERRYMEN_TG_GROUPS_DESK ?? "").trim() === "0") return null;
    try {
      return d.desk?.() ?? null;
    } catch {
      return null;
    }
  };
  /**
   * HOW OFTEN THE DESK MAY READ. Each new look costs index requests from the
   * fleet's shared GeckoTerminal budget (the one discovery uses), so a chat gets
   * at most DESK_PER_CHAT looks and the agent DESK_PER_AGENT in any ten
   * minutes; past that an explicit ask receives an allowance status. A repeat of a
   * look still in the desk's one-minute memo costs nothing but is counted the
   * same, which keeps the rule simple and the ceiling honest.
   */
  const DESK_WINDOW_MS = 10 * MIN;
  const DESK_PER_CHAT = 6;
  const DESK_PER_AGENT = 30;
  const deskLooks: Array<{ chatId: number; atMs: number }> = [];
  const deskRoom = (chatId: number): boolean => {
    const now = clock();
    while (deskLooks.length && now - deskLooks[0]!.atMs > DESK_WINDOW_MS) deskLooks.shift();
    if (deskLooks.length >= DESK_PER_AGENT || deskLooks.filter((l) => l.chatId === chatId).length >= DESK_PER_CHAT) return false;
    deskLooks.push({ chatId, atMs: now });
    return true;
  };
  /** What each chat last asked the desk, so "do a quick analysis" right after reads the same thing. */
  const lastDesk = new Map<string, { ask: TgDeskAsk; atMs: number; ingressOrder: number; migrated?: boolean; fromId?: number }>();
  const deskKey = (chatId: number, threadId?: number): string => `${chatId}:${threadId ?? 0}`;
  const DESK_FOLLOW_MS = 15 * MIN;
  /** `fromId`: who asked it, so a subject they asked before their /forgetme is never read again for anyone (deskAskFor). */
  const rememberDesk = (chatId: number, ask: TgDeskAsk, atMs: number, order: number | undefined, threadId?: number, migrated = false, fromId?: number): void => {
    const key = deskKey(chatId, threadId);
    if (order === undefined || (lastDesk.get(key)?.ingressOrder ?? -1) >= order) return;
    if (lastDesk.size > 256 && !lastDesk.has(key)) lastDesk.delete(lastDesk.keys().next().value!);
    lastDesk.set(key, { ask, atMs, ingressOrder: order, ...(migrated ? { migrated: true } : {}), ...(typeof fromId === "number" ? { fromId } : {}) });
  };

  // ── social-trading research (docs/fomo.md "Telegram groups") ──────────────

  /**
   * HOW OFTEN THE RESEARCH MAY BE ASKED, like the desk's looks: each ask can
   * spend the owner's research credits, so a chat gets at most FOMO_PER_CHAT
   * and the agent FOMO_PER_AGENT in any ten minutes. An ask the research does
   * not take (not a research question) gives its slot back, and so does an
   * answer that bought nothing (TgFomoAnswer.free: every read a kept copy, no
   * paraphrase call): only answers that read from the provider count.
   */
  const FOMO_WINDOW_MS = 10 * MIN;
  const FOMO_PER_CHAT = 6;
  const FOMO_PER_AGENT = 30;
  const fomoAsks: Array<{ chatId: number; atMs: number }> = [];
  const fomoRoom = (chatId: number): { atMs: number; chatId: number } | null => {
    const now = clock();
    while (fomoAsks.length && now - fomoAsks[0]!.atMs > FOMO_WINDOW_MS) fomoAsks.shift();
    if (fomoAsks.length >= FOMO_PER_AGENT || fomoAsks.filter((l) => l.chatId === chatId).length >= FOMO_PER_CHAT) return null;
    const slot = { chatId, atMs: now };
    fomoAsks.push(slot);
    return slot;
  };
  const fomoRefund = (slot: { atMs: number; chatId: number }): void => {
    const i = fomoAsks.indexOf(slot);
    if (i >= 0) fomoAsks.splice(i, 1);
  };
  /** When each chat topic last got a research answer: a short follow-up there ("what about the sellers?") goes to the research too. */
  const lastFomo = new Map<string, number>();
  const FOMO_FOLLOW_MS = 15 * MIN;
  const fomoRecent = (chatId: number, threadId?: number): boolean => {
    const at = lastFomo.get(deskKey(chatId, threadId));
    return at !== undefined && clock() - at <= FOMO_FOLLOW_MS;
  };
  const rememberFomo = (chatId: number, threadId?: number): void => {
    const key = deskKey(chatId, threadId);
    if (lastFomo.size > 256 && !lastFomo.has(key)) lastFomo.delete(lastFomo.keys().next().value!);
    lastFomo.set(key, clock());
  };
  /** The most lines and characters one research answer may run to in a room. */
  const FOMO_MAX_LINES = 6;
  const FOMO_MAX_CHARS = 700;
  /** The copy's age (fomo/render.ts freshnessLine), as a room hears it. */
  const FOMO_AGE_LINE = /^(?:From a copy fetched |Data age: |The provider's own copy is from |Fomo's own copy is from )/;
  /** A board's row ("12. PONS on robinhood, market cap $2.1M", "2. kaleo +$151.4k"). */
  const FOMO_BOARD_ROW = /^\d+\. /;
  /** Whom a trader row names, or which coin a coin row names. */
  const FOMO_ROW_SUBJECT = /^\d+\. (.+?) [+-]?\$[\d.,]+[kMBT]?$|^\d+\. (.+?), market cap /;
  const FOMO_LATE = "the research didn't come back in time; ask again in a bit.";
  const FOMO_BUSY = "i've done enough research lookups in here for now; ask again in a few minutes.";
  const FOMO_UNSAYABLE = "i can't put that research into words for a group; ask me in a direct message.";
  /**
   * A read that came back with nothing in it, when none of its lines is
   * sayable: never FOMO_UNSAYABLE, whose "ask me in a direct message" would
   * make an empty answer sound private.
   */
  const FOMO_NOTHING = "nothing on fomo for that one right now.";
  /**
   * A lookup that failed, could not be reached or was refused by a budget,
   * when nothing of its answer is sayable: said plainly, never as
   * FOMO_UNSAYABLE, whose "ask me in a direct message" would make a failure
   * sound private (fomo/render.ts GROUP_FOMO_UNREACHED, the same words).
   */
  const FOMO_UNREACHED = "couldn't reach fomo just now, try again in a bit.";
  /**
   * The longest a research read with a fallback may take: what is left of the
   * reply deadline after it still holds the desk's look and a send.
   */
  const FOMO_FALLBACK_MS = 12 * SEC;

  /**
   * WHAT OF A RESEARCH ANSWER A ROOM MAY HEAR: each line through the group
   * line gate on its own, as a `research` line (no @handles, addresses,
   * links, cashtags, advice, claims, private state or plumbing; the published
   * figures a code-built board carries, a leaderboard's money made or a
   * coin's market cap, may stand), refused lines DROPPED, never repaired, and
   * at most FOMO_MAX_LINES lines and FOMO_MAX_CHARS characters. A group answer
   * carries no source line: the room has had its post about where the data
   * comes from (Milla, 2026-10-07). Null when nothing sayable is left.
   */
  const fomoSayable = (text: string, tail?: string): string | null => {
    const agentName = selfNow()?.name ?? "";
    const lines = text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    const kept: string[] = [];
    let refused = 0;
    for (const l of lines) {
      const v = admitTgLine(l, { agentName, kind: "research", recentOwn: [] });
      if (!v.ok) {
        refused += 1;
        continue;
      }
      kept.push(v.text);
    }
    if (refused) log(`[tg-groups] research lines dropped by the gate (${refused})`);
    // THE COPY'S AGE KEEPS A SLOT OF ITS OWN (docs/fomo.md: a reused copy is
    // always labelled with its age), like the tail below: a 50-minute-old
    // board is never said as current because the line cap cut its last line.
    // Alone it says nothing, so an answer with nothing else sayable is not one.
    const ageAt = kept.findIndex((l) => FOMO_AGE_LINE.test(l));
    const age = ageAt >= 0 ? kept.splice(ageAt, 1)[0]! : null;
    if (!kept.length) return null;
    // A tail line (the owner's "sent the trade moves … to your DM") keeps the
    // last slot; refused by the gate, it is dropped and the answer still goes.
    const last = tail !== undefined ? admitTgLine(tail, { agentName, kind: "research", recentOwn: [] }) : null;
    const end = last?.ok ? last.text : null;
    // What the room hears without the age: lines in order, within the caps.
    const slots = FOMO_MAX_LINES - (end ? 1 : 0);
    const budget = FOMO_MAX_CHARS - (end ? end.length + 1 : 0);
    const out: string[] = [];
    let used = 0;
    for (const l of kept) {
      if (out.length >= slots || used + l.length + 1 > budget) break;
      out.push(l);
      used += l.length + 1;
    }
    if (age) {
      // Room for the age comes out of the board's rows, lowest first: never
      // out of a row's answer or the Robinhood Chain line, which say what was
      // asked, never the row that answer is about (its subject is named
      // below it), never the first row (a board with no row is no board);
      // with no such row, out of whatever comes last.
      const asked = (row: string): boolean => {
        const m = FOMO_ROW_SUBJECT.exec(row);
        const who = m?.[1] ?? m?.[2];
        return !!who && out.some((l) => !FOMO_BOARD_ROW.test(l) && l.includes(who));
      };
      const chars = (): number => out.reduce((n, l) => n + l.length + 1, 0);
      while (out.length > 0 && (out.length > slots - 1 || chars() + age.length + 1 > budget)) {
        const first = out.findIndex((l) => FOMO_BOARD_ROW.test(l));
        let row = -1;
        for (let i = out.length - 1; first >= 0 && i > first; i--) {
          if (FOMO_BOARD_ROW.test(out[i]!) && !asked(out[i]!)) {
            row = i;
            break;
          }
        }
        if (row >= 0) out.splice(row, 1);
        else out.pop();
      }
    }
    if (!out.length) return null;
    return [...out, ...(age ? [age] : []), ...(end ? [end] : [])].join("\n");
  };

  /** A coin's theses as the group model worded them, by coin and copy, for half an hour (theses.ts). */
  const thesesWordings = new ThesesWordings();

  /** How often the owner's moves go out per room and kind of answer. */
  const MOVES_EVERY_MS = 30 * MIN;
  const movesAt = new Map<string, number>();
  const movesDue = (chatId: number, kind: string): boolean => {
    const at = movesAt.get(`${chatId}:${kind}`);
    return at === undefined || clock() - at >= MOVES_EVERY_MS;
  };
  const movesSaid = (chatId: number, kind: string): void => {
    if (movesAt.size > 512) movesAt.delete(movesAt.keys().next().value!);
    movesAt.set(`${chatId}:${kind}`, clock());
  };

  /** A research read, time-boxed. "timeout" and "failed" are told apart from a plain "not research" (null). */
  const readFomo = async (port: TgFomoPort, q: { text: string; request?: TgFomoRequest; owner?: boolean; chatId: number; threadId?: number; selfNames?: readonly string[] }, ms: number): Promise<Awaited<ReturnType<TgFomoPort["ask"]>> | "timeout" | "failed"> => {
    if (ms <= 0) return "timeout";
    const ask = { ...q, timeoutMs: ms };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const expired = d.timer ? d.timer(ms).then(() => "timeout" as const) : new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), ms);
        timer.unref?.();
      });
      return await Promise.race([Promise.resolve().then(() => port.ask(ask)), expired]);
    } catch (e) {
      fail("research", e);
      return "failed";
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  /**
   * ONE ADDRESSED RESEARCH QUESTION, ANSWERED IN THE ROOM: rate-bounded,
   * inside the reply deadline from receipt, delivered through deliver() so
   * the feature switch, the room's approval, the deadline, a shush and
   * whether it is still wanted are all checked again right before the send.
   * "not-research": the research did not take it, and the caller goes on.
   *
   * WITH A FALLBACK (a bare "what's trending", whose fallback is the desk's
   * market read) nothing is said unless the research really answered: the
   * room's research answers spent, a late read, a budget refusal, research
   * unavailable or failed, or nothing sayable are all "not-research", and
   * the read gets at most FOMO_FALLBACK_MS, so the desk still has its time
   * inside the same deadline.
   */
  const fomoAnswer = async (chatId: number, j: LineJob, o: SpeakOpts, request?: TgFomoRequest, how: { fallback?: boolean; unreached?: boolean } = {}): Promise<"sent" | "not-research" | Quiet> => {
    const port = fomoNow();
    if (!port) return "not-research";
    const replyByMs = j.bornAtMs + RESEARCH_REPLY_MS;
    let lost: Quiet = "send-failed";
    const send = async (text: string): Promise<"sent" | Quiet> => {
      const sent = await deliver({
        chatId,
        intent: { kind: "answer", mood: "normal" },
        text,
        ...(o.replyTo !== undefined ? { replyTo: o.replyTo } : {}),
        ...(o.threadId !== undefined ? { threadId: o.threadId } : {}),
        ...(o.mention ? { mention: o.mention } : {}),
        bornAtMs: j.bornAtMs,
        replyByMs,
        followUp: false,
        ownerAddressed: o.ownerAddressed === true,
        // Still wanted only while the research lane stays wired and the asker still wants it.
        stillWanted: () => (!o.stillWanted || o.stillWanted()) && fomoNow() !== null,
        miss: (why) => {
          lost = why;
          o.miss?.(why);
        },
        accountAnswer: accountResearchAnswer(j.line, j.seenAtMs),
      });
      if (!sent) return lost;
      recordOwn(sent.chatId, sent.messageId, text.slice(0, 400), sent.chatId === chatId ? o.replyTo : undefined, undefined, sent.chatId === chatId ? o.threadId : undefined);
      markFomoLine(sent.chatId, sent.messageId);
      log("[tg-groups] said research");
      return "sent";
    };
    const slot = fomoRoom(chatId);
    if (!slot) return how.fallback ? "not-research" : send(FOMO_BUSY);
    const refund = (): void => fomoRefund(slot);
    stageOf(chatId, "research: ask");
    // The bot's own names go with the line: an addressed line almost always
    // carries "@thisbot", which the research must not read as a trader.
    const selfNames = selfNamesOf(selfNow());
    // The owner is the trusted sender id, never a line sent through a chat (j.isOwner excludes `via`).
    const owner = j.isOwner === true;
    const left = replyByMs - RESEARCH_SEND_MS - clock();
    // "typing…" while the research is read: the room sees it is on its way.
    const stopTyping = keepTyping(chatId, replyByMs, o.threadId, "typing", o);
    const r = await readFomo(port, {
      text: j.line.text,
      ...(request ? { request } : {}),
      ...(owner ? { owner } : {}),
      chatId,
      ...(j.threadId !== undefined ? { threadId: j.threadId } : {}),
      ...(selfNames.length ? { selfNames } : {}),
    }, how.fallback ? Math.min(FOMO_FALLBACK_MS, left) : left).finally(stopTyping);
    // `unreached`: a request with no other answer (another chain's trending board) says Fomo could not be reached.
    if (r === null) {
      refund();
      return how.unreached ? send(FOMO_UNREACHED) : "not-research";
    }
    if (r === "failed") {
      refund();
      return how.unreached ? send(FOMO_UNREACHED) : "not-research";
    }
    if (r === "timeout") {
      log(`[tg-groups] research ask timed out${how.fallback ? ", the fallback answers" : ""}`);
      return how.fallback ? "not-research" : send(FOMO_LATE);
    }
    if (typeof r !== "object" || typeof r.text !== "string") {
      refund();
      return "not-research";
    }
    if (how.fallback && !r.deflect && (r.status === "budget-limited" || r.status === "unavailable" || r.status === "failed" || fomoSayable(r.text) === null)) {
      // A refusal costs the provider nothing: the room's ask is given back.
      if (r.status === "budget-limited" || r.status === "unavailable") refund();
      log(`[tg-groups] research ${r.status ?? "unsayable"}, the fallback answers`);
      return "not-research";
    }
    // A deflection is still an answer about research: a follow-up here goes back to it.
    rememberFomo(chatId, j.threadId);
    // Deflected before anything was looked up: it cost nothing, so it takes nothing.
    if (r.deflect && r.free === true) refund();
    // A COIN'S THESES IN THE GROUP MODEL'S OWN WORDS (theses.ts, decision
    // D5): one checked call inside what is left of the deadline, kept for
    // half an hour; anything short of that is the code digest (r.text).
    let body = r.text;
    // Whether the paraphrase made (or may have made) a model call: such an answer keeps its slot.
    let thesesFree = true;
    if (!r.deflect && r.theses) {
      const stopWording = keepTyping(chatId, replyByMs, o.threadId, "typing", o);
      const worded = await wordTheses({
        model: modelNow(),
        gate,
        chatId,
        material: r.theses,
        agentName: selfNow()?.name ?? "",
        env: env(),
        boxMs: Math.min(THESES_BOX_MS, replyByMs - RESEARCH_SEND_MS - clock()),
        // Her moves line, when it goes, takes the last slot.
        maxLines: FOMO_MAX_LINES - (owner && r.moves ? 1 : 0),
        maxChars: FOMO_MAX_CHARS - (owner && r.moves ? r.moves.room.length + 1 : 0),
        now: clock(),
        kept: thesesWordings,
        // Like routing, a paraphrase only spends the half of the allowance kept for what is nice to have.
        reserve: { day: Math.max(ROUTE_RESERVE_DAY, Math.ceil(gate.dailyAllowance / 2)), hour: Math.max(ROUTE_RESERVE_HOUR, Math.ceil(gate.hourAllowance / 2)) },
      }).finally(stopWording);
      // Counts and kinds only: never a phrase, a coin or a sample.
      log(`[tg-groups] theses ${worded.why}${worded.dropped ? ` (${worded.dropped} phrase(s) dropped)` : ""}`);
      if (worded.lines) body = worded.lines.join("\n");
      if (worded.why === "worded" || worded.why === "dropped" || worded.why === "no-answer") thesesFree = false;
    }
    // AN ANSWER THAT BOUGHT NOTHING (every read a kept copy, no paraphrase
    // call) gives its slot back: the room's six per ten minutes bound what is
    // spent, and a re-ask or a board cut from the same read spends nothing.
    if (!r.deflect && r.free === true && thesesFree) refund();
    // HER MOVES: the commands go to her DM first, and the room hears that they
    // went only when the DM landed (never a claim that is not true), at most
    // once per room and kind in MOVES_EVERY_MS.
    let movesLine: string | undefined;
    if (owner && !r.deflect && r.moves && movesDue(chatId, r.moves.kind) && fomoSayable(body) !== null) {
      stageOf(chatId, "research: owner moves");
      if (await dmOwner(r.moves.dm)) {
        movesSaid(chatId, r.moves.kind);
        movesLine = r.moves.room;
        log("[tg-groups] owner moves sent to the DM");
      }
    }
    const failedRead = r.status === "failed" || r.status === "unavailable" || r.status === "budget-limited";
    const text = fomoSayable(body, movesLine) ?? (body !== r.text ? fomoSayable(r.text, movesLine) : null) ?? (failedRead ? FOMO_UNREACHED : r.status === "empty" ? FOMO_NOTHING : FOMO_UNSAYABLE);
    // A REMEMBERED BOARD IS THE ROWS THE ROOM HEARD: rows the six lines cut
    // (an age line, her moves line, a row's answer) are never "the last one".
    if (r.board && typeof port.heard === "function") {
      try {
        await port.heard(chatId, j.threadId, r.board, text);
      } catch (e) {
        fail("research", e);
      }
    }
    return send(text);
  };

  // ── what a line wants, when no rule knew (route.ts) ──

  const routeBreaker = new RouteBreaker(clock);
  /** MERRYMEN_TG_GROUPS_ROUTER=0 turns it off; it needs a model and something to route to. */
  const routerOn = (): boolean =>
    (env().MERRYMEN_TG_GROUPS_ROUTER ?? "").trim() !== "0" && modelNow() !== null && (fomoNow() !== null || deskNow() !== null);
  const ownerNow = (): TgOwnerPort | null => {
    try {
      return d.owner?.() ?? null;
    } catch {
      return null;
    }
  };
  /** Whether a tail can work here (TgOwnerPort.tailsState); absent or throwing: "on". */
  const tailsStateNow = (): "on" | "switched-off" | "no-live-feed" => {
    try {
      const st = ownerNow()?.tailsState?.();
      return st === "switched-off" || st === "no-live-feed" ? st : "on";
    } catch {
      return "on";
    }
  };
  /** The text of the line this one replies to, when Telegram quoted it. */
  const repliedText = (j: LineJob): string | null => {
    const t = j.msg.replyTo?.text;
    return typeof t === "string" && t.trim() ? t.slice(0, 400) : null;
  };
  /**
   * A reply to one of its own lines about Fomo: a research answer, or the
   * persona asking which board or coin they meant. What "pons" or
   * "trending" means there is in the line it answers.
   */
  const repliesToOwnFomo = (j: LineJob): boolean => {
    const me = selfNow();
    const q = j.msg.replyTo;
    if (!me || !q || q.fromId !== me.id || !isMsgId(q.messageId)) return false;
    // By message, never by its words: a desk read that says "trending up"
    // keeps its own follow-ups, bound to the coin it read.
    const at = fomoLines.get(msgKey(j.msg.chatId, q.messageId));
    if (at === undefined || clock() - at > FOMO_THREAD_MS) return false;
    if (!reactionOnly(j.line.text, selfNamesOf(me))) return true;
    // "ok" and "bet" under its own ask or offer are a yes, not a reaction;
    // under a research answer they stay a reaction.
    return personaFomoLines.get(msgKey(j.msg.chatId, q.messageId)) === true && consents(j.line.text, selfNamesOf(me));
  };
  /**
   * When this line replies to one of its own lines: the person's line that
   * one answered (this chat's lines only), so route.ts can tell a name its
   * own offer invented from one a person wrote first.
   */
  const askedBefore = (j: LineJob): string | null => {
    const me = selfNow();
    const q = j.msg.replyTo;
    if (!me || !q || q.fromId !== me.id || !isMsgId(q.messageId)) return null;
    const room = store.room(j.msg.chatId);
    const own = room?.lines.find((l) => l.own && l.messageId === q.messageId);
    const asked = own && isMsgId(own.replyTo) ? room!.lines.find((l) => !l.own && l.messageId === own.replyTo) : undefined;
    return asked && typeof asked.text === "string" && asked.text.trim() ? asked.text.slice(0, 400) : null;
  };
  const routeLabel = (r: TgRoute): string => (r.action === "fomo" ? `fomo:${r.request.kind}` : r.action);
  /** "not-wanted", told apart as act's whyLost does. */
  const whyGone = (j: LineJob, why: Quiet): Quiet =>
    why !== "not-wanted" ? why : forgotten(j) ? "forgotten" : j.addressed !== null && burstPassed(j.msg.chatId, j) ? "burst" : "not-wanted";

  /**
   * Ask what the line wants and run it. "taken": a lane has it (detached, and
   * it answers or says why not); "persona": the persona answers it, as before.
   */
  const routeLine = async (chatId: number, j: LineJob, o: SpeakOpts, persona: TgIntent, earlier: { reask?: boolean; reaskOf?: string } = {}): Promise<"taken" | "persona"> => {
    try {
      if (!routerOn() || routeBreaker.open()) return "persona";
      // Routing only ever spends the first half of the day and of this
      // chat's hour: the rest is kept for the lines that must be written.
      const reserve = {
        day: Math.max(ROUTE_RESERVE_DAY, Math.ceil(gate.dailyAllowance / 2)),
        hour: Math.max(ROUTE_RESERVE_HOUR, Math.ceil(gate.hourAllowance / 2)),
      };
      const box = Math.min(ROUTE_TIMEOUT_MS, j.bornAtMs + RESEARCH_REPLY_MS - RESEARCH_SEND_MS - ROUTE_LEAVES_MS - clock());
      if (box < ROUTE_MIN_BOX_MS) return "persona";
      const selfNames = selfNamesOf(selfNow());
      stageOf(chatId, "route");
      const { route, why } = await readRoute({
        model: modelNow(),
        gate,
        chatId,
        room: store.room(chatId),
        trigger: j.line,
        timeoutMs: box,
        reserve,
        ctx: {
          line: j.line.text,
          replied: repliedText(j),
          asked: askedBefore(j),
          ...(typeof earlier.reaskOf === "string" ? { reaskOf: earlier.reaskOf } : {}),
          selfNames,
          fomo: fomoNow() !== null,
          desk: deskNow() !== null,
          coins: coinFactsOn(),
          ...(earlier.reask === true ? { reask: true } : {}),
        },
      });
      routeBreaker.note(why);
      // Counts and kinds only: never the line, a name or a coin.
      log(`[tg-groups] route ${route ? routeLabel(route) : why}`);
      if (!route || route.action === "chat") return "persona";
      track(runRoute(chatId, j, o, persona, route));
      return "taken";
    } catch (e) {
      fail("route", e);
      return "persona";
    }
  };

  /**
   * A FOMO TAIL ASKED FOR IN THE ROOM (docs/fomo.md "Tailing a trader";
   * docs/tg-groups.md rules 1 and 3). Groups never order trades, and who
   * Merrymen tails is never a room's (a trader's public data is, Milla
   * 2026-10-07; what Merrymen watches is not), so:
   *
   * - the owner's line (j.isOwner: the trusted sender id, never a line sent
   *   through a chat) goes to her DM as the confirm card, through
   *   TgOwnerPort.proposeTail with only what code read from it (`ask`; null
   *   when it named no trader code could read: her DM gets the /tail usage).
   *   Nothing is created until she presses a button there. The room hears
   *   only where it went ("sent it to your DMs 🤫", or the dm-first line).
   * - anyone else's gets the owner-only line, at most once an hour per
   *   person (commandNotice), and nothing else: no research, no persona.
   *
   * Null: handled. A Quiet: nothing was said, and why.
   */
  const tailLine = async (chatId: number, j: LineJob, o: SpeakOpts, ask: TailRequest | null): Promise<Quiet | null> => {
    const extra = { ...(o.stillWanted ? { stillWanted: o.stillWanted } : {}), replyByMs: j.bornAtMs + RESEARCH_REPLY_MS };
    if (!j.isOwner) {
      const said = await commandNotice(chatId, j.line.messageId, j.line.fromId, "owner-only", j.threadId, extra);
      log(`[tg-groups] tail ask from someone else${said ? "" : ", owner-only already said this hour"}`);
      // Silent by rule (said this hour already): nothing is open, and a re-run could only be silent again.
      const k = askKey(chatId, j.line.fromId, j.threadId);
      if (!said && openAsks.get(k)?.job.line.messageId === j.line.messageId) openAsks.delete(k);
      return null;
    }
    const port = ownerNow();
    if (!port?.proposeTail) {
      log("[tg-groups] owner tail ask, no DM to send it to");
      return "skipped";
    }
    if (o.stillWanted && !o.stillWanted()) return "not-wanted";
    stageOf(chatId, "owner tail");
    const tail: TgTailAsk | null =
      ask === null
        ? null
        : ask.kind === "start"
          ? { kind: "start", handle: ask.handle, hours: ask.hours, clamped: ask.clamped, take: tailAsksToTake(j.line.text) }
          : ask.kind === "stop"
            ? { kind: "stop", handle: ask.handle }
            : { kind: "stop-which" };
    const outcome = await port.proposeTail({ tail, fromId: j.line.fromId });
    // Counts and kinds only: never the trader, the hours or the line.
    log(`[tg-groups] owner tail ${tail ? tail.kind : "usage"}: ${outcome}`);
    if (outcome !== "sent" && outcome !== "dm-first") return "skipped";
    await commandNotice(chatId, j.line.messageId, j.line.fromId, outcome === "sent" ? "dm-sent" : "dm-first", j.threadId, extra);
    return null;
  };

  /** One routed line, off the chat queue. Whatever happens, the line is answered or its slot released. */
  const runRoute = async (chatId: number, j: LineJob, o: SpeakOpts, persona: TgIntent, route: TgRoute): Promise<void> => {
    const messageId = j.line.messageId;
    let lost: Quiet = "send-failed";
    const opts: SpeakOpts = { ...o, miss: (why) => { lost = why; o.miss?.(why); } };
    const done = (ok: boolean, why?: Quiet): void => {
      if (ok) return;
      releaseReply(chatId, messageId);
      if (j.addressed !== null) quietLine(whyGone(j, why ?? lost), j);
    };
    /** The persona's answer, exactly as without the router. */
    const asBefore = async (): Promise<void> => {
      const sent = await speak(chatId, persona, opts);
      if (sent) noteAnswered(sent.chatId, j, false);
      done(!!sent);
    };
    try {
      switch (route.action) {
        case "fomo": {
          const r = await fomoAnswer(chatId, j, opts, route.request);
          if (r === "not-research") return await asBefore();
          return done(r === "sent", r === "sent" ? undefined : r);
        }
        case "fomo-tail": {
          // The pick names nobody: code reads the trader and the hours from
          // the line itself, and her line that named no one gets the usage.
          const r = await tailLine(chatId, j, opts, parseTailRequest(j.line.text, selfNamesOf(selfNow())));
          return done(r === null, r ?? undefined);
        }
        case "reask": {
          // A newer line of theirs arrived while this was routed (burst), or
          // they were forgotten: that line wins, and the old ask stays lost.
          // Re-running it now would make it their last addressed line again
          // and drop the newer question as a burst.
          if (o.stillWanted && !o.stillWanted()) return done(false, "not-wanted");
          // Their earlier ask, run again as the reply to it (reaskAgain); this
          // line itself needs no answer of its own.
          if (!reaskAgain(j)) return await asBefore();
          releaseReply(chatId, messageId);
          return;
        }
        case "market":
        case "coin": {
          if (!deskNow() || (route.action === "coin" && !coinFactsOn())) return await asBefore();
          const context = route.action === "coin" ? coinContext(j) : null;
          const ask: TgDeskAsk =
            route.action === "market"
              ? { kind: "market" }
              : context && context.memo?.name && context.memo.name.toLowerCase() === route.name.toLowerCase()
                ? { kind: "coin", address: context.address }
                : { kind: "coin", query: route.name };
          const timed: SpeakOpts = { ...opts, replyByMs: j.bornAtMs + RESEARCH_REPLY_MS, accountAnswer: accountResearchAnswer(j.line, j.seenAtMs) };
          const deskOpts = ask.kind === "coin" ? { ...timed, stillWanted: () => (!o.stillWanted || o.stillWanted()) && coinFactsOn() } : timed;
          const note = context && "address" in ask && ask.address === context.address ? deskNoteFor(context.memo) : undefined;
          const sent = await deskAnswer(chatId, j, ask, deskOpts, note, deskRoom(chatId));
          return done(!!sent);
        }
        default:
          return await asBefore();
      }
    } catch (e) {
      fail("routed answer", e);
      done(false);
    }
  };

  /** A desk ask earlier in the reply chain: "do a quick analysis" under "how's the market?". This chat's lines only. */
  const repliedDesk = (j: LineJob): TgDeskAsk | null => {
    const stored = store.room(j.msg.chatId);
    if (!stored) return null;
    const room = freshView(stored, clock());
    let id = j.line.replyTo;
    const seen = new Set<number>();
    for (let depth = 0; isMsgId(id) && depth < 8; depth++) {
      if (seen.has(id)) break;
      seen.add(id);
      const line = room.lines.find((l) => l.messageId === id);
      // A recorded answer keeps its public subject across pruning/restarts.
      // Quotes and persisted references select research only, never a trade.
      if (line?.own && line.deskAsk) return line.deskAsk;
      const text = line?.text ?? (depth === 0 && j.msg.replyTo?.messageId === id ? j.msg.replyTo.text ?? "" : "");
      const quote = j.msg.replyTo;
      if (depth === 0 && quote && typeof quote.fromId === "number" && quote.fromId === selfNow()?.id && (!line || line.own)) {
        // Older stored answers contain prose but no subject metadata; the
        // authenticated Telegram photo caption still carries its safe header.
        const parts = (quote.text ?? text).split(/\r?\n/u).map((p) => p.trim()).filter((p) => p !== "");
        const head = parts[0] ?? "";
        if (head === "Robinhood Chain market") return { kind: "market" };
        // Own photo captions start with a code-owned safe subject, unlike
        // project claims further down the caption. Ambiguous ticker lookup
        // remains an honest miss in the desk. Only a caption, though: a
        // title above a read. An older stored answer kept only the read, so
        // the caption is what Telegram quotes beyond it; a line it remembers
        // word for word, and a one-line "yo", are never a read (live
        // 2026-10-07: "i asked a question" under "yo" was searched as the
        // coin "yo").
        const names = selfNamesOf(selfNow());
        const caption = parts.length >= 2 && (!line || parts.join("\n") !== line.text.split(/\r?\n/u).map((p) => p.trim()).filter((p) => p !== "").join("\n"));
        if (caption && /^[\p{L}][\p{L}\p{N}._-]{1,23}$/u.test(head) && deskNameOk(head, names) && addressedSmallTalk(head, names) === null
          && greetingOf(head) === null && !reactionOnly(head, names) && coinFactsOn()) {
          return { kind: "coin", query: head };
        }
      }
      if (!line?.own) {
        // A loose opinion ask up the chain was never settled as a coin: it lends no subject.
        const intent = firmDeskIntentOf(text, j.msg.chatId);
        if (intent?.kind === "market") return { kind: "market" };
        if (intent?.kind === "comparison" && coinFactsOn()) return { kind: "comparison", queries: intent.names };
        if (intent?.kind === "coin" && coinFactsOn()) return { kind: "coin", query: intent.name };
      }
      if (!line) break;
      id = line.replyTo;
    }
    return null;
  };

  /**
   * WHAT, IF ANYTHING, THE DESK IS ASKED. A named coin is searched (or, when
   * the reply chain's coin carries that name, looked up by its address); the
   * market is the market; a bare "do a quick analysis" or "wdyt" binds to the
   * coin it replies under, then to a desk ask up the reply chain, then to what
   * this chat last asked within the quarter hour, else the market. A "why"
   * under a coin carries its recorded public outcome beneath the current read.
   * Story questions bind only to coins; rewrites can bind to either kind of
   * read. With no subject, discussion requests ask for one. Coin asks honour
   * the coins switch.
   */
  /**
   * The code-written line under a read about a coin this chat remembers: the
   * Brain's public reason when it reviewed it, else the quick screen's verdict.
   * Never a private reason or a figure (publicCoinReason, quickTake).
   */
  const deskNoteFor = (memo: TgCoinMemo | undefined): string | undefined => publicCoinStatus(memo, clock());

  const deskAskFor = (
    j: LineJob,
    context: { address: string; memo?: TgCoinMemo } | null,
    coinQuestion: boolean,
    intent: DeskIntent | null = deskIntentOf(j.line.text, j.msg.chatId),
  ): TgDeskAsk | null => {
    if (!d.desk) return null;
    if (deskQuestionIntent(j.line.text) === "comparison" && (extractCaHits(j.line.text).length > 2 || extractCashtags(j.line.text).length > 2)) return null;
    if (intent?.kind === "comparison") return coinFactsOn() ? { kind: "comparison", queries: intent.names } : null;
    if (intent?.kind === "coin") {
      if (!coinFactsOn()) return null;
      if (/^0x[0-9a-f]{40}$/iu.test(intent.name)) return { kind: "coin", address: intent.name.toLowerCase() };
      if (context?.memo?.name && context.memo.name.toLowerCase() === intent.name.toLowerCase()) return { kind: "coin", address: context.address };
      return { kind: "coin", query: intent.name };
    }
    if (intent?.kind === "market") return { kind: "market" };
    // "why" under a coin is a desk ask too: the chart and the read, with the
    // recorded reason under it (deskNoteFor) — not a one-line snapshot.
    const complaint = j.addressed !== null && /\b(?:vibes|asked you|asked a question|answer|chart|analysis)\b/iu.test(j.line.text) && /\b(?:just|nothing|not|deal|why|how|asked|single|entire)\b|[?？]/iu.test(j.line.text);
    const discussion = intent?.kind === "discussion" || (intent?.kind === "analysis" && deskQuestionIntent(j.line.text) !== "overview");
    const lore = intent?.kind === "discussion" && intent.topic === "lore";
    const bare = intent?.kind === "analysis" || discussion || (!intent && context !== null && coinQuestion) || complaint;
    if (!bare) return null;
    if (context) return coinFactsOn() ? { kind: "coin", address: context.address } : null;
    const chained = repliedDesk(j);
    if (chained) {
      if (chained.kind !== "market" && !coinFactsOn()) return null;
      if (chained.kind === "comparison" && intent?.kind === "discussion" && intent.topic === "setup" && deskQuestionIntent(j.line.text) !== "comparison") return null;
      return !lore || chained.kind === "coin" ? chained : null;
    }
    // An unresolved explicit reply must not silently borrow a newer coin.
    if (j.line.replyTo !== undefined && discussion) return null;
    // A complaint from someone with nothing open never borrows the topic's
    // last read, someone else's (D12): "which question?" (act()).
    if (j.meta === "complaint" && j.noOpenAsk === true) return null;
    const general = lastDesk.get(deskKey(j.msg.chatId));
    const remembered = lastDesk.get(deskKey(j.msg.chatId, j.threadId)) ?? (general?.migrated ? general : undefined);
    // A subject asked by someone forgotten since is not this topic's any more.
    const prev = remembered && !(remembered.fromId !== undefined && forgottenSince(j.msg.chatId, remembered.fromId, remembered.atMs)) ? remembered : undefined;
    if (prev?.ask.kind === "comparison" && intent?.kind === "discussion" && intent.topic === "setup" && deskQuestionIntent(j.line.text) !== "comparison") return null;
    if (prev && clock() - prev.atMs <= DESK_FOLLOW_MS && (prev.ask.kind === "market" || coinFactsOn())) return !lore || prev.ask.kind === "coin" ? prev.ask : null;
    // A complaint with no subject anywhere ("i asked a question", "why can't
    // you answer in the group?") is never a guessed market read: the re-ask,
    // "which question?" or the persona answers it (onMessage, act()).
    // Only real complaint wording blocks it: a bare "vibes?" or "how are the vibes" is still the market read.
    // Never the ordinary words alone ("vibes not great huh?", "vibes just feel off today?" are vibes questions); "just vibes?" is its own phrase.
    const grievance = complaint && /\b(?:asked you|asked a question|answer|single|entire|just vibes)\b/iu.test(j.line.text);
    if (discussion || (grievance && intent?.kind !== "analysis")) return null;
    return { kind: "market" };
  };

  /** The desk's reads, time-boxed off the chat queue like every public fact. */
  const readDesk = async <T>(read: () => Promise<T>, ms: number): Promise<T | null> => {
    if (ms <= 0) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const expired = d.timer ? d.timer(ms).then(() => null) : new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
        timer.unref?.();
      });
      return await Promise.race([Promise.resolve().then(read), expired]);
    } catch (e) {
      fail("desk", e);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  /** The persona line the read is written in: its name and its typing style, nothing else. */
  const deskVoice = (): string => {
    let key = "";
    try {
      key = String(d.agentKey() ?? "");
    } catch {
      key = "";
    }
    const name = selfNow()?.name ?? "";
    return `${name ? `You are ${name}. ` : ""}${styleWords(styleFor(key))}`.slice(0, 500);
  };

  /**
   * ONE DEADLINE FROM RECEIPT, including any initial coin screen. The lookup
   * gets at most DESK_LOOK_MS; optional model work uses what remains before
   * the five-second send reserve. Past it the measured floor is delivered,
   * with no refreshed budget or hidden late reply.
   */
  const DESK_LOOK_MS = 10 * SEC;
  const DESK_BRAIN_MS = 18 * SEC;
  const DESK_MODEL_MIN_MS = 6 * SEC;

  /**
   * EVIDENCE AND A READ FOR ONE ASK: the desk's look, then Brain's read when
   * the operator allows it, else the group's model, else the code's floor —
   * each model-written piece admitted against the brief — as a caption ready
   * to send. Every model call is counted against the group allowance (rule
   * 7). A miss is the desk's reason, for the caller to word.
   */
  const deskCompose = async (
    chatId: number,
    ask: TgDeskAsk,
    question: string,
    note: string | undefined,
    replyByMs: number,
  ): Promise<{ ok: true; html: string; read: string; chart: Uint8Array | null; kind: "market" | "coin"; reference: TgDeskAsk } | { ok: false; why: "not-found" | "ambiguous" | "unavailable" }> => {
    const desk = deskNow();
    if (!desk) return { ok: false, why: "unavailable" };
    const started = clock();
    const left = (): number => Math.max(0, replyByMs - RESEARCH_SEND_MS - clock());
    if (left() <= 0) return { ok: false, why: "unavailable" };
    stageOf(chatId, "desk: look");
    const lookMs = Math.min(DESK_LOOK_MS, left());
    const looked = await readDesk(() => desk.look(ask, { timeoutMs: lookMs }), lookMs);
    if (!looked || !looked.ok) return { ok: false, why: looked && !looked.ok ? looked.why : "unavailable" };
    const e = deskQuestionEvidence(looked.evidence, question);
    const req = { kind: e.kind, subject: e.subject, question: question.slice(0, 400), brief: e.brief, voice: deskVoice(),
      ...(e.lore ? { lore: { description: e.lore.description, source: e.lore.source, ...(e.lore.name ? { name: e.lore.name } : {}) } } : {}) };
    let thought: TgDeskThought | null = null;
    let by = "floor";
    if (desk.think && left() > DESK_MODEL_MIN_MS) {
      stageOf(chatId, "desk: brain");
      const think = desk.think;
      const thinkMs = Math.min(DESK_BRAIN_MS, left());
      thought = await gate.run(chatId, () => think(req, { timeoutMs: thinkMs }), thinkMs);
      if (thought) by = "brain";
    }
    const m = modelNow();
    if (!thought && m && left() >= DESK_MODEL_MIN_MS) {
      stageOf(chatId, "desk: model");
      thought = await thinkWithModel(m, gate, chatId, req, left());
      if (thought) by = "model";
    }
    if (left() <= 0) thought = null;
    const admitted = admitThought(thought, e, selfNow()?.name ?? "", question);
    // Which kind of read went out, how long it took and, when a model's was
    // refused, the gate's reason code — never the text, the question or the coin.
    log(`[tg-groups] desk ${e.kind} read: ${admitted.from === "model" ? by : "floor"}${admitted.refused ? ` (${by} read refused: ${admitted.refused})` : ""} in ${Math.round((clock() - started) / 100) / 10}s`);
    return { ok: true, html: deskCaption(e, admitted.thought, note, question), read: admitted.thought.read, chart: e.chart, kind: e.kind, reference: e.reference ?? ask };
  };

  /** One desk answer out: a photo, or the caption as a message with no chart. Recorded as its own line. */
  const deskDeliver = async (
    chatId: number,
    composed: { html: string; read: string; chart: Uint8Array | null; reference: TgDeskAsk },
    o: SpeakOpts,
  ): Promise<{ chatId: number; messageId?: number } | null> => {
    stageOf(chatId, "desk: send");
    const sent = await deliver({
      chatId,
      intent: { kind: "answer", mood: "normal" } as TgIntent,
      text: composed.read,
      ...(o.replyTo !== undefined ? { replyTo: o.replyTo } : {}),
      ...(o.threadId !== undefined ? { threadId: o.threadId } : {}),
      ...(o.mention ? { mention: o.mention } : {}),
      bornAtMs: typeof o.bornAtMs === "number" ? o.bornAtMs : clock(),
      ...(o.replyByMs !== undefined ? { replyByMs: o.replyByMs } : {}),
      followUp: false,
      ownerAddressed: o.ownerAddressed === true,
      ...(o.stillWanted ? { stillWanted: o.stillWanted } : {}),
      ...(o.miss ? { miss: o.miss } : {}),
      ...(o.accountAnswer ? { accountAnswer: o.accountAnswer } : {}),
      desk: { html: composed.html, photo: composed.chart },
    });
    if (sent) recordOwn(sent.chatId, sent.messageId, composed.read.slice(0, 400), sent.chatId === chatId ? o.replyTo : undefined, composed.reference, sent.chatId === chatId ? o.threadId : undefined);
    return sent;
  };

  /** The pause between two chat actions (TgGroupsDeps.tick): real time when absent, never `sleep`. */
  const tick = (ms: number): Promise<void> =>
    d.tick
      ? d.tick(ms)
      : new Promise((resolve) => {
          const t = setTimeout(resolve, ms);
          t.unref?.();
        });
  /**
   * PROGRESS YOU CAN SEE while a read runs: "typing…" (or "sending a
   * photo…" for a chart) again every TYPING_EVERY_MS until the returned stop
   * is called, the deadline passes, the line stops being wanted (a newer
   * line, a /forgetme), the chat is shushed (unless the owner called it) or
   * the handler stops. Detached and outside the chat lock: each action is
   * capped at one second and never gates useful work. Bot API calls, never
   * a model call.
   */
  const keepTyping = (
    chatId: number,
    replyByMs: number,
    threadId: number | undefined,
    action: "typing" | "upload_photo",
    o: { stillWanted?: () => boolean; ownerAddressed?: boolean } = {},
  ): (() => void) => {
    let done = false;
    const wanted = (): boolean => {
      try {
        return !o.stillWanted || o.stillWanted();
      } catch {
        return false;
      }
    };
    void (async () => {
      while (!done && !stopped) {
        const left = replyByMs - clock();
        const opts = optsNow();
        if (!opts || left <= 0 || !wanted() || !canTalk(chatId) || (!o.ownerAddressed && shushedNow(store.room(chatId), clock()))) return;
        await sendChatAction({ ...opts, deadlineAtMs: Date.now() + Math.min(SEC, left) }, chatId, action, threadId).catch((e) => fail("typing", e));
        if (done || stopped) return;
        await tick(TYPING_EVERY_MS);
      }
    })().catch((e) => fail("typing", e));
    return () => {
      done = true;
    };
  };

  /** A service miss is stated by code, never answered with invented market banter. */
  const deskMiss = async (chatId: number, ask: TgDeskAsk, why: "not-found" | "ambiguous" | "unavailable" | "rate-limit", o: SpeakOpts, note?: string): Promise<{ chatId: number; messageId?: number } | null> => {
    const text = [deskMissLine(why, ask.kind === "comparison" ? "coin" : ask.kind), note].filter(Boolean).join(". ");
    const sent = await deliver({
      chatId, intent: { kind: "answer", mood: "normal" }, text,
      ...(o.replyTo !== undefined ? { replyTo: o.replyTo } : {}),
      ...(o.threadId !== undefined ? { threadId: o.threadId } : {}),
      ...(o.mention ? { mention: o.mention } : {}),
      bornAtMs: o.bornAtMs ?? clock(),
      replyByMs: o.replyByMs ?? (o.bornAtMs ?? clock()) + RESEARCH_REPLY_MS,
      followUp: false, ownerAddressed: o.ownerAddressed === true,
      ...(o.stillWanted ? { stillWanted: o.stillWanted } : {}),
      ...(o.miss ? { miss: o.miss } : {}),
      ...(o.accountAnswer ? { accountAnswer: o.accountAnswer } : {}),
    });
    if (sent) recordOwn(sent.chatId, sent.messageId, text, sent.chatId === chatId ? o.replyTo : undefined);
    return sent;
  };

  /**
   * RUN AN UNANSWERED ASK AGAIN, once, for the line that says it was missed
   * (the router's reask): as onMessage's re-ask, the reply to the ask itself.
   * False when there is nothing to re-run (answered meanwhile, re-run
   * already, or the person was forgotten).
   */
  const reaskAgain = (j: LineJob): boolean => {
    const open = j.reaskable;
    if (!open || open.reasked || open.noReask || askStateOf(open) !== "lost" || forgotten(open.job)) return false;
    const now = clock();
    const again = againOf(open.job, now, ++ingressOrder);
    open.reasked = true;
    open.eyed = false;
    open.job = again;
    lostAsks.delete(msgKey(again.msg.chatId, again.line.messageId));
    lastAddressed.set(`${again.msg.chatId}:${again.line.fromId}`, { messageId: again.line.messageId, atMs: now });
    // It is their open ask again, so a poke while it runs gets the 👀; unless the line that
    // asked for it became their open ask itself (it was substantive): a misread reask then
    // leaves that line open, to be re-run in turn, never dropped for good.
    const k = askKey(again.msg.chatId, again.line.fromId, again.threadId);
    const left = openAsks.get(k);
    if (left?.job.line.messageId !== j.line.messageId) openAsks.set(k, open);
    else left.rerun = open;
    log("[tg-groups] an unanswered ask re-asked (routed)");
    if (open.research) track(processLine(again));
    else enqueue(again.msg.chatId, () => processLine(again), { force: true });
    return true;
  };

  /** "i asked a question" with nothing of theirs open: which one? Code-written, gated as a fixed line. */
  const whichQuestion = async (chatId: number, j: LineJob, o: SpeakOpts): Promise<{ chatId: number; messageId?: number } | null> => {
    const v = admitTgLine(WHICH_QUESTION, { agentName: selfNow()?.name ?? "", kind: "fixed", recentOwn: [] });
    if (!v.ok) return null;
    const sent = await deliver({
      chatId, intent: { kind: "answer", mood: "normal" }, text: v.text,
      ...(o.replyTo !== undefined ? { replyTo: o.replyTo } : {}),
      ...(o.threadId !== undefined ? { threadId: o.threadId } : {}),
      bornAtMs: j.bornAtMs,
      followUp: false, ownerAddressed: o.ownerAddressed === true,
      ...(o.stillWanted ? { stillWanted: o.stillWanted } : {}),
      ...(o.miss ? { miss: o.miss } : {}),
    });
    if (sent) recordOwn(sent.chatId, sent.messageId, v.text, sent.chatId === chatId ? o.replyTo : undefined);
    return sent;
  };

  /** No subject is evidence too: ask once instead of guessing a coin or inventing its story. */
  const deskClarify = async (chatId: number, o: SpeakOpts, j: LineJob): Promise<{ chatId: number; messageId?: number } | null> => {
    const text = "which coin or read do you mean? reply to it, or send the coin's name or address so i can explain it properly.";
    const sent = await deliver({
      chatId, intent: { kind: "answer", mood: "normal" }, text,
      ...(o.replyTo !== undefined ? { replyTo: o.replyTo } : {}),
      ...(o.threadId !== undefined ? { threadId: o.threadId } : {}),
      bornAtMs: j.bornAtMs, replyByMs: j.bornAtMs + RESEARCH_REPLY_MS,
      followUp: false, ownerAddressed: o.ownerAddressed === true,
      ...(o.stillWanted ? { stillWanted: o.stillWanted } : {}),
      ...(o.miss ? { miss: o.miss } : {}),
      accountAnswer: accountResearchAnswer(j.line, j.seenAtMs),
    });
    if (sent) recordOwn(sent.chatId, sent.messageId, text, sent.chatId === chatId ? o.replyTo : undefined);
    return sent;
  };

  const deskAnswer = async (chatId: number, j: LineJob, ask: TgDeskAsk, o: SpeakOpts, note?: string, allowed = true): Promise<{ chatId: number; messageId?: number } | null> => {
    const replyByMs = o.replyByMs ?? j.bornAtMs + RESEARCH_REPLY_MS;
    const opts = { ...o, replyByMs };
    // Remember the actual subject even on failure: a reply asking for a proper
    // analysis should retry that subject, not turn into unrelated banter.
    rememberDesk(chatId, ask, j.seenAtMs, j.ingressOrder, j.threadId, false, j.line.fromId);
    if (!allowed) return deskMiss(chatId, ask, "rate-limit", opts, note);
    const stopTyping = keepTyping(chatId, replyByMs, o.threadId, "upload_photo", o);
    try {
      const composed = await deskCompose(chatId, ask, j.line.text, note, replyByMs);
      if (!composed.ok) {
        log(`[tg-groups] desk ${ask.kind} miss (${composed.why})`);
        return await deskMiss(chatId, ask, composed.why, opts, note);
      }
      return await deskDeliver(chatId, composed, opts);
    } finally {
      stopTyping();
    }
  };

  /**
   * THE COIN FLOW'S READ (coins.ts CoinFlowDeps.read): a posted CA answered
   * with the chart and the read inside the desk's budget, the quick screen's
   * verdict as a code-written line under it. False — and the coin flow says
   * its own line — when the desk is off, the chat has had its share of reads,
   * or the desk could not answer.
   */
  const deskReadCoin = async (chatId: number, address: string, o: CoinReadOpts): Promise<boolean> => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address) || !coinFactsOn()) return false;
    const poster = o.trigger;
    const seenAt = received.get(msgKey(chatId, poster.messageId)) ?? poster.atMs;
    if (forgottenSince(chatId, poster.fromId, seenAt)) return false;
    if (flooded(chatId, poster.fromId)) {
      coinMissed.set(msgKey(chatId, o.replyTo), "flood");
      await floodEyes(chatId, poster.fromId, o.replyTo);
      return false;
    }
    if (!reserveReply(chatId, o.replyTo)) return false;
    const replyByMs = o.replyByMs ?? seenAt + RESEARCH_REPLY_MS;
    const threadId = threads.get(msgKey(chatId, o.replyTo));
    const label = o.mention && isUserId(o.mention.id) ? tagLabel(o.mention.name) : "";
    const opts: SpeakOpts = {
      replyTo: o.replyTo,
      ...(threadId !== undefined ? { threadId } : {}),
      ...(label && o.mention ? { mention: { id: o.mention.id, name: label } } : {}),
      bornAtMs: seenAt, replyByMs,
      ownerAddressed: poster.fromId === ownerId() && askedIn.has(msgKey(chatId, o.replyTo)),
      stillWanted: () => coinFactsOn() && !forgottenSince(chatId, poster.fromId, seenAt) && (!o.stillWanted || o.stillWanted()),
      miss: (why) => coinMissed.set(msgKey(chatId, o.replyTo), why),
      accountAnswer: accountResearchAnswer(poster, seenAt),
    };
    const ask: TgDeskAsk = { kind: "coin", address };
    const order = messageIngressOrder.get(msgKey(chatId, poster.messageId));
    rememberDesk(chatId, ask, seenAt, order, threadId, false, poster.fromId);
    const note = deskNoteFor(store.coin(chatId, address)) ?? o.note;
    let sent: { chatId: number; messageId?: number } | null;
    if (o.busy) sent = await deskMiss(chatId, ask, "rate-limit", opts, note);
    else if (!deskNow()) sent = await deskMiss(chatId, ask, "unavailable", opts, note);
    else if (!deskRoom(chatId)) sent = await deskMiss(chatId, ask, "rate-limit", opts, note);
    else {
      const stopTyping = keepTyping(chatId, replyByMs, threadId, "upload_photo", opts);
      try {
        const composed = await deskCompose(chatId, ask, o.trigger.text, note, replyByMs);
        sent = composed.ok ? await deskDeliver(chatId, composed, opts) : await deskMiss(chatId, ask, composed.why, opts, note);
      } finally {
        stopTyping();
      }
    }
    // A transport timeout may already have landed. Keep the message's reply
    // reservation; the coin flow's fallback cannot blindly send another answer.
    if (sent && sent.chatId !== chatId && !forgottenSince(chatId, poster.fromId, seenAt) && !forgottenSince(sent.chatId, poster.fromId, seenAt)) {
      // Migration carries the subject, retaining its original receipt order
      // and lifetime; a newer destination ask still wins.
      rememberDesk(sent.chatId, ask, seenAt, order, undefined, true, poster.fromId);
    }
    return sent !== null;
  };

  const requestedFact = async (request: PublicFactRequest, chatId: number): Promise<TgPublicFact> => {
    if (request.kind === "calculation") return request.fact;
    // What a room can ask: only what is wired here, read now (never from the line).
    if (request.kind === "site" && (request.topic === "capabilities" || request.topic === "dm-policy")) {
      return { kind: "site", topic: request.topic, wired: { fomo: fomoNow() !== null, desk: deskNow() !== null, coins: coinFactsOn() } };
    }
    if (request.kind === "site") return { kind: "site", topic: request.topic };
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
    if (why !== null && j.addressed !== null) quietLine(why, j);
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
    // gets the kind line (pacing), not "hmm is this good?". A re-asked line
    // (onMessage) never comes here: its coin was the flow's the first time,
    // and a second claim or nomination is never made (rule 1).
    if (!j.deferred && !j.reasked && !isDistress(text)) {
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
      // A cashtag said to it with no CA is a question for the desk, which can
      // find the coin by name; the coin flow's "drop the ca" is for a cashtag
      // dropped in the room, or when there is no desk.
      const deskTicker = j.addressed !== null && !asked && cas.length === 0 && !foreignMint && cashtags.length > 0 && deskNow() !== null && coinFactsOn()
        && deskIntentOf(text, j.msg.chatId)?.kind === "coin";
      const researchIntent = deskIntentOf(text, j.msg.chatId);
      const deskResearch = j.addressed !== null && deskNow() !== null && coinFactsOn() && !foreignMint && otherChain.length === 0 && !isInjection(text)
        && (deskQuestionIntent(text) === "comparison" || (cas.length === 1 && researchIntent?.kind === "coin"
          && (deskQuestionIntent(text) !== "overview" || isReadOnlyTradeQuestion(text) || /\b(?:chart|analy[sz]e|analysis|read[- ]only|research)\b/iu.test(text))));
      // AN ADDRESSED RESEARCH QUESTION IS NOT A COIN POST: "what are the theses
      // on $PONS?" is answered by the research lane (act), never asked for a CA,
      // and a CA inside such a question is a subject to research, never a
      // nomination into trading (an information request never starts a trade).
      const fomoQuestion = j.fomo === true && !isInjection(text);
      if (!rememberedAsk && !deskTicker && !deskResearch && !fomoQuestion && (cas.length > 0 || foreignMint || cashtags.length > 0)) {
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
          // Public desk replies share one 30-second window from ingress;
          // legacy coin replies retain STALE_MS. Lookup leaves time to send,
          // and an expired window permits no late fallback.
          replyByMs: j.bornAtMs + (d.desk ? RESEARCH_REPLY_MS : STALE_MS),
          forgotten: () => forgotten(j),
        });
        // The coin flow owns the message: nothing else is said about it. Its
        // looks and lines run beside chatter (coins.ts): concurrently with a
        // public desk, or on the legacy coin lane. The next line is read now.
        if (post.owned === "handled") {
          const key = msgKey(chatId, j.line.messageId);
          // The flow owns it, and a re-run skips the flow: never re-askable, by a poke, a complaint or the router.
          const ownedAsk = openAsks.get(askKey(chatId, j.line.fromId, j.threadId));
          if (ownedAsk && ownedAsk.job.line.messageId === j.line.messageId) ownedAsk.noReask = true;
          const how = asked ? "reply to a coin post" : j.addressed !== null ? "to me" : "not to me";
          track(
            post.done.then((end) => {
              const acted = end.acted || landedOn.has(key);
              coinPostLine(how, { ...end, acted }, coinMissed.get(key));
              if (j.addressed === null || acted) return;
              quietLine(coinMissed.get(key) ?? end.quiet ?? "coin-silent", j);
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
    let dec = decide({
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
    // Frustration about an unanswered research question deserves the read,
    // while distress, protected-trait abuse, privacy and injection retain priority.
    if (j.addressed !== null && dec.act === "roast" && !signals.distress && !signals.privateAsk && !signals.injection && signals.insult !== "hateful"
      && deskAskFor(j, coinContext(j), asksAboutCoin(text, selfNamesOf(selfNow())), firmDeskIntentOf(text, chatId)) !== null) {
      dec = { act: "answer", mood: "normal" };
    }
    // A NEW LINE WHILE AN EARLIER ASK WENT UNANSWERED ("bro??", "you good?",
    // "you ignored me"): an answer the router may read as "ask it again"
    // (act(): reask), however small the talk.
    // A hail keeps its template ("hey 👋", "all good, just lurking 👀") as what the persona says
    // when the router picks nothing: routed for a reask, never a model-written answer to "yo".
    let fallback: TgIntent | undefined;
    if (j.reaskable && j.addressed !== null && ((dec.act === "smalltalk" && dec.what === "hail") || (dec.act === "answer" && dec.mood === "normal")) && !signals.distress && !signals.injection) {
      if (dec.act === "smalltalk") fallback = { kind: "smalltalk", what: dec.what };
      dec = { act: "answer", mood: "normal" };
    }
    if ((dec.act === "skip" || dec.act === "react") && j.addressed === null && (await maybeFadedAgain(j, cfg))) return null;
    stageOf(chatId, `act: ${dec.act}`);
    return act(dec, j, fallback);
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
      if (r.status === "blocked") row.push({ text: `${n} · Unblock`, callbackData: `${CB_PREFIX}unblock:${r.chatId}` });
      row.push({ text: `${n} · Forget`, callbackData: `${CB_PREFIX}forget:${r.chatId}` });
      keyboard.push(row);
    });
    // A Leave pressed by mistake is otherwise forever: a blocked group's every
    // re-add by someone else is undone, and nothing on this list said how out.
    if (rooms.some((r) => r.status === "blocked")) {
      lines.push("", "Pressed Leave by mistake? Unblock lets a group back, or send /groups unblock to clear them all.");
    }
    return { html: lines.join("\n"), keyboard };
  };

  /**
   * BLOCKED BACK TO UNDECIDED — `left`, not `approved`. The bot is not in the
   * group, and the owner unblocking it is not the owner asking it in: their own
   * re-add approves it as it always did (onMember), and anyone else's asks them
   * again, where a blocked room's would have been undone quietly. Memory is not
   * touched; Forget is for that. `releft` is cleared so a line from the group,
   * if it is ever back, is not answered with a leave this process remembered.
   *
   * `unblockedAtMs` holds that promise for a group the owner once ran /link in:
   * its allowlist entry would otherwise approve anyone's re-add on sight, and
   * the owner's Leave came after that link. It lasts until they decide again.
   */
  const unblock = (chatId: number): void => {
    const at = clock();
    store.update(chatId, (r) => {
      // One durable state: writing `left` before its consent guard would let
      // a restart between writes revive an old /link and approve a stranger.
      r.status = "left";
      r.statusAtMs = at;
      delete r.askedOwnerAtMs;
      r.unblockedAtMs = at;
    }, { flush: true });
    releft.delete(chatId);
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
          ...(msg.isTopicMessage === true && isMsgId(msg.messageThreadId) ? { threadId: msg.messageThreadId } : {}),
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
        const order = ++ingressOrder;
        messageIngressOrder.set(key, order);
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
        // A LINE ABOUT ITS OWN SILENCE ("?", "hello??", "i asked a question",
        // its name alone) while their ask is still being worked on never
        // decides the burst: that ask stays the line to answer (openAsks).
        // Small talk and such lines are never an ask of their own.
        const meta = addressed !== null ? metaLineOf(text, selfNamesOf(me)) : null;
        const ownOpen = addressed !== null ? openAskOf(chatId, msg.fromId, threadId) : null;
        // A /forgetme'd ask is nothing open: no 👀 promising it, never re-run,
        // so their hail, poke or complaint gets its own answer.
        const open = ownOpen && !forgotten(ownOpen.job) ? ownOpen : null;
        const openState = open ? askStateOf(open) : null;
        // An ask the coin flow owns (noReask) is never run again: past the 👀 while it runs, nothing is open.
        const live = open && !open.noReask ? open : null;
        const substantive = addressed !== null && meta === null && smallTalkOf(text, selfNamesOf(me), room.title) === null;
        if (addressed !== null) {
          stats.addressed += 1;
          if (!(meta !== null && openState === "running")) lastAddressed.set(`${chatId}:${msg.fromId}`, { messageId, atMs: now });
          askedIn.set(key, true);
        }
        maybeMemoryPass(chatId);
        if (meta !== null && open && openState === "running") {
          // A POKE WHILE ITS ASK IS BEING WORKED ON: a 👀 on it (no model
          // call, no reply slot), and the answer still lands on the ask.
          log("[tg-groups] addressed line got 👀 (poke-while-working)");
          if (!open.eyed) {
            open.eyed = true;
            track(reactTo(chatId, messageId, "👀", { ownerAddressed: isOwner, stillWanted: () => !forgottenSince(chatId, msg.fromId, now) }));
          }
          return;
        }
        // A hail or a "?" after a nudge whose re-run already ran gets its own
        // answer; only an explicit complaint re-runs that nudge (a misread reask).
        if (meta !== null && live && openState === "lost" && !live.reasked && (!live.rerun || meta === "complaint")) {
          const open = live;
          // NOTHING ANSWERED THEIR ASK: run it again, once, as the reply to
          // it. A /forgetme since still cancels it (seenAtMs is kept), and it
          // is never claimed or nominated again (lineOutcome: reasked).
          const again = againOf(open.job, now, ++ingressOrder);
          open.reasked = true;
          open.eyed = false;
          open.job = again;
          lostAsks.delete(msgKey(chatId, again.line.messageId));
          lastAddressed.set(`${chatId}:${msg.fromId}`, { messageId: again.line.messageId, atMs: now });
          log(`[tg-groups] an unanswered ask re-asked (${meta})`);
          if (open.research) track(processLine(again));
          else enqueue(chatId, () => processLine(again), { force: true });
          return;
        }

        // An addressed research question, or a short follow-up to this
        // topic's last research answer (fomoRecent), while a port is wired.
        // A bare "what's trending" (no platform or venue named) is Fomo's
        // trending board there, with the desk as its fallback (act()).
        const fomoHere = addressed !== null && fomoNow() !== null;
        const named = fomoHere && fomoAskOf(text, selfNamesOf(me)) !== null;
        const desked = fomoHere && !named ? deskIntentOf(text, chatId) : null;
        const trendingAsk = desked?.kind === "market" && desked.trending === true;
        // A market ask naming a venue ("what's trending in the market", "on robinhood chain") stays
        // with the desk, even right after a Fomo answer (D1): never a Fomo follow-up.
        const venueMarket = desked?.kind === "market" && desked.trending !== true;
        // So does a line the desk owns: an analysis, a comparison, or a coin
        // it names ("what do you think about sol?", "should i buy sol?"),
        // unless the coin word is a chain in a chain's position ("on base?"),
        // or the line asks what traders are saying about the coin ("what are
        // people saying about $PONS now"): that is the coin's theses, never a chart.
        const deskOwned = desked?.kind === "analysis" || desked?.kind === "comparison"
          || (desked?.kind === "coin" && chainIn(text) === undefined && !/\b(?:saying|thes[ie]s)\b/iu.test(text));
        const fomoAsk = fomoHere && (named || trendingAsk || (!venueMarket && !deskOwned && fomoRecent(chatId, threadId) && fomoFollowUpOf(text, selfNamesOf(me))));
        // A complaint with nothing of theirs open asks which question; one
        // replying to its answer to their open ask has that ask read again by
        // the router (act()). A new line while an earlier one went
        // unanswered may be a nudge in other words: the router may re-run it.
        const repliesToOwn = !!me && msg.replyTo?.fromId === me.id && isMsgId(msg.replyTo.messageId);
        const answeredHere = !!open && openState === "answered" && repliesToOwn
          && store.room(chatId)?.lines.some((l) => l.own && l.messageId === msg.replyTo?.messageId && l.replyTo === open.job.line.messageId) === true;
        const job: LineJob = {
          msg, line, addressed, isOwner, via, bornAtMs: now, seenAtMs: now, ingressOrder: order,
          ...(threadId !== undefined ? { threadId } : {}),
          ...(fomoAsk ? { fomo: true } : {}),
          ...(trendingAsk ? { trending: true } : {}),
          ...(meta !== null ? { meta } : {}),
          ...(meta === "complaint" && !live ? { noOpenAsk: true } : {}),
          // A /forgetme'd line never reaches the router as their earlier question.
          ...(meta === "complaint" && answeredHere && live && !forgotten(live.job) ? { reaskOf: live.job.line.text } : {}),
          // Never a nudge whose routed re-run already ran (live.rerun): her next line is no complaint about it.
          ...(meta === null && addressed !== null && live && openState === "lost" && !live.reasked && !live.rerun && !forgotten(live.job) ? { reaskable: live } : {}),
        };
        // A coin line's durable claim and nomination admission must not be
        // lost to a busy chatter queue. Ordinary chatter keeps its queue cap.
        const coin = extractCas(text).length > 0;
        // Public research starts beside a busy chatter queue. Bookkeeping and
        // reply admission still happen synchronously. Nomination admission
        // belongs to the port; financial execution stays on the trading side.
        const research = fomoAsk || (!!d.desk && (coin || (addressed !== null && (deskIntentOf(text, chatId) !== null
          || /\b(?:why|how come|vibes|asked you|asked a question|chart|analysis)\b/iu.test(text)))));
        // Their newest substantive line is their open ask from now on.
        if (substantive) openAsks.set(askKey(chatId, msg.fromId, threadId), { job, research, reasked: false });
        if (research) track(processLine(job));
        else enqueue(chatId, () => processLine(job), { force: addressed !== null });
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
        // A link the owner made before telling it to leave does not outlast
        // that Leave: an unblocked group is asked about again (unblock).
        if (linked && room.unblockedAtMs === undefined) {
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
        } else if (what === "unblock") {
          if (room.status === "blocked") {
            unblock(chatId);
            note("ok", "Telegram groups: the owner unblocked a group");
            outcome = `✅ Unblocked ${title}. Add me back to it and I'll join in.`;
            await answer("Unblocked");
          } else {
            outcome = `${title} isn't blocked.`;
            await answer("Not blocked");
          }
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

    async unblockAll(chatId: number): Promise<void> {
      try {
        const opts = optsNow();
        if (!opts) return;
        const blocked = store.rooms().filter((r) => r.status === "blocked");
        for (const r of blocked) unblock(r.chatId);
        if (blocked.length > 0) note("ok", `Telegram groups: the owner unblocked ${blocked.length} group(s)`);
        const names = blocked.map((r) => (r.title ? `«${esc(r.title)}»` : "a group")).join(", ");
        await sendMessage(
          opts,
          chatId,
          blocked.length === 0
            ? "Nothing to unblock: you haven't told me to leave any group."
            : `✅ Unblocked ${names}. Add me back to any of them and I'll join in.`,
        );
      } catch (e) {
        fail("unblock", e);
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
      await commandNotice(chatId, messageId, fromId, what, threadId);
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
