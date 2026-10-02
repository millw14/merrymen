/**
 * Telegram poll service — the merryman's always-on ear.
 *
 * An independent, self-scheduling long-poll loop (setTimeout + .finally, NEVER
 * setInterval, NEVER inside the trading tick) started once from the worker's
 * main(). It reads the live config each iteration (so token/allowlist/enable
 * changes from the dashboard apply with no restart), gates every message on the
 * allowlist (except /link, and /start <code>, its deep-link form), routes
 * obeyed messages through the interpreter → executor, and replies. Every
 * action is logged to the event feed so the dashboard shows "Telegram: …".
 *
 * Safety: a chat message can only produce one enumerated Command; trades still
 * pass the policy wall via the injected submitTrade; /cap and caps clamp to the
 * signed grant. Transfers additionally require the dashboard toggle, a grant
 * that carries the transfer permission, and an explicit /confirm after the full
 * recipient address is echoed back. The link code rotates after every
 * successful /link and guesses are rate-limited (link.ts). Nothing here can
 * exceed the grant.
 *
 * Messages that waited out an outage are not live messages: see pollOnce's
 * backlog rule before changing how a batch is handled.
 */

import { existsSync, rmSync, writeFileSync } from "node:fs";
// RELATIVE import only — the "@merrymen/core" alias exists solely in dev
// tsconfigs; inside the installed package tsx can't resolve it and the worker
// dies at startup (which silently kills Telegram). Never alias-import in worker/.
import { PC_CAPABILITIES, isHostedMode } from "../../../packages/core/src/index";
import { patchSettingsFile, type ResolvedConfig } from "../settings";
import { rememberChatSetting } from "./state";
import { ensureHome, homePaths } from "../home";
import { loadGrantFile } from "../grant";
import {
  answerCallbackQuery,
  editMessageText,
  esc,
  escModel,
  getFileUrl,
  getMe,
  getUpdates,
  sendChatAction,
  sendMessage as sendTelegramMessage,
  setMyCommands,
  publicBotCommands,
  type InlineKeyboard,
  type SendExtra,
  type SendResult,
  type TgBotInfo,
  type TgCallback,
  type TgMessage,
} from "./api";
import { runAgentTask } from "./agent";
import { SETTING_CONFIRM_TTL_SEC, executeCommand, type CommandDeps, type KillResult, type PendingAction } from "./executor";
import { appliedText, proposeSettingChange, settingsListText } from "./settings-chat";
import { specFor, stockSymbols, validStoredSetting } from "./setting-spec";
import { signKeyboard, signUrl } from "./sign-prompt";
import { confirmKeyboard, mintNonce, parseConfirmData } from "./buttons";
import { BUILTIN_STRATEGIES } from "../strategies/registry";
import { bookAddresses } from "../custody";
import { mainnetClient } from "../snapshot";
import type { TradeViewOpts } from "./trade-rows";
import { answerQuestion } from "./answer";
import type { ToolContext } from "./chat-tools";
import { resolveLlm } from "../llm";
import { CONTROL_KINDS, PC_KINDS, interpretWithLlm, narrateChat, narrateWhy, parseSlash, stripThinkingBlock, type Command } from "./interpreter";
import { makePcActions, resolveInRoot } from "./pc";
import { transcribeVoice } from "./voice";
import { fmtReminders, fmtWatchers, parseWatchSpec, parseWhenSec } from "./watchers";
import {
  HELP_TEXT,
  readBrag,
  readLlmState,
  readPnl,
  readPositions,
  readReport,
  readStatus,
  readTrades,
  readWallet,
  readWhyEvidence,
  redactAddresses,
  dashboardBase,
  type StatusContext,
} from "./reads";
import { bindToken, botIdOf, ensureLinkCode, recordPoll, retireLegacyCode, rotateLinkCode, type StateRef } from "./state";
import { linkReply, tallyFailedLink, tryLink, type LinkFails } from "./link";
import {
  BACKOFF_MAX_SEC,
  CONFLICT_RETELL_SEC,
  EARLY_LINK_TEXT,
  IDLE_GAP_MS,
  POLL_GAP_MS,
  REARM_AFTER_SEC,
  STALE_LINK_TEXT,
  WAKE_SLICE_MS,
  groupLineShowsCode,
  isGroupMessage,
  makeChatTally,
  onboardingText,
  pollFailure,
  refusalText,
  span,
  telegramLog,
  type ChatTally,
} from "./poll-rules";
import {
  ageDays,
  ensureSoul,
  forgetOwner,
  getBornDate,
  getName,
  ownerFacts,
  relationship,
  rememberNote,
  rememberOwnerFact,
  setName as setSoulName,
  soulPromptBlock,
  identityBlock,
  narratorIdentityBlock,
  recallForPrompt,
} from "../soul";
import { appendChatTurn, clearChatTurns, lastChatTurnAt, recentChatTurns } from "../store";
import { describeGap } from "../memory/retrieve";
import { describeLlmFailure, isLlmProviderFailure } from "../llm-failure";
import type { TgGroupsStore } from "./tg-groups/store";
import type { TgCoinsPort, TgGroupFactsPort } from "./tg-groups/types";
import { createTgGroups, type TgCommandNotice, type TgGroups, type TgGroupsDeps } from "./tg-groups/handler";
import type { HeldGroupEntry } from "./held-groups";

/**
 * Commands that are really questions when they arrive as WORDS: answered by
 * looking things up (answer.ts) rather than by dumping the matching report.
 * As slash commands they still return the exact report.
 */
const ANSWER_KINDS: ReadonlySet<string> = new Set(["chat", "status", "positions", "pnl", "trades", "why"]);

/** Buttons a command asked to have under its reply. */
interface ReplyExtras {
  keyboard?: InlineKeyboard;
}

export interface TelegramServiceDeps {
  /** Live config (reassigned each tick by refreshConfig — pass a getter). */
  getCfg: () => ResolvedConfig;
  /** Shared persisted state (offset, link code, owner, alerts …). */
  stateRef: StateRef;
  /** Event-feed sink (strategyNote). */
  note: (level: "ok" | "warn", message: string) => void;
  /** Live status context for /status. */
  buildStatusContext: () => StatusContext;
  /** Validate + apply a strategy switch (name must resolve). */
  setStrategy: (name: string) => { ok: boolean; reason?: string };
  /** On-chain per-trade ceiling for clamping /cap; undefined when no grant. */
  grantPerTradeUsdg: () => number | undefined;
  /** Does the armed grant carry the on-chain transfer permission? */
  grantHasTransfer: () => boolean;
  /** Liquidity depth for a ticker, read from the chain. Lives in index.ts because
   * this file deliberately owns no chain client. */
  readDepth: (symbol: string) => Promise<string>;
  /** Build a bounded TradeIntent and route it through processIntent. */
  submitTrade: (side: "buy" | "sell", symbol: string, usdg: number) => Promise<string>;
  /** Build a bounded transfer intent and route it through processIntent. */
  submitTransfer: (to: `0x${string}`, usdg: number) => Promise<string>;
  /** Delete the grant (kill switch). */
  kill: () => KillResult;
  /** Mirror a /name change into the agents table (dashboard display). */
  onNameChange?: (name: string) => void;
  /**
   * Where refusals, failed codes and undelivered messages are counted and
   * logged: the fleet's log, never `note` (poll-rules.ts makeChatTally).
   * index.ts hands the same one to the notifier, so a blocked bot is said
   * once an hour whichever of the two found it. One of its own otherwise.
   */
  tally?: ChatTally;
  /**
   * Telegram groups (docs/tg-groups.md). The durable per-agent store of every
   * group's memory, and the port through which a coin posted in a group can
   * reach trading — as an address and nothing else. Both optional: without
   * them the bot stays silent in groups.
   */
  tgGroupsStore?: TgGroupsStore;
  tgCoins?: TgCoinsPort;
  /** A public projection of recorded actions, with no wallet amounts or private reasons. */
  tgFacts?: TgGroupFactsPort;
  /**
   * What a hold process kept about groups while trading was held
   * (held-groups.ts takeHeldGroupUpdates over this home): taken once, at the
   * first poll that can hand it to the group handler. Hosted only; without
   * it there is nothing to take.
   */
  heldGroupUpdates?: () => HeldGroupEntry[];
  /** Injectable for tests. */
  now?: () => number;
  /** Injectable for tests: the group handler's clock, dice, waits, environment and log. */
  tgGroupsTest?: Partial<Pick<TgGroupsDeps, "now" | "rand" | "sleep" | "env" | "log">>;
}

/** Toggle the pause marker the tick loop honors. */
export function setPaused(paused: boolean): void {
  try {
    ensureHome();
    if (paused) writeFileSync(homePaths.paused(), "paused", "utf8");
    else rmSync(homePaths.paused(), { force: true });
  } catch {
    // best-effort
  }
}

export function isPaused(): boolean {
  return existsSync(homePaths.paused());
}

const HISTORY_TURNS = 6; // user+assistant pairs kept per chat for follow-ups
/** How often the cached getMe (id, username, privacy flag) is read again. */
const SELF_REFRESH_MS = 30 * 60 * 1000;
/**
 * THE POLL HEARTBEAT: how many updates of each kind arrived, every few
 * minutes when any did, and a liveness line after a long quiet. Counts only.
 * It is what tells "no group message reaches this bot" (Telegram, privacy
 * mode, a second poller on the token) apart from "they arrive and something
 * after the poll drops them".
 */
const POLL_HEARTBEAT_MS = 5 * 60 * 1000;
const POLL_QUIET_NOTE_MS = 30 * 60 * 1000;

/**
 * Commands that read the owner's private state (docs/tg-groups.md rule 3).
 * Asked in a group by the owner or an allowlisted sender, they are answered in
 * THAT PERSON'S DM, never in the room. The contract's list, plus the other
 * reads that print settings, alerts, reminders or the remote-control state —
 * rule 3 keeps all of those out of a group too.
 */
const PRIVATE_READS: ReadonlySet<string> = new Set([
  "status",
  "positions",
  "pnl",
  "trades",
  "wallet",
  "why",
  "report",
  "soul",
  "depth",
  "brag",
  "settings",
  "alerts",
  "reminders",
  "watchers",
  "pc",
]);

// What counts as a group (isGroupMessage) is in poll-rules.ts, which the hold
// process shares: neither process sends a group down a DM's path.

// The refusal, the onboarding line and the late-code prompt are in
// poll-rules.ts, which the hold process shares: a stranger is told the same
// whichever process is answering.

/**
 * What the backlog rule does with one message that waited out a silence
 * (holdStale): answer a late code, refuse a stranger, run it (only /pause and
 * /kill, which can only reduce risk), or hold it back.
 */
function staleAction(text: string, allowed: boolean): "late-code" | "refuse" | "run" | "hold" {
  const kind = parseSlash(text)?.kind;
  if (kind === "link" || kind === "start") return "late-code";
  if (!allowed) return "refuse";
  if (kind === "pause" || kind === "kill") return "run";
  return "hold";
}

/**
 * What a late slash command typed in a group may still do, by its name (ours,
 * the @name gone) and text (routeGroup). "forget": a /forgetme or /forget,
 * which only take something away, whenever it arrives. "run": /pause or
 * /kill, which only reduce risk, as in a DM (staleAction). "hold": the rest.
 */
function lateGroupCommand(name: string, text: string): "forget" | "run" | "hold" {
  if (name === "forgetme" || name === "forget") return "forget";
  return staleAction(text, true) === "run" ? "run" : "hold";
}

/** One batch's backlog bookkeeping: who has been answered, and what each allowlisted chat had held back. */
interface StaleBatch {
  /** `${chatId}:${action}` for each answer already given in this batch. */
  told: Set<string>;
  /** Per chat, how many messages were held back and the oldest one's date. */
  held: Map<number, { n: number; oldest: number }>;
  /**
   * This batch was asked for from no saved offset, by the first good poll of
   * this bot in this process (polledBot), so it may hold the last batch a
   * process before this one ran: say so, rather than that none of it was
   * acted on (staleSummaryText).
   */
  blind: boolean;
}

function heldPerChat(stale: TgMessage[], cfg: ResolvedConfig): Map<number, { n: number; oldest: number }> {
  const held = new Map<number, { n: number; oldest: number }>();
  for (const m of stale) {
    const allowed = cfg.telegramAllowlist.includes(m.chatId) || cfg.telegramAllowlist.includes(m.fromId);
    if (staleAction(m.text, allowed) !== "hold") continue;
    const h = held.get(m.chatId);
    held.set(m.chatId, h ? { n: h.n + 1, oldest: Math.min(h.oldest, m.date) } : { n: 1, oldest: m.date });
  }
  return held;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "14:36 UTC" today, "Sep 27 14:36 UTC" on another day: a backlog can be a day old. */
function utcStamp(sec: number, nowSec: number): string {
  const d = new Date(sec * 1000).toISOString();
  const hm = `${d.slice(11, 16)} UTC`;
  if (d.slice(0, 10) === new Date(nowSec * 1000).toISOString().slice(0, 10)) return hm;
  return `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))} ${hm}`;
}

/**
 * The one note an allowlisted chat gets about what it sent while the bot was
 * not listening.
 *
 * "I DIDN'T ACT ON IT" IS SAID ONLY WHERE IT IS KNOWN. Telegram confirms an
 * update only when a later getUpdates asks past it, so the last batch a
 * process handled is still pending there until its next poll (bindBot says
 * the same of a switch). A redeploy in that window, the handling time plus
 * POLL_GAP_MS, perhaps in the middle of the trade itself, wipes the home and
 * the offset with it (orchestrator.ts restoredTelegramFile restores none), and
 * the next process asks from 0 and is handed that batch again. The date rule
 * holds it back, rightly; but told "I didn't act on it — resend", an owner
 * whose /buy had filled before the redeploy, with the reply lost to it, would
 * buy twice.
 *
 * So for a batch asked for from no saved offset (`blind`), the note says what
 * this process can know: it has done nothing with them, and they may have
 * gone through before, so look before resending a trade or a transfer. With
 * an offset saved, every update handed back is past everything handled under
 * it (the offset is saved before each update runs), and the plain claim is
 * true.
 */
function staleSummaryText(n: number, oldest: number, nowSec: number, blind: boolean): string {
  const what = n === 1 ? "1 message arrived late" : `${n} messages arrived late`;
  const them = n === 1 ? "it" : "them";
  if (blind) {
    return (
      `I've just come back online; ${what} (oldest ${utcStamp(oldest, nowSec)}). I haven't acted on ${them} since, ` +
      `but ${n === 1 ? "it" : "some"} may have gone through just before I went offline — check /status and /trades before you resend a trade or a transfer.`
    );
  }
  return `I was offline; ${what} (oldest ${utcStamp(oldest, nowSec)}). I didn't act on ${them} — resend anything you still need.`;
}
/** Anything else an allowlisted chat sent the bot before this agent was switched onto it (holdEarly). */
const EARLY_HELD_TEXT =
  "I've just been connected to this bot. Messages sent to it before that reached me late, so I didn't act on them — resend anything you still need.";

// The poll's timings (the gap, the idle wait, the backoff and the re-arm
// silence) are in poll-rules.ts, shared with the hold process.
/** Failed pushes of one menu fingerprint before it drops to one try per MENU_RETRY_SEC. */
const MENU_MAX_ATTEMPTS = 3;
const MENU_RETRY_SEC = 600;

/** How pushing one menu fingerprint is going. */
interface MenuTry {
  key: string;
  /** Failed pushes of this fingerprint so far. */
  attempts: number;
  /** Unix seconds before which it is not tried again. */
  nextAt: number;
  /** Its failure has been logged. */
  warned: boolean;
  /** Chats Telegram says it has no chat with. Retrying cannot change that. */
  gone: Set<number>;
}

const freshMenuTry = (key = ""): MenuTry => ({ key, attempts: 0, nextAt: 0, warned: false, gone: new Set() });

/** Escape a name so it can sit inside a RegExp. */
function escapeRe(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, (m) => `\\${m}`);
}

/**
 * The opener this deployment's agent used to recite, matched by ITS name.
 *
 * Rebuilt per call rather than cached: `getName()` follows the owner's
 * settings, so a rename must not leave the scrub hunting the old identity.
 */
function soulHeaderRe(): RegExp {
  return new RegExp(`^\\s*${escapeRe(getName())}\\s+here\\s*[\u2014-]\\s*born\\b[^.!?\\n]*[.!?\\n]\\s*`, "i");
}

/** Start the poll loop. Returns a stop() handle. */
export function startTelegram(deps: TelegramServiceDeps): { stop: () => void } {
  let stopped = false;
  /** Fingerprint (token + allowlist) whose "/" command menus are live — avoids
   * re-setting every poll and re-pushes when /link grows the allowlist. */
  let commandsRegisteredKey = "";
  /** How pushing the fingerprint that is NOT yet live is going. */
  let menuTry = freshMenuTry();
  const stateRef = deps.stateRef;
  /**
   * The polling outage in progress, if any: when it began, how many polls in a
   * row have failed (the backoff exponent), and which kinds of failure have
   * been logged. Only a logged outage gets a recovery line.
   */
  let outage: { since: number; streak: number; told: Set<string> } | null = null;
  /** When a 409 was last logged, unix seconds. */
  let conflictToldAt: number | null = null;
  /** Polls in a row that threw, as opposed to failing cleanly. */
  let crashStreak = 0;
  /** The token the loop last polled with. In memory only: telegram.json never holds a token. */
  let boundToken: string | null = null;
  /**
   * `${chatId}:${kind}` for each reply holdEarly has already given since the
   * last change of bot, so a day of waiting messages gets one answer per chat,
   * not one per message.
   */
  const earlyTold = new Set<string>();
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  ensureSoul(now()); // the merryman is born (IDENTITY/OWNER/JOURNAL.md) on first run
  /**
   * Refusals, failed /link codes and undelivered replies, counted for the
   * fleet's log (poll-rules.ts makeChatTally). NEVER ON `deps.note`: that is
   * the owner's event feed, and almost all of this is what a stranger did.
   * One `/link x` from anyone who knows the bot's name would otherwise be the
   * newest warning on the owner's screen, over whatever real one was there.
   */
  const tally = deps.tally ?? makeChatTally(telegramLog, now);
  /**
   * EVERY REPLY GOES THROUGH HERE, so one Telegram would not take is logged
   * rather than dropped. Every call site below ignored the answer: a blocked
   * bot, a chat that no longer exists or a reply Telegram refused as too long
   * looked, from here, exactly like a reply that arrived.
   */
  const sendMessage: typeof sendTelegramMessage = async (opts, chatId, text, extra) => {
    const r = await sendTelegramMessage(opts, chatId, text, extra);
    if (!r.ok) tally.sendFailed(chatId, r.reason);
    return r;
  };

  // Per-chat runtime (in-memory only — cleared on restart, which is safe):
  // Keyed by `${chatId}:${fromId}` — a parked action is bound to the USER who
  // parked it, so in a group one member can't /confirm another's transfer/shell.
  const pending = new Map<string, PendingAction>(); // awaiting /confirm
  /**
   * The buttons under each parked question: which nonce they carry and WHICH
   * parked action they answer. A press is honoured only when both still match
   * — so an old button cannot confirm whatever was parked after it (the slot
   * holds one action, and /confirm runs whatever is in it).
   */
  const pendingMeta = new Map<string, { nonce: string; action: PendingAction; messageId?: number }>();
  /**
   * Senders whose LAST reply from the bot was a settings question. Only then
   * does a typed "yes" answer it: "ok" said about something else, minutes
   * later, must not confirm a change the owner has moved on from. The buttons
   * and /confirm keep working until the question expires.
   */
  const typedAnswerable = new Set<string>();
  /**
   * The setting the bot just asked a value for ("stop loss is off right now.
   * What should it be?"), so a bare "8%" or "20" answers it instead of being
   * read as a trade with no ticker.
   */
  const awaitingValue = new Map<string, { key: string; expiresAt: number }>();
  const linkFails: LinkFails = new Map();
  /**
   * When this process started listening to the current bot: the moment the
   * first getUpdates that worked was sent, unix seconds. Null until then, and
   * again after a change of bot or while Telegram is switched off; moved on
   * after a silence of REARM_AFTER_SEC or more. Anything dated before it
   * waited out a silence, and pollOnce holds it back.
   */
  let armedAt: number | null = null;
  /**
   * The bot this process has had a good poll of. Until it has, a poll from
   * no saved offset (0: a first start, or a home a redeploy wiped) is handed
   * everything Telegram still holds, which may include the last batch a
   * process before this one handled: Telegram had not been told it was done
   * (staleSummaryText). Once one such poll has come back, whatever was
   * pending before it has been handed over, and no later batch can hold it.
   */
  let polledBot: string | null = null;
  /**
   * When this process stopped hearing the bot, unix seconds: the first poll
   * since the last good one that failed or threw. Null while polls work. Not
   * cleared by a change of token, so the 401s before a renewed secret count.
   */
  let deafSince: number | null = null;
  /**
   * Reads in a row that found Telegram switched off. One alone may be
   * settings.json caught half-written by the orchestrator's rewrite, which
   * reads as the defaults, with Telegram off.
   */
  let offReads = 0;
  /** Whether what a hold process kept about groups has been taken (replayHeldGroups). Once per process. */
  let heldGroupsTaken = false;
  const history = new Map<number, { role: "user" | "assistant"; content: string }[]>();
  // Memory ids surfaced on the previous turn, per chat. A follow-up like "is it
  // done?" shares no words with anything on disk, so without carrying the last
  // turn's ids forward the thread is lost the moment the topic isn't restated.
  const stickyIds = new Map<number, Set<string>>();
  /**
   * THERE IS NO BARE-AMOUNT TRADE CONTEXT HERE, AND THAT IS DELIBERATE.
   *
   * The change this file came from carried one: a chat-keyed map that let a
   * message consisting of nothing but "5" become a live buy. It was primed by
   * REGEX-MATCHING THE BOT'S OWN OUTBOUND PROSE, took its ticker from the first
   * one-to-six-letter word of an earlier message, resolved the side with
   * `/sell/.test() ? "sell" : "buy"` — so "should I sell before I buy more?"
   * primes a sell — and then called `deps.trade` with no confirmation step at
   * all, while the sibling `transfer` case parks and waits for `/confirm`.
   * It had no expiry and was keyed by chat rather than by sender.
   *
   * The problem it was solving is real and is solved below without any of that:
   * a bare number must not reach the classifier, because a reasoning model
   * spends its whole budget dumping chain-of-thought at it. A deterministic
   * nudge costs no tokens and states no trade.
   *
   * If a ticker+amount follow-up is wanted, it belongs in its own change: park
   * it through `deps.setPending` with `CONFIRM_TTL_SEC`, key it by
   * `msg.fromId`, re-display side, symbol and amount on the confirm, and carry
   * them from the `Command` the classifier actually emitted — never re-derive
   * a ticker or a direction from prose.
   */
  // One detached /agent task per chat; /agent stop flips the flag mid-run.
  const agentRuns = new Map<number, { stopped: boolean }>();

  /**
   * WHO THE BOT IS, from getMe: its id (a reply to one of its messages is a
   * reply to this id), its username (whether "/cmd@name" and "@name" mean it)
   * and whether privacy mode is off. Read at start, again when the token
   * changes, and every half hour — the owner can flip privacy mode in
   * BotFather at any time. Bound to the token it was read with, so a new
   * token never borrows the old bot's identity.
   */
  let botSelf: { token: string; bot: TgBotInfo; at: number } | null = null;
  /** What the poll has delivered since the last heartbeat (POLL_HEARTBEAT_MS). */
  let pollCounts = { since: Date.now(), group: 0, groupLate: 0, dm: 0, buttons: 0, members: 0, service: 0 };
  let selfReading: Promise<void> | null = null;
  const refreshSelf = (token: string): Promise<void> => {
    if (selfReading) return selfReading;
    selfReading = getMe({ token })
      .then((r) => {
        if (r.bot) botSelf = { token, bot: r.bot, at: Date.now() };
      })
      .catch(() => {
        /* the next poll tries again */
      })
      .finally(() => {
        selfReading = null;
      });
    return selfReading;
  };
  const selfFor = (cfg: ResolvedConfig): TgBotInfo | null =>
    botSelf && cfg.telegramBotToken && botSelf.token === cfg.telegramBotToken ? botSelf.bot : null;

  /**
   * The settings as the group handler reads them: fresh, but at most once a
   * second. It reads them several times per group line, and every read here
   * is a settings file parse; a busy group would otherwise mean dozens a
   * second. A second is short enough that a /link or a dashboard switch
   * still applies at once.
   */
  let groupCfgMemo: { at: number; cfg: ResolvedConfig } | null = null;
  const groupCfg = (): ResolvedConfig => {
    const t = Date.now();
    if (!groupCfgMemo || t - groupCfgMemo.at >= 1000 || t < groupCfgMemo.at) groupCfgMemo = { at: t, cfg: deps.getCfg() };
    return groupCfgMemo.cfg;
  };

  /**
   * TELEGRAM GROUPS (docs/tg-groups.md), created once, and only when the child
   * handed over the durable store. Without it the bot is silent in groups:
   * slash commands keep their rules (handleGroupCommand), and nothing else is
   * answered.
   */
  const tgGroups: TgGroups | null = deps.tgGroupsStore
    ? createTgGroups({
        opts: () => {
          const token = groupCfg().telegramBotToken;
          return token ? { token } : null;
        },
        store: deps.tgGroupsStore,
        getCfg: groupCfg,
        stateRef,
        port: () => deps.tgCoins ?? null,
        facts: () => deps.tgFacts ?? null,
        self: () => {
          const bot = selfFor(groupCfg());
          // The bot's display name (getMe's first_name) is what members see on
          // its lines, so it is a name they call it by too ("pine bot, thoughts?").
          return bot
            ? { id: bot.id, username: bot.username, name: getName(), ...(bot.firstName ? { aliases: [bot.firstName] } : {}) }
            : null;
        },
        privacyOff: () => {
          const bot = selfFor(groupCfg());
          return typeof bot?.canReadAllGroupMessages === "boolean" ? bot.canReadAllGroupMessages : null;
        },
        note: deps.note,
        dashboardBase,
        // The agent's own id seeds its typing style; before it is armed, the
        // bot's id (one bot per agent) keeps the style stable meanwhile.
        agentKey: () => {
          const id = deps.buildStatusContext().agentId;
          if (id) return id;
          const bot = botSelf?.bot;
          return bot ? `bot:${bot.id}` : getName();
        },
        hosted: isHostedMode(),
        ...(deps.tgGroupsTest ?? {}),
      })
    : null;

  /**
   * The in-memory map is now a CACHE over the sqlite log, not the source of
   * truth. First touch of a chat after a restart pulls the conversation back
   * from disk — before this, every restart silently wiped the thread and the
   * merryman greeted a mid-conversation owner like a stranger.
   */
  const historyFor = async (chatId: number): Promise<{ role: "user" | "assistant"; content: string }[]> => {
    let h = history.get(chatId);
    if (!h) {
      h = (await recentChatTurns(chatId, HISTORY_TURNS * 2)).map((t) => {
        let c = t.role === "assistant" ? stripThinkingBlock(t.content) : t.content;
        // SCRUB THE OLD SOUL HEADER OUT OF STORED HISTORY.
        //
        // Before identity moved into the system prompt, every reply opened by
        // reciting it — "<name> here — born 2026-…". Those turns are on disk,
        // and a few-shot prompt built from them teaches the new model to recite
        // it again, so the fix would undo itself one conversation at a time.
        //
        // BUILT FROM THE AGENT'S OWN NAME, not a literal. It was hardcoded to
        // one tenant's, so on every other deployment it scrubbed nothing while
        // claiming to.
        if (t.role === "assistant") c = c.replace(soulHeaderRe(), "").trim();
        // NO `|| t.content` TAIL. A turn that was ENTIRELY the old header
        // scrubs to nothing, and restoring it whole is the one case the scrub
        // exists for. Empty turns are dropped just below.
        return { role: t.role, content: c };
      }).filter((t) => t.content.length > 0);
      history.set(chatId, h);
      // Restore the last turn's recalled ids too, so a pronoun sent right after
      // a restart still lands on whatever the merryman was just talking about.
      const lastWithIds = [...(await recentChatTurns(chatId, 4))].reverse().find((t) => t.memoryIds?.length);
      if (lastWithIds?.memoryIds?.length) stickyIds.set(chatId, new Set(lastWithIds.memoryIds));
    }
    return h;
  };

  const pushHistory = async (
    chatId: number,
    role: "user" | "assistant",
    content: string,
    memoryIds?: string[],
  ): Promise<void> => {
    const trimmed = content.slice(0, 600);
    const h = await historyFor(chatId);
    h.push({ role, content: trimmed });
    while (h.length > HISTORY_TURNS * 2) h.shift();
    history.set(chatId, h);
    await appendChatTurn(chatId, { role, content: trimmed, memoryIds }); // write-through
  };

  /**
   * How a trade list reaches coin names: the owner's own added tokens, their
   * account and vaults (which are never a coin, and which a receipt is netted
   * over), and the chain for whatever the local ledger cannot name.
   */
  const tradeLookup = (cfg: ResolvedConfig): TradeViewOpts => {
    const grant = loadGrantFile();
    const agentId = deps.buildStatusContext().agentId ?? grant?.smartAccount ?? null;
    return {
      customTokens: cfg.customTokens,
      book: agentId ? bookAddresses(grant, agentId) : undefined,
      client: mainnetClient(),
    };
  };

  /** What the answer loop's lookups read: this owner's agent, settings, permission and chain. */
  const toolContext = (cfg: ResolvedConfig): ToolContext => {
    const grant = loadGrantFile();
    const status = deps.buildStatusContext();
    const agentId = status.agentId ?? grant?.smartAccount ?? null;
    return {
      status,
      cfg,
      paused: isPaused(),
      grant,
      book: agentId ? bookAddresses(grant, agentId) : [],
      client: mainnetClient(),
      now: now(),
    };
  };

  /**
   * The capabilities one chat message may use, bound to WHO sent it.
   *
   * A factory rather than an object built inside `handle`, because a button
   * press needs exactly the same capabilities — bound to the presser — and a
   * second copy of this object would drift from the first on the next change.
   */
  const makeCmdDeps = (
    msg: Pick<TgMessage, "chatId" | "fromId" | "fromUsername">,
    cfg: ResolvedConfig,
    token: string,
    extras: ReplyExtras,
  ): CommandDeps => {
    // The decision lives in link.ts, so a process that answers the bot while
    // trading is held links a chat exactly as this one does. What a link means
    // HERE is handed in: the allowlist in settings.json, the owner's handle
    // remembered, and a line in the event feed.
    const linkDep = (code: string): { ok: boolean; reason?: string } => {
      const outcome = tryLink(
        {
          stateRef,
          fails: linkFails,
          now,
          allow: (chatId) => {
            const next = new Set(cfg.telegramAllowlist);
            next.add(chatId);
            patchSettingsFile({ telegramAllowlist: [...next] });
          },
          onLinked: (who) => {
            if (who.fromUsername) rememberOwnerFact(`Their Telegram handle is @${who.fromUsername}.`, now());
            deps.note("ok", `Telegram: linked chat ${who.chatId}${who.fromUsername ? ` (@${who.fromUsername})` : ""}`);
          },
        },
        msg,
        code,
      );
      tallyFailedLink(tally, linkFails, msg.chatId, outcome);
      return linkReply(outcome, now());
    };

    const statusCtx = () => deps.buildStatusContext();
    const cmdDeps: CommandDeps = {
      controlEnabled: cfg.telegramControlEnabled,
      hosted: isHostedMode(),
      maxActionUsdg: cfg.telegramMaxActionUsdg,
      grantPerTradeUsdg: deps.grantPerTradeUsdg(),
      transferEnabled: cfg.telegramTransferEnabled,
      grantHasTransfer: deps.grantHasTransfer(),
      reads: {
        status: () => readStatus(statusCtx()),
        positions: () => readPositions(statusCtx().agentId),
        depth: (symbol: string) => deps.readDepth(symbol),
        pnl: () => readPnl(statusCtx().agentId),
        // Names from the ledger first, then the chain — including the coin in a
        // row re-recorded after a restart, which only its receipt still knows.
        trades: () => readTrades(statusCtx().agentId, tradeLookup(cfg)),
        report: () => readReport(statusCtx()),
        brag: () => readBrag(statusCtx()),
        // NEVER WIRED, SO NEVER CALLED. `readWallet` has existed and been
        // correct the whole time; executor.ts:147 reads
        // `deps.reads.wallet ? … : WALLET_TEXT`, and with this key absent every
        // one of /wallet, /fund, /grant, /recover, /restore and /reconnect fell
        // through to the static signpost — which tells the reader to open
        // http://localhost:3100 "on the machine running merrymen". On the
        // hosted fleet there is no such machine, so the instruction cannot be
        // followed at all, and "fund your agent" is the commonest thing anyone
        // is ever told to do.
        wallet: () => readWallet(statusCtx().agentId),
        why: async () => {
          const ev = readWhyEvidence(statusCtx().agentId);
          const llm = resolveLlm(cfg);
          if (!ev.hasTrade || !llm) return ev.text;
          // Model text, sent as HTML: escaped, or a "<" in it (or in a
          // decision's reason it quotes) makes Telegram refuse the message.
          // Addresses redacted: the evidence quotes event lines (reads.ts).
          const plain = redactAddresses(
            ev.text.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"),
          );
          return escModel(await narrateWhy(plain, llm));
        },
        settings: () => settingsListText(cfg as unknown as Record<string, unknown>),
      },
      // ── settings by text: ask first, change on confirm ────────────────────
      proposeSetting: (setting, value) => {
        const p = proposeSettingChange(setting, value, {
          current: cfg as unknown as Record<string, unknown>,
          allowedSymbols: [...stockSymbols(), ...cfg.customTokens.map((t) => t.symbol.toUpperCase())],
          strategies: [...BUILTIN_STRATEGIES],
          hosted: isHostedMode(),
          signedPerTradeUsdg: deps.grantPerTradeUsdg(),
          agentName: getName(),
        });
        if (p.kind === "reply") {
          if (p.button === "sign") extras.keyboard = signKeyboard(signUrl(dashboardBase(), "expiring"));
          if (p.button === "dashboard") extras.keyboard = [[{ text: "⚙️ Open Settings", url: `${dashboardBase()}/settings${p.anchor ? `#${p.anchor}` : ""}` }]];
          if (p.awaitKey) awaitingValue.set(`${msg.chatId}:${msg.fromId}`, { key: p.awaitKey, expiresAt: now() + SETTING_CONFIRM_TTL_SEC });
          return p.text;
        }
        pending.set(`${msg.chatId}:${msg.fromId}`, {
          kind: "setting",
          key: p.key,
          value: p.value,
          expiresAt: now() + SETTING_CONFIRM_TTL_SEC,
        });
        return p.text;
      },
      applySetting: (key, value) => {
        // Checked again here, not only when asked: the value sat in memory for
        // up to ten minutes and the rules for it are one table away.
        const spec = specFor(key);
        if (!spec || !validStoredSetting(key, value)) return "that change is no longer valid — nothing changed. Ask me again.";
        if (key === "strategy") {
          const r = deps.setStrategy(value as string);
          if (!r.ok) return `can't switch strategy: ${esc(r.reason ?? "unknown")} — nothing changed.`;
        }
        // BOTH FILES, for the reason /strategy and /cap explain below.
        patchSettingsFile({ [key]: value } as never);
        rememberChatSetting(stateRef, { [key]: value }, now());
        deps.note("ok", `Telegram: ${key} → ${JSON.stringify(value)} (confirmed in chat ${msg.chatId})`);
        return appliedText(key, value, isHostedMode());
      },
      /**
       * BOTH FILES, FOR THE REASON /link ALREADY LEARNED.
       *
       * `patchSettingsFile` writes the child's settings.json, which the
       * orchestrator replaces wholesale from the tenant store every fifteen
       * seconds — so hosted, this reply was true for fifteen seconds and then
       * silently false. `rememberChatSetting` writes the child-owned telegram
       * state, which nothing above overwrites and which the parent promotes
       * into the stored settings. The settings.json write stays because it is
       * what makes the change take effect on the NEXT TICK rather than on the
       * next reconcile, and self-hosted it is the whole mechanism.
       */
      setStrategy: (name) => {
        const r = deps.setStrategy(name);
        if (r.ok) {
          patchSettingsFile({ strategy: name });
          rememberChatSetting(stateRef, { strategy: name }, now());
          deps.note("ok", `Telegram: strategy → ${name}`);
        }
        return r;
      },
      setCap: (usdg) => {
        patchSettingsFile({ telegramMaxActionUsdg: usdg });
        rememberChatSetting(stateRef, { telegramMaxActionUsdg: usdg }, now());
        deps.note("ok", `Telegram: chat cap → ${usdg} USDG`);
      },
      setPaused: (paused) => {
        setPaused(paused);
        deps.note("warn", `Telegram: ${paused ? "paused" : "resumed"} by chat ${msg.chatId}`);
      },
      kill: () => {
        const r = deps.kill();
        if (r.ok) deps.note("warn", `Telegram: KILL by chat ${msg.chatId}`);
        // Refused on purpose, and still worth a record of who asked.
        else if (r.archiveFailed) deps.note("warn", `Telegram: KILL by chat ${msg.chatId} kept the grant (${r.archiveFailed.why}) and paused instead`);
        return r;
      },
      link: linkDep,
      trade: deps.submitTrade,
      transfer: async (to, usdg) => {
        deps.note("warn", `Telegram: transfer ${usdg} USDG → ${to} confirmed by chat ${msg.chatId}`);
        return deps.submitTransfer(to, usdg);
      },
      getPending: () => pending.get(`${msg.chatId}:${msg.fromId}`) ?? null,
      setPending: (p) => pending.set(`${msg.chatId}:${msg.fromId}`, p),
      clearPending: () => pending.delete(`${msg.chatId}:${msg.fromId}`),
      addAlert: (symbol, op, price) => {
        const st = stateRef.get();
        if (st.priceAlerts.length >= 20) return "you're at the 20-alert limit — /unalert one first.";
        const id = st.priceAlerts.reduce((m, a) => Math.max(m, a.id), 0) + 1;
        stateRef.set({ ...st, priceAlerts: [...st.priceAlerts, { id, symbol: symbol.toUpperCase(), op, price }] });
        return `🔔 alert #${id} set — I'll ping you when ${esc(symbol.toUpperCase())} goes ${op === ">" ? "above" : "below"} ${price}. (fires once; needs the worker running)`;
      },
      listAlerts: () => {
        const st = stateRef.get();
        if (!st.priceAlerts.length) return "no price alerts set. Try: /alert QQQ &gt; 600";
        return ["🔔 <b>price alerts</b>", ...st.priceAlerts.map((a) => `#${a.id} — ${esc(a.symbol)} ${a.op === ">" ? "&gt;" : "&lt;"} ${a.price}`)].join("\n");
      },
      removeAlert: (id) => {
        const st = stateRef.get();
        const next = st.priceAlerts.filter((a) => a.id !== id);
        if (next.length === st.priceAlerts.length) return `no alert #${id}. /alerts lists them.`;
        stateRef.set({ ...st, priceAlerts: next });
        return `🔕 alert #${id} removed.`;
      },
      /**
       * A RENAME FROM CHAT LASTED ONE TICK.
       *
       * `setSoulName` rewrites the identity file, and index.ts:5220 rewrites
       * that file back from `cfg.agentName` on every tick it differs — a
       * reconciliation that exists so the dashboard's name wins, and which
       * therefore undid a chat rename before the owner finished reading the
       * confirmation. Worse than /strategy and /cap, which at least lasted
       * the fifteen seconds until the next reconcile.
       *
       * So the settings copy moves too: `patchSettingsFile` stops this tick
       * from reverting it, and `rememberChatSetting` is what survives the
       * orchestrator replacing that file wholesale.
       *
       * `r.name` and not `name` — the NORMALISED form setName returned. The
       * web tier stores soul-form for exactly this reason (both take the rule
       * and the NFC-plus-collapse from packages/core/src/agent-name.ts), and storing the raw
       * input would leave cfg.agentName !== getName() true for ever, which
       * is the every-tick rewrite this fix exists to stop.
       */
      setName: (name) => {
        const r = setSoulName(name);
        if (r.ok) {
          patchSettingsFile({ agentName: r.name });
          rememberChatSetting(stateRef, { agentName: r.name }, now());
          deps.onNameChange?.(r.name);
          deps.note("ok", `Telegram: the merryman is now called ${r.name}`);
        }
        return r;
      },
      remember: (fact) => rememberOwnerFact(fact, now()),
      soulInfo: () => {
        const st = stateRef.get();
        const rel = relationship(st.linkedAt, st.messageCount, now());
        const facts = ownerFacts();
        return [
          `🌳 <b>${esc(getName())}</b> of the merrymen`,
          `• ${ageDays(now())} days old · born ${getBornDate()} · ${rel.stage}`,
          `• ${rel.daysTogether} day(s) riding with you · ${rel.messageCount} messages shared`,
          facts.length
            ? `• what I know about you:\n${facts.slice(-8).map((f) => `  ${esc(f.replace(/^- /, "· "))}`).join("\n")}`
            : `• I don't know much about you yet — tell me things, or /remember them for me`,
          ``,
          `my soul lives in ~/.merrymen/soul/ — read it, edit it, it's yours. /name renames me · /forget wipes what I know.`,
        ].join("\n");
      },
      // /forget must now clear the CONVERSATION too, not just OWNER.md —
      // turns persist to disk since chat_turns, so wiping only the facts while
      // the transcript survived would make the reply ("I've let go of what I
      // knew about you") untrue.
      forgetOwner: () => {
        forgetOwner();
        void clearChatTurns(msg.chatId); // fire-and-forget; the in-memory wipe below is immediate
        history.delete(msg.chatId);
        stickyIds.delete(msg.chatId);
      },
      // ── PC control ─────────────────────────────────────────────────────
      pcControlEnabled: cfg.telegramPcControlEnabled,
      capabilities: new Set(cfg.telegramCapabilities),
      filesRoot: cfg.telegramFilesRoot,
      shellAllowlist: cfg.telegramShellAllowlist,
      pc: makePcActions(
        { token },
        msg.chatId,
        {
          filesRoot: cfg.telegramFilesRoot,
          shellAllowlist: cfg.telegramShellAllowlist,
          appAllowlist: cfg.telegramAppAllowlist,
          anthropicApiKey: cfg.anthropicApiKey,
          llmModel: cfg.llmModel,
        },
        deps.note,
      ),
      pcStatus: () => {
        const on = cfg.telegramPcControlEnabled;
        const caps = new Set(cfg.telegramCapabilities);
        const rows = PC_CAPABILITIES.map((c) => `${caps.has(c) ? "✅" : "▫️"} ${c}`).join("  ");
        return [
          `🖥️ <b>remote control</b> — master ${on ? "ON" : "OFF"}`,
          rows,
          on
            ? `enabled: ${[...caps].join(", ") || "(none — turn some on in the dashboard)"}`
            : `turn it on in the dashboard → settings → remote control.`,
          `shell + type + files + power always ask for /confirm first.`,
        ].join("\n");
      },
      addReminder: (when, text) => {
        const sec = parseWhenSec(when);
        if (sec === null) return "when? e.g. /remind 20m stretch (s/m/h/d).";
        const st = stateRef.get();
        if (st.reminders.length >= 20) return "you're at the 20-reminder limit — /unremind one first.";
        const id = st.nextId;
        stateRef.set({
          ...st,
          nextId: id + 1,
          reminders: [...st.reminders, { id, fireAt: now() + sec, text: text.slice(0, 300) }],
        });
        return `⏰ reminder #${id} set — I'll ping you in ${when}. (needs the worker running)`;
      },
      listReminders: () => fmtReminders(stateRef.get().reminders, now()),
      removeReminder: (id) => {
        const st = stateRef.get();
        const next = st.reminders.filter((r) => r.id !== id);
        if (next.length === st.reminders.length) return `no reminder #${id}. /reminders lists them.`;
        stateRef.set({ ...st, reminders: next });
        return `🗑️ reminder #${id} removed.`;
      },
      addWatcher: (spec) => {
        const parsed = parseWatchSpec(spec);
        if (!parsed) return "watch what? e.g. cpu>80, file &lt;path&gt;, proc &lt;name&gt;";
        if (parsed.kind === "file") {
          const res = resolveInRoot(cfg.telegramFilesRoot, parsed.arg);
          if (!res.ok) return `🔒 ${esc(res.reason)}`;
        }
        const st = stateRef.get();
        if (st.watchers.length >= 20) return "you're at the 20-watcher limit — /unwatch one first.";
        const id = st.nextId;
        stateRef.set({
          ...st,
          nextId: id + 1,
          watchers: [...st.watchers, { id, kind: parsed.kind, arg: parsed.kind === "cpu" ? "" : parsed.arg, threshold: parsed.kind === "cpu" ? parsed.threshold : undefined }],
        });
        return `👀 watcher #${id} set. (needs the worker running)`;
      },
      listWatchers: () => fmtWatchers(stateRef.get().watchers),
      removeWatcher: (id) => {
        const st = stateRef.get();
        const next = st.watchers.filter((w) => w.id !== id);
        if (next.length === st.watchers.length) return `no watcher #${id}. /watchers lists them.`;
        stateRef.set({ ...st, watchers: next });
        return `🗑️ watcher #${id} removed.`;
      },
      help: () => HELP_TEXT,
      now,
    };
    return cmdDeps;
  };

  /**
   * `onSent`, when given, hears whether each message this call sends reached the
   * chat. Only a command forwarded from a group passes it: the room is told
   * "sent it to your DMs" only when something actually arrived there (a person
   * who never opened a DM with the bot cannot be written to first). A DM is
   * answered exactly as before either way.
   */
  const handle = async (msg: TgMessage, cfg: ResolvedConfig, onSent?: (ok: boolean) => void): Promise<void> => {
    const token = cfg.telegramBotToken!;
    const say = async (text: string, extra?: SendExtra): Promise<SendResult> => {
      const r = await sendMessage({ token }, msg.chatId, text, extra);
      onSent?.(r.ok);
      return r;
    };
    const allowed = cfg.telegramAllowlist.includes(msg.chatId) || cfg.telegramAllowlist.includes(msg.fromId);

    // Voice note → text: only for allowlisted chats with the "voice" capability.
    // Transcribed text then flows through the SAME path as a typed message.
    if (msg.voiceFileId && !msg.text) {
      if (!allowed) {
        tally.refused(msg.chatId);
        await say(refusalText(msg.chatId));
        return;
      }
      if (!cfg.telegramPcControlEnabled || !cfg.telegramCapabilities.includes("voice")) {
        await say("🎙️ voice is off — enable “remote control” + the voice capability in the dashboard.");
        return;
      }
      if (!cfg.telegramTranscribeKey) {
        await say("🎙️ add a transcription key (OpenAI-compatible) in the dashboard to talk to me by voice.");
        return;
      }
      const { url } = await getFileUrl({ token }, msg.voiceFileId);
      const t = url
        ? await transcribeVoice(url, { key: cfg.telegramTranscribeKey, base: cfg.telegramTranscribeBase })
        : { text: null as string | null, reason: "couldn't fetch the voice file" };
      if (!t.text) {
        await say(`🎙️ couldn't transcribe that: ${esc(t.reason ?? "unknown")}`);
        return;
      }
      msg = { ...msg, text: t.text };
      await say(`🎙️ <i>heard:</i> ${esc(t.text)}`);
    }

    let slash = parseSlash(msg.text);

    // /link is the only command an unlisted chat may use — and it's rate-limited.
    if (!allowed) {
      // A deep link (t.me/<bot>?start=<code>) arrives as /start <code>. The
      // same code as /link, so the same path: compared, counted and locked
      // out exactly as a typed /link is, or the button would be a way round
      // the lockout.
      if (slash?.kind === "start") slash = { kind: "link", code: slash.payload };
      if (slash?.kind !== "link") {
        // A bare /start or /help is how anyone meets the bot, so it gets the
        // way in rather than a refusal.
        tally.refused(msg.chatId);
        await say(slash?.kind === "help" ? onboardingText(msg.chatId) : refusalText(msg.chatId));
        return;
      }
    }

    // Launch a detached agent task (from /agent OR natural language). Streams its
    // own progress; returns immediately so the poll (and /agent stop) keep flowing.
    // Every gate is checked here, so both entry points are equally locked down.
    const startAgent = async (task: string): Promise<void> => {
      if (!task.trim()) {
        await say("what would you like me to do? Describe the task, e.g. “clone github.com/x/y, install, build, and tell me what breaks”.");
        return;
      }
      if (!cfg.telegramPcControlEnabled || !cfg.telegramAgentEnabled) {
        await say(
          isHostedMode()
            ? "I can't work on your computer — I live on the merrymen servers. Ask me anything about your trades, coins or settings and I'll look it up."
            : "I can only work on your computer when PC control and agent mode are switched on in Settings. Ask me anything about your trades, coins or settings and I'll look it up.",
        );
        return;
      }
      const llm = resolveLlm(cfg);
      if (!llm) {
        await say("🤖 agent mode needs an AI provider — pick one in the dashboard (Settings → AI provider).");
        return;
      }
      if (agentRuns.has(msg.chatId)) {
        await say("⏳ I'm already on a task here — say “stop” (or /agent stop) first, or wait for it to finish.");
        return;
      }
      const st = stateRef.get();
      const soulBlock = soulPromptBlock(st.linkedAt, st.messageCount, now());
      // Live secret VALUES to strip from every tool output and block from
      // send_file — however the agent reads them, they never reach chat.
      const grant = loadGrantFile();
      const secrets = [
        cfg.telegramBotToken,
        cfg.anthropicApiKey,
        cfg.groqApiKey,
        cfg.llmApiKey,
        cfg.bundlerApiKey,
        cfg.rialtoApiKey,
        cfg.telegramTranscribeKey,
        cfg.virtualsApiKey,
        // The signed wallet grant custodies funds. Its 0x owner/session keys already
        // match the shape-redactor, but the base64 `serialized` session-account blob
        // does NOT — list all three explicitly so no tool output can exfiltrate them.
        grant?.serialized,
        grant?.demoOwnerPrivateKey,
        grant?.demoSessionPrivateKey,
      ].filter((s): s is string => typeof s === "string" && s.length >= 8);
      const stopFlag = { stopped: false };
      agentRuns.set(msg.chatId, stopFlag);
      await say("🏹 on it — I'll message progress here. Say “stop” to halt me.");
      void runAgentTask(task, {
        creds: llm,
        cfg: {
          capabilities: new Set(cfg.telegramCapabilities),
          filesRoot: cfg.telegramFilesRoot,
          shellAllowlist: cfg.telegramShellAllowlist,
          appAllowlist: cfg.telegramAppAllowlist,
          autoShell: cfg.telegramAgentAutoShell,
          maxSteps: cfg.telegramAgentMaxSteps,
          anthropicApiKey: cfg.anthropicApiKey,
          llmModel: cfg.llmModel,
          secrets,
        },
        opts: { token },
        chatId: msg.chatId,
        // Model text is HTML-escaped here — it must never inject parse-mode markup.
        send: async (text) => {
          await sendMessage({ token }, msg.chatId, escModel(text));
        },
        note: deps.note,
        remember: (n) => rememberNote(n, now()),
        soulBlock,
        stopFlag,
      }).finally(() => agentRuns.delete(msg.chatId));
    };

    // ── /agent — explicit slash entry (also handles /agent stop) ─────────────
    // Handled before the interpreter: the loop streams its own messages and must
    // not block the poll (or a stop could never land). Natural-language agent
    // tasks route through the SAME startAgent below, after interpretation.
    const agentMatch = msg.text?.match(/^\/agent(?:@\w+)?(?:\s+([\s\S]+))?$/i);
    if (agentMatch) {
      // Same sender-level rule as other state-changing commands: in a group,
      // only individually-allowlisted users may drive the PC.
      if (msg.chatId !== msg.fromId && !cfg.telegramAllowlist.includes(msg.fromId)) {
        await say("🚫 in a group, only individually-allowlisted users can run /agent.");
        return;
      }
      const arg = (agentMatch[1] ?? "").trim();
      if (/^stop$/i.test(arg)) {
        const running = agentRuns.get(msg.chatId);
        if (running) {
          running.stopped = true;
          await say("🛑 stopping after the current step…");
        } else {
          await say("nothing running.");
        }
        return;
      }
      if (!arg) {
        await say("what's the task? e.g. <code>/agent clone github.com/x/y, install deps, build, and tell me what breaks</code> — or just say it in plain English. <code>/agent stop</code> halts.");
        return;
      }
      await startAgent(arg);
      return;
    }

    // "stop" / "halt" while a task is running → stop it (natural-language stop).
    if (agentRuns.has(msg.chatId) && /^\s*(stop|halt|cancel|abort)\b/i.test(msg.text ?? "")) {
      if (msg.chatId === msg.fromId || cfg.telegramAllowlist.includes(msg.fromId)) {
        agentRuns.get(msg.chatId)!.stopped = true;
        await say("🛑 stopping after the current step…");
        return;
      }
    }

    const statusCtx = () => deps.buildStatusContext();
    // Filled by a command that wants buttons under its reply (a "Sign now" link,
    // a Settings link). Confirm buttons for a parked action are added below.
    const extras: ReplyExtras = {};
    const cmdDeps = makeCmdDeps(msg, cfg, token, extras);

    // Only the OWNER shapes the soul — both relationship growth AND persistent
    // memory. In a GROUP, `allowed` is true for every member, so without this gate
    // an ordinary member could deepen the bond or (below) write/evict the owner's
    // remembered facts. Private chats have chatId === fromId, so this is a no-op there.
    const isOwnerMsg = msg.fromId === stateRef.get().ownerId || msg.chatId === stateRef.get().ownerId;
    if (isOwnerMsg) {
      stateRef.set({ ...stateRef.get(), messageCount: stateRef.get().messageCount + 1 });
    }

    // Slash command wins; else natural language (LLM) if a key is set; else nudge.
    let cmd = slash;
    // What the narrator recalled this turn — stored on the assistant's reply so
    // the thread survives a restart, not just a process lifetime.
    let turnMemoryIds: string[] | undefined;
    // Conversation state from the bot's LAST reply is used up by this message,
    // whatever it is — a later "yes" or "20" can only answer the reply right
    // before it.
    const senderKey = `${msg.chatId}:${msg.fromId}`;
    const answerableNow = typedAnswerable.has(senderKey);
    typedAnswerable.delete(senderKey);
    const awaited = awaitingValue.get(senderKey);
    awaitingValue.delete(senderKey);
    if (!cmd && awaited && awaited.expiresAt > now()) {
      // THE ANSWER TO "WHAT SHOULD IT BE?" — a short reply only; anything
      // longer is a new message and goes through the classifier as usual.
      const t = msg.text.trim();
      if (t.length > 0 && t.length <= 40 && !t.startsWith("/")) cmd = { kind: "set", setting: awaited.key, value: t };
    }
    if (!cmd) {
      // A BARE NUMBER NEVER REACHES THE CLASSIFIER — and never becomes a trade.
      //
      // "5" carries no ticker, no side and no verb, so there is nothing for a
      // classifier to classify; what a reasoning model does with it is spend
      // the whole completion budget on chain-of-thought and return empty
      // content. So it is answered here, deterministically, for no tokens.
      //
      // The answer is a nudge and nothing else. See the note on the absent
      // ask-amount context above for what this deliberately does not do.
      const bareMatch = msg.text.trim().match(/^\s*(\d+(?:\.\d+)?)\s*(usdg|usd)?\s*$/i);
      if (bareMatch) {
        const n = Number(bareMatch[1]);
        if (Number.isFinite(n) && n > 0) {
          cmd = { kind: "chat", reply: `to trade, tell me a ticker and a USDG amount, e.g. 'buy 10 of QQQ' — you sent just "${msg.text.trim()}"` };
        }
      }
    }
    if (!cmd) {
      // "YES" ANSWERS A SETTINGS QUESTION — AND ONLY A SETTINGS QUESTION.
      //
      // Typing the answer is natural after "Change X to Y?", and the model is
      // deliberately unable to emit confirm (it could read one out of any
      // sentence). So it is matched here, exactly, and only when the thing
      // parked for this sender is a settings change: a transfer, a kill or a
      // shell command still needs /confirm or its button.
      const parked = pending.get(`${msg.chatId}:${msg.fromId}`);
      if (parked?.kind === "setting" && answerableNow) {
        const t = msg.text.trim();
        if (/^(yes|y|yep|yeah|ok|okay|sure|do it|confirm|go ahead|please do)[.!\s]*$/i.test(t)) cmd = { kind: "confirm" };
        else if (/^(no|n|nope|cancel|never ?mind|don'?t|leave it)[.!\s]*$/i.test(t)) cmd = { kind: "cancel" };
      }
    }
    if (!cmd) {
      const llm = resolveLlm(cfg);
      if (llm) {
        const st = stateRef.get();
        // The classifier gets IDENTITY ONLY — it picks a value from a closed enum
        // and has no use for recalled detail. Keeping memory out of this call also
        // means a remembered line can never nudge routing toward a trade.
        const identity = identityBlock(st.linkedAt, st.messageCount, now());
        const liveState = await readLlmState(statusCtx());
        const routeCtx = { state: `SOUL:\n${identity}\n\n${liveState}`, history: await historyFor(msg.chatId) };
        const r = await interpretWithLlm(msg.text, routeCtx, llm);
        cmd = r.cmd;
        // Strip any thinking dump that slipped through llmText (defense in depth)
        if (cmd.kind === "chat" && typeof cmd.reply === "string") {
          const stripped = stripThinkingBlock(cmd.reply);
          if (stripped !== cmd.reply) cmd = { kind: "chat", reply: stripped || cmd.reply };
        }
        // The get-to-know-you side-channel: the model proposes a fact, the
        // sanitizer disposes (drops addresses/keys/markup, dedupes, caps). Only the
        // OWNER may write it — else a group member could poison/evict owner memory.
        if (r.remember && isOwnerMsg) rememberOwnerFact(r.remember, now());
        // A conversational turn gets a warm, free-form voice — the classifier's
        // terse `reply` is for routing, not for talking. Text out triggers nothing.
        //
        // ONLY the narrator gets recalled memory, retrieved against what they
        // actually just said, so a fact from months back is reachable when it's
        // the one being asked about. Written AFTER the remember side-channel, so
        // something learned this turn can be recalled in the very same reply.
        // A QUESTION IS ANSWERED BY LOOKING IT UP (answer.ts).
        //
        // "What did you buy" used to be routed to the /trades dump; "why did
        // you lose money" to a one-shot reply over a fixed paragraph of state.
        // Every question — and the read commands when they arrive as words,
        // not slashes — now goes to a model that can look things up before it
        // answers. So does a "multi-step task" when PC control is off, which is
        // every hosted owner: "use the brain to analyse these coins" is a
        // question about coins, and the old reply ("turn on remote control +
        // agent mode") was advice a hosted owner cannot even follow.
        const pcAgentOn = cfg.telegramPcControlEnabled && cfg.telegramAgentEnabled;
        const asked = ANSWER_KINDS.has(cmd.kind) || (cmd.kind === "agent" && !pcAgentOn);
        let answered = false;
        let recalledNow: { block: string; ids: string[] } | null = null;
        if (asked) {
          recalledNow = recallForPrompt(msg.text, now(), stickyIds.get(msg.chatId));
          const gap = describeGap(await lastChatTurnAt(msg.chatId), now());
          void sendChatAction({ token }, msg.chatId);
          const ans = await answerQuestion({
            question: msg.text,
            name: getName(),
            identity: narratorIdentityBlock(st.linkedAt, st.messageCount, now()),
            memory: recalledNow.block,
            gap: gap ? `TIME SINCE THEIR LAST MESSAGE: ${gap}` : "",
            history: await historyFor(msg.chatId),
            tools: toolContext(cfg),
            creds: llm,
          });
          if (ans) {
            answered = true;
            cmd = { kind: "chat", reply: ans.text };
            if (ans.needsSignature) extras.keyboard = signKeyboard(signUrl(dashboardBase(), ans.signReason ?? "dead-policy"));
            console.log(`[telegram] answered from ${ans.used.length} lookup(s): ${[...new Set(ans.used)].join(", ") || "none"}`);
          } else if (cmd.kind === "agent") {
            // No answer and no PC: say what IS possible, in one breath.
            cmd = {
              kind: "chat",
              reply: isHostedMode()
                ? "I can't work on your computer — I live on the merrymen servers. Ask me anything about your trades, coins or settings and I'll look it up."
                : "I can only work on your computer when PC control and agent mode are switched on in Settings. Ask me anything about your trades, coins or settings and I'll look it up.",
            };
          }
          stickyIds.set(msg.chatId, new Set(recalledNow.ids));
          turnMemoryIds = recalledNow.ids;
        }
        if (cmd.kind === "chat" && !answered) {
          const recalled = recalledNow ?? recallForPrompt(msg.text, now(), stickyIds.get(msg.chatId));
          // Read BEFORE this turn is written, so it's the gap since they last
          // spoke rather than zero.
          const gap = describeGap(await lastChatTurnAt(msg.chatId), now());
          // Hermes-style tiering: stable identity (name+stage+tone, no numbers) in system,
          // volatile (gap+recalled+liveState) in user STATE — so model follows role, doesn't narrate it.
          const narratorIdentity = narratorIdentityBlock(st.linkedAt, st.messageCount, now());
          const chatCtx = {
            state: [
              gap ? `TIME SINCE THEIR LAST MESSAGE: ${gap}` : "",
              recalled.block,
              "",
              liveState,
            ]
              .filter(Boolean)
              .join("\n"),
            history: await historyFor(msg.chatId),
            narratorIdentity,
          } as unknown as { state: string; history: { role: "user" | "assistant"; content: string }[] };
          const fluent = await narrateChat(msg.text, chatCtx as never, llm);
          let strippedFluent = fluent ? stripThinkingBlock(fluent) : "";
          if (strippedFluent) cmd = { kind: "chat", reply: strippedFluent };
          else if (fluent && !strippedFluent) {
            // Whole reply was thinking — fall back to classifier's (already stripped) reply
          }
          // Carry what was surfaced into the next turn so a pronoun follow-up
          // ("is it done?") keeps the thread instead of losing it to zero word
          // overlap. Persisted on the turn below, so it survives a restart too.
          stickyIds.set(msg.chatId, new Set(recalled.ids));
          turnMemoryIds = recalled.ids;
        }
        // MODEL TEXT GOES OUT ESCAPED — the same rule the agent path keeps.
        // Every chat reply in this branch came from a model, and the answer
        // loop reads text strangers wrote (a coin's own description, news):
        // quoted faithfully, `<a href="…">tap to re-sign</a>` would render as a
        // live, disguised link in the bot's own voice. No reply here asks for
        // markup, so escaping costs nothing. escModel keeps a model's **bold**
        // as bold rather than showing the stars, and adds no other tag.
        if (cmd.kind === "chat") cmd = { kind: "chat", reply: escModel(cmd.reply) };
      } else {
        cmd = { kind: "chat", reply: "pick an AI provider and paste its key in the dashboard (Settings → AI provider) to chat in plain English — Groq, Google and Cerebras are free, or run Ollama locally. For now, try /help." };
      }
      // UNCONDITIONAL. This was guarded by a "same as the last user message?"
      // check, to avoid a double-push from a bare-amount branch that also wrote
      // history. That branch is gone, and the guard it needed silently dropped
      // a legitimately repeated message — an owner who says "ok" twice loses the
      // second one from the thread, which is exactly the kind of quiet edit to
      // somebody's own words this file should not make.
      await pushHistory(msg.chatId, "user", msg.text);
    }

    // Sender-level authz for state-changing commands. In a GROUP the chatId is a
    // negative group id (≠ the sender's id), so allowlisting the group would grant
    // EVERY member trade/transfer/PC/kill power. Require the SENDER's own id to be
    // allowlisted for anything state-changing; reads stay chat-level. Private chats
    // (chatId === fromId) are unaffected. `confirm`/`cancel` only arrive via
    // parseSlash now (the LLM can't emit them), and are gated here too.
    const stateChanging =
      CONTROL_KINDS.has(cmd.kind) ||
      PC_KINDS.has(cmd.kind) ||
      cmd.kind === "transfer" ||
      cmd.kind === "confirm" ||
      cmd.kind === "agent";
    if (stateChanging && msg.chatId !== msg.fromId && !cfg.telegramAllowlist.includes(msg.fromId)) {
      await say(
        "🚫 in a group, only individually-allowlisted users can run that. The owner can add your Telegram user id in the dashboard.",
      );
      return;
    }

    // Natural-language multi-step task → the agent loop (same gates as /agent).
    if (cmd.kind === "agent") {
      await pushHistory(msg.chatId, "assistant", "starting an agent task");
      await startAgent(cmd.task);
      return;
    }

    // A failed command must still answer — silence reads as a dead bot.
    const pendingKey = `${msg.chatId}:${msg.fromId}`;
    const pendingBefore = pending.get(pendingKey);
    let reply: string;
    try {
      reply = await executeCommand(cmd, cmdDeps);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      deps.note("warn", `Telegram: ${cmd.kind} failed — ${m}`);
      // A command that failed INSIDE a model call (/why narration, say) would
      // otherwise echo "groq 401 — invalid_api_key: Invalid API Key" at the
      // owner. Same rule as the interpreter: say which kind of no it was, and
      // what they can do. Anything that is not a provider line keeps its words.
      reply = isLlmProviderFailure(m)
        ? `🚫 that ${cmd.kind} failed — ${esc(describeLlmFailure(m).text)}`
        : `🚫 that ${cmd.kind} failed: ${esc(m.slice(0, 200))}`;
    }
    if (!slash) await pushHistory(msg.chatId, "assistant", stripThinkingBlock(reply.replace(/<[^>]+>/g, "")), turnMemoryIds);
    // THE LAST-RESORT STRIP FAILS CLOSED.
    //
    // It was `strippedReply || reply` — so a reply that was ENTIRELY
    // chain-of-thought stripped to "" and the raw thinking was sent instead,
    // which is the one case the strip exists for. A model that answered only in
    // its reasoning channel has not answered; say that.
    const strippedReply = stripThinkingBlock(reply);
    // A NEW PARKED ACTION GETS BUTTONS. Whatever this command parked — a
    // settings change, a transfer, the kill switch, a shell command — the
    // question now carries ✅/✖ as well as the /confirm it always accepted.
    // The press is checked against this exact action (handleCallback).
    const parkedNow = pending.get(pendingKey);
    let keyboard = extras.keyboard;
    let meta: { nonce: string; action: PendingAction; messageId?: number } | null = null;
    if (parkedNow && parkedNow !== pendingBefore) {
      meta = { nonce: mintNonce(), action: parkedNow };
      keyboard = confirmKeyboard(meta.nonce);
      pendingMeta.set(pendingKey, meta);
    } else if (!parkedNow) {
      pendingMeta.delete(pendingKey);
    }
    const sent = await say(
      strippedReply ||
        "that came back as reasoning with no answer in it — say it again, or use a slash command like /status.",
      keyboard ? { keyboard } : {},
    );
    if (meta && sent.messageId !== undefined) meta.messageId = sent.messageId;
    // A typed "yes" may answer the NEXT message only if this reply was the
    // settings question itself.
    if (meta?.action.kind === "setting") typedAnswerable.add(pendingKey);
  };

  /**
   * THE LIVE LINK CODE, ONCE A ROOM HAS SEEN IT, IS REPLACED (docs/tg-groups.md
   * "Link codes are for DMs only"), and the owner is told why the code on
   * their Settings page changed. Anyone who read it could DM "/link CODE" and
   * be allowlisted — on a bot never linked, made its owner. `shows` says
   * whether a text carries the live code (upper-cased); a false positive only
   * costs a fresh code and one DM to the owner, so a caller errs that way.
   */
  const replaceShownCode = (chatId: number, cfg: ResolvedConfig, shows: (live: string) => boolean): void => {
    const token = cfg.telegramBotToken;
    if (!token) return;
    // Random codes (state.ts): nothing here is derived from the token, which
    // only says there is a bot whose code could have leaked.
    const state = ensureLinkCode(stateRef.get());
    const live = state.linkCode.toUpperCase();
    if (!live || !shows(live)) return;
    stateRef.set(rotateLinkCode(state));
    deps.note("warn", "Telegram: a link code was typed in a group; it was replaced");
    if (tgGroups) void tgGroups.codeLeaked(chatId);
  };

  /**
   * The command's name when a group slash command is this bot's: bare
   * ("/cmd"), or addressed to this bot by its username ("/cmd@thisbot"),
   * lower-cased with the @name gone. Null when it names another bot, or any
   * bot while getMe has not answered: not provably ours, so not ours.
   */
  const ownGroupCommand = (text: string, cfg: ResolvedConfig): string | null => {
    const head = text.trim().slice(1).split(/\s+/)[0] ?? "";
    const addressedTo = /@(\w+)$/.exec(head)?.[1];
    const me = selfFor(cfg)?.username;
    const ours = !addressedTo || (!!me && addressedTo.toLowerCase() === me.toLowerCase());
    return ours ? head.replace(/@\w+$/, "").toLowerCase() : null;
  };

  /**
   * A group slash command as the DM handleGroupCommand would forward it as,
   * or null when it would reach nobody's DM: not ours, another bot's bare
   * command, a code (/link, /start <code>: never compared from a group), a
   * forget (the room's, not a DM's), or a sender who is not on the allowlist
   * themselves, or speaks through a chat. The backlog rule counts and holds a
   * late one as this DM (routeGroup), so a late /buy typed in a group gets the
   * same "I was offline" note in the sender's DM as a late /buy sent there.
   */
  const groupCommandDm = (m: TgMessage, cfg: ResolvedConfig): TgMessage | null => {
    if (!m.text.trim().startsWith("/") || m.senderChatId !== undefined || m.fromIsBot === true) return null;
    if (!cfg.telegramAllowlist.includes(m.fromId)) return null;
    const name = ownGroupCommand(m.text, cfg);
    if (name === null || name === "forgetme" || name === "forget") return null;
    const slash = parseSlash(m.text);
    if (slash?.kind === "link" || slash?.kind === "start") return null;
    if (slash?.kind === "unknown" && name !== "agent" && /^unknown command\b/.test(slash.text)) return null;
    return { updateId: m.updateId, chatId: m.fromId, fromId: m.fromId, fromUsername: m.fromUsername, text: m.text, date: m.date };
  };

  /**
   * A SLASH COMMAND TYPED IN A GROUP (docs/tg-groups.md "Commands in groups").
   *
   * It still goes through `handle` and its sender rules; what changes is who
   * may reach it and where the answer goes:
   *
   *   - "/cmd@OtherBot" is another bot's, and is ignored (parseSlash strips
   *     any @name without checking it is ours), and so is a bare command
   *     parseSlash does not know ("/ban @spammer" is a moderation bot's).
   *   - Someone who may not run commands gets one casual line per hour at
   *     most, never "🚫 not authorized" — with privacy mode off that was one
   *     refusal per message.
   *   - /link never works in a group: codes are for DMs (see below).
   *   - Every command's answer — a private read (rule 3) or an order's
   *     receipt (rule 2) — goes to the asker's own DM, with a "sent it to
   *     your DMs" in the room once it arrived there (else "dm me /start
   *     first"); the room never sees a report or a figure. A command that
   *     changes something runs only once their DM is proved reachable, and
   *     one that ran is never answered "dm me first".
   *   - A command reaches the DM only from a SENDER on the allowlist, as a
   *     DM would need; that covers /name, /remember and /soul (today any
   *     member of a linked group could run them, and /remember writes owner
   *     facts).
   *   - The owner's /groups is answered in their DM, like the DM command.
   *   - /forget wipes that group's memory only, and only for the owner: the
   *     owner's DM memory is not the room's to erase. /forgetme is anyone's.
   *
   * `late`: it waited out a silence, or reached this bot before this agent
   * did (routeGroup), and it is one of the few a late line may still run: a
   * /forgetme or the owner's /forget, which only take something away, or a
   * /pause or /kill, which only reduce risk. It runs by every rule above, the
   * DM's included, and the room hears nothing about it.
   */
  const handleGroupCommand = async (msg: TgMessage, cfg: ResolvedConfig, late = false): Promise<void> => {
    const text = msg.text.trim();
    const own = ownGroupCommand(text, cfg);
    const ours = own !== null;
    const name = own ?? "";
    // A person speaking through a chat (an anonymous admin, a channel) cannot
    // be told apart from any other: nobody in particular to answer or forget.
    const via = msg.senderChatId !== undefined;
    const ownerId = stateRef.get().ownerId;
    const isOwner = !via && ownerId !== null && msg.fromId === ownerId;
    const senderListed = !via && cfg.telegramAllowlist.includes(msg.fromId);
    const thread = msg.isTopicMessage === true && typeof msg.messageThreadId === "number" ? msg.messageThreadId : undefined;
    // NOT AWAITED. The group line takes typing time, the flood pacer and maybe
    // a 429 pause; the poll loop must not wait on any of it (rule 7). Neither
    // call ever rejects.
    const notice = (what: TgCommandNotice): void => {
      if (tgGroups && !late) void tgGroups.commandNotice(msg.chatId, msg.messageId, msg.fromId, what, thread);
    };

    const slash = parseSlash(text);
    if (slash?.kind === "link") {
      // LINK CODES ARE FOR DMs ONLY. In a group there is nothing to link: the
      // owner approves a group by adding the bot or pressing Stay, and nobody
      // in it needs a code to talk to it. A code typed here is never consumed
      // — linking from a group used to allowlist the whole group, handing
      // every member the chat-level private reads (/pnl, /positions …). And
      // when it is the live code, everyone in the room has just seen a bearer
      // credential, so it is replaced and the owner told why.
      //
      // CHECKED BEFORE WHOSE COMMAND IT IS. "/link@SomeBot CODE" shows the room
      // the code just the same — whether it names another bot, an old username
      // of this one, or this one before getMe has answered — and a code left
      // live would let any member DM "/link CODE" later and be allowlisted. For
      // the same reason the code counts ANYWHERE in what follows /link, not
      // only as a word of its own: "/link CODE.", "/link `CODE`" and
      // "/link (CODE)" show the room the same six characters, and so does a
      // longer run holding them (a handful of guesses finds where it starts).
      // Only the "no code needed" line waits for the command to be ours.
      const shown = slash.code.toUpperCase();
      if (shown) replaceShownCode(msg.chatId, cfg, (live) => shown.includes(live));
      if (ours) notice("link-here");
      return;
    }
    if (!ours) return;
    // Whoever hands a late one over, nothing else a late one says runs.
    if (late && lateGroupCommand(name, text) === "hold") return;

    if (name === "forgetme") {
      // The wipe itself happens before forgetMe first awaits; only the
      // "done 🫡" is left to the group queue, and a late one is not answered.
      if (!via && tgGroups) void tgGroups.forgetMe(msg.chatId, msg.fromId, msg.messageId, { late });
      return;
    }
    // THE OWNER'S /groups is answered in their DM, as when they type it there;
    // the room hears nothing (the listing names every group the bot is in).
    if (name === "groups") {
      if (isOwner) await tgGroups?.groupsCommand(msg.fromId);
      else notice("owner-only");
      return;
    }
    // A BARE COMMAND WE DO NOT KNOW IS ANOTHER BOT'S. Crypto groups run
    // moderation and scanner bots whose commands ("/ban @spammer", "/price")
    // carry no @name; forwarded, each one DMed the asker "unknown command" and
    // told the room "sent it to your DMs". Only parseSlash's own "unknown
    // command" marks a name it does not know: its usage lines ("usage: /buy …")
    // are for our commands and still go through, and /agent is matched by
    // `handle` itself rather than parseSlash.
    if (slash?.kind === "unknown" && name !== "agent" && /^unknown command\b/.test(slash.text)) return;

    if (!isOwner && !senderListed) {
      notice(slash && PRIVATE_READS.has(slash.kind) ? "private-refused" : "owner-only");
      return;
    }
    if (slash?.kind === "forget") {
      if (isOwner) tgGroups?.forgetChat(msg.chatId, msg.messageId, { late });
      else notice("owner-only");
      return;
    }
    // FORWARDED ONLY WHEN THE DM WOULD ANSWER IT. `handle` lets a DM in by the
    // sender's own id on the allowlist. An owner who linked from a group
    // before groups had their own rules has only that group there, so their DM
    // would be "🚫 not authorized" while the room heard "sent it to your DMs";
    // they are asked to DM the bot instead, which is where linking now
    // happens. /name and /remember need the sender listed too (they shape the
    // soul), and this is where they get it.
    if (!senderListed) {
      notice("dm-first");
      return;
    }
    // EVERY OTHER ANSWER GOES TO THE ASKER'S DM, reads and orders alike. The
    // same command, as if they had sent it to the bot directly: every DM rule
    // applies (confirm buttons included), and the answer lands in their DM.
    // A private read in the room would publish the owner's book (rule 3), and
    // an order's receipt — "bought 10 USDG of …" — is exactly the figure a
    // group must never see (rule 2). The room hears "sent it to your DMs" only
    // when the DM arrived: a bot cannot write first to someone who never
    // opened a DM with it.
    //
    // ANYTHING THAT CHANGES SOMETHING RUNS ONLY ONCE THE DM IS PROVED. /buy
    // has no confirm step, so it used to trade first and try the DM after:
    // for someone the bot cannot write to (added by id in the dashboard and
    // never pressed /start, or who blocked it) the buy went through, the
    // receipt bounced, and the room said "dm me /start first" — words that
    // say it did not run, and that a person follows by sending /buy again.
    // Now a "typing…" goes to their DM first, which Telegram refuses exactly
    // where it would refuse the receipt, and when it is refused nothing runs.
    // A read changes nothing, so it keeps the old order.
    // "/start <anything>" from a sender on the allowlist is help too (the
    // payload is a link code only for a chat that is not).
    const readOnly = slash !== null && (PRIVATE_READS.has(slash.kind) || slash.kind === "help" || slash.kind === "start");
    if (!readOnly) {
      const token = cfg.telegramBotToken;
      if (!token || !(await sendChatAction({ token }, msg.fromId)).ok) {
        notice("dm-first");
        return;
      }
    }
    let delivered = false;
    // Its own date: a forwarded command is exactly as live as the line it came in.
    await handle({ updateId: msg.updateId, chatId: msg.fromId, fromId: msg.fromId, fromUsername: msg.fromUsername, text: msg.text, date: msg.date }, cfg, (ok) => {
      if (ok) delivered = true;
    });
    // Once something ran, the room never hears "dm me first": a receipt that
    // bounced after the DM was proved (a blip, or blocked in between) is "done,
    // couldn't DM you the details", so nobody sends the order twice.
    notice(delivered ? "dm-sent" : readOnly ? "dm-first" : "done-no-dm");
  };

  /**
   * A MESSAGE IN A GROUP. Never `handle`: ordinary lines, the owner's
   * included, go to the group persona, which knows nothing private, and a
   * slash command to handleGroupCommand, which answers in the asker's DM.
   *
   * A LATE ONE IS DROPPED (`late`: "stale" when it waited out a silence,
   * "early" when it reached this bot before this agent was switched onto it;
   * the backlog rule in pollOnce). It is not answered, reacted to, remembered
   * or run: a room has moved on hours after an outage, and a Merryman that
   * answers it then, or runs a /buy typed into it then, is doing something
   * nobody asked for any more. Nor does a room get any of a DM's backlog notes
   * (the late-code prompt, the refusal, "I was offline"): the room is not
   * waiting on them, and whether the bot was down is nobody's business there.
   * The coin flow has its own, stricter clock besides (docs/tg-groups.md: a
   * CA older than ten minutes is claimed and left alone).
   *
   * What is done whatever the line's age, none of it said in the room:
   *
   * - THE LIVE CODE IN ANY GROUP LINE ("try /link CODE", "code: CODE!", a
   *   caption, even another bot's line) is replaced before anything else looks
   *   at it. The room has seen it whenever it was typed, and replacing it only
   *   ever takes something away.
   * - A /forgetme, or the owner's /forget, WIPES. Every /forgetme does
   *   (docs/tg-groups.md Memory), and a redeploy's restart is a silence, so
   *   dropping one would drop every request typed during one.
   *
   * And what a late DM still gets (holdStale), in the sender's own DM, for a
   * command someone on the allowlist typed here while the bot was down, since
   * that is where the answer to it would have gone (handleGroupCommand):
   *
   * - /pause and /kill RUN, because they only reduce risk, through every rule
   *   a live one meets. A /kill still only asks for a /confirm sent live.
   * - Anything else of ours is held back, and counted into that DM's one "I
   *   was offline" note, so an owner who typed /buy in the room during an
   *   outage learns that it did not run.
   *
   * Only from a silence, not from before the switch: holdEarly runs nothing,
   * since on a bot that served another agent those commands were that
   * agent's.
   */
  const routeGroup = (m: TgMessage, cfg: ResolvedConfig, late: "early" | "stale" | null, batch: StaleBatch): Promise<void> => {
    if (m.text) {
      const text = m.text;
      replaceShownCode(m.chatId, cfg, (live) => groupLineShowsCode(text, live));
    }
    // Voice notes are not transcribed in groups: nobody asked the owner's
    // transcription key to listen to a room.
    if (m.voiceFileId && !m.text) return Promise.resolve();
    // The loop guard: another bot's line. An anonymous admin (a bot account
    // posting for a person, with sender_chat set) is a person.
    if (m.fromIsBot === true && m.senderChatId === undefined) return Promise.resolve();
    const command = m.text.trim().startsWith("/");
    // Counted for the poll heartbeat: a group line that waited out a silence
    // is dropped below, and the heartbeat must be able to say so.
    if (late !== null && !command) pollCounts.groupLate += 1;
    if (late === null) {
      if (command) return handleGroupCommand(m, cfg);
      tgGroups?.onMessage(m);
      return Promise.resolve();
    }
    const name = command ? ownGroupCommand(m.text, cfg) : null;
    if (name === null) return Promise.resolve();
    const action = lateGroupCommand(name, m.text);
    if (action === "forget") return handleGroupCommand(m, cfg, true);
    if (late === "early") return Promise.resolve();
    const dm = groupCommandDm(m, cfg);
    if (!dm) return Promise.resolve();
    return action === "run" ? handleGroupCommand(m, cfg, true) : holdStale(dm, cfg, batch);
  };

  /**
   * A BUTTON PRESS — the answer to one parked question, from the person it was
   * asked of.
   *
   * Every check a typed /confirm gets, plus one: the press must carry the
   * nonce of the action parked for THIS sender, and that action must still be
   * the one in the slot. Anything else is answered and ignored. Every press is
   * answered, including refused ones, or the button spins for ever.
   */
  const handleCallback = async (cb: TgCallback, cfg: ResolvedConfig): Promise<void> => {
    const opts = { token: cfg.telegramBotToken! };
    const parsed = parseConfirmData(cb.data);
    if (!parsed) {
      await answerCallbackQuery(opts, cb.id, "That button has expired.");
      return;
    }
    const allowed = cfg.telegramAllowlist.includes(cb.chatId) || cfg.telegramAllowlist.includes(cb.fromId);
    if (!allowed) {
      tally.refused(cb.chatId);
      await answerCallbackQuery(opts, cb.id, "Not authorized.");
      return;
    }
    // The group rule, as for typed state-changing commands.
    if (cb.chatId !== cb.fromId && !cfg.telegramAllowlist.includes(cb.fromId)) {
      await answerCallbackQuery(opts, cb.id, "Only allowlisted users can confirm in a group.");
      return;
    }
    const key = `${cb.chatId}:${cb.fromId}`;
    const meta = pendingMeta.get(key);
    const parked = pending.get(key);
    if (!meta) {
      // Not this person's question (or nothing is waiting). Say so; leave the
      // message alone — it may be someone else's live question.
      await answerCallbackQuery(opts, cb.id, "There's nothing waiting for you to confirm.");
      return;
    }
    if (meta.nonce !== parsed.nonce || !parked || parked !== meta.action || (meta.messageId !== undefined && meta.messageId !== cb.messageId)) {
      await answerCallbackQuery(opts, cb.id, "That question has expired — ask me again.");
      // Mark the pressed message stale only if its nonce is live for NOBODY —
      // in a group it may be another member's open question.
      if (meta.nonce !== parsed.nonce && ![...pendingMeta.values()].some((m) => m.nonce === parsed.nonce)) {
        await editMessageText(opts, cb.chatId, cb.messageId, "⌛ This question was replaced by a newer one.");
      }
      return;
    }
    pendingMeta.delete(key);
    typedAnswerable.delete(key);
    let result: string;
    try {
      result = await executeCommand({ kind: parsed.yes ? "confirm" : "cancel" }, makeCmdDeps(cb, cfg, opts.token, {}));
    } catch (e) {
      result = `🚫 that failed: ${esc((e instanceof Error ? e.message : String(e)).slice(0, 200))}`;
    }
    await answerCallbackQuery(opts, cb.id, parsed.yes ? "Done" : "Cancelled");
    // The question becomes its answer, so it cannot be pressed twice.
    await editMessageText(opts, cb.chatId, cb.messageId, result);
    await pushHistory(cb.chatId, "assistant", stripThinkingBlock(result.replace(/<[^>]+>/g, "")));
  };

  /**
   * One poll. Returns how long to wait before the next, in ms. The bot
   * binding, the backoff and the menu push it calls are defined just below.
   *
   * THE BACKLOG RULE. Telegram keeps what a bot is sent for up to a day, so
   * after a restart, a redeploy or an outage the first poll hands over
   * everything that waited, all at once. It used to be handled as if it had
   * just been typed. In the incident this came from, five /link attempts the
   * owner had sent over a day of silence were compared against a code minted
   * seconds earlier, counted as five wrong guesses, and locked the owner out
   * the moment the bot came back. A /buy sent yesterday would have bought
   * today, at today's price.
   *
   * So a message dated before `armedAt`, the moment this process started
   * listening to this bot, is backlog (holdStale). The line is when listening
   * began and nothing else: there is no age threshold. A live /link that is
   * merely handled late, behind a slow batch, still counts toward the lockout,
   * or waiting would be a way round the guess limit. A date of 0 says nothing
   * either way and is treated as live, as before. A message from before a
   * change of bot is the stricter case, and holdEarly has it.
   *
   * LISTENING BEGINS AGAIN AFTER A SILENCE, not only at the start. Armed once
   * per process, an outage inside it went unseen: hours of 502s, or a revoked
   * token's 401s until the owner pasted a renewed secret, and the backlog they
   * left was all dated after `armedAt`. It ran as live, a /buy from an hour
   * before bought, and five /link attempts from the silence locked out the
   * owner's live code, the incident over again. So a good poll that ends
   * REARM_AFTER_SEC or more of polls failing or throwing re-arms at its own
   * send time. A shorter blip does not: whoever typed into it is still
   * waiting for the answer. This weakens nothing: what is held is never
   * compared, and a guesser cannot make polls fail. Switched off re-arms too,
   * once a second read confirms it (offReads).
   *
   * EACH UPDATE IS SAVED AS SEEN BEFORE IT RUNS, and each reads the config
   * afresh.
   * - At most once, on purpose. The offset used to be saved after the whole
   *   batch, so a crash part way through replayed every update in it on the
   *   restart, including a trade or a transfer that had already gone through.
   *   A command lost to a crash can be sent again; one run twice cannot be
   *   undone. After a redeploy that wipes the offset, the date rule above is
   *   what stops the replayed backlog from running, and the note it sends
   *   does not claim that none of it ran before (staleSummaryText).
   * - The allowlist is read per update, so a chat removed on the dashboard is
   *   refused from its next message, not after the rest of a batch that can
   *   run to a hundred.
   * - The token is not. The batch came from one bot, and its replies must go
   *   through that bot. If the token changes, or Telegram is switched off,
   *   the batch stops where it is, and whatever is left is asked for again
   *   under the new token (or found where it was left, on a return to this
   *   bot).
   */
  const pollOnce = async (): Promise<number> => {
    const cfg = deps.getCfg();
    if (!cfg.telegramEnabled || !cfg.telegramBotToken) {
      // Only on a second read in a row. The orchestrator rewrites settings.json
      // every 15 seconds, and a read that catches it half-written parses as
      // nothing: the defaults, Telegram off. Taken at its word, that one read
      // re-armed the boundary, and whatever the owner typed in the idle gap
      // that followed was held as if the bot had been off.
      offReads += 1;
      if (offReads >= 2) {
        // Switched off is not an outage, and time spent off must not be
        // counted into one when it is switched back on.
        outage = null;
        // Nor is anything sent while it was off live when it comes back on:
        // nobody was listening, which is what backlog means.
        armedAt = null;
      }
      return IDLE_GAP_MS; // idle until enabled
    }
    offReads = 0;
    const token = cfg.telegramBotToken;
    await bindBot(token);
    stateRef.set(ensureLinkCode(stateRef.get()));

    // When the request was SENT, not when it came back. A long poll that
    // returns 20 seconds later with one message returns it the moment it was
    // typed; that message is live, and the answer's own clock would call it
    // late whenever the reply crossed a second.
    const askedAt = now();
    const askedFrom = stateRef.get().offset;
    const polled = await getUpdates({ token }, askedFrom);
    if (polled.reason) return pollFailed(polled, token);
    pollWorked(token);
    // The backlog rule's silence: this poll ends one long enough that what
    // waited through it is backlog, so listening begins again now.
    if (deafSince !== null && askedAt - deafSince >= REARM_AFTER_SEC) armedAt = null;
    deafSince = null;
    if (armedAt === null) armedAt = askedAt;
    const armed = armedAt;
    const bot = botIdOf(token);
    const blind = askedFrom === 0 && polledBot !== bot;
    polledBot = bot;
    const { messages, callbacks, members, service, nextOffset } = polled;
    // Who the bot is, before a group line is read against it: first poll,
    // a new token, or half an hour since the last look (in the background).
    // The poll heartbeat (POLL_HEARTBEAT_MS): what this poll delivered, by kind.
    for (const m of messages) {
      if (isGroupMessage(m)) pollCounts.group += 1;
      else pollCounts.dm += 1;
    }
    pollCounts.buttons += callbacks.length;
    pollCounts.members += members.length;
    pollCounts.service += service.length;
    {
      const t = Date.now();
      const total = pollCounts.group + pollCounts.dm + pollCounts.buttons + pollCounts.members + pollCounts.service;
      if ((total > 0 && t - pollCounts.since >= POLL_HEARTBEAT_MS) || (total === 0 && t - pollCounts.since >= POLL_QUIET_NOTE_MS)) {
        console.log(
          total > 0
            ? `[telegram] last ${Math.round((t - pollCounts.since) / 60_000)} min: ${total} updates (${pollCounts.group} group messages of which ${pollCounts.groupLate} were backlog, ${pollCounts.dm} DMs, ${pollCounts.buttons} buttons, ${pollCounts.members} membership, ${pollCounts.service} service)`
            : `[telegram] no updates in ${Math.round((t - pollCounts.since) / 60_000)} min (polling)`,
        );
        pollCounts = { since: t, group: 0, groupLate: 0, dm: 0, buttons: 0, members: 0, service: 0 };
      }
    }
    // After the poll rather than before it, so a getMe that fails or hangs
    // through an outage never stands in front of the getUpdates that ends it,
    // and never moves the backlog boundary above.
    if (!botSelf || botSelf.token !== token) await refreshSelf(token);
    else if (Date.now() - botSelf.at > SELF_REFRESH_MS) void refreshSelf(token);
    // What a hold process kept while trading was held, before this batch: it
    // all happened before anything in it. Once the handler can tell the bot's
    // own removal from anyone's, which takes getMe.
    if (!heldGroupsTaken && tgGroups && deps.heldGroupUpdates && selfFor(cfg)) {
      heldGroupsTaken = true;
      await replayHeldGroups(tgGroups, deps.heldGroupUpdates, token);
    }
    // Sent to this bot before this agent was switched onto it (boundAt).
    const boundAt = stateRef.get().boundAt;
    const early = (date: number) => boundAt !== null && date > 0 && date < boundAt;
    const stale = (date: number) => !early(date) && date > 0 && date < armed;
    // A group hears nothing about a backlog (routeGroup), so only DMs are
    // counted into the one summary each allowlisted chat gets, with the late
    // group commands that would have been answered in one (groupCommandDm).
    const lateDms = messages.filter((m) => stale(m.date)).map((m) => (isGroupMessage(m) ? groupCommandDm(m, cfg) : m));
    const batch: StaleBatch = {
      told: new Set(),
      held: heldPerChat(lateDms.filter((m): m is TgMessage => m !== null), cfg),
      blind,
    };
    /**
     * WHERE A MESSAGE GOES. A DM goes to `handle` exactly as it always has
     * (the owner's /groups aside), or, when it waited out a silence or reached
     * this bot before this agent did, to the backlog rule above. A group
     * message never does either: routeGroup has it, and a late one is
     * dropped there rather than held with a note. Before groups had their own
     * rules, the owner's words in a group ran the full DM pipeline, private
     * state and all, and the answer was posted to the room.
     *
     * The group handler's methods return at once and do their work on their
     * own queue, so a busy group never holds up the owner's DMs or buttons.
     */
    const route = (m: TgMessage, c: ResolvedConfig): Promise<void> => {
      if (isGroupMessage(m)) return routeGroup(m, c, early(m.date) ? "early" : stale(m.date) ? "stale" : null, batch);
      if (early(m.date)) return holdEarly(m, c);
      if (stale(m.date)) return holdStale(m, c, batch);
      if (
        tgGroups &&
        m.chatId === m.fromId &&
        m.fromId === stateRef.get().ownerId &&
        /^\/groups(?:@\w+)?\s*$/i.test(m.text.trim())
      ) {
        return tgGroups.groupsCommand(m.chatId);
      }
      return handle(m, c);
    };
    // In the order they happened: a press and a typed message in the same
    // batch must not overtake each other, and a group's "you were added"
    // must come before the first line said in it.
    const updates = [
      ...messages.map((m) => ({ at: m.updateId, run: (c: ResolvedConfig) => route(m, c) })),
      ...callbacks.map((cb) => ({
        at: cb.updateId,
        run: async (c: ResolvedConfig) => {
          // A button on a message from before the switch answers a question
          // this agent may never have asked. Answered, so it stops spinning,
          // and dropped.
          if (early(cb.date)) {
            await answerCallbackQuery({ token }, cb.id, "That button has expired.");
            return;
          }
          // Telegram groups' own buttons (Stay, Leave, Forget, in the owner's
          // DM) answer questions kept in the group store, not parked in this
          // process, and the handler checks the owner and the room as they are
          // now. So one asked before a restart still counts: expiring it would
          // void every open Stay or Leave at each redeploy, and leave a
          // stranger's group to its 24-hour leave.
          if (tgGroups && cb.data.startsWith("tgg:")) {
            await tgGroups.onCallback(cb);
            return;
          }
          // One from before this process started listening answers a question
          // whose parked action died with the last process.
          if (stale(cb.date)) {
            await answerCallbackQuery({ token }, cb.id, "That button has expired.");
            return;
          }
          await handleCallback(cb, c);
        },
      })),
      // The bot's own membership, and joins, leaves and migrations: recorded
      // whenever they arrive, since a group the bot was added to or removed
      // from while nobody listened is still a fact. A late one says nothing in
      // the room, though: no hello hours after the add, and no welcome for
      // someone who joined while the bot was away.
      ...members
        .filter((u) => u.chatType === "group" || u.chatType === "supergroup")
        .map((u) => ({ at: u.updateId, run: async () => tgGroups?.onMember(u, { late: early(u.dateSec) || stale(u.dateSec) }) })),
      ...service
        .filter((s) => s.chatType === "group" || s.chatType === "supergroup")
        .map((s) => ({
          at: s.updateId,
          run: async () => tgGroups?.onService(early(s.dateSec) || stale(s.dateSec) ? { ...s, newChatMembers: [] } : s),
        })),
    ].sort((a, b) => a.at - b.at);
    let whole = true;
    for (const u of updates) {
      const live = freshCfg();
      if (!live?.telegramEnabled || live.telegramBotToken !== token) {
        whole = false;
        break;
      }
      if (u.at + 1 > stateRef.get().offset) stateRef.set({ ...stateRef.get(), offset: u.at + 1 });
      try {
        await u.run(live);
      } catch (e) {
        deps.note("warn", `Telegram: error handling message — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Past the updates none of the above reads too (a private chat's
    // membership change, anything unparsed), but only when the batch ran to
    // its end: a stopped batch leaves the rest to be asked for again.
    if (whole && nextOffset > stateRef.get().offset) {
      stateRef.set({ ...stateRef.get(), offset: nextOffset });
    }
    // With the allowlist as it is NOW. A /link in this batch has just grown it,
    // and `cfg` from before the batch would find the old menu already live, so
    // a newly linked owner saw only the stranger's menu until the next long
    // poll came back, up to 25s later.
    const fresh = freshCfg();
    if (fresh?.telegramEnabled && fresh.telegramBotToken === token) await pushMenus(fresh, token);
    return POLL_GAP_MS;
  };

  /**
   * WHAT A HOLD PROCESS KEPT ABOUT GROUPS while trading was held
   * (held-groups.ts): the bot's own membership, migrations, its removal, and
   * the owner's Stay, Leave and Forget. Handed to the group handler in the
   * order they happened, as late updates are: recorded, and nothing said in a
   * room (no hello days after an add). A stranger's add is asked about now,
   * with its own 24 hours; a press does what it did then, and its question is
   * edited to say so. Only this bot's. Taken off the disk before any of it
   * runs, so a crash part way never repeats one.
   */
  const replayHeldGroups = async (groups: TgGroups, take: () => HeldGroupEntry[], token: string): Promise<void> => {
    const bot = botIdOf(token);
    let entries: HeldGroupEntry[];
    try {
      entries = take().filter((e) => e.bot === bot);
    } catch {
      return;
    }
    for (const e of entries) {
      try {
        if (e.kind === "member") groups.onMember(e.member, { late: true });
        else if (e.kind === "service") groups.onService({ ...e.service, newChatMembers: [] });
        else await groups.onCallback({ ...e.press, updateId: 0, id: "" }, { late: true });
      } catch (err) {
        deps.note("warn", `Telegram: error applying a group update kept while trading was held — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (entries.length > 0) {
      deps.note("ok", `Telegram groups: applied ${entries.length === 1 ? "1 group update" : `${entries.length} group updates`} kept while trading was held`);
    }
  };

  /**
   * A MESSAGE THAT WAITED OUT A SILENCE (the backlog rule in pollOnce): at most
   * one answer per chat of each kind per batch, and nothing run but what only
   * reduces risk. What each message gets is staleAction's.
   *
   * - A /link or /start <code> is never compared and never counted, from any
   *   chat. The code in it was for whatever the dashboard showed when it was
   *   typed, which may be long gone; comparing it could only count a wrong
   *   guess. One prompt to send the current code.
   * - Anyone not on the allowlist gets the ordinary refusal once, and hears
   *   nothing about the outage: whether the bot was down is not a stranger's
   *   business.
   * - From an allowlisted chat, /pause and /kill run, through the same path
   *   as a live message and every gate on it. /kill still only asks for a
   *   /confirm, which must be sent live. Everything else is held back: trades,
   *   transfers, /confirm, settings, and anything a model would answer. One
   *   summary per chat says how many and since when, so the owner knows to
   *   resend what they still want; after a start from no saved offset it
   *   says they may have gone through already (staleSummaryText).
   */
  const holdStale = async (msg: TgMessage, cfg: ResolvedConfig, batch: StaleBatch): Promise<void> => {
    const token = cfg.telegramBotToken!;
    const allowed = cfg.telegramAllowlist.includes(msg.chatId) || cfg.telegramAllowlist.includes(msg.fromId);
    const action = staleAction(msg.text, allowed);
    if (action === "run") {
      await handle(msg, cfg);
      return;
    }
    // Counted per message, though answered once: the count is what arrived.
    if (action === "refuse") tally.refused(msg.chatId);
    const key = `${msg.chatId}:${action}`;
    if (batch.told.has(key)) return;
    batch.told.add(key);
    let reply: string;
    if (action === "late-code") reply = STALE_LINK_TEXT;
    else if (action === "refuse") reply = refusalText(msg.chatId);
    else {
      // Counted up front from the whole batch. A chat added to the allowlist
      // part way through (a live /link earlier in it) was counted as refused
      // there, so it falls back to this one message.
      const held = batch.held.get(msg.chatId) ?? { n: 1, oldest: msg.date };
      reply = staleSummaryText(held.n, held.oldest, now(), batch.blind);
    }
    await sendMessage({ token }, msg.chatId, reply);
  };

  /**
   * A MESSAGE SENT TO THIS BOT BEFORE THIS AGENT WAS SWITCHED ONTO IT: answered,
   * and never acted on.
   *
   * A change of bot polls the new bot from where this agent last left it, or
   * from its first update, so everything the bot was sent in the meantime (up
   * to a day's worth) arrives in one go. None of it was meant for this agent as
   * it is now. The bot may have been serving another agent, the owner's other
   * login in the incident this came from, whose allowlist had the same owner
   * on it: a /buy sent there must not be bought here. And the /link codes in
   * it were for a code this bot's dashboard never showed, so comparing them
   * would only count wrong guesses, and five lock the owner out just as they
   * arrive to link.
   *
   * So nothing runs, not even /pause or /kill: on a bot that served another
   * agent they were that agent's, and a /kill here would stand the wrong agent
   * down. A /link is never compared or counted. Each chat gets one answer of
   * each kind per change of bot: a resend prompt for a /link, which says only
   * that the code came late, a short note to an allowlisted chat, and the
   * ordinary refusal to anyone else. A stranger learns nothing about the agent
   * or the switch.
   */
  const holdEarly = async (msg: TgMessage, cfg: ResolvedConfig): Promise<void> => {
    const token = cfg.telegramBotToken!;
    const allowed = cfg.telegramAllowlist.includes(msg.chatId) || cfg.telegramAllowlist.includes(msg.fromId);
    const slashKind = parseSlash(msg.text)?.kind;
    const kind = slashKind === "link" || slashKind === "start" ? "link" : allowed ? "held" : "refused";
    if (kind === "refused") tally.refused(msg.chatId);
    const key = `${msg.chatId}:${kind}`;
    if (earlyTold.has(key)) return;
    earlyTold.add(key);
    const reply = kind === "link" ? EARLY_LINK_TEXT : kind === "held" ? EARLY_HELD_TEXT : refusalText(msg.chatId);
    await sendMessage({ token }, msg.chatId, reply);
  };

  /**
   * TIE THE OFFSET AND THE LINK CODE TO THE BOT THEY BELONG TO, before either
   * is used.
   *
   * Both used to outlive a change of bot. Update ids count up per bot, so the
   * old bot's offset, far past anything a new bot has sent, made getUpdates
   * return nothing for good: the new bot never heard a message. And the code
   * minted for the old bot stayed on the dashboard and kept working.
   *
   * - A DIFFERENT bot resumes where this agent last left it, or starts from
   *   its first update if it never polled it (switchBot). NOT FROM 0 ON A
   *   RETURN: the last batch handled on a bot is still pending at Telegram
   *   until the next poll of that bot asks past it, so polling from 0 after
   *   A → B → A handed it over again and ran its /buy a second time. Whatever
   *   the bot was sent before the switch is held (holdEarly), and the backlog
   *   boundary is re-armed by the new bot's first good poll. The code is
   *   fresh, and link lockouts are cleared: they counted guesses at a code
   *   that no longer exists.
   * - The SAME bot with a new secret keeps its offset, since its updates are
   *   the same stream. The code is rotated all the same: a secret is renewed
   *   because the old one got out, and a code issued while it was out is not
   *   worth keeping. Told by the token's fingerprint in telegram.json, so a
   *   secret that changed while the process was down is caught on the way
   *   back up.
   * - NO stored bot, a file from before this existed or one the orchestrator
   *   restored, adopts the current bot and resets nothing. A reset there would
   *   replay the backlog and void a code the dashboard may be showing.
   * - Whichever of those it is, a code the OLD SCHEME derived from this token
   *   is retired first, once per token per process (retireLegacyCode): it is
   *   computable from the token and was printed into the fleet's logs, and
   *   the adoption above would otherwise keep it for good.
   *
   * The new code is minted in the same write that clears the old one, so
   * telegram.json never holds an empty code for the orchestrator to publish as
   * "no code" while getMe is out. Logged without the token or the code; the
   * dashboard shows the new code.
   */
  const bindBot = async (token: string): Promise<void> => {
    const firstUse = boundToken !== token;
    // A new token is a new question, so it starts the backoff from the bottom.
    if (boundToken !== null && firstUse && outage) outage.streak = 0;
    boundToken = token;
    if (firstUse) {
      const held = stateRef.get();
      const retired = retireLegacyCode(held, token);
      if (retired !== held) {
        stateRef.set(retired);
        linkFails.clear();
        deps.note("ok", "Telegram: the link code was one derived from the bot token, so it was re-minted");
      }
    }
    // The state change itself is state.ts bindToken, which the hold process
    // shares; what it means to THIS loop is below.
    const bound = bindToken(stateRef.get(), token, now());
    // `invalid` is not a token Telegram would accept; getUpdates says so.
    if (bound.change === "invalid" || bound.change === "same") return;
    stateRef.set(bound.state);
    if (bound.change === "adopted") return;
    if (bound.change === "switched") {
      linkFails.clear();
      earlyTold.clear();
      armedAt = null;
      commandsRegisteredKey = "";
      menuTry = freshMenuTry();
      const me = await getMe({ token });
      deps.note("ok", me.bot ? `Telegram: bot changed to @${me.bot.username}` : "Telegram: bot changed");
      return;
    }
    // A different fingerprint, or none next to a stored bot (every path above
    // writes the two together): the code on file cannot be shown to have been
    // issued under this token, so it is rotated, and like any rotation it
    // forgives the lockouts that counted guesses at the old one.
    linkFails.clear();
    if (bound.told) deps.note("ok", "Telegram: bot token renewed, so the link code was re-minted");
  };

  /**
   * A poll that failed: log it once per kind per outage, and say how long to
   * leave it.
   *
   * The loop used to retry every 500ms whatever the answer. A revoked token
   * was asked again twice a second for days, a 429 was retried inside its own
   * retry_after, and a second poller on the same bot turned into two processes
   * taking the bot's updates from each other as fast as they could.
   */
  const pollFailed = (r: { reason?: string; errorCode?: number; retryAfter?: number }, token: string): number => {
    const t = now();
    outage = outage ?? { since: t, streak: 0, told: new Set() };
    outage.streak += 1;
    deafSince ??= t;
    // How long, and in what words: poll-rules.ts, shared with the hold process.
    const { kind, waitMs, line, err } = pollFailure(r, outage.streak);
    notePoll(token, err);
    const conflictToldRecently = kind === "conflict" && conflictToldAt !== null && t - conflictToldAt < CONFLICT_RETELL_SEC;
    if (!outage.told.has(kind) && !conflictToldRecently) {
      outage.told.add(kind);
      if (kind === "conflict") conflictToldAt = t;
      deps.note("warn", line);
    }
    return waitMs;
  };

  /** A poll that worked. An outage that was logged is closed with how long it lasted. */
  const pollWorked = (token: string): void => {
    notePoll(token, null);
    if (outage && outage.told.size > 0) {
      deps.note("ok", `Telegram: receiving updates again after ${span(now() - outage.since)}`);
    }
    outage = null;
  };

  /**
   * How the poll went, into telegram.json for the orchestrator to publish and
   * watch (state.ts recordPoll, which says why and how often).
   */
  const notePoll = (token: string, err: string | null): void => {
    const held = stateRef.get();
    const next = recordPoll(held, botIdOf(token), now(), err);
    if (next !== held) stateRef.set(next);
  };

  /**
   * Push the "/" command menus whenever the token or allowlist changed
   * (enable-after-start, /link growing the allowlist). Two scopes: a trimmed
   * safe menu for every private chat — strangers get signposts, not an
   * advertisement of the remote-control surface — and the FULL menu for each
   * allowlisted chat, so owners keep discoverability (/run, /type, /agent…).
   * The fingerprint is stored only after a clean pass, so one transient
   * network failure retries on the next poll instead of silently dropping the
   * menu until a restart. Best-effort — never breaks the poll.
   *
   * AFTER THE BATCH, AND BOUNDED. It ran before getUpdates on every poll, so a
   * menu that could not be pushed (a revoked token, an allowlisted chat the bot
   * has never spoken to) cost one to N requests before each poll, twice a
   * second, and stood in front of every message waiting to be read. Now a
   * fingerprint is tried at most MENU_MAX_ATTEMPTS times in a row, then once
   * every MENU_RETRY_SEC. "chat not found" is not retried for that chat at
   * all: the bot has no chat with it until that person writes to the bot, and
   * asking again does not change that. The next change of fingerprint, or a
   * restart, tries it again.
   */
  const pushMenus = async (cfg: ResolvedConfig, token: string): Promise<void> => {
    const key = `${token}:${[...cfg.telegramAllowlist].sort((a, b) => a - b).join(",")}`;
    if (key === commandsRegisteredKey) return;
    if (menuTry.key !== key) menuTry = freshMenuTry(key);
    if (now() < menuTry.nextAt) return;
    let firstFail: string | null = null;
    const pub = await setMyCommands({ token }, publicBotCommands, { type: "all_private_chats" });
    if (!pub.ok) firstFail = pub.reason ?? "public menu failed";
    for (const chatId of cfg.telegramAllowlist) {
      if (menuTry.gone.has(chatId)) continue;
      const r = await setMyCommands({ token }, undefined, { type: "chat", chat_id: chatId });
      if (r.ok) continue;
      if (/chat not found/i.test(r.reason ?? "")) {
        menuTry.gone.add(chatId);
        continue;
      }
      firstFail = firstFail ?? `chat ${chatId} — ${r.reason ?? "full menu failed"}`;
    }
    if (!firstFail) {
      commandsRegisteredKey = key;
      return;
    }
    menuTry.attempts += 1;
    if (menuTry.attempts >= MENU_MAX_ATTEMPTS) menuTry.nextAt = now() + MENU_RETRY_SEC;
    if (!menuTry.warned) {
      menuTry.warned = true; // retried as above — but logged once per fingerprint
      deps.note("warn", `Telegram: command menu — ${firstFail}`);
    }
  };

  const freshCfg = (): ResolvedConfig | undefined => {
    try {
      return deps.getCfg();
    } catch {
      return undefined;
    }
  };
  const currentToken = (): string | undefined => freshCfg()?.telegramBotToken;

  /**
   * Wait `ms`, then poll. Taken in slices so that a wait never outlasts the
   * token it was for: after a 401 the owner pastes a new token on the
   * dashboard, and the next poll should use it within seconds, not at the end
   * of the five minutes the old token earned.
   */
  const waitThenPoll = (ms: number, token: string | undefined): void => {
    const slice = Math.min(ms, WAKE_SLICE_MS);
    setTimeout(() => {
      if (stopped) return;
      const left = ms - slice;
      if (left > 0 && currentToken() === token) waitThenPoll(left, token);
      else loop();
    }, slice);
  };

  const loop = () => {
    if (stopped) return;
    const token = currentToken();
    pollOnce()
      .then((ms) => {
        crashStreak = 0;
        return ms;
      })
      .catch((e) => {
        deps.note("warn", `Telegram: poll loop — ${e instanceof Error ? e.message : String(e)}`);
        crashStreak += 1;
        // A poll that threw heard nothing either (telegram.json unwritable, say),
        // and a long run of them is a silence like any failed poll's.
        deafSince ??= now();
        return Math.min(BACKOFF_MAX_SEC, 2 ** crashStreak) * 1000;
      })
      .then((ms) => waitThenPoll(ms, token));
  };

  // Announce the bot identity once at startup (best-effort).
  const cfg0 = deps.getCfg();
  if (cfg0.telegramEnabled && cfg0.telegramBotToken) {
    const token0 = cfg0.telegramBotToken;
    void getMe({ token: token0 }).then((r) => {
      if (r.bot) {
        // The same answer seeds the cached identity, so the first poll need not ask again.
        if (!botSelf) botSelf = { token: token0, bot: r.bot, at: Date.now() };
        deps.note("ok", `Telegram: connected as @${r.bot.username}`);
      } else deps.note("warn", `Telegram: token check failed — ${r.reason}`);
    });
  }
  loop();
  return {
    stop: () => {
      stopped = true;
      tgGroups?.stop();
    },
  };
}
